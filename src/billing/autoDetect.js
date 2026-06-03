import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { parseReceipt } from './receiptParser.js';
import { getBillByImage, createBillSplit } from '../memory/billStore.js';
import { logger } from '../utils/logger.js';

/**
 * Auto-detect and store a bill from an image message.
 * Called after describeMedia identifies an image as a bill (description starts with "BILL:").
 * Runs silently in the background — no messages sent to the group.
 *
 * @param {object} rawMsg - Raw WhatsApp message (for media download)
 * @param {object} sock - Baileys socket
 * @param {object} storedMsg - Normalized stored message { id, groupJid, ... }
 */
export async function autoDetectBill(rawMsg, sock, storedMsg) {
  // Skip if already parsed
  const existing = getBillByImage(storedMsg.id);
  if (existing) {
    logger.debug({ msgId: storedMsg.id }, 'autoDetect: bill already parsed for this image');
    return;
  }

  // Download the image
  let base64, mimetype;
  try {
    const buffer = await downloadMediaMessage(
      rawMsg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
    if (!buffer || buffer.length === 0) return;
    base64 = buffer.toString('base64');
    const imgMsg = rawMsg.message?.imageMessage;
    mimetype = imgMsg?.mimetype?.split(';')[0]?.trim() || 'image/jpeg';
  } catch (err) {
    logger.debug({ err: err.message, msgId: storedMsg.id }, 'autoDetect: failed to download image');
    return;
  }

  // Parse with Gemini
  const bill = await parseReceipt(base64, mimetype);
  if (!bill) {
    logger.debug({ msgId: storedMsg.id }, 'autoDetect: image not a bill');
    return;
  }

  // Store in DB
  const id = createBillSplit(
    storedMsg.groupJid,
    storedMsg.id,
    bill.restaurant,
    bill,
    'PARSED',
    null,
  );

  logger.info({
    billSplitId: id,
    msgId: storedMsg.id,
    restaurant: bill.restaurant,
    items: bill.items.length,
  }, 'autoDetect: bill stored');
}
