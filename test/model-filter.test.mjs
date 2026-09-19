// 模型白/黑名单与错误提示准确性（回归）
//
// 背景：isExcluded 同时管 allowModels 白名单与 excludeModels 黑名单，
// 但原先的 404 提示一律说「在剔除名单里（config.json 的 excludeModels）」。
// 当真正原因是白名单没命中（excludeModels 为空）时，用户会被引去改无关配置。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isExcluded, explainExcluded } from '../src/router.mjs';

const mkCfg = (over = {}) => ({
  allowModels: [],
  excludeModels: [],
  sites: { 'cn-cli': { enabled: true }, 'site-b': { enabled: true } },
  ...over,
});

describe('isExcluded：白名单与黑名单', () => {
  test('无任何配置时全部放行', () => {
    const cfg = mkCfg();
    assert.equal(isExcluded(cfg, 'cn-cli', 'anything'), false);
  });

  test('allowModels 非空时，未命中的被排除', () => {
    const cfg = mkCfg({ allowModels: ['glm-*'] });
    assert.equal(isExcluded(cfg, 'cn-cli', 'glm-5.3'), false);
    assert.equal(isExcluded(cfg, 'cn-cli', 'kimi-k3'), true);
  });

  test('excludeModels 命中的被排除', () => {
    const cfg = mkCfg({ excludeModels: ['kimi-*'] });
    assert.equal(isExcluded(cfg, 'cn-cli', 'kimi-k3'), true);
    assert.equal(isExcluded(cfg, 'cn-cli', 'glm-5.3'), false);
  });

  test('站点级配置与全局叠加', () => {
    const cfg = mkCfg({ sites: { 'cn-cli': { enabled: true, excludeModels: ['x-*'] } } });
    assert.equal(isExcluded(cfg, 'cn-cli', 'x-1'), true);
    assert.equal(isExcluded(cfg, 'cn-cli', 'y-1'), false);
  });

  test('通配符前缀匹配', () => {
    const cfg = mkCfg({ allowModels: ['glm-5*'] });
    assert.equal(isExcluded(cfg, 'cn-cli', 'glm-5.3'), false);
    assert.equal(isExcluded(cfg, 'cn-cli', 'glm-5.2'), false);
    assert.equal(isExcluded(cfg, 'cn-cli', 'kimi-k3'), true);
    assert.equal(isExcluded(cfg, 'cn-cli', 'hy3'), true);
  });
});

describe('explainExcluded：必须指出真实原因', () => {
  test('可用时返回 null', () => {
    assert.equal(explainExcluded(mkCfg(), 'cn-cli', 'm'), null);
  });

  test('原因是白名单没命中时，说 allowModels 而不是 excludeModels', () => {
    const cfg = mkCfg({ allowModels: ['glm-5*', 'hy*'] });
    const why = explainExcluded(cfg, 'site-b', 'kimi-k3');
    assert.ok(why, '应给出原因');
    assert.match(why, /allowModels/, '应指向 allowModels');
    assert.ok(!/excludeModels/.test(why), `不应误指 excludeModels：${why}`);
  });

  test('原因提示里带上当前白名单内容，便于直接对照', () => {
    const cfg = mkCfg({ allowModels: ['glm-*'] });
    const why = explainExcluded(cfg, 'cn-cli', 'kimi-k3');
    assert.match(why, /glm-\*/);
  });

  test('原因是黑名单命中时，说 excludeModels', () => {
    const cfg = mkCfg({ excludeModels: ['kimi-*'] });
    const why = explainExcluded(cfg, 'cn-cli', 'kimi-k3');
    assert.ok(why);
    assert.match(why, /excludeModels/);
    assert.ok(!/allowModels/.test(why), `不应误指 allowModels：${why}`);
  });

  test('白名单通过但黑名单命中 → 报黑名单', () => {
    const cfg = mkCfg({ allowModels: ['kimi-*'], excludeModels: ['kimi-k3'] });
    const why = explainExcluded(cfg, 'cn-cli', 'kimi-k3');
    assert.match(why, /excludeModels/);
  });

  test('站点级白名单同样被识别', () => {
    const cfg = mkCfg({ sites: { 'cn-cli': { enabled: true, allowModels: ['a-*'] } } });
    const why = explainExcluded(cfg, 'cn-cli', 'b-1');
    assert.match(why, /allowModels/);
  });

  test('真实场景：白名单只放行部分前缀，其余站点的模型全部被挡', () => {
    // 复现线上 config：allowModels = ["glm-5*","hy*"]
    const cfg = mkCfg({ allowModels: ['glm-5*', 'hy*'] });
    for (const id of ['kimi-k3', 'minimax-m3', 'claude-sonnet-4.6']) {
      assert.equal(isExcluded(cfg, 'site-b', id), true, `${id} 应被排除`);
      assert.match(explainExcluded(cfg, 'site-b', id), /allowModels/);
    }
    // 而命中的前缀是放行的
    assert.equal(isExcluded(cfg, 'cn-cli', 'glm-5.3'), false);
    assert.equal(isExcluded(cfg, 'cn-cli', 'hy3'), false);
  });
});
