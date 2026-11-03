// How things stand (plan 020 D2): one short note per fictional cast member, rebuilt at night only for
// people whose events changed, and read by the writers instead of their history lines.
//
//   runPass(opts)     the mind's sleep step (life.storyStandingPass). The sweep first, then, for members with
//                     something new and in priority order, one clerk call each (caller mind.standing): the
//                     previous note + what happened since → a new version. Night cap, day cap and month $
//                     cap, the mind's clerk cap: all fail closed, and whatever stops a rebuild leaves the old
//                     version live. An invented name or a day word gets one more try; anything else keeps
//                     the old version.
//   sweep(s, opts)    a version whose evidence left the log (revert, rewind, a heavy onset near it) or whose
//                     as-of fell in a rewound range is invalidated, with everything built on it. At the next pass
//                     the newest clean version stands again (no call), and it's rebuilt from there if anything
//                     still in his life is new. Text is never edited.
//   noteAt(s, id, at) the version that held at `at`, checked against the log now → the writers' sheets.
//   view(id)          the dashboard's. publicRows(): the site's, ready and not wired.
//
// Real people aren't in this slice. Nothing here logs words: ids, codes and counts only.
import { createHash } from 'node:crypto';
import { listEvents, causeChain, getEvent, lastEventId } from '../../eventLog.js';
import { isExcludedId } from '../../projector.js';
import { foldDecisions } from '../../decisionLog.js';
import { dayStart, resolveTimezone } from '../../clock.js';
import { venueNamesNow } from '../../places.js';
import { activeRomance, metricsOf } from '../romance.js';
import { arcsCallerSpend } from '../seed.js';
import { config } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import * as store from './store.js';
import { READ_TYPES, band01, changedEnough, linesFor, privateWordsOf } from './facts.js';
import { CALLER, MAX_TOKENS, STANDING_CHARTER, correctionFor, renderUser, validateStanding } from './charter.js';

const DAY = 86400;
export const LOOKBACK_SEC = 60 * DAY;
const READ_PAGE = 500;
const READ_MAX_PAGES = 80;
const HEAVY_BEFORE = 2 * DAY;      // the same window as a scene's heavy_window (R1)
const HEAVY_AFTER = 31 * DAY;
const VERSIONS_SHOWN = 20;
const EVIDENCE_SHOWN = 60;
const RELATION_RE = /^family:/;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const DEFAULT_DEPS = {
  now: () => Math.floor(Date.now() / 1000),
  getState: () => null,
  persona: () => ({}),
  knownNames: () => { throw new Error('names'); },
  callRole: async (...a) => (await import('../../../brain/llm.js')).callRole(...a),
  getUsageByCaller: null,
  sceneRows: () => [],
  textRows: () => [],
  tz: (s) => resolveTimezone(s?.world?.timezone ?? config.timezone),
};
let deps = { ...DEFAULT_DEPS };
let running = false;
let lastSig = null;

/** The story facade's wiring (and the tests'). */
export function configure(d = {}) {
  deps = { ...DEFAULT_DEPS, ...d };
}

const enabled = () => config.arcs?.standingEnabled !== false;
const activeMember = (s, id) => s?.cast instanceof Map && s.cast.has(id) && !isObj(s.story?.departed?.[id]);

function warn(where, err) {
  try { logger.warn({ evt: 'issue', where: `arcs.standing.${where}`, err: err?.code ?? err?.name ?? 'Error' }, 'story: how things stand step failed'); } catch { /* */ }
}

function heavyWindowsOf(s) {
  return listEvents({ types: ['heavy.started'], order: 'desc', limit: 200 })
    .filter(e => e.redacted !== true && !isExcludedId(s, e.id))
    .map((e) => {
      const until = e.payload?.until;
      return { from: e.at - HEAVY_BEFORE, to: Math.max(e.at + HEAVY_AFTER, finite(until) ? until : 0) };
    });
}

const inRewoundRange = (s, id) => Array.isArray(s?.excludedRanges) && s.excludedRanges.some(x => id >= x.from && id <= x.to);

function wordsOf(row) {
  return String(row?.editedText || row?.text || '');
}

function wordsSig(evidence) {
  const sceneIds = evidence.filter(e => e.source === 'scene').map(e => e.eventId);
  const textIds = evidence.filter(e => e.source === 'text').map(e => e.eventId);
  const rows = [...deps.sceneRows(sceneIds), ...deps.textRows(textIds)].sort((a, b) => a.eventId - b.eventId);
  return createHash('sha256').update(rows.map(r => `${r.eventId}:${wordsOf(r)}`).join('\n'), 'utf8').digest('hex').slice(0, 32);
}

// ── the sweep ────────────────────────────────────────────────────────────────

/**
 * Invalidate what no longer holds. `deep` (the night's pass) also reads the log for redacted evidence and
 * re-reads the words of each live version, since an owner's edit of a scene or a text appends no event.
 * → { invalidated }
 */
export function sweep(s = deps.getState(), { deep = false } = {}) {
  if (!s) return { invalidated: 0 };
  const at = deps.now();
  const rows = store.standingVersions();
  if (!rows.length) return { invalidated: 0 };
  const windows = heavyWindowsOf(s);
  const byVersion = new Map();
  for (const e of store.standingEvidence()) {
    if (!byVersion.has(e.versionId)) byVersion.set(e.versionId, []);
    byVersion.get(e.versionId).push(e);
  }
  const gone = new Set();
  for (const v of rows) {
    const ev = byVersion.get(v.id) ?? [];
    let reason = null;
    // Also one built on a version a sweep already took (the base went while the clerk was thinking).
    if (gone.has(v.supersedes) || (v.supersedes && store.get(v.supersedes)?.status === 'invalidated')) reason = 'built_on_gone';
    else if (inRewoundRange(s, v.asOfEventId)) reason = 'rewound';
    else if (ev.some(e => isExcludedId(s, e.eventId))) reason = 'evidence_gone';
    else if (ev.some(e => windows.some(w => e.at >= w.from && e.at <= w.to))) reason = 'heavy_window';
    else if (deep && v.status === 'live') {
      if (ev.some(e => { const x = getEvent(e.eventId); return !x || x.redacted === true; })) reason = 'evidence_gone';
      else if (v.wordsSig && wordsSig(ev) !== v.wordsSig) reason = 'words_changed';
    }
    if (!reason) continue;
    store.invalidate(v.id, reason, at);
    gone.add(v.id);
  }
  return { invalidated: gone.size };
}

/** After a tick: sweep when something may have left the log, or a heavy stretch began. Cheap otherwise. */
export function exclusionsChanged(s) {
  let heavy = null;
  try { heavy = listEvents({ types: ['heavy.started'], order: 'desc', limit: 1 })[0]?.id ?? null; } catch { heavy = 'unread'; }
  const sig = `${s?.excluded?.size ?? 0}:${s?.excludedRanges?.length ?? 0}:${heavy}`;
  if (sig === lastSig) return false;
  lastSig = sig;
  return true;
}

// ── the pass ─────────────────────────────────────────────────────────────────

function readEvents(from, head, types = READ_TYPES) {
  const out = [];
  let after;
  // The read is by `at`, then in pages by id: the row count, not the span, is what's capped.
  for (let page = 0; page < READ_MAX_PAGES; page++) {
    const rows = listEvents({ types: [...types], from, ...(after ? { after } : {}), limit: READ_PAGE });
    for (const e of rows) if (e.id <= head) out.push(e);
    if (rows.length < READ_PAGE) return out;
    after = rows[rows.length - 1].id;
  }
  const err = new Error('too many events');
  err.code = 'read_cap';
  throw err;
}

async function gate(at, tz) {
  const maxNight = Number(config.arcs?.standingMaxPerNight ?? 4);
  const fn = deps.getUsageByCaller ?? (await import('../../../brain/usage.js')).getUsageByCallerStrict;
  const rows = fn(CALLER, dayStart(at, tz));
  if (!Array.isArray(rows)) return 'ledger';
  const today = rows.filter(r => r?.caller === CALLER).reduce((a, r) => a + (Number(r.calls) || 0), 0);
  // Each member may take a second try.
  if (!(today < maxNight * 2)) return 'day_cap';
  const usd = await arcsCallerSpend(at, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [CALLER] });
  if (!finite(usd) || !(usd < Number(config.arcs?.standingBudgetUsd ?? 0.3))) return 'budget';
  return null;
}

async function defaultCall(system, user) {
  const res = await deps.callRole('clerk', system, user, { caller: CALLER, maxTokens: MAX_TOKENS });
  if (res?.skipped) return { ok: false, skipped: true };
  if (!res || res.status !== 'ok' || typeof res.text !== 'string' || !res.text) return { ok: false };
  return { ok: true, text: res.text, model: res.model ?? null, fellBack: !!res.fellBack };
}

function inputOf(s, castId, name, lines, base) {
  const c = s.cast.get(castId);
  const m = metricsOf(s, castId);
  const rom = activeRomance(s);
  const persona = (() => { try { return deps.persona() ?? {}; } catch { return {}; } })();
  return {
    him: String(persona.displayName ?? persona.name ?? 'him').slice(0, 40),
    them: {
      name, relation: String(c?.relation ?? 'friend').replace(RELATION_RE, ''),
      closeness: band01(m.closeness), trust: band01(m.trust), tension: band01(m.tension),
      ...(rom?.partnerId === castId ? { romance: rom.arc.stage } : {}),
    },
    base: base?.text ?? null,
    lines: lines.map(l => l.text),
  };
}

// A head that was undone, with an earlier version still clean: that one stands again, word for word, whatever stops a rebuild tonight.
// What's newer than it reaches the sheets as it did before the note existed.
function restoreClean(s, at, night) {
  const out = [];
  const members = new Set(store.standingVersions().map(v => v.castId));
  for (const castId of members) {
    if (!activeMember(s, castId) || store.live(castId)) continue;
    const prev = store.newestStanding(castId);
    if (!prev) continue;
    store.addVersion({ castId, text: prev.text, asOfEventId: prev.asOfEventId, at, supersedes: prev.id, night, model: prev.model, evidence: [] });
    out.push({ castId, outcome: 'restored' });
  }
  return out;
}

async function rebuildOne(s, c, { call, knownNames, castNames, venueNames, night, head, clerkLeft }) {
  const { castId, name, lines, base, privateWords = [] } = c;
  const input = inputOf(s, castId, name, lines, base);
  const persona = (() => { try { return deps.persona() ?? {}; } catch { return {}; } })();
  const names = [name, persona.displayName, persona.name, ...(persona.aliases ?? []), base?.text ?? '', ...input.lines, input.him];
  const ctx = { names, knownNames, castNames, venueNames, privateWords };
  let correction = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const stop = await gate(deps.now(), deps.tz(s));
      if (stop) return { outcome: stop, stop: true };
      if (typeof clerkLeft === 'function' && !clerkLeft()) return { outcome: 'clerk_cap', stop: true };
    }
    const out = await call(STANDING_CHARTER, renderUser(input, correction), { castId, night, attempt });
    if (out?.skipped) return { outcome: 'skipped', stop: true };
    if (!out?.ok) return { outcome: 'model_failed' };
    const v = validateStanding(out.text, ctx);
    if (!v.ok) {
      if (v.retry && attempt === 0) { correction = correctionFor(v); continue; }
      return { outcome: `refused_${v.reason}` };
    }
    // A revert or a rewind while the model was thinking: this note was written from what's gone.
    const now = deps.getState();
    if (lines.some(l => isExcludedId(now, l.eventId))) return { outcome: 'stale' };
    // …or from a base that has gone: a new version on it would be unreadable for good.
    if (base && (store.get(base.id)?.status !== 'live' || !holdsNow(now, base))) return { outcome: 'stale' };
    const evidence = lines.map(l => ({ eventId: l.eventId, at: l.at, source: l.source }));
    const id = store.addVersion({ castId, text: v.text, asOfEventId: head, at: deps.now(), supersedes: base?.id ?? null,
      wordsSig: wordsSig(evidence), night, model: out.model ?? null, fellBack: out.fellBack === true, evidence });
    return { outcome: 'written', versionId: id };
  }
  return { outcome: 'refused' };
}

/**
 * One night's work. opts: { nightKey, budgetOk (mindBudgetOk's object), call(system, user, meta) (default: the clerk),
 * clerkLeft() (the mind's clerk cap) }. Never throws.
 * → { status: 'done'|'skipped'|'busy', reason?, swept, candidates, results: [{ castId, outcome }] }
 */
export async function runPass({ nightKey = null, budgetOk = null, call = defaultCall, clerkLeft = null } = {}) {
  if (!enabled()) return { status: 'skipped', reason: 'disabled' };
  if (running) return { status: 'busy' };
  running = true;
  try {
    const s = deps.getState();
    if (!s || !(s.cast instanceof Map)) return { status: 'skipped', reason: 'not_running' };
    const { invalidated } = sweep(s, { deep: true });
    const results = restoreClean(s, deps.now(), nightKey);
    if (budgetOk && budgetOk.ok !== true) return { status: 'skipped', reason: 'budget', swept: invalidated, results };
    let knownNames;
    try { knownNames = deps.knownNames(); } catch { knownNames = null; }
    if (!Array.isArray(knownNames)) return { status: 'skipped', reason: 'names_unavailable', swept: invalidated, results };
    const at = deps.now();
    const tz = deps.tz(s);
    const head = lastEventId();
    const events = readEvents(at - LOOKBACK_SEC, head);
    const folds = foldDecisions(events.filter(e => e.type.startsWith('decision.') && e.redacted !== true && !isExcludedId(s, e.id)));
    const rowMap = (fn, source) => {
      const ids = events.filter(e => e.type === source).map(e => e.id);
      const m = new Map();
      for (let i = 0; i < ids.length; i += 400) for (const r of fn(ids.slice(i, i + 400))) m.set(r.eventId, r);
      return m;
    };
    const scenes = rowMap(deps.sceneRows, 'scene.played');
    const texts = rowMap(deps.textRows, 'phone.message');
    const chainMemo = new Map();
    const heavyChain = (ev) => {
      if (!chainMemo.has(ev.id)) {
        let v = true;
        try { v = causeChain(ev.id).some(x => x?.heavy === true || x?.type === 'heavy.started'); } catch { v = true; }
        chainMemo.set(ev.id, v);
      }
      return chainMemo.get(ev.id);
    };
    const venueNames = venueNamesNow();
    const heavyWindows = heavyWindowsOf(s);
    const arcOf = (id) => (Number.isSafeInteger(id) ? s.story?.arcs?.[id] ?? getEvent(id)?.payload ?? null : null);
    const base = { tz, isOut: (id) => isExcludedId(s, id), heavyChain, heavyWindows, folds, venueNames, arcOf,
      sceneRow: (id) => scenes.get(id) ?? null, textRow: (id) => texts.get(id) ?? null };
    // When they last met in person (any activity with them): what a beat from before that can still mean is the clerk's to weigh.
    const lastMet = new Map();
    for (const e of readEvents(at - LOOKBACK_SEC, head, ['activity.started'])) {
      if (e.redacted === true || isExcludedId(s, e.id) || !Array.isArray(e.payload?.withCast)) continue;
      for (const id of e.payload.withCast) if (!(lastMet.get(id) >= e.at)) lastMet.set(id, e.at);
    }
    const rom = activeRomance(s);
    const candidates = [];
    for (const [castId, member] of s.cast) {
      if (!activeMember(s, castId)) continue;
      const name = String(member?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) continue;
      const prev = store.live(castId);
      const r = linesFor(events, { ...base, castId, name, afterId: prev?.asOfEventId ?? 0, lastMetAt: lastMet.get(castId) ?? null });
      if (!changedEnough(r)) continue;
      const m = metricsOf(s, castId);
      const weight = r.counts.scene * 3 + r.counts.arc * 3 + r.counts.plan * 2 + r.counts.beat + r.counts.relationship + r.counts.text / 4;
      candidates.push({ castId, name, lines: r.lines, base: prev, privateWords: privateWordsOf(events, { castId, sceneRow: base.sceneRow, textRow: base.textRow }), weight, partner: rom?.partnerId === castId ? 1 : 0, closeness: finite(m.closeness) ? m.closeness : 0 });
    }
    candidates.sort((a, b) => b.partner - a.partner || b.weight - a.weight || b.closeness - a.closeness || (a.castId < b.castId ? -1 : 1));
    const maxNight = Number(config.arcs?.standingMaxPerNight ?? 4);
    const castNames = [...s.cast.values()].map(c => c?.name).filter(n => typeof n === 'string');
    let done = 0;
    for (const c of candidates) {
      if (done >= maxNight) { results.push({ castId: c.castId, outcome: 'night_cap' }); continue; }
      let stop = null;
      try { stop = await gate(deps.now(), tz); } catch { stop = 'ledger'; }
      if (!stop && typeof clerkLeft === 'function' && !clerkLeft()) stop = 'clerk_cap';
      if (stop) { results.push({ castId: c.castId, outcome: stop }); break; }
      done++;
      let r;
      try {
        r = await rebuildOne(s, c, { call, knownNames, castNames, venueNames, night: nightKey, head, clerkLeft });
      } catch (err) {
        warn('rebuild', err);
        r = { outcome: 'failed' };
      }
      results.push({ castId: c.castId, outcome: r.outcome });
      if (r.stop) break;
    }
    logger.info({ evt: 'arcs_standing', night: nightKey, candidates: candidates.length, swept: invalidated,
      outcomes: results.map(r => r.outcome).slice(0, 24) }, 'story: how things stand');
    return { status: 'done', swept: invalidated, candidates: candidates.length, results };
  } catch (err) {
    warn('pass', err);
    return { status: 'skipped', reason: 'failed' };
  } finally {
    running = false;
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

function holdsNow(s, version) {
  if (inRewoundRange(s, version.asOfEventId)) return false;
  const chain = store.chainOf(version);
  const evidence = store.evidenceOf(chain.map(v => v.id));
  for (const list of evidence.values()) if (list.some(e => isExcludedId(s, e.eventId))) return false;
  return !chain.some(v => v.status === 'invalidated');
}

/**
 * The note on a member as of `at`, for a writer's sheet. → { text, versionId, validFrom, asOfEventId } | null. No note, the
 * feature off, a member who left, evidence gone since, a read that fails: null, and the sheet falls back to its history.
 */
export function noteAt(s, castId, at) {
  try {
    if (!enabled() || !s || !activeMember(s, castId) || !finite(at)) return null;
    const v = store.asOf(castId, at);
    if (!v || !holdsNow(s, v)) return null;
    // What it knows runs to its as-of, not to when the row was written: a restored note is old words on a new row.
    return { text: v.text, versionId: v.id, validFrom: v.validFrom, asOfEventId: v.asOfEventId, asOfAt: getEvent(v.asOfEventId)?.at ?? v.validFrom };
  } catch {
    return null;
  }
}

const versionOut = (v, list) => {
  const sources = {};
  for (const e of list ?? []) sources[e.source] = (sources[e.source] ?? 0) + 1;
  return { id: v.id, status: v.status, reason: v.invalidReason ?? null, text: v.text, validFrom: v.validFrom, validTo: v.validTo ?? null,
    supersedes: v.supersedes ?? null, asOfEventId: v.asOfEventId, night: v.night ?? null, model: v.model ?? null, fellBack: v.fellBack === 1,
    evidenceCount: (list ?? []).length, sources };
};

/** The dashboard's: the note and its versions, newest first. A member who left keeps theirs to read. Never throws. */
export function view(castId) {
  try {
    const rows = store.versions(castId).slice(0, VERSIONS_SHOWN);
    const ev = store.evidenceOf(rows.map(v => v.id));
    const live = rows.find(v => v.status === 'live') ?? null;
    return {
      enabled: enabled(),
      current: live ? { ...versionOut(live, ev.get(live.id)), asOfAt: getEvent(live.asOfEventId)?.at ?? live.validFrom, evidence: (ev.get(live.id) ?? []).slice(-EVIDENCE_SHOWN).map(e => e.eventId) } : null,
      versions: rows.map(v => versionOut(v, ev.get(v.id))),
    };
  } catch {
    return { enabled: enabled(), current: null, versions: [] };
  }
}

/**
 * The site's rows: fictional cast he still has, a live note that holds now. Ready, not exported: the exporter's
 * `buildStanding` turns them into the optional `standing` key when the PM wires it. → [{ castId, text, validFrom }]
 */
export function publicRows(s = deps.getState()) {
  try {
    if (!s || !enabled()) return [];
    const windows = heavyWindowsOf(s);
    return store.allLive()
      .filter(v => activeMember(s, v.castId) && holdsNow(s, v) && !windows.some(w => v.validFrom >= w.from && v.validFrom <= w.to))
      .map(v => ({ castId: v.castId, text: v.text, validFrom: v.validFrom }));
  } catch {
    return [];
  }
}

export function __resetForTest() {
  running = false;
  lastSig = null;
}
