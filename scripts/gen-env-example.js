#!/usr/bin/env node
/**
 * Generate the model-role block of .env.example from the registry (src/brain/roles.js).
 *
 *   node scripts/gen-env-example.js           print the block
 *   node scripts/gen-env-example.js --check   exit 1 if .env.example's block drifted
 *   node scripts/gen-env-example.js --write   rewrite the block in .env.example
 *
 * The block sits between the BEGIN/END markers below; everything else in the file
 * is left untouched. Imports only the pure registry (no config, no .env read).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { envExampleBlock } from '../src/brain/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.env.example');
const BEGIN = '# >>> roles (generated: npm run gen:env) >>>';
const END = '# <<< roles <<<';

const block = envExampleBlock();
const args = process.argv.slice(2);

if (!args.includes('--check') && !args.includes('--write')) {
  console.log(`${BEGIN}\n${block}\n${END}`);
  process.exit(0);
}

const text = fs.readFileSync(FILE, 'utf-8');
const start = text.indexOf(BEGIN);
const end = text.indexOf(END);
if (start < 0 || end < start) {
  console.error(`.env.example has no role block (markers "${BEGIN}" … "${END}")`);
  process.exit(1);
}
const current = text.slice(start + BEGIN.length, end).replace(/^\n/, '').replace(/\n$/, '');

if (args.includes('--check')) {
  if (current === block) {
    console.log('.env.example role block is up to date');
    process.exit(0);
  }
  console.error('.env.example role block drifted from src/brain/roles.js — run: npm run gen:env -- --write');
  process.exit(1);
}

const next = `${text.slice(0, start)}${BEGIN}\n${block}\n${END}${text.slice(end + END.length)}`;
if (next === text) {
  console.log('.env.example role block already up to date');
} else {
  fs.writeFileSync(FILE, next);
  console.log('.env.example role block rewritten');
}
