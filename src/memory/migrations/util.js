// Small helpers shared by ladder steps. Identifiers here are compile-time
// constants from the step files, never user input.

export function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

export function addColumn(db, table, col, type) {
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// Strip a WhatsApp device suffix: "9198…:12@s.whatsapp.net" → "9198…@s.whatsapp.net".
export function bareJid(jid) {
  if (!jid) return jid;
  return String(jid).replace(/:\d+(?=@)/, '');
}
