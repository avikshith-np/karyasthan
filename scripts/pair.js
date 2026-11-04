// Links this install to a WhatsApp number with a pairing code, and ends by itself.
// Exit: 0 linked, 1 failed, 3 the session was logged out, 4 too many codes, 5 WhatsApp refuses this
// number, 78 the bot is running on this session, 130 stopped with Ctrl-C.
process.umask(0o077);

import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';

process.env.DOTENV_CONFIG_QUIET = 'true';
const { config } = await import('../src/utils/config.js');     // loads the project's .env
const { safePath } = await import('../src/utils/pathGuard.js');
const { takeLock } = await import('../src/utils/instanceLock.js');
const { nextAfterClose, MAX_CODES } = await import('./setup/link.js');

const PHONE = String(process.argv[2] || process.env.WA_PHONE_NUMBER || '').replace(/\D/g, '');
if (!PHONE) {
  console.error('\n  No WhatsApp number provided.');
  console.error('  Set WA_PHONE_NUMBER in .env, or pass it directly:');
  console.error('    node scripts/pair.js 15550100123   (country code and digits only)\n');
  process.exit(1);
}

// The dashboard's own pairing job runs under the bot that holds the lock, with the socket down.
const holder = takeLock(path.dirname(safePath(config.dbPath)), 'pair', { allow: (h) => h.pid === process.ppid });
if (holder) {
  console.error(`\n  It's already running (pid ${holder.pid}). Stop it first: two copies on one session knock each other off WhatsApp.\n`);
  process.exit(78);
}

process.on('SIGINT', () => {
  console.log('\n  Stopped. Not linked. Run this to try again:  npm run setup\n');
  process.exit(130);
});

const AUTH_DIR = safePath(config.authPath);
let codesShown = 0;
let waitingOnCode = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);  // AUTH_PATH, as the bot reads it
  try { fs.chmodSync(AUTH_DIR, 0o700); } catch { /* not ours */ }

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),  // must be macOS, not ubuntu
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // The QR event means the server is ready for a pairing request.
    if (qr && !waitingOnCode && !sock.authState.creds.registered) {
      try {
        const code = await sock.requestPairingCode(PHONE);
        waitingOnCode = true;
        codesShown += 1;
        console.log(`\n  On the phone with +${PHONE}, open WhatsApp:`);
        console.log('  Linked Devices → Link a Device → Link with phone number instead\n');
        // The dashboard's pairing page reads this exact label.
        console.log(`      PAIRING CODE: ${code}\n`);
        if (codesShown > 1) console.log(`  The last code ran out, so here's a new one (${codesShown} of ${MAX_CODES}).\n`);
        console.log('  Waiting. Ctrl-C to skip for now.\n');
      } catch (e) {
        console.log(`  ! WhatsApp refused the request: ${e.message}`);
        waitingOnCode = false;
      }
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      const next = nextAfterClose(status, { codesShown, loggedOut: DisconnectReason.loggedOut, restartRequired: DisconnectReason.restartRequired });
      if (next.exit != null) {
        console.error('');
        for (const line of next.lines) console.error(`  ${line}`);
        console.error('');
        process.exit(next.exit);
      }
      if (next.newCode) waitingOnCode = false;
      setTimeout(() => start(), next.delayMs);
    }

    if (connection === 'open') {
      console.log('\n  ✓ Linked. Nothing was sent.\n');
      setTimeout(() => process.exit(0), 3000);   // lets the last creds reach the disk
    }
  });
}

start();
