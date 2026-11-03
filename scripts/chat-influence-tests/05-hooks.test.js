// 012 deletion hooks (plan §P1.5): forget / revoke / edit withdraw the item and
// revert its pointer (the blip cascades out, the overlay is gone) — also with
// life stopped; a deletion that races the Jev call leaves nothing; the tick's
// evidence sweep catches what no hook saw; a failing hook persists its request,
// degrades influence (overlay off) and is audited, the user's deletion stands,
// and only applying the request clears the degraded flag (also across a
// restart); device-suffixed / PN forms match; purge deletes rows, redacts events,
// folds cleanly, and a purge error rolls the purge back.
import {
  setupScratchDb, bootInfluence, say, idle, eventsOf, stopEngine, startEngine, liveChoice, fakeJev,
  section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const t = await bootInfluence();
const rs = await import('../../src/memory/relationshipStore.js');
const hooks = await import('../../src/life/influence/hooks.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
const { storeMessage } = await import('../../src/memory/messageStore.js');
const BOT = '10000000000@s.whatsapp.net';
const wallNow = () => Math.floor(Date.now() / 1000);
const row = (id) => t.db.prepare('SELECT * FROM chat_influence_items WHERE msg_id = ?').get(id);
const pointerOf = async (id) => (await eventsOf(['chat.perceived'])).find(e => e.payload.msgId === id);
const excluded = (id) => t.life.getState().excluded.has(id);
const settle = () => new Promise(r => setImmediate(r));
const overlayOn = () => 'vitalsBase' in t.life.getState();

section('forget');
await say(t, { chat: t.A, sender: t.A, text: 'honestly you are hopeless', id: 'F1', at: wallNow() });
const p1 = await pointerOf('F1');
check('a blip from the DM', !!p1 && row('F1')?.status === 'active' && overlayOn());
rs.forgetRecent(t.A, t.A);
await settle();
eq('forget → withdrawn → reverted', row('F1')?.status, 'reverted');
const moodF1 = (await eventsOf(['mood.chat'])).find(e => e.causeId === p1.id);
check('…the pointer and its mood.chat are out of the projection', excluded(p1.id) && excluded(moodF1.id));
check('…the overlay is gone', !overlayOn() && !(t.life.getState().chatMood || []).length);

section('revoke and edit');
await say(t, { chat: t.GROUP, sender: t.B, text: 'you clown, what was that', id: 'R1', mentioned: [BOT] });
await say(t, { chat: t.GROUP, sender: t.C, text: 'you clown, honestly though', id: 'E1', mentioned: [BOT] });
const pR = await pointerOf('R1');
const pE = await pointerOf('E1');
rs.onMessageRevoked('R1', t.GROUP);
rs.onMessageEdited('E1', 'never mind', t.GROUP);
await settle();
eq('revoke → reverted; edit → reverted', [row('R1')?.status, row('E1')?.status], ['reverted', 'reverted']);
check('…both pointers excluded', excluded(pR.id) && excluded(pE.id));
await say(t, { chat: t.OTHER, sender: t.C, text: 'you clown, other chat', id: 'R2', mentioned: [BOT] });
rs.onMessageRevoked('R2', t.GROUP);
await settle();
eq('a revoke in another chat matches nothing (ids are per chat)', row('R2')?.status, 'active');

section('life stopped');
await say(t, { chat: t.GROUP, sender: t.A, text: 'you clown, before the stop', id: 'S1', mentioned: [BOT] });
const pS = await pointerOf('S1');
await stopEngine(t);
rs.onMessageRevoked('S1', t.GROUP);
await settle();
await startEngine(t);
eq('withdrawn while stopped, reverted in the log', row('S1')?.status, 'reverted');
check('…and out of the rebuilt projection', excluded(pS.id));

section('a deletion racing the Jev call');
let release;
const gate = new Promise(r => { release = r; });
const slow = fakeJev(async (req) => {
  if (req?.caller !== 'life.chat.perceive') return {};
  await gate;
  return { kind: liveChoice('affect'), target: liveChoice('him'), affect: liveChoice('roast'), intensity: liveChoice('high'), advice: liveChoice('none') };
});
t.perceive.setJev(slow.fn);
for (const [id, cause] of [['X1', 'revoke'], ['X2', 'edit']]) {
  const msg = { id, groupJid: t.GROUP, senderJid: t.B, content: `you clown, racing ${cause}`, messageType: 'text', timestamp: t.clock.now(),
    metadata: { mentionedJids: [BOT] } };
  storeMessage(msg);
  t.life.perceiveChat(msg, resolveAudience({ chatJid: t.GROUP }), { botJid: '10000000000:1@s.whatsapp.net' });
  t.life.gateOutcome(t.GROUP, id, 'now');
  if (cause === 'revoke') rs.onMessageRevoked(id, t.GROUP); else rs.onMessageEdited(id, 'changed', t.GROUP);
}
release();
await idle(t);
eq('revoke / edit during the wait → no pointer, no row', [!!(await pointerOf('X1')), !!(await pointerOf('X2')), !!row('X1'), !!row('X2')],
  [false, false, false, false]);
t.perceive.setJev(t.jev.fn);

section('the evidence sweep');
await say(t, { chat: t.GROUP, sender: t.C, text: 'you clown, swept later', id: 'W1', mentioned: [BOT] });
const pW = await pointerOf('W1');
t.db.prepare(`UPDATE messages SET no_learn = 1 WHERE id = 'W1'`).run();   // no hook ran
t.clock.advance({ minutes: 15 });
await t.life.tick();
await settle();
eq('a fenced message with no hook → withdrawn by the tick, reverted', row('W1')?.status, 'reverted');
check('…pointer out', excluded(pW.id));

section('a failing hook');
await say(t, { chat: t.GROUP, sender: t.A, text: 'you clown, hook will fail', id: 'H1', mentioned: [BOT] });
const pH = await pointerOf('H1');
t.db.exec('ALTER TABLE chat_influence_items RENAME TO cii_moved');
const revoked = rs.onMessageRevoked('H1', t.GROUP);
await settle();
t.db.exec('ALTER TABLE cii_moved RENAME TO chat_influence_items');
check('the revoke itself stands', revoked.removed === 1 && !t.db.prepare(`SELECT 1 FROM messages WHERE id = 'H1'`).get());
const reqs = t.db.prepare('SELECT * FROM chat_influence_pending_withdrawals').all();
check('the request is persisted (ids only)', reqs.length === 1 && reqs[0].cause === 'revoke' && JSON.parse(reqs[0].msg_ids).includes('H1'));
eq('…degraded is persisted', t.db.prepare(`SELECT value FROM chat_influence_state WHERE key = 'degraded'`).get()?.value, '1');
await settle(); await new Promise(r => setTimeout(r, 20));
check('…and audited', !!t.db.prepare(`SELECT 1 FROM dashboard_audit WHERE action = 'chatInfluence.hook.fail'`).get());
check('while degraded: no influence, no overlay', !t.influence.influenceOn('mood') && !overlayOn());
hooks.__setDepsForTest(null);            // a new process: the in-memory marker is gone…
hooks.registerHooks();
check('…the restart still knows it is degraded (from the DB)', hooks.isDegraded());
await stopEngine(t);
await startEngine(t);                    // boot applies the persisted request
eq('after the restart the withdrawal applied', row('H1')?.status, 'reverted');
check('…the pointer is out and the request gone', excluded(pH.id) && t.db.prepare('SELECT COUNT(*) AS n FROM chat_influence_pending_withdrawals').get().n === 0);
check('…and only then degraded cleared', !hooks.isDegraded() && t.influence.influenceOn('mood'));

section('JID forms');
const PN = '15550007201@s.whatsapp.net';
await say(t, { chat: PN, sender: PN, text: 'honestly, you are hopeless', id: 'J1' });
eq('a DM arriving on the PN form is keyed by the canonical person', row('J1')?.chat_jid, t.A);
rs.onMessageRevoked('J1', '15550007201:7@s.whatsapp.net');
await settle();
eq('a revoke on a device-suffixed form still matches', row('J1')?.status, 'reverted');

section('purge');
await say(t, { chat: t.GROUP, sender: t.B, text: 'you clown, about to be purged', id: 'U1', mentioned: [BOT] });
const pU = await pointerOf('U1');
t.db.prepare(`INSERT INTO chat_influence_items (kind, chat_jid, origin_kind, msg_id, sender_jid, status, created_at)
  VALUES ('mood', ?, 'group', 'U2', ?, 'active', 1)`).run(t.GROUP, PN);
const ptrB = t.life.getState() && (await import('../../src/life/eventLog.js')).appendEvent({
  type: 'chat.perceived', at: t.clock.now(), actor: 'chat', originKind: 'group', originJid: t.GROUP, subjectJid: t.B, payload: { kind: 'live', msgId: 'U3' },
});
const { appendEvent } = await import('../../src/life/eventLog.js');
appendEvent({ type: 'sleep.delayed', at: t.clock.now(), actor: 'engine', causeId: ptrB.id, subjectJid: t.B, payload: { until: t.clock.now() + 1800, totalMin: 30, date: '2026-10-27' } });
appendEvent({ type: 'work.behind', at: t.clock.now(), actor: 'engine', originKind: 'self', originJid: 'self', subjectJid: t.B, payload: { sent: 30, date: '2026-10-27' } });
rs.purgePerson(t.B, 'test', 'test');
eq('purge of B deletes B\'s rows', t.db.prepare(`SELECT COUNT(*) AS n FROM chat_influence_items WHERE sender_jid = ?`).get(t.B).n, 0);
const red = (await eventsOf(['chat.perceived', 'mood.chat', 'sleep.delayed', 'work.behind'])).filter(e => e.id === pU.id || e.causeId === pU.id || e.causeId === ptrB.id || e.id === ptrB.id);
check('…B\'s pointers and consequences are redacted', red.length >= 3 && red.every(e => e.redacted));
const projector = await import('../../src/life/projector.js');
let rebuilt = null;
try { rebuilt = projector.rebuild({ world: t.world, useSnapshot: false }); } catch (err) { rebuilt = err; }
check('…and a full rebuild folds the redacted events cleanly', rebuilt && !(rebuilt instanceof Error)
  && !(rebuilt.chatMood || []).some(e => e.subjectJid === t.B) && !rebuilt.sleep?.delayedFor, rebuilt?.message);
rs.purgePerson(t.A, 'test', 'test');
eq('a PN-keyed row goes with the person (LID canonical)', t.db.prepare(`SELECT COUNT(*) AS n FROM chat_influence_items WHERE msg_id = 'U2'`).get().n, 0);
await say(t, { chat: t.GROUP, sender: t.C, text: 'you clown, will survive', id: 'U4', mentioned: [BOT] });
t.db.exec('ALTER TABLE chat_influence_items RENAME TO cii_moved');
let threw = false;
try { rs.purgePerson(t.C, 'test', 'test'); } catch { threw = true; }
t.db.exec('ALTER TABLE cii_moved RENAME TO chat_influence_items');
check('a purge error propagates…', threw);
check('…and rolls the purge back (C\'s lines are not fenced, the row is there)',
  t.db.prepare(`SELECT no_learn FROM messages WHERE id = 'U4'`).get()?.no_learn !== 1 && !!row('U4'));

report();
