// What the clerk checks against (plan 020 E3), pure: a writer's own code-built sheet as numbered true lines, and the dated rows
// the code pass reads. Never the thread: a text is checked against the facts alone, and a thread could hold explicit lines (the
// explicit register never comes here, but its words may linger in a thread). No chat text enters: the sheets are built without it.
//
//   sceneGrounding(sheet, { startAt, endAt, tz, relWhen, castNames }) · phoneGrounding(sheet, { at, tz, plans, castNames }) ·
//   journalGrounding(bullets, { startAt, tz, relWhen, castNames }) → { lines: [...], rows: [...], names: [...], afterwards: [...], atHour }
// relWhen comes from phone/facts.js through the worker's seam (only story/index.js imports phone/*).
import { contentProblem } from '../desire.js';
import { hasIdentifier } from '../schema.js';
import { localParts, zonedToUnix, addDays } from '../../clock.js';
import { rowsFromLines, rowFromLine } from './timeWords.js';

export const LINES_MAX = 40;
export const LINE_MAX = 240;
export const GROUNDING_MAX_BYTES = 6144;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null);
const kv = (k, v) => (str(v) ? `${k}: ${str(v)}` : null);
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
// A standing note runs to 620 characters and LINE_MAX would cut it: one true line per sentence, so the clerk can cite each.
const noteLines = (label, note) => (str(note?.text) ?? '').split(/(?<=[.!?])\s+/).filter(Boolean)
  .map(l => `${label}${str(note?.asOf) ? ` (as of ${str(note.asOf)})` : ''}: ${l}`);
const firstNames = (names) => [...new Set(names.flatMap(n => String(n ?? '').split(/\s+/)).filter(w => w.length >= 2))];

/** Only lines fit to send: short, no identifiers, nothing explicit. */
function finish(lines, { rows = [], names = [], afterwards = [], atHour = 12, problem = contentProblem } = {}) {
  const out = [];
  let bytes = 0;
  for (const raw of lines) {
    const l = str(raw);
    if (!l || hasIdentifier(l) || problem(l)) continue;
    const line = l.slice(0, LINE_MAX);
    bytes += Buffer.byteLength(line, 'utf8') + 8;
    if (out.length >= LINES_MAX || bytes > GROUNDING_MAX_BYTES) break;
    out.push(line);
  }
  return { lines: out, rows, names, afterwards, atHour };
}

const hourAt = (at, tz) => (tz && Number.isFinite(at) ? localParts(at, tz).hour : 12);

/** The scene's sheet (scenes/facts.js buildFactSheet), read at the outing's end: that's "now" for its time words. */
export function sceneGrounding(sheet, { startAt, endAt, tz, relWhen = null, castNames = [], problem } = {}) {
  if (!isObj(sheet)) return finish([]);
  const t = isObj(sheet.time) ? sheet.time : {};
  const people = Array.isArray(sheet.people) ? sheet.people : [];
  const names = firstNames([...people.map(p => p?.name), ...castNames]);
  const lines = [
    kv('activity', sheet.activity),
    kv('place', sheet.place?.words),
    kv('time', [t.day, t.from && t.to ? `${t.from}–${t.to}` : null, t.daypart, Number.isFinite(t.minutes) ? `${t.minutes} min` : null].filter(Boolean).join(', ')),
    kv('he got there by', t.travel),
    sheet.weather?.condition ? kv('weather', sheet.weather.condition) : null,
    kv('how it went', sheet.outcome),
    kv('the owner\'s note on it', sheet.tone),
    kv('the owner\'s intent', sheet.ownerIntent),
    ...people.flatMap(p => [
      kv('with him', `${p?.name} (${p?.relation})${p?.firstMeet ? ', meeting him for the first time' : ''}`),
      kv(`${p?.name} hometown`, p?.hometown),
      kv(`last saw ${p?.name}`, p?.lastSaw),
      ...list(p?.history).map(h => kv(`history with ${p?.name}`, h)),
      kv(`last time out with ${p?.name}`, [p?.lastTime?.ending ? `ended ${String(p.lastTime.ending).replace(/_/g, ' ')}` : null, p?.lastTime?.highlight].filter(Boolean).join('; ')),
    ]),
    ...list(sheet.together).map(l => `together before: ${l}`),
    ...list(sheet.afterwards).map(l => `afterwards: ${l}`),
    ...list(sheet.plansAfter).map(l => `planned next with them: ${l}`),
    ...list(sheet.phoneDuring).map(l => `his phone during it: ${l}`),
    ...list(sheet.trace?.lines).map(l => `how it went, in order: ${l}`),
    // Last, so under the cap the outing itself always stays: 019, 020 D2, D3, B, the rest of what the writer read. A check without
    // these calls a true line unsupported.
    ...people.flatMap(p => [
      ...list(p?.commitments).map(c => kv(`he said he would, to ${p?.name}`, c)),
      ...noteLines(`how things stand with ${p?.name}`, p?.standing),
      ...list(p?.historyAfter).map(h => kv(`history with ${p?.name}, since`, h)),
      ...[...list(p?.beats), ...list(p?.beatsAfter)].map(b => kv(`lately with ${p?.name}`, b.replace(/_/g, ' '))),
      kv(`texting with ${p?.name}`, p?.texting),
    ]),
    ...list(sheet.hisViews).map(l => `what he makes of it: ${l}`),
  ];
  const opts = { names };
  const rows = rowsFromLines([...list(sheet.together), ...list(sheet.plansAfter)], opts);
  for (const p of people) {
    const r = rowFromLine(str(p?.lastSaw) ?? '', opts);
    if (r) rows.push(r);
  }
  // The outing itself: "tonight" for a scene is the scene.
  if (tz && typeof relWhen === 'function' && Number.isFinite(startAt) && Number.isFinite(endAt)) {
    const body = `${sheet.activity ?? ''} at ${sheet.place?.words ?? ''}`;
    for (const at of [startAt, Math.max(startAt, endAt - 60)]) {
      const line = `${relWhen(at, endAt, tz)}: ${body}`;
      const row = rowFromLine(line, { names });
      if (row) rows.push({ ...row, names: firstNames(people.map(p => p?.name)), past: true });
    }
  }
  return finish(lines, { rows, names, afterwards: list(sheet.afterwards), atHour: hourAt(endAt, tz), problem });
}

/** A text's sheet (phone/facts.js buildSheet), minus the thread. `plans`: the plans as they stand now, a plan this text just agreed included. */
export function phoneGrounding(sheet, { at, tz, plans = null, castNames = [], problem } = {}) {
  if (!isObj(sheet)) return finish([]);
  const h = isObj(sheet.him) ? sheet.him : {};
  const t = isObj(sheet.them) ? sheet.them : {};
  const planLines = Array.isArray(plans) ? list(plans) : list(sheet.plans);
  const recent = list(sheet.recent);
  const them = firstNames([t.name]);
  const names = firstNames([t.name, ...castNames]);
  const lines = [
    kv('he is', [h.name, h.job].filter(Boolean).join(', ')),
    kv('his home', h.from),
    kv('right now he is', sheet.now),
    kv('the time', [sheet.time?.day, sheet.time?.at, sheet.time?.daypart].filter(Boolean).join(', ')),
    kv('the other person', `${t.name} (${t.relation})`),
    kv(`${t.name} hometown`, t.hometown),
    kv('they last saw each other in person', t.lastSeen ?? 'not in the last 45 days'),
    ...list(t.lately).map(l => kv(`${t.name} lately`, l)),
    kv('last time out together', t.lastTime),
    ...(recent.length ? recent.map(l => `his recent days: ${l}`) : ['his recent days: nothing with anyone in the last two days']),
    ...(planLines.length ? planLines.map(l => `his plans: ${l}`) : ['his plans: none set']),
    kv('a dream', sheet.dreamt),
    kv('why this text', sheet.why),
    kv('the owner\'s note for this text (he may say this)', sheet.gist),
    kv('how this chat started', sheet.setup),
    // Last, so under the cap the text's own facts always stay: 020 D3, D2, B.
    ...list(sheet.commitments).map(l => `what he has said he would do: ${l}`),
    ...noteLines(`how things stand with ${t.name}`, t.standing),
    ...list(t.latelyAfter).map(l => kv(`${t.name} lately, since`, l)),
    ...list(sheet.hisViews).map(l => `what he makes of them: ${l}`),
  ];
  const opts = { names };
  const rows = rowsFromLines([...recent, ...planLines, str(t.lastSeen) ?? ''], opts);
  // The last-seen line and the recent [together] lines are both with them; the rest is his alone.
  const seen = str(t.lastSeen);
  for (const r of rows) if (seen && r.line === seen) { r.together = true; r.names = them; }
  return finish(lines, { rows, names, afterwards: [], atHour: hourAt(at, tz), problem });
}

/** A journal part's own bullets ("19:30 went: …"), each dated inside its night's window [startAt, +1 day). */
export function journalGrounding(bullets, { startAt, tz, relWhen = null, castNames = [], problem } = {}) {
  const items = list(bullets);
  const names = firstNames(castNames);
  if (!items.length) return finish([]);
  const dated = [];
  if (tz && typeof relWhen === 'function' && Number.isFinite(startAt)) {
    const p = localParts(startAt, tz);
    const midnight = zonedToUnix(p.year, p.month, p.day, 0, 0, tz);
    const next = addDays(midnight, 1, tz);
    for (const b of items) {
      const m = /^(\d{2}):(\d{2}) (.*)$/.exec(b);
      if (!m) continue;
      const hh = Number(m[1]);
      const at = (hh < p.hour ? next : midnight) + hh * 3600 + Number(m[2]) * 60;
      dated.push({ at, body: m[3] });
    }
  }
  const anchor = dated.length ? Math.max(...dated.map(d => d.at)) : null;
  const rows = anchor === null ? [] : rowsFromLines(dated.map(d => `${relWhen(d.at, anchor, tz)}: ${d.body}`), { names });
  return finish(items, { rows, names, atHour: hourAt(anchor, tz), problem });
}
