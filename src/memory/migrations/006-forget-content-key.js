// v6 — "forget that" tombstones that survive identity merges (spec 006, R5/R11).
// A tombstone's fingerprint hashes (origin, subject, content); a merge or a recycled-
// number reassignment re-keys origins, after which a restated forgotten claim hashes
// differently and would be learned again. The forgotten memory is already deleted, so
// its fingerprint can't be recomputed: tombstones now also keep a content-only key
// (hash of the normalised text, never the text) next to origin_jid, and merges re-key
// origin_jid. Existing tombstones keep matching by exact fingerprint only.

import { addColumn } from './util.js';

export default {
  version: 6,
  name: 'forget-content-key',
  up(db) {
    addColumn(db, 'learning_exclusions', 'content_key', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_exclusions_content ON learning_exclusions(origin_jid, content_key)');
  },
};
