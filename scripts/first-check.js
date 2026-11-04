// Proves the chain on one real message: it arrives, the reply model writes an answer. Nothing is
// sent, no read receipt, and only the owner's direct message is read.
// Exit: 0 proved, 2 no message came, 1 failed, 78 the bot is running on this session.
process.umask(0o077);

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import makeWASocket, { useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';

process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.LOG_LEVEL = 'silent';
const { config, getPersona } = await import('../src/utils/config.js');
const { safePath } = await import('../src/utils/pathGuard.js');
const { takeLock } = await import('../src/utils/instanceLock.js');
const { ownerMessage } = await import('./setup/link.js');

const WAIT_MS = Number(process.env.KARYASTHAN_FIRST_CHECK_MS || 180000);
const owner = String(process.env.OWNER_JIDS || '').split(',')[0].split('@')[0].replace(/\D/g, '');

const holder = takeLock(path.dirname(safePath(config.dbPath)), 'first-check');
if (holder) {
  console.error(`\n  It's already running (pid ${holder.pid}), so the check can't connect. Stop it first.\n`);
  process.exit(78);
}

const self = config.phoneNumber;
console.log(`\n  Send +${self} a WhatsApp message from your own phone.`);
console.log('  Waiting up to 3 minutes. Ctrl-C to skip.\n');
process.on('SIGINT', () => { console.log('\n  Skipped.\n'); process.exit(2); });
setTimeout(() => { console.log('  No message came.\n'); process.exit(2); }, WAIT_MS);

function askYes(q) {
  return new Promise((resolve) => {
    let input;
    try { input = fs.createReadStream('/dev/tty'); } catch { resolve(false); return; }
    input.on('error', () => resolve(false));
    const rl = readline.createInterface({ input, output: process.stdout });
    rl.question(`  ${q} (y/N) `, (a) => { rl.close(); input.destroy(); resolve(/^y/i.test(a.trim())); });
  });
}

let done = false;
async function handle(text) {
  console.log('  ✓ Got your message');
  console.log('  ✓ It would answer: direct messages always get a turn');
  const { callRole } = await import('../src/brain/llm.js');
  const { getIdentityText } = await import('../src/personality/systemPrompt.js');
  const r = await callRole('mouth', `${getIdentityText()}\n\nA friend just sent you this on WhatsApp. Reply the way you'd text back: short.`, text, { caller: 'setup.firstCheck', send: false, maxTokens: 256 });
  if (!r?.text) {
    console.log(`  ✗ The reply model didn't answer (${r?.status || 'no answer'}). Run: npm run doctor\n`);
    process.exit(1);
  }
  console.log(`  ✓ Wrote a reply with ${r.model || 'the reply model'}:\n`);
  console.log(`      "${String(r.text).trim().replace(/\s+/g, ' ').slice(0, 200)}"\n`);
  console.log(`  Not sent. ${getPersona().name} starts talking once it's running${config.warmupEnabled === false ? '.' : ', and on a new number it only reacts for the first 3 days.'}\n`);
  process.exit(0);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(safePath(config.authPath));
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection }) => { if (connection === 'close' && !done) setTimeout(start, 3000); });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || done) return;
    for (const m of messages) {
      const hit = ownerMessage(m, owner);
      if (!hit) continue;
      if (!hit.confirmed) {
        const who = hit.from ? `+${hit.from}` : 'a number WhatsApp is hiding';
        if (!await askYes(`A message came from ${who}. Was that you?`)) continue;
      }
      done = true;
      try { await handle(hit.text); } catch (err) { console.error(`  ✗ ${err.message}\n`); process.exit(1); }
      return;
    }
  });
}
start();
