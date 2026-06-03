#!/usr/bin/env node
// Guided first-run setup wizard for this WhatsApp agent.
//
// Interactive and IDEMPOTENT: re-running skips prompts whose values already
// exist and confirms before overwriting generated files. Uses ONLY Node
// built-ins (plus bcryptjs, an existing project dependency, for the optional
// dashboard password hash). Invoked via `npm run setup` and by install.sh.
//
//   STEP 0  preflight (Node >= 20, resolve project root)
//   STEP 1  .env       create from .env.example, prompt for the essentials
//   STEP 2  persona    build persona.json + render identity.md from template
//   STEP 3  database   run migrations
//   STEP 4  pairing    optionally launch the WhatsApp pairing flow

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// STEP 0 — Preflight
// --------------------------------------------------------------------------
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 20) {
  console.error(
    `\n  This wizard requires Node.js 20 or newer.\n` +
    `  You are running Node ${process.versions.node}.\n` +
    `  Please upgrade (see https://nodejs.org) and re-run \`npm run setup\`.\n`,
  );
  process.exit(1);
}

// scripts/ lives directly under the project root.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');
const PERSONALITY_DIR = path.join(PROJECT_ROOT, 'src', 'personality');
const PERSONA_PATH = path.join(PERSONALITY_DIR, 'persona.json');
const IDENTITY_PATH = path.join(PERSONALITY_DIR, 'identity.md');
const IDENTITY_TEMPLATE_PATH = path.join(PERSONALITY_DIR, 'identity.template.md');

const rl = readline.createInterface({ input, output });

// --------------------------------------------------------------------------
// Small prompt helpers
// --------------------------------------------------------------------------

/** Ask a question, returning the trimmed answer (or `def` on blank input). */
async function ask(question, def = '') {
  const suffix = def ? ` [${def}]` : '';
  const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
  return answer || def;
}

/** Ask a y/N question. Defaults to no unless `defaultYes`. */
async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? '(Y/n)' : '(y/N)';
  const answer = (await rl.question(`  ${question} ${hint} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/**
 * Read a secret without echoing it to the terminal. Falls back to a plain
 * (visible) read if the TTY can't be muted — better a visible password than
 * a crash. Built on raw readline so we stay dependency-free.
 */
function askSecret(question) {
  return new Promise((resolve) => {
    const canMute = input.isTTY && typeof input.setRawMode === 'function';
    if (!canMute) {
      rl.question(`  ${question}: `).then((a) => resolve(a.trim()));
      return;
    }
    output.write(`  ${question}: `);
    input.setRawMode(true);
    input.resume();
    let buf = '';
    const onData = (chunk) => {
      const ch = chunk.toString('utf8');
      for (const c of ch) {
        // Enter / EOT (Ctrl-D) -> finish.
        if (c === '\n' || c === '\r' || c === '\u0004') {
          input.setRawMode(false);
          input.removeListener('data', onData);
          output.write('\n');
          resolve(buf.trim());
          return;
        }
        // Ctrl-C -> abort.
        if (c === '\u0003') {
          input.setRawMode(false);
          output.write('\n');
          process.exit(130);
        }
        // Backspace / DEL.
        if (c === '\u007f' || c === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        buf += c;
        output.write('*');
      }
    };
    input.on('data', onData);
  });
}

// --------------------------------------------------------------------------
// .env read / write helpers — surgical, preserve comments and unrelated keys
// --------------------------------------------------------------------------

/** Parse a .env-ish string into a flat KEY -> value map (strips inline #comments only for our reads). */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Drop a trailing inline comment if the value isn't quoted.
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

/**
 * Apply `updates` (KEY -> value) to a .env file body: replace existing KEY=
 * lines in place, append any missing keys at the end. Never deletes or
 * reorders unrelated lines/comments.
 */
function applyEnvUpdates(body, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return body;
  const seen = new Set();
  const lines = body.split('\n');
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = line.indexOf('=');
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  const missing = keys.filter((k) => !seen.has(k));
  if (missing.length > 0) {
    // Ensure exactly one trailing newline before appending.
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
      newLines.pop();
    }
    newLines.push('');
    newLines.push('# Added by setup wizard');
    for (const k of missing) newLines.push(`${k}=${updates[k]}`);
  }
  let result = newLines.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return result;
}

// --------------------------------------------------------------------------
// Steps
// --------------------------------------------------------------------------

const API_KEY_FOR_PROVIDER = {
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'LLM_API_KEY',
  openai: 'LLM_API_KEY',
};

async function stepEnv() {
  console.log('\n── Step 1/4 · Environment (.env) ───────────────────────────\n');

  if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
    console.log('  ! .env.example not found — skipping .env configuration.');
    return;
  }

  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    console.log('  Created .env from .env.example');
  } else {
    console.log('  .env already exists — only filling in missing values.');
  }

  let body = fs.readFileSync(ENV_PATH, 'utf-8');
  const current = parseEnv(body);
  const updates = {};

  // Helper: only prompt when the key is currently missing/empty.
  const isSet = (k) => current[k] !== undefined && current[k] !== '';

  // --- LLM provider ---
  let provider = current.LLM_PROVIDER;
  if (!isSet('LLM_PROVIDER')) {
    provider = (await ask('LLM provider (gemini/openrouter/anthropic/openai/ollama)', 'gemini')).toLowerCase();
    updates.LLM_PROVIDER = provider;
  } else {
    provider = provider.toLowerCase();
    console.log(`  LLM provider already set to "${provider}" — keeping it.`);
  }

  // --- API key matching the provider ---
  const keyName = API_KEY_FOR_PROVIDER[provider];
  if (keyName) {
    if (!isSet(keyName)) {
      const label =
        keyName === 'LLM_API_KEY'
          ? `${provider} API key (LLM_API_KEY)`
          : `${keyName.replace('_API_KEY', '')} API key`;
      const val = await ask(`${label} (blank to skip for now)`, '');
      if (val) updates[keyName] = val;
    } else {
      console.log(`  ${keyName} already set — keeping it.`);
    }
  } else if (provider !== 'ollama') {
    console.log(`  No API key prompt for provider "${provider}" — set one manually in .env if needed.`);
  }

  // --- WhatsApp phone number ---
  if (!isSet('WA_PHONE_NUMBER')) {
    while (true) {
      const phone = await ask('WhatsApp phone (digits only w/ country code, e.g. 919876543210)', '');
      if (!phone) {
        console.log('  Skipped — set WA_PHONE_NUMBER later in .env before pairing.');
        break;
      }
      if (/^\d{8,15}$/.test(phone)) {
        updates.WA_PHONE_NUMBER = phone;
        break;
      }
      console.log('  ! Digits only (8–15), including country code. Try again.');
    }
  } else {
    console.log('  WA_PHONE_NUMBER already set — keeping it.');
  }

  // --- Dashboard (optional) ---
  const dashboardAlreadyOn = (current.DASHBOARD_ENABLED || '').toLowerCase() === 'true';
  if (dashboardAlreadyOn) {
    console.log('  Web dashboard already enabled — keeping it.');
  } else if (await confirm('Enable the web dashboard?', false)) {
    const user = await ask('Dashboard username', current.DASHBOARD_USER || 'admin');
    updates.DASHBOARD_USER = user;

    let bcrypt = null;
    try {
      ({ default: bcrypt } = await import('bcryptjs'));
    } catch {
      bcrypt = null;
    }

    if (bcrypt) {
      let hash = '';
      while (!hash) {
        const pw = await askSecret('Dashboard password (input hidden)');
        if (!pw) {
          console.log('  ! Password cannot be empty.');
          continue;
        }
        const pw2 = await askSecret('Confirm password');
        if (pw !== pw2) {
          console.log('  ! Passwords do not match. Try again.');
          continue;
        }
        hash = bcrypt.hashSync(pw, 10);
      }
      updates.DASHBOARD_PASS_HASH = hash;
      updates.DASHBOARD_ENABLED = 'true';
      if (!isSet('DASHBOARD_COOKIE_SECRET')) {
        updates.DASHBOARD_COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
      }
      console.log('  Dashboard enabled. Reach it via SSH tunnel / Tailscale (default bind 127.0.0.1).');
    } else {
      console.log(
        '  ! Could not load bcryptjs to hash the password. Skipping dashboard auth.\n' +
        '    Generate a hash later with:\n' +
        `      node -e 'import("bcryptjs").then(b=>b.default.hash("yourpass",10).then(console.log))'\n` +
        '    then set DASHBOARD_PASS_HASH and DASHBOARD_ENABLED=true in .env.',
      );
    }
  }

  if (Object.keys(updates).length > 0) {
    body = applyEnvUpdates(body, updates);
    fs.writeFileSync(ENV_PATH, body);
    console.log(`  Saved ${Object.keys(updates).length} setting(s) to .env`);
  } else {
    console.log('  Nothing to change in .env.');
  }
}

async function stepPersona() {
  console.log('\n── Step 2/4 · Persona ──────────────────────────────────────\n');
  console.log("  Let's give your bot an identity. It will answer to a name, have a");
  console.log('  vibe, and speak in a language/region of your choosing.\n');

  // persona.json — confirm before overwriting.
  let writePersona = true;
  if (fs.existsSync(PERSONA_PATH)) {
    writePersona = await confirm('persona.json already exists — overwrite?', false);
    if (!writePersona) console.log('  Keeping existing persona.json.');
  }

  // We still gather answers even if not writing persona.json, because identity.md
  // may want rendering. But if the user declined persona overwrite AND identity
  // exists, there is nothing to ask — short-circuit using existing persona.
  let persona;
  if (!writePersona && fs.existsSync(IDENTITY_PATH)) {
    console.log('  Persona and identity already present — skipping persona prompts.');
    return;
  }

  if (writePersona) {
    let name = '';
    while (!name) {
      name = await ask('Bot name (required, e.g. "Sam")', '');
      if (!name) console.log('  ! A name is required.');
    }
    const nameLower = name.toLowerCase();

    const aliasesRaw = await ask('Extra aliases it answers to (comma-separated)', nameLower);
    let aliases = aliasesRaw
      .split(',')
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean);
    if (!aliases.includes(nameLower)) aliases = [nameLower, ...aliases];
    aliases = [...new Set(aliases)];

    const ageRaw = await ask('Age (number, optional)', '');
    const ageNum = ageRaw === '' ? null : Number(ageRaw);
    const age = Number.isFinite(ageNum) ? ageNum : null;

    const region = await ask('Region (e.g. "Lagos, Nigeria", optional)', '');
    const language = await ask('Language', 'English');
    const voiceDescriptor = await ask(
      'Voice descriptor (for TTS)',
      `a young adult from ${region || 'somewhere'} speaking casually to friends`,
    );
    const vibe = await ask('Vibe (one line)', 'warm, witty, a real friend not an assistant');

    persona = {
      name,
      displayName: name,
      aliases,
      age,
      region,
      language,
      voiceDescriptor,
      vibe,
    };

    fs.mkdirSync(PERSONALITY_DIR, { recursive: true });
    fs.writeFileSync(PERSONA_PATH, JSON.stringify(persona, null, 2) + '\n');
    console.log(`  Wrote ${path.relative(PROJECT_ROOT, PERSONA_PATH)}`);
  } else {
    // persona.json kept; read it back so we can still render identity.md.
    try {
      persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf-8'));
    } catch (err) {
      console.log(`  ! Could not read existing persona.json (${err.message}). Skipping identity render.`);
      return;
    }
  }

  // Render identity.md from the template.
  if (!fs.existsSync(IDENTITY_TEMPLATE_PATH)) {
    console.log('  ! identity.template.md not found — cannot render identity.md.');
    return;
  }

  let writeIdentity = true;
  if (fs.existsSync(IDENTITY_PATH)) {
    writeIdentity = await confirm('identity.md already exists — overwrite?', false);
    if (!writeIdentity) console.log('  Keeping existing identity.md.');
  }

  if (writeIdentity) {
    const template = fs.readFileSync(IDENTITY_TEMPLATE_PATH, 'utf-8');
    const rendered = template
      .replaceAll('{{NAME}}', persona.name)
      .replaceAll('{{AGE}}', persona.age == null ? '' : String(persona.age))
      .replaceAll('{{REGION}}', persona.region || '')
      .replaceAll('{{LANGUAGE}}', persona.language || 'English')
      .replaceAll('{{VIBE}}', persona.vibe || '');
    fs.writeFileSync(IDENTITY_PATH, rendered);
    console.log(`  Rendered ${path.relative(PROJECT_ROOT, IDENTITY_PATH)}`);
  }
}

async function stepDatabase() {
  console.log('\n── Step 3/4 · Database ─────────────────────────────────────\n');
  try {
    const dbModuleUrl = new URL('../src/memory/db.js', import.meta.url).href;
    const { runMigrations } = await import(dbModuleUrl);
    if (typeof runMigrations !== 'function') {
      throw new Error('runMigrations export not found in src/memory/db.js');
    }
    runMigrations();
    console.log('  Database ready (migrations applied).');
  } catch (err) {
    console.log(`  ! Database setup failed: ${err.message}`);
    console.log('    You can retry later with: npm run migrate');
  }
}

async function stepPairing() {
  console.log('\n── Step 4/4 · WhatsApp pairing ─────────────────────────────\n');
  console.log('  Pairing links this bot to a WhatsApp account via a one-time code.');
  console.log('  pair.js reads the phone number from its first CLI argument,');
  console.log('  e.g.  node scripts/pair.js 919876543210\n');

  // Try to surface the configured phone number for convenience.
  let phone = '';
  try {
    if (fs.existsSync(ENV_PATH)) {
      phone = parseEnv(fs.readFileSync(ENV_PATH, 'utf-8')).WA_PHONE_NUMBER || '';
    }
  } catch {
    phone = '';
  }

  const wantPair = await confirm('Pair WhatsApp now?', false);
  const cmd = phone ? `node scripts/pair.js ${phone}` : 'node scripts/pair.js <your-number>';

  if (!wantPair) {
    console.log(`\n  When you're ready, run:\n    ${cmd}\n`);
    return;
  }

  // Hand the terminal over to the pairing script.
  await new Promise((resolve) => {
    const args = ['scripts/pair.js'];
    if (phone) args.push(phone);
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code && code !== 0 && code !== 130) {
        console.log(`\n  Pairing process exited with code ${code}.`);
        console.log(`  You can retry with: ${cmd}`);
      }
      resolve();
    });
    child.on('error', (err) => {
      console.log(`\n  ! Could not launch pairing: ${err.message}`);
      console.log(`  Run it manually: ${cmd}`);
      resolve();
    });
  });
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║              WhatsApp agent · guided setup                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('\n  This wizard is safe to re-run — it skips values that are already');
  console.log('  set and asks before overwriting anything.\n');

  try {
    await stepEnv();
    await stepPersona();
    await stepDatabase();
    await stepPairing();

    console.log('\n────────────────────────────────────────────────────────────');
    console.log('  All set — run `npm start` to launch.');
    console.log('────────────────────────────────────────────────────────────\n');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n  Setup failed: ${err?.stack || err}\n`);
  try {
    rl.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
