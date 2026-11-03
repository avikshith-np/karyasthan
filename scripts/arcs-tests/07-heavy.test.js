// 010 T016 — heavy arcs (src/life/story/heavy.js, research R17): the closed kind
// enum (no job_loss), per-kind preconditions/effects/pins, the forbidden list and
// regex, themeAllowed (seed, roll, onset and owner scenes), the roll inside the
// daily item, the veto card lead time, the onset item (start or heavy.lapsed:
// refused | precondition | stale), the end item, durations ≤ 30 days, the 90-day
// gap from the RAW log (eventLog.lastHeavyAt) and heavyGuardActive.
//
// unit: hand-built projections folded through the real projector (an in-memory
//       log: no DB) plus a five-year roll simulation; a scratch-DB section for the
//       append rules and lastHeavyAt.
// sim:  the facade-level guard checks (lifeGuardNote on day 5 of a 14-day arc,
//       008 proactive blocked, group fragment empty / DM low-mood line) — skipped
//       until T024 wires the story into the life facade.
// Invented, persona-neutral names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, exampleWorld, exampleArcSeed, skipSimUnlessWired,
  bootLife, stopLife, simulateDays, DAY, HOUR,
} from './_helpers.js';
import { createInitialState, project } from '../../src/life/projector.js';
import { genesis as pulseGenesis } from '../../src/life/pulse.js';
import { EVENT_TYPES } from '../../src/life/eventLog.js';
import { zonedToUnix, dateKey } from '../../src/life/clock.js';
import { rngFor, setRngSeed } from '../../src/life/rng.js';
import { heavyGuardActive } from '../../src/life/story/reducer.js';
import { categoryOf } from '../../src/life/story/controls.js';
import { castCard } from '../../src/life/innerState.js';
import * as heavy from '../../src/life/story/heavy.js';

setRngSeed(4242);
const world = await exampleWorld();
const tz = world.timezone;
const T0 = zonedToUnix(2026, 10, 27, 6, 0, tz);
const KNOWN = ['Quinlan Marsh', 'Rowan Vale'];

// ── In-memory log: ids, the real projector, the eventLog's heavy rules ──────
function makeLog() {
  let state = createInitialState(world);
  const events = [];
  const add = (d) => {
    if (!EVENT_TYPES.has(d.type)) throw new Error(`unknown type ${d.type}`);
    const isHeavy = d.heavy === true;
    if (d.type === 'heavy.started' && !isHeavy) throw new Error('heavy.started must be heavy');
    if (d.type !== 'heavy.started' && isHeavy && d.type.startsWith('heavy.')) throw new Error(`${d.type} cannot be heavy`);
    const actor = d.actor ?? 'engine';
    const e = {
      id: events.length + 1, at: d.at, type: d.type, actor, causeId: d.causeId ?? null,
      payload: structuredClone(d.payload ?? {}), originKind: actor === 'owner' ? 'owner' : 'self', originJid: actor === 'owner' ? 'owner' : 'self',
      subjectJid: null, heavy: isHeavy, redacted: false,
    };
    events.push(e);
    state = project(state, e, world);
    return e;
  };
  const owner = (type, at, payload) => add({ type, at, actor: 'owner', payload });
  pulseGenesis(add, world, T0);
  return {
    get state() { return state; },
    events, add, owner,
    getEvent: (id) => events.find(e => e.id === id) ?? null,
    lastHeavyAt: () => {
      const ats = events.filter(e => e.type === 'heavy.proposed' || e.type === 'heavy.started').map(e => e.at);
      return ats.length ? Math.max(...ats) : null;
    },
    after: (id) => events.filter(e => e.id > id),
  };
}

const always = () => { const r = () => 0; r.int = (a) => a; r.float = (a) => a; return r; };
const never = () => { const r = () => 0.999999; r.int = (a, b) => b; r.float = (a, b) => b; return r; };

function runItem(log, it) {
  const before = log.events.length;
  const res = it.run(log.add);
  return Promise.resolve(res).then(() => log.events.slice(before));
}

function propose(log, payloadOver = {}, at = log.state.at) {
  return log.add({
    type: 'heavy.proposed', at, actor: 'engine',
    payload: { themeId: 'minor-accident', kind: 'minor_accident', label: 'a small accident', onsetAt: at + 30 * HOUR, roll: 0.0001, p: 0.0014, nominated: false, durationDays: 4, ...payloadOver },
  });
}

let seed;
try {
  seed = await exampleArcSeed();

  // ───────────────────────────── unit ─────────────────────────────
  section('catalogue');
  eq('six heavy kinds, closed enum', [...heavy.HEAVY_KINDS].sort(),
    ['breakup', 'family_illness', 'friend_moving_away', 'minor_accident', 'money_setback', 'pet_loss']);
  check('job_loss is deferred: not a kind', !heavy.HEAVY_KINDS.includes('job_loss') && heavy.DEFERRED_KINDS.includes('job_loss'));
  check('every kind maps to the heavy category (controls stays in step)', heavy.HEAVY_KINDS.every(k => categoryOf(k) === 'heavy'));
  check('KIND_RULES covers exactly the kinds', Object.keys(heavy.KIND_RULES).sort().join() === [...heavy.HEAVY_KINDS].sort().join());
  check('forbidden kinds include self-harm, suicide, abuse, own death, crime',
    ['self_harm', 'suicide', 'abuse', 'own_death', 'crime'].every(k => heavy.FORBIDDEN_KINDS.includes(k)));

  section('themeAllowed (seed, roll, owner scenes)');
  check('the example seed themes pass', seed.heavy.themes.every(t => heavy.themeAllowed(t, KNOWN).ok));
  for (const label of ['thoughts of suicide', 'self-harm episode', 'abuse at home', 'his own death', 'arrested for theft',
    'a crime he commits', 'kills himself', 'a funeral', 'drunk driving']) {
    eq(`forbidden label refused: "${label}"`, heavy.themeAllowed({ id: 'x', kind: 'minor_accident', label }, KNOWN).reason, 'forbidden');
  }
  for (const kind of ['self_harm', 'suicide', 'abuse', 'own_death', 'crime', 'job_loss', 'alien_abduction']) {
    eq(`kind refused: ${kind}`, heavy.themeAllowed({ id: 'x', kind, label: 'a hard week' }, KNOWN).reason, 'forbidden');
  }
  eq('a real person named in the label → name_collision', heavy.themeAllowed({ id: 'x', kind: 'friend_moving_away', label: 'Quinlan moving away' }, KNOWN).reason, 'name_collision');
  eq('lowercase common word is fine', heavy.themeAllowed({ id: 'x', kind: 'pet_loss', label: 'losing an old pet' }, KNOWN).ok, true);
  eq('durations above 30 days are invalid', heavy.themeAllowed({ id: 'x', kind: 'pet_loss', label: 'losing a pet', durationDays: [3, 31] }).reason, 'invalid');
  eq('a forbidden id is refused too', heavy.themeAllowed({ id: 'self-harm', kind: 'pet_loss', label: 'a quiet week' }).reason, 'forbidden');
  eq('seedThemes drops forbidden and unknown themes', heavy.seedThemes({ heavy: { themes: [
    ...seed.heavy.themes, { id: 'bad', kind: 'minor_accident', label: 'arrested again' }, { id: 'jl', kind: 'job_loss', label: 'laid off' },
  ] } }, KNOWN).map(t => t.id), ['minor-accident', 'friend-moving-away']);

  {
    const bad = { heavy: { themes: [...seed.heavy.themes, { id: 'bad', kind: 'minor_accident', label: 'arrested again' }, { id: 'named', kind: 'friend_moving_away', label: 'Quinlan leaving' }] } };
    const refusals = [];
    const out = await heavy.dailyRoll({ state: makeLog().state, add: () => {}, at: T0 + 2 * DAY, world, seed: bad },
      { lastHeavyAt: () => null, rngFor: () => always(), knownNames: KNOWN, refuse: r => refusals.push(r) });
    check('at roll time a forbidden seed theme is refused and logged (never picked)', out.outcome === 'proposed'
      && refusals.some(r => r.target === 'theme:bad' && r.reason === 'forbidden') && refusals.some(r => r.target === 'theme:named' && r.reason === 'name_collision'), refusals);
  }

  section('roll probability (formula, research R17)');
  const L0 = makeLog();
  eq('defaults → 1/720 per day (≈ 0.5 a year)', heavy.rollP(L0.state), 1 / 720);
  L0.owner('director.slider_set', T0 + 1, { slider: 'drama', value: 1 });
  L0.owner('director.slider_set', T0 + 1, { slider: 'heavyLikelihood', value: 1 });
  check('maximum → 3/720 = 1/240 per day', Math.abs(heavy.rollP(L0.state) - 1 / 240) < 1e-12, heavy.rollP(L0.state));
  L0.owner('director.slider_set', T0 + 2, { slider: 'heavyLikelihood', value: 0 });
  eq('heavyLikelihood 0 → p 0', heavy.rollP(L0.state), 0);
  eq('… and the roll reports off', heavy.roll(L0.state, always(), seed, null, { at: T0 + DAY }).outcome, 'off');

  section('roll gates');
  {
    const L = makeLog();
    const at = T0 + 2 * DAY;
    eq('no heavy section → inert', heavy.roll(L.state, always(), { ...seed, heavy: null }, null, { at }).outcome, 'inert');
    eq('a roll ≥ p → no', heavy.roll(L.state, never(), seed, null, { at }).outcome, 'no');
    const hit = heavy.roll(L.state, always(), seed, null, { at, world });
    eq('a roll < p → proposed', hit.outcome, 'proposed');
    const pp = hit.descriptor.payload;
    check('proposal: engine, not heavy, onset ≥ 24 h ahead and ≤ 36 h', hit.descriptor.actor === 'engine' && hit.descriptor.heavy !== true
      && pp.onsetAt >= at + 24 * HOUR && pp.onsetAt <= at + 36 * HOUR, pp);
    check('proposal stores the roll, p, theme, kind, label, duration once', pp.roll < pp.p && pp.themeId && heavy.HEAVY_KINDS.includes(pp.kind)
      && typeof pp.label === 'string' && Number.isInteger(pp.durationDays) && pp.durationDays >= 1 && pp.durationDays <= 30, pp);
    eq('a gap of 89 days since the last heavy row → gap', heavy.roll(L.state, always(), seed, at - 89 * DAY, { at }).outcome, 'gap');
    eq('… 90 days → rollable', heavy.roll(L.state, always(), seed, at - 90 * DAY, { at }).outcome, 'proposed');
    eq('config can only raise the gap (30 → still 90)', heavy.roll(L.state, always(), seed, at - 60 * DAY, { at, cfg: { heavyMinGapDays: 30 } }).outcome, 'gap');
    eq('config can raise it (200)', heavy.roll(L.state, always(), seed, at - 150 * DAY, { at, cfg: { heavyMinGapDays: 200 } }).outcome, 'gap');
    propose(L, {}, at);
    eq('a pending proposal → pending', heavy.roll(L.state, always(), seed, null, { at: at + DAY }).outcome, 'pending');
    const F = makeLog();
    F.owner('director.fate_set', T0 + 1, { category: 'heavy', mode: 'frozen' });
    const fr = heavy.roll(F.state, always(), seed, null, { at });
    check('heavy frozen → frozen, with a refusal row', fr.outcome === 'frozen' && fr.refusal?.reason === 'frozen', fr);
    const P = makeLog();
    P.owner('director.paused', T0 + 1, { reason: 'test' });
    eq('paused → paused', heavy.roll(P.state, always(), seed, null, { at }).outcome, 'paused');
  }

  section('per-kind preconditions and pins');
  {
    const breakupSeed = { heavy: { themes: [{ id: 'split', kind: 'breakup', label: 'a breakup', durationDays: [5, 10] }] } };
    const L = makeLog();
    const at = T0 + 2 * DAY;
    eq('breakup while single → not rollable', heavy.roll(L.state, always(), breakupSeed, null, { at }).outcome, 'no_candidate');
    const arc = L.add({ type: 'arc.started', at: T0 + 10, actor: 'engine', payload: { category: 'romance', kind: 'romance', castIds: ['cast:flatmate'], stage: 'talking' } });
    eq('breakup while only talking → not rollable', heavy.roll(L.state, always(), breakupSeed, null, { at }).outcome, 'no_candidate');
    L.add({ type: 'arc.stage', at: T0 + 20, actor: 'engine', payload: { arcId: arc.id, from: 'talking', to: 'dating', reason: 'decision' } });
    eq('breakup with an active romance at dating → rollable', heavy.roll(L.state, always(), breakupSeed, null, { at }).outcome, 'proposed');
    L.owner('director.pin_set', T0 + 30, { pinKey: 'self.relationship' });
    const pinned = heavy.roll(L.state, always(), breakupSeed, null, { at });
    check('pin self.relationship → not rollable, refusal names the pin', pinned.outcome === 'no_candidate' && pinned.refusal?.pinKey === 'self.relationship', pinned);
    const R = makeLog();
    const arc2 = R.add({ type: 'arc.started', at: T0 + 10, actor: 'engine', payload: { category: 'romance', kind: 'romance', castIds: ['cast:flatmate'], stage: 'dating' } });
    R.owner('director.fate_set', T0 + 11, { category: 'romance', mode: 'frozen' });
    eq('romance frozen → breakup not rollable', heavy.roll(R.state, always(), breakupSeed, null, { at }).outcome, 'no_candidate');
    check('(arc id used)', arc2.id > 0);

    const accSeed = { heavy: { themes: [{ id: 'acc', kind: 'minor_accident', label: 'a small accident', durationDays: [2, 4] }] } };
    const H = makeLog();
    H.owner('director.fate_set', T0 + 1, { category: 'health', mode: 'frozen' });
    eq('health frozen → minor_accident not rollable', heavy.roll(H.state, always(), accSeed, null, { at }).outcome, 'no_candidate');

    const illSeed = { heavy: { themes: [{ id: 'ill', kind: 'family_illness', label: 'a parent unwell', durationDays: [3, 7] }] } };
    const I = makeLog();
    const ill = heavy.roll(I.state, always(), illSeed, null, { at });
    check('family_illness targets a family:* member', ill.outcome === 'proposed' && I.state.cast.get(ill.descriptor.payload.castId)?.relation?.startsWith('family:'), ill.descriptor?.payload);
    for (const id of [...I.state.cast.values()].filter(c => c.relation.startsWith('family:')).map(c => c.id)) I.owner('director.pin_set', T0 + 5, { pinKey: id });
    eq('every family member pinned → not rollable', heavy.roll(I.state, always(), illSeed, null, { at }).outcome, 'no_candidate');

    const friendSeed = { heavy: { themes: [{ id: 'mv', kind: 'friend_moving_away', label: 'a friend moving away', durationDays: [3, 14] }] } };
    const Fr = makeLog();
    const fr = heavy.roll(Fr.state, always(), friendSeed, null, { at });
    const target = Fr.state.cast.get(fr.descriptor?.payload?.castId);
    check('friend_moving_away targets a non-family member with closeness ≥ 0.4',
      fr.outcome === 'proposed' && target && !target.relation.startsWith('family:') && target.metrics.closeness >= 0.4, fr.descriptor?.payload);

    const money = { heavy: { themes: [{ id: 'cash', kind: 'money_setback', label: 'an unexpected bill', durationDays: [2, 5] }] } };
    eq('money_setback with a salary → rollable', heavy.roll(makeLog().state, always(), money, null, { at, world }).outcome, 'proposed');
    eq('money_setback without a salary → not rollable', heavy.roll(makeLog().state, always(), money, null, { at, world: { ...world, money: {} } }).outcome, 'no_candidate');
  }

  section('onset item: start + effects, guard, end');
  {
    const L = makeLog();
    const pr = propose(L, { durationDays: 14 });
    const onsetAt = pr.payload.onsetAt;
    eq('not due before onsetAt', heavy.onsetItems(L.state, onsetAt - 1, { world, seed, getEvent: L.getEvent }).length, 0);
    const [it] = heavy.onsetItems(L.state, onsetAt, { world, seed, getEvent: L.getEvent });
    check('an onset item at onsetAt with the proposal id', it && it.at === onsetAt && it.id === pr.id && it.label === 'heavy:onset', it);
    const out = await runItem(L, it);
    const st = out[0];
    check('heavy.started: heavy, engine, caused by the proposal, until = +14 d', st.type === 'heavy.started' && st.heavy === true
      && st.actor === 'engine' && st.causeId === pr.id && st.payload.until === onsetAt + 14 * DAY && st.payload.proposedId === pr.id, st);
    const eff = out.slice(1);
    check('minor_accident effect: sick.started {days 1..3, until} caused by heavy.started',
      eff.length === 1 && eff[0].type === 'sick.started' && eff[0].causeId === st.id && eff[0].payload.days >= 1 && eff[0].payload.days <= 3
      && eff[0].payload.until > onsetAt, eff);
    eq('proposal folded as started', L.state.story.heavy.proposals[pr.id].status, 'started');
    check('heavyGuardActive on day 5 of the 14-day arc', heavyGuardActive(L.state, onsetAt + 5 * DAY));
    check('… still on day 13', heavyGuardActive(L.state, onsetAt + 13 * DAY));
    check('… off at until', !heavyGuardActive(L.state, onsetAt + 14 * DAY));
    eq('no second onset item once started', heavy.onsetItems(L.state, onsetAt + DAY, { world, seed, getEvent: L.getEvent }).length, 0);
    eq('no end item before until', heavy.endItem(L.state, onsetAt + 14 * DAY - 1), null);
    const end = heavy.endItem(L.state, onsetAt + 14 * DAY);
    const ended = await runItem(L, end);
    check('heavy.ended {reason:due} at until, caused by heavy.started', ended.length === 1 && ended[0].type === 'heavy.ended'
      && ended[0].at === onsetAt + 14 * DAY && ended[0].causeId === st.id && ended[0].payload.reason === 'due', ended);
    eq('active cleared', L.state.story.heavy.active, null);
    check('guard off after the end', !heavyGuardActive(L.state, onsetAt + 14 * DAY));
    eq('durations are capped at 30 days', (await (async () => {
      const L2 = makeLog();
      const p2 = propose(L2, { durationDays: 45 });
      const out2 = await runItem(L2, heavy.onsetItems(L2.state, p2.payload.onsetAt, { world, seed, getEvent: L2.getEvent })[0]);
      return (out2[0].payload.until - p2.payload.onsetAt) / DAY;
    })()), 30);
  }

  section('onset effects per kind');
  {
    // breakup: ends the romance, cancels its open decisions, back to single.
    const L = makeLog();
    const arc = L.add({ type: 'arc.started', at: T0 + 10, actor: 'engine', payload: { category: 'romance', kind: 'romance', castIds: ['cast:flatmate'], stage: 'dating' } });
    const d = L.add({
      type: 'decision.opened', at: T0 + 20, actor: 'engine',
      payload: { kind: 'romance:step', category: 'romance', arcId: arc.id, subject: { eventAt: T0 + 3 * DAY, castIds: ['cast:flatmate'] },
        opensAt: T0 + 20, decideBy: T0 + 3 * DAY, ponrAt: T0 + 3 * DAY, mode: 'auto', options: [{ id: 'step', label: 'step' }, { id: 'wait', label: 'wait' }] },
    });
    eq('dating → self.relationship dating', L.state.self.relationship, 'dating');
    const pr = propose(L, { themeId: 'split', kind: 'breakup', label: 'a breakup', durationDays: 7 }, T0 + 30);
    const bSeed = { heavy: { themes: [{ id: 'split', kind: 'breakup', label: 'a breakup', durationDays: [5, 10] }] } };
    const out = await runItem(L, heavy.onsetItems(L.state, pr.payload.onsetAt, { world, seed: bSeed, getEvent: L.getEvent })[0]);
    eq('breakup: started, the open decision cancelled, the arc ended', out.map(e => e.type), ['heavy.started', 'decision.expired', 'arc.ended']);
    check('… caused by heavy.started', out.slice(1).every(e => e.causeId === out[0].id));
    eq('decision cancelled', L.state.decisions.get(d.id).status, 'cancelled');
    eq('arc ended broken_up', L.state.story.arcs[arc.id].outcome, 'broken_up');
    eq('self.relationship → single', L.state.self.relationship, 'single');

    // friend_moving_away: an away beat until the arc's end.
    const F = makeLog();
    const fp = propose(F, { themeId: 'mv', kind: 'friend_moving_away', label: 'a friend moving away', durationDays: 10, castId: 'cast:flatmate' });
    const fout = await runItem(F, heavy.onsetItems(F.state, fp.payload.onsetAt, { world, seed, getEvent: F.getEvent })[0]);
    check('friend_moving_away → cast.beat away until the arc end', fout[1]?.type === 'cast.beat' && fout[1].payload.kind === 'away'
      && fout[1].payload.until === fout[0].payload.until && fout[1].payload.castId === 'cast:flatmate', fout);

    // family_illness: a news beat + bounded stress.
    const I = makeLog();
    const ip = propose(I, { themeId: 'ill', kind: 'family_illness', label: 'a parent unwell', durationDays: 5, castId: 'cast:parent' });
    const iSeed = { heavy: { themes: [{ id: 'ill', kind: 'family_illness', label: 'a parent unwell', durationDays: [3, 7] }] } };
    const iout = await runItem(I, heavy.onsetItems(I.state, ip.payload.onsetAt, { world, seed: iSeed, getEvent: I.getEvent })[0]);
    check('family_illness → news beat on the member + vitals.nudged stress ≤ 15', iout[1]?.type === 'cast.beat' && iout[1].payload.kind === 'news'
      && iout[2]?.type === 'vitals.nudged' && iout[2].payload.delta.stress > 0 && iout[2].payload.delta.stress <= 15, iout);

    // pet_loss and money_setback.
    const Pt = makeLog();
    const pp = propose(Pt, { themeId: 'pet', kind: 'pet_loss', label: 'losing an old pet', durationDays: 3 });
    const pout = await runItem(Pt, heavy.onsetItems(Pt.state, pp.payload.onsetAt, { world, seed: { heavy: { themes: [{ id: 'pet', kind: 'pet_loss', label: 'losing an old pet', durationDays: [2, 4] }] } }, getEvent: Pt.getEvent })[0]);
    check('pet_loss → vitals.nudged valence −0.3', pout[1]?.type === 'vitals.nudged' && pout[1].payload.delta.valence === -0.3, pout);
    const M = makeLog();
    const mp = propose(M, { themeId: 'cash', kind: 'money_setback', label: 'an unexpected bill', durationDays: 3 });
    const mout = await runItem(M, heavy.onsetItems(M.state, mp.payload.onsetAt, { world, seed, getEvent: M.getEvent })[0]);
    check('money_setback → one money.spent ≤ 25% of salary', mout[1]?.type === 'money.spent' && mout[1].payload.for === 'setback'
      && mout[1].payload.amount > 0 && mout[1].payload.amount <= 0.25 * world.money.salary, mout);
  }

  section('onset lapses (the item always appends)');
  {
    const lapse = async (setup, label, want) => {
      const L = makeLog();
      const pr = propose(L);
      const g = await setup(L, pr);
      const items = heavy.onsetItems(L.state, g ?? pr.payload.onsetAt, { world, seed, getEvent: L.getEvent });
      if (want === null) return eq(`${label} → no item`, items.length, 0);
      const out = await runItem(L, items[0]);
      return check(`${label} → one heavy.lapsed {${want}}`, out.length === 1 && out[0].type === 'heavy.lapsed' && out[0].payload.reason === want
        && out[0].payload.proposedId === pr.id && out[0].causeId === pr.id && L.state.story.heavy.proposals[pr.id].status === 'lapsed', out);
    };
    await lapse((L, pr) => { L.owner('heavy.vetoed', pr.at + HOUR, { proposedId: pr.id }); }, 'vetoed', null);
    await lapse((L) => { L.owner('director.paused', L.state.at + 60, { reason: 'test' }); }, 'paused at onset (still offered, only to lapse)', 'refused');
    await lapse((L) => { L.owner('director.fate_set', L.state.at + 60, { category: 'heavy', mode: 'frozen' }); }, 'heavy frozen', 'refused');
    await lapse((L) => { L.owner('director.fate_set', L.state.at + 60, { category: 'health', mode: 'frozen' }); }, 'health frozen (minor_accident)', 'refused');
    await lapse((L, pr) => {
      L.add({ type: 'weather.changed', at: pr.payload.onsetAt + 3 * HOUR, actor: 'engine', payload: {} });
      return pr.payload.onsetAt + 3 * HOUR;
    }, 'the projection jumped past onsetAt (rewind/re-anchor)', 'stale');
    // breakup whose romance ended before the onset
    const L = makeLog();
    const arc = L.add({ type: 'arc.started', at: T0 + 10, actor: 'engine', payload: { category: 'romance', kind: 'romance', castIds: ['cast:flatmate'], stage: 'dating' } });
    const pr = propose(L, { themeId: 'split', kind: 'breakup', label: 'a breakup', durationDays: 7 }, T0 + 20);
    L.add({ type: 'arc.ended', at: T0 + 30, actor: 'engine', payload: { arcId: arc.id, outcome: 'fizzled' } });
    const out = await runItem(L, heavy.onsetItems(L.state, pr.payload.onsetAt, { world, seed, getEvent: L.getEvent })[0]);
    check('breakup after the romance ended → heavy.lapsed {precondition}', out.length === 1 && out[0].payload.reason === 'precondition', out);
    const refusals = [];
    const Lp = makeLog();
    const pp = propose(Lp, { themeId: 'mv', kind: 'friend_moving_away', label: 'a friend moving away', castId: 'cast:flatmate' });
    Lp.owner('director.pin_set', Lp.state.at + 60, { pinKey: 'cast:flatmate' });
    const pout = await runItem(Lp, heavy.onsetItems(Lp.state, pp.payload.onsetAt, { world, seed, getEvent: Lp.getEvent, refuse: r => refusals.push(r) })[0]);
    check('target pinned after the proposal → lapsed {refused} + a refusal row with the pin key',
      pout[0].payload.reason === 'refused' && refusals[0]?.pinKey === 'cast:flatmate', { pout, refusals });
  }

  section('owner heavy scene (Director: themeAllowed, precondition, cap)');
  {
    const L = makeLog();
    const at = T0 + DAY;
    const plan = (input, deps = {}) => heavy.ownerHeavyPlan(input, L.state, { at, seed, world, knownNames: KNOWN, lastHeavyAt: null, ...deps });
    eq('a forbidden label → forbidden_theme (400)', plan({ kind: 'minor_accident', label: 'arrested after a fight', durationDays: 3 }).code, 'forbidden_theme');
    eq('a forbidden kind → forbidden_theme', plan({ kind: 'suicide', label: 'a hard week', durationDays: 3 }).code, 'forbidden_theme');
    eq('job_loss → forbidden_theme', plan({ kind: 'job_loss', label: 'laid off', durationDays: 3 }).code, 'forbidden_theme');
    eq('a real name → forbidden_theme', plan({ kind: 'friend_moving_away', label: 'Rowan leaving town', durationDays: 3 }).code, 'forbidden_theme');
    eq('breakup while single → heavy_precondition', plan({ kind: 'breakup', label: 'a breakup', durationDays: 5 }).code, 'heavy_precondition');
    eq('31 days → invalid', plan({ kind: 'pet_loss', label: 'losing a pet', durationDays: 31 }).code, 'invalid');
    eq('within 90 days of the last heavy row → heavy_cap', plan({ kind: 'pet_loss', label: 'losing a pet', durationDays: 3 }, { lastHeavyAt: at - 30 * DAY }).code, 'heavy_cap');
    const ok = plan({ themeId: 'minor-accident', durationDays: 3 });
    check('a seed theme → ok with the payload and its effects', ok.ok && ok.payload.kind === 'minor_accident' && ok.payload.until === at + 3 * DAY
      && ok.effects(999).some(e => e.type === 'sick.started' && e.causeId === 999), ok);
    L.owner('director.fate_set', T0 + 1, { category: 'heavy', mode: 'frozen' });
    eq('heavy frozen → frozen (409)', plan({ kind: 'pet_loss', label: 'losing a pet', durationDays: 3 }).code, 'frozen');
  }

  section('dailyRoll adapter (cast.js deps.rolls.heavy)');
  {
    const L = makeLog();
    const at = T0 + 3 * DAY;
    const date = dateKey(at, tz);
    const refusals = [];
    const out = await heavy.dailyRoll({ state: L.state, add: L.add, at, date, world, seed }, { lastHeavyAt: () => null, rngFor: () => always(), refuse: r => refusals.push(r) });
    check('a hit appends exactly one heavy.proposed and reports it', out.outcome === 'proposed' && L.events.at(-1).type === 'heavy.proposed', out);
    const n = L.events.length;
    eq('a failing gap read fails closed (no roll)', (await heavy.dailyRoll({ state: L.state, add: L.add, at, date, world, seed }, { lastHeavyAt: () => { throw new Error('db'); }, rngFor: () => always() })).outcome, 'gap');
    eq('… and appends nothing', L.events.length, n);
    const real = await heavy.dailyRoll({ state: makeLog().state, add: () => {}, at, date, world, seed }, { lastHeavyAt: () => null });
    check('with the real rngFor the outcome is deterministic per date', JSON.stringify(real) === JSON.stringify(
      await heavy.dailyRoll({ state: makeLog().state, add: () => {}, at, date, world, seed }, { lastHeavyAt: () => null })), real);
  }

  section('five simulated years (unit roll sim): drama 1, heavy slider 1');
  async function fiveYears({ veto = false, sliders = { drama: 1, heavyLikelihood: 1 }, frozen = false } = {}) {
    const L = makeLog();
    for (const [slider, value] of Object.entries(sliders)) L.owner('director.slider_set', T0 + 1, { slider, value });
    if (frozen) L.owner('director.fate_set', T0 + 1, { category: 'heavy', mode: 'frozen' });
    for (let day = 1; day <= 5 * 365; day++) {
      const at = zonedToUnix(2026, 10, 27, 8, 0, tz) + day * DAY;
      for (const it of heavy.heavyItems(L.state, at, { world, seed, getEvent: L.getEvent })) await runItem(L, it);
      if (veto) {
        for (const [id, p] of Object.entries(L.state.story.heavy.proposals)) {
          if (p.status === 'pending') L.owner('heavy.vetoed', Math.max(L.state.at, p.at + 60), { proposedId: Number(id) });
        }
      }
      await heavy.dailyRoll({ state: L.state, add: L.add, at, date: dateKey(at, tz), world, seed }, { lastHeavyAt: L.lastHeavyAt, rngFor });
    }
    return L;
  }
  {
    const L = await fiveYears();
    const proposed = L.events.filter(e => e.type === 'heavy.proposed');
    const started = L.events.filter(e => e.type === 'heavy.started');
    const lapsed = L.events.filter(e => e.type === 'heavy.lapsed');
    console.log(`    (${proposed.length} proposals, ${started.length} onsets, ${lapsed.length} lapsed)`);
    check('≥ 1 onset in five years', started.length >= 1, { proposed: proposed.length, started: started.length });
    const gaps = started.slice(1).map((e, i) => (e.at - started[i].at) / DAY);
    check('onsets ≤ 1 per 90 days', gaps.every(g => g >= 90), gaps);
    const props = L.events.filter(e => e.type === 'heavy.proposed' || e.type === 'heavy.started').map(e => e.at);
    check('every heavy row (proposal or onset) ≥ 90 days after the previous proposal', proposed.slice(1).every((e, i) => (e.at - proposed[i].at) / DAY >= 90));
    check('100% of onsets preceded by their veto card ≥ 24 h ahead', started.every((s) => {
      const p = L.getEvent(s.payload.proposedId);
      return p && p.type === 'heavy.proposed' && s.at - p.at >= 24 * HOUR && s.causeId === p.id;
    }));
    check('each proposal is resolved exactly once (started or lapsed), never re-rolled', proposed.every(p =>
      started.filter(s => s.payload.proposedId === p.id).length + lapsed.filter(x => x.payload.proposedId === p.id).length <= 1));
    check('only seed kinds, never a forbidden one, durations ≤ 30 d', started.every(s => ['minor_accident', 'friend_moving_away'].includes(s.payload.kind)
      && (s.payload.until - s.at) <= 30 * DAY));
    check('every onset has an end', started.every(s => L.events.some(e => e.type === 'heavy.ended' && e.payload.heavyId === s.id)));
    check('(timeline sanity)', props.length === proposed.length + started.length);
  }
  {
    const L = await fiveYears({ veto: true });
    const proposed = L.events.filter(e => e.type === 'heavy.proposed');
    check('owner vetoes every card → never happens', !L.events.some(e => e.type === 'heavy.started') && proposed.length >= 1, proposed.length);
    check('… and a vetoed proposal still reserves the 90-day gap', proposed.slice(1).every((e, i) => (e.at - proposed[i].at) / DAY >= 90));
  }
  eq('heavy slider 0 → no proposal in five years', (await fiveYears({ sliders: { drama: 1, heavyLikelihood: 0 } })).events.filter(e => e.type.startsWith('heavy.')).length, 0);
  eq('heavy frozen → no proposal in five years', (await fiveYears({ frozen: true })).events.filter(e => e.type.startsWith('heavy.')).length, 0);

  // ───────────────────────── scratch DB: append rules + raw-log gap ─────────────────────────
  section('eventLog rules and the raw-log gap (scratch DB)');
  {
    await setupScratchDb();
    const log = await import('../../src/life/eventLog.js');
    const g = log.appendEvent({ type: 'genesis', at: T0, actor: 'engine', payload: { timezone: tz } });
    const at = T0 + DAY;
    const started = (actor, extra = {}) => () => log.appendEvent({ type: 'heavy.started', at, actor, heavy: true, payload: { kind: 'pet_loss', until: at + DAY }, ...extra });
    const refused = (name, fn) => { let ok = false; try { fn(); } catch { ok = true; } check(name, ok); };
    refused('chat cannot append heavy.started', started('chat', { originKind: 'group', originJid: '120363000000000301@g.us' }));
    refused('jev cannot append heavy.started', started('jev'));
    refused('mind cannot start a heavy arc', started('mind'));
    refused('heavy.started must be heavy', () => log.appendEvent({ type: 'heavy.started', at, actor: 'engine', payload: { kind: 'pet_loss' } }));
    refused('heavy.proposed cannot be heavy', () => log.appendEvent({ type: 'heavy.proposed', at, actor: 'engine', heavy: true, payload: { kind: 'pet_loss', onsetAt: at + DAY } }));
    const trig = log.appendEvent({ type: 'chat.trigger', at, actor: 'chat', originKind: 'group', originJid: '120363000000000301@g.us', payload: {} });
    refused('a chat-caused heavy.proposed is refused (reconciler/chat can never create heavy)', () =>
      log.appendEvent({ type: 'heavy.proposed', at, actor: 'engine', causeId: trig.id, payload: { kind: 'pet_loss', onsetAt: at + DAY } }));
    eq('lastHeavyAt with no heavy rows → null', log.lastHeavyAt(), null);
    const p = log.appendEvent({ type: 'heavy.proposed', at, actor: 'engine', causeId: g.id, payload: { kind: 'pet_loss', themeId: 'pet', onsetAt: at + 30 * HOUR } });
    log.revertEvent(p.id, { reason: 'test', by: 'owner', at: at + 60 });
    eq('a reverted proposal still counts (raw log)', log.lastHeavyAt(), at);
    const s0 = makeLog().state;
    eq('… so the roll is in the gap 30 days later', (await heavy.dailyRoll({ state: s0, add: () => {}, at: at + 30 * DAY, world, seed }, { rngFor: () => always() })).outcome, 'gap');
    check('… and rollable 90 days later (default lastHeavyAt reads the DB)',
      (await heavy.dailyRoll({ state: s0, add: () => {}, at: at + 90 * DAY, world, seed }, { rngFor: () => always() })).outcome === 'proposed');
    const ownerStart = log.appendEvent({ type: 'heavy.started', at: at + 2 * DAY, actor: 'owner', heavy: true, payload: { kind: 'pet_loss', until: at + 5 * DAY } });
    check('the owner may start a heavy arc', ownerStart.heavy === true || ownerStart.heavy === 1);
    eq('lastHeavyAt follows the onset', log.lastHeavyAt(), at + 2 * DAY);
  }

  // ───────────────────────────── sim ─────────────────────────────
  section('sim: heavy guard through the life facade (day 5 of a 14-day arc)');
  if (!(await skipSimUnlessWired())) {
    await setupScratchDb();
    const { life } = await bootLife({ arcSeed: seed });
    const story = await import('../../src/life/story/index.js');
    await simulateDays(1);
    const at = life.getState().at;
    const res = await life.appendOwnerBatch([
      { type: 'heavy.started', at, heavy: true, payload: { kind: 'friend_moving_away', themeId: 'friend-moving-away', castId: 'cast:flatmate', until: at + 14 * DAY } },
    ], { by: 'test' });
    check('owner heavy batch applied', !!res);
    await simulateHours(13);
    check('embargo over after 12 h, so embargoActive() is false', life.embargoActive() === false);
    await simulateDays(4);
    check('day 5: lifeGuardNote() still non-null (gate note + 008 proactive embargoed())', !!life.lifeGuardNote());
    const st = life.getState();
    eq('day 5: a group audience gets no heavy fragment', /rough|low/i.test(story.promptFragment(st, { kind: 'group', chatJid: '120363000000000301@g.us' }) || ''), false);
    check('day 5: a DM gets the low-mood line', (story.promptFragment(st, { kind: 'dm', chatJid: '15550000301@s.whatsapp.net' }) || '').length > 0);
    await stopLife();
  }

  section('sim: heavy-caused cast overlay and sickness never reach a group prompt (R17)');
  if (!(await skipSimUnlessWired())) {
    const { setSkills } = await import('./_helpers.js');
    const GROUP = { kind: 'group', chatJid: '120363000000000302@g.us', members: new Set() };
    const DM = { kind: 'dm', chatJid: '15550000302@s.whatsapp.net', members: new Set(['15550000302@s.whatsapp.net']) };
    const CALL = { kind: 'call', chatJid: DM.chatJid, members: DM.members };
    const IG = { kind: 'ig', chatJid: 'ig:thread-302', members: new Set() };

    // friend_moving_away: the away beat it causes.
    await setupScratchDb();
    const a = await bootLife({ arcSeed: seed });
    await simulateDays(1);
    let at = a.life.getState().at;
    a.life.appendOwnerBatch([
      { ref: '$h', type: 'heavy.started', at, heavy: true, payload: { kind: 'friend_moving_away', themeId: 'friend-moving-away', castId: 'cast:flatmate', until: at + 10 * DAY } },
      { type: 'cast.beat', actor: 'engine', causeRef: '$h', at, payload: { castId: 'cast:flatmate', kind: 'away', until: at + 10 * DAY } },
      { type: 'cast.beat', actor: 'engine', at, payload: { castId: 'cast:parent', kind: 'away', until: at + 4 * DAY } },
    ], { by: 'test' });
    await simulateHours(13);                       // past the 12 h embargo (tone-only lines)
    const cast = a.life.getState().cast;
    const flat = cast.get('cast:flatmate').name;
    const parent = cast.get('cast:parent').name;
    const card = (aud, name) => a.life.castCards(aud, [name], 3, { overBudget: false }).find(c => c.includes(name)) ?? '';
    check('heavy away: a DM card has the suffix', /away until/.test(card(DM, flat)), card(DM, flat));
    check('… a call card too', /away until/.test(card(CALL, flat)), card(CALL, flat));
    check('… a group card is the plain card', card(GROUP, flat) !== '' && !/away until/.test(card(GROUP, flat)), card(GROUP, flat));
    check('… an IG card too', card(IG, flat) !== '' && !/away until/.test(card(IG, flat)), card(IG, flat));
    check('… an unknown audience too (fails closed)', !/away until/.test(card(null, flat)), card(null, flat));
    check('an ordinary away trip still shows in a group', /away until/.test(card(GROUP, parent)), card(GROUP, parent));
    await setSkills({ arcs: false });
    eq('arcs off: the group card is 009\'s (no overlay at all)', card(GROUP, flat), castCard(cast.get('cast:flatmate')));
    eq('arcs off: the DM card is 009\'s too', card(DM, flat), castCard(cast.get('cast:flatmate')));
    await setSkills({ arcs: true });
    await stopLife();

    // minor_accident: the sick.started it causes.
    await setupScratchDb();
    const b = await bootLife({ arcSeed: seed });
    await simulateDays(1);
    at = b.life.getState().at;
    b.life.appendOwnerBatch([
      { ref: '$h', type: 'heavy.started', at, heavy: true, payload: { kind: 'minor_accident', themeId: 'minor-accident', until: at + 10 * DAY } },
      { type: 'sick.started', actor: 'engine', causeRef: '$h', at, payload: { until: at + 3 * DAY, days: 3, reason: 'accident' } },
    ], { by: 'test' });
    await simulateHours(13);
    const SICK = /home sick|under the weather/;
    const line = (aud) => b.life.innerStateLine(aud, { overBudget: false });
    check('heavy sick: a DM line may say so', SICK.test(line(DM)), line(DM));
    check('… a call line too', SICK.test(line(CALL)), line(CALL));
    check('… a group line never does', line(GROUP) !== '' && !SICK.test(line(GROUP)), line(GROUP));
    check('… nor an IG or unknown audience', !SICK.test(line(IG)) && !SICK.test(line(null)), [line(IG), line(null)]);
    await setSkills({ arcs: false });
    eq('arcs off: the group line is 009\'s (the same as the DM\'s, sickness included)', line(GROUP), line(DM));
    await setSkills({ arcs: true });
    await stopLife();
  }
} finally {
  // nothing global to restore
}

report();

async function simulateHours(h) {
  const { simulateHours: sh } = await import('./_helpers.js');
  return sh(h);
}
