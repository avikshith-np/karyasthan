import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { describeInline } from './geminiMedia.js';

const MAX_BUFFER_SIZE = 5 * 1024 * 1024; // 5MB

const DESCRIPTION_PROMPT = `Describe this image briefly in 1-2 sentences, focusing on what's most notable.
If this is a food bill, restaurant receipt, or restaurant check, instead start with "BILL:" followed by each item and price, then subtotal, tax (if any), and total.
Example: "BILL: 2x Burger 450, 1x Fries 60, 1x Pasta 350. Subtotal 860, Tax 86, Total 946"`;

/**
 * Download and describe an image or sticker message.
 * Uses OpenRouter if its key is configured, otherwise the native Gemini API
 * (geminiMedia.describeInline: metered under the `senses` label, own keys only).
 * Returns the description text, or null on failure.
 */
export async function describeMedia(rawMsg, sock, mediaType) {
  let buffer;
  try {
    buffer = await downloadMediaMessage(rawMsg, 'buffer', {}, sock ? {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    } : undefined);
  } catch (err) {
    logger.warn({ err: err.message, msgId: rawMsg.key?.id, mediaType }, 'Failed to download media from WhatsApp');
    return null;
  }

  if (!buffer || buffer.length === 0) {
    logger.warn({ msgId: rawMsg.key?.id, mediaType }, 'Empty media buffer');
    return null;
  }

  if (buffer.length > MAX_BUFFER_SIZE) {
    logger.warn({ msgId: rawMsg.key?.id, size: buffer.length, mediaType }, 'Media too large, skipping description');
    return null;
  }

  const msgData = mediaType === 'sticker'
    ? rawMsg.message?.stickerMessage
    : rawMsg.message?.imageMessage;
  const rawMime = msgData?.mimetype || (mediaType === 'sticker' ? 'image/webp' : 'image/jpeg');
  const mimetype = rawMime.split(';')[0].trim();

  logger.info({ msgId: rawMsg.key?.id, size: buffer.length, mimetype, mediaType }, 'Describing media');

  const result = await describeInline({
    label: 'senses',
    caller: 'describe',
    model: config.transcriptionModel || 'gemini-3-flash-preview',
    prompt: DESCRIPTION_PROMPT,
    data: buffer,
    mime: mimetype,
  });
  if (!result) {
    logger.warn({ msgId: rawMsg.key?.id, mediaType }, 'Media description failed');
    return null;
  }

  logger.info({ msgId: rawMsg.key?.id, mediaType, descLen: result.text.length, provider: result.provider }, 'Media described');
  return result.text;
}
