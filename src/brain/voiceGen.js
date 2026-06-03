import { spawn } from 'child_process';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// In-memory rate limiter
let voiceCount = 0;
let rateWindowStart = Date.now();

/**
 * Extract a marker of the given type from LLM output.
 * Searches for [TYPE: text] anywhere in the text.
 * Text before/after the marker becomes the caption.
 * Returns { text, caption } or null if no marker found.
 */
function extractMarker(text, type) {
  if (!text || !config.voiceNote.enabled) return null;

  const markerIdx = text.search(new RegExp(`\\[${type}:`, 'i'));
  if (markerIdx === -1) return null;

  const beforeMarker = text.slice(0, markerIdx).trim();
  const markerText = text.slice(markerIdx);

  let markerContent;
  let afterMarker = '';

  const closed = markerText.match(new RegExp(`^\\[${type}:\\s*(.+?)\\]\\s*\\n?([\\s\\S]*)$`, 'si'));
  if (closed) {
    markerContent = closed[1].trim();
    afterMarker = closed[2]?.trim() || '';
  } else {
    // LLM output truncated before closing `]` — treat the rest as the marker content.
    const open = markerText.match(new RegExp(`^\\[${type}:\\s*([\\s\\S]*)$`, 'i'));
    if (!open) return null;
    markerContent = open[1].trim();
  }

  if (!markerContent) return null;

  const caption = [beforeMarker, afterMarker].filter(Boolean).join('\n');

  return { text: markerContent, caption };
}

/** Extract [VOICE: text] marker. */
export function extractVoiceMarker(text) {
  return extractMarker(text, 'VOICE');
}

/** Extract [SING: lyrics] marker. */
export function extractSingMarker(text) {
  return extractMarker(text, 'SING');
}

/**
 * Convert raw PCM audio (s16le, 24kHz, mono) to OGG/Opus via ffmpeg.
 * Returns { buffer, duration } or null on failure.
 */
function convertPcmToOggOpus(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('ffmpeg conversion timed out'));
    }, 10000);

    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on',
      '-application', 'voip', '-f', 'ogg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];

    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      // Duration: PCM at 24kHz, 16-bit (2 bytes/sample), mono
      const duration = Math.round(pcmBuffer.length / 48000);
      resolve({ buffer, duration });
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Generate a voice note using Gemini TTS API.
 * @param {string} text - Text to speak or sing
 * @param {{ sing: boolean }} [options] - Set sing: true for singing mode
 * Returns { buffer, duration } or null on failure.
 */
export async function generateVoiceNote(text, { sing = false } = {}) {
  const apiKey = config.llm.geminiApiKey || config.llm.apiKey;
  if (!apiKey) {
    logger.warn('No Gemini API key for voice note generation');
    return null;
  }

  // Rate limit check
  const now = Date.now();
  if (now - rateWindowStart > 60 * 60 * 1000) {
    voiceCount = 0;
    rateWindowStart = now;
  }
  if (voiceCount >= config.voiceNote.maxPerHour) {
    logger.warn({ voiceCount, max: config.voiceNote.maxPerHour }, 'Voice note rate limit exceeded');
    return null;
  }

  const model = config.voiceNote.model;
  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

  try {
    const startTime = Date.now();

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: sing
              ? `Sing this in a fun, melodious way like ${getPersona().voiceDescriptor}: ${text}`
              : `Say casually like ${getPersona().voiceDescriptor}: ${text}`,
          }],
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: config.voiceNote.voiceName,
              },
            },
          },
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'Gemini TTS API error');
      return null;
    }

    const data = await res.json();
    const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;

    if (!inlineData?.data) {
      logger.warn({ data: JSON.stringify(data).slice(0, 300) }, 'Gemini TTS returned no audio data');
      return null;
    }

    const pcmBuffer = Buffer.from(inlineData.data, 'base64');

    // Convert PCM to OGG/Opus for WhatsApp
    const result = await convertPcmToOggOpus(pcmBuffer);
    const latencyMs = Date.now() - startTime;

    voiceCount++;
    logger.info({ model, latencyMs, duration: result.duration, bufferSize: result.buffer.length, voiceCount }, 'Voice note generated');

    return result;
  } catch (err) {
    logger.warn({ err: err.message, model }, 'Voice note generation failed');
    return null;
  }
}
