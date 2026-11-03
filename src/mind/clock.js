// Mind clock (spec 008, contracts/mind-api.md "clock.js", research R3/R5).
//
// One injectable time source for every mind module (unix SECONDS), plus the local
// calendar helpers, all in config.timezone:
//   dayKey(t)      local YYYY-MM-DD (the same function as store.localDateKey, so a
//                  run's day_key and the store's defaults can never disagree);
//   nightKey(t)    localDate(t − 12 h): any sleep that starts between 12:00 on day D
//                  and 12:00 on D+1 belongs to night D (research R5);
//   localHour(t)   0..23;
//   inSleepHours(t) the config.sleepStartHour..sleepEndHour window, the same rule as
//                  instagram/scheduler.js isAwake (copied, so the mind has no IG
//                  dependency); start === end → never asleep.
// All local-time math goes through Intl (hourCycle h23): no arithmetic on local hours,
// so DST zones behave. setClock() also re-points the store's clock.

import { config } from '../utils/config.js';
import { setStoreClock, localDateKey } from './store.js';

const realNow = () => Math.floor(Date.now() / 1000);
let nowFn = realNow;

/** Current mind time, unix seconds. */
export function now() {
  return Math.floor(nowFn());
}

/** Use `fn` (→ unix seconds) as the mind clock everywhere; null restores the real clock. */
export function setClock(fn) {
  nowFn = typeof fn === 'function' ? fn : realNow;
  setStoreClock(typeof fn === 'function' ? fn : null);
}

/** Local date key (YYYY-MM-DD) in config.timezone. Same function as the store's. */
export function dayKey(t = now()) {
  return localDateKey(t);
}

/**
 * Night key: localDate(t − 12 h) on the wall clock — from local 12:00 on day D until
 * local 12:00 on D+1 it is D. Computed from the local hour (not by subtracting 12 h of
 * absolute time), so the boundary stays at local noon on DST-change days too.
 */
export function nightKey(t = now()) {
  const key = localDateKey(t);
  return localHour(t) >= 12 ? key : daysBeforeKey(key, 1);
}

let hourFmt = null;
let hourTz = null;
function hourFormatter() {
  const tz = config.timezone || 'UTC';
  if (!hourFmt || hourTz !== tz) {
    try {
      hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' });
    } catch {
      hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', hour: '2-digit' });
    }
    hourTz = tz;
  }
  return hourFmt;
}

/** Local hour 0..23 in config.timezone. */
export function localHour(t = now()) {
  const h = Number(hourFormatter().format(new Date(Math.floor(t) * 1000)));
  return h === 24 ? 0 : h;
}

/** True inside the configured quiet hours (SLEEP_START_HOUR..SLEEP_END_HOUR, local). */
export function inSleepHours(t = now()) {
  const s = Number(config.sleepStartHour);
  const e = Number(config.sleepEndHour);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  const h = localHour(t);
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

/** Local-day key for the next local day after `key` (calendar arithmetic, no tz math). */
export function nextDayKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/** Local-day key `n` days before `key` (calendar arithmetic). */
export function daysBeforeKey(key, n) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - Math.floor(n)));
  return dt.toISOString().slice(0, 10);
}
