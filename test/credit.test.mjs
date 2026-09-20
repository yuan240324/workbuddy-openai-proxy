// 额度查询的适用性判断（回归）
//
// 背景：DeepSeek 官方站点协议不同，预设里没有 billingBase，
// 但 /status 与控制台原先无条件调用 queryCredit，导致拼出
// "undefined/v2/billing/meter/get-user-resource" 这种无效 URL，
// 并被当作「30s 超时或网络异常」上报 —— 把「该站点不适用」误报成网络故障。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-credit-'));
const { authPathFor, setConfigDir } = await import('../src/config.mjs');
setConfigDir(tmpDir);
const { supportsCreditQuery, queryCredit } = await import('../src/upstream.mjs');

const PORT = 18_000 + Math.floor(Math.random() * 1500);
const AUTH_FILE = authPathFor('cn-cli');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假上游：正常返回额度数据
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    code: 0,
    data: { Response: { Data: { Accounts: [{ PackageName: 'P', CycleCapacitySize: 0, CapacityRemain: 42 }] } } },
  }));
});

const mkCfg = (sites) => ({
  defaultSite: 'cn-cli',
  timeouts: { headerMs: 2000, idleMs: 2000, metaMs: 1000 },
  sites,
});

const WITH_BILLING = {
  label: 'T', enabled: true,
  apiBase: `http://127.0.0.1:${PORT}`,
  billingBase: `http://127.0.0.1:${PORT}`,
  origin: 'https://x.test', userAgent: 'T/1',
};
// 模拟 DeepSeek 官方站点：有 apiBase / origin，但没有 billingBase
const NO_BILLING = {
  label: 'DS', enabled: true, protocol: 'deepseek',
  apiBase: `http://127.0.0.1:${PORT}`,
  origin: 'https://chat.deepseek.com', userAgent: 'T/1',
};

before(async () => { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); });
beforeEach(() => {
  setConfigDir(tmpDir);
  const f = authPathFor('cn-cli');
  fs.writeFileSync(f, JSON.stringify({
    site: 'cn-cli', accessToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 86400_000, uid: 'u1',
  }, null, 2));
  const t = Date.now() / 1000 + 1;
  fs.utimesSync(f, t, t);
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('supportsCreditQuery：判断站点是否支持额度查询', () => {
  test('有 billingBase 的站点 → 支持', () => {
    const cfg = mkCfg({ 'cn-cli': WITH_BILLING });
    assert.equal(supportsCreditQuery(cfg, 'cn-cli'), true);
  });

  test('缺 billingBase 的站点（如 DeepSeek 官方）→ 不支持', () => {
    const cfg = mkCfg({ 'cn-cli': NO_BILLING });
    assert.equal(supportsCreditQuery(cfg, 'cn-cli'), false);
  });

  test('billingBase 为空串 / 纯空白 → 不支持', () => {
    for (const bad of ['', '   ']) {
      const cfg = mkCfg({ 'cn-cli': { ...WITH_BILLING, billingBase: bad } });
      assert.equal(supportsCreditQuery(cfg, 'cn-cli'), false, `"${bad}" 应视为不支持`);
    }
  });

  test('billingBase 非字符串 → 不支持', () => {
    for (const bad of [null, 123, {}, []]) {
      const cfg = mkCfg({ 'cn-cli': { ...WITH_BILLING, billingBase: bad } });
      assert.equal(supportsCreditQuery(cfg, 'cn-cli'), false);
    }
  });

  test('站点不存在时不抛错，返回 false', () => {
    const cfg = mkCfg({ 'cn-cli': WITH_BILLING });
    assert.equal(supportsCreditQuery(cfg, 'ghost'), false);
  });

  test('cfg.sites 缺失时不抛错', () => {
    assert.equal(supportsCreditQuery({}, 'cn-cli'), false);
  });
});

describe('queryCredit：不支持的站点应给出明确原因，而非伪装成网络故障', () => {
  test('缺 billingBase 时抛出「不支持额度查询」并带 501', async () => {
    const cfg = mkCfg({ 'cn-cli': NO_BILLING });
    const err = await queryCredit(cfg, 'cn-cli').catch((e) => e);
    assert.ok(err instanceof Error, '应抛错');
    assert.equal(err.status, 501);
    assert.match(err.message, /不支持额度查询/);
  });

  test('错误信息不得把配置问题说成超时（回归：曾报「30s 超时或网络异常」）', async () => {
    const cfg = mkCfg({ 'cn-cli': NO_BILLING });
    const err = await queryCredit(cfg, 'cn-cli').catch((e) => e);
    assert.ok(!/undefined/.test(err.message), `不应出现 undefined：${err.message}`);
    assert.ok(!/超时/.test(err.message), `不应说成超时：${err.message}`);
    assert.ok(!/网络异常/.test(err.message), `不应说成网络异常：${err.message}`);
  });

  test('不支持的站点不会真的发起网络请求（应立刻失败）', async () => {
    const cfg = mkCfg({ 'cn-cli': NO_BILLING });
    const t0 = Date.now();
    await queryCredit(cfg, 'cn-cli').catch(() => {});
    assert.ok(Date.now() - t0 < 500, '应在毫秒级失败，而不是等超时');
  });

  test('支持的站点照常返回额度（不受本次改动影响）', async () => {
    const cfg = mkCfg({ 'cn-cli': WITH_BILLING });
    const r = await queryCredit(cfg, 'cn-cli');
    assert.equal(r.remain, 42);
  });
});
