// 完整链路实测：申请挑战 → 求解 PoW → 发起补全 → 解析 SSE。
// 这是写代理前的最后一道验证。
import fs from 'node:fs';
import readline from 'node:readline';

const ROOT = import.meta.dirname;

// ---- 读取 token ----
function getToken() {
  if (fs.existsSync(`${ROOT}/.ds-token`)) return fs.readFileSync(`${ROOT}/.ds-token`, 'utf8').trim();
  if (fs.existsSync(`${ROOT}/auth.deepseek.json`)) {
    const j = JSON.parse(fs.readFileSync(`${ROOT}/auth.deepseek.json`, 'utf8'));
    return String(j.accessToken || j.token || '').trim();
  }
  return null;
}

const token = getToken();
if (!token) {
  console.log('未找到 token。请把 token 存到 .ds-token 文件（单行）。');
  process.exit(1);
}

const BASE = 'https://chat.deepseek.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

/** 抓包确认必须的请求头。 */
function headers(extra = {}) {
  return {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: BASE,
    Referer: `${BASE}/`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-timezone-offset': '28800',
    'x-client-version': '2.5.0',
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

// ---- 载入 wasm ----
const wasmBytes = fs.readFileSync(`${ROOT}/_ds-pow/sha3_wasm_bg.wasm`);
const ex = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}).exports;
const st = ex.__wbindgen_add_to_stack_pointer;
const alloc = ex.__wbindgen_export_0;

function passString(str) {
  const n = str.length;
  const ptr = alloc(n, 1) >>> 0;
  const u = new Uint8Array(ex.memory.buffer);
  for (let i = 0; i < n; i++) u[ptr + i] = str.charCodeAt(i) & 0xff;
  return { ptr, len: n };
}

/** 求解 PoW：返回 answer。 */
function solvePow(challenge, prefix, difficulty) {
  const c = passString(challenge);
  const p = passString(prefix);
  const ret = st(-16) >>> 0;
  try {
    ex.wasm_solve(ret, c.ptr, c.len, p.ptr, p.len, difficulty);
    const dv = new DataView(ex.memory.buffer);
    const status = dv.getInt32(ret, true);
    return status === 0 ? undefined : dv.getFloat64(ret + 8, true);
  } finally {
    st(16);
  }
}

const log = (...a) => console.log(...a);

async function main() {
  // ---- 1. 申请挑战 ----
  log('[1] 申请 PoW 挑战…');
  const cr = await fetch(`${BASE}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  const cj = await cr.json();
  if (cj.code !== 0) throw new Error(`申请挑战失败: ${JSON.stringify(cj)}`);
  const ch = cj.data.biz_data.challenge;
  log(`    algorithm=${ch.algorithm} difficulty=${ch.difficulty} expire_at=${ch.expire_at}`);

  // ---- 2. 求解 PoW ----
  log('[2] 求解 PoW…');
  const t0 = Date.now();
  const prefix = `${ch.salt}_${ch.expire_at}_`;
  const answer = solvePow(ch.challenge, prefix, ch.difficulty);
  if (answer === undefined) throw new Error('PoW 求解失败');
  log(`    answer=${answer}  耗时 ${Date.now() - t0}ms`);

  const powPayload = {
    algorithm: ch.algorithm,
    challenge: ch.challenge,
    salt: ch.salt,
    answer,
    signature: ch.signature,
    target_path: '/api/v0/chat/completion',
  };
  const powHeader = Buffer.from(JSON.stringify(powPayload)).toString('base64');

  // ---- 3. 创建会话 ----
  log('[3] 创建会话…');
  const sr = await fetch(`${BASE}/api/v0/chat_session/create`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}',
  });
  const sj = await sr.json();
  if (sj.code !== 0) throw new Error(`创建会话失败: ${JSON.stringify(sj)}`);
  const sessionId = sj.data.biz_data.chat_session?.id ?? sj.data.biz_data.id;
  log(`    session_id=${sessionId}`);

  // ---- 4. 发起补全 ----
  log('[4] 发起补全（流式）…');
  const cr2 = await fetch(`${BASE}/api/v0/chat/completion`, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      'x-ds-pow-response': powHeader,
      Referer: `${BASE}/a/chat/s/${sessionId}`,
    }),
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type: 'default',
      prompt: '回复三个字：你好啊',
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    }),
  });

  log(`    HTTP ${cr2.status}  content-type=${cr2.headers.get('content-type')}`);
  if (!cr2.ok) {
    log('    响应: ' + (await cr2.text()).slice(0, 400));
    return;
  }

  // ---- 5. 解析 SSE ----
  log('[5] SSE 事件流：');
  const reader = cr2.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.startsWith('data:')) { events.push(`[event] ${line}`); continue; }
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        events.push(`[raw] ${payload.slice(0, 120)}`);
      }
    }
  }

  log(`    共 ${events.length} 个事件`);

  // 用库函数解析（与代理实际使用的逻辑一致）
  const { extractDelta } = await import('./src/deepseek.mjs');
  let full = '';
  let reasoning = '';
  let usage = null;
  let finished = false;
  for (const e of events) {
    if (typeof e !== 'object') continue;
    const r = extractDelta(e);
    full += r.text;
    reasoning += r.reasoning;
    if (r.usage) usage = r.usage;
    if (r.done) finished = true;
  }
  log(`\n    模型完整回复: "${full}"`);
  if (reasoning) log(`    思考内容: "${reasoning.slice(0, 100)}…"`);
  if (usage) log(`    token 用量: ${JSON.stringify(usage)}`);
  log(`    流正常结束: ${finished ? '是' : '否'}`);
  fs.writeFileSync(`${ROOT}/_ds-pow/last-sse.json`, JSON.stringify(events, null, 2), 'utf8');
  log('\n[OK] 完整链路已跑通（真实 PoW + 真实补全），SSE 已存 _ds-pow/last-sse.json');
}

main().catch((e) => { console.error('失败: ' + e.message); process.exitCode = 1; });
