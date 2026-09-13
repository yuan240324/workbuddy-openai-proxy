// 站点路由：把「模型名」映射到「哪个站点 + 该站点上的模型 ID」。
// 规则优先级：显式站点前缀 → 别名 → config.modelRoutes → 站点目录匹配（倍率最低优先） → 默认站点。
import { siteKeys, isDeepSeekSite } from './config.mjs';
import { isLoggedIn } from './auth.mjs';
import { fetchModels } from './upstream.mjs';
import { deepseekModels } from './deepseek-adapter.mjs';

const TTL_OK = 5 * 60 * 1000;
const TTL_ERR = 60 * 1000;
const catalogs = new Map(); // site → { at, ttl, models: Map, error }

/** 把上游的倍率串（"x0.79 credits"）解析成数字；无法解析返回 Infinity（视为最贵）。 */
export function parseMultiplier(credits) {
  if (!credits) return Number.POSITIVE_INFINITY;
  const m = String(credits).match(/x\s*([\d.]+)/i);
  if (!m) return Number.POSITIVE_INFINITY;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** 取站点模型目录（带缓存）。动态接口不可用时回落到站点内置清单（seedModels）。 */
export async function getCatalog(cfg, site, { force = false } = {}) {
  const cached = catalogs.get(site);
  if (!force && cached && Date.now() - cached.at < cached.ttl) return cached;

  if (!isLoggedIn(site)) {
    const entry = { at: Date.now(), ttl: TTL_ERR, models: new Map(), error: '未登录', source: 'none' };
    catalogs.set(site, entry);
    return entry;
  }
  // DeepSeek 官方站点没有可拉取的模型目录接口，直接用站点预设清单
  if (isDeepSeekSite(cfg.sites?.[site])) {
    const models = new Map(deepseekModels(cfg, site).map((m) => [m.id, m]));
    const entry = { at: Date.now(), ttl: TTL_OK, models, error: null, source: 'seed' };
    catalogs.set(site, entry);
    return entry;
  }
  try {
    const list = await fetchModels(cfg, site);
    const entry = { at: Date.now(), ttl: TTL_OK, models: new Map(list.map((m) => [m.id, m])), error: null, source: 'upstream' };
    catalogs.set(site, entry);
    return entry;
  } catch (e) {
    const prev = catalogs.get(site);
    // 之前成功拉过动态目录 → 继续用缓存，避免被内置清单覆盖
    if (prev?.source?.startsWith('upstream') && prev.models.size) {
      const entry = { at: Date.now(), ttl: TTL_ERR, models: prev.models, error: e.message, source: 'upstream(cache)' };
      catalogs.set(site, entry);
      return entry;
    }
    // 动态目录不可用（如国际版控制台接口被网关限制）→ 用站点内置清单兜底
    const seed = cfg.sites[site]?.seedModels || [];
    const models = new Map(seed.map((m) => [m.id, { ...m, seed: true }]));
    const entry = {
      at: Date.now(),
      ttl: models.size ? TTL_ERR : TTL_OK,
      models,
      error: e.message,
      source: models.size ? 'seed' : 'none',
    };
    catalogs.set(site, entry);
    return entry;
  }
}

/** 解析 `站点/模型` 前缀；不是已知站点则返回 null。 */
function splitPrefix(cfg, raw) {
  const slash = raw.indexOf('/');
  if (slash <= 0) return null;
  const head = raw.slice(0, slash);
  if (cfg.sites?.[head] && cfg.sites[head].enabled !== false) return { site: head, model: raw.slice(slash + 1) };
  return null;
}

/** 解析请求里的模型 → { site, model, requested }。 */
export async function resolveTarget(cfg, requestedModel) {
  let raw = String(requestedModel || '').trim();
  const sites = siteKeys(cfg);
  if (!raw) raw = cfg.defaultModel;

  // 0) 特殊别名：客户端只配一个 `default` 模型，之后切换模型全在控制台完成
  if (raw.toLowerCase() === 'default' || raw.toLowerCase() === 'current') {
    raw = cfg.modelAliases?.[raw] || cfg.defaultModel;
  }

  // 1) 显式站点前缀：intl-cli/glm-5.3、cn-cli/hy3
  const direct = splitPrefix(cfg, raw);
  if (direct) return { site: direct.site, model: direct.model, requested: raw };

  // 2) 别名映射（别名值本身也可以是 `站点/模型`）
  const alias = cfg.modelAliases?.[raw];
  const viaAlias = alias ? splitPrefix(cfg, String(alias)) : null;
  if (viaAlias) return { site: viaAlias.site, model: viaAlias.model, requested: raw };
  const model = alias || raw;

  // 3) 显式路由表
  const route = cfg.modelRoutes?.[model];
  if (route && cfg.sites?.[route]) return { site: route, model, requested: raw };

  // 4) 目录匹配：多站点都有该模型时，选倍率最低的（未知倍率排最后）
  const hits = [];
  for (const s of sites) {
    const cat = await getCatalog(cfg, s);
    const info = cat.models.get(model);
    if (info) hits.push({ site: s, mult: parseMultiplier(info.credits) });
  }
  if (hits.length) {
    hits.sort((a, b) => a.mult - b.mult || (a.site === cfg.defaultSite ? -1 : 1));
    return { site: hits[0].site, model, requested: raw };
  }

  return { site: cfg.defaultSite, model, requested: raw };
}

/**
 * 合并所有站点目录，供 GET /v1/models 使用：
 *   - 裸 ID：只出现一次，取倍率最低的站点
 *   - 前缀 ID（site/model）：每个拥有该模型的站点各一条，便于客户端固定站点
 */
export async function mergedModels(cfg) {
  const sites = siteKeys(cfg);
  const byId = new Map();
  for (const s of sites) {
    const cat = await getCatalog(cfg, s);
    for (const m of cat.models.values()) {
      const mult = parseMultiplier(m.credits);
      const cur = byId.get(m.id);
      if (!cur) byId.set(m.id, { info: m, best: s, bestMult: mult, sites: [{ site: s, mult }] });
      else {
        cur.sites.push({ site: s, mult });
        if (mult < cur.bestMult) {
          cur.best = s;
          cur.bestMult = mult;
        }
      }
    }
  }
  const out = [];
  for (const [id, v] of byId) {
    out.push({ id, site: v.best, info: v.info, mult: v.bestMult });
    for (const alt of v.sites) {
      if (alt.site === v.best) continue;
      out.push({ id: `${alt.site}/${id}`, site: alt.site, info: v.info, mult: alt.mult, aliasOf: id });
    }
  }
  return out;
}
