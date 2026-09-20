// 账号池测试：选号、额度耗尽、失败退避、轮换、旧单账号兼容。
//
// 隔离方式与 auth.test.mjs 一致：setConfigDir() 切到临时目录。
// 号池把「站点 → 账号列表」落盘到 auth.<site>.pool.json，
// 所以每个用例都要先切目录再操作，避免污染仓库。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pool-'));

const { setConfigDir, authPathFor, getConfigDir } = await import('../src/config.mjs');
setConfigDir(tmpDir);
const pool = await import('../src/pool.mjs');

if (!pool.poolPathFor('cn-cli').startsWith(tmpDir)) {
  throw new Error(`测试隔离失败：号池路径 ${pool.poolPathFor('cn-cli')} 不在临时目录内`);
}

/** 造一个账号对象。 */
const acct = (n, extra = {}) => ({
  accessToken: `tok-${n}`,
  refreshToken: `rt-${n}`,
  uid: `uid-${n}`,
  nickname: `号${n}`,
  expiresAt: Date.now() + 3600_000,
  ...extra,
});

/**
 * 每个用例开始时切回本文件的临时目录并清空凭证。
 *
 * 为什么必须在「用例体内」调用，而不是只用 beforeEach：
 * 同一个进程里会跑多个测试文件，它们各自持有不同的临时目录，
 * 而 setConfigDir 是全局状态。挂在 beforeEach 上时，
 * 其他文件（如 auth.test.mjs）的钩子会在本文件的用例之间改走目录，
 * 于是本文件读到的是别人的凭证 —— 表现为「单独跑通过、全量跑失败」。
 */
function fresh() {
  setConfigDir(tmpDir);
  fs.rmSync(pool.poolPathFor('cn-cli'), { force: true });
  fs.rmSync(authPathFor('cn-cli'), { force: true });
  fs.rmSync(path.join(tmpDir, 'auth.json'), { force: true });
}

describe('号池：旧单账号兼容', () => {
  test('没有池文件时，旧 auth.<site>.json 被当作唯一账号', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, pool.DEFAULT_ACCOUNT_ID);
    assert.equal(list[0].accessToken, 'tok-1');
    assert.equal(pool.hasPoolFile('cn-cli'), false, '不应因为读取就建池文件');
  });

  test('池文件不存在且没有旧凭证时，池为空', () => {
    fresh();
    assert.deepEqual(pool.listAccounts('cn-cli'), []);
    assert.equal(pool.pickAccount('cn-cli'), null);
  });

  test('cn-cli 还能回落到更老的 auth.json', () => {
    fresh();
    fs.writeFileSync(path.join(getConfigDir(), 'auth.json'), JSON.stringify(acct(9)));
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 1);
    assert.equal(list[0].accessToken, 'tok-9');
  });

  test('加入第一个新账号时，旧账号会被并进池（不会丢）', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    pool.addAccount('cn-cli', acct(2), { label: '新号' });
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 2);
    assert.ok(list.some((a) => a.id === pool.DEFAULT_ACCOUNT_ID), '旧账号应保留');
    assert.ok(list.some((a) => a.label === '新号'));
    assert.equal(pool.hasPoolFile('cn-cli'), true);
  });
});

describe('号池：增删账号', () => {
  test('addAccount 能加多个账号', () => {
    fresh();
    pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((a) => a.label), ['A', 'B']);
  });

  test('同一个 uid 重复登录是覆盖，不是新增', () => {
    fresh();
    pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', { ...acct(1), accessToken: 'tok-1-new' }, { label: 'A2' });
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 1, '同 uid 不应出现两条');
    assert.equal(list[0].accessToken, 'tok-1-new');
    assert.equal(list[0].label, 'A2');
  });

  test('未登录（无 uid）的账号不会互相覆盖', () => {
    fresh();
    const noUid = { accessToken: 'x', refreshToken: 'y' };
    pool.addAccount('cn-cli', { ...noUid }, { label: 'A' });
    pool.addAccount('cn-cli', { ...noUid }, { label: 'B' });
    assert.equal(pool.listAccounts('cn-cli').length, 2);
  });

  test('removeAccount 删除指定账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    assert.equal(pool.removeAccount('cn-cli', a.id), true);
    assert.deepEqual(pool.listAccounts('cn-cli').map((x) => x.label), ['B']);
  });

  test('删除不存在的账号返回 false', () => {
    fresh();
    assert.equal(pool.removeAccount('cn-cli', 'nope'), false);
  });

  test('删除默认账号时连带清掉旧凭证文件，避免又被兼容读回来', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    pool.addAccount('cn-cli', acct(2), { label: 'B' }); // 触发迁移，旧号进池
    pool.removeAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(fs.existsSync(authPathFor('cn-cli')), false);
    assert.deepEqual(pool.listAccounts('cn-cli').map((x) => x.label), ['B']);
  });
});

describe('号池：选号', () => {
  test('优先选从没被判耗尽的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli').id, b.id);
  });

  test('默认只返回可用账号；全耗尽时返回 null', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli'), null, '严格模式下不返回耗尽的号');
  });

  test('fallback:true 时，全耗尽也返回一个（让上游给最终答案，而非本地臆断）', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli', { fallback: true }).id, a.id);
  });

  test('fallback:true 也不会返回被禁用的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.setAccountEnabled('cn-cli', a.id, false);
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli', { fallback: true }), null);
  });

  test('禁用账号不参与选择', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.setAccountEnabled('cn-cli', a.id, false);
    assert.equal(pool.pickAccount('cn-cli').id, b.id);
  });

  test('exclude 里的账号会被跳过（换号重试用）', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    assert.equal(pool.pickAccount('cn-cli', { exclude: [a.id] }).id, b.id);
    assert.equal(pool.pickAccount('cn-cli', { exclude: [a.id, b.id] }), null);
  });

  test('负载摊开：连续选号会轮到不同的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    const 第一次 = pool.pickAccount('cn-cli', { now: 1000 });
    pool.markSuccess('cn-cli', 第一次.id); // 会更新 lastUsedAt
    const 第二次 = pool.pickAccount('cn-cli');
    assert.notEqual(第一次.id, 第二次.id, '应该轮到另一个账号');
    assert.deepEqual(new Set([第一次.id, 第二次.id]), new Set([a.id, b.id]));
  });

  test('连续失败的账号排在后面', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    assert.equal(pool.pickAccount('cn-cli').id, b.id);
  });

  test('usableCount 会扣除 exclude', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    assert.equal(pool.usableCount('cn-cli'), 2);
    assert.equal(pool.usableCount('cn-cli', undefined, [a.id]), 1);
    assert.equal(pool.usableCount('cn-cli', undefined, [a.id, 'x']), 1);
  });
});

describe('号池：状态与退避', () => {
  test('额度类错误 → 标记耗尽', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 429 });
    assert.equal(pool.getAccount('cn-cli', a.id).exhaustedAt !== null, true);
    assert.equal(pool.isUsable(pool.getAccount('cn-cli', a.id)), false);
  });

  test('额度不足的中文提示也识别为耗尽', () => {
    fresh();
    assert.equal(pool.isQuotaError(200, '积分不足'), true);
    assert.equal(pool.isQuotaError(200, 'insufficient credits'), true);
    assert.equal(pool.isQuotaError(200, '随便什么错误'), false);
  });

  test('普通错误走冷却退避，不是耗尽', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.exhaustedAt, null, '5xx 不该判成额度耗尽');
    assert.equal(got.failCount, 1);
  });

  test('连续失败会拉长冷却时间', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    const 一次 = pool.getAccount('cn-cli', a.id).cooldownUntil;
    pool.markFailure('cn-cli', a.id, { status: 500 });
    const 两次 = pool.getAccount('cn-cli', a.id).cooldownUntil;
    assert.ok(两次 > 一次, '第二次失败冷却应更长');
  });

  test('markSuccess 清掉失败计数、冷却与耗尽标记', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 429 });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    pool.markSuccess('cn-cli', a.id);
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.failCount, 0);
    assert.equal(got.cooldownUntil, null);
    assert.equal(got.exhaustedAt, null);
    assert.equal(got.lastError, null);
  });

  test('resetAccountState 能手动恢复', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    pool.setAccountEnabled('cn-cli', a.id, false);
    pool.resetAccountState('cn-cli', a.id);
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.exhaustedAt, null);
    assert.equal(got.failCount, 0);
  });

  test('耗尽标记会随时间失效（额度可能已重置）', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(pool.isUsable(got), false, '刚标记时不可用');
    // 7 小时后（超过 6 小时 TTL）应重新可用
    assert.equal(pool.isUsable(got, Date.now() + 7 * 3600_000), true);
  });

  test('updateTokens 按账号精确写回，不影响别的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.updateTokens('cn-cli', a.id, { accessToken: 'new-a', refreshToken: 'new-ra', expiresAt: 42 });
    assert.equal(pool.getAccount('cn-cli', a.id).accessToken, 'new-a');
    assert.equal(pool.getAccount('cn-cli', a.id).expiresAt, 42);
    assert.equal(pool.getAccount('cn-cli', b.id).accessToken, 'tok-2', 'B 不该被动');
  });

  test('setAccountLabel 改显示名', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.setAccountLabel('cn-cli', a.id, '小号甲');
    assert.equal(pool.getAccount('cn-cli', a.id).label, '小号甲');
  });
});

describe('号池：getAuth 必须跟着池走（回归）', () => {
  // 曾经的 bug：loadAuth 只读 auth.<site>.json，忽略了池文件，
  // 于是 chatHeaders 用的是旧文件的 token，而请求本身却是池里选出的账号 ——
  // 表现为「禁用/换号后行为完全没变」，很难察觉。
  test('有池文件时 getAuth 返回池里的账号，而不是旧文件', async () => {
    fresh();
    const authMod = await import('../src/auth.mjs');
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify({ ...acct(1), accessToken: 'legacy-file-token' }));
    pool.addAccount('cn-cli', { ...acct(2), accessToken: 'pool-token' }, { label: 'PoolA' });
    const got = authMod.getAuth('cn-cli');
    assert.notEqual(got.accessToken, 'legacy-file-token', '不能再用旧文件的 token');
  });

  test('池里账号全部禁用时，不会退回旧文件的凭证', async () => {
    fresh();
    const authMod = await import('../src/auth.mjs');
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify({ ...acct(1), accessToken: 'legacy-file-token' }));
    pool.addAccount('cn-cli', acct(2), { label: 'A' });
    for (const a of pool.listAccounts('cn-cli')) pool.setAccountEnabled('cn-cli', a.id, false);
    const got = authMod.getAuth('cn-cli');
    assert.notEqual(got.accessToken, 'legacy-file-token', '旧文件不该再被使用');
    assert.equal(got.accessToken, undefined, '全禁用时应没有可用凭证');
  });

  test('ensureToken 选中的账号会成为 getAuth 的结果', async () => {
    fresh();
    const authMod = await import('../src/auth.mjs');
    pool.addAccount('cn-cli', { ...acct(1), accessToken: 'tok-A', expiresAt: Date.now() + 3600_000 }, { label: 'A' });
    const b = pool.addAccount('cn-cli', { ...acct(2), accessToken: 'tok-B', expiresAt: Date.now() + 3600_000 }, { label: 'B' });
    // 让 A 显得「刚用过」，这样选出来的必然是 B
    const a = pool.listAccounts('cn-cli').find((x) => x.label === 'A');
    pool.markSuccess('cn-cli', a.id);
    const r = await authMod.ensureToken({ sites: { 'cn-cli': {} }, defaultSite: 'cn-cli' }, 'cn-cli');
    assert.equal(r.accountId, b.id, 'A 刚被用过，应轮到 B');
    assert.equal(r.token, 'tok-B');
    assert.equal(authMod.getAuth('cn-cli').accessToken, 'tok-B');
  });
});

describe('号池：文件读写', () => {
  test('写出的池文件不含内部字段 legacyFile', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    const raw = JSON.parse(fs.readFileSync(pool.poolPathFor('cn-cli'), 'utf8'));
    for (const a of raw.accounts) {
      assert.equal('legacyFile' in a, false, 'legacyFile 是内部字段，不应落盘');
    }
  });

  test('池文件损坏时视作空池，不抛异常', () => {
    fresh();
    fs.writeFileSync(pool.poolPathFor('cn-cli'), '{ 这不是 json');
    assert.deepEqual(pool.listAccounts('cn-cli'), []);
  });

  test('池文件权限为 600（含凭证，不能被同机其他用户读）', () => {
    fresh();
    pool.addAccount('cn-cli', acct(1), { label: 'A' });
    if (process.platform === 'win32') return; // Windows 不支持 POSIX 权限位
    const mode = fs.statSync(pool.poolPathFor('cn-cli')).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
