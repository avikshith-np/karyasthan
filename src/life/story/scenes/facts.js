// The scene's fact sheet (spec 016, plan §P1.4) — pure, code-built from the
// projection, the world and owner text; the caller (worker.js) does the few log
// reads (beats, the previous scene, the trip there) and passes them in `ctx`.
// No chat text, no JIDs, no real names: cast members are labelled P1…Pn (output
// keys use the labels, mapped back in code), a real person is the literal token
// {FRIEND} (replaced at read time, so neither the input nor the stored text ever
// holds a real name).
//
//   buildFactSheet(s, session, ctx) → { sheet, labels: {P1: castId}, mode, outcome, outcomeBy, names }
//   codeOutcome(s, session, rng, ctx) → 'well'|'fine'|'flat'|'badly'   (deterministic per rng)
//   oneLiner(session, outcome, ctx) → the code fallback line
//   selfOnlyScene(session, outcome, ctx) → a real person's scene (D10/D17): code-built
//       sentences about HIM only — the outing, the place by its kind, the weather, his own
//       mood bands. Never a model call, never a word about the other person (the prompt
//       frame names them, only where they are).
import { stanceSheetLines } from '../../stanceSeam.js';
import { placeLabel, isHomeKind, kindWord, isVenueLike } from '../../places.js';
import { sliderFactor } from '../controls.js';
import { metricsOf } from '../romance.js';
import { hhmm, localParts, dayLabel } from '../../clock.js';
import { ownerDirected } from './detect.js';
import { homeLabel } from '../outing.js';

export const FRIEND = '{FRIEND}';
export const OUTCOMES = Object.freeze(['well', 'fine', 'flat', 'badly']);
/** A session this long is told as an arc (start, middle, end), with the longer narration cap. */
export const LONG_MINUTES = 180;
const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);
const OUTDOOR = new Set(['walk', 'park', 'hike', 'run', 'cycle', 'outing', 'picnic', 'beach']);
const BEAT_KINDS = new Set(['hobby', 'status', 'news', 'milestone']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const band3 = (v, lo, hi) => (!finite(v) ? 'ok' : v < lo ? 'low' : v > hi ? 'high' : 'ok');
const band01 = (v) => (!finite(v) ? 'unknown' : v < 0.34 ? 'low' : v < 0.67 ? 'medium' : 'high');

function daypart(at, tz) {
  const h = localParts(at, tz).hour;
  return h < 5 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
}

/** How a kind reads as words ("eat-out" → "eating out"). */
export function kindPhrase(kind) {
  const k = String(kind ?? '').replace(/^[a-z]+:/, '');
  return {
    'eat-out': 'eating out', eatout: 'eating out', hangout: 'hanging out', visit: 'a visit', movie: 'a movie',
    outing: 'an outing', walk: 'a walk', drinks: 'drinks', coffee: 'coffee', gym: 'the gym', followup: 'meeting up',
    meet: 'meeting up', party: 'a party', concert: 'a concert', game: 'a game', shopping: 'shopping',
  }[k] ?? k.replace(/[_-]+/g, ' ');
}

/**
 * The place as words for the model's sheet and the code text (plan §P1.4, D9): home kinds
 * by kind, a real (venue-like) place ALWAYS by its kind word — the model never sees or
 * writes a business's name; only the prompt frame names it, through placeLabel's negative
 * rule. A fictional world place keeps its name.
 */
export function placeWords(s, session) {
  const id = session.placeId;
  if (!id) return 'out';
  if (isHomeKind(s, id)) return id === s?.self?.homePlaceId ? 'his flat' : 'their place';
  const place = s?.places?.get?.(id);
  if (!place || isVenueLike(place)) return kindWord(place?.kind);
  return placeLabel(s, id) ?? kindWord(place.kind);
}

/**
 * The code outcome (plan §P1.4): one draw of `rng` over well|fine|flat|badly, weights
 * from mean closeness, max tension, his valence / energy / social battery, rain on an
 * outdoor kind, `badly` scaled by the drama slider (≤ 10 % at drama 1). ctx: { vitals, weather }.
 */
export function codeOutcome(s, session, rng, { vitals = null, weather = null } = {}) {
  const ms = session.castIds.map(id => metricsOf(s, id));
  const close = ms.length ? ms.reduce((a, m) => a + m.closeness, 0) / ms.length : 0.5;
  const tension = ms.length ? Math.max(...ms.map(m => m.tension)) : 0;
  const v = vitals ?? s?.vitals ?? {};
  const valence = finite(v.mood?.valence) ? v.mood.valence : (finite(v.valence) ? v.valence : 0);
  const w = { well: 0.35, fine: 0.35, flat: 0.2, badly: 0.1 };
  w.well += (close - 0.5) * 0.4 - tension * 0.2 + valence * 0.15;
  w.flat += -(close - 0.5) * 0.2 - valence * 0.1;
  w.badly += tension * 0.3;
  if (finite(v.energy) && v.energy < 30) w.flat += 0.1;
  if (finite(v.socialBattery) && v.socialBattery < 25) { w.flat += 0.1; w.badly += 0.03; }
  if (weather?.rain === true && OUTDOOR.has(String(session.kind).replace(/^[a-z]+:/, ''))) { w.flat += 0.1; w.badly += 0.03; }
  const drama = sliderFactor('drama', s);   // 0.5 … 1.5
  for (const k of OUTCOMES) w[k] = Math.max(0.01, w[k]);
  // `badly` scaled by drama, its SHARE capped at 10 % × drama / 1.5 (10 % at drama 1).
  const cap = 0.1 * (drama / 1.5);
  const rest = w.well + w.fine + w.flat;
  w.badly = Math.min(w.badly * drama, (cap * rest) / (1 - cap));
  const total = OUTCOMES.reduce((a, k) => a + w[k], 0);
  let r = (typeof rng === 'function' ? rng() : 0.5) * total;
  for (const k of OUTCOMES) {
    if (r < w[k]) return k;
    r -= w[k];
  }
  return 'fine';
}

const OUTCOME_WORDS = { well: 'it went well', fine: 'it was fine', flat: 'it was a bit flat', badly: "it didn't go well" };

/** The code-built fallback line (no effects). ctx: { names: {castId: name}, place } */
export function oneLiner(session, outcome, { names = {}, place = null } = {}) {
  const who = session.mode === 'self_only' ? FRIEND
    : session.castIds.map(id => names[id]).filter(Boolean).slice(0, 3).join(' and ') || 'friends';
  const what = kindPhrase(session.kind);
  const where = place && place !== 'out' ? ` at ${place}` : '';
  const head = `${what[0].toUpperCase()}${what.slice(1)}${where} with ${who}`;
  return `${head} — ${OUTCOME_WORDS[outcome] ?? OUTCOME_WORDS.fine}.`;
}

const ENERGY_LINE = { low: 'He was a little tired', ok: 'He was in an easy mood', high: 'He had plenty of energy' };
const MOOD_END = { low: 'and was glad to get home', ok: 'and headed home afterwards', high: 'and headed home in a good mood' };

/** A real person's scene (D10/D17): his side only, code-built. ctx: { place, weather, vitals } */
export function selfOnlyScene(session, outcome, { place = null, weather = null, vitals = null } = {}) {
  const what = kindPhrase(session.kind);
  const where = place && place !== 'out' ? ` at ${place}` : '';
  const head = `${what[0].toUpperCase()}${what.slice(1)}${where} — ${OUTCOME_WORDS[outcome === 'well' ? 'well' : 'fine']}.`;
  const v = vitals ?? {};
  const cond = clean(weather?.condition, 24);
  const sky = cond ? ` It was ${cond.toLowerCase()} out${finite(weather?.tempC) ? `, about ${Math.round(weather.tempC)}°C` : ''}.` : '';
  const energy = band3(v.energy, 35, 70);
  const mood = band3(finite(v.mood?.valence) ? v.mood.valence : 0, -0.2, 0.3);
  return `${head}${sky} ${ENERGY_LINE[energy]} ${MOOD_END[mood]}.`;
}

// 019: "6 texts in the days before, mostly flirty" (codes and counts only).
function textingWords(t) {
  if (!isObj(t) || !finite(t.count) || t.count < 1) return null;
  const top = Object.entries(isObj(t.tones) ? t.tones : {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  return `${t.count} text${t.count === 1 ? '' : 's'} in the days before${top ? `, mostly ${String(top).replace(/[^a-z]/g, '')}` : ''}`;
}

/** pinned #8: the sheet's true lines around the outing (each only when there is one). */
export function aroundOf(ctx = {}) {
  const lines = (v, n) => (Array.isArray(v) ? v.map(l => clean(l, 200)).filter(Boolean).slice(-n) : []);
  const out = {};
  const before = lines(ctx.together, 6);
  const after = lines(ctx.afterwards, AFTER_MAX);
  const plans = lines(ctx.plansAfter, 4);
  const phone = lines(ctx.phoneDuring, 5);
  if (phone.length) out.phoneDuring = phone;
  if (before.length) out.together = before;
  if (after.length) out.afterwards = after;
  if (plans.length) out.plansAfter = plans;
  if (isObj(ctx.planning)) out.planning = ctx.planning;
  return out;
}

function relationWord(rel) {
  const r = String(rel ?? '');
  return r.startsWith('family:') ? r.slice(7) : r || 'friend';
}

/**
 * The owner's line for this outing (the committed option's label), or null.
 * Only an owner-directed full scene. A chat-made outing and a real person get none.
 */
export function ownerIntentOf(s, session, { tone = null } = {}) {
  if (!session || session.mode !== 'full' || CHAT_ORIGINS.has(session.originKind)) return null;
  if (!ownerDirected(session, s, { tone })) return null;
  const d = session.decisionId && s?.decisions instanceof Map ? s.decisions.get(session.decisionId) : null;
  const opt = d?.options?.find?.(o => o.id === d.committed?.optionId);
  // A visit made before 2026-11-02 still reads "Go to <his home>": say who came over instead.
  if (typeof opt?.label === 'string' && /^Go to /.test(opt.label)) {
    const home = homeLabel(s, d.subject?.placeId, d.subject?.castIds);
    if (home) return home;
  }
  return clean(opt?.label, 160);
}

// ── what really happened around the outing (2026-11-02, pinned #8: the café scene had them
// leave together while he walked home alone and she came over at 17:30, and called a night
// out the night before "days earlier") ──────────────────────────────────────────────────────
const TRIP_VERB = { walk: 'walked', cab: 'took a cab', auto: 'took an auto', bus: 'took the bus', metro: 'took the metro', bike: 'rode', scooter: 'rode', car: 'drove' };
const AFTER_MAX = 4;

/**
 * Lines for what followed the outing (pure; `events` ascending, already filtered to his own
 * public events — not excluded, redacted, heavy or about a real person): how he left (alone or
 * with them) and when he got there, and any later time with the same people (≤ 6 h). ≤ 4 lines.
 */
export function afterwardsLines(events, s, session, tz) {
  if (!session || !Array.isArray(events) || !tz) return [];
  const end = session.endAt;
  const ids = new Set(session.castIds ?? []);
  const nameOf = (id) => clean(s?.cast?.get?.(id)?.name ?? s?.story?.departed?.[id]?.name, 40);
  const whereOf = (placeId) => {
    const kind = s?.places?.get?.(placeId)?.kind;
    if (placeId && placeId === s?.self?.homePlaceId) return 'his place';
    if (placeId && isHomeKind(s, placeId)) return 'their place';
    const word = String(kindWord(kind) ?? 'out').replace(/^(?:an?|the)\s+/, '');
    return word === 'out' ? 'the place' : `the ${word}`;
  };
  const evs = events.filter(e => isObj(e) && finite(e.at) && e.at >= end - 60 && e.at <= end + 6 * 3600);
  const out = [];
  const trip = evs.find(e => e.type === 'travel.started' && e.payload?.from === session.placeId && e.at <= end + 30 * 60);
  let skip = null;
  if (trip) {
    const arrived = evs.find(e => e.type === 'travel.arrived' && e.at >= trip.at && e.payload?.to === trip.payload?.to);
    const to = trip.payload?.to;
    const withSomeone = (cast) => (Array.isArray(cast) ? cast : []).some(id => ids.has(id));
    // A short wait at the place is a block of its own: he's going there to be with them if the next thing there is with them.
    // Not at his own place: someone there a little later came over, he didn't bring them.
    const waits = to !== s?.self?.homePlaceId;
    const started = arrived ? evs.filter(e => e.type === 'activity.started' && e.at >= arrived.at && e.at <= arrived.at + 30 * 60) : [];
    const next = (waits ? started.find(e => e.payload?.placeId === to && withSomeone(e.payload?.withCast)) : null) ?? started.find(e => e.at <= arrived.at + 20 * 60) ?? null;
    // Still on the way (a scene is written the moment the outing ends): who he's with comes from the plan in force, not a log that hasn't got there yet.
    const atTo = arrived ? [] : (Array.isArray(s?.plan?.blocks) ? s.plan.blocks : []).filter(b => b?.placeId === to && finite(b.start) && b.start >= trip.at - 60 && b.start <= trip.at + 3 * 3600);
    const planned = (waits ? atTo.find(b => b.start <= atTo[0].start + 30 * 60 && withSomeone(b.withCast)) : null) ?? atTo[0];
    const withThem = (next?.payload?.withCast ?? planned?.withCast ?? []).filter(id => ids.has(id));
    if (next && withThem.length) skip = next.id;
    const toWords = to && to === s?.self?.homePlaceId ? 'home' : `to ${whereOf(to)}`;
    out.push(`${hhmm(trip.at, tz)}: he ${TRIP_VERB[trip.payload?.mode] ?? 'went'} ${toWords}`
      + (withThem.length ? ` with ${withThem.map(nameOf).filter(Boolean).join(', ')}` : ' on his own')
      + (arrived ? `, there by ${hhmm(arrived.at, tz)}` : ''));
  } else if (session.home === true) {
    const next = evs.find(e => e.type === 'activity.started' && e.at >= end - 60);
    if (next && !(next.payload?.withCast ?? []).some(id => ids.has(id))) {
      const gone = [...ids].filter(id => s?.cast?.get?.(id)?.relation !== 'flatmate').map(nameOf).filter(Boolean);
      if (gone.length) out.push(`${hhmm(end, tz)}: ${gone.join(', ')} left; he stayed home`);
    }
  }
  for (const e of evs) {
    if (out.length >= AFTER_MAX) break;
    if (e.type !== 'activity.started' || e.id === skip || e.at < end) continue;
    const withThem = (e.payload?.withCast ?? []).filter(id => ids.has(id));
    if (!withThem.length) continue;
    const who = withThem.map(nameOf).filter(Boolean).join(', ');
    const where = whereOf(e.payload?.placeId);
    out.push(where === 'his place' && e.payload?.kind === 'visit'
      ? `${hhmm(e.at, tz)}: ${who} came over to his place`
      : `${hhmm(e.at, tz)}: ${kindPhrase(e.payload?.kind)} at ${where} with ${who}`);
  }
  return out;
}

/**
 * The fact sheet. `s` = the world before the outing (worker.stateAtStart). ctx: { place (words,
 * from now), world, tz, persona: {displayName, voice}, age, jobTitle, vitals, weather,
 * travelMode, firstMeet: [ids], tone, outcome: {value, by}, negative, beats: {castId: [kind]},
 * prev: {castId: {ending, highlight}}, history: {castId: [line]} }
 */
/** What of the record goes on the sheet: none for the explicit register (its own path), or once it no longer agrees with the outcome. */
export function recordFor(trace, { register, outcome, tz, ownerIntent = false }) {
  if (register === 'explicit' || trace?.mode !== 'full' || trace.outcome !== outcome) return null;
  return traceSheet(trace, tz, { ownerIntent });
}

const THEM_WORDS = Object.freeze({ low: 'they seemed off', ok: 'they seemed fine', high: 'they seemed happy' });
const HIS_WORDS = Object.freeze({ low: 'he was low', ok: 'he was all right', high: 'he was enjoying himself' });
const TRACE_LINES = 24;
const MOOD_LASTS_SEC = 10 * 60;

const PLAIN_PHASES = new Set(['settling', 'main']);   // "settling in", "in full swing": they say nothing a scene would use
const hisAgrees = (his, outcome) => !((outcome === 'badly' || outcome === 'flat') && his === 'high') && !(outcome === 'well' && his === 'low');

/** Over the cap, the middle goes first: topics, then moods, then anything else. The start, the ending and what interrupted them stay. */
function thinned(rows) {
  const keep = [...rows];
  const lastPhase = keep.map(r => r.rank).lastIndexOf(0);
  const drop = (rank) => {
    while (keep.length > TRACE_LINES) {
      const candidates = keep.map((r, i) => (r.rank === rank && i > 0 && i < keep.length - 1 && i !== lastPhase ? i : -1)).filter(i => i >= 0);
      if (!candidates.length) return;
      keep.splice(candidates[Math.floor(candidates.length / 2)], 1);
    }
  };
  drop(1);
  drop(3);
  drop(2);
  return keep;
}

/** One interruption in plain words: who for someone fictional, counts at most for real chats, never a word of either. */
function momentWords(m) {
  if (m.kind === 'text') return m.who ? `a text from ${m.who}; he ${m.answered ? 'answered it' : 'left it'}` : null;
  if (m.kind === 'answered') return m.who ? `he texted ${m.who}` : null;
  if (m.kind === 'chats_sent') return 'he was on his phone, answering messages';
  if (m.kind === 'chats') return 'his phone buzzed a few times';
  return null;
}

/**
 * The live session's record → the sheet's timeline (plan 020 C4). In time order; every line is true, and the
 * scene tells it rather than lists it. { lines: ['19:30 arriving', …], names: [...], late, drifted } | null.
 */
export function traceSheet(trace, tz, { ownerIntent = false } = {}) {
  if (!isObj(trace) || trace.mode !== 'full') return null;
  const clock = (t) => (tz ? hhmm(t, tz) : String(t));
  const rows = [];
  const names = [];
  // The shape of the evening, not a transcript: the phases that say something, and what they talked about unless the owner has said what this outing is.
  for (const p of Array.isArray(trace.phases) ? trace.phases : []) if (!PLAIN_PHASES.has(p.phase)) rows.push({ at: p.from, text: p.words ?? null, rank: 0 });
  if (!ownerIntent) for (const x of Array.isArray(trace.topics) ? trace.topics : []) if (x.words && x.code !== 'nothing') rows.push({ at: x.from, text: `${x.back ? 'back to' : 'talking about'} ${x.words}`, rank: 1 });
  for (const m of Array.isArray(trace.interruptions) ? trace.interruptions : []) {
    const text = momentWords(m);
    if (!text) continue;
    if (m.who) names.push(m.who);
    rows.push({ at: m.at, text, rank: 2 });
  }
  // The path of the mood, not its wobble: a mood that didn't last isn't one, and the same one again isn't news.
  const mood = (Array.isArray(trace.mood) ? trace.mood : []).filter((m, i, all) => i === all.length - 1 || all[i + 1].at - m.at >= MOOD_LASTS_SEC);
  let said = null;
  for (const m of mood) {
    // His half comes from his day, not this evening: where it disagrees with how it went, it would contradict the outcome on the same sheet.
    const his = hisAgrees(m.his, trace.outcome) ? `, ${HIS_WORDS[m.his] ?? HIS_WORDS.ok}` : '';
    const text = `${THEM_WORDS[m.them] ?? THEM_WORDS.ok}${his}`;
    if (text !== said) rows.push({ at: m.at, text, rank: 3 });
    said = text;
  }
  const lines = thinned(rows.filter(r => r.text && finite(r.at)).sort((a, b) => a.at - b.at || a.rank - b.rank)).map(r => `${clock(r.at)} ${r.text}`);
  if (!lines.length) return null;
  return {
    lines, names: [...new Set(names)],
    ...(finite(trace.late) ? { lateMin: trace.late } : {}),
    ...(finite(trace.attention?.low) && trace.attention.low < 0.4 ? { drifted: true } : {}),
  };
}

export function buildFactSheet(s, session, ctx = {}) {
  const tz = ctx.tz;
  const labels = {};
  const names = new Set();
  const people = [];
  const first = new Set(ctx.firstMeet ?? []);
  if (session.mode !== 'self_only') {
    session.castIds.forEach((id, i) => {
      const c = s.cast.get(id);
      const label = `P${i + 1}`;
      labels[label] = id;
      const m = metricsOf(s, id);
      const romance = s.story?.romance?.partnerId === id && s.story?.romance?.stage && s.story.romance.stage !== 'single';
      const name = clean(c?.name, 40) ?? label;
      for (const w of name.split(' ')) names.add(w);
      people.push({
        label, name, relation: relationWord(c?.relation), pronouns: clean(c?.pronouns, 24),
        personality: clean(c?.personality, 200), speech: clean(c?.speech, 160), hometown: clean(c?.hometown, 80),
        closeness: band01(m.closeness), trust: band01(m.trust), tension: band01(m.tension),
        ...(romance ? { romance: s.story.romance.stage, intimacy: band01(m.intimacy), passion: band01(m.passion) } : {}),
        firstMeet: first.has(id),
        history: (ctx.history?.[id] ?? []).slice(-3).map(h => clean(h, 120)).filter(Boolean),
        beats: (ctx.beats?.[id] ?? []).filter(k => BEAT_KINDS.has(k)).slice(0, 4),
        lastTime: ctx.prev?.[id] ? { ending: ctx.prev[id].ending ?? null, highlight: clean(ctx.prev[id].highlight, 160) } : null,
        // 019: how much they texted in the days before (only when they did, so older sheets read the same).
        ...(textingWords(ctx.texting?.[id]) ? { texting: textingWords(ctx.texting[id]) } : {}),
        // pinned #8: when they last saw each other, in the words people use (only when known).
        ...(clean(ctx.lastSaw?.[id], 120) ? { lastSaw: clean(ctx.lastSaw[id], 120) } : {}),
        // 020 D2: the note that held when the outing began. Up to its as-of it stands in for the beats; the shared past stays, the note never reads it.
        ...(clean(ctx.standing?.[id]?.text, 620) ? {
          standing: { text: clean(ctx.standing[id].text, 620), asOf: tz ? dayLabel(ctx.standing[id].asOfAt ?? ctx.standing[id].validFrom, tz) : null },
          historyAfter: (ctx.historyAfter?.[id] ?? []).slice(-3).map(h => clean(h, 120)).filter(Boolean),
          beatsAfter: (ctx.beatsAfter?.[id] ?? []).filter(k => BEAT_KINDS.has(k)).slice(0, 4),
        } : {}),
        // 020 D3: a promise with them with nothing behind it (a chat's plan never reaches this sheet).
        ...(ctx.commitments?.[id]?.length ? { commitments: ctx.commitments[id].map(l => clean(l, 160)).filter(Boolean).slice(0, 2) } : {}),
      });
      // A name the note carries is one the writer may use.
      const note = ctx.standing?.[id]?.text;
      if (note) {
        const inNote = new Set(String(note).split(/[^\p{L}'’-]+/u));
        for (const c of s.cast.values()) for (const w of String(c?.name ?? '').split(' ')) if (inNote.has(w)) names.add(w);
      }
    });
  }
  const v = ctx.vitals ?? s.vitals ?? {};
  const place = typeof ctx.place === 'string' ? ctx.place : placeWords(s, session);
  const persona = ctx.persona ?? {};
  for (const w of String(persona.displayName ?? '').split(/\s+/)) if (w) names.add(w);
  if (place) for (const w of String(place).split(/\s+/)) names.add(w);
  const sheet = {
    mode: session.mode,
    him: {
      name: clean(persona.displayName, 40) ?? 'him',
      age: finite(ctx.age) ? ctx.age : null,
      job: clean(ctx.jobTitle, 60),
      voice: clean(persona.voice, 160),
      energy: band3(v.energy, 35, 70),
      stress: band3(v.stress, 30, 65),
      mood: band3(finite(v.mood?.valence) ? v.mood.valence : 0, -0.2, 0.3),
      socialBattery: band3(v.socialBattery, 30, 70),
    },
    place: { words: place, kind: kindWord(s?.places?.get?.(session.placeId)?.kind), home: session.home === true },
    time: {
      day: tz ? dayLabel(session.startAt, tz) : null,
      from: tz ? hhmm(session.startAt, tz) : null,
      to: tz ? hhmm(session.endAt, tz) : null,
      daypart: tz ? daypart(session.startAt, tz) : null,
      minutes: session.minutes,
      travel: clean(ctx.travelMode, 16),
    },
    weather: ctx.weather ? { condition: clean(ctx.weather.condition, 24), tempC: finite(ctx.weather.tempC) ? Math.round(ctx.weather.tempC) : null } : null,
    activity: kindPhrase(session.kind),
    people,
    friend: session.mode === 'self_only' ? FRIEND : null,
    outcome: ctx.outcome?.value ?? 'fine',
    tone: clean(ctx.tone, 120),
  };
  // The owner's own line for the outing, and a long night (told as an arc). Absent otherwise,
  // so an older sheet still reads the same. Never for a chat outing or a real person.
  const intent = ownerIntentOf(s, session, { tone: ctx.tone ?? null });
  if (intent) sheet.ownerIntent = intent;
  if (Number(session.minutes) >= LONG_MINUTES) sheet.long = true;
  Object.assign(sheet, aroundOf(ctx));
  // plan 020 B: what he makes of what's in it. Absent until the owner approves a set; never a chat's, never a real person's outing.
  if (session.mode !== 'self_only') {
    const views = stanceSheetLines({ kind: session.kind, placeId: session.placeId, castIds: session.castIds });
    if (views.length) sheet.hisViews = views;
  }
  return {
    sheet, labels, mode: session.mode, outcome: sheet.outcome, outcomeBy: ctx.outcome?.by ?? 'code',
    names: [...names, ...(Array.isArray(ctx.phoneNames) ? ctx.phoneNames.flatMap(n => String(n).split(' ')) : [])].filter(Boolean),
  };
}
