// Exercises the schema ladder (spec 006, US6 / R12) without WhatsApp:
//   1. fresh DB → latest version, no backup, v0 baseline + every step present
//   2. re-run on a current DB is a no-op (sqlite_master identical, no new backup)
//   3. v0 fixture (c699f57's schema.sql + real-shaped rows) → backup 0600 in a 0700
//      dir, every backfill rule, FTS consistency after edits/deletes
//   4. v6 → latest (spec 007 ledger step v7, then 009's v8/v9, 008's v10, 010's v11): from a v6 DB without
//      the ledger tables (the live DB before 007) and from a v6 DB that already has
//      them (pre-merge 007 build) — idempotent
//   4b. v7 → v11 (spec 009 life steps, 008's mind step, 010's arcs step): a v7 DB
//      gets only v8 + v9 + v10 + v11 — the life, mind and story tables/triggers/indexes
//      appear, nothing else changes, a v7 backup is written
//   4c. v9 → v10 (spec 008 mind step): a v9 DB like the life tree gets v10 (then
//      v11); an injected failure in v10 leaves it at v9 with no mind tables (backup
//      first); the retry applies v10 + v11; a re-run is a no-op
//   4d. v10 → v11 (spec 010 arcs step): a v10 DB like live gets v11 — the 8
//      story_* tables (then v12); an injected failure in v11 leaves it at v10 with no
//      story_* tables and a -v10- backup; the retry applies v11 + v12; a re-run is a no-op
//   4e. v11 → v12 (spec 012 chat-influence step): a v11 DB like live gets only v12 —
//      the 3 chat_influence_* tables; an injected failure leaves it at v11 with a
//      -v11- backup; the retry applies exactly v12; a re-run is a no-op
//   4f. v12 → v13 (spec 013 public-site step): a v12 DB gets only v13; an injected failure
//      rolls back to v12 with a -v12- backup; the retry applies exactly v13; re-run no-op.
//   5. injected failure in step 1 → DB unchanged; in the rebuild step (3) → earlier
//      steps kept, the step rolled back, foreign_keys back ON; re-run then succeeds
// Exits non-zero if a check fails.
//
// Usage:  node scripts/test-migrate.js
// Scratch DB + backups live in data/test-migrate/ (deleted on exit).

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';

const SCRATCH_DIR = './data/test-migrate';
process.env.DB_PATH = `${SCRATCH_DIR}/karyasthan-test.db`;
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { config } = await import('../src/utils/config.js');
const { runMigrations, getDb, closeDb, assertSchemaCurrent, LATEST_SCHEMA_VERSION } = await import('../src/memory/db.js');
const { MIGRATIONS } = await import('../src/memory/migrations/index.js');
const { memoryFingerprint } = await import('../src/memory/migrations/fingerprint.js');

const dbPath = path.resolve(config.projectRoot, config.dbPath);
const scratchAbs = path.dirname(dbPath);
const backupDir = path.join(scratchAbs, 'backups');

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`); }
}
function throws(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

function removeDb() {
  closeDb();
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(dbPath + suf, { force: true });
}
function clearBackups() { fs.rmSync(backupDir, { recursive: true, force: true }); }
function backups() { return fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.endsWith('.db')) : []; }

// Schema + row counts, independent of WAL/file layout.
function snapshot(d) {
  const master = d.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();
  const counts = {};
  for (const { name } of master.filter(m => m.type === 'table' && !m.name.startsWith('sqlite_') && !/_fts_/.test(m.name))) {
    counts[name] = d.prepare(`SELECT COUNT(*) FROM "${name}"`).pluck().get();
  }
  return JSON.stringify({ uv: d.pragma('user_version', { simple: true }), master, counts });
}
const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);

function v0Schema() {
  try {
    return execFileSync('git', ['show', 'c699f57:src/memory/schema.sql'], { cwd: config.projectRoot, encoding: 'utf-8' });
  } catch {
    // No git history (e.g. a tarball install): the frozen baseline is the same shape.
    return fs.readFileSync(path.join(config.projectRoot, 'src/memory/schema.sql'), 'utf-8');
  }
}

const G1 = '120363000000000001@g.us';
const G2 = '155500000000-1500000000@g.us';   // PN-addressed group
const ALICE = '111@lid';
const BOB = '222@lid';
const CAROL = '155500000333@s.whatsapp.net';
const T0 = 1_700_000_000;
const CALL_SUMMARY = 'They planned the trip for Saturday.';

// Real-shaped pre-006 rows: group-JID call memories, NULL-scope + duplicate
// nicknames/slang, duplicate memories, NULL-content messages, the group's own JID
// as a "member", a profile summary, a stored voice descriptor.
function buildV0Fixture() {
  fs.mkdirSync(scratchAbs, { recursive: true });
  const raw = new Database(dbPath);
  raw.exec(v0Schema());
  const run = (sql, ...a) => raw.prepare(sql).run(...a);

  run(`INSERT INTO groups (jid, name, joined_at) VALUES (?, 'Friends', ?)`, G1, T0 + 500);
  run(`INSERT INTO groups (jid, name, joined_at) VALUES (?, 'Family', NULL)`, G2);
  run(`INSERT INTO people (jid, phone, push_name, summary, traits_json, interests_json, first_seen, updated_at)
       VALUES (?, '111', 'Alice', 'Runs the trip planning', '["organised"]', '["cricket"]', ?, ?)`, ALICE, T0, T0 + 50);
  run(`INSERT INTO people (jid, phone, push_name, first_seen) VALUES (?, '222', 'Bob', ?)`, BOB, T0);
  run(`INSERT INTO people (jid, phone, push_name, first_seen) VALUES (?, '155500000333', 'Carol', ?)`, CAROL, T0);
  run(`INSERT INTO people (jid, push_name, first_seen) VALUES (?, NULL, ?)`, G1, T0);   // group JID leaked into people
  for (const [g, p, j] of [[G1, ALICE, T0 + 900], [G1, BOB, T0 + 1200], [G1, G1, T0 + 100], [G2, CAROL, T0 + 3000]]) {
    run(`INSERT INTO group_members (group_jid, person_jid, joined_at) VALUES (?, ?, ?)`, g, p, j);
  }

  let i = 0;
  const msg = (chat, sender, content, ts, type = 'text') =>
    run(`INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, message_type, timestamp)
         VALUES (?, ?, ?, 'x', ?, ?, ?)`, `M${i++}`, chat, sender, content, type, ts);
  msg(G1, ALICE, 'kayaking saturday anyone', T0 + 200);
  msg(G1, BOB, null, T0 + 210, 'sticker');
  msg(G1, BOB, 'count me in for kayaking', T0 + 220);
  msg(ALICE, ALICE, 'secret plan in the dm', T0 + 300);
  msg(G2, CAROL, null, T0 + 2500, 'image');
  msg(G2, CAROL, 'dinner at home', T0 + 2600);
  msg('155500000333:5@s.whatsapp.net', CAROL, 'hi from my laptop', T0 + 2700);   // device-suffixed DM chat

  run(`INSERT INTO calls (id, direction, context, person_jid, group_jid, status, started_at, answered_at, summary)
       VALUES (7, 'outbound', 'group', ?, ?, 'ended', ?, ?, ?)`, ALICE, G1, T0 + 400, T0 + 405, CALL_SUMMARY);
  const mem = (cat, subj, grp, content, created) =>
    run(`INSERT INTO memories (category, subject_jid, group_jid, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      cat, subj, grp, content, created).lastInsertRowid;
  const ids = {
    groupCall: mem('event', ALICE, G1, `Phone call on 2023-11-14 (you called, about Friends): ${CALL_SUMMARY}`, T0 + 410),
    dmCall: mem('event', BOB, null, 'Phone call on 2023-11-15 (they called): Bob is moving next month.', T0 + 420),
    group: mem('fact', ALICE, G1, 'Alice is a doctor', T0 + 430),
    dm: mem('fact', ALICE, ALICE, 'Alice is job hunting', T0 + 440),
    owner: mem('fact', BOB, null, 'Bob prefers tea', T0 + 450),
    dupOld: mem('interest', BOB, G1, 'Bob is watching Dark', T0 + 460),
    dupNew: mem('interest', BOB, G1, 'bob is watching   dark!', T0 + 470),
  };

  // nicknames: NULL-scope duplicates (old UNIQUE allowed them) + scoped rows
  run(`INSERT INTO nicknames (person_jid, nickname, group_jid, confidence, use_count, first_seen, last_used)
       VALUES (?, 'ali', NULL, 0.4, 2, ?, ?)`, ALICE, T0 + 10, T0 + 20);
  run(`INSERT INTO nicknames (person_jid, nickname, group_jid, confidence, use_count, first_seen, last_used)
       VALUES (?, 'ali', NULL, 0.7, 3, ?, ?)`, ALICE, T0 + 5, T0 + 30);
  run(`INSERT INTO nicknames (person_jid, nickname, group_jid, use_count) VALUES (?, 'bobby', ?, 1)`, BOB, G1);
  run(`INSERT INTO relationships (person_a_jid, person_b_jid, relationship, group_jid, updated_at) VALUES (?, ?, 'friends', NULL, ?)`, ALICE, BOB, T0);
  run(`INSERT INTO relationships (person_a_jid, person_b_jid, relationship, group_jid, updated_at) VALUES (?, ?, 'cousins', ?, ?)`, ALICE, BOB, G1, T0);
  run(`INSERT INTO slang (term, meaning, group_jid, use_count) VALUES ('scene', 'problem', ?, 4)`, G1);
  run(`INSERT INTO slang (term, meaning, group_jid, use_count) VALUES ('scene', NULL, NULL, 1)`);
  run(`INSERT INTO slang (term, meaning, group_jid, use_count) VALUES ('scene', NULL, NULL, 1)`);
  run(`INSERT INTO slang (term, meaning, group_jid, use_count) VALUES ('machaa', 'buddy', ?, 2)`, ALICE);
  run(`INSERT INTO person_style_card (person_jid, group_jid, card_json, voice_descriptor) VALUES (?, ?, '{}', 'talks like x')`, ALICE, G1);
  raw.close();
  return ids;
}

try {
  fs.rmSync(scratchAbs, { recursive: true, force: true });

  // ── 1. Fresh database ──────────────────────────────────────────────────────
  console.log('\nFresh database');
  check('ladder is v1..vN in order', MIGRATIONS.every((m, i) => m.version === i + 1) && LATEST_SCHEMA_VERSION === MIGRATIONS.length);
  check('assertSchemaCurrent refuses a missing DB without creating it', !!throws(assertSchemaCurrent) && !fs.existsSync(dbPath));
  let r = runMigrations();
  let db = getDb();
  check(`user_version = ${LATEST_SCHEMA_VERSION}`, db.pragma('user_version', { simple: true }) === LATEST_SCHEMA_VERSION);
  check('all steps applied', r.applied.length === MIGRATIONS.length);
  check('no backup for a brand-new DB', r.backup === null && backups().length === 0);
  check('people profile columns absent', !cols(db, 'people').includes('summary') && !cols(db, 'people').includes('traits_json'));
  check('nicknames scoped (origin_jid, no group_jid)', cols(db, 'nicknames').includes('origin_jid') && !cols(db, 'nicknames').includes('group_jid'));
  check('new tables exist', ['person_identities', 'person_facets', 'item_evidence', 'item_origins', 'learning_exclusions',
    'group_membership_log', 'learning_state', 'relays', 'ig_sync_state', 'identity_merge_queue',
    'llm_usage', 'prefilter_log', 'world_events', 'world_snapshots', 'life_queue', 'life_claims',
    'mind_state', 'mind_settings', 'mind_runs', 'mind_nights', 'mind_chat_activity', 'mind_digests',
    'mind_episode_cursor', 'mind_episode_log', 'mind_self_state', 'mind_self_model', 'mind_nudges',
    'mind_proactive', 'mind_exclusions']
    .every(t => db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)));
  check('episode index on memories exists', !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_memories_episode'`).get());
  check('msg_fts_delete trigger exists', !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='msg_fts_delete'`).get());
  check('assertSchemaCurrent passes', !throws(assertSchemaCurrent));
  check('foreign_keys ON', db.pragma('foreign_keys', { simple: true }) === 1);

  // ── 2. Re-run is a no-op ───────────────────────────────────────────────────
  console.log('\nRe-run');
  const before = snapshot(db);
  r = runMigrations();
  db = getDb();
  check('nothing applied', r.applied.length === 0 && r.backup === null);
  check('sqlite_master + counts identical', snapshot(db) === before);
  const status = runMigrations({ apply: false });
  check('apply:false reports no pending steps', status.pending.length === 0);

  // ── 3. v0 fixture ──────────────────────────────────────────────────────────
  console.log('\nv0 fixture → latest');
  removeDb(); clearBackups();
  const ids = buildV0Fixture();
  const dry = runMigrations({ apply: false });
  check('apply:false lists every step and changes nothing', dry.from === 0 && dry.pending.length === MIGRATIONS.length
    && getDb().pragma('user_version', { simple: true }) === 0 && cols(getDb(), 'memories').indexOf('origin_jid') === -1);
  check('assertSchemaCurrent refuses a v0 DB', !!throws(assertSchemaCurrent));
  const msgCountBefore = getDb().prepare('SELECT COUNT(*) FROM messages').pluck().get();
  r = runMigrations();
  db = getDb();
  check('stepped v0 → latest', r.from === 0 && r.to === LATEST_SCHEMA_VERSION && r.applied.length === MIGRATIONS.length);
  const files = backups();
  check('one backup written', files.length === 1 && /^karyasthan-test-v0-\d{8}T\d{6}Z\.db$/.test(files[0]));
  if (files.length) {
    check('backup file is 0600', (fs.statSync(path.join(backupDir, files[0])).mode & 0o777) === 0o600);
    check('backup dir is 0700', (fs.statSync(backupDir).mode & 0o777) === 0o700);
    const b = new Database(path.join(backupDir, files[0]), { readonly: true });
    check('backup is the v0 database', b.pragma('user_version', { simple: true }) === 0 && cols(b, 'people').includes('summary'));
    b.close();
  }
  check('messages preserved', db.prepare('SELECT COUNT(*) FROM messages').pluck().get() === msgCountBefore);

  const m = (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  check('every memory has an origin', db.prepare('SELECT COUNT(*) FROM memories WHERE origin_jid IS NULL OR origin_kind IS NULL').pluck().get() === 0);
  check('group-JID call memory → call, caller DM', m(ids.groupCall).origin_kind === 'call' && m(ids.groupCall).origin_jid === ALICE);
  check('call memory tied to its call record', !!db.prepare(`SELECT 1 FROM item_evidence WHERE item_type='memory' AND item_id=? AND msg_id='call:7'`).get(ids.groupCall));
  check('NULL-scope call memory → call, caller DM', m(ids.dmCall).origin_kind === 'call' && m(ids.dmCall).origin_jid === BOB);
  check('group memory → group', m(ids.group).origin_kind === 'group' && m(ids.group).origin_jid === G1 && m(ids.group).source === 'heuristic');
  check('DM memory → dm', m(ids.dm).origin_kind === 'dm' && m(ids.dm).origin_jid === ALICE);
  check('NULL-scope memory → owner, subject_dm', m(ids.owner).origin_kind === 'owner' && m(ids.owner).origin_jid === 'owner' && m(ids.owner).visibility === 'subject_dm');
  check('learned_at = created_at', m(ids.group).learned_at === T0 + 430);
  check('fingerprint matches memoryFingerprint()', m(ids.group).fingerprint === memoryFingerprint({ originJid: G1, subjectJid: ALICE, content: 'Alice is a doctor' }));
  check('older duplicate superseded by newest', m(ids.dupOld).superseded_by === ids.dupNew && m(ids.dupNew).superseded_by === null);
  check('partial unique index blocks a second current duplicate', !!throws(() =>
    db.prepare(`INSERT INTO memories (category, subject_jid, content, origin_kind, origin_jid, fingerprint) VALUES ('fact', ?, 'x', 'group', ?, ?)`)
      .run(BOB, G1, m(ids.dupNew).fingerprint)));

  const nick = db.prepare(`SELECT * FROM nicknames WHERE person_jid = ? AND nickname = 'ali'`).all(ALICE);
  check('NULL-scope nickname duplicates merged into one owner row', nick.length === 1 && nick[0].origin_kind === 'owner'
    && nick[0].origin_jid === 'owner' && nick[0].use_count === 5 && nick[0].confidence === 0.7 && nick[0].first_seen === T0 + 5);
  check('group nickname → group', db.prepare(`SELECT origin_jid FROM nicknames WHERE nickname = 'bobby'`).pluck().get() === G1);
  check('relationships: NULL → owner, group kept', db.prepare(`SELECT origin_kind FROM relationships ORDER BY origin_kind`).pluck().all().join(',') === 'group,owner');
  const slang = db.prepare(`SELECT term, origin_kind, origin_jid FROM slang ORDER BY term`).all();
  check('NULL-scope slang dropped, scoped slang kept', slang.length === 2 && slang.every(s => s.origin_jid !== null)
    && slang.find(s => s.term === 'machaa')?.origin_kind === 'dm');

  check('people.summary/traits_json/interests_json dropped', !['summary', 'traits_json', 'interests_json'].some(c => cols(db, 'people').includes(c)));
  const facet = db.prepare(`SELECT * FROM person_facets WHERE person_jid = ?`).get(ALICE);
  check('profile → owner facet, subject_dm', facet && facet.origin_kind === 'owner' && facet.visibility === 'subject_dm'
    && facet.summary === 'Runs the trip planning' && JSON.parse(facet.interests_json)[0] === 'cricket');
  check('no facet for an empty profile', !db.prepare(`SELECT 1 FROM person_facets WHERE person_jid = ?`).get(BOB));
  check('identities seeded (lid/pn), not for group JIDs',
    db.prepare(`SELECT kind FROM person_identities WHERE jid = ?`).pluck().get(ALICE) === 'lid'
    && db.prepare(`SELECT kind FROM person_identities WHERE jid = ?`).pluck().get(CAROL) === 'pn'
    && !db.prepare(`SELECT 1 FROM person_identities WHERE jid = ?`).get(G1));

  check("group's own JID removed from group_members", !db.prepare(`SELECT 1 FROM group_members WHERE person_jid LIKE '%@g.us'`).get());
  check('members back-dated to the group first observation', db.prepare(`SELECT joined_at FROM group_members WHERE group_jid = ? AND person_jid = ?`).pluck().get(G1, BOB) === T0 + 200);
  check('PN-addressed group: first message when no group joined_at', db.prepare(`SELECT joined_at FROM group_members WHERE group_jid = ?`).pluck().get(G2) === T0 + 2500);
  check('backfill join rows logged', db.prepare(`SELECT COUNT(*) FROM group_membership_log WHERE action='join' AND source='backfill'`).pluck().get() === 3);
  check('voice descriptors cleared', db.prepare(`SELECT COUNT(*) FROM person_style_card WHERE voice_descriptor IS NOT NULL`).pluck().get() === 0);
  const ls = db.prepare(`SELECT last_batch_rowid FROM learning_state WHERE chat_jid = ?`).pluck().get(G1);
  check('learning_state seeded with MAX(rowid) per chat', ls === db.prepare(`SELECT MAX(rowid) FROM messages WHERE group_jid = ?`).pluck().get(G1)
    && db.prepare('SELECT COUNT(*) FROM learning_state').pluck().get() === 4
    && !!db.prepare('SELECT 1 FROM learning_state WHERE chat_jid = ?').get(CAROL));

  console.log('\nFTS consistency');
  const hits = (q) => db.prepare(`SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?`).pluck().all(q);
  const ftsOk = () => !throws(() => db.prepare(`INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)`).run());
  check('rebuilt index finds existing rows', hits('kayaking').length === 2);
  check('FTS integrity-check passes after rebuild', ftsOk());
  db.prepare(`INSERT INTO messages (id, group_jid, sender_jid, content, timestamp) VALUES ('M9', ?, ?, NULL, ?)`).run(G1, BOB, T0 + 999);
  db.prepare(`UPDATE messages SET content = 'kayaking photo' WHERE id = 'M1'`).run();      // NULL → text
  check('NULL → text edit indexed', hits('photo').join() === 'M1');
  db.prepare(`UPDATE messages SET content = 'went canoeing instead' WHERE id = 'M0'`).run(); // text → text
  check('text edit replaces old terms', !hits('saturday').length && hits('canoeing').join() === 'M0');
  db.prepare(`UPDATE messages SET content = NULL WHERE id = 'M2'`).run();                   // text → NULL
  check('text → NULL removes the row', !hits('count').length);
  db.prepare(`DELETE FROM messages WHERE id = 'M3'`).run();
  check('deleted message leaves the index', !hits('secret').length);
  check('FTS integrity-check passes after edits/deletes', ftsOk());

  // ── 4. Injected failures ──────────────────────────────────────────────────
  console.log('\nInjected failure');
  removeDb(); clearBackups();
  buildV0Fixture();
  let raw = new Database(dbPath);
  const v0Snap = snapshot(raw);
  raw.close();
  const step1 = MIGRATIONS[0].up;
  MIGRATIONS[0].up = (d) => { step1(d); throw new Error('injected'); };
  let err = throws(() => runMigrations());
  MIGRATIONS[0].up = step1;
  check('failing step throws', !!err && /v1/.test(err.message));
  closeDb();
  raw = new Database(dbPath);
  check('DB unchanged after a failed first step', snapshot(raw) === v0Snap);
  raw.close();
  check('backup still written first', backups().length === 1);

  const step3 = MIGRATIONS[2].up;
  MIGRATIONS[2].up = (d) => { step3(d); throw new Error('injected'); };
  err = throws(() => runMigrations());
  MIGRATIONS[2].up = step3;
  db = getDb();
  check('rebuild step failure throws', !!err && /v3/.test(err.message));
  check('earlier steps kept, failed step rolled back', db.pragma('user_version', { simple: true }) === 2
    && cols(db, 'nicknames').includes('group_jid') && cols(db, 'memories').includes('origin_jid')
    && !db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'nicknames_new'`).get());
  check('foreign_keys back ON after the failed rebuild', db.pragma('foreign_keys', { simple: true }) === 1);
  check('v0 backup reused within the hour (no restart-loop pile-up)', backups().filter(f => f.includes('-v0-')).length === 1);

  r = runMigrations();
  db = getDb();
  check('re-run after the fix completes', r.from === 2 && r.to === LATEST_SCHEMA_VERSION);
  check('nickname rows survive the retry', db.prepare('SELECT COUNT(*) FROM nicknames').pluck().get() === 2);

  // ── v6 → latest (spec 007 usage ledger, then the 009 life steps) ──────────
  console.log('\nv6 → latest (llm_usage + prefilter_log, then world_events + life ops, then mind, then the story tables)');
  const hasTable = (d, t) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const hasObj = (d, type, n) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type=? AND name=?`).get(type, n);
  const LIFE_TABLES = ['world_events', 'world_snapshots', 'life_queue', 'life_claims'];
  const dropLife = (d) => d.exec(LIFE_TABLES.map(t => `DROP TABLE ${t};`).join(' '));   // drops their indexes + triggers too
  const MIND_TABLES = ['mind_state', 'mind_settings', 'mind_runs', 'mind_nights', 'mind_chat_activity', 'mind_digests',
    'mind_episode_cursor', 'mind_episode_log', 'mind_self_state', 'mind_self_model', 'mind_nudges', 'mind_proactive',
    'mind_exclusions'];
  const MIND_INDEXES = ['idx_mind_runs_kind', 'idx_mind_runs_day', 'idx_mind_digests_chat', 'idx_mind_self_state_status',
    'idx_mind_self_model_version', 'idx_mind_self_model_active', 'idx_mind_nudges_active', 'idx_mind_nudges_created',
    'idx_mind_proactive_queued', 'idx_mind_proactive_chat', 'idx_mind_proactive_status', 'idx_mind_exclusions_jid',
    'idx_memories_episode'];
  const dropMind = (d) => d.exec(MIND_TABLES.map(t => `DROP TABLE ${t};`).join(' ') + ' DROP INDEX idx_memories_episode;');
  const STORY_TABLES = ['story_claim_reviews', 'story_runs', 'story_proposals', 'story_journal_nights', 'story_journal_parts',
    'story_narrations', 'story_refusals', 'story_state', 'story_scenes', 'story_messages', 'story_thoughts', 'story_dreams', 'story_standing', 'story_standing_evidence', 'story_check_runs', 'story_check_claims'];   // 016: story_scenes (v14), 019: story_messages (v15) go with them
  const STORY_INDEXES = ['idx_story_claim_reviews_status', 'idx_story_claim_reviews_origin', 'idx_story_runs_kind',
    'idx_story_proposals_status', 'idx_story_refusals_at'];
  const dropStory = (d) => d.exec(STORY_TABLES.map(t => `DROP TABLE ${t};`).join(' '));   // drops their indexes too
  // The v12 step's objects (spec 012): chat_influence_* tables and their indexes.
  const INFLUENCE_TABLES = ['chat_influence_items', 'chat_influence_pending_withdrawals', 'chat_influence_state'];
  const INFLUENCE_INDEXES = ['idx_chat_influence_items_msg', 'idx_chat_influence_items_status', 'idx_chat_influence_items_sender'];
  const dropInfluence = (d) => d.exec(INFLUENCE_TABLES.map(t => `DROP TABLE ${t};`).join(' '));
  const INFLUENCE_LIKE = `name NOT GLOB 'chat_influence_*' AND name NOT GLOB 'idx_chat_influence_*' AND name NOT GLOB 'sqlite_autoindex_chat_influence_*'`;
  const INFLUENCE_NAME_RE = /^(idx_|sqlite_autoindex_)?chat_influence_/;
  // The v11 step's objects: story_* tables, their idx_story_* indexes and autoindexes (UNIQUE / text PKs).
  const STORY_LIKE = `name NOT GLOB 'story_*' AND name NOT GLOB 'idx_story_*' AND name NOT GLOB 'sqlite_autoindex_story_*'`;
  const STORY_NAME_RE = /^(idx_|sqlite_autoindex_)?story_/;
  // The v10 step's objects: mind_* tables, their idx_mind_* / autoindexes and the episode index on memories.
  const MIND_LIKE = `name NOT GLOB 'mind_*' AND name NOT GLOB 'idx_mind_*' AND name NOT GLOB 'sqlite_autoindex_mind_*'
    AND name != 'idx_memories_episode'`;
  const MIND_NAME_RE = /^(idx_|sqlite_autoindex_)?mind_|^idx_memories_episode$/;
  const LEDGER_LIKE = `name NOT LIKE 'llm_usage%' AND name NOT LIKE 'idx_llm_usage%' AND name NOT LIKE 'prefilter_log%' AND name NOT LIKE 'idx_prefilter%'`;
  const LIFE_LIKE = `name NOT GLOB 'world_*' AND name NOT GLOB 'life_*' AND name NOT GLOB 'idx_world_*' AND name NOT GLOB 'idx_life_*'
    AND name NOT GLOB 'sqlite_autoindex_life_*'`;   // GLOB: '_' is literal; life_queue's UNIQUE gets an autoindex
  const otherSchema = (d, where) => JSON.stringify(d.prepare(`SELECT type, name, sql FROM sqlite_master WHERE ${where} ORDER BY type, name`).all());
  check('v7 is the llm-usage step', MIGRATIONS[6]?.version === 7 && MIGRATIONS[6]?.name === 'llm-usage');
  check('v8 is the world-events step', MIGRATIONS[7]?.version === 8 && MIGRATIONS[7]?.name === 'world-events');
  check('v9 is the life-ops step', MIGRATIONS[8]?.version === 9 && MIGRATIONS[8]?.name === 'life-ops');
  check('v10 is the mind step', MIGRATIONS[9]?.version === 10 && MIGRATIONS[9]?.name === 'mind');
  check('v11 is the arcs step', MIGRATIONS[10]?.version === 11 && MIGRATIONS[10]?.name === 'arcs');
  check('v12 is the chat-influence step', MIGRATIONS[11]?.version === 12 && MIGRATIONS[11]?.name === 'chat-influence');
  check('v13 is the public-site step', MIGRATIONS[12]?.version === 13 && MIGRATIONS[12]?.name === 'public-site');
  check('v14 is the scenes step', MIGRATIONS[13]?.version === 14 && MIGRATIONS[13]?.name === 'scenes');
  check('v15 is the phone step', MIGRATIONS[14]?.version === 15 && MIGRATIONS[14]?.name === 'phone');
  check('v16 is the thoughts step', MIGRATIONS[15]?.version === 16 && MIGRATIONS[15]?.name === 'thoughts');
  check('v17 is the stance step', MIGRATIONS[16]?.version === 17 && MIGRATIONS[16]?.name === 'stance');
  check('v18 is the dreams step', MIGRATIONS[17]?.version === 18 && MIGRATIONS[17]?.name === 'dreams');
  check('v19 is the standing step', MIGRATIONS[18]?.version === 19 && MIGRATIONS[18]?.name === 'standing');
  for (const t of ['story_standing', 'story_standing_evidence']) check(`v19 adds ${t}`, db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) != null);
  check('v20 is the claim check', MIGRATIONS[19]?.version === 20 && MIGRATIONS[19]?.name === 'claim-check');
  for (const t of ['story_check_runs', 'story_check_claims']) check(`v20 adds ${t}`, db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) != null);
  check('v21 is the weekly review (latest)', MIGRATIONS[20]?.version === 21 && MIGRATIONS[20]?.name === 'weekly-review'
    && MIGRATIONS.length === 21 && LATEST_SCHEMA_VERSION === 21);
  check('v21 adds review_items and review_weeks', ['review_items', 'review_weeks'].every((t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) != null));
  check('v18 adds story_dreams', db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='story_dreams'").get() != null);
  for (const t of ['self_stance', 'self_stance_evidence', 'self_stance_history']) {
    check(`v17 adds ${t}`, db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) != null);
  }
  for (const preexisting of [false, true]) {
    removeDb(); clearBackups();
    runMigrations();
    db = getDb();
    db.prepare(`INSERT INTO people (jid, push_name) VALUES ('333@lid', 'Dan')`).run();
    if (!preexisting) { db.exec('DROP TABLE llm_usage; DROP TABLE prefilter_log;'); }
    dropLife(db);
    dropMind(db);
    dropStory(db);
    dropInfluence(db);
    db.pragma('user_version = 6');
    const v6Tables = otherSchema(db, `${LEDGER_LIKE} AND ${LIFE_LIKE} AND ${MIND_LIKE} AND ${STORY_LIKE} AND ${INFLUENCE_LIKE}`);
    const label = preexisting ? 'ledger tables already present' : 'ledger tables absent';
    check(`[${label}] apply:false reports v7..v14 pending`,
      JSON.stringify(runMigrations({ apply: false }).pending) === '["v7-llm-usage","v8-world-events","v9-life-ops","v10-mind","v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
    r = runMigrations();
    db = getDb();
    check(`[${label}] applied exactly v7..v14`, r.from === 6 && r.to === 21
      && JSON.stringify(r.applied) === '["v7-llm-usage","v8-world-events","v9-life-ops","v10-mind","v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
    check(`[${label}] llm_usage + prefilter_log exist`, hasTable(db, 'llm_usage') && hasTable(db, 'prefilter_log'));
    check(`[${label}] life tables exist`, LIFE_TABLES.every(t => hasTable(db, t)));
    check(`[${label}] mind tables exist`, MIND_TABLES.every(t => hasTable(db, t)));
    check(`[${label}] story tables exist`, STORY_TABLES.every(t => hasTable(db, t)));
    check(`[${label}] chat influence tables exist`, INFLUENCE_TABLES.every(t => hasTable(db, t)));
    check(`[${label}] nothing else in the schema changed`,
      otherSchema(db, `${LEDGER_LIKE} AND ${LIFE_LIKE} AND ${MIND_LIKE} AND ${STORY_LIKE} AND ${INFLUENCE_LIKE}`) === v6Tables);
    check(`[${label}] rows kept`, db.prepare(`SELECT COUNT(*) FROM people`).pluck().get() === 1);
    check(`[${label}] v6 backup written`, !!r.backup && /-v6-\d{8}T\d{6}Z\.db$/.test(r.backup) && backups().length === 1);
  }

  // ── v7 → v11 (spec 009 life steps, 008's mind step, then 010's arcs step) ──
  console.log('\nv7 → v11 (world_events + world_snapshots, life_queue + life_claims, the mind tables, then the story tables)');
  removeDb(); clearBackups();
  runMigrations();
  db = getDb();
  db.prepare(`INSERT INTO people (jid, push_name) VALUES ('444@lid', 'Eve')`).run();
  db.prepare(`INSERT INTO llm_usage (role, provider, model, cost_source) VALUES ('mouth', 'gemini', 'm', 'unknown')`).run();
  dropLife(db);
  dropMind(db);
  dropStory(db);
  dropInfluence(db);
  db.pragma('user_version = 7');
  check('v7 fixture has no life, mind or story tables', LIFE_TABLES.every(t => !hasTable(db, t))
    && MIND_TABLES.every(t => !hasTable(db, t)) && STORY_TABLES.every(t => !hasTable(db, t)));
  const v7Schema = otherSchema(db, `${LIFE_LIKE} AND ${MIND_LIKE} AND ${STORY_LIKE} AND ${INFLUENCE_LIKE}`);
  const v7Rows = snapshot(db).replace(/"uv":\d+,/, '');
  check('apply:false reports only v8 … v13 pending',
    JSON.stringify(runMigrations({ apply: false }).pending) === '["v8-world-events","v9-life-ops","v10-mind","v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('…and touched nothing', db.pragma('user_version', { simple: true }) === 7 && LIFE_TABLES.every(t => !hasTable(db, t)));
  r = runMigrations();
  db = getDb();
  check('applied exactly v8 … v13', r.from === 7 && r.to === 21
    && JSON.stringify(r.applied) === '["v8-world-events","v9-life-ops","v10-mind","v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('user_version = 21', db.pragma('user_version', { simple: true }) === 21);
  check('life tables exist', LIFE_TABLES.every(t => hasTable(db, t)));
  check('mind tables exist', MIND_TABLES.every(t => hasTable(db, t)));
  check('story tables exist', STORY_TABLES.every(t => hasTable(db, t)));
  check('chat influence tables exist', INFLUENCE_TABLES.every(t => hasTable(db, t)));
  check('append-only triggers exist', hasObj(db, 'trigger', 'world_events_no_delete') && hasObj(db, 'trigger', 'world_events_no_update'));
  check('life indexes exist', ['idx_world_events_at', 'idx_world_events_type_at', 'idx_world_events_cause', 'idx_world_events_origin_at',
    'idx_world_events_subject', 'idx_world_snapshots_upto', 'idx_world_snapshots_at', 'idx_life_queue_status', 'idx_life_claims_status']
    .every(n => hasObj(db, 'index', n)));
  check('nothing else in the schema changed', otherSchema(db, `${LIFE_LIKE} AND ${MIND_LIKE} AND ${STORY_LIKE} AND ${INFLUENCE_LIKE}`) === v7Schema);
  const after = JSON.parse(snapshot(db));
  for (const t of [...LIFE_TABLES, ...MIND_TABLES, ...STORY_TABLES, ...INFLUENCE_TABLES]) delete after.counts[t];
  after.master = after.master.filter(m => !/^(idx_|sqlite_autoindex_)?(world|life)_/.test(m.name) && !MIND_NAME_RE.test(m.name)
    && !STORY_NAME_RE.test(m.name) && !INFLUENCE_NAME_RE.test(m.name));
  delete after.uv;
  check('rows kept (people, llm_usage, every other table)', JSON.stringify(after) === v7Rows
    && db.prepare(`SELECT COUNT(*) FROM people`).pluck().get() === 1 && db.prepare(`SELECT COUNT(*) FROM llm_usage`).pluck().get() === 1);
  check('v7 backup written (0600)', !!r.backup && /-v7-\d{8}T\d{6}Z\.db$/.test(r.backup) && backups().length === 1
    && (fs.statSync(r.backup).mode & 0o777) === 0o600);
  const bk = new Database(r.backup, { readonly: true });
  check('backup is the v7 database', bk.pragma('user_version', { simple: true }) === 7 && !hasTable(bk, 'world_events'));
  bk.close();
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (1, 'test', 'engine')`).run();
  check('world_events DELETE refused by trigger', !!throws(() => db.prepare('DELETE FROM world_events').run()));
  check('world_events UPDATE refused by trigger', !!throws(() => db.prepare(`UPDATE world_events SET type = 'x'`).run()));
  const rerun = snapshot(db);
  r = runMigrations();
  check('re-run on v12 is a no-op', r.applied.length === 0 && r.backup === null && snapshot(getDb()) === rerun);
  db = getDb();

  // ── v9 → v10 (spec 008 mind step on a DB like the life tree) ───────────────
  console.log('\nv9 → v10 (the 13 mind tables + the episode index; v11 follows)');
  removeDb(); clearBackups();
  runMigrations();
  db = getDb();
  db.prepare(`INSERT INTO people (jid, push_name) VALUES ('555@lid', 'Finn')`).run();
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (1, 'test', 'engine')`).run();
  db.prepare(`INSERT INTO memories (category, content, origin_kind, origin_jid) VALUES ('fact', 'likes tea', 'group', ?)`).run(G1);
  dropMind(db);
  dropStory(db);
  dropInfluence(db);
  db.pragma('user_version = 9');
  check('v9 fixture has no mind or story tables', MIND_TABLES.every(t => !hasTable(db, t)) && !hasObj(db, 'index', 'idx_memories_episode')
    && STORY_TABLES.every(t => !hasTable(db, t)));
  const v9Schema = otherSchema(db, `${MIND_LIKE} AND ${STORY_LIKE} AND ${INFLUENCE_LIKE}`);
  const v9Rows = snapshot(db).replace(/"uv":\d+,/, '');
  check('apply:false reports only v10 … v13 pending', JSON.stringify(runMigrations({ apply: false }).pending) === '["v10-mind","v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('…and touched nothing', db.pragma('user_version', { simple: true }) === 9 && MIND_TABLES.every(t => !hasTable(db, t)));

  const step10 = MIGRATIONS[9].up;
  MIGRATIONS[9].up = (d) => { step10(d); throw new Error('injected'); };
  err = throws(() => runMigrations());
  MIGRATIONS[9].up = step10;
  db = getDb();
  check('failing v10 throws', !!err && /v10/.test(err.message));
  check('v10 failure rolled back: still v9, no mind tables, no episode index', db.pragma('user_version', { simple: true }) === 9
    && MIND_TABLES.every(t => !hasTable(db, t)) && !hasObj(db, 'index', 'idx_memories_episode'));
  check('…and v11 never ran (no story tables)', STORY_TABLES.every(t => !hasTable(db, t)));
  check('…schema and rows unchanged', otherSchema(db, `${MIND_LIKE} AND ${STORY_LIKE} AND ${INFLUENCE_LIKE}`) === v9Schema
    && snapshot(db).replace(/"uv":\d+,/, '') === v9Rows);
  check('v9 backup written before the failed step', backups().length === 1 && /-v9-\d{8}T\d{6}Z\.db$/.test(backups()[0]));

  r = runMigrations();
  db = getDb();
  check('retry applies exactly v10 … v13', r.from === 9 && r.to === 21 && JSON.stringify(r.applied) === '["v10-mind","v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('user_version = 21', db.pragma('user_version', { simple: true }) === 21);
  check('all 13 mind tables exist', MIND_TABLES.length === 13 && MIND_TABLES.every(t => hasTable(db, t)));
  check('mind indexes exist (incl. partial uniques + the episode index)', MIND_INDEXES.every(n => hasObj(db, 'index', n)));
  const tableSql = (t) => db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).pluck().get(t) || '';
  check('every mind surrogate id is AUTOINCREMENT', ['mind_runs', 'mind_digests', 'mind_self_state', 'mind_self_model',
    'mind_nudges', 'mind_proactive', 'mind_exclusions'].every(t => /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/.test(tableSql(t))));
  check('episode index is partial on category = episode',
    /WHERE category = 'episode'/.test(db.prepare(`SELECT sql FROM sqlite_master WHERE name='idx_memories_episode'`).pluck().get() || ''));
  check('nothing else in the schema changed', otherSchema(db, `${MIND_LIKE} AND ${STORY_LIKE} AND ${INFLUENCE_LIKE}`) === v9Schema);
  const after10 = JSON.parse(snapshot(db));
  for (const t of [...MIND_TABLES, ...STORY_TABLES, ...INFLUENCE_TABLES]) delete after10.counts[t];
  after10.master = after10.master.filter(m => !MIND_NAME_RE.test(m.name) && !STORY_NAME_RE.test(m.name) && !INFLUENCE_NAME_RE.test(m.name));
  delete after10.uv;
  check('rows kept (people, world_events, memories, every other table)', JSON.stringify(after10) === v9Rows);
  check('v9 backup reused within the hour', backups().length === 1 && r.backup && /-v9-/.test(r.backup));
  const bk9 = new Database(r.backup, { readonly: true });
  check('backup is the v9 database', bk9.pragma('user_version', { simple: true }) === 9 && !hasTable(bk9, 'mind_runs'));
  bk9.close();
  check('mind_state is a singleton (CHECK id = 1)', !!throws(() => db.prepare('INSERT INTO mind_state (id) VALUES (2)').run()));
  const rerun10 = snapshot(db);
  r = runMigrations();
  check('re-run on v12 is a no-op', r.applied.length === 0 && r.backup === null && snapshot(getDb()) === rerun10);
  check('the v10 step itself is re-run safe (IF NOT EXISTS)', !throws(() => getDb().transaction(() => step10(getDb()))())
    && snapshot(getDb()) === rerun10);
  db = getDb();

  // ── v10 → v11 (spec 010 arcs step on a DB like live: life + mind) ─────────
  console.log('\nv10 → v11 (the 8 story tables; v12 follows)');
  removeDb(); clearBackups();
  runMigrations();
  db = getDb();
  db.prepare(`INSERT INTO people (jid, push_name) VALUES ('666@lid', 'Gale')`).run();
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (1, 'test', 'engine')`).run();
  db.prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, text) VALUES (?, 'group', ?, 'going to the gym later')`).run(G1, G1);
  db.prepare(`INSERT INTO mind_state (id, last_rowid) VALUES (1, 7)`).run();
  dropStory(db);
  dropInfluence(db);
  db.pragma('user_version = 10');
  check('v10 fixture has no story tables', STORY_TABLES.every(t => !hasTable(db, t)));
  const v10Schema = otherSchema(db, `${STORY_LIKE} AND ${INFLUENCE_LIKE}`);
  const v10Rows = snapshot(db).replace(/"uv":\d+,/, '');
  check('apply:false reports only v11 … v13 pending', JSON.stringify(runMigrations({ apply: false }).pending) === '["v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('…and touched nothing', db.pragma('user_version', { simple: true }) === 10 && STORY_TABLES.every(t => !hasTable(db, t)));

  const step11 = MIGRATIONS[10].up;
  MIGRATIONS[10].up = (d) => { step11(d); throw new Error('injected'); };
  err = throws(() => runMigrations());
  MIGRATIONS[10].up = step11;
  db = getDb();
  check('failing v11 throws', !!err && /v11/.test(err.message));
  check('v11 failure rolled back: still v10, no story tables', db.pragma('user_version', { simple: true }) === 10
    && STORY_TABLES.every(t => !hasTable(db, t)) && STORY_INDEXES.every(n => !hasObj(db, 'index', n)));
  check('…schema and rows unchanged', otherSchema(db, `${STORY_LIKE} AND ${INFLUENCE_LIKE}`) === v10Schema && snapshot(db).replace(/"uv":\d+,/, '') === v10Rows);
  check('v10 backup written before the failed step', backups().length === 1 && /-v10-\d{8}T\d{6}Z\.db$/.test(backups()[0]));

  r = runMigrations();
  db = getDb();
  check('retry applies exactly v11 … v13', r.from === 10 && r.to === 21 && JSON.stringify(r.applied) === '["v11-arcs","v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('user_version = 21', db.pragma('user_version', { simple: true }) === 21);
  check('all 16 story tables exist (v14 story_scenes, v15 story_messages, v16 story_thoughts, v18 story_dreams, v19 story_standing*, v20 story_check_* included)', STORY_TABLES.length === 16 && STORY_TABLES.every(t => hasTable(db, t)));
  check('story indexes exist', STORY_INDEXES.every(n => hasObj(db, 'index', n)));
  const storySql = (t) => db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).pluck().get(t) || '';
  check('every story surrogate id is AUTOINCREMENT', ['story_claim_reviews', 'story_runs', 'story_proposals', 'story_journal_parts',
    'story_narrations', 'story_refusals'].every(t => /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/.test(storySql(t))));
  check('world_events untouched by v11', !/story/.test(storySql('world_events'))
    && hasObj(db, 'trigger', 'world_events_no_delete') && hasObj(db, 'trigger', 'world_events_no_update'));
  check('nothing else in the schema changed', otherSchema(db, `${STORY_LIKE} AND ${INFLUENCE_LIKE}`) === v10Schema);
  const after11 = JSON.parse(snapshot(db));
  for (const t of [...STORY_TABLES, ...INFLUENCE_TABLES]) delete after11.counts[t];
  after11.master = after11.master.filter(m => !STORY_NAME_RE.test(m.name) && !INFLUENCE_NAME_RE.test(m.name));
  delete after11.uv;
  check('rows kept (people, world_events, life_claims, mind_state, every other table)', JSON.stringify(after11) === v10Rows);
  check('v10 backup reused within the hour', backups().length === 1 && r.backup && /-v10-/.test(r.backup));
  const bk10 = new Database(r.backup, { readonly: true });
  check('backup is the v10 database', bk10.pragma('user_version', { simple: true }) === 10 && !hasTable(bk10, 'story_runs')
    && hasTable(bk10, 'mind_runs'));
  bk10.close();
  // Constraints the store relies on (data-model §1).
  const T11 = 1_800_000_000;
  const review = (claimId) => db.prepare(`INSERT INTO story_claim_reviews (claim_id, chat_jid, origin_kind, origin_jid, status,
    created_at, expires_at) VALUES (?, ?, 'group', ?, 'pending', ?, ?)`).run(claimId, G1, G1, T11, T11 + 3600);
  check('one review per claim (UNIQUE claim_id)', !throws(() => review(1)) && !!throws(() => review(1)));
  check('review status CHECK', !!throws(() => db.prepare(`INSERT INTO story_claim_reviews (claim_id, chat_jid, origin_kind,
    origin_jid, status, created_at, expires_at) VALUES (2, ?, 'group', ?, 'bogus', 1, 2)`).run(G1, G1)));
  check('review reason CHECK (NULL or a known reason)', !!throws(() => db.prepare(`INSERT INTO story_claim_reviews (claim_id,
    chat_jid, origin_kind, origin_jid, status, reason, created_at, expires_at) VALUES (3, ?, 'group', ?, 'tray', 'nope', 1, 2)`).run(G1, G1)));
  check('review origin_kind CHECK (group|dm only)', !!throws(() => db.prepare(`INSERT INTO story_claim_reviews (claim_id, chat_jid,
    origin_kind, origin_jid, status, created_at, expires_at) VALUES (4, ?, 'self', 'self', 'pending', 1, 2)`).run(G1)));
  const part = () => db.prepare(`INSERT INTO story_journal_parts (night_key, origin_kind, origin_jid, text, sources_json, status,
    created_at) VALUES ('2026-10-30', 'self', 'self', 'x', '{}', 'active', 1)`).run();
  check('one journal part per night and origin (UNIQUE)', !throws(part) && !!throws(part));
  check('refusal reason CHECK', !!throws(() => db.prepare(`INSERT INTO story_refusals (at, source, action, reason)
    VALUES (1, 'engine', 'beat', 'because')`).run()));
  check('run kind CHECK', !!throws(() => db.prepare(`INSERT INTO story_runs (kind, caller, status, started_at)
    VALUES ('think', 'x', 'ok', 1)`).run()));
  db.exec('DELETE FROM story_claim_reviews; DELETE FROM story_journal_parts;');
  const rerun11 = snapshot(db);
  r = runMigrations();
  check('re-run on v12 is a no-op', r.applied.length === 0 && r.backup === null && snapshot(getDb()) === rerun11);
  check('the v11 step itself is re-run safe (IF NOT EXISTS)', !throws(() => getDb().transaction(() => step11(getDb()))())
    && snapshot(getDb()) === rerun11);
  db = getDb();

  // ── v11 → v12 (spec 012 chat-influence step on a DB like live) ───────────
  console.log('\nv11 → v12 (the 3 chat influence tables)');
  removeDb(); clearBackups();
  runMigrations();
  db = getDb();
  db.prepare(`INSERT INTO people (jid, push_name) VALUES ('777@lid', 'Hale')`).run();
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (1, 'test', 'engine')`).run();
  db.prepare(`INSERT INTO story_state (key, value_json, updated_at) VALUES ('x', '{}', 1)`).run();
  dropInfluence(db);
  db.pragma('user_version = 11');
  check('v11 fixture has no chat influence tables', INFLUENCE_TABLES.every(t => !hasTable(db, t)));
  const v11Schema = otherSchema(db, INFLUENCE_LIKE);
  const v11Rows = snapshot(db).replace(/"uv":\d+,/, '');
  check('apply:false reports only v12 + v13 pending', JSON.stringify(runMigrations({ apply: false }).pending) === '["v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  const step12 = MIGRATIONS[11].up;
  MIGRATIONS[11].up = (d) => { step12(d); throw new Error('injected'); };
  err = throws(() => runMigrations());
  MIGRATIONS[11].up = step12;
  db = getDb();
  check('failing v12 throws', !!err && /v12/.test(err.message));
  check('v12 failure rolled back: still v11, no chat influence tables', db.pragma('user_version', { simple: true }) === 11
    && INFLUENCE_TABLES.every(t => !hasTable(db, t)) && INFLUENCE_INDEXES.every(n => !hasObj(db, 'index', n)));
  check('…schema and rows unchanged', otherSchema(db, INFLUENCE_LIKE) === v11Schema && snapshot(db).replace(/"uv":\d+,/, '') === v11Rows);
  check('v11 backup written before the failed step', backups().length === 1 && /-v11-\d{8}T\d{6}Z\.db$/.test(backups()[0]));
  r = runMigrations();
  db = getDb();
  check('retry applies exactly v12 + v13', r.from === 11 && r.to === 21 && JSON.stringify(r.applied) === '["v12-chat-influence","v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('user_version = 21', db.pragma('user_version', { simple: true }) === 21);
  check('the 3 chat influence tables exist', INFLUENCE_TABLES.every(t => hasTable(db, t)));
  check('chat influence indexes exist', INFLUENCE_INDEXES.every(n => hasObj(db, 'index', n)));
  const infSql = (t) => db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).pluck().get(t) || '';
  check('surrogate ids are AUTOINCREMENT', ['chat_influence_items', 'chat_influence_pending_withdrawals']
    .every(t => /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/.test(infSql(t))));
  check('no message text column (pointers, codes and a hash only)', INFLUENCE_TABLES
    .every(t => cols(db, t).length && !cols(db, t).some(c => /^(content|text|excerpt|message|body)$/i.test(c))));
  check('world_events untouched by v12', !/influence/.test(infSql('world_events'))
    && hasObj(db, 'trigger', 'world_events_no_delete') && hasObj(db, 'trigger', 'world_events_no_update'));
  check('nothing else in the schema changed', otherSchema(db, INFLUENCE_LIKE) === v11Schema);
  const after12 = JSON.parse(snapshot(db));
  for (const t of INFLUENCE_TABLES) delete after12.counts[t];
  after12.master = after12.master.filter(m => !INFLUENCE_NAME_RE.test(m.name));
  delete after12.uv;
  check('rows kept (people, world_events, story_state, every other table)', JSON.stringify(after12) === v11Rows);
  const item = (over = {}) => db.prepare(`INSERT INTO chat_influence_items (kind, chat_jid, origin_kind, msg_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, 1)`).run(over.kind ?? 'mood', G1, over.origin ?? 'group', 'M1', over.status ?? 'active');
  check('item kind / origin / status CHECKs', !throws(() => item()) && !!throws(() => item({ kind: 'sick' }))
    && !!throws(() => item({ origin: 'self' })) && !!throws(() => item({ status: 'bogus' })));
  check('pending withdrawal cause CHECK', !!throws(() => db.prepare(`INSERT INTO chat_influence_pending_withdrawals
    (cause, chat_forms, msg_ids, created_at) VALUES ('purge', '[]', '[]', 1)`).run()));
  db.exec('DELETE FROM chat_influence_items;');
  const rerun12 = snapshot(db);
  r = runMigrations();
  check('re-run on v12 is a no-op (from v11)', r.applied.length === 0 && r.backup === null && snapshot(getDb()) === rerun12);
  check('the v12 step itself is re-run safe (IF NOT EXISTS)', !throws(() => getDb().transaction(() => step12(getDb()))())
    && snapshot(getDb()) === rerun12);
  db = getDb();

  // ── v12 → v13 (spec 013 public-site step on a DB like live) ─────────────
  console.log('\nv12 → v13 (the 4 public site tables)');
  const PUBLIC_TABLES = ['public_people', 'public_journal', 'public_state', 'public_votes'];
  const PUBLIC_LIKE = `name NOT GLOB 'public_*' AND name NOT GLOB 'sqlite_autoindex_public_*'`;
  const PUBLIC_NAME_RE = /^(sqlite_autoindex_)?public_/;
  removeDb(); clearBackups();
  runMigrations();
  db = getDb();
  db.prepare(`INSERT INTO people (jid, push_name) VALUES ('888@lid', 'Ivo')`).run();
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (1, 'test', 'engine')`).run();
  db.exec(PUBLIC_TABLES.map(t => `DROP TABLE ${t};`).join(' '));
  db.pragma('user_version = 12');
  check('v12 fixture has no public tables', PUBLIC_TABLES.every(t => !hasTable(db, t)));
  const v12Schema = otherSchema(db, PUBLIC_LIKE);
  const v12Rows = snapshot(db).replace(/"uv":\d+,/, '');
  check('apply:false reports only v13 + v14 pending', JSON.stringify(runMigrations({ apply: false }).pending) === '["v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  const step13 = MIGRATIONS[12].up;
  MIGRATIONS[12].up = (d) => { step13(d); throw new Error('injected'); };
  err = throws(() => runMigrations());
  MIGRATIONS[12].up = step13;
  db = getDb();
  check('failing v13 throws', !!err && /v13/.test(err.message));
  check('v13 failure rolled back: still v12, no public tables', db.pragma('user_version', { simple: true }) === 12
    && PUBLIC_TABLES.every(t => !hasTable(db, t)));
  check('…schema and rows unchanged', otherSchema(db, PUBLIC_LIKE) === v12Schema && snapshot(db).replace(/"uv":\d+,/, '') === v12Rows);
  check('v12 backup written before the failed step', backups().length === 1 && /-v12-\d{8}T\d{6}Z\.db$/.test(backups()[0]));
  r = runMigrations();
  db = getDb();
  check('retry applies exactly v13 + v14', r.from === 12 && r.to === 21 && JSON.stringify(r.applied) === '["v13-public-site","v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('user_version = 21', db.pragma('user_version', { simple: true }) === 21);
  check('the 4 public tables exist', PUBLIC_TABLES.every(t => hasTable(db, t)));
  check('no chat text column (only the published journal text)', PUBLIC_TABLES
    .every(t => cols(db, t).length && !cols(db, t).some(c => /^(content|excerpt|message|body|msg_id|chat_jid)$/i.test(c)))
    && !cols(db, 'public_people').includes('text'));
  check('nothing else in the schema changed', otherSchema(db, PUBLIC_LIKE) === v12Schema);
  const after13 = JSON.parse(snapshot(db));
  for (const t of PUBLIC_TABLES) delete after13.counts[t];
  after13.master = after13.master.filter(m => !PUBLIC_NAME_RE.test(m.name));
  delete after13.uv;
  check('rows kept (people, world_events, every other table)', JSON.stringify(after13) === v12Rows);
  check('opted_in CHECK + vote count CHECK', !!throws(() => db.prepare(`INSERT INTO public_people (person_jid, public_id, display_name, opted_in, updated_at) VALUES ('x@lid', 'f_1', 'X', 2, 1)`).run())
    && !!throws(() => db.prepare(`INSERT INTO public_votes (decision_id, option_id, count, pulled_at) VALUES (1, 'go', -1, 1)`).run()));
  const rerun13 = snapshot(db);
  r = runMigrations();
  check('re-run on v13 is a no-op', r.applied.length === 0 && r.backup === null && snapshot(getDb()) === rerun13);
  check('the v13 step itself is re-run safe (IF NOT EXISTS)', !throws(() => getDb().transaction(() => step13(getDb()))())
    && snapshot(getDb()) === rerun13);
  db = getDb();

  // ── v13 → v14 (spec 016 scenes step) ─────────────────────────────────────
  console.log('\nv13 → v14 (story_scenes)');
  removeDb(); clearBackups();
  runMigrations();
  db = getDb();
  db.prepare(`INSERT INTO people (jid, push_name) VALUES ('999@lid', 'Jo')`).run();
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (1, 'test', 'engine')`).run();
  db.exec('DROP TABLE story_scenes;');
  db.pragma('user_version = 13');
  const SCENE_LIKE = `name != 'story_scenes' AND name NOT GLOB 'idx_story_scenes_*' AND name NOT GLOB 'sqlite_autoindex_story_scenes_*'`;
  check('v13 fixture has no story_scenes', !hasTable(db, 'story_scenes'));
  const v13Schema = otherSchema(db, SCENE_LIKE);
  const v13Rows = snapshot(db).replace(/"uv":\d+,/, '');
  check('apply:false reports only v14 pending', JSON.stringify(runMigrations({ apply: false }).pending) === '["v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  const step14 = MIGRATIONS[13].up;
  MIGRATIONS[13].up = (d) => { step14(d); throw new Error('injected'); };
  err = throws(() => runMigrations());
  MIGRATIONS[13].up = step14;
  db = getDb();
  check('failing v14 throws', !!err && /v14/.test(err.message));
  check('v14 failure rolled back: still v13, no story_scenes', db.pragma('user_version', { simple: true }) === 13 && !hasTable(db, 'story_scenes'));
  check('…schema and rows unchanged', otherSchema(db, SCENE_LIKE) === v13Schema && snapshot(db).replace(/"uv":\d+,/, '') === v13Rows);
  check('v13 backup written before the failed step (0600)', backups().length === 1 && /-v13-\d{8}T\d{6}Z\.db$/.test(backups()[0])
    && (fs.statSync(path.join(backupDir, backups()[0])).mode & 0o777) === 0o600);
  r = runMigrations();
  db = getDb();
  check('retry applies exactly v14 (+ v15)', r.from === 13 && r.to === 21 && JSON.stringify(r.applied) === '["v14-scenes","v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('story_scenes + its indexes exist', hasTable(db, 'story_scenes') && hasObj(db, 'index', 'idx_story_scenes_event')
    && hasObj(db, 'index', 'idx_story_scenes_subject'));
  check('no chat text column', !cols(db, 'story_scenes').some(c => /^(content|excerpt|message|body|msg_id|chat_jid)$/i.test(c)));
  check('nothing else in the schema changed', otherSchema(db, SCENE_LIKE) === v13Schema);
  check('status CHECK + (activity, version) UNIQUE', !!throws(() => db.prepare(`INSERT INTO story_scenes (activity_event_id, version, status, ended_at, created_at) VALUES (1, 1, 'bogus', 1, 1)`).run())
    && !throws(() => db.prepare(`INSERT INTO story_scenes (activity_event_id, version, status, ended_at, created_at) VALUES (1, 1, 'pending', 1, 1)`).run())
    && !!throws(() => db.prepare(`INSERT INTO story_scenes (activity_event_id, version, status, ended_at, created_at) VALUES (1, 1, 'pending', 1, 1)`).run()));
  db.prepare('DELETE FROM story_scenes').run();
  const rerun14 = snapshot(db);
  r = runMigrations();
  check('re-run on v14 is a no-op', r.applied.length === 0 && r.backup === null && snapshot(getDb()) === rerun14);
  check('the v14 step itself is re-run safe (IF NOT EXISTS)', !throws(() => getDb().transaction(() => step14(getDb()))())
    && snapshot(getDb()) === rerun14);
  db = getDb();

  // ── v14 → v15 (spec 019 phone step) ──────────────────────────────────────
  console.log('\nv14 → v15 (story_messages)');
  removeDb(); clearBackups();
  runMigrations();
  db = getDb();
  db.prepare(`INSERT INTO people (jid, push_name) VALUES ('999@lid', 'Jo')`).run();
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (1, 'test', 'engine')`).run();
  db.exec('DROP TABLE story_messages;');
  db.pragma('user_version = 14');
  const MSG_LIKE = `name != 'story_messages' AND name NOT GLOB 'idx_story_messages_*' AND name NOT GLOB 'sqlite_autoindex_story_messages_*'`;
  check('v14 fixture has no story_messages', !hasTable(db, 'story_messages'));
  const v14Schema = otherSchema(db, MSG_LIKE);
  const v14Rows = snapshot(db).replace(/"uv":\d+,/, '');
  check('apply:false reports only v15 pending', JSON.stringify(runMigrations({ apply: false }).pending) === '["v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  const step15 = MIGRATIONS[14].up;
  MIGRATIONS[14].up = (d) => { step15(d); throw new Error('injected'); };
  err = throws(() => runMigrations());
  MIGRATIONS[14].up = step15;
  db = getDb();
  check('failing v15 throws', !!err && /v15/.test(err.message));
  check('v15 failure rolled back: still v14, no story_messages', db.pragma('user_version', { simple: true }) === 14 && !hasTable(db, 'story_messages'));
  check('…schema and rows unchanged', otherSchema(db, MSG_LIKE) === v14Schema && snapshot(db).replace(/"uv":\d+,/, '') === v14Rows);
  check('v14 backup written before the failed step (0600)', backups().length === 1 && /-v14-\d{8}T\d{6}Z\.db$/.test(backups()[0])
    && (fs.statSync(path.join(backupDir, backups()[0])).mode & 0o777) === 0o600);
  r = runMigrations();
  db = getDb();
  check('retry applies exactly v15', r.from === 14 && r.to === 21 && JSON.stringify(r.applied) === '["v15-phone","v16-thoughts","v17-stance","v18-dreams","v19-standing","v20-claim-check","v21-weekly-review"]');
  check('story_messages + its indexes exist', hasTable(db, 'story_messages') && hasObj(db, 'index', 'idx_story_messages_cast')
    && hasObj(db, 'index', 'idx_story_messages_status') && hasObj(db, 'index', 'idx_story_messages_event') && hasObj(db, 'index', 'idx_story_messages_trigger'));
  check('no chat text column', !cols(db, 'story_messages').some(c => /^(content|excerpt|message|body|msg_id|chat_jid|origin_jid|subject_jid)$/i.test(c)));
  check('nothing else in the schema changed', otherSchema(db, MSG_LIKE) === v14Schema);
  const ins = (st, dir = 'out', trig = 1) => () => db.prepare(`INSERT INTO story_messages (cast_id, dir, status, trigger, trigger_event_id, due_at, created_at) VALUES ('cast:a', ?, ?, 'owner', ?, 1, 1)`).run(dir, st, trig);
  check('status / dir CHECKs + one row per trigger', !!throws(ins('bogus')) && !!throws(ins('pending', 'sideways'))
    && !throws(ins('pending')) && !!throws(ins('pending')) && !throws(ins('pending', 'out', 2)));
  db.prepare('DELETE FROM story_messages').run();
  const rerun15 = snapshot(db);
  r = runMigrations();
  check('re-run on v15 is a no-op', r.applied.length === 0 && r.backup === null && snapshot(getDb()) === rerun15);
  check('the v15 step itself is re-run safe (IF NOT EXISTS)', !throws(() => getDb().transaction(() => step15(getDb()))())
    && snapshot(getDb()) === rerun15);
  db = getDb();

  console.log('\nNewer schema');
  db.prepare('DROP TABLE topics').run();   // a "future" step removed a v0 table
  db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
  const newer = snapshot(db);
  check('refuses a DB newer than the code', !!throws(() => runMigrations()) && !!throws(assertSchemaCurrent));
  check('…without touching it (no schema.sql re-run)', snapshot(getDb()) === newer);
} catch (err) {
  failures++;
  console.log(`  ✗ unexpected error: ${err.stack || err.message}`);
} finally {
  closeDb();
  fs.rmSync(scratchAbs, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} migration check(s) FAILED` : '\nAll migration checks passed');
process.exit(failures ? 1 : 0);
