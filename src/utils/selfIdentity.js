import { config } from './config.js';

// The bot's own WhatsApp identities (phone JID + LID) as bare digit strings, so
// code without the socket (e.g. transcript rendering) can recognise "@<digits>"
// mentions of the bot. Set on connect; WA_PHONE_NUMBER is the fallback.
const selfDigits = new Set();

const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

export function setSelfIdentity(user) {
  for (const jid of [user?.id, user?.lid]) {
    const d = digitsOf(jid);
    if (d) selfDigits.add(d);
  }
}

/** Digit strings that identify the bot itself in "@<digits>" mentions. */
export function getSelfIdDigits() {
  const out = new Set(selfDigits);
  const configured = String(config.phoneNumber || '').replace(/\D/g, '');
  if (configured) out.add(configured);
  return out;
}
