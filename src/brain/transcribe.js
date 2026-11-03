import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../utils/config.js';
import { logger as rootLogger } from '../utils/logger.js';
import { describeInline } from './geminiMedia.js';

// `mod` puts these lines under AUDIO on the dashboard's live logs.
const logger = rootLogger.child({ mod: 'audio' });

const TRANSCRIPTION_PROMPT = 'Transcribe this audio message exactly as spoken. If the language is not English, keep it in the original language written in English script (transliteration). Return ONLY the transcription, nothing else.';

/**
 * Download and transcribe an audio message.
 * Uses OpenRouter if its key is configured, otherwise the native Gemini API
 * (geminiMedia.describeInline: metered under the `senses` label, own keys only).
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

  const rawMime = rawMsg.message?.audioMessage?.mimetype || 'audio/ogg';
  const mimetype = rawMime.split(';')[0].trim();
  const seconds = rawMsg.message?.audioMessage?.seconds || 0;

  logger.info({ msgId: rawMsg.key?.id, size: buffer.length, seconds, mimetype }, 'Transcribing audio');

  const result = await describeInline({
    label: 'senses',
    caller: 'transcribe',
    model: config.transcriptionModel || 'gemini-3-flash-preview',
    prompt: TRANSCRIPTION_PROMPT,
    data: buffer,
    mime: mimetype,
  });
  if (!result) {
    logger.warn({ msgId: rawMsg.key?.id }, 'Audio transcription failed');
    return null;
  }

  logger.info({ msgId: rawMsg.key?.id, seconds, transcriptLen: result.text.length, provider: result.provider }, 'Audio transcribed');
  return result.text;
}
