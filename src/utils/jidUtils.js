/**
 * Check if a JID is a group chat.
 * Group JIDs end with @g.us, individual JIDs end with @s.whatsapp.net
 */
export function isGroupJid(jid) {
  return jid?.endsWith('@g.us') ?? false;
}

/**
 * Check if a JID is a direct message (1:1 chat).
 * Handles both regular JIDs (@s.whatsapp.net) and LID JIDs (@lid)
 */
export function isDmJid(jid) {
  if (!jid) return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

/**
 * Extract phone number from a JID.
 * "15550100123@s.whatsapp.net" → "15550100123"
 * "15550100123:42@s.whatsapp.net" → "15550100123" (strips device suffix)
 */
export function phoneFromJid(jid) {
  // Defensive: Baileys sometimes hands objects where a JID string is expected
  // (e.g. participant entries) — never throw from a hot event path.
  if (!jid || typeof jid !== 'string') return null;
  return jid.split('@')[0].split(':')[0];
}

/**
 * Check if a JID is a status broadcast.
 */
export function isStatusBroadcast(jid) {
  return jid === 'status@broadcast';
}
