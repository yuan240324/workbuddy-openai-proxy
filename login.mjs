// 设备授权登录（OAuth device flow）：不读取 WorkBuddy 客户端任何本地文件，
// 只把浏览器授权后拿到的 token 写入本项目的 auth.json。
//
//   node login.mjs            发起授权并等待（默认最多 10 分钟）
//   node login.mjs --no-open  只打印授权链接，不自动打开浏览器
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, paths } from './src/config.mjs';
import { saveAuth, jwtClaims, hydrateFromToken } from './src/auth.mjs';
import { commonHeaders } from './src/headers.mjs';
import { log, warn } from './src/log.mjs';

const cfg = loadConfig();
const args = process.argv.slice(2);
const autoOpen = !args.includes('--no-open');
const timeoutSec = Number(args.find((a) => /^\d+$/.test(a)) || 600);
const POLL_MS = 3000;

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
  const headers = commonHeaders(cfg);
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
  log('开始 WorkBuddy 授权登录（设备授权流程）…');
  const stateRes = await api('POST', cfg.upstream.apiBase + '/v2/plugin/auth/state?platform=CLI', { body: {} });
  if (stateRes.status >= 400 || stateRes.json?.code !== 0 || !stateRes.json?.data?.state || !stateRes.json?.data?.authUrl) {
    throw new Error(`申请授权状态失败（HTTP ${stateRes.status}）：${stateRes.text.slice(0, 300)}`);
  }
  const { state, authUrl } = stateRes.json.data;
  fs.writeFileSync(paths.loginState, JSON.stringify({ state, authUrl, at: Date.now() }, null, 2), 'utf8');

  console.log('');
  console.log('============================================================');
  console.log(' 请在浏览器中打开下面的链接，用你的 WorkBuddy / CodeBuddy 账号登录：');
  console.log('');
  console.log('   ' + authUrl);
  console.log('');
  console.log(' 登录完成后不用关闭页面，本脚本会自动轮询到授权结果。');
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
    const res = await api('GET', cfg.upstream.apiBase + '/v2/plugin/auth/token?state=' + encodeURIComponent(state));
    const data = res.json?.data;
    if (res.status < 400 && res.json?.code === 0 && data?.accessToken) {
      const auth = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || '',
        expiresAt: data.expiresIn ? Date.now() + data.expiresIn * 1000 : undefined,
        domain: data.domain || undefined,
        savedAt: new Date().toISOString(),
      };
      // 拿账号信息（失败不影响登录结果）
      try {
        const acct = await api('GET', cfg.upstream.apiBase + '/v2/plugin/login/account?state=' + encodeURIComponent(state), {
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
      saveAuth(auth);
      hydrateFromToken();
      const after = saveAuth(auth);
      try {
        fs.unlinkSync(paths.loginState);
      } catch {
        /* 忽略 */
      }
      const claims = jwtClaims(after.accessToken) || {};
      console.log('');
      log('登录成功 ✅');
      log(`  uid：${after.uid || claims.sub || '未知'}`);
      log(`  昵称：${after.nickname || '未知'}`);
      log(`  企业/域：${after.enterpriseId || '未知'} / ${after.domain || '未知'}`);
      log(`  token 过期时间：${after.expiresAt ? new Date(after.expiresAt).toLocaleString() : '未知'}`);
      log(`  凭证已写入：${paths.auth}`);
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
  throw new Error(`等待超时（${timeoutSec}s）：请重新运行 node login.mjs`);
}

main().catch((e) => {
  console.error('');
  console.error('登录失败：' + e.message);
  process.exit(1);
});
