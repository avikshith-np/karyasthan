#!/usr/bin/env node
// Public site (spec 013) rehearsal: the REAL exporter run once against a COPY of a real
// database and this install's real world, proving nothing private reaches public.json.
// Nothing is uploaded, nothing is sent, nothing leaves the machine.
//
//   node scripts/public-dry-run.js --source <path/to/karyasthan.db> [--world <world.json>]
//        [--persona <persona.json>] [--arcs <arcs.json>] [--keep] [--verbose]
//
// What it does:
//   1. Copies the database with VACUUM INTO over a READ-ONLY connection into
//      data/rehearsal/public-dry/copy.db (the directory must be absent or empty; chmod 600;
//      removed at the end unless --keep). It refuses a target that looks like the live
//      database (a file named karyasthan.db, the default DB path, a -wal/-shm sibling, or
//      anything outside data/), and a source inside data/rehearsal/.
//   2. Migration rehearsal on the copy: exactly the pending steps applied (v13 public-site),
//      a 0600 backup in a 0700 dir, only public_* (and other new-spec) tables added, every
//      existing table's row count unchanged, a second run a no-op.
//   3. Boots life on the copy with the install's real world (--world, default
//      ../karyasthan/src/personality/world.json next to this worktree, else this tree's
//      world.json; read only, passed as `world`; the example world is refused), the life,
//      arcs and chat-influence skills on (mind off), timers off, the clock fixed at now.
//      The arc seed is the install's arcs.json (read only, validated, injected — never
//      generated). Jev / callRole are stubs that answer nothing; fetch, sockets and DNS
//      throw and every attempt is counted; the socket is a fake (sends counted).
//   4. Runs the exporter: exportNow({ upload: false }) → preview(), with dryRun on, the
//      R2 put / votes pull stubbed to throw (counted), the persona from --persona (default
//      the install's persona.json, read only).
//   5. Canary over the exported document (walked leaf by leaf, so a hit has a JSON path):
//        names     every people.push_name / real_name (minus the bot's own rows): the full
//                  name and its first word (≥ 3 letters), case- and accent-insensitive,
//                  word-bounded (normalized as scrub.js normalizeName: NFKD, marks and
//                  format characters dropped, lowercase, non-alphanumerics → one space)
//        ids       every JID local part and phone digit run (≥ 7 digits; phones also as
//                  their last 10 digits) from people / person_identities / groups /
//                  messages, matched inside any digit run of a leaf after dropping
//                  spaces, dots, dashes, parentheses and '+'
//        groups    every group subject (≥ 3 letters), normalized as above, word-bounded
//        messages  the 500 most recent non-empty messages: any 6-word window (normalized
//                  as above) that also appears as a 6-word window of a leaf
//        suffixes  no '@lid' / '@g.us' / '@s.whatsapp.net' / '@c.us' in the JSON text
//        home      no place name equal to the home place's name (now.where, now.travel,
//                  city.places), and the home name not inside any leaf unless it is a
//                  generic word (home, flat, house…)
//        grid      every lat / lon is a 0.01° cell centre
//        schema    validate(doc, scrubber) passes (closed keys + per-string scrub)
//   6. Prints a codes-only report: counts, sizes, which checks passed. A hit prints only
//      the check name, the JSON path and a non-revealing hint (source field, length,
//      a cast / persona coincidence) — never the private value.
// Exit 1 on any hit, a failed check, a network attempt, a send or a thrown run; 2 on a
// refused or bad invocation.

import fs from 'fs';
import path from 'path';
import net from 'net';
import tls from 'tls';
import dns from 'dns';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SCRATCH = path.join(DATA, 'rehearsal', 'public-dry');
const INSTALL = path.resolve(ROOT, '..', 'karyasthan');   // the live checkout next to this worktree

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const KEEP = flag('keep');
const VERBOSE = flag('verbose');
const SOURCE = opt('source');
const die = (msg, code = 2) => { console.error(`public-dry-run: ${msg}`); process.exit(code); };
if (flag('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
if (!SOURCE) die('pass --source <db> (a read-only VACUUM INTO copy is made)');
const firstExisting = (...ps) => ps.find((p) => p && fs.existsSync(p)) ?? null;
const WORLD_PATH = opt('world') ? path.resolve(opt('world'))
  : firstExisting(path.join(INSTALL, 'src', 'personality', 'world.json'), path.join(ROOT, 'src', 'personality', 'world.json'));
const PERSONA_PATH = opt('persona') ? path.resolve(opt('persona'))
  : firstExisting(path.join(INSTALL, 'src', 'personality', 'persona.json'), path.join(ROOT, 'src', 'personality', 'persona.json'));
const ARCS_PATH = opt('arcs') ? path.resolve(opt('arcs'))
  : firstExisting(path.join(INSTALL, 'src', 'personality', 'arcs.json'), path.join(ROOT, 'src', 'personality', 'arcs.json'));
if (!WORLD_PATH) die('no world.json found (pass --world <path>)');

// ── the database: never the live one ─────────────────────────────────────────
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const realTarget = (p) => path.join(real(path.dirname(path.resolve(p))), path.basename(p));
const LIVE_DEFAULTS = [realTarget(path.join(ROOT, 'data', 'karyasthan.db')), realTarget(path.join(INSTALL, 'data', 'karyasthan.db'))];
function refuseLive(target, what) {
  const t = realTarget(target);
  if (path.basename(t) === 'karyasthan.db' || LIVE_DEFAULTS.includes(t)) die(`${what} looks like the live database — refusing`);
  if (!t.startsWith(real(DATA) + path.sep)) die(`${what} must be under ${path.relative(ROOT, DATA)}/`);
  for (const s of ['-wal', '-shm']) if (fs.existsSync(t + s)) die(`${what} has a ${s} file (a database in use) — refusing`);
  if (real(SOURCE) === t) die(`${what} is the source — refusing`);
  return t;
}
const src = real(SOURCE);
if (!fs.existsSync(src)) die('source not found');
if (src.startsWith(real(path.join(DATA, 'rehearsal')) + path.sep)) die('the source must not be inside data/rehearsal/');
if (fs.existsSync(SCRATCH) && fs.readdirSync(SCRATCH).length) die(`${path.relative(ROOT, SCRATCH)}/ exists and is not empty — delete it first`);
const COPY = refuseLive(path.join(SCRATCH, 'copy.db'), 'the copy target');
const OUT_DIR = path.join(SCRATCH, 'out');

// ── env (before anything imports src/utils/config.js) ────────────────────────
let worldTz = null;
try { worldTz = JSON.parse(fs.readFileSync(WORLD_PATH, 'utf-8'))?.timezone ?? null; } catch { die('world.json is not readable JSON'); }
process.env.DB_PATH = `./${path.relative(ROOT, COPY).split(path.sep).join('/')}`;
process.env.DRY_RUN = 'true';
process.env.LIFE_ENABLED = 'true';
process.env.ARCS_ENABLED = 'true';
process.env.CHAT_INFLUENCE_ENABLED = 'true';
process.env.MIND_ENABLED = 'false';
process.env.PUBLIC_SITE_ENABLED = 'false';   // the timer is never started; exportNow is called directly
process.env.DASHBOARD_ENABLED = 'false';
process.env.IG_ENABLED = 'false';
process.env.OWNER_JIDS = '';
if (worldTz && !process.env.TIMEZONE) process.env.TIMEZONE = worldTz;
process.env.LOG_LEVEL = VERBOSE ? 'info' : (process.env.PUBLIC_DRY_RUN_LOG_LEVEL || 'error');
for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GLM_API_KEY', 'LLM_API_KEY', 'LLM_LOCAL_API_KEY',
  'JEV_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
  'R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'PUBLIC_VOTES_URL', 'PUBLIC_VOTES_READ_TOKEN', 'PUBLIC_JSON_URL']) process.env[k] = '';
process.env.SEARXNG_URL = 'http://127.0.0.1:9';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9';

// ── network off: every attempt throws and is counted ─────────────────────────
const netAttempts = [];
{
  const refuse = (what) => () => { netAttempts.push(what); throw new Error(`network is off in the public dry run (${what})`); };
  globalThis.fetch = async () => { netAttempts.push('fetch'); throw new Error('network is off in the public dry run'); };
  net.Socket.prototype.connect = refuse('net.connect');
  net.connect = refuse('net.connect');
  net.createConnection = refuse('net.createConnection');
  tls.connect = refuse('tls.connect');
  dns.lookup = refuse('dns.lookup');
  dns.resolve = refuse('dns.resolve');
  if (dns.promises) { dns.promises.lookup = refuse('dns.promises.lookup'); dns.promises.resolve = refuse('dns.promises.resolve'); }
}

const { default: Database } = await import('better-sqlite3');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); return !!ok; };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };
function tableCounts(db) {
  const out = {};
  for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all()) {
    out[t] = db.prepare(`SELECT COUNT(*) FROM "${t.replace(/"/g, '""')}"`).pluck().get();
  }
  return out;
}
const schemaOf = (db) => db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();
const columns = (db, t) => { try { return db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name); } catch { return []; } };
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

// ── normalization (scrub.js normalizeName) ───────────────────────────────────
const norm = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const letters = (s) => (String(s).match(/\p{L}/gu) || []).length;
const tokens = (s) => { const n = norm(s); return n ? n.split(' ') : []; };
const GENERIC_HOME = new Set(['home', 'flat', 'house', 'apartment', 'room', 'pg', 'hostel', 'my place', 'my flat', 'the flat', 'my home']);

let exitCode = 0;
let closeDb = null;
let lifeMod = null;
const lines = [];
const out = (s = '') => lines.push(s);

try {
  // ── 1. the copy ────────────────────────────────────────────────────────────
  fs.mkdirSync(SCRATCH, { recursive: true, mode: 0o700 });
  fs.chmodSync(SCRATCH, 0o700);
  {
    const s = new Database(src, { readonly: true, fileMustExist: true });
    try { s.prepare('VACUUM INTO ?').run(COPY); } finally { s.close(); }
  }
  fs.chmodSync(COPY, 0o600);
  check('copy made with VACUUM INTO over a read-only connection, mode 0600',
    fs.existsSync(COPY) && (fs.statSync(COPY).mode & 0o777) === 0o600);
  const copyBytes = fs.statSync(COPY).size;
  const pre = new Database(COPY, { readonly: true });
  const preVersion = pre.pragma('user_version', { simple: true });
  const preCounts = tableCounts(pre);
  pre.close();

  // ── 2. migration rehearsal ─────────────────────────────────────────────────
  const { config } = await import('../src/utils/config.js');
  if (path.resolve(config.projectRoot, config.dbPath) !== COPY) throw new Error('config.dbPath is not the copy');
  const dbMod = await import('../src/memory/db.js');
  closeDb = dbMod.closeDb;
  const { MIGRATIONS } = await import('../src/memory/migrations/index.js');
  const latest = dbMod.LATEST_SCHEMA_VERSION;
  const pending = MIGRATIONS.filter((m) => m.version > preVersion);
  const backupsDir = path.join(path.dirname(COPY), 'backups');
  const backupsBefore = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
  const r1 = dbMod.runMigrations();
  const db = dbMod.getDb();
  const PUBLIC_TABLES = ['public_people', 'public_journal', 'public_state', 'public_votes'];
  if (pending.length) {
    const expected = pending.map((m) => `v${m.version}-${m.name}`);
    check(`migration v${preVersion} → v${latest}: applied exactly ${expected.join(', ')}`, r1.from === preVersion && r1.to === latest
      && JSON.stringify(r1.applied) === JSON.stringify(expected), { from: r1.from, to: r1.to, applied: r1.applied });
    if (preVersion < 13) check('v13 is among the applied steps', pending.some((m) => m.version === 13));
    const backups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
    const backupPath = r1.backup || (backups[0] ? path.join(backupsDir, backups[0]) : null);
    check('a backup was written before the step', !!backupPath && fs.existsSync(backupPath) && backups.length === backupsBefore + 1, backups.length);
    if (backupPath && fs.existsSync(backupPath)) {
      const mode = fs.statSync(backupPath).mode & 0o777;
      const dmode = fs.statSync(path.dirname(backupPath)).mode & 0o777;
      check(`backup file 0600 in a 0700 dir (${mode.toString(8)} / ${dmode.toString(8)})`, mode === 0o600 && dmode === 0o700);
    }
    const post = tableCounts(db);
    const changed = Object.keys(preCounts).filter((t) => post[t] !== preCounts[t]);
    check(`row counts unchanged in all ${Object.keys(preCounts).length} existing tables`, changed.length === 0, changed);
    const added = Object.keys(post).filter((t) => !(t in preCounts));
    const PREFIX = { 10: 'mind_', 11: 'story_', 12: 'chat_influence_', 13: 'public_', 14: 'story_scenes', 15: 'story_messages', 16: 'story_thoughts', 17: 'self_stance', 18: 'story_dreams', 19: 'story_standing', 20: 'story_check_', 21: 'review_' };
    const prefixes = pending.map((m) => PREFIX[m.version]).filter(Boolean);
    check(`only the steps' own tables were added (${added.length}: ${prefixes.join('|')}*)`, added.length > 0
      && added.every((t) => prefixes.some((px) => t.startsWith(px))), added);
    check(preVersion < 13 ? 'the four v13 public_* tables exist and are empty' : 'the four v13 public_* tables exist', PUBLIC_TABLES.every((t) => preVersion < 13 ? post[t] === 0 : t in post));
    check('no existing table was dropped', Object.keys(preCounts).every((t) => t in post));
  } else {
    check(`the copy is already at v${latest} (no migration to rehearse)`, preVersion === latest && r1.applied.length === 0);
  }
  const schemaBefore = JSON.stringify(schemaOf(db));
  const r2 = dbMod.runMigrations();
  check('a second runMigrations is a no-op (nothing applied, schema identical)', r2.applied.length === 0 && r2.from === latest
    && JSON.stringify(schemaOf(db)) === schemaBefore);
  try { dbMod.assertSchemaCurrent(); check('assertSchemaCurrent() passes', true); } catch (err) { check('assertSchemaCurrent() passes', false, err?.name); }

  // ── 3. world, seed, skills, clock, fakes; boot life ────────────────────────
  const { setClock } = await import('../src/life/clock.js');
  const { loadWorld, EXAMPLE_PATH, realPeopleNames } = await import('../src/life/world.js');
  const decisions = await import('../src/life/decisions.js');
  const claims = await import('../src/life/claims.js');
  const seedMod = await import('../src/life/story/seed.js');
  const skills = await import('../src/skills/skillRunner.js');

  const worldHashBefore = sha(WORLD_PATH);
  const personaHashBefore = PERSONA_PATH ? sha(PERSONA_PATH) : null;
  const arcsHashBefore = ARCS_PATH ? sha(ARCS_PATH) : null;
  const world = loadWorld({ path: WORLD_PATH, examplePath: EXAMPLE_PATH, force: true });
  if (world.source === 'example') throw Object.assign(new Error('the install world.json did not validate (fell back to the example) — refusing'), { name: 'WorldRefused' });
  check(`the install's world.json validates (${world.places.length} places, ${world.cast.length} cast)`, world.source !== 'example');
  const genesis = db.prepare(`SELECT payload_json FROM world_events WHERE type = 'genesis' ORDER BY id LIMIT 1`).pluck().get();
  const genesisHash = genesis ? JSON.parse(genesis).worldHash ?? null : null;
  const worldNote = !genesis ? 'no genesis on the copy (fresh genesis)' : genesisHash === world.hash ? 'matches the copy\'s genesis' : 'differs from the copy\'s genesis';
  const droppedSnapshots = genesis && genesisHash !== world.hash ? db.prepare('DELETE FROM world_snapshots').run().changes : 0;

  let seedSource = 'example';
  let seedRaw;
  try { seedRaw = JSON.parse(fs.readFileSync(ARCS_PATH ?? seedMod.EXAMPLE_ARCS_PATH, 'utf-8')); seedSource = ARCS_PATH ? 'install' : 'example'; }
  catch { seedRaw = JSON.parse(fs.readFileSync(seedMod.EXAMPLE_ARCS_PATH, 'utf-8')); seedSource = 'example'; }
  let seedCheck = seedMod.validateArcSeed(seedRaw, { knownNames: seedSource === 'install' ? realPeopleNames() : [], world });
  if (!seedCheck.ok && seedSource === 'install') {
    seedSource = 'example (install seed invalid)';
    seedCheck = seedMod.validateArcSeed(JSON.parse(fs.readFileSync(seedMod.EXAMPLE_ARCS_PATH, 'utf-8')), { knownNames: [], world });
  }
  if (!seedCheck.ok) throw new Error('arc seed invalid');
  seedMod.__setSeedForTest(seedCheck.seed);   // never generated, arcs.json never written

  let persona = null;
  try { persona = PERSONA_PATH ? JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf-8')) : null; } catch { persona = null; }
  const { getPersona } = await import('../src/utils/config.js');
  const personaSource = persona ? 'install persona.json' : 'config fallback';
  if (!persona) persona = getPersona() || {};

  await skills.loadSkills();
  for (const [name, on] of Object.entries({ life: true, arcs: true, 'chat-influence': true, mind: false, 'public-site': false })) {
    try { skills.setSkillEnabled(name, on); } catch { /* not loaded */ }
  }

  const realNow = Math.floor(Date.now() / 1000);
  const lastAt = db.prepare(`SELECT MAX(at) FROM world_events`).pluck().get() || 0;
  const NOW = Math.max(realNow, lastAt + 1);
  setClock(() => NOW);

  const modelCalls = new Map();
  const count = (k) => modelCalls.set(k, (modelCalls.get(k) || 0) + 1);
  const fakeJev = async (req = {}) => { count(`jev:${req?.caller ?? '?'}`); return { model: 'dry-jev', answers: {}, usage: {}, ms: 0 }; };
  const fakeCallRole = async (role, _s, _u, o = {}) => {
    count(`${role}:${o?.caller ?? '?'}`);
    return { text: null, provider: 'dry', model: 'dry', usage: {}, costUsd: 0, fellBack: false, status: 'disabled', skipped: 'disabled' };
  };
  decisions.setJev(fakeJev);
  claims.setJev(fakeJev);
  const story = await import('../src/life/story/index.js');
  story.__setDepsForTest({ now: () => NOW, callRole: fakeCallRole, askJev: fakeJev, mindBudgetOk: async () => ({ ok: false, reason: 'dry_run' }) });
  try {
    const infl = await import('../src/life/influence/index.js');
    if (typeof infl.__setDepsForTest === 'function') infl.__setDepsForTest({ now: () => NOW, callRole: fakeCallRole, askJev: fakeJev });
  } catch { /* no seam */ }

  const sends = [];
  const turns = [];
  const fakeSock = {
    user: { id: '10000000000@s.whatsapp.net' },
    sendMessage: async () => { sends.push(1); return null; },
    sendPresenceUpdate: async () => { sends.push('presence'); return null; },
    readMessages: async () => { sends.push('read'); return null; },
    presenceSubscribe: async () => null,
  };
  const life = await import('../src/life/index.js');
  lifeMod = life;
  await life.startLife({
    world, timers: false, isEnabled: () => true, getSock: () => fakeSock,
    processMessage: async () => { turns.push(1); return null; },
    withChatLock: async (_c, fn) => fn({ turnSignal: { aborted: false } }),
    isGroupMuted: () => false, isMember: () => true, sleep: async () => {},
  });
  const state = life.getState();
  check('life started on the copy with the install world', !!state && state.genesisAt != null);

  // ── 4. the exporter ────────────────────────────────────────────────────────
  const pub = await import('../src/public/index.js');
  const store = await import('../src/public/store.js');
  const { makeScrubber } = await import('../src/public/scrub.js');
  const { validate } = await import('../src/public/schema.js');
  const { snap } = await import('../src/public/build.js');
  const exporterCalls = { put: 0, pull: 0 };
  pub.__setDepsForTest({
    enabled: () => true, dryRun: () => true, soonMs: null, now: () => NOW, outDir: () => OUT_DIR,
    persona: () => persona,
    put: async () => { exporterCalls.put++; throw new Error('upload is off in the public dry run'); },
    pull: async () => { exporterCalls.pull++; throw new Error('votes pull is off in the public dry run'); },
  });
  const res = await pub.exportNow({ upload: false });
  const doc = await pub.preview();
  check(`exportNow({ upload: false }) → ok (got ${res?.status})`, res?.status === 'ok' && !!doc,
    res?.errors ? res.errors.slice(0, 10) : undefined);
  if (!doc) throw Object.assign(new Error(`export status ${res?.status}`), { name: 'ExportFailed' });
  const json = JSON.stringify(doc);
  const bytes = Buffer.byteLength(json, 'utf8');

  // ── 5. the canary ──────────────────────────────────────────────────────────
  // 5a. the private corpus, from the copy.
  // The bot's own identities (its people rows are not "real people" for this check).
  const selfJids = new Set(db.prepare(`SELECT DISTINCT sender_jid FROM messages WHERE is_from_self = 1 AND sender_jid IS NOT NULL`).pluck().all());
  const pCols = columns(db, 'people');
  const peopleRows = db.prepare(`SELECT jid${pCols.includes('phone') ? ', phone' : ', NULL AS phone'}, push_name, real_name FROM people`).all();
  const piCols = columns(db, 'person_identities');
  const idRows = piCols.length ? db.prepare(`SELECT jid, person_jid FROM person_identities`).all() : [];
  for (const r of idRows) if (selfJids.has(r.jid) || selfJids.has(r.person_jid)) { selfJids.add(r.jid); selfJids.add(r.person_jid); }
  const persons = peopleRows.filter((r) => !selfJids.has(r.jid));

  // Allow-listed names a real name may coincide with (a hint only; still a hit).
  const castNames = (world.cast || []).map((c) => c.name).filter(Boolean);
  const personaNames = [persona?.name, persona?.displayName, ...(Array.isArray(persona?.aliases) ? persona.aliases : [])].filter(Boolean);
  const castFull = new Set(castNames.map(norm));
  const castFirst = new Set(castNames.map((n) => tokens(n)[0]).filter(Boolean));
  const personaSet = new Set(personaNames.flatMap((n) => [norm(n), tokens(n)[0]]).filter(Boolean));
  const coincide = (phrase) => (castFull.has(phrase) ? 'cast-full' : castFirst.has(phrase) ? 'cast-first' : personaSet.has(phrase) ? 'persona' : null);

  // names: normalized phrase → { field, kind, len }
  const nameMap = new Map();
  for (const r of persons) {
    for (const field of ['push_name', 'real_name']) {
      const t = tokens(r[field]);
      if (!t.length) continue;
      const full = t.join(' ');
      if (letters(full) >= 3 && !nameMap.has(full)) nameMap.set(full, { field, kind: t.length > 1 ? 'full' : 'single', len: letters(full) });
      if (t.length > 1 && letters(t[0]) >= 3 && !nameMap.has(t[0])) nameMap.set(t[0], { field, kind: 'first', len: letters(t[0]) });
    }
  }
  const maxNameWords = Math.max(1, ...[...nameMap.keys()].map((k) => k.split(' ').length));
  const capForm = (orig, phrase) => {
    try {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${phrase.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'iu');
      const m = String(orig).normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '').match(re);
      return m ? (/\p{Lu}/u.test(m[0][0]) ? 'capitalized' : 'lowercase') : 'folded';
    } catch { return '?'; }
  };

  // ids: JID local parts + phone digit runs → source label
  const runs = new Map();
  const addRun = (s, srcName) => {
    for (const r of String(s ?? '').split('@')[0].split(':')[0].match(/\d+/g) || []) {
      if (r.length >= 7 && !runs.has(r)) runs.set(r, srcName);
    }
  };
  const addPhone = (s, srcName) => {
    const d = String(s ?? '').replace(/\D/g, '');
    if (d.length >= 7 && !runs.has(d)) runs.set(d, srcName);
    if (d.length > 10 && !runs.has(d.slice(-10))) runs.set(d.slice(-10), `${srcName}/last10`);
  };
  const pnOf = (j) => (String(j).endsWith('@s.whatsapp.net') ? String(j).split('@')[0].split(':')[0] : null);
  for (const r of peopleRows) { addRun(r.jid, 'people.jid'); addPhone(r.phone, 'people.phone'); if (pnOf(r.jid)) addPhone(pnOf(r.jid), 'people.jid/pn'); }
  for (const r of idRows) {
    addRun(r.jid, 'person_identities.jid'); addRun(r.person_jid, 'person_identities.person_jid');
    if (pnOf(r.jid)) addPhone(pnOf(r.jid), 'person_identities.jid/pn');
  }
  const gRows = db.prepare(`SELECT jid, name FROM groups`).all();
  for (const r of gRows) addRun(r.jid, 'groups.jid');
  for (const j of db.prepare(`SELECT DISTINCT group_jid FROM messages UNION SELECT DISTINCT sender_jid FROM messages`).pluck().all()) {
    addRun(j, 'messages.jid');
    if (pnOf(j)) addPhone(pnOf(j), 'messages.jid/pn');
  }
  const runList = [...runs.entries()];

  // group subjects: normalized phrase → letters
  const groupPhrases = new Map();
  for (const r of gRows) { const n = norm(r.name); if (n && letters(n) >= 3 && !groupPhrases.has(n)) groupPhrases.set(n, letters(n)); }
  const maxGroupWords = Math.max(1, ...[...groupPhrases.keys()].map((k) => k.split(' ').length));

  // message 6-grams (the 500 most recent non-empty messages)
  const msgTexts = db.prepare(`SELECT content FROM messages WHERE content IS NOT NULL AND TRIM(content) != '' ORDER BY timestamp DESC, rowid DESC LIMIT 500`).pluck().all();
  const msgGrams = new Set();
  for (const m of msgTexts) { const t = tokens(m); for (let i = 0; i + 6 <= t.length; i++) msgGrams.add(t.slice(i, i + 6).join(' ')); }

  // home
  const homeId = state.self?.homePlaceId ?? null;
  const homePlace = (state.places instanceof Map ? state.places.get(homeId) : null) ?? (world.places || []).find((p) => p.id === homeId || p.home) ?? null;
  const homeName = homePlace?.name ? norm(homePlace.name) : null;

  // schema: the exporter's own scrubber inputs, built again here
  const scrubber = makeScrubber({
    knownNames: store.knownPeopleNames(), groupNames: store.groupSubjects(),
    allowNames: [...personaNames, ...castNames, ...store.optedIn().map((x) => x.displayName)].filter((s) => typeof s === 'string'),
  });

  // 5b. scan(doc) → { hits: [{ check, path, hint }], stats } — values are never kept.
  const SUFFIX = /@lid\b|@g\.us\b|@s\.whatsapp\.net\b|@c\.us\b/i;
  function scan(d) {
    const hits = [];
    const hit = (checkName, p, hint = '') => hits.push({ check: checkName, path: p, hint });
    // Leaves: [path, value] for every string and number; object keys too (schema-closed anyway).
    const leaves = [];
    const walk = (v, p) => {
      if (typeof v === 'string' || typeof v === 'number') { leaves.push([p, v]); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { leaves.push([`${p}.${k}{key}`, k]); walk(x, `${p}.${k}`); }
    };
    walk(d, '$');
    const strLeaves = leaves.filter(([, v]) => typeof v === 'string');
    const leafTokens = strLeaves.map(([p, v]) => [p, tokens(v), v]);

    for (const [p, t, orig] of leafTokens) {
      for (let n = 1; n <= Math.min(maxNameWords, t.length); n++) {
        for (let i = 0; i + n <= t.length; i++) {
          const phrase = t.slice(i, i + n).join(' ');
          const m = nameMap.get(phrase);
          if (!m) continue;
          const co = coincide(phrase);
          hit('names', p, `${m.field}/${m.kind}, ${m.len} letters, ${capForm(orig, phrase)}${co ? `, coincides:${co}` : ''}`);
        }
      }
    }
    for (const [p, v] of leaves) {
      const compact = String(v).replace(/[\s().+-]/g, '');
      for (const dr of compact.match(/\d{7,}/g) || []) {
        for (const [r, srcName] of runList) if (dr.includes(r)) hit('ids', p, `${srcName}, ${r.length} digits, in a ${typeof v} leaf`);
      }
    }
    for (const [p, t] of leafTokens) {
      for (let n = 1; n <= Math.min(maxGroupWords, t.length); n++) {
        for (let i = 0; i + n <= t.length; i++) {
          const phrase = t.slice(i, i + n).join(' ');
          if (groupPhrases.has(phrase)) hit('groups', p, `${n} word(s), ${groupPhrases.get(phrase)} letters${coincide(phrase) ? `, coincides:${coincide(phrase)}` : ''}`);
        }
      }
    }
    let docGrams = 0;
    for (const [p, t] of leafTokens) {
      for (let i = 0; i + 6 <= t.length; i++) {
        docGrams++;
        if (msgGrams.has(t.slice(i, i + 6).join(' '))) { hit('messages', p, '6-word window'); break; }
      }
    }
    if (SUFFIX.test(JSON.stringify(d))) {
      const at = leaves.filter(([, v]) => SUFFIX.test(String(v)));
      if (at.length) for (const [p] of at) hit('suffixes', p, 'JID suffix');
      else hit('suffixes', '$', 'JID suffix in the JSON text');
    }
    let homeContainment = 'skipped (no home)';
    if (homeName) {
      const eqFields = [['$.now.where.name', d.now?.where?.name], ['$.now.travel.toName', d.now?.travel?.toName],
        ...(d.city?.places || []).map((pl, i) => [`$.city.places[${i}].name`, pl?.name])];
      for (const [p, v] of eqFields) if (v != null && norm(v) === homeName) hit('home', p, 'equals the home place name');
      if (GENERIC_HOME.has(homeName)) homeContainment = 'skipped (generic home name)';
      else {
        homeContainment = 'checked';
        const hw = homeName.split(' ');
        for (const [p, t] of leafTokens) {
          for (let i = 0; i + hw.length <= t.length; i++) if (t.slice(i, i + hw.length).join(' ') === homeName) { hit('home', p, 'contains the home place name'); break; }
        }
      }
    }
    let homeCellPins = 0;
    if (homePlace && Number.isFinite(homePlace.lat) && Number.isFinite(homePlace.lon)) {
      const hl = snap(homePlace.lat); const hn = snap(homePlace.lon);
      homeCellPins = (d.city?.places || []).filter((pl) => pl?.lat === hl && pl?.lon === hn).length;
    }
    let coords = 0;
    for (const [p, v] of leaves) {
      if (!/\.(lat|lon)$/.test(p)) continue;
      coords++;
      if (typeof v !== 'number' || snap(v) !== v) hit('grid', p, 'not a 0.01° cell centre');
    }
    const sv = validate(d, scrubber);
    if (!sv.ok) for (const e of sv.errors) hit('schema', String(e).split(':')[0], String(e).split(':').slice(1).join(':'));
    return { hits, stats: { leaves: leaves.length, strings: strLeaves.length, docGrams, coords, homeContainment, homeCellPins } };
  }

  // 5c. self-test: plant one private value per check into a clone; every check must fire
  // at exactly the planted path (a canary that cannot fail proves nothing).
  const CHECKS = ['names', 'ids', 'groups', 'messages', 'suffixes', 'home', 'grid', 'schema'];
  const planted = structuredClone(doc);
  const plantAt = {};
  const firstOf = (it) => { for (const x of it) return x; return null; };
  const plantRow = (checkName, label) => {
    planted.next = [...(planted.next || []), { at: NOW, end: null, kind: 'planted', label, placeId: null, with: [] }];
    plantAt[checkName] = `$.next[${planted.next.length - 1}].label`;
  };
  const longestRun = runList.map(([r]) => r).sort((a, b) => b.length - a.length)[0] ?? null;
  if (nameMap.size) plantRow('names', `Lunch with ${firstOf(nameMap.keys()).replace(/(^|\s)(\S)/gu, (m, a, b) => a + b.toUpperCase())}`);
  if (longestRun) plantRow('ids', `call ${longestRun}`);
  if (groupPhrases.size) plantRow('groups', `back from ${firstOf(groupPhrases.keys())}`);
  if (msgGrams.size) plantRow('messages', firstOf(msgGrams));
  plantRow('suffixes', 'ping 1234@lid');
  planted.city = { ...(planted.city || {}), places: [...(planted.city?.places || [])] };
  if (homeName) {
    planted.city.places.push({ id: 'p_0000000000', name: homeName, kind: null, lat: null, lon: null });
    plantAt.home = `$.city.places[${planted.city.places.length - 1}].name`;
  }
  planted.city.places.push({ id: 'p_0000000001', name: 'planted', kind: null, lat: 12.3456, lon: null });
  plantAt.grid = `$.city.places[${planted.city.places.length - 1}].lat`;
  plantAt.schema = plantAt.suffixes;   // a JID: the scrubber refuses it whatever the case
  const selfHits = scan(planted).hits;
  const selfOk = [];
  const selfSkipped = [];
  for (const c of CHECKS) {
    if (!plantAt[c]) { selfSkipped.push(c); continue; }
    if (selfHits.some((h) => h.check === c && h.path === plantAt[c])) selfOk.push(c);
  }
  const selfMissing = CHECKS.filter((c) => plantAt[c] && !selfOk.includes(c));
  check(`self-test: each check fires on a planted value (${selfOk.join(', ')}${selfSkipped.length ? `; no corpus for ${selfSkipped.join(', ')}` : ''})`,
    selfMissing.length === 0, selfMissing);

  // 5d. the real document
  const { hits, stats } = scan(doc);
  for (const c of CHECKS) check(`canary: ${c}`, !hits.some((h) => h.check === c), hits.filter((h) => h.check === c).length);
  check('no network attempt', netAttempts.length === 0, netAttempts.length);
  check('no send / presence / read receipt on the fake socket, no catch-up turn', sends.length === 0 && turns.length === 0, { sends: sends.length, turns: turns.length });
  check('the exporter never called put / pull', exporterCalls.put === 0 && exporterCalls.pull === 0, exporterCalls);
  check('no local public.json written (upload:false)', !fs.existsSync(path.join(OUT_DIR, 'public.json')));
  check('world.json / persona.json / arcs.json unchanged', sha(WORLD_PATH) === worldHashBefore
    && (!PERSONA_PATH || sha(PERSONA_PATH) === personaHashBefore) && (!ARCS_PATH || sha(ARCS_PATH) === arcsHashBefore));

  // ── 6. the report ──────────────────────────────────────────────────────────
  const rows = (doc.today?.rows?.length ?? 0) + (doc.days || []).reduce((a, d) => a + d.rows.length, 0);
  out('Public-site dry run (spec 013) — the real exporter on a copy, nothing uploaded');
  out(`  copy: ${kb(copyBytes)}, v${preVersion} → v${latest}; tables ${Object.keys(preCounts).length}; snapshots dropped ${droppedSnapshots}`);
  out(`  world: install (${world.places.length} places, ${world.cast.length} cast) — ${worldNote}; arc seed: ${seedSource}; persona: ${personaSource}`);
  out(`  life: last event #${state.lastEventId ?? '?'}; model calls by the stubs: ${[...modelCalls].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  out(`  export: status ${res.status}, ${bytes} bytes (${kb(bytes)}); today ${doc.today?.rows?.length ?? 0} rows, ${doc.days?.length ?? 0} past days (${rows} rows total), next ${doc.next?.length ?? 0}`);
  out(`          cast ${doc.people?.cast?.length ?? 0}, friends ${doc.people?.friends?.length ?? 0}, places ${doc.city?.places?.length ?? 0}, visits ${doc.city?.visits?.length ?? 0}, chapters ${doc.story?.chapters?.length ?? 0}, recaps ${doc.story?.recaps?.length ?? 0}, votes ${doc.votes?.length ?? 0}, journal ${doc.journal?.length ?? 0}`);
  out(`  canary corpus: ${nameMap.size} name phrase(s) from ${persons.length} people (${peopleRows.length - persons.length} own row(s) left out), ${runs.size} digit run(s), ${groupPhrases.size} group subject(s), ${msgTexts.length} message(s) → ${msgGrams.size} 6-grams`);
  out(`  document: ${stats.leaves} leaves (${stats.strings} strings), ${stats.docGrams} 6-word windows, ${stats.coords} coordinates; home containment ${stats.homeContainment}; public pins in the home's 0.01° cell ${stats.homeCellPins} (note)`);
  out('');
  out('── Checks ' + '─'.repeat(53));
  for (const r of results) out(`  ${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail !== undefined ? ` — ${JSON.stringify(r.detail).slice(0, 200)}` : ''}`);
  if (hits.length) {
    out('');
    out(`── Hits (${hits.length}) — check, JSON path, hint; never the value ` + '─'.repeat(8));
    const byCheck = new Map();
    for (const h of hits) { if (!byCheck.has(h.check)) byCheck.set(h.check, []); byCheck.get(h.check).push(h); }
    for (const [c, hs] of byCheck) {
      out(`  ${c}: ${hs.length}`);
      for (const h of hs.slice(0, 40)) out(`    ${h.path}${h.hint ? `  (${h.hint})` : ''}`);
      if (hs.length > 40) out(`    … ${hs.length - 40} more`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  out('');
  out(`${results.length - failed.length}/${results.length} checks passed, ${hits.length} canary hit(s)`);
  if (failed.length || hits.length) exitCode = 1;
} catch (err) {
  out(`\nFAILED: ${err?.name ?? 'Error'}${err?.code ? ` [${err.code}]` : ''}: ${String(err?.message ?? '').slice(0, 160)}`);
  if (VERBOSE) out(String(err?.stack ?? ''));
  exitCode = 1;
} finally {
  console.log(lines.join('\n'));
  try { await lifeMod?.stopLife?.(); } catch { /* best effort */ }
  try { closeDb?.(); } catch { /* best effort */ }
  if (!KEEP) {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (!fs.readdirSync(path.join(DATA, 'rehearsal')).length) fs.rmdirSync(path.join(DATA, 'rehearsal')); } catch { /* not ours / not empty */ }
  } else {
    console.log(`(kept ${path.relative(ROOT, SCRATCH)}/)`);
  }
}
process.exit(exitCode);
