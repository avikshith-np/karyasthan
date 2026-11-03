// Links this install to a WhatsApp number with a pairing code. Exits by itself:
// 0 linked, 1 failed, 130 stopped with Ctrl-C.
process.umask(0o077);

import fs from 'node:fs';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';

process.env.DOTENV_CONFIG_QUIET = 'true';
const { config } = await import('../src/utils/config.js');     // loads the project's .env
const { safePath } = await import('../src/utils/pathGuard.js');

const PHONE = String(process.argv[2] || process.env.WA_PHONE_NUMBER || '').replace(/\D/g, '');
if (!PHONE) {
  console.error('\n  No WhatsApp number provided.');
  console.error('  Set WA_PHONE_NUMBER in .env, or pass it directly:');
  console.error('    node scripts/pair.js 15550100123   (country code and digits only)\n');
  process.exit(1);
}

process.on('SIGINT', () => {
  console.log('\n  Stopped. Not linked. Run this to try again:  node scripts/pair.js\n');
  process.exit(130);
});

const AUTH_DIR = safePath(config.authPath);
let codeShown = false;

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
    if (qr && !codeShown && !sock.authState.creds.registered) {
      try {
        const code = await sock.requestPairingCode(PHONE);
        codeShown = true;
        console.log(`\n  On the phone with +${PHONE}, open WhatsApp:`);
        console.log('  Linked Devices → Link a Device → Link with phone number instead\n');
        console.log('      ┌─────────────────┐');
        console.log(`      │   ${String(code).padEnd(12)}  │`);
        console.log('      └─────────────────┘\n');
        console.log('  Waiting. Ctrl-C to skip for now.\n');
      } catch (e) {
        console.log(`  ! WhatsApp refused the request: ${e.message}`);
        codeShown = false;
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('\n  ! WhatsApp has logged this session out.');
        console.error(`    Move ${AUTH_DIR} aside, then run this again.\n`);
        process.exit(1);
      }
      // WhatsApp asks for a restart right after a successful link.
      setTimeout(() => start(), code === DisconnectReason.restartRequired ? 500 : 10000);
    }

    if (connection === 'open') {
      console.log('\n  Linked. Nothing was sent.\n');
      setTimeout(() => process.exit(0), 3000);   // lets the last creds reach the disk
    }
  });
}

start();
