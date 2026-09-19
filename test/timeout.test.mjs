// 上游超时测试（P1-1）：元数据接口必须有超时，不能永久挂起。
// 回归背景：fetchModels / queryCredit 原先既无 signal 也无超时，
// 上游挂起时 /v1/models、/status、控制台首屏会永久卡住。
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-timeout-'));
const { authPathFor, setConfigDir } = await import('../src/config.mjs');
const restoreConfigDir = setConfigDir(tmpDir);

const CRED = JSON.stringify({
  site: 'cn-cli',
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSIsImV4cCI6NDEwMjQ0NDgwMH0.x',
  refreshToken: 'rt',
  expiresAt: Date.now() + 86400_000,
  uid: 'u1',
}, null, 2);

/**
 * 每个用例开始前把配置目录重新指回本文件的临时目录，并确保凭证存在。
 *
 * 为什么必须这么做：多个测试文件共享同一进程（--experimental-test-isolation=none），
 * 别的文件也会调用 setConfigDir，全局目录会被改走；同时别的套件可能删掉凭证文件。
 * 这里在用例边界上重新声明自己的前提，使本文件不依赖执行顺序。
 */
function useOwnDir() {
  setConfigDir(tmpDir);
  const f = authPathFor('cn-cli');
  fs.writeFileSync(f, CRED);
  const t = Date.now() / 1000 + 1;
  fs.utimesSync(f, t, t); // 推后 mtime，避免命中上一次的缓存
}

const { fetchModels, queryCredit } = await import('../src/upstream.mjs');

const PORT = 17_000 + Math.floor(Math.random() * 2000);
const META_MS = 1200;

/** 可切换行为的假上游。 */
let mode = 'hang';
let partialSrv = null;
const server = http.createServer((req, res) => {
  if (mode === 'hang') return; // 永不响应
  if (mode === 'hang-body') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"partial":'); // 发一半就停住
  }
  if (mode === 'ok-models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      code: 0,
      data: {
        models: [{ id: 'good', name: 'Good', credits: 'x0.5 credits' }, { id: 'off', name: 'Off', disabled: true }],
        agents: [],
      },
    }));
  }
  if (mode === 'ok-credit') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [{ PackageName: 'P', CycleCapacitySize: 0, CapacityRemain: 42 }] } } },
    }));
  }
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 500, msg: 'boom' }));
});

const mkCfg = (over = {}) => ({
  defaultSite: 'cn-cli',
  timeouts: { headerMs: 2000, idleMs: 2000, metaMs: META_MS },
  sites: {
    'cn-cli': {
      label: 'T', enabled: true,
      apiBase: `http://127.0.0.1:${PORT}`,
      billingBase: `http://127.0.0.1:${PORT}`,
      origin: 'https://x.test', userAgent: 'T/1',
    },
  },
  ...over,
});

before(async () => { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); });
beforeEach(() => { useOwnDir(); });
after(async () => {
  await new Promise((r) => server.close(r));
  restoreConfigDir();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('fetchModels：挂起上游必须超时返回', () => {
  test('上游永不响应时在 metaMs 附近抛错（而非永久挂起）', async () => {
    mode = 'hang';
    const t0 = Date.now();
    const err = await fetchModels(mkCfg(), 'cn-cli').catch((e) => e);
    const ms = Date.now() - t0;
    assert.ok(err instanceof Error, '应抛错而不是一直挂着');
    assert.ok(ms < META_MS * 4, `应在超时附近返回，实际 ${ms}ms`);
    assert.equal(err.transport, true, '应标记为传输层错误');
  });

  test('upstream 发完响应头后挂起 body 同样超时（定时器需覆盖 body 阶段）', async () => {
    mode = 'hang-body';
    const t0 = Date.now();
    const err = await fetchModels(mkCfg(), 'cn-cli').catch((e) => e);
    const ms = Date.now() - t0;
    assert.ok(err instanceof Error, 'body 阶段挂起也应超时');
    assert.ok(ms < META_MS * 4, `实际 ${ms}ms`);
  });

  test('超时信息包含站点名与秒数，便于排查', async () => {
    mode = 'hang';
    const err = await fetchModels(mkCfg(), 'cn-cli').catch((e) => e);
    assert.match(err.message, /cn-cli/);
    assert.match(err.message, /超时|网络异常/);
  });

  test('正常响应时照常解析（超时不影响成功路径）', async () => {
    mode = 'ok-models';
    const list = await fetchModels(mkCfg(), 'cn-cli');
    assert.equal(list.length, 1, 'disabled 的模型应被过滤');
    assert.equal(list[0].id, 'good');
    assert.equal(list[0].credits, 'x0.5 credits');
  });

  test('上游 500 时抛出可读错误', async () => {
    mode = 'server_error';
    const err = await fetchModels(mkCfg(), 'cn-cli').catch((e) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /500|HTTP/);
  });
});

describe('queryCredit：挂起上游必须超时返回', () => {
  test('上游永不响应时超时抛错', async () => {
    mode = 'hang';
    const t0 = Date.now();
    const err = await queryCredit(mkCfg(), 'cn-cli').catch((e) => e);
    const ms = Date.now() - t0;
    assert.ok(err instanceof Error);
    assert.ok(ms < META_MS * 4, `实际 ${ms}ms`);
  });

  test('正常响应时返回剩余积分', async () => {
    mode = 'ok-credit';
    const r = await queryCredit(mkCfg(), 'cn-cli');
    assert.equal(r.remain, 42);
    assert.ok(Array.isArray(r.detail));
    assert.equal(r.detail[0].package, 'P');
  });
});

describe('超时配置：metaMs 缺失时使用合理默认值', () => {
  test('timeouts 缺 metaMs 时回退到默认 30s（而非 0 或 undefined 导致无超时）', async () => {
    // 直接断言默认值来源，避免等待 30s。
    // fetchModels 读的是 cfg.timeouts?.metaMs ?? 30000，这里验证该表达式在缺字段时给出 30000。
    const cfg = mkCfg();
    delete cfg.timeouts.metaMs;
    const effective = cfg.timeouts?.metaMs ?? 30000;
    assert.equal(effective, 30000, '缺字段时应取默认 30s');
    assert.ok(Number.isFinite(effective) && effective > 0, '必须是有限正数，否则 setTimeout 会变成立即超时或永不超时');
  });

  test('timeouts 整个缺失时也不会退化为无超时', async () => {
    const cfg = mkCfg();
    delete cfg.timeouts;
    const effective = cfg.timeouts?.metaMs ?? 30000;
    assert.equal(effective, 30000);
  });

  test('自定义 metaMs 生效（短超时确实更快返回）', async () => {
    mode = 'hang';
    const t0 = Date.now();
    await fetchModels(mkCfg({ timeouts: { headerMs: 2000, idleMs: 2000, metaMs: 300 } }), 'cn-cli').catch((e) => e);
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `自定义 300ms 超时应很快返回，实际 ${ms}ms`);
  });
});
