// T010 — src/mind/hooks.js (research R9; threats T11, T12): the onItemsDeleted handler
// (forget → fenced, revoke/edit → rebuild_requested, purge → deleted; a deleted weekly
// un-supersedes its dailies; drafts of that chat dropped content_changed and shadow
// texts nulled; run free text nulled for runs that read that chat; a failure is caught
// for forget/revoke/edit — savepoint rolled back, evt:'issue', audited, degraded — and
// propagates for purge), the onPersonPurged handler (no try/catch), the
// onIdentityChange handler (merge / record / reassign; a failure is logged, audited and
// degrades), and registration. Scratch DB, fake clock, no network, no model.
import { TEST_ZONE, OFFSET_ZONE } from '../test-zone.js';
import {
  setupScratchDb, fakeClock, blockNetwork, seedPerson, seedGroup, setBot, section, check, eq, throws, report, DAY, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
const net = blockNetwork();
const { config } = await import('../../src/utils/config.js');
config.timezone = TEST_ZONE;
const store = await import('../../src/mind/store.js');
const clock = await import('../../src/mind/clock.js');
const hooks = await import('../../src/mind/hooks.js');
const rel = await import('../../src/memory/relationshipStore.js');

const fc = fakeClock(Date.UTC(2026, 9, 27, 9, 0) / 1000);   // 14:30 local
clock.setClock(fc.fn);
await setBot();

const A = await seedPerson({ jid: '82001@lid', name: 'Avery' });
const B = await seedPerson({ jid: '82002@lid', name: 'Blake' });
const G = await seedGroup({ jid: '120363000000082001@g.us', name: 'Hikers', members: [A, B] });
const G2 = await seedGroup({ jid: '120363000000082002@g.us', name: 'Chess', members: [B] });

// Recorders for the injected seams.
const unsup = [];
const logs = [];
const fakeLogger = { warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }), info() {}, debug() {}, error() {} };
hooks.__setDepsForTest({ unsupersede: (ids) => { unsup.push([...ids]); return ids.length; }, logger: fakeLogger });

const draft = (chatJid, status, extra = {}) => store.insertDraft({
  chatJid, chatKind: chatJid.endsWith('@g.us') ? 'group' : 'dm', kind: 'follow_up', basis: [{ digestId: 1, thread: 1 }],
  origins: [{ originJid: chatJid, minLearnedAt: fc.now() - DAY }], mode: status === 'queued' ? 'live' : 'shadow', status,
  intent: 'ask about the hike', voicedText: 'how was the hike?', reason: 'they mentioned it', ...extra,
});
const run = (labels, note) => {
  const id = store.insertRun({ kind: 'think', input: { labels } });
  store.finishRun(id, { status: 'ok', output: { note, nudges: [{ knob: 'replyLength', reason: `${note} reason` }] } });
  return id;
};
const inTx = (fn) => db.transaction(fn)();
const auditRows = (action) => db.prepare('SELECT * FROM dashboard_audit WHERE action = ? ORDER BY id').all(action);

// ── forget ─────────────────────────────────────────────────────────────────
section('onItemsDeleted: forget');
{
  store.logEpisodeNight(A, '2026-10-20', { outcome: 'written', memoryId: 101 });
  const q = draft(A, 'queued');
  const res = inTx(() => hooks.handleItemsDeleted(db, { chatJid: A, chatForms: [A], msgIds: ['m1'], cause: 'forget',
    byType: { memory: [101] }, episodes: [{ id: 101, originJid: A, attribute: 'day:2026-10-20' }] }));
  check('handler returned counts', res && res.episodeNights === 1);
  eq('a deleted episode night → fenced', store.episodeNight(A, '2026-10-20').outcome, 'fenced');
  eq('the current chat-night is fenced too', store.episodeNight(A, clock.nightKey(fc.now()))?.outcome, 'fenced');
  check('fenced nights are never rebuilt', !store.nightsToRebuild('2026-10-01', 50).some(r => r.chatJid === A));
  eq('no weekly deleted → unsupersede not called', unsup.length, 0);
  eq('the DM draft is dropped content_changed', [store.getDraft(q).status, store.getDraft(q).dropReason], ['dropped', 'content_changed']);
  eq('its text is nulled', [store.getDraft(q).intent, store.getDraft(q).voicedText], [null, null]);
  check('not degraded', !hooks.isDegraded());
}

section('onItemsDeleted: forget keeps a standing episode of tonight');
{
  const nk = clock.nightKey(fc.now());
  store.logEpisodeNight(B, nk, { outcome: 'written', memoryId: 150 });
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: B, chatForms: [B], msgIds: ['m2'], cause: 'forget', byType: {} }));
  eq('a written night whose episode survived is left alone', store.episodeNight(B, nk).outcome, 'written');
}

// ── revoke / edit ──────────────────────────────────────────────────────────
section('onItemsDeleted: revoke and edit');
{
  store.logEpisodeNight(G, '2026-10-21', { outcome: 'written', memoryId: 102 });
  store.logEpisodeNight(G, '2026-10-22', { outcome: 'written', memoryId: 103 });
  const gq = draft(G, 'queued');
  const gd = draft(G, 'drafting');
  const gs = draft(G, 'shadow');
  const gw = draft(G, 'would_send');
  const g2q = draft(G2, 'queued');
  const rG = run({ C1: { chatJid: G } }, 'group note');
  const rG2 = run({ C1: { chatJid: G2 } }, 'chess note');
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: G, chatForms: [G], msgIds: ['m3'], cause: 'revoke', byType: { memory: [102] } }));
  const n = store.episodeNight(G, '2026-10-21');
  eq('revoke → deleted + rebuild_requested', [n.outcome, n.cause, n.rebuildRequested], ['deleted', 'revoke', true]);
  check('the night is offered for rebuild', store.nightsToRebuild('2026-10-15', 4).some(r => r.chatJid === G && r.nightKey === '2026-10-21'));
  eq('queued + drafting rows of G dropped', [store.getDraft(gq).status, store.getDraft(gd).status], ['dropped', 'dropped']);
  eq('shadow / would_send keep their status', [store.getDraft(gs).status, store.getDraft(gw).status], ['shadow', 'would_send']);
  eq('…but lose their text', [store.getDraft(gs).intent, store.getDraft(gs).voicedText, store.getDraft(gw).voicedText], [null, null, null]);
  eq('another chat\'s queued draft is untouched', [store.getDraft(g2q).status, store.getDraft(g2q).intent], ['queued', 'ask about the hike']);
  eq('run free text of a run that read G is nulled', store.getRun(rG).output.note, null);
  eq('…including nested reasons', store.getRun(rG).output.nudges[0].reason, null);
  eq('a run that never read G keeps its note', store.getRun(rG2).output.note, 'chess note');

  inTx(() => hooks.handleItemsDeleted(db, { chatJid: G, chatForms: [G], msgIds: ['m4'], cause: 'edit', byType: { memory: [103] } }));
  const e = store.episodeNight(G, '2026-10-22');
  eq('edit → deleted + rebuild_requested', [e.outcome, e.cause, e.rebuildRequested], ['deleted', 'edit', true]);
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: A, chatForms: [A], msgIds: ['m5'], cause: 'revoke', byType: { memory: [101] } }));
  eq('a later revoke never un-fences a forgotten night', store.episodeNight(A, '2026-10-20').outcome, 'fenced');
}

// ── purge cause ────────────────────────────────────────────────────────────
section('onItemsDeleted: purge');
{
  store.logEpisodeNight(G, '2026-10-23', { outcome: 'written', memoryId: 104 });
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: A, chatForms: [A], msgIds: [], cause: 'purge', byType: { memory: [104] } }));
  const p = store.episodeNight(G, '2026-10-23');
  eq('purge → deleted, never rebuilt', [p.outcome, p.cause, p.rebuildRequested], ['deleted', 'purge', false]);
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: G, chatForms: [G], msgIds: ['m6'], cause: 'revoke', byType: { memory: [104] } }));
  eq('a purge-deleted night stays unrebuildable', store.episodeNight(G, '2026-10-23').rebuildRequested, false);
}

// ── owner cause (a dashboard memory delete, relationshipStore.deleteMemory) ──
section('onItemsDeleted: owner delete');
{
  store.logEpisodeNight(G, '2026-10-18', { outcome: 'written', memoryId: 106 });
  const old = draft(G, 'drafting', { createdAt: fc.now() - 3 * DAY });
  const fresh = draft(G, 'drafting');
  const res = inTx(() => hooks.handleItemsDeleted(db, { chatJid: G, chatForms: [G], msgIds: [], cause: 'owner',
    byType: { memory: [106] }, episodes: [{ id: 106, originJid: G, attribute: 'day:2026-10-18' }], msgTs: fc.now() - DAY }));
  const o = store.episodeNight(G, '2026-10-18');
  eq('owner-deleted episode night → tombstoned, never rebuilt', [o.outcome, o.rebuildRequested], ['tombstoned', false]);
  check('owner delete is not a forget: tonight is not fenced', store.episodeNight(G, clock.nightKey(fc.now())) === null && res.fencedNights === 0);
  check('drafts made since the memory existed are dropped, older ones kept',
    store.getDraft(fresh).status === 'dropped' && store.getDraft(old).status === 'drafting');
  store.updateDraft(old, { status: 'dropped', dropReason: 'content_changed' });
}

section('onItemsDeleted: the episodes payload and a deleted weekly');
{
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: G2, chatForms: [G2], msgIds: ['m9'], cause: 'revoke', byType: { memory: [120] },
    episodes: [{ id: 120, originJid: G2, attribute: 'day:2026-10-19' }] }));
  const n = store.episodeNight(G2, '2026-10-19');
  eq('a daily from the payload gets a log row even without a prior one', [n.outcome, n.memoryId, n.rebuildRequested],
    ['deleted', 120, true]);
  const asked = [];
  hooks.__setDepsForTest({ episodesFor: (chat, opts) => { asked.push({ chat, ...opts }); return [{ id: 301 }, { id: 302 }]; } });
  unsup.length = 0;
  const r = inTx(() => hooks.handleItemsDeleted(db, { chatJid: G2, chatForms: [G2], msgIds: ['m10'], cause: 'revoke',
    byType: { memory: [300] }, episodes: [{ id: 300, originJid: G2, attribute: 'week:2026-10-12' }] }));
  eq('the weekly\'s seven dailies are looked up (superseded included)', asked[0], { chat: G2, attributes: ['day:2026-10-12',
    'day:2026-10-13', 'day:2026-10-14', 'day:2026-10-15', 'day:2026-10-16', 'day:2026-10-17', 'day:2026-10-18'], current: false });
  eq('…and handed to unsupersede', [unsup.at(-1), r.unsuperseded], [[301, 302], 2]);
  eq('a weekly writes no chat-night row', store.episodeNight(G2, '2026-10-12'), null);
  hooks.__setDepsForTest({ episodesFor: () => [] });
}

// ── failures ───────────────────────────────────────────────────────────────
section('onItemsDeleted: a failure is caught for revoke (savepoint, issue, audit, degraded)');
{
  store.logEpisodeNight(G, '2026-10-24', { outcome: 'written', memoryId: 105 });
  hooks.__setDepsForTest({ cancelForChat: () => { throw Object.assign(new Error('boom: private words here'), { code: 'E_TEST' }); } });
  logs.length = 0;
  let outerRun = null;
  const res = inTx(() => {
    outerRun = store.insertRun({ kind: 'pulse' });       // stands in for the 006 transaction's own writes
    return hooks.handleItemsDeleted(db, { chatJid: G, chatForms: [G], msgIds: ['m7'], cause: 'revoke', byType: { memory: [105] } });
  });
  eq('the handler swallowed the error', res, null);
  check('the outer (006) transaction still committed', !!store.getRun(outerRun));
  eq('the handler\'s own writes were rolled back', store.episodeNight(G, '2026-10-24').outcome, 'written');
  check('degraded', hooks.isDegraded() && hooks.degradedInfo().cause === 'revoke');
  const a = auditRows('mind.hook.fail');
  check('audited mind.hook.fail as mind', a.length === 1 && a[0].actor === 'mind');
  check('the audit carries a code, never the message', /E_TEST/.test(a[0].payload_json) && !/boom|private/.test(a[0].payload_json));
  check('logged evt:issue', logs.some(l => l.obj?.evt === 'issue'));
  const keys = new Set(logs.flatMap(l => Object.keys(l.obj || {})));
  check('the log carries only evt/where/cause/code', [...keys].every(k => ['evt', 'where', 'cause', 'code'].includes(k)), [...keys]);
  check('no error text in the log', !JSON.stringify(logs).includes('private'));

  const atFirst = hooks.degradedInfo().at;
  fc.advance({ minutes: 5 });
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: G, chatForms: [G], msgIds: ['m8'], cause: 'edit', byType: {} }));
  eq('the first failure time is kept', hooks.degradedInfo().at, atFirst);
  // Audit fix: the marker survives a restart (stored, picked up by restoreDegraded at boot).
  hooks.__resetDegradedMemoryForTest();
  check('simulated restart: not degraded in memory', !hooks.isDegraded());
  hooks.restoreDegraded();
  check('restoreDegraded → degraded again with the original failure time',
    hooks.isDegraded() && hooks.degradedInfo().at === atFirst && hooks.degradedInfo().cause === 'revoke');

  let outer2 = null;
  let threw = false;
  try {
    inTx(() => {
      outer2 = store.insertRun({ kind: 'pulse' });
      hooks.handleItemsDeleted(db, { chatJid: A, chatForms: [A], msgIds: [], cause: 'purge', byType: { memory: [] } });
    });
  } catch (err) { threw = err?.code === 'E_TEST'; }
  check('for purge the error propagates', threw);
  check('…and rolls the whole purge transaction back', !store.getRun(outer2));
  eq('clearDegraded', [!!hooks.clearDegraded(), hooks.isDegraded()], [true, false]);
  hooks.__resetDegradedMemoryForTest();
  hooks.restoreDegraded();
  check('…and clearing removes the stored marker (a restart stays clear)', !hooks.isDegraded() && store.getDegraded() === null);
  hooks.__setDepsForTest(null);
  hooks.__setDepsForTest({ unsupersede: (ids) => { unsup.push([...ids]); return ids.length; }, logger: fakeLogger });
}

// ── onPersonPurged ─────────────────────────────────────────────────────────
section('onPersonPurged');
{
  const P = await seedPerson({ jid: '82009@lid', name: 'Casey', pn: '15550009009@s.whatsapp.net' });
  const forms = ['82009@lid', '15550009009@s.whatsapp.net'];
  const day = clock.dayKey(fc.now());
  store.bumpActivity(P, day, { msgs: 3, humanMsgs: 2 });
  const dg = store.insertDigest({ chatJid: P, originKind: 'dm', fromRowid: 0, toRowid: 5, periodStart: fc.now() - HOUR,
    periodEnd: fc.now(), summary: 'private chat summary', tone: 'warm', evidence: [{ msgId: 'pm1', ts: fc.now() - HOUR }] });
  store.logEpisodeNight(P, '2026-10-25', { outcome: 'written', memoryId: 201 });
  const dmSent = draft(P, 'sent', { personJid: P });
  store.upsertDetected({ jid: P, msgId: 'pm2', p: 0.9 });
  const gAud = draft(G, 'queued', { audience: { members: [A, B, P].sort(), fresh: true } });
  const gOther = draft(G2, 'drafting');
  const recent = run({ C1: { chatJid: G2 } }, 'recent note');
  fc.advance({ days: -8 });
  const old = run({ C1: { chatJid: G2 } }, 'old note');
  fc.advance({ days: 8 });

  const out = inTx(() => hooks.handlePersonPurged(db, P, forms));
  check('returns counts', out && out.drafts === 1);
  eq('a group draft whose audience names them is dropped', [store.getDraft(gAud).status, store.getDraft(gAud).intent], ['dropped', null]);
  eq('an unrelated pending draft is untouched', store.getDraft(gOther).status, 'drafting');
  eq('DM activity deleted', store.activityFor(day).filter(r => r.chatJid === P).length, 0);
  eq('DM digest deleted (+ evidence)', [store.getDigest(dg), store.digestEvidence(dg).length], [null, 0]);
  eq('DM episode log deleted', store.episodeNight(P, '2026-10-25'), null);
  eq('DM proactive rows deleted', store.getDraft(dmSent), null);
  eq('their exclusion is kept', store.exclusionsFor(forms).length, 1);
  eq('free text of the last 7 days nulled', store.getRun(recent).output.note, null);
  eq('older run text not touched by the recent sweep', store.getRun(old).output.note, 'old note');

  const badDb = { prepare() { throw Object.assign(new Error('disk'), { code: 'E_DISK' }); } };
  throws('no try/catch: an error propagates (the purge rolls back)', () => hooks.handlePersonPurged(badDb, P, forms), /disk/);
  check('…and does not degrade (the purge itself fails visibly)', !hooks.isDegraded());
}

// ── identity ───────────────────────────────────────────────────────────────
section('onIdentityChange: merge / record / reassign');
{
  const KEEP = '82101@lid';
  const DROP = '15550101010@s.whatsapp.net';
  const day = clock.dayKey(fc.now());
  store.bumpActivity(DROP, day, { msgs: 2 });
  const d = draft(DROP, 'shadow', { personJid: DROP, origins: [{ originJid: DROP, minLearnedAt: 5 }] });
  const r = hooks.handleIdentityChange({ type: 'merge', keepJid: KEEP, dropJid: DROP });
  check('merge applied', r && r.type === 'merge');
  eq('activity re-keyed', store.activityFor(day).filter(x => x.chatJid === KEEP).length, 1);
  eq('draft chat + person re-keyed', [store.getDraft(d).chatJid, store.getDraft(d).personJid], [KEEP, KEEP]);
  eq('origins_json re-keyed', store.getDraft(d).origins[0].originJid, KEEP);

  const RAW = '15550202020@s.whatsapp.net';
  const PERSON = '82102@lid';
  store.bumpActivity(RAW, day, { msgs: 1 });
  eq('record re-keys the raw form', hooks.handleIdentityChange({ type: 'record', jid: RAW, personJid: PERSON })?.type, 'record');
  eq('record moved the rows', store.activityFor(day).filter(x => x.chatJid === PERSON).length, 1);

  const NUM = '15550303030@s.whatsapp.net';
  const NEW = '82103@lid';
  const q = draft(NUM, 'queued', { personJid: NUM });
  store.upsertDetected({ jid: NUM, msgId: 'x1', p: null });
  hooks.handleIdentityChange({ type: 'reassign', jid: NUM, personJid: NEW, prevOwnerJid: '82104@lid' });
  eq('reassign drops the queued draft identity_changed', [store.getDraft(q).status, store.getDraft(q).dropReason], ['dropped', 'identity_changed']);
  check('reassign copies the exclusion to both people', store.exclusionsFor([NEW]).length === 1 && store.exclusionsFor(['82104@lid']).length === 1);
  eq('unknown change types are ignored', hooks.handleIdentityChange({ type: 'rename' }), null);

  hooks.__setDepsForTest({ rekey: () => { throw Object.assign(new Error('locked secret'), { code: 'SQLITE_BUSY' }); } });
  eq('a failing handler never throws (identity.js would swallow it anyway)', hooks.handleIdentityChange({ type: 'merge', keepJid: KEEP, dropJid: DROP }), null);
  const a = auditRows('mind.identity.fail');
  check('audited mind.identity.fail with a code only', a.length === 1 && /SQLITE_BUSY/.test(a[0].payload_json) && !/secret/.test(a[0].payload_json));
  check('degraded until recovery', hooks.isDegraded() && hooks.degradedInfo().source === 'identity');
  hooks.clearDegraded();
  hooks.__setDepsForTest(null);
}

// ── integration with the real 006 seams (relationshipStore) ────────────────
section('integration: real forget / revoke cascades through the registered hooks');
if (typeof rel.onItemsDeleted === 'function' && typeof rel.unsupersede === 'function') {
  const { seedMessage } = await import('./_helpers.js');
  const reads = await import('../../src/memory/mindReads.js');
  hooks.__setDepsForTest(null);
  hooks.__setDepsForTest({ logger: fakeLogger });
  hooks.registerHooks();
  const G3 = await seedGroup({ jid: '120363000000082003@g.us', name: 'Book club', members: [A, B] });
  const t = fc.now() - 3 * DAY;
  const e1 = await seedMessage({ chat: G3, sender: A, text: 'chapter one was slow', ts: t });
  const e2 = await seedMessage({ chat: G3, sender: B, text: 'chapter two was great', ts: t + DAY });
  const ew = await seedMessage({ chat: G3, sender: A, text: 'next pick is poetry', ts: t + 2 * DAY });
  const ep = (o) => rel.addMemory({ category: 'episode', subjectJid: null, source: 'mind.sleep', importance: 0.4, originKind: 'group',
    originJid: G3, ...o });
  const d1 = ep({ attribute: 'day:2026-10-21', content: 'They talked about chapter one.', evidence: [{ msgId: e1.id, ts: e1.ts }] }).id;
  const d2 = ep({ attribute: 'day:2026-10-22', content: 'They loved chapter two.', evidence: [{ msgId: e2.id, ts: e2.ts }] }).id;
  const w = ep({ attribute: 'week:2026-10-21', content: 'A week of chapters and a new pick.', replaces: [d1, d2], expiresInDays: 365,
    importance: 0.5, evidence: [{ msgId: ew.id, ts: ew.ts }] }).id;
  store.logEpisodeNight(G3, '2026-10-21', { outcome: 'written', memoryId: d1 });
  store.logEpisodeNight(G3, '2026-10-22', { outcome: 'written', memoryId: d2 });
  const cur = () => reads.episodesFor(G3, { current: true }).map(e => e.id);
  check('setup: only the weekly is current', cur().includes(w) && !cur().includes(d1));
  const dg = store.insertDigest({ chatJid: G3, originKind: 'group', fromRowid: 0, toRowid: e2.rowid, periodStart: e1.ts, periodEnd: e2.ts,
    summary: 'chapters', tone: 'warm', evidence: [{ msgId: e2.id, ts: e2.ts }] });
  const q = draft(G3, 'queued');

  rel.onMessageRevoked(ew.id, G3);
  check('revoking the weekly\'s line brings its dailies back into recall', cur().includes(d1) && cur().includes(d2) && !cur().includes(w));
  eq('the group\'s queued draft is dropped content_changed', store.getDraft(q).dropReason, 'content_changed');

  rel.onMessageRevoked(e2.id, G3);
  const n = store.episodeNight(G3, '2026-10-22');
  eq('revoking a daily\'s line → that night deleted + rebuild_requested', [n.outcome, n.cause, n.rebuildRequested], ['deleted', 'revoke', true]);
  eq('the digest it evidenced is gone (ITEM_TABLES.mind_digest)', store.getDigest(dg), null);

  // forgetRecent reads real time (relationshipStore's own clock).
  const realNow = Math.floor(Date.now() / 1000);
  const f1 = await seedMessage({ chat: A, sender: A, text: 'please forget what I said about my job', ts: realNow - 30 });
  const dmDay = ep({ attribute: 'day:2026-10-26', originKind: 'dm', originJid: A, content: 'Avery talked about a job change.',
    evidence: [{ msgId: f1.id, ts: f1.ts }] }).id;
  store.logEpisodeNight(A, '2026-10-26', { outcome: 'written', memoryId: dmDay });
  rel.forgetRecent(A, A);
  eq('forget → that DM-night is fenced', store.episodeNight(A, '2026-10-26').outcome, 'fenced');
  check('…and never offered for rebuild', !store.nightsToRebuild('2026-10-01', 50).some(r => r.chatJid === A));
  check('no hook failure along the way', !hooks.isDegraded());
  hooks.unregisterHooks();
  hooks.__setDepsForTest(null);
  hooks.__setDepsForTest({ unsupersede: (ids) => { unsup.push([...ids]); return ids.length; }, logger: fakeLogger });
} else {
  console.log('    (skipped: relationshipStore seams not present yet)');
}

// Review repair: an edit or revoke of one message used to null the text of every draft
// and run of the chat, years-old shadow drafts included. Only rows made at or after the
// message (less 5 min of clock skew) can contain it; a draft in another chat whose basis
// origins name this one is now reached too.
section('revoke / edit touch only rows made after the message (and drafts based on the chat)');
if (typeof rel.onMessageEdited === 'function') {
  const { seedMessage } = await import('./_helpers.js');
  hooks.__setDepsForTest(null);
  hooks.__setDepsForTest({ logger: fakeLogger });
  hooks.registerHooks();
  const G4 = await seedGroup({ jid: '120363000000082004@g.us', name: 'Runners', members: [A, B] });
  const G5 = await seedGroup({ jid: '120363000000082005@g.us', name: 'Pair', members: [A, B] });
  const setCreated = (id, at) => db.prepare('UPDATE mind_proactive SET created_at = ? WHERE id = ?').run(at, id);
  const setStarted = (id, at) => db.prepare('UPDATE mind_runs SET started_at = ? WHERE id = ?').run(at, id);
  const msgAt = fc.now() - HOUR;
  const m = await seedMessage({ chat: G4, sender: A, text: 'new route on sunday', ts: msgAt });

  const oldShadow = draft(G4, 'shadow'); setCreated(oldShadow, fc.now() - 2 * DAY);
  const oldQueued = draft(G4, 'queued'); setCreated(oldQueued, fc.now() - 2 * HOUR);
  const oldRun = run({ C1: { chatJid: G4 } }, 'old note'); setStarted(oldRun, fc.now() - 2 * DAY);
  const newShadow = draft(G4, 'shadow'); setCreated(newShadow, msgAt + 60);
  const newRun = run({ C1: { chatJid: G4 } }, 'new note'); setStarted(newRun, msgAt + 60);
  const basedOn = draft(G5, 'queued', { origins: [{ originJid: G4, minLearnedAt: msgAt }] }); setCreated(basedOn, msgAt + 120);

  const r = rel.onMessageEdited(m.id, 'new route on saturday', G4);
  eq('the edit itself deleted nothing learned', r.deleted, 0);
  eq('a 2-day-old shadow draft keeps its text', [store.getDraft(oldShadow).intent, store.getDraft(oldShadow).voicedText],
    ['ask about the hike', 'how was the hike?']);
  eq('a queued draft made before the message stays queued', store.getDraft(oldQueued).status, 'queued');
  eq('a run from before the message keeps its note', store.getRun(oldRun).output.note, 'old note');
  eq('a shadow draft made after the message loses its text', [store.getDraft(newShadow).intent, store.getDraft(newShadow).voicedText], [null, null]);
  eq('a run made after the message loses its note', store.getRun(newRun).output.note, null);
  eq('a pending draft in another chat based on this one is dropped', [store.getDraft(basedOn).status, store.getDraft(basedOn).intent],
    ['dropped', null]);

  const m2 = await seedMessage({ chat: G4, sender: B, text: 'count me in', ts: fc.now() - 30 * 60 });
  rel.onMessageRevoked(m2.id, G4);
  eq('revoke: the older queued draft still stands', store.getDraft(oldQueued).status, 'queued');
  eq('revoke: the old shadow draft still has its text', store.getDraft(oldShadow).voicedText, 'how was the hike?');

  // No message time (a caller without msgTs) → the old unbounded rule: fail closed.
  inTx(() => hooks.handleItemsDeleted(db, { chatJid: G4, chatForms: [G4], msgIds: ['mx'], cause: 'edit', byType: {} }));
  eq('unknown message time → every row of the chat', [store.getDraft(oldQueued).status, store.getDraft(oldShadow).voicedText],
    ['dropped', null]);
  check('no hook failure along the way', !hooks.isDegraded());
  hooks.unregisterHooks();
  hooks.__setDepsForTest(null);
  hooks.__setDepsForTest({ unsupersede: (ids) => { unsup.push([...ids]); return ids.length; }, logger: fakeLogger });
} else {
  console.log('    (skipped: relationshipStore seams not present yet)');
}

// ── registration ───────────────────────────────────────────────────────────
section('registerHooks');
{
  const got = {};
  const offs = [];
  hooks.__setDepsForTest({
    onItemsDeleted: (fn) => { got.items = fn; return () => offs.push('items'); },
    onPersonPurged: (fn) => { got.purged = fn; return () => offs.push('purged'); },
    onIdentityChange: (fn) => { got.identity = fn; return () => offs.push('identity'); },
    logger: fakeLogger,
  });
  const st = hooks.registerHooks();
  eq('all three seams registered', st, { itemsDeleted: true, personPurged: true, identity: true });
  check('the registered functions are the handlers', got.items === hooks.handleItemsDeleted && got.purged === hooks.handlePersonPurged
    && got.identity === hooks.handleIdentityChange);
  got.items = null;
  eq('idempotent', hooks.registerHooks(), st);
  check('…without registering twice', got.items === null);
  hooks.unregisterHooks();
  eq('unregister calls every off()', offs.sort(), ['identity', 'items', 'purged']);

  hooks.__setDepsForTest(null);
  hooks.__setDepsForTest({ logger: fakeLogger });
  logs.length = 0;
  const real = hooks.registerHooks();
  eq('real relationshipStore seams detected as they exist', [real.itemsDeleted, real.personPurged],
    [typeof rel.onItemsDeleted === 'function', typeof rel.onPersonPurged === 'function']);
  check('identity.onIdentityChange is always there', real.identity);
  if (!real.itemsDeleted) check('a missing seam is reported (issue)', logs.some(l => l.obj?.evt === 'issue'));
  hooks.unregisterHooks();
  hooks.__setDepsForTest(null);
}

eq('no network was touched', net.length, 0);
report();
