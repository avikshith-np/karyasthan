// Public site (spec 013, plan "Public side"): the raw public view (life facade
// publicRaw) → the public.json document. Resolves person refs to opted-in
// display names or "a friend", maps internal ids to salted public ids, drops
// the home place, snaps every other place to a 0.01° cell centre, builds
// labels, stats and the weekly recap in code, and cleans every string with the
// scrubber (a refused optional string → null; a refused label → the row's
// generic label; a refused name → the item is left out). Pure: the caller
// validates the result (schema.js) before anything is written.

import crypto from 'crypto';
import { FICTION, GRID, SCENE_ENDINGS, SCENE_MAX, SCENE_PARAS_MAX, SCENE_TEXT_MAX, SCENE_SCHEMA_VERSION, validateScene,
  WALLET_SCHEMA_VERSION, WALLET_CATEGORIES, WALLET_ITEMS_MAX, WALLET_DAYS_MAX,
  PHONE_SCHEMA_VERSION, PHONE_THREADS_MAX, PHONE_THREAD_MESSAGES_MAX, PHONE_MESSAGES_MAX, PHONE_TEXT_MAX, DREAMS_MAX, DREAMS_SCHEMA_VERSION, DREAM_FRAGMENT_MAX, DREAM_TONES, DREAM_VIVID_MAX, LIVE_BEATS_MAX, LIVE_PHASES, LIVE_PRIVATE_LINE, LIVE_SCHEMA_VERSION, LIVE_WITH_MAX, MIND_ROWS_MAX, MIND_SCHEMA_VERSION, THOUGHTS_MAX, THOUGHTS_SCHEMA_VERSION, THOUGHT_TEXT_MAX } from './schema.js';
import { normalizeName } from './scrub.js';

const DAY = 86400;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const r1 = (v) => (finite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (finite(v) ? Math.round(v * 100) / 100 : null);

export const HARD_STRETCH_LINE = 'Going through a hard stretch.';

const LABELS = {
  work: 'Working', meeting: 'In a meeting', lunch: 'Lunch', breakfast: 'Breakfast', dinner: 'Dinner', snack: 'A snack',
  free: 'Free time', sleep: 'Asleep', commute: 'On the way', rest: 'Resting', gym: 'Working out', 'eat-out': 'Eating out',
  movie: 'At the movies', coffee: 'Coffee', cafe: 'Coffee', walk: 'A walk', errand: 'Running errands', shopping: 'Shopping',
  groceries: 'Getting groceries', tv: 'Watching TV', read: 'Reading', reading: 'Reading', gaming: 'Gaming', cook: 'Cooking',
  cooking: 'Cooking', run: 'A run', visit: 'Visiting', call: 'On a call', social: 'Hanging out', leisure: 'Taking it easy',
  out: 'Out', chores: 'Chores', nap: 'A nap', career: 'An interview',
};
const HOME_LABELS = {
  work: 'Working from home', meeting: 'In a meeting (from home)', free: 'Free time at home', rest: 'Resting at home',
  tv: 'Watching TV at home', breakfast: 'Breakfast at home', lunch: 'Lunch at home', dinner: 'Dinner at home',
};
const MEAL_KINDS = new Set(['breakfast', 'lunch', 'dinner', 'snack']);
const OUTING_PLACE_KINDS = new Set(['restaurant', 'bar', 'cinema', 'park', 'sports', 'cafe', 'streetfood']);
const SKY_OF = (valence, arousal) => {
  if (!finite(valence)) return 'fair';
  if (valence >= 0.45) return 'sunny';
  if (valence >= 0.15) return 'fair';
  if (valence >= -0.15) return 'cloudy';
  if (valence >= -0.45 || !finite(arousal) || arousal < 0.6) return 'grey';
  return 'stormy';
};

function humanize(kind) {
  const s = String(kind || 'activity').split(':')[0].replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Activity';
}

function kindCode(kind) {
  const k = String(kind || 'activity').toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return k || 'activity';
}

export function snap(v) {
  if (!finite(v)) return null;
  return Math.round((Math.floor(v / GRID) * GRID + GRID / 2) * 1000) / 1000;
}

function isoWeek(unixSec, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(unixSec * 1000));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const d = new Date(Date.UTC(g('year'), g('month') - 1, g('day')));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((d - y0) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function dateKeyTz(unixSec, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSec * 1000));
}

function ageFrom(birthdate, at, tz) {
  if (typeof birthdate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
  const [y, m, d] = birthdate.split('-').map(Number);
  const [ny, nm, nd] = dateKeyTz(at, tz).split('-').map(Number);
  return ny - y - (nm < m || (nm === m && nd < d) ? 1 : 0);
}

/**
 * build({ raw, persona, people, journal, resolvePerson, scrubber, salt, venueWords, scenes }) → document
 *   venueWords      text → text with every venue name as its kind word (life.venueKindWords)
 *   phone           019: raw.phone rows joined with their text (life.publicPhone), or null → no
 *                   `phone` key (an engine without 019, or the text read failed)
 *   scenes          016: raw.scenes rows joined with their text (life.publicScenes), or null → no
 *                   `scenes` key (the owner switched public scenes off, or none could be read)
 *   people          opted-in rows [{ personJid, publicId, displayName }]
 *   resolvePerson   jid → canonical person jid | null
 */
export function build({ raw, persona = {}, people = [], journal = [], resolvePerson = () => null, scrubber, salt, venueWords = null, scenes = null, phone = null, feed = null }) {
  if (!raw || !scrubber || typeof salt !== 'string') throw new Error('build: missing input');
  const tz = raw.tz;
  const at = raw.at;
  const pid = (prefix, id) => `${prefix}_${crypto.createHash('sha256').update(`${salt}|${prefix}|${id}`).digest('hex').slice(0, 10)}`;
  const clean = (s, max) => scrubber.clean(s, max);

  // ── people refs ──
  const optByJid = new Map(people.map((p) => [p.personJid, p]));
  const friends = [];
  for (const p of people) {
    const name = clean(p.displayName, 40);
    if (name && /^f_[0-9a-f]{12}$/.test(p.publicId)) friends.push({ id: p.publicId, name });
  }
  const friendOk = new Set(friends.map((f) => f.id));
  const friendName = new Map(friends.map((f) => [f.id, f.name]));
  const refOf = (jid) => {
    if (typeof jid !== 'string' || !jid) return 'friend';
    let canon = null;
    try { canon = resolvePerson(jid); } catch { canon = null; }
    const row = canon ? optByJid.get(canon) : null;
    return row && friendOk.has(row.publicId) ? row.publicId : 'friend';
  };
  const refName = (ref) => (ref === 'friend' ? 'a friend' : friendName.get(ref) ?? 'a friend');

  // ── places ──
  const placeById = new Map();
  const places = [];
  // Pins in a home's own 0.01° cell would point at it: those places are listed, never
  // pinned. Every home counts — the current one and any place marked home (a former
  // home, a pending move's target, kind home: publicView.homeIdsOf).
  const cellOf = (p) => (p && finite(p.lat) && finite(p.lon) ? `${snap(p.lat)},${snap(p.lon)}` : null);
  const homeCells = new Set((raw.places || []).filter((p) => p.home || p.id === raw.self?.homePlaceId).map(cellOf).filter(Boolean));
  const currentHome = (raw.places || []).find((p) => p.id === raw.self?.homePlaceId);
  const homeKnown = !!cellOf(currentHome);
  for (const p of raw.places || []) {
    if (p.home || p.id === raw.self?.homePlaceId) continue;
    const name = clean(p.name, 80);
    if (!name) continue;
    const inHomeCell = !homeKnown || homeCells.has(cellOf(p)) || !cellOf(p);   // no known home → no pins at all
    const out = { id: pid('p', p.id), name, kind: p.kind ? kindCode(p.kind) : null, lat: inHomeCell ? null : snap(p.lat), lon: inHomeCell ? null : snap(p.lon) };
    placeById.set(p.id, { ...out, rawKind: p.kind });
    places.push(out);
  }
  const placeOf = (id) => (id ? placeById.get(id) ?? null : null);

  // ── cast ──
  const castById = new Map();
  for (const c of raw.cast || []) {
    const name = clean(c.name, 60);
    if (!name) continue;
    castById.set(c.id, { id: pid('c', c.id), name, first: name.split(' ')[0] });
  }
  const castRefs = (ids) => (ids || []).map((id) => castById.get(id)?.id).filter(Boolean).slice(0, 8);

  // ── 016 scenes (export-contract.md): fictional cast only, never home, heavy or a real person ──
  const sceneList = Array.isArray(scenes)
    ? buildScenes({ raw, persona, scenes, scrubber, venueWords, pid, castById, placeOf, tz })
    : null;
  // A past span carries its scene: by the span's event id when the raw row has one, else its start + kind.
  const sceneByAct = new Map((sceneList || []).map((x) => [x.activityEventId, x.out.id]));
  const sceneByAtKind = new Map((sceneList || []).map((x) => [`${x.out.at}|${x.out.kind}`, x.out.id]));
  const sceneOfRow = (r, row) => (sceneList && row.end !== null && row.kind !== 'out'
    ? (Number.isSafeInteger(r.eventId) ? sceneByAct.get(r.eventId) : null) ?? sceneByAtKind.get(`${row.at}|${row.kind}`) ?? null
    : null);

  // ── rows ──
  function rowOf(r) {
    if (r.kind === 'out') {
      const ref = refOf(r.personRef);
      return { at: r.at, end: r.end ?? null, kind: 'out', label: `Out with ${refName(ref)}`, placeId: null, with: [ref] };
    }
    const kind = kindCode(r.kind);
    const base = kind.split(':')[0];
    const place = placeOf(r.placeId);
    let label;
    if (kind === 'commute') {
      label = r.placeId && r.placeId === raw.self?.homePlaceId ? 'Heading home' : place ? `On the way to ${place.name}` : 'On the way';
    } else if (r.home && HOME_LABELS[base]) {
      label = HOME_LABELS[base];
    } else {
      label = LABELS[base] ?? humanize(kind);
      if (place && base !== 'sleep') label += ` at ${place.name}`;
      else if (r.home && base !== 'sleep') label += ' at home';
    }
    label = clean(label, 120) ?? LABELS[base] ?? 'Busy';
    const row = { at: r.at, end: r.end ?? null, kind, label, placeId: place?.id ?? null, with: castRefs(r.castIds) };
    const sceneId = sceneOfRow(r, row);
    return sceneId ? { ...row, sceneId } : row;
  }

  function tickRow(t) {
    switch (t.type) {
      case 'meal': return null;   // meal blocks are spans already
      case 'soaked': return { at: t.at, end: null, kind: 'soaked', label: 'Got caught in the rain', placeId: null, with: [] };
      case 'beat': {
        const c = castById.get(t.castId);
        const text = clean(t.text, 120);
        return c && text ? { at: t.at, end: null, kind: 'beat', label: text, placeId: null, with: [c.id] } : null;
      }
      case 'arc.started': case 'arc.stage': case 'arc.ended': {
        const title = `${humanize(t.kind)}${t.type === 'arc.started' ? ' — a new chapter' : t.type === 'arc.ended' ? ' — chapter closed' : t.stage ? ` — ${humanize(t.stage).toLowerCase()}` : ''}`;
        const label = clean(title, 120);
        return label ? { at: t.at, end: null, kind: 'chapter', label, placeId: null, with: castRefs(t.castIds) } : null;
      }
      case 'birthday': {
        const c = castById.get(t.castId);
        return { at: t.at, end: null, kind: 'birthday', label: c ? `${c.first}'s birthday` : 'A birthday', placeId: null, with: c ? [c.id] : [] };
      }
      case 'family.call': return { at: t.at, end: null, kind: 'family-call', label: 'Called home', placeId: null, with: castRefs(t.castIds) };
      case 'family.occasion': return { at: t.at, end: null, kind: 'family', label: clean(`Family: ${humanize(t.kind).toLowerCase()}`, 120) ?? 'A family occasion', placeId: null, with: [] };
      case 'job_changed': return { at: t.at, end: null, kind: 'career', label: 'Started a new job', placeId: null, with: [] };
      case 'goal.done': return { at: t.at, end: null, kind: 'goal', label: 'Did something he meant to do', placeId: null, with: [] };
      default: return null;
    }
  }

  const today0 = raw.today0;
  const allRows = [];
  for (const r of raw.rows || []) {
    const row = 'type' in r ? tickRow(r) : rowOf(r);
    if (row && finite(row.at)) allRows.push(row);
  }
  const byDate = new Map();
  for (const row of allRows) {
    const t = Math.max(row.at, raw.from);
    const k = dateKeyTz(t, tz);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(row.at < raw.from ? { ...row, at: raw.from } : row);
  }
  const todayKey = dateKeyTz(at, tz);
  const days = [...byDate.keys()].filter((k) => k < todayKey).sort().reverse().slice(0, 30)
    .map((date) => ({ date, rows: byDate.get(date).slice(-200) }));
  const next = (raw.next || []).map(rowOf).slice(0, 13);

  // ── now ──
  const n = raw.now || {};
  let doing = null;
  if (n.span) {
    const row = rowOf(n.span);
    doing = { kind: row.kind, label: row.label, since: finite(n.span.at) ? n.span.at : null, until: finite(n.span.until) ? n.span.until : null, with: row.with };
  }
  const herePlace = n.home ? null : placeOf(n.placeId);   // publicView: only the current public span's place
  const travel = n.travel ? {
    mode: n.travel.mode ? clean(humanize(n.travel.mode).toLowerCase(), 24) : null,
    toName: n.travel.toHome ? null : placeOf(n.travel.to)?.name ?? null,
    toHome: n.travel.toHome === true,
  } : null;
  const now = {
    at,
    doing,
    where: { placeId: herePlace?.id ?? null, name: herePlace?.name ?? null, home: n.home === true && !(doing?.kind === 'out') },
    travel,
    mood: finite(n.valence) ? { sky: SKY_OF(n.valence, n.arousal), valence: Math.max(-1, Math.min(1, r1(n.valence))), arousal: Math.max(0, Math.min(1, r1(n.arousal ?? 0.5))) } : null,
    energy: finite(n.energy) ? Math.max(0, Math.min(100, Math.round(n.energy))) : null,
    vitals: vitalsOf(n.vitals),
    weather: n.weather ? { condition: n.weather.condition ? clean(n.weather.condition, 24) : null, tempC: finite(n.weather.tempC) ? n.weather.tempC : null, rain: n.weather.rain === true } : null,
    awake: n.asleep !== true,
    hardStretch: n.hardStretch === true,
  };

  // ── cast pages ──
  const beatsByCast = new Map();
  for (const t of raw.rows || []) {
    if (t.type !== 'beat') continue;
    const text = clean(t.text, 200);
    if (!text) continue;
    if (!beatsByCast.has(t.castId)) beatsByCast.set(t.castId, []);
    beatsByCast.get(t.castId).push({ at: t.at, text });
  }
  const cast = [];
  for (const c of raw.cast || []) {
    const ref = castById.get(c.id);
    if (!ref) continue;
    const m = c.metrics || {};
    cast.push({
      id: ref.id, name: ref.name, relation: c.relation ? clean(c.relation, 40) : null, job: c.job ? clean(c.job, 80) : null,
      status: c.status ? clean(c.status, 160) : null,
      closeness: r2(m.closeness), trust: r2(m.trust), tension: r2(m.tension),
      series: (c.series || []).slice(-61).map((p) => ({ at: p.at, closeness: r2(p.closeness), trust: r2(p.trust), tension: r2(p.tension) })),
      beats: (beatsByCast.get(c.id) || []).slice(-10).reverse(),
    });
  }

  // ── chapters ──
  const chapters = [];
  for (const a of raw.arcs || []) {
    const title = clean(humanize(a.category && a.category !== 'cast' ? a.category : a.kind), 80);
    if (!title) continue;
    const castIds = new Set(a.castIds || []);
    const beats = (raw.rows || []).filter((t) => (t.type === 'beat' && castIds.has(t.castId)) || (t.type?.startsWith('arc.') && t.arcId === a.id))
      .map((t) => ({ at: t.at, text: t.type === 'beat' ? clean(t.text, 200) : clean(t.type === 'arc.started' ? 'It began.' : t.type === 'arc.ended' ? 'It ended.' : `Moved on: ${humanize(t.stage).toLowerCase()}`, 200) }))
      .filter((b) => b.text).slice(-10);
    chapters.push({
      id: pid('a', a.id), kind: kindCode(a.kind || a.category), title, stage: a.stage ? clean(humanize(a.stage).toLowerCase(), 40) : null,
      status: a.status ? clean(a.status, 16) : null, startedAt: finite(a.startedAt) ? a.startedAt : null, endedAt: finite(a.endedAt) ? a.endedAt : null,
      with: castRefs(a.castIds).slice(0, 4), beats,
    });
  }
  chapters.sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0));

  // ── stats ──
  const spanRows = allRows.filter((r) => r.end !== null && r.kind !== 'beat');
  const sleepByDate = new Map();
  for (const s of raw.stats?.sleeps || []) sleepByDate.set(s.date, (sleepByDate.get(s.date) ?? 0) + s.minutes);
  const sleep = [...sleepByDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-60).map(([date, min]) => ({ date, hours: Math.min(24, r1(min / 60)) }));
  const meals = (raw.rows || []).filter((t) => t.type === 'meal' && MEAL_KINDS.has(t.kind)).length;
  const cafeVisits = (raw.rows || []).filter((r) => !('type' in r) && r.kind !== 'out' && placeById.get(r.placeId)?.rawKind === 'cafe').length;
  const outings = (raw.rows || []).filter((r) => !('type' in r) && (r.kind === 'out' || OUTING_PLACE_KINDS.has(placeById.get(r.placeId)?.rawKind))).length;
  const visits = new Map();
  for (const r of raw.rows || []) {
    if ('type' in r || r.kind === 'out' || r.kind === 'commute') continue;
    const p = placeOf(r.placeId);
    if (p) visits.set(p.id, (visits.get(p.id) ?? 0) + 1);
  }
  const firstDay = dateKeyTz(raw.from, tz);
  const stats = {
    since: firstDay,
    days: Math.max(0, Math.round((today0 - raw.from) / DAY)),
    sleep,
    meals,
    cafeVisits,
    rainyDays: (raw.stats?.rainyDays || []).length,
    soaked: (raw.rows || []).filter((t) => t.type === 'soaked').length,
    plans: { kept: raw.stats?.plansKept ?? 0, bailed: raw.stats?.plansBailed ?? 0 },
    outings,
  };

  // ── weekly recap (code-built) ──
  const weeks = new Map();
  for (const r of spanRows) {
    const w = isoWeek(r.at, tz);
    if (!weeks.has(w)) weeks.set(w, { from: r.at, to: r.end, rows: [] });
    const x = weeks.get(w);
    x.from = Math.min(x.from, r.at); x.to = Math.max(x.to, r.end); x.rows.push(r);
  }
  const recaps = [];
  for (const [week, w] of [...weeks.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 8)) {
    const lines = [];
    const sleepMin = w.rows.filter((r) => r.kind === 'sleep').map((r) => (r.end - r.at) / 60);
    if (sleepMin.length) lines.push(`Slept about ${r1(sleepMin.reduce((a, b) => a + b, 0) / sleepMin.length / 60)} hours a night.`);
    const workDays = new Set(w.rows.filter((r) => r.kind === 'work').map((r) => dateKeyTz(r.at, tz))).size;
    if (workDays) lines.push(`Worked ${workDays} day${workDays === 1 ? '' : 's'}.`);
    const outs = w.rows.filter((r) => r.kind === 'out').length;
    if (outs) lines.push(`Went out with friends ${outs} time${outs === 1 ? '' : 's'}.`);
    const seen = new Map();
    for (const r of w.rows) for (const id of r.with) if (id.startsWith('c_')) seen.set(id, (seen.get(id) ?? 0) + (r.end - r.at));
    const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id]) => [...castById.values()].find((c) => c.id === id)?.first).filter(Boolean);
    if (top.length) lines.push(clean(`Spent the most time with ${top.join(', ')}.`, 160) ?? 'Spent time with the usual people.');
    const wFrom = w.from;
    const wTo = w.to;
    const soaked = (raw.rows || []).filter((t) => t.type === 'soaked' && t.at >= wFrom && t.at <= wTo).length;
    if (soaked) lines.push(`Got soaked in the rain ${soaked === 1 ? 'once' : `${soaked} times`}.`);
    for (const t of (raw.rows || []).filter((x) => x.type?.startsWith('arc.') && x.at >= wFrom && x.at <= wTo).slice(0, 2)) {
      const l = clean(`${humanize(t.kind)}: ${t.type === 'arc.started' ? 'a new chapter began' : t.type === 'arc.ended' ? 'a chapter closed' : 'things moved on'}.`, 160);
      if (l) lines.push(l);
    }
    if (lines.length) recaps.push({ week, from: wFrom, to: wTo, lines: lines.slice(0, 8) });
  }

  // ── journal (never a night near a heavy onset: its self part may describe it) ──
  const jr = [];
  for (const j of journal || []) {
    if (nearHeavy(raw, j.night)) continue;
    // Every venue name ever recorded → its kind word (014 §8), again at every export:
    // a night published before a venue was added still names it in plain text.
    const words = typeof venueWords === 'function' ? venueWords(j.text) : j.text;
    if (typeof words !== 'string') continue;
    const text = clean(words, 1200);
    if (text && /^\d{4}-\d{2}-\d{2}$/.test(j.night) && finite(j.publishedAt)) jr.push({ night: j.night, text, publishedAt: j.publishedAt });
  }

  // ── votes ──
  const votes = [];
  for (const v of raw.votes || []) {
    const options = (v.options || []).map((o) => ({ id: String(o.id).toLowerCase(), label: clean(o.label, 100) })).filter((o) => o.label && /^[a-z][a-z0-9_-]{0,23}$/.test(o.id));
    // Fewer than two options left after scrubbing (a refused label) → no vote, not a crash.
    if (options.length < 2 || !finite(v.decideBy)) continue;
    // The question is code-built: the "go" option as a question ("Sunday run at Lakeside Park?").
    const go = options.find((o) => o.id === 'go') ?? options[0];
    const question = clean(`${go.label.replace(/[.?!]+$/, '')}?`, 140) ?? 'What should he do?';
    votes.push({ id: pid('d', v.decisionId), question, closesAt: v.decideBy, options });
  }

  // ── 018 wallet ──
  const wallet = raw.wallet ? buildWallet({ raw, clean, pid, placeOf, tz, at }) : null;

  // ── plan 020: live, thoughts, dreams, mind ──
  const feedOut = feed ? buildFeed({ raw, persona, feed, scrubber, venueWords, pid, castById, placeOf, tz }) : {};

  // ── 019 phone ──
  const phoneOut = Array.isArray(phone) ? buildPhone({ raw, persona, phone, scrubber, venueWords, pid, castById, tz }) : null;

  const name = clean(persona.displayName || persona.name, 40) ?? 'Him';
  return {
    v: 1,
    generatedAt: at,
    timezone: tz,
    fiction: FICTION,
    persona: { name, age: ageFrom(raw.self?.birthdate, at, tz) ?? (finite(persona.age) ? persona.age : null), city: null },
    now,
    today: { date: todayKey, rows: (byDate.get(todayKey) || []).slice(-200) },
    next,
    days,
    story: { chapters: chapters.slice(0, 30), recaps, hardStretchLine: now.hardStretch ? HARD_STRETCH_LINE : null },
    people: { cast, friends },
    city: { places, visits: [...visits.entries()].map(([placeId, count]) => ({ placeId, count })) },
    stats,
    journal: jr.slice(0, 60),
    votes: votes.slice(0, 5),
    ...(sceneList ? { scenes: sceneList.map((x) => x.out), scenesSchema: SCENE_SCHEMA_VERSION } : {}),
    ...(wallet ? { wallet, walletSchema: WALLET_SCHEMA_VERSION } : {}),
    ...(phoneOut ? { phone: phoneOut, phoneSchema: PHONE_SCHEMA_VERSION } : {}),
    ...feedOut,
  };
}

// ── plan 020 (contracts/public-json.md) ───────────────────────────────────────

/**
 * The feed's four keys from what index.js joined. feed: { live, thoughts: [{ id, at, text }], dreams: [{ eventId, at, recall, tone, castIds, placeIds, text, night }], mind }.
 * A key whose read failed is undefined there and stays out; a row that fails a check is dropped, never the document. No venue rule → no text at all.
 * Near a heavy onset or in a hard stretch, nothing.
 */
function buildFeed({ raw, persona, feed, scrubber, venueWords, pid, castById, placeOf, tz }) {
  if (typeof venueWords !== 'function') return {};
  const out = {};
  const places = Array.isArray(raw.places) ? raw.places : [];
  const homeIds = new Set(places.filter((p) => p.home || p.id === raw.self?.homePlaceId).map((p) => p.id));
  const homeNames = places.filter((p) => homeIds.has(p.id)).map((p) => normalizeName(p.name)).filter((n) => n.length >= 3);
  const region = regionPhrases(persona);
  // Code-built or not, every string takes the same road: venue names to kind words, no home, no region, scrubbed, refused if it still fails.
  const prose = (t, max) => {
    if (typeof t !== 'string' || !t.trim()) return null;
    let w;
    try { w = venueWords(t.replace(/\s+/g, ' ').trim()); } catch { return null; }
    if (typeof w !== 'string' || w.length > max || mentionsAny(w, homeNames) || mentionsAny(w, region)) return null;
    const c = scrubber.clean(w, max);
    return c && !scrubber.check(c) ? c : null;
  };
  const near = (at) => nearHeavy(raw, dateKeyTz(at, tz));
  const placeId = (id) => {
    if (!id || homeIds.has(id)) return null;
    const p = placeOf(id);
    return p && !p.home ? p.id : null;
  };

  if ('live' in feed) {
    let live = null;
    const v = feed.live;
    if (isObj(v) && !near(raw.at)) {
      if (v.private === true) {
        live = { at: Math.round(raw.at), startAt: null, until: null, placeId: null, with: [], phase: null, line: LIVE_PRIVATE_LINE, beats: [] };
      } else {
        const cast = Array.isArray(v.castIds) ? v.castIds : [];
        const line = prose(v.line, 160);
        if (line && line !== LIVE_PRIVATE_LINE && cast.length && cast.length <= LIVE_WITH_MAX && cast.every((id) => castById.has(id)) && LIVE_PHASES.includes(v.phase) && finite(v.startAt)) {
          const beats = [];
          for (const b of Array.isArray(v.beats) ? v.beats : []) {
            const text = finite(b?.at) ? prose(b.text, 120) : null;
            if (text) beats.push({ at: Math.round(b.at), text });
          }
          live = {
            at: Math.round(raw.at), startAt: Math.round(v.startAt), until: finite(v.until) ? Math.round(v.until) : null,
            placeId: placeId(v.placeId), with: cast.map((id) => castById.get(id).id), phase: v.phase, line, beats: beats.slice(-LIVE_BEATS_MAX),
          };
        }
      }
    }
    out.live = live;
    out.liveSchema = LIVE_SCHEMA_VERSION;
  }

  if (Array.isArray(feed.thoughts)) {
    const list = [];
    for (const t of feed.thoughts) {
      if (list.length >= THOUGHTS_MAX) break;
      if (!isObj(t) || !finite(t.at) || t.at < raw.from || t.at > raw.at || near(t.at)) continue;
      const text = prose(t.text, THOUGHT_TEXT_MAX);
      if (text) list.push({ id: pid('t', t.id), at: Math.round(t.at), kind: 'stream', text });
    }
    out.thoughts = list.sort((a, b) => b.at - a.at);
    out.thoughtsSchema = THOUGHTS_SCHEMA_VERSION;
  }

  if (Array.isArray(feed.dreams)) {
    const list = [];
    for (const d of feed.dreams) {
      if (list.length >= DREAMS_MAX) break;
      if (!isObj(d) || !finite(d.at) || d.at < raw.from || d.at > raw.at || near(d.at) || !DREAM_TONES[d.tone] || (d.recall !== 'vivid' && d.recall !== 'fragment')) continue;
      // Someone who has left his life: the words may name them, so it stays out.
      const cast = Array.isArray(d.castIds) ? d.castIds : [];
      if (!cast.every((id) => castById.has(id))) continue;
      const text = prose(d.text, d.recall === 'vivid' ? DREAM_VIVID_MAX : DREAM_FRAGMENT_MAX);
      if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.night))) continue;
      list.push({
        id: pid('dr', d.eventId), night: d.night, at: Math.round(d.at), recall: d.recall, tone: DREAM_TONES[d.tone], text,
        with: cast.map((id) => castById.get(id).id).slice(0, 3),
        placeIds: (Array.isArray(d.placeIds) ? d.placeIds : []).map(placeId).filter(Boolean).slice(0, 3),
      });
    }
    out.dreams = list.sort((a, b) => b.at - a.at);
    out.dreamsSchema = DREAMS_SCHEMA_VERSION;
  }

  if (Array.isArray(feed.mind) && !near(raw.at)) {
    const trend = (t) => (t === 'up' || t === 'down' ? t : 'steady');
    const round2 = (x) => Math.round(x * 100) / 100;
    const rows = feed.mind.map((r) => {
      if (!isObj(r) || !finite(r.value) || !finite(r.since) || r.subjectJid || String(r.topic ?? '').startsWith('cast:')) return null;
      if (r.kind !== 'interest' && r.kind !== 'opinion') return null;
      const topic = prose(r.label, 40);
      const why = prose(r.why, 160);
      return topic && why ? { kind: r.kind, topic, value: r.value, trend: trend(r.trend), why, since: Math.round(r.since) } : null;
    }).filter(Boolean);
    const strongest = (kind, centre) => rows.filter((r) => r.kind === kind).sort((a, b) => Math.abs(b.value - centre) - Math.abs(a.value - centre)).slice(0, MIND_ROWS_MAX);
    const interests = strongest('interest', 0.5).map((r) => ({ topic: r.topic, value: round2(Math.min(1, Math.max(0, r.value))), trend: r.trend, why: r.why, since: r.since }));
    const opinions = strongest('opinion', 0).map((r) => ({ topic: r.topic, stance: round2(Math.min(1, Math.max(-1, r.value))), trend: r.trend, why: r.why, since: r.since }));
    if (interests.length || opinions.length) {
      out.mind = { interests, opinions };
      out.mindSchema = MIND_SCHEMA_VERSION;
    }
  }
  return out;
}

// ── 019 phone (contracts/public-json.md "phone") ─────────────────────────────

const PHONE_BYTES_MAX = 160 * 1024;   // the phone block's own budget inside SIZE_MAX

/**
 * The public phone from publicView's raw rows joined with their texts (index.js phoneRows):
 * threads with fictional cast members the document lists, never near a heavy onset or in a
 * hard stretch, inside the export window. A text goes through the venue rule (venue names →
 * kind words), the home-name / region check and the scrubber; any refusal drops that message
 * (never the thread or the document). Newest kept: ≤ 60 per thread, ≤ 500 and ~160 KB in
 * all, ≤ 30 threads; a thread's messages oldest → newest, threads by their newest message.
 */
function buildPhone({ raw, persona, phone, scrubber, venueWords, pid, castById, tz }) {
  if (typeof venueWords !== 'function') return { threads: [] };   // no venue rule → no text at all
  const places = Array.isArray(raw.places) ? raw.places : [];
  const homeNames = places.filter((p) => p.home || p.id === raw.self?.homePlaceId).map((p) => normalizeName(p.name)).filter((n) => n.length >= 3);
  const region = regionPhrases(persona);
  const text = (t) => {
    if (typeof t !== 'string' || !t.trim()) return null;
    let w;
    try { w = venueWords(t.replace(/\s+/g, ' ').trim()); } catch { return null; }
    if (typeof w !== 'string' || mentionsAny(w, homeNames) || mentionsAny(w, region) || w.length > PHONE_TEXT_MAX) return null;
    return scrubber.clean(w, PHONE_TEXT_MAX);
  };
  const byCast = new Map();
  let total = 0;
  const rows = phone.filter((m) => isObj(m) && finite(m.at) && Number.isSafeInteger(m.eventId)).sort((a, b) => b.at - a.at || b.eventId - a.eventId);
  for (const m of rows) {
    if (total >= PHONE_MESSAGES_MAX) break;
    if (m.at < raw.from || m.at > raw.at || (m.dir !== 'out' && m.dir !== 'in')) continue;
    const c = castById.get(m.castId);
    if (!c || m.subjectJid || m.heavy === true) continue;                    // fictional cast only
    if (nearHeavy(raw, dateKeyTz(m.at, tz))) continue;
    const list = byCast.get(m.castId) ?? [];
    if (list.length >= PHONE_THREAD_MESSAGES_MAX) continue;
    const t = text(m.text);
    if (!t || scrubber.check(t)) continue;
    list.push({ id: pid('m', m.eventId), at: Math.round(m.at), dir: m.dir, text: t });
    byCast.set(m.castId, list);
    total++;
  }
  let threads = [...byCast.entries()].map(([castId, list]) => {
    const messages = list.slice().reverse();
    return { id: castById.get(castId).id, name: castById.get(castId).name, lastAt: messages[messages.length - 1].at, messages };
  }).sort((a, b) => b.lastAt - a.lastAt).slice(0, PHONE_THREADS_MAX);
  // Byte budget: drop the oldest messages over all threads until the block fits.
  const size = () => Buffer.byteLength(JSON.stringify({ threads }), 'utf8');
  while (threads.length && size() > PHONE_BYTES_MAX) {
    let oldest = null;
    for (const t of threads) if (!oldest || t.messages[0].at < oldest.messages[0].at) oldest = t;
    oldest.messages.shift();
    threads = threads.filter((t) => t.messages.length);
  }
  return { threads };
}

// ── 018 wallet (contracts/public-json.md "wallet") ─────────────────────────

const WALLET_LISTED = new Set(WALLET_CATEGORIES.filter((c) => c !== 'out'));

/**
 * The public wallet from publicView's raw half: listed entries (code-word labels,
 * scrubbed; a label the scrubber refuses drops its item), the chat / subject spends
 * as each day's outWithFriends total, the month's in / out / byCategory, every day of
 * the export window from his world's first day (newest first, zeros included), ≤ WALLET_ITEMS_MAX items newest first.
 */
function buildWallet({ raw, clean, pid, placeOf, tz, at }) {
  const w = raw.wallet;
  const amount = (x) => (finite(x) ? Math.round(x) : 0);
  const items = [];
  for (const e of Array.isArray(w.entries) ? w.entries : []) {
    if (!WALLET_LISTED.has(e.category) || (e.dir !== 'in' && e.dir !== 'out') || !finite(e.at)) continue;
    const label = clean(e.label, 60);
    const amt = amount(e.amount);
    if (!label || amt < 1) continue;
    items.push({ id: pid('w', e.eventId), at: e.at, dir: e.dir, amount: amt, category: e.category, label, placeId: placeOf(e.placeId)?.id ?? null });
  }
  const folded = (Array.isArray(w.folded) ? w.folded : []).filter((f) => finite(f.at) && finite(f.amount) && f.amount > 0);

  const inMonth = (t) => finite(w.monthStart) && t >= w.monthStart && t <= at;
  let monthIn = 0;
  let monthOut = 0;
  const byCategory = {};
  for (const it of items) {
    if (!inMonth(it.at)) continue;
    if (it.dir === 'in') monthIn += it.amount; else monthOut += it.amount;
    byCategory[it.category] = (byCategory[it.category] ?? 0) + it.amount;
  }
  for (const f of folded) {
    if (!inMonth(f.at)) continue;
    monthOut += amount(f.amount);
    byCategory.out = (byCategory.out ?? 0) + amount(f.amount);
  }

  // Every day of the window, today first.
  const keys = [];
  for (let t = at, i = 0; t >= raw.from && i < WALLET_DAYS_MAX; t -= 86400, i++) {
    const k = dateKeyTz(t, tz);
    if (!keys.includes(k)) keys.push(k);
  }
  // No empty days from before his world began (genesis' own local day is kept).
  const sinceKey = finite(w.since) ? dateKeyTz(w.since, tz) : null;
  if (sinceKey) keys.splice(0, keys.length, ...keys.filter((k) => k >= sinceKey));
  const shown = items.filter((it) => it.at >= raw.from).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).slice(0, WALLET_ITEMS_MAX);
  const days = keys.map((date) => {
    const its = shown.filter((it) => dateKeyTz(it.at, tz) === date);
    const fol = folded.filter((f) => f.at >= raw.from && dateKeyTz(f.at, tz) === date).reduce((a, f) => a + amount(f.amount), 0);
    return {
      date,
      in: its.filter((it) => it.dir === 'in').reduce((a, it) => a + it.amount, 0),
      out: its.filter((it) => it.dir === 'out').reduce((a, it) => a + it.amount, 0) + fol,
      outWithFriends: fol,
      items: its,
    };
  });
  const s = w.salary;
  return {
    month: w.month,
    balance: finite(w.balance) ? Math.round(w.balance) : null,
    salary: s && finite(s.amount) && Number.isInteger(s.payday)
      ? { amount: Math.round(s.amount), payday: s.payday, lastDate: finite(s.lastAt) ? dateKeyTz(s.lastAt, tz) : null, nextDate: finite(s.nextAt) ? dateKeyTz(s.nextAt, tz) : null }
      : null,
    monthIn, monthOut, byCategory, days,
  };
}

// ── 016 scenes ────────────────────────────────────────────────────────────

const AREA_MIN_KM = 2;
const ENDINGS = new Set(SCENE_ENDINGS);

/** Great-circle distance in km. */
export function distKm(aLat, aLon, bLat, bLon) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whole-phrase (normalized) hit of any of `phrases` in `text`. */
/**
 * Plan 020 D2: the optional `standing` key, ready and not wired into build() yet (the site's phase 4). rows = life.publicStanding();
 * castById = the document's cast. Fictional people the document lists, words through venue words, the home and region check and the scrubber; a
 * row that fails is dropped, and nothing at all near a heavy onset. → { people: [{ id, name, text, since }] }
 */
export const STANDING_SCHEMA_VERSION = 1;
const STANDING_TEXT_MAX = 600;
export function buildStanding({ rows, raw, persona, scrubber, venueWords, castById, tz }) {
  if (typeof venueWords !== 'function' || !Array.isArray(rows)) return { people: [] };
  const places = Array.isArray(raw?.places) ? raw.places : [];
  const homeNames = places.filter((p) => p.home || p.id === raw?.self?.homePlaceId).map((p) => normalizeName(p.name)).filter((n) => n.length >= 3);
  const region = regionPhrases(persona);
  const people = [];
  for (const r of rows) {
    const c = castById.get(r?.castId);
    if (!c || typeof r.text !== 'string' || !finite(r.validFrom) || nearHeavy(raw, dateKeyTz(r.validFrom, tz))) continue;
    let w;
    try { w = venueWords(r.text.replace(/\s+/g, ' ').trim()); } catch { continue; }
    if (typeof w !== 'string' || w.length > STANDING_TEXT_MAX || mentionsAny(w, homeNames) || mentionsAny(w, region)) continue;
    const t = scrubber.clean(w, STANDING_TEXT_MAX);
    if (!t || scrubber.check(t)) continue;
    people.push({ id: c.id, name: c.name, text: t, since: Math.round(r.validFrom) });
  }
  return { people };
}

function mentionsAny(text, phrases) {
  const norm = ` ${normalizeName(text)} `;
  return phrases.some((p) => p && norm.includes(` ${p} `));
}

/** "Testville, Northshire" → ['testville', 'northshire'] (each part ≥ 3 letters, normalized). */
function regionPhrases(persona) {
  const out = [];
  for (const v of [persona?.region, persona?.city]) {
    if (typeof v !== 'string') continue;
    for (const part of v.split(/[,/;|]+/)) { const n = normalizeName(part); if (n.length >= 3) out.push(n); }
  }
  return out;
}

/** One impression line for the first-met member (an array of {castId,text} or a plain string). */
function impressionOf(v, castId) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const hit = v.find((x) => x && x.castId === castId) ?? (v.length === 1 ? v[0] : null);
  return typeof hit?.text === 'string' ? hit.text : null;
}

/**
 * The public scenes. A scene leaves only when every check passes (fail closed, a failing
 * scene is dropped, never the document): inside the export window; mode 'full'; no real
 * person (no subject JID, every cast id a fictional cast member the export knows); not
 * heavy and not near a heavy onset; not at a home or an unknown place; text through the
 * venue rule (every venue name → its kind word: a negative moment never names a business),
 * no home name or region string, the scrubber; then the scene schema.
 * → [{ activityEventId, out }] (≤ 30, newest first)
 */
function buildScenes({ raw, persona, scenes, scrubber, venueWords, pid, castById, placeOf, tz }) {
  if (typeof venueWords !== 'function') return [];   // no venue rule → no scene text at all
  const places = Array.isArray(raw.places) ? raw.places : [];
  const homes = places.filter((p) => p.home || p.id === raw.self?.homePlaceId);
  const homeIds = new Set(homes.map((p) => p.id));
  if (raw.self?.homePlaceId) homeIds.add(raw.self.homePlaceId);
  const homeNames = homes.map((p) => normalizeName(p.name)).filter((n) => n.length >= 3);
  const region = regionPhrases(persona);
  const cellOf = (p) => (p && finite(p.lat) && finite(p.lon) ? `${snap(p.lat)},${snap(p.lon)}` : null);
  const homeCells = new Set(homes.map(cellOf).filter(Boolean));
  const homesKnown = homes.length > 0 && homes.every((h) => cellOf(h)) && !!cellOf(places.find((p) => p.id === raw.self?.homePlaceId));
  const placeRaw = new Map(places.map((p) => [p.id, p]));
  const privateText = (t) => mentionsAny(t, homeNames) || mentionsAny(t, region);
  // Model text → public text, or null (refused).
  const prose = (t, max) => {
    if (typeof t !== 'string' || !t.trim()) return null;
    let w;
    try { w = venueWords(t); } catch { return null; }
    if (typeof w !== 'string' || privateText(w)) return null;
    return scrubber.clean(w, max);
  };

  const out = [];
  for (const sc of scenes) {
    if (!isObj(sc) || !finite(sc.at) || !finite(sc.end) || sc.end < sc.at) continue;
    if (sc.end < raw.from || sc.at > raw.at) continue;                               // inside the window only
    if (sc.mode !== 'full' || sc.heavy === true || sc.redacted === true || sc.subjectJid) continue;
    if (sc.originKind !== undefined && sc.originKind !== 'self' && sc.originKind !== 'owner') continue;
    if (nearHeavy(raw, dateKeyTz(sc.at, tz))) continue;
    const castIds = Array.isArray(sc.castIds) ? sc.castIds : [];
    if (!castIds.length || castIds.length > 8 || castIds.some((id) => !castById.has(id))) continue;   // fictional cast only
    if (typeof sc.text !== 'string' || !ENDINGS.has(sc.ending)) continue;
    // Place: never a home; an unknown place id is treated as one (fail closed).
    let placeId = null;
    let area = null;
    if (sc.placeId !== null && sc.placeId !== undefined) {
      if (homeIds.has(sc.placeId) || !placeRaw.has(sc.placeId)) continue;
      const rp = placeRaw.get(sc.placeId);
      if (rp.home || rp.kind === 'home') continue;
      placeId = placeOf(sc.placeId)?.id ?? null;
      // Area: a real venue, not in any home's cell, ≥ 2 km from every home (homes without coordinates → none).
      if (rp.venue === true && typeof rp.area === 'string' && homesKnown && cellOf(rp) && !homeCells.has(cellOf(rp))
          && homes.every((h) => distKm(rp.lat, rp.lon, h.lat, h.lon) >= AREA_MIN_KM)) {
        area = prose(rp.area, 60);
      }
    }
    // Narration → ≤ 9 paragraphs, ≤ 2400 chars together; any refused paragraph drops the scene.
    const parts = sc.text.split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, SCENE_PARAS_MAX);
    const paras = [];
    let left = SCENE_TEXT_MAX;
    let bad = false;
    for (const part of parts) {
      if (left < 20) break;
      let t = part;
      if (t.length > left) { const cut = t.slice(0, left - 1); const sp = cut.lastIndexOf(' '); t = `${(sp > left / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`; }
      const c = prose(t, left);
      if (!c) { bad = true; break; }
      paras.push(c);
      left -= c.length;
    }
    if (bad || !paras.length) continue;
    const firstIds = (Array.isArray(sc.firstMeet) ? sc.firstMeet : []).filter((id) => castIds.includes(id));
    let impressions = null;
    if (firstIds.length && isObj(sc.impressions)) {
      const him = prose(impressionOf(sc.impressions.him, firstIds[0]), 160);
      const them = prose(impressionOf(sc.impressions.them, firstIds[0]), 160);
      impressions = him && them ? { him, them } : null;
    }
    const s1 = {
      id: pid('s', Number.isSafeInteger(sc.activityEventId) ? sc.activityEventId : sc.sceneEventId),
      at: Math.round(sc.at), end: Math.round(sc.end), placeId,
      with: castIds.map((id) => castById.get(id).id),
      firstMeet: firstIds.map((id) => castById.get(id).id),
      kind: kindCode(sc.kind),
      area,
      paras,
      highlight: prose(sc.highlight, 160),
      awkward: prose(sc.awkward, 160),
      topics: (Array.isArray(sc.topics) ? sc.topics : []).map((t) => prose(t, 40)).filter(Boolean).slice(0, 5),
      impressions,
      ending: sc.ending,
    };
    if (validateScene(s1, scrubber).length) continue;
    out.push({ activityEventId: sc.activityEventId, out: s1 });
  }
  return out.sort((a, b) => b.out.at - a.out.at).slice(0, SCENE_MAX);
}

/** True when a journal night falls in a heavy stretch (onset − 1 day … onset + 31 days) or one is active now. */
export function nearHeavy(raw, night) {
  if (raw?.now?.hardStretch === true) return true;
  const t = Date.parse(`${night}T12:00:00Z`) / 1000;
  if (!Number.isFinite(t)) return true;
  const win = Number.isFinite(raw?.heavyWindowSec) ? raw.heavyWindowSec : 31 * 86400;
  return (raw?.heavyAt || []).some((h) => t >= h - 2 * 86400 && t <= h + win);
}

/** His vitals as public figures: body 0–100, mood −100…100, arousal 0–100, sleep debt in hours (0–20), money; unknown → null. */
function vitalsOf(v) {
  const pct = (x) => (finite(x) ? Math.max(0, Math.min(100, Math.round(x))) : null);
  return {
    energy: pct(v?.energy), stress: pct(v?.stress), hunger: pct(v?.hunger), social: pct(v?.social),
    workPressure: pct(v?.workPressure),
    sleepDebtHours: finite(v?.sleepDebtHours) ? Math.max(0, Math.min(20, Math.round(v.sleepDebtHours * 10) / 10)) : null,
    mood: finite(v?.mood) ? Math.max(-100, Math.min(100, Math.round(v.mood))) : null,
    arousal: pct(v?.arousal),
    money: finite(v?.money) ? Math.max(-1e9, Math.min(1e9, Math.round(v.money))) : null,
  };
}

/** The public decision id of an internal one (votes pull maps tallies back). */
export function publicDecisionId(salt, decisionId) {
  return `d_${crypto.createHash('sha256').update(`${salt}|d|${decisionId}`).digest('hex').slice(0, 10)}`;
}

export const __test = { SKY_OF, isoWeek, kindCode, humanize, regionPhrases, impressionOf };
