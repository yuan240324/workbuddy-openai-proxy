// loadConfig / getLastConfigIssues 集成测试：
// 验证「读文件 → 校验 → 修复 → 上报问题」这条链路，而不只是纯函数。
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-loadcfg-'));
const { setConfigDir, getConfigDir, paths, loadConfig, getLastConfigIssues, defaultConfig } = await import('../src/config.mjs');

const CFG = path.join(tmpDir, 'config.json');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 每个用例前把目录指回本文件的临时目录并清掉配置文件。
// 同进程可能还有别的测试文件也在切这个全局目录（见 auth/timeout 测试），
// 因此在用例边界上重新声明前提，使本文件不依赖执行顺序。
beforeEach(() => {
  setConfigDir(tmpDir);
  fs.rmSync(CFG, { force: true });
});

describe('loadConfig：首次运行自动生成配置', () => {
  test('config.json 缺失时创建并返回默认配置', () => {
    const cfg = loadConfig(tmpDir);
    assert.ok(fs.existsSync(CFG), '应自动落盘 config.json');
    assert.ok(cfg.apiKey.startsWith('sk-wb-'), '应生成随机本地密钥');
    assert.ok(cfg.port > 0);
  });

  test('自动生成的配置零问题', () => {
    loadConfig(tmpDir);
    assert.deepEqual(getLastConfigIssues(), []);
  });

  test('重复加载不会重新生成密钥', () => {
    const k1 = loadConfig(tmpDir).apiKey;
    const k2 = loadConfig(tmpDir).apiKey;
    assert.equal(k1, k2, '密钥必须稳定，否则每次重启客户端都要改配置');
  });
});

describe('loadConfig：坏值被修复并上报', () => {
  test('timeouts:null 被修复且问题可读', () => {
    fs.writeFileSync(CFG, JSON.stringify({ ...defaultConfig(), timeouts: null }));
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.timeouts.headerMs, 90000, '应回退为默认超时');
    const issues = getLastConfigIssues();
    assert.ok(issues.length > 0, '应上报问题');
    assert.ok(issues.some((m) => m.includes('timeouts')));
  });

  test('sites:null 被修复且恢复内置站点', () => {
    fs.writeFileSync(CFG, JSON.stringify({ ...defaultConfig(), sites: null }));
    const cfg = loadConfig(tmpDir);
    assert.ok(Object.keys(cfg.sites).length >= 3);
    assert.ok(getLastConfigIssues().some((m) => m.includes('sites')));
  });

  test('port 非法时回退并上报', () => {
    fs.writeFileSync(CFG, JSON.stringify({ ...defaultConfig(), port: 'abc' }));
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.port, 8788);
    assert.ok(getLastConfigIssues().some((m) => m.includes('port')));
  });

  test('多处问题一次性全部上报', () => {
    fs.writeFileSync(CFG, JSON.stringify({
      ...defaultConfig(), port: null, timeouts: { headerMs: 'x' }, stripFields: 'nope', defaultMaxTokens: -1,
    }));
    loadConfig(tmpDir);
    const issues = getLastConfigIssues();
    assert.ok(issues.length >= 4, `应至少上报 4 处，实际 ${issues.length}`);
  });

  test('问题列表是副本，外部修改不影响内部状态', () => {
    fs.writeFileSync(CFG, JSON.stringify({ ...defaultConfig(), port: 'x' }));
    loadConfig(tmpDir);
    const a = getLastConfigIssues();
    a.push('伪造的问题');
    assert.ok(!getLastConfigIssues().includes('伪造的问题'));
  });

  test('合法配置不产生任何问题（零行为变更）', () => {
    fs.writeFileSync(CFG, JSON.stringify(defaultConfig(), null, 2));
    loadConfig(tmpDir);
    assert.deepEqual(getLastConfigIssues(), [], '合法配置不应报告任何问题');
  });
});

describe('loadConfig：非法 JSON 的处理', () => {
  test('JSON 语法错误时抛出可识别错误（而不是静默重置用户文件）', () => {
    fs.writeFileSync(CFG, '{ "port": 8788, }'); // 尾逗号
    const before = fs.readFileSync(CFG, 'utf8');
    const err = (() => { try { loadConfig(tmpDir); return null; } catch (e) { return e; } })();
    assert.ok(err, '应抛出错误');
    assert.equal(err.code, 'INVALID_CONFIG_JSON');
    assert.equal(fs.readFileSync(CFG, 'utf8'), before, '绝不能覆盖用户文件');
  });

  test('空文件也按非法 JSON 处理且不覆盖', () => {
    fs.writeFileSync(CFG, '');
    const err = (() => { try { loadConfig(tmpDir); return null; } catch (e) { return e; } })();
    assert.ok(err);
    assert.equal(fs.readFileSync(CFG, 'utf8'), '', '不应写入内容');
  });
});

describe('旧版配置迁移', () => {
  test('upstream 字段迁移到 sites["cn-cli"]', () => {
    fs.writeFileSync(CFG, JSON.stringify({
      upstream: {
        apiBase: 'https://legacy.example.com',
        billingBase: 'https://legacy-bill.example.com',
        origin: 'https://legacy.example.com',
        userAgent: 'Legacy/1.0',
      },
    }));
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.sites['cn-cli'].apiBase, 'https://legacy.example.com');
    assert.equal(cfg.sites['cn-cli'].userAgent, 'Legacy/1.0');
  });

  test('迁移后 upstream 字段不再保留', () => {
    fs.writeFileSync(CFG, JSON.stringify({ upstream: { apiBase: 'https://x' } }));
    const cfg = loadConfig(tmpDir);
    assert.ok(!('upstream' in cfg));
  });
});

describe('配置目录切换（测试隔离机制本身）', () => {
  test('setConfigDir 改变 paths.config 与凭证路径', async () => {
    const { authPathFor } = await import('../src/config.mjs');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-other-'));
    const restore = setConfigDir(other);
    try {
      assert.ok(paths.config.startsWith(other));
      assert.ok(authPathFor('cn-cli').startsWith(other));
      assert.equal(getConfigDir(), other);
    } finally {
      restore();
      fs.rmSync(other, { recursive: true, force: true });
    }
    assert.notEqual(getConfigDir(), other, 'restore 应还原目录');
  });

  test('loadConfig(dir) 读取指定目录而不是全局目录', () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-d1-'));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-d2-'));
    fs.writeFileSync(path.join(d1, 'config.json'), JSON.stringify({ ...defaultConfig(), port: 1111 }));
    fs.writeFileSync(path.join(d2, 'config.json'), JSON.stringify({ ...defaultConfig(), port: 2222 }));

    // 不切全局目录，直接指定目录读取——这正是为了让测试免受同进程其他文件干扰
    const before = getConfigDir();
    const c1 = loadConfig(d1);
    const c2 = loadConfig(d2);

    assert.equal(c1.port, 1111);
    assert.equal(c2.port, 2222);
    // 关键保证：用完要还原，不能把全局目录留在 d1/d2 上
    assert.equal(getConfigDir(), before, 'loadConfig(dir) 必须还原全局目录');
    assert.notEqual(getConfigDir(), d1);
    assert.notEqual(getConfigDir(), d2);

    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  });

  test('loadConfig(dir) 对缺失目录会生成默认配置', () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-d3-'));
    const cfg = loadConfig(d3);
    assert.ok(fs.existsSync(path.join(d3, 'config.json')), '应在指定目录落盘');
    assert.ok(cfg.apiKey.startsWith('sk-wb-'));
    fs.rmSync(d3, { recursive: true, force: true });
  });
});
