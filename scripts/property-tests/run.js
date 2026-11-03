#!/usr/bin/env node
// Property tests (plan 020 §E5): random sequences of Director actions, reverts, rewinds,
// schedule edits, texts and time passing against the real engine (scratch DB, example world,
// fake clock, stubbed models, no network), checked after every step by child.js:
//   no operation or tick throws, no engine error is logged · two ticks at one moment append
//   nothing the second time (the log stops growing when nothing's due) · a full replay ≡ the
//   live projection (vitals aside: live integrates them between events) and ≡ a snapshot
//   rebuild · a revert + re-apply stays consistent (replayed right after the re-apply) · no
//   event dated before (or appended before) its cause · created ids are never minted twice ·
//   the nightly sweep's rules (src/life/sweep.js): a high finding fails, warn / info are listed.
//
//   node scripts/property-tests/run.js                 the short run (npm test -- property): 4 seeds × 18 operations
//   node scripts/property-tests/run.js --long          40 seeds × 40 operations
//   node scripts/property-tests/run.js --seeds 7,9 --ops-per-run 30
//   node scripts/property-tests/run.js --seed 7 --ops '<json>'   replay one (shrunk) sequence
//   node scripts/property-tests/run.js --self-test      plant a fault: it must be caught and shrunk
//   --notes   print each sweep warn / info finding with its seed · cases.json: replayed in every default run
//
// On a failure it prints the seed and the shortest operation list it could find that still
// fails the same check (drop halves, then single operations, then shorten time passing).
// Exit 1 when any run fails. Runs one child at a time (the scratch DB is one file).
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { opsFor } from './ops.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

const LONG = flag('--long');
const PER = Number(val('--ops-per-run', LONG ? 40 : 18));
const BASE = Number(val('--base', 20261102));
const N = Number(val('--runs', LONG ? 40 : 4));
const seeds = val('--seeds', null)?.split(',').map(Number) ?? (val('--seed', null) !== null ? [Number(val('--seed'))] : Array.from({ length: N }, (_, i) => BASE + i));
const fixedOps = val('--ops', null);
const SHRINK_MAX = Number(val('--shrink-runs', LONG ? 60 : 25));

const SELF_TEST = flag('--self-test');
function child(seed, ops, { plant = false } = {}) {
  const res = spawnSync(process.execPath, [path.join(HERE, 'child.js'), JSON.stringify({ seed, ops, selfTest: plant })],
    { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LIFE_TEST_LOG_LEVEL: 'error' } });
  const line = (res.stdout || '').trim().split('\n').reverse().find(l => l.startsWith('{"ok"'));
  if (!line) return { ok: false, failures: [{ check: 'child_crashed', op: null, detail: (res.stderr || '').trim().split('\n').slice(-4).join(' | ').slice(0, 400) }], stats: {} };
  return JSON.parse(line);
}

// The same failure = the same check name.
const same = (r, check) => !r.ok && r.failures.some(f => f.check === check);

function shrink(seed, ops, check, { plant = false } = {}) {
  let best = ops;
  let tries = 0;
  const attempt = (cand) => { if (tries >= SHRINK_MAX || !cand.length) return false; tries++; return same(child(seed, cand, { plant }), check); };
  // 1. chunks, halves first.
  for (let size = Math.ceil(best.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let at = 0; at < best.length && tries < SHRINK_MAX;) {
      const cand = [...best.slice(0, at), ...best.slice(at + size)];
      if (attempt(cand)) best = cand; else at += size;
    }
    if (size === 1) break;
  }
  // 2. shorter waits.
  for (let k = 0; k < best.length && tries < SHRINK_MAX; k++) {
    if (best[k].t !== 'pass' || best[k].h <= 0.5) continue;
    const cand = best.map((o, j) => (j === k ? { ...o, h: Math.max(0.25, o.h / 2) } : o));
    if (attempt(cand)) { best = cand; k--; }
  }
  return { ops: best, tries };
}

// The self-test (always in the default run; alone with --self-test): plant one fault in a random
// sequence; the run must fail on it and shrink to a few operations, or the harness is blind.
function selfTest() {
  const ops = opsFor(BASE, 12);
  ops.splice(6, 0, { t: 'plant' });
  const r = child(BASE, ops, { plant: true });
  const f = r.failures?.[0];
  const caught = f?.check === 'dated_before_cause';
  const { ops: small, tries } = caught ? shrink(BASE, ops.slice(0, (f.op ?? ops.length - 1) + 1), f.check, { plant: true }) : { ops: [], tries: 0 };
  const ok = caught && small.some(o => o.t === 'plant') && small.length <= 4;
  console.log(`  ${ok ? '✓' : '✗'} self-test: planted fault ${caught ? `caught (${f.check} at op ${f.op})` : `NOT caught (${JSON.stringify(f ?? null)})`}; shrunk to ${small.length} op(s) in ${tries} runs`);
  return ok;
}
if (SELF_TEST) process.exit(selfTest() ? 0 : 1);

const started = Date.now();
let failed = 0;
const NOTES = flag('--notes');
const DEFAULT = !fixedOps && val('--seeds', null) === null && val('--seed', null) === null;
// The incident list (cases.json): every shrunk sequence that once failed, replayed in each default run.
if (DEFAULT && !flag('--no-cases')) {
  let cases = [];
  try { cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf-8')); } catch { cases = []; }
  for (const c of cases) {
    const r = child(c.seed, c.ops);
    // A case may also name sweep findings that must not come back (a warn the fix removed).
    const back = (r.notes || []).filter(n => (c.noNotes || []).includes(n.sweep));
    const ok = r.ok && !back.length;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} case: ${c.name}${r.ok ? (back.length ? ` — ${back[0].sweep} is back: ${back[0].text}` : '') : ` — ${r.failures[0].check}: ${JSON.stringify(r.failures[0].detail)}`}`);
  }
}
if (DEFAULT && !flag('--no-self-test') && !selfTest()) failed++;
const notes = new Map();
for (const seed of seeds) {
  const ops = fixedOps ? JSON.parse(fixedOps) : opsFor(seed, PER);
  const r = child(seed, ops);
  const s = r.stats || {};
  for (const n of r.notes || []) {
    if (!n.sweep) continue;
    notes.set(n.sweep, (notes.get(n.sweep) ?? 0) + 1);
    if (NOTES) console.log(`    · seed ${seed} ${n.sweep} (${n.severity}): ${n.text} [events ${(n.eventIds ?? []).join(",")}]`);
  }
  if (r.ok) {
    console.log(`  ✓ seed ${seed}: ${s.ran ?? '?'} ops, ${s.events ?? '?'} events, ${s.applied ?? 0} applied, refused ${JSON.stringify(s.refused ?? {})}, ${s.reverted ?? 0} reverts, ${s.rewound ?? 0} rewinds`);
    continue;
  }
  failed++;
  const f = r.failures[0];
  console.log(`  ✗ seed ${seed}: ${f.check} at op ${f.op} — ${typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail)}`);
  if (fixedOps || flag('--no-shrink')) continue;
  const { ops: small, tries } = shrink(seed, ops.slice(0, (f.op ?? ops.length - 1) + 1), f.check);
  console.log(`    shortest found (${small.length} ops, ${tries} shrink runs):`);
  console.log(`    node scripts/property-tests/run.js --seed ${seed} --ops '${JSON.stringify(small)}'`);
}
if (notes.size) console.log(`  sweep warn/info seen: ${[...notes].map(([k, n]) => `${k} ×${n}`).join(', ')}`);
console.log(`\n${failed ? `${failed} failed` : 'all passed'}: ${seeds.length} seeded run(s)${DEFAULT ? ' + the cases + the self-test' : ''} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed ? 1 : 0);
