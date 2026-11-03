// Offline checks for the response pipeline: the "is this aimed at the bot?" and
// stale-turn guards (the @-mention helper — own PN/LID only, tagging a friend is
// not a mention — the explicit+directed image-request detector, the in-flight
// turn guard), and spec 006's pipeline pieces: withChatLock, "forget that"
// (detected before debouncing, DM only) and explicit DM → group relays
// (prefilter → Jev → code decision → [RELAY_OK] confirmation → dispatch).
// No network, no WhatsApp: Jev, the LLM, the quality gate and sends are mocked.
// Exits non-zero if a check fails.
//
// Usage:  node scripts/test-pipeline.js
// Runs on an isolated, migrated scratch DB (data/test-pipeline.db) with DRY_RUN=true
// and warmup off; the DB is deleted and data/warmup.json restored on exit.

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DB_PATH = path.join(ROOT, 'data', 'test-pipeline.db');
process.env.DRY_RUN = 'true';
process.env.WARMUP_ENABLED = 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const WARMUP_FILE = path.join(ROOT, 'data', 'warmup.json');
const warmupBackup = fs.existsSync(WARMUP_FILE) ? fs.readFileSync(WARMUP_FILE) : null;

const {
  normalizeUserJid, isBotMentionedByJid, isBotAddressedInText, isBotMentioned,
  isExplicitImageRequest, isImageRequestForBot,
} = await import('../src/utils/mentions.js');
const events = await import('../src/whatsapp/events.js');
const { createTurnGuard } = events;
const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
const { config, getPersona } = await import('../src/utils/config.js');
const { setSelfIdentity } = await import('../src/utils/selfIdentity.js');
const membership = await import('../src/memory/membership.js');
const groupStore = await import('../src/memory/groupStore.js');
const { storeMessage } = await import('../src/memory/messageStore.js');
const store = await import('../src/memory/relationshipStore.js');
const relay = await import('../src/brain/relay.js');
const { stripRelayOk } = await import('../src/brain/contextBuilder.js');
const { loadMutedGroups, muteGroup, unmuteGroup } = await import('../src/dashboard/state.js');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}`);
  }
}

const BOT_PN = '155500000001:12@s.whatsapp.net';
const BOT_LID = '111122223333444:12@lid';
const FRIEND_PN = '155500002222@s.whatsapp.net';
const FRIEND_LID = '555566667777888@lid';
const ID = { botJid: BOT_PN, botLid: BOT_LID };
const DEBOUNCE_WAIT_MS = 3300;   // DM debounce (3 s) + margin

try {
  console.log('\nJID normalisation');
  check('device suffix stripped (PN)', normalizeUserJid('123:45@s.whatsapp.net') === '123@s.whatsapp.net');
  check('device suffix stripped (LID)', normalizeUserJid('987:3@lid') === '987@lid');
  check('c.us folds to s.whatsapp.net', normalizeUserJid('123@c.us') === '123@s.whatsapp.net');
  check('group JID rejected', normalizeUserJid('1203630@g.us') === null);
  check('junk rejected', normalizeUserJid({ id: 'x' }) === null && normalizeUserJid('') === null && normalizeUserJid('abc@lid') === null);

  console.log('\n@-mention helper');
  check('bot PN mention (no device suffix) → true', isBotMentionedByJid(['155500000001@s.whatsapp.net'], ID));
  check('bot PN mention (with device suffix) → true', isBotMentionedByJid(['155500000001:3@s.whatsapp.net'], ID));
  check('bot LID mention → true', isBotMentionedByJid(['111122223333444@lid'], ID));
  check('bot LID mention when only LID known → true', isBotMentionedByJid(['111122223333444@lid'], { botLid: BOT_LID }));
  check('configured phone counts as bot PN', isBotMentionedByJid(['155500000009@s.whatsapp.net'], { configPhone: '+1 55500 000009' }));
  check('tagging one friend (PN) → false', !isBotMentionedByJid([FRIEND_PN], ID));
  check('tagging one friend (LID) → false', !isBotMentionedByJid([FRIEND_LID], ID));
  check('tagging friend + bot → true', isBotMentionedByJid([FRIEND_LID, BOT_LID], ID));
  check('bot PN digits under @lid does not match', !isBotMentionedByJid(['155500000001@lid'], ID));
  check('unknown bot identity, single tag → false', !isBotMentionedByJid([FRIEND_PN], {}));
  check('unknown bot identity, no args → false', !isBotMentionedByJid([FRIEND_PN]));
  check('no mentions → false', !isBotMentionedByJid([], ID) && !isBotMentionedByJid(undefined, ID));

  console.log('\nName/alias address');
  check('alias in text → true', isBotAddressedInText('kary what do you think', ['kary']));
  check('alias case-insensitive → true', isBotAddressedInText('KARY??', ['kary']));
  check('no alias → false', !isBotAddressedInText('what do you guys think', ['kary']));
  check('combined: friend tag only, no alias → false',
    !isBotMentioned({ id: 't1', content: '@155500002222 come na', metadata: { mentionedJids: [FRIEND_PN] } }, ID));
  check('combined: bot LID tag → true',
    isBotMentioned({ id: 't2', content: '@111122223333444 hi', metadata: { mentionedJids: [BOT_LID] } }, ID));

  console.log('\nImage-request detector');
  check('"imagine if we went to goa" (directed) → false', !isImageRequestForBot('imagine if we went to goa', { directed: true }));
  check('"kary draw me a cat" directed → true', isImageRequestForBot('kary draw me a cat', { directed: true }));
  check('"kary draw me a cat" undirected → false', !isImageRequestForBot('kary draw me a cat', { directed: false }));
  check('undirected "can someone send a pic" → false', !isImageRequestForBot('can someone send a pic', { directed: false }));
  check('DM "send me a meme pic" → true', isImageRequestForBot('send me a meme pic', { directed: true }));
  check('"create a plan for saturday" → not explicit', !isExplicitImageRequest('create a plan for saturday'));
  check('"generate some ideas" → not explicit', !isExplicitImageRequest('generate some ideas'));
  check('"make a wallpaper of testville" → explicit', isExplicitImageRequest('make a wallpaper of testville'));
  check('"show me a picture of a dog" → explicit', isExplicitImageRequest('show me a picture of a dog'));
  check('"its a draw lol" → not explicit', !isExplicitImageRequest('its a draw lol'));
  check('"don\'t send pics" → not explicit', !isExplicitImageRequest("don't send pics"));
  check('@-tokens ignored ("@155500000001 imagine")', !isExplicitImageRequest('@155500000001 imagine that'));
  check('verb and noun in different sentences → false', !isExplicitImageRequest('send it. nice pic btw'));
  check('"kary generate a cat" → explicit', isExplicitImageRequest('kary generate a cat'));
  check('"kary image of a sunset" → explicit', isExplicitImageRequest('kary image of a sunset'));
  check('"photo of the beach pls" → explicit', isExplicitImageRequest('photo of the beach pls'));

  console.log('\nTurn guard (in-flight safety timeout)');
  {
    const guard = createTurnGuard(30);
    check('signal starts un-aborted', guard.signal.aborted === false);
    let rejected = null;
    await guard.race(new Promise(() => {})).catch(err => { rejected = err; });
    check('hung turn → race rejects with the in-flight timeout (lock released)', rejected?.message === 'processMessage in-flight timeout');
    check('timeout alone does NOT abort the turn (a late reply still sends)', guard.signal.aborted === false);
    // flushBuffer calls abort() only when a new turn takes over the chat:
    guard.abort();
    check('abort() → signal aborted', guard.signal.aborted === true);
    guard.abort();
    check('abort() is idempotent', guard.signal.aborted === true);
    // What processMessage does before every send:
    const context = { turnSignal: guard.signal };
    check('send gate trips on aborted context', !!context.turnSignal?.aborted);
  }
  {
    const guard = createTurnGuard(200);
    const value = await guard.race(Promise.resolve('done'));
    await new Promise(r => setTimeout(r, 250));
    check('fast turn → resolves normally', value === 'done');
    check('fast turn → never aborted (timer cleared)', guard.signal.aborted === false);
  }
  check('context without a signal never trips the gate', !({}).turnSignal?.aborted);

  await runSpec006Checks();
  await runSpec012Checks();
  await runAuditChecks();
} finally {
  try { relay.__setRelayDepsForTest(null); } catch {}
  try { closeDb(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${process.env.DB_PATH}${suffix}`;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
  try {
    if (warmupBackup) fs.writeFileSync(WARMUP_FILE, warmupBackup);
    else if (fs.existsSync(WARMUP_FILE)) fs.unlinkSync(WARMUP_FILE);
  } catch {}
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll pipeline checks passed');
process.exit(failures ? 1 : 0);

// ── spec 012: an invitation follow-up turn (decide(), pre-filter, prompt bar) ──

async function runSpec012Checks() {
  const { decide } = await import('../src/brain/decisionEngine.js');
  const { isEligible } = await import('../src/brain/prefilter.js');
  const { buildConversationContext } = await import('../src/personality/systemPrompt.js');
  const { setCooldown } = await import('../src/behavior/rateLimiter.js');
  const db = getDb();
  const G = '120363000000000099@g.us';
  const NOW = Math.floor(Date.now() / 1000);
  let n = 0;
  const msg = (extra = {}) => {
    const m = { id: `fu_${++n}`, groupJid: G, senderJid: FRIEND_PN, senderName: 'Friend', content: 'cinema at 8?', messageType: 'text',
      quotedId: null, isFromSelf: false, timestamp: NOW, metadata: { mentionedJids: [BOT_PN] }, ...extra };
    storeMessage(m);
    return m;
  };
  const selfAt = (ts) => storeMessage({ id: `fus_${++n}`, groupJid: G, senderJid: BOT_PN, senderName: 'Bot', content: 'ok', messageType: 'text', isFromSelf: true, timestamp: ts, metadata: {} });
  const FU = (m) => ({ isGroup: true, isDm: false, ...ID, followUp: { decisionId: 1, outcome: 'going' }, catchUp: { followUp: true, triggerIds: [m.id], itemIds: [] } });
  const savedCaps = [config.maxPerGroupHour, config.maxGlobalHour];

  console.log('\nspec 012: invitation follow-up turn — decide()');
  {
    config.maxPerGroupHour = 0; config.maxGlobalHour = 0;
    const m = msg();
    const d = decide(m, FU(m));
    check('a follow-up turn responds with text, no roll (factors.followUp)', d.shouldRespond && d.responseType === 'text' && d.factors.followUp === true);
    config.maxPerGroupHour = 1;
    selfAt(NOW - 600);
    const capped = decide(m, FU(m));
    check('…the group hourly cap applies with NO mention exemption (the invitation @-mentioned him)', !capped.shouldRespond
      && capped.factors.skipReason === 'rate_limited: hourly cap (group)');
    check('…while a plain @-mention of him is still exempt (unchanged)', decide(m, { isGroup: true, isDm: false, ...ID }).shouldRespond === true);
    config.maxPerGroupHour = 0;
    setCooldown(G, 60);
    const rl = decide(m, FU(m));
    check('…the rate limit applies with no mention bypass', !rl.shouldRespond && /^rate_limited: cooldown/.test(rl.factors.skipReason));
    db.prepare('DELETE FROM messages WHERE group_jid = ? AND is_from_self = 1').run(G);
    setCooldown(G, 0);
    for (let i = 0; i < 3; i++) selfAt(NOW - 10 - i);
    const burst = decide(m, FU(m));
    check('…and the burst check', !burst.shouldRespond && burst.factors.skipReason === 'burst_cooldown');
    db.prepare('DELETE FROM messages WHERE group_jid = ? AND is_from_self = 1').run(G);
    setCooldown(G, 0);
  }

  console.log('\nspec 012: invitation follow-up turn — pre-filter and prompt');
  {
    const m = msg();
    const el = isEligible(m, FU(m), { factors: {}, responseType: 'text' }, { responseType: 'text' });
    check('the Jev pre-filter never takes a follow-up turn (enforce cannot drop it)', el.eligible === false && el.reason === 'follow_up');
    const { text } = buildConversationContext(G, m, true, { life: { catchUp: { followUp: true, triggerIds: [m.id], itemIds: [] } },
      promptNotes: ["Earlier you weren't sure about a movie at Cinema with a friend at 20:00. You've decided to go — tell them you're coming, in a few words."] });
    check('the contribution bar is the follow-up line', text.includes("You're getting back to them about the invitation"));
    check('…not the catch-up bar, no "you were away" note', !text.includes("You're catching up on the chat") && !/You were away/.test(text));
    check('…the invitation is the ">>>" line and the note is in the prompt', text.split('\n').some(l => l.startsWith('>>> [') && l.includes(`[id:${m.id.slice(-8)}]`))
      && text.includes("You've decided to go"));
    const plain = buildConversationContext(G, m, true, { life: { catchUp: { triggerIds: [m.id], itemIds: [1], awayMin: 30, newCount: 1 } } }).text;
    check('a plain life catch-up still gets its own bar (unchanged)', plain.includes("You're catching up on the chat") && !plain.includes('getting back to them'));
  }
  [config.maxPerGroupHour, config.maxGlobalHour] = savedCaps;
}

// ── spec 006: chat lock, forget, relays ──────────────────────────────────────

async function runSpec006Checks() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${process.env.DB_PATH}${suffix}`); } catch {}
  }
  runMigrations();
  const db = getDb();
  const NOW = Math.floor(Date.now() / 1000);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  setSelfIdentity({ id: BOT_PN, lid: BOT_LID });
  const G = '120363000000000001@g.us';     // "Weekend Gang": Alice, Bob
  const H = '120363000000000002@g.us';     // "Office Team": Alice, Carol
  const K = '120363000000000003@g.us';     // "Cricket Club": Bob only
  const ALICE = '700000000000001@lid';
  const ALICE_PN = '155570000001@s.whatsapp.net';
  const BOB = '700000000000002@lid';
  const CAROL = '700000000000003@lid';
  for (const [jid, name] of [[G, 'Weekend Gang'], [H, 'Office Team'], [K, 'Cricket Club']]) {
    run('INSERT INTO groups (jid, name, joined_at) VALUES (?, ?, ?)', jid, name, NOW - 90 * 86400);
  }
  for (const [jid, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CAROL, 'Carol']]) {
    run('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)', jid, name, NOW - 90 * 86400);
    run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', ?)`, jid, jid, NOW);
  }
  run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'pn', 'sync', ?)`, ALICE_PN, ALICE, NOW);
  for (const [g, p] of [[G, ALICE], [G, BOB], [H, ALICE], [H, CAROL], [K, BOB]]) {
    groupStore.upsertMember(g, p, 'member', NOW - 60 * 86400);
  }
  const markAll = () => { for (const g of [G, H, K]) membership.__markSyncedForTest(g); };
  markAll();
  loadMutedGroups();

  // Mocks: every network seam of relay.js.
  const jevCalls = [];
  const llmCalls = [];
  const sends = [];
  let jevAnswer = { intent: 0.9, sensitive: 0.05, harm: 0.05 };
  let jevThrows = false;
  let llmReply = 'Alice says she will be late today';
  let gateResult = { pass: true, score: 0.9, reason: 'ok' };
  relay.__setRelayDepsForTest({
    askJev: async ({ state, questions }) => {
      jevCalls.push({ state, questions: Object.keys(questions) });
      if (jevThrows) throw new Error('Jev 503: mocked outage');
      return { model: 'mock', answers: Object.fromEntries(Object.entries(jevAnswer).map(([k, v]) => [k, { noul: v }])), usage: {}, ms: 1 };
    },
    callLlm: async (system, user, opts) => { llmCalls.push({ system, user, opts }); return llmReply; },
    evaluateResponse: async (text, snippet, opts) => ({ ...gateResult, opts }),
    sendText: async (sock, jid, text) => { sends.push({ jid, text }); return { key: { id: `sent_${sends.length}` } }; },
  });

  let seq = 0;
  const dmMsg = (content, extra = {}) => ({
    id: `dm_${++seq}`, groupJid: ALICE, senderJid: ALICE, senderName: 'Alice', content,
    messageType: 'text', isFromSelf: false, timestamp: NOW, quotedId: null, isForwarded: false, ...extra,
  });
  const relayRows = () => db.prepare('SELECT * FROM relays ORDER BY id').all();

  console.log('\nwithChatLock');
  {
    const order = [];
    const a = events.withChatLock('lock-test', async () => { await sleep(60); order.push('a'); return 'A'; });
    const b = events.withChatLock('lock-test', async () => { order.push('b'); return 'B'; });
    const [ra, rb] = await Promise.all([a, b]);
    check('jobs on one chat run one after another, in order', order.join(',') === 'a,b');
    check('withChatLock resolves with fn\'s result', ra === 'A' && rb === 'B');
    let err = null;
    await events.withChatLock('lock-test', async () => { throw new Error('boom'); }).catch(e => { err = e; });
    const after = await events.withChatLock('lock-test', async () => 'next');
    check('a failing job rejects to its caller and releases the lock', err?.message === 'boom' && after === 'next');
  }

  console.log('\n"forget that" detection');
  {
    const alias = (getPersona().aliases || [])[0] || getPersona().name;
    const yes = ['forget that', 'Forget that.', 'please forget that', 'forget it pls', 'forget what I just said',
      "don't remember that", 'delete that from your memory', 'athu marannekku', 'marannekku', `${alias}, forget that`,
      'ok forget everything'];
    const no = ["I'll never forget that trip", 'forget that, what time is dinner?', 'did you forget that I called?',
      'forgetting', 'dont forget the cake', 'marakkalle', ''];
    check('positives detected', yes.every(t => events.isForgetRequest(t)));
    for (const t of yes) if (!events.isForgetRequest(t)) console.log(`      missed: ${t}`);
    check('negatives (not whole-message requests) ignored', no.every(t => !events.isForgetRequest(t)));
    for (const t of no) if (events.isForgetRequest(t)) console.log(`      false hit: ${t}`);
  }

  console.log('\n"forget that" end-to-end (DM, before debouncing)');
  {
    const processed = [];
    events.setMessageProcessor(async (sock, msg, ctx) => { processed.push({ msg, ctx }); });
    const sock = { ev: new EventEmitter(), user: { id: BOT_PN, lid: BOT_LID } };
    events.registerEventHandlers(sock);
    const upsert = (id, text, remote = ALICE, extra = {}) => sock.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { remoteJid: remote, id, fromMe: false, ...extra.key }, pushName: extra.pushName || 'Alice',
      messageTimestamp: Math.floor(Date.now() / 1000), message: extra.message || { conversation: text },
    }] });
    // A secret told in the DM, and a fact learned from it.
    upsert('fg_secret', 'I got the job offer from the other company, keep it quiet');
    await sleep(50);
    const mem = store.addMemory({ category: 'fact', subjectJid: ALICE, originKind: 'dm', originJid: ALICE,
      content: 'Alice got a job offer elsewhere', source: 'batch', evidence: [{ msgId: 'fg_secret', ts: NOW }] });
    check('fixture: fact learned from the DM message', !!mem?.id);
    upsert('fg_req', 'forget that');
    await sleep(50);
    const fenced = db.prepare('SELECT no_learn FROM messages WHERE id = ?').pluck();
    check('the secret message is fenced (no_learn)', fenced.get('fg_secret') === 1);
    check('the request itself is fenced too', fenced.get('fg_req') === 1);
    check('the fact learned from it is deleted', !db.prepare('SELECT 1 FROM memories WHERE id = ?').get(mem.id));
    check('its fingerprint is tombstoned', !!db.prepare('SELECT 1 FROM learning_exclusions LIMIT 1').get());
    check('audited as memory.forget', !!db.prepare(`SELECT 1 FROM dashboard_audit WHERE action = 'memory.forget'`).get());
    await sleep(DEBOUNCE_WAIT_MS);
    check('neither message reached the response pipeline', processed.length === 0);

    // Group "forget that" is ordinary chat, not a request.
    upsert('fg_grp', 'forget that', G, { key: { participant: BOB }, pushName: 'Bob' });
    await sleep(50);
    check('in a group it is not a forget request (not fenced)', fenced.get('fg_grp') === 0);

    // Ingest: identity alt form + learning counter + ephemeral expiry.
    const DAN = '700000000000009@lid';
    const DAN_PN = '155570000009@s.whatsapp.net';
    upsert('ing_1', 'hello all', G, { key: { participant: DAN, participantAlt: DAN_PN }, pushName: 'Dan' });
    await sleep(50);
    check('participantAlt recorded as the sender\'s identity', db.prepare('SELECT person_jid FROM person_identities WHERE jid = ?').pluck().get(DAN_PN) === DAN);
    // A recycled number messaging PN-addressed (remoteJid = PN, alt = a new LID): the PN
    // moves to the new account; the new LID is never bound onto the previous owner.
    const OLD = '700000000000010@lid'; const OLD_PN = '155570000010@s.whatsapp.net'; const NEWL = '700000000000011@lid';
    run('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)', OLD, 'Oldie', NOW - 90 * 86400);
    run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', ?), (?, ?, 'pn', 'sync', ?)`,
      OLD, OLD, NOW, OLD_PN, OLD, NOW);
    upsert('rc_1', 'hi who is this', OLD_PN, { key: { remoteJidAlt: NEWL }, pushName: 'Newbie' });
    await sleep(50);
    check('PN-addressed DM with a new LID alt → PN reassigned to the new account',
      db.prepare('SELECT person_jid FROM person_identities WHERE jid = ?').pluck().get(OLD_PN) === NEWL
      && db.prepare('SELECT person_jid FROM person_identities WHERE jid = ?').pluck().get(NEWL) === NEWL);
    check('unknown group sender added as a member', membership.isCurrentMember(G, DAN));
    check('…and the group goes stale until the next sync', !membership.isFresh(G));
    check('learning counter advanced at ingest', (db.prepare('SELECT msgs_since_batch FROM learning_state WHERE chat_jid = ?').pluck().get(G) || 0) >= 1);
    upsert('eph_1', 'this disappears', ALICE, { message: { extendedTextMessage: { text: 'this disappears', contextInfo: { expiration: 86400 } } } });
    await sleep(50);
    const exp = db.prepare('SELECT expires_at, timestamp FROM messages WHERE id = ?').get('eph_1');
    check('disappearing message stored with expires_at = ts + timer', exp?.expires_at === exp?.timestamp + 86400);
    // Protocol messages (revoke / edit) are applied via messages.update, never stored.
    upsert('proto_1', null, ALICE, { message: { protocolMessage: { type: 0, key: { id: 'ing_1' } } } });
    await sleep(50);
    check('protocol message not stored as chat content', !db.prepare('SELECT 1 FROM messages WHERE id = ?').get('proto_1'));
    const editOf = (participant, text) => sock.ev.emit('messages.update', [{ key: { remoteJid: G, id: 'ing_1', participant },
      update: { message: { editedMessage: { message: { conversation: text } } } } }]);
    editOf(BOB, 'Dan owes me money');
    await sleep(20);
    check('an edit by someone other than the author is ignored', db.prepare('SELECT content FROM messages WHERE id = ?').pluck().get('ing_1') === 'hello all');
    editOf(DAN, 'hello everyone');
    await sleep(20);
    check('the author\'s edit replaces the stored text', db.prepare('SELECT content FROM messages WHERE id = ?').pluck().get('ing_1') === 'hello everyone');
    sock.ev.emit('messages.update', [{ key: { remoteJid: G, id: 'ing_1' }, update: { messageStubType: 1 } }]);
    await sleep(20);
    check('revoke (delete for everyone) removes the message', !db.prepare('SELECT 1 FROM messages WHERE id = ?').get('ing_1'));
    groupStore.removeMember(G, DAN);
    markAll();
    await sleep(DEBOUNCE_WAIT_MS);   // let any buffered group/DM flush settle
  }

  console.log('\nRelay prefilter + Jev + code decision');
  {
    check('prefilter: plain chat → no', !relay.looksLikeRelay('how was your day'));
    check('prefilter: "tell the group I\'ll be late" → yes', relay.looksLikeRelay("tell the group I'll be late"));
    check('prefilter: by group name → yes', relay.looksLikeRelay('tell weekend gang hi', ['Weekend Gang']));
    check('target: by distinctive word', relay.resolveTarget('tell office I am sick', [{ jid: G, name: 'Weekend Gang' }, { jid: H, name: 'Office Team' }]).group?.jid === H);
    check('target: generic with two groups → ambiguous', relay.resolveTarget('tell the group hi', [{ jid: G, name: 'Weekend Gang' }, { jid: H, name: 'Office Team' }]).ambiguous === true);
    check('target: generic with one group → that group', relay.resolveTarget('tell the group hi', [{ jid: G, name: 'Weekend Gang' }]).group?.jid === G);

    jevCalls.length = 0;
    check('no relay verb → null, Jev not called', (await relay.prepare({ chatJid: ALICE, messages: [dmMsg('how was the match')] })) === null && jevCalls.length === 0);
    check('a group chat never creates a relay', (await relay.prepare({ chatJid: G, messages: [{ ...dmMsg('tell the group hi'), groupJid: G }] })) === null);

    const ok = await relay.prepare({ chatJid: ALICE, messages: [dmMsg('so tired today'), dmMsg("tell weekend gang I'll be late for dinner")] });
    check('valid request → pending relay row', !!ok?.relayId && relayRows().at(-1)?.state === 'pending');
    check('…targeting the named group the requester is in', relayRows().at(-1)?.target_jid === G);
    check('…with the requester attributed', relayRows().at(-1)?.requester_jid === ALICE);
    check('…and a note asking for [RELAY_OK]', ok.promptNotes.some(n => n.includes('[RELAY_OK]') && n.includes('Weekend Gang')));
    check('only the relay message was shown to Jev', jevCalls.at(-1)?.state?.message?.includes('late for dinner') && !JSON.stringify(jevCalls.at(-1)).includes('tired'));

    const fwd = await relay.prepare({ chatJid: ALICE, messages: [dmMsg('tell weekend gang the party is off', { isForwarded: true })] });
    check('forwarded source → declined (no row, decline note)', fwd?.relayId === null && fwd.promptNotes[0].includes('can NOT'));
    const quoted = await relay.prepare({ chatJid: ALICE, messages: [dmMsg('tell weekend gang this', { quotedId: 'x1' })] });
    check('quoted source → declined', quoted?.relayId === null);

    const amb = await relay.prepare({ chatJid: ALICE, messages: [dmMsg('tell the group I said hi')] });
    check('ambiguous target → asks which group, no row', amb?.relayId === null && /which/.test(amb.promptNotes[0]));
    const notMine = await relay.prepare({ chatJid: ALICE, messages: [dmMsg('tell cricket club I quit')] });
    check('group the requester is not in → no row', notMine?.relayId == null);

    jevThrows = true;
    const down = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'm coming")] });
    check('Jev error → declined (fail closed), no row', down?.relayId === null && down.promptNotes[0].includes('can NOT'));
    jevThrows = false;

    jevAnswer = { intent: 0.2, sensitive: 0.05, harm: 0.05 };
    check('Jev says not a relay → ordinary turn (null)', (await relay.prepare({ chatJid: ALICE, messages: [dmMsg('did you tell the group about it?')] })) === null);
    jevAnswer = { intent: 0.9, sensitive: 0.05, harm: 0.9 };
    const harmful = await relay.prepare({ chatJid: ALICE, messages: [dmMsg('tell weekend gang that bob is a thief')] });
    check('harmful content → declined', harmful?.relayId === null);
    jevAnswer = { intent: 0.9, sensitive: 0.9, harm: 0.1 };
    const sensitive = await relay.prepare({ chatJid: ALICE, messages: [dmMsg('tell weekend gang bob has been in hospital')] });
    check('sensitive fact about another named person → declined', sensitive?.relayId === null);
    jevAnswer = { intent: 0.9, sensitive: 0.05, harm: 0.05 };

    muteGroup(G, { reason: 'test' });
    const muted = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'm here")] });
    check('muted target → declined', muted?.relayId === null);
    unmuteGroup(G);

    membership.__resetMembershipForTest();
    const stale = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'm here")] });
    check('stale membership → no eligible group, declined', stale?.relayId === null);
    markAll();
  }

  console.log('\nRelay confirmation + dispatch');
  {
    check('[RELAY_OK] stripped and reported', (() => { const r = stripRelayOk('sure, will tell them [RELAY_OK]'); return r.relayOk && r.text === 'sure, will tell them'; })());
    check('no token → relayOk false, text untouched', (() => { const r = stripRelayOk('nope'); return !r.relayOk && r.text === 'nope'; })());

    // Seed other DM content that must never reach the relay generation.
    storeMessage({ id: 'dm_private', groupJid: ALICE, senderJid: ALICE, content: 'PRIVATE-DM-SECRET', messageType: 'text', timestamp: NOW });

    const a = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    check('no marker in the reply → declined', relay.confirm(a.relayId, { relayOk: false, sentMessageId: 'm1' }) === false && relay.getRelay(a.relayId).state === 'declined');
    const b = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    check('stale turn → declined', relay.confirm(b.relayId, { relayOk: true, sentMessageId: 'm2', stale: true }) === false);

    const c = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    sends.length = 0; llmCalls.length = 0;
    check('marker + sent reply → confirmed', relay.confirm(c.relayId, { relayOk: true, sentMessageId: 'm3', sock: {} }) === true);
    await sleep(100);
    const rowC = relay.getRelay(c.relayId);
    check('dispatched into the target group', rowC.state === 'sent' && sends.some(s => s.jid === G));
    check('generated from the relay text + persona + target only', llmCalls.length === 1
      && llmCalls[0].user.includes("I'll be late") && llmCalls[0].system.includes('Weekend Gang')
      && !JSON.stringify(llmCalls[0]).includes('PRIVATE-DM-SECRET') && !JSON.stringify(llmCalls[0]).includes('Office Team'));
    check('credited to the requester', llmCalls[0].user.includes('Alice'));
    check('a relay is used once (a second confirm is a no-op)', relay.confirm(c.relayId, { relayOk: true, sentMessageId: 'm3' }) === false);

    const d = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    gateResult = { pass: false, score: 0.1, reason: 'harm' };
    sends.length = 0;
    relay.confirm(d.relayId, { relayOk: true, sentMessageId: 'm4', sock: {} });
    await sleep(100);
    check('gate rejects → failed, nothing posted in the group', relay.getRelay(d.relayId).state === 'failed' && !sends.some(s => s.jid === G));
    check('…and the requester is told in their DM', sends.some(s => s.jid === ALICE));
    gateResult = { pass: true, score: null, reason: 'no_response' };
    const e = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    relay.confirm(e.relayId, { relayOk: true, sentMessageId: 'm5', sock: {} });
    await sleep(100);
    check('gate with no verdict fails closed', relay.getRelay(e.relayId).state === 'failed');
    gateResult = { pass: true, score: 0.9, reason: 'ok' };

    const f = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    llmReply = '[SKIP]';
    relay.confirm(f.relayId, { relayOk: true, sentMessageId: 'm6', sock: {} });
    await sleep(100);
    check('model refuses ([SKIP]) → failed', relay.getRelay(f.relayId).state === 'failed');
    llmReply = 'Alice says she will be late today';

    const g = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    run('UPDATE relays SET created_at = ? WHERE id = ?', NOW - relay.RELAY_TTL_SEC - 5, g.relayId);
    check('pending relay expires after 10 min', relay.confirm(g.relayId, { relayOk: true, sentMessageId: 'm7' }) === false && relay.getRelay(g.relayId).state === 'expired');

    // The requester left the group between confirmation and dispatch.
    const h = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    groupStore.removeMember(G, ALICE);
    sends.length = 0;
    relay.confirm(h.relayId, { relayOk: true, sentMessageId: 'm8', sock: {} });
    await sleep(100);
    check('requester no longer a member at dispatch → failed, nothing posted', relay.getRelay(h.relayId).state === 'failed' && !sends.some(s => s.jid === G));
    groupStore.upsertMember(G, ALICE, 'member', NOW - 60 * 86400);
    markAll();

    // Credit spoofing: a self-chosen push name matching another member of the target.
    run("UPDATE people SET push_name = 'Bob' WHERE jid = ?", ALICE);
    const spoof = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I quit")] });
    check("push name = another member's name → declined before generation", spoof?.relayId === null
      && /same name/.test(spoof.promptNotes.join(' ')));
    run("UPDATE people SET real_name = 'Alice' WHERE jid = ?", ALICE);
    const owned = await relay.prepare({ chatJid: ALICE, messages: [dmMsg("tell weekend gang I'll be late")] });
    check('owner-set real name is credited over the push name', !!owned?.relayId && /Alice asked you/.test(owned.promptNotes.join(' ')));
    run("UPDATE people SET real_name = NULL WHERE jid = ?", ALICE);
    sends.length = 0; llmCalls.length = 0;
    relay.confirm(owned.relayId, { relayOk: true, sentMessageId: 'm9', sock: {} });
    await sleep(100);
    check('name collision at dispatch → failed, nothing generated or posted', relay.getRelay(owned.relayId).state === 'failed'
      && relay.getRelay(owned.relayId).error === 'declined' && !llmCalls.length && !sends.some(s => s.jid === G));
    run("UPDATE people SET push_name = 'Alice' WHERE jid = ?", ALICE);
  }

  console.log('\nRelay end-to-end through the DM flush');
  {
    const seen = [];
    events.setMessageProcessor(async (sock, msg, ctx) => { seen.push(ctx); });
    const sock = { ev: new EventEmitter(), user: { id: BOT_PN, lid: BOT_LID } };
    events.registerEventHandlers(sock);
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { remoteJid: ALICE, id: 'e2e_1', fromMe: false }, pushName: 'Alice',
      messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "tell weekend gang I'm bringing snacks" },
    }] });
    await sleep(DEBOUNCE_WAIT_MS + 200);
    const ctx = seen.at(-1);
    check('the DM turn carries the pending relay', !!ctx?.relay?.relayId && relay.getRelay(ctx.relay.relayId)?.state === 'pending');
    check('…and its prompt note', Array.isArray(ctx?.promptNotes) && ctx.promptNotes.some(n => n.includes('[RELAY_OK]')));
  }
}

// ── Pipeline audit (2026-10): skill flows, image edits, revoke/edit while buffered,
// [REPLY:] targets, replies to his media ──────────────────────────────────────

async function runAuditChecks() {
  const { decide } = await import('../src/brain/decisionEngine.js');
  const { startFlow, clearFlow, getActiveFlow } = await import('../src/behavior/activeFlows.js');
  const { setCooldown } = await import('../src/behavior/rateLimiter.js');
  const { sendText, sendImage, triggerNeedsQuote } = await import('../src/whatsapp/actions.js');
  const { isImageEditForBot } = await import('../src/utils/mentions.js');
  const { WAMessageStubType } = await import('@whiskeysockets/baileys');
  const db = getDb();
  const G = '120363000000000077@g.us';
  const ALICE = '700000000000001@lid';
  const NOW = Math.floor(Date.now() / 1000);
  const CTX = { isGroup: true, isDm: false, ...ID };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let n = 0;
  const msg = (content, extra = {}) => {
    const m = { id: `au_${++n}`, groupJid: G, senderJid: FRIEND_PN, senderName: 'Friend', content, messageType: 'text',
      quotedId: null, quotedContent: null, isFromSelf: false, timestamp: NOW, metadata: { mentionedJids: [] }, ...extra };
    storeMessage(m);
    return m;
  };
  const self = (ts, extra = {}) => {
    const m = { id: `aus_${++n}`, groupJid: G, senderJid: BOT_PN, senderName: 'Bot', content: 'ok', messageType: 'text', isFromSelf: true, timestamp: ts, metadata: {}, ...extra };
    storeMessage(m);
    return m;
  };
  const savedCaps = [config.maxPerGroupHour, config.maxGlobalHour];

  console.log('\nAn active skill flow does not force replies to unrelated messages');
  {
    config.maxPerGroupHour = 0; config.maxGlobalHour = 0;
    startFlow(G, 'bill_split', { initiatorJid: ALICE, participantJids: new Set([ALICE]), people: [] });
    for (const off of [30, 20, 10]) self(NOW - off);
    const rnd = Math.random;
    Math.random = () => 0;   // the roll passes: only the guards can stop it
    let d;
    try { d = decide(msg('random chatter about cricket'), CTX); } finally { Math.random = rnd; }
    check('a non-participant\'s message during a flow, in a burst → burst_cooldown (not a forced reply)',
      !d.shouldRespond && d.factors.skipReason === 'burst_cooldown' && d.factors.activeFlow === undefined);
    db.prepare('DELETE FROM messages WHERE group_jid = ? AND is_from_self = 1').run(G);
    setCooldown(G, 0);
    const flow = getActiveFlow(G);
    const before = flow.startedAt;
    flow.startedAt -= 60_000;
    decide(msg('more chatter'), CTX);
    check('…and decide() does not keep the flow alive', getActiveFlow(G)?.startedAt === before - 60_000);
    clearFlow(G);
  }

  console.log('\nA reply to his media is a reply to him');
  {
    const sticker = self(NOW - 60, { content: '[sticker]', messageType: 'sticker' });
    const d = decide(msg('haha what is this', { quotedId: sticker.id, quotedContent: null }), CTX);
    check('reply to his sticker (no quoted text) → mention factor 5', d.factors.mention === 5 && d.shouldRespond);
    const other = '120363000000000078@g.us';
    storeMessage({ id: 'au_other', groupJid: other, senderJid: BOT_PN, senderName: 'Bot', content: '[sticker]', messageType: 'sticker', isFromSelf: true, timestamp: NOW, metadata: {} });
    const d2 = decide(msg('lol', { quotedId: 'au_other', quotedContent: null }), CTX);
    check('a quoted id of his from another chat → not a reply to him here', (d2.factors.mention ?? 1) < 5);
    db.prepare('DELETE FROM messages WHERE group_jid = ? AND is_from_self = 1').run(G);
    setCooldown(G, 0);
  }

  console.log('\nImage edit (reply to an image) follows the image-request rule');
  {
    const ok = { shouldRespond: true };
    check('DM → allowed', isImageEditForBot({ isDm: true, mentionFactor: 0, decision: ok }));
    check('group, @-mention / reply to him → allowed', isImageEditForBot({ isDm: false, mentionFactor: 6, decision: ok }));
    check('group, undirected ("put on the shades lol") → refused', !isImageEditForBot({ isDm: false, mentionFactor: 1, decision: { shouldRespond: false, factors: { skipReason: 'probability' } } }));
    check('directed but capped (rate_limited) → refused', !isImageEditForBot({ isDm: false, mentionFactor: 6, decision: { shouldRespond: false, factors: { skipReason: 'rate_limited: hourly cap (global)' } } }));
    check('directed but burst cooldown → refused', !isImageEditForBot({ isDm: false, mentionFactor: 6, decision: { shouldRespond: false, factors: { skipReason: 'burst_cooldown' } } }));
    check('warmup forbids text → refused', !isImageEditForBot({ isDm: true, mentionFactor: 0, decision: ok, warmup: { allowed: true, responseType: 'reaction' } })
      && !isImageEditForBot({ isDm: true, mentionFactor: 0, decision: ok, warmup: { allowed: false } }));
  }

  console.log('\n[REPLY:<id>] picks the quoted message');
  {
    const target = msg('the earlier message');
    const trigger = msg('the trigger');
    const raw = { key: { remoteJid: G, id: trigger.id, participant: FRIEND_PN }, message: { conversation: 'the trigger' } };
    const captured = [];
    const sock = { user: { id: BOT_PN }, sendMessage: async (jid, content, options) => { captured.push(options); return { key: { id: `au_sent_${captured.length}` } }; } };
    const savedDry = config.dryRun;
    config.dryRun = false;
    try {
      await sendText(sock, G, 'plain', { rawMsg: raw }, {});   // first: his own sent line is newer than the trigger
      await sendText(sock, G, 'yeah that', { rawMsg: raw }, { quotedKey: { id: target.id } });
      await sendImage(sock, G, Buffer.from('x'), '', { rawMsg: raw }, { quotedKey: { id: target.id } });
      msg('a newer line');
      await sendText(sock, G, 'plain again', { rawMsg: raw }, {});
    } finally {
      config.dryRun = savedDry;
    }
    check('no marker, the trigger is the latest line → no quote', captured[0]?.quoted === undefined);
    check('sendText: an explicit quotedKey wins over the trigger', captured[1]?.quoted?.key?.id === target.id);
    check('sendImage: same', captured[2]?.quoted?.key?.id === target.id);
    check('no marker, a newer line arrived → the trigger is quoted', captured[3]?.quoted === raw);
  }

  console.log('\nA reply without [REPLY:] quotes its trigger only when it isn\'t answering the latest line');
  {
    const GQ = '120363000000000079@g.us';
    const DM = '700000000000009@lid';
    const BOB = '700000000000002@lid';
    let k = 0;
    const put = (chat, sender, extra = {}) => {
      const m = { id: `qq_${++k}`, groupJid: chat, senderJid: sender, senderName: 'X', content: `line ${k}`, messageType: 'text',
        quotedId: null, quotedContent: null, isFromSelf: sender === BOT_PN, timestamp: NOW + k, metadata: {}, ...extra };
      storeMessage(m);
      return m;
    };
    const captured = [];
    const sock = { user: { id: BOT_PN }, sendMessage: async (jid, content, options) => { captured.push(options); return { key: { id: `qq_sent_${captured.length}` } }; } };
    const rawOf = (m, chat) => ({ key: { remoteJid: chat, id: m.id, ...(chat.endsWith('@g.us') ? { participant: m.senderJid } : {}) }, message: { conversation: m.content } });
    const quoted = async (chat, m) => {
      const savedDry = config.dryRun;
      config.dryRun = false;
      try { await sendText(sock, chat, 'reply', { rawMsg: rawOf(m, chat) }, {}); } finally { config.dryRun = savedDry; }
      return captured.at(-1)?.quoted !== undefined;
    };

    const d1 = put(DM, DM);
    check('DM: a reply to the latest message → no quote', !(await quoted(DM, d1)));
    put(DM, DM);
    check('DM: the person wrote again since the trigger → quoted', await quoted(DM, d1));

    const g1 = put(GQ, ALICE);
    check('group: a reply to the latest line → no quote', !(await quoted(GQ, g1)));
    put(GQ, ALICE, { messageType: 'reaction', content: '👍' });
    check('…a reaction since does not count', !(await quoted(GQ, g1)));
    put(GQ, BOB);
    check('group: someone else spoke since → quoted', await quoted(GQ, g1));
    const g2 = put(GQ, ALICE);
    put(GQ, BOT_PN);
    check('group: he spoke since (another turn) → quoted', await quoted(GQ, g2));

    const ghost = { id: 'qq_not_stored', senderJid: ALICE };
    check('trigger not stored, the last speaker is someone else → quote', triggerNeedsQuote(GQ, ghost));
    put(GQ, ALICE);
    check('trigger not stored, the last speaker is its sender → no quote', !triggerNeedsQuote(GQ, ghost));
    check('an empty chat → no quote', !triggerNeedsQuote('120363000000000080@g.us', { id: 'x', senderJid: ALICE }));
  }

  console.log('\nA message revoked or edited while it waits in the debounce buffer');
  {
    const processed = [];
    events.setMessageProcessor(async (sock, m, ctx) => { processed.push({ m, ctx }); });
    const sock = { ev: new EventEmitter(), user: { id: BOT_PN, lid: BOT_LID } };
    events.registerEventHandlers(sock);
    const upsert = (id, text) => sock.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { remoteJid: ALICE, id, fromMe: false }, pushName: 'Alice',
      messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text },
    }] });
    upsert('rv_1', 'call me when you are free');
    await sleep(50);
    sock.ev.emit('messages.update', [{ key: { remoteJid: ALICE, id: 'rv_1', fromMe: false }, update: { messageStubType: WAMessageStubType.REVOKE } }]);
    await sleep(DEBOUNCE_WAIT_MS);
    check('revoked before the flush → no turn', processed.length === 0);

    upsert('ed_1', 'see you at 7');
    await sleep(50);
    sock.ev.emit('messages.update', [{ key: { remoteJid: ALICE, id: 'ed_1', fromMe: false }, update: { message: { editedMessage: { message: { conversation: 'see you at 9' } } } } }]);
    await sleep(DEBOUNCE_WAIT_MS);
    check('edited before the flush → the turn sees the new text', processed.length === 1 && processed[0].m.content === 'see you at 9');
    // The reply's quote is built from context.rawMsg: it must be this message's own,
    // carrying the edited text — never the text the sender edited away.
    // A newer line is stored first, so the reply has to quote its trigger.
    let newer = 0;
    const quoteOf = async (ctx) => {
      const captured = [];
      const qsock = { user: { id: BOT_PN }, sendMessage: async (jid, content, options) => { captured.push(options); return { key: { id: `au_q_${captured.length}` } }; } };
      const savedDry = config.dryRun;
      config.dryRun = false;
      const later = `au_newer_${++newer}`;
      storeMessage({ id: later, groupJid: ALICE, senderJid: ALICE, senderName: 'Alice', content: 'one more thing', messageType: 'text', isFromSelf: false, timestamp: Math.floor(Date.now() / 1000) + 60, metadata: {} });
      try { await sendText(qsock, ALICE, 'ok', ctx, {}); } finally {
        config.dryRun = savedDry;
        db.prepare('DELETE FROM messages WHERE id = ?').run(later);
      }
      return captured[0]?.quoted || null;
    };
    {
      const q = await quoteOf(processed[0]?.ctx);
      check('…its context.rawMsg is that message', processed[0]?.ctx.rawMsg?.key?.id === 'ed_1');
      check('…and the reply quotes the new text, not the old one',
        q?.key?.id === 'ed_1' && !JSON.stringify(q?.message || {}).includes('see you at 7') && JSON.stringify(q?.message || {}).includes('see you at 9'));
    }

    processed.length = 0;
    upsert('rv_2', 'first line');
    await sleep(30);
    upsert('rv_3', 'second line');
    await sleep(50);
    sock.ev.emit('messages.update', [{ key: { remoteJid: ALICE, id: 'rv_3', fromMe: false }, update: { messageStubType: WAMessageStubType.REVOKE } }]);
    await sleep(DEBOUNCE_WAIT_MS);
    check('the newest line revoked → the turn answers the line still there', processed.length === 1 && processed[0].m.id === 'rv_2');
    {
      const q = await quoteOf(processed[0]?.ctx);
      check('…with that line\'s own raw message (context.rawMsg)', processed[0]?.ctx.rawMsg?.key?.id === 'rv_2');
      check('…so the reply never quotes the revoked line', q?.key?.id === 'rv_2' && !JSON.stringify(q?.message || {}).includes('second line'));
    }

    // An image whose caption is edited while it waits: the quote must not carry the old caption.
    processed.length = 0;
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { remoteJid: ALICE, id: 'im_1', fromMe: false }, pushName: 'Alice',
      messageTimestamp: Math.floor(Date.now() / 1000), message: { imageMessage: { caption: 'my address is 12 Old Lane', mimetype: 'image/jpeg' } },
    }] });
    await sleep(50);
    sock.ev.emit('messages.update', [{ key: { remoteJid: ALICE, id: 'im_1', fromMe: false }, update: { message: { editedMessage: { message: { imageMessage: { caption: 'look at this', mimetype: 'image/jpeg' } } } } } }]);
    await sleep(DEBOUNCE_WAIT_MS);
    {
      const q = await quoteOf(processed[0]?.ctx);
      check('an image whose caption was edited → the reply quote never carries the old caption',
        processed.length === 1 && processed[0].ctx.rawMsg?.key?.id === 'im_1' && !JSON.stringify(q || {}).includes('12 Old Lane'));
    }

    // Several buffered lines processed one by one (an earlier skill trigger): each turn
    // carries its own raw message, not the newest line's.
    processed.length = 0;
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { remoteJid: ALICE, id: 'tr_1', fromMe: false }, pushName: 'Alice', messageTimestamp: Math.floor(Date.now() / 1000),
      message: { extendedTextMessage: { text: 'split this', contextInfo: { stanzaId: 'some_bill', participant: ALICE, quotedMessage: { conversation: 'dinner 1200' }, mentionedJid: [BOT_PN] } } },
    }] });
    await sleep(30);
    upsert('tr_2', 'thanks');
    await sleep(DEBOUNCE_WAIT_MS);
    check('an earlier trigger in the buffer → every line is processed with its own raw message',
      processed.length === 2 && processed.every(p => p.ctx.rawMsg?.key?.id === p.m.id));
  }
  [config.maxPerGroupHour, config.maxGlobalHour] = savedCaps;
}
