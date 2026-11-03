// v1 — provenance columns (spec 006 data-model). ALTERs first, then the indexes
// on the new columns, in the same step.

import { addColumn } from './util.js';

export default {
  version: 1,
  name: 'provenance',
  up(db) {
    for (const [col, type] of [
      ['origin_kind', 'TEXT'],
      ['origin_jid', 'TEXT'],
      ['learned_at', 'INTEGER'],
      ['attribute', 'TEXT'],
      ['fingerprint', 'TEXT'],
      ['source', 'TEXT'],
      ['superseded_by', 'INTEGER'],
      ['superseded_at', 'INTEGER'],
      ['last_recalled_at', 'INTEGER'],
      ['visibility', 'TEXT'],
    ]) addColumn(db, 'memories', col, type);

    addColumn(db, 'messages', 'no_learn', 'INTEGER DEFAULT 0');
    addColumn(db, 'messages', 'expires_at', 'INTEGER');
    addColumn(db, 'groups', 'members_synced_at', 'INTEGER');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mem_origin ON memories(origin_jid, learned_at);
      CREATE INDEX IF NOT EXISTS idx_mem_subject_attr ON memories(subject_jid, attribute);
    `);
  },
};
