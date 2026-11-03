// Public site (spec 013): the per-string scrubber. Every string in public.json
// passes check() — the exporter drops an optional string that fails, and drops
// the row (or fails the export) for a required one. Pure.
//
// Refused: JIDs and @mentions, phone-like digit runs (dates and clock times are
// masked first), URLs and emails, a real person's full name anywhere, a real
// person's first name (≥ 3 letters) written as a proper noun (a capitalized
// word), and a group's subject as a phrase. Allowed through the name rules: the
// persona's own names, his cast's names (a cast member's first name only as
// itself — a real full name that shares it is still refused) and opted-in
// display names. Names are compared after dropping format characters and
// accents (the Director wish rule, world.js normalizeName).

import { createHash } from 'crypto';
import { nameTokens } from '../utils/nameTokens.js';

const JID_RE = /[0-9A-Za-z._:+-]{2,}@(?:s\.whatsapp\.net|g\.us|lid|c\.us|broadcast|newsletter)|@\s?\d{3,}/i;
const PHONE_RE = /\+?\p{Nd}[\p{Nd}\s().-]{7,}\p{Nd}/u;   // any script's digits
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|in|io|me|app|dev|co|ai|ly|gg|xyz)\b(?:\/\S*)?/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const DATE_MASKS = [/(?<!\p{Nd})\p{Nd}{4}([-/.])\p{Nd}{1,2}\1\p{Nd}{1,2}(?!\p{Nd})/gu, /(?<!\p{Nd})\p{Nd}{1,2}([-/.])\p{Nd}{1,2}\1\p{Nd}{2,4}(?!\p{Nd})/gu,
  /(?<!\p{Nd})\p{Nd}{1,2}:\p{Nd}{2}(?:\s*[-–]\s*\p{Nd}{1,2}:\p{Nd}{2})?(?!\p{Nd})/gu];
const PREFIX_MIN = 4;   // a known first name glued to a suffix ("Sanjunte", "Rahulinte") counts from 4 letters
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const GROUP_PHRASE_MIN = 8;

/** Lowercase, accents folded, format characters dropped, letters/digits only, single-spaced. */
export function normalizeName(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Salted one-way key of a normalized name (the purged-name guard stores only these). */
export function nameKey(salt, norm) {
  return createHash('sha256').update(`${salt}|name|${norm}`).digest('hex').slice(0, 24);
}

/**
 * The guard's keys for a list of names: { full: [...], first: [...] } (full = multi-word
 * names, first = first words of ≥ 3 letters).
 */
export function guardKeys(salt, names) {
  const full = new Set();
  const first = new Set();
  for (const n of names || []) {
    const norm = normalizeName(n);
    if (!norm) continue;
    if (norm.includes(' ')) full.add(nameKey(salt, norm));
    const f = norm.split(' ')[0];
    if (f.length >= 3) first.add(nameKey(salt, f));
  }
  return { full: [...full], first: [...first] };
}

/**
 * makeScrubber({ knownNames, groupNames, allowNames, guard }) → { check(text) → null | reason, clean(text, max) → text | null }
 *   knownNames  real people's names (people.push_name / real_name)
 *   groupNames  group subjects
 *   allowNames  persona names + aliases, cast names, opted-in display names
 *   placeNames  this document's place names: their words never count as a real name's word
 *   guard       { salt, full: Set, first: Set } — keys of every real name the exporter has
 *               seen (a purged person's name is gone from people, never from the site's guard)
 * A real name's every word (utils/nameTokens: "K Ann" → ann, "Dr. Maris" → maris, "Rahul Varnell" → rahul,
 * varnell) is caught capitalized and whole-word, reason 'real_name_token', unless it is a word of an allowed
 * or place name (a dropped real-name word is cheap, a broken export isn't): clean() drops such a string,
 * and validate() lists it as soft — a common capitalized word ("Sunny", "Will") never fails an export.
 */
export const TOKEN_REASON = 'real_name_token';
export function makeScrubber({ knownNames = [], groupNames = [], allowNames = [], placeNames = [], guard = null } = {}) {
  const allowNorm = allowNames.map(normalizeName).filter(Boolean);
  const allowFull = new Set(allowNorm);
  const allowFirst = new Set(allowNorm.map((n) => n.split(' ')[0]));
  const full = new Set();
  const first = new Set();
  for (const n of knownNames) {
    const norm = normalizeName(n);
    if (!norm) continue;
    if (norm.includes(' ') && !allowFull.has(norm)) full.add(norm);
    const f = norm.split(' ')[0];
    if (f.length >= 3 && !allowFirst.has(f) && !allowFull.has(f)) first.add(f);
  }
  const groups = new Set(groupNames.map(normalizeName).filter((g) => g.length >= GROUP_PHRASE_MIN && !allowFull.has(g)));
  // Every word of a real name (≥ 3 characters), less the words of allowed and place names.
  const exemptTokens = new Set([...allowNames, ...placeNames].flatMap((n) => nameTokens(n)));
  const tokens = new Set(knownNames.flatMap((n) => nameTokens(n)).filter((t) => !exemptTokens.has(t)));

  const allowPrefix = [...allowFirst].filter((f) => f.length >= 3);
  const firstLong = [...first].filter((f) => f.length >= PREFIX_MIN);
  // A word that may be a name: capitalized, or in a script without case (Malayalam, Tamil, …).
  const nameLike = (w) => /^\p{Lu}/u.test(w) || /^\p{Lo}/u.test(w);

  function check(text0) {
    if (typeof text0 !== 'string') return 'not_text';
    // NFKC first: fullwidth digits/letters and compatibility forms become their plain selves.
    const text = text0.normalize('NFKC');
    if (CONTROL_RE.test(text)) return 'control_char';
    if (JID_RE.test(text)) return 'jid';
    if (EMAIL_RE.test(text)) return 'email';
    if (URL_RE.test(text)) return 'url';
    let masked = text;
    for (const re of DATE_MASKS) masked = masked.replace(re, ' ');
    if (PHONE_RE.test(masked)) return 'phone';
    const norm = ` ${normalizeName(text)} `;
    // Spaced-out letters ("R a h u l") are read as one word too.
    const despaced = ` ${norm.trim().split(' ').reduce((acc, t) => {
      if (t.length === 1 && acc.length && acc[acc.length - 1].single) { acc[acc.length - 1].w += t; return acc; }
      acc.push({ w: t, single: t.length === 1 });
      return acc;
    }, []).map((x) => x.w).join(' ')} `;
    for (const f of full) if (norm.includes(` ${f} `) || despaced.includes(` ${f} `)) return 'real_name';
    for (const tok of despaced.trim().split(' ')) if (tok.length >= 3 && norm.indexOf(` ${tok} `) === -1 && first.has(tok)) return 'real_name';
    for (const g of groups) if (norm.includes(` ${g} `)) return 'group_name';
    if (guard) {
      const toks = norm.trim().split(' ').filter(Boolean);
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= toks.length; i++) {
          const gram = toks.slice(i, i + n).join(' ');
          if (!allowFull.has(gram) && guard.full.has(nameKey(guard.salt, gram))) return 'real_name';
        }
      }
    }
    for (const m of text.replace(/\p{Cf}/gu, '').matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
      const w = m[0];
      if (!nameLike(w)) continue;
      const nw = normalizeName(w);
      if (first.has(nw)) return 'real_name';
      if (nw.length > PREFIX_MIN && !allowPrefix.some((a) => nw.startsWith(a))
          && firstLong.some((f) => nw.length > f.length && nw.startsWith(f))) return 'real_name';
      if (guard && nw.length >= 3 && !allowFirst.has(nw) && !allowFull.has(nw) && guard.first.has(nameKey(guard.salt, nw))) return 'real_name';
    }
    // Last: a real name's other words, capitalized (or a caseless script's) and whole.
    if (tokens.size) {
      for (const m of text.replace(/\p{Cf}/gu, '').matchAll(/[\p{L}\p{M}]+/gu)) {
        if (!nameLike(m[0])) continue;
        const tok = nameTokens(m[0])[0];
        if (tok && tokens.has(tok)) return TOKEN_REASON;
      }
    }
    return null;
  }

  function clean(text, max = 200) {
    if (typeof text !== 'string') return null;
    const t = text.replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
    if (!t) return null;
    return check(t) ? null : t;
  }

  return { check, clean };
}
