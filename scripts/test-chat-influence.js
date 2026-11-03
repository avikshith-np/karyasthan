// Chat influence (spec 012) test runner: runs every scripts/chat-influence-tests/*.test.js in
// name order, each in its own Node process (config reads DB_PATH at import time
// and db.js holds a singleton, so tests must not share a process). Offline:
// scratch DB under data/, fake clock, mocked Jev — see chat-influence-tests/_helpers.js.
//
// Usage:  npm run test:chat-influence                 all tests
//         npm run test:chat-influence -- 05 07        only files whose name contains "05" or "07"
//         npm run test:chat-influence -- --live       passes --live through (unused: the suite is offline)
// Exits non-zero if any test file fails.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'chat-influence-tests');
const PROJECT_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('-'));
const filters = args.filter(a => !a.startsWith('-'));

const files = (fs.existsSync(TEST_DIR) ? fs.readdirSync(TEST_DIR) : [])
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filters.length || filters.some(s => f.includes(s)))
  .sort();

if (!files.length) {
  console.log(`No chat influence tests found${filters.length ? ` matching ${filters.join(', ')}` : ''} (scripts/chat-influence-tests/*.test.js).`);
  process.exit(0);
}

const failed = [];
const started = Date.now();
for (const f of files) {
  console.log(`\n▶ ${f}`);
  const res = spawnSync(process.execPath, [path.join(TEST_DIR, f), ...flags], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, LIFE_TEST: '1' },
  });
  if (res.status !== 0) failed.push(`${f} (${res.signal ? `signal ${res.signal}` : `exit ${res.status}`})`);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${files.length - failed.length}/${files.length} chat influence test files passed in ${secs}s`);
if (failed.length) {
  console.log(`Failed:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
