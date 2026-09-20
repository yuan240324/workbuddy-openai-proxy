// 终极验证：像 Trae 一样，通过真实代理服务（HTTP）请求真实 DeepSeek 上游。
// 这是目标里"接入 Trae"的最终一环。
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const BASE = `http://127.0.0.1:${cfg.port}`;
const KEY = cfg.apiKey;
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};

console.log('=== 1. /v1/models 列出 deepseek ===');
{
  const r = await fetch(`${BASE}/v1/models`, { headers: H });
  const j = await r.json();
  const ids = (j.data || []).map((m) => m.id).filter((id) => id.startsWith('deepseek'));
  check(`HTTP 200，deepseek 模型 ${ids.length} 个`, r.status === 200 && ids.length >= 3, `actual=${ids.join(',')}`);
  console.log(`      ${ids.join(', ')}`);
}

console.log('\n=== 2. OpenAI 非流式（真实上游）===');
{
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: '只回复四个字：你好世界' }],
      stream: false,
    }),
  });
  const j = await r.json();
  const dt = Date.now() - t0;
  console.log(`  HTTP ${r.status}（${dt}ms）`);
  console.log(`  回复: "${j.choices?.[0]?.message?.content}"`);
  console.log(`  usage: ${JSON.stringify(j.usage)}`);
  check('HTTP 200', r.status === 200, JSON.stringify(j).slice(0, 200));
  check('finish_reason=stop', j.choices?.[0]?.finish_reason === 'stop');
  check('有内容', (j.choices?.[0]?.message?.content || '').length > 0);
  check('无脏数据', !(j.choices?.[0]?.message?.content || '').includes('FINISHED'));
}

console.log('\n=== 3. OpenAI 流式（真实上游）===');
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
      stream: true,
    }),
  });
  check('content-type 是 SSE', (r.headers.get('content-type') || '').includes('text/event-stream'));
  const text = await r.text();
  const chunks = text.split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
    .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
  console.log(`  流式拼接: "${content.slice(0, 100)}${content.length > 100 ? '…' : ''}"`);
  check('流以 [DONE] 结束', text.trim().endsWith('[DONE]'));
  check('有内容', content.length > 0);
  check('无脏数据', !content.includes('FINISHED') && !content.includes('WIP'));
}

console.log('\n=== 4. Anthropic 非流式（真实上游）===');
{
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat',
      max_tokens: 500,
      messages: [{ role: 'user', content: '回复两个字：收到' }],
    }),
  });
  const j = await r.json();
  console.log(`  HTTP ${r.status}  回复: "${j.content?.[0]?.text}"`);
  check('HTTP 200', r.status === 200, JSON.stringify(j).slice(0, 200));
  check('type=message', j.type === 'message');
  check('stop_reason=end_turn', j.stop_reason === 'end_turn');
  check('有内容', (j.content?.[0]?.text || '').length > 0);
}

console.log('\n=== 5. reasoner 模型（深度思考，真实上游）===');
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'deepseek/deepseek-reasoner',
      messages: [{ role: 'user', content: '1+1=?直接给答案' }],
      stream: false,
    }),
  });
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || '';
  const reasoning = j.choices?.[0]?.message?.reasoning_content || '';
  console.log(`  HTTP ${r.status}`);
  console.log(`  正文: "${content.slice(0, 80)}"`);
  console.log(`  思考: ${reasoning ? `"${reasoning.slice(0, 60)}…"` : '(无)'}`);
  check('HTTP 200', r.status === 200, JSON.stringify(j).slice(0, 200));
  check('有正文', content.length > 0);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
