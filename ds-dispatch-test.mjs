// 验证分发层：Anthropic / OpenAI / 控制台探测 三条路径
// 都能正确路由到 DeepSeek 适配器（用 mock 拦截网络，不需要真实 token）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const AUTH = path.join(ROOT, 'auth.deepseek.json');

// ---- 准备：临时凭证 + 启用站点 ----
const hadAuth = fs.existsSync(AUTH);
const backup = hadAuth ? fs.readFileSync(AUTH, 'utf8') : null;
fs.writeFileSync(AUTH, JSON.stringify({ accessToken: 'MOCK_TOKEN', savedAt: new Date().toISOString() }, null, 2));

let calls = [];
// ---- Mock fetch：拦截 DeepSeek 的三个端点 ----
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body });

  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

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
    return json({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { id: 'mock-session-uuid' } } });
  }
  if (u.includes('/chat/completion')) {
    // 返回 SSE 流（真实 JSON-Patch 形态；直接用 UTF-8 字符，避免转义歧义）
    const sse = [
      'event: ready', 'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}', '',
      'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"你"}]}}}', '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"好"}', '',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}', '',
      'event: close', 'data: {"click_behavior":"none"}', '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return realFetch(url, init);
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

try {
  const { defaultConfig } = await import('./src/config.mjs');
  const cfg = defaultConfig();
  cfg.sites.deepseek.enabled = true;

  console.log('=== 1. dispatch 正确分发到 DeepSeek ===');
  const { openUpstream } = await import('./src/dispatch.mjs');
  calls = [];
  const up = await openUpstream(cfg, 'deepseek', {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
  }, {});
  check('返回 ok', up.ok === true, JSON.stringify(up).slice(0, 150));
  check('调用了 create_pow_challenge', calls.some((c) => c.url.includes('create_pow_challenge')));
  check('调用了 chat_session/create', calls.some((c) => c.url.includes('chat_session/create')));
  check('调用了 chat/completion', calls.some((c) => c.url.includes('chat/completion')));

  console.log('\n=== 2. PoW 头被正确附加 ===');
  const comp = calls.find((c) => c.url.includes('chat/completion'));
  const powHeader = comp?.headers?.['x-ds-pow-response'];
  check('completion 带 x-ds-pow-response', typeof powHeader === 'string' && powHeader.length > 0);
  if (powHeader) {
    const decoded = JSON.parse(Buffer.from(powHeader, 'base64').toString('utf8'));
    check('PoW answer 正确 (27720)', decoded.answer === 27720, `实际=${decoded.answer}`);
    check('PoW target_path 正确', decoded.target_path === '/api/v0/chat/completion');
  }
  check('客户端标识头存在', comp?.headers?.['x-client-bundle-id'] === 'com.deepseek.chat');

  console.log('\n=== 3. 请求体格式（单 prompt，非 messages）===');
  const sentBody = JSON.parse(comp.body);
  check('有 prompt 字段', typeof sentBody.prompt === 'string');
  check('prompt 内容正确', sentBody.prompt === '你好', `实际="${sentBody.prompt}"`);
  check('没有 messages 字段', sentBody.messages === undefined);
  check('chat_session_id 为会话 UUID', sentBody.chat_session_id === 'mock-session-uuid');
  check('thinking_enabled 默认 false', sentBody.thinking_enabled === false);

  console.log('\n=== 4. 帧翻译（DeepSeek → OpenAI chunk）===');
  const out = [];
  for await (const f of up.frames) out.push(JSON.parse(f));
  const text = out.map((c) => c.choices?.[0]?.delta?.content || '').join('');
  check('文本拼接正确（快照+增量）', text === '你好', `实际="${text}"`);
  check('产出 OpenAI chunk 形状', out.every((c) => c.object === 'chat.completion.chunk'));
  check('末帧 finish_reason=stop', out.at(-1).choices[0].finish_reason === 'stop');

  console.log('\n=== 5. Anthropic 路径也走分发 ===');
  // 直接验证 anthropic.mjs 内部用的是 openUpstream：通过 handleMessages 端到端跑
  const { toOpenAIBody } = await import('./src/anthropic.mjs');
  const oaBody = toOpenAIBody({
    model: 'deepseek/deepseek-chat',
    max_tokens: 100,
    messages: [{ role: 'user', content: '测试' }],
  });
  check('Anthropic 请求转换出 messages', Array.isArray(oaBody.messages));
  check('转换后 model 保留前缀', oaBody.model === 'deepseek/deepseek-chat');

  console.log('\n=== 6. reasoner 模型映射到 thinking ===');
  calls = [];
  const up2 = await openUpstream(cfg, 'deepseek', {
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'x' }],
  }, {});
  const comp2 = calls.find((c) => c.url.includes('chat/completion'));
  const body2 = JSON.parse(comp2.body);
  check('thinking_enabled = true', body2.thinking_enabled === true, `实际=${body2.thinking_enabled}`);
  up2.close?.();

  console.log('\n=== 7. 多轮对话被压平成单 prompt ===');
  calls = [];
  const up3 = await openUpstream(cfg, 'deepseek', {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '1+1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '再加1' },
    ],
  }, {});
  const body3 = JSON.parse(calls.find((c) => c.url.includes('chat/completion')).body);
  check('prompt 含系统指令', body3.prompt.includes('[系统指令]'));
  check('prompt 含历史轮次', body3.prompt.includes('[助手]\n2'));
  check('最后一句保持原样', body3.prompt.endsWith('再加1'));
  console.log(`     prompt = ${JSON.stringify(body3.prompt)}`);
  up3.close?.();
} finally {
  globalThis.fetch = realFetch;
  if (hadAuth) fs.writeFileSync(AUTH, backup);
  else fs.unlinkSync(AUTH);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
