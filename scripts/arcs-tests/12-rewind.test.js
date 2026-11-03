// 010 T020 — rewind (src/life/story/rewind.js, research R11, contracts/director-api.md
// §3 `rewind`, SC-005): a range exclusion, never a delete. Checks:
//   - targetFor maps a picked time to the last applied, non-keep event;
//   - the window, genesis, excluded-target and keep-type rules;
//   - the preview's rebuilt state equals the real rebuild after step 1, and both
//     are storyEquivalent to the fold at the target (kept controls aside);
//   - the batch order (action → world.rewound → re-anchor → heavy lapses → stale
//     expiries → embargo marker), vitals after the batch = the target's vitals;
//   - REWIND_KEEP survives: a kept slider change, a vetoed proposal stays vetoed,
//     a revert stays a revert; a pending proposal inside the lead time lapses;
//   - an adoption in the range returns its review to the tray; mismatched replies
//     are listed; a routine phone check after the preview still applies; a full
//     replay converges (rebuild without snapshots).
// unit: a realistic log from the 009 facade (stopped), a local projection + appender.
// Invented, persona-neutral names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, foldAt, exampleArcSeed,
  skipSimUnlessWired, DAY, HOUR,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent, getEvent, listEvents, lastEventId } from '../../src/life/eventLog.js';
import { rebuild, applyAppended, isExcludedId } from '../../src/life/projector.js';
import { storyEquivalent } from '../../src/life/story/reducer.js';
import * as store from '../../src/life/story/store.js';
import * as director from '../../src/life/story/director.js';
import * as rewind from '../../src/life/story/rewind.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
await simulateDays(2);
await stopLife();

let state = rebuild({ world });
const append = (spec) => {
  const ev = appendEvent(spec);
  state = applyAppended(state, ev, { world });
  return ev;
};
let rebased = 0;
const seed = await exampleArcSeed();
director.__setDepsForTest({
  now: () => clock.now(), getState: () => state, world, append, pulse: { rebase: () => { rebased += 1; } },
  knownNames: () => [], seed: () => seed, countSelfReplies: () => 7, chatName: () => 'Chat',
});
const codeOf = async (p) => { try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; } };
const codeOfSync = (fn) => { try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; } };

// ── Fixture: things before the target, the target, things after it ─────────
const now0 = clock.now();
// A heavy proposal before the target, onset inside the lead time after the rewind → lapses.
const propLapse = append({ type: 'heavy.proposed', at: now0, actor: 'engine', payload: { themeId: 'minor-accident', kind: 'minor_accident', label: 'a small accident', onsetAt: now0 + 20 * HOUR, roll: 0.0001, p: 0.001, nominated: false, durationDays: 2 } });
// A proposal before the target that the owner vetoes after it → stays vetoed (kept).
const propVeto = append({ type: 'heavy.proposed', at: now0, actor: 'engine', payload: { themeId: 'friend-moving', kind: 'friend_moving_away', label: 'a friend moves away', onsetAt: now0 + 60 * HOUR, roll: 0.0001, p: 0.001, nominated: false, durationDays: 5 } });
// An open decision whose decideBy falls between the target and now → expired as stale.
const stale = append({
  type: 'decision.opened', at: now0, actor: 'engine',
  payload: { kind: 'cafe', subject: { eventAt: now0 + 3 * HOUR, placeId: 'place:cafe', castIds: [] }, opensAt: now0, decideBy: now0 + 2 * HOUR, ponrAt: now0 + 2 * HOUR + 1200, mode: 'auto',
    options: [{ id: 'go', label: 'Go', cost: {}, expiresAt: now0 + 3 * HOUR }, { id: 'stay', label: 'Stay in', cost: {} }] },
});
// A DM claim flagged before the target.
const dm = '15550003333@s.whatsapp.net';
const { getDb } = await import('../../src/memory/db.js');
const claimId = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
  VALUES (?, 'dm', ?, 'M1', 'see you at the park', 'commitment', 0.9, 'flagged', ?)`).run(dm, dm, now0).lastInsertRowid);
const flagged = append({ type: 'claim.flagged', at: now0, actor: 'chat', originKind: 'dm', originJid: dm, payload: { claimId } });
const review = store.createReview({ claimId, claimEventId: flagged.id, chatJid: dm, originKind: 'dm', originJid: dm, createdAt: now0, status: 'tray' }).id;

clock.advance({ minutes: 30 });
const target = append({ type: 'vitals.checkpoint', at: clock.now(), actor: 'engine', payload: { date: 'x', vitals: {} } });
const targetAt = target.at;
const atTarget = await foldAt(target.id);

await simulateHoursLocal(3);
// After the target: an adoption of the claim, a slider change (kept), a veto (kept), a late claim reply.
const adopted = append({ type: 'claim.adopted', at: clock.now(), actor: 'engine', causeId: flagged.id, payload: { claimId, reviewId: review, as: 'commitment', ref: null } });
append({ type: 'commitment.recorded', at: clock.now(), actor: 'engine', causeId: adopted.id, payload: { dueAt: clock.now() + DAY, castIds: [], label: 'meet at the park' } });
store.updateReview(review, { status: 'adopted', adoptedEventId: adopted.id });
getDb().prepare(`UPDATE life_claims SET status = 'adopted', reviewed_at = ?, reviewed_by = 'engine' WHERE id = ?`).run(clock.now(), claimId);
const slider = append({ type: 'director.slider_set', at: clock.now(), actor: 'owner', payload: { slider: 'drama', value: 0.9 } });
append({ type: 'heavy.vetoed', at: clock.now(), actor: 'owner', payload: { proposedId: propVeto.id } });
getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
  VALUES (?, 'dm', ?, 'M2', 'yes I went running this morning', 'claim', 0.8, 'flagged', ?)`).run(dm, dm, clock.now());
const beat = append({ type: 'cast.beat', at: clock.now(), actor: 'engine', payload: { castId: 'cast:sibling', kind: 'trip', text: 'a short trip' } });
await simulateHoursLocal(2);

async function simulateHoursLocal(h) {
  // The facade is stopped: advance time with a few plain events (enough for a log).
  for (let i = 0; i < h * 4; i++) {
    clock.advance({ minutes: 15 });
    append({ type: 'phone.check.started', at: clock.now(), actor: 'engine', payload: { until: clock.now() + 60 } });
  }
}

section('target selection and rules');
{
  eq('targetFor(targetAt) is the target', rewind.targetFor(targetAt, state), target.id);
  eq('targetFor(targetAt + 1 s) skips kept events after it', rewind.targetFor(targetAt + 1, state) >= target.id, true);
  eq('a kept-type target is refused', codeOfSync(() => director.plan({ kind: 'rewind', toEventId: slider.id }, state)), 'refused:target_kept');
  eq('genesis is refused', codeOfSync(() => director.plan({ kind: 'rewind', toEventId: 1 }, state)), 'refused:before_genesis');
  eq('the last event leaves nothing to rewind', codeOfSync(() => director.plan({ kind: 'rewind', toEventId: state.lastEventId }, state)), 'refused:nothing');
  const old = config.arcs.rewindDays;
  config.arcs.rewindDays = 1;
  const early = listEvents({ types: ['plan.made'], limit: 1 })[0];
  eq('beyond ARCS_REWIND_DAYS → refused', codeOfSync(() => director.plan({ kind: 'rewind', toEventId: early.id }, state)), 'refused:beyond_window');
  config.arcs.rewindDays = old;
  eq('a jid in the reason → invalid', codeOfSync(() => director.plan({ kind: 'rewind', toEventId: target.id, reason: 'per 15550009999@s.whatsapp.net' }, state)), 'invalid:jid_in_text');
}

section('preview');
const lastBefore = state.lastEventId;
const pv = await director.preview({ kind: 'rewind', at: targetAt, reason: 'try that afternoon again' });
const types = pv.events.map(e => e.type);
{
  eq('batch order', types.slice(0, 3), ['director.action', 'world.rewound', 'world.reanchored']);
  eq('world.rewound targets the picked event', pv.events[1].payload.toEventId, target.id);
  eq('world.rewound is owner, caused by the action', [pv.events[1].actor, pv.events[1].causeRef], ['owner', '$1']);
  check('steps are engine events caused by world.rewound', pv.events.slice(2).every(e => e.actor === 'engine' && e.causeRef === '$2'));
  const lapsed = pv.events.filter(e => e.type === 'heavy.lapsed').map(e => e.payload.proposedId);
  eq('the pending proposal inside the lead time lapses; the vetoed one does not', lapsed, [propLapse.id]);
  const expired = pv.events.filter(e => e.type === 'decision.expired').map(e => [e.payload.decisionId, e.payload.reason]);
  check('the stale open decision expires (rewound)', expired.some(([id, r]) => id === stale.id && r === 'rewound'), expired);
  check('lists cancelled events by type', pv.extra.cancelled.total > 0 && pv.extra.cancelled.byType['cast.beat'] === 1, pv.extra.cancelled);
  check('counts routine phone checks', pv.extra.routineCount > 0);
  eq('the adopted claim returns to the tray', pv.extra.returned, [review]);
  check('mismatched replies: the late flagged reply with an excerpt', pv.extra.mismatched.claims.some(c => c.excerpt.includes('running') && c.chatName === 'Chat'));
  eq('…and the count of his other replies', pv.extra.mismatched.otherReplies, 7 - pv.extra.mismatched.claims.length);
  check('warnings mention returned claims', pv.warnings.some(w => w.includes('return to the tray')));
  eq('nothing written by the preview', lastEventId(), lastBefore);
}

section('apply (a routine phone check after the preview still applies)');
clock.advance({ seconds: 40 });
append({ type: 'phone.check.started', at: clock.now(), actor: 'engine', payload: { until: clock.now() + 60 } });
const planned = director.plan({ kind: 'rewind', at: targetAt, reason: 'try that afternoon again' }, state, { now: pv.events[0].at });
const res = await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
const rewound = res.eventIds.map(getEvent).find(e => e.type === 'world.rewound');
{
  check('applied', res.ok === true && !!rewound);
  eq('appended the previewed types in order', res.eventIds.map(id => getEvent(id).type), types);
  check('the range covers everything after the target', isExcludedId(state, beat.id) && isExcludedId(state, adopted.id));
  check('…but not the kept slider change', !isExcludedId(state, slider.id) && state.story.controls.sliders.drama === 0.9);
  eq('the vetoed proposal stays vetoed', state.story.heavy.proposals[propVeto.id]?.status, 'vetoed');
  eq('the lapsed proposal is lapsed', state.story.heavy.proposals[propLapse.id]?.status, 'lapsed');
  eq('the stale decision expired', state.decisions.get(stale.id)?.status, 'expired');
  eq('the review is back in the tray', [store.getReview(review).status, store.getReview(review).reason], ['returned', 'rewound']);
  eq('…and its life_claims row is flagged again', Object.values(getDb().prepare('SELECT status, reviewed_at, reviewed_by FROM life_claims WHERE id = ?').get(claimId)), ['flagged', null, null]);
  eq('pulse rebased', rebased, 1);
  eq('he is re-anchored at the apply clock', state.reanchoredAt, pv.events[0].at);
  check('no beat from the range', state.story.castLife['cast:sibling']?.lastBeat?.eventId !== beat.id);
}

section('SC-005: the projection equals the target');
{
  const afterStep1 = await foldAt(rewound.id);
  // fold at the target + the kept events of the range: the slider (controls are outside the
  // equivalence) and the veto (its proposal is vetoed, not pending).
  const expected = structuredClone(atTarget);
  expected.story.heavy.proposals[propVeto.id].status = 'vetoed';
  check('state after world.rewound ≡ fold at the target + kept events', storyEquivalent(afterStep1, expected));
  check('…and differs from the fold at the target alone only by the veto', !storyEquivalent(afterStep1, atTarget));
  check('the preview\'s rebuilt state ≡ the real one', storyEquivalent(planned.rebuiltState, afterStep1));
  eq('vitals after the whole batch = the target\'s vitals (no integration)', JSON.stringify(state.vitals), JSON.stringify(atTarget.vitals));
  const full = rebuild({ world, useSnapshot: false });
  check('a full replay converges and agrees', storyEquivalent(full, state));
}

section('nested rewinds compose; a rewind to a bookmark');
{
  await simulateHoursLocal(1);
  const bmPv = await director.preview({ kind: 'bookmark', name: 'after the rewind' });
  await director.apply(bmPv.previewId, bmPv.fingerprint);
  const bm = state.story.bookmarks.at(-1);
  await simulateHoursLocal(1);
  const extra = append({ type: 'cast.beat', at: clock.now(), actor: 'engine', payload: { castId: 'cast:parent', kind: 'news', text: 'some news' } });
  const p2 = await director.preview({ kind: 'rewind', bookmarkId: bm.id });
  await director.apply(p2.previewId, p2.fingerprint);
  check('the second range excludes the new beat', isExcludedId(state, extra.id));
  check('the first range still holds', isExcludedId(state, beat.id));
  const full = rebuild({ world, useSnapshot: false });
  check('two rewinds: a full replay converges', storyEquivalent(full, state));
}

section('post-rebuild withdrawal guard');
{
  // A withdrawn review whose adoption is live (a missed keep) is reverted again.
  const c2 = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, 'M3', 'x', 'claim', 0.8, 'flagged', ?)`).run(dm, dm, clock.now()).lastInsertRowid);
  const f2 = append({ type: 'claim.flagged', at: clock.now(), actor: 'chat', originKind: 'dm', originJid: dm, payload: { claimId: c2 } });
  const r2 = store.createReview({ claimId: c2, claimEventId: f2.id, chatJid: dm, originKind: 'dm', originJid: dm, createdAt: clock.now(), status: 'tray' }).id;
  const a2 = append({ type: 'claim.adopted', at: clock.now(), actor: 'engine', causeId: f2.id, payload: { claimId: c2, reviewId: r2, as: 'activity', ref: null } });
  store.withdrawReviews([c2]);
  const n = rewind.recheckWithdrawals({ getState: () => state, append, now: clock.now() });
  eq('one adoption re-reverted', n, 1);
  check('the adoption is excluded', isExcludedId(state, a2.id));
}

if (!(await skipSimUnlessWired())) {
  // Through the wired facade (T024): a fresh log, two simulated days, a rewind to
  // yesterday afternoon via story.director, then the pulse keeps living from now.
  section('sim: a rewind through the life facade');
  director.__setDepsForTest(null);
  await setupScratchDb();
  const sim = await bootLife();
  await simulateDays(2);
  const story = await import('../../src/life/story/index.js');
  const life = sim.life;
  const T = sim.clock.now() - DAY + 6 * HOUR;
  const p = await story.director.preview({ kind: 'rewind', at: T, reason: 'sim' });
  check('preview lists the batch', p.events[1]?.type === 'world.rewound');
  sim.clock.advance({ seconds: 30 });
  const r = await story.director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  check('applied through the facade', r.ok === true);
  const toId = p.events[1].payload.toEventId;
  const rewoundId = r.eventIds.find(id => getEvent(id)?.type === 'world.rewound');
  check('SC-005 through the facade: fold after world.rewound ≡ fold at the target (+ kept)',
    storyEquivalent(await foldAt(rewoundId), await foldAt(toId)));
  await simulateHours(6);
  check('the pulse lives on after the rewind', life.getState().at >= sim.clock.now() - HOUR);
  await stopLife();
}

void HOUR; void simulateDays; void simulateHours; void getEvent;
report();
