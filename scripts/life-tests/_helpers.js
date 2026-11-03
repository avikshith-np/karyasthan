// Shared helpers for the life-core tests (scripts/life-tests/*.test.js).
//
// Import this module FIRST in a test file: on load it points DB_PATH at a
// per-process scratch DB under data/ (db.js's safePath refuses anything outside
// the project, so os.tmpdir() is not an option), forces DRY_RUN and quiets the
// logger — all before anything imports src/utils/config.js, which reads the env
// once. Nothing here touches the network or an LLM.
//
//   import { setupScratchDb, fakeClock, fakeJev, fakeSock, check, eq, report } from './_helpers.js';
//   const { db, cleanup } = await setupScratchDb();
//   …
//   cleanup(); report();

import { TEST_ZONE } from '../test-zone.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const testName = path.basename(process.argv[1] || 'life', '.js').replace(/[^\w.-]/g, '_');
export const SCRATCH_DB_REL = `./data/life-test-${testName}-${process.pid}.db`;
export const SCRATCH_DB_PATH = path.join(PROJECT_ROOT, SCRATCH_DB_REL);

process.env.DB_PATH = SCRATCH_DB_REL;
process.env.DRY_RUN = 'true';
process.env.TIMEZONE = process.env.TEST_TIMEZONE || TEST_ZONE;   // never an install's own; a golden recorded in another asks for it
process.env.ARCS_CLAIM_CHECK_ENABLED = 'false';   // 020 E3: its own test turns it on; other suites count their model calls
process.env.ARCS_STANDING_ENABLED = 'false';   // 020 D2: the same; arcs and chat-influence helpers re-export this one
process.env.LOG_LEVEL = process.env.LIFE_TEST_LOG_LEVEL || 'error';

// 014 geo (plan §2, R11): no test reaches a real host. Any fetch to a
// non-loopback host throws (a missed geo-client injection fails loudly); a
// test that needs its own stub replaces globalThis.fetch after this import.
// `-- --live` (opt-in paid calls) leaves fetch alone.
if (!process.argv.includes('--live')) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let host = '';
    try { host = new URL(typeof input === 'string' ? input : input?.url ?? String(input)).hostname; } catch { host = ''; }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('network is off in life/arcs tests (non-loopback fetch)');
    return realFetch(input, init);
  };
}

/** True when the runner was given `-- --live` (opt-in real calls, e.g. a world seed). */
export const LIVE = process.argv.includes('--live');

function removeScratchFiles() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(SCRATCH_DB_PATH + suffix); } catch { /* absent */ }
  }
}

let scratchOpen = false;
let closeDbRef = null;

/**
 * Fresh scratch DB built by the real 006 ladder — runMigrations() applies
 * schema.sql plus every step, the 009 life steps (v8 world-events, v9 life-ops)
 * included. Returns { db, path, cleanup }. Refuses to run if config was imported
 * before this module set DB_PATH — the test would otherwise open the worktree's
 * default database — and if the ladder did not reach its latest version.
 */
export async function setupScratchDb() {
  cleanup(); // a second call in one process closes the old connection before unlinking
  const { config } = await import('../../src/utils/config.js');
  if (path.resolve(config.projectRoot, config.dbPath) !== SCRATCH_DB_PATH) {
    throw new Error(`config.dbPath is ${config.dbPath}, not the scratch DB — import _helpers.js before anything that loads config`);
  }
  const { getDb, runMigrations, closeDb, LATEST_SCHEMA_VERSION } = await import('../../src/memory/db.js');
  closeDbRef = closeDb;
  runMigrations();
  const db = getDb();
  scratchOpen = true;
  const uv = db.pragma('user_version', { simple: true });
  if (uv !== LATEST_SCHEMA_VERSION) throw new Error(`scratch DB is v${uv}, ladder latest is v${LATEST_SCHEMA_VERSION}`);
  for (const t of ['world_events', 'world_snapshots', 'life_queue', 'life_claims']) {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)) {
      throw new Error(`ladder did not create ${t} — are the 009 steps registered in src/memory/migrations/index.js?`);
    }
  }
  return { db, path: SCRATCH_DB_PATH, cleanup };
}

/** Close the shared connection and delete the scratch DB files. Idempotent. */
export function cleanup() {
  if (scratchOpen && closeDbRef) {
    try { closeDbRef(); } catch { /* already closed */ }
  }
  scratchOpen = false;
  removeScratchFiles();
}

// Never leave a scratch DB behind, even when a test throws.
process.on('exit', cleanup);

// ── Fakes ─────────────────────────────────────────────────────────────────

/**
 * Controllable clock in unix SECONDS (src/life/clock.js convention).
 * `clock.fn` is a bound now() to hand to setClock().
 */
export function fakeClock(startUnix = Date.UTC(2026, 9, 27, 3, 30) / 1000) {
  let t = Math.floor(startUnix);
  const clock = {
    now: () => t,
    set(unix) { t = Math.floor(unix); return t; },
    advance({ seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) {
      t += Math.round(seconds + minutes * 60 + hours * 3600 + days * 86400);
      return t;
    },
  };
  clock.fn = clock.now;
  return clock;
}

/** One Jev `choice` answer in askJev's shape (`answers.<q>.choice/confidence`). */
export function jevChoice(choice, probabilities = { [choice]: 1 }) {
  return { choice, confidence: probabilities[choice] ?? 0, probabilities };
}

/**
 * Stand-in for askJev({state, questions}) → { model, answers, usage, ms }.
 * `respond(req, callIndex)` returns the `answers` object (may be async); throw in
 * it — or call jev.fail(err) — to simulate a Jev error. Every request is recorded
 * in `jev.calls` so tests can assert "no Jev without a trigger".
 */
export function fakeJev(respond = () => ({})) {
  let failWith = null;
  const jev = {
    calls: [],
    fail(err = new Error('fake Jev failure')) { failWith = err; return jev; },
    recover() { failWith = null; return jev; },
    reset() { jev.calls.length = 0; failWith = null; return jev; },
    async fn(req) {
      const index = jev.calls.length;
      jev.calls.push(structuredClone(req ?? {}));
      if (failWith) throw failWith;
      const answers = await respond(req, index);
      return { model: 'fake-jev', answers: answers || {}, usage: {}, ms: 0 };
    },
  };
  jev.fn = jev.fn.bind(jev);
  return jev;
}

/**
 * Minimal Baileys socket double. Records readMessages / sendPresenceUpdate /
 * sendMessage calls in order (`sock.log` holds all of them with their kind).
 */
export function fakeSock({ user = { id: '10000000000@s.whatsapp.net' } } = {}) {
  const sock = {
    user,
    log: [],
    reads: [],
    presence: [],
    sent: [],
    async readMessages(keys) {
      sock.reads.push(keys);
      sock.log.push({ kind: 'read', keys });
    },
    async sendPresenceUpdate(type, jid) {
      sock.presence.push({ type, jid });
      sock.log.push({ kind: 'presence', type, jid });
    },
    async sendMessage(jid, content, opts) {
      const key = { remoteJid: jid, fromMe: true, id: `fake-${sock.sent.length + 1}` };
      sock.sent.push({ jid, content, opts });
      sock.log.push({ kind: 'send', jid, content });
      return { key, message: content };
    },
    reset() {
      sock.log.length = 0; sock.reads.length = 0; sock.presence.length = 0; sock.sent.length = 0;
    },
  };
  return sock;
}

// ── Assertions (test-privacy.js style: ✓/✗ lines, exit code at the end) ────

let passes = 0;
let failures = 0;

export function section(title) {
  console.log(`\n${title}`);
}

export function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
  return !!cond;
}

function same(a, b) {
  if (Object.is(a, b)) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

export function eq(name, actual, expected) {
  return check(name, same(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function near(name, actual, expected, tol = 1e-6) {
  return check(name, typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    `expected ${expected} ±${tol}, got ${actual}`);
}

/** Passes when fn throws (optionally with a message matching `re`). Sync only. */
export function throws(name, fn, re) {
  try { fn(); } catch (err) {
    return check(name, !re || re.test(String(err?.message ?? err)), `threw "${err?.message}"`);
  }
  return check(name, false, 'did not throw');
}

/** Async variant of throws(). */
export async function rejects(name, fn, re) {
  try { await fn(); } catch (err) {
    return check(name, !re || re.test(String(err?.message ?? err)), `rejected "${err?.message}"`);
  }
  return check(name, false, 'did not reject');
}

/** Print the tally, clean up the scratch DB and exit 1 on any failure. */
export function report() {
  console.log(`\n${passes} passed, ${failures} failed`);
  cleanup();
  if (failures) process.exit(1);
}
