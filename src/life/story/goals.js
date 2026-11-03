// Soft goals (spec 011 Phase 2, plan §P2.3, review R8/R18/R19/R23/R27): the
// owner says "he should see X / call home / get out / run an errand this week";
// the engine fits it into a free slot of his day. Pure over the projection
// (state.goals, folded by projector.js HANDLERS_011): goalItems() offers the
// pulse at most one item per goal, each appending at least one event (010's
// never-stalling rule), keyed by goal id + date so a retry never repeats.
//
//   expire  open, g ≥ goal.to                        → goal.expired (cause goal.set)
//   fit     open, once per local date (lastTry.date ≠ today), awake with today's
//           plan, at max(wake + 30 min, goal.from, s.at) → exactly one of
//             goal.fitted + decision.opened {goalId} + lean go p 1 + committed
//               by:'goal'   (meet / outing / errand; the pulse's committed-evening
//               path rewrites the evening at the point of no return)
//             goal.fitted {slotStart}   (call: the call happens at the slot)
//             goal.deferred {reason}    paused | frozen | pinned | sick | heavy |
//               away | tired | no_place | no_slot
//   block   fitted, committed, before ponrAt, and sick / a heavy stretch / paused /
//           the category frozen → decision.expired {reason} (the projector closes
//           the decision and reopens the goal for another day, R8)
//   call    fitted call at slotStart: the controls re-checked → family.call
//           {goalId} + goal.done, or goal.deferred (reopens it)
//   done    fitted outing whose committed decision has ended → goal.done
//   lost    fitted outing whose decision is gone (rewound) → goal.deferred {rewound} (reopens)
//
// Slots (R18): today's free windows (availability.freeWindows) clipped to
// [max(now, goal.from), min(goal.to, bedtime − 30 min)]; meet / outing / call
// prefer windows from 17:00 local. A call fits inside one window. An outing
// starts ≥ window start + travel + prep, so he is free at its point of no return
// (inside the window); from there the pulse rewrites his evening as for any
// committed outing, so it only has to end by the clipped bound with no work,
// meeting, office commute or sleep before it is over (+ the trip back). A slot
// overlapping another open / committed decision is skipped. Energy and
// social battery are base vitals, never the chat overlay (R23). Places: the
// goal's own, else a leisure place picked on rngFor(date, 'goal:place:<id>'), or
// for an errand the nearest shop to home.
import { dateKey, dayStart, localParts } from '../clock.js';
import { rngFor as rngForDefault } from '../rng.js';
import { freeWindows } from '../availability.js';
import { vitalsAt } from '../projector.js';
import { blockAt } from '../routine.js';
import { haversineKm } from '../travel.js';
import { check as controlsCheck, isPaused, fateOf, pinOf } from './controls.js';
import { heavyGuardActive } from './reducer.js';
import { familyMembers } from './family.js';
import { outingDecisionPayload, OutingError } from './outing.js';
import { hasSchedule, activeRanges } from '../planEdits.js';   // 014 sched

const MIN = 60;
const HOUR = 3600;
export const FIT_AFTER_WAKE_MIN = 30;
export const ENERGY_MIN = 35;
export const CALL_ENERGY_MIN = 15;
export const SOCIAL_MIN = 25;
export const EVENING_FROM_MIN = 17 * 60;
const SLEEP_MARGIN = 30 * MIN;
const SLOT_STEP = 15 * MIN;
const LEISURE_KINDS = new Set(['cafe', 'restaurant', 'pub', 'bar', 'park', 'cinema', 'mall']);
const ERRAND_KINDS = new Set(['shop', 'market', 'supermarket', 'pharmacy', 'bank', 'post']);
const DECISION_KIND = { meet: 'hangout', outing: 'outing', errand: 'errand' };
const BLOCK_REASONS = ['paused', 'frozen', 'sick', 'heavy'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const ceilStep = (t) => Math.ceil(t / SLOT_STEP) * SLOT_STEP;
const tzOf = (s, world) => s?.world?.timezone || world?.timezone;

/** Goals the pulse still works on (open or fitted), oldest first. */
export function activeGoals(s) {
  return Object.values(isObj(s?.goals) ? s.goals : {})
    .filter(g => isObj(g) && (g.status === 'open' || g.status === 'fitted')).sort((a, b) => a.id - b.id);
}

function categoryFor(goal) {
  return goal.goalKind === 'call' ? 'family' : 'social';
}

/** Why the controls / his state block this goal right now, or null. */
function blockedBy(s, goal, at, world, { forFit = true } = {}) {
  if (isPaused(s)) return 'paused';
  if (fateOf(categoryFor(goal), s) === 'frozen') return 'frozen';
  if (goal.castId && pinOf(goal.castId, s)) return 'pinned';
  if (s.sick || s.vitals?.sick === true) return 'sick';
  if (heavyGuardActive(s, at)) return 'heavy';
  if (!forFit) return null;
  const away = goal.castId ? s.story?.castLife?.[goal.castId]?.away : null;
  if (finite(away?.until) && away.until > at) return 'away';
  let v = null;
  try { v = vitalsAt(s, at, world, { chatMood: false }); } catch { v = s.vitals; }
  const energyMin = goal.goalKind === 'call' ? CALL_ENERGY_MIN : ENERGY_MIN;
  if (finite(v?.energy) && v.energy < energyMin) return 'tired';
  if (goal.goalKind !== 'call' && goal.goalKind !== 'errand' && finite(v?.socialBattery) && v.socialBattery < SOCIAL_MIN) return 'tired';
  return null;
}

function placeFor(s, goal, date, rf) {
  const places = s.places instanceof Map ? s.places : new Map();
  if (goal.placeId) return places.has(goal.placeId) ? goal.placeId : null;
  const home = s.self?.homePlaceId ?? null;
  const all = [...places.values()].filter(p => p?.id && p.id !== home).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (goal.goalKind === 'errand') {
    const h = places.get(home);
    const shops = all.filter(p => ERRAND_KINDS.has(p.kind) && finite(p.lat) && finite(p.lon));
    if (!shops.length) return null;
    if (!h) return shops[0].id;
    return shops.map(p => [p, haversineKm(h, p)]).sort((a, b) => a[1] - b[1] || (a[0].id < b[0].id ? -1 : 1))[0][0].id;
  }
  const pool = all.filter(p => LEISURE_KINDS.has(p.kind));
  return pool.length ? rf(date, `goal:place:${goal.id}`).pick(pool).id : null;
}

function castFor(s, goal, at) {
  if (goal.castId) return [goal.castId];
  if (goal.goalKind !== 'call') return [];
  const free = familyMembers(s).filter((id) => {
    const away = s.story?.castLife?.[id]?.away;
    return !(finite(away?.until) && away.until > at) && !pinOf(id, s);
  }).sort();
  return free.length ? [free[0]] : null;
}

function busySpans(s) {
  const out = [];
  for (const d of s.decisions instanceof Map ? s.decisions.values() : []) {
    if ((d?.status !== 'open' && d?.status !== 'committed') || !finite(d.subject?.eventAt)) continue;
    const end = d.options?.find?.(o => o.id === 'late')?.expiresAt ?? d.subject.endAt ?? d.subject.eventAt + 2 * HOUR;
    out.push([d.subject.eventAt - (finite(d.ponrAt) ? Math.max(0, d.subject.eventAt - d.ponrAt) : HOUR), end]);
  }
  // 014 sched (R21): an owner override's ranges are busy too.
  if (hasSchedule(s)) for (const r of activeRanges(s)) out.push([r.from, r.to]);
  return out;
}

/**
 * Where today has room for `goal` from `at` (pure). → { ok:true, kind, slotStart,
 * slotEnd, placeId, castIds, payload? } | { ok:false, reason }
 */
export function fitToday(s, at, world, goal, { rngFor = rngForDefault, decisionRef = null } = {}) {
  const tz = tzOf(s, world);
  const date = dateKey(at, tz);
  const blocked = blockedBy(s, goal, at, world);
  if (blocked) return { ok: false, reason: blocked };
  const castIds = castFor(s, goal, at);
  if (castIds === null) return { ok: false, reason: 'away' };
  const placeId = goal.goalKind === 'call' ? null : placeFor(s, goal, date, rngFor);
  if (goal.goalKind !== 'call' && !placeId) return { ok: false, reason: 'no_place' };
  const plan = s.plan;
  if (!plan || plan.date !== date) return { ok: false, reason: 'no_slot' };
  const minutes = Number.isInteger(goal.minutes) ? goal.minutes : 60;
  const lo = Math.max(at, goal.from);
  const hi = Math.min(goal.to, finite(plan.sleepAt) ? plan.sleepAt - SLEEP_MARGIN : goal.to);
  // A call needs the whole slot free; an outing needs him free at its point of no
  // return (the pulse then rewrites the rest of the evening, as for any outing),
  // and nothing fixed — work, a meeting, the office commute, sleep — before it ends.
  const call = goal.goalKind === 'call';
  let wins = [];
  try { wins = freeWindows(s, dayStart(at, tz), world, { minMinutes: call ? minutes + 30 : 15 }); } catch { wins = []; }
  wins = wins.map(w => ({ from: Math.max(w.from, lo), to: Math.min(w.to, hi) })).filter(w => w.to - w.from >= (call ? minutes + 30 : 15) * MIN);
  const office = s.self?.officePlaceId ?? null;
  const fixed = (plan.blocks || []).filter(b => ['work', 'meeting', 'sleep'].includes(b.kind)
    || (b.kind === 'commute' && office && (b.to === office || b.from === office)));
  const overFixed = (a, b) => fixed.some(x => a < x.end && x.start < b);
  const evening = (t) => { const p = localParts(t, tz); return p.hour * 60 + p.minute >= EVENING_FROM_MIN; };
  if (goal.goalKind !== 'errand') wins.sort((a, b) => (evening(b.from) - evening(a.from)) || a.from - b.from);
  const busy = busySpans(s);
  const clashes = (a, b) => busy.some(([x, y]) => a < y && x < b);
  for (const w of wins) {
    if (goal.goalKind === 'call') {
      const slotStart = ceilStep(w.from);
      const slotEnd = slotStart + minutes * MIN;
      if (slotEnd > w.to || clashes(slotStart, slotEnd)) continue;
      return { ok: true, kind: 'call', slotStart, slotEnd, placeId: null, castIds };
    }
    const from = blockAt(plan, w.from)?.placeId ?? s.self?.homePlaceId ?? null;
    // 016: a scene's follow-up fits like a meet goal; its decision names the follow-up instead.
    const ref = decisionRef && typeof decisionRef === 'object' ? decisionRef : { goalId: goal.id };
    const spec = (startAt) => ({ placeId, castIds, startAt, minutes, label: goal.label ?? null, kind: DECISION_KIND[goal.goalKind], ...ref, from });
    let payload;
    try {
      let startAt = ceilStep(w.from + HOUR);
      payload = outingDecisionPayload({ state: s, now: at, world }, spec(startAt));
      const need = w.from + (payload.travelMin + payload.prepMin) * MIN;
      if (startAt < need || payload.ponrAt < w.from) {
        startAt = ceilStep(Math.max(need, startAt + (w.from - payload.ponrAt)));
        payload = outingDecisionPayload({ state: s, now: at, world }, spec(startAt));
      }
      if (payload.ponrAt < w.from || payload.ponrAt < at) continue;
    } catch (e) {
      if (e instanceof OutingError) continue;
      throw e;
    }
    const slotStart = payload.subject.eventAt;
    const slotEnd = payload.subject.endAt;
    if (slotEnd > hi || payload.ponrAt >= w.to || clashes(payload.ponrAt, slotEnd) || overFixed(payload.ponrAt, slotEnd + payload.travelMin * MIN)) continue;
    return { ok: true, kind: DECISION_KIND[goal.goalKind], slotStart, slotEnd, placeId, castIds, payload };
  }
  return { ok: false, reason: 'no_slot' };
}

/**
 * 016 (plan §P2.2): the same slot logic for a scene's follow-up meet — `slot` =
 * { id, castId, placeId, from, to, minutes?, label? }; the decision payload carries
 * `followupId` instead of `goalId`. → fitToday's result.
 */
export function fitSlot(s, at, world, slot, { rngFor = rngForDefault } = {}) {
  const goal = { id: slot.id, goalKind: 'meet', castId: slot.castId ?? null, placeId: slot.placeId ?? null,
    from: slot.from, to: slot.to, minutes: Number.isInteger(slot.minutes) ? slot.minutes : 120, label: slot.label ?? null };
  return fitToday(s, at, world, goal, { rngFor, decisionRef: { followupId: slot.id } });
}

/** The pulse items for every active goal (story/index.js collects them; sim:true honoured — nothing here writes). */
export function goalItems(s, g, d = {}) {
  const world = d.world;
  const rf = typeof d.rngFor === 'function' ? d.rngFor : rngForDefault;
  const tz = tzOf(s, world);
  const out = [];
  const sAt = finite(s?.at) ? s.at : g;
  for (const goal of activeGoals(s)) {
    if (goal.status === 'open') {
      if (g >= goal.to) {
        const at = Math.max(goal.to, sAt);
        if (at <= g) out.push(item(`goal:expire:${goal.id}`, at, 'goal:expire', goal.id, (add) => {
          add({ type: 'goal.expired', at, actor: 'engine', causeId: goal.id, payload: { goalId: goal.id, reason: 'window_passed' } });
        }));
        continue;
      }
      const plan = s.plan;
      if (s.activity?.kind === 'sleep' || !plan || !finite(plan.wakeAt)) continue;
      const at = Math.max(plan.wakeAt + FIT_AFTER_WAKE_MIN * MIN, goal.from, sAt);
      if (at > g || at >= goal.to) continue;
      const date = dateKey(at, tz);
      if (plan.date !== date || goal.lastTry?.date === date) continue;
      out.push(item(`goal:fit:${goal.id}:${date}`, at, 'goal:fit', goal.id, (add) => {
        const fit = fitToday(s, at, world, goal, { rngFor: rf });
        if (!fit.ok) {
          add({ type: 'goal.deferred', at, actor: 'engine', causeId: goal.id, payload: { goalId: goal.id, date, reason: fit.reason } });
          return;
        }
        const fitted = add({
          type: 'goal.fitted', at, actor: 'engine', causeId: goal.id,
          payload: { goalId: goal.id, date, slotStart: fit.slotStart, slotEnd: fit.slotEnd, placeId: fit.placeId, castIds: fit.castIds },
        });
        if (!fit.payload) return;   // a call: it happens at the slot
        const opened = add({ type: 'decision.opened', at, actor: 'engine', causeId: fitted.id, payload: fit.payload });
        const lean = add({
          type: 'decision.lean', at, actor: 'engine', causeId: opened.id,
          payload: { decisionId: opened.id, optionId: 'go', p: 1, probs: { go: 1 }, trigger: 'new_info' },
        });
        add({
          type: 'decision.committed', at, actor: 'engine', causeId: lean.id,
          payload: { decisionId: opened.id, optionId: 'go', p: 1, sampled: false, by: 'goal' },
        });
      }));
      continue;
    }
    // fitted
    const f = goal.fitted;
    if (!f) continue;
    if (goal.goalKind === 'call') {
      if (!finite(f.slotStart) || f.slotStart > g) continue;
      const at = Math.max(f.slotStart, sAt);
      if (at > g) continue;
      out.push(item(`goal:call:${goal.id}:${f.eventId}`, at, 'goal:call', goal.id, (add) => {
        const why = blockedBy(s, goal, at, world, { forFit: false });
        const castId = f.castIds?.[0] ?? null;
        const v = castId ? controlsCheck({ source: 'engine', category: 'family', action: 'beat', pinKeys: [castId] }, s) : { ok: false, reason: 'away' };
        const reason = why ?? (v.ok ? null : (v.reason === 'pinned' ? 'pinned' : v.reason === 'frozen' ? 'frozen' : 'paused'));
        if (reason || !s.cast?.has?.(castId)) {
          add({ type: 'goal.deferred', at, actor: 'engine', causeId: goal.id, payload: { goalId: goal.id, date: dateKey(at, tz), reason: reason ?? 'away' } });
          return;
        }
        const next = s.story?.family?.nextCallAt;
        add({
          type: 'family.call', at, actor: 'engine', causeId: f.eventId,
          payload: { castId, themeId: null, intensity: 0.1, minutes: goal.minutes ?? 20, pressure: 0, ...(finite(next) ? { nextCallAt: next } : {}), goalId: goal.id },
        });
        add({ type: 'goal.done', at, actor: 'engine', causeId: f.eventId, payload: { goalId: goal.id } });
      }));
      continue;
    }
    const dec = Number.isSafeInteger(f.decisionId) && s.decisions instanceof Map ? s.decisions.get(f.decisionId) : null;
    // Fitted, but its decision is gone (a rewind took it out, or it never opened):
    // it did not happen — reopen for another day rather than call it done.
    if (!dec) {
      const at = sAt;
      if (at <= g) out.push(item(`goal:lost:${goal.id}:${f.eventId}`, at, 'goal:lost', goal.id, (add) => {
        add({ type: 'goal.deferred', at, actor: 'engine', causeId: goal.id, payload: { goalId: goal.id, date: dateKey(at, tz), reason: 'rewound' } });
      }));
      continue;
    }
    if (dec && dec.status === 'committed' && finite(dec.ponrAt) && sAt < dec.ponrAt) {
      const why = blockedBy(s, goal, sAt, world, { forFit: false });
      if (why && BLOCK_REASONS.includes(why) && sAt <= g) {
        out.push(item(`goal:block:${goal.id}:${dec.id}`, sAt, 'goal:block', goal.id, (add) => {
          add({ type: 'decision.expired', at: sAt, actor: 'engine', causeId: dec.id, payload: { decisionId: dec.id, reason: why } });
        }));
        continue;
      }
    }
    const endAt = dec.subject?.endAt ?? f.slotEnd;
    if (dec.status === 'committed' && finite(endAt) && endAt <= g) {
      const at = Math.max(endAt, sAt);
      if (at <= g) out.push(item(`goal:done:${goal.id}`, at, 'goal:done', goal.id, (add) => {
        add({ type: 'goal.done', at, actor: 'engine', causeId: f.eventId, payload: { goalId: goal.id } });
      }));
    }
  }
  return out;
}

function item(key, at, label, id, run) {
  return { key, at, prio: 9, label, id, run };
}
