#!/usr/bin/env node
// Property tests: trace one decision of a seed's run (triage of a sweep finding).
//   node scripts/property-tests/trace.js <seed> <decisionId> [--ops-per-run 40] [--ops '<json>']
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { opsFor } from './ops.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [seed, id] = process.argv.slice(2).map(Number);
const i = process.argv.indexOf('--ops-per-run'); const per = i > 0 ? Number(process.argv[i + 1]) : 40;
const j = process.argv.indexOf('--ops'); const ops = j > 0 ? JSON.parse(process.argv[j + 1]) : opsFor(seed, per);
const res = spawnSync(process.execPath, [path.join(HERE, 'child.js'), JSON.stringify({ seed, ops, trace: id })], { cwd: path.resolve(HERE, '..', '..'), encoding: 'utf-8', maxBuffer: 64 << 20 });
const line = (res.stdout || '').trim().split('\n').reverse().find(l => l.startsWith('{"ok"'));
const r = line ? JSON.parse(line) : null;
if (!r?.trace) { console.log('no trace', (res.stderr || '').slice(-400)); process.exit(1); }
for (const [k, list] of Object.entries(r.trace)) { console.log(`── ${k}`); for (const e of list) console.log(`  #${e.id} ${e.t} ${e.type} ${e.actor}${e.cause ? ` ←${e.cause}` : ''}${e.out ? ' [OUT]' : ''} ${e.p}`); }
for (const n of r.notes) if (n.sweep) console.log(`· ${n.sweep}: ${n.text}`);
