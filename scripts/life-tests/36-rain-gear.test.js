// 011 Phase 2 — rain gear (src/life/commute.js, plan §P2.2, review R23/R24/R25/
// R28/R30): dry days plan exactly as before 011 (the 3b7fd6f routine.js, loaded
// from git); the rainMode table; the umbrella roll is per date on its own stream
// and from the forecast at his usual departures; the plan carries `gear` and its
// commutes `gear`/`exposed` through the fold and through FREE EVENING / an outing
// amendment; a window set after the morning plan soaks him at departure
// (commute.soaked caused by its travel.started; lateMin moves the arrival, the
// commute's end and its availability); the vitals hit is bounded; a soak on a
// DM-origin trip keeps that DM's origin and stays out of a group's inner-state
// line; rainMode reads base vitals; a rainy month in the dry run walks under an
// umbrella and is deterministic. Scratch DB, fake clock, no network.
import { setupScratchDb, fakeClock, section, check, eq, report, PROJECT_ROOT } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { setClock, zonedToUnix, dateKey } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent, eventsAfter } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild, project } from '../../src/life/projector.js';
import { createPulse, genesis, amendPlanForOuting } from '../../src/life/pulse.js';
import { planDay } from '../../src/life/routine.js';
import { initialVitals, applyEvent as applyVitals } from '../../src/life/vitals.js';
import { innerStateLine } from '../../src/life/innerState.js';
import { freeEveningPlan } from '../../src/life/story/director.js';
import { rainMode, umbrellaFor, forecastChance, soakedAt, isExposed } from '../../src/life/commute.js';

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

setRngSeed(7);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (mo, d, h, m = 0) => zonedToUnix(2026, mo, d, h, m, tz);
const H = 3600;
const SALARY = world.money.salary;

// The pre-011 routine.js (3b7fd6f), its imports pointed at the current modules.
const BASE_DIR = path.join(PROJECT_ROOT, 'data', `life-test-36-baseline-${process.pid}`);
process.on('exit', () => { try { fs.rmSync(BASE_DIR, { recursive: true, force: true }); } catch { /* gone */ } });
async function loadOldRoutine() {
  let src;
  try {
    src = execFileSync('git', ['-C', PROJECT_ROOT, 'show', '3b7fd6f:src/life/routine.js'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const lifeDir = path.join(PROJECT_ROOT, 'src', 'life');
  const out = src.replace(/from '(\.{1,2}\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(path.resolve(lifeDir, rel)).href}'`);
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const file = path.join(BASE_DIR, 'routine-3b7fd6f.js');
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}
const strip = (plan) => JSON.parse(JSON.stringify(plan, (k, v) => (k === 'gear' || k === 'exposed' ? undefined : v)));

section('dry days plan exactly as before 011');
{
  const OLD = await loadOldRoutine();
  if (!OLD) console.log('  (skip: git cannot show 3b7fd6f:src/life/routine.js here)');
  else {
    const calm = { vitals: { ...initialVitals(world), energy: 80, socialBattery: 70, workPressure: 30, money: 40000 } };
    const dry = { weather: () => ({ rain: false }) };
    let same = 0;
    for (let d = 26; d <= 31; d++) {
      const day = local(10, d, 7, 30);
      if (JSON.stringify(strip(planDay(calm, day, world, dry))) === JSON.stringify(OLD.planDay(calm, day, world, dry))) same++;
    }
    eq('a dry week: the same blocks (gear fields aside)', same, 6);
    const p = planDay(calm, local(10, 27, 7, 30), world, dry);
    check('…plus plan.gear {umbrella, p}', typeof p.gear?.umbrella === 'boolean' && p.gear.p >= 0.1 && p.gear.p <= 0.95, p.gear);
    check('…and every commute carries gear + exposed', p.blocks.filter(b => b.kind === 'commute').every(b => typeof b.gear === 'boolean' && typeof b.exposed === 'boolean'));
    check('dry trips carry the day\'s umbrella as gear (R24)', p.blocks.filter(b => b.kind === 'commute').every(b => b.gear === p.gear.umbrella));
    const calmRain = { vitals: { ...calm.vitals } };
    const rainy = { weather: () => ({ rain: true, intensity: 'light', condition: 'light_rain' }) };
    const office = (pl) => pl.blocks.find(b => b.kind === 'commute' && b.to === world.self.job?.officePlaceId);
    eq('10-routine\'s case: rain + money in hand → a cab to the 5.5 km office (unchanged)', office(planDay(calmRain, local(10, 27, 7, 30), world, rainy))?.mode, 'cab');
  }
}

section('rainMode table');
{
  const light = { rain: true, intensity: 'light', condition: 'light_rain' };
  const hard = { rain: true, intensity: 'heavy', condition: 'heavy_rain' };
  const ok = { money: SALARY, salary: SALARY, valence: 0.1, energy: 70 };
  const tight = { ...ok, money: SALARY * 0.05 };
  const m = (km, w, ctx) => { const r = rainMode(km, w, world, ctx); return `${r.mode}${r.gear ? '+gear' : ''}${r.exposed ? ' exposed' : ''}`; };
  eq('walkable + umbrella → walk with gear', m(0.6, light, { ...ok, umbrella: true }), 'walk+gear exposed');
  eq('walkable, no umbrella, money ok → cab', m(0.6, light, ok), 'cab');
  eq('walkable, no umbrella, tight → walk exposed', m(0.6, light, tight), 'walk exposed');
  eq('walkable, tight, umbrella, pouring → walk with gear', m(0.6, hard, { ...tight, umbrella: true }), 'walk+gear exposed');
  eq('hard rain + umbrella + money ok → cab', m(0.6, hard, { ...ok, umbrella: true }), 'cab+gear');
  eq('long + ok → cab', m(5.5, light, ok), 'cab');
  eq('long + tight → the default mode (a scooter: exposed)', m(5.5, light, tight), `${world.travel.defaultMode} exposed`);
  eq('long + tight + umbrella → the default mode with gear', m(5.5, light, { ...tight, umbrella: true }), `${world.travel.defaultMode}+gear exposed`);
  eq('long + tight + lazy (low mood) → cab', m(5.5, light, { ...tight, valence: -0.5 }), 'cab');
  eq('long + tight + lazy (tired) → cab', m(5.5, light, { ...tight, energy: 10 }), 'cab');
  eq('a storm counts as hard', m(0.6, { rain: true, condition: 'storm', intensity: 'heavy' }, { ...ok, umbrella: true }), 'cab+gear');
  eq('a quick RAIN ("rain") counts as light', m(0.6, { rain: true, condition: 'rain' }, { ...ok, umbrella: true }), 'walk+gear exposed');
  eq('no salary → never tight', m(0.6, light, { money: 1, salary: null }), 'cab');
  eq('dry → chooseMode (walk / scooter)', [m(0.6, null, ok), m(5.5, { rain: false }, ok)], ['walk exposed', `${world.travel.defaultMode} exposed`]);
  check('isExposed: cab / metro are not', !isExposed('cab') && !isExposed('metro') && isExposed('walk') && isExposed('scooter'));
}

section('the umbrella roll');
{
  const deps = [local(7, 6, 8, 45), local(7, 6, 18), local(7, 6, 19)];
  const a = umbrellaFor(null, deps, '2026-07-06', world);
  const b = umbrellaFor(null, deps, '2026-07-06', world);
  eq('deterministic per date', a, b);
  const keys = ['wake', 'meetings', 'work.late', 'leisure:evening', 'leisure:afternoon', 'weather:day', 'weather:block:5', 'decision:evening'];
  const draw = () => keys.map(k => rngFor('2026-07-06', k)());
  const before = draw();
  for (let i = 0; i < 5; i++) umbrellaFor(null, deps, '2026-07-06', world);
  planDay({ vitals: initialVitals(world) }, local(7, 6, 7, 30), world);
  eq('every other stream draws the same values', draw(), before);
  const wet = umbrellaFor({ weatherWindows: [{ id: 1, from: local(7, 6, 6), to: local(7, 6, 22), sky: 'storm', intensity: 1 }] }, deps, '2026-07-06', world);
  eq('a storm window in the forecast → p 0.87 (0.1 + 0.85 × 0.9, rounded)', wet.p, 0.87);
  const dryWin = umbrellaFor({ weatherWindows: [{ id: 1, from: local(7, 6, 6), to: local(7, 6, 22), sky: 'clear', intensity: 1 }] }, deps, '2026-07-06', world);
  check('a clear window → a low p', dryWin.p <= 0.15, dryWin);
  check('forecastChance is a probability', [0, 3, 6, 9, 12, 15, 18, 21].every(h => { const c = forecastChance(null, local(7, 6, h), world); return c >= 0 && c <= 1; }));
}

section('the fold: gear survives; a soak moves the arrival (R25)');
{
  let s = createInitialState(world);
  let id = 0;
  const fold = (type, at, payload, extra = {}) => { s = project(s, { id: ++id, at, type, actor: 'engine', payload, originKind: 'self', originJid: 'self', causeId: null, ...extra }, world); return id; };
  fold('genesis', local(7, 6, 6), {});
  const blocks = [{ kind: 'free', placeId: 'place:home', start: local(7, 6, 7), end: local(7, 6, 8, 40), availability: 'free' },
    { kind: 'commute', placeId: null, start: local(7, 6, 8, 40), end: local(7, 6, 9), from: 'place:home', to: 'place:office', mode: 'scooter', km: 5.5, minutes: 20, cost: 15, gear: false, exposed: true, availability: 'busy' }];
  fold('plan.made', local(7, 6, 7), { date: '2026-07-06', wakeAt: local(7, 6, 7), sleepAt: local(7, 6, 23), nextWakeAt: local(7, 7, 7), blocks, gear: { umbrella: false, p: 0.4 } });
  eq('plan.gear folded', s.plan.gear, { umbrella: false, p: 0.4 });
  eq('commute gear/exposed folded', [s.plan.blocks[1].gear, s.plan.blocks[1].exposed], [false, true]);
  const tr = fold('travel.started', local(7, 6, 8, 40), { from: 'place:home', to: 'place:office', mode: 'scooter', minutes: 20, availability: 'busy' });
  fold('commute.soaked', local(7, 6, 8, 40), { mode: 'scooter', intensity: 'heavy', changeClothes: true, lateMin: 15 }, { causeId: tr });
  eq('arrival +15 min', s.position.travel.endAt, local(7, 6, 9, 15));
  eq('the commute activity ends then too', s.activity.endAt, local(7, 6, 9, 15));
  eq('…and its availability', s.availability.until, local(7, 6, 9, 15));
  check('soakedAt set', s.soakedAt?.eventId === id && s.soakedAt.intensity === 'heavy');
  fold('commute.soaked', local(7, 6, 8, 41), { lateMin: 99 }, { causeId: tr });
  eq('lateMin capped at 20', s.position.travel.endAt, local(7, 6, 9, 35));
  fold('sleep.started', local(7, 6, 23), { until: local(7, 7, 7) });
  check('cleared by the next sleep', !('soakedAt' in s));
  const v0 = initialVitals(world);
  const v1 = applyVitals(v0, { type: 'commute.soaked', payload: { intensity: 'heavy' } }, world);
  const v2 = applyVitals(v0, { type: 'commute.soaked', payload: { intensity: 'light' } }, world);
  check('vitals: bounded comfort hit', v1.mood.valence < v2.mood.valence && v2.mood.valence < v0.mood.valence
    && v1.mood.valence >= v0.mood.valence - 0.13 && v1.stress <= v0.stress + 4.01 && v1.energy >= v0.energy - 3.01, { v0: v0.mood, v1: v1.mood });

  // FREE EVENING / an outing amendment carry plan.gear.
  const work = [{ kind: 'work', placeId: 'place:office', start: local(7, 6, 9), end: local(7, 6, 18), availability: 'light' },
    { kind: 'free', placeId: 'place:office', start: local(7, 6, 18), end: local(7, 6, 23), availability: 'free' }];
  const st = { ...s, activity: { kind: 'work', startAt: local(7, 6, 9) }, plan: { ...s.plan, blocks: work, eventId: 2 } };
  eq('FREE EVENING keeps the day\'s gear', freeEveningPlan(st, local(7, 6, 12)).gear, { umbrella: false, p: 0.4 });
  const home = { ...st, plan: { ...st.plan, blocks: [{ kind: 'free', placeId: 'place:home', start: local(7, 6, 7), end: local(7, 6, 23), availability: 'free' }] },
    position: { placeId: 'place:home' }, self: { ...st.self, homePlaceId: 'place:home' } };
  const d = { id: 77, kind: 'outing', subject: { eventAt: local(7, 6, 19), placeId: 'place:cafe', castIds: [] }, ponrAt: local(7, 6, 18, 30),
    options: [{ id: 'go' }, { id: 'late', expiresAt: local(7, 6, 21) }, { id: 'stay' }], committed: { optionId: 'go' } };
  const am = amendPlanForOuting(home, d, local(7, 6, 18, 30), world);
  eq('an outing amendment keeps the morning\'s gear', am?.gear, { umbrella: false, p: 0.4 });
  check('…and its commutes carry gear/exposed', am.blocks.filter(b => b.kind === 'commute').every(b => typeof b.gear === 'boolean' && typeof b.exposed === 'boolean'));
}

section('rainMode reads base vitals, not the chat overlay (R23)');
{
  // planDay reads state.vitals (the base); a view's overlay lives on vitalsBase/vitals of a VIEW only.
  const tired = { vitals: { ...initialVitals(world), energy: 10, money: SALARY * 0.01 }, weather: null };
  const p = planDay(tired, local(7, 7, 7, 30), world, { weather: () => ({ rain: true, intensity: 'light' }) });
  const c = p.blocks.find(b => b.kind === 'commute' && b.km > 1.2);
  eq('tight + tired (base vitals) → cab', c?.mode, 'cab');
  const overlayed = { ...tired, vitals: { ...tired.vitals, energy: 90 }, vitalsBase: tired.vitals };
  const p2 = planDay(overlayed, local(7, 7, 7, 30), world, { weather: () => ({ rain: true, intensity: 'light' }) });
  eq('planDay reads state.vitals as given (the projection, never a chat-mood view)', p2.blocks.find(b => b.kind === 'commute' && b.km > 1.2)?.mode, world.travel.defaultMode);
}

// ── The pulse: a window set after the morning plan soaks him ───────────────

async function sim({ startDay = 27, until = null, window = null, hook = null } = {}) {
  await setupScratchDb();
  const clock = fakeClock(local(10, startDay, 5));
  setClock(clock.fn);
  let live = createInitialState(world);
  const append = (spec) => { const ev = appendEvent(spec); live = applyAppended(live, ev, { world }); return ev; };
  genesis(append, world, local(10, startDay, 5), { vitals: { money: SALARY * 0.02 } });   // money tight: he rides
  const pulse = createPulse({ world, getState: () => live, append, now: clock.fn, tickMinutes: 15 });
  let win = null;
  const end = until ?? local(10, startDay, 22);
  while (clock.now() < end) {
    clock.advance({ minutes: 15 });
    await pulse.tick();
    if (window && !win && live.plan?.date === dateKey(clock.now(), tz) && live.plan.blocks?.length) {
      const act = append({ type: 'director.action', at: clock.now(), actor: 'owner', payload: { kind: 'weather', previewAt: clock.now(), count: 1 } });
      win = append({ type: 'weather.window_set', at: clock.now(), actor: 'owner', causeId: act.id, payload: window(live) });
    }
    if (hook) await hook(live, append, clock);
  }
  return { live: () => live, events: eventsAfter(0, 50000), win };
}

section('a storm window after the morning plan: soaked at departure');
{
  // Tue 27 Oct: an office day; with money tight the 5.5 km commute is the scooter (exposed).
  const S = await sim({ window: (s) => {
    const c = s.plan.blocks.find(b => b.kind === 'commute');
    return { from: c.start - 30 * 60, to: c.end + H, sky: 'storm', intensity: 1 };
  } });
  const evs = S.events;
  const plan = evs.find(e => e.type === 'plan.made');
  const c0 = plan.payload.blocks.find(b => b.kind === 'commute');
  check('the morning plan rode the scooter (dry forecast, money tight)', c0.mode === world.travel.defaultMode && c0.exposed === true, c0);
  const soaked = evs.filter(e => e.type === 'commute.soaked');
  const umbrella = plan.payload.gear?.umbrella === true;
  if (umbrella) {
    check('he had packed an umbrella: no soak', soaked.length === 0);
  } else {
    check('a commute.soaked at departure', soaked.length >= 1, evs.filter(e => e.type === 'travel.started').map(e => e.at));
    const tr = evs.find(e => e.id === soaked[0].causeId);
    eq('caused by its travel.started, same time', [tr?.type, tr?.at], ['travel.started', soaked[0].at]);
    eq('origin self (his own trip)', soaked[0].originKind, 'self');
    const arr = evs.find(e => e.type === 'travel.arrived' && e.causeId === tr.id);
    eq('arrival = start + minutes + lateMin', arr.at, tr.at + (tr.payload.minutes + soaked[0].payload.lateMin) * 60);
    check('lateMin 0 or 10–20, changeClothes ⇔ lateMin > 0', [0].includes(soaked[0].payload.lateMin) !== (soaked[0].payload.lateMin >= 10 && soaked[0].payload.lateMin <= 20)
      && (soaked[0].payload.changeClothes === true) === (soaked[0].payload.lateMin > 0), soaked[0].payload);
    eq('heavy (a storm)', soaked[0].payload.intensity, 'heavy');
  }
  const rerun = await sim({ window: (s) => {
    const c = s.plan.blocks.find(b => b.kind === 'commute');
    return { from: c.start - 30 * 60, to: c.end + H, sky: 'storm', intensity: 1 };
  } });
  eq('the same run twice: the same log', rerun.events.map(e => [e.type, e.at, e.payload.lateMin ?? null]), evs.map(e => [e.type, e.at, e.payload.lateMin ?? null]));
}

section('soakedAt: gear, cab, dry, home');
{
  const at = local(7, 6, 18);
  const st = { weatherWindows: [{ id: 3, from: at - H, to: at + H, sky: 'rain', intensity: 0.3 }], self: { homePlaceId: 'place:home' }, world: { timezone: tz } };
  const blk = { kind: 'commute', start: at, end: at + 600, to: 'place:home', mode: 'walk', exposed: true, gear: false };
  const r = soakedAt(st, blk, at, world);
  eq('walking home in rain, no umbrella: soaked, no change of clothes at home', [r?.intensity, r?.changeClothes, r?.lateMin], ['light', false, 0]);
  eq('with an umbrella: dry', soakedAt(st, { ...blk, gear: true }, at, world), null);
  eq('in a cab: dry', soakedAt(st, { ...blk, mode: 'cab', exposed: false }, at, world), null);
  eq('no rain at departure or arrival: dry', soakedAt({ ...st, weatherWindows: [{ ...st.weatherWindows[0], sky: 'clear' }] }, blk, at, world), null);
  const rArr = soakedAt({ ...st, weatherWindows: [{ id: 3, from: at + 300, to: at + H, sky: 'rain', intensity: 0.3 }] }, blk, at, world);
  check('rain starting before the planned arrival soaks him too', rArr?.intensity === 'light');
}

section('a soak on a DM-origin trip keeps that DM (S11)');
{
  await setupScratchDb();
  const DM = '15550003333@s.whatsapp.net';
  const G = '120363000000880001@g.us';
  const at = local(10, 28, 18);
  let s = createInitialState(world);
  const append = (spec) => { const ev = appendEvent(spec); s = applyAppended(s, ev, { world }); return ev; };
  genesis(append, world, at - H);
  const ptr = append({ type: 'claim.flagged', at, actor: 'chat', originKind: 'dm', originJid: DM, payload: { claimId: 1 } });
  const tr = append({ type: 'travel.started', at, actor: 'engine', causeId: ptr.id, payload: { from: 'place:home', to: 'place:cafe', mode: 'walk', minutes: 8 } });
  const soak = append({ type: 'commute.soaked', at, actor: 'engine', causeId: tr.id, payload: { mode: 'walk', intensity: 'light', changeClothes: false, lateMin: 0 } });
  eq('the soak inherits the DM origin', [soak.originKind, soak.originJid], ['dm', DM]);
  eq('soakedAt keeps the trip that caused it', s.soakedAt?.travelEventId, tr.id);
  // On that same trip the line already says he is getting wet; "earlier" waits for the arrival.
  const during = innerStateLine(s, at + 4 * 60, { kind: 'dm', chatJid: DM, members: [DM] });
  check('during the soaked trip: no "caught in the rain earlier"', !/caught in the rain earlier/.test(during), during);
  const later = at + 40 * 60;
  const dm = innerStateLine(s, later, { kind: 'dm', chatJid: DM, members: [DM] });
  const grp = innerStateLine(s, later, { kind: 'group', chatJid: G, members: ['15550004444@s.whatsapp.net'] });
  check('in that DM: "got caught in the rain earlier"', /caught in the rain earlier/.test(dm), dm);
  check('in a group: not a word of it', !/caught in the rain/.test(grp), grp);
  const after = innerStateLine(s, at + 3 * H, { kind: 'dm', chatJid: DM, members: [DM] });
  check('gone after 2 h', !/caught in the rain/.test(after), after);
  void rebuild;
}

section('the dry run: a rainy month walks under an umbrella, deterministically');
{
  const run = () => execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts/life-dryrun.js'), '--days', '31', '--start', '2026-06-01'],
    { cwd: PROJECT_ROOT, encoding: 'utf-8', env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' } });
  const a = run();
  const b = run();
  check('June 2026 twice: identical output', a === b);
  check('…umbrella days in the plan lines', /umbrella packed/.test(a));
  check('…a walkable trip walked in the rain (the gym at 18:00 on a rainy evening)', /→ Gym by walk/.test(a));
}

check('no network', fetches === 0, fetches);
report();
