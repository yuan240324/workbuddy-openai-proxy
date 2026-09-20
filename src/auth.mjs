// 凭证管理（多站点 + 多账号）：每个站点一个账号池，落在本项目目录内的
// auth.<site>.pool.json；池为空时自动兼容旧的单账号 auth.<site>.json。
// 登录通过官方设备授权（OAuth）流程获得，不读取 WorkBuddy 客户端的任何本地文件。
import fs from 'node:fs';
import { paths, authPathFor } from './config.mjs';
import { refreshHeaders } from './headers.mjs';
import { log, warn } from './log.mjs';
import {
  DEFAULT_ACCOUNT_ID,
  listAccounts,
  pickAccount,
  isUsable,
  getAccount,
  hasPoolFile,
  loadPool,
  markFailure,
  markSuccess,
  updateTokens,
  poolPathFor,
} from './pool.mjs';

export class AuthError extends Error {
  constructor(message, code = 'auth_error') {
    super(message);
    this.code = code;
    this.status = code === 'not_logged_in' || code === 'refresh_failed' ? 401 : 500;
  }
}

// site → { auth, mtime, path }；用「站点 + 文件路径」做键，
// 这样配置目录切换后（测试隔离）不会命中另一个目录的缓存。
const stores = new Map();
const refreshInFlight = new Map(); // `${site}\0${accountId}` → Promise
const storeKey = (site, file) => `${site}\u0000${file}`;
/** 池模式下「当前生效账号」在 stores 里的伪路径标记。 */
const POOL_MARK = '\u0000pool';

/**
 * 取「当前生效的凭证」。
 *
 * 顺序：
 *   1) 有池文件 → 用池里选中的那个账号（选择结果会被 ensureToken 覆盖为本次真正用的号）
 *   2) 没池文件 → 旧版单账号文件（auth.<site>.json，cn-cli 再回落 auth.json）
 *
 * 按 mtime 缓存，登录脚本运行中写入也能被自动感知。
 */
export function loadAuth(site = 'cn-cli') {
  // 池模式下以池为准。getAuth() 的调用点（headers.mjs 等）拿到的必须是
  // 本次请求真正用的那个账号的 token，否则会用错号的身份头发请求。
  if (hasPoolFile(site)) {
    const key = storeKey(site, POOL_MARK);
    // 缓存里已经有「本次请求选中的账号」就直接用——那是 ensureToken 放的，最准确。
    // 但池文件被改动过（禁用/新增/耗尽）时必须重选，否则会一直用旧账号。
    const cached = stores.get(key);
    if (cached && cached.poolStamp === poolStamp(site)) return cached.auth;
    const picked = pickAccount(site, { fallback: true });
    const auth = picked ? { ...picked } : {};
    stores.set(key, { auth, mtime: 0, path: POOL_MARK, poolStamp: poolStamp(site) });
    return auth;
  }

  const file = authPathFor(site);
  let useFile = file;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // 兼容旧版单站点凭证：cn-cli 未登录时回落到 auth.json（只读，不回写）
    if (site === 'cn-cli' && fs.existsSync(paths.legacyAuth)) {
      useFile = paths.legacyAuth;
      try {
        mtime = -fs.statSync(paths.legacyAuth).mtimeMs; // 负值标记"来自旧文件"
      } catch {
        mtime = 0;
      }
    }
  }
  const key = storeKey(site, useFile);
  const cached = stores.get(key);
  if (cached && mtime !== 0 && cached.mtime === mtime) return cached.auth;

  let auth = {};
  if (mtime !== 0) {
    try {
      auth = JSON.parse(fs.readFileSync(useFile, 'utf8'));
    } catch (e) {
      warn(`[${site}] 凭证文件解析失败，视作未登录：`, e.message);
      auth = {};
    }
  }
  hydrateFromToken(site, auth);
  stores.set(key, { auth, mtime, path: useFile });
  return auth;
}

/** 把某个账号设为「当前生效账号」（ensureToken 选定后调用）。 */
function setCurrentAccount(site, account) {
  stores.set(storeKey(site, POOL_MARK), { auth: account, mtime: 0, path: POOL_MARK, poolStamp: poolStamp(site) });
}

/**
 * 池文件的时间戳，用于判断「池是否被改动过」。
 * 改动过就必须重新选号，否则控制台禁用/切号后服务还在用旧账号。
 */
function poolStamp(site) {
  try {
    return fs.statSync(poolPathFor(site)).mtimeMs;
  } catch {
    return 0;
  }
}

export function getAuth(site = 'cn-cli') {
  return loadAuth(site);
}

export function saveAuth(site, next) {
  const file = authPathFor(site);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  stores.set(storeKey(site, file), { auth: next, mtime: fs.statSync(file).mtimeMs, path: file });
  return next;
}

export function isLoggedIn(site = 'cn-cli') {
  return Boolean(getAuth(site).accessToken);
}

/** 解析 JWT 载荷（不验签，仅取 sub/iss/exp 用于拼出账号头）。 */
export function jwtClaims(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 用 token 里的声明补齐 uid / enterpriseId / domain / expiresAt。 */
export function hydrateFromToken(site, auth) {
  if (!auth.accessToken) return auth;
  const claims = jwtClaims(auth.accessToken);
  if (!claims) return auth;
  if (claims.exp) auth.expiresAt = auth.expiresAt ?? claims.exp * 1000;
  if (!auth.uid && claims.sub) auth.uid = String(claims.sub);
  const iss = String(claims.iss || '');
  const m = iss.match(/\/sso-([^/]+)$/);
  if (!auth.enterpriseId && m) auth.enterpriseId = m[1];
  const host = iss.match(/^https?:\/\/([^/]+)/);
  if (!auth.domain && host) auth.domain = host[1];
  return auth;
}

function tokenExpiringWithin(site, minMs) {
  const a = getAuth(site);
  if (!a.accessToken) return true;
  if (a.expiresAt) return Date.now() > a.expiresAt - minMs;
  const claims = jwtClaims(a.accessToken);
  if (claims?.exp) {
    a.expiresAt = claims.exp * 1000;
    return Date.now() > a.expiresAt - minMs;
  }
  return false; // 无法判断有效期时先直接用，401 再触发刷新
}/**
 * 判断刷新失败是否属于「凭证已彻底失效」（需要重新登录），
 * 而不是网络抖动/上游临时故障（保留凭证下次再试）。
 */
function isCredentialDead(res, json) {
  // 明确的 HTTP 鉴权失败
  if (res.status === 401 || res.status === 403) return true;
  // OAuth 语义的失效错误码
  const code = String(json?.code ?? '');
  const msg = String(json?.msg || json?.error?.code || json?.error || '');
  if (/invalid_grant|invalid_token|expired_token|unauthorized/i.test(msg)) return true;
  // 上游常见的「登录态失效」业务码
  if (code && /^(401|403|1001|1002|1003|1004)$/.test(code)) return true;
  return false;
}

/**
 * 清除某站点的登录凭证（凭证已彻底失效时调用，避免反复用死 token 重试）。
 * 有池文件时只清该账号；没有池文件（兼容视图）时清旧凭证文件。
 */
function clearAuth(site, accountId = null) {
  if (hasPoolFile(site) && accountId) {
    // 池模式下不清除账号本身（保留在控制台可见），只标记为不可用
    markFailure(site, accountId, { status: 401, message: '登录态已失效，需要重新登录' });
    stores.delete(storeKey(site, POOL_MARK));
    return;
  }
  const file = authPathFor(site);
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    warn(`[${site}] 清除失效凭证失败：`, e.message);
  }
  // 旧版单站点凭证也一并清掉（仅 cn-cli 会回落到它）
  if (site === 'cn-cli') {
    try {
      fs.rmSync(paths.legacyAuth, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  // 清掉该站点在当前目录下的缓存（含旧文件来源的键），避免读到死凭证
  stores.delete(storeKey(site, file));
  stores.delete(storeKey(site, paths.legacyAuth));
  stores.delete(storeKey(site, POOL_MARK));
  stores.set(storeKey(site, file), { auth: {}, mtime: 0, path: file });
}

/** 调用站点刷新接口换新 token。accountId 为空时刷新「当前默认账号」。 */
export async function refreshToken(cfg, site, accountId = null) {
  const id = accountId || resolveAccountId(site);
  const a = id ? getAccount(site, id) : getAuth(site);
  const siteCfg = cfg.sites[site];
  if (!a) throw new AuthError(`[${site}] 账号不存在：${id}`, 'not_logged_in');
  if (!a.refreshToken) throw new AuthError(`[${site}] refresh_token 缺失，需要重新登录`, 'not_logged_in');

  const url = siteCfg.apiBase + '/v2/plugin/auth/token/refresh';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('refresh timeout')), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: refreshHeaders(siteCfg, a),
      body: '',
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AuthError(`[${site}] 刷新响应无法解析（HTTP ${res.status}）：${text.slice(0, 200)}`, 'refresh_failed');
    }
    if (res.status >= 400 || json.code !== 0 || !json.data?.accessToken) {
      const err = new AuthError(
        `[${site}] 刷新 token 失败（HTTP ${res.status} code=${json.code}）：${String(json.msg || text).slice(0, 200)}`,
        'refresh_failed',
      );
      // 凭证已彻底失效时清掉本地凭证，避免后续每次都拿死 token 重试刷屏
      if (isCredentialDead(res, json)) {
        clearAuth(site, id);
        err.code = 'not_logged_in';
        err.status = 401;
        err.message = `[${site}] 登录态已失效（HTTP ${res.status} code=${json.code}）：请重新登录 —— node login.mjs --site ${site}`;
        warn(err.message);
      }
      throw err;
    }
    const expiresAt = json.data.expiresIn ? Date.now() + json.data.expiresIn * 1000 : undefined;
    const next = {
      accessToken: json.data.accessToken,
      refreshToken: json.data.refreshToken || a.refreshToken,
      expiresAt,
      domain: json.data.domain || a.domain,
    };
    hydrateFromToken(site, next);
    // 有池就走池（按账号精确写回），否则沿用旧的单账号文件
    if (hasPoolFile(site) && id) {
      updateTokens(site, id, next);
      const fresh = getAccount(site, id);
      if (fresh) setCurrentAccount(site, fresh);
    } else {
      Object.assign(a, next);
      saveAuth(site, stripLegacy(a));
    }
    log(`[${site}] token 已刷新${id ? `（${id}）` : ''}，uid=${String(next.uid || a.uid || '').slice(0, 8)}… 有效期至 ${expiresAt ? new Date(expiresAt).toISOString() : '未知'}`);
    return next.accessToken;
  } finally {
    clearTimeout(timer);
  }
}

/** 去掉内部控制字段再写回旧版单账号文件，保持文件格式与以前一致。 */
function stripLegacy(a) {
  const { legacyFile, id, label, enabled, exhaustedAt, cooldownUntil, failCount, lastUsedAt, lastError, ...rest } = a;
  return rest;
}

/** 池模式下「当前账号」= 池里选中的那个；兼容模式下就是旧单账号。 */
function resolveAccountId(site) {
  if (!hasPoolFile(site)) return DEFAULT_ACCOUNT_ID;
  const picked = pickAccount(site);
  return picked ? picked.id : null;
}

/** 该站点当前选中的账号 id（供请求路径记录/上报用），没有可用账号时返回 null。 */
export function currentAccountId(site) {
  return resolveAccountId(site);
}

/** 该站点所有账号的健康快照（控制台用）。 */
export function accountSnapshot(site) {
  return listAccounts(site).map((a) => ({
    id: a.id,
    label: a.label || a.nickname || a.id,
    uid: a.uid || null,
    nickname: a.nickname || null,
    enabled: a.enabled !== false,
    usable: isUsable(a),
    exhausted: Boolean(a.exhaustedAt),
    exhausted_at: a.exhaustedAt ? new Date(a.exhaustedAt).toISOString() : null,
    cooldown_until: a.cooldownUntil ? new Date(a.cooldownUntil).toISOString() : null,
    fail_count: a.failCount || 0,
    last_error: a.lastError || null,
    last_error_at: a.lastErrorAt ? new Date(a.lastErrorAt).toISOString() : null,
    last_used_at: a.lastUsedAt ? new Date(a.lastUsedAt).toISOString() : null,
    expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    added_at: a.addedAt || null,
    is_default: a.id === DEFAULT_ACCOUNT_ID,
  }));
}

/**
 * 取站点可用 accessToken：临期自动刷新（单飞，避免并发刷新风暴）。
 * 返回值：{ token, accountId }（accountId 用于失败时上报给号池）。
 * exclude 里的账号 id 会被跳过——调用方在「换个号重试」时传入。
 */
export async function ensureToken(cfg, site = cfg.defaultSite, { force = false, exclude = [], accountId = null } = {}) {
  const id = accountId || (() => {
    // 优先选可用账号；一个都没有时退而取一个「耗尽/冷却中」的，
    // 让上游给最终答案（额度可能已重置），好过本地直接失败。
    const picked = pickAccount(site, { exclude }) || pickAccount(site, { exclude, fallback: true });
    return picked ? picked.id : null;
  })();

  if (!id) throw new AuthError(`[${site}] 尚未登录：请运行 node login.mjs --site ${site}`, 'not_logged_in');
  const a = getAccount(site, id);
  if (!a?.accessToken) throw new AuthError(`[${site}] 尚未登录：请运行 node login.mjs --site ${site}`, 'not_logged_in');

  // 把选中账号设为「当前生效账号」——后续 chatHeaders 通过 getAuth 读到的必须是它
  setCurrentAccount(site, a);

  const needRefresh = force || !a.expiresAt || Date.now() > a.expiresAt - 5 * 60 * 1000;
  if (!needRefresh) return { token: a.accessToken, accountId: id };

  // 单飞按「站点 + 账号」粒度，不同账号互不阻塞
  const key = `${site}\u0000${id}`;
  if (!refreshInFlight.has(key)) {
    const p = refreshToken(cfg, site, id)
      .then(() => getAccount(site, id)?.accessToken)
      .finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, p);
  }
  try {
    const token = await refreshInFlight.get(key);
    return { token, accountId: id };
  } catch (e) {
    // 刷新失败：把这个号标成不可用并退避，然后交给上层换号重试
    if (e.code !== 'not_logged_in') {
      try {
        markFailure(site, id, { status: e.status || 0, message: e.message });
      } catch {
        /* 上报失败不影响主流程 */
      }
    }
    throw e;
  }
}
