#!/usr/bin/env node
// DeepSeek 官方站点（chat.deepseek.com）token 配置工具。
//
// 与 CodeBuddy 站点不同，DeepSeek 官方没有可用的设备授权 OAuth 流程，
// 因此这里采用「从浏览器取 token 并粘贴」的方式（本项目不保存账号密码）。
//
// 用法：
//   node login-deepseek.mjs --token "<token>"
//   node login-deepseek.mjs --file token.txt
//   node login-deepseek.mjs              # 交互式粘贴（隐藏输入）
//   node login-deepseek.mjs --status     # 只看当前状态
//
// token 取法：浏览器登录 https://chat.deepseek.com →
//   F12 → Console → 执行：JSON.parse(localStorage.getItem('userToken')).value
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = import.meta.dirname;
const AUTH_FILE = path.join(ROOT, 'auth.deepseek.json');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const ok = (s) => console.log(`${C.green}✔${C.reset} ${s}`);
const bad = (s) => console.log(`${C.red}✘${C.reset} ${s}`);
const warn = (s) => console.log(`${C.yellow}!${C.reset} ${s}`);
const info = (s) => console.log(`${C.dim}  ${s}${C.reset}`);

function parseArgs(argv) {
  const out = { token: null, file: null, status: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token') out.token = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--status') out.status = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`DeepSeek token 配置工具

  node login-deepseek.mjs                 # 交互式粘贴 token
  node login-deepseek.mjs --token "<t>"   # 直接提供
  node login-deepseek.mjs --file t.txt    # 从文件读取
  node login-deepseek.mjs --status        # 查看当前状态

token 取法：浏览器登录 https://chat.deepseek.com →
  F12 → Console → 执行：
    JSON.parse(localStorage.getItem('userToken')).value
`);
}

/** 交互式输入一行。 */
function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); }));
}

async function verify(token) {
  const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
      Accept: '*/*',
      Origin: 'https://chat.deepseek.com',
      Referer: 'https://chat.deepseek.com/',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': '28800',
      'x-client-version': '2.5.0',
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, msg: `返回非 JSON（HTTP ${res.status}）` }; }
  if (json.code === 0) return { ok: true, data: json.data || {} };
  const map = { 40002: 'token 缺失', 40003: 'token 无效或已过期' };
  return { ok: false, code: json.code, msg: `${json.msg || '校验失败'}${map[json.code] ? '（' + map[json.code] + '）' : ''}` };
}

function loadSaved() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  console.log(`${C.bold}DeepSeek 站点 token 配置${C.reset} ${C.dim}(chat.deepseek.com)${C.reset}\n`);

  // ---- 只查状态 ----
  if (args.status) {
    const saved = loadSaved();
    if (!saved?.accessToken) {
      warn('尚未配置 token。');
      info(`配置文件：${AUTH_FILE}`);
      return usage();
    }
    ok(`已配置 token（前 8 位 ${String(saved.accessToken).slice(0, 8)}…）`);
    info(`保存时间：${saved.savedAt || '未知'}`);
    const v = await verify(saved.accessToken);
    if (v.ok) ok(`token 有效${v.data.user?.email ? `，账号：${v.data.user.email}` : ''}`);
    else bad(`token 已失效：${v.msg}`);
    return;
  }

  // ---- 取 token ----
  let token = args.token?.trim();
  if (!token && args.file) {
    if (!fs.existsSync(args.file)) { bad(`文件不存在：${args.file}`); process.exitCode = 1; return; }
    token = fs.readFileSync(args.file, 'utf8').trim();
  }
  if (!token) {
    console.log('请粘贴 DeepSeek token（浏览器 Console 里执行：');
    console.log(`${C.cyan}  JSON.parse(localStorage.getItem('userToken')).value${C.reset} ）\n`);
    token = await ask('token> ');
  }
  if (!token) { bad('未提供 token。'); process.exitCode = 1; return; }

  // 容忍误带 JSON 包装：{"value":"xxx"}
  if (token.startsWith('{')) {
    try {
      const j = JSON.parse(token);
      if (j.value) { token = String(j.value).trim(); info('已自动剥离 {"value": ...} 包装'); }
    } catch { /* 保持原样 */ }
  }

  console.log(`\n正在校验 token（前 8 位 ${token.slice(0, 8)}…，长度 ${token.length}）…`);
  const v = await verify(token);
  if (!v.ok) {
    bad(`校验失败：${v.msg}`);
    console.log(`\n${C.yellow}提示${C.reset}：token 会随登录态变化。请重新在浏览器取得最新值：`);
    console.log(`  1. 打开 https://chat.deepseek.com 并确认已登录`);
    console.log(`  2. F12 → Console（如被拦先输入「允许粘贴」）`);
    console.log(`  3. 执行：JSON.parse(localStorage.getItem('userToken')).value`);
    process.exitCode = 2;
    return;
  }

  ok('token 有效');
  const u = v.data.user || v.data;
  if (u.email) info(`账号：${u.email}`);
  if (u.mobile_number) info(`手机：${u.mobile_number}`);

  // ---- 落盘 ----
  const payload = {
    accessToken: token,
    savedAt: new Date().toISOString(),
    account: u.email || u.mobile_number || u.id || null,
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  ok(`已写入 ${path.basename(AUTH_FILE)}（权限 0600，已在 .gitignore 中忽略）`);

  console.log(`\n${C.green}${C.bold}配置完成。${C.reset}下一步：`);
  console.log('  1. 在 config.json 的 sites 里加上 deepseek 站点（或运行 node status.mjs 查看）');
  console.log('  2. 重启反代服务');
  console.log('  3. Trae 里把模型 ID 填 deepseek 站点的模型即可');
}

main().catch((e) => { bad(`出错：${e.message}`); process.exitCode = 1; });
