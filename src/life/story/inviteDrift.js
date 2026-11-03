// An invitation's clerk answer, tidied (plan 020 H4 follow-up). Used only by resolvePlan: the claim path and validateExtraction are untouched. It turns the
// ordinary ways a clerk writes down a stated time ("8pm", "this_evening", "saturday") into the schema's forms, and a bad optional field into nothing, so one sloppy
// field doesn't lose a real invitation. It only normalises what's clearly stated: anything ambiguous refuses, with its own code, because a wrong plan is worse than none.
// It computes no dates: every day it names is a relative word that the reconciler resolves in the world's timezone. A clock time with no day word is left without one, so the
// reconciler takes it as the next occurrence, however it was written; a day he said out loud that has already gone fails the later checks. Pure; nothing is logged.
import { DAY_PARTS, RELATIVE_WHEN, WEEKDAYS, parseJsonObject, realDate } from './schema.js';
import { localParts } from '../clock.js';

const REL = Object.freeze({
  this_evening: ['today', 'evening'], evening: ['today', 'evening'], this_afternoon: ['today', 'afternoon'], afternoon: ['today', 'afternoon'],
  this_morning: ['today', 'morning'], morning: ['today', 'morning'], this_night: ['tonight', null], night: ['tonight', null],
  tomorrow_morning: ['tomorrow', 'morning'], tomorrow_afternoon: ['tomorrow', 'afternoon'], tomorrow_evening: ['tomorrow', 'evening'], tomorrow_night: ['tomorrow', 'night'],
  weekend: ['this_weekend', null], the_weekend: ['this_weekend', null],
});
const SHORT_DAYS = Object.freeze({ sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 });
const AFTER_MIDNIGHT_BEFORE = 5;   // "tonight at 1am" is the coming small hours
// The hours a part said out loud can hold. Generous: only a plain contradiction ("tomorrow morning at 8pm") refuses.
const PART_HOURS = Object.freeze({ morning: [4, 12], afternoon: [12, 18], evening: [16, 23], night: [19, 23] });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
const fail = (error) => ({ ok: false, error });

function weekdayOf(word) {
  const w = word.replace(/^(?:this|coming|next)_/, '');
  const full = WEEKDAYS.indexOf(w);
  if (full >= 0) return full;
  return Object.hasOwn(SHORT_DAYS, w) ? SHORT_DAYS[w] : -1;
}

/** A relative word → { relative, part } or null when it says nothing clear. A bare weekday said on that weekday could be today or next week: null. */
function relativeOf(value, { createdAt, tz }) {
  const w = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (RELATIVE_WHEN.includes(w)) return { relative: w, part: null };
  if (Object.hasOwn(REL, w)) return { relative: REL[w][0], part: REL[w][1] };
  const day = /^(?:this_|coming_)?[a-z]+$/.test(w) ? weekdayOf(w) : -1;
  if (day < 0) return null;
  const p = localParts(createdAt, tz);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return day === wd ? null : { relative: `next_${WEEKDAYS[day]}`, part: null };
}

/** A clock time → 'HH:MM' or null. Bare "8" could be morning or night: null. So could "8.30": a dotted time only reads as 24-hour from 13 up. */
export function clockOf(value) {
  if (typeof value !== 'string') return null;
  const dotted = /^(\d{1,2})\.\d{2}$/.exec(value.trim());
  if (dotted && Number(dotted[1]) < 13) return null;
  const t = value.trim().toLowerCase().replace(/\./g, (m, i, s) => (/\d\.\d/.test(s.slice(i - 1, i + 2)) ? ':' : ''));
  if (t === 'noon' || t === 'midday') return '12:00';
  if (t === 'midnight') return '00:00';
  const pad = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (m) {
    const [h, min] = [Number(m[1]), Number(m[2])];
    return h <= 23 && min <= 59 ? pad(h, min) : null;
  }
  m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(t);
  if (!m) return null;
  const [h12, min] = [Number(m[1]), Number(m[2] ?? 0)];
  if (h12 < 1 || h12 > 12 || min > 59) return null;
  return pad((h12 % 12) + (m[3] === 'pm' ? 12 : 0), min);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function whenOf(raw, ctx) {
  const out = { date: null, relative: null, time: null, part: null };
  // No time at all is a fact about the message, not drift: the validator refuses it as no_when.
  if (blank(raw)) return { ok: true, when: out };
  const v = typeof raw === 'string' ? { relative: raw } : raw;
  if (!isObj(v)) return fail('bad_when');

  let setPart = null;
  const rel = (value, code) => {
    const r = relativeOf(value, ctx);
    if (!r) return code;
    if (out.relative && out.relative !== r.relative) return code;
    out.relative = r.relative;
    if (r.part) setPart = r.part;
    return null;
  };
  if (!blank(v.relative)) {
    if (typeof v.relative !== 'string') return fail('bad_relative');
    const bad = rel(v.relative, 'bad_relative');
    if (bad) return fail(bad);
  }
  if (!blank(v.date)) {
    if (typeof v.date !== 'string') return fail('bad_date');
    const d = v.date.trim();
    if (ISO_DATE.test(d)) {
      if (!realDate(d)) return fail('bad_date');
      out.date = d;
    }
    else {
      const bad = rel(d, 'bad_date');
      if (bad) return fail(bad);
    }
  }
  if (!blank(v.time)) {
    out.time = clockOf(v.time);
    if (!out.time) return fail('bad_time');
  }
  if (!blank(v.part)) {
    const p = typeof v.part === 'string' ? v.part.trim().toLowerCase() : '';
    if (!DAY_PARTS.includes(p)) return fail('bad_part');
    if (setPart && setPart !== p) return fail('bad_part');
    out.part = p;
  } else if (setPart) out.part = setPart;

  // "tomorrow night at 1am" means the night after: a day no relative word here can name, and nothing here computes dates.
  const hour = out.time ? Number(out.time.slice(0, 2)) : null;
  if (out.relative === 'tomorrow' && out.part === 'night' && hour !== null && hour < AFTER_MIDNIGHT_BEFORE) return fail('bad_time');
  // A part from a drift word and a time outside it contradict each other. Which one was meant isn't ours to pick.
  const span = setPart ? PART_HOURS[setPart] : null;
  if (span && hour !== null && (hour < span[0] || hour > span[1])) return fail('bad_part');

  // "tonight at 12am" is the coming midnight, unless it's already the small hours.
  if (out.relative === 'tonight' && out.time && Number(out.time.slice(0, 2)) < AFTER_MIDNIGHT_BEFORE && localParts(ctx.createdAt, ctx.tz).hour >= AFTER_MIDNIGHT_BEFORE) out.relative = 'tomorrow';
  return { ok: true, when: out };
}

/**
 * raw (the clerk's text) → { ok: true, text } for validateExtraction, or { ok: false, error } with the code of what can't be read.
 * A bad optional field (minutes, place, summary, kind) becomes nothing; `when` never does, people that aren't a list refuse, and confidence is required.
 */
export function normalizeInviteExtraction(raw, { createdAt, tz }) {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return fail(parsed.error);
  const o = { ...parsed.value };
  const w = whenOf(o.when, { createdAt, tz });
  if (!w.ok) return w;
  o.when = w.when;
  if (typeof o.minutes === 'string' && /^\d{1,3}$/.test(o.minutes.trim())) o.minutes = Number(o.minutes.trim());
  else if (typeof o.minutes !== 'number') o.minutes = null;
  if (typeof o.place !== 'string') o.place = null;
  // Nothing there means nobody; anything else that isn't a list stays as it is and the validator refuses it (bad_people): dropped, it would open one-to-one with the inviter.
  if (typeof o.people === 'string') o.people = o.people.trim() ? [o.people] : [];
  else if (o.people === null || o.people === undefined) o.people = [];
  if (typeof o.summary !== 'string') o.summary = null;
  if (typeof o.kind !== 'string') o.kind = null;
  if (typeof o.confidence === 'string' && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(o.confidence.trim())) o.confidence = Number(o.confidence.trim());
  return { ok: true, text: JSON.stringify(o) };
}
