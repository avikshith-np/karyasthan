// What update, backup and uninstall all need to know about an install. Reads settings the way
// doctor does, never through src/utils/config.js, so a broken .env can't stop them running.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseEnv } from './lib.js';

const require = createRequire(import.meta.url);

/** The gitignored files that make the character yours. */
export const CHARACTER_FILES = ['persona.json', 'identity.md', 'world.json', 'arcs.json', 'taste.json', 'phrases.json'];

export function installPaths(root) {
  const envPath = path.join(root, '.env');
  let env = {};
  try { env = parseEnv(fs.readFileSync(envPath, 'utf-8')); } catch { /* no settings yet */ }
  const dbPath = path.resolve(root, env.DB_PATH || './data/karyasthan.db');
  const dataDir = path.join(root, 'data');
  return {
    root, envPath, env, dataDir, dbPath,
    authPath: path.resolve(root, env.AUTH_PATH || './data/auth_info_baileys'),
    backupsDir: path.join(dataDir, 'backups'),
    personalityDir: path.join(root, 'src', 'personality'),
    // The bot keeps its lock beside the database; pair.js and first-check beside data/.
    lockDirs: [...new Set([path.dirname(dbPath), dataDir])],
  };
}

/** Strictly inside: the folder itself doesn't count. */
export function isInside(root, p) {
  const rel = path.relative(root, p);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A variable like GIT_DIR, set by a hook, would point git at some other repo. */
export function git(root, ...args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', env, timeout: 180000 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * { checkout, branch }. A folder inside some other repo isn't a checkout of this project, and
 * a detached HEAD has no branch. Whoever needs `main` then refuses, so this fails closed.
 */
export function checkoutFacts(root) {
  const top = git(root, 'rev-parse', '--show-toplevel');
  if (!top.ok) return { checkout: false, branch: '' };
  let same = false;
  try { same = fs.realpathSync(top.out) === fs.realpathSync(root); } catch { /* gone */ }
  if (!same) return { checkout: false, branch: '' };
  const b = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  return { checkout: true, branch: b.ok ? b.out : '' };
}

export const stamp = (at = new Date()) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Quoted for a line someone will paste into a shell. */
export const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** In a child, so a failed load here doesn't stick in this process after a rebuild. */
export function sqliteLoads(root) {
  const code = 'const D = require("better-sqlite3"); new D(":memory:").close();';
  return spawnSync(process.execPath, ['-e', code], { cwd: root, stdio: 'ignore', timeout: 30000 }).status === 0;
}

/** The database's schema version, or null when there's none or it can't be read. */
export function dbVersion(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    try { return db.pragma('user_version', { simple: true }); } finally { db.close(); }
  } catch { return null; }
}

/** A consistent private copy, whether or not the bot is running. A failed copy leaves nothing. */
export function vacuumInto(dbPath, target) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10000 });
  try {
    db.prepare('VACUUM INTO ?').run(target);
    fs.chmodSync(target, 0o600);
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  } finally { db.close(); }
}

/** Folder 0700, made if needed. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}
