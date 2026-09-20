// DeepSeek 官方站点（chat.deepseek.com）上游客户端。
//
// 与 CodeBuddy 站点（src/upstream.mjs）协议完全不同，故独立实现：
//   1. POST /api/v0/chat/create_pow_challenge   申请工作量证明挑战
//   2. 用 wasm 求解 → X-DS-PoW-Response 头
//   3. POST /api/v0/chat_session/create         创建会话（UUID）
//   4. POST /api/v0/chat/completion             发起补全，SSE 返回
//
// 凭证：auth.deepseek.json { accessToken, ... }（token 由用户从浏览器粘贴）
import { loadAuth, saveAuth } from './auth.mjs';
import { solvePowHeader } from './deepseek-pow.mjs';
import { log, warn } from './log.mjs';

export const DS_SITE = 'deepseek';
export const DS_API = 'https://chat.deepseek.com';
export const DS_COMPLETION_PATH = '/api/v0/chat/completion';

/** 浏览器指纹：对齐官方 Web 端，缺失会让 WAF 拦截。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

/** 官方 Web 端固定携带的客户端标识头（抓包确认，缺一不可）。 */
export function baseHeaders(token, referer = `${DS_API}/`) {
  return {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: DS_API,
    Referer: referer,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-timezone-offset': '28800',
    'x-client-version': '2.5.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export class DeepSeekError extends Error {
  constructor(message, { status = 502, code = null, transport = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.transport = transport;
  }
}

/** 统一信封解析：{ code, msg, data }，code !== 0 视为业务错误。 */
function unwrap(json, what) {
  if (json?.code === 0) return json.data;
  const code = json?.code;
  const map = {
    40002: 'token 缺失',
    40003: 'token 无效或已过期',
    40012: '账号已被封禁',
    40029: 'IP 被限制',
    40300: 'PoW 头缺失或被拒绝',
    40301: 'PoW 答案无效',
    50006: '账号被禁言',
  };
  const hint = map[code] ? `（${map[code]}）` : '';
  throw new DeepSeekError(`${what}失败：code=${code} ${json?.msg || ''}${hint}`, {
    status: code === 40003 || code === 40002 ? 401 : 502,
    code,
  });
}

/** 取该站点 token；未登录抛 401。 */
export function dsToken() {
  const a = loadAuth(DS_SITE);
  if (!a.accessToken) {
    throw new DeepSeekError('DeepSeek 站点未配置 token：请运行 `node login-deepseek.mjs` 或把 token 写入 auth.deepseek.json', {
      status: 401,
      code: 40002,
    });
  }
  return a.accessToken;
}

export function saveToken(token, extra = {}) {
  return saveAuth(DS_SITE, { accessToken: String(token).trim(), savedAt: new Date().toISOString(), ...extra });
}

/** 校验 token 是否有效，有效时返回账号信息。 */
export async function verifyToken(token) {
  const res = await fetch(`${DS_API}/api/v0/users/current`, { headers: baseHeaders(token) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DeepSeekError(`校验 token 失败：返回非 JSON（HTTP ${res.status}）`, { status: 502 });
  }
  if (json.code !== 0) unwrap(json, '校验 token');
  return json.data || {};
}

/** 申请 PoW 挑战。 */
export async function createPowChallenge(token, targetPath = DS_COMPLETION_PATH) {
  const res = await fetch(`${DS_API}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: { ...baseHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_path: targetPath }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DeepSeekError(`申请 PoW 挑战返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, { status: 502 });
  }
  const data = unwrap(json, '申请 PoW 挑战');
  const challenge = data?.biz_data?.challenge;
  if (!challenge) throw new DeepSeekError('申请 PoW 挑战响应里没有 challenge 字段', { status: 502 });
  return challenge;
}

/** 创建会话，返回 UUID。 */
export async function createSession(token) {
  const res = await fetch(`${DS_API}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: { ...baseHeaders(token), 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DeepSeekError(`创建会话返回非 JSON（HTTP ${res.status}）`, { status: 502 });
  }
  const data = unwrap(json, '创建会话');
  // 响应结构：data.biz_data.chat_session.id（Round 11 实测确认）
  const id = data?.biz_data?.chat_session?.id ?? data?.biz_data?.id;
  if (!id) throw new DeepSeekError('创建会话响应里没有会话 ID', { status: 502 });
  return id;
}

/**
 * 把「代理对外暴露的模型 ID」映射到官方补全参数。
 *
 * 官方 Web 端没有模型选择器，只有 model_type="default" 加上两个开关
 * （thinking_enabled / search_enabled），因此这里用别名承载组合：
 *   deepseek-reasoner → 开深度思考
 *   deepseek-search   → 开联网搜索
 *   deepseek-chat     → 默认
 */
export function resolveOptions(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('reasoner') || m.includes('think') || m.includes('r1')) {
    return { modelType: 'default', thinking: true, search: false };
  }
  if (m.includes('search')) {
    return { modelType: 'default', thinking: false, search: true };
  }
  return { modelType: 'default', thinking: false, search: false };
}

/**
 * 把 OpenAI 风格的 messages 压平成官方要求的单个 prompt 字符串。
 *
 * 官方 /api/v0/chat/completion 只接受一个 `prompt` 字段，没有 messages 数组，
 * 因此多轮对话必须在这里序列化成文本。采用通用的角色标签格式。
 */
export function flattenMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const parts = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || 'user').toLowerCase();
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b && b.type === 'text') return b.text || '';
          return '';
        })
        .join('');
    }
    if (m.tool_calls?.length) {
      text += '\n' + m.tool_calls
        .map((tc) => `[调用工具 ${tc.function?.name}: ${tc.function?.arguments || '{}'}]`)
        .join('\n');
    }
    if (!text.trim()) continue;

    if (role === 'system' || role === 'developer') parts.push(`[系统指令]\n${text}`);
    else if (role === 'assistant') parts.push(`[助手]\n${text}`);
    else if (role === 'tool') parts.push(`[工具结果]\n${text}`);
    else parts.push(text);
  }

  // 单条 user 消息是最常见情形，直接返回原文，避免多余的标签干扰
  if (parts.length === 1) return parts[0];

  // 多轮：前面的对话作为上下文，最后一条保持无标签以便模型直接接续
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const head = parts.slice(0, -1).join('\n\n');
    return `${head}\n\n${last}`;
  }
  return parts.join('\n\n');
}

/**
 * 发起一次补全（总是流式）。
 * @returns {{ok:true, sessionId, frames:AsyncGenerator<string>, close:()=>void}} 或 {ok:false, status, text}
 */
export async function openCompletion(token, { prompt, sessionId, modelType = 'default', thinking = false, search = false, signal } = {}) {
  const sid = sessionId || (await createSession(token));

  // 每次补全都需要一个新的 PoW（挑战有 5 分钟有效期）
  const t0 = Date.now();
  const challenge = await createPowChallenge(token, DS_COMPLETION_PATH);
  const powHeader = solvePowHeader(challenge, DS_COMPLETION_PATH);
  log(`[deepseek] PoW 求解完成（difficulty=${challenge.difficulty}，${Date.now() - t0}ms）`);

  const body = {
    chat_session_id: sid,
    parent_message_id: null,
    model_type: modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: Boolean(thinking),
    search_enabled: Boolean(search),
    action: null,
    preempt: false,
  };

  const res = await fetch(`${DS_API}${DS_COMPLETION_PATH}`, {
    method: 'POST',
    headers: {
      ...baseHeaders(token, `${DS_API}/a/chat/s/${sid}`),
      'Content-Type': 'application/json',
      'x-ds-pow-response': powHeader,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (res.status >= 400) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text, sessionId: sid };
  }

  // 读取器与 close() 必须共用同一个 reader，否则 cancel() 会因流被锁而抛错
  // （ERR_INVALID_STATE: ReadableStream is locked），且是异步 rejection，
  // try/catch 拦不住，会变成未处理的 Promise 异常。
  const reader = res.body.getReader();
  const finalize = () => {
    // 主动取消读取，释放连接；cancel 的 rejection 必须显式吞掉
    reader.cancel().catch(() => {});
  };

  return {
    ok: true,
    status: res.status,
    sessionId: sid,
    frames: readDeepSeekSSEFromReader(reader, finalize),
    close: finalize,
  };
}

/**
 * 解析 DeepSeek 的 SSE 流（对外入口，自行获取 reader）。
 */
export function readDeepSeekSSE(stream) {
  const reader = stream.getReader();
  return readDeepSeekSSEFromReader(reader, () => {
    reader.cancel().catch(() => {});
  });
}

/**
 * 解析 DeepSeek 的 SSE 流（核心实现，复用外部传入的 reader）。
 *
 * 官方帧形如：
 *   event: ready
 *   data: {"type":"ready",...}
 *
 * 注意：`event:` 行与载荷里的 `type` 字段**都要用**——
 * 有些帧（如 close/finish）只有 event 行可靠，因此这里把 event 名
 * 一并注入载荷，供 extractDelta 判断终止。
 *
 * 产出 JSON 字符串（与 CodeBuddy 的 readSSE 保持一致的消费方式）。
 *
 * @param {ReadableStreamDefaultReader} reader 已获取的读取器
 * @param {() => void} onEnd 流结束时的清理回调（用于释放连接）
 */
export async function* readDeepSeekSSEFromReader(reader, onEnd) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let pendingEvent = null; // 当前帧的 event 名

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

        if (line.startsWith('event:')) {
          const ev = line.slice(6).trim();
          // 终止类事件即便没有后续 data 行也必须立即上报，
          // 否则流会一直挂到超时（官方有时只发 "event: close"）。
          if (TERMINAL_EVENTS.has(ev)) {
            pendingEvent = null;
            yield JSON.stringify({ event: ev, type: ev });
            continue;
          }
          pendingEvent = ev;
          continue;
        }
        if (!line.startsWith('data:')) continue; // 注释/心跳行忽略

        const payload = line.slice(5).trim();
        const ev = pendingEvent;
        pendingEvent = null;
        if (!payload || payload === '[DONE]') {
          // 仅有 event 行、无 data 的终止帧（如 event: close）
          if (ev && TERMINAL_EVENTS.has(ev)) yield JSON.stringify({ event: ev, type: ev });
          continue;
        }

        // 把 event 名注入载荷（载荷没写 type 时尤其重要）
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          yield payload;
          continue;
        }
        if (ev && obj && typeof obj === 'object' && !obj.event && !obj.type) obj.event = ev;
        yield JSON.stringify(obj);
      }
    }

    // 收尾：处理没有换行结尾的最后一行
    const tail = buf.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') yield payload;
    } else if (tail.startsWith('event:') && TERMINAL_EVENTS.has(tail.slice(6).trim())) {
      const ev = tail.slice(6).trim();
      yield JSON.stringify({ event: ev, type: ev });
    }
  } finally {
    onEnd?.();
  }
}

/**
 * 事件名枚举（从官方 main bundle 的 NewSSEEventName 提取，确认无误）：
 *   ready / delta / toast / title / finish / close / hint
 *   updateSession / updateParentMessage / updateFile
 *
 * 其中承载正文的是 `delta` 事件。
 */
export const SS_EVENTS = Object.freeze({
  READY: 'ready',
  DELTA: 'delta',
  TOAST: 'toast',
  TITLE: 'title',
  FINISH: 'finish',
  CLOSE: 'close',
  HINT: 'hint',
  UPDATE_SESSION: 'updateSession',
  UPDATE_PARENT_MESSAGE: 'updateParentMessage',
  UPDATE_FILE: 'updateFile',
});

/** 结束类事件：收到即代表本轮生成完毕。 */
const TERMINAL_EVENTS = new Set([SS_EVENTS.CLOSE, SS_EVENTS.FINISH]);

/**
 * 非正文事件：这些事件即便带着 content/text 字段也不是回复内容，
 * 必须整帧忽略，否则会把提示语、标题、错误码混进回答里。
 */
const NON_CONTENT_EVENTS = new Set([
  SS_EVENTS.READY,
  SS_EVENTS.TOAST,
  SS_EVENTS.TITLE,
  SS_EVENTS.HINT,
  SS_EVENTS.UPDATE_SESSION,
  SS_EVENTS.UPDATE_PARENT_MESSAGE,
  SS_EVENTS.UPDATE_FILE,
]);

/** 承载正文的事件名（官方确认 delta 是正文事件；其余为兼容命名）。 */
const CONTENT_EVENTS = new Set([
  SS_EVENTS.DELTA,
  'text', 'message',
  'think', 'thinking', 'reasoning',
]);

/** 思考/推理相关的路径关键词。 */
const REASONING_HINTS = ['thinking', 'reasoning', 'thought'];

/** 元数据字段：值是路径/ID/状态而非正文，递归时跳过。 */
const META_KEYS = new Set([
  'p', 'id', 'message_id', 'chat_session_id', 'chat_message_id',
  'status', 'type', 'event', 'role', 'finish_reason', 'parent_message_id',
  'model_type', 'inserted_at', 'updated_at',
]);

/**
 * 从 DeepSeek 的 SSE 载荷里抽取增量文本与结束状态。
 *
 * 官方真实帧（Round 11 线上抓取确认）采用 **JSON-Patch 语义**（p/o/v = 路径/操作/值）：
 *
 *   快照（updateSession 里携带）：
 *     {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"你好",...}]}}}
 *
 *   增量（正文追加）：
 *     {"p":"response/fragments/-1/content","o":"APPEND","v":"啊"}
 *
 *   状态与元数据：
 *     {"p":"response/status","o":"SET","v":"FINISHED"}
 *     {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":40},...]}
 *
 *   事件行：event: ready / update_session / title / close / delta
 *
 * 因此解析规则为：
 *   1. 带 `o`（操作）字段且 `p` 指向 fragments/content 的帧 → 正文增量
 *      （`p` 含 thinking/reasoning → 推理内容）
 *   2. `p === "response/status"` 且值为 FINISHED → 本轮结束
 *   3. `o: "BATCH"` → 元数据批量更新（可能含 token 用量），不当正文
 *   4. 兼容早期猜测的直给形态（type:text/content 等）
 */
export function extractDelta(obj) {
  if (!obj || typeof obj !== 'object') return { text: '', reasoning: '', done: false };

  const evName = String(obj.type || obj.event || '');
  if (TERMINAL_EVENTS.has(evName)) return { text: '', reasoning: '', done: true };

  // 快照帧优先于事件名过滤：真实流中快照挂在 update_session 事件下，
  // 但它携带 fragments（初始正文），必须先于 NON_CONTENT_EVENTS 处理。
  if (obj.v?.response && Array.isArray(obj.v.response.fragments)) {
    // 快照帧给出当前 fragments 的完整状态（初始正文）。
    // 官方流：先快照（含已生成的初始正文），后续 APPEND 帧追加增量。
    // 对流式客户端：快照正文必须先发出，否则首字丢失。
    let text = '';
    let reasoning = '';
    for (const f of obj.v.response.fragments) {
      if (!f || typeof f.content !== 'string') continue;
      if (f.type === 'THINKING' || f.type === 'REASONING') reasoning += f.content;
      else text += f.content;
    }
    return { text, reasoning, done: false };
  }

  // ---------- 真实形态：JSON-Patch（p/o/v） ----------
  if (typeof obj.p === 'string' && typeof obj.o === 'string') {
    const path = obj.p;

    // 状态帧：response/status → SET FINISHED 表示生成结束
    if (path === 'response/status' || path === 'response/quasi_status') {
      const finished = obj.v === 'FINISHED' || obj.v === 'CONTENT_FILTER';
      return { text: '', reasoning: '', done: Boolean(finished) };
    }

    // 元数据批量更新：可能含 token 用量，不当正文
    if (obj.o === 'BATCH' || !/content/i.test(path)) {
      // BATCH 里如果带 token 用量，透传给上层（通过 attachments 机制）
      let usage = null;
      if (obj.o === 'BATCH' && Array.isArray(obj.v)) {
        for (const item of obj.v) {
          if (item?.p === 'accumulated_token_usage' && Number.isFinite(item.v)) {
            usage = { completion_tokens: item.v };
          }
        }
      }
      return { text: '', reasoning: '', done: false, usage };
    }

    // 正文增量：path 指向 fragments 的 content
    const isReasoning = REASONING_HINTS.some((h) => path.toLowerCase().includes(h));
    const piece = typeof obj.v === 'string' ? obj.v : '';
    if (!piece) return { text: '', reasoning: '', done: false };
    return isReasoning
      ? { text: '', reasoning: piece, done: false }
      : { text: piece, reasoning: '', done: false };
  }

  // ---------- 兼容形态：直给（type/content） ----------
  // 非正文事件整帧忽略（title 帧形如 {"content":"回应问候"}，没有 type 字段，
  // 因此必须按「无事件名的孤立 content 帧」处理 —— 真实流中裸 content 只出现在
  // title 事件里；正文一律走 JSON-Patch（p/o/v）形态，不会裸给）。
  if (NON_CONTENT_EVENTS.has(evName)) return { text: '', reasoning: '', done: false };
  // 无事件名且无 p 字段的帧（如 title 的 {"content":"..."}）→ 忽略，
  // 避免 title/提示语混入回答。真实正文一定带 p/o。
  if (!evName && typeof obj.p !== 'string') {
    return { text: '', reasoning: '', done: false };
  }
  if (evName && !CONTENT_EVENTS.has(evName)) return { text: '', reasoning: '', done: false };

  // 兼容的直给形态（历史猜测，实测未出现，保留以防上游变更）
  let text = '';
  let reasoning = '';
  if (typeof obj.content === 'string') {
    if (obj.type === 'thinking' || obj.type === 'reasoning') reasoning += obj.content;
    else text += obj.content;
  }
  if (typeof obj.v === 'string') text += obj.v;
  if (typeof obj.text === 'string') text += obj.text;

  return { text, reasoning, done: false };
}
