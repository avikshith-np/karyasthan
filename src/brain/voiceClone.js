import { spawn } from 'child_process';
import { config, getProviderKey, getPersona } from '../utils/config.js';
import { logger as rootLogger } from '../utils/logger.js';
import {
  getPersonVoice, savePersonVoice, revokePersonVoice, isVoiceDeletePending, listPendingVoiceDeletes, settleVoiceDelete,
} from '../memory/voiceStore.js';

// `mod` puts these lines under AUDIO on the dashboard's live logs.
const logger = rootLogger.child({ mod: 'audio' });

// Voice Replication (imitate voice) — clones a group member's voice so imitate mode
// can send voice notes that sound like them.
//
// Google requires two recordings from the SAME adult speaker: a natural sample and
// a reading of a fixed consent statement; it speaker-verifies them against each
// other. That is the whole consent model: a person can only be enrolled with a
// recording of themselves agreeing. Nothing here builds a voice from chat history.

const VOICES_API_URL = 'https://generativelanguage.googleapis.com/v1beta/voices';

// Must be read verbatim (ai.google.dev/gemini-api/docs/voice-replication).
export const CONSENT_STATEMENTS = {
  'en-US': 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.',
  'ml-IN': 'ഈ ശബ്ദത്തിന്റെ ഉടമ ഞാനാണ്, ഒരു സിന്തറ്റിക് വോയ്സ് മോഡൽ സൃഷ്ടിക്കാൻ ഈ ശബ്ദം ഉപയോഗിക്കുന്നതിന് ഞാൻ Google-ന് സമ്മതം നൽകുന്നു.',
};

// Which consent statement a persona's language reads most naturally in (persona.json
// `language`, free text). Anything unmatched gets the English one.
const CONSENT_LANGUAGE_WORDS = { 'ml-IN': ['malayalam', 'manglish'] };

/** The default consent language for enrollment: from the persona's language, else en-US. */
export function defaultConsentLanguage(personaLanguage = getPersona().language) {
  const lang = String(personaLanguage || '').toLowerCase();
  for (const [code, words] of Object.entries(CONSENT_LANGUAGE_WORDS)) {
    if (CONSENT_STATEMENTS[code] && words.some(w => lang.includes(w))) return code;
  }
  return 'en-US';
}

export const SAMPLE_MIN_SECONDS = 10;
export const SAMPLE_MAX_SECONDS = 30; // longer samples are trimmed, not rejected
export const CONSENT_MIN_SECONDS = 3;
export const CONSENT_MAX_SECONDS = 30;

export class VoiceCloneError extends Error {
  /** @param {string} userMessage - safe to show the person (DM / dashboard) */
  constructor(message, userMessage, code = 'error') {
    super(message);
    this.userMessage = userMessage;
    this.code = code;
  }
}

// Leading/trailing silence (mic fumbling before/after talking) trimmed, so the
// 30 s cap is spent on actual speech. Internal pauses are kept — they are part of
// how the person talks.
const TRIM_EDGE_SILENCE = [
  'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-45dB',
  'areverse',
  'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-45dB',
  'areverse',
].join(',');

/**
 * Any audio (WhatsApp ogg/opus, uploaded mp3/m4a/wav) → 24 kHz mono s16le WAV.
 * `trimSilence` drops edge silence BEFORE the maxSeconds cut. Returns { wav, seconds }.
 */
export function toWav24kMono(inputBuffer, { maxSeconds = SAMPLE_MAX_SECONDS, trimSilence = false } = {}) {
  return new Promise((resolve, reject) => {
    // Raw PCM out, header written by us: a WAV streamed to a pipe carries
    // 0xFFFFFFFF size fields, which the voices API rejects with a bare 400.
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0', ...(trimSilence ? ['-af', TRIM_EDGE_SILENCE] : []), '-t', String(maxSeconds),
      '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => { ffmpeg.kill('SIGKILL'); reject(new Error('ffmpeg conversion timed out')); }, 20000);
    const chunks = [];
    ffmpeg.stdout.on('data', (c) => chunks.push(c));
    ffmpeg.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input; 'close' reports it
    ffmpeg.on('error', (err) => { clearTimeout(timeout); reject(err); });
    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      const pcm = Buffer.concat(chunks);
      if (code !== 0 || pcm.length < 2) { reject(new Error(`ffmpeg exited with code ${code}`)); return; }
      resolve({ wav: Buffer.concat([wavHeader(pcm.length), pcm]), seconds: pcm.length / 48000 });
    });
    ffmpeg.stdin.end(inputBuffer);
  });
}

/** Canonical 44-byte RIFF header for 24 kHz mono 16-bit PCM of `dataBytes`. */
function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);       // fmt chunk size
  h.writeUInt16LE(1, 20);        // PCM
  h.writeUInt16LE(1, 22);        // mono
  h.writeUInt32LE(24000, 24);    // sample rate
  h.writeUInt32LE(48000, 28);    // byte rate
  h.writeUInt16LE(2, 32);        // block align
  h.writeUInt16LE(16, 34);       // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// GEMINI_API_KEY only (spec 007 R7), sent in the x-goog-api-key header — never in
// the URL, where it could reach error and request logs.
function apiKey() {
  const key = getProviderKey('gemini');
  if (!key) throw new VoiceCloneError('No Gemini API key', 'Voice cloning is not configured on this bot.', 'config');
  return key;
}

/**
 * POST /v1beta/voices (type=replicated, store=true). Returns { voiceId, expireTime }.
 */
export async function createReplicatedVoice({ sourceWav, consentWav, displayName, languageCode }) {
  const res = await fetch(VOICES_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      store: true,
      voice: {
        model: config.voiceNote.cloneModel,
        type: 'replicated',
        display_name: String(displayName || 'member').slice(0, 60),
        language_code: languageCode,
        replicated: {
          source_audio: { mime_type: 'audio/wav', data: sourceWav.toString('base64') },
          consent_audio: { mime_type: 'audio/wav', data: consentWav.toString('base64') },
        },
      },
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    // A failed speaker/consent check comes back wrapped in a 500 whose detail says
    // "Consent flow failed" — surface it as a retry-able user error, not an outage.
    if (/consent flow failed/i.test(body)) {
      const detail = (body.match(/Original error:\s*([^"\\]+)/) || [])[1] || body.slice(0, 1000);
      throw new VoiceCloneError(`consent check failed: ${detail}`,
        "Google couldn't verify the consent recording. Most common fixes: read the sentence SLOWLY and completely, word for word; record both notes back-to-back in the same quiet room, speaking the same way."
          + (languageCode !== 'en-US' ? ' The English sentence is often easier — send "voice enroll en".' : ''),
        'consent');
    }
    // 400 = the recordings themselves were rejected (e.g. no clear speech).
    if (res.status === 400) {
      throw new VoiceCloneError(`voices API 400: ${body.slice(0, 300)}`,
        'Google rejected the recordings. Both need to be clear speech from you: the sample talking normally, the consent note reading the sentence.',
        'input');
    }
    throw new VoiceCloneError(`voices API ${res.status}: ${body.slice(0, 300)}`,
      'Voice creation failed on Google’s side. Try again in a bit.', 'api');
  }
  const data = JSON.parse(body);
  if (!data.id) throw new VoiceCloneError(`voices API returned no id: ${body.slice(0, 200)}`, 'Voice creation failed.', 'api');
  return { voiceId: data.id, expireTime: data.expire_time ? Math.floor(Date.parse(data.expire_time) / 1000) : null };
}

/** DELETE /v1beta/voices/{id}. A 404 (already gone / expired) counts as success. */
export async function deleteVoice(voiceId) {
  const res = await fetch(`${VOICES_API_URL}/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey() },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`delete voice ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

/**
 * Full enrollment: convert + validate both recordings, create the voice, replace
 * any previous voice for this person. The recordings are never persisted — only
 * the resulting voice id. Throws VoiceCloneError (with .userMessage) on failure.
 */
export async function enrollVoice({ personJid, displayName, sourceAudio, consentAudio, languageCode = defaultConsentLanguage(), consentRef, via }) {
  if (!CONSENT_STATEMENTS[languageCode]) {
    throw new VoiceCloneError(`unsupported consent language ${languageCode}`, 'Unsupported consent language.', 'input');
  }

  let source, consent;
  try {
    source = await toWav24kMono(sourceAudio, { maxSeconds: SAMPLE_MAX_SECONDS, trimSilence: true });
    consent = await toWav24kMono(consentAudio, { maxSeconds: CONSENT_MAX_SECONDS });
  } catch (err) {
    throw new VoiceCloneError(`audio conversion failed: ${err.message}`, "Couldn't read that audio file.", 'input');
  }
  if (source.seconds < SAMPLE_MIN_SECONDS) {
    throw new VoiceCloneError(`sample too short (${source.seconds.toFixed(1)}s)`,
      `The sample needs at least ${SAMPLE_MIN_SECONDS} seconds of you talking normally (got ${Math.round(source.seconds)}s).`, 'input');
  }
  if (consent.seconds < CONSENT_MIN_SECONDS) {
    throw new VoiceCloneError(`consent too short (${consent.seconds.toFixed(1)}s)`,
      'The consent recording is too short. Read the whole sentence.', 'input');
  }

  // Replace, never accumulate: the project caps stored voices at 200, and the upsert
  // below overwrites the previous voice's row — the only record of its id. So the
  // previous voice is deleted at Google first, and a failed delete refuses the
  // enrollment with the old row intact (still active, or still marked for the
  // maintenance retry). A voice already revoked but pending its delete goes before
  // anything is created; an active one only once the new voice exists, so a failed
  // enrollment never costs the person their current voice.
  const previous = getPersonVoice(personJid, { includeInactive: true });
  if (previous?.voice_id && isVoiceDeletePending(previous) && !(await deleteAtGoogle(previous))) {
    throw new VoiceCloneError('previous voice still pending its Google delete',
      'Your previous voice is still being deleted at Google. Try again in a bit.', 'api');
  }

  const { voiceId, expireTime } = await createReplicatedVoice({
    sourceWav: source.wav, consentWav: consent.wav, displayName, languageCode,
  });

  if (previous?.voice_id && !previous.revoked_at) {
    try {
      await deleteVoice(previous.voice_id);
    } catch (err) {
      logger.warn({ err: err.message, voiceId: previous.voice_id }, 'Replaced voice could not be deleted at Google — enrollment refused, previous voice kept');
      await deleteVoice(voiceId).catch(e =>
        logger.warn({ err: e.message, voiceId }, 'New voice of a refused enrollment could not be deleted at Google — it expires on its own'));
      throw new VoiceCloneError(`replaced voice delete failed: ${err.message}`,
        'Couldn’t replace your previous voice at Google right now. Your current voice is unchanged; try again in a bit.', 'api');
    }
  }

  savePersonVoice({ personJid, voiceId, languageCode, consentRef, via, expireTime });
  logger.info({ personJid, voiceId, languageCode, via, sampleSeconds: Math.round(source.seconds) }, 'Voice enrolled');
  return { voiceId, expireTime };
}

/**
 * Revoke + delete a person's cloned voice. Returns true if one existed. The row is
 * revoked first (never used again, whatever Google says); a failed delete at Google
 * leaves it marked "Google delete pending" for the maintenance retry.
 */
export async function removeVoice(personJid, { reason = 'revoked' } = {}) {
  const row = getPersonVoice(personJid, { includeInactive: true });
  if (!row || row.revoked_at) return false;
  revokePersonVoice(personJid, reason, { pendingDelete: true });
  await deleteAtGoogle(row);
  logger.info({ personJid, voiceId: row.voice_id, reason }, 'Voice removed');
  return true;
}

async function deleteAtGoogle(row) {
  try {
    await deleteVoice(row.voice_id);
  } catch (err) {
    logger.warn({ err: err.message, voiceId: row.voice_id }, 'Voice revoked locally but Google delete failed — retried at maintenance');
    return false;
  }
  settleVoiceDelete(row.person_jid, row.voice_id);
  return true;
}

let retrying = null;   // the running all-rows retry (maintenance + retention share it)

/**
 * Delete at Google every revoked voice still marked pending (a failed delete, a
 * purge). Run after a purge (`personJids`: that person's identity forms only — a
 * merge can leave a second row under a merged-away form) and by the 6-hourly
 * maintenance. → { deleted, failed, pending } (`pending`: rows of those forms
 * still marked after the retry, whoever ran it).
 */
export function retryPendingVoiceDeletes({ personJids = null } = {}) {
  if (personJids) return retryPending(new Set(personJids));
  if (!retrying) retrying = retryPending(null).finally(() => { retrying = null; });
  return retrying;
}

async function retryPending(forms) {
  let deleted = 0;
  let failed = 0;
  for (const row of listPendingVoiceDeletes()) {
    if (forms && !forms.has(row.person_jid)) continue;
    if (await deleteAtGoogle(row)) deleted++; else failed++;
  }
  if (deleted || failed) logger.info({ deleted, failed }, 'Pending voice deletes retried');
  const pending = listPendingVoiceDeletes().filter(r => !forms || forms.has(r.person_jid)).length;
  return { deleted, failed, pending };
}
