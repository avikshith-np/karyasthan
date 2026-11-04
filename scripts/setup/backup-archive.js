// One tar.gz of what makes an install yours, and putting one back. Used by scripts/backup.js and
// scripts/uninstall.js. The tar command does the packing, so nothing new is needed to read a
// backup later; everything is staged first, because the bot keeps writing its session while it
// runs and tar treats a file changing under it as an error.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CHARACTER_FILES, installPaths, isInside, git, stamp, dbVersion, vacuumInto, ensurePrivateDir,
} from './day-two.js';
import { holderOf } from './running.js';
import { migrationFiles, latestVersion } from './update-plan.js';

export const MANIFEST = 'karyasthan-backup.json';
// Beside the listed files: warmup.json, or a restored number starts its warmup again at day 1,
// and llm-models.json, the models added on the dashboard.
const DATA_FILES = ['llm-prices.json', 'warmup.json', 'llm-models.json'];
const DEFAULT_DB = 'data/karyasthan.db';
const DEFAULT_SESSION = 'data/auth_info_baileys';

const posix = (p) => p.split(path.sep).join('/');

/** Where a path goes in the archive: as it is under data/, else the default place. */
function archiveName(root, p, fallback) {
  return isInside(path.join(root, 'data'), p) ? posix(path.relative(root, p)) : fallback;
}

function copyPrivate(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o600);
}

/** Regular files and folders only. A file the running bot removes meanwhile is simply gone. */
function copySession(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try {
      const st = fs.lstatSync(src);
      if (st.isDirectory()) copySession(src, dst);
      else if (st.isFile()) copyPrivate(src, dst);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

function workDir(I) {
  return ensurePrivateDir(path.join(ensurePrivateDir(I.backupsDir), `.work-${process.pid}-${Date.now()}`));
}

/**
 * Writes one tar.gz into outDir (default data/backups), mode 0600.
 * → { file, included: [words], missing: [words], notes: [words] }. Throws when it can't.
 */
export function createBackup({ root, outDir = null }) {
  const I = installPaths(root);
  // A folder given by the caller keeps its own mode; only the file itself is private.
  const target = outDir || ensurePrivateDir(I.backupsDir);
  const included = []; const missing = []; const notes = [];
  const work = workDir(I);
  try {
    if (fs.existsSync(I.envPath)) { copyPrivate(I.envPath, path.join(work, '.env')); included.push('.env'); } else missing.push('.env');

    if (fs.existsSync(I.dbPath)) {
      const name = archiveName(root, I.dbPath, DEFAULT_DB);
      fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true, mode: 0o700 });
      vacuumInto(I.dbPath, path.join(work, name));
      included.push('the database');
      if (name === DEFAULT_DB && !isInside(I.dataDir, I.dbPath)) notes.push(`DB_PATH points outside data/. A restore puts the database at ${DEFAULT_DB}.`);
    } else missing.push('the database');

    if (fs.existsSync(I.authPath)) {
      const name = archiveName(root, I.authPath, DEFAULT_SESSION);
      copySession(I.authPath, path.join(work, name));
      included.push('the WhatsApp session');
      if (name === DEFAULT_SESSION && !isInside(I.dataDir, I.authPath)) notes.push(`AUTH_PATH points outside data/. A restore puts the session at ${DEFAULT_SESSION}.`);
      try {
        JSON.parse(fs.readFileSync(path.join(work, name, 'creds.json'), 'utf-8'));
      } catch (err) {
        if (err.code !== 'ENOENT') notes.push('The session was being written just then. Run this again if you\'ll rely on this backup.');
      }
    } else missing.push('the WhatsApp session');

    for (const f of DATA_FILES) {
      const p = path.join(I.dataDir, f);
      if (fs.existsSync(p)) { copyPrivate(p, path.join(work, 'data', f)); included.push(`data/${f}`); }
    }
    for (const f of CHARACTER_FILES) {
      const p = path.join(I.personalityDir, f);
      if (fs.existsSync(p)) { copyPrivate(p, path.join(work, 'src/personality', f)); included.push(`src/personality/${f}`); }
    }
    if (!included.length) throw new Error('There\'s nothing here to back up yet.');

    const commit = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(work, MANIFEST), `${JSON.stringify({
      kind: 'karyasthan-backup',
      v: 1,
      at: new Date().toISOString(),
      commit: commit.ok ? commit.out : null,
      schema: fs.existsSync(I.dbPath) ? dbVersion(I.dbPath) : null,
    }, null, 2)}\n`, { mode: 0o600 });

    const names = fs.readdirSync(work);
    const file = path.join(target, `karyasthan-backup-${stamp()}.tar.gz`);
    const tmp = `${file}.tmp-${process.pid}`;
    const r = spawnSync('tar', ['-czf', tmp, '-C', work, ...names], {
      encoding: 'utf-8', env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    if (r.status !== 0) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`tar failed: ${(r.error?.message || r.stderr || '').trim().slice(0, 200)}`);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return { file, included, missing, notes };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ── Reading one back ──────────────────────────────────────────────────────────

const DIR_ONLY = new Set(['data', 'src', 'src/personality']);
const isAllowedPath = (name) => {
  if (name === MANIFEST || name === '.env' || DIR_ONLY.has(name)) return true;
  // Its own work folder lives in data/backups, and a lock isn't a thing to restore.
  if (/^data\/(backups|\.instance-lock)(\/|$)/.test(name)) return false;
  return name.startsWith('data/') || (name.startsWith('src/personality/') && CHARACTER_FILES.includes(name.slice('src/personality/'.length)));
};
const cleanName = (raw) => String(raw).replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/**
 * Checks what a tarball would write, before anything is extracted. entries: [{ name, type }] with
 * type from `tar -tv`: '-' file, 'd' folder, anything else a link or a device.
 * → { ok, bad: [{ name, why }] }. A file inside the project can still be code, so only what a
 * backup holds gets through: a planted src/index.js or .git/hooks/* is refused too.
 */
export function checkEntries(entries) {
  const bad = [];
  for (const { name: raw, type } of entries) {
    const name = cleanName(raw);
    const flag = (why) => bad.push({ name: String(raw).replace(/[^\x20-\x7e]/g, '?').slice(0, 120), why });
    if (name === '' || name === '.') continue;
    if (String(raw).startsWith('/')) flag('an absolute path');
    else if (/[\x00-\x1f\\]/.test(name)) flag('a strange name');
    else if (name.split('/').includes('..')) flag('a path outside the project');
    else if (type !== '-' && type !== 'd') flag(type === 'l' || type === 'h' ? 'a link' : 'not a plain file');
    else if (!isAllowedPath(name)) flag('not something a backup holds');
    else if (DIR_ONLY.has(name) ? type !== 'd' : (!name.startsWith('data/') && type !== '-')) flag('not something a backup holds');
  }
  return { ok: bad.length === 0, bad };
}

/** What the tar command says is in this file, or null if it can't read it. -P: names as stored. */
export function listEntries(file) {
  const names = spawnSync('tar', ['-tPzf', file], { encoding: 'utf-8', maxBuffer: 1 << 28 });
  const long = spawnSync('tar', ['-tPzvf', file], { encoding: 'utf-8', maxBuffer: 1 << 28 });
  if (names.status !== 0 || long.status !== 0) return null;
  const n = names.stdout.split('\n').filter(Boolean);
  const l = long.stdout.split('\n').filter(Boolean);
  if (n.length !== l.length) return null;
  return n.map((name, i) => ({ name, type: l[i][0] }));
}

/** No leftover but the staged copy: file and folder only, and only what the check allowed. */
function walkAndSeal(dir, base = dir) {
  const bad = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = posix(path.relative(base, p));
    const st = fs.lstatSync(p);
    if (!isAllowedPath(rel) || !(st.isFile() || st.isDirectory())) { bad.push(rel); continue; }
    if (st.isDirectory()) { fs.chmodSync(p, 0o700); bad.push(...walkAndSeal(p, base)); } else fs.chmodSync(p, 0o600);
  }
  return bad;
}

const asideSuffix = () => `old-${new Date().toISOString().slice(0, 10)}-${Date.now() % 100000}`;

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Never deletes. Character files keep the .bak. name the repo ignores, or they'd show up in git. */
function moveAside(p, suffix) {
  const to = path.dirname(p).endsWith(`${path.sep}personality`) ? `${p}.bak.${suffix}` : `${p}.${suffix}`;
  move(p, to);
  return to;
}

/**
 * Puts a backup in place. Refusals don't throw: { refused: 'words', bad? }.
 * → { restored: [names], asideMoved: [paths], warnings: [words] }.
 */
export function restoreBackup({ root, file, force = false }) {
  const I = installPaths(root);
  const holder = holderOf(I.lockDirs);
  if (holder) return { refused: `A copy is running here (pid ${holder.pid}). Stop it first. --force doesn't change this.` };
  if (!fs.existsSync(file)) return { refused: 'There\'s no such file.' };

  const entries = listEntries(file);
  if (!entries) return { refused: 'That can\'t be read as a tar.gz.' };
  const check = checkEntries(entries);
  if (!check.ok) return { refused: 'That file isn\'t a safe backup, so nothing was extracted.', bad: check.bad };
  const clean = entries.map((e) => ({ name: cleanName(e.name), type: e.type })).filter((e) => e.name && e.name !== '.');
  const has = (n) => clean.some((e) => e.name === n);
  if (!has(MANIFEST) && !has('.env')) return { refused: 'That doesn\'t look like a backup from npm run backup.' };

  // What this would land on: .env, a character file, or one thing under data/ (a session folder moves whole).
  const targets = new Set();
  for (const e of clean) {
    if (e.name === MANIFEST) continue;
    if (e.name.startsWith('data/')) targets.add(e.name.split('/').slice(0, 2).join('/'));
    else if (e.type !== 'd') targets.add(e.name);
  }
  const isStateTarget = (t) => t.startsWith('data/') && (/\.db$/.test(t) || clean.some((e) => e.name === t && e.type === 'd'));
  const inWay = new Set();
  for (const p of [I.dbPath, I.authPath]) if (fs.existsSync(p)) inWay.add(p);
  for (const t of targets) if (isStateTarget(t) && fs.existsSync(path.join(root, t))) inWay.add(path.join(root, t));
  if (inWay.size && !force) {
    const names = [...inWay].map((p) => (isInside(root, p) ? posix(path.relative(root, p)) : p));
    return { refused: `A session or database is already here: ${names.join(', ')}. Add --force to move them aside (nothing is deleted).` };
  }

  const work = workDir(I);
  try {
    const x = spawnSync('tar', ['-xzf', file, '-C', work, '--no-same-owner'], { encoding: 'utf-8' });
    if (x.status !== 0) return { refused: `Extracting failed, so nothing was changed: ${(x.stderr || '').trim().slice(0, 200)}` };
    const bad = walkAndSeal(work);
    if (bad.length) return { refused: 'That file isn\'t a safe backup, so nothing was put in place.', bad: bad.slice(0, 5).map((name) => ({ name, why: 'not something a backup holds' })) };

    const warnings = [];
    let schema = null;
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(work, MANIFEST), 'utf-8')); } catch { /* optional */ }
    const dbEntry = clean.find((e) => e.type === '-' && /\.db$/.test(e.name));
    if (dbEntry) schema = dbVersion(path.join(work, dbEntry.name));

    const suffix = asideSuffix();
    const asideMoved = [];
    const aside = (p) => {
      if (!fs.existsSync(p)) return;
      const to = moveAside(p, suffix);
      asideMoved.push(to);
      // A database's write-ahead files would corrupt the restored one. Beside the old copy they
      // keep their meaning: that name's -wal is that copy's.
      for (const s of ['-wal', '-shm']) {
        if (fs.existsSync(`${p}${s}`)) { move(`${p}${s}`, `${to}${s}`); asideMoved.push(`${to}${s}`); }
      }
    };
    for (const p of inWay) aside(p);
    for (const t of targets) {
      const dest = path.join(root, t);
      aside(dest);
      move(path.join(work, t), dest);
    }
    ensurePrivateDir(I.dataDir);

    const after = installPaths(root);
    if (targets.has(DEFAULT_DB) && after.dbPath !== path.join(root, DEFAULT_DB)) warnings.push(`The database is at ${DEFAULT_DB}, but DB_PATH in .env points elsewhere. Fix one of them.`);
    if (targets.has(DEFAULT_SESSION) && after.authPath !== path.join(root, DEFAULT_SESSION)) warnings.push(`The session is at ${DEFAULT_SESSION}, but AUTH_PATH in .env points elsewhere. Fix one of them.`);
    const codeLatest = latestMigration(root);
    if (schema != null && codeLatest && schema > codeLatest) warnings.push(`This database is newer (v${schema}) than this code (v${codeLatest}), and the bot will refuse it. Run npm run update first.`);
    return { restored: [...targets], asideMoved, warnings, manifest, schema };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function latestMigration(root) {
  try { return latestVersion(migrationFiles(fs.readdirSync(path.join(root, 'src/memory/migrations')))); } catch { return 0; }
}
