// 设备授权登录（OAuth device flow，多站点）：不读取 WorkBuddy 客户端任何本地文件，
// 只把浏览器授权后拿到的 token 写入本项目的 auth.<site>.json。
//
//   node login.mjs                        登录默认站点（cn-cli）
//   node login.mjs --site intl-cli        登录国际版 CLI（codebuddy.ai）
//   node login.mjs --site intl-work       登录国际版 WorkBuddy（workbuddy.ai）
//   node login.mjs --site cn-cli --no-open   只打印授权链接，不自动打开浏览器
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, paths, authPathFor, siteKeys } from './src/config.mjs';
import { saveAuth, jwtClaims, hydrateFromToken } from './src/auth.mjs';
import { commonHeaders } from './src/headers.mjs';
import { log, warn } from './src/log.mjs';

const cfg = loadConfig();
const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const siteKey = siteIdx >= 0 ? args[siteIdx + 1] : cfg.defaultSite;
const autoOpen = !args.includes('--no-open');
const timeoutSec = Number(args.find((a) => /^\d+$/.test(a)) || 600);
const POLL_MS = 3000;

if (!cfg.sites?.[siteKey]) {
  console.error(`未知站点：${siteKey}\n可用站点：${siteKeys(cfg).join(', ')}`);
  process.exit(1);
}
const site = cfg.sites[siteKey];

const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function api(method, url, { body, token } = {}) {
  const headers = commonHeaders(site);
  if (body) headers['Content-Type'] = 'application/json';
  if (jar.size) headers.Cookie = cookieHeader();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (e) {
    warn('自动打开浏览器失败：', e.message);
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log(`开始登录站点 [${siteKey}] ${site.label}`);
  const stateRes = await api('POST', site.apiBase + '/v2/plugin/auth/state?platform=CLI', { body: {} });
  if (stateRes.status >= 400 || stateRes.json?.code !== 0 || !stateRes.json?.data?.state || !stateRes.json?.data?.authUrl) {
    throw new Error(`申请授权状态失败（HTTP ${stateRes.status}）：${stateRes.text.slice(0, 300)}`);
  }
  const { state, authUrl } = stateRes.json.data;
  fs.writeFileSync(paths.loginState, JSON.stringify({ site: siteKey, state, authUrl, at: Date.now() }, null, 2), 'utf8');

  console.log('');
  console.log('============================================================');
  console.log(` 站点：${siteKey}  ${site.label}`);
  console.log(' 请在浏览器中打开下面的链接，用你的账号登录：');
  console.log('');
  console.log('   ' + authUrl);
  console.log('');
  console.log(' 登录完成后不用关闭页面，本脚本会自动轮询到授权结果。');
  console.log(' （国际版若还没有账号，可在该页面直接注册）');
  console.log('============================================================');
  console.log('');
  if (autoOpen) {
    const ok = openBrowser(authUrl);
    log(ok ? '已尝试自动打开浏览器' : '请手动复制上面的链接到浏览器打开');
  }

  const deadline = Date.now() + timeoutSec * 1000;
  let dots = 0;
  let lastMsg = '';
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const res = await api('GET', site.apiBase + '/v2/plugin/auth/token?state=' + encodeURIComponent(state));
    const data = res.json?.data;
    if (res.status < 400 && res.json?.code === 0 && data?.accessToken) {
      const auth = {
        site: siteKey,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || '',
        expiresAt: data.expiresIn ? Date.now() + data.expiresIn * 1000 : undefined,
        domain: data.domain || undefined,
        savedAt: new Date().toISOString(),
      };
      try {
        const acct = await api('GET', site.apiBase + '/v2/plugin/login/account?state=' + encodeURIComponent(state), {
          token: data.accessToken,
        });
        const a = acct.json?.data;
        if (a) {
          auth.uid = a.uid;
          auth.enterpriseId = a.enterpriseId;
          auth.nickname = a.nickname;
        }
      } catch (e) {
        warn('获取账号信息失败（不影响使用）：', e.message);
      }
      hydrateFromToken(siteKey, auth);
      const saved = saveAuth(siteKey, auth);
      try {
        fs.unlinkSync(paths.loginState);
      } catch {
        /* 忽略 */
      }
      const claims = jwtClaims(saved.accessToken) || {};
      console.log('');
      log(`登录成功 ✅  （站点 ${siteKey}）`);
      log(`  uid：${saved.uid || claims.sub || '未知'}`);
      log(`  昵称：${saved.nickname || '未知'}`);
      log(`  企业/域：${saved.enterpriseId || '未知'} / ${saved.domain || '未知'}`);
      log(`  token 过期时间：${saved.expiresAt ? new Date(saved.expiresAt).toLocaleString() : '未知'}`);
      log(`  凭证已写入：${authPathFor(siteKey)}`);
      return;
    }
    const msg = res.json?.msg || res.text || `HTTP ${res.status}`;
    if (msg !== lastMsg) {
      lastMsg = msg;
      process.stdout.write(`\n等待授权…（上游：${String(msg).slice(0, 80)}）\n`);
      dots = 0;
    } else {
      process.stdout.write('.');
      if (++dots % 40 === 0) process.stdout.write('\n');
    }
  }
  throw new Error(`等待超时（${timeoutSec}s）：请重新运行 node login.mjs --site ${siteKey}`);
}

main().catch((e) => {
  console.error('');
  console.error('登录失败：' + e.message);
  process.exit(1);
});
