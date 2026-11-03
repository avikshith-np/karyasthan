// Self-state (spec 008, research R10/R11, data-model "mind_self_state").
//
// Elements are enums, picks and code templates — never mind-authored text:
//   base_mood   glance (Jev) word + intensity; origins [] (self). Expires 6 h after set.
//   mood        think / sleep word + intensity; origins = EVERY chat in the run's input
//               (computed here from the label map, plan review S1-11). Expires 12 h.
//   today (≤ 3) a pick of a digest's clerk today_note ({digestId, today:true}); origin
//               = that digest's chat and period_start. Expires at the morning reset
//               (a 24 h hold bounds it if no reset comes).
//   intention   (≤ 3) a kind enum + target + basis refs; origins = union of the basis
//               digests' chats; [] only for self kinds. Expires after its ttl
//               (1..24 h, ≤ config.mind.intentionTtlHours).
// Origins are written by code from the digests the refs resolve to — never read from
// model output. Every element is checked again at render time.
//
// renderLine(audience, ctx) — sync, never throws ('' on any error):
//   mind off / imitating / life embargo / degraded / life facade not loaded → '';
//   each element must pass canUseIn({originJid:'self', originKind:'self',
//   subjectJid:null, origins}, audience) AND every basis digest is re-read BY PK ON EVERY
//   CALL (no text cache) and must still exist with the chat/period_start stored in
//   origins (plan review S1-06/S1-09), so a revoked/forgotten/purged basis drops the
//   element on the very next prompt;
//   life on → no mood word at all (life's inner-state line owns feelings);
//   today dropped when life is on and life.overSelfMentionBudget(chat) (otherwise —
//   life off, or no such facade function — after 3 tracked renders per chat per day);
//   intentions only for this chat or self;
//   "How you are today: <mood>; <today, today>; on your mind: <intention>." capped at
//   config.mind.selfStateMaxChars (160) by dropping whole fragments from the end.
//
// Sleep output is STAGED: applyMood/applyIntentions(..., {morning:true}) store rows
// marked {stage:'morning'} in basis_json that never render; morningReset() (the first
// glance after the night is done) turns them into live elements — the mood at half
// intensity, intentions with their ttl counted from the reset — and ends the day's
// `today` picks. Nothing here logs chat- or model-derived text.

import * as store from './store.js';
import { now as clockNow, dayKey } from './clock.js';
import { isDegraded } from './hooks.js';
import { MOOD, INTENT_CHAT, INTENT_SELF } from './schema.js';
import { cleanChatText } from './charter.js';
import { canUseIn, resolveAudience } from '../memory/recall.js';
import { chatKeyOf } from '../memory/learningPipeline.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config } from '../utils/config.js';

const HOUR = 3600;
export const MOOD_TTL_SEC = 12 * HOUR;
export const BASE_MOOD_TTL_SEC = 6 * HOUR;
export const TODAY_HOLD_SEC = 24 * HOUR;
export const STAGE_HOLD_SEC = 36 * HOUR;
export const MAX_TODAY = 3;
export const MAX_INTENTIONS = 3;
export const OWN_TODAY_PER_DAY = 3;
export const REPLY_LENGTH_MAX = 30;

export const SELF_NOTE = "Let this colour your tone and length; don't bring it up unless it fits.";
const LINE_HEAD = 'How you are today: ';

// Code templates (research R10). Thread text comes from the basis digest at render time.
const INTENT_TEXT = Object.freeze({
  follow_up: (t) => `meaning to ask about ${t}`,
  share: (t) => `want to share ${t}`,
  check_in: () => 'meaning to check in on them',
  wind_down: () => 'winding down',
  be_present: () => 'want to be present',
  keep_quiet: () => 'not in a chatty mood',
  catch_up: () => 'catching up on chats',
});

const REPLY_LENGTH_TEXT = Object.freeze({ shorter: 'Keep replies brief.', longer: 'You can say a bit more.' });

// ── deps (test seam) ─────────────────────────────────────────────────────────

// Neighbours loaded without blocking module load: the life facade (heavy, and the mind
// reads it only through its facade) and knobs.js (another lane). Until they resolve,
// renderLine fails closed ('') and replyLengthLine returns ''.
let lifeMod = null;
let knobsMod = null;
import('../life/index.js').then((m) => { lifeMod = m; }, () => { lifeMod = null; });
import('./knobs.js').then((m) => { knobsMod = m; }, () => { knobsMod = null; });

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isMindOn: () => isSkillEnabled('mind'),
  isDegraded: () => isDegraded(),
  life: () => lifeMod,
  replyLength: (chatJid) => (knobsMod && knobsMod.knobs && typeof knobsMod.knobs.replyLength === 'function'
    ? knobsMod.knobs.replyLength(chatJid)
    : knobsMod && typeof knobsMod.replyLength === 'function' ? knobsMod.replyLength(chatJid) : 'normal'),
  canUseIn: (item, aud) => canUseIn(item, aud),
  resolveAudience: (q) => resolveAudience(q),
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: { now, isMindOn, isDegraded, life (→ facade|null), replyLength, canUseIn, resolveAudience }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
  if (!d) ownTodayCount.clear();
}

// ── helpers ──────────────────────────────────────────────────────────────────

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const nowSec = () => Math.floor(deps.now());
const isGroupJid = (j) => typeof j === 'string' && j.endsWith('@g.us');
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function isStaged(el) {
  return Array.isArray(el?.basis) && el.basis.some(b => b && typeof b === 'object' && b.stage === 'morning');
}
function stageOf(el) {
  return Array.isArray(el?.basis) ? el.basis.find(b => b && b.stage === 'morning') || null : null;
}
const realBasis = (el) => (Array.isArray(el?.basis) ? el.basis.filter(b => b && !b.stage) : []);

function cleanOrigins(list) {
  const by = new Map();
  for (const o of Array.isArray(list) ? list : []) {
    if (!o || typeof o.originJid !== 'string' || !o.originJid) continue;
    const min = fin(o.minLearnedAt) ? Math.floor(o.minLearnedAt) : 0;   // unknown → 0: the strictest floor
    const kind = o.originKind === 'group' || o.originKind === 'dm' || o.originKind === 'ig' ? o.originKind
      : isGroupJid(o.originJid) ? 'group' : 'dm';
    const cur = by.get(o.originJid);
    if (!cur || min < cur.minLearnedAt) by.set(o.originJid, { originJid: o.originJid, originKind: kind, minLearnedAt: min });
  }
  return [...by.values()];
}

function digestOrigin(d) {
  return { originJid: d.chatJid, originKind: d.originKind === 'group' ? 'group' : 'dm', minLearnedAt: d.periodStart };
}

/**
 * Origins for a run-wide element (mood): one per chat in the run's label map, with
 * minLearnedAt = that chat's digest period_start (the digest must exist and belong to
 * the chat), else the entry's own minLearnedAt (e.g. an episode's learned_at, given by
 * the sleep), else 0 (strictest). → [{originJid, originKind, minLearnedAt}]
 */
export function originsFromLabelMap(labelMap) {
  const out = [];
  for (const e of Object.values(labelMap || {})) {
    if (!e || typeof e.chatJid !== 'string') continue;
    let min = fin(e.minLearnedAt) ? e.minLearnedAt : 0;
    if (e.digestId != null) {
      const d = store.getDigest(e.digestId);
      if (d && d.chatJid === e.chatJid && fin(d.periodStart)) min = d.periodStart;
    }
    out.push({ originJid: e.chatJid, originKind: e.kind === 'group' ? 'group' : 'dm', minLearnedAt: min });
  }
  return cleanOrigins(out);
}

function checkMood(m) {
  if (!m || !MOOD.includes(m.word)) return null;
  const intensity = fin(m.intensity) ? clamp01(m.intensity) : 0.5;
  return { word: m.word, intensity: Math.round(intensity * 100) / 100 };
}

function supersede(els) {
  const ids = els.map(e => e.id);
  return ids.length ? store.setElementStatus(ids, 'superseded') : 0;
}

const live = (t) => store.activeElements(t).filter(e => !isStaged(e));
const staged = (t) => store.activeElements(t).filter(isStaged);

// ── apply (writers) ──────────────────────────────────────────────────────────

/**
 * The run mood (think: `mood`; sleep: `morning_mood` with {morning:true}).
 * opts: { labelMap (the run's input → origins), origins? (extra, e.g. episode
 * learned_at), runId, at, morning }. → element id, or null for an invalid mood.
 */
export function applyMood(mood, { labelMap = null, origins = null, runId = null, at = null, morning = false } = {}) {
  const m = checkMood(mood);
  if (!m) return null;
  const t = fin(at) ? Math.floor(at) : nowSec();
  const og = cleanOrigins([...originsFromLabelMap(labelMap), ...cleanOrigins(origins)]);
  if (morning) {
    supersede(staged(t).filter(e => e.kind === 'mood'));
    return store.insertElement({ kind: 'mood', word: m.word, intensity: m.intensity, origins: og,
      basis: [{ stage: 'morning' }], createdAt: t, expiresAt: t + STAGE_HOLD_SEC, runId });
  }
  supersede(live(t).filter(e => e.kind === 'mood'));
  return store.insertElement({ kind: 'mood', word: m.word, intensity: m.intensity, origins: og, basis: [],
    createdAt: t, expiresAt: t + MOOD_TTL_SEC, runId });
}

/** The glance's base mood (life + aggregate counts only): origins [] (self). → id|null */
export function applyBaseMood(mood, { runId = null, at = null } = {}) {
  const m = checkMood(mood);
  if (!m) return null;
  const t = fin(at) ? Math.floor(at) : nowSec();
  supersede(live(t).filter(e => e.kind === 'base_mood'));
  return store.insertElement({ kind: 'base_mood', word: m.word, intensity: m.intensity, origins: [], basis: [],
    createdAt: t, expiresAt: t + BASE_MOOD_TTL_SEC, runId });
}

/**
 * The think's `today` picks ([{digestId, chatJid?}] from validateThink). Each must
 * resolve to an existing digest (of that chat) with a today_note. A pick replaces an
 * older pick of the same chat; at most 3 stay active (oldest superseded).
 * → { applied: [id], dropped: [{index, reason}] }
 */
export function applyToday(picks, { runId = null, at = null } = {}) {
  const t = fin(at) ? Math.floor(at) : nowSec();
  const applied = [];
  const dropped = [];
  for (const [index, p] of (Array.isArray(picks) ? picks : []).slice(0, MAX_TODAY).entries()) {
    const d = p && p.digestId != null ? store.getDigest(p.digestId) : null;
    if (!d) { dropped.push({ index, reason: 'digest_gone' }); continue; }
    if (p.chatJid && p.chatJid !== d.chatJid) { dropped.push({ index, reason: 'chat_mismatch' }); continue; }
    if (!d.todayNote) { dropped.push({ index, reason: 'no_today_note' }); continue; }
    supersede(live(t).filter(e => e.kind === 'today' && (e.origins || []).some(o => o.originJid === d.chatJid)));
    applied.push(store.insertElement({ kind: 'today', origins: [digestOrigin(d)], basis: [{ digestId: d.id, today: true }],
      createdAt: t, expiresAt: t + TODAY_HOLD_SEC, runId }));
  }
  const all = live(t).filter(e => e.kind === 'today');   // newest first
  if (all.length > MAX_TODAY) supersede(all.slice(MAX_TODAY));
  return { applied, dropped };
}

/**
 * The basis audience rule (research R10, mind-output §5): a basis digest from chat X
 * may support a target Y only if X === Y or canUseIn({originJid:X, originKind,
 * learnedAt: digest.period_start}, aud(Y)) — the item rule with the join-time floor.
 * basis: { digestId, chatJid? }, target: { chatJid }. Usable as validateThink's
 * ctx.basisAllowed. Never throws (false).
 */
export function basisAllowed(basis, target) {
  try {
    const d = basis && basis.digestId != null ? store.getDigest(basis.digestId) : null;
    const y = target?.chatJid;
    if (!d || !y || (basis.chatJid && basis.chatJid !== d.chatJid)) return false;
    if (d.chatJid === y || d.chatJid === chatKeyOf(y)) return true;
    const aud = deps.resolveAudience({ chatJid: y, kind: isGroupJid(y) ? 'group' : 'dm' });
    return deps.canUseIn({ originJid: d.chatJid, originKind: d.originKind === 'group' ? 'group' : 'dm',
      learnedAt: d.periodStart, subjectJid: null }, aud) === true;
  } catch {
    return false;
  }
}

function threadOf(d, k) {
  const list = Array.isArray(d?.threads) ? d.threads : [];
  return list.find(th => Number(th?.k) === Number(k)) || null;
}

/** Validate one intention against the digests it cites. → { row } | { reason } */
function intentionRow(it) {
  if (!it || typeof it !== 'object') return { reason: 'bad_shape' };
  const cap = Math.max(1, Math.min(24, Number(config.mind?.intentionTtlHours) || 24));
  const ttlHours = Math.max(1, Math.min(cap, fin(it.ttlHours) ? Math.round(it.ttlHours) : cap));
  if (INTENT_SELF.includes(it.kind)) {
    if (it.target !== undefined && it.target !== 'self') return { reason: 'bad_target' };
    if (Array.isArray(it.basis) && it.basis.length) return { reason: 'bad_basis' };
    return { row: { kind: it.kind, targetChat: null, basis: [], origins: [] }, ttlHours };
  }
  if (!INTENT_CHAT.includes(it.kind)) return { reason: 'bad_enum' };
  const target = typeof it.targetChat === 'string' && it.targetChat ? it.targetChat : null;
  if (!target) return { reason: 'bad_target' };
  const list = Array.isArray(it.basis) ? it.basis : [];
  const basis = [];
  const origins = [];
  for (const b of list) {
    const d = b && b.digestId != null ? store.getDigest(b.digestId) : null;
    if (!d) return { reason: 'digest_gone' };
    if (b.chatJid && b.chatJid !== d.chatJid) return { reason: 'chat_mismatch' };
    if (b.today === true) {
      if (!d.todayNote) return { reason: 'no_today_note' };
      basis.push({ digestId: d.id, today: true });
    } else {
      if (!threadOf(d, b.thread)) return { reason: 'no_thread' };
      basis.push({ digestId: d.id, thread: Number(b.thread) });
    }
    origins.push(digestOrigin(d));
    if (!basisAllowed({ digestId: d.id }, { chatJid: target })) return { reason: 'basis_audience' };
  }
  if (it.kind === 'check_in') {
    // DM targets only; exactly one ref into THAT DM's own digest (plan review S1-07, S2-03).
    if (isGroupJid(target) || basis.length !== 1) return { reason: 'bad_basis' };
    const d = store.getDigest(basis[0].digestId);
    if (d.chatJid !== target) return { reason: 'foreign_basis' };
  } else if (basis.length < 1 || basis.length > 2 || basis.some(b => b.today)) {
    return { reason: 'bad_basis' };
  }
  return { row: { kind: it.kind, targetChat: target, basis, origins: cleanOrigins(origins) }, ttlHours };
}

const sameIntention = (a, b) => a.intentionKind === b.kind && (a.targetChat || null) === (b.targetChat || null)
  && JSON.stringify(realBasis(a)) === JSON.stringify(b.basis);

function capIntentions(t) {
  const all = live(t).filter(e => e.kind === 'intention');   // newest first
  if (all.length > MAX_INTENTIONS) supersede(all.slice(MAX_INTENTIONS));
}

/**
 * Intentions from validateThink / validateSleep values
 * ([{kind, target, targetChat, basis:[{digestId, chatJid, thread?|today?}], ttlHours}]).
 * Every chat-target intention is re-checked against the digests it cites (exist,
 * thread/today present, check_in basis = the target DM's own digest, audience rule).
 * A duplicate replaces the older row; ≤ 3 stay active. {morning:true} stages them
 * for morningReset (the ttl then counts from the reset).
 * → { applied: [id], dropped: [{index, reason}] }
 */
export function applyIntentions(list, { runId = null, at = null, morning = false } = {}) {
  const t = fin(at) ? Math.floor(at) : nowSec();
  const applied = [];
  const dropped = [];
  for (const [index, it] of (Array.isArray(list) ? list : []).slice(0, MAX_INTENTIONS).entries()) {
    const r = intentionRow(it);
    if (r.reason) { dropped.push({ index, reason: r.reason }); continue; }
    const { row, ttlHours } = r;
    if (morning) {
      applied.push(store.insertElement({ kind: 'intention', intentionKind: row.kind, targetChat: row.targetChat,
        basis: [...row.basis, { stage: 'morning', ttlHours }], origins: row.origins, createdAt: t,
        expiresAt: t + STAGE_HOLD_SEC, runId }));
      continue;
    }
    supersede(live(t).filter(e => e.kind === 'intention' && sameIntention(e, row)));
    applied.push(store.insertElement({ kind: 'intention', intentionKind: row.kind, targetChat: row.targetChat,
      basis: row.basis, origins: row.origins, createdAt: t, expiresAt: t + ttlHours * HOUR, runId }));
  }
  if (!morning) capIntentions(t);
  return { applied, dropped };
}

/**
 * The morning reset (research R5): run by the first glance after mind_nights[NK] is
 * done. Ends the `today` picks made before `sleptAt` (default: now), turns the newest
 * staged morning mood into the live mood at HALF its intensity (origins kept), and
 * starts the staged intentions with their ttl counted from now. Idempotent: staged rows
 * are consumed, and a later think's picks (created after sleptAt) are left alone.
 * → { today, mood: id|null, intentions: [id] }
 */
export function morningReset({ at = null, sleptAt = null } = {}) {
  const t = fin(at) ? Math.floor(at) : nowSec();
  const cut = fin(sleptAt) ? Math.floor(sleptAt) : t;
  const out = { today: 0, mood: null, intentions: [] };
  const todays = live(t).filter(e => e.kind === 'today' && e.createdAt <= cut);
  if (todays.length) out.today = store.setElementStatus(todays.map(e => e.id), 'done');

  const st = staged(t);
  const moods = st.filter(e => e.kind === 'mood');   // newest first
  if (moods.length) {
    const m = moods[0];
    supersede(live(t).filter(e => e.kind === 'mood'));
    out.mood = store.insertElement({ kind: 'mood', word: m.word,
      intensity: Math.round(clamp01((Number(m.intensity) || 0) / 2) * 100) / 100,
      origins: cleanOrigins(m.origins), basis: [], createdAt: t, expiresAt: t + MOOD_TTL_SEC, runId: m.runId ?? null });
    store.setElementStatus(moods.map(e => e.id), 'done');
  }
  const ints = st.filter(e => e.kind === 'intention').reverse();   // oldest first, so the newest end up newest
  for (const e of ints) {
    const ttl = Math.max(1, Math.min(24, Number(stageOf(e)?.ttlHours) || 24));
    const basis = realBasis(e);
    supersede(live(t).filter(x => x.kind === 'intention'
      && sameIntention(x, { kind: e.intentionKind, targetChat: e.targetChat, basis })));
    out.intentions.push(store.insertElement({ kind: 'intention', intentionKind: e.intentionKind, targetChat: e.targetChat,
      basis, origins: cleanOrigins(e.origins), createdAt: t, expiresAt: t + ttl * HOUR, runId: e.runId ?? null }));
  }
  if (ints.length) store.setElementStatus(ints.map(e => e.id), 'done');
  capIntentions(t);
  return out;
}

/** Expire elements whose time is up (the pulse calls this every tick). → changes */
export function expire(t = nowSec()) {
  return store.expireElements(Math.floor(t));
}

// ── render ───────────────────────────────────────────────────────────────────

// Per chat-day count of tracked renders that carried a `today` fragment (the fallback
// self-mention budget when the life facade has no overSelfMentionBudget).
const ownTodayCount = new Map();

function lifeView() {
  const life = deps.life();
  if (!life || typeof life !== 'object') return null;
  return life;
}

function embargoed(life) {
  if (typeof life.embargoActive === 'function') { if (life.embargoActive()) return true; }
  if (typeof life.lifeGuardNote === 'function') {
    const note = life.lifeGuardNote();
    if (note !== null && note !== undefined && note !== '') return true;
  }
  return false;
}

/** Usable in this audience: canUseIn over the stored origins (an empty list = self). */
function usable(el, audience) {
  if (!Array.isArray(el.origins)) return false;
  const origins = el.origins.map(o => ({ originJid: o?.originJid, minLearnedAt: o?.minLearnedAt }));
  return deps.canUseIn({ originJid: 'self', originKind: 'self', subjectJid: null, origins }, audience) === true;
}

/**
 * Re-read every basis digest by PK and match it against the stored origins. → the
 * resolved digests ([{d, b}]) or null when any is gone or no longer matches.
 */
function resolveBasis(el) {
  const out = [];
  const origins = Array.isArray(el.origins) ? el.origins : [];
  for (const b of realBasis(el)) {
    if (b.digestId == null) return null;
    const d = store.getDigest(b.digestId);
    if (!d) return null;
    if (!origins.some(o => o && o.originJid === d.chatJid && o.minLearnedAt === d.periodStart)) return null;
    out.push({ d, b });
  }
  return out;
}

function moodText(el) {
  const i = Number(el.intensity);
  const adv = fin(i) && i >= 0.75 ? 'very ' : fin(i) && i < 0.35 ? 'a bit ' : '';
  return MOOD.includes(el.word) ? `${adv}${el.word}` : null;
}

function cleanFragment(s, cap) {
  return cleanChatText(String(s || '').replace(/[;]+/g, ','), cap).replace(/[.\s]+$/, '');
}

function todayText(el) {
  const res = resolveBasis(el);
  if (!res || res.length !== 1 || res[0].b.today !== true) return null;
  const t = cleanFragment(res[0].d.todayNote, 80);
  return t || null;
}

function intentionText(el, chatForms) {
  const tpl = INTENT_TEXT[el.intentionKind];
  if (!tpl) return null;
  if (INTENT_SELF.includes(el.intentionKind)) {
    return el.targetChat == null && realBasis(el).length === 0 ? tpl() : null;
  }
  if (!el.targetChat || !chatForms.has(el.targetChat)) return null;
  const res = resolveBasis(el);
  if (!res || !res.length) return null;
  if (el.intentionKind === 'check_in') {
    return res.length === 1 && res[0].d.chatJid === el.targetChat ? tpl() : null;
  }
  const first = res.find(r => r.b.thread != null);
  const th = first ? threadOf(first.d, first.b.thread) : null;
  const text = th ? cleanFragment(th.text, 100) : '';
  return text ? tpl(text) : null;
}

function assemble(mood, todays, ints, cap) {
  const items = [];
  if (mood) items.push({ k: 'mood', t: mood });
  for (const t of todays) items.push({ k: 'today', t });
  for (const t of ints) items.push({ k: 'int', t });
  const build = (list) => {
    if (!list.length) return '';
    const parts = [];
    const m = list.filter(x => x.k === 'mood').map(x => x.t);
    const td = list.filter(x => x.k === 'today').map(x => x.t);
    const it = list.filter(x => x.k === 'int').map(x => x.t);
    if (m.length) parts.push(m[0]);
    if (td.length) parts.push(td.join(', '));
    if (it.length) parts.push(`on your mind: ${it.join(', ')}`);
    return `${LINE_HEAD}${parts.join('; ')}.`;
  };
  const list = [...items];
  let line = build(list);
  while (list.length && line.length > cap) { list.pop(); line = build(list); }
  return { line, kinds: new Set(list.map(x => x.k)) };
}

/**
 * The self-state line for one prompt. audience = resolveAudience(...) of the chat
 * being answered; ctx: { chatJid, isGroup, imitation = null, track = true }.
 * Sync, < 2 ms, never throws; '' when off, imitating, embargo, degraded, the life
 * facade is not loaded, or nothing is usable.
 */
export function renderLine(audience, { chatJid = null, imitation = null, track = true } = {}) {
  try {
    if (imitation) return '';
    if (!deps.isMindOn()) return '';
    if (deps.isDegraded()) return '';
    if (!audience || typeof audience !== 'object') return '';
    const life = lifeView();
    if (!life || embargoed(life)) return '';
    const t = nowSec();
    const els = live(t);
    if (!els.length) return '';
    const lifeOn = typeof life.isLifeOn === 'function' ? !!life.isLifeOn() : false;
    const chat = chatJid || audience.chatJid || null;
    const chatForms = new Set([chat, chat ? chatKeyOf(chat) : null, audience.chatJid,
      ...(Array.isArray(audience.sameChat) ? audience.sameChat : [])].filter(Boolean));

    let mood = null;
    if (!lifeOn) {
      const m = els.find(e => e.kind === 'mood' && usable(e, audience));
      const b = m ? null : els.find(e => e.kind === 'base_mood' && usable(e, audience));
      mood = m ? moodText(m) : b ? moodText(b) : null;
    }

    let todays = [];
    const day = dayKey(t);
    const countKey = `${chatKeyOf(chat) || chat}|${day}`;
    // Life's budget counts only through its onReplySent, which runs while life is on;
    // with life off its answer is always false, so the mind's own count applies then.
    const lifeBudget = lifeOn && typeof life.overSelfMentionBudget === 'function';
    let overBudget;
    if (lifeBudget) overBudget = !!life.overSelfMentionBudget(chat);
    else overBudget = (ownTodayCount.get(countKey) || 0) >= OWN_TODAY_PER_DAY;
    if (!overBudget) {
      todays = els.filter(e => e.kind === 'today' && usable(e, audience))
        .map(todayText).filter(Boolean).slice(0, MAX_TODAY);
    }

    const ints = els.filter(e => e.kind === 'intention' && usable(e, audience))
      .map(e => intentionText(e, chatForms)).filter(Boolean).slice(0, MAX_INTENTIONS);

    const cap = Math.max(40, Math.min(400, Number(config.mind?.selfStateMaxChars) || 160));
    const { line, kinds } = assemble(mood, todays, ints, cap);
    if (line && kinds.has('today') && track !== false && !lifeBudget) {
      for (const k of ownTodayCount.keys()) if (!k.endsWith(`|${day}`)) ownTodayCount.delete(k);
      ownTodayCount.set(countKey, (ownTodayCount.get(countKey) || 0) + 1);
    }
    return line;
  } catch {
    return '';
  }
}

/**
 * SELF_NOTE when the mind line rendered (line non-empty) and the prompt did not
 * already carry life's LIFE_SITUATION_NOTE; else ''. Pure: the caller passes the line
 * it just rendered (no module state shared across concurrent chats).
 */
export function selfStateNote({ lifeNoteEmitted = false, line = '' } = {}) {
  return typeof line === 'string' && line.length > 0 && !lifeNoteEmitted ? SELF_NOTE : '';
}

/**
 * The replyLength lever as its own short line (≤ 30 chars, outside the 160 cap), so
 * it applies even when the self-state line is empty. '' when the mind is off, the
 * knob is 'normal', knobs.js is not loaded, or on any error.
 */
export function replyLengthLine(chatJid) {
  try {
    if (!deps.isMindOn()) return '';
    const v = deps.replyLength(chatJid);
    const s = REPLY_LENGTH_TEXT[v] || '';
    return s.length <= REPLY_LENGTH_MAX ? s : '';
  } catch {
    return '';
  }
}

// ── dashboard view ───────────────────────────────────────────────────────────

/**
 * Operator view of the active elements (the dashboard sees everything): Element
 * shape of contracts/mind-api.md with the code-rendered text; with `audience`, each
 * element gets usableIn and `preview` is the exact line that chat would get
 * (track:false). Staged morning rows are listed with staged:true.
 */
export function elementsView({ audience = null, chatJid = null } = {}) {
  const t = nowSec();
  const els = store.activeElements(t);
  const elements = els.map((e) => {
    let text = null;
    if (e.kind === 'mood' || e.kind === 'base_mood') text = moodText(e);
    else if (e.kind === 'today') text = todayText(e);
    else if (e.kind === 'intention') {
      const forms = new Set([e.targetChat].filter(Boolean));
      text = intentionText(e, forms);
    }
    const out = { id: e.id, kind: e.kind, text, word: e.word ?? null, intensity: e.intensity ?? null,
      intentionKind: e.intentionKind ?? null, targetChat: e.targetChat ?? null,
      origins: (Array.isArray(e.origins) ? e.origins : []).map(o => ({ originJid: o.originJid,
        originKind: o.originKind ?? null, minLearnedAt: o.minLearnedAt ?? null })),
      createdAt: e.createdAt, expiresAt: e.expiresAt, staged: isStaged(e) };
    if (audience) out.usableIn = !isStaged(e) && usable(e, audience) && (realBasis(e).length === 0 || !!resolveBasis(e));
    return out;
  });
  const res = { elements };
  if (audience) res.preview = renderLine(audience, { chatJid: chatJid || audience.chatJid, track: false });
  return res;
}
