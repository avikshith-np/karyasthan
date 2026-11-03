// Wake him ("can't sleep"): the live night of 2026-10-30. He went to sleep at
// ~00:30 on a plan dated the day before (still in force past midnight); the
// owner wants "he can't sleep, gets up at ~01:15, goes out to a nearby place
// with a new person at 01:30, comes back, sleeps again". On e6cc84e the outing
// was accepted with `sleeping` + `projected_missed` and he slept through it:
// there was no way to wake him. Now: a Director `wake` action (owner wake.set →
// the pulse's early woke + the night's re-plan), a past-midnight locked outing
// fitted into the plan in force (Bug B), the continuity suggestion "he can't
// sleep: wake him at HH:MM" when he is asleep at an owner outing's point of no
// return, a next-date "stays up late" range in tonight's plan (Bug C), and a
// revert of the wake. Example world, fake clock, stubbed models.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, HOUR, fakeCallRole,
} from './_helpers.js';
import { buildCatalogue, batchableOf } from '../../src/life/story/prompt.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';
import { listEvents, getEvent } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';
import { isLockedOuting, ownerWakeDue, wakeFor } from '../../src/life/pulse.js';
import { overridesForPlan } from '../../src/life/planEdits.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(16);              // Tue 27 Oct ~22:00, at home
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const MIN = 60;
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
const since = (id, types) => listEvents({ types, limit: 5000 }).filter(e => e.id > id);
const lastId = () => Math.max(0, ...listEvents({ limit: 5000 }).map(e => e.id));
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
// Through the story facade (as the route does): a wake / schedule apply settles the pulse at once.
async function applyOk(action) {
  const p = await story.director.preview(action);
  const r = await story.director.apply(p.previewId, p.fingerprint);
  await story.lastScheduleKick();
  return { p, r };
}

const today0 = dayStart(clock.now(), tz);
const tomorrow = addDays(today0, 1, tz);
const NEAR = 'place:cafe';

section('tonight: asleep on yesterday\'s plan past midnight');
// He goes to bed at ~00:30 tonight: a "stays up late" range on the NEXT date (Bug C).
{
  const action = { kind: 'schedule', day: 1, ranges: [{ activity: 'home', from: '00:00', to: '00:30', label: 'Stays up late' }] };
  const { r } = await applyOk(action);
  check('the next-date range applied', r?.ok === true, JSON.stringify(r));
  const plan = S().plan;
  eq('the plan in force is still today\'s', plan.date, dateKey(today0 + 12 * HOUR, tz));
  check('Bug C: tonight\'s plan carries the next-date override', overridesForPlan(S(), plan, tz).length >= 1 && (plan.overrides ?? []).length >= 1, JSON.stringify(plan.overrides));
  const sleep = [...plan.blocks].reverse().find(b => b.kind === 'sleep');
  eq('…he goes to sleep at 00:30, not at his usual bedtime', sleep?.start, at(tomorrow, 0, 30));
  await stepTo(at(tomorrow, 0, 50));
  eq('asleep at 00:50', S().activity?.kind, 'sleep');
  eq('…since 00:30', S().activity?.startAt, at(tomorrow, 0, 30));
  eq('…on the plan dated yesterday', S().plan.date, dateKey(today0 + 12 * HOUR, tz));
}

section('Tell the story: "he can\'t sleep and goes out…" → a wake + the outing');
{
  const { model } = buildCatalogue(S(), world, clock.now(), tz);
  eq('the catalogue says he is asleep, since 00:30', [model.sleep?.asleep, model.sleep?.since], [true, '00:30']);
  check('…and when he wakes', /^\d\d:\d\d$/.test(model.sleep?.wakes ?? ''), JSON.stringify(model.sleep));
  const wake = { kind: 'wake', reason: 'cant_sleep', at: '01:15' };
  const outing = { kind: 'scene', shape: 'outing', placeId: NEAR, castIds: [], when: { day: 0, time: '01:30' }, minutes: 60, label: 'Midnight snack' };
  const fcr = fakeCallRole({ 'director.prompt': () => JSON.stringify({ actions: [{ action: wake, why: 'he can\'t sleep' }, { action: outing, why: 'out to clear his head', accompanies: 0 }], cantDo: [] }) });
  story.__setDepsForTest({ callRole: fcr.fn, getUsageByCaller: () => [], knownNames: () => [], mindBudgetOk: async () => ({ ok: true }) });
  const r = await story.director.prompt('he can\'t sleep, gets up around 01:15 and goes out to the cafe for a bite, then sleeps again');
  eq('two drafts, status ok', [r.status, r.drafts.length], ['ok', 2]);
  const wd = r.drafts.find(d => d.action.kind === 'wake');
  eq('the wake draft as drafted', wd?.action, wake);
  check('…planned (one wake.set, no refusals)', wd?.events > 0 && (wd.refusals ?? []).length === 0, JSON.stringify(wd));
  check('…never batchable', wd?.batchable === false && wd.reviewReason === 'target_resolved', JSON.stringify(wd));
  eq('…the route shape check passes', actionProblem(wd.action), null);
  eq('batchableOf(wake) → target_resolved', batchableOf(wake).reviewReason, 'target_resolved');
  check('the outing draft is there too', r.drafts.some(d => d.action.kind === 'scene' && d.action.shape === 'outing'), JSON.stringify(r.drafts.map(d => d.action)));
}

section('a new person and an outing at 01:30 while he sleeps: the wake suggestion');
let outingId = null;
let castId = null;
{
  const { r } = await applyOk({ kind: 'scene', shape: 'new_cast', name: 'Quill Nightowl', relation: 'friend' });
  check('new cast applied', r?.ok === true, JSON.stringify(r));
  castId = [...S().cast.values()].find(c => c.name === 'Quill Nightowl')?.id ?? null;
  check('…found', !!castId);
  const outing = { kind: 'scene', shape: 'outing', placeId: NEAR, startAt: at(tomorrow, 1, 30), minutes: 60, castIds: [castId], label: 'Clear my head and a bite' };
  const p = await director.preview(outing, { relax: true });
  const codes = (p.continuity?.warnings ?? []).map(w => w.code);
  check('the preview warns he is asleep', codes.includes('sleeping'), JSON.stringify(codes));
  check('…and that the projection shows him missing it (projected_missed)', codes.includes('projected_missed'), JSON.stringify(codes));
  const sug = (p.continuity?.suggestions ?? []).find(x => x.action?.kind === 'wake');
  check('…and offers "he can\'t sleep: wake him at HH:MM"', !!sug && /can't sleep: wake him at \d\d:\d\d/.test(sug.why ?? sug.text ?? ''), JSON.stringify(p.continuity?.suggestions));
  eq('…a wake before he must leave, reason cant_sleep', [sug?.action?.reason, typeof sug?.action?.at], ['cant_sleep', 'string']);
  // ADD → bundle [outing, wake]: no sleeping warning any more.
  const bundle = { kind: 'bundle', actions: [outing, sug.action] };
  const pb = await director.preview(bundle, { relax: true });
  const bcodes = (pb.continuity?.warnings ?? []).map(w => w.code);
  check('the bundle: no sleeping warning', !bcodes.includes('sleeping'), JSON.stringify(bcodes));
  check('…and no projected_missed', !bcodes.includes('projected_missed'), JSON.stringify(bcodes));
  const r2 = await story.director.apply(pb.previewId, pb.fingerprint);
  await story.lastScheduleKick();
  check('applied', r2?.ok === true, JSON.stringify(r2));
  const d = decisionOf('Clear my head and a bite');
  outingId = d?.id ?? null;
  check('the outing is locked (owner go)', isLockedOuting(d));
  const ws = (S().wakeSets ?? []).at(-1);
  eq('a wake request for tonight, cant_sleep', ws?.reason, 'cant_sleep');
  check('…before the outing', ws?.at < at(tomorrow, 1, 30) && ws?.at >= at(tomorrow, 0, 50), JSON.stringify(ws));
}

section('the night: up, out with the new person, home, asleep again, a later wake with debt');
{
  const before = lastId();
  const debt0 = S().vitals.sleepDebt;
  await stepTo(at(tomorrow, 1, 20));
  const woke = since(before, ['woke'])[0];
  check('he woke early, caused by the owner\'s request', woke?.payload?.interrupted === true && getEvent(woke.causeId)?.type === 'wake.set', JSON.stringify(woke));
  check('…before 01:20', woke?.at <= at(tomorrow, 1, 20) && woke?.at >= at(tomorrow, 0, 50));
  check('awake now', S().activity?.kind !== 'sleep', JSON.stringify(S().activity));
  eq('the morning\'s debt is not settled by a night wake', S().vitals.sleepDebt.toFixed(2), debt0.toFixed(2));
  await stepTo(at(tomorrow, 3, 30));
  const trips = since(before, ['travel.started']);
  check('he went out (a trip to the place)', trips.some(e => e.payload.to === NEAR), JSON.stringify(trips.map(e => e.payload)));
  const acts = since(before, ['activity.started']).filter(e => e.payload.placeId === NEAR && e.payload.kind !== 'free');
  check('…the outing with the new person', acts.some(e => (e.payload.withCast ?? []).includes(castId)), JSON.stringify(acts.map(e => e.payload)));
  check('…and came home', trips.some(e => e.payload.from === NEAR && e.payload.to === S().self.homePlaceId));
  const sleeps = since(before, ['sleep.started']);
  check('asleep again after', sleeps.length === 1 && sleeps[0].at > at(tomorrow, 2, 0), JSON.stringify(sleeps.map(e => e.at)));
  eq('asleep at 03:30', S().activity?.kind, 'sleep');
  eq('no could_not_go', since(before, ['decision.expired']).filter(e => e.payload.decisionId === outingId).map(e => e.payload.reason), []);
  const w = wakeFor(S(), world);
  check('his wake is later in the morning', w?.at > at(tomorrow, 6, 0), JSON.stringify(w));
  await stepTo(w.at + 10 * MIN);
  const morning = since(before, ['woke']).filter(e => e.payload?.interrupted !== true);
  eq('one morning wake', morning.length, 1);
  check('…which settles the broken night (debt up)', S().vitals.sleepDebt > debt0, `${debt0} → ${S().vitals.sleepDebt}`);
  check('…and starts a new day\'s plan', S().plan.date === dateKey(tomorrow + 12 * HOUR, tz), S().plan.date);
  // The morning's plan is dated the outing's date but starts after it: not "missed".
  eq('the outing is not expired by the new day (could_not_go)', since(before, ['decision.expired']).filter(e => e.payload.decisionId === outingId).map(e => e.payload.reason), []);
}

section('wake him now (preview, apply, revert)');
{
  // The next night: asleep → wake now, until 20 min later; then REVERT THIS CHANGE.
  const night = addDays(tomorrow, 1, tz);
  await stepTo(at(night, 2, 0));
  eq('asleep at 02:00', S().activity?.kind, 'sleep');
  const sleepStart = S().activity.startAt;
  eq('refused while asleep only: an "until" after his wake', (() => { try { director.plan({ kind: 'wake', reason: 'woken_up', until: '11:59' }, S()); return 'ok'; } catch (e) { return e.reason ?? e.code; } })(), 'bad_until');
  const bad = (() => { try { director.plan({ kind: 'wake', reason: 'nope' }, S()); return 'ok'; } catch (e) { return e.reason ?? e.code; } })();
  eq('a bad reason → invalid', bad, 'bad_reason');
  const before = lastId();
  const { p, r } = await applyOk({ kind: 'wake', reason: 'woken_up', until: '02:30' });
  check('the preview names the time', p.warnings.some(w => /wakes him at .* 02:00/.test(w)), JSON.stringify(p.warnings));
  check('applied', r?.ok === true, JSON.stringify(r));
  check('awake at once (woken now, no wait for the next tick)', S().activity?.kind !== 'sleep', JSON.stringify(S().activity));
  check('a woke within minutes', since(before, ['woke']).some(e => e.payload?.interrupted === true && e.at <= at(night, 2, 5)));
  const actionId = r.eventIds.map(getEvent).find(e => e.type === 'director.action')?.id;
  const rv = life.revertChangePreview(actionId);
  eq('REVERT THIS CHANGE is allowed before his morning', rv.refusals ?? [], []);
  check('…described in words', /Wake/.test(rv.description ?? ''), rv.description);
  life.revertChange(actionId, { fingerprint: rv.fingerprint });
  eq('reverted: asleep again from his first sleep', [S().activity?.kind, S().activity?.startAt], ['sleep', sleepStart]);
  eq('…and no wake request left', ownerWakeDue(S(), wakeFor(S(), world)), null);
  await stepTo(at(night, 3, 0));
  eq('…still asleep at 03:00 (the wake stays undone)', S().activity?.kind, 'sleep');
}

section('a past-midnight owner outing while he is still up: no wake needed (Bug B)');
{
  const day3 = addDays(tomorrow, 2, tz);
  await stepTo(at(day3, 22, 0));
  check('awake at 22:00', S().activity?.kind !== 'sleep', JSON.stringify(S().activity));
  const before = lastId();
  const sets0 = (S().wakeSets ?? []).length;
  const night = addDays(day3, 1, tz);
  const { r } = await applyOk({ kind: 'scene', shape: 'outing', placeId: NEAR, startAt: at(night, 0, 45), minutes: 60, castIds: [], label: 'After-midnight chai' });
  check('applied', r?.ok === true, JSON.stringify(r));
  const d = decisionOf('After-midnight chai');
  await stepTo(at(day3, 22, 30));
  check('fitted into tonight\'s plan (dated today, past his usual bedtime)', S().plan.blocks.some(b => b.decisionId === d?.id && b.kind !== 'commute'), JSON.stringify(S().plan.blocks.map(b => [b.kind, b.start])));
  await stepTo(at(night, 3, 0));
  check('he went (a trip to the place after midnight)', since(before, ['travel.started']).some(e => e.payload.to === NEAR && e.at >= at(day3, 23, 30)));
  eq('no wake request was needed', (S().wakeSets ?? []).length, sets0);
  eq('no could_not_go', since(before, ['decision.expired']).filter(e => e.payload.decisionId === d?.id).map(e => e.payload.reason), []);
  eq('asleep at 03:00', S().activity?.kind, 'sleep');
  await stepTo(at(night, 12, 0));
  eq('…nor after his morning', since(before, ['decision.expired']).filter(e => e.payload.decisionId === d?.id).map(e => e.payload.reason), []);
}

section('a wake set after the outing\'s point of no return: he goes late, not "could not go"');
{
  const day5 = addDays(tomorrow, 4, tz);
  await stepTo(at(day5, 0, 50));
  eq('asleep at 00:50', S().activity?.kind, 'sleep');
  const before = lastId();
  const outing = { kind: 'scene', shape: 'outing', placeId: NEAR, startAt: at(day5, 1, 30), minutes: 60, castIds: [], label: 'Late bite' };
  const p = await story.director.preview(outing);
  const sug = (p.continuity?.suggestions ?? []).find(x => x.action?.kind === 'wake');
  const sugAt = sug ? at(day5, Number(sug.action.at.slice(0, 2)), Number(sug.action.at.slice(3))) : null;
  // The owner types 01:25 instead (after the ponr).
  const { r } = await applyOk({ kind: 'bundle', actions: [outing, { kind: 'wake', reason: 'cant_sleep', at: '01:25' }] });
  check('applied', r?.ok === true, JSON.stringify(r));
  const d = decisionOf('Late bite');
  check('the suggested wake was not after its point of no return', Number.isFinite(d?.ponrAt) && sugAt <= d.ponrAt, JSON.stringify({ sug: sug?.action, ponr: d?.ponrAt }));
  check('…and 01:25 is after it (the case under test)', at(day5, 1, 25) > d?.ponrAt, String(d?.ponrAt));
  await stepTo(at(day5, 3, 30));
  eq('no could_not_go', since(before, ['decision.expired']).filter(e => e.payload.decisionId === d?.id).map(e => e.payload.reason), []);
  check('he went (late)', since(before, ['travel.started']).some(e => e.payload.to === NEAR && e.at >= at(day5, 1, 25)), JSON.stringify(since(before, ['travel.started']).map(e => [e.at, e.payload.to])));
}

section('chat paths never reach it');
{
  const { appendEvent } = await import('../../src/life/eventLog.js');
  let refused = false;
  try { appendEvent({ type: 'wake.set', at: clock.now(), actor: 'engine', payload: { at: clock.now(), reason: 'cant_sleep' } }); } catch { refused = true; }
  check('wake.set from the engine → refused (owner-only)', refused);
}

report();
