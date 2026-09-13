// 验证控制台的「粘贴 token 登录」端点（DeepSeek 专用）。
// 走真实 HTTP 服务器，mock verifyToken 的网络调用。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const TEST_PORT = 8898;
const API_KEY = 'sk-test-console-deepseek';
const AUTH = path.join(ROOT, 'auth.deepseek.json');
const cfgPath = path.join(ROOT, 'config.json');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};

const cfgBackup = fs.readFileSync(cfgPath, 'utf8');
const hadAuth = fs.existsSync(AUTH);
const authBackup = hadAuth ? fs.readFileSync(AUTH, 'utf8') : null;

const cfg = JSON.parse(cfgBackup);
cfg.port = TEST_PORT;
cfg.apiKey = API_KEY;
cfg.sites.deepseek = {
  label: 'DeepSeek (console test)',
  enabled: true,
  protocol: 'deepseek',
  apiBase: 'https://chat.deepseek.com',
  origin: 'https://chat.deepseek.com',
  userAgent: 'test',
  seedModels: [{ id: 'deepseek-chat', name: 'DeepSeek' }],
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// mock 用户校验端点
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/users/current')) {
    const auth = (init.headers && init.headers.Authorization) || '';
    const tok = String(auth).replace('Bearer ', '');
    if (tok === 'GOOD_TOKEN') {
      return new Response(JSON.stringify({ code: 0, msg: '', data: { user: { email: 'test@example.com', id: 'u1' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const BASE = `http://127.0.0.1:${TEST_PORT}`;
const H = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

async function waitReady(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await realFetch(`${BASE}/health`); if (r.ok) return true; } catch { /* not up */ }
    await new Promise((s) => setTimeout(s, 250));
  }
  return false;
}

try {
  console.log('=== 0. 启动真实服务器 ===');
  await import('./server.mjs');
  const ready = await waitReady();
  check('服务器就绪', ready);
  if (!ready) throw new Error('server did not start');

  console.log('\n=== 1. 设备授权登录对 DeepSeek 应被拒绝 ===');
  {
    const r = await realFetch(`${BASE}/console/api/login/start`, {
      method: 'POST', headers: H, body: JSON.stringify({ site: 'deepseek' }),
    });
    const j = await r.json();
    check('返回 400', r.status === 400, `actual=${r.status}`);
    check('标记 need_token', j.need_token === true, JSON.stringify(j));
    check('给出取 token 提示', String(j.hint || '').includes('userToken'));
  }

  console.log('\n=== 2. 无效 token 应被拒绝 ===');
  {
    const r = await realFetch(`${BASE}/console/api/login/token`, {
      method: 'POST', headers: H, body: JSON.stringify({ site: 'deepseek', token: 'BAD_TOKEN' }),
    });
    check('返回 401', r.status === 401, `actual=${r.status}`);
    const j = await r.json();
    check('错误信息合理', String(j.error || '').includes('校验失败'), JSON.stringify(j));
  }

  console.log('\n=== 3. 缺少 token 应被拒绝 ===');
  {
    const r = await realFetch(`${BASE}/console/api/login/token`, {
      method: 'POST', headers: H, body: JSON.stringify({ site: 'deepseek' }),
    });
    check('返回 400', r.status === 400, `actual=${r.status}`);
  }

  console.log('\n=== 4. 有效 token → 保存成功 ===');
  {
    const r = await realFetch(`${BASE}/console/api/login/token`, {
      method: 'POST', headers: H, body: JSON.stringify({ site: 'deepseek', token: 'GOOD_TOKEN' }),
    });
    const j = await r.json();
    check('返回 200', r.status === 200, `actual=${r.status} ${JSON.stringify(j)}`);
    check('ok 为 true', j.ok === true);
    check('带回账号', j.account === 'test@example.com', `actual=${j.account}`);
    check('凭证文件已写入', fs.existsSync(AUTH));
    if (fs.existsSync(AUTH)) {
      const saved = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
      check('保存的 token 正确', saved.accessToken === 'GOOD_TOKEN', `actual=${saved.accessToken}`);
    }
  }

  console.log('\n=== 5. 自动剥离 {"value":"..."} 包装 ===');
  {
    const r = await realFetch(`${BASE}/console/api/login/token`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ site: 'deepseek', token: '{"value":"GOOD_TOKEN"}' }),
    });
    const j = await r.json();
    check('包装被剥离且校验通过', r.status === 200 && j.ok === true, `actual=${r.status} ${JSON.stringify(j)}`);
  }

  console.log('\n=== 6. 非 DeepSeek 站点不接受 token 登录 ===');
  {
    const r = await realFetch(`${BASE}/console/api/login/token`, {
      method: 'POST', headers: H, body: JSON.stringify({ site: 'cn-cli', token: 'x' }),
    });
    check('返回 400', r.status === 400, `actual=${r.status}`);
  }
} catch (e) {
  fail++;
  console.log(`\n  [FAIL] 异常：${e.message}`);
} finally {
  globalThis.fetch = realFetch;
  fs.writeFileSync(cfgPath, cfgBackup);
  if (hadAuth) fs.writeFileSync(AUTH, authBackup);
  else if (fs.existsSync(AUTH)) fs.unlinkSync(AUTH);
  console.log('\n（已清理：临时配置与凭证）');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(process.exitCode || 0), 100).unref();
