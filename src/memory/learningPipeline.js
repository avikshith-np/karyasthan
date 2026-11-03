// Learning (spec 006, R9). Two tiers, both fire-and-forget:
//
//   onIngest(storedMsg) — called by events.js right after storeMessage. Counts the
//     message toward its chat's batch (learning_state survives restarts) and picks up
//     explicit self-declared nicknames in groups. Zero LLM cost.
//   runBatchAnalysis(chat) — every 100 (group) / 30 (DM) new messages: one LLM pass
//     over the messages after last_batch_rowid (a few earlier ones as marked context).
//
// What the model sees: speakers as P-labels (never phone numbers or @digits), every
// line with a short id, the bot's own lines tagged as context. It must cite line ids
// as evidence; only new, human-authored lines count, so the bot can't launder
// something it was told elsewhere into this chat's memory. Subjects are restricted to
// the labelled roster (members of the chat); an unknown label drops the item. Every
// item is stored with this chat as its origin and learned_at = its earliest evidence.
// Messages flagged no_learn ("forget that"), disappearing messages and reactions are
// never shown to the model at all.

import { getDb } from './db.js';
import * as peopleStore from './peopleStore.js';
import { upsertSlang, learnVibe } from './groupStore.js';
import { addMemory, addEvidence, upsertRelationship, reobserveMemory } from './relationshipStore.js';
import { resolvePerson, identitiesOf, bareJid, isPersonJid, isSelfJid } from './identity.js';
import { getMembership, groupsOf } from './membership.js';
import { callLlm } from '../brain/llm.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { logger } from '../utils/logger.js';
import { getPersona } from '../utils/config.js';
import { flattenContent } from '../utils/transcript.js';
import { isGroupJid } from '../utils/jidUtils.js';

const GROUP_THRESHOLD = 100;
const DM_THRESHOLD = 30;
const MAX_NEW_LINES = 150;       // newest new messages analysed per batch
const CONTEXT_LINES = 15;        // earlier messages shown as context only
const MIN_HUMAN_LINES = { group: 20, dm: 8 };
const MAX_ROSTER = 40;
const MAX_EXISTING = 40;
const MIN_CONFIDENCE = 0.5;
const FACT_CATEGORIES = new Set(['fact', 'event', 'temporary', 'interest', 'preference']);

const nowSec = () => Math.floor(Date.now() / 1000);
const inflight = new Map();      // chat → Promise (one batch per chat at a time)
let llm = callLlm;

/** Test hook: replace the LLM call ((system, prompt, opts) → string|null). null restores it. */
export function __setLlmForTest(fn) {
  llm = typeof fn === 'function' ? fn : callLlm;
}

/** The learning_state key for a stored message's chat: group → bare JID, DM → canonical person. */
export function chatKeyOf(chatJid) {
  if (!chatJid || typeof chatJid !== 'string') return null;
  if (isGroupJid(chatJid)) return bareJid(chatJid);
  if (!isPersonJid(chatJid) || isSelfJid(chatJid)) return null;   // the bot's own chat learns nothing
  return resolvePerson(chatJid) || bareJid(chatJid);
}

function chatForms(chat) {
  return isGroupJid(chat) ? [chat] : identitiesOf(chat);
}

const marks = (n) => Array(n).fill('?').join(',');
const clamp01 = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);

// ── Tier 1: at ingest ────────────────────────────────────────────────────────

/**
 * Called after storeMessage for every stored message. Never throws. Returns the
 * batch promise when this message triggered one (callers ignore it; tests await it).
 */
export function onIngest(storedMsg) {
  try {
    const msg = storedMsg || {};
    const chatRaw = msg.groupJid ?? msg.group_jid;
    const sender = msg.senderJid ?? msg.sender_jid;
    const type = msg.messageType ?? msg.message_type ?? 'text';
    if (!chatRaw || !sender || msg.isFromSelf || msg.is_from_self || isSelfJid(sender)) return null;
    if (type === 'reaction' || msg.expiresAt || msg.expires_at) return null;
    const chat = chatKeyOf(chatRaw);
    if (!chat) return null;

    if (isGroupJid(chat)) {
      try { selfDeclaredNickname(msg, chat, sender); } catch (err) {
        logger.warn({ err: err.message }, 'self-declared nickname failed (non-critical)');
      }
    }

    const db = getDb();
    const forms = chatForms(chat);
    // A chat with no state yet starts at "now": history before this message is not
    // re-analysed (the v5 backfill seeded every existing chat the same way).
    const count = db.prepare(`INSERT INTO learning_state (chat_jid, msgs_since_batch, last_batch_rowid)
      VALUES (?, 1, COALESCE((SELECT MAX(rowid) FROM messages WHERE group_jid IN (${marks(forms.length)}) AND id != ?), 0))
      ON CONFLICT(chat_jid) DO UPDATE SET msgs_since_batch = msgs_since_batch + 1
      RETURNING msgs_since_batch`).pluck().get(chat, ...forms, String(msg.id ?? ''));
    const threshold = isGroupJid(chat) ? GROUP_THRESHOLD : DM_THRESHOLD;
    if (count < threshold || inflight.has(chat)) return null;
    db.prepare('UPDATE learning_state SET msgs_since_batch = 0 WHERE chat_jid = ?').run(chat);
    return startBatch(chat);
  } catch (err) {
    logger.warn({ err: err.message }, 'learning onIngest failed (non-critical)');
    return null;
  }
}

function startBatch(chat) {
  const p = runBatchAnalysis(chat)
    .catch(err => { logger.warn({ err: err.message }, 'Batch analysis failed'); return null; })
    .finally(() => inflight.delete(chat));
  inflight.set(chat, p);
  return p;
}

// Self-declared nickname. It becomes a "(prefers X)" instruction in the prompt, so
// a false positive is expensive: only explicit naming phrases count, the name must
// END the message, and it's a single word. (A loose "I'm X" pattern once turned
// "i am working in…", "I'm done" and "Size 7" into people's preferred names.)
const NAME_END = String.raw`\s+([a-z][a-z]{1,19})\s*[.!😂🤣]*\s*$`;
const SELF_DECLARE = [
  // "call me X", "just call me X", "you can call me X"
  new RegExp(String.raw`(?:^|[.!?]\s*)(?:you can |just |pls |please )?(?:call me|address me as)` + NAME_END, 'i'),
  // "my name is X" / "my name's X"
  new RegExp(String.raw`(?:^|[.!?]\s*)my name(?:'s| is)` + NAME_END, 'i'),
  // "I go by X"
  new RegExp(String.raw`(?:^|[.!?]\s*)i go by` + NAME_END, 'i'),
  // Manglish: "enne X ennu vilikk" / "enne X vilikk"
  /^enne\s+([a-z][a-z]{1,19})\s+(?:ennu?\s+)?vilik/i,
];

function selfDeclaredNickname(msg, chat, sender) {
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!content || content.length > 200) return;
  const person = resolvePerson(sender) || bareJid(sender);
  if (!isPersonJid(person)) return;
  for (const pattern of SELF_DECLARE) {
    const match = content.match(pattern);
    if (!match?.[1]) continue;
    const nick = match[1].trim().toLowerCase();
    if (nick.length < 2 || nick.length > 20 || COMMON_WORDS.has(nick) || /ing$/.test(nick)) return;
    const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : nowSec();
    const evidence = msg.id ? [{ msgId: String(msg.id), ts }] : [];
    if (writeNickname(person, nick, 'group', chat, person, 0.7, 'self_declared', evidence, ts) != null) {
      logger.debug('Self-declared nickname learned');
    }
    return;   // one match is enough
  }
}

// ── Writers for peopleStore items (nicknames, facets) ────────────────────────
// peopleStore owns the upserts; the provenance rule for learned_at and the evidence
// rows are applied here in the same transaction so they hold whatever the upsert sets.
//
// A nickname row is one claim: re-observed → MAX(existing, new) (R9). A facet row is
// many claims merged (traits/interests unioned, the old summary kept when a batch
// gives none), so new evidence vouches only for what it added — the row keeps its
// EARLIEST learned_at and older content never becomes visible to later joiners.

function nextLearnedAt(prior, newMin) {
  if (!prior) return newMin;
  return prior.learned_at == null || newMin == null ? null : Math.max(prior.learned_at, newMin);
}

function facetLearnedAt(prior, newMin) {
  if (!prior) return newMin;
  return prior.learned_at == null || newMin == null ? null : Math.min(prior.learned_at, newMin);
}

function evidenceMin(evidence, fallback = null) {
  const ts = evidence.map(e => e.ts).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : fallback;
}

function evidenceLive(db, evidence) {
  if (!evidence.length) return true;
  const ids = evidence.map(e => e.msgId);
  const rows = db.prepare(`SELECT COALESCE(no_learn, 0) AS nl FROM messages WHERE id IN (${marks(ids.length)})`).all(...ids);
  return rows.length === ids.length && !rows.some(r => r.nl);
}

function writeNickname(personJid, nickname, originKind, originJid, usedBy, confidence, source, evidence, fallbackTs = null) {
  if (typeof peopleStore.upsertNickname !== 'function') return null;
  const db = getDb();
  const find = db.prepare('SELECT id, learned_at FROM nicknames WHERE person_jid = ? AND nickname = ? AND origin_jid = ?');
  return db.transaction(() => {
    if (!evidenceLive(db, evidence)) return null;
    const prior = find.get(personJid, nickname, originJid);
    const learnedAt = nextLearnedAt(prior, evidenceMin(evidence, fallbackTs));
    peopleStore.upsertNickname(personJid, nickname, originKind, originJid, usedBy || null, confidence, source, { learnedAt });
    const row = find.get(personJid, nickname, originJid);
    if (!row) return null;
    db.prepare('UPDATE nicknames SET learned_at = ? WHERE id = ?').run(learnedAt, row.id);
    addEvidence('nickname', row.id, evidence);
    return row.id;
  })();
}

function writeFacet(personJid, originKind, originJid, data, evidence) {
  if (typeof peopleStore.upsertFacet !== 'function') return null;
  const db = getDb();
  const find = db.prepare('SELECT rowid AS rid, learned_at FROM person_facets WHERE person_jid = ? AND origin_jid = ?');
  return db.transaction(() => {
    if (!evidenceLive(db, evidence)) return null;
    const prior = find.get(personJid, originJid);
    const learnedAt = facetLearnedAt(prior, evidenceMin(evidence));
    peopleStore.upsertFacet(personJid, originKind, originJid, data, { learnedAt });
    const row = find.get(personJid, originJid);
    if (!row) return null;
    db.prepare('UPDATE person_facets SET learned_at = ? WHERE rowid = ?').run(learnedAt, row.rid);
    addEvidence('facet', row.rid, evidence);
    return row.rid;
  })();
}

// ── Tier 2: batch analysis ───────────────────────────────────────────────────

const LINE_COLS = `rowid AS rid, id, sender_jid, sender_name, content, message_type, is_from_self, timestamp`;
const ELIGIBLE = `message_type != 'reaction' AND COALESCE(no_learn, 0) = 0 AND expires_at IS NULL`;

function lineText(r) {
  return sanitizeWebContent(flattenContent(r.content, r.message_type)).slice(0, 400);
}

function displayName(db, personJid, fallback) {
  const p = db.prepare('SELECT real_name, push_name FROM people WHERE jid = ?').get(personJid);
  const name = sanitizeWebContent(fallback || p?.real_name || p?.push_name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return name || 'unknown';
}

const words = (s) => String(s || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);

// P-label roster: speakers first (in order of appearance), then non-speaking chat
// members (DM: people the DM person shares a group with) whose name appears in the
// text. A non-speaker whose name collides with another roster name is left out —
// an ambiguous name is dropped, never guessed.
function buildRoster(db, chat, isGroup, rows) {
  const byPerson = new Map();   // person → { label, name, speaker }
  const add = (person, name, speaker) => {
    if (!person || byPerson.has(person) || isSelfJid(person) || !isPersonJid(person)) return;
    byPerson.set(person, { label: null, name, speaker });
  };
  for (const r of rows) {
    if (r.is_from_self || isSelfJid(r.sender_jid)) continue;
    const p = resolvePerson(r.sender_jid) || bareJid(r.sender_jid);
    if (!byPerson.has(p)) add(p, displayName(db, p, r.sender_name), true);
  }
  if (!isGroup) add(chat, displayName(db, chat), true);

  const text = new Set(rows.flatMap(r => words(r.content)));
  const candidates = new Set();
  if (isGroup) for (const p of getMembership(chat).members.keys()) candidates.add(p);
  else for (const { groupJid } of groupsOf(chat)) for (const p of getMembership(groupJid).members.keys()) candidates.add(p);
  const extra = [];
  for (const p of candidates) {
    if (byPerson.has(p) || isSelfJid(p)) continue;
    const name = displayName(db, p);
    if (name !== 'unknown' && words(name).some(w => text.has(w))) extra.push([p, name]);
  }
  const nameCount = new Map();
  for (const n of [...[...byPerson.values()].map(v => v.name), ...extra.map(e => e[1])]) {
    nameCount.set(n.toLowerCase(), (nameCount.get(n.toLowerCase()) || 0) + 1);
  }
  for (const [p, name] of extra) {
    if (byPerson.size >= MAX_ROSTER) break;
    if (nameCount.get(name.toLowerCase()) > 1) continue;
    add(p, name, false);
  }
  let i = 0;
  const byLabel = new Map();
  for (const [person, v] of byPerson) { v.label = `P${++i}`; byLabel.set(v.label, { person, ...v }); }
  return { byPerson, byLabel };
}

function buildPrompt({ isGroup, roster, lines, existing }) {
  const bot = getPersona().name;
  const rosterText = [...roster.byLabel.values()].map(v => `${v.label}: ${v.name}`).join('\n');
  const log = lines.map(l => `[${l.id}] ${l.speaker}: ${l.text}${l.bot ? '   (BOT — context only)' : ''}`).join('\n');
  const existingText = existing.length
    ? existing.map(e => `[M${e.id}] ${e.subjectLabel || '-'} (${e.category}${e.attribute ? `/${e.attribute}` : ''}): ${e.content}`).join('\n')
    : '(none)';
  const framing = isGroup
    ? 'This is an excerpt of a WhatsApp group chat.'
    : 'This is a private one-to-one WhatsApp chat between P1 and BOT. Anything here is private to this chat.';
  return `${framing} BOT is ${bot}, an AI participant; its lines are context only.

People (use these labels, exactly):
${rosterText}

Lines marked [C…] are earlier context; lines marked [L…] are new. Cite ONLY [L…] ids of human lines as evidence — never BOT lines, never [C…] lines.

Already known (cite an id in "same_as" when a new item says the same thing, or in "replaces" when it updates/contradicts it):
${existingText}

Chat:
${log}

Return ONLY JSON:
{
  "facts": [{"subject": "P1", "category": "fact|event|temporary|interest|preference", "attribute": "job|location|home|relationship_status|birthday|education|health|travel|family|pet|vehicle|other", "content": "short third-person statement", "confidence": 0.0-1.0, "evidence": ["L3"], "expires_in_days": null, "same_as": null, "replaces": null}],
  "relationships": [{"a": "P1", "b": "P2", "type": "...", "description": "...", "strength": 0.0-1.0, "evidence": ["L4"]}],
  "inside_jokes": [{"content": "...", "evidence": ["L5", "L9"], "same_as": null}],
  "profiles": [{"person": "P1", "summary": "one line", "traits": ["..."], "interests": ["..."], "evidence": ["L2"]}],
  "nicknames": [{"person": "P2", "nickname": "...", "used_by": "P1", "evidence": ["L8"]}]${isGroup ? `,
  "slang": [{"term": "...", "meaning": "...", "example": "L7"}],
  "group_vibe": "one sentence describing the group's personality"` : ''}
}

Rules:
- Subjects/people must be labels from the list above. If you can't tell who it is, leave the item out.
- Only things a human clearly stated or confirmed. Not greetings, wishes ("happy bday da"), passing moods ("I'm a bit tired"), jokes taken literally, hypotheticals or mere mentions of a topic.
- Facts about someone other than the speaker are fine when the speaker clearly states them.
- Write content in plain words with the person's name, never a label, phone number or @mention.
- "temporary" is for things that stop being true soon (sick, travelling, exams) — give expires_in_days.
- Nicknames: only names the HUMANS actually use for each other. Anything BOT says is not evidence. A word someone uses about themselves ("I'm done", "working") is not a nickname.
- Leave a list empty rather than guess.`;
}

function parseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/**
 * Analyse a chat's new messages and persist what was learned with provenance.
 * `chat` is a learning_state key (see chatKeyOf). Returns a counts summary, or null
 * when nothing ran / the model failed (last_batch_rowid is only advanced on success).
 */
export async function runBatchAnalysis(chat) {
  const db = getDb();
  const isGroup = isGroupJid(chat);
  if (!isGroup && (!isPersonJid(chat) || isSelfJid(chat))) return null;
  const origin = { kind: isGroup ? 'group' : 'dm', jid: chat };
  const forms = chatForms(chat);
  const inChat = `group_jid IN (${marks(forms.length)})`;

  const lastRowid = db.prepare('SELECT last_batch_rowid FROM learning_state WHERE chat_jid = ?').pluck().get(chat) ?? 0;
  const upTo = db.prepare(`SELECT MAX(rowid) FROM messages WHERE ${inChat}`).pluck().get(...forms) ?? 0;
  if (upTo <= lastRowid) return null;

  // Oldest pending lines first. A full window (more pending than MAX_NEW_LINES) only
  // advances to its last line and leaves the counter at the threshold, so the next
  // message runs a follow-up batch over the rest: no line is skipped for good.
  const fresh = db.prepare(`SELECT ${LINE_COLS} FROM messages WHERE ${inChat} AND rowid > ? AND rowid <= ? AND ${ELIGIBLE}
    ORDER BY rowid ASC LIMIT ?`).all(...forms, lastRowid, upTo, MAX_NEW_LINES);
  const truncated = fresh.length === MAX_NEW_LINES && fresh.at(-1).rid < upTo;
  const advanceTo = truncated ? fresh.at(-1).rid : upTo;
  const pendingCount = truncated ? (isGroup ? GROUP_THRESHOLD : DM_THRESHOLD) : 0;
  const advance = () => db.prepare(`INSERT INTO learning_state (chat_jid, msgs_since_batch, last_batch_rowid, last_batch_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(chat_jid) DO UPDATE SET last_batch_rowid = MAX(last_batch_rowid, excluded.last_batch_rowid),
    last_batch_at = excluded.last_batch_at,
    msgs_since_batch = MAX(msgs_since_batch, excluded.msgs_since_batch)`).run(chat, pendingCount, advanceTo, nowSec());
  const firstNew = fresh.length ? fresh[0].rid : upTo + 1;
  const context = db.prepare(`SELECT ${LINE_COLS} FROM messages WHERE ${inChat} AND rowid < ? AND ${ELIGIBLE}
    ORDER BY rowid DESC LIMIT ?`).all(...forms, firstNew, CONTEXT_LINES).reverse();

  const isBot = (r) => !!r.is_from_self || isSelfJid(r.sender_jid);
  const humanNew = fresh.filter(r => !isBot(r) && lineText(r));
  if (humanNew.length < MIN_HUMAN_LINES[origin.kind]) {
    // Nothing learnable (all fenced / bot / media), or a full window that can't grow.
    if (!fresh.length || humanNew.length === 0 || truncated) advance();
    return null;
  }

  const roster = buildRoster(db, chat, isGroup, [...context, ...fresh]);
  const labelOf = (r) => {
    if (isBot(r)) return 'BOT';
    return roster.byPerson.get(resolvePerson(r.sender_jid) || bareJid(r.sender_jid))?.label || 'unknown';
  };

  // Line ids: C1… context, L1… new. Only new human lines are acceptable evidence.
  const lines = [];
  const evidenceById = new Map();
  context.forEach((r, i) => { const t = lineText(r); if (t) lines.push({ id: `C${i + 1}`, speaker: labelOf(r), text: t, bot: isBot(r) }); });
  fresh.forEach((r, i) => {
    const t = lineText(r);
    if (!t) return;
    const id = `L${i + 1}`;
    lines.push({ id, speaker: labelOf(r), text: t, bot: isBot(r) });
    if (!isBot(r)) evidenceById.set(id, { msgId: r.id, ts: r.timestamp, text: t });
  });

  // Same-origin current items only: another chat's items must never enter this
  // chat's analysis (they'd be laundered into this origin).
  const subjects = [...roster.byPerson.keys()];
  const existing = subjects.length ? db.prepare(`SELECT id, category, subject_jid, attribute, content FROM memories
      WHERE origin_jid = ? AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)
        AND (subject_jid IN (${marks(subjects.length)}) OR (subject_jid IS NULL AND category = 'lore'))
      ORDER BY COALESCE(learned_at, created_at) DESC LIMIT ?`).all(chat, nowSec(), ...subjects, MAX_EXISTING)
    .map(e => ({ ...e, content: sanitizeWebContent(e.content).slice(0, 160),
      subjectLabel: e.subject_jid ? roster.byPerson.get(e.subject_jid)?.label : null }))
    : [];
  const existingIds = new Map(existing.map(e => [`M${e.id}`, e]));

  const prompt = buildPrompt({ isGroup, roster, lines, existing });
  logger.info({ kind: origin.kind, lines: lines.length, people: roster.byLabel.size }, 'Running batched LLM analysis');

  let data = null;
  try {
    const response = await llm(
      'You are a careful social analyst. Extract structured data from chat logs. Return ONLY valid JSON, no markdown.',
      prompt,
      { role: 'clerk', caller: 'batch', temperature: 0.2 },
    );
    data = parseJson(response);
  } catch (err) {
    logger.warn({ err: err.message }, 'Batch analysis LLM call failed');
  }
  if (!data) { logger.warn({ kind: origin.kind }, 'Batch analysis returned no usable JSON'); return null; }

  const counts = persistBatch(db, data, { origin, isGroup, roster, evidenceById, existingIds, firstTs: humanNew[0].timestamp });
  advance();
  logger.info({ kind: origin.kind, ...counts }, 'Batch analysis complete');
  return counts;
}

// ── Persisting one batch's output ────────────────────────────────────────────

function persistBatch(db, data, ctx) {
  const { origin, isGroup, roster } = ctx;
  const counts = { facts: 0, merged: 0, superseded: 0, relationships: 0, lore: 0, profiles: 0, nicknames: 0, slang: 0, dropped: 0 };
  const person = (label) => (typeof label === 'string' ? roster.byLabel.get(label.trim().toUpperCase()) : null) || null;
  const names = new Map([...roster.byLabel.values()].map(v => [v.label, v.name]));
  // Labels → names, markers/@digits stripped, one line, capped.
  const text = (s, max) => {
    const t = sanitizeWebContent(String(s ?? '').replace(/\bP(\d{1,3})\b/g, (m) => names.get(m) || 'someone'))
      .replace(/\s+/g, ' ').trim();
    return t.slice(0, max);
  };
  const evidence = (ids) => {
    const list = (Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [])
      .map(id => ctx.evidenceById.get(String(id).trim().toUpperCase())).filter(Boolean);
    return [...new Map(list.map(e => [e.msgId, { msgId: e.msgId, ts: e.ts }])).values()];
  };
  const existingId = (ref) => {
    const e = ref != null ? ctx.existingIds.get(String(ref).trim().toUpperCase()) : null;
    return e ? e.id : null;
  };
  const each = (list, fn) => {
    for (const item of Array.isArray(list) ? list.slice(0, 60) : []) {
      try { if (fn(item || {}) === false) counts.dropped++; } catch (err) {
        counts.dropped++;
        logger.debug({ err: err.message }, 'batch item skipped');
      }
    }
  };
  const store = (fields, ev, sameAs) => {
    const same = existingId(sameAs);
    if (same && reobserveMemory(same, origin.jid, fields.subjectJid ?? null, ev)) { counts.merged++; return true; }
    const r = addMemory({ ...fields, originKind: origin.kind, originJid: origin.jid, source: 'batch', evidence: ev });
    if (!r?.id) return false;
    if (r.merged) counts.merged++;
    if (r.superseded) counts.superseded++;
    return true;
  };

  each(data.facts ?? data.people_facts, (f) => {
    const p = person(f.subject ?? f.name);
    const ev = evidence(f.evidence);
    const content = text(f.content ?? f.fact, 300);
    const confidence = clamp01(f.confidence, 0.6);
    if (!p || !ev.length || content.length < 6 || confidence < MIN_CONFIDENCE) return false;
    const category = FACT_CATEGORIES.has(f.category) ? f.category : 'fact';
    const attribute = typeof f.attribute === 'string' && /^[a-z_]{2,30}$/.test(f.attribute.trim().toLowerCase())
      ? f.attribute.trim().toLowerCase() : 'other';
    let expiresInDays = Number.isFinite(Number(f.expires_in_days)) && f.expires_in_days != null ? Number(f.expires_in_days) : null;
    if (category === 'temporary') expiresInDays = Math.max(1, Math.min(expiresInDays ?? 7, 60));
    const replaces = existingId(f.replaces);
    const ok = store({ category, subjectJid: p.person, content, importance: clamp01(f.importance, confidence),
      attribute, expiresInDays, replaces }, ev, f.same_as);
    if (ok) counts.facts++;
    return ok;
  });

  each(data.inside_jokes ?? data.lore, (j) => {
    const item = typeof j === 'string' ? { content: j } : j;
    const ev = evidence(item.evidence);
    const content = text(item.content, 300);
    if (!ev.length || content.length < 6) return false;
    const ok = store({ category: 'lore', subjectJid: null, content, importance: 0.5,
      replaces: existingId(item.replaces) }, ev, item.same_as);
    if (ok) counts.lore++;
    return ok;
  });

  each(data.relationships, (r) => {
    const a = person(r.a ?? r.person_a);
    const b = person(r.b ?? r.person_b);
    const ev = evidence(r.evidence);
    if (!a || !b || a.person === b.person || !ev.length) return false;
    const res = upsertRelationship(a.person, b.person, origin.kind, origin.jid, text(r.type ?? r.relationship, 60) || null,
      text(r.description ?? r.dynamic, 200) || null, clamp01(r.strength, 0.5), { evidence: ev });
    if (!res) return false;
    counts.relationships++;
    return true;
  });

  each(data.profiles, (pr) => {
    const p = person(pr.person);
    const ev = evidence(pr.evidence);
    if (!p || !ev.length) return false;
    const list = (v) => (Array.isArray(v) ? v : []).map(x => text(x, 40)).filter(x => x.length >= 2).slice(0, 8);
    const facet = { summary: text(pr.summary, 200) || undefined, traits: list(pr.traits), interests: list(pr.interests) };
    if (!facet.summary && !facet.traits.length && !facet.interests.length) return false;
    if (writeFacet(p.person, origin.kind, origin.jid, facet, ev) == null) return false;
    counts.profiles++;
    return true;
  });

  const botAliases = [getPersona().name, ...(getPersona().aliases || [])].filter(Boolean).map(a => String(a).toLowerCase());
  each(data.nicknames, (n) => {
    const p = person(n.person);
    const nick = String(n.nickname ?? '').trim().toLowerCase();
    const usedByRaw = String(n.used_by ?? '').trim();
    // Never learn a name from the bot's own usage (it would feed back into the prompt).
    if (/^bot$/i.test(usedByRaw) || botAliases.some(a => a && usedByRaw.toLowerCase().includes(a))) return false;
    const usedBy = person(usedByRaw);
    const ev = evidence(n.evidence);
    if (!p || !ev.length || !/^[\p{L}][\p{L}\p{N} .'-]{1,19}$/u.test(nick) || COMMON_WORDS.has(nick)) return false;
    if (nick === p.name.toLowerCase()) return false;
    if (writeNickname(p.person, nick, origin.kind, origin.jid, usedBy?.person || null, 0.4, 'batch_llm', ev) == null) return false;
    counts.nicknames++;
    return true;
  });

  if (isGroup) {
    each(data.slang, (s) => {
      const term = text(s.term, 40);
      const meaning = text(s.meaning, 200);
      if (!term || !meaning) return false;
      const refs = [s.example ?? s.evidence].flat().filter(x => x != null);
      const ev = evidence(refs);
      // The example is the cited line's own text (content: it stays in this chat).
      const example = refs.length ? ctx.evidenceById.get(String(refs[0]).trim().toUpperCase())?.text : null;
      // The cited lines must still exist and not be fenced: a batch read before a
      // revoke / "forget that" must not write from them afterwards (R11, R15).
      if (!evidenceLive(getDb(), ev)) return false;
      const res = upsertSlang(term, meaning, origin.kind, origin.jid, example || null);
      if (!res) return false;
      addEvidence('slang', res.id, ev);
      counts.slang++;
      return true;
    });
    const vibe = typeof data.group_vibe === 'string' ? text(data.group_vibe, 200) : '';
    if (vibe) { try { learnVibe(origin.jid, vibe); } catch (err) { logger.debug({ err: err.message }, 'vibe update failed'); } }
  }
  return counts;
}

/** Test/diagnostic: wait for any running batch of a chat. */
export function __pendingBatch(chat) {
  return inflight.get(chat) || null;
}

// ── Common words set (to filter false positives) ──

const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'is', 'it', 'this', 'that', 'was', 'are', 'be', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should',
  'not', 'no', 'yes', 'ok', 'okay', 'yeah', 'yep', 'nah', 'nope',
  'what', 'who', 'how', 'why', 'when', 'where', 'which',
  'i', 'me', 'my', 'we', 'us', 'you', 'your', 'he', 'she', 'they',
  'him', 'her', 'his', 'its', 'our', 'their', 'them',
  'just', 'also', 'very', 'too', 'so', 'if', 'then', 'than', 'more',
  'some', 'any', 'all', 'each', 'every', 'both', 'few', 'many', 'much',
  'lol', 'lmao', 'bro', 'bruh', 'dude', 'man', 'like', 'got', 'get',
  'know', 'think', 'want', 'need', 'see', 'come', 'go', 'say', 'said',
  'one', 'two', 'first', 'new', 'good', 'bad', 'big', 'old', 'right',
  'well', 'still', 'after', 'before', 'now', 'here', 'there', 'only',
  'about', 'with', 'from', 'been', 'were', 'being', 'other', 'into',
  'over', 'down', 'out', 'up', 'off', 'way', 'day', 'time', 'back',
  'even', 'make', 'take', 'let', 'put', 'give', 'tell', 'call',
]);
