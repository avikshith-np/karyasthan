import crypto from 'crypto';

// 014 geo (plan §A1.3, R18): search results held server-side under opaque
// candidate ids for 30 min (≤ 200, oldest evicted). A Director action names
// only `candidateId`; preview() resolves it here and freezes the copy into
// the preview entry, so apply never reads this store and a client can never
// forge a "real venue" (no coordinates or names ever ride in an action).

export const CANDIDATE_TTL_SEC = 30 * 60;
export const CANDIDATES_MAX = 200;
const ID_RE = /^cand:[0-9a-f-]{36}$/;

/** A store (one per facade; tests make their own). `now()` in unix seconds. */
export function createCandidateStore({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const map = new Map();   // id → { venue (frozen), expiresAt }

  function sweep() {
    const t = now();
    for (const [id, v] of map) if (v.expiresAt <= t) map.delete(id);
  }

  return {
    /** Keep a venue candidate; → its id. */
    put(venue) {
      sweep();
      const id = `cand:${crypto.randomUUID()}`;
      map.set(id, { venue: Object.freeze({ ...venue, id, flags: Object.freeze([...(venue.flags ?? [])]) }), expiresAt: now() + CANDIDATE_TTL_SEC });
      while (map.size > CANDIDATES_MAX) map.delete(map.keys().next().value);
      return id;
    },
    /** The frozen candidate, or null (unknown / expired). */
    get(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return null;
      const v = map.get(id);
      if (!v) return null;
      if (v.expiresAt <= now()) { map.delete(id); return null; }
      return v.venue;
    },
    size() { sweep(); return map.size; },
    clear() { map.clear(); },
  };
}

export const isCandidateId = (v) => typeof v === 'string' && ID_RE.test(v);
