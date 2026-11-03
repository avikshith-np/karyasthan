// The mind facade (spec 008, contracts/mind-api.md). The ONLY module the rest of the
// app imports from src/mind/. Importing it arms nothing: the cadence subscribes to
// life.onTick at import (it only records ticks), and nothing runs until startMind().
//
//   lifecycle       startMind({getSock}) / stopMind() / isMindOn() / isMindActive() / cancelQueued()
//   prompt surfaces selfStateLine / selfStateNote / replyLengthLine / recentEpisodes / selfModelBlock
//                   (sync, never throw, '' / [] on any error); openerText (the opener instruction)
//   knobs           the overlay getters (re-exported)
//   owner hooks     onOwnerConfigChange(appliedKeys)
//   dashboard       getStatus / getSelfState / listRuns / getRun / getSelfModel / getSelfModelDiff /
//                   listNudges / getBands / listProactive / listExclusions
//   owner writes    owner.* — used by src/dashboard/routes/mind.js only. Refusals throw
//                   OwnerError(code, http). This is the only module that imports store.owner.
// Nothing here logs chat- or model-derived text.

import * as store from './store.js';
import * as hooks from './hooks.js';
import * as cadence from './cadence.js';
import * as selfState from './selfState.js';
import * as selfModel from './selfModel.js';
import * as knobsMod from './knobs.js';
import * as levers from './levers.js';
import * as proactive from './proactive.js';
import * as stance from './stance.js';
import { mindBudgetOk } from './think.js';
import { now as clockNow, dayKey, nightKey } from './clock.js';
import { recallEpisodes, resolveAudience } from '../memory/recall.js';
import { identitiesOf, resolvePerson } from '../memory/identity.js';
import { getPerson } from '../memory/peopleStore.js';
import { getGroup } from '../memory/groupStore.js';
import { budgetState, getUsageByCaller, monthStartTs } from '../brain/usage.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export { OwnerError } from './selfModel.js';
export { knobs } from './knobs.js';
const { OwnerError } = selfModel;

const DAY = 86400;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const nowSec = () => Math.floor(clockNow());
const isGroupJid = (j) => typeof j === 'string' && j.endsWith('@g.us');
const codeOf = (err) => String(err?.code || err?.name || 'error').slice(0, 60);

function issue(where, err) {
  try { logger.warn({ evt: 'issue', where: `mind.facade.${where}`, code: codeOf(err) }, 'mind: facade call failed'); } catch { /* */ }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

let startedOnce = false;

/**
 * Idempotent. Sets `started` (the drain runs from now on), arms the fallback timer,
 * loads knobs, registers the 006 deletion / identity hooks, seeds the proactive-mode
 * setting once and drops every `drafting` row (stale_draft). It does not seed cursors
 * or set first_enabled_at: the cadence does that on the skill's off→on edge. Never throws.
 */
export function startMind({ getSock } = {}) {
  try {
    if (!startedOnce) {
      startedOnce = true;
      try { store.seedDefaults(); } catch (err) { issue('seed', err); }
      try { store.dropStaleDrafting(nowSec() + 1); } catch (err) { issue('stale', err); }
      try { knobsMod.reload(); } catch (err) { issue('knobs', err); }
      try { hooks.registerHooks({ cancelForChat: proactive.cancelForChat }); } catch (err) { issue('hooks', err); }
      try { hooks.restoreDegraded(); } catch (err) { issue('degraded', err); }
    }
    cadence.start({ getSock });
  } catch (err) {
    issue('start', err);
  }
}

/** Clears timers and the hooks; drains nothing. Never throws. */
export function stopMind() {
  try { cadence.stop(); } catch (err) { issue('stop', err); }
  try { hooks.unregisterHooks(); } catch (err) { issue('unhook', err); }
  startedOnce = false;
}

/** 008's budget gate (think.js mindBudgetOk) for callers outside the mind: life's arc seed. */
export function budgetOk(kind = 'think') {
  return mindBudgetOk(kind);
}

export function isMindOn() {
  try { return isSkillEnabled('mind') === true; } catch { return false; }
}

/** On, initialised, not paused, not degraded. */
export function isMindActive() {
  try {
    if (!isMindOn() || hooks.isDegraded()) return false;
    const s = store.getSettings();
    return s.firstEnabledAt != null && !s.paused;
  } catch { return false; }
}

/** Every queued proactive send → cancelled (skill off, pause). Never throws. */
export function cancelQueued(reason = 'cancelled') {
  try { return proactive.cancelQueued(reason); } catch (err) { issue('cancel', err); return 0; }
}

// ── prompt surfaces ──────────────────────────────────────────────────────────

/** ≤ 160 chars; '' when off, imitating, embargo, degraded, or nothing usable. */
export function selfStateLine(audience, { chatJid = null, isGroup = null, imitation = null, track = true } = {}) {
  try {
    if (!isMindOn() || imitation) return '';
    const line = selfState.renderLine(audience, { chatJid, isGroup, imitation, track });
    return typeof line === 'string' ? line : '';
  } catch { return ''; }
}

/** SELF_NOTE when `line` (the rendered self-state line) is non-empty and life's note was not emitted. */
export function selfStateNote({ lifeNoteEmitted = false, line = '' } = {}) {
  try { return selfState.selfStateNote({ lifeNoteEmitted, line }); } catch { return ''; }
}

/** 'Keep replies brief.' / 'You can say a bit more.' / '' (its own line, ≤ 30 chars). */
export function replyLengthLine(chatJid) {
  try { return selfState.replyLengthLine(chatJid) || ''; } catch { return ''; }
}

/** ≤ 2 episodes usable in this audience; [] when the mind is off or imitating. */
export function recentEpisodes(audience, { imitation = null } = {}) {
  try {
    if (!isMindOn() || imitation || !audience) return [];
    const r = recallEpisodes(audience, { limit: 2 });
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}

/** The opener instruction (proactive stage C) — systemPrompt's `opener` option renders it. */
export function openerText(intent) {
  return proactive.openerText(intent);
}

/** The cached-core self-model block ('' when off, imitating or empty). */
export function selfModelBlock({ imitation = null } = {}) {
  try { return selfModel.selfModelBlock({ imitation }) || ''; } catch { return ''; }
}

// ── owner hooks ──────────────────────────────────────────────────────────────

/** The owner changed live config: nudges on those knobs end `overridden`. Never throws. */
export function onOwnerConfigChange(appliedKeys = []) {
  try { return levers.onOwnerConfigChange(Array.isArray(appliedKeys) ? appliedKeys : []); } catch (err) { issue('owner_config', err); return { overridden: 0 }; }
}

// ── dashboard reads ──────────────────────────────────────────────────────────

const REMINDERS = {
  not_initialised: 'The mind has not started its first live day yet (it starts on the next pass with the skill on and DRY_RUN off).',
  owner_jids_unset: 'OWNER_JIDS is not set in .env (or none of its entries is a valid WhatsApp number or JID), so proactive live mode is unavailable.',
  degraded: 'A deletion hook failed; the self-state line and sends are off until the next pulse recovers.',
  unpriced: 'The mind model has no price entry; mind runs are skipped until data/llm-prices.json has one.',
  global_cap: 'Global spend is past the mind\'s headroom; thinks and drafts are paused for the month.',
  no_key: 'The mind role has no API key; its runs are skipped.',
  fell_back: 'A recent mind run fell back to another model; its nudges and self-model text were refused.',
  shadow_14d: 'Proactive messages have been in shadow for 14 days: review the drafts before going live.',
  review_window_ending: 'The self-model review window ends within two days; after it, proposals may auto-apply.',
};

function chatNameOf(jid) {
  try {
    if (isGroupJid(jid)) return getGroup(jid)?.name || null;
    const p = getPerson(jid);
    return p?.real_name || p?.push_name || null;
  } catch { return null; }
}

function spendByCaller(since) {
  const rows = [...getUsageByCaller('mind.', since), ...getUsageByCaller('fun.proactive', since)];
  return rows.map(r => ({ caller: r.caller, calls: Number(r.calls) || 0, costUsd: Number(r.costUsd) || 0 }));
}

function countToday(kind, t) {
  return store.countRuns({ kind, dayKey: dayKey(t), status: ['running', 'ok', 'partial', 'invalid', 'failed'] });
}

/**
 * Plan 020 F2: what he has told himself he'd do, as codes: [{ id, kind, createdAt, origin }], kind from
 * INTENTION_KINDS, origin the chat it rests on or null. No text, no target: the thought stream words it.
 */
export function openIntentions(at = nowSec()) {
  try {
    return store.activeElements(at).filter(e => e.kind === 'intention').map((e) => {
      // Origins are { originJid, originKind, minLearnedAt } (selfState.originsFromLabelMap): a chat's stays a chat's.
      const first = Array.isArray(e.origins) ? e.origins.find(o => typeof o?.originJid === 'string') : null;
      return { id: e.id, kind: e.intentionKind, createdAt: e.createdAt, origin: first ? { kind: first.originKind === 'group' ? 'group' : 'dm', jid: first.originJid } : null };
    });
  } catch { return []; }
}

/**
 * Plan 020 A4: did this person ask not to be texted first (a person exclusion, detected or the owner's;
 * matched over every identity)? A code answer for the life layer's tell about a plan. Throws on a failed read.
 */
export function personOptedOut(jid) {
  if (typeof jid !== 'string' || !jid) return false;
  return store.exclusionsFor(formsOf(jid)).some(r => r.kind === 'person');
}

/** The status panel (dashboard-api.md). Codes + fixed texts only; never chat or model text. */
export function getStatus() {
  const t = nowSec();
  const s = store.getSettings();
  const st = store.getState();
  const review = store.reviewState(t);
  const ownerJidsSet = proactive.ownerJidsResolved();   // resolved, not merely non-blank (a typo reads as unset)
  let life = { on: false, availability: null };
  try {
    const l = cadence.lifeFacade();
    const on = !!l && typeof l.isLifeOn === 'function' && l.isLifeOn() === true;
    life = { on, availability: on && typeof l.availabilityNow === 'function' ? (l.availabilityNow() ?? null) : null };
  } catch { /* life absent */ }
  const budget = budgetState('mind');
  const since = monthStartTs(t * 1000);
  const byCaller = spendByCaller(since);
  const monthUsd = Math.round(byCaller.reduce((a, r) => a + r.costUsd, 0) * 1e6) / 1e6;
  const start = proactive.dayStart(t);
  const today = {
    glances: countToday('glance', t),
    thinks: countToday('think', t),
    sleeps: countToday('sleep', t),
    drafts: store.countDrafts({ statuses: store.DRAFT_STATUSES, since: start }),
    sends: store.countDrafts({ statuses: ['sent'], since: start }),
  };
  const recent = store.listRuns({ limit: 30 }).filter(r => r.kind !== 'pulse' && r.kind !== 'digest');
  const last = recent[0] || null;
  const gate = mindBudgetOk('think');
  const globalBudget = Number(budget.globalBudgetUsd) || 0;
  const globalSpent = Number(budget.globalSpentUsd) || 0;
  const reminders = [];
  const add = (code) => { if (!reminders.some(r => r.code === code)) reminders.push({ code, text: REMINDERS[code] }); };
  if (s.firstEnabledAt == null) add('not_initialised');
  if (!ownerJidsSet) add('owner_jids_unset');
  if (hooks.isDegraded()) add('degraded');
  if (gate.reason === 'unpriced') add('unpriced');
  if (gate.reason === 'global_cap') add('global_cap');
  if (recent.some(r => r.skipReason === 'no_key' && t - (r.startedAt || 0) < 2 * DAY)) add('no_key');
  if (recent.some(r => r.fellBack && t - (r.startedAt || 0) < 7 * DAY)) add('fell_back');
  if (s.proactiveMode === 'shadow' && fin(s.proactiveModeSince ?? s.firstEnabledAt)
    && t - (s.proactiveModeSince ?? s.firstEnabledAt) >= 14 * DAY) add('shadow_14d');
  if (review.mode === 'window' && fin(review.until) && review.until > t && review.until - t <= 2 * DAY) add('review_window_ending');
  return {
    enabled: isMindOn(),
    active: isMindActive(),
    paused: s.paused,
    pausedAt: s.pausedAt,
    proactiveMode: s.proactiveMode,
    effectiveProactiveMode: proactive.effectiveMode(s),
    modeSince: s.proactiveModeSince,
    ownerJidsSet,
    review: { mode: review.mode, until: review.until, autoActive: review.autoActive, firstEnabledAt: review.firstEnabledAt },
    life,
    budget: { allowed: budget.allowed, reason: budget.reason, spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd,
      gate: gate.ok ? 'ok' : gate.reason },
    spend: { monthUsd, byCaller },
    today,
    caps: JSON.parse(JSON.stringify(config.mind || {})),
    next: { glanceAt: fin(st.lastGlanceAt) ? st.lastGlanceAt + (Number(config.mind?.glanceMinutes) || 45) * 60 : null,
      thinkAt: st.nextThinkAt ?? null, sleepNight: nightKey(t) },
    lastRun: last ? { kind: last.kind, status: last.status, at: last.startedAt, skipReason: last.skipReason ?? null } : null,
    global: { spentUsd: globalSpent, budgetUsd: globalBudget,
      headroomPct: globalBudget > 0 ? Math.round((1 - globalSpent / globalBudget) * 1000) / 10 : null },
    cadence: { started: cadence.isStarted(), fallback: cadence.fallbackActive(), pendingAnchors: cadence.pendingAnchorCount() },
    reminders,
  };
}

/** Elements with origins; `asChatJid` adds usableIn + the exact line that chat would get (track:false). */
export function getSelfState({ asChatJid = null } = {}) {
  let audience = null;
  if (asChatJid) {
    audience = resolveAudience({ chatJid: asChatJid, kind: isGroupJid(asChatJid) ? 'group' : 'dm' });
  }
  return selfState.elementsView({ audience, chatJid: asChatJid });
}
export function listRuns(q = {}) {
  return store.listRuns({ kind: q.kind, before: q.before, limit: Math.min(100, Number(q.limit) || 50) });
}

export function getRun(id) {
  return store.getRun(Number(id)) || null;
}

export function getSelfModel() {
  return selfModel.overview();
}

/** One version with its diff vs its base, scrub report and rationale. Missing → OwnerError 404. */
export function getSelfModelDiff(id) {
  const row = store.getSelfModel(Number(id));
  if (!row) throw new OwnerError('not_found', 404);
  return row;
}

export function listNudges(q = {}) {
  const rows = store.listNudges({ status: q.status, limit: Math.min(200, Number(q.limit) || 100) });
  return rows.map((r) => {
    let effective = null;
    if (r.status === 'active') { try { effective = knobsMod.effective(r.knob, r.scope); } catch { effective = null; } }
    return { ...r, effective };
  });
}

export function getBands() {
  return {
    bands: knobsMod.getBands(),
    knobs: Object.fromEntries(Object.entries(knobsMod.KNOBS).map(([k, v]) => [k, { label: v.label, valueType: v.type, scope: v.scope,
      ttlHours: v.ttlHours }])),
    hardLimits: knobsMod.HARD_LIMITS,
  };
}

export function listProactive(q = {}) {
  const forms = q.chatJid ? formsOf(q.chatJid) : null;
  return store.listDrafts({ status: q.status, chatJid: forms, before: q.before, limit: Math.min(100, Number(q.limit) || 50) })
    .map(r => ({ ...r, chatName: chatNameOf(r.chatJid) }));
}

/**
 * The door for his life (plan 020 B, src/index.js → startLife): nothing while the mind is off, paused or degraded,
 * so stances don't move or drive then, like the knobs.
 */
let stanceActive = { at: 0, on: false };
const STANCE_ACTIVE_MS = 30_000;   // read on every decision and plan: a skill toggle shows within this; a pause at once
function stanceDriving() {
  const t = Date.now();
  if (t - stanceActive.at >= STANCE_ACTIVE_MS || t < stanceActive.at) stanceActive = { at: t, on: isMindActive() };
  return stanceActive.on;
}
export function __resetStanceActiveForTest() { stanceActive = { at: 0, on: false }; }

export const stanceProvider = Object.freeze({
  numbers: () => (stanceDriving() ? stance.numbers() : null),
  sheetLines: (q) => (stanceDriving() ? stance.sheetLines(q) : []),
  publicRows: () => (stanceDriving() ? stance.selfOriginRows() : null),
});

/** At most one line for this turn's tail, audience-checked. '' while imitating or with nothing being raised. */
export function stanceLines(audience, recentText = [], { imitation = null, trigger = null } = {}) {
  if (imitation || !isMindActive()) return '';
  return stance.linesFor(audience, recentText, { trigger }).join(' ');
}

/** His interests and opinions for the dashboard (plan 020 B). */
export function listStances() {
  return stance.view();
}

export function getStanceWhy(id) {
  return stance.why(id);
}

export function listExclusions() {
  const s = store.getSettings();
  return { excludeAll: s.excludeAll, rows: store.listExclusions().map(r => ({ ...r, name: chatNameOf(r.jid) })) };
}

function formsOf(jid) {
  if (isGroupJid(jid)) return [jid];
  const p = resolvePerson(jid);
  return [...new Set([jid, ...(p ? identitiesOf(p) : [])])];
}

// ── owner writes ─────────────────────────────────────────────────────────────

function checkBy(by) {
  if (typeof by !== 'string' || !/^owner:[^\r\n]{1,100}$/.test(by)) throw new OwnerError('bad_actor', 400);
}

const RUN_KINDS = ['glance', 'think', 'sleep'];

export const owner = Object.freeze({
  /** Pause (durable): no runs or sends; queued sends cancelled. */
  setPaused(paused, by) {
    checkBy(by);
    if (typeof paused !== 'boolean') throw new OwnerError('bad_request', 400);
    store.owner.setSetting('paused', paused, by);
    store.owner.setSetting('paused_at', paused ? nowSec() : null, by);
    let cancelled = 0;
    if (paused) cancelled = proactive.cancelQueued('paused');
    stanceActive = { at: 0, on: false };   // his interests stop driving him now, not at the next read
    try { knobsMod.reload(); } catch (err) { issue('knobs', err); }
    return { ok: true, paused, cancelled };
  },

  /** off|shadow|live. live needs OWNER_JIDS; leaving live cancels queued sends. */
  setProactiveMode(mode, by) {
    checkBy(by);
    if (!['off', 'shadow', 'live'].includes(mode)) throw new OwnerError('bad_request', 400);
    const ownerJidsSet = proactive.ownerJidsResolved();   // resolved, not merely non-blank (a typo reads as unset)
    if (mode === 'live' && !ownerJidsSet) throw new OwnerError('owner_jids_unset', 409);
    store.owner.setSetting('proactive_mode', mode, by);
    store.owner.setSetting('proactive_mode_since', nowSec(), by);
    const cancelled = mode !== 'live' ? proactive.cancelQueued('mode_changed') : 0;
    return { ok: true, mode, cancelled };
  },

  /** { mode?: window|review|auto, extendDays?: 1..30 } (research R13). */
  setReview(change = {}, by) {
    checkBy(by);
    const t = nowSec();
    if (change.mode !== undefined) {
      if (!['window', 'review', 'auto'].includes(change.mode)) throw new OwnerError('bad_request', 400);
      if (change.mode === 'window' && !fin(store.getSettings().reviewUntil)) {
        store.owner.setSetting('review_until', t + (Number(config.mind?.reviewDays) || 14) * DAY, by);
      }
      store.owner.setSetting('review_mode', change.mode, by);
    }
    if (change.extendDays !== undefined) {
      const d = Number(change.extendDays);
      if (!Number.isInteger(d) || d < 1 || d > 30) throw new OwnerError('bad_request', 400);
      const until = store.getSettings().reviewUntil;
      store.owner.setSetting('review_until', Math.max(t, fin(until) ? until : t) + d * DAY, by);
    }
    const r = store.reviewState(t);
    return { ok: true, review: { mode: r.mode, until: r.until, autoActive: r.autoActive } };
  },

  approve(id, by) { return selfModel.approve(id, by); },

  // plan 020 B: the starting set and his interests and opinions
  stanceSeed(by) { checkBy(by); return stance.seed(); },
  stanceApprove(ids, by) { checkBy(by); return stance.approve(ids); },
  stanceReject(id, by) { checkBy(by); return stance.reject(id); },
  stancePin(id, pinned, by) { checkBy(by); return stance.setPinned(id, pinned); },
  stanceAnchor(id, anchor, by) { checkBy(by); return stance.setAnchor(id, anchor); },
  stanceReset(id, by) { checkBy(by); return stance.reset(id); },
  /** opts.reason (≤ 200, the owner's own note) is kept on the rejected version; never logged or audited. */
  reject(id, by, opts = {}) { return selfModel.reject(id, by, opts); },
  editSelfModel(text, by) { return selfModel.editText(text, by); },
  revertTo(id, by) { return selfModel.revertTo(id, by); },

  revertNudge(id, by) {
    checkBy(by);
    const n = store.getNudge(Number(id));
    if (!n) throw new OwnerError('not_found', 404);
    // A clamped nudge is in force too (active = 1, applied at its band edge): both revert.
    if (n.active !== true || !['active', 'clamped'].includes(n.status)) throw new OwnerError('not_pending', 409);
    const r = levers.revertNudge(Number(id), by);
    if (!r?.ok) throw new OwnerError('not_pending', 409);
    return { ok: true, id: Number(id) };
  },

  /** A full bands object (contracts/levers.md); out-of-band active nudges → overridden. */
  setBands(bands, by) {
    checkBy(by);
    const v = knobsMod.validateBands(bands);
    if (!v.ok) throw new OwnerError('bad_request', 400);
    store.owner.setSetting('bands', v.bands, by);
    let overridden = 0;
    try { overridden = Number(levers.onBandsChanged(v.bands)?.overridden) || 0; } catch (err) { issue('bands', err); }
    try { knobsMod.reload(); } catch (err) { issue('knobs', err); }
    return { ok: true, overridden };
  },

  dropDraft(id, by) {
    checkBy(by);
    const d = store.getDraft(Number(id));
    if (!d) throw new OwnerError('not_found', 404);
    if (!store.DRAFT_PENDING.includes(d.status)) throw new OwnerError('not_pending', 409);
    store.updateDraft(Number(id), { status: 'dropped', dropReason: 'owner' });
    return { ok: true, id: Number(id) };
  },

  /** Exclude a person (canonical jid) or group; cancels its pending sends. */
  addExclusion(row = {}, by) {
    checkBy(by);
    if (!['person', 'group'].includes(row.kind) || typeof row.jid !== 'string' || !row.jid) throw new OwnerError('bad_request', 400);
    const jid = row.kind === 'person' ? (resolvePerson(row.jid) || row.jid) : row.jid;
    const r = store.owner.addExclusion({ kind: row.kind, jid, note: row.note ?? null }, by);
    const forms = row.kind === 'group' ? [jid] : formsOf(jid);
    const cancelled = store.updateDraftsWhere({ chatForms: forms, statuses: store.DRAFT_PENDING },
      { status: 'cancelled', dropReason: 'excluded' });
    return { ok: true, id: r.id, cancelled };
  },

  /** Owner row → deleted; detected row → owner_cleared (cleared_at = now). Missing → 404. */
  removeExclusion(id, by) {
    checkBy(by);
    const r = store.owner.removeExclusion(Number(id), by);
    if (!r?.ok) throw new OwnerError('not_found', 404);
    return { ok: true, action: r.action };
  },

  setExcludeAll(on, by) {
    checkBy(by);
    if (typeof on !== 'boolean') throw new OwnerError('bad_request', 400);
    store.owner.setSetting('exclude_all', on, by);
    const cancelled = on ? proactive.cancelQueued('exclude_all') : 0;
    return { ok: true, excludeAll: on, cancelled };
  },

  /** glance|think|sleep now, through the serial queue; obeys skill, pause, caps, gap, budget, awake rules. */
  async runNow(kind, by) {
    checkBy(by);
    if (!RUN_KINDS.includes(kind)) throw new OwnerError('bad_request', 400);
    const r = await cadence.ownerRun(kind);
    if (r?.refused) throw new OwnerError(String(r.reason || 'error').slice(0, 40), 409);
    return { ok: true, runId: r?.runId ?? null, status: r?.status ?? 'unknown' };
  },
});
