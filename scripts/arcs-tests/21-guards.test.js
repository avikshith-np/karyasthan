// T026 — static guards over the story layer (quickstart §2 test 21; FR-039, threat
// model T17, constitution III). Pure source reads: no DB, no model, no network. Every
// guard also asserts it found what it is meant to look at, so an empty match can't
// pass by accident.
//
//   1. facade    — from src/ outside src/life/story/, only src/life/index.js and the two
//                  dashboard routes (routes/arcs.js, routes/director.js) import a story
//                  module, and only story/index.js; the one reviewed exception is
//                  projector.js → story/reducer.js (T009: the fold lives in 009's projector).
//   2. journal   — nothing but the facade imports journal.js / narrate.js (narrate reuses
//                  journal's bullet builders); no code outside story/store.js and the v11
//                  migration names story_journal_parts / story_journal_nights /
//                  story_narrations / story_claim_reviews (so no prompt builder can read
//                  them), and the prompt builders don't import the facade's journal readers.
//   3. sends     — nothing under src/life/story/ names sendText, imports actions.js or any
//                  src/whatsapp/ module, or calls a socket method.
//   4. authority — no updateConfig / persistEnvDiff / updateLlmKeys / setSkillEnabled /
//                  muteGroup / unmuteGroup, no env writer or dashboard route import, no
//                  write into config / process.env.
//   5. logging   — no logger call under src/life/story/ passes a text-bearing field
//                  unless its value is a code (literal, .length/.size, err.name/.code) or
//                  the exact call is a reviewed reason-CODE site below; messages are plain
//                  literals; no console.*.
//   6. SQL       — no SQL on the 006 tables (memories|nicknames|relationships|person_facets|
//                  slang) and none of the unscoped 006 helpers (the test:privacy import
//                  guard with no exemption); the database handle only in store.js plus the
//                  reviewed hooks.js / director.js sites, which touch only life_claims,
//                  world_events (redaction read) and sqlite_master.
//   7. trust     — earned trust (2026-10-30): only story/cast.js writes a `trust` delta
//                  (the daily pass), only story/director.js builds an owner relationship
//                  change (cast.metrics), and nothing outside the story layer does either.
import { check, eq, section, report, PROJECT_ROOT } from './_helpers.js';
import fs from 'fs';
import path from 'path';

const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const read = (p) => fs.readFileSync(p, 'utf-8');

// ── a small JS lexer: comments, strings, templates, regex literals, words, punctuation ──

const REGEX_AFTER_WORD = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function skipTemplate(src, i) {           // src[i] === '`' → index after the closing backtick
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && src[j + 1] === '{') { j = skipCode(src, j + 2); continue; }
    j++;
  }
  return src.length;
}

function skipCode(src, j) {              // inside ${ … } → index after its closing brace
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") { j = skipString(src, j); continue; }
    if (c === '`') { j = skipTemplate(src, j); continue; }
    if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? src.length : e + 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if (depth === 0) return j + 1; depth--; }
    j++;
  }
  return src.length;
}

function skipString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
  return j + 1;
}

function lex(src) {
  const toks = [];
  let last = null;                       // last significant token
  const push = (t) => { toks.push(t); if (t.type !== 'comment') last = t; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e;
      push({ type: 'comment', start: i, end }); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2;
      push({ type: 'comment', start: i, end }); i = end; continue;
    }
    if (c === '"' || c === "'") { const end = skipString(src, i); push({ type: 'str', start: i, end }); i = end; continue; }
    if (c === '`') { const end = skipTemplate(src, i); push({ type: 'tpl', start: i, end }); i = end; continue; }
    const regexOk = !last || (last.type === 'punc' && /[(,=:[!&|?{};+\-*%<>~^]/.test(last.value))
      || (last.type === 'word' && REGEX_AFTER_WORD.test(last.value));
    if (c === '/' && regexOk) {
      let j = i + 1; let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      j++;
      while (/[a-z]/i.test(src[j] || '')) j++;
      push({ type: 're', start: i, end: j }); i = j; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) {
      let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++;
      push({ type: 'word', start: i, end: j, value: src.slice(i, j) }); i = j; continue;
    }
    push({ type: 'punc', start: i, end: i + 1, value: c }); i++;
  }
  return toks;
}

/** Source with comments blanked (newlines kept, so offsets and line numbers hold). */
function stripComments(src, toks = lex(src)) {
  let out = '';
  let at = 0;
  for (const t of toks) {
    if (t.type !== 'comment') continue;
    out += src.slice(at, t.start) + src.slice(t.start, t.end).replace(/[^\n]/g, ' ');
    at = t.end;
  }
  return out + src.slice(at);
}

/** String and template literal bodies (the SQL lives there). */
function literals(src, toks = lex(src)) {
  return toks.filter(t => t.type === 'str' || t.type === 'tpl')
    .map(t => ({ text: src.slice(t.start + 1, t.end - 1), line: src.slice(0, t.start).split('\n').length }));
}


const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ── the files ────────────────────────────────────────────────────────────────

const SRC = path.join(PROJECT_ROOT, 'src');
const STORY_DIR = path.join(SRC, 'life', 'story');
const load = (p) => { const src = read(p); const toks = lex(src); return { path: p, rel: rel(p), src, toks, code: stripComments(src, toks) }; };
const storyFiles = walk(STORY_DIR).map(p => ({ ...load(p), name: rel(p).slice('src/life/story/'.length) }));
const appFiles = walk(SRC).filter(p => !p.startsWith(STORY_DIR + path.sep)).map(load);
const byName = (n) => storyFiles.find(f => f.name === n);
const specifiers = (f) => [...f.code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g)].map(m => m[2]);
const resolveSpec = (f, s) => (s.startsWith('.') ? path.resolve(path.dirname(f.path), s) : null);

section('the scanner sees the story layer');
{
  check('src/life/story/ holds the story modules (≥ 20, facade + store + reducer present)', storyFiles.length >= 20
    && ['index.js', 'store.js', 'reducer.js', 'journal.js', 'narrate.js', 'hooks.js'].every(n => byName(n)), storyFiles.map(f => f.name));
  const probe = "const a = /['\"`]/g; const b = `x${'}'}y`; // c 'd\nconst e = 'f'; /* g */ const h = 1 / 2 / 3;";
  const t = lex(probe);
  check('lexer: regex, nested template and comments stay in sync', t.filter(x => x.type === 'word' && x.value === 'const').length === 4
    && t.filter(x => x.type === 'comment').length === 2 && t.filter(x => x.type === 're').length === 1
    && stripComments(probe).includes("const e = 'f';") && !stripComments(probe).includes('g */'));
  const unbalanced = storyFiles.filter(f => {
    let d = 0;
    for (const x of f.toks) if (x.type === 'punc') { if ('([{'.includes(x.value)) d++; else if (')]}'.includes(x.value)) d--; if (d < 0) return true; }
    return d !== 0;
  }).map(f => f.name);
  eq('every src/life/story file lexes to balanced brackets', unbalanced, []);
  check(`the app scan covers src/ (${appFiles.length} files outside the story layer)`, appFiles.length >= 100);
}

// ── 1. facade ────────────────────────────────────────────────────────────────

section('1. only story/index.js is imported from outside src/life/story/');
{
  const ALLOWED_IMPORTERS = new Set(['src/life/index.js', 'src/dashboard/routes/arcs.js', 'src/dashboard/routes/director.js']);
  const EXCEPTIONS = new Set(['src/life/projector.js -> reducer.js']);   // T009
  const imports = [];
  for (const f of appFiles) {
    for (const s of specifiers(f)) {
      const abs = resolveSpec(f, s);
      if (abs && abs.startsWith(STORY_DIR + path.sep)) imports.push({ from: f.rel, to: rel(abs).slice('src/life/story/'.length) });
    }
    // Any other spelling of a story path (string concatenation, a bare 'story/x.js' string).
    for (const l of literals(f.src, lex(f.src))) {
      if (/(^|\/)story\/[\w.-]+\.js$/.test(l.text) && !specifiers(f).includes(l.text)) imports.push({ from: f.rel, to: `?${l.text}` });
    }
  }
  const bad = imports.filter(i => !(i.to === 'index.js' && ALLOWED_IMPORTERS.has(i.from)) && !EXCEPTIONS.has(`${i.from} -> ${i.to}`))
    .map(i => `${i.from} -> ${i.to}`);
  eq('every import of a story module from src/ is the facade, from life/index.js or a story route', bad, []);
  check('life/index.js and routes/arcs.js do import the facade (the guard is not vacuous)',
    imports.some(i => i.from === 'src/life/index.js' && i.to === 'index.js') && imports.some(i => i.from === 'src/dashboard/routes/arcs.js' && i.to === 'index.js'),
    imports);
  check('the reviewed exception is still exactly projector.js → reducer.js', imports.filter(i => EXCEPTIONS.has(`${i.from} -> ${i.to}`)).length === 1);
}

// ── 2. journal / narration ──────────────────────────────────────────────────

section('2. journal and narration text stay out of every prompt path');
{
  const jn = /(^|\/)(journal|narrate)\.js$/;
  const importers = [];
  for (const f of [...storyFiles, ...appFiles]) {
    for (const s of specifiers(f)) {
      const abs = resolveSpec(f, s);
      if (abs && abs.startsWith(STORY_DIR + path.sep) && jn.test(abs)) importers.push(`${f.rel} -> ${path.basename(abs)}`);
    }
  }
  eq('only the facade imports journal.js/narrate.js (narrate reuses journal\'s builders)', importers.sort(),
    ['src/life/story/index.js -> journal.js', 'src/life/story/index.js -> narrate.js', 'src/life/story/narrate.js -> journal.js']);
  const TABLES = /\b(story_journal_parts|story_journal_nights|story_narrations|story_claim_reviews)\b/;
  const named = [...storyFiles, ...appFiles].filter(f => TABLES.test(f.code))
    .map(f => f.rel).filter(r => r !== 'src/life/story/store.js' && r !== 'src/memory/migrations/011-arcs.js');
  eq('no code outside story/store.js and the v11 migration names the journal/narration/review tables', named, []);
  check('store.js does name them (non-vacuous)', ['story_journal_parts', 'story_narrations', 'story_claim_reviews']
    .every(t => byName('store.js').code.includes(t)));
  // The facade's journal/narration readers are for the dashboard only.
  const READERS = /\b(journal|journalNights|narrate|journalRegenerate)\b/;
  const facadeUsers = appFiles.filter(f => specifiers(f).some(s => { const a = resolveSpec(f, s); return a && a === path.join(STORY_DIR, 'index.js'); }));
  const PROMPT_BUILDERS = ['src/life/index.js', 'src/life/innerState.js', 'src/personality/systemPrompt.js', 'src/brain/contextBuilder.js'];
  const lifeIndex = appFiles.find(f => f.rel === 'src/life/index.js');
  const lifeReaders = [...lifeIndex.code.matchAll(/\bstory\s*\.\s*(journal|journalNights|narrate|journalRegenerate)\b/g)].map(m => m[1]);
  eq('src/life/index.js never reaches the facade\'s journal/narration readers', lifeReaders, []);
  check('the facade users are life/index.js and the dashboard routes only', facadeUsers.every(f => f.rel === 'src/life/index.js' || f.rel.startsWith('src/dashboard/routes/')),
    facadeUsers.map(f => f.rel));
  const prompt = appFiles.filter(f => PROMPT_BUILDERS.includes(f.rel));
  check('the prompt builders were scanned', prompt.length === PROMPT_BUILDERS.length, prompt.map(f => f.rel));
  const leak = prompt.filter(f => f.rel !== 'src/life/index.js' && specifiers(f).some(s => /story\//.test(s))).map(f => f.rel);
  eq('no prompt builder but the life facade imports anything under story/', leak, []);
  const fragment = byName('fragment.js');
  check('fragment.js (the prompt fragment) imports neither journal nor narrate nor store', !!fragment
    && !specifiers(fragment).some(s => /(journal|narrate|store)\.js$/.test(s)), fragment && specifiers(fragment));
  void READERS;
}

// ── 3. sends ─────────────────────────────────────────────────────────────────

section('3. no sends from the story layer');
{
  const offenders = [];
  for (const f of storyFiles) {
    if (/\bsendText\b/.test(f.code)) offenders.push(`${f.name}: sendText`);
    if (/actions\.js/.test(f.code)) offenders.push(`${f.name}: actions.js`);
    for (const s of specifiers(f)) if (/whatsapp\//.test(s)) offenders.push(`${f.name}: imports ${s}`);
  }
  eq('no src/life/story module names sendText, actions.js or src/whatsapp/', offenders, []);
  const direct = storyFiles.flatMap(f => [...f.code.matchAll(/\.\s*(sendMessage|sendPresenceUpdate|readMessages|relayMessage|chatModify|groupParticipantsUpdate|updateBlockStatus)\s*\(/g)]
    .map(m => `${f.name}:${lineOf(f.code, m.index)} .${m[1]}(`));
  eq('no src/life/story module calls a socket method', direct, []);
  check('the app does send somewhere (the regexes are live)', appFiles.some(f => /\bsendText\b/.test(f.code)) && appFiles.some(f => /\.\s*sendMessage\s*\(/.test(f.code)));
}

// ── 4. authority ────────────────────────────────────────────────────────────

section('4. no config / skill / mute / key writers in the story layer');
{
  const FORBIDDEN = ['updateConfig', 'persistEnvDiff', 'updateLlmKeys', 'setSkillEnabled', 'muteGroup', 'unmuteGroup', 'writeEnvVars'];
  const hits = storyFiles.flatMap(f => FORBIDDEN.filter(n => new RegExp(`\\b${n}\\b`).test(f.code)).map(n => `${f.name}: ${n}`));
  eq('no src/life/story module names a forbidden writer (code, comments excluded)', hits, []);
  check('the writers exist in the app (non-vacuous)', ['updateConfig', 'setSkillEnabled', 'persistEnvDiff'].every(n => appFiles.some(f => new RegExp(`\\bexport\\s+(async\\s+)?function\\s+${n}\\b`).test(f.code))));
  // The audit log is the one dashboard module the story may reach (hooks.js: arcs.hook.fail).
  const modHits = storyFiles.flatMap(f => specifiers(f).filter(s => /envWriter|dashboard\//.test(s) && !/dashboard\/audit\.js$/.test(s)).map(s => `${f.name}: ${s}`));
  eq('no src/life/story module imports the env writer or src/dashboard/ (but the audit log)', modHits, []);
  const audit = storyFiles.filter(f => specifiers(f).some(s => /dashboard\/audit\.js$/.test(s))).map(f => f.name);
  eq('…only hooks.js reaches the audit log', audit, ['hooks.js']);
  const assigns = storyFiles.flatMap(f => [
    ...[...f.code.matchAll(/\b(config|process\.env)((?:\s*\??\.\s*[\w$]+|\s*\[[^\]\n]+\])+)\s*(=(?!=)|\+=|-=|\*=|\/=|\|\|=|&&=|\?\?=|\+\+|--)/g)]
      .map(m => `${f.name}:${lineOf(f.code, m.index)} ${m[1]}${m[2].replace(/\s+/g, '')} ${m[3]}`),
    ...[...f.code.matchAll(/Object\.(assign|defineProperty)\(\s*(config|process\.env)\b/g)].map(m => `${f.name}:${lineOf(f.code, m.index)} Object.${m[1]}(${m[2]}`),
    ...[...f.code.matchAll(/\bdelete\s+(config|process\.env)\b/g)].map(m => `${f.name}:${lineOf(f.code, m.index)} delete ${m[1]}`),
  ]);
  eq('no src/life/story module writes into config or process.env', assigns, []);
  const skills = storyFiles.flatMap(f => specifiers(f).filter(s => /skills\//.test(s)).map(s => `${f.name}: ${s}`));
  check('only the facade reads the skill registry (isSkillEnabled)', skills.every(s => /^index\.js: /.test(s)) && skills.length >= 1, skills);
  const skillNames = storyFiles.flatMap(f => [...f.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"`][^'"`]*skills\/skillRunner\.js['"`]/g)]
    .flatMap(m => m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)));
  eq('…and imports only isSkillEnabled from it', skillNames, ['isSkillEnabled']);
}

// ── 5. logging ──────────────────────────────────────────────────────────────

section('5. story logs carry ids, counts, statuses and reason codes only');
{
  const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  const TEXT_KEYS = new Set(['summary', 'text', 'texts', 'label', 'labels', 'note', 'notes', 'reason', 'reasons', 'rationale',
    'content', 'body', 'message', 'messages', 'msg', 'claim', 'claimtext', 'extraction', 'scene', 'journal', 'part', 'parts_text',
    'narration', 'thought', 'beat', 'beats_text', 'status_text', 'name', 'names', 'pushname', 'prompt', 'system', 'user', 'output',
    'raw', 'err', 'error', 'lasterror', 'quote', 'line', 'lines', 'snippet', 'title', 'employer', 'employername', 'personality',
    'speech', 'value', 'seed', 'theme', 'themelabel', 'option', 'options', 'question',
    // 011: the Director prompt's owner/model text
    'wish', 'why', 'cantdo', 'drafts', 'dropped']);
  // Reviewed reason-CODE sites (exact source text, whitespace collapsed): every `reason`
  // here is a code from a fixed set (resolver/tray reasons, schema error codes, gate
  // reasons, seed/journal statuses) — never claim, model or chat text. The spread in
  // hooks.js is the purge counters object.
  const REVIEWED = new Map([
    ['index.js', ["logger.info({ evt: 'arcs_seed', status: r?.status ?? null, reason: r?.reason ?? null }, 'story: arc seed')"]],
    ['reconciler.js', ["logger.info({ evt: 'arcs_reconciler', reviewId: review.id, claimId: review.claimId, status, reason }, 'arcs reconciler')"]],
    ['journal.js', ["deps.logger.info({ evt: 'arcs.journal', night: nk, status, reason, parts: out.parts, calls: out.calls }, 'story: journal night')"]],
    ['weekly.js', [
      "logger.info({ evt: 'arcs_weekly', status: 'skipped', reason, runId }, 'arcs weekly: skipped')",
      "logger.info({ evt: 'arcs_weekly', status: 'skipped', reason, runId }, 'arcs weekly: skipped')",
      "logger.warn({ evt: 'arcs_weekly', status: 'invalid', reason: v.error, runId }, 'arcs weekly: invalid output')",
    ]],
    ['seed.js', [
      "logger.warn({ evt: 'arcs_seed', reason: res.error }, 'arcs.json unusable, using the example seed')",
      "logger.info({ evt: 'arcs_seed', status: 'example', reason: gate.reason }, 'arcs seed: generation gated, using the example')",
      "logger.warn({ evt: 'arcs_seed', status: 'example', reason: r.reason, runId: r.runId }, 'arcs seed failed, using the example')",
      "logger.warn({ evt: 'arcs_seed', status: 'failed', reason: r.reason, runId: r.runId }, 'arcs seed regenerate failed')",
    ]],
    ['hooks.js', [
      "deps.logger.info({ evt: 'arcs.hook', cause: 'purge', ...out }, 'story: purge applied')",
    ]],
  ]);
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
  const usedReviewed = new Map();

  const matchClose = (toks, openIdx) => {
    let d = 0;
    for (let k = openIdx; k < toks.length; k++) {
      const t = toks[k];
      if (t.type !== 'punc') continue;
      if ('([{'.includes(t.value)) d++;
      else if (')]}'.includes(t.value)) { d--; if (d === 0) return k; }
    }
    return -1;
  };
  const splitTop = (toks, from, to) => {
    const parts = []; let cur = []; let d = 0;
    for (let k = from; k < to; k++) {
      const t = toks[k];
      if (t.type === 'comment') continue;
      if (t.type === 'punc' && '([{'.includes(t.value)) d++;
      if (t.type === 'punc' && ')]}'.includes(t.value)) d--;
      if (d === 0 && t.type === 'punc' && t.value === ',') { parts.push(cur); cur = []; continue; }
      cur.push(t);
    }
    if (cur.length) parts.push(cur);
    return parts;
  };
  const text = (src, ts) => (ts.length ? src.slice(ts[0].start, ts[ts.length - 1].end) : '');
  const safeValue = (src, ts) => {
    const v = text(src, ts).trim();
    if (ts.length === 1 && ts[0].type === 'word' && /^(true|false|null|undefined|\d[\d_.]*)$/.test(v)) return true;
    if (ts.length === 1 && ts[0].type === 'str' && /^['"][\w.:-]{0,60}['"]$/.test(v)) return true;
    if (ts.length === 1 && ts[0].type === 'tpl' && /^`[\w.:-]{0,60}`$/.test(v)) return true;
    if (/\.(length|size)$/.test(v)) return true;
    // an error's name/code (never its message), optionally with a literal fallback
    if (/^[\w$]+\??\.(name|code)(\s*(\|\||\?\?)\s*([\w$]+\??\.(name|code)|'[\w-]{1,20}'|null))*$/.test(v)) return true;
    return false;
  };

  let calls = 0;
  let consoleCalls = 0;
  const problems = [];
  for (const f of storyFiles) {
    const toks = f.toks.filter(t => t.type !== 'comment');
    for (let k = 0; k + 3 < toks.length; k++) {
      const t = toks[k];
      if (t.type === 'word' && t.value === 'console' && toks[k + 1].value === '.') { consoleCalls++; problems.push(`${f.name}:${lineOf(f.src, t.start)} console.*`); continue; }
      if (!(t.type === 'word' && t.value === 'logger' && toks[k + 1].value === '.' && LEVELS.has(toks[k + 2].value) && toks[k + 3].value === '(')) continue;
      calls++;
      const open = k + 3;
      const close = matchClose(toks, open);
      const startTok = (k >= 2 && toks[k - 1].value === '.' && toks[k - 2].type === 'word') ? toks[k - 2] : t;
      const callText = norm(f.src.slice(startTok.start, toks[close].end));
      const at = `${f.name}:${lineOf(f.src, t.start)}`;
      if ((REVIEWED.get(f.name) || []).map(norm).includes(callText)) {
        const key = `${f.name}|${callText}`;
        usedReviewed.set(key, (usedReviewed.get(key) || 0) + 1);
        continue;
      }
      const args = splitTop(toks, open + 1, close);
      if (!args.length) { problems.push(`${at} empty call`); continue; }
      let first = args[0];
      let msgArgs = args.slice(1);
      if (first.length === 1 && (first[0].type === 'str' || first[0].type === 'tpl')) { msgArgs = args; first = null; }
      if (first) {
        if (!(first[0].value === '{' && matchClose(first, 0) === first.length - 1)) { problems.push(`${at} first argument is not an object literal: ${text(f.src, first)}`); continue; }
        const visit = (ts, prefix) => {
          for (const prop of splitTop(ts, 1, ts.length - 1)) {
            if (!prop.length) continue;
            if (prop[0].value === '.' && prop[1]?.value === '.' && prop[2]?.value === '.') { problems.push(`${at} spread ${prefix}${text(f.src, prop)}`); continue; }
            const keyTok = prop[0];
            const key = keyTok.type === 'str' ? f.src.slice(keyTok.start + 1, keyTok.end - 1) : f.src.slice(keyTok.start, keyTok.end);
            const nkey = key.toLowerCase().replace(/_/g, '');
            const hasColon = prop[1]?.value === ':';
            const value = hasColon ? prop.slice(2) : [keyTok];
            if (hasColon && value[0]?.value === '{' && matchClose(value, 0) === value.length - 1) { visit(value, `${prefix}${key}.`); continue; }
            if (TEXT_KEYS.has(nkey) && !safeValue(f.src, value)) problems.push(`${at} ${prefix}${key}: ${text(f.src, value)}`);
          }
        };
        visit(first, '');
      }
      if (msgArgs.length !== 1) { problems.push(`${at} expected exactly one message argument, got ${msgArgs.length}`); continue; }
      const m = msgArgs[0];
      if (!(m.length === 1 && (m[0].type === 'str' || (m[0].type === 'tpl' && !f.src.slice(m[0].start, m[0].end).includes('${'))))) {
        problems.push(`${at} message is not a plain literal: ${text(f.src, m)}`);
      }
    }
  }
  const plain = storyFiles.reduce((n, f) => n + [...f.code.matchAll(/\blogger\s*\.\s*(trace|debug|info|warn|error|fatal)\s*\(/g)].length, 0);
  check(`the scan parsed every logger call (${calls} found, ${plain} by regex; ≥ 30)`, calls === plain && calls >= 30, { calls, plain });
  eq('no logger call passes a text-bearing field, a spread, a non-literal first argument or message', problems, []);
  eq('no console.* in src/life/story/', consoleCalls, 0);
  const stale = [...REVIEWED].flatMap(([file, list]) => {
    const want = new Map();
    for (const c of list.map(norm)) want.set(c, (want.get(c) || 0) + 1);
    return [...want].filter(([c, n]) => (usedReviewed.get(`${file}|${c}`) || 0) !== n).map(([c]) => `${file}: ${c.slice(0, 80)}`);
  });
  eq('every reviewed reason-code site still exists verbatim, as often as listed (else re-review)', stale, []);
  // The reviewed `reason` values are codes: the reconciler's come from the resolver's
  // { reason: '<code>' } returns and tray constants, never the extraction's summary.
  const rec = byName('reconciler.js');
  const reasonTaint = [...rec.code.matchAll(/\breason\s*[:=]\s*([^,;\n})]+)/g)].map(m => m[1].trim())
    .filter(v => /\b(summary|text|label|extraction)\b/.test(v) && !/\.length\b/.test(v));
  eq('reconciler.js never derives a reason from summary/text/label/extraction', reasonTaint, []);
}

// ── 6. SQL ──────────────────────────────────────────────────────────────────

section('6. no SQL on the 006 tables; the database handle only in reviewed places');
{
  const BANNED = ['getNicknames', 'getGroupNicknames', 'getRelationshipsForPerson', 'getGroupRelationships',
    'getRelevantMemories', 'getMemoriesForPersonInChat', 'getMemoriesForPerson', 'getMemoriesForGroup', 'getTopSlang',
    'getMessagesBySenderAnyGroup', 'countMessagesBySenderAnyGroup'];
  const RAW_SQL = /\b(?:FROM|JOIN)\s+(memories|nicknames|relationships|person_facets|slang)\b/i;
  const privacy = [];
  for (const f of storyFiles) {
    for (const n of BANNED) if (new RegExp(`\\b${n}\\b`).test(f.src)) privacy.push(`${f.name}:${n}`);
    const raw = f.src.match(RAW_SQL);
    if (raw) privacy.push(`${f.name}:raw SQL on ${raw[1]}`);
  }
  eq('test:privacy import guard over src/life/story/ (no exemption)', privacy, []);
  const SCOPED = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["`]?(memories|nicknames|relationships|person_facets|slang|messages|people|group_members)\b/i;
  const scoped = storyFiles.flatMap(f => literals(f.src, f.toks).filter(l => SCOPED.test(l.text)).map(l => `${f.name}:${l.line}`));
  eq('no SQL literal in src/life/story/ touches a 006 table, messages, people or group_members', scoped, []);

  const handle = storyFiles.filter(f => /\bgetDb\w*\b|\.prepare\s*\(|\bdb\s*\.\s*exec\s*\(|\.pragma\s*\(|\bnew\s+Database\b|better-sqlite3/.test(f.code)).map(f => f.name).sort();
  eq('the database handle only in store.js, hooks.js (life_claims withdrawal/purge), director.js and index.js (apply transactions) '
    + 'and reconciler.js (claim status) — and 016 scenes/store.js (story_scenes), 019 phone/store.js (story_messages), 020 dreams/store.js (story_dreams), 020 standing/store.js (story_standing), 020 check/store.js (story_check_*)', handle,
    ['check/store.js', 'director.js', 'dreams/store.js', 'hooks.js', 'index.js', 'phone/store.js', 'reconciler.js', 'scenes/store.js', 'standing/store.js', 'store.js']);
  const idx = byName('index.js');
  check('index.js uses the handle for transactions only (no prepare/exec)', /\.transaction\s*\(/.test(idx.code)
    && !/\.prepare\s*\(|\.exec\s*\(/.test(idx.code));
  const TABLE_RE = /\b(FROM|JOIN|INTO|UPDATE)\s+["`]?([A-Za-z_][\w]*)/g;
  const SQLISH = /\b(SELECT|INSERT|UPDATE|DELETE)\b/;
  const named = [];
  for (const f of storyFiles) {
    for (const l of literals(f.src, f.toks)) {
      if (!SQLISH.test(l.text)) continue;
      for (const m of l.text.matchAll(TABLE_RE)) {
        if (m[1].toUpperCase() === 'UPDATE' && /\bDO\s+$/i.test(l.text.slice(0, m.index))) continue;
        named.push({ file: f.name, line: l.line, verb: m[1].toUpperCase(), table: m[2], sql: l.text });
      }
    }
  }
  check('the SQL scan found the story tables (non-vacuous)', named.filter(n => n.table.startsWith('story_')).length >= 30, named.length);
  const reviewed = (n) => {
    // 016: story_scenes only through scenes/store.js (memory.js reads through it).
    if (n.table === 'story_scenes') return n.file === 'scenes/store.js';
    // 019: story_messages only through phone/store.js (memory.js reads through it).
    if (n.table === 'story_messages') return n.file === 'phone/store.js';
    // 020 G: story_dreams only through dreams/store.js.
    if (n.table === 'story_dreams') return n.file === 'dreams/store.js';
    // 020 D2: story_standing only through standing/store.js.
    if (n.table === 'story_standing' || n.table === 'story_standing_evidence') return n.file === 'standing/store.js';
    // 020 E3: the claim check's two tables only through check/store.js.
    if (n.table === 'story_check_runs' || n.table === 'story_check_claims') return n.file === 'check/store.js';
    if (n.table.startsWith('story_')) return n.file === 'store.js';
    switch (n.table) {
      case 'life_claims': return ['store.js', 'hooks.js', 'director.js'].includes(n.file)
        || (n.file === 'reconciler.js' && n.verb === 'UPDATE' && /WHERE id = \? AND status = 'flagged'/.test(n.sql));
      case 'world_events': return (n.file === 'hooks.js' && /redacted\s*=\s*1/.test(n.sql) && n.verb === 'FROM' && !/\bDELETE\b|\bUPDATE\b/i.test(n.sql))
        || (n.file === 'store.js' && n.verb === 'FROM' && !/\bDELETE\b|\bUPDATE\b/i.test(n.sql));
      case 'sqlite_master': return n.verb === 'FROM';
      case 'json_each': return true;
      default: return false;
    }
  };
  const unreviewed = named.filter(n => !reviewed(n)).map(n => `${n.file}:${n.line} ${n.verb} ${n.table}`);
  eq('every table named by story SQL is a story table (store.js) or a reviewed life_claims/world_events read', unreviewed, []);
  const worldWrites = named.filter(n => n.table === 'world_events' && (n.verb === 'INTO' || n.verb === 'UPDATE' || /\bDELETE\s+FROM\s+world_events\b/i.test(n.sql)))
    .map(n => `${n.file}:${n.line}`);
  eq('no story SQL writes world_events (append-only: only eventLog.appendEvent)', worldWrites, []);
}

// ── 7. trust ─────────────────────────────────────────────────────────────────

section('7. trust moves only in the daily pass (cast.js) and the Director (director.js)');
{
  const TRUST_DELTA = /\bdelta\s*\.\s*trust\s*=|\bdelta\s*:\s*\{[^}]*\btrust\s*:/;
  const OWNER_REL = /relationship\.changed[\s\S]{0,300}?reason:\s*'owner'/;
  const all = [...storyFiles.map(f => ({ ...f, label: `story/${f.name}` })), ...appFiles.map(f => ({ ...f, label: f.rel }))];
  eq('files that write a trust delta', all.filter(f => TRUST_DELTA.test(f.code)).map(f => f.label), ['story/cast.js']);
  eq('files that build an owner relationship change', all.filter(f => OWNER_REL.test(f.code)).map(f => f.label), ['story/director.js']);
  check('cast.js documents its trust constants in the header', /Earned trust \(owner decision 2026-10-30\)/.test(byName('cast.js').src)
    && /export const TRUST_DAY_CAP/.test(byName('cast.js').code));
}

// ── 8. scenes (016) ──────────────────────────────────────────────────────────

section('8. scene play-outs: scenes/* imported only by story/index.js; no sends, no message reads');
{
  const SCENES_DIR = path.join(STORY_DIR, 'scenes');
  const importers = [];
  for (const f of [...storyFiles.map(x => ({ ...x, rel: `src/life/story/${x.name}` })), ...appFiles]) {
    for (const sp of specifiers(f)) {
      const abs = resolveSpec(f, sp);
      if (abs && abs.startsWith(SCENES_DIR + path.sep) && !(f.rel ?? '').startsWith('src/life/story/scenes/')) importers.push(f.rel);
    }
  }
  eq('only src/life/story/index.js imports scenes/*', [...new Set(importers)], ['src/life/story/index.js']);
  const scenes = storyFiles.filter(f => f.name.startsWith('scenes/'));
  check('the scanner sees the scene modules', scenes.length >= 8, scenes.map(f => f.name));
  const sendRe = /(?:sendText|sendMessage|sendReaction|sendVoice|sendImage)|whatsapp\/actions/;
  eq('no send in scenes/*', scenes.filter(f => sendRe.test(f.code)).map(f => f.name), []);
  const msgRe = /(?:FROM|JOIN)\s+(?:messages|messages_fts)|messageStore|getRecentMessages/;
  eq('no message-table read in scenes/* (no chat text in a fact sheet)', scenes.filter(f => msgRe.test(f.src)).map(f => f.name), []);
  eq('story_scenes named only in scenes/store.js (memory.js reads through it)',
    storyFiles.filter(f => /story_scenes/.test(f.code)).map(f => f.name), ['scenes/store.js']);
}

// ── 8b. the claim check (020 E3) ───────────────────────────────────────────

section('8b. the claim check: check/* imported only by story/index.js; no sends, no message reads, no chat, the clerk only');
{
  const CHECK_DIR = path.join(STORY_DIR, 'check');
  const importers = [];
  for (const f of [...storyFiles.map(x => ({ ...x, rel: `src/life/story/${x.name}` })), ...appFiles]) {
    for (const sp of specifiers(f)) {
      const abs = resolveSpec(f, sp);
      if (abs && abs.startsWith(CHECK_DIR + path.sep) && !(f.rel ?? '').startsWith('src/life/story/check/')) importers.push(f.rel);
    }
  }
  eq('only src/life/story/index.js imports check/*', [...new Set(importers)], ['src/life/story/index.js']);
  const mods = storyFiles.filter(f => f.name.startsWith('check/'));
  check('the scanner sees the check modules', mods.length >= 5, mods.map(f => f.name));
  eq('no send', mods.filter(f => /(?:sendText|sendMessage|sendReaction|sendVoice|sendImage)|whatsapp\/actions/.test(f.code)).map(f => f.name), []);
  eq('no message-table read', mods.filter(f => /(?:FROM|JOIN)\s+(?:messages|messages_fts)|messageStore|getRecentMessages/.test(f.src)).map(f => f.name), []);
  eq('no event appended', mods.filter(f => /appendEvent|\bappend\s*\(|revertEvent/.test(f.code)).map(f => f.name), []);
  const worker = byName('check/worker.js');
  check('one model call: the clerk, under its caller', (worker.code.match(/deps\.callRole\(/g) ?? []).length === 1 && /deps\.callRole\('clerk'/.test(worker.code) && /caller: CALLER/.test(worker.code));
  // The desire role's path: the explicit register never reaches the check. (The enforce seams sit on the non-explicit branches.)
  const sceneCode = byName('scenes/worker.js').code;
  check('a scene: explicit is out before enforce and before submit', /enforcing = [^\n]*register !== 'explicit'/.test(sceneCode) && /if \(result && register !== 'explicit'\) \{\s*deps\.claimCheck\?\.submit/.test(sceneCode));
  check('the explicit scene call passes no check', /writeTier\(tier, user, vctx, row\.id, \{ explicit: true, long: sheetLong \}\)/.test(sceneCode));
  const phoneCode = byName('phone/worker.js').code;
  check('a text: explicit is out before enforce and before submit', /register !== 'explicit' && deps\.claimCheck\?\.mode\(\) === 'enforce'/.test(phoneCode) && /w\.facts\.register === 'explicit'\) return;/.test(phoneCode));
  check('never the desire role', !mods.some(f => /['"]desire['"]/.test(f.code)));
}

// ── 9. his phone (019) ───────────────────────────────────────────────────────

section('9. his phone: phone/* imported only by story/index.js; no sends, no message reads, the heat check in place');
{
  const PHONE_DIR = path.join(STORY_DIR, 'phone');
  const importers = [];
  for (const f of [...storyFiles.map(x => ({ ...x, rel: `src/life/story/${x.name}` })), ...appFiles]) {
    for (const sp of specifiers(f)) {
      const abs = resolveSpec(f, sp);
      if (abs && abs.startsWith(PHONE_DIR + path.sep) && !(f.rel ?? '').startsWith('src/life/story/phone/')) importers.push(f.rel);
    }
  }
  eq('only src/life/story/index.js imports phone/*', [...new Set(importers)], ['src/life/story/index.js']);
  const phone = storyFiles.filter(f => f.name.startsWith('phone/'));
  check('the scanner sees the phone modules', phone.length >= 6, phone.map(f => f.name));
  const sendRe = /(?:sendText|sendMessage|sendReaction|sendVoice|sendImage)|whatsapp\/actions|\bsend\s*:\s*true/;
  eq('no send in phone/* (texts are fiction: never a WhatsApp send)', phone.filter(f => sendRe.test(f.code)).map(f => f.name), []);
  const msgRe = /(?:FROM|JOIN)\s+(?:messages|messages_fts)|messageStore|getRecentMessages/;
  eq('no message-table read in phone/* (no chat text in a sheet)', phone.filter(f => msgRe.test(f.src)).map(f => f.name), []);
  eq('story_messages named only in phone/store.js', storyFiles.filter(f => /story_messages/.test(f.code)).map(f => f.name), ['phone/store.js']);
  const schema = phone.find(f => f.name === 'phone/schema.js');
  const worker = phone.find(f => f.name === 'phone/worker.js');
  check('every written text passes the heat check (validateTexts → heatProblem → no message)',
    /if \(heatProblem\(text\)\) return bad\('explicit'\)/.test(schema?.code ?? '') && /validateTexts\(res\.text, vctx\)/.test(worker?.code ?? ''));
}

// ── 10. how things stand + commitments (plan 020 D) ──────────────────────────

section('10. how things stand: standing/* imported only by story/index.js; no sends, no chat reads, no world events; commitments stay read-only');
{
  const DIR = path.join(STORY_DIR, 'standing');
  const importers = [];
  for (const f of [...storyFiles.map(x => ({ ...x, rel: `src/life/story/${x.name}` })), ...appFiles]) {
    for (const sp of specifiers(f)) {
      const abs = resolveSpec(f, sp);
      if (abs && abs.startsWith(DIR + path.sep) && !(f.rel ?? '').startsWith('src/life/story/standing/')) importers.push(f.rel);
    }
  }
  eq('only src/life/story/index.js imports standing/*', [...new Set(importers)], ['src/life/story/index.js']);
  const mods = storyFiles.filter(f => f.name.startsWith('standing/'));
  check('the scanner sees the modules', mods.length >= 4, mods.map(f => f.name));
  const sendRe = /(?:sendText|sendMessage|sendReaction|sendVoice|sendImage)|whatsapp\/actions|\bsend\s*:\s*true/;
  eq('no send', mods.filter(f => sendRe.test(f.code)).map(f => f.name), []);
  const msgRe = /(?:FROM|JOIN)\s+(?:messages|messages_fts)|messageStore|getRecentMessages|memory\/recall/;
  eq('no chat read', mods.filter(f => msgRe.test(f.src)).map(f => f.name), []);
  eq('nothing appended to his life', mods.filter(f => /appendEvent|\bappend\s*\(/.test(f.code)).map(f => f.name), []);
  eq('story_standing named only in standing/store.js', storyFiles.filter(f => /story_standing/.test(f.code)).map(f => f.name), ['standing/store.js']);
  const view = fs.readFileSync(path.join(STORY_DIR, '..', 'commitments.js'), 'utf8');
  check('the commitments view is pure: no database, no append, no phone import', !/getDb|appendEvent|\.prepare\(|phone\//.test(view));
}

report();
