// Offline checks for the cap catch-up (src/behavior/capCatchUp.js): when an hourly
// cap blocks a group reply he would have sent, ONE catch-up reply goes out in that
// group once the cap frees. Covers decide()'s capped path (would-reply queues,
// would-skip / would-react doesn't, the factors), the pending store (≤ 3 triggers,
// mentions kept), the pass (waits for the cap, one fire per group, the global slot
// re-checked between groups, live reply / max age / mute / invisible triggers drop
// the entry, life availability, DRY_RUN) and the catch-up turn itself (no second
// roll, prompt wording). No network, no WhatsApp: processMessage is a stub (sends
// go through the real DRY_RUN sendText against a fake socket).
//
// Usage:  node scripts/test-cap-catchup.js   (npm run test:cap-catchup)
// Runs on an isolated, migrated scratch DB (data/test-cap-catchup.db) with
// DRY_RUN=true and warmup off; the DB is deleted and data/warmup.json restored on exit.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DB_PATH = path.join(ROOT, 'data', 'test-cap-catchup.db');
process.env.DRY_RUN = 'true';
process.env.WARMUP_ENABLED = 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const WARMUP_FILE = path.join(ROOT, 'data', 'warmup.json');
const warmupBackup = fs.existsSync(WARMUP_FILE) ? fs.readFileSync(WARMUP_FILE) : null;

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${process.env.DB_PATH}${suffix}`); } catch {}
}

const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
const { config } = await import('../src/utils/config.js');
const { storeMessage } = await import('../src/memory/messageStore.js');
const { decide } = await import('../src/brain/decisionEngine.js');
const cap = await import('../src/behavior/capCatchUp.js');
const { withChatLock } = await import('../src/whatsapp/events.js');
const { sendText } = await import('../src/whatsapp/actions.js');
const { loadMutedGroups, muteGroup, unmuteGroup, isGroupMuted } = await import('../src/dashboard/state.js');
const { buildConversationContext } = await import('../src/personality/systemPrompt.js');

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
const FRIEND = '155500002222@s.whatsapp.net';
const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';
const G3 = '120363000000000003@g.us';
const CTX = { isGroup: true, isDm: false, botJid: BOT_PN, botLid: BOT_LID };

let seq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);

function member(group, content, extra = {}) {
  const msg = {
    id: `m${++seq}`, groupJid: group, senderJid: FRIEND, senderName: 'Friend', content, messageType: 'text',
    quotedId: null, quotedContent: null, quotedParticipant: null, isFromSelf: false, timestamp: nowSec(),
    metadata: { mentionedJids: [] }, ...extra,
  };
  storeMessage(msg);
  return msg;
}
function self(group, ts) {
  storeMessage({
    id: `s${++seq}`, groupJid: group, senderJid: BOT_PN, senderName: 'Bot', content: 'earlier reply', messageType: 'text',
    isFromSelf: true, timestamp: ts, metadata: {},
  });
}
// Free a cap: every self message of `group` (or all) moves out of the last hour.
function backdateSelf(group = null) {
  const db = getDb();
  if (group) db.prepare(`UPDATE messages SET timestamp = timestamp - 7200 WHERE is_from_self = 1 AND group_jid = ?`).run(group);
  else db.prepare(`UPDATE messages SET timestamp = timestamp - 7200 WHERE is_from_self = 1`).run();
}
function clearChat() {
  getDb().prepare(`DELETE FROM messages`).run();
  cap.resetCapCatchUpForTest();
}
// Math.random as a fixed sequence (the last value repeats).
function withRandom(values, fn) {
  const orig = Math.random;
  let i = 0;
  Math.random = () => values[Math.min(i++, values.length - 1)];
  try { return fn(); } finally { Math.random = orig; }
}

// The pass's deps: a counting processMessage stub (optionally "sends": stores a self row).
const calls = [];
let sendsSelfRow = true;
let lifeStub = null;
let clockOffset = 0;
const fakeSock = { user: { id: BOT_PN, lid: BOT_LID }, sent: 0, sendMessage: async () => { fakeSock.sent++; return { key: { id: 'x' } }; } };
async function stubProcess(sock, msg, ctx) {
  calls.push({ msg, ctx });
  if (sendsSelfRow) self(msg.groupJid, nowSec() + 1);
}
function arm(extra = {}) {
  cap.startCapCatchUp({
    getSock: () => fakeSock, processMessage: stubProcess, withChatLock, isGroupMuted,
    life: lifeStub, now: () => nowSec() + clockOffset, intervalMs: 3_600_000, ...extra,
  });
  cap.stopCapCatchUp(); // tests drive runCapCatchUpPass() themselves; deps stay
}

try {
  runMigrations();
  loadMutedGroups();
  config.responseRate = 0.15;
  config.maxPerGroupHour = 2;
  config.maxGlobalHour = 0;
  config.capCatchUp.enabled = true;
  config.capCatchUp.maxAgeMinutes = 120;

  console.log('\ndecide() on the capped path');
  {
    clearChat(); arm();
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    const m = member(G1, 'anyone up for lunch?');
    const d = withRandom([0], () => decide(m, CTX));
    check('capped would-reply → still a skip', d.shouldRespond === false);
    check('skip reason unchanged (rate_limited: hourly cap (group))', d.factors.skipReason === 'rate_limited: hourly cap (group)');
    check('factors.catchUpQueued = true', d.factors.catchUpQueued === true);
    check('the score + roll are kept for the Decisions page', typeof d.factors.finalScore === 'number' && d.factors.roll === 0);
    const p = cap.listPendingCatchUps();
    check('one pending entry for the group', p.length === 1 && p[0].groupJid === G1 && p[0].triggers[0].id === m.id);
    check('not a mention', p[0].isMention === false);
  }
  {
    clearChat(); arm();
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    const m = member(G1, 'just had lunch');
    const d = withRandom([0.99], () => decide(m, CTX));
    check('capped would-skip → skip, catchUpQueued = false', d.shouldRespond === false && d.factors.catchUpQueued === false
      && d.factors.skipReason === 'rate_limited: hourly cap (group)');
    check('capped would-skip → nothing pending', cap.listPendingCatchUps().length === 0);
    const r = withRandom([0, 0.8], () => decide(member(G1, 'anyone up for lunch?'), CTX));
    check('capped would-react (reaction only) → nothing pending', r.factors.catchUpQueued === false && cap.listPendingCatchUps().length === 0);
    config.capCatchUp.enabled = false;
    const off = withRandom([0], () => decide(member(G1, 'anyone up for lunch?'), CTX));
    check('CAP_CATCHUP_ENABLED=false → plain cap skip, nothing pending',
      off.factors.skipReason === 'rate_limited: hourly cap (group)' && off.factors.catchUpQueued === undefined && cap.listPendingCatchUps().length === 0);
    config.capCatchUp.enabled = true;
    const uncapped = withRandom([0], () => decide(member(G2, 'anyone up for lunch?'), CTX));
    check('uncapped group → normal reply, no catch-up factor', uncapped.shouldRespond === true && uncapped.factors.catchUpQueued === undefined);
    const own = decide({ ...member(G1, 'mine'), isFromSelf: true }, CTX);
    check('own message → own_message, nothing pending', own.factors.skipReason === 'own_message' && cap.listPendingCatchUps().length === 0);
    const lifeTurn = withRandom([0], () => decide(member(G1, 'anyone up for lunch?'), { ...CTX, catchUp: { triggerIds: [], itemIds: [1] } }));
    check('a capped catch-up turn never queues another', lifeTurn.factors.skipReason === 'rate_limited: hourly cap (group)'
      && cap.listPendingCatchUps().length === 0);
  }

  console.log('\nThe pending store');
  {
    clearChat(); arm();
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    const ms = [1, 2, 3, 4].map(i => member(G1, `question ${i}?`));
    for (const m of ms) withRandom([0], () => decide(m, CTX));
    const p = cap.listPendingCatchUps();
    check('several triggers → still one entry', p.length === 1);
    check('keeps the last ≤ 3 (oldest dropped)', p[0].triggers.length === 3 && p[0].triggers.map(t => t.id).join() === ms.slice(1).map(m => m.id).join());
    check('first / last skipped time recorded', p[0].firstAt <= p[0].lastAt);
  }

  console.log('\nFiring');
  {
    clearChat(); arm(); calls.length = 0;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    const ms = [1, 2, 3].map(i => member(G1, `question ${i}?`));
    for (const m of ms) withRandom([0], () => decide(m, CTX));
    let res = await cap.runCapCatchUpPass();
    check('cap still full → kept, no turn', res.kept === 1 && calls.length === 0 && cap.listPendingCatchUps().length === 1);
    backdateSelf(G1);
    res = await cap.runCapCatchUpPass();
    check('cap freed → exactly one turn', res.fired === 1 && calls.length === 1);
    const c = calls[0];
    check('turn runs on the newest trigger', c.msg.id === ms[2].id && c.msg.groupJid === G1 && c.msg.isFromSelf === false);
    check('ctx.catchUp marks it a cap catch-up with all 3 triggers', c.ctx.catchUp?.cap === true
      && c.ctx.catchUp.triggerIds.join() === ms.map(m => m.id).join() && c.ctx.catchUp.itemIds.length === 0);
    check('ctx carries the held-back note, no raw message, bot identity', c.ctx.promptNotes?.[0]?.includes('held back')
      && c.ctx.rawMsg === null && c.ctx.botJid === BOT_PN && c.ctx.isGroup === true && c.ctx.isDm === false);
    check('ctx carries the lock\'s turn signal', !!c.ctx.turnSignal && c.ctx.turnSignal.aborted === false);
    check('entry consumed', cap.listPendingCatchUps().length === 0);
    res = await cap.runCapCatchUpPass();
    check('next pass → no second reply', res.fired === 0 && calls.length === 1);
  }
  {
    // The model answers [SKIP]: nothing is sent, and the group still gets no second try.
    clearChat(); arm(); calls.length = 0; sendsSelfRow = false;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    withRandom([0], () => decide(member(G1, 'question?'), CTX));
    backdateSelf(G1);
    await cap.runCapCatchUpPass();
    await cap.runCapCatchUpPass();
    check('a [SKIP]ped catch-up is not retried', calls.length === 1 && cap.listPendingCatchUps().length === 0);
    sendsSelfRow = true;
  }
  {
    // Two groups pending, one global slot: the older fires, its send fills the slot,
    // the younger waits for the next one.
    clearChat(); arm(); calls.length = 0;
    config.maxGlobalHour = 3;
    self(G3, nowSec() - 600); self(G3, nowSec() - 500); self(G3, nowSec() - 400);
    withRandom([0], () => decide(member(G1, 'first?'), CTX));
    clockOffset = 5;
    withRandom([0], () => decide(member(G2, 'second?'), CTX));
    clockOffset = 0;
    check('both groups pending (global cap)', cap.listPendingCatchUps().length === 2);
    getDb().prepare(`UPDATE messages SET timestamp = timestamp - 7200 WHERE id = (SELECT id FROM messages WHERE is_from_self = 1 AND group_jid = ? LIMIT 1)`).run(G3);
    const res = await cap.runCapCatchUpPass();
    check('one global slot → only the oldest group fires', res.fired === 1 && calls.length === 1 && calls[0].msg.groupJid === G1);
    check('the other stays pending', cap.listPendingCatchUps().map(e => e.groupJid).join() === G2);
    config.maxGlobalHour = 0;
  }

  console.log('\nDropping');
  {
    clearChat(); arm(); calls.length = 0;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    withRandom([0], () => decide(member(G1, 'question?'), CTX));
    self(G1, nowSec() + 2); // a live turn replied in the meantime
    backdateSelf(G1);       // (any cap has freed meanwhile)
    getDb().prepare(`UPDATE messages SET timestamp = ? WHERE id = ?`).run(nowSec() + 2, `s${seq}`);
    const res = await cap.runCapCatchUpPass();
    check('a live reply since the trigger → dropped, no turn', res.dropped === 1 && calls.length === 0 && cap.listPendingCatchUps().length === 0);
  }
  {
    clearChat(); arm(); calls.length = 0;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    withRandom([0], () => decide(member(G1, 'question?'), CTX));
    clockOffset = 121 * 60;
    const res = await cap.runCapCatchUpPass();
    clockOffset = 0;
    check('older than CAP_CATCHUP_MAX_AGE_MINUTES → dropped', res.dropped === 1 && calls.length === 0 && cap.listPendingCatchUps().length === 0);
  }
  {
    clearChat(); arm(); calls.length = 0;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    withRandom([0], () => decide(member(G1, 'question?'), CTX));
    muteGroup(G1, { reason: 'test' });
    backdateSelf(G1);
    const res = await cap.runCapCatchUpPass();
    unmuteGroup(G1);
    check('muted group → dropped, no turn', res.dropped === 1 && calls.length === 0 && cap.listPendingCatchUps().length === 0);
  }
  {
    clearChat(); arm(); calls.length = 0;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    const m = member(G1, 'question?');
    withRandom([0], () => decide(m, CTX));
    getDb().prepare(`UPDATE messages SET no_learn = 1 WHERE id = ?`).run(m.id); // "forget that"
    backdateSelf(G1);
    const res = await cap.runCapCatchUpPass();
    check('trigger no longer prompt-visible → dropped, no turn', res.dropped === 1 && calls.length === 0);
  }
  {
    clearChat(); arm(); calls.length = 0;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    withRandom([0], () => decide(member(G1, 'question?'), CTX));
    config.capCatchUp.enabled = false;
    const res = await cap.runCapCatchUpPass();
    config.capCatchUp.enabled = true;
    check('switched off at runtime → pending entries dropped', res.dropped === 1 && cap.listPendingCatchUps().length === 0);
  }

  console.log('\nDRY_RUN and life');
  {
    clearChat(); calls.length = 0; fakeSock.sent = 0; sendsSelfRow = false;
    arm({ processMessage: async (sock, msg, ctx) => { calls.push({ msg, ctx }); await sendText(sock, msg.groupJid, 'catching up'); } });
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    withRandom([0], () => decide(member(G1, 'question?'), CTX));
    backdateSelf(G1);
    await cap.runCapCatchUpPass();
    await cap.runCapCatchUpPass();
    check('DRY_RUN → the turn runs once, the socket never sends', config.dryRun === true && calls.length === 1 && fakeSock.sent === 0);
    sendsSelfRow = true;
  }
  {
    clearChat(); calls.length = 0;
    let avail = 'meeting';
    let onPhone = false;
    lifeStub = { isLifeOn: () => true, availabilityNow: () => avail, inPhoneCheckNow: () => onPhone };
    arm();
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);
    withRandom([0], () => decide(member(G1, 'question?'), CTX));
    backdateSelf(G1);
    let res = await cap.runCapCatchUpPass();
    check('life on, he is in a meeting → kept, no turn', res.kept === 1 && calls.length === 0 && cap.listPendingCatchUps().length === 1);
    lifeStub.availabilityNow = () => { throw new Error('boom'); };
    res = await cap.runCapCatchUpPass();
    check('life error → not available (kept)', res.kept === 1 && calls.length === 0);
    lifeStub.availabilityNow = () => avail;
    onPhone = true;
    res = await cap.runCapCatchUpPass();
    check('life on, he checks his phone → fires', res.fired === 1 && calls.length === 1);
    lifeStub = null;
  }

  console.log('\nMentions');
  {
    clearChat(); arm(); calls.length = 0;
    config.maxGlobalHour = 4;
    self(G1, nowSec() - 600); self(G1, nowSec() - 500);                // group cap (2) full
    self(G3, nowSec() - 600); self(G3, nowSec() - 500);                // + 2 → global (4) full
    const m = member(G1, 'hey you, thoughts?', { metadata: { mentionedJids: ['155500000001@s.whatsapp.net'] } });
    const d = withRandom([0.99], () => decide(m, CTX));
    check('capped @-mention (global cap) → queued even on a bad roll', d.factors.skipReason === 'rate_limited: hourly cap (global)' && d.factors.catchUpQueued === true);
    const p = cap.listPendingCatchUps();
    check('the entry carries the mention flag', p.length === 1 && p[0].isMention === true && p[0].triggers[0].isMention === true);
    for (const i of [1, 2, 3]) withRandom([0], () => decide(member(G1, `chatter ${i}?`), CTX));
    const p2 = cap.listPendingCatchUps()[0];
    check('a mention trigger outlives newer chatter in the last 3', p2.triggers.length === 3 && p2.triggers.some(t => t.id === m.id) && p2.isMention === true);
    backdateSelf(G3); // the global cap frees; G1's group cap is still full — a mention is exempt
    const res = await cap.runCapCatchUpPass();
    check('mention → fires past the full group cap', res.fired === 1 && calls.length === 1 && calls[0].ctx.catchUp.triggerIds.includes(m.id));
    // The fired turn through the real decide(): the mention among the triggers keeps the
    // group-cap exemption, and there is no second roll.
    const c = calls[0];
    getDb().prepare(`DELETE FROM messages WHERE is_from_self = 1 AND timestamp > ?`).run(nowSec());
    const again = withRandom([0.99], () => decide(c.msg, { ...CTX, catchUp: c.ctx.catchUp }));
    check('catch-up turn → responds with text despite a bad roll (no re-roll)', again.shouldRespond === true && again.responseType === 'text' && again.factors.capCatchUp === true);
    check('…and keeps its trigger\'s @-mention (factors.mention ≥ 5: mention threshold, directed, fast delay)', again.factors.mention >= 5);
    const { isEligible } = await import('../src/brain/prefilter.js');
    const el = isEligible(c.msg, { ...CTX, catchUp: c.ctx.catchUp }, again, { responseType: 'text' });
    check('the Jev pre-filter never takes a cap catch-up turn (its one attempt)', el.eligible === false);
    config.maxGlobalHour = 0;
    const noMention = withRandom([0.99], () => decide(c.msg, { ...CTX, catchUp: { ...c.ctx.catchUp, triggerIds: [] } }));
    check('catch-up turn without the mention, group cap full → cap skip, not re-queued', noMention.shouldRespond === false
      && noMention.factors.skipReason === 'rate_limited: hourly cap (group)' && cap.listPendingCatchUps().length === 0);
  }

  console.log('\nThe pass has no side effects on the burst cooldown');
  {
    clearChat(); arm(); calls.length = 0;
    const { getAllCooldowns, setCooldown } = await import('../src/behavior/rateLimiter.js');
    setCooldown(G2, 0);
    config.maxPerGroupHour = 3;
    for (const off of [80, 70, 60]) self(G2, nowSec() - off);   // 3 self rows in the last 90 s
    const m = member(G2, 'anyone up for lunch?');
    withRandom([0], () => decide(m, CTX));
    check('fixture: capped → pending', cap.listPendingCatchUps().length === 1);
    config.maxPerGroupHour = 0;   // the cap frees; the burst window still holds 3 of his lines
    const res = await cap.runCapCatchUpPass();
    check('in a burst → kept, no turn', res.kept === 1 && res.fired === 0 && calls.length === 0);
    check('…and checking it started no burst cooldown', !getAllCooldowns().some(c => c.jid === G2));
    config.maxPerGroupHour = 2;
  }

  console.log('\nPrompt wording');
  {
    clearChat();
    const a = member(G1, 'first question?');
    const b = member(G1, 'second question?');
    const opts = { life: { catchUp: { cap: true, triggerIds: [a.id, b.id], itemIds: [] } }, promptNotes: ['You held back from this chat for ~20 min rather than jump in.'] };
    const { text } = buildConversationContext(G1, b, true, opts);
    const marked = (id) => text.split('\n').some(l => l.startsWith('>>> [') && l.includes(`[id:${id.slice(-8)}]`));
    check('both triggers marked ">>>"', marked(a.id) && marked(b.id));
    check('"held back", not "being away" / "you were away"', text.includes('after holding back for a while') && text.includes('messages you held back from')
      && !text.includes('after being away') && !/You were away/.test(text));
    check('the held-back note is in the prompt', text.includes('You held back from this chat for ~20 min'));
  }
} catch (err) {
  failures++;
  console.log(`  ✗ threw: ${err?.stack || err}`);
} finally {
  try { cap.resetCapCatchUpForTest(); } catch {}
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

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll cap catch-up checks passed');
process.exit(failures ? 1 : 0);
