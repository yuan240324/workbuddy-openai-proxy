// 无需 token 的模块自检：导入、头构造、SSE 解析、增量提取。
import { baseHeaders, extractDelta, DS_API } from './src/deepseek.mjs';
import { loadWasm, solvePow } from './src/deepseek-pow.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('=== 1. 模块导入 ===');
check('deepseek.mjs 可导入', typeof baseHeaders === 'function');
check('deepseek-pow.mjs 可导入', typeof solvePow === 'function');

console.log('\n=== 2. wasm 加载 ===');
const ex = loadWasm();
check('wasm 有 wasm_solve', typeof ex.wasm_solve === 'function');
check('wasm 有 memory', ex.memory instanceof WebAssembly.Memory);

console.log('\n=== 3. 请求头构造（对齐抓包）===');
const h = baseHeaders('TEST_TOKEN');
const expectHeaders = {
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-locale': 'zh_CN',
  'x-client-platform': 'web',
  'x-client-timezone-offset': '28800',
  'x-client-version': '2.5.0',
};
for (const [k, v] of Object.entries(expectHeaders)) {
  check(`${k} = ${v}`, h[k] === v, `实际=${h[k]}`);
}
check('Origin 正确', h.Origin === DS_API);
check('Authorization 带 Bearer', h.Authorization === 'Bearer TEST_TOKEN');
check('含 User-Agent', typeof h['User-Agent'] === 'string' && h['User-Agent'].includes('Chrome'));

console.log('\n=== 4. SSE 解析 ===');
// 模拟 DeepSeek 的真实 SSE 流（Round 11 抓包确认：快照 + JSON-Patch 增量）
const sseText = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1789256736.73}',
  '',
  'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"你"}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"好"}',
  '',
  'event: title',
  'data: {"content":"问候"}',
  '',
  'event: close',
  'data: {"click_behavior":"none"}',
  '',
].join('\n');

const { readDeepSeekSSE } = await import('./src/deepseek.mjs');
const stream = new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode(sseText));
    c.close();
  },
});
const payloads = [];
for await (const p of readDeepSeekSSE(stream)) payloads.push(p);
// ready / update_session / 快照 / APPEND / title / close = 6 个 data 帧
check(`解析出 ${payloads.length} 个载荷（期望 7）`, payloads.length === 7, `实际=${payloads.length}`);
check('第 1 个是 ready', JSON.parse(payloads[0]).model_type === 'default');

console.log('\n=== 5. 增量提取（真实帧形态）===');
check('APPEND 帧取正文', extractDelta({ p: 'response/fragments/-1/content', o: 'APPEND', v: 'abc' }).text === 'abc');
check('thinking 路径归入 reasoning', extractDelta({ p: 'response/thinking_content', o: 'APPEND', v: 'think' }).reasoning === 'think');
check('close 标记 done', extractDelta({ type: 'close' }).done === true);
check('快照 fragments 取初始正文', extractDelta({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'xyz' }] } } }).text === 'xyz');
check('空对象不崩', extractDelta({}).text === '');
check('null 不崩', extractDelta(null).text === '');
check('裸 content 帧（title）不混入正文', extractDelta({ content: '标题' }).text === '');
check('BATCH 帧透传 usage', extractDelta({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 40 }] }).usage?.completion_tokens === 40);

console.log('\n=== 6. PoW 端到端（用抓包样本）===');
const challenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: '2710c2f9d32645e18a18c2d6ae2a2e8eed1d079ad5a773861b8c8913be87b722',
  salt: 'ccd2d20978f6b8697919',
  difficulty: 144000,
  expire_at: 1789247493602,
  signature: 'c0ac58cab9eeaf914f53bba9033f23657706c34d494346eadf955153220cd8c8',
};
check('求解得 27720', solvePow(challenge) === 27720);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
