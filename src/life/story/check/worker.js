// The claim check (plan 020 E3): after a scene, a text or a journal part is written, code reads its time words, then one small
// clerk call lists its claims against the sheet it was written from. SHADOW by default: verdicts are stored and nothing else
// changes. ENFORCE (ARCS_CLAIM_CHECK_ENFORCE, off): the writer checks before commit, a contradiction gets one rewrite naming it,
// then that writer's own fallback.
//
// Never in the way: a failure of any kind means no verdict, the writer goes on. Fail closed means no model call, not a blocked
// output. An explicit output is never sent to the clerk, whichever register it came from.
//
//   seam           what the writers get through configure(): mode, ground*, enforce, submit
//   processPending the job: ≤ PER_JOB queued runs, one call each, outside the story's chain so it never holds up a text
//   sweep          a run whose output left the log or changed goes, with its verdicts
//   view           the Control panel's read
//
// Logging: evt 'arcs_check', codes and counts only (logRun).
import { createHash } from 'crypto';
import { config } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { now as clockNow, dayStart, resolveTimezone } from '../../clock.js';
import { arcsCallerSpend, monthStart } from '../seed.js';
import { contentProblem } from '../desire.js';
import * as store from './store.js';
import { sceneGrounding, phoneGrounding, journalGrounding } from './grounding.js';
import { timeWordFindings, leftFindings } from './timeWords.js';
import { CLAIMS_CHARTER, renderUser, validateClaims, correctionOf, TEXT_MAX } from './charter.js';

export const CALLER = 'life.check.claims';
export const PER_JOB = 5;
export const MAX_AGE_SEC = 6 * 3600;   // a queue older than this (downtime) is closed, not caught up on
export const HUGE_CHARS = 20000;
export const SWEEP_PAGE = 1000;   // a pass reads the newest page and the next page of a walk through the older ones
const LOCAL_PROVIDERS = new Set(['local', 'ollama']);
const WRITERS = new Set(['scene', 'phone', 'journal']);
const SPEAKERS = new Set(['narrator', 'his', 'cast']);

let deps = {
  now: () => Math.floor(clockNow()),
  tz: () => resolveTimezone(config.timezone),
  callRole: async (...args) => (await import('../../../brain/llm.js')).callRole(...args),
  getUsageByCaller: null,
  knownNames: () => null,
  castNames: () => [],
  relWhen: null,                // phone/facts.js relWhen: the sheet's own time words
  contentProblem,               // desire.js: what the clerk must never read
  textOf: () => undefined,      // (writer, rowId) → { text, href? } | null (gone) | undefined (can't tell now)
  kick: () => {},
  pricing: (...a) => realPricing(...a),   // 'priced' | 'local' | 'unpriced'
};

/** Story attach. */
export function configure(d = {}) {
  deps = { ...deps, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) };
}

const nowSec = () => Math.floor(deps.now());
const sha = (t) => createHash('sha256').update(String(t ?? ''), 'utf8').digest('hex').slice(0, 32);
const issue = (where, err) => { try { logger.warn({ evt: 'issue', where: `arcs.check.${where}`, err: err?.name || 'Error' }, 'story: claim check failed'); } catch { /* never in the way */ } };

/** 'off' | 'shadow' | 'enforce' */
export function mode() {
  if (config.arcs?.claimCheckEnabled === false) return 'off';
  return config.arcs?.claimCheckEnforce === true ? 'enforce' : 'shadow';
}

// ── gates ────────────────────────────────────────────────────────────────────

/** Today's calls and the month's spend, from the ledger. → { today, monthUsd } | null (unreadable: no call). */
export async function budgetStatus(at = nowSec(), tz = deps.tz()) {
  try {
    const fn = deps.getUsageByCaller ?? (await import('../../../brain/usage.js')).getUsageByCallerStrict;
    const rows = fn(CALLER, dayStart(at, tz));
    if (!Array.isArray(rows)) return null;
    const monthUsd = await arcsCallerSpend(at, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [CALLER] });
    if (!Number.isFinite(monthUsd)) return null;
    return { today: rows.filter(r => r?.caller === CALLER).reduce((a, r) => a + (Number(r.calls) || 0), 0), monthUsd };
  } catch {
    return null;
  }
}

/**
 * Can a clerk call be charged against the $ cap? Unpriced adds $0 to the ledger, so without a price the cap does nothing:
 * the route has no price, or a call this month came back with none (a fallback), and no table row has appeared since. A local
 * model has no bill to cap. → 'priced' | 'local' | 'unpriced'. Throws when the ledger can't be read.
 */
export async function realPricing(at = nowSec(), tz = deps.tz()) {
  const [{ resolveRole }, usage] = await Promise.all([import('../../../brain/roles.js'), import('../../../brain/usage.js')]);
  const inTable = (provider, model) => !!provider && !!model && usage.costFor({ provider, model, usage: { input: 1000, output: 1000 } }).source !== 'unknown';
  const route = resolveRole('clerk', config);
  const local = LOCAL_PROVIDERS.has(route?.provider);
  // OpenRouter reports each call's cost itself; anything else needs a table row (the mind's rule).
  if (!local && route?.provider !== 'openrouter' && !inTable(route?.provider, route?.model)) return 'unpriced';
  const rows = usage.getUnpricedByCallerStrict(CALLER, monthStart(at, tz));
  if (rows.some(r => !LOCAL_PROVIDERS.has(r.provider) && !inTable(r.provider, r.model))) return 'unpriced';
  return local ? 'local' : 'priced';
}

async function pricingNow(at, tz) {
  try { return await deps.pricing(at, tz); } catch { return null; }
}

async function gate(at, tz) {
  const b = await budgetStatus(at, tz);
  if (!b) return 'ledger';
  const pricing = await pricingNow(at, tz);
  if (!pricing) return 'ledger';
  if (pricing === 'unpriced') return 'unpriced';
  if (!(b.today < Number(config.arcs?.claimCheckMaxPerDay ?? 0))) return 'cap';
  if (!(b.monthUsd < Number(config.arcs?.claimCheckBudgetUsd ?? 0))) return 'budget';
  return null;
}

// ── the check ────────────────────────────────────────────────────────────────

function codePass(text, grounding, speaker) {
  const f = [
    ...timeWordFindings(text, grounding.rows, { speaker, atHour: grounding.atHour, names: grounding.names }),
    ...leftFindings(text, grounding.afterwards),
  ];
  return f.map(x => ({ source: 'code', verdict: 'contradicted', ...x }));
}

/**
 * Code first, then at most one clerk call. Never throws. → { status 'checked'|'code_only', skip, claims, model, cut }
 * The clerk sees the code-built sheet and the output, nothing else.
 */
async function check(text, grounding, speaker) {
  const g = grounding ?? { lines: [], rows: [] };
  const body = String(text ?? '');
  if (body.length > HUGE_CHARS) return { status: 'code_only', skip: 'too_long', claims: [], model: null, cut: true };
  let code = [];
  try { code = codePass(body, g, speaker); } catch (err) { issue('code', err); }
  const done = (skip) => ({ status: 'code_only', skip, claims: code, model: null, cut: false });
  if (!g.lines?.length) return done('no_sheet');
  const at = nowSec();
  const tz = deps.tz();
  const closed = await gate(at, tz);
  if (closed) return done(closed);
  const cut = body.length > TEXT_MAX;
  let res;
  try {
    res = await deps.callRole('clerk', CLAIMS_CHARTER, renderUser(g, body), { caller: CALLER, maxTokens: 500, temperature: 0, timeoutMs: 30_000 });
  } catch { res = null; }
  if (res?.skipped) return done(res.skipped === 'budget' ? 'budget' : 'call_failed');
  if (!res || typeof res.text !== 'string' || !res.text.trim() || (res.status && res.status !== 'ok')) return done('call_failed');
  let knownNames = null;
  try { knownNames = deps.knownNames(); } catch { knownNames = null; }
  let castNames = [];
  try { castNames = deps.castNames(); } catch { castNames = []; }
  const v = validateClaims(res.text, { lines: g.lines, knownNames, castNames });
  if (!v.ok) return done(v.reason);
  return { status: 'checked', skip: null, claims: [...code, ...v.claims], model: typeof res.model === 'string' ? res.model.slice(0, 60) : null, cut };
}

/** An output the clerk must never see, or that has nothing to check. */
function refused(text, facts) {
  if (typeof text !== 'string' || !text.trim()) return true;
  if (facts?.register === 'explicit' || facts?.tone === 'naughty') return true;
  return deps.contentProblem(text) !== null;
}

// The clerk can't see the thread, and at enforce time a plan this text is agreeing to isn't on the sheet yet (planFromTexts needs the
// committed row). So "no plan" proves nothing: enforce acts on a plan verdict only when the sheet names a plan at some other time.
const NONE_SET_RE = /^his plans: none\b/;
const PLAN_AT_TIME_RE = /^(?:his plans|planned next with them): .*\b\d{2}:\d{2}\b|^\d{2}:\d{2} (?:planned|promised):/;
export const enforceActsOn = (c) => {
  const evidence = String(c?.evidence ?? '');
  if (NONE_SET_RE.test(evidence)) return false;
  return c?.about !== 'plan' || c?.source === 'code' || PLAN_AT_TIME_RE.test(evidence);
};

/**
 * Enforce mode only, before the writer commits. → null (not enforcing, or nothing to act on) |
 * { contradicted: [...], correction, result } (result goes back through submit, so no second call; a verdict enforce won't act on
 * is still stored).
 */
async function enforce(text, grounding, { speaker = 'narrator', register = null, tone = null } = {}) {
  try {
    if (mode() !== 'enforce' || refused(text, { register, tone }) || !store.hasTables()) return null;
    const result = await check(text, grounding, speaker);
    const contradicted = result.claims.filter(c => c.verdict === 'contradicted' && enforceActsOn(c));
    return { contradicted, correction: contradicted.length ? correctionOf(contradicted) : null, result };
  } catch (err) {
    issue('enforce', err);
    return null;
  }
}

/**
 * The writer committed an output. Queues its check (or records what enforce already found). Synchronous, never throws, changes
 * nothing about the output. o: { writer, rowId, eventId, grounding, speaker, chatOrigin, register, tone, result, rewrote }
 */
function submit(o = {}) {
  try {
    const m = mode();
    if (m === 'off' || !WRITERS.has(o.writer) || !SPEAKERS.has(o.speaker) || !Number.isSafeInteger(o.rowId)) return null;
    if (!store.hasTables()) return null;
    const live = deps.textOf(o.writer, o.rowId);
    const text = live?.text;
    if (refused(text, o)) return null;
    const at = nowSec();
    const id = store.inTransaction(() => {
      const runId = store.insertRun({
        writer: o.writer, rowId: o.rowId, eventId: Number.isSafeInteger(o.eventId) ? o.eventId : null, sha: sha(text), speaker: o.speaker,
        chatOrigin: o.chatOrigin === true, mode: m === 'enforce' ? 'enforce' : 'shadow', at, createdAt: at, rewrote: o.rewrote === true,
        grounding: o.result ? null : (o.grounding ?? { lines: [], rows: [] }), status: o.result ? 'running' : 'pending',
      });
      if (runId && o.result) store.finishRun(runId, { status: o.result.status, skipReason: o.result.skip, model: o.result.model, cut: o.result.cut, claims: o.result.claims, at });
      return runId;
    });
    if (!id) return null;
    if (o.result) logRun(o.writer, o.result, id);
    else {
      try { deps.kick(); } catch { /* the next tick runs it */ }
    }
    return id;
  } catch (err) {
    issue('submit', err);
    return null;
  }
}

function logRun(writer, r, id) {
  const n = (v) => r.claims.filter(c => c.verdict === v).length;
  try {
    logger.info({ evt: 'arcs_check', writer, id, status: r.status, skip: r.skip, supported: n('supported'), contradicted: n('contradicted'), unknown: n('unknown') }, 'story: claim check');
  } catch { /* never in the way */ }
}

/** What the writers get. Each piece is safe to call with anything; a bad sheet → an empty grounding, which means no call. */
const safeGround = (fn) => (input, o = {}) => {
  try {
    let castNames = [];
    try { castNames = deps.castNames() ?? []; } catch { castNames = []; }
    return fn(input, { ...o, relWhen: deps.relWhen, castNames, problem: deps.contentProblem });
  } catch (err) {
    issue('ground', err);
    return { lines: [], rows: [], names: [], afterwards: [], atHour: 12 };
  }
};
export const seam = Object.freeze({
  mode,
  enforce,
  submit,
  scene: safeGround(sceneGrounding),
  phone: safeGround(phoneGrounding),
  journal: safeGround(journalGrounding),
});

// ── the job ──────────────────────────────────────────────────────────────────

/** ≤ PER_JOB queued runs. → how many it closed */
export async function processPending(limit = PER_JOB) {
  if (mode() === 'off' || !store.hasTables()) return 0;
  let n = 0;
  for (const run of store.listPending(limit)) {
    const at = nowSec();
    const live = deps.textOf(run.writer, run.rowId);
    if (live === undefined) break;   // life isn't running: they wait
    if (live === null || sha(live.text) !== run.sha) { store.deleteRun(run.id); continue; }   // reverted or rewritten while queued
    if (!store.claimRun(run.id)) continue;
    if (at - run.createdAt > MAX_AGE_SEC) {
      // Downtime isn't caught up on with a clerk call. The code pass costs nothing, and the stored rows still hold the sheet's times.
      let code = [];
      try { code = codePass(live.text, run.grounding ?? { rows: [] }, run.speaker); } catch (err) { issue('code', err); }
      store.finishRun(run.id, { status: 'code_only', skipReason: 'too_old', claims: code, at });
      n++;
      continue;
    }
    const r = await check(live.text, run.grounding, run.speaker);
    // It may have gone during the call.
    const after = deps.textOf(run.writer, run.rowId);
    if (after === null || (after && sha(after.text) !== run.sha)) { store.deleteRun(run.id); continue; }
    store.finishRun(run.id, { status: r.status, skipReason: r.skip, model: r.model, cut: r.cut, claims: r.claims, at: nowSec() });
    logRun(run.writer, r, run.id);
    n++;
  }
  return n;
}

export function resetInterrupted() {
  try { if (store.hasTables()) store.resetRunning(); } catch (err) { issue('reset', err); }
}

/**
 * A run whose output left the log, or whose words changed, goes with its verdicts. A pass reads the newest page, what's likeliest to
 * change, and the next page of a walk through the older ones, so every run within retention is reached in a few passes. → how many
 */
let sweepCursor = null;
export function sweep({ page = SWEEP_PAGE } = {}) {
  if (!store.hasTables()) return 0;
  const newest = store.listKeys(page);
  const lowest = newest.length ? newest[newest.length - 1].id : null;
  const older = lowest === null ? [] : store.listKeysBefore(sweepCursor !== null && sweepCursor < lowest ? sweepCursor : lowest, page);
  sweepCursor = older.length < page ? null : older[older.length - 1].id;
  let n = 0;
  for (const k of [...newest, ...older]) {
    const live = deps.textOf(k.writer, k.rowId);
    if (live === undefined) continue;
    if (live === null || sha(live.text) !== k.sha) { store.deleteRun(k.id); n++; }
  }
  return n;
}

export function prune(at = nowSec()) {
  try { if (store.hasTables()) store.prune(at); } catch (err) { issue('prune', err); }
}

// ── the panel ────────────────────────────────────────────────────────────────

const EXCERPT_MAX = 280;
const blank = () => ({ runs: 0, checked: 0, codeOnly: 0, supported: 0, contradicted: 0, unknown: 0, codeContradicted: 0 });

/**
 * Counts per writer and voice, skip reasons, the last contradictions with the words they came from (none for a chat's). A read, on
 * the bot's main thread every 30 s while the page is open: it doesn't sweep (the facade's memo does), and leaves out of the list a
 * contradiction whose output has gone or changed.
 */
export async function view({ days = 30, limit = 30 } = {}) {
  const base = {
    mode: mode(), maxPerDay: Number(config.arcs?.claimCheckMaxPerDay ?? 0), budgetUsd: Number(config.arcs?.claimCheckBudgetUsd ?? 0),
    days, today: null, monthUsd: null, rows: [], skips: [], pending: 0, rewrites: 0, last: [], ready: store.hasTables(),
  };
  if (!base.ready) return base;
  const at = nowSec();
  const c = store.counts(at - days * 86400);
  const rows = new Map();
  const of = (w, s) => {
    const k = `${w}.${s}`;
    if (!rows.has(k)) rows.set(k, { writer: w, speaker: s, ...blank() });
    return rows.get(k);
  };
  for (const r of c.runs) {
    const x = of(r.writer, r.speaker);
    x.runs += r.n;
    if (r.status === 'checked') x.checked += r.n;
    if (r.status === 'code_only') x.codeOnly += r.n;
  }
  for (const r of c.claims) {
    const x = of(r.writer, r.speaker);
    x[r.verdict] += r.n;
    if (r.source === 'code' && r.verdict === 'contradicted') x.codeContradicted += r.n;
  }
  const b = await budgetStatus(at);
  const pricing = await pricingNow(at, deps.tz());
  const last = store.lastContradictions(limit).flatMap((r) => {
    const current = deps.textOf(r.writer, r.rowId);
    if (current === null || (current && sha(current.text) !== r.sha)) return [];
    const live = r.chatOrigin === 1 ? null : current;
    return [{
      id: r.id, runId: r.runId, writer: r.writer, speaker: r.speaker, at: r.at, source: r.source, about: r.about, reason: r.reason, mode: r.mode,
      fromChat: r.chatOrigin === 1, claim: r.claim, evidence: r.evidence,
      excerpt: typeof live?.text === 'string' ? live.text.slice(0, EXCERPT_MAX) : null, href: live?.href ?? null,
    }];
  });
  return { ...base, today: b?.today ?? null, monthUsd: b?.monthUsd ?? null, pricing, rows: [...rows.values()], skips: c.skips, pending: c.pending, rewrites: c.rewrites, last };
}
