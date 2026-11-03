import { config } from '../utils/config.js';

// The world clock (spec 009 plan §R2). Every life module reads time through
// now() so tests can swap in a fake clock with setClock(fn) — the helpers'
// fakeClock().fn is shaped for it. Times are unix SECONDS throughout src/life/.
//
// Calendar helpers (day start, weekday, hh:mm, "07:30 on this day") work in the
// world's timezone via Intl, never the host's. The timezone is a per-call
// argument: the projection holds world.timezone and passes it in; when omitted,
// the configured TIMEZONE is used. Everything is DST-safe even though the
// example world has none — the code stays persona- and region-neutral.

const realNow = () => Math.floor(Date.now() / 1000);
let clockFn = realNow;

/** Current world time in unix seconds. */
export function now() {
  return clockFn();
}

/** True while the real clock runs (not a test's or a simulation's fake one). */
export function isRealClock() {
  return clockFn === realNow;
}

/** Replace the clock (tests). `null` restores real time. */
export function setClock(fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error('setClock expects a function or null');
  clockFn = fn ? () => Math.floor(fn()) : realNow;
}

// ── Timezone ──────────────────────────────────────────────────────────────

const formatters = new Map();
const validity = new Map();

/** True when Intl knows `tz` (e.g. 'Europe/Paris', 'UTC'). */
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  if (validity.has(tz)) return validity.get(tz);
  let ok = true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { ok = false; }
  if (validity.size < 64) validity.set(tz, ok);
  return ok;
}

/** `tz` if valid, else the configured TIMEZONE, else UTC. */
export function resolveTimezone(tz) {
  if (isValidTimezone(tz)) return tz;
  if (isValidTimezone(config.timezone)) return config.timezone;
  return 'UTC';
}

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PARTS_CACHE_MAX = 16384;
const partsCache = new Map();
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Wall-clock fields of `unix` in the world timezone:
 * { year, month (1–12), day, hour (0–23), minute, second, weekday (0 = Sunday) }.
 */
export function localParts(unix, tz) {
  const zone = resolveTimezone(tz);
  // formatToParts dominates the vitals integration (one call per 5-minute
  // sub-step) and the same instants repeat across views and preview sims, so
  // results are memoized (bounded; callers get a fresh copy).
  const key = `${zone}|${unix}`;
  const hit = partsCache.get(key);
  if (hit) return { ...hit };
  const out = {};
  for (const { type, value } of formatter(zone).formatToParts(new Date(unix * 1000))) {
    if (type === 'weekday') out.weekday = WEEKDAYS[value];
    else if (type !== 'literal') out[type] = Number(value);
  }
  if (out.hour === 24) out.hour = 0; // defensive: some engines still emit 24 at midnight
  if (partsCache.size >= PARTS_CACHE_MAX) partsCache.clear();
  partsCache.set(key, out);
  return { ...out };
}

/** Minutes the zone is ahead of UTC at `unix` (+05:45 → 345). */
export function tzOffsetMinutes(unix, tz) {
  const p = localParts(unix, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return Math.round((asUtc - unix) / 60);
}

/**
 * Unix seconds of a local wall-clock time. In a DST gap the result lands just
 * after the gap; in an overlap it picks the first occurrence.
 */
export function zonedToUnix(year, month, day, hour = 0, minute = 0, tz) {
  const zone = resolveTimezone(tz);
  const naive = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  // Offsets a day either side bracket at most one transition; try both.
  const candidates = [...new Set([
    naive - tzOffsetMinutes(naive - 86400, zone) * 60,
    naive - tzOffsetMinutes(naive + 86400, zone) * 60,
  ])];
  const want = new Date(naive * 1000);
  const matches = candidates.filter(c => {
    const p = localParts(c, zone);
    return p.year === want.getUTCFullYear() && p.month === want.getUTCMonth() + 1 && p.day === want.getUTCDate()
      && p.hour === want.getUTCHours() && p.minute === want.getUTCMinutes();
  });
  return matches.length ? Math.min(...matches) : Math.max(...candidates);
}

// ── Day helpers ───────────────────────────────────────────────────────────

/** Unix seconds of local midnight of the day containing `unix`. */
export function dayStart(unix = now(), tz) {
  const p = localParts(unix, tz);
  return zonedToUnix(p.year, p.month, p.day, 0, 0, tz);
}

/** Local midnight `n` days after the day containing `unix` (DST-safe). */
export function addDays(unix, n, tz) {
  const p = localParts(unix, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return zonedToUnix(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, tz);
}

/** 0 = Sunday … 6 = Saturday (world.routine uses the same numbering). */
export function weekday(unix = now(), tz) {
  return localParts(unix, tz).weekday;
}

/** True on the world's weekend days (`world.routine.weekend`, default Sat/Sun). */
export function isWeekend(unix = now(), tz, weekendDays = [0, 6]) {
  return weekendDays.includes(weekday(unix, tz));
}

/** 'YYYY-MM-DD' of the local day — the RNG key for per-day rolls. */
export function dateKey(unix = now(), tz) {
  const p = localParts(unix, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Local 'HH:MM' (24 h). */
export function hhmm(unix = now(), tz) {
  const p = localParts(unix, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Minutes since local midnight (0–1439). */
export function minuteOfDay(unix = now(), tz) {
  const p = localParts(unix, tz);
  return p.hour * 60 + p.minute;
}

/** Fractional local hour (14:30 → 14.5). */
export function hourOfDay(unix = now(), tz) {
  const p = localParts(unix, tz);
  return p.hour + p.minute / 60 + p.second / 3600;
}

/** 'Wed 28 Oct' — locale-independent, for prompt time lines. */
export function dayLabel(unix = now(), tz) {
  const p = localParts(unix, tz);
  return `${DAY_NAMES[p.weekday]} ${p.day} ${MONTH_NAMES[p.month - 1]}`;
}

const HHMM_RE = /^([01]?\d|2[0-4]):([0-5]\d)$/;

/** '07:30' → 450 minutes. '24:00' → 1440 (end of day). Throws on anything else. */
export function parseHhmm(s) {
  const m = typeof s === 'string' ? HHMM_RE.exec(s.trim()) : null;
  if (!m) throw new Error(`invalid hh:mm "${String(s).slice(0, 16)}"`);
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins > 1440) throw new Error(`invalid hh:mm "${s}"`);
  return mins;
}

/**
 * Unix seconds of `time` ('HH:MM' or minutes since midnight) on the local day
 * containing `dayUnix`. Minutes ≥ 1440 roll into the next day ('25:30' style
 * plans past midnight are passed as 1530). DST-safe.
 */
export function atLocal(dayUnix, time, tz) {
  const mins = typeof time === 'number' ? Math.round(time) : parseHhmm(time);
  const p = localParts(dayUnix, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 0, mins));
  return zonedToUnix(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), tz);
}

/**
 * Whole years since `birthdate` ('YYYY-MM-DD') on the local day of `unix`.
 * Feb-29 birthdays count from Mar 1 in non-leap years. null on a bad date.
 */
export function ageOn(birthdate, unix = now(), tz) {
  const m = typeof birthdate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate) : null;
  if (!m) return null;
  const [by, bm, bd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bm < 1 || bm > 12 || bd < 1 || bd > 31) return null;
  const p = localParts(unix, tz);
  let age = p.year - by;
  if (p.month < bm || (p.month === bm && p.day < bd)) age--;
  return age;
}
