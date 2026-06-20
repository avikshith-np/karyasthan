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
 * Build a 64-byte 0..100 amplitude waveform from raw PCM (s16le, mono) — the same
 * shape WhatsApp renders for voice notes. Mirrors Baileys' getAudioWaveform math but
 * runs on the in-hand Int16 PCM (per-array max normalization makes Int16-vs-Float32
 * scale irrelevant), so no audio-decode dependency or re-decode is needed.
 */
export function pcmToWaveform(pcm) {
  const samples = 64;
  const sampleCount = Math.floor(pcm.length / 2); // s16le = 2 bytes/sample
  const blockSize = Math.floor(sampleCount / samples);
  if (blockSize < 1) return Buffer.alloc(samples); // audio too short → flat

  const filtered = new Array(samples);
  let max = 0;
  for (let i = 0; i < samples; i++) {
    const start = blockSize * i;
    let sum = 0;
    for (let j = 0; j < blockSize; j++) sum += Math.abs(pcm.readInt16LE((start + j) * 2));
    const avg = sum / blockSize;
    filtered[i] = avg;
    if (avg > max) max = avg;
  }

  const mult = max > 0 ? 1 / max : 0; // guard silence (Baileys divides by zero → NaN)
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const v = Math.floor(100 * filtered[i] * mult);
    out[i] = v > 100 ? 100 : v < 0 ? 0 : v; // belt-and-suspenders clamp
  }
  return out;
}

/**
 * Generate a voice note using Gemini TTS API.
 * @param {string} text - Text to speak or sing
 * @param {{ sing?: boolean, ignoreRateLimit?: boolean }} [options] - sing: true for
 *   singing mode; ignoreRateLimit: true to bypass the hourly cap (manual dashboard sends).
 * Returns { buffer, duration } or null on failure.
 */
export async function generateVoiceNote(text, { sing = false, ignoreRateLimit = false } = {}) {
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
  if (!ignoreRateLimit && voiceCount >= config.voiceNote.maxPerHour) {
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
    // Compute the waveform from the lossless PCM (before encoding) so the voice note
    // renders amplitude bars like a real person's, not a flat line.
    const waveform = pcmToWaveform(pcmBuffer);
    const latencyMs = Date.now() - startTime;

    voiceCount++;
    logger.info({ model, latencyMs, duration: result.duration, bufferSize: result.buffer.length, voiceCount }, 'Voice note generated');

    return { ...result, waveform };
  } catch (err) {
    logger.warn({ err: err.message, model }, 'Voice note generation failed');
    return null;
  }
}
