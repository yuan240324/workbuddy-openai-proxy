// 命令行提问客户端（用于快速验证代理是否正常）
//
//   node ask.mjs                              # 用默认模型问一句
//   node ask.mjs claude-sonnet-4.6            # 指定模型
//   node ask.mjs gpt-5.4 "用一句话介绍你自己"   # 指定模型 + 提示词
//   node ask.mjs intl-cli/glm-5.3 "你好"       # 用站点前缀强制走国际版
//   node ask.mjs --list                       # 列出所有可用模型
import { loadConfig, primaryKey } from './src/config.mjs';

const cfg = loadConfig();
const base = `http://${cfg.host}:${cfg.port}`;
const headers = { Authorization: 'Bearer ' + primaryKey(cfg), 'Content-Type': 'application/json' };
const args = process.argv.slice(2);

if (args[0] === '--list' || args[0] === '-l') {
  const res = await fetch(base + '/v1/models', { headers });
  if (!res.ok) {
    console.log(`服务返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const j = await res.json();
  const bySite = {};
  for (const m of j.data) (bySite[m.site || '-'] = bySite[m.site || '-'] || []).push(m);
  for (const [site, list] of Object.entries(bySite)) {
    console.log(`\n■ ${site}`);
    for (const m of list) {
      console.log(`  ${String(m.id).padEnd(34)} ${String(m.credits || '').padEnd(16)} ${m.name || ''}`);
    }
  }
  process.exit(0);
}

const model = args[0] || cfg.defaultModel;
const prompt = args[1] || '用一句话说明你现在是哪个模型，以及你能做什么。';

const res = await fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers,
  body: JSON.stringify({ model, stream: true, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
});

const site = res.headers.get('X-Upstream-Site') || '未知';
if (!res.ok) {
  const text = await res.text();
  console.log(`❌ HTTP ${res.status}（站点 ${site}）`);
  try {
    console.log('   ', JSON.parse(text).error?.message || text.slice(0, 300));
  } catch {
    console.log('   ', text.slice(0, 300));
  }
  process.exit(1);
}

console.log(`▶ 模型 ${model}  站点 ${site}\n`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let reasoning = 0;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const d = j.choices?.[0]?.delta || {};
      if (d.reasoning_content) reasoning += d.reasoning_content.length;
      if (d.content) process.stdout.write(d.content);
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }
}
console.log('');
if (reasoning) console.log(`\n（另有 ${reasoning} 字思考内容已省略）`);
