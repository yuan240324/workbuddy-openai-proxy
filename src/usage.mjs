// 用量统计：按天 / 按站点 / 按模型累计调用次数、token 与 credit 消耗，落盘到 usage.json。
// 只在本项目目录内读写；写入做了节流，避免每次请求都打盘。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { warn } from './log.mjs';

const FILE = path.join(ROOT, 'usage.json');
const SAVE_DELAY_MS = 3000;

let data = { days: {}, balance: {} };
let dirty = false;
let timer = null;

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function load() {
  try {
    if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    warn('usage.json 读取失败，重新开始统计：', e.message);
    data = { days: {}, balance: {} };
  }
  if (!data.days) data.days = {};
  if (!data.balance) data.balance = {};
}
load();

function saveNow() {
  dirty = false;
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
  if (typeof remain !== 'number') return;
  const list = data.balance[site] || (data.balance[site] = []);
  const last = list[list.length - 1];
  const now = Date.now();
  if (last && last.v === remain) return; // 没变化就不记
  if (last && now - last.t < 60_000 && last.v === remain) return;
  list.push({ t: now, v: remain });
  if (list.length > 500) list.splice(0, list.length - 500);
  scheduleSave();
}

/** 汇总：今天 / 最近 N 天 / 按模型排行 / 余额趋势。 */
export function usageSnapshot(days = 7) {
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
  saveNow();
}
