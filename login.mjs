// 设备授权登录（OAuth device flow，多站点）：不读取 WorkBuddy 客户端任何本地文件，
// 只把浏览器授权后拿到的 token 写入本项目的 auth.<site>.json。
//
//   node login.mjs                           登录默认站点（cn-cli）
//   node login.mjs --site intl-cli           登录国际版 CLI（codebuddy.ai）
//   node login.mjs --site intl-work          登录国际版 WorkBuddy（workbuddy.ai）
//   node login.mjs --site cn-cli --no-open   只打印授权链接，不自动打开浏览器
//   node login.mjs --site intl-cli 1800      自定义等待秒数（默认 600）
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, paths, authPathFor, siteKeys } from './src/config.mjs';
import { jwtClaims } from './src/auth.mjs';
import { startLogin, pollLogin } from './src/device-login.mjs';
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
  const { state, authUrl } = await startLogin(cfg, siteKey);
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
    const r = await pollLogin(cfg, siteKey, state);
    if (r.done) {
      try {
        fs.unlinkSync(paths.loginState);
      } catch {
        /* 忽略 */
      }
      const saved = r.auth;
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
    const msg = r.msg || '';
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
