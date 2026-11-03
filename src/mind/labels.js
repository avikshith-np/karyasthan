// Per-run chat labels and ref resolution (spec 008, contracts/mind-output.md "Refs",
// data-model "Label map per run").
//
// A run's input names chats only by label (C1…C12). The model answers with refs to
// those labels; code maps them back. A ref with a valid pattern but no entry in this
// run's map — or pointing at a thread / today note / episode the entry does not have —
// resolves to null (the validator drops it as unknown_ref). Chat ids in writes always
// come from this map, never from model output (data-model "Validation summary").
//
// Entry shape (all but chatJid optional):
//   { chatJid, kind: 'group'|'dm', digestId, hasToday, threadKs: [1..3], episodeId, name }
// `threads` (an array with `k` per item, as stored in mind_digests.threads_json) and
// `todayNote` may be passed instead of threadKs / hasToday; buildLabelMap derives them.

export const MAX_LABELS = 12;

export const CHAT_REF = /^C([1-9]|1[0-2])$/;
export const THREAD_REF = /^C([1-9]|1[0-2])\.t([1-3])$/;
export const TODAY_REF = /^C([1-9]|1[0-2])\.today$/;
export const EPISODE_REF = /^C([1-9]|1[0-2])\.e$/;

const kindOfJid = (jid) => (typeof jid === 'string' && jid.endsWith('@g.us') ? 'group' : 'dm');

function threadKsOf(c) {
  if (Array.isArray(c.threadKs)) return c.threadKs.map(Number).filter(k => Number.isInteger(k) && k >= 1 && k <= 3);
  if (Array.isArray(c.threads)) {
    return c.threads.map((t, i) => Number(t?.k ?? i + 1)).filter(k => Number.isInteger(k) && k >= 1 && k <= 3);
  }
  return [];
}

/**
 * chats: [{ chatJid, kind?, digestId?, hasToday?|todayNote?, threadKs?|threads?, episodeId?, name? }]
 * (in priority order). At most 12 distinct chats get labels C1…C12; duplicates and
 * entries without a chatJid are skipped. → { C1: entry, … } (frozen entries)
 */
export function buildLabelMap(chats = []) {
  const map = {};
  const seen = new Set();
  let n = 0;
  for (const c of Array.isArray(chats) ? chats : []) {
    if (n >= MAX_LABELS) break;
    const chatJid = typeof c === 'string' ? c : c?.chatJid;
    if (typeof chatJid !== 'string' || !chatJid || seen.has(chatJid)) continue;
    seen.add(chatJid);
    const src = typeof c === 'string' ? {} : c;
    const kind = src.kind === 'group' || src.kind === 'dm' ? src.kind : kindOfJid(chatJid);
    const entry = {
      chatJid,
      kind,
      digestId: Number.isFinite(Number(src.digestId)) && src.digestId != null ? Number(src.digestId) : null,
      hasToday: src.hasToday === true || (typeof src.todayNote === 'string' && src.todayNote.length > 0),
      threadKs: threadKsOf(src),
      episodeId: Number.isFinite(Number(src.episodeId)) && src.episodeId != null ? Number(src.episodeId) : null,
    };
    if (typeof src.name === 'string') entry.name = src.name;
    map[`C${++n}`] = Object.freeze(entry);
  }
  return map;
}

/** The label of a chat in this map, or null. */
export function labelOf(map, chatJid) {
  for (const [label, e] of Object.entries(map || {})) if (e.chatJid === chatJid) return label;
  return null;
}

/** The labels of a map in order (C1, C2, …). */
export function labelsOf(map) {
  return Object.keys(map || {}).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/**
 * Resolve a ref against a run's label map.
 *   'C3'       → { type:'chat', label, chatJid, chatKind, entry }
 *   'C3.t2'    → { type:'thread', …, thread: 2 }   (the digest must have thread 2)
 *   'C3.today' → { type:'today', … }                (the digest must have a today note)
 *   'C3.e'     → { type:'episode', … }              (an episode must be in the input)
 * Anything else, or a ref the map cannot back, → null.
 */
export function resolveRef(map, ref) {
  if (typeof ref !== 'string' || !map) return null;
  let m;
  let type;
  let thread = null;
  if ((m = ref.match(CHAT_REF))) type = 'chat';
  else if ((m = ref.match(THREAD_REF))) { type = 'thread'; thread = Number(m[2]); }
  else if ((m = ref.match(TODAY_REF))) type = 'today';
  else if ((m = ref.match(EPISODE_REF))) type = 'episode';
  else return null;
  const label = `C${m[1]}`;
  const entry = Object.prototype.hasOwnProperty.call(map, label) ? map[label] : null;
  if (!entry) return null;
  if (type === 'thread' && (entry.digestId == null || !entry.threadKs.includes(thread))) return null;
  if (type === 'today' && (entry.digestId == null || !entry.hasToday)) return null;
  if (type === 'episode' && entry.episodeId == null) return null;
  const out = { type, label, chatJid: entry.chatJid, chatKind: entry.kind, entry };
  if (thread !== null) out.thread = thread;
  return out;
}

/** A compact, text-free copy of the map for mind_runs.input_json (label → chat, kind, ids). */
export function labelMapForInput(map) {
  const out = {};
  for (const label of labelsOf(map)) {
    const e = map[label];
    out[label] = { chatJid: e.chatJid, kind: e.kind, digestId: e.digestId, episodeId: e.episodeId };
  }
  return out;
}
