// 凭证管理（多站点）：每个站点一份 auth.<site>.json，全部落在本项目目录内。
// 登录通过官方设备授权（OAuth）流程获得，不读取 WorkBuddy 客户端的任何本地文件。
import fs from 'node:fs';
import { paths, authPathFor } from './config.mjs';
import { refreshHeaders } from './headers.mjs';
import { log, warn } from './log.mjs';

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
const refreshInFlight = new Map(); // site → Promise
const storeKey = (site, file) => `${site}\u0000${file}`;

/** 读取一个站点的凭证（按 mtime 缓存，登录脚本运行中写入也能被自动感知）。 */
export function loadAuth(site = 'cn-cli') {
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
}

/**
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

/** 清除某站点的登录凭证（凭证已失效时调用，避免反复用死 token 重试）。 */
function clearAuth(site) {
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
  stores.set(storeKey(site, file), { auth: {}, mtime: 0, path: file });
}

/** 调用站点刷新接口换新 token。 */
export async function refreshToken(cfg, site) {
  const a = getAuth(site);
  const siteCfg = cfg.sites[site];
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
        clearAuth(site);
        err.code = 'not_logged_in';
        err.status = 401;
        err.message = `[${site}] 登录态已失效（HTTP ${res.status} code=${json.code}）：请重新登录 —— node login.mjs --site ${site}`;
        warn(err.message);
      }
      throw err;
    }
    a.accessToken = json.data.accessToken;
    if (json.data.refreshToken) a.refreshToken = json.data.refreshToken;
    if (json.data.domain) a.domain = json.data.domain;
    a.expiresAt = json.data.expiresIn ? Date.now() + json.data.expiresIn * 1000 : undefined;
    a.savedAt = new Date().toISOString();
    hydrateFromToken(site, a);
    saveAuth(site, a);
    log(`[${site}] token 已刷新，uid=${String(a.uid || '').slice(0, 8)}… 有效期至 ${a.expiresAt ? new Date(a.expiresAt).toISOString() : '未知'}`);
    return a.accessToken;
  } finally {
    clearTimeout(timer);
  }
}

/** 取站点可用 accessToken：临期自动刷新（单飞，避免并发刷新风暴）。 */
export async function ensureToken(cfg, site = cfg.defaultSite, { force = false } = {}) {
  const a = getAuth(site);
  if (!a.accessToken) throw new AuthError(`[${site}] 尚未登录：请运行 node login.mjs --site ${site}`, 'not_logged_in');
  if (!force && !tokenExpiringWithin(site, 5 * 60 * 1000)) return a.accessToken;
  if (!refreshInFlight.has(site)) {
    const p = refreshToken(cfg, site).finally(() => refreshInFlight.delete(site));
    refreshInFlight.set(site, p);
  }
  return refreshInFlight.get(site);
}
