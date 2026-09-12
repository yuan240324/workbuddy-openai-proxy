// 极简日志：统一时间戳，并在内存里保留最近 N 条，供控制台实时查看。
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const BUFFER_MAX = 500;
const buffer = []; // { seq, time, level, text }

function push(level, text) {
  buffer.push({ seq: buffer.length ? buffer[buffer.length - 1].seq + 1 : 1, time: ts(), level, text });
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
}

function fmt(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export function log(...args) {
  const text = fmt(args);
  console.log(`[${ts()}]`, ...args);
  push('info', text);
}

export function warn(...args) {
  const text = fmt(args);
  console.warn(`[${ts()}] WARN`, ...args);
  push('warn', text);
}

export function error(...args) {
  const text = fmt(args);
  console.error(`[${ts()}] ERROR`, ...args);
  push('error', text);
}

// 单行请求日志：模型 / 模式 / 状态 / 耗时 / 首字节
export function requestLog(fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  const text = parts.join(' ');
  console.log(`[${ts()}] ${text}`);
  push(fields.status && fields.status >= 400 ? 'warn' : 'req', text);
}

/** 取最近的日志（seq 之后的），供 /console/logs 长轮询。 */
export function recentLogs(afterSeq = 0) {
  const list = buffer.filter((l) => l.seq > afterSeq);
  return { lastSeq: buffer.length ? buffer[buffer.length - 1].seq : 0, list };
}
