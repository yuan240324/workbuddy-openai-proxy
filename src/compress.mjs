// 上下文压缩：把过长的消息历史裁到上游能接受的大小。
//
// 为什么需要：上游对输入长度有硬限制（实测 glm-5.1 是 100000 tokens），
// 超了直接 400 "prompt is too long: N > M maximum"，客户端会看到一个裸报错。
// 原实现是「原样转发」，没有任何裁剪，所以长会话必然撞墙。
//
// 关键约束（踩过的坑）：
//   1. 带 tool_calls 的 assistant 消息和它对应的 role:"tool" 结果必须同生共死 ——
//      只删其中一半，上游会报 tool_call_id 找不到。
//      所以裁剪以「块」为单位，而不是单条消息。
//   2. system 提示词永远保留（丢了会改变行为）。
//   3. 越新的消息越重要，所以从最老的开始丢。
//   4. 单条消息本身就超限时，只能截断它自己的内容（保留头尾）。

/** 上游报「太长」时的真实上限缓存：`site/model` → maxInputTokens。 */
const learnedLimits = new Map();

/**
 * 中文字符判定（CJK 统一表意文字 + 扩展 A + 兼容表意 + 中文标点）。
 *
 * 为什么压缩要单独判这个：util.mjs 的 estimateTokens 用的是「3 字符 ≈ 1 token」，
 * 那是英文口径。实测（deepseek-v4.1-flash，见下表）中文一个字符要 0.53 个 token，
 * 按 0.33 估会**低估 1.6 倍** —— 于是「以为装得下、其实装不下」，
 * 压缩不触发，客户端照样收到 prompt is too long。
 *
 *   纯中文 0.528 tokens/字符   纯英文 0.222   纯数字 0.332   代码 0.352
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** 按内容类型分别计权（贴近上面的实测值，纯数值区间比对避免逐字正则分配开销）。 */
function tokenWeight(text) {
  const s = String(text);
  let cjk = 0;
  let digit = 0;
  let punct = 0;
  let word = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // CJK 统一表意文字及扩展 + 中文标点 + 兼容表意 + 全半角（等价于原 CJK 正则）
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0xf900 && c <= 0xfaff)
    ) {
      cjk++;
    } else if (c >= 48 && c <= 57) {
      digit++;
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32 || (c >= 9 && c <= 13)) {
      word++;
    } else {
      punct++;
    }
  }
  return cjk * 0.55 + digit * 0.33 + word * 0.25 + punct * 0.35;
}

/**
 * 估算一段文本 / 消息数组的 token 数（中文感知）。
 * 比 util.estimateTokens 更准，压缩预算必须用它。
 */
export function estimateTokensAccurate(input) {
  // null/undefined 要当作「没有内容」，不能 JSON.stringify 成 "null" 再算
  if (input === null || input === undefined || input === '') return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  if (!text) return 0;
  return Math.max(1, Math.ceil(tokenWeight(text)));
}

/**
 * 从上游 400 报错里解析真实上限，例如 "prompt is too long: 100001 tokens > 100000 maximum"。
 *
 * 注意：上游返回的 JSON 里 `>` 是**转义过的**（正文长这样：`tokens \u003e 100000`），
 * 直接把原始响应文本丢给正则匹配不到 —— 必须先还原。这个坑实测踩过：
 * 压缩逻辑明明写了却完全不触发，就是因为这里静默返回了 null。
 */
export function parseLimitFromError(text) {
  const s = String(text || '').replace(/\\u003[ce]/gi, (m) => (m.toLowerCase().endsWith('e') ? '>' : '<'));
  const m = s.match(/too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);
  if (m) return Number(m[2]);
  // 变体：context length exceeded / maximum context length is N tokens
  const m2 = s.match(/maximum (?:context )?length is\s*(\d+)/i);
  if (m2) return Number(m2[1]);
  const m3 = s.match(/max(?:imum)?[_\s-]?(?:input[_\s-]?)?tokens?[^0-9]{0,20}(\d{4,})/i);
  if (m3) return Number(m3[1]);
  // 兜底：context_length_exceeded 里如果只给了一个大数字，取 "maximum" 前面那个
  const m4 = s.match(/(\d{4,})\s*maximum/i);
  if (m4) return Number(m4[1]);
  return null;
}

/** 判断一个上游错误是不是「输入太长」。 */
export function isTooLongError(status, text) {
  if (status !== 400 && status !== 413 && status !== 422) return false;
  return /too long|context length|context_length_exceeded|maximum context|prompt is too long|exceed.*(?:token|context)|input.*too (?:large|long)/i.test(String(text || ''));
}

/**
 * 记下某模型能收多少 token。
 *
 * authoritative=true 表示「上游亲口报的」——它永远优先，因为实测目录里的值会偏大：
 * glm-5.1 目录写 200000，真实上限只有 100000。如果让目录值覆盖它，
 * 压缩就会按 200000 去压（压到 187k），仍然超限，白白多打一次上游。
 */
export function learnLimit(site, model, maxInputTokens, { authoritative = false } = {}) {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) return;
  const key = `${site}/${model}`;
  const prev = learnedLimits.get(key);
  if (prev?.authoritative && !authoritative) return; // 别用弱证据覆盖强证据
  learnedLimits.set(key, { value: maxInputTokens, authoritative: authoritative || Boolean(prev?.authoritative) });
}

export function learnedLimit(site, model) {
  return learnedLimits.get(`${site}/${model}`)?.value ?? null;
}

/**
 * 估算偏差的实测修正：`site/model` → 倍率（上游报的真实 tokens ÷ 本地估算）。
 *
 * 为什么需要：本地按字符类型加权估算（中文 0.55 / 英文 0.25 / 数字 0.33），
 * 对长会话里的 JSON、工具调用、代码混合文本会严重**低估**。实测一次真实
 * 1,193,121 tokens 的请求，本地只估到 620,249 —— 差 1.92 倍。
 * 后果：预压缩「压到 95% 上限」其实仍然超限，每个请求都要先撞一次 400 再重试，
 * 白等 20~30 秒。这里用上游亲口报的数字把这个倍率学出来。
 */
const estimateCalibration = new Map();

/**
 * 从上游 400 报错里解析**真实** token 数，
 * 例如 "prompt is too long: 1193121 tokens > 1048576 maximum"。
 * 同样要先还原被转义的 `>`（与 parseLimitFromError 同一个坑）。
 */
export function parseActualTokens(text) {
  const s = String(text || '').replace(/\\u003[ce]/gi, (m) => (m.toLowerCase().endsWith('e') ? '>' : '<'));
  const m = s.match(/(\d+)\s*tokens?\s*>\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * 用上游报的真实 token 数校准本地估算器。返回新倍率；样本不可用返回 null。
 * 倍率夹在 [1, 4]：只修「低估」，也避免单次异常样本把预算压得过狠。
 */
export function calibrateEstimate(site, model, 真实, 本地估算) {
  if (!Number.isFinite(真实) || !Number.isFinite(本地估算) || 真实 <= 0 || 本地估算 <= 0) return null;
  const 样本 = Math.min(4, Math.max(1, 真实 / 本地估算));
  const key = `${site}/${model}`;
  const prev = estimateCalibration.get(key);
  // 指数滑动平均：单次样本不带偏整体，又能较快收敛
  const 新 = prev ? prev * 0.5 + 样本 * 0.5 : 样本;
  estimateCalibration.set(key, 新);
  return 新;
}

/** 取该模型的估算修正倍率；没校准过就是 1（不改动原有行为）。 */
export function calibrationFactor(site, model) {
  return (site && estimateCalibration.get(`${site}/${model}`)) || 1;
}

/**
 * 上游把「输入远超上限」也报成 400 + `11133 model_param_invalid`，
 * 而不是那条带 token 数字的 `11115 prompt is too long`。
 * 后者能被 isTooLongError 匹配，前者只有一句通用文案，一个关键词都不匹配
 * —— 压缩逻辑完全不走，请求直接失败（实测 250 万字符触发，100 万字符仍是 200）。
 */
export function isProviderParamRejection(text) {
  const s = String(text || '');
  return /"code"\s*:\s*11133\b/.test(s) && /model_param_invalid/.test(s);
}

/** 清空学习到的上限与估算校准（测试用）。 */
export function resetLearnedLimits() {
  learnedLimits.clear();
  estimateCalibration.clear();
}

/**
 * 把消息切成「不可拆分的块」。
 * 一个 assistant(tool_calls) 连同紧随其后的若干 role:"tool" 属于同一块。
 */
export function splitBlocks(messages) {
  const blocks = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const hasCalls = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
    if (hasCalls) {
      const group = [m];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === 'tool') {
        group.push(messages[j]);
        j++;
      }
      blocks.push(group);
      i = j;
    } else {
      blocks.push([m]);
      i++;
    }
  }
  return blocks;
}

/** 估算一整组消息的 token（中文感知）。 */
export function estimateMessages(messages) {
  return estimateTokensAccurate(messages);
}

/**
 * 把单条消息的内容截断到指定 token 预算（保留头尾，中间打省略号）。
 * 只在「一条消息自己就超限」时使用——正常裁剪丢的是整块。
 */
export function truncateMessage(message, budgetTokens, { keepHeadRatio = 0.6 } = {}) {
  const clone = { ...message };
  const content = clone.content;
  if (typeof content !== 'string' || !content) return clone;

  // 凭「每字符多少 token」反推可保留的字符数（中文 ~0.55，英文 ~0.25，取中值偏保守）
  const 每字符 = Math.max(0.2, tokenWeight(content) / Math.max(1, content.length));
  const budgetChars = Math.max(200, Math.floor(budgetTokens / 每字符));
  if (content.length <= budgetChars) return clone;

  const head = Math.floor(budgetChars * keepHeadRatio);
  const tail = budgetChars - head;
  const 标记 = `\n\n…（此处省略 ${content.length - head - tail} 字，因超出模型上下文上限被代理截断）…\n\n`;
  clone.content = content.slice(0, head) + 标记 + content.slice(content.length - tail);
  return clone;
}

/**
 * 把 messages 裁到 maxInputTokens 以内。
 *
 * 返回 { messages, stats }：
 *   stats.dropped    被丢掉的消息条数
 *   stats.truncated  被截断内容的消息条数
 *   stats.before     裁剪前估算 token
 *   stats.after      裁剪后估算 token
 *   stats.limit      使用的上限
 *
 * 策略：
 *   1. system 块（开头的 system 消息）永远保留
 *   2. 从最老的块开始丢，直到装得下
 *   3. 至少保留 minKeepMessages 条（从最新往回数）——除非它们本身就超限
 *   4. 仍然超限 → 从最新往回，逐条截断内容
 */
export function fitMessages(messages, {
  maxInputTokens,
  reserveForOutput = 4096,
  minKeepMessages = 4,
  safetyRatio = 0.95,
} = {}) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  const stats = { dropped: 0, truncated: 0, before: 0, after: 0, limit: maxInputTokens ?? null, applied: false };
  if (!list.length) return { messages: list, stats };

  stats.before = estimateMessages(list);
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
    stats.after = stats.before;
    return { messages: list, stats };
  }

  const 预算 = Math.max(1024, Math.floor((maxInputTokens - Math.max(0, reserveForOutput)) * safetyRatio));
  if (stats.before <= 预算) {
    stats.after = stats.before;
    return { messages: list, stats };
  }

  // 1) 开头连续的 system 消息视为「系统提示」，不可丢
  let sysEnd = 0;
  while (sysEnd < list.length && String(list[sysEnd]?.role || '').toLowerCase() === 'system') sysEnd++;
  const 系统块 = list.slice(0, sysEnd);
  const 其余 = list.slice(sysEnd);
  const blocks = splitBlocks(其余);

  // 2) 从最老的块开始丢，但至少给最近 minKeepMessages 条留位置
  const 保留条数 = (bs) => bs.reduce((n, b) => n + b.length, 0);
  let maxDrop = blocks.length;
  while (maxDrop > 0 && 保留条数(blocks.slice(maxDrop)) < minKeepMessages) {
    maxDrop--;
  }

  // 二分查找满足 <= 预算的最小 起点（保留尽可能多的历史），避免在超长列表上反复 O(N) 线性全量估算
  let 起点 = 0;
  let l = 0, r = maxDrop;
  while (l < r) {
    const mid = (l + r) >> 1;
    const msgs = 系统块.concat(...blocks.slice(mid));
    if (estimateMessages(msgs) <= 预算) {
      r = mid;
    } else {
      l = mid + 1;
    }
  }
  起点 = l;
  let 当前 = 系统块.concat(...blocks.slice(起点));
  stats.dropped = 起点 > 0 ? 保留条数(blocks.slice(0, 起点)) : 0;

  // 3) 还是超 → 从最新往回逐条截断内容（最新的最该保住，所以从最老的开始截）
  if (estimateMessages(当前) > 预算) {
    const 系统token = estimateMessages(系统块);
    const 可分配 = Math.max(512, 预算 - 系统token);
    const 每条预算 = Math.max(256, Math.floor(可分配 / Math.max(1, 当前.length - 系统块.length)));
    for (let i = 系统块.length; i < 当前.length; i++) {
      // 必须和预算用同一个口径（tokenWeight 的中文感知估算）。
      // 这里曾经用粗略的 estimateTokens（3 字符≈1 token），与按 0.55/字符
      // 算出的「每条预算」不同量纲，于是该截断时不截断
      // （日志表现为「已自动压缩：丢弃 0 条、截断 0 条，A → A」，请求照样超限发出）。
      const before = estimateTokensAccurate(当前[i]);
      if (before <= 每条预算) continue;
      const 截断后 = truncateMessage(当前[i], 每条预算);
      // 内容不是字符串（多模态数组）等情况压不动，别把它算进 truncated
      if (截断后.content === 当前[i].content) continue;
      当前[i] = 截断后;
      当前[i]._proxy_truncated = true;
      stats.truncated++;
    }
  }

  stats.after = estimateMessages(当前);
  // 只有真的变小了才算「压缩生效」，而不是「超过了预算」：
  //   - applyContextFit 据此决定要不要打日志，否则会打出「已压缩：A → A」这种误导行
  //   - 上游重试据此判断「还压得动吗」，没变小就该停下，而不是白重试一轮
  stats.applied = stats.after < stats.before;
  return { messages: 当前, stats };
}
