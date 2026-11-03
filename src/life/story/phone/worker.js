// The phone worker (spec 019). Runs on the story's own serialized chain (story/index.js
// enqueue), never on the tick's and never from a sim: story.afterTick is live-only, so
// texts are structurally absent from tomorrow.simulate, the Day projection and preview
// tomorrow.
//
//   scan()          cursor scan of trigger events → story_messages 'pending' rows (one
//                   transaction with the cursor): the owner's phone.text_set; a scene that
//                   went well or ended in swapped numbers / a plan to meet; a member's
//                   birthday; their news; a trip to a plan with them ("on my way"); a
//                   romance starting or moving on. Only self/owner-origin triggers with no
//                   real-person subject and no heavy event in the chain (fail closed). The
//                   first scan (and every off → on) seeds the cursor to the log head.
//   rollDay()       once a local day, after his wake: at most two texts out of the blue —
//                   one of them texting him first, him texting the closest one in the evening.
//   processDue()    ≤ 3 due turns → runTurn.
//   runTurn(row)    gates (enabled, paused / heavy for organic turns, his availability or
//                   their night, the day / member / organic caps, the ledger day cap and the
//                   month $ cap) → the writer (his side: the mind for an owner's ask, else the
//                   mouth with his identity core; their side: the clerk) → validate → commit.
//                   A refused or failed call → no message (never a code stand-in).
//   commit(...)     pulse.exclusive(() => withDecisionLock(…)) and ONE SQLite transaction:
//                   phone.message (engine, caused by its trigger) + its effects, the row →
//                   live with its text; then the other side's reply is queued (or not).
//   regenerate(id)  an owner REWRITE of the newest turn of a thread: the new turn caused by
//                   the old one's cause, the old one reverted (its pending reply goes with it).
//
// Logging: evt 'arcs_phone' with codes only — never the sheet, the text or a gist.
import { config, getPersona } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { now as clockNow, dateKey, dayStart, resolveTimezone, ageOn, localParts, zonedToUnix, hhmm, dayLabel } from '../../clock.js';
import { rngFor as rngForDefault } from '../../rng.js';
import { getEvent, listEvents, lastEventId, causeChain, revertEvent as logRevert } from '../../eventLog.js';
import { isExcludedId, vitalsAt } from '../../projector.js';
import { availabilityAt } from '../../availability.js';
import { venueNamesNow, isHomeKind } from '../../places.js';
import { withDecisionLock } from '../../decisions.js';
import { goingTo, chatMadeDecision } from '../../planWeight.js';
import { check as controlsCheck, pinKeysFor, isPaused, fateOf, sliderValue } from '../controls.js';
import { romanceEligible, metricsOf, activeRomance } from '../romance.js';
import { heavyGuardActive } from '../reducer.js';
import {
  registerOf, urgeNow, urgeBand, heatOf, contentProblem, phonePrivate, organicPick,
} from '../desire.js';
import { arcsCallerSpend } from '../seed.js';
import * as store from './store.js';
import { getState as storyStateGet, patchState as storyStatePatch } from '../store.js';
import { buildSheet, placeWords, relWhen, timelineLines, planLines } from './facts.js';
import { jobWordsOf } from '../reducer.js';
import { HIS_CHARTER, CAST_CHARTER, renderUser, charterFor, BODY_ASK_LINE, THREAD_LINES } from './charter.js';
import { validateTexts, repeatedPhrase, repeatedToday, questionsIn, gistMiss, gistFallback, bodyAsk, gistAllows, gistIsAsk } from './schema.js';
import { cueCheck, PLAN_PROMPT, PLAN_TURNS, renderPlanUser, validatePlanOutput, resolveTextPlan, appendPlan } from './plans.js';
import { createHash } from 'crypto';

// Phone callers live under their own `life.phone.` prefix: texting never uses up the
// arcs or the scene budget.
export const CALLER_PREFIX = 'life.phone.';
export const CALLER_HIS = 'life.phone.his';
export const CALLER_MIND = 'life.phone.mind';
export const CALLER_CAST = 'life.phone.cast';
// Plans from texts (owner 2026-11-01): one clerk call when two turns read like an agreement to meet.
export const CALLER_PLAN = 'life.phone.plan';
export const PLAN_MAX_PER_DAY = 12;
export const PLAN_RECENT_HOURS = 6;   // a text plan with them this recent: later "see you then"s spend no call
export const PER_TICK = 3;
export const EXCHANGE_MAX = 8;
// An owner-started chat (the owner's `text`, either side first): chat 'long' runs up to
// LONG_EXCHANGE_MAX turns, each answered with at least LONG_REPLY_P; both sides answer within
// OWNER_REPLY_MIN minutes and stay up for it (no night gate while the last turn is < OWNER_LIVE_MIN old).
export const LONG_EXCHANGE_MAX = 100;   // a safety stop (owner 2026-11-01: no limit); a long chat ends when a writer ends it
// A long chat the owner started goes on until a writer ends it (`end`) or the cap — never on a
// dice roll (2026-11-01 live: a 0.967 draw stopped a morning chat after his question).
export const LONG_REPLY_P = 1;
// An owner-started chat claims its thread this long after its newest owner turn: a text from the
// thread's own life in that time (one queued earlier) is part of the chat, not a separate exchange.
export const OWNER_SESSION_MIN = 90;
export const OWNER_SESSION_MAX_HOURS = 6;
export const ECHO_RETRIES = 3;   // a repeating turn comes back this many times before it is dropped
export const OWNER_REPLY_MIN = Object.freeze([1, 6]);   // (kept for reference; owner chats now answer in OWNER_REPLY_SEC)
// Owner 2026-11-01 ("the texts are still very slow"): an owner-started chat answers in 20–90 s.
export const OWNER_REPLY_SEC = Object.freeze([20, 90]);
// Pace by how they feel about each other (owner: "increase the pace based on closeness and relationship").
// bond → reply delay (seconds), the chance the other side answers, and how long a chat can run.
export const BOND_PACE = Object.freeze({
  romance: { delay: [30, 180], slowP: 0.05, slow: [600, 1800], replyP: 0.95, max: 40 },
  spark:   { delay: [60, 300], slowP: 0.06, slow: [900, 2700], replyP: 0.9, max: 30 },
  close:   { delay: [120, 600], slowP: 0.08, slow: [1800, 5400], replyP: 0.8, max: 16 },
});

/** How the two of them are: romance (his active romance partner), spark (passion ≥ 0.3), close (closeness ≥ 0.6) or null. */
export function bondOf(s, castId) {
  try {
    const r = activeRomance(s);
    if (r && r.partnerId === castId) return 'romance';
    const m = metricsOf(s, castId);
    if ((m?.passion ?? 0) >= 0.3) return 'spark';
    if ((m?.closeness ?? 0) >= 0.6) return 'close';
  } catch { /* none */ }
  return null;
}
export const OWNER_LIVE_MIN = 45;
// Will the other side answer turn n of an exchange? (an owner's ask is almost always answered)
export const REPLY_P = Object.freeze([0.95, 0.8, 0.65, 0.5, 0.35, 0.25, 0.15, 0.1]);
export const STALE_HOURS = 14;
export const PHONE_DAY_MAX = 0.03;       // closeness (and passion / tension) per member per local day from texts
export const PHONE_STEP = 0.01;
// One person, one stream of attention (owner 2026-11-02: he was texting one of them while another was at his
// flat). Each text he sends while he is with someone in person costs a little with each of them;
// a flirty one with someone else costs more with a romance partner. ≤ ATTENTION_DAY_MAX per metric
// per member per local day. Code-only, caused by the text (a revert of the text takes it back).
export const ATTENTION_STEP = 0.01;
export const ATTENTION_JEALOUS = 0.02;
export const ATTENTION_DAY_MAX = 0.06;
const WARM_TONES = new Set(['flirty', 'teasing', 'naughty']);
export const ROMANCE_TEXTS = 8;          // live texts with the partner in 7 days (≥ 3 warm/flirty) → interested → talking
export const HEAVY_WINDOW_BEFORE = 2 * 86400;
export const HEAVY_WINDOW_AFTER = 31 * 86400;
const TRIGGER_TYPES = ['phone.text_set', 'scene.played', 'birthday', 'cast.beat', 'travel.started', 'arc.started', 'arc.stage', 'decision.reversed', 'decision.expired'];
// 020: a plan with someone from his world fell through and they were expecting him: he tells them.
const FELL_THROUGH = new Set(['could_not_go', 'owner_plan', 'owner_cancelled', 'fell_through', 'schedule']);
const NEWS_BEATS = new Set(['news', 'milestone', 'back', 'trip']);
const ORGANIC_SKIP = new Set(['owner', 'reply', 'regenerate']);
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

let deps = {
  now: () => Math.floor(clockNow()),
  getState: () => null,
  append: null,
  world: null,
  worldOf: (s) => null,
  pulse: null,
  rebuild: () => {},
  callRole: async (...args) => (await import('../../../brain/llm.js')).callRole(...args),
  // His identity core (the cached system text's identity part), read at call time.
  identity: async () => (await import('../../../personality/systemPrompt.js')).identityCore(),
  getUsageByCaller: null,       // strict reader (a throw = cap reached); null → brain/usage.js getUsageByCallerStrict
  mindBudgetOk: null,           // 008's gate; null → the mind writer refuses (fail closed; the mouth writes)
  knownNames: () => [],
  rngFor: rngForDefault,
  persona: () => getPersona(),
  settle: () => {},             // after a plan from texts: the pulse fits it now, not at the next tick
};

/** Wire the worker (story/index.js wire()); partial updates keep the rest. */
export function configure(d = {}) {
  deps = { ...deps, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) };
}

const nowSec = () => Math.floor(deps.now());
const tzOf = (s) => resolveTimezone(s?.world?.timezone ?? deps.world?.timezone ?? config.timezone);
const enabled = () => config.arcs?.phoneEnabled !== false && Number(config.arcs?.phoneMaxPerDay ?? 100000) > 0;

function log({ status = null, tier = null, skip = null, id = null, ms = null, trigger = null, dir = null } = {}) {
  try { logger.info({ evt: 'arcs_phone', status, tier, skip, id, ms, trigger, dir }, 'story: phone'); } catch { /* best effort */ }
}

function sha(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

const activeMember = (s, id) => typeof id === 'string' && s?.cast instanceof Map && s.cast.has(id);
const selfOrigin = (ev) => ev && ['self', 'owner'].includes(ev.originKind) && !ev.subjectJid;

function heavyChain(ev) {
  try { return causeChain(ev.id).some(e => e?.heavy === true || e?.type === 'heavy.started'); } catch { return true; }
}

function gone(s, id) {
  if (!posInt(id)) return false;
  if (isExcludedId(s, id)) return true;
  const ev = getEvent(id);
  return !ev || ev.redacted === true;
}

// ── scan ─────────────────────────────────────────────────────────────────────

/** The phone went off (the arcs skill or ARCS_PHONE_ENABLED): the next scan re-seeds. */
export function markPhoneOff() {
  try { if (store.getPhoneOn() !== false) store.setPhoneOn(false); } catch { /* the next on re-seeds anyway */ }
}

/** Rows a crash left 'running' → pending (the first phone job after attach). */
export function resetInterrupted() {
  return store.resetRunning();
}

function rnd(row, purpose, tz, at) {
  return deps.rngFor(dateKey(at, tz), `phone:${purpose}:${row}`);
}

// Would this member be expecting him? A plan agreed in texts with them; else they have a thread with
// him and this wasn't to be their first meeting (nobody gets "can't make it" out of nowhere).
function knowsAboutPlan(s, d, castId) {
  if (d.committed?.by === 'text') return true;
  if (!store.lastLive(castId)) return false;
  try { return deps.firstMeeting?.(s, d, castId) !== true; } catch { return false; }
}

/** The triggers turnsFor can queue: each must be one store.TRIGGERS allows (test: arcs 99-one-being). */
export const TURN_TRIGGERS = Object.freeze(['owner', 'after_scene', 'birthday', 'news', 'on_my_way', 'backing_out', 'romance']);

// The pending turns one trigger event asks for (pure over the state + the event).
function turnsFor(s, ev, tz) {
  const p = isObj(ev.payload) ? ev.payload : {};
  const r = rnd(ev.id, 'scan', tz, ev.at);
  const out = [];
  const push = (castId, dir, trigger, dueAt) => { if (activeMember(s, castId)) out.push({ castId, dir, trigger, dueAt: Math.max(ev.at, Math.round(dueAt)) }); };
  switch (ev.type) {
    case 'phone.text_set':
      push(p.castId, p.from === 'them' ? 'in' : 'out', 'owner', finite(p.at) ? p.at : ev.at);
      break;
    case 'scene.played': {
      if (p.mode !== 'full' || !Array.isArray(p.castIds) || !p.castIds.length) break;
      if (!(['plan_to_meet', 'swapped_numbers'].includes(p.ending) || p.outcome === 'well')) break;
      const id = p.castIds[0];
      push(id, r() < 0.6 ? 'out' : 'in', 'after_scene', ev.at + r.int(20, 120) * MIN);
      break;
    }
    case 'birthday':
      if (typeof p.castId === 'string') push(p.castId, 'out', 'birthday', ev.at + r.int(10, 180) * MIN);
      break;
    case 'cast.beat':
      if (NEWS_BEATS.has(p.kind) && r() < 0.6) push(p.castId, p.kind === 'back' || r() < 0.5 ? 'out' : 'in', 'news', ev.at + r.int(30, 240) * MIN);
      break;
    case 'travel.started': {
      const d = [...(s.decisions instanceof Map ? s.decisions.values() : [])].find(x => x?.status === 'committed'
        && x.subject?.placeId === p.to && finite(x.subject?.eventAt) && x.subject.eventAt >= ev.at && x.subject.eventAt <= ev.at + 3 * HOUR
        && Array.isArray(x.subject?.castIds) && x.subject.castIds.length && !x.subjectJid);
      if (d && r() < 0.35) push(d.subject.castIds[0], 'out', 'on_my_way', ev.at);
      break;
    }
    case 'decision.reversed':
    case 'decision.expired': {
      if (ev.type === 'decision.expired' && !FELL_THROUGH.has(p.reason)) break;
      // go ↔ late is no backing out: only a real decline counts.
      if (ev.type === 'decision.reversed' && !(['go', 'late'].includes(p.from) && ['stay', 'skip'].includes(p.to))) break;
      const d = s.decisions instanceof Map ? s.decisions.get(posInt(p.decisionId)) : null;
      if (!d || !Array.isArray(d.subject?.castIds) || !finite(d.subject?.eventAt) || d.subject.eventAt <= ev.at) break;
      // A plan made in a chat stays "busy" to a fictional person (facts.planLines): no text, here or on the site.
      if (chatMadeDecision(d)) break;
      if (ev.type === 'decision.expired' && !['go', 'late'].includes(d.committed?.optionId)) break;
      for (const id of d.subject.castIds.slice(0, 3)) {
        if (s.cast?.get?.(id)?.relation === 'flatmate' || !knowsAboutPlan(s, d, id)) continue;
        push(id, 'out', 'backing_out', ev.at + r.int(1, 10) * MIN);
      }
      break;
    }
    case 'arc.started':
      if (p.category === 'romance' && Array.isArray(p.castIds)) push(p.castIds[0], r() < 0.5 ? 'out' : 'in', 'romance', ev.at + r.int(60, 360) * MIN);
      break;
    case 'arc.stage': {
      const arc = s.story?.arcs?.[posInt(p.arcId)];
      if (arc?.category === 'romance' && ['talking', 'dating', 'committed'].includes(p.to)) {
        push(arc.castIds?.[0], r() < 0.5 ? 'out' : 'in', 'romance', ev.at + r.int(60, 360) * MIN);
      }
      break;
    }
    default: break;
  }
  return out;
}

/** Cursor scan → pending rows (DB only, one transaction). → how many were queued. */
export function scan({ insert = store.insertPending } = {}) {
  const s = deps.getState();
  if (!isObj(s) || s.genesisAt === null || s.genesisAt === undefined) return 0;
  const cursor = store.getCursor();
  if (cursor === null || store.getPhoneOn() !== true) {
    store.inTransaction(() => { store.setCursor(lastEventId()); store.setPhoneOn(true); });
    return 0;
  }
  const evs = listEvents({ types: TRIGGER_TYPES, after: cursor, limit: 200, order: 'asc' });
  if (!evs.length) return 0;
  const tz = tzOf(s);
  let n = 0;
  store.inTransaction(() => {
    for (const ev of evs) {
      if (ev.redacted || isExcludedId(s, ev.id) || !selfOrigin(ev) || ev.heavy === true || heavyChain(ev)) continue;
      // One bad row is skipped with a warning: it must never stop the cursor, or every later job dies on it.
      try {
        for (const t of turnsFor(s, ev, tz)) {
          if (store.hasTrigger(t.trigger, ev.id, t.castId, 0)) continue;
          if (insert({ ...t, triggerEventId: ev.id, exchange: 0, createdAt: nowSec() })) n++;
        }
      } catch (err) {
        logger.warn({ evt: 'issue', where: 'arcs.phone.scan', id: ev.id, type: ev.type, err: err?.name || 'Error' }, 'story: a text trigger was skipped');
      }
    }
    store.setCursor(evs[evs.length - 1].id);
  });
  return n;
}

// ── the day's texts out of the blue ──────────────────────────────────────────

/**
 * Once a local day, from 09:00 while he is up: a member may text him first (closer →
 * likelier) and he may text the closest one in the evening. Rows only; caps at write.
 */
export function rollDay() {
  const s = deps.getState();
  if (!isObj(s) || !(s.cast instanceof Map) || !s.cast.size) return 0;
  const at = nowSec();
  const tz = tzOf(s);
  const date = dateKey(at, tz);
  if (store.getRolledDate() === date) return 0;
  if (localParts(at, tz).hour < 9 || s.activity?.kind === 'sleep') return 0;
  const r = deps.rngFor(date, 'phone:day');
  const members = [...s.cast.keys()].map(id => ({ id, m: metricsOf(s, id) })).sort((a, b) => b.m.closeness - a.m.closeness || (a.id < b.id ? -1 : 1));
  const [y, mo, d] = date.split('-').map(Number);
  const evening = (h0, h1) => zonedToUnix(y, mo, d, 0, 0, tz) + r.int(h0 * 60, h1 * 60) * MIN;
  const rows = [];
  const urge = urgeNow(s, { now: at, tz });
  const wanted = organicPick(s, { urge, drama: sliderValue('drama', s) ?? 0.5, roll: r() });
  // Someone texts him first: a love or lust interest when he is wound up, else the closest.
  const inbound = wanted ? [{ id: wanted, m: metricsOf(s, wanted) }] : members.slice(0, 6);
  for (const { id, m } of inbound) {
    const p = wanted ? 0.45 : 0.08 + 0.3 * Math.max(0, m.closeness - 0.2);
    if (r() < p) {
      rows.push({ castId: id, dir: 'in', trigger: wanted ? 'desire' : 'cast_first', dueAt: Math.max(at + 10 * MIN, evening(11, 21)) });
      break;
    }
  }
  // He texts them in the evening: the weighted love/lust pick when urge is high, else the closest.
  // A high-urge day does not also add the closest friend.
  const eveningId = wanted
    ? (rows.some(rw => rw.castId === wanted) ? null : wanted)
    : members.find(x => !rows.some(rw => rw.castId === x.id) && x.m.closeness >= 0.45)?.id;
  if (eveningId && r() < (wanted ? 0.55 : 0.35)) {
    rows.push({ castId: eveningId, dir: 'out', trigger: wanted ? 'desire' : 'evening', dueAt: Math.max(at + 10 * MIN, evening(19, 22)) });
  }
  store.inTransaction(() => {
    store.setRolledDate(date);
    for (const row of rows) store.insertPending({ ...row, triggerEventId: null, exchange: 0, createdAt: at });
  });
  return rows.length;
}

// Owner 2026-11-01 ("if two people like each other, they will text each other a lot"): besides the
// day's roll, a romance / spark / close bond gets a chance in each window of the day — morning,
// midday, evening, late — him or them first. Once per window per local date (story_state
// phone_bond_rolled = 'YYYY-MM-DD|w,w'); ≤ 3 bonds; never while asleep or while they're together.
const BOND_WINDOWS = Object.freeze([['m', 9, 11], ['d', 13, 15], ['e', 19, 21], ['n', 22, 24]]);
const BOND_START_P = Object.freeze({ romance: 0.7, spark: 0.55, close: 0.3 });
export function rollBonds() {
  const s = deps.getState();
  if (!isObj(s) || !(s.cast instanceof Map) || !s.cast.size || s.activity?.kind === 'sleep') return 0;
  const at = nowSec();
  const tz = tzOf(s);
  const date = dateKey(at, tz);
  const h = localParts(at, tz).hour;
  const win = BOND_WINDOWS.find(([, a, b]) => h >= a && h < b);
  if (!win) return 0;
  const raw = storyStateGet('phone_bond_rolled');
  const [d0, ws] = typeof raw === 'string' ? raw.split('|') : [null, ''];
  const done = d0 === date ? new Set(String(ws || '').split(',').filter(Boolean)) : new Set();
  if (done.has(win[0])) return 0;
  const r = deps.rngFor(date, `phone:bond:${win[0]}`);
  const bonds = [...s.cast.keys()].map(id => ({ id, bond: bondOf(s, id) })).filter(x => x.bond)
    .sort((a, b) => Object.keys(BOND_START_P).indexOf(a.bond) - Object.keys(BOND_START_P).indexOf(b.bond)).slice(0, 3);
  const rows = [];
  for (const { id, bond } of bonds) {
    if (store.pendingFor(id).length) continue;                                     // a chat already waiting
    if (Array.isArray(s.activity?.withCast) && s.activity.withCast.includes(id)) continue;   // together now
    if (r() >= BOND_START_P[bond]) continue;
    const them = r() < 0.5;
    rows.push({ castId: id, dir: them ? 'in' : 'out', trigger: them ? 'cast_first' : 'evening', dueAt: at + r.int(2, 25) * MIN });
  }
  done.add(win[0]);
  store.inTransaction(() => {
    storyStatePatch({ phone_bond_rolled: `${date}|${[...done].join(',')}` });
    for (const row of rows) store.insertPending({ ...row, triggerEventId: null, exchange: 0, createdAt: at });
  });
  return rows.length;
}

// ── gates (all fail closed) ──────────────────────────────────────────────────

async function usageRows(since) {
  const fn = deps.getUsageByCaller ?? (await import('../../../brain/usage.js')).getUsageByCallerStrict;
  const rows = fn(CALLER_PREFIX, since);
  if (!Array.isArray(rows)) throw new Error('ledger');
  return rows.filter(r => typeof r?.caller === 'string' && r.caller.startsWith(CALLER_PREFIX));
}

/** Today's phone calls and the month's spend. → { today, monthUsd, perCast, organic } | null (unreadable). */
export async function budgetStatus(at = nowSec(), tz = tzOf(deps.getState())) {
  try {
    const since = dayStart(at, tz);
    const rows = await usageRows(since);
    const monthUsd = await arcsCallerSpend(at, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [CALLER_PREFIX] });
    if (!finite(monthUsd)) return null;
    const counts = store.countsSince(since);
    return { today: rows.reduce((a, r) => a + (Number(r.calls) || 0), 0), monthUsd, perCast: counts.perCast, organic: counts.organic };
  } catch {
    return null;
  }
}

// `long`: a turn of an owner's long chat — the per-member day cap is raised by LONG_EXCHANGE_MAX
// for it (unless the owner set that cap to 0); the day's call cap and the month's $ cap hold as ever.
async function capReason(row, at, tz, { long = false } = {}) {
  const b = await budgetStatus(at, tz);
  if (!b) return 'ledger';
  if (!(b.today < Number(config.arcs?.phoneMaxPerDay ?? 100000))) return 'cap';
  if (!(b.monthUsd < Number(config.arcs?.phoneBudgetUsd ?? 3))) return 'budget';
  const perCast = Number(config.arcs?.phonePerCastDay ?? 100000);
  const castCap = long && perCast > 0 ? perCast + LONG_EXCHANGE_MAX : perCast;
  if (!((b.perCast[row.castId] ?? 0) < castCap)) return 'cast_cap';
  if (!ORGANIC_SKIP.has(row.trigger) && !(b.organic < Number(config.arcs?.phoneOrganicPerDay ?? 100000))) return 'organic_cap';
  return null;
}

// When may this side write? → null (now) | a later unix time | 'stale' | 'dozed'
// An owner-started chat (`owner` = its phone.text_set, or null): he looks again within minutes
// while asleep (a wake is usually on its way), and their side stays up for it — no night gate for
// the owner's own first turn or while the last turn is < OWNER_LIVE_MIN old.
export function waitFor(s, row, at, tz, world, owner = null) {
  if (at - row.createdAt > STALE_HOURS * HOUR && row.trigger !== 'owner') return 'stale';
  const r = rnd(row.id, `wait:${row.tries}`, tz, at);
  // Together in person (2026-11-01 live: he texted her at 18:50 while she was at his flat): no texts
  // between them until they part — the turn waits for the end of what they're doing together.
  const act = s?.activity;
  if (act && Array.isArray(act.withCast) && act.withCast.includes(row.castId)) {
    const end = Number.isSafeInteger(act.endAt) && act.endAt > at ? act.endAt : at + 30 * MIN;
    return end + r.int(2, 10) * MIN;
  }
  // One stream of attention: while he is with anyone in person, his own texts (to anyone) wait until
  // they part. An owner-started chat goes through — a deliberate interruption, and it costs (attentionEffects).
  if (row.dir === 'out' && !owner && presentWith(s).length) {
    const end = Number.isSafeInteger(act.endAt) && act.endAt > at ? act.endAt : at + 30 * MIN;
    return end + r.int(2, 10) * MIN;
  }
  if (row.dir === 'out') {
    let av;
    try { av = availabilityAt(s, at, world); } catch { av = { state: 'free' }; }
    if (av.state === 'asleep') {
      // He fell back asleep in the middle of an owner-started chat: it ends there (no 9 am answer).
      if (owner && row.trigger === 'reply' && at - row.createdAt > OWNER_LIVE_MIN * MIN) return 'dozed';
      return at + (owner ? r.int(2, 5) : r.int(30, 60)) * MIN;
    }
    if (['busy', 'meeting', 'dnd'].includes(av.state) && !av.onPhone) return at + r.int(15, 45) * MIN;
    return null;
  }
  if (owner) {
    if (row.trigger === 'owner') return null;
    const prevAt = posInt(row.triggerEventId) ? getEvent(row.triggerEventId)?.at : null;
    if (finite(prevAt) && at - prevAt < OWNER_LIVE_MIN * MIN) return null;
  }
  // Their side: people sleep too (local 00:30–07:00 → the morning).
  const h = localParts(at, tz).hour + localParts(at, tz).minute / 60;
  if (h >= 0.5 && h < 7) {
    const [y, mo, d] = dateKey(at, tz).split('-').map(Number);
    return zonedToUnix(y, mo, d, 7, 0, tz) + r.int(10, 120) * MIN;
  }
  return null;
}

// ── context reads ────────────────────────────────────────────────────────────

/** This side's texts in the last 24 h (oldest first): all of them, and those already past the writer's 12-line thread. A failed read → none. */
function saidToday(s, row, at, { beforeAt = null, beforeId = null } = {}) {
  try {
    const rows = store.threadOf(row.castId, { live: true, limit: 120, ...(posInt(beforeAt) ? { before: beforeAt, beforeId: beforeId ?? 0 } : {}) })
      .filter(r => !isExcludedId(s, r.eventId) && r.at >= at - DAY);
    const mine = (list) => list.filter(r => r.dir === row.dir).map(r => r.editedText || r.text || '').filter(Boolean).reverse();
    return { all: mine(rows), older: mine(rows.slice(THREAD_LINES)) };
  } catch { return { all: [], older: [] }; }
}

/** The thread so far (oldest first, live turns before `beforeAt`/`beforeId`), as sheet lines. */
function threadLines(s, castId, tz, { beforeAt = null, beforeId = null } = {}) {
  const name = String(s.cast.get(castId)?.name ?? s.story?.departed?.[castId]?.name ?? 'them').split(' ')[0];
  const rows = store.threadOf(castId, { live: true, limit: THREAD_LINES, ...(posInt(beforeAt) ? { before: beforeAt, beforeId: beforeId ?? 0 } : {}) })
    .filter(r => !isExcludedId(s, r.eventId)).reverse();
  return rows.map(r => ({ who: r.dir === 'out' ? 'him' : name, when: `${dayLabel(r.at, tz)} ${hhmm(r.at, tz)}`, text: r.editedText || r.text || '' }))
    .filter(l => l.text);
}

// What's new with them, each line with its day. Only news since they last saw each other in person: a
// beat from before that is over, and undated it read as still on (2026-11-02 live: "planning a dinner
// with her friends", from before that very evening, had him asking two days later if she was still on for it).
export function beatsOf(s, castId, at, tz, afterId = 0) {
  try {
    const seen = listEvents({ types: ['activity.started'], from: at - 45 * DAY, to: at, order: 'desc', limit: 400 })
      .find(e => !e.redacted && !isExcludedId(s, e.id) && Array.isArray(e.payload?.withCast) && e.payload.withCast.includes(castId));
    return listEvents({ types: ['cast.beat'], from: at - 10 * DAY, to: at, order: 'desc', limit: 100 })
      .filter(e => e.id > afterId && !e.redacted && !isExcludedId(s, e.id) && e.payload?.castId === castId && e.heavy !== true && !heavyChain(e) && (!seen || e.at > seen.at))
      .map(e => [e, typeof e.payload?.text === 'string' ? e.payload.text : e.payload?.kind]).filter(([, t]) => t)
      .map(([e, t]) => `${relWhen(e.at, at, tz)}: ${t}`).slice(0, 3);
  } catch { return []; }
}

function lastSceneWith(s, castId, tz) {
  const scenes = Object.values(isObj(s.story?.scenes) ? s.story.scenes : {})
    .filter(sc => sc.mode === 'full' && sc.heavyWindow !== true && Array.isArray(sc.castIds) && sc.castIds.includes(castId))
    .sort((a, b) => b.at - a.at);
  const sc = scenes[0];
  return sc ? { when: dayLabel(sc.endedAt ?? sc.at, tz), ending: sc.ending ?? null, highlight: null } : null;
}

// A failed read leaves the sheet as it was, with its history.
// The note is his side's alone: it's written from his view ("less trust"), and FACTS_CAST holds them to what they know.
export function memoryFor(s, castId, at, tz, side) {
  const out = {};
  try {
    const note = side === 'his' ? deps.standing?.(s, castId, at) ?? null : null;
    if (note) {
      out.standing = { text: note.text, asOf: dayLabel(note.asOfAt ?? note.validFrom, tz) };
      out.beatsAfter = beatsOf(s, castId, at, tz, note.asOfEventId);
    }
  } catch { /* the history stands in */ }
  try {
    const lines = deps.commitmentLines?.(s, castId, at, tz, side) ?? [];
    if (lines.length) out.commitments = lines;
  } catch { /* none */ }
  return out;
}

// When they last saw each other in person: his newest activity with them (any outing, a visit, a
// meal — scene or not), from the log (≤ 45 days back), in the words people use (relWhen: 00:15 Sat
// is "Fri night"). null when none. (2026-11-01 live: a Friday-night snack was called "last night".)
export function lastSeenWith(s, castId, at, tz) {
  try {
    const ev = listEvents({ types: ['activity.started'], from: at - 45 * DAY, to: at, order: 'desc', limit: 400 })
      .find(e => !e.redacted && !isExcludedId(s, e.id) && Array.isArray(e.payload?.withCast) && e.payload.withCast.includes(castId) && e.heavy !== true);
    if (!ev) return null;
    return `${relWhen(ev.at, at, tz)}: ${String(ev.payload?.kind ?? 'time together').replace(/[_:-]+/g, ' ')}`;
  } catch { return null; }
}

// His last two days (outings with people, getting home, sleep / wake) and his plans ahead,
// as true lines for both writers (facts.js timelineLines / planLines). A failed read → none.
const TIMELINE_TYPES = ['activity.started', 'activity.ended', 'travel.started', 'travel.arrived', 'sleep.started', 'woke'];
export function timelineOf(s, castId, at, tz) {
  try {
    const evs = listEvents({ types: TIMELINE_TYPES, from: at - 48 * HOUR, to: at, order: 'asc', limit: 800 })
      .filter(e => !e.redacted && !isExcludedId(s, e.id) && e.heavy !== true && !heavyChain(e));
    return timelineLines(evs, s, { at, tz, castId });
  } catch { return []; }
}
export const PLANS_AHEAD_HOURS = 7 * 24;   // the phone's writers and the plan clerk: a week ahead
export function plansOf(s, castId, at, tz, { aheadHours = 36, skipDecisionId = null } = {}) {
  try {
    return planLines(s, { at, tz, castId, aheadHours, skipDecisionId, endOf: (d) => {
      const late = d.options?.find?.(o => o.id === 'late')?.expiresAt;
      const opened = posInt(d.eventId) ? getEvent(d.eventId) : null;
      const end = opened?.payload?.subject?.endAt;
      return finite(end) ? end : (finite(late) ? late : null);
    } });
  } catch { return []; }
}

// The heavy window (016 R1): a turn within a heavy stretch's onset − 2 d … onset + 31 d.
export function inHeavyWindow(s, at) {
  try {
    return listEvents({ types: ['heavy.started'], from: at - HEAVY_WINDOW_AFTER, to: at + HEAVY_WINDOW_BEFORE, limit: 100 })
      .some(e => !e.redacted && !isExcludedId(s, e.id) && at >= e.at - HEAVY_WINDOW_BEFORE && at <= e.at + HEAVY_WINDOW_AFTER);
  } catch { return true; }
}

export function whyCtxOf(s, row, tz) {
  const ev = posInt(row.triggerEventId) ? getEvent(row.triggerEventId) : null;
  const p = isObj(ev?.payload) ? ev.payload : {};
  if (row.trigger === 'news') return { beat: typeof p.text === 'string' ? p.text : null };
  if (row.trigger === 'after_scene') return { scene: [p.outcome === 'well' ? 'it went well' : null, p.ending && p.ending !== 'nothing' ? String(p.ending).replace(/_/g, ' ') : null].filter(Boolean).join(', ') || null };
  if (row.trigger === 'backing_out') {
    const d = s.decisions instanceof Map ? s.decisions.get(posInt(p.decisionId)) : null;
    return { eventAt: finite(d?.subject?.eventAt) ? hhmm(d.subject.eventAt, tz) : null, place: d?.subject?.placeId ? placeWords(s, d.subject.placeId) : null };
  }
  if (row.trigger === 'on_my_way') {
    // This trip's plan (as the trigger scan picked it), not an older one kept a few days at the same place.
    const ahead = [...(s.decisions instanceof Map ? s.decisions.values() : [])].filter(x => x?.status === 'committed' && x.subject?.placeId === p.to
      && finite(x.subject?.eventAt) && finite(ev?.at) && x.subject.eventAt >= ev.at && x.subject.eventAt <= ev.at + 3 * HOUR);
    const d = ahead.find(x => x.subject?.castIds?.includes?.(row.castId)) ?? ahead[0];
    return { eventAt: finite(d?.subject?.eventAt) ? hhmm(d.subject.eventAt, tz) : null, place: placeWords(s, p.to) };
  }
  return {};
}

/** The owner's gist and tone for an owner turn (from its phone.text_set). */
function askOf(row) {
  if (row.trigger !== 'owner' || !posInt(row.triggerEventId)) return { gist: null, tone: null };
  const p = getEvent(row.triggerEventId)?.payload ?? {};
  return { gist: typeof p.gist === 'string' ? p.gist : null, tone: typeof p.tone === 'string' ? p.tone : null };
}

// ── writers ──────────────────────────────────────────────────────────────────

async function callWriter(tier, system, user, vctx, rowId) {
  const explicit = vctx.register === 'explicit';
  const role = explicit ? 'desire' : tier === 'mind' ? 'mind' : tier === 'clerk' ? 'clerk' : 'mouth';
  const caller = tier === 'mind' ? CALLER_MIND : tier === 'clerk' ? CALLER_CAST : CALLER_HIS;
  const opts = explicit
    ? { caller, maxTokens: 500, temperature: 0.9, timeoutMs: 60_000, noFallback: true }
    : tier === 'mind'
      ? { caller, maxTokens: 500, effort: 'low', timeoutMs: 60_000 }
      : { caller, maxTokens: 500, temperature: 0.9, timeoutMs: 45_000 };
  try { if (rowId) store.update(rowId, { caller }); } catch { /* the ledger still counts it */ }
  let res;
  try { res = await deps.callRole(role, system, user, opts); } catch { res = null; }
  if (!res || typeof res.text !== 'string' || !res.text.trim() || (res.status && res.status !== 'ok')) {
    return { ok: false, reason: res?.skipped ? `model_${String(res.skipped).slice(0, 16)}` : 'model_failed', caller };
  }
  const v = validateTexts(res.text, vctx);
  if (!v.ok) return { ok: false, reason: `invalid:${v.reason}`.slice(0, 48), caller };
  return { ok: true, value: v.value, model: typeof res.model === 'string' ? res.model : null, fellBack: res.fellBack === true, caller };
}

async function mindOk() {
  if (typeof deps.mindBudgetOk !== 'function') return false;
  try { return (await deps.mindBudgetOk('think'))?.ok === true; } catch { return false; }
}

function personaAge(persona) {
  const n = Number(persona?.age);
  if (Number.isFinite(n)) return n;
  try {
    const a = Number(getPersona()?.age);
    return Number.isFinite(a) ? a : null;
  } catch { return null; }
}

function turnRegister(s, row, { at, tz, thread, tone }) {
  const last = (() => { try { return store.lastLive(row.castId); } catch { return null; } })();
  const hour = localParts(at, tz).hour;
  const threadExplicit = (thread ?? []).some(l => contentProblem(l.text) === 'explicit');
  return registerOf(s, row.castId, {
    age: personaAge((() => { try { return deps.persona(); } catch { return null; } })()),
    urge: urgeNow(s, { now: at, tz }),
    private: phonePrivate({ hour, atHome: isHomeKind(s, s.activity?.placeId), threadExplicit }),
    heavy: heavyGuardActive(s, at) === true,
    sick: s.vitals?.sick === true || s.activity?.kind === 'sick',
    tone,
    cooled: last?.dir === 'in' && last?.tone === 'annoyed',
  });
}

/** The owner's verbatim words as a turn (lines = bubbles, ≤ BUBBLES_MAX). */
function ownerWordsTurn(words, tone) {
  const lines = String(words).split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, reason: 'empty' };
  const bubbles = lines.length > 3 ? [...lines.slice(0, 2), lines.slice(2).join(' ')] : lines;
  return { ok: true, tier: null, model: null, fellBack: false, caller: null,   // tier null: the owner's own words (no writer)
    value: { text: bubbles.join('\n'), bubbles, tone: typeof tone === 'string' && tone ? tone : 'casual', topic: null, end: false } };
}

// His vitals at the turn's moment, as the sheet states them: no chat or dream overlay, as ever on this sheet.
function stateNow(s, at) {
  try { return vitalsAt(s, at, deps.world ?? undefined, { chatMood: false }); } catch { return s.vitals; }
}

/** Write one turn's texts (no commit). → { ok, value, tier, model, fellBack, caller } | { ok:false, reason } */
async function write(s, row, { at, tz, world, beforeAt = null, beforeId = null }) {
  const side = row.dir === 'out' ? 'his' : 'cast';
  const persona = (() => { try { return deps.persona() ?? {}; } catch { return {}; } })();
  const ask = askOf(row);
  const ownerEv = ownerAskEvent(row);
  // A question the owner had him ask is asked: repeated on every reply of a long chat, it kept steering the chat back to it (2026-11-03).
  const setup = row.trigger === 'reply' && typeof ownerEv?.payload?.gist === 'string' && !gistIsAsk(ownerEv.payload.gist) ? ownerEv.payload.gist : null;
  const today = saidToday(s, row, at, { beforeAt, beforeId });
  const thread = threadLines(s, row.castId, tz, { beforeAt, beforeId });
  const register = turnRegister(s, row, { at, tz, thread, tone: ask.tone });
  const urge = urgeNow(s, { now: at, tz });
  // 020 D2 + D3: how things stand, and what he said he'd do. An explicit sheet stays as it was.
  const memory = register === 'explicit' ? {} : memoryFor(s, row.castId, at, tz, side);
  const { sheet, names } = buildSheet(s, row, {
    ...memory,
    tz, at, side, trigger: row.trigger, gist: ask.gist, tone: ask.tone, setup, askedEarlier: ask.gist ? [] : questionsIn(today.older), chat: ownerEv?.payload?.chat ?? null,
    persona: { displayName: persona.displayName ?? persona.name ?? null, aliases: persona.aliases ?? [], region: persona.region ?? null, language: persona.language ?? null },
    age: ageOn(s.self?.birthdate, at, tz),
    jobTitle: jobWordsOf(s, world),
    vitals: stateNow(s, at),
    thread, beats: beatsOf(s, row.castId, at, tz),
    firstTurnToday: (() => { const last = store.threadOf(row.castId, { live: true, limit: 1 })[0]?.at; return !finite(last) || dateKey(last, tz) !== dateKey(at, tz); })(),
    lastScene: lastSceneWith(s, row.castId, tz),
    lastSeen: lastSeenWith(s, row.castId, at, tz),
    timeline: timelineOf(s, row.castId, at, tz),
    plans: plansOf(s, row.castId, at, tz, { aheadHours: PLANS_AHEAD_HOURS }),
    whyCtx: whyCtxOf(s, row, tz),
    urgeBand: urgeBand(urge), register,
  });
  let knownNames = null;
  try { knownNames = deps.knownNames(); if (!Array.isArray(knownNames)) knownNames = null; } catch { knownNames = null; }
  if (!knownNames) return { ok: false, reason: 'names_unavailable' };
  const castNames = [...s.cast.values()].map(c => c?.name).filter(n => typeof n === 'string');
  const placeNames = [...(s.places instanceof Map ? s.places.values() : [])].filter(p => !p?.venue).map(p => p?.name).filter(n => typeof n === 'string');
  const vctx = { names: [...names, ...castNames, ...placeNames], knownNames, castNames, venueNames: venueNamesNow(), register };
  const user = renderUser(sheet);
  let tiers;
  let system;
  if (side === 'his') {
    let core = '';
    try { core = String(await deps.identity() ?? ''); } catch { core = ''; }
    if (!core.trim()) return { ok: false, reason: 'no_identity' };
    system = `${core.trimEnd()}\n\n${charterFor(HIS_CHARTER, register)}${bodyAsk(ask.gist) && register !== 'explicit' ? `\n${BODY_ASK_LINE}` : ''}`;
    // A clothes or body question the owner asked skips the mind model: it talks around it
    // ("choosing to be a gentleman") instead of asking. Explicit turns still use desire.
    const direct = bodyAsk(ask.gist);
    tiers = register === 'explicit' ? [row.trigger === 'owner' ? 'mind' : 'mouth']
      : direct ? ['mouth']
      : row.trigger === 'owner' && await mindOk() ? ['mind', 'mouth'] : ['mouth'];
  } else {
    system = charterFor(CAST_CHARTER, register);
    tiers = ['clerk'];
  }
  const prior = (thread ?? []).map(l => l.text);
  let reason = null;
  let dodged = null;
  // A retry after the writer kept repeating: steer it somewhere new from the first attempt.
  // An owner question is the exception: the retry asks that question, it does not change the subject.
  const freshNote = row.skipReason === 'echo' && !ask.gist
    ? 'The last try kept repeating what is already in the thread. Move the conversation somewhere new: a different topic, a question about their day, a plan, a memory, a joke — nothing already said.'
    : '';
  for (const tier of tiers) {
    let note = freshNote;
    let echoed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await callWriter(tier, system, note ? `${user}\n\n${note}` : user, vctx, row.id);
      if (!r.ok) { if (!dodged) reason = r.reason; break; }
      // Held to the owner's gist only when it is a question / an ask (a description is a note, not a script).
      const missed = ask.gist && gistIsAsk(ask.gist) ? gistMiss(ask.gist, r.value.text) : null;
      if (missed) {
        dodged = r;
        reason = 'gist';
        if (echoed) break;
        echoed = true;
        note = `You did not ask what the owner told you to ask. Ask it outright, in your voice, and include: ${String(missed).slice(0, 80)}. Do not hint. Do not say you are choosing not to ask.`;
        continue;
      }
      const phrase = repeatedPhrase(r.value.text, prior);
      // Said already today, past the thread: one rewrite. A second try goes out whatever it says, so this never costs a turn.
      const stale = !phrase && !ask.gist && !echoed ? repeatedToday(r.value.text, today.all) : null;
      if (stale) {
        echoed = true;
        note = `You already said "${String(stale).slice(0, 40)}" earlier today, and the answer hasn't changed. Don't say or ask it again. Move on: react to what they just said, or go somewhere new.`;
        continue;
      }
      if (!phrase || gistAllows(phrase, ask.gist)) {
        // 020 E3, enforce only: a contradiction gets this tier's one rewrite, naming it. Never the explicit register.
        const verdict = register !== 'explicit' && deps.claimCheck?.mode() === 'enforce'
          ? await deps.claimCheck.enforce(r.value.text, deps.claimCheck.phone(sheet, { at, tz }), { speaker: side, register, tone: r.value.tone }) : null;
        if (!verdict?.contradicted?.length) return { ...r, tier, facts: { sheet, register }, check: verdict?.result ?? null, rewrote: echoed && reason === 'contradicted' };
        reason = 'contradicted';
        if (echoed) break;
        echoed = true;
        note = verdict.correction;
        continue;
      }
      reason = 'echo';
      if (echoed) break;
      echoed = true;
      note = `The texts you just wrote repeat "${String(phrase).slice(0, 40)}", which is already in the thread. Write them again. Leave that phrase out. A plan already agreed is settled. Say something that has not been said.`;
    }
    if (register === 'explicit') break;
  }
  if (reason === 'gist' && ask.gist) {
    const line = gistFallback(ask.gist);
    const v = line ? validateTexts(JSON.stringify({ messages: [line], tone: ask.tone || 'flirty', end: false }), vctx) : null;
    if (v?.ok) return { ok: true, value: v.value, tier: 'mouth', model: null, fellBack: false, caller: null };
    if (dodged) return { ...dodged, tier: dodged.tier ?? 'mouth', facts: { sheet, register } };
  }
  return { ok: false, reason: reason ?? 'model_failed' };
}

// ── effects (pure over the state) ────────────────────────────────────────────

// Today's phone deltas per member (abs sums) from the live log.
function todayPhoneDeltas(s, at, tz) {
  const out = {};
  try {
    for (const e of listEvents({ types: ['relationship.changed'], from: dayStart(at, tz), to: at + 1, limit: 500 })) {
      if (e.redacted || e.payload?.reason !== 'phone' || isExcludedId(s, e.id)) continue;
      const m = (out[e.payload.castId] ??= {});
      for (const [k, v] of Object.entries(e.payload.delta ?? {})) if (finite(v)) m[k] = (m[k] ?? 0) + Math.abs(v);
    }
  } catch { return null; }
  return out;
}

/**
 * The effects of a reply that completed an exchange: a small step closer (passion for a
 * flirty one with a romance-eligible member, tension for an annoyed one), ≤ PHONE_DAY_MAX
 * per metric per member per day; and a romance that has been texting a lot moves from
 * interested to talking. Only while the controls allow. → [{ type, payload }]
 */
export function planEffects(s, row, value, { today = {}, recent = [] } = {}) {
  if (row.trigger !== 'reply' || isPaused(s) || fateOf('social', s) === 'frozen') return [];
  const keys = pinKeysFor({ type: 'relationship.changed', payload: { castId: row.castId } }, s);
  if (!controlsCheck({ source: 'engine', category: 'social', action: 'change', pinKeys: keys }, s).ok) return [];
  const want = { closeness: value.tone === 'annoyed' ? 0 : PHONE_STEP };
  if (value.tone === 'annoyed') want.tension = PHONE_STEP;
  if ((value.tone === 'flirty' || value.tone === 'teasing' || value.tone === 'naughty') && romanceEligible(s, row.castId)) want.passion = PHONE_STEP;
  const delta = {};
  for (const [k, v] of Object.entries(want)) {
    if (!v) continue;
    const room = PHONE_DAY_MAX - (today?.[row.castId]?.[k] ?? 0);
    const m = metricsOf(s, row.castId);
    const d = Math.min(v, Math.max(0, room), 1 - (finite(m[k]) ? m[k] : 0));
    if (d > 0.0005) delta[k] = Math.round(d * 1000) / 1000;
  }
  const list = Object.keys(delta).length ? [{ type: 'relationship.changed', payload: { castId: row.castId, delta, reason: 'phone' } }] : [];
  const rom = activeRomance(s);
  if (rom && rom.partnerId === row.castId && rom.arc.stage === 'interested') {
    const warmTones = ['flirty', 'teasing', 'naughty', 'warm'];
    const warm = recent.filter(r => warmTones.includes(r.tone)).length + (warmTones.includes(value.tone) ? 1 : 0);
    if (recent.length + 1 >= ROMANCE_TEXTS && warm >= 3) {
      const ev = { type: 'arc.stage', payload: { arcId: rom.arc.id, to: 'talking', reason: 'phone' } };
      if (controlsCheck({ source: 'engine', category: 'romance', action: 'change', pinKeys: pinKeysFor(ev, s) }, s).ok) list.push(ev);
    }
  }
  return list;
}

/** The cast he is with in person right now (his current activity's company), never a departed one. */
export function presentWith(s) {
  const ids = Array.isArray(s?.activity?.withCast) ? s.activity.withCast : [];
  return ids.filter(id => typeof id === 'string' && s?.cast?.get?.(id));
}

// Today's attention deltas per member (abs sums) from the live log.
function todayAttentionDeltas(s, at, tz) {
  const out = {};
  try {
    for (const e of listEvents({ types: ['relationship.changed'], from: dayStart(at, tz), to: at + 1, limit: 500 })) {
      if (e.redacted || e.payload?.reason !== 'attention' || isExcludedId(s, e.id)) continue;
      const m = (out[e.payload.castId] ??= {});
      for (const [k, v] of Object.entries(e.payload.delta ?? {})) if (finite(v)) m[k] = (m[k] ?? 0) + Math.abs(v);
    }
  } catch { return null; }
  return out;
}

/**
 * A text he sent while with someone in person (pure over the state): for each person there (not the
 * one he is texting) tension up a step; with his romance partner passion down a step, and a warm text
 * (flirty / teasing / naughty) to someone else is a jealous step more. ≤ ATTENTION_DAY_MAX per metric
 * per member per day; only while the social controls allow. → [{ type, payload }]
 */
export function attentionEffects(s, row, value, { today = {} } = {}) {
  if (row.dir !== 'out' || isPaused(s) || fateOf('social', s) === 'frozen') return [];
  const rom = activeRomance(s);
  const out = [];
  for (const id of presentWith(s)) {
    if (id === row.castId) continue;
    const keys = pinKeysFor({ type: 'relationship.changed', payload: { castId: id } }, s);
    if (!controlsCheck({ source: 'engine', category: 'social', action: 'change', pinKeys: keys }, s).ok) continue;
    const partner = rom?.partnerId === id;
    const want = { tension: ATTENTION_STEP + (partner && WARM_TONES.has(value?.tone) ? ATTENTION_JEALOUS : 0) };
    if (partner) want.passion = -ATTENTION_STEP;
    const m = metricsOf(s, id);
    const delta = {};
    for (const [k, v] of Object.entries(want)) {
      const room = Math.max(0, ATTENTION_DAY_MAX - (today?.[id]?.[k] ?? 0));
      const cur = finite(m[k]) ? m[k] : 0;
      const d = v > 0 ? Math.min(v, room, 1 - cur) : -Math.min(-v, room, cur);
      if (Math.abs(d) > 0.0005) delta[k] = Math.round(d * 1000) / 1000;
    }
    if (Object.keys(delta).length) out.push({ type: 'relationship.changed', payload: { castId: id, delta, reason: 'attention' } });
  }
  return out;
}

// ── the job ──────────────────────────────────────────────────────────────────

function underLocks(fn) {
  const inner = () => withDecisionLock(fn);
  return typeof deps.pulse?.exclusive === 'function' ? deps.pulse.exclusive(inner) : inner();
}

// Queue the other side's answer to a committed turn (or not: the exchange runs out).
function queueReply(row, eventId, value, at, tz) {
  const owner = ownerAskEvent(row);
  const long = owner?.payload?.chat === 'long';
  const pace = BOND_PACE[bondOf(deps.getState(), row.castId)] ?? null;
  if (value.end || row.exchange + 1 >= (long ? LONG_EXCHANGE_MAX : Math.max(EXCHANGE_MAX, pace?.max ?? 0))) return null;
  const r = rnd(eventId, 'reply', tz, at);
  // The owner's own first turn is always answered (they asked for this chat; 2026-11-01 live: a 0.996
  // draw left "Hey. Are you awake?" unanswered).
  const base = row.trigger === 'owner' && row.exchange === 0 ? 1 : (REPLY_P[row.exchange] ?? 0.1);
  const p = long ? Math.max(LONG_REPLY_P, base) : Math.max(base, pace?.replyP ?? 0);
  if (r() >= p) return null;
  const dir = row.dir === 'out' ? 'in' : 'out';
  // An owner-started chat: within minutes. Else minutes by day; now and then an hour or more.
  // Seconds: an owner-started chat answers fast; otherwise by how they feel about each other; else the old pace.
  const delaySec = owner ? r.int(OWNER_REPLY_SEC[0], OWNER_REPLY_SEC[1])
    : pace ? (r() < pace.slowP ? r.int(pace.slow[0], pace.slow[1]) : r.int(pace.delay[0], pace.delay[1]))
      : (r() < 0.12 ? r.int(60, 240) : r.int(2, 40)) * 60;
  return store.insertPending({ castId: row.castId, dir, trigger: 'reply', triggerEventId: eventId, exchange: row.exchange + 1, dueAt: at + delaySec, createdAt: at });
}

function commit(row, value, w, { replacing = null } = {}) {
  return underLocks(() => store.inTransaction(() => {
    const s = deps.getState();
    if (!activeMember(s, row.castId)) throw Object.assign(new Error('gone'), { code: 'departed' });
    if (posInt(row.triggerEventId) && gone(s, row.triggerEventId)) throw Object.assign(new Error('gone'), { code: 'trigger_gone' });
    const tz = tzOf(s);
    const at = Math.max(nowSec(), Number.isSafeInteger(s.at) ? s.at : 0);
    // The together rule again, on the state this turn lands in (2026-11-02, property tests): runTurn's
    // check can read a projection the pulse hasn't caught up on yet (an outing starting at that very
    // tick), and the words take time to write. Together now → the turn waits, as waitFor would have.
    if (!replacing) {
      const again = waitFor(s, row, at, tz, deps.worldOf(s) ?? deps.world, ownerAskEvent(row));
      if (Number.isSafeInteger(again) && (presentWith(s).includes(row.castId) || (row.dir === 'out' && presentWith(s).length))) {
        throw Object.assign(new Error('together'), { code: 'together', dueAt: again });
      }
    }
    const causeId = replacing ? (posInt(getEvent(replacing.eventId)?.causeId) ?? null) : posInt(row.triggerEventId);
    if (replacing) logRevert(replacing.eventId, { reason: 'phone_regenerated', by: 'owner', at });
    const heavyWindow = inHeavyWindow(s, at);
    const thread = threadLines(s, row.castId, tz);
    const register = turnRegister(s, row, { at, tz, thread, tone: askOf(row).tone });
    const heat = heatOf({ text: value.text, register, tone: value.tone });
    const ev = deps.append({
      type: 'phone.message', at, actor: 'engine', ...(causeId ? { causeId } : {}),
      payload: {
        castId: row.castId, castIds: [row.castId], dir: row.dir, msgId: row.id, trigger: row.trigger, exchange: row.exchange,
        tone: value.tone, length: value.text.length, bubbles: value.bubbles.length, textSha: sha(value.text),
        heat, register,   // a code word beside heat: heat alone can't tell a flirty tame text from an explicit one the word list missed (020 D2)
        ...(replacing ? { replaces: replacing.eventId } : {}), ...(heavyWindow ? { heavyWindow: true } : {}),
      },
    });
    const recent = store.threadOf(row.castId, { live: true, limit: 30 }).filter(r => r.at >= at - 7 * DAY && !isExcludedId(s, r.eventId));
    for (const e of planEffects(s, row, value, { today: todayPhoneDeltas(s, at, tz) ?? { [row.castId]: { closeness: PHONE_DAY_MAX, passion: PHONE_DAY_MAX, tension: PHONE_DAY_MAX } }, recent })) {
      deps.append({ type: e.type, at, actor: 'engine', causeId: ev.id, payload: e.payload });
    }
    const caps = todayAttentionDeltas(s, at, tz);
    const full = Object.fromEntries(presentWith(s).map(id => [id, { tension: ATTENTION_DAY_MAX, passion: ATTENTION_DAY_MAX }]));
    for (const e of attentionEffects(s, row, value, { today: caps ?? full })) {
      deps.append({ type: e.type, at, actor: 'engine', causeId: ev.id, payload: e.payload });
    }
    store.update(row.id, {
      status: 'live', skipReason: null, eventId: ev.id, at, text: value.text, tone: value.tone, topic: value.topic, tier: w.tier,
      model: w.model, fellBack: w.fellBack, caller: w.caller, heavyWindow, finishedAt: nowSec(),
    });
    // A rewritten turn keeps no words (its event is reverted; the new turn is the thread's).
    if (replacing) store.update(replacing.id, { status: 'superseded', text: null, editedText: null, topic: null });
    queueReply(row, ev.id, value, at, tz);
    return { status: 'live', id: row.id, eventId: ev.id };
  }));
}

/** Play one due turn. → { status: 'live'|'waiting'|'skipped', reason?, id, eventId? } */
export async function runTurn(row) {
  const started = Date.now();
  if (!store.update(row.id, { status: 'running' }, { fromStatus: 'pending' })) return { status: 'skipped', reason: 'busy', id: row.id };
  const s = deps.getState();
  const at = nowSec();
  const skip = (reason) => {
    store.update(row.id, { status: 'skipped', skipReason: reason, finishedAt: nowSec() });
    log({ status: 'skipped', skip: reason, id: row.id, ms: Date.now() - started, trigger: row.trigger, dir: row.dir });
    return { status: 'skipped', reason, id: row.id };
  };
  if (!isObj(s)) return skip('not_running');
  if (!enabled()) return skip('off');
  if (!activeMember(s, row.castId)) return skip('departed');
  if (posInt(row.triggerEventId) && gone(s, row.triggerEventId)) return skip('trigger_gone');
  // "Can't make it" only while that is still true and still ahead (his side may have waited hours).
  if (row.trigger === 'backing_out') {
    const d = s.decisions instanceof Map ? s.decisions.get(posInt(getEvent(row.triggerEventId)?.payload?.decisionId)) : null;
    if (!d || d.status === 'open' || goingTo(d)) return skip('changed');
    if (!finite(d.subject?.eventAt) || at >= d.subject.eventAt) return skip('too_late');
  }
  // One conversation per thread (2026-11-02 live: four owner texts to the same member ran four
  // exchanges side by side — double texts, and he answered his own question as her): a reply only
  // answers the thread's newest turn; if someone has spoken in it since, this reply is dropped (the
  // newer turn has its own answer queued).
  if (row.trigger === 'reply' && posInt(row.triggerEventId)) {
    const last = store.lastLive(row.castId);
    if (last && posInt(last.eventId) && last.eventId !== row.triggerEventId && !isExcludedId(s, last.eventId)) return skip('superseded');
  }
  const organic = !ORGANIC_SKIP.has(row.trigger) || (row.trigger === 'reply' && !ownerThread(row));
  if (organic && isPaused(s)) return skip('paused');
  if (organic && heavyGuardActive(s, at)) return skip('heavy');
  const tz = tzOf(s);
  const world = deps.worldOf(s) ?? deps.world;
  const owner = ownerAskEvent(row);
  const wait = waitFor(s, row, at, tz, world, owner);
  if (wait === 'stale') return skip('stale');
  if (wait === 'dozed') return skip('dozed_off');
  if (wait) {
    store.update(row.id, { status: 'pending', dueAt: wait, tries: Math.min(99, (row.tries ?? 0) + 1) }, { fromStatus: 'running' });
    return { status: 'waiting', id: row.id };
  }
  const cap = await capReason(row, at, tz, { long: owner?.payload?.chat === 'long' });
  if (cap) return skip(cap);
  // The owner's own words for the first text: verbatim (validated at the Director's plan), no model call.
  const words = row.trigger === 'owner' && typeof owner?.payload?.words === 'string' && owner.payload.words.trim() ? owner.payload.words : null;
  const w = words ? ownerWordsTurn(words, owner.payload.tone) : await write(s, row, { at, tz, world });
  // Owner 2026-11-02 ("fix it now"): a turn the writer kept repeating doesn't end the chat — it comes
  // back in 1–2.5 min with a nudge to move the conversation somewhere new, up to ECHO_RETRIES times,
  // then is dropped as before (the no-repeat rule itself is unchanged).
  if (!w.ok && w.reason === 'echo' && (row.tries ?? 0) < ECHO_RETRIES) {
    const r2 = rnd(row.id, `echo:${row.tries ?? 0}`, tz, at);
    store.update(row.id, { status: 'pending', dueAt: at + r2.int(60, 150), tries: Math.min(99, (row.tries ?? 0) + 1), skipReason: 'echo' }, { fromStatus: 'running' });
    log({ status: 'waiting', skip: 'echo_retry', id: row.id, ms: Date.now() - started, trigger: row.trigger, dir: row.dir });
    return { status: 'waiting', id: row.id };
  }
  if (!w.ok) return skip(w.reason);
  let res;
  try {
    res = await commit(row, w.value, w);
    log({ status: 'live', tier: w.tier, id: row.id, ms: Date.now() - started, trigger: row.trigger, dir: row.dir });
  } catch (err) {
    if (err?.code === 'together' && Number.isSafeInteger(err.dueAt)) {
      store.update(row.id, { status: 'pending', dueAt: err.dueAt, tries: Math.min(99, (row.tries ?? 0) + 1) }, { fromStatus: 'running' });
      return { status: 'waiting', id: row.id };
    }
    try { deps.rebuild(); } catch { /* the next tick re-reads */ }
    return skip(typeof err?.code === 'string' && err.code.length < 24 ? err.code : 'append');
  }
  // Plans from texts: never changes what this turn did.
  try { await planFromTexts(row, res); } catch { logPlan('nothing', 'error', { id: res?.eventId ?? null }); }
  submitCheck(row, res, w);
  return res;
}

/**
 * 020 E3: what a model wrote goes to the claim check, against the sheet it was written from, with his plans as they stand now
 * (a plan this very text agreed isn't a plan out of nowhere). Not the owner's own words or a code line, never the explicit register.
 */
function submitCheck(row, res, w) {
  if (!deps.claimCheck || !w?.facts || !w.caller || w.facts.register === 'explicit') return;
  try {
    const s = deps.getState();
    const tz = tzOf(s);
    const at = nowSec();
    deps.claimCheck.submit({
      writer: 'phone', rowId: res?.id ?? row.id, eventId: res?.eventId ?? null, speaker: row.dir === 'out' ? 'his' : 'cast',
      register: w.facts.register, tone: w.value?.tone ?? null, result: w.check ?? null, rewrote: w.rewrote === true,
      grounding: w.check ? null : deps.claimCheck.phone(w.facts.sheet, { at, tz, plans: plansOf(s, row.castId, at, tz, { aheadHours: PLANS_AHEAD_HOURS }) }),
    });
  } catch { /* a check never touches the turn */ }
}

// ── plans from texts ─────────────────────────────────────────────────────────

function logPlan(outcome, code, { id = null, kind = null, decisionId = null } = {}) {
  try { logger.info({ evt: 'arcs_phone_plan', outcome, code, kind, id, decisionId }, 'story: phone plan'); } catch { /* best effort */ }
  try { store.notePlanOutcome({ eventId: id, outcome, code }); } catch { /* the log has it; the sweep then says it can't tell */ }
}

// The plan clerk's caps (fail closed): the phone's day call cap and month $ cap (its caller is
// under the `life.phone.` prefix), and PLAN_MAX_PER_DAY calls of its own.
async function planCapReason(at, tz) {
  const b = await budgetStatus(at, tz);
  if (!b) return 'ledger';
  if (!(b.today < Number(config.arcs?.phoneMaxPerDay ?? 100000))) return 'cap';
  if (!(b.monthUsd < Number(config.arcs?.phoneBudgetUsd ?? 3))) return 'budget';
  try {
    const n = (await usageRows(dayStart(at, tz))).filter(r => r.caller === CALLER_PLAN).reduce((a, r) => a + (Number(r.calls) || 0), 0);
    if (!(n < PLAN_MAX_PER_DAY)) return 'plan_cap';
  } catch { return 'ledger'; }
  return null;
}

/**
 * After a turn went live: when it and the turn before read like the two of them agreeing to
 * meet (code prefilter), ONE clerk call says what was agreed; code resolves it against his world
 * (who, where, when, the controls, clashes) and appends a committed, locked plan caused by this
 * text (decision.opened → lean → committed by 'text'). Every outcome is logged as codes.
 * → { outcome, code, decisionId? }
 */
export async function planFromTexts(row, res) {
  const s0 = deps.getState();
  const eventId = posInt(res?.eventId);
  if (!isObj(s0) || !eventId) return { outcome: 'nothing', code: 'not_running' };
  const thread = store.threadOf(row.castId, { live: true, limit: PLAN_TURNS }).filter(r => !isExcludedId(s0, r.eventId));
  const [latest, previous] = thread;
  if (!latest || latest.eventId !== eventId) return { outcome: 'nothing', code: 'not_newest' };
  const textOf = (r) => (r ? r.editedText || r.text || '' : '');
  // Small talk never reaches the clerk (and isn't logged: most turns end here).
  if (!cueCheck(textOf(latest), textOf(previous))) return { outcome: 'nothing', code: 'no_cue' };
  const done = (outcome, code, extra = {}) => { logPlan(outcome, code, { id: eventId, ...extra }); return { outcome, code, ...extra }; };
  const ev = getEvent(eventId);
  if (!selfOrigin(ev) || ev.heavy === true || heavyChain(ev)) return done('nothing', 'origin');
  const tz = tzOf(s0);
  const at = nowSec();
  // A plan with them already made in texts lately (the "see you then" after the "deal"): no call.
  const since = at - PLAN_RECENT_HOURS * HOUR;
  for (const d of s0.decisions instanceof Map ? s0.decisions.values() : []) {
    if (goingTo(d) && d.committed?.by === 'text' && (d.subject?.castIds ?? []).includes(row.castId)
      && finite(d.committed.at) && d.committed.at >= since) return done('nothing', 'already_planned');
  }
  const cap = await planCapReason(at, tz);
  if (cap) return done('nothing', cap);
  const name = String(s0.cast.get(row.castId)?.name ?? 'them').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)[0];
  const user = renderPlanUser({
    at, tz, member: name, plans: plansOf(s0, row.castId, at, tz, { aheadHours: PLANS_AHEAD_HOURS }),
    thread: threadLines(s0, row.castId, tz).slice(-PLAN_TURNS),
  });
  let out;
  try { out = await deps.callRole('clerk', PLAN_PROMPT, user, { caller: CALLER_PLAN, maxTokens: 200, temperature: 0, timeoutMs: 30_000 }); } catch { out = null; }
  if (!out || out.skipped) return done('nothing', out?.skipped ? 'budget' : 'model_failed');
  if (typeof out.text !== 'string' || (out.status && out.status !== 'ok')) return done('nothing', 'model_failed');
  const v = validatePlanOutput(out.text);
  if (!v.ok) return done('nothing', 'invalid');
  const ownerChat = ownerAskEvent(row) !== null;
  // Resolve and append on the fresh state, under the locks (the clerk call awaited).
  let r;
  try {
    r = underLocks(() => store.inTransaction(() => {
      const s = deps.getState();
      if (!isObj(s) || gone(s, eventId)) return { ok: false, outcome: 'nothing', code: 'text_gone' };
      if (store.lastLive(row.castId)?.eventId !== eventId) return { ok: false, outcome: 'nothing', code: 'superseded' };
      const t = Math.max(nowSec(), Number.isSafeInteger(s.at) ? s.at : 0);
      const world = deps.worldOf(s) ?? deps.world;
      const plan = resolveTextPlan(s, row.castId, v.value, { at: t, tz, world, ownerChat, rnd: rnd(eventId, 'plan', tz, t) });
      if (!plan.ok) return plan;
      const ids = appendPlan((e) => deps.append(e), { at: t, causeId: eventId, payload: plan.payload });
      return { ok: true, kind: plan.kind, ...ids };
    }));
    r = await r;
  } catch {
    try { deps.rebuild(); } catch { /* the next tick re-reads */ }
    return done('nothing', 'append');
  }
  if (!r.ok) return done(r.outcome, r.code, { kind: v.value.kind });
  try { deps.settle(); } catch { /* the next tick fits it */ }
  return done('applied', v.value.kind, { kind: v.value.kind, decisionId: r.openedId });
}

// The owner's phone.text_set that started this turn's exchange (the turn itself, or a reply
// chain back to it), else null. (An owner's exchange runs while the story is paused.)
function ownerAskEvent(row) {
  if (row.trigger === 'owner' || row.trigger === 'reply') {
    let ev = posInt(row.triggerEventId) ? getEvent(row.triggerEventId) : null;
    for (let i = 0; ev && i < LONG_EXCHANGE_MAX + 2; i++) {
      if (ev.type === 'phone.text_set') return ev;
      if (ev.type !== 'phone.message') break;
      ev = posInt(ev.causeId) ? getEvent(ev.causeId) : null;
    }
  }
  return ownerSessionAsk(row);
}

// The thread's live owner chat: its newest owner turn (trigger 'owner') went out within the last
// OWNER_SESSION_MIN → that turn's phone.text_set. Any text of the thread then
// belongs to the chat (an organic text queued before it, an answer to one), so the chat's pace,
// night rule and length hold for the whole thread (2026-11-01 live: an after-scene text queued
// before the owner's "Hey. Are you awake?" went out mid-chat and started its own slow exchange).
function ownerSessionAsk(row) {
  let rows = [];
  try { rows = store.threadOf(row.castId, { live: true, limit: 20 }); } catch { return null; }
  const t = nowSec();
  // The owner's turn within OWNER_SESSION_MIN, or — while the chat stays alive (its newest turn under
  // OWNER_LIVE_MIN old) — within OWNER_SESSION_MAX_HOURS: a long chat that keeps going stays the
  // owner's (2026-11-01: a chat kept up past bedtime outlived the 90 min and fell back to her night).
  const newest = rows.find(r => Number.isSafeInteger(r.at));
  const alive = newest && newest.at >= t - OWNER_LIVE_MIN * MIN;
  const own = rows.find(r => r.trigger === 'owner' && Number.isSafeInteger(r.at) && r.at <= t
    && (r.at >= t - OWNER_SESSION_MIN * MIN || (alive && r.at >= t - OWNER_SESSION_MAX_HOURS * HOUR)));
  if (!own || !posInt(own.triggerEventId)) return null;
  const ev = getEvent(own.triggerEventId);
  return ev?.type === 'phone.text_set' && ev.payload?.castId === row.castId ? ev : null;
}
const ownerThread = (row) => ownerAskEvent(row) !== null;

// An engaging chat going on right now (owner 2026-11-01: "if his chats are engaging, he should keep
// texting regardless of time"): a thread with ≥ 2 live turns in the last 20 min whose newest turn is
// < 15 min old, or with an answer due in the next 15 min. → { castId, eventId } (the newest turn) | null
export function activeChat(at) {
  const live = store.listLive({ since: at - 20 * MIN, limit: 100 });
  const due = new Set(store.listDue(at + 15 * MIN, 50).map(r => r.castId));
  const by = new Map();
  for (const r of live) {
    const x = by.get(r.castId) ?? { n: 0, last: null };
    x.n += 1;
    if (!x.last || r.at > x.last.at) x.last = r;
    by.set(r.castId, x);
  }
  let best = null;
  for (const [castId, x] of by) {
    if (x.n < 2 || !x.last) continue;
    if (!(x.last.at >= at - 15 * MIN || due.has(castId))) continue;
    if (!best || x.last.at > best.at) best = { castId, eventId: x.last.eventId, at: x.last.at };
  }
  return best ? { castId: best.castId, eventId: best.eventId } : null;
}

/** ≤ PER_TICK due turns, oldest due first. → results */
export async function processDue() {
  const out = [];
  for (const row of store.listDue(nowSec(), PER_TICK)) out.push(await runTurn(row));
  return out;
}

/** Drop pending turns whose trigger left the log; mark live turns whose event left it. */
export function sweep() {
  const s = deps.getState();
  if (!isObj(s)) return { reverted: 0, dropped: 0 };
  return { reverted: store.sweep((id) => gone(s, id)), dropped: store.dropPendingFor((id) => gone(s, id)) };
}

// ── owner ────────────────────────────────────────────────────────────────────

/** Is this the newest live turn of its thread (the one a REWRITE may replace)? */
export function isNewest(row) {
  const last = store.lastLive(row.castId);
  return !!last && last.id === row.id;
}

/**
 * The owner's REWRITE of the newest turn of a thread: written again from the thread
 * before it; on success the new turn replaces it (the old one reverted, its pending
 * answer dropped by the sweep, a new answer queued). → { status: 'live', id, eventId } | { status: 'failed', reason }
 */
export async function regenerate(id) {
  const old = store.getMessage(id);
  if (!old) return { status: 'failed', reason: 'not_found' };
  if (old.status !== 'live' || !posInt(old.eventId)) return { status: 'failed', reason: 'reverted' };
  const s = deps.getState();
  if (!isObj(s)) return { status: 'failed', reason: 'not_running' };
  if (isExcludedId(s, old.eventId)) return { status: 'failed', reason: 'reverted' };
  if (!activeMember(s, old.castId)) return { status: 'failed', reason: 'departed' };
  if (!isNewest(old)) return { status: 'failed', reason: 'not_newest' };
  const at = nowSec();
  const tz = tzOf(s);
  const cap = await capReason({ ...old, trigger: 'regenerate' }, at, tz);
  if (cap) return { status: 'failed', reason: cap };
  const rowId = store.insertPending({ castId: old.castId, dir: old.dir, trigger: 'regenerate', triggerEventId: null,
    exchange: old.exchange, dueAt: at, replacesId: old.id, createdAt: at });
  if (!rowId) return { status: 'failed', reason: 'busy' };
  store.update(rowId, { status: 'running' }, { fromStatus: 'pending' });
  const row = store.getMessage(rowId);
  // The rewrite answers what the old one answered: same trigger for the sheet's "why".
  const w = await write(s, { ...row, trigger: old.trigger === 'reply' ? 'reply' : 'regenerate', triggerEventId: old.triggerEventId },
    { at, tz, world: deps.worldOf(s) ?? deps.world, beforeAt: old.at, beforeId: old.id });
  if (!w.ok) {
    store.update(rowId, { status: 'skipped', skipReason: w.reason, finishedAt: nowSec() });
    return { status: 'failed', reason: w.reason };
  }
  try {
    const res = await commit({ ...row, trigger: 'regenerate', triggerEventId: null }, w.value, w, { replacing: old });
    try { deps.rebuild(); } catch { /* the next tick re-reads */ }
    sweep();
    log({ status: 'live', tier: w.tier, id: rowId, trigger: 'regenerate', dir: row.dir });
    // The old turn's plan (if it agreed to one) left with it; the rewrite may agree again.
    try { await planFromTexts(row, res); } catch { logPlan('nothing', 'error', { id: res?.eventId ?? null }); }
    submitCheck(row, res, w);
    return res;
  } catch (err) {
    try { deps.rebuild(); } catch { /* the next tick re-reads */ }
    store.update(rowId, { status: 'skipped', skipReason: 'append', finishedAt: nowSec() });
    return { status: 'failed', reason: typeof err?.code === 'string' && err.code.length < 24 ? err.code : 'append' };
  }
}

/** Texts with each member in the last `days` (the scene sheet's "texting lately"). → { castId: { count, tones } } */
export function recentTexting(castIds, at = nowSec(), days = 3) {
  const out = {};
  try {
    for (const r of store.listLive({ since: at - days * DAY, limit: 200 })) {
      if (!castIds.includes(r.castId) || !(r.at <= at)) continue;
      const o = (out[r.castId] ??= { count: 0, tones: {} });
      o.count += 1;
      if (r.tone) o.tones[r.tone] = (o.tones[r.tone] ?? 0) + 1;
    }
  } catch { return {}; }
  return out;
}

