// 设备授权登录（OAuth device flow，多站点 + 多账号）：不读取 WorkBuddy 客户端任何本地文件，
// 只把浏览器授权后拿到的 token 写进本项目的账号池。
//
//   node login.mjs                           登录默认站点（cn-cli），结果加进该站点号池
//   node login.mjs --site intl-cli           登录国际版 CLI（codebuddy.ai）
//   node login.mjs --site intl-work          登录国际版 WorkBuddy（workbuddy.ai）
//   node login.mjs --label 小号A             给这次加的账号起个名字（方便在控制台区分）
//   node login.mjs --site cn-cli --no-open   只打印授权链接，不自动打开浏览器
//   node login.mjs --list                    列出各站点号池里的账号
//
// 换账号只要再登录一次：同一个 uid 会覆盖更新，不同 uid 自动新增一条。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, paths, siteKeys } from './src/config.mjs';
import { jwtClaims } from './src/auth.mjs';
import { accountSnapshot } from './src/auth.mjs';
import { startLogin, pollLogin } from './src/device-login.mjs';
import { poolPathFor } from './src/pool.mjs';
import { log, warn } from './src/log.mjs';

const cfg = loadConfig();
const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const siteKey = siteIdx >= 0 ? args[siteIdx + 1] : cfg.defaultSite;
const labelIdx = args.indexOf('--label');
const label = labelIdx >= 0 ? args[labelIdx + 1] : null;
const autoOpen = !args.includes('--no-open');
const listOnly = args.includes('--list');
const timeoutSec = Number(args.find((a) => /^\d+$/.test(a)) || 600);
const POLL_MS = 3000;

/** --list：不登录，只把各站点号池现状打出来。 */
if (listOnly) {
  for (const s of siteKeys(cfg)) {
    const list = accountSnapshot(s);
    console.log(`\n[${s}] ${cfg.sites[s].label} —— ${list.length} 个账号`);
    if (!list.length) {
      console.log('  （空。运行 node login.mjs --site ' + s + ' 添加账号）');
      continue;
    }
    for (const a of list) {
      const 状态 = !a.enabled ? '已禁用' : a.exhausted ? '额度耗尽' : a.usable ? '可用' : '冷却中';
      console.log(`  · ${a.label}  uid=${String(a.uid || '').slice(0, 8)}…  ${状态}${a.last_error ? '  ← ' + a.last_error.slice(0, 40) : ''}`);
    }
  }
  console.log(`\n号池文件：${poolPathFor(cfg.defaultSite)}（每站点一个）`);
  process.exit(0);
}

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
    const r = await pollLogin(cfg, siteKey, state, { label });
    if (r.done) {
      try {
        fs.unlinkSync(paths.loginState);
      } catch {
        /* 忽略 */
      }
      const saved = r.auth;
      const claims = jwtClaims(saved.accessToken) || {};
      const 池 = accountSnapshot(siteKey);
      console.log('');
      log(`登录成功 ✅  （站点 ${siteKey}）`);
      log(`  账号：${saved.label || saved.nickname || saved.id}`);
      log(`  uid：${saved.uid || claims.sub || '未知'}`);
      log(`  昵称：${saved.nickname || '未知'}`);
      log(`  企业/域：${saved.enterpriseId || '未知'} / ${saved.domain || '未知'}`);
      log(`  token 过期时间：${saved.expiresAt ? new Date(saved.expiresAt).toLocaleString() : '未知'}`);
      log(`  已写入号池：${poolPathFor(siteKey)}`);
      log(`  该站点现有 ${池.length} 个账号：${池.map((a) => a.label).join('、')}`);
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
