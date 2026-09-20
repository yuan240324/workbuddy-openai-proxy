// 设备授权登录（OAuth device flow）共享实现：CLI（login.mjs）与控制台 API 共用。
// 只调用官方授权接口，把拿到的 token 写进本项目目录内的账号池。
import { hydrateFromToken } from './auth.mjs';
import { addAccount } from './pool.mjs';
import { commonHeaders } from './headers.mjs';

const jars = new Map(); // site → Map(cookie)

function jarOf(site) {
  if (!jars.has(site)) jars.set(site, new Map());
  return jars.get(site);
}

function storeCookies(site, res) {
  const jar = jarOf(site);
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function api(cfg, site, method, url, { body, token } = {}) {
  const siteCfg = cfg.sites[site];
  const headers = commonHeaders(siteCfg);
  const jar = jarOf(site);
  if (body) headers['Content-Type'] = 'application/json';
  if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  storeCookies(site, res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/** 第一步：申请 state 与授权链接。 */
export async function startLogin(cfg, site) {
  const siteCfg = cfg.sites[site];
  if (!siteCfg) throw new Error(`未知站点：${site}`);
  const res = await api(cfg, site, 'POST', siteCfg.apiBase + '/v2/plugin/auth/state?platform=CLI', { body: {} });
  if (res.status >= 400 || res.json?.code !== 0 || !res.json?.data?.state) {
    throw new Error(`申请授权状态失败（HTTP ${res.status}）：${res.text.slice(0, 200)}`);
  }
  const { state, authUrl } = res.json.data;
  return { site, state, authUrl, at: Date.now() };
}

/** 第二步：轮询一次授权结果。未完成时返回 { done:false, msg }。 */
export async function pollLogin(cfg, site, state, { label = null } = {}) {
  const siteCfg = cfg.sites[site];
  const res = await api(cfg, site, 'GET', siteCfg.apiBase + '/v2/plugin/auth/token?state=' + encodeURIComponent(state));
  const data = res.json?.data;
  if (!(res.status < 400 && res.json?.code === 0 && data?.accessToken)) {
    return { done: false, msg: res.json?.msg || res.text || `HTTP ${res.status}` };
  }

  const auth = {
    site,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || '',
    expiresAt: data.expiresIn ? Date.now() + data.expiresIn * 1000 : undefined,
    domain: data.domain || undefined,
    savedAt: new Date().toISOString(),
  };
  try {
    const acct = await api(cfg, site, 'GET', siteCfg.apiBase + '/v2/plugin/login/account?state=' + encodeURIComponent(state), {
      token: data.accessToken,
    });
    const a = acct.json?.data;
    if (a) {
      auth.uid = a.uid;
      auth.enterpriseId = a.enterpriseId;
      auth.nickname = a.nickname;
    }
  } catch {
    /* 账号信息拿不到不影响登录 */
  }
  hydrateFromToken(site, auth);
  // 加进号池：同一 uid 会覆盖更新，不同 uid 则新增一个账号。
  // 首个账号加入时会自动把旧的单账号凭证并进池（用户无感迁移）。
  const saved = addAccount(site, auth, { label });
  return { done: true, auth: saved };
}
