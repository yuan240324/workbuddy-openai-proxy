// HTTP 小工具：请求体读取、响应写出（含背压）、SSE 帧写出。
export const MAX_BODY = 16 * 1024 * 1024;

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求体过大（上限 16MB）'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, status, message, type = 'upstream_error') {
  sendJson(res, status, { error: { message, type, code: status } });
}

/** 带背压的写出：客户端读得慢时等待 drain，避免内存堆积。 */
export function writeAsync(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ok = res.write(chunk);
    if (ok) resolve(true);
    else res.once('drain', () => resolve(true));
  });
}

export function startSSE(res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extraHeaders,
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function writeSSE(res, payload) {
  return writeAsync(res, `data: ${payload}\n\n`);
}

export function writeSSEEvent(res, event, payload) {
  return writeAsync(res, `event: ${event}\ndata: ${payload}\n\n`);
}

export function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：中英混排按 3 字符 ≈ 1 token
  return Math.max(1, Math.ceil(String(text).length / 3));
}
