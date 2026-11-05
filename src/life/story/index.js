// The story facade (spec 010, contracts/story-api.md §1). The ONLY module
// imported from outside src/life/story/: the life facade (src/life/index.js)
// and the dashboard routes (routes/arcs.js, routes/director.js).
//
// Lifecycle (life facade only):
//   registerHooks()   startLife(), before its enabled check: the DB-only
//                     forget/revoke/purge listeners (hooks.js), idempotent.
//   attach(rt)        every life boot, whatever the `arcs` skill says: wires the
//                     live projection, appender and world into the story
//                     modules and installs the innerState seams. Each installed
//                     seam and pulse dep checks storyOn() per call and returns
//                     009's default while `arcs` is off (research R5), except the
//                     state-derived worldOf and heavyGuardActive.
//   detach()          stopLife(): seams back to 009's defaults (hooks stay).
//   storyOn()         life running && the `arcs` skill && attached.
//
// Pulse items (items): the daily cast pass (with the career, family and heavy
// rolls inside it), consequences of committed arc decisions (each caused by
// the decision's own decision.opened), heavy onsets/ends, family calls and
// occasions, the job change, and (011) the owner's soft goals (goals.js: fit,
// defer, expire, done). Controls are checked when an item is OFFERED,
// never inside run(); every item appends; a throw retires its key (label + id,
// never the floating `at`) for this process. sim:true (preview tomorrow) → no store or model I/O.
//
// afterTick is ENQUEUE ONLY: the journal, tray expiry, withdrawals and the
// boot sweep run on the story's own serialized chain, never on the tick's.
// Withdrawals also run while the `arcs` skill is off (attached only).
//
// Logging: ids, counts, statuses and reason codes only.

import { config, getPersona } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { isSkillEnabled } from '../../skills/skillRunner.js';
import { getDb } from '../../memory/db.js';
import { now as clockNow, dateKey, dayStart, resolveTimezone, localParts, isRealClock } from '../clock.js';
import { rngFor as rngForDefault } from '../rng.js';
import { isExcludedId } from '../projector.js';
import { causeChain, getEvent, leanHistory, lastHeavyAt, lastEventId, listEvents, revertEvent, childEvents, directorGroup } from '../eventLog.js';
import { realPeopleNames } from '../world.js';
import { reopenAdoptedClaim } from '../claims.js';
import { ownerCommit, setStoryAsk, setTrustWeight, setUrgeBoost, arcJevUsedToday, arcBudgetPerDay, noteArcJevAttempt } from '../decisions.js';
import { askJev as askJevDefault } from '../../brain/jev.js';
import * as innerState from '../innerState.js';
import {
  CATEGORIES, worldOverlay, heavyGuardActive as heavyGuardActiveOf, overlayKey, overlayMemoKey,
} from './reducer.js';
import { check as controlsCheck, fateOf, pinOf, reconcilerModeOf, isPaused } from './controls.js';
import * as store from './store.js';
import * as castMod from './cast.js';
import * as romance from './romance.js';
import * as career from './career.js';
import * as family from './family.js';
import * as heavy from './heavy.js';
import * as reconciler from './reconciler.js';
import * as weekly from './weekly.js';
import * as journalMod from './journal.js';
import * as narrateMod from './narrate.js';
import * as hooks from './hooks.js';
import * as seedMod from './seed.js';
import * as directorMod from './director.js';
import * as changeText from './changeText.js';
import * as promptMod from './prompt.js';
import * as storyReadMod from './storyRead.js';
import * as continuityMod from './continuity.js';   // the revert preview's lived-outing line   // 015 cont: the continuity story read
import * as goalsMod from './goals.js';
import * as pendingMod from './pending.js';
import { simulate as simulateRun } from './tomorrow.js';
import { blockCause as planEditsBlockCause } from '../planEdits.js';   // 014 sched
import * as rewindMod from './rewind.js';
import * as fragmentMod from './fragment.js';
import { openArcDecision, cardsView } from './decisionsGlue.js';
import { validateExtraction } from './schema.js';
import { normalizeInviteExtraction } from './inviteDrift.js';
// 014 geo: the projected places' content key (worldOf memo).
import { placesKey, negativeAtVenue, venueNamesNow, placeLabel as placeLabelOf, isHomeKind } from '../places.js';
// 016 scene play-outs: only this facade imports scenes/*.
import * as sceneWorker from './scenes/worker.js';
import * as dreamWorker from './dreams/worker.js';   // 020 G
import * as dreamStore from './dreams/store.js';
import * as checkWorker from './check/worker.js';   // 020 E3
import { relWhen as relWhenWords } from './phone/facts.js';
import * as thoughtWorker from './thoughts/worker.js';   // 020 F3
import * as sceneStore from './scenes/store.js';
import * as sceneMemoryMod from './scenes/memory.js';
import { followupItems } from './scenes/effects.js';
import { validateEditedText, sceneTextCap, sceneParasCap, LONG_MINUTES } from './scenes/schema.js';
import { kindPhrase, FRIEND } from './scenes/facts.js';
import { firstMeetOf, isSceneSession as sceneIsSession } from './scenes/detect.js';
// 019 his phone: only this facade imports phone/*.
import * as phoneWorker from './phone/worker.js';
import * as phoneStore from './phone/store.js';
import { strongCue, promiseCue, promiseDayEnd } from './phone/plans.js';
import * as phoneMemoryMod from './phone/memory.js';
// 020 D2: only this facade imports standing/*.
import * as standingWorker from './standing/worker.js';
import { commitmentRows, commitmentLines } from '../commitments.js';
import { registerOf, urgeNow, urgeUtility, phonePrivate, contentProblem, sawInterest as sawInterestOf } from './desire.js';
export { contentProblem };   // 020 H2: the phrase banks' check on a line, unchanged
import { validateEditedText as validatePhoneEdit } from './phone/schema.js';

export { StoryError, TEXT_TONES } from './director.js';
export { openArcDecision, cardsView } from './decisionsGlue.js';

const HOUR = 3600;
const DAY = 86400;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function storyError(code, reason = null, extra = {}) {
  return new directorMod.StoryError(code, reason, extra);
}

// ── State ─────────────────────────────────────────────────────────────────

let att = null;               // { getState, append, world, pulse, revert, rebuild, isLifeOn }
let testDeps = {};            // __setDepsForTest: { now, callRole, askJev, rng, canUseIn, getUsageByCaller, mindBudgetOk, knownNames }
const failed = new Set();     // live item keys retired after a throw
const simFailed = new Set();  // the same for preview-tomorrow sims
let chain = Promise.resolve();
const pendingNights = new Set();
let swept = false;
let seedStarted = false;
let lastPruneDate = null;
let spendCache = { at: 0, usd: null };
let promptCache = { promptMonthUsd: null, promptToday: null };
let continuityCache = { continuityMonthUsd: null, continuityToday: null };   // 015 cont

const nowSec = () => Math.floor((testDeps.now ?? clockNow)());
const rngFor = (...a) => (testDeps.rng ?? rngForDefault)(...a);

/** Test seam (bootLife, tests): { now, callRole, askJev, rng, canUseIn, getUsageByCaller, mindBudgetOk } | null. */
export function __setDepsForTest(over) {
  testDeps = over === null ? {} : { ...testDeps, ...(isObj(over) ? over : {}) };
  if (att) wire();
}

function safe(fn, dflt) {
  try { return fn(); } catch { return dflt; }
}

/** True while life runs, the `arcs` skill is on and the story is attached. */
export function storyOn() {
  if (!att) return false;
  if (!safe(() => isSkillEnabled('arcs'), false)) return false;
  return safe(() => att.isLifeOn() === true, false);
}

/** Is the story wired to a running life engine (whatever the skill says)? */
export function isAttached() {
  return !!att;
}

function liveState() {
  return att ? safe(() => att.getState(), null) : null;
}

function tzOf(state) {
  return resolveTimezone(state?.world?.timezone ?? att?.world?.timezone ?? config.timezone);
}

// ── Hooks ─────────────────────────────────────────────────────────────────

/** The DB-only forget/revoke/purge listeners (idempotent; life running or not). */
export function registerHooks() {
  try { return hooks.registerHooks(); } catch { return false; }
}

/**
 * 015: the owner reverted world events (a timeline revert, REVERT THIS CHANGE),
 * called by the life facade once the reverts committed. A reverted claim.adopted
 * sends its review back to the tray (`returned`, reason owner — as a rewind does)
 * and its life_claims row back to 'flagged', so the tray shows it again and it
 * can be re-adopted; a reverted proposal.approve change closes its
 * proposal (applied → rejected 'reverted'). DB-only, best effort.
 * → { returned, proposals }
 */
export function onOwnerReverted({ events = [], action = null, by = 'owner' } = {}) {
  const who = String(by || 'owner').slice(0, 100);
  let returned = 0;
  let proposals = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    // 016: a reverted scene's row goes at once (the sweep catches cascades: a reverted outing, a rewind).
    if (ev?.type === 'scene.played') { try { sceneStore.markReverted(ev.id); } catch { /* the sweep retries */ } continue; }
    // 019: a reverted text's row goes at once (its replies cascade; the phone job's sweep catches them).
    if (ev?.type === 'phone.message') { try { phoneStore.markReverted(ev.id); } catch { /* the sweep retries */ } continue; }
    if (ev?.type !== 'claim.adopted' || !Number.isSafeInteger(ev.payload?.reviewId)) continue;
    try {
      const r = store.getReview(ev.payload.reviewId);
      if (r?.status === 'adopted' && r.adoptedEventId === ev.id
        && store.updateReview(r.id, { status: 'returned', reason: 'owner', decidedBy: who }, { fromStatus: 'adopted' })) {
        returned += 1;
        reopenAdoptedClaim(r.claimId);
      }
    } catch { /* best effort: the world side is already undone */ }
  }
  if (action?.payload?.kind === 'proposal.approve' && Number.isSafeInteger(action.payload?.proposalId)) {
    try { if (store.unapplyProposal(action.payload.proposalId, { by: who, at: nowSec() })) proposals += 1; } catch { /* best effort */ }
  }
  // 016 (D15, R26): a revert that took a scene out (directly or through an ancestor) undoes
  // its unlived companions at once; a reverted follow-up decision lapses its follow-up (the
  // scenes job is the backstop for rewinds and automatic reverts).
  try { sceneWorker.settleCompanions(); } catch (err) {
    logger.warn({ evt: 'issue', where: 'arcs.scenes.companions', err: err?.name || 'Error' }, 'story: scene companions not settled');
  }
  return { returned, proposals };
}

/** 009 purge (inside purgePerson's transaction): DB-only, works detached; errors propagate. */
export function onRedacted(jids) {
  const res = hooks.onRedacted(jids);
  // 016: scenes about that person (a real-person outing) go with them; errors propagate (roll the purge back).
  sceneStore.deleteBySubject(Array.isArray(jids) ? jids : [jids]);
  return res;
}

// ── World + guard (state-derived, never skill-gated) ──────────────────────

let overlayMemo = { world: null, key: null, value: null };

/** The world as of the projection (job change overlay, R9). Memoized per career state. */
export function worldOf(state, world = att?.world ?? null) {
  if (!isObj(world)) return world;
  // 014 geo (R27): the projected places' content key joins the memo key.
  const pk = placesKey(state, world);
  // 015: a career, home or departure event (overlayKey), not only a career one.
  if (overlayKey(state) === null && !pk) return world;
  const key = `${overlayMemoKey(state)}|${pk}`;
  if (overlayMemo.world === world && overlayMemo.key === key) return overlayMemo.value;
  const value = worldOverlay(state, world);
  overlayMemo = { world, key, value };
  return value;
}

/**
 * 014 geo: is a place-search query fine to send to a third party? The
 * Director's wish checks (JID / phone / real name, cast first names exempt).
 * → null | 'jid_in_text' | 'real_person_name' | 'too_long' | 'bad_wish' | 'names_unavailable'.
 */
export function queryProblem(q) {
  if (typeof q !== 'string' || !q.trim() || q.length > 80) return 'bad_wish';
  return textProblem(q);
}

/** A code when text names a real person or carries a JID or a number (≤ the wish cap, fictional names allowed). */
export function textProblem(q) {
  let names;
  try { names = realPeopleNames(); } catch { return 'names_unavailable'; }
  const s = att ? safe(att.getState, null) : null;
  const castNames = [...(s?.cast instanceof Map ? s.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  return promptMod.wishProblem(q, names, castNames);
}

/** The heavy guard (R17): true for the whole active heavy arc. */
export function heavyGuardActive(state, now) {
  try { return heavyGuardActiveOf(state, now) === true; } catch { return false; }
}

// ── Pulse seams (skill-gated per call) ────────────────────────────────────

/**
 * 015 pulse seam (deps.atWake): between the wake checkpoint and the morning
 * plan, the owner's planned wake nudges due today ("wakes up exhausted").
 * Skill-gated like items(); sim:true (preview / Day projection) always runs.
 */
/** 020 G: the wake's dream. Live only (no sim passes this to its pulse). → the event | null */
export function atDream(state, o) {
  if (!att || !storyOn() || o?.firstNight === true) return null;
  return dreamWorker.atDream(state, o);
}

/** One line about this morning's dream, or ''. */
export function dreamLine(state, at, opts) {
  if (!att || !storyOn()) return '';
  return dreamWorker.dreamLine(state, at, opts);
}

/**
 * Plan 020 B, free topics: what he came across in his own days, for the mind's night call. His outings' talking points and his texts, of his own or the owner's origin, no real
 * person, nothing heavy or from around a stretch, nothing explicit. Never a chat. → [{ kind: 'scene'|'text', eventId, at, text }]
 */
export function stanceEncounters({ from, to } = {}) {
  const s = att ? liveState() : null;
  if (!s) return [];
  const own = (e) => !e.redacted && e.heavy !== true && !isExcludedId(s, e.id) && (e.originKind === 'self' || e.originKind === 'owner') && !e.subjectJid
    && e.payload?.heavyWindow !== true && e.payload?.heat !== 'explicit' && e.payload?.heat !== 'suggestive'
    && !sceneWorker.heavyAtSession(s, { startAt: e.at }) && !sceneWorker.inHeavyWindow(s, { startAt: e.at })
    && !causeChain(e.id).some(x => x?.heavy === true || x?.type === 'heavy.started');
  const out = [];
  const scenes = listEvents({ types: ['scene.played'], from, to, limit: 50 }).filter(own).filter(e => e.payload?.mode === 'full');
  for (const r of publicScenes(scenes.map(e => e.id))) {
    const e = scenes.find(x => x.id === r.eventId);
    const words = [r.highlight, ...(Array.isArray(r.topics) ? r.topics : [])].filter(x => typeof x === 'string' && x).join('; ');
    if (e && words && !contentProblem(words)) out.push({ kind: 'scene', eventId: e.id, at: e.at, text: words });
  }
  const texts = listEvents({ types: ['phone.message'], from, to, limit: 200 }).filter(own);
  const words = publicPhone(texts.map(e => e.id));
  for (const e of texts) {
    const t = words.get(e.id);
    if (typeof t === 'string' && !contentProblem(t)) out.push({ kind: 'text', eventId: e.id, at: e.at, text: t });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Anything the desire check flags, on top of the name check. */
export function stanceTextProblem(text) {
  if (contentProblem(text)) return 'content';
  return textProblem(text);
}

/** The site's dreams: live words outside a heavy window. */
export function publicDreams(eventIds) {
  const s = att ? liveState() : null;
  if (!s) return new Map();
  try { return dreamWorker.publicDreams(s, eventIds); } catch { return new Map(); }
}

/** The Mind page's dreams. */
export function dreamsView(opts) {
  return dreamWorker.dreamsView(opts);
}

export function atWake(state, at, add, { sim = false } = {}) {
  if (!sim && !storyOn()) return 0;
  return pendingMod.wakeNudges(state, at, add, { world: att?.world ?? null });
}

/** Cause of a plan block's events: an outing's blocks descend from the amended plan, the rest from the base plan (R4). */
export function blockCause(plan, block) {
  // 014 sched (R29): a block that carries its own cause (a chat outing kept through
  // a re-plan) or an override's block, and every block of a schedule re-plan, use
  // planEdits.blockCause whether the story is on or not.
  if (block?.causeEventId || block?.fromOverride || Array.isArray(plan?.overrides)) return planEditsBlockCause(plan, block);
  if (!storyOn()) return plan?.eventId;
  return planEditsBlockCause(plan, block);
}

/** Cause of work.late, sleep.started and the evening invitation: the base plan (R4). */
export function planCause(plan) {
  if (!storyOn()) return plan?.eventId;
  return plan?.basePlanEventId ?? plan?.eventId;
}

// The seed in force, with the owner's overlay; memoized per overlay object.
let seedMemo = { base: null, overlay: null, value: null };
function seedFor(state) {
  const base = safe(() => seedMod.getArcSeed(), null);
  const overlay = state?.story?.seedOverlay ?? null;
  if (seedMemo.base === base && seedMemo.overlay === overlay && seedMemo.value) return seedMemo.value;
  const value = safe(() => seedMod.effectiveSeed(state, base), base);
  seedMemo = { base, overlay, value };
  return value;
}

// Real people's names (the name-collision checks); one DB read per few minutes, not per pulse step.
let namesMemo = { at: 0, value: [] };
function knownNames() {
  const t = Date.now();
  if (t - namesMemo.at > 5 * 60_000) namesMemo = { at: t, value: safe(() => realPeopleNames(), []) };
  return namesMemo.value;
}

function themeLabelOf(themeId) {
  if (typeof themeId !== 'string') return null;
  const seed = seedFor(liveState());
  const pools = [
    ...(Array.isArray(seed?.heavy?.themes) ? seed.heavy.themes : []),
    ...(Array.isArray(seed?.family?.themes) ? seed.family.themes : []),
  ];
  const t = pools.find(x => isObj(x) && x.id === themeId);
  return typeof t?.label === 'string' ? t.label.slice(0, 80) : null;
}

// career.appraise's Jev (research R9, caller life.arc.appraisal): the real client
// (or the test seam's), counted against ARCS_JEV_MAX_PER_DAY like an arc lean.
// A spent cap throws, so appraise takes its code fallback ('budget'); a client
// error or 007's BudgetError does the same ('jev_error' / 'jev_budget').
function appraisalJev(req) {
  const s = liveState();
  const at = finite(s?.at) ? s.at : nowSec();
  const tz = tzOf(s);
  if (arcJevUsedToday(s, at, tz) >= arcBudgetPerDay()) throw Object.assign(new Error('arc Jev cap'), { code: 'jev_cap' });
  noteArcJevAttempt(at, tz);
  return (testDeps.askJev ?? askJevDefault)(req);
}

function itemDeps(s, world, seed, sim, refusals, simGetState = null) {
  const refuse = (row) => {
    if (sim) { if (Array.isArray(refusals) && refusals.length < 50) refusals.push({ reason: row?.reason ?? 'refused', target: row?.target ?? null }); return; }
    try { store.recordRefusal(row); } catch { /* an operational log only */ }
  };
  // A sim item re-reads the sim pulse's state at run time (what it appended so far,
  // e.g. a change.applied before its re-plan), as a live one re-reads the live state;
  // the listing snapshot only when the sim gave no reader.
  const getState = sim
    ? (typeof simGetState === 'function' ? () => { try { return simGetState() ?? s; } catch { return s; } } : () => s)
    : () => liveState() ?? s;
  const openDecision = (stateOrGetter, spec, ctx) => openArcDecision(stateOrGetter, spec, { ...ctx, onRefused: refuse });
  return {
    world, seed, sim, getState, openDecision, refuse, recordRefusal: refuse, rngFor,
    cfg: config.arcs, knownNames: knownNames(), askJev: sim ? null : appraisalJev,
    lastHeavyAt: () => lastHeavyAt(),
    nominated: sim ? null : safe(() => weekly.nominatedTheme(), null),
    getEvent: (id) => getEvent(id),
  };
}

function expireItem(d, at, reason) {
  return {
    at, prio: 8, label: 'arc:refused', id: d.id,
    run: (add) => { add({ type: 'decision.expired', at, actor: 'engine', causeId: d.id, payload: { decisionId: d.id, reason } }); },
  };
}

function romanceItems(s, g) {
  const out = [];
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    if (d?.status !== 'committed' || d.category !== 'romance') continue;
    const c = safe(() => romance.consequence(d, d.committed, s), null);
    if (!c || !Array.isArray(c.events) || !c.events.length) continue;
    const at = Math.max(c.at, finite(s.at) ? s.at : c.at);
    if (at > g) continue;
    const v = controlsCheck({ source: 'engine', category: c.category, action: c.action, pinKeys: c.pinKeys }, s);
    if (!v.ok) { out.push(expireItem(d, at, v.reason === 'pinned' ? 'pinned' : 'frozen')); continue; }
    out.push({
      at, prio: 8, label: 'romance:consequence', id: d.id,
      run: (add) => { for (const ev of c.events) add({ ...ev, at }); },
    });
  }
  return out;
}

// Open arc decisions of a frozen category (the Director expires them at freeze
// time; this catches anything opened in between): the terminal expiry.
function frozenItems(s, g) {
  const out = [];
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    if (d?.status !== 'open' || d.adopted === true || !CATEGORIES.includes(d.category)) continue;
    if (fateOf(d.category, s) !== 'frozen') continue;
    const at = finite(s.at) ? s.at : g;
    if (at > g) continue;
    out.push(expireItem(d, at, 'frozen'));
  }
  return out;
}

/**
 * Story due items for the pulse (story-api §1, R7). sim:true → preview tomorrow
 * (no store/model I/O, its own failed set; refusals in opts.refusals).
 */
export function items(state, g, { sim = false, refusals = null, getState = null } = {}) {
  const s = state;
  if (!sim && !storyOn()) return [];
  if (!s?.story || s.genesisAt === null || s.genesisAt === undefined || !finite(g)) return [];
  const world = worldOf(s, att?.world ?? null);
  if (!world) return [];
  const seed = seedFor(s);
  const d = itemDeps(s, world, seed, sim, refusals, sim ? getState : null);
  const list = [];
  const collect = (name, fn) => {
    try {
      const got = fn();
      if (Array.isArray(got)) list.push(...got.filter(Boolean));
    } catch (err) {
      logger.warn({ evt: 'issue', where: `arcs.items.${name}`, err: err?.name || 'Error' }, 'story: item planning failed');
    }
  };
  collect('cast', () => castMod.dailyItems(s, g, world, seed, {
    getState: d.getState, openDecision: d.openDecision, recordRefusal: d.recordRefusal, rngFor, sim,
    rolls: {
      career: (args) => career.dailyRoll(args, d),
      family: (args) => family.dailyRoll(args, d),
      heavy: (args) => heavy.dailyRoll(args, d),
    },
  }));
  collect('romance', () => romanceItems(s, g));
  collect('career', () => career.huntItems(s, g, d));
  collect('family', () => family.familyItems(s, g, seed, d));
  collect('heavy', () => heavy.heavyItems(s, g, d));
  collect('frozen', () => frozenItems(s, g));
  collect('goals', () => goalsMod.goalItems(s, g, d));   // 011: the owner's soft goals (pure; sim-safe)
  collect('followups', () => followupItems(s, g, d));      // 016: a scene's follow-up meet (pure; sim-safe)
  // 015: the owner's scheduled changes, outcomes and the overlay drift re-plan (pure; sim-safe).
  const god = { ...d, worldOf: (st) => worldOf(st, att?.world ?? null) ?? world };
  collect('pending', () => pendingMod.pendingItems(s, g, god));
  collect('outcomes', () => pendingMod.outcomeItems(s, g, god));
  collect('overlay', () => pendingMod.overlayDriftItems(s, g, god));

  const retired = sim ? simFailed : failed;
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (!isObj(it) || typeof it.run !== 'function' || !finite(it.at) || it.at > g) continue;
    const label = typeof it.label === 'string' && it.label ? it.label.slice(0, 48) : 'story';
    // A stable key (label + id, or the item's own key), never `at`: several items
    // date themselves max(…, s.at), which moves with every tick, so an `at` key
    // would let a retired item (or a half-applied daily pass) come back.
    const key = typeof it.key === 'string' && it.key ? it.key.slice(0, 96)
      : `${label}|${it.id !== undefined && it.id !== null ? it.id : `@${it.at}`}`;
    if (retired.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      at: it.at, prio: finite(it.prio) ? it.prio : 9, label, id: it.id ?? null, key,
      run: async (add) => {
        // All-or-nothing: an item that fails part-way (an append refused, a roll
        // throwing after it wrote) has what it appended reverted, then retires.
        const wrote = [];
        const record = (spec) => {
          const ev = add(spec);
          if (Number.isSafeInteger(ev?.id)) wrote.push(ev);
          return ev;
        };
        try {
          await it.run(sim ? add : record);
        } catch (err) {
          retired.add(key);
          const undone = undoItem(wrote);
          logger.warn({ evt: 'issue', where: 'arcs.item', item: label, id: it.id ?? null, err: err?.name || 'Error', undone }, 'story: item failed; undone and retired');
        }
      },
    });
  }
  return out;
}

// Revert what a failed item appended. The item's events are awaited across
// model calls (an opened decision's lean, the appraisal), so one SQLite
// transaction can't hold them; a revert is the log's own undo (the reconciler's
// adopt does the same). Only the roots: a revert cascades to engine/jev events
// caused by its target (eventLog.cascadeIds), the embargo follow-ups of a heavy
// append included. One rebuild at the end. → how many roots were reverted.
function undoItem(wrote) {
  if (!wrote.length) return 0;
  const ids = new Set(wrote.map(e => e.id));
  const cascades = (e) => ids.has(e.causeId) && (e.actor === 'engine' || e.actor === 'jev');
  let n = 0;
  for (const e of [...wrote].reverse()) {
    if (cascades(e)) continue;
    try {
      revertEvent(e.id, { reason: 'story_item_failed', by: 'system', at: nowSec() });
      n++;
    } catch (err) {
      logger.warn({ evt: 'issue', where: 'arcs.item.undo', eventId: e.id, err: err?.name || 'Error' }, 'story: undo revert failed');
    }
  }
  try { att?.rebuild?.(); } catch { /* the next tick re-reads */ }
  return n;
}

// ── afterTick (enqueue only) ──────────────────────────────────────────────

function enqueue(name, fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, (err) => {
    logger.warn({ evt: 'issue', where: `arcs.job.${name}`, err: err?.name || 'Error' }, 'story: background job failed');
  });
  return run;
}

/** Test seam: rebuild the live projection from the log (events appended outside the facade). */
/** Test seam: the live projection itself (not the facade's view). */
export const __rawStateForTest = () => att?.getState?.() ?? null;

export function __rebuildForTest() {
  try { att?.rebuild?.(); } catch { /* the next tick re-reads */ }
}

/** Wait for the story's background jobs (tests, stop). */
export function idle() {
  return chain;
}

function startSeed() {
  if (seedStarted) return;
  seedStarted = true;
  // A test seed (bootLife) or arcs.json in place → nothing to generate.
  if (safe(() => seedMod.getArcSeed()?.source, null) === 'test') return;
  enqueue('seed', () => seedMod.ensureArcSeed({
    world: att?.world ?? undefined,
    ...(testDeps.callRole ? { callRole: testDeps.callRole } : {}),
    ...((testDeps.mindBudgetOk ?? att?.mindBudgetOk) ? { mindBudgetOk: testDeps.mindBudgetOk ?? att.mindBudgetOk } : {}),
    ...(testDeps.getUsageByCaller ? { getUsageByCaller: testDeps.getUsageByCaller } : {}),
  }).then((r) => { logger.info({ evt: 'arcs_seed', status: r?.status ?? null, reason: r?.reason ?? null }, 'story: arc seed'); }));
}

/**
 * After each pulse tick (life facade afterTick, before the subscribers).
 * Decides what is due and queues it; never awaits a model call.
 */
let withdrawQueued = false;
let scenesQueued = false;
let scenesAgain = false;   // 020 C4: a kick while one is queued runs once more after it

// 016: sweep (rows whose scene left the log), scan (new outings that ended), play out ≤ 3.
function sceneGone(s, id) {
  if (isExcludedId(s, id)) return true;
  const ev = getEvent(id);
  return !ev || ev.redacted === true;
}

// The sweep runs when the projection's exclusions changed (a revert, a rewind) and
// hourly (a redaction rewrites rows without touching the exclusion set).
let sweepMemo = { key: null, at: 0 };
function exclusionKey(s) {
  return `${s?.excluded instanceof Set ? s.excluded.size : 0}|${Array.isArray(s?.excludedRanges) ? s.excludedRanges.length : 0}`;
}

let scenesReset = false;   // the first scenes job after attach resets rows a crash left 'running'
async function scenesJob() {
  const s = liveState();
  if (!s) return;
  if (!scenesReset) {
    scenesReset = true;
    try { sceneWorker.resetInterrupted(); } catch (err) {
      logger.warn({ evt: 'issue', where: 'arcs.scenes.reset', err: err?.name || 'Error' }, 'story: interrupted scenes not reset');
    }
  }
  const key = exclusionKey(s);
  const t = nowSec();
  if (key !== sweepMemo.key || t - sweepMemo.at > HOUR) {
    sweepMemo = { key, at: t };
    try {
      sceneStore.sweep((id) => sceneGone(s, id));
      // Every version of an outing that left the log (superseded ones too, R9).
      sceneStore.sweepActivities((aid) => sceneGone(s, aid));
    } catch (err) {
      logger.warn({ evt: 'issue', where: 'arcs.scenes.sweep', err: err?.name || 'Error' }, 'story: scene sweep failed');
    }
  }
  // D15 backstop: unlived companions of scenes a rewind / an automatic revert took out.
  try {
    const lockedSettle = () => sceneWorker.settleCompanions();
    await (typeof att?.pulse?.exclusive === 'function' ? att.pulse.exclusive(lockedSettle) : lockedSettle());
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'arcs.scenes.companions', err: err?.name || 'Error' }, 'story: scene companions not settled');
  }
  sceneWorker.scan();
  const done = await sceneWorker.processPending();
  if (done.length || scenesCache.at === 0 || nowSec() - scenesCache.at > HOUR) await refreshScenesCache(s);
}

// 020 G: words that left the log go; a vivid dream's words.
let dreamsQueued = false;
let dreamSweepMemo = { key: null, at: 0 };
async function dreamsJob() {
  const s = liveState();
  if (!s) return;
  const key = exclusionKey(s);
  const t = nowSec();
  if (key !== dreamSweepMemo.key || t - dreamSweepMemo.at > HOUR) {
    dreamSweepMemo = { key, at: t };
    try { dreamWorker.sweep((id) => sceneGone(s, id)); } catch (err) {
      logger.warn({ evt: 'issue', where: 'arcs.dreams.sweep', err: err?.name || 'Error' }, 'story: dream sweep failed');
    }
  }
  await dreamWorker.processWords();
}

// 020 E3: the claim check's job. Its own chain, so a check's clerk call never holds up a text or a scene; it reads rows and writes
// only its own tables. The sweep runs when the projection's exclusions change, and hourly; the panel sweeps on read.
let checkChain = Promise.resolve();
let checksQueued = false;
let checksReset = false;
let checkSweepMemo = { key: null, at: 0 };
function sweepChecksIfChanged(s) {
  const key = exclusionKey(s);
  const t = nowSec();
  if (key === checkSweepMemo.key && t - checkSweepMemo.at <= HOUR) return;
  checkSweepMemo = { key, at: t };
  checkWorker.sweep();
}
async function checksJob() {
  const s = liveState();
  if (!s) return;
  if (!checksReset) { checksReset = true; checkWorker.resetInterrupted(); }
  sweepChecksIfChanged(s);
  await checkWorker.processPending();
}
// Runs with the check off too: the sweep still removes what's gone, a queued run's sheet lines with it. processPending has the mode gate.
function queueChecks() {
  if (checksQueued) return;
  checksQueued = true;
  checkChain = checkChain.then(checksJob).catch((err) => {
    logger.warn({ evt: 'issue', where: 'arcs.check.job', err: err?.name || 'Error' }, 'story: claim check job failed');
  }).finally(() => { checksQueued = false; });
}

/** The words a run was written over, where they stand now. → { text, href } | null (gone or changed status) | undefined (life isn't running). */
function checkTextOf(writer, id) {
  const s = liveState();
  if (!s) return undefined;
  if (writer === 'scene') {
    const r = sceneStore.getScene(id);
    if (!r || !sceneStore.LIVE_STATUSES.includes(r.status) || !r.eventId || sceneGone(s, r.eventId)) return null;
    const text = r.editedText ?? r.text;
    return typeof text === 'string' ? { text, href: Number.isFinite(r.endedAt) ? `#life/day/${dateKey(r.endedAt, tzOf(s))}` : '#life/day' } : null;
  }
  if (writer === 'phone') {
    const r = phoneStore.getMessage(id);
    if (!r || r.status !== 'live' || !r.eventId || sceneGone(s, r.eventId)) return null;
    const text = r.editedText ?? r.text;
    return typeof text === 'string' ? { text, href: `#life/phone/${encodeURIComponent(r.castId)}` } : null;
  }
  if (writer === 'journal') {
    const r = store.getPart(id);
    return r?.status === 'active' && typeof r.text === 'string' ? { text: r.text, href: '#life/journal' } : null;
  }
  return null;
}

/** The Control panel's read (plan 020 E3). Verdicts and codes, plus words only where no chat is behind them. */
export function claimChecksView(opts) {
  const s = liveState();
  if (s) {
    try { sweepChecksIfChanged(s); } catch (err) {
      logger.warn({ evt: 'issue', where: 'arcs.check.sweep', err: err?.name || 'Error' }, 'story: claim check sweep failed');
    }
  }
  return checkWorker.view(opts);
}

/** Tests: run the claim check's job now and wait for it. */
export async function runChecksNow() {
  queueChecks();
  await checkChain;
  return checkChain;
}

// 020 F3: one real thought when the salience adds up (live only, like dreams). Only with the life facade's reads attached.
let realThoughtQueued = false;
async function realThoughtsJob() {
  if (!att?.thoughts) return { status: 'none' };
  return thoughtWorker.runRealThoughts();
}

/** Tests: run the real thoughts job now. */
export function runRealThoughtsNow() {
  return enqueue('real_thoughts_now', () => realThoughtsJob());
}

/** A stored real thought as the dashboard's card (what he told himself, what drove it). */
export function realThoughtView(row) {
  return thoughtWorker.viewOf(row);
}

/** Tests: run the dreams job now. */
export function runDreamsNow() {
  return enqueue('dreams_now', () => dreamsJob());
}

// 019: the phone job — sweep (texts / pending turns whose event left the log), scan (new
// triggers), the day's texts out of the blue, then ≤ 3 due turns.
let phoneQueued = false;
let phoneReset = false;
let phoneSweepMemo = { key: null, at: 0 };
async function phoneJob() {
  const s = liveState();
  if (!s) return;
  if (!phoneReset) {
    phoneReset = true;
    try { phoneWorker.resetInterrupted(); } catch (err) {
      logger.warn({ evt: 'issue', where: 'arcs.phone.reset', err: err?.name || 'Error' }, 'story: interrupted texts not reset');
    }
  }
  const key = exclusionKey(s);
  const t = nowSec();
  if (key !== phoneSweepMemo.key || t - phoneSweepMemo.at > HOUR) {
    phoneSweepMemo = { key, at: t };
    try { phoneWorker.sweep(); } catch (err) {
      logger.warn({ evt: 'issue', where: 'arcs.phone.sweep', err: err?.name || 'Error' }, 'story: phone sweep failed');
    }
  }
  // Only awaited when one is held: an await here on every job lets the rest of it interleave with a Director preview → apply.
  try { if (phoneWorker.hasHeldPlans()) await phoneWorker.settleHeldPlans(t); } catch (err) {
    logger.warn({ evt: 'issue', where: 'arcs.phone.held', err: err?.name || 'Error' }, 'story: held text plans not settled');
  }
  try { phoneWorker.scan(); } catch (err) {
    logger.warn({ evt: 'issue', where: 'arcs.phone.scan', err: err?.name || 'Error' }, 'story: text triggers not scanned');
  }
  phoneWorker.rollDay();
  try { phoneWorker.rollBonds(); } catch { /* the next job rolls it */ }
  await phoneWorker.processDue();
  armPhoneTimer();
}

// A text due before the next tick (a chat going back and forth within minutes) runs at its own
// time: one unref'd timer re-runs the phone job then. Real clock only (never a test's fake
// clock or a simulation — afterTick, the only caller, is live-only anyway).
let phoneTimer = null;
let phoneTimerAt = null;
function armPhoneTimer() {
  if (!isRealClock() || testDeps.now) return;
  let due = null;
  try { due = phoneStore.nextDueAt(); } catch { due = null; }
  const t = nowSec();
  const tick = Math.max(60, Math.round(Number(config.life?.tickMinutes ?? 15) * 60));
  if (!Number.isSafeInteger(due) || due >= t + tick) return;
  const fireAt = Math.max(t + 5, due);
  if (phoneTimer && phoneTimerAt !== null && phoneTimerAt <= fireAt) return;
  if (phoneTimer) clearTimeout(phoneTimer);
  phoneTimerAt = fireAt;
  phoneTimer = setTimeout(() => {
    phoneTimer = null;
    phoneTimerAt = null;
    if (!att || !storyOn() || config.arcs?.phoneEnabled === false || phoneQueued) return;
    phoneQueued = true;
    enqueue('phone', async () => {
      try { await phoneJob(); } finally { phoneQueued = false; }
    });
  }, (fireAt - t) * 1000);
  phoneTimer.unref?.();
}

// ── 020 C4: the scene the moment the outing ends ─────────────────────────────
// The pulse only folds an end at its next grid tick, so a timer at the outing's end folds it then and runs the scenes job.
// Live only: this is armed from afterTick, which never runs in a sim. Everything it does is what the next tick would do
// anyway, so a kick that loses a race with the tick finds nothing left: the scan's cursor and the row's pending → running
// each let one through. Lost on restart like the phone's, and the first tick after it picks the outing up.
let sceneTimer = null;
let sceneTimerFor = null;
const SCENE_KICK_GRACE_SEC = 5;
const SCENE_KICK_STALE_SEC = 120;

function queueScenes() {
  if (scenesQueued) { scenesAgain = true; return; }
  scenesQueued = true;
  enqueue('scenes', async () => {
    try { await scenesJob(); } finally {
      scenesQueued = false;
      if (scenesAgain) { scenesAgain = false; queueScenes(); }
    }
  });
}

function outingDue(view, tickSec, t) {
  const a = view?.activity;
  if (!a || !finite(a.endAt) || !posInt(a.eventId)) return null;
  if (a.endAt >= t + tickSec) return null;   // an end already past since the tick's grid point, still unfolded, is due at once
  const start = getEvent(a.eventId);
  if (!start || start.type !== 'activity.started') return null;
  // Only something that could have a scene: not routine, and with someone.
  const fake = { type: 'activity.ended', at: Math.max(a.endAt, start.at + 3600) };
  const ok = sceneIsSession(start, fake, view);
  return ok.ok ? { eventId: a.eventId, end: a.endAt } : null;
}

function armSceneKick(view) {
  // The real clock, not the tick's grid point: ticks sit at boot time mod the interval, so a delay from the grid fires late.
  const t = nowSec();
  const tick = Math.max(60, Math.round(Number(config.life?.tickMinutes ?? 15) * 60));
  const due = outingDue(view, tick, t);
  if (!due) return;
  if (sceneTimer && sceneTimerFor?.eventId === due.eventId && sceneTimerFor.end === due.end) return;
  if (sceneTimer) clearTimeout(sceneTimer);
  const delay = Math.max(1, due.end + SCENE_KICK_GRACE_SEC - t);
  sceneTimerFor = { ...due, delaySec: delay };
  sceneTimer = setTimeout(() => {
    sceneTimer = null;
    const armed = sceneTimerFor;
    sceneTimerFor = null;
    kickSceneNow(armed).catch(err => logger.warn({ evt: 'issue', where: 'arcs.scenes.kick', err: err?.code || err?.name }, 'story: scene kick failed'));
  }, delay * 1000);
  sceneTimer.unref?.();
}

/** The outing it was armed for is still the one underway and its end has just come: fold it, then run the job. */
async function kickSceneNow(armed) {
  if (!att || !storyOn() || config.arcs?.scenesEnabled === false || !armed) return false;
  const s = liveState();
  const t = nowSec();
  if (s?.activity?.eventId === armed.eventId && t >= armed.end && t - armed.end < SCENE_KICK_STALE_SEC) {
    await att.pulse?.settle?.(t);
  }
  queueScenes();
  return true;
}

/** Tests: what the kick is armed for, and fire it now. */
export function __sceneKickForTest() { return sceneTimerFor; }
export function __fireSceneKickForTest() {
  const armed = sceneTimerFor;
  if (sceneTimer) clearTimeout(sceneTimer);
  sceneTimer = null;
  sceneTimerFor = null;
  return kickSceneNow(armed);
}

let scenesCache = { at: 0, today: null, mindToday: null, chatToday: null, monthUsd: null };
async function refreshScenesCache(s = liveState()) {
  const at = nowSec();
  const b = await sceneWorker.budgetStatus(at, tzOf(s));
  scenesCache = { at, today: b?.today ?? null, mindToday: b?.mindToday ?? null, chatToday: b?.chatToday ?? null, monthUsd: b?.monthUsd ?? null };
}

export async function afterTick(view, info = {}, append = null) {
  void append;
  if (!att) return;
  if (!storyOn()) {
    sceneWorker.markScenesOff();   // 016 (R24): the next on re-seeds the scene cursor
    phoneWorker.markPhoneOff();    // 019: likewise the phone's trigger cursor
    // Withdrawals (forget/revoke of a chat with an adoption) are privacy, not a
    // story feature: their world half runs with the skill off too, on the
    // story's own chain (it appends and rebuilds), never on the tick's.
    if (!withdrawQueued) {
      withdrawQueued = true;
      enqueue('withdraw', () => {
        try { if (att) reconciler.applyPendingWithdrawals(); } finally { withdrawQueued = false; }
      });
    }
    return;
  }
  const at = finite(info?.at) ? info.at : nowSec();
  try {
    if (!swept) { swept = true; reconciler.bootSweep(at); }
    startSeed();
    reconciler.afterTick(at);
    const due = journalMod.journalDue(view, info, { at });
    if (due?.due && !pendingNights.has(due.nightKey)) {
      pendingNights.add(due.nightKey);
      enqueue('journal', async () => {
        try {
          await journalMod.runJournal(due.nightKey, { sleepEventId: due.sleepEventId ?? null });
          await journalMod.rebuildUndone();
        } finally {
          pendingNights.delete(due.nightKey);
        }
      });
    }
    const today = dateKey(at, tzOf(view));
    if (lastPruneDate !== today) {
      lastPruneDate = today;
      enqueue('prune', () => {
        store.expireProposals(at);
        store.pruneStory(at);
        sceneStore.prune(at);   // 016
        phoneStore.prune(at);   // 019
        dreamStore.prune(at);   // 020 G
        checkWorker.prune(at);  // 020 E3
      });
    }
    // 016: scene play-outs (live only: afterTick never runs in a sim).
    if (config.arcs?.scenesEnabled === false) sceneWorker.markScenesOff();
    else {
      queueScenes();
      armSceneKick(view);
    }
    // 020 G: dreams: words that left the log go, and a vivid one's single call (live only, like scenes).
    if (!dreamsQueued && config.arcs?.dreamsEnabled !== false) {
      dreamsQueued = true;
      enqueue('dreams', async () => {
        try { await dreamsJob(); } finally { dreamsQueued = false; }
      });
    }
    // 020 D2: a revert, a rewind or a heavy onset can take a note's evidence out of his life.
    if (standingWorker.exclusionsChanged(att.getState())) enqueue('standing', () => { standingWorker.sweep(); });
    queueChecks();   // 020 E3: anything a tick's restart left queued
    // 020 F3: real thoughts. His mood's reading each tick; the job only when it might think.
    if (att.thoughts) {
      thoughtWorker.noteTick(view, { ...info, at });
      if (!realThoughtQueued && config.arcs?.realThoughtsEnabled !== false) {
        realThoughtQueued = true;
        enqueue('real_thoughts', async () => {
          try { await realThoughtsJob(); } finally { realThoughtQueued = false; }
        });
      }
    }
    // 019: texts with the fictional cast (live only, like scenes).
    if (config.arcs?.phoneEnabled === false) phoneWorker.markPhoneOff();
    else if (!phoneQueued) {
      phoneQueued = true;
      enqueue('phone', async () => {
        try { await phoneJob(); } finally { phoneQueued = false; }
      });
    }
    if (at - spendCache.at > HOUR) {
      spendCache.at = at;
      enqueue('spend', async () => {
        const usd = await seedMod.arcsCallerSpend(at, { tz: tzOf(view), getUsageByCaller: testDeps.getUsageByCaller });
        spendCache.usd = finite(usd) ? usd : null;
        await refreshPromptCache(at, tzOf(view));
      });
    }
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'arcs.afterTick', err: err?.name || 'Error' }, 'story: afterTick failed');
  }
}

async function refreshPromptCache(at, tz) {
  try {
    const b = await promptMod.promptBudgetStatus(at, tz);
    promptCache = { promptMonthUsd: b.promptMonthUsd, promptToday: b.promptToday };
  } catch {
    promptCache = { promptMonthUsd: null, promptToday: null };
  }
  await refreshContinuityCache(at, tz);
}

// 015 cont: the story read's day count and month spend for /api/arcs/status.
async function refreshContinuityCache(at, tz) {
  try {
    const b = await storyReadMod.continuityBudgetStatus(at, tz);
    continuityCache = { continuityMonthUsd: b.continuityMonthUsd, continuityToday: b.continuityToday };
  } catch {
    continuityCache = { continuityMonthUsd: null, continuityToday: null };
  }
}

// ── Facade hooks ──────────────────────────────────────────────────────────

/** A flagged claim (life onReplySent): queue it for the reconciler. Never throws. */
export function onClaimFlagged({ claim, eventId } = {}) {
  try {
    if (!storyOn() || !isObj(claim)) return null;
    return reconciler.enqueue({ claim, eventId });
  } catch {
    return null;
  }
}

/** Withdrawals the DB-only hooks recorded while detached: the world half (boot, before catch-up). */
export function applyPendingWithdrawals() {
  try { return att ? reconciler.applyPendingWithdrawals() : 0; } catch { return 0; }
}

/** 008 sleep step 4b (via life.storyWeeklyPass): budgetOk is mindBudgetOk('sleep')'s object. */
export async function weeklyPass({ nightKey = null, trigger = null, budgetOk = null } = {}) {
  if (!storyOn()) return { status: 'skipped', reason: 'disabled' };
  return weekly.runWeekly({ nightKey, trigger, budgetOk });
}

/** 020 D2: the mind's sleep step (via life.storyStandingPass). opts: { nightKey, budgetOk, call, clerkLeft }. */
export async function standingPass(opts = {}) {
  if (!storyOn()) return { status: 'skipped', reason: 'disabled' };
  return standingWorker.runPass(opts);
}

/** 020 D2: the site's rows (the exporter's `standing` key): [{ castId, text, validFrom }]. Story off → []. */
export function publicStanding() {
  return storyOn() ? standingWorker.publicRows(safe(() => att?.getState?.(), null)) : [];
}

// ── 020 D3: what he said he'd do ──────────────────────────────────────────

const COMMIT_DECISION_TYPES = ['decision.opened', 'decision.committed', 'decision.reversed', 'decision.expired'];
const COMMIT_LOOKBACK_SEC = 30 * 86400;
const COMMIT_MOVES_SEC = 14 * 86400;
const COMMIT_PROMISE_SEC = 15 * 86400;   // a named day up to a week off, and the week it stays shown after

function pagesOf(query, maxPages = 20) {
  const out = [];
  for (let page = 0, after; page < maxPages; page++) {
    const rows = listEvents({ ...query, ...(after ? { after } : {}), limit: 500 });
    out.push(...rows);
    if (rows.length < 500) break;
    after = rows[rows.length - 1].id;
  }
  return out;
}

/** Texts that sound like a promise to meet (a code word and the day, never the words). */
function phonePromises(s, at, tz) {
  const out = [];
  for (const r of phoneStore.listLive({ since: at - COMMIT_PROMISE_SEC, limit: 400 })) {
    if (r.heavyWindow === true || isExcludedId(s, r.eventId)) continue;
    const hit = promiseCue(r.editedText || r.text || '');
    if (hit) out.push({ eventId: r.eventId, castId: r.castId, at: r.at, cue: hit.cue, dayAt: promiseDayEnd(hit.day, r.at, tz, { next: hit.next === true }) });
  }
  return out;
}

/** The commitments view for a state (works with the arcs skill off: invitations, goals and decisions are life's). */
export function commitmentsFor(s, at, tz) {
  const live = (e) => e && e.redacted !== true && !isExcludedId(s, e.id);
  return commitmentRows(s, {
    at,
    decisions: pagesOf({ types: COMMIT_DECISION_TYPES, from: at - COMMIT_LOOKBACK_SEC }).filter(live),
    recorded: pagesOf({ types: ['commitment.recorded'], from: at - COMMIT_LOOKBACK_SEC }).filter(live),
    moves: pagesOf({ types: ['activity.started', 'travel.started'], from: at - COMMIT_MOVES_SEC }).filter(live).sort((a, b) => a.at - b.at || a.id - b.id),
    causeOf: (id) => getEvent(id),
    promises: phonePromises(s, at, tz),
    ring: phoneStore.planOutcomes(),
  });
}

// ── Prompt helpers (sync, read-only) ──────────────────────────────────────

/** ≤ 80 chars or ''. '' while the story is off. */
export function promptFragment(state, audience, opts = {}) {
  if (!storyOn()) return '';
  try { return fragmentMod.promptFragment(state, audience, opts) || ''; } catch { return ''; }
}

/** { label?, statusSuffix?, age? } for this audience, or {} while off. */
export function castOverlay(state, castId, member = null, audience = null) {
  if (!storyOn()) return {};
  try { return fragmentMod.castOverlay(state, castId, member, audience) || {}; } catch { return {}; }
}

/** May this audience hear that he is sick? A heavy onset's sickness: DM/call only (R17). Always yes while off. */
export function sickVisible(state, audience) {
  if (!storyOn()) return true;
  return fragmentMod.sickVisible(state, audience) === true;
}

// ── 012 chat influence (plan §P2.3) ───────────────────────────────────────

/**
 * The owner's controls over a chat-caused change: controls.check({source,
 * category, action, pinKeys}) on the live projection (or `state`), or {ok:true}
 * while the story is off (no controls exist then). Fails closed on an error.
 */
export function controlsVerdict(opts = {}, state = null) {
  if (!storyOn()) return { ok: true };
  try { return controlsCheck(opts, state ?? liveState()); } catch { return { ok: false, reason: 'invalid' }; }
}

/**
 * 012 (plan §P2.2–P2.3): an invitation's clerk extraction (raw text) → the
 * reconciler's code-only resolution (steps 4–10: time window, place, people,
 * controls as `source:'reconciler', action:'adopt'`, calendar fit, the future
 * cap) — never the owner mapping path. Works with the `arcs` skill off.
 *   claim = { chatJid (canonical), originKind, originJid, createdAt }
 *   opts.venue(kind) → the exact name of the world's venue for that activity
 *     kind (used when the extraction names no place, or one he doesn't know)
 * → { ok:true, kind, resolution } | { ok:false, reason } — kind is on the
 * reconciler's allow-list (an unknown kind refuses). A refusal by the owner's
 * controls is recorded (story_refusals) while the story is on.
 */
export async function resolvePlan(raw, claim, state, { at = nowSec(), venue = null } = {}) {
  // What exactly was wrong is kept as the reason, so the day's counters say it (never the clerk's words). Normalising and these codes are this path's only: the claim path is untouched.
  const tidy = normalizeInviteExtraction(raw, { createdAt: finite(claim?.createdAt) ? claim.createdAt : at, tz: tzOf(state) });
  if (!tidy.ok) return { ok: false, reason: tidy.error };
  const v = validateExtraction(tidy.text);
  if (!v.ok) return { ok: false, reason: v.error };
  const x = { ...v.value, summary: '' };            // the clerk's summary is never kept
  if (x.type !== 'plan') return { ok: false, reason: 'out_of_scope' };
  const kind = reconciler.allowedKind(x.kind);
  if (!kind) return { ok: false, reason: 'bad_kind' };
  x.kind = kind;
  const world = worldOf(state, att?.world ?? null);
  const known = x.place ? reconciler.matchPlace(x.place, state, world) : null;
  if (!known?.placeId) {
    const name = typeof venue === 'function' ? safe(() => venue(kind), null) : null;
    if (typeof name !== 'string' || !name) return { ok: false, reason: 'unknown_place' };
    x.place = name;
  }
  let r;
  try {
    r = await reconciler.resolve(x, { ...claim }, state, { at, world });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!r?.ok) {
    if (r?.refusal && storyOn()) {
      try {
        store.recordRefusal({ source: 'reconciler', category: r.refusal.category, action: 'adopt', target: 'invite',
          reason: ['paused', 'frozen', 'pinned', 'guided', 'invalid'].includes(r.refusal.reason) ? r.refusal.reason : 'invalid',
          pinKey: r.refusal.pinKey ?? null, detail: null, at });
      } catch { /* an operational log only */ }
    }
    return { ok: false, reason: r?.reason ?? 'failed' };
  }
  return { ok: true, kind, resolution: r.resolution };
}

// ── Attach / detach ───────────────────────────────────────────────────────

let canUseInRule = null;   // 006's rule, resolved once (an import error leaves the 009 fallback)
async function loadCanUseIn() {
  if (canUseInRule || testDeps.canUseIn) return;
  try {
    const recall = await import('../../memory/recall.js');
    if (typeof recall.canUseIn === 'function') canUseInRule = recall.canUseIn;
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'arcs.canUseIn', err: err?.name || 'Error' }, 'story: 006 audience rule unavailable; same-chat fallback stays');
  }
}

/**
 * The innerState decision filter (R21): while the story is on, an open arc
 * decision whose category isn't `social` never reaches a prompt line; 009
 * decisions (no category) are kept. While off, every story-owned decision (any
 * category, adopted ones included) is dropped, so prompts read as with 009.
 */
export function decisionKept(d) {
  const story = typeof d?.category === 'string' && d.category !== '';
  if (!storyOn()) return !story;
  return !(story && d.category !== 'social');
}

function installSeams() {
  innerState.setCanUseIn((item, aud) => {
    const rule = testDeps.canUseIn ?? canUseInRule;
    if (!storyOn() || typeof rule !== 'function') return innerState.fallbackCanUseIn(item, aud);
    return rule(item, aud) === true;
  });
  innerState.setBlockOrigin((plan, block) => blockCause(plan, block));
  innerState.setStoryFragment((state, audience, o) => promptFragment(state, audience, o));
  innerState.setCastOverlay((state, castId, member, audience) => castOverlay(state, castId, member, audience));
  innerState.setDecisionFilter((d) => decisionKept(d));
  innerState.setSickFilter((state, audience) => sickVisible(state, audience));
  setStoryAsk(() => storyOn());
  setTrustWeight(() => (storyOn() && castMod.trustEnabled() ? castMod.TRUST_LEAN_W : 0));
  setUrgeBoost((state, castIds, at) => (storyOn() ? urgeUtility(state, castIds, { at }) : 0));
}

function resetSeams() {
  innerState.setCanUseIn(null);
  innerState.setBlockOrigin(null);
  innerState.setStoryFragment(null);
  innerState.setCastOverlay(null);
  innerState.setDecisionFilter(null);
  innerState.setSickFilter(null);
  setStoryAsk(null);
  setTrustWeight(null);
  setUrgeBoost(null);
}

function wire() {
  if (!att) return;
  const { getState, append, world, pulse } = att;
  const now = () => nowSec();
  const tz = () => tzOf(safe(getState, null));
  const optional = {
    ...(testDeps.callRole ? { callRole: testDeps.callRole } : {}),
  };
  directorMod.configure({
    now, getState, world, append, pulse,
    worldOf: (s) => worldOf(s, world),                       // 014 geo (§A0)
    geo: att.geo ?? null,                                    // 014 geo: preview resolver (null → geo_off)
    venueNames: () => safe(() => att?.venueNames?.() ?? [], []),
    seed: () => seedFor(safe(getState, null)),
    knownNames: () => safe(() => realPeopleNames(), []),   // owner actions: always a fresh read
    storyItems: (s, g, o = {}) => items(s, g, { ...o, sim: true }),
    atWake: (s, at, add) => atWake(s, at, add, { sim: true }),   // 015: planned wake nudges in preview tomorrow
    blockCause: (plan, b) => planEditsBlockCause(plan, b),   // 014 sched (R29)
    planCause: (plan) => plan?.basePlanEventId ?? plan?.eventId,
    onApplyFailed: () => { try { att?.rebuild?.(); } catch { /* the next tick re-reads */ } },
    // PREVIEW APPROVE of a weekly proposal (Life · Story): weekly's checks, re-run now, as descriptors.
    proposalDescriptors: (proposal, s, c) => weekly.proposalDescriptors(proposal, s, c),
    willTellBackOut: (d, o) => safe(() => att?.willTellBackOut?.(d, o) === true, false),   // 020: the Director's warnings
    phoneWords: (text, castId, s, o = {}) => phoneWordsCheck(text, castId, s, o),   // 019: an owner's verbatim first text
  });
  reconciler.configure({
    now, getState, append, world, worldOf: (s, w) => worldOf(s, w ?? world), isOn: storyOn,
    revertEvent: (id, o = {}) => att.revert(id, o), ...optional,
  });
  weekly.configure({
    now, getState, append, world, worldOf: (s, w) => worldOf(s, w ?? world), isOn: storyOn,
    openArcDecision: (st, spec, ctx) => openArcDecision(st, spec, { ...ctx, source: 'mind' }),
    ...optional,
    ...(testDeps.getUsageByCaller ? { getUsageByCaller: testDeps.getUsageByCaller } : {}),
  });
  // Spec 011: the Director prompt. No 008 gate wired → it refuses (fail closed).
  promptMod.configure({
    now, getState, world, ...optional,
    geo: att.geo ?? null,                                    // 014 geo (A6b): venue lookups for drafts
    mindBudgetOk: testDeps.mindBudgetOk ?? att.mindBudgetOk ?? null,
    getUsageByCaller: testDeps.getUsageByCaller ?? null,
    knownNames: testDeps.knownNames ?? (() => realPeopleNames()),   // a throw → names_unavailable
  });
  // 015 cont: the continuity story read. No 008 gate wired → it refuses (fail closed).
  storyReadMod.configure({
    now, getState, world, ...optional,
    mindBudgetOk: testDeps.mindBudgetOk ?? att.mindBudgetOk ?? null,
    getUsageByCaller: testDeps.getUsageByCaller ?? null,
    knownNames: testDeps.knownNames ?? (() => realPeopleNames()),
  });
  // 016: the scene worker. No 008 gate wired → the mind tier refuses (fail closed).
  dreamWorker.configure({
    now, getState,
    tz: (s) => tzOf(s),
    rngFor: (...a) => rngFor(...a),
    callRole: optional.callRole ?? (async (...a) => (await import('../../brain/llm.js')).callRole(...a)),
    spend: (at, tz) => seedMod.arcsCallerSpend(at, { tz, getUsageByCaller: testDeps.getUsageByCaller ?? undefined, prefixes: [dreamWorker.CALLER] }),
    knownNames: testDeps.knownNames ?? (() => realPeopleNames()),
    heavyAt: (s, t) => sceneWorker.heavyAtSession(s, { startAt: t }) || sceneWorker.inHeavyWindow(s, { startAt: t }),
  });
  // 020 E3: the claim check. Writers get its seam; only this file imports check/*.
  checkWorker.configure({
    now,
    tz: () => tzOf(safe(getState, null)),
    callRole: optional.callRole ?? (async (...a) => (await import('../../brain/llm.js')).callRole(...a)),
    getUsageByCaller: testDeps.getUsageByCaller ?? null,
    knownNames: testDeps.knownNames ?? (() => realPeopleNames()),
    castNames: () => {
      const st = safe(getState, null);
      return st?.cast instanceof Map ? [...st.cast.values()].map(c => c?.name).filter(n => typeof n === 'string') : [];
    },
    relWhen: relWhenWords,
    textOf: checkTextOf,
    kick: () => queueChecks(),
  });
  if (att.thoughts) {
    thoughtWorker.configure({
      now, getState, worldOf: (s) => worldOf(s, world),
      tz: (s) => tzOf(s),
      callRole: optional.callRole ?? (async (...a) => (await import('../../brain/llm.js')).callRole(...a)),
      callRows: async (prefix, since) => (testDeps.getUsageByCaller ?? (await import('../../brain/usage.js')).getUsageByCallerStrict)(prefix, since),
      spend: (at, tz) => seedMod.arcsCallerSpend(at, { tz, getUsageByCaller: testDeps.getUsageByCaller ?? undefined, prefixes: ['life.thought.'] }),
      roleBudgetOk: testDeps.roleBudgetOk ?? (async () => (await import('../../brain/usage.js')).budgetState('mouth').allowed === true),
      knownNames: testDeps.knownNames ?? (() => realPeopleNames()),
      identity: async () => (await import('../../personality/systemPrompt.js')).identityCore(),
      heavyAt: (s, t) => sceneWorker.heavyAtSession(s, { startAt: t }) || sceneWorker.inHeavyWindow(s, { startAt: t }),
      ...att.thoughts,
    });
  }
  sceneWorker.configure({
    claimCheck: checkWorker.seam,
    now, getState, append, world, pulse, worldOf: (s) => worldOf(s, world),
    rebuild: () => { try { att?.rebuild?.(); } catch { /* the next tick re-reads */ } },
    ...optional,
    getUsageByCaller: testDeps.getUsageByCaller ?? null,
    mindBudgetOk: testDeps.mindBudgetOk ?? att.mindBudgetOk ?? null,
    knownNames: testDeps.knownNames ?? (() => realPeopleNames()),
    seed: () => seedFor(safe(getState, null)),
    rngFor: (...a) => rngFor(...a),
    liveTrace: att.liveTrace ?? null,   // 020 C4
    liveResumed: att.liveResumed ?? null,
    standing: (s, id, at) => standingWorker.noteAt(s, id, at),   // 020 D2
    commitmentLines: (s, castId, at, tz, side) => commitmentLines(commitmentsFor(s, at, tz), { castId, side, at, tz }),   // 020 D3
    liveEarlier: att.liveEarlier ?? null,
    texting: (ids, at) => phoneWorker.recentTexting(ids, at),   // 019: the sheet's "texting lately"
    // 2026-11-02 (pinned #8): the phone's true lines for the scene sheet too — when they last saw
    // each other, their time together lately, and what's planned with them after the outing.
    lastSeen: (s, castId, at, tz) => phoneWorker.lastSeenWith(s, castId, at, tz),
    timeline: (s, castId, at, tz) => phoneWorker.timelineOf(s, castId, at, tz),
    plans: (s, castId, at, tz, o) => phoneWorker.plansOf(s, castId, at, tz, o),
  });
  // 020 D2: how things stand. The mind's sleep step runs it; the sheets read it.
  standingWorker.configure({
    now, getState, ...optional,
    tz: (s) => tzOf(s),
    persona: () => getPersona(),
    getUsageByCaller: testDeps.getUsageByCaller ?? null,
    knownNames: testDeps.knownNames ?? (() => realPeopleNames()),
    sceneRows: (ids) => sceneStore.byEventIds(ids),
    textRows: (ids) => phoneStore.byEventIds(ids),
  });
  // 019: the phone worker. No 008 gate wired → an owner's text is written by the mouth.
  phoneWorker.configure({
    claimCheck: checkWorker.seam,
    now, getState, append, world, pulse, worldOf: (s) => worldOf(s, world),
    rebuild: () => { try { att?.rebuild?.(); } catch { /* the next tick re-reads */ } },
    ...optional,
    ...(testDeps.identity ? { identity: testDeps.identity } : {}),
    getUsageByCaller: testDeps.getUsageByCaller ?? null,
    mindBudgetOk: testDeps.mindBudgetOk ?? att.mindBudgetOk ?? null,
    knownNames: testDeps.knownNames ?? (() => realPeopleNames()),
    rngFor: (...a) => rngFor(...a),
    settle: () => kickSchedule(),   // a plan agreed in texts: the pulse fits it at once (014 R36's settle)
    standing: (s, id, at) => standingWorker.noteAt(s, id, at),   // 020 D2
    commitmentLines: (s, castId, at, tz, side) => commitmentLines(commitmentsFor(s, at, tz), { castId, side, at, tz }),   // 020 D3
    firstMeeting: (s, d, castId) => firstMeetOf({ castIds: [castId], activityEventId: null }, s, { metAtGenesis: sceneWorker.metAtGenesis }).length > 0,
  });
  journalMod.configure({ now, getState, world, timezone: tz, themeLabel: themeLabelOf, sceneOf: journalSceneOf, claimCheck: checkWorker.seam, ...optional });
  narrateMod.configure({ now, getState, world, timezone: tz, themeLabel: themeLabelOf, ...optional });
  hooks.configure({ now, timezone: tz });
}

/**
 * Wire the story to the running life engine (life boot, after createPulse).
 * rt: { getState (the LIVE projection, not a view), append (the facade's
 * appender), world, pulse, revert(id, {reason, by}), rebuild(), isLifeOn() }.
 */
export function attach(rt = {}) {
  if (!isObj(rt) || typeof rt.getState !== 'function' || typeof rt.append !== 'function') {
    throw new Error('story: attach needs { getState, append, world }');
  }
  att = {
    getState: rt.getState, append: rt.append, world: rt.world ?? null, pulse: rt.pulse ?? null,
    revert: typeof rt.revert === 'function' ? rt.revert : () => { throw new Error('story: no revert'); },
    rebuild: typeof rt.rebuild === 'function' ? rt.rebuild : () => {},
    isLifeOn: typeof rt.isLifeOn === 'function' ? rt.isLifeOn : () => true,
    // 008's mindBudgetOk(kind), injected by the life facade (the story layer
    // imports no src/mind/ module); absent → the seed gate fails closed.
    mindBudgetOk: typeof rt.mindBudgetOk === 'function' ? rt.mindBudgetOk : null,
    // 014 geo: the life facade's geo service (null → geo_off) and the venue names reader.
    geo: isObj(rt.geo) ? rt.geo : null,
    venueNames: typeof rt.venueNames === 'function' ? rt.venueNames : () => [],
    liveTrace: typeof rt.liveTrace === 'function' ? rt.liveTrace : null,   // 020 C4: an outing's record, from the life facade
    liveResumed: typeof rt.liveResumed === 'function' ? rt.liveResumed : null,
    liveEarlier: typeof rt.liveEarlier === 'function' ? rt.liveEarlier : null,
    willTellBackOut: typeof rt.willTellBackOut === 'function' ? rt.willTellBackOut : () => false,   // 020: influence's read-only probe, for the Director's warnings
    thoughts: isObj(rt.thoughts) ? rt.thoughts : null,   // 020 F3: the thought table and the live reads, from the life facade
  };
  failed.clear();
  swept = false;
  scenesReset = false;   // 016: rows a crash left 'running' are reset by the first scenes job
  phoneReset = false;    // 019: likewise the phone job's
  wire();
  installSeams();
  loadCanUseIn().catch(() => {});
  // 019: texts that fell due during a restart (or are due before the first tick) go out within
  // seconds of boot, not at the next grid tick (2026-11-01 live: up to 15 min late after a restart).
  try { armPhoneTimer(); } catch { /* the first tick arms it */ }
  logger.info({ evt: 'arcs.attach', on: storyOn() }, 'story: attached');
}

/** Seams back to 009's defaults; the DB-only hooks stay registered. */
export function detach() {
  if (!att) return;
  att = null;
  if (phoneTimer) { clearTimeout(phoneTimer); phoneTimer = null; phoneTimerAt = null; }
  resetSeams();
  directorMod.configure({ getState: () => null, append: null, pulse: null, geo: null, proposalDescriptors: null });
  directorMod.clearPreviews();
  promptMod.configure({ getState: () => null, geo: null });
  storyReadMod.configure({ getState: () => null });
  reconciler.configure({ isOn: () => false });
  weekly.configure({ isOn: () => false });
  sceneWorker.configure({ getState: () => null, append: null, pulse: null });
  phoneWorker.configure({ getState: () => null, append: null, pulse: null });
  pendingNights.clear();
  logger.info({ evt: 'arcs.detach' }, 'story: detached');
}

// ── Owner batch + rewind (the life facade's appendOwnerBatch / rewindTo) ──

const OWNER_TYPES_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Append owner descriptors through `append` in one transaction ({type, at?,
 * payload, heavy?, ref?, causeRef?, causeId?, subjectJid?}; actor forced to
 * owner unless 'engine' consequence). → { eventIds }
 */
export function appendOwnerBatch(descriptors, { append = att?.append, by = 'owner', now = nowSec() } = {}) {
  if (typeof append !== 'function') throw storyError('not_running');
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 50) throw storyError('invalid', 'batch');
  const list = descriptors.map((d, i) => {
    if (!isObj(d) || typeof d.type !== 'string' || !OWNER_TYPES_RE.test(d.type)) throw storyError('invalid', 'bad_type');
    return {
      ref: typeof d.ref === 'string' ? d.ref : `$${i + 1}`,
      type: d.type,
      actor: d.actor === 'engine' ? 'engine' : 'owner',
      at: Number.isSafeInteger(d.at) ? d.at : now,
      payload: isObj(d.payload) ? d.payload : {},
      ...(typeof d.causeRef === 'string' ? { causeRef: d.causeRef } : {}),
      ...(posInt(d.causeId) ? { causeId: posInt(d.causeId) } : {}),
      ...(d.heavy === true ? { heavy: true } : {}),
      ...(typeof d.subjectJid === 'string' ? { subjectJid: d.subjectJid } : {}),
    };
  });
  let db = null;
  try { db = getDb(); } catch { db = null; }
  try {
    const res = db ? db.transaction(() => directorMod.appendDescriptors(list, append))() : directorMod.appendDescriptors(list, append);
    logger.info({ evt: 'arcs.owner_batch', events: res.eventIds.length, by: typeof by === 'string' ? by.slice(0, 40) : 'owner' }, 'story: owner batch');
    return { eventIds: res.eventIds };
  } catch (err) {
    try { att?.rebuild?.(); } catch { /* the next tick re-reads */ }
    if (err instanceof directorMod.StoryError) throw err;
    throw storyError('invalid', 'refused_by_log');
  }
}

/** Apply a planned rewind (director.plan of a `rewind` action). → applyRewind's result */
export async function rewindTo(planned, { by = 'owner', fingerprint = null, append = att?.append } = {}) {
  if (!att || typeof append !== 'function') throw storyError('not_running');
  if (!isObj(planned) || planned.action?.kind !== 'rewind' || !Array.isArray(planned.events)) throw storyError('invalid', 'plan');
  return rewindMod.applyRewind(planned, {
    append, getState: att.getState, pulse: att.pulse, fingerprint, by, now: nowSec(),
    appendDescriptors: (list, ap, o) => {
      const db = getDb();
      return db.transaction(() => directorMod.appendDescriptors(list, ap, o))();
    },
  });
}

// ── Readers (operator view; never throw; off → an off shape) ──────────────

function decisionsOf(s) {
  return s?.decisions instanceof Map ? [...s.decisions.values()] : [];
}

function cards0(s, includeClosed) {
  return cardsView(s, { includeClosed, now: nowSec(), leanHistory: (id, n) => leanHistory(id, n), themeLabel: themeLabelOf });
}

/** /api/arcs/status (director-api §1). */
export function status() {
  const s = liveState();
  if (!storyOn() || !s) return { enabled: false };
  try {
    const at = nowSec();
    const since = dayStart(at, tzOf(s));
    const ctl = s.story?.controls ?? {};
    const cards = cards0(s, false);
    const seedInfo = safe(() => seedMod.getArcSeed(), null);
    const seedState = safe(() => store.getState('seed'), null);
    return {
      paused: ctl.paused === true,
      fate: { ...(ctl.fate ?? {}) },
      sliders: { ...(ctl.sliders ?? {}) },
      pins: Object.keys(ctl.pins ?? {}),
      reconcilerMode: reconcilerModeOf(s, config.arcs?.reconcilerMode ?? 'auto'),
      seed: {
        source: seedInfo?.source ?? seedState?.source ?? null,
        missing: Array.isArray(seedInfo?.missing) ? seedInfo.missing.slice(0, 10) : [],
        ...(typeof seedState?.reason === 'string' ? { reason: seedState.reason.slice(0, 40) } : {}),
      },
      counts: {
        cards: cards.filter(c => c.type === 'decision' && c.status === 'open').length,
        vetoCards: cards.filter(c => c.type === 'heavy_veto' && c.status === 'open').length,
        tray: safe(() => store.countReviews({ status: ['tray', 'returned'] }), 0),
        proposals: safe(() => store.countProposals({ status: 'pending' }), 0),
        refusals24h: safe(() => store.countRefusals({ since: at - DAY }), 0),
      },
      budgets: {
        mindMonthUsd: spendCache.usd,
        mindCapUsd: Number(config.arcs?.mindBudgetUsd ?? 1),
        clerkToday: safe(() => store.countRuns({ kind: ['extract', 'journal'], excludeStatus: 'skipped', since }), 0),
        clerkCap: Number(config.arcs?.clerkMaxPerDay ?? 80),
        extractHour: safe(() => store.countRuns({ kind: 'extract', excludeStatus: 'skipped', since: at - HOUR }), 0),
        extractDay: safe(() => store.countRuns({ kind: 'extract', excludeStatus: 'skipped', since }), 0),
        arcJevToday: finite(s.counters?.arcJevToday) ? s.counters.arcJevToday : 0,
        // 011: the Director prompt (cached; refreshed hourly and after every prompt)
        promptMonthUsd: promptCache.promptMonthUsd,
        promptCapUsd: Number(config.arcs?.promptBudgetUsd ?? 0.5),
        promptToday: promptCache.promptToday,
        promptDayCap: Number(config.arcs?.promptMaxPerDay ?? 20),
        // 015 cont: the continuity story read (cached like the prompt's)
        continuityMonthUsd: continuityCache.continuityMonthUsd,
        continuityCapUsd: Number(config.arcs?.continuityBudgetUsd ?? 0.5),
        continuityToday: continuityCache.continuityToday,
        continuityDayCap: Number(config.arcs?.continuityMaxPerDay ?? 30),
      },
      // 016: scene play-outs (cached: refreshed after each scene job and hourly; null = unreadable).
      scenes: {
        enabled: config.arcs?.scenesEnabled !== false,
        today: scenesCache.today, dayCap: Number(config.arcs?.sceneMaxPerDay ?? 8),
        mindToday: scenesCache.mindToday, mindCap: Number(config.arcs?.sceneMindMaxPerDay ?? 3),
        chatToday: scenesCache.chatToday, chatCap: Number(config.arcs?.sceneChatMaxPerDay ?? 2),
        monthUsd: scenesCache.monthUsd, capUsd: Number(config.arcs?.sceneBudgetUsd ?? 1),
        pending: safe(() => sceneStore.countPending(), null),
        regenToday: safe(() => sceneStore.countRegensSince(since), null),
        regenCap: Number(config.arcs?.sceneRegenMaxPerDay ?? 6),
      },
      degraded: safe(() => hooks.isDegraded(), false),
      // 011: the owner's weather windows not yet ended and his open / planned goals (ids, codes, times).
      windows: (Array.isArray(s.weatherWindows) ? s.weatherWindows : []).filter(w => finite(w?.to) && w.to > at)
        .slice(0, 8).map(w => ({ id: w.id, from: w.from, to: w.to, sky: w.sky, intensity: w.intensity })),
      goals: goalsMod.activeGoals(s).slice(0, 8).map(g => ({
        id: g.id, goalKind: g.goalKind, castId: g.castId ?? null, placeId: g.placeId ?? null, from: g.from, to: g.to,
        status: g.status === 'fitted' ? 'planned' : g.status, slotStart: g.fitted?.slotStart ?? null, lastReason: g.lastTry?.reason ?? null,
      })),
    };
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'arcs.status', err: err?.name || 'Error' }, 'story: status failed');
    return { enabled: false };
  }
}

/**
 * 015 Director as god — the PLAY GOD panel (operator view; ids, codes, fictional
 * names): the decisions it may steer (never chat-made ones), his job, money and
 * home, the cast with every number, who left, the scheduled changes and the
 * recent Director changes (for REVERT THIS CHANGE).
 */
export function godView() {
  const s = liveState();
  if (!storyOn() || !s) return { enabled: false };
  const at = nowSec();
  const tz = tzOf(s);
  const c = s.story?.career ?? {};
  const name = (id) => s.cast?.get?.(id)?.name ?? s.story?.departed?.[id]?.name ?? id;
  const placeName = (id) => (typeof id === 'string' ? s.places?.get?.(id)?.name ?? id : null);
  const decisions = [...(s.decisions instanceof Map ? s.decisions.values() : [])]
    .filter(d => (d?.status === 'open' || d?.status === 'committed') && finite(d.subject?.eventAt)
      && d.subject.eventAt + 6 * HOUR > at)
    .sort((a, b) => a.subject.eventAt - b.subject.eventAt).slice(0, 30)
    .map(d => ({
      id: d.id, kind: d.kind ?? null, category: d.category ?? null, status: d.status, eventAt: d.subject.eventAt,
      ponrAt: finite(d.ponrAt) ? d.ponrAt : null, place: placeName(d.subject.placeId),
      with: (Array.isArray(d.subject.castIds) ? d.subject.castIds : []).map(name).slice(0, 4),
      options: (Array.isArray(d.options) ? d.options : []).map(o => ({ id: o.id, label: typeof o.label === 'string' ? o.label.slice(0, 80) : o.id })),
      committed: d.status === 'committed' ? (d.committed?.optionId ?? null) : null,
      ...(pendingMod.isChatDecision(d) ? { fromChat: true, realPerson: !!d.subjectJid } : {}),
      outcome: s.story?.outcomes?.[d.id]?.status === 'set' ? s.story.outcomes[d.id].outcome : null,
      outcomeEventId: s.story?.outcomes?.[d.id]?.eventId ?? null,
      // 016: the scene tone hint set for it, and whether one may be set (the planner's rule).
      tone: typeof s.story?.sceneTones?.[d.id]?.tone === 'string' ? s.story.sceneTones[d.id].tone : null,
      toneOutcome: typeof s.story?.sceneTones?.[d.id]?.outcome === 'string' ? s.story.sceneTones[d.id].outcome : null,
      toneable: safe(() => directorMod.sceneToneable(d), false) === true && !d.subjectJid,
    }));
  const cast = [...(s.cast instanceof Map ? s.cast.values() : [])].slice(0, 30).map(m => {
    const r = s.story?.relationships?.[m.id] ?? {};
    const num = (v) => (finite(v) ? Math.round(v * 100) / 100 : null);
    return {
      id: m.id, name: m.name, relation: m.relation ?? null,
      closeness: num(m.metrics?.closeness), trust: num(m.metrics?.trust), tension: num(m.metrics?.tension),
      intimacy: num(r.intimacy), passion: num(r.passion), commitment: num(r.commitment),
      pinned: !!s.story?.controls?.pins?.[m.id],
    };
  });
  // 017: the parts of one bundle apply share a groupId (the first part's action id); null alone.
  const groups = new Map();
  const groupIdOf = (e) => {
    const key = `${e.at}:${e.payload?.fingerprint ?? e.id}`;
    if (!groups.has(key)) {
      let run = [];
      try { run = directorGroup(e); } catch { run = []; }
      groups.set(key, run.length > 1 ? run[0].id : null);
    }
    return groups.get(key);
  };
  let changes = [];
  try {
    changes = listEvents({ types: ['director.action'], order: 'desc', limit: 20 })
      .filter(e => !isExcludedId(s, e.id))
      .map(e => ({ id: e.id, at: e.at, kind: typeof e.payload?.kind === 'string' ? e.payload.kind : null, count: e.payload?.count ?? null,
        description: changeDescription(e, s), groupId: groupIdOf(e) }));
  } catch { changes = []; }
  return {
    enabled: true,
    now: at, timezone: tz ?? null,
    career: {
      employed: c.employed !== false, title: c.employed === false ? null : (c.title ?? null), employerName: c.employed === false ? null : (c.employerName ?? null),
      salary: finite(c.salary) ? c.salary : null, office: placeName(c.officePlaceId), pattern: isObj(c.pattern) ? c.pattern : null,
      hunting: !!c.huntArcId, notice: isObj(c.notice),
    },
    money: finite(s.vitals?.money) ? Math.round(s.vitals.money) : null,
    home: { placeId: s.self?.homePlaceId ?? null, name: placeName(s.self?.homePlaceId) },
    sick: !!(s.sick || s.vitals?.sick === true),
    decisions, cast,
    places: [...(s.places instanceof Map ? s.places.values() : [])].slice(0, 48).map(p => ({ id: p.id, name: p.name, kind: p.kind ?? null })),
    arcs: Object.values(s.story?.arcs ?? {}).filter(a => a?.status === 'active').slice(0, 16)
      .map(a => ({ id: a.id, category: a.category, kind: a.kind, stage: a.stage, with: (a.castIds ?? []).map(name) })),
    departed: Object.values(isObj(s.story?.departed) ? s.story.departed : {}).slice(0, 30)
      .map(m => ({ id: m.id, name: m.name, relation: m.relation ?? null, how: m.how ?? null, at: m.departedAt ?? null })),
    pending: Object.entries(isObj(s.story?.pending) ? s.story.pending : {}).slice(0, 32)
      .map(([id, e]) => ({ id: Number(id), type: e?.type ?? null, dueAt: e?.due?.at ?? null, wakeDate: e?.due?.wakeDate ?? null })),
    changes,
  };
}

/**
 * sched-fixes: the CHANGES line of one Director change (changeText.js), from the
 * `director.action` (an event or its id), its owner / mind descendants and the
 * engine events those caused directly (a schedule edit's cancels). Parts already
 * undone are left out. Dashboard only. → string | null
 */
export function changeDescription(actionOrId, s = liveState()) {
  try {
    const action = typeof actionOrId === 'object' && actionOrId ? actionOrId : getEvent(Number(actionOrId));
    if (!action || action.type !== 'director.action') return null;
    const out = (id) => !!s && isExcludedId(s, id);
    const parts = [];
    const effects = [];
    const seen = new Set([action.id]);
    const queue = [action.id];
    while (queue.length && parts.length < 200) {
      const id = queue.shift();
      for (const ev of childEvents(id)) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (ev.actor === 'owner' || ev.actor === 'mind') { if (!out(ev.id)) { parts.push(ev); queue.push(ev.id); } }
        else if (id !== action.id && ev.type === 'decision.expired' && !out(ev.id)) effects.push(ev);
      }
    }
    // A tray adoption / claim scene lists its engine events by id.
    for (const id of Array.isArray(action.payload?.eventIds) ? action.payload.eventIds.filter(Number.isSafeInteger) : []) {
      if (seen.has(id)) continue;
      const ev = safe(() => getEvent(id), null);
      if (ev && !out(ev.id)) { seen.add(id); parts.push(ev); }
    }
    return changeText.describeChange({ action, parts, effects, state: s, tz: tzOf(s), eventOf: (id) => safe(() => getEvent(id), null) });
  } catch (err) {
    logger.debug({ err: err?.name || 'Error' }, 'story: change description skipped');
    return null;
  }
}

function initials(name) {
  const parts = typeof name === 'string' ? name.trim().split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean) : [];
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
}

// metVia is not on the projected cast record (the projector keeps a fixed field
// set): it lives in the member's cast.created payload. Memoized per event id
// (an appended event never changes; a redacted payload reads as none).
const metViaMemo = new Map();
/** The web's circle for a relation: home | work | family | friends. */
function webGroup(rel) {
  if (rel === 'flatmate') return 'home';
  if (rel === 'coworker' || rel === 'manager') return 'work';
  if (rel.startsWith('family:')) return 'family';
  return 'friends';
}

/** Created by the world seed at genesis (the engine), so he has always known them. */
function metAtGenesis(c) {
  const evId = posInt(c?.eventId);
  if (!evId) return true;
  const ev = safe(() => getEvent(evId), null);
  return !ev || ev.actor === 'engine';
}

function metViaOf(s, c) {
  const evId = posInt(c?.eventId);
  if (!evId) return null;
  if (!metViaMemo.has(evId)) {
    if (metViaMemo.size > 500) metViaMemo.clear();
    const ev = safe(() => getEvent(evId), null);
    const v = ev && !ev.redacted && ev.payload?.redacted !== true && typeof ev.payload?.metVia === 'string' ? ev.payload.metVia : null;
    metViaMemo.set(evId, v);
  }
  const via = metViaMemo.get(evId);
  return via && via !== c.id && s.cast instanceof Map && s.cast.has(via) ? via : null;
}

// The away beat's own text (a heavy onset's beat carries its theme label; the
// daily pass's carries none). Dashboard only: prompts read castOverlay.
function awayView(away) {
  if (!isObj(away)) return null;
  const ev = posInt(away.eventId) ? safe(() => getEvent(away.eventId), null) : null;
  const text = ev && !ev.redacted && typeof ev.payload?.text === 'string' ? ev.payload.text.slice(0, 120) : null;
  return { until: away.until ?? null, label: text, ...(away.heavy === true ? { heavy: true } : {}) };
}

const castText = (v, cap = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null);

function memberSummary(s, id, c) {
  const life = s.story?.castLife?.[id] ?? {};
  const rel = s.story?.relationships?.[id] ?? null;
  const ov = safe(() => fragmentMod.castOverlay(s, id, c, { kind: 'dashboard' }), {}) || {};
  const romanceOn = s.story?.romance?.partnerId === id && s.story?.romance?.stage && s.story.romance.stage !== 'single';
  const m = c.metrics ?? {};
  const via = metViaOf(s, c);
  return {
    id, name: c.name ?? id, initials: initials(c.name), relation: c.relation ?? null,
    label: ov.label ?? c.relation ?? null, age: finite(ov.age) ? ov.age : (finite(c.age) ? c.age : null),
    // Fictional cast fields (s.cast already carries the Director's cast.updated edits).
    pronouns: castText(c.pronouns, 24), job: castText(c.job, 80), employer: castText(c.employer, 80),
    personality: castText(c.personality), speech: castText(c.speech), hometown: castText(c.hometown), availability: castText(c.availability),
    birthday: typeof c.birthday === 'string' ? c.birthday : null,
    metVia: via ? (s.cast.get(via)?.name ?? via) : null, metViaId: via,
    status: life.status ?? c.status ?? null,
    away: awayView(life.away),
    metrics: { closeness: finite(m.closeness) ? m.closeness : null, trust: finite(m.trust) ? m.trust : null, tension: finite(m.tension) ? m.tension : null },
    ...(romanceOn && rel ? {
      romance: { stage: s.story.romance.stage, intimacy: rel.intimacy ?? 0, passion: rel.passion ?? 0, commitment: rel.commitment ?? 0,
        togetherH: Math.round(((rel.togetherMin ?? 0) / 60) * 10) / 10 },
    } : {}),
    pinned: !!pinOf(id, s),
  };
}

/** /api/arcs/cast */
export function castList() {
  const s = liveState();
  if (!storyOn() || !s) return [];
  try {
    return [...(s.cast instanceof Map ? s.cast.entries() : [])].map(([id, c]) => memberSummary(s, id, c));
  } catch { return []; }
}
export { castList as cast };

const CAST_EVENT_TYPES = ['cast.beat', 'cast.updated', 'cast.history_added', 'relationship.changed', 'cast.created', 'birthday', 'family.call',
  'scene.played'];   // 016
const METRIC_KEYS = ['closeness', 'trust', 'tension'];
const SERIES_MAX = 120;
const SERIES_PAGES = 4;       // ≤ 2000 relationship.changed rows per read
const SERIES_DELTA_MAX = 0.2; // the reducer's per-event clamp (reducer.js MAX_DELTA)
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * The member's closeness / trust / tension over time, oldest first, for the
 * cast member chart: walks back from the current metrics through their
 * relationship.changed events in fold (id) order, undoing each folded delta
 * (reverted / rewound / redacted ones never folded, so they are skipped). One
 * point per local day (its end-of-day value) plus "now" and the value before
 * the oldest change read. Approximate where the reducer clamped at 0 or 1.
 */
function metricSeries(s, castId, c) {
  const cur = isObj(c.metrics) ? c.metrics : {};
  const m = Object.fromEntries(METRIC_KEYS.map(k => [k, finite(cur[k]) ? cur[k] : null]));
  if (METRIC_KEYS.every(k => m[k] === null)) return [];
  const tz = tzOf(s);
  const at0 = finite(s.at) ? s.at : nowSec();
  const points = [{ at: at0, ...m }];
  const days = new Set([dateKey(at0, tz)]);
  let before = lastEventId() + 1;
  let oldest = null;
  for (let page = 0; page < SERIES_PAGES && points.length < SERIES_MAX; page++) {
    const rows = listEvents({ types: ['relationship.changed'], order: 'desc', before, limit: 500 });
    for (const e of rows) {
      if (e.payload?.castId !== castId || e.redacted || e.payload?.redacted === true || !isObj(e.payload?.delta)) continue;
      if (isExcludedId(s, e.id)) continue;
      const day = dateKey(e.at, tz);
      if (!days.has(day)) {
        days.add(day);
        points.push({ at: e.at, ...m });
        if (points.length >= SERIES_MAX) break;
      }
      for (const k of METRIC_KEYS) {
        const d = e.payload.delta[k];
        if (m[k] !== null && finite(d)) m[k] = clamp01(m[k] - Math.max(-SERIES_DELTA_MAX, Math.min(SERIES_DELTA_MAX, d)));
      }
      oldest = oldest === null ? e.at : Math.min(oldest, e.at);
    }
    if (rows.length < 500) break;
    before = rows[rows.length - 1].id;
  }
  if (oldest !== null && points.length < SERIES_MAX) points.push({ at: oldest - 60, ...m });
  const r2 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
  // Walked in id order; `at` is not monotone in id (catch-up writes past times), so sort for the chart.
  return points.reverse().sort((a, b) => a.at - b.at)
    .map(p => ({ at: p.at, closeness: r2(p.closeness), trust: r2(p.trust), tension: r2(p.tension) }));
}

// "trust −0.04 · closeness +0.01 · backed out" — code-built from the numbers and
// the closed reason codes (the earned-trust codes first, then the event's reason).
const CODE_RE = /^[a-z][a-z0-9_]{0,23}$/;
function relationshipSummary(p) {
  const d = isObj(p?.delta) ? p.delta : {};
  const nums = [...METRIC_KEYS, 'intimacy', 'passion', 'commitment']
    .filter(k => finite(d[k]) && d[k] !== 0)
    .map(k => `${k} ${d[k] > 0 ? '+' : '−'}${Math.abs(Math.round(d[k] * 1000) / 1000)}`);
  const why = [...(Array.isArray(p?.trustWhy) ? p.trustWhy : []), p?.reason]
    .filter(c => typeof c === 'string' && CODE_RE.test(c));
  const words = [...new Set(why)].slice(0, 4).map(c => c.replace(/_/g, ' '));
  return [...nums, ...words].join(' · ') || 'relationship.changed';
}

/** /api/arcs/cast/:id */
export function castDetail(castId, { before = null, limit = 50 } = {}) {
  const s = liveState();
  if (!storyOn() || !s || !(s.cast instanceof Map) || !s.cast.has(castId)) return null;
  try {
    const c = s.cast.get(castId);
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const rows = listEvents({ types: CAST_EVENT_TYPES, order: 'desc', limit: 500, ...(posInt(before) ? { before: posInt(before) } : {}) })
      .filter(e => !e.redacted && (e.payload?.castId === castId || (Array.isArray(e.payload?.castIds) && e.payload.castIds.includes(castId))))
      .slice(0, lim);
    const history = [
      ...(Array.isArray(s.story?.history?.[castId]) ? s.story.history[castId] : []).slice(-20),
      ...(Array.isArray(c.history) ? c.history : []).slice(-8),
    ];
    return {
      member: memberSummary(s, castId, c),
      history,
      metrics: safe(() => metricSeries(s, castId, c), []),
      events: rows.map(e => ({
        id: e.id, at: e.at, type: e.type, actor: e.actor, origin: e.originKind,
        excluded: isExcludedId(s, e.id),
        summary: e.type === 'cast.beat' ? `beat: ${e.payload?.kind ?? ''}`.trim()
          : e.type === 'relationship.changed' ? relationshipSummary(e.payload) : e.type,
      })),
      nextBefore: rows.length === lim ? rows[rows.length - 1].id : null,
      scenes: safe(() => castScenes(s, castId), []),   // 016
      standing: standingWorker.view(castId),   // 020 D2
    };
  } catch { return null; }
}

// ── 016 scene play-outs (operator view; never throw) ──────────────────────

const SCENE_ENDING_WORDS = Object.freeze({
  nothing: null, swapped_numbers: 'swapped numbers', plan_to_meet: 'planned to meet again', stayed_late: 'stayed late',
  left_early: 'left early', parted_badly: 'parted badly',
});

function scenePlaceLabel(s, placeId, negative) {
  if (!placeId) return null;
  return safe(() => placeLabelOf(s, placeId, { negative }), null) ?? null;
}

// D9: the frame names a venue only for a good moment — a flat or bad outcome, an awkward
// moment or a bad ending words it by its kind.
function sceneNegative(sc, detail) {
  return ['badly', 'flat'].includes(sc?.outcome) || ['parted_badly', 'left_early'].includes(sc?.ending)
    || (typeof detail?.awkward === 'string' && detail.awkward.trim() !== '');
}

// A scene's entry for the operator view: the folded one, else (a reverted scene) its
// scene.played payload — the log keeps the codes after the projection drops it (R32).
function sceneEntryOf(s, row) {
  const live = row ? s.story?.scenes?.[row.activityEventId] : null;
  if (live && live.eventId === row.eventId) return live;
  const ev = Number.isSafeInteger(row?.eventId) ? safe(() => getEvent(row.eventId), null) : null;
  if (ev?.type !== 'scene.played') return null;
  const p = ev.payload ?? {};
  return {
    eventId: ev.id, version: p.version ?? row.version, sceneId: p.sceneId ?? row.id, ending: p.ending ?? 'nothing',
    outcome: p.outcome ?? 'fine', chemistry: p.chemistry ?? null, castIds: Array.isArray(p.castIds) ? p.castIds : [],
    firstMeet: Array.isArray(p.firstMeet) ? p.firstMeet : [], mode: p.mode ?? row.mode, decisionId: p.decisionId ?? null,
    placeId: p.placeId ?? null, startAt: p.startAt ?? null, endedAt: p.endedAt ?? row.endedAt, kind: p.kind ?? null,
    tier: p.tier ?? row.tier ?? null, fallback: p.fallback === true, heavyWindow: p.heavyWindow === true, at: ev.at,
  };
}

// A scene's operator-view summary from its folded entry + row.
function sceneSummary(s, aid, sc, row) {
  const negative = sceneNegative(sc, row?.detail);
  return {
    sceneId: row?.id ?? sc.sceneId ?? null, eventId: sc.eventId, activityEventId: Number(aid), version: sc.version,
    at: sc.startAt ?? null, endedAt: sc.endedAt ?? null, kind: sc.kind ?? null, kindWords: kindPhrase(sc.kind ?? 'outing'),
    placeId: sc.placeId ?? null, place: scenePlaceLabel(s, sc.placeId, negative),
    castIds: sc.castIds ?? [], ending: sc.ending, endingWords: SCENE_ENDING_WORDS[sc.ending] ?? null,
    chemistry: sc.chemistry ?? null, outcome: sc.outcome, mode: sc.mode, tier: sc.tier ?? row?.tier ?? null,
    fallback: sc.fallback === true, highlight: typeof row?.detail?.highlight === 'string' ? row.detail.highlight : null,
    excluded: isExcludedId(s, sc.eventId),
  };
}

/** The member's scenes, newest first (≤ 20): castDetail.scenes — reverted ones too, marked excluded. */
function castScenes(s, castId) {
  const entries = Object.entries(isObj(s.story?.scenes) ? s.story.scenes : {})
    .filter(([, sc]) => Array.isArray(sc?.castIds) && sc.castIds.includes(castId));
  const liveIds = new Set(entries.map(([, sc]) => sc.eventId));
  const rows = new Map(safe(() => sceneStore.byEventIds(entries.map(([, sc]) => sc.eventId)), []).map(r => [r.eventId, r]));
  const out = entries.map(([aid, sc]) => ({ ...sceneSummary(s, aid, sc, rows.get(sc.eventId)), firstMeet: Array.isArray(sc.firstMeet) && sc.firstMeet.includes(castId) }));
  // Reverted scenes (the projection drops them): from the log, with their rows.
  const gone = safe(() => listEvents({ types: ['scene.played'], order: 'desc', limit: 200 }), [])
    .filter(e => !liveIds.has(e.id) && Array.isArray(e.payload?.castIds) && e.payload.castIds.includes(castId) && isExcludedId(s, e.id));
  const goneRows = new Map(safe(() => sceneStore.byEventIds(gone.map(e => e.id)), []).map(r => [r.eventId, r]));
  for (const e of gone) {
    const row = goneRows.get(e.id);
    if (!row || row.status === 'superseded') continue;   // a regenerate's old version: shown under its live one
    const sc = sceneEntryOf(s, row);
    if (sc) out.push({ ...sceneSummary(s, row.activityEventId, sc, row), firstMeet: sc.firstMeet.includes(castId) });
  }
  return out.sort((a, b) => (b.endedAt ?? b.at ?? 0) - (a.endedAt ?? a.at ?? 0)).slice(0, 20);
}

// 016 (plan §P2.5): the journal bullet's "how it went" — a live, full (self/owner-origin,
// fictional cast) scene of that activity.started: '<highlight> (<ending words>)', ≤ 160.
function journalSceneOf(ev, s) {
  const sc = s?.story?.scenes?.[ev?.id];
  if (!isObj(sc) || sc.mode !== 'full' || sc.heavyWindow === true || isExcludedId(s, sc.eventId)) return null;   // never a heavy_window scene (R1)
  const row = safe(() => sceneStore.getByEvent(sc.eventId), null);
  const hl = typeof row?.detail?.highlight === 'string' ? row.detail.highlight : null;
  if (!hl || !sceneStore.LIVE_STATUSES.includes(row.status)) return null;
  const end = SCENE_ENDING_WORDS[sc.ending];
  return `${hl}${end ? ` (${end})` : ''}`.slice(0, 160);
}

// The dashboard's person label for {FRIEND} (operator view: the push name), via the life facade's seam.
let operatorPersonLabel = null;
/** Life facade: fn(jid) → a display name for the dashboard's scene view (or null). */
export function setScenePersonLabel(fn) {
  operatorPersonLabel = typeof fn === 'function' ? fn : null;
}

function resolveScene(id, s) {
  const n = posInt(id);
  if (!n) return null;
  // An id is a story_scenes row id, else a scene.played event id.
  return safe(() => sceneStore.getScene(n), null) ?? safe(() => sceneStore.getByEvent(n), null);
}

/**
 * GET /api/arcs/scenes/:id (plan §P1.9; operator view): `id` = a scene row id or its
 * scene.played event id. → { scene, versions, effects, text, editedText, detail, … } | null
 * A real person's scene shows their push name in place of {FRIEND} (the dashboard sees all).
 */
export function sceneDetail(id) {
  const s = liveState();
  if (!storyOn() || !s) return null;
  try {
    const row = resolveScene(id, s);
    if (!row) return null;
    const folded = s.story?.scenes?.[row.activityEventId] ?? null;
    const live = !!folded && folded.eventId === row.eventId;
    // A reverted / superseded version reads its own scene.played payload (R32): a revert never blanks the panel.
    const sc = live ? folded : (sceneEntryOf(s, row) ?? folded);
    const friend = row.mode === 'self_only' && row.subjectJid
      ? (safe(() => operatorPersonLabel?.(row.subjectJid), null) || 'a friend') : null;
    const swap = (t) => (typeof t === 'string' ? (friend ? t.split(FRIEND).join(friend) : t) : null);
    // Its effects: the relationship deltas (caused by it) and the companions naming it (D15) —
    // a companion still live after the scene went was lived and kept.
    const sceneGoneNow = Number.isSafeInteger(row.eventId) && isExcludedId(s, row.eventId);
    const effects = Number.isSafeInteger(row.eventId)
      ? [...safe(() => childEvents(row.eventId), []).filter(e => e.actor === 'engine'),
        ...safe(() => listEvents({ types: ['scene.followup', 'arc.started'], after: row.eventId, limit: 200 }), [])
          .filter(e => e.payload?.sceneEventId === row.eventId)].map(e => ({
        id: e.id, type: e.type, castId: e.payload?.castId ?? e.payload?.castIds?.[0] ?? null,
        summary: e.type === 'relationship.changed' ? relationshipSummary(e.payload)
          : e.type === 'arc.started' ? 'romance: interested' : e.type === 'scene.followup' ? 'planning to meet again' : e.type,
        excluded: isExcludedId(s, e.id),
        kept: e.type !== 'relationship.changed' && sceneGoneNow && !isExcludedId(s, e.id),
      }))
      : [];
    const detail = isObj(row.detail) ? row.detail : {};
    // Who was there (the dashboard's chips and "<NAME> THOUGHT" labels): fictional cast only.
    const firstMeet = new Set(Array.isArray(detail.firstMeet) ? detail.firstMeet : Array.isArray(sc?.firstMeet) ? sc.firstMeet : []);
    const castOf = (id) => s.cast?.get?.(id) ?? s.story?.departed?.[id] ?? null;
    const person = (id) => ({ castId: id, name: castOf(id)?.name ?? id, pronouns: castOf(id)?.pronouns ?? null, firstMeet: firstMeet.has(id) });
    const castIds = Array.isArray(sc?.castIds) ? sc.castIds : [];
    const impSide = (list) => (Array.isArray(list) ? list.map(x => (isObj(x) ? { ...person(x.castId), text: swap(x.text) } : null)).filter(Boolean) : []);
    const impressions = isObj(detail.impressions) ? { him: impSide(detail.impressions.him), them: impSide(detail.impressions.them) } : null;
    return {
      sceneId: row.id, eventId: row.eventId ?? null, activityEventId: row.activityEventId, version: row.version,
      at: sc?.startAt ?? null, kind: sc?.kind ?? null, kindWords: sc?.kind ? kindPhrase(sc.kind) : null,
      place: sc ? scenePlaceLabel(s, sc.placeId, sceneNegative(sc, row.detail)) : null,
      with: castIds.map(person), realPerson: !!friend, friend,
      fallback: row.status === 'fallback' || sc?.fallback === true,
      excluded: Number.isSafeInteger(row.eventId) && isExcludedId(s, row.eventId),
      // REGENERATE: a live version, or a reverted one while its outing is in his day and nothing else is live (R32).
      regenerable: row.mode !== 'self_only' && (live || (row.status === 'reverted' && !folded
        && safe(() => getEvent(row.activityEventId), null) && !isExcludedId(s, row.activityEventId)
        // the worker's rule: no newer version but a failed rewrite
        && safe(() => { const top = sceneStore.versionsOf(row.activityEventId)[0]; return !top || top.id === row.id || top.status === 'skipped'; }, false))),
      heavyWindow: row.heavyWindow === true || sc?.heavyWindow === true,
      status: row.status, live, skipReason: row.skipReason ?? null, tier: row.tier ?? null, mode: row.mode ?? null,
      model: row.model ?? null, fellBack: row.fellBack === true, endedAt: row.endedAt, finishedAt: row.finishedAt ?? null,
      text: swap(row.text), editedText: swap(row.editedText ?? null), editedAt: row.editedAt ?? null,
      tone: row.tone ?? null, toneOutcome: row.toneOutcome ?? null,
      impressions, topics: Array.isArray(detail.topics) ? detail.topics.map(swap) : [],
      highlight: swap(detail.highlight ?? null), awkward: swap(detail.awkward ?? null),
      chemistry: detail.chemistry ?? null, ending: detail.ending ?? sc?.ending ?? null,
      endingWords: SCENE_ENDING_WORDS[detail.ending ?? sc?.ending] ?? null,
      outcome: detail.outcome ?? sc?.outcome ?? null, outcomeBy: detail.outcomeBy ?? null,
      summary: sc ? sceneSummary(s, row.activityEventId, sc, row) : null,
      effects,
      revertible: live && !!sc && !isExcludedId(s, row.eventId),
      versions: safe(() => sceneStore.versionsOf(row.activityEventId), []).map(v => ({
        sceneId: v.id, version: v.version, status: v.status, eventId: v.eventId ?? null, tier: v.tier ?? null,
        skipReason: v.skipReason ?? null, createdAt: v.createdAt, toneOutcome: v.toneOutcome ?? null,
      })),
    };
  } catch { return null; }
}

// ── 020 E1: the nightly sweep's seams (the life facade imports nothing from story/ but this file) ──

const SWEEP_KEYS = Object.freeze(['sweep_findings', 'sweep_dismissed']);

/** The sweep's stored values: { findings: {value, corrupt}, dismissed: {value, corrupt} }. */
export function sweepStateRead() {
  return { findings: store.getStateChecked(SWEEP_KEYS[0]), dismissed: store.getStateChecked(SWEEP_KEYS[1]) };
}

export function sweepStateWrite({ findings, dismissed } = {}) {
  store.patchState({ ...(findings !== undefined ? { sweep_findings: findings } : {}), ...(dismissed !== undefined ? { sweep_dismissed: dismissed } : {}) });
}

/** What the plan step decided on recent texts (the ring), for the sweep. Codes only. */
export function phonePlanOutcomes() {
  return phoneStore.planOutcomes();
}

/** Which of these phone.message turns plainly say a meeting is on: [{ eventId, cue }]. Code words only. */
export function phoneStrongCues(eventIds) {
  const out = [];
  for (const r of phoneStore.byEventIds(eventIds)) {
    if (r.status !== 'live') continue;
    const cue = strongCue(r.editedText || r.text || '');
    if (cue) out.push({ eventId: r.eventId, cue });
  }
  return out;
}

/** Do these scenes' stored "afterwards" lines still match the log? [{ eventId, stale }]. */
export function sceneAfterwardsCheck(eventIds) {
  return sceneWorker.afterwardsCheck(eventIds);
}

/** Scenes of a time range for the Day page (plan §P1.9): [{…summary}] for live scenes ended in [from, to]. */
export function scenesBetween(from, to) {
  const s = liveState();
  if (!storyOn() || !s) return [];
  try {
    const entries = Object.entries(isObj(s.story?.scenes) ? s.story.scenes : {})
      .filter(([, sc]) => finite(sc.endedAt) && sc.endedAt >= from && sc.endedAt <= to);
    const rows = new Map(safe(() => sceneStore.byEventIds(entries.map(([, sc]) => sc.eventId)), []).map(r => [r.eventId, r]));
    return entries.map(([aid, sc]) => sceneSummary(s, aid, sc, rows.get(sc.eventId))).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  } catch { return []; }
}

/** 020 C1: the facts of an outing under way (scenes/worker.liveContext), or null. */
export function liveContext(startEv, endAt) {
  if (!storyOn()) return null;
  return sceneWorker.liveContext(startEv, endAt);
}

// The owner's tone hint (plan §P2.3): the Director's owner-text rules + wishProblem
// (JIDs, phone numbers, real names) + no bad thing at a named venue. Throws StoryError.
// Real people's names for owner text (always a fresh read; a throw → names_unavailable).
function realNamesNow() {
  const names = testDeps.knownNames ? testDeps.knownNames() : realPeopleNames();
  if (!Array.isArray(names)) throw new Error('names');
  return names;
}

const SCENE_OUTCOME_WORDS = Object.freeze(['well', 'fine', 'flat', 'badly']);

export function cleanSceneTone(tone) {
  if (tone === null || tone === undefined || tone === '') return null;
  let names;
  try { names = realNamesNow(); } catch { throw storyError('refused', 'names_unavailable'); }
  const t = directorMod.cleanOwnerText(tone, 120, { knownNames: names }, { field: 'tone' });
  const s = liveState();
  const castNames = [...(s?.cast instanceof Map ? s.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  const p = promptMod.wishProblem(t, names, castNames);
  if (p) throw storyError('invalid', p, { field: 'tone' });
  if (safe(() => negativeAtVenue(t, venueNamesNow()), true)) throw storyError('invalid', 'negative_at_venue', { field: 'tone' });
  return t;
}

/**
 * POST /api/arcs/scenes/:id/regenerate (plan §P2.4): a new version of a live scene, or of
 * a reverted one whose outing is still in his day (R32). An optional owner tone (cleaned
 * like the Director's text) needs its outcome word (well / fine / flat / badly, R23), which
 * sets the outcome (outcomeBy owner); without a tone the stored v1 outcome stands (R16).
 * The old live version is reverted with its effects only when the new one is valid.
 * A real person's scene is code-written and never regenerated (D17: real_person).
 * → { status: 'done'|'failed'|'refused', reason?, sceneId?, eventId? }; throws StoryError.
 */
export async function sceneRegenerate(id, { tone = null, outcome = null, by = 'owner' } = {}) {
  requireOn();
  const s = liveState();
  const row = resolveScene(id, s);
  if (!row) throw storyError('not_found');
  if (row.mode === 'self_only') throw storyError('refused', 'real_person');
  const t = cleanSceneTone(tone);
  let o = null;
  if (t) {
    if (!SCENE_OUTCOME_WORDS.includes(outcome)) throw storyError('invalid', 'outcome_required', { field: 'outcome' });
    const decisionId = s?.story?.scenes?.[row.activityEventId]?.decisionId
      ?? safe(() => getEvent(row.eventId)?.payload?.decisionId, null);
    const owner = Number.isSafeInteger(decisionId) ? s?.story?.outcomes?.[decisionId]?.outcome : null;
    if ((owner === 'well' || owner === 'badly') && owner !== outcome) throw storyError('refused', 'outcome_conflict');
    o = outcome;
  } else if (outcome !== null && outcome !== undefined && outcome !== '') {
    throw storyError('invalid', 'tone_required', { field: 'tone' });
  }
  return enqueue('scene_regen', () => sceneWorker.regenerate(row.id, { tone: t, outcome: o, by }));
}

/** A long outing (the sheet, or the activity span) uses the longer edit cap. */
function editCap(row) {
  let minutes = 0;
  if (row?.sheet?.long === true || Number(row?.sheet?.time?.minutes) >= LONG_MINUTES) minutes = LONG_MINUTES;
  else {
    try {
      const start = getEvent(row?.activityEventId);
      const ended = Number(getEvent(row?.eventId)?.payload?.endedAt);
      if (start && Number.isFinite(start.at) && Number.isFinite(ended) && (ended - start.at) / 60 >= LONG_MINUTES) minutes = LONG_MINUTES;
    } catch { /* the short cap */ }
  }
  const base = Number(config.arcs?.sceneMaxChars ?? 1200);
  return { maxChars: sceneTextCap(minutes, base), parasMax: sceneParasCap(minutes) };
}

/**
 * PUT /api/arcs/scenes/:id/text (plan §P2.4): the owner's edit of the narration (no
 * world event, effects unchanged). '' clears the edit. A real person's scene is code text
 * and is never edited (D17: real_person). → { ok:true, sceneId, length } | throws StoryError
 */
export function sceneEditText(id, text, { by = 'owner' } = {}) {
  void by;
  requireOn();
  const s = liveState();
  const row = resolveScene(id, s);
  if (!row || !sceneStore.LIVE_STATUSES.includes(row.status)) throw storyError('not_found');
  if (row.mode === 'self_only') throw storyError('refused', 'real_person');
  if (text === '' || text === null) {
    sceneStore.setEditedText(row.id, null, nowSec());
    checkSweepMemo.at = 0;   // 020 E3: words changed, so the next read or job sweeps
    return { ok: true, sceneId: row.id, length: 0 };
  }
  if (typeof text !== 'string' || text.length > 4000) throw storyError('invalid', 'bad_text');
  let names;
  try { names = realNamesNow(); } catch { throw storyError('refused', 'names_unavailable'); }
  const castNames = [...(s.cast instanceof Map ? s.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  if (safe(() => negativeAtVenue(text, venueNamesNow()), true)) throw storyError('invalid', 'negative_at_venue');
  const cap = editCap(row);
  const v = validateEditedText(text, { mode: row.mode, maxChars: cap.maxChars, parasMax: cap.parasMax, knownNames: names, castNames });
  if (!v.ok) throw storyError('invalid', v.reason);
  sceneStore.setEditedText(row.id, v.text, nowSec());
  checkSweepMemo.at = 0;   // 020 E3: words changed, so the next read or job sweeps
  return { ok: true, sceneId: row.id, length: v.text.length };
}

/**
 * The per-turn scene memory (plan §P1.8) for the life facade's sceneLines:
 * [] | [block]. opts: { at, recentText, imitating, mode, heavyActive, personLabel }.
 */
export function sceneMemory(state, audience, opts = {}) {
  if (!storyOn() || config.arcs?.scenesEnabled === false) return [];
  try {
    return sceneMemoryMod.sceneMemory(state, audience, { ...opts, tz: tzOf(state), heavyActive: opts.heavyActive ?? heavyGuardActive(state, opts.at ?? nowSec()) });
  } catch { return []; }
}

/** The public exporter's text reader (plan §P3): full, live scenes only. */
/** REVERT THIS CHANGE's continuity line for a lived outing (continuity.laterTripsFrom). Never throws. */
export function revertTripsWarnings(args) {
  try { return continuityMod.laterTripsFrom(args); } catch { return []; }
}

export function publicScenes(sceneEventIds) {
  try { return sceneMemoryMod.publicScenes(sceneEventIds); } catch { return []; }
}

// ── 019 his phone (operator view + owner writes; reads never throw) ─────────

const PHONE_PREVIEW = 80;
const memberName = (s, id) => s?.cast?.get?.(id)?.name ?? s?.story?.departed?.[id]?.name ?? null;

/**
 * GET /api/arcs/phone: one row per member — every active member, plus a departed one with
 * texts — newest conversation first, members without texts after (by name).
 * → [{ castId, name, departed, count, last: { at, dir, preview } | null }]
 */
export function phoneThreads() {
  const s = liveState();
  if (!s) return [];
  try {
    const sums = new Map(phoneStore.threadSummaries().map(r => [r.castId, r]));
    const ids = new Set([...(s.cast instanceof Map ? s.cast.keys() : []), ...sums.keys()]);
    const out = [];
    for (const id of ids) {
      const name = memberName(s, id);
      if (!name) continue;
      const sum = sums.get(id);
      const last = sum ? phoneStore.lastLive(id) : null;
      out.push({
        castId: id, name, departed: !(s.cast instanceof Map && s.cast.has(id)), count: sum?.count ?? 0,
        last: last ? { at: last.at, dir: last.dir, preview: String(last.editedText || last.text || '').replace(/\s*\n+\s*/g, ' / ').slice(0, PHONE_PREVIEW) } : null,
      });
    }
    return out.sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || String(a.name).localeCompare(String(b.name)));
  } catch {
    return [];
  }
}

/**
 * GET /api/arcs/phone/:castId: one member's thread, oldest → newest, live and undone
 * turns (status). Paging: `before` (unix) with an optional `beforeId` (the oldest row
 * shown at that second). Unknown member → null.
 * → { castId, name, departed, messages: [{ id, eventId, at, dir, text, edited, status, tier, trigger, revertible, regenerable }] }
 */
export function phoneThread(castId, { before = null, beforeId = null, limit = 50 } = {}) {
  const s = liveState();
  if (!s || typeof castId !== 'string') return null;
  try {
    const name = memberName(s, castId);
    if (!name) return null;
    const rows = phoneStore.threadOf(castId, { before: posInt(before), beforeId: posInt(beforeId), limit: Math.max(1, Math.min(100, Number(limit) || 50)) });
    const newest = phoneStore.lastLive(castId);
    const messages = rows.reverse().map(r => {
      const live = r.status === 'live' && posInt(r.eventId) && !isExcludedId(s, r.eventId);
      return {
        id: r.id, eventId: r.eventId ?? null, at: r.at, dir: r.dir, text: r.editedText || r.text || '', edited: !!r.editedText,
        status: live ? 'live' : r.status === 'live' ? 'reverted' : r.status, tier: r.tier ?? null, trigger: r.trigger,
        revertible: !!live, regenerable: !!live && newest?.id === r.id && s.cast instanceof Map && s.cast.has(castId),
      };
    });
    return { castId, name, departed: !(s.cast instanceof Map && s.cast.has(castId)), messages };
  } catch {
    return null;
  }
}

// One live, still-logged turn by row id, else a StoryError.
function liveTurn(id, s) {
  const n = posInt(id);
  if (!n) throw storyError('invalid', 'bad_id');
  const row = safe(() => phoneStore.getMessage(n), null);
  if (!row) throw storyError('not_found');
  if (row.status !== 'live' || !posInt(row.eventId) || isExcludedId(s, row.eventId)) throw storyError('refused', 'reverted');
  return row;
}

/**
 * PUT /api/arcs/phone/messages/:id/text: the owner's edit of one turn's words (no world
 * event; the effects stay). Lines are bubbles; '' clears the edit. → { ok:true, id, length } | throws StoryError
 * (invalid: too_long / real_name / jid_in_text / empty / bad_text / explicit; refused: reverted)
 */
// The phone validator for owner-written words in a thread (an edit, or the opening text of an
// owner's `text` with `words`): the register that thread would have now (desire.js, unchanged),
// the real-name / identifier / heat rules. → { ok, text } | { ok:false, reason }
function phoneOwnerWords(text, castId, s, { tone = null } = {}) {
  let names;
  try { names = (testDeps.knownNames ?? realPeopleNames)(); } catch { return { ok: false, reason: 'names_unavailable' }; }
  if (!Array.isArray(names)) return { ok: false, reason: 'names_unavailable' };
  const castNames = [...(s.cast instanceof Map ? s.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  const at = nowSec();
  const tz = tzOf(s);
  let age = null;
  try { const n = Number(getPersona()?.age); age = Number.isFinite(n) ? n : null; } catch { age = null; }
  let threadExplicit = false;
  try {
    threadExplicit = phoneStore.threadOf(castId, { live: true, limit: 12 }).some(r => contentProblem(r.editedText || r.text) === 'explicit');
  } catch { threadExplicit = false; }
  const register = registerOf(s, castId, {
    age, urge: urgeNow(s, { now: at, tz }),
    private: phonePrivate({ hour: localParts(at, tz).hour, atHome: isHomeKind(s, s.activity?.placeId), threadExplicit }),
    heavy: heavyGuardActive(s, at) === true,
    sick: s?.vitals?.sick === true || s?.activity?.kind === 'sick',
    ...(tone ? { tone } : {}),
  });
  return validatePhoneEdit(text, { names: castNames, knownNames: names, castNames, venueNames: safe(() => venueNamesNow(), []), register });
}

function phoneWordsCheck(text, castId, s, { tone = null } = {}) {
  const v = phoneOwnerWords(text, castId, s, { tone });
  if (!v.ok) return v;
  if (!v.text) return { ok: false, reason: 'empty' };
  return v;
}

export function phoneEdit(id, text) {
  requireOn();
  const s = liveState();
  const row = liveTurn(id, s);
  const v = phoneOwnerWords(text, row.castId, s);
  if (!v.ok && v.reason === 'names_unavailable') throw storyError('refused', 'names_unavailable');
  if (!v.ok) throw storyError('invalid', v.reason);
  phoneStore.setEditedText(row.id, v.text, nowSec());
  checkSweepMemo.at = 0;   // 020 E3: words changed, so the next read or job sweeps
  return { ok: true, id: row.id, length: v.text.length };
}

/**
 * POST /api/arcs/phone/messages/:id/regenerate: the owner's REWRITE of the newest turn of a
 * thread (a new turn replaces it; its effects and pending answer go with the old one).
 * → { ok:true, id, eventId } | throws StoryError (not_found; refused: reverted / not_newest / departed / caps / model codes)
 */
export async function phoneRegenerate(id) {
  requireOn();
  const s = liveState();
  const row = liveTurn(id, s);
  if (!phoneWorker.isNewest(row)) throw storyError('refused', 'not_newest');
  const r = await enqueue('phone_regen', () => phoneWorker.regenerate(row.id));
  if (r?.status !== 'live') throw storyError(r?.reason === 'not_found' ? 'not_found' : 'refused', String(r?.reason ?? 'failed').slice(0, 48));
  return { ok: true, id: r.id, eventId: r.eventId };
}

/** Urge 0–100 at `at`. Stage does not change it. 0 if the read fails. */
export function urgeOf(state, at = nowSec()) {
  try {
    const tz = tzOf(state);
    let ids = [];
    try { ids = phoneStore.listLive({ since: at - 86400, limit: 40 }).map(r => r.castId); } catch { ids = []; }
    return urgeNow(state, { now: at, tz, sawInterest: sawInterestOf(state, ids, at) });
  } catch { return 0; }
}

/** The per-turn phone memory (the life facade's phoneLines): [] | [block]. opts: { at, imitating, mode, heavyActive } */
export function phoneMemory(state, audience, opts = {}) {
  if (!storyOn() || config.arcs?.phoneEnabled === false) return [];
  try {
    return phoneMemoryMod.phoneMemory(state, audience, { ...opts, tz: tzOf(state), heavyActive: opts.heavyActive ?? heavyGuardActive(state, opts.at ?? nowSec()) });
  } catch { return []; }
}

/** The public exporter's text reader: live turns outside a heavy window. → Map(eventId → text) */
export function publicPhone(eventIds) {
  try { return phoneMemoryMod.publicPhone(eventIds); } catch { return new Map(); }
}

/** The scene sheet's "texting lately" (counts + tones per member, last 3 days). */
export function recentTexting(castIds, at = nowSec()) {
  try { return phoneWorker.recentTexting(Array.isArray(castIds) ? castIds : [], at); } catch { return {}; }
}

/**
 * 019 (owner 2026-11-01): the pulse's sleep seam for his phone — an engaging chat at bedtime pushes
 * his sleep 30 min (engine `sleep.delayed`, caused by the newest turn, `reason: 'phone'`); asked again
 * at the pushed start, so it runs on while the chat does, never into his last hour of sleep. Live only.
 */
export function phoneBeforeSleep(s, at, block, add) {
  try {
    if (!att || !storyOn() || config.arcs?.phoneEnabled === false || typeof add !== 'function') return false;
    if (block?.kind !== 'sleep' || !finite(block.start) || !finite(block.end)) return false;
    const tickSec = (Number(config.life?.tickMinutes) > 0 ? Number(config.life.tickMinutes) : 15) * 60;
    if (testDeps.now ? false : Math.abs(at - nowSec()) > 2 * tickSec) return false;   // live only (never a sim)
    if (isPaused(s)) return false;
    const chat = phoneWorker.activeChat(at);
    if (!chat || !posInt(chat.eventId)) return false;
    const until = Math.max(at, block.start) + 30 * 60;
    if (until > block.end - 3600) return false;
    const prior = s?.sleep?.delayedFor;
    const total = (finite(prior?.totalMin) ? prior.totalMin : 0) + 30;
    add({ type: 'sleep.delayed', at, actor: 'engine', causeId: chat.eventId,
      payload: { minutes: 30, until, totalMin: total, date: s?.plan?.date ?? null, reason: 'phone' } });
    logger.info({ evt: 'arcs.phone.sleep', totalMin: total }, 'story: an active chat keeps him up');
    return true;
  } catch { return false; }
}

/** Wait for queued phone jobs, then run one now (tests / the dry runs). */
export async function runPhoneNow() {
  if (!att || !storyOn()) return null;
  return enqueue('phone_now', () => phoneJob());
}

/** Wait for queued scene jobs, then run one now (tests / the dry runs). */
export async function runScenesNow() {
  if (!att || !storyOn()) return null;
  return enqueue('scenes_now', () => scenesJob());
}

/** /api/arcs/web: cast only, no JIDs. */
export function web() {
  const s = liveState();
  if (!storyOn() || !s) return { nodes: [], edges: [] };
  try {
    const nodes = [{ id: 'self', label: 'self', initials: 'ME' }];
    const edges = [];
    const members = [...(s.cast instanceof Map ? s.cast.entries() : [])];
    const rels = isObj(s.story?.relationships) ? s.story.relationships : {};
    for (const [id, c] of members) {
      const rel = String(c.relation ?? '');
      // Met = part of his world from the start (the seed's cast) or any contact since.
      const r = rels[id];
      const met = metAtGenesis(c) || (isObj(r) && (r.lastContactAt != null || (finite(r.togetherMin) && r.togetherMin > 0)));
      nodes.push({ id, label: c.name ?? id, initials: initials(c.name), group: webGroup(rel), met });
      edges.push({ a: 'self', b: id, closeness: c.metrics?.closeness ?? null, tension: c.metrics?.tension ?? null, kind: rel === 'flatmate' ? 'flatmate' : 'self', met });
    }
    // How they came into his life: a dashed edge to the cast member who introduced them.
    for (const [id, c] of members) {
      const via = metViaOf(s, c);
      if (via) edges.push({ a: id, b: via, kind: 'metVia' });
    }
    const groupBy = (pred, kind) => {
      const ids = members.filter(([, c]) => pred(String(c.relation ?? ''))).map(([id]) => id);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) edges.push({ a: ids[i], b: ids[j], kind });
    };
    groupBy(r => r === 'coworker' || r === 'manager', 'coworkers');
    groupBy(r => r.startsWith('family:'), 'family');
    return { nodes, edges: edges.slice(0, 300) };
  } catch { return { nodes: [], edges: [] }; }
}

const ARC_BEAT_TYPES = ['arc.started', 'arc.stage', 'arc.ended', 'career.hunt', 'cast.beat'];
const ARC_BEATS_MAX = 3;

// A short code-built line for an arc's beat (dashboard only; the beat text is the seed's).
function arcBeatSummary(s, e) {
  const p = e.payload ?? {};
  const word = (v, cap = 40) => (typeof v === 'string' && v ? v.slice(0, cap) : '');
  switch (e.type) {
    case 'arc.started': return `started${word(p.stage) ? ` · ${word(p.stage)}` : ''}`;
    case 'arc.stage': return `stage → ${word(p.to) || '?'}`;
    case 'arc.ended': return `ended${word(p.outcome) ? ` · ${word(p.outcome)}` : ''}`;
    case 'career.hunt': return `job hunt ${word(p.phase)}`.trim();
    case 'cast.beat': {
      const name = (s.cast instanceof Map ? s.cast.get(p.castId)?.name : null) ?? p.castId ?? '?';
      return `${name}: ${word(p.kind)}${word(p.text, 120) ? ` · ${word(p.text, 120)}` : ''}`;
    }
    default: return e.type;
  }
}

// ≤ 3 newest beats of each arc from one read of the log: its own arc.* / career.hunt
// events, and beats of its cast while it ran. Reverted / rewound / redacted ones are skipped.
function arcBeats(s, arcs) {
  const out = new Map(arcs.map(a => [a.id, []]));
  if (!arcs.length) return out;
  const rows = safe(() => listEvents({ types: ARC_BEAT_TYPES, order: 'desc', before: lastEventId() + 1, limit: 500 }), []);
  for (const e of rows) {
    if (e.redacted || e.payload?.redacted === true || isExcludedId(s, e.id)) continue;
    const p = e.payload ?? {};
    for (const a of arcs) {
      const list = out.get(a.id);
      if (list.length >= ARC_BEATS_MAX) continue;
      const mine = e.type === 'arc.started' ? e.id === a.id
        : e.type === 'cast.beat'
          ? Array.isArray(a.castIds) && a.castIds.includes(p.castId) && e.at >= (a.startedAt ?? 0) && e.at <= (finite(a.endedAt) ? a.endedAt : Infinity)
          : posInt(p.arcId) === a.id;
      if (mine) list.push({ id: e.id, at: e.at, type: e.type, summary: arcBeatSummary(s, e) });
    }
  }
  return out;
}

const decisionView = (d) => (d ? { id: d.id, kind: d.kind, decideBy: d.decideBy ?? null, mode: d.mode ?? null } : null);
const byDecideBy = (a, b) => (a.decideBy ?? 0) - (b.decideBy ?? 0);

/** /api/arcs/story */
export function arcsBoard() {
  const s = liveState();
  if (!storyOn() || !s) return { categories: [] };
  try {
    const seed = seedFor(s);
    const arcs = Object.values(s.story?.arcs ?? {}).filter(isObj);
    const open = decisionsOf(s).filter(d => d.status === 'open' && CATEGORIES.includes(d.category));
    const careerInert = safe(() => career.careerStatus(s, seed)?.inert, null);
    const familyInert = safe(() => family.familyStatus(s, seed)?.inert, null);
    const active = (a) => (a.status === 'active' ? 0 : 1);
    const shown = new Map(CATEGORIES.map(category => [category, arcs.filter(a => a.category === category)
      .sort((a, b) => active(a) - active(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 10)]));
    const beats = arcBeats(s, [...shown.values()].flat());
    return {
      categories: CATEGORIES.map((category) => {
        const mine = shown.get(category);
        const onArc = new Set();
        const arcsOut = mine.map((a) => {
          // The arc's own next decision (decisions carry arcId; arc.decisionIds lists them too).
          const own = open.filter(d => d.arcId === a.id || (Array.isArray(a.decisionIds) && a.decisionIds.includes(d.id))).sort(byDecideBy)[0];
          if (own) onArc.add(own.id);
          return {
            id: a.id, kind: a.kind ?? null, stage: a.stage ?? null, status: a.status ?? null, since: a.stageAt ?? a.startedAt ?? null,
            startedAt: a.startedAt ?? null, endedAt: a.endedAt ?? null, outcome: a.outcome ?? null,
            castIds: Array.isArray(a.castIds) ? a.castIds.slice(0, 4) : [], lastBeats: beats.get(a.id) ?? [],
            nextDecision: decisionView(own),
          };
        });
        // The category's next decision that no arc card already shows.
        const next = open.filter(d => d.category === category && !onArc.has(d.id)).sort(byDecideBy)[0];
        const inert = category === 'career' ? careerInert : category === 'family' ? familyInert
          : category === 'romance' && !seed?.romance ? 'no_seed_section' : null;
        return {
          category, fate: fateOf(category, s),
          arcs: arcsOut,
          nextDecision: decisionView(next),
          ...(inert ? { inert } : {}),
        };
      }),
    };
  } catch { return { categories: [] }; }
}

/** /api/arcs/cards */
export function cards({ includeClosed = true } = {}) {
  const s = liveState();
  if (!storyOn() || !s) return [];
  return cards0(s, includeClosed);
}

/** /api/arcs/claims (the route joins life_claims). */
export function tray({ status: st = 'tray', limit = 50 } = {}) {
  if (!storyOn()) return [];
  return safe(() => store.listReviews({ status: st === 'tray' ? ['tray', 'returned'] : st, limit: Math.min(100, Math.max(1, Number(limit) || 50)) }), []);
}

/** /api/arcs/proposals */
export function proposals({ status: st = null, limit = 50 } = {}) {
  if (!storyOn()) return [];
  return safe(() => store.listProposals({ status: st, limit: Math.min(100, Math.max(1, Number(limit) || 50)) }), []);
}

/** /api/arcs/journal (latest night when none is given). */
export function journal({ nightKey = null } = {}) {
  if (!storyOn()) return null;
  try {
    const nk = nightKey ?? store.listNights({ limit: 1 })[0]?.nightKey ?? null;
    if (!nk) return { night: null, status: null, reason: null, parts: [] };
    const night = store.getNight(nk);
    const parts = store.listParts(nk).map(p => ({
      originKind: p.originKind, originLabel: p.originKind === 'self' ? 'self' : p.originKind,
      text: p.status === 'active' ? p.text : null, status: p.status,
    }));
    return { night: nk, status: night?.status ?? null, reason: night?.reason ?? null, parts };
  } catch { return null; }
}

/** /api/arcs/journal/nights */
export function journalNights({ limit = 30 } = {}) {
  if (!storyOn()) return [];
  try {
    return store.listNights({ limit: Math.min(60, Math.max(1, Number(limit) || 30)) })
      .map(n => ({ night: n.nightKey, status: n.status, parts: safe(() => store.listParts(n.nightKey).filter(p => p.status === 'active').length, 0) }));
  } catch { return []; }
}

/** /api/arcs/refusals */
export function refusals({ limit = 100 } = {}) {
  if (!storyOn()) return [];
  return safe(() => store.listRefusals({ limit: Math.min(200, Math.max(1, Number(limit) || 100)) }), []);
}

/** /api/director/bookmarks */
export function bookmarks() {
  const s = liveState();
  if (!storyOn() || !s) return [];
  try {
    const at = nowSec();
    const days = Number.isFinite(config.arcs?.rewindDays) ? config.arcs.rewindDays : 14;
    return (Array.isArray(s.story?.bookmarks) ? s.story.bookmarks : []).map((b) => {
      const ev = safe(() => getEvent(b.eventId), null);
      const t = finite(ev?.at) ? ev.at : (finite(b.at) ? b.at : null);
      return { id: b.id, name: b.name, eventId: b.eventId, at: t, inWindow: finite(t) && t >= at - days * DAY && !isExcludedId(s, b.eventId) };
    });
  } catch { return []; }
}

// ── Owner operations (dashboard; StoryError on refusal) ───────────────────

function requireOn() {
  if (!att || !liveState()) throw storyError('not_running');
  if (!storyOn()) throw storyError('not_running', 'off');
  return liveState();
}

/** The Director, gated on storyOn() (director-api §3). */
export const director = Object.freeze({
  plan(action) { const s = requireOn(); return directorMod.plan(action, s, { now: nowSec() }); },
  // 015: a hand-built preview (any source but the prompt) plans with relax — the
  // owner's pacing limits and guardrails come back as warnings (plan §1.4).
  async preview(action, { source = null } = {}) { requireOn(); return directorMod.preview(action, { relax: source !== 'prompt' }); },
  async apply(previewId, fingerprint, { by = 'owner' } = {}) {
    requireOn();
    const res = await directorMod.apply(previewId, fingerprint, { by });
    if (res?.schedule) kickSchedule();   // 014 sched (R36)
    if (res?.phone) kickPhone();         // 019: an owner's text goes out now, not at the next grid tick
    return res;
  },
  async previewTomorrow() { requireOn(); return directorMod.previewTomorrow(); },
  // Spec 011: words → drafts (nothing written; the owner previews and applies each).
  async prompt(wish, { by = 'owner' } = {}) {
    const s = requireOn();
    try {
      return await promptMod.runPrompt(wish, { by });
    } finally {
      await refreshPromptCache(nowSec(), tzOf(s));
    }
  },
  // 015 cont: the continuity story read of a preview (one mind call; drafts only, nothing written).
  async continuity(previewId, { by = 'owner' } = {}) {
    const s = requireOn();
    try {
      return await storyReadMod.runStoryRead(previewId, { by });
    } finally {
      await refreshContinuityCache(nowSec(), tzOf(s));
    }
  },
});

/**
 * One read-only run of the pulse from `now` over `hours` on a copy of the live
 * projection (Life · Day's projection; tomorrow.js simulate): no model calls,
 * nothing written. While the story is on its sim items and pulse seams ride
 * along, as in preview tomorrow; while it is off, 009's pulse alone.
 * opts: { state (default the live projection; never a view), now, hours, rng, sampleSec }
 * → { from, to, events, samples } | null (not attached)
 */
export async function simulate({ state = null, now, hours, rng = null, sampleSec = 0, descriptors = undefined, deadlineMs = undefined } = {}) {
  const s = state ?? liveState();
  if (!att || !s || !att.world) return null;
  const on = storyOn();
  const run = await simulateRun(s, att.world, {
    now, hours, rng, sampleSec,
    ...(descriptors !== undefined ? { descriptors } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}),   // 014 sched (R35)
    worldOf: (st) => worldOf(st, att?.world ?? null),
    ...(on ? {
      storyItems: (st, g, o = {}) => items(st, g, { ...o, sim: true }),
      blockCause: (plan, b) => planEditsBlockCause(plan, b),   // 014 sched (R29)
      planCause: (plan) => plan?.basePlanEventId ?? plan?.eventId,
      atWake: (st, at, add) => atWake(st, at, add, { sim: true }),   // 015
    } : {}),
  });
  return { from: run.from, to: run.to, events: run.log.events, samples: run.samples, ...(run.timedOut ? { timedOut: true } : {}) };
}

// 014 sched (R36): after an applied schedule edit, apply what is now due (the
// re-plan) at once instead of at the next grid tick. Not awaited by the route.
let scheduleKick = null;
function kickSchedule() {
  const pulse = att?.pulse;
  if (!pulse) return;
  const run = typeof pulse.settle === 'function' ? pulse.settle(nowSec()) : pulse.tick?.();
  // An owner's change can end an outing early: its scene comes now too (020 C4).
  scheduleKick = Promise.resolve(run).then(() => { if (storyOn() && config.arcs?.scenesEnabled !== false) queueScenes(); }).catch(err => logger.warn({ evt: 'issue', where: 'arcs.schedule', err: err?.code || err?.name }, 'story: schedule re-plan after apply failed'));
}

// 019: after an applied `text`, run the phone job at once (queued after the settle above, so a
// wake in the same apply is folded first). Not awaited by the route; a failure only logs.
let phoneKick = null;
function kickPhone() {
  if (!att || !storyOn() || config.arcs?.phoneEnabled === false) return;
  phoneKick = Promise.resolve(scheduleKick).then(() => enqueue('phone_now', () => phoneJob()))
    .catch(err => logger.warn({ evt: 'issue', where: 'arcs.phone', err: err?.code || err?.name }, 'story: phone job after apply failed'));
}

/** Tests: the phone job kicked by the last `text` apply (or null). */
export function lastPhoneKick() {
  return phoneKick;
}

/** Tests: the settle kicked by the last schedule apply (or null). */
export function lastScheduleKick() {
  return scheduleKick;
}

/** Owner pick on an Ask-me card (decisions.ownerCommit). → { eventId } */
export async function cardPick(decisionId, optionId, { by = 'owner' } = {}) {
  const s = requireOn();
  const id = posInt(decisionId);
  if (!id) throw storyError('invalid', 'decision');
  const d = s.decisions instanceof Map ? s.decisions.get(id) : null;
  if (!d) throw storyError('not_found', 'decision');
  if (d.status !== 'open') throw storyError('conflict', d.status === 'committed' ? 'already_committed' : 'not_open');
  try {
    const ev = await ownerCommit(() => att.getState(), id, optionId, { at: nowSec(), append: att.append, by });
    logger.info({ evt: 'arcs.card.pick', decisionId: id }, 'story: card pick');
    return { eventId: ev.id };
  } catch (err) {
    if (err?.code === 'not_found') throw storyError('not_found', 'decision');
    if (err?.code === 'expired') {
      const now = att.getState()?.decisions?.get?.(id);
      throw storyError('conflict', now?.status === 'committed' ? 'already_committed' : now?.status === 'open' ? 'expired_option' : 'not_open');
    }
    if (err?.code === 'invalid') throw storyError('invalid', 'option');
    throw storyError('conflict', 'apply_failed');
  }
}

/** Owner veto of a pending heavy proposal before its onset. → { eventId } */
export async function heavyVeto(proposedId, { by = 'owner' } = {}) {
  const s = requireOn();
  const id = posInt(proposedId);
  if (!id) throw storyError('invalid', 'proposal');
  const prop = s.story?.heavy?.proposals?.[id];
  if (!isObj(prop)) throw storyError('not_found', 'proposal');
  const at = nowSec();
  if (prop.status !== 'pending' || !(at < prop.onsetAt)) throw storyError('conflict', 'not_pending');
  const ev = att.append({ type: 'heavy.vetoed', at, actor: 'owner', causeId: id, payload: { proposedId: id } });
  logger.info({ evt: 'arcs.card.veto', proposedId: id, by: typeof by === 'string' ? by.slice(0, 40) : 'owner' }, 'story: heavy veto');
  return { eventId: ev.id };
}

function trayResult(r, reviewId) {
  if (r?.ok) return { claimId: store.getReview(reviewId)?.claimId ?? null };
  if (r?.reason === 'not_found') throw storyError('not_found', 'review');
  throw storyError('conflict', 'review_state');
}

export async function trayReject(reviewId, { by = 'owner' } = {}) {
  requireOn();
  const id = posInt(reviewId);
  if (!id) throw storyError('invalid', 'review');
  return trayResult(reconciler.trayReject(id, { by }), id);
}

export async function trayDismiss(reviewId, { by = 'owner' } = {}) {
  requireOn();
  const id = posInt(reviewId);
  if (!id) throw storyError('invalid', 'review');
  return trayResult(reconciler.trayDismiss(id, { by }), id);
}

/** A scene draft from a tray claim (structured ids only). */
export async function trayScene(reviewId) {
  requireOn();
  return directorMod.sceneDraftFromReview(reviewId);
}

export async function proposalReject(id, { by = 'owner' } = {}) {
  requireOn();
  const pid = posInt(id);
  if (!pid) throw storyError('invalid', 'proposal');
  const p = store.getProposal(pid);
  if (!p) throw storyError('not_found', 'proposal');
  if (p.status !== 'pending') throw storyError('conflict', 'not_pending');
  store.decideProposal(pid, { status: 'rejected', by: String(by || 'owner').slice(0, 100), at: nowSec() });
  return { id: pid };
}

export async function narrate(req, { by = 'owner' } = {}) {
  requireOn();
  return narrateMod.narrate(req, { by });
}

export async function journalRegenerate(nightKey, { by = 'owner' } = {}) {
  requireOn();
  return journalMod.regenerateNight(nightKey, { by });
}

export async function seedRegenerate({ by = 'owner' } = {}) {
  requireOn();
  void by;
  const r = await seedMod.regenerateArcSeed({
    world: att?.world ?? undefined,
    ...(testDeps.callRole ? { callRole: testDeps.callRole } : {}),
    ...((testDeps.mindBudgetOk ?? att?.mindBudgetOk) ? { mindBudgetOk: testDeps.mindBudgetOk ?? att.mindBudgetOk } : {}),
    ...(testDeps.getUsageByCaller ? { getUsageByCaller: testDeps.getUsageByCaller } : {}),
  });
  if (r?.status === 'refused' && r.reason === 'rate') throw storyError('rate', 'rate');
  seedMemo = { base: null, overlay: null, value: null };
  return r;
}

