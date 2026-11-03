// Formatting helpers. Times are shown in the bot's timezone (status.timezone,
// set once at boot via setTimezone) through Intl — no zone is hardcoded here.

let TZ; // undefined → the browser's own zone until status arrives

export function setTimezone(tz) {
  try {
    if (tz) new Intl.DateTimeFormat(undefined, { timeZone: tz }); // throws on a bad zone
    TZ = tz || undefined;
  } catch {
    TZ = undefined;
  }
}
export const getTimezone = () => TZ;

export const padz = (n, w = 2) => String(n).padStart(w, '0');

/** Seconds or milliseconds → Date. */
export function toDate(ts) {
  if (ts == null || ts === '') return null;
  if (ts instanceof Date) return ts;
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

const cache = new Map();
function fmtr(key, opts) {
  const k = `${TZ || ''}|${key}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: TZ });
    cache.set(k, f);
  }
  return f;
}

function parts(d) {
  const out = {};
  for (const p of fmtr('parts', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** Full local date + time in the bot's zone. */
export function fmtTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return fmtr('full', { dateStyle: 'medium', timeStyle: 'medium' }).format(d);
}

/** HH:MM:SS in the bot's zone. */
export function fmtClock(ts = Date.now()) {
  const d = toDate(ts);
  if (!d) return '—';
  const p = parts(d);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** HH:MM in the bot's zone. */
export function fmtHm(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const p = parts(d);
  return `${p.hour}:${p.minute}`;
}

/** YYYY-MM-DD in the bot's zone. */
export function fmtDay(ts = Date.now()) {
  const d = toDate(ts);
  if (!d) return '—';
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Tue 3 Nov 19:30" in the bot's zone (a day that isn't today, said plainly). */
export function fmtWhen(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const p = {};
  for (const x of fmtr('when', { weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.weekday} ${p.day} ${p.month} ${fmtHm(d)}`;
}

/**
 * A committed plan whose time is still ahead must not read as done:
 * "decided: going · Tue 3 Nov 19:30 (not yet)". '' when it is not ahead of `now` (seconds).
 */
export function decidedAhead(label, eventAt, now) {
  const at = Number(eventAt);
  const n = Number(now);
  if (!Number.isFinite(at) || !Number.isFinite(n) || at <= n) return '';
  return `decided: ${label || '?'} · ${fmtWhen(at)} (not yet)`;
}

/** Hour of day (0–23) in the bot's zone. */
export function hourOf(ts) {
  const d = toDate(ts);
  return d ? Number(parts(d).hour) % 24 : null;
}

/** Short zone label for the clock (e.g. "GMT+9" / "UTC"). */
export function zoneLabel() {
  try {
    const p = new Intl.DateTimeFormat(undefined, { timeZone: TZ, timeZoneName: 'short' }).formatToParts(new Date());
    return p.find((x) => x.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

export function fmtRelative(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 0) return 'now';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function fmtDuration(sec) {
  if (!sec && sec !== 0) return '—';
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const days = Math.floor(h / 24);
  if (days < 1) return `${h}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${days}d ${h % 24}h`;
}

export function maskPhone(phone) {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return digits;
  return digits.slice(0, digits.length - 5) + ' ▓▓▓▓▓';
}

export const fmtNum = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
export const fmtInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

export function fmtUsd(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const d = digits ?? (v !== 0 && Math.abs(v) < 0.01 ? 4 : 2);
  return `$${v.toFixed(d)}`;
}

export const fmtPct = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
