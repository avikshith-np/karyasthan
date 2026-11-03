import { getDb } from './db.js';

// Call history for the phone-call bridge (src/calls/). One row per call attempt plus
// its transcript lines; the live state is in callManager, this is the durable record.

export function createCall({ direction, context, personJid = null, groupJid = null, phone = null, model = null, initiatedBy = null, status = 'dialing' }) {
  const info = getDb().prepare(`
    INSERT INTO calls (direction, context, person_jid, group_jid, phone, model, initiated_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(direction, context, personJid, groupJid, phone, model, initiatedBy, status);
  return Number(info.lastInsertRowid);
}

export function setCallStatus(id, status) {
  getDb().prepare('UPDATE calls SET status = ? WHERE id = ?').run(status, id);
}

export function markCallAnswered(id) {
  getDb().prepare("UPDATE calls SET status = 'active', answered_at = unixepoch() WHERE id = ?").run(id);
}

export function endCall(id, status, reason) {
  getDb().prepare('UPDATE calls SET status = ?, end_reason = ?, ended_at = unixepoch() WHERE id = ? AND ended_at IS NULL')
    .run(status, reason, id);
}

export function setCallSummary(id, summary) {
  getDb().prepare('UPDATE calls SET summary = ? WHERE id = ?').run(summary, id);
}

export function addTranscriptLine(callId, speaker, text) {
  getDb().prepare('INSERT INTO call_transcript (call_id, speaker, text) VALUES (?, ?, ?)').run(callId, speaker, text);
}

export function getCall(id) {
  return getDb().prepare('SELECT * FROM calls WHERE id = ?').get(id);
}

export function getTranscript(callId) {
  return getDb().prepare('SELECT speaker, text, ts FROM call_transcript WHERE call_id = ? ORDER BY id').all(callId);
}

export function listCalls({ personJid, groupJid, limit = 20 } = {}) {
  const db = getDb();
  if (groupJid) return db.prepare('SELECT * FROM calls WHERE group_jid = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(groupJid, limit);
  if (personJid) return db.prepare("SELECT * FROM calls WHERE person_jid = ? AND context != 'group' ORDER BY started_at DESC, id DESC LIMIT ?").all(personJid, limit);
  return db.prepare('SELECT * FROM calls ORDER BY started_at DESC, id DESC LIMIT ?').all(limit);
}

/** Calls left non-final by a crash/restart are closed on boot. */
export function closeStaleCalls() {
  return getDb().prepare("UPDATE calls SET status = 'failed', end_reason = 'process restarted', ended_at = unixepoch() WHERE ended_at IS NULL").run().changes;
}
