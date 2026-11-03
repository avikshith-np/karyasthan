import { config } from '../../utils/config.js';
import { ROMANCE_STAGES } from './reducer.js';
import { check as controlsCheck, sliderFactor, pinKeysFor } from './controls.js';

// Romance state machine (spec 010 research R8): Sternberg's triangle
// (intimacy, passion, commitment) plus time together, on the projection's
// story slice. Pure: no DB, no clock, no model calls. The daily item
// (cast.js) asks this module for the day's romance plan; the facade asks it
// for the consequence of a committed romance decision.
//
//   single → interested → talking → dating → committed → engaged → married
//   exits: fizzled (interested/talking → single), broken_up (dating+ → single)
//
// - A forward move needs the thresholds AND the minimum dwell; it is never
//   taken directly — the daily item opens a timed `romance:step` decision
//   (options step|wait, never go/late/stay) and the step happens only as the
//   consequence of a committed `step`, caused by the decision's own
//   `decision.opened` (self) with the commit id in the payload (R14 item 8).
//   Stages are never skipped: the consequence moves exactly one stage.
// - dating→committed, committed→engaged and engaged→married are big.
// - The onset (single → interested) is a daily roll: p = 0.004 × (0.5 +
//   romanceAppetite), after the cool-down, with a fictional, non-family cast
//   member (ids are `cast:*` only, so a real person can never be a partner).
// - Metrics move only through `relationship.changed`. The daily pass credits
//   shared time (see dailyDelta) and this module adds commitment on a committed
//   step; neglect (no contact for 7 days) costs passion.
//
// Documented choices the spec leaves open:
// - Pre-onset attraction: shared time with a romance-eligible member adds a
//   little intimacy and passion (half the partner rate), so the onset's
//   "passion ≥ 0.3" row is reachable only with someone he actually spends time
//   with. togetherMin counts every member's shared time (the "together" column).
// - Eligibility: relation not `family:*` and not `manager` (the manager is the
//   career arc's counterpart; a romance there would read as a power imbalance).
// - "Tension ≥ 0.7 for 14 days" (breakup) needs a window the projection does
//   not keep. When the reducer folds `relationships[id].tensionHighSince` the
//   exact rule is used; until then a proxy: tension ≥ 0.7 today and a per-date
//   roll with p = 1/14 (≈ 14 days expected). A `stay` re-opens it the same way.
// - A step decision re-opens after `wait` through a per-date roll (p = 1/7)
//   while the thresholds still hold — stateless, so replay gives the same log.
// - An interested/talking arc that stalls fizzles: passion < 0.2, or longer
//   than FIZZLE_AFTER_DAYS in the stage.

export const STAGES = ROMANCE_STAGES;

/** Forward thresholds, keyed by the stage being entered (R8 table). togetherMin is minutes. */
export const THRESHOLDS = Object.freeze({
  interested: Object.freeze({ passion: 0.3 }),
  talking: Object.freeze({ intimacy: 0.25, passion: 0.4, togetherMin: 60 }),
  dating: Object.freeze({ intimacy: 0.4, passion: 0.5, commitment: 0.2, togetherMin: 6 * 60 }),
  committed: Object.freeze({ intimacy: 0.6, passion: 0.5, commitment: 0.5, togetherMin: 30 * 60 }),
  engaged: Object.freeze({ intimacy: 0.75, passion: 0.45, commitment: 0.75, togetherMin: 150 * 60 }),
  married: Object.freeze({ intimacy: 0.8, passion: 0.4, commitment: 0.85 }),
});

/** Minimum days in a stage before the next step may open (keyed by the current stage). */
export const DWELL_DAYS = Object.freeze({ interested: 7, talking: 14, dating: 60, committed: 365, engaged: 90 });

/** Steps that are big decisions (keyed by the stage being entered). */
export const BIG_STEPS = Object.freeze(new Set(['committed', 'engaged', 'married']));

export const ONSET_P = 0.004;
export const STEP_RETRY_P = 1 / 7;
export const BREAKUP_TENSION = 0.7;
export const BREAKUP_DAYS = 14;
export const BREAKUP_P = 1 / BREAKUP_DAYS;
export const NEGLECT_DAYS = 7;
export const FIZZLE_PASSION = 0.2;
// A romance this new is never ended for low passion (it hasn't had the time to build any).
export const FIZZLE_GRACE_DAYS = 5;
export const FIZZLE_AFTER_DAYS = Object.freeze({ interested: 90, talking: 120 });

const DAY = 86400;
const HOUR = 3600;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const STEP_LABEL = Object.freeze({
  interested: 'Let it grow', talking: 'Start talking more', dating: 'Start dating', committed: 'Make it official',
  engaged: 'Get engaged', married: 'Get married',
});
// Shared-time rates per 30 minutes, with a per-day ceiling (see header).
const RATE = Object.freeze({
  partner: { intimacy: [0.01, 0.04], passion: [0.01, 0.04], commitment: [0.0025, 0.01] },
  eligible: { intimacy: [0.005, 0.02], passion: [0.005, 0.02] },
});
const NEGLECT_PASSION_PER_DAY = 0.01;
const STEP_COMMITMENT = 0.15;
const STEP_PASSION = 0.05;
const COMMITTED_STAGES = new Set(['talking', 'dating', 'committed', 'engaged', 'married']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round4 = (v) => Math.round(v * 10000) / 10000;
const round2 = (v) => Math.round(v * 100) / 100;
const num = (v, d = 0) => (finite(v) ? v : d);

/** The stage after `stage`, or null (married, unknown). */
export function nextStage(stage) {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

/** The active romance arc ({arc, partnerId}) or null. */
export function activeRomance(s) {
  const st = s?.story;
  const id = st?.romance?.arcId;
  const arc = id ? st?.arcs?.[id] : null;
  if (!isObj(arc) || arc.status !== 'active' || arc.category !== 'romance') return null;
  const partnerId = typeof arc.castIds?.[0] === 'string' ? arc.castIds[0] : (st.romance.partnerId ?? null);
  return { arc, partnerId };
}

/** Metrics of one cast member: closeness/trust/tension (cast.metrics) + intimacy/passion/commitment/togetherMin. */
export function metricsOf(s, castId) {
  const m = s?.cast instanceof Map ? s.cast.get(castId)?.metrics : null;
  const r = s?.story?.relationships?.[castId];
  return {
    closeness: num(m?.closeness, 0.5), trust: num(m?.trust, 0.5), tension: num(m?.tension, 0),
    intimacy: num(r?.intimacy), passion: num(r?.passion), commitment: num(r?.commitment),
    togetherMin: num(r?.togetherMin), lastContactAt: finite(r?.lastContactAt) ? r.lastContactAt : null,
  };
}

/** Can this cast member be a romance partner at all? (fictional, non-family, not the manager) */
export function romanceEligible(s, castId) {
  if (typeof castId !== 'string' || !CAST_ID_RE.test(castId)) return false;
  const c = s?.cast instanceof Map ? s.cast.get(castId) : null;
  if (!isObj(c)) return false;
  const rel = String(c.relation ?? '');
  return !rel.startsWith('family') && rel !== 'manager';
}

/**
 * Code score for a partner candidate (R8): closeness, trust, low tension,
 * attraction and time together; +0.05 when the arc seed's romance.meetVia names
 * their relation. null when the member can't be a partner.
 */
export function partnerScore(s, castId, seed = null) {
  if (!romanceEligible(s, castId)) return null;
  const m = metricsOf(s, castId);
  const via = Array.isArray(seed?.romance?.meetVia) ? seed.romance.meetVia : [];
  const rel = String(s.cast.get(castId).relation ?? '');
  const score = 0.4 * m.closeness + 0.2 * m.trust - 0.3 * m.tension
    + 0.3 * Math.min(1, m.passion / 0.5) + Math.min(0.1, m.togetherMin / 6000)
    + (via.includes(rel) ? 0.05 : 0);
  return round4(score);
}

function meets(m, th) {
  return Object.entries(th).every(([k, v]) => num(m[k]) >= v);
}

// Mean margin over the thresholds (how clearly they are met), for the step's bias.
function margin(m, th) {
  const keys = Object.keys(th).filter(k => k !== 'togetherMin');
  if (!keys.length) return 0;
  return keys.reduce((a, k) => a + (num(m[k]) - th[k]), 0) / keys.length;
}

/** Open or committed-but-not-yet-applied romance decisions of this arc (any kind). */
export function pendingDecisions(s, arc) {
  const out = [];
  const decisions = s?.decisions instanceof Map ? s.decisions.values() : [];
  for (const d of decisions) {
    if (d?.arcId !== arc.id) continue;
    if (d.status === 'open') out.push(d);
    else if (d.status === 'committed' && consequenceDue(d, arc)) out.push(d);
  }
  return out;
}

// A committed step/end whose effect has not been folded yet.
function consequenceDue(d, arc) {
  const opt = d?.committed?.optionId;
  if (d?.kind === 'romance:step') return opt === 'step' && arc.status === 'active' && num(arc.stageAt) < num(d.opensAt);
  if (d?.kind === 'romance:breakup') return opt === 'end' && arc.status === 'active';
  return false;
}

function leadSec() {
  const h = Number(config.arcs?.bigLeadHours);
  return (Number.isFinite(h) && h >= 24 ? h : 24) * HOUR;
}

/**
 * The next step's decision spec for the active romance at `at`, or null: the
 * stage's thresholds AND dwell must hold and no romance decision of the arc may
 * be pending. Controls (pins, frozen, guided) are the caller's (dailyRomance).
 * opts.bias: extra bias on `step` (e.g. the romanceAppetite slider).
 */
export function nextStep(s, at, opts = {}) {
  const r = activeRomance(s);
  if (!r || !finite(at)) return null;
  const { arc, partnerId } = r;
  const to = nextStage(arc.stage);
  if (!to || !THRESHOLDS[to] || !partnerId) return null;
  const dwell = DWELL_DAYS[arc.stage];
  if (!finite(dwell) || at - num(arc.stageAt, at) < dwell * DAY) return null;
  const m = metricsOf(s, partnerId);
  if (!meets(m, THRESHOLDS[to])) return null;
  if (pendingDecisions(s, arc).length) return null;
  const big = BIG_STEPS.has(to);
  const decideBy = Math.round(at + (big ? leadSec() + 12 * HOUR : 24 * HOUR));
  const bias = round2(clamp(0.5 + 3 * margin(m, THRESHOLDS[to]) + num(opts.bias), -3, 3));
  return {
    kind: 'romance:step',
    category: 'romance',
    arcId: arc.id,
    big,
    ...(big ? { mode: 'ask' } : {}),
    decideBy,
    subject: { eventAt: decideBy, placeId: null, castIds: [partnerId], minutes: 30 },
    options: [
      { id: 'step', label: STEP_LABEL[to], kind: 'rest', minutes: 0, bias },
      { id: 'wait', label: 'Give it more time', kind: 'rest', minutes: 0 },
    ],
    to,
  };
}

/**
 * The breakup decision spec (big) when tension with the partner has stayed
 * ≥ 0.7 for 14 days, or null. `rng` is the date's roll for the proxy rule
 * (header); pass null to only test the precondition.
 */
export function breakupSpec(s, at, rng = null) {
  const r = activeRomance(s);
  if (!r || !finite(at) || !r.partnerId) return null;
  const { arc, partnerId } = r;
  if (STAGES.indexOf(arc.stage) < STAGES.indexOf('dating')) return null;
  const m = metricsOf(s, partnerId);
  if (m.tension < BREAKUP_TENSION) return null;
  const since = s?.story?.relationships?.[partnerId]?.tensionHighSince;
  if (finite(since)) {
    if (at - since < BREAKUP_DAYS * DAY) return null;
  } else if (rng && !(rng() < BREAKUP_P)) {
    return null;
  }
  if (pendingDecisions(s, arc).length) return null;
  const decideBy = Math.round(at + leadSec() + 12 * HOUR);
  const endBias = round2(clamp((m.tension - BREAKUP_TENSION) * 5 - (m.commitment - 0.5) * 2, -3, 3));
  return {
    kind: 'romance:breakup',
    category: 'romance',
    arcId: arc.id,
    big: true,
    mode: 'ask',
    decideBy,
    subject: { eventAt: decideBy, placeId: null, castIds: [partnerId], minutes: 30 },
    options: [
      { id: 'end', label: 'End it', kind: 'rest', minutes: 0, bias: endBias },
      { id: 'stay', label: 'Try to work it out', kind: 'rest', minutes: 0 },
    ],
  };
}

/**
 * Onset roll (single → interested). rng: the date's generator (cast.js passes
 * rngFor(date, 'story:romance:onset')). Gates in order: the arc seed's romance
 * section (null → inert), no active romance, cool-down over; then the roll
 * p = ONSET_P × sliderFactor('romanceAppetite'); then a partner with passion ≥
 * 0.3, the best partnerScore (ties by id).
 * → { outcome: 'inert'|'active'|'cooldown'|'no'|'no_partner'|'hit', p, roll?, partnerId? }
 */
export function onsetRoll(s, rng, { seed = null, at = s?.at } = {}) {
  if (!isObj(seed?.romance)) return { outcome: 'inert', p: 0 };
  if (activeRomance(s) || s?.story?.romance?.arcId) return { outcome: 'active', p: 0 };
  const cool = s?.story?.romance?.cooldownUntil;
  if (finite(cool) && finite(at) && at < cool) return { outcome: 'cooldown', p: 0 };
  const p = round4(ONSET_P * sliderFactor('romanceAppetite', s));
  const roll = typeof rng === 'function' ? rng() : 1;
  if (!(roll < p)) return { outcome: 'no', p, roll: round4(roll) };
  const partnerId = pickPartner(s, seed);
  if (!partnerId) return { outcome: 'no_partner', p, roll: round4(roll) };
  return { outcome: 'hit', p, roll: round4(roll), partnerId };
}

/** Best eligible candidate with passion ≥ the onset threshold (pins are the caller's), or null. */
export function pickPartner(s, seed = null, exclude = () => false) {
  const ids = s?.cast instanceof Map ? [...s.cast.keys()].sort() : [];
  let best = null;
  for (const id of ids) {
    if (exclude(id)) continue;
    const score = partnerScore(s, id, seed);
    if (score === null || metricsOf(s, id).passion < THRESHOLDS.interested.passion) continue;
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? null;
}

/**
 * Romance part of one member's daily `relationship.changed` (merged by cast.js):
 * shared-time intimacy/passion (partner: full rate, eligible: half), partner
 * commitment from `talking` on, and neglect (−passion/day after 7 days without
 * contact). Deltas are rounded; zeros omitted.
 * ctx: { sharedMin, noContactDays, days }
 */
export function dailyDelta(s, castId, { sharedMin = 0, noContactDays = 0, days = 1 } = {}) {
  const out = {};
  const r = activeRomance(s);
  const isPartner = !!r && r.partnerId === castId;
  const rates = isPartner ? RATE.partner : (romanceEligible(s, castId) ? RATE.eligible : null);
  const m = metricsOf(s, castId);
  const blocks = Math.max(0, num(sharedMin)) / 30;
  if (rates && blocks > 0) {
    for (const [k, [per, cap]] of Object.entries(rates)) {
      if (k === 'commitment' && !(isPartner && COMMITTED_STAGES.has(r.arc.stage))) continue;
      const d = Math.min(cap, per * blocks, 1 - num(m[k]));
      if (d > 0) out[k] = round4(d);
    }
  }
  const neglectDays = Math.min(Math.max(1, Math.floor(num(days, 1))), Math.max(0, Math.floor(num(noContactDays)) - NEGLECT_DAYS));
  if (num(sharedMin) <= 0 && neglectDays > 0 && m.passion > 0) {
    out.passion = round4(-Math.min(m.passion, NEGLECT_PASSION_PER_DAY * neglectDays));
  }
  return out;
}

// Controls verdict for one romance change; refusals are collected for the caller.
function gate(s, { action, pinKeys, target, refusals }) {
  const v = controlsCheck({ source: 'engine', category: 'romance', action, pinKeys }, s);
  if (!v.ok) refusals.push({ source: 'engine', category: 'romance', action, target, reason: v.reason, pinKey: v.pinKey ?? null });
  return v;
}

/**
 * The day's romance plan for the daily item (cast.js): at most one of
 * fizzle / step decision / breakup decision for an active romance, or the onset
 * roll when single. Controls are evaluated here (never in run()).
 * ctx: { at, date, seed, rngFor(date, purpose) }
 * → { outcome, events: [descriptor], decisions: [{ spec, roll }], refusals: [row] }
 */
export function dailyRomance(s, { at, date, seed = null, rngFor } = {}) {
  const res = { outcome: 'none', events: [], decisions: [], refusals: [] };
  const rf = typeof rngFor === 'function' ? rngFor : () => () => 1;
  const r = activeRomance(s);
  if (r) {
    const { arc, partnerId } = r;
    const pending = pendingDecisions(s, arc).length > 0;
    const m = partnerId ? metricsOf(s, partnerId) : null;
    // Fizzle: a stalled early romance ends quietly.
    if (!pending && (arc.stage === 'interested' || arc.stage === 'talking')) {
      const tooLong = at - num(arc.stageAt, at) > FIZZLE_AFTER_DAYS[arc.stage] * DAY;
      // 2026-11-01 (live: an owner-started romance fizzled 4 h in, on its first daily pass, before any
      // passion could build): low passion ends it only after FIZZLE_GRACE_DAYS from its start.
      const young = at - num(arc.startedAt ?? arc.stageAt, at) < FIZZLE_GRACE_DAYS * DAY;
      if (!partnerId || !m || (m.passion < FIZZLE_PASSION && !young) || tooLong) {
        const ev = { type: 'arc.ended', at, actor: 'engine', payload: { arcId: arc.id, outcome: 'fizzled' } };
        const v = gate(s, { action: 'beat', pinKeys: pinKeysFor(ev, s), target: `arc:${arc.id}`, refusals: res.refusals });
        if (v.ok) { res.events.push(ev); res.outcome = 'fizzled'; } else res.outcome = v.reason;
        return res;
      }
    }
    const bspec = breakupSpec(s, at, rf(date, 'story:romance:breakup'));
    const spec = bspec ?? (rf(date, 'story:romance:step')() < STEP_RETRY_P || firstChance(s, arc, at) ? nextStep(s, at) : null);
    if (spec) {
      const pins = pinKeysFor({ type: 'decision.opened', payload: spec }, s);
      const v = gate(s, { action: 'decision', pinKeys: pins, target: `arc:${arc.id}`, refusals: res.refusals });
      if (v.ok) {
        const { to, ...clean } = spec;
        if (v.ask) clean.mode = 'ask';
        res.decisions.push({ spec: clean, roll: 'romance' });
        res.outcome = spec.kind === 'romance:breakup' ? 'breakup_opened' : `step_opened:${to}`;
      } else {
        res.outcome = v.reason;
      }
      return res;
    }
    res.outcome = pending ? 'pending' : `steady:${arc.stage}`;
    return res;
  }
  const roll = onsetRoll(s, rf(date, 'story:romance:onset'), { seed, at });
  res.outcome = roll.outcome;
  res.p = roll.p;
  if (roll.outcome !== 'hit') return res;
  const ev = {
    type: 'arc.started', at, actor: 'engine',
    payload: { category: 'romance', kind: 'romance', castIds: [roll.partnerId], stage: 'interested' },
  };
  const v = gate(s, { action: 'start', pinKeys: pinKeysFor(ev, s), target: roll.partnerId, refusals: res.refusals });
  if (!v.ok) { res.outcome = v.reason; return res; }
  res.events.push(ev);
  res.outcome = 'started';
  return res;
}

// The first day the step becomes possible opens at once (no retry roll).
function firstChance(s, arc, at) {
  const dwell = DWELL_DAYS[arc.stage];
  return finite(dwell) && at - num(arc.stageAt, at) < (dwell + 1) * DAY;
}

/**
 * The consequence of a committed romance decision (R14 item 8), or null when
 * there is nothing (more) to do: `wait`/`stay`, an unknown kind, an arc that
 * already moved or ended, or no state to read. Every event is caused by the
 * decision's own `decision.opened` (decision.id, self) and carries
 * `commitEventId`; it is due at the commit time. The facade checks `category`,
 * `action` and `pinKeys` with controls.check before offering it, and appends
 * the terminal decision.expired {frozen|pinned} when refused.
 * → { at, category:'romance', action:'change', pinKeys, events } | null
 */
export function consequence(decision, committed = decision?.committed, state = null) {
  if (!isObj(decision) || !isObj(committed) || !Number.isSafeInteger(decision.id)) return null;
  const opt = committed.optionId;
  const arc = state?.story?.arcs?.[decision.arcId];
  if (!isObj(arc) || arc.status !== 'active' || arc.category !== 'romance') return null;
  const at = finite(committed.at) ? committed.at : null;
  if (at === null) return null;
  const partnerId = arc.castIds?.[0] ?? null;
  const commitEventId = Number.isSafeInteger(committed.eventId) ? committed.eventId : null;
  const base = { at, actor: 'engine', causeId: decision.id };
  let events = null;
  if (decision.kind === 'romance:step' && opt === 'step') {
    if (num(arc.stageAt) >= num(decision.opensAt, Infinity)) return null; // already moved since it opened
    const to = nextStage(arc.stage);
    if (!to) return null;
    events = [{ ...base, type: 'arc.stage', payload: { arcId: arc.id, from: arc.stage, to, reason: 'decision', commitEventId } }];
    if (partnerId) {
      events.push({ ...base, type: 'relationship.changed',
        payload: { castId: partnerId, delta: { commitment: STEP_COMMITMENT, passion: STEP_PASSION }, reason: 'decision', commitEventId } });
    }
  } else if (decision.kind === 'romance:breakup' && opt === 'end') {
    events = [{ ...base, type: 'arc.ended', payload: { arcId: arc.id, outcome: 'broken_up', commitEventId } }];
    if (partnerId) {
      events.push({ ...base, type: 'relationship.changed',
        payload: { castId: partnerId, delta: { closeness: -0.15, passion: -0.2, commitment: -0.2, tension: -0.1 }, reason: 'decision', commitEventId } });
    }
  }
  if (!events) return null;
  const pinKeys = [...new Set(events.flatMap(e => pinKeysFor(e, state)))];
  return { at, category: 'romance', action: 'change', pinKeys, events };
}
