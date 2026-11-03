import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger.js';
import { getDb } from '../memory/db.js';
import { getPerson } from '../memory/peopleStore.js';
import { resolvePerson } from '../memory/identity.js';
import { getPersonVoice } from '../memory/voiceStore.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { sendText, sendVoiceNote } from './actions.js';
import { generateVoiceNote } from '../brain/voiceGen.js';
import {
  enrollVoice, removeVoice, VoiceCloneError, CONSENT_STATEMENTS,
  SAMPLE_MIN_SECONDS, SAMPLE_MAX_SECONDS,
} from '../brain/voiceClone.js';

// DM-only voice enrollment for imitate-voice. A member enrolls THEMSELVES:
//
//   voice enroll [en|ml]  → bot asks for (1) a natural sample, (2) the consent line
//   voice status          → is a voice enrolled?
//   voice test            → hear a sample of your own cloned voice (sent only to you)
//   voice delete          → revoke + delete the cloned voice at Google
//   voice cancel          → abandon an in-progress enrollment
//
// Only fresh push-to-talk notes are accepted (no forwards, no audio files), so a
// person can't be enrolled from someone else's forwarded voice notes. Google then
// speaker-verifies the sample against the consent recording.

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map(); // personJid → { chatJid, step: 'sample'|'consent', lang, sample, expiresAt }
const chains = new Map();   // chatJid → promise of the step in progress

// Transcripts of the consent statement (script or transliterated Malayalam, English).
const CONSENT_LIKE_RE = /synthetic\s*voice|സിന്തറ്റിക്|consent to google|google-?(?:inu|nu|ന്)\s*(?:sammatham|സമ്മതം)|shabdathinte\s*udama/i;

const COMMAND_RE = /^\s*voice\s+(enroll|enrol|status|delete|remove|cancel|test)(?:\s+(en|ml))?\s*[.!]*\s*$/i;

/** In-progress enrollment for a person (diagnostics/tests). */
export function getEnrollmentSession(personJid) {
  const s = sessions.get(personJid);
  return s ? { step: s.step, lang: s.lang, expiresAt: s.expiresAt } : null;
}

function reply(sock, jid, text) {
  return sendText(sock, jid, text).catch(err =>
    logger.warn({ err: err.message, jid }, 'Voice enrollment reply failed'));
}

// Enrollment recordings are only for Google's voice check. Their transcripts were
// already stored as ordinary messages; blank them so they never become chat
// context or imitation material (a sample story got read back verbatim once).
function redactEnrollmentAudio(msgId) {
  try {
    getDb().prepare(`UPDATE messages SET content = '[voice enrollment recording]' WHERE id = ?`).run(msgId);
  } catch (err) {
    logger.warn({ err: err.message, msgId }, 'Failed to redact enrollment recording transcript');
  }
}

function isInAnyGroup(personJid) {
  return !!getDb().prepare(`SELECT 1 FROM group_members WHERE person_jid = ? LIMIT 1`).get(personJid);
}

function consentPrompt(lang) {
  return `Got it ✅ Now step 2: record a voice note reading this sentence *exactly*, in the same place and on the same phone:\n\n"${CONSENT_STATEMENTS[lang]}"`;
}

/**
 * Claim a DM message for the enrollment flow. Synchronous decision so the caller
 * can skip the normal response pipeline; the actual work runs in the background.
 * Returns true when the message was handled here.
 */
export function claimVoiceEnrollment(sock, storedMsg, rawMsg) {
  const chatJid = storedMsg.groupJid;
  const text = storedMsg.messageType === 'text' ? String(rawMsg.message?.conversation || rawMsg.message?.extendedTextMessage?.text || '') : '';
  const cmd = text.match(COMMAND_RE);
  const isAudio = storedMsg.messageType === 'audio';
  // Session lookup by the raw sender first (resolution to LID is async); sessions
  // are keyed by the resolved JID but we also index by chat for this check.
  const pending = [...sessions.values()].find(s => s.chatJid === chatJid && s.expiresAt > Date.now());
  // A consent reading with no live session (sessions are in-memory: a restart or
  // the 15-min expiry drops them). Never let it reach the LLM, which would happily
  // "confirm" an enrollment that never happened.
  if (isAudio && !pending && CONSENT_LIKE_RE.test(storedMsg.content || '')) {
    redactEnrollmentAudio(storedMsg.id);
    reply(sock, chatJid, 'Your voice setup session expired before that last step, so nothing was saved. Send "voice enroll" to start again — it only takes a minute.');
    return true;
  }
  if (!cmd && !(isAudio && pending)) return false;
  if (isAudio) redactEnrollmentAudio(storedMsg.id);

  // Serialize per chat: the sample note is still downloading when the consent note
  // may already arrive — each step must see the previous step's state.
  const prev = chains.get(chatJid) || Promise.resolve();
  const next = prev
    .then(() => run(sock, chatJid, storedMsg, rawMsg, cmd, pending))
    .catch(err => logger.warn({ err: err.message, chatJid }, 'Voice enrollment step failed'));
  chains.set(chatJid, next);
  next.finally(() => { if (chains.get(chatJid) === next) chains.delete(chatJid); });
  return true;
}

async function run(sock, chatJid, storedMsg, rawMsg, cmd, pending) {
  // Revoking (delete) and checking (status) must always work — only NEW
  // enrollments are gated by the kill switch.
  const action0 = cmd?.[1]?.toLowerCase();
  const alwaysAllowed = action0 === 'delete' || action0 === 'remove' || action0 === 'status';
  if (!alwaysAllowed && !isSkillEnabled('imitate-voice')) {
    await reply(sock, chatJid, 'Voice cloning is switched off right now.');
    return;
  }

  // The canonical person (the id group_members and person_voice use), whichever
  // JID form the DM arrived as. Unknown → refuse (never guess an identity).
  const personJid = resolvePerson(storedMsg.senderJid || chatJid);
  if (!personJid) {
    await reply(sock, chatJid, "I couldn't match this chat to your group profile, so I can't set up a voice for you.");
    return;
  }

  if (cmd) {
    const action = cmd[1].toLowerCase();
    if (action === 'status') {
      const v = getPersonVoice(personJid);
      await reply(sock, chatJid, v
        ? `Your voice is enrolled (since ${new Date(v.created_at * 1000).toDateString()}). Send "voice delete" to remove it.`
        : 'No voice enrolled. Send "voice enroll" to set one up.');
      return;
    }
    if (action === 'delete' || action === 'remove') {
      sessions.delete(personJid);
      const removed = await removeVoice(personJid, { reason: 'owner request (dm)' });
      await reply(sock, chatJid, removed ? 'Done — your cloned voice is deleted 🗑️' : 'You had no voice enrolled.');
      return;
    }
    if (action === 'test') {
      // Owner-only preview: the sample goes back to the person whose voice it is.
      const v = getPersonVoice(personJid);
      if (!v) { await reply(sock, chatJid, 'No voice enrolled. Send "voice enroll" to set one up.'); return; }
      const line = v.language_code === 'en-US'
        ? "Hey, this is a quick test of my voice. <short pause> How does it sound? <chuckle>"
        : 'ഹലോ, ഇത് എന്റെ ശബ്ദത്തിന്റെ ഒരു ടെസ്റ്റ് ആണ്. <short pause> എങ്ങനെയുണ്ട്, ശരിക്കും ഞാൻ തന്നെ പോലെ ഉണ്ടോ? <chuckle>';
      const note = await generateVoiceNote(line, { voiceId: v.voice_id });
      if (!note) { await reply(sock, chatJid, "Couldn't generate the sample right now — try again in a bit."); return; }
      await sendVoiceNote(sock, chatJid, note.buffer, note.duration, null, { waveform: note.waveform, transcript: line });
      return;
    }
    if (action === 'cancel') {
      sessions.delete(personJid);
      await reply(sock, chatJid, 'Voice enrollment cancelled.');
      return;
    }
    // enroll
    if (!isInAnyGroup(personJid)) {
      await reply(sock, chatJid, 'Voice enrollment is only for members of my groups.');
      return;
    }
    const lang = cmd[2]?.toLowerCase() === 'en' ? 'en-US' : 'ml-IN';
    sessions.set(personJid, { chatJid, step: 'sample', lang, sample: null, expiresAt: Date.now() + SESSION_TTL_MS });
    await reply(sock, chatJid,
      `🎙️ Voice setup — this lets me send voice notes in *your* voice, only while I'm imitating you in a group. You can delete it anytime with "voice delete".\n\n` +
      `Step 1: record a voice note (hold the mic, don't forward) of about ${SAMPLE_MAX_SECONDS} seconds (minimum ${SAMPLE_MIN_SECONDS}) just talking normally — about your day, anything. The closer to ${SAMPLE_MAX_SECONDS}s, the better your voice will sound. Quiet room, phone at normal distance, your normal voice.\n\n` +
      `(Send "voice cancel" to stop.${lang === 'ml-IN' ? ' Want the consent line in English? Send "voice enroll en".' : ''})`);
    return;
  }

  // Audio for an in-progress session.
  const session = sessions.get(personJid) || pending;
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(personJid);
    return;
  }
  const audio = rawMsg.message?.audioMessage;
  if (!audio?.ptt || audio.contextInfo?.isForwarded) {
    await reply(sock, chatJid, 'That needs to be a fresh voice note recorded right here (hold the mic button) — not a forwarded message or audio file.');
    return;
  }

  let buffer;
  try {
    buffer = await downloadMediaMessage(rawMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  } catch (err) {
    logger.warn({ err: err.message }, 'Enrollment audio download failed');
    await reply(sock, chatJid, "Couldn't download that voice note — try sending it again.");
    return;
  }

  if (session.step === 'sample') {
    if ((audio.seconds || 0) < SAMPLE_MIN_SECONDS) {
      await reply(sock, chatJid, `That was only ${audio.seconds || 0}s — I need at least ${SAMPLE_MIN_SECONDS} seconds of you talking. Try again.`);
      return;
    }
    session.sample = buffer;
    session.step = 'consent';
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(personJid, session);
    await reply(sock, chatJid, consentPrompt(session.lang));
    return;
  }

  // step === 'consent'
  sessions.delete(personJid); // one shot per session; buffers are dropped with it
  await reply(sock, chatJid, 'Setting up your voice… ⏳');
  const person = getPerson(personJid);
  try {
    await enrollVoice({
      personJid,
      displayName: person?.push_name || person?.real_name || personJid,
      sourceAudio: session.sample,
      consentAudio: buffer,
      languageCode: session.lang,
      consentRef: storedMsg.id,
      via: 'dm',
    });
    await reply(sock, chatJid, 'Your voice is ready ✅ I will only use it while imitating you in a group, for a few notes per session. Send "voice test" to hear it, "voice delete" anytime to remove it.');
  } catch (err) {
    const userMsg = err instanceof VoiceCloneError ? err.userMessage : 'Something went wrong setting up your voice.';
    logger.warn({ err: err.message, personJid }, 'Voice enrollment failed');
    await reply(sock, chatJid, `${userMsg}\n\nSend "voice enroll" to start over.`);
  }
}
