#!/usr/bin/env node
// npm run update: new code on main, safely. Refuses anything but a clean main that can
// fast-forward. Backs up first, then stops the bot, pulls, reinstalls packages if they changed,
// and starts it again. If any of that fails, the code and packages go back. The database never
// goes back by itself, because that would lose messages: if it was already upgraded, the exact
// steps are printed for a person to choose.
//
//   npm run update           asks first
//   npm run update -- --yes  doesn't; needed when there's no terminal
//
// Exit codes: 0 updated or nothing new, 1 failed (and put back), 2 refused, 130 stopped by the user.
//
// Everything this needs after the pull is loaded before it: the files on disk change under it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUi, Interrupted, openTerminal } from './setup/ui.js';
import {
  installPaths, git, checkoutFacts, stamp, shellQuote, sqliteLoads, dbVersion, vacuumInto, ensurePrivateDir,
} from './setup/day-two.js';
import {
  refusal, migrationFiles, latestVersion, migrationPlan, describeUpdate, oldCodeRefuses, restoreSteps,
  oldUpdateBackups, KEEP_UPDATE_BACKUPS,
} from './setup/update-plan.js';
import {
  managerOf, stopManaged, startManaged, startWords, holderOf, waitGone, waitSteady,
} from './setup/running.js';

process.umask(0o077);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I = installPaths(ROOT);
const YES = process.argv.includes('--yes') || process.argv.includes('-y');
const WAIT_MS = Number(process.env.KARYASTHAN_UPDATE_WAIT_MS) || 30000;
const STEADY_MS = Math.min(5000, Math.floor(WAIT_MS / 3));

const say = (s = '') => console.log(s ? `  ${s}` : '');

function refuse(words) {
  say();
  say(`✗ ${words}`);
  say();
  return 2;
}

const migrationsAt = (rev) => {
  const r = git(ROOT, 'ls-tree', '--name-only', rev, 'src/memory/migrations/');
  return r.ok ? migrationFiles(r.out.split('\n')) : [];
};
const lockChanged = (a, b) => !git(ROOT, 'diff', '--quiet', a, b, '--', 'package-lock.json').ok;

function npmCi() {
  say('Installing packages…');
  return spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'ignore', timeout: 600000 }).status === 0;
}

/** After a Node major change the compiled SQLite won't load. True when it loads, rebuilt if it had to be. */
function sqliteReady() {
  if (sqliteLoads(ROOT)) return true;
  say('SQLite doesn\'t load, usually after a change of Node version. Rebuilding it…');
  spawnSync('npm', ['rebuild', 'better-sqlite3'], { cwd: ROOT, stdio: 'ignore', timeout: 600000 });
  return sqliteLoads(ROOT);
}

/** After a good update only: a failed one may still need every backup it can find. */
function pruneOldBackups() {
  let removed = 0;
  try {
    for (const name of oldUpdateBackups(fs.readdirSync(I.backupsDir))) {
      const p = path.join(I.backupsDir, name);
      if (!fs.lstatSync(p).isDirectory()) continue;   // a link or a file with that name isn't ours
      fs.rmSync(p, { recursive: true, force: true });
      removed += 1;
    }
  } catch (err) { say(`! Couldn't clear old update backups: ${err.message}`); }
  if (removed) say(`Removed ${removed} older update backup${removed === 1 ? '' : 's'}, keeping the newest ${KEEP_UPDATE_BACKUPS}.`);
}

/** data/backups/update-<time>/: the database, .env and the commit it's going back to. */
function backUp(oldCommit) {
  const dir = path.join(ensurePrivateDir(I.backupsDir), `update-${stamp()}`);
  ensurePrivateDir(dir);
  fs.writeFileSync(path.join(dir, 'commit'), `${oldCommit}\n`, { mode: 0o600 });
  if (fs.existsSync(I.envPath)) {
    fs.copyFileSync(I.envPath, path.join(dir, '.env'));
    fs.chmodSync(path.join(dir, '.env'), 0o600);
  }
  let db = null;
  if (fs.existsSync(I.dbPath)) {
    db = path.join(dir, path.basename(I.dbPath));
    vacuumInto(I.dbPath, db);
  }
  return { dir, db };
}

/** Starts it and waits until one copy has stayed up. */
async function startAndWait(manager) {
  say('Starting it…');
  if (!startManaged(manager)) return null;
  return waitSteady(I.lockDirs, { timeoutMs: WAIT_MS, steadyMs: STEADY_MS });
}

/**
 * Something failed after the bot stopped. Code and packages go back; the bot starts on the old
 * code unless the database has moved on past it. Never touches the database.
 */
async function goBack({ why, oldCommit, manager, backup, ciTried, lockWasChanged, started }) {
  say();
  say(`✗ ${why}`);
  say('Going back to the old version.');
  if (started && manager) {
    stopManaged(manager);
    if (!await waitGone(I.lockDirs)) say('! A copy is still running, and it\'s on the new code. Stop it by hand.');
  }
  const now = git(ROOT, 'rev-parse', 'HEAD').out;
  let codeBack = true;
  if (now !== oldCommit) {
    codeBack = git(ROOT, 'reset', '--hard', oldCommit).ok;
    if (!codeBack) say(`✗ The code didn't go back. To do it by hand: git reset --hard ${oldCommit}`);
  }
  // npm ci empties node_modules before it installs, so a failed try leaves nothing to run on.
  let packagesBack = true;
  if (ciTried || lockWasChanged) {
    packagesBack = npmCi();
    if (!packagesBack) say('✗ The old packages didn\'t install. To do it by hand: npm ci');
  }

  say();
  const backupWords = backup.db ? `The backup is at ${backup.dir}` : `The backup of .env and the old commit id is at ${backup.dir}`;
  const dbNow = dbVersion(I.dbPath);
  const oldLatest = latestVersion(migrationsAt(oldCommit));
  if (oldCodeRefuses(dbNow, oldLatest)) {
    say(`! The database was already upgraded to v${dbNow}, and the old code (v${oldLatest}) refuses it, so it wasn't started.`);
    say(`  ${backupWords}.`);
    say();
    say('Your choices:');
    say(`  Stay on the new database. Fix what failed, then: npm run update`);
    if (backup.db) {
      say('  Or go back to the copy from before the update. This loses every message since then, so');
      say('  only you can decide it. Run these lines:');
      const steps = restoreSteps({
        dbPath: I.dbPath,
        backupDb: backup.db,
        startCommand: manager ? startWords[manager] : 'npm start',
        quote: shellQuote,
        suffix: stamp(),
      });
      for (const s of steps) say(`    ${s}`);
    }
    say();
    return 1;
  }
  if (manager && codeBack && packagesBack) {
    const up = await startAndWait(manager);
    if (up) say(`✓ Back on the old version and running (pid ${up.pid}).`);
    else say(`✗ The old version didn't come up either. Check its log, then: ${startWords[manager]}`);
  } else if (manager) {
    say(`It wasn't started. When that's sorted out: ${startWords[manager]}`);
  } else {
    say('✓ Back on the old version.');
  }
  say(`${backupWords}.`);
  say();
  return 1;
}

async function main() {
  // Everything that can refuse comes first, and the branch comes before all of it: an install
  // on any other branch isn't touched in any way, not even a package rebuild.
  const co = checkoutFacts(ROOT);
  let words = refusal(co);
  if (words) return refuse(words);

  const changed = git(ROOT, 'status', '--porcelain', '--untracked-files=no').out.split('\n').filter(Boolean).map((l) => l.trim().replace(/^\S+\s+/, ''));
  const up = git(ROOT, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', 'main@{upstream}');
  const upstream = up.ok ? up.out : '';
  words = refusal({ ...co, changed, upstream });
  if (words) return refuse(words);

  say();
  say(`Looking for new code on ${upstream}…`);
  const fetchFailed = !git(ROOT, 'fetch', '--quiet', git(ROOT, 'config', 'branch.main.remote').out || 'origin').ok;
  words = refusal({ ...co, changed, upstream, fetchFailed });
  if (words) return refuse(words);
  const count = (a, b) => Number(git(ROOT, 'rev-list', '--count', `${a}..${b}`).out) || 0;
  const ahead = count(upstream, 'HEAD');
  const behind = count('HEAD', upstream);
  words = refusal({ ...co, changed, upstream, ahead, behind });
  if (words) return refuse(words);

  if (!sqliteReady()) {
    say();
    say('✗ SQLite still doesn\'t load, so the database can\'t be backed up. Nothing was changed.');
    say('  Try by hand: npm rebuild better-sqlite3');
    say();
    return 1;
  }

  if (behind === 0) {
    say('✓ Already up to date.');
    say();
    return 0;
  }

  const oldCommit = git(ROOT, 'rev-parse', 'HEAD').out;
  const before = migrationsAt(oldCommit);
  const after = migrationsAt(upstream);
  const dbBefore = dbVersion(I.dbPath);
  if (dbBefore != null && dbBefore > latestVersion(after)) {
    return refuse(refusal({ ...co, changed, upstream, ahead, behind, dbNewer: { db: dbBefore, code: latestVersion(after) } }));
  }
  const migration = migrationPlan({ before, after, dbVersion: dbBefore });
  const packages = lockChanged(oldCommit, upstream);

  // A copy nothing here can drive has to be stopped by whoever started it, before any backup.
  const holder = holderOf(I.lockDirs);
  const manager = holder ? managerOf(holder.pid) : null;
  if (holder && !manager) {
    say(`It's running (pid ${holder.pid}), and not under pm2 or a systemd user service.`);
    say('Stop it, then run this again. Nothing was changed.');
    say();
    return 2;
  }

  say();
  for (const line of describeUpdate({ count: behind, migration, hasDb: dbBefore != null, packages, manager })) say(line);
  say();

  if (!YES) {
    const term = openTerminal();
    if (!term) {
      say('✗ No terminal here to ask on. To go ahead without asking: npm run update -- --yes');
      say();
      return 2;
    }
    const ui = createUi({ input: term.input, output: process.stdout });
    let go = false;
    try { go = await ui.confirm('Go ahead?', true); } finally { term.close(); }
    if (!go) {
      say('Nothing was changed.');
      say();
      return 0;
    }
  }

  let backup;
  try {
    backup = backUp(oldCommit);
    say(`✓ Backed up to ${backup.dir}`);
  } catch (err) {
    say(`✗ The backup failed, so nothing was changed: ${err.message}`);
    say();
    return 1;
  }

  // From here a stopped bot has to end up running again, whatever happens: Ctrl-C ends the
  // command in hand, which is one more failure to put right, and a closed terminal changes nothing.
  const hold = () => say('! Hold on: finishing so it isn\'t left stopped.');
  process.on('SIGINT', hold);
  process.on('SIGTERM', hold);
  process.on('SIGHUP', () => {});
  process.stdout.on('error', () => {});

  if (manager) {
    say(`Stopping it under ${manager}…`);
    stopManaged(manager);
    if (!await waitGone(I.lockDirs)) {
      startManaged(manager);
      say('✗ It didn\'t stop within 30 seconds, so nothing was pulled.');
      say();
      return 1;
    }
  }

  const fail = (why, extra = {}) => goBack({ why, oldCommit, manager, backup, ciTried: false, lockWasChanged: false, started: false, ...extra });

  let lockWasChanged = false;
  try {
    const pull = git(ROOT, 'pull', '--ff-only');
    if (!pull.ok) return await fail('git pull failed. The code is as it was.');
    const newCommit = git(ROOT, 'rev-parse', 'HEAD').out;

    lockWasChanged = lockChanged(oldCommit, newCommit);
    if (lockWasChanged && !npmCi()) return await fail('The new packages didn\'t install.', { ciTried: true, lockWasChanged });
    if (!sqliteReady()) return await fail('SQLite doesn\'t load with the new packages.', { ciTried: lockWasChanged, lockWasChanged });

    if (!manager) {
      say(`✓ Updated to ${newCommit.slice(0, 7)}.`);
      say(`The backup is at ${backup.dir}`);
      pruneOldBackups();
      say(migration.will && dbBefore != null ? 'Start it when you\'re ready: npm start. The database upgrades on that start, with its own backup.' : 'Start it when you\'re ready: npm start');
      say();
      return 0;
    }

    const running = await startAndWait(manager);
    if (!running) {
      return await fail(`The new version didn't stay up within ${Math.round(WAIT_MS / 1000)} seconds.`, { ciTried: lockWasChanged, lockWasChanged, started: true });
    }
    const dbNow = dbVersion(I.dbPath);
    say(`✓ Updated to ${newCommit.slice(0, 7)} and running (pid ${running.pid}).`);
    if (dbBefore != null && dbNow !== dbBefore) say(`✓ The database went from v${dbBefore} to v${dbNow}.`);
    say(`The backup is at ${backup.dir}`);
    pruneOldBackups();
    say();
    return 0;
  } catch (err) {
    return fail(`Something unexpected went wrong: ${err.message}`, { ciTried: lockWasChanged, lockWasChanged, started: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof Interrupted) {
      say('Stopped. Nothing was changed.');
      say();
      process.exit(130);
    }
    console.error(`\n  Update failed: ${err?.message || err}\n`);
    process.exit(1);
  },
);
