// 上游（CodeBuddy / WorkBuddy，国内版与国际版同构）客户端：
//   - 请求体改写（上游只接受流式；tool_choice 只接受字符串）
//   - SSE 读取（带首字节/空闲超时，客户端断开即中止）
//   - 模型清单（含积分倍率）、额度查询
import crypto from 'node:crypto';
import { getAuth, ensureToken } from './auth.mjs';
import { markSuccess, markFailure, isQuotaError, usableCount } from './pool.mjs';
import { fitMessages, estimateMessages, learnedLimit, isTooLongError } from './compress.mjs';
import { chatHeaders, billingHeaders } from './headers.mjs';
import { warn } from './log.mjs';

/** 上游请求体改写：强制流式 + 首条必须为 system + 角色/工具选择归一 + 剔除配置中要求剔除的字段。 */
export function prepareBody(cfg, src) {
  const body = { ...src };
  body.stream = true;

  // 上游 role 白名单里没有 developer，等价改写为 system
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && typeof m === 'object' && typeof m.role === 'string' && m.role.toLowerCase() === 'developer') {
        m.role = 'system';
      }
    }

    // 国际版硬性要求：第一条消息必须是 system，否则 400 "first message is not system prompt"
    const first = body.messages[0];
    const firstRole = first && typeof first === 'object' ? String(first.role || '').toLowerCase() : '';
    if (firstRole !== 'system') {
      body.messages = [
        { role: 'system', content: cfg.defaultSystemPrompt || 'You are a helpful AI assistant.' },
        ...body.messages,
      ];
    }
  }

  // tool_choice：上游是字符串字段，对象形式会 400
  normalizeToolChoice(body);

  for (const key of cfg.stripFields || []) delete body[key];
  return body;
}

/**
 * 按模型上下文上限裁剪 messages（原地改 body.messages）。
 *
 * 单独成一个函数而不是塞进 prepareBody：
 *   - prepareBody 只做「格式归一」，不依赖模型上限，纯函数好测
 *   - 裁剪依赖「上限已知」，而上限可能要等上游报错才知道，见 openChat 的重试逻辑
 *
 * 上限来源（优先用学到的真实值）：
 *   目录里的 maxInputTokens 实测会偏大 —— glm-5.1 目录写 200000，
 *   真实上限只有 100000。所以一旦上游报「太长」，就记下它给的真实数字。
 *
 * 返回裁剪统计；没裁返回 null。
 */
export function applyContextFit(cfg, body, { site = null, limitOverride = null } = {}) {
  const conf = cfg.context || {};
  if (conf.enabled === false) return null;
  if (!Array.isArray(body.messages) || !body.messages.length) return null;

  const model = String(body.model || '');
  const limit = limitOverride || (site ? learnedLimit(site, model) : null);
  if (!Number.isFinite(limit) || limit <= 0) return null; // 不知道上限就先原样发，撞墙后再学

  const { messages, stats } = fitMessages(body.messages, {
    maxInputTokens: limit,
    reserveForOutput: Number(body.max_tokens) || conf.reserveForOutput || 4096,
    minKeepMessages: conf.minKeepMessages ?? 4,
    safetyRatio: conf.safetyRatio ?? 0.95,
  });
  body.messages = messages;
  return stats.applied ? stats : null;
}

function normalizeToolChoice(body) {
  if (!('tool_choice' in body)) return;
  const tc = body.tool_choice;
  const drop = () => {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  };
  if (typeof tc === 'string') {
    if (tc.toLowerCase() === 'none') drop();
    return;
  }
  if (tc && typeof tc === 'object') {
    const type = String(tc.type || '').toLowerCase();
    if (type === 'none') return drop();
    if (type === 'auto' || type === 'required') {
      body.tool_choice = type;
      return;
    }
    if (type === 'function') {
      const name = tc.function?.name || tc.name;
      body.tool_choice = name ? String(name) : 'auto';
      return;
    }
  }
  delete body.tool_choice;
}

export class UpstreamError extends Error {
  constructor(message, { status = 502, code = null, transport = false, site = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.transport = transport;
    this.site = site;
  }
}

/**
 * 发起一次站点聊天请求。
 * 返回：{ ok:true, status, frames:AsyncGenerator<string>, close(), payload } 或
 *      { ok:false, status, text }
 */
export async function openChat(cfg, site, body, { signal, exclude = [], accountId = null } = {}) {
  const siteCfg = cfg.sites[site];
  // ensureToken 会选定账号（池模式）并把该账号的 token 暴露给 getAuth，
  // 因此必须先 await，再取 chatHeaders——顺序不能反。
  const { accountId: usedAccount } = await ensureToken(cfg, site, { exclude, accountId });
  const auth = getAuth(site);
  const model = String(body?.model || '');
  const payload = prepareBody(cfg, body);
  const fit = applyContextFit(cfg, payload, { site });
  if (fit) {
    warn(
      `[${site}] ${model} 上下文超限，已自动压缩：丢弃 ${fit.dropped} 条、截断 ${fit.truncated} 条，`
      + `${fit.before} → ${fit.after} tokens（上限 ${fit.limit}）`,
    );
  }

  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(new Error('client closed'));
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let settled = false;
  let headerTimer = setTimeout(() => ac.abort(new Error('upstream header timeout')), cfg.timeouts.headerMs);
  let idleTimer = null;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(headerTimer);
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  };
  const bumpIdle = () => {
    if (settled) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new Error('upstream idle timeout')), cfg.timeouts.idleMs);
  };

  // 连接级失败自动重试：国际版（codebuddy.ai）实测约有 17% 的 ECONNRESET / socket 抖动，
  // 这类瞬时网络错误重试一两次即可恢复。只重试「连接建立/传输」错误，
  // 不重试 HTTP 业务错误，也不重试客户端主动断开（那是用户取消）。
  //
  // 外层再套一圈「太长就压缩后重试」：上游的真实上限常常比目录里写的小
  // （glm-5.1 目录 200000 / 真实 100000），第一次发过去才知道，
  // 这时学到真实值、按它重新裁剪，再发一次，客户端就不用看到裸报错了。
  const 最大尝试 = Number(cfg.upstreamRetry?.attempts ?? 3);
  const 退避 = Array.isArray(cfg.upstreamRetry?.backoffMs) ? cfg.upstreamRetry.backoffMs : [400, 1000];
  let res;
  let 最后错误;
  let 当前payload = payload;
  let 压缩重试次数 = 0;
  const 最大压缩重试 = 3; // 上限未知时要从全量往下爬，多留一次

  for (;;) {
    for (let 尝试 = 1; 尝试 <= 最大尝试; 尝试++) {
      try {
        res = await fetch(siteCfg.apiBase + '/v2/chat/completions', {
          method: 'POST',
          headers: chatHeaders(siteCfg, auth),
          body: JSON.stringify(当前payload),
          signal: ac.signal,
        });
        最后错误 = null;
        break;
      } catch (e) {
        最后错误 = e;
        const 客户端取消 = signal?.aborted || /client closed/i.test(String(e?.message || ''));
        if (客户端取消) break; // 用户取消，不重试
        if (尝试 < 最大尝试) {
          warn(`[${site}] 连接失败（${e?.cause?.code || e?.message || e}），第 ${尝试} 次重试…`);
          await new Promise((r) => setTimeout(r, 退避[Math.min(尝试 - 1, 退避.length - 1)] ?? 500));
        }
      }
    }
    if (!res) break; // 连接失败，交给下面统一抛错

    // 只在「输入太长」且还有机会压缩时重试
    if (res.status < 400 || 压缩重试次数 >= 最大压缩重试) break;
    const text = await res.text().catch(() => '');
    if (!isTooLongError(res.status, text)) {
      // 不是「太长」，把读掉的 body 还原成一个可返回的结果
      res = { status: res.status, _text: text };
      break;
    }

    // 上游报的「too long: N > M maximum」里的数字**不可信**，实测：
    //   glm-5.1 报 "100001 tokens > 100000 maximum"，但同一模型
    //   34 万字符（实测 180030 tokens）明明能正常返回 200。
    //   真正触发 400 的是请求体积（约 34~40 万字符），报错信息是误导性的。
    //   所以这里不把它当成模型的真实上限，只当「这次发太大了」的信号，
    //   用「相对收缩 + 重试」逐步逼近，而不是一步跳到那个数字。
    const 已知上限 = learnedLimit(site, model);
    const 当前估计 = estimateMessages(当前payload.messages);
    const 收缩比 = 压缩重试次数 === 0 ? 0.75 : 0.5;
    // 已知上限比当前还小时直接按它压，否则按比例收缩
    const 预算 = Math.min(已知上限 ?? Number.POSITIVE_INFINITY, Math.floor(当前估计 * 收缩比));

    const 更小 = fitMessages(Array.isArray(当前payload.messages) ? 当前payload.messages : [], {
      maxInputTokens: 预算,
      reserveForOutput: 0,
      minKeepMessages: cfg.context?.minKeepMessages ?? 4,
      safetyRatio: 1,
    });
    if (!更小.stats.applied) break; // 压不动了，别再试
    当前payload = { ...当前payload, messages: 更小.messages };
    压缩重试次数++;
    warn(
      `[${site}] ${model} 输入超限（${text.slice(0, 100).replace(/\s+/g, ' ')}），`
      + `已压缩上下文后重试（丢弃 ${更小.stats.dropped} 条，截断 ${更小.stats.truncated} 条，`
      + `${更小.stats.before} → ${更小.stats.after} tokens，目标 ${预算}）`,
    );
    res = undefined;
  }
  if (!res) {
    clearTimeout(headerTimer);
    cleanup();
    const 原因 = 最后错误?.cause?.code || 最后错误?.message || 最后错误;
    throw new UpstreamError(`[${site}] 上游连接失败（已重试 ${最大尝试} 次）：${原因}`, { status: 504, transport: true, site });
  }
  clearTimeout(headerTimer);

  if (res.status >= 400) {
    const text = res._text !== undefined ? res._text : await res.text().catch(() => '');
    cleanup();
    return { ok: false, status: res.status, text, payload: 当前payload, site, accountId: usedAccount };
  }

  // 上游接受了这次请求 → 说明该账号可用，清掉它的失败计数
  markSuccess(site, usedAccount);

  bumpIdle();
  return {
    ok: true,
    status: res.status,
    site,
    accountId: usedAccount,
    payload: 当前payload,
    frames: readSSE(res.body, { onActivity: bumpIdle, onEnd: cleanup }),
    close: () => {
      ac.abort(new Error('closed'));
      cleanup();
    },
  };
}

/** 逐行解析上游 SSE，只产出 data: 载荷字符串；[DONE] / 流结束即返回。 */
async function* readSSE(stream, { onActivity, onEnd }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity?.();
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!line.startsWith('data:')) continue; // 注释/心跳行忽略
        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') return;
        if (payload) yield payload;
      }
    }
    const tail = (buf + decoder.decode()).trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trimStart();
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    onEnd?.();
  }
}

/** 判断一帧是错误信封还是正常 chunk。 */
export function classifyFrame(payload) {
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return { kind: 'garbage' };
  }
  if (obj && typeof obj === 'object' && !obj.choices && (obj.code || obj.error)) {
    const msg = obj.msg || obj.error?.message || JSON.stringify(obj.error) || `上游错误 code=${obj.code}`;
    return { kind: 'error', code: obj.code ?? null, message: String(msg) };
  }
  return { kind: 'chunk', obj };
}

/** 聚合上游流为单个完整回复（供非流式客户端使用）。 */
export async function aggregateFrames(frames) {
  const out = {
    id: null,
    model: null,
    created: null,
    role: 'assistant',
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    frames: 0,
  };
  for await (const payload of frames) {
    const parsed = classifyFrame(payload);
    if (parsed.kind !== 'chunk') {
      if (parsed.kind === 'error') throw new UpstreamError(parsed.message, { status: 502, code: parsed.code });
      continue;
    }
    out.frames++;
    const c = parsed.obj;
    if (!out.id && c.id) out.id = c.id;
    if (!out.model && c.model) out.model = c.model;
    if (!out.created && c.created) out.created = c.created;
    if (c.usage) out.usage = c.usage;
    const choice = Array.isArray(c.choices) ? c.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (delta.role) out.role = delta.role;
    if (typeof delta.content === 'string') out.content += delta.content;
    if (typeof delta.reasoning_content === 'string') out.reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        const cur = out.toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.function.name = tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        out.toolCalls.set(idx, cur);
      }
    }
  }
  out.toolCallList = [...out.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return out;
}

/**
 * 描述一次 fetch 失败的原因。
 *
 * 为什么要区分：超时（AbortError）与其他失败（URL 非法、DNS 失败、连接被拒）
 * 是完全不同的问题，混在一句「超时或网络异常」里会把排查方向带偏——
 * 例如站点漏配 billingBase 会拼出 undefined/... 的非法 URL，
 * 那属于配置错误，不是网络抖动。
 */
function describeFetchFailure(e, timeoutMs) {
  const msg = String(e?.message || e);
  const isTimeout = e?.name === 'AbortError' || /timeout|aborted/i.test(msg);
  if (isTimeout) return `${Math.round(timeoutMs / 1000)}s 超时`;
  if (/Failed to parse URL|Invalid URL/i.test(msg)) return `URL 无效（多半是站点配置缺少 apiBase / billingBase）：${msg}`;
  return `网络异常：${msg}`;
}

/**
 * 带超时的 fetch（用于非流式的元数据接口：模型列表 / 额度查询）。
 *
 * 为什么需要：这些接口原先既无 signal 也无超时，上游挂起时请求会永久悬挂，
 * 导致 /v1/models、/status、控制台首屏全部卡死且连接不释放。
 * 注意与 openChat 的区别：聊天接口是流式的，超时按「首字节/流中空闲」分别控制，
 * 不能用单一总时长，因此这里只服务于一次性请求。
 *
 * 返回 { res, text, dispose }：超时定时器要覆盖到 body 读完为止（仅等响应头不够，
 * 上游发完头再挂起同样会卡死），所以由调用方在读完 body 后调 dispose()。
 */
function fetchWithTimeout(url, { timeoutMs, ...init } = {}) {
  const ac = new AbortController();
  const ms = Math.max(1, Number(timeoutMs) || 0);
  const timer = setTimeout(() => ac.abort(new Error(`request timeout after ${ms}ms`)), ms);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
  };
  const p = fetch(url, { ...init, signal: ac.signal }).then(
    (res) => ({
      res,
      text: async () => {
        try {
          return await res.text();
        } finally {
          dispose();
        }
      },
      dispose,
    }),
    (e) => {
      dispose();
      throw e;
    },
  );
  return p;
}

/** 拉取站点可用模型清单（含积分倍率）。 */
export async function fetchModels(cfg, site) {
  const siteCfg = cfg.sites[site];
  await ensureToken(cfg, site);
  const auth = getAuth(site);
  const timeoutMs = cfg.timeouts?.metaMs ?? 30000;
  let res, text;
  try {
    const r = await fetchWithTimeout(siteCfg.apiBase + '/console/enterprises/personal/models', {
      timeoutMs,
      headers: { ...chatHeaders(siteCfg, auth), Accept: 'application/json' },
    });
    res = r.res;
    text = await r.text();
  } catch (e) {
    throw new UpstreamError(`[${site}] 模型接口请求失败（${describeFetchFailure(e, timeoutMs)}）`, { status: 504, transport: true, site });
  }
  if (res.status !== 200) throw new UpstreamError(`[${site}] 模型接口 HTTP ${res.status}：${text.slice(0, 200)}`, { status: res.status, site });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError(`[${site}] 模型接口返回无法解析（HTTP ${res.status}）`, { status: 502, site });
  }
  if (json.code !== 0) throw new UpstreamError(`[${site}] 模型接口 code=${json.code}：${String(json.msg || '').slice(0, 200)}`, { status: 502, site });
  const models = json.data?.models || [];
  const agents = json.data?.agents || [];
  const cli = agents.find((a) => a.name === 'cli');
  const cliIds = cli?.models?.length ? new Set(cli.models) : null;
  return models
    .filter((m) => !m.disabled && (!cliIds || cliIds.has(m.id)))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      credits: m.credits || null, // 积分倍率，如 "x0.79 credits"；x0.00 表示不扣积分
      contextWindow: m.maxInputTokens || null,
      maxTokens: m.maxOutputTokens || null,
      supportsImages: Boolean(m.supportsImages),
      supportsToolCall: Boolean(m.supportsToolCall),
      supportsReasoning: Boolean(m.supportsReasoning),
    }));
}

/**
 * 该站点是否支持额度查询。
 *
 * 没有配置 billingBase 的站点不使用 CodeBuddy 的计费接口，
 * 站点预设里本就没有该字段。此时不应发起查询——否则会拼出
 * "undefined/v2/billing/meter/get-user-resource" 这种无效 URL，
 * 还会被当作网络故障上报，把「该站点不适用」误报成「超时」。
 */
export function supportsCreditQuery(cfg, site) {
  const b = cfg.sites?.[site]?.billingBase;
  return typeof b === 'string' && b.trim().length > 0;
}

/**
 * 查询站点剩余积分（免费额度）。国际版计费口径不同，失败时静默返回错误信息。
 * accountId 指定时查该账号——控制台要逐个账号看余额。
 */
export async function queryCredit(cfg, site, accountId = null) {
  const siteCfg = cfg.sites[site];
  if (!supportsCreditQuery(cfg, site)) {
    throw new UpstreamError(
      `[${site}] 该站点不支持额度查询（协议与 CodeBuddy 不同，未配置 billingBase）`,
      { status: 501, site },
    );
  }
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  };
  const timeoutMs = cfg.timeouts?.metaMs ?? 30000;
  let res, text;
  try {
    const r = await fetchWithTimeout(siteCfg.billingBase + '/v2/billing/meter/get-user-resource', {
      timeoutMs,
      method: 'POST',
      headers: billingHeaders(siteCfg, auth),
      body: JSON.stringify(body),
    });
    res = r.res;
    text = await r.text();
  } catch (e) {
    throw new UpstreamError(`[${site}] 额度接口请求失败（${describeFetchFailure(e, timeoutMs)}）`, { status: 504, transport: true, site });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError(`[${site}] 额度接口返回无法解析（HTTP ${res.status}）`, { status: 502, site });
  }
  if (json.code !== 0) throw new UpstreamError(`[${site}] 额度接口 code=${json.code}：${String(json.msg || '').slice(0, 160)}`, { status: 502, site });
  const accounts = json.data?.Response?.Data?.Accounts || [];
  let remain = 0;
  const detail = [];
  for (const a of accounts) {
    const r = a.CycleCapacitySize > 0 ? a.CycleCapacityRemain : a.CapacityRemain;
    const n = Math.max(0, Number(r) || 0);
    remain += n;
    detail.push({ package: a.PackageName, remain: n, used: a.CycleCapacityUsed ?? a.CapacityUsed ?? null });
  }
  return { remain, detail };
}

/**
 * 带「账号轮换」的上游调用，三个协议入口（OpenAI / Anthropic / Responses）共用。
 *
 * 处理顺序（每一步都只在「还没成功」时继续）：
 *   1) 正常发一次（openChat 内部已按号池选号）
 *   2) 401 → 原地强刷该账号 token 重试一次（可能只是 token 过期，不必换号）
 *   3) 仍然失败 → 把该账号上报号池（额度耗尽/冷却），换一个账号重试
 *   4) 号池里没有别的可用账号了 → 原样返回最后一次的错误，交给上层做站点降级
 *
 * 返回 { up, tried }：tried 是本次已经用过的账号 id 列表。
 */
export async function openChatRotating(cfg, site, body, { signal, maxAccounts = 0 } = {}) {
  const tried = [];
  const 上限 = maxAccounts > 0 ? maxAccounts : Math.max(1, Number(cfg.pool?.maxAccountsPerRequest ?? 3));
  let up = null;

  for (let i = 0; i < 上限; i++) {
    up = await openChat(cfg, site, body, { signal, exclude: tried });
    if (up.ok) return { up, tried };
    if (!up.accountId) return { up, tried }; // 兼容模式（单账号），没有可换的
    if (tried.includes(up.accountId)) return { up, tried }; // 池里只剩它，别死循环

    // 401：先原地刷 token。很多情况下只是 token 过期，换号反而浪费一个账号。
    if (up.status === 401 && i === 0) {
      warn(`[${site}] 上游 401，强制刷新账号 ${up.accountId} 的 token 后重试`);
      try {
        await ensureToken(cfg, site, { force: true, accountId: up.accountId });
        const retry = await openChat(cfg, site, body, { signal, accountId: up.accountId });
        if (retry.ok) return { up: retry, tried };
        up = retry;
      } catch (e) {
        warn(`[${site}] 刷新 token 失败：`, e.message);
      }
    }

    // 上报号池：额度类错误会被标记为「耗尽」，其余走冷却退避
    markFailure(site, up.accountId, { status: up.status, message: up.text });
    tried.push(up.accountId);

    const 还有号 = usableCount(site, undefined, tried) > 0;
    if (!还有号) return { up, tried };
    const 原因 = isQuotaError(up.status, up.text) ? '额度不足' : `HTTP ${up.status}`;
    warn(`[${site}] 账号 ${up.accountId} ${原因}，切换下一个账号重试`);
  }
  return { up, tried };
}

export function upstreamErrorMessage(status, text, site = '') {  let msg = text || '';
  try {
    const j = JSON.parse(text);
    msg = j.msg || j.error?.message || j.message || text;
  } catch {
    if (status === 500 && /<html/i.test(msg)) msg = '上游网关 500（该接口在该站点不可用或临时故障）';
    else if (/<html/i.test(msg)) msg = msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const prefix = site ? `[${site}] ` : '';
  const map = {
    401: '上游 401：登录态失效，请重新登录',
    402: '上游 402：额度/积分不足',
    404: '上游 404：接口偶发不可用，稍后重试',
    429: '上游 429：触发限流，稍后重试',
  };
  const head = map[status] || `上游 HTTP ${status}`;
  warn(`${prefix}上游返回 ${status}：${String(msg).slice(0, 200)}`);
  return `${prefix}${head}：${String(msg).slice(0, 500)}`;
}

export function newId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}
