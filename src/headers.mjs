// 上游请求头构造（站点感知）：对齐 CodeBuddy 官方 CLI 的调用形态。
// 国内版与国际版协议同构，只有 origin / UA / 域名不同，均由站点配置提供。
import crypto from 'node:crypto';

/** 通用头（所有上游接口共用） */
export function commonHeaders(site) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: site.origin,
    Referer: site.origin + '/',
    'User-Agent': site.userAgent,
  };
}

/** 聊天接口头：额外携带账号身份头（X-User-Id / X-Enterprise-Id / X-Domain）。 */
export function chatHeaders(site, auth) {
  const h = commonHeaders(site);
  h.Accept = 'text/event-stream';
  h.Authorization = 'Bearer ' + auth.accessToken;
  h['X-Request-ID'] = crypto.randomBytes(16).toString('hex');
  h['X-Request-Trace-Id'] = crypto.randomUUID();
  // 2026-10 起上游在 /v2/chat/completions 上做「渠道校验」：三个 X-Conversation-* 会话头缺一
  // 即返回 11128 request illegal（displayTips: 没通过渠道校验，可能不是官方客户端发出）。
  // 这三个 id 只作渠道/会话标识，服务端不据此保存历史，每次请求现生成随机 UUID 即可。
  h['X-Conversation-ID'] = crypto.randomUUID();
  h['X-Conversation-Request-ID'] = crypto.randomUUID();
  h['X-Conversation-Message-ID'] = crypto.randomUUID();
  h['X-Product'] = site.product || 'SaaS';
  if (auth.uid) h['X-User-Id'] = auth.uid;
  else h['X-No-User-Id'] = '1';
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  else h['X-No-Enterprise-Id'] = '1';
  if (auth.domain) h['X-Domain'] = auth.domain;
  else h['X-No-Department-Info'] = '1';
  return h;
}

/** token 刷新头：X-Refresh-Token 只允许出现在刷新接口。 */
export function refreshHeaders(site, auth) {
  const h = commonHeaders(site);
  h['X-Refresh-Token'] = auth.refreshToken;
  h['X-Auth-Refresh-Source'] = 'workbuddy';
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  return h;
}

/** 计费/额度接口头。 */
export function billingHeaders(site, auth) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + auth.accessToken,
    Origin: site.origin,
    Referer: site.origin + '/',
    'User-Agent': site.userAgent,
  };
  if (auth.uid) h['X-User-Id'] = auth.uid;
  if (auth.enterpriseId) {
    h['X-Enterprise-Id'] = auth.enterpriseId;
    h['X-Tenant-Id'] = auth.enterpriseId;
  }
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}
