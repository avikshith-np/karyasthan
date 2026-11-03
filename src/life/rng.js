// Seeded randomness for the life engine (spec 009 plan §R1). Every random
// outcome — wake minute, phone-check gap, weather block, sampled decision — is
// rolled from a generator keyed by (day, purpose) and then written into an event
// payload, so replay never rolls again.
//
// rngFor(day, purpose) returns a FRESH generator each call: asking twice for
// ('2026-10-28', 'wake') gives the same sequence no matter when, how often or in
// what order the pulse asks. That is what lets a catch-up after downtime land on
// the same day an uninterrupted run would have had. The install seed comes from
// setRngSeed() — the facade seeds it from the world file's hash; tests set it.
//
// A generator is callable (r() → [0, 1)) and carries helpers:
//   r.float(min, max)  r.int(min, max) (inclusive)  r.chance(p)
//   r.pick(list)       r.weighted(list, weightOf)   r.shuffle(list)

const DEFAULT_SEED = 0x9e3779b9;
let globalSeed = DEFAULT_SEED;

/** mulberry32: tiny, fast, good enough for simulation. Returns () → [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a of a string. */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche so near-identical keys ('block:1' / 'block:2') diverge fully
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Wrap a () → [0, 1) source with the helper methods. */
export function makeRng(source) {
  const r = () => source();
  r.next = r;
  r.float = (min = 0, max = 1) => min + (max - min) * source();
  r.int = (min, max) => {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(source() * (hi - lo + 1));
  };
  r.chance = p => source() < p;
  r.pick = list => (list?.length ? list[Math.floor(source() * list.length)] : undefined);
  r.weighted = (list, weightOf = x => x?.weight ?? 1) => {
    if (!list?.length) return undefined;
    const weights = list.map(x => Math.max(0, Number(weightOf(x)) || 0));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return list[Math.floor(source() * list.length)];
    let roll = source() * total;
    for (let i = 0; i < list.length; i++) {
      roll -= weights[i];
      if (roll < 0) return list[i];
    }
    return list[list.length - 1];
  };
  r.shuffle = list => {
    const out = [...(list || [])];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(source() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return r;
}

/** Set the install seed (number or string). Called by the facade and by tests. */
export function setRngSeed(seed) {
  globalSeed = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hashString(seed ?? DEFAULT_SEED);
  return globalSeed;
}

/** Current install seed. */
export function getRngSeed() {
  return globalSeed;
}

/**
 * Fresh generator for one (day, purpose) roll. `day` is a clock.dateKey()
 * string or any stable key (a message id for a gate roll); `purpose` names the
 * roll ('wake', 'weather:block:3', 'phone.gap:<n>').
 */
export function rngFor(day, purpose = '') {
  return makeRng(mulberry32(hashString(`${globalSeed}|${day}|${purpose}`)));
}
