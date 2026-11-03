// Earned trust (owner decision 2026-10-30): src/life/story/cast.js earnedTrust /
// planDaily, the decisions.js trust seam, the card hint (fragment.castOverlay →
// innerState.castCard), the Director's cast.metrics and the owner rule.
//
//   unit  hand-built projections: every rule (kept plan once a day, a decline
//         costs only after a go lean — a plain one is free —,
//         backed out by a reversal or an owner cancel, occasion skip, romance
//         breakup / fizzle, tension, steady contact and its ceiling), what never
//         counts (a romance "stay", chat-origin decisions, chat shared time, other
//         family decisions, outside the window), the day cap and the 0..1 range,
//         the merge into the member's one relationship.changed (reason, trustWhy,
//         controls), counts.trust, determinism, the switch;
//   effects castAffinity with and without the seam, the hint on the card within
//         CARD_MAX, the overlay;
//   owner cast.metrics plans split ≤ 0.2 steps that land exactly, pins refuse,
//         nothing-to-do refuses, bad numbers are invalid;
//   log   the real 010 pulse via the life facade (a tense member): engine trust
//         events with trustWhy, a revert and a rewind take them back, a Director
//         apply lands the owner's numbers.
// Offline: scratch DB, fake clock, mocked Jev, invented names only.
import {
  setupScratchDb, section, check, eq, near, report, exampleWorld, exampleArcSeed, bootLife, stopLife, simulateDays, DAY, HOUR,
} from './_helpers.js';
import { zonedToUnix, dateKey } from '../../src/life/clock.js';
import { appendEvent, getEvent, listEvents, revertEvent, lastEventId } from '../../src/life/eventLog.js';
import { createInitialState, project, rebuild, applyAppended } from '../../src/life/projector.js';
import { castAffinity, setTrustWeight } from '../../src/life/decisions.js';
import { castCard, CARD_MAX } from '../../src/life/innerState.js';
import {
  earnedTrust, planDaily, dailyItems, trustHint, __setTrustForTest, trustEnabled, declinedLeanedGo,
  TRUST_KEPT, TRUST_DECLINED, TRUST_BACKED_OUT, TRUST_OCCASION_SKIP, TRUST_BROKEN_UP, TRUST_FIZZLED,
  TRUST_TENSION_PER_DAY, TRUST_STEADY, TRUST_DAY_CAP, TRUST_LEAN_W, TRUST_HINT_BELOW,
} from '../../src/life/story/cast.js';
import { castOverlay } from '../../src/life/story/fragment.js';
import * as director from '../../src/life/story/director.js';

const H = 3600;
await setupScratchDb();
const WORLD = await exampleWorld();
const SEED = await exampleArcSeed();
const TZ = WORLD.timezone;
const T0 = zonedToUnix(2026, 10, 26, 5, 0, TZ);
const NO = () => () => 0.99;

let nextId = 1;
const ev = (type, at, payload = {}, extra = {}) => ({ id: nextId++, at, type, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false, ...extra });
function baseState() {
  nextId = 1;
  let s = createInitialState(WORLD);
  s = project(s, ev('genesis', T0, { source: 'example', timezone: TZ, self: WORLD.self }), WORLD);
  for (const p of WORLD.places) s = project(s, ev('place.created', T0, p), WORLD);
  for (const c of WORLD.cast) s = project(s, ev('cast.created', T0, c), WORLD);
  for (const id of s.cast.keys()) s.cast.set(id, { ...s.cast.get(id), metrics: { ...s.cast.get(id).metrics, tension: 0 } });
  return s;
}
const FLAT = 'cast:flatmate';
const SIB = 'cast:sibling';
const PARENT = 'cast:parent';
const WAKE = zonedToUnix(2026, 10, 27, 7, 10, TZ);
const AT = WAKE + 5 * 60;                 // the daily pass
const LAST = AT - DAY;                    // the previous pass
const window = (s) => { s.story.daily = { lastDate: '2026-10-26', lastAt: LAST }; s.at = AT; return s; };
const withPlan = (s) => { s.plan = { date: '2026-10-27', wakeAt: WAKE, eventId: 1, blocks: [] }; return s; };
let decId = 500;
// A projection decision (the fold's shape) with the given outcome.
function decision(s, { castIds = [FLAT], options = ['go', 'late', 'stay'], status = 'committed', optionId = 'go', at = AT - 10 * H,
  endAt = AT - 9 * H, reversals = 0, origins = [], category = 'social', arcId = null, invite = false } = {}) {
  const d = {
    id: decId++, kind: 'cafe', status, category, arcId, origins, reversals, invite,
    options: options.map(id => ({ id, label: id, cost: {} })),
    subject: { castIds, eventAt: endAt - 2 * H, endAt },
    committed: optionId ? { optionId, at, by: 'early', eventId: 1 } : null, closedAt: at,
  };
  s.decisions.set(d.id, d);
  return d;
}
const trustOf = (s, id) => s.cast.get(id).metrics.trust;

try {
  section('rules: plans with them');
  {
    const s = window(baseState());
    decision(s, {});
    let t = earnedTrust(s, { at: AT, world: WORLD });
    eq('a kept plan (committed go, ended in the window) → +TRUST_KEPT', t.get(FLAT), { delta: TRUST_KEPT, why: ['kept_plan'] });
    decision(s, { optionId: 'late', endAt: AT - 8 * H });
    eq('… a second kept plan the same day counts once', earnedTrust(s, { at: AT, world: WORLD }).get(FLAT).delta, TRUST_KEPT);
    const s2 = window(baseState());
    decision(s2, { endAt: AT + H });
    eq('… one still to come is not kept yet', earnedTrust(s2, { at: AT, world: WORLD }).size, 0);
    decision(s2, { endAt: LAST - H });
    eq('… one that ended before the last pass is not counted again', earnedTrust(s2, { at: AT, world: WORLD }).size, 0);
    const s3 = window(baseState());
    decision(s3, { status: 'missed' });
    decision(s3, { status: 'cancelled', castIds: [PARENT] });
    eq('a missed plan (could_not_go) and a cancel that was not his → nothing', earnedTrust(s3, { at: AT, world: WORLD }).size, 0);

    const s4 = window(baseState());
    const plain = decision(s4, { optionId: 'stay' });
    eq('a plain decline (stay, never leaned go) → no trust change', earnedTrust(s4, { at: AT, world: WORLD, leanedGo: [] }).size, 0);
    eq('… and none with no lean list at all', earnedTrust(s4, { at: AT, world: WORLD }).size, 0);
    eq('leaned go, then chose stay → −0.01 (declined)', earnedTrust(s4, { at: AT, world: WORLD, leanedGo: [plain.id] }).get(FLAT),
      { delta: -0.01, why: ['declined'] });
    eq('… TRUST_DECLINED is −0.01', TRUST_DECLINED, -0.01);
    const s5 = window(baseState());
    decision(s5, { optionId: 'stay', reversals: 1 });
    eq('reversed a go into stay → TRUST_BACKED_OUT', earnedTrust(s5, { at: AT, world: WORLD }).get(FLAT), { delta: TRUST_BACKED_OUT, why: ['backed_out'] });
    const s6 = window(baseState());
    const c = decision(s6, { status: 'cancelled' });
    eq('an owner cancel of a committed go → TRUST_BACKED_OUT', earnedTrust(s6, { at: AT, world: WORLD, cancelled: [c.id] }).get(FLAT)?.delta, TRUST_BACKED_OUT);
    check('backing out costs more than a kept plan earns', Math.abs(TRUST_BACKED_OUT) > TRUST_KEPT);

    const s7 = window(baseState());
    decision(s7, { options: ['end', 'stay'], optionId: 'stay', category: 'romance' });
    decision(s7, { options: ['step', 'wait'], optionId: 'wait', category: 'romance', castIds: [SIB] });
    eq('a romance "stay" (try to work it out) is never backing out', earnedTrust(s7, { at: AT, world: WORLD }).size, 0);
    const s8 = window(baseState());
    decision(s8, { optionId: 'stay', origins: [{ kind: 'group', jid: '120363000000000101@g.us' }] });
    decision(s8, { optionId: 'go', origins: [{ kind: 'dm', jid: '7101@lid' }], castIds: [SIB] });
    decision(s8, { optionId: 'go', invite: true, castIds: [PARENT] });
    // 020 (decision 15): a chat's nudge doesn't take his own plan out of trust; a plan made in a chat earns nothing for being kept.
    const t8 = earnedTrust(s8, { at: AT, world: WORLD });
    eq('a plan he kept after a chat lean still counts; a plain decline and a kept invitation move nothing', [t8.get(SIB)?.why, t8.get(FLAT), t8.get(PARENT)], [['kept_plan'], undefined, undefined]);
  }

  section('rules: family occasions');
  {
    const s = window(baseState());
    s.story.arcs[77] = { id: 77, category: 'family', kind: 'occasion', status: 'active', castIds: [PARENT, SIB] };
    s.story.arcs[78] = { id: 78, category: 'family', kind: 'major', status: 'active', castIds: [PARENT] };
    const occ = { options: ['attend', 'call', 'skip'], category: 'family', arcId: 77, castIds: [PARENT, SIB] };
    decision(s, { ...occ, optionId: 'skip' });
    const t = earnedTrust(s, { at: AT, world: WORLD });
    eq('occasion skip → TRUST_OCCASION_SKIP for every member of it, once', [t.get(PARENT), t.get(SIB)],
      [{ delta: TRUST_OCCASION_SKIP, why: ['occasion_skipped'] }, { delta: TRUST_OCCASION_SKIP, why: ['occasion_skipped'] }]);
    const s2 = window(baseState());
    s2.story.arcs[77] = s.story.arcs[77];
    s2.story.arcs[78] = s.story.arcs[78];
    decision(s2, { ...occ, optionId: 'call' });
    decision(s2, { options: ['attend', 'skip'], category: 'family', arcId: 78, castIds: [PARENT], optionId: 'skip' });
    eq('occasion call, a major family decision skipped → nothing', earnedTrust(s2, { at: AT, world: WORLD }).size, 0);
    decision(s2, { ...occ, optionId: 'attend' });
    eq('occasion attend → kept', earnedTrust(s2, { at: AT, world: WORLD }).get(PARENT)?.why, ['kept_plan']);
  }

  section('rules: story moments, tension, steady contact');
  {
    const s = window(baseState());
    s.story.arcs[90] = { id: 90, category: 'romance', kind: 'romance', status: 'ended', outcome: 'broken_up', endedAt: AT - H, castIds: [SIB] };
    s.story.arcs[91] = { id: 91, category: 'romance', kind: 'romance', status: 'ended', outcome: 'fizzled', endedAt: AT - H, castIds: [PARENT] };
    s.story.arcs[92] = { id: 92, category: 'romance', kind: 'romance', status: 'ended', outcome: 'fizzled', endedAt: LAST - H, castIds: [FLAT] };
    s.story.arcs[93] = { id: 93, category: 'career', kind: 'hunt', status: 'ended', outcome: 'fizzled', endedAt: AT - H, castIds: ['cast:manager'] };
    const t = earnedTrust(s, { at: AT, world: WORLD });
    eq('broken_up / fizzled in the window; an older one and a career arc → nothing',
      [t.get(SIB)?.delta, t.get(PARENT)?.delta, t.has(FLAT), t.has('cast:manager')], [TRUST_BROKEN_UP, TRUST_FIZZLED, false, false]);

    const s2 = window(baseState());
    s2.cast.set(SIB, { ...s2.cast.get(SIB), metrics: { closeness: 0.7, trust: 0.7, tension: 0.8 } });
    eq('tension > 0.5 → TRUST_TENSION_PER_DAY a day', earnedTrust(s2, { at: AT, world: WORLD }).get(SIB), { delta: TRUST_TENSION_PER_DAY, why: ['tension'] });
    eq('… × days on a gap pass', earnedTrust(s2, { at: AT, days: 3, world: WORLD }).get(SIB).delta, 3 * TRUST_TENSION_PER_DAY);

    const s3 = window(baseState());
    s3.story.together[FLAT] = { openSince: null, minutesSinceDaily: 90 };
    s3.story.together[SIB] = { openSince: AT - 2 * H, minutesSinceDaily: 0, chat: true };
    s3.story.together['cast:manager'] = { openSince: null, minutesSinceDaily: 120 };   // closeness 0.3, trust 0.6: at the ceiling
    const t3 = earnedTrust(s3, { at: AT, world: WORLD });
    eq('an hour+ together → TRUST_STEADY', t3.get(FLAT), { delta: TRUST_STEADY, why: ['steady'] });
    check('chat-origin shared time credits nothing', !t3.has(SIB));
    check('never above closeness + 0.2', !t3.has('cast:manager'));
    s3.cast.set(FLAT, { ...s3.cast.get(FLAT), metrics: { closeness: 0.7, trust: 0.898, tension: 0 } });
    near('… only up to that ceiling', earnedTrust(s3, { at: AT, world: WORLD }).get(FLAT).delta, 0.002, 1e-9);
  }

  section('cap and range');
  {
    const s = window(baseState());
    s.cast.set(SIB, { ...s.cast.get(SIB), metrics: { closeness: 0.7, trust: 0.7, tension: 0.9 } });
    decision(s, { castIds: [SIB], optionId: 'stay', reversals: 1 });
    s.story.arcs[90] = { id: 90, category: 'romance', kind: 'romance', status: 'ended', outcome: 'broken_up', endedAt: AT - H, castIds: [SIB] };
    const t = earnedTrust(s, { at: AT, world: WORLD });
    eq('net change capped at TRUST_DAY_CAP a day', t.get(SIB).delta, -TRUST_DAY_CAP);
    eq('… why lists every rule, biggest first', t.get(SIB).why, ['broken_up', 'backed_out', 'tension']);
    eq('… a gap pass allows TRUST_DAY_CAP × days (here −0.05 − 0.04 − 2 × 0.005)', earnedTrust(s, { at: AT, days: 2, world: WORLD }).get(SIB).delta, -0.1);
    eq('… and caps there', earnedTrust(s, { at: AT, days: 2, world: WORLD, cancelled: [] }).get(SIB).delta >= -2 * TRUST_DAY_CAP, true);
    const s2 = window(baseState());
    s2.cast.set(FLAT, { ...s2.cast.get(FLAT), metrics: { closeness: 0.7, trust: 0.01, tension: 0 } });
    decision(s2, { optionId: 'stay', reversals: 1 });
    eq('never below 0', earnedTrust(s2, { at: AT, world: WORLD }).get(FLAT).delta, -0.01);
  }

  section('the daily pass: one relationship.changed per member, controls, counts');
  {
    const s = withPlan(window(baseState()));
    s.cast.set(SIB, { ...s.cast.get(SIB), metrics: { closeness: 0.7, trust: 0.7, tension: 0.8 } });
    decision(s, { optionId: 'stay', reversals: 1 });
    const p = planDaily(s, { date: '2026-10-27', at: AT, world: WORLD, seed: SEED, rngFor: NO });
    const rc = p.events.filter(e => e.type === 'relationship.changed');
    const flat = rc.filter(e => e.payload.castId === FLAT);
    eq('a trust-only member: one event, reason = its rule, trustWhy', flat.map(e => e.payload),
      [{ castId: FLAT, delta: { trust: TRUST_BACKED_OUT }, reason: 'backed_out', trustWhy: ['backed_out'] }]);
    const sib = rc.filter(e => e.payload.castId === SIB);
    eq('drift + trust merge: one event, the drift reason, both deltas', sib.map(e => [e.payload.reason, e.payload.delta.tension, e.payload.delta.trust, e.payload.trustWhy]),
      [['drift', -0.01, TRUST_TENSION_PER_DAY, ['tension']]]);
    check('every event is engine, no cause', rc.every(e => e.actor === 'engine' && e.causeId === undefined));
    eq('counts.trust', p.counts.trust, 2);
    eq('deterministic: the same projection plans the same pass', JSON.stringify(planDaily(s, { date: '2026-10-27', at: AT, world: WORLD, seed: SEED, rngFor: NO })), JSON.stringify(p));

    const pinned = structuredClone(s);
    pinned.story.controls.pins[FLAT] = { eventId: 1, at: T0 };
    check('a pinned member gets no trust change', !planDaily(pinned, { date: '2026-10-27', at: AT, world: WORLD, seed: SEED, rngFor: NO }).events.some(e => e.payload?.castId === FLAT));
    const frozen = structuredClone(s);
    frozen.story.controls.fate.cast = 'frozen';
    check('cast frozen: no trust change at all', !planDaily(frozen, { date: '2026-10-27', at: AT, world: WORLD, seed: SEED, rngFor: NO }).events.some(e => 'trust' in (e.payload?.delta ?? {})));

    const [item] = dailyItems(s, AT + H, WORLD, SEED, { rngFor: NO, recordRefusal: () => {}, listActivities: () => [], listCancelled: () => [] });
    const out = [];
    await item.run((e) => { out.push(e); return { ...e, id: 9000 + out.length }; });
    eq('the marker counts the trust changes', out.at(-1).payload.counts.trust, 2);

    __setTrustForTest(false);
    check('the switch: off → no earned trust, no counts.trust', !trustEnabled() && earnedTrust(s, { at: AT, world: WORLD }).size === 0
      && planDaily(s, { date: '2026-10-27', at: AT, world: WORLD, seed: SEED, rngFor: NO }).counts.trust === undefined);
    __setTrustForTest(true);
  }

  section('effects: decisions lean, the card hint');
  {
    const s = baseState();
    const d = { subject: { castIds: [FLAT] } };
    s.cast.set(FLAT, { ...s.cast.get(FLAT), metrics: { closeness: 0.6, trust: 0.9, tension: 0.1 } });
    near('without the seam: closeness − tension (009)', castAffinity(d, s), 0.5);
    setTrustWeight(() => TRUST_LEAN_W);
    near('with it: + w × (trust − 0.5)', castAffinity(d, s), 0.5 + TRUST_LEAN_W * 0.4);
    s.cast.set(FLAT, { ...s.cast.get(FLAT), metrics: { closeness: 0.6, trust: 0.1, tension: 0.1 } });
    near('… lower with low trust', castAffinity(d, s), 0.5 - TRUST_LEAN_W * 0.4);
    s.cast.set(FLAT, { ...s.cast.get(FLAT), metrics: { closeness: 0.6, trust: 0.5, tension: 0.1 } });
    near('… neutral at 0.5', castAffinity(d, s), 0.5);
    setTrustWeight(null);

    const m = { ...s.cast.get('cast:coworker-a'), metrics: { closeness: 0.5, trust: 0.2, tension: 0 } };
    eq('the hint uses their pronouns', [trustHint(m), trustHint({ ...m, pronouns: 'he/him' }), trustHint({ ...m, pronouns: 'they/them' })],
      ['not sure you can count on her', 'not sure you can count on him', 'not sure you can count on them']);
    eq(`no hint at or above ${TRUST_HINT_BELOW}`, trustHint({ ...m, metrics: { trust: TRUST_HINT_BELOW } }), null);
    const st = baseState();
    st.cast.set(m.id, m);
    eq('the overlay carries it', castOverlay(st, m.id)?.hint, 'not sure you can count on her');
    check('… not for a trusted member', !('hint' in castOverlay(st, FLAT)));
    const long = { ...m, personality: 'x'.repeat(200), status: 'y'.repeat(160) };
    const card = castCard(long, { hint: trustHint(long) });
    check(`the card ends with the hint and stays ≤ ${CARD_MAX}`, card.endsWith('not sure you can count on her') && card.length <= CARD_MAX, card);
    eq('a card without a hint is unchanged', castCard(long, {}), castCard(long, null));
  }

  section('owner: cast.metrics');
  {
    const s = baseState();
    director.__setDepsForTest({ world: WORLD, knownNames: () => [], now: () => T0 + H });
    const p = director.plan({ kind: 'cast.metrics', castId: PARENT, trust: 0.1, closeness: 0.75 }, s, { now: T0 + H });
    const rc = p.events.filter(e => e.type === 'relationship.changed');
    eq('0.9 → 0.1 in 4 owner steps of −0.2 (closeness spread over them)', rc.map(e => [e.actor, e.payload.reason, e.payload.delta.trust, e.payload.step, e.payload.steps]),
      [1, 2, 3, 4].map(i => ['owner', 'owner', -0.2, i, 4]));
    check('every step within the reducer clamp', rc.every(e => Object.values(e.payload.delta).every(v => Math.abs(v) <= 0.2 + 1e-9)));
    eq('the preview diff shows the member', p.diff.map(x => x.path).sort(), [`${PARENT}.metrics.closeness`, `${PARENT}.metrics.trust`]);
    check('the preview state lands on the targets (to float precision)', Math.abs(p.after[PARENT].metrics.trust - 0.1) < 1e-9
      && Math.abs(p.after[PARENT].metrics.closeness - 0.75) < 1e-9, p.after[PARENT].metrics);
    check('… caused by the director.action', rc.every(e => e.causeRef === p.events[0].ref) && p.events[0].type === 'director.action');
    const one = director.plan({ kind: 'cast.metrics', castId: FLAT, tension: 0.15 }, s, { now: T0 + H });
    eq('a small change is one event without step fields', one.events.filter(e => e.type === 'relationship.changed').map(e => e.payload),
      [{ castId: FLAT, delta: { tension: 0.15 }, reason: 'owner' }]);
    const same = director.plan({ kind: 'cast.metrics', castId: FLAT, trust: 0.7 }, s, { now: T0 + H });
    eq('nothing to change → refused (nothing), no events', [same.events.length, same.refusals[0]?.reason], [0, 'nothing']);
    const pin = structuredClone(s);
    pin.story.controls.pins[FLAT] = { eventId: 1, at: T0 };
    eq('a pinned member → refused (pinned)', director.plan({ kind: 'cast.metrics', castId: FLAT, trust: 0.2 }, pin, { now: T0 + H }).refusals[0]?.reason, 'pinned');
    const code = (a) => { try { director.plan(a, s, { now: T0 + H }); return null; } catch (e) { return `${e.code}:${e.reason}`; } };
    eq('bad numbers / no numbers / unknown member', [code({ kind: 'cast.metrics', castId: FLAT, trust: 1.5 }), code({ kind: 'cast.metrics', castId: FLAT }),
      code({ kind: 'cast.metrics', castId: 'cast:nobody', trust: 0.2 })], ['invalid:bad_trust', 'invalid:bad_fields', 'not_found:cast']);
    director.__setDepsForTest(null);
  }

  section('the log: the real pulse, revert and rewind take earned trust back');
  {
    const world = structuredClone(WORLD);
    world.cast.find(c => c.id === SIB).metrics.tension = 0.9;
    const booted = await bootLife({ world });
    await simulateDays(3);
    await stopLife();
    let state = rebuild({ world });
    const rows = listEvents({ types: ['relationship.changed'], limit: 500 }).filter(e => e.payload?.castId === SIB && 'trust' in e.payload.delta);
    check(`engine trust changes for the tense member (${rows.length})`, rows.length >= 2 && rows.every(e => e.actor === 'engine' && e.originKind === 'self'
      && e.payload.trustWhy.includes('tension') && e.payload.delta.trust < 0));
    const before = trustOf(state, SIB);
    near('trust fell by their sum', before, 0.7 + rows.reduce((a, e) => a + e.payload.delta.trust, 0), 1e-6);
    check('nothing came from a chat', listEvents({ types: ['relationship.changed'], limit: 500 }).every(e => e.originKind === 'self' || e.originKind === 'owner'));

    const last = rows.at(-1);
    revertEvent(last.id, { reason: 'test', at: booted.clock.now() });
    state = rebuild({ world });
    near('a revert takes that change back', trustOf(state, SIB), before - last.payload.delta.trust, 1e-6);

    const append = (spec) => { const e = appendEvent(spec); state = applyAppended(state, e, { world }); return e; };
    director.__setDepsForTest({
      now: () => booted.clock.now(), getState: () => state, world, append, pulse: { rebase: () => {} },
      knownNames: () => [], seed: () => SEED, countSelfReplies: () => 0, chatName: () => 'Chat',
    });
    const target = rows[0];
    const rw = await director.preview({ kind: 'rewind', at: target.at - 60, reason: 'before the first trust change' });
    await director.apply(rw.previewId, rw.fingerprint, { by: 'tester' });
    state = rebuild({ world });
    near('a rewind before the first change restores the seed trust', trustOf(state, SIB), 0.7, 1e-6);

    const pv = await director.preview({ kind: 'cast.metrics', castId: SIB, trust: 0.25, tension: 0.4 });
    const res = await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
    const owned = res.eventIds.map(id => getEvent(id)).filter(e => e.type === 'relationship.changed');
    check('the Director apply appends owner relationship changes', owned.length === 3 && owned.every(e => e.actor === 'owner' && e.originKind === 'owner' && e.payload.reason === 'owner'));
    state = rebuild({ world });
    check('… and the member has the owner\'s numbers', Math.abs(trustOf(state, SIB) - 0.25) < 1e-9 && Math.abs(state.cast.get(SIB).metrics.tension - 0.4) < 1e-9);
    eq('the hint now shows on their card (trust < 0.3)', castOverlay(state, SIB).hint, 'not sure you can count on him');
    check('nothing else wrote meanwhile', lastEventId() === res.eventIds.at(-1));

    // The default lean reader: only a decline that leaned go before counts.
    const now = booted.clock.now();
    const plan = (castIds) => append({
      type: 'decision.opened', at: now, actor: 'engine',
      payload: { kind: 'cafe', subject: { eventAt: now + 5 * HOUR, placeId: 'place:cafe', castIds }, opensAt: now, decideBy: now + 4 * HOUR, ponrAt: now + 4 * HOUR + 1200, mode: 'auto',
        options: [{ id: 'go', label: 'Go', cost: {}, expiresAt: now + 4 * HOUR + 1200 }, { id: 'late', label: 'Join later', cost: {} }, { id: 'stay', label: 'Stay in', cost: {} }] },
    });
    const lean = (d, optionId, at) => append({ type: 'decision.lean', at, actor: 'engine', causeId: d.id, payload: { decisionId: d.id, optionId, p: 0.6, probs: { [optionId]: 0.6 }, trigger: 'new_info' } });
    const commit = (d, l, at) => append({ type: 'decision.committed', at, actor: 'engine', causeId: l.id, payload: { decisionId: d.id, optionId: 'stay', p: 0.6, sampled: false } });
    const wavered = plan([FLAT]);
    lean(wavered, 'go', now + 60);
    commit(wavered, lean(wavered, 'stay', now + 120), now + 120);
    const flat = plan(['cast:coworker-a']);
    commit(flat, lean(flat, 'stay', now + 60), now + 60);
    eq('declinedLeanedGo reads the log: only the decline that leaned go first', declinedLeanedGo(state, now + 600, {}), [wavered.id]);
    const t = earnedTrust(state, { at: now + 600, world, leanedGo: declinedLeanedGo(state, now + 600, {}) });
    eq('… −0.01 for that member, nothing for the plain decline', [t.get(FLAT)?.delta, t.has('cast:coworker-a')], [-0.01, false]);
    eq('… none under sim (no I/O)', declinedLeanedGo(state, now + 600, { sim: true }), []);
    director.__setDepsForTest(null);
    void HOUR; void DAY; void dateKey;
  }
} catch (err) {
  check(`no exception (${err?.stack ?? err})`, false);
}
report();
