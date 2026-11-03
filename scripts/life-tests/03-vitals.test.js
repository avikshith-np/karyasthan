// T008 — vitals model (src/life/vitals.js): ranges over a simulated week,
// per-tick limits outside explained events, couplings, night settlement.
// Pure: no DB, no network, no RNG.

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, section, check, eq, near, report } from './_helpers.js';

const V = await import('../../src/life/vitals.js');
const { atLocal, dayStart, weekday, hhmm } = await import('../../src/life/clock.js');
const {
  VITAL_RANGES, PER_TICK_LIMITS, perTickLimits, MAX_RATE_PER_HOUR, ACTIVITY_CLASSES, activityClass,
  initialVitals, integrate, applyEvent, applyCouplings, inRange, getVital, energyCap, valenceTarget,
  nightDebtDelta, lateWakeMinutes, sickChance, workLateChance, crossings, vitalsConfig,
} = V;

const TZ = 'UTC';
const example = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/world.example.json'), 'utf-8'));
const world = { ...example, timezone: TZ };
const OFFICE = world.self.job.officePlaceId;
const HOME = world.self.homePlaceId;
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const names = Object.keys(VITAL_RANGES);
const deepFreeze = o => { Object.values(o).forEach(x => x && typeof x === 'object' && deepFreeze(x)); return Object.freeze(o); };

// A plausible hand-written week (routine.js is another task): office Tue–Thu,
// WFH Mon/Fri, weekends free. Returns the activity at local minute-of-day `m`.
function activityAt(t, { lateDay } = {}) {
  const wd = weekday(t, TZ);
  const m = (t - dayStart(t, TZ)) / 60;
  const weekend = wd === 0 || wd === 6;
  const office = wd >= 2 && wd <= 4;
  const late = lateDay && wd === lateDay;
  const wake = weekend ? 540 : 450;
  // The night after a late day: asleep until 00:30
  const prevLate = lateDay && wd === (lateDay + 1) % 7;
  if (m < (prevLate ? 30 : 0)) return { kind: 'work', placeId: HOME };
  if (m < wake) return { kind: 'sleep' };
  if (weekend) {
    if (m < 600) return { kind: 'breakfast' };
    if (m < 780) return { kind: 'tv' };
    if (m < 825) return { kind: 'lunch', withCast: ['cast:flatmate'] };
    if (m < 960) return { kind: 'walk' };
    if (m < 1140) return { kind: 'movie', social: true };
    if (m < 1230) return { kind: 'dinner' };
    if (m < 1410) return { kind: 'tv' };
    return { kind: 'sleep' };
  }
  if (m < 480) return { kind: 'rest' };
  if (m < 500) return { kind: 'breakfast' };
  if (office && m >= 540 && m < 570) return { kind: 'commute' };
  if (m < 570) return { kind: 'rest' };
  if ((m >= 630 && m < 675) || (m >= 900 && m < 945)) return { kind: 'meeting' };
  if (m >= 780 && m < 825) return { kind: 'lunch' };
  const workEnd = late ? 1410 : 1080;
  if (m < workEnd) return { kind: 'work', placeId: office ? OFFICE : HOME };
  if (late) return { kind: 'work', placeId: HOME };
  if (office && m < 1110) return { kind: 'commute' };
  if ((wd === 2 || wd === 4) && m >= 1140 && m < 1200) return { kind: 'gym' };
  if (m >= 1230 && m < 1275) return { kind: 'dinner' };
  if (m < 1410) return { kind: 'tv' };
  return { kind: 'sleep' };
}

const MEALS = new Set(['breakfast', 'lunch', 'dinner']);
const WORKISH = new Set(['work', 'meeting']);

/** Run a week of 15-min ticks; returns { states, violations, rangeFails, wakes }. */
function simulate({ start, days = 7, lateDay = null, vitals = initialVitals(world) }) {
  let v = vitals;
  let prevAct = activityAt(start - 900, { lateDay });
  const violations = [];
  const rangeFails = [];
  const wakes = [];
  const states = [];
  for (let t = start; t < start + days * 86400; t += 900) {
    const act = activityAt(t, { lateDay });
    // Discrete events at transitions (explained jumps)
    if (prevAct.kind === 'sleep' && act.kind !== 'sleep') {
      const before = v.sleepDebt;
      v = applyEvent(v, { type: 'woke', payload: {} }, world);
      wakes.push({ at: t, hhmm: hhmm(t, TZ), wd: weekday(t, TZ), before, after: v.sleepDebt });
    }
    if (MEALS.has(act.kind) && !MEALS.has(prevAct.kind)) v = applyEvent(v, { type: 'meal', payload: {} }, world);
    if (WORKISH.has(prevAct.kind) && !WORKISH.has(act.kind)) v = applyEvent(v, { type: 'activity.ended', payload: { kind: 'work' } }, world);
    if (lateDay && weekday(t, TZ) === lateDay && hhmm(t, TZ) === '18:00') v = applyEvent(v, { type: 'work.late', payload: {} }, world);
    // Continuous step — must stay inside the per-tick limits
    const next = integrate(v, act, 15, world, { at: t });
    for (const n of names) {
      const d = Math.abs(getVital(next, n) - getVital(v, n));
      if (d > PER_TICK_LIMITS[n] + 1e-9) violations.push({ n, d, at: hhmm(t, TZ), wd: weekday(t, TZ), kind: act.kind });
    }
    if (!inRange(next)) rangeFails.push({ at: t, next });
    v = next;
    states.push(v);
    prevAct = act;
  }
  return { states, violations, rangeFails, wakes, final: v };
}

section('declared ranges and limits');
{
  eq('ranges cover every R3 vital', names.sort(), ['arousal', 'energy', 'hunger', 'sleepDebt', 'socialBattery', 'stress', 'valence', 'workPressure']);
  eq('per-tick limit = max rate × 15/60', PER_TICK_LIMITS.energy, MAX_RATE_PER_HOUR.energy / 4);
  eq('perTickLimits(30) scales', perTickLimits(30).stress, MAX_RATE_PER_HOUR.stress / 2);
  const v0 = initialVitals(world);
  check('initial vitals in range', inRange(v0), v0);
  eq('initial flags', [v0.sick, v0.night], [false, { awakeMin: 0, sleptMin: 0 }]);
  eq('initial money from salary', v0.money, Math.round(world.money.salary * 0.5));
}

section('one simulated week (15-min ticks)');
const monday = U(2026, 10, 26); // a Monday
{
  const run = simulate({ start: monday });
  eq('every tick in range', run.rangeFails.length, 0);
  check('no continuous step exceeds its per-tick limit', run.violations.length === 0, run.violations.slice(0, 3));
  check('energy actually moves (not flat)', Math.max(...run.states.map(s => s.energy)) - Math.min(...run.states.map(s => s.energy)) > 30);
  check('hunger rises between meals', Math.max(...run.states.map(s => s.hunger)) > 40);
  check('social battery drains on working days and recovers', (() => {
    const sb = run.states.map(s => s.socialBattery);
    return Math.min(...sb) < 70 && Math.max(...sb) > 90;
  })(), [Math.min(...run.states.map(s => s.socialBattery)), Math.max(...run.states.map(s => s.socialBattery))]);
  eq('one wake per day', run.wakes.length, 7);
  check('normal nights keep sleep debt near zero', run.wakes.every(w => w.after < 1.5), run.wakes.map(w => w.after.toFixed(2)));
  check('money drains at the monthly baseline', Math.abs((initialVitals(world).money - run.final.money) - (world.money.monthlyBaseline / 30) * 7) < 1e-6);
}

section('consequence: late work → sleep debt → late wake');
{
  const normal = simulate({ start: monday });
  const late = simulate({ start: monday, lateDay: 3 }); // Wed: work till 23:30, asleep 00:30
  const thuNormal = normal.wakes.find(w => w.wd === 4);
  const thuLate = late.wakes.find(w => w.wd === 4);
  check('sleep debt after the late night is higher', thuLate.after > thuNormal.after + 0.5, { normal: thuNormal.after, late: thuLate.after });
  near('debt grew by about the hour of lost sleep', thuLate.after - thuNormal.after, 1, 0.1);
  check('lateWakeMinutes grows with the debt', lateWakeMinutes(thuLate.after) > lateWakeMinutes(thuNormal.after));
  const wedStress = s => s.states.slice(2 * 96 + 72, 2 * 96 + 73)[0].stress; // Wed 18:00 tick
  check('work.late bumps stress', wedStress(late) > wedStress(normal), [wedStress(normal), wedStress(late)]);
  eq('late week still in range', late.rangeFails.length, 0);
  check('late week continuous steps within limits', late.violations.length === 0, late.violations.slice(0, 3));
}

section('night settlement');
{
  near('16 h awake + 8 h sleep settles to 0', nightDebtDelta(480, 1440, 8), 0);
  near('7 h sleep in a 24 h cycle → +1', nightDebtDelta(420, 1440, 8), 1);
  near('10 h sleep → −2 (each extra hour repays one)', nightDebtDelta(600, 1440 + 120, 8), -1.333333, 1e-5);
  near('an all-nighter (40 h awake, 10 h sleep) charges the long cycle', nightDebtDelta(600, 3000, 8), 50 / 3 - 10, 1e-9);
  // woke uses the night counters, or payload overrides
  let v = integrate({ ...initialVitals(world), sleepDebt: 2 }, 'rest', 16 * 60, world, { hour: 7 });
  v = integrate(v, 'sleep', 6 * 60, world, { hour: 23 });
  eq('counters track awake and slept minutes', v.night, { awakeMin: 960, sleptMin: 360 });
  const w = applyEvent(v, { type: 'woke', payload: {} }, world);
  near('woke settles need × cycle/24 h − slept into the debt', w.sleepDebt, 2 + 8 * 1320 / 1440 - 6, 1e-9);
  eq('woke resets the counters', w.night, { awakeMin: 0, sleptMin: 0 });
  near('payload override wins', applyEvent(v, { type: 'woke', payload: { sleptMin: 480, cycleMin: 1440 } }, world).sleepDebt, 2);
  near('debt never below 0', applyEvent({ ...v, sleepDebt: 0 }, { type: 'woke', payload: { sleptMin: 720, cycleMin: 1440 } }, world).sleepDebt, 0);
  near('debt never above 20', applyEvent({ ...v, sleepDebt: 19 }, { type: 'woke', payload: { sleptMin: 0, cycleMin: 4320 } }, world).sleepDebt, 20);
  eq('lateWakeMinutes = min(90, 20 × debt)', [lateWakeMinutes(0), lateWakeMinutes(1.5), lateWakeMinutes(10), lateWakeMinutes(-3)], [0, 30, 90, 0]);
  near('sleep need comes from world.routine', vitalsConfig({ routine: { sleepNeedHours: 7 } }).sleepNeedHours, 7);
  near('world.vitals.sleepNeedHours overrides the routine', vitalsConfig({ routine: { sleepNeedHours: 7 }, vitals: { sleepNeedHours: 9 } }).sleepNeedHours, 9);
}

section('couplings');
{
  const base = { ...initialVitals(world), energy: 90 };
  eq('energyCap normal', energyCap(base), 100);
  eq('sleep debt > 6 caps energy at 60', energyCap({ ...base, sleepDebt: 6.5 }), 60);
  eq('sick caps energy at 50', energyCap({ ...base, sick: true }), 50);
  eq('woke into heavy debt clamps energy at the event', applyEvent({ ...base, sleepDebt: 6, night: { awakeMin: 1080, sleptMin: 240 } },
    { type: 'woke', payload: {} }, world).energy, 60);
  eq('sick.started clamps energy at the event', applyEvent(base, { type: 'sick.started' }, world).energy, 50);
  eq('sick.ended clears the flag', applyEvent({ ...base, sick: true }, { type: 'sick.ended' }, world).sick, false);
  // Without an event, an over-cap energy drains smoothly instead of jumping
  const over = integrate({ ...base, sleepDebt: 7 }, 'rest', 15, world, { hour: 12 });
  near('over-cap energy drains at the max rate', over.energy, 90 - PER_TICK_LIMITS.energy, 1e-9);
  const sleepingCapped = integrate({ ...base, energy: 55, sleepDebt: 7 }, 'sleep', 120, world, { hour: 2 });
  eq('sleep cannot push energy through the cap', sleepingCapped.energy, 60);
  const sickRest = integrate({ ...base, energy: 45, sick: true }, 'rest', 600, world, { hour: 10 });
  check('sick: rest never lifts energy past 50', sickRest.energy <= 50, sickRest.energy);

  const calm = integrate({ ...base, hunger: 50, stress: 40 }, 'wfh', 60, world, { hour: 11, weekday: 3 });
  const starving = integrate({ ...base, hunger: 85, stress: 40 }, 'wfh', 60, world, { hour: 11, weekday: 3 });
  near('hunger > 80 adds stress +2/h', starving.stress - calm.stress, 2, 1e-9);
  const lowWp = integrate({ ...base, workPressure: 50, stress: 40 }, 'office', 60, world, { hour: 11, weekday: 3 });
  const highWp = integrate({ ...base, workPressure: 65, stress: 40 }, 'office', 60, world, { hour: 11, weekday: 3 });
  near('work pressure > 60 adds stress +4/h at work', highWp.stress - lowWp.stress, 4, 1e-9);
  check('stress > 70 lowers the mood target', valenceTarget({ ...base, stress: 75 }, 'wfh') < valenceTarget({ ...base, stress: 69 }, 'wfh') - 0.2);
  check('hunger > 70, sick and rain commute lower the mood target', [
    valenceTarget({ ...base, hunger: 75 }, 'wfh') < valenceTarget(base, 'wfh'),
    valenceTarget({ ...base, sick: true }, 'wfh') < valenceTarget(base, 'wfh'),
    valenceTarget(base, 'commute', { rain: true }) < valenceTarget(base, 'commute'),
  ].every(Boolean));
  const moodSlide = integrate({ ...base, mood: { valence: 0.8, arousal: 0.5 }, stress: 90 }, 'office', 60, world, { hour: 11, weekday: 3 });
  check('valence moves ~10%/h toward its target, not instantly', moodSlide.mood.valence < 0.8 && moodSlide.mood.valence > 0.6, moodSlide.mood.valence);
  const night = integrate({ ...base, mood: { valence: 0.2, arousal: 0.8 } }, 'sleep', 120, world, { hour: 1 });
  check('arousal falls at night asleep', night.mood.arousal < 0.5, night.mood.arousal);
  const wkd = integrate({ ...base, stress: 50, workPressure: 50 }, 'rest', 60, world, { hour: 12, weekday: 6 });
  const wkdy = integrate({ ...base, stress: 50, workPressure: 50 }, 'rest', 60, world, { hour: 12, weekday: 3 });
  near('weekend: stress −2/h extra', wkdy.stress - wkd.stress, 2, 1e-9);
  // A weekend reverts 4%/h toward baseline − 15 (25), a weekday 1%/h toward 40: at 50 ≈ −0.97 vs −0.1.
  near('weekend: work pressure eases ~0.87/h faster', wkdy.workPressure - wkd.workPressure, 0.87, 0.03);
  const fri = integrate({ ...base, workPressure: 50 }, 'tv', 60, world, { hour: 18, weekday: 5 });
  near('Friday evening relieves work pressure (−2/h + reversion)', fri.workPressure, 47.9, 0.02);
  const mon = integrate({ ...base, workPressure: 50 }, 'work', 60, world, { hour: 9, weekday: 1 });
  near('Monday morning work adds pressure', mon.workPressure, 50 + 1.5 + 4 - 0.1, 0.03);
}

section('rebalance 2026-10-31: fatigue, sleep taper, stress floor, social battery, chat load');
{
  const base = { ...initialVitals(world), energy: 60, stress: 30, workPressure: 40, socialBattery: 50, sleepDebt: 0 };
  const fresh = integrate({ ...base, night: { awakeMin: 60, sleptMin: 0 } }, 'rest', 60, world, { hour: 10, weekday: 3 });
  const late = integrate({ ...base, night: { awakeMin: 15 * 60, sleptMin: 0 } }, 'rest', 60, world, { hour: 22, weekday: 3 });
  near('resting fresh: energy about flat (+1/h)', fresh.energy - 60, 1, 1e-6);
  near('awake > 14 h: fatigue −3/h on top', fresh.energy - late.energy, V.FATIGUE_RATE, 1e-6);
  const dip = integrate({ ...base, night: { awakeMin: 360, sleptMin: 0 } }, 'wfh', 60, world, { hour: 14, weekday: 3 });
  const morning = integrate({ ...base, night: { awakeMin: 120, sleptMin: 0 } }, 'wfh', 60, world, { hour: 10, weekday: 3 });
  near('post-lunch dip drains −2/h more', morning.energy - dip.energy, V.DIP_RATE, 1e-6);
  const low = integrate({ ...base, energy: 30 }, 'sleep', 60, world, { hour: 2 });
  const high = integrate({ ...base, energy: 80 }, 'sleep', 60, world, { hour: 2 });
  check('sleep refills fast while low, slowly past the taper', low.energy - 30 > 8 && high.energy - 80 <= V.SLEEP_TAPER_RATE + 1e-9, [low.energy, high.energy]);
  let night = { ...base, energy: 35 };
  night = integrate(night, 'sleep', 8 * 60, world, { hour: 23 });
  check('a full night from 35 wakes him at ~85–92, not 100', night.energy > 84 && night.energy < 93, night.energy);
  const rested = integrate({ ...base, stress: 22 }, 'rest', 240, world, { hour: 19, weekday: 3 });
  near('rest drains stress only to the floor (8 + 0.3 × work pressure)', rested.stress, 8 + 0.3 * 40, 0.01);
  const below = integrate({ ...base, stress: 5 }, 'rest', 60, world, { hour: 19, weekday: 3 });
  check('below the floor stress creeps back up', below.stress > 5, below.stress);
  for (const cls of ['awake', 'wfh', 'meal', 'commute']) {
    const x = integrate(base, cls, 60, world, { hour: 11, weekday: 3 });
    check(`social battery does not refill during ${cls} (≤ +0.5/h)`, x.socialBattery - 50 <= 0.5 + 1e-9, x.socialBattery);
  }
  const alone = integrate(base, 'rest', 60, world, { hour: 19, weekday: 3 });
  check('it refills alone at rest', alone.socialBattery > 52, alone.socialBattery);
  const hi = integrate({ ...base, workPressure: 90 }, 'rest', 24 * 60, world, { hour: 0, weekday: 3 });
  check('work pressure reverts toward its baseline, slowly', hi.workPressure < 90 && hi.workPressure > 60, hi.workPressure);
  const wkEnd = integrate({ ...base, workPressure: 45 }, 'rest', 48 * 60, world, { hour: 9, weekday: 6, weekend: true });
  check('a weekend eases work pressure toward its weekend baseline, never to 0', wkEnd.workPressure > 25 && wkEnd.workPressure < 32, wkEnd.workPressure);
  eq('energyCap is gradual with sleep debt (3 h → 92)', energyCap({ ...base, sleepDebt: 3 }), 92);
  const load = applyEvent(base, { type: 'chat.load', payload: { sent: 10, received: 20 } }, world);
  near('chat.load: battery −(0.5 × sent + 0.1 × received)', load.socialBattery, 50 - 7, 1e-9);
  check('chat.load lifts arousal and, with battery to spare, valence', load.mood.arousal > base.mood.arousal && load.mood.valence > base.mood.valence);
  const big = applyEvent(base, { type: 'chat.load', payload: { sent: 200, received: 900 } }, world);
  near('chat.load drain is capped per window', big.socialBattery, 50 - V.CHAT_LOAD_SOCIAL_MAX, 1e-9);
  const drained = applyEvent({ ...base, socialBattery: 15 }, { type: 'chat.load', payload: { sent: 5, received: 10 } }, world);
  check('drained, a busy chat grates (valence down)', drained.mood.valence < base.mood.valence, drained.mood.valence);
  eq('chat.load with junk counts moves nothing', applyEvent(base, { type: 'chat.load', payload: { sent: 'x', received: -4 } }, world).socialBattery, 50);
}

section('discrete events');
{
  const base = { ...initialVitals(world), hunger: 75, stress: 40, workPressure: 50, money: 1000 };
  eq('meal resets hunger to 10', applyEvent(base, { type: 'meal' }, world).hunger, 10);
  eq('meal with explicit hunger', applyEvent(base, { type: 'meal', payload: { hunger: 25 } }, world).hunger, 25);
  check('good meal lifts mood more', applyEvent(base, { type: 'meal', payload: { good: true } }, world).mood.valence
    > applyEvent(base, { type: 'meal' }, world).mood.valence);
  eq('work.late: stress +8', applyEvent(base, { type: 'work.late' }, world).stress, 48);
  eq('decision.reversed: stress +5', applyEvent(base, { type: 'decision.reversed' }, world).stress, 45);
  eq('work.crunch: pressure +20', applyEvent(base, { type: 'work.crunch' }, world).workPressure, 70);
  eq('finishing a work block: pressure −1', applyEvent(base, { type: 'activity.ended', payload: { kind: 'work' } }, world).workPressure, 49);
  eq('ending tv leaves pressure alone', applyEvent(base, { type: 'activity.ended', payload: { kind: 'tv' } }, world).workPressure, 50);
  eq('salary in', applyEvent(base, { type: 'money.salary', payload: { amount: 500 } }, world).money, 1500);
  eq('money spent', applyEvent(base, { type: 'money.spent', payload: { amount: 120 } }, world).money, 880);
  eq('bad amounts ignored', applyEvent(base, { type: 'money.spent', payload: { amount: 'lots' } }, world).money, 1000);
  eq('reply drains social battery 0.5', applyEvent(base, { type: 'reply.sent' }, world).socialBattery, base.socialBattery - 0.5);
  eq('unknown event: unchanged', applyEvent(base, { type: 'nope' }, world), applyCouplings(base));
  eq('event jumps stay in range', applyEvent({ ...base, stress: 98 }, { type: 'work.late' }, world).stress, 100);
}

section('probabilities and thresholds');
{
  const v = initialVitals(world);
  near('sickChance baseline', sickChance(v), 0.01);
  near('sickChance with debt and stress', sickChance({ ...v, sleepDebt: 7, stress: 75 }), 0.04);
  eq('workLateChance 0 at ≤ 70', workLateChance({ ...v, workPressure: 70 }), 0);
  check('workLateChance > 0 above 70', workLateChance({ ...v, workPressure: 80 }) > 0.2);
  check('workLateChance capped', workLateChance({ ...v, workPressure: 100 }) <= 0.6);
  eq('crossings up/down', crossings({ ...v, hunger: 79, energy: 21 }, { ...v, hunger: 81, energy: 19 }).map(c => `${c.vital}:${c.dir}`), ['hunger:up', 'energy:down']);
  eq('crossing down', crossings({ ...v, stress: 72 }, { ...v, stress: 69 }).map(c => `${c.vital}:${c.dir}`), ['stress:down']);
  eq('no crossing inside a band', crossings(v, v), []);
}

section('activity vocabulary');
{
  eq('classes', ACTIVITY_CLASSES.sort(), ['awake', 'commute', 'gym', 'leisure', 'meal', 'meeting', 'office', 'rest', 'sleep', 'social', 'wfh']);
  eq('work at the office place → office', activityClass({ kind: 'work', placeId: OFFICE }, world), 'office');
  eq('work at home → wfh', activityClass({ kind: 'work', placeId: HOME }, world), 'wfh');
  eq('string kinds', ['sleep', 'tv', 'cafe', 'movie', 'lunch', 'commute', 'gym', 'meeting'].map(k => activityClass(k, world)),
    ['sleep', 'rest', 'leisure', 'social', 'meal', 'commute', 'gym', 'meeting']);
  eq('unknown kind → awake (no throw)', [activityClass('juggling', world), activityClass(null, world), activityClass({}, world)], ['awake', 'awake', 'awake']);
  const alone = integrate(initialVitals(world), { kind: 'lunch' }, 60, world, { hour: 13 });
  const together = integrate(initialVitals(world), { kind: 'lunch', withCast: ['cast:x'] }, 60, world, { hour: 13 });
  near('company drains the social battery', alone.socialBattery - together.socialBattery, 6, 1e-9);
}

section('purity, step invariance, overrides');
{
  const v0 = deepFreeze({ ...initialVitals(world), mood: { valence: 0.1, arousal: 0.4 }, night: { awakeMin: 30, sleptMin: 0 } });
  const t = U(2026, 10, 28, 9);
  let threw = false;
  try { integrate(v0, 'office', 60, world, { at: t }); applyEvent(v0, { type: 'meal' }, world); } catch { threw = true; }
  check('inputs are not mutated (frozen input works)', !threw);
  const one = integrate(v0, { kind: 'work', placeId: OFFICE }, 60, world, { at: t });
  let four = v0;
  for (let i = 0; i < 4; i++) four = integrate(four, { kind: 'work', placeId: OFFICE }, 15, world, { at: t + i * 900 });
  eq('one 60-min call == four 15-min calls', one, four);
  eq('deterministic', integrate(v0, 'gym', 45, world, { at: t }), integrate(v0, 'gym', 45, world, { at: t }));
  eq('dt ≤ 0 is a no-op', integrate(v0, 'gym', 0, world), V.normalizeVitals(v0));

  const junk = integrate({ energy: NaN, stress: 'high', mood: null, hunger: 500 }, 'rest', 15, world, { hour: 12 });
  check('garbage input normalized into range', inRange(junk), junk);

  const fast = { ...world, vitals: { rates: { rest: { energy: 9 }, gym: { energy: -9999 } } } };
  const cfg = vitalsConfig(fast);
  eq('world rate override applied', cfg.rates.rest.energy, 9);
  eq('absurd override clamped to the max rate', cfg.rates.gym.energy, -MAX_RATE_PER_HOUR.energy);
  eq('non-overridden rates keep defaults', cfg.rates.sleep.energy, 9);
  const g = integrate({ ...initialVitals(fast), energy: 80 }, 'gym', 15, fast, { hour: 18 });
  check('even an overridden rate respects the per-tick limit', 80 - g.energy <= PER_TICK_LIMITS.energy + 1e-9, g.energy);
  check('vitalsConfig cached per world object', vitalsConfig(fast) === cfg);
  check('vitalsConfig works without a world', vitalsConfig(undefined).rates.sleep.energy === 9);
  eq('baselineSpend: false disables the drain', integrate({ ...initialVitals(world), money: 100 }, 'rest', 600, { ...world, vitals: { baselineSpend: false } }, { hour: 9 }).money, 100);
  const init = initialVitals({ ...world, vitals: { initial: { energy: 40, valence: -0.5, stress: 500 } } });
  eq('initial overrides (clamped)', [init.energy, init.mood.valence, init.stress], [40, -0.5, 100]);
}

section('urge (read-time, not a folded vital)');
{
  const day = U(2026, 10, 28, 12);
  const night = U(2026, 10, 28, 23);
  const base = { tz: 'UTC', stress: 20, socialBattery: 80, romanceAppetite: 0.5, asleep: false };
  const noon = V.urgeValue({ ...base, now: day });
  const late = V.urgeValue({ ...base, now: night });
  check('night sits above the afternoon', late > noon, [noon, late]);
  const released = V.urgeValue({ ...base, now: night, lastReleaseAt: night - 600 });
  check('a release drops it', released < late && released <= 30, released);
  eq('asleep rests near the morning baseline', V.urgeValue({ ...base, now: night, asleep: true }), 25);
  eq('the same inputs twice (a relationship stage is not an input)', V.urgeValue({ ...base, now: night }), late);
  const stressed = V.urgeValue({ ...base, now: night, stress: 90, socialBattery: 10 });
  check('stress and a flat battery lower it', stressed < late, [stressed, late]);
  const seen = V.urgeValue({ ...base, now: day, sawInterest: true });
  check('seeing someone he wants adds a step', seen > noon, [seen, noon]);
  eq('urge is not on the vitals object', initialVitals(world).urge, undefined);
  eq('integrate does not grow an urge key', integrate(initialVitals(world), 'rest', 60, world, { at: day }).urge, undefined);
}

report();
