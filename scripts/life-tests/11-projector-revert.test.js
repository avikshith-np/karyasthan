// T016 — projector (src/life/projector.js): the reducer over the §D catalogue,
// purity, vitals integrated between events, live fold ≡ replay, serialization
// round trip, revert cascade (engine/jev excluded; chat/owner orphaned but kept;
// live revert rebuilds), redacted/unknown events, snapshot write/load/
// equivalence, stale-snapshot fallback, invalidation and retention. Scratch DB,
// fake clock, example world; no network, no LLM.
import { setupScratchDb, fakeClock, section, check, eq, near, throws, report } from './_helpers.js';
import { setClock } from '../../src/life/clock.js';
import { appendEvent, getEvent, revertEvent, cascadeIds, redactPerson, lastEventId } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { integrate, applyEvent as applyVitalsEvent } from '../../src/life/vitals.js';
import { planDay, blockAt } from '../../src/life/routine.js';
import { encodePayload } from '../../src/life/eventLog.js';
import {
  createInitialState, project, applyAppended, rebuild, advanceTo, positionAt, isOrphaned, isExcluded,
  serializeState, deserializeState, saveSnapshot, loadLatestSnapshot, invalidateSnapshots, pruneSnapshots,
  exclusionSet, SNAPSHOT_KEEP,
} from '../../src/life/projector.js';

const { db } = await setupScratchDb();
const clock = fakeClock(Date.UTC(2026, 9, 26, 1, 0) / 1000); // Mon 26 Oct 2026, 01:00 UTC
setClock(clock.fn);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });

const T0 = clock.now();
const MIN = 60;
const H = 3600;
const GROUP = '120363000000000001@g.us';
const ALICE = '15550000001@s.whatsapp.net';

const json = (s) => JSON.stringify(serializeState(s));
const snapCount = () => db.prepare('SELECT COUNT(*) AS n FROM world_snapshots').get().n;

// Live path: every append is folded into `live` the way the facade will do it.
let live = createInitialState(world);
const add = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  return ev;
};
const at = (min) => T0 + min * MIN;

try {
  section('empty log');
  const empty = rebuild({ world });
  eq('rebuild of an empty log is the initial state', json(empty), json(createInitialState(world)));
  eq('nothing consumed', [empty.lastEventId, empty.genesisAt], [0, null]);

  section('genesis, places, cast');
  const genesis = add({ type: 'genesis', at: T0, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) add({ type: 'place.created', at: T0, actor: 'engine', causeId: genesis.id, payload: p });
  for (const c of world.cast) add({ type: 'cast.created', at: T0, actor: 'engine', causeId: genesis.id, payload: c });
  eq('source from genesis', live.world.source, 'example');
  eq('home from self', [live.self.homePlaceId, live.position.placeId], ['place:home', 'place:home']);
  eq('office from self.job', live.self.officePlaceId, 'place:office');
  eq('age derived from birthdate (1999-04-12 → 27)', live.self.age, 27);
  eq('every place projected', live.places.size, world.places.length);
  eq('every cast member projected', live.cast.size, world.cast.length);
  check('position resolved to the home coordinates', live.position.lat === world.places[0].lat && live.position.lon === world.places[0].lon);
  eq('cast metrics kept', live.cast.get('cast:flatmate').metrics, world.cast[0].metrics);

  section('purity');
  const before = json(live);
  const probe = project(live, { id: 99999, at: at(5), type: 'meal', actor: 'engine', payload: {} }, world);
  eq('project() leaves its input unchanged', json(live), before);
  check('… and returns a new state', probe !== live && probe.lastEventId === 99999 && probe.vitals.hunger === 10);
  throws('project() needs an event id', () => project(live, { at: at(5), type: 'meal' }, world), /positive integer id/);
  throws('project() needs integer at', () => project(live, { id: 99999, at: 1.5, type: 'meal' }, world), /integer at/);

  section('vitals integrate between events');
  const sleepEv = add({ type: 'sleep.started', at: at(0), actor: 'engine' });
  eq('asleep after sleep.started', [live.activity.kind, live.availability.state], ['sleep', 'asleep']);
  const base = live;
  const cp = add({ type: 'vitals.checkpoint', at: at(60), actor: 'engine', payload: { note: 'drift probe' } });
  const expect = applyVitalsEvent(integrate(base.vitals, base.activity, 60, world, { at: base.at, rain: false }), cp, world);
  eq('one event 60 min later = integrate(60) + its jump', live.vitals, expect);
  check('sleeping an hour raised energy', live.vitals.energy > base.vitals.energy);
  const twoStep = project(project(base, { id: 99990, at: at(30), type: 'vitals.checkpoint', actor: 'engine' }, world),
    { id: 99991, at: at(60), type: 'vitals.checkpoint', actor: 'engine' }, world);
  near('two 30-min gaps ≈ one 60-min gap (energy)', twoStep.vitals.energy, live.vitals.energy, 1e-9);
  near('… (hunger)', twoStep.vitals.hunger, live.vitals.hunger, 1e-9);
  const past = project(live, { id: 99992, at: at(10), type: 'vitals.checkpoint', actor: 'engine' }, world);
  eq('an event dated in the past integrates nothing', past.vitals, applyVitalsEvent(live.vitals, { type: 'x' }, world));
  eq('… and never moves the clock back', past.at, live.at);

  section('a morning');
  add({ type: 'woke', at: at(7 * 60), actor: 'engine', causeId: sleepEv.id, payload: { lateBy: 12 } });
  eq('woke → awake, free', [live.activity.kind, live.availability.state, live.sleep.lateBy], ['idle', 'free', 12]);
  eq('woke settles the night counters', live.vitals.night, { awakeMin: 0, sleptMin: 0 });
  add({ type: 'weather.changed', at: at(7 * 60), actor: 'engine', payload: { rain: true, condition: 'light_rain', tempC: 24, until: at(9 * 60) } });
  eq('weather projected', [live.weather.rain, live.weather.tempC], [true, 24]);
  const plan = add({ type: 'plan.made', at: at(7 * 60), actor: 'engine', payload: { date: '2026-10-26', blocks: [
    { kind: 'wfh', placeId: 'place:home', start: at(8 * 60), end: at(12 * 60), availability: 'light' },
    { kind: 'lunch', placeId: 'place:cafe', start: at(12 * 60), end: at(13 * 60), availability: 'free' },
    { kind: 'bogus kind!', start: at(1), end: at(2) },
  ] } });
  eq('plan blocks kept (invalid one dropped)', live.plan.blocks.map(b => b.kind), ['wfh', 'lunch']);
  for (const day of [T0, T0 + 86400]) { // a WFH Monday and an office Tuesday from routine.js
    const real = planDay(live, day, world);
    const stored = JSON.parse(encodePayload(real)); // what the log would hold
    const pp = project(live, { id: 99993, at: real.wakeAt, type: 'plan.made', actor: 'engine', payload: stored }, world).plan;
    eq(`routine ${real.dayType} plan: every block kept`, pp.blocks.length, real.blocks.length);
    eq(`… meta kept (${real.dayType})`, [pp.dayType, pp.wakeAt, pp.sleepAt, pp.nextWakeAt], [real.dayType, real.wakeAt, real.sleepAt, real.nextWakeAt]);
    const commute = real.blocks.find(b => b.kind === 'commute');
    if (commute) {
      const pc = pp.blocks.find(b => b.kind === 'commute');
      eq('… commute trip kept', [pc.from, pc.to, pc.mode, pc.minutes], [commute.from, commute.to, commute.mode, commute.minutes]);
    }
    const mid = real.blocks[Math.floor(real.blocks.length / 2)];
    eq('… blockAt() works on the projected plan', blockAt(pp, mid.start)?.kind, mid.kind);
  }
  const wfh = add({ type: 'activity.started', at: at(8 * 60), actor: 'engine', causeId: plan.id,
    payload: { kind: 'wfh', placeId: 'place:home', end: at(12 * 60), availability: 'light' } });
  eq('activity + availability from the block', [live.activity.kind, live.availability.state, live.availability.until], ['wfh', 'light', at(12 * 60)]);
  add({ type: 'phone.check.started', at: at(9 * 60), actor: 'engine' });
  check('on phone during a check', live.availability.onPhone === true && live.phone.lastCheckAt === at(9 * 60));
  add({ type: 'phone.check.ended', at: at(9 * 60 + 3), actor: 'engine', payload: { nextCheckAt: at(9 * 60 + 20) } });
  eq('check ended', [live.availability.onPhone, live.phone.nextCheckAt], [false, at(9 * 60 + 20)]);
  add({ type: 'activity.ended', at: at(12 * 60), actor: 'engine', causeId: wfh.id, payload: { kind: 'wfh' } });
  eq('ended activity releases its availability', [live.activity.kind, live.availability.state], ['idle', 'free']);
  const trip = add({ type: 'travel.started', at: at(12 * 60), actor: 'engine',
    payload: { from: 'place:home', to: 'place:cafe', mode: 'walk', km: 1, minutes: 20, cost: 0 } });
  eq('travelling: commute, no place', [live.activity.kind, live.position.placeId, live.position.travel.endAt], ['commute', null, at(12 * 60 + 20)]);
  const home = live.places.get('place:home');
  const cafe = live.places.get('place:cafe');
  const mid = positionAt(live, at(12 * 60 + 10));
  near('halfway position (lat)', mid.lat, (home.lat + cafe.lat) / 2, 1e-9);
  check('… flagged travelling', mid.travelling === true);
  add({ type: 'travel.arrived', at: at(12 * 60 + 20), actor: 'engine', causeId: trip.id, payload: { to: 'place:cafe' } });
  eq('arrived at the café', [live.position.placeId, live.position.travel, live.activity.kind], ['place:cafe', null, 'idle']);
  add({ type: 'meal', at: at(12 * 60 + 25), actor: 'engine', payload: { kind: 'lunch', good: true } });
  eq('meal → hunger 10', live.vitals.hunger, 10);
  add({ type: 'availability.changed', at: at(12 * 60 + 30), actor: 'engine', payload: { state: 'dnd', until: at(13 * 60) } });
  eq('availability.changed', [live.availability.state, live.availability.until], ['dnd', at(13 * 60)]);
  add({ type: 'availability.changed', at: at(12 * 60 + 31), actor: 'engine', payload: { state: 'partying' } });
  eq('unknown availability state ignored', live.availability.state, 'dnd');
  const salaryBefore = live.vitals.money;
  add({ type: 'money.salary', at: at(12 * 60 + 31), actor: 'engine', payload: { amount: 1000 } });
  near('salary credited', live.vitals.money, salaryBefore + 1000, 1e-6);

  section('decisions');
  const dec = add({ type: 'decision.opened', at: at(13 * 60), actor: 'engine', payload: {
    kind: 'evening', subject: { eventAt: at(19 * 60), placeId: 'place:restaurant', castIds: ['cast:flatmate', 'cast:nobody!'] },
    decideBy: at(18 * 60), ponrAt: at(18 * 60 + 30),
    options: [{ id: 'go', label: 'Go out', cost: { energy: 10, money: 500 } }, { id: 'stay', label: 'Stay in', cost: {} }],
  } });
  const d0 = live.decisions.get(dec.id);
  eq('decision id = opened event id, status open', [d0.id, d0.status, d0.mode], [dec.id, 'open', 'auto']);
  eq('subject cast ids validated', d0.subject.castIds, ['cast:flatmate']);
  eq('cost vector filled', d0.options[1].cost, { energy: 0, money: 0, social: 0, stress: 0, travelMin: 0 });
  const jevBefore = live.counters.jevToday;
  const lean = add({ type: 'decision.lean', at: at(13 * 60 + 5), actor: 'jev', causeId: dec.id,
    payload: { decisionId: dec.id, optionId: 'go', p: 0.6, probs: { go: 0.6, stay: 0.4 }, trigger: 'state_shift' } });
  const d1 = live.decisions.get(dec.id);
  eq('lean recorded with the state at lean time', [d1.lean.optionId, d1.lean.by, d1.lean.state.energy], ['go', 'jev', live.vitals.energy]);
  eq('Jev events counted for the day', live.counters.jevToday, jevBefore + 1);
  add({ type: 'decision.lean', at: at(13 * 60 + 6), actor: 'engine', payload: { decisionId: dec.id, optionId: 'fly' } });
  eq('lean to an unknown option ignored', live.decisions.get(dec.id).lean.eventId, lean.id);
  const trig = add({ type: 'chat.trigger', at: at(14 * 60), actor: 'chat', originKind: 'group', originJid: GROUP,
    payload: { decisionId: dec.id, toward: 'stay' } });
  eq('chat trigger taints the decision with its origin', live.decisions.get(dec.id).origins, [{ kind: 'group', jid: GROUP }]);
  eq('… and is kept as a signal', live.decisions.get(dec.id).signals.map(x => x.toward), ['stay']);
  add({ type: 'decision.lean', at: at(14 * 60 + 1), actor: 'jev', causeId: trig.id, payload: { decisionId: dec.id, optionId: 'stay', p: 0.85 } });
  check('a lean caused by a chat inherits its origin', live.decisions.get(dec.id).origins.length === 1);
  add({ type: 'decision.committed', at: at(14 * 60 + 2), actor: 'engine', causeId: trig.id,
    payload: { decisionId: dec.id, optionId: 'stay', p: 0.85, wanted: true } });
  eq('committed', [live.decisions.get(dec.id).status, live.decisions.get(dec.id).committed.optionId], ['committed', 'stay']);
  const tension0 = live.cast.get('cast:flatmate').metrics.tension;
  const stress0 = live.vitals.stress;
  add({ type: 'decision.reversed', at: at(15 * 60), actor: 'jev', causeId: trig.id, payload: { decisionId: dec.id, from: 'stay', to: 'go' } });
  const d2 = live.decisions.get(dec.id);
  eq('reversed to go', [d2.committed.optionId, d2.reversals], ['go', 1]);
  near('tension on involved cast +0.1', live.cast.get('cast:flatmate').metrics.tension, tension0 + 0.1, 1e-9);
  check('reversal stress applied', live.vitals.stress > stress0);
  add({ type: 'decision.mode_set', at: at(15 * 60 + 1), actor: 'owner', payload: { decisionId: dec.id, mode: 'ask' } });
  eq('owner mode set', live.decisions.get(dec.id).mode, 'ask');
  const dec2 = add({ type: 'decision.opened', at: at(15 * 60 + 2), actor: 'engine',
    payload: { kind: 'gym', options: [{ id: 'gym' }, { id: 'rest' }] } });
  add({ type: 'decision.expired', at: at(16 * 60), actor: 'engine', causeId: dec2.id, payload: { decisionId: dec2.id } });
  eq('expired', live.decisions.get(dec2.id).status, 'expired');
  add({ type: 'decision.opened', at: at(16 * 60), actor: 'engine', payload: { kind: 'empty', options: [] } });
  eq('a decision without options is not opened', live.decisions.size, 2);

  section('embargo, alerts, calls, claims, birthdays, unknown and redacted events');
  const heavyEv = add({ type: 'work.crunch', at: at(16 * 60 + 5), actor: 'engine', heavy: true, payload: { amount: 10 } });
  add({ type: 'embargo.started', at: heavyEv.at, actor: 'engine', causeId: heavyEv.id, payload: { until: heavyEv.at + 12 * H, heavyEventId: heavyEv.id } });
  add({ type: 'alert.raised', at: heavyEv.at, actor: 'engine', causeId: heavyEv.id, payload: { kind: 'embargo' } });
  eq('embargo projected', live.embargo?.until, heavyEv.at + 12 * H);
  eq('alert kept', live.alerts.map(a => a.kind), ['embargo']);
  add({ type: 'call.answered', at: at(16 * 60 + 10), actor: 'engine', originKind: 'call', originJid: ALICE, subjectJid: ALICE });
  eq('call recorded without the caller id', Object.keys(live.lastCall).sort(), ['at', 'eventId', 'originKind']);
  add({ type: 'claim.flagged', at: at(16 * 60 + 11), actor: 'chat', originKind: 'dm', originJid: ALICE, payload: { claimId: 1 } });
  eq('claims counted', live.claims.flagged, 1);
  add({ type: 'birthday', at: at(16 * 60 + 12), actor: 'engine', payload: { castId: 'cast:flatmate' } });
  eq('cast birthday', live.cast.get('cast:flatmate').lastBirthdayAt, at(16 * 60 + 12));
  const n0 = live.lastEventId;
  const odd = project(live, { id: n0 + 100, at: at(16 * 60 + 13), type: 'arc.started', actor: 'mind', payload: { x: 1 } }, world);
  eq('unknown type only advances bookkeeping', odd.lastEventId, n0 + 100);
  const red = project(live, { id: n0 + 101, at: at(16 * 60 + 13), type: 'cast.created', actor: 'engine', payload: { redacted: true } }, world);
  eq('redacted cast.created adds no one', red.cast.size, live.cast.size);
  for (const type of ['place.created', 'plan.made', 'activity.started', 'travel.started', 'travel.arrived', 'decision.opened',
    'decision.lean', 'decision.committed', 'decision.reversed', 'weather.changed', 'woke', 'sick.started', 'embargo.started']) {
    let ok = true;
    try { project(live, { id: n0 + 102, at: at(16 * 60 + 14), type, actor: 'engine', payload: { redacted: true } }, world); } catch { ok = false; }
    if (!ok) check(`redacted ${type} does not throw`, false);
  }
  check('redacted payloads never throw', true);
  add({ type: 'sick.started', at: at(17 * 60), actor: 'engine', payload: { days: 2, until: at(17 * 60) + 2 * 86400 } });
  check('sick flag + record', live.vitals.sick === true && live.sick.days === 2);
  add({ type: 'sick.ended', at: at(18 * 60), actor: 'engine' });
  check('sick ended', live.vitals.sick === false && live.sick === null);

  section('live fold ≡ replay; serialization');
  const full = rebuild({ world, useSnapshot: false });
  eq('incremental state equals a full replay', json(live), json(full));
  eq('replay is deterministic', json(rebuild({ world, useSnapshot: false })), json(full));
  const round = deserializeState(JSON.parse(json(full)));
  eq('serialize → deserialize round trip', json(round), json(full));
  check('Maps and Sets survive', round.places instanceof Map && round.decisions instanceof Map && round.excluded instanceof Set);
  throws('wrong snapshot version refused', () => deserializeState({ ...JSON.parse(json(full)), v: 999 }), /version/);

  section('views');
  const view = advanceTo(live, live.at + 2 * H, world);
  check('view integrates vitals forward', view.vitals.hunger > live.vitals.hunger && view.view === true);
  eq('… without touching the state', json(live), json(full));
  throws('project() refuses a view', () => project(view, { id: n0 + 200, at: view.viewAt, type: 'meal', actor: 'engine' }, world), /view/);
  throws('advanceTo() refuses a view', () => advanceTo(view, view.viewAt + 60, world), /view/);
  throws('a view cannot be snapshotted', () => saveSnapshot(view), /view/);

  section('snapshots');
  const snapAt = live.lastEventId;
  const snapId = saveSnapshot(live);
  check('snapshot written', Number.isInteger(snapId) && snapCount() === 1);
  eq('same upto → same snapshot', saveSnapshot(live), snapId);
  const loaded = loadLatestSnapshot();
  eq('loaded snapshot matches the state', [loaded.uptoEventId, json(loaded.state)], [snapAt, json(live)]);
  // More of the day after the snapshot.
  add({ type: 'activity.started', at: at(19 * 60), actor: 'engine', payload: { kind: 'eat-out', placeId: 'place:restaurant', withCast: ['cast:flatmate'], availability: 'light' } });
  add({ type: 'money.spent', at: at(20 * 60), actor: 'engine', payload: { amount: 450 } });
  add({ type: 'activity.ended', at: at(21 * 60), actor: 'engine', payload: { kind: 'eat-out' } });
  const fromSnap = rebuild({ world });
  const fromScratch = rebuild({ world, useSnapshot: false });
  eq('snapshot + replay ≡ full replay', json(fromSnap), json(fromScratch));
  eq('… ≡ live fold', json(live), json(fromScratch));
  eq('loadLatestSnapshot(before) skips newer ones', loadLatestSnapshot({ beforeEventId: snapAt }), null);
  db.prepare("INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, '{not json')").run(live.lastEventId, live.at);
  eq('an unreadable snapshot is skipped', loadLatestSnapshot().uptoEventId, snapAt);
  eq('… and rebuild still matches', json(rebuild({ world })), json(fromScratch));
  db.prepare('DELETE FROM world_snapshots WHERE upto_event_id = ?').run(live.lastEventId);

  section('revert cascade');
  // A(engine) → B(engine, money) → C(jev) → D(chat) → E(owner) ; D → F(engine): only A,B,C go.
  const A = add({ type: 'decision.opened', at: at(21 * 60 + 5), actor: 'engine', payload: { kind: 'late-snack', options: [{ id: 'order' }, { id: 'skip' }] } });
  const B = add({ type: 'money.spent', at: at(21 * 60 + 6), actor: 'engine', causeId: A.id, payload: { amount: 500 } });
  const C = add({ type: 'decision.lean', at: at(21 * 60 + 7), actor: 'jev', causeId: B.id, payload: { decisionId: A.id, optionId: 'order', p: 0.7 } });
  const D = add({ type: 'chat.trigger', at: at(21 * 60 + 8), actor: 'chat', causeId: C.id, originKind: 'group', originJid: GROUP, payload: { decisionId: A.id } });
  const E = add({ type: 'decision.mode_set', at: at(21 * 60 + 9), actor: 'owner', causeId: D.id, payload: { decisionId: A.id, mode: 'ask' } });
  const F = add({ type: 'meal', at: at(21 * 60 + 10), actor: 'engine', causeId: D.id, payload: { kind: 'snack', hunger: 15 } });
  const moneyWith = live.vitals.money;
  check('before the revert the decision and spend are in', live.decisions.has(A.id) && live.decisions.get(A.id).mode === 'ask');
  const snapBeforeRevert = saveSnapshot(live);
  const staleJson = db.prepare('SELECT state_json FROM world_snapshots WHERE id = ?').get(snapBeforeRevert).state_json;
  const rev = revertEvent(A.id, { reason: 'owner undo', at: at(21 * 60 + 20) });
  check('revertEvent invalidated the later snapshot', rev.snapshotsInvalidated >= 1 && !db.prepare('SELECT 1 FROM world_snapshots WHERE id = ?').get(snapBeforeRevert));
  const prevLive = live;
  live = applyAppended(live, getEvent(rev.revertEventId), { world });
  check('a live revert rebuilt the projection', live !== prevLive && !live.rebuildNeeded);
  eq('excluded = target + engine/jev descendants', [...live.excluded].sort((a, b) => a - b), [A.id, B.id, C.id]);
  eq('… the same set eventLog.cascadeIds walks', cascadeIds(A.id), [A.id, B.id, C.id]);
  eq('exclusionSet() over the log agrees', [...exclusionSet()].sort((a, b) => a - b), [A.id, B.id, C.id]);
  check('reverted decision gone', !live.decisions.has(A.id));
  near('reverted spend no longer subtracted', live.vitals.money, moneyWith + 500, 1e-6);
  check('chat trigger D is orphaned, not excluded', isOrphaned(D, live.excluded) && !isExcluded(live, D));
  check('owner E is kept (its cause D was not reverted)', !isOrphaned(E, live.excluded) && !isExcluded(live, E));
  check('engine F caused by the chat event still applies', live.lastMeal?.eventId === F.id && live.vitals.hunger <= 15 + 1);
  check('engine B is excluded, not orphaned', isExcluded(live, B) && !isOrphaned(B, live.excluded));
  eq('live after revert ≡ full replay', json(live), json(rebuild({ world, useSnapshot: false })));
  eq('a revert does not move the integration anchor', live.at, F.at);
  const hungerAtF = live.vitals.hunger;
  eq('reverting again returns the same revert', revertEvent(A.id).revertEventId, rev.revertEventId);
  // A descendant appended after the revert is excluded too.
  const G = add({ type: 'money.spent', at: at(21 * 60 + 30), actor: 'engine', causeId: B.id, payload: { amount: 77 } });
  check('engine event caused by an excluded one is excluded on arrival', live.excluded.has(G.id));
  const N = add({ type: 'vitals.checkpoint', at: at(21 * 60 + 40), actor: 'engine' });
  near('the gap across the revert is integrated (30 awake min ≈ +3.5 hunger)', live.vitals.hunger - hungerAtF, 3.5, 0.6);
  eq('… anchor now at the next real event', live.at, N.at);
  near('… and does not spend', live.vitals.money, rebuild({ world, useSnapshot: false }).vitals.money, 1e-9);
  eq('incremental ≡ replay after the late descendant', json(live), json(rebuild({ world, useSnapshot: false })));

  section('stale snapshot fallback');
  // A snapshot that folded A..F but predates the revert (as if invalidation was missed).
  db.prepare('INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, ?)')
    .run(JSON.parse(staleJson).lastEventId, JSON.parse(staleJson).at, staleJson);
  const recovered = rebuild({ world });
  eq('stale snapshot is not trusted: rebuild ≡ full replay', json(recovered), json(rebuild({ world, useSnapshot: false })));
  check('… and the stale row was deleted', !db.prepare('SELECT 1 FROM world_snapshots WHERE upto_event_id = ?').get(JSON.parse(staleJson).lastEventId));
  const goodSnap = saveSnapshot(live);
  add({ type: 'meal', at: at(22 * 60), actor: 'engine', payload: { kind: 'dinner' } });
  eq('after a fresh snapshot, snapshot + replay ≡ full', json(rebuild({ world })), json(rebuild({ world, useSnapshot: false })));
  check('the fresh snapshot is used', loadLatestSnapshot().id === goodSnap);

  section('redaction');
  const dm = add({ type: 'chat.trigger', at: at(22 * 60 + 5), actor: 'chat', originKind: 'dm', originJid: ALICE, payload: { note: 'x' } });
  saveSnapshot(live);
  const r = redactPerson(ALICE);
  check('redaction hit the DM trigger and the call', r.events >= 2);
  const afterRedact = rebuild({ world });
  eq('rebuild after redaction ≡ full replay', json(afterRedact), json(rebuild({ world, useSnapshot: false })));
  check('no snapshot still mentions the person', !db.prepare('SELECT 1 FROM world_snapshots WHERE instr(state_json, ?) > 0').get(ALICE));
  check('the redacted event still advances the projection', afterRedact.lastEventId >= dm.id);
  live = afterRedact;

  section('invalidate + retention');
  saveSnapshot(live);
  eq('invalidate from an event id', invalidateSnapshots({ fromEventId: live.lastEventId }) >= 1, true);
  eq('invalidate with no bound is a no-op', invalidateSnapshots({}), 0);
  saveSnapshot(live);
  eq('invalidate from a world time after it keeps it', invalidateSnapshots({ fromAt: live.at + 1 }), 0);
  eq('invalidate from a world time at it removes it', invalidateSnapshots({ fromAt: live.at }), 1);
  db.prepare('DELETE FROM world_snapshots').run();
  const DAY = 86400;
  const start = Date.UTC(2026, 0, 15, 12) / 1000; // 15 Jan
  const ins = db.prepare("INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, '{}')");
  for (let i = 0; i < 40; i++) ins.run(i + 1, start + i * 7 * DAY); // weekly, ~9 months
  const deleted = pruneSnapshots({ timezone: 'UTC' });
  const kept = db.prepare('SELECT upto_event_id AS id, at FROM world_snapshots ORDER BY upto_event_id DESC').all();
  const newest = kept.slice(0, SNAPSHOT_KEEP).map(k => k.id);
  eq('newest 14 kept', newest, Array.from({ length: 14 }, (_, i) => 40 - i));
  const older = kept.slice(SNAPSHOT_KEEP);
  const monthsOlder = older.map(k => new Date(k.at * 1000).toISOString().slice(0, 7));
  eq('one per month among the older ones', monthsOlder.length, new Set(monthsOlder).size);
  const allOlderMonths = new Set(Array.from({ length: 26 }, (_, i) => new Date((start + i * 7 * DAY) * 1000).toISOString().slice(0, 7)));
  eq('… covering every older month', monthsOlder.length, allOlderMonths.size);
  eq('deleted count adds up', deleted + kept.length, 40);
  db.prepare('DELETE FROM world_snapshots').run();

  section('replay speed');
  // ~30 days × ~10 events on top of the log: a full replay stays well under SC-008.
  let t = live.at + 600;
  for (let day = 0; day < 30; day++) {
    for (const [type, payload] of [
      ['woke', { lateBy: 0 }], ['activity.started', { kind: 'wfh', availability: 'light' }], ['meal', {}],
      ['activity.ended', { kind: 'wfh' }], ['phone.check.started', {}], ['phone.check.ended', {}],
      ['activity.started', { kind: 'gym', availability: 'busy' }], ['activity.ended', { kind: 'gym' }], ['meal', {}],
      ['sleep.started', {}],
    ]) { appendEvent({ type, at: t, actor: 'engine', payload }); t += 90 * MIN; }
    t += 9 * H;
  }
  const t1 = performance.now();
  const big = rebuild({ world, useSnapshot: false });
  const ms = performance.now() - t1;
  check(`full replay of ${lastEventId()} events in ${Math.round(ms)} ms (< 1000)`, ms < 1000);
  check('vitals stay in range over the month', big.vitals.energy >= 0 && big.vitals.energy <= 100 && big.vitals.hunger <= 100);
} finally {
  setClock(null);
}

report();
