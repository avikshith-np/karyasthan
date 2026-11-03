// 010 T009 — projector.js seams (contracts/story-api.md §3.2, data-model §3,
// research R4/R9/R11/R14): the story slice folds live ≡ replay; a rewind range
// equals the fold to its target plus the kept (REWIND_KEEP) events, folded as
// bookkeeping; world.rewound integrates no vitals; a claim.flagged in a range
// stays a valid cause; a stale snapshot is skipped; a 009 v1 snapshot loads; a
// 10-day-ahead committed decision survives pruning; the arc Jev counter
// survives a day rollover; a job change moves the office vitals see; the new
// decision fields, `by`, the owner-pick reversal guard and the closing expiry
// reasons. Scratch DB, fake clock, example world, invented ids only.
import { setupScratchDb, fakeClock, section, check, eq, report } from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { appendEvent, eventsAfter, listRewinds } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { integrate, activityClass } from '../../src/life/vitals.js';
import {
  createInitialState, project, applyAppended, rebuild, advanceTo, serializeState, deserializeState,
  saveSnapshot, loadLatestSnapshot, isExcluded, isExcludedId, SNAPSHOT_VERSION,
} from '../../src/life/projector.js';
import { initialStory, storyEquivalent, worldOverlay } from '../../src/life/story/reducer.js';

const { db } = await setupScratchDb();
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz);
const clock = fakeClock(local(26, 6));
setClock(clock.fn);

const MIN = 60;
const H = 3600;
const DAY = 86400;
const GROUP = '120363000000000251@g.us';
const PERSON = '15550000251@s.whatsapp.net';

const json = (s) => JSON.stringify(serializeState(s));
const snapCount = () => db.prepare('SELECT COUNT(*) AS n FROM world_snapshots').get().n;

let live = createInitialState(world);
const add = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  return ev;
};
const allEvents = () => eventsAfter(0, 100000);
/** Fold of every event with id ≤ `uptoId` from an empty state (no rewinds known). */
const foldTo = (uptoId) => {
  let st = createInitialState(world);
  for (const ev of allEvents()) if (ev.id <= uptoId) st = project(st, ev, world);
  return st;
};
const full = () => rebuild({ world, useSnapshot: false });

// Synthetic events for the pure parts (project() needs no DB).
let synthId = 1_000_000;
const synth = (type, at, payload = {}, extra = {}) => ({
  id: ++synthId, at, type, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: 'self',
  subjectJid: null, heavy: false, redacted: false, ...extra,
});

try {
  // ── Genesis ──────────────────────────────────────────────────────────────
  const T0 = clock.now();
  const genesis = add({ type: 'genesis', at: T0, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) add({ type: 'place.created', at: T0, actor: 'engine', causeId: genesis.id, payload: p });
  for (const c of world.cast) add({ type: 'cast.created', at: T0, actor: 'engine', causeId: genesis.id, payload: c });
  const castA = world.cast[0].id;

  section('initial state and the story slice');
  const init = createInitialState(world);
  eq('story = initialStory()', JSON.stringify(init.story), JSON.stringify(initialStory()));
  eq('no ranges', init.excludedRanges, []);
  check('keptInRange is an empty Set', init.keptInRange instanceof Set && init.keptInRange.size === 0);
  eq('arc counters', [init.counters.arcJevDay, init.counters.arcJevToday], [null, 0]);
  eq('genesis observer: career base from self.job', [live.story.career.title, live.story.career.employerName, live.story.career.officePlaceId],
    [world.self.job.title, world.self.job.employerName, 'place:office']);
  check('worldOverlay is the world itself before any career event', worldOverlay(live, world) === world);

  section('009 wins; story handlers and observers fold');
  eq('cast.created still the 009 record', live.cast.get(castA)?.id, castA);
  eq('genesis cast does not count toward the new-cast pace', live.story.newCast.ats.length, 0);
  const t1 = clock.advance({ minutes: 30 });
  const upd = add({ type: 'cast.updated', at: t1, actor: 'engine', payload: { castId: castA, fields: { status: 'busy with a move' }, reason: 'status_rotate' } });
  eq('cast.updated merged into the 009 cast record', live.cast.get(castA).status, 'busy with a move');
  add({ type: 'relationship.changed', at: t1, actor: 'engine', causeId: upd.id, payload: { castId: castA, delta: { closeness: 0.1, intimacy: 0.05 }, reason: 'drift' } });
  check('relationship.changed → story.relationships', live.story.relationships[castA]?.intimacy > 0);
  add({ type: 'director.slider_set', at: t1, actor: 'owner', payload: { slider: 'drama', value: 0.8 } });
  eq('owner slider folded', live.story.controls.sliders.drama, 0.8);

  section('decision fields, by, owner-pick guard, closing reasons');
  const tD = clock.advance({ minutes: 10 });
  const arcOpen = add({ type: 'decision.opened', at: tD, actor: 'engine', subjectJid: PERSON, payload: {
    kind: 'romance:dinner', subject: { eventAt: tD + 3 * DAY }, opensAt: tD, decideBy: tD + 2 * DAY, ponrAt: tD + 2 * DAY, mode: 'ask',
    category: 'romance', big: true, bigDowngraded: 'lead_time', adopted: false, arcId: 77,
    options: [{ id: 'yes', label: 'say yes', cost: {}, bias: 9 }, { id: 'no', label: 'say no', cost: {}, bias: -1.5 }, { id: 'later', label: 'later', cost: {} }],
  } });
  const ad = live.decisions.get(arcOpen.id);
  eq('category, big, bigDowngraded, arcId kept', [ad.category, ad.big, ad.bigDowngraded, ad.arcId], ['romance', true, 'lead_time', 77]);
  check('adopted:false is not stored', !('adopted' in ad));
  eq('option bias clamped to ±3; zero/absent not stored', ad.options.map(o => o.bias), [3, -1.5, undefined]);
  eq('subjectJid from the event column', ad.subjectJid, PERSON);
  eq('mode ask', ad.mode, 'ask');
  const plainOpen = add({ type: 'decision.opened', at: tD, actor: 'engine', payload: {
    kind: 'movie', subject: { eventAt: tD + 4 * H }, opensAt: tD, decideBy: tD + 3 * H, ponrAt: tD + 3.5 * H,
    options: [{ id: 'go', label: 'go', cost: {} }, { id: 'stay', label: 'stay', cost: {} }],
  } });
  const pd = live.decisions.get(plainOpen.id);
  check('a 009 decision gains no 010 keys', !['category', 'big', 'bigDowngraded', 'adopted', 'arcId', 'claimId', 'subjectJid'].some(k => k in pd)
    && pd.options.every(o => !('bias' in o)));

  const ownerPick = add({ type: 'decision.committed', at: tD + 60, actor: 'owner', causeId: arcOpen.id, payload: { decisionId: arcOpen.id, optionId: 'yes', by: 'owner' } });
  eq('owner commit → by owner', live.decisions.get(arcOpen.id).committed.by, 'owner');
  add({ type: 'decision.reversed', at: tD + 120, actor: 'engine', causeId: ownerPick.id, payload: { decisionId: arcOpen.id, from: 'yes', to: 'no' } });
  eq('an owner pick is never reversed', [live.decisions.get(arcOpen.id).committed.optionId, live.decisions.get(arcOpen.id).reversals], ['yes', 0]);
  add({ type: 'decision.committed', at: tD + 60, actor: 'engine', causeId: plainOpen.id, payload: { decisionId: plainOpen.id, optionId: 'go', sampled: true } });
  eq('009 row without by → sample (from sampled)', live.decisions.get(plainOpen.id).committed.by, 'sample');
  const forged = project(live, synth('decision.committed', tD, { decisionId: 999, optionId: 'go', by: 'owner' }), world);
  check('non-owner by:owner is not trusted (unknown decision ignored anyway)', !forged.decisions.has(999));
  const early = synth('decision.opened', tD, { kind: 'chai', subject: { eventAt: tD + H }, options: [{ id: 'go', label: 'go' }, { id: 'stay', label: 'stay' }] });
  let ps = project(live, early, world);
  ps = project(ps, synth('decision.committed', tD, { decisionId: early.id, optionId: 'go', sampled: false, by: 'owner' }), world);
  eq('engine event claiming by:owner folds as early', ps.decisions.get(early.id).committed.by, 'early');
  ps = project(ps, synth('decision.expired', tD + 1, { decisionId: early.id, reason: 'frozen' }), world);
  eq('frozen closes a committed decision (cancelled)', ps.decisions.get(early.id).status, 'cancelled');
  for (const reason of ['pinned', 'owner_cancelled', 'withdrawn']) {
    let q = project(live, early, world);
    q = project(q, synth('decision.committed', tD, { decisionId: early.id, optionId: 'go', by: 'adopted' }), world);
    eq(`by adopted kept`, q.decisions.get(early.id).committed.by, 'adopted');
    q = project(q, synth('decision.expired', tD + 1, { decisionId: early.id, reason }), world);
    eq(`${reason} closes a committed decision`, q.decisions.get(early.id).status, 'cancelled');
  }
  let rq = project(live, early, world);
  rq = project(rq, synth('decision.committed', tD, { decisionId: early.id, optionId: 'go', sampled: true }), world);
  rq = project(rq, synth('decision.expired', tD + 1, { decisionId: early.id, reason: 'options_expired' }), world);
  eq('other reasons still leave a committed decision alone (009)', rq.decisions.get(early.id).status, 'committed');

  section('cleanBlock fromAmendment/subjectJid; plan.basePlanEventId');
  const base = synth('plan.made', tD, { date: '2026-10-26', blocks: [{ kind: 'work', placeId: 'place:office', start: tD, end: tD + H }] });
  const amended = synth('plan.made', tD + 60, { amendedFor: 5, basePlanEventId: base.id, blocks: [
    { kind: 'commute', start: tD + H, end: tD + 2 * H, from: 'place:home', to: 'place:cinema', fromAmendment: true, subjectJid: PERSON },
    { kind: 'movie', placeId: 'place:cinema', start: tD + 2 * H, end: tD + 4 * H, fromAmendment: true, subjectJid: 'not-a-jid' },
    { kind: 'free', start: tD + 4 * H, end: tD + 5 * H, fromAmendment: 'yes' },
  ] });
  let pl = project(project(live, base, world), amended, world);
  eq('basePlanEventId kept', pl.plan.basePlanEventId, base.id);
  eq('fromAmendment only when true', pl.plan.blocks.map(b => b.fromAmendment === true), [true, true, false]);
  eq('subjectJid only when a person jid', pl.plan.blocks.map(b => b.subjectJid ?? null), [PERSON, null, null]);
  check('a 009 plan has no basePlanEventId and plain blocks', !('basePlanEventId' in project(live, base, world).plan)
    && !('fromAmendment' in project(live, base, world).plan.blocks[0]));

  section('arc Jev counter: classified by category, reset in place');
  const d1 = local(27, 9);
  const arcDec = synth('decision.opened', d1, { kind: 'career:offer', category: 'career', subject: { eventAt: d1 + 2 * DAY },
    options: [{ id: 'take', label: 'take' }, { id: 'stay', label: 'stay' }] });
  const plainDec = synth('decision.opened', d1, { kind: 'walk', subject: { eventAt: d1 + H }, options: [{ id: 'go', label: 'go' }, { id: 'stay', label: 'stay' }] });
  let cs = project(project(live, arcDec, world), plainDec, world);
  cs = project(cs, synth('decision.lean', d1 + 60, { decisionId: arcDec.id, optionId: 'take', p: 0.6 }, { actor: 'jev' }), world);
  cs = project(cs, synth('decision.lean', d1 + 120, { decisionId: plainDec.id, optionId: 'go', p: 0.6 }, { actor: 'jev' }), world);
  eq('day 1: one arc lean, one 009 lean', [cs.counters.arcJevToday, cs.counters.jevToday], [1, 1]);
  const d2 = local(28, 9);
  cs = project(cs, synth('decision.lean', d2, { decisionId: arcDec.id, optionId: 'take', p: 0.7 }, { actor: 'jev' }), world);
  eq('day 2 starts with an arc lean: both reset, arc = 1', [cs.counters.arcJevToday, cs.counters.jevToday, cs.counters.arcJevDay], [1, 0, '2026-10-28']);
  cs = project(cs, synth('decision.lean', d2 + 60, { decisionId: plainDec.id, optionId: 'go', p: 0.7 }, { actor: 'jev' }), world);
  eq('a later 009 jev event the same day does not wipe the arc counter', [cs.counters.arcJevToday, cs.counters.jevToday], [1, 1]);
  const v1 = deserializeState({ ...serializeState(cs), counters: { jevDay: '2026-10-28', jevToday: 3 } });
  eq('v1 counters (no arc fields) default to 0', [v1.counters.arcJevToday, v1.counters.jevToday], [0, 3]);
  const v1n = project(v1, synth('decision.lean', d2 + 120, { decisionId: arcDec.id, optionId: 'take', p: 0.7 }, { actor: 'jev' }), world);
  eq('… and count from there', [v1n.counters.arcJevToday, v1n.counters.jevToday], [1, 3]);

  section('pruning keeps a committed decision 10 days ahead');
  const pAt = local(27, 10);
  const ahead = synth('decision.opened', pAt, { kind: 'social:trip', adopted: true, category: 'social', subject: { eventAt: pAt + 10 * DAY },
    ponrAt: pAt + 10 * DAY - H, options: [{ id: 'go', label: 'go' }, { id: 'late', label: 'late', expiresAt: pAt + 10 * DAY + 2 * H }, { id: 'stay', label: 'stay' }] });
  let pr = project(createInitialState(world), ahead, world);
  pr = project(pr, synth('decision.committed', pAt, { decisionId: ahead.id, optionId: 'go', by: 'adopted' }), world);
  // 80 short decisions, each committed and closed, then four days later.
  for (let i = 0; i < 80; i++) {
    const o = synth('decision.opened', pAt + i, { kind: 'snack', subject: { eventAt: pAt + i - 600 }, options: [{ id: 'go', label: 'go' }, { id: 'stay', label: 'stay' }] });
    pr = project(pr, o, world);
    pr = project(pr, synth('decision.committed', pAt + i, { decisionId: o.id, optionId: 'stay', sampled: true }), world);
  }
  check('over the cap, the future commit survives', pr.decisions.has(ahead.id));
  check('the cap still holds for everything else (≤ 64 besides it)', pr.decisions.size - 1 <= 64, pr.decisions.size);
  pr = project(pr, synth('decision.opened', pAt + 4 * DAY, { kind: 'snack', subject: { eventAt: pAt + 4 * DAY + 600 }, options: [{ id: 'go', label: 'go' }, { id: 'stay', label: 'stay' }] }), world);
  check('closed > 3 days ago: the old ones pruned, the future commit kept', pr.decisions.has(ahead.id) && pr.decisions.size === 2, pr.decisions.size);
  pr = project(pr, synth('decision.opened', pAt + 14 * DAY, { kind: 'snack', subject: { eventAt: pAt + 14 * DAY + 600 }, options: [{ id: 'go', label: 'go' }, { id: 'stay', label: 'stay' }] }), world);
  check('once its day is > 3 days past, it prunes like any other', !pr.decisions.has(ahead.id));

  section('a job change moves the office vitals see');
  const jAt = clock.advance({ hours: 1 });
  add({ type: 'place.created', at: jAt, actor: 'engine', payload: { id: 'place:office-two', name: 'New office', kind: 'office', lat: world.places[1].lat + 0.01, lon: world.places[1].lon } });
  add({ type: 'career.job_changed', at: jAt, actor: 'engine', payload: { title: 'Lead', employerName: 'Other Co.', officePlaceId: 'place:office-two' } });
  eq('self.officePlaceId moved', live.self.officePlaceId, 'place:office-two');
  const ow = worldOverlay(live, world);
  eq('overlay office', ow.self.job.officePlaceId, 'place:office-two');
  const workBlock = add({ type: 'activity.started', at: jAt + 60, actor: 'engine', payload: { kind: 'work', placeId: 'place:office-two', end: jAt + 3 * H } });
  eq('the raw world would call it wfh', activityClass(live.activity, world), 'wfh');
  eq('the overlay calls it office', activityClass(live.activity, ow), 'office');
  const before = live.vitals;
  add({ type: 'cast.beat', at: workBlock.at + 2 * H, actor: 'engine', payload: { castId: castA, kind: 'news', text: 'busy week' } });
  const expected = integrate(before, { kind: 'work', placeId: 'place:office-two' }, 120, ow, { at: workBlock.at, rain: live.weather?.rain === true });
  const asWfh = integrate(before, { kind: 'work', placeId: 'place:office-two' }, 120, world, { at: workBlock.at, rain: live.weather?.rain === true });
  check('two hours at the new office integrate as office (energy)', Math.abs(expected.energy - live.vitals.energy) < 1e-6
    && Math.abs(asWfh.energy - expected.energy) > 1e-6, { got: live.vitals.energy, office: expected.energy, wfh: asWfh.energy });
  const view = advanceTo(live, live.at + H, world);
  check('advanceTo integrates under the overlay too', Number.isFinite(view.vitals.energy));
  add({ type: 'activity.ended', at: workBlock.at + 2 * H + 60, actor: 'engine', payload: { kind: 'work' } });

  section('live ≡ replay with story events');
  eq('full replay equals the live fold', json(full()), json(live));
  saveSnapshot(live);
  const tR = clock.advance({ minutes: 20 });
  add({ type: 'arc.started', at: tR, actor: 'engine', payload: { category: 'cast', kind: 'friendship', castIds: [castA], stage: 'start' } });
  add({ type: 'cast.beat', at: tR + 60, actor: 'engine', payload: { castId: castA, kind: 'hobby', text: 'took up pottery' } });
  eq('snapshot + replay equals the live fold', json(rebuild({ world })), json(live));
  eq('and equals a full replay', json(full()), json(live));

  // ── Rewind ───────────────────────────────────────────────────────────────
  section('rewind: a range equals the fold to its target plus kept events');
  const target = live.lastEventId;
  const targetState = foldTo(target);
  const tgtAt = live.at;
  const s0 = clock.advance({ hours: 2 });
  const act = add({ type: 'activity.started', at: s0, actor: 'engine', payload: { kind: 'gym', placeId: 'place:gym', end: s0 + H } });
  add({ type: 'relationship.changed', at: s0 + 60, actor: 'engine', payload: { castId: castA, delta: { trust: 0.2 }, reason: 'drift' } });
  add({ type: 'cast.history_added', at: s0 + 120, actor: 'engine', payload: { castId: castA, text: 'moved flats' } });
  const keptSlider = add({ type: 'director.slider_set', at: s0 + 180, actor: 'owner', payload: { slider: 'familyPressure', value: 0.1 } });
  const flagged = add({ type: 'claim.flagged', at: s0 + 240, actor: 'chat', originKind: 'group', originJid: GROUP, payload: { claimId: 501 } });
  const keptExpiry = add({ type: 'decision.expired', at: s0 + 300, actor: 'engine', causeId: arcOpen.id, payload: { decisionId: arcOpen.id, reason: 'frozen' } });
  const droppedExpiry = add({ type: 'decision.expired', at: s0 + 300, actor: 'engine', causeId: plainOpen.id, payload: { decisionId: plainOpen.id, reason: 'options_expired' } });
  eq('kept freeze closed the owner-picked arc decision', live.decisions.get(arcOpen.id).status, 'cancelled');
  const lastInRange = live.lastEventId;
  const preVitals = live.vitals;
  const snapBefore = saveSnapshot(live); // a snapshot inside what will be the range → stale after the rewind
  check('snapshot inside the range saved', !!snapBefore);
  const nowAt = clock.advance({ days: 2 });
  const rewound = add({ type: 'world.rewound', at: nowAt, actor: 'owner', payload: { toEventId: target, uptoEventId: lastInRange, reason: 'test' } });
  eq('listRewinds sees the range', listRewinds().map(r => [r.from, r.to]), [[target + 1, rewound.id - 1]]);
  eq('state carries the range', live.excludedRanges.map(r => [r.from, r.to, r.eventId]), [[target + 1, rewound.id - 1, rewound.id]]);
  check('kept ids recorded', live.keptInRange.has(keptSlider.id) && live.keptInRange.has(flagged.id) && live.keptInRange.has(keptExpiry.id)
    && !live.keptInRange.has(droppedExpiry.id) && !live.keptInRange.has(act.id));
  check('the stale snapshot was dropped', !db.prepare('SELECT 1 FROM world_snapshots WHERE id = ?').get(snapBefore));
  check('range events are excluded, kept ones are not', isExcluded(live, act) && !isExcludedId(live, keptSlider.id) && !isExcludedId(live, flagged.id));
  check('storyEquivalent(after rewind, fold to target)', storyEquivalent(live, targetState));
  eq('vitals equal the target (no integration across the gap)', JSON.stringify(live.vitals), JSON.stringify(targetState.vitals));
  check('… and differ from just before the rewind', JSON.stringify(preVitals) !== JSON.stringify(live.vitals));
  eq('s.at stays at the target (world.rewound and kept events don\'t advance it)', live.at, tgtAt);
  eq('kept controls applied', [live.story.controls.sliders.familyPressure, live.story.controls.sliders.drama], [0.1, 0.8]);
  eq('kept claim.flagged counted', live.claims.flagged, targetState.claims.flagged + 1);
  eq('kept frozen expiry still closes its decision', live.decisions.get(arcOpen.id).status, 'cancelled');
  eq('dropped expiry undone (the 009 decision is committed again)', live.decisions.get(plainOpen.id).status, 'committed');
  check('range exclusions leave no exclusion signatures', !live.excludedSigs.some(x => x.at === act.at));
  eq('rebuild converges (full replay = live)', json(full()), json(live));

  section('world.rewound integrates no vitals');
  const r2 = { ...rewound, at: rewound.at + 7 * DAY }; // the same rewind folded again (as a replay meets it)
  const after = project(live, r2, world);
  eq('an already-known range: no rebuild flag', after.rebuildNeeded, false);
  eq('vitals and s.at unchanged a week later', [JSON.stringify(after.vitals), after.at], [JSON.stringify(live.vitals), live.at]);
  const r3 = synth('world.rewound', live.at + 7 * DAY, { toEventId: target - 5 }, { actor: 'owner', originKind: 'owner', originJid: 'owner' });
  const after3 = project(live, r3, world);
  eq('a new range flags a rebuild, still no integration', [after3.rebuildNeeded, JSON.stringify(after3.vitals), after3.at], [true, JSON.stringify(live.vitals), live.at]);

  section('a claim.flagged in a range stays a valid cause');
  const adoptAt = clock.advance({ minutes: 5 });
  const adopted = add({ type: 'claim.adopted', at: adoptAt, actor: 'engine', causeId: flagged.id, payload: { claimId: 501, reviewId: 9, as: 'activity', ref: flagged.id } });
  eq('adoption inherits the chat origin', adopted.originJid, GROUP);
  check('and folds (not cascade-excluded)', !isExcludedId(live, adopted.id) && live.story.adopted[501]?.eventId === adopted.id, live.story.adopted);
  const orphan = add({ type: 'activity.ended', at: adoptAt + 60, actor: 'engine', causeId: act.id, payload: { kind: 'gym' } });
  check('an engine event caused by a non-kept range event is excluded', isExcludedId(live, orphan.id));
  eq('still converges', json(full()), json(live));

  section('nested rewinds converge; a stale snapshot is skipped');
  const good = saveSnapshot(live);
  const midTarget = orphan.id; // the good snapshot's upto: it predates the new range
  const n0 = clock.advance({ hours: 1 });
  add({ type: 'cast.beat', at: n0, actor: 'engine', payload: { castId: castA, kind: 'news', text: 'got a dog' } });
  const stale = saveSnapshot(live);
  add({ type: 'world.rewound', at: clock.advance({ minutes: 1 }), actor: 'owner', payload: { toEventId: midTarget, reason: 'nested' } });
  check('the snapshot after the new target is gone, the earlier one stays',
    !db.prepare('SELECT 1 FROM world_snapshots WHERE id = ?').get(stale) && !!db.prepare('SELECT 1 FROM world_snapshots WHERE id = ?').get(good));
  eq('two ranges', live.excludedRanges.length, 2);
  eq('rebuild from the remaining snapshot = full replay = live', [json(rebuild({ world })), json(full())], [json(live), json(live)]);

  section('snapshot round trip and a 009 v1 snapshot');
  const rt = deserializeState(JSON.parse(JSON.stringify(serializeState(live))));
  check('keptInRange survives as a Set', rt.keptInRange instanceof Set && rt.keptInRange.size === live.keptInRange.size);
  eq('round trip is exact', json(rt), json(live));
  const old = JSON.parse(JSON.stringify(serializeState(foldTo(genesis.id + world.places.length + world.cast.length))));
  for (const k of ['story', 'excludedRanges', 'keptInRange']) delete old[k];
  old.counters = { jevDay: null, jevToday: 0 };
  eq('a pre-010 shaped snapshot carries the current version (only story keys missing)', old.v, SNAPSHOT_VERSION);
  // 2026-10-31: v1 snapshots hold vitals from the old rates — refused, so a rebuild replays the log.
  check('a v1 snapshot (pre-rebalance vitals) is refused', (() => { try { deserializeState({ ...old, v: 1 }); return false; } catch { return true; } })());
  const loaded = deserializeState(old);
  eq('story defaults to initialStory()', JSON.stringify(loaded.story), JSON.stringify(initialStory()));
  check('ranges/kept default empty', Array.isArray(loaded.excludedRanges) && !loaded.excludedRanges.length && loaded.keptInRange instanceof Set);
  const partial = deserializeState({ ...old, story: { controls: initialStory().controls, arcs: [] } });
  check('a partial story slice is completed', partial.story.workLog && !Array.isArray(partial.story.arcs) && Array.isArray(partial.story.bookmarks));
  const folded = project(loaded, synth('cast.beat', T0 + 60, { castId: castA, kind: 'hobby', text: 'x' }), world);
  check('a loaded v1 snapshot takes story events', folded.story.castLife[castA]?.lastBeat?.kind === 'hobby');
  // A v1 (pre-010) snapshot row in the DB is skipped by rebuild(): its story
  // slice would miss what the story observed from 009 events before it.
  db.prepare('DELETE FROM world_snapshots').run();
  const v1State = foldTo(genesis.id);
  const v1Json = serializeState(v1State);
  for (const k of ['story', 'excludedRanges', 'keptInRange']) delete v1Json[k];
  db.prepare('INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, ?)').run(v1State.lastEventId, v1State.at, JSON.stringify(v1Json));
  check('rebuild skips the v1 row', loadLatestSnapshot() === null);
  eq('… and still equals the live fold', json(rebuild({ world })), json(live));
  // Regression (review): a v1 row taken late in the log (story data folded) must not
  // become the rebuild base, or the story slice resets to its defaults for good.
  db.prepare('DELETE FROM world_snapshots').run();
  const lateJson = serializeState(live);
  for (const k of ['story', 'excludedRanges', 'keptInRange']) delete lateJson[k];
  db.prepare('INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, ?)').run(live.lastEventId, live.at, JSON.stringify(lateJson));
  check('a late v1 row is not loaded', loadLatestSnapshot() === null);
  check('the live story slice is not the default (the case matters)', JSON.stringify(live.story) !== JSON.stringify(initialStory()));
  eq('rebuild over a late v1 row = full replay = live', [json(rebuild({ world })), json(full())], [json(live), json(live)]);
  check('snapshot count sane', snapCount() >= 1);
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}

report();
