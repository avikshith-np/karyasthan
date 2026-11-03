// Shared helpers for the mind tests (scripts/mind-tests/*.test.js, spec 008).
//
// Import this module FIRST in a test file: on load it points DB_PATH at a
// per-process scratch DB under data/, forces DRY_RUN and quiets the logger — all
// before anything imports src/utils/config.js, which reads the env once. (The
// quickstart says os.tmpdir(), but db.js's safePath() refuses any path outside the
// project root, so the scratch DB lives in the gitignored data/ like life-tests.)
// Nothing here touches the network or a real model: every model, Jev, gate, socket
// and life dependency is a fake that records its inputs.
//
//   import { setupScratchDb, fakeClock, fakeCallRole, seedGroup, check, eq, report } from './_helpers.js';
//   const { db } = await setupScratchDb();
//   …
//   report();

import { TEST_ZONE } from '../test-zone.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const testName = path.basename(process.argv[1] || 'mind', '.js').replace(/[^\w.-]/g, '_');
export const SCRATCH_DB_REL = `./data/mind-test-${testName}-${process.pid}.db`;
export const SCRATCH_DB_PATH = path.join(PROJECT_ROOT, SCRATCH_DB_REL);

process.env.DB_PATH = SCRATCH_DB_REL;
process.env.DRY_RUN = 'true';
process.env.TIMEZONE = TEST_ZONE;   // never an install's own
process.env.LOG_LEVEL = process.env.MIND_TEST_LOG_LEVEL || 'error';
// Never let a developer .env leak owner identities or a live switch into a test.
process.env.OWNER_JIDS = process.env.MIND_TEST_OWNER_JIDS || '';
process.env.MIND_ENABLED = 'false';
process.env.ARCS_CLAIM_CHECK_ENABLED = 'false';   // 020 E3: its own test turns it on
process.env.ARCS_STANDING_ENABLED = 'false';   // 020 D2: its own test turns it on; its sleep step is a clerk call

/** True when the runner was given `-- --live` (opt-in paid calls; never in CI). */
export const LIVE = process.argv.includes('--live');

export const DAY = 86400;
export const HOUR = 3600;

function removeScratchFiles() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(SCRATCH_DB_PATH + suffix); } catch { /* absent */ }
  }
  // A ladder backup is only written for a DB that already had tables; remove ours if any.
  const backups = path.join(path.dirname(SCRATCH_DB_PATH), 'backups');
  try {
    for (const f of fs.readdirSync(backups)) {
      if (f.startsWith(path.basename(SCRATCH_DB_PATH, '.db') + '-v')) fs.unlinkSync(path.join(backups, f));
    }
    if (!fs.readdirSync(backups).length) fs.rmdirSync(backups);
  } catch { /* no backups dir */ }
}

let scratchOpen = false;
let closeDbRef = null;

/**
 * Fresh scratch DB built by the real ladder (schema.sql + v1..latest, v10 mind
 * included). Returns { db, path, cleanup }. Refuses to run if config was imported
 * before this module set DB_PATH (the test would otherwise open the worktree's
 * default database) or if the ladder did not reach its latest version.
 */
export async function setupScratchDb() {
  cleanup();
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
  if (uv < 10 || !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mind_runs'`).get()) {
    throw new Error('ladder did not create the mind tables — is 010-mind registered in src/memory/migrations/index.js?');
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

process.on('exit', cleanup);

// Some transitive imports create data/media-cache/{gifs,stickers} (and data/) at module
// load. Remember what existed before this process and remove only the EMPTY dirs it
// left behind, on exit (not in cleanup(), which setupScratchDb also runs at start).
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LEFTOVER_DIRS = [
  path.join(DATA_DIR, 'media-cache', 'gifs'),
  path.join(DATA_DIR, 'media-cache', 'stickers'),
  path.join(DATA_DIR, 'media-cache'),
  DATA_DIR,
];
const preexisting = new Set(LEFTOVER_DIRS.filter(d => fs.existsSync(d)));
process.on('exit', () => {
  for (const d of LEFTOVER_DIRS) {
    if (preexisting.has(d)) continue;
    try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* absent, or not empty */ }
  }
});

/** Any network access in a mind test is a bug: make it loud. */
export function blockNetwork() {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('network is off in mind tests'); };
  return calls;
}

// ── Clock ──────────────────────────────────────────────────────────────────

/**
 * Controllable clock in unix SECONDS. `clock.fn` is a bound now() for setClock()
 * (src/mind/clock.js) / setStoreClock() (src/mind/store.js).
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

// ── Models ─────────────────────────────────────────────────────────────────

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Stand-in for callRole(role, system, user, opts) → { text, provider, model, usage,
 * costUsd, fellBack, status, skipped? }. `script` maps a caller label
 * (opts.caller, e.g. 'mind.think') — or `role:<role>` as a fallback key — to a
 * responder (system, user, opts, index) returning:
 *   - a string → an ok result with that text;
 *   - an object → merged over the ok result (e.g. { skipped:'budget', text:null },
 *     { fellBack:true, model:'fallback-model' });
 *   - or it throws (callRole itself never throws; the fake converts it to status:'error').
 * Every call is recorded in `calls` ({role, system, user, opts}); a caller with no
 * script is recorded in `unscripted` and returns text:null (status:'unscripted').
 */
export function fakeCallRole(script = {}) {
  const calls = [];
  const unscripted = [];
  const perCaller = new Map();
  async function fn(role, system, user, opts = {}) {
    const caller = opts?.caller || null;
    calls.push({ role, system: structuredClone(system), user, opts: { ...opts } });
    const responder = (caller && script[caller]) || script[`role:${role}`];
    const base = { text: null, provider: 'fake', model: `fake-${role}`, usage: { ...EMPTY_USAGE }, costUsd: 0,
      fellBack: false, status: 'ok' };
    if (!responder) {
      unscripted.push({ role, caller });
      return { ...base, status: 'unscripted' };
    }
    const index = perCaller.get(caller) || 0;
    perCaller.set(caller, index + 1);
    try {
      const out = await responder(system, user, opts, index);
      if (out == null) return { ...base, text: null };
      if (typeof out === 'string') return { ...base, text: out };
      return { ...base, ...out };
    } catch (err) {
      return { ...base, text: null, status: 'error', lastError: err.message };
    }
  }
  return {
    fn,
    calls,
    unscripted,
    callsFor: (caller) => calls.filter(c => c.opts.caller === caller),
    reset() { calls.length = 0; unscripted.length = 0; perCaller.clear(); },
  };
}

/** One Jev `choice` answer in askJev's shape (`answers.<q>.choice/confidence`). */
export function jevChoice(choice, probabilities = { [choice]: 1 }) {
  return { choice, confidence: probabilities[choice] ?? 0, probabilities };
}

/** One Jev `noul` answer with probability p — the live wire shape ({ type, noul }), nothing else. */
export function jevNoul(p) {
  return { type: 'noul', noul: p };
}

/**
 * Stand-in for askJev({state, questions, caller}) → { model, answers, usage, ms }.
 * `respond(req, index)` returns the `answers` object; throw in it — or call
 * jev.fail(err) / jev.failBudget() — to simulate a Jev error or a BudgetError.
 */
export function fakeJev(respond = () => ({})) {
  let failWith = null;
  const jev = {
    calls: [],
    fail(err = new Error('fake Jev failure')) { failWith = err; return jev; },
    async failBudget(state = { reason: 'budget' }) {
      const { BudgetError } = await import('../../src/brain/usage.js');
      failWith = new BudgetError('jev', state);
      return jev;
    },
    recover() { failWith = null; return jev; },
    reset() { jev.calls.length = 0; failWith = null; return jev; },
    async fn(req) {
      const index = jev.calls.length;
      jev.calls.push(structuredClone(req ?? {}));
      if (failWith) throw failWith;
      const answers = await respond(req, index);
      return { model: 'fake-jev', answers: answers || {}, usage: { input_tokens: 0, output_tokens: 0, cost: 0 }, ms: 0 };
    },
  };
  jev.fn = jev.fn.bind(jev);
  return jev;
}

/**
 * Stand-in for evaluateResponse(text, snippet, opts) → { pass, score, reason, latencyMs }.
 * `verdict` is an object or (text, snippet, opts, index) → object. Records calls.
 */
export function fakeGate(verdict = { pass: true, score: 0.8, reason: 'ok' }) {
  const calls = [];
  async function fn(text, snippet, opts = {}) {
    const index = calls.length;
    calls.push({ text, snippet, opts: { ...opts } });
    const v = typeof verdict === 'function' ? await verdict(text, snippet, opts, index) : verdict;
    return { latencyMs: 0, ...v };
  }
  return { fn, calls, set(v) { verdict = v; }, reset() { calls.length = 0; } };
}

// ── WhatsApp ───────────────────────────────────────────────────────────────

/** Minimal Baileys socket double (records sendMessage / readMessages / presence). */
export function fakeSock({ user = { id: '10000000000:1@s.whatsapp.net', lid: '10000000000:1@lid' } } = {}) {
  const sock = {
    user,
    log: [],
    sent: [],
    async readMessages(keys) { sock.log.push({ kind: 'read', keys }); },
    async sendPresenceUpdate(type, jid) { sock.log.push({ kind: 'presence', type, jid }); },
    async sendMessage(jid, content, opts) {
      const key = { remoteJid: jid, fromMe: true, id: `fake-${sock.sent.length + 1}` };
      sock.sent.push({ jid, content, opts });
      sock.log.push({ kind: 'send', jid });
      return { key, message: content };
    },
    reset() { sock.log.length = 0; sock.sent.length = 0; },
  };
  return sock;
}

/**
 * Stand-in for actions.sendText(sock, jid, text, quoted, opts). Returns a sent
 * message ({ key }) or, after `failNext()` / with `returnNull`, null (a real send
 * that returned nothing → the caller must record send_failed). Records every call.
 */
export function fakeSendText({ returnNull = false } = {}) {
  const sent = [];
  let failOnce = false;
  async function fn(sock, jid, text, quoted = null, opts = {}) {
    sent.push({ jid, text, quoted, opts: { ...opts } });
    if (returnNull || failOnce) { failOnce = false; return null; }
    return { key: { remoteJid: jid, fromMe: true, id: `sent-${sent.length}` } };
  }
  return { fn, sent, failNext() { failOnce = true; }, reset() { sent.length = 0; } };
}

/** Stand-in for events.withChatLock(chatJid, fn): runs fn, records the chat and nesting. */
export function fakeWithChatLock() {
  const locks = [];
  let depth = 0;
  async function fn(chatJid, work) {
    locks.push(chatJid);
    depth++;
    try { return await work(); } finally { depth--; }
  }
  return { fn, locks, held: () => depth > 0, reset() { locks.length = 0; } };
}

// ── Life ───────────────────────────────────────────────────────────────────

/**
 * Stand-in for the life facade (src/life/index.js) as the mind reads it:
 * onTick, isLifeOn, isAwakeAt, getState, listEvents, lifeGuardNote, plus the R26
 * additions availabilityNow, inPhoneCheckNow, embargoActive, overSelfMentionBudget.
 * Drive it with `life.tick(view, info)` (calls every subscriber synchronously, in
 * order, and returns how long the callbacks took in ms). Every knob is a plain
 * field so a test can flip it between ticks.
 */
export function fakeLife({ on = true, awake = () => true, availability = 'free', embargo = false,
  phoneCheck = false, overBudget = () => false, events = [], state = null, guardNote = '' } = {}) {
  const subs = new Set();
  const life = {
    on, awake, availability, embargo, phoneCheck, overBudget, events, state, guardNote,
    ticks: 0,
    onTick(fn) {
      if (typeof fn !== 'function') throw new Error('fakeLife: onTick expects a function');
      subs.add(fn);
      return () => subs.delete(fn);
    },
    subscribers: () => subs.size,
    tick(view = life.state, info = {}) {
      life.ticks++;
      const t0 = performance.now();
      for (const fn of [...subs]) fn(view, { at: info.at ?? null, catchUp: false, reanchored: false, events: [], crossings: [], ...info });
      return performance.now() - t0;
    },
    isLifeOn: () => !!life.on,
    isAwakeAt: (unix) => !!life.awake(unix),
    getState: () => life.state,
    lifeGuardNote: () => life.guardNote,
    availabilityNow: () => (life.on ? life.availability : null),
    inPhoneCheckNow: () => !!life.phoneCheck,
    embargoActive: () => !!life.embargo,
    overSelfMentionBudget: (chatJid) => !!life.overBudget(chatJid),
    listEvents({ after = 0, order = 'asc', limit = 100, types = null } = {}) {
      let list = life.events.filter(e => e.id > after && (!types || types.includes(e.type)));
      list = list.sort((a, b) => (order === 'desc' ? b.id - a.id : a.id - b.id));
      return list.slice(0, limit);
    },
  };
  return life;
}

// ── Seeds (invented, persona-neutral names) ────────────────────────────────

export const NAMES = ['Avery', 'Blake', 'Casey', 'Drew', 'Emery', 'Finley', 'Gray', 'Harper'];

let seq = 0;
async function dbh() {
  const { getDb } = await import('../../src/memory/db.js');
  return getDb();
}

/** The bot's own identity (src/utils/selfIdentity.js), so isSelfJid/mentions resolve. */
export async function setBot({ pn = '10000000000:1@s.whatsapp.net', lid = '10000000000:1@lid' } = {}) {
  const { setSelfIdentity } = await import('../../src/utils/selfIdentity.js');
  setSelfIdentity({ id: pn, lid });
  return { pn: pn.replace(/:\d+(?=@)/, ''), lid: lid.replace(/:\d+(?=@)/, '') };
}

/**
 * A person with a canonical LID id, optional PN form bound to it, and a push name.
 * Returns the canonical jid.
 */
export async function seedPerson({ jid, name = null, pn = null, at = Math.floor(Date.now() / 1000) - 200 * DAY } = {}) {
  const db = await dbh();
  const id = jid || `${7000 + (++seq)}@lid`;
  db.prepare(`INSERT OR IGNORE INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)`).run(id, name, at);
  db.prepare(`INSERT OR IGNORE INTO person_identities (jid, person_jid, kind, source, seen_at)
    VALUES (?, ?, ?, 'sync', ?)`).run(id, id, id.endsWith('@lid') ? 'lid' : 'pn', at);
  if (pn) {
    const { recordIdentity } = await import('../../src/memory/identity.js');
    recordIdentity(pn, id, 'sync');
  }
  return id;
}

/**
 * A group with members (each `{ jid, joinedAt }` or a bare jid joined at `at`),
 * marked freshly synced so membership checks pass. Returns the group jid.
 */
export async function seedGroup({ jid, name = 'Group', members = [], at = Math.floor(Date.now() / 1000) - 100 * DAY,
  synced = true } = {}) {
  const db = await dbh();
  const g = jid || `1203630000000${String(++seq).padStart(5, '0')}@g.us`;
  db.prepare(`INSERT OR IGNORE INTO groups (jid, name, joined_at) VALUES (?, ?, ?)`).run(g, name, at);
  const groupStore = await import('../../src/memory/groupStore.js');
  for (const m of members) {
    const pj = typeof m === 'string' ? m : m.jid;
    const joinedAt = typeof m === 'string' ? at : (m.joinedAt ?? at);
    groupStore.upsertMember(g, pj, 'member', joinedAt);
  }
  if (synced) {
    const membership = await import('../../src/memory/membership.js');
    membership.__markSyncedForTest(g);
  }
  return g;
}

/**
 * One stored message. `chat` is a group jid or a DM chat form; `fromSelf` marks the
 * bot's own line. Returns { id, rowid, ts }.
 */
export async function seedMessage({ chat, sender, text = 'hello', ts = Math.floor(Date.now() / 1000), fromSelf = false,
  type = 'text', noLearn = false, expiresAt = null, mentions = null, quotedId = null, id = null } = {}) {
  const db = await dbh();
  const msgId = id || `M${++seq}-${process.pid}`;
  const metadata = mentions ? { mentionedJids: mentions } : {};
  const info = db.prepare(`INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, message_type, quoted_id,
      is_from_self, timestamp, metadata_json, no_learn, expires_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(msgId, chat, sender, text, type, quotedId, fromSelf ? 1 : 0, ts, JSON.stringify(metadata), noLearn ? 1 : 0, expiresAt);
  return { id: msgId, rowid: Number(info.lastInsertRowid), ts };
}

/** A DM conversation: `lines` = [{ text, fromSelf?, ts? }] in order, `step` seconds apart. */
export async function seedDm({ person, chat = person, lines = [], startTs = Math.floor(Date.now() / 1000) - HOUR, step = 60,
  bot = '10000000000@s.whatsapp.net' } = {}) {
  const out = [];
  let ts = startTs;
  for (const l of lines) {
    const line = typeof l === 'string' ? { text: l } : l;
    out.push(await seedMessage({ chat, sender: line.fromSelf ? bot : person, text: line.text, ts: line.ts ?? ts,
      fromSelf: !!line.fromSelf }));
    ts += step;
  }
  return out;
}

// ── Assertions (✓/✗ lines, exit code at the end) ───────────────────────────

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
