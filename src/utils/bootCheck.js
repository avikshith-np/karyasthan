// What stops a start before it touches WhatsApp. Pure; src/index.js acts on it.
// Exit 78 means "needs a person", and service files are set not to restart on it, so an unlinked
// bot under pm2 or systemd can't keep asking WhatsApp for codes that land in a log.
export const EXIT_NEEDS_PERSON = 78;

/**
 * facts: { linked, tty, phone, keyMissing (the replies provider's label, or ''), dashboard }
 * { stop: [lines] } or { noWhatsApp: true, lines } (dashboard stays up so it can link) or {}.
 */
export function bootVerdict({ linked, tty, phone, keyMissing, dashboard }) {
  if (keyMissing && !dashboard) {
    return { stop: [`No ${keyMissing} key, so it can't reply.`, 'Run: npm run setup'] };
  }
  if (linked) return {};
  if (tty) {
    if (!phone) return { stop: ['No WhatsApp number yet.', 'Run: npm run setup'] };
    return {};   // a person is here to read the code
  }
  if (dashboard) {
    return { noWhatsApp: true, lines: ['Not linked to WhatsApp, so not connecting.', 'Link it from the dashboard, or run in a terminal: npm run setup', 'Then restart it.'] };
  }
  return { stop: ['Not linked to WhatsApp yet, so not starting.', 'Run in a terminal: npm run setup   (choose Link WhatsApp)'] };
}

/** Baileys' creds.json body → is this session linked? */
export function credsAreLinked(text) {
  try {
    const c = JSON.parse(text);
    return Boolean(c.registered || c.me?.id);
  } catch { return false; }
}
