import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { config } from '../utils/config.js';
import { safePath } from '../utils/pathGuard.js';
import { logger } from '../utils/logger.js';

let sock = null;
let reconnectAttempts = 0;
let pairingCodeRequested = false;
const MAX_RECONNECT_ATTEMPTS = 15;

export function getSock() {
  return sock;
}

export async function connectToWhatsApp(onReady) {
  const authDir = safePath(config.authPath);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.macOS('Chrome'),
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR event = server is ready for pairing. Request pairing code here.
    if (qr && !pairingCodeRequested && !sock.authState.creds.registered) {
      if (!config.phoneNumber) {
        console.log('\n⚠️  Set WA_PHONE_NUMBER in .env (digits only, with country code, e.g. 919876543210)\n');
        process.exit(1);
      }
      pairingCodeRequested = true;
      try {
        const code = await sock.requestPairingCode(config.phoneNumber);
        console.log(`\n  ┌─────────────────────────────┐`);
        console.log(`  │  PAIRING CODE:  ${code}   │`);
        console.log(`  └─────────────────────────────┘`);
        console.log(`\n  On phone +${config.phoneNumber}:`);
        console.log(`  WhatsApp → Linked Devices → Link a Device`);
        console.log(`  Enter the code above.\n`);
      } catch (err) {
        pairingCodeRequested = false;
        logger.warn({ err: err.message }, 'Pairing code request failed');
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : lastDisconnect?.error?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({ statusCode, shouldReconnect }, 'Connection closed');

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 30000) + Math.random() * 3000;
        logger.info({ attempt: reconnectAttempts, delayMs: Math.round(delay) }, 'Reconnecting...');
        setTimeout(() => connectToWhatsApp(onReady), delay);
      } else if (!shouldReconnect) {
        logger.error('Logged out — run: rm -rf data/auth_info_baileys/ && node src/index.js');
      } else {
        logger.error({ attempts: reconnectAttempts }, 'Max reconnection attempts reached');
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      pairingCodeRequested = false;
      console.log('\n✅ Connected to WhatsApp!\n');
      logger.info('Connected to WhatsApp');
      if (onReady) onReady(sock);
    }
  });

  return sock;
}

export async function disconnectFromWhatsApp() {
  if (sock) {
    await sock.end(undefined);
    sock = null;
    logger.info('Disconnected from WhatsApp');
  }
}
