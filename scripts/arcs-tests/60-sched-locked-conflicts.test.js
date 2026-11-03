// Live replay (sched-fixes): two drafts from one Director prompt — a scene (a
// hangout 00:15–01:15 at a nearby place, committed go by the owner) and a
// schedule edit "stays up late" (home 01:15–02:30 the next date). The schedule's
// conflict check listed the outing with resolution 'cancel' (its window was the
// outing + a default 2 h, as the projector keeps no subject minutes), so the apply
// appended decision.expired {schedule} and the outing was gone. Now: ranges are
// half-open and an outing ends where its late option expires, so a range from the
// outing's end (or over only its trip home, for 'home') is no conflict; a locked
// outing (owner / goal / adopted) that really overlaps is kept by default (the
// range trimmed around it, a warning); a cancel only when the owner picks it, and
// then a HIGH continuity warning "this cancels <label> at HH:MM" (the I KNOW tick)
// with the keys for "keep it instead". Also: CHANGES says what each change did,
// today's Day page after 18:00 shows tonight past midnight (the 00:15 plan) and
// Life · Now lists plans of the next 12 h. Example world, fake clock, stubbed models.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents, getEvent } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone, dayLabel } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import { config } from '../../src/utils/config.js';
import { isLockedOuting } from '../../src/life/pulse.js';
import Fastify from 'fastify';
import lifeRoutes from '../../src/dashboard/routes/life.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(16);              // Tue 27 Oct ~22:00, at home
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const hoursUntil = (t) => Math.max(0, Math.ceil((t - clock.now()) / HOUR));
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
const expiredFor = (id) => listEvents({ types: ['decision.expired'], limit: 2000 }).filter(e => e.payload?.decisionId === id);
const warningsOf = (p) => p.continuity?.warnings ?? [];
async function applyScene(action) {
  const p = await director.preview(action, { relax: true });
  return director.apply(p.previewId, p.fingerprint);
}

const tomorrow = addDays(dayStart(clock.now(), tz), 1, tz);
const NEAR = 'place:cafe';

section('the replay: outing 00:15–01:15 (owner go) + home 01:15–02:30 → the outing is kept');
let snackId = null;
{
  await applyScene({ kind: 'scene', shape: 'outing', placeId: NEAR, startAt: at(tomorrow, 0, 15), minutes: 60, castIds: [], label: 'Late-night snack run' });
  const d = decisionOf('Late-night snack run');
  snackId = d?.id ?? null;
  check('the outing is an owner-committed go (locked)', isLockedOuting(d), JSON.stringify(d?.committed));
  // Item 4: at 22:00 today's Day page shows tonight past midnight, and Life · Now lists the plan.
  const day = await life.dayView({ date: dateKey(clock.now(), tz) });
  const tn = day?.tonight;
  check('Day (today, after 18:00): a TONIGHT strip from midnight, ≥ 6 h', tn?.from === tomorrow && tn.to >= tomorrow + 6 * HOUR, JSON.stringify({ from: tn?.from, to: tn?.to }));
  check('…listing the 00:15 plan', (tn?.decisions ?? []).some(x => x.id === snackId && x.at === at(tomorrow, 0, 15)), JSON.stringify(tn?.decisions));
  check('…and its projected hours (his sleep past midnight)', (tn?.spans ?? []).some(x => x.cat === 'sleep'), JSON.stringify(tn?.spans?.map(x => [x.at, x.kind])));
  eq('…not today\'s own rows (they stop at midnight)', (day.future?.spans ?? []).every(x => x.at < tomorrow), true);
  const app = Fastify();
  await app.register(lifeRoutes);
  const now = (await app.inject({ method: 'GET', url: '/api/life/now' })).json();
  const up = (now.upcoming ?? []).find(x => x.id === snackId);
  eq('Life · Now: the plan in the next 12 h (label, 00:15, committed go, not in the plan)', [up?.label, up?.start, up?.committed, up?.inPlan], ['Late-night snack run', at(tomorrow, 0, 15), 'go', false]);
  await app.close();
  const action = { kind: 'schedule', day: 1, ranges: [{ activity: 'home', from: '01:15', to: '02:30', label: 'Stays up late watching a show' }] };
  const p = director.plan(action, S());
  eq('no conflict row for the outing', p.extra.conflicts.filter(r => r.id === snackId), []);
  eq('no decision.expired in the plan', p.events.filter(e => e.type === 'decision.expired').length, 0);
  check('no cancels_plan warning', !warningsOf(p).some(w => w.code === 'cancels_plan'), JSON.stringify(warningsOf(p)));
  eq('the range is unchanged (01:15–02:30)', p.events.find(e => e.type === 'schedule.override_set')?.payload.ranges.map(r => [r.from, r.to]),
    [[at(tomorrow, 1, 15), at(tomorrow, 2, 30)]]);
  const pv = await director.preview(action);
  await director.apply(pv.previewId, pv.fingerprint);
  eq('…applied: still committed, no expiry', [S().decisions.get(snackId)?.status, expiredFor(snackId).length], ['committed', 0]);
  await simulateHours(hoursUntil(at(tomorrow, 3, 0)));
  eq('…and none later (the pulse\'s schedule re-plan keeps it too)', expiredFor(snackId).map(e => e.payload.reason), []);
  eq('…still committed', S().decisions.get(snackId)?.status, 'committed');
}

section('a home range over only the trip home is no conflict either');
{
  // The next evening: an outing 21:00–22:00 at the cafe, then home from 22:05 (he is still walking back).
  await simulateHours(hoursUntil(at(tomorrow, 18, 0)));
  await applyScene({ kind: 'scene', shape: 'outing', placeId: NEAR, startAt: at(tomorrow, 21, 0), minutes: 60, castIds: [], label: 'Coffee with nobody' });
  const d = decisionOf('Coffee with nobody');
  const p = director.plan({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '22:05', to: '23:30' }] }, S());
  eq('no conflict row', p.extra.conflicts.filter(r => r.id === d?.id), []);
}

section('a truly overlapping range: kept by default, the range trimmed around it, a warning');
let mainId = null;
const day2 = addDays(tomorrow, 1, tz);
{
  await applyScene({ kind: 'scene', shape: 'outing', placeId: NEAR, startAt: at(day2, 20, 0), minutes: 60, castIds: [], label: 'Dinner with no one' });
  const d = decisionOf('Dinner with no one');
  mainId = d?.id ?? null;
  check('locked', isLockedOuting(d));
  // home 19:00–23:00 covers the whole outing.
  const action = { kind: 'schedule', day: 1, ranges: [{ activity: 'home', from: '19:00', to: '23:00' }] };
  const p = director.plan(action, S());
  const row = p.extra.conflicts.find(r => r.id === mainId);
  eq('the row: keep by default, kept, both choices', [row?.resolution, row?.outcome, row?.choices], ['keep', 'kept', ['cancel', 'keep']]);
  eq('no decision.expired', p.events.filter(e => e.type === 'decision.expired').length, 0);
  eq('the range split around the outing', p.events.find(e => e.type === 'schedule.override_set')?.payload.ranges.map(r => [r.from, r.to]),
    [[at(day2, 19, 0), at(day2, 20, 0)], [at(day2, 21, 0), at(day2, 23, 0)]]);
  const w = warningsOf(p).find(x => x.code === 'keeps_plan');
  check('a keeps_plan warning naming it', w?.severity === 'warn' && /Dinner with no one/.test(w.text) && /20:00/.test(w.text), JSON.stringify(warningsOf(p)));
  check('no HIGH cancel warning', !warningsOf(p).some(x => x.code === 'cancels_plan'));
  // A range that only starts inside it: trimmed to start at the outing's end.
  const p2 = director.plan({ kind: 'schedule', day: 1, ranges: [{ activity: 'gym', from: '20:30', to: '22:00' }] }, S());
  eq('…a range starting inside it is moved to its end', p2.events.find(e => e.type === 'schedule.override_set')?.payload.ranges.map(r => [r.from, r.to]),
    [[at(day2, 21, 0), at(day2, 22, 0)]]);
}

section('an explicit cancel: a HIGH warning with the keep key, and it cancels');
{
  const key = `decision:${mainId}`;
  const action = { kind: 'schedule', day: 1, ranges: [{ activity: 'home', from: '19:00', to: '23:00' }], resolutions: { [key]: 'cancel' } };
  const p = director.plan(action, S());
  const row = p.extra.conflicts.find(r => r.id === mainId);
  eq('the row: cancel, cancelled', [row?.resolution, row?.outcome], ['cancel', 'cancelled']);
  const w = warningsOf(p).find(x => x.code === 'cancels_plan');
  check('HIGH "this cancels Dinner with no one at 20:00"', w?.severity === 'high' && /this cancels Dinner with no one at 20:00/.test(w.text), JSON.stringify(warningsOf(p)));
  eq('…with the key for KEEP IT INSTEAD', w?.keep, [key]);
  const pv = await director.preview(action);
  check('the preview carries it too', (pv.continuity?.warnings ?? []).some(x => x.code === 'cancels_plan' && x.severity === 'high'));
  const res = await director.apply(pv.previewId, pv.fingerprint);
  const exp = res.eventIds.map(getEvent).filter(e => e.type === 'decision.expired' && e.payload.decisionId === mainId);
  eq('applied: one decision.expired {schedule}', exp.map(e => e.payload.reason), ['schedule']);
  eq('the outing is cancelled', S().decisions.get(mainId)?.status, 'cancelled');
  // CHANGES says what the change did, in words.
  const actionId = res.eventIds.map(getEvent).find(e => e.type === 'director.action')?.id;
  const change = story.godView().changes.find(c => c.id === actionId);
  eq('CHANGES: the schedule change described', change?.description,
    `Schedule · ${dayLabel(at(day2, 19, 0), tz)} · home 19:00–23:00 · cancelled: Dinner with no one`);
  const rv = life.revertChangePreview(actionId);
  eq('REVERT THIS CHANGE confirm: the same description', rv.description, change?.description);
}

section('CHANGES: the replay\'s two changes in words');
{
  const rows = story.godView().changes;
  const sched = rows.find(c => c.kind === 'schedule' && /01:15–02:30/.test(c.description ?? ''));
  eq('the schedule edit', sched?.description, `Schedule · ${dayLabel(at(tomorrow, 1, 15), tz)} · home 01:15–02:30 'Stays up late watching a…'`);
  const scene = rows.find(c => c.kind === 'scene' && /Late-night snack run/.test(c.description ?? ''));
  check('the scene: its label, place, day and times, committed go', /^Scene · Late-night snack run at .+ · \S+ \d+ \S+ 00:15–01:15 · committed: go$/.test(scene?.description ?? ''), scene?.description);
}

report();
