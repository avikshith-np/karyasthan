// Pairing script with all 3 Baileys bug fixes applied
import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';

const PHONE = process.argv[2] || process.env.WA_PHONE_NUMBER;
if (!PHONE) {
  console.error('\n  No WhatsApp number provided.');
  console.error('  Set WA_PHONE_NUMBER in .env, or pass it directly:');
  console.error('    node scripts/pair.js 919876543210   (country code + number, digits only)\n');
  process.exit(1);
}
let pairingDone = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./data/auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),  // Fix #2: must be macOS, not ubuntu
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Fix #3: request pairing code when QR event fires (server ready signal)
    if (qr && !pairingDone && !sock.authState.creds.registered) {
      try {
        const code = await sock.requestPairingCode(PHONE);
        pairingDone = true;
        console.log(`\n  ┌─────────────────────────────┐`);
        console.log(`  │  PAIRING CODE:  ${code}   │`);
        console.log(`  └─────────────────────────────┘`);
        console.log(`\n  On phone +${PHONE}:`);
        console.log(`  WhatsApp → Linked Devices → Link a Device`);
        console.log(`  Enter the code above.\n`);
      } catch (e) {
        console.log('  Pairing request failed:', e.message);
        pairingDone = false;
      }
    }

    if (connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => start(), 10000);
      }
    }

    if (connection === 'open') {
      console.log('\n  ✅ PAIRED SUCCESSFULLY!\n');
      console.log('  You can now run: node src/index.js');
      console.log('  Press Ctrl+C to exit.\n');
    }
  });
}

start();
