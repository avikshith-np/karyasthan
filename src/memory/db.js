import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../utils/config.js';
import { safePath } from '../utils/pathGuard.js';
import { logger } from '../utils/logger.js';
import { MIGRATIONS } from './migrations/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = safePath(config.dbPath);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  logger.info({ dbPath }, 'Database connected');
  return db;
}

// Schema = frozen v0 baseline (schema.sql) + the versioned ladder in ./migrations
// (spec 006, R12). Boot (src/index.js) and `scripts/migrate.js --apply` are the only
// callers that apply; every other script calls assertSchemaCurrent().
//
//   exec(schema.sql) → legacy idempotent ALTERs → backup → step v(n+1) … v(latest)
//
// Each step runs in one transaction that also sets user_version, so a failure
// leaves the database at the previous version. Steps that rebuild tables run
// with foreign_keys OFF (it is a no-op inside a transaction, so it is set before
// BEGIN) plus a foreign_key_check on the rebuilt tables before COMMIT.
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

const BACKUP_DEDUPE_SEC = 3600;

function readUserVersion(database) {
  return database.pragma('user_version', { simple: true });
}

function pendingSteps(version) {
  return MIGRATIONS.filter(m => m.version > version);
}

function checkLadderShape() {
  MIGRATIONS.forEach((m, i) => {
    if (m.version !== i + 1 || typeof m.up !== 'function') {
      throw new Error(`Migration ladder is malformed at index ${i} (${m.name || '?'})`);
    }
  });
}

// VACUUM INTO a timestamped copy next to the database (data/backups/ for the live
// DB). Directory 0700, file 0600. Skipped if a backup of the same source version
// was written within the last hour, so a pm2 restart loop doesn't fill the disk.
function backupBeforeMigrating(database, dbPath, fromVersion) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const base = path.basename(dbPath).replace(/\.db$/i, '') || 'db';
  const prefix = `${base}-v${fromVersion}-`;
  const cutoff = Date.now() - BACKUP_DEDUPE_SEC * 1000;
  const recent = fs.readdirSync(dir).find(f => f.startsWith(prefix) && f.endsWith('.db')
    && fs.statSync(path.join(dir, f)).mtimeMs >= cutoff);
  if (recent) {
    logger.info({ backup: path.join(dir, recent) }, 'Migration backup: recent backup reused');
    return path.join(dir, recent);
  }

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = path.join(dir, `${prefix}${ts}.db`);
  database.prepare('VACUUM INTO ?').run(target);
  fs.chmodSync(target, 0o600);
  logger.info({ backup: target }, 'Migration backup written');
  return target;
}

function applyStep(database, step) {
  const rebuild = Array.isArray(step.rebuild) && step.rebuild.length > 0;
  if (rebuild) database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      step.up(database);
      if (rebuild) {
        for (const table of step.rebuild) {
          const bad = database.pragma(`foreign_key_check(${table})`);
          if (bad.length) throw new Error(`foreign_key_check failed on ${table}: ${bad.length} row(s)`);
        }
      }
      database.pragma(`user_version = ${step.version}`);
    })();
  } finally {
    if (rebuild) database.pragma('foreign_keys = ON');
  }
}

/**
 * Bring the database to LATEST_SCHEMA_VERSION. Synchronous.
 * `apply: false` only reports — it touches nothing (no schema.sql, no ALTERs).
 * Throws (after a fatal log) if a step fails; the failed step is rolled back.
 * @returns {{ from: number, to: number, applied: string[], pending: string[], backup: string|null }}
 */
export function runMigrations({ apply = true } = {}) {
  checkLadderShape();
  const database = getDb();

  if (!apply) {
    const from = readUserVersion(database);
    const pending = pendingSteps(from).map(m => `v${m.version}-${m.name}`);
    return { from, to: from, applied: [], pending, backup: null };
  }

  // Refuse a database written by newer code before touching it (rolled-back deploy).
  const found = readUserVersion(database);
  if (found > LATEST_SCHEMA_VERSION) {
    const err = new Error(`Database schema v${found} is newer than this code (v${LATEST_SCHEMA_VERSION}) — refusing to start`);
    logger.fatal({ from: found, latest: LATEST_SCHEMA_VERSION }, err.message);
    throw err;
  }

  const dbPath = safePath(config.dbPath);
  const hadTables = database.prepare(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'`).pluck().get() > 0;

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // Execute the entire schema at once — better-sqlite3's exec() handles multiple statements
  database.exec(schema);

  // Idempotent column adds for pre-existing databases. CREATE TABLE IF NOT EXISTS is a
  // no-op on an existing table, so new columns must be ALTERed in explicitly.
  const msgCols = database.prepare('PRAGMA table_info(messages)').all();
  if (!msgCols.some(c => c.name === 'quoted_participant')) {
    database.exec('ALTER TABLE messages ADD COLUMN quoted_participant TEXT');
    logger.info('Migration: added messages.quoted_participant column');
  }

  const imitCols = database.prepare('PRAGMA table_info(group_imitation)').all();
  for (const [col, ddl] of [
    ['use_voice', 'ALTER TABLE group_imitation ADD COLUMN use_voice INTEGER DEFAULT 0'],
    ['voice_notes_sent', 'ALTER TABLE group_imitation ADD COLUMN voice_notes_sent INTEGER DEFAULT 0'],
  ]) {
    if (!imitCols.some(c => c.name === col)) {
      database.exec(ddl);
      logger.info(`Migration: added group_imitation.${col} column`);
    }
  }

  const igSessCols = database.prepare('PRAGMA table_info(ig_sessions)').all();
  if (!igSessCols.some(c => c.name === 'live_tokens')) {
    database.exec('ALTER TABLE ig_sessions ADD COLUMN live_tokens INTEGER');
    logger.info('Migration: added ig_sessions.live_tokens column');
  }

  // ── Versioned ladder ──────────────────────────────────────────────────────
  const from = readUserVersion(database);
  const steps = pendingSteps(from);
  const applied = [];
  let backup = null;

  if (steps.length) {
    // A brand-new database has nothing to lose; everything else is copied first.
    if (hadTables) {
      try {
        backup = backupBeforeMigrating(database, dbPath, from);
      } catch (err) {
        logger.fatal({ err: err.message }, 'Migration backup failed — refusing to migrate');
        throw err;
      }
    }
    for (const step of steps) {
      const t0 = Date.now();
      try {
        applyStep(database, step);
      } catch (err) {
        logger.fatal({ step: step.version, name: step.name, err: err.message, backup },
          'Migration step failed — rolled back, refusing to start');
        throw new Error(`Migration v${step.version} (${step.name}) failed: ${err.message}`, { cause: err });
      }
      applied.push(`v${step.version}-${step.name}`);
      logger.info({ step: step.version, name: step.name, ms: Date.now() - t0 }, 'Migration step applied');
    }
  }

  logger.info({ version: readUserVersion(database), applied: applied.length }, 'Database migrations complete');
  return { from, to: readUserVersion(database), applied, pending: [], backup };
}

/**
 * For scripts that must never migrate (FR-026): throws unless the database file
 * exists and is at LATEST_SCHEMA_VERSION. Never creates a database file.
 */
export function assertSchemaCurrent() {
  const dbPath = safePath(config.dbPath);
  if (!db && !fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath} — start the bot once or run: node scripts/migrate.js --apply`);
  }
  const version = readUserVersion(getDb());
  if (version !== LATEST_SCHEMA_VERSION) {
    const pending = pendingSteps(version).map(m => `v${m.version}-${m.name}`);
    throw new Error(version > LATEST_SCHEMA_VERSION
      ? `Database schema v${version} is newer than this code (v${LATEST_SCHEMA_VERSION})`
      : `Database schema is v${version}, code expects v${LATEST_SCHEMA_VERSION} (pending: ${pending.join(', ')}) — `
        + 'start the bot or run: node scripts/migrate.js --apply');
  }
  return version;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}
