// T012 — phone queue (src/life/queue.js): enqueue validation + idempotency on
// (chat_jid, msg_id) (no resurrection after drain/expire), minimal stored keys,
// drain order, mark drained/dropped/expired only from pending (maxId leaves
// late arrivals pending), expiry cutoff on a fake clock, prune never touching
// pending rows, persistence across a reconnect, and the purge hook.
import { setupScratchDb, fakeClock, section, check, eq, throws, report } from './_helpers.js';
import { setClock } from '../../src/life/clock.js';
import {
  enqueue, markDrained, markDropped, markExpired, expireOlderThan, prune, deleteForPerson,
  getItem, isPending, pendingChats, listPendingByChat, pendingCount, rowToItem, AVAILABILITY_STATES,
} from '../../src/life/queue.js';
import { config } from '../../src/utils/config.js';

let { db } = await setupScratchDb();
const clock = fakeClock();
setClock(clock.fn);
const T0 = clock.now();

const G1 = '120363000000000011@g.us';
const G2 = '120363000000000012@g.us';
const ALICE = '15550000011@s.whatsapp.net';
const BOB = '15550000012@lid';
const key = (id, remoteJid, participant) => ({ remoteJid, id, fromMe: false, ...(participant ? { participant } : {}) });
const q = (chatJid, msgId, sender, extra = {}) => enqueue({
  chatJid, msgId, senderJid: sender,
  msgKey: key(msgId, chatJid, chatJid.endsWith('@g.us') ? sender : undefined),
  availability: 'meeting', ...extra,
});

try {
  section('enqueue');
  const a = q(G1, '3EB0AAA1', ALICE, { isMention: true, isQuestion: true });
  check('first enqueue inserts', a.inserted && a.id > 0);
  eq('item shape', [a.item.chatJid, a.item.msgId, a.item.senderJid, a.item.status, a.item.enqueuedAt],
    [G1, '3EB0AAA1', ALICE, 'pending', T0]);
  eq('gate features stored as booleans', [a.item.isDm, a.item.isMention, a.item.isQuestion], [false, true, true]);
  eq('state at enqueue stored', a.item.availability, 'meeting');
  eq('only the read-receipt key fields are kept', a.item.msgKey, { remoteJid: G1, id: '3EB0AAA1', fromMe: false, participant: ALICE });
  const stripped = enqueue({ chatJid: ALICE, msgId: 'DM1', senderJid: ALICE, isDm: true, availability: 'asleep',
    msgKey: { remoteJid: ALICE, id: 'DM1', fromMe: false, message: { conversation: 'secret text' }, pushName: 'x' } });
  check('message body/pushName never stored', !/secret|pushName/.test(db.prepare('SELECT msg_key_json AS k FROM life_queue WHERE id = ?').get(stripped.id).k));
  eq('availability set', [...AVAILABILITY_STATES], ['free', 'light', 'busy', 'meeting', 'dnd', 'asleep']);

  section('enqueue validation');
  throws('bad chat jid', () => q('not-a-jid', 'X1', ALICE), /chatJid/);
  throws('bad msg id', () => q(G1, "x'; DROP TABLE life_queue; --", ALICE), /msgId/);
  throws('unknown availability', () => q(G1, 'X2', ALICE, { availability: 'partying' }), /availability/);
  throws('missing key', () => enqueue({ chatJid: G1, msgId: 'X3', availability: 'busy' }), /msgKey/);
  throws('key id must match msgId', () => enqueue({ chatJid: G1, msgId: 'X4', msgKey: key('OTHER', G1), availability: 'busy' }), /msgKey\.id/);
  throws('key remoteJid must be a jid', () => enqueue({ chatJid: G1, msgId: 'X5', msgKey: key('X5', 'nope'), availability: 'busy' }), /remoteJid/);
  throws('key for another chat refused', () => enqueue({ chatJid: G1, msgId: 'X6', msgKey: key('X6', ALICE), availability: 'busy' }), /remoteJid must equal chatJid/);
  throws('bad sender jid', () => q(G1, 'X6', 'bob'), /senderJid/);
  throws('ms timestamp refused', () => q(G1, 'X7', ALICE, { enqueuedAt: 1.5 }), /unix seconds/);
  eq('nothing written by refused calls', pendingCount(), 2);

  section('idempotent on (chat, msg)');
  clock.advance({ minutes: 5 });
  const again = q(G1, '3EB0AAA1', ALICE, { availability: 'asleep', isMention: false });
  eq('re-enqueue returns the existing row', [again.inserted, again.id], [false, a.id]);
  eq('existing row unchanged (time, state, flags)', [again.item.enqueuedAt, again.item.availability, again.item.isMention], [T0, 'meeting', true]);
  const sameIdOtherChat = q(G2, '3EB0AAA1', BOB);
  check('same msg id in another chat is a separate item', sameIdOtherChat.inserted && sameIdOtherChat.id !== a.id);
  check('isPending', isPending(G1, '3EB0AAA1') && !isPending(G1, 'nope'));

  section('drain order + listing');
  clock.advance({ minutes: 5 });
  const b = q(G1, '3EB0AAA2', BOB);
  clock.advance({ minutes: 5 });
  const c = q(G1, '3EB0AAA3', ALICE);
  const chats = pendingChats();
  eq('chats oldest first', chats.map(x => x.chatJid), [G1, ALICE, G2]);
  eq('per-chat counts', chats.map(x => x.count), [3, 1, 1]);
  eq('mentions/dms tallies', [chats[0].mentions, chats[1].dms], [1, 1]);
  eq('maxId is the newest item', chats[0].maxId, c.id);
  eq('oldestAt', chats[0].oldestAt, T0);
  eq('chat items oldest first', listPendingByChat(G1).map(x => x.msgId), ['3EB0AAA1', '3EB0AAA2', '3EB0AAA3']);
  eq('all pending without a chat', listPendingByChat().length, 5);
  eq('limit', listPendingByChat(G1, { limit: 1 }).length, 1);
  eq('pendingCount per chat', pendingCount(G1), 3);

  section('mark drained / dropped / expired');
  const seenMax = chats[0].maxId;
  clock.advance({ minutes: 1 });
  const lateArrival = q(G1, '3EB0AAA4', BOB); // queued while the catch-up turn runs
  eq('drain up to the ids it saw', markDrained({ chatJid: G1, maxId: seenMax }), 3);
  eq('the late arrival stays pending', getItem(lateArrival.id).status, 'pending');
  const drained = getItem(a.id);
  eq('drained row has a drain time', [drained.status, drained.drainedAt], ['drained', clock.now()]);
  eq('re-marking a drained row changes nothing', markDrained([a.id, b.id]), 0);
  eq('drained row cannot be dropped', markDropped(a.id, 'muted'), 0);
  const resurrect = q(G1, '3EB0AAA1', ALICE);
  eq('re-delivery after drain does not resurrect', [resurrect.inserted, resurrect.item.status], [false, 'drained']);
  eq('drop with reason', markDropped(sameIdOtherChat.id, 'Left the group!'), 1);
  eq('reason normalised to a label', getItem(sameIdOtherChat.id).reason, 'left_the_group');
  throws('drop needs a reason', () => markDropped(lateArrival.id, ''), /reason/);
  throws('bad ids refused', () => markDrained(['1 OR 1=1']), /positive integers/);
  throws('bad chat selector refused', () => markDrained({ chatJid: "x' OR '1'='1" }), /chatJid/);
  eq('markExpired by id', markExpired([lateArrival.id]), 1);
  eq('expired default reason', getItem(lateArrival.id).reason, 'max_age');
  eq('empty id list is a no-op', markDrained([]), 0);

  section('expireOlderThan');
  eq('drain the DM by id', markDrained(stripped.id), 1);
  const fresh = q(G2, 'FRESH1', BOB);
  clock.advance({ hours: 17, minutes: 59 });
  eq('nothing expires before the max age', expireOlderThan(18).length, 0);
  // exactly 18 h old after the next 2-minute step: at the cutoff, so kept
  const old = q(G2, 'OLD-AT-EDGE', BOB, { enqueuedAt: clock.now() + 120 - 18 * 3600 });
  clock.advance({ minutes: 2 });
  const expired = expireOlderThan(18);
  eq('items past the max age expire', expired.map(x => x.msgId), ['FRESH1']);
  check('expired items carry their read keys', expired.every(x => x.msgKey && x.msgKey.id === x.msgId && x.status === 'expired'));
  eq('item at the cutoff boundary still pending', getItem(old.id).status, 'pending');
  eq('default max age comes from config', config.life.queueMaxAgeHours, 18);
  clock.advance({ minutes: 1 });
  eq('config default expires the boundary item', expireOlderThan().map(x => x.id), [old.id]);
  throws('max age must be positive', () => expireOlderThan(0), /positive/);
  eq('fresh item now expired', getItem(fresh.id).status, 'expired');

  section('restart keeps pending');
  const keep = q(G1, 'KEEP1', ALICE);
  const { closeDb, getDb } = await import('../../src/memory/db.js');
  closeDb();
  db = getDb(); // a fresh connection to the same file, like a reboot
  eq('pending item survives a reconnect', [getItem(keep.id)?.status, pendingCount()], ['pending', 1]);

  section('prune');
  clock.advance({ days: 6 });
  eq('resolved rows younger than 7 days kept', prune(), 0);
  clock.advance({ days: 2 });
  const pruned = prune();
  check('resolved rows older than 7 days deleted', pruned >= 5, pruned);
  eq('pending rows never pruned (even old ones)', [getItem(keep.id)?.status, pendingCount()], ['pending', 1]);
  eq('only the pending row is left', db.prepare('SELECT COUNT(*) AS n FROM life_queue').get().n, 1);
  throws('negative age refused', () => prune({ olderThanDays: -1 }), /non-negative/);

  section('deleteForPerson');
  q(ALICE, 'DM2', ALICE, { isDm: true });
  q(G2, 'BOB2', BOB);
  eq('deletes rows she sent and her DM chat', deleteForPerson(ALICE), 2);
  eq('other senders kept', listPendingByChat().map(x => x.senderJid), [BOB]);
  throws('needs a jid', () => deleteForPerson(''), /personJid/);
  eq('rowToItem(null) → null', rowToItem(null), null);
} finally {
  setClock(null);
}

report();
