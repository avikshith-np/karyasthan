// What linking does after WhatsApp closes the connection. Pure.
export const MAX_CODES = 3;
const TIMED_OUT = 408;              // the code ran out with no answer
const REFUSED = new Set([401, 403, 405]);

/**
 * status: the close's status code. Returns { exit, lines } to stop, else { delayMs, newCode }.
 * Asking too often can get a number limited, so codes stop at MAX_CODES.
 */
export function nextAfterClose(status, { codesShown, loggedOut, restartRequired }) {
  if (status === loggedOut && codesShown === 0) {
    return { exit: 3, lines: ['WhatsApp has logged this session out.', 'Setup can set it aside and link again: npm run setup'] };
  }
  if (REFUSED.has(status)) {
    return { exit: 5, lines: [`WhatsApp refused this number (${status}). It may be banned, or not on WhatsApp.`, 'Check it in the WhatsApp app on that phone.'] };
  }
  if (status === restartRequired) return { delayMs: 500 };   // normal, right after a successful link
  if (status === TIMED_OUT) {
    if (codesShown >= MAX_CODES) {
      return { exit: 4, lines: [`No link after ${MAX_CODES} codes. Asking too often can get a number limited, so this stopped.`, 'Try again in a few minutes: npm run setup'] };
    }
    return { delayMs: 1000, newCode: true };
  }
  return { delayMs: 10000 };
}

/** Is this message the owner's direct message, and its text? null when it isn't. */
export function ownerMessage(m, ownerDigits) {
  const key = m?.key;
  const remote = key?.remoteJid || '';
  if (!remote || key.fromMe || remote.endsWith('@g.us') || remote === 'status@broadcast' || remote.endsWith('@newsletter')) return null;
  const msg = m.message || {};
  const text = msg.conversation || msg.extendedTextMessage?.text || '';
  if (!text) return null;
  const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  const candidates = [remote, key.remoteJidAlt, key.senderPn, key.participantPn].filter(Boolean).filter((j) => /@s\.whatsapp\.net$/.test(j)).map(digits);
  if (ownerDigits) {
    if (candidates.includes(ownerDigits)) return { text, confirmed: true };
    // A LID with no phone beside it can't be matched yet: ask, without showing the text.
    if (!candidates.length) return { text, confirmed: false };
    return null;
  }
  return { text, confirmed: false, from: candidates[0] || '' };
}
