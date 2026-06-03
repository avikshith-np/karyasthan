import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const TRANSCRIPTION_PROMPT = 'Transcribe this audio message exactly as spoken. If the language is not English, keep it in the original language written in English script (transliteration). Return ONLY the transcription, nothing else.';

/**
 * Download and transcribe an audio message.
 * Uses OpenRouter if configured, otherwise falls back to native Gemini API.
 * Returns the transcription text, or null on failure.
 */
export async function transcribeAudio(rawMsg, sock) {
  let buffer;
  try {
    buffer = await downloadMediaMessage(rawMsg, 'buffer', {}, sock ? {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    } : undefined);
  } catch (err) {
    logger.warn({ err: err.message, msgId: rawMsg.key?.id }, 'Failed to download audio from WhatsApp');
    return null;
  }

  if (!buffer || buffer.length === 0) {
    logger.warn({ msgId: rawMsg.key?.id }, 'Empty audio buffer');
    return null;
  }

  const base64Audio = buffer.toString('base64');
  const rawMime = rawMsg.message?.audioMessage?.mimetype || 'audio/ogg';
  const mimetype = rawMime.split(';')[0].trim();
  const seconds = rawMsg.message?.audioMessage?.seconds || 0;

  logger.info({ msgId: rawMsg.key?.id, size: buffer.length, seconds, mimetype }, 'Transcribing audio');

  // Use OpenRouter if it's the configured provider or has an API key
  const useOpenRouter = config.llm.provider === 'openrouter' || config.llm.openrouterApiKey;
  // Use native Gemini if it's the configured provider or has a Gemini key
  const useGemini = !useOpenRouter && (config.llm.provider === 'gemini' || config.llm.geminiApiKey);

  if (useOpenRouter) {
    return transcribeViaOpenRouter(rawMsg, base64Audio, mimetype, seconds);
  } else if (useGemini) {
    return transcribeViaGemini(rawMsg, base64Audio, mimetype, seconds);
  } else {
    // Fallback: try OpenRouter with main API key, then Gemini
    const result = await transcribeViaOpenRouter(rawMsg, base64Audio, mimetype, seconds);
    if (result) return result;
    return transcribeViaGemini(rawMsg, base64Audio, mimetype, seconds);
  }
}

async function transcribeViaOpenRouter(rawMsg, base64Audio, mimetype, seconds) {
  const apiKey = config.llm.openrouterApiKey || config.llm.apiKey;
  if (!apiKey) {
    logger.warn('No OpenRouter API key for transcription');
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
            { type: 'text', text: TRANSCRIPTION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${mimetype};base64,${base64Audio}` },
            },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'OpenRouter transcription error');
      return null;
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      logger.warn({ msgId: rawMsg.key?.id, data: JSON.stringify(data).slice(0, 300) }, 'OpenRouter returned empty transcription');
      return null;
    }

    logger.info({ msgId: rawMsg.key?.id, seconds, transcriptLen: text.length }, 'Audio transcribed via OpenRouter');
    return text;
  } catch (err) {
    logger.warn({ err: err.message, msgId: rawMsg.key?.id }, 'OpenRouter transcription failed');
    return null;
  }
}

async function transcribeViaGemini(rawMsg, base64Audio, mimetype, seconds) {
  const apiKey = config.llm.geminiApiKey || config.llm.apiKey;
  if (!apiKey) {
    logger.warn('No Gemini API key for transcription');
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
            { text: TRANSCRIPTION_PROMPT },
            { inline_data: { mime_type: mimetype, data: base64Audio } },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'Gemini transcription API error');
      return null;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      logger.warn({ msgId: rawMsg.key?.id, data: JSON.stringify(data).slice(0, 300) }, 'Gemini returned empty transcription');
      return null;
    }

    logger.info({ msgId: rawMsg.key?.id, seconds, transcriptLen: text.length }, 'Audio transcribed via Gemini');
    return text;
  } catch (err) {
    logger.warn({ err: err.message, msgId: rawMsg.key?.id }, 'Gemini transcription failed');
    return null;
  }
}
