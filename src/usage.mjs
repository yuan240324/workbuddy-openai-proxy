// 用量统计：按天 / 按站点 / 按模型累计调用次数、token 与 credit 消耗，落盘到 usage.json。
// 只在本项目目录内读写；写入做了节流，避免每次请求都打盘。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.mjs';
import { warn } from './log.mjs';

// 与 config.json 同目录（跟随 setConfigDir / WB_CONFIG_DIR 变化，不冻结路径）
const file = () => path.join(paths.root, 'usage.json');
const SAVE_DELAY_MS = 3000;

let data = { days: {}, balance: {} };
let dirty = false;
let timer = null;
let loadedFrom = null;

/**
 * 「今天」的键（YYYY-MM-DD）。
 * 必须用本地日期：toISOString() 给的是 UTC 日期，东八区下一天的边界会落在早上 8 点，
 * 凌晨 0~8 点的用量会被记进前一天，「用量统计」的日切就错位了。
 */
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 确保已从当前配置目录加载过 usage.json。
 * 之所以做成惰性 + 记住来源路径：配置目录可能在运行期被切换（测试隔离），
 * 冻结在模块加载时会导致写到旧目录。
 */
function ensureLoaded() {
  const f = file();
  if (loadedFrom === f) return;
  loadedFrom = f;
  try {
    if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
    else data = { days: {}, balance: {} };
  } catch (e) {
    warn('usage.json 读取失败，重新开始统计：', e.message);
    data = { days: {}, balance: {} };
  }
  if (!data.days) data.days = {};
  if (!data.balance) data.balance = {};
}
ensureLoaded();

function saveNow() {
  dirty = false;
  try {
    fs.writeFileSync(file(), JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) {
    warn('usage.json 写入失败：', e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (dirty) saveNow();
  }, SAVE_DELAY_MS);
  timer.unref?.();
}

export function flushUsage() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (dirty) saveNow();
}

function dayOf(key = todayKey()) {
  ensureLoaded();
  if (!data.days[key]) data.days[key] = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, models: {} };
  return data.days[key];
}

/** 记录一次调用。 */
export function recordUsage({ site, model, mode, status, promptTokens = 0, completionTokens = 0, credit = 0, ms = 0, tools = 0 }) {
  const day = dayOf();
  const ok = status >= 200 && status < 400;
  day.calls += 1;
  if (!ok) day.errors += 1;
  day.promptTokens += promptTokens || 0;
  day.completionTokens += completionTokens || 0;
  day.credit += credit || 0;
  const key = `${site}/${model}`;
  if (!day.models[key]) day.models[key] = { site, model, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0, tools: 0 };
  const m = day.models[key];
  m.calls += 1;
  if (!ok) m.errors += 1;
  m.promptTokens += promptTokens || 0;
  m.completionTokens += completionTokens || 0;
  m.credit += credit || 0;
  m.ms += ms || 0;
  m.tools += tools || 0;
  scheduleSave();
}

/** 记录一次余额快照（用于画余额趋势）。 */
export function recordBalance(site, remain) {
  if (typeof remain !== 'number' || !Number.isFinite(remain)) return;
  ensureLoaded();
  const list = data.balance[site] || (data.balance[site] = []);
  const last = list[list.length - 1];
  const now = Date.now();
  // 值没变化就没必要记（去掉无意义的重复点）
  if (last && last.v === remain) return;
  // 节流：60 秒内不重复采样，避免控制台轮询（20s 一次）把数组刷满
  if (last && now - last.t < 60_000) return;
  list.push({ t: now, v: remain });
  if (list.length > 500) list.splice(0, list.length - 500);
  scheduleSave();
}

/** 汇总：今天 / 最近 N 天 / 按模型排行 / 余额趋势。 */
export function usageSnapshot(days = 7) {
  ensureLoaded();
  const today = todayKey();
  const t = data.days[today] || { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, models: {} };
  const keys = Object.keys(data.days).sort().slice(-days);
  const recent = keys.map((k) => ({ date: k, ...data.days[k], models: undefined }));
  const totals = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0 };
  const byModel = new Map();
  for (const k of Object.keys(data.days)) {
    const d = data.days[k];
    totals.calls += d.calls;
    totals.errors += d.errors;
    totals.promptTokens += d.promptTokens;
    totals.completionTokens += d.completionTokens;
    totals.credit += d.credit;
    for (const [mid, m] of Object.entries(d.models || {})) {
      const cur = byModel.get(mid) || { id: mid, site: m.site, model: m.model, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0 };
      cur.calls += m.calls;
      cur.errors += m.errors;
      cur.promptTokens += m.promptTokens;
      cur.completionTokens += m.completionTokens;
      cur.credit += m.credit;
      byModel.set(mid, cur);
    }
  }
  return {
    today: { date: today, ...t, models: undefined },
    todayByModel: Object.values(t.models || {}).sort((a, b) => b.calls - a.calls),
    recent,
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.credit - a.credit || b.calls - a.calls),
    balance: data.balance,
    since: Object.keys(data.days).sort()[0] || today,
  };
}

export function resetUsage() {
  data = { days: {}, balance: {} };
  dirty = true;
  loadedFrom = file(); // 标记为已加载，避免下次调用又把旧文件读回来
  saveNow();
}
