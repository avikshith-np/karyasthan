// Day two, offline: npm run update, backup and uninstall on scratch repos with a real local bare
// remote, a stand-in bot that takes the real lock, and stubbed npm, pm2 and systemctl on PATH. The
// outside services are a stubbed fetch. Nothing here reads this install's .env or data, and no
// test reaches a real pm2: every run has the stubs first on PATH, and that's checked before any.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  refusal, migrationFiles, latestVersion, migrationPlan, describeUpdate, oldCodeRefuses, restoreSteps,
  oldUpdateBackups,
} from './setup/update-plan.js';
import { checkEntries, listEntries } from './setup/backup-archive.js';
import { shellQuote, isInside, checkoutFacts } from './setup/day-two.js';
import { waitSteady, waitGone, holderOf } from './setup/running.js';

// Read from the source: importing the store would load this install's .env through config.js.
const DELETE_PENDING_SUFFIX = fs.readFileSync(new URL('../src/memory/voiceStore.js', import.meta.url), 'utf-8').match(/DELETE_PENDING_SUFFIX = '([^']+)'/)[1];
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'karyasthan-day-two-')));
const BIN = path.join(SCRATCH, 'bin');
// Packages for every project are one level above it, so a project's own node_modules holds
// nothing real and an uninstall can't reach the real ones.
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(SCRATCH, 'node_modules'));

let passed = 0; let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n── ${s}`);
const standIns = [];
process.on('exit', () => {
  for (const get of standIns) { const pid = get(); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
});
const plain = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stubs ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(BIN);
const HEAD = `#!/bin/bash\nS="$STUB_STATE"; P="$STUB_PROJECT"; mkdir -p "$S"\n`;
const BOT_FN = 'start_bot() { cd "$P" || exit 1; setsid nohup "$STUB_NODE" "$P/src/index.js" </dev/null >>"$S/bot.log" 2>&1 & echo $! > "$1"; }\n'
  + 'alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }\n'
  + 'stop_bot() { alive "$1" && kill "$(cat "$1")"; rm -f "$1"; for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$1" || break; sleep 0.1; done; true; }\n';
fs.writeFileSync(path.join(BIN, 'pm2'), `${HEAD}${BOT_FN}echo "pm2 $*" >> "$S/calls.log"
pidf="$S/pm2.pid"
case "$1" in
  --version) echo 5 ;;
  pid) if alive "$pidf"; then cat "$pidf"; else echo 0; fi ;;
  stop) echo "backups-at-stop $(ls "$P/data/backups" 2>/dev/null | wc -l)" >> "$S/calls.log"; stop_bot "$pidf" ;;
  start) start_bot "$pidf" ;;
  jlist) cat "$S/pm2-list.json" 2>/dev/null || echo '[]' ;;
  delete) stop_bot "$pidf"; rm -f "$S/pm2-list.json" ;;
  save) ;;
esac
exit 0
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'systemctl'), `${HEAD}${BOT_FN}echo "systemctl $*" >> "$S/calls.log"
pidf="$S/systemd.pid"
[ "$1" = "--user" ] && shift
case "$1" in
  show-environment) ;;
  show) if alive "$pidf"; then cat "$pidf"; else echo 0; fi ;;
  stop) stop_bot "$pidf" ;;
  start) start_bot "$pidf" ;;
  disable) stop_bot "$pidf" ;;
esac
exit 0
`, { mode: 0o755 });
// npm ci empties node_modules, as the real one does. It fails while the lockfile says BROKEN.
// npm rebuild takes away the broken SQLite stand-in unless told it can't.
fs.writeFileSync(path.join(BIN, 'npm'), `${HEAD}echo "npm $*" >> "$S/calls.log"
case "$1" in
  ci) rm -rf "$P/node_modules"; mkdir -p "$P/node_modules"; grep -q SLOW "$P/package-lock.json" && sleep 20; grep -q BROKEN "$P/package-lock.json" && exit 1 ;;
  rebuild) [ -z "$STUB_REBUILD_FAILS" ] && rm -rf "$P/node_modules/better-sqlite3" ;;
esac
exit 0
`, { mode: 0o755 });

const baseEnv = (dir, state, extra = {}) => ({
  PATH: `${BIN}:${process.env.PATH}`,
  HOME: path.join(SCRATCH, 'home'),
  TERM: 'xterm',
  LANG: 'C.UTF-8',
  STUB_STATE: state,
  STUB_PROJECT: dir,
  STUB_NODE: process.execPath,
  ...extra,
});
fs.mkdirSync(path.join(SCRATCH, 'home'), { recursive: true });

const resolvedPm2 = spawnSync('bash', ['-c', 'command -v pm2; command -v systemctl; command -v npm'], { encoding: 'utf-8', env: baseEnv(SCRATCH, SCRATCH) }).stdout.trim().split('\n');
if (!resolvedPm2.every((p) => p.startsWith(`${BIN}/`))) {
  console.error(`The stubs aren't first on PATH, so this could reach a real pm2: ${resolvedPm2.join(' ')}`);
  process.exit(1);
}

// ── A scratch repo, its remote and a stand-in bot ─────────────────────────────
const gitIn = (dir, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', dir, ...args], { encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: path.join(SCRATCH, 'home'), GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// Takes the real lock, migrates as the bot does (refusing a newer database), and stays up.
const botSource = (breaks = '') => `import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { takeLock } from './utils/instanceLock.js';
const BREAKS = ${JSON.stringify(breaks)};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');
if (BREAKS === 'at-once') process.exit(1);
if (takeLock(data, 'bot')) process.exit(78);
const Database = createRequire(import.meta.url)('better-sqlite3');
const latest = Math.max(0, ...fs.readdirSync(path.join(root, 'src/memory/migrations')).map((f) => Number(f.slice(0, 3)) || 0));
const db = new Database(path.join(data, 'karyasthan.db'));
db.pragma('journal_mode = WAL');
const v = db.pragma('user_version', { simple: true });
if (v > latest) { console.error('newer'); process.exit(1); }
if (v < latest) db.pragma('user_version = ' + latest);
db.close();
if (BREAKS === 'after-migrating') setTimeout(() => process.exit(1), 400);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 60000);
`;

function scaffold(name, { full = false } = {}) {
  const base = path.join(SCRATCH, name);
  const seed = path.join(base, 'seed');
  fs.mkdirSync(path.join(seed, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts/setup'), path.join(seed, 'scripts/setup'), { recursive: true });
  for (const f of ['scripts/update.js', 'scripts/backup.js', 'scripts/uninstall.js', 'scripts/setup.js', 'scripts/doctor.js', '.env.example', '.gitignore']) fs.copyFileSync(path.join(ROOT, f), path.join(seed, f));
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"karyasthan","type":"module"}\n');
  fs.writeFileSync(path.join(seed, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const copy = (rel, filter) => fs.cpSync(path.join(ROOT, rel), path.join(seed, rel), { recursive: true, filter });
  const notPrivate = (p) => !/^(persona\.json|identity\.md|world\.json|arcs\.json|taste\.json|phrases\.json)/.test(path.basename(p));
  if (full) copy('src', notPrivate);
  else {
    for (const rel of ['src/utils/instanceLock.js', 'src/utils/bootCheck.js', 'src/brain/providers.js', 'src/public/r2.js', 'src/memory/migrations', 'src/personality/persona.example.json', 'src/personality/identity.example.md', 'src/personality/templates']) copy(rel, notPrivate);
  }
  fs.writeFileSync(path.join(seed, 'src/index.js'), botSource());
  gitIn(seed, 'init', '-q', '-b', 'main');
  gitIn(seed, 'add', '.');
  gitIn(seed, 'commit', '-q', '-m', 'first');
  const remote = path.join(base, 'remote.git');
  spawnSync('git', ['clone', '-q', '--bare', seed, remote], { env: { PATH: process.env.PATH, HOME: path.join(SCRATCH, 'home') } });
  gitIn(seed, 'remote', 'add', 'origin', remote);
  gitIn(seed, 'fetch', '-q', 'origin');
  gitIn(seed, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  const dir = path.join(base, 'work');
  spawnSync('git', ['clone', '-q', remote, dir], { env: { PATH: process.env.PATH, HOME: path.join(SCRATCH, 'home') } });
  const state = path.join(base, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, '.env'), 'LLM_PROVIDER=ollama\nLLM_MODEL=m\nGEMINI_API_KEY=SECRETGEMINI-1234\n', { mode: 0o600 });
  const db = new Database(path.join(dir, 'data/karyasthan.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, t TEXT); INSERT INTO messages (t) VALUES (\'before\')');
  db.pragma(`user_version = ${latestVersion(migrationFiles(fs.readdirSync(path.join(dir, 'src/memory/migrations'))))}`);
  db.close();
  return { base, seed, remote, dir, state, env: (extra) => baseEnv(dir, state, extra) };
}

/** A new commit on the remote. */
function publish(repo, files, message = 'new') {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(repo.seed, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  gitIn(repo.seed, 'add', '.');
  gitIn(repo.seed, 'commit', '-q', '-m', message);
  gitIn(repo.seed, 'push', '-q', 'origin', 'main');
  return gitIn(repo.seed, 'rev-parse', 'HEAD');
}
const NEW_MIGRATION = { 'src/memory/migrations/022-test.js': 'export default {};\n' };

const headOf = (repo) => gitIn(repo.dir, 'rev-parse', 'HEAD');
const callsOf = (repo) => { try { return fs.readFileSync(path.join(repo.state, 'calls.log'), 'utf-8'); } catch { return ''; } };
const clearCalls = (repo) => fs.rmSync(path.join(repo.state, 'calls.log'), { force: true });
const backupsOf = (repo) => { try { return fs.readdirSync(path.join(repo.dir, 'data/backups')); } catch { return []; } };
const dbV = (p) => { const d = new Database(p, { readonly: true }); try { return d.pragma('user_version', { simple: true }); } finally { d.close(); } };
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const pidFile = (repo, m = 'pm2') => path.join(repo.state, `${m}.pid`);
const pidOf = (repo, m = 'pm2') => { try { return Number(fs.readFileSync(pidFile(repo, m), 'utf-8')); } catch { return 0; } };

/** Starts the stand-in under a stub manager, and waits until it holds the lock. */
async function startBot(repo, m = 'pm2') {
  const cmd = m === 'pm2' ? ['pm2', ['start', 'karyasthan']] : ['systemctl', ['--user', 'start', 'karyasthan']];
  spawnSync(cmd[0], cmd[1], { env: repo.env(), stdio: 'ignore' });
  clearCalls(repo);
  standIns.push(() => pidOf(repo, m));
  const up = await waitSteady([path.join(repo.dir, 'data')], { timeoutMs: 8000, steadyMs: 300 });
  if (!up) throw new Error('the stand-in bot did not start');
  return up;
}
async function stopBot(repo, m = 'pm2') {
  const pid = pidOf(repo, m);
  if (pid && pidAlive(pid)) process.kill(pid, 'SIGTERM');
  await waitGone([path.join(repo.dir, 'data')], 5000);
  fs.rmSync(pidFile(repo, m), { force: true });
}

/** With no controlling terminal, as under cron or CI. */
function noTerminal(repo, script, args = [], extra = {}) {
  const r = spawnSync('setsid', ['-w', process.execPath, script, ...args], { cwd: repo.dir, env: repo.env(extra), encoding: 'utf-8', input: '', timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** A real terminal; each step waits for text, then types. One key at a time, like a person. */
function terminal(repo, command, steps, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: repo.dir, env: repo.env(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let at = 0; let i = 0; let typing = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    const step = async () => {
      if (typing || i >= steps.length) return;
      const [wait, send] = steps[i];
      const idx = plain(out).indexOf(wait, at);
      if (idx < 0) return;
      at = idx + wait.length;
      i++; typing = true;
      await sleep(100);
      for (const c of send) {
        try { child.stdin.write(c); } catch { /* gone */ }
        await sleep(10);
      }
      typing = false;
      step();
    };
    const onData = (d) => { out += d.toString('utf8'); step(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: plain(out), answered: i, total: steps.length }); });
  });
}

const FAKE_HOME = ['', 'home', 'sam'].join('/');   // built, so the repo's path check stays strict

// ── Pure planning ─────────────────────────────────────────────────────────────
section('update: what it decides');
const okFacts = { checkout: true, branch: 'main', changed: [], upstream: 'origin/main', ahead: 0, behind: 3 };
check('a clean main that can fast-forward goes ahead', refusal(okFacts) === null);
check('not a checkout', /git checkout/.test(refusal({ checkout: false })));
check('the owner\'s branch is refused by name', /"live"/.test(refusal({ ...okFacts, branch: 'live' })));
check('no branch at all is refused', /no branch/.test(refusal({ ...okFacts, branch: '' })));
check('tracked changes name the files', /src\/a\.js/.test(refusal({ ...okFacts, changed: ['src/a.js'] })));
check('a long list of changes is cut short', /and 2 more/.test(refusal({ ...okFacts, changed: ['1', '2', '3', '4', '5', '6', '7'] })));
check('no remote', /no remote/.test(refusal({ ...okFacts, upstream: '' })));
check('an unreachable remote', /Couldn't reach/.test(refusal({ ...okFacts, fetchFailed: true })));
check('local commits can\'t be fast-forwarded', /can't be fast-forwarded/.test(refusal({ ...okFacts, ahead: 2 })));
check('every refusal says nothing changed', ['checkout', 'branch', 'changed', 'upstream', 'fetchFailed', 'ahead'].every((k) => /Nothing was changed/.test(refusal({ ...okFacts, ...{ checkout: { checkout: false }, branch: { branch: 'x' }, changed: { changed: ['a'] }, upstream: { upstream: '' }, fetchFailed: { fetchFailed: true }, ahead: { ahead: 1 } }[k] }))));
check('migration files are read by number, from a full path', migrationFiles(['src/memory/migrations/002-b.js', 'src/memory/migrations/index.js', 'src/memory/migrations/001-a.js', 'x/util.js']).join() === '001-a.js,002-b.js');
check('the latest number is the schema version', latestVersion(['001-a.js', '021-z.js']) === 21 && latestVersion([]) === 0);
const mig = migrationPlan({ before: ['001-a.js'], after: ['001-a.js', '002-b.js'], dbVersion: 1 });
check('a new file means a migration, from the database\'s version', mig.will && mig.from === 1 && mig.to === 2 && mig.newFiles.join() === '002-b.js');
check('the same files and a current database: no migration', !migrationPlan({ before: ['001-a.js'], after: ['001-a.js'], dbVersion: 1 }).will);
check('a database behind the code migrates even with no new file', migrationPlan({ before: ['001-a.js', '002-b.js'], after: ['001-a.js', '002-b.js'], dbVersion: 1 }).will);
check('no database: the files decide', migrationPlan({ before: ['001-a.js'], after: ['001-a.js', '002-b.js'] }).will);
const words = describeUpdate({ count: 1, migration: mig, hasDb: true, packages: false, manager: 'pm2' }).join(' ');
check('it says how many, whether it migrates, packages, and the stop', /1 new commit\./.test(words) && /v1 to v2/.test(words) && /Packages are the same/.test(words) && /under pm2/.test(words), words);
check('no database, no database line', !/database/i.test(describeUpdate({ count: 2, migration: mig, hasDb: false, packages: true, manager: null }).join(' ')));
check('old code refuses only a newer schema', oldCodeRefuses(22, 21) && !oldCodeRefuses(21, 21) && !oldCodeRefuses(null, 21));
const stepsText = restoreSteps({ dbPath: `${FAKE_HOME}/my bot/data/k.db`, backupDb: `${FAKE_HOME}/my bot/data/backups/u/k.db`, startCommand: 'pm2 start karyasthan', quote: shellQuote, suffix: 'T1' }).join('\n');
check('restore steps: aside first, quoted, then copy and start', stepsText.indexOf('mv ') < stepsText.indexOf('cp ') && stepsText.includes(`'${FAKE_HOME}/my bot/data/k.db.old-T1'`) && stepsText.endsWith('pm2 start karyasthan'), stepsText);
check('restore steps never delete', !/\brm\b/.test(stepsText));
check('shell quoting holds a quote', shellQuote("it's") === "'it'\\''s'" && shellQuote('/plain/path-1') === '/plain/path-1');
check('inside means strictly inside', isInside('/a/b', '/a/b/c') && !isInside('/a/b', '/a/b') && !isInside('/a/b', '/a/bc') && !isInside('/a/b', '/a'));

section('the lock wait');
const lockTest = path.join(SCRATCH, 'lock-wait');
fs.mkdirSync(lockTest, { recursive: true });
const standIn = path.join(SCRATCH, 'stand-in/src/index.js');
fs.mkdirSync(path.dirname(standIn), { recursive: true });
fs.writeFileSync(standIn, 'setTimeout(()=>{},60000)');
const spawnStandIn = async () => {
  const c = spawn(process.execPath, [standIn], { stdio: 'ignore' });
  await sleep(200);
  return c;
};
const a1 = await spawnStandIn();
const a2 = await spawnStandIn();
const a4 = await spawnStandIn();
const a5 = await spawnStandIn();
fs.writeFileSync(path.join(lockTest, '.instance-lock'), `${a1.pid} bot\n`);
const steady = await waitSteady([lockTest], { timeoutMs: 2000, steadyMs: 500 });
check('one pid holding it counts as up', steady?.pid === a1.pid, JSON.stringify(steady));
let swaps = true;
const swapper = (async () => {
  let which = 0;
  while (swaps) {
    fs.writeFileSync(path.join(lockTest, '.instance-lock'), `${[a1, a2, a4, a5][which++ % 4].pid} bot\n`);
    await sleep(300);
  }
})();
const looping = await waitSteady([lockTest], { timeoutMs: 2500, steadyMs: 1200 });
swaps = false; await swapper;
check('a pid that keeps changing, a manager restarting a crash, never counts as up', looping === null, JSON.stringify(looping));
const spaced = path.join(SCRATCH, 'a folder/src/index.js');
fs.mkdirSync(path.dirname(spaced), { recursive: true });
fs.writeFileSync(spaced, 'setTimeout(()=>{},60000)');
const a3 = spawn(process.execPath, [spaced], { stdio: 'ignore' });
await sleep(200);
fs.writeFileSync(path.join(lockTest, '.instance-lock'), `${a3.pid} bot\n`);
check('a folder with a space in its name doesn\'t hide a running copy', holderOf([lockTest])?.pid === a3.pid);
a3.kill('SIGKILL');
// The way pm2 renames its process: one string, padded with NULs. The -e text makes the room for it.
const titled = spawn(process.execPath, ['-e', `process.title = 'node ${SCRATCH}/a folder/src/index.js'; setTimeout(() => {}, 60000); /* ${'x'.repeat(300)} */`], { stdio: 'ignore' });
await sleep(300);
fs.writeFileSync(path.join(lockTest, '.instance-lock'), `${titled.pid} bot\n`);
check('a copy pm2 renamed still counts', holderOf([lockTest])?.pid === titled.pid);
titled.kill('SIGKILL');
for (const c of [a1, a2, a4, a5]) c.kill('SIGKILL');
await sleep(100);
check('a dead holder is gone', await waitGone([lockTest], 500));

// ── update: refusals ──────────────────────────────────────────────────────────
section('update: refusals');
const upd = (repo, args = ['--yes'], extra = {}) => noTerminal(repo, 'scripts/update.js', args, extra);
{
  const repo = scaffold('refuse-live');
  publish(repo, NEW_MIGRATION);
  gitIn(repo.dir, 'checkout', '-q', '-b', 'live');
  // A broken SQLite stand-in: a rebuild would be a touch, and it mustn't happen here.
  fs.mkdirSync(path.join(repo.dir, 'node_modules/better-sqlite3'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, 'node_modules/better-sqlite3/index.js'), 'throw new Error("broken");');
  const before = headOf(repo);
  const r = upd(repo);
  check('branch live: refused by name, exit 2', r.code === 2 && r.out.includes('"live"') && r.out.includes('Nothing was changed'), `${r.code} ${r.out}`);
  check('branch live: not one call to npm, pm2 or systemctl', callsOf(repo) === '', callsOf(repo));
  check('branch live: no pull, no backup', headOf(repo) === before && backupsOf(repo).length === 0);
  check('branch live: the packages are untouched', fs.existsSync(path.join(repo.dir, 'node_modules/better-sqlite3/index.js')));
}
{
  const repo = scaffold('refuse-detached');
  gitIn(repo.dir, 'checkout', '-q', '--detach');
  const r = upd(repo);
  check('a detached HEAD: refused, exit 2', r.code === 2 && r.out.includes('no branch'), `${r.code} ${r.out}`);
}
{
  const repo = scaffold('refuse-dirty');
  publish(repo, NEW_MIGRATION);
  const before = headOf(repo);
  fs.appendFileSync(path.join(repo.dir, 'package.json'), '\n');
  const r = upd(repo);
  check('tracked changes: refused, exit 2, the file is named', r.code === 2 && r.out.includes('package.json') && headOf(repo) === before, `${r.code} ${r.out}`);
  fs.writeFileSync(path.join(repo.dir, 'untracked-note.txt'), 'mine');
  gitIn(repo.dir, 'checkout', '--', 'package.json');
  const r2 = upd(repo);
  check('an untracked file is no reason to refuse, and stays', r2.code === 0 && fs.existsSync(path.join(repo.dir, 'untracked-note.txt')), `${r2.code} ${r2.out}`);
}
{
  const plainDir = path.join(SCRATCH, 'not-a-checkout');
  fs.mkdirSync(path.join(plainDir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts/setup'), path.join(plainDir, 'scripts/setup'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/update.js'), path.join(plainDir, 'scripts/update.js'));
  fs.writeFileSync(path.join(plainDir, 'package.json'), '{"type":"module"}\n');
  for (const f of ['src/utils/instanceLock.js', 'src/utils/bootCheck.js', 'src/brain/providers.js']) fs.cpSync(path.join(ROOT, f), path.join(plainDir, f), { recursive: true });
  const fakeRepo = { dir: plainDir, env: (x) => baseEnv(plainDir, path.join(SCRATCH, 'na-state'), x) };
  const r = upd(fakeRepo);
  check('not a git checkout: refused, exit 2', r.code === 2 && r.out.includes('git checkout'), `${r.code} ${r.out}`);
  gitIn(SCRATCH, 'init', '-q', '-b', 'main');
  const r2 = upd(fakeRepo);
  check('a folder inside someone else\'s repo on main: still not a checkout of this', r2.code === 2 && r2.out.includes('git checkout'), `${r2.code} ${r2.out}`);
  check('...and uninstall says the same, whatever branch that repo is on', checkoutFacts(plainDir).checkout === false && checkoutFacts(plainDir).branch === '');
  fs.rmSync(path.join(SCRATCH, '.git'), { recursive: true, force: true });
}
{
  const repo = scaffold('refuse-noremote');
  gitIn(repo.dir, 'remote', 'remove', 'origin');
  const r = upd(repo);
  check('no remote: refused, exit 2', r.code === 2 && r.out.includes('no remote'), `${r.code} ${r.out}`);
}
{
  const repo = scaffold('refuse-unreachable');
  gitIn(repo.dir, 'remote', 'set-url', 'origin', path.join(SCRATCH, 'nothing-here.git'));
  const r = upd(repo);
  check('a remote that doesn\'t answer: refused, exit 2', r.code === 2 && r.out.includes('Couldn\'t reach'), `${r.code} ${r.out}`);
}
{
  const repo = scaffold('refuse-diverged');
  publish(repo, NEW_MIGRATION);
  fs.writeFileSync(path.join(repo.dir, 'local.txt'), 'mine');
  gitIn(repo.dir, 'add', 'local.txt');
  gitIn(repo.dir, 'commit', '-q', '-m', 'local');
  const before = headOf(repo);
  const r = upd(repo);
  check('a remote that can\'t be fast-forwarded: refused, exit 2, nothing moved', r.code === 2 && r.out.includes('fast-forwarded') && headOf(repo) === before && backupsOf(repo).length === 0, `${r.code} ${r.out}`);
}
{
  const repo = scaffold('refuse-handrun');
  publish(repo, NEW_MIGRATION);
  const before = headOf(repo);
  const bot = spawn(process.execPath, [path.join(repo.dir, 'src/index.js')], { cwd: repo.dir, stdio: 'ignore', env: repo.env() });
  await waitSteady([path.join(repo.dir, 'data')], { timeoutMs: 8000, steadyMs: 300 });
  const r = upd(repo);
  check('running with no manager: says stop it, exit 2', r.code === 2 && /Stop it, then run this again/.test(r.out), `${r.code} ${r.out}`);
  check('running with no manager: no backup, no pull, and it\'s still running', backupsOf(repo).length === 0 && headOf(repo) === before && pidAlive(bot.pid));
  bot.kill('SIGTERM');
  await sleep(200);
}
{
  const repo = scaffold('another-install-pm2');
  publish(repo, NEW_MIGRATION);
  const bot = spawn(process.execPath, [path.join(repo.dir, 'src/index.js')], { cwd: repo.dir, stdio: 'ignore', env: repo.env() });
  await waitSteady([path.join(repo.dir, 'data')], { timeoutMs: 8000, steadyMs: 300 });
  // pm2 knows a "karyasthan", but with a different pid: some other install's.
  fs.writeFileSync(pidFile(repo), String(process.pid));
  const r = upd(repo);
  check('a pm2 entry with the name but not this copy\'s pid isn\'t driven', r.code === 2 && !callsOf(repo).includes('pm2 stop') && pidAlive(process.pid), `${r.code} ${callsOf(repo)}`);
  bot.kill('SIGTERM');
  fs.rmSync(pidFile(repo), { force: true });
  await sleep(200);
}
{
  const repo = scaffold('uptodate');
  const r = upd(repo);
  check('nothing new: says so, exit 0, no backup', r.code === 0 && r.out.includes('Already up to date') && backupsOf(repo).length === 0 && !callsOf(repo).includes('stop'), `${r.code} ${r.out}`);
}
{
  const repo = scaffold('no-terminal');
  publish(repo, NEW_MIGRATION);
  const before = headOf(repo);
  const r = noTerminal(repo, 'scripts/update.js');
  check('no terminal and no --yes: refused, exit 2, says how', r.code === 2 && r.out.includes('--yes') && headOf(repo) === before, `${r.code} ${r.out}`);
}

// ── update: good runs ─────────────────────────────────────────────────────────
section('update: a good update');
{
  const repo = scaffold('good-pm2');
  const old = headOf(repo);
  const newHead = publish(repo, NEW_MIGRATION);
  publish(repo, { 'another.txt': 'x' });
  const up = await startBot(repo, 'pm2');
  // A message only in the write-ahead file, while the bot has it open.
  const writer = new Database(path.join(repo.dir, 'data/karyasthan.db'));
  writer.pragma('wal_autocheckpoint = 0');
  writer.prepare('INSERT INTO messages (t) VALUES (?)').run('in the wal');
  writer.close();
  const r = await upd(repo);
  check('exit 0', r.code === 0, `${r.code} ${r.out}`);
  check('says how many commits and that the database will migrate', r.out.includes('2 new commits') && r.out.includes('from v21 to v22'), r.out);
  check('the code moved to the newest commit', headOf(repo) === gitIn(repo.seed, 'rev-parse', 'HEAD') && newHead !== old);
  const calls = callsOf(repo);
  check('the backup came before the stop', /backups-at-stop\s+1/.test(calls), calls);
  check('it stopped and started it under pm2, once each', (calls.match(/pm2 stop karyasthan/g) || []).length === 1 && (calls.match(/pm2 start karyasthan/g) || []).length === 1, calls);
  check('lockfile unchanged: no npm ci', !calls.includes('npm ci'), calls);
  const after = pidOf(repo);
  check('a new copy runs, and holds the lock', after !== up.pid && pidAlive(after) && holderOf([path.join(repo.dir, 'data')])?.pid === after, `${after} ${up.pid}`);
  check('the database migrated when it came up', dbV(path.join(repo.dir, 'data/karyasthan.db')) === 22 && r.out.includes('from v21 to v22'));
  const dirs = backupsOf(repo);
  const u = path.join(repo.dir, 'data/backups', dirs[0] || 'x');
  check('one backup folder, private', dirs.length === 1 && dirs[0].startsWith('update-') && mode(u) === '700', dirs.join());
  check('the database copy is private, at the old version, with the newest message', mode(path.join(u, 'karyasthan.db')) === '600' && dbV(path.join(u, 'karyasthan.db')) === 21 && new Database(path.join(u, 'karyasthan.db'), { readonly: true }).prepare('SELECT COUNT(*) c FROM messages WHERE t = ?').get('in the wal').c === 1);
  check('a private copy of .env', mode(path.join(u, '.env')) === '600' && fs.readFileSync(path.join(u, '.env'), 'utf-8').includes('SECRETGEMINI'));
  check('the old commit id is kept', fs.readFileSync(path.join(u, 'commit'), 'utf-8').trim() === old);
  check('no key on the screen', !r.out.includes('SECRETGEMINI'));
  check('the backup path is printed', r.out.includes(dirs[0]));
  await stopBot(repo);
}
{
  const repo = scaffold('good-systemd');
  publish(repo, { 'package-lock.json': '{"lockfileVersion":3,"new":true}\n' });
  await startBot(repo, 'systemd');
  const r = upd(repo);
  const calls = callsOf(repo);
  check('under a systemd user service: exit 0', r.code === 0 && r.out.includes('under systemd'), `${r.code} ${r.out}`);
  check('lockfile changed: npm ci once, before the start', (calls.match(/npm ci/g) || []).length === 1 && calls.indexOf('npm ci') < calls.indexOf('--user start'), calls);
  check('it stopped through systemctl, not pm2', calls.includes('--user stop karyasthan') && !calls.includes('pm2 stop'), calls);
  check('no migration: the database line says so', r.out.includes('The database stays as it is') && dbV(path.join(repo.dir, 'data/karyasthan.db')) === 21, r.out);
  await stopBot(repo, 'systemd');
}
{
  const repo = scaffold('not-running');
  publish(repo, NEW_MIGRATION);
  const r = upd(repo);
  const calls = callsOf(repo);
  check('not running: updates, and doesn\'t start it', r.code === 0 && !calls.includes('pm2 start') && !calls.includes('--user start') && r.out.includes('npm start') && r.out.includes('upgrades on that start'), `${r.code} ${r.out}\n${calls}`);
  check('not running: a backup all the same', backupsOf(repo).length === 1);
}
{
  const repo = scaffold('rebuild');
  publish(repo, { 'x.txt': 'x' });
  fs.mkdirSync(path.join(repo.dir, 'node_modules/better-sqlite3'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, 'node_modules/better-sqlite3/index.js'), 'throw new Error("was compiled against a different Node.js version");');
  const r = upd(repo);
  check('SQLite won\'t load: rebuilt, then it goes on', r.code === 0 && callsOf(repo).includes('npm rebuild better-sqlite3') && r.out.includes('Rebuilding'), `${r.code} ${r.out}\n${callsOf(repo)}`);
  const repo2 = scaffold('rebuild-fails');
  publish(repo2, { 'x.txt': 'x' });
  fs.mkdirSync(path.join(repo2.dir, 'node_modules/better-sqlite3'), { recursive: true });
  fs.writeFileSync(path.join(repo2.dir, 'node_modules/better-sqlite3/index.js'), 'throw new Error("broken");');
  const before = headOf(repo2);
  const r2 = upd(repo2, ['--yes'], { STUB_REBUILD_FAILS: '1' });
  check('a rebuild that doesn\'t help: stops, nothing changed', r2.code === 1 && r2.out.includes('Nothing was changed') && headOf(repo2) === before && backupsOf(repo2).length === 0, `${r2.code} ${r2.out}`);
}
const hasScript = spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
if (!hasScript) console.log('  skip  no `script` command here');
else {
  const repo = scaffold('asks');
  publish(repo, NEW_MIGRATION);
  const before = headOf(repo);
  const no = await terminal(repo, 'node scripts/update.js', [['Go ahead?', 'n\r']]);
  check('in a terminal it asks, and no means nothing changes', no.code === 0 && no.out.includes('Nothing was changed') && headOf(repo) === before && backupsOf(repo).length === 0, `${no.code} ${no.out}`);
  const yes = await terminal(repo, 'node scripts/update.js', [['Go ahead?', '\r']]);
  check('Enter means yes', yes.code === 0 && headOf(repo) !== before, `${yes.code} ${yes.out}`);
}

// ── update: going back ────────────────────────────────────────────────────────
section('update: old backups');
check('keeps the newest few of its own, by name', oldUpdateBackups(['update-20200101T000000Z', 'update-20200102T000000Z', 'update-20200103T000000Z'], 2).join() === 'update-20200101T000000Z');
check('nothing else counts as its own', oldUpdateBackups(['karyasthan-x-pre.db', 'update-notes', 'update-2020', 'full.tar.gz'], 0).length === 0);
{
  const repo = scaffold('prune');
  publish(repo, { 'another.txt': 'x' });
  await startBot(repo, 'pm2');
  const bdir = path.join(repo.dir, 'data/backups');
  fs.mkdirSync(bdir, { recursive: true });
  const olds = [1, 2, 3, 4, 5, 6, 7].map((d) => `update-2020010${d}T000000Z`);
  for (const n of olds) fs.mkdirSync(path.join(bdir, n));
  fs.writeFileSync(path.join(bdir, 'karyasthan-x-pre.db'), 'mine');
  fs.mkdirSync(path.join(bdir, 'update-notes'));
  fs.writeFileSync(path.join(bdir, 'update-20190101T000000Z'), 'a file, not a folder');
  const r = await upd(repo);
  const left = fs.readdirSync(bdir);
  const updates = left.filter((n) => /^update-\d{8}T/.test(n) && fs.statSync(path.join(bdir, n)).isDirectory());
  check('after a good update, the newest 5 folders stay', r.code === 0 && updates.length === 5 && updates.includes('update-20200107T000000Z') && !updates.includes('update-20200103T000000Z') && updates.some((n) => !olds.includes(n)), `${r.code} ${left.join()}`);
  check('says what it removed', r.out.includes('older update backups, keeping the newest 5'), r.out.slice(-300));
  check('other backups stay', left.includes('karyasthan-x-pre.db') && left.includes('update-notes'), left.join());
  check('a file with that kind of name isn\'t its own', fs.existsSync(path.join(bdir, 'update-20190101T000000Z')));
  await stopBot(repo);
}

section('update: a failed update goes back');
{
  const repo = scaffold('fail-npm');
  const old = headOf(repo);
  publish(repo, { 'package-lock.json': '{"BROKEN":true}\n' });
  await startBot(repo, 'pm2');
  const r = upd(repo);
  const calls = callsOf(repo);
  check('packages fail: exit 1, says so', r.code === 1 && r.out.includes('didn\'t install'), `${r.code} ${r.out}`);
  check('packages fail: the code is back on the old commit', headOf(repo) === old);
  check('packages fail: npm ci ran again for the old packages', (calls.match(/npm ci/g) || []).length === 2, calls);
  check('packages fail: it\'s running again', pidAlive(pidOf(repo)) && r.out.includes('Back on the old version and running'), r.out);
  check('packages fail: the backup path is printed', r.out.includes(backupsOf(repo)[0]), r.out);
  check('packages fail: the database wasn\'t touched', dbV(path.join(repo.dir, 'data/karyasthan.db')) === 21);
  await stopBot(repo);
}
if (hasScript) {
  const repo = scaffold('fail-ctrl-c');
  const old = headOf(repo);
  publish(repo, { 'package-lock.json': '{"SLOW":true}\n' });
  await startBot(repo, 'pm2');
  // exec: otherwise the shell `script` wraps it in takes the Ctrl-C too, and reports its own exit.
  const r = await terminal(repo, 'exec node scripts/update.js', [['Go ahead?', 'y\r'], ['Installing packages', '\u0003']]);
  check('Ctrl-C during the packages: it goes back and starts it, rather than leave it stopped', r.answered === r.total && r.code === 1 && headOf(repo) === old && pidAlive(pidOf(repo)) && r.out.includes('Back on the old version and running'), `${r.code} ${r.answered}/${r.total} ${r.out.slice(-500)}`);
  await stopBot(repo);
}
{
  const repo = scaffold('fail-pull');
  const old = headOf(repo);
  publish(repo, { 'clash.txt': 'theirs' });
  fs.writeFileSync(path.join(repo.dir, 'clash.txt'), 'mine');
  await startBot(repo, 'pm2');
  const r = upd(repo);
  check('pull fails: exit 1, and it\'s running again on the same code', r.code === 1 && headOf(repo) === old && pidAlive(pidOf(repo)), `${r.code} ${r.out}`);
  check('pull fails: no packages reinstalled, and the untracked file stays', !callsOf(repo).includes('npm ci') && fs.readFileSync(path.join(repo.dir, 'clash.txt'), 'utf-8') === 'mine');
  await stopBot(repo);
}
{
  const repo = scaffold('fail-boot');
  const old = headOf(repo);
  publish(repo, { 'src/index.js': botSource('at-once') });
  await startBot(repo, 'pm2');
  const t0 = Date.now();
  const r = upd(repo);   // the real 30 second wait
  const secs = (Date.now() - t0) / 1000;
  check('the new code never comes up: exit 1, after the whole wait', r.code === 1 && r.out.includes('didn\'t stay up within 30 seconds') && secs >= 30, `${r.code} ${secs}s ${r.out}`);
  check('the code is back and the old copy runs', headOf(repo) === old && pidAlive(pidOf(repo)) && r.out.includes('Back on the old version and running'), r.out);
  check('lockfile unchanged: no npm ci on the way back either', !callsOf(repo).includes('npm ci'), callsOf(repo));
  await stopBot(repo);
}
{
  const repo = scaffold('fail-migrated');
  const old = headOf(repo);
  publish(repo, { ...NEW_MIGRATION, 'src/index.js': botSource('after-migrating') });
  await startBot(repo, 'pm2');
  const db = path.join(repo.dir, 'data/karyasthan.db');
  const r = upd(repo, ['--yes'], { KARYASTHAN_UPDATE_WAIT_MS: '6000' });
  check('it migrated, then died: exit 1, a copy that holds the lock for a moment isn\'t up', r.code === 1 && r.out.includes('didn\'t stay up'), `${r.code} ${r.out}`);
  check('the code went back', headOf(repo) === old);
  check('the database was not restored by itself', dbV(db) === 22);
  check('old code would refuse it, so it wasn\'t started', !pidAlive(pidOf(repo)) && r.out.includes('wasn\'t started') && r.out.includes('v22'), r.out);
  check('it says this loses messages', r.out.includes('loses every message'), r.out);
  const lines = r.out.split('\n').map((l) => l.trim());
  const from = lines.findIndex((l) => l.startsWith('mv '));
  const printed = lines.slice(from, from + 6);
  check('the exact steps are printed, ending in the start', from > 0 && printed.some((l) => l.startsWith('cp ')) && printed[5] === 'pm2 start karyasthan', printed.join('\n'));
  // The printed steps, run as printed, by a person.
  const db2 = new Database(db); db2.prepare('INSERT INTO messages (t) VALUES (?)').run('after the backup'); db2.close();
  const run = spawnSync('bash', ['-ec', printed.join('\n')], { cwd: repo.dir, env: repo.env(), encoding: 'utf-8' });
  const up = await waitSteady([path.join(repo.dir, 'data')], { timeoutMs: 8000, steadyMs: 300 });
  check('the printed steps work: the old code starts on the backup', run.status === 0 && up && dbV(db) === 21 && mode(db) === '600', `${run.status} ${run.stderr}`);
  const aside = fs.readdirSync(path.join(repo.dir, 'data')).find((f) => f.includes('.old-') && f.endsWith(fs.readdirSync(path.join(repo.dir, 'data')).find((x) => x.includes('.old-')).split('.old-')[1]));
  check('the migrated copy was kept, with what it held', Boolean(aside) && new Database(path.join(repo.dir, 'data', aside), { readonly: true }).prepare('SELECT COUNT(*) c FROM messages WHERE t = ?').get('after the backup').c === 1, aside);
  await stopBot(repo);
}

// ── backup ────────────────────────────────────────────────────────────────────
section('backup');
function fillInstall(dir, { env = '' } = {}) {
  fs.writeFileSync(path.join(dir, '.env'), `GEMINI_API_KEY=SECRETGEMINI-1234\nWA_PHONE_NUMBER=15550100123\n${env}`, { mode: 0o600 });
  const session = path.join(dir, 'data/auth_info_baileys');
  fs.mkdirSync(path.join(session, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(session, 'creds.json'), '{"registered":true,"me":{"id":"1"}}');
  fs.writeFileSync(path.join(session, 'keys/app-state.json'), '{}');
  fs.symlinkSync('/etc/hostname', path.join(session, 'a-link'));
  fs.writeFileSync(path.join(dir, 'data/llm-prices.json'), '{}');
  fs.writeFileSync(path.join(dir, 'data/warmup.json'), '{"startDate":"2026-01-01"}');
  for (const f of ['persona.json', 'identity.md', 'world.json', 'arcs.json', 'taste.json', 'phrases.json']) fs.writeFileSync(path.join(dir, 'src/personality', f), `mine ${f}`);
  for (const p of ['data/media-cache/gifs/g.gif', 'data/asterisk/a.conf', 'data/searxng/settings.yml', 'data/backups/older.tar.gz', 'data/instagram/thumbs/t.jpg', 'logs/install.log']) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), 'x');
  }
}
const bk = (repo, args = [], extra = {}) => noTerminal(repo, 'scripts/backup.js', args, extra);
const archiveOf = (repo) => path.join(repo.dir, 'data/backups', fs.readdirSync(path.join(repo.dir, 'data/backups')).find((f) => f.startsWith('karyasthan-backup-')));
const tarList = (file) => spawnSync('tar', ['-tzf', file], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean);

const srcRepo = scaffold('backup-src');
fillInstall(srcRepo.dir);
const dbWriter = new Database(path.join(srcRepo.dir, 'data/karyasthan.db'));
dbWriter.pragma('wal_autocheckpoint = 0');
dbWriter.prepare('INSERT INTO messages (t) VALUES (?)').run('only in the wal');
const madeBackup = bk(srcRepo);
dbWriter.close();
const archive = archiveOf(srcRepo);
const listed = tarList(archive);
check('exit 0, one file, private', madeBackup.code === 0 && mode(archive) === '600' && /karyasthan-backup-\d{8}T\d{6}Z\.tar\.gz$/.test(archive), `${madeBackup.code} ${madeBackup.out}`);
check('it says it holds secrets, and shows none', /keys, your WhatsApp session and your chats/.test(madeBackup.out) && !madeBackup.out.includes('SECRETGEMINI') && !madeBackup.out.includes('15550100123'), madeBackup.out);
for (const want of ['.env', 'data/karyasthan.db', 'data/auth_info_baileys/creds.json', 'data/auth_info_baileys/keys/app-state.json', 'data/llm-prices.json', 'data/warmup.json', 'src/personality/persona.json', 'src/personality/identity.md', 'src/personality/world.json', 'src/personality/arcs.json', 'src/personality/taste.json', 'src/personality/phrases.json', 'karyasthan-backup.json']) {
  check(`holds ${want}`, listed.includes(want), listed.join(' '));
}
for (const leave of ['media-cache', 'data/backups', 'logs', 'data/asterisk', 'data/searxng', 'data/instagram', '.instance-lock', '-wal', '-shm', 'node_modules', 'a-link', 'persona.example', 'scripts/']) {
  check(`leaves out ${leave}`, !listed.some((f) => f.includes(leave)), listed.join(' '));
}
check('its own work folder is gone', !fs.readdirSync(path.join(srcRepo.dir, 'data/backups')).some((f) => f.startsWith('.work')));
const peek = fs.mkdtempSync(path.join(SCRATCH, 'peek-'));
spawnSync('tar', ['-xzf', archive, '-C', peek]);
const peeked = new Database(path.join(peek, 'data/karyasthan.db'), { readonly: true });
check('the database copy opens, with a message that was only in the write-ahead file', peeked.prepare('SELECT COUNT(*) c FROM messages WHERE t = ?').get('only in the wal').c === 1 && !fs.existsSync(path.join(peek, 'data/karyasthan.db-wal')));
peeked.close();
const manifest = JSON.parse(fs.readFileSync(path.join(peek, 'karyasthan-backup.json'), 'utf-8'));
check('it notes the commit and schema, and no secret', manifest.commit === headOf(srcRepo) && manifest.schema === 21 && !JSON.stringify(manifest).includes('SECRET'));
{
  const repo = scaffold('backup-empty');
  fs.rmSync(path.join(repo.dir, '.env'));
  fs.rmSync(path.join(repo.dir, 'data/karyasthan.db'), { force: true });
  for (const s of ['-wal', '-shm']) fs.rmSync(path.join(repo.dir, `data/karyasthan.db${s}`), { force: true });
  const r = bk(repo);
  check('nothing to back up: says so, exit 1', r.code === 1 && r.out.includes('nothing here to back up'), `${r.code} ${r.out}`);
}
{
  const repo = scaffold('backup-running');
  fillInstall(repo.dir);
  await startBot(repo, 'pm2');
  const r = bk(repo);
  check('a running bot doesn\'t stop a backup, and keeps running', r.code === 0 && pidAlive(pidOf(repo)), `${r.code} ${r.out}`);
  await stopBot(repo);
}

section('restore');
const rst = (repo, file, extra = []) => bk(repo, ['--restore', file, ...extra]);
const emptyRepo = (name) => {
  const repo = scaffold(name);
  for (const f of ['.env', 'data']) fs.rmSync(path.join(repo.dir, f), { recursive: true, force: true });
  return repo;
};
{
  const repo = emptyRepo('restore-fresh');
  const r = rst(repo, archive);
  check('a fresh install: exit 0', r.code === 0, `${r.code} ${r.out}`);
  check('everything is back', fs.readFileSync(path.join(repo.dir, '.env'), 'utf-8').includes('SECRETGEMINI') && fs.existsSync(path.join(repo.dir, 'data/auth_info_baileys/keys/app-state.json')) && fs.readFileSync(path.join(repo.dir, 'src/personality/persona.json'), 'utf-8') === 'mine persona.json' && fs.existsSync(path.join(repo.dir, 'data/warmup.json')));
  check('the database opens, at its version', dbV(path.join(repo.dir, 'data/karyasthan.db')) === 21);
  check('all of it is private', mode(path.join(repo.dir, '.env')) === '600' && mode(path.join(repo.dir, 'data')) === '700' && mode(path.join(repo.dir, 'data/karyasthan.db')) === '600' && mode(path.join(repo.dir, 'data/auth_info_baileys')) === '700' && mode(path.join(repo.dir, 'data/auth_info_baileys/creds.json')) === '600');
  check('it warns plainly about two machines on one session', /Two machines running one WhatsApp session knock each other off/.test(r.out) && /Stop the old copy/.test(r.out), r.out);
  check('no key on the screen, no work folder left', !r.out.includes('SECRETGEMINI') && !fs.readdirSync(path.join(repo.dir, 'data/backups')).some((f) => f.startsWith('.work')));
  const relative = emptyRepo('restore-relative');
  const typedFrom = path.dirname(archive);
  const rr = rst(relative, path.basename(archive), []);
  check('a relative path from the wrong folder isn\'t found', rr.code === 2 && rr.out.includes('no such file'), rr.out);
  const rr2 = noTerminal(relative, 'scripts/backup.js', ['--restore', path.basename(archive)], { INIT_CWD: typedFrom });
  check('a relative path is taken from where it was typed, under npm', rr2.code === 0, rr2.out);
}
{
  const repo = emptyRepo('restore-running');
  fs.mkdirSync(path.join(repo.dir, 'data'), { mode: 0o700 });
  const db = new Database(path.join(repo.dir, 'data/karyasthan.db'));
  db.pragma('user_version = 21');
  db.close();
  const bot = spawn(process.execPath, [path.join(repo.dir, 'src/index.js')], { cwd: repo.dir, stdio: 'ignore', env: repo.env() });
  await waitSteady([path.join(repo.dir, 'data')], { timeoutMs: 8000, steadyMs: 300 });
  const r = rst(repo, archive);
  const rf = rst(repo, archive, ['--force']);
  check('a copy running here: refused, exit 2, even with --force', r.code === 2 && rf.code === 2 && rf.out.includes('running here') && !fs.existsSync(path.join(repo.dir, '.env')), `${r.code} ${rf.code} ${rf.out}`);
  bot.kill('SIGTERM');
  await sleep(200);
}
{
  const repo = scaffold('restore-existing');
  fillInstall(repo.dir);
  fs.writeFileSync(path.join(repo.dir, 'data/auth_info_baileys/creds.json'), '{"registered":true,"me":{"id":"this one"}}');
  fs.writeFileSync(path.join(repo.dir, 'data/karyasthan.db-wal'), 'old wal');
  fs.writeFileSync(path.join(repo.dir, 'src/personality/persona.json'), 'this persona');
  const envBefore = 'THIS_ENV=1\n';
  fs.writeFileSync(path.join(repo.dir, '.env'), envBefore);
  const r = rst(repo, archive);
  check('a session and database here: refused, exit 2, each named', r.code === 2 && r.out.includes('data/auth_info_baileys') && r.out.includes('data/karyasthan.db') && r.out.includes('--force'), `${r.code} ${r.out}`);
  check('refused means nothing moved', fs.readFileSync(path.join(repo.dir, '.env'), 'utf-8') === envBefore && fs.readFileSync(path.join(repo.dir, 'src/personality/persona.json'), 'utf-8') === 'this persona');
  const rf = rst(repo, archive, ['--force']);
  check('--force: exit 0', rf.code === 0, `${rf.code} ${rf.out}`);
  check('--force: what\'s restored is in place', JSON.parse(fs.readFileSync(path.join(repo.dir, 'data/auth_info_baileys/creds.json'), 'utf-8')).me.id === '1' && fs.readFileSync(path.join(repo.dir, 'src/personality/persona.json'), 'utf-8') === 'mine persona.json');
  const data = fs.readdirSync(path.join(repo.dir, 'data'));
  const oldSession = data.find((f) => f.startsWith('auth_info_baileys.old-'));
  const oldDb = data.find((f) => /^karyasthan\.db\.old-[\d-]+$/.test(f));
  const oldWal = data.find((f) => f === `${oldDb}-wal`);
  check('--force: the old session, database and write-ahead file were moved aside, nothing deleted', Boolean(oldSession && oldDb && oldWal) && JSON.parse(fs.readFileSync(path.join(repo.dir, 'data', oldSession, 'creds.json'), 'utf-8')).me.id === 'this one', data.join());
  check('--force: no stale write-ahead file beside the restored database', !fs.existsSync(path.join(repo.dir, 'data/karyasthan.db-wal')) && dbV(path.join(repo.dir, 'data/karyasthan.db')) === 21);
  const oldEnv = fs.readdirSync(repo.dir).find((f) => f.startsWith('.env.old-'));
  const oldPersona = fs.readdirSync(path.join(repo.dir, 'src/personality')).find((f) => f.startsWith('persona.json.bak.'));
  check('--force: the old .env and character were moved aside too', fs.readFileSync(path.join(repo.dir, oldEnv), 'utf-8') === envBefore && fs.readFileSync(path.join(repo.dir, 'src/personality', oldPersona), 'utf-8') === 'this persona');
  const status = gitIn(repo.dir, 'status', '--porcelain', '--untracked-files=all');
  check('what\'s moved aside stays out of git', !/persona|\.env|identity|auth_info/.test(status), status);
}
{
  const repo = scaffold('restore-custom');
  fillInstall(repo.dir, { env: 'DB_PATH=./data/custom/my.db\nAUTH_PATH=./data/my_session\n' });
  fs.mkdirSync(path.join(repo.dir, 'data/custom'), { recursive: true });
  fs.renameSync(path.join(repo.dir, 'data/karyasthan.db'), path.join(repo.dir, 'data/custom/my.db'));
  fs.renameSync(path.join(repo.dir, 'data/auth_info_baileys'), path.join(repo.dir, 'data/my_session'));
  const r = bk(repo);
  const file = archiveOf(repo);
  check('custom paths under data/: kept as they are', r.code === 0 && tarList(file).includes('data/custom/my.db') && tarList(file).includes('data/my_session/creds.json'), `${r.out} ${tarList(file).join(' ')}`);
  const to = emptyRepo('restore-custom-to');
  const rr = rst(to, file);
  check('...and back to the same places, with no warning', rr.code === 0 && fs.existsSync(path.join(to.dir, 'data/custom/my.db')) && fs.existsSync(path.join(to.dir, 'data/my_session/creds.json')) && !rr.out.includes('points elsewhere'), rr.out);
}
{
  const repo = scaffold('restore-outside');
  const outsideSession = path.join(repo.base, 'session-elsewhere');
  fillInstall(repo.dir, { env: `AUTH_PATH=${outsideSession}\n` });
  fs.renameSync(path.join(repo.dir, 'data/auth_info_baileys'), outsideSession);
  const r = bk(repo);
  const file = archiveOf(repo);
  check('a session outside data/ still goes in, and it says where a restore puts it', r.code === 0 && tarList(file).includes('data/auth_info_baileys/creds.json') && r.out.includes('AUTH_PATH points outside data/'), `${r.out}`);
  const to = emptyRepo('restore-outside-to');
  const rr = rst(to, file);
  check('restoring it warns that AUTH_PATH points elsewhere', rr.code === 0 && rr.out.includes('AUTH_PATH in .env points elsewhere'), rr.out);
}
{
  const repo = scaffold('restore-newer');
  fillInstall(repo.dir);
  const d = new Database(path.join(repo.dir, 'data/karyasthan.db')); d.pragma('user_version = 99'); d.close();
  bk(repo);
  const to = emptyRepo('restore-newer-to');
  const rr = rst(to, archiveOf(repo));
  check('a database newer than this code: restored, with a warning to update', rr.code === 0 && rr.out.includes('newer (v99)') && rr.out.includes('npm run update'), rr.out);
}

section('restore: a malicious tarball');
check('entries: a plain backup passes', checkEntries([{ name: '.env', type: '-' }, { name: './data/', type: 'd' }, { name: 'data/x.db', type: '-' }, { name: 'src/personality/persona.json', type: '-' }, { name: 'karyasthan-backup.json', type: '-' }]).ok);
const whyOf = (name, type = '-') => checkEntries([{ name, type }]).bad[0]?.why || '';
check('entries: an absolute path', whyOf('/etc/passwd') === 'an absolute path');
check('entries: climbing out', whyOf('../x') === 'a path outside the project' && whyOf('data/../../x') === 'a path outside the project' && whyOf('./../x') === 'a path outside the project');
check('entries: links', whyOf('data/x', 'l') === 'a link' && whyOf('data/x', 'h') === 'a link');
check('entries: devices and pipes', whyOf('data/x', 'c') === 'not a plain file' && whyOf('data/x', 'p') === 'not a plain file' && whyOf('data/x', 'b') === 'not a plain file');
check('entries: inside the project, but code', ['src/index.js', 'package.json', '.git/hooks/post-merge', 'scripts/x.js', 'node_modules/x/index.js', 'src/personality/capabilities.js', '.envrc'].every((n) => whyOf(n) === 'not something a backup holds'));
check('entries: its own work folder and the lock', whyOf('data/backups/x') !== '' && whyOf('data/.instance-lock') !== '');
check('entries: a file where a folder goes', whyOf('data') !== '' && whyOf('src/personality') !== '');
check('entries: a folder where .env goes', whyOf('.env', 'd') !== '');
check('entries: a strange name', whyOf('data/a\nb') === 'a strange name' && whyOf('data/a\\b') === 'a strange name');

// Tarballs written byte by byte, so each case is exactly what it says and no tar tidied it up.
const evilOutside = path.join(SCRATCH, 'evil-landed.txt');
function rawTar(entries) {
  const blocks = [];
  const header = (name, type, size, link = '') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0); h.write('0000644', 100); h.write('0000000', 108); h.write('0000000', 116);
    h.write(size.toString(8).padStart(11, '0'), 124); h.write('00000000000', 136);
    h.write(type, 156); h.write(link, 157); h.write('ustar  \0', 257);
    h.fill(' ', 148, 156);
    let sum = 0; for (const c of h) sum += c;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const addBody = (body) => {
    const buf = Buffer.from(body);
    blocks.push(buf, Buffer.alloc((512 - (buf.length % 512)) % 512));
  };
  for (const e of [{ name: '.env', body: 'EVIL=1\n' }, { name: 'karyasthan-backup.json', body: '{}' }, ...entries]) {
    const body = e.body ?? '';
    if (e.gnuLong) { blocks.push(header('././@LongLink', 'L', e.gnuLong.length + 1)); addBody(`${e.gnuLong}\0`); }
    if (e.pax) {
      const line = (k, v) => { let n = k.length + v.length + 3; n += String(n).length; n = k.length + v.length + 3 + String(n).length; return `${n} ${k}=${v}\n`; };
      const text = line('path', e.pax);
      blocks.push(header('PaxHeader/x', 'x', text.length));
      addBody(text);
    }
    blocks.push(header(e.name, e.type || '0', Buffer.byteLength(body), e.link || ''));
    if (body) addBody(body);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const padded = `data/${'deep/'.repeat(30)}`;
const evilCases = {
  'a path with ..': [{ name: '../evil-landed.txt', body: 'evil' }, 'a path outside the project'],
  '.. in the middle': [{ name: 'data/../../../evil-landed.txt', body: 'evil' }, 'a path outside the project'],
  'an absolute path': [{ name: evilOutside, body: 'evil' }, 'an absolute path'],
  'a symlink, then a write through it': [[{ name: 'data/out', type: '2', link: SCRATCH }, { name: 'data/out/evil-landed.txt', body: 'evil' }], 'a link'],
  'a hard link to something outside': [{ name: 'data/b', type: '1', link: evilOutside }, 'a link'],
  'a device': [{ name: 'data/dev', type: '3' }, 'not a plain file'],
  'a pipe': [{ name: 'data/fifo', type: '6' }, 'not a plain file'],
  'a long name that climbs out': [{ name: 'data/short', gnuLong: `${padded}${'../'.repeat(33)}evil-landed.txt`, body: 'evil' }, 'a path outside the project'],
  'a pax name that climbs out': [{ name: 'data/short', pax: '../evil-landed.txt', body: 'evil' }, 'a path outside the project'],
  'code inside the project': [{ name: 'src/index.js', body: 'evil' }, 'not something a backup holds'],
  'a git hook': [{ name: '.git/hooks/post-merge', body: 'evil' }, 'not something a backup holds'],
  'a package manifest': [{ name: 'package.json', body: '{}' }, 'not something a backup holds'],
};
for (const [what, [entry, why]] of Object.entries(evilCases)) {
  const slug = what.replace(/\W+/g, '-');
  const file = path.join(SCRATCH, `e-${slug}.tar.gz`);
  fs.writeFileSync(file, rawTar([entry].flat()));
  const repo = emptyRepo(`evil-${slug}`);
  const entries = listEntries(file);
  const r = rst(repo, file, ['--force']);
  check(`${what}: as tar reads it, it's caught for that reason`, Boolean(entries) && checkEntries(entries).bad.some((x) => x.why === why), JSON.stringify(entries));
  check(`${what}: refused before extracting, exit 2`, r.code === 2 && r.out.includes('isn\'t a safe backup') && r.out.includes(why), `${r.code} ${r.out}`);
  check(`${what}: nothing landed`, !fs.existsSync(path.join(repo.dir, '.env')) && !fs.existsSync(evilOutside) && gitIn(repo.dir, 'status', '--porcelain') === '', gitIn(repo.dir, 'status', '--porcelain'));
}
{
  const repo = emptyRepo('evil-junk');
  const junk = path.join(SCRATCH, 'junk.tar.gz');
  fs.writeFileSync(junk, 'this is not a tarball');
  const r = rst(repo, junk);
  check('junk: says it can\'t be read, exit 2', r.code === 2 && r.out.includes('can\'t be read'), `${r.code} ${r.out}`);
  const r2 = bk(repo, ['--restore']);
  check('no file given: says which, exit 2', r2.code === 2 && r2.out.includes('Which file'), r2.out);
  const d = path.join(SCRATCH, 'e-other'); fs.mkdirSync(path.join(d, 'data'), { recursive: true });
  fs.writeFileSync(path.join(d, 'data/x'), 'x');
  const other = path.join(SCRATCH, 'e-other.tar.gz');
  spawnSync('tar', ['-czf', other, '-C', d, 'data']);
  const r3 = rst(repo, other);
  check('a tarball that isn\'t a backup at all: refused', r3.code === 2 && r3.out.includes('doesn\'t look like a backup'), r3.out);
}

// ── uninstall ─────────────────────────────────────────────────────────────────
section('uninstall: refusals');
const U = 'node scripts/uninstall.js';
if (!hasScript) console.log('  skip  no `script` command here');
else {
  const repo = scaffold('un-live');
  fillInstall(repo.dir);
  gitIn(repo.dir, 'checkout', '-q', '-b', 'live');
  const r = await terminal(repo, U, []);
  check('branch live: refused by name, exit 2', r.code === 2 && r.out.includes('"live"') && r.out.includes('Nothing was removed'), `${r.code} ${r.out}`);
  check('branch live: nothing touched, not even asked of pm2', fs.existsSync(path.join(repo.dir, '.env')) && fs.existsSync(path.join(repo.dir, 'data/karyasthan.db')) && callsOf(repo) === '', callsOf(repo));
  const detached = scaffold('un-detached');
  gitIn(detached.dir, 'checkout', '-q', '--detach');
  const r2 = await terminal(detached, U, []);
  check('a detached HEAD: refused, exit 2', r2.code === 2 && fs.existsSync(path.join(detached.dir, '.env')), `${r2.code} ${r2.out}`);
  const noRepo = scaffold('un-nogit');
  fs.rmSync(path.join(noRepo.dir, '.git'), { recursive: true, force: true });
  const r3 = await terminal(noRepo, U, []);
  check('not a checkout: refused, exit 2', r3.code === 2 && fs.existsSync(path.join(noRepo.dir, '.env')), `${r3.code} ${r3.out}`);
}
{
  const repo = scaffold('un-noterm');
  const r = noTerminal(repo, 'scripts/uninstall.js');
  check('no terminal: refused, exit 2, nothing removed', r.code === 2 && r.out.includes('person at a terminal') && fs.existsSync(path.join(repo.dir, '.env')), `${r.code} ${r.out}`);
}

if (hasScript) {
  section('uninstall: the list, and the word');
  {
    const repo = scaffold('un-word');
    fillInstall(repo.dir);
    fs.writeFileSync(path.join(repo.dir, 'data/auth_info_baileys/creds.json'), '{}');
    const up = await startBot(repo, 'pm2');
    fs.writeFileSync(path.join(repo.state, 'pm2-list.json'), JSON.stringify([{ pm_id: 3, name: 'karyasthan', pm2_env: { pm_cwd: repo.dir, pm_out_log_path: path.join(repo.base, 'out.log'), SECRET_LOOKING: 'SECRETINPM2' } }]));
    const r = await terminal(repo, U, [
      ['Make a backup first?', 'n\r'],
      ['Type the word delete', 'yes\r'],
    ]);
    check('it asked everything', r.answered === r.total, `${r.answered}/${r.total} ${r.out}`);
    check('another word: nothing removed, exit 0', r.code === 0 && r.out.includes('Nothing was removed'), `${r.code} ${r.out}`);
    for (const f of ['.env', 'data/karyasthan.db', 'src/personality/persona.json']) check(`another word: ${f} is still there`, fs.existsSync(path.join(repo.dir, f)));
    check('another word: it keeps running', pidAlive(up.pid) && !callsOf(repo).includes('pm2 delete'), callsOf(repo));
    check('the list names the service, the running copy, and every kind of file', r.out.includes('the pm2 entry "karyasthan"') && r.out.includes(`the running copy (pid ${up.pid})`) && r.out.includes('.env  (your keys') && r.out.includes('data  (database') && r.out.includes('1 older backup') && r.out.includes('src/personality/persona.json') && r.out.includes('src/personality/world.json') && r.out.includes('node_modules'), r.out);
    check('nothing tracked is on the list', !r.out.includes('.env.example') && !r.out.includes('persona.example.json') && !r.out.includes('identity.example.md'), r.out);
    check('the list says what stays', r.out.includes('This stays') && r.out.includes('This folder\'s code') && r.out.includes('out.log') && r.out.includes('Your model keys'), r.out);
    check('nothing outside is set up here, so none is listed or offered', r.out.includes('nothing set up') && !r.out.includes('R2') && !r.out.includes('cloned voice') && !r.out.includes('Linked Devices'), r.out);
    check('no secret on the screen', !r.out.includes('SECRETGEMINI') && !r.out.includes('SECRETINPM2') && !r.out.includes('15550100123'), r.out);
    const r2 = await terminal(repo, U, [['Make a backup first?', 'n\r'], ['Type the word delete', 'DELETE\r']]);
    check('the word is exact: DELETE won\'t do', r2.code === 0 && fs.existsSync(path.join(repo.dir, '.env')), r2.out.slice(-200));
    const r3 = await terminal(repo, U, [['Make a backup first?', 'n\r'], ['Type the word delete', '\u0003']]);
    check('Ctrl-C: nothing removed, exit 130, no stack trace', r3.code === 130 && fs.existsSync(path.join(repo.dir, '.env')) && !r3.out.includes('    at '), `${r3.code} ${r3.out.slice(-200)}`);
    await stopBot(repo);
  }
  {
    const repo = scaffold('un-configured');
    fillInstall(repo.dir, { env: `R2_ENDPOINT=https://${'a'.repeat(32)}.r2.cloudflarestorage.com\nR2_BUCKET=my-bucket\nR2_ACCESS_KEY_ID=KEYID123\nR2_SECRET_ACCESS_KEY=SECRETR2KEY\n` });
    const db = new Database(path.join(repo.dir, 'data/karyasthan.db'));
    db.exec('CREATE TABLE person_voice (person_jid TEXT PRIMARY KEY, voice_id TEXT, revoked_at INTEGER, revoke_reason TEXT)');
    db.prepare('INSERT INTO person_voice VALUES (?,?,?,?)').run('1@s.whatsapp.net', 'voice_a', null, null);
    db.prepare('INSERT INTO person_voice VALUES (?,?,?,?)').run('2@s.whatsapp.net', 'voice_b', 123, `revoked${DELETE_PENDING_SUFFIX}`);
    db.prepare('INSERT INTO person_voice VALUES (?,?,?,?)').run('3@s.whatsapp.net', 'voice_c', 123, 'revoked');
    db.close();
    const r = await terminal(repo, U, [
      ['Make a backup first?', 'n\r'],
      ['public site offline first?', 'n\r'],
      ['cloned voices at Google first?', 'n\r'],
      ['Type the word delete', 'no\r'],
    ]);
    check('configured: the site is listed, with its bucket', r.answered === r.total && r.out.includes('R2 bucket my-bucket') && r.out.includes('The bucket and the site in your Cloudflare account'), `${r.answered}/${r.total} ${r.out}`);
    check('configured: voices that may still exist are counted, a settled one isn\'t', r.out.includes('2 cloned voices at Google'), r.out);
    check('configured: the linked device, which only the phone can remove', r.out.includes('Only the phone can remove it: WhatsApp, Linked Devices') && !r.out.includes('15550100123'), r.out);
    check('configured: no key on the screen', !r.out.includes('SECRETR2KEY') && !r.out.includes('KEYID123') && !r.out.includes('SECRETGEMINI'), r.out);
    const fileText = fs.readFileSync(path.join(ROOT, 'scripts/uninstall.js'), 'utf-8');
    check('the voice query uses the store\'s own marker', fileText.includes(`LIKE '%${DELETE_PENDING_SUFFIX}'`));
  }
  {
    const repo = scaffold('un-badr2');
    fillInstall(repo.dir, { env: 'R2_ENDPOINT=https://example.com\nR2_BUCKET=b\n' });
    const r = await terminal(repo, U, [['Make a backup first?', 'n\r'], ['Type the word delete', 'no\r']]);
    check('half-set R2 settings: said plainly, not offered', r.answered === r.total && r.out.includes('they don\'t work') && !r.out.includes('offline first'), r.out);
  }

  section('uninstall: all the way');
  {
    const repo = scaffold('un full');
    fillInstall(repo.dir);
    fs.writeFileSync(path.join(repo.dir, '.env.bak.1700000000000'), 'SECRET=old');
    fs.writeFileSync(path.join(repo.dir, 'src/personality/identity.md.bak.1700000000000'), 'old');
    const decoy = path.join(repo.base, 'decoy-packages');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'keep.js'), 'keep');
    fs.rmSync(path.join(repo.dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(decoy, path.join(repo.dir, 'node_modules'));
    const up = await startBot(repo, 'pm2');
    fs.writeFileSync(path.join(repo.state, 'pm2-list.json'), JSON.stringify([{ pm_id: 7, name: 'karyasthan', pm2_env: { pm_cwd: repo.dir } }]));
    const r = await terminal(repo, U, [
      ['Make a backup first?', '\r'],
      ['Type the word delete', 'delete\r'],
    ]);
    const calls = callsOf(repo);
    check('it asked everything and exits 0', r.answered === r.total && r.code === 0, `${r.code} ${r.out}`);
    check('the service: pm2 entry deleted by id, list saved, copy stopped', calls.includes('pm2 delete 7') && calls.includes('pm2 save') && !pidAlive(up.pid), calls);
    for (const gone of ['.env', '.env.bak.1700000000000', 'data', 'src/personality/persona.json', 'src/personality/identity.md', 'src/personality/world.json', 'src/personality/arcs.json', 'src/personality/taste.json', 'src/personality/phrases.json', 'src/personality/identity.md.bak.1700000000000']) {
      check(`gone: ${gone}`, !fs.existsSync(path.join(repo.dir, gone)));
    }
    check('gone: node_modules, a link goes and not what it points at', !fs.existsSync(path.join(repo.dir, 'node_modules')) && fs.existsSync(path.join(decoy, 'keep.js')));
    check('the code stays, and git sees nothing deleted', fs.existsSync(path.join(repo.dir, 'scripts/uninstall.js')) && fs.existsSync(path.join(repo.dir, '.env.example')) && fs.existsSync(path.join(repo.dir, 'src/personality/persona.example.json')) && gitIn(repo.dir, 'status', '--porcelain') === '', gitIn(repo.dir, 'status', '--porcelain'));
    const backup = path.join(repo.base, fs.readdirSync(repo.base).find((f) => f.startsWith('karyasthan-backup-')) || 'none');
    check('the backup went outside the folder, so it survived', fs.existsSync(backup) && !isInside(repo.dir, backup) && mode(backup) === '600' && r.out.includes(backup), r.out);
    check('its parent folder keeps its own mode', mode(repo.base) !== '700' || fs.statSync(repo.base).mode === fs.statSync(path.join(SCRATCH, 'un-live')).mode);
    check('the backup holds what was deleted', tarList(backup).includes('.env') && tarList(backup).includes('data/karyasthan.db'));
    const to = emptyRepo('un-restore-to');
    const rr = rst(to, backup);
    check('...and it restores', rr.code === 0 && fs.existsSync(path.join(to.dir, 'data/auth_info_baileys/creds.json')), rr.out);
    const line = r.out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('rm -rf'));
    check('the one rm -rf line, quoted for the space in the path', line === `rm -rf '${repo.dir}'`, line);
    check('no secret on the screen', !r.out.includes('SECRETGEMINI'), r.out);
    check('it said to remove the device on the phone', r.out.includes('On the phone'), r.out);
  }
  {
    const repo = scaffold('un-systemd');
    fillInstall(repo.dir);
    const home = path.join(repo.base, 'home');
    const unit = path.join(home, '.config/systemd/user/karyasthan.service');
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Service]\nWorkingDirectory=${repo.dir}\n`);
    const up = await startBot(repo, 'systemd');
    const r = await terminal(repo, U, [['Make a backup first?', 'n\r'], ['Type the word delete', 'delete\r']], { env: { HOME: home } });
    const calls = callsOf(repo);
    check('a systemd user service of this folder: disabled, stopped, its file removed', r.code === 0 && calls.includes('--user disable --now karyasthan') && calls.includes('daemon-reload') && !fs.existsSync(unit) && !pidAlive(up.pid), `${r.code} ${calls}\n${r.out}`);
    check('...and it was on the list', r.out.includes(`the systemd user service ${unit}`), r.out);
  }
  {
    const repo = scaffold('un-others');
    fillInstall(repo.dir);
    const other = path.join(repo.base, 'other-install');
    fs.mkdirSync(other);
    const home = path.join(repo.base, 'home');
    const unit = path.join(home, '.config/systemd/user/karyasthan.service');
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Service]\nWorkingDirectory=${other}\n`);
    fs.writeFileSync(path.join(repo.state, 'pm2-list.json'), JSON.stringify([{ pm_id: 1, name: 'karyasthan', pm2_env: { pm_cwd: other } }]));
    const r = await terminal(repo, U, [['Make a backup first?', 'n\r'], ['Type the word delete', 'delete\r']], { env: { HOME: home } });
    const calls = callsOf(repo);
    check('another folder\'s pm2 entry and service, under the same name: left alone', r.code === 0 && !calls.includes('pm2 delete') && !calls.includes('disable') && fs.existsSync(unit), `${r.code} ${calls}\n${r.out}`);
    check('...and it says so', r.out.includes('belongs to another folder'), r.out);
    check('...while this install\'s files go', !fs.existsSync(path.join(repo.dir, '.env')));
  }
  {
    const repo = scaffold('un-handrun');
    fillInstall(repo.dir);
    const bot = spawn(process.execPath, [path.join(repo.dir, 'src/index.js')], { cwd: repo.dir, stdio: 'ignore', env: repo.env() });
    await waitSteady([path.join(repo.dir, 'data')], { timeoutMs: 8000, steadyMs: 300 });
    const r = await terminal(repo, U, [['Make a backup first?', 'n\r'], ['Type the word delete', 'delete\r']], { timeoutMs: 40000 });
    check('a copy nothing manages is stopped too', r.code === 0 && !pidAlive(bot.pid) && r.out.includes('Stopped the running copy') && !fs.existsSync(path.join(repo.dir, 'data')), `${r.code} ${r.out}`);
  }
  {
    const repo = scaffold('un-custom');
    const outside = path.join(repo.base, 'session-elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'creds.json'), '{"registered":true}');
    fillInstall(repo.dir, { env: `AUTH_PATH=${outside}\nDB_PATH=./own-data/my.db\n` });
    fs.mkdirSync(path.join(repo.dir, 'own-data'));
    fs.renameSync(path.join(repo.dir, 'data/karyasthan.db'), path.join(repo.dir, 'own-data/my.db'));
    const r = await terminal(repo, U, [['Make a backup first?', 'n\r'], ['Type the word delete', 'delete\r']]);
    check('a database elsewhere inside the folder goes', r.code === 0 && !fs.existsSync(path.join(repo.dir, 'own-data/my.db')), `${r.code} ${r.out}`);
    check('a path in .env outside the folder is left, and listed', fs.existsSync(path.join(outside, 'creds.json')) && r.out.includes(`${outside}, set in .env, outside this folder`), r.out);
    for (const danger of ['.', './src', './.git', '..', FAKE_HOME]) {
      const again = scaffold(`un-danger-${danger.replace(/\W/g, 'x')}`);
      fs.writeFileSync(path.join(again.dir, '.env'), `AUTH_PATH=${danger}\n`);
      const rd = await terminal(again, U, [['Make a backup first?', 'n\r'], ['Type the word delete', 'delete\r']]);
      check(`AUTH_PATH=${danger === FAKE_HOME ? 'a home folder' : danger} aims nothing outside what's listed`, fs.existsSync(path.join(again.dir, 'scripts/uninstall.js')) && gitIn(again.dir, 'status', '--porcelain') === '' && fs.existsSync(again.base), `${rd.code} ${rd.out}`);
    }
  }

  section('uninstall: the outside deletes, on a stubbed fetch');
  const stubFetch = path.join(SCRATCH, 'stub-fetch.mjs');
  fs.writeFileSync(stubFetch, `import fs from 'node:fs';
globalThis.fetch = async (url, init = {}) => {
  fs.appendFileSync(process.env.STUB_FETCH_LOG, JSON.stringify({ url: String(url), method: init.method, body: init.body ? String(init.body) : '' }) + '\\n');
  if (process.env.STUB_FETCH === 'network') throw new Error('offline SECRETINERROR');
  const ok = process.env.STUB_FETCH !== 'refused';
  return { ok, status: ok ? 200 : 403, text: async () => 'SECRETINBODY', arrayBuffer: async () => new ArrayBuffer(0) };
};
`);
  const R2_ENV = `R2_ENDPOINT=https://${'a'.repeat(32)}.r2.cloudflarestorage.com\nR2_BUCKET=my-bucket\nR2_ACCESS_KEY_ID=KEYID123\nR2_SECRET_ACCESS_KEY=SECRETR2KEY\n`;
  function outsideRepo(name, envExtra = '') {
    const repo = scaffold(name, { full: true });
    fillInstall(repo.dir, { env: `${R2_ENV}${envExtra}` });
    const db = new Database(path.join(repo.dir, 'data/karyasthan.db'));
    db.exec(fs.readFileSync(path.join(ROOT, 'src/memory/schema.sql'), 'utf-8').match(/CREATE TABLE IF NOT EXISTS person_voice[\s\S]*?\);/)[0]);
    db.prepare('INSERT INTO person_voice (person_jid, voice_id) VALUES (?,?)').run('1@s.whatsapp.net', 'voice_a');
    db.prepare('INSERT INTO person_voice (person_jid, voice_id, revoked_at, revoke_reason) VALUES (?,?,?,?)').run('2@s.whatsapp.net', 'voice_b', 123, `purge${DELETE_PENDING_SUFFIX}`);
    db.close();
    return repo;
  }
  const outsideRun = (repo, fetchMode) => {
    const log = path.join(repo.state, 'fetch.log');
    return terminal(repo, U, [
      ['Make a backup first?', 'n\r'],
      ['public site offline first?', 'y\r'],
      ['cloned voices at Google first?', 'y\r'],
      ['Type the word delete', 'delete\r'],
    ], { env: { NODE_OPTIONS: `--import=${stubFetch}`, STUB_FETCH: fetchMode, STUB_FETCH_LOG: log }, timeoutMs: 90000 }).then((r) => {
      let calls = [];
      try { calls = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      return { ...r, calls };
    });
  };
  const noSecrets = (out) => !['SECRETGEMINI', 'SECRETR2KEY', 'KEYID123', 'SECRETINERROR', 'SECRETINBODY', '15550100123'].some((s) => out.includes(s));
  {
    const repo = outsideRepo('out-ok');
    const r = await outsideRun(repo, 'ok');
    const put = r.calls.find((c) => c.method === 'PUT');
    const dels = r.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()).sort();
    check('all fine: exit 0', r.answered === r.total && r.code === 0, `${r.code} ${r.answered}/${r.total} ${r.out.slice(-600)}`);
    check('the site: the offline notice goes to the bucket, with real takedown()', put?.url.includes('/my-bucket/public.json') && JSON.parse(put.body || '{}').offline === true, JSON.stringify(put));
    check('the voices: both deleted at Google, by id, by the real code', dels.join() === 'voice_a,voice_b', dels.join());
    check('it says what happened', r.out.includes('offline notice') && r.out.includes('Deleted 2 cloned voices'), r.out);
    check('and the files go after them', !fs.existsSync(path.join(repo.dir, '.env')) && !fs.existsSync(path.join(repo.dir, 'data')));
    check('no secret on the screen', noSecrets(r.out), r.out);
  }
  {
    const repo = outsideRepo('out-refused');
    const r = await outsideRun(repo, 'refused');
    check('Google and R2 refuse: exit 1, each reported', r.code === 1 && r.out.includes('still up: R2 refused it') && r.out.includes('2 of 2 cloned voices couldn\'t be deleted'), `${r.code} ${r.out.slice(-600)}`);
    check('it says where to do it by hand', r.out.includes('Delete public.json from the bucket my-bucket'), r.out);
    check('a failed outside delete doesn\'t stop the rest', !fs.existsSync(path.join(repo.dir, '.env')) && !fs.existsSync(path.join(repo.dir, 'data')) && r.out.includes('rm -rf'), r.out.slice(-400));
    check('no secret on the screen', noSecrets(r.out), r.out);
  }
  {
    const repo = outsideRepo('out-network');
    const r = await outsideRun(repo, 'network');
    check('no network: reported, the rest goes on', r.code === 1 && r.out.includes('R2 couldn\'t be reached') && !fs.existsSync(path.join(repo.dir, '.env')), `${r.code} ${r.out.slice(-500)}`);
    check('no secret on the screen', noSecrets(r.out), r.out);
  }
  {
    const repo = outsideRepo('out-dry', 'DRY_RUN=true\n');
    const r = await outsideRun(repo, 'ok');
    check('DRY_RUN on: not called offline when nothing went up', r.code === 1 && r.out.includes('still up: DRY_RUN is on') && !r.calls.some((c) => c.method === 'PUT'), `${r.code} ${r.out.slice(-500)}`);
  }

  section('the setup menu');
  {
    const repo = scaffold('menu', { full: true });
    publish(repo, { 'x.txt': 'x' });
    const before = headOf(repo);
    fs.writeFileSync(path.join(repo.dir, 'src/personality/persona.json'), JSON.stringify({ name: 'Sam' }));
    fs.writeFileSync(path.join(repo.dir, 'src/personality/identity.md'), 'x');
    const finish = await terminal(repo, 'node scripts/setup.js', [['Choose', '\r']]);
    check('Finish is the last item and the default', finish.code === 0 && finish.out.includes('9  Update to the newest version') && finish.out.includes('10 Finish') && headOf(repo) === before, `${finish.code} ${finish.out.slice(-500)}`);
    const go = await terminal(repo, 'node scripts/setup.js', [['Choose', '9\r'], ['Go ahead?', 'y\r']]);
    check('Update from the menu: new code lands, and setup stops, since it\'s now the old one', go.answered === go.total && go.code === 0 && headOf(repo) !== before && go.out.includes('npm run setup again'), `${go.code} ${go.answered}/${go.total} ${go.out.slice(-500)}`);
    gitIn(repo.dir, 'checkout', '-q', '-b', 'live');
    const refuse = await terminal(repo, 'node scripts/setup.js', [['Choose', '9\r'], ['"live"', ''], ['Choose', '\r']]);
    check('a refusal goes back to the menu, then Finish', refuse.answered === refuse.total && refuse.code === 0, `${refuse.code} ${refuse.answered}/${refuse.total} ${refuse.out.slice(-500)}`);
  }
}

// ── The words ─────────────────────────────────────────────────────────────────
section('the words');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
check('package.json runs them', pkg.scripts.update === 'node scripts/update.js' && pkg.scripts.backup === 'node scripts/backup.js' && pkg.scripts.uninstall === 'node scripts/uninstall.js' && pkg.scripts['test:day-two'] === 'node scripts/test-day-two.js');
check('the runner has this suite', fs.readFileSync(path.join(ROOT, 'scripts/run-all-tests.js'), 'utf-8').includes("['day-two', 'test-day-two.js']"));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
check('the README points at them, not the by-hand steps', readme.includes('npm run update') && readme.includes('npm run backup') && readme.includes('npm run uninstall') && !readme.includes('git pull --ff-only && npm ci && pm2 restart'));
const docs = fs.readFileSync(path.join(ROOT, 'docs/install.md'), 'utf-8');
check('docs/install.md covers them', ['npm run update', 'npm run backup', '--restore', 'npm run uninstall'].every((w) => docs.includes(w)));
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf-8');
check('CLAUDE.md lists them', ['npm run update', 'npm run backup', 'npm run uninstall', 'npm run test:day-two'].every((w) => claude.includes(w)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
