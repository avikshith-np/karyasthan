// Text output validation (spec 019). Fail closed: any violation → { ok:false, reason }
// and the turn is skipped (no message, never a code stand-in); nothing is repaired
// except a venue name, which is scrubbed to its kind word (the writers never see one).
//
//   validateTexts(raw, ctx) → { ok:true, value: { text, bubbles, tone, topic, end } } | { ok:false, reason }
//       text = the bubbles joined by '\n' (≤ TEXT_MAX); ctx = { names (allow-list: cast, his
//       names, places), knownNames (real people), castNames, venueNames }
//   heatProblem(text, register?) → 'explicit' | 'minor' | 'nonconsent' | null.
//       With no register (or anything but 'explicit'), explicit sexual words fail.
//       Register 'explicit' allows those words. Minor-age framing and non-consent always fail.
//   validateEditedText(text, ctx) → { ok, text } | { ok:false, reason } (the owner's edit)
import { parseJsonObject, validateText } from '../schema.js';
import { wishProblem } from '../prompt.js';
import { scrubVenueNames } from '../../places.js';
import { heatProblem as desireHeat, contentProblem } from '../desire.js';
import { TONES, TEXT_MAX, TOPIC_MAX } from './store.js';

export const BUBBLES_MAX = 3;
export const BUBBLE_MAX = 160;
const KEYS = new Set(['messages', 'tone', 'topic', 'end']);

/**
 * 'explicit' | 'minor' | 'nonconsent' | null.
 * One argument keeps the old ceiling (explicit words fail). Pass register
 * 'explicit' to allow those words; minor-age framing and non-consent still fail.
 */
export function heatProblem(text, register) {
  return desireHeat(text, register);
}

const bad = (reason) => ({ ok: false, reason });

// Words that carry no scene. A 3-word run of only these is not a repeated phrase.
const ECHO_STOP = new Set('i me my you your yours the a an to at on in of and or so it is am im dont still just when for be that this not no yes we our they them their was were do did are what how its up out now here there get got but if then than too very really already with from about have has had will would can could should ok okay haha yeah hey hi oh um'.split(' '));

function echoWords(s) {
  return String(s ?? '').toLowerCase().normalize('NFKC').replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function echoTrigrams(words) {
  const out = [];
  for (let i = 0; i + 3 <= words.length; i++) {
    const g = words.slice(i, i + 3);
    if (g.every(w => ECHO_STOP.has(w))) continue;
    out.push(g.join(' '));
  }
  return out;
}

/**
 * A phrase in `text` already said in `prior` (older texts, newest last).
 * A 3-word run, or a word of 4+ letters said in 3 of the last 6.
 * null when this turn says something new. The hit is for the retry note, never logged.
 */
export function repeatedPhrase(text, prior) {
  const recent = (Array.isArray(prior) ? prior : []).filter(t => typeof t === 'string' && t.trim()).slice(-8);
  if (!recent.length || typeof text !== 'string' || !text.trim()) return null;
  const seen = new Set();
  for (const p of recent) for (const g of echoTrigrams(echoWords(p))) seen.add(g);
  for (const bubble of text.split(/\n+/)) {
    for (const g of echoTrigrams(echoWords(bubble))) if (seen.has(g)) return g;
  }
  const sticky = new Map();
  for (const p of recent.slice(-6)) {
    for (const w of new Set(echoWords(p).filter(w => w.length >= 4 && !ECHO_STOP.has(w)))) sticky.set(w, (sticky.get(w) ?? 0) + 1);
  }
  for (const w of new Set(echoWords(text).filter(w => w.length >= 4 && !ECHO_STOP.has(w)))) {
    if ((sticky.get(w) ?? 0) >= 3) return w;
  }
  return null;
}

/**
 * A phrase this side already said earlier in the day, past what the writer can still see (2026-11-03 live: the same question
 * again after 22 texts, the same answer back). A 3-word run holding a real word. Softer than repeatedPhrase: the caller retries once and then lets it through.
 */
export function repeatedToday(text, earlier) {
  const seen = new Set();
  for (const p of Array.isArray(earlier) ? earlier : []) if (typeof p === 'string') for (const g of echoTrigrams(echoWords(p))) seen.add(g);
  if (!seen.size || typeof text !== 'string') return null;
  for (const bubble of text.split(/\n+/)) {
    for (const g of echoTrigrams(echoWords(bubble))) {
      if (seen.has(g) && g.split(' ').some(w => w.length >= 4 && !ECHO_STOP.has(w))) return g;
    }
  }
  return null;
}

/** The question bubbles in these texts (oldest first), newest `keep`, none the tame writers shouldn't read. */
export function questionsIn(texts, keep = 4) {
  const out = [];
  for (const t of Array.isArray(texts) ? texts : []) {
    if (typeof t !== 'string') continue;
    for (const b of t.split(/\n+/)) if (b.includes('?') && !heatProblem(b)) out.push(b.trim());
  }
  return out.slice(-keep);
}

// Instruction words in an owner's gist. What remains is the thing he was told to say.
const GIST_SKIP = new Set([...ECHO_STOP, 'ask', 'asks', 'asked', 'her', 'him', 'she', 'shes', 'he', 'hes', 'if', 'theres', 'anything', 'tell', 'say', 'says', 'mention', 'comment', 'about', 'going', 'back', 'initial', 'question', 'earlier', 'please', 'dont', 'whether']);

function gistHit(word, have) {
  if (have.includes(word)) return true;
  if ((word === 'tshirt' || word === 'shirt') && /\b(t\s*shirt|tee|shirt)\b/.test(have)) return true;
  if (word === 'underneath' && /\bunder\b/.test(have)) return true;
  return false;
}

/**
 * Words from an owner's gist that the text never asked. null when the gist
 * landed, or when it named nothing concrete. The words are for the retry note.
 */
export function gistMiss(gist, text) {
  const want = [...new Set(echoWords(gist).filter(w => w.length >= 5 && !GIST_SKIP.has(w)))];
  if (!want.length) return null;
  const have = echoWords(text).join(' ');
  const missing = want.filter(w => !gistHit(w, have));
  if (!missing.length) return null;
  // 2026-11-02: a gist is usually a description, not a script. A body / clothes question still needs
  // its body words; anything else has landed once half of its words are there (the rest is wording).
  if (bodyAsk(gist)) {
    const body = missing.filter(w => BODY_WORD_RE.test(w));
    return body.length || missing.length === want.length ? missing.slice(0, 4).join(' ') : null;
  }
  return want.length - missing.length >= Math.ceil(want.length / 2) ? null : missing.slice(0, 4).join(' ');
}

const BODY_WORD_RE = /^(underneath|underwear|bra|panties|naked|nude|tshirt|shirt)$/;

/** Is the owner's gist a question / an ask (the only kind the writer is held to)? */
export function gistIsAsk(gist) {
  const g = String(gist ?? '');
  return /^\s*(please\s+)?(ask|asks|asking|tell)\b/i.test(g) || /\?\s*$/.test(g) || bodyAsk(g);
}

/** The owner's question, as one text, when the writer keeps dodging it. null when it isn't a question. */
export function gistFallback(gist) {
  if (typeof gist !== 'string') return null;
  let s = gist.trim().replace(/\s+/g, ' ');
  if (!/^\s*(please\s+)?(ask|tell|say)\b/i.test(s) && !/\?/.test(s) && !/\bunderneath\b/i.test(s)) return null;
  s = s.replace(/^(please\s+)?(ask|tell|say)\s+(her|him|them)?\s*/i, '');
  s = s.replace(/^(if|whether)\s+/i, '');
  s = s.replace(/^going back to (?:my|the) (?:initial|earlier) question,?\s*/i, '');
  s = s.replace(/[.!\s]+$/g, '');
  if (!s || s.length > 140) return null;
  // Never a line that talks about her in the third person ("she is free on Sunday?"): no fallback then.
  if (/^(she|he|they|her|his|their|hers|him|them)\b/i.test(s)) return null;
  if (!s.endsWith('?')) s += '?';
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A clothes or body question the owner asked. Those turns skip the mind model, which talks around them. */
export function bodyAsk(gist) {
  return /\b(underneath|underwear|bra|panties|naked|nude|nothing under)\b/i.test(String(gist ?? ''));
}

/** The repeated phrase is part of what the owner told him to say, so it may stay. */
export function gistAllows(phrase, gist) {
  if (!phrase || !gist) return false;
  return echoWords(gist).some(w => w.length >= 4 && phrase.includes(w));
}

// The guard in arcs-tests/21 pins this exact call for a tame turn. An explicit
// register still rejects minor-age framing and non-consent.
function rejectHeat(text, register) {
  if (register !== 'explicit') {
    if (heatProblem(text)) return bad('explicit');
    return null;
  }
  const p = contentProblem(text);
  if (p === 'minor' || p === 'nonconsent') return bad(p);
  return null;
}

function realNameIn(text, ctx) {
  for (const c of String(text).split(/\n+|(?<=[.!?…])\s+/)) {
    if (!c.trim()) continue;
    const p = wishProblem(c.slice(0, 380), ctx.knownNames ?? [], ctx.castNames ?? []);
    if (p === 'real_person_name' || p === 'jid_in_text') return p === 'jid_in_text' ? 'identifier' : 'real_name';
  }
  return null;
}

function bubbleOf(v, ctx) {
  if (typeof v !== 'string' || !v.trim()) return { reason: 'empty' };
  const scrubbed = scrubVenueNames(v, Array.isArray(ctx.venueNames) ? ctx.venueNames : []);
  // Casual texts carry their own capitalised words (days, greetings, slang): two invented ones allowed per bubble.
  const r = validateText(scrubbed, { cap: BUBBLE_MAX, names: ctx.names ?? [], maxBytes: 1024, maxInvented: 2 });
  if (!r.ok) return { reason: r.reason };
  return r.text;
}

/** See the module comment. */
export function validateTexts(raw, ctx = {}) {
  const parsed = parseJsonObject(typeof raw === 'string' ? raw : '', 4096);
  if (!parsed.ok) return bad(`json_${parsed.error}`.slice(0, 24));
  const o = parsed.value;
  for (const k of Object.keys(o)) if (!KEYS.has(k)) return bad('bad_key');
  const msgs = Array.isArray(o.messages) ? o.messages : typeof o.messages === 'string' ? [o.messages] : null;
  if (!msgs || !msgs.length) return bad('no_messages');
  if (msgs.length > BUBBLES_MAX) return bad('too_many');
  const bubbles = [];
  for (const m of msgs) {
    const b = bubbleOf(m, ctx);
    if (typeof b !== 'string') return bad(b.reason);
    bubbles.push(b);
  }
  const text = bubbles.join('\n');
  if (text.length > TEXT_MAX) return bad('too_long');
  const heat = rejectHeat(text, ctx.register);
  if (heat) return heat;
  const name = realNameIn(text, ctx);
  if (name) return bad(name);
  const tone = TONES.includes(o.tone) ? o.tone : 'casual';
  const topic = typeof o.topic === 'string' ? validateText(o.topic, { cap: TOPIC_MAX, names: ctx.names ?? [], maxBytes: 256, maxInvented: 2 }) : null;
  if (topic && topic.ok && (rejectHeat(topic.text, ctx.register) || realNameIn(topic.text, ctx))) return bad('topic');
  return { ok: true, value: { text, bubbles, tone, topic: topic?.ok ? topic.text : null, end: o.end === true } };
}

/** The owner's edit of one turn: the same rejects (lines = bubbles), ≤ TEXT_MAX. '' clears the edit. */
export function validateEditedText(text, ctx = {}) {
  if (text === '' || text === null) return { ok: true, text: '' };
  if (typeof text !== 'string') return bad('bad_text');
  if (text.length > TEXT_MAX) return bad('too_long');
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return bad('empty');
  const out = [];
  for (const l of lines.slice(0, 6)) {
    const r = validateText(scrubVenueNames(l, ctx.venueNames ?? []), { cap: TEXT_MAX, names: [...(ctx.names ?? []), ...l.split(/\s+/)], maxBytes: 2048, maxInvented: 99 });
    if (!r.ok) return bad(r.reason === 'identifier' || r.reason === 'url' ? 'jid_in_text' : r.reason === 'empty' ? 'empty' : 'bad_text');
    out.push(r.text);
  }
  const joined = out.join('\n');
  const heat = rejectHeat(joined, ctx.register);
  if (heat) return heat;
  const name = realNameIn(joined, ctx);
  if (name) return bad(name === 'identifier' ? 'jid_in_text' : 'real_name');
  return { ok: true, text: joined.slice(0, TEXT_MAX) };
}
