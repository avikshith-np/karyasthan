// Lever executor (spec 008, research R14, contracts/levers.md): the only code path from
// a mind run's `nudges` to behaviour. It writes mind_nudges rows through the store and
// reloads the knob overlay (knobs.js); it never touches `config`, `.env`, skills, mute
// state, exclusions or any other table, and it has code paths for exactly the five
// allow-listed knobs (KNOBS). Anything else is refused `not_allowed` and never
// interpreted.
//
//   applyNudges(nudges, runId, labelMap, { fellBack })   the contract algorithm, one result per nudge
//   expireNudges(now)                                    the pulse: active rows past expires_at → expired
//   onOwnerConfigChange(appliedKeys)                     FR-023: an owner PATCH of responseRate overrides
//   onBandsChanged(bands?)                               owner narrowed a band: out-of-band actives → overridden
//   revertNudge(id, by)                                  owner revert (routes/mind.js via the facade)
//
// Scope written to mind_nudges is 'global' or a GROUP JID taken from the run's label
// map (never from model text). Audit payloads and log lines carry ids, knob names,
// values and statuses only — never the model's reason text (plan review S1-13).

import * as store from './store.js';
import * as knobsMod from './knobs.js';
import { KNOBS, DEFAULT_BANDS, LENGTHS, bandFor, clampToBand, effective, getBands, effectiveBands, validateBands } from './knobs.js';
import { now as clockNow } from './clock.js';
import { resolveRef } from './labels.js';
import { cleanChatText } from './charter.js';
import { isFresh } from '../memory/membership.js';
import { auditWrite } from '../dashboard/audit.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export { KNOBS, DEFAULT_BANDS, validateBands };

export const MAX_PER_RUN = 3;
export const MAX_ACTIVE = 6;
export const COOLDOWN_SEC = 12 * 3600;
export const TTL_MIN_H = 1;
export const TTL_MAX_H = 72;

// Owner config keys (canonical, after legacy aliases) that override a knob (FR-023).
const OWNER_KEY_TO_KNOBS = Object.freeze({ responseRate: ['responseRate'] });
// updateConfig reports applied keys by their RAW name (it may be a legacy alias, or
// the .env spelling on a persist path). Map them to canonical keys first.
const KEY_ALIASES = Object.freeze({ RESPONSE_RATE: 'responseRate', response_rate: 'responseRate' });

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isFresh: (jid) => isFresh(jid),
  auditWrite: (...a) => auditWrite(...a),
  reload: () => knobsMod.reload(),
  base: () => Number(config.responseRate),
  logger,
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: { now, isFresh, auditWrite, reload, base, logger }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const round4 = (v) => Math.round(v * 10000) / 10000;
const nowSec = () => Math.floor(deps.now());
const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 40) || '?';
const code = (err) => String(err?.code || err?.name || 'error').slice(0, 60);

function ownerBase() {
  const b = Number(deps.base());
  return Number.isFinite(b) ? b : 0;
}

function reloadQuietly(where) {
  try { deps.reload(); } catch (err) {
    try { deps.logger.warn({ evt: 'issue', where: `mind.levers.${where}`, code: code(err) }, 'mind: knob reload failed'); } catch { /* */ }
  }
}

function audit(action, target, payload) {
  try { deps.auditWrite('mind', action, target, payload); } catch { /* auditWrite already swallows */ }
}

/** A JSON scalar for the requested/prev/value columns (non-scalars become a short string). */
function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string' || typeof v === 'boolean') return typeof v === 'string' ? v.slice(0, 40) : v;
  return String(v).slice(0, 40);
}

function ttlOf(nudge, def) {
  const raw = fin(nudge?.ttlHours) ? nudge.ttlHours : fin(nudge?.ttl_hours) ? nudge.ttl_hours : def.ttlHours;
  return Math.round(Math.min(TTL_MAX_H, Math.max(TTL_MIN_H, raw)));
}

/**
 * The stored scope of a nudge: 'global' for the global knobs; for groupResponseRate a
 * group label in this run's map that resolves to a group the membership sync calls
 * fresh; replyLength takes either. → { scope } | { reason:'bad_scope', label }
 */
function resolveScope(nudge, def, labelMap) {
  const raw = nudge?.scope == null ? 'global' : nudge.scope;
  if (raw === 'global') return def.scope === 'group' ? { reason: 'bad_scope', label: 'global' } : { scope: 'global' };
  if (def.scope === 'global') return { reason: 'bad_scope', label: safeName(raw) };
  const r = resolveRef(labelMap || {}, raw);
  if (!r || r.type !== 'chat' || r.chatKind !== 'group' || !r.chatJid.endsWith('@g.us')) {
    return { reason: 'bad_scope', label: safeName(raw) };
  }
  if (nudge.scopeChat != null && nudge.scopeChat !== r.chatJid) return { reason: 'bad_scope', label: safeName(raw) };
  let fresh = false;
  try { fresh = deps.isFresh(r.chatJid) === true; } catch { fresh = false; }
  if (!fresh) return { reason: 'bad_scope', label: safeName(raw) };
  return { scope: r.chatJid };
}

/** Move at most maxStep (numbers) or one step (replyLength) from cur toward v. */
function clampStep(knob, v, cur, band) {
  if (knob === 'replyLength') {
    const ci = LENGTHS.indexOf(cur);
    const vi = LENGTHS.indexOf(v);
    if (ci < 0 || vi < 0) return null;
    const step = Math.max(-1, Math.min(1, vi - ci));
    const out = LENGTHS[ci + step];
    return band.allowed.includes(out) ? out : cur;
  }
  if (!fin(v) || !fin(cur)) return null;
  const s = fin(band.maxStep) ? band.maxStep : 0;
  return round4(Math.min(cur + s, Math.max(cur - s, v)));
}

const same = (a, b) => (fin(a) && fin(b) ? Math.abs(a - b) < 1e-9 : a === b);

function storeRefused(base, refuseReason) {
  try {
    const id = store.insertNudge({ ...base, status: 'refused', refuseReason, active: false });
    return id;
  } catch (err) {
    try { deps.logger.warn({ evt: 'issue', where: 'mind.levers.refused', code: code(err) }, 'mind: refused nudge not stored'); } catch { /* */ }
    return null;
  }
}

/**
 * Apply a run's nudges (already schema-valid: { knob, scope: 'global'|'Cn', scopeChat?,
 * value, ttlHours?, reason? }; raw `ttl_hours` is accepted too). opts.fellBack: the run
 * fell back to another model → every nudge refused 'fell_back' (research R4).
 * → { results: [{ index, knob, scope, status: 'active'|'clamped'|'refused', refuseReason?,
 *     id?, prev?, value?, requested?, expiresAt?, stored }], applied, refused }
 * Never throws.
 */
export function applyNudges(nudges, runId = null, labelMap = {}, { fellBack = false } = {}) {
  const list = Array.isArray(nudges) ? nudges : [];
  const results = [];
  const t = nowSec();
  const base = ownerBase();
  const bands = getBands();
  let changed = false;
  try { deps.reload(); } catch { /* use what is loaded; a failure leaves owner values */ }

  for (const [index, nudge] of list.entries()) {
    const knobName = typeof nudge?.knob === 'string' ? nudge.knob : '';
    const def = Object.prototype.hasOwnProperty.call(KNOBS, knobName) ? KNOBS[knobName] : null;
    const requested = scalar(nudge?.value);
    const reason = typeof nudge?.reason === 'string' ? cleanChatText(nudge.reason, 160) || null : null;

    // Structural refusal: only the five names have code paths. Not storable (the store
    // keeps knob to the allow-list), so it is returned and audited, never interpreted.
    if (!def) {
      results.push({ index, knob: safeName(knobName), scope: null, status: 'refused', refuseReason: 'not_allowed', stored: false });
      audit('mind.nudge', `${safeName(knobName)}:refused`, { status: 'refused', refuseReason: 'not_allowed', runId });
      continue;
    }

    const band = bandFor(knobName, bands, base);
    const sc = resolveScope(nudge, def, labelMap);
    const scopeKey = sc.scope || sc.label || 'global';
    const cur = effective(knobName, sc.scope || 'global');
    const row = { knob: knobName, scope: scopeKey, prevValue: scalar(cur), value: scalar(cur), requested,
      band: { ...band, base }, reason, runId, createdAt: t };
    const refuse = (why) => {
      const id = storeRefused(row, why);
      results.push({ index, knob: knobName, scope: scopeKey, status: 'refused', refuseReason: why, id, stored: id != null,
        prev: cur, requested });
    };

    if (fellBack) { refuse('fell_back'); continue; }
    if (index >= MAX_PER_RUN) { refuse('too_many'); continue; }
    if (band.disabled) { refuse('not_allowed'); continue; }
    const validValue = knobName === 'replyLength' ? LENGTHS.includes(nudge?.value) : fin(nudge?.value);
    if (!validValue) { refuse('not_allowed'); continue; }
    if (sc.reason) { refuse('bad_scope'); continue; }
    // The current value outside its band (the owner's base above the hard ceiling, say):
    // clamping would jump to the band edge whatever was asked, so refuse instead.
    if (knobName !== 'replyLength' && fin(cur) && fin(band.min) && fin(band.max)
      && (cur < band.min - 1e-9 || cur > band.max + 1e-9)) { refuse('not_allowed'); continue; }

    try {
      const last = store.lastApplied(knobName, sc.scope);
      if (last != null && t - last < COOLDOWN_SEC) { refuse('cooldown'); continue; }
      const active = store.activeNudges().filter(r => fin(r.expiresAt) && r.expiresAt > t);
      const hasSame = active.some(r => r.knob === knobName && r.scope === sc.scope);
      if (active.length >= MAX_ACTIVE && !hasSame) { refuse('too_many'); continue; }

      let v = clampToBand(knobName, nudge.value, band);
      v = clampStep(knobName, v, cur, band);
      v = clampToBand(knobName, v, band);
      if (v === null || same(v, cur)) { refuse('no_change'); continue; }
      const status = same(v, nudge.value) ? 'active' : 'clamped';
      const ttl = ttlOf(nudge, def);
      const expiresAt = t + ttl * 3600;
      const id = store.insertNudge({ ...row, value: scalar(v), status, active: true, expiresAt });
      changed = true;
      results.push({ index, knob: knobName, scope: sc.scope, status, id, prev: cur, value: v, requested, expiresAt, stored: true });
      audit('mind.nudge', `${knobName}:${sc.scope}`, { prev: cur, value: v, requested, status, expiresAt, runId });
    } catch (err) {
      try { deps.logger.warn({ evt: 'issue', where: 'mind.levers.apply', knob: knobName, code: code(err) }, 'mind: nudge not applied'); } catch { /* */ }
      results.push({ index, knob: knobName, scope: scopeKey, status: 'refused', refuseReason: 'error', stored: false });
    }
  }
  if (changed) reloadQuietly('apply');
  const applied = results.filter(r => r.status === 'active' || r.status === 'clamped').length;
  return { results, applied, refused: results.length - applied };
}

/** End every active nudge whose expires_at has passed (the pulse). → how many ended. Never throws. */
export function expireNudges(t = nowSec()) {
  let n = 0;
  try {
    for (const r of store.activeNudges()) {
      if (!fin(r.expiresAt) || r.expiresAt <= t) n += store.endNudge(r.id, 'expired', 'expiry');
    }
  } catch (err) {
    try { deps.logger.warn({ evt: 'issue', where: 'mind.levers.expire', code: code(err) }, 'mind: nudge expiry failed'); } catch { /* */ }
  }
  if (n) reloadQuietly('expire');
  return n;
}

/**
 * The owner changed live config (routes/config.js, after auditWrite): every active
 * nudge on a knob the owner set is ended 'overridden' (FR-023). appliedKeys =
 * Object.keys(result.applied || {}) (raw keys; aliases are mapped here).
 * → { overridden: n, knobs: [] }. Never throws.
 */
export function onOwnerConfigChange(appliedKeys = []) {
  const out = { overridden: 0, knobs: [] };
  try {
    const keys = (Array.isArray(appliedKeys) ? appliedKeys : []).filter(k => typeof k === 'string')
      .map(k => KEY_ALIASES[k] || k);
    const hit = [...new Set(keys.flatMap(k => OWNER_KEY_TO_KNOBS[k] || []))];
    if (!hit.length) return out;
    const ids = [];
    for (const r of store.activeNudges()) {
      if (hit.includes(r.knob) && store.endNudge(r.id, 'overridden', 'override')) ids.push(r.id);
    }
    out.overridden = ids.length;
    out.knobs = hit;
    if (ids.length) {
      audit('mind.nudge.overridden', hit.join(','), { ids, cause: 'owner_config' });
      reloadQuietly('owner');
    }
  } catch (err) {
    try { deps.logger.warn({ evt: 'issue', where: 'mind.levers.owner', code: code(err) }, 'mind: owner override failed'); } catch { /* */ }
  }
  return out;
}

/**
 * The owner saved new bands (PUT /api/mind/bands, after store.owner.setSetting('bands')):
 * active nudges outside their knob's new band, or on a now-disabled knob, are ended
 * 'overridden'. `bands` defaults to the stored owner bands. → { overridden: n }. Never throws.
 */
export function onBandsChanged(bands = undefined) {
  const out = { overridden: 0 };
  try {
    const eff = effectiveBands(bands === undefined ? store.getSettings().bands : bands);
    const base = ownerBase();
    const ids = [];
    for (const r of store.activeNudges()) {
      if (!KNOBS[r.knob]) continue;
      const band = bandFor(r.knob, eff, base);
      const inBand = !band.disabled && same(clampToBand(r.knob, r.value, band), r.value);
      if (!inBand && store.endNudge(r.id, 'overridden', 'override')) ids.push(r.id);
    }
    out.overridden = ids.length;
    if (ids.length) audit('mind.nudge.overridden', 'bands', { ids, cause: 'owner_bands' });
  } catch (err) {
    try { deps.logger.warn({ evt: 'issue', where: 'mind.levers.bands', code: code(err) }, 'mind: band override failed'); } catch { /* */ }
  }
  reloadQuietly('bands');
  return out;
}

/**
 * Owner revert of one active nudge (POST /api/mind/nudges/:id/revert; the route audits
 * mind.nudge.revert). by = 'owner:<user>'. → { ok, changes }
 */
export function revertNudge(id, by) {
  if (typeof by !== 'string' || !/^owner:\S{1,80}$/.test(by)) throw new TypeError('revertNudge: by must be owner:<user>');
  const changes = store.endNudge(Number(id), 'reverted', by);
  if (changes) reloadQuietly('revert');
  return { ok: changes > 0, changes };
}
