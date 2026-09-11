// 查看服务状态与剩余积分：node status.mjs
import fs from 'node:fs';
import { loadConfig } from './src/config.mjs';

const cfg = loadConfig();
const base = `http://${cfg.host}:${cfg.port}`;

try {
  const res = await fetch(base + '/status', { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
  const j = await res.json();
  console.log('服务：' + base + '  （HTTP ' + res.status + '）');
  console.log('登录：' + (j.logged_in ? '已登录 ' + (j.uid || '') : '未登录 → 请运行 node login.mjs'));
  if (j.nickname) console.log('昵称：' + j.nickname);
  if (j.domain) console.log('域：' + j.domain);
  if (j.token_expires_at) console.log('token 过期：' + new Date(j.token_expires_at).toLocaleString());
  if (j.credit?.remain !== undefined) console.log('剩余积分：' + j.credit.remain);
  else if (j.credit?.error) console.log('额度查询失败：' + j.credit.error);
} catch (e) {
  console.log('服务未启动或端口不通：' + e.message);
  console.log('请先运行： node server.mjs   （或双击 start.cmd）');
}
