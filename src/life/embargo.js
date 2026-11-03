import { config } from '../utils/config.js';

// Heavy-arc embargo (spec 009 plan §R15). Heavy events themselves arrive with
// spec 010; 009 ships the hooks so they are safe from day one.
//
// An event with heavy = 1, appended by the engine, mind or owner (NEVER by chat
// or Jev — the same rule eventLog.js enforces on append), starts an embargo for config.life.embargoHours (12 h): the pulse appends
// `embargo.started` + `alert.raised` (dashboard alert), prompts carry tone only
// (innerState.js reads EMBARGO_TONE), and lifeGuardNote() is appended to the
// quality-gate prompt so a reply never asks anyone for money or help and never
// announces personal news in a group. `embargo.ended` is appended by the pulse
// once world time passes `until`.
//
// Pure: functions take the projected embargo ({ until, eventId, heavyEventId,
// startedAt } | null) and world time, and return event DESCRIPTORS for the
// caller to append through eventLog.js appendEvent() — this module does no I/O.
// Descriptor shape: { type, at, actor, causeId, payload } (appendEvent's own
// argument names). No origin is set: appendEvent inherits it from the cause, so
// an embargo caused by a chat-tainted heavy event stays tagged with that chat.
// An owner-made heavy event gets owner-actor consequences (only the owner may
// write owner-origin events); everything else is the engine's. Payloads hold
// ids and times only, never the heavy event's content, so an alert or a
// timeline row can't leak what happened into a prompt.

export const EMBARGO_TONE = 'having a quiet, low day; not up for much';

/** Fixed quality-gate note during an embargo (never built from event content). */
export const GUARD_NOTE =
  'He is going through a hard time right now. Reject the reply if it asks anyone for money, a loan or help, ' +
  'or if it announces or hints at personal news in a group chat when nobody asked.';

const MAX_HOURS = 24 * 7;
const HEAVY_ACTORS = new Set(['engine', 'mind', 'owner']);

const finite = v => typeof v === 'number' && Number.isFinite(v);

function embargoHours(hours) {
  const h = finite(hours) ? hours : Number(config.life?.embargoHours);
  if (!finite(h) || h <= 0) return 12;
  return Math.min(MAX_HOURS, h);
}

/** True for an event that may start an embargo: heavy and not chat-made. */
export function isHeavy(event) {
  return !!event && (event.heavy === 1 || event.heavy === true) && HEAVY_ACTORS.has(event.actor);
}

/**
 * React to a just-appended event. Returns { embargo, events }: the expected
 * embargo state (its `eventId` is filled by applyEmbargoEvent once the started
 * event has an id) and the descriptors to append, in order — `embargo.started`
 * and `alert.raised`, both caused by the heavy event. Not heavy, chat-made, or
 * not yet appended (no id) → no change. A heavy event during an active embargo
 * extends `until` (never shortens it).
 */
export function startFromHeavy(event, current = null, { hours } = {}) {
  if (!isHeavy(event) || !Number.isInteger(event.id) || !finite(event.at)) {
    return { embargo: current, events: [] };
  }
  const at = Math.floor(event.at);
  const fresh = at + Math.round(embargoHours(hours) * 3600);
  const active = isActive(current, at);
  const until = active ? Math.max(current.until, fresh) : fresh;
  const actor = event.actor === 'owner' ? 'owner' : 'engine';
  const started = {
    type: 'embargo.started',
    at,
    actor,
    causeId: event.id,
    payload: { until, heavyEventId: event.id, ...(active ? { extends: current.eventId ?? null } : {}) },
  };
  const alert = {
    type: 'alert.raised',
    at,
    actor,
    causeId: event.id,
    payload: { kind: 'embargo', until, heavyEventId: event.id },
  };
  return {
    embargo: { until, eventId: null, heavyEventId: event.id, startedAt: active ? current.startedAt : at },
    events: [started, alert],
  };
}

/** True while `embargo` covers world time `at`. */
export function isActive(embargo, at) {
  return !!embargo && finite(embargo.until) && finite(at) && at < embargo.until;
}

/**
 * End detection for the pulse: an `embargo.ended` descriptor once `at` has
 * reached `until`, else null. The event is dated `until` (not the tick that
 * noticed it), so a catch-up after downtime yields the same log as a live run.
 * The end is caused by time, not by the start: no causeId (so it never inherits
 * an owner or chat origin it can't carry), the started event is in the payload.
 */
export function endIfDue(embargo, at) {
  if (!embargo || !finite(embargo.until) || !finite(at) || at < embargo.until) return null;
  return {
    type: 'embargo.ended',
    at: Math.floor(embargo.until),
    actor: 'engine',
    causeId: null,
    payload: { startedEventId: embargo.eventId ?? null, heavyEventId: embargo.heavyEventId ?? null },
  };
}

/** Quality-gate note while embargoed, else null. */
export function lifeGuardNote(embargo, at) {
  return isActive(embargo, at) ? GUARD_NOTE : null;
}

/** Tone-only line while embargoed, else null (innerState.js uses it in place of details). */
export function embargoTone(embargo, at) {
  return isActive(embargo, at) ? EMBARGO_TONE : null;
}

/**
 * Projector helper: fold one event into the embargo state. Handles
 * `embargo.started` / `embargo.ended`; any other event returns `embargo` as is.
 */
export function applyEmbargoEvent(embargo, event) {
  if (!event) return embargo;
  if (event.type === 'embargo.started') {
    const p = event.payload || {};
    if (!finite(p.until)) return embargo;
    const keep = embargo && finite(embargo.until) && embargo.until > event.at;
    return {
      until: keep ? Math.max(embargo.until, p.until) : p.until,
      eventId: Number.isInteger(event.id) ? event.id : null,
      heavyEventId: Number.isInteger(p.heavyEventId) ? p.heavyEventId : null,
      startedAt: keep && finite(embargo.startedAt) ? embargo.startedAt : event.at,
    };
  }
  if (event.type === 'embargo.ended') return null;
  return embargo;
}
