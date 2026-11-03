// Phrase banks (plan 020 H2), at run time: the code-written lines in his own voice, with no model call. See
// docs/claude/phrase-banks.md. src/personality/phrases.json is written offline by scripts/gen-phrases.js, per install and
// gitignored. Missing or corrupted → the committed example, which is today's English; no example either → English.
//
// With life.phraseBanks off (the default) voiceLine hands back what it was given, so everything is byte for byte as before.
// The caller draws and remembers English lines; only the words on the way out change.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { BANKS, MAX_FILE_BYTES, chooseVariant, slotCatalogue, validateBank, ACTIVITIES, MOODS, TIMES } from './phraseCheck.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../personality');
export const PHRASES_PATH = path.join(DIR, 'phrases.json');
export const EXAMPLE_PATH = path.join(DIR, 'phrases.example.json');

// The running bank: set at boot only (or a fresh process). Nothing a page reads can change what he says.
let active = null;
let bootCtx = null;
let bootFiles = null;
// What's on disk, read for the side by side only, and read again only when the file changes.
let diskCache = null;
let testFile = null;

const emptyBank = () => Object.fromEntries(BANKS.map(b => [b, new Map()]));

function readFile(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_FILE_BYTES) return { code: 'too_big', stamp: stampOf(st) };
  try {
    return { raw: JSON.parse(fs.readFileSync(file, 'utf-8')), stamp: stampOf(st) };
  } catch {
    return { code: 'corrupt', stamp: stampOf(st) };
  }
}
const stampOf = (st) => `${st.mtimeMs}:${st.size}`;

/** A bank from disk, checked, with no effect on anything. Never throws; a refusal falls to the example, then to none, and says why. */
function readBank({ file, examplePath, ctx }) {
  let issue = null;
  let stamp = null;
  let found = false;
  const attempt = (f, source) => {
    let got;
    try { got = readFile(f); } catch (err) {
      if (err?.code !== 'ENOENT') issue = 'unreadable';
      else if (source === 'phrases.json') issue = 'missing';
      return null;
    }
    if (source === 'phrases.json') { stamp = got.stamp; found = true; }
    if (got.code) { issue = got.code; return null; }
    const v = validateBank(got.raw, ctx);
    if (!v.ok) { issue = `invalid:${v.code}`; return null; }
    return { ...v, source };
  };
  const result = attempt(file, 'phrases.json') ?? attempt(examplePath, 'example');
  const bank = result
    ? { ...result, issue: result.source === 'phrases.json' ? null : issue }
    : { ok: false, source: 'none', issue, lines: emptyBank(), meta: { version: null, generatedAt: null, model: null, catalogue: null }, coverage: null, rejected: {}, stale: 0, health: null, warnings: [] };
  return { ...bank, stamp, found };
}

/**
 * Load the running bank. Life's boot calls this, and only that (a CLI or a test may, in its own process): a new file reaches
 * him at the next restart. ctx: the names a line may not hold (phraseCheck.makeChecker).
 */
export function loadPhraseBank({ file = testFile ?? PHRASES_PATH, examplePath = EXAMPLE_PATH, ctx = {} } = {}) {
  bootCtx = ctx;
  bootFiles = { file, examplePath };
  diskCache = null;
  active = readBank({ file, examplePath, ctx });
  // A bank that is there and refused is a thing to look at; one not written yet isn't.
  if (active.found && active.source !== 'phrases.json') logger.warn({ evt: 'issue', code: active.issue }, 'phrase bank refused: English lines stay');
  else logger.info({ evt: 'life.phrases', source: active.source, version: active.meta.version, on: phraseBanksOn(), rejected: Object.values(active.rejected).reduce((a, b) => a + b, 0), warnings: active.warnings }, 'phrase bank loaded');
  return bankStatus();
}

/** A boot that couldn't read the names to check a bank against: nothing loaded, so English, whatever was running before. The next restart retries. */
export function unloadPhraseBank() {
  active = null;
  bootCtx = null;
  diskCache = null;
}

export const phraseBanksOn = () => config.life?.phraseBanks === true;

/** The words for an English line in this state: the line itself with the switch off, or when the bank has nothing for it. */
export function voiceLine(bank, source, state, seed) {
  // Not loaded means not checked against today's names: English, until life's boot has done it.
  if (!phraseBanksOn() || !active) return source;
  const list = active.lines[bank]?.get(source);
  if (!list?.length) return source;
  return chooseVariant(list, state, seed) ?? source;
}

/** Which bank the words come from, when they aren't plain English: a thought keeps it in its codes. */
export function bankVersion() {
  return phraseBanksOn() && active?.source === 'phrases.json' ? active.meta.version : null;
}

const statusOf = (b) => {
  const { source, issue, meta, coverage, rejected, stale, health, warnings } = b;
  return { source, issue, ...meta, coverage, rejected, stale, health, warnings };
};

/** The running bank; source null while none has been loaded in this process. */
export function bankStatus() {
  return { on: phraseBanksOn(), ...(active ? statusOf(active) : { source: null, issue: null, version: null, generatedAt: null, model: null, catalogue: null, coverage: null, rejected: {}, stale: 0, health: null, warnings: [] }) };
}

function diskBank(ctxOf) {
  const files = bootFiles ?? { file: PHRASES_PATH, examplePath: EXAMPLE_PATH };
  let stamp = null;
  try { stamp = stampOf(fs.statSync(files.file)); } catch { /* gone or never written */ }
  if (diskCache && diskCache.stamp === stamp) return diskCache;
  const ctx = bootCtx ?? (typeof ctxOf === 'function' ? ctxOf() : null) ?? {};
  diskCache = readBank({ ...files, ctx });
  return diskCache;
}

/**
 * Side by side, for the owner to judge: each English line and what the file on disk has for it, tags included. Reads only:
 * `running` is what he speaks from, `disk` what a restart would load, and they differ until one. opts: { bank, q, only:
 * 'voiced'|'english', offset, limit, ctx: () => names for the check when life hasn't booted }.
 */
export function phraseBankView({ bank = 'thought', q = '', only = null, offset = 0, limit = 40, ctx = null } = {}) {
  const disk = diskBank(ctx);
  const needle = String(q ?? '').trim().toLowerCase();
  const slots = [...slotCatalogue()[bank].values()];
  const rows = [];
  let total = 0;
  for (const s of slots) {
    const variants = (disk.lines[bank]?.get(s.source) ?? []).filter(e => e.t !== s.source);
    if (only === 'voiced' && !variants.length) continue;
    if (only === 'english' && variants.length) continue;
    if (needle && !s.source.toLowerCase().includes(needle) && !variants.some(e => e.t.toLowerCase().includes(needle))) continue;
    if (total >= offset && rows.length < limit) rows.push({ source: s.source, family: s.family, pools: s.pools, variants });
    total += 1;
  }
  const running = bankStatus();
  const restartNeeded = !!active && (active.stamp !== disk.stamp || active.source !== disk.source);
  return { on: running.on, running, disk: statusOf(disk), restartNeeded, bank, banks: BANKS, tags: { moods: MOODS, times: TIMES, activities: ACTIVITIES[bank] }, total, offset, limit, rows };
}

/** Where a boot in a test looks for the bank, so a test never touches the real file. */
export function __setBankFileForTest(file) { testFile = file; }

export function __setBankForTest(lines, { version = 'test', source = 'phrases.json' } = {}) {
  diskCache = null;
  if (lines === null) { active = null; bootCtx = null; bootFiles = null; return; }
  const maps = emptyBank();
  for (const b of BANKS) for (const [k, v] of Object.entries(lines[b] ?? {})) maps[b].set(k, v);
  active = { ok: true, source, issue: null, lines: maps, meta: { version, generatedAt: null, model: null, catalogue: null }, coverage: null, rejected: {}, stale: 0, health: null, warnings: [], stamp: null, found: true };
}
