// The re-projected future of a Director preview (spec 015 §P2.3): his next
// hours simulated twice — without and with the planned change — and the
// difference as rows (added / removed / moved / same), decisions before → after,
// money and energy at sleep. Display only: never part of the fingerprint, never
// run by apply, nothing written (the sim log is in memory: tomorrow.simulate).
//
//   buildProjection({ state, afterBase?, descriptors, world, now, deps, budgetMs? })
//     → { from, to, rows, decisions, money, energyAtSleep } | { skipped: 'budget'|'rate'|'failed' }
//
// Both runs use the install seed (no rng override), start from the same anchor
// (the sim pulse runs to now before the descriptors are appended) and close the
// 012 chat-mood overlay, so a no-op change gives identical runs. Chat-made rows
// (a block of a chat-adopted outing, an invitation's plan) are kept for the
// owner but marked `fromChat` and genericised ("a plan from a chat"); the story
// read drops them (storyRead.js).

import { dateKey, dayStart, addDays, resolveTimezone } from '../clock.js';
import { simulate } from './tomorrow.js';
import { placeLabel as placeLabelOf } from '../places.js';
import { decisionFromChat } from './continuity.js';

const HOUR = 3600;
const MOVED_SEC = 30 * 60;
const ROWS_MAX = 60;
const DECISIONS_MAX = 12;
const HOURS_MAX = 36;
export const PROJECTION_BUDGET_MS = 1500;
export const PROJECTIONS_PER_MIN = 12;
const CHAT_KINDS = new Set(['group', 'dm', 'call', 'ig']);
/** Action kinds whose preview carries a projection (015 god kinds and 014 plan edits by name). */
export const PROJECT_KINDS = Object.freeze(new Set(['scene', 'quick', 'goal', 'goal.cancel', 'weather', 'weather.end', 'heavy.end',
  'tray.adopt', 'bundle', 'retcon',
  'decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health', 'arc.end', 'cast.depart', 'cast.return',
  'schedule', 'schedule.clear', 'wake']));

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

let recent = [];   // ms timestamps of projections in the last minute (process-wide)
let runs = 0;      // simulations started (tests: apply never runs one)

/** Test seam: forget the rate window. */
export function __resetProjectionRate() { recent = []; }

/** How many sim runs this process started (a test spy). */
export function projectionRuns() { return runs; }

function rateOk(nowMs) {
  recent = recent.filter(t => t > nowMs - 60_000);
  if (recent.length >= PROJECTIONS_PER_MIN) return false;
  recent.push(nowMs);
  return true;
}

/** A place's wording in the projection: "home", "the office", else 014's safe label. */
function placeLabel(state, id) {
  if (!id) return null;
  if (id === state?.self?.homePlaceId) return 'home';
  if (id === state?.self?.officePlaceId) return 'the office';
  const name = placeLabelOf(state, id);
  return typeof name === 'string' && name ? name.slice(0, 60) : null;
}

// One run through 014's tomorrow.simulate: the same anchor for before and after
// (anchorFirst), the 012 overlay closed (closeChatMood), the caller's appender.
function simulateWithDescriptors(state, world, o) {
  return simulate(state, world, {
    now: o.now, hours: o.hours, sampleSec: o.sampleSec, deadlineAt: o.deadlineAt, anchorFirst: true, closeChatMood: true,
    ...(typeof o.worldOf === 'function' ? { worldOf: o.worldOf } : {}),
    ...(typeof o.storyItems === 'function' ? { storyItems: o.storyItems } : {}),
    ...(typeof o.atWake === 'function' ? { atWake: o.atWake } : {}),
    ...(typeof o.blockCause === 'function' ? { blockCause: o.blockCause } : {}),
    ...(typeof o.planCause === 'function' ? { planCause: o.planCause } : {}),
    ...(Array.isArray(o.descriptors) && o.descriptors.length ? { descriptors: o.descriptors, appendDescriptors: o.appendDescriptors } : {}),
  });
}

function firstName(state, id) {
  const c = state?.cast instanceof Map ? state.cast.get(id) : null;
  const n = typeof c?.name === 'string' ? c.name : state?.story?.departed?.[id]?.name;
  return typeof n === 'string' && n ? n.split(/\s+/)[0].slice(0, 40) : null;
}

// The plan in force per date over the run: the start state's plan, then every
// plan.made of the sim log (last per date wins), with each plan's own event.
function blocksOf(run, startState) {
  const plans = [];
  if (isObj(startState?.plan)) plans.push({ plan: startState.plan, ev: run.log.getEvent(startState.plan.eventId) });
  for (const e of run.log.events) if (e.type === 'plan.made') plans.push({ plan: e.payload, ev: e });
  const byDate = new Map();
  for (const p of plans) if (typeof p.plan?.date === 'string') byDate.set(p.plan.date, p);
  const out = [];
  for (const { plan, ev } of [...byDate.values()].sort((a, b) => (a.plan.date < b.plan.date ? -1 : 1))) {
    const chatPlan = !!ev && CHAT_KINDS.has(ev.originKind);
    for (const b of Array.isArray(plan.blocks) ? plan.blocks : []) {
      if (!finite(b?.start) || !finite(b?.end) || b.end <= run.from || b.start >= run.to) continue;
      let causeChat = false;
      if (Number.isSafeInteger(b.causeEventId)) {
        try { const c = run.log.getEvent(b.causeEventId); causeChat = !!c && CHAT_KINDS.has(c.originKind); } catch { causeChat = true; }
      }
      const fromChat = typeof b.subjectJid === 'string' || causeChat || (b.fromAmendment === true && chatPlan);
      out.push({ start: b.start, end: b.end, kind: typeof b.kind === 'string' ? b.kind : 'block', placeId: b.placeId ?? null,
        withCast: Array.isArray(b.withCast) ? b.withCast : [], fromChat });
    }
  }
  return out;
}

function diffRows(before, after, names) {
  const used = new Set();
  const rows = [];
  const keyOf = (r) => `${r.kind}|${r.placeId ?? ''}`;
  for (const a of after) {
    let i = before.findIndex((b, j) => !used.has(j) && keyOf(b) === keyOf(a) && b.start === a.start && b.end === a.end);
    let change = 'same';
    if (i < 0) {
      i = before.findIndex((b, j) => !used.has(j) && keyOf(b) === keyOf(a) && Math.abs(b.start - a.start) <= MOVED_SEC);
      change = i < 0 ? 'added' : 'moved';
    }
    if (i >= 0) used.add(i);
    rows.push(rowOf(a, change, i >= 0 ? before[i] : null, names));
  }
  before.forEach((b, j) => { if (!used.has(j)) rows.push(rowOf(b, 'removed', null, names)); });
  rows.sort((x, y) => x.at - y.at || (x.change === 'removed' ? -1 : 1));
  // Keep every change; fill with unchanged rows up to the cap.
  const changed = rows.filter(r => r.change !== 'same');
  const same = rows.filter(r => r.change === 'same');
  return [...changed.slice(0, ROWS_MAX), ...same.slice(0, Math.max(0, ROWS_MAX - changed.length))].sort((x, y) => x.at - y.at);
}

function rowOf(b, change, was, names) {
  if (b.fromChat) return { at: b.start, end: b.end, kind: 'plan', place: 'a plan from a chat', placeId: null, cast: [], change, fromChat: true, ...(was ? { wasAt: was.start } : {}) };
  return {
    at: b.start, end: b.end, kind: b.kind, place: b.placeId ? names.place(b.placeId) : null, placeId: b.placeId,
    cast: b.withCast.map(names.cast).filter(Boolean).slice(0, 6), change, fromChat: false,
    ...(was && change === 'moved' ? { wasAt: was.start } : {}),
  };
}

function decisionStatus(d) {
  if (!d) return null;
  if (d.status === 'committed') return d.committed?.optionId ?? 'committed';
  return d.status;
}

function decisionsDiff(runB, runA, baseLast, from, to) {
  const keyOf = (d) => (d.id <= baseLast ? `#${d.id}` : `${d.kind}|${d.subject?.eventAt}|${d.subject?.placeId ?? ''}`);
  const collect = (run) => {
    const m = new Map();
    const s = run.log.getState();
    for (const d of s.decisions instanceof Map ? s.decisions.values() : []) {
      const at = d.subject?.eventAt;
      if (!finite(at) || at < from - 2 * HOUR || at > to) continue;
      m.set(keyOf(d), d);
    }
    return m;
  };
  const b = collect(runB);
  const a = collect(runA);
  const out = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const db = b.get(k) ?? null;
    const da = a.get(k) ?? null;
    const d = da ?? db;
    const chat = decisionFromChat(d);
    const go = (Array.isArray(d.options) ? d.options : []).find(o => o?.id === 'go')?.label;
    out.push({
      id: d.id <= baseLast ? d.id : null, at: d.subject?.eventAt ?? null, fromChat: chat,
      label: chat ? 'a plan from a chat' : (typeof go === 'string' && go ? go.slice(0, 80) : String(d.kind ?? 'plan').replace(/[_:-]+/g, ' ')),
      before: decisionStatus(db), after: decisionStatus(da),
    });
  }
  const changed = out.filter(x => x.before !== x.after);
  const rest = out.filter(x => x.before === x.after);
  return [...changed, ...rest].slice(0, DECISIONS_MAX).sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
}

function moneyOf(run) {
  const list = run.samples.map(s => s.vitals?.money).filter(finite);
  return { last: list.length ? list[list.length - 1] : null, min: list.length ? Math.min(...list) : null };
}

function energyAtSleep(run, rows) {
  const sleep = rows.find(r => r.kind === 'sleep' && r.start > run.from);
  if (!sleep) return null;
  const s = [...run.samples].reverse().find(x => x.at <= sleep.start);
  return finite(s?.vitals?.energy) ? Math.round(s.vitals.energy) : null;
}

/**
 * The two runs and their difference. input: { state (the live projection, never
 * a view), afterBase (default state: the base of the after run, e.g. a retcon's
 * rewound world), descriptors (the planned batch), world (base), now, deps:
 * { appendDescriptors, worldOf, storyItems, blockCause, planCause }, budgetMs }.
 */
export async function buildProjection(input = {}) {
  const { state, world, deps = {} } = input;
  const now = Math.floor(input.now);
  if (!isObj(state) || !world || !finite(now)) return { skipped: 'failed' };
  if (!rateOk(Date.now())) return { skipped: 'rate' };
  const tz = resolveTimezone(state.world?.timezone ?? world.timezone);
  const endOfTomorrow = addDays(dayStart(now, tz), 2, tz);
  const hours = Math.max(1, Math.min(HOURS_MAX, (endOfTomorrow - now) / HOUR));
  const deadlineAt = Date.now() + (finite(input.budgetMs) ? input.budgetMs : PROJECTION_BUDGET_MS);
  const common = {
    now, hours, sampleSec: 1800, deadlineAt, worldOf: deps.worldOf, storyItems: deps.storyItems,
    blockCause: deps.blockCause, planCause: deps.planCause, atWake: deps.atWake, appendDescriptors: deps.appendDescriptors,
  };
  let runB;
  let runA;
  try {
    runs += 2;
    runB = await simulateWithDescriptors(state, world, { ...common, descriptors: null });
    if (runB.timedOut) return { skipped: 'budget' };
    runA = await simulateWithDescriptors(input.afterBase ?? state, world, { ...common, descriptors: input.descriptors ?? [] });
    if (runA.timedOut) return { skipped: 'budget' };
    if (runA.failed) return { skipped: 'failed' };
  } catch {
    return { skipped: 'failed' };
  }
  const finalA = runA.log.getState();
  const finalB = runB.log.getState();
  const names = {
    place: (id) => placeLabel(finalA, id) ?? placeLabel(finalB, id) ?? 'a place',
    cast: (id) => firstName(finalA, id) ?? firstName(finalB, id),
  };
  const blocksB = blocksOf(runB, input.state);
  const blocksA = blocksOf(runA, input.afterBase ?? state);
  const mb = moneyOf(runB);
  const ma = moneyOf(runA);
  const round = (v) => (finite(v) ? Math.round(v) : null);
  return {
    from: runA.from, to: runA.to, today: dateKey(now, tz),
    rows: diffRows(blocksB, blocksA, names),
    decisions: decisionsDiff(runB, runA, state.lastEventId, runA.from, runA.to),
    money: { before: round(mb.last), after: round(ma.last), min: round(ma.min) },
    energyAtSleep: { before: energyAtSleep(runB, blocksB), after: energyAtSleep(runA, blocksA) },
  };
}
