#!/usr/bin/env node
// T030 — one simulated day of the mind (spec 008 quickstart §4) on a read-only copy of a
// real database, with stubbed models by default: nothing is sent and nothing leaves the
// machine. Also rehearses the pending migration steps (v9/v10 → latest) on that copy.
//
//   node scripts/mind-dry-run.js --source <path/to/karyasthan.db> [--day YYYY-MM-DD]
//        [--tick-minutes 15] [--jev-cost 0.001] [--keep] [--verbose] [--live]
//
// What it does:
//   1. Copies --source with VACUUM INTO over a READ-ONLY connection into
//      data/rehearsal/live-copy.db. The source is never opened for writing. The scratch
//      directory must be absent or empty, and is deleted at the end unless --keep.
//   2. Migration rehearsal on the copy: it must be at v9 or later. A copy already at the
//      latest version (the bot migrates at boot) gets one "already current" check; a copy
//      behind the code is migrated: runMigrations() must write a 0600 backup in a 0700
//      dir, apply exactly the pending steps (v10 … latest), add only those steps' tables
//      (mind_*, story_*, chat_influence_*, public_*) and leave every existing table's row
//      count unchanged. Either way a second run is a no-op.
//   3. Replay: every message of the chosen local day (default: the latest full local day
//      with messages) is held out and re-inserted tick by tick under a fake clock, so the
//      mind sees the day as it happened. The cadence is driven through a fake life.onTick
//      every --tick-minutes from 07:00 on that day to 07:30 the next morning (one night's
//      sleep). Life is "on", awake outside SLEEP_START_HOUR..SLEEP_END_HOUR, always free.
//      Groups are marked freshly synced (as after a WhatsApp connect).
//   4. Models are stubs: callRole / askJev / the quality gate return schema-valid answers
//      built from the labels in the real prompts, with token counts estimated from the
//      real prompt sizes plus per-caller thinking estimates (research R23), costed by the
//      real price table and written to the copy's llm_usage, so the mind's own budget
//      gates see the spend. sendText is a recorder (and DRY_RUN=true, proactive shadow).
//      fetch / sockets / DNS throw, and every attempt is counted.
//   5. Prints the rehearsal checks, the runs per kind, every model call per caller with
//      tokens and cost, self-state per chat, episodes, drafts, and a monthly projection
//      against the mind budget (roles.mind.budgetUsd) and the global cap
//      (LLM_MONTHLY_BUDGET_USD). Chats are shown as kind + a short id, never by name, and
//      no chat text is printed.
//
// --live keeps the real callRole/askJev/gate (paid calls; needs keys in the env; never in CI).
// Exit code 1 if a rehearsal check fails, a send or a network attempt happened, or the run
// threw.

import fs from 'fs';
import path from 'path';
import net from 'net';
import tls from 'tls';
import dns from 'dns';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRATCH = path.join(ROOT, 'data', 'rehearsal');
const COPY_REL = './data/rehearsal/live-copy.db';
const COPY = path.join(ROOT, COPY_REL);

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const LIVE = flag('live');
const KEEP = flag('keep');
const VERBOSE = flag('verbose');
const SOURCE = opt('source', process.env.MIND_DRY_RUN_SOURCE || null);
const DAY_ARG = opt('day');
const TICK_MIN = Math.max(5, Math.min(60, Number(opt('tick-minutes', 15)) || 15));
const JEV_COST = Math.max(0, Number(opt('jev-cost', 0.001)) || 0);
if (flag('help') || !SOURCE) {
  console.log('Usage: node scripts/mind-dry-run.js --source <path/to/karyasthan.db> [--day YYYY-MM-DD] [--tick-minutes 15]'
    + ' [--jev-cost 0.001] [--keep] [--verbose] [--live]');
  process.exit(SOURCE ? 0 : 2);
}
const sourceAbs = path.resolve(SOURCE);
if (!fs.existsSync(sourceAbs)) { console.error(`source not found: ${sourceAbs}`); process.exit(2); }
if (sourceAbs === COPY || sourceAbs.startsWith(SCRATCH + path.sep)) { console.error('the source must not be inside data/rehearsal/'); process.exit(2); }
if (fs.existsSync(SCRATCH) && fs.readdirSync(SCRATCH).length) {
  console.error(`${path.relative(ROOT, SCRATCH)}/ exists and is not empty — refusing to touch it (delete it first)`);
  process.exit(2);
}

// ── env (before anything imports src/utils/config.js) ────────────────────────
process.env.DB_PATH = COPY_REL;
process.env.DRY_RUN = 'true';
process.env.MIND_ENABLED = 'true';
process.env.MIND_PROACTIVE_MODE = 'shadow';
process.env.OWNER_JIDS = '';
process.env.DASHBOARD_ENABLED = 'false';
process.env.LOG_LEVEL = VERBOSE ? 'info' : (process.env.MIND_DRY_RUN_LOG_LEVEL || 'error');
if (!LIVE) {
  // A set (even empty) variable is never overridden by dotenv, so a .env next to the code
  // can't put a key or a reachable endpoint back.
  for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GLM_API_KEY', 'LLM_API_KEY',
    'LLM_LOCAL_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']) process.env[k] = '';
  process.env.SEARXNG_URL = 'http://127.0.0.1:9';
  process.env.LLM_BASE_URL = 'http://127.0.0.1:9';
}

// ── network off (stub mode): every attempt throws and is counted ─────────────
const netAttempts = [];
if (!LIVE) {
  const refuse = (what) => (...a) => { netAttempts.push(what); throw new Error(`network is off in the mind dry run (${what})`); };
  globalThis.fetch = async (url) => { netAttempts.push(`fetch ${String(url).slice(0, 40)}`); throw new Error('network is off in the mind dry run'); };
  net.Socket.prototype.connect = refuse('net.connect');
  net.connect = refuse('net.connect');
  net.createConnection = refuse('net.createConnection');
  tls.connect = refuse('tls.connect');
  dns.lookup = refuse('dns.lookup');
  dns.resolve = refuse('dns.resolve');
  if (dns.promises) { dns.promises.lookup = refuse('dns.promises.lookup'); dns.promises.resolve = refuse('dns.promises.resolve'); }
}

const { default: Database } = await import('better-sqlite3');

const results = [];   // rehearsal checks
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); return !!ok; };
const shortId = (jid) => {
  const s = String(jid || '');
  const kind = s.endsWith('@g.us') ? 'group' : 'dm';
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${kind}#${h.toString(36).slice(-4)}`;
};
const usd = (v) => `$${(Number(v) || 0).toFixed(4)}`;
const usd2 = (v) => `$${(Number(v) || 0).toFixed(2)}`;

let exitCode = 0;
let closeDb = null;

function tableCounts(db) {
  const out = {};
  for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all()) {
    out[t] = db.prepare(`SELECT COUNT(*) FROM "${t.replace(/"/g, '""')}"`).pluck().get();
  }
  return out;
}
const schemaOf = (db) => db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();

try {
  // ── 1. read-only copy ──────────────────────────────────────────────────────
  fs.mkdirSync(SCRATCH, { recursive: true, mode: 0o700 });
  {
    const src = new Database(sourceAbs, { readonly: true, fileMustExist: true });
    try { src.prepare('VACUUM INTO ?').run(COPY); } finally { src.close(); }
  }
  const pre = new Database(COPY, { readonly: true });
  const preVersion = pre.pragma('user_version', { simple: true });
  const preCounts = tableCounts(pre);
  pre.close();

  // ── 2. migration rehearsal ─────────────────────────────────────────────────
  const { config } = await import('../src/utils/config.js');
  if (path.resolve(config.projectRoot, config.dbPath) !== COPY) throw new Error(`config.dbPath is ${config.dbPath}, not the copy`);
  const dbMod = await import('../src/memory/db.js');
  closeDb = dbMod.closeDb;
  const { MIGRATIONS } = await import('../src/memory/migrations/index.js');
  const latest = dbMod.LATEST_SCHEMA_VERSION;
  // The ladder may have grown past v10 (spec 010 adds v11), and runMigrations() has no
  // "up to N" option: a v9 copy gets v10 and every later step, a v10 copy (live after
  // 008) only the later ones. Either way the rehearsal checks the v10 objects exist.
  const pendingSteps = MIGRATIONS.filter(m => m.version > preVersion);
  // A copy already at the latest version (the bot migrates at boot, so the live DB usually
  // is) has nothing to rehearse: one "already current" check, like arcs/public-dry-run.
  const behind = preVersion < latest;
  check(behind ? `copy is behind the code and at v9 or later (v${preVersion} → v${latest})`
    : `the copy is already at v${latest} (no migration to rehearse)`,
  latest >= 10 && preVersion >= 9 && preVersion <= latest, { preVersion, latest });
  const backupsDir = path.join(SCRATCH, 'backups');
  const r1 = dbMod.runMigrations();
  const db = dbMod.getDb();
  const backups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
  const postCounts = tableCounts(db);
  if (behind) {
    const expectedSteps = pendingSteps.map(m => `v${m.version}-${m.name}`);
    check(`runMigrations applied exactly the pending step(s) ${expectedSteps.join(', ')}`, r1.from === preVersion && r1.to === latest
      && JSON.stringify(r1.applied) === JSON.stringify(expectedSteps), { from: r1.from, to: r1.to, applied: r1.applied });
    const backupPath = r1.backup || (backups[0] ? path.join(backupsDir, backups[0]) : null);
    check('a backup was written before the step', !!backupPath && fs.existsSync(backupPath) && backups.length === 1, backups);
    if (backupPath && fs.existsSync(backupPath)) {
      const mode = fs.statSync(backupPath).mode & 0o777;
      const dmode = fs.statSync(path.dirname(backupPath)).mode & 0o777;
      check(`backup file 0600 in a 0700 dir (${mode.toString(8)} / ${dmode.toString(8)})`, mode === 0o600 && dmode === 0o700);
      const b = new Database(backupPath, { readonly: true });
      const bv = b.pragma('user_version', { simple: true });
      const bc = tableCounts(b);
      b.close();
      check(`the backup is the pre-step database (v${bv}, same row counts)`, bv === preVersion && JSON.stringify(bc) === JSON.stringify(preCounts));
    }
    check(`user_version is now ${latest}`, db.pragma('user_version', { simple: true }) === latest);
    const changed = Object.keys(preCounts).filter(t => postCounts[t] !== preCounts[t]);
    check(`row counts unchanged in all ${Object.keys(preCounts).length} existing tables`, changed.length === 0, changed);
    const added = Object.keys(postCounts).filter(t => !(t in preCounts));
    // Each step's own table prefix: v10 → mind_*, v11 → story_* (spec 010).
    const STEP_PREFIX = { 10: 'mind_', 11: 'story_', 12: 'chat_influence_', 13: 'public_', 14: 'story_scenes', 15: 'story_messages', 16: 'story_thoughts', 17: 'self_stance', 18: 'story_dreams', 19: 'story_standing', 20: 'story_check_', 21: 'review_' };
    const prefixes = pendingSteps.map(m => STEP_PREFIX[m.version]).filter(Boolean);
    const v10Applied = pendingSteps.some(m => m.version === 10);
    check(`only the steps' own tables were added (${added.length}: ${prefixes.join('|')}*)`,
      added.length > 0 && added.every(t => prefixes.some(px => t.startsWith(px)))
      && (!v10Applied || added.filter(t => t.startsWith('mind_')).length >= 10), added);
  } else {
    check('nothing applied, no backup written', r1.applied.length === 0 && r1.from === latest && r1.to === latest
      && backups.length === 0, { applied: r1.applied, backups: backups.length });
  }
  check('the v10 mind tables exist', ['mind_state', 'mind_runs', 'mind_nights', 'mind_proactive']
    .every(t => t in postCounts));
  check('no existing table was dropped', Object.keys(preCounts).every(t => t in postCounts));
  const schemaBefore = JSON.stringify(schemaOf(db));
  const r2 = dbMod.runMigrations();
  const backups2 = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
  check('a second runMigrations is a no-op (nothing applied, no new backup, schema identical)', r2.applied.length === 0
    && r2.from === latest && r2.to === latest && backups2.length === backups.length && JSON.stringify(schemaOf(db)) === schemaBefore,
  { applied: r2.applied, backups: backups2.length });
  try { dbMod.assertSchemaCurrent(); check('assertSchemaCurrent() passes', true); } catch (err) { check('assertSchemaCurrent() passes', false, err.message); }

  // ── 3. replay setup ────────────────────────────────────────────────────────
  const clock = await import('../src/mind/clock.js');
  const tz = config.timezone;
  const dayStart = (key) => {           // first unix second of a local day (15-min grid covers every real offset)
    const [y, m, d] = key.split('-').map(Number);
    for (let t = Date.UTC(y, m - 1, d) / 1000 - 14 * 3600; t < Date.UTC(y, m - 1, d) / 1000 + 14 * 3600; t += 900) {
      if (clock.dayKey(t) === key) return t;
    }
    throw new Error(`no start found for ${key}`);
  };
  const realNow = Math.floor(Date.now() / 1000);
  const todayKey = clock.dayKey(realNow);
  let DAY = DAY_ARG;
  if (!DAY) {
    const latestTs = db.prepare(`SELECT MAX(timestamp) FROM messages WHERE timestamp < ?`).pluck().get(dayStart(todayKey));
    if (!latestTs) throw new Error('no messages before today in the copy (pass --day)');
    DAY = clock.dayKey(latestTs);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error('--day must be YYYY-MM-DD');
  const D0 = dayStart(DAY);
  const D1 = dayStart(clock.nextDayKey(DAY));
  const cols = db.prepare(`PRAGMA table_info(messages)`).all().map(c => `"${c.name}"`).join(', ');
  db.exec(`CREATE TEMP TABLE dry_replay AS SELECT ${cols} FROM messages WHERE 0`);
  const held = db.transaction(() => {
    db.prepare(`INSERT INTO temp.dry_replay SELECT ${cols} FROM messages WHERE timestamp >= ? ORDER BY timestamp, rowid`).run(D0);
    db.prepare(`DELETE FROM messages WHERE timestamp >= ?`).run(D0);
    return db.prepare(`SELECT COUNT(*) FROM temp.dry_replay`).pluck().get();
  })();
  const replayRows = db.prepare(`SELECT rowid AS r, timestamp AS ts FROM temp.dry_replay WHERE timestamp < ? ORDER BY timestamp, rowid`).all(D1);
  const replayShape = db.prepare(`SELECT COUNT(*) AS n, SUM(is_from_self) AS self, SUM(message_type = 'reaction') AS reactions,
      COUNT(DISTINCT group_jid) AS chats FROM temp.dry_replay WHERE timestamp < ?`).get(D1);
  const insertUpTo = (() => {
    let i = 0;
    const ins = db.prepare(`INSERT INTO messages (${cols}) SELECT ${cols} FROM temp.dry_replay WHERE rowid = ?`);
    return (t) => {
      let n = 0;
      while (i < replayRows.length && replayRows[i].ts <= t) { ins.run(replayRows[i].r); i++; n++; }
      return n;
    };
  })();

  // The bot's own identity, from its stored lines (so isSelfJid / mentions resolve).
  const selfRow = db.prepare(`SELECT sender_jid FROM messages WHERE is_from_self = 1 AND sender_jid LIKE '%@s.whatsapp.net' ORDER BY rowid DESC LIMIT 1`).pluck().get()
    || db.prepare(`SELECT sender_jid FROM temp.dry_replay WHERE is_from_self = 1 ORDER BY rowid DESC LIMIT 1`).pluck().get();
  if (selfRow) (await import('../src/utils/selfIdentity.js')).setSelfIdentity({ id: selfRow, lid: null });
  const membership = await import('../src/memory/membership.js');
  const groups = db.prepare(`SELECT jid FROM groups`).pluck().all();
  for (const g of groups) membership.__markSyncedForTest(g, { syncedAt: realNow });

  // ── 4. fakes ───────────────────────────────────────────────────────────────
  let simNow = D0 + 7 * 3600;
  const fc = () => simNow;
  clock.setClock(fc);
  const usage = await import('../src/brain/usage.js');
  const { resolveRole } = await import('../src/brain/roles.js');
  const ledgerStart = db.prepare(`SELECT COALESCE(MAX(id), 0) FROM llm_usage`).pluck().get();

  const tok = (s) => Math.ceil(String(s ?? '').length / 3.5);
  const sysText = (s) => (typeof s === 'string' ? s : [s?.core, s?.profile].filter(Boolean).join('\n'));
  // Thinking tokens per caller (research R23; output includes thinking).
  const THINKING = { 'mind.think': { low: 1000, medium: 2500, high: 5000 }, 'mind.sleep': { low: 1000, medium: 2500, high: 5000 },
    'mind.selfmodel': { low: 800, medium: 1600, high: 3000 }, 'mind.draft': { low: 250, medium: 600, high: 1200 } };
  const CLERK_THINKING = 300;
  const MOUTH_THINKING = 200;
  const stubStats = { digestNoHumans: 0, thinkLabels: 0, thinkReach: 0 };
  let nudged = false;
  const sends = [];

  const J = (o) => JSON.stringify(o);
  function respond(role, caller, system, user, opts) {
    const u = String(user ?? '');
    switch (caller) {
      case 'mind.digest': {
        const humans = [...u.matchAll(/\[L(\d+)\] P\d+:/g)].map(m => `L${m[1]}`);
        if (!humans.length) { stubStats.digestNoHumans++; return J({ v: 1, summary: 'Only the bot spoke here.', today_note: null, tone: 'neutral', threads: [], evidence: [] }); }
        const threads = humans.length >= 2
          ? [{ text: 'a plan for later in the week', evidence: [humans[0]] }, { text: 'a running joke from earlier', evidence: [humans[humans.length - 1]] }]
          : [{ text: 'a quick update from one member', evidence: [humans[0]] }];
        return J({ v: 1, summary: 'Members swapped updates, made a loose plan for later in the week and kept a running joke going.',
          today_note: humans.length >= 3 ? 'someone has something on this evening' : null, tone: humans.length >= 3 ? 'playful' : 'neutral',
          threads, evidence: humans.slice(0, 4) });
      }
      case 'mind.think': {
        const labels = [...u.matchAll(/^(C\d+) \((group|one-to-one)\)/gm)].map(m => ({ label: m[1], group: m[2] === 'group' }));
        const threads = [...u.matchAll(/^(C\d+\.t\d):/gm)].map(m => m[1]);
        const todays = [...u.matchAll(/^(C\d+\.today):/gm)].map(m => m[1]);
        const reach = /You may look for one or two/.test(u);
        if (labels.length) stubStats.thinkLabels++;
        const out = { v: 1, mood: { word: labels.length ? 'playful' : 'calm', intensity: 0.5 }, next_think_in_minutes: 180,
          note: 'A light day; nothing needs doing.' };
        if (todays.length) out.today = [{ ref: todays[0] }];
        if (!nudged && labels.length) { nudged = true; out.nudges = [{ knob: 'replyLength', scope: 'global', value: 'shorter', ttl_hours: 12, reason: 'The chat is quick today.' }]; }
        const g = labels.find(l => l.group && threads.some(t => t.startsWith(`${l.label}.`)));
        if (g) out.intentions = [{ kind: 'follow_up', target: g.label, basis: [threads.find(t => t.startsWith(`${g.label}.`))], ttl_hours: 12 }];
        if (reach && g) {
          stubStats.thinkReach++;
          out.reach_out = [{ target: g.label, kind: 'follow_up', basis: [threads.find(t => t.startsWith(`${g.label}.`))], urgency: 0.7,
            reason: 'They left a plan hanging.' }];
        }
        return J(out);
      }
      case 'mind.episode': return J({ v: 1, episode: 'They traded updates through the day, made a loose plan for later in the week and kept an old joke alive.', tone: 'warm' });
      case 'mind.weekly': return J({ v: 1, episode: 'A steady week of small updates, one loose plan that kept moving, and the usual running jokes.' });
      case 'mind.sleep': return J({ v: 1, morning_mood: { word: 'content', intensity: 0.5 }, next_think_in_minutes: 600, note: 'Quiet day overall.' });
      case 'mind.selfmodel': {
        const base = Number((u.match(/"base_version":\s*(\d+)/) || [])[1] ?? 0);
        return J({ v: 1, skip: false, base_version: base, text: 'Keeps replies short and dry.\nAsks one good question when a friend is stuck.',
          changes_summary: 'tightened the tone lines' });
      }
      case 'mind.draft': return J({ v: 1, skip: false, intent: 'ask how the plan from earlier in the week is shaping up' });
      case 'mind.proactive': return 'so is that plan still on or did everyone flake';
      case 'fun.proactive': return 'so is the plan alive';
      default: return role === 'clerk' ? J({ v: 1 }) : 'ok';
    }
  }

  async function fakeCallRole(role, system, user, opts = {}) {
    const caller = opts?.caller || null;
    const r = resolveRole(role, config);
    if (!r || r.disabled || !r.provider || !r.model) return { text: null, provider: null, model: null, usage: {}, costUsd: null, fellBack: false, status: 'disabled', skipped: 'disabled' };
    if (r.shadowOnly && opts.send === true) return { text: null, provider: null, model: null, usage: {}, costUsd: null, fellBack: false, status: 'shadow_only', skipped: 'shadow_only' };
    const st = usage.budgetState(role);
    if (!st.allowed && !['mouth', 'senses', 'gate'].includes(role)) {
      usage.recordUsage({ role, provider: r.provider, model: r.model, caller, usage: {}, ok: false, status: 'budget', latencyMs: 0 });
      return { text: null, provider: r.provider, model: r.model, usage: {}, costUsd: null, fellBack: false, status: 'budget', skipped: 'budget' };
    }
    const text = respond(role, caller, system, user, opts);
    const sys = sysText(system);
    const effort = opts.effort !== undefined && opts.effort !== '' ? opts.effort : (r.effort || 'low');
    const thinking = THINKING[caller]?.[effort] ?? THINKING[caller]?.low
      ?? (role === 'clerk' ? CLERK_THINKING : role === 'mouth' || role === 'fun' ? MOUTH_THINKING : 0);
    const out = tok(text) + thinking;
    // Anthropic: the static system block is a cache write (calls are hours apart, past the 5-min TTL).
    const u = r.provider === 'anthropic'
      ? { input: tok(user), output: out, cacheRead: 0, cacheWrite: tok(sys) }
      : { input: tok(sys) + tok(user), output: out, cacheRead: 0, cacheWrite: 0 };
    const cost = usage.recordUsage({ role, provider: r.provider, model: r.model, caller, usage: u, ok: true, status: 'ok',
      latencyMs: 1000 + out * 10, fellBack: false });
    return { text, provider: r.provider, model: r.model, usage: u, costUsd: cost.costUsd, fellBack: false, status: 'ok' };
  }

  async function fakeGate(text, snippet, opts = {}) {
    const r = resolveRole('gate', config);
    usage.recordUsage({ role: 'gate', provider: r.provider, model: r.model, caller: opts.caller || 'gate',
      usage: { input: 900 + tok(text) + tok(snippet), output: 60, cacheRead: 0, cacheWrite: 0 }, ok: true, status: 'ok', latencyMs: 800 });
    return { pass: true, score: 0.78, reason: 'fine', latencyMs: 800 };
  }

  let insertedSinceGlance = 0;
  let glanceN = 0;
  const noul = (p) => ({ choice: p >= 0.75 ? 'yes' : p >= 0.5 ? 'likely' : p >= 0.25 ? 'unlikely' : 'no', confidence: Math.max(p, 1 - p),
    probability: p, probabilities: { yes: p, no: 1 - p } });
  async function fakeJev(req = {}) {
    const caller = req.caller || 'jev';
    const r = resolveRole('jev', config);
    usage.recordUsage({ role: 'jev', provider: r?.provider || 'openrouter', model: r?.model || 'jev', caller,
      usage: { input: 0, output: 0 }, providerCost: JEV_COST, ok: true, status: 'ok', latencyMs: 600 });
    const answers = {};
    if (caller === 'mind.glance') glanceN++;
    for (const [k, q] of Object.entries(req.questions || {})) {
      if (q?.type === 'noul') {
        answers[k] = k === 'think_now' ? noul(insertedSinceGlance > 0 ? 0.8 : 0.3)
          : k === 'reach_out' ? noul(glanceN % 4 === 2 ? 0.75 : 0.2)
            : noul(0.03);
      } else if (q?.type === 'choice') {
        const keys = Object.keys(q.criteria || {});
        const c = keys.includes('calm') ? 'calm' : keys[0];
        answers[k] = { choice: c, confidence: 0.7, probabilities: { [c]: 0.7 } };
      } else answers[k] = noul(0.1);
    }
    if (caller === 'mind.glance') insertedSinceGlance = 0;
    return { model: r?.model || 'jev', answers, usage: { cost: JEV_COST }, ms: 600 };
  }

  const life = {
    subs: new Set(),
    onTick(fn) { life.subs.add(fn); return () => life.subs.delete(fn); },
    tick(at) { for (const fn of [...life.subs]) fn(null, { at, catchUp: false, reanchored: false, events: [], crossings: [] }); },
    isLifeOn: () => true,
    isAwakeAt: (u) => !clock.inSleepHours(u),
    getState: () => null,
    lifeGuardNote: () => '',
    availabilityNow: () => 'free',
    inPhoneCheckNow: () => false,
    embargoActive: () => false,
    overSelfMentionBudget: () => false,
    listEvents: () => [],
  };
  const lifeAsync = async () => life;

  const m = {
    cadence: await import('../src/mind/cadence.js'),
    digest: await import('../src/mind/digest.js'),
    think: await import('../src/mind/think.js'),
    sleep: await import('../src/mind/sleep.js'),
    selfModel: await import('../src/mind/selfModel.js'),
    glance: await import('../src/mind/glance.js'),
    pulse: await import('../src/mind/pulse.js'),
    dontText: await import('../src/mind/dontText.js'),
    proactive: await import('../src/mind/proactive.js'),
    selfState: await import('../src/mind/selfState.js'),
    knobs: await import('../src/mind/knobs.js'),
    hooks: await import('../src/mind/hooks.js'),
    levers: await import('../src/mind/levers.js'),
  };
  const models = LIVE ? {} : { callRole: fakeCallRole };
  m.digest.__setDepsForTest({ now: fc, ...models });
  m.think.__setDepsForTest({ now: fc, life: lifeAsync, ...models });
  m.sleep.__setDepsForTest({ now: fc, life: lifeAsync, ...models });
  m.selfModel.__setDepsForTest({ now: fc, life: lifeAsync, ...models, ...(LIVE ? {} : { evaluateResponse: fakeGate }) });
  m.glance.__setDepsForTest({ now: fc, life: lifeAsync, ...(LIVE ? {} : { askJev: fakeJev, jevDisabled: () => false }) });
  m.pulse.__setDepsForTest({ now: fc, life: lifeAsync });
  m.dontText.__setDepsForTest({ now: fc, ...(LIVE ? {} : { askJev: fakeJev }) });
  m.proactive.__setDepsForTest({ now: fc, life: () => life, ...models, ...(LIVE ? {} : { evaluateResponse: fakeGate }),
    sendText: async (sock, jid) => { sends.push(shortId(jid)); return null; },
    withChatLock: async (chatJid, fn) => fn({ turnSignal: { aborted: false } }) });
  m.selfState.__setDepsForTest({ now: fc, life: () => life });
  m.knobs.__setDepsForTest({ now: fc });
  m.hooks.__setDepsForTest({ now: fc });
  m.levers.__setDepsForTest({ now: fc });
  // dryRun:false only lets the cadence run its lazy first-live initialisation on this copy
  // (first_enabled_at + review window); config.dryRun stays true for every send path.
  m.cadence.__setDepsForTest({ now: fc, life: () => life, dryRun: () => false });

  const skills = await import('../src/skills/skillRunner.js');
  await skills.loadSkills();
  skills.setSkillEnabled('mind', true);
  const mind = await import('../src/mind/index.js');

  // ── 5. the day ─────────────────────────────────────────────────────────────
  const t0 = D0 + 7 * 3600;
  const tEnd = D1 + 7 * 3600 + 30 * 60;
  simNow = t0;
  mind.startMind({ getSock: () => null });
  life.tick(simNow);
  await m.cadence.idle();
  let ticks = 1;
  let replayed = 0;
  const { resolveAudience } = await import('../src/memory/recall.js');
  const activeChats = db.prepare(`SELECT DISTINCT group_jid FROM temp.dry_replay WHERE timestamp < ?`).pluck().all(D1);
  const snapAt = D0 + 18 * 3600;
  // A DM of a member of the first active group (audience preview): under the 006 rule that group's
  // `today` may show there (the DM's audience is a subset of the group), its intentions must not.
  const firstGroup = activeChats.find(j => j.endsWith('@g.us'));
  const memberDm = firstGroup ? db.prepare(`SELECT person_jid FROM group_members WHERE group_jid = ? ORDER BY person_jid LIMIT 1`).pluck().get(firstGroup) : null;
  const snapshot = new Map();
  const lineFor = (jid) => {
    const isGroup = jid.endsWith('@g.us');
    const aud = resolveAudience({ chatJid: jid, kind: isGroup ? 'group' : 'dm', personJid: isGroup ? null : jid });
    return { line: mind.selfStateLine(aud, { chatJid: jid, isGroup, track: false }), len: mind.replyLengthLine(jid) };
  };
  for (let t = t0 + TICK_MIN * 60; t <= tEnd; t += TICK_MIN * 60) {
    simNow = t;
    const n = insertUpTo(t);
    replayed += n;
    insertedSinceGlance += n;
    life.tick(t);
    await m.cadence.idle();
    ticks++;
    if (t >= snapAt && !snapshot.size) for (const jid of [...activeChats, ...(memberDm ? [memberDm] : [])]) snapshot.set(jid, lineFor(jid));
  }
  mind.stopMind();

  // ── 6. report ──────────────────────────────────────────────────────────────
  console.log(`\nMind dry run — ${LIVE ? 'LIVE models' : 'stubbed models'}, DRY_RUN=true, proactive ${mind.getStatus?.()?.proactiveMode ?? 'shadow'}`);
  console.log(`source copied read-only → ${path.relative(ROOT, COPY)}; timezone ${tz}; sleep ${config.sleepStartHour}:00–${config.sleepEndHour}:00`);

  console.log('\nMigration rehearsal');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok || r.detail === undefined ? '' : ` — ${JSON.stringify(r.detail)}`}`);
  if (results.some(r => !r.ok)) exitCode = 1;

  console.log(`\nReplay of ${DAY}: ${replayShape.n} messages (${replayShape.self || 0} bot, ${replayShape.reactions || 0} reactions) in ${replayShape.chats} chat(s); `
    + `${held - replayShape.n} later message(s) held out; ${replayed} re-inserted over ${ticks} ticks of ${TICK_MIN} min `
    + `(${new Date(t0 * 1000).toISOString()} → ${new Date(tEnd * 1000).toISOString()})`);

  console.log('\nRuns (mind_runs)');
  const runs = db.prepare(`SELECT kind, status, COALESCE(skip_reason, '') AS reason, COUNT(*) AS n FROM mind_runs
    GROUP BY kind, status, reason ORDER BY kind, status, reason`).all();
  for (const r of runs) console.log(`  ${r.kind.padEnd(9)} ${r.status.padEnd(8)} ${r.reason.padEnd(16)} ${r.n}`);
  const nights = db.prepare(`SELECT night_key AS nk, status FROM mind_nights ORDER BY night_key`).all();
  console.log(`  nights: ${nights.map(n => `${n.nk}=${n.status}`).join(', ') || 'none'}`);

  console.log('\nModel calls (llm_usage rows written by this run)');
  const calls = db.prepare(`SELECT role, COALESCE(caller, '-') AS caller, provider, model, COUNT(*) AS n,
      SUM(ok = 1) AS ok, ROUND(AVG(input_tokens)) AS inTok, ROUND(AVG(cache_write_tokens)) AS cwTok, ROUND(AVG(output_tokens)) AS outTok,
      SUM(COALESCE(cost_usd, 0)) AS cost, SUM(cost_usd IS NULL AND ok = 1) AS unpriced
    FROM llm_usage WHERE id > ? GROUP BY role, caller ORDER BY role, caller`).all(ledgerStart);
  for (const c of calls) {
    console.log(`  ${c.role.padEnd(5)} ${c.caller.padEnd(20)} n=${String(c.n).padStart(3)} ok=${String(c.ok).padStart(3)}  in≈${c.inTok ?? 0}`
      + `${c.cwTok ? ` (+${c.cwTok} cache-write)` : ''} out≈${c.outTok ?? 0}  ${usd(c.cost)}${c.unpriced ? `  (${c.unpriced} unpriced)` : ''}  ${c.provider}/${c.model}`);
  }
  const byRole = {};
  for (const c of calls) byRole[c.role] = (byRole[c.role] || 0) + c.cost;
  const dayTotal = Object.values(byRole).reduce((a, b) => a + b, 0);
  console.log(`  day total ${usd(dayTotal)} (${Object.entries(byRole).map(([r, v]) => `${r} ${usd(v)}`).join(', ')})`);

  console.log('\nSelf-state');
  const elements = db.prepare(`SELECT kind, COUNT(*) AS n FROM mind_self_state GROUP BY kind ORDER BY kind`).all();
  console.log(`  elements: ${elements.map(e => `${e.kind}×${e.n}`).join(', ') || 'none'}`);
  const show = (x) => `${x.line ? `"${x.line}"` : '(no line)'}${x.len ? ` + "${x.len}"` : ''}`;
  for (const jid of activeChats) {
    const at18 = snapshot.get(jid);
    console.log(`  ${shortId(jid)}: at 18:00 ${at18 ? show(at18) : '(not reached)'}; at the end ${show(lineFor(jid))}`);
  }
  if (memberDm && !activeChats.includes(memberDm)) {
    const at18 = snapshot.get(memberDm);
    console.log(`  a member's DM (${shortId(memberDm)}, not active that day): at 18:00 ${at18 ? show(at18) : '(not reached)'}; at the end ${show(lineFor(memberDm))}`);
  }

  console.log('\nDigests and episodes');
  const dg = db.prepare(`SELECT chat_jid AS c, COUNT(*) AS n FROM mind_digests GROUP BY chat_jid`).all();
  console.log(`  digests: ${dg.map(d => `${shortId(d.c)}×${d.n}`).join(', ') || 'none'}`);
  const ep = db.prepare(`SELECT origin_jid AS c, attribute, LENGTH(content) AS len FROM memories WHERE source IN ('mind.sleep', 'mind.weekly') ORDER BY id`).all();
  console.log(`  episodes: ${ep.map(e => `${shortId(e.c)} ${e.attribute} (${e.len} chars)`).join(', ') || 'none'}`);
  const elog = db.prepare(`SELECT outcome, COUNT(*) AS n FROM mind_episode_log GROUP BY outcome`).all();
  if (elog.length) console.log(`  episode log: ${elog.map(e => `${e.outcome}×${e.n}`).join(', ')}`);

  console.log('\nProactive drafts');
  const drafts = db.prepare(`SELECT chat_kind AS k, status, COALESCE(drop_reason, '') AS reason, COUNT(*) AS n FROM mind_proactive
    GROUP BY k, status, reason`).all();
  for (const d of drafts) console.log(`  ${d.k.padEnd(5)} ${d.status.padEnd(9)} ${d.reason.padEnd(18)} ${d.n}`);
  if (!drafts.length) console.log('  none');
  const sentRows = db.prepare(`SELECT COUNT(*) FROM mind_proactive WHERE status = 'sent'`).pluck().get();
  console.log(`  sendText calls: ${sends.length}; sent rows: ${sentRows}`);
  const selfModels = db.prepare(`SELECT status, COUNT(*) AS n FROM mind_self_model GROUP BY status`).all();
  console.log(`  self-model versions: ${selfModels.map(s => `${s.status}×${s.n}`).join(', ') || 'none'}`);
  const nudges = db.prepare(`SELECT knob, status, COUNT(*) AS n FROM mind_nudges GROUP BY knob, status`).all();
  console.log(`  nudges: ${nudges.map(n => `${n.knob}:${n.status}×${n.n}`).join(', ') || 'none'}`);
  if (!LIVE) console.log(`  stub: ${stubStats.thinkLabels} think input(s) with chat labels, ${stubStats.thinkReach} with a reach-out window, ${stubStats.digestNoHumans} digest input(s) without human lines`);

  // ── projection ──
  console.log('\nMonthly projection (30 days)');
  const mindBudget = Number(config.roles?.mind?.budgetUsd) || 0;
  const globalCap = Number(config.llm?.monthlyBudgetUsd) || 0;
  const avg = (callerList) => {
    const rows = calls.filter(c => callerList.includes(c.caller) && c.ok);
    const n = rows.reduce((a, c) => a + c.ok, 0);
    return n ? rows.reduce((a, c) => a + c.cost, 0) / n : null;
  };
  const R23 = { 'mind.think': 0.082, 'mind.sleep': 0.086, 'mind.selfmodel': 0.038, 'mind.draft': 0.016 };
  const per = (c) => avg([c]) ?? R23[c] ?? 0;
  const mindDay = byRole.mind || 0;
  const otherDay = dayTotal - mindDay;
  console.log(`  this day ×30: mind role ${usd2(mindDay * 30)} of ${usd2(mindBudget)} (${mindBudget ? Math.round(mindDay * 30 / mindBudget * 100) : '-'}%); `
    + `mind-caused other roles (clerk/mouth/gate/jev) ${usd2(otherDay * 30)}`);
  const pc = config.mind.proactive || {};
  const thinksCap = config.mind.thinkMaxPerDay;
  const draftsCap = pc.draftsPerDay ?? 8;
  const ceilingMind = 30 * (thinksCap * per('mind.think') + per('mind.sleep') + draftsCap * per('mind.draft'))
    + Math.ceil(30 / (config.mind.selfModelEveryNights || 3)) * per('mind.selfmodel');
  const clerkAvg = avg(['mind.digest', 'mind.episode', 'mind.weekly']) ?? 0.004;
  const ceilingOther = 30 * (config.mind.clerkMaxPerDay * clerkAvg + draftsCap * ((avg(['mind.proactive']) ?? 0.006) + (avg(['mind.gate']) ?? 0.001))
    + (config.mind.glanceMaxPerDay + 10) * JEV_COST);
  console.log(`  every cap hit (${thinksCap} thinks, 1 sleep, ${draftsCap} drafts/day, self-model every ${config.mind.selfModelEveryNights} nights, `
    + `${config.mind.clerkMaxPerDay} clerk calls/day): mind ${usd2(ceilingMind)} → stopped by the 80% think/draft gate at `
    + `${usd2(mindBudget * 0.8)} (sleep reserve ${usd2(mindBudget * (config.mind.sleepReservePct / 100))}); other roles ≤ ${usd2(ceilingOther)}`);
  const monthStart = usage.monthStartTs(Date.now());
  const existing = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage WHERE id <= ? AND ts >= ?`).pluck().get(ledgerStart, monthStart);
  const ledgerSince = db.prepare(`SELECT MIN(ts) FROM llm_usage WHERE id <= ?`).pluck().get(ledgerStart);
  const projected = existing + (mindDay + otherDay) * 30;
  console.log(`  global cap ${usd2(globalCap)}: existing month-to-date ${usd2(existing)} (ledger since ${ledgerSince ? new Date(ledgerSince * 1000).toISOString().slice(0, 10) : 'never'})`
    + ` + mind-caused ${usd2((mindDay + otherDay) * 30)} = ${usd2(projected)} (${globalCap ? Math.round(projected / globalCap * 100) : '-'}% of the cap; think/draft stop at 70% = ${usd2(globalCap * 0.7)})`);
  console.log(`  assumptions: ~3.5 chars/token; thinking per R23 (think/sleep medium ${THINKING['mind.think'].medium}, self-model low ${THINKING['mind.selfmodel'].low}, `
    + `draft low ${THINKING['mind.draft'].low}, clerk ${CLERK_THINKING}, mouth ${MOUTH_THINKING}); Anthropic system = cache write; Jev ${usd(JEV_COST)}/call; `
    + 'gate ≈ 900 + text tokens in, 60 out');

  console.log(`\nNetwork attempts: ${netAttempts.length}${netAttempts.length ? ` (${[...new Set(netAttempts)].join(', ')})` : ''}`);
  if (sends.length || sentRows || netAttempts.length) exitCode = 1;
} catch (err) {
  console.error(`mind dry run failed: ${err?.stack || err}`);
  exitCode = 1;
} finally {
  try { closeDb?.(); } catch { /* */ }
  if (!KEEP) {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* */ }
  } else {
    console.log(`kept ${path.relative(ROOT, SCRATCH)}/ (delete it when done)`);
  }
}
process.exit(exitCode);
