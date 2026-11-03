import { getDb } from '../memory/db.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { isGroupJid, isDmJid } from '../utils/jidUtils.js';
import { now } from './clock.js';
import { deleteForPerson as deleteQueueForPerson } from './queue.js';

// The world log (spec 009 plan §R1/§R13/§D): every change to his simulated life
// is one row in world_events — who did it (actor), why (cause_id → another
// event), when in his life (at) and where it came from (origin). State is a
// projection of this log (projector.js); nothing here keeps state in memory.
//
// Append-only is enforced twice: this module only ever INSERTs, and the
// migration's triggers abort any DELETE and any UPDATE that is not the
// redaction shape used by redactPerson() (006 purgePerson). Undo is a new
// `event.reverted` row (revertEvent), never an edit.
//
// Everything written is validated here first; the table's CHECKs are a
// backstop. Payload strings pass through sanitizeWebContent + a length cap, so
// a crafted world file, owner reason or chat-derived pointer can't plant
// [IMAGE:]-style markers or @mention tags that later reach a prompt.

// 010 relationships, arcs & Director (data-model §2). Code-validated only:
// world_events has no type CHECK, so no table rebuild (research R2).
const STORY_TYPE_LIST = [
  'cast.updated', 'cast.beat', 'cast.history_added', 'relationship.changed', 'place.updated',
  'arc.started', 'arc.stage', 'arc.ended',
  'career.appraisal', 'career.hunt', 'career.resigned', 'career.job_changed',
  'family.call', 'family.occasion', 'story.daily_done',
  'heavy.proposed', 'heavy.vetoed', 'heavy.lapsed', 'heavy.started', 'heavy.ended',
  'claim.adopted', 'activity.recorded', 'commitment.recorded', 'claim.withdrawn',
  'director.action', 'director.fate_set', 'director.slider_set', 'director.pin_set', 'director.pin_cleared',
  'director.paused', 'director.resumed', 'director.bookmark', 'director.bookmark_removed',
  'director.seed_set', 'director.reconciler_mode',
  'vitals.nudged', 'world.rewound',
];

// 012 chats shape his life (plan §1.2). Code-validated like 010's. None starts
// with a CHAT_FORBIDDEN_PREFIXES entry or equals a CHAT_FORBIDDEN_EXACT one, so
// CHAT_FORBIDDEN_TYPES below is unchanged (tested). chat.perceived is the one
// inert chat-actor pointer; every consequence is an engine event caused by it.
// chat.load (2026-10-31): counts only — his sent messages and the replies in the
// chats he was talking in over ≥ 30 min — drains the social battery (vitals).
const INFLUENCE_TYPE_LIST = ['chat.perceived', 'mood.chat', 'sleep.delayed', 'work.behind', 'invite.answered', 'invite.followed_up',
  'chat.load'];

// 011 story prompt, Phase 2 (plan §1.2): owner weather windows, soft goals and a
// soaked commute. Code-validated like 010's. None starts with `director.`, so a
// rewind removes them together with their consequences (reducer.isRewindKept).
const STEER_TYPE_LIST = ['weather.window_set', 'weather.window_ended', 'goal.set', 'goal.cancelled',
  'goal.fitted', 'goal.deferred', 'goal.done', 'goal.expired', 'commute.soaked'];

// 014 real places, geo (plan §1.2): a road route fetched by an owner action.
// Owner-only and chat-forbidden; kept by a rewind (reducer REWIND_KEEP).
const GEO_TYPE_LIST = ['route.recorded'];
// 014 sched: the owner's schedule overrides (plan §1.2, §A5). Owner-only and
// chat-forbidden (below). Not `director.*`, so a rewind removes them together
// with their consequences (the re-plan, a schedule expiry).
const SCHEDULE_TYPE_LIST = ['schedule.override_set', 'schedule.override_cleared'];
// 015 Director as god (plan §1.2): the owner's opened powers and their engine
// consequences. Code-validated like 010's. None starts with `director.`, so a
// rewind removes each with its consequences; none is heavy.
const GOD_TYPE_LIST = ['outcome.set', 'outcome.happened', 'career.set', 'self.moved', 'change.applied',
  'money.adjusted', 'vitals.planned', 'sick.planned', 'cast.departed', 'cast.returned'];
// Wake him ("can't sleep"): the owner's request to wake him at a time tonight.
// Owner-only and chat-forbidden (an exact entry: a `sleep.` prefix would also
// forbid sleep.started, which a chat-adopted outing's chain reaches). Its engine
// consequences (the early `woke`, the night's re-plan) are caused by it.
const WAKE_TYPE_LIST = ['wake.set'];
// 018 his wallet: the engine's one-time cut-over from the hourly baseline drain to
// itemized money.spent events (chat-forbidden; never from anyone but the engine in practice).
const WALLET_TYPE_LIST = ['wallet.started'];
// 019 his phone: a text turn with a fictional cast member (engine; codes only — the
// words live in story_messages) and the owner's "he texts …" request (owner-only).
// Exact entries, never a `phone.` prefix: phone.check.* is 009's phone and a
// chat-adopted outing's chain may reach it.
const PHONE_TYPE_LIST = ['phone.message', 'phone.text_set'];
// 020 G: a dream he remembers (engine; codes only, the words live in story_dreams), caused by the night's sleep.started.
const DREAM_TYPE_LIST = ['dream.had'];
// What a text may hang off: the owner's request, the turn it answers, a scene, a
// birthday, news, a trip to a plan with them, a romance moment — or nothing (a
// text out of the blue: self origin).
const PHONE_CAUSE_TYPES = Object.freeze(['phone.text_set', 'phone.message', 'scene.played', 'birthday', 'cast.beat',
  'travel.started', 'arc.started', 'arc.stage', 'decision.reversed', 'decision.expired']);   // 020: telling them he can't make it

// 016 scene play-outs (plan §1.3): how an outing with someone went. Code-validated
// like 010's. None starts with `director.`, so a rewind removes each with its
// consequences. scene.played carries codes only (model text lives in story_scenes).
const SCENE_TYPE_LIST = ['scene.played', 'scene.followup', 'scene.followup_lapsed', 'scene.tone_set', 'scene.regenerated'];

/** Event type catalogue (plan §D + 010 + 012). Anything else is refused. */
export const EVENT_TYPES = new Set([
  'genesis', 'place.created', 'cast.created', 'world.reanchored', 'plan.made',
  'activity.started', 'activity.ended', 'travel.started', 'travel.arrived', 'meal',
  'sleep.started', 'woke', 'work.late', 'work.crunch', 'weather.changed',
  'sick.started', 'sick.ended', 'money.salary', 'money.spent', 'vitals.checkpoint', 'birthday',
  'phone.check.started', 'phone.check.ended', 'availability.changed',
  'decision.opened', 'decision.lean', 'decision.committed', 'decision.reversed',
  'decision.expired', 'decision.mode_set',
  'chat.trigger', 'call.answered', 'claim.flagged',
  'embargo.started', 'embargo.ended', 'alert.raised', 'event.reverted',
  ...STORY_TYPE_LIST,
  ...INFLUENCE_TYPE_LIST,
  ...STEER_TYPE_LIST,
  ...GEO_TYPE_LIST,
  ...SCHEDULE_TYPE_LIST,   // 014 sched
  ...GOD_TYPE_LIST,
  ...SCENE_TYPE_LIST,      // 016
  ...WAKE_TYPE_LIST,
  ...WALLET_TYPE_LIST,     // 018
  ...PHONE_TYPE_LIST,      // 019
  ...DREAM_TYPE_LIST,      // 020 G
]);

/** The 010 additions to the catalogue (the 009 types keep their 009 rules). */
export const STORY_EVENT_TYPES = new Set(STORY_TYPE_LIST);

/** The 012 additions (chat influence). */
export const INFLUENCE_EVENT_TYPES = new Set(INFLUENCE_TYPE_LIST);

/** The 011 additions (owner steering: weather windows, goals, rain gear). */
export const STEER_EVENT_TYPES = new Set(STEER_TYPE_LIST);

/** The 014 geo additions (road routes). */
export const GEO_EVENT_TYPES = new Set(GEO_TYPE_LIST);
export { GEO_TYPE_LIST };
/** The 014 schedule-edit additions (owner overrides). */
export const SCHEDULE_EVENT_TYPES = new Set(SCHEDULE_TYPE_LIST);
/** The 015 additions (Director as god). */
export const GOD_EVENT_TYPES = new Set(GOD_TYPE_LIST);
/** The 016 additions (scene play-outs). */
export const SCENE_EVENT_TYPES = new Set(SCENE_TYPE_LIST);
export const DREAM_EVENT_TYPES = new Set(DREAM_TYPE_LIST);
/** Wake him: the owner's night wake. */
export const WAKE_EVENT_TYPES = new Set(WAKE_TYPE_LIST);
/** 018: the wallet's cut-over. */
export const WALLET_EVENT_TYPES = new Set(WALLET_TYPE_LIST);
/** 019: his phone (texts with the fictional cast). */
export const PHONE_EVENT_TYPES = new Set(PHONE_TYPE_LIST);
export { PHONE_CAUSE_TYPES };

export const ACTORS = new Set(['engine', 'jev', 'mind', 'owner', 'chat']);
export const ORIGIN_KINDS = new Set(['self', 'group', 'dm', 'call', 'ig', 'owner']);

// Chat content never changes his life in 009 (threat model): a chat-actor event
// can only be an inert pointer — a decision trigger, a flagged claim or (012) a
// perceived message; what a perception causes is an engine event under it.
const CHAT_ACTOR_TYPES = new Set(['chat.trigger', 'claim.flagged', 'chat.perceived']);
// Heavy events come from the engine/mind/owner only — never chat or Jev.
const HEAVY_ACTORS = new Set(['engine', 'mind', 'owner']);

// ── 010 rules (data-model §2.1) ───────────────────────────────────────────
// Director controls, rewinds and heavy vetoes are the owner's alone.
export const OWNER_ONLY_TYPES = new Set([
  'director.action', 'director.fate_set', 'director.slider_set', 'director.pin_set', 'director.pin_cleared',
  'director.paused', 'director.resumed', 'director.bookmark', 'director.bookmark_removed',
  'director.seed_set', 'director.reconciler_mode', 'world.rewound', 'heavy.vetoed',
  // 011: the owner's weather windows and goals.
  'weather.window_set', 'weather.window_ended', 'goal.set', 'goal.cancelled',
  // 014 geo: road routes come from owner actions only.
  ...GEO_TYPE_LIST,
  // 015: the owner's god changes (their consequences are engine events).
  'outcome.set', 'career.set', 'self.moved', 'money.adjusted', 'vitals.planned', 'sick.planned',
  'cast.departed', 'cast.returned',
  // 016: the owner's tone hint and the record of a REGENERATE (never a cause).
  'scene.tone_set', 'scene.regenerated',
  // Wake him ("can't sleep").
  ...WAKE_TYPE_LIST,
  // 019: the owner's "he texts …" (the text itself is the engine's).
  'phone.text_set',
]);
// Of the 010 types only heavy.started is heavy, and only engine (the roll) or
// owner (a scene) start one — stricter than HEAVY_ACTORS: a mind nomination
// becomes an engine roll (research R17).
const HEAVY_START_ACTORS = new Set(['engine', 'owner']);
// Claims → world (reconciler.md §3): engine writes with a cause, so the
// claim's chat origin is inherited and can't be dropped.
const ADOPTION_TYPES = new Set(['claim.adopted', 'claim.withdrawn', 'activity.recorded', 'commitment.recorded']);
const CHAT_ORIGIN_KINDS = new Set(['group', 'dm', 'call', 'ig']);
// 011 engine consequences (review R14): engine actor, a cause, and the cause's
// TYPE must be one of these — a goal step hangs off its goal, a soak off its trip.
const CAUSE_TYPES = Object.freeze({
  'goal.fitted': ['goal.set'],
  'goal.deferred': ['goal.set'],
  'goal.expired': ['goal.set', 'cast.departed'],   // 015: a departure closes an open goal with that member
  'goal.done': ['goal.fitted'],
  'commute.soaked': ['travel.started'],
  // 015: a god change's engine consequences hang off the owner event that asked for them.
  'outcome.happened': ['outcome.set'],
  'change.applied': ['career.set', 'self.moved'],
  // 016: a scene hangs off the outing's activity.started (v1 and every regenerated
  // version, so a chat-origin outing's scene stays chat-origin). A follow-up is an
  // uncaused companion (D15, below): reverting the scene or anything above it never
  // cascades into an outing he already went on.
  'scene.played': ['activity.started'],
  // 020 G: his night, or the owner's wake that broke it (a revert of that wake takes the dream with it). Only his own life goes in.
  'dream.had': ['sleep.started', 'woke'],
  'scene.followup_lapsed': ['scene.followup'],
});
// 015 (plan §1.2): decision.expired with one of these reasons only from the
// engine, caused by an event of the listed type (the pulse never mints them).
const EXPIRY_CAUSE_TYPES = Object.freeze({
  fell_through: ['outcome.set'],
  career_changed: ['career.set', 'change.applied'],
  cast_departed: ['cast.departed'],
  owner_plan: ['decision.opened'],   // 2026-11-02: the owner's new outing over this plan
});
// No story family may descend from a chat (research R2, SC-002): a non-owner
// event whose (usually inherited) origin is a chat origin is refused for these
// types. A deny-list, so 009's chat-caused chains (decision → plan.made →
// travel/activity/meal/money.spent/work.late/sleep.started) are untouched.
// 011: goal.* — a goal is the owner's steering and never descends from a chat.
// commute.soaked is not listed: like travel.* it is part of 009's trip chain,
// which a chat-adopted outing legitimately reaches.
// 015: outcome.*, self.*, change.*, money.adjusted, vitals.planned (god types).
const CHAT_FORBIDDEN_PREFIXES = ['career.', 'family.', 'heavy.', 'arc.', 'story.', 'cast.', 'place.', 'sick.', 'goal.',
  // 014 geo
  'route.',
  // 015
  'outcome.', 'self.', 'change.'];
// 016: a chat-origin scene never plans a meet (scene.played itself is allowed: an
// adopted / invitation outing gets a narration-only scene).
const CHAT_FORBIDDEN_EXACT = ['relationship.changed', 'vitals.nudged', 'money.salary', 'money.adjusted', 'vitals.planned',
  'scene.followup', 'scene.followup_lapsed',
  // Wake him: never from a chat.
  ...WAKE_TYPE_LIST,
  // 018: the wallet's cut-over.
  ...WALLET_TYPE_LIST,
  // 019: texts with the fictional cast never descend from a chat.
  ...PHONE_TYPE_LIST];
// 014 sched: schedule overrides are the owner's alone and never descend from a chat
// (not `plan.`: a chat-adopted outing legitimately makes a plan.made).
CHAT_FORBIDDEN_PREFIXES.push('schedule.');
for (const t of SCHEDULE_TYPE_LIST) OWNER_ONLY_TYPES.add(t);
/** Every catalogue type a chat-origin, non-owner event may not have (precomputed: the check is O(1)). */
export const CHAT_FORBIDDEN_TYPES = new Set([...EVENT_TYPES].filter(t =>
  CHAT_FORBIDDEN_EXACT.includes(t) || CHAT_FORBIDDEN_PREFIXES.some(pre => t.startsWith(pre))));

export const PAYLOAD_MAX_BYTES = 8192;
const PAYLOAD_MAX_DEPTH = 6;
const STRING_MAX = 1000;
const REASON_MAX = 200;
const BY_MAX = 64;
const JID_MAX = 128;
const CHAIN_MAX_DEPTH = 256;
const LIST_MAX = 500;
// Plausible world time: 2000-01-01 .. 2100-01-01 (unix seconds, not ms).
const AT_MIN = 946684800;
const AT_MAX = 4102444800;
export const EVENT_AT_MIN = AT_MIN;
export const EVENT_AT_MAX = AT_MAX;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const JID_RE = /^[A-Za-z0-9._:+-]{1,96}@[a-z0-9.-]{1,30}$/;
const IG_ORIGIN_RE = /^ig:[a-z0-9][a-z0-9:_-]{0,62}$/;

const fail = (msg) => { throw new Error(`eventLog: ${msg}`); };
const isPlainObject = (v) => v !== null && typeof v === 'object'
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// ── Validation ────────────────────────────────────────────────────────────

function cleanString(s) {
  return sanitizeWebContent(s).slice(0, STRING_MAX);
}

// Deep copy of a JSON-shaped value with every string sanitized. Refuses
// non-plain objects (Date, Map, class instances), non-finite numbers, odd keys
// and runaway nesting; undefined members are dropped as JSON would.
function cleanValue(v, depth, where) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string') return cleanString(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${where} must be a finite number`);
    return v;
  }
  if (depth >= PAYLOAD_MAX_DEPTH) fail(`payload nests deeper than ${PAYLOAD_MAX_DEPTH}`);
  if (Array.isArray(v)) return v.filter(x => x !== undefined).map((x, i) => cleanValue(x, depth + 1, `${where}[${i}]`));
  if (!isPlainObject(v)) fail(`${where} must be plain JSON`);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    if (!KEY_RE.test(k) || FORBIDDEN_KEYS.has(k)) fail(`${where} has an invalid key "${String(k).slice(0, 32)}"`);
    out[k] = cleanValue(x, depth + 1, `${where}.${k}`);
  }
  return out;
}

/** Sanitized payload JSON (≤ PAYLOAD_MAX_BYTES). Throws on anything else. */
export function encodePayload(payload) {
  if (payload === undefined || payload === null) return '{}';
  if (!isPlainObject(payload)) fail('payload must be a plain object');
  const json = JSON.stringify(cleanValue(payload, 0, 'payload'));
  if (Buffer.byteLength(json, 'utf8') > PAYLOAD_MAX_BYTES) fail(`payload exceeds ${PAYLOAD_MAX_BYTES} bytes`);
  return json;
}

/**
 * Check an origin pair against 006's conventions: `self`⇔'self', `owner`⇔'owner',
 * group → …@g.us, dm/call → a person id (the caller's DM for calls), ig → 'ig:…'.
 */
export function isValidOrigin(kind, jid) {
  if (!ORIGIN_KINDS.has(kind) || typeof jid !== 'string' || jid.length > JID_MAX) return false;
  switch (kind) {
    case 'self': return jid === 'self';
    case 'owner': return jid === 'owner';
    case 'group': return JID_RE.test(jid) && isGroupJid(jid);
    case 'dm':
    case 'call': return JID_RE.test(jid) && isDmJid(jid);
    case 'ig': return IG_ORIGIN_RE.test(jid);
    default: return false;
  }
}

// 'self' and (010, research R3) 'owner' causes pass no taint on.
function causeIsSelf(cause) {
  return cause.origin_kind === 'self' || cause.origin_kind === 'owner';
}

function personJidOk(jid) {
  return typeof jid === 'string' && jid.length <= JID_MAX && JID_RE.test(jid) && !isGroupJid(jid);
}

function toId(v, what) {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) fail(`${what} must be a positive integer id`);
  return n;
}

function toAt(v) {
  if (!Number.isInteger(v) || v < AT_MIN || v > AT_MAX) fail('at must be integer unix seconds');
  return v;
}

// ── Rows ──────────────────────────────────────────────────────────────────

function parsePayload(json) {
  try {
    const v = JSON.parse(json);
    return isPlainObject(v) ? v : {};
  } catch {
    return {};
  }
}

/** world_events row → Event (camelCase, payload parsed, flags as booleans). */
export function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    at: row.at,
    recordedAt: row.recorded_at,
    type: row.type,
    actor: row.actor,
    causeId: row.cause_id ?? null,
    payload: parsePayload(row.payload_json),
    originKind: row.origin_kind,
    originJid: row.origin_jid,
    subjectJid: row.subject_jid ?? null,
    heavy: row.heavy === 1,
    redacted: row.redacted === 1,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Append one world event and return it (with its id).
 *
 * Provenance rules (plan §R13): the origin defaults to the cause's origin, so
 * anything caused by a chat trigger stays tagged with that chat; an explicit
 * origin that differs from a non-self cause's origin is refused (a chat-derived
 * consequence can't be laundered into `self`). Actor `chat` needs a chat origin
 * and may only append inert pointers; actor `owner` ⇔ origin `owner`; heavy
 * events come only from engine/mind/owner.
 */
export function appendEvent({
  type, at, actor, causeId = null, payload = {},
  originKind, originJid, subjectJid = null, heavy = false,
} = {}) {
  if (!EVENT_TYPES.has(type)) fail(`unknown event type "${String(type).slice(0, 40)}"`);
  if (!ACTORS.has(actor)) fail(`unknown actor "${String(actor).slice(0, 20)}"`);
  const when = toAt(at === undefined ? now() : at);
  if (typeof heavy !== 'boolean') fail('heavy must be a boolean');
  if (heavy && !HEAVY_ACTORS.has(actor)) fail(`actor ${actor} cannot create heavy events`);
  if (actor === 'chat' && !CHAT_ACTOR_TYPES.has(type)) fail(`actor chat cannot append ${type}`);
  if (subjectJid !== null && subjectJid !== undefined && !personJidOk(subjectJid)) fail('subjectJid must be a person jid');
  // 010 (after the 009 checks, so their messages still fire first).
  if (OWNER_ONLY_TYPES.has(type) && actor !== 'owner') fail(`only the owner can append ${type}`);
  // Earned trust (2026-10-30): a relationship change marked as the owner's comes from the owner only.
  if (type === 'relationship.changed' && payload?.reason === 'owner' && actor !== 'owner') fail('only the owner can append an owner relationship change');
  if (type === 'heavy.started') {
    if (!heavy) fail('heavy.started must be heavy');
    if (!HEAVY_START_ACTORS.has(actor)) fail(`actor ${actor} cannot start a heavy arc`);
  } else if (heavy && (STORY_EVENT_TYPES.has(type) || STEER_EVENT_TYPES.has(type) || GOD_EVENT_TYPES.has(type) || SCENE_EVENT_TYPES.has(type) || PHONE_EVENT_TYPES.has(type))) {
    fail(`${type} cannot be heavy`);
  }
  if (ADOPTION_TYPES.has(type)) {
    if (actor !== 'engine') fail(`${type} must be an engine event`);
    if (causeId === null || causeId === undefined) fail(`${type} needs a cause`);
  }
  // 011 (after the 010 checks).
  const causeTypes = Object.hasOwn(CAUSE_TYPES, type) ? CAUSE_TYPES[type] : null;
  if (causeTypes) {
    if (actor !== 'engine') fail(`${type} must be an engine event`);
    if (causeId === null || causeId === undefined) fail(`${type} needs a cause`);
  }
  // 019: a text is the engine's (the owner asks with phone.text_set), never about a real person.
  if (type === 'phone.message') {
    if (actor !== 'engine') fail('phone.message must be an engine event');
    if (subjectJid !== null && subjectJid !== undefined) fail('phone.message is never about a real person');
  }
  // 020 G: a dream is the engine's, never about a real person.
  if (type === 'dream.had') {
    if (actor !== 'engine') fail('dream.had must be an engine event');
    if (subjectJid !== null && subjectJid !== undefined) fail('dream.had is never about a real person');
  }
  // 016 (D15): a follow-up is a companion of its scene — no cause, the scene in its payload.
  if (type === 'scene.followup') {
    if (actor !== 'engine') fail('scene.followup must be an engine event');
    if (causeId !== null && causeId !== undefined) fail('scene.followup is a companion: it has no cause');
    if (!Number.isSafeInteger(payload?.sceneEventId) || payload.sceneEventId <= 0) fail('scene.followup needs a sceneEventId');
  }
  // 015 (after the 011 checks): reason-scoped expiries and owner picks.
  const expiryCause = type === 'decision.expired' && typeof payload?.reason === 'string' && Object.hasOwn(EXPIRY_CAUSE_TYPES, payload.reason)
    ? EXPIRY_CAUSE_TYPES[payload.reason] : null;
  if (expiryCause) {
    if (actor !== 'engine') fail(`decision.expired ${payload.reason} must be an engine event`);
    if (causeId === null || causeId === undefined) fail(`decision.expired ${payload.reason} needs a cause`);
  }
  if ((type === 'decision.committed' || type === 'decision.reversed') && payload?.by === 'owner' && actor !== 'owner') {
    fail(`only the owner can append an owner ${type}`);
  }

  const db = getDb();
  return db.transaction(() => {
    let cause = null;
    if (causeId !== null && causeId !== undefined) {
      cause = db.prepare('SELECT id, type, origin_kind, origin_jid FROM world_events WHERE id = ?').get(toId(causeId, 'causeId'));
      if (!cause) fail(`cause ${causeId} does not exist`);
      if (causeTypes && !causeTypes.includes(cause.type)) fail(`${type} cannot be caused by ${cause.type}`);
      if (expiryCause && !expiryCause.includes(cause.type)) fail(`decision.expired ${payload.reason} cannot be caused by ${cause.type}`);
      if (type === 'phone.message' && !PHONE_CAUSE_TYPES.includes(cause.type)) fail(`phone.message cannot be caused by ${cause.type}`);
    }

    // 016 (D15): a follow-up only for a self/owner-origin, full (fictional cast) scene.
    if (type === 'scene.followup') {
      const sc = db.prepare('SELECT type, payload_json, origin_kind FROM world_events WHERE id = ?').get(payload.sceneEventId);
      let mode = null;
      try { mode = sc ? parsePayload(sc.payload_json)?.mode ?? null : null; } catch { mode = null; }
      if (!sc || sc.type !== 'scene.played') fail('scene.followup: sceneEventId is not a scene.played');
      if (mode !== 'full' || !['self', 'owner'].includes(sc.origin_kind)) fail('scene.followup: only a self/owner full scene plans a meet');
    }

    let kind = originKind ?? null;
    let jid = originJid ?? null;
    if (kind === null && jid === null) {
      if (actor === 'owner') [kind, jid] = ['owner', 'owner'];
      // An owner cause counts as self (research R3): owner origins are steering,
      // not content, so the engine can act on a Director write (a block of an
      // owner plan.made, an owner card pick's consequence) and the result is his.
      else if (cause && !causeIsSelf(cause)) [kind, jid] = [cause.origin_kind, cause.origin_jid];
      else [kind, jid] = ['self', 'self'];
    } else if (kind === null) {
      fail('originKind is required with originJid');
    } else if (jid === null) {
      if (kind === 'self' || kind === 'owner') jid = kind;
      else fail(`originJid is required for origin kind ${kind}`);
    }
    if (!isValidOrigin(kind, jid)) fail(`invalid origin ${kind}/${String(jid).slice(0, 40)}`);

    if (actor === 'owner' && kind !== 'owner') fail('owner events must have origin owner');
    if (actor !== 'owner' && kind === 'owner') fail('only the owner can append owner-origin events');
    if (actor === 'chat' && !['group', 'dm', 'call', 'ig'].includes(kind)) fail('chat events need a chat origin');
    // Taint sticks: a non-self cause's origin is inherited, never replaced —
    // except by the owner, whose writes are origin `owner` by definition.
    if (cause && !causeIsSelf(cause) && actor !== 'owner'
        && (kind !== cause.origin_kind || jid !== cause.origin_jid)) {
      fail(`origin ${kind}/${jid} does not match cause ${cause.id}'s origin`);
    }
    if (actor !== 'owner' && CHAT_ORIGIN_KINDS.has(kind) && CHAT_FORBIDDEN_TYPES.has(type)) {
      fail(`${type} cannot have a chat origin`);
    }

    const info = db.prepare(`
      INSERT INTO world_events (at, type, actor, cause_id, payload_json, origin_kind, origin_jid, subject_jid, heavy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(when, type, actor, cause ? cause.id : null, encodePayload(payload), kind, jid, subjectJid ?? null, heavy ? 1 : 0);
    return getEvent(Number(info.lastInsertRowid));
  })();
}

/**
 * Owner undo (plan §R1): append `event.reverted {targetId, reason, by}` (actor
 * owner). The projector excludes the target and its engine/jev descendants
 * (cascadeIds). Snapshots taken at or after the target are invalidated in the
 * same transaction — they are a cache and would otherwise replay the reverted
 * state. Reverting genesis or a revert is refused; reverting an already
 * reverted event returns the existing revert.
 */
export function revertEvent(targetId, { reason = '', by = 'owner', at } = {}) {
  const id = toId(targetId, 'targetId');
  const db = getDb();
  return db.transaction(() => {
    const target = getEvent(id);
    if (!target) fail(`event ${id} does not exist`);
    if (target.type === 'genesis') fail('genesis cannot be reverted');
    if (target.type === 'event.reverted') fail('a revert cannot be reverted');
    const existing = db.prepare(`
      SELECT id FROM world_events
      WHERE type = 'event.reverted' AND json_extract(payload_json, '$.targetId') = ?
      ORDER BY id LIMIT 1
    `).get(id);
    if (existing) return { revertEventId: existing.id, already: true, snapshotsInvalidated: 0 };

    const ev = appendEvent({
      type: 'event.reverted',
      at,
      actor: 'owner',
      payload: {
        targetId: id,
        reason: cleanString(String(reason ?? '')).replace(/\s+/g, ' ').trim().slice(0, REASON_MAX),
        by: cleanString(String(by ?? 'owner')).replace(/\s+/g, ' ').trim().slice(0, BY_MAX) || 'owner',
      },
    });
    const snaps = db.prepare('DELETE FROM world_snapshots WHERE upto_event_id >= ? OR at >= ?').run(id, target.at);
    return { revertEventId: ev.id, already: false, snapshotsInvalidated: snaps.changes };
  })();
}

/**
 * 006 purgePerson hook (plan §R13): redact every event about `personJid` —
 * subject, DM/call origin, or the id named anywhere in the payload — to
 * `{"redacted":true}` with subject_jid cleared. This is the one UPDATE the
 * append-only trigger allows; ids, times, types, actors and cause links stay,
 * so replay and cause chains keep their shape. Also deletes the person's
 * life_queue rows (sender or DM chat), their DM-chat life_claims rows, and
 * every snapshot from the first redacted event on (stale cache).
 * Accepts one jid or several (phone + LID forms of the same person).
 */
// Bumped by every redaction: a read-only fold cached before it (projector.asOf) is stale.
let redactions = 0;
export const redactionGeneration = () => redactions;

export function redactPerson(personJid) {
  const jids = [...new Set((Array.isArray(personJid) ? personJid : [personJid]))];
  if (!jids.length) fail('redactPerson needs a person jid');
  for (const j of jids) if (!personJidOk(j)) fail('redactPerson needs a person jid');

  const db = getDb();
  return db.transaction(() => {
    const out = { events: 0, queue: 0, claims: 0, snapshots: 0 };
    let firstId = null;
    const redact = db.prepare(`
      UPDATE world_events SET payload_json = '{"redacted":true}', subject_jid = NULL, redacted = 1
      WHERE id = ? AND redacted = 0
    `);
    for (const j of jids) {
      // instr() narrows the scan; the regex then requires a whole-jid match so
      // "23@s.whatsapp.net" never redacts "123@s.whatsapp.net".
      const named = jidMatcher(j);
      const rows = db.prepare(`
        SELECT id, type, subject_jid, origin_kind, origin_jid, payload_json FROM world_events
        WHERE redacted = 0 AND (subject_jid = ? OR (origin_kind IN ('dm','call') AND origin_jid = ?)
          OR instr(payload_json, ?) > 0)
      `).all(j, j, j);
      for (const r of rows) {
        // A revert is never redacted for naming someone in its reason: wiping
        // its targetId would silently bring the reverted event back. The same
        // holds for a rewind's range (010; the Director refuses jids in text).
        const hit = r.subject_jid === j || (['dm', 'call'].includes(r.origin_kind) && r.origin_jid === j)
          || (r.type !== 'event.reverted' && r.type !== 'world.rewound' && named.test(r.payload_json));
        if (!hit) continue;
        // 020: a lean a DM nudged keeps that DM's origin, but the commit it nudged is self-origin (it hangs off
        // the decision) and so is all it caused: their redaction follows the lean's link, like a revert's. Read
        // first: the lean's own row is what the link is read from.
        const nudged = r.type === 'decision.lean' ? cascadeIds(r.id).filter(id => id !== r.id) : [];
        out.events += redact.run(r.id).changes;
        firstId = firstId === null ? r.id : Math.min(firstId, r.id);
        for (const id of nudged) {
          out.events += redact.run(id).changes;
          firstId = Math.min(firstId, id);
        }
      }
      out.queue += deleteQueueForPerson(j);
      if (tableExists(db, 'life_claims')) {
        out.claims += db.prepare('DELETE FROM life_claims WHERE chat_jid = ? OR origin_jid = ?').run(j, j).changes;
      }
      out.snapshots += db.prepare('DELETE FROM world_snapshots WHERE instr(state_json, ?) > 0').run(j).changes;
    }
    if (firstId !== null) {
      out.snapshots += db.prepare('DELETE FROM world_snapshots WHERE upto_event_id >= ?').run(firstId).changes;
    }
    redactions++;
    return out;
  })();
}

function jidMatcher(jid) {
  const esc = jid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9._:+-])${esc}(?![A-Za-z0-9.-])`);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One event by id, or null. */
export function getEvent(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return rowToEvent(getDb().prepare('SELECT * FROM world_events WHERE id = ?').get(n));
}

/**
 * Events in world-time order (`at`, then id). Filters: `from`/`to` (inclusive
 * world time), `types` (array), `originJid`, `subjectJid`; cursors `after` /
 * `before` (event ids, exclusive); `order` 'asc' (default) | 'desc' — use
 * 'desc' with `before` to page back from the newest. `limit` 1..500 (100).
 * With an id cursor the order is id (append) order: `at` is not monotone in id
 * (catch-up, phone and chat events), so an (at, id) order would skip or
 * repeat events across pages.
 */
export function listEvents({ from, to, types, originJid, subjectJid, after, before, limit = 100, order = 'asc' } = {}) {
  const where = [];
  const args = [];
  if (from !== undefined && from !== null) { where.push('at >= ?'); args.push(toAt(from)); }
  if (to !== undefined && to !== null) { where.push('at <= ?'); args.push(toAt(to)); }
  if (types !== undefined && types !== null) {
    const list = [...new Set(Array.isArray(types) ? types : [types])];
    if (!list.length) return [];
    for (const t of list) if (!EVENT_TYPES.has(t)) fail(`unknown event type "${String(t).slice(0, 40)}"`);
    where.push(`type IN (${list.map(() => '?').join(', ')})`);
    args.push(...list);
  }
  if (originJid !== undefined && originJid !== null) { where.push('origin_jid = ?'); args.push(String(originJid)); }
  if (subjectJid !== undefined && subjectJid !== null) { where.push('subject_jid = ?'); args.push(String(subjectJid)); }
  if (after !== undefined && after !== null) { where.push('id > ?'); args.push(toId(after, 'after')); }
  if (before !== undefined && before !== null) { where.push('id < ?'); args.push(toId(before, 'before')); }
  const lim = Math.min(LIST_MAX, Math.max(1, Math.floor(Number(limit)) || 100));
  const dir = order === 'desc' ? 'DESC' : 'ASC';
  const byId = (after !== undefined && after !== null) || (before !== undefined && before !== null);
  const sql = `SELECT * FROM world_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${byId ? `id ${dir}` : `at ${dir}, id ${dir}`} LIMIT ?`;
  return getDb().prepare(sql).all(...args, lim).map(rowToEvent);
}

/**
 * Events with id > `afterId` in append (id) order — the projector's replay
 * feed after a snapshot. Replay order is id, not `at`: catch-up writes past
 * times, and the fold must see events as they were written.
 */
export function eventsAfter(afterId = 0, limit = 5000) {
  const n = Number(afterId) || 0;
  const lim = Math.min(50000, Math.max(1, Math.floor(Number(limit)) || 5000));
  return getDb().prepare('SELECT * FROM world_events WHERE id > ? ORDER BY id LIMIT ?').all(n, lim).map(rowToEvent);
}

/** Highest event id (0 on an empty log). */
export function lastEventId() {
  return getDb().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM world_events').get().id;
}

/**
 * Why did this happen? The event and its causes up to the root, oldest first
 * (root … event) — the Timeline draws arrows along it. Causes always have a
 * lower id (appendEvent requires an existing cause), so the walk terminates;
 * the depth cap is a backstop. [] when the id is unknown.
 */
export function causeChain(id) {
  const start = Number(id);
  if (!Number.isSafeInteger(start) || start < 1) return [];
  const rows = getDb().prepare(`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT id, 0 FROM world_events WHERE id = ?
      UNION ALL
      SELECT e.cause_id, chain.depth + 1 FROM world_events e JOIN chain ON e.id = chain.id
      WHERE e.cause_id IS NOT NULL AND e.cause_id < chain.id AND chain.depth < ?
    )
    SELECT w.* FROM chain JOIN world_events w ON w.id = chain.id ORDER BY chain.depth DESC
  `).all(start, CHAIN_MAX_DEPTH);
  return rows.map(rowToEvent);
}

/**
 * Ids a revert of `targetId` removes from projection (plan §R1): the target
 * plus every engine/jev event reachable from it through engine/jev links.
 * Chat, mind and owner events are not cascaded (the Timeline shows them as
 * orphaned) and the walk does not continue through them — except an owner's
 * commit / reversal / lean caused by a decision.opened (a Director scene opens
 * and commits its outing in one change): it is part of that decision, so it
 * goes with it, and so do its engine consequences (the fitted plan, 015).
 *
 * A plan stops the walk at another outing (2026-11-02 live: reverting an
 * evening visit took the afternoon café date with it, because the day's plan
 * was re-made for the visit and the café's blocks were started from that
 * plan): an activity or trip a cascaded plan.made started for a block of a
 * DIFFERENT decision — one this revert doesn't take — stays, with everything
 * it caused (`planBlockDecision`). The projector applies the same rule.
 * When the plan itself is the revert target, everything it started goes.
 */
export function cascadeIds(targetId) {
  const start = Number(targetId);
  if (!Number.isSafeInteger(start) || start < 1) return [];
  const ids = cascadeAll(start);
  if (ids.length < 3) return ids;
  const db = getDb();
  const row = db.prepare('SELECT id, at, type, cause_id, payload_json FROM world_events WHERE id = ?');
  const rows = new Map();
  for (const id of ids) { const r = row.get(id); if (r) rows.set(id, r); }
  if (![...rows.values()].some(r => r.type === 'plan.made' && r.id !== start)) return ids;
  const inSet = new Set(ids);
  const kids = new Map();
  const parse = (r) => { try { return JSON.parse(r.payload_json); } catch { return {}; } };
  for (const r of rows.values()) {
    if (r.id === start) continue;
    // A nudged commit hangs off its lean (020), its cause being the decision.
    const parent = inSet.has(parse(r).leanEventId) ? parse(r).leanEventId : r.cause_id;
    if (!inSet.has(parent)) continue;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(r);
  }
  const out = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    const parent = rows.get(id);
    const plan = parent?.type === 'plan.made' && id !== start ? parse(parent) : null;
    for (const k of kids.get(id) ?? []) {
      if (plan) {
        const d = planBlockDecision(plan, { at: k.at, type: k.type, payload: parse(k) });
        if (d && !inSet.has(d)) continue;
      }
      out.add(k.id);
      queue.push(k.id);
    }
  }
  return ids.filter(id => out.has(id));
}

const PLAN_STARTS = new Set(['activity.started', 'travel.started']);

/**
 * The decision whose block of `plan` (a plan.made payload) started `ev` (an
 * activity.started or travel.started it caused): the block covering ev.at of
 * the same kind (a trip: a commute block), else null. A trip may leave a
 * minute before its block.
 */
export function planBlockDecision(plan, ev) {
  if (!ev || !PLAN_STARTS.has(ev.type) || !Array.isArray(plan?.blocks)) return null;
  const at = Number(ev.at);
  if (!Number.isFinite(at)) return null;
  const kind = ev.type === 'travel.started' ? 'commute' : ev.payload?.kind;
  for (const b of plan.blocks) {
    if (!b || b.kind !== kind || !Number.isSafeInteger(b.decisionId) || b.decisionId < 1) continue;
    const from = ev.type === 'travel.started' ? b.start - 60 : b.start;
    if (at >= from && at < b.end) return b.decisionId;
  }
  return null;
}

// 020: a commit or reversal a chat lean nudged (cause = the decision, so its origin stays his) names that
// lean in payload.leanEventId, and goes with it. The commit is a child by this link, not by cause_id.
function cascadeAll(start) {
  const db = getDb();
  const seen = new Set();
  const queue = [start];
  const ofLean = db.prepare(`SELECT id FROM world_events WHERE cause_id = ? AND type IN ('decision.committed','decision.reversed')
    AND actor IN ('engine','jev') AND json_extract(payload_json, '$.leanEventId') = ?`);
  const leanOf = db.prepare(`SELECT json_extract(payload_json, '$.decisionId') AS d FROM world_events WHERE id = ? AND type = 'decision.lean'`);
  while (queue.length) {
    const from = queue.shift();
    if (seen.has(from)) continue;
    for (const id of cascadeDown(from)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const decisionId = leanOf.get(id)?.d;
      if (Number.isSafeInteger(decisionId)) for (const r of ofLean.all(decisionId, id)) if (!seen.has(r.id)) queue.push(r.id);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

function cascadeDown(start) {
  return getDb().prepare(`
    WITH RECURSIVE down(id, depth, type) AS (
      SELECT id, 0, type FROM world_events WHERE id = ?
      UNION
      SELECT e.id, down.depth + 1, e.type FROM world_events e JOIN down ON e.cause_id = down.id
      WHERE (e.actor IN ('engine','jev')
          OR (e.actor = 'owner' AND down.type = 'decision.opened'
            AND e.type IN ('decision.committed','decision.reversed','decision.lean')))
        AND down.depth < ?
    )
    SELECT DISTINCT id FROM down ORDER BY id
  `).all(start, CHAIN_MAX_DEPTH * 16).map(r => r.id);
}

/** 015: the events directly caused by `causeId` (any actor), in id order (≤ 500). */
export function childEvents(causeId) {
  const id = Number(causeId);
  if (!Number.isSafeInteger(id) || id < 1) return [];
  return getDb().prepare('SELECT * FROM world_events WHERE cause_id = ? ORDER BY id LIMIT ?').all(id, LIST_MAX).map(rowToEvent);
}

/**
 * 017: the owner `director.action`s applied together with `ev` — one bundle's
 * parts share the preview fingerprint and the apply time, back to back (no other
 * Director change between them) — in id order. A single change → [ev]; not an
 * owner Director change → [].
 */
export function directorGroup(ev) {
  if (!ev || ev.type !== 'director.action' || ev.actor !== 'owner') return [];
  const fp = typeof ev.payload?.fingerprint === 'string' ? ev.payload.fingerprint : null;
  if (!fp) return [ev];
  const same = getDb().prepare("SELECT * FROM world_events WHERE type = 'director.action' AND at = ? ORDER BY id LIMIT ?")
    .all(ev.at, LIST_MAX).map(rowToEvent);
  const i = same.findIndex(e => e.id === ev.id);
  if (i < 0) return [ev];
  const fits = (e) => e.actor === 'owner' && e.payload?.fingerprint === fp;
  let a = i;
  let b = i;
  while (a > 0 && fits(same[a - 1])) a -= 1;
  while (b < same.length - 1 && fits(same[b + 1])) b += 1;
  return same.slice(a, b + 1);
}

/**
 * 015: ids of events after `afterId` whose payload names `token` as a JSON string
 * value (e.g. a place or cast id) — REVERT THIS CHANGE's "nothing else uses it" check.
 */
export function eventsNaming(token, afterId = 0) {
  if (typeof token !== 'string' || !token || token.length > 80) return [];
  return getDb().prepare('SELECT id FROM world_events WHERE id > ? AND instr(payload_json, ?) > 0 ORDER BY id LIMIT ?')
    .all(Math.max(0, Number(afterId) || 0), JSON.stringify(token), LIST_MAX).map(r => r.id);
}

/** Every revert in the log: [{ revertId, targetId, at }], oldest first. */
export function listReverts() {
  return getDb().prepare(`
    SELECT id AS revertId, CAST(json_extract(payload_json, '$.targetId') AS INTEGER) AS targetId, at
    FROM world_events WHERE type = 'event.reverted' AND redacted = 0 ORDER BY id
  `).all().filter(r => Number.isSafeInteger(r.targetId) && r.targetId > 0);
}

// ── 010 reads ─────────────────────────────────────────────────────────────

const LEAN_HISTORY_MAX = 50;
const LEAN_OPTION_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,47}$/;
const LEAN_WORD_RE = /^[a-z][a-z0-9_:-]{0,31}$/;

/**
 * A decision's lean history for its card (research R14): the newest `limit`
 * (1..50) `decision.lean` rows that name it, oldest first, as
 * [{at, optionId, p, actor, fallback}]. Raw log: a redacted lean names no
 * decision and drops out. [] for an unknown or invalid id.
 */
export function leanHistory(decisionId, limit = LEAN_HISTORY_MAX) {
  const n = typeof decisionId === 'string' && /^\d{1,15}$/.test(decisionId) ? Number(decisionId) : decisionId;
  if (!Number.isSafeInteger(n) || n < 1) return [];
  const lim = Math.min(LEAN_HISTORY_MAX, Math.max(1, Math.floor(Number(limit)) || LEAN_HISTORY_MAX));
  const rows = getDb().prepare(`
    SELECT id, at, actor, payload_json FROM world_events
    WHERE type = 'decision.lean' AND json_extract(payload_json, '$.decisionId') = ?
    ORDER BY id DESC LIMIT ?
  `).all(n, lim).reverse();
  return rows.map((r) => {
    const p = parsePayload(r.payload_json);
    return {
      at: r.at,
      optionId: typeof p.optionId === 'string' && LEAN_OPTION_RE.test(p.optionId) ? p.optionId : null,
      p: typeof p.p === 'number' && Number.isFinite(p.p) ? Math.min(1, Math.max(0, p.p)) : null,
      actor: r.actor,
      fallback: typeof p.fallback === 'string' && LEAN_WORD_RE.test(p.fallback) ? p.fallback : null,
    };
  });
}

/**
 * Every rewind's excluded id range (research R11), oldest first:
 * [{rewindId, from, to}] with from = toEventId + 1 and to = rewindId − 1.
 * The projector pre-seeds its ranges from this so a full replay converges.
 * A rewind with no events in between (an empty range) is left out.
 */
export function listRewinds() {
  return getDb().prepare(`
    SELECT id AS rewindId, CAST(json_extract(payload_json, '$.toEventId') AS INTEGER) AS toEventId
    FROM world_events WHERE type = 'world.rewound' AND redacted = 0 ORDER BY id
  `).all()
    .filter(r => Number.isSafeInteger(r.toEventId) && r.toEventId > 0 && r.toEventId < r.rewindId - 1)
    .map(r => ({ rewindId: r.rewindId, from: r.toEventId + 1, to: r.rewindId - 1 }));
}

/**
 * World time of the latest heavy proposal or onset in the RAW log — excluded,
 * reverted, rewound and redacted rows included — or null. The 90-day heavy gap
 * is measured from this, so no revert or rewind can reset it (research R17).
 */
export function lastHeavyAt() {
  const row = getDb().prepare(`
    SELECT MAX(at) AS at FROM world_events WHERE type IN ('heavy.proposed', 'heavy.started')
  `).get();
  return Number.isSafeInteger(row?.at) ? row.at : null;
}
