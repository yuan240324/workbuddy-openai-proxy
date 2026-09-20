// 新增纯函数的单元测试：resolveOptions / flattenMessages / isDeepSeekSite。
import { resolveOptions, flattenMessages } from './src/deepseek.mjs';
import { isDeepSeekSite, SITE_PRESETS, siteKeys, defaultConfig } from './src/config.mjs';

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n      实际: ${a}\n      期望: ${e}`); }
};

console.log('=== 1. resolveOptions（模型名 → 官方参数）===');
eq('deepseek-chat', resolveOptions('deepseek-chat'), { modelType: 'default', thinking: false, search: false });
eq('deepseek-reasoner 开思考', resolveOptions('deepseek-reasoner'), { modelType: 'default', thinking: true, search: false });
eq('deepseek-search 开搜索', resolveOptions('deepseek-search'), { modelType: 'default', thinking: false, search: true });
eq('含 r1 视为思考', resolveOptions('deepseek-r1'), { modelType: 'default', thinking: true, search: false });
eq('大写容错', resolveOptions('DeepSeek-REASONER'), { modelType: 'default', thinking: true, search: false });
eq('空值回落默认', resolveOptions(''), { modelType: 'default', thinking: false, search: false });
eq('undefined 不崩', resolveOptions(undefined), { modelType: 'default', thinking: false, search: false });

console.log('\n=== 2. flattenMessages（多轮 → 单 prompt）===');
eq('单条 user 不加标签',
  flattenMessages([{ role: 'user', content: '你好' }]), '你好');

eq('system + user 保留顺序',
  flattenMessages([{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }]),
  '[系统指令]\n你是助手\n\n你好');

eq('assistant 轮加标签',
  flattenMessages([
    { role: 'user', content: '1+1' },
    { role: 'assistant', content: '2' },
    { role: 'user', content: '再加1' },
  ]), '1+1\n\n[助手]\n2\n\n再加1');

eq('tool 结果带标签',
  flattenMessages([
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', content: '晴 25度' },
  ]), '查天气\n\n[助手]\n\n[调用工具 get_weather: {"city":"北京"}]\n\n[工具结果]\n晴 25度');

eq('多模态 content 数组取 text',
  flattenMessages([{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'x' } }] }]),
  '看图');

eq('空数组返回空串', flattenMessages([]), '');
eq('非数组返回空串', flattenMessages(null), '');
eq('跳过纯空白消息', flattenMessages([{ role: 'user', content: '   ' }, { role: 'user', content: 'x' }]), 'x');
eq('developer 角色归入系统',
  flattenMessages([{ role: 'developer', content: '规则' }, { role: 'user', content: '嗨' }]),
  '[系统指令]\n规则\n\n嗨');

console.log('\n=== 3. 站点注册与分发标识 ===');
eq('SITE_PRESETS 含 deepseek', 'deepseek' in SITE_PRESETS, true);
eq('deepseek 标记 protocol', SITE_PRESETS.deepseek.protocol, 'deepseek');
eq('deepseek 默认 disabled', SITE_PRESETS.deepseek.enabled, false);
eq('isDeepSeekSite 识别', isDeepSeekSite({ protocol: 'deepseek' }), true);
eq('isDeepSeekSite 不误判 codebuddy', isDeepSeekSite({ product: 'SaaS' }), false);
eq('isDeepSeekSite 容错 undefined', isDeepSeekSite(undefined), false);

console.log('\n=== 4. 默认配置不包含未启用的 deepseek ===');
const cfg = defaultConfig();
const keys = siteKeys(cfg);
eq('siteKeys 只含已启用站点', keys.includes('deepseek'), false);
console.log(`     当前启用站点: ${keys.join(', ')}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
