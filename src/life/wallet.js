import { dateKey, localParts, dayStart, addDays, zonedToUnix } from './clock.js';

// His wallet, the owner's view (spec 018 §B; Life · Wallet). Pure: the facade
// hands in the log readers. One local month of money events — salary, every
// itemized spend, the owner's money changes — as a log (newest first), the
// month's totals by category, and a balance line per day.
//
// Entry `amount` is always > 0 and `dir` ('in' | 'out') gives the direction;
// `totals.byCategory.adjustment` is signed (+/−): an owner "set the balance to"
// counts by how far it moved him, either way. Labels are code-built words —
// except an owner money change, which shows the owner's own label when it has
// one (dashboard only: the public export keeps the code word, never this label).

export class WalletError extends Error {
  constructor(code) { super(`wallet: ${code}`); this.code = code; }
}

export const WALLET_TYPES = Object.freeze(['money.salary', 'money.spent', 'money.adjusted']);
export const CATEGORIES = Object.freeze(['salary', 'income', 'rent', 'bills', 'groceries', 'food', 'outing', 'travel',
  'setback', 'adjustment', 'other']);
export const ENTRIES_MAX = 500;
export const MONTHS_MAX = 24;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);
const SPENT_FOR = new Set(['rent', 'bills', 'groceries', 'food', 'outing', 'travel', 'setback']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (x) => Math.round(x * 100) / 100;
const kindOf = (k) => String(k ?? '').split(':')[0];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const OUTING_WORDS = Object.freeze({
  cafe: 'Coffee', coffee: 'Coffee', movie: 'Movie', cinema: 'Movie', drinks: 'Drinks', bar: 'Drinks', date: 'Date',
  hangout: 'Hanging out', social: 'Going out', outing: 'Going out', sports: 'Sports', shopping: 'Shopping', concert: 'Concert',
});
const MEAL_WORDS = Object.freeze({
  breakfast: 'Breakfast out', lunch: 'Lunch out', dinner: 'Dinner out', 'eat-out': 'Dinner out', meal: 'Meal out',
  snack: 'Snack', cafe: 'Coffee', coffee: 'Coffee', restaurant: 'Meal out',
});
const FARE_MODES = new Set(['cab', 'auto', 'bus', 'metro', 'train', 'taxi', 'rickshaw', 'ferry', 'tram']);
const OWN_MODES = new Set(['car', 'drive', 'scooter', 'motorbike', 'bike']);
const ADJUST_WORDS = Object.freeze({ income: 'Income', expense: 'Expense', set: 'Balance set' });

/** The code-built word for a money event (the public export uses these; never a name). */
export function labelOf(ev, { travelMode = null, office = false } = {}) {
  const p = ev?.payload || {};
  if (ev?.type === 'money.salary') return 'Salary';
  if (ev?.type === 'money.adjusted') return ADJUST_WORDS[p.mode] ?? 'Adjustment';
  const kind = kindOf(p.kind);
  switch (p.for) {
    case 'rent': return 'Rent';
    case 'bills': return 'Bills';
    case 'groceries': return p.period ? 'Groceries' : 'Groceries top-up';
    case 'setback': return 'Setback';
    case 'food': return kind === 'lunch' && office ? 'Canteen lunch' : (MEAL_WORDS[kind] ?? 'Food');
    case 'outing': return OUTING_WORDS[kind] ?? (kind && /^[a-z][a-z-]{1,23}$/.test(kind) ? cap(kind.replace(/-/g, ' ')) : 'Going out');
    case 'travel': {
      const m = kindOf(travelMode);
      if (FARE_MODES.has(m)) return `${cap(m)} fare`;
      if (OWN_MODES.has(m)) return 'Fuel';
      return 'Travel';
    }
    default: return 'Spent';
  }
}

/** { dir, amount, category } of a money event, or null (an unknown set, a zero). */
export function moneyOf(ev, { balanceBefore = null } = {}) {
  const p = ev?.payload || {};
  const amt = finite(p.amount) ? Math.abs(p.amount) : 0;
  if (ev?.type === 'money.salary') return amt > 0 ? { dir: 'in', amount: round2(amt), category: 'salary' } : null;
  if (ev?.type === 'money.spent') return amt > 0 ? { dir: 'out', amount: round2(amt), category: SPENT_FOR.has(p.for) ? p.for : 'other' } : null;
  if (ev?.type === 'money.adjusted') {
    if (p.mode === 'income') return amt > 0 ? { dir: 'in', amount: round2(amt), category: 'income' } : null;
    if (p.mode === 'expense') return amt > 0 ? { dir: 'out', amount: round2(amt), category: 'other' } : null;
    if (p.mode === 'set' && finite(p.amount) && finite(balanceBefore)) {
      const d = round2(p.amount - balanceBefore);
      return d !== 0 ? { dir: d > 0 ? 'in' : 'out', amount: Math.abs(d), category: 'adjustment', signed: d } : null;
    }
  }
  return null;
}

/** The origin word of an event: 'self' | 'owner' | 'chat'. */
export function originOf(ev) {
  if (CHAT_ORIGINS.has(ev?.originKind)) return 'chat';
  return ev?.originKind === 'owner' ? 'owner' : 'self';
}

function monthBounds(month, tz) {
  const m = MONTH_RE.exec(month);
  const y = Number(m[1]); const mo = Number(m[2]);
  const first = zonedToUnix(y, mo, 1, 0, 0, tz);
  const next = zonedToUnix(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1, 0, 0, tz);
  return { from: first, to: next };
}

function monthsBetween(fromMonth, toMonth) {
  const out = [];
  let [y, m] = toMonth.split('-').map(Number);
  for (let i = 0; i < MONTHS_MAX; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key < fromMonth) break;
    out.push(key);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

/** The start of his next payday's local day (unix), or null. */
export function nextPayday(state, world, at, tz) {
  const pay = world?.money?.payday;
  if (!Number.isInteger(pay)) return null;
  const p = localParts(at, tz);
  const dim = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const thisMonth = `${p.year}-${String(p.month).padStart(2, '0')}`;
  const last = state?.money?.lastSalaryAt;
  const paidThisMonth = finite(last) && dateKey(last, tz).slice(0, 7) === thisMonth;
  let y = p.year; let mo = p.month;
  if (paidThisMonth || p.day > Math.min(pay, dim(y, mo))) { mo += 1; if (mo === 13) { mo = 1; y += 1; } }
  return zonedToUnix(y, mo, Math.min(pay, dim(y, mo)), 0, 0, tz);
}

const empty = (month) => ({
  running: false, month, months: [], balance: null, currencyHint: null, salary: null, baseline: null,
  totals: { in: 0, out: 0, net: 0, byCategory: {} }, daily: [], entries: [],
});

/**
 * The wallet for one local month ('YYYY-MM', default this month).
 * deps: { state, world, at, tz, events(from, to, types), getEvent(id), isOut(id),
 *         balanceNow() → number|null, balancesAt([unix…]) → [number|null…] (one read for the month's day ends),
 *         balanceBefore(eventId) → number|null,
 *         isRevertible(ev) → bool }
 * Throws WalletError('bad_month' | 'out_of_range').
 */
export function buildWalletView({ state, world, at, tz, month = null, events, getEvent = () => null, isOut = () => false,
  balanceNow = () => null, balancesAt = (ts) => ts.map(() => null), balanceBefore = () => null, isRevertible = () => false } = {}) {
  const thisMonth = dateKey(at, tz).slice(0, 7);
  const key = month === null || month === undefined || month === '' ? thisMonth : month;
  if (typeof key !== 'string' || !MONTH_RE.test(key) || Number(key.slice(5)) < 1 || Number(key.slice(5)) > 12) throw new WalletError('bad_month');
  if (!state) return empty(key);
  const genesisAt = finite(state.genesisAt) ? state.genesisAt : at;
  const firstMonth = dateKey(genesisAt, tz).slice(0, 7);
  if (key < firstMonth || key > thisMonth) throw new WalletError('out_of_range');

  const { from, to } = monthBounds(key, tz);
  const end = Math.min(to - 1, at);
  const evs = (events(from, end, [...WALLET_TYPES]) || []).filter(ev => !isOut(ev.id) && ev.redacted !== true);
  const places = state.places instanceof Map ? state.places : new Map();
  const officeIds = new Set([state.self?.officePlaceId, state.story?.career?.officePlaceId].filter(Boolean));
  const departed = state.story?.departed && typeof state.story.departed === 'object' ? state.story.departed : {};
  const castName = (id) => state.cast?.get?.(id)?.name ?? departed[id]?.name ?? 'someone';

  const entries = [];
  const byCategory = {};
  let tin = 0; let tout = 0;
  for (const ev of evs) {
    const m = moneyOf(ev, { balanceBefore: ev.type === 'money.adjusted' && ev.payload?.mode === 'set' ? balanceBefore(ev.id) : null });
    if (!m) continue;
    const p = ev.payload || {};
    const placeId = typeof p.placeId === 'string' && places.has(p.placeId) ? p.placeId : null;
    const place = placeId ? places.get(placeId) : null;
    let travelMode = null;
    if (p.for === 'travel' && Number.isSafeInteger(ev.causeId)) {
      try { travelMode = getEvent(ev.causeId)?.payload?.mode ?? null; } catch { travelMode = null; }
    }
    const word = labelOf(ev, { travelMode, office: !!placeId && (officeIds.has(placeId) || place?.kind === 'office') });
    const ownerLabel = ev.type === 'money.adjusted' && typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 80) : null;
    const castIds = Array.isArray(p.castIds) ? p.castIds.filter(x => typeof x === 'string').slice(0, 12) : [];
    entries.push({
      id: ev.id, at: ev.at, dir: m.dir, amount: m.amount, category: m.category, label: ownerLabel ?? word,
      placeId, placeName: place?.name ?? null, castIds, castNames: castIds.map(castName),
      origin: originOf(ev), fromChat: originOf(ev) === 'chat', actor: ev.actor,
      revertible: (() => { try { return isRevertible(ev) === true; } catch { return false; } })(),
    });
    const signed = m.signed ?? (m.dir === 'in' ? m.amount : -m.amount);
    if (m.category === 'adjustment') byCategory.adjustment = round2((byCategory.adjustment ?? 0) + signed);
    else byCategory[m.category] = round2((byCategory[m.category] ?? 0) + m.amount);
    if (m.dir === 'in') tin += m.amount; else tout += m.amount;
  }

  // Every day from the month's first (or genesis day) to today, zeros where nothing moved.
  const days = [];
  const startDay = Math.max(from, dayStart(genesisAt, tz));
  for (let d = startDay, i = 0; d < to && d <= at && i < 32; d = addDays(d, 1, tz), i++) days.push([d, addDays(d, 1, tz)]);
  let bals = [];
  try { bals = balancesAt(days.map(([, next]) => Math.min(next - 1, at))) || []; } catch { bals = []; }
  const daily = days.map(([d, next], i) => {
    const day = entries.filter(e => e.at >= d && e.at < next);
    const dayIn = round2(day.filter(e => e.dir === 'in').reduce((a, e) => a + e.amount, 0));
    const dayOut = round2(day.filter(e => e.dir === 'out').reduce((a, e) => a + e.amount, 0));
    return { date: dateKey(d, tz), in: dayIn, out: dayOut, balance: finite(bals[i]) ? Math.round(bals[i]) : null };
  });

  const pay = world?.money?.payday;
  const salary = finite(world?.money?.salary) && world.money.salary > 0 && Number.isInteger(pay) ? {
    amount: world.money.salary, payday: pay,
    lastAt: finite(state.money?.lastSalaryAt) ? state.money.lastSalaryAt : null,
    nextAt: nextPayday(state, world, at, tz),
  } : null;
  let balance = null;
  try { balance = balanceNow(); } catch { balance = null; }

  entries.sort((a, b) => b.at - a.at || b.id - a.id);
  return {
    running: true,
    month: key,
    months: monthsBetween(firstMonth, thisMonth),
    balance: finite(balance) ? Math.round(balance) : null,
    currencyHint: null,
    salary,
    baseline: finite(world?.money?.monthlyBaseline) ? world.money.monthlyBaseline : null,
    totals: { in: round2(tin), out: round2(tout), net: round2(tin - tout), byCategory },
    daily,
    entries: entries.slice(0, ENTRIES_MAX),
  };
}
