import { sanitizeWebContent } from '../brain/webSearch.js';
import { now, dayLabel, hhmm, resolveTimezone } from './clock.js';
import { embargoTone, isActive as embargoActive } from './embargo.js';
import { overSelfMentionBudget } from './claims.js';
import { availabilityAt } from './availability.js';
import { activityClass, companyOf } from './vitals.js';
import { getEvent } from './eventLog.js';
// 014 geo (§A7): a real venue next to a negative event is worded by its kind.
import { safePlaceName, negativeNow, negativeLabel } from './places.js';

// Life in prompts (spec 009 plan §R12/§R13, FR-028–030, FR-032): the per-turn
// lines buildConversationContext adds while life is on — a time line, one
// inner-state line (situation + feeling, hard cap 240 chars), ≤ 3 cast cards
// on relevance, a catch-up note, and a one-line state note for calls. Template
// lines only (no LLM in 009); every string that came from the world file or the
// log (place/cast names, statuses, option labels) is re-sanitized here with
// sanitizeWebContent, whatever eventLog did on append.
//
// Privacy (Principle II, filter before the LLM): a fact whose event came from a
// chat — an activity caused by a chat-moved decision, a lean nudged in a group —
// reaches a prompt only if canUseIn({originJid, learnedAt}, audience) allows it.
// 006's recall.canUseIn is wired in through setCanUseIn(); until then the
// fallback is same-chat only. A fact about a real person (subject_jid) shows
// only where that person is. Unknown origin (event not found) → excluded.
// Self-origin facts (the engine's own day) are usable anywhere. The dashboard
// audience ({kind:'dashboard'}) sees everything — it is never a prompt.
//
// Modes: under a heavy-event embargo the line is tone only (EMBARGO_TONE, no
// event, no nouns) and cards appear only for cast someone else named; over the
// chat's self-mention budget (claims.js) the line keeps tone + feelings only,
// with the same card rule. "Tone only" means no place, cast, plan or decision.
//
// Signatures take the projection explicitly (state, at, …); the facade closes
// over its projection for the C1 shapes (innerStateLine(audience), …).

export const INNER_MAX = 240;
export const CARD_MAX = 140;
export const CARDS_MAX = 3;
export const CALL_NOTE_MAX = 160;
export const CATCH_UP_MAX = 240;
export const STORY_FRAGMENT_MAX = 80;
const NAME_MAX = 40;
const LABEL_MAX = 48;
const FIELD_MAX = 80;
const RECENT_MAX = 4000;
const RECENT_MESSAGES = 10;
const ORIGIN_CACHE_MAX = 512;
const NEXT_HORIZON_SEC = 3 * 3600;

/** The fixed situational instruction that goes with the lines (§R12). */
export const SITUATION_NOTE =
  "This is just your situation right now — let it colour your mood and length; don't bring it up unless someone asks or it really fits, and when someone asks, answer from it.";

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** sanitizeWebContent, one line, capped at a word boundary. Always a string. */
export function cleanText(v, max = FIELD_MAX) {
  if (typeof v !== 'string') return '';
  const s = sanitizeWebContent(v).replace(/\s+/g, ' ').replace(/[;]+/g, ',').trim();
  return s.length <= max ? s : clip(s, max);
}

function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

// ── Seams: audience rule + origin lookup ──────────────────────────────────

/** Same-chat-only fallback until 006's canUseIn is wired in (fail closed). */
export function fallbackCanUseIn(item, audience) {
  return !!item && typeof item.originJid === 'string' && !!audience?.chatJid && item.originJid === audience.chatJid;
}

let canUseInFn = fallbackCanUseIn;

/** Replace the audience rule (006 recall.canUseIn, tests). `null` restores the fallback. */
export function setCanUseIn(fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error('setCanUseIn expects a function or null');
  canUseInFn = fn || fallbackCanUseIn;
}

const originCache = new Map();
const CHAIN_MAX = 16;
// The chat evidence time of a chat-origin event: the earliest ancestor on its
// cause chain that carries the same origin (a chat.trigger or claim.flagged).
// The event's own time can be much later (a lean, an adopted plan applied days
// after the claim), which would loosen 006's join-time floor (010 review).
function chainEvidenceAt(ev) {
  let at = ev.at;
  let cur = ev;
  for (let i = 0; i < CHAIN_MAX && Number.isSafeInteger(cur?.causeId); i++) {
    const parent = getEvent(cur.causeId);
    if (!parent || parent.originJid !== ev.originJid) break;
    if (Number.isFinite(parent.at) && parent.at < at) at = parent.at;
    cur = parent;
  }
  return at;
}
function defaultOriginLookup(eventId) {
  if (originCache.has(eventId)) return originCache.get(eventId);
  const ev = getEvent(eventId);
  const chat = ev && typeof ev.originJid === 'string' && ev.originJid !== 'self' && ev.originJid !== 'owner';
  const out = ev ? { originJid: ev.originJid, learnedAt: chat ? chainEvidenceAt(ev) : ev.at, subjectJid: ev.subjectJid ?? null } : null;
  // Origins never change (redaction rewrites payload/subject, not origin) — but
  // a redacted subject must not linger, so only subject-free rows are cached.
  if (out && !out.subjectJid) {
    if (originCache.size >= ORIGIN_CACHE_MAX) originCache.delete(originCache.keys().next().value);
    originCache.set(eventId, out);
  }
  return out;
}

let originLookup = defaultOriginLookup;

/**
 * Replace the event → { originJid, learnedAt, subjectJid } lookup (tests).
 * `null` restores the eventLog-backed default.
 */
export function setOriginLookup(fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error('setOriginLookup expects a function or null');
  originLookup = fn || defaultOriginLookup;
  originCache.clear();
}

function seesAll(audience) {
  return audience?.kind === 'dashboard';
}

export function subjectVisible(subjectJid, audience) {
  if (!subjectJid) return true;
  if (seesAll(audience)) return true;
  if (audience?.chatJid === subjectJid) return true;
  const m = audience?.members;
  return m instanceof Set ? m.has(subjectJid) : Array.isArray(m) ? m.includes(subjectJid) : false;
}

/**
 * One fact { originJid, learnedAt, subjectJid? } usable for this audience?
 * Owner-written world facts (010 research R3: validated fiction, no chat
 * content) pass like self ones; one that names a real person still shows only
 * where that person is (subjectVisible above).
 */
export function factAllowed(item, audience) {
  if (!item || typeof item.originJid !== 'string') return false;
  if (seesAll(audience)) return true;
  if (!subjectVisible(item.subjectJid, audience)) return false;
  if (item.originJid === 'self' || item.originJid === 'owner') return true;
  try { return canUseInFn({ originJid: item.originJid, learnedAt: item.learnedAt }, audience) === true; } catch { return false; }
}

/** Is the fact carried by world event `eventId` usable here? No id → the engine's own state (self). */
export function eventAllowed(eventId, audience) {
  if (!Number.isSafeInteger(eventId) || eventId < 1) return true;
  if (seesAll(audience)) return true;
  let o = null;
  try { o = originLookup(eventId); } catch { o = null; }
  return factAllowed(o, audience);
}

/**
 * A derived fact (e.g. a decision lean) is usable only if every origin passes
 * (006 R14). 010: each origin is checked at its own evidence time
 * (originAt[jid], the earliest event that carried it) when that is earlier.
 */
export function originsAllowed(origins, audience, learnedAt, originAt = null) {
  if (!Array.isArray(origins) || !origins.length) return true;
  return origins.every(o => {
    const own = originAt && typeof o?.jid === 'string' ? originAt[o.jid] : undefined;
    return factAllowed({ originJid: o?.jid, learnedAt: Number.isFinite(own) && !(own >= learnedAt) ? own : learnedAt }, audience);
  });
}

// learnedAt for a decision's facts: its latest lean (009), or earlier when the
// decision itself came from a chat (an adopted plan: the claim's time).
function decisionLearnedAt(d) {
  const base = d?.lean?.at ?? d?.opensAt;
  if (!Array.isArray(d?.origins) || !d.origins.length || !Number.isSafeInteger(d?.id)) return base;
  let o = null;
  try { o = originLookup(d.id); } catch { o = null; }
  const at = o && o.originJid !== 'self' && o.originJid !== 'owner' ? o.learnedAt : null;
  return Number.isFinite(at) && !(at >= base) ? at : base;
}

// ── 010 story seams (story-api §3.5; every default is 009's behaviour) ─────
//
// The story layer installs these at attach and gates each call on storyOn()
// itself; null restores the default. A seam that throws fails closed: the
// block / decision is dropped, the fragment and overlay are empty.

const defaultBlockOrigin = (plan) => plan?.eventId;
let blockOriginFn = defaultBlockOrigin;
let storyFragmentFn = null;
let castOverlayFn = null;
let decisionFilterFn = null;
let sickFilterFn = null;

function seamFn(name, fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error(`${name} expects a function or null`);
  return fn || null;
}

/** fn(plan, block) → the event id a plan block's facts come from (default: the plan's). */
export function setBlockOrigin(fn) {
  blockOriginFn = seamFn('setBlockOrigin', fn) || defaultBlockOrigin;
}

/** fn(state, audience, { at, mode }) → one short story fragment ('' for none). */
export function setStoryFragment(fn) {
  storyFragmentFn = seamFn('setStoryFragment', fn);
}

/** fn(state, castId, member, audience) → { label?, statusSuffix?, age? } for that member's card. */
export function setCastOverlay(fn) {
  castOverlayFn = seamFn('setCastOverlay', fn);
}

/** fn(decision, state, audience) → keep it as a decisionFragment / cast-card candidate? (default: keep all) */
export function setDecisionFilter(fn) {
  decisionFilterFn = seamFn('setDecisionFilter', fn);
}

/** fn(state, audience) → may this audience hear that he is sick? (default: yes) */
export function setSickFilter(fn) {
  sickFilterFn = seamFn('setSickFilter', fn);
}

// 012 (chat influence): fn(state, audience, { at }) → one short reason fragment
// ("still a bit annoyed after that argument", "up late chatting") for the chat
// the influence came from, '' elsewhere. Installed by the influence facade; the
// default (null) adds nothing. Throws → nothing.
let influenceFragmentFn = null;

/** fn(state, audience, { at }) → one short influence fragment ('' for none). */
export function setInfluenceFragment(fn) {
  influenceFragmentFn = seamFn('setInfluenceFragment', fn);
}

function influenceFragment(state, audience, at) {
  if (!influenceFragmentFn) return null;
  try {
    const text = influenceFragmentFn(state, audience, { at });
    return typeof text === 'string' && text ? cleanText(text, STORY_FRAGMENT_MAX) || null : null;
  } catch {
    return null;
  }
}

// 012 (chat invitations): fn(personJid, audience) → a short name for a real
// person an invitation outing is with ('' / null → "a friend from here").
// Installed by the influence facade; while null every line is as before.
let personLabelFn = null;

/** fn(personJid, audience) → a short display name, or null. */
export function setPersonLabel(fn) {
  personLabelFn = seamFn('setPersonLabel', fn);
}

/** 016: the installed person label (the influence facade's push-name reader), or null — scene memory's {FRIEND}. */
export function personLabelOf(jid, audience) {
  return personLabel(jid, audience);
}

function personLabel(jid, audience) {
  if (!personLabelFn || !jid) return null;
  try {
    const n = personLabelFn(jid, audience);
    return typeof n === 'string' && n ? cleanText(n, 20) || null : null;
  } catch {
    return null;
  }
}

// An outing from a chat invitation (012): an amended block with the same real
// person and place as a committed invitation (go / late).
function inviteOuting(state, plan, b) {
  if (!personLabelFn || !b?.fromAmendment || !b.subjectJid || !(state?.decisions instanceof Map)) return false;
  for (const d of state.decisions.values()) {
    if (d?.invite !== true || d.status !== 'committed' || d.subjectJid !== b.subjectJid) continue;
    if ((d.committed?.optionId === 'go' || d.committed?.optionId === 'late') && d.subject?.placeId === b.placeId) return true;
  }
  return false;
}

function blockAllowed(plan, b, audience) {
  if (!subjectVisible(b?.subjectJid, audience)) return false;
  let id;
  try { id = blockOriginFn(plan, b); } catch { return false; }
  if (id === undefined || id === null) return eventAllowed(plan?.eventId, audience);
  return Number.isSafeInteger(id) && eventAllowed(id, audience);
}

function storyFragment(state, audience, at, mode) {
  if (!storyFragmentFn) return null;
  try {
    const text = storyFragmentFn(state, audience, { at, mode });
    return typeof text === 'string' && text ? cleanText(text, STORY_FRAGMENT_MAX) || null : null;
  } catch {
    return null;
  }
}

function decisionKept(d, state, audience) {
  if (!decisionFilterFn) return true;
  try { return decisionFilterFn(d, state, audience) === true; } catch { return false; }
}

function sickShown(state, audience) {
  if (!sickFilterFn || !state?.sick) return true;
  try { return sickFilterFn(state, audience) === true; } catch { return false; }
}

function castOverlayOf(state, member, audience) {
  if (!castOverlayFn || !member) return null;
  try {
    const o = castOverlayFn(state, member.id, member, audience);
    return isObj(o) ? o : null;
  } catch {
    return null;
  }
}

// ── Mode ──────────────────────────────────────────────────────────────────

/** 'embargo' | 'tone' (over the self-mention budget) | 'full'. */
export function lineMode(state, at, chatJid, { overBudget } = {}) {
  if (embargoActive(state?.embargo, at)) return 'embargo';
  const over = typeof overBudget === 'boolean' ? overBudget : (chatJid ? safeOverBudget(chatJid, at) : false);
  return over ? 'tone' : 'full';
}

function safeOverBudget(chatJid, at) {
  try { return overSelfMentionBudget(chatJid, at); } catch { return false; }
}

// ── Time line ─────────────────────────────────────────────────────────────

/** 'Now: Wed 28 Oct, 14:20.' in the world's timezone. */
export function timeLine(state, at = now(), world) {
  const tz = resolveTimezone(state?.world?.timezone ?? world?.timezone);
  const t = finite(at) ? at : now();
  return `Now: ${dayLabel(t, tz)}, ${hhmm(t, tz)}.`;
}

// ── Fragments ─────────────────────────────────────────────────────────────

const TONE_BY_STATE = {
  free: 'free right now',
  light: 'a bit busy',
  busy: 'busy',
  meeting: 'tied up right now',
  dnd: 'not really on the phone',
  asleep: 'half asleep',
};

const MEAL_KINDS = new Set(['breakfast', 'lunch', 'dinner', 'meal', 'snack']);
const LEISURE_PHRASES = {
  break: 'on a short break from work',
  tv: 'watching TV',
  walk: 'out for a walk',
  groceries: 'getting groceries',
  cafe: 'out at a café',
  'eat-out': 'eating out',
  movie: 'watching a movie, phone away',
  gym: 'at the gym',
  workout: 'working out',
  run: 'out for a run',
  chores: 'doing chores',
  cook: 'cooking',
  ig: 'scrolling reels',
  rest: 'resting',
  nap: 'napping',
  read: 'reading',
  gaming: 'gaming',
};

function placeName(state, id) {
  if (!id) return null;
  const p = state?.places instanceof Map ? state.places.get(id) : null;
  if (!p) return null;
  if (p.kind === 'home' && id === state?.self?.homePlaceId) return 'home';
  if (id === state?.self?.officePlaceId || p.kind === 'office') return 'the office';
  const name = cleanText(p.name, NAME_MAX) || null;
  // 014 geo (§A7): sick / soaked / heavy / a bad chat mood now → a venue by its kind.
  return name ? safePlaceName(state, id, name, { negative: negativeNow(state, state?.viewAt ?? state?.at) }) : null;
}

function atPlace(state, id) {
  const n = placeName(state, id);
  if (!n || n === 'out') return '';
  return n === 'home' ? ' at home' : ` at ${n}`;
}

function castMember(state, id) {
  return state?.cast instanceof Map ? state.cast.get(id) ?? null : null;
}

function castNamesList(state, ids) {
  const names = (ids || []).map(id => cleanText(castMember(state, id)?.name, NAME_MAX)).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function untilPhrase(state, until, at) {
  if (!finite(until) || until <= at || until - at > 12 * 3600) return '';
  return ` till ${hhmm(until, resolveTimezone(state?.world?.timezone))}`;
}

/**
 * What he's in the middle of (concrete): "in a meeting till 15:00", "on the way to the office by cab".
 * null when the only thing to say is a sickness this audience may not hear (the caller says the tone).
 */
function situationPhrase(state, avail, at, { hideSick = false } = {}) {
  const act = isObj(state?.activity) ? state.activity : {};
  const kind = String(act.kind ?? '').toLowerCase();
  const cls = activityClass(act, { self: { officePlaceId: state?.self?.officePlaceId } });
  const until = untilPhrase(state, avail.until ?? act.endAt, at);
  const travel = state?.position?.travel;
  if (state?.sick && cls !== 'sleep' && (kind === 'sick' || kind === 'idle' || kind === 'free')) return hideSick ? null : 'home sick';
  switch (cls) {
    case 'sleep': return 'asleep';
    case 'meeting': {
      const withWho = castNamesList(state, act.withCast);
      return `in a meeting${withWho ? ` with ${withWho}` : ''}${until}`;
    }
    case 'office': return `at the office, at the desk${until}`;
    case 'wfh': return `working from home${until}`;
    case 'commute': {
      const toName = placeName(state, travel?.to);
      const to = toName === 'out' ? null : toName;   // 014 geo: an unmapped venue in a negative context
      const mode = cleanText(travel?.mode ?? '', 16);
      return `on the way${to ? ` ${to === 'home' ? 'home' : `to ${to}`}` : ''}${mode ? ` by ${mode}` : ''}`;
    }
    case 'meal': {
      const meal = MEAL_KINDS.has(kind) && kind !== 'meal' ? kind : 'a meal';
      const withWho = castNamesList(state, act.withCast);
      return `having ${meal}${withWho ? ` with ${withWho}` : ''}${atPlace(state, act.placeId)}`;
    }
    case 'gym': return 'at the gym';
    default: {
      const phrase = LEISURE_PHRASES[kind];
      const withWho = castNamesList(state, act.withCast);
      if (phrase) return `${phrase}${withWho ? ` with ${withWho}` : ''}`;
      if (cls === 'social' || withWho) return `out${withWho ? ` with ${withWho}` : ''}${atPlace(state, act.placeId)}`;
      if (avail.state === 'free') return `free${atPlace(state, act.placeId ?? state?.position?.placeId)}`;
      return `${TONE_BY_STATE[avail.state] ?? 'around'}${atPlace(state, act.placeId)}`;
    }
  }
}

/** Feelings from vitals, most salient first (no nouns that name places or people). */
export function feelingFragments(v = {}) {
  const out = [];
  const add = (score, text) => out.push({ score, text });
  const energy = v.energy;
  if (finite(energy)) {
    if (energy < 20) add(90 - energy, 'exhausted');
    else if (energy < 40) add(60 - energy, 'tired');
    else if (energy > 85) add(energy - 60, 'full of energy');
  }
  if (finite(v.sleepDebt)) {
    if (v.sleepDebt > 8) add(70, 'running on very little sleep');
    else if (v.sleepDebt > 4) add(45, 'slept badly');
  }
  if (finite(v.stress)) {
    if (v.stress > 75) add(v.stress - 10, 'stressed and short on patience');
    else if (v.stress > 55) add(v.stress - 30, 'a bit stressed');
  }
  if (finite(v.hunger)) {
    if (v.hunger > 80) add(v.hunger - 20, 'starving');
    else if (v.hunger > 65) add(v.hunger - 40, 'getting hungry');
  }
  if (finite(v.socialBattery) && v.socialBattery < 20) add(60 - v.socialBattery, 'peopled out, wants some quiet');
  if (v.sick) add(85, 'feeling under the weather');
  const val = v.mood?.valence;
  if (finite(val)) {
    if (val > 0.4) add(30 + val * 20, 'in a good mood');
    else if (val < -0.4) add(30 - val * 20, 'in a low mood');
  }
  out.sort((a, b) => b.score - a.score);
  if (!out.length) {
    out.push({ score: 0, text: finite(val) && val > 0.15 ? 'feeling pretty good' : 'feeling okay' });
  }
  return out.map(x => x.text);
}

// 011 (review R28): a storm reads like heavy rain; on the way, what reaches him
// depends on the trip — a cab or the metro keeps him dry, on foot or two wheels
// the day's umbrella (plan.gear) does or doesn't.
const EXPOSED_MODES = new Set(['walk', 'scooter', 'bike', 'motorbike', 'cycle', 'bicycle']);
function weatherFragment(state, cls) {
  const w = state?.weather;
  if (!w?.rain) return null;
  const hard = w.condition === 'heavy_rain' || w.condition === 'storm';
  if (cls === 'commute') {
    const mode = state.position?.travel?.mode;
    if (!EXPOSED_MODES.has(mode)) return mode ? 'it is raining on the way' : (hard ? 'getting soaked in heavy rain' : 'it is raining on the way');
    if (state.plan?.gear?.umbrella === true && mode === 'walk') return hard ? 'walking through heavy rain with an umbrella' : 'walking in the rain with an umbrella';
    return hard ? 'getting soaked in heavy rain' : 'getting wet on the way';
  }
  if (w.condition === 'storm') return 'a storm outside';
  return hard ? 'pouring outside' : 'raining outside';
}

const SOAKED_SEC = 2 * 3600;
// 011: he got caught in the rain earlier (≤ 2 h ago) — only where the trip's own origin may be seen,
// and not while he is still on that trip (the weather fragment says it then).
function soakedFragment(state, at, audience) {
  const s = state?.soakedAt;
  if (!s || !finite(s.at) || at < s.at || at - s.at > SOAKED_SEC) return null;
  const trip = state.position?.travel;
  if (trip && Number.isSafeInteger(s.travelEventId) && trip.eventId === s.travelEventId && finite(trip.endAt) && at < trip.endAt) return null;
  if (!eventAllowed(s.eventId, audience)) return null;
  return 'got caught in the rain earlier';
}

/** The next notable plan block within 3 h ("a meeting at 15:00 with X", "dinner with X at 20:30"). */
function nextFragment(state, at, audience) {
  const plan = state?.plan;
  if (!plan?.blocks?.length) return null;
  const tz = resolveTimezone(state?.world?.timezone);
  // Each block passes the audience rule on its own origin (010 R4: only an
  // adopted outing's blocks carry its chat; by default every block is the plan's).
  for (const b of plan.blocks) {
    if (b.start <= at || b.start - at > NEXT_HORIZON_SEC) continue;
    if (!blockAllowed(plan, b, audience)) continue;
    if (b.kind !== 'commute' && inviteOuting(state, plan, b)) {
      return `plans with ${personLabel(b.subjectJid, audience) || 'a friend from here'} at ${hhmm(b.start, tz)}`;
    }
    const withWho = castNamesList(state, b.withCast);
    if (b.kind === 'meeting') return `a meeting at ${hhmm(b.start, tz)}${withWho ? ` with ${withWho}` : ''}`;
    if (withWho) return `${b.kind === 'dinner' ? 'dinner' : 'plans'} with ${withWho} at ${hhmm(b.start, tz)}`;
    if (b.availability === 'dnd' && LEISURE_PHRASES[b.kind]) return `${b.kind === 'movie' ? 'a movie' : b.kind} at ${hhmm(b.start, tz)}`;
  }
  return null;
}

/** The soonest open decision whose every origin passes, as a lean ("torn about the gym plan, leaning: skip it"). */
function decisionFragment(state, audience) {
  if (!(state?.decisions instanceof Map)) return null;
  const open = [...state.decisions.values()]
    .filter(d => d?.status === 'open' && d.lean?.optionId && decisionKept(d, state, audience))
    .sort((a, b) => (a.decideBy ?? Infinity) - (b.decideBy ?? Infinity));
  for (const d of open) {
    if (!originsAllowed(d.origins, audience, decisionLearnedAt(d), d.originAt)) continue;
    if (d.invite === true && !subjectVisible(d.subjectJid, audience)) continue;   // 012: only where the inviter is
    const opt = (d.options || []).find(o => o.id === d.lean.optionId);
    // 014 geo (R5): a stored label is scrubbed of venue names in a negative context.
    const label = cleanText(negativeLabel(opt?.label ?? '', negativeNow(state, state?.viewAt ?? state?.at)), LABEL_MAX);
    if (!label) continue;
    const kind = cleanText(cleanText(String(d.kind ?? 'plan'), 40).replace(/[_:-]+/g, ' '), 24) || 'plan';
    const p = finite(d.lean.p) ? d.lean.p : 0.5;
    return p >= 0.7 ? `pretty sure about the ${kind}: ${label}` : `torn about the ${kind}, leaning: ${label}`;
  }
  return null;
}

function assemble(fragments, max) {
  const list = fragments.filter(f => f && f.text);
  const render = (fs) => {
    const s = [...fs].sort((a, b) => a.order - b.order).map(f => f.text).join('; ');
    return s ? `${s[0].toUpperCase()}${s.slice(1)}.` : '';
  };
  let keep = [...list];
  let line = render(keep);
  while (line.length > max && keep.length > 1) {
    let drop = 0;
    for (let i = 1; i < keep.length; i++) if (keep[i].prio < keep[drop].prio) drop = i;
    keep.splice(drop, 1);
    line = render(keep);
  }
  return line.length <= max ? line : `${clip(line.slice(0, -1), max - 1)}.`.slice(0, max);
}

/**
 * The inner-state line (FR-028): one sentence, ≤ 240 chars, situation + feeling.
 * opts: { world, chatJid (default audience.chatJid), overBudget (else claims.js) }.
 * Facts with a chat origin pass the audience rule first; a disallowed activity
 * collapses to the availability tone ("busy", "tied up right now").
 */
export function innerStateLine(state, at = now(), audience = null, opts = {}) {
  if (!state) return '';
  const t = finite(at) ? at : now();
  const avail = availabilityAt(state, t, opts.world);
  const mode = lineMode(state, t, opts.chatJid ?? audience?.chatJid, opts);
  const tone = { text: TONE_BY_STATE[avail.state] ?? 'around', prio: 90, order: 0 };
  if (mode === 'embargo') return assemble([tone, { text: embargoTone(state.embargo, t), prio: 100, order: 1 }], INNER_MAX);

  const hideSick = !sickShown(state, audience);
  const feelings = feelingFragments(vitalsOf(state, hideSick)).slice(0, 3)
    .map((text, i) => ({ text, prio: 80 - i * 10, order: 2 + i }));
  if (mode === 'tone') return assemble([tone, ...feelings.slice(0, 2)], INNER_MAX);

  const act = state.activity;
  const travelId = state.position?.travel?.eventId;
  const situationOk = eventAllowed(act?.eventId, audience) && eventAllowed(travelId, audience);
  const phrase = situationOk ? situationPhrase(state, avail, t, { hideSick }) : null;
  const situation = phrase ? { text: phrase, prio: 95, order: 0 } : tone;
  const cls = activityClass(act, { self: { officePlaceId: state.self?.officePlaceId } });
  const extra = [
    { text: weatherFragment(state, cls), prio: 30, order: 6 },
    { text: soakedFragment(state, t, audience), prio: 35, order: 6 },
    { text: nextFragment(state, t, audience), prio: 50, order: 7 },
    { text: decisionFragment(state, audience), prio: 55, order: 8 },
    { text: storyFragment(state, audience, t, mode), prio: 40, order: 9 },
    { text: influenceFragment(state, audience, t), prio: 45, order: 10 },
    { text: jobFragment(state), prio: 42, order: 11 },   // 015
  ];
  return assemble([situation, ...feelings, ...extra], INNER_MAX);
}

// 015 (owner decision 7: a god change is his life news, shared in any chat):
// out of work after an owner fire / quit. Keyed on the career state, never on a
// day off (014's 'off' is also an ordinary day off). '' otherwise.
function jobFragment(state) {
  return state?.story?.career?.employed === false ? 'between jobs' : '';
}

// 015: while he is out of work his work cast are former coworkers / a former manager.
function formerLabel(state, member, overlay) {
  if (state?.story?.career?.employed !== false || !member) return overlay;
  const rel = member.relation === 'manager' ? 'former manager' : member.relation === 'coworker' ? 'former coworker' : null;
  if (!rel) return overlay;
  return { ...(isObj(overlay) ? overlay : {}), label: rel };
}

// Blocks that are just his evening at home, not plans.
const QUIET_KINDS = new Set(['free', 'idle', 'rest', 'tv', 'dinner', 'sleep', 'sick', 'cook', 'chores']);

/**
 * 012: his evening as a short clause for an invitation note — "free until
 * 21:00", "plans at 20:00", "something on later", "you're tired" — built only
 * from plan blocks that pass this audience's rule (a block that doesn't →
 * "something on later": no time, no label). `until` bounds the look-ahead
 * (default his bedtime). '' when there is nothing to say.
 */
export function eveningClause(state, at = now(), audience = null, { until = null } = {}) {
  if (!state) return '';
  const plan = state.plan;
  const tz = resolveTimezone(state.world?.timezone);
  const end = finite(until) ? until : (finite(plan?.sleepAt) ? plan.sleepAt : at + 6 * 3600);
  const blocks = Array.isArray(plan?.blocks) ? plan.blocks : [];
  const cur = blocks.find(b => b.start <= at && at < b.end) ?? null;
  const next = blocks.find(b => b.start > at && b.start < end && b.kind !== 'commute' && b.kind !== 'sleep'
    && (!QUIET_KINDS.has(b.kind) || b.withCast?.length || b.fromAmendment)) ?? null;
  const nextOk = next ? blockAllowed(plan, next, audience) : false;
  const parts = [];
  if (cur && (cur.kind === 'work' || cur.kind === 'meeting') && blockAllowed(plan, cur, audience)) {
    parts.push(`working till ${hhmm(cur.end, tz)}`);
  } else if (!cur || QUIET_KINDS.has(cur.kind)) {
    if (next && nextOk) parts.push(`free until ${hhmm(next.start, tz)}`);
    else parts.push('free for now');
  }
  if (next) parts.push(nextOk ? `plans at ${hhmm(next.start, tz)}` : 'something on later');
  const v = state.vitals || {};
  if (finite(v.energy) && v.energy < 40) parts.push("you're tired");
  return parts.join(', ');
}

function vitalsOf(state, hideSick = false) {
  const v = isObj(state?.vitals) ? state.vitals : {};
  if (hideSick) return v.sick ? { ...v, sick: false } : v;
  return state?.sick && !v.sick ? { ...v, sick: true } : v;
}

// ── Cast cards ────────────────────────────────────────────────────────────

const RELATION_LABEL = {
  flatmate: 'Flatmate', coworker: 'Coworker', manager: 'Manager',
  friend: 'Friend', acquaintance: 'Acquaintance', neighbour: 'Neighbour',
};
// English relation words that point at one cast member when only one has that relation.
const RELATION_WORDS = {
  flatmate: ['flatmate', 'flat mate', 'roommate', 'room mate'],
  manager: ['manager', 'boss'],
  coworker: ['coworker', 'co-worker', 'colleague'],
  'family:parent': ['parent', 'parents', '%mother'],
  'family:sibling': ['sibling', '%sibling'],
};
const GENDERED = {
  '%mother': { she: ['mom', 'mum', 'mother'], he: ['dad', 'father'] },
  '%sibling': { she: ['sister', 'sis'], he: ['brother', 'bro'] },
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relationLabel(relation) {
  const r = String(relation ?? '');
  if (RELATION_LABEL[r]) return RELATION_LABEL[r];
  if (r.startsWith('family:')) {
    const role = cleanText(cleanText(r.slice(7), 40).replace(/[_-]+/g, ' '), 20);
    return role ? `Family (${role})` : 'Family';
  }
  return cleanText(r, 20) || 'Contact';
}

function matchName(member) {
  return cleanText(member?.name ?? '', NAME_MAX).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstName(member) {
  const first = matchName(member).split(' ')[0] ?? '';
  return first.length >= 3 && /^[\p{L}][\p{L}'’-]*$/u.test(first) ? first.toLowerCase() : null;
}

/**
 * Words that refer to a cast member: their name, their first name when no
 * one else in the cast shares it, and a relation word when only they have
 * that relation. `relationCounts` / `firstCounts`: Map → how many share it.
 */
export function castTerms(member, relationCounts = new Map(), firstCounts = new Map()) {
  const terms = new Set();
  const name = matchName(member);
  if (name.length >= 3) terms.add(name.toLowerCase());
  const first = firstName(member);
  if (first && (firstCounts.get(first) ?? 1) === 1) terms.add(first);
  const rel = String(member?.relation ?? '');
  if ((relationCounts.get(rel) ?? 0) === 1) {
    const pron = String(member?.pronouns ?? '').toLowerCase();
    const g = pron.startsWith('she') ? 'she' : pron.startsWith('he') ? 'he' : null;
    for (const w of RELATION_WORDS[rel] || (rel.startsWith('family:') ? [rel.slice(7)] : [])) {
      if (w.startsWith('%')) { for (const x of (g ? GENDERED[w]?.[g] : []) || []) terms.add(x); }
      else if (w.length >= 3) terms.add(w);
    }
  }
  return [...terms];
}

// A term matches from a word start. One whose last word has ≥ 4 letters may
// carry a short suffix — agglutinative forms ("managerum", "managerinte"),
// plurals; a short one ("mom", "bro") stays a whole word, so false hits stay rare.
const SUFFIX_RE = '\\p{L}{0,6}';
const lastWordLen = (t) => (t.split(' ').pop() ?? '').length;
function termsRegex(terms) {
  const list = terms.filter(t => t.length >= 3);
  const tolerant = list.filter(t => lastWordLen(t) >= 4).map(escapeRe);
  const strict = list.filter(t => lastWordLen(t) < 4).map(escapeRe);
  const alts = [
    ...(tolerant.length ? [`(?:${tolerant.join('|')})${SUFFIX_RE}`] : []),
    ...(strict.length ? [`(?:${strict.join('|')})`] : []),
  ];
  return alts.length ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${alts.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu') : null;
}

// Work as the topic of other people's messages, and (only while he is at work)
// a question about his day or plans — either pulls the work cast into the cards.
const WORK_TOPIC_RE = termsRegex(['office', 'meeting', 'manager', 'boss', 'colleague', 'coworker', 'co-worker',
  'team', 'standup', 'stand-up', 'client', 'deadline', 'job']);
const WORK_WORD_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?!workout)work${SUFFIX_RE}(?=$|[^\\p{L}\\p{N}])`, 'iu');
const DAY_TOPIC_RE = termsRegex(['today', 'your day', 'the day', 'plan', 'plans', 'schedule', 'busy', 'wyd', 'up to', 'you doing']);

// recentText: string | string[] | [{ text, fromMe }] — the last 10 messages.
// Strings count as other people's messages.
function splitRecent(recentText) {
  const list = Array.isArray(recentText) ? recentText.slice(-RECENT_MESSAGES) : [recentText];
  let others = '';
  let mine = '';
  for (const m of list) {
    const text = typeof m === 'string' ? m : (typeof m?.text === 'string' ? m.text : '');
    if (!text) continue;
    if (isObj(m) && m.fromMe === true) mine += ` ${text}`;
    else others += ` ${text}`;
  }
  return { others: others.slice(-RECENT_MAX), mine: mine.slice(-RECENT_MAX) };
}

/**
 * One card, ≈120 chars: "Flatmate Asha (she/her): easygoing, messy; status: between projects".
 * overlay (010 setCastOverlay, optional): { label (replaces the relation label),
 * age ("Asha (28, she/her)"), statusSuffix (leads the status: "status: away until Fri, …"),
 * hint (≤ 48 chars, closes the card: "…; not sure you can count on her"; its room
 * comes off personality and status first, so the card stays ≤ CARD_MAX) }.
 */
export function castCard(member, overlay = null) {
  if (!member) return '';
  const name = cleanText(member.name, NAME_MAX);
  if (!name) return '';
  const pron = cleanText(member.pronouns ?? '', 16);
  const o = isObj(overlay) ? overlay : {};
  const label = cleanText(typeof o.label === 'string' ? o.label : '', 24) || relationLabel(member.relation);
  const age = Number.isInteger(o.age) && o.age > 0 && o.age < 130 ? String(o.age) : '';
  const paren = [age, pron].filter(Boolean).join(', ');
  const head = `${label} ${name}${paren ? ` (${paren})` : ''}`;
  const hint = cleanText(typeof o.hint === 'string' ? o.hint : '', 48);
  const room = CARD_MAX - head.length - 2 - (hint ? hint.length + 2 : 0);
  const personality = cleanText(member.personality ?? '', Math.max(0, Math.min(60, room)));
  const statusRoom = room - personality.length - (personality ? 10 : 8);
  const suffix = cleanText(typeof o.statusSuffix === 'string' ? o.statusSuffix : '', 40);
  // The overlay's suffix ("away until Fri") is the fresher fact, so it leads and the base status is clipped first.
  const rawStatus = suffix ? [suffix, cleanText(member.status ?? '', 50)].filter(Boolean).join(', ') : (member.status ?? '');
  const status = statusRoom >= 12 ? cleanText(rawStatus, Math.min(suffix ? 70 : 50, statusRoom)) : '';
  let card = head;
  if (personality) card += `: ${personality}`;
  if (status) card += `${personality ? '; ' : ': '}status: ${status}`;
  if (hint) card += `${personality || status ? '; ' : ': '}${hint}`;
  return clip(card, CARD_MAX);
}

// The current meeting's attendees, else the next meeting's (≤ 3 h) — each on
// its own audience rule, as the inner line names them.
function meetingAttendees(state, at, audience) {
  const act = state?.activity;
  if (activityClass(act) === 'meeting') {
    return Array.isArray(act.withCast) && eventAllowed(act.eventId, audience) ? act.withCast : [];
  }
  const plan = state?.plan;
  for (const b of plan?.blocks || []) {
    if (b.kind !== 'meeting' || b.start <= at || b.start - at > NEXT_HORIZON_SEC) continue;
    return Array.isArray(b.withCast) && blockAllowed(plan, b, audience) ? b.withCast : [];
  }
  return [];
}

function workTopic(state, others, audience) {
  if (!others) return false;
  if (WORK_TOPIC_RE.test(others) || WORK_WORD_RE.test(others)) return true;
  const act = state?.activity;
  const office = state?.self?.officePlaceId;
  const cls = activityClass(act, { self: { officePlaceId: office } });
  const atWork = cls === 'office' || cls === 'wfh' || cls === 'meeting' || (!!office && act?.placeId === office);
  return atWork && eventAllowed(act?.eventId, audience) && DAY_TOPIC_RE.test(others);
}

/**
 * ≤ `limit` (max 3) cast cards for this prompt (FR-028). Relevant cast: named
 * in the recent messages, company in the current activity, the subject of an
 * open decision, the attendees of the current or next meeting — those three
 * only when their facts pass the audience rule — and the work cast when other
 * people talk about work (or ask about his day while he's at work).
 * Under embargo or over the self-mention budget, only cast that someone else
 * named. Ordered: named by others, named by him, activity, decisions, meeting,
 * manager, coworkers; then closeness. opts: { world, chatJid, overBudget }.
 */
export function castCards(state, at = now(), audience = null, recentText = '', limit = CARDS_MAX, opts = {}) {
  if (!(state?.cast instanceof Map) || !state.cast.size) return [];
  const n = Math.max(0, Math.min(CARDS_MAX, Number.isFinite(limit) ? Math.floor(limit) : CARDS_MAX));
  if (!n) return [];
  const t = finite(at) ? at : now();
  const mode = lineMode(state, t, opts.chatJid ?? audience?.chatJid, opts);
  const { others, mine } = splitRecent(recentText);
  const counts = new Map();
  const firsts = new Map();
  for (const c of state.cast.values()) {
    counts.set(c.relation, (counts.get(c.relation) ?? 0) + 1);
    const f = firstName(c);
    if (f) firsts.set(f, (firsts.get(f) ?? 0) + 1);
  }

  const rank = new Map(); // castId → rank (lower first)
  const consider = (id, r) => {
    if (state.cast.has(id) && (!rank.has(id) || r < rank.get(id))) rank.set(id, r);
  };
  for (const c of state.cast.values()) {
    const re = termsRegex(castTerms(c, counts, firsts));
    if (!re) continue;
    if (others && re.test(others)) consider(c.id, 0);
    else if (mode === 'full' && mine && re.test(mine)) consider(c.id, 1);
  }
  if (mode === 'full') {
    const act = state.activity;
    const company = companyOf(act);
    if (company.length && eventAllowed(act.eventId, audience)) {
      for (const id of company) consider(id, 2);
    }
    if (state.decisions instanceof Map) {
      for (const d of state.decisions.values()) {
        if (d?.status !== 'open' || !decisionKept(d, state, audience)
          || !originsAllowed(d.origins, audience, decisionLearnedAt(d), d.originAt)) continue;
        if (d.invite === true && !subjectVisible(d.subjectJid, audience)) continue;   // 012: only where the inviter is
        for (const id of d.subject?.castIds || []) consider(id, 3);
      }
    }
    for (const id of meetingAttendees(state, t, audience)) consider(id, 4);
    if (workTopic(state, others, audience)) {
      for (const c of state.cast.values()) {
        if (c?.relation === 'manager') consider(c.id, 5);
        else if (c?.relation === 'coworker') consider(c.id, 6);
      }
    }
  }
  return [...rank.entries()]
    .sort((a, b) => a[1] - b[1]
      || (state.cast.get(b[0])?.metrics?.closeness ?? 0) - (state.cast.get(a[0])?.metrics?.closeness ?? 0)
      || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([id]) => castCard(state.cast.get(id), formerLabel(state, state.cast.get(id), castOverlayOf(state, state.cast.get(id), audience))))
    .filter(Boolean);
}

// ── Catch-up and calls ────────────────────────────────────────────────────

const AWAY_REASON = {
  meeting: 'in a meeting',
  asleep: 'asleep',
  busy: 'busy',
  light: 'busy',
  dnd: 'away from your phone',
  free: 'away from your phone',
};

function awayPhrase(min) {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `~${m} min`;
  const h = Math.round(m / 30) / 2;
  return `~${h % 1 ? h.toFixed(1) : h} h`;
}

/**
 * The catch-up note (FR-022) for a drained turn: catchUp = { awayMin, newCount,
 * reason? (availability when it was deferred), triggerIds? }. '' when absent.
 */
export function catchUpNote(catchUp) {
  if (!isObj(catchUp)) return '';
  const away = finite(catchUp.awayMin) && catchUp.awayMin > 0 ? catchUp.awayMin : null;
  const count = Number.isSafeInteger(catchUp.newCount) && catchUp.newCount > 0 ? catchUp.newCount : null;
  if (!away && !count) return '';
  const why = AWAY_REASON[catchUp.reason] ?? null;
  const parts = [];
  if (away) parts.push(`You were away ${awayPhrase(away)}${why ? ` (${why})` : ''}`);
  if (count) parts.push(`${count} new message${count === 1 ? '' : 's'} since you last looked`);
  parts.push('reply once, covering what needs you');
  const s = parts.join('; ');
  return clip(`${s[0].toUpperCase()}${s.slice(1)}.`, CATCH_UP_MAX);
}

/**
 * One line for the call prompt (FR-025): how he is as the phone rings — "You
 * were asleep when the phone rang — groggy, keep it short." Activity details
 * pass the audience rule like the inner-state line; under embargo only tone.
 * opts: { world }.
 */
export function callStateNote(state, at = now(), audience = null, opts = {}) {
  if (!state) return '';
  const t = finite(at) ? at : now();
  const avail = availabilityAt(state, t, opts.world);
  if (embargoActive(state.embargo, t)) return 'You are having a quiet, low day; keep the call short and easy.';
  if (avail.state === 'asleep') return 'You were asleep when the phone rang — groggy, keep it short.';
  const act = state.activity;
  const allowed = eventAllowed(act?.eventId, audience) && eventAllowed(state.position?.travel?.eventId, audience);
  let note;
  if (!allowed) {
    note = {
      free: 'You are free right now.', light: 'You are a bit busy right now.', busy: 'You are busy right now; keep it short.',
      meeting: 'You are tied up right now; keep it brief.', dnd: 'You stepped away to take this; keep it short.',
    }[avail.state] ?? 'You picked up the phone.';
  } else {
    const s = situationPhrase(state, avail, t);
    const brief = avail.state === 'meeting' || avail.state === 'busy' || avail.state === 'dnd' ? '; keep it brief' : '';
    note = `You are ${s}${brief}.`;
  }
  const v = state.vitals || {};
  if (finite(v.energy) && v.energy < 20) note = `${note.slice(0, -1)} — and exhausted.`;
  return clip(note, CALL_NOTE_MAX);
}

/**
 * Everything a reply prompt gets in one call (the facade's convenience):
 * { time, inner, cards, catchUp, situation }. opts: { world, chatJid,
 * recentText, catchUp, overBudget }.
 */
export function lifeLines(state, at = now(), audience = null, opts = {}) {
  const t = finite(at) ? at : now();
  return {
    time: timeLine(state, t, opts.world),
    inner: innerStateLine(state, t, audience, opts),
    cards: castCards(state, t, audience, opts.recentText ?? '', CARDS_MAX, opts),
    catchUp: catchUpNote(opts.catchUp),
    situation: SITUATION_NOTE,
  };
}
