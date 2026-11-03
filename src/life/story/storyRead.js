// The continuity story read (spec 015 §P2.4): ONE mind call that reads a
// previewed change against the recent story and returns extra warnings and at
// most 4 small suggested fixes — drafts of ordinary Director actions, checked
// exactly like the Director prompt's (validatePromptOutput, a dry plan WITHOUT
// relax). It writes nothing: no world event, no story row, no stored text. The
// owner adds a suggestion to the preview (a bundle) and applies it, or not.
//
//   runStoryRead(previewId, {by})   the preview entry → re-plan at its clock
//       (a different fingerprint → StoryError stale, before any spend) → the
//       per-fingerprint cache → gates → one callRole('mind', …,
//       {caller:'director.continuity'}) → validateContinuityOutput → drafts.
//       Resolves { status: ok|invalid_output|model_failed|skipped|refused, reason?,
//       warnings, suggestions, dropped, model, fellBack, usage:{today, cap}, called, cached }.
//
// Gates, in order (each refusal costs nothing): ARCS_CONTINUITY_MAX_PER_DAY > 0,
// the day count from the ledger (a read error = cap reached), the own $ sub-cap,
// the shared arcs cap (life.arcs.* + director.prompt + director.continuity under
// ARCS_MIND_BUDGET_USD), 008's mindBudgetOk('think') (absent → refused), one at a
// time.
//
// What the model sees (privacy, the threat table's first row): the Director
// prompt's catalogue, which since 020 lists chat-made plans by codes only (id, kind,
// relative time, placeId, castIds, marked fromChat / realPerson; never a label, subject
// or JID); the change's summary and the planned events NOT made from a chat; the code
// findings NOT touching chat state; the projection's rows and decisions minus every
// chat-derived one; the last 14 days of self/owner story events. Never chat text,
// claims, tray reviews, subjects, the rewind report of a retcon, the journal, people
// data, real names or JIDs. Logging: codes and counts.

import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { now as clockNow, dateKey, dayStart, addDays, hhmm as clockHhmm, resolveTimezone } from '../clock.js';
import { listEvents, getEvent, EVENT_TYPES } from '../eventLog.js';
import { realPeopleNames, textNameCollisions } from '../world.js';
import { cleanItem, fence, continuityCharter } from './charter.js';
import { validateContinuityOutput } from './schema.js';
import { arcsCallerSpend } from './seed.js';
import { chatRefsOf, decisionFromChat } from './continuity.js';
import * as directorMod from './director.js';
import * as promptMod from './prompt.js';

const HOUR = 3600;
const DAY = 86400;
export const CONTINUITY_CALLER = 'director.continuity';
export const STATE_MAX = 8192;
export const CHANGE_MAX = 4096;
const CALL_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 1200;
const CACHE_MAX = 20;
const RECENT_DAYS = 14;
const RECENT_MAX = 30;
const ROWS_MAX = 40;
const SHARED_PREFIXES = Object.freeze(['life.arcs.', promptMod.PROMPT_CALLER, CONTINUITY_CALLER]);
// The non-destructive allow-list (plan §P2.4 step 6): small fixes only.
const ALLOWED_SCENES = new Set(['outing', 'visit', 'cast.beat']);
const ALLOWED_KINDS = new Set(['goal', 'weather', 'decision.pick', 'mood']);
const RECENT_TYPES = ['arc.started', 'arc.stage', 'arc.ended', 'cast.beat', 'cast.history_added', 'career.set', 'career.job_changed',
  'career.resigned', 'self.moved', 'money.adjusted', 'heavy.started', 'heavy.ended', 'cast.departed', 'cast.returned', 'cast.created'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const err = (code, reason) => new directorMod.StoryError(code, reason);

/** May a story-read suggestion be offered at all? (outing / visit / cast beat scenes, goal, weather, pick, outcome cancelled, mood) */
export function suggestionAllowed(action) {
  if (!isObj(action)) return false;
  if (action.kind === 'scene') return ALLOWED_SCENES.has(action.shape) && !action.newCast && !action.newPlace;
  if (action.kind === 'outcome') return action.outcome === 'cancelled';
  return ALLOWED_KINDS.has(action.kind);
}

const allowedList = () => {
  const kinds = new Set(directorMod.PROMPT_ACTION_KINDS);
  const out = ['"scene" with shape "outing" | "visit" | "cast.beat" (the shapes of the Director prompt)'];
  for (const k of ['goal', 'weather', 'decision.pick', 'mood']) if (kinds.has(k)) out.push(`"${k}"`);
  if (kinds.has('outcome')) out.push('"outcome" with "outcome":"cancelled" only');
  return out.join(', ');
};

/** The static charter (generated from the Director's lists; persona-neutral, byte-stable). */
export const CONTINUITY_CHARTER = continuityCharter(allowedList());

// ── Deps (the story facade wires the live ones; tests stub them) ──────────

const DEFAULT_DEPS = {
  now: () => clockNow(),
  getState: () => null,
  world: null,
  callRole: null,            // default: brain/llm.js callRole (lazy import)
  mindBudgetOk: null,        // 008's gate; absent → refused (fail closed)
  getUsageByCaller: null,    // default: brain/usage.js getUsageByCallerStrict (lazy import)
  knownNames: () => realPeopleNames(),   // a throw → the warnings are dropped (fail closed)
  logger,
};
let deps = { ...DEFAULT_DEPS };
let busy = false;
const cache = new Map();     // fingerprint → { result, expiresAt }

export function configure(over = {}) {
  if (isObj(over)) deps = { ...deps, ...over };
}

export function __setDepsForTest(over) {
  if (over === null) { deps = { ...DEFAULT_DEPS }; busy = false; cache.clear(); return; }
  deps = { ...deps, ...(isObj(over) ? over : {}) };
}

function tzOf(state) {
  return resolveTimezone(state?.world?.timezone ?? deps.world?.timezone ?? config.timezone);
}

// ── Ledger reads (strict: a read error = cap reached) ──────────────────────

async function usageReader() {
  return deps.getUsageByCaller ?? (await import('../../brain/usage.js')).getUsageByCallerStrict;
}

/** director.continuity calls today (local day) — null on any read error. */
export async function continuityCallsToday(now, tz) {
  try {
    const rows = (await usageReader())(CONTINUITY_CALLER, dayStart(now, resolveTimezone(tz)));
    if (!Array.isArray(rows)) return null;
    return rows.filter(r => r?.caller === CONTINUITY_CALLER).reduce((s, r) => s + (Number(r?.calls) || 0), 0);
  } catch {
    return null;
  }
}

/** { continuityMonthUsd, continuityCapUsd, continuityToday, continuityDayCap } for /api/arcs/status (null on a read error). */
export async function continuityBudgetStatus(now, tz) {
  const usd = await arcsCallerSpend(now, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [CONTINUITY_CALLER] });
  return {
    continuityMonthUsd: finite(usd) ? usd : null,
    continuityCapUsd: Number(config.arcs?.continuityBudgetUsd ?? 0.5),
    continuityToday: await continuityCallsToday(now, tz),
    continuityDayCap: Number(config.arcs?.continuityMaxPerDay ?? 30),
  };
}

/** Pre-call gates → { ok:true, today, cap } | { ok:false, reason } (never throws). */
async function gates(now, tz) {
  const cap = Number(config.arcs?.continuityMaxPerDay ?? 30);
  if (!(cap > 0)) return { ok: false, reason: 'story_read_off', today: null, cap };
  const today = await continuityCallsToday(now, tz);
  if (today === null || today >= cap) return { ok: false, reason: 'rate', today, cap };
  const own = await arcsCallerSpend(now, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [CONTINUITY_CALLER] });
  if (!(own < Number(config.arcs?.continuityBudgetUsd ?? 0.5))) return { ok: false, reason: 'caller_cap', today, cap };
  const all = await arcsCallerSpend(now, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [...SHARED_PREFIXES] });
  if (!(all < Number(config.arcs?.mindBudgetUsd ?? 1))) return { ok: false, reason: 'caller_cap', today, cap };
  if (typeof deps.mindBudgetOk !== 'function') return { ok: false, reason: 'budget', today, cap };
  let b;
  try { b = await deps.mindBudgetOk('think'); } catch { b = null; }
  if (b?.ok !== true) return { ok: false, reason: b?.reason === 'unpriced' ? 'unpriced' : 'budget', today, cap };
  return { ok: true, today, cap };
}

// ── The change block (what the model sees of the preview) ──────────────────

function relWhen(at, now, tz) {
  if (!finite(at)) return null;
  const d = dateKey(at, tz);
  const day0 = dayStart(now, tz);
  for (let i = 0; i <= 14; i++) if (dateKey(addDays(day0, i, tz), tz) === d) return { day: i, time: clockHhmm(at, tz) };
  return at < now ? { past: true } : { later: true };
}

const ENUM_FIELDS = ['kind', 'shape', 'category', 'mode', 'reason', 'outcome', 'stage', 'from', 'to', 'beatKind', 'optionId', 'button',
  'goalKind', 'sky', 'relation', 'how', 'change'];
const NUM_FIELDS = ['amount', 'days', 'value', 'intensity', 'minutes', 'salary'];
const TEXT_FIELDS = { label: 80, text: 160, name: 40 };

// One planned descriptor as the model may see it: type, actor, relative time, ids,
// enums and numbers, owner labels cleaned. Never a subject JID.
function eventLine(e, now, tz) {
  const p = isObj(e.payload) ? e.payload : {};
  const out = { type: e.type, actor: e.actor };
  const when = relWhen(p.subject?.eventAt ?? p.startAt ?? p.from ?? p.dueAt ?? null, now, tz);
  if (when) out.when = when;
  const castIds = [...new Set([...(Array.isArray(p.castIds) ? p.castIds : []), ...(Array.isArray(p.subject?.castIds) ? p.subject.castIds : []),
    ...(typeof p.castId === 'string' ? [p.castId] : [])])].filter(id => typeof id === 'string' && /^cast:/.test(id)).slice(0, 6);
  if (castIds.length) out.castIds = castIds;
  const placeId = p.subject?.placeId ?? p.placeId ?? null;
  if (typeof placeId === 'string' && /^place:/.test(placeId)) out.placeId = placeId;
  for (const k of ENUM_FIELDS) if (typeof p[k] === 'string' && /^[a-z][a-z0-9_:.-]{0,30}$/.test(p[k])) out[k] = p[k];
  for (const k of NUM_FIELDS) if (finite(p[k])) out[k] = Math.round(p[k] * 100) / 100;
  if (isObj(p.delta)) out.delta = Object.fromEntries(Object.entries(p.delta).filter(([, v]) => finite(v)).slice(0, 6));
  if (e.actor === 'owner') for (const [k, cap] of Object.entries(TEXT_FIELDS)) if (typeof p[k] === 'string') out[k] = cleanItem(p[k], cap);
  return out;
}

// The last 14 days of his own / the owner's story moments (never chat-origin; story
// families are chat-forbidden anyway — this is defence in depth).
function recentLines(state, now, tz, listFn) {
  const types = RECENT_TYPES.filter(t => EVENT_TYPES.has(t));
  let list = [];
  try { list = listFn({ types, from: now - RECENT_DAYS * DAY, order: 'desc', limit: 200 }); } catch { list = []; }
  const out = [];
  for (const e of list) {
    if (out.length >= RECENT_MAX) break;
    if (e.originKind !== 'self' && e.originKind !== 'owner') continue;
    if (typeof e.subjectJid === 'string' || e.redacted) continue;
    const p = isObj(e.payload) ? e.payload : {};
    const line = { type: e.type, daysAgo: Math.max(0, Math.round((now - e.at) / DAY)) };
    if (e.type === 'heavy.started' || e.type === 'heavy.ended') { if (typeof p.kind === 'string') line.kind = p.kind; out.push(line); continue; }
    if (typeof p.castId === 'string') line.castId = p.castId;
    for (const k of ['kind', 'stage', 'from', 'to', 'outcome', 'reason', 'how', 'category']) if (typeof p[k] === 'string' && p[k].length <= 30) line[k] = p[k];
    if ((e.type === 'cast.beat' || e.type === 'cast.history_added') && typeof p.text === 'string') line.text = cleanItem(p.text, 120);
    out.push(line);
  }
  return out.reverse();
}

/**
 * The change block for one planned preview (exported for the privacy test).
 * planned: director.plan's result; projection: the preview's cached one.
 */
export function changeBlock(planned, projection, { state, now, tz, summaries = [], listFn = listEvents } = {}) {
  // A retcon's own rewind events (its report: cancelled counts, mismatched replies) are never sent.
  const list = Array.isArray(planned.retcon?.actionEvents) ? planned.retcon.actionEvents : planned.events;
  const chat = chatRefsOf(list, { getEvent });
  // Never a chat's words or a real person: no line made from a chat and no subject, no revert. 020: a
  // change that targets a chat-made plan is the owner's own and may be read (its fields are codes).
  const events = list.filter(e => e.type !== 'director.action' && e.type !== 'event.reverted' && !chat.has(e.ref)
    && typeof e.subjectJid !== 'string')
    .slice(0, 24).map(e => eventLine(e, now, tz));
  const cont = isObj(planned.continuity) ? planned.continuity : { warnings: [] };
  const findings = (cont.warnings ?? []).filter(w => !w.fromChat && !CHAT_ONLY_CODES.has(w.code)).slice(0, 16)
    .map(w => ({ code: w.code, severity: w.severity, text: cleanItem(w.text, 160) }));
  const p = isObj(projection) && Array.isArray(projection.rows) ? projection : null;
  const ahead = p ? p.rows.filter(r => !r.fromChat && r.change !== 'removed').slice(0, ROWS_MAX).map(r => ({
    when: relWhen(r.at, now, tz), kind: r.kind, place: r.place ? cleanItem(r.place, 60) : null, cast: (r.cast ?? []).map(n => cleanItem(n, 40)), change: r.change,
  })) : [];
  const decisions = p ? (p.decisions ?? []).filter(d => !d.fromChat).slice(0, 12).map(d => ({ label: cleanItem(d.label, 80), before: d.before, after: d.after })) : [];
  const block = {
    summary: summaries.map(s => cleanItem(s, 200)).filter(Boolean).slice(0, 6),
    events, findings, ahead, decisions,
    recent: recentLines(state, now, tz, listFn),
  };
  // Fit the fence by dropping list tails, never by cutting characters.
  const fits = () => JSON.stringify(block).length <= CHANGE_MAX - 64;
  for (const k of ['recent', 'ahead', 'decisions', 'events', 'findings']) while (!fits() && block[k].length > 0) block[k].pop();
  return block;
}

// Codes that exist only because of a chat plan (never sent, whatever their flag says).
const CHAT_ONLY_CODES = new Set(['chat_said', 'overrides_open_chat', 'chat_plan_kept', 'CHAT_PLAN', 'messages_real_person']);

// ── The run ───────────────────────────────────────────────────────────────

function summariesOf(planned, state, now, tz) {
  const action = planned.action;
  const list = action.kind === 'bundle' || action.kind === 'retcon' ? (action.actions ?? []) : [action];
  const out = [];
  if (action.kind === 'retcon') out.push('REWIND to an earlier point, then:');
  for (const a of list) {
    try { out.push(promptMod.summaryOf(a, state, now, tz)); } catch { out.push(String(a?.kind ?? 'action').toUpperCase()); }
  }
  return out;
}

// A model suggestion → a 011-style draft planned on the state after the change,
// WITHOUT relax (a story-read part never loosens a pin, a freeze or the romance slot).
function draftOf(d, planned, previewAt, knownNames, state, tz) {
  const base = planned.afterState ?? state;
  let p;
  try {
    p = directorMod.plan(d.action, base, { now: previewAt, knownNames, relax: false, continuity: false, project: false });
  } catch (e) {
    const reason = typeof e?.reason === 'string' && /^[a-z][A-Za-z0-9_]{0,39}$/.test(e.reason) ? e.reason : 'bad_field';
    return { dropped: { part: 'suggestion', index: d.index, kind: d.action.kind, reason } };
  }
  if (!p.events.some(e => e.type !== 'director.action')) return { dropped: { part: 'suggestion', index: d.index, kind: d.action.kind, reason: p.refusals[0]?.reason ?? 'nothing' } };
  return {
    draft: {
      index: d.index, action: d.action, why: d.why, source: 'continuity',
      summary: promptMod.summaryOf(d.action, state, previewAt, tz),
      texts: promptMod.textsOf(d.action),
      refusals: p.refusals.map(r => ({ reason: r.reason, target: r.target ?? null })),
      warnings: p.warnings.slice(0, 8),
      events: p.events.filter(e => e.type !== 'director.action').length,
      ...promptMod.batchableOf(d.action),
    },
  };
}

/**
 * The story read of one preview. Throws StoryError not_running | expired
 * (expired_preview) | stale; every other outcome resolves with a status.
 */
export async function runStoryRead(previewId, { by = 'owner' } = {}) {
  void by;
  const started = Date.now();
  const state = deps.getState?.();
  if (!isObj(state) || state.genesisAt === null || state.genesisAt === undefined) throw err('not_running');
  const entry = directorMod.previewEntry(previewId);
  if (!entry) throw err('expired', 'expired_preview');
  // Re-plan at the preview's clock: the world moved → stale, before any spend.
  const planned = directorMod.plan(entry.action, state, { now: entry.previewAt, relax: entry.relax });
  if (directorMod.fingerprintOf(planned.action, planned, directorMod.materialId()) !== entry.fingerprint) throw err('stale', 'stale');
  const hit = cache.get(entry.fingerprint);
  if (hit && hit.expiresAt > Math.floor(deps.now())) return { ...hit.result, cached: true, called: false };
  const tz = tzOf(state);
  const now = Math.floor(deps.now());
  const base = { warnings: [], suggestions: [], dropped: [], model: null, fellBack: false, called: false, cached: false };
  const g = await gates(now, tz);
  if (!g.ok) return { ...base, status: 'refused', reason: g.reason, usage: { today: g.today ?? null, cap: g.cap } };
  if (busy) return { ...base, status: 'refused', reason: 'busy', usage: { today: g.today, cap: g.cap } };
  busy = true;
  try {
    const catState = planned.retcon?.baseState ?? state;
    const { model, check } = promptMod.buildCatalogue(catState, deps.world, entry.previewAt, tz);
    const listFn = (o) => (planned.action.kind === 'retcon' ? [] : listEvents(o));   // a retcon's recent story is the rewound one: none sent
    const change = changeBlock(planned, entry.projection, { state: catState, now: entry.previewAt, tz, summaries: summariesOf(planned, catState, entry.previewAt, tz), listFn });
    const user = `${fence(JSON.stringify(model), { kind: 'state', cap: STATE_MAX })}\n${fence(JSON.stringify(change), { kind: 'change', cap: CHANGE_MAX })}`;
    const call = deps.callRole ?? (await import('../../brain/llm.js')).callRole;
    let res;
    try {
      res = await call('mind', CONTINUITY_CHARTER, user, { caller: CONTINUITY_CALLER, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: CALL_TIMEOUT_MS });
    } catch {
      res = null;
    }
    const meta = { model: typeof res?.model === 'string' ? res.model.slice(0, 80) : null, fellBack: !!res?.fellBack, called: true,
      usage: { today: g.today + 1, cap: g.cap } };
    let out;
    if (!res || res.status === 'error') out = { ...base, ...meta, status: 'model_failed' };
    else if (res.skipped) out = { ...base, ...meta, status: 'skipped', reason: ['budget', 'disabled', 'no_key'].includes(res.skipped) ? res.skipped : 'budget' };
    else if (typeof res.text !== 'string' || !res.text.trim()) out = { ...base, ...meta, status: 'invalid_output' };
    else {
      const v = validateContinuityOutput(res.text, check, promptMod.VOCAB, { allowed: suggestionAllowed });
      if (v.invalid) out = { ...base, ...meta, status: 'invalid_output' };
      else {
        let names = null;
        try { names = deps.knownNames(); if (!Array.isArray(names)) names = null; } catch { names = null; }
        const dropped = [...v.dropped];
        const warnings = [];
        v.warnings.forEach((w, index) => {
          if (!names || textNameCollisions({ places: [{ name: w.text }] }, names).length) dropped.push({ part: 'warning', index, reason: names ? 'real_person_name' : 'names_unavailable' });
          else warnings.push(w);
        });
        const suggestions = [];
        for (const d of v.suggestions) {
          const r = names ? draftOf(d, planned, entry.previewAt, names, catState, tz) : { dropped: { part: 'suggestion', index: d.index, kind: d.action.kind, reason: 'names_unavailable' } };
          if (r.draft) suggestions.push(r.draft); else dropped.push(r.dropped);
        }
        out = { ...base, ...meta, status: 'ok', warnings, suggestions, dropped };
      }
    }
    if (out.status === 'ok') {
      cache.set(entry.fingerprint, { result: { ...out, called: false }, expiresAt: entry.previewAt + directorMod.PREVIEW_TTL_SEC });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    deps.logger.info({ evt: 'arcs.director.continuity', status: out.status, warnings: out.warnings.length, suggestions: out.suggestions.length,
      ms: Date.now() - started }, 'story: director continuity');
    return out;
  } finally {
    busy = false;
  }
}

export const __test = { gates, recentLines, eventLine };
