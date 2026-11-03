import crypto from 'crypto';

// Dedupe key for a memory item (spec 006, R9). Shared by the v5 backfill and the
// runtime addMemory so old and new rows collide on the partial unique index
// memories(fingerprint) WHERE superseded_by IS NULL.
//
// Scope is part of the key: the same sentence learned in two chats is two items
// (two origins, two audiences), never one. Category is not: a "fact" and an
// "interest" with the same text are the same claim.
//
//   sha256( originJid \n subjectJid|'' \n normalizeForFingerprint(content) ) → first 32 hex chars

export function normalizeForFingerprint(content) {
  return String(content ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Content-only key for "forget that" tombstones (v6): matched together with the
// tombstone's origin_jid, which identity merges re-key. Never stores the text.
export function contentKey(content) {
  return crypto.createHash('sha256').update(normalizeForFingerprint(content)).digest('hex').slice(0, 32);
}

export function memoryFingerprint({ originJid, subjectJid, content }) {
  const key = `${originJid ?? ''}\n${subjectJid ?? ''}\n${normalizeForFingerprint(content)}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}
