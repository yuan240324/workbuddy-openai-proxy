// 凭证刷新与失效处理测试（P1-4）
//
// 关键区分：
//   - 上游明确返回 401/403 或 invalid_grant → 凭证已死，应清除并提示重新登录
//   - 上游 500 / 网络异常 / 超时        → 临时故障，必须保留凭证（否则用户被迫反复登录）
//
// 隔离方式：用 setConfigDir() 显式切到临时目录。
// 不能只靠 WB_CONFIG_DIR 环境变量——多个测试文件共享同一进程时，
// 模块只加载一次，环境变量在加载后再设置就无效了（会把凭证写进仓库根目录）。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-'));

const { authPathFor, setConfigDir } = await import('../src/config.mjs');
const restoreConfigDir = setConfigDir(tmpDir);
const authMod = await import('../src/auth.mjs');

const PORT = 16_000 + Math.floor(Math.random() * 2000);

// 注意：必须每次现算，不能在模块加载时缓存成常量。
// 配置目录是可变状态，同进程的其他测试文件会切换它；
// 缓存下来的话测试写到 A 目录、被测代码却读 B 目录，表现为随执行顺序时好时坏。
const authFile = () => authPathFor('cn-cli');

// 断言隔离确实生效，避免测试污染仓库
if (!authFile().startsWith(tmpDir)) {
  throw new Error(`测试隔离失败：凭证路径 ${authFile()} 不在临时目录 ${tmpDir} 内`);
}

// 可控行为的假上游
let mode = 'ok';
const server = http.createServer((req, res) => {
  if (req.url.includes('/auth/token/refresh')) {
    if (mode === 'unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 401, msg: 'invalid_grant: refresh token expired' }));
    }
    if (mode === 'forbidden') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 403, msg: 'forbidden' }));
    }
    if (mode === 'server_error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 500, msg: 'internal error' }));
    }
    if (mode === 'business_code') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 1002, msg: '登录态已失效' }));
    }
    if (mode === 'bad_json') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>gateway</html>');
    }
    if (mode === 'no_token_field') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: {} }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: 0, data: { accessToken: 'new-token', refreshToken: 'new-rt', expiresIn: 3600 } }));
  }
  res.writeHead(404);
  res.end('{}');
});

const cfg = {
  defaultSite: 'cn-cli',
  sites: {
    'cn-cli': {
      label: 'T', enabled: true,
      apiBase: `http://127.0.0.1:${PORT}`,
      billingBase: `http://127.0.0.1:${PORT}`,
      origin: 'https://x.test', userAgent: 'T/1',
    },
  },
};

before(async () => { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); });
after(async () => {
  await new Promise((r) => server.close(r));
  restoreConfigDir();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写入一份「已有但临期」的凭证，并触发热加载（mtime 变化）。 */
function writeAuth({ accessToken = 'old-token', refreshToken = 'old-rt' } = {}) {
  const f = authFile();
  fs.writeFileSync(f, JSON.stringify({
    site: 'cn-cli', accessToken, refreshToken,
    expiresAt: Date.now() + 1000, uid: 'u1',
  }, null, 2));
  // 显式把 mtime 往前推，避免同一毫秒内重写导致 mtime 未变、命中旧缓存
  const t = Date.now() / 1000 + 1;
  fs.utimesSync(f, t, t);
}
const authExists = () => fs.existsSync(authFile());
const readAuth = () => JSON.parse(fs.readFileSync(authFile(), 'utf8'));

/**
 * 用例边界上重新声明本文件的前提：
 *  - 把全局配置目录指回本文件的临时目录（同进程的其他测试文件可能改走它）
 *  - 复位上游行为并重建凭证文件
 * 这样本文件不依赖执行顺序，单独跑与全量跑结果一致。
 */
beforeEach(() => {
  setConfigDir(tmpDir);
  mode = 'ok';
  writeAuth();
});

describe('refreshToken：成功路径', () => {
  test('刷新成功后写入新 token 并保留文件', async () => {
    mode = 'ok';
    writeAuth();
    const tok = await authMod.ensureToken(cfg, 'cn-cli', { force: true });
    assert.equal(tok, 'new-token');
    assert.ok(authExists(), '凭证文件应保留');
    assert.equal(readAuth().accessToken, 'new-token');
  });

  test('refreshToken 轮换时一并保存', async () => {
    mode = 'ok';
    writeAuth();
    await authMod.ensureToken(cfg, 'cn-cli', { force: true });
    assert.equal(readAuth().refreshToken, 'new-rt');
  });

  test('未临期且非 force 时直接返回现有 token（不请求上游）', async () => {
    mode = 'server_error'; // 若真的请求上游会失败
    const f = authFile();
    fs.writeFileSync(f, JSON.stringify({
      site: 'cn-cli', accessToken: 'fresh', refreshToken: 'rt',
      expiresAt: Date.now() + 3600_000, uid: 'u1',
    }, null, 2));
    const t = Date.now() / 1000 + 1;
    fs.utimesSync(f, t, t);
    const tok = await authMod.ensureToken(cfg, 'cn-cli');
    assert.equal(tok, 'fresh');
  });
});

describe('refreshToken：凭证已死 → 清除本地凭证', () => {
  test('HTTP 401 时清除凭证并报 not_logged_in', async () => {
    mode = 'unauthorized';
    writeAuth();
    await assert.rejects(
      () => authMod.ensureToken(cfg, 'cn-cli', { force: true }),
      (e) => {
        assert.equal(e.code, 'not_logged_in');
        assert.equal(e.status, 401);
        return true;
      },
    );
    assert.equal(authExists(), false, '失效凭证应被删除');
  });

  test('HTTP 403 同样视为失效', async () => {
    mode = 'forbidden';
    writeAuth();
    await assert.rejects(() => authMod.ensureToken(cfg, 'cn-cli', { force: true }),
      (e) => e.code === 'not_logged_in');
    assert.equal(authExists(), false);
  });

  test('业务码 1002（登录态失效）也清除', async () => {
    mode = 'business_code';
    writeAuth();
    await assert.rejects(() => authMod.ensureToken(cfg, 'cn-cli', { force: true }),
      (e) => e.code === 'not_logged_in');
    assert.equal(authExists(), false);
  });

  test('错误信息包含重新登录指引', async () => {
    mode = 'unauthorized';
    writeAuth();
    const err = await authMod.ensureToken(cfg, 'cn-cli', { force: true }).catch((e) => e);
    assert.match(err.message, /重新登录|login\.mjs/);
  });
});

describe('refreshToken：临时故障 → 必须保留凭证', () => {
  test('HTTP 500 保留凭证', async () => {
    mode = 'server_error';
    writeAuth();
    const err = await authMod.ensureToken(cfg, 'cn-cli', { force: true }).catch((e) => e);
    assert.equal(err.code, 'refresh_failed', '不应被误判为登录失效');
    assert.ok(authExists(), '临时故障绝不能删除凭证');
  });

  test('响应不是 JSON 时保留凭证', async () => {
    mode = 'bad_json';
    writeAuth();
    const err = await authMod.ensureToken(cfg, 'cn-cli', { force: true }).catch((e) => e);
    assert.equal(err.code, 'refresh_failed');
    assert.ok(authExists());
  });

  test('code=0 但缺 accessToken 时保留凭证', async () => {
    mode = 'no_token_field';
    writeAuth();
    const err = await authMod.ensureToken(cfg, 'cn-cli', { force: true }).catch((e) => e);
    assert.equal(err.code, 'refresh_failed');
    assert.ok(authExists());
  });

  test('端口不通（网络异常）时保留凭证', async () => {
    writeAuth();
    const badCfg = {
      defaultSite: 'cn-cli',
      sites: { 'cn-cli': { ...cfg.sites['cn-cli'], apiBase: 'http://127.0.0.1:1' } },
    };
    const err = await authMod.ensureToken(badCfg, 'cn-cli', { force: true }).catch((e) => e);
    assert.ok(err, '应抛出错误');
    assert.ok(authExists(), '网络异常不能删凭证');
  });
});

describe('ensureToken：未登录场景', () => {
  test('无 accessToken 时抛 not_logged_in 并给出登录指引', async () => {
    setConfigDir(tmpDir);
    // 清掉凭证与可能存在的旧版凭证，确保处于未登录状态
    fs.rmSync(authFile(), { force: true });
    fs.rmSync(path.join(tmpDir, 'auth.json'), { force: true });
    const err = await authMod.ensureToken(cfg, 'cn-cli', { force: true }).catch((e) => e);
    assert.ok(err, '应抛出错误');
    assert.equal(err.status, 401);
    assert.match(err.message, /尚未登录|login\.mjs/);
  });
});

describe('并发刷新：单飞（避免刷新风暴）', () => {
  test('并发调用只触发一次上游刷新', async () => {
    mode = 'ok';
    writeAuth();
    let hits = 0;
    const origEmit = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url.includes('/auth/token/refresh')) hits++;
      origEmit(req, res);
    });

    await Promise.all([
      authMod.ensureToken(cfg, 'cn-cli', { force: true }),
      authMod.ensureToken(cfg, 'cn-cli', { force: true }),
      authMod.ensureToken(cfg, 'cn-cli', { force: true }),
    ]);

    assert.equal(hits, 1, `并发刷新应合并为 1 次请求，实际 ${hits}`);
    server.removeAllListeners('request');
    server.on('request', origEmit);
  });
});

describe('JWT 解析：jwtClaims / hydrateFromToken', () => {
  const makeJwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

  test('解析 sub / exp / iss', () => {
    const tok = makeJwt({ sub: 'user-1', exp: 2000000000, iss: 'https://sso-ent1.example.com' });
    const c = authMod.jwtClaims(tok);
    assert.equal(c.sub, 'user-1');
    assert.equal(c.exp, 2000000000);
  });

  test('非法 token 返回 null 而不抛错', () => {
    assert.equal(authMod.jwtClaims('garbage'), null);
    assert.equal(authMod.jwtClaims(''), null);
    assert.equal(authMod.jwtClaims('a.b'), null);
  });

  test('hydrateFromToken 补齐 uid / enterpriseId / domain', () => {
    // iss 形如 https://sso-<enterpriseId>.<domain>；
    // 源码用 /\/sso-([^/]+)$/ 取值，因此 enterpriseId 是 "sso-" 之后到结尾的整段。
    const tok = makeJwt({ sub: 'u9', exp: 2000000000, iss: 'https://sso-ent9.example.com' });
    const auth = { accessToken: tok };
    authMod.hydrateFromToken('cn-cli', auth);
    assert.equal(auth.uid, 'u9');
    assert.equal(auth.enterpriseId, 'ent9.example.com');
    assert.equal(auth.domain, 'sso-ent9.example.com');
    assert.equal(auth.expiresAt, 2000000000 * 1000);
  });

  test('iss 无 sso- 前缀时不设置 enterpriseId', () => {
    const tok = makeJwt({ sub: 'u1', exp: 1, iss: 'https://plain.example.com' });
    const auth = { accessToken: tok };
    authMod.hydrateFromToken('cn-cli', auth);
    assert.equal(auth.enterpriseId, undefined);
    assert.equal(auth.domain, 'plain.example.com', 'domain 仍应取到');
  });

  test('已有字段不被 JWT 覆盖', () => {
    const tok = makeJwt({ sub: 'from-jwt', exp: 1, iss: 'https://sso-x.example.com' });
    const auth = { accessToken: tok, uid: 'explicit', enterpriseId: 'keep' };
    authMod.hydrateFromToken('cn-cli', auth);
    assert.equal(auth.uid, 'explicit');
    assert.equal(auth.enterpriseId, 'keep');
  });

  test('无 accessToken 时原样返回', () => {
    const auth = {};
    assert.deepEqual(authMod.hydrateFromToken('cn-cli', auth), {});
  });
});
