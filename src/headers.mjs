// 上游请求头构造：对齐 CodeBuddy 官方 CLI 的调用形态。
import crypto from 'node:crypto';

/** 通用头（所有上游接口共用） */
export function commonHeaders(cfg) {
  const u = cfg.upstream;
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: u.origin,
    Referer: u.origin + '/',
    'User-Agent': u.userAgent,
  };
}

/** 聊天接口头：额外携带账号身份头（X-User-Id / X-Enterprise-Id / X-Domain）。 */
export function chatHeaders(cfg, auth) {
  const h = commonHeaders(cfg);
  h.Accept = 'text/event-stream';
  h.Authorization = 'Bearer ' + auth.accessToken;
  h['X-Request-ID'] = crypto.randomBytes(16).toString('hex');
  h['X-Request-Trace-Id'] = crypto.randomUUID();
  h['X-Product'] = 'SaaS';
  if (auth.uid) h['X-User-Id'] = auth.uid;
  else h['X-No-User-Id'] = '1';
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  else h['X-No-Enterprise-Id'] = '1';
  if (auth.domain) h['X-Domain'] = auth.domain;
  else h['X-No-Department-Info'] = '1';
  return h;
}

/** token 刷新头：X-Refresh-Token 只允许出现在刷新接口。 */
export function refreshHeaders(cfg, auth) {
  const h = commonHeaders(cfg);
  h['X-Refresh-Token'] = auth.refreshToken;
  h['X-Auth-Refresh-Source'] = 'workbuddy';
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  return h;
}

/** 计费/额度接口头。 */
export function billingHeaders(cfg, auth) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + auth.accessToken,
  };
  if (auth.uid) h['X-User-Id'] = auth.uid;
  if (auth.enterpriseId) {
    h['X-Enterprise-Id'] = auth.enterpriseId;
    h['X-Tenant-Id'] = auth.enterpriseId;
  }
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}
