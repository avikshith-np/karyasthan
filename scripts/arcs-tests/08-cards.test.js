// 010 T023 — Ask-me cards (src/life/story/decisionsGlue.js + the story facade's
// cards/cardPick/heavyVeto; US5, FR-033–FR-036, SC-006):
//   - big and guided decisions open with mode 'ask'; an insufficient lead time is
//     downgraded (bigDowngraded:'lead_time') or, for a movable spec, moved; a frozen
//     category refuses the open (nothing appended);
//   - no early commit on a card; silence → the argmax of the lean at decideBy
//     (by:'lean'); a non-card decision keeps 009 sampling;
//   - an owner pick commits as an owner event and is never reversed; a second pick
//     loses (already_committed); an expired option is not pickable; a pick racing
//     the deadline commit → exactly one decision.committed (both orders);
//   - a Jev failure → the card shows the lean's fallback; lean history ≤ 50 points;
//   - heavy veto cards (pending → veto once; after onset → refused).
// The facade is attached to a local projection (no life facade); scratch DB,
// fake clock and Jev, no network. Invented names.
import {
  section, check, eq, report, setupScratchDb, setSkills, fakeClock, fakeJevFixed, exampleWorld, blockNetwork, HOUR, DAY,
} from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { appendEvent, revertEvent } from '../../src/life/eventLog.js';
import { createInitialState, applyAppended, rebuild } from '../../src/life/projector.js';
import { createPulse, genesis } from '../../src/life/pulse.js';
import { setJev, resetDecisionCounters, evaluate } from '../../src/life/decisions.js';
import { setRngSeed } from '../../src/life/rng.js';
import * as glue from '../../src/life/story/decisionsGlue.js';

const net = blockNetwork();
await setupScratchDb();
await setSkills({ life: true, arcs: true });
setRngSeed(8);
const WORLD = await exampleWorld();
const T0 = zonedToUnix(2026, 10, 27, 6, 0, WORLD.timezone);
const clock = fakeClock(T0);
setClock(clock.fn);
let jev = fakeJevFixed({ accept: 0.9, decline: 0.1, attend: 0.2, call: 0.7, skip: 0.1, step: 0.3, wait: 0.7, go: 0.6, late: 0.2, stay: 0.2 });
setJev(jev.fn);
resetDecisionCounters();

const rt = { live: createInitialState(WORLD) };
rt.append = (spec) => { const e = appendEvent(spec); rt.live = applyAppended(rt.live, e, { world: WORLD }); return e; };
genesis(rt.append, WORLD, T0);
const pulse = createPulse({ world: WORLD, getState: () => rt.live, append: rt.append, now: clock.fn, tickMinutes: 15 });
await pulse.settle(T0);
for (let i = 0; i < 8; i++) { clock.advance({ minutes: 15 }); await pulse.tick(); }

const story = await import('../../src/life/story/index.js');
story.__setDepsForTest({ now: clock.fn });
story.attach({
  getState: () => rt.live, append: rt.append, world: WORLD, pulse, isLifeOn: () => true,
  revert: (id, o = {}) => { const r = revertEvent(id, { ...o, at: clock.now() }); rt.live = rebuild({ world: WORLD }); return r; },
  rebuild: () => { rt.live = rebuild({ world: WORLD }); },
});
check('the facade is on (attached to the local projection)', story.storyOn());

const ctx = (extra = {}) => ({ world: WORLD, at: clock.now(), append: rt.append, ...extra });
const offer = (over = {}) => ({
  kind: 'career:offer', category: 'career', big: true,
  decideBy: clock.now() + 48 * HOUR,
  subject: { eventAt: clock.now() + 48 * HOUR, placeId: null, castIds: [], minutes: 30 },
  options: [{ id: 'accept', label: 'Accept the offer', kind: 'rest', minutes: 0 }, { id: 'decline', label: 'Decline the offer', kind: 'rest', minutes: 0 }],
  ...over,
});
const dec = (id) => rt.live.decisions.get(id);
const codeOf = async (p) => { try { await p; return 'ok'; } catch (e) { return `${e?.code}:${e?.reason ?? ''}`; } };
const commitsOf = (id) => [...appendEventsOf('decision.committed')].filter(e => e.payload.decisionId === id);
function* appendEventsOf(type) {
  const { listEvents } = rtEvents;
  for (const e of listEvents({ types: [type], limit: 1000 })) yield e;
}
const rtEvents = await import('../../src/life/eventLog.js');

section('big and guided → ask; lead time downgrade or move; frozen refuses');
let bigId;
{
  const r = await glue.openArcDecision(() => rt.live, offer(), ctx());
  bigId = r.decision.id;
  eq('big → mode ask, big kept', [r.decision.payload.mode, r.decision.payload.big], ['ask', true]);
  eq('no early commit on a card (a confident lean)', dec(bigId).status, 'open');

  const short = await glue.openArcDecision(() => rt.live, offer({ decideBy: clock.now() + 2 * HOUR, subject: { eventAt: clock.now() + 3 * HOUR, placeId: null, castIds: [], minutes: 30 } }), ctx());
  eq('a short lead → ordinary, bigDowngraded', [short.decision.payload.big ?? false, short.decision.payload.bigDowngraded, short.decision.payload.mode],
    [false, 'lead_time', 'auto']);
  const moved = await glue.openArcDecision(() => rt.live, offer({ movable: true, decideBy: clock.now() + 2 * HOUR, subject: { eventAt: clock.now() + 3 * HOUR, placeId: null, castIds: [], minutes: 30 } }), ctx());
  check('a movable spec is moved to the full lead time', moved.decision.payload.decideBy - clock.now() >= 24 * HOUR && moved.decision.payload.mode === 'ask'
    && moved.decision.payload.subject.eventAt > clock.now() + 3 * HOUR);

  rt.append({ type: 'director.fate_set', at: clock.now(), actor: 'owner', payload: { category: 'family', mode: 'guided' } });
  const g = await glue.openArcDecision(() => rt.live, {
    kind: 'family:visit', subject: { eventAt: clock.now() + 30 * HOUR, placeId: null, castIds: [], minutes: 60 },
    options: [{ id: 'attend', label: 'Visit', kind: 'rest' }, { id: 'call', label: 'Call instead', kind: 'rest' }, { id: 'skip', label: 'Skip it', kind: 'rest' }],
  }, ctx());
  eq('guided (not big) → ask, category from the kind', [g.decision.payload.mode, g.decision.payload.category], ['ask', 'family']);
  check('the card says guided', story.cards().find(c => c.id === g.decision.id)?.guided === true);

  rt.append({ type: 'director.fate_set', at: clock.now(), actor: 'owner', payload: { category: 'health', mode: 'frozen' } });
  const n0 = rt.live.lastEventId;
  eq('a frozen category refuses the open', await codeOf(glue.openArcDecision(() => rt.live, {
    kind: 'health:checkup', subject: { eventAt: clock.now() + 30 * HOUR, placeId: null, castIds: [], minutes: 60 },
    options: [{ id: 'go_in', label: 'Go', kind: 'rest' }, { id: 'later', label: 'Later', kind: 'rest' }],
  }, ctx())), 'refused:frozen');
  eq('…and appends nothing', rt.live.lastEventId, n0);
  eq('an unknown category is invalid', await codeOf(glue.openArcDecision(() => rt.live, { ...offer(), kind: 'zzz:offer', category: 'zzz' }, ctx())), 'invalid:invalid');
}

section('cards view');
{
  const c = story.cards().find(x => x.id === bigId);
  check('the big decision has a card', !!c);
  eq('card shape', [c.type, c.category, c.kind, c.big, c.status, c.outcome], ['decision', 'career', 'career:offer', true, 'open', null]);
  check('a code question with the option labels', typeof c.question === 'string' && c.question.includes('Accept the offer'));
  check('options with cost vectors', c.options.length === 2 && c.options.every(o => ['energy', 'money', 'social', 'stress', 'travelMin'].every(k => typeof o.cost[k] === 'number')));
  check('a lean and its history', c.lean && ['jev', 'engine'].includes(c.lean.by) && c.leanHistory.length >= 1 && c.leanHistory.length <= 50);
  check('decideBy, ponrAt and now', c.decideBy > c.now && Number.isFinite(c.ponrAt));
  const status = story.status();
  check('status counts the open cards', status.counts.cards >= 2);
}

section('owner pick: an owner event, never reversed; the second pick loses');
{
  const r = await story.cardPick(bigId, 'decline', { by: 'tester' });
  const ev = rtEvents.getEvent(r.eventId);
  eq('owner event, by owner', [ev.actor, ev.payload.by, ev.payload.optionId], ['owner', 'owner', 'decline']);
  eq('projected as an owner pick', [dec(bigId).status, dec(bigId).committed.by, dec(bigId).committed.optionId], ['committed', 'owner', 'decline']);
  eq('a second pick → already_committed', await codeOf(story.cardPick(bigId, 'accept')), 'conflict:already_committed');
  rt.append({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: bigId, payload: { decisionId: bigId, from: 'decline', to: 'accept' } });
  eq('a later reversal (state shift) does not move an owner pick', dec(bigId).committed.optionId, 'decline');
  eq('unknown decision → not_found', await codeOf(story.cardPick(987654, 'accept')), 'not_found:decision');
  const card = story.cards().find(x => x.id === bigId);
  eq('the card shows the outcome', [card.status, card.outcome?.by, card.outcome?.optionId], ['committed', 'owner', 'decline']);
}

section('silence → the argmax of the lean at decideBy (by:lean); auto decisions sample');
{
  const r = await glue.openArcDecision(() => rt.live, offer({ decideBy: clock.now() + 25 * HOUR }), ctx());
  const id = r.decision.id;
  clock.advance({ hours: 25, minutes: 1 });
  await evaluate(() => rt.live, { world: WORLD, at: clock.now(), append: rt.append, newEvents: [] });
  const c = commitsOf(id);
  eq('exactly one commit', c.length, 1);
  eq('the lean argmax, by lean', [c[0]?.payload.optionId, c[0]?.payload.by], ['accept', 'lean']);
  const auto = await glue.openArcDecision(() => rt.live, {
    kind: 'social:plan', subject: { eventAt: clock.now() + 6 * HOUR, placeId: null, castIds: [], minutes: 60 }, decideBy: clock.now() + 2 * HOUR,
    options: [{ id: 'attend', label: 'Go along', kind: 'rest' }, { id: 'skip', label: 'Skip it', kind: 'rest' }],
  }, ctx());
  eq('a social plan is not a card (mode auto)', auto.decision.payload.mode, 'auto');
  clock.advance({ hours: 2, minutes: 1 });
  await evaluate(() => rt.live, { world: WORLD, at: clock.now(), append: rt.append, newEvents: [] });
  const ac = commitsOf(auto.decision.id);
  check('…and commits by 009 sampling (or early)', ac.length === 1 && ['sample', 'early'].includes(ac[0].payload.by), ac.map(e => e.payload.by));
}

section('an expired option is not pickable');
{
  const r = await glue.openArcDecision(() => rt.live, offer({
    options: [{ id: 'accept', label: 'Accept', kind: 'rest', minutes: 0, expiresAt: clock.now() + 60 }, { id: 'decline', label: 'Decline', kind: 'rest', minutes: 0 }],
  }), ctx());
  clock.advance({ minutes: 2 });
  eq('expired option → expired_option', await codeOf(story.cardPick(r.decision.id, 'accept')), 'conflict:expired_option');
  check('the card marks it expired', story.cards().find(c => c.id === r.decision.id)?.options.find(o => o.id === 'accept')?.expired === true);
}

section('a pick racing the deadline commit → exactly one decision.committed (both orders)');
for (const order of ['pick_first', 'deadline_first']) {
  const r = await glue.openArcDecision(() => rt.live, offer({ decideBy: clock.now() + 25 * HOUR }), ctx());
  const id = r.decision.id;
  clock.advance({ hours: 25, minutes: 1 });
  const pick = () => story.cardPick(id, 'decline').then(() => 'picked', e => e.code);
  const deadline = () => evaluate(() => rt.live, { world: WORLD, at: clock.now(), append: rt.append, newEvents: [] }).then(() => 'evaluated');
  const out = order === 'pick_first' ? await Promise.all([pick(), deadline()]) : (await Promise.all([deadline(), pick()])).reverse();
  eq(`${order}: one commit`, commitsOf(id).length, 1);
  check(`${order}: the losing side got a conflict or nothing`, out[0] === 'picked' || out[0] === 'conflict', out);
}

section('a Jev failure → the card shows the fallback');
{
  setJev(async () => { throw new Error('jev down'); });
  const r = await glue.openArcDecision(() => rt.live, offer(), ctx());
  const c = story.cards().find(x => x.id === r.decision.id);
  check('the lean came from code costs with a fallback word', c?.lean && typeof c.lean.fallback === 'string', c?.lean);
  setJev(jev.fn);
}

section('lean history ≤ 50 points');
{
  const r = await glue.openArcDecision(() => rt.live, offer(), ctx());
  for (let i = 0; i < 60; i++) {
    appendEvent({ type: 'decision.lean', at: clock.now(), actor: 'engine', causeId: r.decision.id, payload: { decisionId: r.decision.id, optionId: i % 2 ? 'accept' : 'decline', p: 0.6, probs: { accept: 0.6, decline: 0.4 }, trigger: 'state_shift' } });
  }
  rt.live = rebuild({ world: WORLD });
  eq('capped at 50', story.cards().find(x => x.id === r.decision.id)?.leanHistory.length, 50);
}

section('heavy veto cards');
{
  const prop = rt.append({ type: 'heavy.proposed', at: clock.now(), actor: 'engine', payload: { themeId: 'minor-accident', kind: 'minor_accident', label: 'a small accident', onsetAt: clock.now() + 30 * HOUR, roll: 0.0001, p: 0.002, nominated: false, durationDays: 2 } });
  const card = story.cards().find(c => c.id === `heavy:${prop.id}`);
  eq('a veto card', [card?.type, card?.status, card?.heavy?.status], ['heavy_veto', 'open', 'pending']);
  const v = await story.heavyVeto(prop.id, { by: 'tester' });
  eq('veto → an owner heavy.vetoed', [rtEvents.getEvent(v.eventId).type, rtEvents.getEvent(v.eventId).actor], ['heavy.vetoed', 'owner']);
  eq('a second veto → not_pending', await codeOf(story.heavyVeto(prop.id)), 'conflict:not_pending');
  const late = rt.append({ type: 'heavy.proposed', at: clock.now(), actor: 'engine', payload: { themeId: 'minor-accident', kind: 'minor_accident', onsetAt: clock.now() + 60, roll: 0.0001, p: 0.002, nominated: false } });
  clock.advance({ minutes: 2 });
  eq('after the onset time → refused', await codeOf(story.heavyVeto(late.id)), 'conflict:not_pending');
}

story.detach();
eq('no network', net.count, 0);
void DAY;
report();
