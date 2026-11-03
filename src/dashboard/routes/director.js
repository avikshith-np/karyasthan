// The Director (spec 010, contracts/director-api.md §3, §5, §6): preview-then-
// apply over the closed action catalogue, preview tomorrow, bookmarks.
//
// Previews are ordinary POSTs (plan review A8): readOnlyGuard answers 403 while
// DASHBOARD_READONLY=true and csrfGuard checks the token otherwise — a preview
// rebuilds projections and can show claim text, so it is treated as a write
// (neither middleware is edited). Previews write nothing and are not audited;
// every accepted apply is audited as `director.<kind>` with the fingerprint and
// the appended event ids only.
//
// The Director prompt (spec 011): POST /api/director/prompt {wish} — one mind
// call turns the wish into DRAFTS (ordinary actions); nothing is written. The
// page previews and applies each draft through the two routes above, sending
// `source:'prompt'` with the preview so the apply audit can tell a suggested
// action from a hand-built one (review R11; never in world events). The prompt
// is audited as `director.prompt` with lengths, counts and a status only.
//
// The route validates the shape (closed kinds, bounded body, no JIDs); the
// Director's planner validates every field (director-api §4) and the story
// facade is the only door (loaded lazily by routes/arcs.js).
import { config } from '../../utils/config.js';
import { auditWrite } from '../audit.js';
import * as life from '../../life/index.js';
import { TEXT_TONES } from '../../life/story/index.js';
import { getEvent } from '../../life/eventLog.js';
import {
  WRITE, PREVIEW, TOMORROW, PROMPT, actorOf, bodyProblem, storyContext, writeGate, sendStoryError,
} from './arcs.js';
import { CONTINUITY } from './arcs.js';   // 015 cont

// The closed action catalogue (director-api §3); the planner re-validates.
export const ACTION_KINDS = new Set(['quick', 'fate', 'slider', 'pin', 'unpin', 'pause', 'resume', 'rewind',
  'bookmark', 'bookmark.remove', 'scene', 'cast.edit', 'cast.history', 'place.edit', 'seed.set', 'reconciler.mode',
  'tray.adopt', 'heavy.end', 'proposal.approve',
  // 011 Phase 2
  'weather', 'weather.end', 'goal', 'goal.cancel',
  // earned trust: closeness / trust / tension set by the owner
  'cast.metrics',
  // 014 geo: real places (ids only; the server resolves them)
  'place.real', 'places.realify', 'routes.refresh',
  // 014 sched: schedule edits
  'schedule', 'schedule.clear',
  // 015 Director as god: the opened powers
  'decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health', 'arc.end', 'cast.depart', 'cast.return',
  // 015 cont: several actions in one apply; rewind + actions dated now
  'bundle', 'retcon',
  // 016 scenes: the owner's tone hint for how an outing's scene should go
  'scene.tone',
  // wake him ("can't sleep")
  'wake',
  // 019 his phone: he texts a member of his cast
  'text']);
// 015 enums (the planner re-validates every field; these are the shape checks).
const GOD_ENUMS = Object.freeze({
  outcome: ['outcome', ['well', 'badly', 'cancelled']],
  career: ['change', ['hire', 'fire', 'quit', 'promote', 'job', 'salary', 'pattern']],
  money: ['mode', ['set', 'income', 'expense']],
  health: ['change', ['sick', 'well']],
  'arc.end': ['outcome', ['fizzled', 'broken_up', 'done', 'cancelled']],
  'cast.depart': ['how', ['moved_away', 'moved_out', 'written_out']],
});
const GOD_IDS = Object.freeze({ 'decision.pick': 'decisionId', outcome: 'decisionId', 'arc.end': 'arcId' });
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
export const QUICK_BUTTONS = new Set(['tired', 'energised', 'free_evening', 'cancel_tonight', 'rain', 'sick_day',
  'bad_day_at_work', 'good_day_at_work']);
export const SCENE_SHAPES = new Set(['outing', 'visit', 'cast.beat', 'cast.history', 'new_cast', 'new_place',
  'arc.start', 'arc.stage', 'heavy']);
export const WEATHER_KINDS = new Set(['clear', 'cloudy', 'rain', 'storm', 'heat']);
export const GOAL_KINDS = new Set(['meet', 'call', 'outing', 'errand']);
const ID_FIELD = (v) => Number.isSafeInteger(v) && v > 0;
// 014 sched: the schedule shapes (the planner validates every field).
export const SCHEDULE_BACKGROUNDS = new Set(['off', 'work_home', 'work_office']);
export const SCHEDULE_ACTIVITIES = new Set(['home', 'out', 'sleep', 'errand', 'gym', 'work_office', 'work_home']);
const SCHEDULE_OPS = new Set(['set', 'remove', 'move']);
const SCHEDULE_TIME = (v) => v === 'now' || v === 'endOfDay' || (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) || ID_FIELD(v);
const SCHEDULE_RESOLUTIONS = new Set(['cancel', 'reopen', 'keep', 'drop']);

// The owner's conflict resolutions ({'<type>:<id>': cancel|reopen|keep|drop}): a
// schedule edit's, and (2026-11-02) an owner outing / visit set up over a plan.
function resolutionsProblem(r) {
  if (r === undefined || r === null) return false;
  if (typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length > 16) return true;
  return Object.entries(r).some(([k, v]) => !/^(decision|goal|commitment|meeting|invite):\d{1,15}$/.test(k) || !SCHEDULE_RESOLUTIONS.has(v));
}

/** 014 sched: shape of a `schedule` action → null | reason. */
export function scheduleProblem(a) {
  if (a.kind === 'schedule.clear') return ID_FIELD(a.overrideId) ? null : 'bad_overrideId';
  if (a.op !== undefined && a.op !== null && !SCHEDULE_OPS.has(a.op)) return 'bad_op';
  const hasDay = a.day !== undefined && a.day !== null;
  if (hasDay === (a.date !== undefined && a.date !== null)) return 'bad_day';
  if (hasDay && !(Number.isInteger(a.day) && a.day >= 0 && a.day <= 7)) return 'bad_day';
  if (!hasDay && !(typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date))) return 'bad_date';
  if (a.background !== undefined && a.background !== null) {
    const bg = a.background;
    if (typeof bg !== 'object' || Array.isArray(bg) || !SCHEDULE_BACKGROUNDS.has(bg.activity)) return 'bad_background';
    if (bg.wholeDay !== true && (!SCHEDULE_TIME(bg.from) || (bg.to !== undefined && bg.to !== null && !SCHEDULE_TIME(bg.to)))) return 'bad_background';
  }
  if (a.ranges !== undefined && a.ranges !== null) {
    if (!Array.isArray(a.ranges) || a.ranges.length > 3) return 'bad_ranges';
    for (const r of a.ranges) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || !SCHEDULE_ACTIVITIES.has(r.activity)) return 'bad_ranges';
      if (!SCHEDULE_TIME(r.from) || !SCHEDULE_TIME(r.to)) return 'bad_ranges';
      if (r.candidateId !== undefined && r.candidateId !== null && !(typeof r.candidateId === 'string' && CANDIDATE_ID_RE.test(r.candidateId))) return 'bad_candidateId';   // geo's ids (cand:<uuid>)
      if (r.castIds !== undefined && r.castIds !== null && (!Array.isArray(r.castIds) || r.castIds.length > 4)) return 'bad_castIds';
      // The client never carries venue data (geo R18): coordinates, venues and routes come from the server.
      for (const k of ['venue', 'routes', 'swaps', 'lat', 'lon']) if (r[k] !== undefined) return 'bad_ranges';
    }
  }
  if (resolutionsProblem(a.resolutions)) return 'bad_resolutions';
  if ((a.op === 'remove' || a.op === 'move') && !(typeof a.blockKind === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(a.blockKind))) return 'bad_blockKind';
  if (a.op === 'move' && !SCHEDULE_TIME(a.moveTo)) return 'bad_moveTo';
  return null;
}
const METRIC_FIELDS = ['closeness', 'trust', 'tension', 'intimacy', 'passion', 'commitment'];   // 015: + the romance numbers

const SOURCES = new Set(['prompt']);
const WISH_MAX = 400;
const PROMPT_STATUSES = new Set(['ok', 'invalid_output', 'model_failed', 'skipped']);
const SLUG = /^[a-z][A-Za-z0-9_]{0,39}$/;

const PREVIEW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_RE = /^[A-Za-z0-9+/=_:.-]{8,200}$/;
const AUDIT_IDS_MAX = 50;

// previewId → { kind, expiresAt } so an apply is audited as director.<kind>
// (the apply body carries only the preview id and fingerprint).
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_KINDS_MAX = 64;
const previewKinds = new Map();

function rememberKind(previewId, kind, source = null, extra = null) {
  if (typeof previewId !== 'string') return;
  const now = Date.now();
  for (const [id, v] of previewKinds) if (v.expiresAt <= now) previewKinds.delete(id);
  previewKinds.set(previewId, { kind, source, expiresAt: now + PREVIEW_TTL_MS, ...(extra ? { extra } : {}) });
  while (previewKinds.size > PREVIEW_KINDS_MAX) previewKinds.delete(previewKinds.keys().next().value);
}

function takeKind(previewId) {
  const v = previewKinds.get(previewId);
  if (!v) return { kind: null, source: null };
  previewKinds.delete(previewId);
  return v.expiresAt > Date.now() ? { kind: v.kind, source: v.source ?? null, extra: v.extra ?? null } : { kind: null, source: null };
}

// A draft from the prompt facade → the page's shape (codes, ids, the model's
// short strings; every action re-checked like a hand-built one).
function cleanDraft(d) {
  return {
    index: Number.isSafeInteger(d?.index) ? d.index : null,
    action: d.action,
    summary: typeof d.summary === 'string' ? d.summary.slice(0, 200) : '',
    why: typeof d.why === 'string' ? d.why.slice(0, 120) : null,
    texts: (Array.isArray(d.texts) ? d.texts : []).slice(0, 24)
      .filter(t => typeof t?.field === 'string' && typeof t?.value === 'string')
      .map(t => ({ field: t.field.slice(0, 40), value: t.value.slice(0, 400) })),
    refusals: (Array.isArray(d.refusals) ? d.refusals : []).slice(0, 10)
      .map(r => ({ reason: SLUG.test(r?.reason ?? '') ? r.reason : 'refused', target: typeof r?.target === 'string' ? r.target.slice(0, 80) : null })),
    warnings: (Array.isArray(d.warnings) ? d.warnings : []).filter(w => typeof w === 'string').slice(0, 8).map(w => w.slice(0, 120)),
    events: Number.isSafeInteger(d.events) ? d.events : 0,
    batchable: d.batchable === true,
    reviewReason: SLUG.test(d.reviewReason ?? '') ? d.reviewReason : null,
    // 014 geo (A6b): a draft that named a real venue → the lookup's candidates (ids, names, areas).
    ...(DRAFT_STATUSES.has(d.status) ? { status: d.status } : {}),
    ...(Array.isArray(d.venues) ? { venues: d.venues.slice(0, 3).map(cleanVenueSlot) } : {}),
    // An outing he can't make in time: the first start he can (MOVE TO EARLIEST on the card).
    ...(d.status === 'too_soon' && Number.isSafeInteger(d.earliestAt) && d.earliestAt > 0 ? { earliestAt: d.earliestAt } : {}),
    // A side draft (a bookmark, or one marked as accompanying another) and the main drafts it waits for.
    ...(d.side === true ? { side: true } : {}),
    // 017: the draft in plain words (code-built), for the plan line the page rebuilds when a draft is left out.
    ...(typeof d.phrase === 'string' && d.phrase ? { phrase: d.phrase.slice(0, 160) } : {}),
    ...(Array.isArray(d.dependsOn) ? { dependsOn: d.dependsOn.filter(Number.isSafeInteger).slice(0, 8) } : {}),
  };
}

// needs_venue / needs_pick: a real venue to pick first; too_soon / no_route: an outing he can't make.
const DRAFT_STATUSES = new Set(['needs_venue', 'needs_pick', 'too_soon', 'no_route']);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
function cleanVenueSlot(v) {
  return {
    range: Number.isSafeInteger(v?.range) ? v.range : null,
    ...(v?.field === 'place' ? { field: 'place' } : {}),   // a scene outing's place (no range)
    query: { name: str(v?.query?.name, 60), area: str(v?.query?.area, 40) },
    candidates: (Array.isArray(v?.candidates) ? v.candidates : []).slice(0, 5)
      .filter(c => typeof c?.id === 'string' && /^cand:[0-9a-f-]{36}$/.test(c.id))
      .map(c => ({ id: c.id, name: str(c.name, 60), kind: str(c.kind, 24), area: str(c.area, 40),
        distKmFromHome: Number.isFinite(c.distKmFromHome) ? c.distKmFromHome : null,
        flags: (Array.isArray(c.flags) ? c.flags : []).filter(f => typeof f === 'string').slice(0, 4) })),
  };
}

/** Route-level shape check of `action` → null when fine, else a reason code (400). */
export function actionProblem(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return 'bad_action';
  if (typeof action.kind !== 'string' || !ACTION_KINDS.has(action.kind)) return 'bad_kind';
  if (action.kind === 'quick' && !QUICK_BUTTONS.has(action.button)) return 'bad_button';
  if (action.kind === 'scene' && !SCENE_SHAPES.has(action.shape)) return 'bad_shape';
  if (action.kind === 'scene' && resolutionsProblem(action.resolutions)) return 'bad_resolutions';
  // 014 geo: a scene outing at a real venue carries the picked candidate's id only.
  if (action.kind === 'scene' && action.candidateId !== undefined && action.candidateId !== null) {
    if (typeof action.candidateId !== 'string' || !CANDIDATE_ID_RE.test(action.candidateId)) return 'bad_candidateId';
    if (carriesVenueData(action)) return 'venue_data';
  }
  if (action.kind === 'weather' && !WEATHER_KINDS.has(action.weatherKind)) return 'bad_weatherKind';
  if (action.kind === 'weather.end' && !ID_FIELD(action.windowId)) return 'bad_windowId';
  if (action.kind === 'goal' && !GOAL_KINDS.has(action.goalKind)) return 'bad_goalKind';
  if (action.kind === 'goal.cancel' && !ID_FIELD(action.goalId)) return 'bad_goalId';
  // 014 geo (R18, T8): these kinds carry ids only — venue data, routes, swaps and
  // coordinates come from the server-side stores, never from a client.
  if (GEO_KINDS.has(action.kind) || action.kind === 'schedule') {
    if (carriesVenueData(action)) return 'venue_data';
    if (action.kind === 'place.real') {
      if (typeof action.candidateId !== 'string' || !CANDIDATE_ID_RE.test(action.candidateId)) return 'bad_candidateId';
      if (action.as !== 'new' && action.as !== 'replace') return 'bad_as';
      if (action.as === 'replace' && (typeof action.placeId !== 'string' || !PLACE_ID_RE.test(action.placeId))) return 'bad_placeId';
    }
    if ((action.kind === 'places.realify' || action.kind === 'routes.refresh') && (typeof action.resultId !== 'string' || !RESULT_ID_RE.test(action.resultId))) return 'bad_resultId';
    for (const k of ['untick', 'tick']) {
      if (action[k] !== undefined && (!Array.isArray(action[k]) || !action[k].every(x => typeof x === 'string' && PLACE_ID_RE.test(x)))) return `bad_${k}`;
    }
  }
  if (action.kind === 'schedule' || action.kind === 'schedule.clear') {   // 014 sched
    const p = scheduleProblem(action);
    if (p) return p;
  }
  if (action.kind === 'wake') {   // wake him: reason enum, times 'HH:MM' or unix seconds
    if (!['cant_sleep', 'woken_up', 'early_start'].includes(action.reason)) return 'bad_reason';
    for (const k of ['at', 'until']) {
      const v = action[k];
      if (v !== undefined && v !== null && !(typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) && !Number.isSafeInteger(v)) return `bad_${k}`;
    }
  }
  if (action.kind === 'text') {   // 019: a cast id, the owner's gist / first words, an optional tone, a time 'HH:MM' | unix | 'now', who texts first, short/long, wake
    if (typeof action.castId !== 'string' || !CAST_ID_RE.test(action.castId)) return 'bad_castId';
    const hasWords = typeof action.words === 'string' && action.words.trim() !== '';
    if (action.words !== undefined && action.words !== null && action.words !== '' && (typeof action.words !== 'string' || action.words.length > 160)) return 'bad_words';
    if (action.gist === undefined || action.gist === null || action.gist === '') { if (!hasWords) return 'bad_gist'; }
    else if (typeof action.gist !== 'string' || !action.gist.trim() || action.gist.length > 200) return 'bad_gist';
    if (action.from !== undefined && action.from !== null && !['him', 'them'].includes(action.from)) return 'bad_from';
    if (action.chat !== undefined && action.chat !== null && !['short', 'long'].includes(action.chat)) return 'bad_chat';
    if (action.wake !== undefined && action.wake !== null && typeof action.wake !== 'boolean') return 'bad_wake';
    if (action.tone !== undefined && action.tone !== null && action.tone !== ''
      && !TEXT_TONES.includes(action.tone)) return 'bad_tone';
    const v = action.at;
    if (v !== undefined && v !== null && v !== 'now' && !(typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) && !Number.isSafeInteger(v)) return 'bad_at';
    for (const k of Object.keys(action)) if (!['kind', 'castId', 'gist', 'tone', 'at', 'from', 'words', 'chat', 'wake', 'source'].includes(k)) return 'bad_field';
  }
  if (action.kind === 'cast.metrics') {
    const set = METRIC_FIELDS.filter(k => action[k] !== undefined && action[k] !== null);
    if (!set.length || !set.every(k => Number.isFinite(action[k]) && action[k] >= 0 && action[k] <= 1)) return 'bad_metrics';
  }
  const god = godProblem(action);
  if (god) return god;
  const tone = sceneToneProblem(action);   // 016
  if (tone) return tone;
  // 015 cont: a bundle's / retcon's parts get the same checks (an excluded kind → bad_kind).
  if (action.kind === 'bundle' || action.kind === 'retcon') { const pp = partsProblem(action); if (pp) return pp.error; }
  return bodyProblem(action);
}

// ── 014 geo ───────────────────────────────────────────────────────────────
const GEO_KINDS = new Set(['place.real', 'places.realify', 'routes.refresh']);
const VENUE_KEYS = new Set(['venue', 'routes', 'swaps', 'lat', 'lon', 'pts', 'aAt', 'bAt', 'resolved']);
const CANDIDATE_ID_RE = /^cand:[0-9a-f-]{36}$/;
const RESULT_ID_RE = /^res:[0-9a-f-]{36}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;

function carriesVenueData(v, depth = 0) {
  if (depth > 4 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(x => carriesVenueData(x, depth + 1));
  return Object.keys(v).some(k => VENUE_KEYS.has(k) || carriesVenueData(v[k], depth + 1));
}

// 015: shape checks of the opened powers (types, enums, caps ≤ the planner's).
function godProblem(action) {
  const e = GOD_ENUMS[action.kind];
  if (e && !e[1].includes(action[e[0]])) return `bad_${e[0]}`;
  const idField = GOD_IDS[action.kind];
  if (idField && !ID_FIELD(action[idField])) return `bad_${idField}`;
  if (action.kind === 'decision.pick' && (typeof action.optionId !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(action.optionId))) return 'bad_optionId';
  if ((action.kind === 'cast.depart' || action.kind === 'cast.return') && (typeof action.castId !== 'string' || !CAST_ID_RE.test(action.castId))) return 'bad_castId';
  if (action.kind === 'money' && (!Number.isFinite(action.amount) || Math.abs(action.amount) > 1e9)) return 'bad_amount';
  if (action.kind === 'career') {
    for (const [k, cap] of [['title', 60], ['employerName', 80]]) {
      if (action[k] !== undefined && action[k] !== null && (typeof action[k] !== 'string' || action[k].length > cap)) return `bad_${k}`;
    }
    if (action.salary !== undefined && action.salary !== null && (!Number.isFinite(action.salary) || action.salary < 0 || action.salary > 1e9)) return 'bad_salary';
  }
  if (action.kind === 'mood') {
    if (action.wakeDay !== undefined && action.wakeDay !== null && (!Number.isInteger(action.wakeDay) || action.wakeDay < 0 || action.wakeDay > 13)) return 'bad_wakeDay';
    if ((action.preset === undefined || action.preset === null) && (!action.delta || typeof action.delta !== 'object' || Array.isArray(action.delta))) return 'bad_delta';
  }
  if (action.kind === 'health' && action.days !== undefined && action.days !== null && (!Number.isInteger(action.days) || action.days < 1 || action.days > 14)) return 'bad_days';
  if (action.kind === 'home' && (action.near === undefined || action.near === null) === (action.area === undefined || action.area === null)) return 'bad_home';
  return null;
}

// ── 016 scenes: the tone hint ({kind:'scene.tone', decisionId, tone, outcome}; `outcome` takes an optional tone) ──
export const SCENE_TONE_MAX = 120;
const SCENE_TONE_OUTCOMES = new Set(['well', 'fine', 'flat', 'badly']);
function sceneToneProblem(action) {
  const given = action.tone !== undefined && action.tone !== null;
  if (action.kind === 'scene.tone') {
    if (!ID_FIELD(action.decisionId)) return 'bad_decisionId';
    if (!given) return 'bad_tone';
  }
  if (given && (action.kind === 'scene.tone' || action.kind === 'outcome')) {
    if (typeof action.tone !== 'string' || !action.tone.trim() || action.tone.length > SCENE_TONE_MAX) return 'bad_tone';
  }
  // R23: the hint's outcome word is required (it sets the scene's outcome).
  if (action.kind === 'scene.tone' && !SCENE_TONE_OUTCOMES.has(action.outcome)) return 'bad_outcome';
  return null;
}

// ── 015 cont: bundle / retcon shapes ───────────────────────────────────────

export const BUNDLE_MAX = 5;
export const BUNDLE_EXCLUDED = new Set(['bundle', 'rewind', 'retcon', 'tray.adopt', 'proposal.approve', 'bookmark', 'bookmark.remove']);
export const PART_SOURCES = new Set(['hand', 'code', 'continuity', 'prompt']);   // 017: a Tell-the-story bundle's parts

/** The first bad part of a bundle / retcon → { error, part } (part = its index), or null. */
export function partsProblem(action) {
  if (action.kind === 'retcon') {
    const to = action.to;
    if (!to || typeof to !== 'object' || Array.isArray(to)) return { error: 'bad_to', part: null };
    const keys = Object.keys(to);
    if (keys.length !== 1 || !['eventId', 'bookmarkId', 'at'].includes(keys[0]) || !ID_FIELD(to[keys[0]])) return { error: 'bad_to', part: null };
    if (action.reason !== undefined && (typeof action.reason !== 'string' || action.reason.length > 200)) return { error: 'bad_reason', part: null };
  }
  const list = action.actions;
  if (!Array.isArray(list) || !list.length || list.length > BUNDLE_MAX) return { error: 'bad_actions', part: null };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || typeof a !== 'object' || Array.isArray(a) || BUNDLE_EXCLUDED.has(a.kind)) return { error: 'bad_kind', part: i };
    if (a.source !== undefined && !PART_SOURCES.has(a.source)) return { error: 'bad_source', part: i };
    const { source, ...rest } = a;
    const p = actionProblem(rest);
    if (p) return { error: p, part: i };
  }
  return null;
}

function bookmarksOf(story) {
  if (story && typeof story.bookmarks === 'function') {
    try { const b = story.bookmarks(); if (Array.isArray(b)) return b; } catch { /* fall through to the projection */ }
  }
  let s = null;
  try { s = life.getState(); } catch { s = null; }
  const list = Array.isArray(s?.story?.bookmarks) ? s.story.bookmarks : [];
  const now = Number.isFinite(s?.viewAt) ? s.viewAt : Math.floor(Date.now() / 1000);
  const days = Number.isFinite(config.arcs?.rewindDays) ? config.arcs.rewindDays : 14;
  const excluded = s?.excluded instanceof Set ? s.excluded : new Set();
  return list.map((b) => {
    let at = Number.isFinite(b.at) ? b.at : null;
    try { const ev = getEvent(b.eventId); if (Number.isFinite(ev?.at)) at = ev.at; } catch { /* keep the bookmark time */ }
    return {
      id: b.id, name: b.name, eventId: b.eventId, at,
      inWindow: Number.isFinite(at) && at >= now - days * 86400 && !excluded.has(b.eventId),
    };
  });
}

// 014 sched: what a schedule apply's audit records (kinds, dates, counts, ids — never labels).
function scheduleAuditOf(action, res) {
  if (action?.kind === 'schedule') {
    const acts = [...(action.background?.activity ? [action.background.activity] : []), ...(Array.isArray(action.ranges) ? action.ranges.map(r => r.activity) : [])]
      .filter(a => SCHEDULE_BACKGROUNDS.has(a) || SCHEDULE_ACTIVITIES.has(a)).slice(0, 4);
    const date = typeof res?.extra?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(res.extra.date) ? res.extra.date : null;
    return { activities: acts, date, conflicts: Array.isArray(res?.extra?.conflicts) ? res.extra.conflicts.length : 0,
      ...(action.op && action.op !== 'set' ? { op: action.op } : {}) };
  }
  if (action?.kind === 'schedule.clear') return { overrideId: ID_FIELD(action.overrideId) ? action.overrideId : null };
  return null;
}

export default async function directorRoutes(app) {
  // 014 sched: the active schedule overrides (read-only; ids, dates, activities, times).
  app.get('/api/director/schedule', async () => {
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, overrides: [] };
    try {
      const v = life.scheduleView();
      return { enabled: true, ...v };
    } catch {
      return { enabled: true, running: false, overrides: [] };
    }
  });

  // 015: the PLAY GOD panel's read (operator view; 409-free: off → {enabled:false}).
  app.get('/api/director/god', async () => {
    const c = await storyContext();
    if (!c.enabled || typeof c.story?.godView !== 'function') return { enabled: false };
    try { return c.story.godView(); } catch { return { enabled: false }; }
  });

  app.get('/api/director/bookmarks', async () => {
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, bookmarks: [] };
    return { enabled: true, running: true, bookmarks: bookmarksOf(c.story) };
  });

  // Spec 011: words → drafts. A POST under readOnlyGuard + csrfGuard; one model
  // call; nothing written. Audited (lengths, counts, status) once the model ran:
  // a pre-call refusal or a skipped run (budget, disabled, no key) is not.
  app.post('/api/director/prompt', { config: PROMPT }, async (req, reply) => {
    const wish = req.body?.wish;
    if (typeof wish !== 'string' || !wish.trim()) return reply.code(400).send({ error: 'bad_wish' });
    if (wish.length > WISH_MAX) return reply.code(400).send({ error: 'too_long' });
    const problem = bodyProblem(wish);
    if (problem) return reply.code(400).send({ error: problem });
    const story = await writeGate(reply);
    if (!story) return reply;
    if (typeof story.director?.prompt !== 'function') return reply.code(409).send({ error: 'unsupported' });
    const actor = actorOf(req);
    let res;
    try {
      res = await story.director.prompt(wish, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'director.prompt');
    }
    const status = PROMPT_STATUSES.has(res?.status) ? res.status : 'model_failed';
    const drafts = [];
    let mainShapeDrop = false;
    const dropped = (Array.isArray(res?.dropped) ? res.dropped : []).slice(0, 16).map(x => ({
      index: Number.isSafeInteger(x?.index) ? x.index : null,
      kind: typeof x?.kind === 'string' && ACTION_KINDS.has(x.kind) ? x.kind : null,
      reason: SLUG.test(x?.reason ?? '') ? x.reason : 'bad_field',
    }));
    for (const d of Array.isArray(res?.drafts) ? res.drafts.slice(0, 6) : []) {
      // The same shape check as a hand-built action (route_shape when it fails).
      const p = actionProblem(d?.action);
      if (p) {
        dropped.push({ index: Number.isSafeInteger(d?.index) ? d.index : null, kind: ACTION_KINDS.has(d?.action?.kind) ? d.action.kind : null, reason: 'route_shape' });
        if (d?.side !== true) mainShapeDrop = true;
        continue;
      }
      drafts.push(cleanDraft(d));
    }
    // No orphans (prompt.js holdSideDrafts): a main draft dropped here holds the side drafts too.
    if (mainShapeDrop) for (const d of drafts) if (d.side) { d.batchable = false; d.reviewReason = 'depends_on_main'; }
    const cantDo = (Array.isArray(res?.cantDo) ? res.cantDo : []).filter(x => typeof x === 'string').slice(0, 4).map(x => x.slice(0, 120));
    if (status !== 'skipped') auditWrite(actor, 'director.prompt', null, {
      status, length: wish.length, drafts: drafts.length, dropped: dropped.length, cantDo: cantDo.length, fellBack: !!res?.fellBack,
      ...(Number.isSafeInteger(res?.venueLookups) ? { venueLookups: res.venueLookups } : {}),   // 014 geo
      ...(dropped.length ? { drops: dropped.map(x => ({ index: x.index, kind: x.kind, reason: x.reason })) } : {}),   // codes only
    });
    // 017: the plan in one line (code-built; null once the route dropped a draft — the page joins the
    // kept drafts' phrases instead) and the default apply plan, limited to the drafts sent.
    const kept = new Set(drafts.map(d => d.index).filter(Number.isSafeInteger));
    const ints = (xs) => (Array.isArray(xs) ? xs.filter(i => Number.isSafeInteger(i) && kept.has(i)) : []);
    const bp = res?.bundlePlan && typeof res.bundlePlan === 'object' ? res.bundlePlan : null;
    const bundlePlan = bp ? {
      bundles: (Array.isArray(bp.bundles) ? bp.bundles : []).map(b => ints(b).slice(0, BUNDLE_MAX)).filter(b => b.length).slice(0, 6),
      after: ints(bp.after), waiting: ints(bp.waiting),
    } : null;
    const planLine = !mainShapeDrop && drafts.length === (Array.isArray(res?.drafts) ? res.drafts.length : 0) && typeof res?.planLine === 'string'
      ? res.planLine.slice(0, 240) : null;
    const body = {
      status, ...(SLUG.test(res?.reason ?? '') ? { reason: res.reason } : {}),
      planLine, ...(bundlePlan ? { bundlePlan } : {}),
      drafts, dropped, cantDo, model: typeof res?.model === 'string' ? res.model.slice(0, 80) : null, fellBack: !!res?.fellBack,
      usage: { today: Number.isSafeInteger(res?.usage?.today) ? res.usage.today : null, cap: Number.isSafeInteger(res?.usage?.cap) ? res.usage.cap : null },
    };
    if (status !== 'ok') return reply.code(409).send({ ...body, error: status });
    return body;
  });

  // A POST: 403 in read-only, CSRF-checked in write mode. Writes nothing.
  app.post('/api/director/preview', { config: PREVIEW }, async (req, reply) => {
    const action = req.body?.action;
    const problem = actionProblem(action);
    if (problem) return reply.code(400).send({ error: problem, ...partOf(action) });
    const source = req.body?.source;
    if (source !== undefined && source !== null && !SOURCES.has(source)) return reply.code(400).send({ error: 'bad_source' });
    const story = await writeGate(reply);
    if (!story) return reply;
    let res;
    try {
      res = await story.director.preview(action, { source: source ?? null });
    } catch (err) {
      return sendStoryError(reply, err, 'director.preview');
    }
    rememberKind(res?.previewId, action.kind, source ?? null, scheduleAuditOf(action, res));   // 014 sched: audit details
    return res;
  });

  app.post('/api/director/preview-tomorrow', { config: TOMORROW }, async (req, reply) => {
    const story = await writeGate(reply);
    if (!story) return reply;
    try {
      return await story.director.previewTomorrow();
    } catch (err) {
      return sendStoryError(reply, err, 'director.tomorrow');
    }
  });

  // 015 cont: the continuity story read of a preview — a POST under readOnlyGuard +
  // csrfGuard; at most one mind call (cached per preview fingerprint); drafts only,
  // nothing written. Audited (status and counts only) when the model ran.
  app.post('/api/director/continuity', { config: CONTINUITY }, async (req, reply) => {
    const previewId = req.body?.previewId;
    if (typeof previewId !== 'string' || !PREVIEW_ID_RE.test(previewId)) return reply.code(400).send({ error: 'bad previewId' });
    const story = await writeGate(reply);
    if (!story) return reply;
    if (typeof story.director?.continuity !== 'function') return reply.code(409).send({ error: 'unsupported' });
    const actor = actorOf(req);
    let res;
    try {
      res = await story.director.continuity(previewId, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'director.continuity');
    }
    return continuityReply(res, actor);
  });

  app.post('/api/director/apply', { config: WRITE }, async (req, reply) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { previewId, fingerprint } = body;
    if (typeof previewId !== 'string' || !PREVIEW_ID_RE.test(previewId)) return reply.code(400).send({ error: 'bad previewId' });
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return reply.code(400).send({ error: 'bad fingerprint' });
    const story = await writeGate(reply);
    if (!story) return reply;
    const actor = actorOf(req);
    let res;
    try {
      res = await story.director.apply(previewId, fingerprint, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'director.apply');
    }
    const remembered = takeKind(previewId);
    const kind = (typeof res?.kind === 'string' && ACTION_KINDS.has(res.kind) ? res.kind : null) ?? remembered.kind ?? 'apply';
    const eventIds = Array.isArray(res?.eventIds) ? res.eventIds.filter(Number.isSafeInteger) : [];
    auditWrite(actor, `director.${kind}`, res?.actionEventId != null ? String(res.actionEventId) : null, {
      fingerprint, actionEventId: res?.actionEventId ?? null, eventIds: eventIds.slice(0, AUDIT_IDS_MAX), count: eventIds.length,
      ...(remembered.source ? { source: remembered.source } : {}),
      ...(remembered.extra ? remembered.extra : {}),   // 014 sched: activities / date / conflicts count / override id
      ...auditContinuity(res),
    });
    return { ok: true, actionEventId: res?.actionEventId ?? null, eventIds };
  });

  // 015 REVERT THIS CHANGE (owner decision 6): one Director change undone as a
  // whole. Without a fingerprint → the preview (what would be reverted, what
  // refuses); with the preview's fingerprint → the revert, audited as
  // director.revert_change with ids only. Both POSTs: readonly 403 + CSRF.
  app.post('/api/director/revert-change', { config: WRITE }, async (req, reply) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const actionEventId = body.actionEventId;
    if (!ID_FIELD(actionEventId)) return reply.code(400).send({ error: 'bad_actionEventId' });
    const fingerprint = body.fingerprint;
    if (fingerprint !== undefined && fingerprint !== null && (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint))) {
      return reply.code(400).send({ error: 'bad fingerprint' });
    }
    // 017: group:true = every change of the apply it was part of (UNDO ALL OF THIS).
    if (body.group !== undefined && typeof body.group !== 'boolean') return reply.code(400).send({ error: 'bad_group' });
    const group = body.group === true;
    const story = await writeGate(reply);
    if (!story) return reply;
    const ev = getEvent(actionEventId);
    if (!ev || ev.type !== 'director.action') return reply.code(404).send({ error: 'not_found' });
    if (fingerprint === undefined || fingerprint === null) {
      try {
        const p = life.revertChangePreview(actionEventId, { group });
        return { preview: true, ...p };
      } catch (err) {
        return reply.code(err?.code === 'not_found' ? 404 : 409).send({ error: SLUG.test(err?.code ?? '') ? err.code : 'refused' });
      }
    }
    const actor = actorOf(req);
    let res;
    try {
      res = life.revertChange(actionEventId, { fingerprint, by: actor, group });
    } catch (err) {
      const code = SLUG.test(err?.code ?? '') ? err.code : 'refused';
      const refusals = (Array.isArray(err?.refusals) ? err.refusals : []).slice(0, 20)
        .map(x => ({ id: Number.isSafeInteger(x?.id) ? x.id : null, type: typeof x?.type === 'string' ? x.type.slice(0, 40) : null, reason: SLUG.test(x?.reason ?? '') ? x.reason : 'refused' }));
      return reply.code(code === 'not_found' ? 404 : 409).send({ error: code, ...(refusals.length ? { refusals } : {}) });
    }
    const reverted = Array.isArray(res?.reverted) ? res.reverted.filter(Number.isSafeInteger) : [];
    const actionEventIds = Array.isArray(res?.actionEventIds) ? res.actionEventIds.filter(Number.isSafeInteger).slice(0, BUNDLE_MAX) : null;
    auditWrite(actor, 'director.revert_change', String(actionEventId), {
      actionEventId, reverted: reverted.slice(0, AUDIT_IDS_MAX), count: reverted.length,
      ...(group ? { group: true, ...(actionEventIds ? { actionEventIds } : {}) } : {}),
    });
    return { ok: true, actionEventId, reverted, ...(group && actionEventIds ? { group: true, actionEventIds } : {}) };
  });
}

// ── 015 cont: route helpers ────────────────────────────────────────────────

function partOf(action) {
  if (action?.kind !== 'bundle' && action?.kind !== 'retcon') return {};
  const pp = partsProblem(action);
  return Number.isInteger(pp?.part) ? { part: pp.part } : {};
}

/** The apply audit's 015 fields: overridden continuity codes, a batch's parts (kind + source), a retcon's target. */
function auditContinuity(res) {
  const out = {};
  const codes = (Array.isArray(res?.continuity) ? res.continuity : []).filter(c => typeof c === 'string' && SLUG.test(c)).slice(0, 16);
  if (codes.length) out.continuity = codes;
  if (Array.isArray(res?.parts)) {
    out.parts = res.parts.slice(0, BUNDLE_MAX).map(p => ({
      kind: ACTION_KINDS.has(p?.kind) ? p.kind : null, source: PART_SOURCES.has(p?.source) ? p.source : 'hand',
    }));
  }
  if (Number.isSafeInteger(res?.toEventId)) out.toEventId = res.toEventId;
  if (Number.isSafeInteger(res?.cancelled)) out.cancelled = res.cancelled;
  return out;
}

const CONTINUITY_STATUSES = new Set(['ok', 'invalid_output', 'model_failed', 'skipped', 'refused']);
const SEVERITIES = new Set(['info', 'warn', 'high']);
const ABOUT = new Set(['time', 'people', 'job', 'relationship', 'money', 'family', 'tone', 'other']);

// The facade's story-read result → the page's shape (codes, the model's short
// strings, suggestions re-checked like any hand-built action); audited when a
// model call ran, with counts only.
function continuityReply(res, actor) {
  const status = CONTINUITY_STATUSES.has(res?.status) ? res.status : 'model_failed';
  const warnings = (Array.isArray(res?.warnings) ? res.warnings : []).slice(0, 6)
    .filter(w => SEVERITIES.has(w?.severity) && typeof w?.text === 'string')
    .map(w => ({ severity: w.severity, about: ABOUT.has(w.about) ? w.about : 'other', text: w.text.slice(0, 160) }));
  const dropped = (Array.isArray(res?.dropped) ? res.dropped : []).slice(0, 16).map(x => ({
    part: x?.part === 'warning' ? 'warning' : 'suggestion', index: Number.isSafeInteger(x?.index) ? x.index : null,
    kind: typeof x?.kind === 'string' && ACTION_KINDS.has(x.kind) ? x.kind : null, reason: SLUG.test(x?.reason ?? '') ? x.reason : 'bad_field',
  }));
  const suggestions = [];
  for (const d of Array.isArray(res?.suggestions) ? res.suggestions.slice(0, 4) : []) {
    if (actionProblem(d?.action)) { dropped.push({ part: 'suggestion', index: Number.isSafeInteger(d?.index) ? d.index : null, kind: null, reason: 'route_shape' }); continue; }
    suggestions.push({ ...cleanDraft(d), source: 'continuity' });
  }
  if (res?.called === true) {
    auditWrite(actor, 'director.continuity', null, {
      status, warnings: warnings.length, suggestions: suggestions.length, dropped: dropped.length, fellBack: !!res?.fellBack,
    });
  }
  return {
    status, ...(SLUG.test(res?.reason ?? '') ? { reason: res.reason } : {}),
    warnings, suggestions, dropped, model: typeof res?.model === 'string' ? res.model.slice(0, 80) : null, fellBack: !!res?.fellBack,
    cached: res?.cached === true,
    usage: { today: Number.isSafeInteger(res?.usage?.today) ? res.usage.today : null, cap: Number.isSafeInteger(res?.usage?.cap) ? res.usage.cap : null },
  };
}
