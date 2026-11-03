// T020 — phone (src/life/phone.js): checks and the drain of the deferred queue.
// Fake lock + fake processor over a scratch DB with the real queue/eventLog/
// projector: one catch-up turn per chat through the lock (never two at once),
// catch-up context (away time, count, ≤ 3 triggers, mentions first), read
// receipts only at checks (or markSeenNow), the presence sequence, muted /
// left / revoked drops, a message queued during the turn stays pending, expiry
// (read, not answered), read-only checks while asleep, a restart keeps pending
// items, scheduling from the cadence and the projection, owner checks, no
// socket. Fake timers: nothing live is ever armed. No network, no LLM.
import { setupScratchDb, fakeClock, fakeSock, section, check, eq, report } from './_helpers.js';
import { setClock, atLocal } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { appendEvent, listEvents } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended } from '../../src/life/projector.js';
import { enqueue, getItem, pendingCount, listPendingByChat } from '../../src/life/queue.js';
import { createPhone, cleanKey, buildCatchUp, SPACING_MS, UNREAD_PER_CHAT } from '../../src/life/phone.js';
import { CHECK_GAP_MIN } from '../../src/life/availability.js';

const { db } = await setupScratchDb();
setRngSeed(15);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const TZ = createInitialState(world).world.timezone;
const T0 = atLocal(Date.UTC(2026, 9, 28, 6, 0) / 1000, '10:00', TZ); // Wed 10:00 local
const clock = fakeClock(T0);
setClock(clock.fn);
const MIN = 60;
const H = 3600;

const GROUP = '120363000000000001@g.us';
const MUTED = '120363000000000002@g.us';
const OTHER = '120363000000000003@g.us';
const ALICE = '15550000001@s.whatsapp.net';
const BOB = '15550000002@s.whatsapp.net';
const CAROL = '15550000003@s.whatsapp.net';
const GONE = '15550000009@s.whatsapp.net';

// Baseline rows: groups, people, members (GONE left the group), stored messages.
for (const g of [GROUP, MUTED, OTHER]) db.prepare('INSERT INTO groups (jid, name) VALUES (?, ?)').run(g, 'group');
for (const p of [ALICE, BOB, CAROL, GONE]) db.prepare('INSERT INTO people (jid, phone) VALUES (?, ?)').run(p, p.split('@')[0]);
for (const p of [ALICE, BOB]) db.prepare('INSERT INTO group_members (group_jid, person_jid) VALUES (?, ?)').run(GROUP, p);
let msgSeq = 0;
function storeMsg(chatJid, senderJid, content, { store = true } = {}) {
  const id = `M${String(++msgSeq).padStart(4, '0')}`;
  if (store) {
    db.prepare('INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, chatJid, senderJid, 'someone', content, clock.now());
  }
  return id;
}
const keyOf = (chatJid, id, senderJid) => ({ remoteJid: chatJid, id, fromMe: false, ...(chatJid.endsWith('@g.us') ? { participant: senderJid } : {}) });
function defer(chatJid, senderJid, content, { mention = false, availability = 'meeting', store = true, enqueuedAt } = {}) {
  const id = storeMsg(chatJid, senderJid, content, { store });
  const isDm = !chatJid.endsWith('@g.us');
  return enqueue({ chatJid, msgId: id, senderJid, msgKey: keyOf(chatJid, id, senderJid), isDm, isMention: mention, availability, enqueuedAt }).item;
}

// The facade's role: append + keep the projection in step, forward to the phone.
let live = createInitialState(world);
let phone = null;
const add = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  return ev;
};
const addAndTell = async (spec) => {
  const ev = add(spec);
  if (phone) await phone.onEvent(ev);
  return ev;
};

// Fakes: timers that never fire, a sleep that advances the clock, a lock that records concurrency.
function fakeTimers() {
  const t = { armed: [], cleared: 0, seq: 0 };
  t.setTimer = (fn, ms) => { const h = { id: ++t.seq, fn, ms }; t.armed.push(h); return h; };
  t.clearTimer = (h) => { t.cleared++; t.armed = t.armed.filter(x => x !== h); };
  t.live = () => t.armed.length;
  t.fire = async (h = t.armed[0]) => { t.armed = t.armed.filter(x => x !== h); await h.fn(); };
  return t;
}
const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); clock.advance({ seconds: Math.round(ms / 1000) }); };
const lock = { calls: [], active: 0, maxActive: 0 };
const withChatLock = async (chatJid, fn) => {
  lock.calls.push(chatJid);
  lock.active++;
  lock.maxActive = Math.max(lock.maxActive, lock.active);
  try { return await fn(); } finally { lock.active--; }
};
const turns = [];
let duringTurn = null;
const processMessage = async (sock, msg, ctx) => {
  turns.push({ chatJid: ctx.chatJid, msgId: msg.id, content: msg.content, ctx: structuredClone(ctx), readsBefore: sock.reads.length, inLock: lock.active });
  clock.advance({ seconds: 20 });
  if (duringTurn) { const f = duringTurn; duringTurn = null; await f(msg, ctx); }
};
const muted = new Set([MUTED]);
const sock = fakeSock();
let sockAvailable = true;
let timers = fakeTimers();
const makePhone = (over = {}) => createPhone({
  getSock: () => (sockAvailable ? sock : null),
  processMessage, withChatLock, sleep,
  isGroupMuted: (jid) => muted.has(jid),
  appendEvent: add,
  getState: () => live,
  world,
  setTimer: (...a) => timers.setTimer(...a),
  clearTimer: (h) => timers.clearTimer(h),
  ...over,
});
const readIds = () => sock.reads.flat().map(k => k.id);
const presenceSeq = () => sock.presence.map(p => p.type);
const eventsOf = (type) => listEvents({ types: [type], limit: 500 });

try {
  const genesis = add({ type: 'genesis', at: T0 - 2 * H, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) add({ type: 'place.created', at: T0 - 2 * H, actor: 'engine', causeId: genesis.id, payload: p });

  section('keys');
  eq('cleanKey keeps only what readMessages needs', cleanKey({ remoteJid: GROUP, id: 'ABC', participant: ALICE, extra: 'x', fromMe: false }, GROUP),
    { remoteJid: GROUP, id: 'ABC', fromMe: false, participant: ALICE });
  check('rejects another chat\'s key, his own messages and junk', !cleanKey({ remoteJid: OTHER, id: 'A' }, GROUP) && !cleanKey({ remoteJid: GROUP, id: 'A', fromMe: true }, GROUP) && !cleanKey('x', GROUP) && !cleanKey({ remoteJid: GROUP, id: 'a b' }, GROUP));

  section('start in a meeting: presence + schedule');
  await addAndTell({ type: 'activity.started', at: T0, actor: 'engine', payload: { kind: 'meeting', placeId: 'place:office', end: T0 + H, availability: 'meeting' } });
  phone = makePhone();
  const first = await phone.start();
  eq('presence unavailable while in a meeting', presenceSeq(), ['unavailable']);
  check('first check at the meeting end + 0–5 min', first.at >= T0 + H && first.at <= T0 + H + 5 * MIN && first.reason === 'meeting_end', first);
  eq('one timer armed, for that time', [timers.live(), timers.armed[0].ms], [1, (first.at - clock.now()) * 1000]);

  section('messages during the meeting: nothing read, nothing sent');
  clock.advance({ minutes: 10 });
  const dm1 = defer(ALICE, ALICE, 'are you coming tonight?');
  const dm2 = defer(ALICE, ALICE, 'hello??');
  const g1 = defer(GROUP, BOB, 'lunch plans?');
  const g2 = defer(GROUP, ALICE, '@him what do you think', { mention: true });
  const g3 = defer(GROUP, BOB, 'anyone?');
  const goneItem = defer(GROUP, GONE, 'bye all');
  const revoked = defer(GROUP, BOB, 'deleted message', { store: false });
  const m1 = defer(MUTED, CAROL, 'noise in a muted group');
  const ignoredId = storeMsg(OTHER, CAROL, 'random chatter');
  check('noteUnread for ignored chatter', phone.noteUnread(OTHER, keyOf(OTHER, ignoredId, CAROL)));
  check('noteUnread refuses a key from another chat', !phone.noteUnread(OTHER, keyOf(GROUP, 'X1', BOB)));
  eq('queue holds the deferred items', pendingCount(), 8);
  eq('no receipts, no sends, no new presence', [sock.reads.length, sock.sent.length, presenceSeq().length], [0, 0, 1]);

  section('meeting ends → phone check drains, one turn per chat');
  clock.set(first.at);
  await addAndTell({ type: 'activity.ended', at: T0 + H, actor: 'engine', payload: { kind: 'meeting' } });
  sleeps.length = 0;
  const res = await phone.runCheck({ reason: 'meeting_end' });
  eq('two catch-up turns (DM + group; muted dropped)', [res.drained, turns.length], [2, 2]);
  eq('one turn per chat, through the lock, oldest chat first', [turns.map(t => t.chatJid), lock.calls], [[ALICE, GROUP], [ALICE, GROUP]]);
  check('never two turns at once', lock.maxActive === 1 && turns.every(t => t.inLock === 1));
  eq('the turn answers the last remaining message of the chat', [turns[0].msgId, turns[1].msgId], [dm2.msgId, g3.msgId]);
  eq('rebuilt from the messages table', turns[1].content, 'anyone?');
  const cu = turns[1].ctx.catchUp;
  check('group catch-up: away time, count, mention first', cu.awayMin >= 50 && cu.newCount === 3 && cu.triggerIds[0] === g2.msgId && cu.triggerIds.length === 3 && cu.reason === 'meeting', cu);
  eq('ctx is minimal: group, no rawMsg', [turns[1].ctx.isGroup, turns[1].ctx.isDm, turns[1].ctx.rawMsg], [true, false, null]);
  eq('DM ctx', [turns[0].ctx.isDm, turns[0].ctx.catchUp.newCount, turns[0].ctx.catchUp.triggerIds[0]], [true, 2, dm2.msgId]);
  check('read before the reply (blue ticks, then typing)', turns[0].readsBefore >= 1 && readIds().includes(dm1.msgId) && readIds().includes(dm2.msgId));
  check('every queued and unread key read at the check', [dm1, dm2, g1, g2, g3, goneItem, revoked, m1].every(i => readIds().includes(i.msgId)) && readIds().includes(ignoredId));
  eq('statuses: drained / dropped with reasons', [dm1, dm2, g1, g2, g3, goneItem, revoked, m1].map(i => [getItem(i.id).status, getItem(i.id).reason]),
    [['drained', null], ['drained', null], ['drained', null], ['drained', null], ['drained', null], ['dropped', 'left'], ['dropped', 'revoked'], ['dropped', 'muted']]);
  check('spacing between turns: 3–15 s', sleeps.length >= 1 && sleeps[0] >= SPACING_MS[0] && sleeps[0] <= SPACING_MS[1], sleeps);
  eq('presence: available at the check, stays while free', presenceSeq(), ['unavailable', 'available']);
  const started = eventsOf('phone.check.started');
  const ended = eventsOf('phone.check.ended');
  check('phone.check.started/ended appended', started.length === 1 && ended.length === 1 && ended[0].causeId === started[0].id);
  check('he stayed on the phone for the check (1–4 min)', ended[0].at - started[0].at >= 60);
  eq('projection follows: off the phone, next check stored', [live.availability.onPhone, live.phone.nextCheckAt], [false, ended[0].payload.nextCheckAt]);
  const gapMin = (ended[0].payload.nextCheckAt - ended[0].at) / MIN;
  check('next check from the free cadence', gapMin >= CHECK_GAP_MIN.free[0] && gapMin <= CHECK_GAP_MIN.free[1], gapMin);
  check('rescheduled: one timer for the next check', timers.live() === 1 && phone.getNext().at === ended[0].payload.nextCheckAt);
  eq('unread map emptied', phone.unreadCount(), 0);
  eq('nothing was sent by the phone itself', sock.sent.length, 0);

  section('a message queued during the turn stays pending');
  clock.advance({ minutes: 5 });
  const q1 = defer(BOB, BOB, 'ping', { availability: 'busy' });
  let late = null;
  duringTurn = () => { late = defer(BOB, BOB, 'sent while he was typing', { availability: 'busy' }); };
  await phone.runCheck();
  eq('first item drained, the late one pending', [getItem(q1.id).status, getItem(late.id).status], ['drained', 'pending']);
  turns.length = 0;
  await phone.runCheck();
  eq('… answered at the next check', [getItem(late.id).status, turns.length, turns[0]?.msgId], ['drained', 1, late.msgId]);

  section('busy check ends unavailable');
  await addAndTell({ type: 'activity.started', at: clock.now(), actor: 'engine', payload: { kind: 'gym', placeId: 'place:gym', end: clock.now() + H, availability: 'busy' } });
  check('going busy drops presence', presenceSeq().at(-1) === 'unavailable');
  const busyNext = phone.getNext();
  const bg = (busyNext.at - clock.now()) / MIN;
  check('busy cadence 20–45 min', bg >= 19 && bg <= 45, bg);
  sock.reset();
  await phone.runCheck();
  eq('busy: available during, unavailable after', presenceSeq(), ['available', 'unavailable']);

  section('markSeenNow (now/sneak)');
  sock.reset();
  const s1 = defer(CAROL, CAROL, 'queued earlier', { availability: 'light' });
  const liveId = storeMsg(CAROL, CAROL, 'answer now');
  phone.noteUnread(CAROL, keyOf(CAROL, 'UNREAD1', CAROL));
  const seen = await phone.markSeenNow(sock, CAROL, keyOf(CAROL, liveId, CAROL));
  eq('reads this message, the chat\'s unread and queued keys at once', [seen.read, sock.reads.length, sock.reads[0].map(k => k.id).sort()], [3, 1, [liveId, s1.msgId, 'UNREAD1'].sort()]);
  eq('the queued item is handed to the live turn as its catch-up', [seen.catchUp?.itemIds, seen.catchUp?.triggerIds, seen.catchUp?.chatJid], [[s1.id], [s1.msgId], CAROL]);
  eq('… but not marked answered before a reply is sent', getItem(s1.id).status, 'pending');
  eq('settleCatchUp after the reply marks it drained', [phone.settleCatchUp(seen.catchUp), getItem(s1.id).status], [1, 'drained']);
  const none = await phone.markSeenNow(sock, CAROL, keyOf(CAROL, 'M-LIVE2', CAROL));
  eq('nothing queued → no catch-up', none.catchUp, null);
  eq('no presence change', sock.presence.length, 0);

  section('asleep: read only');
  sock.reset();
  turns.length = 0;
  const sleepAt = clock.now();
  await addAndTell({ type: 'sleep.started', at: sleepAt, actor: 'engine', payload: { until: sleepAt + 8 * H } });
  eq('sleep.started → unavailable (already) — no duplicate send', presenceSeq(), []);
  const wakePlan = phone.getNext();
  check('next check is a night check or the wake', ['night', 'wake'].includes(wakePlan.reason), wakePlan);
  const night1 = defer(ALICE, ALICE, 'you up?', { availability: 'asleep' });
  const r2 = await phone.runCheck({ reason: 'night', readOnly: true });
  eq('no turn while asleep; item still pending; but read', [turns.length, getItem(night1.id).status, readIds().includes(night1.msgId)], [0, 'pending', true]);
  check('the check is logged read only', eventsOf('phone.check.started').at(-1).payload.readOnly === true && r2.drained === 0);
  const r3 = await phone.runCheck();
  check('even unforced: asleep ⇒ read only', r3.drained === 0 && getItem(night1.id).status === 'pending');
  check('…and the result says so (the dashboard tells the owner)', r2.readOnly === true && r3.readOnly === true);

  section('restart keeps pending; expiry');
  phone.stop();
  check('stop clears the timer', timers.live() === 0);
  const old = defer(ALICE, ALICE, 'very old message', { availability: 'asleep', enqueuedAt: clock.now() - 19 * H });
  clock.advance({ hours: 8 });
  await addAndTell({ type: 'woke', at: clock.now(), actor: 'engine', payload: {} });
  // a fresh process: new phone, same DB
  timers = fakeTimers();
  turns.length = 0;
  sock.reset();
  phone = makePhone();
  await phone.start();
  eq('pending survived the restart', listPendingByChat(ALICE).map(i => i.msgId).sort(), [night1.msgId, old.msgId].sort());
  const wokeEv = add({ type: 'woke', at: clock.now(), actor: 'engine', payload: {} });
  const afterWake = await phone.onEvent(wokeEv);
  check('woke → a check 0–5 min later, caused by the woke', afterWake.reason === 'wake' && afterWake.at - clock.now() <= 6 * MIN && afterWake.causeId === wokeEv.id, afterWake);
  clock.set(afterWake.at);
  await timers.fire();              // the armed timer goes off
  await new Promise(r => setImmediate(r));
  eq('morning check: old item expired (read, not answered)', [getItem(old.id).status, getItem(old.id).reason, readIds().includes(old.msgId)], ['expired', 'max_age', true]);
  eq('the overnight DM gets one catch-up reply', [turns.length, turns[0]?.msgId, getItem(night1.id).status], [1, night1.msgId, 'drained']);
  check('the wake check is caused by the woke', eventsOf('phone.check.started').at(-1).causeId === wokeEv.id);

  section('guards');
  const busyRun = phone.runCheck();
  eq('a second check while one runs is refused', await phone.runCheck(), { skipped: 'in_check' });
  await busyRun;
  sockAvailable = false;
  eq('no socket → skipped', await phone.runCheck(), { skipped: 'no_socket' });
  check('… and retried in 5 min', Math.abs(phone.getNext().at - (clock.now() + 300)) <= 1);
  sockAvailable = true;
  const ownerRes = await phone.checkNow({ by: 'owner' });
  const ownerEvents = eventsOf('phone.check.started').at(-1);
  check('owner check: owner-actor events', ownerRes.drained === 0 && ownerEvents.actor === 'owner' && ownerEvents.originKind === 'owner' && eventsOf('phone.check.ended').at(-1).actor === 'owner');
  for (let i = 0; i < UNREAD_PER_CHAT + 10; i++) phone.noteUnread(OTHER, keyOf(OTHER, `U${i}`, CAROL));
  eq(`unread map bounded at ${UNREAD_PER_CHAT}/chat`, phone.unreadCount(OTHER), UNREAD_PER_CHAT);
  const failing = makePhone({ processMessage: async () => { throw new Error('turn failed'); } });
  const f1 = defer(BOB, BOB, 'this turn will fail', { availability: 'busy' });
  await failing.runCheck();
  eq('a failing turn drops its items with a reason (never loops)', [getItem(f1.id).status, getItem(f1.id).reason], ['dropped', 'error']);
  const cuOnly = buildCatchUp([
    { id: 1, msgId: 'a', enqueuedAt: T0, isMention: false, isDm: false, availability: 'busy' },
    { id: 2, msgId: 'b', enqueuedAt: T0 + 60, isMention: true, isDm: false, availability: 'busy' },
    { id: 3, msgId: 'c', enqueuedAt: T0 + 120, isMention: false, isDm: false, availability: 'busy' },
    { id: 4, msgId: 'd', enqueuedAt: T0 + 180, isMention: false, isDm: false, availability: 'busy' },
  ], T0 + 30 * MIN, { extraUnread: 2 });
  eq('buildCatchUp: mentions first, then newest; ≤ 3; extra unread counted', [cuOnly.triggerIds, cuOnly.newCount, cuOnly.awayMin], [['b', 'd', 'c'], 6, 30]);
  phone.stop();
  failing.stop();
  eq('no timers left armed', timers.live(), 0);
} finally {
  phone?.stop();
  setClock(null);
}

report();
