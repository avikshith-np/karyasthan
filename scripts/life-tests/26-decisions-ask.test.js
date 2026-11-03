// 010 T010 — decisions.js seams (contracts/story-api.md §3.3, research R14):
// "Ask me" cards (no early commit, argmax at the deadline), ownerCommit racing
// the pulse's deadline commit (both orders → exactly one commit), adopted
// decisions (preCommit, locked: no triggers, no chat leans), `by` on every
// commit, bias in U, explicit decideBy, subjectJid on opened/lean/commit, the
// arc Jev caller and its separate budget, and the consequence-cause rule (a
// chat-origin arc commit still lets a story consequence caused by
// decision.opened append). A 009 setMode('ask') decision still takes chat
// leans. Scratch DB, fake clock, mocked Jev, invented ids only.
import { setupScratchDb, fakeClock, fakeJev, jevChoice, section, check, eq, throws, report } from './_helpers.js';
import { setClock, zonedToUnix, dateKey } from '../../src/life/clock.js';
import { appendEvent, listEvents, getEvent } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended } from '../../src/life/projector.js';
import { config } from '../../src/utils/config.js';
import {
  setJev, resetDecisionCounters, utilities, detectTriggers, openDecision, evaluate, noteChat, setMode, ownerCommit,
  arcJevUsedToday, jevUsedToday, setStoryAsk,
} from '../../src/life/decisions.js';

const { db } = await setupScratchDb();
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (h, m = 0, day = 26) => zonedToUnix(2026, 10, day, h, m, tz);
const clock = fakeClock(local(9));
setClock(clock.fn);

const MIN = 60;
const H = 3600;
const DAY = 86400;
const GROUP = '120363000000000261@g.us';
const PERSON = '15550000261@s.whatsapp.net';
const FLATMATE = 'cast:flatmate';

let live = createInitialState(world);
const append = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  return ev;
};
const getState = () => live;
const ctxAt = (at, extra = {}) => ({ world, at, append, ...extra });
const commitsOf = (id) => listEvents({ types: ['decision.committed'], limit: 1000 }).filter(e => e.payload.decisionId === id);
const leansOf = (id) => listEvents({ types: ['decision.lean'], limit: 1000 }).filter(e => e.payload.decisionId === id);

let answer = () => ({ pick: jevChoice('yes', { yes: 0.9, no: 0.1 }) });
const jev = fakeJev((req, i) => answer(req, i));
setJev(jev.fn);

// An arc-style card: category, ask, no trip, explicit decideBy.
const cardSpec = (eventAt, decideBy, extra = {}) => ({
  kind: 'romance:dinner',
  subject: { eventAt, castIds: [FLATMATE], minutes: 120 },
  options: [
    { id: 'yes', label: 'Say yes to dinner', kind: 'social', fun: 5 },
    { id: 'no', label: 'Say no for now', kind: 'rest' },
  ],
  mode: 'ask', category: 'romance', big: true, decideBy,
  ...extra,
});
const outingSpec = (eventAt, extra = {}) => ({
  kind: 'movie',
  subject: { eventAt, placeId: 'place:cinema', castIds: [FLATMATE], minutes: 150 },
  options: [
    { id: 'go', label: 'Go to the movie', go: true, kind: 'movie', spend: 300, fun: 6 },
    { id: 'late', label: 'Join late', go: 'late', kind: 'movie', minutes: 75, spend: 300, fun: 3 },
    { id: 'stay', label: 'Stay in and rest', kind: 'rest' },
  ],
  ...extra,
});

async function rejectsCode(name, promise, code) {
  try { await promise; } catch (err) { return check(name, err?.code === code, `code ${err?.code}: ${err?.message}`); }
  return check(name, false, 'did not reject');
}

try {
  const T0 = clock.now();
  const genesis = append({ type: 'genesis', at: T0, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) append({ type: 'place.created', at: T0, actor: 'engine', causeId: genesis.id, payload: p });
  for (const c of world.cast) append({ type: 'cast.created', at: T0, actor: 'engine', causeId: genesis.id, payload: c });

  section('validateSpec: 010 fields');
  const bad = async (name, spec, re) => {
    try { await openDecision(getState, spec, ctxAt(clock.now())); check(name, false, 'did not throw'); }
    catch (err) { check(name, re.test(err.message), err.message); }
  };
  await bad('preCommit without adopted refused', outingSpec(local(21), { preCommit: 'go' }), /preCommit/);
  await bad('preCommit other than go refused', outingSpec(local(21), { adopted: true, preCommit: 'stay' }), /preCommit/);
  await bad('bad category refused', cardSpec(local(21), local(20), { category: 'Not A Category!' }), /category/);
  await bad('non-integer decideBy refused', cardSpec(local(21), 12.5), /decideBy/);
  await bad('non-numeric bias refused', { ...outingSpec(local(21)), options: [{ id: 'go', label: 'go', bias: 'x' }, { id: 'stay', label: 'stay' }] }, /bias/);

  section('ask: explicit decideBy, no early commit, subjectJid, arc caller');
  jev.reset();
  const tA = clock.now();
  const card = await openDecision(getState, cardSpec(tA + 3 * DAY, tA + 2 * DAY, { arcId: 41 }), ctxAt(tA, { subjectJid: PERSON }));
  const cid = card.decision.id;
  const cd = live.decisions.get(cid);
  eq('decideBy explicit; not a trip → ponrAt = decideBy', [cd.decideBy, cd.ponrAt], [tA + 2 * DAY, tA + 2 * DAY]);
  eq('opened payload carries category/big/arcId', [card.decision.payload.category, card.decision.payload.big, card.decision.payload.arcId], ['romance', true, 41]);
  eq('lean p 0.9 ≥ commitP but ask → still open', cd.status, 'open');
  eq('one Jev call with the arc caller', jev.calls.map(c => c.caller), ['life.arc.decision']);
  eq('subjectJid on opened and lean', [card.decision.subjectJid, leansOf(cid)[0]?.subjectJid], [PERSON, PERSON]);
  eq('projected decision keeps subjectJid and category', [cd.subjectJid, cd.category], [PERSON, 'romance']);
  eq('projector counted it as an arc Jev call', [live.counters.arcJevToday, arcJevUsedToday(live, tA, tz)], [1, 1]);

  section('deadline: ask commits the argmax, by lean');
  answer = () => ({ pick: jevChoice('no', { yes: 0.45, no: 0.55 }) });
  const near = cd.decideBy - 30 * MIN - 1;
  await evaluate(getState, ctxAt(near + 2, { rng: () => 0 }));
  eq('deadline_near lean recorded (still open)', [live.decisions.get(cid).lean.optionId, live.decisions.get(cid).status], ['no', 'open']);
  await evaluate(getState, ctxAt(cd.decideBy + 60, { rng: () => 0 })); // rng 0 would sample 'yes' first
  const c1 = commitsOf(cid);
  eq('one commit, the argmax (not the rng draw)', c1.map(e => [e.payload.optionId, e.payload.by, e.payload.sampled, e.payload.byLean]), [['no', 'lean', false, true]]);
  eq('commit dated decideBy, carries subjectJid', [c1[0].at, c1[0].subjectJid], [cd.decideBy, PERSON]);
  eq('projection: by lean', live.decisions.get(cid).committed.by, 'lean');

  section('auto: sampling unchanged, by sample / early');
  answer = () => ({ pick: jevChoice('go', { go: 0.5, late: 0.2, stay: 0.3 }) });
  const tB = local(17);
  const auto = await openDecision(getState, outingSpec(local(21)), ctxAt(tB));
  const aid = auto.decision.id;
  const ad = live.decisions.get(aid);
  await evaluate(getState, ctxAt(ad.decideBy + 1, { rng: () => 0.99 }));
  const ac = commitsOf(aid);
  eq('sampled by the rng (0.99 → last positive option), by sample', ac.map(e => [e.payload.optionId, e.payload.sampled, e.payload.by]), [['stay', true, 'sample']]);
  answer = () => ({ pick: jevChoice('go', { go: 0.95, late: 0.03, stay: 0.02 }) });
  const early = await openDecision(getState, outingSpec(local(22)), ctxAt(local(18)));
  eq('a confident auto lean commits early, by early', commitsOf(early.decision.id).map(e => e.payload.by), ['early']);

  section('bias is added to U');
  const biased = { id: 1, options: [{ id: 'a', cost: {}, bias: 2 }, { id: 'b', cost: {} }], subject: { castIds: [] } };
  const us = utilities(biased, live, world, { at: local(18) });
  eq('U(a) − U(b) = bias', Math.round((us.a - us.b) * 1000) / 1000, 2);

  section('ownerCommit races the deadline commit: both orders → one commit');
  // Order 1: owner first, then the pulse's deadline evaluation in the same chain.
  answer = () => ({ pick: jevChoice('yes', { yes: 0.6, no: 0.4 }) });
  const tC = local(10, 0, 27);
  clock.set(tC);
  const r1 = await openDecision(getState, cardSpec(tC + 2 * DAY, tC + DAY), ctxAt(tC));
  const r1id = r1.decision.id;
  const [own1, ev1] = await Promise.allSettled([
    ownerCommit(getState, r1id, 'no', { at: tC + DAY - 60, append, by: 'operator' }),
    evaluate(getState, ctxAt(tC + DAY + 60)),
  ]);
  eq('owner pick resolved', own1.status, 'fulfilled');
  eq('exactly one commit, the owner\'s', commitsOf(r1id).map(e => [e.actor, e.payload.optionId, e.payload.by]), [['owner', 'no', 'owner']]);
  check('evaluate after it committed nothing more', ev1.status === 'fulfilled' && !ev1.value.events.some(e => e.type === 'decision.committed'));
  eq('projection: by owner', live.decisions.get(r1id).committed.by, 'owner');
  eq('owner commit caused by the decision, operator label kept', [commitsOf(r1id)[0].causeId, commitsOf(r1id)[0].payload.operator], [r1id, 'operator']);
  // Order 2: the deadline commit first, then the owner's late pick.
  const r2 = await openDecision(getState, cardSpec(tC + 2 * DAY, tC + DAY + 10), ctxAt(tC + 5));
  const r2id = r2.decision.id;
  const [ev2, own2] = await Promise.allSettled([
    evaluate(getState, ctxAt(tC + DAY + 600)),
    ownerCommit(getState, r2id, 'no', { at: tC + DAY + 601, append }),
  ]);
  check('deadline evaluation committed', ev2.status === 'fulfilled' && ev2.value.events.some(e => e.type === 'decision.committed' && e.payload.decisionId === r2id));
  check('the late owner pick is refused as expired', own2.status === 'rejected' && own2.reason?.code === 'expired', own2.reason?.message);
  eq('exactly one commit, by lean', commitsOf(r2id).map(e => e.payload.by), ['lean']);

  section('ownerCommit refusals');
  await rejectsCode('unknown decision → not_found', ownerCommit(getState, 999999, 'yes', { at: clock.now(), append }), 'not_found');
  const r3 = await openDecision(getState, cardSpec(tC + 3 * DAY, tC + 2 * DAY), ctxAt(tC + 20));
  await rejectsCode('unknown option → invalid', ownerCommit(getState, r3.decision.id, 'maybe', { at: tC + 30, append }), 'invalid');
  await rejectsCode('bad option id → invalid', ownerCommit(getState, r3.decision.id, '../x', { at: tC + 30, append }), 'invalid');
  const exp = await openDecision(getState, { ...outingSpec(local(21, 0, 27)), mode: 'ask' }, ctxAt(local(15, 0, 27)));
  const ponr = live.decisions.get(exp.decision.id).ponrAt;
  await rejectsCode('an expired option → expired', ownerCommit(getState, exp.decision.id, 'go', { at: ponr + 60, append }), 'expired');

  section('owner pick is never reversed');
  answer = () => ({ pick: jevChoice('stay', { go: 0.4, late: 0.1, stay: 0.5 }) });
  const tE = local(12, 0, 27);
  const out = await openDecision(getState, { ...outingSpec(local(21, 0, 27)), mode: 'ask' }, ctxAt(tE));
  const oid = out.decision.id;
  await ownerCommit(getState, oid, 'go', { at: tE + 60, append });
  answer = () => ({ pick: jevChoice('stay', { go: 0.02, late: 0.01, stay: 0.97 }) });
  const leansBefore = leansOf(oid).length;
  append({ type: 'sick.started', at: tE + 120, actor: 'engine', payload: { until: tE + DAY, days: 1 } }); // state_shift
  jev.reset();
  await evaluate(getState, ctxAt(tE + 180));
  // 020: only the owner changes an owner's plan, so a lean on it could change nothing: none is taken, no Jev spend.
  eq('no lean on the owner pick, even on a state shift', leansOf(oid).length, leansBefore);
  eq('no reversal of the owner pick', [listEvents({ types: ['decision.reversed'], limit: 100 }).filter(e => e.payload.decisionId === oid).length, live.decisions.get(oid).committed.optionId], [0, 'go']);
  append({ type: 'sick.ended', at: tE + 240, actor: 'engine', payload: {} });

  section('adopted: preCommit go, locked, no chat leans');
  jev.reset();
  const tF = local(9, 0, 28);
  clock.set(tF);
  const adoptedSpec = { ...outingSpec(tF + 10 * DAY), adopted: true, preCommit: 'go', category: 'social', claimId: 88 };
  const adop = await openDecision(getState, adoptedSpec, ctxAt(tF, { subjectJid: PERSON }));
  const did = adop.decision.id;
  eq('events: opened, engine lean p 1, commit by adopted', adop.events.map(e => [e.type, e.actor, e.payload.p ?? null, e.payload.by ?? null]),
    [['decision.opened', 'engine', null, null], ['decision.lean', 'engine', 1, null], ['decision.committed', 'engine', 1, 'adopted']]);
  eq('no Jev call', jev.calls.length, 0);
  eq('opened payload: adopted, claimId', [adop.decision.payload.adopted, adop.decision.payload.claimId], [true, 88]);
  eq('subjectJid on all three', adop.events.map(e => e.subjectJid), [PERSON, PERSON, PERSON]);
  const dd = live.decisions.get(did);
  eq('projection: committed, by adopted, adopted flag', [dd.status, dd.committed.by, dd.adopted], ['committed', 'adopted', true]);
  // 020: an adopted plan is a promise now, not a lock: real news about it may make him rethink it.
  eq('detectTriggers: new info counts on an adopted plan', detectTriggers(dd, live, { at: tF + 60, world,
    newEvents: [{ id: 10 ** 9, type: 'activity.started', causeId: did, payload: {} }] }).map(t => t.trigger), ['new_info']);
  const aboutDid = (evs) => evs.filter(e => e.payload?.decisionId === did || e.causeId === did).length;
  const nBefore = aboutDid(listEvents({ limit: 100000 }));
  const chat = await noteChat(getState, { text: 'are we still on for the movie? let\'s go', originKind: 'group', originJid: GROUP }, ctxAt(tF + 120));
  eq('a chat mention of an adopted decision appends nothing for it', [chat.matched.includes(did), aboutDid(chat.events), aboutDid(listEvents({ limit: 100000 })) - nBefore], [false, 0, 0]);
  check('no Jev for it', !jev.calls.some(c => c.state?.decision === 'movie' && c.state?.minutes_to_event > 9 * 24 * 60));
  await evaluate(getState, ctxAt(tF + 3 * H, { newEvents: [] }));
  eq('evaluate leaves it alone', leansOf(did).length, 1);

  section('chat lean on an arc decision → the commit stays his, naming its lean; chat-origin causes stay refused');
  answer = () => ({ pick: jevChoice('yes', { yes: 0.7, no: 0.3 }) });
  const tG = local(10, 0, 29);
  clock.set(tG);
  const arc = await openDecision(getState, cardSpec(tG + 2 * DAY, tG + DAY), ctxAt(tG));
  const arcId = arc.decision.id;
  // After deadline_near (decideBy − 20% of the window), so the chat lean is the one the deadline commits from.
  const noted = await noteChat(getState, { text: 'dinner with them would be great, say yes!', originKind: 'group', originJid: GROUP }, ctxAt(tG + DAY - H));
  check('the arc decision took the chat lean', noted.matched.includes(arcId) && noted.events.some(e => e.type === 'decision.lean' && e.originJid === GROUP));
  await evaluate(getState, ctxAt(tG + DAY + 60));
  const ac2 = commitsOf(arcId);
  // 020 §A3: a nudge doesn't recolour the commit. The anti-injection rule stands, on the chat-origin event itself.
  eq('deadline commit keeps his origin, nudged', ac2.map(e => [e.originKind, e.originJid, e.payload.by, e.payload.nudged]), [['self', 'self', 'lean', true]]);
  const chatLean = getEvent(ac2[0].payload.leanEventId);
  eq('…naming the chat\'s lean', [chatLean?.type, chatLean?.originJid], ['decision.lean', GROUP]);
  throws('a story event caused directly by a chat-origin event is refused', () => appendEvent({ type: 'arc.stage', actor: 'engine', causeId: chatLean.id,
    payload: { arcId: 1, from: 'talking', to: 'dating', commitEventId: ac2[0].id } }), /cannot have a chat origin/);
  const stage = appendEvent({ type: 'arc.stage', actor: 'engine', causeId: arcId, payload: { arcId: 1, from: 'talking', to: 'dating', commitEventId: ac2[0].id } });
  eq('the consequence caused by decision.opened appends as self', [stage.originKind, stage.causeId], ['self', arcId]);

  section('a 009 setMode(\'ask\') decision still takes chat leans');
  answer = () => ({ pick: jevChoice('go', { go: 0.55, late: 0.15, stay: 0.3 }) });
  const tH = local(16, 0, 29);
  const m = await openDecision(getState, outingSpec(local(21, 0, 29)), ctxAt(tH));
  const mid = m.decision.id;
  setMode(getState, mid, 'ask', { at: tH + 60, append });
  eq('mode ask, no category', [live.decisions.get(mid).mode, live.decisions.get(mid).category], ['ask', undefined]);
  jev.reset();
  const n2 = await noteChat(getState, { text: 'movie tonight? come with us', originKind: 'group', originJid: GROUP }, ctxAt(tH + 20 * MIN));
  check('chat lean taken (matched, chat.trigger + lean)', n2.matched.includes(mid) && n2.events.some(e => e.type === 'decision.lean'));
  eq('009 caller', jev.calls.map(c => c.caller), ['life.decision']);

  section('story off: a 009 decision in ask mode keeps 009 semantics (review regression)');
  setStoryAsk(null);
  answer = () => ({ pick: jevChoice('go', { go: 0.97, late: 0.01, stay: 0.02 }) });
  const tJ = local(10, 0, 31);
  clock.set(tJ);
  const e1 = await openDecision(getState, { ...outingSpec(local(21, 0, 31)), mode: 'ask' }, ctxAt(tJ));
  eq('ask + story off: early commit by lean (009)', commitsOf(e1.decision.id).map(e => e.payload.by), ['early']);
  answer = () => ({ pick: jevChoice('go', { go: 0.6, late: 0.1, stay: 0.3 }) });
  const e2 = await openDecision(getState, { ...outingSpec(local(21, 30, 31)), mode: 'ask' }, ctxAt(tJ + 60));
  eq('… below commitP: still open', live.decisions.get(e2.decision.id).status, 'open');
  await evaluate(getState, ctxAt(live.decisions.get(e2.decision.id).decideBy + 60));
  eq('… the deadline samples (009), not the argmax', commitsOf(e2.decision.id).map(e => [e.payload.by, e.payload.sampled, e.payload.byLean ?? null]), [['sample', true, null]]);
  setStoryAsk(() => true);
  answer = () => ({ pick: jevChoice('go', { go: 0.97, late: 0.01, stay: 0.02 }) });
  const e3 = await openDecision(getState, { ...outingSpec(local(22, 0, 31)), mode: 'ask' }, ctxAt(tJ + 120));
  eq('ask + story on: no early commit', [live.decisions.get(e3.decision.id).status, commitsOf(e3.decision.id).length], ['open', 0]);
  await evaluate(getState, ctxAt(live.decisions.get(e3.decision.id).decideBy + 60));
  eq('… the deadline commits the argmax by lean', commitsOf(e3.decision.id).map(e => [e.payload.by, e.payload.sampled]), [['lean', false]]);
  setStoryAsk(null);
  const e4 = await openDecision(getState, cardSpec(tJ + 3 * DAY, tJ + 2 * DAY), ctxAt(tJ + 180));
  eq('an arc decision keeps ask semantics with the story seam off', [live.decisions.get(e4.decision.id).status, commitsOf(e4.decision.id).length], ['open', 0]);

  section('arc budget is separate');
  resetDecisionCounters();
  const origArc = config.arcs.jevMaxPerDay;
  config.arcs.jevMaxPerDay = 0;
  jev.reset();
  const tI = local(9, 0, 30);
  const capped = await openDecision(getState, cardSpec(tI + 2 * DAY, tI + DAY), ctxAt(tI));
  eq('arc budget 0 → code lean, fallback budget, no Jev', [leansOf(capped.decision.id)[0]?.payload.fallback, jev.calls.length], ['budget', 0]);
  const plain = await openDecision(getState, outingSpec(local(21, 0, 30)), ctxAt(tI + 60));
  eq('a 009 decision still asks Jev', [jev.calls.length, leansOf(plain.decision.id)[0]?.actor], [1, 'jev']);
  config.arcs.jevMaxPerDay = origArc;
  check('009 counter unaffected by arc leans', jevUsedToday(live, tI + 120, tz) >= 1 && arcJevUsedToday(live, tI + 120, tz) === 0);
  eq('day key sanity', dateKey(tI, tz), '2026-10-30');
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}

report();
