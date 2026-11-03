import { WAMessageStubType, normalizeMessageContent, getContentType } from '@whiskeysockets/baileys';
import { isGroupJid, isDmJid, isStatusBroadcast, phoneFromJid } from '../utils/jidUtils.js';
import { logger } from '../utils/logger.js';
import { getPersona } from '../utils/config.js';
import { storeMessage } from '../memory/messageStore.js';
import { getDb } from '../memory/db.js';
import { upsertPerson } from '../memory/peopleStore.js';
import { upsertGroup } from '../memory/groupStore.js';
import { resolvePerson, recordIdentity } from '../memory/identity.js';
import { noteSender, onParticipantsUpdate } from '../memory/membership.js';
import { forgetRecent, onMessageRevoked, onMessageEdited } from '../memory/relationshipStore.js';
import { onIngest } from '../memory/learningPipeline.js';
import { transcribeAudio } from '../brain/transcribe.js';
import { describeMedia } from '../brain/describeMedia.js';
import { recordReaction } from '../brain/qualityGate.js';
import { prepare as prepareRelay } from '../brain/relay.js';
import { autoDetectBill } from '../billing/autoDetect.js';
import { claimVoiceEnrollment } from './voiceEnrollment.js';
import { sendText } from './actions.js';
import { isBotMentioned as isBotMentionedShared } from '../utils/mentions.js';

// Will be set by index.js after all modules are loaded
let processMessage = null;

// ── Raw message cache for skills that need media re-download ──
const rawMessageCache = new Map();
const RAW_MSG_CACHE_MAX = 50;

export function getRawMessage(msgId) {
  return rawMessageCache.get(msgId) || null;
}

// ── In-flight media descriptions ──
// describeMedia is fire-and-forget, so an image's description may not be in the
// DB yet when the response pipeline builds its transcript — the trigger line ends
// up as just the caption (often a bare link). The pipeline can wait on this map
// (bounded) so it replies to what's actually IN the image.
const pendingDescriptions = new Map(); // msgId → Promise

/**
 * Wait (bounded) for a message's media description to land in the DB.
 * Resolves true when the description settled, false on timeout or if none is in flight.
 */
export function waitForMediaDescription(msgId, timeoutMs = 10_000) {
  const pending = pendingDescriptions.get(msgId);
  if (!pending) return Promise.resolve(false);
  return Promise.race([
    pending.then(() => true),
    new Promise(resolve => setTimeout(resolve, timeoutMs, false)),
  ]);
}

// ── Message debounce buffer ──
// Buffers rapid messages per chat so the bot waits for the sender to finish
// before deciding whether to respond. Messages are stored to DB immediately;
// only the processMessage trigger is delayed.
const messageBuffers = new Map(); // chatJid → { messages[], timer, sock, context }

// Per-chat in-flight lock. While a processMessage is running for a chat,
// newly arriving messages accumulate in messageBuffers instead of kicking off
// a second parallel processMessage. When the in-flight promise settles, any
// pending buffer is re-flushed in one shot with full updated context.
const inFlight = new Map(); // chatJid → Promise
// 90s: a web-search turn during provider degradation (LLM 503 retries + fallback +
// search + re-prompt) has been measured at ~55s; 60s risked force-releasing the chat
// lock mid-turn and double-replying. Still small enough to unstick a truly hung chat.
let IN_FLIGHT_SAFETY_MS = 90_000;

/** Test hook (scripts/life-tests/20-*): shorten the in-flight safety timeout; null restores 90 s. */
export function __setInFlightSafetyMsForTest(ms) {
  IN_FLIGHT_SAFETY_MS = Number.isFinite(ms) && ms > 0 ? ms : 90_000;
}

const DEBOUNCE_GROUP_MS = 8000;  // 8s for group chats — wait for people to finish typing
const DEBOUNCE_DM_MS = 3000;    // 3s for DMs
const DEBOUNCE_MENTION_MS = 2000; // 2s for direct @mentions (faster attention)
const REFLUSH_DELAY_MS = 500;   // re-arm delay when flush is blocked by in-flight
const MAX_BUFFER_SIZE = 12;      // flush if buffer gets too large

/**
 * Check if a message directly mentions the bot (by its own JID/LID or name).
 * Tagging someone else is NOT a mention — see src/utils/mentions.js.
 */
function isBotMentioned(msg, botJid, botLid) {
  return isBotMentionedShared(msg, { botJid, botLid }, { logTag: 'isBotMentioned' });
}

/**
 * Race a turn against the in-flight safety timeout. On timeout race() rejects so
 * the chat lock is released as before — the turn itself keeps running and may
 * still send its (late) reply. abort() marks it stale (processMessage checks
 * context.turnSignal before every send); flushBuffer calls it only when a new
 * turn actually takes over the chat, so a stale turn can never double-reply but
 * a slow turn with nothing behind it is never thrown away.
 * Returns { signal, race(promise), abort() }.
 */
export function createTurnGuard(timeoutMs) {
  const ac = new AbortController();
  let timeoutHandle;
  const race = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('processMessage in-flight timeout')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeoutHandle));
  const abort = () => { if (!ac.signal.aborted) ac.abort(); };
  return { signal: ac.signal, race, abort };
}

// chatJid → abort() of a turn that overran the safety timeout and is still running.
// Called when the next turn for that chat starts.
const staleTurns = new Map();

/**
 * Buffer a message and debounce the processMessage call.
 * The last message in the buffer is the one that gets processed —
 * all earlier messages are already in the DB and visible in context.
 * Each message keeps its own raw WAMessage (`raws`): the turn's context.rawMsg is
 * quoted by the reply and keys its read receipt, so it must be the processed
 * message's, never the newest buffered line's (which may have been revoked).
 */
function bufferAndProcess(sock, msg, context) {
  const chatJid = msg.groupJid;
  const hasMention = isBotMentioned(msg, context.botJid, context.botLid);

  const existing = messageBuffers.get(chatJid);
  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(msg);
    existing.raws.set(msg.id, context.rawMsg || null);
    existing.context = context; // update to latest context
    // Promote to mention-speed if any message in buffer mentions us
    if (hasMention) existing.hasMention = true;
  } else {
    messageBuffers.set(chatJid, {
      messages: [msg], raws: new Map([[msg.id, context.rawMsg || null]]), edited: new Map(), sock, context, hasMention,
    });
  }

  const buffer = messageBuffers.get(chatJid);

  // Flush immediately if buffer is getting too large
  if (buffer.messages.length >= MAX_BUFFER_SIZE) {
    flushBuffer(chatJid);
    return;
  }

  // Pick debounce delay
  let delay;
  if (context.isDm) delay = DEBOUNCE_DM_MS;
  else if (buffer.hasMention) delay = DEBOUNCE_MENTION_MS;
  else delay = DEBOUNCE_GROUP_MS;

  buffer.timer = setTimeout(() => flushBuffer(chatJid), delay);
}

/**
 * The buffered messages as stored now: a message revoked while it waited here is
 * dropped, an edited text message carries its new text (messages.update changes only
 * the DB row). Read failure → the buffer as it was.
 */
function stillStored(chatJid, messages) {
  try {
    const ids = messages.map(m => m.id);
    const rows = getDb().prepare(
      `SELECT id, content FROM messages WHERE group_jid = ? AND id IN (${ids.map(() => '?').join(',')})`
    ).all(chatJid, ...ids);
    const byId = new Map(rows.map(r => [r.id, r]));
    return messages.filter(m => byId.has(m.id)).map(m => {
      // Text only: a photo's/sticker's row content becomes its media description.
      const content = byId.get(m.id).content;
      return m.messageType !== 'text' || content === m.content ? m : { ...m, content };
    });
  } catch (err) {
    logger.debug({ err: err.message, chatJid }, 'Buffered-message re-read failed (non-critical)');
    return messages;
  }
}

/** An edit applied to a message still waiting in a buffer: its raw (old text/caption) must not be quoted. */
function noteBufferedEdit(msgId, text) {
  for (const buffer of messageBuffers.values()) {
    if (buffer.raws.has(msgId)) buffer.edited.set(msgId, String(text ?? ''));
  }
}

/**
 * The raw message a turn for `m` carries (quote + receipt key). An edited message's
 * raw still holds the text the sender edited away, so its text (or a media
 * caption) is replaced with the edited one; the key stays, so receipts and the
 * quote's target are unchanged.
 */
function rawFor(buffer, m, original) {
  const raw = buffer.raws.get(m.id) || null;
  if (!raw) return null;
  const edited = buffer.edited.has(m.id);
  if (!edited && m === original) return raw;
  const text = edited ? buffer.edited.get(m.id) : String(m.content ?? '');
  const inner = normalizeMessageContent(raw.message) || {};
  const type = getContentType(inner);
  const media = type && /^(image|video|document)Message$/.test(type) && inner[type];
  return {
    key: raw.key,
    ...(raw.participant && { participant: raw.participant }),
    ...(raw.messageTimestamp && { messageTimestamp: raw.messageTimestamp }),
    message: media ? { [type]: { ...media, caption: text } } : { conversation: text },
  };
}

function flushBuffer(chatJid) {
  const buffer = messageBuffers.get(chatJid);
  if (!buffer) return;

  // If a processMessage is already running for this chat, keep messages queued
  // and re-arm a short timer. The in-flight promise's .finally will trigger a
  // re-flush that coalesces everything at once with fully-updated context.
  if (inFlight.has(chatJid)) {
    clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => flushBuffer(chatJid), REFLUSH_DELAY_MS);
    logger.debug({
      chatJid,
      bufferedCount: buffer.messages.length,
    }, 'Flush deferred — processMessage in flight');
    return;
  }

  messageBuffers.delete(chatJid);

  const { sock, context } = buffer;
  const messages = stillStored(chatJid, buffer.messages);
  if (!messages.length) {
    logger.debug({ chatJid, bufferedCount: buffer.messages.length }, 'Flush dropped — every buffered message was revoked');
    return;
  }
  const lastMsg = messages[messages.length - 1];
  const originals = new Map(buffer.messages.map(m => [m.id, m]));
  const rawOf = (m) => rawFor(buffer, m, originals.get(m.id));

  logger.debug({
    chatJid,
    bufferedCount: messages.length,
    triggerMsgId: lastMsg.id,
  }, 'Flushing message buffer');

  if (!processMessage) return;

  // Check if an earlier message is a skill trigger (reply + mention) that would
  // be lost if we only process the last message. If so, process all messages
  // sequentially so the skill flow handles subsequent ones too.
  const hasEarlierTrigger = messages.length > 1 && messages.slice(0, -1).some(
    m => m.quotedId && isBotMentioned(m, context.botJid, context.botLid)
  );

  // DM relays ("tell the group I'll be late"): detected over every buffered message
  // of the flush, decided in code before generation (src/brain/relay.js). The turn
  // carries the relay id + a prompt note; processMessage confirms or declines it.
  const relayReady = context.isDm ? prepareRelayForTurn(sock, chatJid, messages) : Promise.resolve(null);

  // Each turn gets its own abort signal (context.turnSignal), tripped only if it
  // overruns the safety timeout AND a later turn takes over the chat.
  holdChat(chatJid, null, ({ turnSignal }) => {
    const turnContext = { ...context, rawMsg: rawOf(lastMsg), turnSignal };
    // Spec 012: the flush's buffered ids, so life's chat perception can read the burst.
    if (messages.length > 1) turnContext.burstIds = messages.map(m => m.id);
    return relayReady.then((relay) => {
      if (relay) {
        turnContext.relay = relay;
        turnContext.promptNotes = relay.promptNotes || [];
      }
      if (!hasEarlierTrigger) {
        return processMessage(sock, lastMsg, turnContext).catch(err => {
          logger.error({ err, msgId: lastMsg.id }, 'Error in debounced processMessage');
        });
      }
      return (async () => {
        for (let i = 0; i < messages.length; i++) {
          if (turnSignal.aborted) break;
          const msg = messages[i];
          // The relay (and its note) belongs to the final reply of the flush only.
          const ctx = i === messages.length - 1 ? turnContext : { ...turnContext, rawMsg: rawOf(msg), relay: null, promptNotes: [] };
          try {
            await processMessage(sock, msg, ctx);
          } catch (err) {
            logger.error({ err, msgId: msg.id }, 'Error in buffered processMessage');
          }
        }
      })();
    });
  }, 'turn');
}

/**
 * The per-chat lock — the ONE code path behind live turns (flushBuffer), relay
 * dispatch and life's catch-up drain (withChatLock). Synchronously registers the
 * run in `inFlight` (so flushBuffer defers new messages behind it), then once
 * `waitFor` settles (the job it queued behind; null = start now):
 *   1. a turn that overran the safety timeout and is still running is aborted —
 *      this run takes over the chat, so the stale one must never send alongside it;
 *   2. start(lockCtx) runs with lockCtx = { turnSignal } (abort signal for this run);
 *   3. the 90 s createTurnGuard race starts — from the run's own start, not from
 *      the moment it was queued, so a job behind a slow turn keeps its full budget.
 * On timeout the lock is released, not the run: its abort goes into staleTurns
 * and trips only when the next run for this chat starts. On settle the entry is
 * deleted and any messages buffered meanwhile are flushed as one batch.
 * Returns start()'s own promise (resolves/rejects with its result).
 */
function holdChat(chatJid, waitFor, start, kind) {
  const guard = createTurnGuard(IN_FLIGHT_SAFETY_MS);
  const ready = waitFor ? waitFor.catch(() => {}) : Promise.resolve();

  const runner = ready.then(() => {
    // A turn that overran the safety timeout may still be running — a new run is
    // taking over this chat now, so stop it from sending alongside this one.
    const staleAbort = staleTurns.get(chatJid);
    if (staleAbort) {
      staleTurns.delete(chatJid);
      staleAbort();
    }
    return start({ turnSignal: guard.signal });
  });

  const abortStale = () => {
    if (guard.signal.aborted) return;
    guard.abort();
    logger.warn({ evt: 'turn_stale', chatJid, timeoutMs: IN_FLIGHT_SAFETY_MS }, 'turn_stale — overran turn aborted as a new turn takes over the chat; it will not send');
  };
  // Once the overran run settles on its own there is nothing left to abort.
  runner.catch(() => {}).finally(() => {
    if (staleTurns.get(chatJid) === abortStale) staleTurns.delete(chatJid);
  });

  // Safety timeout so a hung LLM never permanently locks a chat.
  const held = ready.then(() => guard.race(runner)).catch(err => {
    if (err?.message === 'processMessage in-flight timeout') {
      // Released, not aborted: the run may still send late, unless a new run
      // for this chat starts first (it aborts this one then).
      staleTurns.set(chatJid, abortStale);
      if (kind === 'turn') {
        logger.error(
          { evt: 'issue', chatJid, timeoutMs: IN_FLIGHT_SAFETY_MS },
          'Message processing hit the in-flight safety timeout — forced release (the turn is aborted only if a new turn takes over this chat)',
        );
      } else {
        logger.error({ evt: 'issue', chatJid, timeoutMs: IN_FLIGHT_SAFETY_MS }, 'Locked chat job hit the in-flight safety timeout — lock released');
      }
    } else if (kind === 'turn') {
      logger.warn({ evt: 'issue', err: err?.message, chatJid }, 'In-flight guard released with error');
    }
    // A locked job's own error goes to its caller through the returned promise.
  }).finally(() => {
    // A run queued behind this one now holds the chat; it re-flushes the buffer
    // when it settles.
    if (inFlight.get(chatJid) !== held) return;
    inFlight.delete(chatJid);
    // If new messages arrived while we were busy, flush them now as one batch.
    const pending = messageBuffers.get(chatJid);
    if (pending) {
      clearTimeout(pending.timer);
      flushBuffer(chatJid);
    }
  });

  inFlight.set(chatJid, held);
  return runner;
}

// Relay detection never blocks the turn for long and never throws into it: a slow
// or failing Jev check yields no relay (relay.js fails closed on its own errors).
const RELAY_PREP_TIMEOUT_MS = 12_000;
async function prepareRelayForTurn(sock, chatJid, messages) {
  let timer;
  try {
    return await Promise.race([
      prepareRelay({ sock, chatJid, messages }),
      new Promise(resolve => { timer = setTimeout(resolve, RELAY_PREP_TIMEOUT_MS, null); }),
    ]);
  } catch (err) {
    logger.warn({ err: err.message, chatJid }, 'Relay detection failed — no relay this turn');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run fn inside chatJid's in-flight lock: after the turn (or locked job) currently
 * holding the chat settles, and before any newly buffered messages are flushed.
 * Used to dispatch relays into a target group without racing a reply there, and
 * by life's phone checks to run a chat's catch-up turn (spec 009 §R10). Shares
 * holdChat with live turns: fn gets { turnSignal } (pass it on as
 * context.turnSignal so an overrun turn can be aborted), starting fn aborts a
 * stale overrun turn of this chat, and messages buffered while fn runs are
 * flushed after it — never in parallel, never lost. Resolves/rejects with fn's
 * result. The same safety timeout as a turn releases the lock if fn hangs (fn
 * itself keeps running).
 */
export function withChatLock(chatJid, fn) {
  return holdChat(chatJid, inFlight.get(chatJid) ?? null, (lockCtx) => fn(lockCtx), 'job');
}

export function setMessageProcessor(fn) {
  processMessage = fn;
}

/**
 * Extract text content from a WAMessage
 */
function extractContent(msg) {
  const m = msg.message;
  if (!m) return { text: null, type: 'unknown' };

  if (m.conversation) return { text: m.conversation, type: 'text' };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, type: 'text' };
  if (m.imageMessage?.caption) return { text: m.imageMessage.caption, type: 'image' };
  if (m.videoMessage?.caption) return { text: m.videoMessage.caption, type: 'video' };
  if (m.documentMessage?.caption) return { text: m.documentMessage.caption, type: 'document' };
  if (m.stickerMessage) return { text: null, type: 'sticker' };
  if (m.audioMessage) return { text: null, type: 'audio' };
  if (m.reactionMessage) return { text: m.reactionMessage.text, type: 'reaction' };
  if (m.imageMessage) return { text: null, type: 'image' };
  if (m.videoMessage) return { text: null, type: 'video' };

  return { text: null, type: 'other' };
}

/**
 * Extract quoted message info if this message is a reply
 */
function extractQuoted(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) {
    return {
      quotedId: null,
      quotedContent: null,
      quotedMessageType: null,
      quotedParticipant: null,
      quotedRawMessage: null,
    };
  }

  const quotedId = ctx.stanzaId || null;
  const qm = ctx.quotedMessage;
  const quotedContent = qm.conversation
    || qm.extendedTextMessage?.text
    || qm.imageMessage?.caption
    || null;

  let quotedMessageType = null;
  if (qm.imageMessage) quotedMessageType = 'image';
  else if (qm.videoMessage) quotedMessageType = 'video';
  else if (qm.stickerMessage) quotedMessageType = 'sticker';
  else if (qm.audioMessage) quotedMessageType = 'audio';
  else if (qm.documentMessage) quotedMessageType = 'document';
  else if (qm.conversation || qm.extendedTextMessage) quotedMessageType = 'text';

  return {
    quotedId,
    quotedContent,
    quotedMessageType,
    quotedParticipant: ctx.participant || null,
    quotedRawMessage: qm,
  };
}

/**
 * Given a processed msg whose quoted message is an image, build a Baileys-shaped
 * message object suitable for downloadMediaMessage(). Returns null if the quoted
 * message isn't present or isn't an image.
 */
export function buildQuotedWAMessage(msg) {
  if (!msg?.quotedRawMessage?.imageMessage) return null;
  if (!msg.quotedId || !msg.groupJid) return null;

  return {
    key: {
      remoteJid: msg.groupJid,
      id: msg.quotedId,
      participant: msg.quotedParticipant || undefined,
      fromMe: false,
    },
    message: msg.quotedRawMessage,
  };
}

/**
 * Extract @mentioned JIDs from a message's contextInfo
 */
function extractMentionedJids(msg) {
  const m = msg.message;
  if (!m) return [];

  const ctx = m.extendedTextMessage?.contextInfo
    || m.imageMessage?.contextInfo
    || m.videoMessage?.contextInfo
    || m.documentMessage?.contextInfo;

  return ctx?.mentionedJid || [];
}

// contextInfo of the message's content node, whatever its type.
function contentContextInfos(message) {
  if (!message || typeof message !== 'object') return [];
  const inner = message.ephemeralMessage?.message || message;
  return Object.values(inner).map(v => v?.contextInfo).filter(Boolean);
}

function isForwardedMessage(msg) {
  return contentContextInfos(msg.message).some(c => c.isForwarded || (c.forwardingScore || 0) > 0);
}

const DEFAULT_EPHEMERAL_SEC = 7 * 24 * 3600;
/** unix s when a disappearing message expires, or null for an ordinary message. */
function ephemeralExpiresAt(msg, ts) {
  const exp = contentContextInfos(msg.message).map(c => Number(c.expiration)).find(n => Number.isFinite(n) && n > 0);
  if (exp) return ts + exp;
  if (msg.message?.ephemeralMessage) return ts + DEFAULT_EPHEMERAL_SEC;
  return null;
}

// ── "forget that" (R11) ──
// Whole-message match only, so "I'll never forget that trip" is not a request.
// An optional leading name/alias of the bot and politeness words are allowed.
const FORGET_CORE = new RegExp('^(?:'
  + 'forget (?:that|this|it|all (?:of )?(?:that|this|it)|everything|it all|that one|about (?:that|this|it)'
  + '|what i (?:just )?(?:said|told you|sent|wrote)(?: (?:just )?now)?|i (?:ever )?said (?:that|it|this)|i told you (?:that|this))'
  + '|(?:do not|dont|don\'t) remember (?:that|this|it)'
  + '|(?:delete|erase|remove|wipe|clear) (?:that|this|it|what i said)(?: from (?:your )?memory)?'
  + '|(?:ath|athu|ith|ithu|athokke|ithokke|ellam|ellaam)? ?(?:marakk(?:u|uka|ane)?|marann?ek+(?:u|o|ane)?|marannu kala(?:yu|yy?u|k+u)?)'
  + ')$');
const FORGET_FILLER = /^(?:please|pls|plz|ok|okay|hey|bro|da|di|machane|eda|edi|just|now|and)\s+|\s+(?:please|pls|plz|ok|okay|bro|da|di|machane|now|thanks|thank you)$/;

/** True if the whole message is a "forget that"-style request. Exported for tests. */
export function isForgetRequest(text) {
  if (!text || typeof text !== 'string' || text.length > 80) return false;
  let t = text.toLowerCase().normalize('NFKC')
    .replace(/[\u2019`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  for (const alias of getPersona().aliases || []) {
    const a = String(alias || '').toLowerCase().trim();
    if (a && t.startsWith(`${a} `)) { t = t.slice(a.length + 1); break; }
  }
  for (let i = 0; i < 4; i++) {
    const next = t.replace(FORGET_FILLER, '').trim();
    if (next === t) break;
    t = next;
  }
  return FORGET_CORE.test(t);
}

// A platform-attested pair of forms of one account. The phone form is always bound
// to the LID account, whichever form the chat was addressed by: a number can be
// recycled, a LID can't, so binding a new LID onto whoever held the number would
// hand that person the previous owner's history. recordIdentity then reassigns
// (PN moved to a different LID) or merges/queues (one side without a LID).
function recordIdentityPair(formA, formB, source) {
  const lid = [formA, formB].find(f => typeof f === 'string' && f.endsWith('@lid'));
  const pn = [formA, formB].find(f => typeof f === 'string' && f.endsWith('@s.whatsapp.net'));
  if (lid && pn) recordIdentity(pn, resolvePerson(lid) || lid, source);
  else if (formA && formB) recordIdentity(formB, resolvePerson(formA) || formA, source);
}

function handleForget(sock, chatJid, senderJid) {
  // Pending (not yet answered) messages from this chat are part of what is being
  // forgotten — don't reply to them.
  const pending = messageBuffers.get(chatJid);
  if (pending) {
    clearTimeout(pending.timer);
    messageBuffers.delete(chatJid);
  }
  let ack;
  try {
    const { deleted, fenced } = forgetRecent(senderJid, chatJid);
    logger.info({ evt: 'memory_forget', chatJid, deleted, fenced }, 'Forget request handled');
    ack = 'Okay, forgotten 👍';
  } catch (err) {
    logger.warn({ err: err.message, chatJid }, 'Forget request failed');
    ack = "Couldn't clear that just now — try again in a bit.";
  }
  // Acknowledged only after the deletion above has committed.
  sendText(sock, chatJid, ack).catch(err =>
    logger.warn({ err: err.message, chatJid }, 'Forget acknowledgement failed'));
}

// An edit is applied only when it comes from the stored message's own author: the
// update's key is the editing protocol message's, so a member can't rewrite (and
// re-attribute) someone else's stored text. Revokes need no such check — deleting
// is the safe direction, and group admins may delete for everyone.
function isEditByAuthor(key, msgId) {
  try {
    const row = getDb().prepare('SELECT sender_jid, is_from_self FROM messages WHERE id = ?').get(msgId);
    if (!row) return false;
    if (key.fromMe) return !!row.is_from_self;
    const editor = key.participant || key.remoteJid;
    const same = (a, b) => !!a && !!b && (resolvePerson(a) || a.replace(/:\d+(?=@)/, '')) === (resolvePerson(b) || b.replace(/:\d+(?=@)/, ''));
    return !row.is_from_self && (same(editor, row.sender_jid) || same(key.participantAlt || key.remoteJidAlt, row.sender_jid));
  } catch {
    return false;
  }
}

/**
 * Register all event handlers on the Baileys socket
 */
export function registerEventHandlers(sock) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only process new messages (not history sync)
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err, msgId: msg.key?.id }, 'Error handling message');
      }
    }
  });

  // Track group metadata updates
  sock.ev.on('groups.update', async (updates) => {
    for (const update of updates) {
      if (update.id && update.subject) {
        upsertGroup(update.id, update.subject);
        logger.debug({ groupJid: update.id, name: update.subject }, 'Group updated');
      }
    }
  });

  // Group participant changes, canonicalised (identity forms recorded first; the
  // bot's own forms and non-person JIDs dropped) and logged as joins/leaves —
  // membership feeds the recall audience rule (src/memory/membership.js).
  sock.ev.on('group-participants.update', async (update) => {
    logger.debug({ groupJid: update?.id, count: update?.participants?.length, action: update?.action }, 'Group participants changed');
    onParticipantsUpdate(update, sock);
  });

  // Platform-attested LID ↔ phone pairings.
  sock.ev.on('lid-mapping.update', async (update) => {
    for (const { lid, pn } of [].concat(update || [])) {
      try {
        if (!resolvePerson(lid) && !resolvePerson(pn)) continue;   // nobody we know — nothing to attach the form to
        recordIdentityPair(lid, pn, 'lidmap');
      } catch (err) {
        logger.debug({ err: err.message }, 'lid-mapping update failed (non-critical)');
      }
    }
  });

  // Delete-for-everyone and edits arrive as message updates (Baileys turns the
  // protocol message into one). A revoked message is removed with anything learned
  // from it; an edit replaces the stored text and drops what the old text taught.
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates || []) {
      const id = key?.id;
      if (!id || !update) continue;
      try {
        if (update.messageStubType === WAMessageStubType.REVOKE) {
          onMessageRevoked(id, key.remoteJid || '');
          logger.debug({ msgId: id }, 'Message revoked — removed');
          continue;
        }
        const edited = update.message?.editedMessage?.message;
        if (edited && isEditByAuthor(key, id)) {
          const { text } = extractContent({ message: edited });
          if (text != null && onMessageEdited(id, text, key.remoteJid || '').updated) noteBufferedEdit(id, text);
        }
      } catch (err) {
        logger.debug({ err: err.message, msgId: id }, 'Message update handling failed (non-critical)');
      }
    }
  });

  logger.info('Event handlers registered');
}

/**
 * Handle a single incoming message
 */
async function handleMessage(sock, msg) {
  const chatJid = msg.key.remoteJid;
  if (!chatJid) return;

  // Skip status broadcasts
  if (isStatusBroadcast(chatJid)) return;

  // Skip protocol/system messages with no content. Protocol messages (revokes,
  // edits, ephemeral settings…) are not chat content: revokes/edits are applied
  // from 'messages.update'.
  if (!msg.message) return;
  if (normalizeMessageContent(msg.message)?.protocolMessage) return;

  // Skip reaction messages from processing pipeline (but still store them)
  const { text, type: messageType } = extractContent(msg);

  const isFromSelf = msg.key.fromMe === true;
  const senderJid = isFromSelf
    ? sock.user?.id
    : (msg.key.participant || chatJid); // participant is set for group messages

  const pushName = msg.pushName || null;
  const isGroup = isGroupJid(chatJid);
  const isDm = isDmJid(chatJid);

  // Cache raw message for images so skills (e.g. bill-split) can re-download
  if (messageType === 'image') {
    rawMessageCache.set(msg.key.id, msg);
    if (rawMessageCache.size > RAW_MSG_CACHE_MAX) {
      const oldest = rawMessageCache.keys().next().value;
      rawMessageCache.delete(oldest);
    }
  }

  // Transcribe audio synchronously (bot needs transcription to respond to voice notes)
  let mediaContent = null;
  if (messageType === 'audio') {
    mediaContent = await transcribeAudio(msg, sock);
  }

  // Extract quoted message context
  let { quotedId, quotedContent, quotedMessageType, quotedParticipant, quotedRawMessage } = extractQuoted(msg);

  // For reaction messages, extract the target message ID from reactionMessage.key
  let reactionTargetId = null;
  if (messageType === 'reaction' && msg.message?.reactionMessage?.key?.id) {
    reactionTargetId = msg.message.reactionMessage.key.id;
    if (!quotedId) quotedId = reactionTargetId; // store as quotedId for traceability
  }

  // Extract WhatsApp @mention metadata
  const mentionedJids = extractMentionedJids(msg);

  // Persist the sender, then the platform-attested other form of their id
  // (participantAlt in groups, remoteJidAlt in DMs: LID ↔ phone).
  if (senderJid && !isFromSelf) {
    upsertPerson(senderJid, phoneFromJid(senderJid), pushName);
    const alt = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt;
    if (alt) recordIdentityPair(senderJid, alt, 'message');
  }

  // Persist the group; a sender missing from the membership map is added (joined
  // now) and the group stays stale until the next full sync.
  if (isGroup) {
    upsertGroup(chatJid, null);
    if (senderJid && !isFromSelf) noteSender(chatJid, senderJid);
  }

  // Store the message immediately (before async media description)
  // For images/stickers, content is the caption only — description updates DB later
  const storedMsg = {
    id: msg.key.id,
    groupJid: chatJid,
    senderJid: senderJid || 'unknown',
    senderName: pushName,
    content: mediaContent || text,
    messageType,
    quotedId,
    quotedContent,
    // Persisted (messages.quoted_participant) — the authoritative author JID of the
    // quoted message, used for reply attribution in the conversation transcript.
    quotedParticipant,
    // In-memory only — not persisted to SQLite; used by processMessage for
    // image-edit dispatch and any future quoted-media flows.
    quotedMessageType,
    quotedRawMessage,
    isFromSelf,
    // In-memory only: relays never pass on forwarded text (not the sender's own words).
    isForwarded: isForwardedMessage(msg),
    timestamp: msg.messageTimestamp
      ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.low)
      : Math.floor(Date.now() / 1000),
    metadata: {
      mentionedJids,
      // Store raw message key for images so skills can re-download later
      ...(messageType === 'image' && { rawMsgKey: msg.key }),
    },
  };

  // Disappearing-message chats: the row expires with the message (never learned
  // from; maintenance deletes it).
  const expiresAt = ephemeralExpiresAt(msg, storedMsg.timestamp);
  if (expiresAt) storedMsg.expiresAt = expiresAt;

  const stored = storeMessage(storedMsg);
  if (stored?.changes) {
    if (expiresAt) {
      try {
        getDb().prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(expiresAt, storedMsg.id);
      } catch (err) {
        logger.warn({ err: err.message, msgId: storedMsg.id }, 'Failed to store message expiry');
      }
    }
    // Learning cadence + self-declared nicknames (fire-and-forget; never throws).
    onIngest(storedMsg);
  }

  // Track reactions on bot messages for quality feedback
  if (messageType === 'reaction' && reactionTargetId && text && !isFromSelf) {
    try {
      const db = getDb();
      const target = db.prepare('SELECT is_from_self FROM messages WHERE id = ?').get(reactionTargetId);
      if (target?.is_from_self) {
        recordReaction(reactionTargetId, text, senderJid);
      }
    } catch (err) {
      logger.debug({ err: err.message, targetId: reactionTargetId }, 'Failed to record reaction feedback (non-critical)');
    }
  }

  // Fire-and-forget media description — updates DB content asynchronously
  // This runs for all messages (including from self) so descriptions are available in context
  if (messageType === 'image' || messageType === 'sticker') {
    const captionAtStore = storedMsg.content;
    const descPromise = describeMedia(msg, sock, messageType).then(desc => {
      if (desc) {
        // Keep the caption alongside the description — for link posts the caption
        // (page title / preview text) often carries the actual topic while the
        // image is just artwork. Bills stay clean for downstream parsing.
        const combined = (captionAtStore && !desc.startsWith('BILL:'))
          ? `${desc} (caption: ${String(captionAtStore).slice(0, 300)})`
          : desc;
        try {
          getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run(combined, storedMsg.id);
        } catch (err) {
          logger.warn({ err: err.message, msgId: storedMsg.id }, 'Failed to update media description in DB');
        }

        // Auto-detect bills from image descriptions
        if (messageType === 'image' && desc.startsWith('BILL:')) {
          autoDetectBill(msg, sock, storedMsg).catch(err => {
            logger.debug({ err: err.message, msgId: storedMsg.id }, 'Auto bill detection failed');
          });
        }
      }
    }).catch(err => {
      logger.warn({ err: err.message, msgId: storedMsg.id, messageType }, 'Background media description failed');
    });
    pendingDescriptions.set(storedMsg.id, descPromise);
    descPromise.finally(() => pendingDescriptions.delete(storedMsg.id));
  }

  // Skip own messages and reactions for the response pipeline
  if (isFromSelf) return;
  if (messageType === 'reaction') return;

  // DM voice enrollment ("voice enroll" + its two voice notes) is a deterministic
  // flow — handled here, before debouncing, so the notes are never coalesced or
  // answered by the LLM.
  if (isDm && claimVoiceEnrollment(sock, storedMsg, msg)) return;

  // "forget that" in a DM: same pre-debounce treatment. The requester's last few
  // messages here are fenced from learning and what was learned from them is
  // deleted (relationshipStore.forgetRecent, audited) — then acknowledged.
  if (isDm && messageType === 'text' && isForgetRequest(text)) {
    handleForget(sock, chatJid, senderJid);
    return;
  }

  // Buffer and debounce — waits for sender to finish before triggering response
  if ((isGroup || isDm) && processMessage) {
    bufferAndProcess(sock, storedMsg, { isGroup, isDm, rawMsg: msg, botJid: sock.user?.id, botLid: sock.user?.lid });
  }
}
