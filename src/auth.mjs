// 凭证管理：accessToken / refreshToken 只保存在本项目目录内的 auth.json。
// 登录通过官方设备授权（OAuth）流程获得，不读取 WorkBuddy 客户端的任何本地文件。
import fs from 'node:fs';
import { paths } from './config.mjs';
import { refreshHeaders } from './headers.mjs';
import { log, warn } from './log.mjs';

export class AuthError extends Error {
  constructor(message, code = 'auth_error') {
    super(message);
    this.code = code;
    // 登录态类错误统一以 401 返回客户端（客户端/网关据此提示重新登录）
    this.status = code === 'not_logged_in' || code === 'refresh_failed' ? 401 : 500;
  }
}

let auth = null;
let refreshInFlight = null;
let loadedMtime = -1;

/** 读取 auth.json（按 mtime 缓存）：登录脚本在服务运行期间写入凭证也能被自动感知。 */
export function loadAuth() {
  let mtime = 0;
  try {
    mtime = fs.statSync(paths.auth).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (auth && mtime === loadedMtime) return auth;
  loadedMtime = mtime;
  if (!mtime) auth = {};
  else {
    try {
      auth = JSON.parse(fs.readFileSync(paths.auth, 'utf8'));
    } catch (e) {
      warn('auth.json 解析失败，视作未登录：', e.message);
      auth = {};
    }
  }
  hydrateFromToken();
  return auth;
}

export function getAuth() {
  return loadAuth();
}

export function saveAuth(next = getAuth()) {
  auth = next;
  fs.writeFileSync(paths.auth, JSON.stringify(auth, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  loadedMtime = fs.statSync(paths.auth).mtimeMs;
  return auth;
}

export function isLoggedIn() {
  return Boolean(getAuth().accessToken);
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
export function hydrateFromToken() {
  const a = getAuth();
  if (!a.accessToken) return a;
  const claims = jwtClaims(a.accessToken);
  if (!claims) return a;
  if (claims.exp) a.expiresAt = a.expiresAt ?? claims.exp * 1000;
  if (!a.uid && claims.sub) a.uid = String(claims.sub);
  const iss = String(claims.iss || '');
  const m = iss.match(/\/sso-([^/]+)$/);
  if (!a.enterpriseId && m) a.enterpriseId = m[1];
  const host = iss.match(/^https?:\/\/([^/]+)/);
  if (!a.domain && host) a.domain = host[1];
  return a;
}

function tokenExpiringWithin(minMs) {
  const a = getAuth();
  if (!a.accessToken) return true;
  if (a.expiresAt) return Date.now() > a.expiresAt - minMs;
  const claims = jwtClaims(a.accessToken);
  if (claims?.exp) {
    a.expiresAt = claims.exp * 1000;
    return Date.now() > a.expiresAt - minMs;
  }
  return false; // 无法判断有效期时先直接用，401 再触发刷新
}

/** 调用上游刷新接口换新 token。 */
export async function refreshToken(cfg) {
  const a = getAuth();
  if (!a.refreshToken) throw new AuthError('refresh_token 缺失，需要重新运行 node login.mjs 登录', 'not_logged_in');

  const url = cfg.upstream.apiBase + '/v2/plugin/auth/token/refresh';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('refresh timeout')), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: refreshHeaders(cfg, a),
      body: '',
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AuthError(`刷新响应无法解析（HTTP ${res.status}）：${text.slice(0, 200)}`, 'refresh_failed');
    }
    if (res.status >= 400 || json.code !== 0 || !json.data?.accessToken) {
      throw new AuthError(
        `刷新 token 失败（HTTP ${res.status} code=${json.code}）：${String(json.msg || text).slice(0, 200)}`,
        'refresh_failed',
      );
    }
    a.accessToken = json.data.accessToken;
    if (json.data.refreshToken) a.refreshToken = json.data.refreshToken;
    if (json.data.domain) a.domain = json.data.domain;
    a.expiresAt = json.data.expiresIn ? Date.now() + json.data.expiresIn * 1000 : undefined;
    a.savedAt = new Date().toISOString();
    delete a.needsLogin;
    hydrateFromToken();
    saveAuth(a);
    log(`token 已刷新，账号 uid=${String(a.uid || '').slice(0, 8)}… 有效期至 ${a.expiresAt ? new Date(a.expiresAt).toISOString() : '未知'}`);
    return a.accessToken;
  } finally {
    clearTimeout(timer);
  }
}

/** 取可用 accessToken：临期自动刷新（单飞，避免并发刷新风暴）。 */
export async function ensureToken(cfg, { force = false } = {}) {
  const a = getAuth();
  if (!a.accessToken) throw new AuthError('尚未登录：请先运行 node login.mjs 完成授权', 'not_logged_in');
  if (!force && !tokenExpiringWithin(5 * 60 * 1000)) return a.accessToken;
  if (!refreshInFlight) {
    refreshInFlight = refreshToken(cfg).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}
