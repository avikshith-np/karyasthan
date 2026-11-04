#!/usr/bin/env node
// npm run uninstall: takes this install off the machine, and whatever it can reach online.
// Interactive only. Shows everything first, offers a backup, and does nothing without the typed
// word `delete`. Never deletes the folder it runs from: the last line it prints does that.
//
// A service name isn't proof of whose it is: pm2 and systemd names are per user, so a service
// here only counts when it points at this folder. Another install's stays untouched.
//
// Exit codes: 0 done or nothing done, 1 something couldn't be removed, 2 refused, 130 stopped by
// the user.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createUi, Interrupted, openTerminal } from './setup/ui.js';
import { mask, credsAreLinked } from './setup/lib.js';
import { CHARACTER_FILES, installPaths, isInside, git, checkoutFacts, shellQuote } from './setup/day-two.js';
import { createBackup } from './setup/backup-archive.js';
import { holderOf, waitGone } from './setup/running.js';
import { r2Config } from '../src/public/r2.js';

process.umask(0o077);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I = installPaths(ROOT);
const require = createRequire(import.meta.url);
const say = (s = '') => console.log(s ? `  ${s}` : '');
const rel = (p) => (isInside(ROOT, p) ? path.relative(ROOT, p) : p);
const sameDir = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };

// ── What's here ───────────────────────────────────────────────────────────────
function pm2Entries() {
  const r = spawnSync('pm2', ['jlist'], { encoding: 'utf-8', timeout: 60000 });
  if (r.status !== 0) return [];
  let list = [];
  // pm2 can print a line or two about its daemon before the list.
  try { list = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch { return []; }
  return list.map((e) => ({
    id: e.pm_id,
    name: e.name,
    ours: Boolean(e.pm2_env?.pm_cwd && sameDir(e.pm2_env.pm_cwd, ROOT)),
    logs: [e.pm2_env?.pm_out_log_path, e.pm2_env?.pm_err_log_path].filter((l) => l && l !== '/dev/null'),
  }));
}

function unitFacts(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  const dir = (text.match(/^WorkingDirectory=(.*)$/m) || [])[1]?.trim();
  return { file, ours: Boolean(dir && sameDir(dir, ROOT)) };
}

const tracked = (p) => git(ROOT, 'ls-files', '--', rel(p)).out !== '';

/** What gets removed here. Nothing outside this folder, and nothing the project tracks. */
function localTargets() {
  const out = [];
  const add = (p, why) => { if (fs.existsSync(p) || isLink(p)) out.push({ path: p, why }); };
  for (const f of fs.readdirSync(ROOT)) {
    if ((f === '.env' || f.startsWith('.env.')) && f !== '.env.example' && !tracked(path.join(ROOT, f))) add(path.join(ROOT, f), f === '.env' ? 'your keys and settings' : 'an old copy of your keys and settings');
  }
  const backups = (() => { try { return fs.readdirSync(I.backupsDir).filter((f) => !f.startsWith('.')).length; } catch { return 0; } })();
  add(I.dataDir, `database, WhatsApp session, caches${backups ? `, and ${backups} older backup${backups === 1 ? '' : 's'}` : ''}`);
  for (const [p, why] of [[I.dbPath, 'the database'], [`${I.dbPath}-wal`, 'the database'], [`${I.dbPath}-shm`, 'the database'], [I.authPath, 'the WhatsApp session']]) {
    if (!isInside(I.dataDir, p) && isInside(ROOT, p) && !/^\.git(\/|$)/.test(rel(p)) && !tracked(p)) add(p, why);
  }
  let chars = [];
  try { chars = fs.readdirSync(I.personalityDir); } catch { /* none */ }
  const isCharacter = (f) => CHARACTER_FILES.includes(f) || f.startsWith('phrases.json') || f.includes('.bak.');
  for (const f of chars) {
    const p = path.join(I.personalityDir, f);
    if (isCharacter(f) && !tracked(p)) add(p, 'the character');
  }
  add(path.join(ROOT, 'node_modules'), 'installed packages');
  return out;
}

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** A link goes, not what it points at. Refuses anything not strictly inside this folder. */
function removePath(p) {
  if (!isInside(ROOT, p)) throw new Error('outside this folder');
  if (isLink(p)) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

/** Paths from .env that this won't touch, since a typo there mustn't aim a delete anywhere else. */
function pathsLeftAlone() {
  return [I.dbPath, I.authPath].filter((p) => fs.existsSync(p) && !isInside(ROOT, p));
}

function voiceCount() {
  if (!fs.existsSync(I.dbPath)) return { count: 0 };
  try {
    const Database = require('better-sqlite3');
    const db = new Database(I.dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      const rows = db.prepare(`SELECT person_jid FROM person_voice WHERE revoked_at IS NULL OR revoke_reason LIKE '% · Google delete pending'`).all();
      return { count: rows.length };
    } finally { db.close(); }
  } catch (err) {
    return /no such table/.test(err.message) ? { count: 0 } : { count: 0, unread: true };
  }
}

function isLinkedHere() {
  try { return credsAreLinked(fs.readFileSync(path.join(I.authPath, 'creds.json'), 'utf-8')); } catch { return false; }
}

function backupHome() {
  for (const dir of [path.dirname(ROOT), os.homedir()]) {
    try { fs.accessSync(dir, fs.constants.W_OK); return dir; } catch { /* next */ }
  }
  return null;
}

// ── Doing it ──────────────────────────────────────────────────────────────────
async function stopEverything({ pm2, unit }) {
  let ok = true;
  if (pm2.length) {
    for (const e of pm2) {
      // By id: two installs can share a name, and deleting by name would take both.
      const r = spawnSync('pm2', ['delete', String(e.id)], { stdio: 'ignore', timeout: 60000 });
      if (r.status === 0) say(`✓ Removed the pm2 entry "${e.name}"`);
      else { say(`✗ pm2 couldn't remove "${e.name}"`); ok = false; }
    }
    spawnSync('pm2', ['save'], { stdio: 'ignore', timeout: 60000 });
  }
  if (unit?.ours) {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'karyasthan'], { stdio: 'ignore', timeout: 60000 });
    try { fs.rmSync(unit.file, { force: true }); say('✓ Removed the systemd user service'); } catch { say('✗ Couldn\'t remove the service file'); ok = false; }
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 60000 });
  }
  if (!await waitGone(I.lockDirs, 10000)) {
    const h = holderOf(I.lockDirs);
    if (h) { try { process.kill(h.pid, 'SIGTERM'); } catch { /* gone */ } }
    if (!await waitGone(I.lockDirs, 30000)) {
      const h2 = holderOf(I.lockDirs);
      if (h2) { try { process.kill(h2.pid, 'SIGKILL'); } catch { /* gone */ } }
      if (!await waitGone(I.lockDirs, 5000)) ok = false;
    }
    if (ok) say('✓ Stopped the running copy');
  }
  return ok;
}

const SITE_WHY = {
  dry_run: 'DRY_RUN is on here, so nothing was uploaded',
  not_configured: 'the R2 settings aren\'t complete',
  bad_endpoint: 'R2_ENDPOINT isn\'t an R2 address',
  bad_bucket: 'R2_BUCKET isn\'t a valid name',
  no_credentials: 'the R2 key is missing',
  http: 'R2 refused it',
  timeout: 'R2 didn\'t answer in time',
  network: 'R2 couldn\'t be reached',
};

/** Failure is reported, and the rest goes on. Only codes and counts: never a key, never a reply body. */
async function takeSiteOffline(bucket) {
  try {
    const { takedown } = await import('../src/public/index.js');
    const res = await takedown();
    if (res.uploaded === true) {
      say('✓ The public site now shows an offline notice');
      return true;
    }
    say(`✗ The public site is still up: ${SITE_WHY[res.reason] || res.reason || 'unknown reason'}.`);
  } catch {
    say('✗ The public site is still up: the takedown couldn\'t run.');
  }
  say(`  Delete public.json from the bucket ${bucket || '(see your Cloudflare account)'} in your Cloudflare account.`);
  return false;
}

async function deleteVoices(rowsExpected) {
  try {
    const { removeVoice, retryPendingVoiceDeletes } = await import('../src/brain/voiceClone.js');
    const { getDb } = await import('../src/memory/db.js');
    const { listPendingVoiceDeletes } = await import('../src/memory/voiceStore.js');
    for (const r of getDb().prepare('SELECT person_jid FROM person_voice WHERE revoked_at IS NULL').all()) await removeVoice(r.person_jid);
    await retryPendingVoiceDeletes();
    const left = listPendingVoiceDeletes().length;
    if (!left) {
      say(`✓ Deleted ${rowsExpected} cloned voice${rowsExpected === 1 ? '' : 's'} at Google`);
      return true;
    }
    say(`✗ ${left} of ${rowsExpected} cloned voice${rowsExpected === 1 ? '' : 's'} couldn't be deleted at Google. They expire there on their own, within a year.`);
    return false;
  } catch {
    say(`✗ Couldn't delete the cloned voices at Google (${rowsExpected}). They expire there on their own, within a year.`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const co = checkoutFacts(ROOT);
  if (co.branch !== 'main') {
    say();
    say(`✗ This install is on ${co.branch ? `the branch "${co.branch}"` : (co.checkout ? 'no branch' : 'no git branch')}. Uninstall only runs on main. Nothing was removed.`);
    say();
    return 2;
  }
  const term = openTerminal();
  if (!term) {
    say();
    say('✗ This needs a person at a terminal, to read the list and type the word. Nothing was removed.');
    say();
    return 2;
  }
  const ui = createUi({ input: term.input, output: process.stdout });
  try {
    return await run(ui);
  } finally { term.close(); }
}

async function run(ui) {
  const all = pm2Entries();
  const pm2 = all.filter((e) => e.ours);
  const otherPm2 = all.filter((e) => !e.ours && e.name === 'karyasthan');
  const unit = unitFacts(path.join(os.homedir(), '.config/systemd/user/karyasthan.service'));
  const systemUnit = unitFacts('/etc/systemd/system/karyasthan.service');
  if (systemUnit?.ours) {
    say();
    say('✗ This install runs as a system service, and removing that needs sudo. Run these, then this again:');
    say(`    sudo systemctl disable --now karyasthan && sudo rm ${systemUnit.file} && sudo systemctl daemon-reload`);
    say();
    return 2;
  }
  const holder = holderOf(I.lockDirs);
  const targets = localTargets();
  const left = pathsLeftAlone();
  const r2 = r2Config(I.env);
  const r2Set = r2.reason !== 'not_configured';
  const voices = voiceCount();
  const linked = isLinkedHere();

  say();
  say('This removes the install from this machine. Read the list.');
  say();
  say('The service:');
  if (pm2.length) for (const e of pm2) say(`  the pm2 entry "${e.name}"`);
  if (unit?.ours) say(`  the systemd user service ${unit.file}`);
  if (holder) say(`  the running copy (pid ${holder.pid})`);
  if (!pm2.length && !unit?.ours && !holder) say('  none here, and nothing running');
  say();
  say('Files, for good:');
  for (const t of targets) say(`  ${rel(t.path)}  (${t.why})`);
  say();

  say('Outside this machine:');
  if (r2Set) {
    if (r2.ok) say(`  The public site, in the R2 bucket ${r2.bucket}. This can replace it with an offline notice.`);
    else say(`  The public site: R2 settings are here, but they don't work (${SITE_WHY[r2.reason] || r2.reason}). It can't be reached from here.`);
  }
  if (voices.count) say(`  ${voices.count} cloned voice${voices.count === 1 ? '' : 's'} at Google. This can delete them.`);
  if (voices.unread) say('  Cloned voices at Google: the database couldn\'t be read to check for any.');
  if (linked) {
    const n = I.env.WA_PHONE_NUMBER ? ` on +${mask(I.env.WA_PHONE_NUMBER)}` : '';
    say(`  The linked device${n}. Only the phone can remove it: WhatsApp, Linked Devices.`);
  }
  if (!r2Set && !voices.count && !voices.unread && !linked) say('  nothing set up');
  say();

  say('This stays:');
  say(`  This folder's code and logs. The last line below deletes the folder.`);
  for (const p of left) say(`  ${p}, set in .env, outside this folder. Delete it yourself if you want it gone.`);
  for (const e of otherPm2) say(`  The pm2 entry "${e.name}" (id ${e.id}): it belongs to another folder, so it's left alone.`);
  if (unit && !unit.ours) say(`  ${unit.file}: it belongs to another folder, so it's left alone.`);
  for (const l of pm2.flatMap((e) => e.logs)) say(`  ${l}, pm2's own log. Delete it yourself if you want it gone.`);
  if (r2Set) say('  The bucket and the site in your Cloudflare account. Delete them there when you\'re done.');
  say('  Your model keys. They stay valid until you revoke them with each provider.');
  say();

  let backupFile = null;
  const backupDir = backupHome();
  if (backupDir && await ui.confirm(`Make a backup first? It goes in ${backupDir}, so it survives this.`, true)) {
    try {
      backupFile = createBackup({ root: ROOT, outDir: backupDir }).file;
    } catch (err) {
      say(`✗ The backup failed, so nothing was removed: ${err.message}`);
      say();
      return 1;
    }
    say(`✓ ${backupFile}`);
    say('! It holds your keys, your WhatsApp session and your chats. Keep it private.');
    say();
  } else if (!backupDir) {
    say('! There\'s nowhere outside this folder to put a backup, so none is offered.');
    say();
  }

  const siteToo = r2.ok ? await ui.confirm('Take the public site offline first?', true) : false;
  const voicesToo = voices.count ? await ui.confirm('Delete the cloned voices at Google first?', true) : false;
  say();

  const word = await ui.ask('Type the word delete to remove all of this, anything else to stop');
  if (word !== 'delete') {
    say();
    say(`Nothing was removed.${backupFile ? ` The backup stays at ${backupFile}.` : ''}`);
    say();
    return 0;
  }
  say();

  // From here it runs to the end: stopped halfway it would leave keys behind and no way to say so.
  process.on('SIGINT', () => say('! Hold on: finishing what\'s started.'));
  process.on('SIGTERM', () => {});
  process.on('SIGHUP', () => {});
  process.stdout.on('error', () => {});

  // The running bot goes first. Its exporter would put the site back on its next tick, and it
  // holds the database. The outside deletes then need .env and the database, so they come before
  // the files, and node_modules, which they load from.
  if (!await stopEverything({ pm2, unit })) {
    const h = holderOf(I.lockDirs);
    say(`✗ ${h ? `It's still running (pid ${h.pid}). Stop it, then run this again.` : 'The service couldn\'t be removed. Fix that, then run this again.'} Your files weren't touched.`);
    say();
    return 1;
  }

  let failures = 0;
  // Only codes from here: the outside calls log nothing to this screen.
  process.env.LOG_LEVEL = 'silent';
  process.env.DOTENV_CONFIG_QUIET = 'true';
  if (siteToo && !await takeSiteOffline(r2.bucket)) failures++;
  if (voicesToo && !await deleteVoices(voices.count)) failures++;

  let stuck = 0;
  for (const t of targets) {
    try { removePath(t.path); } catch (err) {
      stuck++;
      say(`✗ Couldn't remove ${rel(t.path)}: ${err.code || err.message}`);
    }
  }
  failures += stuck;
  if (!stuck) say('✓ Files removed');
  if (linked) say('! On the phone: WhatsApp, Linked Devices. Remove this device there. Nothing here can.');
  if (backupFile) say(`Your backup: ${backupFile}`);
  say();
  say('Last step, for the folder itself:');
  say(`    rm -rf ${shellQuote(ROOT)}`);
  say();
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof Interrupted) {
      say('Stopped. Nothing was removed.');
      say();
      process.exit(130);
    }
    console.error(`\n  Uninstall failed: ${err?.message || err}\n`);
    process.exit(1);
  },
);
