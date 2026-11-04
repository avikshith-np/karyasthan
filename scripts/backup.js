#!/usr/bin/env node
// npm run backup: one private tar.gz in data/backups/ of what makes this install yours.
// npm run backup -- --restore <file> [--force]: puts one back.
//
// Exit codes: 0 done, 1 failed, 2 refused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, restoreBackup } from './setup/backup-archive.js';
import { installPaths, sqliteLoads } from './setup/day-two.js';

process.umask(0o077);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const say = (s = '') => console.log(s ? `  ${s}` : '');

function human(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function backup() {
  say();
  if (fs.existsSync(installPaths(ROOT).dbPath) && !sqliteLoads(ROOT)) {
    say('✗ SQLite doesn\'t load, so the database can\'t be copied. Nothing was written.');
    say('  After changing Node versions, run: npm rebuild better-sqlite3');
    say();
    return 1;
  }
  let r;
  try {
    r = createBackup({ root: ROOT });
  } catch (err) {
    say(`✗ The backup failed: ${err.message}`);
    say();
    return 1;
  }
  say(`✓ ${r.file}`);
  say(`  ${human(fs.statSync(r.file).size)}, readable by this user only.`);
  say();
  say(`It holds: ${r.included.join(', ')}.`);
  if (r.missing.length) say(`Not there to copy: ${r.missing.join(', ')}.`);
  for (const n of r.notes) say(`! ${n}`);
  say();
  say('! This file holds your keys, your WhatsApp session and your chats. Keep it private,');
  say('  and copy it off this machine: a backup on the same disk won\'t survive losing the disk.');
  say();
  return 0;
}

function restore() {
  const at = argv.indexOf('--restore');
  const given = argv[at + 1];
  if (!given || given.startsWith('--')) {
    say();
    say('✗ Which file? npm run backup -- --restore <file>');
    say();
    return 2;
  }
  // npm runs this from the project folder, whatever folder the person typed it in.
  const file = path.resolve(process.env.INIT_CWD || process.cwd(), given);
  const force = argv.includes('--force');
  say();
  const r = restoreBackup({ root: ROOT, file, force });
  if (r.refused) {
    say(`✗ ${r.refused}`);
    for (const b of r.bad || []) say(`    ${b.name}: ${b.why}`);
    say();
    return 2;
  }
  say(`✓ Restored ${r.restored.join(', ')}`);
  if (r.asideMoved.length) {
    say('Moved aside, nothing deleted:');
    for (const p of r.asideMoved) say(`    ${path.relative(ROOT, p).startsWith('..') ? p : path.relative(ROOT, p)}`);
  }
  for (const w of r.warnings) say(`! ${w}`);
  say();
  say('! Two machines running one WhatsApp session knock each other off WhatsApp.');
  say('  Stop the old copy before you start this one, and leave it stopped.');
  say();
  say('Next: npm run doctor, then npm start.');
  say();
  return 0;
}

let code;
try {
  code = argv.includes('--restore') ? restore() : backup();
} catch (err) {
  say(`✗ Failed: ${err.message}`);
  say();
  code = 1;
}
process.exit(code);
