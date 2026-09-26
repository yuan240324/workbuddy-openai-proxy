// resolveTarget 路由优先级测试。
// 只覆盖「不需要访问上游目录」的分支（显式前缀 / 别名 / 路由表 / 默认值），
// 这些分支不触发网络与凭证读取，因此可以稳定单测。
// 目录匹配分支需要真实上游，不在单测范围内——它和降级选站共用的排序逻辑
// 已抽成纯函数 rankSiteCandidates，在文件末尾单独覆盖。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, rankSiteCandidates } from '../src/router.mjs';

function mkCfg(over = {}) {
  return {
    defaultSite: 'cn-cli',
    defaultModel: 'deepseek-v4-pro',
    modelAliases: {},
    modelRoutes: {},
    sites: {
      'cn-cli': { enabled: true },
      'intl-cli': { enabled: true },
      'intl-work': { enabled: true },
      'disabled-site': { enabled: false },
    },
    ...over,
  };
}

describe('resolveTarget：显式站点前缀', () => {
  test('intl-cli/glm-5.3 拆成站点与模型', async () => {
    const r = await resolveTarget(mkCfg(), 'intl-cli/glm-5.3');
    assert.equal(r.site, 'intl-cli');
    assert.equal(r.model, 'glm-5.3');
    assert.equal(r.requested, 'intl-cli/glm-5.3');
  });

  test('cn-cli/hy3', async () => {
    const r = await resolveTarget(mkCfg(), 'cn-cli/hy3');
    assert.equal(r.site, 'cn-cli');
    assert.equal(r.model, 'hy3');
  });

  test('已禁用的站点前缀 → 明确报「站点已禁用」，不再当成模型名', async () => {
    // 原先会静默把它整体当作模型名，最终在上游报出难懂的 "model not found"；
    // 现在直接说明真实原因（站点存在但被 config.json 禁用）。
    const err = await resolveTarget(mkCfg(), 'disabled-site/hy3').catch((e) => e);
    assert.ok(err instanceof Error, '应抛错');
    assert.equal(err.status, 404);
    assert.match(err.message, /disabled-site/);
    assert.match(err.message, /已禁用/);
  });

  test('未知前缀整体作为模型名（与「已禁用」区分：模型 ID 本身可含斜杠）', async () => {
    const r = await resolveTarget(mkCfg(), 'unknown-site/hy3');
    assert.notEqual(r.site, 'unknown-site');
    assert.equal(r.model, 'unknown-site/hy3');
  });

  test('模型名本身含斜杠但前缀非站点时不拆分', async () => {
    const r = await resolveTarget(mkCfg(), 'org/model-name');
    assert.equal(r.model, 'org/model-name');
  });

  test('模型名前有斜杠（空前缀）不拆分', async () => {
    const r = await resolveTarget(mkCfg(), '/hy3');
    assert.equal(r.model, '/hy3');
  });

  test('站点前缀可指定与默认不同的站点', async () => {
    const r = await resolveTarget(mkCfg(), 'intl-work/auto');
    assert.equal(r.site, 'intl-work');
    assert.equal(r.model, 'auto');
  });
});

describe('resolveTarget：别名', () => {
  test('简单别名映射到模型名', async () => {
    const cfg = mkCfg({ modelAliases: { fast: 'hy3' } });
    const r = await resolveTarget(cfg, 'fast');
    assert.equal(r.model, 'hy3');
    assert.equal(r.requested, 'fast', 'requested 应保留原始请求名');
  });

  test('别名值是「站点/模型」时同时指定站点', async () => {
    const cfg = mkCfg({ modelAliases: { claude: 'intl-cli/claude-sonnet-4.6' } });
    const r = await resolveTarget(cfg, 'claude');
    assert.equal(r.site, 'intl-cli');
    assert.equal(r.model, 'claude-sonnet-4.6');
  });

  test('别名指向已禁用站点 → 同样报「站点已禁用」', async () => {
    const cfg = mkCfg({ modelAliases: { x: 'disabled-site/foo' } });
    const err = await resolveTarget(cfg, 'x').catch((e) => e);
    assert.ok(err instanceof Error, '应抛错');
    assert.match(err.message, /已禁用/);
    assert.match(err.message, /disabled-site/);
  });
});

describe('resolveTarget：default / current 虚拟模型', () => {
  test('default 解析为 defaultModel', async () => {
    const r = await resolveTarget(mkCfg(), 'default');
    assert.equal(r.model, 'deepseek-v4-pro');
  });

  test('current 同义', async () => {
    const r = await resolveTarget(mkCfg(), 'current');
    assert.equal(r.model, 'deepseek-v4-pro');
  });

  test('大小写不敏感', async () => {
    assert.equal((await resolveTarget(mkCfg(), 'DEFAULT')).model, 'deepseek-v4-pro');
    assert.equal((await resolveTarget(mkCfg(), 'Current')).model, 'deepseek-v4-pro');
  });

  test('modelAliases 显式覆盖 default 时以覆盖为准', async () => {
    const cfg = mkCfg({ modelAliases: { default: 'glm-5.3' } });
    const r = await resolveTarget(cfg, 'default');
    assert.equal(r.model, 'glm-5.3');
  });
});

describe('resolveTarget：空模型名', () => {
  test('空字符串 → 默认模型', async () => {
    assert.equal((await resolveTarget(mkCfg(), '')).model, 'deepseek-v4-pro');
  });

  test('undefined → 默认模型', async () => {
    assert.equal((await resolveTarget(mkCfg(), undefined)).model, 'deepseek-v4-pro');
  });

  test('null → 默认模型', async () => {
    assert.equal((await resolveTarget(mkCfg(), null)).model, 'deepseek-v4-pro');
  });

  test('纯空白 → 默认模型', async () => {
    assert.equal((await resolveTarget(mkCfg(), '   ')).model, 'deepseek-v4-pro');
  });

  test('前后空白被裁剪', async () => {
    const r = await resolveTarget(mkCfg(), '  hy3  ');
    assert.equal(r.model, 'hy3');
  });
});

describe('resolveTarget：显式路由表', () => {
  test('modelRoutes 指定站点', async () => {
    const cfg = mkCfg({ modelRoutes: { hy3: 'intl-cli' } });
    const r = await resolveTarget(cfg, 'hy3');
    assert.equal(r.site, 'intl-cli');
    assert.equal(r.model, 'hy3');
  });

  test('路由指向不存在的站点时忽略该路由', async () => {
    const cfg = mkCfg({ modelRoutes: { hy3: 'ghost' } });
    const r = await resolveTarget(cfg, 'hy3');
    assert.notEqual(r.site, 'ghost');
  });

  test('未在路由表中的模型落到默认站点', async () => {
    const cfg = mkCfg({ modelRoutes: { hy3: 'intl-cli' } });
    const r = await resolveTarget(cfg, 'unknown-model-xyz');
    assert.equal(r.site, 'cn-cli', '应回落到默认站点');
  });
});

describe('resolveTarget：返回结构', () => {
  test('始终返回 site / model / requested 三个字段', async () => {
    const r = await resolveTarget(mkCfg(), 'hy3');
    assert.ok('site' in r && 'model' in r && 'requested' in r);
    assert.equal(typeof r.site, 'string');
    assert.equal(typeof r.model, 'string');
  });

  test('优先级：显式前缀 > 别名', async () => {
    const cfg = mkCfg({ modelAliases: { 'intl-work/auto': 'hy3' } });
    // 前缀写法应走前缀分支，而不是别名分支
    const r = await resolveTarget(cfg, 'intl-work/auto');
    assert.equal(r.site, 'intl-work');
    assert.equal(r.model, 'auto');
  });
});

describe('rankSiteCandidates：选站排序（降级目标与目录匹配共用）', () => {
  test('还有可用账号的站点优先，即使它的倍率更高', () => {
    // 回归：请求首发 intl-cli 拿到 429，降级目标曾算成同样 429 的 cn-cli，
    // 原因是只比倍率——cn-cli 的倍率有限，而 intl-work 是内置清单（倍率 Infinity）。
    // 结果是从一个死站换到另一个死站，真正有额度的站点没被考虑。
    const 排序 = rankSiteCandidates(
      [
        { site: 'cn-cli', mult: 0.8, usable: false },
        { site: 'intl-work', mult: Infinity, usable: true },
      ],
      'cn-cli',
    );
    assert.equal(排序[0].site, 'intl-work');
  });

  test('都还有可用账号时按倍率升序', () => {
    const 排序 = rankSiteCandidates(
      [
        { site: 'a', mult: 1.5, usable: true },
        { site: 'b', mult: 0.7, usable: true },
      ],
      'a',
    );
    assert.equal(排序[0].site, 'b');
  });

  test('都没有可用账号时退回按倍率排序（保持改动前的行为）', () => {
    // 额度可能已经重置，所以「全都不可用」时不能变成不发请求，
    // 排序结果必须与改动前一致。
    const 排序 = rankSiteCandidates(
      [
        { site: 'a', mult: 1.5, usable: false },
        { site: 'b', mult: 0.7, usable: false },
      ],
      'a',
    );
    assert.equal(排序[0].site, 'b');
  });

  test('倍率未知（Infinity，内置清单没有 credits）排在已知倍率之后', () => {
    const 排序 = rankSiteCandidates(
      [
        { site: 'seed', mult: Infinity, usable: true },
        { site: 'dynamic', mult: 3, usable: true },
      ],
      'seed',
    );
    assert.equal(排序[0].site, 'dynamic');
  });

  test('倍率相同时偏向 defaultSite', () => {
    const 排序 = rankSiteCandidates(
      [
        { site: 'other', mult: 1, usable: true },
        { site: 'home', mult: 1, usable: true },
      ],
      'home',
    );
    assert.equal(排序[0].site, 'home');
  });

  test('是纯函数：不改动传入数组', () => {
    const 输入 = [
      { site: 'a', mult: 2, usable: false },
      { site: 'b', mult: 1, usable: true },
    ];
    const 快照 = JSON.parse(JSON.stringify(输入));
    rankSiteCandidates(输入, 'a');
    assert.deepEqual(输入, 快照);
  });

  test('空候选返回空数组', () => {
    assert.deepEqual(rankSiteCandidates([], 'a'), []);
  });
});
