// Plan 020 §E1: the plot-hole sweep against a COPY of a database, read only: run the rules
// over the copy's last --days days and print the findings. --source is only read, once, by VACUUM INTO. Codes and
// code-built words only (no chat text, no JID); nothing is sent, no model is called.
//
//   node scripts/sweep-dry-run.js --source <db> [--days 14] [--keep]
//
// Takes a VACUUM INTO copy under data/ (never touches --source beyond that read), folds the projection
// from it, runs the rules and removes the copy unless --keep.
// Run it from the install whose src/personality/world.json matches the source DB: the world comes
// from this tree, not from the copy. From another tree the real log folds with the example world
// (place words degrade to kind words, routine-dependent checks drift). scene_afterwards isn't run.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const source = arg('source');
const days = Math.min(90, Math.max(1, Number(arg('days', 14)) || 14));
if (!source) { console.error('usage: node scripts/sweep-dry-run.js --source <db> [--days 14] [--keep]'); process.exit(2); }

const copyRel = `./data/sweep-dry-run-${process.pid}.db`;
const copy = path.join(ROOT, copyRel);
process.env.DB_PATH = copyRel;
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.LIFE_ENABLED = 'false';

const src = new Database(source, { readonly: true, fileMustExist: true });
src.prepare('VACUUM INTO ?').run(copy);
src.close();
fs.chmodSync(copy, 0o600);
const drop = () => { if (process.argv.includes('--keep')) return; for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(copy + s); } catch { /* absent */ } } };
process.on('exit', drop);

const { getDb } = await import('../src/memory/db.js');
const { getEvent, listEvents, causeChain, lastEventId } = await import('../src/life/eventLog.js');
const { rebuild, isExcludedId, stateBeforeEvent, vitalsAt } = await import('../src/life/projector.js');
const { getWorld } = await import('../src/life/world.js');
const { runRules, RULES } = await import('../src/life/sweep.js');
const { WALLET_TYPES } = await import('../src/life/wallet.js');
const { strongCue } = await import('../src/life/story/phone/plans.js');
const { placeLabel } = await import('../src/life/places.js');
const { config } = await import('../src/utils/config.js');

const db = getDb();
const world = getWorld();
const before = lastEventId();
const state = rebuild({ world, useSnapshot: false });
if (state?.genesisAt === null || state?.genesisAt === undefined) { console.log('no world in this database'); process.exit(0); }
const at = Math.max(state.at ?? 0, Math.floor(Date.now() / 1000));
const tz = state.world?.timezone ?? world?.timezone ?? config.timezone;
const isOut = (id) => isExcludedId(state, id);
const live = (e) => !e.redacted && !isOut(e.id);

function read(from, to, types) {
  const out = new Map();
  for (let after; ;) {
    const page = listEvents({ from, to, types, ...(after ? { after } : {}), order: 'asc', limit: 500 });
    for (const e of page) out.set(e.id, e);
    if (page.length < 500) break;
    after = page[page.length - 1].id;
  }
  return [...out.values()].sort((a, b) => a.at - b.at || a.id - b.id);
}

const started = Date.now();
const { findings, ruleErrors } = runRules({
  from: at - days * 86400, to: at, tz, isOut, getEvent, causeChain, read,
  placeWord: (id) => { try { return placeLabel(state, id, { negative: true }) ?? 'somewhere'; } catch { return 'somewhere'; } },
  castWord: (id) => state.cast?.get?.(id)?.name ?? state.story?.departed?.[id]?.name ?? 'someone',
  kindWord: (k) => String(k ?? 'outing').replace(/[_:-]+/g, ' '),
  walletStartId: () => listEvents({ types: ['wallet.started'], limit: 50, order: 'desc' }).find(live)?.id ?? null,
  moneyBefore: (id) => stateBeforeEvent(id, { world })?.vitals?.money ?? null,
  moneyNow: () => vitalsAt(state, at, world)?.money ?? null,
  moneySince: (id) => {
    const out = [];
    for (let after = id - 1; ;) {
      const page = listEvents({ types: WALLET_TYPES, after, limit: 500 });
      out.push(...page.filter(live));
      if (page.length < 500) return out;
      after = page[page.length - 1].id;
    }
  },
  planOutcomes: () => {
    try { return JSON.parse(db.prepare("SELECT value_json FROM story_state WHERE key = 'phone_plan_outcomes'").pluck().get() ?? 'null'); } catch { return null; }
  },
  strongCues: (ids) => {
    const stmt = db.prepare("SELECT event_id AS eventId, text, edited_text AS editedText FROM story_messages WHERE event_id = ? AND status = 'live'");
    return ids.flatMap((id) => { const r = stmt.get(id); const cue = r ? strongCue(r.editedText || r.text || '') : null; return cue ? [{ eventId: id, cue }] : []; });
  },
});

console.log(`events ${before} · window ${days} days · ${Date.now() - started} ms · rules ${RULES.length} · failed rules ${ruleErrors.length ? ruleErrors.join(', ') : 'none'}`);
console.log('scene_afterwards needs the running story layer: not run here.');
const by = new Map(RULES.map(r => [r, []]));
for (const f of findings) by.get(f.rule).push(f);
for (const [rule, list] of by) {
  console.log(`\n${rule}: ${list.length}`);
  for (const f of list.slice(0, 20)) console.log(`  [${f.severity}] ${new Date(f.at * 1000).toISOString().slice(0, 16)} #${f.eventIds.join(',')} ${f.text}`);
  if (list.length > 20) console.log(`  … and ${list.length - 20} more`);
}
