import { spawn } from 'child_process';
import { config, getPersona, getProviderKey } from '../utils/config.js';
import { logger as rootLogger } from '../utils/logger.js';
import { GEMINI_API_URL, geminiPost, recordGeminiUsage, budgetAllows } from './geminiMedia.js';

// `mod` puts these lines under AUDIO on the dashboard's live logs.
const logger = rootLogger.child({ mod: 'audio' });

// Transport via geminiPost (spec 007 R6/R7): GEMINI_API_KEY only, key in the
// x-goog-api-key header (never a key in the URL), `voice` budget (over it → null →
// the caller sends text), one llm_usage row per successful attempt.
const INTERACTIONS_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// In-memory rate limiter
let voiceCount = 0;
let rateWindowStart = Date.now();

// Non-verbal cues the 3.8 TTS models perform inline (spoken text is otherwise read
// verbatim). A small whitelist — anything else in angle brackets is stripped so a
// stray "<b>" or hallucinated tag is never read aloud.
const SPEECH_TAGS = ['laugh', 'chuckle', 'giggle', 'snicker', 'sigh', 'short pause', 'long pause',
  'breath', 'tsk', 'gasp', 'whispers', 'exhales', 'pff', 'phew'];
const MAX_SPEECH_TAGS = 3;

/** Matches any whitelisted speech tag — postProcess strips these from text replies. */
export const SPEECH_TAG_RE = new RegExp(`<\\s*(?:${SPEECH_TAGS.join('|')})\\s*>`, 'gi');

/**
 * Clean text for TTS: keep up to MAX_SPEECH_TAGS whitelisted tags (none for legacy
 * models, which would read them out), drop every other <…> and stray brackets.
 */
export function sanitizeSpeechText(text, { allowTags = true } = {}) {
  let kept = 0;
  const tags = [];
  return String(text || '')
    .replace(/<\s*([a-z][a-z -]{0,20}?)\s*>/gi, (_, tag) => {
      const t = tag.toLowerCase().replace(/\s+/g, ' ');
      if (allowTags && SPEECH_TAGS.includes(t) && kept < MAX_SPEECH_TAGS) {
        kept++;
        tags.push(`<${t}>`);
        return `\u0000${tags.length - 1}\u0000`; // placeholder survives the bracket strip
      }
      return ' ';
    })
    .replace(/[<>]/g, ' ')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => ` ${tags[i]} `)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Extract a marker of the given type from LLM output.
 * Searches for [TYPE: text] or [TYPE(mood): text] anywhere in the text.
 * Text before/after the marker becomes the caption.
 * Returns { text, caption, mood } or null if no marker found.
 */
function extractMarker(text, type) {
  if (!text || !config.voiceNote.enabled) return null;

  const head = `\\[${type}(?:\\(([^)\\]]{1,40})\\))?:`;
  const markerIdx = text.search(new RegExp(head, 'i'));
  if (markerIdx === -1) return null;

  const beforeMarker = text.slice(0, markerIdx).trim();
  const markerText = text.slice(markerIdx);

  let markerContent;
  let mood = null;
  let afterMarker = '';

  const closed = markerText.match(new RegExp(`^${head}\\s*(.+?)\\]\\s*\\n?([\\s\\S]*)$`, 'si'));
  if (closed) {
    mood = closed[1]?.trim() || null;
    markerContent = closed[2].trim();
    afterMarker = closed[3]?.trim() || '';
  } else {
    // LLM output truncated before closing `]` — treat the rest as the marker content.
    const open = markerText.match(new RegExp(`^${head}\\s*([\\s\\S]*)$`, 'i'));
    if (!open) return null;
    mood = open[1]?.trim() || null;
    markerContent = open[2].trim();
  }

  if (!markerContent) return null;

  const caption = [beforeMarker, afterMarker].filter(Boolean).join('\n');

  return { text: markerContent, caption, mood };
}

/** Extract [VOICE: text] / [VOICE(mood): text] marker. */
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

// Legacy `*-preview` TTS models are served by generateContent; 3.8+ only by the
// Interactions API.
const isLegacyTtsModel = (model) => /preview/.test(model);
const isCustomVoice = (voice) => /^voice(key)?_/.test(voice || '');

const ATTEMPT_TIMEOUT_MS = 15000;
const TOTAL_BUDGET_MS = 30000; // stays well inside the 90s in-flight guard

class TtsError extends Error {
  constructor(message, { status = 0, retryable = false, result = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.result = result; // the failed attempt's geminiPost result, for its ledger row
  }
}

/**
 * One TTS POST (no ledger row: the caller writes one per attempt, failed ones
 * from the TtsError's `result`). → { data, result } or throws TtsError.
 */
async function postJson(url, body, { model, caller }) {
  const result = await geminiPost({ label: 'voice', caller, model, url, body, timeoutMs: ATTEMPT_TIMEOUT_MS, record: false });
  if (result.ok) return { data: result.data, result };
  const status = /^http_(\d+)$/.exec(result.status)?.[1];
  if (status) {
    throw new TtsError(result.error || `HTTP ${status}`, { status: Number(status), retryable: Number(status) >= 500, result });
  }
  // timeout / network → retryable; no key / over budget → not
  throw new TtsError(result.error || result.status, { retryable: result.status === 'timeout' || result.status === 'error', result });
}

/** One synthesis call → { pcm: raw s16le 24kHz mono PCM Buffer, result } (result: for the ledger). */
async function synthesize({ model, voice, text, style, caller }) {
  if (isLegacyTtsModel(model)) {
    // Legacy models take the direction as a text prefix, and only prebuilt voices.
    const { data, result } = await postJson(`${GEMINI_API_URL}/${model}:generateContent`, {
      contents: [{ parts: [{ text: `${style}: ${sanitizeSpeechText(text, { allowTags: false })}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }, { model, caller });
    const b64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) throw new TtsError(`no audio in response: ${JSON.stringify(data).slice(0, 200)}`, { result: { ...result, ok: false, status: 'empty' } });
    return { pcm: Buffer.from(b64, 'base64'), result };
  }

  // 3.8+: text is spoken VERBATIM — direction goes in speech_metadata.style, never
  // in the text. audio/l16 returns headerless PCM (same shape as the legacy path).
  const { data, result } = await postJson(INTERACTIONS_API_URL, {
    model,
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text: sanitizeSpeechText(text),
        annotations: [{ type: 'speech_metadata', style }],
      }],
    }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice }] },
  }, { model, caller });
  const audio = data.steps?.flatMap(s => s.content || []).find(c => c.type === 'audio' && c.data);
  if (!audio) throw new TtsError(`no audio in response: ${JSON.stringify(data).slice(0, 200)}`, { result: { ...result, ok: false, status: 'empty' } });
  // The Interactions API's usage shape is unverified: without usageMetadata the row
  // carries no tokens and the price table's perCall (if any) applies.
  return { pcm: Buffer.from(audio.data, 'base64'), result };
}

function buildStyle({ sing, mood, cloned }) {
  if (sing) return ['singing, melodious and playful', mood].filter(Boolean).join(', ');
  // A cloned voice already carries its owner's delivery — don't layer the persona on it.
  const base = cloned
    ? 'casual and natural, like a quick WhatsApp voice note to close friends'
    : `casual and natural, like ${getPersona().voiceDescriptor} sending a quick WhatsApp voice note`;
  return [mood, base].filter(Boolean).join(', ');
}

/**
 * Generate a voice note using Gemini TTS.
 * @param {string} text - Text to speak or sing (may contain whitelisted <laugh>-style tags)
 * @param {{ sing?: boolean, ignoreRateLimit?: boolean, voiceId?: string, mood?: string }} [options]
 *   sing: singing mode; ignoreRateLimit: bypass the hourly cap (manual dashboard sends);
 *   voiceId: speak in this custom (e.g. cloned) voice — never falls back to another
 *   voice, since a stranger's voice would be worse than a text reply; mood: short
 *   delivery hint from a [VOICE(mood): …] marker.
 * Returns { buffer, duration, waveform, model, voice } or null on failure.
 */
export async function generateVoiceNote(text, { sing = false, ignoreRateLimit = false, voiceId = null, mood = null } = {}) {
  if (!getProviderKey('gemini')) {
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

  const cloned = !!voiceId;
  const style = buildStyle({ sing, mood: mood ? String(mood).slice(0, 40) : null, cloned });
  const primary = { model: cloned ? config.voiceNote.cloneModel : config.voiceNote.model, voice: voiceId || config.voiceNote.voiceName };
  // Primary twice (one retry on 5xx/timeout — seen transient 500s), then the
  // fallback model/voice. A custom voice can't run on a legacy model.
  const attempts = [primary, primary];
  if (!cloned) {
    const fb = { model: config.voiceNote.fallbackModel, voice: config.voiceNote.fallbackVoice };
    if (fb.model && !(isLegacyTtsModel(fb.model) && isCustomVoice(fb.voice))) attempts.push(fb);
  }
  if (isLegacyTtsModel(primary.model) && isCustomVoice(primary.voice)) {
    logger.warn({ model: primary.model, voice: primary.voice }, 'Custom voice ids need a 3.8+ TTS model — check VOICE_NOTE_MODEL');
  }

  const caller = cloned ? 'voice.clone' : sing ? 'voice.sing' : 'voice.note';
  if (!budgetAllows('voice', { provider: 'gemini', model: primary.model, caller })) return null;

  const startTime = Date.now();
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const { model, voice } = attempts[i];
    if (i > 0 && Date.now() - startTime > TOTAL_BUDGET_MS - ATTEMPT_TIMEOUT_MS) break;
    // Retry the same target only for transient errors; always allow the fallback.
    if (i === 1 && lastErr && !lastErr.retryable) continue;
    try {
      const { pcm: pcmBuffer, result: ledger } = await synthesize({ model, voice, text, style, caller });
      const fellBack = model !== primary.model || voice !== primary.voice;
      recordGeminiUsage({ label: 'voice', caller, model, result: ledger, fellBack });

      // Convert PCM to OGG/Opus for WhatsApp
      const result = await convertPcmToOggOpus(pcmBuffer);
      // Compute the waveform from the lossless PCM (before encoding) so the voice note
      // renders amplitude bars like a real person's, not a flat line.
      const waveform = pcmToWaveform(pcmBuffer);
      const latencyMs = Date.now() - startTime;

      voiceCount++;
      if (fellBack) {
        logger.warn({ model, voice, primaryModel: primary.model, primaryVoice: primary.voice, err: lastErr?.message }, 'voice_fallback: voice note generated on the fallback model/voice');
      }
      logger.info({ model, voice, cloned, sing, latencyMs, attempts: i + 1, duration: result.duration, bufferSize: result.buffer.length, voiceCount }, 'Voice note generated');

      return { ...result, waveform, model, voice };
    } catch (err) {
      lastErr = err instanceof TtsError ? err : new TtsError(err.message);
      // One ledger row per attempt, failed ones too (a TTS outage shows on the Usage page).
      if (lastErr.result) {
        const fellBack = model !== primary.model || voice !== primary.voice;
        recordGeminiUsage({ label: 'voice', caller, model, result: lastErr.result, fellBack });
      }
      logger.warn({ err: lastErr.message, model, voice, attempt: i + 1 }, 'Voice note attempt failed');
    }
  }
  logger.warn({ err: lastErr?.message, cloned }, 'Voice note generation failed');
  return null;
}
