// 用真实抓包帧（_ds-pow/last-sse.json）校准 extractDelta 与帧翻译。
// 真实协议：快照（fragments 初始正文）+ JSON-Patch 增量（APPEND）。
// 完整回复 = 快照正文 + 增量正文。
import fs from 'node:fs';
import { extractDelta } from './src/deepseek.mjs';
import { translateFrames } from './src/deepseek-adapter.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};

const events = JSON.parse(fs.readFileSync('_ds-pow/last-sse.json', 'utf8'));
const FULL = '\u4f60\u597d\u554a'; // 你好啊

console.log('=== 1. 逐帧解析真实事件（快照+增量语义）===');
let body = '';
let usage = null;
let done = false;
for (const e of events) {
  if (typeof e === 'string') continue; // "[event] xxx" 标记行
  const r = extractDelta(e);
  body += r.text;
  if (r.usage) usage = r.usage;
  if (r.done) done = true;
}
console.log(`  完整正文: "${body}"`);
check(`正文 = "${FULL}"（快照"你好"+增量"啊"）`, body === FULL, `actual="${body}"`);
check('无脏数据（无 FINISHED/标题混入）', !body.includes('FINISHED') && !body.includes('\u56de\u5e94\u95ee\u5019'));
check('检测到结束', done === true);
check('提取到 token 用量', usage?.completion_tokens === 40, `actual=${JSON.stringify(usage)}`);

console.log('\n=== 2. 帧翻译（真实帧 → OpenAI chunk）===');
{
  async function* gen() {
    for (const e of events) {
      if (typeof e === 'string') continue;
      yield JSON.stringify(e);
    }
  }
  const out = [];
  for await (const f of translateFrames(gen(), 'deepseek-chat')) out.push(JSON.parse(f));
  const text = out.map((c) => c.choices?.[0]?.delta?.content || '').join('');
  console.log(`  流式输出: "${text}"`);
  check('流式输出 = 完整正文', text === FULL, `actual="${text}"`);
  check('不含脏数据', !text.includes('FINISHED'));
  check('首帧带 role', out[0]?.choices?.[0]?.delta?.role === 'assistant');
  check('最后帧 finish_reason=stop', out.at(-1).choices?.[0]?.finish_reason === 'stop');
  check('每帧都是合法 chunk 形状', out.every((c) => c.object === 'chat.completion.chunk'));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
