// T011 — world log (src/life/eventLog.js): append validation (type/actor/origin/
// cause/payload), origin inheritance from a chat-origin cause, the append-only
// triggers (raw UPDATE/DELETE blocked, redaction allowed exactly once), cause
// chains, the revert cascade set, owner reverts (+ snapshot invalidation) and
// redactPerson (events, queue rows, claims, snapshots). Scratch DB, fake clock.
import { setupScratchDb, fakeClock, section, check, eq, throws, report } from './_helpers.js';
import { setClock } from '../../src/life/clock.js';
import {
  appendEvent, getEvent, listEvents, eventsAfter, lastEventId, causeChain, cascadeIds, revertEvent,
  listReverts, redactPerson, rowToEvent, isValidOrigin, encodePayload, EVENT_TYPES, PAYLOAD_MAX_BYTES,
} from '../../src/life/eventLog.js';
import { enqueue, pendingCount } from '../../src/life/queue.js';

const { db } = await setupScratchDb();
const clock = fakeClock();
setClock(clock.fn);
const T0 = clock.now();

const GROUP = '120363000000000001@g.us';
const OTHER_GROUP = '120363000000000002@g.us';
const ALICE = '15550000001@s.whatsapp.net';
const BOB = '15550000002@s.whatsapp.net';
const ALICE_SHORT = '5550000001@s.whatsapp.net'; // a suffix of ALICE — must never match her

try {
  section('append + read back');
  const genesis = appendEvent({ type: 'genesis', actor: 'engine', payload: { source: 'example', hash: 'abc' } });
  eq('genesis gets id 1', genesis.id, 1);
  eq('at defaults to the world clock', genesis.at, T0);
  eq('origin defaults to self', [genesis.originKind, genesis.originJid], ['self', 'self']);
  eq('payload round-trips', genesis.payload, { source: 'example', hash: 'abc' });
  check('recorded_at is set by the DB', Number.isInteger(genesis.recordedAt) && genesis.recordedAt > 0);
  eq('flags are booleans', [genesis.heavy, genesis.redacted], [false, false]);
  eq('getEvent returns the same event', getEvent(genesis.id), genesis);
  eq('getEvent(unknown) → null', getEvent(9999), null);
  eq('getEvent(garbage) → null', getEvent('1; DROP TABLE world_events'), null);
  check('catalogue has the 009 types', EVENT_TYPES.has('event.reverted') && EVENT_TYPES.has('chat.trigger') && EVENT_TYPES.size >= 37);   // 010 adds its own types (data-model §2)
  eq('rowToEvent(null) → null', rowToEvent(null), null);

  section('append validation');
  throws('unknown type refused', () => appendEvent({ type: 'married', actor: 'engine' }), /unknown event type/);
  throws('unknown actor refused', () => appendEvent({ type: 'meal', actor: 'god' }), /unknown actor/);
  throws('ms timestamp refused', () => appendEvent({ type: 'meal', actor: 'engine', at: Date.now() }), /unix seconds/);
  throws('fractional at refused', () => appendEvent({ type: 'meal', actor: 'engine', at: T0 + 0.5 }), /unix seconds/);
  throws('missing cause refused', () => appendEvent({ type: 'meal', actor: 'engine', causeId: 4242 }), /does not exist/);
  throws('non-integer cause refused', () => appendEvent({ type: 'meal', actor: 'engine', causeId: 'x' }), /positive integer/);
  throws('array payload refused', () => appendEvent({ type: 'meal', actor: 'engine', payload: [1, 2] }), /plain object/);
  throws('Date in payload refused', () => appendEvent({ type: 'meal', actor: 'engine', payload: { d: new Date() } }), /plain JSON/);
  throws('NaN in payload refused', () => appendEvent({ type: 'meal', actor: 'engine', payload: { n: NaN } }), /finite/);
  throws('__proto__ key refused', () => appendEvent({ type: 'meal', actor: 'engine', payload: JSON.parse('{"__proto__":{"x":1}}') }), /invalid key/);
  throws('runaway nesting refused', () => appendEvent({ type: 'meal', actor: 'engine', payload: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }), /deeper/);
  throws('oversized payload refused', () => appendEvent({ type: 'meal', actor: 'engine',
    payload: { notes: Array.from({ length: 12 }, () => 'x'.repeat(900)) } }), /exceeds 8192/);
  throws('heavy from chat refused', () => appendEvent({ type: 'chat.trigger', actor: 'chat', originKind: 'group', originJid: GROUP, heavy: true }), /cannot create heavy/);
  throws('heavy from jev refused', () => appendEvent({ type: 'decision.lean', actor: 'jev', heavy: true }), /cannot create heavy/);
  throws('chat actor cannot change his life', () => appendEvent({ type: 'sick.started', actor: 'chat', originKind: 'dm', originJid: ALICE }), /cannot append sick\.started/);
  throws('chat actor needs a chat origin', () => appendEvent({ type: 'chat.trigger', actor: 'chat' }), /chat origin/);
  throws('owner actor cannot claim self origin', () => appendEvent({ type: 'decision.mode_set', actor: 'owner', originKind: 'self' }), /origin owner/);
  throws('engine cannot use owner origin', () => appendEvent({ type: 'meal', actor: 'engine', originKind: 'owner' }), /only the owner/);
  throws('group origin needs a group jid', () => appendEvent({ type: 'chat.trigger', actor: 'chat', originKind: 'group', originJid: ALICE }), /invalid origin/);
  throws('dm origin needs a person jid', () => appendEvent({ type: 'chat.trigger', actor: 'chat', originKind: 'dm', originJid: GROUP }), /invalid origin/);
  throws('non-self origin needs a jid', () => appendEvent({ type: 'chat.trigger', actor: 'chat', originKind: 'group' }), /originJid is required/);
  throws('jid without kind refused', () => appendEvent({ type: 'meal', actor: 'engine', originJid: GROUP }), /originKind is required/);
  throws('self origin must be "self"', () => appendEvent({ type: 'meal', actor: 'engine', originKind: 'self', originJid: GROUP }), /invalid origin/);
  throws('subject must be a person', () => appendEvent({ type: 'meal', actor: 'engine', subjectJid: GROUP }), /person jid/);
  throws('heavy must be boolean', () => appendEvent({ type: 'meal', actor: 'engine', heavy: 1 }), /boolean/);
  eq('nothing partial was written', lastEventId(), 1);
  check('ig origin accepted', isValidOrigin('ig', 'ig:group'));
  check('call origin = caller DM', isValidOrigin('call', ALICE) && !isValidOrigin('call', GROUP));
  check('owner origin is "owner"', isValidOrigin('owner', 'owner') && !isValidOrigin('owner', 'self'));

  section('payload sanitizing');
  const dirty = appendEvent({ type: 'alert.raised', actor: 'engine',
    payload: { note: 'hi [IMAGE: a cat] @15550100123 there\u0007', nested: { list: ['[VOICE: boo]', 3, true, null] }, skip: undefined } });
  check('marker stripped', !/\[IMAGE/i.test(dirty.payload.note) && !/\[VOICE/i.test(dirty.payload.nested.list[0]));
  check('@mention tag stripped', !/@9198/.test(dirty.payload.note));
  check('control chars stripped', !/\u0007/.test(dirty.payload.note));
  eq('non-strings kept', dirty.payload.nested.list.slice(1), [3, true, null]);
  check('undefined members dropped', !('skip' in dirty.payload));
  check('jids in payloads are left intact', encodePayload({ who: ALICE }).includes(ALICE));
  check('payload cap is 8 KB', PAYLOAD_MAX_BYTES === 8192);

  section('provenance');
  clock.advance({ minutes: 15 });
  const late = appendEvent({ type: 'work.late', actor: 'engine', causeId: genesis.id, payload: { extraMin: 90 } });
  const trig = appendEvent({ type: 'chat.trigger', actor: 'chat', originKind: 'group', originJid: GROUP,
    subjectJid: ALICE, payload: { decisionId: 'd1', toward: 'go' } });
  const lean = appendEvent({ type: 'decision.lean', actor: 'jev', causeId: trig.id, payload: { lean: 'go', p: 0.7 } });
  eq('consequence of a chat trigger inherits its origin', [lean.originKind, lean.originJid], ['group', GROUP]);
  throws('chat taint cannot be laundered to self', () => appendEvent({ type: 'decision.committed', actor: 'engine',
    causeId: trig.id, originKind: 'self' }), /does not match/);
  throws('nor moved to another chat', () => appendEvent({ type: 'decision.committed', actor: 'engine',
    causeId: trig.id, originKind: 'group', originJid: OTHER_GROUP }), /does not match/);
  const selfChild = appendEvent({ type: 'sleep.started', actor: 'engine', causeId: late.id });
  eq('self cause → self origin', selfChild.originKind, 'self');
  const mode = appendEvent({ type: 'decision.mode_set', actor: 'owner', causeId: trig.id, payload: { mode: 'ask' } });
  eq('owner events are origin owner, even under a chat cause', [mode.originKind, mode.originJid], ['owner', 'owner']);

  section('append-only triggers');
  throws('raw UPDATE of payload blocked', () => db.prepare("UPDATE world_events SET payload_json = '{}' WHERE id = ?").run(late.id), /append-only/);
  throws('raw UPDATE of type blocked', () => db.prepare("UPDATE world_events SET type = 'meal' WHERE id = ?").run(late.id), /append-only/);
  throws('redaction shape cannot rewrite the actor', () => db.prepare(
    "UPDATE world_events SET redacted = 1, actor = 'owner' WHERE id = ?").run(late.id), /append-only/);
  throws('redaction shape cannot re-point the cause', () => db.prepare(
    'UPDATE world_events SET redacted = 1, cause_id = NULL WHERE id = ?').run(late.id), /append-only/);
  throws('raw DELETE blocked', () => db.prepare('DELETE FROM world_events WHERE id = ?').run(late.id), /append-only/);
  throws('bulk DELETE blocked', () => db.prepare('DELETE FROM world_events').run(), /append-only/);
  eq('event untouched', getEvent(late.id).payload, { extraMin: 90 });

  section('cause chain');
  const woke = appendEvent({ type: 'woke', actor: 'engine', causeId: selfChild.id, payload: { lateBy: 40 } });
  eq('chain walks to genesis, root first', causeChain(woke.id).map(e => e.type), ['genesis', 'work.late', 'sleep.started', 'woke']);
  eq('chain of a root is itself', causeChain(genesis.id).map(e => e.id), [genesis.id]);
  eq('chain of unknown id is empty', causeChain(9999), []);

  section('list / replay feed');
  clock.advance({ hours: 1 });
  const meal = appendEvent({ type: 'meal', actor: 'engine', at: T0 - 600, payload: { kind: 'breakfast' } }); // backdated
  eq('listEvents orders by world time', listEvents().map(e => e.id)[0], meal.id);
  eq('types filter', listEvents({ types: ['woke', 'meal'] }).map(e => e.type).sort(), ['meal', 'woke']);
  eq('empty types → nothing', listEvents({ types: [] }), []);
  throws('unknown type in filter refused', () => listEvents({ types: ['meal', "x' OR 1=1 --"] }), /unknown event type/);
  eq('from/to window', listEvents({ from: T0 + 60, to: T0 + 3600 }).every(e => e.at >= T0 + 60 && e.at <= T0 + 3600), true);
  eq('originJid filter', listEvents({ originJid: GROUP }).map(e => e.id), [trig.id, lean.id]);
  eq('subjectJid filter', listEvents({ subjectJid: ALICE }).map(e => e.id), [trig.id]);
  eq('desc + before pages back', listEvents({ order: 'desc', before: lean.id, limit: 2 }).length, 2);
  {
    // A cursor pages in id order even when `at` isn't monotone in id.
    const first = listEvents({ order: 'asc', limit: 1 })[0];
    const ids = listEvents({ after: first.id, limit: 500 }).map(e => e.id);
    eq('after-cursor pages in id order', ids, [...ids].sort((a, b) => a - b));
    const back = listEvents({ order: 'desc', before: lean.id, limit: 500 }).map(e => e.id);
    eq('before-cursor pages back in id order', back, [...back].sort((a, b) => b - a));
  }
  eq('limit clamps', listEvents({ limit: 1e9 }).length, lastEventId());
  eq('eventsAfter is append (id) order', eventsAfter(woke.id - 1).map(e => e.id), [woke.id, meal.id]);

  section('revert');
  // late → sleep.started (engine) → woke (engine); plus a mind and a chat child under `late`.
  const plan = appendEvent({ type: 'plan.made', actor: 'mind', causeId: late.id });
  const planKid = appendEvent({ type: 'activity.started', actor: 'engine', causeId: plan.id });
  const chatKid = appendEvent({ type: 'claim.flagged', actor: 'chat', causeId: late.id, originKind: 'dm', originJid: BOB });
  eq('cascade: target + engine/jev descendants only', cascadeIds(late.id), [late.id, selfChild.id, woke.id]);
  check('cascade does not walk through mind/chat events', !cascadeIds(late.id).includes(planKid.id) && !cascadeIds(late.id).includes(chatKid.id));
  db.prepare('INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, ?)').run(genesis.id, T0 - 3600, '{}');
  db.prepare('INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, ?)').run(woke.id, T0 + 7200, '{}');
  const r = revertEvent(late.id, { reason: 'too harsh [IMAGE: x] @15550100123', by: 'owner-ui' });
  const rev = getEvent(r.revertEventId);
  eq('revert is a new owner event', [rev.type, rev.actor, rev.originKind], ['event.reverted', 'owner', 'owner']);
  eq('revert payload names the target', rev.payload.targetId, late.id);
  check('revert reason sanitized', !/\[IMAGE/.test(rev.payload.reason) && !/@9198/.test(rev.payload.reason));
  eq('target itself is untouched', getEvent(late.id).payload, { extraMin: 90 });
  eq('later snapshot invalidated, earlier kept', db.prepare('SELECT upto_event_id AS u FROM world_snapshots').all().map(x => x.u), [genesis.id]);
  eq('reverting twice returns the same revert', revertEvent(late.id).revertEventId, r.revertEventId);
  eq('listReverts', listReverts().map(x => [x.revertId, x.targetId]), [[r.revertEventId, late.id]]);
  throws('genesis cannot be reverted', () => revertEvent(genesis.id), /genesis/);
  throws('a revert cannot be reverted', () => revertEvent(r.revertEventId), /revert cannot/);
  throws('unknown target refused', () => revertEvent(9999), /does not exist/);
  throws('bad target id refused', () => revertEvent('1 OR 1=1'), /positive integer/);

  section('redactPerson');
  const ownerNote = revertEvent(meal.id, { reason: `asked by ${ALICE}` });
  const aboutAlice = appendEvent({ type: 'call.answered', actor: 'engine', originKind: 'call', originJid: ALICE, payload: { secs: 40 } });
  const namesAlice = appendEvent({ type: 'alert.raised', actor: 'engine', payload: { note: `ping from ${ALICE}` } });
  const namesShort = appendEvent({ type: 'alert.raised', actor: 'engine', payload: { who: ALICE_SHORT } });
  const aboutBob = appendEvent({ type: 'chat.trigger', actor: 'chat', originKind: 'dm', originJid: BOB, subjectJid: BOB });
  const key = (id, remoteJid, participant) => ({ remoteJid, id, fromMe: false, ...(participant ? { participant } : {}) });
  enqueue({ chatJid: GROUP, msgId: 'A1', senderJid: ALICE, msgKey: key('A1', GROUP, ALICE), availability: 'meeting' });
  enqueue({ chatJid: ALICE, msgId: 'A2', senderJid: ALICE, msgKey: key('A2', ALICE), isDm: true, availability: 'asleep' });
  enqueue({ chatJid: GROUP, msgId: 'B1', senderJid: BOB, msgKey: key('B1', GROUP, BOB), availability: 'meeting' });
  db.prepare("INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, text, kind, p) VALUES (?, 'dm', ?, 'see you at 8', 'commitment', 0.8)").run(ALICE, ALICE);
  db.prepare("INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, text, kind, p) VALUES (?, 'group', ?, 'off to office', 'claim', 0.7)").run(GROUP, GROUP);
  db.prepare('INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, ?)').run(aboutAlice.id + 100, T0 + 9000, '{}');

  const before = { trig: getEvent(trig.id), lean: getEvent(lean.id) };
  const out = redactPerson(ALICE);
  eq('redaction counts', out, { events: 3, queue: 2, claims: 1, snapshots: 1 });
  const red = getEvent(trig.id);
  eq('subject event payload replaced', red.payload, { redacted: true });
  eq('subject cleared, flag set', [red.subjectJid, red.redacted], [null, true]);
  eq('id/at/type/actor/cause/origin kept', [red.id, red.at, red.type, red.actor, red.causeId, red.originJid],
    [before.trig.id, before.trig.at, before.trig.type, before.trig.actor, before.trig.causeId, before.trig.originJid]);
  check('call-origin event redacted', getEvent(aboutAlice.id).redacted);
  check('payload naming her redacted', getEvent(namesAlice.id).redacted);
  check('a jid that is a suffix of hers is not', !getEvent(namesShort.id).redacted);
  check('a revert naming her is not redacted (stays in force)', !getEvent(ownerNote.revertEventId).redacted
    && listReverts().some(x => x.targetId === meal.id));
  check('other people untouched', !getEvent(aboutBob.id).redacted && getEvent(aboutBob.id).subjectJid === BOB);
  eq('lean caused by the trigger keeps its chain', causeChain(lean.id).map(e => e.id), [trig.id, lean.id]);
  check('lean (no reference to her) not redacted', !getEvent(lean.id).redacted);
  eq('her queue rows deleted, others kept', pendingCount(), 1);
  eq('her DM claims deleted, group claim kept', db.prepare('SELECT COUNT(*) AS n FROM life_claims').get().n, 1);
  throws('a redacted row can never be updated again', () => db.prepare(
    "UPDATE world_events SET payload_json = '{\"x\":1}' WHERE id = ?").run(trig.id), /append-only/);
  throws('redacted rows still cannot be deleted', () => db.prepare('DELETE FROM world_events WHERE id = ?').run(trig.id), /append-only/);
  eq('redacting again is a no-op', redactPerson([ALICE]).events, 0);
  throws('redactPerson refuses a group', () => redactPerson(GROUP), /person jid/);
  throws('redactPerson refuses self', () => redactPerson('self'), /person jid/);
  throws('redactPerson refuses empty', () => redactPerson([]), /person jid/);
} finally {
  setClock(null);
}

report();
