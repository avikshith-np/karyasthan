// Real thoughts (plan 020 F3): the reads, the gates and the one small call. Only story/index.js imports this. From the
// story's afterTick, so live only: a simulation never gets here. A thought changes nothing: no world event, no state, and no
// decision or prompt reads it. A failure of any kind just leaves the code stream. Logs carry codes only.
//
// The thought table has one store, and the life facade hands its functions in (deps.store).
import { CALLER, CALLER_PREFIX, FRESH_SEC, MIN_GAP_SEC, MOMENT_TYPES, RESERVOIR_SEC, SWING_WINDOW_SEC, THOUGHT_CHARTER, THOUGHTS_PER_DAY,
  DAY_END_HOUR, MAX_TRIES, chooseMoment, dayEndMoment, hasDayToLookBack, momentsOf, namesOnSheet, sheetOf, stateCodes, swingOf, validateThought, viewOf as rowView } from './real.js';
import { fence, FENCE_NOTE } from '../charter.js';
import { dateKey, dayStart, localParts } from '../../clock.js';
import { causeChain, getEvent, lastEventId, listEvents } from '../../eventLog.js';
import { isExcludedId } from '../../projector.js';
import { isActive as embargoActive } from '../../embargo.js';
import { isPaused } from '../controls.js';
import { venueNamesNow } from '../../places.js';
import { config } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const EARLIER_MAX = 3;
const DRIVER_TYPES = Object.freeze(['chat.perceived', 'commute.soaked', 'decision.expired', 'scene.played', 'work.crunch', 'sick.started']);

let deps = {};
let samples = [];                  // his mood over the last hours: lost on a restart, like cooldowns
let tried = new Map();             // moment key → calls that failed on it, today
let attempts = { day: null, n: 0, lastAt: 0 };

/** { now, getState, worldOf, tz, callRole, callRows(prefix, since), spend(at, tz) → month's $, roleBudgetOk(), knownNames, identity(), heavyAt, store, deedRows(date), isPrivateNow(at), isPrivateActivity(id) } */
export function configure(d = {}) {
  deps = { ...deps, ...d };
}

export function __resetForTest() {
  samples = [];
  tried = new Map();
  attempts = { day: null, n: 0, lastAt: 0 };
}

const nowSec = () => Math.floor(deps.now());
const log = (moment, status, code = null) => logger.info({ evt: 'thought.real', moment, status, code }, 'real thought');

function heavyChain(e) {
  try { return causeChain(e.id).some(x => x?.heavy === true || x?.type === 'heavy.started'); } catch { return true; }
}

// What's live: not undone, not redacted, nothing heavy in it.
function liveEvent(s, e) {
  return !e.redacted && e.heavy !== true && !isExcludedId(s, e.id) && !heavyChain(e);
}

/** Every tick (live): one more reading of his mood. Cheap, no read. A downtime gap restarts it. */
export function noteTick(view, info = {}) {
  const at = info.at;
  if (!Number.isSafeInteger(at) || !finite(view?.vitals?.mood?.valence)) return;
  if (info.steps > 1 || info.reanchored === true) samples = [];
  samples.push({ at, valence: view.vitals.mood.valence });
  samples = samples.filter(x => at - x.at <= SWING_WINDOW_SEC);
}

// What moved his mood, as codes. A chat's carries its origin, and its pointer as evidence: a forget takes the thought along.
function driversOf(s, from, at) {
  const out = [];
  const seen = new Set();
  const add = (code, e, origin = null) => { if (!seen.has(code)) { seen.add(code); out.push({ code, id: e?.id ?? null, origin }); } };
  for (const e of listEvents({ types: DRIVER_TYPES, from, to: at, order: 'asc', limit: 200 })) {
    if (!liveEvent(s, e)) continue;
    const p = e.payload ?? {};
    if (e.type === 'chat.perceived' && p.kind === 'affect' && ['group', 'dm', 'call', 'ig'].includes(e.originKind)) add(`chat:${p.affect}`, e, { kind: e.originKind, jid: e.originJid ?? null });
    if (e.type === 'commute.soaked') add('soaked', e);
    if (e.type === 'work.crunch') add('crunch', e);
    if (e.type === 'sick.started') add('sick', e);
    if (e.type === 'decision.expired' && !['group', 'dm', 'call', 'ig'].includes(e.originKind)) add('plan_off', e);
    if (e.type === 'scene.played' && p.outcome === 'badly' && !e.subjectJid) add('outing_badly', e);
    if (e.type === 'scene.played' && p.outcome === 'well' && !e.subjectJid) add('outing_well', e);
  }
  return out;
}

async function capsOk(at, tz) {
  const cap = Number(config.arcs?.realThoughtMaxPerDay ?? 0);
  if (!(cap > 0)) return 'off';
  const budget = Number(config.arcs?.realThoughtBudgetUsd ?? 0);
  if (!(budget > 0)) return 'off';
  let rows;
  try {
    rows = await deps.callRows(CALLER_PREFIX, dayStart(at, tz));
    if (!Array.isArray(rows)) return 'ledger';
  } catch { return 'ledger'; }
  const today = rows.reduce((a, r) => a + (Number(r.calls) || 0), 0);
  if (Math.max(today, attempts.day === dateKey(at, tz) ? attempts.n : 0) >= cap) return 'day_cap';
  let usd;
  try { usd = await deps.spend(at, tz); } catch { return 'ledger'; }
  if (!finite(usd)) return 'ledger';
  if (!(usd < budget)) return 'budget';
  // The mouth runs anyway when over its budget, for chat's sake; a thought isn't chat.
  try { if (await deps.roleBudgetOk() !== true) return 'budget'; } catch { return 'budget'; }
  return null;
}

/** One pass. → { status, reason?, moment? }. Never throws for a model or a ledger failure. */
export async function runRealThoughts() {
  if (config.arcs?.realThoughtsEnabled === false) return { status: 'off' };
  const s0 = deps.getState();
  const at = nowSec();
  const tz = deps.tz(s0);
  const day = dateKey(at, tz);
  if (attempts.day !== day) { attempts = { day, n: 0, lastAt: attempts.lastAt }; tried = new Map(); }
  if (s0?.genesisAt === null || s0?.genesisAt === undefined) return { status: 'none' };
  if (s0.activity?.kind === 'sleep') return { status: 'asleep' };
  if (isPaused(s0)) return { status: 'paused' };
  // A private session gets no model thought, and neither does a heavy stretch: unknown → none.
  let priv = true;
  try { priv = deps.isPrivateNow(at) === true; } catch { priv = true; }
  if (priv) return { status: 'private' };
  if (embargoActive(s0.embargo, at) || deps.heavyAt(s0, at)) return { status: 'heavy' };

  const store = deps.store;
  const todays = store.realBetween(dayStart(at, tz), at + 1);
  if (todays.length >= THOUGHTS_PER_DAY) return { status: 'enough' };
  const spent = store.realBetween(at - RESERVOIR_SEC, at + 1).at(-1) ?? null;
  if (spent && at - spent.at < MIN_GAP_SEC) return { status: 'gap' };
  if (at - attempts.lastAt < MIN_GAP_SEC) return { status: 'gap' };   // a failed call too

  const from = Math.max(at - RESERVOIR_SEC, spent?.at ?? 0);
  const spentId = Number.isSafeInteger(spent?.asOf) ? spent.asOf : 0;
  const events = listEvents({ types: MOMENT_TYPES, from, to: at, order: 'asc', limit: 500 }).filter(e => e.id > spentId && liveEvent(s0, e));
  const swing = swingOf(samples.filter(x => x.at >= (spent?.at ?? 0)), at);
  const parts = localParts(at, tz);
  const hhmm = (t) => { const p = localParts(t, tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

  // The deed rows are a fold of the decision log: only when there's a decision to look at.
  const deedCache = new Map();
  const deedRow = (id) => {
    if (!events.some(e => e.type === 'decision.committed' || e.type === 'decision.reversed')) return null;
    for (const date of [day, dateKey(at - FRESH_SEC, tz)]) {
      if (!deedCache.has(date)) { let rows = []; try { rows = deps.deedRows(date) ?? []; } catch { rows = []; } deedCache.set(date, rows); }
      const hit = deedCache.get(date).find(r => r.id === id);
      if (hit) return hit;
    }
    return null;
  };
  const isPrivate = (id) => { try { return deps.isPrivateActivity(id) === true; } catch { return true; } };
  // A venue's name in a thought: its kind word. Unreadable → no call.
  let venueNames;
  try { venueNames = venueNamesNow(); } catch { return { status: 'skipped', reason: 'venues' }; }

  const world = deps.worldOf(s0);
  const moneyRef = finite(world?.money?.salary) ? world.money.salary : null;
  const ctx = { s: s0, at, parts, dayKey: day, hhmm, deedRow, isPrivate, venueNames, moneyRef, v: s0.vitals, swing, swingKey: `${day}:${Math.floor(at / (SWING_WINDOW_SEC))}`,
    drivers: swing ? driversOf(s0, at - swing.overSec, at) : [] };
  const moments = momentsOf(events, ctx);
  const spentOn = new Set([...tried].filter(([, n]) => n >= MAX_TRIES).map(([k]) => k));
  let m = chooseMoment(moments, { at, spentOn });
  if (!m && parts.hour >= DAY_END_HOUR && hasDayToLookBack(moments, todays)) {
    const d = dayEndMoment(ctx);
    if (!spentOn.has(d.key) && !todays.some(r => r.dedupeKey === `real:${d.key}`)) m = d;
  }
  if (!m) return { status: 'quiet' };

  const gate = await capsOk(at, tz);
  if (gate) { log(m.moment, 'skipped', gate); return { status: 'skipped', reason: gate }; }
  let knownNames;
  try { knownNames = deps.knownNames(); if (!Array.isArray(knownNames)) throw new Error('names'); } catch { log(m.moment, 'skipped', 'names'); return { status: 'skipped', reason: 'names' }; }

  // A chat's thought stays out of a later sheet: a forget takes that row, and nothing built on it should stay.
  const earlier = todays.filter(r => r.originKind === 'self' || r.originKind === 'owner').slice(-EARLIER_MAX).map(r => r.text);
  const lines = sheetOf(m, { ...ctx, earlier, others: m.moment === 'day_end' ? moments : moments.filter(x => at - x.at <= FRESH_SEC) });
  const user = `${FENCE_NOTE}\n\n${fence(lines, { kind: 'facts', cap: 320 })}\n\n${m.ask} Reply with the JSON object.`;
  const asOf = lastEventId();
  attempts.n += 1;
  attempts.lastAt = at;
  let res;
  try {
    res = await deps.callRole('mouth', { core: await deps.identity(), profile: THOUGHT_CHARTER }, user, { caller: CALLER, maxTokens: 160, temperature: 0.9, timeoutMs: 30_000 });
  } catch { res = null; }
  const fail = (reason) => { tried.set(m.key, (tried.get(m.key) ?? 0) + 1); log(m.moment, 'failed', reason); return { status: 'failed', reason, moment: m.moment }; };
  if (!res || res.status !== 'ok' || typeof res.text !== 'string') return fail(res?.skipped ? 'budget' : 'model_failed');
  const castNames = [...(s0.cast instanceof Map ? s0.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  const names = [...new Set([...(m.names ?? []), ...namesOnSheet(lines, castNames)])];   // whoever the sheet names, not only the moment's
  const v = validateThought(res.text, { names, knownNames, castNames, venueNames, earlier: todays.map(r => r.text) });
  if (!v.ok) return fail(v.reason);

  // It took a while: what it rests on may have gone, and he may have moved on.
  const s1 = deps.getState();
  const after = nowSec();
  for (const id of m.evidence) {
    const e = getEvent(id);
    if (!e || e.redacted || isExcludedId(s1, id)) return fail('evidence_gone');
  }
  let privNow = true;
  try { privNow = deps.isPrivateNow(after) === true; } catch { privNow = true; }
  if (privNow || embargoActive(s1.embargo, after) || deps.heavyAt(s1, after)) return fail('moved_on');

  const codes = { ...m.codes, kind: 'real', moment: m.moment, title: m.title ?? null, state: stateCodes(s0.vitals, s0) };
  const stored = store.insert({
    at: after, family: 'excuse', text: v.text, codes, originKind: m.origin?.kind ?? 'self', originJid: m.origin?.jid ?? null,
    evidence: m.evidence, asOf, cause: m.cause ?? m.moment, dedupeKey: `real:${m.key}`, phraseKey: null,
  }, after);
  log(m.moment, stored ? 'written' : 'duplicate');
  return { status: stored ? 'written' : 'duplicate', moment: m.moment };
}

export const viewOf = rowView;
