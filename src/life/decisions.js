import { stanceOf } from './stanceSeam.js';
import { planWeight, neverRethought, oneBeingOn, holdsPromise, chatMadeDecision, WEIGHT, PROMISE_REVERSE_P } from './planWeight.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { askJev, choice } from '../brain/jev.js';
import { budgetState, BudgetError } from '../brain/usage.js';
import { dateKey } from './clock.js';
import { rngFor } from './rng.js';
import { planTrip } from './travel.js';
import { routineOf } from './routine.js';
import { activityClass, companyOf, vitalsConfig } from './vitals.js';
import { weatherAt } from './weather.js';
import { sharedView } from './projector.js';
import { appendEvent, isValidOrigin } from './eventLog.js';
// 014 geo: the one projected-places merge.
import { worldWithPlaces } from './places.js';

// Timed decisions (spec 009 plan §R8, US4, FR-015–FR-018).
//
// A decision is a small choice with a deadline: "the flatmate wants a movie at
// 21:00 — go, go late, or stay in?". Lifecycle, all as world events:
//
//   decision.opened   options with code-computed costs, decideBy / ponrAt
//   decision.lean     his current lean {optionId, p, probs, trigger, fallback?}
//   decision.committed early (lean p ≥ config.life.commitP) or at decideBy (sampled)
//   decision.reversed a committed choice changed before the point of no return
//   decision.expired  every option ran out (or the caller cancelled it)
//   decision.mode_set owner 'auto'|'ask' (stored for 010; 009 commits by lean)
//
// Deadlines: decideBy = eventAt − travel(here → place) − prep; ponrAt = eventAt
// − travel, after which "go" options expire; "go late" options expire at the
// event's end. Travel comes from travel.js at the estimated departure time.
//
// Costs are code: each option gets a vector {energy, money, social, stress,
// travelMin} at open (vitals.js rates × duration, round-trip travel, spend,
// fun), stored in the opened event. U = −Σ need-weighted cost + affinity(cast)
// re-weights that vector by the CURRENT projection (tired → energy costs more,
// low battery → people cost more, low balance → money costs more, rain →
// travel costs more), so a lean can change without the options changing.
//
// Jev is asked for probabilities ONLY on a trigger, never per tick:
//   new_info      the decision opened, or an event linked to its subject arrived
//   state_shift   |Δenergy| ≥ 15, |Δstress| ≥ 15 or sick flipped since the last lean
//   chat_mention  noteChat(): a code matcher found the decision in a chat
//                 message; only {toward: optionId|null} goes on, never the text
//   deadline_near once, at decideBy − max(30 min, 20% of the window)
// Several triggers at once still cost one call. Over the daily budget
// (config.life.jevMaxPerDay) or on any Jev error/garbage, the lean is
// softmax(U / 0.5) by code: actor 'engine', payload.fallback 'budget'|'jev_budget'|'jev_error'
// ('life_off' when ctx.noJev: the life skill is switched off).
// The engine samples (rngFor, keyed by the decision) only at the deadline; the
// lean is the argmax. Expired options are never offered, leaned on or sampled.
//
// Actors and causes: a lean is 'jev' (or 'engine' on fallback); commits,
// reversals and expiries are the engine's rule acting on a lean, so they are
// 'engine' and caused by that lean (projector's jevToday counts only leans).
// A chat mention appends an inert `chat.trigger` (actor chat, the chat's
// origin); the lean it causes inherits that origin through appendEvent, and so
// does anything caused by the lean — a chat can steer, never write his life.
//
// Writes go through `append` (default eventLog.appendEvent), which must return
// the stored event (with id). The facade passes one that also folds the event
// into its projection (projector.applyAppended) and hands state in as a getter,
// so each async step sees fresh state. Every async entry point is serialized
// in this module: a tick and a chat message never race on one decision.
//
//   openDecision(state, spec, ctx)     → { decision, events }
//   evaluate(state, ctx)               → { events }          (pulse step 5)
//   noteChat(state, msg, ctx)          → { events, matched }  (perceiveChat)
//   setMode(state, id, mode, ctx)      → event                (owner)
//   cancelDecision(state, id, ctx)     → event | null
//   ownerCommit(state, id, optionId, ctx) → event              (owner card pick, 010)
// ctx: { world, at, append, newEvents?, rng?, causeId?, subjectJid? }; state: WorldState or () => WorldState.
//
// Spec 010 (research R14):
//   - mode 'ask' is the "Ask me" card: no early commit; at decideBy the argmax
//     of the latest lean (restricted to what is still available) commits,
//     `by:'lean'`. 'auto' keeps 009's sampling (`by:'sample'`); an early commit
//     is `by:'early'`. ownerCommit appends the owner's pick (`by:'owner'`), in
//     the same serialized chain as the pulse, so exactly one commit wins.
//   - An owner pick and an adopted decision are never reversed. An adopted
//     decision (spec.adopted, a plan he made in a chat) is committed at open
//     (spec.preCommit 'go', engine lean p = 1, `by:'adopted'`), then takes no
//     more triggers and no chat leans.
//   - spec.decideBy (explicit), per-option bias (−3…3, added to U), big,
//     category, bigDowngraded, arcId, claimId; ctx.subjectJid rides on the
//     opened event, every lean and the commit.
//   - A decision with a category is an arc decision: its Jev leans use caller
//     'life.arc.decision' and the separate budget config.arcs.jevMaxPerDay,
//     counted in the projection's counters.arcJevToday.

export const TRIGGERS = Object.freeze(['new_info', 'state_shift', 'chat_mention', 'deadline_near']);
export const SHIFT_ENERGY = 15;
export const SHIFT_STRESS = 15;
export const REVERSE_P = 0.7;
export const TAU = 0.5;
export const MAX_REVERSALS = 2;            // flip-flop guard per decision
export const CHAT_COOLDOWN_SEC = 10 * 60;  // one chat-driven re-check per decision per 10 min
export const DEFAULT_PREP_MIN = 20;
export const DEFAULT_MINUTES = 120;
export const NEAR_MIN_SEC = 30 * 60;
export const NEAR_FRACTION = 0.2;
export const PUSH_BONUS = 0.5;             // fallback U bonus for a chat-pushed option
const PROMISE_PULL = 2;                    // 020: utility of keeping his word (a tired evening doesn't break it, a sick one might)
export const AFFINITY_W = 2;

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const LABEL_MAX = 80;
const CHAT_TEXT_MAX = 2000;
const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,47}$/;
const KIND_RE = /^[a-z][a-z0-9_:-]{0,31}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const CHAT_KINDS = new Set(['group', 'dm', 'call', 'ig']);
const MODES = new Set(['auto', 'ask']);
const BIAS_MAX = 3;
const CATEGORY_RE = /^[a-z][a-z0-9_]{0,23}$/;
// Units that make cost components comparable (one "unit" each). Travel time is
// an hour per unit: the commute's energy drain is already in the energy cost.
const UNIT = { energy: 10, social: 10, stress: 10, travelMin: 60 };
// Commuting rates when an option travels (vitals.js 'commute' class).
const COMMUTE_CLASS = 'commute';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(v * 100) / 100;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => { throw new Error(`decisions: ${msg}`); };
const resolve = (state) => (typeof state === 'function' ? state() : state);

// ── Seams + counters ──────────────────────────────────────────────────────

let jevFn = askJev;

/** Replace the Jev client (tests). `null` restores the real askJev. */
export function setJev(fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error('setJev expects a function or null');
  jevFn = fn || askJev;
}

// Jev calls made by this module today, failures included (the projection's
// counters.jevToday only sees successful 'jev' leans, and survives restarts).
// Arc decisions (010) have their own counter and budget.
const attempts = { day: null, n: 0 };
const arcAttempts = { day: null, n: 0 };

/** Clear the in-memory Jev attempt counters (tests). */
export function resetDecisionCounters() {
  attempts.day = null;
  attempts.n = 0;
  arcAttempts.day = null;
  arcAttempts.n = 0;
}

/** ARCS_JEV_MAX_PER_DAY (010): arc-decision leans and the yearly appraisal share it. */
export function arcBudgetPerDay() {
  const n = Number(config.arcs?.jevMaxPerDay);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20;
}

const isArc = (d) => typeof d?.category === 'string' && d.category !== '';

// 010's "Ask me" semantics (no early commit, argmax at the deadline) apply to an
// arc decision, or to any 'ask' decision while the story is on (the story facade
// installs storyOn here). With the story off a 009 decision in 'ask' mode keeps
// 009's behaviour: stored, but committed by lean like 'auto'.
let storyAsk = () => false;
/** Story seam (010): fn() → true while the story is on; null → 009 behaviour. */
export function setStoryAsk(fn) {
  storyAsk = typeof fn === 'function' ? fn : () => false;
}
function asksOwner(d) {
  if (d?.mode !== 'ask') return false;
  if (isArc(d)) return true;
  try { return storyAsk() === true; } catch { return false; }
}

function budgetPerDay() {
  const n = Number(config.life?.jevMaxPerDay);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 40;
}

/** True when 007's `jev` role budget (or the global cap) is spent this month. Fails open to "not spent": askJev re-checks. */
function jevMonthlyBudgetSpent() {
  if (jevFn !== askJev) return false;   // a test/dry-run double is not metered
  try { return !budgetState('jev').allowed; } catch { return false; }
}

function commitP() {
  const p = Number(config.life?.commitP);
  return Number.isFinite(p) && p > 0.5 && p <= 1 ? p : 0.8;
}

/** Jev calls counted against today's budget at `at` (max of the projection's and this process's count). */
export function jevUsedToday(state, at, tz) {
  const day = dateKey(at, tz);
  const projected = state?.counters?.jevDay === day ? Number(state.counters.jevToday) || 0 : 0;
  const local = attempts.day === day ? attempts.n : 0;
  return Math.max(projected, local);
}

/** Arc-decision Jev calls counted against today's arc budget (010; counters.arcJevToday until the projector has it → 0). */
export function arcJevUsedToday(state, at, tz) {
  const day = dateKey(at, tz);
  const c = state?.counters;
  const projected = c?.arcJevDay === day ? Number(c?.arcJevToday ?? 0) || 0 : 0;
  const local = arcAttempts.day === day ? arcAttempts.n : 0;
  return Math.max(projected, local);
}

function noteAttempt(at, tz, counter = attempts) {
  const day = dateKey(at, tz);
  if (counter.day !== day) { counter.day = day; counter.n = 0; }
  counter.n += 1;
}

/** Count one arc Jev call made outside a lean (010: the appraisal) against today's arc budget. */
export function noteArcJevAttempt(at, tz) {
  noteAttempt(at, tz, arcAttempts);
}

// One queue for every async entry point (see header).
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * 015: run fn() in this module's serialized chain (evaluate / noteChat /
 * ownerCommit). The Director's apply takes it INSIDE pulse.exclusive — pulse
 * chain outer, decision lock inner, the order a tick uses — so an owner pick
 * and a deadline commit never both land.
 */
export function withDecisionLock(fn) {
  return serialized(async () => fn());
}

// ── Deadlines ─────────────────────────────────────────────────────────────

function tzOf(state, world) {
  return state?.world?.timezone || world?.timezone;
}

function hereOf(state) {
  const pos = state?.position;
  if (pos?.placeId) return pos.placeId;
  if (finite(pos?.lat) && finite(pos?.lon)) return { lat: pos.lat, lon: pos.lon };
  return state?.self?.homePlaceId || null;
}

// 014 geo (plan §A0): the one merge — projected places win on every id (a place
// created or moved by an event resolves), plus the stored road routes.
function travelWorld(state, world) {
  return worldWithPlaces(state, world);
}

/**
 * Trip from `from` to `placeId` arriving for `eventAt`: one-way planTrip at the
 * estimated departure (eventAt − travel at eventAt, refined once, so a peak
 * window just before the event counts). Null place or same spot → zero trip.
 */
export function tripFor(from, placeId, eventAt, weather, world, opts = {}) {
  if (!placeId || !from) return { from: typeof from === 'string' ? from : null, to: placeId ?? null, mode: 'walk', km: 0, minutes: 0, cost: 0 };
  const first = planTrip(from, placeId, eventAt, weather, world, opts);
  if (!first.minutes) return first;
  return planTrip(from, placeId, eventAt - first.minutes * 60, weather, world, opts);
}

/**
 * Deadlines for an event at `eventAt` at `placeId` heard about at `at`:
 * { travelMin, prepMin, decideBy, ponrAt, nearAt, trip }. decideBy never lies
 * before `at` (heard late → decide now); ponrAt may (then "go" is already gone).
 */
export function deadlines({ eventAt, placeId = null, from = null, at, prepMin, weather = null, mode } = {}, world) {
  if (!Number.isInteger(eventAt)) fail('eventAt must be integer unix seconds');
  if (!Number.isInteger(at)) fail('at must be integer unix seconds');
  const trip = tripFor(from, placeId, eventAt, weather, world, mode ? { mode } : {});
  const prep = finite(prepMin) ? Math.max(0, Math.round(prepMin)) : (routineOf(world).prepMinutes ?? DEFAULT_PREP_MIN);
  const ponrAt = eventAt - trip.minutes * 60;
  const decideBy = Math.max(at, ponrAt - prep * 60);
  return { travelMin: trip.minutes, prepMin: prep, decideBy, ponrAt, nearAt: nearTime(at, decideBy), trip };
}

/** When deadline_near fires: decideBy − max(30 min, 20% of the open→decideBy window). */
export function nearTime(opensAt, decideBy) {
  return decideBy - Math.max(NEAR_MIN_SEC, Math.round(NEAR_FRACTION * Math.max(0, decideBy - opensAt)));
}

// ── Costs and utility ─────────────────────────────────────────────────────

/**
 * Cost vector of one option spec (positive = it costs him; negative = it gives
 * back). spec: { kind (activity kind, vitals.js vocabulary), minutes, go
 * (true | 'late' | false), spend (money), fun (stress relief, 0–20), stress
 * (extra, e.g. guilt for bailing) }. `trip` is the one-way trip of a go option.
 */
export function optionCost(spec, trip, world) {
  const { rates } = vitalsConfig(world);
  const r = rates[activityClass(spec.kind || 'rest', world)] || rates.awake;
  const h = clamp(finite(spec.minutes) ? spec.minutes : DEFAULT_MINUTES, 0, 24 * 60) / 60;
  const goes = !!spec.go && trip && trip.minutes > 0;
  const travelMin = goes ? 2 * trip.minutes : 0;
  const c = rates[COMMUTE_CLASS] || r;
  const th = travelMin / 60;
  const fun = finite(spec.fun) ? clamp(spec.fun, 0, 20) : 0;
  const extra = finite(spec.stress) ? clamp(spec.stress, -20, 20) : 0;
  const spend = finite(spec.spend) ? Math.max(0, spec.spend) : 0;
  return {
    energy: round2(-(r.energy * h + c.energy * th)),
    money: round2(spend + (goes ? 2 * (trip.cost || 0) : 0)),
    social: round2(-(r.socialBattery * h + c.socialBattery * th)),
    stress: round2(r.stress * h + c.stress * th + extra - fun),
    travelMin,
  };
}

// How much a resource matters right now: ~0.1 when plentiful, 1.5 when nearly gone.
function need(v) {
  return clamp((70 - (finite(v) ? v : 50)) / 40, 0.1, 1.5);
}

/** Per-component weights from the current projection (see header). */
export function weightsFor(state, world) {
  const v = state?.vitals || {};
  const salary = finite(world?.money?.salary) ? world.money.salary : 0;
  const baseline = finite(world?.money?.monthlyBaseline) ? world.money.monthlyBaseline : 0;
  const daily = salary > 0 ? Math.max(1, (salary - baseline) / 30) : 0;
  let money = 0;
  if (daily) {
    money = 1 / daily;
    if (finite(v.money) && v.money <= 0) money *= 3;
    else if (finite(v.money) && v.money < Math.max(baseline, salary) / 4) money *= 2;
  }
  return {
    energy: need(v.energy) * (v.sick ? 1.5 : 1) / UNIT.energy,
    money,
    social: need(v.socialBattery) / UNIT.social,
    stress: (finite(v.stress) && v.stress > 70 ? 1.5 : 1) / UNIT.stress,
    travelMin: (state?.weather?.rain ? 1.5 : 1) / UNIT.travelMin,
  };
}

// Story seam (010 earned trust): fn() → the weight of (trust − 0.5) in castAffinity
// while the story is on; 0 (009's behaviour) otherwise.
let trustWeight = () => 0;
/** null restores 009 behaviour (no trust term). */
export function setTrustWeight(fn) {
  trustWeight = typeof fn === 'function' ? fn : () => 0;
}

// Story seam: a go/attend option with a love or lust interest, when urge is high.
// The story facade installs it. 0 while arcs is off. The bump stays ≤ 2.
let urgeBoost = () => 0;
/** null restores 009 (no urge term). */
export function setUrgeBoost(fn) {
  urgeBoost = typeof fn === 'function' ? fn : () => 0;
}

/**
 * Mean (closeness − tension) of the decision's cast, −1…1 (0 without cast);
 * with the story's trust seam, + w × (trust − 0.5) per member: he follows
 * through more with people he trusts.
 */
export function castAffinity(decision, state) {
  const ids = decision?.subject?.castIds || [];
  let w = 0;
  try { w = Number(trustWeight()) || 0; } catch { w = 0; }
  const vals = [];
  for (const id of ids) {
    const m = state?.cast?.get?.(id)?.metrics;
    if (!m) continue;
    let v = (finite(m.closeness) ? m.closeness : 0.5) - (finite(m.tension) ? m.tension : 0);
    if (w) v += w * ((finite(m.trust) ? m.trust : 0.5) - 0.5);
    vals.push(v);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/**
 * U per available option: −Σ w·cost + affinity on options spent with people
 * (social cost > 0), + PUSH_BONUS on `pushed` (fallback only). { optionId: U }.
 */
export function utilities(decision, state, world, { at, pushed = null } = {}) {
  const w = weightsFor(state, world);
  const aff = AFFINITY_W * castAffinity(decision, state);
  const out = {};
  for (const o of availableOptions(decision, at)) {
    const c = o.cost || {};
    let u = 0;
    for (const k of Object.keys(w)) u -= w[k] * (finite(c[k]) ? c[k] : 0);
    if ((c.social ?? 0) > 0) u += aff;
    if ((c.social ?? 0) > 0 && (o.id === 'go' || o.id === 'late' || o.id === 'attend')) {
      try {
        const bump = Number(urgeBoost(state, decision?.subject?.castIds, at));
        if (bump > 0 && bump <= 2) u += bump;
      } catch { /* leave the 009 utility */ }
    }
    if (o.id === 'go' || o.id === 'late' || o.id === 'attend') {   // plan 020 B: his interests; 0 until the owner approves a set
      const view = stanceOf(o.kind ?? decision?.kind, decision?.subject?.placeId);
      if (view) u += view.bump;
    }
    if (finite(o.bias)) u += clamp(o.bias, -BIAS_MAX, BIAS_MAX); // 010: arc preference computed in code
    if (pushed && o.id === pushed) u += PUSH_BONUS;
    // 020: he gave his word: the option he promised pulls (code fallback and Jev's `utility` alike).
    if (holdsPromise(decision) && o.id === decision.committed?.optionId) u += PROMISE_PULL;
    out[o.id] = Math.round(u * 1000) / 1000;
  }
  return out;
}

/** softmax(U / τ) over the given { id: U } map. */
export function softmax(us, tau = TAU) {
  const ids = Object.keys(us);
  if (!ids.length) return {};
  const t = finite(tau) && tau > 0 ? tau : TAU;
  const m = Math.max(...ids.map(k => us[k]));
  const e = ids.map(k => Math.exp((us[k] - m) / t));
  const z = e.reduce((a, b) => a + b, 0);
  const out = {};
  ids.forEach((k, i) => { out[k] = e[i] / z; });
  return out;
}

/** Options still choosable at `at` (no expiresAt, or expiresAt in the future). */
export function availableOptions(decision, at) {
  return (decision?.options || []).filter(o => !finite(o.expiresAt) || !finite(at) || at < o.expiresAt);
}

function argmax(probs) {
  let best = null;
  for (const [k, p] of Object.entries(probs)) if (best === null || p > probs[best]) best = k;
  return best;
}

/** Restrict probs to `ids` and renormalize; null when nothing positive remains. */
export function restrictProbs(probs, ids) {
  if (!isObj(probs)) return null;
  const out = {};
  let z = 0;
  for (const id of ids) {
    const p = probs[id];
    if (finite(p) && p > 0) { out[id] = p; z += p; }
  }
  if (!(z > 0)) return null;
  for (const id of Object.keys(out)) out[id] = out[id] / z;
  return out;
}

/** Inverse-CDF sample over `probs` in option order with one draw from `rng`. */
export function sampleOption(probs, order, rng) {
  const ids = order.filter(id => finite(probs[id]) && probs[id] > 0);
  if (!ids.length) return null;
  let roll = rng();
  for (const id of ids) {
    roll -= probs[id];
    if (roll < 0) return id;
  }
  return ids[ids.length - 1];
}

// ── Triggers (pure) ───────────────────────────────────────────────────────

// A decision's own events — and (012) an invitation's answer / follow-up record — are not news about it.
const SELF_TYPES = /^(?:decision|invite)\./;

function rainAtLean(d, world) {
  if (typeof d.lean?.rain === 'boolean') return d.lean.rain;
  if (!finite(d.lean?.at) || !world) return undefined;
  try { return weatherAt(d.lean.at, world).rain === true; } catch { return undefined; }
}

const CHATTER_TYPES = new Set(['phone.message', 'relationship.changed']);
function linkedEvent(ev, d, world) {
  if (!isObj(ev) || !Number.isSafeInteger(ev.id) || ev.id === d.id) return false;
  if (SELF_TYPES.test(ev.type) || ev.type === 'chat.trigger' || ev.type === 'event.reverted') return false;
  const p = isObj(ev.payload) ? ev.payload : {};
  if (ev.causeId === d.id || p.decisionId === d.id) return true;
  const place = d.subject?.placeId;
  if (place && (p.placeId === place || p.to === place)) return true;
  const cast = new Set(d.subject?.castIds || []);
  if (cast.size) {
    // A meeting's attendees are not news about them (companyOf).
    const ids = [p.castId, ...companyOf(p), ...(Array.isArray(p.castIds) ? p.castIds : [])];
    if (ids.some(id => cast.has(id))) return true;
  }
  // Rain starting or stopping changes every trip's cost.
  if (ev.type === 'weather.changed' && typeof p.rain === 'boolean'
      && d.options.some(o => (o.cost?.travelMin ?? 0) > 0)) {
    const was = rainAtLean(d, world);
    return was === undefined || was !== p.rain;
  }
  return false;
}

/**
 * Triggers due for decision `d` at `at` given the current (advanced) state and
 * the events appended since the last evaluation. Returns [{ trigger, causeId }]
 * in priority order (new_info, state_shift, deadline_near); [] = no Jev call.
 * Committed decisions only re-check (new_info/state_shift) before ponrAt.
 */
export function detectTriggers(d, state0, { at, newEvents = [], world } = {}) {
  const state = scoped(state0, d);
  const out = [];
  if (!d || (d.status !== 'open' && d.status !== 'committed')) return out;
  if (neverRethought(d)) return out; // the owner's plan or a soft goal's outing; anything else he may rethink (020)
  if (d.status === 'committed' && (!finite(d.ponrAt) || at >= d.ponrAt || d.reversals >= reversalCap(d) || hasSetOff(d, state0, at))) return out;

  const linked = (Array.isArray(newEvents) ? newEvents : [])
    .filter(ev => linkedEvent(ev, d, world) && (!d.lean || ev.id > (d.lean.eventId ?? 0))
      // Chatting with the person he promised is no news about the plan (a Jev call a tick from the shared cap otherwise).
      && !(oneBeingOn() && planWeight(d) === WEIGHT.promise && CHATTER_TYPES.has(ev.type)));
  if (linked.length) out.push({ trigger: 'new_info', causeId: linked[linked.length - 1].id });

  const was = d.lean?.state;
  const v = state?.vitals;
  if (was && v) {
    const shifted = Math.abs((v.energy ?? 0) - (was.energy ?? 0)) >= SHIFT_ENERGY
      || Math.abs((v.stress ?? 0) - (was.stress ?? 0)) >= SHIFT_STRESS
      || (v.sick === true) !== (was.sick === true);
    // Caused by the decision, not the last lean: a shift in his body isn't
    // the chat that may have moved that lean (no needless origin taint).
    if (shifted) out.push({ trigger: 'state_shift', causeId: d.id });
  }

  if (d.status === 'open' && finite(d.decideBy)) {
    const near = nearTime(d.opensAt ?? d.decideBy, d.decideBy);
    if (at >= near && (!d.lean || d.lean.at < near)) out.push({ trigger: 'deadline_near', causeId: d.id });
  }
  return out;
}

// ── Chat matcher (code only; the text never leaves this function) ─────────

const STOP = new Set(['with', 'from', 'that', 'this', 'just', 'stay', 'home', 'have', 'into', 'your', 'some', 'plan']);
export const GO_RE = /\b(?:come|coming|join|joining|let['’]?s|lets|going|go|in for|you in|be there|see you|meet)\b/i;
export const STAY_RE = /\b(?:skip|skipping|stay|staying|rest|sleep|tired|cancel|cancelled|(?:can['’]?t|cannot|won['’]?t) (?:make|come|go)|not coming|no thanks|pass|bail)\b/i;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordsOf(s, min = 4) {
  return String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= min && !STOP.has(w));
}

function hasWord(text, w) {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(w)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * Does `text` talk about decision `d`? Mention keywords (plan §R8): the decision
 * kind, its place's name, its cast's names — NOT option label words, which
 * are common ("late", "rest") and would spend the Jev budget on chatter. Returns
 * { toward: optionId|null } or null. `toward`: a stay cue ("skip", "tired") →
 * the first stay-put option; else an option whose label words appear (and no
 * other's); else a go cue → the first go option; else null.
 */
export function matchChat(d, text, state) {
  if (!d || typeof text !== 'string' || !text.trim()) return null;
  const t = text.slice(0, CHAT_TEXT_MAX).toLowerCase();
  const keys = new Set(wordsOf(d.kind));
  const place = d.subject?.placeId ? state?.places?.get?.(d.subject.placeId) : null;
  for (const w of wordsOf(place?.name, 3)) keys.add(w);
  for (const id of d.subject?.castIds || []) for (const w of wordsOf(state?.cast?.get?.(id)?.name, 3)) keys.add(w);
  if (![...keys].some(w => hasWord(t, w))) return null;
  // Words naming the decision itself ("movie", the flatmate) don't pick a side.
  const optWords = new Map((d.options || []).map(o => [o.id, wordsOf(o.label).filter(w => !keys.has(w))]));

  const goes = o => (o.cost?.travelMin ?? 0) > 0 || (o.cost?.social ?? 0) > 0;
  if (STAY_RE.test(t)) return { toward: (d.options || []).find(o => !goes(o))?.id ?? null };
  // Only a word unique to one option's label picks it (a word in two labels doesn't).
  const hits = [...optWords].filter(([, ws]) => ws.some(w => hasWord(t, w))).map(([id]) => id);
  if (hits.length === 1) return { toward: hits[0] };
  if (GO_RE.test(t)) return { toward: (d.options || []).find(goes)?.id ?? null };
  return { toward: null };
}

// ── Jev ───────────────────────────────────────────────────────────────────

/** plan 020 B: how much he likes this kind of thing and this place, only when he has a view. */
function jevStance(d) {
  const view = stanceOf(d?.kind, d?.subject?.placeId);
  if (!view) return {};
  const r2 = (x) => Math.round(x * 100) / 100;
  return { ...(finite(view.interest) ? { interest: r2(view.interest) } : {}), ...(finite(view.placeLiking) ? { place_liking: r2(view.placeLiking) } : {}) };
}

/** The compact numeric state Jev sees (no names, no chat text). */
export function jevState(d, state, at, us, { pushed = null, trigger } = {}) {
  const v = state?.vitals || {};
  const r1 = x => (finite(x) ? Math.round(x) : null);
  return {
    decision: d.kind,
    trigger,
    minutes_to_event: finite(d.subject?.eventAt) ? Math.round((d.subject.eventAt - at) / 60) : null,
    minutes_to_decide: finite(d.decideBy) ? Math.max(0, Math.round((d.decideBy - at) / 60)) : null,
    energy: r1(v.energy),
    stress: r1(v.stress),
    hunger: r1(v.hunger),
    social_battery: r1(v.socialBattery),
    sleep_debt_h: finite(v.sleepDebt) ? Math.round(v.sleepDebt * 10) / 10 : null,
    mood: finite(v.mood?.valence) ? Math.round(v.mood.valence * 100) / 100 : null,
    sick: v.sick === true,
    raining: state?.weather?.rain === true,
    cast_affinity: Math.round(castAffinity(d, state) * 100) / 100,
    ...jevStance(d),
    ...(d.status === 'committed' && d.committed ? { committed_to: d.committed.optionId } : {}),
    ...(holdsPromise(d) ? { gave_his_word: true } : {}),
    ...(pushed ? { friend_pushed_toward: pushed } : {}),
    options: availableOptions(d, at).map(o => ({ id: o.id, label: o.label, utility: us[o.id], ...o.cost })),
  };
}

async function askLean(d, state, at, { pushed, trigger }, world, { noJev = false, noJevReason = null } = {}) {
  const tz = tzOf(state, world);
  const avail = availableOptions(d, at);
  const ids = avail.map(o => o.id);
  const us = utilities(d, state, world, { at });
  const fallback = (reason) => {
    const probs = softmax(utilities(d, state, world, { at, pushed }));
    return { actor: 'engine', probs, fallback: reason };
  };
  // One option left is no choice: no Jev call, the engine leans on it.
  if (ids.length === 1) return { actor: 'engine', probs: { [ids[0]]: 1 }, fallback: null };
  if (noJev) return fallback(noJevReason || 'life_off');      // the life skill is off (or 012: an invitation's first lean)
  const arc = isArc(d);
  if (arc ? arcJevUsedToday(state, at, tz) >= arcBudgetPerDay() : jevUsedToday(state, at, tz) >= budgetPerDay()) {
    return fallback('budget');
  }
  // 007's jev/global monthly budget: spent → lean from costs without a call (askJev
  // would refuse anyway, writing a 'budget' ledger row on every pulse).
  if (jevMonthlyBudgetSpent()) return fallback('jev_budget');

  noteAttempt(at, tz, arc ? arcAttempts : attempts);
  const criteria = {};
  for (const o of avail) criteria[o.id] = o.label;
  try {
    const res = await jevFn({
      state: jevState(d, state, at, us, { pushed, trigger }),
      questions: { pick: choice('Given his state and the options, which option would he choose now?', criteria) },
      caller: arc ? 'life.arc.decision' : 'life.decision',
    });
    // Jev's answer is untrusted: only known, available ids with finite probabilities count.
    const probs = restrictProbs(res?.answers?.pick?.probabilities, ids);
    if (!probs) throw new Error('no usable probabilities');
    return { actor: 'jev', probs, fallback: null };
  } catch (err) {
    if (err instanceof BudgetError) {
      logger.info({ decisionId: d.id, reason: err.state?.reason }, 'life decisions: Jev over budget, lean from costs');
      return fallback('jev_budget');
    }
    logger.warn({ err: err?.message, decisionId: d.id }, 'life decisions: Jev failed, lean from costs');
    return fallback('jev_error');
  }
}

// ── Steps (append + keep a local copy of the decision current) ────────────

function roundProbs(probs) {
  const out = {};
  for (const [k, p] of Object.entries(probs)) out[k] = Math.round(p * 10000) / 10000;
  return out;
}

async function leanStep(d, state0, at, { trigger, causeId, pushed = null, also = [] }, ctx) {
  const state = scoped(state0, d);
  const r = await askLean(d, state, at, { pushed, trigger }, ctx.world, { noJev: ctx.noJev, noJevReason: ctx.noJevReason });
  const optionId = argmax(r.probs);
  if (!optionId) return null;
  const ev = ctx.append({
    type: 'decision.lean', at, actor: r.actor, causeId, ...subjectOf(d),
    payload: {
      decisionId: d.id, optionId, p: Math.round(r.probs[optionId] * 10000) / 10000,
      probs: roundProbs(r.probs), trigger,
      ...(also.length ? { also } : {}),
      ...(r.fallback ? { fallback: r.fallback } : {}),
    },
  });
  ctx.out.push(ev);
  const v = state?.vitals || {};
  d.lean = {
    optionId, p: r.probs[optionId], probs: r.probs, at, by: r.actor, trigger, fallback: r.fallback,
    state: { energy: v.energy, stress: v.stress, sick: v.sick === true }, rain: state?.weather?.rain === true,
    eventId: ev.id,
  };
  d.leans = (d.leans || 0) + 1;
  return ev;
}

function isWanted(d, state, world, optionId, at) {
  const us = utilities(d, state, world, { at });
  return argmax(us) === optionId;
}

// subjectJid (010) rides on every event of a decision that names a real person.
function subjectOf(d) {
  return typeof d?.subjectJid === 'string' && d.subjectJid ? { subjectJid: d.subjectJid } : {};
}

function commitStep(d, state, at, { optionId, p, sampled, causeId, by, actor = 'engine', extra = {} }, ctx) {
  const ev = ctx.append({
    type: 'decision.committed', at, actor, causeId, ...subjectOf(d),
    payload: {
      decisionId: d.id, optionId, p: Math.round(p * 10000) / 10000, sampled,
      wanted: isWanted(d, state, ctx.world, optionId, at),
      by,
      ...extra,
    },
  });
  ctx.out.push(ev);
  d.status = 'committed';
  d.committed = { optionId, at, p, sampled, by, eventId: ev.id };
  return ev;
}

function expireStep(d, at, reason, causeId, ctx) {
  const ev = ctx.append({ type: 'decision.expired', at, actor: 'engine', causeId, payload: { decisionId: d.id, reason } });
  ctx.out.push(ev);
  d.status = reason === 'cancelled' ? 'cancelled' : 'expired';
  return ev;
}

// 020 (§A3): a plan keeps the origin of where it was made. A chat's nudge is an influence on it (the
// lean keeps the chat's origin and stays in `origins`, payload `nudged`), so a commit after one is
// caused by the decision itself: before this, one chat line just before his deadline made the whole
// evening chat-origin (the scene narration-only, no relationship effects, hidden from other chats).
// `leanEventId` keeps the undo: a revoked or forgotten line takes back what it caused (eventLog.cascadeIds
// and the projector follow it). A plan made in a chat has that chat's origin anyway: its commit keeps
// the plain cause.
function commitCause(d, causeId) {
  if (oneBeingOn() && d?.lean?.trigger === 'chat_mention' && causeId === d.lean.eventId && !chatMadeDecision(d)) {
    return { causeId: d.id, extra: { nudged: true, leanEventId: causeId } };
  }
  return { causeId, extra: {} };
}
const withExtra = (c, more) => ({ causeId: c.causeId, extra: { ...c.extra, ...more } });

// How many times a lean may reverse this plan: a promise once (so another lean on one reversed
// already can't change anything, and costs nothing).
function reversalCap(d) {
  if (!oneBeingOn()) return MAX_REVERSALS;
  if (planWeight(d) === WEIGHT.promise) return 1;
  return d?.invite === true ? Math.min(MAX_REVERSALS, finite(d.inviteMaxRev) ? d.inviteMaxRev : 1) : MAX_REVERSALS;
}

// 020: he has set off for it (or is there): a block of his day carrying this plan has started. A fit
// may leave well before the point of no return, which was computed from where he was when it opened.
function hasSetOff(d, state, at) {
  if (!oneBeingOn() || !Number.isSafeInteger(d?.id)) return false;
  return (state?.plan?.blocks ?? []).some(b => b.decisionId === d.id && b.start <= at);
}

// After a lean: early commit (open) or reversal (committed, before ponrAt).
// 010: an 'ask' decision never commits early (the owner may still pick; see
// asksOwner); an owner pick or an adopted plan is never reversed.
function afterLean(d, state0, at, leanEv, ctx) {
  if (!d.lean) return;
  const state = scoped(state0, d);
  const avail = new Set(availableOptions(d, at).map(o => o.id));
  const locked = neverRethought(d);
  // 020: breaking a promise takes a much surer lean, and only once (planWeight).
  const promise = holdsPromise(d);
  const reverseAt = promise ? PROMISE_REVERSE_P : REVERSE_P;
  // A code-fallback lean (over cap, Jev down) never breaks his word: softmax hits 0.9 on a tired blip.
  const mayReverse = !promise || !d.lean.fallback;
  // 012: an invitation waits for his own word (no early commit until he answered)
  // and reverses at most d.inviteMaxRev times.
  const waitsForAnswer = d.invite === true && !d.inviteAnswer;
  const maxRev = oneBeingOn() ? reversalCap(d) : d.invite === true ? Math.min(MAX_REVERSALS, finite(d.inviteMaxRev) ? d.inviteMaxRev : 1) : MAX_REVERSALS;
  if (d.status === 'open' && !waitsForAnswer && !asksOwner(d) && d.lean.p >= commitP() && avail.has(d.lean.optionId)) {
    commitStep(d, state, at, { optionId: d.lean.optionId, p: d.lean.p, sampled: false, ...commitCause(d, leanEv.id), by: 'early' }, ctx);
  } else if (d.status === 'committed' && !locked && mayReverse && finite(d.ponrAt) && at < d.ponrAt && !hasSetOff(d, state0, at)
      && d.lean.optionId !== d.committed.optionId && d.lean.p >= reverseAt && avail.has(d.lean.optionId)
      && (d.reversals || 0) < maxRev) {
    const { causeId, extra } = commitCause(d, leanEv.id);
    const ev = ctx.append({
      type: 'decision.reversed', at, actor: 'engine', causeId, ...subjectOf(d),
      payload: { decisionId: d.id, from: d.committed.optionId, to: d.lean.optionId, p: Math.round(d.lean.p * 10000) / 10000, ...extra },
    });
    ctx.out.push(ev);
    d.committed = { ...d.committed, optionId: d.lean.optionId, at, eventId: ev.id };
    d.reversals = (d.reversals || 0) + 1;
  }
}

// At or past decideBy and still open: sample from the latest lean (restricted
// to what's still choosable) and commit. Dated decideBy (never before the lean
// it samples), keyed by the decision, so a catch-up commits what a live run would.
// 010: an 'ask' decision (asksOwner) commits the argmax of that lean instead (no draw).
function deadlineCommit(d, state0, at, ctx) {
  const state = scoped(state0, d);
  // 012: an invitation he never answered expires at its (graced) deadline — no
  // outing without his word (fail closed). A "maybe" commits like any decision.
  if (d.invite === true && !d.inviteAnswer) {
    return expireStep(d, Math.max(Math.min(at, d.decideBy), d.opensAt ?? 0), 'unanswered', d.lean?.eventId ?? d.id, ctx);
  }
  const when = Math.max(Math.min(at, d.decideBy), finite(d.lean?.at) ? d.lean.at : 0);
  const avail = availableOptions(d, when);
  const ids = avail.map(o => o.id);
  if (!ids.length) return null;
  const probs = restrictProbs(d.lean?.probs, ids) || softmax(utilities(d, state, ctx.world, { at: when }));
  if (asksOwner(d)) {
    const best = ids.reduce((b, id) => (b === null || (probs[id] ?? 0) > (probs[b] ?? 0) ? id : b), null);
    if (!best) return null;
    return commitStep(d, state, when, {
      optionId: best, p: probs[best] ?? 0, sampled: false, by: 'lean', ...withExtra(commitCause(d, d.lean?.eventId ?? d.id), { byLean: true }),
    }, ctx);
  }
  const rng = ctx.rng || rngFor(dateKey(d.decideBy, tzOf(state, ctx.world)), `decision:${d.id}:commit`);
  const optionId = sampleOption(probs, ids, rng);
  if (!optionId) return null;
  return commitStep(d, state, when, { optionId, p: probs[optionId], sampled: true, ...commitCause(d, d.lean?.eventId ?? d.id), by: 'sample' }, ctx);
}

function makeCtx(ctx, state, world) {
  const at = Number.isInteger(ctx?.at) ? ctx.at : null;
  if (at === null) fail('ctx.at must be integer unix seconds');
  if (!world) fail('ctx.world is required');
  return {
    world, at, append: typeof ctx.append === 'function' ? ctx.append : appendEvent, rng: ctx.rng, noJev: ctx?.noJev === true,
    // 012: why a no-Jev lean fell back ('invite_open' for an invitation's first lean); default 'life_off'.
    noJevReason: typeof ctx?.noJevReason === 'string' && KIND_RE.test(ctx.noJevReason) ? ctx.noJevReason : null,
    out: [],
  };
}

function viewOf(state, at, world) {
  if (!state || state.view || state.genesisAt == null || state.at == null) return state;
  // 012: with chat-mood entries a view is built even at at <= state.at (the overlay decays with time).
  if (at <= state.at && !state.chatMood?.length) return state;
  // Read only here (decision copies are cloned on their own): no deep copy.
  return sharedView(state, at, world);
}

// 012: chat mood never tips a story-family decision (a category, or a career /
// family / romance / heavy / arc kind): those read the view's base vitals
// (projector vitalsBase, present only when an overlay was added).
const STORY_KIND_RE = /^(?:career|family|romance|heavy|arc)(?:[:_.-]|$)/;
function scoped(state, d) {
  if (!state?.vitalsBase || !(d?.category || STORY_KIND_RE.test(String(d?.kind ?? '')))) return state;
  return { ...state, vitals: state.vitalsBase };
}

function decisionCopy(state, id) {
  const d = state?.decisions?.get?.(id);
  return d ? structuredClone(d) : null;
}

// ── Open ──────────────────────────────────────────────────────────────────

function cleanLabel(v, fallback) {
  const s = typeof v === 'string' ? sanitizeWebContent(v).replace(/\s+/g, ' ').trim() : '';
  return (s || fallback).slice(0, LABEL_MAX);
}

function validateSpec(spec, state) {
  if (!isObj(spec)) fail('spec must be an object');
  const kind = typeof spec.kind === 'string' && KIND_RE.test(spec.kind) ? spec.kind : null;
  if (!kind) fail('spec.kind must be a short lowercase kind');
  const s = isObj(spec.subject) ? spec.subject : {};
  if (!Number.isInteger(s.eventAt)) fail('subject.eventAt must be integer unix seconds');
  const placeId = s.placeId == null ? null : (typeof s.placeId === 'string' && PLACE_ID_RE.test(s.placeId) ? s.placeId : fail('bad subject.placeId'));
  if (placeId && state?.places instanceof Map && state.places.size && !state.places.has(placeId)) fail(`unknown place ${placeId}`);
  const castIds = [...new Set((Array.isArray(s.castIds) ? s.castIds : []).filter(id => typeof id === 'string' && CAST_ID_RE.test(id)))].slice(0, 16);
  const minutes = finite(s.minutes) ? clamp(Math.round(s.minutes), 5, 24 * 60) : DEFAULT_MINUTES;
  const opts = Array.isArray(spec.options) ? spec.options : [];
  if (opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS) fail(`a decision needs ${MIN_OPTIONS}–${MAX_OPTIONS} options`);
  const seen = new Set();
  const options = opts.map((o) => {
    if (!isObj(o) || typeof o.id !== 'string' || !OPTION_ID_RE.test(o.id)) fail('option ids must match [A-Za-z0-9_:.-]');
    if (seen.has(o.id)) fail(`duplicate option ${o.id}`);
    seen.add(o.id);
    const go = o.go === true || o.go === 'late' ? o.go : false;
    if (o.bias !== undefined && o.bias !== null && !finite(o.bias)) fail(`option ${o.id} bias must be a number`);
    return {
      id: o.id, label: cleanLabel(o.label, o.id), go,
      kind: typeof o.kind === 'string' && KIND_RE.test(o.kind) ? o.kind : (go ? (castIds.length ? 'social' : 'leisure') : 'rest'),
      minutes: finite(o.minutes) ? clamp(o.minutes, 0, 24 * 60) : minutes,
      spend: o.spend, fun: o.fun, stress: o.stress,
      expiresAt: Number.isInteger(o.expiresAt) ? o.expiresAt : null,
      bias: finite(o.bias) ? round2(clamp(o.bias, -BIAS_MAX, BIAS_MAX)) : 0,
    };
  });
  // 010 fields (research R14), all optional; a 009 spec gives none of them.
  if (spec.decideBy !== undefined && spec.decideBy !== null && !Number.isInteger(spec.decideBy)) fail('decideBy must be integer unix seconds');
  if (spec.category !== undefined && spec.category !== null && !(typeof spec.category === 'string' && CATEGORY_RE.test(spec.category))) {
    fail('category must be a short lowercase word');
  }
  const adopted = spec.adopted === true;
  if (spec.preCommit !== undefined && spec.preCommit !== null) {
    if (spec.preCommit !== 'go' || !adopted) fail("preCommit is only 'go' on an adopted decision");
    if (!seen.has('go')) fail("preCommit 'go' needs a go option");
  }
  const posId = (v, what) => {
    if (v === undefined || v === null) return null;
    if (!Number.isSafeInteger(v) || v < 1) fail(`${what} must be a positive event id`);
    return v;
  };
  // 012: an invitation from a chat ({ pointerId, maxReversals 0..1 }) and its answer grace.
  let invite = null;
  if (spec.invite !== undefined && spec.invite !== null) {
    if (!isObj(spec.invite) || !Number.isSafeInteger(spec.invite.pointerId) || spec.invite.pointerId < 1) fail('invite.pointerId must be a positive event id');
    const mr = spec.invite.maxReversals ?? 1;
    if (!Number.isInteger(mr) || mr < 0 || mr > 1) fail('invite.maxReversals must be 0 or 1');
    invite = { pointerId: spec.invite.pointerId, maxReversals: mr };
  }
  if (spec.answerGraceSec !== undefined && spec.answerGraceSec !== null
      && !(Number.isInteger(spec.answerGraceSec) && spec.answerGraceSec >= 0 && spec.answerGraceSec <= 3 * 3600)) {
    fail('answerGraceSec must be 0..10800 seconds');
  }
  return {
    kind, subject: { eventAt: s.eventAt, placeId, castIds, minutes }, options,
    mode: MODES.has(spec.mode) ? spec.mode : 'auto',
    invite,
    answerGraceSec: invite && Number.isInteger(spec.answerGraceSec) ? spec.answerGraceSec : null,
    prepMin: spec.prepMin,
    decideBy: Number.isInteger(spec.decideBy) ? spec.decideBy : null,
    category: typeof spec.category === 'string' ? spec.category : null,
    big: spec.big === true,
    bigDowngraded: spec.bigDowngraded === 'lead_time' ? 'lead_time' : null,
    adopted,
    preCommit: adopted && spec.preCommit === 'go' ? 'go' : null,
    arcId: posId(spec.arcId, 'arcId'),
    claimId: posId(spec.claimId, 'claimId'),
  };
}

// Optional 010 payload fields, only when set (a 009 decision's payload is unchanged).
function specExtras(v) {
  return {
    ...(v.category ? { category: v.category } : {}),
    ...(v.big ? { big: true } : {}),
    ...(v.bigDowngraded ? { bigDowngraded: v.bigDowngraded } : {}),
    ...(v.adopted ? { adopted: true } : {}),
    ...(v.arcId ? { arcId: v.arcId } : {}),
    ...(v.claimId ? { claimId: v.claimId } : {}),
    ...(v.invite ? { invite: { pointerId: v.invite.pointerId, maxReversals: v.invite.maxReversals } } : {}),
  };
}

/**
 * The `decision.opened` payload for `spec` heard at `at` — pure, the planning
 * half of openDecision (which appends it, then leans). `s` is the state it
 * plans on (openDecision: the scoped view; the Director's approved weekly
 * opener: its projection). Throws like openDecision on a bad spec.
 * → { v, payload, decideBy, ponrAt, options }
 */
export function planOpened(s, spec, { at, world } = {}) {
  const v = validateSpec(spec, s);
  const tw = travelWorld(s, world);
  const from = hereOf(s);
  const prepMin = finite(v.prepMin) ? v.prepMin : (routineOf(world).prepMinutes ?? DEFAULT_PREP_MIN);
  const dl = deadlines({ eventAt: v.subject.eventAt, placeId: v.subject.placeId, from, at, prepMin, weather: s?.weather ?? null }, tw);
  // 010: an explicit decideBy (never before now); a decision that isn't a trip has its point of no return there too.
  const endAt = v.subject.eventAt + v.subject.minutes * 60;
  let decideBy = v.decideBy !== null ? Math.max(at, v.decideBy) : dl.decideBy;
  // 012 answer grace: a short-notice (or deferred) invitation stays open for his
  // reply — never past the event's end; with a place, go still expires at ponrAt.
  if (v.answerGraceSec !== null) decideBy = Math.min(Math.max(decideBy, at + v.answerGraceSec), endAt);
  const ponrAt = v.decideBy !== null && !v.subject.placeId ? decideBy : dl.ponrAt;
  const options = v.options.map(o => ({
    id: o.id,
    label: o.label,
    cost: optionCost(o, o.go ? dl.trip : null, world),
    expiresAt: o.expiresAt ?? (o.go === true ? ponrAt : o.go === 'late' ? endAt : null),
    ...(o.bias ? { bias: o.bias } : {}),
  }));
  const payload = {
    kind: v.kind,
    subject: { eventAt: v.subject.eventAt, endAt, placeId: v.subject.placeId, castIds: v.subject.castIds },
    opensAt: at, decideBy, ponrAt,
    travelMin: dl.travelMin, prepMin: dl.prepMin, mode: v.mode,
    options,
    ...specExtras(v),
  };
  return { v, payload, decideBy, ponrAt, options };
}

/**
 * Open a decision and take its first lean (trigger new_info, cause = the
 * opened event); a confident lean commits at once. spec: { kind, subject:
 * { eventAt, placeId?, castIds?, minutes? }, options: [{ id, label, go?,
 * kind?, minutes?, spend?, fun?, stress?, expiresAt? }], mode?, prepMin? }.
 * ctx.causeId links it to what he heard (plan.made, a cast event, …).
 * Returns { decision: the opened event, events } — every appended event in order.
 */
export function openDecision(state, spec, ctx = {}) {
  return serialized(async () => {
    const s0 = resolve(state);
    const world = ctx.world;
    const c = makeCtx(ctx, s0, world);
    const at = c.at;
    const s = scoped(viewOf(s0, at, world), spec);
    const { v, payload, decideBy, ponrAt, options } = planOpened(s, spec, { at, world });
    const subjectJid = typeof ctx.subjectJid === 'string' && ctx.subjectJid ? ctx.subjectJid : null;
    const opened = c.append({
      type: 'decision.opened', at, actor: 'engine', causeId: ctx.causeId ?? null,
      ...(subjectJid ? { subjectJid } : {}),
      payload,
    });
    c.out.push(opened);

    const d = {
      id: opened.id, kind: v.kind,
      subject: { eventAt: v.subject.eventAt, placeId: v.subject.placeId, castIds: v.subject.castIds },
      opensAt: at, decideBy, ponrAt, options,
      lean: null, leans: 0, mode: v.mode, status: 'open', committed: null, reversals: 0, signals: [],
      ...(v.category ? { category: v.category } : {}),
      ...(v.adopted ? { adopted: true } : {}),
      ...(subjectJid ? { subjectJid } : {}),
      // 012: set before the first lean so the opening lean can't commit early either.
      ...(v.invite ? { invite: true, inviteMaxRev: v.invite.maxReversals } : {}),
    };
    if (!availableOptions(d, at).length) {
      expireStep(d, at, 'options_expired', opened.id, c);
      return { decision: opened, events: c.out };
    }
    if (v.preCommit === 'go') {
      // An adopted plan (research R13): he already said yes in the chat. No Jev;
      // the engine leans on go (p = 1) and commits it, locked from here on.
      if (!availableOptions(d, at).some(o => o.id === 'go')) {
        expireStep(d, at, 'options_expired', opened.id, c);
        return { decision: opened, events: c.out };
      }
      const leanEv = c.append({
        type: 'decision.lean', at, actor: 'engine', causeId: opened.id, ...subjectOf(d),
        payload: { decisionId: d.id, optionId: 'go', p: 1, probs: { go: 1 }, trigger: 'new_info' },
      });
      c.out.push(leanEv);
      const v0 = s?.vitals || {};
      d.lean = {
        optionId: 'go', p: 1, probs: { go: 1 }, at, by: 'engine', trigger: 'new_info', fallback: null,
        state: { energy: v0.energy, stress: v0.stress, sick: v0.sick === true }, rain: s?.weather?.rain === true, eventId: leanEv.id,
      };
      d.leans = 1;
      commitStep(d, s, at, { optionId: 'go', p: 1, sampled: false, causeId: leanEv.id, by: 'adopted' }, c);
      return { decision: opened, events: c.out };
    }
    const lean = await leanStep(d, s, at, { trigger: 'new_info', causeId: opened.id }, c);
    if (lean) afterLean(d, s, at, lean, c);
    if (d.status === 'open' && at >= d.decideBy) deadlineCommit(d, s, at, c);
    return { decision: opened, events: c.out };
  });
}

// ── Evaluate (pulse) ──────────────────────────────────────────────────────

/**
 * Pulse step 5 for every open/committed decision at ctx.at: expire what ran
 * out, ask Jev once on any due trigger, commit early or reverse after that
 * lean, and commit by sampling at decideBy. ctx.newEvents = events appended
 * since the previous evaluation (for new_info). No trigger → no Jev call.
 * Per-decision errors are logged and skipped. Returns { events }.
 */
export function evaluate(state, ctx = {}) {
  return serialized(async () => {
    const s0 = resolve(state);
    const world = ctx.world;
    const c = makeCtx(ctx, s0, world);
    const at = c.at;
    if (!(s0?.decisions instanceof Map)) return { events: c.out };
    const ids = [...s0.decisions.keys()].sort((a, b) => a - b);
    // One view per projection: decisions that appended nothing share it (a
    // view is read-only here; any append yields a new projection object).
    let memo = null;
    for (const id of ids) {
      try {
        // Closed decisions stay in the projection for days: skip them before
        // paying for a view (a view never changes a decision's status).
        const cur = resolve(state);
        const st = cur?.decisions?.get?.(id)?.status;
        if (st !== 'open' && st !== 'committed') continue;
        if (memo?.src !== cur) memo = { src: cur, view: viewOf(cur, at, world) };
        const s = memo.view;
        const d = decisionCopy(s, id);
        if (!d || (d.status !== 'open' && d.status !== 'committed')) continue;
        if (d.status === 'open' && !availableOptions(d, at).length) {
          // A tick that jumped past both decideBy and every expiry (catch-up)
          // commits what a live run would have at decideBy; else nothing is left.
          if (finite(d.decideBy) && at >= d.decideBy && availableOptions(d, d.decideBy).length) {
            deadlineCommit(d, s, at, c);
          } else {
            const last = Math.max(...d.options.map(o => o.expiresAt).filter(finite));
            expireStep(d, finite(last) ? Math.min(at, last) : at, 'options_expired', d.lean?.eventId ?? d.id, c);
          }
          continue;
        }
        const due = detectTriggers(d, s, { at, newEvents: ctx.newEvents, world });
        if (due.length) {
          const [first, ...rest] = due;
          const lean = await leanStep(d, s, at, { ...first, also: rest.map(t => t.trigger) }, c);
          if (lean) afterLean(d, s, at, lean, c);
        }
        if (d.status === 'open' && finite(d.decideBy) && at >= d.decideBy) deadlineCommit(d, s, at, c);
      } catch (err) {
        logger.warn({ err: err?.message, decisionId: id }, 'life decisions: evaluation failed');
      }
    }
    return { events: c.out };
  });
}

// ── Chat mention ──────────────────────────────────────────────────────────

/**
 * A chat message (already audience-checked by the facade) may mention a live
 * decision. For each decision the code matcher hits (and not within the chat
 * cooldown), append an inert `chat.trigger {decisionId, toward}` (actor chat,
 * the chat's origin) and take one lean caused by it — the lean and anything it
 * causes inherit the chat's origin. The text itself is never stored or sent.
 * msg: { text, originKind: 'group'|'dm'|'call'|'ig', originJid }.
 * Returns { events, matched: [decisionId] }.
 */
export function noteChat(state, msg = {}, ctx = {}) {
  return serialized(async () => {
    const s0 = resolve(state);
    const world = ctx.world;
    const c = makeCtx(ctx, s0, world);
    const at = c.at;
    const matched = [];
    const { text, originKind, originJid, msgId } = msg || {};
    if (typeof text !== 'string' || !text.trim() || !CHAT_KINDS.has(originKind) || !isValidOrigin(originKind, originJid)) {
      return { events: c.out, matched };
    }
    if (!(s0?.decisions instanceof Map)) return { events: c.out, matched };
    const ids = [...s0.decisions.keys()].sort((a, b) => a - b);
    // One view per projection: decisions that appended nothing share it (a
    // view is read-only here; any append yields a new projection object).
    let memo = null;
    for (const id of ids) {
      try {
        // Closed decisions stay in the projection for days: skip them before
        // paying for a view (a view never changes a decision's status).
        const cur = resolve(state);
        const st = cur?.decisions?.get?.(id)?.status;
        if (st !== 'open' && st !== 'committed') continue;
        if (memo?.src !== cur) memo = { src: cur, view: viewOf(cur, at, world) };
        const s = memo.view;
        const d = decisionCopy(s, id);
        if (!d || (d.status !== 'open' && d.status !== 'committed')) continue;
        if (neverRethought(d)) continue; // the owner's plan or a goal's outing: no chat lean, no Jev spend
        if (d.status === 'committed' && (!finite(d.ponrAt) || at >= d.ponrAt || (d.reversals || 0) >= reversalCap(d) || hasSetOff(d, s, at))) continue;
        if (!availableOptions(d, at).length) continue;
        const last = d.signals?.length ? d.signals[d.signals.length - 1].at : null;
        if (finite(last) && at - last < CHAT_COOLDOWN_SEC) continue;
        const hit = matchChat(d, text, s);
        if (!hit) continue;
        const toward = hit.toward && availableOptions(d, at).some(o => o.id === hit.toward) ? hit.toward : null;
        // 020: on a promise, a chat lean only when the line pushes against it (else it can change nothing: no Jev spend).
        if (oneBeingOn() && d.status === 'committed' && planWeight(d) === WEIGHT.promise && (!toward || toward === d.committed?.optionId)) continue;
        const trig = c.append({
          type: 'chat.trigger', at, actor: 'chat', causeId: d.id, originKind, originJid,
          // 020: the line it came from (codes only): a revoke or a forget of that line takes back what it caused.
          payload: { decisionId: d.id, toward, ...(oneBeingOn() && typeof msgId === 'string' && msgId ? { msgId: msgId.slice(0, 128) } : {}) },
        });
        c.out.push(trig);
        d.signals = [...(d.signals || []), { at, toward, eventId: trig.id }];
        matched.push(d.id);
        const lean = await leanStep(d, s, at, { trigger: 'chat_mention', causeId: trig.id, pushed: toward }, c);
        if (lean) afterLean(d, s, at, lean, c);
        if (d.status === 'open' && finite(d.decideBy) && at >= d.decideBy) deadlineCommit(d, s, at, c);
      } catch (err) {
        logger.warn({ err: err?.message, decisionId: id }, 'life decisions: chat trigger failed');
      }
    }
    return { events: c.out, matched };
  });
}

// ── Owner / caller operations ─────────────────────────────────────────────

/** Owner sets a decision's mode ('auto'|'ask'): decision.mode_set, actor owner. Stored for 010. */
export function setMode(state, id, mode, { at, append = appendEvent, by = 'owner' } = {}) {
  if (!MODES.has(mode)) fail(`mode must be auto or ask`);
  if (!Number.isInteger(at)) fail('at must be integer unix seconds');
  const d = resolve(state)?.decisions?.get?.(id);
  if (!d) fail(`unknown decision ${id}`);
  const who = cleanLabel(typeof by === 'string' ? by : 'owner', 'owner').slice(0, 64);
  return append({ type: 'decision.mode_set', at, actor: 'owner', causeId: d.id, payload: { decisionId: d.id, mode, by: who } });
}

function ownerError(code, msg) {
  return Object.assign(new Error(`decisions: ${msg}`), { code });
}

/**
 * The owner picks an option on an "Ask me" card (010, research R14 item 3).
 * Serialized with evaluate/noteChat, so against the pulse's deadline commit
 * exactly one commit wins. Re-reads the decision: not found → code
 * 'not_found'; not open or the option no longer available → 'expired'; bad
 * option id → 'invalid'. Appends decision.committed {optionId, by:'owner'},
 * actor owner, caused by the decision. ctx: { at, append?, by? (operator
 * label) }. Resolves to the appended event.
 */
export function ownerCommit(state, id, optionId, { at, append = appendEvent, by = 'owner' } = {}) {
  return serialized(async () => {
    if (!Number.isInteger(at)) throw ownerError('invalid', 'at must be integer unix seconds');
    if (typeof optionId !== 'string' || !OPTION_ID_RE.test(optionId)) throw ownerError('invalid', 'bad option id');
    const d = resolve(state)?.decisions?.get?.(id);
    if (!d) throw ownerError('not_found', `unknown decision ${id}`);
    if (d.status !== 'open') throw ownerError('expired', `decision ${id} is ${d.status}`);
    if (!d.options.some(o => o.id === optionId)) throw ownerError('invalid', `decision ${id} has no option ${optionId}`);
    if (!availableOptions(d, at).some(o => o.id === optionId)) throw ownerError('expired', `option ${optionId} is no longer available`);
    const who = cleanLabel(typeof by === 'string' ? by : 'owner', 'owner').slice(0, 64);
    const ev = append({
      type: 'decision.committed', at, actor: 'owner', causeId: d.id, ...subjectOf(d),
      payload: { decisionId: d.id, optionId, sampled: false, by: 'owner', operator: who },
    });
    return ev;
  });
}

// ── 012 invitations (spec 012 plan §P2.4) ─────────────────────────────────

export const INVITE_ANSWERS = Object.freeze(['yes', 'late', 'no', 'maybe']);

/**
 * His reply answered an invitation (influence layer, after classifying it).
 * Serialized with evaluate/noteChat/ownerCommit, so exactly one commit wins.
 * Only an open invitation he hasn't answered yet, or one he answered "maybe"
 * (a later yes / late / no supersedes it; the projector keeps the latest): re-checks the owner's
 * controls first (ctx.controls() → {ok, reason}; a social freeze or a Director
 * pause since it opened → decision.expired {frozen|paused}, nothing else), then
 * appends `invite.answered` (caused by the decision) and: yes → commit go
 * `by:'reply'` (late when go is gone, nothing when neither is), late → late,
 * no → stay, maybe → nothing more (it leans on like any decision).
 * ctx: { at, world, append?, p?, controls? }. → { events } (null when not answerable)
 */
export function answerInvite(state, id, answer, ctx = {}) {
  return serialized(async () => {
    if (!INVITE_ANSWERS.includes(answer)) fail('answer must be yes|late|no|maybe');
    const s0 = resolve(state);
    const world = ctx.world;
    const c = makeCtx(ctx, s0, world);
    const at = c.at;
    const d = decisionCopy(s0, id);
    // Unanswered, or a "maybe" that a later yes / late / no settles (a second maybe changes nothing).
    if (!d || d.invite !== true || d.status !== 'open') return null;
    if (d.inviteAnswer && !(d.inviteAnswer === 'maybe' && answer !== 'maybe')) return null;
    let verdict = { ok: true };
    try { verdict = typeof ctx.controls === 'function' ? (ctx.controls() || { ok: false }) : { ok: true }; } catch { verdict = { ok: false, reason: 'invalid' }; }
    if (verdict.ok !== true) {
      expireStep(d, at, verdict.reason === 'paused' ? 'paused' : 'frozen', d.id, c);
      return { events: c.out };
    }
    const p = finite(ctx.p) ? Math.round(clamp(ctx.p, 0, 1) * 100) / 100 : null;
    const answered = c.append({
      type: 'invite.answered', at, actor: 'engine', causeId: d.id, ...subjectOf(d),
      payload: { decisionId: d.id, answer, ...(p !== null ? { p } : {}) },
    });
    c.out.push(answered);
    d.inviteAnswer = answer;
    const avail = new Set(availableOptions(d, at).map(o => o.id));
    const pick = answer === 'yes' ? (avail.has('go') ? 'go' : avail.has('late') ? 'late' : null)
      : answer === 'late' ? (avail.has('late') ? 'late' : null)
        : answer === 'no' ? (avail.has('stay') ? 'stay' : null) : null;
    if (pick) {
      const s = scoped(viewOf(s0, at, world), d);
      commitStep(d, s, at, { optionId: pick, p: p ?? 1, sampled: false, causeId: answered.id, by: 'reply' }, c);
    }
    return { events: c.out };
  });
}

/**
 * The inviter called it off (influence layer, after the inviter's own `cancel`
 * pointer in the same chat). Serialized; ignores 009's chat cooldown. Open → one
 * lean pushed to stay, caused by the pointer (so reverting it cascades the lean
 * and anything after it); committed to go/late before the point of no return →
 * decision.expired {reason:'inviter_cancelled'} caused by the pointer.
 * ctx: { at, world, append?, pointerId, originKind, originJid }. → { events } | null
 */
export function cancelInvite(state, id, ctx = {}) {
  return serialized(async () => {
    const s0 = resolve(state);
    const world = ctx.world;
    const c = makeCtx(ctx, s0, world);
    const at = c.at;
    const d = decisionCopy(s0, id);
    if (!d || d.invite !== true || !Number.isSafeInteger(ctx.pointerId)) return null;
    if (d.status === 'committed') {
      const going = d.committed?.optionId === 'go' || d.committed?.optionId === 'late';
      if (!going || !finite(d.ponrAt) || at >= d.ponrAt) return null;
      const ev = c.append({
        type: 'decision.expired', at, actor: 'engine', causeId: ctx.pointerId,
        payload: { decisionId: d.id, reason: 'inviter_cancelled' },
      });
      c.out.push(ev);
      return { events: c.out };
    }
    if (d.status !== 'open' || !CHAT_KINDS.has(ctx.originKind) || !isValidOrigin(ctx.originKind, ctx.originJid)) return null;
    const stay = availableOptions(d, at).some(o => o.id === 'stay') ? 'stay' : null;
    // No chat.trigger of its own: the lean (and an early commit after it) hangs
    // off the cancel pointer, so reverting that pointer (a forget / revoke /
    // edit of the cancel) cascades them — a chat-actor trigger would stop the
    // cascade. The pointer already carries the chat's origin.
    const s = viewOf(s0, at, world);
    const lean = await leanStep(d, s, at, { trigger: 'chat_mention', causeId: ctx.pointerId, pushed: stay }, c);
    if (lean) afterLean(d, s, at, lean, c);
    return { events: c.out };
  });
}

/** Call off an open decision (the plan fell through): decision.expired {reason:'cancelled'}. Null if not open. */
export function cancelDecision(state, id, { at, append = appendEvent, causeId = null } = {}) {
  if (!Number.isInteger(at)) fail('at must be integer unix seconds');
  const d = resolve(state)?.decisions?.get?.(id);
  if (!d || d.status !== 'open') return null;
  return append({ type: 'decision.expired', at, actor: 'engine', causeId: causeId ?? d.id, payload: { decisionId: d.id, reason: 'cancelled' } });
}
