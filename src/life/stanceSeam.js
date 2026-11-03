// A changing mind (plan 020 B): the one door by which his interests and opinions reach his life. startLife sets the
// provider from src/index.js (life can't import the mind). With none, or none active, every reader here gets nothing
// and his day runs exactly as it did: no numbers, unchanged weights, no draws moved.
//
//   provider = { numbers() → Map(topic → value) | null, sheetLines({ kind, placeId, castIds }) → string[], publicRows() → rows | null }
let provider = null;

export const INTEREST_W = 1;      // a utility bump for a full swing of interest in what it is
export const PLACE_W = 0.5;       // and of liking for where it is
export const BUMP_MAX = 0.6;
const WEIGHT_MIN = 0.25;
const WEIGHT_MAX = 2;

export function setStanceProvider(p) {
  provider = p && typeof p === 'object' ? p : null;
}

function numbers() {
  try {
    const n = provider?.numbers?.();
    return n instanceof Map && n.size ? n : null;
  } catch { return null; }
}

const lean = (n, topic) => { const v = n.get(topic); return Number.isFinite(v) ? v - 0.5 : null; };

/** What he makes of this outing, for the decision. null when there's no view on it. */
export function stanceOf(kind, placeId) {
  const n = numbers();
  if (!n) return null;
  const interest = typeof kind === 'string' ? lean(n, `kind:${kind}`) : null;
  const place = typeof placeId === 'string' ? lean(n, placeId) : null;
  if (interest === null && place === null) return null;
  const bump = Math.max(-BUMP_MAX, Math.min(BUMP_MAX, INTEREST_W * (interest ?? 0) + PLACE_W * (place ?? 0)));
  return { bump, ...(interest !== null ? { interest: interest + 0.5 } : {}), ...(place !== null ? { placeLiking: place + 0.5 } : {}) };
}

/** Leisure items, their weights leaning his way. The same array, untouched, when he has no views. */
export function leanedLeisure(items) {
  const n = numbers();
  if (!n || !Array.isArray(items)) return items;
  return items.map((l) => {
    const interest = lean(n, `kind:${l.kind}`) ?? 0;
    const place = lean(n, l.placeId) ?? 0;
    const factor = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, 1 + 1.2 * interest + 0.6 * place));
    return { ...l, weight: (Number.isFinite(l.weight) ? l.weight : 1) * factor };
  });
}

/** Up to three lines for a writer's sheet. Empty when he has no views on what's in it. */
export function stanceSheetLines(q) {
  try {
    const out = provider?.sheetLines?.(q);
    return Array.isArray(out) ? out.filter(x => typeof x === 'string' && x).slice(0, 3) : [];
  } catch { return []; }
}

/** For the public site's `mind` key: only rows his own life shaped, or null with no mind to ask. */
export function publicStanceRows() {
  try {
    const out = provider?.publicRows?.();
    return Array.isArray(out) ? out : null;
  } catch { return null; }
}
