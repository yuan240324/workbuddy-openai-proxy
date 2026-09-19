// 安全回归测试（P0）：控制台来源校验、DNS rebinding 防护、鉴权。
//
// 做法：把 server.mjs 作为子进程启动在随机端口，用原始 TCP socket 发请求
// （Node 的 fetch 会忽略手工设置的 Host 头，无法用于 DNS rebinding 场景）。
//
// 环境适配：某些受限沙箱禁止带管道的子进程（spawn 抛 EPERM），但允许
// stdio:'ignore' 或重定向到文件。这里优先用「重定向到文件」以保留启动日志，
// 若连这也被禁止，则把套件标记为 skip 而不是失败——环境限制不应算代码缺陷。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 15_000 + Math.floor(Math.random() * 2000);
const API_KEY = 'sk-wb-test-security';

let child = null;
let tmpDir = null;
let logFd = null;
let spawnBlocked = false;

/** 原始 HTTP 请求，可自定义 Host / Origin / body，绕过 fetch 的限制。 */
function raw(port, reqPath, { host, origin, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      let req = `${method} ${reqPath} HTTP/1.1\r\nHost: ${host || `127.0.0.1:${port}`}\r\nConnection: close\r\n`;
      if (origin) req += `Origin: ${origin}\r\n`;
      for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`;
      if (body !== undefined) req += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
      req += '\r\n';
      sock.write(req);
      if (body !== undefined) sock.write(body);
    });
    let buf = '';
    sock.on('data', (d) => (buf += d));
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error('socket timeout')); });
  });
}

const statusOf = (res) => Number((res.match(/^HTTP\/1\.1 (\d+)/) || [])[1]);
const headerOf = (res, name) => {
  const m = res.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
};

/** 启动服务子进程；返回是否成功启动。 */
function startServer() {
  try {
    // 优先：日志重定向到文件（沙箱允许），便于失败时诊断
    const logPath = path.join(tmpDir, 'server.log');
    logFd = fs.openSync(logPath, 'w');
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, WB_CONFIG_DIR: tmpDir },
      stdio: ['ignore', logFd, logFd],
    });
  } catch (e) {
    if (e.code === 'EPERM') {
      // 退一步：完全忽略 stdio
      try {
        child = spawn(process.execPath, ['server.mjs'], {
          cwd: ROOT,
          env: { ...process.env, WB_CONFIG_DIR: tmpDir },
          stdio: 'ignore',
        });
      } catch (e2) {
        if (e2.code === 'EPERM') { spawnBlocked = true; return false; }
        throw e2;
      }
    } else {
      throw e;
    }
  }
  child.on('error', (e) => { if (e.code === 'EPERM') spawnBlocked = true; });
  return true;
}

before(async () => {
  // 用临时目录，避免污染仓库里的 config.json
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    host: '127.0.0.1',
    port: PORT,
    apiKey: API_KEY,
    defaultSite: 'cn-cli',
    defaultModel: 'm',
    defaultMaxTokens: 100,
    stripFields: [],
    sites: { 'cn-cli': { label: 'T', enabled: true, apiBase: 'https://copilot.tencent.com' } },
    modelRoutes: {},
    timeouts: { headerMs: 2000, idleMs: 2000, metaMs: 1000 },
    models: [],
    modelAliases: {},
  }, null, 2));

  if (!startServer()) return;

  // 等端口就绪
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnBlocked) return;
    try {
      const r = await raw(PORT, '/health');
      if (statusOf(r)) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(() => {
  try { child?.kill(); } catch { /* ignore */ }
  try { if (logFd !== null) fs.closeSync(logFd); } catch { /* ignore */ }
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const skipIfBlocked = (t) => {
  if (spawnBlocked) {
    t.skip('当前环境无法 spawn 子进程，跳过端到端安全测试');
    return true;
  }
  return false;
};

describe('P0-1：控制台不可被跨站读取（会话 token 泄露防护）', () => {
  test('恶意 Origin 读取 /console 被拒且不泄露 token', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/console', { origin: 'https://evil.example.com' });
    assert.equal(statusOf(res), 403, '应返回 403');
    assert.ok(!res.includes('__WB_TOKEN__'), '响应体绝不能包含会话 token');
  });

  test('被拒时也不回显 ACAO:*', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/console', { origin: 'https://evil.example.com' });
    assert.notEqual(headerOf(res, 'Access-Control-Allow-Origin'), '*');
  });

  test('恶意 Origin 调用控制台 API 被拒', async (t) => {
    if (skipIfBlocked(t)) return;
    for (const [p, m] of [['/console/api/state', 'GET'], ['/console/api/service/stop', 'POST']]) {
      const res = await raw(PORT, p, { origin: 'https://evil.example.com', method: m, headers: { 'X-Console-Token': 'x' } });
      assert.equal(statusOf(res), 403, `${m} ${p} 应被拒`);
    }
  });

  test('本机无 Origin 可正常访问（地址栏/本机工具不被误伤）', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/console');
    assert.equal(statusOf(res), 200);
    assert.ok(res.includes('__WB_TOKEN__'), '本机访问应拿到注入的 token');
  });

  test('本机 Origin（127.0.0.1 / localhost）可访问', async (t) => {
    if (skipIfBlocked(t)) return;
    for (const o of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) {
      const res = await raw(PORT, '/console', { origin: o });
      assert.equal(statusOf(res), 200, `${o} 应放行`);
    }
  });

  test('控制台响应带 X-Frame-Options: DENY', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/console');
    assert.equal(headerOf(res, 'X-Frame-Options'), 'DENY');
  });

  test('控制台接口仍需 token 或 apiKey（鉴权未被削弱）', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/console/api/state');
    assert.equal(statusOf(res), 401, '无凭证应 401');
  });
});

describe('P0-1：DNS rebinding 防护（校验 Host）', () => {
  test('Host 指向外部域名时被拒', async (t) => {
    if (skipIfBlocked(t)) return;
    for (const h of ['attacker.example.com', `evil.com:${PORT}`, 'myapp.local']) {
      const res = await raw(PORT, '/console', { host: h });
      assert.equal(statusOf(res), 403, `Host=${h} 应被拒`);
    }
  });

  test('Host 为本机时放行', async (t) => {
    if (skipIfBlocked(t)) return;
    for (const h of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      const res = await raw(PORT, '/console', { host: h });
      assert.equal(statusOf(res), 200, `Host=${h} 应放行`);
    }
  });

  test('对话接口不受 Host 校验影响（客户端可能用任意 Host）', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/models', { host: 'some-client.example.com', headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.notEqual(statusOf(res), 403, '/v1/* 不应被 Host 校验拦截');
  });
});

describe('P0-2：API Key 鉴权', () => {
  test('无 key 访问 /v1/* 返回 401', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/models');
    assert.equal(statusOf(res), 401);
  });

  test('错误 key 返回 401', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/models', { headers: { Authorization: 'Bearer wrong-key' } });
    assert.equal(statusOf(res), 401);
  });

  test('正确 key 放行', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/models', { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(statusOf(res), 200);
  });

  test('x-api-key 头同样被接受', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/models', { headers: { 'x-api-key': API_KEY } });
    assert.equal(statusOf(res), 200);
  });

  test('/v1/* 仍保留宽松 CORS（浏览器内客户端需要）', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/models', { origin: 'https://any.example.com' });
    assert.equal(headerOf(res, 'Access-Control-Allow-Origin'), '*');
  });
});

describe('P1-3：路径路由（按路径段匹配，保留拼接容错）', () => {
  test('GET /v1/models 正常', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/models', { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(statusOf(res), 200);
  });

  test('含相似子串的路径不被误判为 404 以外（/v1/mymessagesfoo）', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/mymessagesfoo', {
      method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    assert.equal(statusOf(res), 404, '不应被误判为 messages 端点');
  });

  test('TraeWork 拼接路径 /v1/messages/chat/completions 仍被识别', async (t) => {
    if (skipIfBlocked(t)) return;
    // 无有效凭证时上游会报错（401/502 等），但绝不应落到 404
    const res = await raw(PORT, '/v1/messages/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.notEqual(statusOf(res), 404, '拼接路径不应落到 404');
  });

  test('POST /v1/chat/completions 正常被识别', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    assert.notEqual(statusOf(res), 404);
  });

  test('POST /v1/messages/count_tokens 正常被识别', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/messages/count_tokens', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(statusOf(res), 200, 'count_tokens 应直接返回 200');
    assert.match(res, /input_tokens/);
  });

  test('非法 JSON body 返回 400', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(statusOf(res), 400);
  });

  test('未知路径返回 404', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/definitely/not/an/endpoint', { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(statusOf(res), 404);
  });
});

describe('健康检查（无需鉴权）', () => {
  test('/health 返回 200 且结构正确', async (t) => {
    if (skipIfBlocked(t)) return;
    const res = await raw(PORT, '/health');
    assert.equal(statusOf(res), 200);
    assert.match(res, /workbuddy-proxy/);
  });
});
