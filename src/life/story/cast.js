import { dateKey, dayStart, atLocal } from '../clock.js';
import { rngFor as rngForDefault } from '../rng.js';
import { openDecision as openDecisionDefault } from '../decisions.js';
import { listEvents } from '../eventLog.js';
import { isExcludedId } from '../projector.js';
import { recordRefusal as recordRefusalDefault } from './store.js';
import { check as controlsCheck, fateOf, isPaused, pinOf, sliderFactor } from './controls.js';
import { dailyRomance, dailyDelta as romanceDelta } from './romance.js';
import { oneBeingOn, chatMadeDecision } from '../planWeight.js';

// The daily cast pass (spec 010 research R7): one code-only pulse due item per
// plan date, at plan.wakeAt + 5 min, plus the `back` item of an away trip.
// Story items run serialized with ticks and catch-up and are dated by world
// time, so a catch-up writes the same log as a live run.
//
// The daily item:
//   - is offered only when the story isn't paused (pause → no daily pass and no
//     story.daily_done; it runs for the current date once the pause lifts);
//   - evaluates every control verdict (fate, pins) when it is offered — in
//     dailyItems(), never inside run() — into a plan that run() just appends;
//   - ALWAYS appends `story.daily_done {date, rolls, counts}` last, even with
//     zero deltas, so it is never due twice for a date and never appends
//     nothing (plan review B2). It is not revertible: reverting one of its
//     relationship.changed events never re-runs the pass;
//   - writes `self` events with no cause (they aggregate numbers);
//   - is all-or-nothing: a refused append, or a decision open / roll that
//     throws after appending, aborts the pass (it throws; the story facade's
//     item wrapper reverts what it wrote and retires it). An open or a roll
//     that throws before writing anything is recorded as 'error' and the
//     pass goes on (counts.failed stays 0, kept for the payload shape).
//
// What it does, per member (sorted by id):
//   drift     closeness −0.004/day after 14 days without contact (floor 0.15,
//             family 0.35); shared time since the last pass +0.01 per 30 min
//             (≤ +0.05/day); tension −0.01/day toward 0; plus the romance part
//             (romance.dailyDelta). One relationship.changed per member with a
//             non-zero delta. After a gap, one aggregated event with `days`
//             (≤ 60); each delta is still clamped to ±0.2 by the reducer.
//   status    p = 0.15 × (0.5 + socialAppetite): a status line from the arc
//             seed's castStatus pool for their relation (family:* → family,
//             else `any`) — never text built in code.
//   away      p = 0.01: cast.beat {kind:'away', until: +2..7 d}; the `back`
//             beat is its own item at `until`.
//   history   a shared outing since the last pass (self/owner origin only, never
//             a chat-origin adopted one; not an everyday block; away from home)
//             → one cast.history_added "<kind> together", ≤ 2 per pass.
//   ≤ 2 status/away beats per pass (≤ cast + 4 events, plus the romance step,
//             late birthdays, decisions and the marker).
// Then late birthdays (each missed one once, `late: true`, after a re-anchor
// gap; 009 logs today's at wake), today's birthday decisions (closeness ≥ 0.5,
// p = 0.6: `social:birthday`, go|late|stay at a known place, else
// call|text|skip), the romance plan (romance.dailyRomance) and the rolls other
// modules contribute (deps.rolls: heavy, appraisal, family …), whose outcomes
// go into `rolls`.
//
// Pure planning over the projection; run() writes through `add` (the pulse's
// append), store.recordRefusal (deduped per hour; skipped under sim:true) and
// the injected openDecision.
//
// Earned trust (owner decision 2026-10-30). A member's `trust` moves only here
// (and by the owner's Director `cast.metrics`), as a `trust` delta in that
// member's one relationship.changed of the pass (the cast/beat verdict gates it
// with the drift; `trustWhy` lists the rule codes, biggest first; a trust-only
// change has the biggest code as its reason). Deterministic: read from the
// projection the pass plans on — decisions and arcs that closed in the window
// (the last pass's time, or a day back on the first pass, .. now) — plus two log
// reads when the item comes due (none under sim): the owner_cancelled
// decision.expired ids of that window, and for each decision he declined in it,
// whether any earlier decision.lean on it was go / attend. Only self/engine/owner causes count: a
// decision that carries a chat origin (an adopted plan, an invitation, a chat
// lean) moves nothing, and chat-origin shared time is not shared time (R7).
//   kept_plan        a plan with them that happened: committed go / late /
//                    attend, still committed when it ended in the window
//                    (could_not_go → `missed`, a cancel → `cancelled`):
//                    TRUST_KEPT, once per member per local date
//   declined         he chose stay / skip on a plan with them after an earlier
//                    lean on it was go / attend: TRUST_DECLINED. A plain decline
//                    (he never leaned go) costs nothing: saying no to an
//                    invitation is not unreliability (owner decision 2026-10-30)
//   backed_out       he reversed a go into stay (reversals > 0), or a committed
//                    go was cancelled (owner_cancelled: CANCEL TONIGHT, a goal
//                    cancel): TRUST_BACKED_OUT
//   occasion_skipped a family occasion's `skip` (OCCASION_DELTAS keeps its
//                    tension): TRUST_OCCASION_SKIP, instead of `declined`
//   broken_up / fizzled  a romance arc that ended so in the window:
//                    TRUST_BROKEN_UP / TRUST_FIZZLED for its cast. Nothing else
//                    in the catalogue is a breach of trust: beats (status, away,
//                    back, hobby, news, milestone, trip) are neutral, the heavy
//                    kinds (family_illness, friend_moving_away, pet_loss,
//                    minor_accident, money_setback; a heavy breakup ends the
//                    arc as broken_up, counted above) are nobody's fault, career
//                    arcs have no cast
//   tension          tension > TRUST_TENSION_AT: TRUST_TENSION_PER_DAY × days
//   steady           shared time ≥ TRUST_STEADY_MIN since the last pass:
//                    TRUST_STEADY, never above closeness + TRUST_STEADY_OVER_CLOSENESS
// A plan = a decision with them whose options include go or attend (so a
// romance "stay together" never counts) and that is no romance / career /
// heavy decision nor a family one other than an occasion. The net is clamped
// to ±TRUST_DAY_CAP × days (≤ the reducer's 0.2) and to trust's 0..1 range.
// Closed decisions are pruned 3 days after they close: a longer outage forgets
// their trust. Effects: decisions.js castAffinity adds TRUST_LEAN_W × (trust −
// 0.5) through the story's seam; a card for a member under TRUST_HINT_BELOW
// carries a short hint (fragment.castOverlay).

export const DAILY_OFFSET_SEC = 5 * 60;
export const DRIFT_PER_DAY = 0.004;
export const NO_CONTACT_DAYS = 14;
export const CLOSENESS_FLOOR = 0.15;
export const FAMILY_FLOOR = 0.35;
export const SHARED_PER_30 = 0.01;
export const SHARED_MAX_PER_DAY = 0.05;
export const TENSION_DECAY_PER_DAY = 0.01;
export const STATUS_P = 0.15;
export const AWAY_P = 0.01;
export const AWAY_DAYS = Object.freeze([2, 7]);
export const MAX_BEATS = 2;
export const MAX_GAP_DAYS = 60;
export const BIRTHDAY_CLOSENESS = 0.5;
export const BIRTHDAY_P = 0.6;
export const MAX_HISTORY_PER_PASS = 2;
// Earned trust (see the header).
export const TRUST_KEPT = 0.02;
export const TRUST_DECLINED = -0.01;
export const TRUST_BACKED_OUT = -0.04;
export const TRUST_BROKE_PROMISE = -0.05;   // 020: he gave his word (texts, an accepted invitation): the most a day can cost
export const TRUST_OCCASION_SKIP = -0.03;
export const TRUST_BROKEN_UP = -0.05;
export const TRUST_FIZZLED = -0.02;
export const TRUST_TENSION_AT = 0.5;
export const TRUST_TENSION_PER_DAY = -0.005;
export const TRUST_STEADY_MIN = 60;
export const TRUST_STEADY = 0.005;
export const TRUST_STEADY_OVER_CLOSENESS = 0.2;
export const TRUST_DAY_CAP = 0.05;
export const TRUST_LEAN_W = 0.25;
export const TRUST_HINT_BELOW = 0.3;
const TRUST_GO = new Set(['go', 'late', 'attend']);
const TRUST_DECLINE = new Set(['stay', 'skip']);
const TRUST_NOT_PLANS = new Set(['romance', 'career', 'heavy']);
const TRUST_ARC_END = Object.freeze({ broken_up: TRUST_BROKEN_UP, fizzled: TRUST_FIZZLED });
let trustOn = true;

/** False only in tests that compare against a pre-trust recording (the 012 golden run). */
export function trustEnabled() { return trustOn; }
export function __setTrustForTest(on) { trustOn = on !== false; }

/** Everyday blocks that never become a history entry (only outings do). */
export const ROUTINE_ACTIVITY_KINDS = Object.freeze(new Set(['work', 'meeting', 'commute', 'lunch', 'breakfast', 'dinner',
  'snack', 'sleep', 'free', 'sick', 'rest', 'tv', 'groceries', 'errand', 'call']));
const HISTORY_ORIGINS = new Set(['self', 'owner']);

const DAY = 86400;
const MIN = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const STATUS_MAX = 120;
const ROLL_KEYS_MAX = 12;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (finite(v) ? v : d);
const round4 = (v) => Math.round(v * 10000) / 10000;
const isFamily = (c) => String(c?.relation ?? '').startsWith('family');
const tzOf = (s, world) => s?.world?.timezone || world?.timezone;

// ── Pieces (pure) ─────────────────────────────────────────────────────────

/**
 * A status line from the arc seed's pool for this relation (family:* → family;
 * an empty or missing pool → `any`), never the current one. null when nothing
 * fits. `rng` is a rng.js generator.
 */
export function statusPick(rng, relation, seed, current = null) {
  const pools = isObj(seed?.castStatus) ? seed.castStatus : {};
  const rel = String(relation ?? '');
  const key = rel.startsWith('family') ? 'family' : rel;
  const list = (Array.isArray(pools[key]) && pools[key].length ? pools[key] : pools.any) || [];
  const cur = typeof current === 'string' ? current.trim().toLowerCase() : '';
  const pool = list.filter(x => typeof x === 'string' && x.trim() && x.length <= STATUS_MAX && x.trim().toLowerCase() !== cur);
  if (!pool.length || typeof rng !== 'function') return null;
  return pool[Math.floor(rng() * pool.length) % pool.length].trim();
}

function shiftDate(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Birthdays (his own: castId null) on dates strictly between fromDate and
 * toDate that were never logged (lastBirthdayAt not on that date), at most
 * MAX_GAP_DAYS back from toDate. [] when fromDate is null (first pass).
 * → [{ castId|null, date }] in date order.
 */
export function lateBirthdays(s, fromDate, toDate) {
  if (typeof fromDate !== 'string' || !DATE_RE.test(fromDate) || typeof toDate !== 'string' || !DATE_RE.test(toDate)) return [];
  if (fromDate >= toDate) return [];
  const tz = tzOf(s);
  const start = fromDate > shiftDate(toDate, -MAX_GAP_DAYS) ? fromDate : shiftDate(toDate, -MAX_GAP_DAYS - 1);
  const people = [{ castId: null, birthday: s?.self?.birthdate, last: s?.self?.lastBirthdayAt }];
  const ids = s?.cast instanceof Map ? [...s.cast.keys()].sort() : [];
  for (const id of ids) {
    const c = s.cast.get(id);
    people.push({ castId: id, birthday: c?.birthday, last: c?.lastBirthdayAt });
  }
  const out = [];
  for (let d = shiftDate(start, 1); d < toDate; d = shiftDate(d, 1)) {
    const md = d.slice(5);
    for (const p of people) {
      if (typeof p.birthday !== 'string' || p.birthday.slice(5) !== md) continue;
      if (finite(p.last) && dateKey(p.last, tz) === d) continue;
      out.push({ castId: p.castId, date: d });
    }
  }
  return out;
}

// Latest contact: the reducer's lastContactAt, or a committed decision with them
// (not one that carries a chat origin: its time would reach self-origin drift).
function lastContactOf(s, id) {
  let at = s?.story?.relationships?.[id]?.lastContactAt;
  at = finite(at) ? at : null;
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    if (d?.status !== 'committed' || !d.subject?.castIds?.includes?.(id)) continue;
    if (Array.isArray(d.origins) && d.origins.length) continue;
    const c = d.committed?.at;
    if (finite(c) && (at === null || c > at)) at = c;
  }
  return at;
}

function sharedMinutes(s, id, at) {
  const t = s?.story?.together?.[id];
  if (!isObj(t)) return 0;
  let min = num(t.minutesSinceDaily);
  if (finite(t.openSince) && at > t.openSince && !t.chat) min += (at - t.openSince) / 60;
  return Math.round(Math.min(1440, Math.max(0, min)));
}

/**
 * The numeric drift of one pass covering `days` days (≥ 1, ≤ 60) at `at`.
 * → [{ castId, sharedMin, noContactDays, cast:{closeness?, tension?, togetherMin?}, romance:{…}, reason, days }]
 * Members with no change are left out. Controls are the caller's.
 */
export function drift(s, days = 1, at = s?.at) {
  const n = Math.max(1, Math.min(MAX_GAP_DAYS, Math.floor(num(days, 1))));
  const out = [];
  if (!(s?.cast instanceof Map) || !finite(at)) return out;
  const base = finite(s.genesisAt) ? s.genesisAt : at;
  for (const id of [...s.cast.keys()].sort()) {
    const c = s.cast.get(id);
    const m = isObj(c?.metrics) ? c.metrics : {};
    const sharedMin = sharedMinutes(s, id, at);
    const contact = lastContactOf(s, id) ?? base;
    const noContactDays = sharedMin > 0 ? 0 : Math.max(0, Math.floor((at - contact) / DAY));
    const cast = {};
    const close = num(m.closeness, 0.5);
    let dc = 0;
    const decayDays = Math.min(n, Math.max(0, noContactDays - NO_CONTACT_DAYS));
    if (decayDays > 0) {
      const floor = isFamily(c) ? FAMILY_FLOOR : CLOSENESS_FLOOR;
      dc -= Math.min(DRIFT_PER_DAY * decayDays, Math.max(0, close - floor));
    }
    if (sharedMin > 0) dc += Math.min(SHARED_MAX_PER_DAY, SHARED_PER_30 * (sharedMin / 30), Math.max(0, 1 - close));
    if (round4(dc)) cast.closeness = round4(dc);
    const tension = num(m.tension);
    if (tension > 0) cast.tension = round4(-Math.min(tension, TENSION_DECAY_PER_DAY * n));
    if (sharedMin > 0) cast.togetherMin = sharedMin;
    const romance = romanceDelta(s, id, { sharedMin, noContactDays, days: n });
    if (!Object.keys(cast).length && !Object.keys(romance).length) continue;
    out.push({
      castId: id, sharedMin, noContactDays, cast, romance,
      reason: sharedMin > 0 ? 'shared_time' : n > 1 ? 'gap' : 'drift', days: n,
    });
  }
  return out;
}

// The plan kind of a decision for earned trust: 'plan' | 'occasion' | null (not a plan with people).
// 020: 'promise' = a plan made in a chat with someone from his world: only breaking it counts (below).
// A chat's nudge doesn't take his own plan out of trust: it's judged by where the plan was made.
function trustPlanKind(s, d) {
  if (!isObj(d)) return null;
  if (oneBeingOn()) {
    if (chatMadeDecision(d)) return d.invite === true || d.adopted === true ? 'promise' : null;
  } else {
    if (d.invite === true || d.adopted === true) return null;
    if (Array.isArray(d.origins) && d.origins.length) return null;
  }
  if (!Array.isArray(d.options) || !d.options.some(o => o?.id === 'go' || o?.id === 'attend')) return null;
  const cat = typeof d.category === 'string' ? d.category : '';
  if (TRUST_NOT_PLANS.has(cat)) return null;
  if (cat === 'family') return s?.story?.arcs?.[d.arcId]?.kind === 'occasion' ? 'occasion' : null;
  return 'plan';
}

function planEndOf(d) {
  const sub = isObj(d.subject) ? d.subject : {};
  if (finite(sub.endAt)) return sub.endAt;
  if (finite(sub.eventAt)) return sub.eventAt + (finite(sub.minutes) ? sub.minutes : 120) * MIN;
  return null;
}

/**
 * Earned trust of one pass (see the header): pure over the projection.
 * `cancelled` = ids of decisions whose decision.expired in the window was
 * owner_cancelled; `leanedGo` = ids of declined decisions that leaned go /
 * attend before (declinedLeanedGo). → Map(castId → { delta, why: [codes, biggest first] }),
 * only members with a non-zero net change, ids in sorted order.
 */
export function earnedTrust(s, { at = s?.at, days = 1, world = null, cancelled = [], leanedGo = [] } = {}) {
  const out = new Map();
  if (!trustOn || !(s?.cast instanceof Map) || !finite(at)) return out;
  const n = Math.max(1, Math.min(MAX_GAP_DAYS, Math.floor(num(days, 1))));
  const from = finite(s.story?.daily?.lastAt) ? s.story.daily.lastAt : at - DAY;
  const inWindow = (t) => finite(t) && t > from && t <= at;
  const tz = tzOf(s, world);
  const cancelledIds = new Set(Array.isArray(cancelled) ? cancelled : []);
  const leanedGoIds = new Set(Array.isArray(leanedGo) ? leanedGo : []);
  const parts = new Map();   // castId → { code: amount }
  const add = (id, code, v) => {
    if (!s.cast.has(id)) return;
    const p = parts.get(id) ?? {};
    p[code] = round4((p[code] ?? 0) + v);
    parts.set(id, p);
  };
  const kept = new Map();    // castId → Set(local dates)
  const decisions = s.decisions instanceof Map ? [...s.decisions.values()].sort((a, b) => a.id - b.id) : [];
  for (const d of decisions) {
    const kind = trustPlanKind(s, d);
    if (!kind) continue;
    const ids = (Array.isArray(d.subject?.castIds) ? d.subject.castIds : []).filter(id => typeof id === 'string' && s.cast.has(id));
    if (!ids.length) continue;
    const opt = d.committed?.optionId;
    if (kind === 'promise') {
      // He gave his word in a chat, and took it back himself; the owner's own change costs nothing here.
      if (d.status === 'committed' && TRUST_DECLINE.has(opt) && num(d.reversals) > 0 && d.committed?.by !== 'owner' && inWindow(d.committed?.at)) {
        for (const id of ids) add(id, 'broke_promise', TRUST_BROKE_PROMISE);
      }
      continue;
    }
    if (d.status === 'committed' && TRUST_GO.has(opt)) {
      const end = planEndOf(d);
      if (!inWindow(end)) continue;
      const date = dateKey(end, tz);
      for (const id of ids) {
        const seen = kept.get(id) ?? new Set();
        if (seen.has(date)) continue;
        seen.add(date);
        kept.set(id, seen);
        add(id, 'kept_plan', TRUST_KEPT);
      }
    } else if (d.status === 'committed' && TRUST_DECLINE.has(opt)) {
      if (!inWindow(d.committed?.at)) continue;
      const [code, v] = kind === 'occasion' ? ['occasion_skipped', TRUST_OCCASION_SKIP]
        : num(d.reversals) > 0 ? (d.committed?.by === 'text' || d.committed?.by === 'scene' ? ['broke_promise', TRUST_BROKE_PROMISE] : ['backed_out', TRUST_BACKED_OUT])
        : ['declined', TRUST_DECLINED];
      if (kind === 'occasion' && opt !== 'skip') continue;
      if (code === 'declined' && !leanedGoIds.has(d.id)) continue;   // a plain decline costs nothing
      for (const id of ids) add(id, code, v);
    } else if (d.status === 'cancelled' && TRUST_GO.has(opt) && cancelledIds.has(d.id) && inWindow(d.closedAt)) {
      for (const id of ids) add(id, 'backed_out', TRUST_BACKED_OUT);
    }
  }
  for (const a of Object.values(isObj(s.story?.arcs) ? s.story.arcs : {})) {
    if (a?.category !== 'romance' || a.status !== 'ended' || !inWindow(a.endedAt) || !Object.hasOwn(TRUST_ARC_END, a.outcome)) continue;
    for (const id of Array.isArray(a.castIds) ? a.castIds : []) add(id, a.outcome, TRUST_ARC_END[a.outcome]);
  }
  for (const id of [...s.cast.keys()].sort()) {
    const m = isObj(s.cast.get(id)?.metrics) ? s.cast.get(id).metrics : {};
    const trust = num(m.trust, 0.5);
    if (num(m.tension) > TRUST_TENSION_AT) add(id, 'tension', TRUST_TENSION_PER_DAY * n);
    if (sharedMinutes(s, id, at) >= TRUST_STEADY_MIN) {
      const room = Math.min(1, num(m.closeness, 0.5) + TRUST_STEADY_OVER_CLOSENESS) - trust;
      if (room > 0) add(id, 'steady', Math.min(TRUST_STEADY, room));
    }
    const p = parts.get(id);
    if (!p) continue;
    const cap = Math.min(TRUST_DAY_CAP * n, 0.2);
    const sum = Object.values(p).reduce((x, y) => x + y, 0);
    const delta = round4(Math.max(-trust, Math.min(1 - trust, Math.max(-cap, Math.min(cap, sum)))));
    if (!delta) continue;
    const why = Object.entries(p).filter(([, v]) => v).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]) || (x[0] < y[0] ? -1 : 1)).map(([k]) => k);
    out.set(id, { delta, why });
  }
  return out;
}

/** A short code-built card hint for a member he can't quite count on, or null. */
export function trustHint(member) {
  const t = member?.metrics?.trust;
  if (!trustOn || !finite(t) || t >= TRUST_HINT_BELOW) return null;
  const pron = String(member?.pronouns ?? '').toLowerCase();
  const obj = /^she\b/.test(pron) ? 'her' : /^he\b/.test(pron) ? 'him' : 'them';
  return `not sure you can count on ${obj}`;
}

// A small, JSON-safe roll outcome (strings/numbers/booleans, or a flat object of them).
function cleanRoll(v) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return finite(v) ? round4(v) : null;
  if (typeof v === 'string') return v.slice(0, 60);
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, ROLL_KEYS_MAX)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) continue;
      const c = typeof x === 'object' && x !== null ? null : cleanRoll(x);
      if (c !== undefined && c !== null) out[k] = c;
    }
    return out;
  }
  return null;
}

/**
 * Shared outings since the last pass that may become a history entry (R7): a
 * self/owner-origin activity.started (never a chat-origin, adopted outing — that
 * would put chat content in a cast card), not excluded, away from home, not an
 * everyday block, with the member in withCast. The longest per member, at most
 * MAX_HISTORY_PER_PASS members. `events` are activity.started rows.
 * → [{ castId, text, dated, eventId }] — text is a kind word built in code ("movie together").
 */
export function historyEntries(s, events = []) {
  const best = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== 'activity.started' || !HISTORY_ORIGINS.has(e.originKind) || isExcludedId(s, e.id)) continue;
    const p = isObj(e.payload) ? e.payload : {};
    const kind = typeof p.kind === 'string' ? p.kind.toLowerCase() : '';
    if (!/^[a-z][a-z0-9_-]{1,23}$/.test(kind) || ROUTINE_ACTIVITY_KINDS.has(kind)) continue;
    if (!p.placeId || p.placeId === s?.self?.homePlaceId) continue;
    const len = num(p.end ?? p.until, e.at) - num(p.start, e.at);
    for (const id of Array.isArray(p.withCast) ? p.withCast : []) {
      if (!(s?.cast instanceof Map) || !s.cast.has(id)) continue;
      const cur = best.get(id);
      if (!cur || len > cur.len) best.set(id, { castId: id, len, text: `${kind.replace(/[-_]+/g, ' ')} together`, dated: e.at, eventId: e.id });
    }
  }
  return [...best.values()].sort((a, b) => b.len - a.len || (a.castId < b.castId ? -1 : 1))
    .slice(0, MAX_HISTORY_PER_PASS).map(({ len, ...x }) => x);
}

function activitiesSince(s, at, deps) {
  if (deps.sim === true && typeof deps.listActivities !== 'function') return []; // preview tomorrow: no I/O
  const from = finite(s?.story?.daily?.lastAt) ? s.story.daily.lastAt + 1 : at - DAY;
  const fn = typeof deps.listActivities === 'function' ? deps.listActivities
    : (a, b) => listEvents({ types: ['activity.started'], from: a, to: b, limit: 200 });
  try { return fn(from, at) || []; } catch { return []; }
}

// Ids of decisions an owner cancel closed since the last pass (earned trust's
// backed_out): one decision.expired read when the item comes due; none under sim.
function cancelledSince(s, at, deps) {
  if (!trustOn || (deps.sim === true && typeof deps.listCancelled !== 'function')) return [];
  const from = finite(s?.story?.daily?.lastAt) ? s.story.daily.lastAt + 1 : at - DAY;
  const fn = typeof deps.listCancelled === 'function' ? deps.listCancelled
    : (a, b) => listEvents({ types: ['decision.expired'], from: a, to: b, limit: 500 })
      .filter(e => e?.payload?.reason === 'owner_cancelled' && !isExcludedId(s, e.id))
      .map(e => e.payload.decisionId);
  try { return (fn(from, at) || []).filter(id => Number.isSafeInteger(id)); } catch { return []; }
}

/**
 * Ids of the plans he declined in this pass's window (committed stay / skip, no
 * reversal, no chat origin) whose decision.lean history, from their opening to
 * the commit, has a go / attend lean — the only declines that cost trust. One
 * bounded log read per such decision when the item comes due; none under sim.
 */
export function declinedLeanedGo(s, at, deps = {}) {
  if (!trustOn || !finite(at) || (deps.sim === true && typeof deps.listLeans !== 'function')) return [];
  const from = finite(s?.story?.daily?.lastAt) ? s.story.daily.lastAt : at - DAY;
  const fn = typeof deps.listLeans === 'function' ? deps.listLeans
    : (d, a, b) => listEvents({ types: ['decision.lean'], from: a, to: b, limit: 500 })
      .filter(e => e?.payload?.decisionId === d.id && !isExcludedId(s, e.id));
  const out = [];
  const list = s?.decisions instanceof Map ? [...s.decisions.values()].sort((a, b) => a.id - b.id) : [];
  for (const d of list) {
    const c = d?.committed;
    if (d?.status !== 'committed' || !TRUST_DECLINE.has(c?.optionId) || num(d.reversals) > 0) continue;
    if (!finite(c.at) || !(c.at > from && c.at <= at) || trustPlanKind(s, d) !== 'plan') continue;
    const since = finite(d.opensAt) ? d.opensAt : c.at - 3 * DAY;
    try {
      if ((fn(d, since, c.at) || []).some(e => e?.payload?.optionId === 'go' || e?.payload?.optionId === 'attend')) out.push(d.id);
    } catch { /* unknown → a plain decline: no trust change */ }
  }
  return out;
}

// ── Plan (pure; every control verdict is taken here) ──────────────────────

function verdict(s, refusals, { category, action, pinKeys, target }) {
  const v = controlsCheck({ source: 'engine', category, action, pinKeys }, s);
  if (!v.ok) refusals.push({ source: 'engine', category, action, target, reason: v.reason, pinKey: v.pinKey ?? null });
  return v;
}

function birthdayPlace(s, c) {
  const home = typeof c?.home === 'string' && PLACE_ID_RE.test(c.home) ? c.home : null;
  if (home && home !== s?.self?.homePlaceId && s?.places instanceof Map && s.places.has(home)) return home;
  return null;
}

function birthdaySpec(s, c, at, world, tz) {
  const d0 = dayStart(at, tz);
  const eventAt = atLocal(d0, '19:30', tz);
  if (!(eventAt > at + 2 * 3600)) return null;
  const place = birthdayPlace(s, c);
  const name = String(c.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'them';
  const salary = num(world?.money?.salary);
  const spend = salary > 0 ? Math.round(salary * 0.005) : 0;
  const options = place
    ? [
      { id: 'go', label: `Go to ${name}'s birthday`, go: true, kind: 'social', spend, fun: 5 },
      { id: 'late', label: `Drop by ${name}'s birthday later`, go: 'late', kind: 'social', minutes: 60, spend, fun: 3 },
      { id: 'stay', label: 'Stay in and rest', kind: 'rest' },
    ]
    : [
      { id: 'call', label: `Call ${name} for the birthday`, kind: 'social', minutes: 20, fun: 3 },
      { id: 'text', label: `Text ${name} a birthday wish`, kind: 'rest', minutes: 5, fun: 1 },
      { id: 'skip', label: 'Let it pass', kind: 'rest', minutes: 0 },
    ];
  return {
    kind: 'social:birthday', category: 'social',
    subject: { eventAt, placeId: place, castIds: [c.id], minutes: 120 },
    options,
  };
}

function birthdayOpenToday(s, id, date, tz) {
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    if (d?.kind === 'social:birthday' && d.subject?.castIds?.includes?.(id) && finite(d.opensAt) && dateKey(d.opensAt, tz) === date) return true;
  }
  return false;
}

/**
 * Everything one daily pass will do, decided now (controls included).
 * → { date, at, days, events, decisions: [{spec, causeId, roll}], refusals, rolls, counts }
 */
export function planDaily(s, { date, at, world, seed = null, rngFor = rngForDefault, activities = [], cancelled = [], leanedGo = [] } = {}) {
  const tz = tzOf(s, world);
  const st = s.story;
  const last = st?.daily?.lastDate ?? null;
  const days = last && DATE_RE.test(last) && last < date
    ? Math.min(MAX_GAP_DAYS, Math.max(1, Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / (DAY * 1000))))
    : 1;
  const out = { date, at, days, events: [], decisions: [], refusals: [], rolls: {}, counts: { drift: 0, beats: 0, late: 0 } };
  const castFrozen = fateOf('cast', s) === 'frozen';

  // Late birthdays first (they are 009 facts, not beats: logged once, late).
  for (const b of lateBirthdays(s, last, date)) {
    out.events.push({ type: 'birthday', at, actor: 'engine', payload: { ...(b.castId ? { castId: b.castId } : {}), late: true, date: b.date } });
    out.counts.late++;
  }

  // Drift + shared time + romance metrics + earned trust: one relationship.changed per member.
  const drifts = new Map(drift(s, days, at).map(d => [d.castId, d]));
  const trusts = earnedTrust(s, { at, days, world, cancelled, leanedGo });
  for (const id of [...new Set([...drifts.keys(), ...trusts.keys()])].sort()) {
    const d = drifts.get(id) ?? { castId: id, cast: {}, romance: {}, reason: null, days };
    const tr = trusts.get(id) ?? null;
    const target = id;
    const pinKeys = [id];
    let delta = {};
    let trustWhy = null;
    if (Object.keys(d.cast).length || tr) {
      const v = verdict(s, out.refusals, { category: 'cast', action: 'beat', pinKeys, target });
      if (v.ok) {
        delta = { ...delta, ...d.cast };
        if (tr) { delta.trust = tr.delta; trustWhy = tr.why; }
      }
    }
    if (Object.keys(d.romance).length) {
      const v = verdict(s, out.refusals, { category: 'romance', action: 'beat', pinKeys, target });
      if (v.ok) delta = { ...delta, ...d.romance };
    }
    if (!Object.keys(delta).length) continue;
    const reason = d.reason ?? (trustWhy && Object.keys(delta).length === 1 ? trustWhy[0] : 'drift');
    out.events.push({
      type: 'relationship.changed', at, actor: 'engine',
      payload: { castId: id, delta, reason, ...(trustWhy ? { trustWhy } : {}), ...(d.days > 1 ? { days: d.days } : {}) },
    });
    if (drifts.has(id)) out.counts.drift++;
    if (trustWhy) out.counts.trust = (out.counts.trust ?? 0) + 1;
  }

  // History: one short entry per member for a shared (self/owner-origin) outing.
  if (!castFrozen) {
    for (const h of historyEntries(s, activities)) {
      if (!verdict(s, out.refusals, { category: 'cast', action: 'beat', pinKeys: [h.castId], target: h.castId }).ok) continue;
      out.events.push({ type: 'cast.history_added', at, actor: 'engine', payload: { castId: h.castId, text: h.text, dated: h.dated } });
      out.counts.history = (out.counts.history ?? 0) + 1;
    }
  }

  // Status lines and away trips (≤ MAX_BEATS per pass).
  const ids = s.cast instanceof Map ? [...s.cast.keys()].sort() : [];
  const statusP = STATUS_P * sliderFactor('socialAppetite', s);
  for (const id of ids) {
    if (out.counts.beats >= MAX_BEATS || castFrozen) break;
    const c = s.cast.get(id);
    const life = st?.castLife?.[id];
    const away = finite(life?.away?.until) && life.away.until > at;
    const rs = rngFor(date, `story:status:${id}`);
    if (rs() < statusP) {
      const text = statusPick(rs, c?.relation, seed, c?.status);
      if (text && verdict(s, out.refusals, { category: 'cast', action: 'beat', pinKeys: [id], target: id }).ok) {
        out.events.push({ type: 'cast.updated', at, actor: 'engine', payload: { castId: id, fields: { status: text }, reason: 'status_rotate' } });
        out.counts.beats++;
        continue;
      }
    }
    if (away || out.counts.beats >= MAX_BEATS) continue;
    const ra = rngFor(date, `story:away:${id}`);
    if (ra() < AWAY_P && verdict(s, out.refusals, { category: 'cast', action: 'beat', pinKeys: [id], target: id }).ok) {
      const until = at + (AWAY_DAYS[0] + Math.min(AWAY_DAYS[1] - AWAY_DAYS[0], Math.floor(ra() * (AWAY_DAYS[1] - AWAY_DAYS[0] + 1)))) * DAY;
      out.events.push({ type: 'cast.beat', at, actor: 'engine', payload: { castId: id, kind: 'away', until } });
      out.counts.beats++;
    }
  }

  // Romance: onset roll, fizzle, a step or breakup decision.
  const rom = dailyRomance(s, { at, date, seed, rngFor });
  out.rolls.romance = rom.outcome;
  out.events.push(...rom.events);
  out.refusals.push(...rom.refusals);
  for (const d of rom.decisions) out.decisions.push({ spec: d.spec, causeId: null, roll: 'romanceDecision' });

  // Today's birthdays may open a small timed decision.
  const md = date.slice(5);
  for (const id of ids) {
    const c = s.cast.get(id);
    if (typeof c?.birthday !== 'string' || c.birthday.slice(5) !== md) continue;
    if (num(c.metrics?.closeness, 0.5) < BIRTHDAY_CLOSENESS || birthdayOpenToday(s, id, date, tz)) continue;
    if (!(rngFor(date, `story:birthday:${id}`)() < BIRTHDAY_P)) { out.rolls.birthday = out.rolls.birthday ?? 'no'; continue; }
    const spec = birthdaySpec(s, c, at, world, tz);
    if (!spec) continue;
    if (!verdict(s, out.refusals, { category: 'social', action: 'decision', pinKeys: [id], target: id }).ok) continue;
    out.decisions.push({ spec, causeId: null, roll: 'birthday' });
  }
  return out;
}

// ── Items ─────────────────────────────────────────────────────────────────

/**
 * Story due items of the cast pass for the pulse (story-api §1 items(); R7):
 * the daily item for the current plan date and each due `back` beat. [] while
 * paused or without a story slice.
 *
 * deps (all optional):
 *   getState()            fresh projection for decision opening (default: the given s)
 *   openDecision(state, spec, ctx)   default decisions.openDecision; the facade
 *                         passes decisionsGlue.openArcDecision (big/guided → ask)
 *   recordRefusal(row)    default store.recordRefusal (skipped under sim)
 *   rolls                 { name: async ({ state, add, at, date, world, seed, sim }) → outcome }
 *                         rolls from other modules (heavy, appraisal, family), run in
 *                         name order inside the item; each outcome lands in daily_done.rolls
 *   rngFor(date, purpose) default rng.js rngFor
 *   listActivities(from, to)  activity.started rows since the last pass (default eventLog.listEvents),
 *                         read once when the item comes due; feeds the history entries
 *   listCancelled(from, to)   ids of decisions an owner_cancelled decision.expired closed
 *                         since the last pass (default: the log, minus excluded rows); earned trust
 *   listLeans(decision, from, to)  that decision's decision.lean rows (default: the log, minus
 *                         excluded rows); earned trust (a decline costs only after a go lean)
 *   sim                   true → no refusal rows, no decision opens (preview tomorrow)
 *   prio                  item priority (default 9, after 009's own items)
 */
export function dailyItems(s, g, world, seed, deps = {}) {
  const out = [];
  const st = s?.story;
  if (!isObj(st) || s.genesisAt === null || s.genesisAt === undefined || !finite(g)) return out;
  if (isPaused(s)) return out;
  const prio = finite(deps.prio) ? deps.prio : 9;
  const sim = deps.sim === true;

  // `back` beats: one item per member whose away trip has ended.
  for (const [id, life] of Object.entries(st.castLife || {})) {
    const until = life?.away?.until;
    if (!finite(until) || until > g || !(s.cast instanceof Map) || !s.cast.has(id)) continue;
    if (fateOf('cast', s) === 'frozen' || pinOf(id, s)) continue;
    const at = Math.max(until, num(s.at, until));
    out.push({
      at, prio, label: 'cast:back', id, key: `cast:back|${id}|${until}`,
      run: (add) => { add({ type: 'cast.beat', at, actor: 'engine', payload: { castId: id, kind: 'back' } }); },
    });
  }

  const plan = s.plan;
  const date = typeof plan?.date === 'string' && DATE_RE.test(plan.date) ? plan.date : null;
  const last = st.daily?.lastDate ?? null;
  if (!date || !finite(plan.wakeAt) || (last !== null && last >= date)) return out;
  const at = Math.max(plan.wakeAt + DAILY_OFFSET_SEC, num(s.at, 0));
  if (at > g) return out;
  const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
  const p = planDaily(s, { date, at, world, seed, rngFor: rf, activities: activitiesSince(s, at, deps),
    cancelled: cancelledSince(s, at, deps), leanedGo: declinedLeanedGo(s, at, deps) });
  out.push({ at, prio, label: 'daily', id: date, run: (add) => runDaily(p, s, add, world, seed, deps, sim) });
  return out;
}

// All-or-nothing (the story facade's item wrapper reverts what a failed pass
// wrote): any append that throws aborts the pass, and so does a decision open or
// a roll that throws after appending. One that throws before writing anything
// is only recorded ('error'): nothing of it is half-applied.
async function runDaily(p, s, add, world, seed, deps, sim) {
  const counts = { events: 0, failed: 0, ...p.counts, decisions: 0 };
  const rolls = { ...p.rolls };
  const record = typeof deps.recordRefusal === 'function' ? deps.recordRefusal : recordRefusalDefault;
  if (!sim) {
    for (const r of p.refusals) {
      try { record({ ...r, at: p.at }); } catch { /* an operational log, never the pass */ }
    }
  }
  for (const ev of p.events) {
    add(ev);
    counts.events++;
  }
  let wrote = 0;
  const counted = (spec) => { const ev = add(spec); wrote++; return ev; };
  const guarded = async (fn) => {
    const before = wrote;
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (wrote > before) throw err;
      return { ok: false };
    }
  };
  const getState = typeof deps.getState === 'function' ? deps.getState : () => s;
  const open = typeof deps.openDecision === 'function' ? deps.openDecision : openDecisionDefault;
  for (const d of p.decisions) {
    if (sim) { rolls[d.roll] = 'sim'; continue; }
    const r = await guarded(() => open(getState, d.spec, { world, at: p.at, append: counted, causeId: d.causeId ?? null }));
    rolls[d.roll] = r.ok ? 'opened' : 'error';
    if (r.ok) counts.decisions++;
  }
  const extra = isObj(deps.rolls) ? deps.rolls : {};
  for (const name of Object.keys(extra).sort()) {
    if (typeof extra[name] !== 'function' || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name)) continue;
    const r = await guarded(async () => cleanRoll(await extra[name]({ state: getState(), add: counted, at: p.at, date: p.date, world, seed, sim })));
    rolls[name] = r.ok ? (r.value ?? 'none') : 'error';
  }
  add({
    type: 'story.daily_done', at: p.at, actor: 'engine',
    payload: { date: p.date, rolls, counts: { events: counts.events, beats: counts.beats, drift: counts.drift, history: counts.history ?? 0, late: counts.late, decisions: counts.decisions, failed: counts.failed, days: p.days, ...(counts.trust ? { trust: counts.trust } : {}) } },
  });
}
