// Usage ledger + budgets (spec 007 R4/R5). Every metered model call writes one
// llm_usage row; budgets are checked against an in-memory month-to-date map
// (seeded by one SUM per month, so a check costs no query). "Month" is the
// calendar month in config.timezone.
//
// Never throws into a caller: a ledger failure must not fail a model call
// (one warn per minute). The tables are created by the migration step
// src/memory/migrations/007-llm-usage.js (ladder v7) — this module never creates them.
//
// Cost: provider-reported value (OpenRouter / Jev usage.cost, xAI usage.cost_in_usd_ticks) → price table
// (data/llm-prices.json over the committed src/brain/llm-prices.example.json) →
// NULL ("unpriced"). Unpriced spend counts tokens but adds $0 to budgets (O2).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../memory/db.js';
import { emitDashboardEvent } from '../dashboard/events.js';
import { ROLE_NAMES, METERED_LABELS } from './roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PRICES = path.join(__dirname, 'llm-prices.example.json');
const OWNER_PRICES = path.join(config.projectRoot, 'data', 'llm-prices.json');

const MAX_COST_PER_CALL = 100; // USD; a provider value outside [0, 100] is clamped
const RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;

export class BudgetError extends Error {
  constructor(name, state = {}) {
    super(`budget exhausted for ${name} (${state.reason || 'budget'})`);
    this.name = 'BudgetError';
    this.role = name;
    this.state = state;
  }
}

// ── clock (overridable in tests) ──────────────────────────────────────────────
let nowFn = () => Date.now();

// ── warn throttle ─────────────────────────────────────────────────────────────
let lastWarnAt = 0;
function warnThrottled(err, msg) {
  const t = Date.now();
  if (t - lastWarnAt < 60_000) return;
  lastWarnAt = t;
  logger.warn({ err: err?.message }, msg);
}

// ── month in config.timezone ──────────────────────────────────────────────────
const fmtCache = new Map();
function tzFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return fmtCache.get(tz);
}

function zonedParts(ms, tz) {
  const parts = {};
  for (const p of tzFormatter(tz).formatToParts(new Date(ms))) parts[p.type] = Number(p.value);
  return parts;
}

function safeTz() {
  const tz = config.timezone || 'UTC';
  try { tzFormatter(tz); return tz; } catch { return 'UTC'; }
}

/** 'YYYY-MM' of `ms` in config.timezone. */
export function monthKey(ms = nowFn()) {
  const p = zonedParts(ms, safeTz());
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** Epoch seconds of the first instant of `ms`'s month in config.timezone. */
export function monthStartTs(ms = nowFn()) {
  const tz = safeTz();
  const p = zonedParts(ms, tz);
  const wallUtc = Date.UTC(p.year, p.month - 1, 1, 0, 0, 0);
  let guess = wallUtc;
  for (let i = 0; i < 3; i++) {
    const q = zonedParts(guess, tz);
    const asUtc = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
    guess = wallUtc - (asUtc - guess);
  }
  return Math.floor(guess / 1000);
}

function tzOffsetSeconds(ms = nowFn()) {
  const p = zonedParts(ms, safeTz());
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 1000);
}

// ── month-to-date spend ───────────────────────────────────────────────────────
let mtd = null; // { key, byName: Map<name, usd>, total, retryAt }

function seedMonth(key) {
  const state = { key, byName: new Map(), total: 0, retryAt: 0 };
  try {
    const rows = getDb().prepare(
      'SELECT role, SUM(cost_usd) AS usd FROM llm_usage WHERE ts >= ? AND cost_usd IS NOT NULL GROUP BY role',
    ).all(monthStartTs());
    for (const r of rows) {
      const usd = Number(r.usd) || 0;
      state.byName.set(r.role, usd);
      state.total += usd;
    }
  } catch (err) {
    // Table missing (migrations not run) or DB unavailable: budgets fail open; retry later.
    state.retryAt = nowFn() + 60_000;
    warnThrottled(err, 'llm_usage month-to-date seed failed — budgets unchecked until it works');
  }
  return state;
}

function ensureMonth() {
  const key = monthKey();
  if (!mtd || mtd.key !== key || (mtd.retryAt && nowFn() >= mtd.retryAt)) {
    const carried = mtd && mtd.key === key && mtd.retryAt ? mtd : null;
    mtd = seedMonth(key);
    // A failed seed retried in the same month keeps what was added in memory meanwhile.
    if (carried && mtd.retryAt) mtd = { ...carried, retryAt: mtd.retryAt };
  }
  return mtd;
}

function addSpend(name, usd) {
  if (!(usd > 0)) return;
  const m = ensureMonth();
  m.byName.set(name, (m.byName.get(name) || 0) + usd);
  m.total += usd;
}

/**
 * Budget state of a role or metered label right now.
 *   → { allowed, reason: null|'role'|'global', spentUsd, budgetUsd, globalSpentUsd, globalBudgetUsd }
 * A budget of 0 means "none". Unpriced spend never counts.
 */
export function budgetState(name) {
  const m = ensureMonth();
  const budgetUsd = Number(config.roles?.[name]?.budgetUsd) || 0;
  const spentUsd = m.byName.get(name) || 0;
  const globalBudgetUsd = Number(config.llm.monthlyBudgetUsd) || 0;
  const globalSpentUsd = m.total;
  let reason = null;
  if (budgetUsd > 0 && spentUsd >= budgetUsd) reason = 'role';
  else if (globalBudgetUsd > 0 && globalSpentUsd >= globalBudgetUsd) reason = 'global';
  return { allowed: !reason, reason, spentUsd, budgetUsd, globalSpentUsd, globalBudgetUsd };
}

// ── prices ────────────────────────────────────────────────────────────────────
let priceOverride = null; // tests only
let priceCache = { table: null, checkedAt: 0, sig: '' };

function readJson(file) {
  try {
    const st = fs.statSync(file);
    return { sig: `${file}:${st.mtimeMs}:${st.size}`, data: JSON.parse(fs.readFileSync(file, 'utf-8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') warnThrottled(err, `could not read price table ${path.basename(file)}`);
    return { sig: `${file}:none`, data: null };
  }
}

function priceTable() {
  if (priceOverride) return priceOverride;
  const t = Date.now();
  if (priceCache.table && t - priceCache.checkedAt < 30_000) return priceCache.table;
  const ex = readJson(EXAMPLE_PRICES);
  const own = readJson(OWNER_PRICES);
  const sig = ex.sig + '|' + own.sig;
  if (!priceCache.table || sig !== priceCache.sig) {
    const table = {};
    for (const src of [ex.data, own.data]) {
      if (!src || typeof src !== 'object') continue;
      for (const [k, v] of Object.entries(src)) {
        if (k.startsWith('_') || !v || typeof v !== 'object') continue;
        table[k] = v;
      }
    }
    priceCache = { table, checkedAt: t, sig };
  } else {
    priceCache.checkedAt = t;
  }
  return priceCache.table;
}

function lookupPrice(provider, model) {
  const table = priceTable();
  return table[`${provider}/${model}`] || table[`*/${model}`] || null;
}

const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (usd) => Math.min(MAX_COST_PER_CALL, Math.max(0, usd));

/**
 * Cost of one call. → { costUsd: number|null, source: 'provider'|'table'|'unknown' }
 * usage: { input, output, cacheRead, cacheWrite } (any may be missing).
 */
export function costFor({ provider, model, usage = {}, providerCost } = {}) {
  const pc = typeof providerCost === 'string' && providerCost.trim() !== '' ? Number(providerCost) : providerCost;
  if (typeof pc === 'number' && Number.isFinite(pc)) return { costUsd: clamp(pc), source: 'provider' };

  const price = lookupPrice(provider, model);
  if (!price) return { costUsd: null, source: 'unknown' };
  const u = usage || {};
  const tok = {
    input: finiteOrNull(u.input) || 0,
    output: finiteOrNull(u.output) || 0,
    cacheRead: finiteOrNull(u.cacheRead) || 0,
    cacheWrite: finiteOrNull(u.cacheWrite) || 0,
  };
  const anyTokens = tok.input + tok.output + tok.cacheRead + tok.cacheWrite > 0;
  const perCall = finiteOrNull(price.perCall);
  if (!anyTokens) {
    return perCall !== null ? { costUsd: clamp(perCall), source: 'table' } : { costUsd: null, source: 'unknown' };
  }
  const inP = finiteOrNull(price.inputPerM);
  const outP = finiteOrNull(price.outputPerM);
  if (inP === null && outP === null) {
    return perCall !== null ? { costUsd: clamp(perCall), source: 'table' } : { costUsd: null, source: 'unknown' };
  }
  const readP = finiteOrNull(price.cacheReadPerM) ?? inP ?? 0;
  const writeP = finiteOrNull(price.cacheWritePerM) ?? inP ?? 0;
  const usd = (tok.input * (inP ?? 0) + tok.output * (outP ?? 0) + tok.cacheRead * readP + tok.cacheWrite * writeP) / 1e6
    + (perCall ?? 0);
  return Number.isFinite(usd) ? { costUsd: clamp(usd), source: 'table' } : { costUsd: null, source: 'unknown' };
}

// ── dashboard event (throttled to 1/s, trailing) ──────────────────────────────
let lastEmitAt = 0;
let emitTimer = null;
let pendingEvt = null;
function emitUsage(evt) {
  pendingEvt = evt;
  const t = Date.now();
  const fire = () => {
    lastEmitAt = Date.now();
    emitTimer = null;
    const e = pendingEvt;
    pendingEvt = null;
    if (e) emitDashboardEvent('usage', e);
  };
  if (t - lastEmitAt >= 1000 && !emitTimer) return fire();
  if (!emitTimer) {
    emitTimer = setTimeout(fire, Math.max(0, 1000 - (t - lastEmitAt)));
    emitTimer.unref?.();
  }
}

// ── prune ─────────────────────────────────────────────────────────────────────
let lastPruneAt = 0;
function maybePrune(db) {
  const t = nowFn();
  if (t - lastPruneAt < DAY_MS) return;
  lastPruneAt = t;
  try {
    const cutoff = Math.floor(t / 1000) - RETENTION_DAYS * 86_400;
    const r = db.prepare('DELETE FROM llm_usage WHERE ts < ?').run(cutoff);
    if (r.changes) logger.info({ deleted: r.changes }, 'llm_usage pruned (> 180 days)');
  } catch (err) {
    warnThrottled(err, 'llm_usage prune failed');
  }
}

const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);

/**
 * Write one ledger row. Never throws. → { costUsd, source }
 * row: { role, provider, model, usage:{input,output,cacheRead,cacheWrite}, providerCost,
 *        latencyMs, fellBack, ok, status, caller }
 */
export function recordUsage(row = {}) {
  let cost = { costUsd: null, source: 'unknown' };
  try {
    const role = String(row.role || 'mouth');
    const provider = String(row.provider || 'unknown');
    const model = String(row.model || 'unknown');
    const usage = row.usage || {};
    cost = row.status === 'budget' || row.status === 'no_key' || row.status === 'unroutable'
      ? { costUsd: null, source: 'unknown' }
      : costFor({ provider, model, usage, providerCost: row.providerCost });
    addSpend(role, cost.costUsd);

    const ts = Math.floor(nowFn() / 1000);
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO llm_usage (ts, role, provider, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd, cost_source, latency_ms, fell_back, ok, status, caller)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ts, role, provider, model,
        intOrNull(usage.input), intOrNull(usage.output), intOrNull(usage.cacheRead), intOrNull(usage.cacheWrite),
        cost.costUsd, cost.source, intOrNull(row.latencyMs),
        row.fellBack ? 1 : 0, row.ok === false ? 0 : 1,
        row.status ? String(row.status).slice(0, 40) : null,
        row.caller ? String(row.caller).slice(0, 60) : null,
      );
      maybePrune(db);
    } catch (err) {
      warnThrottled(err, 'llm_usage write failed (call unaffected)');
    }
    emitUsage({ role, provider, model, costUsd: cost.costUsd, ok: row.ok !== false, fellBack: !!row.fellBack });
  } catch (err) {
    warnThrottled(err, 'recordUsage failed (call unaffected)');
  }
  return cost;
}

// ── reads for the dashboard ───────────────────────────────────────────────────
const clampDays = (d) => Math.min(180, Math.max(1, Math.round(Number(d) || 30)));

/** Per role per day (days in config.timezone). */
export function getUsageByDay(days = 30) {
  const n = clampDays(days);
  try {
    const since = Math.floor(nowFn() / 1000) - n * 86_400;
    return getDb().prepare(`
      SELECT strftime('%Y-%m-%d', ts + ?, 'unixepoch') AS day, role,
             COUNT(*) AS calls,
             SUM(fell_back) AS fellBack,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
             COALESCE(SUM(input_tokens), 0) AS input,
             COALESCE(SUM(output_tokens), 0) AS output,
             COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
             COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
             COALESCE(SUM(cost_usd), 0) AS costUsd,
             SUM(CASE WHEN cost_source = 'unknown' AND COALESCE(status, 'ok') NOT IN ('budget', 'no_key', 'unroutable')
                      THEN 1 ELSE 0 END) AS unpricedCalls
      FROM llm_usage WHERE ts >= ?
      GROUP BY day, role ORDER BY day DESC, role
    `).all(tzOffsetSeconds(), since);
  } catch (err) {
    warnThrottled(err, 'llm_usage read failed');
    return [];
  }
}

/** Models that ran without a price in the last `days`. */
export function getUnpricedModels(days = 30) {
  const n = clampDays(days);
  try {
    const since = Math.floor(nowFn() / 1000) - n * 86_400;
    return getDb().prepare(`
      SELECT provider, model, COUNT(*) AS calls FROM llm_usage
      WHERE ts >= ? AND cost_source = 'unknown' AND COALESCE(status, 'ok') NOT IN ('budget', 'no_key', 'unroutable')
      GROUP BY provider, model ORDER BY calls DESC
    `).all(since);
  } catch (err) {
    warnThrottled(err, 'llm_usage read failed');
    return [];
  }
}

/**
 * Models that ran without a price for callers starting with `prefix`, since `sinceUnix` (seconds), for a $ gate: a read error is
 * rethrown so the gate can fail closed. Status rows that never reached a model (budget, no key, unroutable) don't count.
 * @returns {Array<{ provider, model, calls }>}
 */
export function getUnpricedByCallerStrict(prefix, sinceUnix) {
  const p = String(prefix ?? '').slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`);
  const since = Number.isFinite(Number(sinceUnix)) ? Math.max(0, Math.floor(Number(sinceUnix))) : 0;
  return getDb().prepare(`
    SELECT provider, model, COUNT(*) AS calls FROM llm_usage
    WHERE ts >= ? AND caller IS NOT NULL AND caller LIKE ? || '%' ESCAPE '\\' AND cost_source = 'unknown'
      AND COALESCE(status, 'ok') NOT IN ('budget', 'no_key', 'unroutable')
    GROUP BY provider, model
  `).all(since, p);
}

/**
 * Calls, cost and tokens per caller label starting with `prefix` (e.g. 'mind.'), since
 * `sinceUnix` (seconds). Read-only; `_`/`%` in the prefix match literally. Never throws.
 * @returns {Array<{ caller, calls, costUsd, input, output }>}
 */
export function getUsageByCaller(prefix, sinceUnix) {
  try {
    return getUsageByCallerStrict(prefix, sinceUnix);
  } catch (err) {
    warnThrottled(err, 'llm_usage read failed');
    return [];
  }
}

/**
 * getUsageByCaller for spend/count GATES: a read error is rethrown instead of
 * reading as "nothing spent", so the gate can fail closed (spec 011 review R1).
 * @returns {Array<{ caller, calls, costUsd, input, output }>}
 */
export function getUsageByCallerStrict(prefix, sinceUnix) {
  const p = String(prefix ?? '').slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`);
  const since = Number.isFinite(Number(sinceUnix)) ? Math.max(0, Math.floor(Number(sinceUnix))) : 0;
  return getDb().prepare(`
    SELECT caller, COUNT(*) AS calls,
           COALESCE(SUM(cost_usd), 0) AS costUsd,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output
    FROM llm_usage WHERE ts >= ? AND caller IS NOT NULL AND caller LIKE ? || '%' ESCAPE '\\'
    GROUP BY caller ORDER BY costUsd DESC, calls DESC, caller
  `).all(since, p);
}

/** Month-to-date vs budget per role/label, plus the global cap (name 'global'). */
export function getBudgets() {
  const m = ensureMonth();
  const out = [...ROLE_NAMES, ...METERED_LABELS].map((name) => {
    const budgetUsd = Number(config.roles?.[name]?.budgetUsd) || 0;
    const spentUsd = m.byName.get(name) || 0;
    return { name, budgetUsd, spentUsd, state: budgetUsd > 0 ? (spentUsd >= budgetUsd ? 'over' : 'ok') : 'none' };
  });
  const g = Number(config.llm.monthlyBudgetUsd) || 0;
  out.push({ name: 'global', budgetUsd: g, spentUsd: m.total, state: g > 0 ? (m.total >= g ? 'over' : 'ok') : 'none' });
  return out;
}

// ── test hooks ────────────────────────────────────────────────────────────────
export const __test = {
  setNow(fn) { nowFn = typeof fn === 'function' ? fn : () => Date.now(); mtd = null; },
  setPrices(table) { priceOverride = table || null; },
  reset() { mtd = null; lastPruneAt = 0; lastWarnAt = 0; },
};
