// 测试 deepseek-adapter 的帧翻译与错误处理。
import { translateFrames, deepseekModels, isDeepSeek } from './src/deepseek-adapter.mjs';
import { normalizeChunk } from './src/openai.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

/** 把数组包成 AsyncGenerator，模拟上游帧流。 */
async function* fakeFrames(list) {
  for (const x of list) yield typeof x === 'string' ? x : JSON.stringify(x);
}
/** 消费翻译后的帧。 */
async function collect(gen) {
  const out = [];
  for await (const f of gen) out.push(JSON.parse(f));
  return out;
}

console.log('=== 1. 基本文本流（真实 JSON-Patch 形态）===');
{
  const src = [
    { v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: '你好' }] } } },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '，世界' },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  ];
  const out = await collect(translateFrames(fakeFrames(src), 'deepseek-chat'));
  const text = out.map((c) => c.choices[0].delta.content || '').join('');
  check('拼接文本正确', text === '你好，世界', `实际="${text}"`);
  check('首帧带 role', out[0].choices[0].delta.role === 'assistant');
  check('末帧 finish_reason=stop', out.at(-1).choices[0].finish_reason === 'stop');
  check('每条都有 id', out.every((c) => typeof c.id === 'string' && c.id.startsWith('chatcmpl-')));
  check('object 正确', out.every((c) => c.object === 'chat.completion.chunk'));
  check('model 透传', out.every((c) => c.model === 'deepseek-chat'));
}

console.log('\n=== 2. 思考内容 → reasoning_content ===');
{
  const src = [
    { p: 'response/thinking_content', o: 'APPEND', v: '让我想想' },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '答案是 2' },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  ];
  const out = await collect(translateFrames(fakeFrames(src), 'deepseek-reasoner'));
  const reasoning = out.map((c) => c.choices[0].delta.reasoning_content || '').join('');
  const text = out.map((c) => c.choices[0].delta.content || '').join('');
  check('reasoning 单独成帧', reasoning === '让我想想', `实际="${reasoning}"`);
  check('正文正确', text === '答案是 2', `实际="${text}"`);
}

console.log('\n=== 3. 多段 APPEND 累加 ===');
{
  const src = [
    { p: 'response/fragments/-1/content', o: 'APPEND', v: 'AAA' },
    { v: { response: { fragments: [{ type: 'RESPONSE', content: 'BBB' }] } } },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: 'CCC' },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  ];
  const out = await collect(translateFrames(fakeFrames(src), 'm'));
  const text = out.map((c) => c.choices[0].delta.content || '').join('');
  check('APPEND+快照+APPEND 累加', text === 'AAABBBCCC', `实际="${text}"`);
}

console.log('\n=== 4. 异常帧容错 ===');
{
  const src = ['not json at all', { p: 'response/fragments/-1/content', o: 'APPEND', v: 'X' }, '{"broken":', { p: 'response/status', o: 'SET', v: 'FINISHED' }];
  const out = await collect(translateFrames(fakeFrames(src), 'm'));
  const text = out.map((c) => c.choices[0].delta.content || '').join('');
  check('坏帧被跳过且不中断', text === 'X', `实际="${text}"`);
}

console.log('\n=== 5. 空流仍产出合法收尾帧 ===');
{
  const out = await collect(translateFrames(fakeFrames([]), 'm'));
  check('空流产出 1 帧', out.length === 1, `实际=${out.length}`);
  check('该帧 finish_reason=stop', out[0].choices[0].finish_reason === 'stop');
}

console.log('\n=== 6. 与 openai.mjs 的 normalizeChunk 兼容 ===');
{
  const src = [
    { p: 'response/fragments/-1/content', o: 'APPEND', v: 'hi' },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  ];
  const out = await collect(translateFrames(fakeFrames(src), 'deepseek-chat'));
  let okAll = true;
  for (const c of out) {
    const n = normalizeChunk(c, 'public-model');
    if (!n.choices || !Array.isArray(n.choices)) { okAll = false; break; }
  }
  check('normalizeChunk 能处理每一帧', okAll);
  const first = normalizeChunk(out[0], 'public-model');
  check('normalizeChunk 保留文本', first.choices[0].delta.content === 'hi');
  check('normalizeChunk 改写 model', first.model === 'public-model');
}

console.log('\n=== 7. 模型清单与协议判断 ===');
{
  const cfg = { sites: { deepseek: { seedModels: [{ id: 'deepseek-chat', name: 'A' }, { id: 'deepseek-reasoner', name: 'B' }] } } };
  const models = deepseekModels(cfg, 'deepseek');
  check('返回 2 个模型', models.length === 2);
  check('reasoner 标记支持推理', models[1].supportsReasoning === true);
  check('chat 不标记推理', models[0].supportsReasoning === false);
  check('isDeepSeek 正确', isDeepSeek('deepseek') === true && isDeepSeek('codebuddy') === false);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
