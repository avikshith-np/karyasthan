// T017 — timed decisions (src/life/decisions.js): deadlines from travel + prep,
// code costs → U → softmax, expiry, then the lifecycle on a scratch DB with the
// projection folded live: no Jev without a trigger; each trigger (new_info,
// state_shift, chat_mention, deadline_near) → exactly one call with the right
// cause; early commit, deadline sample, reversal + tension/stress, expiry,
// Jev error / garbage / budget fallbacks (actor engine), owner mode, cancel,
// chat origin taint and no chat text reaching Jev. Fake clock, mocked Jev.
import { setupScratchDb, fakeClock, fakeJev, jevChoice, section, check, eq, near, throws, rejects, report } from './_helpers.js';
import { setClock, zonedToUnix, dateKey } from '../../src/life/clock.js';
import { rngFor } from '../../src/life/rng.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild } from '../../src/life/projector.js';
import { config } from '../../src/utils/config.js';
import { BudgetError } from '../../src/brain/usage.js';
import {
  setJev, resetDecisionCounters, deadlines, nearTime, tripFor, optionCost, utilities, softmax, weightsFor,
  availableOptions, restrictProbs, sampleOption, detectTriggers, matchChat, jevUsedToday,
  openDecision, evaluate, noteChat, setMode, cancelDecision, REVERSE_P,
} from '../../src/life/decisions.js';

const { db } = await setupScratchDb();
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (h, m = 0, day = 26) => zonedToUnix(2026, 10, day, h, m, tz); // Mon 26 Oct 2026
const clock = fakeClock(local(17));
setClock(clock.fn);

const MIN = 60;
const GROUP = '120363000000000001@g.us';
const DM = '15550000001@s.whatsapp.net';
const FLATMATE = 'cast:flatmate';

// Facade-style append: store, then fold into the live projection.
let live = createInitialState(world);
const appended = [];
const append = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  appended.push(ev);
  return ev;
};
const getState = () => live;
const ctxAt = (at, extra = {}) => ({ world, at, append, ...extra });

let answer = () => ({ pick: jevChoice('go', { go: 0.6, stay: 0.4 }) });
const jev = fakeJev((req, i) => answer(req, i));
setJev(jev.fn);
const origBudget = config.life.jevMaxPerDay;

const movieSpec = (eventAt, extra = {}) => ({
  kind: 'movie',
  subject: { eventAt, placeId: 'place:cinema', castIds: [FLATMATE], minutes: 150 },
  options: [
    { id: 'go', label: 'Go to the movie with the flatmate', go: true, kind: 'movie', spend: 300, fun: 6 },
    { id: 'late', label: 'Join late for the second half', go: 'late', kind: 'movie', minutes: 75, spend: 300, fun: 3 },
    { id: 'stay', label: 'Stay in and rest', kind: 'rest' },
  ],
  ...extra,
});

async function open(spec, at = clock.now(), extra = {}) {
  const r = await openDecision(getState, spec, ctxAt(at, extra));
  return { ...r, id: r.decision.id, d: () => live.decisions.get(r.decision.id) };
}

try {
  // ── Genesis ──────────────────────────────────────────────────────────────
  const T0 = clock.now();
  const genesis = append({ type: 'genesis', at: T0, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) append({ type: 'place.created', at: T0, actor: 'engine', causeId: genesis.id, payload: p });
  for (const c of world.cast) append({ type: 'cast.created', at: T0, actor: 'engine', causeId: genesis.id, payload: c });
  check('genesis projected at home', live.position.placeId === 'place:home' && live.cast.has(FLATMATE));

  // ── Pure: deadlines ──────────────────────────────────────────────────────
  section('deadlines = eventAt − travel − prep; ponr = eventAt − travel');
  const show = local(21);
  const heard = local(18);
  const dl = deadlines({ eventAt: show, placeId: 'place:cinema', from: 'place:home', at: heard, prepMin: 20 }, world);
  const trip = tripFor('place:home', 'place:cinema', show, null, world);
  check('real trip home → cinema', trip.minutes > 0 && trip.km > 0, trip);
  eq('travelMin from travel.js at the departure time', dl.travelMin, trip.minutes);
  eq('ponrAt = eventAt − travel', dl.ponrAt, show - trip.minutes * MIN);
  eq('decideBy = eventAt − travel − prep', dl.decideBy, show - trip.minutes * MIN - 20 * MIN);
  eq('nearAt = decideBy − max(30 min, 20% window)', dl.nearAt, dl.decideBy - Math.max(30 * MIN, Math.round(0.2 * (dl.decideBy - heard))));
  const dflt = deadlines({ eventAt: show, placeId: 'place:cinema', from: 'place:home', at: heard }, world);
  eq('prep defaults to routine.prepMinutes (20)', dflt.prepMin, 20);
  const peakTrip = tripFor('place:home', 'place:office', local(19), null, world);
  const offTrip = tripFor('place:home', 'place:office', local(22), null, world);
  check('departure inside the evening peak takes longer', peakTrip.minutes > offTrip.minutes, [peakTrip.minutes, offTrip.minutes]);
  const late = deadlines({ eventAt: show, placeId: 'place:cinema', from: 'place:home', at: show - 5 * MIN, prepMin: 20 }, world);
  eq('heard too late → decideBy is now', late.decideBy, show - 5 * MIN);
  check('… and ponr already passed', late.ponrAt < show - 5 * MIN);
  const here = deadlines({ eventAt: show, placeId: null, from: 'place:home', at: heard, prepMin: 0 }, world);
  eq('no place → no travel, ponr = event', [here.travelMin, here.ponrAt, here.decideBy], [0, show, show]);
  const rainy = deadlines({ eventAt: show, placeId: 'place:cinema', from: 'place:home', at: heard, prepMin: 20, weather: { rain: true } }, world);
  eq('rain → cab trip', rainy.trip.mode, 'cab');
  eq('nearTime with a short window uses 30 min', nearTime(1000000, 1000000 + 600), 1000000 + 600 - 1800);
  throws('eventAt must be an integer', () => deadlines({ eventAt: 1.5, at: heard }, world), /eventAt/);

  // ── Pure: costs and utility ──────────────────────────────────────────────
  section('costs → U → softmax');
  const goCost = optionCost({ kind: 'movie', minutes: 150, go: true, spend: 300, fun: 6 }, trip, world);
  const stayCost = optionCost({ kind: 'rest', minutes: 150 }, null, world);
  eq('go travels both ways', goCost.travelMin, 2 * trip.minutes);
  near('go money = spend + two trip costs', goCost.money, 300 + 2 * trip.cost, 0.011);
  check('go drains energy and the social battery', goCost.energy > 0 && goCost.social > 0, goCost);
  eq('stay has no travel or money', [stayCost.travelMin, stayCost.money], [0, 0]);
  check('stay gives energy and battery back', stayCost.energy < 0 && stayCost.social < 0, stayCost);
  check('fun lowers the stress cost', optionCost({ kind: 'movie', minutes: 150, go: true, fun: 6 }, trip, world).stress
    < optionCost({ kind: 'movie', minutes: 150, go: true }, trip, world).stress);

  const fakeD = {
    kind: 'movie', subject: { castIds: [FLATMATE] },
    options: [{ id: 'go', label: 'go', cost: goCost, expiresAt: null }, { id: 'stay', label: 'stay', cost: stayCost, expiresAt: null }],
  };
  const rested = { vitals: { energy: 85, socialBattery: 75, stress: 30, money: 40000, sick: false }, weather: null, cast: live.cast };
  const tired = { vitals: { energy: 25, socialBattery: 30, stress: 55, money: 40000, sick: false }, weather: null, cast: live.cast };
  const pRested = softmax(utilities(fakeD, rested, world));
  const pTired = softmax(utilities(fakeD, tired, world));
  near('softmax sums to 1', Object.values(pRested).reduce((a, b) => a + b, 0), 1, 1e-9);
  check('rested → leans toward going', pRested.go > 0.5, pRested);
  check('tired after work → probably not', pTired.stay > 0.8, pTired);
  check('rain makes travel weigh more', weightsFor({ ...rested, weather: { rain: true } }, world).travelMin > weightsFor(rested, world).travelMin);
  check('low balance makes money weigh more', weightsFor({ vitals: { ...rested.vitals, money: 1000 } }, world).money > weightsFor(rested, world).money);
  const lowTension = utilities(fakeD, rested, world).go;
  const tense = new Map(live.cast);
  tense.set(FLATMATE, { ...tense.get(FLATMATE), metrics: { closeness: 0.2, trust: 0.2, tension: 0.8 } });
  check('tension with the cast lowers going', utilities(fakeD, { ...rested, cast: tense }, world).go < lowTension);
  check('a chat push adds to the fallback U', utilities(fakeD, rested, world, { pushed: 'stay' }).stay > utilities(fakeD, rested, world).stay);

  section('expiry, restrict, sample');
  const expD = { options: [{ id: 'a', expiresAt: 100 }, { id: 'b', expiresAt: null }, { id: 'c', expiresAt: 300 }] };
  eq('expired options are not available', availableOptions(expD, 100).map(o => o.id), ['b', 'c']);
  eq('restrict drops unknown/expired ids and renormalizes', restrictProbs({ a: 0.5, b: 0.25, c: 0.25, zz: 9 }, ['b', 'c']), { b: 0.5, c: 0.5 });
  eq('nothing usable → null', restrictProbs({ x: 1 }, ['b']), null);
  eq('sample: low roll → first', sampleOption({ b: 0.5, c: 0.5 }, ['b', 'c'], () => 0), 'b');
  eq('sample: high roll → last', sampleOption({ b: 0.5, c: 0.5 }, ['b', 'c'], () => 0.99), 'c');
  eq('sample skips zero-probability options', sampleOption({ b: 0, c: 1 }, ['b', 'c'], () => 0), 'c');

  // ── Open + early commit ──────────────────────────────────────────────────
  section('open → one Jev call (new_info) → early commit at p ≥ commitP');
  clock.set(heard);
  jev.reset();
  answer = () => ({ pick: jevChoice('go', { go: 0.9, late: 0.05, stay: 0.05 }) });
  const A = await open(movieSpec(show));
  eq('events: opened, lean, committed', A.events.map(e => e.type), ['decision.opened', 'decision.lean', 'decision.committed']);
  const [aOpen, aLean, aCommit] = A.events;
  eq('one Jev call', jev.calls.length, 1);
  eq('opened by the engine', aOpen.actor, 'engine');
  eq('stored decideBy/ponrAt', [aOpen.payload.decideBy, aOpen.payload.ponrAt], [dl.decideBy, dl.ponrAt]);
  eq('go expires at ponr, late at the event end, stay never', aOpen.payload.options.map(o => o.expiresAt), [dl.ponrAt, show + 150 * MIN, null]);
  eq('lean by Jev, caused by the opening', [aLean.actor, aLean.causeId, aLean.payload.trigger], ['jev', aOpen.id, 'new_info']);
  eq('lean = argmax', [aLean.payload.optionId, aLean.payload.p], ['go', 0.9]);
  eq('commit by the engine, caused by the lean', [aCommit.actor, aCommit.causeId], ['engine', aLean.id]);
  eq('early commit is not sampled', [aCommit.payload.optionId, aCommit.payload.sampled], ['go', false]);
  eq('projection: committed', [A.d().status, A.d().committed.optionId], ['committed', 'go']);
  const q = jev.calls[0];
  eq('Jev question is a choice over the options', Object.keys(q.questions.pick.criteria), ['go', 'late', 'stay']);
  eq('Jev call labelled for the 007 ledger', q.caller, 'life.decision');
  check('Jev state is compact numbers + option costs', typeof q.state.energy === 'number' && q.state.options.length === 3
    && typeof q.state.options[0].utility === 'number' && q.state.options[0].travelMin === aOpen.payload.options[0].cost.travelMin);
  eq('jevToday counts the Jev lean', live.counters.jevToday, 1);
  await cancelDecision(getState, A.id, { at: clock.now(), append }); // committed: not cancellable
  eq('cancel on a committed decision is a no-op', A.d().status, 'committed');

  // ── No trigger → no Jev; deadline_near once; deadline sample ─────────────
  section('ticks without a trigger never call Jev; deadline_near fires once; deadline samples');
  // A fresh decision (the first one stays committed; it only re-checks on triggers).
  jev.reset();
  answer = () => ({ pick: jevChoice('stay', { go: 0.35, late: 0.05, stay: 0.6 }) });
  const showB = local(22);
  const B = await open(movieSpec(showB), heard + 5 * MIN);
  eq('opened + lean, no commit at p 0.6', B.events.map(e => e.type), ['decision.opened', 'decision.lean']);
  eq('one call at open', jev.calls.length, 1);
  const bOpen = B.events[0];
  const bNear = nearTime(bOpen.payload.opensAt, bOpen.payload.decideBy);
  let calls = jev.calls.length;
  let t = heard + 15 * MIN;
  let quiet = 0;
  for (; t < bNear; t += 15 * MIN) {
    clock.set(t);
    const r = await evaluate(getState, ctxAt(t, { newEvents: [] }));
    quiet += r.events.filter(e => e.payload?.decisionId === B.id).length;
  }
  eq('no Jev calls while nothing changes', jev.calls.length, calls);
  eq('no events for the decision either', quiet, 0);
  clock.set(bNear);
  let r = await evaluate(getState, ctxAt(bNear, { newEvents: [] }));
  const nearLean = r.events.find(e => e.type === 'decision.lean' && e.payload.decisionId === B.id);
  eq('deadline_near → one call', jev.calls.length, calls + 1);
  eq('lean trigger deadline_near, caused by the decision', [nearLean?.payload.trigger, nearLean?.causeId, nearLean?.actor], ['deadline_near', B.id, 'jev']);
  calls = jev.calls.length;
  r = await evaluate(getState, ctxAt(bNear + 10 * MIN, { newEvents: [] }));
  eq('deadline_near does not fire twice', jev.calls.length, calls);
  const decideB = bOpen.payload.decideBy;
  const tick = decideB + 7 * MIN; // the tick lands after decideBy
  clock.set(tick);
  r = await evaluate(getState, ctxAt(tick, { newEvents: [] }));
  const bCommit = r.events.find(e => e.type === 'decision.committed' && e.payload.decisionId === B.id);
  eq('no Jev at the deadline', jev.calls.length, calls);
  check('deadline commit happened', !!bCommit);
  eq('sampled, by the engine, caused by the latest lean', [bCommit.payload.sampled, bCommit.actor, bCommit.causeId], [true, 'engine', nearLean.id]);
  eq('dated decideBy, not the tick', bCommit.at, decideB);
  const expectRng = rngFor(dateKey(decideB, live.world.timezone), `decision:${B.id}:commit`);
  eq('sample is the keyed, replayable roll', bCommit.payload.optionId,
    sampleOption({ go: 0.35, late: 0.05, stay: 0.6 }, ['go', 'late', 'stay'], expectRng));
  eq('projection: committed', live.decisions.get(B.id).status, 'committed');

  // ── state_shift ──────────────────────────────────────────────────────────
  section('state_shift: sick flips / stress +16 → one call');
  const dayC = 27;
  clock.set(local(9, 0, dayC));
  jev.reset();
  const C = await open(movieSpec(local(21, 0, dayC)), clock.now());
  calls = jev.calls.length;
  clock.advance({ minutes: 5 });
  const sick = append({ type: 'sick.started', at: clock.now(), actor: 'engine', payload: { until: clock.now() + 86400, days: 1 } });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [sick] }));
  const shiftLean = r.events.find(e => e.type === 'decision.lean' && e.payload.decisionId === C.id);
  eq('one call on the sick flip', jev.calls.length, calls + 1);
  eq('trigger state_shift, caused by the decision', [shiftLean?.payload.trigger, shiftLean?.causeId], ['state_shift', C.id]);
  calls = jev.calls.length;
  clock.advance({ minutes: 15 });
  await evaluate(getState, ctxAt(clock.now(), { newEvents: [] }));
  eq('no repeat once the lean caught up', jev.calls.length, calls);
  const l1 = append({ type: 'work.late', at: clock.now(), actor: 'engine', payload: {} });
  const l2 = append({ type: 'work.late', at: clock.now(), actor: 'engine', payload: {} });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [l1, l2] }));
  eq('stress +16 → one call', jev.calls.length, calls + 1);
  eq('… as state_shift', r.events.find(e => e.type === 'decision.lean')?.payload.trigger, 'state_shift');
  calls = jev.calls.length;

  // ── new_info ─────────────────────────────────────────────────────────────
  section('new_info: an event linked to the subject → one call caused by it');
  const unrelated = append({ type: 'vitals.checkpoint', at: clock.now(), actor: 'engine', payload: {} });
  await evaluate(getState, ctxAt(clock.now(), { newEvents: [unrelated] }));
  eq('an unrelated event is not a trigger', jev.calls.length, calls);
  const info = append({ type: 'activity.started', at: clock.now(), actor: 'engine',
    payload: { kind: 'tv', placeId: 'place:home', withCast: [FLATMATE] } });
  const info2 = append({ type: 'travel.arrived', at: clock.now(), actor: 'engine', payload: { to: 'place:cinema' } });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [info, info2] }));
  const infoLean = r.events.find(e => e.type === 'decision.lean' && e.payload.decisionId === C.id);
  eq('two linked events, still one call', jev.calls.length, calls + 1);
  eq('trigger new_info, caused by the latest linked event', [infoLean?.payload.trigger, infoLean?.causeId], ['new_info', info2.id]);
  const d0 = { ...structuredClone(live.decisions.get(C.id)) };
  eq('pure detectTriggers: nothing new → []', detectTriggers(d0, live, { at: clock.now(), newEvents: [] }), []);
  calls = jev.calls.length;

  // ── chat_mention ─────────────────────────────────────────────────────────
  section('chat_mention: code matcher → chat.trigger (chat origin) → one call; text never sent');
  eq('matcher: unrelated text', matchChat(live.decisions.get(C.id), 'what is for lunch', live), null);
  eq('matcher: option words alone are not a mention', matchChat(live.decisions.get(C.id), 'running late, need rest', live), null);
  eq('matcher: unique option word picks it', matchChat(live.decisions.get(C.id), 'just join the movie for the second half', live), { toward: 'late' });
  eq('matcher: a cast name is a mention', matchChat(live.decisions.get(C.id), 'ask the flatmate', live), { toward: null });
  eq('matcher: shared word + go cue → go option', matchChat(live.decisions.get(C.id), "let's go to the movie!", live), { toward: 'go' });
  eq('matcher: "can\'t wait" is not a stay cue', matchChat(live.decisions.get(C.id), "can't wait for the movie", live), { toward: null });
  eq('matcher: stay cue → stay option', matchChat(live.decisions.get(C.id), "skip the movie, you're tired", live), { toward: 'stay' });
  const secret = 'SECRET-TEXT come to the movie tonight';
  r = await noteChat(getState, { text: secret, originKind: 'group', originJid: GROUP }, ctxAt(clock.now()));
  const trig = r.events.find(e => e.type === 'chat.trigger' && e.payload.decisionId === C.id);
  const chatLean = r.events.find(e => e.type === 'decision.lean' && e.payload.decisionId === C.id);
  check('matched decision C', r.matched.includes(C.id), r.matched);
  eq('chat.trigger: actor chat, group origin, pointer only', [trig?.actor, trig?.originKind, trig?.originJid, trig?.payload], ['chat', 'group', GROUP, { decisionId: C.id, toward: 'go' }]);
  eq('lean: Jev, caused by the chat trigger, chat origin inherited', [chatLean?.actor, chatLean?.causeId, chatLean?.originKind, chatLean?.originJid], ['jev', trig?.id, 'group', GROUP]);
  eq('trigger chat_mention', chatLean?.payload.trigger, 'chat_mention');
  eq('one Jev call per matched decision', jev.calls.length, calls + r.matched.length);
  check('the chat text never reached Jev', !JSON.stringify(jev.calls).includes('SECRET-TEXT'));
  check('the chat text is not stored', !db.prepare("SELECT 1 FROM world_events WHERE instr(payload_json, 'SECRET-TEXT') > 0").get());
  eq('Jev only sees the push signal', jev.calls[jev.calls.length - 1].state.friend_pushed_toward, 'go');
  check('projection tainted with the chat origin', live.decisions.get(C.id).origins.some(o => o.jid === GROUP));
  calls = jev.calls.length;
  r = await noteChat(getState, { text: 'seriously come to the movie', originKind: 'group', originJid: GROUP }, ctxAt(clock.now() + 2 * MIN));
  eq('cooldown: a second mention within 10 min → no call', [jev.calls.length, r.events.length], [calls, 0]);
  r = await noteChat(getState, { text: 'movie?', originKind: 'group', originJid: 'not-a-jid' }, ctxAt(clock.now() + 20 * MIN));
  eq('invalid origin → ignored', [jev.calls.length, r.events.length], [calls, 0]);
  r = await noteChat(getState, { text: 'how was your day', originKind: 'dm', originJid: DM }, ctxAt(clock.now() + 20 * MIN));
  eq('no match → no event, no call', [jev.calls.length, r.events.length], [calls, 0]);

  // ── Reversal ─────────────────────────────────────────────────────────────
  section('reversal before ponr: strong opposite lean → decision.reversed, +stress, +tension');
  clock.set(local(9, 0, 28));
  jev.reset();
  answer = () => ({ pick: jevChoice('go', { go: 0.9, late: 0.05, stay: 0.05 }) });
  const R = await open(movieSpec(local(21, 0, 28)), clock.now());
  eq('committed early to go', live.decisions.get(R.id).committed?.optionId, 'go');
  clock.advance({ minutes: 30 });
  answer = () => ({ pick: jevChoice('stay', { go: 0.4, late: 0, stay: 0.6 }) });
  let info3 = append({ type: 'activity.started', at: clock.now(), actor: 'engine', payload: { kind: 'tv', withCast: [FLATMATE] } });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [info3] }));
  check(`a different lean below ${REVERSE_P} does not reverse`, !r.events.some(e => e.type === 'decision.reversed') && r.events.some(e => e.type === 'decision.lean'));
  const tensionBefore = live.cast.get(FLATMATE).metrics.tension;
  const stressBefore = live.vitals.stress;
  clock.advance({ minutes: 1 });
  answer = () => ({ pick: jevChoice('stay', { go: 0.1, late: 0.1, stay: 0.8 }) });
  info3 = append({ type: 'activity.started', at: clock.now(), actor: 'engine', payload: { kind: 'tv', withCast: [FLATMATE] } });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [info3] }));
  const rev = r.events.find(e => e.type === 'decision.reversed');
  const revLean = r.events.find(e => e.type === 'decision.lean');
  check('reversed', !!rev);
  eq('reversal: engine, caused by the new lean, go → stay', [rev?.actor, rev?.causeId, rev?.payload.from, rev?.payload.to], ['engine', revLean?.id, 'go', 'stay']);
  eq('projection: committed to stay, one reversal', [live.decisions.get(R.id).committed.optionId, live.decisions.get(R.id).reversals], ['stay', 1]);
  near('tension on the involved cast +0.1', live.cast.get(FLATMATE).metrics.tension, Math.min(1, tensionBefore + 0.1), 1e-9);
  check('stress rose by the reversal', live.vitals.stress >= stressBefore + 4.5, [stressBefore, live.vitals.stress]);
  const ponrR = live.decisions.get(R.id).ponrAt;
  clock.set(ponrR + MIN);
  calls = jev.calls.length;
  const info4 = append({ type: 'activity.started', at: clock.now(), actor: 'engine', payload: { kind: 'tv', withCast: [FLATMATE] } });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [info4] }));
  eq('after ponr a committed decision is settled (no Jev)', jev.calls.length, calls);

  // ── Expiry ───────────────────────────────────────────────────────────────
  section('expired options are never offered or sampled; all expired → decision.expired');
  clock.set(local(8, 0, 29));
  jev.reset();
  // Jev insists on 'early' (garbage for an expired option) → it is dropped.
  answer = () => ({ pick: jevChoice('early', { early: 0.95, stay: 0.03, go: 0.02 }) });
  const showE = local(20, 0, 29);
  const E = await open({
    kind: 'dinner', subject: { eventAt: showE, placeId: 'place:restaurant', castIds: [FLATMATE], minutes: 90 },
    options: [
      { id: 'early', label: 'Early table', go: true, expiresAt: clock.now() + 10 * MIN },
      { id: 'go', label: 'Dinner out', go: true, spend: 600, fun: 4 },
      { id: 'stay', label: 'Cook at home', kind: 'cook' },
    ],
  }, clock.now());
  eq('open-time Jev saw all three (none expired yet)', Object.keys(jev.calls[0].questions.pick.criteria), ['early', 'go', 'stay']);
  eq('early commit on early (p 0.95 while it was available)', live.decisions.get(E.id).committed?.optionId, 'early');
  // A second decision where the favourite expires before the deadline.
  clock.set(local(8, 30, 29));
  answer = () => ({ pick: jevChoice('early', { early: 0.79, stay: 0.11, go: 0.1 }) });
  const E2 = await open({
    kind: 'dinner', subject: { eventAt: showE, placeId: 'place:restaurant', minutes: 90 },
    options: [
      { id: 'early', label: 'Early table', go: true, expiresAt: clock.now() + 10 * MIN },
      { id: 'go', label: 'Dinner out', go: true, spend: 600 },
      { id: 'stay', label: 'Cook at home', kind: 'cook' },
    ],
  }, clock.now());
  eq('lean early, not committed (0.79 < 0.8)', [live.decisions.get(E2.id).lean.optionId, live.decisions.get(E2.id).status], ['early', 'open']);
  calls = jev.calls.length;
  const nearE2 = nearTime(live.decisions.get(E2.id).opensAt, live.decisions.get(E2.id).decideBy);
  // Jev still puts weight on the expired option: it is dropped and the rest renormalized.
  answer = () => ({ pick: jevChoice('early', { early: 0.6, go: 0.3, stay: 0.1 }) });
  clock.set(nearE2);
  r = await evaluate(getState, ctxAt(nearE2, { newEvents: [] }));
  eq('Jev was not offered the expired option', Object.keys(jev.calls[jev.calls.length - 1].questions.pick.criteria), ['go', 'stay']);
  const e2Lean = r.events.find(e => e.type === 'decision.lean' && e.payload.decisionId === E2.id);
  eq('lean ignores the expired option, renormalized', [e2Lean?.actor, e2Lean?.payload.optionId, e2Lean?.payload.probs], ['jev', 'go', { go: 0.75, stay: 0.25 }]);
  eq('0.75 < commitP → still open', live.decisions.get(E2.id).status, 'open');
  // Deadline: a low roll would pick the first option in order — the expired one must be skipped.
  const decideE2 = live.decisions.get(E2.id).decideBy;
  clock.set(decideE2);
  r = await evaluate(getState, ctxAt(decideE2, { newEvents: [], rng: () => 0 }));
  const e2Commit = r.events.find(e => e.type === 'decision.committed' && e.payload.decisionId === E2.id);
  eq('deadline sample (roll 0) skips the expired first option', e2Commit?.payload.optionId, 'go');
  // Jev answers only for ids that aren't on offer → nothing usable → code fallback.
  clock.set(local(8, 40, 29));
  answer = () => ({ pick: jevChoice('zzz', { zzz: 1 }) });
  const G = await open({ kind: 'plan', subject: { eventAt: local(18, 0, 29) },
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, clock.now());
  const gLean = G.events.find(e => e.type === 'decision.lean');
  eq('garbage answer → engine lean, fallback jev_error', [gLean?.actor, gLean?.payload.fallback], ['engine', 'jev_error']);
  // All options expired before the deadline.
  clock.set(local(9, 0, 29));
  answer = () => ({ pick: jevChoice('a', { a: 0.5, b: 0.5 }) });
  const X = await open({
    kind: 'errand', subject: { eventAt: local(19, 0, 29), placeId: 'place:grocery', minutes: 30 },
    options: [
      { id: 'a', label: 'Morning slot', go: true, expiresAt: clock.now() + 10 * MIN },
      { id: 'b', label: 'Noon slot', go: true, expiresAt: clock.now() + 20 * MIN },
    ],
  }, clock.now());
  clock.advance({ minutes: 30 });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [] }));
  const xExp = r.events.find(e => e.type === 'decision.expired' && e.payload.decisionId === X.id);
  eq('decision.expired by the engine, options_expired', [xExp?.actor, xExp?.payload.reason], ['engine', 'options_expired']);
  eq('dated when the last option ran out', xExp?.at, X.events[0].payload.options[1].expiresAt);
  eq('projection: expired', live.decisions.get(X.id).status, 'expired');

  section('heard too late: go already gone, decides on the spot');
  clock.set(local(19, 55, 29));
  append({ type: 'travel.arrived', at: clock.now(), actor: 'engine', payload: { to: 'place:home' } });
  eq('back home', live.position.placeId, 'place:home');
  answer = () => ({ pick: jevChoice('go', { go: 0.9, late: 0.05, stay: 0.05 }) });
  const L = await open(movieSpec(local(20, 0, 29)), clock.now());
  eq('go was not offered', Object.keys(jev.calls[jev.calls.length - 1].questions.pick.criteria), ['late', 'stay']);
  const lCommit = L.events.find(e => e.type === 'decision.committed');
  check('committed in the same step, never to go', lCommit && lCommit.payload.optionId !== 'go' && lCommit.at === clock.now(), lCommit?.payload);

  section('catch-up past decideBy and every expiry still commits at decideBy');
  clock.set(local(6, 0, 29));
  answer = () => ({ pick: jevChoice('a', { a: 0.6, b: 0.4 }) });
  const evAt = local(12, 0, 29);
  const J = await open({ kind: 'errand', subject: { eventAt: evAt, placeId: 'place:grocery', minutes: 30 },
    options: [{ id: 'a', label: 'Walk over', go: true }, { id: 'b', label: 'Go late', go: 'late' }] }, clock.now());
  const jDecide = live.decisions.get(J.id).decideBy;
  r = await evaluate(getState, ctxAt(evAt + 3 * 3600, { newEvents: [] }));
  const jCommit = r.events.find(e => e.type === 'decision.committed' && e.payload.decisionId === J.id);
  eq('committed (not expired), dated decideBy, sampled', [jCommit?.at, jCommit?.payload.sampled, live.decisions.get(J.id).status], [jDecide, true, 'committed']);

  // ── Fallbacks ────────────────────────────────────────────────────────────
  section('Jev failure and budget → softmax(U) by the engine');
  clock.set(local(10, 0, 30));
  jev.reset();
  jev.fail();
  const F = await open(movieSpec(local(21, 0, 30)), clock.now());
  const fLean = F.events.find(e => e.type === 'decision.lean');
  eq('Jev was tried once', jev.calls.length, 1);
  eq('lean by the engine with fallback jev_error', [fLean.actor, fLean.payload.fallback], ['engine', 'jev_error']);
  const fD = live.decisions.get(F.id);
  const expectProbs = softmax(utilities(fD, rebuild({ world }), world, { at: clock.now() }));
  near('probs = softmax(U / 0.5)', fLean.payload.probs.stay, Math.round(expectProbs.stay * 10000) / 10000, 2e-4);
  jev.recover();
  config.life.jevMaxPerDay = 0;
  calls = jev.calls.length;
  clock.advance({ minutes: 5 });
  const fInfo = append({ type: 'activity.started', at: clock.now(), actor: 'engine', payload: { kind: 'tv', withCast: [FLATMATE] } });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [fInfo] }));
  const bLean = r.events.find(e => e.type === 'decision.lean' && e.payload.decisionId === F.id);
  eq('over budget: no Jev call', jev.calls.length, calls);
  eq('… lean by the engine with fallback budget', [bLean?.actor, bLean?.payload.fallback, bLean?.payload.trigger], ['engine', 'budget', 'new_info']);
  config.life.jevMaxPerDay = 1;
  resetDecisionCounters();
  check('budget counts the projection too (survives a restart)', jevUsedToday(live, clock.now(), live.world.timezone) >= 0);
  const usedBefore = jevUsedToday(live, clock.now(), live.world.timezone);
  config.life.jevMaxPerDay = usedBefore + 1;
  clock.advance({ minutes: 5 });
  const fInfo2 = append({ type: 'activity.started', at: clock.now(), actor: 'engine', payload: { kind: 'tv', withCast: [FLATMATE] } });
  calls = jev.calls.length;
  answer = () => ({ pick: jevChoice('stay', { go: 0.4, late: 0.1, stay: 0.5 }) });
  await evaluate(getState, ctxAt(clock.now(), { newEvents: [fInfo2] }));
  eq('one call allowed under the budget', jev.calls.length, calls + 1);
  clock.advance({ minutes: 5 });
  const fInfo3 = append({ type: 'activity.started', at: clock.now(), actor: 'engine', payload: { kind: 'tv', withCast: [FLATMATE] } });
  r = await evaluate(getState, ctxAt(clock.now(), { newEvents: [fInfo3] }));
  eq('then the budget is spent', [jev.calls.length, r.events.find(e => e.type === 'decision.lean')?.payload.fallback], [calls + 1, 'budget']);
  config.life.jevMaxPerDay = origBudget;

  // ── Owner mode + cancel ──────────────────────────────────────────────────
  section('owner mode "ask" is stored; 009 still commits at the deadline; cancel');
  const modeEv = setMode(getState, F.id, 'ask', { at: clock.now(), append, by: 'owner' });
  eq('mode_set by the owner, owner origin, caused by the decision', [modeEv.actor, modeEv.originKind, modeEv.causeId, modeEv.payload.mode], ['owner', 'owner', F.id, 'ask']);
  eq('projection: mode ask', live.decisions.get(F.id).mode, 'ask');
  throws('bad mode refused', () => setMode(getState, F.id, 'yolo', { at: clock.now(), append }), /mode/);
  const decideF = live.decisions.get(F.id).decideBy;
  clock.set(decideF);
  r = await evaluate(getState, ctxAt(decideF, { newEvents: [] }));
  eq('ask mode still commits by lean at the deadline', [live.decisions.get(F.id).status, live.decisions.get(F.id).mode], ['committed', 'ask']);
  clock.set(local(10, 0, 31));
  answer = () => ({ pick: jevChoice('stay', { go: 0.5, late: 0, stay: 0.5 }) });
  const K = await open(movieSpec(local(21, 0, 31)), clock.now());
  const cancel = cancelDecision(getState, K.id, { at: clock.now(), append });
  eq('cancelled: decision.expired {reason: cancelled}', [cancel.type, cancel.payload.reason, live.decisions.get(K.id).status], ['decision.expired', 'cancelled', 'cancelled']);
  calls = jev.calls.length;
  await evaluate(getState, ctxAt(clock.now() + 3600, { newEvents: [] }));
  eq('closed decisions are never evaluated again', jev.calls.length, calls);

  // ── Validation + sanitizing ──────────────────────────────────────────────
  section('validation and sanitizing');
  const at0 = clock.now();
  await rejects('one option is refused', () => openDecision(getState, { kind: 'movie', subject: { eventAt: at0 + 3600 }, options: [{ id: 'a' }] }, ctxAt(at0)), /options/);
  await rejects('bad option id', () => openDecision(getState, { kind: 'movie', subject: { eventAt: at0 + 3600 }, options: [{ id: 'a b' }, { id: 'c' }] }, ctxAt(at0)), /option ids/);
  await rejects('duplicate option', () => openDecision(getState, { kind: 'movie', subject: { eventAt: at0 + 3600 }, options: [{ id: 'a' }, { id: 'a' }] }, ctxAt(at0)), /duplicate/);
  await rejects('unknown place', () => openDecision(getState, { kind: 'movie', subject: { eventAt: at0 + 3600, placeId: 'place:moon' }, options: [{ id: 'a' }, { id: 'b' }] }, ctxAt(at0)), /unknown place/);
  await rejects('bad kind', () => openDecision(getState, { kind: 'DROP TABLE', subject: { eventAt: at0 + 3600 }, options: [{ id: 'a' }, { id: 'b' }] }, ctxAt(at0)), /kind/);
  answer = () => ({ pick: jevChoice('a', { a: 0.5, b: 0.5 }) });
  const S = await open({
    kind: 'plan', subject: { eventAt: at0 + 4 * 3600 },
    options: [{ id: 'a', label: 'Go [IMAGE: http://x/y.png] with @15550000001 ok' }, { id: 'b', label: 'x'.repeat(300) }],
  }, at0);
  const labels = S.events[0].payload.options.map(o => o.label);
  check('marker stripped from labels', !labels[0].includes('[IMAGE'), labels[0]);
  check('@mention tag defanged', !labels[0].includes('@15550000001'), labels[0]);
  check('labels capped', labels[1].length <= 80);

  // ── Serialization ────────────────────────────────────────────────────────
  section('async entry points are serialized');
  clock.set(local(11, 0, 31));
  let inFlight = 0;
  let maxInFlight = 0;
  answer = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(res => setTimeout(res, 5));
    inFlight--;
    return { pick: jevChoice('a', { a: 0.5, b: 0.5 }) };
  };
  const twoOpen = [
    open({ kind: 'plan', subject: { eventAt: clock.now() + 6 * 3600 }, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, clock.now()),
    open({ kind: 'plan', subject: { eventAt: clock.now() + 7 * 3600 }, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, clock.now()),
  ];
  await Promise.all(twoOpen);
  eq('never two Jev calls in flight', maxInFlight, 1);

  section('007 Jev budget spent (BudgetError) → engine lean, never a crash');
  clock.set(local(12, 0, 31));
  jev.reset();
  jev.fail(new BudgetError('jev', { reason: 'global' }));
  const BE = await open({ kind: 'plan', subject: { eventAt: clock.now() + 5 * 3600 }, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, clock.now());
  const beLean = BE.events.find(e => e.type === 'decision.lean');
  eq('Jev was tried once', jev.calls.length, 1);
  eq('lean by the engine with fallback jev_budget', [beLean?.actor, beLean?.payload.fallback], ['engine', 'jev_budget']);
  jev.recover();

  section('replay: the folded live state equals a rebuild from the log');
  const replay = rebuild({ world, useSnapshot: false });
  const pick = (s) => [...s.decisions.values()].map(d => [d.id, d.status, d.committed?.optionId ?? null, d.reversals, d.mode, d.lean?.optionId ?? null]);
  eq('decisions identical after replay', pick(replay), pick(live));
} finally {
  setJev(null);
  setClock(null);
  config.life.jevMaxPerDay = origBudget;
}

report();
