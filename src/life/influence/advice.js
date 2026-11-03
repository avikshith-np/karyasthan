// Life-direction advice → the owner's tray (spec 012 plan §P3.1). Pure: no DB,
// no world events, no model calls — the facade (influence/index.js) passes the
// readers in and writes the row through store.js.
//
// An accepted `kind: advice` perception ("you should quit that job", "call your
// mum more") changes NOTHING in his life. It becomes one pending row on the
// Story / Director tray; the owner may approve it (→ a Director scene builder
// preset to that category, nothing else — what happens is the owner's own
// scene, through the normal preview → apply) or reject it. Admission, in code:
// the category is on the closed list, the story's controls let a new thing
// start there (paused / frozen refuse; guided passes — the owner decides
// anyway), ≤ advicePerCategory pending in that category, ≤ 1 pending per
// sender and category. Every label is built here from the category code and a
// chat name; the message text only ever reaches the owner as the live excerpt.

import { cleanLine } from './perceive.js';

/** The advice categories (1:1 onto the story's reducer.CATEGORIES). */
export const CATEGORIES = Object.freeze(['career', 'romance', 'family', 'social', 'health']);
export const EXCERPT_MAX = 300;
const DAY = 86400;

/**
 * May this advice join the tray? → null (yes) or the refusal's code.
 * deps: { controls({source, category, action}) → {ok, reason?}, pendingCount(category),
 *         pendingBySender(category, sender), perCategory }
 */
export function refusal({ category, senderJid }, deps) {
  if (!CATEGORIES.includes(category)) return 'category';
  if (typeof senderJid !== 'string' || !senderJid) return 'sender';
  let v;
  try { v = deps.controls({ source: 'reconciler', category, action: 'start' }); } catch { v = null; }
  if (v?.ok !== true) return v?.reason === 'paused' || v?.reason === 'frozen' || v?.reason === 'pinned' ? v.reason : 'controls';
  const cap = Number(deps.perCategory);
  if (!(cap > 0)) return 'cap';
  if (deps.pendingCount(category) >= cap) return 'cap';
  if (deps.pendingBySender(category, senderJid)) return 'duplicate';
  return null;
}

/** When a row made at `at` leaves the tray (CHAT_INFLUENCE_ADVICE_DAYS, 1–14). */
export function expiresAt(at, days) {
  const d = Number.isFinite(Number(days)) ? Math.min(14, Math.max(1, Math.round(Number(days)))) : 14;
  return Math.floor(at) + d * DAY;
}

/** The code-built tray line: "advice from <chat> about <category>". */
export function summaryOf(chatName, category) {
  const where = cleanLine(chatName, 40) || 'a chat';
  return `advice from ${where} about ${CATEGORIES.includes(category) ? category : 'his life'}`;
}

/** The owner's view of the message (fenced tokens and markers stripped, ≤ 300 chars). */
export function excerptOf(content) {
  const s = cleanLine(content, EXCERPT_MAX);
  return s || null;
}

/** What an approval hands the Director page: its scene builder, preset to the category. */
export function presetOf(category) {
  return CATEGORIES.includes(category) ? { shape: 'arc.start', category } : null;
}
