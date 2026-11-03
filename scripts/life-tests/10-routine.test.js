// T015 — daily plan (src/life/routine.js): weekday shapes (office Tue–Thu, WFH
// Mon/Fri, free weekends), meals, commutes via travel.js, availability per
// block, wake from sleep debt, the work.late roll, sick days, rain → cab, and
// determinism. Pure: no DB, no network, no clock reads, no LLM.

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, section, check, eq, report } from './_helpers.js';

const R = await import('../../src/life/routine.js');
const {
  planDay, wakeTime, rollWorkLate, dayType, expectedSleepDebt, blockAt, checkPlan, availabilityFor,
  routineOf, AVAILABILITY_STATES,
} = R;
const { setRngSeed } = await import('../../src/life/rng.js');
const { setClock, hhmm, atLocal } = await import('../../src/life/clock.js');
const { validateWorld } = await import('../../src/life/world.js');
const { activityClass, lateWakeMinutes } = await import('../../src/life/vitals.js');

setRngSeed('routine-test');
// planDay must never read the clock: a throwing clock proves it.
setClock(() => { throw new Error('routine read the clock'); });

const TZ = 'UTC';
const example = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/world.example.json'), 'utf-8'));
const NOW = Date.UTC(2026, 9, 28) / 1000;
const world = validateWorld({ ...example, timezone: TZ }, { now: NOW });
const HOME = world.self.homePlaceId;
const OFFICE = world.self.job.officePlaceId;
const utc = (d, h = 6, m = 0) => Date.UTC(2026, 9, d, h, m) / 1000; // October 2026 (d > 31 rolls into Nov)
const at = (p, hm) => atLocal(utc(p), hm, TZ);
const calm = { vitals: { sleepDebt: 0, workPressure: 40, energy: 70, socialBattery: 60, stress: 30 } };
const kinds = p => p.blocks.map(b => b.kind);
const fmt = p => p.blocks.map(b => `${hhmm(b.start, TZ)} ${b.kind}@${b.placeId ?? `${b.from}>${b.to}`}/${b.availability}`).join(' | ');

// Mon 26 Oct … Sun 1 Nov 2026
const WEEK = [26, 27, 28, 29, 30, 31, 32];
const EXPECT = { 26: 'wfh', 27: 'office', 28: 'office', 29: 'office', 30: 'wfh', 31: 'weekend', 32: 'weekend' };

section('weekday shapes (Mon–Sun)');
const plans = {};
for (const d of WEEK) {
  const p = planDay(calm, utc(d), world);
  plans[d] = p;
  const name = `${p.date} ${EXPECT[d]}`;
  eq(`${name}: day type`, p.dayType, EXPECT[d]);
  eq(`${name}: plan is sound`, checkPlan(p, world), []);
  const work = p.blocks.filter(b => b.kind === 'work');
  const toOffice = p.blocks.filter(b => b.kind === 'commute' && b.to === OFFICE);
  const fromOffice = p.blocks.filter(b => b.kind === 'commute' && b.from === OFFICE);
  if (EXPECT[d] === 'office') {
    check(`${name}: commutes to and from the office`, toOffice.length === 1 && fromOffice.length === 1, fmt(p));
    check(`${name}: all work at the office`, work.length > 0 && work.every(b => b.placeId === OFFICE), fmt(p));
    check(`${name}: arrives by work start`, toOffice[0].end <= at(d, '09:30'), hhmm(toOffice[0].end, TZ));
    check(`${name}: leaves the office at work end`, fromOffice[0].start === at(d, '18:00'), hhmm(fromOffice[0].start, TZ));
    check(`${name}: office desk → light`, work.every(b => b.availability === 'light'));
    check(`${name}: lunch with coworkers → light`,
      p.blocks.some(b => b.kind === 'lunch' && b.placeId === OFFICE && b.withCast?.length && b.availability === 'light'));
  } else if (EXPECT[d] === 'wfh') {
    check(`${name}: no office trip`, toOffice.length === 0 && fromOffice.length === 0, fmt(p));
    check(`${name}: all work at home, focused → busy`, work.length > 0 && work.every(b => b.placeId === HOME && b.availability === 'busy'));
    eq(`${name}: work starts at 09:30`, hhmm(work[0].start, TZ), '09:30');
    check(`${name}: a WFH break (break → free)`, p.blocks.some(b => b.kind === 'break' && b.availability === 'free'), fmt(p));
    check(`${name}: no 'idle' gap inside the work day`, !p.blocks.some(b => b.kind === 'idle'), fmt(p));
  } else {
    check(`${name}: no work, no meetings`, !p.blocks.some(b => ['work', 'meeting'].includes(b.kind)), fmt(p));
    check(`${name}: no office trip`, toOffice.length === 0);
    check(`${name}: wakes near weekendWake`, Math.abs(p.wakeAt - at(d, '09:00')) <= 10 * 60, hhmm(p.wakeAt, TZ));
  }
  if (EXPECT[d] !== 'weekend') {
    const meetings = p.blocks.filter(b => b.kind === 'meeting');
    const [lo, hi] = world.routine.meetings.count;
    check(`${name}: ${lo}–${hi} meetings inside work hours`, meetings.length >= lo && meetings.length <= hi
      && meetings.every(b => b.start >= at(d, '09:30') && b.end <= at(d, '18:00') && b.availability === 'meeting'), fmt(p));
    check(`${name}: meeting starts are typicalTimes`,
      meetings.every(b => world.routine.meetings.typicalTimes.includes(hhmm(b.start, TZ))));
  }
  for (const m of ['breakfast', 'lunch']) check(`${name}: ${m}`, kinds(p).includes(m), fmt(p));
  check(`${name}: dinner (home or eating out)`,
    kinds(p).includes('dinner') || p.blocks.some(b => b.kind === 'eat-out' && b.meal === 'dinner'), fmt(p));
  const last = p.blocks[p.blocks.length - 1];
  check(`${name}: ends asleep at home`, last.kind === 'sleep' && last.placeId === HOME && last.availability === 'asleep');
  check(`${name}: every availability is a known state`, p.blocks.every(b => AVAILABILITY_STATES.includes(b.availability)));
  check(`${name}: every kind has a vitals rate class`,
    p.blocks.every(b => activityClass(b, world) !== 'awake'), p.blocks.filter(b => activityClass(b, world) === 'awake').map(b => b.kind));
  check(`${name}: commutes carry trip fields`, p.blocks.filter(b => b.kind === 'commute')
    .every(b => b.minutes === (b.end - b.start) / 60 && typeof b.mode === 'string' && b.km > 0 && b.cost >= 0));
}
check('Fri and Sat nights end later (next day is a weekend)',
  plans[30].sleepAt === at(30, '23:30') + 1800 && plans[31].sleepAt === at(31, '23:30') + 1800 && plans[29].sleepAt === at(29, '23:30'),
  [30, 31, 29].map(d => hhmm(plans[d].sleepAt, TZ)));
check('the night sleep runs to the next nominal wake', plans[29].nextWakeAt === at(30, '07:30') && plans[30].nextWakeAt === at(31, '09:00'));
check('weekend leisure: not the same thing twice in a day', [31, 32].every(d => {
  const l = plans[d].blocks.filter(b => b.leisure).map(b => b.kind);
  return new Set(l).size === l.length;
}));

section('determinism and roll isolation');
for (const d of WEEK) eq(`${plans[d].date}: same inputs → same plan`, JSON.stringify(planDay(calm, utc(d), world)), JSON.stringify(plans[d]));
eq('YYYY-MM-DD and unix on that day give the same plan', JSON.stringify(planDay(calm, '2026-10-27', world)), JSON.stringify(plans[27]));
eq('any time of the day gives the same plan', JSON.stringify(planDay(calm, utc(27, 22, 15), world)), JSON.stringify(plans[27]));
{
  const late = planDay({ vitals: { ...calm.vitals, sleepDebt: 2 } }, utc(28), world);
  const starts = p => p.blocks.filter(b => b.kind === 'meeting').map(b => b.start);
  eq('a later wake does not move the meetings', starts(late), starts(plans[28]));
}
setRngSeed('another-install');
check('another install seed plans a different week', WEEK.some(d => JSON.stringify(planDay(calm, utc(d), world)) !== JSON.stringify(plans[d])));
setRngSeed('routine-test');

section('wake from sleep debt');
for (const debt of [0, 1, 2.5, 6]) {
  const w0 = wakeTime(calm, utc(28), world);
  const w = wakeTime({ vitals: { ...calm.vitals, sleepDebt: debt } }, utc(28), world);
  eq(`debt ${debt}: lateBy = lateWakeMinutes`, w.lateBy, lateWakeMinutes(debt));
  eq(`debt ${debt}: wakes exactly lateBy later`, w.at - w0.at, lateWakeMinutes(debt) * 60);
}
check('jitter is within ±10 min', Math.abs(wakeTime(calm, utc(28), world).jitter) <= 10);
eq('plan.wakeAt = wakeTime().at', plans[28].wakeAt, wakeTime(calm, utc(28), world).at);
{
  const p = planDay(calm, utc(28), world, { wakeAt: at(28, '07:05'), lateBy: 7 });
  check('explicit wakeAt anchors the plan', p.wakeAt === at(28, '07:05') && p.lateBy === 7 && checkPlan(p, world).length === 0);
}
{
  // Asleep since 23:30 after a normal 16 h day: the night settles to ~0 → no late wake.
  const asleep = (sleepAt) => ({ vitals: { ...calm.vitals, sleepDebt: 0, night: { awakeMin: (sleepAt - at(27, '07:30')) / 60 } },
    activity: { kind: 'sleep', startAt: sleepAt } });
  const normal = asleep(at(27, '23:30'));
  const lateNight = asleep(at(27, '23:30') + 2 * 3600); // went to bed 2 h late
  const base = at(28, '07:30');
  check('normal night → expected debt ≈ 0', Math.abs(expectedSleepDebt(normal, base, world)) < 1e-9, expectedSleepDebt(normal, base, world));
  eq('2 h late night → expected debt 2', Math.round(expectedSleepDebt(lateNight, base, world) * 100) / 100, 2);
  const wn = wakeTime(normal, utc(28), world);
  const wl = wakeTime(lateNight, utc(28), world);
  eq('late night → wakes 40 min later the same morning', wl.at - wn.at, lateWakeMinutes(2) * 60);
  eq('expected debt is stable across ticks while asleep', expectedSleepDebt({ ...lateNight, at: base - 3600 }, base, world),
    expectedSleepDebt(lateNight, base, world));
  check('not asleep → current sleepDebt', expectedSleepDebt({ vitals: { sleepDebt: 3.5 } }, base, world) === 3.5);
}
{
  const p = planDay(calm, utc(28), world, { wakeAt: at(28, '09:10') });
  const toOffice = p.blocks.find(b => b.kind === 'commute' && b.to === OFFICE);
  check('very late wake: breakfast skipped', p.skipped.includes('breakfast') && !kinds(p).includes('breakfast'), p.skipped);
  check('very late wake: leaves after getting ready', toOffice.start >= at(28, '09:10') + world.routine.prepMinutes * 60);
  check('very late wake: work starts on arrival', p.blocks.find(b => b.kind === 'work').start === toOffice.end);
  eq('very late wake: plan is sound', checkPlan(p, world), []);
}

section('work.late roll');
check('work pressure ≤ 70 never runs late', Array.from({ length: 60 }, (_, i) => rollWorkLate({ workPressure: 70 }, `2026-11-${i}`)).every(x => x === null));
{
  const pressured = { vitals: { ...calm.vitals, workPressure: 95 } };
  const rolls = Array.from({ length: 200 }, (_, i) => rollWorkLate(pressured.vitals, `d${i}`)).filter(Boolean);
  check('pressure 95 runs late sometimes, not always', rolls.length > 20 && rolls.length < 180, rolls.length);
  check('late extra is 30–120 min in 30-min steps', rolls.every(x => [30, 60, 90, 120].includes(x.minutes)));
  eq('same day → same roll', JSON.stringify(rollWorkLate(pressured.vitals, '2026-10-28')), JSON.stringify(rollWorkLate(pressured.vitals, '2026-10-28')));

  let found = null;
  for (let d = 26; d < 26 + 60 && !found; d++) {
    const p = planDay(pressured, utc(d), world);
    if (p.workLate) found = { d, p };
  }
  check('a work day within two months runs late', !!found);
  if (found) {
    const { d, p } = found;
    const onTime = planDay(pressured, utc(d), world, { workLateMin: 0 });
    const lastWork = b => b.filter(x => x.kind === 'work').pop();
    const m = p.workLate.minutes;
    check(`${p.date}: a work day`, ['office', 'wfh'].includes(p.dayType));
    eq(`${p.date}: work block ends ${m} min later`, lastWork(p.blocks).end - lastWork(onTime.blocks).end, m * 60);
    eq(`${p.date}: workLate.normalEnd is the usual end`, p.workLate.normalEnd, lastWork(onTime.blocks).end);
    eq(`${p.date}: workLate.end is the new end`, p.workLate.end, lastWork(p.blocks).end);
    check(`${p.date}: last work block carries lateBy`, lastWork(p.blocks).lateBy === m);
    eq(`${p.date}: sleep pushed by half the extra`, p.sleepAt - onTime.sleepAt, Math.round(m / 2) * 60);
    check(`${p.date}: no leisure after a late day`, !p.blocks.some(b => b.leisure));
    eq(`${p.date}: late plan is sound`, checkPlan(p, world), []);
    check(`${p.date}: p recorded`, p.workLate.p > 0 && p.workLate.p <= 0.6);
  }
  const forced = planDay(calm, utc(28), world, { workLateMin: 90 });
  check('forced workLateMin works on a calm day', forced.workLate?.minutes === 90 && checkPlan(forced, world).length === 0);
  eq('weekends never run late', planDay(pressured, utc(31), world, { workLateMin: 90 }).workLate, null);
}

section('sick day');
{
  const sick = { vitals: { ...calm.vitals, sick: true } };
  const p = planDay(sick, utc(28), world);
  eq('Wednesday while sick → sick day', p.dayType, 'sick');
  eq('dayType() agrees', dayType(utc(28), world, sick.vitals), 'sick');
  check('no work, meetings or commute', !p.blocks.some(b => ['work', 'meeting', 'commute'].includes(b.kind)), fmt(p));
  check('no leisure', !p.blocks.some(b => b.leisure));
  check('at most light all day (never free)', p.blocks.every(b => b.availability !== 'free'), fmt(p));
  check('meals still happen', ['breakfast', 'lunch', 'dinner'].every(k => kinds(p).includes(k)));
  check('stays home', p.blocks.every(b => b.placeId === HOME));
  eq('sick plan is sound', checkPlan(p, world), []);
}

section('travel and weather');
{
  const rainy = planDay(calm, utc(28), world, { weather: () => ({ rain: true }) });
  const dry = planDay(calm, utc(28), world, { weather: () => ({ rain: false }) });
  const commute = p => p.blocks.find(b => b.kind === 'commute' && b.to === OFFICE);
  eq('rain → cab to the office', commute(rainy).mode, 'cab');
  eq('cab commute → light', commute(rainy).availability, 'light');
  eq('dry → default mode', commute(dry).mode, world.travel.defaultMode);
  eq('riding a scooter → busy', commute(dry).availability, 'busy');
  check('dry commute has a duration and arrives by work start',
    commute(dry).minutes > 0 && commute(dry).end <= at(28, '09:30'));
  const stateRain = planDay({ ...calm, weather: { rain: true, from: at(28, '06:00'), until: at(28, '12:00') } }, utc(28), world);
  eq('state.weather covering the departure is used', commute(stateRain).mode, 'cab');
  check('every place change goes through a commute block', WEEK.every(d => {
    const bs = plans[d].blocks;
    let place = HOME;
    for (const b of bs) {
      if (b.kind === 'commute') { if (b.from !== place) return false; place = b.to; } else if (b.placeId !== place) return false;
    }
    return place === HOME;
  }));
}

section('availability mapping');
eq('movie → dnd', availabilityFor({ kind: 'movie' }, world), 'dnd');
eq('family call → dnd', availabilityFor({ kind: 'family-call' }, world), 'dnd');
eq('gym → busy', availabilityFor({ kind: 'gym' }, world), 'busy');
eq('meeting → meeting', availabilityFor({ kind: 'meeting' }, world), 'meeting');
eq('sleep → asleep', availabilityFor({ kind: 'sleep' }, world), 'asleep');
eq('work at office → light', availabilityFor({ kind: 'work', placeId: OFFICE }, world), 'light');
eq('work at home → busy', availabilityFor({ kind: 'work', placeId: HOME }, world), 'busy');
eq('metro → light', availabilityFor({ kind: 'commute', mode: 'metro' }, world), 'light');
eq('meal alone → free', availabilityFor({ kind: 'dinner' }, world), 'free');
eq('meal with others → light', availabilityFor({ kind: 'lunch', withCast: ['cast:x'] }, world), 'light');
eq('unknown kind → free', availabilityFor({ kind: 'whatever' }, world), 'free');
eq('sick caps free → light', availabilityFor({ kind: 'tv' }, world, { sick: true }), 'light');
eq('sick keeps asleep', availabilityFor({ kind: 'sleep' }, world, { sick: true }), 'asleep');

section('lookups');
{
  const p = plans[28];
  eq('10:00 on an office day → work', blockAt(p, at(28, '10:00'))?.kind, 'work');
  eq('03:00 next night → sleep', blockAt(p, at(29, '03:00'))?.kind, 'sleep');
  eq('before wake → null', blockAt(p, p.wakeAt - 60), null);
  eq('block end is exclusive', blockAt(p, p.blocks[0].end)?.kind, p.blocks[1].kind);
  check('checkPlan catches a gap', checkPlan({ ...p, blocks: [p.blocks[0], ...p.blocks.slice(2)] }, world).length > 0);
  check('checkPlan catches an unknown place', checkPlan({ ...p, blocks: p.blocks.map((b, i) => (i === 1 ? { ...b, placeId: 'place:nowhere' } : b)) }, world).length > 0);
}

section('minimal, un-normalized world');
{
  const mini = {
    timezone: 'UTC',
    self: { homePlaceId: 'place:a', job: { officePlaceId: 'place:b' } },
    places: [{ id: 'place:a', kind: 'home', lat: 0, lon: 0 }, { id: 'place:b', kind: 'office', lat: 0.05, lon: 0 }],
    travel: { roadFactor: 1.3, speedsKmh: { walk: 4.5, cab: 20 }, overheadMin: { cab: 5 }, walkMaxKm: 1, defaultMode: 'cab' },
  };
  eq('defaults: office Tue–Thu', routineOf(mini).officeDays, [2, 3, 4]);
  for (const d of WEEK) {
    const p = planDay(calm, utc(d), mini);
    check(`${p.date} ${p.dayType}: plans and is sound`, checkPlan(p, mini).length === 0 && p.dayType === EXPECT[d], checkPlan(p, mini));
  }
  const noMeetings = planDay(calm, utc(27), mini);
  check('no typicalTimes → no meetings', !kinds(noMeetings).includes('meeting'));
  check('no leisure list → evenings are free time', !noMeetings.blocks.some(b => b.leisure));
  const unreachable = { ...mini, travel: { ...mini.travel, defaultMode: 'teleport' } };
  const p = planDay(calm, utc(27), unreachable);
  check('no route to the office → plans the day from home', p.blocks.every(b => b.placeId === 'place:a') && checkPlan(p, unreachable).length === 0, fmt(p));
  let threw = false;
  try { planDay(calm, utc(27), { ...mini, self: {}, places: [] }); } catch { threw = true; }
  check('a world without a home throws', threw);
}

section('real timezone');
{
  const ist = validateWorld(example, { now: NOW }); // the example's own timezone
  const p = planDay(calm, '2026-10-27', ist);
  const work = p.blocks.find(b => b.kind === 'work');
  eq('office work starts at local 09:30', hhmm(work.start, ist.timezone), '09:30');
  eq('plan date is the local date', p.date, '2026-10-27');
  eq('local plan is sound', checkPlan(p, ist), []);
}

setClock(null);
report();
