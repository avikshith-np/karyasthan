// Plan 020 B, the nightly update: bounded, recomputable, explainable. A stub life hands in the events; the real log is
// arcs-tests/99-stance-live. Each case is one from the brief.
import { setupScratchDb, fakeClock, blockNetwork, section, check, eq, report, DAY } from './_helpers.js';

await setupScratchDb();
const net = blockNetwork();
const store = await import('../../src/mind/store.js');
const stance = await import('../../src/mind/stance.js');
const rules = await import('../../src/mind/stanceRules.js');
const clock = fakeClock(Date.UTC(2026, 9, 27, 20, 0) / 1000);
store.setStoreClock(clock.fn);

const GROUP = '120363000000081001@g.us';
let parkWord = 'the park';
const cat = () => ({ kinds: new Map([['kind:cafe', 'cafe'], ['kind:walk', 'walk']]), places: new Map([['place:park', parkWord]]), cast: new Map(castNow), fixed: new Map([['fixed:work', 'work'], ['fixed:people', 'people']]), homes: new Set(['place:home']) });
let castNow = [['cast:flatmate', 'Robin']];
let events = [];
let excluded = new Set();
let sig = '0:0';
let nextId = 100;
const life = {
  stanceCatalogue: cat,
  stanceTextProblem: () => null,
  stanceLastEventId: () => nextId,
  stanceExclusionSig: () => sig,
  stanceIsExcluded: (id) => excluded.has(id),
  stanceLabel: (t) => t,
  stanceLived: ({ afterId }) => ({
    events: events.filter(e => e.id > afterId && !excluded.has(e.id)),
    lastId: nextId,
    ctx: { homeIds: new Set(['place:home']), activeCast: new Set(castNow.map(c => c[0])), heavyAt: () => false, startOf: () => null, decisionOf: () => null, energyAt: () => 80 },
  }),
};
stance.__setDepsForTest({ now: clock.fn, life: async () => life });

const put = (topic, value, extra = {}) => store.putStance({ topic, label: topic, kind: rules.kindOfTopic(topic), value, status: 'active', source: 'seed', uptake: 1, ...extra });
const scene = (outcome, extra = {}) => ({ id: ++nextId, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { outcome, kind: 'cafe', placeId: 'place:park', castIds: [], mode: 'full', ...extra } });
const val = (t) => store.getStanceByTopic(t)?.value;
let n = 0;
const night = () => `2026-11-${String(++n).padStart(2, '0')}`;
const run = async (evs = []) => { events.push(...evs); return stance.nightlyUpdate(night()); };

section('no approved set: inert');
{
  store.putStance({ topic: 'kind:walk', label: 'walk', kind: 'interest', value: 0.5, status: 'proposed', source: 'seed' });
  events.push(scene('well'));
  eq('nothing to do', await run(), { skipped: 'none' });
  eq('a proposed row stays where it is', val('kind:walk'), 0.5);
  eq('no evidence', store.allStanceEvidence().length, 0);
  check('no cursor', store.getSetting('stance_cursor', null) === null);
}

section('one good night: a bounded step');
store.stanceTx(() => { for (const r of store.listStances()) store.patchStance(r.id, { status: 'rejected' }); });
put('kind:cafe', 0.5);
put('place:park', 0.5);
events = [];
{
  await run([scene('well')]);
  eq('at most one step', val('kind:cafe'), 0.57);
  eq('the place moved a bit less', val('place:park'), 0.556);
  eq('its evidence is world event ids and a code', store.stanceEvidence(store.getStanceByTopic('kind:cafe').id)[0].cause, 'scene:well');
  eq('a re-run of the night does nothing', await stance.nightlyUpdate(`2026-11-0${n}`), { skipped: 'done' });
}

section('a skipped night or downtime: one update, no double');
{
  const before = val('kind:cafe');
  events.push(scene('well'), scene('well'), scene('well'), scene('well'));
  await stance.nightlyUpdate(night());
  n += 3;   // three nights he never slept through
  const after = val('kind:cafe');
  check('four good outings over the gap still move one step', Math.abs(after - before) <= rules.STEP.interest + 1e-9, after - before);
  const h = store.stanceHistory(store.getStanceByTopic('kind:cafe').id, { limit: 100 });
  eq('one history row per update', new Set(h.map(x => x.night)).size, h.length);
}

section('contradictory evidence the same day');
{
  const before = val('place:park');
  put('kind:walk', 0.5);
  const a = { id: ++nextId, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { outcome: 'well', kind: 'walk', placeId: 'place:home', castIds: [], mode: 'full' } };
  const b = { id: ++nextId, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { outcome: 'flat', kind: 'walk', placeId: 'place:home', castIds: [], mode: 'full' } };
  await run([a, b]);
  const r = store.getStanceByTopic('kind:walk');
  check('it moves half what a clean night with that sum would', Math.abs(r.value - 0.5) < 0.6 * rules.STEP.interest * 0.6, r.value);
  check('and he is less sure', r.confidence < 0.5, r.confidence);
  check('home is never a topic', !store.getStanceByTopic('place:home'));
  void before;
}

section('the owner\'s pace: strong experiences show, and being there doesn\'t soften them');
{
  const row = { kind: 'interest', anchor: 0.5, uptake: 1, confidence: 0.5 };
  const well = rules.stepNight(row, 0.5, [{ weight: 1, originKind: 'self' }]).value;
  const bad = rules.stepNight(row, 0.5, [{ weight: -1, originKind: 'self' }, { weight: 0.05, cause: 'time_spent', originKind: 'self' }]).value;
  check('one great date moves it visibly', well - 0.5 >= 0.05, well);
  check('a bad night too, with its small time evidence', 0.5 - bad >= 0.05, bad);
  const time = rules.stepNight(row, 0.5, [{ weight: 0.05, cause: 'time_spent', originKind: 'self' }]).value;
  check('just being there barely moves it', time - 0.5 < 0.005, time);
  check('and it says so while it is moving', /warming/.test(rules.lineFor({ kind: 'interest', value: 0.556, anchor: 0.5 }, 'the park', { trend: 'up' })) && /cooled/.test(rules.lineFor({ kind: 'interest', value: 0.544, anchor: 0.6 }, 'the park', { trend: 'down' })));
  eq('not once it has stopped: that is who he is now', rules.lineFor({ kind: 'interest', value: 0.556, anchor: 0.5 }, 'the park', { trend: 'flat' }), null);
}

section('an interest at its bound');
{
  const row = put('kind:gym', 1);
  for (let i = 0; i < 5; i++) await run([{ ...scene('well', { kind: 'gym', placeId: null }) }]);
  eq('stays at 1', store.getStance(row.id).value, 1);
}

section('pinned');
{
  const row = put('fixed:work', 0.2);
  stance.setPinned(row.id, true);
  const before = JSON.stringify(store.getStance(row.id).value);
  await run([{ id: ++nextId, type: 'work.crunch', at: clock.now(), originKind: 'self', payload: {} }]);
  eq('value byte-stable', JSON.stringify(store.getStance(row.id).value), before);
  eq('no evidence collected', store.stanceEvidence(row.id).length, 0);
  stance.setPinned(row.id, false);
  await run([{ id: ++nextId, type: 'work.crunch', at: clock.now(), originKind: 'self', payload: {} }]);
  check('after an unpin it moves again', store.getStance(row.id).value < 0.2);
}

section('all evidence reverted: the value comes back');
{
  const row = put('kind:cine', 0.5);
  const ev = [];
  for (let i = 0; i < 3; i++) { const e = scene('well', { kind: 'cine', placeId: null }); ev.push(e); await run([e]); }
  check('it moved', store.getStance(row.id).value > 0.55);
  excluded = new Set(ev.map(e => e.id));
  sig = '3:0';
  eq('sweep takes them', (await stance.sweep()).swept, 3);
  eq('value returns exactly', store.getStance(row.id).value, 0.5);
  eq('no evidence left', store.stanceEvidence(row.id).length, 0);
  eq('a second sweep has nothing to do', (await stance.sweep()).swept, 0);
}

section('a rewind across a night update: reverted evidence, later evidence stays');
{
  const row = put('kind:rewound', 0.5);
  const first = scene('well', { kind: 'rewound', placeId: null });
  await run([first]);
  const second = scene('well', { kind: 'rewound', placeId: null });
  await run([second]);
  const both = store.getStance(row.id).value;
  excluded.add(second.id);
  sig = '4:1';
  await stance.sweep();
  check('only the rewound night is undone', store.getStance(row.id).value < both && store.getStance(row.id).value > 0.5, store.getStance(row.id).value);
  eq('the survivor holds', store.stanceEvidence(row.id).length, 1);
}

section('a chat moved an opinion, then the message was revoked');
{
  const row = put('fixed:people', 0, { uptake: 1 });
  const at = clock.now();
  await run([{ id: ++nextId, type: 'chat.perceived', at, actor: 'chat', originKind: 'group', originJid: GROUP, subjectJid: 's1@lid', payload: { kind: 'affect', affect: 'praise' } }]);
  const v = store.getStance(row.id).value;
  check('it moved a little', v > 0 && v <= rules.CHAT_PER_CHAT * rules.STEP.opinion + 1e-9, v);
  const e = store.stanceEvidence(row.id)[0];
  eq('its evidence names the chat by origin only', [e.originKind, e.originJid, e.cause], ['group', GROUP, 'chat:praise']);
  check('no words in the row', !JSON.stringify(e).includes('text'));
  eq('revoked: evidence removed', stance.removeEvidenceFor([GROUP], { since: at - 300 }), 1);
  eq('value recomputed', store.getStance(row.id).value, 0);
}

section('chats are capped: per chat and in all');
{
  const row = put('fixed:people2', 0);
  void row;
  const items = [];
  for (let i = 0; i < 5; i++) items.push({ weight: 1, originKind: 'group', originJid: `g${i}@g.us` });
  eq('five loud chats are worth the night cap', rules.nightSum(items), rules.CHAT_NIGHT_MAX);
  eq('one chat its own cap', rules.nightSum([{ weight: 1, originKind: 'group', originJid: 'g@g.us' }, { weight: 1, originKind: 'group', originJid: 'g@g.us' }]), rules.CHAT_PER_CHAT);
  eq('his own days are not capped by that', rules.nightSum([{ weight: 0.9, originKind: 'self' }, { weight: 1, originKind: 'group', originJid: 'g@g.us' }]), 0.9 + rules.CHAT_PER_CHAT);
}

section('someone left: set aside, then back');
{
  const row = put('cast:flatmate', 0.3);
  const was = store.getStance(row.id).value;
  castNow = [];
  await run();
  eq('archived', store.getStance(row.id).status, 'archived');
  await run();
  eq('not moving', store.getStance(row.id).value, was);
  castNow = [['cast:flatmate', 'Robin']];
  await run();
  eq('back in his life', store.getStance(row.id).status, 'active');
}

section('a place renamed or moved: the same row, its value kept, new words');
{
  const row = store.getStanceByTopic('place:park');
  const v = row.value;
  parkWord = 'the riverside gardens';
  await run();
  const after = store.getStance(row.id);
  eq('the label follows', after.label, 'the riverside gardens');
  eq('the id is what it hangs on', after.topic, 'place:park');
  check('the value did not jump', Math.abs(after.value - v) < 0.01, [v, after.value]);
}

section('a place gone: set aside');
{
  const row = store.getStanceByTopic('place:park');
  const savedCat = life.stanceCatalogue;
  life.stanceCatalogue = () => { const c = savedCat(); c.places = new Map(); return c; };
  await run();
  eq('archived', store.getStance(row.id).status, 'archived');
  life.stanceCatalogue = savedCat;
  await run();
  eq('back', store.getStance(row.id).status, 'active');
}

section('no evidence: only toward the anchor, and an unused interest fades');
{
  const row = put('kind:drift', 0.5, {});
  store.patchStance(row.id, { value: 0.7, baseValue: 0.7 });
  for (let i = 0; i < rules.GRACE_NIGHTS; i++) await run();
  eq('a grace period first', store.getStance(row.id).value, 0.7);
  await run();
  const v = store.getStance(row.id).value;
  check('then back toward the anchor', v < 0.7 && v > 0.5, v);
  for (let i = 0; i < 60; i++) await run();
  const end = store.getStance(row.id).value;
  check('never past anchor less the fade', end >= 0.4 - 1e-9 && end < 0.5 + 1e-9, end);
}

section('the window: past 60 nights a value is kept and its cause let go');
{
  const row = store.getStanceByTopic('kind:drift');
  check('old evidence goes', store.stanceEvidence(row.id).length === 0);
  const nights = store.stanceHistory(row.id, { limit: 400 }).length;
  check('the base moved forward', row.baseNight !== null && nights > rules.EVIDENCE_NIGHTS, [row.baseNight, nights]);
  const before = row.value;
  stance.recomputeAll();
  eq('a recompute after compaction changes nothing', store.getStance(row.id).value, before);
}

section('fold + rules');
{
  const row = { kind: 'interest', anchor: 0.5, uptake: 1, baseValue: 0.5, baseConfidence: 0.5 };
  const items = new Map([['a', [{ weight: 1, cause: 'x', originKind: 'self' }]], ['b', [{ weight: -1, cause: 'x', originKind: 'self' }]]]);
  const f = rules.replay(row, ['a', 'b'], items);
  eq('deterministic', rules.replay(row, ['a', 'b'], items), f);
  const habit = new Map(Array.from({ length: 10 }, (_, i) => [`n${i}`, [{ weight: 0.3, cause: 'time_spent', originKind: 'self' }]]));
  const nights = [...habit.keys()];
  const steps = rules.replay(row, nights, habit).rows.map(x => x.after - x.before);
  check('done every day it counts for less', steps.at(-1) < steps[0] / 2, steps);
  eq('why from a chat: a feeling, not its words', rules.whyWords({ cause: 'chat:argument', originKind: 'group' }), 'an argument in a chat');
  eq('why on a chat plan says so', rules.whyWords({ cause: 'scene:well', originKind: 'group' }), 'it went well, on a plan from a chat');
  eq('no line at neutral', rules.lineFor({ kind: 'interest', value: 0.5, anchor: 0.5 }, 'cafes'), null);
  eq('a strong one is just who he is', rules.lineFor({ kind: 'interest', value: 0.75, anchor: 0.6 }, 'cafes'), 'You like cafes.');
  eq('"more lately" only while it is moving', rules.lineFor({ kind: 'interest', value: 0.75, anchor: 0.6 }, 'cafes', { trend: 'up' }), "You've been enjoying cafes more lately.");
  eq('no label, no line', rules.lineFor({ kind: 'interest', value: 0.9, anchor: 0.5 }, null), null);
}

section('finding 22: he changes, but stays himself');
{
  // A regular outing at the outcome mix codeOutcome starts from: 40% well, 30% fine, 20% flat, 10% badly.
  const mix = (i) => { const x = ((i * 0.6180339887) % 1); return x < 0.4 ? 1 : x < 0.7 ? 0.05 : x < 0.9 ? -0.4 : -1; };
  const run = (kind, anchor, every, nights) => {
    const row = { kind, anchor, uptake: 1, baseValue: anchor, baseConfidence: 0.5 };
    const names = Array.from({ length: nights }, (_, i) => `n${String(i).padStart(4, '0')}`);
    const items = new Map();
    names.forEach((n, i) => { if (i % every === 0) items.set(n, [{ weight: mix(i), cause: 'scene:x', originKind: 'self' }, { weight: 0.05, cause: 'time_spent', originKind: 'self' }]); });
    return rules.replay(row, names, items).value;
  };
  check('a weekly interest settles within reach', run('interest', 0.6, 7, 365) <= 0.6 + rules.REACH.interest + 1e-9, run('interest', 0.6, 7, 365));
  check('every third night too', run('interest', 0.6, 3, 365) <= 0.6 + rules.REACH.interest + 1e-9, run('interest', 0.6, 3, 365));
  check('an opinion too', run('opinion', 0.2, 3, 365) <= 0.2 + rules.REACH.opinion + 1e-9, run('opinion', 0.2, 3, 365));
  const near = rules.stepNight({ kind: 'interest', anchor: 0.5, uptake: 1 }, 0.78, [{ weight: 1, originKind: 'self' }]).value - 0.78;
  const far = rules.stepNight({ kind: 'interest', anchor: 0.5, uptake: 1 }, 0.5, [{ weight: 1, originKind: 'self' }]).value - 0.5;
  check('the same great evening moves him less once he is already far along', near < far / 3, [near, far]);
  const back = rules.stepNight({ kind: 'interest', anchor: 0.5, uptake: 1 }, 0.78, [{ weight: -1, originKind: 'self' }]).value;
  check('coming back is not held back', 0.78 - back > 0.06, back);
}

section('finding 11: a base cut keeps the habit, and a recompute with nothing new changes nothing');
{
  const row = { kind: 'interest', anchor: 0.5, uptake: 1, baseValue: 0.5, baseConfidence: 0.5 };
  const names = Array.from({ length: 240 }, (_, i) => `n${String(i).padStart(4, '0')}`);
  const items = new Map(names.map(n => [n, [{ weight: 0.075, cause: 'time_spent', originKind: 'self' }]]));
  const uncut = rules.replay(row, names, items);
  // Cut every night past the window, as recompute does: carrying the state forward must land exactly where the whole fold does.
  let base = { ...row };
  let from = 0;
  for (let i = 60; i < names.length; i += 1) {
    const f = rules.replay(base, names.slice(from, i), items);
    const c = f.rows[0];
    if (!c) continue;
    base = { ...row, baseValue: c.after, baseConfidence: c.confidence, baseSince: c.since, baseHabit: c.habit };
    from += 1;
  }
  const cut = rules.replay(base, names.slice(from), items);
  check('the same value with or without cuts', Math.abs(cut.value - uncut.value) < 1e-3, [cut.value, uncut.value]);
  const r = put('kind:habit', 0.5);
  for (let i = 0; i < 70; i++) await run([{ id: ++nextId, type: 'activity.ended', at: clock.now(), causeId: 1, payload: {} }]);
  store.stanceTx(() => { for (let i = 0; i < 70; i++) store.addStanceEvidence(r.id, `2027-01-${String(i).padStart(3, '0')}`, { at: clock.now(), source: 'time', cause: 'time_spent', weight: 0.075, eventIds: [] }); });
  stance.recomputeAll();
  const once = store.getStance(r.id).value;
  stance.recomputeAll();
  eq('a second recompute changes nothing', store.getStance(r.id).value, once);
}

section('finding 13: the trend is pruned');
{
  const r = put('kind:pruned', 0.5);
  const hist = Array.from({ length: 300 }, (_, i) => ({ night: `2026-${String(i).padStart(4, '0')}`, before: 0.5, after: 0.5, confidence: 0.5, count: 0, since: 0 }));
  store.writeStanceHistory(r.id, hist);
  store.pruneStanceHistory(r.id, 240);
  eq('only the newest kept', store.stanceHistory(r.id, { limit: 1000 }).length, 240);
  eq('the newest', store.stanceHistory(r.id, { limit: 1 })[0].night, '2026-0299');
  const fs = await import('fs');
  check('a recompute prunes', fs.readFileSync(new URL('../../src/mind/stance.js', import.meta.url), 'utf8').includes('store.pruneStanceHistory(row.id, HISTORY_MAX)'));
}

section('finding 6: a chat-derived item keeps the chat\'s own time');
{
  const items = rules.evidenceFrom([{ id: 5, type: 'scene.played', at: 1000, originKind: 'group', originJid: GROUP, payload: { outcome: 'well', kind: 'cafe', mode: 'narration_only' } }], { originAt: () => 400 });
  eq('from its cause chain, not the event', items[0].originAt, 400);
  eq('unknown fails closed', rules.evidenceFrom([{ id: 6, type: 'scene.played', at: 1000, originKind: 'group', originJid: GROUP, payload: { outcome: 'well', kind: 'cafe', mode: 'narration_only' } }], { originAt: () => null })[0].originAt, 0);
  check('his own has none', rules.evidenceFrom([{ id: 7, type: 'work.late', at: 1000, originKind: 'self', payload: {} }], {})[0].originAt === undefined);
}

section('heavy');
{
  const items = rules.evidenceFrom([{ id: 1, type: 'scene.played', at: 10, heavy: true, payload: { outcome: 'badly', kind: 'cafe', mode: 'full' } },
    { id: 2, type: 'scene.played', at: 10, payload: { outcome: 'badly', kind: 'cafe', mode: 'full', heavyWindow: true } },
    { id: 3, type: 'scene.played', at: 500, payload: { outcome: 'badly', kind: 'cafe', mode: 'full' } },
    { id: 4, type: 'scene.played', at: 10, payload: { outcome: 'badly', kind: 'cafe', mode: 'full' } }], { heavyAt: (t) => t === 500, isHeavyChain: (e) => e.id === 4 });
  eq('nothing learned from a heavy stretch', items, []);
}

eq('no network', net.length, 0);
void DAY;
stance.__setDepsForTest(null);
report();
