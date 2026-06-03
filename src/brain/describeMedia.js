import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MAX_BUFFER_SIZE = 5 * 1024 * 1024; // 5MB

const DESCRIPTION_PROMPT = `Describe this image briefly in 1-2 sentences, focusing on what's most notable.
If this is a food bill, restaurant receipt, or restaurant check, instead start with "BILL:" followed by each item and price, then subtotal, tax (if any), and total.
Example: "BILL: 2x Butter Chicken ₹450, 1x Naan ₹60, 1x Biryani ₹350. Subtotal ₹860, Tax ₹86, Total ₹946"`;

/**
 * Download and describe an image or sticker message.
 * Uses OpenRouter if configured, otherwise falls back to native Gemini API.
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

  const base64 = buffer.toString('base64');
  const msgData = mediaType === 'sticker'
    ? rawMsg.message?.stickerMessage
    : rawMsg.message?.imageMessage;
  const rawMime = msgData?.mimetype || (mediaType === 'sticker' ? 'image/webp' : 'image/jpeg');
  const mimetype = rawMime.split(';')[0].trim();

  logger.info({ msgId: rawMsg.key?.id, size: buffer.length, mimetype, mediaType }, 'Describing media');

  const useOpenRouter = config.llm.provider === 'openrouter' || config.llm.openrouterApiKey;
  const useGemini = !useOpenRouter && (config.llm.provider === 'gemini' || config.llm.geminiApiKey);

  if (useOpenRouter) {
    return describeViaOpenRouter(rawMsg, base64, mimetype, mediaType);
  } else if (useGemini) {
    return describeViaGemini(rawMsg, base64, mimetype, mediaType);
  } else {
    const result = await describeViaOpenRouter(rawMsg, base64, mimetype, mediaType);
    if (result) return result;
    return describeViaGemini(rawMsg, base64, mimetype, mediaType);
  }
}

async function describeViaOpenRouter(rawMsg, base64, mimetype, mediaType) {
  const apiKey = config.llm.openrouterApiKey || config.llm.apiKey;
  if (!apiKey) {
    logger.warn('No OpenRouter API key for media description');
    return null;
  }

  const model = config.transcriptionModel || 'gemini-3-flash-preview';

  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: DESCRIPTION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${mimetype};base64,${base64}` },
            },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'OpenRouter media description error');
      return null;
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      logger.warn({ msgId: rawMsg.key?.id, data: JSON.stringify(data).slice(0, 300) }, 'OpenRouter returned empty description');
      return null;
    }

    logger.info({ msgId: rawMsg.key?.id, mediaType, descLen: text.length }, 'Media described via OpenRouter');
    return text;
  } catch (err) {
    logger.warn({ err: err.message, msgId: rawMsg.key?.id }, 'OpenRouter media description failed');
    return null;
  }
}

async function describeViaGemini(rawMsg, base64, mimetype, mediaType) {
  const apiKey = config.llm.geminiApiKey || config.llm.apiKey;
  if (!apiKey) {
    logger.warn('No Gemini API key for media description');
    return null;
  }

  const model = config.transcriptionModel || 'gemini-3-flash-preview';
  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: DESCRIPTION_PROMPT },
            { inline_data: { mime_type: mimetype, data: base64 } },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'Gemini media description API error');
      return null;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      logger.warn({ msgId: rawMsg.key?.id, data: JSON.stringify(data).slice(0, 300) }, 'Gemini returned empty description');
      return null;
    }

    logger.info({ msgId: rawMsg.key?.id, mediaType, descLen: text.length }, 'Media described via Gemini');
    return text;
  } catch (err) {
    logger.warn({ err: err.message, msgId: rawMsg.key?.id }, 'Gemini media description failed');
    return null;
  }
}
