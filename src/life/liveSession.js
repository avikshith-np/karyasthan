// The live outing (plan 020 C1–C2): what is going on right now on an outing with someone, read
// from the log. Pure: the facade hands in the session and its readers. No model, no storage, no
// world event, so a revert or a rewind is exact by construction and a restart reads the same line.
//
//   buildBase(session facts)            → the fixed facts and the seeded plan of one session
//   walkSession(base, inputs, to)       → one step per 5 minutes from its start to `to`
//   liveView(base, inputs, at)          → the state and the line at `at`
//   traceOf(base, inputs, endAt)        → the compact record for the end scene's sheet
//
// Everything random is rngFor(<the start's local date>, 'live:<kind>:<activity>:…'): the same on
// every read. The line at a moment depends only on what the log held by that moment: earlier
// picks are replayed, and that replay is the repeat memory.
//
// Mood is shown, not lived: nothing here changes a relationship or a vital, and "whether he
// answers" is read from the log (phone.message), never decided here.
import { PLACES, GENERAL, SITTING, KNOWN, EMPLOYED, EVENING, DETAILS, PHONE, PRIVATE, TOPIC_WORDS, TOPIC_NEW, TOPIC_NEW_HERS, HER_TOPICS, TOPIC_STILL, TOPIC_BACK } from './livePhrases.js';
import { voiceLine } from './phraseBank.js';
import { timeOfDay } from './phraseCheck.js';

export const STEP_SEC = 5 * 60;
export const PHASES = Object.freeze(['arriving', 'settling', 'main', 'lull', 'winding', 'leaving']);
export const PHASE_WORDS = Object.freeze({ arriving: 'arriving', settling: 'settling in', main: 'in full swing', lull: 'a lull', winding: 'winding down', leaving: 'leaving' });
const MIN = 60;
const FRESH_SEC = 10 * MIN;            // how long an interruption stays news on the line
const STEPS_MAX = 12 * 12;             // 12 hours of 5-minute steps
const MOODLET_MAX = 0.5;
const REUSE_AFTER_STEPS = 40;          // a phrase may come back after about 3 hours

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const round2 = (x) => Math.round(x * 100) / 100;
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

export const moodBand = (x) => (x < 0.38 ? 'low' : x > 0.62 ? 'high' : 'ok');
export const levelBand = (x) => (x < 0.35 ? 'low' : x > 0.68 ? 'high' : 'ok');
export const energyBand = (e) => (!finite(e) ? 'ok' : e < 30 ? 'low' : e > 70 ? 'high' : 'ok');

// ── what kind of outing ─────────────────────────────────────────────────────
const WATCH = new Set(['movie', 'cinema', 'film', 'show', 'theatre', 'theater']);
const FOOD = new Set(['eat-out', 'eatout', 'dinner', 'lunch', 'breakfast', 'brunch', 'food', 'restaurant', 'meal']);
const CAFE = new Set(['cafe', 'coffee', 'tea']);
const BAR = new Set(['drinks', 'bar', 'pub', 'brewpub', 'party', 'club']);
const OUTDOOR = new Set(['walk', 'park', 'hike', 'run', 'cycle', 'outing', 'picnic', 'beach']);
const SHOP = new Set(['shopping', 'mall', 'shop', 'market', 'bookshop']);
const EVENT = new Set(['concert', 'gig', 'festival', 'match', 'game-night']);
const ACTIVE = new Set(['sports', 'game', 'gym', 'cricket', 'football', 'badminton', 'tennis', 'bowling']);
const SELF_CONTAINED = new Set(['watch', 'event', 'active', 'shop']);
const SITS_DOWN = new Set(['cafe', 'food', 'bar', 'home']);

/** Which phrase set an outing reads from: the kind first, then the place's kind. */
export function placeClass(kind, placeKind, home) {
  const k = String(kind ?? '').replace(/^[a-z]+:/, '');
  const pk = String(placeKind ?? '');
  if (WATCH.has(k) || pk === 'cinema') return 'watch';
  if (EVENT.has(k)) return 'event';
  if (ACTIVE.has(k)) return 'active';
  if (home) return 'home';
  if (FOOD.has(k) || pk === 'restaurant') return 'food';
  if (BAR.has(k) || ['bar', 'pub', 'brewpub'].includes(pk)) return 'bar';
  if (SHOP.has(k) || ['shop', 'mall', 'bookshop', 'grocery', 'supermarket'].includes(pk)) return 'shop';
  if (OUTDOOR.has(k) || pk === 'park') return 'outdoor';
  if (CAFE.has(k) || pk === 'cafe') return 'cafe';
  return 'cafe';   // somewhere to sit and talk
}

/** The words a member's pronouns give. Two or more people: they. */
export function pronounsOf(cast) {
  if (cast.length !== 1) return { "she's": "they're", she: 'they', her: 'their', them: 'them' };
  const p = String(cast[0]?.pronouns ?? '').toLowerCase();
  if (/^she\b/.test(p)) return { "she's": "she's", she: 'she', her: 'her', them: 'her' };
  if (/^he\b/.test(p)) return { "she's": "he's", she: 'he', her: 'his', them: 'him' };
  return { "she's": "they're", she: 'they', her: 'their', them: 'them' };
}

export const firstName = (name) => {
  const s = String(name ?? '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.split(' ')[0] : 'them';
};

// ── the seeded plan ─────────────────────────────────────────────────────────

function phaseSpans(base) {
  const { startAt, endAt, rngFor, seedKey, date } = base;
  const dur = Math.max(1, endAt - startAt);
  const rng = rngFor(date, `${seedKey}:phases`);
  const jig = (lo, hi) => lo + (hi - lo) * rng();
  const watching = base.cls === 'watch';
  const arrive = Math.min(10 * MIN, dur * 0.1) * jig(0.7, 1.1);
  const settle = Math.min(20 * MIN, dur * 0.14) * jig(0.8, 1.2);
  const leave = Math.min(8 * MIN, dur * 0.08) * jig(0.8, 1.1);
  // Tired, or going badly: it winds down earlier.
  const early = (base.outcome === 'flat' || base.outcome === 'badly' ? 1.4 : 1) * (base.tiredAtStart ? 1.3 : 1);
  const wind = Math.min(35 * MIN, dur * 0.18) * jig(0.8, 1.2) * early;
  const spans = [{ phase: 'arriving', from: startAt, to: startAt + arrive }, { phase: 'settling', from: startAt + arrive, to: startAt + arrive + settle }];
  const mainFrom = startAt + arrive + settle;
  const mainTo = endAt - wind - leave;
  const lulls = [];
  if (!watching && mainTo - mainFrom > 40 * MIN) {
    const per = base.outcome === 'flat' || base.outcome === 'badly' ? 45 : base.outcome === 'well' ? 110 : 75;
    const n = Math.floor((mainTo - mainFrom) / (per * MIN));
    for (let i = 0; i < n; i++) {
      const slot = (mainTo - mainFrom) / n;
      const at = mainFrom + slot * i + slot * jig(0.45, 0.8);
      lulls.push({ from: at, to: Math.min(mainTo, at + jig(7, 14) * MIN) });
    }
  }
  let t = mainFrom;
  for (const l of lulls) {
    if (l.from > t) spans.push({ phase: 'main', from: t, to: l.from });
    spans.push({ phase: 'lull', from: l.from, to: l.to });
    t = l.to;
  }
  if (t < mainTo) spans.push({ phase: 'main', from: t, to: mainTo });
  spans.push({ phase: 'winding', from: Math.max(t, mainTo), to: endAt - leave }, { phase: 'leaving', from: endAt - leave, to: endAt });
  return spans.filter(s => s.to > s.from).map(s => ({ phase: s.phase, from: Math.round(s.from), to: Math.round(s.to) }));
}

// Topics: what is really in their lives first (a beat, a job, a shared history), then ordinary talk.
function topicThread(base) {
  const { startAt, endAt, rngFor, seedKey, date, facts } = base;
  const rng = rngFor(date, `${seedKey}:topics`);
  const own = [...(facts.topicCodes ?? [])];
  const plain = ['week', ...(facts.employed === false ? [] : ['his_work']), 'plans', 'people', 'food', 'money', 'shows', 'city', 'travel', 'nothing'];
  for (let i = plain.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [plain[i], plain[j]] = [plain[j], plain[i]]; }
  const pool = [...own, ...plain];
  const out = [];
  let t = startAt + Math.min(8 * MIN, (endAt - startAt) * 0.12);
  let i = 0;
  while (t < endAt && out.length < 24) {
    const len = (18 + rng() * 30) * MIN;
    // Now and then a topic comes back: that's how talk goes.
    const back = out.length >= 3 && rng() < 0.18;
    const code = back ? out[Math.floor(rng() * (out.length - 1))].code : pool[i++ % pool.length];
    out.push({ code, from: Math.round(t), to: Math.round(Math.min(endAt, t + len)), words: pick(rng, TOPIC_WORDS[code] ?? TOPIC_WORDS.nothing) });
    t += len;
  }
  return out;
}

/**
 * The fixed facts of one session. facts: { activityId, startAt, endAt, kind, placeKind, home, placeWord,
 * cast: [{ id, name, pronouns }], closeness, tension, outcome, firstMeet, lateMin, rain, sick,
 * topicCodes, register }. rngFor(date, key) → rng; date = the start's local date.
 */
export function buildBase(facts, { rngFor, date, hhmm, hourOf }) {
  const startAt = facts.startAt;
  const endAt = Math.max(startAt + STEP_SEC, facts.endAt);
  const base = {
    facts, startAt, endAt, rngFor, date, hhmm, hourOf,
    seedKey: `live:${facts.activityId}`,
    cls: placeClass(facts.kind, facts.placeKind, facts.home === true),
    outcome: facts.outcome ?? 'fine',
    tiredAtStart: facts.energyAtStart !== undefined && energyBand(facts.energyAtStart) === 'low',
    pron: pronounsOf(facts.cast),
    name: facts.cast.length === 1 ? firstName(facts.cast[0].name) : 'the two of them',
  };
  base.spans = phaseSpans(base);
  base.topics = base.cls === 'watch' || facts.register === 'private' ? [] : topicThread(base);
  return base;
}

export function phaseAt(base, t) {
  if (t >= base.endAt) return 'leaving';
  return base.spans.find(s => t >= s.from && t < s.to)?.phase ?? 'leaving';
}

// ── interruptions: moodlets that dip and fade ───────────────────────────────

/**
 * One moodlet per event, in time order. inputs.events: phone.message (anyone not there) and
 * chat.load in the session, live only. A real chat is counts only, always; a text names a fictional
 * member (the phone's own row says who). `answered` is read from the log.
 */
export function interruptionsOf(base, events) {
  const here = new Set(base.facts.cast.map(c => c.id));
  const out = [];
  const texts = [...events].filter(e => e.type === 'phone.message').sort((a, b) => a.at - b.at || a.id - b.id);
  for (const e of [...events].sort((a, b) => a.at - b.at || a.id - b.id)) {
    const rng = base.rngFor(base.date, `${base.seedKey}:fade:${e.id}`);
    const fade = (10 + rng() * 10) * MIN;
    if (e.type === 'phone.message') {
      const castId = e.payload?.castId;
      if (typeof castId !== 'string' || here.has(castId)) continue;
      const dir = e.payload?.dir === 'out' ? 'out' : 'in';
      const answeredAt = dir === 'in' ? texts.find(x => x.payload?.castId === castId && x.payload?.dir === 'out' && x.at >= e.at)?.at ?? null : null;
      out.push({ id: e.id, at: e.at, kind: dir === 'out' ? 'answered' : 'text', castId, who: base.facts.nameOf?.(castId) ?? null, answeredAt, attention: dir === 'out' ? 0.3 : 0.18, closeness: dir === 'out' ? 0.06 : 0.03, fade });
    } else if (e.type === 'chat.load') {
      const sent = finite(e.payload?.sent) ? e.payload.sent : 0;
      const received = finite(e.payload?.received) ? e.payload.received : 0;
      if (sent + received <= 0) continue;
      out.push({ id: e.id, at: e.at, kind: sent > 0 ? 'chats_sent' : 'chats', sent, received, attention: sent > 0 ? 0.22 : Math.min(0.16, 0.06 + received * 0.01), closeness: sent > 0 ? 0.05 : 0.02, fade });
    }
  }
  return out;
}

function dipAt(list, t) {
  let attention = 0;
  let closeness = 0;
  for (const m of list) {
    if (m.at > t) continue;
    const left = 1 - (t - m.at) / m.fade;
    if (left <= 0) continue;
    attention += m.attention * left;
    closeness += m.closeness * left;
  }
  return { attention: Math.min(MOODLET_MAX, attention), closeness: Math.min(MOODLET_MAX, closeness) };
}

// ── the state at a moment ───────────────────────────────────────────────────

// How she is doing over the session: where it starts, where the outcome takes it.
function themMood(base, t, dip) {
  const f = base.facts;
  const frac = clamp01((t - base.startAt) / (base.endAt - base.startAt));
  const start = 0.45 + (finite(f.closeness) ? (f.closeness - 0.5) * 0.35 : 0) - (finite(f.tension) ? f.tension * 0.3 : 0);
  const target = { well: 0.85, fine: 0.58, flat: 0.34, badly: 0.14 }[base.outcome] ?? 0.55;
  const rng = base.rngFor(base.date, `${base.seedKey}:mood:${Math.floor((t - base.startAt) / (20 * MIN))}`);
  const wobble = (rng() - 0.5) * 0.14;
  const phaseAdj = phaseAt(base, t) === 'lull' ? -0.06 : 0;
  return clamp01(start + (target - start) * Math.min(1, frac * 1.6) + wobble + phaseAdj - dip.attention * 0.35);
}

function stateAt(base, inputs, t) {
  const moodlets = inputs.moodlets.filter(m => m.at <= t);
  const dip = dipAt(moodlets, t);
  const phase = phaseAt(base, t);
  const v = inputs.vitalsAt?.(t) ?? null;
  const hisMood = finite(v?.mood?.valence) ? v.mood.valence : 0;
  const energy = finite(v?.energy) ? v.energy : null;
  const sick = v?.sick === true || base.facts.sick === true;
  const them = themMood(base, t, dip);
  const phaseAttention = { arriving: 0.7, settling: 0.75, main: 0.9, lull: 0.55, winding: 0.65, leaving: 0.5 }[phase] ?? 0.7;
  const attention = clamp01(phaseAttention - (energy !== null && energy < 30 ? 0.12 : 0) - (sick ? 0.1 : 0) - dip.attention);
  const frac = clamp01((t - base.startAt) / (base.endAt - base.startAt));
  const grow = { well: 0.06, fine: 0.02, flat: 0, badly: -0.05 }[base.outcome] ?? 0;
  const closeness = clamp01((finite(base.facts.closeness) ? base.facts.closeness : 0.5) + grow * frac - dip.closeness);
  return {
    phase, them, attention, closeness, energy, sick,
    bands: {
      his: sick ? 'low' : moodBand(0.5 + hisMood * 0.5), them: moodBand(them), attention: levelBand(attention),
      closeness: levelBand(closeness), energy: energyBand(energy),
    },
    moodlets,
  };
}

function topicAt(base, t) {
  return base.topics.find(x => t >= x.from && t < x.to) ?? null;
}

// ── the line ────────────────────────────────────────────────────────────────

function fill(text, base, extra = {}) {
  const p = base.pron;
  return String(text)
    .replaceAll("{she's}", p["she's"]).replaceAll('{she}', p.she).replaceAll('{her}', p.her).replaceAll('{them}', p.them)
    .replaceAll('{name}', base.name).replaceAll('{who}', extra.who ?? 'someone').replaceAll('{t}', extra.t ?? '');
}


// His words for a line when a bank has them (plan 020 H2). The English stays the repeat memory's key, and this draws
// nothing from the session's random stream: the same line at the same moment on every read.
const voiced = (text, base, st, t, step) => voiceLine('live', text, { activity: base.cls, mood: st.bands.his, time: timeOfDay(base.hourOf(t)) }, `${base.seedKey}:${step}:${text}`);

function vibeCandidates(base, st, t, memory) {
  const { phase, bands, sick } = st;
  const mood = bands.them;
  const pl = PLACES[base.cls] ?? {};
  const f = base.facts;
  const take = (list, weight = 1) => (Array.isArray(list) ? list : []).map(text => ({ text, weight }));
  const open = (list) => list.filter(c => !memory.has(c.text) || memory.get(c.text) < memory.step - REUSE_AFTER_STEPS);
  const h = base.hourOf(t);
  const frac = (t - base.startAt) / (base.endAt - base.startAt);
  // At a film, a gig, a shop or a game the place says it all, except for the goodbye.
  if (SELF_CONTAINED.has(base.cls) && phase !== 'leaving') {
    const own = take(pl[phase], 2);
    if (phase === 'main' && frac > 0.42 && frac < 0.58) own.push(...take(pl.middle, 4));
    return open(own);
  }
  // A place with an order to it (a meal): early, then the main of it, then the long after.
  const placed = phase === 'main' && pl.early && frac < 0.25 ? pl.early
    : phase === 'main' && pl.late && frac > 0.6 ? pl.late : pl[phase];
  const out = [
    ...take(GENERAL[`${phase}.${mood}`], 2), ...take(GENERAL[phase]), ...take(placed, 2),
  ];
  if (SITS_DOWN.has(base.cls)) out.push(...take(SITTING[phase]));
  if (!f.firstMeet) out.push(...take(KNOWN[phase]));
  if (f.employed !== false) out.push(...take(EMPLOYED[phase]), ...take(EMPLOYED[`${phase}.${mood}`]));
  if (h >= 17 || h < 4) {
    if (phase === 'winding') out.push(...take(EVENING.winding));
    if (phase === 'winding' && base.cls === 'outdoor') out.push(...take(EVENING.outdoor, 2));
  }
  const early = t - base.startAt < 40 * MIN;
  if (f.firstMeet && early) out.push(...take(DETAILS.first, 3));
  if (finite(f.lateMin) && f.lateMin >= 10 && t - base.startAt < 25 * MIN) out.push(...take(DETAILS.late, 3));
  // The rain is what it was when he arrived: said early on, not for hours.
  const raining = f.rain && t - base.startAt < 90 * MIN;
  if (raining && base.cls === 'outdoor') out.push(...take(DETAILS.rainOut, 2));
  else if (raining && base.cls !== 'home') out.push(...take(DETAILS.rain));
  if (h >= 23 || h < 4) out.push(...take(DETAILS.late_night, 2));
  if (h >= 5 && h < 10) out.push(...take(DETAILS.morning));
  if (sick) out.push(...take(DETAILS.sick, 3));
  else if (bands.energy === 'low') out.push(...take(DETAILS.tired, 2));
  if (!sick && bands.his === 'low') out.push(...take(DETAILS.low_mood));
  if (!sick && bands.his === 'high' && mood !== 'low') out.push(...take(DETAILS.high_mood));
  if (f.cast.length > 1) out.push(...take(DETAILS.group));
  if (finite(f.closeness) && f.closeness > 0.7 && mood !== 'low') out.push(...take(DETAILS.close));
  if (finite(f.tension) && f.tension > 0.5) out.push(...take(DETAILS.tense));
  return open(out);
}

function pickWeighted(rng, list) {
  const sum = list.reduce((a, c) => a + c.weight, 0);
  let x = rng() * sum;
  for (const c of list) { x -= c.weight; if (x <= 0) return c; }
  return list[list.length - 1] ?? null;
}

function phoneWords(base, st, step, t, memory, rng) {
  // Only what became news in this step, and only while fresh.
  const fresh = st.moodlets.filter(m => m.at > t - STEP_SEC && m.at <= t);
  if (!fresh.length) return null;
  const say = (list, extra) => {
    const open = list.filter(x => !memory.has(x) || memory.get(x) < step - REUSE_AFTER_STEPS);
    const text = pick(rng, open.length ? open : list);
    memory.set(text, step);
    return fill(voiced(text, base, st, t, step), base, extra);
  };
  const noticed = st.bands.closeness !== 'low' && rng() < 0.4;
  if (fresh.length >= 3 || (fresh.length >= 2 && fresh.some(m => m.kind === 'chats' || m.kind === 'chats_sent'))) return say(PHONE.many);
  const m = fresh[fresh.length - 1];
  if (m.kind === 'answered') return say(noticed ? PHONE.answeredSeen : PHONE.answered, { who: m.who ?? 'someone' });
  if (m.kind === 'chats_sent') return say(PHONE.chatsSent);
  if (m.kind === 'chats') return say(PHONE.chats);
  const replied = finite(m.answeredAt) && m.answeredAt <= t;
  if (replied) return say(PHONE.answered, { who: m.who ?? 'someone' });
  if (m.who && rng() < 0.45) return say(PHONE.named, { who: m.who });
  return say(noticed ? PHONE.buzzSeen : PHONE.buzz);
}

/**
 * One step per 5 minutes from the start through `to`: { t, st, parts: { topic, vibe, phone }, text }.
 * A vibe holds for a few steps, then gives way, sometimes to nothing: silence is allowed.
 */
export function walkSession(base, inputs, to) {
  const steps = [];
  const memory = new Map();
  let holdVibe = null;
  let holdUntil = -1;
  let lastTopic = null;
  const topicsSeen = new Set();
  let topicShownAt = -99;
  let afterPhoneAt = -99;
  const count = Math.min(STEPS_MAX, Math.floor((Math.min(to, base.endAt + STEP_SEC * 6) - base.startAt) / STEP_SEC));
  const priv = base.facts.register === 'private';
  for (let i = 0; i <= count; i++) {
    const t = base.startAt + i * STEP_SEC;
    memory.step = i;
    const st = stateAt(base, inputs, t);
    const rng = base.rngFor(base.date, `${base.seedKey}:step:${i}`);
    const phase = st.phase;
    const prevPhase = steps[steps.length - 1]?.st.phase;

    if (priv) {
      if (i >= holdUntil) {
        holdVibe = rng() < 0.5 ? pick(rng, PRIVATE) : null;
        holdUntil = i + 3 + Math.floor(rng() * 3);
      }
      steps.push({ t, st, parts: { topic: null, vibe: holdVibe, phone: null } });
      continue;
    }

    // His phone first: it is what actually happened.
    const phone = phoneWords(base, st, i, t, memory, rng);
    if (phone) afterPhoneAt = i;

    // The topic: said when it changes, then sometimes again.
    const topic = topicAt(base, t);
    let topicText = null;
    const talking = ['main', 'settling', 'lull'].includes(phase) && !phone;
    if (topic && talking && phase !== 'lull') {
      const changed = topic !== lastTopic;
      if (changed) {
        const back = topicsSeen.has(topic.code);
        const table = back ? TOPIC_BACK : (HER_TOPICS.has(topic.code) && base.facts.cast.length === 1 ? [...TOPIC_NEW, ...TOPIC_NEW_HERS] : TOPIC_NEW);
        const open = table.filter(x => !memory.has(`T:${x}`) || memory.get(`T:${x}`) < i - 18);
        const form = pick(rng, open.length ? open : table);
        memory.set(`T:${form}`, i);
        topicText = fill(fill(voiced(form, base, st, t, i), base, { t: fill(topic.words, base) }), base);
        topicShownAt = i;
        topicsSeen.add(topic.code);
        lastTopic = topic;
      } else if (i - topicShownAt >= 4 && rng() < 0.22) {
        const open = TOPIC_STILL.filter(x => !memory.has(`T:${x}`) || memory.get(`T:${x}`) < i - 18);
        if (open.length) {
          const form = pick(rng, open);
          memory.set(`T:${form}`, i);
          topicText = fill(voiced(form, base, st, t, i), base, { t: fill(topic.words, base) });
          topicShownAt = i;
        }
      }
    }

    // The detail: held for a few steps, then a new one or nothing.
    if (i === 0 && finite(base.facts.lateMin) && base.facts.lateMin >= 10) {
      // He got here late: that comes first.
      const said = pick(rng, DETAILS.late);
      memory.set(said, i);
      holdVibe = fill(voiced(said, base, st, t, i), base);
      holdUntil = i + 2;
    } else if (phase !== prevPhase || i >= holdUntil) {
      const quietOdds = base.cls === 'watch' ? 0.55 : phase === 'lull' ? 0.25 : phase === 'main' ? 0.35 : 0.15;
      const cands = vibeCandidates(base, st, t, memory);
      if (phase !== prevPhase ? false : rng() < quietOdds) holdVibe = null;
      else {
        const c = cands.length ? pickWeighted(rng, cands) : null;
        holdVibe = c ? fill(voiced(c.text, base, st, t, i), base) : null;
        if (c) memory.set(c.text, i);
      }
      holdUntil = i + 2 + Math.floor(rng() * 2);
    }
    // A word after the phone, once in a while.
    let vibe = holdVibe;
    if (!phone && i === afterPhoneAt + 2 && rng() < 0.35) vibe = fill(voiced(pick(rng, PHONE.after), base, st, t, i), base);
    steps.push({ t, st, parts: { topic: topicText, vibe: phone && topicText ? null : vibe, phone } });
  }
  return steps;
}

/** The parts of the line at a step (short strings; the time goes alongside). */
export function lineParts(base, step) {
  const p = step.parts;
  return [base.facts.placeWord, p.topic, p.vibe, p.phone].filter(Boolean);
}

export function moodletsNow(moodlets, t) {
  return moodlets.filter(m => m.at <= t && t - m.at < m.fade).map(m => ({
    at: m.at, kind: m.kind, who: m.who ?? null,
    ...(m.kind === 'chats' || m.kind === 'chats_sent' ? { sent: m.sent, received: m.received } : {}),
    ...(m.kind === 'text' ? { answered: finite(m.answeredAt) && m.answeredAt <= t } : {}),
    fades: round2(Math.max(0, 1 - (t - m.at) / m.fade)),
  }));
}

/** The state and the line at `at`. */
export function liveView(base, inputs, at) {
  const steps = walkSession(base, inputs, at);
  const step = steps[steps.length - 1];
  const parts = lineParts(base, step);
  const f = base.facts;
  const st = stateAt(base, inputs, at);
  const topic = base.topics.length ? topicAt(base, at) : null;
  return {
    phase: st.phase, phaseWords: PHASE_WORDS[st.phase],
    minutesIn: Math.max(0, Math.round((at - base.startAt) / MIN)),
    minutesLeft: Math.max(0, Math.round((base.endAt - at) / MIN)),
    his: { mood: st.bands.his, energy: st.bands.energy, sick: st.sick },
    them: f.cast.map(c => ({ castId: c.id, name: firstName(c.name), mood: st.bands.them })),
    attention: { band: st.bands.attention, value: round2(st.attention) },
    closeness: { band: st.bands.closeness, value: round2(st.closeness) },
    topic: topic ? { code: topic.code, words: fill(topic.words, base), since: topic.from } : null,
    interruptions: moodletsNow(inputs.moodlets, at),
    line: { at: base.hhmm(at), parts },
    text: [base.hhmm(at), ...parts].join(' · '),
  };
}

const BEATS_MAX = 6;

/**
 * What has happened so far, for the public site: code words only, newest last. A real chat is only that his phone
 * buzzed; a text is who for someone fictional, never its words. (plan 020, the site's `live`)
 */
export function publicBeats(trace) {
  const rows = [];
  for (const x of Array.isArray(trace?.topics) ? trace.topics : []) if (x.words) rows.push({ at: x.from, text: `${x.back ? 'back to' : 'talking about'} ${x.words}` });
  for (const m of Array.isArray(trace?.interruptions) ? trace.interruptions : []) {
    if (m.kind === 'text' && m.who) rows.push({ at: m.at, text: `a text from ${m.who}; he ${m.answered ? 'answered it' : 'left it'}` });
    else if (m.kind === 'answered' && m.who) rows.push({ at: m.at, text: `he texted ${m.who}` });
    else if (m.kind === 'chats') rows.push({ at: m.at, text: 'his phone buzzed' });
    else if (m.kind === 'chats_sent') rows.push({ at: m.at, text: 'he was on his phone for a bit' });
  }
  return rows.filter(r => finite(r.at)).sort((a, b) => a.at - b.at).slice(-BEATS_MAX);
}

/**
 * The record of a session for the end scene's sheet: phases, topics as codes + words, every
 * interruption (who for a fictional member, counts for real chats, never a word), mood over time.
 */
export function traceOf(base, inputs, endAt) {
  const steps = walkSession(base, inputs, endAt);
  const seen = new Set();
  const phases = [];
  for (const s of base.spans) {
    if (s.from >= endAt) break;
    phases.push({ phase: s.phase, words: PHASE_WORDS[s.phase] ?? null, from: s.from, to: Math.min(s.to, endAt) });
  }
  const topics = [];
  for (const x of base.topics) {
    if (x.from >= endAt) break;
    topics.push({ code: x.code, words: fill(x.words, base), from: x.from, to: Math.min(x.to, endAt), back: seen.has(x.code) || undefined });
    seen.add(x.code);
  }
  const mood = [];
  for (const s of steps) {
    const last = mood[mood.length - 1];
    if (!last || last.them !== s.st.bands.them || last.his !== s.st.bands.his) mood.push({ at: s.t, them: s.st.bands.them, his: s.st.bands.his });
  }
  const attn = steps.map(s => s.st.attention);
  return {
    activityEventId: base.facts.activityId, startAt: base.startAt, endAt, minutes: Math.round((endAt - base.startAt) / MIN),
    outcome: base.outcome, outcomeBy: base.facts.outcomeBy ?? null,
    late: finite(base.facts.lateMin) && base.facts.lateMin >= 10 ? base.facts.lateMin : null,
    phases, topics: topics.slice(0, 12), mood: mood.slice(0, 16),
    attention: { mean: round2(attn.reduce((a, b) => a + b, 0) / Math.max(1, attn.length)), low: round2(Math.min(...attn, 1)) },
    interruptions: inputs.moodlets.filter(m => m.at <= endAt).slice(0, 20).map(m => ({
      at: m.at, kind: m.kind, ...(m.who ? { who: m.who } : {}),
      ...(m.kind === 'chats' || m.kind === 'chats_sent' ? { sent: m.sent, received: m.received } : {}),
      ...(m.kind === 'text' ? { answered: finite(m.answeredAt) } : {}),
    })),
  };
}
