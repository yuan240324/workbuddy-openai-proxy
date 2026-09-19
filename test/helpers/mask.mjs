// 测试辅助函数（供多个测试文件复用）

/** 与控制台 /state 相同的密钥掩码逻辑，用于断言不泄露完整密钥。 */
export function maskKeyIfNeeded(k) {
  if (!k) return '';
  return k.length <= 10 ? '***' : `${k.slice(0, 6)}…${k.slice(-4)}`;
}
