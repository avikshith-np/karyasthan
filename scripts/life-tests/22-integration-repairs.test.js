// T036 — regressions for the 009 integration review (go-live hardening):
//   1. a drained @-mention keeps its mention: defaultLoadMessage returns the
//      stored metadata (mentionedJids, rawMsgKey) so decide() scores it as one;
//      forgotten (no_learn) and expired rows are not answered (dropped 'revoked');
//   2. a drain that waited for the lock while a live turn answered the chat's
//      queue (markSeenNow → settleCatchUp) sends no second catch-up reply; the
//      drained turn gets the lock's turnSignal;
//   3. life switched off (skill off at boot / refused boot) with queued rows:
//      one engine-less forced drain answers them, writes no world events, and
//      presence ends available; no socket → nothing answered, still pending;
//   4. a live turn carrying a catch-up keeps a '>>>' on its own trigger;
//   5. a reconnect (new socket) gets presence again;
//   6. a fresh genesis at night starts him asleep, not free at home.
// Scratch DB, fake clock, fake sockets, no Jev, no network, no LLM.
import { setupScratchDb, fakeClock, fakeSock, section, check, eq, report } from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { appendEvent, lastEventId } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended } from '../../src/life/projector.js';
import { enqueue, getItem, pendingCount, listPendingByChat } from '../../src/life/queue.js';
import { createPhone, defaultLoadMessage } from '../../src/life/phone.js';

const { db } = await setupScratchDb();
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const { decide } = await import('../../src/brain/decisionEngine.js');
const { buildConversationContext } = await import('../../src/personality/systemPrompt.js');
const { setSelfIdentity } = await import('../../src/utils/selfIdentity.js');
const life = await import('../../src/life/index.js');

setRngSeed(22);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz);
const clock = fakeClock(local(28, 10));
setClock(clock.fn);

const BOT_PN = '155500000001:12@s.whatsapp.net';
const BOT_LID = '111122223333444:12@lid';
setSelfIdentity({ id: BOT_PN, lid: BOT_LID });
const GROUP = '120363000000000221@g.us';
const GROUP2 = '120363000000000222@g.us';
const DM = '15550000221@s.whatsapp.net';
const ALICE = '15550000222@s.whatsapp.net';
const BOB = '15550000223@s.whatsapp.net';
for (const g of [GROUP, GROUP2]) db.prepare('INSERT INTO groups (jid, name) VALUES (?, ?)').run(g, 'group');
for (const p of [DM, ALICE, BOB]) db.prepare('INSERT INTO people (jid, phone, push_name) VALUES (?, ?, ?)').run(p, p.split('@')[0], p === ALICE ? 'Alice' : 'Bob');

let seq = 0;
const WALL = Math.floor(Date.now() / 1000);
function store(chatJid, senderJid, content, { metadata = {}, noLearn = 0, expiresAt = null, ts } = {}) {
  const id = `R${String(++seq).padStart(4, '0')}`;
  db.prepare(`INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, message_type, timestamp, metadata_json, no_learn, expires_at)
              VALUES (?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)`)
    .run(id, chatJid, senderJid, 'someone', content, ts ?? WALL - 600 + seq, JSON.stringify(metadata), noLearn, expiresAt);
  return id;
}
const keyOf = (chatJid, id, senderJid) => ({ remoteJid: chatJid, id, fromMe: false, ...(chatJid.endsWith('@g.us') ? { participant: senderJid } : {}) });
function defer(chatJid, senderJid, content, o = {}) {
  const id = store(chatJid, senderJid, content, o);
  const isDm = !chatJid.endsWith('@g.us');
  return enqueue({ chatJid, msgId: id, senderJid, msgKey: keyOf(chatJid, id, senderJid), isDm, isMention: !!o.mention, availability: 'meeting' }).item;
}

// The facade's role for a bare phone: append + keep a projection in step.
let live = createInitialState(world);
const add = (spec) => { const ev = appendEvent(spec); live = applyAppended(live, ev, { world }); return ev; };

const sleep = async (ms) => { clock.advance({ seconds: Math.round(ms / 1000) }); };
const noTimers = { setTimer: () => ({}), clearTimer: () => {} };

try {
  // ── 6 ──────────────────────────────────────────────────────────────────
  section('6. a fresh genesis at night starts him asleep');
  clock.set(local(28, 2, 37));                       // 02:37 local, off the 15-min grid
  const nightSock = fakeSock();
  await life.startLife({ world, timers: false, isEnabled: () => true, seed: 22, getSock: () => nightSock,
    processMessage: async () => {}, withChatLock: async (c, fn) => fn({}), isGroupMuted: () => false, isMember: () => true, sleep });
  const st = life.getState();
  eq('right after genesis: asleep', [st?.activity?.kind, life.gateMessage({ id: 'n1', groupJid: DM }, { isDm: true }).state], ['sleep', 'asleep']);
  await life.stopLife();
  clock.set(local(28, 10));

  const g = add({ type: 'genesis', at: clock.now() - 3600, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) add({ type: 'place.created', at: clock.now() - 3600, actor: 'engine', causeId: g.id, payload: p });

  // ── 1 ──────────────────────────────────────────────────────────────────
  section('1. a drained mention keeps its metadata');
  const mention = defer(GROUP, ALICE, 'are you coming?', { mention: true, metadata: { mentionedJids: [BOT_LID], rawMsgKey: { id: 'x' } } });
  const loaded = defaultLoadMessage(mention);
  eq('loader returns mentionedJids', loaded?.metadata?.mentionedJids, [BOT_LID]);
  eq('… and rawMsgKey', loaded?.metadata?.rawMsgKey, { id: 'x' });
  const ctx0 = { isGroup: true, isDm: false, botJid: BOT_PN, botLid: BOT_LID, catchUp: { triggerIds: [loaded.id], itemIds: [mention.id] } };
  const d = decide(loaded, ctx0);
  check('decide() scores the drained turn as a mention (factor ≥ 5)', (d.factors?.mention ?? 0) >= 5, JSON.stringify(d.factors));
  check('… and responds', d.shouldRespond === true || d.respond === true || d.action === 'respond' || d.type === 'text' || !!d.responseType, JSON.stringify(d));
  const noMeta = store(GROUP2, BOB, 'plain');
  eq('a row without metadata → empty mentionedJids', defaultLoadMessage({ msgId: noMeta, chatJid: GROUP2 })?.metadata?.mentionedJids, []);

  const forgotten = defer(DM, DM, 'forget this one', { noLearn: 1 });
  const expired = defer(DM, DM, 'disappearing', { expiresAt: WALL - 60 });
  const okDm = defer(DM, DM, 'you up?');
  eq('forgotten (no_learn) → null', defaultLoadMessage(forgotten), null);
  eq('expired → null', defaultLoadMessage(expired), null);

  const turns = [];
  const lock = async (chatJid, fn) => fn({ turnSignal: { aborted: false, tag: chatJid } });
  const phone1 = createPhone({
    getSock: () => sock1, processMessage: async (s, msg, ctx) => { turns.push({ msg, ctx }); },
    withChatLock: lock, sleep, isGroupMuted: () => false, isMember: () => true,
    appendEvent: add, getState: () => live, world, ...noTimers,
  });
  const sock1 = fakeSock();
  const r1 = await phone1.runCheck({ reason: 'owner', by: 'owner', force: true });
  eq('two chats drained', r1.drained, 2);
  const gTurn = turns.find(t => t.ctx.chatJid === GROUP);
  eq('the group turn got the mention metadata', gTurn?.msg?.metadata?.mentionedJids, [BOT_LID]);
  check('… and the lock\'s turnSignal', gTurn?.ctx?.turnSignal?.tag === GROUP);
  const dTurn = turns.find(t => t.ctx.chatJid === DM);
  eq('the DM turn answers only the visible message', [dTurn?.msg?.id, dTurn?.ctx?.catchUp?.itemIds], [okDm.msgId, [okDm.id]]);
  eq('forgotten + expired dropped as revoked', [getItem(forgotten.id).status, getItem(forgotten.id).reason, getItem(expired.id).status],
    ['dropped', 'revoked', 'dropped']);
  eq('answered rows drained', [getItem(mention.id).status, getItem(okDm.id).status], ['drained', 'drained']);

  // ── 2 ──────────────────────────────────────────────────────────────────
  section('2. a live turn answered the queue while the drain waited');
  const q1 = defer(GROUP, ALICE, 'lunch?');
  const q2 = defer(GROUP, BOB, 'anyone?');
  const turns2 = [];
  let phone2 = null;
  const sock2 = fakeSock();
  let liveRan = 0;
  const racingLock = async (chatJid, fn) => {
    // A live message in this chat holds the lock first and answers the queue.
    if (!liveRan++) {
      const seen = await phone2.markSeenNow(sock2, chatJid, keyOf(chatJid, 'LIVE-1', BOB));
      check('the live turn carried the queued rows', seen.catchUp?.itemIds?.length === 2 && seen.catchUp.live === true);
      turns2.push({ live: true });
      phone2.settleCatchUp(seen.catchUp);
    }
    return fn({ turnSignal: null });
  };
  phone2 = createPhone({
    getSock: () => sock2, processMessage: async (s, msg, ctx) => { turns2.push({ msg, ctx }); },
    withChatLock: racingLock, sleep, isGroupMuted: () => false, isMember: () => true,
    appendEvent: add, getState: () => live, world, ...noTimers,
  });
  clock.advance({ minutes: 10 });
  const r2 = await phone2.runCheck({ reason: 'owner', by: 'owner', force: true });
  eq('no catch-up turn after the live one', [r2.drained, turns2.filter(t => !t.live).length], [0, 0]);
  eq('rows answered once (drained)', [getItem(q1.id).status, getItem(q2.id).status], ['drained', 'drained']);

  // Partial: one row answered live, one still pending → the drain answers only that one.
  const q3 = defer(GROUP, ALICE, 'first');
  const q4 = defer(GROUP, BOB, 'second');
  const turns3 = [];
  const partialLock = async (chatJid, fn) => {
    db.prepare("UPDATE life_queue SET status = 'drained' WHERE id = ?").run(q3.id);
    return fn({});
  };
  const phone3 = createPhone({
    getSock: () => sock2, processMessage: async (s, msg, ctx) => { turns3.push({ msg, ctx }); },
    withChatLock: partialLock, sleep, isGroupMuted: () => false, isMember: () => true,
    appendEvent: add, getState: () => live, world, ...noTimers,
  });
  clock.advance({ minutes: 10 });
  await phone3.runCheck({ reason: 'owner', by: 'owner', force: true });
  eq('only the still-pending row rides the catch-up', [turns3.length, turns3[0]?.ctx?.catchUp?.itemIds, turns3[0]?.msg?.id], [1, [q4.id], q4.msgId]);

  // ── 4 ──────────────────────────────────────────────────────────────────
  section('4. a live turn keeps its own >>> marker');
  const P = '120363000000000229@g.us';
  db.prepare('INSERT INTO groups (jid, name) VALUES (?, ?)').run(P, 'prompt group');
  const ids = ['older A', 'older B', 'older C'].map((t) => store(P, ALICE, t));
  const liveId = store(P, BOB, 'NEW live mention');
  const trig = { id: liveId, groupJid: P, senderJid: BOB, senderName: 'Bob', content: 'NEW live mention', messageType: 'text' };
  const markedLines = (text) => text.split('\n').filter(l => l.startsWith('>>> '));
  const liveCtx = buildConversationContext(P, trig, true, { life: { availability: 'free', catchUp: { awayMin: 30, newCount: 3, triggerIds: ids, itemIds: [1, 2, 3], live: true } } }).text;
  const lm = markedLines(liveCtx);
  check('live trigger is marked', lm.some(l => l.includes('NEW live mention')), lm.join(' | '));
  check('… at most 3 marks', lm.length <= 3, String(lm.length));
  const drainCtx = buildConversationContext(P, { ...trig, id: ids[2], content: 'older C' }, true, { life: { availability: 'free', catchUp: { awayMin: 30, newCount: 3, triggerIds: ids, itemIds: [1, 2, 3] } } }).text;
  const dm2 = markedLines(drainCtx);
  check('a drained turn still marks its 3 queued triggers', dm2.length === 3 && !dm2.some(l => l.includes('NEW live')), dm2.join(' | '));

  // ── 5 ──────────────────────────────────────────────────────────────────
  section('5. a reconnect gets presence again');
  const sA = fakeSock();
  const sB = fakeSock();
  let cur = sA;
  const phone5 = createPhone({ getSock: () => cur, appendEvent: add, getState: () => live, world, sleep, ...noTimers });
  await phone5.start();
  const first = sA.presence.map(p => p.type);
  check('start sent a presence on the first socket', first.length === 1, JSON.stringify(first));
  cur = sB;
  await phone5.resyncPresence();
  eq('the new socket gets the same presence', sB.presence.map(p => p.type), first);
  await phone5.resyncPresence();
  eq('… once', sB.presence.length, 1);
  phone5.stop();

  // ── 3 ──────────────────────────────────────────────────────────────────
  section('3. life off with queued rows: one engine-less drain');
  const eventsBefore = lastEventId();
  const offDm = defer(DM, DM, 'ping while life was on');
  const offGroup = defer(GROUP2, ALICE, '@you there?', { mention: true, metadata: { mentionedJids: [BOT_LID] } });
  const offTurns = [];
  const offSock = fakeSock();
  let offSockUp = false;
  const offOpts = {
    timers: false, isEnabled: () => false,
    getSock: () => (offSockUp ? offSock : null),
    processMessage: async (s, msg, ctx) => { offTurns.push({ msg, ctx }); },
    withChatLock: async (c, fn) => fn({}),
    isGroupMuted: () => false, isMember: () => true, sleep, world,
  };
  await life.startLife(offOpts);
  eq('no socket yet → nothing answered, rows pending', [offTurns.length, pendingCount()], [0, 2]);
  offSockUp = true;
  await life.startLife(offOpts);
  eq('one catch-up turn per chat', offTurns.map(t => t.ctx.chatJid).sort(), [DM, GROUP2].sort());
  check('… with a catch-up context', offTurns.every(t => !!t.ctx.catchUp));
  eq('rows drained, none pending', [getItem(offDm.id).status, getItem(offGroup.id).status, pendingCount()], ['drained', 'drained', 0]);
  eq('no world events written while life is off', lastEventId(), eventsBefore);
  eq('presence ends available', offSock.presence.at(-1)?.type, 'available');
  check('engine still off', life.isLifeOn() === false && life.getState() === null);

  // Refused boot (example world from ensureWorld) also drains.
  const refDm = defer(DM, DM, 'during a refused boot');
  offTurns.length = 0;
  await life.startLife({ ...offOpts, isEnabled: () => true, world: undefined, ensureWorld: async () => world });
  eq('refused boot → its queue is drained', [life.isLifeOn(), offTurns.length, getItem(refDm.id).status], [false, 1, 'drained']);
  eq('… still no world events', lastEventId(), eventsBefore);
  await life.stopLife();

  eq('no network calls', fetches, 0);
} catch (err) {
  check('harness', false, err?.stack || String(err));
}
report();
