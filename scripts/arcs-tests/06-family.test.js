// 010 T015 — family pressure (src/life/story/family.js, research R10): calls on
// the seed's cadence, pressure growing with age × growthPerYear × the slider,
// occasions once a year, a major occasion opening a big decision a week ahead,
// seed major decisions (≤ 1 per 90 days), consequences caused by the decision's
// decision.opened, controls (frozen, paused, pins), inert without a `family`
// section, and no region/culture strings in the code path (content = seed only).
//
// unit: hand-built projections through the real projector and the real
//       decisions.openDecision (noJev) on an in-memory log.
// sim:  calls through the life facade — skipped until T024.
// Invented, persona-neutral names only; no network, no models.
import fs from 'fs';
import path from 'path';
import {
  section, check, eq, near, report, exampleWorld, exampleArcSeed, skipSimUnlessWired, setupScratchDb,
  bootLife, stopLife, simulateDays, PROJECT_ROOT, DAY, HOUR,
} from './_helpers.js';
import { createInitialState, project } from '../../src/life/projector.js';
import { genesis as pulseGenesis } from '../../src/life/pulse.js';
import { EVENT_TYPES } from '../../src/life/eventLog.js';
import { zonedToUnix, dateKey, ageOn, localParts } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { openDecision } from '../../src/life/decisions.js';
import * as family from '../../src/life/story/family.js';

setRngSeed(99);
const world = await exampleWorld();
const tz = world.timezone;
const T0 = zonedToUnix(2026, 10, 27, 6, 0, tz);

function makeLog(w = world) {
  let state = createInitialState(w);
  const events = [];
  const add = (d) => {
    if (!EVENT_TYPES.has(d.type)) throw new Error(`unknown type ${d.type}`);
    const actor = d.actor ?? 'engine';
    const e = {
      id: events.length + 1, at: d.at, type: d.type, actor, causeId: d.causeId ?? null, payload: structuredClone(d.payload ?? {}),
      originKind: actor === 'owner' ? 'owner' : 'self', originJid: actor === 'owner' ? 'owner' : 'self', subjectJid: null, heavy: false, redacted: false,
    };
    events.push(e);
    state = project(state, e, w);
    return e;
  };
  pulseGenesis(add, w, T0);
  const L = {
    get state() { return state; }, events, add,
    owner: (type, at, payload) => add({ type, at, actor: 'owner', payload }),
    getEvent: (id) => events.find(e => e.id === id) ?? null,
    getState: () => state,
  };
  L.deps = (extra = {}) => ({ world: w, getState: L.getState, openDecision: (g, spec, ctx) => openDecision(g, spec, { ...ctx, noJev: true }), ...extra });
  return L;
}
const always = () => { const r = () => 0; r.int = (a) => a; r.float = (a) => a; return r; };
const runItem = async (L, it) => { const n = L.events.length; await it.run(L.add); return L.events.slice(n); };
const ofType = (L, t) => L.events.filter(e => e.type === t);

// Step day by day; within a day, run every due item (repeatedly, as the pulse would).
async function runDays(L, days, seed, { deps = {}, onDay = null } = {}) {
  const start = L.day ?? 0;
  for (let day = start; day < start + days; day++) {
    L.day = day + 1;
    const g = zonedToUnix(2026, 10, 27, 23, 30, tz) + day * DAY;
    for (let k = 0; k < 8; k++) {
      const items = family.familyItems(L.state, g, seed, L.deps(deps)).sort((a, b) => a.at - b.at);
      if (!items.length) break;
      await runItem(L, items[0]);
    }
    if (onDay) await onDay(g);
  }
}

let seed;
try {
  seed = await exampleArcSeed();

  section('pressureFactor (R10)');
  const theme = { id: 'more-calls', fromAge: 18, intensity: 0.3, growthPerYear: 0.02 };
  near('at fromAge: 0.2 × (0.5 + 0.5)', family.pressureFactor(18, theme, 0.5), 0.2);
  near('ten years on: (0.2 + 0.2) × 1', family.pressureFactor(28, theme, 0.5), 0.4);
  near('slider 1 → ×1.5', family.pressureFactor(28, theme, 1), 0.6);
  near('slider 0 → ×0.5', family.pressureFactor(28, theme, 0), 0.2);
  near('base clamps at 1', family.pressureFactor(120, theme, 0.5), 1);
  check('grows with age', family.pressureFactor(40, theme) > family.pressureFactor(30, theme) && family.pressureFactor(30, theme) > family.pressureFactor(20, theme));
  eq('no theme → 0', family.pressureFactor(30, null), 0);

  section('inert without content');
  eq('no family section → no_seed_section', family.familyStatus(makeLog().state, { ...seed, family: null }).inert, 'no_seed_section');
  const noFam = { ...world, cast: world.cast.filter(c => !c.relation.startsWith('family:')) };
  eq('no family:* cast → no_family_cast', family.familyStatus(makeLog(noFam).state, seed).inert, 'no_family_cast');
  eq('the example seed with the example world → active', family.familyStatus(makeLog().state, seed).inert, null);
  {
    const L = makeLog();
    const n = L.events.length;
    await runDays(L, 120, { ...seed, family: null });
    eq('family:null → no family events in 120 days', L.events.slice(n).filter(e => e.type.startsWith('family.') || e.payload?.category === 'family').length, 0);
    eq('family:null → the daily roll is inert', (await family.dailyRoll({ state: L.state, add: L.add, at: T0 + DAY, world, seed: { ...seed, family: null } })).outcome, 'inert');
  }

  section('calls follow the seed cadence');
  {
    const L = makeLog();
    await runDays(L, 180, seed);
    const calls = ofType(L, 'family.call');
    const [lo, hi] = seed.family.callCadenceDays;
    const gaps = calls.slice(1).map((e, i) => Math.round((Date.parse(dateKey(e.at, tz)) - Date.parse(dateKey(calls[i].at, tz))) / 864e5));
    check(`several calls in 180 days (${calls.length})`, calls.length >= Math.floor(180 / hi) && calls.length <= Math.ceil(180 / lo) + 1);
    check(`every gap within [${lo}, ${hi}] days`, gaps.every(g => g >= lo && g <= hi), gaps);
    const first = Math.round((Date.parse(dateKey(calls[0].at, tz)) - Date.parse(dateKey(T0, tz))) / 864e5);
    check('the first call one cadence after genesis', first >= lo && first <= hi, first);
    check('each call is from a family:* member, in the evening', calls.every(e => L.state.cast.get(e.payload.castId)?.relation.startsWith('family:')
      && localParts(e.at, tz).hour >= 18 && localParts(e.at, tz).hour <= 21), calls.map(e => [e.payload.castId, localParts(e.at, tz).hour]));
    check('themes and intensities come from the seed', calls.every(e => e.payload.themeId === 'more-calls' && e.payload.intensity >= 0 && e.payload.intensity <= 1));
    check('pressure stored = pressureFactor(age at the call, theme, slider)', calls.every(e =>
      Math.abs(e.payload.pressure - family.pressureFactor(ageOn(world.self.birthdate, e.at, tz), seed.family.themes[0], 0.5)) < 1e-4));
    check('nextCallAt stored and honoured', calls.slice(1).every((e, i) => e.at === calls[i].payload.nextCallAt));
    eq('the reducer tracks the last call', L.state.story.family.lastCallAt, calls.at(-1).at);
    check('calls are engine/self with no cause', calls.every(e => e.actor === 'engine' && e.causeId === null));
  }

  section('pressure follows age and the slider');
  {
    const older = { ...world, self: { ...world.self, birthdate: '1981-04-12' } };
    const young = makeLog();
    const old = makeLog(older);
    await runDays(young, 30, seed);
    await runDays(old, 30, seed);
    const pY = ofType(young, 'family.call')[0]?.payload.pressure;
    const pO = ofType(old, 'family.call')[0]?.payload.pressure;
    check('an older self feels more pressure from the same theme', pO > pY, { pY, pO });
    const hi = makeLog();
    hi.owner('director.slider_set', T0 + 1, { slider: 'familyPressure', value: 1 });
    await runDays(hi, 30, seed);
    near('slider 1 → ×1.5 of the default', ofType(hi, 'family.call')[0].payload.pressure, pY * 1.5, 1e-3);
  }

  section('controls: frozen, paused, pins');
  {
    const F = makeLog();
    F.owner('director.fate_set', T0 + 1, { category: 'family', mode: 'frozen' });
    const refusals = [];
    await runDays(F, 60, seed, { deps: { refuse: r => refusals.push(r) } });
    eq('family frozen → no calls', ofType(F, 'family.call').length, 0);
    check('… and a refusal is logged (deduped by the store)', refusals.some(r => r.reason === 'frozen' && r.category === 'family'), refusals.slice(0, 2));
    const P = makeLog();
    P.owner('director.paused', T0 + 1, { reason: 'test' });
    await runDays(P, 60, seed);
    eq('paused → no calls', ofType(P, 'family.call').length, 0);
    const N = makeLog();
    N.owner('director.pin_set', T0 + 1, { pinKey: 'cast:parent' });
    await runDays(N, 60, seed);
    check('a pinned member never calls; the other one does', ofType(N, 'family.call').length > 0 && ofType(N, 'family.call').every(e => e.payload.castId === 'cast:sibling'));
    const A = makeLog();
    A.owner('director.pin_set', T0 + 1, { pinKey: 'cast:parent' });
    A.owner('director.pin_set', T0 + 1, { pinKey: 'cast:sibling' });
    await runDays(A, 60, seed);
    eq('every member pinned → no calls', ofType(A, 'family.call').length, 0);
  }

  section('occasions and a major occasion\'s big decision');
  const occSeed = {
    ...seed,
    family: { ...seed.family, occasions: [
      { id: 'gathering', label: 'a family get-together', month: 12, day: 15, major: true },
      { id: 'small-day', label: 'a small yearly day', month: 11, day: null, major: false },
    ] },
  };
  {
    const L = makeLog();
    await runDays(L, 60, occSeed);
    const occ = ofType(L, 'family.occasion');
    eq('each occasion once, on its date (day null → the 1st)', occ.map(e => [e.payload.occasionId, dateKey(e.at, tz), e.payload.major]),
      [['small-day', '2026-11-01', false], ['gathering', '2026-12-15', true]]);
    const arcs = ofType(L, 'arc.started').filter(e => e.payload.category === 'family');
    eq('one family arc for the major occasion, a week ahead', arcs.map(e => [e.payload.kind, dateKey(e.at, tz)]), [['occasion', '2026-12-08']]);
    const op = L.events.find(e => e.type === 'decision.opened' && e.payload.category === 'family');
    check('a big Ask-me decision, caused by the arc, family:<id>, attend|call|skip (not go/late/stay)', op && op.payload.big === true && op.payload.mode === 'ask'
      && op.causeId === arcs[0].id && op.payload.kind === 'family:gathering' && op.payload.options.map(o => o.id).join() === 'attend,call,skip', op?.payload);
    check('lead time ≥ 24 h (decideBy a day before)', op.payload.decideBy - op.payload.opensAt >= 24 * HOUR && op.payload.decideBy === op.payload.subject.eventAt - DAY);
    check('option labels: code templates around the seed label', op.payload.options[0].label === 'Be there: a family get-together');
    await runDays(L, 400, occSeed);
    eq('next year: each occasion once more', ofType(L, 'family.occasion').length, 4);
  }
  {
    // consequence of a committed occasion decision
    const L = makeLog();
    await runDays(L, 43, occSeed);
    const op = L.events.find(e => e.type === 'decision.opened' && e.payload.category === 'family');
    const d = L.state.decisions.get(op.id);
    if (d.status === 'open') L.add({ type: 'decision.committed', at: op.at + HOUR, actor: 'owner', payload: { decisionId: d.id, optionId: 'attend', by: 'owner' } });
    const arcId = op.payload.arcId;
    const before = L.state.cast.get('cast:parent').metrics.closeness;
    const items = family.familyItems(L.state, op.at + 2 * HOUR, occSeed, L.deps()).filter(i => i.label.startsWith('family:done'));
    const evs = await runItem(L, items[0]);
    check('commit → relationship.changed (+closeness) per member + arc.ended done, caused by decision.opened, with commitEventId',
      evs.at(-1).type === 'arc.ended' && evs.at(-1).payload.outcome === 'done' && evs.every(e => e.causeId === op.id)
      && evs.every(e => Number.isInteger(e.payload.commitEventId)), evs.map(e => [e.type, e.payload]));
    check('closeness rose', L.state.cast.get('cast:parent').metrics.closeness > before);
    eq('arc ended', L.state.story.arcs[arcId].status, 'ended');
    eq('not due again', family.familyItems(L.state, op.at + DAY, occSeed, L.deps()).filter(i => i.label.startsWith('family:done')).length, 0);
  }
  {
    // frozen after the commit → terminal decision.expired
    const L = makeLog();
    await runDays(L, 43, occSeed);
    const op = L.events.find(e => e.type === 'decision.opened' && e.payload.category === 'family');
    if (L.state.decisions.get(op.id).status === 'open') L.add({ type: 'decision.committed', at: op.at + HOUR, actor: 'owner', payload: { decisionId: op.id, optionId: 'skip', by: 'owner' } });
    L.owner('director.fate_set', op.at + 90 * 60, { category: 'family', mode: 'frozen' });
    const evs = await runItem(L, family.familyItems(L.state, op.at + 2 * HOUR, occSeed, L.deps())[0]);
    check('family frozen after the commit → decision.expired {frozen} closes it', evs.length === 1 && evs[0].type === 'decision.expired' && evs[0].payload.reason === 'frozen', evs);
  }
  {
    // an arc whose decision never opened is closed after a day
    const L = makeLog();
    const arc = L.add({ type: 'arc.started', at: T0 + HOUR, actor: 'engine', payload: { category: 'family', kind: 'occasion', castIds: ['cast:parent'], stage: 'open', state: { occasionId: 'x', year: 2026 } } });
    eq('not before a day', family.consequence(L.state, L.state.story.arcs[arc.id], T0 + 12 * HOUR), null);
    const evs = await runItem(L, family.consequence(L.state, L.state.story.arcs[arc.id], T0 + 2 * DAY));
    check('an orphaned family arc → arc.ended {cancelled}', evs[0]?.type === 'arc.ended' && evs[0].payload.outcome === 'cancelled', evs);
  }

  section('seed major decisions (daily roll)');
  const majorSeed = {
    ...seed,
    family: { ...seed.family, majorDecisions: [{ id: 'live-closer', label: 'moving closer to family', themeId: 'more-calls', fromAge: 18,
      options: [{ id: 'agree', label: 'Agree to it' }, { id: 'hold', label: 'Not now' }] }] },
  };
  {
    const L = makeLog();
    const at = T0 + 2 * DAY;
    const out = await family.dailyRoll({ state: L.state, add: L.add, at, date: dateKey(at, tz), world, seed: majorSeed }, L.deps({ rngFor: () => always() }));
    eq('a hit opens one', out.outcome, 'opened');
    const op = L.events.find(e => e.type === 'decision.opened');
    check('big Ask-me family:<id> with the seed options, ≥ 24 h lead, caused by its arc', op.payload.kind === 'family:live-closer' && op.payload.big && op.payload.mode === 'ask'
      && op.payload.options.map(o => o.label).join('|') === 'Agree to it|Not now' && op.payload.decideBy - op.payload.opensAt >= 24 * HOUR
      && L.getEvent(op.causeId)?.type === 'arc.started', op.payload);
    eq('one at a time', (await family.dailyRoll({ state: L.state, add: L.add, at: at + DAY, world, seed: majorSeed }, L.deps({ rngFor: () => always() }))).outcome, 'open');
    L.add({ type: 'decision.committed', at: at + 3 * DAY, actor: 'owner', payload: { decisionId: op.id, optionId: 'hold', by: 'owner' } });
    await runItem(L, family.familyItems(L.state, at + 3 * DAY, majorSeed, L.deps()).find(i => i.label === 'family:done'));
    eq('closed after the commit, then ≤ 1 per 90 days', (await family.dailyRoll({ state: L.state, add: L.add, at: at + 60 * DAY, world, seed: majorSeed }, L.deps({ rngFor: () => always() }))).outcome, 'gap');
    eq('… rollable again after 90 days', (await family.dailyRoll({ state: L.state, add: L.add, at: at + 91 * DAY, world, seed: majorSeed }, L.deps({ rngFor: () => always() }))).outcome, 'opened');
    const young = makeLog({ ...world, self: { ...world.self, birthdate: '2015-01-01' } });
    eq('below the age gate → not eligible', (await family.dailyRoll({ state: young.state, add: young.add, at, world, seed: majorSeed }, young.deps({ rngFor: () => always() }))).outcome, 'not_eligible');
    const F = makeLog();
    F.owner('director.fate_set', T0 + 1, { category: 'family', mode: 'frozen' });
    eq('family frozen → refused', (await family.dailyRoll({ state: F.state, add: F.add, at, world, seed: majorSeed }, F.deps({ rngFor: () => always() }))).outcome, 'frozen');
    const evening = { ...majorSeed, family: { ...majorSeed.family, majorDecisions: [{ ...majorSeed.family.majorDecisions[0], options: [{ id: 'go', label: 'a' }, { id: 'late', label: 'b' }, { id: 'stay', label: 'c' }] }] } };
    eq('an exact go/late/stay option set is dropped (it would rewrite his day)', (await family.dailyRoll({ state: makeLog().state, add: () => {}, at, world, seed: evening })).outcome, 'none');
  }

  section('content only from the seed: no region/culture strings in family.js');
  {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'life', 'story', 'family.js'), 'utf-8');
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const literals = [...code.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(m => m[1] ?? m[2]);
    const prose = literals.filter(s => /^[A-Z]/.test(s) || /\p{L} \p{L}/u.test(s));
    eq('the only prose literals are the neutral option templates', [...new Set(prose)].sort(),
      ['Be there: ${label}', 'Call instead', 'Skip it', 'the occasion'].sort());
  }

  section('sim: family calls through the life facade');
  if (!(await skipSimUnlessWired())) {
    await setupScratchDb();
    const { life } = await bootLife({ arcSeed: seed });
    const { listEvents } = await import('../../src/life/eventLog.js');
    await simulateDays(30, { stepMinutes: 60 });
    const calls = listEvents({ types: ['family.call'], limit: 50 });
    check('calls happen on the cadence through the facade', calls.length >= 2, calls.length);
    await stopLife();
  }
} finally {
  // nothing global to restore
}

report();
