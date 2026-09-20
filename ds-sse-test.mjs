// 用「贴近真实」的 SSE 序列测试 readDeepSeekSSE + extractDelta 的配合。
// 事件序列取自用户 HAR 中的 _eventSourceMessages：
//   ready → update_session → message × N → title → close
// （注：HAR 记的是浏览器的 event 名；bundle 枚举里正文事件为 delta）
import { readDeepSeekSSE, extractDelta, SS_EVENTS } from './src/deepseek.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

/** 把字符串喂成 ReadableStream。 */
function streamOf(text, chunkSize = 0) {
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      if (!chunkSize) {
        c.enqueue(enc.encode(text));
        c.close();
        return;
      }
      // 按字节切分，模拟网络分片
      const bytes = enc.encode(text);
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
}

/** 消费流并汇总正文。 */
async function drain(text, chunkSize = 0) {
  const payloads = [];
  let body = '', reasoning = '', done = false;
  for await (const p of readDeepSeekSSE(streamOf(text, chunkSize))) {
    payloads.push(p);
    let obj;
    try { obj = JSON.parse(p); } catch { continue; }
    const r = extractDelta(obj);
    body += r.text;
    reasoning += r.reasoning;
    if (r.done) { done = true; break; }
  }
  return { payloads, body, reasoning, done };
}

// 真实事件序列（Round 11 抓包：event 行 + JSON-Patch 载荷）
const REAL_SSE = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1789247192.5}',
  '',
  'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"你"}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"好"}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"啊"}',
  '',
  'event: title',
  'data: {"content":"问候"}',
  '',
  'event: close',
  'data: {"click_behavior":"none"}',
  '',
].join('\n');

console.log('=== 1. 完整真实序列 ===');
{
  const r = await drain(REAL_SSE);
  check('正文拼接正确', r.body === '你好啊', `实际="${r.body}"`);
  check('检测到终止', r.done === true);
  check('标题未混入正文', !r.body.includes('问候'));
  check('事件数（ready/updateSession/3×delta/title/close = 7）', r.payloads.length === 7, `实际=${r.payloads.length}`);
}

console.log('\n=== 2. 网络分片鲁棒性（每 7 字节一片）===');
{
  const r = await drain(REAL_SSE, 7);
  check('分片后正文仍正确', r.body === '你好啊', `实际="${r.body}"`);
  check('分片后仍能终止', r.done === true);
}

console.log('\n=== 3. 仅有 event 行、无 data 的终止帧 ===');
{
  const sse = [
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"X"}',
    '',
    'event: close',
    '',
  ].join('\n');
  const r = await drain(sse);
  check('正文正确', r.body === 'X', `实际="${r.body}"`);
  check('无 data 的 close 也能终止', r.done === true);
}

console.log('\n=== 4. 载荷缺 type 时由 event 行补齐 ===');
{
  const sse = [
    'event: close',
    'data: {}',
    '',
  ].join('\n');
  const r = await drain(sse);
  check('event 名注入成功并终止', r.done === true);
}

console.log('\n=== 5. 思考内容走 reasoning（真实 JSON-Patch 形态）===');
{
  const sse = [
    'data: {"p":"response/thinking_content","o":"APPEND","v":"推理中"}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"答案"}',
    '',
    'event: close',
    'data: {"click_behavior":"none"}',
    '',
  ].join('\n');
  const r = await drain(sse);
  check('reasoning 正确', r.reasoning === '推理中', `实际="${r.reasoning}"`);
  check('正文正确', r.body === '答案', `实际="${r.body}"`);
}

console.log('\n=== 6. 异常流不崩溃 ===');
{
  const bad = ['data: {broken json', '', 'event: close', 'data: {"click_behavior":"none"}', ''].join('\n');
  let ok = true, body = '', done = false;
  try {
    for await (const p of readDeepSeekSSE(streamOf(bad))) {
      let o; try { o = JSON.parse(p); } catch { continue; }
      const r = extractDelta(o); body += r.text; if (r.done) { done = true; break; }
    }
  } catch { ok = false; }
  check('坏 JSON 不中断', ok);
  check('仍能正常终止', done);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
