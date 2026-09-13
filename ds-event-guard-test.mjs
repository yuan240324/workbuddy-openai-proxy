// 风险验证：非 delta 事件里若含文本字段，会不会被误当正文输出？
// 场景：updateParentMessage 可能带回上一条消息的完整正文（官方结构如此），
//       若被 extractDelta 收下，回复里就会出现重复/脏内容。
import { extractDelta } from './src/deepseek.mjs';

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n      实际: ${a}\n      期望: ${e}`); }
};

console.log('=== 危险场景：非 delta 事件携带文本 ===');

// updateParentMessage 很可能会带回消息对象（含 content）
eq('updateParentMessage 不应产出正文',
  extractDelta({
    type: 'updateParentMessage',
    message: { id: 'm1', role: 'ASSISTANT', content: '这是之前的完整回复', status: 'FINISHED' },
  }), { text: '', reasoning: '', done: false });

// updateSession 带回会话标题
eq('updateSession 不应产出正文',
  extractDelta({
    type: 'updateSession',
    session: { id: 's1', title: '关于天气的对话', pinned: false },
  }), { text: '', reasoning: '', done: false });

// title 事件
eq('title 事件不应产出正文',
  extractDelta({ type: 'title', title: '新对话' }), { text: '', reasoning: '', done: false });

// toast 事件带文案
eq('toast 事件不应产出正文',
  extractDelta({ type: 'toast', content: '操作过于频繁' }), { text: '', reasoning: '', done: false });

// hint 事件
eq('hint 事件不应产出正文',
  extractDelta({ type: 'hint', content: '请稍后重试', hint_type: 'warning' }), { text: '', reasoning: '', done: false });

// ready 事件
eq('ready 事件不应产出正文',
  extractDelta({ type: 'ready', content: 'ok' }), { text: '', reasoning: '', done: false });

// updateFile
eq('updateFile 不应产出正文',
  extractDelta({ type: 'updateFile', file: { name: 'a.txt', content: '文件内容' } }),
  { text: '', reasoning: '', done: false });

console.log('\n=== delta 事件应当产出正文 ===');
eq('delta 直给形态',
  extractDelta({ type: 'delta', content: '你好' }), { text: '你好', reasoning: '', done: false });
eq('delta 路径形态（真实 JSON-Patch）',
  extractDelta({ p: 'response/fragments/-1/content', o: 'APPEND', v: '你好' }), { text: '你好', reasoning: '', done: false });
eq('快照 fragments 形态',
  extractDelta({ v: { response: { fragments: [{ type: 'RESPONSE', content: '裸内容' }] } } }), { text: '裸内容', reasoning: '', done: false });
// 裸 content 帧在真实流中只属于 title 事件，必须忽略（Round 11 抓包确认）
eq('裸 content 不当正文（title 专用）',
  extractDelta({ content: '裸内容' }), { text: '', reasoning: '', done: false });

console.log('\n=== 终止事件 ===');
eq('close', extractDelta({ type: 'close' }), { text: '', reasoning: '', done: true });
eq('finish', extractDelta({ type: 'finish' }), { text: '', reasoning: '', done: true });

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
