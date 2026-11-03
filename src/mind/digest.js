// Digests (spec 008, research R6, contracts/mind-output.md §1 and "Fencing").
//
//   codeDigests(sinceAt)            counters only (mind_chat_activity): no text, no names.
//                                   The glance labels them C1…Cn.
//   refreshClerkDigests(chats, runId)
//                                   ONE callRole('clerk', DIGEST_PROMPT, …, {caller:'mind.digest'})
//                                   PER CHAT — each call sees exactly one chat's eligible lines
//                                   after that chat's monotonic digest cursor (≤ digestMaxLines,
//                                   plus ≤ 10 context lines), P-labelled, each line sanitized,
//                                   fence-stripped, collapsed and capped at 300 chars, inside one
//                                   UNTRUSTED_CHAT_DATA fence. The output goes through
//                                   validateDigest; evidence = EVERY input line (L and C) in
//                                   item_evidence('mind_digest'); thread citations are resolved in
//                                   code to message ids + canonical senders (authors). Each clerk
//                                   call is one mind_runs row of kind 'digest', which is also the
//                                   counter for the mind's daily clerk-call cap.
//   digestBundle(labelMap)          the think input: ≤ 8 chats and ≤ 6 KB of digest text (the
//                                   oldest digests are dropped first), fenced once more.
// Origins are never read from model output: a digest's chat is the chat whose lines
// were read, period_start = MIN ts over every input line (the stricter join-time floor).
// Nothing here logs chat text or digest text.

import * as store from './store.js';
import { now as clockNow, dayKey } from './clock.js';
import { DIGEST_PROMPT, cleanChatText, fenceBlock } from './charter.js';
import { validateDigest } from './schema.js';
import { labelsOf } from './labels.js';
import { callRole } from '../brain/llm.js';
import { resolvePerson, bareJid, isSelfJid } from '../memory/identity.js';
import { getPerson } from '../memory/peopleStore.js';
import { getGroup } from '../memory/groupStore.js';
import { config, getPersona } from '../utils/config.js';

export const LINE_CAP = 300;
export const CONTEXT_LINES = 10;
export const BUNDLE_MAX_BYTES = 6144;
export const BUNDLE_MAX_CHATS = 8;
const TODAY_NOTE_GRACE_SEC = 6 * 3600;

const DEFAULT_DEPS = {
  now: () => clockNow(),
  callRole: (role, system, user, opts) => callRole(role, system, user, opts),
  eligibleLines: async (chatJid, opts) => (await import('../memory/mindReads.js')).eligibleLines(chatJid, opts),
  getPerson: (jid) => getPerson(jid),
  getGroup: (jid) => getGroup(jid),
  getPersona: () => getPersona(),
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: { now, callRole, eligibleLines, getPerson, getGroup, getPersona }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
}

const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
const hoursSince = (t, at) => (at ? Math.round(((t - at) / 3600) * 10) / 10 : null);

// ── code digests ─────────────────────────────────────────────────────────────

/**
 * Counter digests per chat since `sinceAt` (a unix time or a 'YYYY-MM-DD' day key;
 * default: today). → [{ chatJid, kind, msgs, humanMsgs, senders, botMentions,
 * openQuestions, botMsgs, lastHumanAt, lastBotAt, hoursSinceHuman, hoursSinceBot }],
 * busiest first, ≤ 12. No text, no names.
 */
export function codeDigests(sinceAt = null) {
  const t = Math.floor(deps.now());
  const rows = store.activityFor(sinceAt ?? dayKey(t));
  const by = new Map();
  for (const r of rows) {
    const cur = by.get(r.chatJid) || { chatJid: r.chatJid, kind: isGroupJid(r.chatJid) ? 'group' : 'dm', msgs: 0, humanMsgs: 0,
      senders: 0, botMentions: 0, openQuestions: 0, botMsgs: 0, lastHumanAt: null, lastBotAt: null };
    for (const k of ['msgs', 'humanMsgs', 'senders', 'botMentions', 'openQuestions', 'botMsgs']) cur[k] += Number(r[k]) || 0;
    if (r.lastHumanAt && (!cur.lastHumanAt || r.lastHumanAt > cur.lastHumanAt)) cur.lastHumanAt = r.lastHumanAt;
    if (r.lastBotAt && (!cur.lastBotAt || r.lastBotAt > cur.lastBotAt)) cur.lastBotAt = r.lastBotAt;
    by.set(r.chatJid, cur);
  }
  return [...by.values()]
    .map(c => ({ ...c, openQuestions: Math.max(0, c.openQuestions), hoursSinceHuman: hoursSince(t, c.lastHumanAt),
      hoursSinceBot: hoursSince(t, c.lastBotAt) }))
    .sort((a, b) => b.humanMsgs - a.humanMsgs || (b.lastHumanAt || 0) - (a.lastHumanAt || 0))
    .slice(0, 12);
}

// ── clerk digests ────────────────────────────────────────────────────────────

/** Mind-caused clerk calls today (mind_runs of kind 'digest'; episode/weekly calls log the same kind). */
export function clerkCallsToday(t = deps.now()) {
  return store.countRuns({ kind: 'digest', dayKey: dayKey(Math.floor(t)) });
}

/** True while the mind may make another clerk call today (config.mind.clerkMaxPerDay). */
export function clerkBudgetLeft(t = deps.now()) {
  const max = Number(config.mind?.clerkMaxPerDay ?? 60);
  return clerkCallsToday(t) < max;
}

function nameOf(personJid) {
  try {
    const p = deps.getPerson(personJid);
    return cleanChatText(p?.real_name || p?.push_name || '', 40) || 'unknown';
  } catch { return 'unknown'; }
}

function chatName(chatJid) {
  try {
    if (isGroupJid(chatJid)) return cleanChatText(deps.getGroup(chatJid)?.name || '', 60) || 'a group';
    return nameOf(chatJid) === 'unknown' ? 'a friend' : nameOf(chatJid);
  } catch { return isGroupJid(chatJid) ? 'a group' : 'a friend'; }
}

const isBotLine = (l) => !!l.isFromSelf || isSelfJid(l.senderJid);
const personOf = (jid) => (typeof jid === 'string' ? resolvePerson(jid) || bareJid(jid) : null);

/** Build the clerk's user message and the id maps for one chat. Exported for tests. */
export function buildDigestInput(chatJid, lines, context) {
  const isGroup = isGroupJid(chatJid);
  const roster = new Map();      // person → { label, name }
  const labelFor = (l) => {
    if (isBotLine(l)) return '(you)';
    const p = personOf(l.senderJid);
    if (!p) return 'someone';
    if (!roster.has(p)) roster.set(p, { label: `P${roster.size + 1}`, name: nameOf(p) });
    return roster.get(p).label;
  };
  const ctxOut = context.map((l, i) => ({ id: `C${i + 1}`, line: l, who: labelFor(l), text: cleanChatText(l.text, LINE_CAP) }));
  const lineOut = lines.map((l, i) => ({ id: `L${i + 1}`, line: l, who: labelFor(l), text: cleanChatText(l.text, LINE_CAP) }));
  const persona = deps.getPersona() || {};
  const you = cleanChatText(persona.name || 'the character', 60);
  const vibe = persona.vibe ? cleanChatText(persona.vibe, 160) : '';
  const header = isGroup ? `This is a group chat named "${chatName(chatJid)}".`
    : 'This is a private one-to-one chat between you and P1. Everything here is private to this chat.';
  const body = [
    header,
    'People:',
    ...[...roster.values()].map(v => `${v.label}: ${v.name}`),
    '',
    ...ctxOut.map(o => `[${o.id}] ${o.who}: ${o.text}`),
    ...lineOut.map(o => `[${o.id}] ${o.who}: ${o.text}`),
  ].join('\n');
  const user = `You are ${you}${vibe ? ` (${vibe})` : ''}. Your own lines are marked (you).
Lines marked [C…] are earlier context; lines marked [L…] are new.

${fenceBlock(body)}

Return only the JSON object described in the instructions.`;
  const lineIds = lineOut.map(o => o.id);
  const humanLineIds = lineOut.filter(o => !isBotLine(o.line)).map(o => o.id);
  const byId = new Map([...ctxOut, ...lineOut].map(o => [o.id, o.line]));
  return { user, lineIds, humanLineIds, byId };
}

function skipReason(res) {
  const s = res?.skipped;
  if (s === 'budget' || s === 'no_key' || s === 'disabled') return s;
  if (s === 'shadow_only') return 'disabled';
  return 'error';
}

/**
 * Refresh clerk digests for up to config.mind.digestMaxChats chats (chat keys, or
 * { chatJid }), in order. runId = the run that asked (think / draft), stored on each
 * digest. → { results: [{ chatJid, status, digestId?, reason? }], calls }
 *   status: 'ok' | 'nothing_new' | 'skipped' (cap, budget, no_key, disabled) | 'failed' | 'invalid'
 * The digest cursor advances only when a digest is stored.
 */
export async function refreshClerkDigests(chats = [], runId = null) {
  const maxChats = Math.max(1, Math.min(12, Number(config.mind?.digestMaxChats) || 8));
  const maxLines = Math.max(1, Number(config.mind?.digestMaxLines) || 120);
  const list = [...new Set((Array.isArray(chats) ? chats : []).map(c => (typeof c === 'string' ? c : c?.chatJid))
    .filter(c => typeof c === 'string' && c))].slice(0, maxChats);
  const results = [];
  let calls = 0;
  for (const chatJid of list) {
    if (!clerkBudgetLeft()) { results.push({ chatJid, status: 'skipped', reason: 'cap' }); continue; }
    const cursor = store.digestCursor(chatJid);
    let read;
    try {
      read = await deps.eligibleLines(chatJid, { afterRowid: cursor, limit: maxLines, contextLines: CONTEXT_LINES });
    } catch {
      results.push({ chatJid, status: 'failed', reason: 'read' });
      continue;
    }
    const lines = (read?.lines || []).filter(l => Number(l.rowid) > cursor).slice(-maxLines);
    // Context = eligible lines before the first new line (never advances the cursor).
    const first = lines.length ? Number(lines[0].rowid) : Infinity;
    const context = (read?.context || []).filter(l => Number(l.rowid) < first).slice(-CONTEXT_LINES);
    if (!lines.some(l => !isBotLine(l))) { results.push({ chatJid, status: 'nothing_new' }); continue; }

    const input = buildDigestInput(chatJid, lines, context);
    const runRow = store.insertRun({ kind: 'digest', triggerRef: runId != null ? `run:${runId}` : null,
      input: { chatJid, lines: lines.length, context: context.length, fromRowid: cursor } });
    calls++;
    const res = await deps.callRole('clerk', DIGEST_PROMPT, input.user, { caller: 'mind.digest', maxTokens: 1500 });
    const usage = { model: res?.model ?? null, tokensIn: res?.usage?.input ?? null, tokensOut: res?.usage?.output ?? null,
      cacheRead: res?.usage?.cacheRead ?? null, costUsd: res?.costUsd ?? null, fellBack: !!res?.fellBack };
    if (!res || res.skipped || res.status !== 'ok' || typeof res.text !== 'string' || !res.text) {
      const skipped = !!res?.skipped;
      store.finishRun(runRow, { status: skipped ? 'skipped' : 'failed', skipReason: skipped ? skipReason(res) : null,
        error: skipped ? null : String(res?.status || 'no_text').slice(0, 60), ...usage });
      results.push({ chatJid, status: skipped ? 'skipped' : 'failed', reason: skipped ? skipReason(res) : 'error' });
      continue;
    }
    const v = validateDigest(res.text, { lineIds: input.lineIds, humanLineIds: input.humanLineIds });
    if (!v.ok) {
      store.finishRun(runRow, { status: 'invalid', error: v.error, dropped: v.dropped, ...usage });
      results.push({ chatJid, status: 'invalid', reason: v.error });
      continue;
    }
    const all = [...context, ...lines];
    // to_rowid also covers eligible rows mindReads read but dropped for having no text.
    const toRowid = Math.max(...lines.map(l => Number(l.rowid)), Number(read?.maxRowid) || 0);
    const tsList = all.map(l => Math.floor(Number(l.ts))).filter(Number.isFinite);
    const threads = v.value.threads.map(th => {
      const cited = th.evidence.map(id => input.byId.get(id)).filter(Boolean);
      const authors = [...new Set(cited.filter(l => !isBotLine(l)).map(l => personOf(l.senderJid)).filter(Boolean))];
      return { k: th.k, text: th.text, evidence: cited.map(l => l.id), authors };
    }).filter(th => th.authors.length);
    let digestId;
    try {
      digestId = store.insertDigest({
        chatJid,
        originKind: isGroupJid(chatJid) ? 'group' : 'dm',
        fromRowid: cursor,
        toRowid,
        periodStart: Math.min(...tsList),
        periodEnd: Math.max(...tsList),
        summary: v.value.summary,
        todayNote: v.value.todayNote,
        tone: v.value.tone,
        threads,
        model: usage.model,
        runId: runId ?? null,
        evidence: all.map(l => ({ msgId: l.id, ts: l.ts })),
      });
    } catch (err) {
      store.finishRun(runRow, { status: 'failed', error: String(err?.code || err?.name || 'store').slice(0, 60), ...usage });
      results.push({ chatJid, status: 'failed', reason: 'store' });
      continue;
    }
    store.finishRun(runRow, { status: 'ok', dropped: v.dropped, output: { digestId, threads: threads.length,
      cited: v.value.evidence.length, evidence: all.length }, ...usage });
    results.push({ chatJid, status: 'ok', digestId });
  }
  return { results, calls };
}

// ── think bundle ─────────────────────────────────────────────────────────────

/** Plan 020 D1: is a digest's "today" note still about today? Its own local date, or under 6 h old (a late evening's note past midnight). */
export function digestIsToday(d, t) {
  return Number.isFinite(d?.createdAt) && (dayKey(d.createdAt) === dayKey(t) || t - d.createdAt < TODAY_NOTE_GRACE_SEC);
}

function ageWords(createdAt, t) {
  if (!Number.isFinite(createdAt)) return 'of unknown age';
  const h = Math.floor(Math.max(0, t - createdAt) / 3600);
  return h < 1 ? 'as of the last hour' : `as of ${h} h ago`;
}

function section(label, entry, d, t) {
  const name = cleanChatText(entry.name || chatName(entry.chatJid), 60);
  const out = [`${label} (${d.originKind === 'group' ? 'group' : 'one-to-one'}) "${name}" (${ageWords(d.createdAt, t)})`,
    `summary: ${cleanChatText(d.summary, 400)}`];
  if (d.todayNote && digestIsToday(d, t)) out.push(`${label}.today: ${cleanChatText(d.todayNote, 80)}`);
  for (const th of Array.isArray(d.threads) ? d.threads : []) {
    const k = Number(th?.k);
    if (Number.isInteger(k) && k >= 1 && k <= 3 && typeof th.text === 'string') out.push(`${label}.t${k}: ${cleanChatText(th.text, 100)}`);
  }
  out.push(`tone: ${d.tone}`);
  return out.join('\n');
}

/**
 * The think's digest bundle for a run's label map ({ C1: { chatJid, digestId, … } }).
 * Each digest must exist and belong to that label's chat. ≤ 8 chats (≤ digestMaxChats)
 * and ≤ 6 KB of section text; over either cap the oldest digests are dropped first.
 * → { text (fenced; '' when empty), labels: [included], dropped: [{label, reason}], bytes }
 */
export function digestBundle(labelMap = {}) {
  const maxChats = Math.min(BUNDLE_MAX_CHATS, Math.max(1, Number(config.mind?.digestMaxChats) || BUNDLE_MAX_CHATS));
  const items = [];
  const dropped = [];
  const t = deps.now();
  for (const label of labelsOf(labelMap)) {
    const e = labelMap[label];
    if (e.digestId == null) continue;
    const d = store.getDigest(e.digestId);
    if (!d || d.chatJid !== e.chatJid) { dropped.push({ label, reason: 'digest_gone' }); continue; }
    const text = section(label, e, d, t);
    items.push({ label, text, bytes: Buffer.byteLength(text, 'utf8') + 2, age: [d.createdAt || 0, d.id] });
  }
  const byAge = [...items].sort((a, b) => a.age[0] - b.age[0] || a.age[1] - b.age[1]);
  const keep = new Set(items.map(i => i.label));
  let bytes = items.reduce((s, i) => s + i.bytes, 0);
  for (const it of byAge) {
    if (keep.size <= maxChats && bytes <= BUNDLE_MAX_BYTES) break;
    keep.delete(it.label);
    bytes -= it.bytes;
    dropped.push({ label: it.label, reason: 'cap' });
  }
  const included = items.filter(i => keep.has(i.label));
  return {
    text: included.length ? fenceBlock(included.map(i => i.text).join('\n\n')) : '',
    labels: included.map(i => i.label),
    dropped,
    bytes: Math.max(0, bytes),
  };
}
