import './utils/privateFiles.js';
import fs from 'node:fs';
import path from 'node:path';
import { downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { config, getPersona, getProviderKey } from './utils/config.js';
import { logger } from './utils/logger.js';
import { takeLock } from './utils/instanceLock.js';
import { bootVerdict, credsAreLinked, EXIT_NEEDS_PERSON } from './utils/bootCheck.js';
import { resolveRole } from './brain/roles.js';
import { PROVIDER_KEY_FIELD } from './brain/providers.js';
import { safePath } from './utils/pathGuard.js';
import { runMigrations, closeDb } from './memory/db.js';
import { connectToWhatsApp, disconnectFromWhatsApp, getSock } from './whatsapp/connection.js';
import { registerEventHandlers, setMessageProcessor, buildQuotedWAMessage, waitForMediaDescription, withChatLock } from './whatsapp/events.js';
import { sendText, sendReaction, sendImage, sendVoiceNote, sendSticker, sendGif, sendRecording, stopTyping, setPresence } from './whatsapp/actions.js';
import { decide } from './brain/decisionEngine.js';
import { generateResponse } from './brain/contextBuilder.js';
import { runWithPrefilter } from './brain/prefilter.js';
import { postProcess, maybeSplit, pickReactionEmoji, extractMentionTokens } from './brain/postProcess.js';
import { waitResponseDelay, simulateTyping, delayedReadReceipt, interMessagePause } from './behavior/timing.js';
import { checkWarmup, recordSent } from './behavior/warmup.js';
import { getDb } from './memory/db.js';
import { cleanExpiredMemories, decayMemories, pruneSuperseded, purgePerson } from './memory/relationshipStore.js';
import { resolveAudience } from './memory/recall.js';
import { identitiesOf } from './memory/identity.js';
import { syncAllGroups, markAllUnsynced, membershipGate, getMembership, isCurrentMember } from './memory/membership.js';
import { confirm as confirmRelay, expireStaleRelays } from './brain/relay.js';
import { evaluateResponse, recordQuality } from './brain/qualityGate.js';
import { getRecentMessagesForPrompt } from './memory/messageStore.js';
import { backfillOwnerGroupMarks } from './memory/groupStore.js';
import { flattenContent } from './utils/transcript.js';
import { loadSkills, runSkills, isSkillEnabled, skillWouldHandle } from './skills/skillRunner.js';
import { startMind, stopMind, budgetOk as mindBudgetOk, openIntentions as mindIntentions, personOptedOut as mindPersonOptedOut, stanceProvider as mindStanceProvider } from './mind/index.js';
import { startPublic, stopPublic } from './public/index.js';
import { getImitationTarget, loadImitationModes, recordImitationVoiceNote, resolveImitationVoice } from './behavior/imitationState.js';
import { listOrphanedVoices } from './memory/voiceStore.js';
import { removeVoice, retryPendingVoiceDeletes } from './brain/voiceClone.js';
import { buildImitationBundle, pickImitationReaction, imitationTypingFactor, getSpokenExemplars } from './personality/styleProfiler.js';
import { extractImageMarker, generateImage, editImage } from './brain/imageGen.js';
import { extractVoiceMarker, extractSingMarker, generateVoiceNote, SPEECH_TAG_RE } from './brain/voiceGen.js';
import { extractStickerMarker, extractGifMarker, searchGiphy } from './brain/mediaSearch.js';
import { closeBrowser } from './brain/webBrowse.js';
import { expireAllActiveBills, expireStaleBills } from './memory/billStore.js';
import { findPersonInGroupByName, findPersonInGroupByPhoneSuffix } from './memory/peopleStore.js';
import { phoneFromJid } from './utils/jidUtils.js';
import { isImageRequestForBot, isImageEditForBot, isBotMentioned } from './utils/mentions.js';
import { startDashboard } from './dashboard/server.js';
import { startCalls, stopCalls } from './calls/callManager.js';
import { startInstagram, stopInstagram, pruneInstagramData } from './instagram/index.js';
import { emitDashboardEvent } from './dashboard/events.js';
import { isGroupMuted, loadMutedGroups } from './dashboard/state.js';
import { checkRateLimit } from './behavior/rateLimiter.js';
import { getActiveFlow } from './behavior/activeFlows.js';
import {
  startLife, stopLife, isLifeOn, gateMessage as lifeGateMessage, enqueueDeferred, noteUnread, markSeenNow,
  settleCatchUp, lifeGuardNote, perceiveChat, perceiveInfluence, onReplySent, onConnect as lifeOnConnect, gateOutcome as lifeGateOutcome,
  inviteNote as lifeInviteNote,
  availabilityNow as lifeAvailabilityNow, inPhoneCheckNow as lifeInPhoneCheckNow,
  urgeFactor as lifeUrgeFactor,
} from './life/index.js';
// 014 real places: the ONE geo client (owner-click OSM lookups), handed to startLife.
import { createGeoClient } from './life/geo/client.js';
import { startCapCatchUp, stopCapCatchUp } from './behavior/capCatchUp.js';

logger.info({
  dryRun: config.dryRun,
  provider: config.llm.provider,
  model: config.llm.model,
}, `${getPersona().name} starting up...`);

// ── One copy per install, and nothing wrong that needs a person ──
// (Only a real start: a test imports this file with KARYASTHAN_NO_START=1.)
let verdict = {};
if (process.env.KARYASTHAN_NO_START !== '1') {
  const dataDir = path.dirname(safePath(config.dbPath));
  const lockedBy = takeLock(dataDir, 'bot');
  if (lockedBy) {
    console.error(`\n  Already running (pid ${lockedBy.pid}). Two copies on one session knock each other off WhatsApp.\n`);
    process.exit(EXIT_NEEDS_PERSON);
  }
  let linkedNow = false;
  try { linkedNow = credsAreLinked(fs.readFileSync(path.join(safePath(config.authPath), 'creds.json'), 'utf-8')); } catch { /* none yet */ }
  const mouthRole = resolveRole('mouth', config);
  verdict = bootVerdict({
    linked: linkedNow,
    tty: Boolean(process.stdout.isTTY),
    phone: config.phoneNumber,
    keyMissing: mouthRole.provider && PROVIDER_KEY_FIELD[mouthRole.provider] && !getProviderKey(mouthRole.provider) ? mouthRole.provider : '',
    dashboard: config.dashboard?.enabled,
  });
  if (verdict.stop) {
    console.error('');
    for (const line of verdict.stop) console.error(`  ${line}`);
    console.error('');
    process.exit(EXIT_NEEDS_PERSON);
  }
}

// ── Initialize database ──
runMigrations();

// ── Expire any ACTIVE bill splits from a previous session ──
try {
  const result = expireAllActiveBills();
  if (result.changes > 0) {
    logger.info({ count: result.changes }, 'Expired stale bill splits from previous session');
  }
} catch (err) {
  logger.debug({ err: err.message }, 'Failed to expire stale bills on startup (non-critical)');
}

// ── Periodic memory maintenance ──
// Destructive steps that depend on membership (retention purge, orphaned-voice
// removal) run only when this connection's latest full sync succeeded and every
// group it reconciled is still fresh (membershipGate) — so they never run in the
// startup pass (before the first sync) or while a sync is failing. A group gone
// stale since (a new sender, the bot removed) triggers one fresh sync first. Fail
// closed: still not fresh means "skip, try next time" (logged at warn).
const RETENTION_SEC = 30 * 24 * 3600;
const MAX_PURGES_PER_PASS = 20;

// R11 / FR-021: a leave logged for every group they were in (WhatsApp and the
// Instagram group), no current membership, and both the last leave and their last
// DM older than 30 days. People who were never in a shared group have no log rows
// and are never candidates.
function retentionCandidates(now = Math.floor(Date.now() / 1000)) {
  const cutoff = now - RETENTION_SEC;
  const db = getDb();
  const rows = db.prepare(`
    SELECT l.person_jid AS jid, MAX(l.at) AS last_leave FROM group_membership_log l
    WHERE l.action = 'leave'
      AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.person_jid = l.person_jid)
      AND NOT EXISTS (
        SELECT 1 FROM group_membership_log j
        WHERE j.person_jid = l.person_jid AND j.action = 'join'
          AND NOT EXISTS (SELECT 1 FROM group_membership_log x
            WHERE x.person_jid = j.person_jid AND x.group_jid = j.group_jid AND x.action = 'leave' AND x.at >= j.at))
    GROUP BY l.person_jid
    HAVING MAX(l.at) < ?`).all(cutoff);
  const lastDm = (forms) => db.prepare(`SELECT MAX(timestamp) FROM messages
    WHERE group_jid IN (${forms.map(() => '?').join(',')}) AND is_from_self = 0`).pluck().get(...forms);
  return rows.filter(r => {
    const forms = identitiesOf(r.jid);
    if (!forms.length) return false;
    const dm = lastDm(forms);
    return dm == null || dm < cutoff;
  }).map(r => r.jid);
}

function runRetentionPurge() {
  const candidates = retentionCandidates().slice(0, MAX_PURGES_PER_PASS);
  let deleted = 0;
  let voicePending = 0;
  for (const jid of candidates) {
    try {
      const res = purgePerson(jid, 'left all groups, 30 days silent');
      deleted += res.deleted;
      voicePending += res.voicePending || 0;
    } catch (err) {
      logger.warn({ err: err.message, personJid: jid }, 'Retention purge failed for one person');
    }
  }
  if (candidates.length) logger.info({ people: candidates.length, deleted }, 'Retention purge complete');
  // Their cloned voices were revoked by the purge; delete them at Google now.
  if (voicePending) retryPendingVoiceDeletes().catch(err => logger.warn({ err: err.message }, 'Pending voice delete retry failed'));
}

function skipGatedMaintenance(gate) {
  logger.warn({ reason: gate.reason, stale: gate.stale?.length || 0 },
    'Maintenance: membership not fresh — retention purge and orphaned-voice removal skipped');
}

function runMembershipGatedMaintenance() {
  try { runRetentionPurge(); } catch (err) {
    logger.warn({ err: err.message }, 'Retention purge error (non-critical)');
  }
  // Cloned voices of people who have left every group the bot is in are deleted.
  try {
    for (const v of listOrphanedVoices()) {
      removeVoice(v.person_jid, { reason: 'left all groups' }).catch(err =>
        logger.warn({ err: err.message, personJid: v.person_jid }, 'Orphaned voice removal failed'));
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'Orphaned voice check failed (non-critical)');
  }
}

function runMemoryMaintenance({ startup = false } = {}) {
  try {
    const expired = cleanExpiredMemories();
    const decayed = decayMemories();
    const pruned = pruneSuperseded();
    const staleBills = expireStaleBills(2 * 60 * 60); // 2 hours
    // Disappearing messages are deleted with the chat's timer (FTS via trigger).
    const expiredMsgs = getDb().prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < unixepoch()').run().changes;
    const relays = expireStaleRelays();
    if (expired > 0 || decayed.changes > 0 || pruned > 0 || staleBills.changes > 0 || expiredMsgs > 0 || relays > 0) {
      logger.info({ expired, decayed: decayed.changes, pruned, staleBills: staleBills.changes, expiredMsgs, relays }, 'Memory maintenance complete');
    }
  } catch (err) {
    logger.debug({ err }, 'Memory maintenance error (non-critical)');
  }
  if (startup) {
    logger.debug('Startup maintenance: retention purge and orphaned-voice removal skipped (membership not synced yet)');
  } else {
    const gate = membershipGate();
    const sock = gate.ok || !gate.stale ? null : getSock();
    if (gate.ok) runMembershipGatedMaintenance();
    else if (sock) {
      syncAllGroups(sock).then(() => {
        const again = membershipGate();
        if (again.ok) runMembershipGatedMaintenance();
        else skipGatedMaintenance(again);
      }).catch(err => logger.warn({ err: err.message }, 'Maintenance: membership re-sync failed — gated steps skipped'));
    } else skipGatedMaintenance(gate);
  }
  try { pruneInstagramData(); } catch (err) {
    logger.debug({ err: err.message }, 'Instagram data prune failed (non-critical)');
  }
  // Revoked cloned voices whose delete at Google failed earlier (not membership-gated:
  // they are revoked already, this only finishes the delete).
  if (!startup) {
    retryPendingVoiceDeletes().catch(err => logger.debug({ err: err.message }, 'Pending voice delete retry failed (non-critical)'));
  }
}
runMemoryMaintenance({ startup: true }); // once on startup (no membership-gated steps)
setInterval(runMemoryMaintenance, 6 * 60 * 60 * 1000); // then every 6 hours

// ── Outcome narrative ───────────────────────────────────────────────────────
// One human-readable line per evaluated message saying what the bot did and why.
// `evt` drives the dashboard live-log category tag (reply | react | skip | block);
// the sentence reads naturally in plain stdout/journald too. Structured fields
// (score, factors, reason, group, msgId) ride along so the dashboard can render the
// "why" without dumping raw JSON. Emitted at info so every decision is visible by
// default on the live-logs page.
function logOutcome(evt, sentence, fields = {}) {
  logger.info({ evt, ...fields }, sentence);
}

// ── Life simulation (spec 009) ──────────────────────────────────────────────
// While the `life` skill runs, an availability gate decides per message whether
// he answers now, sneaks a look, defers it to his next phone check, just reacts
// or leaves it unread — and his phone (src/life/phone.js) owns read receipts and
// presence. Every life call here FAILS OPEN: an exception is logged and the
// message is handled exactly as with life off (never dropped, never blocked).
// Calls are exempt (src/calls never passes through this gate).

/** Run a life hook; on any exception log it and return `fallback`. */
function lifeSafe(fn, fallback, what) {
  try {
    const out = fn();
    if (out && typeof out.catch === 'function') {
      return out.catch(err => {
        logger.warn({ evt: 'issue', err: err?.message, what }, `life: ${what} failed (ignored)`);
        return fallback;
      });
    }
    return out;
  } catch (err) {
    logger.warn({ evt: 'issue', err: err?.message, what }, `life: ${what} failed — continuing as with life off`);
    return fallback;
  }
}

/** Is this group message aimed at him (@-mention of his own JID/LID, his name/alias, or a reply to him)? */
function isMentionForLife(msg, context) {
  if (isBotMentioned(msg, context, { logTag: 'life gate' })) return true;
  if (!msg.quotedId) return false;
  const row = getDb().prepare('SELECT is_from_self FROM messages WHERE id = ? AND group_jid = ?').get(msg.quotedId, msg.groupJid);
  return row?.is_from_self === 1;
}

function untilText(unix) {
  if (!Number.isFinite(unix)) return '';
  try {
    return ` till ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone || 'UTC' }).format(new Date(unix * 1000))}`;
  } catch {
    return '';
  }
}

/**
 * The availability gate for one live (not catch-up) turn, after the mute check
 * and before imitation/skills/decide(). → { done } (the turn ends here: deferred,
 * ignored or reacted to) or { done:false, gate } (now/sneak: context.availability
 * set for decide(); queued items of this chat become context.catchUp; gate null
 * when life failed and the turn runs as with life off).
 */
async function applyLifeGate(sock, msg, context, turn, turnStale, onVerdict = null) {
  const chatJid = msg.groupJid;
  const rawKey = context.rawMsg?.key || null;
  // 012: told the verdict once, synchronously, as soon as it is known (before any
  // await below), so a perception starts at the same moment it did pre-gate.
  let told = false;
  const tell = (verdict) => {
    if (told || typeof onVerdict !== 'function') return;
    told = true;
    try { onVerdict(verdict); } catch { /* never breaks the gate */ }
  };
  const failOpen = (what, err) => {
    turn.lifeGateVerdict = 'error';   // 012: a failed gate drops what he perceived (fail closed)
    tell('error');
    logger.warn({ evt: 'issue', err: err?.message, what, msgId: msg.id, group: chatJid },
      'life gate failed — handling the message as with life off');
    if (rawKey) delayedReadReceipt(sock, rawKey);
    return { done: false, gate: null };
  };

  let gate;
  let features;
  try {
    const isGroup = !!context.isGroup;
    features = {
      isDm: !!context.isDm,
      isGroup,
      isMention: isGroup && isMentionForLife(msg, context),
      isQuestion: typeof msg.content === 'string' && msg.content.includes('?'),
      // A running skill flow, or a DM relay being confirmed this turn (it expires in
      // minutes and a drained reply carries no relay — it would promise one it can't make),
      // or a message a skill would claim (a drained turn has no raw message for it).
      hasActiveFlow: (isGroup && !!getActiveFlow(chatJid)) || !!context.relay || !!skillWouldHandle(msg, context),
    };
    gate = lifeGateMessage(msg, features);
  } catch (err) {
    return failOpen('gate', err);
  }
  if (!gate || typeof gate.outcome !== 'string') return failOpen('gate', new Error('no outcome'));
  turn.lifeGateVerdict = gate.outcome;
  tell(gate.outcome);

  const where = `${gate.state || 'away'}${untilText(gate.until)}`;
  const why = {
    msgId: msg.id, group: chatJid, sender: msg.senderName,
    reason: `life:${gate.outcome}:${gate.reason}`, availability: gate.state, until: gate.until ?? null,
  };

  if (gate.outcome === 'defer') {
    let item = null;
    try { item = enqueueDeferred(msg, features, rawKey); } catch (err) { return failOpen('enqueue', err); }
    if (!item) return failOpen('enqueue', new Error('not queued'));
    logOutcome('skip', `Deferred — he's ${where}; answered at his next phone check`, why);
    return { done: true };
  }

  if (gate.outcome === 'ignore' || gate.outcome === 'react') {
    if (rawKey && !lifeSafe(() => noteUnread(chatJid, rawKey), false, 'noteUnread')) {
      // Not remembered for his next check → read it the pre-life way.
      delayedReadReceipt(sock, rawKey);
    }
    if (gate.outcome === 'ignore') {
      logOutcome('skip', `Left unread — he's ${where}`, why);
      return { done: true };
    }
    const rate = checkRateLimit(chatJid);
    const warm = checkWarmup('reaction');
    if (!rate.allowed || !warm.allowed) {
      logOutcome('block', `Suppressed — glanced at his phone but ${!rate.allowed ? rate.reason : warm.reason}`, why);
      return { done: true };
    }
    try {
      await waitResponseDelay({ isDm: context.isDm }, { availabilityDelayMs: gate.delayHintMs });
      if (turnStale('reaction')) return { done: true };
      const emoji = pickReactionEmoji(msg.content);
      await sendReaction(sock, chatJid, msg.id, emoji, msg.senderJid);
      recordSent();
      logOutcome('react', `Reacted ${emoji} — glanced at his phone (${where})`, { ...why, emoji });
    } catch (err) {
      logger.warn({ err: err?.message, msgId: msg.id }, 'life: glance reaction failed');
    }
    return { done: true };
  }

  if (gate.outcome !== 'now' && gate.outcome !== 'sneak') return failOpen('gate', new Error(`unknown outcome ${gate.outcome}`));
  context.availability = { state: gate.state, outcome: gate.outcome, scoreFactor: gate.scoreFactor };
  // He's looking at this chat: read it now. Messages he had queued here ride along
  // as a catch-up, settled once this turn's reply was sent.
  // Capped: a hung socket must not hold the reply (on timeout the next phone check
  // answers anything queued here).
  try {
    let timer;
    const seen = await Promise.race([
      markSeenNow(sock, chatJid, rawKey),
      new Promise((resolve) => { timer = setTimeout(resolve, 5000, null); }),
    ]).finally(() => clearTimeout(timer));
    if (seen === null) logger.warn({ evt: 'issue', msgId: msg.id, group: chatJid }, 'life: markSeenNow timed out — replying without the catch-up');
    if (seen?.catchUp && !context.catchUp) {
      context.catchUp = seen.catchUp;
      turn.lifeCatchUp = seen.catchUp;
    }
  } catch (err) {
    logger.warn({ evt: 'issue', err: err?.message, msgId: msg.id }, 'life: markSeenNow failed — read receipt the pre-life way');
    if (rawKey) delayedReadReceipt(sock, rawKey);
  }
  if (gate.outcome === 'sneak') logger.info({ msgId: msg.id, group: chatJid, availability: gate.state }, `Sneaking a look at his phone (${where})`);
  return { done: false, gate };
}

/** A reply went out: settle the queue rows it covered and run the claim hook (both fire-and-forget). */
function lifeAfterReply(msg, context, turn, text, sentMessageId) {
  // A drained turn (phone check): its rows are answered as soon as the reply is
  // out — a restart before the phone marks them would answer them twice.
  if (!turn.lifeCatchUp && context.catchUp && !turn.catchUpSettled) {
    turn.catchUpSettled = true;
    lifeSafe(() => settleCatchUp(context.catchUp), 0, 'settleCatchUp');
  }
  if (turn.lifeCatchUp) {
    const c = turn.lifeCatchUp;
    turn.lifeCatchUp = null;
    lifeSafe(() => settleCatchUp(c), 0, 'settleCatchUp');
  }
  if (turn.lifeOn && typeof text === 'string' && text.trim()) {
    lifeSafe(() => onReplySent({
      chatJid: msg.groupJid, text, triggerText: typeof msg.content === 'string' ? msg.content : '', msgId: sentMessageId || null,
      // 012: is this really his answer to an invitation? (not imitated, not a follow-up, really sent)
      triggerMsgId: msg.id, imitating: !!context.imitation, followUp: !!context.followUp, dryRun: !!config.dryRun,
    }), null, 'onReplySent');
  }
}

// His phone drains a chat's queue through the same per-chat lock as live turns
// (events.js withChatLock). phone.js calls withChatLock(chat, () => processMessage(…))
// without passing the lock's { turnSignal } on, so it is handed over here: fn runs
// synchronously into lifeDrainProcess, which picks the signal up.
let drainSignal = null;
function lifeDrainLock(chatJid, fn) {
  return withChatLock(chatJid, (lockCtx) => {
    drainSignal = lockCtx?.turnSignal ?? null;
    try { return fn(lockCtx); } finally { drainSignal = null; }
  });
}
function lifeDrainProcess(sock, msg, ctx = {}) {
  // A drained turn carries no bot identity (mentions need it) and no raw message
  // (receipts were sent by the phone; the image-edit branch stays inert).
  return processMessage(sock, msg, {
    botJid: sock?.user?.id, botLid: sock?.user?.lid, ...ctx, turnSignal: ctx.turnSignal ?? drainSignal ?? undefined,
  });
}
// An unsynced group has no member list yet: don't drop its queued items as "left".
function lifeIsMember(groupJid, personJid) {
  const m = getMembership(groupJid);
  return m.members.size === 0 ? true : isCurrentMember(groupJid, personJid);
}

// The quality gate's note on a follow-up turn: it answers an older line on purpose.
const FOLLOW_UP_GATE_NOTE = 'This message gets back to someone about a plan they made with him (their line is the first one shown), so it may be off the current topic on purpose. Do not mark it down for that.';

// ── Message processing pipeline ──
// Learning is not driven from here: events.js counts every stored message
// (learningPipeline.onIngest) and batch analysis runs from there.
//
// A DM turn may carry a pending relay (context.relay, set by events.js from
// relay.prepare). However the turn ends, it is settled exactly once: confirmed
// only when the reply that was actually sent carried [RELAY_OK] and the turn
// wasn't stale; declined otherwise.
async function processMessage(sock, msg, context) {
  const turn = { relayOk: false, sentMessageId: null, replied: false, lifeOn: false, lifeCatchUp: null };
  try {
    return await processTurn(sock, msg, context, turn);
  } finally {
    if (context.relay?.relayId) {
      confirmRelay(context.relay.relayId, {
        relayOk: turn.relayOk && turn.replied,
        sentMessageId: turn.sentMessageId,
        stale: !!context.turnSignal?.aborted,
        sock,
      });
    }
  }
}

async function processTurn(sock, msg, context, turn) {
  const startTime = Date.now();

  // Life (spec 009): read once per turn. A catch-up turn (context.catchUp, from a
  // phone-check drain) was learned from, perceived and gated when it arrived, and
  // the phone has read it already; it also carries no rawMsg after a restart.
  const lifeOn = lifeSafe(() => isLifeOn(), false, 'isLifeOn') === true;
  turn.lifeOn = lifeOn;
  const catchUpTurn = !!context.catchUp;

  // 3. Delayed read receipt — while life runs, his phone owns receipts.
  if (!lifeOn && context.rawMsg?.key) {
    delayedReadReceipt(sock, context.rawMsg.key);
  }

  // 3.4. Muted groups: skip response pipeline entirely. Learning + read
  // receipts still happen — we observe but stay silent (with life on, the
  // message is read at his next phone check).
  if (context.isGroup && msg.groupJid && isGroupMuted(msg.groupJid)) {
    if (lifeOn && context.rawMsg?.key && !lifeSafe(() => noteUnread(msg.groupJid, context.rawMsg.key), false, 'noteUnread')) {
      delayedReadReceipt(sock, context.rawMsg.key);
    }
    logOutcome('block', 'Suppressed — group is muted', { msgId: msg.id, group: msg.groupJid, reason: 'group muted' });
    return;
  }

  // Who will see this turn's output — resolved once; every remembered thing in the
  // prompt (life lines included) is read through recall.js for this audience.
  context.audience = resolveAudience({ chatJid: msg.groupJid });

  // Stale-turn guard: events.js aborts context.turnSignal when this turn has overrun
  // the in-flight safety timeout AND a new turn for the chat has started. Checked
  // before every outbound send so the stale turn can never double-reply.
  let staleLogged = false;
  const turnStale = (what) => {
    // A follow-up about a plan: what it says must still be true at the send (the plan may have come back).
    let gone = false;
    if (context.followUp?.stillApplies) {
      try { gone = context.followUp.stillApplies() !== true; } catch { gone = true; }
    }
    if (!context.turnSignal?.aborted && !gone) return false;
    if (!staleLogged) {
      staleLogged = true;
      logOutcome('block', gone ? `Dropped — the plan changed before sending (${what})` : `Dropped — turn went stale before sending (${what})`,
        { msgId: msg.id, group: msg.groupJid, reason: gone ? 'plan_changed' : 'turn_stale' });
    }
    return true;
  };
  // Did a send of this turn actually go out? A send helper returns null on a socket
  // error (and by design under DRY_RUN, which counts as sent). Only a delivered reply
  // counts as replied: relay confirmation, life's catch-up settle and claims follow it.
  let delivered = false;
  const sentOk = (result) => {
    if (!result && !config.dryRun) return false;
    delivered = true;
    return true;
  };

  // 3.42. Life availability gate (after mute, before imitation/skills/decide).
  // Chat may nudge his open decisions (code matcher only; fire-and-forget).
  // 012: the chat-influence perception starts once the gate has its verdict
  // (synchronous, before the gate's awaits): a Jev call only when he reads the
  // message now or at his next phone check — never on ignore/react/a failed gate.
  let lifeGate = null;
  if (lifeOn && !catchUpTurn) {
    const perceiveCtx = { botJid: context.botJid, botLid: context.botLid, burstIds: context.burstIds };
    lifeSafe(() => perceiveChat(msg, context.audience, { ...perceiveCtx, influence: false }), null, 'perceiveChat');
    const gated = await applyLifeGate(sock, msg, context, turn, turnStale,
      (verdict) => lifeSafe(() => perceiveInfluence(msg, context.audience, perceiveCtx, verdict), null, 'perceiveInfluence'));
    // 012: what he perceived in this message lands only if he read it now.
    lifeSafe(() => lifeGateOutcome(msg.groupJid, msg.id, turn.lifeGateVerdict ?? 'error'), null, 'gateOutcome');
    if (gated.done) return;
    lifeGate = gated.gate;
  }
  const sneak = lifeGate?.outcome === 'sneak';

  // 3.45. Imitate mode: resolve this group's active target (dashboard-driven,
  // persisted in group_imitation) into a style bundle for the whole turn.
  // Hard-gated to groups — the DM path never consults the mode, so the bot can
  // never wear person A's voice while DMing person B. getImitationTarget lazily
  // expires the cutoff and auto-clears targets who left the group. When the
  // target themselves is the speaker, the bot still plays them — as their double
  // (they own the persona and can ask for e.g. a voice note in their own voice).
  let imitation = null;
  if (context.isGroup && !context.isDm && isSkillEnabled('imitate')) {
    const target = getImitationTarget(msg.groupJid);
    if (target) {
      try {
        imitation = buildImitationBundle(msg.groupJid, target.targetJid, target.label, { topicHint: msg.content });
        if (imitation) {
          imitation.enabledAt = target.enabledAt || null;
          imitation.speakerIsTarget = target.targetJid === msg.senderJid;
        }
        // Imitate VOICE: the target's cloned voice, when every gate allows it.
        const cloned = imitation ? resolveImitationVoice(target) : null;
        if (cloned) imitation.voice = { ...cloned, spokenExemplars: getSpokenExemplars(target.targetJid, 6, msg.groupJid) };
      } catch (err) {
        logger.warn({ err: err.message, group: msg.groupJid }, 'Imitation bundle build failed — responding as base persona');
      }
    }
  } else if (context.isGroup && !context.isDm && !isSkillEnabled('imitate') && getImitationTarget(msg.groupJid)) {
    // A target is set but the master skill is off (e.g. reset by a restart with
    // IMITATE_MODE_ENABLED=false) — say so instead of going silently inert.
    logger.info({ group: msg.groupJid }, 'Imitation target set but the imitate skill is OFF — responding as base persona');
  }
  context.imitation = imitation;

  // Reaction picker: while imitating, prefer the target's own top emojis.
  const pickEmoji = (content) =>
    (imitation && pickImitationReaction(imitation.styleCard)) || pickReactionEmoji(content);

  // 3.5. Skills intercept (bypasses decision engine + LLM if matched)
  // A follow-up reprocesses an old line of theirs to tell them about a plan: no skill may take that line.
  const skillResult = context.followUp ? { handled: false } : await runSkills(sock, msg, context);
  if (skillResult.handled) return;

  // 4. Decision engine. Urge is a 0–1 factor from the life facade (0 when life is off).
  // The engine does not import life. Groups record it; a flirtatious DM may bump.
  try { context.urge = isLifeOn() ? lifeUrgeFactor() : 0; } catch { context.urge = 0; }
  const decision = decide(msg, context);

  // 4.5. Edit-replied-image branch — direct path, bypasses LLM.
  // A text reply to an image becomes an edit only when it is aimed at the bot — a DM,
  // or mention factor ≥ 5 (@-mention, name/alias, or a reply to the bot's own image) —
  // and, like an image ask, only over a plain probability skip (never a rate-limit /
  // burst-cooldown guard) with warmup allowing text (isImageEditForBot).
  const mentionFactor = decision.factors?.mention ?? 0;
  const quotedIsImage = msg.quotedMessageType === 'image' && !!msg.quotedRawMessage;
  const editIntentAllowed = quotedIsImage && !context.followUp && isImageEditForBot({
    isDm: context.isDm, mentionFactor, decision, warmup: checkWarmup('text'),
  });

  if (quotedIsImage) {
    logger.debug({
      msgId: msg.id,
      isDm: context.isDm,
      mentionFactor,
      editIntentAllowed,
      imageGenEnabled: config.imageGen.enabled,
    }, 'Quoted image detected on incoming message');
  }

  if (editIntentAllowed && config.imageGen.enabled) {
    const editPrompt = (msg.content || '').replace(/@\S+/g, '').trim();
    if (editPrompt) {
      const quotedWAMsg = buildQuotedWAMessage(msg);
      if (quotedWAMsg) {
        logger.info({ msgId: msg.id, isDm: context.isDm, prompt: editPrompt.slice(0, 80) }, 'Image edit request detected');
        try {
          if (turnStale('image edit')) return;
          await simulateTyping(sock, msg.groupJid, 400);
          const buffer = await downloadMediaMessage(quotedWAMsg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });
          if (!buffer || !buffer.length) {
            logger.warn({ msgId: msg.id }, 'Quoted image downloaded as empty buffer');
          } else {
            const mimeType = (msg.quotedRawMessage.imageMessage?.mimetype || 'image/jpeg').split(';')[0];
            logger.debug({ msgId: msg.id, bufferSize: buffer.length, mimeType }, 'Quoted image downloaded');
            const edited = await editImage(buffer, mimeType, editPrompt);
            if (edited) {
              if (turnStale('image edit')) return;
              if (!sentOk(await sendImage(sock, msg.groupJid, edited.buffer, '', context))) {
                logOutcome('block', 'Send failed — the edited image did not go out', { msgId: msg.id, group: msg.groupJid, reason: 'send_failed' });
                return;
              }
              recordSent();
              turn.replied = true;
              lifeAfterReply(msg, context, turn, null, null);
              logger.info({ msgId: msg.id }, 'Image edit response sent');
              return;
            }
            logger.warn({ msgId: msg.id }, 'Image edit returned null, falling through to normal flow');
          }
        } catch (err) {
          logger.warn({ err: err.message, msgId: msg.id }, 'Image edit failed, falling through');
        }
      } else {
        logger.warn({ msgId: msg.id, hasQuotedId: !!msg.quotedId, hasParticipant: !!msg.quotedParticipant }, 'buildQuotedWAMessage returned null despite quoted image');
      }
    } else {
      logger.debug({ msgId: msg.id }, 'Quoted image but empty edit prompt after stripping mentions');
    }
  }

  // Explicit image request aimed at the bot: an image verb + noun ("send me a meme
  // pic", "draw me a cat") AND directed — a DM, or mention factor ≥ 5 (its own
  // @JID/LID, name/alias, or a reply to the bot). A bare "imagine if…" or someone
  // asking the group for a pic is not one.
  const isDirected = context.isDm || (decision.factors?.mention ?? 0) >= 5.0;
  // (Not on a follow-up: that line is only what the turn answers, the note says what it is for.)
  const isImageAsk = !context.followUp && isImageRequestForBot(msg.content, { directed: isDirected });
  // It may only override a plain probability skip — never a hard skip or a
  // rate-limit / burst-cooldown guard.
  const skipReason = decision.shouldRespond ? null : (decision.factors.skipReason || 'unknown');
  const imageOverride = isImageAsk && (decision.shouldRespond
    ? decision.responseType === 'reaction'
    : skipReason === 'probability');

  // Log the decision — its final outcome: an image override turns a skip/reaction into
  // a text turn, so it is logged as 'text' with factors.imageOverride (the engine's own
  // verdict stays readable in factors: skipReason / finalScore).
  const loggedType = imageOverride ? 'text' : decision.responseType;
  const loggedFactors = imageOverride ? { ...decision.factors, imageOverride: true } : decision.factors;
  try {
    getDb().prepare(
      `INSERT INTO response_log (message_id, group_jid, score, decided, factors_json, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())`
    ).run(msg.id, msg.groupJid, decision.score, loggedType, JSON.stringify(loggedFactors));
  } catch (err) {
    logger.debug({ err: err.message, msgId: msg.id }, 'Failed to write decision to response_log (non-critical)');
  }

  emitDashboardEvent('decision', {
    messageId: msg.id,
    groupJid: msg.groupJid,
    senderName: msg.senderName,
    content: msg.content?.slice(0, 200),
    score: decision.score,
    decided: loggedType,
    shouldRespond: decision.shouldRespond || imageOverride,
    factors: loggedFactors,
  });

  if (!decision.shouldRespond && !imageOverride) {
    const reason = skipReason;
    const isGuard = reason.startsWith('rate_limited') || reason === 'burst_cooldown';
    let sentence;
    if (reason === 'burst_cooldown') sentence = 'Suppressed — burst cooldown (replying too fast)';
    else if (reason.startsWith('rate_limited')) sentence = `Suppressed — rate-limited (${reason.replace('rate_limited: ', '')})`;
    else if (reason === 'probability') sentence = "Stayed silent — message didn't clear the response bar";
    else sentence = `Stayed silent — ${reason}`;
    logOutcome(isGuard ? 'block' : 'skip', sentence, {
      msgId: msg.id,
      group: msg.groupJid,
      sender: msg.senderName,
      score: decision.factors.finalScore ?? decision.score,
      factors: decision.factors,
      reason,
    });
    return;
  }

  // 5. Check warm-up constraints. An image override turns a skip/reaction into a
  // text turn, so it is checked as 'text' — warmup's text block still applies.
  const intendedType = imageOverride ? 'text' : decision.responseType;
  const warmup = checkWarmup(intendedType);
  if (!warmup.allowed) {
    logOutcome('block', `Suppressed — ${warmup.reason}`, { msgId: msg.id, group: msg.groupJid, reason: warmup.reason });
    return;
  }
  // checkWarmup may downgrade (e.g. text_and_reaction → reaction on a reactions-only day).
  const responseType = warmup.responseType || intendedType;
  const warmupAllowsText = responseType !== 'reaction';

  // 6. Handle reaction-only responses
  if (responseType === 'reaction') {
    const emoji = pickEmoji(msg.content);
    await waitResponseDelay({ isDm: context.isDm }, {
      availabilityDelayMs: lifeGate?.delayHintMs || 0, catchUp: catchUpTurn || !!turn.lifeCatchUp,
    });
    if (turnStale('reaction')) return;
    await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
    recordSent();
    logOutcome('react', `Reacted ${emoji} to ${msg.senderName || 'someone'}`, {
      msgId: msg.id, group: msg.groupJid, sender: msg.senderName, emoji, score: decision.score, factors: decision.factors,
    });
    return;
  }

  // 7. Generate LLM response (a web search/browse loop may run inside, so time it
  //    and credit that time against the response delay below).
  const genStart = Date.now();

  // Image triggers: wait briefly for the async media description to land in the DB.
  // Otherwise the transcript's trigger line is just the caption (often a bare link)
  // and the LLM anchors on older chat instead of what the image is about. Timed from
  // genStart so the wait is credited against the human-like response delay below.
  if (msg.messageType === 'image') {
    const landed = await waitForMediaDescription(msg.id, 10_000);
    if (!landed) {
      logger.debug({ msgId: msg.id }, 'Image description not ready — generating with caption only');
    }
  }

  // 7.0a. Chat influence (spec 012): an invitation in this message (or, on a
  // catch-up, among its queued triggers) gets one per-turn line. A live turn waits
  // ≤ CHAT_INFLUENCE_INVITE_WAIT_MS from its start for the decision to open; '' while off.
  if (lifeOn && !context.followUp) {
    const note = await lifeSafe(() => lifeInviteNote(msg.groupJid, msg.id, context.audience, {
      startedAt: startTime, catchUp: context.catchUp ?? null, imitating: !!imitation,
    }), '', 'inviteNote');
    if (typeof note === 'string' && note) (context.promptNotes ||= []).push(note);
  }

  // 7.0. Jev pre-filter (spec 007 R9; skill `jev-prefilter`). Shadow: Jev runs in
  // parallel and only logs. Enforce: a confident "stay silent" skips generation.
  // Mentions, DMs, imitation, image asks, follow-ups and cap catch-ups are never pre-filtered.
  // Life: this turn's situation for the prompt (life lines, catch-up note, sneak
  // bar). Also passed on a catch-up drained after life was switched off.
  const lifeOpt = (lifeGate || context.catchUp)
    ? { sneak, availability: lifeGate?.state ?? null, catchUp: context.catchUp || null }
    : undefined;
  const pre = await runWithPrefilter(
    { msg, context, decision, turn: { responseType, imageAsk: isImageAsk || imageOverride } },
    () => generateResponse(msg, context, { sock, promptNotes: context.promptNotes, ...(lifeOpt ? { life: lifeOpt } : {}) }),
  );
  if (pre.skipped) {
    logOutcome('skip', 'Stayed silent — prefilter', {
      msgId: msg.id, group: msg.groupJid, reason: 'prefilter_skip', pReply: pre.info.pReply, skipBelow: pre.info.skipBelow,
    });
    return;
  }
  let llmResult = pre.result;
  turn.relayOk = !!llmResult?.relayOk;
  const genMs = Date.now() - genStart;

  // 7a. Fallback: if the LLM skipped an explicit image request aimed at the bot,
  // generate directly (only when warmup allows text).
  if (!llmResult && isImageAsk && warmupAllowsText && config.imageGen.enabled) {
    const prompt = msg.content.replace(/@\S+/g, '').trim();
    logger.info({ msgId: msg.id, prompt: prompt.slice(0, 80) }, 'LLM skipped image request, generating directly');
    if (turnStale('image')) return;
    await simulateTyping(sock, msg.groupJid, 200);
    const image = await generateImage(prompt);
    if (image) {
      if (turnStale('image')) return;
      if (!sentOk(await sendImage(sock, msg.groupJid, image.buffer, '', context))) {
        logOutcome('block', 'Send failed — the image did not go out', { msgId: msg.id, group: msg.groupJid, reason: 'send_failed' });
        return;
      }
      recordSent();
      turn.replied = true;
      lifeAfterReply(msg, context, turn, null, null);
      return;
    }
  }

  if (!llmResult) {
    // LLM chose to skip ([SKIP]) or generation failed — either way the bot stays
    // silent. Any failure detail is logged separately in llm.js as an `issue`.
    logOutcome('skip', 'Stayed silent — model declined or generation failed', { msgId: msg.id, group: msg.groupJid });
    // maybe still react (never on a follow-up: a 🔥 on an invitation he can't make reads as a yes)
    if (!context.followUp && Math.random() < 0.1 && msg.content && !turnStale('reaction')) {
      const emoji = pickEmoji(msg.content);
      await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
    }
    return;
  }

  // 7.5. Check for image generation marker
  const imageRequest = extractImageMarker(llmResult.text);

  // 7.6. Check for sticker/GIF markers (mutually exclusive — sticker wins)
  const afterImage = imageRequest ? imageRequest.caption : llmResult.text;
  const stickerRequest = extractStickerMarker(afterImage);
  const afterSticker = stickerRequest ? stickerRequest.caption : afterImage;
  const gifRequest = !stickerRequest ? extractGifMarker(afterSticker) : null;
  const afterGif = gifRequest ? gifRequest.caption : afterSticker;

  // 7.7. Check for voice/sing note marker. While imitating, voice notes are only
  // allowed in the target's own enrolled (cloned) voice — the base persona's TTS
  // voice would instantly break the imitation — and singing stays off. Any stray
  // marker text is stripped by postProcess below.
  const singRequest = imitation ? null : extractSingMarker(afterGif);
  const voiceRequest = singRequest || ((!imitation || imitation.voice) ? extractVoiceMarker(afterGif) : null);
  const clonedVoiceId = (imitation && voiceRequest) ? imitation.voice.voiceId : null;
  const isSing = !!singRequest;

  // 8. Post-process (with fixation safety net)
  const textToProcess = voiceRequest
    ? voiceRequest.caption
    : stickerRequest
      ? stickerRequest.caption
      : gifRequest
        ? gifRequest.caption
        : (imageRequest ? imageRequest.caption : llmResult.text);

  // Resolver for @-mention tokens emitted by the LLM (e.g. "@Rohith" or "@5432").
  // Only wired up for groups — DMs don't need tagging.
  const lookupPersonByToken = (token) => {
    const t = String(token || '').trim();
    if (!t) return null;
    // Pure-digit token → phone suffix match; otherwise name match.
    const digitsOnly = t.replace(/\D/g, '');
    if (digitsOnly && digitsOnly.length >= 4 && /^\+?\d+$/.test(t)) {
      return findPersonInGroupByPhoneSuffix(msg.groupJid, digitsOnly);
    }
    return findPersonInGroupByName(msg.groupJid, t);
  };

  // Most group members are stored under LID JIDs (WhatsApp's anonymized ids), and a
  // LID userpart in message text renders as a raw 15-digit number, not a tappable
  // mention. Pre-resolve each mentioned person's LID → phone JID via Baileys here,
  // because that lookup is async and the resolver below must stay sync for postProcess.
  const lidToPn = new Map();
  if (context.isGroup && textToProcess) {
    for (const token of extractMentionTokens(textToProcess)) {
      const hit = lookupPersonByToken(token);
      if (hit?.jid?.endsWith('@lid') && !lidToPn.has(hit.jid)) {
        let pn = null;
        try {
          const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(hit.jid);
          if (mapped) pn = jidNormalizedUser(mapped); // strip the :device suffix
        } catch (err) {
          logger.debug({ err: err.message, lid: hit.jid }, 'LID → PN mention lookup failed');
        }
        lidToPn.set(hit.jid, pn);
      }
    }
  }

  const peopleResolver = (token) => {
    if (!context.isGroup) return null;
    const hit = lookupPersonByToken(token);
    if (!hit) return null;
    let jid = hit.jid;
    if (jid.endsWith('@lid')) {
      const pn = lidToPn.get(jid);
      if (pn) {
        jid = pn; // tappable: text becomes @<phone-digits>, phone JID goes in mentions
      } else {
        // No phone mapping known — digits would show up as a raw LID number in chat.
        // Fall back to the person's name: not tappable, but reads naturally.
        const name = (hit.push_name || hit.real_name || '').trim().split(/\s+/)[0];
        return name ? { jid: hit.jid, displayText: name } : null;
      }
    }
    // WhatsApp only renders a tappable mention when the literal text is `@<userpart-of-JID>`.
    // Clients map the digits to the saved contact name on the receiver's side.
    const userpart = phoneFromJid(jid);
    const display = /^\d{5,}$/.test(userpart || '') ? userpart : String(token).trim();
    return { jid, displayText: display };
  };

  const processed = textToProcess
    ? postProcess(textToProcess, llmResult.fixatedWords, { isGroup: context.isGroup, peopleResolver, imitate: !!imitation, ...(sneak ? { sneak } : {}) })
    : null;
  // `processed` is { text, replyToId, mentions } when opts is provided, or null if text stripped to nothing.
  const processedText = processed?.text || null;
  const processedReplyToId = processed?.replyToId || null;
  const processedMentions = processed?.mentions || [];

  if (!imageRequest && !voiceRequest && !stickerRequest && !gifRequest && !processedText) {
    logOutcome('skip', 'Stayed silent — response was emptied by cleanup', { msgId: msg.id, group: msg.groupJid });
    return;
  }

  // Resolve [REPLY:<suffix>] to a concrete message id in this chat (suffix match on id).
  let replyQuoteKey = null;
  if (processedReplyToId && context.isGroup) {
    try {
      const row = getDb().prepare(
        `SELECT id FROM messages WHERE group_jid = ? AND id LIKE ? ORDER BY timestamp DESC LIMIT 1`
      ).get(msg.groupJid, `%${processedReplyToId}`);
      if (row?.id) replyQuoteKey = { id: row.id };
    } catch (err) {
      logger.debug({ err: err.message, msgId: msg.id }, 'Reply-target resolution failed (non-critical)');
    }
  }

  // 8.5. Quality gate — LLM-as-judge before sending (skip for image/voice/sticker/gif
  // responses). A voice note in someone's CLONED voice is the most convincing thing
  // the bot can send, so it is always gated — on the words it will speak.
  const isMention = decision.factors.mention >= 5.0;
  const gateClonedVoice = !!clonedVoiceId;
  if (!imageRequest && (!voiceRequest || gateClonedVoice) && !stickerRequest && !gifRequest && context.isGroup) {
    const gateLines = getRecentMessagesForPrompt(msg.groupJid, 5)
      .filter(m => !m.is_from_self)
      .slice(-5);
    // A follow-up answers an older line: the judge sees it, or a group that moved on reads the reply as off topic.
    if (context.followUp && !gateLines.some(m => m.id === msg.id)) {
      gateLines.unshift({ id: msg.id, sender_name: msg.senderName, content: msg.content, message_type: msg.messageType });
    }
    const recentForGate = gateLines
      .map(m => `[${m.sender_name || 'Unknown'}]: ${flattenContent(m.content, m.message_type)}`)
      .join('\n');

    const gateText = gateClonedVoice
      ? [voiceRequest.text.replace(SPEECH_TAG_RE, ''), processedText].filter(Boolean).join('\n')
      : processedText;
    // Life: a sneak turn uses the mention threshold; a heavy-event embargo adds its note.
    const lifeNote = lifeOn ? lifeSafe(() => lifeGuardNote(), null, 'lifeGuardNote') : null;
    const guardNote = [context.followUp ? FOLLOW_UP_GATE_NOTE : null, lifeNote].filter(Boolean).join(' ') || null;
    const gateResult = await evaluateResponse(gateText, recentForGate, {
      isMention: isMention || !!context.followUp, imitate: !!imitation, clonedVoice: gateClonedVoice,
      ...(sneak ? { sneak } : {}), ...(guardNote ? { guardNote } : {}),
    });

    if (!gateResult.pass) {
      logOutcome('block', `Blocked by quality gate — ${gateResult.reason || 'low quality'}`, {
        msgId: msg.id,
        group: msg.groupJid,
        sender: msg.senderName,
        score: gateResult.score,
        reason: gateResult.reason,
        latencyMs: gateResult.latencyMs,
      });

      // Imitation replies are excluded from response_quality — they would poison
      // the base persona's getQualityInsights() feedback loop.
      if (!imitation) {
        recordQuality({
          messageId: `gated_${msg.id}_${Date.now()}`,
          groupJid: msg.groupJid,
          responseText: processedText,
          triggerMsgId: msg.id,
          score: gateResult.score,
          reason: gateResult.reason,
          latencyMs: gateResult.latencyMs,
          wasGated: true,
        });
      }

      // A blocked follow-up says so to the phone (a tell gets one retry) and ends without a reaction.
      if (context.followUp) context.followUp.blocked = 'gate';
      // Downgrade: maybe send a reaction instead of gibberish
      if (!context.followUp && Math.random() < 0.3 && msg.content && !turnStale('reaction')) {
        const emoji = pickEmoji(msg.content);
        await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
      }
      return;
    }
  }

  // 9. Wait human-like delay
  const isQuestion = decision.factors.question >= 2.0;
  await waitResponseDelay({
    isMention,
    isQuestion,
    isDm: context.isDm,
  }, {
    alreadyElapsedMs: genMs,
    // Life: a light/sneak hint overlaps the normal range (never stacks); a
    // catch-up is quick — he's already in the chat.
    ...(lifeGate?.delayHintMs ? { availabilityDelayMs: lifeGate.delayHintMs } : {}),
    ...(context.catchUp ? { catchUp: true } : {}),
  });
  if (turnStale('reply')) return;

  // 10. Send response
  let sentMessageId = null;

  // First-message send opts: thread the @-mentions and (optionally) the quote-key
  // from the [REPLY:<id>] marker. Subsequent split parts go in clean.
  const firstSendOpts = {
    mentions: processedMentions.length ? processedMentions : undefined,
    quotedKey: replyQuoteKey || undefined,
  };

  // 10a. Voice note branch
  if (voiceRequest) {
    await sendRecording(sock, msg.groupJid);
    const voice = await generateVoiceNote(voiceRequest.text, { sing: isSing, mood: voiceRequest.mood, voiceId: clonedVoiceId });
    await stopTyping(sock, msg.groupJid);
    if (turnStale('voice note')) return;
    if (voice) {
      const sent = await sendVoiceNote(sock, msg.groupJid, voice.buffer, voice.duration, context, { quotedKey: replyQuoteKey || undefined, waveform: voice.waveform, transcript: voiceRequest.text });
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
      if (clonedVoiceId) recordImitationVoiceNote(msg.groupJid);
      logger.info({ msgId: msg.id, duration: voice.duration, model: voice.model, voice: voice.voice, cloned: !!clonedVoiceId }, 'Voice note sent');

      // Also send caption as text if present
      if (processedText) {
        // No stale check here: the reply has started, so it is finished.
        await interMessagePause();
        await simulateTyping(sock, msg.groupJid, processedText.length);
        sentOk(await sendText(sock, msg.groupJid, processedText, null, { mentions: firstSendOpts.mentions }));
      }
    } else if (processedText) {
      // Fallback: voice gen failed, send just the caption as text
      await simulateTyping(sock, msg.groupJid, processedText.length);
      if (turnStale('reply')) return;
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
    }
  } else if (stickerRequest) {
  // 10b. Sticker branch (GIPHY)
    await simulateTyping(sock, msg.groupJid, 200);
    const sticker = await searchGiphy(stickerRequest.query, 'sticker');
    if (turnStale('sticker')) return;
    if (sticker) {
      const sent = await sendSticker(sock, msg.groupJid, sticker.buffer, context, { quotedKey: replyQuoteKey || undefined });
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
      logger.info({ msgId: msg.id, query: stickerRequest.query, giphyId: sticker.id }, 'Sticker response sent');

      if (processedText) {
        // No stale check here: the reply has started, so it is finished.
        await interMessagePause();
        await simulateTyping(sock, msg.groupJid, processedText.length);
        sentOk(await sendText(sock, msg.groupJid, processedText, null, { mentions: firstSendOpts.mentions }));
      }
    } else if (processedText) {
      await simulateTyping(sock, msg.groupJid, processedText.length);
      if (turnStale('reply')) return;
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
    }
  } else if (gifRequest) {
  // 10c. GIF branch (GIPHY → MP4 with gifPlayback)
    await simulateTyping(sock, msg.groupJid, 200);
    const gif = await searchGiphy(gifRequest.query, 'gif');
    if (turnStale('gif')) return;
    if (gif) {
      const sent = await sendGif(sock, msg.groupJid, gif.buffer, processedText || '', context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
      logger.info({ msgId: msg.id, query: gifRequest.query, giphyId: gif.id }, 'GIF response sent');
    } else if (processedText) {
      await simulateTyping(sock, msg.groupJid, processedText.length);
      if (turnStale('reply')) return;
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
    }
  } else if (imageRequest) {
  // 10d. Image generation branch
    await simulateTyping(sock, msg.groupJid, 200);
    const image = await generateImage(imageRequest.prompt);
    if (turnStale('image')) return;
    if (image) {
      const sent = await sendImage(sock, msg.groupJid, image.buffer, processedText || '', context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
      logger.info({ msgId: msg.id, prompt: imageRequest.prompt.slice(0, 80) }, 'Image response sent');
    } else if (processedText) {
      // Fallback: image gen failed, send just the caption as text
      await simulateTyping(sock, msg.groupJid, processedText.length);
      if (turnStale('reply')) return;
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();
    }
  } else {
    // 10e. Split message if needed
    const parts = maybeSplit(processedText);

    // 11. Type and send each part (typing speed mimics the target while imitating)
    const typingOpts = imitation ? { speedFactor: imitationTypingFactor(imitation.styleCard) } : {};
    // The stale check guards part 1 only: once the reply has started, the rest is
    // sent too so a split reply is never cut in half.
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && turnStale('reply')) return;
      await simulateTyping(sock, msg.groupJid, parts[i].length, typingOpts);
      if (i === 0 && turnStale('reply')) return;
      const sent = await sendText(
        sock,
        msg.groupJid,
        parts[i],
        i === 0 ? context : null,
        i === 0 ? firstSendOpts : {},
      );
      if (i === 0 && sent?.key?.id) sentMessageId = sent.key.id;
      if (sentOk(sent)) recordSent();

      if (i < parts.length - 1) {
        await interMessagePause();
      }
    }
  }

  // Record quality score for the sent response (never for imitation replies —
  // they must not feed the base persona's quality-insight loop)
  if (sentMessageId && context.isGroup && !imitation) {
    try {
      recordQuality({
        messageId: sentMessageId,
        groupJid: msg.groupJid,
        responseText: processedText || '[generated image]',
        triggerMsgId: msg.id,
        score: null, // already evaluated above, score logged there
        reason: 'sent',
        latencyMs: 0,
        wasGated: false,
      });
    } catch (err) {
      logger.debug({ err: err.message, msgId: sentMessageId }, 'Failed to record sent-response quality (non-critical)');
    }
  }

  // 12. Maybe also react (for text_and_reaction type)
  if (responseType === 'text_and_reaction' && msg.content && !turnStale('reaction')) {
    const emoji = pickEmoji(msg.content);
    await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
  }

  if (!delivered) {
    logOutcome('block', 'Send failed — nothing went out', {
      msgId: msg.id, group: msg.groupJid, sender: msg.senderName, reason: 'send_failed',
      voice: !!voiceRequest, imageGen: !!imageRequest, sticker: !!stickerRequest, gif: !!gifRequest,
    });
    return;
  }
  turn.replied = true;
  turn.sentMessageId = sentMessageId;
  lifeAfterReply(msg, context, turn, processedText || voiceRequest?.text || null, sentMessageId);

  const elapsed = Date.now() - startTime;
  logOutcome('reply', `Replied to ${msg.senderName || 'someone'}`, {
    msgId: msg.id,
    group: msg.groupJid,
    sender: msg.senderName,
    score: decision.score,
    factors: decision.factors,
    responseLen: processedText?.length || 0,
    imitating: imitation ? imitation.label : undefined,
    imageGen: !!imageRequest,
    sticker: !!stickerRequest,
    gif: !!gifRequest,
    mentions: processedMentions.length,
    replyThreaded: !!replyQuoteKey,
    elapsedMs: elapsed,
  });
}

// ── Wire up the message processor ──
setMessageProcessor(processMessage);

// ── Connect to WhatsApp ──
async function start() {
  try {
    await loadSkills();

    let liveSock = null;
    loadMutedGroups();
    loadImitationModes();
    // Owner vibe/language edits made before owner marks existed: mark them from the
    // audit log so learning stops overwriting them (idempotent, every boot).
    try {
      const marked = backfillOwnerGroupMarks();
      if (marked) logger.info({ marked }, 'Owner group fields marked from the audit log');
    } catch (err) {
      logger.warn({ evt: 'issue', err: err?.message }, 'Owner group field backfill failed');
    }
    await startDashboard({ getSock: () => liveSock });
    startCalls({ getSock: () => liveSock });
    startInstagram();

    // Life simulation (spec 009). Not awaited: a first boot without world.json
    // makes one 'mind' call to seed the world, and the bot connects meanwhile
    // (life off until it's up). With the `life` skill off the facade waits for
    // the toggle; switching it off later drains the queue once (life_off).
    // Never fatal: a failure leaves life off.
    startLife({
      getSock: () => liveSock,
      processMessage: lifeDrainProcess,
      withChatLock: lifeDrainLock,
      isGroupMuted,
      isMember: lifeIsMember,
      mindBudgetOk: (kind) => mindBudgetOk(kind),   // 010: the arc seed's budget gate
      intentions: (at) => mindIntentions(at),       // 020 F2: the thought stream, codes only
      stances: mindStanceProvider,                  // 020 B: his interests and opinions, inert until approved
      personOptedOut: (jid) => mindPersonOptedOut(jid),   // 020 A4: "don't text me first" also holds a tell about a plan
      // 014: OSM lookups on owner clicks only (GEO_ENABLED=false → none; null = geo off).
      geo: (() => {
        if (!config.geo?.enabled) return null;
        try { return createGeoClient({ fetch: globalThis.fetch }); } catch (err) {
          logger.warn({ evt: 'issue', where: 'geo', err: err?.name || 'Error' }, 'Geo client not built — lookups off');
          return null;
        }
      })(),
      onAlert: (alert) => logger.warn({ evt: 'issue', alert }, `Life alert — ${alert?.kind || 'unknown'}`),
    }).catch(err => logger.error({ evt: 'issue', err: err?.message }, 'Life simulation failed to start — continuing with life off'));

    // Mind (spec 008). Its life.onTick subscription is made at import, so life's boot
    // catch-up tick is not lost; this only marks it started. Inert while the `mind`
    // skill is off (MIND_ENABLED is its boot default). Never throws. The socket is
    // read lazily at each dispatch, so reconnects need no hook.
    startMind({ getSock: () => liveSock });

    // Public site (spec 013): the purge hook + the export timer (each run checks the
    // `public-site` skill; PUBLIC_SITE_ENABLED is its boot default). Never throws.
    startPublic();

    // Cap catch-up: one reply per group once an hourly cap that blocked a reply he'd
    // have sent frees again (src/behavior/capCatchUp.js; 60 s unref'd timer, in-memory).
    startCapCatchUp({
      getSock: () => liveSock,
      processMessage,
      withChatLock,
      isGroupMuted,
      life: { isLifeOn, availabilityNow: lifeAvailabilityNow, inPhoneCheckNow: lifeInPhoneCheckNow },
    });

    // Full membership sync every 3 h (armed once; each run uses the live socket).
    // Connection opens trigger their own sync below.
    setInterval(() => {
      const s = getSock();
      if (s) syncAllGroups(s).catch(err => logger.warn({ err: err.message }, 'Periodic membership sync failed'));
    }, 3 * 60 * 60 * 1000);

    if (verdict.noWhatsApp) {
      for (const line of verdict.lines) logger.warn(line);
      return;
    }
    await connectToWhatsApp(async (connectedSock) => {
      liveSock = connectedSock;
      // Nothing counts as fresh on a new connection until its own sync completes —
      // until then recall shares nothing across chats.
      markAllUnsynced();
      registerEventHandlers(connectedSock);
      syncAllGroups(connectedSock).catch(err => logger.warn({ err: err.message }, 'Membership sync on connect failed'));
      // With life on, his phone (src/life/phone.js) owns presence.
      if (!lifeSafe(() => isLifeOn(), false, 'isLifeOn')) await setPresence(connectedSock, 'available');
      else lifeOnConnect().catch(() => {});
      logger.info(`${getPersona().name} is ready`);
    });
  } catch (err) {
    logger.fatal({ err }, 'Failed to start');
    process.exit(1);
  }
}

// ── Graceful shutdown ──
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  // Close the headless browser first (raced with a timeout so a hung close can't
  // block exit) — prevents orphaned Chromium processes accumulating across restarts.
  try {
    await Promise.race([
      closeBrowser('shutdown'),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {}
  try { stopCalls(); } catch {}
  try { stopInstagram(); } catch {}
  try { stopMind(); } catch {}
  try { stopPublic(); } catch {}
  try { stopCapCatchUp(); } catch {}
  // Snapshot + clear life timers (raced: stopLife waits for a boot in progress).
  try {
    await Promise.race([stopLife(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  } catch {}
  await disconnectFromWhatsApp();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── GO ──
// (A test imports this file for the real turn, with no socket or timers: KARYASTHAN_NO_START=1.)
export { processMessage as __processMessageForTest };
if (process.env.KARYASTHAN_NO_START !== '1') start();
