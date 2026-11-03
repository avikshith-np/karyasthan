// T018 — availability (src/life/availability.js): which availability is in
// force (projection → plan → default; sleep until woke; sick caps free; on the
// phone), every cell of the §R9 gate matrix with a seeded RNG (each outcome
// reachable, frequencies match, same message → same outcome), the catch-up /
// active-flow / not-gated precedence in every state, the group-question and
// low-social-battery shifts, delay hints and score factors, matrix overrides,
// the phone-check cadence (gaps, meeting/dnd ends, wake, read-only night
// checks), isAwakeAt and freeWindows over a planned day. Pure: no DB writes,
// no network, no LLM.
import { setupScratchDb, fakeClock, section, check, eq, near, report } from './_helpers.js';
import { setClock, atLocal, dayStart, addDays, weekday, minuteOfDay } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState } from '../../src/life/projector.js';
import { planDay, blockAt } from '../../src/life/routine.js';
import {
  AVAILABILITY_STATES, OUTCOMES, GATE_MATRIX, SCORE_FACTOR, SNEAK_SCORE_FACTOR, DELAY_HINTS, CHECK_GAP_MIN,
  CHECK_DURATION_SEC, LOW_SOCIAL_BATTERY, availabilityAt, gateMessage, gateProbabilities, cellWeights,
  scoreFactorFor, nextCheckAt, checkDurationSec, nightChecks, isAwakeAt, freeWindows,
} from '../../src/life/availability.js';

await setupScratchDb();
setRngSeed(20261028);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const base = createInitialState(world);
const TZ = base.world.timezone;

// Wed 28 Oct 2026 (an office day in the example routine), local times.
const WED = atLocal(Date.UTC(2026, 9, 28, 6, 0) / 1000, '12:00', TZ);
const D0 = dayStart(WED, TZ);
const clock = fakeClock(WED);
setClock(clock.fn);
const MIN = 60;
const H = 3600;
const GROUP = '120363000000000001@g.us';
const DM = '15550000001@s.whatsapp.net';

/** A projection-shaped state with the given availability (plain object; the module only reads). */
function stateWith(avail, { at = WED, until = at + H, kind = 'work', onPhone = false, sick = false, battery = 70, plan = null } = {}) {
  const s = structuredClone(base);
  s.genesisAt = at - 86400;
  s.at = at;
  s.activity = { kind: avail === 'asleep' ? 'sleep' : kind, placeId: 'place:office', startAt: at - 30 * MIN, endAt: until, availability: avail, withCast: [], social: false, eventId: 5 };
  s.availability = { state: avail, since: at - 30 * MIN, until, onPhone, eventId: 5 };
  if (onPhone) s.phone = { ...s.phone, checkStartedAt: at - MIN };
  s.vitals = { ...s.vitals, sick, socialBattery: battery };
  if (sick) s.sick = { since: at - 86400, until: null };
  s.plan = plan;
  return s;
}

const COLUMNS = {
  dm: { isDm: true, isGroup: false, isMention: false },
  mention: { isDm: false, isGroup: true, isMention: true },
  chatter: { isDm: false, isGroup: true, isMention: false },
};
const ctxFor = (column, extra = {}) => ({ ...COLUMNS[column], ...extra });
const chatOf = (column) => (column === 'dm' ? DM : GROUP);
const msgN = (column, i) => ({ id: `MSG${String(i).padStart(6, '0')}`, groupJid: chatOf(column) });
const fixed = (x) => { const r = () => x; r.int = (lo, hi) => lo + Math.floor(x * (hi - lo + 1)); return r; };

try {
  section('states and matrix shape');
  eq('six states, freest first', AVAILABILITY_STATES, ['free', 'light', 'busy', 'meeting', 'dnd', 'asleep']);
  check('every state has all three columns', AVAILABILITY_STATES.every(s => ['dm', 'mention', 'chatter'].every(c => GATE_MATRIX[s]?.[c])));
  check('matrix only uses known outcomes', AVAILABILITY_STATES.every(s => Object.values(GATE_MATRIX[s]).every(cell => Object.keys(cell).every(o => OUTCOMES.includes(o)))));

  section('availability in force');
  const meeting = stateWith('meeting');
  eq('projection while until is ahead', [availabilityAt(meeting, WED).state, availabilityAt(meeting, WED).source], ['meeting', 'projection']);
  const plan = planDay(base, D0, world);
  const late = stateWith('meeting', { until: WED - MIN, plan });
  const blk = blockAt(plan, WED);
  eq('until passed, no tick yet → the plan block', [availabilityAt(late, WED).state, availabilityAt(late, WED).source], [blk.availability, 'plan']);
  const lateNoPlan = stateWith('busy', { until: WED - MIN });
  eq('until passed, no plan → free (default)', [availabilityAt(lateNoPlan, WED).state, availabilityAt(lateNoPlan, WED).source], ['free', 'default']);
  const overslept = stateWith('asleep', { until: WED - 2 * H, kind: 'sleep' });
  eq('asleep past the nominal end until a woke', availabilityAt(overslept, WED).state, 'asleep');
  eq('sick caps free at light', availabilityAt(stateWith('free', { sick: true }), WED).state, 'light');
  eq('sick leaves busier states alone', availabilityAt(stateWith('meeting', { sick: true }), WED).state, 'meeting');
  check('in a phone check → onPhone', availabilityAt(stateWith('busy', { onPhone: true }), WED).onPhone === true);
  check('asleep is never onPhone (night checks are read only)', availabilityAt(stateWith('asleep', { onPhone: true }), WED).onPhone === false);
  eq('no state → free', availabilityAt(null, WED).state, 'free');

  section('every cell of the matrix (seeded, frequencies)');
  const N = 3000;
  for (const s of AVAILABILITY_STATES) {
    const st = stateWith(s);
    for (const column of ['dm', 'mention', 'chatter']) {
      const want = gateProbabilities(s, column);
      const counts = Object.fromEntries(OUTCOMES.map(o => [o, 0]));
      for (let i = 0; i < N; i++) counts[gateMessage(st, msgN(column, i), ctxFor(column), { at: WED }).outcome]++;
      const cell = GATE_MATRIX[s][column];
      const total = Object.values(cell).reduce((a, b) => a + b, 0);
      const ok = OUTCOMES.every(o => Math.abs(counts[o] / N - (cell[o] ?? 0) / total) <= 0.03);
      check(`${s} × ${column}: ${Object.entries(cell).map(([o, p]) => `${o} ${p}`).join(' / ')}`, ok,
        Object.fromEntries(OUTCOMES.map(o => [o, (counts[o] / N).toFixed(3)])));
      check(`${s} × ${column}: probabilities = the cell`, OUTCOMES.every(o => Math.abs((want[o] ?? 0) - (cell[o] ?? 0) / total) < 1e-9));
      // every outcome in the cell is reachable with a fixed roll
      let acc = 0;
      const reach = Object.keys(cell).filter(o => OUTCOMES.includes(o)).sort((a, b) => OUTCOMES.indexOf(a) - OUTCOMES.indexOf(b)).every((o) => {
        const mid = acc + (cell[o] / total) / 2;
        acc += cell[o] / total;
        return gateMessage(st, msgN(column, 1), ctxFor(column), { at: WED, rng: fixed(mid) }).outcome === o;
      });
      check(`${s} × ${column}: each outcome reachable`, reach);
    }
  }

  section('determinism');
  const light = stateWith('light');
  const g1 = gateMessage(light, msgN('dm', 42), ctxFor('dm'), { at: WED });
  const g2 = gateMessage(light, msgN('dm', 42), ctxFor('dm'), { at: WED + 600 });
  eq('same message → same outcome and delay', [g1.outcome, g1.delayHintMs], [g2.outcome, g2.delayHintMs]);
  const outcomesA = Array.from({ length: 50 }, (_, i) => gateMessage(light, msgN('mention', i), ctxFor('mention'), { at: WED }).outcome);
  setRngSeed(1);
  const outcomesB = Array.from({ length: 50 }, (_, i) => gateMessage(light, msgN('mention', i), ctxFor('mention'), { at: WED }).outcome);
  setRngSeed(20261028);
  const outcomesC = Array.from({ length: 50 }, (_, i) => gateMessage(light, msgN('mention', i), ctxFor('mention'), { at: WED }).outcome);
  eq('replays identically under the same seed', outcomesC, outcomesA);
  check('a different install seed gives different rolls', JSON.stringify(outcomesA) !== JSON.stringify(outcomesB));
  const frozen = Object.freeze(stateWith('busy'));
  const before = JSON.stringify(frozen);
  gateMessage(frozen, msgN('dm', 1), ctxFor('dm'), { at: WED });
  eq('the gate never mutates its state', JSON.stringify(frozen), before);

  section('precedence: catch-up, active flow, not gated');
  for (const s of AVAILABILITY_STATES) {
    const st = stateWith(s);
    for (const column of ['dm', 'mention', 'chatter']) {
      const c = gateMessage(st, msgN(column, 7), ctxFor(column, { catchUp: { awayMin: 30 } }), { at: WED });
      const f = gateMessage(st, msgN(column, 7), ctxFor(column, { hasActiveFlow: true }), { at: WED });
      check(`${s} × ${column}: catch-up → now, active flow → now`,
        c.outcome === 'now' && c.reason === 'catch_up' && c.scoreFactor === 1 && c.delayHintMs === 0
        && f.outcome === 'now' && f.reason === 'active_flow' && f.scoreFactor === 1);
    }
  }
  const ng = gateMessage(stateWith('asleep'), { id: 'X1' }, { isDm: false, isGroup: false }, { at: WED });
  eq('neither group nor DM → not gated', [ng.outcome, ng.reason], ['now', 'not_gated']);
  const onPhoneBusy = stateWith('meeting', { onPhone: true });
  const op = Array.from({ length: 30 }, (_, i) => gateMessage(onPhoneBusy, msgN('dm', i), ctxFor('dm'), { at: WED }));
  check('in a phone check → the free row (a DM is now)', op.every(g => g.outcome === 'now' && g.reason.startsWith('on_phone')));
  const opAsleep = stateWith('asleep', { onPhone: true });
  check('night check: a DM still defers', Array.from({ length: 30 }, (_, i) => gateMessage(opAsleep, msgN('dm', i), ctxFor('dm'), { at: WED }).outcome).every(o => o === 'defer'));
  eq('state reported with the result', [gateMessage(meeting, msgN('dm', 3), ctxFor('dm')).state, gateMessage(meeting, msgN('dm', 3), ctxFor('dm')).until], ['meeting', WED + H]);

  section('group question and social battery');
  const q = gateProbabilities('meeting', 'chatter', { isQuestion: true });
  near('meeting chatter question: a third of ignore → defer', q.defer, 1 / 3, 1e-9);
  eq('free chatter question unchanged (decide() as today)', gateProbabilities('free', 'chatter', { isQuestion: true }), { now: 1 });
  eq('a DM question is the DM cell', gateProbabilities('busy', 'dm', { isQuestion: true }), gateProbabilities('busy', 'dm'));
  const tired = gateProbabilities('free', 'chatter', { socialBattery: 0 });
  check('empty battery: free chatter half to react/ignore', Math.abs(tired.now - 0.5) < 1e-9 && tired.react > 0 && tired.ignore > tired.react);
  const lightLow = gateProbabilities('light', 'chatter', { socialBattery: 10 });
  check('low battery tilts light chatter toward ignore/react', lightLow.ignore > 0.6 && lightLow.defer < 0.3);
  eq('battery ≥ 25 → no shift', gateProbabilities('light', 'chatter', { socialBattery: LOW_SOCIAL_BATTERY }), gateProbabilities('light', 'chatter'));
  eq('mentions and DMs ignore the battery', [gateProbabilities('light', 'mention', { socialBattery: 0 }), gateProbabilities('light', 'dm', { socialBattery: 0 })],
    [gateProbabilities('light', 'mention'), gateProbabilities('light', 'dm')]);
  const lowState = stateWith('free', { battery: 5 });
  const lowOut = Array.from({ length: 400 }, (_, i) => gateMessage(lowState, msgN('chatter', i), ctxFor('chatter'), { at: WED }).outcome);
  check('… and the gate rolls it (some free chatter ignored/reacted)', lowOut.some(o => o === 'ignore') && lowOut.some(o => o === 'react') && lowOut.some(o => o === 'now'));

  section('delay hints and score factors');
  const lightDm = Array.from({ length: 400 }, (_, i) => gateMessage(light, msgN('dm', i), ctxFor('dm'), { at: WED }));
  const nowL = lightDm.filter(g => g.outcome === 'now');
  const sneakL = lightDm.filter(g => g.outcome === 'sneak');
  check('now while light: 0–20 s', nowL.length > 0 && nowL.every(g => g.delayHintMs >= DELAY_HINTS.nowLight[0] && g.delayHintMs <= DELAY_HINTS.nowLight[1]) && nowL.some(g => g.delayHintMs > 0));
  check('sneak: 5–30 s', sneakL.length > 0 && sneakL.every(g => g.delayHintMs >= DELAY_HINTS.sneak[0] && g.delayHintMs <= DELAY_HINTS.sneak[1]));
  check('defer: no delay hint', lightDm.filter(g => g.outcome === 'defer').every(g => g.delayHintMs === 0));
  check('now while free: no delay hint', Array.from({ length: 20 }, (_, i) => gateMessage(stateWith('free'), msgN('dm', i), ctxFor('dm'), { at: WED })).every(g => g.delayHintMs === 0));
  check('now/sneak score factors in (0, 1]', AVAILABILITY_STATES.every(s => ['now', 'sneak'].every(o => {
    const f = scoreFactorFor(o, s, { socialBattery: 70, isGroup: true });
    return f > 0 && f <= 1;
  })));
  eq('free now → 1', scoreFactorFor('now', 'free'), 1);
  check('busier → lower', scoreFactorFor('now', 'light') > scoreFactorFor('now', 'busy') && scoreFactorFor('now', 'busy') > scoreFactorFor('now', 'meeting'));
  near('sneak scales by SNEAK_SCORE_FACTOR', scoreFactorFor('sneak', 'light'), SCORE_FACTOR.light * SNEAK_SCORE_FACTOR, 1e-3);
  check('defer/react/ignore → 0 (never reach decide())', ['defer', 'react', 'ignore'].every(o => scoreFactorFor(o, 'light') === 0));
  check('low battery lowers a group score', scoreFactorFor('now', 'free', { socialBattery: 0, isGroup: true }) < 1);
  eq('gate result carries scoreFactor', gateMessage(stateWith('free'), msgN('chatter', 1), ctxFor('chatter')).scoreFactor, 1);

  section('matrix override');
  const over = { busy: { dm: { now: 1 } } };
  check('an override cell replaces the default', Array.from({ length: 20 }, (_, i) => gateMessage(stateWith('busy'), msgN('dm', i), ctxFor('dm'), { matrix: over }).outcome).every(o => o === 'now'));
  eq('other cells keep the defaults', cellWeights('busy', 'mention', over), GATE_MATRIX.busy.mention);
  eq('junk weights fall back to the default cell', cellWeights('busy', 'dm', { busy: { dm: { now: -1, maybe: 3 } } }), GATE_MATRIX.busy.dm);

  section('phone-check cadence');
  const gap = (s, i) => {
    const st = stateWith(s, { until: WED + 5 * H });
    return (nextCheckAt(st, WED + i * 7, world).at - (WED + i * 7)) / MIN;
  };
  for (const s of ['free', 'light', 'busy']) {
    const gaps = Array.from({ length: 200 }, (_, i) => gap(s, i));
    const [lo, hi] = CHECK_GAP_MIN[s];
    check(`${s}: every gap in ${lo}–${hi} min, both ends reached`, gaps.every(g => g >= lo && g <= hi) && gaps.includes(lo) && gaps.includes(hi), [Math.min(...gaps), Math.max(...gaps)]);
  }
  const mt = Array.from({ length: 100 }, (_, i) => nextCheckAt(stateWith('meeting', { until: WED + 40 * MIN }), WED + i, world));
  check('meeting → its end + 0–5 min', mt.every(n => n.at >= WED + 40 * MIN && n.at <= WED + 45 * MIN && n.reason === 'meeting_end' && !n.readOnly));
  const dn = Array.from({ length: 100 }, (_, i) => nextCheckAt(stateWith('dnd', { until: WED + 2 * H, kind: 'movie' }), WED + i, world));
  check('dnd → the block end + 0–2 min', dn.every(n => n.at >= WED + 2 * H && n.at <= WED + 2 * H + 2 * MIN && n.reason === 'dnd_end'));
  const mtNoEnd = nextCheckAt(stateWith('meeting', { until: null }), WED, world);
  check('meeting with no known end → recheck in 15–30 min', mtNoEnd.reason === 'recheck:meeting' && mtNoEnd.at - WED >= 15 * MIN && mtNoEnd.at - WED <= 30 * MIN);
  const night = (startAt, wake) => {
    const s = stateWith('asleep', { kind: 'sleep', until: wake });
    s.activity.startAt = startAt;
    s.availability.since = startAt;
    return s;
  };
  let withNight = 0;
  let nights = 0;
  let wakeOk = true;
  let nightOk = true;
  for (let d = 0; d < 400; d++) {
    const sleepAt = WED + d * 86400;
    const wake = sleepAt + 8 * H;
    const st = night(sleepAt, wake);
    const n = nextCheckAt(st, sleepAt + 10 * MIN, world);
    const planned = nightChecks(sleepAt, wake);
    if (planned.length) {
      withNight++;
      nights += planned.length;
      nightOk &&= n.reason === 'night' && n.readOnly === true && n.at === Math.max(sleepAt + 10 * MIN + 60, planned[0])
        && planned.every(x => x >= sleepAt + H && x <= wake - H);
    } else {
      wakeOk &&= n.reason === 'wake' && !n.readOnly && n.at >= wake && n.at <= wake + 5 * MIN;
    }
  }
  check('asleep, no night check → the wake + 0–5 min', wakeOk);
  check('night checks: read only, inside the night, first one is next', nightOk);
  check(`night checks on ~10% of nights (${withNight}/400)`, withNight >= 20 && withNight <= 65);
  check('1–2 per such night', nights >= withNight && nights <= 2 * withNight);
  eq('night checks are deterministic', nightChecks(WED, WED + 8 * H), nightChecks(WED, WED + 8 * H));
  eq('a short sleep has no night checks', nightChecks(WED, WED + 2 * H), []);
  const lost = nextCheckAt(night(WED - 9 * H, WED - H), WED, world);
  check('asleep past the wake → read-only recheck', lost.reason === 'recheck:asleep' && lost.readOnly === true);
  const dur = Array.from({ length: 200 }, (_, i) => checkDurationSec(rngFor(String(WED + i), 'phone.check')));
  check('a check lasts 1–4 min', dur.every(d => d >= CHECK_DURATION_SEC[0] && d <= CHECK_DURATION_SEC[1]));
  eq('cadence is deterministic for a time', nextCheckAt(light, WED, world), nextCheckAt(light, WED, world));
  check('next check always ≥ 1 min ahead', nextCheckAt(stateWith('meeting', { until: WED + 5 }), WED, world).at >= WED + 60);

  section('isAwakeAt and freeWindows');
  const day = structuredClone(base);
  day.genesisAt = D0 - 86400;
  day.at = WED;
  day.plan = plan;
  check('awake at noon on a planned day', isAwakeAt(day, WED, world));
  check('asleep inside the plan\'s sleep block', !isAwakeAt(day, plan.sleepAt + 30 * MIN, world));
  check('awake at the plan\'s wake', isAwakeAt(day, plan.wakeAt + MIN, world));
  const asleepNow = stateWith('asleep', { kind: 'sleep', until: WED - 10 * MIN, plan });
  check('asleep now (no woke yet) wins over the plan', !isAwakeAt(asleepNow, WED, world));
  const noPlan = structuredClone(base);
  check('no plan: routine hours (03:00 asleep, 15:00 awake)',
    !isAwakeAt(noPlan, atLocal(D0, '03:00', TZ), world) && isAwakeAt(noPlan, atLocal(D0, '15:00', TZ), world));
  const fw = freeWindows(day, D0, world);
  const freeBlocks = plan.blocks.filter(b => b.availability === 'free');
  check('free windows exist on the day', fw.length > 0 && freeBlocks.length > 0);
  check('every window is inside the day and ordered', fw.every((w, i) => w.from >= D0 && w.to <= addDays(D0, 1, TZ) && w.to > w.from && (i === 0 || w.from > fw[i - 1].to)));
  check('every window is free per the plan', fw.every(w => plan.blocks.filter(b => b.start < w.to && b.end > w.from).every(b => b.availability === 'free')));
  const freeMin = freeBlocks.reduce((s, b) => s + (Math.min(b.end, addDays(D0, 1, TZ)) - Math.max(b.start, D0)), 0);
  eq('windows cover exactly the free blocks (merged)', fw.reduce((s, w) => s + (w.to - w.from), 0), freeMin);
  check('no meeting/work inside a window', fw.every(w => !plan.blocks.some(b => ['meeting', 'work'].includes(b.kind) && b.start < w.to && b.end > w.from)));
  const long = freeWindows(day, D0, world, { minMinutes: 60 });
  check('minMinutes filters short windows', long.every(w => w.to - w.from >= 3600) && long.length <= fw.length);
  const sat = addDays(D0, 3, TZ);
  eq('another day: a predicted plan', weekday(sat, TZ), 6);
  const satWin = freeWindows(day, sat, world);
  check('… with more free time on the weekend', satWin.reduce((s, w) => s + w.to - w.from, 0) > fw.reduce((s, w) => s + w.to - w.from, 0));
  check('… first window after the weekend wake', satWin.length > 0 && minuteOfDay(satWin[0].from, TZ) >= 8 * 60);
} finally {
  setClock(null);
}

report();
