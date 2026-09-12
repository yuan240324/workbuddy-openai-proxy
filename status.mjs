// 查看各站点登录状态与剩余积分：node status.mjs [--site intl-cli]
import { loadConfig } from './src/config.mjs';

const cfg = loadConfig();
const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const only = siteIdx >= 0 ? args[siteIdx + 1] : null;
const base = `http://${cfg.host}:${cfg.port}`;

try {
  const qs = only ? `?site=${encodeURIComponent(only)}` : '';
  const res = await fetch(`${base}/status${qs}`, { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
  const j = await res.json();
  console.log(`服务：${base}  （HTTP ${res.status}）  默认站点：${j.default_site}`);
  console.log('');
  for (const s of j.sites || []) {
    console.log(`■ ${s.site}  ${s.label}`);
    console.log(`    上游：${s.apiBase}`);
    console.log(`    登录：${s.logged_in ? `已登录  uid=${s.uid}${s.nickname ? '  昵称=' + s.nickname : ''}` : '未登录 → node login.mjs --site ' + s.site}`);
    if (s.token_expires_at) console.log(`    token 过期：${new Date(s.token_expires_at).toLocaleString()}`);
    if (s.credit?.remain !== undefined) console.log(`    剩余积分：${s.credit.remain}`);
    else if (s.credit?.error) console.log(`    额度查询：${s.credit.error}`);
    console.log('');
  }
} catch (e) {
  console.log('服务未启动或端口不通：' + e.message);
  console.log('请先运行： node server.mjs   （或双击 start.cmd）');
}
