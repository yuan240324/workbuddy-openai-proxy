// 打开控制台独立窗口（无地址栏）：
//   1) 检查服务是否在跑，不在就静默拉起（后台、不弹黑窗）
//   2) 等服务就绪
//   3) 用 Edge / Chrome 的「应用模式」开一个独立窗口
// 用法：node console-open.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT } from './src/config.mjs';

const cfg = loadConfig();
const BASE = `http://${cfg.host}:${cfg.port}`;
const CONSOLE_URL = `${BASE}/console`;

const 浏览器候选 = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

async function 服务在跑() {
  try {
    const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function 等就绪(最多毫秒 = 20000) {
  const 截止 = Date.now() + 最多毫秒;
  while (Date.now() < 截止) {
    if (await 服务在跑()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function main() {
  if (!(await 服务在跑())) {
    console.log('服务未在运行，正在静默启动…');
    const 子进程 = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    子进程.unref();
    if (!(await 等就绪())) {
      console.error('启动超时，请查看项目目录下的 server.log。');
      process.exit(1);
    }
    console.log('服务已就绪。');
  }

  const 浏览器 = 浏览器候选.find((p) => fs.existsSync(p));
  if (!浏览器) {
    console.log('未找到 Edge / Chrome，改用默认浏览器打开：' + CONSOLE_URL);
    spawn('cmd', ['/c', 'start', '""', CONSOLE_URL], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  // --app 即「应用模式」：无地址栏、无标签栏，看起来就是独立客户端
  const 窗口 = spawn(浏览器, [`--app=${CONSOLE_URL}`, '--window-size=1240,860', '--window-name=WorkBuddy 控制台'], {
    detached: true,
    stdio: 'ignore',
  });
  窗口.unref();
  console.log('已打开控制台窗口（' + path.basename(浏览器) + ' 应用模式）');
}

main().catch((e) => {
  console.error('打开控制台失败：' + e.message);
  process.exit(1);
});
