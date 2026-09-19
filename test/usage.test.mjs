// 用量统计测试（P1-2 的余额节流 + 基础聚合）
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离到临时目录（用 setConfigDir 而非环境变量，理由见 auth.test.mjs）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usage-'));
const { setConfigDir } = await import('../src/config.mjs');
const usage = await import('../src/usage.mjs');

// 同进程其他测试文件也会切这个全局目录（auth / timeout / config-load），
// 因此每个用例前重新声明本文件的前提，保证与执行顺序无关。
beforeEach(() => { setConfigDir(tmpDir); });

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recordBalance：采样与节流（P1-2）', () => {
  test('首次记录会写入一条', () => {
    usage.resetUsage();
    usage.recordBalance('site-a', 100);
    const list = usage.usageSnapshot(1).balance['site-a'];
    assert.equal(list.length, 1);
    assert.equal(list[0].v, 100);
  });

  test('相同值不重复记录', () => {
    usage.resetUsage();
    usage.recordBalance('site-b', 50);
    usage.recordBalance('site-b', 50);
    usage.recordBalance('site-b', 50);
    assert.equal(usage.usageSnapshot(1).balance['site-b'].length, 1);
  });

  test('60 秒内的不同值被节流（回归：原先死代码导致每次都写）', () => {
    usage.resetUsage();
    usage.recordBalance('site-c', 100);
    usage.recordBalance('site-c', 99);
    usage.recordBalance('site-c', 98);
    usage.recordBalance('site-c', 97);
    const list = usage.usageSnapshot(1).balance['site-c'];
    assert.equal(list.length, 1, `60s 内应只留 1 条，实际 ${list.length}`);
  });

  test('非数字值被忽略', () => {
    usage.resetUsage();
    for (const bad of ['100', null, undefined, {}, [], NaN, Infinity, -Infinity]) {
      usage.recordBalance('site-d', bad);
    }
    const list = usage.usageSnapshot(1).balance['site-d'];
    assert.ok(!list || list.length === 0, '非法值不应写入');
  });

  test('不同站点各自独立计数', () => {
    usage.resetUsage();
    usage.recordBalance('s1', 10);
    usage.recordBalance('s2', 20);
    const b = usage.usageSnapshot(1).balance;
    assert.equal(b.s1.length, 1);
    assert.equal(b.s2.length, 1);
  });

  test('数组长度上限 500（防止长期运行无限增长）', () => {
    usage.resetUsage();
    const list = usage.usageSnapshot(1).balance['site-e'] || (usage.usageSnapshot(1).balance['site-e'] = []);
    // 直接灌入 600 条伪造历史（时间戳跨过节流窗口）
    const now = Date.now();
    for (let i = 0; i < 600; i++) list.push({ t: now - (600 - i) * 120_000, v: i });
    usage.recordBalance('site-e', 99999);
    const after = usage.usageSnapshot(1).balance['site-e'];
    assert.ok(after.length <= 500, `长度应被裁剪到 500，实际 ${after.length}`);
  });
});

describe('recordUsage：调用统计', () => {
  test('成功调用计入 calls 而非 errors', () => {
    usage.resetUsage();
    usage.recordUsage({ site: 's', model: 'm', mode: 'json', status: 200, promptTokens: 10, completionTokens: 5, credit: 1.5 });
    const t = usage.usageSnapshot(7).today;
    assert.equal(t.calls, 1);
    assert.equal(t.errors, 0);
    assert.equal(t.promptTokens, 10);
    assert.equal(t.completionTokens, 5);
    assert.equal(t.credit, 1.5);
  });

  test('4xx/5xx 计入 errors', () => {
    usage.resetUsage();
    usage.recordUsage({ site: 's', model: 'm', mode: 'json', status: 500 });
    usage.recordUsage({ site: 's', model: 'm', mode: 'json', status: 401 });
    usage.recordUsage({ site: 's', model: 'm', mode: 'json', status: 200 });
    const t = usage.usageSnapshot(7).today;
    assert.equal(t.calls, 3);
    assert.equal(t.errors, 2);
  });

  test('按模型聚合', () => {
    usage.resetUsage();
    usage.recordUsage({ site: 's', model: 'a', mode: 'json', status: 200, credit: 2 });
    usage.recordUsage({ site: 's', model: 'a', mode: 'json', status: 200, credit: 3 });
    usage.recordUsage({ site: 's', model: 'b', mode: 'json', status: 200, credit: 1 });
    const byModel = usage.usageSnapshot(7).byModel;
    const a = byModel.find((m) => m.model === 'a');
    assert.equal(a.calls, 2);
    assert.equal(a.credit, 5);
  });

  test('缺省参数不产生 NaN', () => {
    usage.resetUsage();
    usage.recordUsage({ site: 's', model: 'm', mode: 'json', status: 200 });
    const t = usage.usageSnapshot(7).today;
    assert.ok(Number.isFinite(t.promptTokens));
    assert.ok(Number.isFinite(t.credit));
  });
});

describe('resetUsage / usageSnapshot', () => {
  test('重置后统计归零', () => {
    usage.recordUsage({ site: 's', model: 'm', mode: 'json', status: 200 });
    usage.resetUsage();
    const snap = usage.usageSnapshot(7);
    assert.equal(snap.totals.calls, 0);
    assert.deepEqual(snap.balance, {});
  });

  test('快照包含必要字段', () => {
    usage.resetUsage();
    const snap = usage.usageSnapshot(7);
    for (const k of ['today', 'todayByModel', 'recent', 'totals', 'byModel', 'balance', 'since']) {
      assert.ok(k in snap, `缺少字段 ${k}`);
    }
  });
});
