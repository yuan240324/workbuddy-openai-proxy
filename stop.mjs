// 停止本地反代服务：node stop.mjs
// 通过服务自身的管理接口优雅退出（需要 config.json 里的本地 API Key），
// 不依赖 WMI / 进程枚举，任何环境下都可用。
import { loadConfig } from './src/config.mjs';

const cfg = loadConfig();
const url = `http://${cfg.host}:${cfg.port}/admin/shutdown`;

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
    signal: AbortSignal.timeout(5000),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok && j.ok) console.log('已发送停止指令，服务正在退出。');
  else console.log(`停止失败：HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
} catch (e) {
  console.log('服务似乎没有在运行（' + (e.cause?.code || e.name) + '）。');
  console.log('如需强制结束，可在任务管理器里结束 node.exe。');
}
