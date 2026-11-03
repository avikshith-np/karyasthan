// The think (spec 008, research R4, R23; contracts/mind-output.md §5).
//
//   mindBudgetOk(kind)        the mind's own budget gate, shared by think, draft (proactive.js),
//                             sleep and selfmodel (sleep.js). → { ok, reason }
//                               think|draft: spent < budget × (1 − sleepReservePct/100) and
//                                            global < 70 % of the global cap;
//                               sleep|selfmodel: budgetState('mind').allowed and global < 90 %;
//                               every kind: 'unpriced' (fail closed) when the mind's primary
//                               model has no price, or the latest ok mind ledger row was
//                               unpriced and still is. spent = ledger + a conservative
//                               estimate (maxTokens × output price) for every mind link this
//                               month that failed without a bill (timeout / empty / error).
//                             Any error → { ok:false, reason:'budget' }.
//   runThink(trigger, opts)   guards in R4 order (skill → initialised → not paused / degraded →
//                             daily cap → min gap → something new → budget), clerk digests for
//                             the chats with new lines (≤ digestMaxChats, one clerk call per
//                             chat), the fenced digest bundle → callRole('mind', THINK_CHARTER,
//                             …, {caller:'mind.think', maxTokens: 6000}) → validateThink →
//                             self-state (mood/today/intentions), levers.applyNudges (refused
//                             when the run fell back), proactive.considerCandidates (only when
//                             the run asked to look for a reach-out, or the owner ran it), and
//                             next_think_at. Never throws.
//   thinkGuards(trigger)      the guards alone (the owner's "think now" pre-check).
//
// The persona name and vibe go into the USER message only; THINK_CHARTER is static.
// Skipped rows are written at most once per (kind, reason) per hour. Logs carry ids,
// counts and codes only — never digest, note or reason text.

import * as store from './store.js';
import * as hooks from './hooks.js';
import { now as clockNow, dayKey } from './clock.js';
import { THINK_CHARTER, cleanChatText } from './charter.js';
import { validateThink } from './schema.js';
import { buildLabelMap, labelMapForInput, labelsOf } from './labels.js';
import { refreshClerkDigests, digestBundle, digestIsToday } from './digest.js';
import { callRole } from '../brain/llm.js';
import { budgetState, costFor, monthStartTs } from '../brain/usage.js';
import { resolveRole } from '../brain/roles.js';
import { getDb } from '../memory/db.js';
import { getPerson } from '../memory/peopleStore.js';
import { getGroup } from '../memory/groupStore.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const HOUR = 3600;
const DAY = 86400;
export const THINK_MAX_TOKENS = 6000;
export const THINK_TIMEOUT_MS = 120_000;
export const BUNDLE_DIGEST_MAX_AGE_SEC = 48 * HOUR;
export const SKIP_ROW_EVERY_SEC = HOUR;
// Conservative output-token estimate per caller for a mind link that failed unbilled.
const EST_MAX_TOKENS = { 'mind.think': 6000, 'mind.sleep': 8000, 'mind.selfmodel': 3000, 'mind.draft': 1500 };
const EST_DEFAULT_TOKENS = 6000;
const UNBILLED_STATUSES = ['timeout', 'empty', 'error'];
const TRIGGERS = new Set(['glance', 'anchor', 'scheduled', 'owner']);
// callRole skip → run skip reason (store.SKIP_REASONS).
const CALL_SKIP = { budget: 'budget', no_key: 'no_key', disabled: 'disabled', shadow_only: 'disabled' };
// Statuses that count against thinkMaxPerDay (a skipped row never eats the cap).
const COUNTED_RUN = ['running', 'ok', 'partial', 'invalid', 'failed'];

// ── deps (test seam) ─────────────────────────────────────────────────────────

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isMindOn: () => isSkillEnabled('mind'),
  isDegraded: () => hooks.isDegraded(),
  callRole: (role, system, user, opts) => callRole(role, system, user, opts),
  refreshDigests: (chats, runId) => refreshClerkDigests(chats, runId),
  life: async () => import('../life/index.js'),
  selfState: async () => import('./selfState.js'),
  levers: async () => import('./levers.js'),
  proactive: async () => import('./proactive.js'),
  getPersona: () => getPersona(),
  getPerson: (jid) => getPerson(jid),
  getGroup: (jid) => getGroup(jid),
  budgetState: (name) => budgetState(name),
  ledger: () => ledgerFacts(),
};
let deps = { ...DEFAULT_DEPS };
// A callRole skip that will repeat (no key / role disabled): later thinks skip early
// without a model call until this time (in memory; one row per hour at most anyway).
let roleBlocked = null;   // { reason, until }

/** Test seam: { now, isMindOn, isDegraded, callRole, refreshDigests, life, selfState, levers, proactive,
 *  getPersona, getPerson, getGroup, budgetState, ledger }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
  roleBlocked = null;
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const nowSec = () => Math.floor(deps.now());
const isGroupJid = (j) => typeof j === 'string' && j.endsWith('@g.us');
const codeOf = (err) => String(err?.code || err?.name || 'error').slice(0, 60);

function issue(where, err) {
  try { logger.warn({ evt: 'issue', where: `mind.think.${where}`, code: codeOf(err) }, 'mind: think step failed'); } catch { /* */ }
}

// ── shared code-text helpers (think + glance) ────────────────────────────────

const WEEKDAY_FMT = new Map();
/** "Local time: Tue 14:05." in config.timezone. */
export function localTimeLine(t) {
  const tz = config.timezone || 'UTC';
  let f = WEEKDAY_FMT.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
    catch { f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
    WEEKDAY_FMT.set(tz, f);
  }
  return `Local time: ${f.format(new Date(Math.floor(t) * 1000)).replace(',', '')}.`;
}

const bucket = (v, lo, hi) => (fin(v) ? (v < lo ? 'low' : v > hi ? 'high' : 'medium') : null);

/** The coarse life view the mind may see: availability + vitals buckets. null when life is off/absent. */
export function lifeView(life, t) {
  try {
    if (!life || typeof life.isLifeOn !== 'function' || !life.isLifeOn()) return null;
    let availability = null;
    try { availability = typeof life.availabilityNow === 'function' ? life.availabilityNow() : null; } catch { availability = null; }
    let state = null;
    try { state = typeof life.getState === 'function' ? life.getState() : null; } catch { state = null; }
    const v = state && typeof state.vitals === 'object' && state.vitals ? state.vitals : {};
    const AV = ['free', 'light', 'busy', 'meeting', 'dnd', 'asleep'];
    return {
      availability: AV.includes(availability) ? availability : null,
      energy: bucket(v.energy, 30, 70),
      stress: bucket(v.stress, 30, 70),
      socialBattery: bucket(v.socialBattery, 30, 70),
      sick: !!(v.sick || state?.sick),
      valence: fin(v.mood?.valence) ? (v.mood.valence < -0.25 ? 'negative' : v.mood.valence > 0.25 ? 'positive' : 'neutral') : null,
      arousal: bucket(v.mood?.arousal, 0.3, 0.7),
      awake: typeof life.isAwakeAt === 'function' ? !!life.isAwakeAt(t) : null,
    };
  } catch {
    return null;
  }
}

/** Life lines for the think's user message (code text only). */
export async function lifeSummaryLines(life, t) {
  const v = lifeView(life, t);
  if (!v) return [];
  const parts = [];
  if (v.availability) parts.push(`availability ${v.availability}`);
  if (v.energy) parts.push(`energy ${v.energy}`);
  if (v.stress) parts.push(`stress ${v.stress}`);
  if (v.socialBattery) parts.push(`social battery ${v.socialBattery}`);
  if (v.sick) parts.push('unwell');
  return parts.length ? [`Your life right now: ${parts.join(', ')}.`] : [];
}

/** Vitals → a mood word (the code-only base mood when Jev is unavailable). null = unchanged. */
export function vitalsMood(v) {
  if (!v) return null;
  if (v.sick) return 'drained';
  if (v.energy === 'low') return 'tired';
  if (v.stress === 'high') return 'anxious';
  if (v.socialBattery === 'low') return 'drained';
  if (v.valence === 'positive') return v.arousal === 'high' ? 'excited' : 'content';
  if (v.valence === 'negative') return 'low';
  if (v.energy === 'high' && v.stress === 'low') return 'upbeat';
  return null;
}

// ── budget gate (R23) ────────────────────────────────────────────────────────

/**
 * Read-only facts from the 007 ledger for the mind role this month: unbilled failed
 * links ({caller, provider, model, n}) and the latest ok row's pricing. Throws on a
 * DB error (the gate fails closed).
 */
function ledgerFacts() {
  const db = getDb();
  const since = monthStartTs(nowSec() * 1000);
  const unbilled = db.prepare(`
    SELECT caller, provider, model, COUNT(*) AS n FROM llm_usage
    WHERE role = 'mind' AND ts >= ? AND ok = 0 AND cost_usd IS NULL
      AND status IN (${UNBILLED_STATUSES.map(() => '?').join(',')})
    GROUP BY caller, provider, model`).all(since, ...UNBILLED_STATUSES);
  const latestOk = db.prepare(`
    SELECT provider, model, cost_source AS costSource FROM llm_usage
    WHERE role = 'mind' AND ts >= ? AND ok = 1 AND status = 'ok'
    ORDER BY ts DESC, id DESC LIMIT 1`).get(since) || null;
  return { unbilled, latestOk };
}

const priced = (provider, model) => {
  if (!provider || !model) return false;
  // OpenRouter reports usage.cost on every call; anything else needs a price-table row.
  if (provider === 'openrouter') return true;
  return costFor({ provider, model, usage: { input: 1000, output: 1000 } }).source !== 'unknown';
};

/** USD of the conservative estimates for this month's unbilled mind links. */
function unbilledEstimate(unbilled) {
  let usd = 0;
  for (const r of unbilled || []) {
    const tokens = EST_MAX_TOKENS[r.caller] || EST_DEFAULT_TOKENS;
    const c = costFor({ provider: r.provider, model: r.model, usage: { output: tokens } });
    if (fin(c.costUsd)) usd += c.costUsd * (Number(r.n) || 0);
  }
  return usd;
}

/**
 * The mind's budget gate for `kind` ('think'|'draft'|'sleep'|'selfmodel').
 * → { ok, reason: null|'budget'|'global_cap'|'unpriced', spentUsd, budgetUsd, globalSpentUsd, globalBudgetUsd }
 * Sync; never throws (an error → budget, fail closed).
 */
export function mindBudgetOk(kind = 'think') {
  try {
    const role = resolveRole('mind', config);
    const facts = deps.ledger();
    if (!role?.disabled && !priced(role?.provider, role?.model)) return { ok: false, reason: 'unpriced' };
    const last = facts?.latestOk;
    if (last && last.costSource === 'unknown' && !priced(last.provider, last.model)) return { ok: false, reason: 'unpriced' };
    const st = deps.budgetState('mind');
    const est = unbilledEstimate(facts?.unbilled);
    const spentUsd = (Number(st.spentUsd) || 0) + est;
    const globalSpentUsd = (Number(st.globalSpentUsd) || 0) + est;
    const budgetUsd = Number(st.budgetUsd) || 0;
    const globalBudgetUsd = Number(st.globalBudgetUsd) || 0;
    const out = (ok, reason) => ({ ok, reason, spentUsd, budgetUsd, globalSpentUsd, globalBudgetUsd });
    if (!st.allowed) return out(false, st.reason === 'global' ? 'global_cap' : 'budget');
    const strict = kind === 'think' || kind === 'draft';
    if (budgetUsd > 0) {
      const pct = Math.max(0, Math.min(50, Number(config.mind?.sleepReservePct ?? 20)));
      const limit = strict ? budgetUsd * (1 - pct / 100) : budgetUsd;
      if (spentUsd >= limit) return out(false, 'budget');
    }
    if (globalBudgetUsd > 0 && globalSpentUsd >= (strict ? 0.7 : 0.9) * globalBudgetUsd) return out(false, 'global_cap');
    return out(true, null);
  } catch (err) {
    issue('budget', err);
    return { ok: false, reason: 'budget' };
  }
}

// ── run rows ─────────────────────────────────────────────────────────────────

/**
 * A skipped run, written at most once per (kind, reason) per hour. → { status:'skipped',
 * reason, runId|null, recorded }
 */
export function recordSkip(kind, reason, { trigger = null, t = nowSec(), error = null } = {}) {
  let runId = null;
  try {
    const last = store.lastSkip(kind, reason);
    if (!(fin(last) && t - last < SKIP_ROW_EVERY_SEC && t >= last)) {
      runId = store.insertRun({ kind, trigger: trigger || null, startedAt: t, status: 'skipped', skipReason: reason });
      store.finishRun(runId, { status: 'skipped', skipReason: reason, finishedAt: t, ...(error ? { error } : {}) });
    }
  } catch (err) {
    issue('skip_row', err);
  }
  return { status: 'skipped', reason, runId, recorded: runId != null };
}

/** The common A1 gate of every mind run: → skip reason | null. */
export function baseGate() {
  if (!deps.isMindOn()) return 'disabled';
  const s = store.getSettings();
  if (s.firstEnabledAt == null) return 'not_initialised';
  if (s.paused) return 'paused';
  if (deps.isDegraded()) return 'error';
  return null;
}

/** Non-skipped thinks counted for local day of t. */
export function thinksToday(t = nowSec()) {
  return store.countRuns({ kind: 'think', dayKey: dayKey(t), status: COUNTED_RUN });
}

// ── what is new ──────────────────────────────────────────────────────────────

/** Chats with human lines after `since` (activity counters), busiest first. */
function chatsWithNewHumans(since, t) {
  const from = fin(since) ? since : t - DAY;
  const by = new Map();
  for (const r of store.activityFor(dayKey(from))) {
    if (!fin(r.lastHumanAt) || r.lastHumanAt <= from) continue;
    const cur = by.get(r.chatJid) || { chatJid: r.chatJid, human: 0, last: 0 };
    cur.human += Number(r.humanMsgs) || 0;
    cur.last = Math.max(cur.last, r.lastHumanAt);
    by.set(r.chatJid, cur);
  }
  return [...by.values()].sort((a, b) => b.human - a.human || b.last - a.last).map(c => c.chatJid);
}

/** Chats with any activity in the last day, most active first (the bundle's other members). */
function recentChats(t) {
  const by = new Map();
  for (const r of store.activityFor(dayKey(t - DAY))) {
    const cur = by.get(r.chatJid) || { chatJid: r.chatJid, n: 0, last: 0 };
    cur.n += Number(r.humanMsgs) || 0;
    cur.last = Math.max(cur.last, Number(r.lastHumanAt) || 0, Number(r.lastBotAt) || 0);
    by.set(r.chatJid, cur);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || b.last - a.last).map(c => c.chatJid);
}

/**
 * The guards in R4 order, without the model call. trigger 'owner' skips only the
 * "something new" guard. → { reason } | { ok:true, newChats, anchors }
 */
export function thinkGuards(trigger = 'scheduled', { anchors = [] } = {}) {
  try {
    const t = nowSec();
    const g = baseGate();
    if (g) return { reason: g };
    const max = Math.max(0, Number(config.mind?.thinkMaxPerDay ?? 4));
    if (thinksToday(t) >= max) return { reason: 'cap' };
    const st = store.getState();
    const gap = Math.max(1, Number(config.mind?.thinkMinGapMinutes ?? 90)) * 60;
    if (fin(st.lastThinkAt) && t - st.lastThinkAt < gap && t >= st.lastThinkAt) return { reason: 'gap' };
    if (roleBlocked && t < roleBlocked.until) return { reason: roleBlocked.reason };
    const newChats = chatsWithNewHumans(st.lastThinkAt, t);
    const anchorList = Array.isArray(anchors) ? anchors.filter(a => a && typeof a.type === 'string') : [];
    if (trigger !== 'owner' && !newChats.length && !anchorList.length) return { reason: 'nothing_new' };
    const b = mindBudgetOk('think');
    if (!b.ok) return { reason: b.reason || 'budget' };
    return { ok: true, newChats, anchors: anchorList };
  } catch (err) {
    issue('guards', err);
    return { reason: 'error' };
  }
}

function settleNextThink(t, reason) {
  try {
    const st = store.getState();
    if (!fin(st.nextThinkAt) || st.nextThinkAt > t) return;   // a future schedule stays
    const gap = Math.max(1, Number(config.mind?.thinkMinGapMinutes ?? 90)) * 60;
    store.patchState({ nextThinkAt: reason === 'gap' || reason === 'cap' ? t + gap : null });
  } catch (err) { issue('next_think', err); }
}

// ── input ────────────────────────────────────────────────────────────────────

function chatName(chatJid) {
  try {
    if (isGroupJid(chatJid)) return cleanChatText(deps.getGroup(chatJid)?.name || '', 60) || 'a group';
    const p = deps.getPerson(chatJid);
    return cleanChatText(p?.real_name || p?.push_name || '', 40) || 'a friend';
  } catch { return isGroupJid(chatJid) ? 'a group' : 'a friend'; }
}

/** Label-map entries from each chat's latest digest (≤ 48 h old), new chats first. */
export function bundleEntries(newChats, t) {
  const order = [...new Set([...newChats, ...recentChats(t)])];
  const out = [];
  for (const chatJid of order) {
    if (out.length >= 12) break;
    const d = store.latestDigest(chatJid);
    if (!d || !fin(d.createdAt) || t - d.createdAt > BUNDLE_DIGEST_MAX_AGE_SEC) continue;
    out.push({ chatJid, kind: d.originKind === 'group' ? 'group' : 'dm', digestId: d.id, todayNote: digestIsToday(d, t) ? d.todayNote : null,
      threads: d.threads, name: chatName(chatJid) });
  }
  return out;
}

function youLine() {
  const persona = deps.getPersona() || {};
  const you = cleanChatText(persona.name || 'the character', 60);
  const vibe = persona.vibe ? cleanChatText(persona.vibe, 160) : '';
  return `You are ${you}${vibe ? ` (${vibe})` : ''}.`;
}

function stateLines(t, labelMap) {
  const out = [];
  try {
    const els = store.activeElements(t).filter(e => !(e.basis || []).some(b => b?.stage));
    const mood = els.find(e => e.kind === 'mood') || els.find(e => e.kind === 'base_mood');
    out.push(mood?.word ? `Your mood now: ${mood.word}${fin(mood.intensity) ? ` (${mood.intensity})` : ''}.` : 'Your mood now: not set.');
    const ints = els.filter(e => e.kind === 'intention').map(e => e.intentionKind).filter(Boolean);
    if (ints.length) out.push(`Your intentions: ${ints.join(', ')}.`);
    const todays = els.filter(e => e.kind === 'today').length;
    if (todays) out.push(`Today notes you already picked: ${todays}.`);
  } catch { /* */ }
  try {
    const labelOfChat = (jid) => labelsOf(labelMap).find(l => labelMap[l].chatJid === jid) || null;
    const ns = store.activeNudges().map((n) => {
      const scope = n.scope === 'global' ? 'global' : (labelOfChat(n.scope) || 'one group');
      const v = typeof n.value === 'string' || fin(n.value) ? n.value : '?';
      return `${n.knob} ${v} (${scope})`;
    });
    out.push(ns.length ? `Active nudges: ${ns.join('; ')}.` : 'Active nudges: none.');
  } catch { /* */ }
  return out;
}

async function buildUser(t, labelMap, bundle, anchors, lookForReachOut) {
  let lifeLines = [];
  try { lifeLines = await lifeSummaryLines(await deps.life(), t); } catch { lifeLines = []; }
  const anchorTypes = [...new Set((anchors || []).map(a => a.type))].slice(0, 10);
  return [
    youLine(),
    localTimeLine(t),
    '',
    bundle.text || 'No chat digests this time.',
    '',
    ...stateLines(t, labelMap),
    ...lifeLines,
    anchorTypes.length ? `Things that just happened in your own life: ${anchorTypes.join(', ')}.` : '',
    lookForReachOut
      ? 'You may look for one or two people or groups to reach out to first (reach_out).'
      : 'Do not propose any reach_out this time.',
    '',
    'Return only the JSON object described in the instructions.',
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}

// ── the think ────────────────────────────────────────────────────────────────

function usageOf(res) {
  return { model: res?.model ?? null, tokensIn: res?.usage?.input ?? null, tokensOut: res?.usage?.output ?? null,
    cacheRead: res?.usage?.cacheRead ?? null, costUsd: fin(res?.costUsd) ? res.costUsd : null, fellBack: !!res?.fellBack };
}

/**
 * One think. trigger: 'glance'|'anchor'|'scheduled'|'owner'. opts: { anchors: [{id,type}],
 * lookForReachOut }. → { status: 'ok'|'skipped'|'invalid'|'failed', runId, reason?, fellBack?, … }
 * Never throws.
 */
export async function runThink(trigger = 'scheduled', opts = {}) {
  const t = nowSec();
  const trig = TRIGGERS.has(trigger) ? trigger : 'scheduled';
  const g = thinkGuards(trig, { anchors: opts.anchors });
  if (g.reason) {
    settleNextThink(t, g.reason);
    return recordSkip('think', g.reason, { trigger: trig, t });
  }
  const anchors = g.anchors;
  const lookForReachOut = opts.lookForReachOut === true;
  let runId = null;
  try {
    const triggerRef = anchors.length && fin(Number(anchors[0].id)) ? `event:${Number(anchors[0].id)}` : null;
    runId = store.insertRun({ kind: 'think', trigger: trig, triggerRef, startedAt: t,
      input: { newChats: g.newChats.length, anchors: anchors.map(a => a.type).slice(0, 10), lookForReachOut } });

    // 1. Clerk digests for the chats with new lines (the clerk cap lives in digest.js).
    let refreshed = { results: [], calls: 0 };
    if (g.newChats.length) {
      try { refreshed = (await deps.refreshDigests(g.newChats, runId)) || refreshed; } catch (err) { issue('digests', err); }
    }
    // 2. The bundle over each chat's latest digest.
    const entries = bundleEntries(g.newChats, t);
    const fullMap = buildLabelMap(entries);
    const bundle = digestBundle(fullMap);
    const labelMap = Object.fromEntries(bundle.labels.map(l => [l, fullMap[l]]));
    const input = { labels: labelMapForInput(labelMap), digests: bundle.labels.length, bytes: bundle.bytes,
      refreshed: refreshed.results.map(r => r.status).slice(0, 12), clerkCalls: refreshed.calls,
      anchors: anchors.map(a => a.type).slice(0, 10), lookForReachOut };
    store.finishRun(runId, { input });
    if (!bundle.labels.length && !anchors.length && trig !== 'owner') {
      store.finishRun(runId, { status: 'skipped', skipReason: 'nothing_new' });
      settleNextThink(t, 'nothing_new');
      return { status: 'skipped', reason: 'nothing_new', runId, recorded: true };
    }

    // 3. The call.
    const user = await buildUser(t, labelMap, bundle, anchors, lookForReachOut);
    const effort = typeof config.mind?.thinkEffort === 'string' && config.mind.thinkEffort ? config.mind.thinkEffort : null;
    const res = await deps.callRole('mind', THINK_CHARTER, user, {
      caller: 'mind.think', maxTokens: THINK_MAX_TOKENS, timeoutMs: THINK_TIMEOUT_MS, ...(effort ? { effort } : {}) });
    const usage = usageOf(res);
    if (res?.skipped) {
      const reason = CALL_SKIP[res.skipped] || 'error';
      if (reason === 'no_key' || reason === 'disabled') roleBlocked = { reason, until: t + SKIP_ROW_EVERY_SEC };
      store.finishRun(runId, { status: 'skipped', skipReason: reason, ...usage });
      settleNextThink(t, reason);
      return { status: 'skipped', reason, runId, recorded: true };
    }
    store.patchState({ lastThinkAt: t });
    if (!res || res.status !== 'ok' || typeof res.text !== 'string' || !res.text) {
      store.finishRun(runId, { status: 'failed', error: String(res?.status || 'no_text').slice(0, 60), ...usage });
      store.patchState({ nextThinkAt: null });
      return { status: 'failed', runId, fellBack: usage.fellBack };
    }

    // 4. Validate.
    const ss = await deps.selfState();
    const v = validateThink(res.text, { labelMap, lookForReachOut, trigger: trig, basisAllowed: ss?.basisAllowed });
    if (!v.ok) {
      store.finishRun(runId, { status: 'invalid', error: v.error, dropped: v.dropped, ...usage });
      store.patchState({ nextThinkAt: null });
      return { status: 'invalid', runId, fellBack: usage.fellBack, error: v.error };
    }

    // 5. Apply (pointer-only outputs; nudges refused on a fell-back run inside levers).
    const value = v.value;
    const dropped = [...v.dropped];
    const output = { mood: null, today: [], intentions: [], nudges: [], reachOut: { drafted: [], notes: [] },
      nextThinkInMinutes: value.nextThinkInMinutes, note: value.note, fellBack: usage.fellBack };
    if (value.mood && ss?.applyMood) {
      const id = ss.applyMood(value.mood, { labelMap, runId, at: t });
      output.mood = id != null ? { id, word: value.mood.word } : null;
    }
    if (value.today.length && ss?.applyToday) {
      const r = ss.applyToday(value.today, { runId, at: t });
      output.today = r?.applied || [];
      for (const d of r?.dropped || []) dropped.push({ path: `today[${d.index}]`, reason: d.reason });
    }
    if (value.intentions.length && ss?.applyIntentions) {
      const r = ss.applyIntentions(value.intentions, { runId, at: t });
      output.intentions = r?.applied || [];
      for (const d of r?.dropped || []) dropped.push({ path: `intentions[${d.index}]`, reason: d.reason });
    }
    if (value.nudges.length) {
      try {
        const lv = await deps.levers();
        const r = lv.applyNudges(value.nudges, runId, labelMap, { fellBack: usage.fellBack });
        output.nudges = (r?.results || []).map(x => ({ knob: x.knob, status: x.status, refuseReason: x.refuseReason ?? null,
          id: x.id ?? null }));
      } catch (err) { issue('nudges', err); }
    }
    if (value.reachOut.length) {
      try {
        const pr = await deps.proactive();
        const r = await pr.considerCandidates(value.reachOut, labelMap, runId);
        output.reachOut = { drafted: (r?.drafted || []).map(d => ({ id: d.id, status: d.status, dropReason: d.dropReason ?? null })),
          notes: (r?.notes || []).map(n => ({ index: n.index, reason: n.reason })) };
      } catch (err) { issue('proactive', err); }
    }
    store.patchState({ nextThinkAt: fin(value.nextThinkInMinutes)
      ? t + Math.min(1440, Math.max(60, value.nextThinkInMinutes)) * 60 : null });
    store.finishRun(runId, { status: 'ok', output, dropped, ...usage });
    logger.info({ evt: 'mind.think', runId, trigger: trig, digests: bundle.labels.length, fellBack: usage.fellBack,
      dropped: dropped.length }, 'mind: think done');
    return { status: 'ok', runId, fellBack: usage.fellBack, output };
  } catch (err) {
    issue('run', err);
    try { if (runId != null) store.finishRun(runId, { status: 'failed', error: codeOf(err) }); } catch { /* */ }
    return { status: 'failed', runId };
  }
}
