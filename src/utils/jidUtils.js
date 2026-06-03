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
 * "919876543210@s.whatsapp.net" → "919876543210"
 * "919876543210:42@s.whatsapp.net" → "919876543210" (strips device suffix)
 */
export function phoneFromJid(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

/**
 * Check if a JID is a status broadcast.
 */
export function isStatusBroadcast(jid) {
  return jid === 'status@broadcast';
}
