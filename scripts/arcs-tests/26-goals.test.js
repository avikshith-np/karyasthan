// 011 Phase 2 — soft goals (story/goals.js, director.js planGoal / planGoalCancel,
// projector HANDLERS_011 + STEER_OBSERVERS, plan §P2.3, review R8/R14/R18/R19/
// R23/R27): a meet goal fits an evening free window (never work or sleep), the
// pulse rewrites the evening at the point of no return and goal.done follows the
// outing; one try per day with each deferral reason; goal.expired at the window
// end, listed by dayView for 3 days; could_not_go / sick before the point of no
// return reopen it; a call goal makes a family.call at its slot (cadence
// unchanged); goal.cancel expires the planned outing and reverts its amendment;
// CANCEL TONIGHT on a goal outing closes the goal; planner bounds and text;
// chat-forbidden goal.*; by:'goal' commits are locked; sims write nothing and show
// the goal; a prompt "call his mum this week" becomes a goal draft.
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR, DAY,
} from './_helpers.js';
import { appendEvent, getEvent, eventsAfter, lastEventId } from '../../src/life/eventLog.js';
import { project, createInitialState } from '../../src/life/projector.js';
import { dateKey, addDays, dayStart, resolveTimezone, localParts } from '../../src/life/clock.js';
import { detectTriggers } from '../../src/life/decisions.js';
import * as director from '../../src/life/story/director.js';
import * as goals from '../../src/life/story/goals.js';
import * as promptMod from '../../src/life/story/prompt.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';
import { getDb } from '../../src/memory/db.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock, life } = booted;
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const minuteOf = (t) => { const p = localParts(t, tz); return p.hour * 60 + p.minute; };

async function codeOf(p) {
  try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
function codeOfSync(fn) {
  try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
async function applyAction(action) {
  const pv = await director.preview(action);
  const res = await director.apply(pv.previewId, pv.fingerprint);
  return { pv, res, events: res.eventIds.map(getEvent) };
}
const since = (id) => eventsAfter(id, 50000);
const goalOf = (id) => S().goals?.[id];
// Step the clock 15 min at a time until pred() holds (≤ maxHours). → whether it did.
async function until(pred, maxHours = 30) {
  for (let i = 0; i < maxHours * 4; i++) {
    if (pred()) return true;
    await simulateHours(0.25);
  }
  return pred();
}
const openedFor = (before, id) => since(before).find(e => e.type === 'decision.opened' && e.payload.goalId === id);

await simulateHours(4);              // Tue 27 Oct ~10:00: an office day, he is at work

section('planner bounds and text');
{
  eq('meet needs a cast member', codeOfSync(() => director.plan({ kind: 'goal', goalKind: 'meet', fromDay: 0, toDay: 1 }, S())), 'invalid:bad_castId');
  eq('call needs a family member', codeOfSync(() => director.plan({ kind: 'goal', goalKind: 'call', castId: 'cast:flatmate', fromDay: 0, toDay: 1 }, S())), 'invalid:bad_castId');
  eq('toDay past 13 → bad_toDay', codeOfSync(() => director.plan({ kind: 'goal', goalKind: 'outing', fromDay: 0, toDay: 14 }, S())), 'invalid:bad_toDay');
  eq('a JID in the label → jid_in_text', codeOfSync(() => director.plan({ kind: 'goal', goalKind: 'outing', fromDay: 0, toDay: 1, label: 'see 15550001111@s.whatsapp.net' }, S())), 'invalid:jid_in_text');
  eq('unknown kind', codeOfSync(() => director.plan({ kind: 'goal', goalKind: 'party', fromDay: 0, toDay: 1 }, S())), 'invalid:bad_goalKind');
  eq('minutes out of range', codeOfSync(() => director.plan({ kind: 'goal', goalKind: 'outing', fromDay: 0, toDay: 1, minutes: 500 }, S())), 'invalid:bad_minutes');
  const p = director.plan({ kind: 'goal', goalKind: 'meet', castId: 'cast:flatmate', fromDay: 0, toDay: 1, label: 'catch up' }, S());
  eq('events: director.action + goal.set (owner)', p.events.map(e => [e.type, e.actor]), [['director.action', 'owner'], ['goal.set', 'owner']]);
  const gs = p.events[1].payload;
  eq('window = today 00:00 … the end of tomorrow', [gs.from, gs.to], [dayStart(clock.now(), tz), addDays(dayStart(clock.now(), tz), 2, tz)]);
  eq('default minutes per kind (meet 120)', gs.minutes, 120);
  check('warnings: visible everywhere + tries once a day', p.warnings.includes(director.VISIBLE_EVERYWHERE) && p.warnings.includes(director.GOAL_TRIES));
  check('extra.firstSlot says whether today has room', p.extra?.firstSlot && (Number.isFinite(p.extra.firstSlot.slotStart) || typeof p.extra.firstSlot.reason === 'string'), p.extra);
  eq('route shape check: bad goalKind', actionProblem({ kind: 'goal', goalKind: 'nap' }), 'bad_goalKind');
  eq('route shape check: goal.cancel id', actionProblem({ kind: 'goal.cancel', goalId: 'x' }), 'bad_goalId');
}

section('a meet goal fits an evening free window; the outing happens; goal.done');
let meetId;
{
  const before = lastEventId();
  const { events } = await applyAction({ kind: 'goal', goalKind: 'meet', castId: 'cast:flatmate', fromDay: 0, toDay: 1, minutes: 90 });
  meetId = events.find(e => e.type === 'goal.set').id;
  eq('goal.set is owner origin', getEvent(meetId).originKind, 'owner');
  await simulateHours(0.5);
  const fitted = since(before).find(e => e.type === 'goal.fitted' && e.payload.goalId === meetId);
  check('goal.fitted at the next tick', !!fitted, since(before).map(e => e.type));
  const opened = since(before).find(e => e.type === 'decision.opened' && e.payload.goalId === meetId);
  const committed = since(before).find(e => e.type === 'decision.committed' && e.payload.decisionId === opened?.id);
  eq('the chain: fitted → opened → lean → committed by:goal, all engine, all self',
    [opened?.causeId === fitted?.id, committed?.payload.by, [fitted, opened, committed].every(e => e?.actor === 'engine' && e.originKind === 'self')],
    [true, 'goal', true]);
  eq('fitted causes: goal.set', fitted.causeId, meetId);
  // A goal outing is locked: it is fitted into the plan in force at once (pulse.fitLockedOuting),
  // so the slot checks read the base plan it was fitted into.
  const amendedNow = S().plan;
  const plan = Number.isSafeInteger(amendedNow.basePlanEventId) && amendedNow.basePlanEventId !== amendedNow.eventId
    ? { ...getEvent(amendedNow.basePlanEventId).payload } : amendedNow;
  check('…and the outing is in his plan at once (blocks carry its decision)', amendedNow.blocks.some(b => b.decisionId === opened?.id && b.kind !== 'commute'));
  const slot = [fitted.payload.slotStart, fitted.payload.slotEnd];
  const office = S().self.officePlaceId;
  const work = plan.blocks.filter(b => ['work', 'meeting', 'sleep'].includes(b.kind) || (b.kind === 'commute' && (b.to === office || b.from === office)));
  check('the slot is in the evening (≥ 17:00) and before bedtime − 30 min', minuteOf(slot[0]) >= 17 * 60 && slot[1] <= plan.sleepAt - 30 * 60, slot);
  check('…never over work, meetings, the office commute or sleep', !work.some(b => b.start < slot[1] && slot[0] < b.end), { slot, work: work.map(b => [b.kind, b.start, b.end]) });
  const ponrBlock = plan.blocks.find(b => b.start <= S().decisions.get(opened.id).ponrAt && S().decisions.get(opened.id).ponrAt < b.end);
  eq('…and he is free at its point of no return', ponrBlock?.availability, 'free');
  eq('goal state: planned', [goalOf(meetId).status, goalOf(meetId).fitted.decisionId], ['fitted', opened.id]);
  const d = S().decisions.get(opened.id);
  eq('decision: committed by goal, goalId kept, category social', [d.status, d.committed.by, d.goalId, d.category], ['committed', 'goal', meetId, 'social']);
  eq('by:goal is locked: no Jev trigger can re-lean it', detectTriggers(d, S(), { at: clock.now(), newEvents: since(before), world }), []);
  // Through the evening.
  await simulateHours(15);
  const all = since(before);
  const amended = all.find(e => e.type === 'plan.made' && e.payload.amendedFor === opened.id);
  check('the pulse fitted the evening into his plan by its point of no return', !!amended && amended.at <= d.ponrAt, amended?.at);
  check('he went (an activity of the outing kind at its place, with the flatmate)',
    all.some(e => e.type === 'activity.started' && e.payload.kind === 'hangout' && (e.payload.withCast || []).includes('cast:flatmate')));
  const done = all.find(e => e.type === 'goal.done' && e.payload.goalId === meetId);
  check('goal.done after the outing ends, caused by goal.fitted', !!done && done.at >= fitted.payload.slotEnd && getEvent(done.causeId).type === 'goal.fitted', done);
  eq('goal closed: done', goalOf(meetId).status, 'done');
}

section('a call goal: family.call at the slot, with goalId; the cadence unchanged');
{
  const before = lastEventId();
  const nextBefore = S().story?.family?.nextCallAt ?? null;
  const { events } = await applyAction({ kind: 'goal', goalKind: 'call', castId: 'cast:parent', fromDay: 0, toDay: 0 });
  const id = events.find(e => e.type === 'goal.set').id;
  await until(() => goalOf(id)?.status === 'done' || goalOf(id)?.status === 'expired', 30);
  const all = since(before);
  const fitted = all.find(e => e.type === 'goal.fitted' && e.payload.goalId === id);
  const call = all.find(e => e.type === 'family.call' && e.payload.goalId === id);
  check('fitted with a slot, no decision', !!fitted && !all.some(e => e.type === 'decision.opened' && e.payload.goalId === id));
  check('family.call at the slot, caused by goal.fitted', !!call && call.at === Math.max(fitted.payload.slotStart, call.at) && call.causeId === fitted.id, call);
  eq('…with the parent, origin self', [call?.payload.castId, call?.originKind], ['cast:parent', 'self']);
  eq('the call cadence is unchanged', S().story?.family?.nextCallAt ?? null, nextBefore);
  eq('goal done', goalOf(id).status, 'done');
}

section('goal.cancel expires the planned outing and reverts its amendment (R19)');
{
  const before = lastEventId();
  const { events } = await applyAction({ kind: 'goal', goalKind: 'outing', placeId: 'place:cafe', fromDay: 1, toDay: 1, minutes: 60 });
  const id = events.find(e => e.type === 'goal.set').id;
  await until(() => !!openedFor(before, id), 30);
  const opened = openedFor(before, id);
  check('fitted and committed', !!opened && goalOf(id).status === 'fitted', since(before).filter(e => e.type.startsWith('goal')).map(e => [e.type, e.payload.reason]));
  const d = S().decisions.get(opened.id);
  // Step to just after the point of no return (the amendment), before the outing starts.
  while (clock.now() < d.ponrAt + 20 * 60 && clock.now() < d.subject.eventAt - 15 * 60) await simulateHours(0.25);
  const amended = since(before).find(e => e.type === 'plan.made' && e.payload.amendedFor === opened.id);
  check('the evening was rewritten for it', !!amended);
  const pv = await director.preview({ kind: 'goal.cancel', goalId: id });
  eq('events: goal.cancelled, the decision expired (owner_cancelled), its amendment reverted',
    pv.events.map(e => [e.type, e.payload.reason ?? null]),
    [['director.action', null], ['goal.cancelled', null], ['decision.expired', 'owner_cancelled'], ['event.reverted', 'goal_cancel']]);
  await director.apply(pv.previewId, pv.fingerprint);
  eq('goal cancelled, decision cancelled', [goalOf(id).status, S().decisions.get(opened.id)?.status], ['cancelled', 'cancelled']);
  check('the amendment is out of the projection', S().plan?.amendedFor !== opened.id);
  eq('an unknown / closed goal → refused', codeOfSync(() => director.plan({ kind: 'goal.cancel', goalId: id }, S())), 'refused:no_goal');
  await simulateHours(10);
}

section('paused: one deferral per day, then goal.expired; dayView lists it for 3 days');
let expiredId;
{
  await applyAction({ kind: 'pause', reason: 'test' });
  const before = lastEventId();
  const { events } = await applyAction({ kind: 'goal', goalKind: 'errand', fromDay: 0, toDay: 1 });
  expiredId = events.find(e => e.type === 'goal.set').id;
  await until(() => goalOf(expiredId)?.status === 'expired', 60);
  const all = since(before);
  const deferred = all.filter(e => e.type === 'goal.deferred' && e.payload.goalId === expiredId);
  eq('deferred once per local date, reason paused', deferred.map(e => [e.payload.date, e.payload.reason]),
    [...new Set(deferred.map(e => e.payload.date))].map(dte => [dte, 'paused']));
  check('…on at most two dates', deferred.length >= 1 && deferred.length <= 2, deferred.length);
  const exp = all.find(e => e.type === 'goal.expired' && e.payload.goalId === expiredId);
  check('goal.expired at the window end', !!exp && exp.at >= getEvent(expiredId).payload.to, exp);
  await applyAction({ kind: 'resume' });
  const dv = await life.dayView({});
  const row = dv.goals?.find(g => g.id === expiredId);
  eq('dayView lists the expired goal', row?.status, 'expired');
}

section('fitToday: every deferral reason (pure)');
{
  const s0 = S();
  const at = clock.now();
  const base = { id: 1, status: 'open', lastTry: null, from: dayStart(at, tz), to: addDays(dayStart(at, tz), 1, tz), minutes: 60 };
  const fit = (state, goal) => goals.fitToday(state, at, world, { ...base, ...goal }).reason ?? 'ok';
  const story = (patch) => ({ ...s0, story: { ...s0.story, ...patch } });
  eq('paused', fit(story({ controls: { ...s0.story.controls, paused: true } }), { goalKind: 'outing' }), 'paused');
  eq('frozen (social)', fit(story({ controls: { ...s0.story.controls, fate: { social: 'frozen' } } }), { goalKind: 'outing' }), 'frozen');
  eq('frozen (family) for a call', fit(story({ controls: { ...s0.story.controls, fate: { family: 'frozen' } } }), { goalKind: 'call', castId: 'cast:parent' }), 'frozen');
  eq('pinned', fit(story({ controls: { ...s0.story.controls, pins: { 'cast:flatmate': { at } } } }), { goalKind: 'meet', castId: 'cast:flatmate' }), 'pinned');
  eq('sick', fit({ ...s0, vitals: { ...s0.vitals, sick: true } }, { goalKind: 'outing' }), 'sick');
  eq('heavy', fit(story({ heavy: { ...(s0.story.heavy || {}), active: { id: 9, until: at + DAY } } }), { goalKind: 'outing' }), 'heavy');
  eq('away', fit(story({ castLife: { ...s0.story.castLife, 'cast:flatmate': { away: { until: at + DAY } } } }), { goalKind: 'meet', castId: 'cast:flatmate' }), 'away');
  eq('tired', fit({ ...s0, vitals: { ...s0.vitals, energy: 10 } }, { goalKind: 'outing' }), 'tired');
  eq('…but a call only needs 15 energy', fit({ ...s0, vitals: { ...s0.vitals, energy: 20 } }, { goalKind: 'call', castId: 'cast:parent' }) === 'tired', false);
  const noShops = { ...s0, places: new Map([...s0.places].filter(([, p]) => p.kind !== 'shop')) };
  eq('no_place (an errand, no shop)', fit(noShops, { goalKind: 'errand' }), 'no_place');
  eq('no_slot (the window closes within the hour)', fit(s0, { goalKind: 'outing', to: at + 50 * 60 }), 'no_slot');
}

section('the fold: reopen on could_not_go / sick; owner cancel closes (R8/R19)');
{
  const fold = (s, id, type, payload, extra = {}) => project(s, { id, at: 1793500000 + id, type, actor: 'engine', payload, originKind: 'self', originJid: 'self', causeId: null, ...extra }, world);
  const mk = (reason) => {
    let s = createInitialState(world);
    s = fold(s, 1, 'goal.set', { goalKind: 'outing', from: 1793400000, to: 1793900000, minutes: 60 }, { actor: 'owner', originKind: 'owner', originJid: 'owner' });
    s = fold(s, 2, 'goal.fitted', { goalId: 1, date: '2026-10-29', slotStart: 1793560000, slotEnd: 1793563600 }, { causeId: 1 });
    s = fold(s, 3, 'decision.opened', { kind: 'outing', goalId: 1, subject: { eventAt: 1793560000 }, options: [{ id: 'go' }, { id: 'late' }, { id: 'stay' }] }, { causeId: 2 });
    s = fold(s, 4, 'decision.committed', { decisionId: 3, optionId: 'go', by: 'goal' });
    eq(`${reason}: fitted with its decision`, [s.goals[1].status, s.goals[1].fitted.decisionId, s.decisions.get(3).committed.by], ['fitted', 3, 'goal']);
    return fold(s, 5, 'decision.expired', { decisionId: 3, reason }, reason === 'owner_cancelled' ? { actor: 'owner', originKind: 'owner', originJid: 'owner' } : {});
  };
  const a = mk('could_not_go');
  eq('could_not_go → reopened, tried today', [a.goals[1].status, a.goals[1].lastTry?.reason, a.decisions.get(3).status], ['open', 'could_not_go', 'missed']);
  const b = mk('sick');
  eq('sick before the point of no return → decision cancelled, goal reopened', [b.goals[1].status, b.decisions.get(3).status], ['open', 'cancelled']);
  const c = mk('owner_cancelled');
  eq('CANCEL TONIGHT on its outing → the goal closes', c.goals[1].status, 'cancelled');
  const e = fold(mk('frozen'), 6, 'goal.deferred', { goalId: 1, reason: 'no_slot' }, { causeId: 1 });
  eq('a deferral of an open goal only records the try', [e.goals[1].status, e.goals[1].lastTry.reason], ['open', 'no_slot']);
}

section('sick before the point of no return: the planned outing is dropped and the goal reopens (live)');
{
  const before = lastEventId();
  const { events } = await applyAction({ kind: 'goal', goalKind: 'outing', placeId: 'place:park', fromDay: 0, toDay: 2, minutes: 45 });
  const id = events.find(e => e.type === 'goal.set').id;
  await until(() => !!openedFor(before, id), 30);
  const opened = openedFor(before, id);
  if (opened && clock.now() < S().decisions.get(opened.id).ponrAt) {
    await applyAction({ kind: 'quick', button: 'sick_day' });
    await simulateHours(0.25);
    const exp = since(before).find(e => e.type === 'decision.expired' && e.payload.decisionId === opened.id);
    eq('decision.expired {sick}', exp?.payload.reason, 'sick');
    eq('goal reopened', goalOf(id).status, 'open');
  } else {
    check('fitted before its point of no return', false, { opened: !!opened });
  }
  await applyAction({ kind: 'goal.cancel', goalId: id });
}

section('CANCEL TONIGHT on a goal outing warns and closes the goal');
{
  await until(() => !(S().vitals?.sick || S().sick), 72);   // well again
  const before = lastEventId();
  const { events } = await applyAction({ kind: 'goal', goalKind: 'outing', placeId: 'place:cafe', fromDay: 1, toDay: 1, minutes: 60 });
  const id = events.find(e => e.type === 'goal.set').id;
  await until(() => !!openedFor(before, id), 40);
  const opened = openedFor(before, id);
  if (opened && dateKey(S().decisions.get(opened.id).subject.eventAt, tz) === dateKey(clock.now(), tz)) {
    const pv = await director.preview({ kind: 'quick', button: 'cancel_tonight' });
    check('warning: also cancels the goal', pv.warnings.includes(director.GOAL_PLAN), pv.warnings);
    await director.apply(pv.previewId, pv.fingerprint);
    eq('goal closed', goalOf(id).status, 'cancelled');
  } else {
    check('the goal fitted tonight', false, { opened: !!opened, why: goalOf(id)?.lastTry });
  }
}

section('revert: a goal whose outing began or is done cannot be reverted; a fresh one can');
{
  let msg = null;
  try { life.revertEvent(meetId, { reason: 'test' }); } catch (e) { msg = e.message; }
  check('a done goal → refused (cancel instead)', /cannot be reverted/.test(msg ?? ''), msg);
  const { events } = await applyAction({ kind: 'goal', goalKind: 'outing', fromDay: 3, toDay: 5 });
  const id = events.find(e => e.type === 'goal.set').id;
  const r = life.revertEvent(id, { reason: 'test' });
  check('an open goal that has not fitted yet can be reverted', Number.isSafeInteger(r.revertEventId) && !goalOf(id));
}

section('a rewind that takes the planned outing out reopens the goal (not done)');
{
  const before = lastEventId();
  const { events } = await applyAction({ kind: 'goal', goalKind: 'outing', placeId: 'place:cafe', fromDay: 0, toDay: 2, minutes: 45 });
  const id = events.find(e => e.type === 'goal.set').id;
  await until(() => !!openedFor(before, id), 40);
  const fitted = since(before).find(e => e.type === 'goal.fitted' && e.payload.goalId === id);
  if (fitted) {
    await applyAction({ kind: 'rewind', toEventId: fitted.id, reason: 'test' });
    eq('after the rewind: fitted, its decision gone', [goalOf(id)?.status, S().decisions.has(openedFor(before, id).id)], ['fitted', false]);
    await simulateHours(0.25);
    const lost = since(before).find(e => e.type === 'goal.deferred' && e.payload.goalId === id && e.payload.reason === 'rewound');
    check('goal.deferred {rewound}, not goal.done', !!lost && !since(before).some(e => e.type === 'goal.done' && e.payload.goalId === id));
    eq('…and the goal is open again', goalOf(id)?.status, 'open');
  } else {
    check('the goal fitted', false);
  }
}

section('a rewind that keeps the commit but takes the outing out reopens the goal (not done)');
{
  const before = lastEventId();
  const { events } = await applyAction({ kind: 'goal', goalKind: 'meet', castId: 'cast:flatmate', fromDay: 0, toDay: 2, minutes: 90 });
  const id = events.find(e => e.type === 'goal.set').id;
  await until(() => !!openedFor(before, id), 40);
  const opened = openedFor(before, id);
  const committed = opened && since(before).find(e => e.type === 'decision.committed' && e.payload.decisionId === opened.id);
  const ponrAt = opened && S().decisions.get(opened.id)?.ponrAt;
  if (committed && Number.isFinite(ponrAt) && committed.at < ponrAt) {
    await until(() => goalOf(id)?.status === 'done', 40);
    eq('the outing happened first: goal done', goalOf(id)?.status, 'done');
    // Back to just after the commit, before the point of no return: the decision
    // is kept (committed, by:goal) but the evening it rewrote is gone.
    const rw = lastEventId();
    const { events: rwEvents } = await applyAction({ kind: 'rewind', toEventId: committed.id, reason: 'test' });
    const exp = rwEvents.find(e => e.type === 'decision.expired' && e.payload.decisionId === opened.id);
    eq('the rewind expires the kept goal decision (rewound)', exp?.payload.reason, 'rewound');
    eq('…the decision is cancelled and the goal open again', [S().decisions.get(opened.id)?.status, goalOf(id)?.status, goalOf(id)?.lastTry?.reason],
      ['cancelled', 'open', 'rewound']);
    await simulateHours(10);
    const after = since(rw);
    check('no back-dated rewrite of the evening for that decision', !after.some(e => e.type === 'plan.made' && e.payload.amendedFor === opened.id));
    const refit = after.find(e => e.type === 'goal.fitted' && e.payload.goalId === id);
    const done = after.find(e => e.type === 'goal.done' && e.payload.goalId === id);
    check('no goal.done unless it fitted again first', !done || (refit && refit.id < done.id), { done: done?.id, refit: refit?.id });
  } else {
    check('the goal committed before its point of no return', false, { opened: !!opened, committed: !!committed });
  }
}

section('≤ 5 open goals');
{
  for (let i = 0; i < 6; i++) {
    if (goals.activeGoals(S()).length >= 5) break;
    await applyAction({ kind: 'goal', goalKind: 'outing', fromDay: 2, toDay: 5 });
  }
  eq('the 6th → refused full', codeOfSync(() => director.plan({ kind: 'goal', goalKind: 'outing', fromDay: 2, toDay: 5 }, S())), 'refused:full');
}

section('sims write nothing and show the goals');
{
  const rows = () => getDb().prepare('SELECT COUNT(*) AS n FROM world_events').get().n;
  const n0 = rows();
  const t = await director.previewTomorrow({});
  eq('preview tomorrow wrote nothing', rows(), n0);
  check('…and lists the open goals', (t.goals ?? []).length >= 1 && t.goals.every(g => typeof g.status === 'string'), t.goals);
  const dv = await life.dayView({});
  eq('the Day view wrote nothing either', rows(), n0);
  check('…its goals strip has the open goals', (dv.goals ?? []).filter(g => g.status === 'open' || g.status === 'planned').length >= 1, dv.goals);
}

section('chat-forbidden goal.* and the cause rule');
{
  const ptr = appendEvent({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'dm', originJid: '15550001111@s.whatsapp.net', payload: {} });
  let msg = null;
  try { appendEvent({ type: 'goal.expired', at: clock.now(), actor: 'engine', causeId: ptr.id, payload: {} }); } catch (e) { msg = e.message; }
  check('a goal.* caused by a chat pointer is refused', /cannot be caused by|chat origin/.test(msg ?? ''), msg);
  for (const t of ['goal.set', 'goal.cancelled']) {
    let m = null;
    try { appendEvent({ type: t, at: clock.now(), actor: 'engine', payload: {} }); } catch (e) { m = e.message; }
    check(`only the owner appends ${t}`, /only the owner/.test(m ?? ''), m);
  }
}

await stopLife();

section('prompt: "he should call his mum this week" → a goal draft');
{
  const s = S() ?? null;
  void s;
  const { rebuild, applyAppended } = await import('../../src/life/projector.js');
  let state = rebuild({ world });
  director.__setDepsForTest({ now: () => clock.now(), getState: () => state, world, append: (spec) => { const ev = appendEvent(spec); state = applyAppended(state, ev, { world }); return ev; }, knownNames: () => [] });
  const cr = fakeCallRole({
    'director.prompt': () => JSON.stringify({ actions: [{ action: { kind: 'goal', goalKind: 'call', castId: 'cast:parent', fromDay: 0, toDay: 6 }, why: 'a call home this week' },
      { action: { kind: 'goal', goalKind: 'meet', fromDay: 0, toDay: 3 }, why: 'no cast' },
      { action: { kind: 'goal.cancel', goalId: 1 }, why: 'not a goal' }] }),
  });
  promptMod.__setDepsForTest(null);
  promptMod.__setDepsForTest({ now: () => clock.now(), getState: () => state, world, callRole: cr.fn, mindBudgetOk: async () => ({ ok: true }),
    getUsageByCaller: () => [], knownNames: () => [], persona: { name: 'Testname', voiceDescriptor: 'plain' } });
  // A clean slate of goals for the catalogue count.
  state = { ...state, goals: {} };
  const res = await promptMod.runPrompt('he should call his mum this week');
  eq('one goal draft; the meet without cast and the unknown goal dropped', [res.drafts.length, res.dropped.map(d => d.reason)], [1, ['bad_field', 'unknown_ref']]);
  const d = res.drafts[0];
  const today = dateKey(clock.now(), tz);
  eq('the draft carries dates anchored to the prompt', [d.action.goalKind, d.action.castId, d.action.fromDate, d.action.toDate],
    ['call', 'cast:parent', today, dateKey(addDays(dayStart(clock.now(), tz), 6, tz), tz)]);
  eq('the route accepts it', actionProblem(d.action), null);
  const p = director.plan(d.action, state);
  const gs = p.events.find(e => e.type === 'goal.set').payload;
  eq('resolved: today 00:00 … the end of day 6', [gs.from, gs.to], [dayStart(clock.now(), tz), addDays(dayStart(clock.now(), tz), 7, tz)]);
  check('the catalogue lists goals (empty here)', /"goals":\[\]/.test(cr.callsFor('director.prompt')[0]?.user ?? ''));
  promptMod.__setDepsForTest(null);
  director.__setDepsForTest(null);
}

report();
