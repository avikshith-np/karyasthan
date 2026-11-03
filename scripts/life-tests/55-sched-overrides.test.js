// 014 sched — the planner honours schedule overrides (plan §A5.1–A5.3, A5.6,
// review R22/R24/R32): with no override every day plans exactly as the 1472b91
// routine.js did (golden, loaded from git); dayType off / wfh / office (incl. an
// office day on a weekend); an off day plans like a weekend day with the
// weekend wake; a sleep-in moves the wake (routineAwake agrees); a partial day
// off from 14:00 at the office → a trip home, free time, the routine evening and
// sleep at the routine time; ranges for every activity (home, out → the place's
// kind, eat-out covering dinner, gym, errand, work at the office / home); a
// meal the range covers moves; routine leisure in the way is dropped; remove /
// move; an early night; an unfit override is left out with a code; every
// skipped code survives the projector's KIND_RE; no crunch on a day off; the
// evening invitation times an off day like a weekend and never lands in a
// range; career never places an interview on a day off; the fold (normalize,
// prune, clear clips). Pure (no DB except the fold through the projector).
import { setupScratchDb, fakeClock, section, check, eq, report, PROJECT_ROOT } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { setClock, zonedToUnix, hhmm, minuteOfDay } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { planDay, checkPlan, dayType, wakeTime, routineOf } from '../../src/life/routine.js';
import { isAwakeAt } from '../../src/life/availability.js';
import { initialVitals } from '../../src/life/vitals.js';
import { eveningProposal } from '../../src/life/pulse.js';
import { createInitialState, project } from '../../src/life/projector.js';
import { appendEvent, SCHEDULE_EVENT_TYPES, OWNER_ONLY_TYPES, CHAT_FORBIDDEN_TYPES } from '../../src/life/eventLog.js';
import {
  normalize, overridesFor, activeRanges, fitAnchors, tripFn, wholeDayOf, outingKind, blockCause, conflictsOf,
} from '../../src/life/planEdits.js';

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

setRngSeed(7);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const L = (mo, d, h, m = 0) => zonedToUnix(2026, mo, d, h, m, tz);
const HOME = world.self.homePlaceId;
const OFFICE = world.self.job.officePlaceId;
const KIND_RE = /^[a-z][a-z0-9_:-]{0,31}$/;      // projector.KIND_RE
const vitals = { ...initialVitals(world), energy: 80, socialBattery: 70, workPressure: 30, money: 40000 };
const dry = { weather: () => ({ rain: false }) };
const TUE = '2026-10-27';                       // office day
const SAT = '2026-10-31';
const ov = (id, date, o) => ({ [id]: { id, date, status: 'active', op: 'set', conflicts: [], ...o } });
const st = (overrides) => ({ vitals, scheduleOverrides: overrides });
const show = (p) => p.blocks.map(b => `${hhmm(b.start, tz)} ${b.kind}@${b.placeId ?? `${b.from}>${b.to}`}`);

// The 1472b91 routine.js, its imports pointed at the current modules.
const BASE_DIR = path.join(PROJECT_ROOT, 'data', `life-test-55-baseline-${process.pid}`);
process.on('exit', () => { try { fs.rmSync(BASE_DIR, { recursive: true, force: true }); } catch { /* gone */ } });
async function loadOldRoutine() {
  let src;
  try {
    src = execFileSync('git', ['-C', PROJECT_ROOT, 'show', '1472b91:src/life/routine.js'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const lifeDir = path.join(PROJECT_ROOT, 'src', 'life');
  const out = src.replace(/from '(\.{1,2}\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(path.resolve(lifeDir, rel)).href}'`);
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const file = path.join(BASE_DIR, 'routine-1472b91.js');
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

section('golden: no override → the 1472b91 routine, two weeks, byte for byte');
{
  const OLD = await loadOldRoutine();
  if (!OLD) console.log('  (skip: git cannot show 1472b91:src/life/routine.js here)');
  else {
    let same = 0;
    for (let d = 0; d < 14; d++) {
      const day = L(10, 19, 7) + d * 86400;
      for (const s of [{ vitals }, { vitals, scheduleOverrides: {} }, { vitals: { ...vitals, sick: true } }]) {
        if (JSON.stringify(planDay(s, day, world)) === JSON.stringify(OLD.planDay(s, day, world))) same++;
      }
    }
    eq('42 plans identical', same, 42);
    eq('wakeTime identical', JSON.stringify(wakeTime({ vitals }, L(10, 27, 7), world)), JSON.stringify(OLD.wakeTime({ vitals }, L(10, 27, 7), world)));
    check('no `overrides` key without an override', !('overrides' in planDay({ vitals }, L(10, 27, 7), world)));
  }
}

section('dayType with a whole-day background');
{
  const off = Object.values(ov(5, TUE, { background: { activity: 'off', from: L(10, 27, 0), to: L(10, 27, 23), wholeDay: true } }));
  const wfh = Object.values(ov(6, TUE, { background: { activity: 'work_home', from: L(10, 27, 0), to: L(10, 27, 23), wholeDay: true } }));
  const office = Object.values(ov(7, SAT, { background: { activity: 'work_office', from: L(10, 31, 0), to: L(10, 31, 23), wholeDay: true } }));
  eq('Tue: office (routine) / off / wfh', [dayType(L(10, 27, 7), world, {}), dayType(L(10, 27, 7), world, {}, { overrides: off }), dayType(L(10, 27, 7), world, {}, { overrides: wfh })], ['office', 'off', 'wfh']);
  eq('Sat: weekend (routine) / office ("go in on Saturday")', [dayType(L(10, 31, 7), world, {}), dayType(L(10, 31, 7), world, {}, { overrides: office })], ['weekend', 'office']);
  eq('sick wins', dayType(L(10, 27, 7), world, { sick: true }, { overrides: off }), 'sick');
  eq('wholeDayOf: the newest whole-day background', wholeDayOf([...off, ...wfh]), 'work_home');
  const noOffice = { ...world, self: { ...world.self, job: { ...world.self.job, officePlaceId: HOME } } };
  eq('work_office with no office → wfh', dayType(L(10, 31, 7), noOffice, {}, { overrides: office }), 'wfh');
}

section('an off day plans like a weekend day (R22 / §A5.6)');
{
  const s = st(ov(5, TUE, { background: { activity: 'off', from: L(10, 27, 0), to: L(10, 27, 23, 30), wholeDay: true } }));
  const p = planDay(s, L(10, 27, 7), world, dry);
  eq('dayType off, overrides listed, sound', [p.dayType, p.overrides, checkPlan(p, world)], ['off', [5], []]);
  check('no work, meeting or office commute', !p.blocks.some(b => b.kind === 'work' || b.kind === 'meeting' || b.placeId === OFFICE || b.to === OFFICE));
  const r = routineOf(world);
  check('the weekend wake (± the jitter)', Math.abs(minuteOfDay(p.wakeAt, tz) - r.weekendWake) <= 10, hhmm(p.wakeAt, tz));
  eq('wakeTime agrees', wakeTime(s, L(10, 27, 7), world).at, p.wakeAt);
  check('lunch at home and an afternoon leisure roll', p.blocks.some(b => b.kind === 'lunch' && b.placeId === HOME) && p.blocks.some(b => b.leisure && b.start < L(10, 27, 18)));
}

section('a sleep-in moves the wake; routineAwake agrees (R32)');
{
  const s = st(ov(5, TUE, { ranges: [{ activity: 'sleep', from: L(10, 27, 0), to: L(10, 27, 10, 30) }] }));
  const w = wakeTime(s, L(10, 27, 7), world);
  eq('wake at 10:30, overridden, no jitter', [w.at, w.overridden, w.jitter], [L(10, 27, 10, 30), true, 0]);
  const p = planDay(s, L(10, 27, 7), world, dry);
  eq('the plan starts at 10:30 and is sound', [p.wakeAt, checkPlan(p, world)], [L(10, 27, 10, 30), []]);
  check('asleep at 09:00 with no plan block (routine fallback)', !isAwakeAt(s, L(10, 27, 9), world));
  check('…but awake at 09:00 without the override', isAwakeAt({ vitals }, L(10, 27, 9), world));
  check('awake at 11:00', isAwakeAt(s, L(10, 27, 11), world));
}

section('rest of the day off from 14:00 at the office (R22)');
{
  const base = planDay({ vitals }, L(10, 27, 7), world, dry);
  const s = st(ov(5, TUE, { background: { activity: 'off', from: L(10, 27, 14), to: base.sleepAt } }));
  const p = planDay(s, L(10, 27, 7), world, dry);
  eq('sound, still an office day', [checkPlan(p, world), p.dayType], [[], 'office']);
  const after = p.blocks.filter(b => b.start >= L(10, 27, 14));
  eq('first: the trip home from the office at 14:00', [after[0].kind, after[0].from, after[0].to, after[0].start], ['commute', OFFICE, HOME, L(10, 27, 14)]);
  check('then free time at home (the override\'s)', after[1].kind === 'free' && after[1].placeId === HOME && after[1].fromOverride === true);
  check('no work, meeting or office trip after 14:00', !after.some(b => ['work', 'meeting'].includes(b.kind) || b.to === OFFICE || (b.from === OFFICE && b !== after[0])));
  const evening = (pl) => pl.blocks.filter(b => b.start >= L(10, 27, 18, 45)).map(b => `${b.kind}@${b.placeId}|${b.start}`);
  eq('the routine evening and sleep stay', [evening(p), p.sleepAt], [evening(base), base.sleepAt]);
  check('skipped meetings are coded and pass KIND_RE (R24)', p.skipped.length > 0 && p.skipped.every(c => KIND_RE.test(c)), p.skipped);
  check('nothing before 14:00 changed', p.blocks.filter(b => b.end <= L(10, 27, 14) && b.start < L(10, 27, 13, 45)).every(b => base.blocks.some(x => JSON.stringify(x) === JSON.stringify(b))));
}

section('ranges: every activity');
{
  const base = planDay({ vitals }, L(10, 27, 7), world, dry);
  const one = (r) => planDay(st(ov(5, TUE, { ranges: [r] })), L(10, 27, 7), world, dry);
  const at = (p, kind) => p.blocks.find(b => b.kind === kind && b.fromOverride);
  const cafe = one({ activity: 'out', placeId: 'place:cafe', from: L(10, 27, 19), to: L(10, 27, 20, 30) });
  eq('out at a cafe → cafe, sound', [at(cafe, 'cafe')?.placeId, checkPlan(cafe, world)], ['place:cafe', []]);
  check('…leisure in the way dropped and coded', cafe.skipped.some(c => /^override:(walk|gym|cafe|tv|movie|groceries|eat-out):\d{4}$/.test(c)) || !base.blocks.some(b => b.leisure && b.start < L(10, 27, 20, 30) && b.end > L(10, 27, 19)), cafe.skipped);
  const dinner = one({ activity: 'out', placeId: 'place:restaurant', from: L(10, 27, 20), to: L(10, 27, 21, 30) });
  const eo = at(dinner, 'eat-out');
  eq('a restaurant at dinner → eat-out covering dinner, no second dinner', [!!eo, eo?.meal, dinner.blocks.filter(b => b.kind === 'dinner').length], [true, 'dinner', 0]);
  const gym = one({ activity: 'gym', from: L(10, 27, 19), to: L(10, 27, 20) });
  eq('gym → the routine gym place', at(gym, 'gym')?.placeId, 'place:gym');
  const errand = one({ activity: 'errand', from: L(10, 27, 19), to: L(10, 27, 19, 45) });
  eq('errand → the nearest shop', at(errand, 'errand')?.placeId, 'place:grocery');
  const home = one({ activity: 'home', from: L(10, 27, 18), to: L(10, 27, 23) });
  const trip = home.blocks.find(b => b.kind === 'commute' && b.from === OFFICE);
  check('home from 18:00 → he leaves the office in time to be home at 18:00', trip && trip.end === L(10, 27, 18) && trip.to === HOME, trip && hhmm(trip.end, tz));
  check('…no leisure out after 18:00', !home.blocks.some(b => b.start >= L(10, 27, 18) && b.kind !== 'sleep' && b.placeId && b.placeId !== HOME));
  check('…dinner kept at home', home.blocks.some(b => b.kind === 'dinner' && b.placeId === HOME));
  const wh = one({ activity: 'work_home', from: L(10, 27, 14), to: L(10, 27, 18) });
  check('work_home 14–18 → work at home in the afternoon', wh.blocks.some(b => b.kind === 'work' && b.placeId === HOME && b.fromOverride) && checkPlan(wh, world).length === 0, show(wh));
  const satWork = planDay(st(ov(6, SAT, { ranges: [{ activity: 'work_office', from: L(10, 31, 10), to: L(10, 31, 13) }] })), L(10, 31, 9), world, dry);
  check('work_office on a Saturday morning → work at the office, sound', satWork.blocks.some(b => b.kind === 'work' && b.placeId === OFFICE) && checkPlan(satWork, world).length === 0, show(satWork));
  for (const [name, p] of Object.entries({ cafe, dinner, gym, errand, home, wh })) {
    check(`${name}: every block has an availability and the plan is sound`, p.blocks.every(b => typeof b.availability === 'string') && checkPlan(p, world).length === 0, checkPlan(p, world));
  }
  const lunch = one({ activity: 'home', from: L(10, 27, 12, 45), to: L(10, 27, 14, 30) });
  check('a range over lunch at the office: lunch at home in it is not doubled', lunch.blocks.filter(b => b.kind === 'lunch').length <= 1 && checkPlan(lunch, world).length === 0);
}

section('early night, remove, move, unfit');
{
  const base = planDay({ vitals }, L(10, 27, 7), world, dry);
  const early = planDay(st(ov(5, TUE, { ranges: [{ activity: 'sleep', from: L(10, 27, 21, 30), to: base.sleepAt }] })), L(10, 27, 7), world, dry);
  eq('early night: sleep at 21:30, at home, sound', [early.sleepAt, early.blocks.at(-1).placeId, checkPlan(early, world)], [L(10, 27, 21, 30), HOME, []]);
  const leisure = base.blocks.find(b => b.leisure);
  if (leisure) {
    const rm = planDay(st({ 5: { id: 5, date: TUE, status: 'active', op: 'remove', blockKind: leisure.kind, conflicts: [] } }), L(10, 27, 7), world, dry);
    eq(`remove ${leisure.kind}: gone, its trips too, sound`, [rm.blocks.some(b => b.kind === leisure.kind), rm.blocks.some(b => b.to === leisure.placeId), checkPlan(rm, world)], [false, false, []]);
    const mv = planDay(st({ 5: { id: 5, date: TUE, status: 'active', op: 'move', blockKind: leisure.kind, moveTo: L(10, 27, 21, 15), conflicts: [] } }), L(10, 27, 7), world, dry);
    const moved = mv.blocks.find(b => b.kind === leisure.kind);
    eq(`move ${leisure.kind} to 21:15: same minutes and place`, [moved?.start, moved && moved.end - moved.start, moved?.placeId], [L(10, 27, 21, 15), leisure.end - leisure.start, leisure.placeId]);
  }
  const bad = planDay(st(ov(5, TUE, { ranges: [{ activity: 'out', placeId: 'place:nowhere', from: L(10, 27, 19), to: L(10, 27, 20) }] })), L(10, 27, 7), world, dry);
  eq('an unknown place → the plan without it + override:unfit:5, never a crash', [bad.skipped.includes('override:unfit:5'), checkPlan(bad, world), bad.overrides], [true, [], [5]]);
}

section('fitAnchors: an override never moves a block before the floor');
{
  const base = planDay({ vitals }, L(10, 27, 7), world, dry);
  const floor = L(10, 27, 16);
  const o = Object.values(ov(5, TUE, { ranges: [{ activity: 'home', from: L(10, 27, 15), to: L(10, 27, 19) }] }));
  const fit = fitAnchors(base.blocks, o, { world, tz, floor, trip: tripFn({ vitals }, world), startPlace: HOME });
  check('blocks before 16:00 are untouched', base.blocks.filter(b => b.end <= floor).every(b => fit.blocks.some(x => JSON.stringify(x) === JSON.stringify(b))));
  eq('applied', fit.applied, [5]);
}

section('outingKind / blockCause');
{
  eq('cafe, cinema, park, restaurant off-meal', [outingKind(world, 'place:cafe', L(10, 27, 16), L(10, 27, 17), tz), outingKind(world, 'place:cinema', L(10, 27, 16), L(10, 27, 18), tz),
    outingKind(world, 'place:park', L(10, 27, 16), L(10, 27, 17), tz), outingKind(world, 'place:restaurant', L(10, 27, 16), L(10, 27, 17), tz)], ['cafe', 'movie', 'walk', 'outing']);
  const plan = { eventId: 50, basePlanEventId: 40 };
  eq('blockCause: own cause → amendment / override → routine', [blockCause(plan, { causeEventId: 30 }), blockCause(plan, { fromAmendment: true }), blockCause(plan, { fromOverride: true }), blockCause(plan, {})], [30, 50, 50, 40]);
}

section('no crunch on a day off; the evening invitation (§A5.6, R21)');
{
  const off = st(ov(5, TUE, { background: { activity: 'off', from: L(10, 27, 0), to: L(10, 27, 23), wholeDay: true } }));
  // eveningProposal: an off day times like a weekend (16:00–20:00), never inside a range.
  let weekendLike = 0;
  let total = 0;
  let inRange = 0;
  for (let d = 19; d <= 30; d++) {
    const date = `2026-10-${d}`;
    const sOff = { ...st(ov(5, date, { background: { activity: 'off', from: L(10, d, 0), to: L(10, d, 23), wholeDay: true } })), self: { homePlaceId: HOME }, places: new Map(world.places.map(p => [p.id, p])), cast: new Map() };
    const p = planDay(sOff, L(10, d, 7), world, dry);
    const pr = eveningProposal(p, sOff, world);
    if (pr) { total++; const m = minuteOfDay(pr.spec.subject.eventAt, tz); if (m >= 16 * 60 && m <= 20 * 60) weekendLike++; }
    const sIn = { ...sOff, scheduleOverrides: { ...sOff.scheduleOverrides, 6: { id: 6, date, status: 'active', op: 'set', conflicts: [], ranges: [{ activity: 'home', from: L(10, d, 15), to: L(10, d, 23) }] } } };
    if (eveningProposal(p, sIn, world)) inRange++;
  }
  check('off-day invitations land 16:00–20:00', total === 0 || weekendLike === total, { total, weekendLike });
  eq('none inside a "home" range', inRange, 0);
  void off;
}

section('activeRanges / conflictsOf');
{
  const s = { scheduleOverrides: ov(5, TUE, { background: { activity: 'off', from: L(10, 27, 14), to: L(10, 27, 23) }, ranges: [{ activity: 'out', placeId: 'place:cafe', from: L(10, 27, 16), to: L(10, 27, 18) }] }) };
  eq('busy ranges: the range, not the day-off background', activeRanges(s).map(r => [r.from, r.to, r.activity]), [[L(10, 27, 16), L(10, 27, 18), 'out']]);
  const d = { id: 77, status: 'committed', kind: 'movie', subject: { eventAt: L(10, 27, 17), placeId: 'place:cinema', minutes: 30 }, options: [{ id: 'go', label: 'Go to the movie' }] };
  const story = { id: 78, status: 'open', kind: 'career:interview', category: 'career', subject: { eventAt: L(10, 27, 17), minutes: 30 }, options: [] };
  const state = { decisions: new Map([[77, d]]), scheduleOverrides: s.scheduleOverrides };
  const o = s.scheduleOverrides[5];
  const r1 = conflictsOf(state, o, { now: L(10, 27, 13), tz });
  eq('a decision in the range: cancel by default', r1.rows.map(r => [r.type, r.id, r.resolution, r.outcome]), [['decision', 77, 'cancel', 'cancelled']]);
  const r2 = conflictsOf(state, o, { now: L(10, 27, 13), tz, resolutions: { 'decision:77': 'keep' } });
  // sched-fixes: a kept plan inside a range splits it (was refused conflict_split); its window ends at its minutes (30).
  eq('keep → the range split around it (it sits inside the range)', [r2.refusal, r2.clipped.ranges.map(r => [r.from, r.to])],
    [null, [[L(10, 27, 16), L(10, 27, 17)], [L(10, 27, 17, 30), L(10, 27, 18)]]]);
  const locked = { ...d, committed: { optionId: 'go', by: 'owner' } };
  const r5 = conflictsOf({ decisions: new Map([[77, locked]]) }, o, { now: L(10, 27, 13), tz });
  eq('a locked outing (owner go): keep by default, trimmed', r5.rows.map(r => [r.resolution, r.outcome, r.locked, r.trimmed]), [['keep', 'kept', true, true]]);
  const late = { ...d, subject: { eventAt: L(10, 27, 15) }, options: [{ id: 'go', label: 'Go' }, { id: 'late', label: 'Join later', expiresAt: L(10, 27, 16) }] };
  eq('an outing ending where a range starts (its late option\'s expiry) is no conflict (half-open)',
    conflictsOf({ decisions: new Map([[77, late]]) }, o, { now: L(10, 27, 13), tz }).rows, []);
  const r3 = conflictsOf({ decisions: new Map([[78, story]]) }, o, { now: L(10, 27, 13), tz });
  eq('a story decision: keep only → conflict_story', [r3.rows[0]?.choices, r3.refusal], [['keep'], 'conflict_story']);
  const edge = { ...o, ranges: [{ activity: 'out', placeId: 'place:cafe', from: L(10, 27, 16), to: L(10, 27, 17, 30) }] };
  const r4 = conflictsOf({ decisions: new Map([[77, { ...d, subject: { ...d.subject, eventAt: L(10, 27, 17) } }]]) }, edge, { now: L(10, 27, 13), tz, resolutions: { 'decision:77': 'keep' } });
  eq('keep at an edge → the range is clipped to end before it', [r4.refusal, r4.clipped.ranges?.[0]?.to], [null, L(10, 27, 17)]);
}

section('the fold: normalize, owner-only, prune, clear clips (R24)');
{
  await setupScratchDb();
  setClock(fakeClock(L(10, 27, 8)).fn);
  eq('two schedule types, owner-only and chat-forbidden', [[...SCHEDULE_EVENT_TYPES].sort(), [...SCHEDULE_EVENT_TYPES].every(t => OWNER_ONLY_TYPES.has(t) && CHAT_FORBIDDEN_TYPES.has(t))],
    [['schedule.override_cleared', 'schedule.override_set'], true]);
  let refused = false;
  try { appendEvent({ type: 'schedule.override_set', actor: 'engine', payload: { op: 'set', date: TUE } }); } catch (e) { refused = /only the owner/.test(e.message); }
  check('engine refused', refused);
  eq('normalize refuses junk', [normalize(null), normalize({ date: 'x' }), normalize({ op: 'set', date: TUE })], [null, null, null]);
  const n = normalize({ op: 'set', date: TUE, ranges: [{ activity: 'home', from: L(10, 27, 20), to: L(10, 27, 21), extra: 1 }, { activity: 'out', placeId: 'place:cafe', from: L(10, 27, 18), to: L(10, 27, 19) }], junk: 1 });
  eq('normalize sorts ranges and drops unknown keys', [n.ranges.map(r => r.activity), 'junk' in n, 'extra' in n.ranges[1]], [['out', 'home'], false, false]);
  let s = createInitialState(world);
  const ev = (id, at, type, payload) => ({ id, at, type, actor: 'owner', causeId: null, payload, originKind: 'owner', originJid: 'owner', redacted: false });
  s = project(s, ev(1, L(10, 27, 8), 'schedule.override_set', { op: 'set', date: TUE, ranges: [{ activity: 'home', from: L(10, 27, 18), to: L(10, 27, 22) }], conflicts: [] }), world);
  eq('folded active', [s.scheduleOverrides[1].status, s.scheduleOverrides[1].setAt], ['active', L(10, 27, 8)]);
  s = project(s, ev(2, L(10, 27, 19), 'schedule.override_cleared', { overrideId: 1, from: L(10, 27, 19) }), world);
  eq('cleared at 19:00 → the range clipped to end then', [s.scheduleOverrides[1].status, s.scheduleOverrides[1].ranges[0].to, s.scheduleOverrides[1].clearedEventId], ['cleared', L(10, 27, 19), 2]);
  eq('overridesFor lists active only', overridesFor(s, TUE).length, 0);
  s = project(s, ev(3, L(10, 31, 8), 'schedule.override_set', { op: 'set', date: SAT, ranges: [{ activity: 'home', from: L(10, 31, 18), to: L(10, 31, 22) }], conflicts: [] }), world);
  eq('an override dated > 2 days before a later fold is pruned', Object.keys(s.scheduleOverrides), ['3']);
  const plain = createInitialState(world);
  check('no schedule event → no scheduleOverrides key', !('scheduleOverrides' in plain));
}

eq('no network', fetches, 0);
report();
