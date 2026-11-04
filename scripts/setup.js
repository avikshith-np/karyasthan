#!/usr/bin/env node
// Guided setup. Safe to stop and to re-run: each answer is saved as it's given, and
// an install that already works keeps what it has.
//
// INPUT: under `curl | bash` stdin is the installer script, so with no terminal on
// stdin we read the controlling terminal (/dev/tty).
//
// HEADLESS: --non-interactive, -y or KARYASTHAN_NONINTERACTIVE=1 takes everything from
// the environment. Every value is checked first; a bad one writes nothing and exits 2.
//
// Exit codes: 0 finished (the last lines say whether it's ready), 1 failed, 2 can't
// run like this, 130 stopped by the user.

import tty from 'node:tty';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUi, Interrupted } from './setup/ui.js';
import net from 'node:net';
import {
  PROVIDERS, providerById, parseEnv, applyEnvUpdates, normalizePhone, parseAge, looksLikeSecret,
  checkAliases, validTimeZone, detectTimeZone, localTimeIn, renderIdentity, parseNumberList,
  featuresToSwitchOff, validateHeadless, credsAreLinked, whatsLeft,
} from './setup/lib.js';
import {
  JOBS, jobById, suggest, suggestBackup, jobUpdates, currentChoice, modelFitsProvider, modelsFor,
  priceKnown, savePrice, parsePrice, jobTable, smallDecisions,
} from './setup/suggestions.js';
import { testModel, failureWords, isInconclusive } from './setup/keys.js';
import { HELP } from './setup/help.js';
import { renderUserUnit, renderSystemUnit } from './setup/service.js';
import { commandExists, pm2Has } from './setup/running.js';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 20) {
  console.error(`\n  This needs Node.js 20 or newer; you are running ${process.versions.node}.\n`);
  process.exit(2);
}

process.umask(0o077);   // whatever setup creates is readable by this user only

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'setup-state.json');
const PERSONALITY_DIR = path.join(PROJECT_ROOT, 'src', 'personality');
const PERSONA_PATH = path.join(PERSONALITY_DIR, 'persona.json');
const IDENTITY_PATH = path.join(PERSONALITY_DIR, 'identity.md');
const IDENTITY_TEMPLATE_PATH = path.join(PERSONALITY_DIR, 'identity.template.md');
const WORLD_PATH = path.join(PERSONALITY_DIR, 'world.json');

const argv = process.argv.slice(2);
const HEADLESS = argv.includes('--non-interactive') || argv.includes('-y') || argv.includes('--yes')
  || process.env.KARYASTHAN_NONINTERACTIVE === '1';

let input = process.stdin;
let ttyFd = null;
if (!HEADLESS && !process.stdin.isTTY) {
  try {
    ttyFd = fs.openSync('/dev/tty', 'r');
    input = new tty.ReadStream(ttyFd);
  } catch { input = process.stdin; }
}
const ui = createUi({ input, output: process.stdout });

function cleanup() {
  try { if (ttyFd != null) input.destroy(); else input.pause(); } catch { /* gone */ }
}

const say = (s = '') => console.log(s ? `  ${s}` : '');
const heading = (s) => console.log(`\n  ${s}\n`);

// ── What this run has already asked ───────────────────────────────────────────
// A new .env starts as a copy of .env.example, whose defaults are not the owner's
// choices. `fresh` is true from the run that created it until setup finishes, and
// `done` lists what was answered, so a stopped run carries on where it was.
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return { fresh: false, done: [] }; }
}
let state = readState();
function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 });
}
function markDone(step) {
  if (!state.done.includes(step)) state.done.push(step);
  saveState();
}

// ── .env ──────────────────────────────────────────────────────────────────────
let current = {};
let backedUp = false;
function writeEnv(updates) {
  const before = fs.readFileSync(ENV_PATH, 'utf-8');
  const body = applyEnvUpdates(before, updates);
  if (!state.fresh && !backedUp && body !== before) {
    const bak = `${ENV_PATH}.bak.${Date.now()}`;
    fs.copyFileSync(ENV_PATH, bak);
    fs.chmodSync(bak, 0o600);
  }
  backedUp = true;
  const tmp = `${ENV_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
  current = parseEnv(body);
}
const isSet = (k) => Boolean(current[k]);
/** True when this question still needs asking on this run. */
const needs = (step, key) => (state.fresh ? !state.done.includes(step) : !isSet(key));

function ensureEnvFile() {
  if (!fs.existsSync(ENV_EXAMPLE_PATH)) throw new Error('.env.example is missing; this checkout is incomplete.');
  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    fs.chmodSync(ENV_PATH, 0o600);
    state = { fresh: true, done: [] };
    saveState();
  }
  fs.chmodSync(ENV_PATH, 0o600);
  current = parseEnv(fs.readFileSync(ENV_PATH, 'utf-8'));
}

// ── What this machine has ─────────────────────────────────────────────────────
async function detectFacts() {
  const hasGemini = isSet('GEMINI_API_KEY');
  const hasOpenrouter = isSet('OPENROUTER_API_KEY') || isSet('JEV_API_KEY');
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  let searxng = false;
  try {
    const res = await fetch(`${(current.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/+$/, '')}/search?q=test&format=json`,
      { signal: AbortSignal.timeout(2000) });
    searxng = res.ok;
  } catch { /* nothing there */ }
  let chromium = false;
  try {
    const { chromium: c } = await import('playwright');
    chromium = fs.existsSync(c.executablePath());
  } catch { /* not installed */ }
  return { hasGemini, hasOpenrouter, ffmpeg, searxng, chromium };
}

async function switchOffWhatCantWork() {
  if (!state.fresh || state.done.includes('features')) return;
  const off = featuresToSwitchOff(await detectFacts());
  if (off.length) {
    writeEnv(Object.fromEntries(off.map((f) => [f.key, 'false'])));
    say('Switched off, because they can\'t work here yet:');
    for (const f of off) say(`  ${f.label}: ${f.why}`);
    say('Turn any of them on later in .env.');
  }
  markDone('features');
}

// ── Step 1: keys, then who does which job ─────────────────────────────────────
const haveProviders = () => new Set(PROVIDERS.filter((p) => (p.keyEnv ? isSet(p.keyEnv) : state.done.includes(`local:${p.id}`) || current.LLM_PROVIDER === p.id)).map((p) => p.id));

/** A key for this provider, tested when there's a model to test it with. False if none was given. */
async function askKey(p) {
  if (!p.keyEnv || isSet(p.keyEnv)) return true;
  for (;;) {
    if (p.keyUrl) say(`Get a key at ${p.keyUrl}`);
    const key = await ui.askSecret(`${p.label} key, hidden (Enter to skip)`);
    if (!key) return false;
    if (p.model) {
      const r = await testModel({ provider: p.id, model: p.model, key });
      if (!r.ok && !isInconclusive(r.why) && r.why !== 'no_model') {
        say(`✗ ${failureWords(r.why, p.label)}`);
        if (r.why === 'bad_key') continue;
      } else if (!r.ok) {
        say(`! ${failureWords(r.why, p.label)} Saved as not tested.`);
      } else {
        say('✓ Works');
      }
    }
    writeEnv({ [p.keyEnv]: key });
    return true;
  }
}

async function stepKeys() {
  say('Which do you have? Any mix works, and you need at least one. Type ? for where to get them.\n');
  PROVIDERS.forEach((p, i) => say(`  ${i + 1}  ${p.label.padEnd(20)} ${p.note}${p.keyEnv && isSet(p.keyEnv) ? '  (have it)' : ''}`));
  say('');
  for (;;) {
    const already = PROVIDERS.map((p, i) => (p.keyEnv && isSet(p.keyEnv) ? i + 1 : 0)).filter(Boolean).join(',');
    const raw = await ui.ask('Type numbers, like 1,2', already, { help: HELP.keys });
    const picks = parseNumberList(raw, PROVIDERS.length);
    if (!picks) { say(`! Numbers from 1 to ${PROVIDERS.length}, separated by commas.`); continue; }
    for (const n of picks) {
      const p = PROVIDERS[n - 1];
      if (!p.keyEnv) {
        state.done.push(`local:${p.id}`); saveState();
        if (p.needsBaseUrl && !isSet('LLM_BASE_URL')) {
          let url = '';
          while (!/^https?:\/\//.test(url)) url = await ui.ask('Server address, like http://127.0.0.1:18080/v1/chat/completions');
          writeEnv({ LLM_BASE_URL: url });
        }
        continue;
      }
      await askKey(p);
    }
    if (haveProviders().size) return;
    if (!picks.length) say('Skipping. It can\'t reply until you add one.');
    else say('No key was added, so it can\'t reply yet.');
    if (await ui.confirm('Carry on without one?', false)) return;
  }
}

/** Provider, then model, for one job. Tests before it returns. Returns a choice, or null for off. */
async function chooseForJob(job, have) {
  const offers = PROVIDERS.map((p) => ({ ...p, held: have.has(p.id) }));
  say('');
  say(`${job.label}: which provider?`);
  offers.forEach((p, i) => say(`  ${i + 1}  ${p.label.padEnd(20)} ${p.held ? 'you have it' : (p.keyEnv ? 'no key yet: choose it to add one' : 'no key needed')}`));
  if (job.off) say(`  ${offers.length + 1}  Off`);
  const items = job.off ? [...offers, null] : offers;
  const p = await ui.choose('Choose', items, Math.max(0, offers.findIndex((o) => o.held)));
  if (!p) return null;
  if (p.keyEnv && !isSet(p.keyEnv)) {
    if (!await askKey(providerById(p.id))) return { retry: true };
    have.add(p.id);
  } else if (!p.keyEnv) { have.add(p.id); }

  const list = modelsFor(p.id);
  for (;;) {
    let model = '';
    if (list.length) {
      say('');
      say(`${job.label} on ${p.label}: which model?`);
      const best = suggest(job, new Set([p.id])).model;
      list.forEach((m, i) => say(`  ${i + 1}  ${m.model.padEnd(30)} ${m.model === best ? 'suggested  ' : ''}${m.note}`));
      say(`  ${list.length + 1}  Type another model id`);
      const opt = await ui.choose('Choose', [...list, null], Math.max(0, list.findIndex((m) => m.model === best)));
      if (opt) model = opt.model;
    }
    while (!model) model = await ui.ask('Model id');
    const misfit = modelFitsProvider(p.id, model);
    if (misfit) { say(`✗ ${misfit}`); continue; }
    if (await provesOut(job, p.id, model)) return { provider: p.id, model };
  }
}

/** One test call, and a price if the model has none. False sends the person back to pick again. */
async function provesOut(job, provider, model) {
  const def = providerById(provider);
  say(`Testing ${model}…`);
  const r = await testModel({ provider, model, key: def?.keyEnv ? current[def.keyEnv] : '', baseUrl: current.LLM_BASE_URL });
  if (r.ok) say(`✓ It answered`);
  else if (isInconclusive(r.why)) say(`! ${failureWords(r.why, def?.label || provider)} Saved as not tested.`);
  else { say(`✗ ${failureWords(r.why, def?.label || provider)}`); return false; }
  if (!priceKnown(PROJECT_ROOT, provider, model) && provider !== 'ollama' && provider !== 'local') {
    say('! No price known for this model, so budgets would count it as $0.');
    if (job.id === 'deep') say('  Deep thinking refuses a model with no price, so this one is needed.');
    for (;;) {
      const raw = await ui.ask('Price per million tokens, in and out, like 0.20 0.80 (blank to skip)');
      if (!raw) { if (job.id === 'deep') return false; break; }
      const price = parsePrice(raw);
      if (price) { savePrice(PROJECT_ROOT, provider, model, price[0], price[1]); say('✓ Saved to data/llm-prices.json'); break; }
      say('! Two numbers, like 0.20 0.80.');
    }
  }
  return true;
}

function tableRows(choices, have) {
  const rows = JOBS.map((j) => {
    const c = choices[j.id];
    return { label: j.label, provider: c.provider, model: c.model, why: c.why };
  });
  const s = smallDecisions(have);
  rows.push({ label: 'Small decisions', model: s.model, why: s.why, fixed: true });
  return rows;
}

async function stepJobs({ reset = false } = {}) {
  const have = haveProviders();
  const choices = {};
  for (const j of JOBS) {
    const c = currentChoice(j, current);
    const useCurrent = !reset && !state.fresh && c.model;
    choices[j.id] = useCurrent ? { ...c, why: 'set now' } : suggest(j, have);
  }
  for (;;) {
    say('');
    for (const line of jobTable(tableRows(choices, have))) console.log(`  ${line}`);
    say('');
    const raw = await ui.ask('Enter to accept, or a number to change', '', { help: HELP.jobs });
    if (raw) {
      const n = Number(raw);
      const job = JOBS[n - 1];
      if (!job) { say(`! A number from 1 to ${JOBS.length}, or Enter.`); continue; }
      const c = await chooseForJob(job, have);
      if (c?.retry) continue;
      choices[job.id] = c ? { ...c, why: 'your choice' } : { provider: '', model: '', why: 'off' };
      continue;
    }
    // Every choice answers once before it's saved; the same pair isn't tested twice.
    const tested = new Set();
    let again = false;
    for (const j of JOBS) {
      const c = choices[j.id];
      if (c.why === 'your choice' || c.why === 'set now' || !c.provider) continue;
      if (!c.model) {
        say(`! ${j.label} needs a model id for ${providerById(c.provider)?.label || c.provider}.`);
        const picked = await chooseForJob(j, have);
        if (picked?.retry) { again = true; break; }
        choices[j.id] = picked ? { ...picked, why: 'your choice' } : { provider: '', model: '', why: 'off' };
        continue;
      }
      const pair = `${c.provider}/${c.model}`;
      if (tested.has(pair)) continue;
      tested.add(pair);
      if (!await provesOut(j, c.provider, c.model)) { say(`Pick something else for ${j.label}.`); again = true; break; }
    }
    if (again) continue;
    const updates = {};
    for (const j of JOBS) {
      if (choices[j.id].why === 'set now') continue;   // an existing choice keeps its own backup
      const backup = suggestBackup(j, choices[j.id], have);
      Object.assign(updates, jobUpdates(j, choices[j.id], backup));
    }
    if (state.fresh && !have.has('gemini') && have.has('openrouter')) updates.TRANSCRIPTION_MODEL = 'google/gemini-3-flash-preview';
    writeEnv(updates);
    say('Saved. Each job has a backup when you hold a second key.');
    markDone('jobs');
    return;
  }
}

async function stepModel() {
  heading('1 of 5  Models');
  if (state.fresh && !state.done.includes('keys')) {
    await stepKeys();
    markDone('keys');
  }
  if (state.fresh && !state.done.includes('jobs')) await stepJobs();
  else if (!state.fresh) {
    await stepKeys();
    await stepJobs();
  } else say('Already chosen. Keeping that.');
  await switchOffWhatCantWork();
}

// ── Step 2: the character ─────────────────────────────────────────────────────
const TEMPLATE_DIR = path.join(PERSONALITY_DIR, 'templates');
function loadTemplates() {
  const order = ['dry-friend', 'warm-one', 'chaos-friend', 'quiet-nerd', 'organiser'];
  return order.map((id) => {
    try { return JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, `${id}.json`), 'utf-8')); } catch { return null; }
  }).filter(Boolean);
}

async function pickTemplate() {
  const list = loadTemplates();
  if (!list.length) return null;
  say('Pick a starting point. You can change everything on the next screen, and later.\n');
  list.forEach((t, i) => say(`  ${i + 1}  ${t.label.padEnd(20)} ${t.blurb}`));
  say(`  ${list.length + 1}  Start blank          write your own`);
  say('');
  for (;;) {
    const t = await ui.choose('Choose', [...list, null], 0, { help: HELP.template });
    if (!t) return null;
    say('');
    say(`  "${t.sample}"`);
    say('');
    if (await ui.confirm(`That's how ${t.label} talks. Use it?`, true)) return t;
  }
}

async function askPersona(character) {
  const askPlain = async (q, def, help) => {
    for (;;) {
      const v = await ui.ask(q, def, { help });
      if (!looksLikeSecret(v)) return v;
      say('! That looks like an API key, and this goes into every prompt. Not saved.');
    }
  };
  say('Enter keeps what\'s in brackets. Type ? for help on a question.\n');
  let name = '';
  while (!name) {
    name = await askPlain('Name', '', HELP.name);
    if (!name) say('! A name is required.');
  }
  const lower = name.toLowerCase();

  let aliases = [];
  for (;;) {
    const raw = await ui.ask('Other names it answers to, comma-separated', lower, { help: HELP.aliases });
    const { keep, refused } = checkAliases([lower, ...raw.split(',')]);
    aliases = keep;
    if (refused.length) {
      say(`! Too short or too common, it would think everyone means it: ${refused.join(', ')}`);
      if (!keep.length) { say('  Add a longer name it answers to as well.'); continue; }
    }
    break;
  }

  let age = null;
  for (;;) {
    const a = parseAge(await ui.ask('Age', character?.age ? String(character.age) : '', { help: HELP.age }));
    if (a.ok) { age = a.age; break; }
    say(`! ${a.why}`);
  }
  const region = await askPlain('From (blank is fine)', '', HELP.from);
  let language = await askPlain('Language', 'English', HELP.language);
  if (await ui.confirm('Does it need to mix languages?', false, { help: HELP.mix })) {
    const mix = await askPlain('Which, like English and Spanish', `${language} and `, HELP.mix);
    if (mix.trim()) language = `${mix.trim()}, often mixed`;
  }
  const voiceDescriptor = await askPlain('How it sounds, for voice notes', character?.voice || (region ? `a young adult from ${region} speaking casually to friends` : 'a young adult speaking casually to friends'), '');
  const vibe = await askPlain('One line of personality', character?.vibe || 'warm, witty, a real friend not an assistant', HELP.personality);
  return { name, displayName: name, aliases, age, region, language, voiceDescriptor, vibe, ...(character ? { template: character.id } : {}) };
}

function writeIdentity(persona, character = null) {
  if (!fs.existsSync(IDENTITY_TEMPLATE_PATH)) {
    say('! identity.template.md is missing, so identity.md was not written.');
    return;
  }
  fs.writeFileSync(IDENTITY_PATH, renderIdentity(fs.readFileSync(IDENTITY_TEMPLATE_PATH, 'utf-8'), persona, character));
}

function personaFromEnv() {
  const e = process.env;
  const name = e.KARYASTHAN_NAME.trim();
  const t = e.KARYASTHAN_TEMPLATE ? loadTemplates().find((x) => x.id === e.KARYASTHAN_TEMPLATE) : null;
  const { keep } = checkAliases([name, ...String(e.KARYASTHAN_ALIASES || '').split(',')]);
  const region = e.KARYASTHAN_REGION || '';
  return {
    persona: {
      name,
      displayName: name,
      aliases: keep.length ? keep : [name.toLowerCase()],
      age: e.KARYASTHAN_AGE ? parseAge(e.KARYASTHAN_AGE).age : (t?.age ?? null),
      region,
      language: e.KARYASTHAN_LANGUAGE || 'English',
      voiceDescriptor: e.KARYASTHAN_VOICE || t?.voice || (region ? `a young adult from ${region} speaking casually to friends` : 'a young adult speaking casually to friends'),
      vibe: e.KARYASTHAN_VIBE || t?.vibe || 'warm, witty, a real friend not an assistant',
      ...(t ? { template: t.id } : {}),
    },
    character: t,
  };
}

function savePersonaFile(persona) {
  fs.mkdirSync(PERSONALITY_DIR, { recursive: true });
  fs.writeFileSync(PERSONA_PATH, `${JSON.stringify(persona, null, 2)}\n`);
}

async function stepCharacter() {
  heading('2 of 5  Character');
  let overwrite = !fs.existsSync(PERSONA_PATH);
  if (!overwrite) {
    if (fs.existsSync(WORLD_PATH)) {
      say('! This character already has a world. A world can\'t be rewritten, so its cast');
      say('  would keep the old name, while chats and memories stay.');
    }
    overwrite = await ui.confirm('persona.json already exists. Replace it?', false);
    if (!overwrite) say('Keeping the character.');
  }
  let persona = null;
  let character = null;
  if (overwrite) {
    character = await pickTemplate();
    say('');
    persona = await askPersona(character);
    savePersonaFile(persona);
    say('Wrote persona.json');
  } else {
    if (fs.existsSync(IDENTITY_PATH)) return;
    try { persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf-8')); } catch (err) {
      say(`! Could not read persona.json (${err.message}).`);
      return;
    }
  }
  if (fs.existsSync(IDENTITY_PATH)) {
    if (!await ui.confirm('identity.md already exists. Replace it?', false)) { say('Keeping identity.md.'); return; }
    fs.copyFileSync(IDENTITY_PATH, `${IDENTITY_PATH}.bak.${Date.now()}`);
  }
  writeIdentity(persona, character);
  say('Wrote identity.md');
}

// ── Step 3: numbers and time zone ─────────────────────────────────────────────
async function stepNumber({ force = false } = {}) {
  heading('3 of 5  Numbers and time zone');
  if (force || needs('phone', 'WA_PHONE_NUMBER')) {
    say('The number it will use. People will message it there, so use a spare');
    say('number, not your own: it would answer your friends as you.\n');
    for (;;) {
      const raw = await ui.ask('Its number, with country code (Enter to skip for now)', '', { help: HELP.number });
      if (!raw) { say('Skipped. It can\'t start until this is set.'); break; }
      const p = normalizePhone(raw);
      if (p.ok) {
        writeEnv({ WA_PHONE_NUMBER: p.digits });
        say(`Read as +${p.digits}`);
        break;
      }
      if (p.why === 'no_country_code') say('! No country code, so WhatsApp could send the code to someone else. Add it, like +44 7700 900123.');
      else say('! That needs 8 to 15 digits with a country code, like +44 7700 900123.');
    }
    markDone('phone');
  } else {
    say(`Its number is set to +${current.WA_PHONE_NUMBER}. Keeping it.`);
  }

  if (force || (state.fresh && !state.done.includes('owner'))) {
    for (;;) {
      const raw = await ui.ask('Your own number, so it knows you\'re the owner (blank is fine)', '', { help: HELP.owner });
      if (!raw) break;
      const p = normalizePhone(raw);
      if (!p.ok) { say('! That needs a country code, like +44 7700 900123.'); continue; }
      if (p.digits === current.WA_PHONE_NUMBER) {
        say('! That\'s the same as its number. It would read all your chats and answer your');
        say('  friends as you, on your own account. Your account is the one at risk of a ban.');
        const keep = await ui.choose('1 enter a spare number instead, 2 I understand, use my own', [1, 2], 0);
        if (keep === 1) {
          writeEnv({ WA_PHONE_NUMBER: '' });
          return stepNumber({ force: true });
        }
      }
      writeEnv({ OWNER_JIDS: p.digits });
      break;
    }
    markDone('owner');
    if (await ui.confirm('Is its number new on WhatsApp?', true, { help: HELP.warmup })) {
      writeEnv({ WARMUP_ENABLED: 'true' });
      say('Warmup on, to protect a new number:');
      say('  Days 1 to 3    it only reacts, even to you');
      say('  Days 4 to 21   text, 15 to 50 messages a day');
      say('  Day 22 on      no limit');
    } else {
      writeEnv({ WARMUP_ENABLED: 'false' });
      say('Warmup off. It can reply from the first day.');
    }
  }

  if (force || needs('timezone', 'TIMEZONE')) {
    let tz = detectTimeZone();
    if (!await ui.confirm(`Time zone: ${tz}, it's ${localTimeIn(tz)} there now. Right?`, true, { help: HELP.timezone })) {
      tz = '';
      while (!validTimeZone(tz)) {
        tz = await ui.ask('Time zone, like Africa/Lagos', '', { help: HELP.timezone });
        if (!validTimeZone(tz)) say('! Not a known time zone.');
      }
    }
    writeEnv({ TIMEZONE: tz });
    markDone('timezone');
  } else {
    say(`Time zone is ${current.TIMEZONE}. Keeping it.`);
  }
  return undefined;
}

// ── Step 4: abilities ─────────────────────────────────────────────────────────
const isOn = (k) => (current[k] || '').toLowerCase() === 'true';
async function stepAbilities({ force = false } = {}) {
  heading('4 of 5  What it can do');
  if (!force && state.fresh && state.done.includes('abilities')) { say('Already chosen.'); return; }
  const deep = currentChoice(jobById('deep'), current);
  const needsDeep = deep.model ? '' : 'needs a deep thinking model';
  const items = [
    { label: 'Understand voice messages', on: isSet('GEMINI_API_KEY') || isSet('OPENROUTER_API_KEY'), fixed: isSet('GEMINI_API_KEY') ? 'your Gemini key' : (isSet('OPENROUTER_API_KEY') ? 'through OpenRouter' : 'needs a Gemini or OpenRouter key') },
    { label: 'Send voice notes', on: (current.VOICE_NOTE_ENABLED || 'true') !== 'false', fixed: (current.VOICE_NOTE_ENABLED || 'true') !== 'false' ? 'Gemini and ffmpeg found' : 'needs a Gemini key and ffmpeg' },
    { label: 'Look things up on the web', on: (current.WEB_SEARCH_ENABLED || 'true') !== 'false', fixed: (current.WEB_SEARCH_ENABLED || 'true') !== 'false' ? 'SearXNG answered' : 'needs a SearXNG server' },
    { label: 'A life of its own', on: isOn('LIFE_ENABLED'), why: 'routine, job, cast, story arcs', blocked: needsDeep, keys: ['LIFE_ENABLED', 'ARCS_ENABLED', 'CHAT_INFLUENCE_ENABLED'] },
    { label: 'The mind', on: isOn('MIND_ENABLED'), why: 'thinks daily, sleeps on each day', blocked: needsDeep, keys: ['MIND_ENABLED'] },
  ];
  say('Chatting, memory and bill-split are always on.\n');
  const render = () => items.forEach((it, i) => {
    const state_ = it.keys ? (it.blocked ? 'n/a' : it.on ? 'on ' : 'off') : (it.on ? 'on ' : 'n/a');
    say(`  ${state_} ${it.keys ? String(i + 1) : ' '}  ${it.label.padEnd(28)} ${it.blocked || it.fixed || it.why}`);
  });
  render();
  say('');
  for (;;) {
    const raw = await ui.ask('Type numbers to switch, Enter to keep', '', { help: HELP.abilities });
    const picks = parseNumberList(raw, items.length);
    if (!picks || picks.some((n) => !items[n - 1].keys)) { say('! Type the number of something that can be switched, or Enter.'); continue; }
    const blocked = picks.map((n) => items[n - 1]).filter((it) => it.blocked);
    if (blocked.length) { say(`! ${blocked[0].label} needs a deep thinking model. Choose one in step 1, then come back.`); continue; }
    for (const n of picks) items[n - 1].on = !items[n - 1].on;
    break;
  }
  const updates = {};
  for (const it of items) if (it.keys) for (const k of it.keys) updates[k] = String(it.on);
  writeEnv(updates);
  if (isOn('LIFE_ENABLED') && !fs.existsSync(WORLD_PATH)) {
    say('');
    say('At first start it writes its world: one call, about $0.10. That world is permanent,');
    say('so the name and time zone matter now.');
  }
  for (;;) {
    const raw = await ui.ask('Monthly budget in US dollars', current.LLM_MONTHLY_BUDGET_USD || '30', { help: HELP.budget });
    if (/^\d+(\.\d+)?$/.test(raw)) { writeEnv({ LLM_MONTHLY_BUDGET_USD: raw }); break; }
    say('! A number, like 20.');
  }
  say('Replies keep working past it. Background thinking stops.');
  markDone('abilities');
}

// ── Step 5: dashboard ─────────────────────────────────────────────────────────
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function setDashboardPassword() {
  const user = await ui.ask('Username', current.DASHBOARD_USER || 'admin');
  let hash = '';
  while (!hash) {
    const pw = await ui.askSecret('Password, 10 characters or more, hidden');
    if ([...pw].length < 10) { say('! At least 10 characters.'); continue; }
    const again = await ui.askSecret('Again');
    if (pw !== again) { say('! They don\'t match. Try again.'); continue; }
    const { default: bcrypt } = await import('bcryptjs');
    hash = bcrypt.hashSync(pw, 10);
  }
  writeEnv({
    DASHBOARD_USER: user,
    DASHBOARD_PASS_HASH: hash,
    DASHBOARD_ENABLED: 'true',
    ...(isSet('DASHBOARD_COOKIE_SECRET') ? {} : { DASHBOARD_COOKIE_SECRET: crypto.randomBytes(32).toString('hex') }),
  });
}

async function stepDashboard({ force = false } = {}) {
  heading('5 of 5  Dashboard');
  if (!force && (current.DASHBOARD_ENABLED || '').toLowerCase() === 'true') {
    say('Already on. Keeping it.');
    return;
  }
  if (!force && state.fresh && state.done.includes('dashboard')) return;
  if (await ui.confirm('Turn on the private web dashboard?', true, { help: HELP.dashboard })) {
    await setDashboardPassword();
    let port = Number(current.DASHBOARD_PORT || 7070);
    if (!force && !await portFree(port)) {
      let next = port + 1;
      while (next < port + 20 && !await portFree(next)) next += 1;
      say(`! Port ${port} is taken. Using ${next}.`);
      port = next;
      writeEnv({ DASHBOARD_PORT: String(port) });
    }
    const editing = isOn('LIFE_ENABLED');
    if (editing) writeEnv({ DASHBOARD_READONLY: 'false' });
    say(`On at 127.0.0.1:${port}${editing ? ', editing on, because life needs the Director' : ', read-only. Set DASHBOARD_READONLY=false in .env to edit from it'}.`);
    if (process.env.SSH_CONNECTION) say(`You're on SSH. From your laptop: ssh -L ${port}:127.0.0.1:${port} ${process.env.USER || 'you'}@this-host`);
  }
  markDone('dashboard');
}

// ── Review ────────────────────────────────────────────────────────────────────
function characterSummary() {
  try {
    const p = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf-8'));
    return [p.name, p.age, p.region, p.language].filter(Boolean).join(', ');
  } catch { return 'not set'; }
}
async function stepReview() {
  for (;;) {
    heading('Review');
    const jobs = JOBS.map((j) => { const c = currentChoice(j, current); return `${j.label.toLowerCase()}: ${c.model || 'off'}`; });
    say(`1 Models      ${jobs.slice(0, 2).join(' · ')}`);
    say(`              ${jobs.slice(2).join(' · ')}`);
    say(`2 Character   ${characterSummary()}`);
    say(`3 Numbers     ${current.WA_PHONE_NUMBER ? `+${current.WA_PHONE_NUMBER}` : 'not set'}${current.OWNER_JIDS ? ` · owner +${current.OWNER_JIDS}` : ''} · warmup ${current.WARMUP_ENABLED === 'false' ? 'off' : 'on'} · ${current.TIMEZONE}`);
    say(`4 Abilities   life ${isOn('LIFE_ENABLED') ? 'on' : 'off'} · mind ${isOn('MIND_ENABLED') ? 'on' : 'off'} · web ${current.WEB_SEARCH_ENABLED === 'false' ? 'off' : 'on'} · budget $${current.LLM_MONTHLY_BUDGET_USD}`);
    say(`5 Dashboard   ${isOn('DASHBOARD_ENABLED') ? `127.0.0.1:${current.DASHBOARD_PORT || 7070}, ${current.DASHBOARD_READONLY === 'false' ? 'editing on' : 'read-only'}` : 'off'}`);
    say('');
    const raw = await ui.ask('Type a number to change it, or Enter to go on', '', { help: HELP.review });
    if (!raw) return;
    if (raw === '1') { await stepKeys(); await stepJobs({ reset: true }); }
    else if (raw === '2') { fs.rmSync(PERSONA_PATH, { force: true }); fs.rmSync(IDENTITY_PATH, { force: true }); await stepCharacter(); }
    else if (raw === '3') await stepNumber({ force: true });
    else if (raw === '4') await stepAbilities({ force: true });
    else if (raw === '5') await stepDashboard({ force: true });
    else say('! A number from 1 to 5, or Enter.');
  }
}

// ── Running setup again ───────────────────────────────────────────────────────
/** True when new code landed: this setup is then the old one, so it stops here. */
function runUpdate() {
  const head = () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf-8' }).stdout.trim();
  const before = head();
  spawnSync(process.execPath, ['scripts/update.js'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  if (head() === before) return false;
  say('Run npm run setup again if there\'s anything else to change.');
  say('');
  return true;
}

async function menu() {
  for (;;) {
    let name = 'It';
    try { name = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf-8')).name || name; } catch { /* no character yet */ }
    say(`${name} is set up. ${isLinked() ? 'Linked to WhatsApp.' : 'Not linked to WhatsApp yet.'} Nothing changes unless you choose it.\n`);
    const items = [
      '1  Change a key or model', '2  Change the character', '3  Numbers and time zone', '4  Switch abilities on or off',
      '5  Dashboard password and access', '6  Link WhatsApp', '7  Check everything', '8  Keep it running', '9  Update to the newest version', '10 Finish',
    ];
    for (const i of items) say(`  ${i}`);
    say('');
    const a = await ui.ask('Choose', '10');
    if (a === '1') { await stepKeys(); await stepJobs(); }
    else if (a === '2') await stepCharacter();
    else if (a === '3') await stepNumber({ force: true });
    else if (a === '4') await stepAbilities({ force: true });
    else if (a === '5') await stepDashboard({ force: true });
    else if (a === '6') await stepLink();
    else if (a === '7') spawnSync(process.execPath, ['scripts/doctor.js'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    else if (a === '8') await stepKeepRunning();
    else if (a === '9') { if (runUpdate()) return 'updated'; }
    else if (a === '10') return 'finished';
    else say('! A number from 1 to 10.');
    say('');
  }
}

// ── Database and private files ────────────────────────────────────────────────
function makePrivate(dir) {
  // Containers with their own users read these two folders: leave them as they are.
  const skip = new Set(['asterisk', 'searxng']);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { if (!skip.has(e.name)) makePrivate(p); }
      else if (e.isFile()) fs.chmodSync(p, 0o600);
    } catch { /* not ours */ }
  }
}

async function stepDatabase() {
  process.env.LOG_LEVEL = 'silent';
  process.env.DOTENV_CONFIG_QUIET = 'true';
  try {
    const { runMigrations, assertSchemaCurrent } = await import('../src/memory/db.js');
    const { config } = await import('../src/utils/config.js');
    const { safePath } = await import('../src/utils/pathGuard.js');
    // Only a new database is made here. An existing one migrates at boot, with a backup.
    if (!fs.existsSync(safePath(config.dbPath))) {
      runMigrations();
      say('Database created.');
    } else {
      assertSchemaCurrent();
      say('Database ready.');
    }
  } catch (err) {
    say(`! Database: ${err.message}`);
    say('Upgrades are applied, after a backup, on the next start.');
  }
  makePrivate(DATA_DIR);
}

// ── Step 5: link WhatsApp ─────────────────────────────────────────────────────
function authDir() {
  return path.resolve(PROJECT_ROOT, current.AUTH_PATH || './data/auth_info_baileys');
}
function isLinked() {
  try { return credsAreLinked(fs.readFileSync(path.join(authDir(), 'creds.json'), 'utf-8')); } catch { return false; }
}

function runScript(script, args = []) {
  return new Promise((resolve) => {
    const ignore = () => {};
    process.on('SIGINT', ignore);       // Ctrl-C ends the child, not setup
    const child = spawn(process.execPath, [script, ...args], { cwd: PROJECT_ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
    const done = (code) => { process.removeListener('SIGINT', ignore); resolve(code); };
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', (err) => { say(`! Could not start it: ${err.message}`); done(1); });
  });
}

/** Stops a running copy for a moment, with permission. A function to start it again, or null if it stays. */
async function clearTheWay(what) {
  const holder = (await import('../src/utils/instanceLock.js')).lockHolder(DATA_DIR);
  if (!holder) return () => {};
  say(`It's already running (pid ${holder.pid}). Two copies on one session knock each other off WhatsApp.`);
  if (String(holder.pid) === pm2Has()) {
    if (!await ui.confirm(`Stop it under pm2, ${what}, then start it again?`, false)) return null;
    spawnSync('pm2', ['stop', 'karyasthan'], { stdio: 'ignore' });
    return () => { spawnSync('pm2', ['start', 'karyasthan'], { stdio: 'ignore' }); say('Started it again.'); };
  }
  say(`Stop it, then ${what}.`);
  return null;
}

async function stepLink() {
  heading('Link WhatsApp');
  if (isLinked()) { say('Already linked.'); return; }
  if (!isSet('WA_PHONE_NUMBER')) { say('Skipped: there\'s no number yet.'); return; }
  if (HEADLESS) { say('WhatsApp needs a person for this step.'); return; }
  say(`You'll need the phone with +${current.WA_PHONE_NUMBER} in your hand.`);
  if (!await ui.confirm('Link it now?', true, { help: HELP.link })) return;
  const restart = await clearTheWay('link');
  if (!restart) return;
  let code = await runScript('scripts/pair.js', [current.WA_PHONE_NUMBER]);
  if (code === 3) {
    const aside = `${authDir()}.old-${new Date().toISOString().slice(0, 10)}-${Date.now() % 100000}`;
    if (await ui.confirm('Set the old session aside and link again?', true)) {
      fs.renameSync(authDir(), aside);
      say(`Moved to ${path.relative(PROJECT_ROOT, aside)}`);
      code = await runScript('scripts/pair.js', [current.WA_PHONE_NUMBER]);
    }
  }
  restart();
}

// ── First check ───────────────────────────────────────────────────────────────
async function stepFirstCheck() {
  if (HEADLESS || !isLinked()) return;
  if (state.done.includes('firstCheck')) return;
  heading('First check');
  say('This proves the whole chain on one real message. Nothing is sent, and only your');
  say('own direct message is read.');
  if (!await ui.confirm('Do it now?', true)) { state.firstCheck = 'skipped'; saveState(); return; }
  const restart = await clearTheWay('run the check');
  if (!restart) { state.firstCheck = 'skipped'; saveState(); return; }
  const code = await runScript('scripts/first-check.js');
  restart();
  state.firstCheck = code === 0 ? 'passed' : 'not checked';
  markDone('firstCheck');
}

// ── Keep it running ───────────────────────────────────────────────────────────
async function stepKeepRunning() {
  if (HEADLESS || !isLinked()) return;
  const holder = (await import('../src/utils/instanceLock.js')).lockHolder(DATA_DIR);
  if (holder) { say(`It's already running (pid ${holder.pid}).`); return; }
  heading('Keep it running');
  say('It has to run all the time.\n');
  const pm2 = commandExists('pm2');
  const systemd = process.platform === 'linux' && commandExists('systemctl', ['--user', 'show-environment']);
  const options = [
    ...(pm2 ? [{ id: 'pm2', label: 'pm2                  already installed' }] : []),
    ...(systemd ? [{ id: 'systemd', label: 'systemd user service starts with this account' }] : []),
    { id: 'none', label: 'Neither              I\'ll run npm start myself' },
  ];
  options.forEach((o, i) => say(`  ${i + 1}  ${o.label}`));
  if (!pm2 && !systemd) say('  (pm2 and systemd weren\'t found here. npm install -g pm2 adds pm2.)');
  say('');
  const pick = await ui.choose('Choose', options, 0);
  if (pick.id === 'pm2') {
    const r = spawnSync('pm2', ['start', 'src/index.js', '--name', 'karyasthan', '--cwd', PROJECT_ROOT, '--stop-exit-codes', '78'], { cwd: PROJECT_ROOT, stdio: 'ignore' });
    if (r.status !== 0) { say('! pm2 couldn\'t start it. Try: npm start'); return; }
    spawnSync('pm2', ['save'], { stdio: 'ignore' });
    say('✓ Started as "karyasthan" under pm2');
    say('To survive a reboot, run this once (needs sudo):');
    say(`    sudo env PATH=$PATH pm2 startup systemd -u ${process.env.USER || 'you'} --hp ${process.env.HOME || '~'}`);
    say('    pm2 save');
    state.running = 'pm2'; saveState();
  } else if (pick.id === 'systemd') {
    const dir = path.join(process.env.HOME || '', '.config/systemd/user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'karyasthan.service'), renderUserUnit({ root: PROJECT_ROOT, node: process.execPath }));
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'karyasthan'], { stdio: 'ignore' });
    if (r.status !== 0) { say('! systemd couldn\'t start it. Try: npm start'); return; }
    say('✓ Started as a user service');
    say('So it keeps running after you log out, run this once (needs sudo):');
    say(`    sudo loginctl enable-linger ${process.env.USER || 'you'}`);
    state.running = 'systemd'; saveState();
  }
}

// ── The end ───────────────────────────────────────────────────────────────────
function finish() {
  const left = whatsLeft(current, { linked: isLinked() });
  if (left.length) {
    heading('Not ready yet. What\'s left:');
    for (const l of left) { say(`· ${l.what}`); say(`    ${l.how}`); }
    say('');
    say('Then run: npm start');
  } else if (state.running) {
    heading(`Running under ${state.running}.`);
  } else {
    heading('Ready. Start it with: npm start');
  }
  if (!left.length && state.firstCheck && state.firstCheck !== 'passed') say(`First check: ${state.firstCheck}. npm run doctor checks the rest.`);
  say('');
  if ((current.WARMUP_ENABLED || 'true').toLowerCase() !== 'false') {
    say('What to expect, to protect a new number:');
    say('  Days 1 to 3    only reactions, even to you');
    say('  Days 4 to 21   text, 15 to 50 messages a day');
    say('  Day 22 on      no limit');
    say('If the number isn\'t new, set WARMUP_ENABLED=false in .env.');
    say('');
  }
  say('In groups it answers when named or asked, and sometimes otherwise. Silence is normal.');
  say('Open WhatsApp on that phone at least every 14 days, or WhatsApp drops the link.');
  say('');
  if (state.fresh) { state.fresh = false; saveState(); }
}

// ── Headless ──────────────────────────────────────────────────────────────────
async function headless() {
  const existing = fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf-8')) : {};
  const errors = validateHeadless(process.env, { personaExists: fs.existsSync(PERSONA_PATH), currentEnv: existing });
  if (errors.length) {
    console.error('\n  Can\'t set up with these values. Nothing was written.\n');
    for (const [k, why] of errors) console.error(`    ${k.padEnd(18)} ${why}`);
    console.error('');
    return 2;
  }
  ensureEnvFile();
  const e = process.env;
  const updates = {};
  const provider = (e.LLM_PROVIDER || (state.fresh ? 'gemini' : current.LLM_PROVIDER) || 'gemini').toLowerCase();
  const def = providerById(provider);
  const keysGiven = { hasGemini: Boolean(e.GEMINI_API_KEY), hasOpenrouter: Boolean(e.OPENROUTER_API_KEY) };
  for (const p of PROVIDERS) if (p.keyEnv && e[p.keyEnv]) updates[p.keyEnv] = e[p.keyEnv];
  // Suggestions for the keys given; any LLM_*_ the caller set wins.
  if (e.LLM_PROVIDER || state.fresh) {
    const have = new Set(PROVIDERS.filter((p) => p.keyEnv && (e[p.keyEnv] || current[p.keyEnv])).map((p) => p.id));
    have.add(provider);
    for (const j of JOBS) {
      const c = j.id === 'replies' ? { provider, model: e.LLM_MODEL || def?.model || current.LLM_MODEL } : suggest(j, have);
      const c2 = j.id === 'check' || j.id === 'background' ? { provider, model: e.LLM_MODEL || def?.model || current.LLM_MODEL } : c;
      Object.assign(updates, jobUpdates(j, c2, suggestBackup(j, c2, have)));
    }
    if (keysGiven.hasOpenrouter && !keysGiven.hasGemini) updates.TRANSCRIPTION_MODEL = 'google/gemini-3-flash-preview';
  }
  for (const j of JOBS) for (const f of ['PROVIDER', 'MODEL', 'FALLBACK_PROVIDER', 'FALLBACK_MODEL']) {
    if (e[`${j.prefix}${f}`] && j.id !== 'replies') updates[`${j.prefix}${f}`] = e[`${j.prefix}${f}`];
  }
  if (e.OWNER_JIDS) updates.OWNER_JIDS = e.OWNER_JIDS;
  if (e.LLM_MONTHLY_BUDGET_USD) updates.LLM_MONTHLY_BUDGET_USD = e.LLM_MONTHLY_BUDGET_USD;
  const enable = String(e.KARYASTHAN_ENABLE || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (enable.includes('life')) Object.assign(updates, { LIFE_ENABLED: 'true', ARCS_ENABLED: 'true', CHAT_INFLUENCE_ENABLED: 'true' });
  if (enable.includes('mind')) updates.MIND_ENABLED = 'true';
  if (e.WA_PHONE_NUMBER) updates.WA_PHONE_NUMBER = normalizePhone(e.WA_PHONE_NUMBER).digits;
  if (e.TIMEZONE) updates.TIMEZONE = e.TIMEZONE;
  else if (state.fresh) updates.TIMEZONE = detectTimeZone();
  if (Object.keys(updates).length) writeEnv(updates);
  say(`Saved ${Object.keys(updates).length} setting(s).`);
  await switchOffWhatCantWork();
  if (!fs.existsSync(PERSONA_PATH)) {
    const { persona, character } = personaFromEnv();
    savePersonaFile(persona);
    if (!fs.existsSync(IDENTITY_PATH)) writeIdentity(persona, character);
    say('Wrote persona.json and identity.md');
  }
  await stepDatabase();
  say('WhatsApp needs a person for the linking step.');
  finish();
  return 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (HEADLESS) return headless();
  if (!input.isTTY) {
    console.error('\n  No terminal here, and headless mode wasn\'t requested.\n');
    console.error('    In a terminal:  npm run setup');
    console.error('    Headless:       KARYASTHAN_NONINTERACTIVE=1 KARYASTHAN_NAME=Sam LLM_PROVIDER=gemini GEMINI_API_KEY=... npm run setup\n');
    return 2;
  }
  ensureEnvFile();
  console.log('\n  Karyasthan setup\n');
  if (state.fresh && state.done.length === 0) {
    say('This links a WhatsApp number to an AI that talks like a person.\n');
    say('! Automated WhatsApp clients can break WhatsApp\'s terms, and a number can');
    say('  get banned. Use a spare number you can lose.');
    say('! Tell the people in your groups that it\'s there.\n');
    say('Nothing is sent to anyone during setup. Stop any time with Ctrl-C;');
    say('the next run carries on where you stopped.');
  } else if (state.fresh) {
    say('Carrying on where you stopped.');
  } else {
    if (await menu() === 'updated') return 0;
    await stepDatabase();
    finish();
    return 0;
  }
  await stepModel();
  await stepCharacter();
  await stepNumber();
  await stepAbilities();
  await stepDashboard();
  await stepReview();
  heading('Database');
  await stepDatabase();
  await stepLink();
  await stepFirstCheck();
  await stepKeepRunning();
  finish();
  return 0;
}

main().then(
  (code) => { cleanup(); process.exit(code); },
  (err) => {
    cleanup();
    if (err instanceof Interrupted) {
      console.log('\n  Stopped. What you finished is saved. Run this to carry on:  npm run setup\n');
      process.exit(130);
    }
    console.error(`\n  Setup failed: ${err?.message || err}\n`);
    process.exit(1);
  },
);
