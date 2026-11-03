// Scheduled god changes (spec 015 plan §1.3): "wakes up exhausted tomorrow",
// "starts the new job on Monday", "moves on Saturday", "the dinner falls
// through". The owner's event is folded into a pending slice
// (s.story.pending / s.story.outcomes, reducer.js GOD_HANDLERS); these pure
// builders offer the pulse the ENGINE consequence when it is due — the 011
// goals pattern (story/index.js items → collect, sim:true honoured), so
// tomorrow.simulate and the Day projection see them.
//
//   pendingItems(s, g, d)     career.set / self.moved with a later effectiveAt →
//                             change.applied (+ career expiries, hunt end, today's
//                             re-plan); vitals.planned {at} → vitals.nudged
//                             {planned}; sick.planned → sick.started {planned}
//                             (+ re-plan). Each caused by its owner event.
//   outcomeItems(s, g, d)     outcome.set → outcome.happened (+ relationship
//                             changes) once the outing is over, or the cancel
//                             (decision.expired {fell_through} + re-plan without it)
//   overlayDriftItems(s, g, d)  the plan in force was made under another god key
//                             (a change applied by a path that could not re-plan,
//                             a revert) → today re-planned once
//   wakeNudges(s, at, add)    the pulse's atWake seam: due wakeDate nudges
//   careerConsequences(...)   shared with the Director's immediate path
//
// Never appends an owner event (21-guards walks this file): every consequence
// is engine and cascades when its owner event is reverted or rewound. Items
// re-read getState() at run time and re-check what they touch (a decision may
// have closed or become chat-shaped since the snapshot) — plan §1.3 review #6/#28.

import { dateKey } from '../clock.js';
import { isUndone } from '../pulse.js';
import { driftKey, PLAN_REASONS } from './reducer.js';
import { replanToday, chatMadeDecision } from '../planEdits.js';
import { isExcludedId } from '../projector.js';

const MIN = 60;
const PRIO = 4.5;            // after weather/embargo, before decisions (5) and blocks (6)
const REL_WELL = Object.freeze({ closeness: 0.05 });
const REL_BADLY = Object.freeze({ tension: 0.1, closeness: -0.03 });
const SICK_GRACE_SEC = 4 * 3600;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const tzOf = (s, world) => s?.world?.timezone || world?.timezone;

/**
 * A plan made in a chat (adopted, a real-person subject, an invitation, a reply's
 * commit, opened from a chat): never a god target. A routine plan a chat only
 * nudged with a lean is his own (2026-11-02; planEdits.chatMadeDecision).
 */
export function isChatDecision(d) {
  return chatMadeDecision(d);
}

/** The decisions a career change closes: open or committed career-category ones, never chat-shaped. */
export function careerDecisions(s) {
  const out = [];
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    if ((d?.status === 'open' || d?.status === 'committed') && d.category === 'career') out.push(d);
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * The engine descriptors a career change brings (immediate at apply, or when its
 * change.applied fires): career decisions expired `career_changed`; an active
 * hunt ended on hire / job / fire / quit. → [{type, payload}] (the caller dates
 * and causes them with the career.set / change.applied).
 */
export function careerConsequences(s, payload) {
  const out = [];
  for (const d of careerDecisions(s)) out.push({ type: 'decision.expired', payload: { decisionId: d.id, reason: 'career_changed' } });
  const c = s?.story?.career;
  const hunt = posInt(c?.huntArcId);
  if (hunt && ['hire', 'job', 'fire', 'quit'].includes(payload?.reason) && s.story?.arcs?.[hunt]?.status === 'active') {
    out.push({ type: 'career.hunt', payload: { arcId: hunt, phase: 'ended' } });
    out.push({ type: 'arc.ended', payload: { arcId: hunt, outcome: payload.reason === 'hire' || payload.reason === 'job' ? 'done' : 'cancelled' } });
  }
  return out;
}

/**
 * Today's re-plan after a change (014 planEdits.replanToday) → a plan.made payload
 * or null. With dropDecisionIds (an outing called off) the plan in force is
 * spliced (those outings' blocks refilled from the routine); without (a career /
 * home / sick change: his routine itself changed) the rest of today is rebased
 * on the routine under `world`, keeping committed outings.
 */
export function replanFor(s, at, world, { dropDecisionIds = [] } = {}) {
  const tz = tzOf(s, world);
  if (!s?.plan || s.plan.date !== dateKey(at, tz)) return null;
  const drop = Array.isArray(dropDecisionIds) ? dropDecisionIds : [];
  const plan = replanToday(s, at, world, drop.length ? { dropDecisionIds: drop, isExcludedId } : { rebase: true, isExcludedId });
  if (!plan) return null;
  const key = driftKey(s);
  return key !== null ? { ...plan, driftKey: key } : plan;
}

function item(key, at, label, id, run) {
  return { at, prio: PRIO, label, id, key, run };
}

function live(d, s) {
  try { return typeof d.getState === 'function' ? (d.getState() ?? s) : s; } catch { return s; }
}

function worldFor(d, s) {
  try { return typeof d.worldOf === 'function' ? d.worldOf(s) : d.world; } catch { return d.world; }
}

/** Pending owner changes with an absolute due time. */
export function pendingItems(s, g, d = {}) {
  const pending = s?.story?.pending;
  if (!isObj(pending)) return [];
  const sAt = finite(s.at) ? s.at : g;
  const out = [];
  for (const [k, e] of Object.entries(pending)) {
    const id = posInt(Number(k));
    if (!id || !isObj(e) || !finite(e.due?.at)) continue;
    const at = Math.max(e.due.at, sAt);
    if (at > g) continue;
    if (e.type === 'career.set' || e.type === 'self.moved') {
      if (isUndone(s, 'change.applied', null, String(id))) continue;
      out.push(item(`god:change:${id}`, at, 'god:change', id, (add) => {
        const s0 = live(d, s);
        if (!isObj(s0?.story?.pending?.[id])) return;
        const applied = add({ type: 'change.applied', at, actor: 'engine', causeId: id, payload: { targetId: id } });
        if (e.type === 'career.set') {
          // Re-read: the decisions are checked at fire time (review #6/#28).
          for (const c of careerConsequences(live(d, s), e.payload)) add({ ...c, at, actor: 'engine', causeId: applied.id });
          if (!PLAN_REASONS.has(e.payload?.reason) && !e.payload?.pattern) return;   // a salary / title change re-plans nothing
        }
        const s1 = live(d, s);
        const plan = replanFor(s1, at, worldFor(d, s1));
        if (plan) add({ type: 'plan.made', at, actor: 'engine', causeId: applied.id, payload: plan });
      }));
    } else if (e.type === 'vitals.planned') {
      if (isUndone(s, 'vitals.nudged', null, String(id))) continue;
      out.push(item(`god:nudge:${id}`, at, 'god:nudge', id, (add) => {
        if (!isObj(live(d, s)?.story?.pending?.[id])) return;
        add({ type: 'vitals.nudged', at, actor: 'engine', causeId: id, payload: { delta: { ...e.payload.delta }, reason: 'planned' } });
      }));
    } else if (e.type === 'sick.planned') {
      if (isUndone(s, 'sick.started', null, String(id))) continue;
      // Already sick: the plan waits, and is not offered at all (an item that appends
      // nothing is retired for the process) — it fires at the first tick after he recovers.
      if (s.sick || s.vitals?.sick === true) continue;
      out.push(item(`god:sick:${id}`, at, 'god:sick', id, (add) => {
        const s0 = live(d, s);
        if (!isObj(s0?.story?.pending?.[id])) return;
        if (s0.sick || s0.vitals?.sick === true) return;   // already sick: the plan waits (one spell at a time)
        const days = Math.max(1, Math.min(14, posInt(e.payload?.days) ?? 1));
        const started = add({ type: 'sick.started', at, actor: 'engine', causeId: id, payload: { until: at + days * 86400 + SICK_GRACE_SEC, days, reason: 'planned' } });
        const s1 = live(d, s);
        const plan = replanFor(s1, at, worldFor(d, s1));
        if (plan) add({ type: 'plan.made', at, actor: 'engine', causeId: started.id, payload: plan });
      }));
    }
  }
  return out;
}

/** The pulse's atWake seam: append the planned nudges due this wake date. */
export function wakeNudges(s, at, add, { world = null } = {}) {
  const pending = s?.story?.pending;
  if (!isObj(pending) || typeof add !== 'function') return 0;
  const date = dateKey(at, tzOf(s, world));
  let n = 0;
  for (const [k, e] of Object.entries(pending)) {
    const id = posInt(Number(k));
    if (!id || e?.type !== 'vitals.planned' || e.due?.wakeDate !== date) continue;
    if (isUndone(s, 'vitals.nudged', null, String(id))) continue;
    add({ type: 'vitals.nudged', at, actor: 'engine', causeId: id, payload: { delta: { ...e.payload.delta }, reason: 'planned' } });
    n++;
  }
  return n;
}

function outingEnd(d) {
  const sub = d?.subject ?? {};
  if (finite(sub.endAt)) return sub.endAt;
  const go = Array.isArray(d?.options) ? d.options.find(o => o.id === 'go') : null;
  return finite(sub.eventAt) ? sub.eventAt + (finite(go?.minutes) ? go.minutes : 90) * MIN : null;
}

/** Owner-set outcomes: how the outing went (once it is over) or the cancel at cancelAt. */
export function outcomeItems(s, g, d = {}) {
  const outcomes = s?.story?.outcomes;
  if (!isObj(outcomes)) return [];
  const sAt = finite(s.at) ? s.at : g;
  const out = [];
  for (const [k, o] of Object.entries(outcomes)) {
    const id = posInt(Number(k));
    if (!id || !isObj(o) || o.status !== 'set' || !posInt(o.eventId)) continue;
    const dec = s.decisions instanceof Map ? s.decisions.get(id) : null;
    // Void (fold-only, nothing appended): gone, or closed without going.
    if (!dec) continue;
    if (o.outcome === 'cancelled') {
      if (dec.status !== 'open' && dec.status !== 'committed') continue;
      const at = Math.max(finite(o.cancelAt) ? o.cancelAt : sAt, sAt);
      if (at > g) continue;
      out.push(item(`god:cancel:${id}`, at, 'god:outcome', id, (add) => {
        const s0 = live(d, s);
        const cur = s0?.decisions?.get?.(id);
        if (!cur || (cur.status !== 'open' && cur.status !== 'committed')) return;
        const exp = add({ type: 'decision.expired', at, actor: 'engine', causeId: o.eventId, ...(cur.subjectJid ? { subjectJid: cur.subjectJid } : {}), payload: { decisionId: id, reason: 'fell_through' } });
        const s1 = live(d, s);
        const plan = replanFor(s1, at, worldFor(d, s1), { dropDecisionIds: [id] });
        if (plan) add({ type: 'plan.made', at, actor: 'engine', causeId: exp.id, payload: plan });
      }));
      continue;
    }
    if (dec.status !== 'committed' || !['go', 'late'].includes(dec.committed?.optionId)) continue;
    if (isUndone(s, 'outcome.happened', null, String(o.eventId))) continue;
    const end = outingEnd(dec);
    if (!finite(end)) continue;
    const at = Math.max(end, sAt);
    if (at > g) continue;
    out.push(item(`god:outcome:${id}`, at, 'god:outcome', id, (add) => {
      const s0 = live(d, s);
      const cur = s0?.decisions?.get?.(id);
      if (!cur || cur.status !== 'committed') return;
      const castIds = (Array.isArray(cur.subject?.castIds) ? cur.subject.castIds : []).filter(c => s0.cast?.has?.(c));
      const ev = add({ type: 'outcome.happened', at, actor: 'engine', causeId: o.eventId, payload: { decisionId: id, outcome: o.outcome, castIds } });
      const delta = o.outcome === 'well' ? REL_WELL : REL_BADLY;
      for (const castId of castIds) {
        add({ type: 'relationship.changed', at, actor: 'engine', causeId: ev.id, payload: { castId, delta: { ...delta }, reason: 'outcome' } });
      }
    }));
  }
  return out;
}

/**
 * The plan in force was made under another god key (overlayKey's owner part:
 * a career / home change applied by a path that could not re-plan today, or a
 * revert of one): re-plan the rest of today once. Guarded by the exclusion
 * signature `overlay:<key>`, so a reverted re-plan does not come back.
 */
export function overlayDriftItems(s, g, d = {}) {
  const key = driftKey(s);
  const plan = s?.plan;
  if (key === null || !plan || (plan.driftKey ?? null) === key) return [];
  if (s.activity?.kind === 'sleep' || !finite(s.at)) return [];
  if (isUndone(s, 'plan.made', null, `overlay:${key}`)) return [];
  const at = s.at;
  if (at > g) return [];
  const world = worldFor(d, s);
  const next = replanFor(s, at, world);
  if (!next) return [];
  const causeId = Math.max(posInt(s.story?.career?.godEventId) ?? 0, posInt(s.self?.homeEventId) ?? 0) || null;
  return [item(`god:drift:${key}`, at, 'god:drift', null, (add) => {
    add({ type: 'plan.made', at, actor: 'engine', ...(causeId ? { causeId } : {}), payload: next });
  })];
}
