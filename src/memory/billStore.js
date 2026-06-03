import { getDb } from './db.js';

const INSERT_BILL = `INSERT INTO bill_splits
  (group_jid, image_msg_id, restaurant, bill_json, people_json, assignments_json, state, initiator_jid, participant_jids_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const GET_BILL = `SELECT * FROM bill_splits WHERE id = ?`;

const GET_ACTIVE_BILL = `SELECT * FROM bill_splits
  WHERE group_jid = ? AND state = 'ACTIVE' AND updated_at > ?
  ORDER BY updated_at DESC LIMIT 1`;

const GET_BILL_BY_IMAGE = `SELECT * FROM bill_splits
  WHERE image_msg_id = ? ORDER BY created_at DESC LIMIT 1`;

const GET_RECENT_PARSED = `SELECT * FROM bill_splits
  WHERE group_jid = ? AND state = 'PARSED' AND created_at > ?
  ORDER BY created_at DESC LIMIT ?`;

const UPDATE_STATE = `UPDATE bill_splits
  SET state = ?, updated_at = unixepoch()
  WHERE id = ?`;

const UPDATE_PROGRESS = `UPDATE bill_splits
  SET people_json = ?, assignments_json = ?, participant_jids_json = ?, updated_at = unixepoch()
  WHERE id = ?`;

const COMPLETE_BILL = `UPDATE bill_splits
  SET state = 'COMPLETED', people_json = ?, assignments_json = ?,
      completed_at = unixepoch(), updated_at = unixepoch()
  WHERE id = ?`;

const CANCEL_BILL = `UPDATE bill_splits
  SET state = 'CANCELLED', updated_at = unixepoch()
  WHERE id = ?`;

const EXPIRE_STALE = `UPDATE bill_splits
  SET state = 'EXPIRED'
  WHERE state = 'ACTIVE' AND updated_at < ?`;

const EXPIRE_ALL_ACTIVE = `UPDATE bill_splits
  SET state = 'EXPIRED', updated_at = unixepoch()
  WHERE state = 'ACTIVE'`;

function hydrateRow(row) {
  if (!row) return null;
  return {
    ...row,
    bill: JSON.parse(row.bill_json),
    people: JSON.parse(row.people_json || '[]'),
    assignments: JSON.parse(row.assignments_json || '[]'),
    participantJids: JSON.parse(row.participant_jids_json || '[]'),
  };
}

export function createBillSplit(groupJid, imageMsgId, restaurant, bill, state = 'PARSED', initiatorJid = null) {
  const db = getDb();
  const result = db.prepare(INSERT_BILL).run(
    groupJid,
    imageMsgId || null,
    restaurant || null,
    JSON.stringify(bill),
    '[]',
    '[]',
    state,
    initiatorJid,
    initiatorJid ? JSON.stringify([initiatorJid]) : '[]',
  );
  return result.lastInsertRowid;
}

export function getBillSplit(id) {
  const db = getDb();
  return hydrateRow(db.prepare(GET_BILL).get(id));
}

export function getActiveBill(groupJid) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 2 * 60 * 60; // 2 hours
  return hydrateRow(db.prepare(GET_ACTIVE_BILL).get(groupJid, cutoff));
}

export function getBillByImage(imageMsgId) {
  if (!imageMsgId) return null;
  const db = getDb();
  return hydrateRow(db.prepare(GET_BILL_BY_IMAGE).get(imageMsgId));
}

export function getRecentParsedBills(groupJid, limit = 3) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 60; // 30 minutes
  return db.prepare(GET_RECENT_PARSED).all(groupJid, cutoff, limit).map(hydrateRow);
}

export function updateBillState(id, state) {
  const db = getDb();
  return db.prepare(UPDATE_STATE).run(state, id);
}

export function updateFlowProgress(id, people, assignments, participantJids) {
  const db = getDb();
  return db.prepare(UPDATE_PROGRESS).run(
    JSON.stringify(people || []),
    JSON.stringify(assignments || []),
    JSON.stringify(participantJids || []),
    id,
  );
}

export function completeBill(id, people, assignments) {
  const db = getDb();
  return db.prepare(COMPLETE_BILL).run(
    JSON.stringify(people || []),
    JSON.stringify(assignments || []),
    id,
  );
}

export function cancelBill(id) {
  const db = getDb();
  return db.prepare(CANCEL_BILL).run(id);
}

export function expireStaleBills(maxAgeSec = 7200) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  return db.prepare(EXPIRE_STALE).run(cutoff);
}

export function expireAllActiveBills() {
  const db = getDb();
  return db.prepare(EXPIRE_ALL_ACTIVE).run();
}
