// Phrase banks (plan 020 H2), the checks: which English lines have a slot, and whether a line written
// for one may be used. Pure: no file, no DB, no model. Shared by the boot loader and the generator.
//
// A slot is one English line of one bank. The English stays the meaning and the repeat-memory key; the bank
// only says how he'd say it. Variants may carry state tags, so the rest of family × activity × mood ×
// time of day is written only where it means something: {t, mood?, time?, activity?}.
//
// Not banked, on purpose: a private session's words and a heavy stretch's (they stay neutral and invent
// nothing), the "plans with a friend" stand-in, and the topic words (the scene writer's fact sheet reads them).
import { createHash } from 'crypto';
import { REACTIONS, WANT_SHOULD, PUTTING_OFF, BODY, PEOPLE, WORDLESS, EXCUSES } from './thoughtPhrases.js';
import { PLACES, GENERAL, SITTING, KNOWN, EMPLOYED, EVENING, DETAILS, PHONE, TOPIC_WORDS, TOPIC_NEW, TOPIC_NEW_HERS, TOPIC_STILL, TOPIC_BACK } from './livePhrases.js';
import { FRAGMENTS, GRAPHIC_RE, HARM_RE, SEXUAL_RE } from './dreamPhrases.js';
import { makeScrubber, normalizeName, TOKEN_REASON } from '../public/scrub.js';
import { nameTokens } from '../memory/mindReads.js';

export const BANKS = Object.freeze(['thought', 'live', 'dream']);
export const BANK_VERSION = 1;
export const MOODS = Object.freeze(['low', 'ok', 'high']);
export const TIMES = Object.freeze(['morning', 'day', 'evening', 'night']);
export const ACTIVITIES = Object.freeze({
  thought: Object.freeze(['work', 'meeting', 'commute', 'meal', 'gym', 'tv', 'home', 'outside', 'errand', 'outing', 'sick', 'other']),
  live: Object.freeze(['cafe', 'food', 'bar', 'watch', 'outdoor', 'home', 'shop', 'event', 'active']),
  dream: Object.freeze([]),
});
export const MAX_VARIANTS = 6;
export const MAX_FILE_BYTES = 2_000_000;
const MAX_WORD = 24;            // one unbreakable run: the site's narrowest column is about 288 px
const LINE_DUP_MAX = 3;         // the same words standing in for this many different lines, no more

// What the longest fill can add. The site refuses a string over its cap rather than cutting it, so a line is
// measured at its worst. A line is allowed its cap, or what today's English needs if that is longer: never worse than now.
const longestTopic = Math.max(...Object.values(TOPIC_WORDS).flat().map(x => x.replaceAll('{her}', 'their').replaceAll('{she}', 'they').length));
export const WIDTHS = Object.freeze({
  thought: Object.freeze({ name: 16, plan: 32, "she's": 7, she: 4, her: 5, them: 4 }),
  live: Object.freeze({ name: 16, who: 16, t: longestTopic, "she's": 7, she: 4, her: 5, them: 4 }),
  dream: Object.freeze({ place: 20, person: 16, task: 64, twist: 64, twistCap: 64 }),
});
export const SURFACE_CAP = Object.freeze({ thought: 80, live: 62, dream: 160 });

const PLACEHOLDER_RE = /\{[^{}]*\}/g;
const placeholdersOf = (t) => [...new Set([...String(t).matchAll(PLACEHOLDER_RE)].map(m => m[0].slice(1, -1)))].sort();
const withoutPlaceholders = (t) => String(t).replace(PLACEHOLDER_RE, ' ');
const expandedLength = (t, widths) => [...String(t).matchAll(PLACEHOLDER_RE)]
  .reduce((n, m) => n - m[0].length + (widths[m[0].slice(1, -1)] ?? 0), String(t).length);
const wordsOf = (t) => normalizeName(withoutPlaceholders(t)).split(' ').filter(Boolean);
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// ── the slots ───────────────────────────────────────────────────────────────

function walk(node, path, visit) {
  if (typeof node === 'string') visit(node, path);
  else if (Array.isArray(node)) node.forEach(x => walk(x, path, visit));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, visit);
}

let slotsMemo = null;
/** bank → Map(English line → { source, family, pools[], placeholders[] }). */
export function slotCatalogue() {
  if (slotsMemo) return slotsMemo;
  const out = { thought: new Map(), live: new Map(), dream: new Map() };
  const add = (bank, family, tree) => walk(tree, '', (source, path) => {
    const pool = `${family}/${path}`;
    const known = out[bank].get(source);
    if (known) { if (!known.pools.includes(pool)) known.pools.push(pool); return; }
    out[bank].set(source, { source, family, pools: [pool], placeholders: placeholdersOf(source) });
  });
  const { heavy: _heavy, private: _private, ...wordless } = WORDLESS;
  add('thought', 'reaction', REACTIONS);
  add('thought', 'want_should', WANT_SHOULD);
  add('thought', 'putting_off', PUTTING_OFF);
  add('thought', 'body', BODY);
  add('thought', 'people', PEOPLE);
  add('thought', 'wordless', wordless);
  add('thought', 'excuse', EXCUSES);
  for (const [family, tree] of Object.entries({ general: GENERAL, sitting: SITTING, known: KNOWN, employed: EMPLOYED, evening: EVENING, place: PLACES, detail: DETAILS, phone: PHONE,
    topic_new: TOPIC_NEW, topic_new_hers: TOPIC_NEW_HERS, topic_still: TOPIC_STILL, topic_back: TOPIC_BACK })) add('live', family, tree);
  add('dream', 'fragment', FRAGMENTS);
  slotsMemo = out;
  return out;
}

/** A fingerprint of the English lines, to tell a bank written from older ones. */
export function catalogueHash() {
  const c = slotCatalogue();
  const h = createHash('sha256');
  for (const b of BANKS) for (const s of [...c[b].keys()].sort()) h.update(`${b}\0${s}\0`);
  return h.digest('hex').slice(0, 16);
}

/** Today's English as a bank: the committed example, and what a test pins it against. */
export function englishBank() {
  const c = slotCatalogue();
  const banks = {};
  for (const b of BANKS) banks[b] = Object.fromEntries([...c[b].keys()].map(s => [s, [{ t: s }]]));
  return { v: BANK_VERSION, version: 'example', generatedAt: null, model: null, catalogue: catalogueHash(), banks };
}

// ── what a line may not hold ────────────────────────────────────────────────

const properNounsOf = (text) => {
  const out = new Set();
  // A capitalized word inside a sentence: a person, a place or a brand he was described with.
  for (const m of String(text ?? '').matchAll(/(?<=[\p{Ll},;:] )(\p{Lu}\p{L}{2,})/gu)) out.add(m[1]);
  return [...out];
};

/** The names and words for makeChecker, from what the install knows. identity: only the generator passes it. */
export function bankContext({ persona = null, world = null, realNames = [], venueNames = [], identity = null, banned = [], contentProblem = null } = {}) {
  const parts = (v) => (typeof v === 'string' ? v.split(/[,/;|()+&]+/).map(x => x.trim()).filter(Boolean) : []);
  return {
    realNames,
    venueNames: [...venueNames, ...(world?.places ?? []).filter(p => p?.venue || p?.ownerNamed).map(p => p.name)],
    castNames: (world?.cast ?? []).map(c => c?.name).filter(Boolean),
    personaNames: [persona?.name, persona?.displayName, ...(persona?.aliases ?? [])].filter(x => typeof x === 'string'),
    personaWords: [...parts(persona?.region), ...parts(persona?.city), ...parts(persona?.language)],
    properNouns: properNounsOf(identity),
    banned,
    contentProblem,
  };
}

// ── one line ────────────────────────────────────────────────────────────────

/**
 * ctx: { realNames, castNames, personaNames, personaWords, venueNames, properNouns, banned } — string lists, all optional —
 * and contentProblem (the desire module's word check: story code, so the caller hands it in).
 * Names are matched whole and in any case, since these lines are lower case; a word the English line itself has is never a problem.
 */
export function makeChecker(ctx = {}) {
  const single = new Map();
  const phrases = new Map();
  const deny = (list, code, { firstToo = false } = {}) => {
    for (const raw of list ?? []) {
      const n = normalizeName(raw);
      if (n.length < 3) continue;
      if (n.includes(' ')) { if (!phrases.has(n)) phrases.set(n, code); } else if (!single.has(n)) single.set(n, code);
      const first = n.split(' ')[0];
      if (firstToo && first.length >= 3 && !single.has(first)) single.set(first, code);
    }
  };
  deny(ctx.realNames, 'real_name', { firstToo: true });
  // Every word of a real name, not just the first: "K Ann", "Dr. Maris" and a surname hold the name people actually use. A false hit only drops a line.
  // Compared the way a line's words are, so a name in a script with vowel marks still meets itself.
  for (const raw of ctx.realNames ?? []) {
    for (const token of nameTokens(raw)) {
      const n = normalizeName(token);
      if (n.length >= 3 && !n.includes(' ') && !single.has(n)) single.set(n, 'real_name');
    }
  }
  deny(ctx.castNames, 'name', { firstToo: true });
  deny(ctx.personaNames, 'name', { firstToo: true });
  deny(ctx.venueNames, 'venue');
  deny(ctx.personaWords, 'persona_word');
  deny(ctx.properNouns, 'name');
  deny(ctx.banned, 'fixated');
  const scrubber = makeScrubber({ knownNames: ctx.realNames ?? [] });
  return { single, phrases, scrubber, explicit: typeof ctx.contentProblem === 'function' ? ctx.contentProblem : () => null };
}

const CONTROL_RE = /[\u0000-\u001f\u007f\u200b\u2028-\u202e\u2066-\u2069\ufeff]/;
const MARKUP_RE = /[[\]<>`*#_\\|]/;
const DIGITS_RE = /\p{Nd}{3,}/u;

/** Does the list match in a line, once the words it matches in the English line are taken out? */
function beyondSource(re, text, source) {
  const every = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const inSource = new Set([...String(source).matchAll(every)].map(m => m[0].toLowerCase()));
  return re.test(text.replace(every, m => (inSource.has(m.toLowerCase()) ? ' ' : m)));
}

/** A code when a line won't do, null when it will. The English line itself is always fine. */
export function lineProblem(text, bank, source, checker) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  if (text === source) return null;
  if (text !== text.trim()) return 'whitespace';
  if (CONTROL_RE.test(text)) return 'control';
  const given = placeholdersOf(text);
  const allowed = WIDTHS[bank];
  if (given.some(p => !(p in allowed))) return 'unknown_placeholder';
  const bare = withoutPlaceholders(text);
  if (/[{}]/.test(bare)) return 'bad_brace';
  if (given.join() !== placeholdersOf(source).join()) return 'placeholder_mismatch';
  if (MARKUP_RE.test(bare)) return 'markup';
  if (bare.includes('@') || DIGITS_RE.test(bare)) return 'identifier';
  const cap = Math.max(SURFACE_CAP[bank], expandedLength(source, allowed));
  if (expandedLength(text, allowed) > cap) return 'too_long';
  // Inner speech stays clipped: a short line doesn't become a sentence.
  if (text.length > Math.max(source.length * 2 + 12, 28)) return 'too_long';
  if (bare.split(/\s+/).some(w => [...w].length > MAX_WORD)) return 'long_word';
  const scrub = checker.scrubber.check(bare);
  if (scrub) return scrub === 'real_name' || scrub === TOKEN_REASON ? 'real_name' : 'identifier';
  // A word today's English line uses in its own plain sense ("throat") is no new risk; only that word, not the whole list it's on.
  if (checker.explicit(bare) || beyondSource(SEXUAL_RE, bare, source)) return 'sexual';
  if (beyondSource(GRAPHIC_RE, bare, source) || beyondSource(HARM_RE, bare, source)) return 'graphic';
  const inSource = new Set(wordsOf(source));
  const words = wordsOf(text);
  for (const w of words) {
    if (inSource.has(w)) continue;
    const hit = checker.single.get(w);
    if (hit) return hit;
  }
  if (checker.phrases.size) {
    const norm = ` ${words.join(' ')} `;
    const srcNorm = ` ${[...inSource].join(' ')} `;
    for (const [p, code] of checker.phrases) if (norm.includes(` ${p} `) && !srcNorm.includes(` ${p} `)) return code;
  }
  // A capitalized word the English doesn't have is somebody's name, or some place's. A dream's sentences may start with one.
  const srcWords = new Set(String(source).split(/[^\p{L}\p{M}']+/u).map(w => w.toLowerCase()));
  for (const m of bare.matchAll(/(?<![\p{L}\p{M}'])(\p{Lu}\p{Ll}{2,})/gu)) {
    if (srcWords.has(m[1].toLowerCase())) continue;
    const before = bare.slice(0, m.index).trimEnd();
    if (bank === 'dream' && (before === '' || /[.!?;:]$/.test(before))) continue;
    return 'invented_name';
  }
  return null;
}

function entryOf(raw, bank) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'bad_entry' };
  for (const k of Object.keys(raw)) if (!['t', 'mood', 'time', 'activity'].includes(k)) return { problem: 'bad_entry' };
  if ('mood' in raw && (bank === 'dream' || !MOODS.includes(raw.mood))) return { problem: 'bad_tag' };
  if ('time' in raw && (bank === 'dream' || !TIMES.includes(raw.time))) return { problem: 'bad_tag' };
  if ('activity' in raw && !ACTIVITIES[bank].includes(raw.activity)) return { problem: 'bad_tag' };
  return { entry: raw };
}

// ── the whole bank ──────────────────────────────────────────────────────────

// Per bank, as a share of its entries: short words are grammar in any language, long ones are what he goes on about.
const shareFor = (len) => (len <= 2 ? 0.08 : len <= 4 ? 0.06 : len === 5 ? 0.03 : 0.015);
const capFor = (word, n) => Math.max(word.length <= 2 ? 8 : word.length <= 4 ? 6 : 5, Math.ceil(n * shareFor([...word].length)));
const STRICT_SHARE = 0.005;
const EMOJI_ONE_CAP = 3;
const EMOJI_SHARE = 0.01;

/**
 * The fixation guard: no word or emoji over its cap across a bank, whatever the slots. An over-used word loses
 * its entries from the fullest slots first, so a slot is emptied last. strict: words he overuses in real life get a much lower cap.
 */
export function capFixation(lines, sources, { strict = [] } = {}) {
  const removed = { word_cap: 0, emoji_cap: 0, dup_line: 0 };
  const entries = () => [...lines].flatMap(([source, list]) => list.filter(e => e.t !== source).map(e => ({ source, e })));
  const sourceShare = new Map();
  for (const s of sources) for (const w of new Set(wordsOf(s))) sourceShare.set(w, (sourceShare.get(w) ?? 0) + 1);
  const drop = ({ source, e }) => {
    const list = lines.get(source);
    list.splice(list.indexOf(e), 1);
    if (!list.length) lines.delete(source);
  };
  const shrink = (matches, cap, code) => {
    const rest = [...matches];
    while (rest.length > cap) {
      rest.sort((a, b) => (lines.get(b.source)?.length ?? 0) - (lines.get(a.source)?.length ?? 0) || a.source.localeCompare(b.source));
      drop(rest.shift());
      removed[code] += 1;
    }
  };
  const strictSet = new Set(strict.map(normalizeName).filter(Boolean));
  let all = entries();
  const n = all.length;
  const sourcesN = Math.max(1, sources.length);
  const byWord = new Map();
  for (const x of all) for (const w of new Set(wordsOf(x.e.t))) { if (!byWord.has(w)) byWord.set(w, []); byWord.get(w).push(x); }
  const over = [...byWord].map(([w, matches]) => {
    // A word the English lines themselves lean on ("he") keeps its share.
    const fromSource = Math.ceil(1.25 * ((sourceShare.get(w) ?? 0) / sourcesN) * n);
    const cap = strictSet.has(w) && !sourceShare.has(w) ? Math.max(2, Math.ceil(n * STRICT_SHARE)) : Math.max(capFor(w, n), fromSource);
    return { w, matches, cap, excess: matches.length - cap };
  }).filter(x => x.excess > 0).sort((a, b) => b.excess - a.excess || a.w.localeCompare(b.w));
  for (const { w, cap } of over) {
    all = entries();
    shrink(all.filter(x => wordsOf(x.e.t).includes(w)), cap, 'word_cap');
  }
  // Emoji, one by one and all together.
  all = entries();
  const emojiOf = (x) => x.e.t.match(EMOJI_RE) ?? [];
  const seen = new Set(all.flatMap(emojiOf));
  for (const em of [...seen].sort()) shrink(entries().filter(x => emojiOf(x).includes(em)), EMOJI_ONE_CAP, 'emoji_cap');
  shrink(entries().filter(x => emojiOf(x).length), Math.max(EMOJI_ONE_CAP, Math.ceil(n * EMOJI_SHARE)), 'emoji_cap');
  // The same words standing in for many different lines.
  const byText = new Map();
  for (const x of entries()) { const k = x.e.t; if (!byText.has(k)) byText.set(k, []); byText.get(k).push(x); }
  for (const matches of byText.values()) shrink(matches, LINE_DUP_MAX, 'dup_line');
  return removed;
}

const ENGLISH_ONLY = 0.92;
const OTHER_ONLY = 0.08;

/** How a bank reads, for the owner: never a reason to refuse it. */
export function healthOf(bank, lines) {
  const vocab = new Set([...slotCatalogue()[bank].keys()].flatMap(wordsOf));
  for (const b of BANKS) for (const s of slotCatalogue()[b].keys()) for (const w of wordsOf(s)) vocab.add(w);
  let entries = 0; let changed = 0; let lenRatio = 0; let known = 0; let words = 0; let latin = 0; let other = 0;
  const top = new Map();
  for (const [source, list] of lines) {
    for (const e of list) {
      entries += 1;
      if (e.t !== source) changed += 1;
      lenRatio += e.t.length / Math.max(1, source.length);
      for (const w of wordsOf(e.t)) { words += 1; if (vocab.has(w)) known += 1; top.set(w, (top.get(w) ?? 0) + 1); }
      for (const ch of withoutPlaceholders(e.t)) { if (/\p{Script=Latin}/u.test(ch)) latin += 1; else if (/\p{L}/u.test(ch)) other += 1; }
    }
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return {
    entries, changedPct: pct(changed, entries), englishWordPct: pct(known, words), nonLatinPct: pct(other, latin + other),
    lengthRatio: entries ? Math.round((lenRatio / entries) * 100) / 100 : 0,
    topWords: [...top].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([word, count]) => ({ word, count })),
    language: !entries || !changed ? 'english' : words && known / words >= ENGLISH_ONLY ? 'english' : words && known / words <= OTHER_ONLY ? 'other' : 'mixed',
  };
}

/**
 * The file as read. A wrong shape refuses the file; a bad line loses only that line, and a slot left with
 * nothing is English. → { ok: false, code } | { ok: true, lines: { bank: Map }, meta, coverage, rejected, stale, health, warnings }.
 */
export function validateBank(raw, ctx = {}, { strict = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'bad_shape' };
  for (const k of Object.keys(raw)) if (!['v', 'version', 'generatedAt', 'model', 'catalogue', 'partial', 'banks'].includes(k)) return { ok: false, code: 'bad_shape' };
  if (raw.v !== BANK_VERSION) return { ok: false, code: 'bad_version' };
  if (typeof raw.version !== 'string' || !raw.version.trim() || raw.version.length > 60) return { ok: false, code: 'bad_shape' };
  if (!raw.banks || typeof raw.banks !== 'object' || Array.isArray(raw.banks)) return { ok: false, code: 'bad_shape' };
  for (const b of Object.keys(raw.banks)) if (!BANKS.includes(b)) return { ok: false, code: 'bad_shape' };
  for (const b of BANKS) {
    const v = raw.banks[b];
    if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) return { ok: false, code: 'bad_shape' };
  }
  const catalogue = slotCatalogue();
  const checker = makeChecker(ctx);
  const rejected = {};
  const hit = (code, n = 1) => { rejected[code] = (rejected[code] ?? 0) + n; };
  let stale = 0;
  const lines = {};
  const coverage = {};
  const health = {};
  const warnings = [];
  for (const b of BANKS) {
    const map = new Map();
    const slots = catalogue[b];
    for (const [source, list] of Object.entries(raw.banks[b] ?? {})) {
      if (!slots.has(source)) { stale += 1; continue; }
      if (!Array.isArray(list)) { hit('bad_entry'); continue; }
      const seen = new Set();
      const kept = [];
      for (const item of list) {
        const { entry, problem } = entryOf(item, b);
        const code = problem ?? lineProblem(entry.t, b, source, checker);
        if (code) { hit(code); continue; }
        if (seen.has(entry.t)) { hit('duplicate'); continue; }
        if (kept.length >= MAX_VARIANTS) { hit('too_many'); continue; }
        seen.add(entry.t);
        kept.push({ t: entry.t, ...(entry.mood ? { mood: entry.mood } : {}), ...(entry.time ? { time: entry.time } : {}), ...(entry.activity ? { activity: entry.activity } : {}) });
      }
      if (kept.length) map.set(source, kept);
    }
    for (const [code, n] of Object.entries(capFixation(map, [...slots.keys()], { strict }))) if (n) hit(code, n);
    lines[b] = map;
    coverage[b] = { slots: slots.size, voiced: [...map].filter(([s, l]) => l.some(e => e.t !== s)).length, entries: [...map.values()].reduce((a, l) => a + l.length, 0) };
    health[b] = healthOf(b, map);
    if (raw.version !== 'example' && map.size && health[b].language !== 'mixed') warnings.push(`one_language_${health[b].language}:${b}`);
  }
  const covered = BANKS.reduce((a, b) => a + coverage[b].voiced, 0);
  if (raw.version !== 'example' && !covered) warnings.push('nothing_voiced');
  if (typeof raw.catalogue === 'string' && raw.catalogue !== catalogueHash()) warnings.push('english_changed_since');
  if (raw.partial === true) warnings.push('partial');
  return {
    ok: true, lines, coverage, rejected, stale, health, warnings,
    meta: { version: raw.version, generatedAt: Number.isFinite(raw.generatedAt) ? raw.generatedAt : null, model: typeof raw.model === 'string' ? raw.model : null, catalogue: typeof raw.catalogue === 'string' ? raw.catalogue : null },
  };
}

/** A validated bank's lines back in the file's shape. */
export function bankToJson(lines) {
  return Object.fromEntries(BANKS.map(b => [b, Object.fromEntries(lines[b])]));
}

// ── choosing ────────────────────────────────────────────────────────────────

/** What part of the day it is, for a bank's tags. */
export function timeOfDay(hour) {
  return hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 17 ? 'day' : hour >= 17 && hour < 22 ? 'evening' : 'night';
}

const hash01 = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  // Mix the high bits: on short, similar seeds they hardly move, and one variant would never come up.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
};

/**
 * One line of a slot's list for this state. Its own hash, never the caller's random stream, so what he thinks and
 * when is the same with a bank as without one. A tag that doesn't fit rules a line out; one that fits counts for it.
 */
export function chooseVariant(list, state = {}, seed = '') {
  const fits = list.filter(e => ['mood', 'time', 'activity'].every(k => !e[k] || e[k] === state[k]));
  if (!fits.length) return null;
  const weight = (e) => 1 + (e.mood ? 1 : 0) + (e.time ? 1 : 0) + (e.activity ? 1 : 0);
  let r = hash01(seed) * fits.reduce((a, e) => a + weight(e), 0);
  for (const e of fits) { r -= weight(e); if (r < 0) return e.t; }
  return fits[fits.length - 1].t;
}
