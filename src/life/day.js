// Life · Day (dashboard #life/day): one local day read top to bottom like a
// diary — what happened (the log), where he is now, and what the rest of
// today / tomorrow most likely holds. Read only, imported by the life facade
// alone (dayView); the dashboard route adds chat and mind counts.
//
// Past: the day's events (reverted / rewound ones left out) become spans
// (activity / trip / sleep, as the Timeline walks them) and ticks (wake,
// meals, phone checks, weather, decisions, story moments, owner and chat
// pointers); any type this module doesn't know is a neutral tick with its
// type, so a later spec's events show up without a change here. Vitals come
// from a read-only fold (projector.vitalsSeries).
//
// Future: N runs of the preview-tomorrow simulation (story facade simulate:
// no model calls, nothing written) over one horizon, now → the end of
// tomorrow, shared by both days. Runs differ only in the decisions' deadline
// sample (run 0 keeps the install seed's roll, runs 1… a generator of their
// own); his routine, the weather and the story's date-keyed rolls are what the
// live pulse will roll, so the odds are "how he might decide", not "what
// might happen to him". The rows shown are the modal run's (the most common
// sequence of spans); decisions carry outcome odds over all runs (a "not
// opened" bucket keeps every distribution summing to 1). N stops early at a
// CPU budget; results are cached per lastEventId (a new event recomputes at
// most once a minute), one computation at a time. With the story layer off:
// 009's day plan (today's plan, routine.planDay for tomorrow) and the
// weather forecast, no odds, no projected vitals.
//
// Tonight (sched-fixes): today's view after 18:00 local also carries `tonight`
// — the hours past midnight up to his next wake (≥ 6 h) from the same
// projection (or today's plan, which runs into tomorrow) and the plans set for
// then — so an outing at 00:15 is visible from today's page.

import { logger } from '../utils/logger.js';
import { dateKey, dayStart, addDays, zonedToUnix, hourOfDay } from './clock.js';
// 014 geo (§A7): negative rows word a real venue by its kind.
import { placeLabel, isNegativeEvent, negativeLabel } from './places.js';
import { makeRng, mulberry32, hashString, getRngSeed } from './rng.js';
import { forecast } from './weather.js';
import { planDay } from './routine.js';
import { availabilityAt, gateProbabilities } from './availability.js';
import { vitalsSeries, advanceTo } from './projector.js';
import { planBlockDecision } from './eventLog.js';

export const DAY_RUNS = 20;            // projection runs (max)
export const DAY_MIN_RUNS = 6;         // …kept even past the budget
export const DAY_BUDGET_MS = 1500;     // CPU budget of one projection
export const SAMPLE_SEC = 1800;        // vitals grid (30 min)
export const RECOMPUTE_MIN_MS = 60_000;      // a changed log recomputes at most this often
export const CACHE_MAX_MS = 15 * 60_000;     // an unchanged log keeps its projection this long
export const PROJECTIONS_PER_MIN = 12;       // hard bound on fresh projections
const PAST_CACHE_MS = 5 * 60_000;
const PAST_CACHE_MAX = 16;
const DAY = 86400;
const LOOKBACK_SEC = 36 * 3600;        // a span in force at midnight began the day before
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);
const DETAIL_MAX = 80;
// sched-fixes: today's page after this local hour also shows tonight past midnight.
export const TONIGHT_FROM_HOUR = 18;
const TONIGHT_MIN_SEC = 6 * 3600;      // at least 6 h past midnight…
const TONIGHT_MAX_SEC = 14 * 3600;     // …up to his next wake, at most 14 h

const SPAN_STARTS = new Set(['activity.started', 'travel.started', 'sleep.started']);
const SPAN_ENDS = new Set(['activity.ended', 'travel.arrived', 'woke', 'world.reanchored']);
// Folded elsewhere (spans, phone rows, decision rows, sparkline) or pure bookkeeping.
const QUIET = new Set([
  'activity.ended', 'travel.arrived', 'plan.made', 'vitals.checkpoint', 'story.daily_done', 'decision.lean',
  'phone.check.ended', 'place.created', 'cast.created', 'availability.changed',
  'mood.chat', // 012: its chat.perceived pointer is the row (the page labels it from the influence lane)
  'chat.load', // 012: counts only, folded into the vitals sparkline
  'wallet.started', // 018: the wallet's cut-over (bookkeeping)
  'scene.played', 'scene.regenerated', // 016: folded into the outing's span (span.scene), not a row
]);
const STORY = new Set([
  'cast.beat', 'cast.updated', 'cast.history_added', 'relationship.changed', 'arc.started', 'arc.stage', 'arc.ended',
  'family.call', 'family.occasion', 'birthday', 'career.appraisal', 'career.hunt', 'career.resigned', 'career.job_changed',
  'heavy.proposed', 'heavy.vetoed', 'heavy.lapsed', 'heavy.started', 'heavy.ended', 'claim.adopted', 'claim.withdrawn',
  'activity.recorded', 'commitment.recorded',
  'scene.followup', 'scene.followup_lapsed', // 016: "planning to see … again"
  'dream.had', // 020 G: at his wake
]);
const CATEGORY = {
  woke: 'wake', 'world.reanchored': 'wake', meal: 'meal', 'weather.changed': 'weather',
  'money.spent': 'money', 'money.salary': 'money', 'work.late': 'work', 'work.crunch': 'work',
  'sick.started': 'health', 'sick.ended': 'health', 'embargo.started': 'health', 'embargo.ended': 'health',
  'decision.committed': 'decision', 'decision.expired': 'decision', 'decision.reversed': 'decision', 'decision.mode_set': 'decision',
  'chat.trigger': 'chat', 'claim.flagged': 'chat', 'call.answered': 'chat', 'event.reverted': 'owner', genesis: 'wake',
  'scene.tone_set': 'owner',   // 016
  'phone.message': 'story', 'phone.text_set': 'owner',   // 019: the page words a text from detail.with / detail.dir
  // 011
  'commute.soaked': 'weather', 'weather.window_set': 'owner', 'weather.window_ended': 'owner', 'goal.set': 'owner',
  'goal.cancelled': 'owner', 'goal.fitted': 'decision', 'goal.deferred': 'decision', 'goal.done': 'decision', 'goal.expired': 'decision',
  // 015 Director as god (plan §P1.7)
  'outcome.set': 'owner', 'outcome.happened': 'social', 'career.set': 'work', 'change.applied': 'work', 'money.adjusted': 'money',
  'self.moved': 'home', 'cast.departed': 'people', 'cast.returned': 'people', 'vitals.planned': 'owner', 'sick.planned': 'owner',
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = DETAIL_MAX) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const round = (v, d = 0) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export class DayError extends Error {
  constructor(code) { super(`day: ${code}`); this.name = 'DayError'; this.code = code; }
}

// ── Names (the operator view: cast and place names from the projection) ──

function namer(state) {
  const place = (id) => (id && state?.places instanceof Map ? state.places.get(id)?.name ?? null : null);
  // 015: a departed member's name still resolves for past rows (story.departed).
  const cast = (id) => (id && state?.cast instanceof Map ? state.cast.get(id)?.name ?? state?.story?.departed?.[id]?.name ?? id : null);
  const castList = (ids) => (Array.isArray(ids) ? ids.map(cast).filter(Boolean).slice(0, 8) : []);
  // 014 geo (§A7): on a negative row a real venue is worded by its kind.
  const placeNeg = (id) => (id ? placeLabel(state, id, { negative: true }) : null);
  const option = (decisionId, optionId) => {
    const d = state?.decisions instanceof Map ? state.decisions.get(decisionId) : null;
    return (Array.isArray(d?.options) ? d.options.find((o) => o.id === optionId)?.label : null) ?? null;
  };
  // A decision's outing time (the Day page says "not yet" for a committed plan still ahead).
  const eventAt = (decisionId) => {
    const d = state?.decisions instanceof Map ? state.decisions.get(decisionId) : null;
    return finite(d?.subject?.eventAt) ? d.subject.eventAt : null;
  };
  return { place, cast, castList, option, placeNeg, eventAt };
}

function vitalsPoint(at, v) {
  if (!isObj(v)) return null;
  return {
    at,
    energy: round(v.energy), stress: round(v.stress), social: round(v.socialBattery),
    valence: round(v.mood?.valence, 2), sick: v.sick === true,
  };
}

// ── Rows from events ──────────────────────────────────────────────────────

/** A few code fields of a payload, for a tick's one-line detail (any type). */
function detailOf(ev, n) {
  const p = isObj(ev.payload) ? ev.payload : {};
  const out = {};
  if (ev.type === 'dream.had') {
    out.tone = typeof p.tone === 'string' ? p.tone : 'flat';
    out.vivid = p.recall === 'vivid';
  }
  const who = n.castList([...(Array.isArray(p.castIds) ? p.castIds : []), ...(typeof p.castId === 'string' ? [p.castId] : [])]);
  if (who.length) out.with = who;
  const neg = isNegativeEvent(ev);   // 014 geo: names, except on negative rows (R38)
  const place = neg && n.placeNeg ? n.placeNeg(p.placeId) : n.place(p.placeId);
  if (place) out.place = place;
  for (const k of ['kind', 'stage', 'reason', 'label', 'condition', 'mode', 'optionId', 'sky', 'goalKind', 'intensity', 'outcome', 'how', 'for', 'dir']) {
    const v = str(k === 'label' ? negativeLabel(p[k], neg) : p[k]);
    if (v) out[k] = v;
  }
  if (finite(p.amount)) out.amount = Math.round(p.amount);
  if (finite(p.tempC)) out.tempC = Math.round(p.tempC);
  if (finite(p.lateBy) && p.lateBy > 0) out.lateBy = Math.round(p.lateBy);
  if (finite(p.extraMin)) out.extraMin = Math.round(p.extraMin);
  if (finite(p.lateMin) && p.lateMin > 0) out.lateMin = Math.round(p.lateMin);   // 011: a soaked trip's delay
  if (p.changeClothes === true) out.changeClothes = true;
  return out;
}

function originOf(ev) {
  return CHAT_ORIGINS.has(ev.originKind) ? ev.originKind : null;
}

function spanOf(ev, n, future) {
  const p = isObj(ev.payload) ? ev.payload : {};
  const base = { at: ev.at, end: null, eventId: future ? null : ev.id, future, origin: originOf(ev), subjectJid: future ? null : ev.subjectJid ?? null };
  if (ev.type === 'sleep.started') return { ...base, cat: 'sleep', kind: 'sleep', availability: 'asleep', place: null, with: [] };
  if (ev.type === 'travel.started') {
    return {
      ...base, cat: 'trip', kind: 'commute', availability: str(p.availability, 16),
      from: n.place(p.from), to: n.place(p.to), mode: str(p.mode, 24), minutes: round(p.minutes), with: n.castList(p.withCast),
    };
  }
  return {
    ...base, cat: 'activity', kind: str(p.kind, 32) ?? 'activity', place: n.place(p.placeId),
    availability: str(p.availability, 16), with: n.castList(p.withCast), social: p.social === true,
    // 016: a planned outing's decision (its ❖ TONE link); digestRun resolves the rest and drops placeKey.
    ...(future ? { decisionId: Number.isSafeInteger(p.decisionId) ? p.decisionId : null, placeKey: typeof p.placeId === 'string' ? p.placeId : null } : {}),
  };
}

// 016: a planned outing span's decision — its plan's block covering it, its amended plan in the run (plan.made {amendedFor}), else a
// live open / committed go decision at that place whose time holds the span (the scene's decisionOf).
function outingDecisionOf(span, state, planOf) {
  if (Number.isSafeInteger(span.decisionId)) return span.decisionId;
  // The plan's own block for this span first: a plan re-made for one outing also starts the others.
  const block = planOf ? planBlockDecision(planOf, { type: 'activity.started', at: span.at, payload: { kind: span.kind } }) : null;
  if (block) return block;
  const amended = planOf?.amendedFor;
  const ad = Number.isSafeInteger(amended) && state?.decisions instanceof Map ? state.decisions.get(amended) : null;
  if (Number.isSafeInteger(amended) && (!ad?.subject?.placeId || !span.placeKey || ad.subject.placeId === span.placeKey)) return amended;
  if (!span.placeKey || !finite(span.at)) return null;
  let best = null;
  for (const d of state?.decisions instanceof Map ? state.decisions.values() : []) {
    if (d?.status !== 'open' && d?.status !== 'committed') continue;
    if (d.status === 'committed' && !['go', 'late'].includes(d.committed?.optionId)) continue;
    const sub = d.subject ?? {};
    if (sub.placeId !== span.placeKey || !finite(sub.eventAt)) continue;
    const end = finite(sub.endAt) ? sub.endAt : sub.eventAt + 4 * 3600;
    if (span.at < sub.eventAt - 2 * 3600 || span.at > end) continue;
    if (!best || Math.abs(sub.eventAt - span.at) < Math.abs(best.subject.eventAt - span.at)) best = d;
  }
  return best ? best.id : null;
}

/** The span in force at `t` from the projection itself (no event in the window started it). */
function spanFromState(state, n, future) {
  const act = state?.activity;
  const travel = state?.position?.travel;
  if (travel) {
    return { at: travel.startAt ?? null, end: null, eventId: null, future, cat: 'trip', kind: 'commute', from: n.place(travel.from), to: n.place(travel.to), mode: str(travel.mode, 24), minutes: null, with: [], availability: null, origin: null };
  }
  if (!isObj(act) || !act.kind || act.kind === 'idle') return null;
  return {
    at: act.startAt ?? null, end: null, eventId: future ? null : act.eventId ?? null, future,
    cat: act.kind === 'sleep' ? 'sleep' : 'activity', kind: act.kind, place: n.place(act.placeId),
    availability: act.kind === 'sleep' ? 'asleep' : str(act.availability, 16), with: n.castList(act.withCast), origin: null,
  };
}

/**
 * Spans and ticks from events (id order of the log or the sim). `open` is a
 * span already in force before the first event. Spans are clipped to the
 * caller's window later; ticks keep their own time.
 */
function rowsOf(events, n, { future = false, open = null, plans = null } = {}) {
  const spans = [];
  const ticks = [];
  const decisions = new Map();   // decision id → { opened, leans, last, closed }
  let cur = open;
  let phone = null;
  const phoneWakes = new Set();   // 019: wake.set ids an owner's text set ("woken up by his phone")
  for (const ev of events) {
    if (ev.type === 'wake.set' && ev.payload?.via === 'phone') phoneWakes.add(ev.id);
    if (SPAN_STARTS.has(ev.type) || SPAN_ENDS.has(ev.type)) {
      if (cur) { cur.end = ev.at; spans.push(cur); }
      cur = SPAN_STARTS.has(ev.type) ? spanOf(ev, n, future) : null;
      if (cur && future && ev.type === 'activity.started' && Number.isSafeInteger(ev.causeId)) cur.causeId = ev.causeId;
    }
    if (plans && ev.type === 'plan.made' && Number.isSafeInteger(ev.payload?.amendedFor)) plans.set(ev.id, ev.payload);
    if (ev.type === 'phone.check.started') {
      const p = isObj(ev.payload) ? ev.payload : {};
      phone = { at: ev.at, end: finite(p.until) ? p.until : null, cat: 'phone', type: ev.type, eventId: future ? null : ev.id, future, readOnly: p.readOnly === true, reason: str(p.reason, 32) };
      ticks.push(phone);
      continue;
    }
    if (ev.type === 'phone.check.ended') { if (phone) phone.end = ev.at; phone = null; continue; }
    if (ev.type.startsWith('decision.')) {
      const id = ev.type === 'decision.opened' ? ev.id : ev.payload?.decisionId;
      if (Number.isSafeInteger(id)) {
        const d = decisions.get(id) ?? { id, opened: null, lean: null, outcome: null, at: null };
        if (ev.type === 'decision.opened') { d.opened = ev; d.at = ev.at; }
        else if (ev.type === 'decision.lean') d.lean = { optionId: str(ev.payload?.optionId, 48), p: round(ev.payload?.p, 2), probs: isObj(ev.payload?.probs) ? ev.payload.probs : null };
        else if (ev.type === 'decision.committed') d.outcome = { optionId: str(ev.payload?.optionId, 48), by: str(ev.payload?.by, 16), at: ev.at };
        else if (ev.type === 'decision.reversed') d.outcome = { optionId: str(ev.payload?.to, 48), by: 'reversed', at: ev.at };
        else if (ev.type === 'decision.expired') d.outcome = { optionId: null, expired: str(ev.payload?.reason, 32) ?? 'expired', at: ev.at };
        decisions.set(id, d);
      }
      if (ev.type === 'decision.opened' || ev.type === 'decision.lean') continue;
    }
    if (SPAN_STARTS.has(ev.type) || ev.type === 'activity.ended' || ev.type === 'travel.arrived') continue;
    if (QUIET.has(ev.type)) continue;
    const cat = STORY.has(ev.type) || ev.type.startsWith('director.') ? (ev.type.startsWith('director.') ? 'owner' : 'story')
      : CATEGORY[ev.type] ?? 'event';
    if (ev.type === 'meal' && cur?.kind && ev.payload?.kind === cur.kind) continue; // the meal block's own meal
    const tick = {
      at: ev.at, cat, type: ev.type, eventId: future ? null : ev.id, future, actor: ev.actor,
      origin: originOf(ev), subjectJid: future ? null : ev.subjectJid ?? null, detail: detailOf(ev, n), count: 1,
    };
    if (ev.type === 'wake.set' && ev.payload?.via === 'phone') tick.detail.via = 'phone';
    if (ev.type === 'woke' && phoneWakes.has(ev.payload?.wakeSetId)) tick.detail.via = 'phone';
    if (ev.type.startsWith('decision.') && Number.isSafeInteger(ev.payload?.decisionId)) {
      tick.decisionId = ev.payload.decisionId;
      const optionId = str(ev.payload.optionId ?? ev.payload.to, 48);
      const opts = decisions.get(tick.decisionId)?.opened?.payload?.options;
      const label = optionId ? (Array.isArray(opts) ? opts.find((o) => o.id === optionId)?.label : null) ?? n.option?.(tick.decisionId, optionId) : null;
      if (label) tick.detail.label = str(label);
      if (optionId) tick.detail.optionId = optionId;
      const eventAt = decisions.get(tick.decisionId)?.opened?.payload?.subject?.eventAt ?? n.eventAt?.(tick.decisionId);
      if (finite(eventAt) && (ev.type === 'decision.committed' || ev.type === 'decision.reversed')) tick.detail.eventAt = eventAt;
    }
    // A burst of the same type in one minute (the daily cast pass) is one row.
    const last = ticks[ticks.length - 1];
    if (last && last.type === tick.type && Math.floor(last.at / 60) === Math.floor(tick.at / 60) && !last.decisionId) {
      last.count += 1;
      if (tick.detail.with) last.detail.with = [...new Set([...(last.detail.with || []), ...tick.detail.with])].slice(0, 8);
      continue;
    }
    ticks.push(tick);
  }
  if (cur) spans.push(cur);
  return { spans, ticks, decisions };
}

// 016 (plan §P1.9): an outing's span carries its live scene (the projection's newest
// non-excluded version, so a scene played after midnight still lands on its span).
function annotateScenes(spans, state) {
  const scenes = state?.story?.scenes;
  if (!isObj(scenes)) return;
  for (const sp of spans) {
    const sc = Number.isSafeInteger(sp.eventId) ? scenes[sp.eventId] : null;
    if (!isObj(sc)) continue;
    sp.scene = {
      eventId: sc.eventId, sceneId: sc.sceneId ?? null, ending: str(sc.ending, 24), chemistry: finite(sc.chemistry) ? sc.chemistry : null,
      tier: str(sc.tier, 8), fallback: sc.fallback === true, mode: str(sc.mode, 16),
      decisionId: Number.isSafeInteger(sc.decisionId) ? sc.decisionId : null,   // its decision's row opens this scene too
    };
  }
}

function clip(rows, from, to) {
  return rows
    .filter((r) => (r.end === null || r.end > from) && (r.at === null || r.at < to))
    .map((r) => ({ ...r, ...(r.at === null || r.at < from ? { at: from, clipped: true } : {}), ...(r.end !== null && r.end > to ? { endClipped: true } : {}) }));
}

function decisionView(d, live, n) {
  // The projection's copy (real decisions) wins; a sim decision has only its opened event.
  const p = isObj(d.opened?.payload) ? d.opened.payload : {};
  const options = Array.isArray(live?.options) ? live.options : Array.isArray(p.options) ? p.options : [];
  const label = (id) => (id ? options.find((o) => o.id === id)?.label ?? id : null);
  const subj = live?.subject ?? p.subject ?? {};
  const lean = live?.lean ?? d.lean;
  const outcome = live?.committed ? { optionId: live.committed.optionId, by: live.committed.by ?? null, at: live.committed.at ?? null } : d.outcome;
  return {
    id: d.id, at: live?.opensAt ?? p.opensAt ?? d.at, kind: live?.kind ?? str(p.kind, 32), category: live?.category ?? str(p.category, 32),
    status: live?.status ?? (d.outcome?.expired ? 'expired' : d.outcome ? 'committed' : 'open'),
    decideBy: live?.decideBy ?? p.decideBy ?? null, eventAt: subj.eventAt ?? null,
    place: n.place(subj.placeId), with: n.castList(subj.castIds), big: (live?.big ?? p.big) === true, mode: live?.mode ?? p.mode ?? null,
    options: options.map((o) => ({ id: o.id, label: str(o.label) ?? o.id })),
    lean: lean?.optionId ? { optionId: lean.optionId, label: label(lean.optionId), p: round(lean.p, 2) } : null,
    outcome: outcome?.optionId ? { optionId: outcome.optionId, label: label(outcome.optionId), by: outcome.by ?? null, at: outcome.at ?? null }
      : outcome?.expired ? { optionId: null, label: null, expired: outcome.expired, at: outcome.at ?? null } : null,
  };
}

// ── Projection ────────────────────────────────────────────────────────────

let ens = null;              // { key, to, at, computedAt, runs, ms, result }
let ensBusy = null;          // the computation in flight
const freshTimes = [];       // fresh projections in the last minute
const pastCache = new Map(); // `${date}|${lastEventId}` → { at, value }

/** Test seam: forget every cached projection and past series. */
export function resetDayCache() {
  ens = null;
  ensBusy = null;
  freshTimes.length = 0;
  pastCache.clear();
}

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

function spanSig(spans) {
  return spans.map((s) => `${s.kind}|${s.place ?? s.to ?? ''}|${Math.round((s.at ?? 0) / 900)}`).join(';');
}

function decisionKey(d) {
  // Real decisions keep their id; sim ones (ids differ between runs) their subject.
  return d.real ? `id:${d.id}` : `${d.kind}|${d.category ?? ''}|${d.eventAt ?? ''}|${d.place ?? ''}`;
}

function outcomeView(o, options) {
  if (o?.optionId) return { optionId: o.optionId, label: options.find((x) => x.id === o.optionId)?.label ?? o.optionId, by: o.by ?? null, at: o.at ?? null };
  if (o?.expired) return { optionId: null, label: null, expired: o.expired, at: o.at ?? null };
  return null;
}

function digestRun(run, state, n) {
  const open = spanFromState(state, n, true);
  const plans = new Map();   // the run's amended plans (an outing's decision)
  const rows = rowsOf(run.events, n, { future: true, open: open ? { ...open, at: run.from, continued: true } : null, plans });
  const { spans, decisions } = rows;
  for (const sp of spans) {
    if (sp.cat === 'activity' && Array.isArray(sp.with) && sp.with.length) sp.decisionId = outingDecisionOf(sp, state, plans.get(sp.causeId));
    else delete sp.decisionId;
    delete sp.placeKey;
    delete sp.causeId;
  }
  // The forecast covers the weather and the decision rows (with odds) the
  // run's own commits; this run's one outcome would read as a certainty.
  const ticks = rows.ticks.filter((t) => t.cat !== 'weather' && t.cat !== 'decision');
  const list = [];
  const push = (view, runOutcome, real) => {
    view.outcome = outcomeView(runOutcome, view.options);
    view.status = view.outcome ? (view.outcome.expired ? 'expired' : 'committed') : 'open';
    view.real = real;
    list.push(view);
  };
  // Every live decision still in play, whether or not the run touched it: its
  // outcome is the run's last commit/reversal/expiry, else what it already is.
  for (const live of state.decisions instanceof Map ? state.decisions.values() : []) {
    if (live?.status !== 'open' && live?.status !== 'committed') continue;
    const d = decisions.get(live.id);
    const view = decisionView({ id: live.id, opened: null, lean: null, outcome: null, at: live.opensAt }, { ...live, lean: d?.lean ?? live.lean }, n);
    const base = live.committed ? { optionId: live.committed.optionId, by: live.committed.by ?? null, at: live.committed.at ?? null } : null;
    push(view, d?.outcome ?? base, true);
  }
  for (const d of decisions.values()) {
    if (d.id <= state.lastEventId || !d.opened) continue;   // live ones are above; sim ones need their opened event
    push(decisionView(d, null, n), d.outcome, false);
  }
  return { spans, ticks, decisions: list, samples: run.samples.map((x) => vitalsPoint(x.at, x.vitals)).filter(Boolean) };
}

function aggregate(digests) {
  const N = digests.length;
  // The modal run: the most common sequence of spans (ties → the lowest run, i.e. run 0).
  const counts = new Map();
  digests.forEach((d, i) => { const k = spanSig(d.spans); const c = counts.get(k) ?? { n: 0, first: i }; c.n++; counts.set(k, c); });
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n || (c.n === best.n && c.first < best.first)) best = c;
  const modal = digests[best?.first ?? 0];
  // Decision outcome odds over every run: option ids, 'expired', 'undecided' (still open
  // at the horizon) and 'not_opened' — each distribution sums to 1.
  const byKey = new Map();
  digests.forEach((d) => {
    for (const x of d.decisions) {
      const k = decisionKey(x);
      const e = byKey.get(k) ?? { view: x, outcomes: new Map(), opened: 0 };
      e.opened++;
      const o = x.outcome?.optionId ?? (x.outcome?.expired ? 'expired' : 'undecided');
      e.outcomes.set(o, (e.outcomes.get(o) ?? 0) + 1);
      byKey.set(k, e);
    }
  });
  const decisions = [...byKey.values()].map(({ view, outcomes, opened }) => {
    const odds = [...outcomes.entries()].map(([id, c]) => ({
      id, label: view.options.find((o) => o.id === id)?.label ?? id, p: round(c / N, 3),
    }));
    if (opened < N) odds.push({ id: 'not_opened', label: 'not opened', p: round((N - opened) / N, 3) });
    odds.sort((a, b) => b.p - a.p);
    const { outcome, ...rest } = view;
    return { ...rest, status: view.real ? 'live' : 'projected', outcome: null, odds, opened: round(opened / N, 3) };
  }).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { spans: modal.spans, ticks: modal.ticks, samples: modal.samples, decisions, modalShare: round((best?.n ?? N) / N, 3) };
}

async function computeEnsemble({ state, at, horizonTo, simulate }) {
  const t0 = performance.now();
  const n = namer(state);
  const digests = [];
  const hours = Math.max(0.25, (horizonTo - at) / 3600);
  for (let i = 0; i < DAY_RUNS; i++) {
    const rng = i === 0 ? null : makeRng(mulberry32(hashString(`${getRngSeed()}|day|${i}`)));
    const run = await simulate({ state, now: at, hours, rng, sampleSec: SAMPLE_SEC });
    if (!run) break;
    digests.push(digestRun(run, state, n));
    if (digests.length >= DAY_MIN_RUNS && performance.now() - t0 > DAY_BUDGET_MS) break;
    await yieldLoop();
  }
  const ms = Math.round(performance.now() - t0);
  if (!digests.length) return null;
  return { ...aggregate(digests), runs: digests.length, ms, from: at, to: horizonTo };
}

/**
 * The shared projection now → horizonTo, cached (see the header). Never
 * throws: a failed or refused computation answers the stale copy or null.
 */
async function ensemble({ state, at, horizonTo, simulate }) {
  const key = state.lastEventId;
  const nowMs = Date.now();
  const covers = ens && ens.to >= horizonTo;
  const age = ens ? nowMs - ens.computedAt : Infinity;
  if (covers && ((ens.key === key && age < CACHE_MAX_MS) || age < RECOMPUTE_MIN_MS)) return { ...ens, cached: true, stale: ens.key !== key };
  if (ensBusy) {
    try { await ensBusy; } catch { /* reported below */ }
    if (ens && ens.to >= horizonTo) return { ...ens, cached: true, stale: ens.key !== key };
  }
  while (freshTimes.length && nowMs - freshTimes[0] > 60_000) freshTimes.shift();
  if (freshTimes.length >= PROJECTIONS_PER_MIN) return ens ? { ...ens, cached: true, stale: true, limited: true } : null;
  freshTimes.push(nowMs);
  ensBusy = computeEnsemble({ state, at, horizonTo, simulate });
  try {
    const res = await ensBusy;
    if (res) ens = { ...res, key, computedAt: Date.now() };
    logger.debug({ evt: 'life.day.projection', runs: res?.runs ?? 0, ms: res?.ms ?? null }, 'life: day projection');
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'life.day.projection', err: err?.name || 'Error' }, 'life: day projection failed');
  } finally {
    ensBusy = null;
  }
  return ens && ens.to >= horizonTo ? { ...ens, cached: false, stale: ens.key !== key } : null;
}

// ── Plan fallback (story off) ─────────────────────────────────────────────

function planSpans(blocks, n) {
  return (Array.isArray(blocks) ? blocks : []).filter((b) => finite(b?.start) && finite(b?.end)).map((b) => ({
    at: b.start, end: b.end, eventId: null, future: true, origin: null,
    cat: b.kind === 'sleep' ? 'sleep' : b.kind === 'commute' ? 'trip' : 'activity', kind: b.kind,
    place: n.place(b.placeId), from: n.place(b.from), to: n.place(b.to), mode: str(b.mode, 24), minutes: round(b.minutes),
    availability: b.kind === 'sleep' ? 'asleep' : str(b.availability, 16), with: n.castList(b.withCast), planned: true,
  }));
}

function planFuture(state, world, n, d0, today) {
  const current = planSpans(state.plan?.blocks, n);   // today's plan; its sleep runs into tomorrow
  if (today) return current;
  try {
    const next = planSpans(planDay(state, d0, world)?.blocks, n);
    const first = next[0]?.at ?? Infinity;
    return [...current.filter((s) => s.at < first).map((s) => ({ ...s, end: Math.min(s.end, first) })), ...next];
  } catch {
    return current;
  }
}

// ── The view ──────────────────────────────────────────────────────────────

function boundsOf(date, tz) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const d0 = zonedToUnix(y, m, d, 0, 0, tz);
  if (dateKey(d0, tz) !== date) return null;
  return { d0, d1: addDays(d0, 1, tz) };
}

function pastVitals({ date, d0, end, state, world, today }) {
  const key = `${date}|${today ? state.lastEventId : 'past'}`;
  const hit = pastCache.get(key);
  if (hit && Date.now() - hit.at < PAST_CACHE_MS) return hit.value;
  let value = null;
  try {
    const series = vitalsSeries({ from: d0, to: end, stepSec: SAMPLE_SEC, world });
    value = series ? series.map((x) => vitalsPoint(x.at, x.vitals)).filter(Boolean) : null;
  } catch (err) {
    logger.debug({ err: err?.name || 'Error' }, 'life: day vitals skipped');
  }
  if (pastCache.size >= PAST_CACHE_MAX) pastCache.delete(pastCache.keys().next().value);
  pastCache.set(key, { at: Date.now(), value });
  return value;
}

function nowCard(state, view, world, n, nextSpan) {
  const at = view.viewAt;
  const av = availabilityAt(view, at, world);
  const row = av.onPhone ? 'free' : av.state;
  const battery = view.vitals?.socialBattery;
  const travel = view.position?.travel;
  const act = view.activity || {};
  const odds = (column) => Object.fromEntries(Object.entries(gateProbabilities(row, column, { socialBattery: battery })).map(([k, v]) => [k, round(v, 2)]));
  return {
    at,
    doing: travel
      ? { cat: 'trip', kind: 'commute', from: n.place(travel.from), to: n.place(travel.to), mode: str(travel.mode, 24), until: travel.endAt ?? null, with: [] }
      : { cat: act.kind === 'sleep' ? 'sleep' : 'activity', kind: act.kind ?? null, place: n.place(act.placeId) ?? n.place(view.position?.placeId),
        since: act.startAt ?? null, until: act.endAt ?? null, with: n.castList(act.withCast), eventId: act.eventId ?? null },
    availability: { state: av.state, onPhone: av.onPhone === true, since: av.since ?? null, until: av.until ?? null },
    reply: { dm: odds('dm'), mention: odds('mention'), chatter: odds('chatter') },
    vitals: vitalsPoint(at, view.vitals),
    hunger: round(view.vitals?.hunger), sleepDebt: round(view.vitals?.sleepDebt, 1), workPressure: round(view.vitals?.workPressure),
    weather: view.weather ? { condition: str(view.weather.condition, 16), tempC: round(view.weather.tempC), rain: view.weather.rain === true } : null,
    next: nextSpan ?? null,
    phone: { nextCheckAt: view.phone?.nextCheckAt ?? null, lastCheckAt: view.phone?.lastCheckEndAt ?? view.phone?.lastCheckAt ?? null },
    embargo: !!(state.embargo && finite(state.embargo.until) && state.embargo.until > at),
  };
}

/**
 * The Day view. deps (the facade's): state (the live projection, not a
 * view), world (the base world), worldOf(state) (its career overlay), at
 * (now), date ('YYYY-MM-DD' | null → today), events(from, to) → the log's
 * non-excluded events in [from, to] (at, id order), simulate(opts) → a
 * story-facade run | null, storyOn (bool).
 * Throws DayError('bad_date' | 'out_of_range').
 */
export async function buildDayView({ state, world, worldOf = () => world, at, date = null, events, simulate, storyOn = false }) {
  const tz = state.world?.timezone ?? world?.timezone;
  const todayKey = dateKey(at, tz);
  const want = date ?? todayKey;
  const b = boundsOf(want, tz);
  if (!b) throw new DayError('bad_date');
  const { d0, d1 } = b;
  const first = finite(state.genesisAt) ? dateKey(state.genesisAt, tz) : todayKey;
  const last = dateKey(addDays(dayStart(at, tz), 1, tz), tz);
  if (want < first || want > last) throw new DayError('out_of_range');
  const today = want === todayKey;
  const n = namer(state);
  const view = { from: d0, to: d1, date: want, today, tomorrow: want === last, timezone: tz, at };

  // Past: [d0, min(d1, at)].
  const pastEnd = Math.min(d1, at);
  let past = { spans: [], ticks: [], decisions: [], vitals: null };
  if (pastEnd > d0) {
    const evs = events(d0 - LOOKBACK_SEC, pastEnd);
    const rows = rowsOf(evs, n);
    if (today && rows.spans.length) {
      const lastSpan = rows.spans[rows.spans.length - 1];
      if (lastSpan.end === null) lastSpan.ongoing = true;
    }
    const decisions = [...rows.decisions.values()]
      .filter((d) => d.opened && d.opened.at >= d0 && d.opened.at <= pastEnd)
      .map((d) => decisionView(d, state.decisions instanceof Map ? state.decisions.get(d.id) : null, n));
    annotateScenes(rows.spans, state);   // 016
    past = {
      spans: clip(rows.spans, d0, pastEnd),
      ticks: rows.ticks.filter((t) => t.at >= d0 && t.at <= pastEnd),
      decisions,
      vitals: pastVitals({ date: want, d0, end: pastEnd, state, world, today }),
    };
  }

  // Future: [max(d0, at), d1] — today's rest or tomorrow.
  let future = null;
  let e = null;                  // the ensemble, kept for tonight's strip
  if (d1 > at) {
    const from = Math.max(d0, at);
    const horizonTo = addDays(dayStart(at, tz), 2, tz);
    if (storyOn && typeof simulate === 'function') {
      e = await ensemble({ state, at, horizonTo, simulate });
      if (e) {
        future = {
          source: 'sim', runs: e.runs, ms: e.ms, cached: e.cached, stale: e.stale, limited: e.limited === true,
          computedAt: Math.floor(e.computedAt / 1000), modalShare: e.modalShare,
          spans: clip(e.spans, from, d1).filter((s) => s.end === null || s.end > at),
          ticks: e.ticks.filter((t) => t.at >= from && t.at < d1),
          decisions: e.decisions.filter((d) => (d.decideBy ?? d.at ?? 0) >= from && (d.at ?? 0) < d1),
          vitals: e.samples.filter((x) => x.at >= from && x.at <= d1),
        };
      }
    }
    if (!future) {
      future = {
        source: 'plan', runs: 0, ms: 0, cached: false, stale: false, limited: false, computedAt: Math.floor(Date.now() / 1000), modalShare: null,
        spans: clip(planFuture(state, worldOf(state), n, d0, today), from, d1).filter((s) => s.end > at),
        ticks: [], decisions: [], vitals: null,
      };
    }
    try {
      // 011: the owner's weather windows replace the forecast where they cover it ("SET BY YOU").
      future.weather = forecast(from, (d1 - from) / 3600, world, { state }).map((w) => ({
        from: Math.max(w.from, from), until: w.until, condition: w.condition, tempC: w.tempC, rain: w.rain, ...(w.owner ? { owner: true } : {}),
      }));
    } catch {
      future.weather = [];
    }
  }

  // sched-fixes: today after 18:00 — tonight past midnight up to his next wake
  // (≥ 6 h), from the same projection (or today's plan, which runs into
  // tomorrow), plus the plans set for then, so a 00:15 outing shows on today's page.
  let tonight = null;
  if (today && future && hourOfDay(at, tz) >= TONIGHT_FROM_HOUR) {
    try {
      tonight = tonightView({ state, n, d1, e });
    } catch (err) {
      logger.debug({ err: err?.name || 'Error' }, 'life: day tonight skipped');
    }
  }

  // Today: the block he is in continues past now — its projected end goes on
  // the ongoing past row instead of a second row for the same block.
  if (today && future?.spans?.[0]?.continued) {
    const cont = future.spans.shift();
    const ongoing = past.spans.at(-1);
    if (ongoing && ongoing.end === null) ongoing.expectedEnd = cont.end;
  }

  let nowView = null;
  if (today) {
    try {
      const nextSpan = future?.spans?.find((s) => s.at > at) ?? null;
      nowView = nowCard(state, advanceTo(state, at, world), world, n, nextSpan);
    } catch (err) {
      logger.debug({ err: err?.name || 'Error' }, 'life: day now card skipped');
    }
  }

  return {
    ...view,
    range: { first, last, today: todayKey },
    prev: want > first ? dateKey(addDays(d0, -1, tz), tz) : null,
    next: want < last ? dateKey(d1, tz) : null,
    now: nowView,
    past,
    future,
    tonight,
    goals: goalsView(state, at, n),
  };
}

// Tonight past midnight: [d1, his next wake] (≥ 6 h, ≤ 14 h). The spans of the
// projection (or today's plan), its decisions whose event falls then, and every
// open / committed plan of his set for then the projection doesn't carry.
function tonightView({ state, n, d1, e }) {
  const all = e ? e.spans : planSpans(state.plan?.blocks, n);
  const sleep = all.find((s) => s.cat === 'sleep' && (s.end === null || s.end > d1) && s.at < d1 + TONIGHT_MAX_SEC);
  const wake = sleep && finite(sleep.end) ? sleep.end : null;
  const to = Math.min(d1 + TONIGHT_MAX_SEC, Math.max(d1 + TONIGHT_MIN_SEC, wake ?? 0));
  const spans = clip(all, d1, to);
  // A plan for tonight is listed at its own time here even when today's rows show it
  // at its decide-by time (that row is about deciding; this one is when it happens).
  const shown = new Set();
  const inWindow = (t) => finite(t) && t >= d1 && t < to;
  const decisions = [];
  for (const d of e ? e.decisions : []) {
    if (!inWindow(d.eventAt) || shown.has(d.id)) continue;
    decisions.push({ ...d, at: d.eventAt });
    if (d.id !== null && d.id !== undefined) shown.add(d.id);
  }
  for (const d of state.decisions instanceof Map ? state.decisions.values() : []) {
    if ((d?.status !== 'open' && d?.status !== 'committed') || !inWindow(d.subject?.eventAt) || shown.has(d.id)) continue;
    decisions.push({ ...decisionView({ id: d.id, at: d.opensAt }, d, n), at: d.subject.eventAt });
    shown.add(d.id);
  }
  decisions.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return {
    from: d1, to, wakeAt: wake, source: e ? 'sim' : 'plan',
    spans,
    ticks: e ? e.ticks.filter((t) => t.at >= d1 && t.at < to) : [],
    decisions: decisions.slice(0, 12),
  };
}

// 011: the owner's soft goals as of now — open, planned, deferred; a closed one
// (done / expired / cancelled) stays listed for 3 days, so it lapses visibly.
const GOAL_SHOWN_SEC = 3 * DAY;
function goalsView(state, at, n) {
  const goals = isObj(state?.goals) ? Object.values(state.goals) : [];
  return goals.filter((g) => isObj(g) && (g.status === 'open' || g.status === 'fitted' || (finite(g.closedAt) && g.closedAt >= at - GOAL_SHOWN_SEC)))
    .sort((a, b) => a.id - b.id).slice(0, 12).map((g) => ({
      id: g.id, goalKind: str(g.goalKind, 16), label: str(g.label, 80),
      with: g.castId ? n.cast(g.castId) : null, place: n.place(g.placeId ?? g.fitted?.placeId ?? null),
      from: finite(g.from) ? g.from : null, to: finite(g.to) ? g.to : null,
      status: g.status === 'fitted' ? 'planned' : str(g.status, 16),
      slotStart: finite(g.fitted?.slotStart) ? g.fitted.slotStart : null,
      lastTry: g.lastTry ? { date: str(g.lastTry.date, 10), reason: str(g.lastTry.reason, 24) } : null,
      closedAt: finite(g.closedAt) ? g.closedAt : null,
    }));
}

export const __test = { rowsOf, aggregate, decisionKey, spanSig, DAY };
