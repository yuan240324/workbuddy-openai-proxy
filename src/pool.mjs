// 账号池：同一个站点下维护多个账号，额度耗尽或请求失败时自动换号。
//
// 存储：auth.<site>.pool.json
//   {
//     "version": 1,
//     "nextLabel": 2,
//     "accounts": [
//       { "id": "acc_1a2b3c4d", "label": "账号1",
//         "accessToken": "...", "refreshToken": "...", "expiresAt": 123,
//         "uid": "...", "nickname": "...", "domain": "...",
//         "enabled": true,
//         "exhaustedAt": null,     // 检测到额度耗尽的时间戳
//         "cooldownUntil": null,   // 失败退避截止时间
//         "failCount": 0,          // 连续失败次数
//         "lastUsedAt": null,      // 上次被选中的时间（用于轮询分摊）
//         "lastError": null,       // 最近一次失败原因（给控制台看）
//         "addedAt": "2026-..." }
//     ]
//   }
//
// 兼容：池文件不存在时，自动把旧的单账号 auth.<site>.json 当作「唯一账号」
//       （id = DEFAULT_ACCOUNT_ID）。此时读写仍然落在旧文件上，
//       所以不迁移也不影响原有行为。一旦池里加入了第 2 个账号，
//       就会把默认账号并入池文件统一管理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfigDir, authPathFor } from './config.mjs';
import { warn } from './log.mjs';

/** 池文件里代表「旧版单账号凭证」的固定 id。 */
export const DEFAULT_ACCOUNT_ID = 'default';

/** 额度耗尽后多久重新尝试（额度可能已重置）。默认 6 小时。 */
const EXHAUST_TTL_MS = 6 * 60 * 60 * 1000;

/** 失败退避阶梯：连续失败 n 次后冷却多久。 */
const COOLDOWN_STEPS_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

export function poolPathFor(site) {
  return path.join(getConfigDir(), `auth.${site}.pool.json`);
}

// 缓存键必须带上配置目录：配置目录是可变状态（测试隔离会切换它），
// 只用 site 做键的话，切目录后仍会命中上一个目录的缓存，
// 表现为「单独跑通过、全量跑随机失败」。
const cache = new Map(); // `${dir}\0${site}` → { mtime, pool }

const cacheKey = (site) => `${getConfigDir()}\u0000${site}`;

function emptyPool() {
  return { version: 1, nextLabel: 1, accounts: [] };
}

function newId() {
  return 'acc_' + crypto.randomBytes(4).toString('hex');
}

/** 读取池文件；文件不存在时返回 null（由调用方决定是否回落到旧单账号文件）。 */
function readPoolFile(site) {
  const file = poolPathFor(site);
  const key = cacheKey(site);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(key);
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.mtime === mtime) return hit.pool;
  let pool;
  try {
    pool = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`[${site}] 账号池文件解析失败，视作空池：`, e.message);
    pool = emptyPool();
  }
  if (!Array.isArray(pool.accounts)) pool.accounts = [];
  if (!Number.isFinite(pool.nextLabel)) pool.nextLabel = pool.accounts.length + 1;
  cache.set(key, { mtime, pool });
  return pool;
}

function writePool(site, pool) {
  const file = poolPathFor(site);
  fs.writeFileSync(file, JSON.stringify(pool, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  cache.set(cacheKey(site), { mtime: fs.statSync(file).mtimeMs, pool });
  return pool;
}

/** 读取旧版单账号凭证文件（auth.<site>.json，cn-cli 还兼容 auth.json）。 */
function readLegacyAuth(site) {
  const candidates = [authPathFor(site)];
  if (site === 'cn-cli') candidates.push(path.join(getConfigDir(), 'auth.json'));
  for (const f of candidates) {
    try {
      const a = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (a && a.accessToken) return { auth: a, file: f };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 取该站点的账号池（会做旧单账号兼容）。
 * 返回值里的 accounts 都是副本，调用方改完需要自己 save。
 */
export function loadPool(site) {
  const pool = readPoolFile(site);
  if (pool) return pool;

  const legacy = readLegacyAuth(site);
  if (!legacy) return emptyPool();
  // 不落盘：让只读场景（如控制台轮询）不产生写入副作用
  return {
    ...emptyPool(),
    accounts: [{ ...legacy.auth, id: DEFAULT_ACCOUNT_ID, label: legacy.auth.nickname || '默认账号', enabled: true, legacyFile: legacy.file }],
  };
}

/** 是否已经在用池文件（false 表示当前只是旧单账号的兼容视图）。 */
export function hasPoolFile(site) {
  return fs.existsSync(poolPathFor(site));
}

/**
 * 保存池。若当前还处在「旧单账号兼容视图」，写入前先把该账号并进池文件，
 * 这样第一次改动（登录新账号 / 改状态）就会自动完成迁移，用户无感。
 */
export function savePool(site, pool) {
  const clean = {
    version: 1,
    nextLabel: pool.nextLabel,
    accounts: pool.accounts.map((a) => {
      const { legacyFile, ...rest } = a; // 不把来源路径写进文件
      return rest;
    }),
  };
  return writePool(site, clean);
}

/** 列出账号（副本），带脱敏视图。 */
export function listAccounts(site) {
  return loadPool(site).accounts.map((a) => ({ ...a }));
}

/** 按 id 取账号。 */
export function getAccount(site, id) {
  return loadPool(site).accounts.find((a) => a.id === id) || null;
}

/** 账号是否处于「可用」状态（启用 + 没冷却 + 没被判额度耗尽）。 */
export function isUsable(a, now = Date.now()) {
  if (!a || a.enabled === false) return false;
  if (!a.accessToken) return false;
  if (a.cooldownUntil && now < a.cooldownUntil) return false;
  if (a.exhaustedAt && now - a.exhaustedAt < EXHAUST_TTL_MS) return false;
  return true;
}

/**
 * 选一个账号。
 * 排序依据（依次）：
 *   1) 优先「从没被判定耗尽」的账号
 *   2) 连续失败次数少的
 *   3) 最久没被用过的（把负载摊开，避免总薅同一个号）
 * exclude 里的 id 会被跳过（用于「这个号刚失败，换一个」）。
 *
 * fallback 为 true 时：若没有任何「可用」账号，退而返回一个「已耗尽/冷却中」的账号。
 * 这样上游能给最终答案，好过本地直接失败——额度可能已经重置了。
 */
export function pickAccount(site, { exclude = [], now = Date.now(), fallback = false } = {}) {
  const pool = loadPool(site);
  const skip = new Set(exclude);
  const candidates = pool.accounts.filter((a) => !skip.has(a.id) && a.enabled !== false && a.accessToken);
  const usable = candidates.filter((a) => isUsable(a, now));
  const 池 = usable.length || !fallback ? usable : candidates;
  if (!池.length) return null;

  const rank = (a) => {
    const exhausted = a.exhaustedAt && now - a.exhaustedAt < EXHAUST_TTL_MS ? 1 : 0;
    return [exhausted, a.failCount || 0, a.lastUsedAt || 0];
  };
  const sorted = [...池].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted[0] || null;
}

/** 池里还有多少个「现在可用」的账号（可排除已试过的 id）。 */
export function usableCount(site, now = Date.now(), exclude = []) {
  const skip = new Set(exclude);
  return loadPool(site).accounts.filter((a) => !skip.has(a.id) && isUsable(a, now)).length;
}

/* ---------------- 状态变更（都会落盘） ---------------- */

/**
 * 改动池并落盘。
 *
 * immediate=false 时改为「延迟合并写」：markSuccess 在每个成功请求上都会调用，
 * 每次都同步写盘会给每个请求加上一次磁盘 IO；而且单账号（兼容模式）下
 * lastUsedAt 毫无意义，却会因为这一次写入而凭空建出池文件。
 * 因此热路径用节流写，且没有池文件时直接跳过。
 */
function mutate(site, fn, { immediate = true } = {}) {
  const pool = loadPool(site);
  const r = fn(pool);
  if (immediate) savePool(site, pool);
  else scheduleSave(site, pool);
  return r;
}

/** 延迟合并写：同一站点的多次改动合并成一次磁盘写。 */
const saveTimers = new Map();
const SAVE_DELAY_MS = 2000;

function scheduleSave(site, pool) {
  const key = cacheKey(site);
  if (saveTimers.has(key)) return;
  const t = setTimeout(() => {
    saveTimers.delete(key);
    try {
      savePool(site, pool);
    } catch (e) {
      warn(`[${site}] 账号池写入失败：`, e.message);
    }
  }, SAVE_DELAY_MS);
  t.unref?.();
  saveTimers.set(key, t);
}

/** 立即把待写的池刷盘（进程退出前调用）。 */
export function flushPool() {
  for (const [key, t] of saveTimers) {
    clearTimeout(t);
    const site = key.slice(key.indexOf('\u0000') + 1);
    try {
      savePool(site, loadPool(site));
    } catch {
      /* 忽略 */
    }
  }
  saveTimers.clear();
}

/**
 * 记录一次成功：清掉失败计数与冷却，并解除「额度耗尽」标记。
 *
 * 兼容模式（还没有池文件）下直接返回：只有一个账号，没有可轮换的对象，
 * 记 lastUsedAt 没有意义，还会因为写盘而意外建出池文件。
 */
export function markSuccess(site, id) {
  if (!hasPoolFile(site)) return null;
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.failCount = 0;
    a.cooldownUntil = null;
    a.lastError = null;
    if (a.exhaustedAt) a.exhaustedAt = null;
    a.lastUsedAt = Date.now();
    return a;
  }, { immediate: false });
}

/**
 * 记录一次失败。
 * status 用于区分处理方式：
 *   - 429/额度类：直接判定额度耗尽，长时间不再选它
 *   - 401/403：凭证失效，需要重新登录
 *   - 5xx/网络：退避冷却，过一会儿还能用
 */
export function markFailure(site, id, { status = 0, message = '' } = {}) {
  // 兼容模式只有一个账号，没有可轮换的对象；也不必为它建池文件
  if (!hasPoolFile(site)) return null;
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.failCount = (a.failCount || 0) + 1;
    a.lastError = String(message || status || '').slice(0, 200);
    a.lastErrorAt = Date.now();
    a.lastUsedAt = Date.now();
    if (isQuotaError(status, message)) {
      a.exhaustedAt = Date.now();
      a.cooldownUntil = null;
    } else {
      const step = COOLDOWN_STEPS_MS[Math.min(a.failCount, COOLDOWN_STEPS_MS.length - 1)];
      a.cooldownUntil = step ? Date.now() + step : null;
    }
    return a;
  });
}

/** 明确标记某账号额度耗尽（由额度查询/业务码驱动）。 */
export function markExhausted(site, id, message = '额度不足') {
  if (!hasPoolFile(site)) return null;
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.exhaustedAt = Date.now();
    a.cooldownUntil = null;
    a.lastError = String(message).slice(0, 200);
    a.lastErrorAt = Date.now();
    return a;
  });
}

/** 手动解除耗尽/冷却（控制台「重置状态」用）。 */
export function resetAccountState(site, id) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.exhaustedAt = null;
    a.cooldownUntil = null;
    a.failCount = 0;
    a.lastError = null;
    return a;
  });
}

/** 启用/禁用账号。 */
export function setAccountEnabled(site, id, enabled) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.enabled = Boolean(enabled);
    return a;
  });
}

/** 改账号显示名（控制台里方便区分「小号A」之类）。 */
export function setAccountLabel(site, id, label) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.label = String(label).slice(0, 40);
    return a;
  });
}

/**
 * 判断错误是否属于「这个号没额度了」。
 * 上游把额度不足做成 429，或在 200 里回特定业务码，这里都覆盖到。
 */
export function isQuotaError(status, message = '') {
  if (status === 429) return true;
  const m = String(message || '');
  if (/insufficient|quota|balance|credit|exceed|limit reached|no available/i.test(m)) return true;
  if (/额度|余额|积分不足|已用完|超出/i.test(m)) return true;
  return false;
}

/* ---------------- 增删账号 ---------------- */

/** 往池里加一个账号（登录成功后调用）。返回新账号。 */
export function addAccount(site, auth, { label } = {}) {
  const pool = loadPool(site);
  const uid = auth.uid ? String(auth.uid) : null;

  // 同一 uid 已存在 → 覆盖更新（重新登录同一个号，不该出现两条）
  const exist = uid ? pool.accounts.find((a) => a.uid && String(a.uid) === uid) : null;
  const base = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken ?? null,
    expiresAt: auth.expiresAt ?? null,
    domain: auth.domain ?? null,
    savedAt: new Date().toISOString(),
    uid,
    nickname: auth.nickname ?? null,
  };
  if (exist) {
    Object.assign(exist, base, { enabled: true, exhaustedAt: null, cooldownUntil: null, failCount: 0, lastError: null });
    if (label) exist.label = label;
    savePool(site, pool);
    return exist;
  }

  // 首次往池里加账号时，把兼容视图里的旧账号也并进来，
  // 避免「加了新号，原来的号反而消失了」。
  const 已有 = pool.accounts.length;
  if (已有 === 0) {
    const legacy = readLegacyAuth(site);
    if (legacy) {
      pool.accounts.push({
        ...legacy.auth,
        id: DEFAULT_ACCOUNT_ID,
        label: legacy.auth.nickname || '默认账号',
        enabled: true,
        exhaustedAt: null,
        cooldownUntil: null,
        failCount: 0,
        addedAt: new Date().toISOString(),
      });
    }
  }

  const nextLabel = pool.nextLabel || pool.accounts.length + 1;
  const acc = {
    id: newId(),
    label: label || auth.nickname || `账号${nextLabel}`,
    ...base,
    enabled: true,
    exhaustedAt: null,
    cooldownUntil: null,
    failCount: 0,
    lastUsedAt: null,
    lastError: null,
    addedAt: new Date().toISOString(),
  };
  pool.accounts.push(acc);
  pool.nextLabel = nextLabel + 1;
  savePool(site, pool);
  return acc;
}

/** 删除账号。若删的是旧版默认账号，同时删掉旧凭证文件，避免它又被兼容读回来。 */
export function removeAccount(site, id) {
  const pool = loadPool(site);
  const idx = pool.accounts.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  const [removed] = pool.accounts.splice(idx, 1);
  savePool(site, pool);
  if (removed.id === DEFAULT_ACCOUNT_ID) {
    try {
      fs.rmSync(authPathFor(site), { force: true });
    } catch {
      /* 忽略 */
    }
  }
  return true;
}

/** 把账号上刷新后的 token 写回（token 刷新成功后调用）。 */
export function updateTokens(site, id, { accessToken, refreshToken, expiresAt, domain }) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.accessToken = accessToken;
    if (refreshToken) a.refreshToken = refreshToken;
    if (expiresAt !== undefined) a.expiresAt = expiresAt;
    if (domain) a.domain = domain;
    a.savedAt = new Date().toISOString();
    return a;
  });
}
