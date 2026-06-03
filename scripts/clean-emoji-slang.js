// One-shot cleanup: delete emoji rows from the slang table.
// Emojis were mistakenly being learned as group slang and re-injected into the
// system prompt as "use these naturally", causing per-group emoji over-use.
// After this runs, the trackSlang() emoji filter prevents re-entry.

import { getDb, runMigrations } from '../src/memory/db.js';
import { hasEmoji } from '../src/utils/emoji.js';

runMigrations();
const db = getDb();

const groupFilter = process.argv[2];
const where = groupFilter ? 'WHERE group_jid = ?' : '';
const params = groupFilter ? [groupFilter] : [];

const rows = db.prepare(`SELECT id, term, group_jid, use_count FROM slang ${where}`).all(...params);
const emojiRows = rows.filter(r => hasEmoji(r.term));

if (emojiRows.length === 0) {
  console.log(`No emoji slang rows found${groupFilter ? ` for group ${groupFilter}` : ''}.`);
  process.exit(0);
}

console.log(`Found ${emojiRows.length} emoji slang rows to delete:\n`);
for (const r of emojiRows) {
  console.log(`  [${r.id}] "${r.term}" group=${r.group_jid || '(global)'} use_count=${r.use_count}`);
}

const del = db.prepare('DELETE FROM slang WHERE id = ?');
const tx = db.transaction(items => { for (const r of items) del.run(r.id); });
tx(emojiRows);

console.log(`\nDeleted ${emojiRows.length} rows.`);
