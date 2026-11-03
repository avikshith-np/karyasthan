// T006 — src/life/story/store.js, the only door to the v11 story tables
// (data-model.md §1, §6): CRUD on all 8 tables, uniqueness (one review per claim, one
// journal part per night and origin), enum/size validation (fail closed), the
// refusal dedupe per (source, target, reason) per hour, forget/purge helpers, the
// seed-attempt gate, prunes, and a static check that every SQL statement is a
// literal with `?` parameters. Scratch DB through the real ladder, fake clock.
import fs from 'fs';
import path from 'path';
import { setupScratchDb, fakeClock, section, check, eq, throws, report, PROJECT_ROOT, STORY_TABLES, DAY, HOUR }
  from './_helpers.js';
import { setClock, now } from '../../src/life/clock.js';
import * as store from '../../src/life/story/store.js';

const { db } = await setupScratchDb();
const T0 = Date.UTC(2026, 9, 30, 13, 10) / 1000;
const clock = fakeClock(T0);
setClock(clock.fn);

const G1 = '120363000000000101@g.us';
const G2 = '120363000000000102@g.us';
const DM = '15550000105@s.whatsapp.net';
const count = (t) => db.prepare('SELECT COUNT(*) FROM ' + t).pluck().get();   // table names from STORY_TABLES only

try {
  section('ladder');
  check('all 8 story tables exist', STORY_TABLES.every(t => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)));
  eq('every table starts empty', STORY_TABLES.map(count), STORY_TABLES.map(() => 0));

  section('claim reviews');
  const r1 = store.createReview({ claimId: 11, claimEventId: 501, chatJid: G1, originKind: 'group', originJid: G1, trayHours: 72 });
  check('create → id, created', r1.created === true && Number.isInteger(r1.id));
  const again = store.createReview({ claimId: 11, claimEventId: 999, chatJid: G2, originKind: 'group', originJid: G2 });
  eq('one review per claim: a second create returns the same row untouched', [again.id, again.created], [r1.id, false]);
  const rv = store.getReview(r1.id);
  eq('stored fields (camelCase, expiry = created + tray hours)', [rv.claimId, rv.claimEventId, rv.chatJid, rv.status, rv.createdAt, rv.expiresAt],
    [11, 501, G1, 'pending', T0, T0 + 72 * HOUR]);
  eq('getReviewByClaim', store.getReviewByClaim(11).id, r1.id);
  throws('origin kind must be group|dm', () => store.createReview({ claimId: 12, chatJid: G1, originKind: 'self', originJid: 'self' }), /originKind/);
  throws('a claim id is required', () => store.createReview({ chatJid: G1, originKind: 'group', originJid: G1 }), /claimId/);

  const extraction = { type: 'plan', kind: 'movie', when: { relative: 'tonight', time: '21:00' }, place: 'cinema', people: [], summary: 'goes out', confidence: 0.9 };
  check('compare-and-set: pending → extracting', store.updateReview(r1.id, { status: 'extracting' }, { fromStatus: 'pending' }));
  check('… a second claim of the same row is refused', !store.updateReview(r1.id, { status: 'extracting' }, { fromStatus: 'pending' }));
  check('tray with reason + extraction', store.updateReview(r1.id, { status: 'tray', reason: 'conflict', extraction,
    conflict: { with: { kind: 'work', start: 1, end: 2 } }, runId: 3 }));
  const rt = store.getReview(r1.id);
  eq('JSON columns parsed back', [rt.status, rt.reason, rt.extraction.kind, rt.conflict.with.kind, rt.runId], ['tray', 'conflict', 'movie', 'work', 3]);
  check('tray is not a decided state (decidedAt stays null)', rt.decidedAt === null);
  throws('unknown status refused', () => store.updateReview(r1.id, { status: 'maybe' }), /status/);
  throws('unknown reason refused', () => store.updateReview(r1.id, { reason: 'because' }), /reason/);
  throws('unknown patch field refused', () => store.updateReview(r1.id, { claimId: 99 }), /no field/);
  throws('an oversized extraction is refused (≤ 2 KB)', () => store.updateReview(r1.id, { extraction: { summary: 'x'.repeat(3000) } }), /larger/);
  clock.advance({ minutes: 5 });
  check('adopt', store.updateReview(r1.id, { status: 'adopted', reason: null, adoptedEventId: 777, decidedBy: 'engine' }));
  const ra = store.getReview(r1.id);
  eq('a decided status stamps decidedAt (now) and keeps the rest', [ra.status, ra.reason, ra.decidedAt, ra.adoptedEventId, ra.extraction.kind],
    ['adopted', null, T0 + 300, 777, 'movie']);
  eq('unknown review → false', store.updateReview(424242, { status: 'tray' }), false);

  const r2 = store.createReview({ claimId: 12, chatJid: DM, originKind: 'dm', originJid: DM, trayHours: 12 });
  const r3 = store.createReview({ claimId: 13, chatJid: G2, originKind: 'group', originJid: G2, status: 'tray' });
  eq('listReviews: newest first', store.listReviews().map(r => r.claimId), [13, 12, 11]);
  eq('listReviews: status list filter', store.listReviews({ status: ['pending', 'tray'] }).map(r => r.claimId), [13, 12]);
  eq('listReviews: origin filter', store.listReviews({ originJid: DM }).map(r => r.claimId), [12]);
  eq('listReviews: before + limit', store.listReviews({ before: r3.id, limit: 1 }).map(r => r.claimId), [12]);
  eq('countReviews by status', [store.countReviews(), store.countReviews({ status: 'adopted' })], [3, 1]);
  eq('reviewsAdoptedBetween (a rewound range)', [store.reviewsAdoptedBetween(700, 800).map(r => r.id), store.reviewsAdoptedBetween(1, 10).length],
    [[r1.id], 0]);
  eq('nothing expired yet', store.listExpiredReviews(now()).length, 0);
  clock.advance({ hours: 13 });
  eq('the 12 h DM review is due (pending|tray past expires_at)', store.listExpiredReviews(now()).map(r => r.id), [r2.id]);

  // 009 claims with and without a review (boot sweep).
  const insClaim = db.prepare(`INSERT INTO life_claims (id, chat_jid, origin_kind, origin_jid, text, status, created_at)
    VALUES (?, ?, 'group', ?, 'a reply', ?, ?)`);
  insClaim.run(11, G1, G1, 'flagged', T0);
  insClaim.run(14, G1, G1, 'flagged', T0 + 10);
  insClaim.run(15, G1, G1, 'dismissed', T0 + 20);
  insClaim.run(16, G1, G1, 'flagged', T0 - 5 * DAY);
  const sweep = store.claimsWithoutReview({ since: T0 - DAY });
  eq('claimsWithoutReview: flagged, unreviewed, recent — ids and routing only', sweep,
    [{ claimId: 14, chatJid: G1, originKind: 'group', originJid: G1, createdAt: T0 + 10 }]);

  section('withdraw / purge reviews');
  const before = store.withdrawReviews([11, 13], { by: 'system:forget' });
  eq('withdraw returns the rows as they were', before.map(r => [r.claimId, r.status, r.adoptedEventId]), [[11, 'adopted', 777], [13, 'tray', null]]);
  const w1 = store.getReview(r1.id);
  eq('… extraction/resolution/conflict NULLed, status withdrawn', [w1.status, w1.extraction, w1.resolution, w1.conflict, w1.decidedBy],
    ['withdrawn', null, null, null, 'system:forget']);
  const at1 = w1.decidedAt;
  clock.advance({ minutes: 1 });
  store.withdrawReviews([11], { by: 'system:revoke' });
  eq('a second withdrawal keeps the first decision', [store.getReview(r1.id).decidedAt, store.getReview(r1.id).decidedBy], [at1, 'system:forget']);
  eq('deleteReviewsByOrigins', store.deleteReviewsByOrigins([DM]), 1);
  eq('deleteReviewsByClaims', store.deleteReviewsByClaims([11, 13, 999]), 2);
  eq('reviews gone', count('story_claim_reviews'), 0);

  section('runs');
  const run = store.startRun({ kind: 'extract', caller: 'life.claim.extract', input: { claimId: 14 } });
  const rr = store.getRun(run);
  eq('startRun → running, started now', [rr.status, rr.caller, rr.input.claimId, rr.startedAt, rr.finishedAt], ['running', 'life.claim.extract', 14, now(), null]);
  check('bumpRun finishes it', store.bumpRun(run, { status: 'ok', model: 'fake-clerk', costUsd: 0.0012, fellBack: true, output: { type: 'plan' }, dropped: [{ path: 'x', reason: 'cap' }] }));
  const rf = store.getRun(run);
  eq('… with finishedAt, cost, fellBack, output', [rf.status, rf.finishedAt, rf.costUsd, rf.fellBack, rf.output.type, rf.dropped.length], ['ok', now(), 0.0012, true, 'plan', 1]);
  throws('a run kind outside the enum is refused', () => store.startRun({ kind: 'think', caller: 'x' }), /kind/);
  throws('a skip reason outside the enum is refused', () => store.bumpRun(run, { skipReason: 'tired' }), /skipReason/);
  throws('unknown run patch field refused', () => store.bumpRun(run, { kind: 'weekly' }), /no field/);
  throws('an oversized output object (> 8 KB) is refused, not truncated silently', () => store.recordRun({ kind: 'weekly',
    caller: 'life.arcs.weekly', status: 'ok', output: { parts: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'p'.repeat(40) })) } }), /larger/);
  store.recordRun({ kind: 'extract', caller: 'life.claim.extract', status: 'skipped', skipReason: 'cap_hour' });
  store.recordRun({ kind: 'journal', caller: 'life.journal', status: 'ok' });
  eq('countRuns by kind', store.countRuns({ kind: 'extract' }), 2);
  eq('countRuns excluding skips (calls actually made)', store.countRuns({ kind: ['extract', 'journal'], excludeStatus: 'skipped' }), 2);
  eq('countRuns since/until window', [store.countRuns({ since: now() + 1 }), store.countRuns({ until: now() + 1 })], [0, 3]);
  eq('countRuns by caller', store.countRuns({ caller: 'life.journal' }), 1);
  eq('lastRun of a kind', store.lastRun({ kind: 'extract' }).status, 'skipped');
  eq('lastRun with a status filter', store.lastRun({ kind: 'extract', status: 'ok' }).id, run);
  eq('listRuns has no JSON bodies', Object.keys(store.listRuns({ limit: 1 })[0]).some(k => ['input', 'output', 'dropped'].includes(k)), false);
  eq('dropped list is trimmed from the end to fit 8 KB', (() => {
    const id = store.recordRun({ kind: 'weekly', caller: 'life.arcs.weekly', status: 'partial',
      dropped: Array.from({ length: 1000 }, (_, i) => ({ path: 'cast.' + i, reason: 'invalid' })) });
    const d = store.getRun(id).dropped;
    return d.length > 0 && d.length < 1000 && JSON.stringify(d).length <= 8192;
  })(), true);

  section('proposals');
  const p1 = store.createProposal({ runId: run, weekKey: '2026-W44', category: 'romance', kind: 'arc_decision', payload: { castId: 'cast:flatmate' } });
  const p2 = store.createProposal({ runId: run, weekKey: '2026-W44', category: 'cast', kind: 'new_cast', payload: { name: 'x' }, status: 'refused', reason: 'name_collision' });
  eq('a refused proposal is decided at once', [store.getProposal(p2).status, store.getProposal(p2).decidedAt], ['refused', now()]);
  eq('listProposals pending', store.listProposals({ status: 'pending' }).map(p => p.id), [p1]);
  throws('category outside the 7', () => store.createProposal({ runId: 1, weekKey: '2026-W44', category: 'money', kind: 'beat', payload: {} }), /category/);
  throws('week key shape', () => store.createProposal({ runId: 1, weekKey: '2026-44', category: 'cast', kind: 'beat', payload: {} }), /weekKey/);
  check('decide a pending proposal once', store.decideProposal(p1, { status: 'applied', by: 'owner:test' }));
  check('… and only once', !store.decideProposal(p1, { status: 'rejected' }));
  const p3 = store.createProposal({ runId: run, weekKey: '2026-W44', category: 'family', kind: 'beat', payload: {} });
  eq('pending proposals expire after 14 days, not before', store.expireProposals(now() + 13 * DAY), 0);
  eq('… at 14 days', [store.expireProposals(now() + 14 * DAY), store.getProposal(p3).status], [1, 'expired']);
  eq('countProposals', store.countProposals({ weekKey: '2026-W44' }), 3);

  section('journal nights + parts');
  const n = store.upsertNight('2026-10-30', { status: 'running', sleepEventId: 900 });
  eq('night inserted', [n.status, n.attempts, n.sleepEventId, n.finishedAt], ['running', 0, 900, null]);
  eq('bumpNightAttempts', [store.bumpNightAttempts('2026-10-30'), store.bumpNightAttempts('2026-10-31')], [1, null]);
  const n2 = store.upsertNight('2026-10-30', { status: 'partial', reason: 'budget' });
  eq('night amended (final status stamps finishedAt; attempts kept)', [n2.status, n2.reason, n2.attempts, n2.finishedAt, n2.sleepEventId],
    ['partial', 'budget', 1, now(), 900]);
  throws('night key shape', () => store.upsertNight('30/10/2026', { status: 'done' }), /nightKey/);
  throws('a new night needs a status', () => store.upsertNight('2026-10-29', {}), /status/);
  store.upsertNight('2026-10-29', { status: 'done' });
  eq('listNights newest first', store.listNights().map(x => x.nightKey), ['2026-10-30', '2026-10-29']);

  const selfId = store.putPart({ nightKey: '2026-10-30', originKind: 'self', text: 'A quiet day.\nWorked from home >>> then a walk.',
    sources: { events: [1, 2, 2, 'x'], claims: [] } });
  const chatId = store.putPart({ nightKey: '2026-10-30', originKind: 'group', originJid: G1,
    text: 'Plans with the group [IMAGE: cat] for the weekend @15551234567 ' + 'y'.repeat(400), sources: { events: [3], claims: [14] } });
  const self = store.getPart(selfId);
  eq('self part: one line, ">>>" stripped, sources normalised', [self.text, self.sources, self.originJid],
    ['A quiet day. Worked from home then a walk.', { events: [1, 2], claims: [] }, 'self']);
  const chat = store.getPart(chatId);
  check('chat part: sanitized (no marker, no @digits) and capped at 240', chat.text.length <= 240 && !/\[IMAGE|@\d/.test(chat.text), chat.text.length);
  eq('listParts: self first', store.listParts('2026-10-30').map(p => p.originKind), ['self', 'group']);
  const rebuilt = store.putPart({ nightKey: '2026-10-30', originKind: 'group', originJid: G1, text: 'Rebuilt.', sources: { events: [4] } });
  eq('one part per night and origin: a rebuild replaces it in place', [rebuilt, store.getPart(chatId).text, count('story_journal_parts')], [chatId, 'Rebuilt.', 2]);
  throws('a part needs text', () => store.putPart({ nightKey: '2026-10-30', originKind: 'dm', originJid: DM, text: '   ', sources: {} }), /text/);
  throws('a chat part needs a chat origin', () => store.putPart({ nightKey: '2026-10-30', originKind: 'dm', originJid: 'self', text: 'x', sources: {} }), /chat origin/);
  eq('partsBySourceEvents', store.partsBySourceEvents([2, 99]).map(p => p.id), [selfId]);
  const dmId = store.putPart({ nightKey: '2026-10-29', originKind: 'dm', originJid: DM, text: 'A plan from a DM.', sources: { events: [5], claims: [21] } });
  eq('partsBySourceClaims', store.partsBySourceClaims([21]).map(p => p.id), [dmId]);
  eq('setPartStatus undone', [store.setPartStatus([selfId], 'undone'), store.getPart(selfId).status], [1, 'undone']);
  throws('setPartStatus cannot fence (fencing NULLs the text)', () => store.setPartStatus([selfId], 'fenced'), /status/);
  eq('fencePartsByOrigin (forget in G1 on that night)', store.fencePartsByOrigin(G1, ['2026-10-30']), 1);
  const fenced = store.getPart(chatId);
  eq('… fenced, text NULL', [fenced.status, fenced.text], ['fenced', null]);
  eq('a fenced part is never rebuilt', [store.putPart({ nightKey: '2026-10-30', originKind: 'group', originJid: G1, text: 'Again.', sources: {} }),
    store.getPart(chatId).text], [null, null]);
  eq('… nor reactivated', [store.setPartStatus([chatId], 'active'), store.getPart(chatId).status], [0, 'fenced']);
  eq('fencePartsByClaims (a withdrawn claim, whatever the night)', [store.fencePartsByClaims([21]), store.getPart(dmId).text], [1, null]);
  const p4 = store.putPart({ nightKey: '2026-10-28', originKind: 'group', originJid: G2, text: 'Old night.', sources: { events: [8], claims: [31] } });
  const p5 = store.putPart({ nightKey: '2026-10-27', originKind: 'self', text: 'Older.', sources: { events: [9] } });
  const p6 = store.putPart({ nightKey: '2026-10-26', originKind: 'self', text: 'Oldest.', sources: { events: [10], claims: [32] } });
  eq('deletePartsByOrigins (never the self parts by name)', [store.deletePartsByOrigins([G2, 'self']), !!store.getPart(p4), !!store.getPart(p5)], [1, false, true]);
  eq('deletePartsBySourceEvents', [store.deletePartsBySourceEvents([9]), !!store.getPart(p5)], [1, false]);
  eq('deletePartsBySourceClaims', [store.deletePartsBySourceClaims([32]), !!store.getPart(p6)], [1, false]);

  section('narrations');
  const nar = store.putNarration({ kind: 'event', eventId: 42, origins: [G1, 'self'], text: 'He went out [VOICE: hi] tonight.', sources: [40, 41, 42] });
  const nv = store.getEventNarration(42);
  eq('event narration cached (sanitized, 30-day expiry)', [nv.id, nv.text.includes('[VOICE'), nv.origins, nv.sources, nv.expiresAt - nv.createdAt],
    [nar, false, [G1, 'self'], [40, 41, 42], 30 * DAY]);
  eq('one row per event: a re-narration replaces it', [store.putNarration({ kind: 'event', eventId: 42, origins: ['self'], text: 'Again.', sources: [42] }),
    store.getEventNarration(42).text, count('story_narrations')], [nar, 'Again.', 1]);
  store.putNarration({ kind: 'event', eventId: 43, origins: [G2], text: 'z'.repeat(900), sources: [43] });
  eq('text capped at 400', store.getEventNarration(43).text.length, 400);
  const t1 = store.putNarration({ kind: 'thought', origins: ['self'], text: 'Thinking about the week.', sources: [] });
  clock.advance({ minutes: 10 });
  const t2 = store.putNarration({ kind: 'thought', origins: ['self'], text: 'Tired.', sources: [] });
  eq('thoughts append; latestThought is the newest', [t1 !== t2, store.latestThought().id], [true, t2]);
  clock.advance({ hours: 1, minutes: 1 });
  eq('a thought expires after 1 h', store.latestThought(), null);
  throws('an event narration needs an event id', () => store.putNarration({ kind: 'event', origins: [], text: 'x', sources: [] }), /eventId/);
  eq('deleteNarrationsByOrigins', [store.deleteNarrationsByOrigins([G2]), store.getEventNarration(43)], [1, null]);
  store.putNarration({ kind: 'event', eventId: 50, origins: ['self'], text: 'Cites 49.', sources: [48, 49] });
  eq('deleteNarrationsBySourceEvents (its own event or a cited one)', store.deleteNarrationsBySourceEvents([42, 49]), 2);

  section('refusals (deduped per source/target/reason per hour)');
  const base = { source: 'engine', category: 'romance', action: 'start', target: 'cast:flatmate', reason: 'frozen', detail: { arcId: 5 } };
  const f1 = store.recordRefusal(base);
  clock.advance({ minutes: 30 });
  const f2 = store.recordRefusal({ ...base, detail: { arcId: 6 } });
  eq('same (source, target, reason) within the hour → one row', [f1.deduped, f2.deduped, f2.id === f1.id, count('story_refusals')], [false, true, true, 1]);
  store.recordRefusal({ ...base, target: 'cast:sibling' });
  store.recordRefusal({ ...base, reason: 'pinned', pinKey: 'cast:flatmate' });
  store.recordRefusal({ ...base, source: 'mind' });
  eq('a different target, reason or source → new rows', count('story_refusals'), 4);
  store.recordRefusal({ ...base, target: null, action: 'beat' });
  const nullAgain = store.recordRefusal({ ...base, target: null, action: 'beat' });
  eq('a null target dedupes too', [nullAgain.deduped, count('story_refusals')], [true, 5]);
  clock.advance({ minutes: 30 });
  eq('one hour after the first → a new row', [store.recordRefusal(base).deduped, count('story_refusals')], [false, 6]);
  throws('reason outside the enum', () => store.recordRefusal({ ...base, reason: 'nope' }), /reason/);
  throws('action outside the enum', () => store.recordRefusal({ ...base, action: 'delete' }), /action/);
  throws('detail > 1 KB refused', () => store.recordRefusal({ ...base, target: 'x', detail: { pad: 'q'.repeat(1100) } }), /larger/);
  eq('listRefusals filters', [store.listRefusals({ reason: 'pinned' }).length, store.listRefusals({ source: 'mind' }).length, store.listRefusals().length], [1, 1, 6]);
  eq('countRefusals since', store.countRefusals({ since: now() - 1 }), 1);

  section('story_state');
  eq('every known key, null when unset', store.getState(), { last_weekly_at: null, last_weekly_run: null, seed: null, extract_counters: null, degraded: null, scenes_cursor: null, scenes_on: null, phone_cursor: null, phone_on: null, phone_rolled: null, phone_bond_rolled: null, sweep_findings: null, sweep_dismissed: null, phone_plan_outcomes: null });   // 016: the scene detector's cursor + its on flag; 019: the phone's; 020: the nightly sweep's
  {
    // 020 E1: the sweep's two list keys may hold 64 KB; every other key stays at the small limit.
    const big = (n) => ({ filler: 'x'.repeat(n) });
    let refused = null;
    try { store.patchState({ last_weekly_run: big(5000) }); } catch (err) { refused = err.message; }
    check('a normal key still refuses 5 KB', /not storable/.test(refused ?? ''), refused);
    store.patchState({ sweep_findings: big(60000) });
    eq('the sweep key holds 60 KB', store.getState('sweep_findings').filler.length, 60000);
    let over = null;
    try { store.patchState({ sweep_dismissed: big(70000) }); } catch (err) { over = err.message; }
    check('…but not 70 KB', /not storable/.test(over ?? ''), over);
    store.patchState({ sweep_findings: null });
    eq('getStateChecked: absent', store.getStateChecked('sweep_findings'), { value: null, corrupt: false });
    db.prepare("INSERT INTO story_state (key, value_json, updated_at) VALUES ('sweep_dismissed', '{bad', 0)").run();
    eq('getStateChecked: a value that does not parse', store.getStateChecked('sweep_dismissed'), { value: null, corrupt: true });
    eq('…getState reads it as unset', store.getState('sweep_dismissed'), null);
    store.patchState({ sweep_dismissed: null });
  }
  check('beginSeedAttempt writes the attempt marker once', store.beginSeedAttempt() === true);
  eq('… the marker', store.getState('seed'), { source: 'pending', attemptedAt: now() });
  check('… and refuses any further automatic attempt', store.beginSeedAttempt() === false);
  store.patchState({ seed: { source: 'example', attemptedAt: now(), reason: 'budget' }, lastWeeklyAt: now(), degraded: { at: now(), where: 'weekly' } });
  eq('patchState (camelCase alias) + getState(key)', [store.getState('last_weekly_at'), store.getState('lastWeeklyAt'), store.getState('seed').source],
    [now(), now(), 'example']);
  check('… an existing seed record still refuses beginSeedAttempt', store.beginSeedAttempt() === false);
  store.patchState({ degraded: null });
  eq('null deletes a key', store.getState('degraded'), null);
  throws('unknown key refused', () => store.patchState({ mood: 'x' }), /no key/);
  throws('oversized value refused', () => store.patchState({ extract_counters: { pad: 'w'.repeat(5000) } }), /storable/);

  section('prunes (data-model §6)');
  const t = now();
  db.prepare(`INSERT INTO story_runs (kind, caller, status, started_at) VALUES ('extract', 'old', 'ok', ?)`).run(t - 181 * DAY);
  db.prepare(`INSERT INTO story_runs (kind, caller, status, started_at) VALUES ('extract', 'old-running', 'running', ?)`).run(t - 181 * DAY);
  db.prepare(`INSERT INTO story_runs (kind, caller, status, started_at) VALUES ('extract', 'recent', 'ok', ?)`).run(t - 179 * DAY);
  db.prepare(`INSERT INTO story_refusals (at, source, action, reason) VALUES (?, 'engine', 'beat', 'cap')`).run(t - 91 * DAY);
  db.prepare(`INSERT INTO story_proposals (run_id, week_key, category, kind, payload_json, status, created_at, decided_at)
    VALUES (1, '2026-W01', 'cast', 'beat', '{}', 'rejected', ?, ?)`).run(t - 100 * DAY, t - 91 * DAY);
  db.prepare(`INSERT INTO story_proposals (run_id, week_key, category, kind, payload_json, status, created_at)
    VALUES (1, '2026-W01', 'cast', 'beat', '{}', 'pending', ?)`).run(t - 15 * DAY);
  db.prepare(`INSERT INTO story_claim_reviews (claim_id, chat_jid, origin_kind, origin_jid, status, created_at, decided_at, expires_at)
    VALUES (101, ?, 'group', ?, 'rejected', ?, ?, ?)`).run(G1, G1, t - 200 * DAY, t - 181 * DAY, t - 197 * DAY);
  db.prepare(`INSERT INTO story_claim_reviews (claim_id, chat_jid, origin_kind, origin_jid, status, created_at, decided_at, expires_at)
    VALUES (102, ?, 'group', ?, 'adopted', ?, ?, ?)`).run(G1, G1, t - 200 * DAY, t - 170 * DAY, t - 197 * DAY);
  db.prepare(`INSERT INTO story_claim_reviews (claim_id, chat_jid, origin_kind, origin_jid, status, created_at, expires_at)
    VALUES (103, ?, 'group', ?, 'tray', ?, ?)`).run(G1, G1, t - 200 * DAY, t - 1 * DAY);
  db.prepare(`INSERT INTO story_narrations (kind, event_id, origins_json, text, sources_json, created_at, expires_at)
    VALUES ('event', 77, '[]', 'old', '[]', ?, ?)`).run(t - 31 * DAY, t - DAY);
  const partsBefore = count('story_journal_parts');
  const pr = store.pruneStory(t);
  // narrations: the old event row + the two expired thoughts from the narrations section
  eq('pruneStory counts', pr, { proposalsExpired: 1, runs: 1, refusals: 1, proposals: 1, reviews: 1, narrations: 3 });
  eq('… a stale running run and recent rows are kept', db.prepare(`SELECT caller FROM story_runs WHERE caller LIKE 'old%' OR caller = 'recent' ORDER BY caller`).pluck().all(),
    ['old-running', 'recent']);
  eq('… a decided review < 180 d and an undecided one are kept', db.prepare('SELECT claim_id FROM story_claim_reviews ORDER BY claim_id').pluck().all(), [102, 103]);
  eq('… journal parts are never pruned', count('story_journal_parts'), partsBefore);
  eq('a second prune is a no-op', Object.values(store.pruneStory(t)).reduce((a, b) => a + b, 0), 0);

  section('static: parameterised SQL only');
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'life', 'story', 'store.js'), 'utf-8');
  const templates = src.match(/`[^`]*`/g) || [];
  const sqlTemplates = templates.filter(s => /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA)\b/.test(s));
  check('SQL is written as literals (some found)', sqlTemplates.length > 10, sqlTemplates.length);
  eq('no template literal with ${…} holds SQL', sqlTemplates.filter(s => s.includes('${')).length, 0);
  eq('no ${…} interpolation anywhere in store.js', (src.match(/\$\{/g) || []).length, 0);
  // The statement cache q(sql) is the one prepare() site; every q() call passes a literal.
  const prepares = [...src.matchAll(/\b(?:prepare|q)\(\s*([^\s)])/g)].map(m => m[0]);
  const nonLiteral = prepares.filter(c => !/[`']$/.test(c));
  check('every q() call takes a string literal (the only prepare() is the cache in q)', prepares.length > 10
    && JSON.stringify(nonLiteral) === JSON.stringify(['q(s', 'prepare(s']) && /function q\(sql\) \{/.test(src)
    && (src.match(/\.prepare\(/g) || []).length === 1, nonLiteral);
  check('no SQL string concatenation (" + " next to a SQL keyword)', !/['`]\s*\+\s*\w+\s*\+?\s*['`]?\s*(?:WHERE|AND|SET|VALUES|FROM)\b/.test(src)
    && !/(?:SELECT|INSERT|UPDATE|DELETE)[^;`']*['`]\s*\+/.test(src));
  check('only the v11 tables and life_claims (read) are named', [...src.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/g)]
    .every(m => STORY_TABLES.includes(m[1]) || m[1] === 'life_claims' || m[1] === 'json_each'));
} finally {
  setClock(null);
}

report();
