// 配置与路径：所有文件（配置、凭证、日志）一律限定在本项目目录内，绝不读写项目外文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');

// 配置目录：默认就是项目根目录。测试可通过 WB_CONFIG_DIR 环境变量或
// setConfigDir() 指向临时目录，避免单测污染仓库里的 config.json / auth.*.json / usage.json。
//
// 注意用「可变状态 + 取值函数」而不是把路径冻结成常量：
// 同一进程里可能先后加载多个测试文件，冻结的常量会让后设置的目录失效
// （曾出现测试文件把凭证写进仓库根目录的问题）。
let configDir = process.env.WB_CONFIG_DIR ? path.resolve(process.env.WB_CONFIG_DIR) : ROOT;

/** 当前配置目录。 */
export function getConfigDir() {
  return configDir;
}

/**
 * 重设配置目录（主要供测试隔离使用）。
 * 返回还原函数，便于在 after() 里恢复。
 */
export function setConfigDir(dir) {
  const prev = configDir;
  configDir = dir ? path.resolve(dir) : ROOT;
  return () => { configDir = prev; };
}

/**
 * 在指定目录下执行一段逻辑（同步或异步），执行前切换、结束后还原。
 *
 * 用途：测试里需要「本次调用一定读写我自己的临时目录」，
 * 且不能被同进程其他测试文件的目录切换干扰。
 * 用法：await withConfigDir(tmp, () => loadConfig())
 */
export async function withConfigDir(dir, fn) {
  const restore = setConfigDir(dir);
  try {
    return await fn();
  } finally {
    restore();
  }
}

export const paths = {
  get root() { return configDir; },
  get config() { return path.join(configDir, 'config.json'); },
  get legacyAuth() { return path.join(configDir, 'auth.json'); }, // 旧版单站点凭证（国内版），仍兼容读取
  get loginState() { return path.join(configDir, '.login-state.json'); },
};

/** 单个站点的凭证文件：auth.<site>.json */
export function authPathFor(site) {
  return path.join(configDir, `auth.${site}.json`);
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
    // 国际版控制台目录接口不稳定（常 500），这里内置一份实测可用清单兜底。
    // 该清单只影响「裸模型名自动选站点」与 /v1/models 展示，不影响实际调用。
    seedModels: [
      { id: 'auto', name: 'Auto（上游自动路由）' },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra（上游偶发不可用）' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol（上游偶发不可用）' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash（实测 0 扣费）' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'kimi-k3', name: 'Kimi-K3' },
      { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
      { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
      { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
      { id: 'minimax-m3', name: 'MiniMax-M3' },
      { id: 'hy3', name: 'Hy3' },
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
      metaMs: 30000, // 元数据接口（模型清单 / 额度查询）总时长超时
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

/* ============================================================
   配置校验
   ------------------------------------------------------------
   目的：config.json 是用户手改的文件，写错类型时原先会让服务以难懂的方式崩掉：
     timeouts: null            → openChat 抛 "Cannot read properties of null"
     port: null / "abc"        → listen 失败或监听意外端口
     sites: null               → 站点静默消失
     apiKey: ""                → 鉴权被完全跳过（已在 server.mjs 兜底警告）
   这里统一做「类型校验 + 回退默认值 + 记录问题」，保证：
     - 合法配置：行为与之前完全一致（不触发任何修复）
     - 非法配置：降级为安全默认值并可读地告知，而不是崩溃
   ============================================================ */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';

/** 有限正数（端口允许 0，表示随机端口）。 */
function isPort(v) {
  return Number.isInteger(v) && v >= 0 && v <= 65535;
}

function isPositiveMs(v) {
  return Number.isFinite(v) && v > 0;
}

/**
 * 校验并就地修复配置。返回问题描述数组（为空表示配置完全合法）。
 * 修复策略：能安全回退到默认值的回退，无法回退的删除该项。
 */
export function validateConfig(cfg, defaults = defaultConfig()) {
  const issues = [];
  const fix = (msg) => issues.push(msg);

  // ---- 监听地址 ----
  if (!isStr(cfg.host) || !cfg.host.trim()) {
    fix(`host 必须是字符串，已回退为 ${defaults.host}`);
    cfg.host = defaults.host;
  }
  if (!isPort(cfg.port)) {
    fix(`port 必须是 0-65535 的整数（当前 ${JSON.stringify(cfg.port)}），已回退为 ${defaults.port}`);
    cfg.port = defaults.port;
  }

  // ---- 密钥：空串/类型错误都视为"未配置"（由服务层决定是否放行并告警）----
  if (!isStr(cfg.apiKey)) {
    fix('apiKey 必须是字符串，已回退为空（服务将不做鉴权）');
    cfg.apiKey = '';
  }

  // ---- 模型与站点 ----
  if (!isStr(cfg.defaultModel) || !cfg.defaultModel.trim()) {
    fix(`defaultModel 必须是非空字符串，已回退为 ${defaults.defaultModel}`);
    cfg.defaultModel = defaults.defaultModel;
  }
  if (!isStr(cfg.defaultSite) || !cfg.defaultSite.trim()) {
    fix(`defaultSite 必须是非空字符串，已回退为 ${defaults.defaultSite}`);
    cfg.defaultSite = defaults.defaultSite;
  }

  // ---- 数值字段 ----
  if (!Number.isInteger(cfg.defaultMaxTokens) || cfg.defaultMaxTokens <= 0) {
    fix(`defaultMaxTokens 必须是正整数，已回退为 ${defaults.defaultMaxTokens}`);
    cfg.defaultMaxTokens = defaults.defaultMaxTokens;
  }

  // ---- 提示词 ----
  if (cfg.defaultSystemPrompt !== undefined && !isStr(cfg.defaultSystemPrompt)) {
    fix('defaultSystemPrompt 必须是字符串，已回退为默认提示语');
    cfg.defaultSystemPrompt = defaults.defaultSystemPrompt;
  }

  // ---- 数组 / 对象字段 ----
  if (!Array.isArray(cfg.stripFields)) {
    fix('stripFields 必须是数组，已回退为 []');
    cfg.stripFields = [];
  } else if (cfg.stripFields.some((f) => !isStr(f))) {
    const kept = cfg.stripFields.filter(isStr);
    fix(`stripFields 含非字符串项，已剔除 ${cfg.stripFields.length - kept.length} 项`);
    cfg.stripFields = kept;
  }

  if (!isPlainObject(cfg.modelRoutes)) {
    fix('modelRoutes 必须是对象，已回退为 {}');
    cfg.modelRoutes = {};
  }
  if (!isPlainObject(cfg.modelAliases)) {
    fix('modelAliases 必须是对象，已回退为 {}');
    cfg.modelAliases = {};
  }
  if (!Array.isArray(cfg.models)) {
    fix('models 必须是数组，已回退为默认清单');
    cfg.models = defaults.models;
  }

  // ---- 超时（原先 timeouts:null 会让所有对话请求 500）----
  if (!isPlainObject(cfg.timeouts)) {
    fix('timeouts 必须是对象，已回退为默认值');
    cfg.timeouts = { ...defaults.timeouts };
  } else {
    for (const [k, dv] of Object.entries(defaults.timeouts)) {
      if (!isPositiveMs(cfg.timeouts[k])) {
        fix(`timeouts.${k} 必须是正数（当前 ${JSON.stringify(cfg.timeouts[k])}），已回退为 ${dv}`);
        cfg.timeouts[k] = dv;
      }
    }
  }

  // ---- 站点表（null / 非对象会让站点静默消失）----
  if (!isPlainObject(cfg.sites)) {
    fix('sites 必须是对象，已回退为内置站点预设');
    cfg.sites = structuredClone(defaults.sites);
  } else {
    for (const [key, site] of Object.entries(cfg.sites)) {
      if (!isPlainObject(site)) {
        fix(`sites.${key} 必须是对象，已移除该站点`);
        delete cfg.sites[key];
        continue;
      }
      for (const field of ['apiBase', 'billingBase', 'origin']) {
        if (!isStr(site[field]) || !site[field].trim()) {
          fix(`sites.${key}.${field} 必须是非空字符串，已回退为默认值`);
          site[field] = defaults.sites[key]?.[field] ?? '';
        }
      }
      if (site.enabled !== undefined && !isBool(site.enabled)) {
        fix(`sites.${key}.enabled 必须是布尔值，已回退为 true`);
        site.enabled = true;
      }
      if (site.seedModels !== undefined && !Array.isArray(site.seedModels)) {
        fix(`sites.${key}.seedModels 必须是数组，已回退为 []`);
        site.seedModels = [];
      }
    }
    // 站点全被移除时兜底回默认，避免服务无站点可用
    if (!Object.keys(cfg.sites).length) {
      fix('sites 校验后为空，已回退为内置站点预设');
      cfg.sites = structuredClone(defaults.sites);
    }
  }

  // ---- defaultSite 必须指向一个真实存在的站点 ----
  if (!cfg.sites[cfg.defaultSite] || cfg.sites[cfg.defaultSite].enabled === false) {
    const fallback = Object.keys(cfg.sites).find((k) => cfg.sites[k]?.enabled !== false);
    if (fallback) {
      fix(`defaultSite "${cfg.defaultSite}" 不存在或已禁用，已改用 "${fallback}"`);
      cfg.defaultSite = fallback;
    }
  }

  // ---- 别名/路由里引用的站点必须存在（否则会静默走到默认站点）----
  for (const [alias, target] of Object.entries(cfg.modelAliases)) {
    if (!isStr(target)) {
      fix(`modelAliases.${alias} 的值必须是字符串，已移除该别名`);
      delete cfg.modelAliases[alias];
    }
  }
  for (const [model, site] of Object.entries(cfg.modelRoutes)) {
    if (!isStr(site) || !cfg.sites[site]) {
      fix(`modelRoutes.${model} 指向不存在的站点 "${site}"，已移除该路由`);
      delete cfg.modelRoutes[model];
    }
  }

  return issues;
}

/** 读取配置并校验；返回 { cfg, issues }。 */
export function loadConfigChecked(opts) {
  const cfg = loadConfig();
  const issues = validateConfig(cfg);
  return { cfg, issues };
}

// 记录最近一次 loadConfig 发现的问题，供服务启动时提示。
// 之所以要单独存：loadConfig 内部已经把坏值修好了，外部再调一次 validateConfig
// 只会看到"已经合法"的配置，什么问题都报不出来。
let lastIssues = [];

/** 最近一次配置加载中发现的问题（已自动修复的项）。 */
export function getLastConfigIssues() {
  return lastIssues.slice();
}

/**
 * 读取 config.json；缺失时用默认配置落盘（含随机生成的本地 API Key）。
 *
 * @param {string} [dir] 可选：显式指定配置目录。
 *   传入时会临时切到该目录读取（读完还原），使调用不受进程内其他代码
 *   切换全局目录的影响——测试里应该用这个，而不是依赖 beforeEach 设置全局态。
 */
export function loadConfig(dir) {
  if (!dir) return loadConfigFrom(configDir);
  const restore = setConfigDir(dir);
  try {
    return loadConfigFrom(configDir);
  } finally {
    restore();
  }
}

function loadConfigFrom(dir) {
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) {
    const cfg = defaultConfig();
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    lastIssues = [];
    return cfg;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (e) {
    // 配置不是合法 JSON：不静默重置用户文件（可能只是手改漏了个逗号），
    // 而是报错并让调用方决定，避免覆盖掉用户内容。
    const err = new Error(`config.json 不是合法 JSON：${e.message}`);
    err.code = 'INVALID_CONFIG_JSON';
    throw err;
  }
  const merged = deepMerge(defaultConfig(), migrateLegacy(raw));
  const cfg = deepMerge(merged, raw);
  delete cfg.upstream; // 已迁移到 sites
  lastIssues = validateConfig(cfg);
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
