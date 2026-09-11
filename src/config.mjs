// 配置与路径：所有文件（配置、凭证、日志）一律限定在本项目目录内，绝不读写项目外文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');

export const paths = {
  root: ROOT,
  config: path.join(ROOT, 'config.json'),
  auth: path.join(ROOT, 'auth.json'),
  loginState: path.join(ROOT, '.login-state.json'),
};

// 默认模型清单（config.json 缺失时的兜底；真实可用清单以 GET /v1/models 实时拉取为准）
export const DEFAULT_MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
  { id: 'kimi-k3-1', name: 'Kimi-K3' },
  { id: 'minimax-m3', name: 'MiniMax-M3' },
  { id: 'hy4-preview', name: 'Hy4 preview' },
  { id: 'hy3', name: 'Hy3' },
  { id: 'auto', name: 'Auto（上游自动路由）' },
];

export function defaultConfig() {
  return {
    host: '127.0.0.1', // 仅本机可访问，不对局域网暴露
    port: 8788,
    apiKey: 'sk-wb-' + crypto.randomBytes(12).toString('hex'),
    defaultModel: 'claude-sonnet-4.6',
    defaultMaxTokens: 16384,
    // 出站请求体里需要剔除的字段（一般留空）
    stripFields: [],
    upstream: {
      apiBase: 'https://copilot.tencent.com',
      billingBase: 'https://www.codebuddy.cn',
      userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
      origin: 'https://www.codebuddy.cn',
    },
    timeouts: {
      headerMs: 90000, // 上游首字节（响应头）超时
      idleMs: 300000, // 流中空闲超时
    },
    models: DEFAULT_MODELS,
    modelAliases: {},
  };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** 读取 config.json；缺失时用默认配置落盘（含随机生成的本地 API Key）。 */
export function loadConfig() {
  if (!fs.existsSync(paths.config)) {
    const cfg = defaultConfig();
    fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  return deepMerge(defaultConfig(), raw);
}

export function saveConfig(cfg) {
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
