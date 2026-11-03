// T028 — static guards over src/mind/ and the Mind page (quickstart §2 test 11; threat
// model T5, T7, T13, T17; plan review S1-13; constitution III). Pure source reads: no
// DB, no model, no network. Every guard also asserts it found what it is meant to
// look at, so an empty match can't pass by accident.
//
//   1. sends     — in src/mind/ only proactive.js reaches sendText / actions.js (and
//                  only actions.js + events.js of src/whatsapp/); no module calls a
//                  socket method directly.
//   2. owner     — outside src/mind/ only src/dashboard/routes/mind.js touches the
//                  facade's `owner` namespace, and the app imports no src/mind/ module
//                  but the facade; inside src/mind/ only index.js uses store.owner.
//   3. authority — nothing in src/mind/ names updateConfig / persistEnvDiff /
//                  updateLlmKeys / setSkillEnabled / muteGroup / unmuteGroup, imports the
//                  env writer or a dashboard route, or assigns into config / process.env.
//   4. SQL       — no SQL on the 006 tables (memories|nicknames|relationships|
//                  person_facets|slang) and none of the unscoped 006 helpers (the
//                  test:privacy import guard, here with no src/mind exemption); SQL only
//                  in store.js + think.js, every table it names is a mind table or a
//                  reviewed exception (MAX cursors on messages/world_events, the digests'
//                  own item_evidence rows, the identity.reassign audit row, the ledger).
//   5. persona   — no persona name/alias anywhere in src/mind/ (comments included); no
//                  persona region/language/vibe/voice phrase in code. Terms come from
//                  getPersona(), persona.example.json and, when set,
//                  MIND_GUARD_PERSONA_FILE (an install's persona.json, read-only).
//   6. logging   — no logger call in src/mind/ passes a text-bearing field (digest,
//                  summary, today_note, thread, intent, voiced, alt, note, reason,
//                  rationale, text, … and err) unless its value is provably a code/count,
//                  or it is one of the reviewed reason-CODE sites below (exact source
//                  text, so any edit forces a re-review); messages are plain literals;
//                  no console.* at all.
//   7. Mind page — src/dashboard/public/js/pages/mind.js has no raw( and no HTML sinks.
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
const MIND_DIR = path.join(SRC, 'mind');
const mindFiles = walk(MIND_DIR).map(p => {
  const src = read(p);
  const toks = lex(src);
  return { path: p, rel: rel(p), name: rel(p).slice('src/mind/'.length), src, toks, code: stripComments(src, toks) };
});
const appFiles = walk(SRC).filter(p => !p.startsWith(MIND_DIR + path.sep)).map(p => {
  const src = read(p);
  return { path: p, rel: rel(p), src, code: stripComments(src) };
});
const byName = (n) => mindFiles.find(f => f.name === n);

section('the scanner sees the mind');
{
  check('src/mind/ holds the mind modules (≥ 15 files, facade + store + proactive present)', mindFiles.length >= 15
    && ['index.js', 'store.js', 'proactive.js', 'cadence.js'].every(n => byName(n)), mindFiles.map(f => f.name));
  // The lexer must not lose sync: a regex like /['"]/ or a template with ${'}'} must not swallow code.
  const probe = "const a = /['\"`]/g; const b = `x${'}'}y`; // c 'd\nconst e = 'f'; /* g */ const h = 1 / 2 / 3;";
  const t = lex(probe);
  check('lexer: regex, nested template and comments stay in sync', t.filter(x => x.type === 'word' && x.value === 'const').length === 4
    && t.filter(x => x.type === 'comment').length === 2 && t.filter(x => x.type === 're').length === 1
    && stripComments(probe).includes("const e = 'f';") && !stripComments(probe).includes('g */'));
  check('every src/mind file lexes to balanced brackets', mindFiles.every(f => {
    let d = 0;
    for (const x of f.toks) if (x.type === 'punc') { if ('([{'.includes(x.value)) d++; else if (')]}'.includes(x.value)) d--; if (d < 0) return false; }
    return d === 0;
  }), mindFiles.filter(f => { let d = 0; for (const x of f.toks) if (x.type === 'punc') d += '([{'.includes(x.value) ? 1 : ')]}'.includes(x.value) ? -1 : 0; return d !== 0; }).map(f => f.name));
}

// ── 1. sends ─────────────────────────────────────────────────────────────────

section('1. only proactive.js reaches sendText / actions.js');
{
  const specifiers = (f) => [...f.code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g)].map(m => m[2]);
  const offenders = [];
  for (const f of mindFiles) {
    if (f.name === 'proactive.js') continue;
    if (/\bsendText\b/.test(f.code)) offenders.push(`${f.name}: sendText`);
    for (const s of specifiers(f)) if (/whatsapp\//.test(s)) offenders.push(`${f.name}: imports ${s}`);
    if (/actions\.js/.test(f.code)) offenders.push(`${f.name}: actions.js`);
  }
  eq('no other src/mind module names sendText, actions.js or src/whatsapp/', offenders, []);
  const p = byName('proactive.js');
  const wa = specifiers(p).filter(s => /whatsapp\//.test(s));
  check('proactive.js reaches src/whatsapp/ only for actions.js (sendText) and events.js (withChatLock)', wa.length >= 2
    && wa.every(s => /whatsapp\/(actions|events)\.js$/.test(s)), wa);
  check('proactive.js does use sendText (the guard is not vacuous)', /\bsendText\b/.test(p.code) && /actions\.js/.test(p.code));
  const direct = mindFiles.flatMap(f => [...f.code.matchAll(/\.\s*(sendMessage|sendPresenceUpdate|readMessages|relayMessage|chatModify|groupParticipantsUpdate|updateBlockStatus)\s*\(/g)]
    .map(m => `${f.name}:${lineOf(f.code, m.index)} .${m[1]}(`));
  eq('no src/mind module calls a socket method directly', direct, []);
}

// ── 2. owner namespace ──────────────────────────────────────────────────────

section('2. owner namespace: routes/mind.js via the facade; store.owner only in index.js');
{
  const facadeRe = /mind\/index\.js/;
  const importers = appFiles.filter(f => facadeRe.test(f.code));
  check('the app reaches the facade (index.js, systemPrompt, decisionEngine, the skill, routes/mind.js)', [
    'src/index.js', 'src/personality/systemPrompt.js', 'src/brain/decisionEngine.js', 'src/skills/mind.skill.js',
    'src/dashboard/routes/mind.js'].every(r => importers.some(f => f.rel === r)), importers.map(f => f.rel));
  // Any other src/mind module path from outside src/mind (static or dynamic, './mind/x.js' or '../../mind/x.js').
  const deep = appFiles.flatMap(f => [...f.code.matchAll(/(['"`])((?:\.\.?\/)+(?:src\/)?mind\/([\w.-]+))\1/g)]
    .filter(m => m[3] !== 'index.js').map(m => `${f.rel}: ${m[2]}`));
  eq('nothing outside src/mind/ imports a mind module other than the facade', deep, []);
  const ownerUse = (code) => /\.\s*owner\b|\?\.\s*owner\b|\[\s*['"`]owner['"`]\s*\]|\{[^{}]*\bowner\b[^{}]*\}\s*(?:=|from)/.test(code);
  const users = importers.filter(f => ownerUse(f.code)).map(f => f.rel);
  eq('of the facade importers, only src/dashboard/routes/mind.js touches `owner`', users, ['src/dashboard/routes/mind.js']);
  const routes = importers.find(f => f.rel === 'src/dashboard/routes/mind.js');
  check('routes/mind.js does reach mind.owner (the guard is not vacuous)', !!routes && /mind\??\.owner\b/.test(routes.code));

  const storeOwner = (f) => /\bstore\s*\??\.\s*owner\b|\bstore\s*\[\s*['"`]owner['"`]\s*\]/.test(f.code)
    || /\{[^{}]*\bowner\b[^{}]*\}\s*=\s*store\b/.test(f.code)
    || /import\s*\{[^}]*\bowner\b[^}]*\}\s*from\s*['"`]\.\/store\.js['"`]/.test(f.code)
    || /import\s*\*\s*as\s+(\w+)\s+from\s*['"`]\.\/store\.js['"`]/.test(f.code) && (() => {
      const alias = f.code.match(/import\s*\*\s*as\s+(\w+)\s+from\s*['"`]\.\/store\.js['"`]/)[1];
      return alias !== 'store' && new RegExp(`\\b${alias}\\s*\\??\\.\\s*owner\\b`).test(f.code);
    })();
  const inMind = mindFiles.filter(f => f.name !== 'store.js' && storeOwner(f)).map(f => f.name);
  eq('inside src/mind/, only index.js uses store.owner', inMind, ['index.js']);
  check('store.js exports the owner namespace', /export\s+const\s+owner\b/.test(byName('store.js').code));
  // The mind's own modules don't reach for the facade's owner either (no back door through index.js).
  const facadeOwner = mindFiles.filter(f => f.name !== 'index.js' && /from\s*['"`]\.\/index\.js['"`]|import\(\s*['"`]\.\/index\.js/.test(f.code))
    .map(f => f.name);
  eq('no src/mind module imports the facade', facadeOwner, []);
}

// ── 3. authority ────────────────────────────────────────────────────────────

section('3. no config / skill / mute writers in src/mind/');
{
  const FORBIDDEN = ['updateConfig', 'persistEnvDiff', 'updateLlmKeys', 'setSkillEnabled', 'muteGroup', 'unmuteGroup'];
  const hits = mindFiles.flatMap(f => FORBIDDEN.filter(n => new RegExp(`\\b${n}\\b`).test(f.code)).map(n => `${f.name}: ${n}`));
  eq('no src/mind module names a forbidden writer (code, comments excluded)', hits, []);
  const modHits = mindFiles.flatMap(f => [...f.code.matchAll(/(['"`])([^'"`\n]*(?:envWriter|dashboard\/routes\/|\/routes\/)[^'"`\n]*)\1/g)]
    .map(m => `${f.name}: ${m[2]}`));
  eq('no src/mind module imports the env writer or a dashboard route', modHits, []);
  // dashboard/state.js also exports muteGroup/unmuteGroup: only the read is imported.
  const stateImports = mindFiles.flatMap(f => [...f.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"`][^'"`]*dashboard\/state\.js['"`]/g)]
    .flatMap(m => m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).map(s => `${f.name}: ${s}`)));
  check('from dashboard/state.js the mind imports only isGroupMuted', stateImports.every(s => /: isGroupMuted$/.test(s)), stateImports);
  const nsState = mindFiles.filter(f => /import\s*\*\s*as\s+\w+\s+from\s*['"`][^'"`]*dashboard\/state\.js/.test(f.code)
    || /import\(\s*['"`][^'"`]*dashboard\/state\.js/.test(f.code)).map(f => f.name);
  eq('no namespace or dynamic import of dashboard/state.js', nsState, []);
  const assigns = mindFiles.flatMap(f => [
    ...[...f.code.matchAll(/\b(config|process\.env)((?:\s*\??\.\s*[\w$]+|\s*\[[^\]\n]+\])+)\s*(=(?!=)|\+=|-=|\*=|\/=|\|\|=|&&=|\?\?=|\+\+|--)/g)]
      .map(m => `${f.name}:${lineOf(f.code, m.index)} ${m[1]}${m[2].replace(/\s+/g, '')} ${m[3]}`),
    ...[...f.code.matchAll(/Object\.(assign|defineProperty)\(\s*(config|process\.env)\b/g)].map(m => `${f.name}:${lineOf(f.code, m.index)} Object.${m[1]}(${m[2]}`),
    ...[...f.code.matchAll(/\bdelete\s+(config|process\.env)\b/g)].map(m => `${f.name}:${lineOf(f.code, m.index)} delete ${m[1]}`),
  ]);
  eq('no src/mind module writes into config or process.env', assigns, []);
}

// ── 4. SQL ──────────────────────────────────────────────────────────────────

section('4. no SQL on the 006 tables; every table the mind names is reviewed');
{
  // The test:privacy import guard, verbatim, with no src/mind exemption.
  const BANNED = ['getNicknames', 'getGroupNicknames', 'getRelationshipsForPerson', 'getGroupRelationships',
    'getRelevantMemories', 'getMemoriesForPersonInChat', 'getMemoriesForPerson', 'getMemoriesForGroup', 'getTopSlang',
    'getMessagesBySenderAnyGroup', 'countMessagesBySenderAnyGroup'];
  const RAW_SQL = /\b(?:FROM|JOIN)\s+(memories|nicknames|relationships|person_facets|slang)\b/i;
  const privacy = [];
  for (const f of mindFiles) {
    for (const n of BANNED) if (new RegExp(`\\b${n}\\b`).test(f.src)) privacy.push(`${f.name}:${n}`);
    const raw = f.src.match(RAW_SQL);
    if (raw) privacy.push(`${f.name}:raw SQL on ${raw[1]}`);
  }
  eq('test:privacy import guard over src/mind/ (no exemption)', privacy, []);
  const SCOPED = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["`]?(memories|nicknames|relationships|person_facets|slang)\b/i;
  const writes = mindFiles.flatMap(f => literals(f.src, f.toks).filter(l => SCOPED.test(l.text)).map(l => `${f.name}:${l.line}`));
  eq('no SQL literal in src/mind/ reads or writes a 006 provenance table', writes, []);

  const sqlFiles = mindFiles.filter(f => /\bgetDb\b|\.prepare\s*\(|\bdb\s*\.\s*exec\s*\(|\.pragma\s*\(|\bnew\s+Database\b|better-sqlite3/.test(f.code)).map(f => f.name).sort();
  eq('only store.js and think.js touch the database handle', sqlFiles, ['store.js', 'think.js']);

  const TABLE_RE = /\b(FROM|JOIN|INTO|UPDATE)\s+["`]?([A-Za-z_][\w]*)/g;
  const SQLISH = /\b(SELECT|INSERT|UPDATE|DELETE)\b/;
  const named = [];
  const dynamic = [];   // interpolated table names: ${table}
  for (const f of mindFiles) {
    for (const l of literals(f.src, f.toks)) {
      if (!SQLISH.test(l.text)) continue;
      for (const m of l.text.matchAll(TABLE_RE)) {
        if (m[1].toUpperCase() === 'UPDATE' && /\bDO\s+$/i.test(l.text.slice(0, m.index))) continue;   // upsert: ON CONFLICT … DO UPDATE SET
        named.push({ file: f.name, line: l.line, verb: m[1].toUpperCase(), table: m[2], sql: l.text });
      }
      for (const m of l.text.matchAll(/\b(FROM|JOIN|INTO|UPDATE)\s+\$\{\s*([\w$]+)\s*\}/g)) dynamic.push({ file: f.name, line: l.line, verb: m[1].toUpperCase(), name: m[2] });
    }
  }
  check('the SQL scan found the mind tables (non-vacuous)', named.filter(n => n.table.startsWith('mind_')).length >= 50, named.length);
  const reviewed = (n) => {
    if (n.table.startsWith('mind_')) return n.file === 'store.js';
    // plan 020 B: his interests and opinions, the mind's own tables
    if (n.table.startsWith('self_stance')) return n.file === 'store.js';
    const writesTo = n.verb === 'INTO' || n.verb === 'UPDATE' || /^\s*DELETE\b/i.test(n.sql.slice(0, n.sql.search(/\bFROM\b/i) + 1) || '');
    const deleteStmt = /\bDELETE\s+FROM\s+["`]?item_evidence\b/i.test(n.sql);
    switch (n.table) {
      // cursors only: MAX(rowid) [per chat] — never a content column
      case 'messages': return n.file === 'store.js' && n.verb === 'FROM' && !/\b(content|sender_jid|sender_name|metadata_json|\*)\b|\*/.test(n.sql)
        && /MAX\(rowid\)/i.test(n.sql);
      case 'world_events': return n.file === 'store.js' && n.verb === 'FROM' && /MAX\(id\)/i.test(n.sql);
      // the digests' own evidence rows
      case 'item_evidence': return n.file === 'store.js' && /item_type\s*=\s*'mind_digest'|VALUES\s*\(\s*'mind_digest'/.test(n.sql)
        && (!deleteStmt || /item_type\s*=\s*'mind_digest'/.test(n.sql));
      case 'sqlite_master': return n.file === 'store.js' && n.verb === 'FROM';
      // read of the identity.reassign audit row (exclusion copy on reassignment)
      case 'dashboard_audit': return n.file === 'store.js' && n.verb === 'FROM' && !writesTo && /action\s*=\s*'identity\.reassign'/.test(n.sql);
      // the 007 ledger, read for the mind's own budget gate
      case 'llm_usage': return n.file === 'think.js' && n.verb === 'FROM' && /role\s*=\s*'mind'/.test(n.sql);
      default: return false;
    }
  };
  const unreviewed = named.filter(n => !reviewed(n)).map(n => `${n.file}:${n.line} ${n.verb} ${n.table}`);
  eq('every table named by mind SQL is a mind table (store.js) or a reviewed read/evidence exception', unreviewed, []);
  // Interpolated table names (${table}) are only store.js's generic helpers and loops, and every
  // value they can take is a mind_* literal: insertRow/updateById call sites, and for-of loops
  // over array literals.
  const store = byName('store.js');
  check('interpolated table names occur only in store.js', dynamic.length >= 1 && dynamic.every(d => d.file === 'store.js'),
    dynamic.map(d => `${d.file}:${d.line}`));
  const helperCalls = [...store.code.matchAll(/\b(insertRow|updateById)\s*\(\s*[\w$]+\s*,\s*([^,)]+)/g)]
    .filter(m => !/function\s+$/.test(store.code.slice(Math.max(0, m.index - 10), m.index)));
  check('every insertRow/updateById call passes a mind_* table literal', helperCalls.length >= 5
    && helperCalls.every(m => /^\s*'mind_\w+'\s*$/.test(m[2])), helperCalls.filter(m => !/^\s*'mind_\w+'\s*$/.test(m[2])).map(m => `${lineOf(store.code, m.index)}: ${m[2]}`));
  const loopVars = new Map();
  for (const m of store.code.matchAll(/for\s*\(\s*const\s+([\w$]+)\s+of\s+\[([^\]]*)\]\s*\)/g)) {
    const items = m[2].split(',').map(s => s.trim()).filter(Boolean);
    loopVars.set(`${m[1]}@${lineOf(store.code, m.index)}`, items.every(s => /^'mind_\w+'$/.test(s)));
  }
  const unsafeDynamic = dynamic.filter(d => {
    if (d.name === 'table' && /function\s+(insertRow|updateById)\b/.test(store.code)) {
      const fnLines = [...store.code.matchAll(/function\s+(insertRow|updateById)\b/g)].map(m => lineOf(store.code, m.index));
      if (fnLines.some(l => d.line >= l && d.line <= l + 12)) return false;
    }
    // the nearest preceding for-of over a literal array that binds this name (≤ 6 lines above)
    const loop = [...loopVars].filter(([k]) => k.startsWith(`${d.name}@`)).map(([k, ok]) => ({ line: Number(k.split('@')[1]), ok }))
      .filter(x => x.line <= d.line && d.line - x.line <= 6).sort((a, b) => b.line - a.line)[0];
    return !(loop && loop.ok);
  }).map(d => `${d.file}:${d.line} ${d.verb} \${${d.name}}`);
  eq('every interpolated table name is bound to mind_* literals only', unsafeDynamic, []);
  const foreignWrites = named.filter(n => !n.table.startsWith('mind_') && (n.verb === 'INTO' || n.verb === 'UPDATE'
    || (n.verb === 'FROM' && /\bDELETE\s+FROM\s+["`]?\w+/i.test(n.sql) && new RegExp(`DELETE\\s+FROM\\s+["\`]?${n.table}\\b`, 'i').test(n.sql))))
    .map(n => `${n.file}:${n.line} ${n.verb} ${n.table}`);
  check('the only non-mind writes are the digests\' own item_evidence rows and his stances', foreignWrites.every(s => /item_evidence$/.test(s) || /^store\.js:\d+ \w+ self_stance(_evidence|_history)?$/.test(s)), foreignWrites);
}

// ── 5. persona strings ──────────────────────────────────────────────────────

section('5. no persona strings in src/mind/');
{
  const { getPersona } = await import('../../src/utils/config.js');
  const sources = [];
  try { sources.push(getPersona()); } catch { /* fallback below */ }
  sources.push(JSON.parse(read(path.join(PROJECT_ROOT, 'src/personality/persona.example.json'))));
  if (process.env.MIND_GUARD_PERSONA_FILE) {
    try { sources.push(JSON.parse(read(process.env.MIND_GUARD_PERSONA_FILE))); }
    catch (err) { check('MIND_GUARD_PERSONA_FILE is readable JSON', false, err.message); }
  }
  const names = new Set(['Karyasthan']);
  const phrases = new Set();
  for (const p of sources) {
    for (const k of ['name', 'displayName']) if (typeof p?.[k] === 'string' && p[k].trim()) names.add(p[k].trim());
    for (const a of Array.isArray(p?.aliases) ? p.aliases : []) if (typeof a === 'string' && a.trim()) names.add(a.trim());
    for (const k of ['region', 'language', 'vibe', 'voiceDescriptor']) if (typeof p?.[k] === 'string' && p[k].trim()) phrases.add(p[k].trim());
  }
  check('persona terms loaded (name + aliases + phrases)', names.size >= 2 && phrases.size >= 2, { names: names.size, phrases: phrases.size });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = (t) => new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(t)}($|[^\\p{L}\\p{N}_])`, 'iu');
  const nameHits = mindFiles.flatMap(f => [...names].filter(t => word(t).test(f.src)).map(t => `${f.name}: name #${[...names].indexOf(t)}`));
  eq('no persona name or alias anywhere in src/mind/ (comments included)', nameHits, []);
  const phraseHits = mindFiles.flatMap(f => [...phrases].filter(t => word(t).test(f.code)).map(t => `${f.name}: phrase #${[...phrases].indexOf(t)}`));
  eq('no persona region/language/vibe/voice phrase in src/mind/ code', phraseHits, []);
  if (!process.env.MIND_GUARD_PERSONA_FILE) console.log('    (set MIND_GUARD_PERSONA_FILE=<install>/src/personality/persona.json to check a real persona too)');
}

// ── 6. logging ──────────────────────────────────────────────────────────────

section('6. mind logs carry ids, counts, statuses and reason codes only');
{
  const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  // Normalised (lower case, no _) keys whose value could carry chat- or model-derived text.
  const TEXT_KEYS = new Set(['digest', 'digests', 'summary', 'todaynote', 'today', 'thread', 'threads', 'intent', 'intents',
    'voiced', 'voicedtext', 'alt', 'alttext', 'note', 'notes', 'reason', 'reasons', 'rationale', 'text', 'texts', 'content',
    'body', 'message', 'messages', 'msg', 'episode', 'episodes', 'proposal', 'changessummary', 'gatereason', 'selfmodel',
    'line', 'lines', 'snippet', 'prompt', 'system', 'user', 'output', 'raw', 'err', 'error', 'lasterror', 'optout', 'quote',
    'name', 'names', 'pushname']);
  // Reviewed reason-CODE sites (exact source text, whitespace collapsed). Every value here is a
  // code from a fixed set inside src/mind (never gate/model/chat text): drop() reasons come from
  // the eligibility/voice checks' `{ reason: '<code>' }` returns, finalize() reasons are literals
  // or those codes, consider() notes are the same codes, cancelQueued() reasons are literals
  // from its callers (skill_off/paused/mode_changed/exclude_all) and are capped at 40 chars.
  // Spreads: sleep.js warn() is only ever called with (where, err); hooks.js spreads its
  // registration booleans.
  const REVIEWED = new Map([
    ['proactive.js', [
      "logger.info({ evt: 'mind.proactive', id, status: 'dropped', reason }, 'proactive draft dropped')",
      "logger.info({ evt: 'mind.proactive', runId, drafted: out.drafted.length, notes: out.notes.map(n => n.reason) }, 'proactive candidates considered')",
      "logger.info({ evt: 'mind.proactive', id, status, reason: reason || null }, 'proactive dispatch outcome')",
      "logger.info({ evt: 'mind.proactive', cancelled: n, reason: String(reason).slice(0, 40) }, 'queued proactive drafts cancelled')",
    ]],
    ['sleep.js', ["deps.logger.warn({ evt: 'issue', where: `mind.sleep.${where}`, code: errCode(err), ...extra }, 'mind sleep step failed')"]],
    ['hooks.js', ["deps.logger.warn({ evt: 'issue', where: 'mind.hooks.register', ...status }, 'mind: a 006 deletion seam is missing')"]],
  ]);
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
  const usedReviewed = new Set();

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
  const splitTop = (toks, from, to) => {          // [from, to) → arrays of tokens split at depth-0 commas
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
    return false;
  };

  let calls = 0;
  let consoleCalls = 0;
  const problems = [];
  for (const f of mindFiles) {
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
      const reviewedHere = (REVIEWED.get(f.name) || []).map(norm).includes(callText);
      if (reviewedHere) { usedReviewed.add(`${f.name}|${callText}`); continue; }
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
  const plain = mindFiles.reduce((n, f) => n + [...f.code.matchAll(/\blogger\s*\.\s*(trace|debug|info|warn|error|fatal)\s*\(/g)].length, 0);
  check(`the scan parsed every logger call (${calls} found, ${plain} by regex; ≥ 30)`, calls === plain && calls >= 30, { calls, plain });
  eq('no logger call passes a text-bearing field, a spread, a non-literal first argument or message', problems, []);
  eq('no console.* in src/mind/', consoleCalls, 0);
  const stale = [...REVIEWED].flatMap(([file, list]) => list.map(norm).filter(c => !usedReviewed.has(`${file}|${c}`)).map(c => `${file}: ${c.slice(0, 80)}`));
  eq('every reviewed reason-code site still exists verbatim (else re-review and update the list)', stale, []);
  // The reviewed reason fields stay codes: no drop/finalize/cancelQueued call passes gate or model text.
  const p = byName('proactive.js');
  const taint = [...p.code.matchAll(/\b(drop|finalize|cancelQueued)\s*\(([^;\n]*)/g)]
    .filter(m => /\bgateReason\b|\bgate\s*\??\.\s*reason\b|\b(text|intent|voiced|altText|summary|note|rationale)\b|\.reason\b(?<!\b(b|v|c|r)\.reason)/.test(m[2].split(')')[0]))
    .map(m => `proactive.js:${lineOf(p.code, m.index)} ${m[1]}(${m[2].slice(0, 60)}`);
  eq('drop/finalize/cancelQueued reasons are codes (no gate/model/chat text, no foreign .reason)', taint, []);
  const nonLiteralCancel = [...appFiles, ...mindFiles].flatMap(f => [...f.code.matchAll(/(?<!function\s+)\bcancelQueued\s*\(\s*([^)]*)\)/g)]
    .filter(m => m[1].trim() && !/^['"][\w-]{1,40}['"]$/.test(m[1].trim()) && !/^reason$/.test(m[1].trim()))
    .map(m => `${f.rel}: cancelQueued(${m[1]})`));
  eq('every cancelQueued(…) caller passes a literal code', nonLiteralCancel, []);
  const sleepWarn = [...byName('sleep.js').code.matchAll(/(?<![.\w])warn\s*\(([^;]*?)\)\s*;/g)]
    .filter(m => !/^\s*where\b/.test(m[1]))
    .filter(m => splitTop(lex(`(${m[1]})`), 1, lex(`(${m[1]})`).length - 1).length > 2)
    .map(m => `sleep.js:${lineOf(byName('sleep.js').code, m.index)} warn(${m[1].slice(0, 60)})`);
  eq('sleep.js warn() is never called with an extra (spread) object', sleepWarn, []);
}

// ── 7. the Mind page ────────────────────────────────────────────────────────

section('7. pages/mind.js renders through auto-escaping html`` only');
{
  const file = path.join(PROJECT_ROOT, 'src/dashboard/public/js/pages/mind.js');
  const src = read(file);
  const code = stripComments(src);
  eq('no raw( in pages/mind.js (anywhere)', [...src.matchAll(/\braw\s*\(/g)].map(m => lineOf(src, m.index)), []);
  check('raw is not imported under another name', !/\braw\s+as\s+\w+/.test(code) && !/import\s*\{[^}]*\braw\b[^}]*\}/.test(code));
  const sinks = [...code.matchAll(/\.(innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(|\bdocument\.write(ln)?\s*\(|\bnew\s+Function\s*\(|\beval\s*\(|createContextualFragment/g)]
    .map(m => `${lineOf(code, m.index)}: ${m[0]}`);
  eq('no HTML sinks (innerHTML/outerHTML/insertAdjacentHTML/document.write/eval/Function)', sinks, []);
  check('the page renders with html`` (the guard is not vacuous)', /\bhtml`/.test(code));
}

report();
