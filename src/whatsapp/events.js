import { isGroupJid, isDmJid, isStatusBroadcast, phoneFromJid } from '../utils/jidUtils.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { storeMessage } from '../memory/messageStore.js';
import { getDb } from '../memory/db.js';
import { upsertPerson } from '../memory/peopleStore.js';
import { upsertGroup, upsertMember } from '../memory/groupStore.js';
import { transcribeAudio } from '../brain/transcribe.js';
import { describeMedia } from '../brain/describeMedia.js';
import { recordReaction } from '../brain/qualityGate.js';
import { autoDetectBill } from '../billing/autoDetect.js';

// Will be set by index.js after all modules are loaded
let processMessage = null;

// ── Raw message cache for skills that need media re-download ──
const rawMessageCache = new Map();
const RAW_MSG_CACHE_MAX = 50;

export function getRawMessage(msgId) {
  return rawMessageCache.get(msgId) || null;
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
const IN_FLIGHT_SAFETY_MS = 60_000;

const DEBOUNCE_GROUP_MS = 8000;  // 8s for group chats — wait for people to finish typing
const DEBOUNCE_DM_MS = 3000;    // 3s for DMs
const DEBOUNCE_MENTION_MS = 2000; // 2s for direct @mentions (faster attention)
const REFLUSH_DELAY_MS = 500;   // re-arm delay when flush is blocked by in-flight
const MAX_BUFFER_SIZE = 12;      // flush if buffer gets too large

/**
 * Check if a message directly mentions the bot (by JID or name)
 */
function isBotMentioned(msg, botJid, botLid) {
  // Check @mention metadata (handles LID ↔ phone JID mismatch)
  if (msg.metadata?.mentionedJids?.length) {
    const botPhone = botJid ? phoneFromJid(botJid) : null;
    const botLidId = botLid ? phoneFromJid(botLid) : null;
    const configPhone = config.phoneNumber;
    const matched = msg.metadata.mentionedJids.some(jid => {
      const phone = phoneFromJid(jid);
      return (botPhone && phone === botPhone)
        || (botLidId && phone === botLidId)
        || (configPhone && phone === configPhone);
    });
    if (matched) return true;

    // LID mismatch: @mentions present but none matched — log for diagnostics
    logger.debug({
      mentionedJids: msg.metadata.mentionedJids,
      botPhone, botLidId, configPhone,
      msgId: msg.id,
    }, 'isBotMentioned: @mention JIDs did not match bot — possible LID mismatch');

    // Fallback: single @mention is very likely for us (group members don't @mention
    // someone else when talking to the bot)
    if (msg.metadata.mentionedJids.length === 1) return true;
  }
  // Check text-based name mention
  if (msg.content) {
    const lower = msg.content.toLowerCase();
    if (getPersona().aliases.some(n => lower.includes(n))) return true;
  }
  return false;
}

/**
 * Buffer a message and debounce the processMessage call.
 * The last message in the buffer is the one that gets processed —
 * all earlier messages are already in the DB and visible in context.
 */
function bufferAndProcess(sock, msg, context) {
  const chatJid = msg.groupJid;
  const hasMention = isBotMentioned(msg, context.botJid, context.botLid);

  const existing = messageBuffers.get(chatJid);
  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(msg);
    existing.context = context; // update to latest context
    // Promote to mention-speed if any message in buffer mentions us
    if (hasMention) existing.hasMention = true;
  } else {
    messageBuffers.set(chatJid, { messages: [msg], sock, context, hasMention });
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

  const { messages, sock, context } = buffer;
  const lastMsg = messages[messages.length - 1];

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

  const runner = hasEarlierTrigger
    ? (async () => {
        for (const msg of messages) {
          try {
            await processMessage(sock, msg, context);
          } catch (err) {
            logger.error({ err, msgId: msg.id }, 'Error in buffered processMessage');
          }
        }
      })()
    : processMessage(sock, lastMsg, context).catch(err => {
        logger.error({ err, msgId: lastMsg.id }, 'Error in debounced processMessage');
      });

  // Safety timeout so a hung LLM never permanently locks a chat.
  let timeoutHandle;
  const withTimeout = Promise.race([
    runner,
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('processMessage in-flight timeout')),
        IN_FLIGHT_SAFETY_MS,
      );
    }),
  ]).catch(err => {
    logger.warn({ err: err.message, chatJid }, 'In-flight guard released with error');
  }).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    inFlight.delete(chatJid);
    // If new messages arrived while we were busy, flush them now as one batch.
    const pending = messageBuffers.get(chatJid);
    if (pending) {
      clearTimeout(pending.timer);
      flushBuffer(chatJid);
    }
  });

  inFlight.set(chatJid, withTimeout);
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

  // Track group participant changes
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    logger.debug({ groupJid: id, participants, action }, 'Group participants changed');
    for (const jid of participants) {
      if (action === 'add') {
        upsertPerson(jid, phoneFromJid(jid), null);
        upsertMember(id, jid, 'member');
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

  // Skip protocol/system messages with no content
  if (!msg.message) return;

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

  // Persist the sender
  if (senderJid && !isFromSelf) {
    upsertPerson(senderJid, phoneFromJid(senderJid), pushName);
  }

  // Persist the group and membership
  if (isGroup) {
    upsertGroup(chatJid, null);
    if (senderJid) {
      upsertMember(chatJid, senderJid);
    }
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
    // In-memory only — not persisted to SQLite; used by processMessage for
    // image-edit dispatch and any future quoted-media flows.
    quotedMessageType,
    quotedParticipant,
    quotedRawMessage,
    isFromSelf,
    timestamp: msg.messageTimestamp
      ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.low)
      : Math.floor(Date.now() / 1000),
    metadata: {
      mentionedJids,
      // Store raw message key for images so skills can re-download later
      ...(messageType === 'image' && { rawMsgKey: msg.key }),
    },
  };

  storeMessage(storedMsg);

  // Track reactions on bot messages for quality feedback
  if (messageType === 'reaction' && reactionTargetId && text && !isFromSelf) {
    try {
      const db = getDb();
      const target = db.prepare('SELECT is_from_self FROM messages WHERE id = ?').get(reactionTargetId);
      if (target?.is_from_self) {
        recordReaction(reactionTargetId, text, senderJid);
      }
    } catch {}
  }

  // Fire-and-forget media description — updates DB content asynchronously
  // This runs for all messages (including from self) so descriptions are available in context
  if (messageType === 'image' || messageType === 'sticker') {
    describeMedia(msg, sock, messageType).then(desc => {
      if (desc) {
        try {
          getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run(desc, storedMsg.id);
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
  }

  // Skip own messages and reactions for the response pipeline
  if (isFromSelf) return;
  if (messageType === 'reaction') return;

  // Buffer and debounce — waits for sender to finish before triggering response
  if ((isGroup || isDm) && processMessage) {
    bufferAndProcess(sock, storedMsg, { isGroup, isDm, rawMsg: msg, botJid: sock.user?.id, botLid: sock.user?.lid });
  }
}
