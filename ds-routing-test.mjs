// 验证路由分发：启用 deepseek 站点后，模型解析与目录合并是否正确。
import { resolveTarget, mergedModels, getCatalog } from './src/router.mjs';
import { defaultConfig, isDeepSeekSite } from './src/config.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

// 构造一个启用 deepseek 的配置（模拟用户配好 token 后的状态）
const cfg = defaultConfig();
cfg.sites.deepseek.enabled = true;
// 让 isLoggedIn('deepseek') 为真：给它一份凭证
process.env.DS_TEST = '1';

console.log('=== 0. 前置：动态写入凭证以便路由识别为已登录 ===');
const fs = await import('node:fs');
const authPath = new URL('./auth.deepseek.json', import.meta.url).pathname.replace(/^\//, '');
// Windows 盘符修正
const realPath = decodeURIComponent(authPath).replace(/^\/([A-Za-z]:)/, '$1');
const existed = fs.existsSync(realPath);
const backup = existed ? fs.readFileSync(realPath, 'utf8') : null;
fs.writeFileSync(realPath, JSON.stringify({ accessToken: 'ROUTING_TEST_TOKEN', savedAt: new Date().toISOString() }, null, 2));
console.log(`     临时写入 ${realPath}（测试后会${existed ? '还原' : '删除'}）`);

try {
  console.log('\n=== 1. 站点协议识别 ===');
  check('deepseek 被识别为 DeepSeek 站点', isDeepSeekSite(cfg.sites.deepseek) === true);
  check('cn-cli 不被误判', isDeepSeekSite(cfg.sites['cn-cli']) === false);

  console.log('\n=== 2. 目录来源：deepseek 用 seed 而非拉取 ===');
  const cat = await getCatalog(cfg, 'deepseek', { force: true });
  check('source 为 seed', cat.source === 'seed', `实际=${cat.source}`);
  check('拿到 3 个模型', cat.models.size === 3, `实际=${cat.models.size}`);
  check('含 deepseek-reasoner', cat.models.has('deepseek-reasoner'));

  console.log('\n=== 3. 模型解析（显式前缀）===');
  const t1 = await resolveTarget(cfg, 'deepseek/deepseek-chat');
  check('前缀路由到 deepseek', t1.site === 'deepseek', `实际=${t1.site}`);
  check('模型名正确', t1.model === 'deepseek-chat', `实际=${t1.model}`);

  const t2 = await resolveTarget(cfg, 'deepseek/deepseek-reasoner');
  check('reasoner 也路由正确', t2.site === 'deepseek' && t2.model === 'deepseek-reasoner');

  console.log('\n=== 4. 裸模型名（靠目录匹配）===');
  const t3 = await resolveTarget(cfg, 'deepseek-reasoner');
  check('裸名能匹配到 deepseek 站点', t3.site === 'deepseek', `实际=${t3.site}`);

  console.log('\n=== 5. 合并模型清单（供 /v1/models）===');
  const merged = await mergedModels(cfg);
  const dsModels = merged.filter((m) => m.site === 'deepseek');
  check('合并结果含 deepseek 模型', dsModels.length >= 3, `实际=${dsModels.length}`);
  const ids = dsModels.map((m) => m.id);
  console.log(`     deepseek 相关 ID: ${ids.join(', ')}`);

  console.log('\n=== 6. 原有站点未被破坏 ===');
  const others = merged.filter((m) => m.site !== 'deepseek');
  check('仍有其他站点模型', others.length > 0, `实际=${others.length}`);
} finally {
  // 还原凭证文件
  if (existed) fs.writeFileSync(realPath, backup);
  else fs.unlinkSync(realPath);
  console.log(`\n     凭证文件已${existed ? '还原' : '删除'}`);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
