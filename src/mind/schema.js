// Model output validation (spec 008, contracts/mind-output.md, research R22).
//
// These are the only shapes accepted from a model. Order, as in the contract:
//   1. raw size check (before parsing);
//   2. parseMindJson: the first balanced {...} (code fences and trailing prose ignored);
//   3. top-level shape — a failure makes the whole run invalid, nothing changes;
//   4. each element on its own — a failing element is dropped and reported {path, reason};
//   5. refs resolved against the run's label map (unknown → dropped unknown_ref);
//   6. every accepted string is sanitized (sanitizeWebContent, fence tokens removed,
//      whitespace collapsed) and then capped again.
// Unknown keys are dropped at every level. Numbers must be finite; only ttl_hours and
// next_think_in_minutes are clamped, every other out-of-range value is dropped.
// A run is also invalid when it had elements and every one of them was dropped.
//
// Every validator takes the RAW model text and returns
//   { ok: true, value, dropped }  or  { ok: false, error, dropped }.
// Nothing here touches the DB, the network or the logger; ids, chats and origins in
// `value` come from the label map, never from the model.

import { sanitizeWebContent } from '../brain/webSearch.js';
import { cleanChatText, stripFenceTokens } from './charter.js';
import { resolveRef } from './labels.js';

export const MOOD = ['upbeat', 'content', 'calm', 'playful', 'excited', 'tired', 'drained', 'restless', 'irritable',
  'low', 'anxious', 'bored'];
export const TONE = ['neutral', 'warm', 'playful', 'tense', 'sad', 'busy'];
export const INTENT_CHAT = ['follow_up', 'check_in', 'share'];
export const INTENT_SELF = ['wind_down', 'be_present', 'keep_quiet', 'catch_up'];
export const REACH_KIND = ['follow_up', 'check_in', 'share'];
export const KNOB = ['responseRate', 'groupResponseRate', 'reactTendency', 'replyLength', 'proactiveAppetite'];
export const LENGTH = ['shorter', 'normal', 'longer'];

/** Raw-text size limits in bytes (research R22). */
export const MAX_BYTES = Object.freeze({
  think: 16384, sleep: 20480, selfmodel: 4096, digest: 6144, episode: 6144, weekly: 6144, draft: 2048,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

// ── parse ────────────────────────────────────────────────────────────────────

/**
 * The first balanced JSON object in `text` (fences and prose around it ignored;
 * braces inside string literals respected). Text over `maxBytes` is rejected
 * unparsed. → { ok:true, value } | { ok:false, error: 'empty'|'oversize'|'no_object'|'bad_json' }
 */
export function parseMindJson(text, maxBytes = 16384) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, error: 'oversize' };
  const start = text.indexOf('{');
  if (start < 0) return { ok: false, error: 'no_object' };
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return { ok: false, error: 'no_object' };
  let value;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, error: 'bad_json' }; }
  if (!isObj(value)) return { ok: false, error: 'no_object' };
  return { ok: true, value };
}

// ── small field helpers ──────────────────────────────────────────────────────

/** A model string → sanitized, fence-free, collapsed, capped; null when not a usable string. */
function cleanStr(v, max, min = 1) {
  if (typeof v !== 'string') return null;
  const s = cleanChatText(v, max);
  return s.length >= min ? s : null;
}

function clampNum(v, lo, hi, def) {
  if (!fin(v)) return def;
  return Math.min(hi, Math.max(lo, v));
}

function dropUnknown(obj, allowed, base, dropped) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) dropped.push({ path: base ? `${base}.${k}` : k, reason: 'unknown_key' });
  }
}

function topLevel(raw, maxBytes) {
  const parsed = parseMindJson(raw, maxBytes);
  if (!parsed.ok) return { error: parsed.error };
  const o = parsed.value;
  if (o.v !== 1) return { error: 'bad_version' };
  return { o };
}

function listOf(o, key, max, dropped) {
  if (!has(o, key) || o[key] == null) return [];
  if (!Array.isArray(o[key])) { dropped.push({ path: key, reason: 'not_a_list' }); return null; }
  const list = o[key];
  for (let i = max; i < list.length; i++) dropped.push({ path: `${key}[${i}]`, reason: 'too_many' });
  return list.slice(0, max);
}

function moodOf(v, path, dropped) {
  if (!isObj(v)) { dropped.push({ path, reason: 'bad_shape' }); return null; }
  dropUnknown(v, ['word', 'intensity'], path, dropped);
  if (!MOOD.includes(v.word)) { dropped.push({ path, reason: 'bad_enum' }); return null; }
  if (!fin(v.intensity) || v.intensity < 0 || v.intensity > 1) { dropped.push({ path, reason: 'out_of_range' }); return null; }
  return { word: v.word, intensity: v.intensity };
}

// A basis ref resolved to what code needs (the digest it points at).
function basisOf(r) {
  const b = { ref: `${r.label}${r.type === 'thread' ? `.t${r.thread}` : r.type === 'today' ? '.today' : ''}`,
    label: r.label, chatJid: r.chatJid, chatKind: r.chatKind, digestId: r.entry.digestId };
  if (r.type === 'thread') b.thread = r.thread;
  if (r.type === 'today') b.today = true;
  return b;
}

/**
 * Shared chat-target rule (intentions and reach_out): target must be a chat ref in
 * the map; follow_up/share need 1–2 thread refs; check_in needs a DM target and
 * exactly one ref (today or thread) into that same chat's digest. ctx.basisAllowed
 * (basis, target) → boolean applies the audience rule (a throw counts as false).
 * → { target, basis } | { reason }
 */
function chatTargetAndBasis(item, ctx, kind) {
  const target = resolveRef(ctx.labelMap, item.target);
  if (!target || target.type !== 'chat') return { reason: typeof item.target === 'string' && /^C\d/.test(item.target) ? 'unknown_ref' : 'bad_target' };
  const refs = item.basis == null ? [] : item.basis;
  if (!Array.isArray(refs)) return { reason: 'bad_basis' };
  const uniq = [...new Set(refs.filter(r => typeof r === 'string'))];
  if (uniq.length !== refs.length) return { reason: 'bad_basis' };
  const resolved = [];
  for (const ref of uniq) {
    const r = resolveRef(ctx.labelMap, ref);
    if (!r) return { reason: 'unknown_ref' };
    resolved.push(r);
  }
  if (kind === 'check_in') {
    if (target.chatKind !== 'dm') return { reason: 'check_in_not_dm' };
    if (resolved.length !== 1) return { reason: 'bad_basis' };
    const r = resolved[0];
    if ((r.type !== 'today' && r.type !== 'thread') || r.label !== target.label) return { reason: 'foreign_basis' };
  } else {
    if (resolved.length < 1 || resolved.length > 2) return { reason: 'bad_basis' };
    if (resolved.some(r => r.type !== 'thread')) return { reason: 'bad_basis' };
  }
  const basis = resolved.map(basisOf);
  if (typeof ctx.basisAllowed === 'function') {
    for (const b of basis) {
      let ok = false;
      try { ok = ctx.basisAllowed(b, { label: target.label, chatJid: target.chatJid, chatKind: target.chatKind }) === true; }
      catch { ok = false; }
      if (!ok) return { reason: 'basis_audience' };
    }
  }
  return { target, basis };
}

function intentionOf(item, path, ctx, dropped) {
  if (!isObj(item)) { dropped.push({ path, reason: 'bad_shape' }); return null; }
  dropUnknown(item, ['kind', 'target', 'basis', 'ttl_hours'], path, dropped);
  const ttlHours = Math.round(clampNum(item.ttl_hours, 1, 24, 24));
  if (INTENT_SELF.includes(item.kind)) {
    if (item.target !== 'self') { dropped.push({ path, reason: 'bad_target' }); return null; }
    if (item.basis != null && !(Array.isArray(item.basis) && item.basis.length === 0)) {
      dropped.push({ path, reason: 'bad_basis' });
      return null;
    }
    return { kind: item.kind, target: 'self', targetChat: null, basis: [], ttlHours };
  }
  if (!INTENT_CHAT.includes(item.kind)) { dropped.push({ path, reason: 'bad_enum' }); return null; }
  const r = chatTargetAndBasis(item, ctx, item.kind);
  if (r.reason) { dropped.push({ path, reason: r.reason }); return null; }
  return { kind: item.kind, target: r.target.label, targetChat: r.target.chatJid, targetKind: r.target.chatKind,
    basis: r.basis, ttlHours };
}

function nudgeOf(item, path, ctx, dropped) {
  if (!isObj(item)) { dropped.push({ path, reason: 'bad_shape' }); return null; }
  dropUnknown(item, ['knob', 'scope', 'value', 'ttl_hours', 'reason'], path, dropped);
  if (!KNOB.includes(item.knob)) { dropped.push({ path, reason: 'bad_enum' }); return null; }
  let scope = 'global';
  let scopeChat = null;
  if (item.scope != null && item.scope !== 'global') {
    const r = resolveRef(ctx.labelMap, item.scope);
    if (!r || r.type !== 'chat') { dropped.push({ path, reason: 'unknown_ref' }); return null; }
    if (r.chatKind !== 'group') { dropped.push({ path, reason: 'bad_scope' }); return null; }
    scope = r.label;
    scopeChat = r.chatJid;
  }
  let value;
  if (item.knob === 'replyLength') {
    if (!LENGTH.includes(item.value)) { dropped.push({ path, reason: 'bad_value' }); return null; }
    value = item.value;
  } else {
    if (!fin(item.value)) { dropped.push({ path, reason: 'bad_value' }); return null; }
    value = item.value;
  }
  const out = { knob: item.knob, scope, scopeChat, value, ttlHours: Math.round(clampNum(item.ttl_hours, 1, 72, 24)) };
  const reason = cleanStr(item.reason, 160);
  out.reason = reason;
  return out;
}

function reachOutOf(item, path, ctx, dropped) {
  if (!isObj(item)) { dropped.push({ path, reason: 'bad_shape' }); return null; }
  dropUnknown(item, ['target', 'kind', 'basis', 'urgency', 'reason'], path, dropped);
  if (!REACH_KIND.includes(item.kind)) { dropped.push({ path, reason: 'bad_enum' }); return null; }
  if (!fin(item.urgency) || item.urgency < 0 || item.urgency > 1) { dropped.push({ path, reason: 'out_of_range' }); return null; }
  const r = chatTargetAndBasis(item, ctx, item.kind);
  if (r.reason) { dropped.push({ path, reason: r.reason }); return null; }
  return { kind: item.kind, target: r.target.label, targetChat: r.target.chatJid, targetKind: r.target.chatKind,
    basis: r.basis, urgency: item.urgency, reason: cleanStr(item.reason, 160) };
}

function finish(value, dropped, total, accepted) {
  if (total > 0 && accepted === 0) return { ok: false, error: 'all_dropped', dropped };
  return { ok: true, value, dropped };
}

// ── think (§5) ───────────────────────────────────────────────────────────────

/**
 * ctx: { labelMap, lookForReachOut = false, trigger = null, basisAllowed?(basis, target) }
 * value: { mood|null, today:[{ref,label,chatJid,digestId}], intentions:[…], nudges:[…],
 *          reachOut:[…], nextThinkInMinutes|null, note|null }
 */
export function validateThink(raw, ctx = {}) {
  const dropped = [];
  const t = topLevel(raw, MAX_BYTES.think);
  if (t.error) return { ok: false, error: t.error, dropped };
  const o = t.o;
  dropUnknown(o, ['v', 'mood', 'today', 'intentions', 'nudges', 'reach_out', 'next_think_in_minutes', 'note'], '', dropped);
  let total = 0;
  let accepted = 0;
  const value = { mood: null, today: [], intentions: [], nudges: [], reachOut: [], nextThinkInMinutes: null, note: null };

  if (has(o, 'mood') && o.mood != null) {
    total++;
    value.mood = moodOf(o.mood, 'mood', dropped);
    if (value.mood) accepted++;
  }

  const today = listOf(o, 'today', 3, dropped);
  if (today === null) total++;
  for (const [i, item] of (today || []).entries()) {
    total++;
    const path = `today[${i}]`;
    if (!isObj(item)) { dropped.push({ path, reason: 'bad_shape' }); continue; }
    dropUnknown(item, ['ref'], path, dropped);
    const r = resolveRef(ctx.labelMap, item.ref);
    if (!r || r.type !== 'today') { dropped.push({ path, reason: 'unknown_ref' }); continue; }
    if (value.today.some(x => x.label === r.label)) { dropped.push({ path, reason: 'duplicate' }); continue; }
    value.today.push({ ref: `${r.label}.today`, label: r.label, chatJid: r.chatJid, digestId: r.entry.digestId });
    accepted++;
  }

  const intentions = listOf(o, 'intentions', 3, dropped);
  if (intentions === null) total++;
  for (const [i, item] of (intentions || []).entries()) {
    total++;
    const v = intentionOf(item, `intentions[${i}]`, ctx, dropped);
    if (v) { value.intentions.push(v); accepted++; }
  }

  const nudges = listOf(o, 'nudges', 3, dropped);
  if (nudges === null) total++;
  for (const [i, item] of (nudges || []).entries()) {
    total++;
    const v = nudgeOf(item, `nudges[${i}]`, ctx, dropped);
    if (v) { value.nudges.push(v); accepted++; }
  }

  const reach = listOf(o, 'reach_out', 2, dropped);
  if (reach === null) total++;
  const reachAllowed = ctx.lookForReachOut === true || ctx.trigger === 'owner';
  for (const [i, item] of (reach || []).entries()) {
    // Unrequested reach-outs are ignored like an unknown field: they never make the run invalid.
    if (!reachAllowed) { dropped.push({ path: `reach_out[${i}]`, reason: 'not_requested' }); continue; }
    total++;
    const v = reachOutOf(item, `reach_out[${i}]`, ctx, dropped);
    if (v) { value.reachOut.push(v); accepted++; }
  }

  if (has(o, 'next_think_in_minutes') && o.next_think_in_minutes != null) {
    if (fin(o.next_think_in_minutes)) value.nextThinkInMinutes = Math.round(clampNum(o.next_think_in_minutes, 60, 1440, 240));
    else dropped.push({ path: 'next_think_in_minutes', reason: 'bad_value' });
  }
  if (has(o, 'note') && o.note != null) {
    value.note = cleanStr(o.note, 280);
    if (value.note === null) dropped.push({ path: 'note', reason: 'bad_value' });
  }
  return finish(value, dropped, total, accepted);
}

// ── sleep (§6) ───────────────────────────────────────────────────────────────

/**
 * ctx: { labelMap, basisAllowed? }. No self_model, no reach_out (dropped as unknown keys).
 * value: { morningMood|null, intentions, nudges, nextThinkInMinutes|null, note|null }
 */
export function validateSleep(raw, ctx = {}) {
  const dropped = [];
  const t = topLevel(raw, MAX_BYTES.sleep);
  if (t.error) return { ok: false, error: t.error, dropped };
  const o = t.o;
  dropUnknown(o, ['v', 'morning_mood', 'intentions', 'nudges', 'next_think_in_minutes', 'note'], '', dropped);
  let total = 0;
  let accepted = 0;
  const value = { morningMood: null, intentions: [], nudges: [], nextThinkInMinutes: null, note: null };
  if (has(o, 'morning_mood') && o.morning_mood != null) {
    total++;
    value.morningMood = moodOf(o.morning_mood, 'morning_mood', dropped);
    if (value.morningMood) accepted++;
  }
  const intentions = listOf(o, 'intentions', 2, dropped);
  if (intentions === null) total++;
  for (const [i, item] of (intentions || []).entries()) {
    total++;
    const v = intentionOf(item, `intentions[${i}]`, ctx, dropped);
    if (v) { value.intentions.push(v); accepted++; }
  }
  const nudges = listOf(o, 'nudges', 2, dropped);
  if (nudges === null) total++;
  for (const [i, item] of (nudges || []).entries()) {
    total++;
    const v = nudgeOf(item, `nudges[${i}]`, ctx, dropped);
    if (v) { value.nudges.push(v); accepted++; }
  }
  if (has(o, 'next_think_in_minutes') && o.next_think_in_minutes != null) {
    if (fin(o.next_think_in_minutes)) value.nextThinkInMinutes = Math.round(clampNum(o.next_think_in_minutes, 60, 1440, 600));
    else dropped.push({ path: 'next_think_in_minutes', reason: 'bad_value' });
  }
  if (has(o, 'note') && o.note != null) {
    value.note = cleanStr(o.note, 280);
    if (value.note === null) dropped.push({ path: 'note', reason: 'bad_value' });
  }
  return finish(value, dropped, total, accepted);
}

// ── clerk digest (§1) ────────────────────────────────────────────────────────

/**
 * ctx: { lineIds: Iterable<'L…'> (every L line of the input), humanLineIds: Iterable<'L…'>
 * (the non-bot L lines) }. Citations must be human L lines; C lines and bot lines never
 * count. A thread with no human citation is dropped; a digest with none at all is invalid.
 * value: { summary, todayNote|null, tone, threads:[{k, text, evidence:['L…']}], evidence:['L…'] }
 */
export function validateDigest(raw, ctx = {}) {
  const dropped = [];
  const t = topLevel(raw, MAX_BYTES.digest);
  if (t.error) return { ok: false, error: t.error, dropped };
  const o = t.o;
  dropUnknown(o, ['v', 'summary', 'today_note', 'tone', 'threads', 'evidence'], '', dropped);
  const lineIds = new Set(ctx.lineIds || []);
  const human = new Set(ctx.humanLineIds || []);
  const cite = (list, path) => {
    if (!Array.isArray(list)) { if (list != null) dropped.push({ path, reason: 'not_a_list' }); return []; }
    const out = [];
    for (const [i, id] of list.entries()) {
      if (typeof id !== 'string' || !lineIds.has(id)) { dropped.push({ path: `${path}[${i}]`, reason: 'unknown_line' }); continue; }
      if (!human.has(id)) { dropped.push({ path: `${path}[${i}]`, reason: 'not_human' }); continue; }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };

  const summary = cleanStr(o.summary, 400);
  if (summary === null) return { ok: false, error: 'bad_summary', dropped };
  let todayNote = null;
  if (has(o, 'today_note') && o.today_note != null) {
    todayNote = cleanStr(o.today_note, 80);
    if (todayNote === null) dropped.push({ path: 'today_note', reason: 'bad_value' });
  }
  let tone = o.tone;
  if (!TONE.includes(tone)) { dropped.push({ path: 'tone', reason: 'bad_enum' }); tone = 'neutral'; }

  const threads = [];
  const tl = listOf(o, 'threads', 3, dropped) || [];
  for (const [i, item] of tl.entries()) {
    const path = `threads[${i}]`;
    if (!isObj(item)) { dropped.push({ path, reason: 'bad_shape' }); continue; }
    dropUnknown(item, ['text', 'evidence'], path, dropped);
    const text = cleanStr(item.text, 100);
    if (text === null) { dropped.push({ path, reason: 'bad_value' }); continue; }
    const ev = cite(item.evidence, `${path}.evidence`);
    if (!ev.length) { dropped.push({ path, reason: 'no_evidence' }); continue; }
    threads.push({ k: threads.length + 1, text, evidence: ev });
  }
  let evidence = cite(o.evidence, 'evidence');
  if (!evidence.length) evidence = [...new Set(threads.flatMap(th => th.evidence))];
  if (!evidence.length) return { ok: false, error: 'no_evidence', dropped };
  return { ok: true, value: { summary, todayNote, tone, threads, evidence }, dropped };
}

// ── clerk episode (§2) and weekly (§3) ───────────────────────────────────────

/** value: { episode: string(20..600)|null, tone } — null = nothing worth remembering. */
export function validateEpisode(raw) {
  const dropped = [];
  const t = topLevel(raw, MAX_BYTES.episode);
  if (t.error) return { ok: false, error: t.error, dropped };
  const o = t.o;
  dropUnknown(o, ['v', 'episode', 'tone'], '', dropped);
  if (!has(o, 'episode')) return { ok: false, error: 'missing_episode', dropped };
  let tone = o.tone;
  if (!TONE.includes(tone)) { if (o.episode !== null) dropped.push({ path: 'tone', reason: 'bad_enum' }); tone = 'neutral'; }
  if (o.episode === null) return { ok: true, value: { episode: null, tone }, dropped };
  const episode = cleanStr(o.episode, 600, 20);
  if (episode === null) return { ok: false, error: 'bad_episode', dropped };
  return { ok: true, value: { episode, tone }, dropped };
}

/** value: { episode: string(20..700) } */
export function validateWeekly(raw) {
  const dropped = [];
  const t = topLevel(raw, MAX_BYTES.weekly);
  if (t.error) return { ok: false, error: t.error, dropped };
  const o = t.o;
  dropUnknown(o, ['v', 'episode'], '', dropped);
  const episode = cleanStr(o.episode, 700, 20);
  if (episode === null) return { ok: false, error: 'bad_episode', dropped };
  return { ok: true, value: { episode }, dropped };
}

// ── draft intent (§7) ────────────────────────────────────────────────────────

/** value: { skip: true } | { skip: false, intent: string(10..200) }. Code checks on the intent are the caller's. */
export function validateDraft(raw) {
  const dropped = [];
  const t = topLevel(raw, MAX_BYTES.draft);
  if (t.error) return { ok: false, error: t.error, dropped };
  const o = t.o;
  dropUnknown(o, ['v', 'skip', 'intent'], '', dropped);
  if (o.skip === true) return { ok: true, value: { skip: true }, dropped };
  if (has(o, 'skip') && o.skip !== false) return { ok: false, error: 'bad_skip', dropped };
  const intent = cleanStr(o.intent, 200, 10);
  if (intent === null) return { ok: false, error: 'bad_intent', dropped };
  return { ok: true, value: { skip: false, intent }, dropped };
}

// ── self-model proposal (§9) ─────────────────────────────────────────────────

/**
 * value: { skip:true } | { skip:false, baseVersion, text, changesSummary|null, oversize }.
 * The text is sanitized and fence-stripped line by line but NEVER trimmed to fit:
 * scrubProposal rejects an oversize proposal (research R12 step 1).
 */
export function validateSelfModel(raw) {
  const dropped = [];
  const t = topLevel(raw, MAX_BYTES.selfmodel);
  if (t.error) return { ok: false, error: t.error, dropped };
  const o = t.o;
  dropUnknown(o, ['v', 'skip', 'base_version', 'text', 'changes_summary'], '', dropped);
  if (o.skip === true) return { ok: true, value: { skip: true }, dropped };
  if (has(o, 'skip') && o.skip !== false) return { ok: false, error: 'bad_skip', dropped };
  if (!Number.isInteger(o.base_version) || o.base_version < 0) return { ok: false, error: 'bad_base_version', dropped };
  if (typeof o.text !== 'string') return { ok: false, error: 'bad_text', dropped };
  const text = o.text.split('\n')
    .map(line => stripFenceTokens(sanitizeWebContent(line)).replace(/[ \t]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let changesSummary = null;
  if (has(o, 'changes_summary') && o.changes_summary != null) {
    changesSummary = cleanStr(o.changes_summary, 200);
    if (changesSummary === null) dropped.push({ path: 'changes_summary', reason: 'bad_value' });
  }
  return { ok: true, value: { skip: false, baseVersion: o.base_version, text, changesSummary, oversize: text.length > 1500 },
    dropped };
}

// ── Jev answers (tolerant parsers, research R3) ──────────────────────────────

const NOUL_BASE = { yes: 0.9, likely: 0.65, unlikely: 0.35, no: 0.1 };

/**
 * p(yes) from a Jev noul answer. The probability field name is unverified live, so
 * accept `probabilities`/`probs` ({yes[, likely]}), then `probability`, then the
 * chosen option. → number in 0..1, or null when the answer carries nothing usable.
 */
export function noulProbability(a) {
  if (!isObj(a)) return null;
  const probs = isObj(a.probabilities) ? a.probabilities : isObj(a.probs) ? a.probs : null;
  let p = null;
  // Jev's live shape is { type: 'noul', noul: p } (verified 2026-10-29); the rest are older/alternate shapes.
  if (fin(a.noul)) p = a.noul;
  else if (probs && fin(probs.yes)) p = probs.yes + (fin(probs.likely) ? probs.likely : 0);
  else if (fin(a.probability)) p = a.probability;
  else if (typeof a.choice === 'string' && has(NOUL_BASE, a.choice)) p = NOUL_BASE[a.choice];
  if (p === null || !Number.isFinite(p)) return null;
  return Math.max(0, Math.min(1, p));
}

/** A Jev choice answer restricted to `allowed`: { choice, confidence } or null. */
export function choiceAnswer(a, allowed) {
  if (!isObj(a) || typeof a.choice !== 'string' || !allowed.includes(a.choice)) return null;
  let c = fin(a.confidence) ? a.confidence : null;
  const probs = isObj(a.probabilities) ? a.probabilities : isObj(a.probs) ? a.probs : null;
  if (c === null && probs && fin(probs[a.choice])) c = probs[a.choice];
  if (c === null) return null;
  return { choice: a.choice, confidence: Math.max(0, Math.min(1, c)) };
}
