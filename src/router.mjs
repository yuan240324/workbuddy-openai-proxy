// 站点路由：把「模型名」映射到「哪个站点 + 该站点上的模型 ID」。
// 规则优先级：显式站点前缀 → 别名 → config.modelRoutes → 站点目录匹配（倍率最低优先） → 默认站点。
import { siteKeys } from './config.mjs';
import { isLoggedIn } from './auth.mjs';
import { fetchModels } from './upstream.mjs';
import { learnLimit } from './compress.mjs';
import { usableCount } from './pool.mjs';

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

/**
 * 模型白/黑名单（都支持 `*` 通配符，站点级 + 全局两处配置）：
 *   - allowModels 非空时，只保留命中的模型（白名单优先）
 *   - excludeModels 命中即剔除
 * 被剔除的模型不会出现在 /v1/models，也不允许被调用。
 */
export function isExcluded(cfg, site, id) {
  const 命中 = (p, v) => (p.endsWith('*') ? String(v).startsWith(p.slice(0, -1)) : p === v);
  const allow = [...(cfg.allowModels || []), ...(cfg.sites?.[site]?.allowModels || [])];
  if (allow.length && !allow.some((p) => 命中(p, id))) return true;
  const deny = [...(cfg.excludeModels || []), ...(cfg.sites?.[site]?.excludeModels || [])];
  return deny.some((p) => 命中(p, id));
}

/**
 * 说明某模型为何不可用，用于给出准确的错误提示；返回 null 表示可用。
 *
 * 为什么要单独说明：isExcluded 同时管 allowModels 白名单与 excludeModels 黑名单，
 * 但原先的错误信息一律说「在剔除名单里（excludeModels）」。
 * 当真正原因是白名单没命中时（excludeModels 其实是空的），
 * 用户会被引去改一个无关的配置项，白费时间。
 */
export function explainExcluded(cfg, site, id) {
  const 命中 = (p, v) => (p.endsWith('*') ? String(v).startsWith(p.slice(0, -1)) : p === v);
  const allow = [...(cfg.allowModels || []), ...(cfg.sites?.[site]?.allowModels || [])];
  if (allow.length && !allow.some((p) => 命中(p, id))) {
    return `不在 allowModels 白名单里（当前白名单：${allow.join('、')}）`;
  }
  const deny = [...(cfg.excludeModels || []), ...(cfg.sites?.[site]?.excludeModels || [])];
  if (deny.some((p) => 命中(p, id))) {
    return `命中 excludeModels 黑名单（当前黑名单：${deny.join('、')}）`;
  }
  return null;
}

/** 展开别名（支持链式，最多 5 层），解析不了就原样返回。 */
function expandAlias(cfg, name, depth = 0) {
  const alias = cfg.modelAliases?.[name];
  if (!alias || depth >= 5) return name;
  return expandAlias(cfg, String(alias), depth + 1);
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
  const 过滤 = (list) =>
    new Map(list.filter((m) => !isExcluded(cfg, site, m.id)).map((m) => [m.id, m]));
  /** 目录里带 maxInputTokens 的模型，顺手登记进「上下文上限」表供压缩用。 */
  const 登记上限 = (list) => {
    for (const m of list) {
      if (m?.id && m.contextWindow) learnLimit(site, m.id, m.contextWindow);
    }
  };
  try {
    const list = await fetchModels(cfg, site);
    登记上限(list);
    const entry = { at: Date.now(), ttl: TTL_OK, models: 过滤(list), error: null, source: 'upstream' };
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
    登记上限(seed);
    const models = 过滤(seed.map((m) => ({ ...m, seed: true })));
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

/**
 * 若 raw 形如 `站点/模型`、且该站点存在但已被禁用，返回站点名；否则返回 null。
 *
 * 为什么要单独识别：splitPrefix 对已禁用站点返回 null，
 * 于是 `站点/模型` 会被整体当成模型名继续往下走，
 * 最后报成「不在 allowModels 白名单里」——真正的原因是站点被禁用了，
 * 提示把人引向完全无关的配置项。
 */
function disabledSitePrefix(cfg, raw) {
  const s = String(raw);
  const slash = s.indexOf('/');
  if (slash <= 0) return null;
  const head = s.slice(0, slash);
  const site = cfg.sites?.[head];
  return site && site.enabled === false ? head : null;
}

/** 构造「站点已禁用」的错误。 */
function disabledSiteError(site, raw) {
  return Object.assign(
    new Error(`站点 ${site} 已禁用（config.json 的 sites.${site}.enabled = false），${raw} 不可用。如需启用请改为 true 并重启服务`),
    { status: 404 },
  );
}

/**
 * 该站点现在还有没有「可用账号」（启用 + 没冷却 + 没被判额度耗尽）。
 *
 * 为什么要参与选站排序：只按倍率排序时，一个**额度已经耗尽**的站点会因为倍率更低
 * 而被优先选中；降级重试也照这个顺序挑，于是从一个死站换到另一个死站。
 * 实测：请求首发 intl-cli 返回 429，降级目标被算成同样 429 的 cn-cli，
 * 而真正有额度的 intl-work（倍率未知 → Infinity，排在最后）根本没被考虑。
 *
 * 注意这是**排序优先级**而不是硬过滤：当所有候选都没有可用账号时，
 * 排序结果与改动前完全一致，仍然会发一次请求（额度可能已经重置了）。
 */
function 有可用账号(site) {
  try {
    return usableCount(site) > 0;
  } catch {
    // 读池失败不该影响路由，按「可能有」处理以保持原有行为
    return true;
  }
}

/**
 * 站点候选排序：① 还有可用账号的优先 ② 倍率低的优先（倍率未知视作最贵）
 * ③ 同级时偏向 config.defaultSite。
 *
 * 抽成纯函数有两个目的：消除「降级选站」与「目录匹配选站」两处重复的比较器，
 * 并且让这段最容易回归的排序逻辑能被单测覆盖（它依赖的 getCatalog 需要真实上游，
 * 直接测 computeFallback 是测不了的）。
 */
export function rankSiteCandidates(candidates, defaultSite) {
  return [...candidates].sort(
    (a, b) =>
      Number(Boolean(b.usable)) - Number(Boolean(a.usable)) ||
      a.mult - b.mult ||
      (a.site === defaultSite ? -1 : 1),
  );
}

/** 计算备用站点：除了「首选站点」以外，还有哪些站点真的拥有该模型。 */
async function computeFallback(cfg, 首选站点, 目标模型) {
  const 备选 = [];
  for (const s of siteKeys(cfg)) {
    if (s === 首选站点) continue;
    const cat = await getCatalog(cfg, s);
    const info = cat.models.get(目标模型);
    if (info) 备选.push({ site: s, mult: parseMultiplier(info.credits), usable: 有可用账号(s) });
  }
  const 排序 = rankSiteCandidates(备选, cfg.defaultSite);
  return 排序.length ? { site: 排序[0].site, model: 目标模型 } : null;
}

/**
 * 解析请求里的模型 → { site, model, requested, fallback? }。
 *
 * 外层包一层「确保目标站点的目录已加载」：目录里带 maxInputTokens，
 * 加载时会登记进压缩模块的上限表。少了这一步，走显式前缀（`cn-cli/xxx`）
 * 的请求可能整条路径都不碰目录，压缩就因为没有上限而完全不触发
 * —— 表现为长上下文照样吃 400。
 */
export async function resolveTarget(cfg, requestedModel) {
  const target = await resolveTargetInner(cfg, requestedModel);
  try {
    await getCatalog(cfg, target.site);
  } catch {
    /* 目录拿不到不影响主流程，压缩会退化成「按比例收缩」 */
  }
  return target;
}

async function resolveTargetInner(cfg, requestedModel) {
  let raw = String(requestedModel || '').trim();
  const sites = siteKeys(cfg);
  if (!raw) raw = cfg.defaultModel;

  // 0) 特殊别名：客户端只配一个 `default` 模型，之后切换模型全在控制台完成
  if (raw.toLowerCase() === 'default' || raw.toLowerCase() === 'current') {
    raw = expandAlias(cfg, raw) === raw ? cfg.defaultModel : expandAlias(cfg, raw);
  }

  // 0.5) 站点存在但已禁用：明确报出真实原因，不要当成模型名继续往下走
  const 禁用站点 = disabledSitePrefix(cfg, raw);
  if (禁用站点) throw disabledSiteError(禁用站点, raw);

  // 1) 显式站点前缀：`站点/模型`。前缀后面也可能是个别名（如 intl-cli/claude），需要再展开
  const direct = splitPrefix(cfg, raw);
  if (direct) {
    const 展开 = expandAlias(cfg, direct.model);
    const 再前缀 = splitPrefix(cfg, 展开);
    const site = 再前缀 ? 再前缀.site : direct.site;
    const model = 再前缀 ? 再前缀.model : 展开;
    if (isExcluded(cfg, site, model)) {
      throw Object.assign(new Error(`模型 ${model} 在 ${site} 站点不可用：${explainExcluded(cfg, site, model)}`), { status: 404 });
    }
    return { site, model, requested: raw, fallback: await computeFallback(cfg, site, model) };
  }

  // 2) 别名映射（别名值本身也可以是 `站点/模型`）
  const model = expandAlias(cfg, raw);
  // 别名可能指向一个已禁用的站点，同样要报出真实原因
  const 别名禁用 = disabledSitePrefix(cfg, model);
  if (别名禁用) throw disabledSiteError(别名禁用, model);
  const viaAlias = splitPrefix(cfg, model);
  const 目标站点 = viaAlias ? viaAlias.site : null;
  const 目标模型 = viaAlias ? viaAlias.model : model;
  if (目标站点) {
    if (isExcluded(cfg, 目标站点, 目标模型)) {
      throw Object.assign(new Error(`模型 ${目标模型} 在 ${目标站点} 站点不可用：${explainExcluded(cfg, 目标站点, 目标模型)}`), { status: 404 });
    }
    return { site: 目标站点, model: 目标模型, requested: raw, fallback: await computeFallback(cfg, 目标站点, 目标模型) };
  }

  // 3) 显式路由表（用户刻意把某些模型钉到某个站点，例如为了走国际版）。
  //    只有在「目标站点拿到了真实的动态目录、且目录里明确没有这个模型」时才忽略该路由；
  //    内置清单（seed）本身不完整，不能用它否定路由表，否则会误判（把国际版能用但没列进
  //    清单的模型错误地打回国内版）。
  const route = cfg.modelRoutes?.[目标模型];
  if (route && cfg.sites?.[route]) {
    const routeCat = await getCatalog(cfg, route);
    const 目录可信 = String(routeCat.source || '').startsWith('upstream');
    if (目录可信 && !routeCat.models.has(目标模型)) {
      if (process.env.WB_ROUTE_DEBUG) {
        console.log(`[调试] 路由表把 ${目标模型} 钉到 ${route}，但该站点动态目录里没有它 → 忽略该路由，改为自动选站点`);
      }
    } else {
      if (isExcluded(cfg, route, 目标模型)) {
        throw Object.assign(new Error(`模型 ${目标模型} 在 ${route} 站点不可用：${explainExcluded(cfg, route, 目标模型)}`), { status: 404 });
      }
      // 备用站点：万一目标站点其实没有这个模型（内置清单不全，事先判断不出），
      // 上游会回 "service info not found"；或者目标站点网络抖动导致连接失败（504），
      // 届时据此自动降级重试一次。
      return {
        site: route,
        model: 目标模型,
        requested: raw,
        fallback: await computeFallback(cfg, route, 目标模型),
      };
    }
  }

  // 4) 目录匹配：多站点都有该模型时，优先选「还有可用账号」的，再选倍率最低的（未知倍率排最后）
  const hits = [];
  if (process.env.WB_ROUTE_DEBUG) console.log('[调试] 目标模型=' + 目标模型 + '　站点列表=' + sites.join(','));
  for (const s of sites) {
    const cat = await getCatalog(cfg, s);
    const info = cat.models.get(目标模型);
    if (process.env.WB_ROUTE_DEBUG) console.log('[调试]   ' + s + ' 目录' + cat.models.size + '个(来源' + cat.source + ') 命中=' + (info ? '是' : '否') + (info ? ' 倍率=' + info.credits + '→' + parseMultiplier(info.credits) : ''));
    if (info) hits.push({ site: s, mult: parseMultiplier(info.credits), usable: 有可用账号(s) });
  }
  if (process.env.WB_ROUTE_DEBUG) console.log('[调试] 命中集合=' + JSON.stringify(hits));
  if (hits.length) {
    const 排序 = rankSiteCandidates(hits, cfg.defaultSite);
    if (process.env.WB_ROUTE_DEBUG) console.log('[调试] 排序后=' + JSON.stringify(排序) + ' → 选 ' + 排序[0].site);
    return { site: 排序[0].site, model: 目标模型, requested: raw };
  }

  // 5) 兜底：默认站点。若该模型被全局剔除，直接报错而不是发一个注定失败的请求
  if (isExcluded(cfg, cfg.defaultSite, 目标模型)) {
    throw Object.assign(
      new Error(`模型 ${目标模型} 不可用：${explainExcluded(cfg, cfg.defaultSite, 目标模型)}（检查 config.json 的 allowModels / excludeModels）`),
      { status: 404 },
    );
  }
  return { site: cfg.defaultSite, model: 目标模型, requested: raw };
}

/**
 * 合并所有站点目录，供 GET /v1/models 使用：
 *   - 只输出裸模型 ID（同名模型取倍率最低的站点），保证客户端（CCSM / Codex 等）拿到的是干净可用的名字
 *   - 需要同时暴露 `站点/模型` 变体时，把 config.json 的 exposeSitePrefixed 设为 true
 *     （带斜杠的 ID 部分客户端不认，默认关闭；路由上的前缀写法始终可用）
 */
export async function mergedModels(cfg) {
  const sites = siteKeys(cfg);
  const byId = new Map();
  for (const s of sites) {
    const cat = await getCatalog(cfg, s);
    for (const m of cat.models.values()) {
      const mult = parseMultiplier(m.credits);
      const cur = byId.get(m.id);
      if (!cur) {
        byId.set(m.id, { info: m, best: s, bestMult: mult, sites: [{ site: s, mult }] });
      } else {
        cur.sites.push({ site: s, mult });
        // 同倍率时优先默认站点
        if (mult < cur.bestMult || (mult === cur.bestMult && s === cfg.defaultSite)) {
          cur.best = s;
          cur.bestMult = mult;
        }
      }
    }
  }
  const out = [];
  for (const [id, v] of byId) {
    out.push({ id, site: v.best, info: v.info, mult: v.bestMult });
    if (!cfg.exposeSitePrefixed) continue;
    for (const alt of v.sites) {
      if (alt.site === v.best) continue;
      out.push({ id: `${alt.site}/${id}`, site: alt.site, info: v.info, mult: alt.mult, aliasOf: id });
    }
  }
  return out;
}
