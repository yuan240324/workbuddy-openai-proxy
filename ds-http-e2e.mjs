// 真机 HTTP 端到端测试：起一个真实的 HTTP 服务器（server.mjs 的路由），
// 只 mock DeepSeek 上游网络，然后像 Trae 那样发真实 HTTP 请求。
//
// 这验证的是「Trae 接入」真正依赖的东西：
//   端口监听、API Key 鉴权、路由容错、OpenAI 与 Anthropic 两种协议、SSE 传输。
//
// 注意：本沙箱不允许 spawn 子进程（EPERM），因此改为在同进程内 mock fetch
// 后再动态 import server.mjs —— 仍然走真实的 http.createServer 与全部路由。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const TEST_PORT = 8899;
const API_KEY = 'sk-test-deepseek-e2e';
const AUTH = path.join(ROOT, 'auth.deepseek.json');
const cfgPath = path.join(ROOT, 'config.json');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};

// ---------- 准备：临时配置 + 临时凭证 ----------
const cfgBackup = fs.readFileSync(cfgPath, 'utf8');
const hadAuth = fs.existsSync(AUTH);
const authBackup = hadAuth ? fs.readFileSync(AUTH, 'utf8') : null;

fs.writeFileSync(AUTH, JSON.stringify({ accessToken: 'MOCK_DS_TOKEN', savedAt: new Date().toISOString() }, null, 2));

const cfg = JSON.parse(cfgBackup);
cfg.port = TEST_PORT;
cfg.apiKey = API_KEY;
cfg.sites.deepseek = {
  label: 'DeepSeek (test)',
  enabled: true,
  protocol: 'deepseek',
  apiBase: 'https://chat.deepseek.com',
  origin: 'https://chat.deepseek.com',
  userAgent: 'test',
  seedModels: [
    { id: 'deepseek-chat', name: 'DeepSeek default' },
    { id: 'deepseek-reasoner', name: 'DeepSeek reasoner' },
  ],
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const EXPECTED = '\u4f60\u597d\u5440'; // 你好呀

// ---------- mock DeepSeek 上游（仅拦截官方域名） ----------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

  if (u.includes('/create_pow_challenge')) {
    const challenge = {
      algorithm: 'DeepSeekHashV1',
      challenge: '2710c2f9d32645e18a18c2d6ae2a2e8eed1d079ad5a773861b8c8913be87b722',
      salt: 'ccd2d20978f6b8697919',
      signature: 'c0ac58cab9eeaf914f53bba9033f23657706c34d494346eadf955153220cd8c8',
      difficulty: 144000,
      expire_at: 1789247493602,
      expire_after: 300000,
      target_path: '/api/v0/chat/completion',
    };
    return json({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { challenge } } });
  }
  if (u.includes('/chat_session/create')) {
    return json({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { id: 'e2e-session-uuid' } } });
  }
  if (u.includes('/chat/completion')) {
    const sse = [
      'event: ready', 'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}', '',
      'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"\u4f60"}]}}}', '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"\u597d"}', '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"\u5440"}', '',
      'event: title', 'data: {"content":"greeting"}', '',
      'event: close', 'data: {"click_behavior":"none"}', '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return realFetch(url, init);
};

const BASE = `http://127.0.0.1:${TEST_PORT}`;
const authHeaders = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

async function waitReady(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await realFetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 250));
  }
  return false;
}

try {
  console.log('=== 0. 启动真实 HTTP 服务器 ===');
  await import('./server.mjs'); // 内部会 listen 到 TEST_PORT
  const ready = await waitReady();
  check(`服务器在 ${TEST_PORT} 端口就绪`, ready);
  if (!ready) throw new Error('server did not start');

  console.log('\n=== 1. 鉴权（Trae 会带 API Key）===');
  {
    const r = await realFetch(`${BASE}/v1/models`);
    check('无 Key 返回 401', r.status === 401, `actual=${r.status}`);
  }

  console.log('\n=== 2. GET /v1/models 列出 deepseek 模型 ===');
  {
    const r = await realFetch(`${BASE}/v1/models`, { headers: authHeaders });
    const j = await r.json();
    check('HTTP 200', r.status === 200, `actual=${r.status}`);
    const ids = (j.data || []).map((m) => m.id);
    check('含 deepseek-chat', ids.includes('deepseek-chat'), `actual=${ids.join(',')}`);
    check('含 deepseek-reasoner', ids.includes('deepseek-reasoner'));
    const m = (j.data || []).find((x) => x.id === 'deepseek-chat');
    check('带 site 字段', m?.site === 'deepseek', `actual=${m?.site}`);
  }

  console.log('\n=== 3. OpenAI 非流式 /v1/chat/completions ===');
  {
    const r = await realFetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    const j = await r.json();
    check('HTTP 200', r.status === 200, `actual=${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    check('object 为 chat.completion', j.object === 'chat.completion', `actual=${j.object}`);
    check('回复内容正确', j.choices?.[0]?.message?.content === EXPECTED, `actual="${j.choices?.[0]?.message?.content}"`);
    check('有 usage 字段', j.usage && typeof j.usage.total_tokens === 'number');
    check('finish_reason 为 stop', j.choices?.[0]?.finish_reason === 'stop');
  }

  console.log('\n=== 4. OpenAI 流式 /v1/chat/completions（SSE）===');
  {
    const r = await realFetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    check('content-type 是 SSE', (r.headers.get('content-type') || '').includes('text/event-stream'), `actual=${r.headers.get('content-type')}`);
    const text = await r.text();
    check('流以 [DONE] 结束', text.trim().endsWith('[DONE]'), `tail="${text.trim().slice(-60)}"`);
    const chunks = text.split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
    check('流式正文拼接正确', content === EXPECTED, `actual="${content}"`);
    check('chunk 形状为 OpenAI', chunks[0]?.object === 'chat.completion.chunk');
    check('首帧带 role', chunks[0]?.choices?.[0]?.delta?.role === 'assistant');
  }

  console.log('\n=== 5. Anthropic 非流式 /v1/messages ===');
  {
    const r = await realFetch(`${BASE}/v1/messages`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const j = await r.json();
    check('HTTP 200', r.status === 200, `actual=${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    check('type 为 message', j.type === 'message', `actual=${j.type}`);
    check('正文正确', j.content?.[0]?.text === EXPECTED, `actual="${j.content?.[0]?.text}"`);
    check('stop_reason 为 end_turn', j.stop_reason === 'end_turn', `actual=${j.stop_reason}`);
    check('usage 有 input/output', typeof j.usage?.input_tokens === 'number' && typeof j.usage?.output_tokens === 'number');
  }

  console.log('\n=== 6. Anthropic 流式 /v1/messages ===');
  {
    const r = await realFetch(`${BASE}/v1/messages`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    check('HTTP 200', r.status === 200, `actual=${r.status}`);
    const text = await r.text();
    check('含 message_start 事件', text.includes('message_start'));
    check('含 content_block_delta', text.includes('content_block_delta'));
    check('含 message_stop', text.includes('message_stop'));
    const deltas = text.split('\n').filter((l) => l.startsWith('data:'))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean)
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => e.delta?.text || '').join('');
    check('流式正文正确', deltas === EXPECTED, `actual="${deltas}"`);
  }

  console.log('\n=== 7. 路径容错（Trae 可能拼错路径）===');
  {
    const r = await realFetch(`${BASE}/v1/messages/chat/completions`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    check('重复拼接路径仍能命中', r.status === 200, `actual=${r.status}`);
  }

  console.log('\n=== 8. 站点列表 ===');
  {
    const r = await realFetch(`${BASE}/health`);
    const j = await r.json();
    const sites = j.sites.map((s) => s.site);
    check('deepseek 出现在站点列表', sites.includes('deepseek'), `actual=${sites.join(',')}`);
  }
} catch (e) {
  fail++;
  console.log(`\n  [FAIL] 测试异常：${e.message}`);
} finally {
  // ---------- 清理（必须可靠执行）----------
  // 注意：不要在这里 process.exit()，否则会跳过清理、污染用户的 config.json。
  globalThis.fetch = realFetch;
  try {
    fs.writeFileSync(cfgPath, cfgBackup);
    if (hadAuth) fs.writeFileSync(AUTH, authBackup);
    else if (fs.existsSync(AUTH)) fs.unlinkSync(AUTH);
    console.log('\n（已清理：临时配置已还原、临时凭证已删除）');
  } catch (e) {
    console.log(`\n  [严重] 清理失败，请手动恢复 config.json：${e.message}`);
    console.log(`  备份内容长度 ${cfgBackup.length}，可从此前的输出中恢复`);
  }
}

// 清理完成后再决定退出码
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
// server.mjs 的 http server 会让事件循环一直存活，必须显式退出，
// 否则测试进程会挂住（CI 里表现为超时）。
setTimeout(() => process.exit(process.exitCode || 0), 100).unref();
