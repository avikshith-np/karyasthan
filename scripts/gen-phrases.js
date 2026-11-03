#!/usr/bin/env node
// Phrase banks (plan 020 H2): write src/personality/phrases.json, the code-written lines in his own voice. Owner-run, never automatic.
// Design and how to judge a bank: docs/claude/phrase-banks.md.
//
//   node scripts/gen-phrases.js                      dry: what it would do and cost; no model call, nothing written
//   node scripts/gen-phrases.js --write              the model calls (a few big `mind` calls, caller life.phrases.gen) + the file
//        --max-usd N     hard cap for this month over this caller (default 4, never above 10)
//        --effort low|medium|high    how hard the model thinks about the lines (default medium; thinking counts as output)
//        --only thought,live,dream   just these banks; the rest of the current file is kept
//        --ban word,word             no line may hold these (the owner's list of what he goes on about)
//        --from-draft [path]         re-check and write the last run's draft, without paying for the lines again
//        --out path                  write here instead of phrases.json
//   node scripts/gen-phrases.js --compare [--bank thought] [--limit 30] [--q word]    the current lines beside the bank's, from the file
//   node scripts/gen-phrases.js --example            rewrite the committed English example from the code's lines
//   node scripts/gen-phrases.js --stub --out <path>  the whole run with a stand-in model: no key, no network, no ledger
//
// The bank does nothing until LIFE_PHRASE_BANKS=true (or the switch on the dashboard), and a running bot loads a new file at its next restart.
import fs from 'fs';
import path from 'path';
import { config, getPersona } from '../src/utils/config.js';
import { BANKS, bankContext, bankToJson, englishBank, validateBank } from '../src/life/phraseCheck.js';
import { CALLER, DEFAULT_MAX_USD, HARD_MAX_USD, buildSystem, dropBadLines, estimateRun, generateBank, reviewBank, stubCallModel } from '../src/life/phraseGen.js';
import { EXAMPLE_PATH, PHRASES_PATH, loadPhraseBank, phraseBankView } from '../src/life/phraseBank.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const value = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const fail = (msg) => { console.error(msg); process.exit(1); };

const DRAFT_PATH = path.join(config.projectRoot, 'data', 'phrases', 'draft.json');

function writeAtomic(file, doc, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 1)}\n`, { encoding: 'utf-8', mode });
  fs.renameSync(tmp, file);
}

function printCheck(v) {
  for (const b of BANKS) {
    const c = v.coverage[b];
    const h = v.health[b];
    console.log(`  ${b.padEnd(8)} ${c.voiced}/${c.slots} lines voiced, ${c.entries} entries · changed ${h.changedPct}% · English-looking words ${h.englishWordPct}% · non-Latin letters ${h.nonLatinPct}% · length ×${h.lengthRatio} · reads as ${h.language}`);
    if (h.topWords.length) console.log(`           most used: ${h.topWords.slice(0, 12).map(x => `${x.word} ${x.count}`).join(', ')}`);
  }
  if (Object.keys(v.rejected).length) console.log(`  dropped: ${JSON.stringify(v.rejected)}`);
  if (v.stale) console.log(`  lines the code no longer has: ${v.stale}`);
  if (v.warnings.length) console.log(`  warnings: ${v.warnings.join(', ')}`);
}

function printCompare({ bank, limit, q, only }) {
  const view = phraseBankView({ bank, q, only, limit });
  const s = view.disk;
  console.log(`on disk: ${s.source}${s.issue ? ` (${s.issue})` : ''} · version ${s.version ?? '—'} · model ${s.model ?? '—'}. The running bot loads it at its next restart.`);
  console.log(`${bank}: showing ${view.rows.length} of ${view.total}\n`);
  for (const r of view.rows) {
    console.log(`NOW   ${r.source}   [${r.pools[0]}]`);
    if (!r.variants.length) console.log('      (stays English)');
    for (const e of r.variants) {
      const tags = ['mood', 'time', 'activity'].filter(k => e[k]).map(k => `${k}:${e[k]}`).join(' ');
      console.log(`  ->  ${e.t}${tags ? `   (${tags})` : ''}`);
    }
  }
}

/** The install's names and words, and the DB-backed seams. Nothing here prints a name. */
async function installContext({ needLedger }) {
  const { getIdentityText, identityCore } = await import('../src/personality/systemPrompt.js');
  const persona = getPersona();
  const { getWorld, realPeopleNames } = await import('../src/life/world.js');
  let world = null;
  try { world = getWorld(); } catch { /* no world yet: names from the people table and the persona still hold */ }
  let realNames = [];
  let strict = [];
  let db = null;
  try {
    const dbm = await import('../src/memory/db.js');
    dbm.assertSchemaCurrent();
    db = dbm.getDb();
    realNames = realPeopleNames(db);
    strict = (await import('../src/memory/messageStore.js')).selfOverusedWords();
  } catch (err) {
    if (needLedger) fail(`The database is needed for the spend ledger and the real names, and it can't be read: ${err.message}`);
    console.log('  (no database here: real names and his over-used words not checked in this run)');
  }
  const banned = (value('--ban', '') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const identity = identityCore() || getIdentityText();
  const { contentProblem } = await import('../src/life/story/desire.js');
  return { persona, world, identity, banned, strict, ctx: bankContext({ persona, world, realNames, identity, banned, contentProblem }), hasDb: !!db };
}

async function liveDeps() {
  const { callRole } = await import('../src/brain/llm.js');
  const { costFor, getUsageByCallerStrict, monthStartTs } = await import('../src/brain/usage.js');
  const { resolveRole } = await import('../src/brain/roles.js');
  const role = resolveRole('mind', config);
  const effort = value('--effort', 'medium');
  if (!['low', 'medium', 'high'].includes(effort)) fail('--effort takes low|medium|high');
  return {
    role,
    callModel: (system, user, o) => callRole('mind', system, user, { caller: CALLER, noFallback: true, effort: o.review ? 'low' : effort, temperature: 0.8, maxTokens: o.maxTokens, timeoutMs: o.timeoutMs }),
    monthSpentUsd: () => getUsageByCallerStrict('life.phrases.', monthStartTs()).reduce((a, r) => a + (Number(r.costUsd) || 0), 0),
    estimateUsd: ({ input, output }) => costFor({ provider: role.provider, model: role.model, usage: { input, output } }).costUsd,
    now: () => Math.floor(Date.now() / 1000),
  };
}

function stubDeps() {
  return { role: { provider: 'stub', model: 'stub' }, callModel: stubCallModel, monthSpentUsd: () => 0, estimateUsd: () => 0.01, now: () => Math.floor(Date.now() / 1000) };
}

const onlyOf = () => {
  const v = value('--only');
  if (!v) return null;
  const list = v.split(',').map(x => x.trim()).filter(Boolean);
  if (!list.length || list.some(b => !BANKS.includes(b))) fail(`--only takes ${BANKS.join(',')}`);
  return list;
};

async function main() {
  if (has('--example')) {
    writeAtomic(EXAMPLE_PATH, englishBank());
    console.log(`Wrote ${path.relative(config.projectRoot, EXAMPLE_PATH)}`);
    return;
  }
  if (has('--compare')) {
    const bank = value('--bank', 'thought');
    if (!BANKS.includes(bank)) fail(`--bank takes ${BANKS.join('|')}`);
    const file = value('--file');
    if (file) loadPhraseBank({ file });
    printCompare({ bank, limit: Number(value('--limit', 30)) || 30, q: value('--q', ''), only: value('--show') });
    return;
  }

  const stub = has('--stub');
  const write = has('--write') || stub;
  const out = value('--out') ? path.resolve(value('--out')) : PHRASES_PATH;
  if (stub && !value('--out')) fail('--stub needs --out: a stand-in model must never write the real file.');
  const only = onlyOf();
  const maxUsd = Number(value('--max-usd', DEFAULT_MAX_USD));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > HARD_MAX_USD) fail(`--max-usd must be above 0 and at most ${HARD_MAX_USD}`);

  const install = await installContext({ needLedger: write && !stub });
  const deps = stub ? stubDeps() : await liveDeps();
  const system = buildSystem({ identity: install.identity, persona: install.persona, banned: install.banned });

  if (!write) {
    const est = estimateRun({ system, only, deps });
    console.log(`DRY RUN: no model call, nothing written.\n`);
    console.log(`  role mind → ${deps.role.provider}/${deps.role.model}, caller ${CALLER}, no fallback`);
    console.log(`  ${est.lines} English lines (private and heavy words stay out), ${est.batches} calls + ${est.reviewCalls} checking`);
    console.log(`  about ${est.input} tokens in, ${est.output} out, ${est.usd === null ? 'NOT PRICED: --write would refuse' : `about $${est.usd.toFixed(2)}, before prompt caching`}`);
    console.log(`  hard cap $${maxUsd.toFixed(2)} this month over this caller; spent so far: ${install.hasDb ? `$${deps.monthSpentUsd().toFixed(2)}` : 'unknown'}`);
    console.log(`  identity ${install.identity.length} chars; ${install.strict.length} over-used words of his held to a low cap; ${install.banned.length} banned`);
    console.log(`\nTo run it: node scripts/gen-phrases.js --write --max-usd ${maxUsd}`);
    return;
  }

  let doc;
  let spent = 0;
  const fromDraft = has('--from-draft');
  if (fromDraft) {
    const f = value('--from-draft') ? path.resolve(value('--from-draft')) : DRAFT_PATH;
    try { doc = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { fail(`No readable draft at ${f}`); }
  } else {
    const res = await generateBank({ system, only, maxUsd, deps });
    spent = res.stats.spentUsd;
    console.log(`Calls ${res.stats.calls} · spent $${spent.toFixed(3)} · failed ${res.stats.failed} · fell back ${res.stats.fellBack}${res.stats.stoppedBy ? ` · stopped: ${res.stats.stoppedBy}` : ''}`);
    if (!res.ok) fail(`Nothing written: ${res.code}`);
    doc = res.doc;
    if (!stub) writeAtomic(DRAFT_PATH, doc, 0o600);
  }

  const badLines = dropBadLines(doc, install.ctx);
  if (Object.keys(badLines).length) console.log(`Code checks dropped: ${JSON.stringify(badLines)}`);
  const review = await reviewBank(doc, { maxUsd, spentSoFar: spent, deps });
  if (!review.ok) fail(`Nothing written: the checking pass failed (${review.code}). The draft is kept; node scripts/gen-phrases.js --write --from-draft picks it up.`);
  console.log(`Checking pass: ${review.flagged} lines flagged and dropped, $${review.spentUsd.toFixed(3)}`);

  // --only: the other banks stay as they are in the current file.
  if (only) {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(out, 'utf-8')); } catch { /* none yet */ }
    if (current?.banks) for (const b of BANKS) if (!only.includes(b) && current.banks[b]) doc.banks[b] = current.banks[b];
  }
  // What's written is what passed: caps included, so the file is what runs, and his over-used words stay down at every boot.
  // Dropping lines lowers a share-based cap, so settle before writing.
  let v = validateBank(doc, install.ctx, { strict: install.strict });
  if (!v.ok) fail(`Nothing written: the document doesn't validate (${v.code}).`);
  const dropped = { ...v.rejected };
  for (let i = 0; i < 6 && ['word_cap', 'emoji_cap', 'dup_line'].some(c => v.rejected[c]); i++) {
    doc.banks = bankToJson(v.lines);
    v = validateBank(doc, install.ctx, { strict: install.strict });
    for (const [k, n] of Object.entries(v.rejected)) dropped[k] = (dropped[k] ?? 0) + n;
  }
  doc.banks = bankToJson(v.lines);
  v.rejected = dropped;
  printCheck(v);

  if (fs.existsSync(out)) fs.copyFileSync(out, `${out}.bak`);
  writeAtomic(out, doc);
  console.log(`\nWrote ${path.relative(config.projectRoot, out)} (version ${doc.version}). Inert until the switch is on; a restart loads it.`);
  console.log(`Judge it: node scripts/gen-phrases.js --compare --bank thought${out === PHRASES_PATH ? '' : ` --file ${value('--out')}`}, or the dashboard's Life · Phrases.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
