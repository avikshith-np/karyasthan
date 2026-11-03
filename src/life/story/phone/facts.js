// A text turn's fact sheet (spec 019) — pure, code-built from the projection, the
// world and owner text; the worker does the few log reads (the thread, beats, the last
// scene) and passes them in `ctx`. No chat text, no JIDs, no real names: only his own
// names, the member's fictional name and kind words for places.
//
//   buildSheet(s, row, ctx) → { sheet, names }   (names = the validator's allow-list)
//   whyOf(trigger, ctx) → the "why now" line
import { stanceSheetLines } from '../../stanceSeam.js';
import { placeLabel, isHomeKind, kindWord, isVenueLike } from '../../places.js';
import { metricsOf, activeRomance } from '../romance.js';
import { hhmm, localParts, dayLabel } from '../../clock.js';
import { chatMadeDecision } from '../../planEdits.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const band3 = (v, lo, hi) => (!finite(v) ? 'ok' : v < lo ? 'low' : v > hi ? 'high' : 'ok');
const band01 = (v) => (!finite(v) ? 'unknown' : v < 0.34 ? 'low' : v < 0.67 ? 'medium' : 'high');

export function daypart(at, tz) {
  const h = localParts(at, tz).hour;
  return h < 5 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
}

// ── his recent days and his plans, in words (2026-11-01 live: the texts moved last night's pizza to
// "tonight", invented a 3 am cab and called a Friday-night snack "last night") ─────────────────────
// A time before 05:00 belongs to the night before (00:15 Sat is "Friday night").
const NIGHT_SHIFT = 5 * 3600;
const socialDay = (t, tz) => { const p = localParts(t - NIGHT_SHIFT, tz); return Math.round(Date.UTC(p.year, p.month - 1, p.day) / 86400000); };
const partOf = (h) => (h < 5 || h >= 21 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening');

/** When `t` was / will be, seen from `at`, in the words people use ("last night", "Fri night (the night before last)", "tomorrow morning") + the clock. */
export function relWhen(t, at, tz) {
  if (!finite(t) || !finite(at)) return null;
  const d = socialDay(at, tz) - socialDay(t, tz);
  const part = partOf(localParts(t, tz).hour);
  const wd = dayLabel(t - NIGHT_SHIFT, tz).split(' ')[0];
  let w;
  if (d === 0) {
    if (t <= at) w = part === 'night' ? 'earlier tonight' : `earlier this ${part}`;
    else w = part === 'night' ? 'tonight' : `later this ${part}`;
  } else if (d === 1) w = part === 'night' ? 'last night' : `yesterday ${part}`;
  else if (d === 2) w = part === 'night' ? `${wd} night (the night before last)` : `${wd} ${part} (2 days ago)`;
  else if (d > 2) w = `${wd}${part === 'night' ? ' night' : ` ${part}`} (${d} days ago)`;
  else if (d === -1) w = part === 'night' ? 'tomorrow night' : `tomorrow ${part}`;
  else w = `${wd} ${part} (in ${-d} days)`;
  return `${w}, ${dayLabel(t, tz)} ${hhmm(t, tz)}`;
}

const castNameOf = (s, id) => clean(s?.cast?.get?.(id)?.name ?? s?.story?.departed?.[id]?.name, 40);
const PUBLIC_ORIGINS = new Set(['self', 'owner']);
const WORK_KINDS = new Set(['work', 'meeting', 'work_office', 'work_home', 'commute']);
const kindText = (k) => String(k ?? 'time together').replace(/[_:-]+/g, ' ');

/**
 * His last two days as true lines (pure; `events` ascending, from the log): every outing with
 * someone from his world (what, where by kind word, with whom, from–to, how he got home and when),
 * when he fell asleep and woke. Chat-made or real-person events are left out. ≤ 10 lines, newest kept.
 */
export function timelineLines(events, s, { at, tz, castId = null } = {}) {
  const evs = (Array.isArray(events) ? events : []).filter(e => isObj(e) && finite(e.at) && e.at <= at
    && !e.subjectJid && PUBLIC_ORIGINS.has(e.originKind ?? 'self'));
  const out = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const p = isObj(e.payload) ? e.payload : {};
    // Work and meetings aren't outings (a meeting's attendees may be online): left out.
    if (e.type === 'activity.started' && Array.isArray(p.withCast) && p.withCast.length && !WORK_KINDS.has(p.kind)) {
      const names = p.withCast.map(id => castNameOf(s, id)).filter(Boolean);
      if (!names.length) continue;
      const ended = evs.slice(i + 1).find(x => x.type === 'activity.ended' && x.payload?.placeId === p.placeId);
      const endAt = ended?.at ?? null;
      // How he left: only a trip that starts by 30 min after the end (a later one is another outing).
      const trip = endAt ? evs.slice(i + 1).find(x => x.type === 'travel.started' && x.at >= endAt - 60 && x.at <= endAt + 30 * 60 && x.payload?.from === p.placeId) : null;
      const arrived = trip ? evs.slice(i + 1).find(x => x.type === 'travel.arrived' && x.at >= trip.at && x.payload?.to === trip.payload?.to) : null;
      const where = placeWords(s, p.placeId);
      const toWhere = trip ? placeWords(s, trip.payload?.to) : null;
      out.push(`${relWhen(e.at, at, tz)}: ${kindText(p.kind)}${where ? ` at ${where === 'home' ? 'his place' : `the ${where}`}` : ''} with ${names.join(', ')}`
        + (endAt ? `, ${hhmm(e.at, tz)}–${hhmm(endAt, tz)}` : ', still going on')
        + (trip ? `; then ${trip.payload?.mode ?? 'went'} ${toWhere === 'home' ? 'home' : `to ${toWhere ?? 'somewhere'}`}${arrived ? `, there by ${hhmm(arrived.at, tz)}` : ''}` : '')
        + (castId && p.withCast.includes(castId) ? ' [together]' : ''));
    } else if (e.type === 'sleep.started') {
      out.push(`${relWhen(e.at, at, tz)}: fell asleep`);
    } else if (e.type === 'woke') {
      out.push(`${relWhen(e.at, at, tz)}: ${p.interrupted ? `woken up${p.reason === 'woken_up' ? ' (by his phone)' : ''}` : 'woke up'}`);
    }
  }
  // ≤ 10 lines: the shared ones ([together]) are kept first, then the newest of the rest.
  if (out.length <= 10) return out;
  const keep = new Set(out.map((l, i) => (l.endsWith('[together]') ? i : -1)).filter(i => i >= 0).slice(-10));
  for (let i = out.length - 1; i >= 0 && keep.size < 10; i--) keep.add(i);
  return out.filter((_, i) => keep.has(i));
}

/**
 * His plans from now to the next 36 h (`aheadHours`) as true lines (pure): committed go / join-late
 * decisions, marked when they are with `castId`. A chat-made plan is only "busy" (no who, what or where).
 * `endOf(d)` → the plan's end (unix) or null. The phone's writers read 7 days: a plan agreed in
 * texts for next week must be on their sheet, or they agree to another one over it.
 */
export function planLines(s, { at, tz, castId = null, endOf = () => null, aheadHours = 36, skipDecisionId = null } = {}) {
  const ds = s?.decisions instanceof Map ? [...s.decisions.values()] : [];
  const out = [];
  for (const d of ds) {
    if (d?.status !== 'committed' || !['go', 'late'].includes(d.committed?.optionId)) continue;
    if (skipDecisionId !== null && d.id === skipDecisionId) continue;   // a scene's own outing isn't what's planned next
    const start = d.subject?.eventAt;
    if (!finite(start)) continue;
    const end = endOf(d) ?? start + 2 * 3600;
    if (end <= at || start > at + aheadHours * 3600) continue;
    const when = start <= at ? `right now (since ${hhmm(start, tz)}), until ${hhmm(end, tz)}` : `${relWhen(start, at, tz)}–${hhmm(end, tz)}`;
    // A plan made in a chat stays "busy" to a fictional person; his own plan a chat merely nudged is his (020).
    const fromChat = chatMadeDecision(d);
    if (fromChat) { out.push({ start, text: `${when}: busy (other plans)` }); continue; }
    const ids = Array.isArray(d.subject?.castIds) ? d.subject.castIds : [];
    const names = ids.map(id => castNameOf(s, id)).filter(Boolean);
    const label = clean(d.options?.find?.(o => o.id === d.committed.optionId)?.label, 80);
    const where = placeWords(s, d.subject?.placeId);
    // Someone coming to his home: say so (the option label reads "Go to <his flat>").
    const comingOver = where === 'home' && names.length && !ids.some(id => s?.cast?.get?.(id)?.relation === 'flatmate');   // the flatmate lives there
    const what = comingOver ? `${names.join(', ')} coming over to his place`
      : `${label ?? kindText(d.kind)}${where ? ` (${where === 'home' ? 'at his place' : `at the ${where}`})` : ''}${names.length ? ` with ${names.join(', ')}` : ''}`;
    out.push({ start, text: `${when}: ${what}${castId && ids.includes(castId) ? ' [with them — you both know about it]' : ''}` });
  }
  return out.sort((a, b) => a.start - b.start).map(x => x.text).slice(0, 6);
}

function relationWord(rel) {
  const r = String(rel ?? '');
  return r.startsWith('family:') ? r.slice(7) : r || 'friend';
}

/** A place as words (D9 of 016): homes by kind, a real venue always by its kind word. */
export function placeWords(s, id) {
  if (!id) return null;
  if (isHomeKind(s, id)) return id === s?.self?.homePlaceId ? 'home' : 'their place';
  const place = s?.places?.get?.(id);
  if (!place || isVenueLike(place)) return kindWord(place?.kind);
  return placeLabel(s, id) ?? kindWord(place.kind);
}

// What he is doing now, in words ("at work", "out at the cafe", "at home").
function nowWords(s) {
  const a = isObj(s?.activity) ? s.activity : {};
  const where = placeWords(s, a.placeId);
  const kind = String(a.kind ?? '').replace(/[_-]+/g, ' ');
  if (!kind) return where ? `at ${where}` : null;
  if (a.kind === 'work' || a.kind === 'meeting') return 'at work';
  if (a.kind === 'commute') return 'on the way somewhere';
  return `${kind}${where ? ` (${where === 'home' ? 'at home' : `at ${where}`})` : ''}`;
}

const ENDING_WORDS = { swapped_numbers: 'you swapped numbers', plan_to_meet: 'you said you would meet again', stayed_late: 'stayed late',
  left_early: 'left early', parted_badly: 'it ended badly' };

/** The "why now" line. ctx: { trigger, them (name), beat, scene, eventAt (outing time), place, side } */
export function whyOf(trigger, ctx = {}) {
  const n = ctx.them ?? 'them';
  const his = ctx.side === 'his';
  switch (trigger) {
    case 'owner': return his ? 'he wants to say something (the gist below)' : `${n} texts him first (the gist below)`;
    case 'reply': return his ? `answering ${n}'s last text` : `answering his last text`;
    case 'regenerate': return his ? 'his turn in the thread' : `${n}'s turn in the thread`;
    case 'after_scene': return `they were out together earlier${ctx.scene ? ` (${ctx.scene})` : ''}; ${his ? 'he texts after' : `${n} texts him after`}`;
    case 'birthday': return `it's ${n}'s birthday`;
    case 'news': return ctx.beat ? `${n}'s news: ${ctx.beat}` : `${n} has some news`;
    case 'on_my_way': return `he is on his way to meet ${n}${ctx.eventAt ? ` at ${ctx.eventAt}` : ''}${ctx.place ? `, ${ctx.place}` : ''}`;
    case 'backing_out': return `he can't make the plan with ${n} after all${ctx.eventAt ? ` (${ctx.eventAt}${ctx.place ? `, ${ctx.place}` : ''})` : ''}; he tells them`;
    case 'romance': return his ? `he can't stop thinking about ${n}` : `${n} has been thinking about him`;
    case 'evening': return `a quiet moment; he thought of ${n}`;
    case 'cast_first': return `${n} texts him out of the blue`;
    case 'desire': return his ? `he wants ${n}` : `${n} wants him`;
    default: return 'a text';
  }
}

/**
 * The sheet. ctx: { tz, at, persona: {displayName, aliases}, age, jobTitle, side: 'his'|'cast',
 * trigger, gist, tone, setup (a reply in an owner-started chat: its gist), chat ('long'), thread: [{who, when, text}],
 * beats: [kind/text], lastScene: {when, ending, highlight}, whyCtx }
 */
const DREAM_ON_MIND_SEC = 8 * 3600;
const DREAM_BOND_CLOSENESS = 0.6;
const DREAM_BOND_PASSION = 0.3;

export function buildSheet(s, row, ctx = {}) {
  const tz = ctx.tz;
  const at = finite(ctx.at) ? ctx.at : s.at;
  const c = s.cast.get(row.castId);
  const m = metricsOf(s, row.castId);
  const rom = activeRomance(s);
  const romance = rom && rom.partnerId === row.castId ? rom.arc.stage : null;
  const persona = ctx.persona ?? {};
  const name = clean(c?.name, 40) ?? 'them';
  // His state at the sheet's own moment (ctx.vitals): the projection's stop at the last event, hours ago on a quiet night.
  const v = ctx.vitals ?? s.vitals ?? {};
  const names = new Set();
  for (const w of name.split(' ')) names.add(w);
  for (const w of String(persona.displayName ?? '').split(/\s+/)) if (w) names.add(w);
  for (const a of persona.aliases ?? []) for (const w of String(a).split(/\s+/)) if (w) names.add(w);
  const last = ctx.lastScene;
  const sheet = {
    side: ctx.side,
    him: {
      name: clean(persona.displayName, 40) ?? 'him',
      age: finite(ctx.age) ? ctx.age : null,
      job: clean(ctx.jobTitle, 60),
      energy: band3(v.energy, 35, 70),
      stress: band3(v.stress, 30, 65),
      mood: band3(finite(v.mood?.valence) ? v.mood.valence : 0, -0.2, 0.3),
      // His home and his language mix (persona): the writers judge who would understand it.
      from: clean(persona.region, 80),
      speaks: clean(persona.language, 120),
    },
    now: nowWords(s),
    them: {
      name, relation: relationWord(c?.relation), pronouns: clean(c?.pronouns, 24),
      personality: clean(c?.personality, 200), speech: clean(c?.speech, 160), hometown: clean(c?.hometown, 80),
      closeness: band01(m.closeness), trust: band01(m.trust), tension: band01(m.tension),
      ...(romance ? { romance, passion: band01(m.passion) } : {}),
      lately: (ctx.beats ?? []).map(b => clean(b, 170)).filter(Boolean).slice(0, 3),
      lastSeen: clean(ctx.lastSeen, 120),
      lastTime: last ? [last.when, last.ending ? ENDING_WORDS[last.ending] ?? null : null, clean(last.highlight, 140)].filter(Boolean).join('; ') : null,
      // 020 D2: his side only (it's his view; the cast side keeps to FACTS_CAST). The note replaces "lately" up to its as-of; newer beats still show. Absent until a note exists.
      ...(ctx.side !== 'cast' && clean(ctx.standing?.text, 620) ? {
        standing: { text: clean(ctx.standing.text, 620), asOf: clean(ctx.standing.asOf, 24) },
        latelyAfter: (ctx.beatsAfter ?? []).map(b => clean(b, 170)).filter(Boolean).slice(0, 3),
      } : {}),
    },
    time: { day: tz ? dayLabel(at, tz) : null, at: tz ? hhmm(at, tz) : null, daypart: tz ? daypart(at, tz) : null },
    // Plan 020 D1: the moment every fact here holds. An explicit sheet stays as it was.
    ...(tz && ctx.register !== 'explicit' ? { asOf: `${dayLabel(at, tz)} ${hhmm(at, tz)}` } : {}),
    why: whyOf(ctx.trigger ?? row.trigger, { ...(ctx.whyCtx ?? {}), them: name, side: ctx.side }),
    gist: clean(ctx.gist, 200),
    tone: clean(ctx.tone, 24),
    ...(Array.isArray(ctx.askedEarlier) && ctx.askedEarlier.length ? { askedEarlier: ctx.askedEarlier } : {}),
    ...(clean(ctx.setup, 200) ? { setup: clean(ctx.setup, 200) } : {}),     // a reply in an owner-started chat: its gist
    ...(ctx.chat === 'long' ? { chat: 'long' } : {}),
    ...(ctx.urgeBand ? { urge: ctx.urgeBand } : {}),
    ...(ctx.register ? { register: ctx.register } : {}),
    thread: Array.isArray(ctx.thread) ? ctx.thread : [],
    recent: (Array.isArray(ctx.timeline) ? ctx.timeline : []).map(l => clean(l, 220)).filter(Boolean).slice(-10),
    plans: (Array.isArray(ctx.plans) ? ctx.plans : []).map(l => clean(l, 220)).filter(Boolean).slice(0, 6),
    ...(Array.isArray(ctx.commitments) && ctx.commitments.length ? { commitments: ctx.commitments.map(l => clean(l, 160)).filter(Boolean).slice(0, 4) } : {}),   // 020 D3
  };
  for (const p of String(sheet.now ?? '').split(/\s+/)) if (p) names.add(p.replace(/[()]/g, ''));
  // plan 020 G: he dreamt about them last night, if it was warm or neutral. To someone close, his first text of the thread that day, his own side, never on an explicit sheet.
  const dream = s.story?.dream;
  const bonded = romance || (finite(m?.closeness) && m.closeness >= DREAM_BOND_CLOSENESS) || (finite(m?.passion) && m.passion >= DREAM_BOND_PASSION);
  if (ctx.side !== 'cast' && ctx.firstTurnToday === true && bonded && finite(dream?.at) && at >= dream.at && at - dream.at < DREAM_ON_MIND_SEC
    && (dream.tone === 'good' || dream.tone === 'flat') && dream.castIds?.includes(row.castId) && sheet.register !== 'explicit') {
    sheet.dreamt = `${dream.tone === 'good' ? 'he had a nice dream about them last night' : 'they turned up in a dream of his last night, nothing much'} (at most once, only if natural)`;
  }
  // plan 020 B: what he makes of them, on his own side only. Absent until the owner approves a set. An explicit sheet stays as it was.
  if (ctx.side !== 'cast' && ctx.register !== 'explicit') {
    const views = stanceSheetLines({ castIds: [row.castId] });
    if (views.length) sheet.hisViews = views;
  }
  return { sheet, names: [...names].filter(Boolean) };
}
