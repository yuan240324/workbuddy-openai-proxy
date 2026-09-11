// 上游（CodeBuddy / copilot.tencent.com）客户端：
//   - 请求体改写（上游只接受流式；tool_choice 只接受字符串）
//   - SSE 读取（带首字节/空闲超时，客户端断开即中止）
//   - 模型清单、额度查询
import crypto from 'node:crypto';
import { getAuth, ensureToken } from './auth.mjs';
import { chatHeaders, billingHeaders } from './headers.mjs';
import { warn } from './log.mjs';

/** 上游请求体改写：强制流式 + 角色/工具选择归一 + 剔除配置中要求剔除的字段。 */
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
  }

  // tool_choice：上游是字符串字段，对象形式会 400
  normalizeToolChoice(body);

  for (const key of cfg.stripFields || []) delete body[key];
  return body;
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
  constructor(message, { status = 502, code = null, transport = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.transport = transport;
  }
}

/**
 * 发起一次上游聊天请求。
 * 返回：{ ok:true, status, frames:AsyncGenerator<string>, close(), payload } 或
 *      { ok:false, status, text }
 */
export async function openChat(cfg, body, { signal } = {}) {
  const auth = getAuth();
  await ensureToken(cfg);
  const payload = prepareBody(cfg, body);

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

  let res;
  try {
    res = await fetch(cfg.upstream.apiBase + '/v2/chat/completions', {
      method: 'POST',
      headers: chatHeaders(cfg, auth),
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(headerTimer);
    cleanup();
    throw new UpstreamError(`上游连接失败：${e?.message || e}`, { status: 504, transport: true });
  }
  clearTimeout(headerTimer);

  if (res.status >= 400) {
    const text = await res.text().catch(() => '');
    cleanup();
    return { ok: false, status: res.status, text, payload };
  }

  bumpIdle();
  return {
    ok: true,
    status: res.status,
    payload,
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
    // 结尾可能残留最后一行（无换行）
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

/** 拉取账号可用模型清单（动态接口，失败返回 null 由调用方兜底）。 */
export async function fetchModels(cfg) {
  const auth = getAuth();
  await ensureToken(cfg);
  const res = await fetch(cfg.upstream.apiBase + '/console/enterprises/personal/models', {
    headers: { ...chatHeaders(cfg, auth), Accept: 'application/json' },
  });
  const text = await res.text();
  if (res.status !== 200) throw new UpstreamError(`模型接口 HTTP ${res.status}：${text.slice(0, 200)}`, { status: res.status });
  const json = JSON.parse(text);
  if (json.code !== 0) throw new UpstreamError(`模型接口 code=${json.code}：${String(json.msg || '').slice(0, 200)}`, { status: 502 });
  const models = json.data?.models || [];
  const agents = json.data?.agents || [];
  const cli = agents.find((a) => a.name === 'cli');
  const cliIds = cli?.models?.length ? new Set(cli.models) : null;
  return models
    .filter((m) => !m.disabled && (!cliIds || cliIds.has(m.id)))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.maxInputTokens || null,
      maxTokens: m.maxOutputTokens || null,
    }));
}

/** 查询剩余积分（免费额度）。 */
export async function queryCredit(cfg) {
  const auth = getAuth();
  await ensureToken(cfg);
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
  const res = await fetch(cfg.upstream.billingBase + '/v2/billing/meter/get-user-resource', {
    method: 'POST',
    headers: billingHeaders(cfg, auth),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError(`额度接口返回无法解析（HTTP ${res.status}）`, { status: 502 });
  }
  if (json.code !== 0) throw new UpstreamError(`额度接口 code=${json.code}：${String(json.msg || '').slice(0, 160)}`, { status: 502 });
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

export function upstreamErrorMessage(status, text) {
  let msg = text || '';
  try {
    const j = JSON.parse(text);
    msg = j.msg || j.error?.message || j.message || text;
  } catch {
    /* 原始文本即可 */
  }
  const map = {
    401: '上游 401：登录态失效，请重新运行 node login.mjs 登录',
    402: '上游 402：额度/积分不足',
    404: '上游 404：接口偶发不可用，稍后重试',
    429: '上游 429：触发限流，稍后重试',
  };
  const prefix = map[status] || `上游 HTTP ${status}`;
  warn(`上游返回 ${status}：${String(msg).slice(0, 200)}`);
  return `${prefix}：${String(msg).slice(0, 500)}`;
}

export function newId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}
