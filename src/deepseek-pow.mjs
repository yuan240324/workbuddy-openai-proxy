// DeepSeek 官方站点（chat.deepseek.com）PoW 求解器。
//
// ═══════════════════════════════════════════════════════════════
// DeepSeekHashV1 算法（已完全破解，Round 11 三重验证）：
//
//   1. dsHash(input) —— 64 字符 hex 摘要，由官方 wasm 的
//      wasm_deepseek_hash_v1 实现（非标准 SHA3-256，输出不同）
//
//   2. 服务端签发：随机选 n ∈ [0, difficulty)，
//      challenge = dsHash(`${salt}_${expire_at}_${n}`)
//
//   3. 客户端求解（原像搜索）：枚举 n，找
//      dsHash(`${salt}_${expire_at}_${n}`) === challenge
//      的最小 n，即为 answer
//
//   difficulty 是搜索上限（保证解一定存在且最多尝试 difficulty 次）
// ═══════════════════════════════════════════════════════════════
//
// 验证证据（真实抓包样本）：
//   salt=ccd2d20978f6b8697919, expire_at=1789247493602, difficulty=144000
//   → 枚举求得 n=27720，dsHash(prefix+27720) === challenge 逐字符相等
//   → 92ms 完成搜索，最坏情况约 0.5s
import fs from 'node:fs';
import path from 'node:path';

/** wasm 实例缓存（dsHash 用）。 */
let wasm = null;
let loadError = null;

/** 加载官方 wasm（仅用于 dsHash）。 */
export function loadWasm(wasmPath) {
  if (wasm) return wasm;
  if (loadError) throw loadError;
  const file = wasmPath || path.join(import.meta.dirname, '..', '_ds-pow', 'sha3_wasm_bg.wasm');
  try {
    const bytes = fs.readFileSync(file);
    const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
    for (const need of ['memory', 'wasm_deepseek_hash_v1', '__wbindgen_export_0']) {
      if (!exports[need]) throw new Error(`wasm 缺少导出 ${need}`);
    }
    wasm = exports;
    return wasm;
  } catch (e) {
    loadError = new Error(`加载 PoW wasm 失败（${file}）：${e.message}`);
    throw loadError;
  }
}

const encoder = new TextEncoder();

/** 计算 DeepSeekHashV1，返回 64 字符 hex。 */
export function dsHash(input) {
  const ex = loadWasm();
  const src = encoder.encode(input);
  const srcPtr = ex.__wbindgen_export_0(src.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer).set(src, srcPtr);
  const dst = ex.__wbindgen_export_0(16, 1) >>> 0; // 接收 (outPtr, outLen)
  ex.wasm_deepseek_hash_v1(dst, srcPtr, src.length);
  const dv = new DataView(ex.memory.buffer);
  const outPtr = dv.getUint32(dst, true);
  const outLen = dv.getUint32(dst + 4, true);
  if (!outLen || outLen !== 64) throw new Error(`DeepSeekHashV1 输出异常：len=${outLen}`);
  return Buffer.from(new Uint8Array(ex.memory.buffer).slice(outPtr, outPtr + outLen)).toString('utf8');
}

/** 把 ASCII 字符串写入 wasm 内存（旧路径，保留给兼容探测）。 */
function passString(ex, str) {
  const n = str.length;
  const ptr = ex.__wbindgen_export_0(n, 1) >>> 0;
  const mem = new Uint8Array(ex.memory.buffer);
  for (let i = 0; i < n; i++) {
    const c = str.charCodeAt(i);
    if (c > 127) throw new Error('PoW 参数必须是 ASCII');
    mem[ptr + i] = c;
  }
  return { ptr, len: n };
}

/**
 * 求解一次 PoW 挑战（原像搜索）。
 * @param {object} challenge create_pow_challenge 返回的 challenge 对象
 * @returns {number} answer
 */
export function solvePow(challenge) {
  const { algorithm, challenge: ch, salt, difficulty, expire_at: expireAt } = challenge;

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`不支持的 PoW 算法：${algorithm}`);
  }

  const prefix = `${salt}_${expireAt}_`;
  const target = ch;

  // 原像搜索：找最小的 n 使 dsHash(prefix + n) === challenge
  for (let n = 0; n < difficulty; n++) {
    if (dsHash(prefix + n) === target) return n;
  }
  throw new Error(`PoW 求解失败：在 [0, ${difficulty}) 内未找到原像`);
}

/**
 * 构造 X-DS-PoW-Response 头的值。
 * @returns {string} base64(JSON)，字段顺序与官方 worker 一致
 */
export function buildPowHeader(challenge, answer, targetPath) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** 一步到位：求解并返回可直接放进请求头的 base64 字符串。 */
export function solvePowHeader(challenge, targetPath) {
  return buildPowHeader(challenge, solvePow(challenge), targetPath);
}
