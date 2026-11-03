#!/usr/bin/env node
// Checks an install and says what's wrong. Reads only; safe to paste when asking for help,
// because keys and numbers are masked. Exit 1 when something is wrong.
//   npm run doctor [-- --offline] [-- --json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseEnv, providerById, credsAreLinked, mask } from './setup/lib.js';
import { JOBS, currentChoice, priceKnown } from './setup/suggestions.js';
import { testModel, failureWords, isInconclusive } from './setup/keys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const JSON_OUT = argv.includes('--json');

const results = [];
const ok = (what) => results.push({ level: 'ok', what });
const warn = (what, how = '') => results.push({ level: 'warn', what, how });
const bad = (what, how = '') => results.push({ level: 'bad', what, how });

const modeOf = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };

// ── Machine ───────────────────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) bad(`Node ${process.versions.node} is too old`, 'Install Node 22: nvm install 22');
else ok(`Node ${process.versions.node}`);
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  ok('SQLite loads');
} catch {
  bad('SQLite doesn\'t load', 'After changing Node versions, run: npm rebuild better-sqlite3');
}

// ── Settings ──────────────────────────────────────────────────────────────────
const envPath = path.join(ROOT, '.env');
let env = {};
if (!fs.existsSync(envPath)) {
  bad('No .env', 'Run: npm run setup');
} else {
  env = parseEnv(fs.readFileSync(envPath, 'utf-8'));
  if ((modeOf(envPath) & 0o077) !== 0) warn('.env can be read by other users', 'Run: chmod 600 .env');
  else ok('.env is private');
  const example = parseEnv(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8'));
  const fresh = Object.keys(example).filter((k) => !(k in env));
  if (fresh.length) warn(`${fresh.length} settings from .env.example aren't in your .env; their defaults apply`);
}

// ── Models ────────────────────────────────────────────────────────────────────
const tested = new Set();
for (const job of JOBS) {
  const c = currentChoice(job, env);
  if (!c.provider || !c.model) {
    if (job.id === 'replies') bad('No model for replies', 'Run: npm run setup');
    else if (job.id === 'deep' && (env.LIFE_ENABLED === 'true' || env.MIND_ENABLED === 'true')) bad('Life or the mind is on with no deep thinking model', 'Run: npm run setup');
    continue;
  }
  const def = providerById(c.provider);
  const key = def?.keyEnv ? env[def.keyEnv] : '';
  if (def?.keyEnv && !key) {
    const fix = `Add ${def.keyEnv} to .env (${def.keyUrl})`;
    if (job.id === 'replies') bad(`${job.label}: no ${def.label} key`, fix);
    else warn(`${job.label}: no ${def.label} key, so this job is skipped`, fix);
    continue;
  }
  if (job.id === 'deep' && !priceKnown(ROOT, c.provider, c.model) && env.MIND_ENABLED === 'true') {
    bad(`${job.label}: ${c.model} has no price, and the mind refuses that`, 'Add it to data/llm-prices.json, or run: npm run setup');
  }
  const pair = `${c.provider}/${c.model}`;
  if (OFFLINE) { ok(`${job.label}: ${pair}${key ? `, key ${mask(key)}` : ''} (not tested)`); continue; }
  if (tested.has(pair)) { ok(`${job.label}: ${pair}`); continue; }
  tested.add(pair);
  const r = await testModel({ provider: c.provider, model: c.model, key, baseUrl: env.LLM_BASE_URL });
  if (r.ok) ok(`${job.label}: ${pair} answers`);
  else if (isInconclusive(r.why)) warn(`${job.label}: ${failureWords(r.why, def?.label || c.provider)}`);
  else bad(`${job.label}: ${failureWords(r.why, def?.label || c.provider)}`, 'Run: npm run setup');
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────
if (!env.WA_PHONE_NUMBER) bad('No WhatsApp number', 'Run: npm run setup');
else ok(`WhatsApp number ${mask(env.WA_PHONE_NUMBER)}`);
const authDir = path.resolve(ROOT, env.AUTH_PATH || './data/auth_info_baileys');
let linked = false;
try { linked = credsAreLinked(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8')); } catch { /* none */ }
if (linked) ok('Linked to WhatsApp');
else bad('Not linked to WhatsApp', `Run: node scripts/pair.js`);

// ── Files and database ────────────────────────────────────────────────────────
const dataDir = path.join(ROOT, 'data');
if (fs.existsSync(dataDir)) {
  if ((modeOf(dataDir) & 0o077) !== 0) warn('data/ can be read by other users', 'Run: chmod 700 data');
  else ok('data/ is private');
}
const dbPath = path.resolve(ROOT, env.DB_PATH || './data/karyasthan.db');
if (fs.existsSync(dbPath)) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    ok(`Database at version ${db.pragma('user_version', { simple: true })}`);
    const budget = Number(env.LLM_MONTHLY_BUDGET_USD || 30);
    const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
    let spent = null;
    try { spent = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_usage WHERE ts >= ?').get(Math.floor(month.getTime() / 1000)).s; } catch { /* older schema */ }
    if (spent != null && budget > 0) {
      const pct = Math.round((spent / budget) * 100);
      if (pct >= 90) warn(`Budget: ${pct}% of $${budget} used this month. Background thinking stops at 100%.`);
      else ok(`Budget: $${spent.toFixed(2)} of $${budget} this month`);
    }
    db.close();
  } catch (err) {
    bad(`Database can't be read: ${err.message}`);
  }
} else {
  warn('No database yet. It\'s created at setup or first start.');
}

// ── Abilities ─────────────────────────────────────────────────────────────────
const onByDefault = (k) => (env[k] || 'true').toLowerCase() !== 'false';
if (onByDefault('WEB_SEARCH_ENABLED') && !OFFLINE) {
  const url = (env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/+$/, '');
  try {
    const res = await fetch(`${url}/search?q=test&format=json`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) ok('Web search answers');
    else warn('Web search is on, but SearXNG refused', 'Enable JSON output in its settings, or set WEB_SEARCH_ENABLED=false');
  } catch {
    warn('Web search is on, but no SearXNG answered', 'Start it, or set WEB_SEARCH_ENABLED=false');
  }
}
if (onByDefault('JEV_PREFILTER_ENABLED') && !env.OPENROUTER_API_KEY && !env.JEV_API_KEY) warn('The pre-filter is on with no OpenRouter key', 'Set JEV_PREFILTER_ENABLED=false');

// ── Is it running? ────────────────────────────────────────────────────────────
let copies = 0;
try {
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      // pm2 renames its process, so the words may be split by spaces instead of NULs.
      const words = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split(/[\0 ]+/).filter(Boolean);
      if (path.basename(words[0] || '') !== 'node' || !/(^|\/)src\/index\.js$/.test(words[1] || '')) continue;
      if (path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`), words[1]) === path.join(ROOT, 'src/index.js')) copies += 1;
    } catch { /* gone, or not ours */ }
  }
  if (copies === 0) warn('It isn\'t running', 'Start it with: npm start');
  else if (copies === 1) ok('Running, one copy');
  else bad(`${copies} copies are running on one session`, 'They knock each other off WhatsApp. Stop all but one.');
} catch { /* no /proc here */ }

// ── Report ────────────────────────────────────────────────────────────────────
const failed = results.some((r) => r.level === 'bad');
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !failed, results }, null, 2));
} else {
  const mark = { ok: '✓', warn: '!', bad: '✗' };
  console.log('');
  for (const r of results) {
    console.log(`  ${mark[r.level]} ${r.what}`);
    if (r.how) console.log(`      ${r.how}`);
  }
  console.log('');
  console.log('  Keys and numbers are masked, so this is safe to paste.');
  console.log('');
}
process.exit(failed ? 1 : 0);
