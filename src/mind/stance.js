// A changing mind (plan 020 B): the flow around his interests and opinions. The rules are in
// stanceRules.js (pure), the SQL in store.js. Reached through the facade src/mind/index.js only.
//
// The starting set is one `mind` call over his identity and a catalogue of what's in his world
// (fictional names and codes, never a chat or a real person). It only drafts: rows wait as
// `proposed` and nothing reads them until the owner approves. Values live on the row; every owner
// action here is audited by the route. Logs carry codes and counts only.
import * as store from './store.js';
import { mindBudgetOk } from './think.js';
import { callRole } from '../brain/llm.js';
import { logger } from '../utils/logger.js';
import { now as clockNow, nightKey } from './clock.js';
import { EVIDENCE_NIGHTS, evidenceFrom, kindOfTopic, lineFor, lineLabel, neutralOf, raises, rangeOf, replay, trendOf, uptakeOf, voiced, whyWords } from './stanceRules.js';
import { nameTokens, realFirstNames } from '../memory/mindReads.js';
import { FREE_CHARTER, FREE_LIVE_MAX, ITEMS_MAX, ITEM_CHARS, MOVE_WEIGHT, cleanMoves, cleanProposals, parseReply, personaWords } from './stanceFree.js';
import { cleanChatText, fenceBlock } from './charter.js';
import { getPersona } from '../utils/config.js';
import { canUseIn } from '../memory/recall.js';
import { resolvePerson } from '../memory/identity.js';

const log = logger.child({ mod: 'mind' });
const SEED_MAX_TOKENS = 3000;
const SEED_MAX_TOPICS = 60;
const WHY_MAX = 160;
const WHY_LIST_MAX = 12;
const PROPOSED_CONFIDENCE = 0.5;
const NEW_TOPIC_CONFIDENCE = 0.3;
const HISTORY_NIGHTS = 180;
const HISTORY_MAX = HISTORY_NIGHTS + EVIDENCE_NIGHTS;

const DEFAULT_DEPS = {
  now: () => clockNow(),
  callRole: (role, system, user, opts) => callRole(role, system, user, opts),
  budgetOk: (kind) => mindBudgetOk(kind),
  identity: async () => (await import('../personality/systemPrompt.js')).identityCore(),
  life: async () => import('../life/index.js'),
  persona: () => getPersona(),
  realFirstNames: () => realFirstNames(),
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: { now, callRole, budgetOk, identity, life }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nowSec = () => Math.floor(deps.now());
const fail = (reason) => ({ ok: false, reason });

export const SEED_CHARTER = `You are setting down where a person stands on the things in their life, as a starting point that they will grow away from.
You are given who they are, then a list of topics. Give a value for the topics this person would plausibly have a view on, and leave out the rest.

An interest is 0 to 1: 0 has no time for it, 0.5 neutral, 1 loves it. An opinion is -1 to 1: -1 strongly against, 0 neutral, 1 strongly for.
People are uneven. Most views are mild, a few are strong, some are negative. Don't make everything positive.
Use only the topic ids given. Each "why" is one short plain sentence in the third person with no names of anyone not on the list.

Reply with JSON only: {"stances":[{"topic":"<id>","value":<number>,"why":"<sentence>"}]}`;

function catalogueTopics(cat) {
  const out = [];
  for (const [topic, label] of cat.kinds) out.push({ topic, label });
  for (const [topic, label] of cat.places) out.push({ topic, label });
  for (const [topic, label] of cat.cast) out.push({ topic, label });
  for (const [topic, label] of cat.fixed) out.push({ topic, label });
  return out.slice(0, SEED_MAX_TOPICS);
}

function parseSeed(text) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(j?.stances) ? j.stances : null;
  } catch { return null; }
}

/**
 * Validate the model's rows against the catalogue. Unknown topics are dropped, values clamped into
 * the topic's range, and a why that names a real person or carries an identifier is dropped.
 */
export function cleanSeed(rows, topics, textProblem = () => null) {
  const known = new Map(topics.map(t => [t.topic, t.label]));
  const out = new Map();
  for (const r of rows) {
    if (!known.has(r?.topic) || out.has(r.topic) || !finite(r.value)) continue;
    const kind = kindOfTopic(r.topic);
    const [lo, hi] = rangeOf(kind);
    const why = typeof r.why === 'string' ? r.why.trim().replace(/\s+/g, ' ').slice(0, WHY_MAX) : '';
    out.set(r.topic, {
      topic: r.topic, label: known.get(r.topic), kind, value: Math.round(Math.min(hi, Math.max(lo, r.value)) * 1000) / 1000,
      why: why && !textProblem(why) ? why : null,
    });
  }
  return [...out.values()];
}

/** One `mind` call → proposed rows. Nothing else happens until the owner approves. */
export async function seed() {
  const life = await deps.life();
  const cat = life?.stanceCatalogue?.();
  if (!cat) return fail('life_off');
  if (store.hasStances()) return fail('exists');
  const budget = await deps.budgetOk('think');
  if (budget !== true && budget?.ok !== true && budget?.allowed !== true) return fail('budget');
  const topics = catalogueTopics(cat);
  if (!topics.length) return fail('no_topics');
  const list = topics.map(t => `${t.topic} (${kindOfTopic(t.topic)}): ${t.label}`).join('\n');
  const user = `WHO THEY ARE\n${await deps.identity()}\n\nTOPICS\n${list}`;
  let res;
  try {
    res = await deps.callRole('mind', SEED_CHARTER, user, { caller: 'mind.stance.seed', effort: 'low', maxTokens: SEED_MAX_TOKENS });
  } catch (err) {
    log.warn({ evt: 'issue', code: err?.code ?? err?.name ?? 'error' }, 'mind: stance seed failed');
    return fail(err?.name === 'BudgetError' ? 'budget' : 'model_failed');
  }
  if (res?.skipped) return fail('budget');
  if (res?.status !== 'ok') return fail('model_failed');
  const rows = parseSeed(res.text);
  if (!rows) return fail('invalid');
  const clean = cleanSeed(rows, topics, (t) => life.stanceTextProblem?.(t) ?? null);
  if (!clean.length) return fail('invalid');
  store.stanceTx(() => {
    for (const c of clean) {
      store.putStance({ ...c, anchor: c.value, uptake: uptakeOf(c.topic), status: 'proposed', source: 'seed', confidence: PROPOSED_CONFIDENCE });
    }
  });
  log.info({ evt: 'mind', count: clean.length }, 'mind: stances proposed');
  return { ok: true, count: clean.length };
}

// ── owner ───────────────────────────────────────────────────────────────────

/** Approve the given proposed rows, or all of them. The first approval starts the evidence cursor. */
export async function approve(ids = null) {
  const life = await deps.life();
  // With no ids, the whole starting set. A free topic isn't part of it: code can't know names, brands or current affairs, so each one takes its own click.
  const proposed = store.listStances({ status: 'proposed' }).filter(r => (ids ? ids.includes(r.id) : !r.topic.startsWith('free:')));
  if (!proposed.length) return fail('nothing_proposed');
  // The cursor starts at the log's end, so nothing from before the owner's yes counts as evidence.
  const lastId = life?.stanceLastEventId?.();
  if (!Number.isSafeInteger(lastId)) return fail('life_off');
  const t = nowSec();
  const night = store.getSetting('stance_last_night', null);
  store.stanceTx(() => {
    if (store.getSetting('stance_cursor', null) === null) {
      store.setStanceSetting('stance_cursor', lastId);
      store.setStanceSetting('stance_cursor_at', t);
      store.setStanceSetting('stance_exclusion_sig', life?.stanceExclusionSig?.() ?? null);
    }
    for (const r of proposed) store.patchStance(r.id, { status: 'active', approvedAt: t, baseValue: r.value, baseConfidence: r.confidence, baseNight: night });
  });
  return { ok: true, approved: proposed.length };
}

/** Turn down a proposed row. A rejected topic drives nothing; a later seed may offer it again. */
export function reject(id) {
  const r = store.getStance(id);
  if (!r) return fail('not_found');
  if (r.status !== 'proposed') return fail('not_proposed');
  store.patchStance(id, { status: 'rejected' });
  return { ok: true };
}

/** Pin holds a value exactly where it is; unpin picks up from there. */
export function setPinned(id, pinned) {
  const r = store.getStance(id);
  if (!r) return fail('not_found');
  if (r.pinned === pinned) return { ok: true, unchanged: true };
  const night = store.getSetting('stance_last_night', null);
  store.patchStance(id, { pinned, baseValue: r.value, baseConfidence: r.confidence, baseNight: night, baseSince: 0 });
  return { ok: true };
}

/** Where he returns to. A proposed row's value moves with it, since it hasn't started moving yet. */
export function setAnchor(id, anchor) {
  const r = store.getStance(id);
  if (!r) return fail('not_found');
  if (r.status === 'rejected') return fail('rejected');
  const [lo, hi] = rangeOf(r.kind);
  if (!finite(anchor) || anchor < lo || anchor > hi) return fail('out_of_range');
  const v = Math.round(anchor * 1000) / 1000;
  if (r.status === 'proposed') store.patchStance(id, { anchor: v, value: v, baseValue: v });
  else store.stanceTx(() => { store.patchStance(id, { anchor: v }); recompute(store.getStance(id)); });
  return { ok: true, anchor: v };
}

/** Back to the anchor: what moved it is cleared. */
export function reset(id) {
  const r = store.getStance(id);
  if (!r) return fail('not_found');
  if (r.status !== 'active' && r.status !== 'archived') return fail('not_active');
  const night = store.getSetting('stance_last_night', null);
  store.stanceTx(() => {
    store.deleteStanceEvidenceOf(id, { keepCited: true });
    store.deleteStanceHistoryOf(id);
    store.patchStance(id, { value: r.anchor, baseValue: r.anchor, baseConfidence: PROPOSED_CONFIDENCE, confidence: PROPOSED_CONFIDENCE, baseNight: night, baseSince: 0, lastReinforcedAt: null });
  });
  return { ok: true };
}

// ── nightly + undo ──────────────────────────────────────────────────────────

/** Replay one row from its base over the evidence still attached, with `extraNight` as a further night. */
function foldOf(row, extraNight = null) {
  const after = (n) => row.baseNight === null || n > row.baseNight;
  const nights = store.stanceHistory(row.id, { limit: HISTORY_MAX }).map(h => h.night).filter(after);
  if (extraNight && after(extraNight) && !nights.includes(extraNight)) nights.push(extraNight);
  nights.sort();
  const byNight = new Map();
  let lastAt = null;
  for (const e of store.stanceEvidence(row.id)) {
    if (!after(e.night) || e.source === 'cited') continue;
    if (!byNight.has(e.night)) byNight.set(e.night, []);
    byNight.get(e.night).push(e);
    if (lastAt === null || e.at > lastAt) lastAt = e.at;
  }
  return { fold: replay(row, nights, byNight), lastAt, nights };
}

/** Value = base folded over the live evidence. A pin holds, a row not in force doesn't move. Call inside a tx. */
function recompute(row, extraNight = null) {
  if (!row || row.pinned || row.status !== 'active') return;
  const { fold, lastAt, nights } = foldOf(row, extraNight);
  store.writeStanceHistory(row.id, fold.rows);
  store.pruneStanceHistory(row.id, HISTORY_MAX);
  store.patchStance(row.id, { value: fold.value, confidence: fold.confidence, lastReinforcedAt: lastAt });
  if (nights.length > EVIDENCE_NIGHTS) {
    // Past the window: what it did stays in the base, what caused it is let go.
    const cut = fold.rows[nights.length - EVIDENCE_NIGHTS - 1];
    store.patchStance(row.id, { baseValue: cut.after, baseConfidence: cut.confidence, baseNight: cut.night, baseSince: cut.since, baseHabit: cut.habit });
    store.deleteStanceEvidenceThrough(row.id, cut.night);
  }
}

function recomputeIds(ids) {
  for (const id of new Set(ids)) recompute(store.getStance(id));
}

export function recomputeAll() {
  store.stanceTx(() => {
    for (const r of store.listStances({ status: 'active' })) recompute(r);
    dropUncited();   // a reassign can take a free topic's only citation with the rekey: with none it would pass as his own
  });
}

/**
 * A chat or a person's evidence is gone (a forget, a revoke, a purge). Sync: runs inside 006's transaction.
 * A chat-derived value returns to what the rest of the evidence says.
 */
export function removeEvidenceFor(forms, { since = null, memoryIds = [], keepCited = false } = {}) {
  // keepCited (an owner deleting one memory): a citation goes only through the memory it names. Its `at` is the night it was made, so the time rule would take an approved topic for an unrelated memory.
  const hit = store.stanceEvidenceIdsFor(forms, { since, ...(keepCited ? { exceptSource: 'cited' } : {}) });
  // An episode that was deleted, whatever the time: a free topic may cite it.
  if (memoryIds.length) {
    for (const e of store.allStanceEvidence()) if (memoryIds.includes(e.details?.memoryId) && !hit.some(h => h.id === e.id)) hit.push({ id: e.id, stanceId: e.stanceId });
  }
  if (!hit.length) return 0;
  store.deleteStanceEvidenceIds(hit.map(h => h.id));
  recomputeIds(hit.map(h => h.stanceId));
  dropUncited();
  return hit.length;
}

/**
 * A free topic's words came from what it cites: with all of that gone the row goes too, whatever its status. A rejected one as well:
 * its label would otherwise go to the model every night after the chat it came from was forgotten or purged. It can come back only if he comes across it again.
 */
function dropUncited() {
  for (const r of store.listStances()) {
    if (!r.topic.startsWith('free:')) continue;
    const cited = store.stanceEvidence(r.id).filter(e => e.source === 'cited');
    // Born on a night with chats in the batch, it may have come from any of them: lose one and the row goes, whatever else it cites. Kept, it would pass as his own.
    const born = Math.max(0, ...cited.map(e => e.details?.batchChats ?? 0));
    const chats = cited.filter(e => e.details?.batchChats && e.originKind !== 'self').length;
    if (!cited.length || chats < born) store.deleteStance(r.id);
  }
}

/** Events left the log (a revert, a rewind): what they evidenced goes, and values recompute. */
export async function sweep() {
  const life = await deps.life();
  const sig = life?.stanceExclusionSig?.() ?? null;
  if (sig === null || !store.hasStances(['active', 'archived'])) return { swept: 0 };
  if (sig === store.getSetting('stance_exclusion_sig', null)) return { swept: 0 };
  let swept = 0;
  store.stanceTx(() => {
    const gone = store.allStanceEvidence().filter(e => e.eventIds.some(id => life.stanceIsExcluded(id)));
    store.deleteStanceEvidenceIds(gone.map(e => e.id));
    recomputeIds(gone.map(e => e.stanceId));
    dropUncited();
    store.setStanceSetting('stance_exclusion_sig', sig);
    swept = gone.length;
  });
  if (swept) log.info({ evt: 'mind', count: swept }, 'mind: stance evidence swept');
  return { swept };
}

const fromChat = (i) => i.originKind !== 'self';

// ── what reaches him ────────────────────────────────────────────────────────
// Sync, never throw. A chat's mark on a value still counts for his days; the words about it are held to the audience rule.

const LINES_MAX = 3;
let numbersMemo = null;   // read on every decision and plan, simulated ones too; rows only change at night and on owner actions

/** The values in force: Map(topic → value), or null with none. */
export function numbers() {
  try {
    const v = store.stanceVersion();
    if (numbersMemo?.version === v) return numbersMemo.map;
    const rows = store.listStances({ status: 'active' });
    const map = rows.length ? new Map(rows.map(r => [r.topic, r.value])) : null;
    numbersMemo = { version: v, map };
    return map;
  } catch { return null; }
}

/** The chats that have had a say in a row, each with its earliest evidence (006: item_origins). */
function chatOriginsOf(rowId) {
  const by = new Map();
  for (const e of store.stanceEvidence(rowId)) {
    if (e.originKind === 'self' || e.originKind === 'owner') continue;
    const when = Number.isFinite(e.originAt) ? e.originAt : 0;   // the chat's own time; unknown fails closed
    const at = by.get(e.originJid);
    if (at === undefined || when < at) by.set(e.originJid, when);
  }
  return [...by].map(([originJid, minLearnedAt]) => ({ originJid, minLearnedAt }));
}

/** The real people who were part of what shaped a row. */
function subjectsOf(rowId) {
  return [...new Set(store.stanceEvidence(rowId).map(e => e.subjectJid).filter(Boolean))];
}

/** 006: a fact with a real person in it shows only where that person is. Fails closed. */
function subjectsPresent(subjects, audience) {
  return subjects.every((j) => {
    const p = resolvePerson(j) || j;
    return audience.personJid === p || audience.members?.has?.(p) === true;
  });
}

const LINE_COOLDOWN_SEC = 3600;
const RECENT_LINES = 3;
const MOVING_WITHIN_SEC = 14 * 86400;
const said = new Map();   // `${chat}|${what}` → when: one topic once an hour per chat. Lost on a restart, like cooldowns.

export function __resetLinesForTest() { said.clear(); }

/**
 * The chat a cooldown belongs to. A DM's @lid and @s.whatsapp.net forms are one chat, so it's the person's canonical JID. The audience already carries it
 * when it knows them; a resolver that fails falls back to the raw key, which at worst lets a line through once more.
 */
export function cooldownChat(audience, resolve = resolvePerson) {
  const raw = audience?.chatJid ?? audience?.personJid ?? 'none';
  if (audience?.kind === 'group' || audience?.kind === 'ig') return raw;
  try { return audience?.personJid || resolve(raw) || raw; } catch { return raw; }
}

const trendNow = (r, t) => (Number.isFinite(r.lastReinforcedAt) && t - r.lastReinforcedAt <= MOVING_WITHIN_SEC ? rawTrend(r) : 'flat');
const rawTrend = (r) => trendOf(store.stanceHistory(r.id, { limit: 14 }), 14);

export function clashesWithRealName(r) {
  if (!r.topic.startsWith('cast:')) return false;
  try {
    const real = realFirstNames();
    return nameTokens(String(r.label)).some(t => real.has(t));
  } catch { return true; }
}

/**
 * At most one line for this turn's tail, per-turn only: only when someone else's newest lines or the trigger raise it, not what he has just said
 * himself, once per topic per chat per hour, and only where every chat that shaped it may be used. recentText: [{ text, fromMe }], oldest first.
 */
export function linesFor(audience, recentText = [], { trigger = null } = {}) {
  try {
    if (!audience) return [];
    const rows = store.listStances({ status: 'active' });
    if (!rows.length) return [];
    const others = recentText.filter(m => !m?.fromMe && typeof m?.text === 'string').slice(-RECENT_LINES).map(m => m.text);
    if (typeof trigger === 'string' && trigger.trim()) others.push(trigger);
    const text = others.join('\n');
    if (!text.trim()) return [];
    const own = recentText.filter(m => m?.fromMe && typeof m?.text === 'string').slice(-RECENT_LINES).map(m => m.text).join('\n');
    const t = nowSec();
    const chat = cooldownChat(audience);
    for (const r of rows.sort((a, b) => Math.abs(b.value - neutralOf(b.kind)) - Math.abs(a.value - neutralOf(a.kind)))) {
      const label = lineLabel(r);
      if (!label || !raises(r, text) || voiced(r, own)) continue;
      const key = `${chat}|${label}`;
      if (t - (said.get(key) ?? -Infinity) < LINE_COOLDOWN_SEC) continue;
      const line = lineFor(r, label, { trend: trendNow(r, t) });
      if (!line) continue;
      const origins = chatOriginsOf(r.id);
      if (origins.length && !canUseIn({ originJid: 'self', originKind: 'self', origins }, audience)) continue;
      if (!subjectsPresent(subjectsOf(r.id), audience) || clashesWithRealName(r)) continue;
      if (said.size > 2000) said.clear();
      said.set(key, t);
      return [line];
    }
    return [];
  } catch { return []; }
}

/** Lines for a writer's sheet: only rows no chat has shaped, about what's in the scene or thread. */
export function sheetLines({ kind = null, placeId = null, castIds = [] } = {}) {
  try {
    const topics = [kind ? `kind:${kind}` : null, placeId, ...(Array.isArray(castIds) ? castIds : [])].filter(Boolean);
    const out = [];
    for (const topic of topics) {
      if (out.length >= LINES_MAX) break;
      const r = store.getStanceByTopic(topic);
      if (!r || r.status !== 'active' || chatOriginsOf(r.id).length || subjectsOf(r.id).length) continue;
      const line = lineFor(r, lineLabel(r), { third: true, trend: trendNow(r, nowSec()) });
      if (line) out.push(line);
    }
    return out;
  } catch { return []; }
}

/**
 * For the public site's `mind` key: rows only his own life shaped, no people. The why is code words from its strongest evidence,
 * never a model's. A row that has moved nothing and is mild has nothing to say and is left out.
 */
export function selfOriginRows() {
  const out = [];
  for (const r of store.listStances({ status: 'active' })) {
    if (r.topic.startsWith('cast:') || chatOriginsOf(r.id).length) continue;
    const evidence = store.stanceEvidence(r.id);
    if (evidence.some(e => e.subjectJid)) continue;
    if (!evidence.length && Math.abs(r.value - neutralOf(r.kind)) < 0.1) continue;
    const top = [...evidence].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || b.at - a.at)[0] ?? null;
    out.push({
      topic: r.topic, label: lineLabel(r) ?? r.label, kind: r.kind, value: r.value, trend: trendOf(store.stanceHistory(r.id, { limit: 30 })),
      why: top ? whyWords(top) : "how he's always been", since: r.lastReinforcedAt ?? r.approvedAt ?? r.createdAt,
    });
  }
  // Two real cafes both read "a cafe": one row, the stronger, rather than two that disagree.
  const byLabel = new Map();
  for (const r of out) {
    const had = byLabel.get(r.label);
    if (!had || Math.abs(r.value - neutralOf(r.kind)) > Math.abs(had.value - neutralOf(had.kind))) byLabel.set(r.label, r);
  }
  return [...byLabel.values()];
}

function labelForNew(cat, topic) {
  const c = [cat.kinds, cat.places, cat.cast, cat.fixed].find(m => m.has(topic));
  if (c) return c.get(topic);
  return topic.startsWith('kind:') ? topic.slice(5).replace(/[-_]+/g, ' ') : null;
}

/** A topic experience raised for the first time: at neutral, so it says and does nothing until he's lived more of it. */
function newTopic(cat, item, lastNight) {
  // A kind outside the catalogue only from his own days: a chat can name a slug.
  const label = labelForNew(cat, item.topic);
  if (!label || (fromChat(item) && !cat.kinds.has(item.topic) && !cat.fixed.has(item.topic))) return null;
  if (!item.topic.startsWith('kind:') && ![cat.places, cat.cast, cat.fixed].some(m => m.has(item.topic))) return null;
  const kind = kindOfTopic(item.topic);
  const neutral = neutralOf(kind);
  return store.putStance({ topic: item.topic, label, kind, value: neutral, anchor: neutral, uptake: uptakeOf(item.topic), status: 'active', source: 'code', confidence: NEW_TOPIC_CONFIDENCE, baseNight: lastNight, approvedAt: nowSec() });
}

/** Someone who left, a place gone: set aside, not rendered, not moving. Back in his life: picks up from there. */
function syncPresence(cat) {
  for (const r of store.listStances({ status: ['active', 'archived'] })) {
    const present = r.topic.startsWith('cast:') ? cat.cast.has(r.topic) : r.topic.startsWith('place:') ? cat.places.has(r.topic) : true;
    // A place renamed or a venue made real: the row reads under its word now (the kind word for a real venue).
    const word = cat.places.get(r.topic) ?? cat.cast.get(r.topic);
    if (word && word !== r.label) store.patchStance(r.id, { label: word });
    if (r.status === 'active' && !present) store.patchStance(r.id, { status: 'archived' });
    else if (r.status === 'archived' && present) store.patchStance(r.id, { status: 'active' });
  }
}

/**
 * One update, for the night `nk`, from the mind's sleep step. Code only, no model. Whatever he lived since the
 * last update goes under this night, so missed nights fold into one bounded step, and a re-run of the night does nothing.
 */
export async function nightlyUpdate(nk) {
  if (!store.hasStances(['active', 'archived'])) return { skipped: 'none' };
  const last = store.getSetting('stance_last_night', null);
  if (last !== null && nk <= last) return { skipped: 'done' };
  const life = await deps.life();
  const cat = life?.stanceCatalogue?.();
  const lived = life?.stanceLived?.({ afterId: store.getSetting('stance_cursor', 0) ?? 0 });
  if (!cat || !lived) return { skipped: 'life_off' };
  const items = evidenceFrom(lived.events, lived.ctx);
  const replaced = lived.events.filter(e => e.type === 'scene.played' && Number.isSafeInteger(e.payload?.regenOf)).map(e => e.payload.regenOf);
  let added = 0;
  store.stanceTx(() => {
    syncPresence(cat);
    // A scene told again replaces what its earlier version said.
    if (replaced.length) {
      const old = store.allStanceEvidence().filter(e => e.eventIds.some(id => replaced.includes(id)));
      store.deleteStanceEvidenceIds(old.map(e => e.id));
    }
    for (const item of items) {
      const row = store.getStanceByTopic(item.topic) ?? (item.existingOnly ? null : newTopic(cat, item, last));
      if (!row || row.status !== 'active' || row.pinned) continue;
      store.addStanceEvidence(row.id, nk, item);
      added += 1;
    }
    for (const r of store.listStances({ status: 'active' })) recompute(r, nk);
    store.setStanceSetting('stance_cursor', lived.lastId);
    store.setStanceSetting('stance_cursor_at', nowSec());
    store.setStanceSetting('stance_last_night', nk);
  });
  return { ok: true, night: nk, read: lived.events.length, added };
}

// ── free topics: what he has actually come across (stanceFree.js) ───────────

const budgetAllows = (b) => b === true || b?.ok === true || b?.allowed === true;

/**
 * One bounded call for the night, with the sleep budget: from tonight's episodes (entries from the sleep step: { chatJid, kind, episodeId, episode, minLearnedAt })
 * and his own scenes and texts. Only once he has an approved set. A proposal waits for the owner; a move on a live topic cites what moved it.
 */
export async function freeTopicsNight(nk, entries = []) {
  if (!store.listStances({ status: 'active' }).length) return { skipped: 'none' };
  if (store.getSetting('stance_free_night', null) === nk) return { skipped: 'done' };
  const life = await deps.life();
  const cat = life?.stanceCatalogue?.();
  if (!cat) return { skipped: 'life_off' };
  const budget = await deps.budgetOk('sleep');
  if (!budgetAllows(budget)) return { skipped: 'budget' };
  const t = nowSec();
  const list = [];
  for (const e of entries) {
    if (typeof e?.episode !== 'string' || !e.episode.trim() || !e.chatJid) continue;
    list.push({ words: e.episode, what: 'a chat', item: { at: t, eventIds: [], originKind: e.kind === 'group' ? 'group' : 'dm', originJid: e.chatJid, originAt: Number.isFinite(e.minLearnedAt) ? e.minLearnedAt : 0, details: { memoryId: e.episodeId ?? null } } });
  }
  let own = [];
  try { own = life.stanceEncounters?.({ from: t - 86400, to: t }) ?? []; } catch { own = []; }
  for (const x of own) {
    if (typeof x?.text === 'string' && x.text.trim()) list.push({ words: x.text, what: x.kind === 'text' ? 'a text' : 'an outing', item: { at: t, eventIds: [x.eventId], originKind: 'self', originJid: null, details: { kind: x.kind } } });
  }
  if (!list.length) return { skipped: 'nothing' };

  const all = store.listStances();
  const free = all.filter(r => r.topic.startsWith('free:'));
  const live = free.filter(r => r.status === 'active');
  const room = FREE_LIVE_MAX - free.filter(r => r.status === 'active' || r.status === 'proposed').length;
  if (room <= 0 && !live.length) return { skipped: 'full' };
  const items = new Map();
  const lines = list.slice(0, ITEMS_MAX).map((x, i) => {
    const label = `E${i + 1}`;
    items.set(label, x.item);
    return `${label} (${x.what}): ${cleanChatText(x.words, ITEM_CHARS)}`;
  });
  const persona = (() => { try { return deps.persona() ?? {}; } catch { return {}; } })();
  let realNames;
  try { realNames = [...deps.realFirstNames()]; } catch { return { skipped: 'names_unavailable' }; }
  const known = [...new Set([...all.map(r => r.label), ...all.map(r => lineLabel(r)).filter(Boolean), ...cat.kinds.values(), ...cat.places.values(), ...cat.fixed.values()].filter(Boolean))];
  const user = `${fenceBlock(lines.join('\n'))}\n\nAlready on his list: ${known.join('; ') || 'nothing'}.\nLive now: ${live.map(r => r.label).join('; ') || 'nothing'}.\nRoom for ${Math.max(0, room)} more.\n\nReturn only the JSON object.`;

  store.setStanceSetting('stance_free_night', nk);   // one call a night, whatever comes of it
  let res;
  try {
    res = await deps.callRole('mind', FREE_CHARTER, user, { caller: 'mind.stance.free', effort: 'low', maxTokens: 500 });
  } catch (err) {
    log.warn({ evt: 'issue', code: err?.name ?? 'error' }, 'mind: free topics call failed');
    return { skipped: err?.name === 'BudgetError' ? 'budget' : 'model_failed' };
  }
  if (res?.skipped) return { skipped: 'budget' };
  if (res?.status !== 'ok' || res.fellBack === true) return { skipped: 'model_failed' };
  const parsed = parseReply(res.text);
  if (!parsed) return { skipped: 'invalid' };
  const ctx = {
    textProblem: (x) => life.stanceTextProblem?.(x) ?? null, venueWords: life.venueKindWords ? (x) => life.venueKindWords(x) : null,
    castNames: [...cat.cast.values(), ...(cat.departed ?? [])], realNames,
    ...personaWords(persona),
  };
  const { ok, dropped } = cleanProposals(parsed.proposals, { items, existing: known, room, ctx });
  const moves = cleanMoves(parsed.moved, { items, rows: live });
  // A citation is only the model's word for where a label came from, and the items are summaries of what people wrote. So on a night with a chat in the batch every
  // proposal carries every chat's origin: it's kept to the audience rule and off the site, whatever it cited. Each citation says how many chats there were (dropUncited).
  const chatItems = [...items.values()].filter(i => i.originKind !== 'self');
  store.stanceTx(() => {
    for (const p of ok) {
      const row = store.putStance({ topic: p.topic, label: p.label, kind: p.kind, value: p.value, uptake: 0.8, status: 'proposed', source: 'code', confidence: 0.3, why: p.why });
      for (const c of new Set([...p.cited, ...chatItems])) {
        store.addStanceEvidence(row.id, nk, { ...c, details: { ...c.details, ...(chatItems.length ? { batchChats: chatItems.length } : {}) }, source: 'cited', cause: 'cited', weight: 0 });
      }
    }
    for (const m of moves) {
      for (const c of m.cited) store.addStanceEvidence(m.row.id, nk, { ...c, source: 'cited', cause: 'cited', weight: 0 });
      const c = m.cited[0];
      store.addStanceEvidence(m.row.id, nk, { ...c, source: 'free', cause: m.dir === 'up' ? 'moved_up' : 'moved_down', weight: m.dir === 'up' ? MOVE_WEIGHT : -MOVE_WEIGHT });
      recompute(store.getStance(m.row.id), nk);
    }
  });
  log.info({ evt: 'mind', proposed: ok.length, moved: moves.length, dropped: dropped.length }, 'mind: free topics');
  return { ok: true, proposed: ok.length, moved: moves.length, dropped };
}

// ── reads ───────────────────────────────────────────────────────────────────

async function labelOf(life, r) {
  try { return life?.stanceLabel?.(r.topic, { negative: true }) ?? r.label; } catch { return r.label; }
}

/** The dashboard's list. Ids, codes, numbers and labels: no chat, no JID. */
export async function view() {
  const life = await deps.life();
  const rows = store.listStances().filter(r => r.status !== 'rejected');
  const out = [];
  for (const r of rows) {
    const history = store.stanceHistory(r.id, { limit: 30 });
    out.push({
      id: r.id, topic: r.topic, label: await labelOf(life, r), kind: r.kind, value: r.value, anchor: r.anchor, confidence: r.confidence,
      status: r.status, pinned: r.pinned, source: r.source, trend: trendOf(history), neutral: neutralOf(r.kind), lastReinforcedAt: r.lastReinforcedAt,
      free: r.topic.startsWith('free:'), why: r.topic.startsWith('free:') && r.status === 'proposed' ? r.why : undefined,
      // Where a free topic's citations come from, as kinds only: what the owner weighs before approving it.
      citedFrom: r.topic.startsWith('free:') ? [...new Set(store.stanceEvidence(r.id).filter(e => e.source === 'cited').map(e => e.originKind ?? 'self'))].sort() : undefined,
      history: history.map(h => h.after),
    });
  }
  return { stances: out, counts: { proposed: out.filter(r => r.status === 'proposed').length, active: out.filter(r => r.status === 'active').length } };
}

/** Why it stands where it does, in plain words built from codes. A chat's part never carries what was said. */
export async function why(id) {
  const r = store.getStance(id);
  if (!r) return fail('not_found');
  const life = await deps.life();
  const evidence = store.stanceEvidence(r.id);
  const grouped = new Map();
  for (const e of evidence) {
    const words = whyWords(e);
    const g = grouped.get(words) ?? { words, count: 0, weight: 0, lastAt: 0 };
    g.count += 1;
    g.weight += e.weight;
    g.lastAt = Math.max(g.lastAt, e.at);
    grouped.set(words, g);
  }
  const lines = [...grouped.values()].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, WHY_LIST_MAX)
    .map(g => ({ words: g.words, count: g.count, direction: g.weight > 0 ? 'up' : g.weight < 0 ? 'down' : 'flat', lastAt: g.lastAt }));
  return {
    ok: true, id: r.id, label: await labelOf(life, r), kind: r.kind, value: r.value, anchor: r.anchor, confidence: r.confidence, pinned: r.pinned,
    status: r.status, startedAs: r.why, trend: trendOf(store.stanceHistory(r.id, { limit: 30 })), lines, evidenceCount: evidence.length,
  };
}
