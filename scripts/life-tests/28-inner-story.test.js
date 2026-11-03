// 010 T012 — the inner-state and vitals seams (src/life/innerState.js,
// src/life/vitals.js; story-api §3.5/§3.6, research R3/R4/R21). Scratch DB
// (real events, so the default origin lookup is exercised), fake clock,
// example world; no network, no LLM.
//
//   - owner-origin facts: an owner scene is visible in every audience; one with
//     a real-person subject only where that person is;
//   - the story fragment: ≤ 80 chars, sanitized, inside the 240 cap, dropped in
//     tone and embargo modes, '' / a throw / the default leave the line as today;
//   - the decision filter: an open arc decision's lean is absent from a group
//     line under the story filter and present with the default;
//   - the per-block origin of nextFragment; the cast overlay; relation labels;
//   - vitals.nudged / family.call: bounded.
import { setupScratchDb, fakeClock, section, check, eq, near, report } from './_helpers.js';
import { setClock, atLocal, hhmm } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended } from '../../src/life/projector.js';
import { EMBARGO_TONE } from '../../src/life/embargo.js';
import { applyEvent, normalizeVitals, NUDGE_MAX, NUDGE_VALENCE_MAX, FAMILY_CALL_STRESS_MAX } from '../../src/life/vitals.js';
import {
  INNER_MAX, CARD_MAX, STORY_FRAGMENT_MAX, innerStateLine, castCards, castCard, factAllowed, eventAllowed,
  setStoryFragment, setCastOverlay, setDecisionFilter, setBlockOrigin, setCanUseIn, callStateNote,
} from '../../src/life/innerState.js';

await setupScratchDb();
setRngSeed(7);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const TZ = createInitialState(world).world.timezone;
const T0 = atLocal(Date.UTC(2026, 9, 28, 6, 0) / 1000, '09:00', TZ); // Wed 28 Oct, 09:00 local
const clock = fakeClock(T0);
setClock(clock.fn);
const MIN = 60;
const H = 3600;
const GROUP_X = '120363000000000001@g.us';
const GROUP_Y = '120363000000000002@g.us';
const ALICE = '15550000001@s.whatsapp.net';
const BOB = '15550000002@s.whatsapp.net';
const audX = { chatJid: GROUP_X, kind: 'group', members: new Set([ALICE]) };
const audY = { chatJid: GROUP_Y, kind: 'group', members: new Set([BOB]) };
const dmA = { chatJid: ALICE, kind: 'dm', personJid: ALICE, members: new Set([ALICE]) };
const dmB = { chatJid: BOB, kind: 'dm', personJid: BOB, members: new Set([BOB]) };
const callB = { chatJid: BOB, kind: 'call', personJid: BOB, members: new Set([BOB]) };
const ALL = { audX, audY, dmA, dmB, callB };

let live = createInitialState(world);
const add = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  return ev;
};
const at = (min) => T0 + min * MIN;
const has = (s, w) => s.toLowerCase().includes(w.toLowerCase());

try {
  const genesis = add({ type: 'genesis', at: T0 - H, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) add({ type: 'place.created', at: T0 - H, actor: 'engine', causeId: genesis.id, payload: p });
  for (const c of world.cast) add({ type: 'cast.created', at: T0 - H, actor: 'engine', causeId: genesis.id, payload: c });

  section('owner-origin facts (research R3)');
  const scene = add({ type: 'activity.started', at: at(0), actor: 'owner',
    payload: { kind: 'walk', placeId: 'place:park', end: at(60), availability: 'free', withCast: [] } });
  eq('an owner scene is stored with the owner origin', [scene.originKind, scene.originJid], ['owner', 'owner']);
  for (const [name, aud] of Object.entries(ALL)) {
    check(`owner scene visible in ${name}`, has(innerStateLine(live, at(10), aud), 'out for a walk'), innerStateLine(live, at(10), aud));
  }
  check('… and in the call note', has(callStateNote(live, at(10), callB), 'walk'));
  check('factAllowed: owner, no subject → everywhere', Object.values(ALL).every(a => factAllowed({ originJid: 'owner' }, a)));
  setCanUseIn(() => false);
  check('… without asking the audience rule (validated fiction, no chat content)', factAllowed({ originJid: 'owner' }, audY));
  setCanUseIn(null);

  const withAlice = add({ type: 'activity.started', at: at(70), actor: 'owner', subjectJid: ALICE,
    payload: { kind: 'cafe', placeId: 'place:cafe', end: at(130), availability: 'light', withCast: [] } });
  eq('an owner scene naming a real person keeps the subject', withAlice.subjectJid, ALICE);
  const vis = Object.fromEntries(Object.entries(ALL).map(([n, a]) => [n, has(innerStateLine(live, at(80), a), 'café')]));
  eq('… visible only with that person (her DM, the group she is in)', vis, { audX: true, audY: false, dmA: true, dmB: false, callB: false });
  check('… the line elsewhere keeps his tone', innerStateLine(live, at(80), audY).length > 0);
  check('factAllowed: owner + subject follows subjectVisible', factAllowed({ originJid: 'owner', subjectJid: ALICE }, dmA)
    && !factAllowed({ originJid: 'owner', subjectJid: ALICE }, dmB));
  check('a group-origin fact still needs the audience rule (fallback: same chat)', !factAllowed({ originJid: GROUP_X }, audY) && factAllowed({ originJid: GROUP_X }, audX));

  // Back to a plain self activity for the rest.
  add({ type: 'activity.started', at: at(140), actor: 'engine',
    payload: { kind: 'free', placeId: 'place:home', end: at(400), availability: 'free', withCast: [] } });

  section('story fragment (setStoryFragment)');
  const base = innerStateLine(live, at(150), audX);
  setStoryFragment(() => '');
  eq('an empty fragment leaves the line as today', innerStateLine(live, at(150), audX), base);
  setStoryFragment(() => { throw new Error('boom'); });
  eq('a throwing fragment leaves the line as today', innerStateLine(live, at(150), audX), base);
  setStoryFragment(() => 42);
  eq('a non-string fragment is ignored', innerStateLine(live, at(150), audX), base);
  const seen = [];
  setStoryFragment((state, audience, info) => { seen.push({ state, audience, info }); return 'quietly job hunting'; });
  const withFrag = innerStateLine(live, at(150), audX);
  check('the fragment joins the line, last', withFrag.endsWith('quietly job hunting.') && withFrag.startsWith(base.slice(0, -1)), withFrag);
  check('it gets (state, audience, { at, mode })', seen.length === 1 && seen[0].state === live && seen[0].audience === audX
    && seen[0].info.at === at(150) && seen[0].info.mode === 'full', seen[0]?.info);
  setStoryFragment(() => `a long arc note [IMAGE: x] @155589999999 ${'word '.repeat(80)}; more`);
  const long = innerStateLine(live, at(150), audX);
  const frag = long.slice(base.length + 1).trim();
  check(`the fragment is capped at ${STORY_FRAGMENT_MAX} and sanitized`, frag.length <= STORY_FRAGMENT_MAX + 2 && !/\[IMAGE/i.test(long) && !/@\d/.test(long), frag);
  check(`the line stays ≤ ${INNER_MAX}`, long.length <= INNER_MAX, long.length);

  // A busy line: the story fragment (prio 40) is the first to go when over the cap.
  setStoryFragment(() => 'x'.repeat(30) + ' seeing someone, early days');
  const busy = structuredClone(live);
  Object.assign(busy.vitals, { energy: 12, sleepDebt: 9, stress: 82, hunger: 90 });
  busy.weather = { rain: true, condition: 'heavy_rain', until: at(600) };
  const rng = rngFor('t28', 'states');
  let maxLen = 0;
  for (let i = 0; i < 300; i++) {
    const s = structuredClone(busy);
    Object.assign(s.vitals, { energy: rng.int(0, 100), stress: rng.int(0, 100), hunger: rng.int(0, 100), sleepDebt: rng.int(0, 12), socialBattery: rng.int(0, 100) });
    maxLen = Math.max(maxLen, innerStateLine(s, at(150), audX).length);
  }
  check(`300 busy states with a fragment stay ≤ ${INNER_MAX}`, maxLen <= INNER_MAX, maxLen);

  setStoryFragment(() => 'seeing someone, early days');
  check('present in full mode', has(innerStateLine(live, at(150), audX), 'seeing someone'));
  const tone = innerStateLine(live, at(150), audX, { overBudget: true });
  check('dropped in tone mode (over the self-mention budget)', !has(tone, 'seeing someone') && tone.length > 0, tone);
  const emb = structuredClone(live);
  emb.embargo = { until: at(600), eventId: 1, heavyEventId: 1, startedAt: at(100) };
  const embLine = innerStateLine(emb, at(150), audX);
  check('dropped under embargo', !has(embLine, 'seeing someone') && embLine.includes(EMBARGO_TONE), embLine);
  check('the dashboard sees it too (full mode)', has(innerStateLine(live, at(150), { kind: 'dashboard' }), 'seeing someone'));
  setStoryFragment(null);
  eq('null restores the default', innerStateLine(live, at(150), audX), base);

  section('decision filter (setDecisionFilter)');
  const arc = add({ type: 'decision.opened', at: at(160), actor: 'engine', payload: {
    kind: 'romance:step', subject: { eventAt: at(3000), placeId: null, castIds: [] },
    decideBy: at(2900), ponrAt: at(2950), mode: 'ask',
    options: [{ id: 'step', label: 'ask them to be exclusive' }, { id: 'wait', label: 'give it more time' }] } });
  add({ type: 'decision.lean', at: at(161), actor: 'jev', causeId: arc.id, payload: { decisionId: arc.id, optionId: 'step', p: 0.6 } });
  const lineDefault = innerStateLine(live, at(170), audX);
  check('default (009): the open decision\'s lean is in a group line', has(lineDefault, 'exclusive'), lineDefault);
  const categoryOf = (d) => d.category ?? (String(d.kind).includes(':') ? String(d.kind).split(':')[0] : 'social');
  const filterArgs = [];
  setDecisionFilter((d, state, aud) => { filterArgs.push([d.id, state === live, aud]); return categoryOf(d) === 'social'; });
  const lineFiltered = innerStateLine(live, at(170), audX);
  check('story filter: the arc decision\'s lean is absent from the group line', !has(lineFiltered, 'exclusive') && !has(lineFiltered, 'romance'), lineFiltered);
  check('… and from a DM line too', !has(innerStateLine(live, at(170), dmA), 'exclusive'));
  check('the filter gets (decision, state, audience)', filterArgs.some(([id, st, aud]) => id === arc.id && st && aud === audX));
  const social = add({ type: 'decision.opened', at: at(162), actor: 'engine', payload: {
    kind: 'movie', subject: { eventAt: at(2000), placeId: 'place:cinema', castIds: [] },
    decideBy: at(1900), ponrAt: at(1950), options: [{ id: 'go', label: 'catch the late show' }, { id: 'skip', label: 'stay in' }] } });
  add({ type: 'decision.lean', at: at(163), actor: 'jev', causeId: social.id, payload: { decisionId: social.id, optionId: 'go', p: 0.6 } });
  check('… a social decision still shows under the filter', has(innerStateLine(live, at(170), audX), 'late show'));
  setDecisionFilter(() => { throw new Error('boom'); });
  const thrown = innerStateLine(live, at(170), audX);
  check('a throwing filter drops the decisions (fail closed)', !has(thrown, 'exclusive') && !has(thrown, 'late show'), thrown);
  setDecisionFilter(() => 'yes');
  check('only a literal true keeps a decision', !has(innerStateLine(live, at(170), audX), 'late show'));
  setDecisionFilter(null);
  const restored = innerStateLine(live, at(170), audX);
  check('null restores the default (the soonest lean shows again)', has(restored, 'late show') || has(restored, 'exclusive'), restored);

  section('per-block origin (setBlockOrigin)');
  // A plan amended from a chat in group X: by default every block is the plan's.
  const trig = add({ type: 'chat.trigger', at: at(400), actor: 'chat', originKind: 'group', originJid: GROUP_X, payload: { kind: 'plan' } });
  const selfPlan = add({ type: 'plan.made', at: at(399), actor: 'engine', payload: {
    date: '2026-10-28', dayType: 'wfh', wakeAt: at(-120), sleepAt: at(900), nextWakeAt: at(1400),
    blocks: [{ kind: 'meeting', placeId: 'place:home', start: at(450), end: at(480), availability: 'meeting', withCast: [] }] } });
  const chatPlan = add({ type: 'plan.made', at: at(400), actor: 'engine', causeId: trig.id, payload: {
    date: '2026-10-28', dayType: 'wfh', wakeAt: at(-120), sleepAt: at(900), nextWakeAt: at(1400), basePlanEventId: selfPlan.id,
    blocks: [
      { kind: 'meeting', placeId: 'place:home', start: at(450), end: at(480), availability: 'meeting', withCast: [] },
      { kind: 'dinner', placeId: 'place:restaurant', start: at(520), end: at(580), availability: 'light', withCast: ['cast:flatmate'], fromAmendment: true },
    ] } });
  eq('the amended plan carries group X\'s origin', chatPlan.originJid, GROUP_X);
  add({ type: 'activity.started', at: at(401), actor: 'engine', causeId: selfPlan.id,
    payload: { kind: 'free', placeId: 'place:home', end: at(450), availability: 'free', withCast: [] } });
  check('default: in X the next block shows', has(innerStateLine(live, at(410), audX), 'a meeting at'));
  check('default: in Y the whole plan is hidden (today)', !has(innerStateLine(live, at(410), audY), 'meeting at'));
  // The story layer's rule (R4): adopted blocks → the amended plan, the rest → the base plan.
  const isAdopted = (b) => b.kind === 'dinner'; // the projector keeps fromAmendment once T009 lands; keyed on the block here
  setBlockOrigin((plan, b) => (isAdopted(b) ? plan.eventId : selfPlan.id));
  check('story: in Y the self meeting shows', has(innerStateLine(live, at(410), audY), `a meeting at ${hhmm(at(450), TZ)}`));
  check('story: in Y the adopted dinner never shows', !has(innerStateLine(live, at(470), audY), 'dinner'), innerStateLine(live, at(470), audY));
  check('story: in X the adopted dinner shows', has(innerStateLine(live, at(470), audX), 'dinner with'), innerStateLine(live, at(470), audX));
  setBlockOrigin(() => { throw new Error('boom'); });
  check('a throwing block-origin drops the block (fail closed)', !has(innerStateLine(live, at(410), audX), 'meeting at'));
  setBlockOrigin(() => 'nope');
  check('a junk id drops the block', !has(innerStateLine(live, at(410), audX), 'meeting at'));
  setBlockOrigin(null);
  check('null restores the default', has(innerStateLine(live, at(410), audX), 'a meeting at') && !has(innerStateLine(live, at(410), audY), 'meeting at'));
  const subj = structuredClone(live);
  subj.plan.blocks[0].subjectJid = BOB;
  setBlockOrigin(() => selfPlan.id);
  check('a block with a real-person subject shows only where that person is', has(innerStateLine(subj, at(410), audY), 'meeting at')
    && !has(innerStateLine(subj, at(410), audX), 'meeting at'));
  setBlockOrigin(null);

  section('learnedAt = the chat evidence time (review regression)');
  // 006's join-time floor: a Y member who joined X after the chat line must not
  // see a fact derived from it. The life event's own time is later than the line.
  const JOIN = at(600);
  const seenAt = [];
  setCanUseIn((item, aud) => {
    seenAt.push(item.learnedAt);
    return aud.chatJid === item.originJid || (aud.chatJid === GROUP_Y && item.originJid === GROUP_X && JOIN <= item.learnedAt);
  });
  const root = add({ type: 'chat.trigger', at: at(500), actor: 'chat', originKind: 'group', originJid: GROUP_X, payload: { kind: 'plan' } });
  const late = add({ type: 'plan.made', at: at(700), actor: 'engine', causeId: root.id, payload: {
    date: '2026-10-28', dayType: 'wfh', wakeAt: at(-120), sleepAt: at(900), nextWakeAt: at(1400), basePlanEventId: selfPlan.id,
    blocks: [{ kind: 'dinner', placeId: 'place:restaurant', start: at(760), end: at(820), availability: 'light', withCast: ['cast:flatmate'], fromAmendment: true }] } });
  eq('the late plan inherits X', late.originJid, GROUP_X);
  seenAt.length = 0;
  const yLine = innerStateLine(live, at(710), audY);
  check('a block applied after the member joined, from a line before it, stays out of Y', !has(yLine, 'dinner'), yLine);
  check('… the rule saw the chat line\'s time, not the plan\'s', seenAt.includes(at(500)) && !seenAt.includes(at(700)), seenAt);
  check('… and X still sees it', has(innerStateLine(live, at(710), audX), 'dinner with'));
  const dec = add({ type: 'decision.opened', at: at(705), actor: 'engine', payload: {
    kind: 'gym', subject: { eventAt: at(1100), placeId: null, castIds: [] },
    decideBy: at(1000), ponrAt: at(1050), options: [{ id: 'go', label: 'hit the gym after all' }, { id: 'skip', label: 'skip the gym' }] } });
  const trig2 = add({ type: 'chat.trigger', at: at(560), actor: 'chat', originKind: 'group', originJid: GROUP_X, payload: { kind: 'decision', decisionId: dec.id } });
  add({ type: 'decision.lean', at: at(706), actor: 'jev', causeId: trig2.id, payload: { decisionId: dec.id, optionId: 'go', p: 0.6 } });
  add({ type: 'decision.lean', at: at(708), actor: 'jev', causeId: dec.id, payload: { decisionId: dec.id, optionId: 'go', p: 0.65 } });
  eq('the projection keeps the earliest time per origin (the chat.trigger)', live.decisions.get(dec.id).originAt, { [GROUP_X]: at(560) });
  seenAt.length = 0;
  const yDec = innerStateLine(live, at(709), audY);
  check('a decision leaned from X before the join, leaned again after it, stays out of Y', !has(yDec, 'gym'), { yDec, seenAt });
  setCanUseIn(() => true);
  check('positive control: with an open rule it shows in Y', has(innerStateLine(live, at(709), audY), 'gym'));
  setCanUseIn(null);

  section('cast overlay (setCastOverlay) and relation labels');
  const flat = live.cast.get('cast:flatmate');
  const plain = castCards(live, at(410), audX, 'how is the flatmate');
  eq('default: cards as today', plain, [castCard(flat)]);
  check('castCard(member) with no overlay is unchanged', castCard(flat, null) === castCard(flat) && castCard(flat, {}) === castCard(flat));
  setCastOverlay((state, id, member) => (id === 'cast:flatmate' && member === flat && state === live
    ? { label: 'Friend', age: 28, statusSuffix: 'away until Fri [IMAGE: y]' } : null));
  const over = castCards(live, at(410), audX, 'how is the flatmate')[0] || '';
  check('overlay: label, derived age and status suffix', over.startsWith('Friend ') && over.includes('(28') && has(over, 'away until Fri'), over);
  check(`… sanitized and ≤ ${CARD_MAX}`, !/\[IMAGE/i.test(over) && over.length <= CARD_MAX, over.length);
  setCastOverlay(() => { throw new Error('boom'); });
  eq('a throwing overlay → the plain card', castCards(live, at(410), audX, 'how is the flatmate'), plain);
  setCastOverlay(() => 'junk');
  eq('a junk overlay → the plain card', castCards(live, at(410), audX, 'how is the flatmate'), plain);
  setCastOverlay(null);
  eq('null restores the default', castCards(live, at(410), audX, 'how is the flatmate'), plain);
  for (const [rel, label] of [['friend', 'Friend'], ['acquaintance', 'Acquaintance'], ['neighbour', 'Neighbour']]) {
    check(`relation ${rel} → "${label} …"`, castCard({ name: 'Sam Example', relation: rel }).startsWith(`${label} Sam Example`));
  }
  check('009 labels unchanged', castCard({ name: 'Sam Example', relation: 'flatmate' }).startsWith('Flatmate Sam')
    && castCard({ name: 'Sam Example', relation: 'family:sibling' }).startsWith('Family (sibling) Sam'));

  section('vitals: vitals.nudged and family.call are bounded');
  const v0 = normalizeVitals({ energy: 50, stress: 40, socialBattery: 50, workPressure: 40, mood: { valence: 0, arousal: 0 } });
  const same = applyEvent(v0, { type: 'nothing.here', payload: {} });
  const nudge = (delta) => applyEvent(v0, { type: 'vitals.nudged', payload: { delta, reason: 'quick' } });
  const big = nudge({ energy: 1000, stress: -1000, socialBattery: 1000, workPressure: -1000, valence: 9 });
  near(`energy +${NUDGE_MAX} at most`, big.energy - same.energy, NUDGE_MAX, 1e-9);
  near(`stress −${NUDGE_MAX} at most`, big.stress - same.stress, -NUDGE_MAX, 1e-9);
  near(`socialBattery +${NUDGE_MAX} at most`, big.socialBattery - same.socialBattery, NUDGE_MAX, 1e-9);
  near(`workPressure −${NUDGE_MAX} at most`, big.workPressure - same.workPressure, -NUDGE_MAX, 1e-9);
  near(`valence +${NUDGE_VALENCE_MAX} at most`, big.mood.valence - same.mood.valence, NUDGE_VALENCE_MAX, 1e-9);
  const small = nudge({ energy: -7, valence: -0.1 });
  near('a small nudge is applied as given', small.energy - same.energy, -7, 1e-9);
  near('… valence too', small.mood.valence - same.mood.valence, -0.1, 1e-9);
  eq('junk / missing deltas move nothing', JSON.stringify(nudge({ energy: 'x', stress: null })), JSON.stringify(same));
  eq('a redacted nudge moves nothing', JSON.stringify(applyEvent(v0, { type: 'vitals.nudged', payload: { redacted: true } })), JSON.stringify(same));
  const hi = normalizeVitals({ ...v0, stress: 95 });
  check('the result stays in range', applyEvent(hi, { type: 'vitals.nudged', payload: { delta: { stress: 30 } } }).stress <= 100);

  const call = (payload) => applyEvent(v0, { type: 'family.call', payload }).stress - same.stress;
  near(`family.call: intensity 1 × pressure 1 → +${FAMILY_CALL_STRESS_MAX}`, call({ castId: 'cast:parent', intensity: 1, pressure: 1 }), FAMILY_CALL_STRESS_MAX, 1e-9);
  near('intensity 0.5 × pressure 0.4 → +2', call({ intensity: 0.5, pressure: 0.4 }), 2, 1e-9);
  near('pressure above 1 (pressureFactor × slider) counts: 0.5 × 1.5 → +7.5', call({ intensity: 0.5, pressure: 1.5 }), 7.5, 1e-9);
  near(`out-of-range inputs are clamped (≤ +${FAMILY_CALL_STRESS_MAX})`, call({ intensity: 7, pressure: 9 }), FAMILY_CALL_STRESS_MAX, 1e-9);
  near('no pressure in the payload → intensity × 10', call({ intensity: 0.3 }), 3, 1e-9);
  near('no intensity → nothing', call({ pressure: 1 }), 0, 1e-9);
  near('a redacted call → nothing', call({ redacted: true }), 0, 1e-9);
  check('family.call moves only stress', (() => {
    const c = applyEvent(v0, { type: 'family.call', payload: { intensity: 1, pressure: 1 } });
    return c.energy === same.energy && c.mood.valence === same.mood.valence && c.workPressure === same.workPressure;
  })());
  eq('activity.recorded moves no vitals (FR-030)', JSON.stringify(applyEvent(v0, { type: 'activity.recorded', payload: { kind: 'walk' } })), JSON.stringify(same));

  // Through the projector's fold, as appended events.
  const stressBefore = live.vitals.stress;
  add({ type: 'vitals.nudged', at: at(420), actor: 'owner', payload: { delta: { stress: 500 }, reason: 'quick' } });
  const afterNudge = live.vitals.stress;
  check(`a folded owner nudge is bounded (Δstress ≤ ${NUDGE_MAX} + integration)`, afterNudge - stressBefore <= NUDGE_MAX + 2 && afterNudge > stressBefore,
    { before: stressBefore, after: afterNudge });
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}
report();
