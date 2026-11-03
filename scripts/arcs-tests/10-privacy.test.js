// 010 T024 — privacy across audiences with 006's real rule wired (research R5,
// SC-001, FR-030, FR-039):
//   - attach installs canUseIn = 006's rule while `arcs` is on: a group fact reaches a
//     subset group and a member's DM, never a group with an outsider; a DM fact stays
//     in that DM; with `arcs` off the same-chat fallback is back;
//   - owner facts appear everywhere; an owner fact with a subject only where that
//     person is;
//   - a DM claim opened as an outing scene (Director, fromReviewId) keeps the DM origin:
//     usable in that DM, absent from every group; a non-outing scene from a claim
//     carries the "visible in every chat" warning;
//   - journal / narration text in no prompt line (group, DM, call);
//   - purge with life stopped: the person's DM reviews, the group review that resolved
//     them (with its life_claims row), their parts and narrations go; no story row
//     keeps their JID or name.
// Scratch DB, fake clock, fake Jev and models, no network. Invented names.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, setSkills, seedPeople, seedGroups, HOUR,
} from './_helpers.js';
import { appendEvent, getEvent } from '../../src/life/eventLog.js';
import { getDb } from '../../src/memory/db.js';
import * as innerState from '../../src/life/innerState.js';
import * as store from '../../src/life/story/store.js';

await setupScratchDb();
const recall = await import('../../src/memory/recall.js');
const story = await import('../../src/life/story/index.js');

const NAMES = { A: 'Avery Thornquist', B: 'Blake Marlowe', C: 'Casey Ondrejka', D: 'Drew Vantongeren' };
const PN = { A: '15550001001@s.whatsapp.net', B: '15550001002@s.whatsapp.net', C: '15550001003@s.whatsapp.net', D: '15550001004@s.whatsapp.net' };
const [A, B, C, D] = await seedPeople(['A', 'B', 'C', 'D'].map(k => ({ jid: `${9100 + k.charCodeAt(0)}@lid`, name: NAMES[k], pn: PN[k] })));
const [GX, GY, GZ] = await seedGroups([
  { jid: '120363000000010001@g.us', name: 'Trail club', members: [A, B, C] },
  { jid: '120363000000010002@g.us', name: 'Trail core', members: [A, B] },
  { jid: '120363000000010003@g.us', name: 'Mixed', members: [A, D] },
]);
const aud = (chatJid) => recall.resolveAudience(chatJid.endsWith('@g.us') ? { chatJid, kind: 'group' } : { chatJid, kind: 'dm' });

const { life, clock } = await bootLife();
await simulateHours(3);
await new Promise(r => setTimeout(r, 20));   // attach resolves 006's rule asynchronously
const now = clock.now();

section('006 rule wired: group facts follow the subset rule, DM facts stay put');
{
  const groupFact = { originJid: GX, learnedAt: now };
  eq('group fact in its own group', innerState.factAllowed(groupFact, aud(GX)), true);
  eq('…in a subset group (members joined before)', innerState.factAllowed(groupFact, aud(GY)), true);
  eq("…in a member's DM", innerState.factAllowed(groupFact, aud(PN.A)), true);
  eq('…never in a group with an outsider', innerState.factAllowed(groupFact, aud(GZ)), false);
  eq("…never in a non-member's DM", innerState.factAllowed(groupFact, aud(PN.D)), false);
  const dmFact = { originJid: PN.A, learnedAt: now };
  eq('DM fact in that DM', innerState.factAllowed(dmFact, aud(PN.A)), true);
  eq('…not in any group', [GX, GY, GZ].map(g => innerState.factAllowed(dmFact, aud(g))), [false, false, false]);
  eq("…not in another person's DM", innerState.factAllowed(dmFact, aud(PN.B)), false);
}

section('owner facts: everywhere; with a subject only where the subject is');
{
  eq('owner fact in every audience', [GX, GY, GZ, PN.D].map(c => innerState.factAllowed({ originJid: 'owner', learnedAt: now }, aud(c))), [true, true, true, true]);
  const withSubject = { originJid: 'owner', learnedAt: now, subjectJid: C };
  eq('owner fact naming C: only where C is', [GX, GY, GZ].map(g => innerState.factAllowed(withSubject, aud(g))), [true, false, false]);
}

section('a DM claim opened as an outing scene keeps the DM origin');
let reviewId;
{
  const at = clock.now();
  const claimId = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, 'P10-1', 'SECRET-CLAIM coffee tomorrow evening', 'commitment', 0.9, 'flagged', ?)`).run(PN.A, PN.A, at).lastInsertRowid);
  const flagged = appendEvent({ type: 'claim.flagged', at, actor: 'chat', originKind: 'dm', originJid: PN.A, payload: { claimId, kind: 'commitment' } });
  reviewId = store.createReview({ claimId, claimEventId: flagged.id, chatJid: PN.A, originKind: 'dm', originJid: PN.A, createdAt: at, status: 'tray' }).id;
  const tomorrow = at + 30 * HOUR;
  store.updateReview(reviewId, {
    reason: 'review_mode',
    extraction: { type: 'plan', kind: 'coffee', summary: 'SECRET-SUMMARY coffee', people: [] },
    resolution: { placeId: 'place:cafe', castIds: [], subjectJid: null, span: { start: tomorrow, end: tomorrow + HOUR } },
  });
  const draft = await story.trayScene(reviewId);
  const p = await story.director.preview(draft);
  check('the preview warns it was built from a claim', p.warnings.some(w => /claim/.test(w)));
  clock.advance({ seconds: 20 });
  const r = await story.director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  const evs = r.eventIds.map(getEvent).filter(e => e.actor === 'engine');
  check('every engine event carries the DM origin', evs.length > 0 && evs.every(e => e.originKind === 'dm' && e.originJid === PN.A), evs.map(e => e.originKind));
  eq('usable in that DM', evs.every(e => innerState.eventAllowed(e.id, aud(PN.A))), true);
  eq('absent from every group', [GX, GY, GZ].map(g => evs.some(e => innerState.eventAllowed(e.id, aud(g)))), [false, false, false]);
  check('no claim text or summary in any event', !JSON.stringify(r.eventIds.map(getEvent)).match(/SECRET-(CLAIM|SUMMARY)/));
  const c2 = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, 'P10-1b', 'good news from home', 'claim', 0.9, 'flagged', ?)`).run(PN.A, PN.A, at).lastInsertRowid);
  const f2 = appendEvent({ type: 'claim.flagged', at, actor: 'chat', originKind: 'dm', originJid: PN.A, payload: { claimId: c2, kind: 'claim' } });
  const r2 = store.createReview({ claimId: c2, claimEventId: f2.id, chatJid: PN.A, originKind: 'dm', originJid: PN.A, createdAt: at, status: 'tray' }).id;
  const bt = story.director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'news', text: 'had good news', fromReviewId: r2 });
  check('a non-outing scene from a claim warns: visible in every chat', bt.warnings.includes('visible in every chat'));
}

section('arcs off → the same-chat fallback');
{
  await setSkills({ arcs: false });
  eq('group fact no longer reaches the subset group', innerState.factAllowed({ originJid: GX, learnedAt: now }, aud(GY)), false);
  eq('…but stays in its own chat', innerState.factAllowed({ originJid: GX, learnedAt: now }, aud(GX)), true);
  await setSkills({ arcs: true });
  eq('back on: the 006 rule again', innerState.factAllowed({ originJid: GX, learnedAt: now }, aud(GY)), true);
}

section('journal and narration text reach no prompt line');
{
  const secret = 'ZQX-journal-secret line about the day';
  const nk = '2026-10-27';
  store.putPart({ nightKey: nk, originKind: 'self', originJid: 'self', text: secret, sources: { events: [], claims: [] } });
  store.putNarration({ kind: 'thought', origins: ['self'], text: 'ZQX-narration-secret thought', sources: { events: [] }, createdAt: clock.now() });
  const lines = [aud(GX), aud(PN.A), { kind: 'call', chatJid: A, personJid: A }].map(a =>
    JSON.stringify([life.innerStateLine(a), life.castCards(a, ''), life.timeLine(), life.callStateNote(A)]));
  check('no journal or narration text in any line', lines.every(l => !l.includes('ZQX-')));
}

section('purge with life stopped: no row keeps the JID or the name');
{
  await stopLife();
  const at = clock.now();
  const dmClaim = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, 'P10-2', 'gym later', 'commitment', 0.9, 'flagged', ?)`).run(PN.B, PN.B, at).lastInsertRowid);
  store.createReview({ claimId: dmClaim, chatJid: PN.B, originKind: 'dm', originJid: PN.B, createdAt: at, status: 'tray' });
  const gClaim = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'group', ?, 'P10-3', 'meeting them at the park', 'commitment', 0.9, 'flagged', ?)`).run(GX, GX, at).lastInsertRowid);
  const gr = store.createReview({ claimId: gClaim, chatJid: GX, originKind: 'group', originJid: GX, createdAt: at, status: 'tray' }).id;
  store.updateReview(gr, { extraction: { type: 'plan', kind: 'walk', summary: `walk with ${NAMES.B}`, people: [NAMES.B] }, resolution: { placeId: 'place:park', castIds: [], subjectJid: B } });
  store.putPart({ nightKey: '2026-10-28', originKind: 'dm', originJid: PN.B, text: 'A plan with a friend came up.', sources: { events: [], claims: [dmClaim] } });
  store.putPart({ nightKey: '2026-10-28', originKind: 'group', originJid: GX, text: 'The club planned a walk.', sources: { events: [], claims: [gClaim] } });
  store.putNarration({ kind: 'thought', origins: [PN.B], text: 'Thinking about the plan.', sources: { events: [] }, createdAt: at });
  const { purgePerson } = await import('../../src/memory/relationshipStore.js');
  purgePerson(B, 'test', 'tester');
  const dump = ['story_claim_reviews', 'story_journal_parts', 'story_narrations', 'story_refusals', 'story_proposals']
    .map(t => JSON.stringify(getDb().prepare(`SELECT * FROM ${t}`).all())).join('\n');
  check('no story row keeps their JID (any form)', ![B, PN.B, PN.B.replace('@s.whatsapp.net', '')].some(j => dump.includes(j)));
  check('…or their name', !dump.includes(NAMES.B) && !dump.includes(NAMES.B.split(' ')[0]));
  eq('the group review that resolved them is gone, with its life_claims row', [store.getReview(gr), getDb().prepare('SELECT COUNT(*) AS n FROM life_claims WHERE id = ?').get(gClaim).n], [null, 0]);
  check('A’s adopted scene review is untouched', store.getReview(reviewId)?.status === 'adopted');
}

void D;
report();
