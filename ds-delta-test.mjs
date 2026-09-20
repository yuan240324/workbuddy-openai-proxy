// 穷举测试重写后的 extractDelta：覆盖官方可能的全部帧形态。
import { extractDelta, SS_EVENTS } from './src/deepseek.mjs';

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n      实际: ${a}\n      期望: ${e}`); }
};
const d = (t, r = '', done = false) => ({ text: t, reasoning: r, done });

console.log('=== 1. 形态 A：直给型 ===');
eq('text/content', extractDelta({ type: 'text', content: '你好' }), d('你好'));
eq('thinking/content → reasoning', extractDelta({ type: 'thinking', content: '想想' }), d('', '想想'));
eq('reasoning/content → reasoning', extractDelta({ type: 'reasoning', content: '想' }), d('', '想'));
eq('close 终止', extractDelta({ type: 'close' }), d('', '', true));
eq('finish 终止', extractDelta({ type: 'finish' }), d('', '', true));
eq('event:close 终止', extractDelta({ event: 'close' }), d('', '', true));
eq('ready 无内容', extractDelta({ type: 'ready' }), d(''));

console.log('\n=== 2. 形态 B：JSON-Patch（真实协议，Round 11 抓包确认）===');
// 真实正文帧：{"p":"response/fragments/-1/content","o":"APPEND","v":"啊"}
eq('APPEND 正文', extractDelta({ p: 'response/fragments/-1/content', o: 'APPEND', v: '你好' }), d('你好'));
eq('APPEND thinking → reasoning',
  extractDelta({ p: 'response/thinking_content', o: 'APPEND', v: '推理中' }), d('', '推理中'));
// 状态帧
eq('response/status SET FINISHED → done',
  extractDelta({ p: 'response/status', o: 'SET', v: 'FINISHED' }), d('', '', true));
// BATCH 元数据（含 token 用量）不当正文
{
  const r = extractDelta({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 40 }] });
  eq('BATCH 无正文', r.text, '');
  eq('BATCH 透传 usage', r.usage?.completion_tokens, 40);
}
// 快照帧：fragments 里的 content 是初始正文
eq('快照 fragments content',
  extractDelta({ v: { response: { fragments: [{ type: 'RESPONSE', content: '你' }, { type: 'RESPONSE', content: '好' }] } } }),
  d('你好'));
// 无 o 字段的 p 帧：非 content 路径不当正文
eq('非 content 路径忽略', extractDelta({ p: 'response/accumulated_token_usage', v: 40 }).text, '');

console.log('\n=== 3. 噪声字段不被混入正文 ===');
eq('跳过 id/status/type/role',
  extractDelta({ p: 'response/content', v: '正文', id: 'abc', status: 'WIP', role: 'ASSISTANT', message_id: 'm1' }),
  d('正文'));

console.log('\n=== 4. 其余事件不产出正文 ===');
// 非 delta 事件的字段不承载正文，必须一律忽略（否则标题/错误码会混进回复里）
eq('updateSession 无正文', extractDelta({ type: 'updateSession', updated_at: 123 }), d(''));
eq('title 的 title 字段不算正文', extractDelta({ type: 'title', title: '标题' }), d(''));
eq('toast 的 code 不算正文', extractDelta({ type: 'toast', code: 'x' }), d(''));
eq('hint 的文案不算正文（提示语必须忽略）', extractDelta({ type: 'hint', text: '提示' }), d(''));

console.log('\n=== 5. 异常输入容错 ===');
eq('null', extractDelta(null), d(''));
eq('undefined', extractDelta(undefined), d(''));
eq('字符串', extractDelta('plain'), d(''));
eq('数字', extractDelta(42), d(''));
eq('空对象', extractDelta({}), d(''));
eq('空数组 v', extractDelta({ p: 'x', v: [] }), d(''));
eq('空字符串 v', extractDelta({ p: 'x', v: '' }), d(''));

console.log('\n=== 6. 深递归保护（不栈溢出）===');
{
  let deep = { content: 'x' };
  for (let i = 0; i < 50; i++) deep = { nested: deep };
  let ok = true;
  try { extractDelta({ p: 'response/fragments', v: deep }); } catch { ok = false; }
  eq('50 层嵌套不崩', ok, true);
}

console.log('\n=== 7. 事件枚举导出正确 ===');
eq('DELTA 值', SS_EVENTS.DELTA, 'delta');
eq('CLOSE 值', SS_EVENTS.CLOSE, 'close');
eq('UPDATE_PARENT_MESSAGE 值', SS_EVENTS.UPDATE_PARENT_MESSAGE, 'updateParentMessage');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
