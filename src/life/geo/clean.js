import { sanitizeWebContent } from '../../brain/webSearch.js';
import { realPeopleNames, textNameCollisions } from '../world.js';

// 014 geo (plan §A1.3, threat T3/T4): OSM data is editable by anyone, so every
// venue name and area that could reach the world (and later a prompt) is
// cleaned here in code: format characters, NFKC, the web sanitizer, a tight
// charset, caps, no URL/@/JID/phone/marker, no real person's name and no word
// of a small venue blocklist (instruction lexicon + forbidden themes). The
// owner's review of each swap is the real control; this keeps the obvious out.
//
// Also the route geometry helpers (Douglas–Peucker, E5 integers, straightening
// near a home-kind endpoint) — pure.

export const NAME_MAX = 60;
export const NAME_MAX_WORDS = 8;
export const AREA_MAX = 40;
export const LONG_NAME_WORDS = 5;
export const LONG_NAME_CHARS = 40;

// Instruction lexicon (R9) and forbidden themes (R7). Whole words, case-folded.
export const VENUE_BLOCKLIST = Object.freeze([
  'ignore', 'instruction', 'instructions', 'system', 'assistant', 'prompt', 'reply', 'say', 'password', 'otp', 'send', 'you',
  'sex', 'sexy', 'porn', 'xxx', 'nude', 'nudes', 'escort', 'strip', 'kill', 'murder', 'rape', 'nazi', 'hitler', 'terror',
]);
const BLOCK = new Set(VENUE_BLOCKLIST);

const NAME_RE = /^[\p{L}\p{N} &'’.,()\-/]+$/u;
const URL_RE = /(?:https?:\/\/|www\.|\.(?:com|net|org|in|io|co)\b)/i;
const JID_RE = /[0-9A-Za-z._:+-]{3,}@(?:s\.whatsapp\.net|g\.us|lid|c\.us|broadcast)|@\d{5,}/i;
// Phone-like runs as the public scrubber sees them (any script's digits; spaces,
// brackets, dots and dashes between), and any name with 7+ digits in all.
const PHONE_RE = /\+?\p{Nd}[\p{Nd}\s().-]{7,}\p{Nd}/u;
const tooManyDigits = (s) => (s.match(/\p{Nd}/gu) ?? []).length >= 7;
const MARKER_RE = /\[[A-Z_]{2,}\s*[:(]|>>>|\{\{|<\/?[a-z]/i;

function strip(raw) {
  return String(raw ?? '').replace(/\p{Cf}/gu, '').normalize('NFKC');
}

/**
 * The cleaned venue name, or null (dropped: counted as unsafe_name by the
 * caller). `knownNames` = the real people's names (from realNamesOrThrow).
 */
export function cleanVenueName(raw, { knownNames = [] } = {}) {
  if (typeof raw !== 'string') return null;
  const pre = strip(raw);
  if (pre.includes('@') || URL_RE.test(pre) || JID_RE.test(pre) || PHONE_RE.test(pre) || tooManyDigits(pre) || MARKER_RE.test(pre)) return null;
  const s = sanitizeWebContent(pre).replace(/\s+/g, ' ').trim();
  if (!s || s.length > NAME_MAX || !/\p{L}/u.test(s) || !NAME_RE.test(s)) return null;
  const words = s.split(' ');
  if (words.length > NAME_MAX_WORDS) return null;
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w && BLOCK.has(w)) return null;
  if (textNameCollisions({ places: [{ name: s }] }, knownNames).length) return null;
  return s;
}

/** A suburb-level area word (never a house number, road or postcode), or null. */
export function cleanArea(raw, { knownNames = [] } = {}) {
  if (typeof raw !== 'string') return null;
  const pre = strip(raw);
  if (/\d/.test(pre) || pre.includes('@') || URL_RE.test(pre) || MARKER_RE.test(pre)) return null;
  const s = sanitizeWebContent(pre).replace(/\s+/g, ' ').trim();
  if (!s || s.length > AREA_MAX || !/\p{L}/u.test(s) || !NAME_RE.test(s)) return null;
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w && BLOCK.has(w)) return null;
  if (textNameCollisions({ places: [{ name: s }] }, knownNames).length) return null;
  return s;
}

/** Flags of a cleaned name: long_name (> 5 words or > 40 chars) needs the owner's tick. */
export function nameFlags(name) {
  const flags = [];
  if (typeof name === 'string' && (name.split(' ').length > LONG_NAME_WORDS || name.length > LONG_NAME_CHARS)) flags.push('long_name');
  return flags;
}

/**
 * The real people's names, read without a catch (R7): a read error throws,
 * and the caller drops every candidate (`names_unavailable`) — never the
 * fail-open director default.
 */
export function realNamesOrThrow(read = realPeopleNames) {
  const names = read();
  if (!Array.isArray(names)) throw Object.assign(new Error('names_unavailable'), { code: 'names_unavailable' });
  return names;
}

// ── Geometry ──────────────────────────────────────────────────────────────

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function metres(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Perpendicular distance (m) of p from the segment a–b on a local flat projection.
function segDist(p, a, b) {
  const k = Math.cos(rad(a[0]));
  const ax = a[1] * k; const ay = a[0];
  const bx = b[1] * k; const by = b[0];
  const px = p[1] * k; const py = p[0];
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const deg = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  return deg * 111320;
}

function dp(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let max = -1; let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > max) { max = d; idx = k; }
    }
    if (idx > 0 && max > tol) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Douglas–Peucker over [lat, lon] points, raising the tolerance (10 m, ×2)
 * until ≤ maxPts; as a last resort the two endpoints. Invalid points → [].
 */
export function simplify(pts, maxPts = 200) {
  const list = (Array.isArray(pts) ? pts : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (list.length < 2) return [];
  let tol = 10;
  let out = dp(list, tol);
  while (out.length > maxPts && tol < 1e6) { tol *= 2; out = dp(list, tol); }
  return out.length > maxPts ? [list[0], list[list.length - 1]] : out;
}

/** [lat, lon] → integer [latE5, lonE5] pairs. */
export function toE5(pts) {
  return (Array.isArray(pts) ? pts : []).map(p => [Math.round(p[0] * 1e5), Math.round(p[1] * 1e5)]);
}

/**
 * Drop the geometry within `m` metres of `point` ({lat, lon}) and draw it
 * straight from the last point outside to `point` (R14): the stored route
 * never traces the streets next to a home-kind endpoint.
 */
export function straightenNear(pts, point, m = 400) {
  if (!Array.isArray(pts) || pts.length < 2 || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return Array.isArray(pts) ? pts.slice() : [];
  const at = [point.lat, point.lon];
  const near = (p) => metres(p, at) <= m;
  const first = metres(pts[0], at) <= metres(pts[pts.length - 1], at);
  const seq = first ? pts.slice().reverse() : pts.slice();   // the home end last
  let cut = seq.length;
  while (cut > 1 && near(seq[cut - 1])) cut--;
  const out = seq.slice(0, cut);
  out.push(seq[seq.length - 1]);
  return first ? out.reverse() : out;
}
