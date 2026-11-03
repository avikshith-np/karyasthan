import { getDb } from './db.js';

// person_voice — one cloned (Voice Replication) voice per person, created only from
// their own recordings + consent statement (src/brain/voiceClone.js). Rows are kept
// after revocation (revoked_at set) so enrollments stay auditable.

/**
 * A person's voice row. By default only an ACTIVE voice (not revoked, not expired);
 * `includeInactive` returns the row regardless.
 */
export function getPersonVoice(personJid, { includeInactive = false } = {}) {
  const row = getDb().prepare(`SELECT * FROM person_voice WHERE person_jid = ?`).get(personJid);
  if (!row || includeInactive) return row || null;
  if (row.revoked_at) return null;
  if (row.expire_time && row.expire_time < Math.floor(Date.now() / 1000)) return null;
  return row;
}

export function savePersonVoice({ personJid, voiceId, languageCode, consentRef, via, expireTime }) {
  getDb().prepare(`
    INSERT INTO person_voice (person_jid, voice_id, language_code, consent_ref, enrolled_via, expire_time, created_at, revoked_at, revoke_reason)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch(), NULL, NULL)
    ON CONFLICT(person_jid) DO UPDATE SET
      voice_id = excluded.voice_id, language_code = excluded.language_code,
      consent_ref = excluded.consent_ref, enrolled_via = excluded.enrolled_via,
      expire_time = excluded.expire_time, created_at = unixepoch(),
      revoked_at = NULL, revoke_reason = NULL
  `).run(personJid, voiceId, languageCode || null, consentRef || null, via || null, expireTime || null);
}

// A revoked voice whose delete at Google hasn't gone through yet carries this
// suffix on revoke_reason (shown as is on the person page). The 6-hourly
// maintenance retries every such row (voiceClone.retryPendingVoiceDeletes).
export const DELETE_PENDING_SUFFIX = ' · Google delete pending';
const PENDING_LIKE = `%${DELETE_PENDING_SUFFIX}`;
// A purge's revoke: the row itself goes once Google has deleted the voice.
export const PURGE_REASON = 'purge';

export function revokePersonVoice(personJid, reason = null, { pendingDelete = false } = {}) {
  const r = reason == null && !pendingDelete ? null : `${reason ?? 'revoked'}${pendingDelete ? DELETE_PENDING_SUFFIX : ''}`;
  getDb().prepare(`UPDATE person_voice SET revoked_at = unixepoch(), revoke_reason = ? WHERE person_jid = ? AND revoked_at IS NULL`)
    .run(r, personJid);
}

export function isVoiceDeletePending(row) {
  return !!row?.revoked_at && typeof row.revoke_reason === 'string' && row.revoke_reason.endsWith(DELETE_PENDING_SUFFIX);
}

/** The reason without the pending suffix. */
export function voiceRevokeReason(row) {
  const r = row?.revoke_reason ?? null;
  return isVoiceDeletePending(row) ? r.slice(0, -DELETE_PENDING_SUFFIX.length) : r;
}

/** Revoked voices still to be deleted at Google, oldest revoke first. */
export function listPendingVoiceDeletes() {
  return getDb().prepare(`SELECT * FROM person_voice WHERE revoked_at IS NOT NULL AND revoke_reason LIKE ?
    ORDER BY revoked_at`).all(PENDING_LIKE);
}

/**
 * Google confirmed the delete (or the voice was already gone). A purged person's
 * row is removed; any other row stays, revoked, for the enrollment audit trail.
 */
export function settleVoiceDelete(personJid, voiceId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM person_voice WHERE person_jid = ? AND voice_id = ?').get(personJid, voiceId);
  if (!row || !isVoiceDeletePending(row)) return false;
  if (voiceRevokeReason(row) === PURGE_REASON) {
    db.prepare('DELETE FROM person_voice WHERE person_jid = ? AND voice_id = ?').run(personJid, voiceId);
  } else {
    db.prepare('UPDATE person_voice SET revoke_reason = ? WHERE person_jid = ? AND voice_id = ?')
      .run(voiceRevokeReason(row), personJid, voiceId);
  }
  return true;
}

/**
 * purgePerson (inside its transaction, DB only): every voice row of these identity
 * forms is revoked at once (never active again). A voice that may still exist at
 * Google is marked for a delete there — the caller fires retryPendingVoiceDeletes
 * after the commit, and the 6-hourly maintenance retries; a row already deleted at
 * Google goes now. Returns how many rows await the Google delete.
 */
export function revokeVoicesForPurge(db, forms) {
  if (!forms.length) return 0;
  const marks = forms.map(() => '?').join(',');
  db.prepare(`DELETE FROM person_voice WHERE person_jid IN (${marks}) AND revoked_at IS NOT NULL
    AND (revoke_reason IS NULL OR revoke_reason NOT LIKE ?)`).run(...forms, PENDING_LIKE);
  return db.prepare(`UPDATE person_voice SET revoked_at = COALESCE(revoked_at, unixepoch()), revoke_reason = ?
    WHERE person_jid IN (${marks})`).run(`${PURGE_REASON}${DELETE_PENDING_SUFFIX}`, ...forms).changes;
}

/** Active voices whose owner is no longer in ANY group the bot knows. */
export function listOrphanedVoices() {
  return getDb().prepare(`
    SELECT pv.* FROM person_voice pv
    WHERE pv.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.person_jid = pv.person_jid)
  `).all();
}
