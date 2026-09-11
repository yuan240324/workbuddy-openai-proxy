// 极简日志：统一时间戳，便于在控制台/日志文件里对齐排查。
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${ts()}] WARN`, ...args);
}

export function error(...args) {
  console.error(`[${ts()}] ERROR`, ...args);
}

// 单行请求日志：模型 / 模式 / 状态 / 耗时 / 首字节
export function requestLog(fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[${ts()}] ${parts.join(' ')}`);
}
