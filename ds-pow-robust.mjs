// PoW 求解器测试（Round 11 修正版 —— 原像搜索模型）。
//
// 已破解的真实算法：
//   challenge = dsHash(`${salt}_${expire_at}_${secret_n}`)   // 服务端签发
//   answer    = 枚举 n，找 dsHash(prefix + n) === challenge   // 客户端求解
//   difficulty = 搜索上限
//
// 验证锚点：真实抓包样本 answer=27720，纯 JS 枚举 92ms 复现。
import crypto from 'node:crypto';
import { solvePow, dsHash, loadWasm } from './src/deepseek-pow.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};

const REAL = {
  algorithm: 'DeepSeekHashV1',
  challenge: '2710c2f9d32645e18a18c2d6ae2a2e8eed1d079ad5a773861b8c8913be87b722',
  salt: 'ccd2d20978f6b8697919',
  signature: 'c0ac58cab9eeaf914f53bba9033f23657706c34d494346eadf955153220cd8c8',
  difficulty: 144000,
  expire_at: 1789247493602,
  answer: 27720,
};

console.log('=== 1. dsHash 基本性质 ===');
{
  const h1 = dsHash('a');
  const h2 = dsHash('a');
  const h3 = dsHash('b');
  check('输出为 64 字符 hex', /^[0-9a-f]{64}$/.test(h1));
  check('确定性（同输入同输出）', h1 === h2);
  check('不同输入不同输出', h1 !== h3);
  check('非标准 sha3-256', h1 !== crypto.createHash('sha3-256').update('a').digest('hex'));
  check('雪崩效应（单字符差异导致哈希完全不同）', dsHash('a') !== dsHash('A'));
}

console.log('\n=== 2. 原像模型验证（用真实样本）===');
{
  const prefix = `${REAL.salt}_${REAL.expire_at}_`;
  const h = dsHash(prefix + REAL.answer);
  check('dsHash(prefix + answer) === challenge', h === REAL.challenge);
  // 对照：相邻 n 不等于 challenge
  check('n=answer-1 的哈希 ≠ challenge', dsHash(prefix + (REAL.answer - 1)) !== REAL.challenge);
  check('n=answer+1 的哈希 ≠ challenge', dsHash(prefix + (REAL.answer + 1)) !== REAL.challenge);
}

console.log('\n=== 3. solvePow 端到端（真实样本）===');
{
  const t0 = Date.now();
  const ans = solvePow(REAL);
  const dt = Date.now() - t0;
  check(`answer === 27720（实际 ${ans}）`, ans === REAL.answer);
  check(`耗时 < 2000ms（实际 ${dt}ms）`, dt < 2000);
  console.log(`      耗时 ${dt}ms`);
}

console.log('\n=== 4. 通用性：随机自造 challenge 应能求解（核心！）===');
{
  // 模拟服务端：随机选 n，算 challenge
  let ok = 0;
  const N = 5;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const secretN = crypto.randomInt(0, 144000);
    const salt = crypto.randomBytes(10).toString('hex');
    const expireAt = Date.now();
    const prefix = `${salt}_${expireAt}_`;
    const challenge = dsHash(prefix + secretN);
    const ans = solvePow({
      algorithm: 'DeepSeekHashV1',
      challenge,
      salt,
      signature: crypto.randomBytes(32).toString('hex'),
      difficulty: 144000,
      expire_at: expireAt,
    });
    if (ans === secretN) ok++;
  }
  const dt = Date.now() - t0;
  check(`自造挑战 ${N}/${N} 求解成功`, ok === N, `仅 ${ok}/${N}`);
  console.log(`      ${N} 个随机挑战总耗时 ${dt}ms（平均 ${(dt / N).toFixed(0)}ms）`);
}

console.log('\n=== 5. difficulty 作为搜索上限 ===');
{
  // 用一个 n=200000 的挑战（超过 144000），应搜不到
  const salt = crypto.randomBytes(10).toString('hex');
  const expireAt = Date.now();
  const prefix = `${salt}_${expireAt}_`;
  const outOfRange = dsHash(prefix + 200000);
  let threw = false;
  try {
    solvePow({
      algorithm: 'DeepSeekHashV1', challenge: outOfRange, salt,
      signature: 'x'.repeat(64), difficulty: 144000, expire_at: expireAt,
    });
  } catch { threw = true; }
  check('超出 difficulty 范围的解 → 报错（符合上限语义）', threw);
}

console.log('\n=== 6. 接口健壮性 ===');
{
  let threw = false;
  try { solvePow({ ...REAL, algorithm: 'SHA256' }); } catch { threw = true; }
  check('未知算法抛错', threw);

  threw = false;
  try { solvePow({ algorithm: 'DeepSeekHashV1' }); } catch { threw = true; }
  check('缺字段抛错', threw);
}

console.log('\n=== 7. buildPowHeader 输出格式 ===');
{
  const { buildPowHeader } = await import('./src/deepseek-pow.mjs');
  const header = buildPowHeader(REAL, 27720, '/api/v0/chat/completion');
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  check('answer 是数字', decoded.answer === 27720 && typeof decoded.answer === 'number');
  check('含全部 6 字段', ['algorithm', 'challenge', 'salt', 'answer', 'signature', 'target_path'].every((k) => k in decoded));
  check('target_path 正确', decoded.target_path === '/api/v0/chat/completion');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
