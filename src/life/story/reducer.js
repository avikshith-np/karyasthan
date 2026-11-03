import { dateKey } from '../clock.js';
import { companyOf } from '../vitals.js';
import { worldWithPlaces } from '../places.js';

// The story slice of the world projection (spec 010 data-model §3). Pure: no DB,
// no I/O, no clock reads — everything comes from the event being folded and the
// state it is folded into, so a replay gives exactly the live result.
//
// Two handler tables, both `(s, ev, p, world)` like projector.js HANDLERS:
//   - STORY_HANDLERS: the 010 event types only (data-model §2). The projector
//     merges them under its own HANDLERS (009 wins on a name clash).
//   - STORY_OBSERVERS: 009 types the story also learns from (shared time, the
//     work log, new-cast pacing, arc decision ids, the career base). They are
//     NOT handlers: the projector calls them AFTER the 009 handler for that type,
//     so 009's own effect is never replaced.
// `world.rewound` is not here: its range bookkeeping is the projector's.
//
// Payloads are untrusted shapes (eventLog sanitized the strings; redacted rows
// arrive as {redacted:true}): every handler picks typed fields with caps,
// tolerates anything missing and ignores a redacted row. The slice holds plain
// objects and arrays only (no Maps), so serializeState needs no change.

// ── Vocabulary ────────────────────────────────────────────────────────────

export const CATEGORIES = Object.freeze(['romance', 'career', 'family', 'cast', 'health', 'social', 'heavy']);
export const FATE_MODES = Object.freeze(['natural', 'guided', 'frozen']);
export const SLIDERS = Object.freeze(['drama', 'romanceAppetite', 'careerAmbition', 'familyPressure', 'socialAppetite', 'heavyLikelihood']);
export const RECONCILER_MODES = Object.freeze(['auto', 'review', 'off']);
/** Romance stages in order (research R8); romance.js reads the same list. */
export const ROMANCE_STAGES = Object.freeze(['single', 'interested', 'talking', 'dating', 'committed', 'engaged', 'married']);
/** Cool-down after a breakup (spec Assumptions: 2 months) and after any other romance end (fizzled, cancelled …). */
export const ROMANCE_BREAKUP_COOLDOWN_DAYS = 60;
export const ROMANCE_END_COOLDOWN_DAYS = 14;
/** A heavy arc lasts at most 30 days (research R17), so the heavy guard is bounded. */
export const HEAVY_MAX_DAYS = 30;

/** Event types that are pure routine (phone checks): a Director preview's fingerprint ignores them (research R12). */
export const ROUTINE_TYPES = Object.freeze(new Set(['phone.check.started', 'phone.check.ended', 'availability.changed']));

/**
 * Types a rewind never cancels (research R11): owner decisions, privacy decisions
 * and the inert pointers they hang off. `decision.expired` is kept only for some
 * reasons — use isRewindKept(event), which also checks that.
 */
export const REWIND_KEEP = Object.freeze(new Set([
  'director.action', 'director.fate_set', 'director.slider_set', 'director.pin_set', 'director.pin_cleared',
  'director.paused', 'director.resumed', 'director.bookmark', 'director.bookmark_removed',
  'director.seed_set', 'director.reconciler_mode',
  'world.rewound', 'event.reverted', 'heavy.vetoed', 'claim.flagged', 'claim.withdrawn',
  // 014 geo: road geometry is bookkeeping, not story; a stale one is inert (endpoint match).
  'route.recorded',
]));
/** `decision.expired` reasons a rewind keeps: engine consequences of kept owner/privacy events. */
export const REWIND_KEEP_EXPIRED_REASONS = Object.freeze(new Set(['withdrawn', 'frozen', 'pinned', 'owner_cancelled']));

/** True when a rewind range must not exclude this event (REWIND_KEEP + the reason-scoped decision.expired). */
export function isRewindKept(event) {
  if (!event || typeof event.type !== 'string') return false;
  if (REWIND_KEEP.has(event.type) || event.type.startsWith('director.')) return true;
  return event.type === 'decision.expired' && REWIND_KEEP_EXPIRED_REASONS.has(event.payload?.reason);
}

/**
 * Owner-tunable seed paths (`director.seed_set`, research R19) and their bounds.
 * A value of null clears the override (back to the seed file).
 */
export const SEED_PATHS = Object.freeze({
  'career.appraisalMonth': (v) => (Number.isInteger(v) && v >= 1 && v <= 12 ? v : undefined),
  'career.noticeDays': (v) => (Number.isInteger(v) && v >= 0 && v <= 120 ? v : undefined),
  'career.salaryChangePct.min': (v) => (finite(v) && v >= -5 && v <= 0 ? round2(v) : undefined),
  'career.salaryChangePct.max': (v) => (finite(v) && v >= 0 && v <= 20 ? round2(v) : undefined),
  'family.callCadenceDays': (v) => (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1])
    && v[0] >= 1 && v[0] <= 30 && v[1] >= 1 && v[1] <= 60 && v[0] <= v[1] ? [v[0], v[1]] : undefined),
});

/** Clean a seed override; undefined when the path or value is not allowed. */
export function cleanSeedValue(path, value) {
  const fn = Object.prototype.hasOwnProperty.call(SEED_PATHS, path) ? SEED_PATHS[path] : null;
  if (!fn) return undefined;
  return value === null ? null : fn(value);
}

/** Pin keys (research R6): self.job, self.home (reserved), self.relationship, arc:<id>.stage, cast:<slug>. */
export function isPinKey(key) {
  return typeof key === 'string' && (PIN_SELF_RE.test(key) || PIN_ARC_RE.test(key) || CAST_ID_RE.test(key));
}

// ── Helpers ───────────────────────────────────────────────────────────────

const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const KIND_RE = /^[a-z][a-z0-9_:-]{0,31}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PIN_SELF_RE = /^self\.(job|home|relationship)$/;
const PIN_ARC_RE = /^arc:[1-9]\d{0,14}\.stage$/;

const DAY = 86400;
const MAX_HISTORY = 20;
const MAX_BOOKMARKS = 30;
const MAX_NEW_CAST_ATS = 8;
const MAX_WORKLOG_DAYS = 400;
const MAX_ARC_DECISIONS = 16;
const MAX_ARC_CAST = 4;
const MAX_ARCS = 64;
const MAX_PROPOSALS = 32;
const MAX_ADOPTED = 200;
const MAX_COMMITMENTS = 32;
const MAX_PINS = 64;
const MAX_OCCASIONS = 16;
const MAX_DELTA = 0.2;
const MAX_TOGETHER_DELTA_MIN = 1440;
const MAX_SESSION_MIN = 1440;
const MAX_AWAY_DAYS = 31;

const BEAT_KINDS = new Set(['status', 'away', 'back', 'hobby', 'news', 'milestone', 'trip']);
const ARC_END_OUTCOMES = new Set(['fizzled', 'broken_up', 'done', 'cancelled', 'frozen']);
const BANDS = new Set(['poor', 'fair', 'good', 'great']);
const HUNT_PHASES = new Set(['started', 'paused', 'ended']);
const METRIC_KEYS = ['closeness', 'trust', 'tension'];
const REL_KEYS = ['intimacy', 'passion', 'commitment'];
const CONTACT_REASONS = new Set(['shared_time', 'family_call', 'decision']);
const CAST_FIELD_CAPS = { status: 160, availability: 160, job: 60, employer: 80, personality: 200, speech: 160, pronouns: 24, hometown: 80 };
// Events after which his current activity (and so who he is with) may have changed.
const TOGETHER_TYPES = ['genesis', 'activity.started', 'activity.ended', 'travel.started', 'travel.arrived', 'sleep.started', 'woke', 'world.reanchored'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const kindOf = (v) => (typeof v === 'string' && KIND_RE.test(v.toLowerCase()) ? v.toLowerCase() : null);
const slug = (v) => (typeof v === 'string' && SLUG_RE.test(v) ? v : null);
const castId = (v) => (typeof v === 'string' && CAST_ID_RE.test(v) ? v : null);
const placeId = (v) => (typeof v === 'string' && PLACE_ID_RE.test(v) ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const round2 = (v) => Math.round(v * 100) / 100;
const castIdList = (v, max) => (Array.isArray(v) ? [...new Set(v.map(castId).filter(Boolean))].slice(0, max) : []);
const tzOf = (s) => s?.world?.timezone;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── Initial state ─────────────────────────────────────────────────────────

/** Empty story slice (data-model §3). Plain JSON. */
export function initialStory() {
  return {
    controls: {
      fate: Object.fromEntries(CATEGORIES.map(c => [c, 'natural'])),
      sliders: Object.fromEntries(SLIDERS.map(n => [n, 0.5])),
      pins: {},
      paused: false,
      pausedAt: null,
      reconcilerMode: null, // null → config.arcs.reconcilerMode
    },
    seedOverlay: {},
    daily: { lastDate: null, lastAt: null },
    arcs: {},
    relationships: {},
    history: {},
    castLife: {},
    together: {},
    workLog: { days: [] },
    career: {
      title: null, employerName: null, officePlaceId: null, salary: null, startedAt: null,
      lastAppraisalYear: null, lastAppraisal: null, huntArcId: null, huntPhase: null, notice: null,
      eventId: null, // last folded career.* event; worldOverlay is the identity while null
    },
    romance: { arcId: null, partnerId: null, stage: 'single', stageAt: null, cooldownUntil: null },
    family: { lastCallAt: null, nextCallAt: null, occasionsDone: {}, lastMajorAt: null },
    heavy: { lastOnsetAt: null, lastProposedAt: null, proposals: {}, active: null },
    newCast: { ats: [] },
    adopted: {},
    commitments: [], // pending commitment.recorded: [{eventId, dueAt, placeId, castIds}] (reconciler calendar fit)
    bookmarks: [],
  };
}

/** The story slice of `s`, created (or completed, for an older snapshot) in place. */
function storyOf(s) {
  if (!isObj(s.story)) { s.story = initialStory(); return s.story; }
  let dflt = null;
  for (const k of STORY_KEYS) {
    if (!own(s.story, k) || s.story[k] === null || typeof s.story[k] !== 'object') {
      dflt = dflt ?? initialStory();
      s.story[k] = dflt[k];
    }
  }
  return s.story;
}
const STORY_KEYS = Object.keys(initialStory());

function relOf(st, id) {
  if (!isObj(st.relationships[id])) st.relationships[id] = { intimacy: 0, passion: 0, commitment: 0, togetherMin: 0, lastContactAt: null };
  return st.relationships[id];
}

function lifeOf(st, id) {
  if (!isObj(st.castLife[id])) st.castLife[id] = { status: null, statusAt: null, away: null, lastBeat: null };
  return st.castLife[id];
}

// An effect of the active heavy onset (research R17: its cast beat, its sick.started):
// caused by that heavy.started. Prompts keep these to DM/call audiences (fragment.js).
function heavyCaused(st, ev) {
  return Number.isSafeInteger(ev?.causeId) && isObj(st.heavy?.active) && ev.causeId === st.heavy.active.id;
}

function castExists(s, id) {
  return !!id && s.cast instanceof Map && s.cast.has(id);
}

function touchContact(st, ids, at) {
  for (const id of ids) {
    const r = relOf(st, id);
    if (r.lastContactAt === null || at > r.lastContactAt) r.lastContactAt = at;
  }
}

function relationshipWord(stage) {
  return ['dating', 'committed', 'engaged', 'married'].includes(stage) ? stage : 'single';
}

function setRelationship(s, stage) {
  if (isObj(s.self)) s.self = { ...s.self, relationship: relationshipWord(stage) };
}

// Small, flat arc state: primitives only, ≤ 16 keys.
function cleanArcState(v) {
  if (!isObj(v)) return {};
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 16)) {
    if (!STATE_KEY_RE.test(k)) continue;
    if (typeof x === 'boolean' || x === null) out[k] = x;
    else if (finite(x)) out[k] = x;
    else if (typeof x === 'string') out[k] = x.slice(0, 80);
  }
  return out;
}

function pruneArcs(st) {
  const ids = Object.keys(st.arcs);
  if (ids.length <= MAX_ARCS) return;
  const ended = ids.filter(id => st.arcs[id].status !== 'active').sort((a, b) => Number(a) - Number(b));
  for (const id of ended.slice(0, ids.length - MAX_ARCS)) delete st.arcs[id];
}

function bumpArcBeat(st, castIdValue, eventId) {
  for (const a of Object.values(st.arcs)) {
    if (a.status === 'active' && a.castIds.includes(castIdValue)) a.lastBeatEventId = eventId;
  }
}

function pruneMap(map, max, keep) {
  const ids = Object.keys(map);
  if (ids.length <= max) return;
  const drop = ids.filter(id => !keep(map[id])).sort((a, b) => Number(a) - Number(b));
  for (const id of drop.slice(0, ids.length - max)) delete map[id];
}

/** The job a fact sheet states: his title, or that he has none (a fire / quit keeps the old title in the career slice). */
export function jobWordsOf(state, world) {
  const c = state?.story?.career;
  if (c?.employed === false) return 'between jobs';
  return c?.title ?? world?.self?.job?.title ?? null;
}

// Career base: genesis self.job (copied into the genesis payload), else the world.
function ensureCareer(s, st, world) {
  const c = st.career;
  const job = isObj(world?.self?.job) ? world.self.job : {};
  if (c.title === null) c.title = str(job.title, 60);
  if (c.employerName === null) c.employerName = str(job.employerName, 80);
  if (c.officePlaceId === null) c.officePlaceId = placeId(s.self?.officePlaceId) ?? placeId(job.officePlaceId);
  if (c.salary === null && finite(world?.money?.salary) && world.money.salary >= 0) c.salary = world.money.salary;
  if (c.startedAt === null) c.startedAt = time(s.genesisAt);
  return c;
}

function workDay(s, st, at) {
  const date = dateKey(at, tzOf(s));
  const days = st.workLog.days;
  let i = days.length - 1;
  while (i >= 0 && days[i].date > date) i--;
  if (i >= 0 && days[i].date === date) return days[i];
  const entry = { date, late: 0, crunch: 0, sick: 0, stress: null, n: 0 };
  days.splice(i + 1, 0, entry);
  if (days.length > MAX_WORKLOG_DAYS) days.splice(0, days.length - MAX_WORKLOG_DAYS);
  return entry;
}

const CHAT_ORIGIN_KINDS = new Set(['group', 'dm', 'call', 'ig']);
const isChatEvent = (ev) => isObj(ev) && CHAT_ORIGIN_KINDS.has(ev.originKind);

// Shared time with cast: open a session for everyone in his current activity's
// withCast, close (and credit) everyone who is no longer in it. A session of a
// chat-origin activity (an outing adopted from a chat) is marked `chat` and
// credits nothing: shared time and contact feed self-origin drift, which would
// launder the chat fact into every audience (006: derived facts AND their origins).
// A work meeting's attendees are not company (vitals.companyOf): no session.
function syncTogether(s, st, at, ev = null) {
  // 015: a departed member earns no shared time or contact (filtered only once someone departed).
  const gone = isObj(st.departed) ? st.departed : null;
  const current = new Set(companyOf(s.activity).map(castId).filter(id => id && !(gone && own(gone, id))));
  // Known only on the event that set the current activity; otherwise sessions keep their flag.
  const chatNow = isObj(ev) && s.activity?.eventId === ev.id ? isChatEvent(ev) : null;
  const close = (id, t) => {
    if (!t.chat) {
      const min = clamp((at - t.openSince) / 60, 0, MAX_SESSION_MIN);
      t.minutesSinceDaily = Math.round((t.minutesSinceDaily ?? 0) + min);
      touchContact(st, [id], at);
    }
    t.openSince = null;
    delete t.chat;
  };
  for (const [id, t] of Object.entries(st.together)) {
    if (!isObj(t) || t.openSince === null) continue;
    if (current.has(id) && (chatNow === null || !!t.chat === chatNow)) continue;
    close(id, t);
  }
  for (const id of current) {
    const t = st.together[id];
    if (isObj(t) && t.openSince !== null) continue;
    const chat = chatNow === true;
    st.together[id] = { openSince: at, minutesSinceDaily: isObj(t) ? (t.minutesSinceDaily ?? 0) : 0, ...(chat ? { chat: true } : {}) };
    if (!chat) touchContact(st, [id], at);
  }
}

const skip = (ev, p) => ev?.redacted === true || p?.redacted === true;

// ── 014 geo: place coordinates/venue fields and the places signature ─────

const VENUE_REF_RE = /^(?:node|way|relation)\/\d{1,15}$/;
const KIND_TAG_RE = /^[a-z_]{1,24}=[a-z0-9_;-]{1,32}$/;

/** A cleaned venue object {src:'osm', ref, area?, kindTag?} or null. */
export function cleanVenue(v) {
  if (!isObj(v) || v.src !== 'osm' || typeof v.ref !== 'string' || !VENUE_REF_RE.test(v.ref)) return null;
  const area = str(v.area, 40);
  return { src: 'osm', ref: v.ref, ...(area ? { area } : {}), ...(typeof v.kindTag === 'string' && KIND_TAG_RE.test(v.kindTag) ? { kindTag: v.kindTag } : {}) };
}

// {lat, lon} only together and in range; venue: cleaned object, or null to clear.
function placeGeoFields(p) {
  const out = {};
  if (finite(p?.lat) && finite(p?.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180) { out.lat = p.lat; out.lon = p.lon; }
  if (p?.venue === null) out.venue = null;
  else if (p?.venue !== undefined) { const v = cleanVenue(p.venue); if (v) out.venue = v; }
  return Object.keys(out).length ? out : null;
}

/**
 * The places content signature (R27): FNV-1a over the sorted (id, lat, lon,
 * venue ref) of every place plus the folded route record ids. Set only by a
 * 014-relevant fold (a venue create, a move/venue update, a route record), so a
 * pre-014 log never has one.
 */
export function placesSigOf(s) {
  const parts = [];
  for (const p of s?.places instanceof Map ? s.places.values() : []) parts.push(`${p?.id}@${p?.lat},${p?.lon},${p?.venue?.ref ?? ''}`);
  parts.sort();
  const routes = isObj(s?.routes) ? Object.keys(s.routes).sort().map(k => `${k}#${s.routes[k]?.eventId ?? ''}`) : [];
  let h = 0x811c9dc5;
  for (const ch of `${parts.join(';')}|${routes.join(';')}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${parts.length}r${routes.length}:${h.toString(16)}`;
}

// ── 015 Director as god (plan §1.2/§1.3) ──────────────────────────────────
// Every new slice (pending, outcomes, departed, departedRev, self.homeHistory,
// career.employed / pattern) is created lazily by its handler and is never in
// initialStory(): storyOf backfills every STORY_KEYS entry, which would change
// every pre-015 fixture.

export const CAREER_REASONS = Object.freeze(['hire', 'fire', 'quit', 'promote', 'job', 'salary', 'pattern']);
export const OUTCOMES = Object.freeze(['well', 'badly', 'cancelled']);
export const DEPART_HOW = Object.freeze(['moved_away', 'moved_out', 'written_out']);
const PENDING_TYPES = new Set(['career.set', 'self.moved', 'vitals.planned', 'sick.planned']);
/** Career changes that change his day (office, work blocks): today is re-planned for these. */
export const PLAN_REASONS = new Set(['hire', 'job', 'fire', 'quit', 'pattern']);
const MAX_PENDING = 32;
const MAX_OUTCOMES = 32;
const MAX_HOME_HISTORY = 8;
const OUTCOME_KEEP_SEC = 14 * DAY;
const VITAL_KEYS = ['energy', 'stress', 'valence', 'socialBattery', 'workPressure'];

function pendingOf(st) {
  if (!isObj(st.pending)) st.pending = {};
  return st.pending;
}

function weekdays(v) {
  return Array.isArray(v) ? [...new Set(v.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : null;
}

function cleanPattern(v) {
  if (!isObj(v)) return null;
  const officeDays = weekdays(v.officeDays) ?? [];
  const wfhDays = (weekdays(v.wfhDays) ?? []).filter(d => !officeDays.includes(d));
  return { officeDays, wfhDays };
}

// A career.set's effect (immediate, or when its change.applied folds).
function applyCareerSet(s, st, p, eventId, at, world) {
  const c = ensureCareer(s, st, world);
  const reason = CAREER_REASONS.includes(p.reason) ? p.reason : null;
  if (!reason) return;
  const setSelfOffice = (id) => { if (isObj(s.self)) s.self = { ...s.self, officePlaceId: id }; };
  if (reason === 'hire' || reason === 'job') {
    const title = str(p.title, 60);
    const employerName = str(p.employerName, 80);
    const office = placeId(p.officePlaceId);
    if (title) c.title = title;
    if (employerName) c.employerName = employerName;
    if (office) { c.officePlaceId = office; setSelfOffice(office); }
    if (finite(p.salary) && p.salary >= 0) c.salary = p.salary;
    Object.assign(c, { employed: true, startedAt: at, notice: null });
  } else if (reason === 'fire' || reason === 'quit') {
    Object.assign(c, { employed: false, notice: null, officePlaceId: null });
    setSelfOffice(null);
  } else if (reason === 'promote') {
    const title = str(p.title, 60);
    if (title) c.title = title;
    if (finite(p.salary) && p.salary >= 0) c.salary = p.salary;
  } else if (reason === 'salary') {
    if (finite(p.salary) && p.salary >= 0) c.salary = p.salary;
  }
  const pattern = cleanPattern(p.pattern);
  if (pattern) c.pattern = pattern;
  c.eventId = eventId;
  // The drift key moves only with what changes his day (a salary / title change re-plans nothing).
  if (PLAN_REASONS.has(reason) || pattern) c.godEventId = eventId;
}

function applyMove(s, p, eventId) {
  const to = placeId(p.homePlaceId);
  if (!to || !isObj(s.self)) return;
  const from = placeId(s.self.homePlaceId);
  const hist = Array.isArray(s.self.homeHistory) ? s.self.homeHistory.filter(x => x !== to) : [];
  if (from && from !== to && !hist.includes(from)) hist.push(from);
  s.self = { ...s.self, homePlaceId: to, homeEventId: eventId, homeHistory: hist.slice(-MAX_HOME_HISTORY) };
}

function applyPending(s, st, entry, eventId, at, world) {
  if (entry.type === 'career.set') applyCareerSet(s, st, entry.payload, eventId, at, world);
  else if (entry.type === 'self.moved') applyMove(s, entry.payload, eventId);
}

// A due consequence (engine, caused by the owner event) consumes its pending entry.
function consumePending(s, ev) {
  const st = storyOf(s);
  const id = posInt(ev.causeId);
  if (id && isObj(st.pending) && isObj(st.pending[id])) delete st.pending[id];
}

function deltaOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of VITAL_KEYS) if (finite(v[k])) out[k] = v[k];
  return Object.keys(out).length ? out : null;
}

function prunePending(st) {
  pruneMap(st.pending, MAX_PENDING, () => false);
}

function pruneOutcomes(st, at) {
  for (const [id, o] of Object.entries(st.outcomes)) {
    if (o.status !== 'set' && finite(o.closedAt) && at - o.closedAt > OUTCOME_KEEP_SEC) delete st.outcomes[id];
  }
  pruneMap(st.outcomes, MAX_OUTCOMES, (o) => o.status === 'set');
}

/** 015 handlers (the projector merges them under its own table, like STORY_HANDLERS). */
export const GOD_HANDLERS = Object.freeze({
  'career.set'(s, ev, p, world) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const due = time(p.effectiveAt);
    if (due && due > ev.at) {
      pendingOf(st)[ev.id] = { type: 'career.set', due: { at: due }, payload: structuredClone(p), eventId: ev.id, at: ev.at };
      prunePending(st);
      return;
    }
    applyCareerSet(s, st, p, ev.id, ev.at, world);
  },

  'self.moved'(s, ev, p) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const due = time(p.effectiveAt);
    if (due && due > ev.at) {
      pendingOf(st)[ev.id] = { type: 'self.moved', due: { at: due }, payload: structuredClone(p), eventId: ev.id, at: ev.at };
      prunePending(st);
      return;
    }
    applyMove(s, p, ev.id);
  },

  'change.applied'(s, ev, p, world) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const target = posInt(p.targetId);
    const entry = target && isObj(st.pending) ? st.pending[target] : null;
    if (!isObj(entry) || !PENDING_TYPES.has(entry.type)) return;
    delete st.pending[target];
    applyPending(s, st, entry, ev.id, ev.at, world);
  },

  'vitals.planned'(s, ev, p) {
    if (skip(ev, p)) return;
    const delta = deltaOf(p.delta);
    const at = time(p.at);
    const wakeDate = typeof p.wakeDate === 'string' && DATE_RE.test(p.wakeDate) ? p.wakeDate : null;
    if (!delta || (!at && !wakeDate)) return;
    const st = storyOf(s);
    pendingOf(st)[ev.id] = { type: 'vitals.planned', due: at ? { at } : { wakeDate }, payload: { delta, label: str(p.label, 80) }, eventId: ev.id, at: ev.at };
    prunePending(st);
  },

  'sick.planned'(s, ev, p) {
    if (skip(ev, p)) return;
    const startAt = time(p.startAt);
    const days = posInt(p.days);
    if (!startAt || !days) return;
    const st = storyOf(s);
    pendingOf(st)[ev.id] = { type: 'sick.planned', due: { at: startAt }, payload: { days: Math.min(days, 14) }, eventId: ev.id, at: ev.at };
    prunePending(st);
  },

  'outcome.set'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = posInt(p.decisionId);
    const outcome = OUTCOMES.includes(p.outcome) ? p.outcome : null;
    if (!id || !outcome) return;
    const st = storyOf(s);
    if (!isObj(st.outcomes)) st.outcomes = {};
    st.outcomes[id] = { eventId: ev.id, outcome, cancelAt: time(p.cancelAt), status: 'set', at: ev.at };
    pruneOutcomes(st, ev.at);
  },

  'outcome.happened'(s, ev, p) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const o = isObj(st.outcomes) ? st.outcomes[posInt(p.decisionId)] : null;
    if (isObj(o)) Object.assign(o, { status: 'done', closedAt: ev.at });
  },

  'cast.departed'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = castId(p.castId);
    if (!castExists(s, id)) return;
    const st = storyOf(s);
    if (!isObj(st.departed)) st.departed = {};
    const rec = structuredClone(s.cast.get(id));
    st.departed[id] = { ...rec, how: DEPART_HOW.includes(p.how) ? p.how : 'written_out', departedAt: ev.at, departedEventId: ev.id };
    s.cast.delete(id);
    st.departedRev = (Number.isSafeInteger(st.departedRev) ? st.departedRev : 0) + 1;
    if (isObj(st.together[id])) st.together[id] = { ...st.together[id], openSince: null };
  },

  'cast.returned'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = castId(p.castId);
    const st = storyOf(s);
    const rec = isObj(st.departed) ? st.departed[id] : null;
    if (!isObj(rec) || castExists(s, id) || !(s.cast instanceof Map)) return;
    const { how, departedAt, departedEventId, ...back } = rec;
    s.cast.set(id, back);
    delete st.departed[id];
    st.departedRev = (Number.isSafeInteger(st.departedRev) ? st.departedRev : 0) + 1;
  },
});

/**
 * 015: the overlay key (plan §P1.2) — `${career.eventId}|${self.homeEventId}|${story.departedRev}`,
 * null when all three are absent (a log with no career/home/departure event): every
 * overlay site returns the base world then, and every overlay memo keys on it.
 */
export function overlayKey(state) {
  const c = state?.story?.career?.eventId ?? null;
  const h = state?.self?.homeEventId ?? null;
  const d = state?.story?.departedRev ?? null;
  if (c === null && h === null && d === null) return null;
  return `${c ?? ''}|${h ?? ''}|${d ?? ''}`;
}

/**
 * 015: the key a plan in force was made under, for the overlay drift item —
 * the owner's career and home changes only (engine career events and
 * departures never re-plan today, as before 015). null while neither exists.
 */
export function driftKey(state) {
  const c = state?.story?.career?.godEventId ?? null;
  const h = state?.self?.homeEventId ?? null;
  if (c === null && h === null) return null;
  return `${c ?? ''}|${h ?? ''}`;
}

/** A memo key over everything worldOverlay reads (overlayKey + the career fields it copies). */
export function overlayMemoKey(state) {
  const k = overlayKey(state);
  if (k === null) return null;
  const c = state?.story?.career ?? {};
  const pat = isObj(c.pattern) ? `${(c.pattern.officeDays || []).join(',')}/${(c.pattern.wfhDays || []).join(',')}` : '';
  return `${k}|${c.title}|${c.employerName}|${c.officePlaceId}|${c.salary}|${c.employed}|${pat}|${state?.self?.homePlaceId ?? ''}`;
}

/** A cast member's name, active or departed (015: past rows keep resolving). */
export function castNameOf(state, id) {
  const live = state?.cast instanceof Map ? state.cast.get(id) : null;
  if (live?.name) return live.name;
  const gone = state?.story?.departed?.[id];
  return isObj(gone) && typeof gone.name === 'string' ? gone.name : null;
}

/** 015: is he out of work (an owner fire/quit with no rehire since)? */
export function isUnemployed(state) {
  return state?.story?.career?.employed === false;
}

// ── Handlers: 010 types ───────────────────────────────────────────────────

export const STORY_HANDLERS = Object.freeze({
  // Cast and relationships (data-model §2.2)
  'cast.updated'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = castId(p.castId);
    if (!castExists(s, id) || !isObj(p.fields)) return;
    const st = storyOf(s);
    const upd = {};
    for (const [k, cap] of Object.entries(CAST_FIELD_CAPS)) {
      const v = str(p.fields[k], cap);
      if (v) upd[k] = v;
    }
    if (typeof p.fields.birthday === 'string' && DATE_RE.test(p.fields.birthday)) upd.birthday = p.fields.birthday;
    if (!Object.keys(upd).length) return;
    s.cast.set(id, { ...s.cast.get(id), ...upd });
    if (upd.status) Object.assign(lifeOf(st, id), { status: upd.status, statusAt: ev.at });
  },

  'cast.beat'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = castId(p.castId);
    const kind = BEAT_KINDS.has(p.kind) ? p.kind : null;
    if (!castExists(s, id) || !kind) return;
    const st = storyOf(s);
    const life = lifeOf(st, id);
    life.lastBeat = { kind, at: ev.at, eventId: ev.id };
    if (kind === 'status') {
      const text = str(p.text, 120);
      if (text) Object.assign(life, { status: text, statusAt: ev.at });
    } else if (kind === 'away') {
      const until = time(p.until);
      life.away = {
        until: until && until > ev.at ? Math.min(until, ev.at + MAX_AWAY_DAYS * DAY) : null, eventId: ev.id,
        ...(heavyCaused(st, ev) ? { heavy: true } : {}),
      };
    } else if (kind === 'back') {
      life.away = null;
    }
    bumpArcBeat(st, id, ev.id);
  },

  'cast.history_added'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = castId(p.castId);
    const text = str(p.text, 160);
    if (!castExists(s, id) || !text) return;
    const st = storyOf(s);
    const at = Math.min(time(p.dated) ?? ev.at, ev.at);
    const list = Array.isArray(st.history[id]) ? st.history[id] : [];
    list.push({ at, text, eventId: ev.id });
    list.sort((a, b) => a.at - b.at || a.eventId - b.eventId);
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    st.history[id] = list;
  },

  'relationship.changed'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = castId(p.castId);
    if (!castExists(s, id) || !isObj(p.delta)) return;
    const st = storyOf(s);
    const d = (k) => (finite(p.delta[k]) ? clamp(p.delta[k], -MAX_DELTA, MAX_DELTA) : 0);
    const c = s.cast.get(id);
    const m = isObj(c.metrics) ? c.metrics : { closeness: 0.5, trust: 0.5, tension: 0 };
    const metrics = { ...m };
    for (const k of METRIC_KEYS) if (d(k)) metrics[k] = clamp01((finite(m[k]) ? m[k] : 0) + d(k));
    s.cast.set(id, { ...c, metrics });
    const r = relOf(st, id);
    for (const k of REL_KEYS) if (d(k)) r[k] = clamp01((finite(r[k]) ? r[k] : 0) + d(k));
    if (finite(p.delta.togetherMin)) {
      r.togetherMin = Math.round((finite(r.togetherMin) ? r.togetherMin : 0) + clamp(p.delta.togetherMin, 0, MAX_TOGETHER_DELTA_MIN));
    }
    if (CONTACT_REASONS.has(p.reason)) touchContact(st, [id], ev.at);
  },

  'place.updated'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = placeId(p.placeId);
    if (!id || !(s.places instanceof Map) || !s.places.has(id)) return;
    const name = str(p.name, 60);
    const kind = kindOf(p.kind);
    // 014 geo (plan §1.2): lat/lon together (a move) and venue data (or venue:null)
    // from an owner switch; `prev` is display only and never read here.
    const geo = placeGeoFields(p);
    if (!name && !kind && !geo) return;
    const next = { ...s.places.get(id), ...(name ? { name } : {}), ...(kind ? { kind } : {}) };
    if (geo) {
      if (geo.lat !== undefined) { next.lat = geo.lat; next.lon = geo.lon; }
      if (geo.venue === null) delete next.venue;
      else if (geo.venue) next.venue = geo.venue;
    }
    // R16: an owner rename may be a real business → venue-like (worded by its kind
    // next to a negative event). The key appears only when such an event folds.
    if (name && ev?.actor === 'owner' && !geo?.venue) next.ownerNamed = true;
    else if (geo?.venue) delete next.ownerNamed;
    s.places.set(id, next);
    if (geo) {
      if (geo.lat !== undefined && s.position?.placeId === id && !s.position.travel) s.position = { ...s.position, lat: geo.lat, lon: geo.lon };
      s.placesSig = placesSigOf(s);
    }
  },

  // Arcs (data-model §2.3)
  'arc.started'(s, ev, p) {
    if (skip(ev, p)) return;
    const category = CATEGORIES.includes(p.category) ? p.category : null;
    const kind = kindOf(p.kind);
    if (!category || !kind) return;
    const st = storyOf(s);
    const stage = category === 'romance'
      ? (ROMANCE_STAGES.includes(p.stage) && p.stage !== 'single' ? p.stage : 'interested')
      : (str(p.stage, 32) ?? 'started');
    const arc = {
      id: ev.id, category, kind, stage, stageAt: ev.at,
      castIds: castIdList(p.castIds, MAX_ARC_CAST),
      startedAt: ev.at, status: 'active', outcome: null, decisionIds: [],
      lastBeatEventId: ev.id, state: cleanArcState(p.state),
    };
    st.arcs[ev.id] = arc;
    if (category === 'romance') {
      st.romance = { ...st.romance, arcId: ev.id, partnerId: arc.castIds[0] ?? null, stage, stageAt: ev.at };
      setRelationship(s, stage);
    }
    pruneArcs(st);
  },

  'arc.stage'(s, ev, p) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const arc = st.arcs[posInt(p.arcId)];
    if (!isObj(arc) || arc.status !== 'active') return;
    const to = arc.category === 'romance'
      ? (ROMANCE_STAGES.includes(p.to) && p.to !== 'single' ? p.to : null)
      : str(p.to, 32);
    if (!to) return;
    Object.assign(arc, { stage: to, stageAt: ev.at, lastBeatEventId: ev.id });
    if (arc.category === 'romance' && st.romance.arcId === arc.id) {
      st.romance = { ...st.romance, stage: to, stageAt: ev.at };
      setRelationship(s, to);
    }
  },

  'arc.ended'(s, ev, p) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const arc = st.arcs[posInt(p.arcId)];
    if (!isObj(arc) || arc.status !== 'active') return;
    const outcome = ARC_END_OUTCOMES.has(p.outcome) ? p.outcome : 'done';
    Object.assign(arc, { status: 'ended', outcome, endedAt: ev.at, lastBeatEventId: ev.id });
    if (arc.category === 'romance' && st.romance.arcId === arc.id) {
      const days = outcome === 'broken_up' ? ROMANCE_BREAKUP_COOLDOWN_DAYS : ROMANCE_END_COOLDOWN_DAYS;
      st.romance = { arcId: null, partnerId: null, stage: 'single', stageAt: ev.at, cooldownUntil: ev.at + days * DAY };
      setRelationship(s, 'single');
    }
    if (st.career.huntArcId === arc.id) Object.assign(st.career, { huntArcId: null, huntPhase: 'ended' });
    pruneArcs(st);
  },

  'career.appraisal'(s, ev, p, world) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const c = ensureCareer(s, st, world);
    const year = int(p.year);
    const band = BANDS.has(p.band) ? p.band : null;
    if (!year || !band) return;
    const pct = finite(p.pct) ? round2(clamp(p.pct, -5, 20)) : 0;
    if (finite(p.salaryTo) && p.salaryTo >= 0) c.salary = p.salaryTo;
    c.lastAppraisalYear = Math.max(c.lastAppraisalYear ?? year, year);
    c.lastAppraisal = { band, pct, year, at: ev.at, eventId: ev.id };
    c.eventId = ev.id;
  },

  'career.hunt'(s, ev, p, world) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const c = ensureCareer(s, st, world);
    const arcId = posInt(p.arcId);
    const phase = HUNT_PHASES.has(p.phase) ? p.phase : null;
    if (!phase) return;
    if (phase === 'started' && arcId) Object.assign(c, { huntArcId: arcId, huntPhase: 'started' });
    else if (phase === 'paused' && c.huntArcId !== null) c.huntPhase = 'paused';
    else if (phase === 'ended' && (arcId === null || arcId === c.huntArcId)) Object.assign(c, { huntArcId: null, huntPhase: 'ended' });
    else return;
    c.eventId = ev.id;
    if (arcId && isObj(st.arcs[arcId])) st.arcs[arcId].lastBeatEventId = ev.id;
  },

  'career.resigned'(s, ev, p, world) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const c = ensureCareer(s, st, world);
    const until = time(p.noticeUntil);
    if (!until) return;
    c.notice = {
      until,
      toEmployer: str(p.toEmployer, 80),
      toTitle: str(p.toTitle, 60),
      toOfficePlaceId: placeId(p.toOfficePlaceId),
      decisionId: posInt(p.decisionId),
      eventId: ev.id,
    };
    c.eventId = ev.id;
  },

  'career.job_changed'(s, ev, p, world) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const c = ensureCareer(s, st, world);
    const title = str(p.title, 60);
    const employerName = str(p.employerName, 80);
    const office = placeId(p.officePlaceId);
    if (!title && !employerName && !office) return;
    if (title) c.title = title;
    if (employerName) c.employerName = employerName;
    if (office) {
      c.officePlaceId = office;
      if (isObj(s.self)) s.self = { ...s.self, officePlaceId: office };
    }
    Object.assign(c, { startedAt: ev.at, notice: null, eventId: ev.id });
    if (c.employed === false) c.employed = true;   // 015: an engine rehire after an owner fire
  },

  'family.call'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = castId(p.castId);
    if (!castExists(s, id)) return;
    const st = storyOf(s);
    st.family.lastCallAt = ev.at;
    const next = time(p.nextCallAt);
    if (next && next > ev.at) st.family.nextCallAt = next;
    touchContact(st, [id], ev.at);
  },

  'family.occasion'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = slug(p.occasionId);
    if (!id) return;
    const st = storyOf(s);
    st.family.occasionsDone[id] = Number(dateKey(ev.at, tzOf(s)).slice(0, 4));
    const keys = Object.keys(st.family.occasionsDone);
    if (keys.length > MAX_OCCASIONS) delete st.family.occasionsDone[keys[0]];
    if (p.major === true) st.family.lastMajorAt = ev.at;
  },

  'story.daily_done'(s, ev, p) {
    // Never skipped for a redaction: it carries only counts, and it is what keeps
    // the daily item from coming due twice (research R7).
    const st = storyOf(s);
    const date = typeof p?.date === 'string' && DATE_RE.test(p.date) ? p.date : dateKey(ev.at, tzOf(s));
    if (st.daily.lastDate === null || date >= st.daily.lastDate) st.daily = { lastDate: date, lastAt: ev.at };
    // The pass consumed the shared time since the last one.
    for (const t of Object.values(st.together)) {
      if (!isObj(t)) continue;
      t.minutesSinceDaily = 0;
      if (t.openSince !== null && t.openSince < ev.at) t.openSince = ev.at;
    }
  },

  'heavy.proposed'(s, ev, p) {
    // A proposal without a kind or an onset could never start or lapse: ignored.
    if (skip(ev, p) || !kindOf(p.kind) || !time(p.onsetAt)) return;
    const st = storyOf(s);
    st.heavy.proposals[ev.id] = {
      themeId: slug(p.themeId), kind: kindOf(p.kind), onsetAt: time(p.onsetAt), status: 'pending', at: ev.at,
    };
    st.heavy.lastProposedAt = ev.at;
    pruneMap(st.heavy.proposals, MAX_PROPOSALS, x => x.status === 'pending');
  },

  'heavy.vetoed'(s, ev, p) {
    if (skip(ev, p)) return;
    const prop = storyOf(s).heavy.proposals[posInt(p.proposedId)];
    if (isObj(prop) && prop.status === 'pending') prop.status = 'vetoed';
  },

  'heavy.lapsed'(s, ev, p) {
    if (skip(ev, p)) return;
    const prop = storyOf(s).heavy.proposals[posInt(p.proposedId)];
    if (isObj(prop) && prop.status === 'pending') Object.assign(prop, { status: 'lapsed', reason: kindOf(p.reason) });
  },

  'heavy.started'(s, ev, p) {
    if (skip(ev, p) || !kindOf(p.kind)) return;
    const st = storyOf(s);
    const proposedId = posInt(p.proposedId);
    const until = clamp(time(p.until) ?? ev.at + 7 * DAY, ev.at + 3600, ev.at + HEAVY_MAX_DAYS * DAY);
    st.heavy.active = {
      id: ev.id, proposedId, themeId: slug(p.themeId), kind: kindOf(p.kind), until,
      castId: castId(p.castId), startedAt: ev.at,
    };
    st.heavy.lastOnsetAt = ev.at;
    const prop = proposedId ? st.heavy.proposals[proposedId] : null;
    if (isObj(prop)) prop.status = 'started';
  },

  'heavy.ended'(s, ev, p) {
    if (skip(ev, p)) return;
    const h = storyOf(s).heavy;
    if (isObj(h.active) && posInt(p.heavyId) === h.active.id) h.active = null;
  },

  // Chats ↔ world (data-model §2.4)
  'claim.adopted'(s, ev, p) {
    if (skip(ev, p)) return;
    const claimId = posInt(p.claimId);
    if (!claimId) return;
    const st = storyOf(s);
    const as = ['decision', 'commitment', 'activity'].includes(p.as) ? p.as : null;
    st.adopted[claimId] = {
      eventId: ev.id, reviewId: posInt(p.reviewId), as,
      decisionId: as === 'decision' ? posInt(p.ref) : null, status: 'adopted', at: ev.at,
    };
    pruneMap(st.adopted, MAX_ADOPTED, x => x.status === 'adopted');
  },

  'activity.recorded'(s, ev, p) {
    // History only (no vitals, never story.history: FR-030). Numeric contact only,
    // and none from a chat-origin record (it would reach self-origin drift).
    if (skip(ev, p) || isChatEvent(ev)) return;
    const st = storyOf(s);
    touchContact(st, castIdList(p.castIds, 16).filter(id => castExists(s, id)), ev.at);
  },

  'commitment.recorded'(s, ev, p) {
    if (skip(ev, p)) return;
    const dueAt = time(p.dueAt);
    if (!dueAt) return;
    const st = storyOf(s);
    st.commitments = st.commitments.filter(c => c.dueAt >= ev.at - DAY);
    st.commitments.push({ eventId: ev.id, dueAt, placeId: placeId(p.placeId), castIds: castIdList(p.castIds, 16) });
    st.commitments.sort((a, b) => a.dueAt - b.dueAt || a.eventId - b.eventId);
    if (st.commitments.length > MAX_COMMITMENTS) st.commitments.splice(0, st.commitments.length - MAX_COMMITMENTS);
  },

  'claim.withdrawn'(s, ev, p) {
    if (skip(ev, p)) return;
    const entry = storyOf(s).adopted[posInt(p.claimId)];
    if (isObj(entry)) entry.status = 'withdrawn';
  },

  // Director (data-model §2.6) — folded from owner events only.
  'director.action'() {},

  'director.fate_set'(s, ev, p) {
    if (skip(ev, p) || !CATEGORIES.includes(p.category) || !FATE_MODES.includes(p.mode)) return;
    storyOf(s).controls.fate[p.category] = p.mode;
  },

  'director.slider_set'(s, ev, p) {
    if (skip(ev, p) || !SLIDERS.includes(p.slider) || !finite(p.value)) return;
    storyOf(s).controls.sliders[p.slider] = round2(clamp01(p.value));
  },

  'director.pin_set'(s, ev, p) {
    if (skip(ev, p) || !isPinKey(p.pinKey)) return;
    const pins = storyOf(s).controls.pins;
    if (!own(pins, p.pinKey) && Object.keys(pins).length >= MAX_PINS) return;
    pins[p.pinKey] = { eventId: ev.id, at: ev.at };
  },

  'director.pin_cleared'(s, ev, p) {
    if (skip(ev, p) || !isPinKey(p.pinKey)) return;
    delete storyOf(s).controls.pins[p.pinKey];
  },

  'director.paused'(s, ev, p) {
    if (skip(ev, p)) return;
    const c = storyOf(s).controls;
    if (!c.paused) Object.assign(c, { paused: true, pausedAt: ev.at });
  },

  'director.resumed'(s, ev, p) {
    if (skip(ev, p)) return;
    Object.assign(storyOf(s).controls, { paused: false, pausedAt: null });
  },

  'director.bookmark'(s, ev, p) {
    if (skip(ev, p)) return;
    const name = str(p.name, 60);
    const eventId = posInt(p.eventId);
    const st = storyOf(s);
    if (!name || !eventId || eventId > ev.id || st.bookmarks.length >= MAX_BOOKMARKS) return;
    st.bookmarks.push({ id: ev.id, name, eventId, at: ev.at });
  },

  'director.bookmark_removed'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = posInt(p.bookmarkId);
    const st = storyOf(s);
    if (id) st.bookmarks = st.bookmarks.filter(b => b.id !== id);
  },

  'director.seed_set'(s, ev, p) {
    if (skip(ev, p)) return;
    const v = cleanSeedValue(p.path, p.value);
    if (v === undefined) return;
    const o = storyOf(s).seedOverlay;
    if (v === null) delete o[p.path];
    else o[p.path] = v;
  },

  'director.reconciler_mode'(s, ev, p) {
    if (skip(ev, p) || !RECONCILER_MODES.includes(p.mode)) return;
    storyOf(s).controls.reconcilerMode = p.mode;
  },

  // Bounded vitals deltas are applied by vitals.applyEvent (lane inner); the
  // story slice has nothing to record — except (015) a planned nudge, which
  // consumes its owner's pending entry.
  'vitals.nudged'(s, ev, p) {
    if (p?.reason === 'planned') consumePending(s, ev);
  },
});

// ── Observers: 009 types (called by the projector AFTER the 009 handler) ──

function observeTogether(s, ev) {
  syncTogether(s, storyOf(s), ev.at, ev);
}

export const STORY_OBSERVERS = Object.freeze({
  ...Object.fromEntries(TOGETHER_TYPES.map(t => [t, observeTogether])),

  genesis(s, ev, p) {
    // The career base from the genesis copy of self.job (history-stable).
    const st = storyOf(s);
    const job = isObj(p?.self?.job) ? p.self.job : {};
    const c = st.career;
    if (c.title === null) c.title = str(job.title, 60);
    if (c.employerName === null) c.employerName = str(job.employerName, 80);
    if (c.officePlaceId === null) c.officePlaceId = placeId(s.self?.officePlaceId) ?? placeId(job.officePlaceId);
    if (c.startedAt === null) c.startedAt = ev.at;
    syncTogether(s, st, ev.at, ev);
  },

  'cast.created'(s, ev) {
    // Genesis cast (engine, stamped at genesis) doesn't count toward the new-cast pace.
    if (ev.actor === 'engine' && (s.genesisAt === null || ev.at === s.genesisAt)) return;
    const st = storyOf(s);
    st.newCast.ats.push(ev.at);
    st.newCast.ats.sort((a, b) => a - b);
    if (st.newCast.ats.length > MAX_NEW_CAST_ATS) st.newCast.ats.splice(0, st.newCast.ats.length - MAX_NEW_CAST_ATS);
  },

  'decision.opened'(s, ev, p) {
    if (skip(ev, p)) return;
    const st = storyOf(s);
    const arc = st.arcs[posInt(p.arcId)];
    if (isObj(arc) && !arc.decisionIds.includes(ev.id)) {
      arc.decisionIds.push(ev.id);
      if (arc.decisionIds.length > MAX_ARC_DECISIONS) arc.decisionIds.splice(0, arc.decisionIds.length - MAX_ARC_DECISIONS);
    }
    const adoption = p.adopted === true ? st.adopted[posInt(p.claimId)] : null;
    if (isObj(adoption) && adoption.decisionId === null) adoption.decisionId = ev.id;
  },

  'work.late'(s, ev) { workDay(s, storyOf(s), ev.at).late += 1; },
  'work.crunch'(s, ev) { workDay(s, storyOf(s), ev.at).crunch += 1; },

  'sick.started'(s, ev, p) {
    const days = posInt(p?.days);
    const st = storyOf(s);
    workDay(s, st, ev.at).sick += days ? Math.min(days, 14) : 1;
    if (heavyCaused(st, ev)) st.heavy.sickEventId = ev.id;   // 009's s.sick.eventId names it while it lasts
    if (p?.reason === 'planned') consumePending(s, ev);       // 015: a due sick.planned
  },

  'vitals.checkpoint'(s, ev) {
    const stress = s.vitals?.stress;
    if (!finite(stress)) return;
    const d = workDay(s, storyOf(s), ev.at);
    d.stress = round2(((d.stress ?? 0) * d.n + stress) / (d.n + 1));
    d.n += 1;
  },
});

// ── Readers (state-derived, not skill-gated: research R5) ─────────────────

/**
 * The world every reader should use (research R9): `world` itself until a
 * career.* event has been folded; then a copy whose self.job (title, employer,
 * office) and money.salary come from the story. Never mutates `world`; the
 * routine (hybrid days) is not overlaid.
 */
export function worldOverlay(state, worldIn) {
  // 014 geo (plan §A0, R19): projected places (moved, added, real venues) and
  // stored routes first, so every caller sees them; the world itself by
  // identity while nothing moved.
  const world = worldWithPlaces(state, worldIn);
  const c = state?.story?.career;
  if (!isObj(world) || overlayKey(state) === null) return world;   // 015: career, home or departure
  if (!isObj(c) || c.eventId === null || c.eventId === undefined) return godOverlay(state, world);
  const self = isObj(world.self) ? world.self : {};
  const job = isObj(self.job) ? self.job : {};
  const nextJob = {
    ...job,
    ...(c.title ? { title: c.title } : {}),
    ...(c.employerName ? { employerName: c.employerName } : {}),
    ...(c.officePlaceId ? { officePlaceId: c.officePlaceId } : {}),
  };
  const out = { ...world, self: { ...self, job: nextJob } };
  if (c.officePlaceId && own(self, 'officePlaceId')) out.self.officePlaceId = c.officePlaceId;
  if (finite(c.salary)) out.money = { ...(isObj(world.money) ? world.money : {}), salary: c.salary };
  return godOverlay(state, out);
}

// 015 (plan §P1.2/§P1.4/§P1.6): unemployment, the office pattern, his home and
// departed cast, over the career overlay. A no-op for a pre-015 state (none of
// the fields exist), so the overlay of an older log is unchanged.
function godOverlay(state, world) {
  const c = state?.story?.career ?? {};
  const st = state?.story ?? {};
  const moved = state?.self?.homeEventId !== null && state?.self?.homeEventId !== undefined && placeId(state?.self?.homePlaceId);
  const departed = isObj(st.departed) ? Object.keys(st.departed) : [];
  // (An owner-created office or home is already in `world`: worldOverlay merged the
  // projected places first, 014 A0.)
  if (c.employed !== false && !isObj(c.pattern) && !moved && !departed.length) return world;
  const out = { ...world, self: { ...(isObj(world.self) ? world.self : {}) } };
  if (c.employed === false) {
    out.self.job = null;
    out.self.employed = false;
    if (own(out.self, 'officePlaceId')) out.self.officePlaceId = null;
    out.money = { ...(isObj(world.money) ? world.money : {}), salary: 0 };
  }
  if (isObj(c.pattern)) out.routine = { ...(isObj(world.routine) ? world.routine : {}), officeDays: [...c.pattern.officeDays], wfhDays: [...c.pattern.wfhDays] };
  if (moved) {
    out.self.homePlaceId = state.self.homePlaceId;
    // Routine items at a former home (the base world's, or any he has left) happen at
    // the new one: he doesn't travel back to his old flat to watch TV.
    const former = new Set([world.self?.homePlaceId, ...(Array.isArray(state.self.homeHistory) ? state.self.homeHistory : [])]
      .filter(id => typeof id === 'string' && id !== state.self.homePlaceId));
    const r = isObj(out.routine) ? out.routine : (isObj(world.routine) ? world.routine : null);
    if (former.size && r && Array.isArray(r.leisure) && r.leisure.some(l => former.has(l?.placeId))) {
      out.routine = { ...r, leisure: r.leisure.map(l => (former.has(l?.placeId) ? { ...l, placeId: state.self.homePlaceId } : l)) };
    }
  }
  if (departed.length) {
    const gone = new Set(departed);
    const list = world.cast instanceof Map ? [...world.cast.values()] : (Array.isArray(world.cast) ? world.cast : []);
    out.cast = list.filter(m => !gone.has(m?.id));
  }
  return out;
}

/** True while a heavy arc is active (research R17): the guard lasts the whole arc, not only the 12 h embargo. */
export function heavyGuardActive(state, now) {
  const a = state?.story?.heavy?.active;
  return isObj(a) && finite(now) && finite(a.until) && now < a.until;
}

// ── Equivalence (tests, rewind preview) ───────────────────────────────────

const EPS = 1e-9;

function normalizeForEquivalence(state) {
  const st = isObj(state?.story) ? state.story : initialStory();
  const { bookmarks, controls, ...story } = st;
  const { age, ...self } = isObj(state?.self) ? state.self : {};
  const entries = (m) => (m instanceof Map ? [...m.entries()] : isObj(m) ? Object.entries(m) : [])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  const open = entries(state?.decisions).filter(([, d]) => d?.status === 'open');
  return {
    story, self, cast: entries(state?.cast), places: entries(state?.places), vitals: state?.vitals ?? null,
    decisions: open, embargo: state?.embargo ?? null, money: state?.money ?? null,
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= EPS || (Number.isNaN(a) && Number.isNaN(b));
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a).filter(k => a[k] !== undefined);
  const kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => own(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Do two projections describe the same life (data-model §3)? Deep-equal of the
 * story (bookmarks and controls aside), self (age aside), cast, places, vitals,
 * open decisions, embargo and money. A state with no story slice compares as an
 * empty one.
 */
export function storyEquivalent(a, b) {
  return deepEqual(normalizeForEquivalence(a), normalizeForEquivalence(b));
}

// ── 016 scene play-outs (plan §1.4) ───────────────────────────────────────
// Every slice (story.scenes, story.sceneTones, story.followups) is created lazily
// by its handler and is never in initialStory(), so a pre-016 log folds exactly as
// before (the 015 rule). Excluded events never fold, so each slice holds the newest
// non-excluded version.

export const SCENE_ENDINGS = Object.freeze(['nothing', 'swapped_numbers', 'plan_to_meet', 'stayed_late', 'left_early', 'parted_badly']);
export const SCENE_OUTCOMES = Object.freeze(['well', 'fine', 'flat', 'badly']);
export const SCENE_MODES = Object.freeze(['full', 'narration_only', 'self_only']);
const MAX_SCENES = 200;
const MAX_SCENE_TONES = 64;
const MAX_FOLLOWUPS = 32;
const FOLLOWUP_REOPEN = new Set(['could_not_go', 'fell_through', 'rewound', 'frozen', 'pinned', 'sick', 'heavy', 'paused', 'schedule', 'owner_plan']);

function noteRelease(s, ev, p) {
  if (skip(ev, p) || p?.heat !== 'explicit') return;
  const at = time(ev?.at);
  if (!at) return;
  const st = storyOf(s);
  if (!isObj(st.desire)) st.desire = {};
  if (!finite(st.desire.lastReleaseAt) || at >= st.desire.lastReleaseAt) st.desire.lastReleaseAt = at;
}

function prunePlain(map, max, keep = () => false) {
  const ids = Object.keys(map);
  if (ids.length <= max) return;
  const drop = ids.filter(id => !keep(map[id])).sort((a, b) => Number(a) - Number(b));
  for (const id of drop.slice(0, ids.length - max)) delete map[id];
}

/** 016 handlers (the projector merges them under its own table, like GOD_HANDLERS). */
export const SCENE_HANDLERS = Object.freeze({
  // 020 G: this morning's dream, for its small mood nudge and for what he might say. Codes only.
  'dream.had'(s, ev, p) {
    if (skip(ev, p)) return;
    const num = (v, cap) => (finite(v) ? Math.max(-cap, Math.min(cap, v)) : 0);
    storyOf(s).dream = {
      at: ev.at, eventId: ev.id, tone: typeof p.tone === 'string' ? p.tone : 'flat', recall: p.recall === 'vivid' ? 'vivid' : 'fragment',
      castIds: Array.isArray(p.castIds) ? p.castIds.filter(x => typeof x === 'string').slice(0, 4) : [],
      until: finite(p.until) ? p.until : ev.at, dv: num(p.dv, 0.06), ds: num(p.ds, 4),
    };
  },

  'scene.played'(s, ev, p) {
    if (skip(ev, p)) return;
    const aid = posInt(p.activityEventId);
    if (!aid) return;
    const st = storyOf(s);
    if (!isObj(st.scenes)) st.scenes = {};
    st.scenes[aid] = {
      eventId: ev.id,
      version: posInt(p.version) ?? 1,
      sceneId: posInt(p.sceneId),
      ending: SCENE_ENDINGS.includes(p.ending) ? p.ending : 'nothing',
      outcome: SCENE_OUTCOMES.includes(p.outcome) ? p.outcome : 'fine',
      chemistry: finite(p.chemistry) ? clamp01(p.chemistry) : null,
      castIds: castIdList(p.castIds, 4),
      firstMeet: castIdList(p.firstMeet, 4),
      mode: SCENE_MODES.includes(p.mode) ? p.mode : 'full',
      decisionId: posInt(p.decisionId),
      placeId: placeId(p.placeId),
      startAt: time(p.startAt),
      endedAt: time(p.endedAt),
      kind: kindOf(p.kind),
      tier: ['clerk', 'mind', 'code'].includes(p.tier) ? p.tier : null,
      fallback: p.fallback === true,
      // Only when set, so a scene without one folds as before (the inert golden checks).
      ...(p.heavyWindow === true ? { heavyWindow: true } : {}),
      ...((p.heat === 'tame' || p.heat === 'suggestive' || p.heat === 'explicit') ? { heat: p.heat } : {}),
      at: ev.at,
    };
    prunePlain(st.scenes, MAX_SCENES);
    noteRelease(s, ev, p);
  },

  // A graphic text or scene settles urge. No heat key → the handler adds nothing,
  // so a log from before this change folds exactly as it did.
  'phone.message'(s, ev, p) {
    noteRelease(s, ev, p);
  },

  'scene.tone_set'(s, ev, p) {
    if (skip(ev, p)) return;
    const id = posInt(p.decisionId);
    const tone = str(p.tone, 120);
    if (!id || !tone) return;
    const st = storyOf(s);
    if (!isObj(st.sceneTones)) st.sceneTones = {};
    // R23: the hint's outcome word sets the scene's outcome (outcomeBy owner).
    st.sceneTones[id] = { tone, outcome: SCENE_OUTCOMES.includes(p.outcome) ? p.outcome : null, eventId: ev.id };
    prunePlain(st.sceneTones, MAX_SCENE_TONES);
  },

  'scene.followup'(s, ev, p) {
    if (skip(ev, p)) return;
    const cid = castId(p.castId);
    const from = time(p.from);
    const to = time(p.to);
    if (!cid || !from || !to || to <= from) return;
    const st = storyOf(s);
    if (!isObj(st.followups)) st.followups = {};
    st.followups[ev.id] = {
      id: ev.id, castId: cid, from, to, placeId: placeId(p.placeId),
      bias: finite(p.bias) ? clamp(p.bias, 0, 2) : 0, status: 'open', decisionId: null,
      // A companion (D15): the scene is named in the payload, never the cause.
      sceneEventId: posInt(p.sceneEventId) ?? posInt(ev.causeId), at: ev.at, lastTry: null,
    };
    prunePlain(st.followups, MAX_FOLLOWUPS, (f) => f.status === 'open' || f.status === 'fitted');
  },

  'scene.followup_lapsed'(s, ev, p) {
    if (skip(ev, p)) return;
    const f = isObj(s.story?.followups) ? s.story.followups[posInt(p.followupId)] : null;
    if (!isObj(f) || (f.status !== 'open' && f.status !== 'fitted')) return;
    f.status = 'lapsed';
    f.reason = kindOf(p.reason) ?? 'window';
    f.closedAt = ev.at;
  },

  // The log's record of the owner's REGENERATE (never a cause): nothing to fold.
  'scene.regenerated'() {},
});

/** 016 observers (after the 009 handler of their type): a follow-up's decision. */
export const SCENE_OBSERVERS = Object.freeze({
  'decision.opened'(s, ev, p) {
    const f = isObj(s.story?.followups) ? s.story.followups[posInt(p.followupId)] : null;
    if (!isObj(f) || f.status !== 'open' || ev.redacted === true) return;
    f.status = 'fitted';
    f.decisionId = ev.id;
  },
  'decision.expired'(s, ev, p) {
    const fs = s.story?.followups;
    if (!isObj(fs)) return;
    const did = posInt(p.decisionId);
    // A committed one is 'done' already; could_not_go / a block still reopens it.
    const f = Object.values(fs).find(x => isObj(x) && (x.status === 'fitted' || x.status === 'done') && x.decisionId === did);
    if (!f) return;
    if (FOLLOWUP_REOPEN.has(p.reason)) {
      f.status = 'open';
      f.decisionId = null;
      f.lastTry = { at: ev.at, reason: kindOf(p.reason) };
    } else {
      f.status = 'done';
      f.closedAt = ev.at;
    }
  },
  'decision.committed'(s, ev, p) {
    const fs = s.story?.followups;
    if (!isObj(fs)) return;
    const did = posInt(p.decisionId);
    const f = Object.values(fs).find(x => isObj(x) && x.status === 'fitted' && x.decisionId === did);
    if (f) { f.status = 'done'; f.closedAt = ev.at; f.optionId = typeof p.optionId === 'string' ? p.optionId.slice(0, 48) : null; }
  },
});
