import { getDb } from '../memory/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { getPersonVoice } from '../memory/voiceStore.js';
import { isSkillEnabled } from '../skills/skillRunner.js';

// In-memory cache of active imitation targets, keyed by group_jid.
// Mirrors the muted-groups pattern (src/dashboard/state.js): synced with DB on
// boot, authoritative afterwards because all writes go through here.
//
// Unlike mute, `active_until` is ALWAYS set — impersonating a real person must
// never run indefinitely. Rows lazily expire on read, and the target's group
// membership is re-validated at read time (single source of truth: group_members)
// so imitation auto-clears if the person leaves the group.
const imitationCache = new Map(); // group_jid → { targetJid, label, activeUntil, enabledAt, useVoice, voiceNotesSent }
let loaded = false;

export function loadImitationModes() {
  try {
    const rows = getDb().prepare(`SELECT group_jid, target_jid, target_label, active_until, enabled_at, use_voice, voice_notes_sent FROM group_imitation`).all();
    imitationCache.clear();
    const now = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      if (r.active_until && r.active_until < now) {
        // Purge stale rows so an expired impersonation never lingers in the DB.
        try { getDb().prepare(`DELETE FROM group_imitation WHERE group_jid = ?`).run(r.group_jid); } catch {}
        continue;
      }
      // enabledAt marks the takeover moment: transcript lines the bot sent BEFORE
      // it are base-persona voice and must not be attributed to the target.
      imitationCache.set(r.group_jid, {
        targetJid: r.target_jid, label: r.target_label, activeUntil: r.active_until, enabledAt: r.enabled_at || null,
        useVoice: !!r.use_voice, voiceNotesSent: r.voice_notes_sent || 0,
      });
    }
    loaded = true;
    logger.info({ count: imitationCache.size }, 'Imitation targets loaded');
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to load group_imitation');
  }
}

function isCurrentMember(groupJid, personJid) {
  try {
    return !!getDb().prepare(
      `SELECT 1 FROM group_members WHERE group_jid = ? AND person_jid = ?`
    ).get(groupJid, personJid);
  } catch {
    return false;
  }
}

/**
 * Active imitation target for a group, or null. Lazily expires past-cutoff
 * targets and auto-clears targets who are no longer group members.
 */
export function getImitationTarget(groupJid) {
  if (!loaded) loadImitationModes(); // lazy-sync (e.g. dashboard-only smoke boot)
  const entry = imitationCache.get(groupJid);
  if (!entry) return null;
  const now = Math.floor(Date.now() / 1000);
  if (entry.activeUntil < now) {
    clearImitationTarget(groupJid);
    logger.info({ groupJid }, 'Imitation target expired');
    return null;
  }
  if (!isCurrentMember(groupJid, entry.targetJid)) {
    clearImitationTarget(groupJid);
    logger.info({ groupJid, targetJid: entry.targetJid }, 'Imitation target left the group — cleared');
    return null;
  }
  return entry;
}

export function setImitationTarget(groupJid, { targetJid, label, durationMinutes, enabledBy, reason, useVoice = false }) {
  const activeUntil = Math.floor(Date.now() / 1000) + Math.max(1, durationMinutes) * 60;
  // A new activation starts a new voice session: the per-session cap resets.
  getDb().prepare(
    `INSERT INTO group_imitation (group_jid, target_jid, target_label, active_until, enabled_by, reason, use_voice, voice_notes_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(group_jid) DO UPDATE SET
       target_jid = excluded.target_jid, target_label = excluded.target_label,
       active_until = excluded.active_until, enabled_by = excluded.enabled_by,
       reason = excluded.reason, enabled_at = unixepoch(),
       use_voice = excluded.use_voice, voice_notes_sent = 0`
  ).run(groupJid, targetJid, label || null, activeUntil, enabledBy || null, reason || null, useVoice ? 1 : 0);
  const entry = { targetJid, label: label || null, activeUntil, enabledAt: Math.floor(Date.now() / 1000), useVoice: !!useVoice, voiceNotesSent: 0 };
  imitationCache.set(groupJid, entry);
  loaded = true; // a write makes the cache authoritative
  return entry;
}

/** Turn cloned-voice notes on/off for the group's active imitation. */
export function setImitationVoice(groupJid, useVoice) {
  const entry = getImitationTarget(groupJid);
  if (!entry) return null;
  getDb().prepare(`UPDATE group_imitation SET use_voice = ? WHERE group_jid = ?`).run(useVoice ? 1 : 0, groupJid);
  entry.useVoice = !!useVoice;
  return entry;
}

/**
 * Cloned-voice settings for an active imitation target, or null. Every gate must
 * pass: the imitate-voice kill switch, the group's opt-in (use_voice), cap headroom
 * for this activation, and an active enrolled (consented) voice for the target.
 */
export function resolveImitationVoice(target) {
  if (!target?.useVoice || !isSkillEnabled('imitate-voice')) return null;
  // voiceMaxPerSession 0 = no per-session cap (the hourly VOICE_NOTE_MAX_PER_HOUR still applies).
  const max = config.imitate.voiceMaxPerSession;
  const remaining = max > 0 ? max - (target.voiceNotesSent || 0) : Infinity;
  if (remaining <= 0) return null;
  const pv = getPersonVoice(target.targetJid);
  return pv ? { voiceId: pv.voice_id, remaining } : null;
}

/** Count one cloned voice note against this activation's cap. */
export function recordImitationVoiceNote(groupJid) {
  const entry = imitationCache.get(groupJid);
  if (!entry) return;
  entry.voiceNotesSent = (entry.voiceNotesSent || 0) + 1;
  try {
    getDb().prepare(`UPDATE group_imitation SET voice_notes_sent = ? WHERE group_jid = ?`).run(entry.voiceNotesSent, groupJid);
  } catch (err) {
    logger.warn({ err: err.message, groupJid }, 'Failed to persist imitation voice count');
  }
}

export function clearImitationTarget(groupJid) {
  try {
    getDb().prepare(`DELETE FROM group_imitation WHERE group_jid = ?`).run(groupJid);
    imitationCache.delete(groupJid);
    return true;
  } catch (err) {
    logger.warn({ err: err.message, groupJid }, 'Failed to clear imitation target');
    return false;
  }
}
