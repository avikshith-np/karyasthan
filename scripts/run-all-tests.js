#!/usr/bin/env node
// `npm test` — runs every offline suite one after another (never in parallel: each
// boots its own scratch DB and some start servers), then prints a pass/fail table.
// Exit 1 if any suite failed.
//
//   node scripts/run-all-tests.js              # every suite below
//   node scripts/run-all-tests.js privacy mind # only these (names as in test:<name>)
//
// Left out on purpose: test:llm (real provider calls), test:imitate's/test:voice's
// --live paths, and the dry-run scripts (they need a source DB). test:search's live
// SearXNG step degrades to "(no results)" when SearXNG isn't running.
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// name → script; the order puts the fast, foundational suites first.
const SUITES = [
  ['migrate', 'test-migrate.js'],
  ['privacy', 'test-privacy.js'],
  ['memory', 'test-memory.js'],
  ['review', 'test-review.js'],
  ['roles', 'test-roles.js'],
  ['llm-offline', 'test-llm-offline.js'],
  ['decision', 'test-decision.js'],
  ['pipeline', 'test-pipeline.js'],
  ['install', 'test-install.js'],
  ['cap-catchup', 'test-cap-catchup.js'],
  ['search', 'test-search.js'],
  ['imitate', 'test-imitate.js'],
  ['voice', 'test-voice.js'],
  ['instagram', 'test-instagram.js'],
  ['dashboard', 'test-dashboard.js'],
  ['life', 'test-life.js'],
  ['mind', 'test-mind.js'],
  ['arcs', 'test-arcs.js'],
  ['chat-influence', 'test-chat-influence.js'],
  ['public', 'test-public.js'],
  ['public-scan', 'test-public-scan.js'],
  ['property', 'property-tests/run.js'],   // plan 020 E5: the short seeded run (--long by hand)
];

const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'));
const unknown = wanted.filter(w => !SUITES.some(([n]) => n === w));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(', ')} — known: ${SUITES.map(([n]) => n).join(', ')}`);
  process.exit(2);
}
const run = wanted.length ? SUITES.filter(([n]) => wanted.includes(n)) : SUITES;

const results = [];
for (const [name, file] of run) {
  console.log(`\n━━━ test:${name} ━━━`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', file)], { cwd: ROOT, stdio: 'inherit' });
  results.push({ name, ok: r.status === 0, code: r.status ?? r.signal, secs: ((Date.now() - t0) / 1000).toFixed(1) });
}

console.log('\nSummary');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} test:${r.name.padEnd(15)} ${String(r.secs).padStart(6)} s${r.ok ? '' : `  (exit ${r.code})`}`);
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n✗ ${failed.length} of ${results.length} suite(s) failed` : `\n✓ all ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
