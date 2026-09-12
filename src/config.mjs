// 配置与路径：所有文件（配置、凭证、日志）一律限定在本项目目录内，绝不读写项目外文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');

export const paths = {
  root: ROOT,
  config: path.join(ROOT, 'config.json'),
  legacyAuth: path.join(ROOT, 'auth.json'), // 旧版单站点凭证（国内版），仍兼容读取
  loginState: path.join(ROOT, '.login-state.json'),
};

/** 单个站点的凭证文件：auth.<site>.json */
export function authPathFor(site) {
  return path.join(ROOT, `auth.${site}.json`);
}

// 上游站点预设：国内版与国际版协议同构，仅域名 / 身份头不同。
export const SITE_PRESETS = {
  'cn-cli': {
    label: '国内版 CLI（copilot.tencent.com）',
    enabled: true,
    apiBase: 'https://copilot.tencent.com',
    billingBase: 'https://www.codebuddy.cn',
    origin: 'https://www.codebuddy.cn',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
  },
  'intl-cli': {
    label: '国际版 CLI（codebuddy.ai）',
    enabled: true,
    apiBase: 'https://www.codebuddy.ai',
    billingBase: 'https://www.codebuddy.ai',
    origin: 'https://www.codebuddy.ai',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
    // 国际版控制台目录接口被网关限制（403/500），这里内置一份实测可用的模型清单兜底。
    // 该清单只影响「裸模型名自动选站点」与 /v1/models 展示，不影响实际调用。
    seedModels: [
      { id: 'auto', name: 'Auto（上游自动路由）' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
      { id: 'minimax-m3', name: 'MiniMax-M3' },
    ],
  },
  'intl-work': {
    label: '国际版 WorkBuddy（workbuddy.ai）',
    enabled: true,
    apiBase: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
    // 登录后可自行补充实测可用的模型 ID
    seedModels: [{ id: 'auto', name: 'Auto（上游自动路由）' }],
  },
};

// 默认模型清单（config.json 缺失时的兜底；真实可用清单以 GET /v1/models 实时拉取为准）
export const DEFAULT_MODELS = [
  { id: 'hy3', name: 'Hy3' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
  { id: 'auto', name: 'Auto（上游自动路由）' },
];

export function defaultConfig() {
  return {
    host: '127.0.0.1', // 仅本机可访问，不对局域网暴露
    port: 8788,
    apiKey: 'sk-wb-' + crypto.randomBytes(12).toString('hex'),
    defaultSite: 'cn-cli',
    defaultModel: 'deepseek-v4-pro',
    defaultMaxTokens: 16384,
    // 上游（尤其是国际版）要求 messages 首条必须是 system，客户端没给时用这句补上
    defaultSystemPrompt: 'You are a helpful AI assistant.',
    // 出站请求体里需要剔除的字段（一般留空）
    stripFields: [],
    // 站点表：国内版 / 国际版可分别启停，也可自行新增
    sites: structuredClone(SITE_PRESETS),
    // 模型 → 站点 的显式路由（可选），例如 { "claude-4.5": "intl-cli" }
    modelRoutes: {},
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

/** 旧版 `upstream` 字段 → sites['cn-cli']，保证老配置继续可用。 */
function migrateLegacy(raw) {
  if (!raw.upstream || raw.sites) return {};
  const u = raw.upstream;
  return {
    sites: {
      'cn-cli': {
        apiBase: u.apiBase,
        billingBase: u.billingBase,
        origin: u.origin,
        userAgent: u.userAgent,
      },
    },
  };
}

/** 读取 config.json；缺失时用默认配置落盘（含随机生成的本地 API Key）。 */
export function loadConfig() {
  if (!fs.existsSync(paths.config)) {
    const cfg = defaultConfig();
    fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const merged = deepMerge(defaultConfig(), migrateLegacy(raw));
  const cfg = deepMerge(merged, raw);
  delete cfg.upstream; // 已迁移到 sites
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** 已启用且在册的站点键列表。 */
export function siteKeys(cfg) {
  return Object.keys(cfg.sites || {}).filter((k) => cfg.sites[k]?.enabled !== false);
}

export function getSite(cfg, site) {
  const s = cfg.sites?.[site];
  if (!s) throw Object.assign(new Error(`未知站点：${site}（可用：${siteKeys(cfg).join(', ')}）`), { status: 400 });
  return s;
}
