import { dateKey, localParts } from './clock.js';
import { rngFor } from './rng.js';

// His wallet (spec 018 §A): what he spends on, in code only — no model call, no
// chat text. Before 018 the vitals drained `world.money.monthlyBaseline` as a
// smooth hourly line and only trips (and heavy setbacks) were itemized. With the
// wallet on, the pulse appends one engine `wallet.started` (its time is the
// cut-over: the projector stops the hourly drain from then on) and itemizes the
// baseline instead, as `money.spent {amount, for, …}`:
//
//   outing     an activity of a non-routine kind at a place that isn't a home —
//              the committed option's `spend` when its decision has one, else a
//              per-kind / per-place-kind share of the price level; caused by the
//              activity.started, so a chat outing's spend keeps the chat origin
//              and reverting the outing takes its spend
//   food       a meal away from home: lunch at the office (canteen), a meal at a
//              cafe / restaurant; caused by its activity.started
//   groceries  a groceries trip at a shop (a top-up; caused by its activity), and
//              the weekly basket at wake on GROCERIES_WEEKDAY (period = the date)
//   rent       monthly at wake on RENT_DAY (period = 'YYYY-MM')
//   bills      monthly at wake on BILLS_DAY (period = 'YYYY-MM')
//
// The price level is the baseline (else salary × 0.45; neither → per-event only
// from a decision's own spend). Recurring items catch up at the first wake on or
// after their day when the period is unpaid and the world already existed at that
// day (no back-pay for a month before genesis) — salary follows the same rule.
// A reverted recurring item stays undone for its period (projector.exclusionSig).
// Amounts are deterministic: rngFor(date, 'spend:…') jitter, rounded to 10.

let walletOn = true;
/** Tests: run the pre-018 engine (no wallet.started, no new spends, the 009 salary rule). Goldens use it. */
export function __setWalletForTest(on) { walletOn = on !== false; }
export function walletEnabled() { return walletOn; }

export const RENT_DAY = 1;
export const BILLS_DAY = 10;
export const GROCERIES_WEEKDAY = 0;            // Sunday
export const GROCERIES_CATCHUP_DAYS = 8;       // a basket missed for this long is bought at the next wake
// Shares of the price level (≈ the monthly baseline). Rent + bills + 4.3 baskets
// ≈ 0.63; canteen lunches, meals out, outings and trips make up the rest (a 31-day
// dry run of an office routine: ~0.8 of the baseline in all).
export const RENT_SHARE = 0.40;
export const BILLS_SHARE = 0.10;
export const GROCERIES_WEEK_SHARE = 0.03;
export const GROCERY_TRIP_SHARE = 0.006;
export const CANTEEN_SHARE = 0.004;
export const MEAL_OUT_SHARE = Object.freeze({ breakfast: 0.004, lunch: 0.006, dinner: 0.012, 'eat-out': 0.012, meal: 0.008, snack: 0.002 });
// Outings by their kind, else by the place's kind; 0 = free (a walk, the gym on his membership).
export const OUTING_SHARE = Object.freeze({
  cafe: 0.006, coffee: 0.006, movie: 0.008, cinema: 0.008, drinks: 0.02, bar: 0.02, date: 0.015,
  hangout: 0.008, social: 0.01, outing: 0.008, sports: 0.005, shopping: 0.02, concert: 0.02,
  walk: 0, run: 0, gym: 0, park: 0, visit: 0,
});
export const PLACE_KIND_SHARE = Object.freeze({
  cafe: 0.006, restaurant: 0.012, bar: 0.02, cinema: 0.008, sports: 0.005, shop: 0.01, mall: 0.01,
  park: 0, gym: 0, office: 0, home: 0,
});
export const DEFAULT_OUTING_SHARE = 0.005;
export const RECURRING = Object.freeze(['rent', 'bills', 'groceries']);

// Kinds that are his routine, not an outing (cast.js ROUTINE_ACTIVITY_KINDS; kept here, life core doesn't import the story).
const ROUTINE = new Set(['work', 'meeting', 'commute', 'lunch', 'breakfast', 'dinner', 'snack', 'sleep', 'free', 'sick',
  'rest', 'tv', 'groceries', 'errand', 'call', 'break']);
const MEALS = new Set(['breakfast', 'lunch', 'dinner', 'meal', 'snack', 'eat-out']);
const MEAL_OUTINGS = new Set(['eat-out', 'cafe', 'food', 'restaurant', 'coffee']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const kindOf = (k) => String(k ?? '').split(':')[0];

/** The price level the shares scale: the monthly baseline, else salary × 0.45, else 0. */
export function priceLevel(world) {
  const m = world?.money || {};
  if (finite(m.monthlyBaseline) && m.monthlyBaseline > 0) return m.monthlyBaseline;
  if (finite(m.salary) && m.salary > 0) return Math.round(m.salary * 0.45);
  return 0;
}

function roundAmount(x) {
  if (!(x > 0)) return 0;
  return x < 50 ? Math.max(1, Math.round(x)) : Math.round(x / 10) * 10;
}

function jitter(date, purpose, base) {
  const r = rngFor(date, `spend:${purpose}`);
  return roundAmount(base * r.float(0.85, 1.15));
}

function isHomePlace(state, placeId, place) {
  if (!placeId) return true;
  if (placeId === state?.self?.homePlaceId) return true;
  if (place?.kind === 'home') return true;
  return Array.isArray(state?.self?.homeHistory) && state.self.homeHistory.includes(placeId);
}

function isOffice(state, placeId, place) {
  return placeId === state?.self?.officePlaceId || placeId === state?.story?.career?.officePlaceId || place?.kind === 'office';
}

// The committed option's own spend for the outing a block belongs to (009's evening
// invitation prices its options), else null.
function optionSpend(state, block) {
  const own = Number.isSafeInteger(block?.decisionId);
  const id = own ? block.decisionId
    : (Number.isSafeInteger(state?.plan?.amendedFor) ? state.plan.amendedFor : null);
  const d = id !== null && state?.decisions instanceof Map ? state.decisions.get(id) : null;
  if (!d || d.status !== 'committed') return null;
  // The plan's amendedFor prices only that outing's own block (2026-11-02: a plan re-made for one
  // outing holds every other block of the day; a routine block elsewhere is not that outing).
  if (!own && d.subject?.placeId && block?.placeId !== d.subject.placeId) return null;
  const o = (d.options || []).find(x => x.id === d.committed?.optionId);
  return o && finite(o.spend) && o.spend > 0 ? { amount: o.spend, decisionId: d.id } : null;
}

/**
 * The money.spent payload for an activity he just started, or null. `ev` is its
 * activity.started (the spend's cause), `places` the world's place map.
 */
export function activitySpend({ state, block, ev, places, world, date }) {
  if (!walletOn || !ev?.payload) return null;
  const p = ev.payload;
  const kind = kindOf(p.kind);
  const placeId = typeof p.placeId === 'string' ? p.placeId : null;
  const place = placeId ? places?.get?.(placeId) : null;
  const level = priceLevel(world);
  const castIds = Array.isArray(p.withCast) ? p.withCast.slice(0, 12) : [];
  const base = { kind, placeId, castIds };
  if (isHomePlace(state, placeId, place)) return null;

  if (MEALS.has(kind)) {
    let share = 0;
    if (isOffice(state, placeId, place)) share = kind === 'lunch' ? CANTEEN_SHARE : 0;
    else share = MEAL_OUT_SHARE[kind] ?? MEAL_OUT_SHARE.meal;
    const amount = jitter(date, `food:${ev.id}`, level * share);
    return amount > 0 ? { amount, for: 'food', ...base } : null;
  }
  if (kind === 'groceries') {
    const amount = jitter(date, `grocery:${ev.id}`, level * GROCERY_TRIP_SHARE);
    return amount > 0 ? { amount, for: 'groceries', ...base } : null;
  }
  if (ROUTINE.has(kind) || isOffice(state, placeId, place)) return null;

  const own = optionSpend(state, block);
  if (own) return { amount: roundAmount(own.amount), for: 'outing', ...base, decisionId: own.decisionId };
  const share = OUTING_SHARE[kind] ?? PLACE_KIND_SHARE[place?.kind] ?? DEFAULT_OUTING_SHARE;
  const amount = jitter(date, `outing:${ev.id}`, level * share);
  if (!(amount > 0)) return null;
  return { amount, for: MEAL_OUTINGS.has(kind) || place?.kind === 'restaurant' ? 'food' : 'outing', ...base };
}

function daysIn(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A monthly item due at this wake? Due on/after its day (clamped to the month's
 * length) while `paidPeriod` isn't this month, and the world existed on that day
 * (its genesis date is before it, or this wake is on it).
 */
export function monthlyDue(day, at, zone, genesisAt, paidPeriod) {
  const p = localParts(at, zone);
  const month = `${p.year}-${String(p.month).padStart(2, '0')}`;
  const d = Math.min(day, daysIn(p.year, p.month));
  if (p.day < d || paidPeriod === month) return null;
  const dueDate = `${month}-${String(d).padStart(2, '0')}`;
  const existed = p.day === d || (finite(genesisAt) && dateKey(genesisAt, zone) < dueDate);
  return existed ? month : null;
}

/**
 * The recurring spends due at a wake: [{ amount, for, period }]. `isUndone(key)`
 * says a reverted one for that `<for>:<period>` (it stays undone).
 */
export function recurringDue(state, at, world, zone, isUndone = () => false) {
  if (!walletOn) return [];
  const level = priceLevel(world);
  if (!(level > 0)) return [];
  const m = world?.money || {};
  const paid = state?.money?.paid || {};
  const date = dateKey(at, zone);
  const out = [];
  const monthly = [['rent', RENT_DAY, finite(m.rent) ? m.rent : level * RENT_SHARE],
    ['bills', BILLS_DAY, finite(m.bills) ? m.bills : level * BILLS_SHARE]];
  for (const [what, day, amount] of monthly) {
    const period = monthlyDue(day, at, zone, state?.genesisAt, paid[what]);
    if (!period || isUndone(`${what}:${period}`)) continue;
    const a = what === 'rent' ? roundAmount(amount) : jitter(date, what, amount);
    if (a > 0) out.push({ amount: a, for: what, period });
  }
  const last = typeof paid.groceries === 'string' ? paid.groceries : null;
  const weekday = localParts(at, zone).weekday;
  const daysSince = last ? Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 864e5) : null;
  const due = last !== date && (weekday === GROCERIES_WEEKDAY || (daysSince !== null && daysSince >= GROCERIES_CATCHUP_DAYS));
  if (due && !isUndone(`groceries:${date}`)) {
    const a = jitter(date, 'groceries', finite(m.groceriesWeekly) ? m.groceriesWeekly : level * GROCERIES_WEEK_SHARE);
    if (a > 0) out.push({ amount: a, for: 'groceries', period: date });
  }
  return out;
}

/** The month a salary is due at this wake ('YYYY-MM'), or null (018: catch-up on/after the payday). */
export function salaryDue(state, at, world, zone, isUndone = () => false) {
  const pay = world?.money?.payday;
  const salary = world?.money?.salary;
  if (!Number.isInteger(pay) || !finite(salary) || !(salary > 0)) return null;
  const last = state?.money?.lastSalaryAt;
  const paidMonth = finite(last) ? dateKey(last, zone).slice(0, 7) : null;
  const month = monthlyDue(pay, at, zone, state?.genesisAt, paidMonth);
  return month && !isUndone(`salary:${month}`) ? month : null;
}
