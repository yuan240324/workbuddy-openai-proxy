// 配置校验测试：确保坏配置被安全降级，且合法配置零改动。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultConfig, validateConfig, authKeys, primaryKey } from '../src/config.mjs';

/** 造一份合法配置（每次独立，避免测试间串扰）。 */
const good = () => defaultConfig();

describe('validateConfig：合法配置不应被改动', () => {
  test('默认配置通过校验且零问题', () => {
    const cfg = good();
    const before = JSON.stringify(cfg);
    const issues = validateConfig(cfg);
    assert.deepEqual(issues, [], '默认配置不应产生任何问题');
    assert.equal(JSON.stringify(cfg), before, '合法配置不得被修改');
  });

  test('用户自定义的合法值被原样保留', () => {
    const cfg = good();
    cfg.host = '127.0.0.1';
    cfg.port = 9999;
    cfg.apiKey = 'sk-wb-mykey';
    cfg.defaultModel = 'glm-5.3';
    cfg.defaultSite = 'intl-cli';
    cfg.defaultMaxTokens = 4096;
    cfg.timeouts = { headerMs: 1000, idleMs: 2000, metaMs: 3000 };
    cfg.modelAliases = { fast: 'hy3' };
    cfg.stripFields = ['presence_penalty'];
    const issues = validateConfig(cfg);
    assert.deepEqual(issues, []);
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.defaultModel, 'glm-5.3');
    assert.equal(cfg.defaultSite, 'intl-cli');
    assert.equal(cfg.timeouts.headerMs, 1000);
    assert.deepEqual(cfg.stripFields, ['presence_penalty']);
  });
});

describe('validateConfig：端口与监听地址', () => {
  const cases = [
    ['字符串端口', 'abc'],
    ['null 端口', null],
    ['对象端口', {}],
    ['负数端口', -1],
    ['超出范围', 70000],
    ['小数端口', 80.5],
  ];
  for (const [name, port] of cases) {
    test(`${name}（${JSON.stringify(port)}）回退为 8788`, () => {
      const cfg = good();
      cfg.port = port;
      const issues = validateConfig(cfg);
      assert.equal(cfg.port, 8788, '应回退为默认端口');
      assert.ok(issues.some((m) => m.includes('port')), '应报告 port 问题');
    });
  }

  test('端口 0（随机端口）是合法的', () => {
    const cfg = good();
    cfg.port = 0;
    assert.deepEqual(validateConfig(cfg), []);
    assert.equal(cfg.port, 0);
  });

  test('空 host 回退为 127.0.0.1', () => {
    const cfg = good();
    cfg.host = '   ';
    assert.ok(validateConfig(cfg).some((m) => m.includes('host')));
    assert.equal(cfg.host, '127.0.0.1');
  });
});

describe('validateConfig：timeouts（原先 null 会让所有对话 500）', () => {
  test('timeouts 为 null 时整体回退', () => {
    const cfg = good();
    cfg.timeouts = null;
    const issues = validateConfig(cfg);
    assert.deepEqual(cfg.timeouts, { headerMs: 90000, idleMs: 300000, metaMs: 30000 });
    assert.ok(issues.some((m) => m.includes('timeouts')));
  });

  test('单项为字符串时只回退该项，其余保留', () => {
    const cfg = good();
    cfg.timeouts = { headerMs: 'abc', idleMs: 1234, metaMs: 5000 };
    const issues = validateConfig(cfg);
    assert.equal(cfg.timeouts.headerMs, 90000, '坏值回退');
    assert.equal(cfg.timeouts.idleMs, 1234, '好值保留');
    assert.equal(cfg.timeouts.metaMs, 5000, '好值保留');
    assert.equal(issues.length, 1, '只应报告 1 处问题');
  });

  test('0 与负数视为非法（超时必须为正）', () => {
    for (const bad of [0, -5]) {
      const cfg = good();
      cfg.timeouts = { ...cfg.timeouts, metaMs: bad };
      validateConfig(cfg);
      assert.equal(cfg.timeouts.metaMs, 30000);
    }
  });

  test('校验后 openChat 需要的字段一定存在（回归：曾抛 Cannot read properties of null）', () => {
    const cfg = good();
    cfg.timeouts = null;
    validateConfig(cfg);
    // 模拟 upstream.mjs 的读取方式
    assert.doesNotThrow(() => {
      const ms = cfg.timeouts.headerMs;
      if (!Number.isFinite(ms)) throw new Error('bad');
    });
  });
});

describe('validateConfig：sites（原先 null 会让站点静默消失）', () => {
  test('sites 为 null 时回退为内置预设', () => {
    const cfg = good();
    cfg.sites = null;
    const issues = validateConfig(cfg);
    assert.ok(Object.keys(cfg.sites).length >= 3, '应恢复内置站点');
    // 至少覆盖三个 CodeBuddy 站点（DeepSeek 官方站点也内置，但不强制其存在）
    for (const s of ['cn-cli', 'intl-cli', 'intl-work']) {
      assert.ok(cfg.sites[s], `应恢复内置站点 ${s}`);
    }
    assert.ok(issues.some((m) => m.includes('sites')));
  });

  test('单个站点为 null 时移除该站点', () => {
    const cfg = good();
    cfg.sites['bad-site'] = null;
    const issues = validateConfig(cfg);
    assert.ok(!('bad-site' in cfg.sites), '应移除坏站点');
    assert.ok(issues.some((m) => m.includes('bad-site')));
  });

  test('站点缺 apiBase 时回退为预设值', () => {
    const cfg = good();
    cfg.sites['cn-cli'].apiBase = '';
    validateConfig(cfg);
    assert.equal(cfg.sites['cn-cli'].apiBase, 'https://copilot.tencent.com');
  });

  test('站点全部被移除时兜底回内置预设（避免无站点可用）', () => {
    const cfg = good();
    cfg.sites = { x: null, y: 123 };
    validateConfig(cfg);
    assert.ok(Object.keys(cfg.sites).length >= 3, '不应留下空站点表');
    assert.ok(cfg.sites['cn-cli']);
  });

  test('enabled 非布尔值时回退为 true', () => {
    const cfg = good();
    cfg.sites['cn-cli'].enabled = 'yes';
    validateConfig(cfg);
    assert.equal(cfg.sites['cn-cli'].enabled, true);
  });
});

describe('validateConfig：defaultSite 必须指向可用站点', () => {
  test('指向不存在的站点时改用第一个可用站点', () => {
    const cfg = good();
    cfg.defaultSite = 'not-exist';
    const issues = validateConfig(cfg);
    assert.ok(cfg.sites[cfg.defaultSite], 'defaultSite 必须真实存在');
    assert.ok(issues.some((m) => m.includes('defaultSite')));
  });

  test('指向已禁用的站点时改用其他可用站点', () => {
    const cfg = good();
    cfg.sites['cn-cli'].enabled = false;
    cfg.defaultSite = 'cn-cli';
    validateConfig(cfg);
    assert.notEqual(cfg.defaultSite, 'cn-cli');
    assert.notEqual(cfg.sites[cfg.defaultSite].enabled, false);
  });
});

describe('validateConfig：apiKey 与模型', () => {
  test('apiKey 为空串被视为"未配置"而非报错', () => {
    const cfg = good();
    cfg.apiKey = '';
    const issues = validateConfig(cfg);
    assert.equal(cfg.apiKey, '');
    assert.deepEqual(issues, [], '空密钥是允许的状态，不算配置错误');
  });

  test('apiKey 非字符串时回退为空串', () => {
    const cfg = good();
    cfg.apiKey = { nested: true };
    validateConfig(cfg);
    assert.equal(cfg.apiKey, '');
  });

  test('apiKey 可以是字符串数组，数组里每个都保留', () => {
    const cfg = good();
    cfg.apiKey = ['sk-a', 'sk-b'];
    const issues = validateConfig(cfg);
    assert.deepEqual(cfg.apiKey, ['sk-a', 'sk-b']);
    assert.deepEqual(issues, [], '合法数组不算配置错误');
  });

  test('apiKey 数组：去重、trim、丢空串与非字符串', () => {
    const cfg = good();
    cfg.apiKey = ['sk-a', '  sk-b  ', 'sk-a', '', '   ', 123, null, 'sk-b'];
    validateConfig(cfg);
    assert.deepEqual(cfg.apiKey, ['sk-a', 'sk-b']);
  });

  test('apiKey 空数组 = 未配置', () => {
    const cfg = good();
    cfg.apiKey = [];
    validateConfig(cfg);
    assert.deepEqual(cfg.apiKey, []);
    assert.equal(authKeys(cfg).length, 0);
    assert.equal(primaryKey(cfg), '', '未配置时主密钥为空串');
  });

  test('authKeys / primaryKey：字符串形式会 trim', () => {
    const cfg = good();
    cfg.apiKey = '  sk-only  ';
    assert.deepEqual(authKeys(cfg), ['sk-only']);
    assert.equal(primaryKey(cfg), 'sk-only');
  });

  test('authKeys / primaryKey：数组形式取第一个当主密钥', () => {
    const cfg = good();
    cfg.apiKey = ['sk-main', 'sk-demo', 'sk-third'];
    assert.deepEqual(authKeys(cfg), ['sk-main', 'sk-demo', 'sk-third']);
    assert.equal(primaryKey(cfg), 'sk-main');
  });

  test('authKeys 面对坏输入不抛异常，返回空数组', () => {
    assert.deepEqual(authKeys(null), []);
    assert.deepEqual(authKeys({}), []);
    assert.deepEqual(authKeys({ apiKey: { x: 1 } }), []);
    assert.deepEqual(authKeys({ apiKey: [null, 42, ''] }), []);
    assert.deepEqual(primaryKey({ apiKey: [] }), '');
  });

  test('defaultModel 为空时回退', () => {
    const cfg = good();
    cfg.defaultModel = '  ';
    validateConfig(cfg);
    assert.equal(cfg.defaultModel, 'deepseek-v4-pro');
  });

  test('defaultMaxTokens 非法时回退', () => {
    for (const bad of ['big', 0, -1, null]) {
      const cfg = good();
      cfg.defaultMaxTokens = bad;
      validateConfig(cfg);
      assert.equal(cfg.defaultMaxTokens, 16384);
    }
  });
});

describe('validateConfig：数组与对象字段', () => {
  test('stripFields 必须是数组', () => {
    const cfg = good();
    cfg.stripFields = 'presence_penalty';
    validateConfig(cfg);
    assert.deepEqual(cfg.stripFields, []);
  });

  test('stripFields 里的非字符串项被剔除', () => {
    const cfg = good();
    cfg.stripFields = ['ok', 123, null, 'fine'];
    const issues = validateConfig(cfg);
    assert.deepEqual(cfg.stripFields, ['ok', 'fine']);
    assert.ok(issues.some((m) => m.includes('stripFields')));
  });

  test('modelAliases / modelRoutes / models 类型错误时回退', () => {
    const cfg = good();
    cfg.modelAliases = [];
    cfg.modelRoutes = 'x';
    cfg.models = 'y';
    validateConfig(cfg);
    assert.deepEqual(cfg.modelAliases, {});
    assert.deepEqual(cfg.modelRoutes, {});
    assert.ok(Array.isArray(cfg.models));
  });

  test('modelRoutes 指向不存在的站点时移除该路由', () => {
    const cfg = good();
    cfg.modelRoutes = { 'glm-5.3': 'ghost-site', 'hy3': 'cn-cli' };
    const issues = validateConfig(cfg);
    assert.ok(!('glm-5.3' in cfg.modelRoutes), '坏路由应被移除');
    assert.equal(cfg.modelRoutes['hy3'], 'cn-cli', '好路由应保留');
    assert.ok(issues.some((m) => m.includes('glm-5.3')));
  });

  test('modelAliases 值非字符串时移除该别名', () => {
    const cfg = good();
    cfg.modelAliases = { good: 'hy3', bad: 123 };
    validateConfig(cfg);
    assert.equal(cfg.modelAliases.good, 'hy3');
    assert.ok(!('bad' in cfg.modelAliases));
  });
});

describe('validateConfig：多问题汇总', () => {
  test('同时存在多个问题时全部修复并逐条报告', () => {
    const cfg = good();
    cfg.port = 'abc';
    cfg.timeouts = null;
    cfg.sites = null;
    cfg.stripFields = 'nope';
    cfg.defaultMaxTokens = -1;
    const issues = validateConfig(cfg);
    assert.ok(issues.length >= 5, `应报告至少 5 个问题，实际 ${issues.length}`);
    // 修复后必须是一份可正常工作的配置
    assert.equal(cfg.port, 8788);
    assert.ok(cfg.timeouts.headerMs > 0);
    assert.ok(Object.keys(cfg.sites).length > 0);
    assert.deepEqual(cfg.stripFields, []);
    assert.equal(cfg.defaultMaxTokens, 16384);
  });

  test('返回的问题描述是可读字符串', () => {
    const cfg = good();
    cfg.port = null;
    const issues = validateConfig(cfg);
    assert.ok(issues.every((m) => typeof m === 'string' && m.length > 0));
  });
});
