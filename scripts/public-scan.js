#!/usr/bin/env node
// A pre-push guard for a public repo: looks through the blobs of a ref or a range for this
// install's private words and for shapes that shouldn't be published. It prints a label, a path
// and a count, never what matched. Exit 0 clean, 1 on a hit, 2 when it couldn't check.
//
//   node scripts/public-scan.js                     # the tree at HEAD
//   node scripts/public-scan.js <ref>               # the tree at a ref
//   node scripts/public-scan.js <a>..<b>            # every blob and commit message in a range
//   node scripts/public-scan.js --all               # every blob and message on every ref
//   node scripts/public-scan.js --pre-push          # git's pre-push stdin: what this push adds
//
//   --repo <dir>     the repository (default: this directory's)
//   --sources <dir>  where persona.json, world.json and arcs.json live (default: <repo>/src/personality)
//   --words <file>   the private-words file (default: <repo>/data/private-words.txt, gitignored)
//   --db <file>      also a database, opened read only: contacts' names, phones, JIDs and LIDs,
//                    groups' names and JIDs, what people wrote and story text (lines of 25+ characters,
//                    exact, kept as hashes; never the bot's own lines), the cast and places the Director added
//   --strict         no sources found, or a database with no contacts or messages, is an error
//
// Private-words file: one word or phrase a line, # for a comment. "!word" says a word taken from
// the sources is an ordinary word here, without a tracked file having to name it. "!row:messages#331"
// leaves one row of text out of --db: the same line in another row still counts.
//
// Docs: docs/claude/public-scan.md
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Words ────────────────────────────────────────────────────────────────────

// Words a place, a job or a name can be made of without identifying anyone.
const GENERIC = new Set(`home flat office cafe café coffee corner neighbourhood neighborhood gym supermarket grocery store
  shop lake park walking track meals place restaurant bar brewpub pub mall multiplex cinema theatre theater badminton
  courts court sports family house the and of in at near new old main city town street road station club centre center
  hall market bakery kitchen garden beach temple church school college hospital clinic hotel tower square north south
  east west central big small little good best first last great blue green red white black golden silver sun moon star
  river hill hills lane cross layout block phase stage sector nagar company studio labs lab tech systems solutions
  services group works work foods food tea juice stall gate bridge point view plaza arcade inc ltd llc pvt limited
  caretaker technologies software example another hometown coworker flatmate manager friend sister brother mother father mom dad
  mum aunt uncle cousin parents january february march april may june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/).filter(Boolean));

const TOKEN = /[\p{L}\p{M}\p{N}_]+/gu;
const nfkc = (s) => String(s ?? '').normalize('NFKC');
const tokensOf = (s) => nfkc(s).toLowerCase().match(TOKEN) || [];
const strings = (v) => (Array.isArray(v) ? v : [v]).filter(s => typeof s === 'string' && s.trim());

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { throw new Error(`can't parse ${path.basename(file)}`); }
}

/** Every string anywhere inside a value. */
function deepStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => deepStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => deepStrings(x, out));
  return out;
}

/**
 * What to look for. A word or phrase is matched whole, in any case, whatever the punctuation
 * between its words. A ref says where a word came from (a file, or a table and row), never what it is.
 */
class Lexicon {
  constructor({ notPrivate, project }) {
    this.notPrivate = notPrivate;
    this.project = project;
    this.words = new Map();
    this.phrases = new Map();
    this.coords = new Map();
    this.ids = new Map();
    this.last10 = new Map();
    this.counts = {};
  }

  note(kind) { this.counts[kind] = (this.counts[kind] ?? 0) + 1; }

  addWord(label, token, ref) {
    if (!this.words.has(token)) this.words.set(token, { label, ref });
  }

  /** A whole phrase (or one word), as written. */
  addPhrase(label, text, ref) {
    const t = tokensOf(text);
    if (!t.length || this.notPrivate.has(t.join(' '))) return;
    if (t.length === 1) { this.addWord(label, t[0], ref); return; }
    const list = this.phrases.get(t[0]) ?? [];
    list.push({ rest: t.slice(1), label, ref });
    this.phrases.set(t[0], list);
  }

  /** A name: the whole of it, and each of its words that could identify someone. */
  addName(label, text, ref, { properOnly = false, min = 3 } = {}) {
    if (!strings(text).length) return;
    const raw = nfkc(text).match(TOKEN) || [];
    // Generic words together aren't a name: the phrase counts only if one of its words could be.
    if (raw.length > 1 && raw.some(w => !this.notPrivate.has(w.toLowerCase()))) this.addPhrase(label, raw.join(' '), ref);
    for (const w of raw) {
      const low = w.toLowerCase();
      if (/^[\p{N}_]+$/u.test(w) || (properOnly && !/^\p{Lu}/u.test(w))) continue;
      // A script without case or spaces says more in fewer letters.
      if (low.length < (/^[\x00-\x7f]+$/.test(low) ? min : 2)) continue;
      if (this.notPrivate.has(low) || (this.project && this.project.startsWith(low))) continue;
      this.addWord(label, low, ref);
    }
  }

  /** A whole line of text, copied. */
  addLine(label, text, ref, exampleLines) {
    const t = nfkc(text).trim();
    if (t.length >= 24 && tokensOf(t).length >= 4 && !exampleLines.has(t.toLowerCase())) this.addPhrase(label, t, ref);
  }

  /** A place's lat or lon, to two decimals. */
  addCoord(n, ref) {
    if (Number.isFinite(n) && Math.abs(n) >= 1) this.coords.set((Math.trunc(Math.abs(n) * 100) / 100).toFixed(2), ref);
  }

  /** The digits of a JID or a phone, with the last ten for a number written another way. */
  addId(label, value, ref) {
    const bare = String(value ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
    if (bare.length < 7) return false;
    if (!this.ids.has(bare)) this.ids.set(bare, { label, ref });
    if (bare.length >= 10 && !this.last10.has(bare.slice(-10))) this.last10.set(bare.slice(-10), { label, ref });
    return true;
  }

  finish() {
    const forms = [...this.coords.keys()].map(n => n.replace('.', '\\.'));
    this.coordRe = forms.length ? new RegExp(`(?<![\\d.])-?(?:${forms.join('|')})\\d*(?![\\d])`, 'g') : null;
  }
}

/** The install's gitignored files and the private-words file. A language is left out: language features are in the code on purpose. */
export function loadWords({ repo, sourcesDir, wordsFile }) {
  const sources = {
    persona: readJson(path.join(sourcesDir, 'persona.json')),
    world: readJson(path.join(sourcesDir, 'world.json')),
    arcs: readJson(path.join(sourcesDir, 'arcs.json')),
  };
  const examples = [readJson(path.join(repo, 'src/personality/world.example.json')),
    readJson(path.join(repo, 'src/personality/arcs.example.json')),
    readJson(path.join(repo, 'src/personality/persona.example.json'))].filter(Boolean);
  const exampleLines = new Set(deepStrings(examples).map(s => s.trim().toLowerCase()));
  const notPrivate = new Set(GENERIC);
  for (const s of exampleLines) for (const w of tokensOf(s)) notPrivate.add(w);
  const project = String(readJson(path.join(repo, 'package.json'))?.name ?? '').toLowerCase();

  const privateWords = [];
  const skipRows = new Set();
  if (fs.existsSync(wordsFile)) {
    for (const raw of fs.readFileSync(wordsFile, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('!row:')) skipRows.add(line.slice(5).trim());
      else if (line.startsWith('!')) notPrivate.add(tokensOf(line.slice(1)).join(' '));
      else privateWords.push(line);
    }
  }

  const lex = new Lexicon({ notPrivate, project });
  lex.exampleLines = exampleLines;
  lex.skipRows = skipRows;
  const { persona, world, arcs } = sources;
  if (persona) {
    for (const s of [...strings(persona.name), ...strings(persona.displayName), ...strings(persona.aliases)]) lex.addName('name', s, 'persona');
    lex.addName('name', persona.region, 'persona', { properOnly: true, min: 4 });
    for (const s of strings(persona.voiceDescriptor).concat(strings(persona.vibe))) lex.addLine('story', s, 'persona', exampleLines);
  }
  if (world) {
    for (const p of world.places ?? []) {
      lex.addName('name', p?.name, 'world');
      lex.addCoord(p?.lat, 'world');
      lex.addCoord(p?.lon, 'world');
    }
    for (const c of world.cast ?? []) {
      lex.addName('name', c?.name, 'world');
      lex.addName('name', c?.hometown, 'world', { properOnly: true, min: 4 });
      lex.addName('name', c?.employer, 'world', { properOnly: true, min: 4 });
      for (const k of ['personality', 'speech', 'availability', 'status']) lex.addLine('story', c?.[k], 'world', exampleLines);
      for (const h of c?.history ?? []) lex.addLine('story', h, 'world', exampleLines);
    }
    for (const s of [world.self?.job?.employerName, world.region, world.city]) lex.addName('name', s, 'world', { properOnly: true, min: 4 });
  }
  if (arcs) {
    for (const e of arcs.career?.employers ?? []) lex.addName('name', e?.name, 'arcs', { properOnly: true, min: 4 });
    for (const o of arcs.family?.occasions ?? []) lex.addName('name', o?.label, 'arcs', { properOnly: true, min: 4 });
    for (const s of deepStrings([arcs.castStatus, arcs.romance, arcs.family?.themes, arcs.family?.majorDecisions, arcs.heavy])) lex.addLine('story', s, 'arcs', exampleLines);
  }
  for (const w of privateWords) lex.addPhrase('private-word', w, 'private-words');
  lex.counts.privateWords = privateWords.length;

  return {
    lex,
    found: Object.entries(sources).filter(([, v]) => v).map(([k]) => k),
    missing: Object.entries(sources).filter(([, v]) => !v).map(([k]) => k),
  };
}

// ── The database ─────────────────────────────────────────────────────────────

// Text lines are only ever held as hashes. A line counts from this length, matched exactly (any
// case, any spacing, a backslash aside: a line inside a quoted string still matches).
const LINE_MIN = 25;
const normLine = (s) => nfkc(s).toLowerCase().replace(/\\/g, '').replace(/\s+/g, ' ').trim();
const BASE = 257;
const MOD = 2 ** 37 - 25; // nothing here leaves a double's exact range
const WINDOW_POW = (() => { let p = 1; for (let i = 1; i < LINE_MIN; i += 1) p = (p * BASE) % MOD; return p; })();
const lineHash = (s) => crypto.createHash('sha1').update(s).digest().readUIntBE(0, 6);

class LineIndex {
  constructor() {
    this.sources = [];
    this.prefix = new Map(); // hash of a line's first LINE_MIN units → its length(s)
    this.full = new Map(); // hash of a line → source * 2^40 + rowid
    this.size = 0;
  }

  source(label, table) {
    this.sources.push({ label, table });
    return this.sources.length - 1;
  }

  add(sourceIdx, rowid, text, skip = null) {
    let added = 0;
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line = normLine(raw);
      if (line.length < LINE_MIN || skip?.has(lineHash(line))) continue;
      let h = 0;
      for (let i = 0; i < LINE_MIN; i += 1) h = (h * BASE + line.charCodeAt(i)) % MOD;
      const at = this.prefix.get(h);
      if (at === undefined) this.prefix.set(h, line.length);
      else if (typeof at === 'number') { if (at !== line.length) this.prefix.set(h, [at, line.length]); }
      else if (!at.includes(line.length)) at.push(line.length);
      const key = lineHash(line);
      if (!this.full.has(key)) { this.full.set(key, sourceIdx * 2 ** 40 + rowid); added += 1; }
    }
    this.size += added;
    return added;
  }

  /** Calls found(label, ref) for each copied line in a text. */
  scan(text, found) {
    if (!this.size) return;
    const s = normLine(text);
    if (s.length < LINE_MIN) return;
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      if (i >= LINE_MIN) h = (h - (s.charCodeAt(i - LINE_MIN) * WINDOW_POW) % MOD + MOD) % MOD;
      h = (h * BASE + s.charCodeAt(i)) % MOD;
      if (i < LINE_MIN - 1) continue;
      const at = this.prefix.get(h);
      if (at === undefined) continue;
      const start = i - LINE_MIN + 1;
      for (const len of typeof at === 'number' ? [at] : at) {
        if (start + len > s.length) continue;
        const code = this.full.get(lineHash(s.substring(start, start + len)));
        if (code === undefined) continue;
        const src = this.sources[Math.floor(code / 2 ** 40)];
        found(src.label, `${src.table}#${code % 2 ** 40}`);
      }
    }
  }
}

const bareJid = (j) => String(j ?? '').replace(/:\d+(?=@)/, '');
const NEEDED_TABLES = ['people', 'person_identities', 'groups', 'messages'];
// Text that says something about a real person or his story, if the table is there.
const TEXT_TABLES = [
  ['memories', 'content', 'memory-text'],
  ['people', 'summary', 'memory-text'],
  ['story_messages', 'text', 'story-text'],
  ['story_messages', 'edited_text', 'story-text'],
  ['story_scenes', 'text', 'story-text'],
  ['story_scenes', 'edited_text', 'story-text'],
  ['story_journal_parts', 'text', 'story-text'],
];

/** Reads names, identities, groups and text from a database, opened read only. Nothing kept but words, digits and hashes. */
export async function loadDb(file, lex) {
  if (!fs.existsSync(file)) throw new Error('no such database');
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const lines = new LineIndex();
  const counts = { contacts: 0, groups: 0, ids: 0, messageLines: 0, otherLines: 0, castNames: 0, rowsOptedOut: 0 };
  try {
    db.pragma('query_only = ON');
    const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const hasColumn = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
    for (const t of NEEDED_TABLES) if (!hasTable(t)) throw new Error(`no ${t} table: not this project's database`);

    const id = (label, v, ref) => { if (lex.addId(label, v, ref)) counts.ids += 1; };
    for (const r of db.prepare('SELECT rowid AS r, jid, phone, push_name, real_name FROM people').iterate()) {
      const ref = `people#${r.r}`;
      counts.contacts += 1;
      id('contact-id', r.jid, ref);
      id('contact-id', r.phone, ref);
      lex.addName('contact-name', r.push_name, ref);
      lex.addName('contact-name', r.real_name, ref);
    }
    for (const r of db.prepare('SELECT rowid AS r, jid, person_jid FROM person_identities').iterate()) {
      id('contact-id', r.jid, `person_identities#${r.r}`);
      id('contact-id', r.person_jid, `person_identities#${r.r}`);
    }
    for (const r of db.prepare('SELECT rowid AS r, jid, name FROM groups').iterate()) {
      counts.groups += 1;
      id('group-id', r.jid, `groups#${r.r}`);
      // The whole name: one word of a group's name is rarely its own.
      if (typeof r.name === 'string' && nfkc(r.name).length >= 4) lex.addPhrase('group-name', r.name, `groups#${r.r}`);
    }
    if (hasTable('nicknames')) {
      for (const r of db.prepare('SELECT rowid AS r, nickname FROM nicknames').iterate()) lex.addName('contact-name', r.nickname, `nicknames#${r.r}`);
    }
    for (const r of db.prepare('SELECT DISTINCT sender_name AS n, min(rowid) AS r FROM messages WHERE sender_name IS NOT NULL GROUP BY sender_name').iterate()) {
      lex.addName('contact-name', r.n, `messages#${r.r}`);
    }
    for (const r of db.prepare('SELECT DISTINCT sender_jid AS j, min(rowid) AS r FROM messages GROUP BY sender_jid').iterate()) id('contact-id', r.j, `messages#${r.r}`);
    for (const r of db.prepare('SELECT DISTINCT group_jid AS j, min(rowid) AS r FROM messages GROUP BY group_jid').iterate()) {
      id(String(r.j).endsWith('@g.us') ? 'group-id' : 'contact-id', r.j, `messages#${r.r}`);
    }

    // A person's words. The bot's own lines are often this code's templates, so they aren't text to
    // find here, sent or quoted back. A schema without the column counts every line, and says so.
    const msg = lines.source('message-text', 'messages');
    const knowsSelf = hasColumn('messages', 'is_from_self');
    const selfJids = new Set();
    if (knowsSelf) {
      for (const r of db.prepare('SELECT DISTINCT sender_jid AS j FROM messages WHERE is_from_self = 1').iterate()) selfJids.add(bareJid(r.j));
      counts.selfLinesSkipped = db.prepare('SELECT count(*) AS n FROM messages WHERE is_from_self = 1').get().n;
    } else counts.selfLinesSkipped = null;
    // A quote can come without its author, so a quoted line the bot itself sent is the bot's too. The
    // person's own lines are never skipped this way: if someone wrote it, their row still finds it.
    const selfLines = new Set();
    if (knowsSelf) {
      for (const r of db.prepare('SELECT content FROM messages WHERE is_from_self = 1 AND content IS NOT NULL').iterate()) {
        for (const raw of String(r.content).split(/\r?\n/)) {
          const line = normLine(raw);
          if (line.length >= LINE_MIN) selfLines.add(lineHash(line));
        }
      }
    }
    const hasQuotedBy = hasColumn('messages', 'quoted_participant');
    const hasType = hasColumn('messages', 'message_type');
    const textSql = `SELECT rowid AS r, content, quoted_content${hasQuotedBy ? ', quoted_participant AS qp' : ''}${hasType ? ', message_type AS mt' : ''} FROM messages${knowsSelf ? ' WHERE coalesce(is_from_self, 0) = 0' : ''}`;
    for (const r of db.prepare(textSql).iterate()) {
      if (lex.skipRows.has(`messages#${r.r}`)) { counts.rowsOptedOut += 1; continue; }
      // A media message whose whole text is a [placeholder] holds no one's words. A typed line in brackets does.
      const placeholder = r.mt && r.mt !== 'text' && /^\[[^\[\]\n]*\]$/.test(String(r.content ?? '').trim());
      if (!placeholder) counts.messageLines += lines.add(msg, r.r, r.content);
      if (!(r.qp && selfJids.has(bareJid(r.qp)))) counts.messageLines += lines.add(msg, r.r, r.quoted_content, selfLines);
    }
    for (const [table, column, label] of TEXT_TABLES) {
      if (!hasTable(table) || !hasColumn(table, column)) continue;
      const src = lines.source(label, table);
      for (const r of db.prepare(`SELECT rowid AS r, ${column} AS t FROM ${table} WHERE ${column} IS NOT NULL`).iterate()) {
        if (lex.skipRows.has(`${table}#${r.r}`)) { counts.rowsOptedOut += 1; continue; }
        counts.otherLines += lines.add(src, r.r, r.t);
      }
    }

    // The cast and places the Director added: in the log, not in world.json.
    if (hasTable('world_events')) {
      const ev = db.prepare("SELECT id, type, payload_json FROM world_events WHERE type IN ('cast.created', 'place.created')");
      for (const r of ev.iterate()) {
        let p = null;
        try { p = JSON.parse(r.payload_json); } catch { continue; }
        lex.addName('story-name', p?.name, `world_events#${r.id}`);
        lex.addCoord(p?.lat, `world_events#${r.id}`);
        lex.addCoord(p?.lon, `world_events#${r.id}`);
        counts.castNames += 1;
      }
    }
  } finally {
    db.close();
  }
  return { lines, counts };
}

// ── Shapes ───────────────────────────────────────────────────────────────────

const EMAIL_DOMAIN_OK = /^(?:s\.whatsapp\.net|g\.us|lid|c\.us|broadcast|anthropic\.com|users\.noreply\.github\.com|b\.com?|example\.[a-z.]+|[a-z0-9.-]+\.(?:example|invalid|test|localhost))$/i;

// Numbers that are plainly made up, or aren't phone numbers at all.
const FAKE_NUMBER = [
  /^1[5-9]\d{8}$/,          // unix seconds
  /^1[5-9]\d{11}$/,         // unix milliseconds
  /^1?555\d{7}$/,           // the 555 range
  /0{4}/,                   // a run of zeros
  /(\d)\1{5}/,              // a run of one digit
  /^[01]?5550100\d{3}$/,    // the range set aside for fiction, with or without its code or a leading 0
  /^1555\d{8}$/,            // the 555 range, a digit longer
  /^0?123456789\d*$/,       // counting
  /^1234567890\d*$/,
  /^6180339887/,            // the golden ratio's digits
  /^(?:1103515245|2147483648|4294967296|4102444800)$/, // a generator's constant, 2^31, 2^32, the year 2100
  /^(?:44|0)?7700900\d{3}$/, // the UK's range for fiction, the same
  /^\d{0,4}12345678$/,      // counting
  /(\d)\1{3}(\d)\2{3}/,      // 1111 2222 …
];
const looksFake = (digits) => FAKE_NUMBER.some(re => re.test(digits));

// An address is a hit unless it's loopback, a documentation range, or one of these: the network
// addresses of the ranges code refuses or allows by CIDR, and the samples the SSRF tests name.
const IPV4_OK = new Set([
  '0.0.0.0', '255.255.255.255', // any, broadcast
  '10.0.0.0', '100.64.0.0', '124.0.0.0', '169.254.0.0', '172.16.0.0', '192.168.0.0', '224.0.0.0', '240.0.0.0', // range starts
  '169.254.169.254', // the cloud metadata address, which the SSRF guard refuses
  '10.0.0.1', '192.168.1.1', '1.2.3.4', '8.8.8.8', // textbook samples
]);
const IPV6_OK = new Set(['::', '::1', '::ffff', '::ffff:0:0', '64:ff9b::', 'fc00::', 'fe80::', // loopback, range starts
  '::7f00:1', '::ffff:7f00:1', '64:ff9b::7f00:1', '::ffff:808:808', '::ffff:a9fe:a9fe', // the same few, as hex in the SSRF tests
  'fd00::1', 'fe80::1', 'ff02::1', '2606:4700::1111']);
const ipv4Ok = (ip) => IPV4_OK.has(ip) || /^(?:127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip);
function ipv6Ok(raw) {
  const ip = raw.toLowerCase();
  if (IPV6_OK.has(ip) || /^2001:0?db8:/.test(ip)) return true;
  const dotted = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  return !!dotted && ipv4Ok(dotted[1]);
}

const SHAPES = [
  ['api-key', /(?<![\w-])(?:sk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{30,})/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['password-hash', /\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/g],
  ['r2-account', /[0-9a-f]{32}\.r2\.cloudflarestorage\.com/g],
  ['tailnet-host', /[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/gi],
  ['ip-address', /(?<![\d.\w])\d{1,3}(?:\.\d{1,3}){3}(?![\d\w]|\.\d)/g, (m) => net.isIPv4(m) && !ipv4Ok(m)],
  ['ip-address', /(?<![\w:.])[0-9a-fA-F:.]*:[0-9a-fA-F:.]*:[0-9a-fA-F:.]*(?![\w:])/g, (m) => {
    const c = m.endsWith('::') ? m : m.replace(/[.:]+$/, '');
    return net.isIPv6(c) && !ipv6Ok(c);
  }],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => !EMAIL_DOMAIN_OK.test(m.slice(m.indexOf('@') + 1))],
  ['home-path', /(?<![\w/])(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+|-home-[a-z][a-z0-9_]+-/g, (m) => !/^(?:\/home\/|\/Users\/)(?:i(?:\.\w+)*|user|you|me|ubuntu|node|runner|example)$/.test(m)],
  ['phone', /(?<![\w.$#/-])\d{10,20}(?![\w])/g, (m) => !looksFake(m)],
  ['phone', /(?<![\w+])\+\d{1,3}[ -]?\d(?:[ -]?\d){7,13}(?![\w])/g, (m) => !looksFake(m.replace(/\D/g, ''))],
];

// A number as a person might write it, to compare with a contact's digits.
const DIGITS = /(?<![\w.])\+?\d(?:[ -]?\d){6,18}(?![\w])/g;

// The lockfile and vendored code are other people's names and hashes.
const SKIP_PATH = /(?:^|\/)package-lock\.json$|(?:^|\/)vendor\//;

/** Label → { n, refs } for one text. Nothing that matched leaves this function. */
export function scanText(rawText, { lex, lines = null }) {
  const counts = new Map();
  const found = (label, ref = null) => {
    const row = counts.get(label) ?? { n: 0, refs: new Set() };
    row.n += 1;
    if (ref) row.refs.add(ref);
    counts.set(label, row);
  };
  const text = nfkc(rawText);

  const tokens = text.toLowerCase().match(TOKEN) || [];
  for (let i = 0; i < tokens.length; i += 1) {
    const word = lex.words.get(tokens[i]);
    if (word) found(word.label, word.ref);
    for (const ph of lex.phrases.get(tokens[i]) ?? []) {
      if (ph.rest.every((t, k) => tokens[i + 1 + k] === t)) found(ph.label, ph.ref);
    }
  }
  if (lex.coordRe) {
    for (const m of text.matchAll(lex.coordRe)) found('coordinate', lex.coords.get(m[0].replace('-', '').slice(0, m[0].indexOf('.') + (m[0].startsWith('-') ? 2 : 3))));
  }
  if (lex.ids.size) {
    for (const m of text.matchAll(DIGITS)) {
      const d = m[0].replace(/\D/g, '');
      const hit = lex.ids.get(d) ?? (d.length >= 10 ? lex.last10.get(d.slice(-10)) : null);
      if (hit) found(hit.label, hit.ref);
    }
  }
  if (lines) lines.scan(text, found);
  for (const [label, re, keep] of SHAPES) {
    for (const m of text.matchAll(re)) if (!keep || keep(m[0])) found(label);
  }
  return counts;
}

// ── Git ──────────────────────────────────────────────────────────────────────

function git(repo, args, opts = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: opts.encoding ?? 'utf-8', maxBuffer: 1 << 30, input: opts.input });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

const ZERO = /^0+$/;

/** { oid → Set(paths) } for a tree. */
function blobsOfTree(repo, ref) {
  const blobs = new Map();
  for (const line of git(repo, ['ls-tree', '-r', '-z', '--full-tree', ref]).split('\0')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/s);
    if (m) add(blobs, m[1], m[2]);
  }
  return blobs;
}

function add(blobs, oid, p) {
  if (!blobs.has(oid)) blobs.set(oid, new Set());
  blobs.get(oid).add(p);
}

/** Every blob that commits in the rev-list args add, and their messages. */
function blobsOfRange(repo, revs) {
  const blobs = new Map();
  const raw = git(repo, ['-c', 'log.showRoot=true', 'log', '--format=', '--raw', '-z', '--no-abbrev', '--no-renames', '-m', ...revs, '--']);
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const m = parts[i].match(/^\s*:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/);
    if (m && parts[i + 1] !== undefined) {
      if (!ZERO.test(m[1])) add(blobs, m[1], parts[i + 1]);
      i += 1;
    }
  }
  const messages = [];
  const authors = new Set();
  const log = git(repo, ['log', '--format=%H%x00%ae%x00%ce%x00%B%x00%x01', ...revs, '--']);
  for (const rec of log.split('\x01')) {
    const [hash, ae, ce, body] = rec.replace(/^\s+/, '').split('\0');
    if (!hash) continue;
    messages.push({ hash, body: body ?? '' });
    if (ae) authors.add(ae);
    if (ce) authors.add(ce);
  }
  return { blobs, messages, authors };
}

/** Yields [oid, Buffer] for the blobs, a batch at a time. */
function* readBlobs(repo, oids) {
  for (let i = 0; i < oids.length; i += 200) {
    const chunk = oids.slice(i, i + 200);
    const out = git(repo, ['cat-file', '--batch'], { encoding: 'buffer', input: Buffer.from(`${chunk.join('\n')}\n`) });
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(0x0a, at);
      if (nl < 0) break;
      const [oid, kind, size] = out.toString('utf-8', at, nl).split(' ');
      if (kind !== 'blob') throw new Error('unexpected object');
      const start = nl + 1;
      yield [oid, out.subarray(start, start + Number(size))];
      at = start + Number(size) + 1;
    }
  }
}

/** git's pre-push stdin → one rev-list per ref it pushes. A delete adds nothing. */
function prePushRevs(stdin) {
  const out = [];
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue;
    out.push(remoteSha && !ZERO.test(remoteSha) ? [`${remoteSha}..${localSha}`] : [localSha, '--not', '--remotes']);
  }
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { target: null, repo: process.cwd(), sources: null, words: null, db: null, strict: false, prePush: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--repo') a.repo = argv[++i];
    else if (v === '--sources') a.sources = argv[++i];
    else if (v === '--words') a.words = argv[++i];
    else if (v === '--db') a.db = argv[++i];
    else if (v === '--strict') a.strict = true;
    else if (v === '--pre-push') a.prePush = true;
    else if (v === '--all') a.all = true;
    else if (v.startsWith('-') || a.target) throw new Error(`unknown argument: ${v.startsWith('-') ? v : '(second target)'}`);
    else a.target = v;
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const repo = git(a.repo, ['rev-parse', '--show-toplevel']).trim();
  const sourcesDir = path.resolve(a.sources ?? path.join(repo, 'src/personality'));
  const wordsFile = path.resolve(a.words ?? path.join(repo, 'data/private-words.txt'));
  const words = loadWords({ repo, sourcesDir, wordsFile });
  if (a.strict && words.missing.length) throw new Error(`no ${words.missing.join(', ')} in the sources`);
  if (words.missing.length) console.log(`note: no ${words.missing.join(', ')}.json in the sources: those words aren't checked`);
  const { lex } = words;
  let lines = null;
  let dbCounts = null;
  if (a.db) {
    const loaded = await loadDb(path.resolve(a.db), lex);
    lines = loaded.lines;
    dbCounts = loaded.counts;
    if (a.strict && (!dbCounts.contacts || !dbCounts.messageLines)) throw new Error('the database has no contacts or no message lines');
  }
  lex.finish();
  const ctx = { lex, lines };

  const blobs = new Map();
  const messages = [];
  const authors = new Set();
  const addRange = (revs) => {
    const r = blobsOfRange(repo, revs);
    for (const [oid, ps] of r.blobs) for (const p of ps) add(blobs, oid, p);
    messages.push(...r.messages);
    for (const e of r.authors) authors.add(e);
  };
  if (a.prePush) prePushRevs(fs.readFileSync(0, 'utf-8')).forEach(addRange);
  else if (a.all) addRange(['--all']);
  else if (a.target?.includes('..')) addRange([a.target]);
  else for (const [oid, ps] of blobsOfTree(repo, a.target ?? 'HEAD')) for (const p of ps) add(blobs, oid, p);

  // One row per label and path; a path naming something private isn't printed either.
  const rows = new Map();
  const hit = (label, where, { n, refs }) => {
    const k = `${label}\0${where}`;
    const row = rows.get(k) ?? { n: 0, refs: new Set() };
    row.n += n;
    for (const r of refs) row.refs.add(r);
    rows.set(k, row);
  };
  const safeWhere = (p, oid) => {
    const counts = scanText(p, { lex });
    if (!counts.size) return p;
    for (const [label, row] of counts) hit(`${label} (in a path)`, `blob ${oid.slice(0, 12)}`, row);
    return `(a path, blob ${oid.slice(0, 12)})`;
  };

  let binary = 0;
  let scanned = 0;
  const textOids = [...blobs.entries()].filter(([, ps]) => [...ps].some(p => !SKIP_PATH.test(p))).map(([oid]) => oid);
  for (const [oid, buf] of readBlobs(repo, textOids)) {
    if (buf.subarray(0, 8000).includes(0)) { binary += 1; continue; }
    scanned += 1;
    const counts = scanText(buf.toString('utf-8'), ctx);
    for (const p of blobs.get(oid)) {
      if (SKIP_PATH.test(p)) continue;
      const where = safeWhere(p, oid);
      for (const [label, row] of counts) hit(label, where, row);
    }
  }
  for (const { hash, body } of messages) {
    for (const [label, row] of scanText(body, ctx)) hit(label, `commit message ${hash.slice(0, 12)}`, row);
  }

  const sorted = [...rows.entries()].map(([k, row]) => [...k.split('\0'), row]).sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  for (const [label, where, { n, refs }] of sorted) {
    const from = [...refs].slice(0, 4).join(', ');
    console.log(`${label.padEnd(14)} ${where}  ${n}${from ? `  from ${from}${refs.size > 4 ? `, +${refs.size - 4}` : ''}` : ''}`);
  }
  if (dbCounts) {
    console.log(`db: ${dbCounts.contacts} contacts, ${dbCounts.groups} groups, ${dbCounts.ids} ids, ${dbCounts.messageLines} message lines, ${dbCounts.otherLines} memory and story lines, ${dbCounts.castNames} cast and places; ${dbCounts.selfLinesSkipped === null ? 'no is_from_self column: the bot\'s own lines count too' : `${dbCounts.selfLinesSkipped} of the bot's own messages not read`}${dbCounts.rowsOptedOut ? `; ${dbCounts.rowsOptedOut} row(s) opted out` : ''}`);
  }
  const lookUp = [...new Set(sorted.flatMap(([, , { refs }]) => [...refs]))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (lookUp.length) console.log(`rows to look up: ${lookUp.join(', ')}`);
  const summary = `${scanned} text blob(s), ${binary} binary skipped, ${messages.length} commit message(s); words from: ${[...words.found, ...(lex.counts.privateWords ? ['private words'] : []), ...(dbCounts ? ['db'] : [])].join(', ') || 'none'}`;
  if (authors.size) console.log(`note: ${authors.size} distinct author/committer email(s) in the range: not checked here, they are the git identity`);
  if (sorted.length) { console.log(`✗ ${sorted.length} hit(s) in ${summary}`); return 1; }
  console.log(`✓ clean: ${summary}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    // Fail closed, and a git or parse error is ours to word: it could quote a line.
    console.error(`public-scan: couldn't check: ${String(err?.message ?? err).split('\n')[0].slice(0, 120)}`);
    process.exitCode = 2;
  });
}
