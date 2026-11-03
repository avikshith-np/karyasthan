// T024 — the per-chat lock shared by live turns and life's catch-up drain
// (src/whatsapp/events.js withChatLock, spec 009 §R10 / C2, FR-021, US2 #6).
// Real events.js over a scratch DB: messages enter through registerEventHandlers
// on a fake socket (debounce + flushBuffer, as live), and a "drain" job goes
// through the real withChatLock — it waits for a running turn, a message
// buffered while it runs is processed after it (never lost, never in parallel),
// a failing drain still releases the lock and re-flushes, the lock hands the
// job { turnSignal }, and an overrun turn is aborted when a drain takes over the
// chat. The processor is a stub: no LLM, no Jev, no network.
import { EventEmitter } from 'events';
import { setupScratchDb, section, check, eq, report } from './_helpers.js';

const { db } = await setupScratchDb();
const events = await import('../../src/whatsapp/events.js');
const { setSelfIdentity } = await import('../../src/utils/selfIdentity.js');

const BOT_PN = '155500000001:12@s.whatsapp.net';
const BOT_LID = '111122223333444:12@lid';
const ALICE = '700000000000001@lid';
const BOB = '700000000000002@lid';
const NOW = Math.floor(Date.now() / 1000);
const DEBOUNCE_WAIT_MS = 3400; // DM debounce (3 s) + margin
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

setSelfIdentity({ id: BOT_PN, lid: BOT_LID });
for (const [jid, name] of [[ALICE, 'Alice'], [BOB, 'Bob']]) {
  db.prepare('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)').run(jid, name, NOW - 90 * 86400);
  db.prepare(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', ?)`).run(jid, jid, NOW);
}

/** A promise with its resolve exposed, to hold a turn or a job open. */
function gate() {
  let open;
  const p = new Promise(r => { open = r; });
  return { p, open };
}

// Stub processor: records every run's start/end and the peak concurrency per chat.
const log = [];
let running = 0;
let maxRunning = 0;
const holds = new Map(); // msg id → gate the turn waits on
const seenCtx = new Map(); // msg id → context the turn got
events.setMessageProcessor(async (sock, msg, ctx) => {
  running++;
  maxRunning = Math.max(maxRunning, running);
  log.push(`start:${msg.id}`);
  seenCtx.set(msg.id, { ...ctx, chatJid: msg.groupJid });
  try {
    if (holds.has(msg.id)) await holds.get(msg.id).p;
  } finally {
    log.push(`end:${msg.id}`);
    running--;
  }
});

const sock = { ev: new EventEmitter(), user: { id: BOT_PN, lid: BOT_LID } };
events.registerEventHandlers(sock);
const upsert = (id, text, remote = ALICE, pushName = 'Alice') => sock.ev.emit('messages.upsert', {
  type: 'notify',
  messages: [{
    key: { remoteJid: remote, id, fromMe: false }, pushName,
    messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text },
  }],
});

/** A drain job run through the lock: logs its own start/end and counts toward concurrency. */
function drainJob(name, { hold, fail } = {}) {
  return async (lockCtx) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    log.push(`start:${name}`);
    try {
      if (hold) await hold.p;
      if (fail) throw new Error(`${name} failed`);
      return { name, signal: lockCtx?.turnSignal };
    } finally {
      log.push(`end:${name}`);
      running--;
    }
  };
}

section('a drain waits for the running turn, a message buffered during it runs after it');
{
  holds.set('m1', gate());
  upsert('m1', 'hey are you free this evening');
  await sleep(DEBOUNCE_WAIT_MS);
  check('the live turn m1 is running', log.includes('start:m1') && !log.includes('end:m1'), log);
  const chat = seenCtx.get('m1')?.chatJid;
  check('the turn got a turnSignal from the lock', seenCtx.get('m1')?.turnSignal instanceof AbortSignal);

  const drainHold = gate();
  const drain = events.withChatLock(chat, drainJob('drain', { hold: drainHold }));
  await sleep(150);
  check('the drain has not started while m1 holds the chat', !log.includes('start:drain'), log);

  holds.get('m1').open();
  await sleep(100);
  check('m1 finished, then the drain started', log.indexOf('end:m1') >= 0 && log.indexOf('end:m1') < log.indexOf('start:drain'), log);

  upsert('m2', 'also did you see the match');
  await sleep(DEBOUNCE_WAIT_MS + 700); // past the debounce and a re-arm of the deferred flush
  check('m2 is buffered, not processed, while the drain holds the chat', !log.includes('start:m2'), log);

  drainHold.open();
  const res = await drain;
  eq('withChatLock resolves with the job\'s result', res?.name, 'drain');
  check('the job got { turnSignal } (an AbortSignal, not aborted)', res?.signal instanceof AbortSignal && !res.signal.aborted);
  await sleep(200);
  eq('order: m1, drain, m2', log.filter(e => e.startsWith('start:')), ['start:m1', 'start:drain', 'start:m2']);
  check('m2 ran after the drain ended', log.indexOf('end:drain') < log.indexOf('start:m2'), log);
  eq('m2 processed exactly once', log.filter(e => e === 'start:m2').length, 1);
  eq('never more than one run in the chat at a time', maxRunning, 1);

  const t0 = Date.now();
  const after = await events.withChatLock(chat, async () => 'free');
  check('the lock is released afterwards (a fresh job runs at once)', after === 'free' && Date.now() - t0 < 200, Date.now() - t0);
}

section('a failing drain rejects to its caller, releases the lock and still flushes the buffer');
{
  log.length = 0;
  maxRunning = 0;
  const chat = seenCtx.get('m1').chatJid;
  const failHold = gate();
  const drain = events.withChatLock(chat, drainJob('bad-drain', { hold: failHold, fail: true }));
  await sleep(50);
  upsert('m3', 'hello?');
  await sleep(DEBOUNCE_WAIT_MS + 700);
  check('m3 waits behind the failing drain', !log.includes('start:m3'), log);
  failHold.open();
  let err = null;
  await drain.catch(e => { err = e; });
  eq('the drain\'s error reaches its caller', err?.message, 'bad-drain failed');
  await sleep(200);
  eq('m3 processed after the failed drain', log.filter(e => e.startsWith('start:')), ['start:bad-drain', 'start:m3']);
  eq('still one at a time', maxRunning, 1);
}

section('drains queued behind each other run in order, one at a time, each with its own signal');
{
  log.length = 0;
  maxRunning = 0;
  const chat = seenCtx.get('m1').chatJid;
  const h = gate();
  const a = events.withChatLock(chat, drainJob('a', { hold: h }));
  const b = events.withChatLock(chat, drainJob('b'));
  const c = events.withChatLock(chat, drainJob('c'));
  await sleep(50);
  eq('only the first queued job started', log, ['start:a']);
  h.open();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  eq('in queue order', log.filter(e => e.startsWith('start:')), ['start:a', 'start:b', 'start:c']);
  eq('never in parallel', maxRunning, 1);
  check('three distinct signals', ra.signal !== rb.signal && rb.signal !== rc.signal);
}

section('other chats are not blocked by a chat\'s drain');
{
  log.length = 0;
  maxRunning = 0;
  const chat = seenCtx.get('m1').chatJid;
  const h = gate();
  const drain = events.withChatLock(chat, drainJob('alice-drain', { hold: h }));
  upsert('b1', 'yo', BOB, 'Bob');
  await sleep(DEBOUNCE_WAIT_MS);
  check('Bob\'s DM turn ran while Alice\'s chat was held', log.includes('start:b1') && log.includes('end:b1'), log);
  h.open();
  await drain;
}

// The safety timeout, shortened so its paths run in milliseconds (restored below).
section('a drain queued behind a slow run gets its own full in-flight budget');
{
  events.__setInFlightSafetyMsForTest(1000);
  log.length = 0;
  maxRunning = 0;
  const chat = 'budget-chat@g.us';
  const a = events.withChatLock(chat, async () => { log.push('start:a'); await sleep(600); log.push('end:a'); });
  const b = events.withChatLock(chat, async () => { log.push('start:b'); await sleep(500); log.push('end:b'); });
  const c = events.withChatLock(chat, async () => { log.push('start:c'); log.push('end:c'); });
  await Promise.all([a, b, c]);
  // Timed from its own start (600 ms), b's guard fires at ~1600 ms — after b ends
  // at ~1100 ms — so the lock is never force-released under it and c waits. (Timed
  // from the enqueue it would fire at ~1000 ms, under b, and c would start early.)
  check('c starts only after b ended (b\'s 1 s budget ran from b\'s start)', log.indexOf('end:b') < log.indexOf('start:c'), log);
}

section('an overrun run is aborted when a drain takes over the chat, not before');
{
  events.__setInFlightSafetyMsForTest(400);
  const chat = 'stale-chat@g.us';
  let staleSignal = null;
  let sawAbortAtEnd = null;
  const slow = events.withChatLock(chat, async ({ turnSignal }) => {
    staleSignal = turnSignal;
    await sleep(1500);
    sawAbortAtEnd = turnSignal.aborted;
  });
  await sleep(700); // past the 400 ms guard: the lock is released, the run goes on
  check('after the timeout the overrun run is released but not aborted', staleSignal && !staleSignal.aborted);
  let abortedWhenDrainStarted = null;
  const t0 = Date.now();
  await events.withChatLock(chat, async () => { abortedWhenDrainStarted = staleSignal.aborted; });
  check('the drain did not wait for the overrun run', Date.now() - t0 < 500, Date.now() - t0);
  check('starting the drain aborted the overrun run (it must not send)', abortedWhenDrainStarted === true);
  await slow;
  check('the overrun run saw the abort before it could send', sawAbortAtEnd === true);

  const lone = events.withChatLock('lone-chat@g.us', async ({ turnSignal }) => { await sleep(1000); return turnSignal.aborted; });
  check('an overrun run with nothing behind it is never aborted', (await lone) === false);
  events.__setInFlightSafetyMsForTest(null);
}

report();
