import { generateWAMessage, generateMessageIDV2 } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger.js';
import { config, getPersona } from '../utils/config.js';
import { storeMessage } from '../memory/messageStore.js';
import { getDb } from '../memory/db.js';

/**
 * Build a minimal Baileys-shaped quoted message from a stored DB row.
 * Used when the bot wants to reply-quote a plain-text message whose raw
 * Baileys payload wasn't cached (most non-image messages).
 * Returns null if the message can't be found.
 */
function buildQuotedFromDb(msgId, chatJid) {
  if (!msgId || !chatJid) return null;
  try {
    const row = getDb().prepare(
      'SELECT id, sender_jid, content, is_from_self FROM messages WHERE id = ? AND group_jid = ?'
    ).get(msgId, chatJid);
    if (!row) return null;
    return {
      key: {
        remoteJid: chatJid,
        id: row.id,
        participant: row.is_from_self ? undefined : row.sender_jid,
        fromMe: !!row.is_from_self,
      },
      message: { conversation: row.content || '' },
    };
  } catch (err) {
    logger.debug({ err: err.message, msgId }, 'buildQuotedFromDb failed');
    return null;
  }
}

/**
 * Send a text message to a chat.
 * @param {object} opts - { mentions?: string[], quotedKey?: { id } }
 */
export async function sendText(sock, jid, text, quotedMsg = null, opts = {}) {
  if (config.dryRun) {
    logger.info({ jid, text, quoted: !!quotedMsg, mentions: opts.mentions, replyTo: opts.quotedKey?.id }, '[DRY RUN] Would send message');
    return null;
  }

  const content = { text };
  if (opts.mentions?.length) content.mentions = opts.mentions;

  const options = {};

  if (quotedMsg?.rawMsg) {
    options.quoted = quotedMsg.rawMsg;
  } else if (opts.quotedKey?.id) {
    const synthesized = buildQuotedFromDb(opts.quotedKey.id, jid);
    if (synthesized) options.quoted = synthesized;
  }

  try {
    const sent = await sock.sendMessage(jid, content, options);

    // Store our own message
    storeMessage({
      id: sent?.key?.id || `self_${Date.now()}`,
      groupJid: jid,
      senderJid: sock.user?.id || 'self',
      senderName: getPersona().displayName,
      content: text,
      messageType: 'text',
      quotedId: null,
      quotedContent: null,
      isFromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
      metadata: {},
    });

    logger.info({ jid, textLen: text.length }, 'Message sent');
    return sent;
  } catch (err) {
    logger.error({ err, jid }, 'Failed to send message');
    return null;
  }
}

/**
 * Send an image message to a chat.
 * @param {object} opts - { mentions?: string[], quotedKey?: { id } }
 */
export async function sendImage(sock, jid, buffer, caption = '', quotedMsg = null, opts = {}) {
  if (config.dryRun) {
    logger.info({ jid, captionLen: caption?.length, bufferSize: buffer.length, mentions: opts.mentions }, '[DRY RUN] Would send image');
    return null;
  }

  const content = { image: buffer, caption: caption || undefined, mimetype: 'image/png' };
  if (opts.mentions?.length) content.mentions = opts.mentions;

  const options = {};

  if (quotedMsg?.rawMsg) {
    options.quoted = quotedMsg.rawMsg;
  } else if (opts.quotedKey?.id) {
    const synthesized = buildQuotedFromDb(opts.quotedKey.id, jid);
    if (synthesized) options.quoted = synthesized;
  }

  try {
    const sent = await sock.sendMessage(jid, content, options);

    storeMessage({
      id: sent?.key?.id || `self_${Date.now()}`,
      groupJid: jid,
      senderJid: sock.user?.id || 'self',
      senderName: getPersona().displayName,
      content: caption || '[generated image]',
      messageType: 'image',
      quotedId: null,
      quotedContent: null,
      isFromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
      metadata: {},
    });

    logger.info({ jid, captionLen: caption?.length }, 'Image sent');
    return sent;
  } catch (err) {
    logger.error({ err, jid }, 'Failed to send image');
    return null;
  }
}

/**
 * Send a sticker (animated WebP) to a chat.
 * @param {object} opts - { quotedKey?: { id } }
 */
export async function sendSticker(sock, jid, buffer, quotedMsg = null, opts = {}) {
  if (config.dryRun) {
    logger.info({ jid, bufferSize: buffer.length }, '[DRY RUN] Would send sticker');
    return null;
  }

  const content = { sticker: buffer };
  const options = {};

  if (quotedMsg?.rawMsg) {
    options.quoted = quotedMsg.rawMsg;
  } else if (opts.quotedKey?.id) {
    const synthesized = buildQuotedFromDb(opts.quotedKey.id, jid);
    if (synthesized) options.quoted = synthesized;
  }

  try {
    const sent = await sock.sendMessage(jid, content, options);

    storeMessage({
      id: sent?.key?.id || `self_${Date.now()}`,
      groupJid: jid,
      senderJid: sock.user?.id || 'self',
      senderName: getPersona().displayName,
      content: '[sticker]',
      messageType: 'sticker',
      quotedId: null,
      quotedContent: null,
      isFromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
      metadata: {},
    });

    logger.info({ jid, bytes: buffer.length }, 'Sticker sent');
    return sent;
  } catch (err) {
    logger.error({ err, jid }, 'Failed to send sticker');
    return null;
  }
}

/**
 * Send a GIF (delivered as MP4 with gifPlayback) to a chat.
 * @param {object} opts - { mentions?: string[], quotedKey?: { id } }
 */
export async function sendGif(sock, jid, buffer, caption = '', quotedMsg = null, opts = {}) {
  if (config.dryRun) {
    logger.info({ jid, captionLen: caption?.length, bufferSize: buffer.length, mentions: opts.mentions }, '[DRY RUN] Would send GIF');
    return null;
  }

  const content = {
    video: buffer,
    caption: caption || undefined,
    gifPlayback: true,
    mimetype: 'video/mp4',
  };
  if (opts.mentions?.length) content.mentions = opts.mentions;

  const options = {};

  if (quotedMsg?.rawMsg) {
    options.quoted = quotedMsg.rawMsg;
  } else if (opts.quotedKey?.id) {
    const synthesized = buildQuotedFromDb(opts.quotedKey.id, jid);
    if (synthesized) options.quoted = synthesized;
  }

  try {
    const sent = await sock.sendMessage(jid, content, options);

    storeMessage({
      id: sent?.key?.id || `self_${Date.now()}`,
      groupJid: jid,
      senderJid: sock.user?.id || 'self',
      senderName: getPersona().displayName,
      content: caption || '[gif]',
      messageType: 'video',
      quotedId: null,
      quotedContent: null,
      isFromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
      metadata: {},
    });

    logger.info({ jid, captionLen: caption?.length, bytes: buffer.length }, 'GIF sent');
    return sent;
  } catch (err) {
    logger.error({ err, jid }, 'Failed to send GIF');
    return null;
  }
}

/**
 * Send a voice note (push-to-talk audio) to a chat.
 * @param {object} opts - { quotedKey?: { id }, waveform?: Buffer }
 */
export async function sendVoiceNote(sock, jid, buffer, duration = 0, quotedMsg = null, opts = {}) {
  if (config.dryRun) {
    logger.info({ jid, bufferSize: buffer.length, duration }, '[DRY RUN] Would send voice note');
    return null;
  }

  const content = {
    audio: buffer,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
    seconds: duration,
  };
  const options = {};

  if (quotedMsg?.rawMsg) {
    options.quoted = quotedMsg.rawMsg;
  } else if (opts.quotedKey?.id) {
    const synthesized = buildQuotedFromDb(opts.quotedKey.id, jid);
    if (synthesized) options.quoted = synthesized;
  }

  try {
    // Build the message ourselves so we can attach the waveform: Baileys' high-level
    // sendMessage unconditionally overwrites audioMessage.waveform for ptt audio (via
    // getAudioWaveform, which needs the uninstalled audio-decode dep), wiping anything
    // we pass in the content. Generating + relaying manually lets us inject ours between
    // the two steps. This mirrors sendMessage's own generate→relay flow.
    const fullMsg = await generateWAMessage(jid, content, {
      logger,
      userJid: sock.user?.id,
      upload: sock.waUploadToServer,
      messageId: generateMessageIDV2(sock.user?.id),
      quoted: options.quoted,
    });
    if (opts.waveform && fullMsg.message?.audioMessage) {
      fullMsg.message.audioMessage.waveform = Buffer.from(opts.waveform);
    }
    await sock.relayMessage(jid, fullMsg.message, { messageId: fullMsg.key.id });
    const sent = fullMsg;

    storeMessage({
      id: sent?.key?.id || `self_${Date.now()}`,
      groupJid: jid,
      senderJid: sock.user?.id || 'self',
      senderName: getPersona().displayName,
      content: '[voice note]',
      messageType: 'audio',
      quotedId: null,
      quotedContent: null,
      isFromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
      metadata: {},
    });

    logger.info({ jid, duration }, 'Voice note sent');
    return sent;
  } catch (err) {
    logger.error({ err, jid }, 'Failed to send voice note');
    return null;
  }
}

/**
 * Send an emoji reaction to a message
 */
export async function sendReaction(sock, jid, messageId, emoji, participant = null) {
  if (config.dryRun) {
    logger.info({ jid, messageId, emoji }, '[DRY RUN] Would send reaction');
    return null;
  }

  try {
    const key = { remoteJid: jid, id: messageId, fromMe: false };
    if (participant) key.participant = participant;

    const sent = await sock.sendMessage(jid, {
      react: { text: emoji, key },
    });
    logger.debug({ jid, emoji }, 'Reaction sent');
    return sent;
  } catch (err) {
    logger.error({ err, jid }, 'Failed to send reaction');
    return null;
  }
}

/**
 * Send typing indicator (composing state)
 */
export async function sendTyping(sock, jid) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (err) {
    logger.debug({ err, jid }, 'Failed to send typing indicator');
  }
}

/**
 * Send recording indicator (voice note recording state)
 */
export async function sendRecording(sock, jid) {
  try {
    await sock.sendPresenceUpdate('recording', jid);
  } catch (err) {
    logger.debug({ err, jid }, 'Failed to send recording indicator');
  }
}

/**
 * Stop typing indicator
 */
export async function stopTyping(sock, jid) {
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    logger.debug({ err, jid }, 'Failed to stop typing indicator');
  }
}

/**
 * Mark messages as read
 */
export async function markRead(sock, keys) {
  try {
    await sock.readMessages(keys);
  } catch (err) {
    logger.debug({ err }, 'Failed to mark messages as read');
  }
}

/**
 * Set presence (available/unavailable)
 */
export async function setPresence(sock, type) {
  try {
    await sock.sendPresenceUpdate(type);
  } catch (err) {
    logger.debug({ err, type }, 'Failed to set presence');
  }
}
