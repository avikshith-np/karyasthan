// Public site (spec 013): the exporter's own tables (v13) and the two people
// reads it needs — the scrubber's list of real names and the opt-in lookup.
// No 006 memory table is read here (privacy import guard).

import crypto from 'crypto';
import { getDb } from '../memory/db.js';
import { resolvePerson } from '../memory/identity.js';

const nowSec = () => Math.floor(Date.now() / 1000);
export const DISPLAY_NAME_MAX = 40;

// ── state ─────────────────────────────────────────────────────────────────

export function getState(key, db = getDb()) {
  const v = db.prepare('SELECT value FROM public_state WHERE key = ?').pluck().get(key);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}

export function setState(key, value, db = getDb()) {
  db.prepare('INSERT INTO public_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

/** The install salt for public ids (random, created once). */
export function salt(db = getDb()) {
  let s = getState('salt', db);
  if (typeof s !== 'string' || s.length < 32) {
    s = crypto.randomBytes(16).toString('hex');
    setState('salt', s, db);
  }
  return s;
}

// ── people ────────────────────────────────────────────────────────────────

/** push_name / real_name of every known person (the scrubber's real-name list). Throws on a DB error. */
export function knownPeopleNames(db = getDb()) {
  return db.prepare('SELECT push_name, real_name FROM people WHERE push_name IS NOT NULL OR real_name IS NOT NULL').all()
    .flatMap((r) => [r.push_name, r.real_name]).filter((s) => typeof s === 'string' && s.trim());
}

/** Group subjects (the scrubber refuses them as phrases). Throws on a DB error. */
export function groupSubjects(db = getDb()) {
  return db.prepare('SELECT name FROM groups WHERE name IS NOT NULL').pluck().all().filter((s) => typeof s === 'string' && s.trim());
}

export function cleanDisplayName(name) {
  if (typeof name !== 'string') return null;
  const s = name.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[^\p{L}\p{M}' .-]/gu, '').replace(/\s+/g, ' ').trim();
  return s && s.length <= DISPLAY_NAME_MAX ? s : null;
}

/** Opt-in rows (dashboard). */
export function listPeople(db = getDb()) {
  return db.prepare('SELECT person_jid AS personJid, public_id AS publicId, display_name AS displayName, opted_in AS optedIn, updated_at AS updatedAt FROM public_people ORDER BY display_name').all()
    .map((r) => ({ ...r, optedIn: r.optedIn === 1 }));
}

export function getPerson(personJid, db = getDb()) {
  const canon = resolvePerson(personJid) ?? personJid;
  const r = db.prepare('SELECT person_jid AS personJid, public_id AS publicId, display_name AS displayName, opted_in AS optedIn FROM public_people WHERE person_jid = ?').get(canon);
  return r ? { ...r, optedIn: r.optedIn === 1 } : null;
}

/**
 * Set a person's switch and display name. The display name defaults to the first word
 * of their push/real name; a new row gets a random public id. → the row | throws 'bad_name' / 'unknown_person'.
 */
export function setPerson(personJid, { optedIn, displayName } = {}, by = 'owner', db = getDb()) {
  const canon = resolvePerson(personJid);
  if (!canon) throw Object.assign(new Error('unknown_person'), { code: 'unknown_person' });
  const cur = getPerson(canon, db);
  let name = displayName === undefined ? cur?.displayName : cleanDisplayName(displayName);
  if (!name) {
    const p = db.prepare('SELECT real_name, push_name FROM people WHERE jid = ?').get(canon);
    name = cleanDisplayName(String(p?.real_name || p?.push_name || '').split(/\s+/)[0] || '');
  }
  if (!name) throw Object.assign(new Error('bad_name'), { code: 'bad_name' });
  const on = optedIn === undefined ? !!cur?.optedIn : optedIn === true;
  const id = cur?.publicId ?? `f_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`INSERT INTO public_people (person_jid, public_id, display_name, opted_in, updated_at, updated_by)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(person_jid) DO UPDATE SET display_name = excluded.display_name, opted_in = excluded.opted_in,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(canon, id, name, on ? 1 : 0, nowSec(), String(by).slice(0, 40));
  return getPerson(canon, db);
}

/** Purge hook (006 onPersonPurged, inside the purge transaction): the row goes. */
export function deletePerson(personJid, db = getDb()) {
  db.prepare('DELETE FROM public_people WHERE person_jid = ?').run(personJid);
}

/** Every opted-in person: [{ personJid, publicId, displayName }]. */
export function optedIn(db = getDb()) {
  return db.prepare('SELECT person_jid AS personJid, public_id AS publicId, display_name AS displayName FROM public_people WHERE opted_in = 1 ORDER BY display_name').all();
}

// ── journal ───────────────────────────────────────────────────────────────

export function listJournal({ limit = 60 } = {}, db = getDb()) {
  return db.prepare('SELECT night_key AS night, text, published_at AS publishedAt FROM public_journal ORDER BY night_key DESC LIMIT ?').all(limit);
}

export function putJournal(night, text, by = 'owner', db = getDb()) {
  db.prepare(`INSERT INTO public_journal (night_key, text, published_at, published_by) VALUES (?, ?, ?, ?)
              ON CONFLICT(night_key) DO UPDATE SET text = excluded.text, published_at = excluded.published_at, published_by = excluded.published_by`)
    .run(night, text, nowSec(), String(by).slice(0, 40));
}

export function deleteJournal(night, db = getDb()) {
  return db.prepare('DELETE FROM public_journal WHERE night_key = ?').run(night).changes > 0;
}

// ── votes ─────────────────────────────────────────────────────────────────

export function putTallies(rows, db = getDb()) {
  const at = nowSec();
  const ins = db.prepare(`INSERT INTO public_votes (decision_id, option_id, count, pulled_at) VALUES (?, ?, ?, ?)
                          ON CONFLICT(decision_id, option_id) DO UPDATE SET count = excluded.count, pulled_at = excluded.pulled_at`);
  db.transaction(() => { for (const r of rows) ins.run(r.decisionId, r.optionId, r.count, at); })();
}

export function talliesFor(decisionId, db = getDb()) {
  return db.prepare('SELECT option_id AS optionId, count, pulled_at AS pulledAt FROM public_votes WHERE decision_id = ? ORDER BY count DESC').all(decisionId);
}

export function pruneTallies(keepDecisionIds, db = getDb()) {
  const keep = new Set(keepDecisionIds);
  const all = db.prepare('SELECT DISTINCT decision_id FROM public_votes').pluck().all();
  const del = db.prepare('DELETE FROM public_votes WHERE decision_id = ? AND pulled_at < ?');
  const cutoff = nowSec() - 14 * 86400;
  for (const id of all) if (!keep.has(id)) del.run(id, cutoff);
}
