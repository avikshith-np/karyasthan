// The thought stream's table (plan 020 F2, story_thoughts). The only SQL on it, imported by the life
// facade alone. Never read by a prompt builder: thoughts are the dashboard's.
import { getDb } from '../memory/db.js';
import * as relationshipStore from '../memory/relationshipStore.js';

const q = (sql) => getDb().prepare(sql);
const RETENTION_DAYS = 180;        // like llm_usage; at most ~90 short rows a day, ~15k rows in all
const DAY = 86400;

function decode(r) {
  if (!r) return null;
  let evidence = [];
  let codes = null;
  try { evidence = JSON.parse(r.evidence_event_ids); } catch { evidence = []; }
  try { codes = r.codes_json ? JSON.parse(r.codes_json) : null; } catch { codes = null; }
  return {
    id: r.id, at: r.at, family: r.family, text: r.text, codes, originKind: r.origin_kind, originJid: r.origin_jid,
    evidence: Array.isArray(evidence) ? evidence.filter(Number.isSafeInteger) : [], asOf: r.as_of_event_id, cause: r.cause_code,
    dedupeKey: r.dedupe_key, phraseKey: r.phrase_key,
  };
}

/** One row. A dedupe key seen before is a no-op (a restart, a replay). → true when it was written. */
export function insertThought(t, createdAt) {
  return q(`INSERT OR IGNORE INTO story_thoughts (at, family, text, codes_json, origin_kind, origin_jid, evidence_event_ids, as_of_event_id, cause_code, dedupe_key, phrase_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    t.at, t.family, t.text, t.codes ? JSON.stringify(t.codes) : null, t.originKind ?? 'self', t.originJid ?? null,
    JSON.stringify(t.evidence ?? []), t.asOf ?? null, t.cause ?? null, t.dedupeKey ?? null, t.phraseKey ?? null, createdAt,
  ).changes === 1;
}

/** Thoughts of [from, to), oldest first. */
export function thoughtsBetween(from, to, limit = 500) {
  return q('SELECT * FROM story_thoughts WHERE at >= ? AND at < ? ORDER BY at, id LIMIT ?').all(from, to, limit).map(decode);
}

/** Thoughts since `from`, for the repeat memory and the rate. */
export function recentThoughts(from) {
  return q('SELECT * FROM story_thoughts WHERE at >= ? ORDER BY at, id').all(from).map(decode);
}

/** F3's real thoughts of [from, to), oldest first (kind real in codes_json; no column of their own). */
export function realThoughtsBetween(from, to, limit = 200) {
  return q(`SELECT * FROM story_thoughts WHERE at >= ? AND at < ? AND dedupe_key LIKE 'real:%' ORDER BY at, id LIMIT ?`).all(from, to, limit).map(decode).filter(isRealThought);
}

/** Is this row a real thought (F3)? Not the stream's: its memory, its rate and the site leave it out. */
export function isRealThought(t) {
  return t?.codes?.kind === 'real';
}

export function hasDedupeKey(key) {
  return !!q('SELECT 1 FROM story_thoughts WHERE dedupe_key = ?').get(key);
}

/** Remove every thought `isGone(row)` says has left his life. → how many. */
export function sweepThoughts(isGone) {
  const rows = q('SELECT id, at, evidence_event_ids, as_of_event_id FROM story_thoughts').all().map(decode);
  const del = q('DELETE FROM story_thoughts WHERE id = ?');
  let n = 0;
  for (const r of rows) if (isGone(r)) n += del.run(r.id).changes;
  return n;
}

/** A forget / revoke / edit in a chat: its thoughts from that moment on go. `forms` = the chat's JID forms. */
export function deleteFromChat(forms, sinceAt = 0) {
  const del = q('DELETE FROM story_thoughts WHERE origin_jid = ? AND at >= ?');
  let n = 0;
  for (const f of forms) n += del.run(f, sinceAt).changes;
  return n;
}

export function pruneThoughts(at) {
  return q('DELETE FROM story_thoughts WHERE at < ?').run(at - RETENTION_DAYS * DAY).changes;
}

// ── 006's deletions: a thought from a chat goes with what it came from ─────────
// Namespace import, used at call time (relationshipStore → life/index.js → here is a cycle, as in
// story/hooks.js). A forget, revoke or edit: that chat's thoughts from the message on (5 minutes of
// skew, like the mind's hooks). A failure never undoes the user's deletion, and the read and the tick
// still drop a thought whose evidence is gone. A purge: all of that person's, and errors propagate.
let hooked = false;
const CHAT_CAUSES = new Set(['forget', 'revoke', 'edit', 'owner']);
export function registerThoughtHooks({ logger = null } = {}) {
  if (hooked) return;
  try {
    if (typeof relationshipStore.onItemsDeleted === 'function') {
      relationshipStore.onItemsDeleted((db, evt) => {
        if (!CHAT_CAUSES.has(evt?.cause)) return;
        const forms = [...new Set([evt.chatJid, ...(Array.isArray(evt.chatForms) ? evt.chatForms : [])].filter(Boolean))];
        const since = Number.isFinite(evt.msgTs) ? evt.msgTs - 300 : 0;
        try { deleteFromChat(forms, since); } catch (err) { logger?.warn?.({ evt: 'issue', where: 'thoughts.hook', err: err?.code || err?.name || 'error' }, 'thoughts: deletion hook failed'); }
      });
    }
    if (typeof relationshipStore.onPersonPurged === 'function') {
      relationshipStore.onPersonPurged((db, person, forms) => {
        deleteFromChat([...new Set([person, ...(Array.isArray(forms) ? forms : [])].filter(Boolean))], 0);
      });
    }
    hooked = true;
  } catch { hooked = false; }
}
