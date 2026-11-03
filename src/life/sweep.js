// The nightly plot-hole sweep (plan 020 §E1): every bug a human caught becomes a permanent
// check. Pure rules over log reads, imported by the life facade alone; the facade hands in
// the readers, runs it once a night (live only, never in a simulation) and on demand, and
// stores the findings. It appends nothing to world_events and calls no model. Findings go
// to the dashboard only (owner decision): nothing is ever sent anywhere.
//
// A finding = { fp, rule, severity, at, eventIds, text }. text is code-built plain words: no
// chat text, no JID, no real name; a plan from a chat is only "a plan from a chat". fp is
// the rule + its events, so the same hole seen on two nights is one finding and a dismissed
// one stays dismissed.
//
// Reverted, rewound and redacted events never count (live() below). Rules read a window of
// the log; a rule that needs a longer look (money per period, a decision opened earlier)
// reads further back on its own.
//
// What the rules can't see (said plainly on the dashboard's guide too):
//   text_plan         the cue is a short list of phrasings, so a text in other words isn't seen. For a
//                     turn older than the plan step's ring (`since`), it may have been a refusal: info.
//   scene_afterwards  only the sheet's "afterwards" lines are checked, never the scene's prose.
//   scene_own_decision  which decision a scene belongs to, not how its words read.
import crypto from 'crypto';
import { dateKey, dayLabel, localParts, hhmm } from './clock.js';
import { moneyOf, WALLET_TYPES } from './wallet.js';
import { planBlockDecision } from './eventLog.js';
import { foldDecisions, chatMade, endedOnGo, outingWindow, wentFor, optionOf, planStepOn } from './decisionLog.js';

export const RULES = Object.freeze([
  'spend_once', 'salary_once', 'recurring_once', 'wallet_money', 'scene_own_decision', 'text_plan',
  'two_places', 'phone_with_someone', 'go_happened', 'scene_afterwards', 'interview_attended', 'open_promise',
]);
export const SEVERITIES = Object.freeze(['high', 'warn', 'info']);

export const FINDINGS_MAX = 100;
export const DISMISSED_MAX = 300;
export const RETAIN_SEC = 14 * 86400;      // a finding nobody dismissed goes after this
export const WINDOW_MAX_SEC = 14 * 86400;  // the longest look back (first run, catch-up, on demand)
export const OVERLAP_SEC = 24 * 3600;      // each run re-reads a day of the last run's window
const LOOKBACK_SEC = 12 * 3600;            // what began before the window (an overnight outing)
const PERIOD_LOOKBACK_SEC = 40 * 86400;    // salary / rent / bills are once a month
const DECISION_LOOKBACK_SEC = 14 * 86400;
const OVERLAP_TOLERANCE_SEC = 5 * 60;
const MONEY_TOLERANCE = 1;
const TEXT_MAX = 240;
const EVENT_IDS_MAX = 8;
const EVENING_HOUR = 18;

// His phone (phone/worker.js waitFor, ownerSessionAsk): the owner's chat rules, mirrored.
const OWNER_SESSION_SEC = 90 * 60;
const OWNER_LIVE_SEC = 45 * 60;
const OWNER_SESSION_MAX_SEC = 6 * 3600;

// text_plan: how far a meeting may be from a strong "on my way" turn.
const PLAN_BEFORE_SEC = 6 * 3600;
const PLAN_AFTER_SEC = 36 * 3600;
const SEEN_BEFORE_SEC = 3600;
const SEEN_AFTER_SEC = 6 * 3600;

const MOVE_TYPES = ['activity.started', 'activity.ended', 'travel.started', 'travel.arrived', 'sleep.started', 'woke',
  'world.reanchored', 'world.rewound', 'self.moved', 'change.applied'];
const DECISION_TYPES = ['decision.opened', 'decision.lean', 'decision.committed', 'decision.reversed', 'decision.expired'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const JID_RE = /@(?:s\.whatsapp\.net|lid|g\.us)\b/;

/** The stable id of a finding: its rule + its events (or `extra`, for a finding with no event of its own). */
export function fingerprint(rule, eventIds, extra = '') {
  const ids = [...new Set(eventIds)].sort((a, b) => a - b).join(',');
  return crypto.createHash('sha256').update(`${rule}|${ids}|${extra}`).digest('hex').slice(0, 32);
}

function finding(rule, severity, at, eventIds, text, extra = '') {
  const ids = [...new Set(eventIds.filter(posInt))].sort((a, b) => a - b).slice(0, EVENT_IDS_MAX);
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return {
    fp: fingerprint(rule, ids, extra), rule, severity, at: finite(at) ? Math.round(at) : 0, eventIds: ids,
    // A code-built line never holds one; this is the backstop, not the rule.
    text: JID_RE.test(clean) ? 'See the events listed.' : clean.slice(0, TEXT_MAX),
  };
}

/** Which night a run at `at` covers, or null when none is due. */
export function nightDue(lastNight, at, tz, asleep) {
  const today = dateKey(at, tz);
  const yesterday = dateKey(at - 86400, tz);
  const last = typeof lastNight === 'string' ? lastNight : '';
  if (asleep === true && localParts(at, tz).hour >= EVENING_HOUR && last < today) return today;
  // First tick after midnight (or the first one back after downtime): one run, whatever was missed.
  if (last < yesterday) return yesterday;
  return null;
}

/** The window of a run. */
export function windowOf(lastRunAt, at, { full = false } = {}) {
  const oldest = at - WINDOW_MAX_SEC;
  if (full || !finite(lastRunAt)) return { from: oldest, to: at };
  return { from: Math.max(oldest, lastRunAt - OVERLAP_SEC), to: at };
}

// ── spans: where his body was ───────────────────────────────────────────────

/**
 * Live move events → intervals, ended by what really ended them: an activity's own
 * activity.ended (it names its start), a trip's travel.arrived, a sleep's woke; else the next
 * thing he started, a re-anchor (downtime), else its planned end, no later than now.
 */
export function buildSpans(events, at) {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const endedBy = new Map();
  for (const e of sorted) {
    if ((e.type === 'activity.ended' || e.type === 'travel.arrived') && posInt(e.causeId) && !endedBy.has(e.causeId)) endedBy.set(e.causeId, e);
  }
  const activities = [];
  const trips = [];
  const sleeps = [];
  let act = null;
  let trip = null;
  let sleep = null;
  const closeAct = (t) => { if (act) { act.end = act.end ?? Math.max(act.start, t); act = null; } };
  const closeTrip = (t) => { if (trip) { trip.end = trip.end ?? Math.max(trip.start, t); trip = null; } };
  const closeSleep = (t) => { if (sleep) { sleep.end = Math.max(sleep.start, t); sleep = null; } };
  for (const e of sorted) {
    switch (e.type) {
      case 'activity.started': {
        closeAct(e.at);
        act = {
          id: e.id, start: e.at, end: endedBy.get(e.id)?.at ?? null, planned: e.payload?.end ?? null, kind: e.payload?.kind ?? null,
          placeId: typeof e.payload?.placeId === 'string' ? e.payload.placeId : null,
          withCast: Array.isArray(e.payload?.withCast) ? e.payload.withCast : [],
        };
        activities.push(act);
        break;
      }
      case 'travel.started': {
        closeAct(e.at);
        closeTrip(e.at);
        trip = {
          id: e.id, start: e.at, end: endedBy.get(e.id)?.at ?? null,
          planned: finite(e.payload?.minutes) ? e.at + e.payload.minutes * 60 : null,
          from: e.payload?.from ?? null, to: e.payload?.to ?? null,
        };
        trips.push(trip);
        break;
      }
      case 'sleep.started':
        closeAct(e.at);
        closeSleep(e.at);
        sleep = { id: e.id, start: e.at, end: null };
        sleeps.push(sleep);
        break;
      case 'woke':
        closeSleep(e.at);
        break;
      case 'world.reanchored':
        closeAct(e.at);
        closeTrip(e.at);
        closeSleep(e.at);
        break;
      default:
    }
  }
  const finish = (x) => { if (x.end === null || x.end === undefined) x.end = Math.max(x.start, Math.min(finite(x.planned) ? x.planned : at, at)); };
  activities.forEach(finish);
  trips.forEach(finish);
  sleeps.forEach(finish);
  return { activities, trips, sleeps };
}

const overlapSec = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

// ── the rules ───────────────────────────────────────────────────────────────

const company = (x) => (Array.isArray(x) ? [...x].sort().join(',') : '');

function ruleSpendOnce(ctx) {
  // pulse's chargedBefore, read back: the same block started twice, both still in the projection, both paid.
  const spends = ctx.read(ctx.from - LOOKBACK_SEC, ctx.to, ['money.spent'])
    .filter(e => ['outing', 'food'].includes(e.payload?.for) && posInt(e.causeId));
  const paid = [];
  const byCause = new Map();
  for (const e of spends) {
    if (!byCause.has(e.causeId)) byCause.set(e.causeId, []);
    byCause.get(e.causeId).push(e);
  }
  const out = [];
  for (const [causeId, list] of byCause) {
    const start = ctx.live(ctx.eventOf(causeId));
    if (!start || start.type !== 'activity.started') continue;
    paid.push({ start, spend: list[0] });
    if (list.length > 1) {
      out.push(finding('spend_once', 'high', start.at, [start.id, ...list.map(e => e.id)],
        `One ${ctx.kindWord(start.payload?.kind)} at ${hhmm(start.at, ctx.tz)} was charged ${list.length} times.`));
    }
  }
  paid.sort((a, b) => a.start.at - b.start.at || a.start.id - b.start.id);
  for (let i = 0; i < paid.length; i++) {
    const a = paid[i].start;
    const aEnd = finite(a.payload?.end) ? a.payload.end : a.at;
    for (let j = i + 1; j < paid.length; j++) {
      const b = paid[j].start;
      if (b.at >= aEnd) break;
      if (b.payload?.kind !== a.payload?.kind || (b.payload?.placeId ?? null) !== (a.payload?.placeId ?? null)) continue;
      if (company(b.payload?.withCast) !== company(a.payload?.withCast)) continue;
      out.push(finding('spend_once', 'high', b.at, [a.id, b.id, paid[i].spend.id, paid[j].spend.id],
        `The same ${ctx.kindWord(a.payload?.kind)} was paid for twice: it started at ${hhmm(a.at, ctx.tz)}, started again at ${hhmm(b.at, ctx.tz)}, and both charges stand.`));
    }
  }
  return out;
}

function ruleSalaryOnce(ctx) {
  const rows = ctx.read(ctx.from - PERIOD_LOOKBACK_SEC, ctx.to, ['money.salary']);
  const byMonth = new Map();
  for (const e of rows) {
    const month = typeof e.payload?.month === 'string' ? e.payload.month : dateKey(e.at, ctx.tz).slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(e);
  }
  const out = [];
  for (const [month, list] of byMonth) {
    if (list.length > 1) out.push(finding('salary_once', 'high', list[1].at, list.map(e => e.id), `Salary was paid ${list.length} times for ${month}.`));
  }
  return out;
}

function ruleRecurringOnce(ctx) {
  const rows = ctx.read(ctx.from - PERIOD_LOOKBACK_SEC, ctx.to, ['money.spent']).filter(e => typeof e.payload?.period === 'string');
  const groups = new Map();
  for (const e of rows) {
    const key = `${e.payload.for}|${e.payload.period}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length > 1) {
      const p = list[0].payload;
      out.push(finding('recurring_once', 'high', list[1].at, list.map(e => e.id), `${p.for} was charged ${list.length} times for ${p.period}.`));
    }
  }
  return out;
}

function ruleWalletMoney(ctx) {
  // Itemized money only: before the wallet's cut-over the balance drained by the hour, and an
  // owner's "set" is absolute (moneyOf measures it from the running balance, as the wallet does).
  const startId = ctx.walletStartId();
  if (!startId) return [];
  const inWindow = ctx.read(ctx.from, ctx.to, WALLET_TYPES).filter(e => e.id > startId);
  const anchor = inWindow.length ? inWindow.reduce((a, b) => (b.id < a.id ? b : a)) : null;
  if (!anchor) return [];
  const before = ctx.moneyBefore(anchor.id);
  const now = ctx.moneyNow();
  if (!finite(before) || !finite(now)) return [];
  let balance = before;
  for (const e of ctx.moneySince(anchor.id)) {
    const m = moneyOf(e, { balanceBefore: balance });
    if (m) balance += m.dir === 'in' ? m.amount : -m.amount;
  }
  const delta = Math.round((now - balance) * 100) / 100;
  if (Math.abs(delta) <= MONEY_TOLERANCE) return [];
  return [finding('wallet_money', 'high', ctx.to, [anchor.id],
    `The wallet's items and his balance disagree by ${delta}: the items since ${dateKey(anchor.at, ctx.tz)} give ${Math.round(balance)}, the balance is ${Math.round(now)}.`,
    `delta:${delta}`)];
}

function ruleSceneOwnDecision(ctx) {
  const out = [];
  for (const sc of ctx.read(ctx.from, ctx.to, ['scene.played'])) {
    const start = ctx.live(ctx.eventOf(posInt(sc.payload?.activityEventId) ?? sc.causeId));
    if (!start || start.type !== 'activity.started') continue;
    const said = posInt(sc.payload?.decisionId);
    const cause = posInt(start.causeId) ? ctx.eventOf(start.causeId) : null;
    const block = posInt(start.payload?.decisionId) ?? (cause?.type === 'plan.made' ? posInt(planBlockDecision(cause.payload, start)) : null);
    if (block && said !== block) {
      out.push(finding('scene_own_decision', 'warn', sc.at, [sc.id, start.id, block, ...(said ? [said] : [])],
        `The scene of the outing at ${hhmm(start.at, ctx.tz)} is tied to ${said ? `decision #${said}` : 'no decision'}, but that outing's plan block belongs to decision #${block}: it may carry the wrong tone.`));
      continue;
    }
    const opened = said ? ctx.eventOf(said) : null;
    const subjectPlace = opened?.payload?.subject?.placeId;
    const place = start.payload?.placeId;
    if (typeof subjectPlace === 'string' && typeof place === 'string' && subjectPlace !== place) {
      out.push(finding('scene_own_decision', 'warn', sc.at, [sc.id, start.id, said],
        `The scene of the outing at ${hhmm(start.at, ctx.tz)} is tied to decision #${said}, which was for another place: it may carry the wrong tone.`));
    }
  }
  return out;
}

function ruleTextPlan(ctx) {
  const out = [];
  // Every plan agreed in texts hangs off a text that is still there.
  for (const e of ctx.decisions.values()) {
    if (!e.commit || e.commit.payload?.by !== 'text' || e.commit.at < ctx.from) continue;
    const cause = posInt(e.opened?.causeId) ? ctx.live(ctx.eventOf(e.opened.causeId)) : null;
    if (cause?.type !== 'phone.message') {
      out.push(finding('text_plan', 'warn', e.commit.at, [e.id, e.commit.id],
        `Plan #${e.id} says it was agreed in texts, but the text it hangs off isn't in his life any more.`));
    }
  }
  // A turn that plainly says he's coming, with no plan or meeting anywhere near it (a code cue
  // over the words, which are never shown). The ring says what the plan step did with it: a logged
  // reason is an answer; a step that couldn't decide is worth a look; one that never looked is a hole.
  const turns = ctx.read(ctx.from, ctx.to, ['phone.message']);
  if (!turns.length) return out;
  const ring = ctx.planOutcomes();
  for (const hit of ctx.strongCues(turns.map(e => e.id))) {
    const turn = turns.find(e => e.id === hit.eventId);
    const castId = turn?.payload?.castId;
    if (!turn || !castId) continue;
    const planned = [...ctx.decisions.values()].some((d) => {
      if (!(d.opened?.payload?.subject?.castIds ?? []).includes(castId) || !d.final || !endedOnGo(d)) return false;
      const t = d.opened.payload.subject.eventAt;
      return finite(t) && t >= turn.at - PLAN_BEFORE_SEC && t <= turn.at + PLAN_AFTER_SEC;
    });
    if (planned) continue;
    const seen = ctx.spans.activities.some(a => a.withCast.includes(castId) && a.end >= turn.at - SEEN_BEFORE_SEC && a.start <= turn.at + SEEN_AFTER_SEC);
    if (seen) continue;
    const said = planStepOn(turn, turns, ring);
    if (said === 'explained') continue;
    if (said === 'never_looked') {
      out.push(finding('text_plan', 'warn', turn.at, [turn.id],
        `A text at ${hhmm(turn.at, ctx.tz)} with ${ctx.castWord(castId)} reads like a meeting is on (${hit.cue}), and the plan step never looked at it.`));
      continue;
    }
    if (said?.failed) {
      out.push(finding('text_plan', 'info', turn.at, [turn.id],
        `A text at ${hhmm(turn.at, ctx.tz)} with ${ctx.castWord(castId)} reads like a meeting is on (${hit.cue}), and the plan step couldn't decide (${said.failed}).`));
      continue;
    }
    out.push(finding('text_plan', 'info', turn.at, [turn.id],
      `A text at ${hhmm(turn.at, ctx.tz)} with ${ctx.castWord(castId)} reads like a meeting is on (${hit.cue}), with no plan or meeting near it. It may be a refusal: those are only logged.`));
  }
  return out;
}

function ruleTwoPlaces(ctx) {
  const out = [];
  const { activities, trips, sleeps } = ctx.spans;
  for (const t of trips) {
    for (const a of activities) {
      if (!a.placeId || overlapSec(a, t) < OVERLAP_TOLERANCE_SEC) continue;
      out.push(finding('two_places', 'warn', Math.max(a.start, t.start), [a.id, t.id],
        `He was on the way to ${ctx.placeWord(t.to)} and at ${ctx.placeWord(a.placeId)} at the same time, around ${hhmm(Math.max(a.start, t.start), ctx.tz)}.`));
    }
  }
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    for (let j = i + 1; j < activities.length; j++) {
      const b = activities[j];
      if (b.start >= a.end) break;
      if (!a.placeId || !b.placeId || a.placeId === b.placeId || overlapSec(a, b) < OVERLAP_TOLERANCE_SEC) continue;
      out.push(finding('two_places', 'warn', b.start, [a.id, b.id],
        `He was at ${ctx.placeWord(a.placeId)} and at ${ctx.placeWord(b.placeId)} at the same time, around ${hhmm(b.start, ctx.tz)}.`));
    }
  }
  for (const s of sleeps) {
    for (const x of [...activities, ...trips]) {
      if (overlapSec(s, x) < OVERLAP_TOLERANCE_SEC) continue;
      out.push(finding('two_places', 'warn', Math.max(s.start, x.start), [s.id, x.id],
        `He was asleep and up and about at the same time, around ${hhmm(Math.max(s.start, x.start), ctx.tz)}.`));
    }
  }
  out.push(...teleports(ctx));
  return out;
}

// Somewhere new with no trip there. Info only: an owner's revert of one trip can leave this behind,
// and a re-anchor (downtime, a rewind) or a move of home starts his position over.
function teleports(ctx) {
  const out = [];
  let pos = null;
  let posEv = null;
  const moved = (place, ev) => { pos = place; posEv = ev; };
  for (const e of ctx.moveEvents) {
    switch (e.type) {
      case 'world.reanchored': case 'world.rewound': case 'self.moved': case 'change.applied':
        moved(null, null);
        break;
      case 'travel.started': {
        const from = e.payload?.from;
        if (pos && typeof from === 'string' && from !== pos && e.at >= ctx.from) {
          out.push(finding('two_places', 'info', e.at, [posEv?.id, e.id],
            `He left ${ctx.placeWord(from)} at ${hhmm(e.at, ctx.tz)} while the log has him at ${ctx.placeWord(pos)}, with no trip between.`));
        }
        moved(null, null);
        break;
      }
      case 'travel.arrived':
        moved(typeof e.payload?.to === 'string' ? e.payload.to : null, e);
        break;
      case 'activity.started': {
        const at = e.payload?.placeId;
        if (typeof at !== 'string') break;
        if (pos && at !== pos && e.at >= ctx.from) {
          out.push(finding('two_places', 'info', e.at, [posEv?.id, e.id],
            `He was at ${ctx.placeWord(at)} at ${hhmm(e.at, ctx.tz)} right after ${ctx.placeWord(pos)}, with no trip between.`));
        }
        moved(at, e);
        break;
      }
      default:
    }
  }
  return out;
}

// The owner's chat (phone/worker.js ownerAskEvent + ownerSessionAsk): a chain back to the
// owner's "he texts…", or a turn of a thread the owner started and kept alive.
function inOwnerChat(ctx, msg, thread) {
  if (msg.payload?.trigger === 'owner') return true;
  if (ctx.chainHas(msg.id, 'phone.text_set')) return true;
  const before = thread.filter(e => e.id < msg.id && e.at <= msg.at);
  const own = [...before].reverse().find(e => e.payload?.trigger === 'owner');
  if (!own) return false;
  const newest = before[before.length - 1];
  const alive = newest && msg.at - newest.at < OWNER_LIVE_SEC;
  return msg.at - own.at <= OWNER_SESSION_SEC || (alive && msg.at - own.at <= OWNER_SESSION_MAX_SEC);
}

function rulePhoneWithSomeone(ctx) {
  const out = [];
  const all = ctx.read(ctx.from - OWNER_SESSION_MAX_SEC, ctx.to, ['phone.message']);
  const threads = new Map();
  for (const e of all) {
    const id = e.payload?.castId;
    if (!threads.has(id)) threads.set(id, []);
    threads.get(id).push(e);
  }
  for (const msg of all) {
    if (msg.at < ctx.from) continue;
    // What the engine knew when the text went out: an activity it hadn't started yet is tick lag.
    const a = ctx.spans.activities.find(x => x.id < msg.id && x.start <= msg.at && msg.at < x.end && x.withCast.length);
    if (!a) continue;
    const castId = msg.payload?.castId;
    const toThem = a.withCast.includes(castId);
    // His own texts wait while he's with anyone; a text between them waits until they part, either way.
    if (msg.payload?.dir !== 'out' && !toThem) continue;
    if (inOwnerChat(ctx, msg, threads.get(castId) ?? [])) continue;
    out.push(finding('phone_with_someone', 'warn', msg.at, [msg.id, a.id],
      toThem
        ? `A text between him and ${ctx.castWord(castId)} went out at ${hhmm(msg.at, ctx.tz)} while the two of them were together.`
        : `He texted ${ctx.castWord(castId)} at ${hhmm(msg.at, ctx.tz)} while he was with ${a.withCast.map(ctx.castWord).join(', ')}, outside a chat the owner started.`));
  }
  return out;
}

function goRule(ctx, rule, picks) {
  const out = [];
  for (const d of ctx.decisions.values()) {
    if (!picks(d) || !d.final || d.expired || !endedOnGo(d)) continue;
    const w = outingWindow(d);
    // No place: the pulse never moves him for it (a call, a decision about something else).
    if (!w?.placeId || ctx.to < w.due || w.eventAt < ctx.from) continue;
    if (wentFor(d, ctx.moves, ctx.eventOf)) continue;
    const label = chatMade(d) ? 'a plan from a chat' : (optionOf(d, d.final.optionId)?.label ?? d.opened.payload?.kind ?? 'a plan');
    out.push(finding(rule, 'warn', w.eventAt, [d.id, d.final.ev.id],
      `He committed to "${label}" at ${hhmm(w.eventAt, ctx.tz)} (decision #${d.id}), and past that point nothing moved him and nothing expired it.`));
  }
  return out;
}

const isInterview = (d) => d.opened?.payload?.kind === 'career:interview';
const ruleGoHappened = (ctx) => goRule(ctx, 'go_happened', d => !isInterview(d));
const ruleInterview = (ctx) => goRule(ctx, 'interview_attended', isInterview);

function ruleSceneAfterwards(ctx) {
  const scenes = ctx.read(ctx.from, ctx.to, ['scene.played']);
  if (!scenes.length) return [];
  const out = [];
  for (const row of ctx.sceneAfterwards(scenes.map(e => e.id))) {
    const sc = scenes.find(e => e.id === row.eventId);
    if (!sc || !row.stale) continue;
    out.push(finding('scene_afterwards', 'info', sc.at, [sc.id],
      `The sheet behind the scene at ${hhmm(sc.at, ctx.tz)} says ${row.stale} line${row.stale === 1 ? '' : 's'} about how he left that the log no longer backs.`));
  }
  return out;
}

// An open promise past its time with no outcome (plan 020 D3): an invitation nobody settled, a chat's promise
// he never kept, a goal that ran out unnoticed, a text that named a day and no plan followed. A committed go with a
// place is go_happened's, so it isn't said twice. The rows are the commitments view's: code words, a chat's plan unnamed.
function ruleOpenPromise(ctx) {
  const out = [];
  for (const r of ctx.overduePromises()) {
    if (r?.status !== 'overdue' || r.covered === true || !finite(r.when) || r.when < ctx.from || r.when > ctx.to) continue;
    const who = r.who ? ` with ${r.who}` : '';
    out.push(finding('open_promise', r.flag || r.soft ? 'info' : 'warn', r.when, r.eventIds ?? [],
      r.flag
        ? `A text${who} made it sound like they'd meet on ${dayLabel(r.when, ctx.tz)}. That day passed with no plan and no meeting.`
        : `He said he'd do "${r.what}"${who} on ${dayLabel(r.when, ctx.tz)} at ${hhmm(r.when, ctx.tz)}. That time passed and nothing came of it, and nothing closed it.`,
      r.key));
  }
  return out;
}

const RULE_FNS = Object.freeze({
  spend_once: ruleSpendOnce, salary_once: ruleSalaryOnce, recurring_once: ruleRecurringOnce, wallet_money: ruleWalletMoney,
  scene_own_decision: ruleSceneOwnDecision, text_plan: ruleTextPlan, two_places: ruleTwoPlaces,
  phone_with_someone: rulePhoneWithSomeone, go_happened: ruleGoHappened, scene_afterwards: ruleSceneAfterwards,
  interview_attended: ruleInterview, open_promise: ruleOpenPromise,
});

// ── a run ───────────────────────────────────────────────────────────────────

/**
 * Run every rule over [from, to]. deps (the facade's readers; every optional one fails soft):
 *   read(from, to, types) → events | getEvent(id) | isOut(id) | causeChain(id)
 *   tz, placeWord(id), castWord(id), kindWord(kind)
 *   walletStartId(), moneyBefore(eventId), moneyNow(), moneySince(eventId)
 *   strongCues(eventIds) → [{eventId, cue}] | planOutcomes() → {since, entries} | null | sceneAfterwards(eventIds) → [{eventId, stale}]
 *   overduePromises() → the commitments view's rows (open_promise)
 * → { findings, ruleErrors: [rule] }. A rule that throws is skipped and named.
 */
export function runRules({ from, to, tz, ...deps }) {
  const live = (e) => (e && e.redacted !== true && !deps.isOut(e.id) ? e : null);
  const cache = new Map();
  const eventOf = (id) => {
    if (!posInt(id)) return null;
    if (!cache.has(id)) cache.set(id, deps.getEvent(id) ?? null);
    return cache.get(id);
  };
  const read = (a, b, types) => (deps.read(a, b, types) ?? []).filter(live);
  const ctx = {
    from, to, tz, live, eventOf, read,
    placeWord: deps.placeWord ?? (() => 'somewhere'),
    castWord: deps.castWord ?? (() => 'someone'),
    kindWord: deps.kindWord ?? ((k) => String(k ?? 'outing')),
    walletStartId: deps.walletStartId ?? (() => null),
    moneyBefore: deps.moneyBefore ?? (() => null),
    moneyNow: deps.moneyNow ?? (() => null),
    moneySince: deps.moneySince ?? (() => []),
    strongCues: deps.strongCues ?? (() => []),
    planOutcomes: () => { try { return deps.planOutcomes?.() ?? null; } catch { return null; } },
    sceneAfterwards: deps.sceneAfterwards ?? (() => []),
    overduePromises: deps.overduePromises ?? (() => []),
    chainHas: (id, type) => (deps.causeChain?.(id) ?? []).some(e => e.type === type && live(e)),
  };
  const moveEvents = read(from - LOOKBACK_SEC, to, MOVE_TYPES);
  ctx.moveEvents = [...moveEvents].sort((a, b) => a.at - b.at || a.id - b.id);
  ctx.spans = buildSpans(moveEvents, to);
  ctx.moves = moveEvents.filter(e => e.type === 'activity.started' || e.type === 'travel.started');
  ctx.decisions = foldDecisions(read(from - DECISION_LOOKBACK_SEC, to, DECISION_TYPES));
  const findings = new Map();
  const ruleErrors = [];
  for (const rule of RULES) {
    try {
      for (const f of RULE_FNS[rule](ctx)) if (!findings.has(f.fp)) findings.set(f.fp, f);
    } catch {
      ruleErrors.push(rule);
    }
  }
  return { findings: [...findings.values()], ruleErrors };
}

/**
 * The new stored list. A finding the run saw stays (firstSeenAt kept). One it did not see goes if
 * its time lies in the window (the hole is gone: a revert, a rewind) unless its rule failed this
 * run; an older one stays until it ages out, unless one of its events has left his life. Dismissed
 * fps never come back. Newest first within severity, ≤ FINDINGS_MAX.
 */
export function mergeFindings(prev, detected, { from, at, dismissed = new Set(), isGone = () => false, ruleErrors = [] } = {}) {
  const old = new Map((Array.isArray(prev) ? prev : []).map(f => [f.fp, f]));
  const out = new Map();
  for (const f of detected) {
    if (dismissed.has(f.fp)) continue;
    const was = old.get(f.fp);
    out.set(f.fp, { ...f, firstSeenAt: finite(was?.firstSeenAt) ? was.firstSeenAt : at, lastSeenAt: at });
  }
  for (const f of old.values()) {
    if (out.has(f.fp) || dismissed.has(f.fp)) continue;
    if (!finite(f.at) || at - f.at > RETAIN_SEC) continue;
    if ((f.eventIds ?? []).some(isGone)) continue;
    if (f.at >= from && !ruleErrors.includes(f.rule)) continue;
    out.set(f.fp, f);
  }
  const rank = (f) => SEVERITIES.indexOf(f.severity);
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || b.at - a.at).slice(0, FINDINGS_MAX);
}

/** A stored value read back: only well-formed rows survive; `corrupt` says something didn't. */
export function cleanStored(findingsValue, dismissedValue) {
  const f = findingsValue;
  const good = (x) => x && typeof x === 'object' && typeof x.fp === 'string' && /^[0-9a-f]{32}$/.test(x.fp)
    && RULES.includes(x.rule) && SEVERITIES.includes(x.severity) && finite(x.at) && Array.isArray(x.eventIds)
    && x.eventIds.every(posInt) && typeof x.text === 'string';
  const shapeOk = f === null || f === undefined || (typeof f === 'object' && !Array.isArray(f));
  const list = shapeOk && Array.isArray(f?.findings) ? f.findings : [];
  const findings = list.filter(good);
  const dismissedOk = dismissedValue === null || dismissedValue === undefined || Array.isArray(dismissedValue);
  const dismissedRows = dismissedOk && Array.isArray(dismissedValue) ? dismissedValue : [];
  const dismissed = dismissedRows.filter(d => d && typeof d.fp === 'string' && /^[0-9a-f]{32}$/.test(d.fp));
  const corrupt = !shapeOk || !dismissedOk || findings.length !== list.length || dismissed.length !== dismissedRows.length
    || (f?.findings !== undefined && !Array.isArray(f?.findings));
  return {
    lastNight: typeof f?.lastNight === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.lastNight) ? f.lastNight : null,
    lastRunAt: finite(f?.lastRunAt) ? f.lastRunAt : null,
    findings, dismissed, corrupt,
  };
}

