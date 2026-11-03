// How things stand (plan 020 D2): what happened with one person, as dated lines for the clerk. Pure:
// the worker does the reads and passes them in. Only his own and the owner's events about a fictional
// person: plans, scenes (their words), texts, beats, relationship changes that mean something. Nothing
// from a chat, a real person or a heavy stretch. Places by kind word. Explicit words never reach the clerk.
import { chatMade, commitBy, optionOf } from '../../decisionLog.js';
import { dayLabel } from '../../clock.js';
import { heatProblem } from '../desire.js';
import { scrubVenueNames } from '../../places.js';

export const SOURCES = Object.freeze(['scene', 'text', 'plan', 'beat', 'relationship', 'arc']);
export const READ_TYPES = Object.freeze(['decision.opened', 'decision.committed', 'decision.reversed', 'decision.expired', 'outcome.happened',
  'scene.played', 'phone.message', 'cast.beat', 'relationship.changed', 'arc.started', 'arc.stage', 'arc.ended']);
const PLAN_TYPES = new Set(['decision.committed', 'decision.reversed', 'decision.expired', 'outcome.happened']);
const SELF_ORIGINS = new Set(['self', 'owner']);
// Caps per source, newest kept: the call stays small however long the relationship runs.
export const CAPS = Object.freeze({ scene: 6, text: 12, plan: 10, beat: 6, relationship: 6, arc: 6 });
const WORDS_MAX = Object.freeze({ scene: 300, text: 110, plan: 120, beat: 120 });
// Drift is the daily pass's small print: a move only counts as news past this, or by a reason that is news.
export const MOVE_MIN = 0.03;
const NEWS_REASONS = new Set(['owner', 'outcome', 'scene', 'decision', 'arc']);
const METRIC_WORDS = Object.freeze({ closeness: 'closer', trust: 'more trust', tension: 'more tension', intimacy: 'more intimate', passion: 'more spark', commitment: 'more committed' });
const AWAY_WORDS = Object.freeze({ closeness: 'less close', trust: 'less trust', tension: 'less tension', intimacy: 'less intimate', passion: 'less spark', commitment: 'less committed' });
const OUTCOME_WORDS = Object.freeze({ well: 'it went well', badly: 'it went badly', fine: 'it went fine', flat: 'it was a bit flat' });
const ENDING_WORDS = Object.freeze({ swapped_numbers: 'they swapped numbers', plan_to_meet: 'they said they would meet again', stayed_late: 'they stayed late', left_early: 'he left early', parted_badly: 'they parted on a bad note' });
const ARC_OUTCOMES = Object.freeze({ broken_up: 'they broke up', fizzled: 'it fizzled out', done: 'that was the end of it', cancelled: 'that was called off' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (t, max) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The cast ids an event is about, where its own payload says. */
export function castIdsOf(ev) {
  const p = ev?.payload ?? {};
  if (typeof p.castId === 'string') return [p.castId];
  return Array.isArray(p.castIds) ? p.castIds.filter(c => typeof c === 'string') : [];
}

/** Is this event from his own life, about no real person, nothing heavy, outside every heavy window? */
export function eligible(ev, { isOut, heavyChain, heavyWindows }) {
  if (!isObj(ev) || ev.redacted === true || ev.heavy === true || ev.subjectJid) return false;
  if (!SELF_ORIGINS.has(ev.originKind ?? 'self') || isOut(ev.id)) return false;
  if (heavyWindows.some(w => ev.at >= w.from && ev.at <= w.to)) return false;
  return !heavyChain(ev);
}

function planLine(ev, fold, day, venueNames) {
  const opened = fold.opened;
  const label = (id) => scrubVenueNames(clean(optionOf(fold, id)?.label ?? opened.payload?.kind, WORDS_MAX.plan), venueNames).replace(/[_:]+/g, ' ');
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'decision.committed':
      if (p.optionId === 'go') return `${day}: plan: ${label('go')}: he said yes${commitBy(ev) === 'text' ? ' (agreed in texts)' : ''}`;
      if (p.optionId === 'late') return `${day}: plan: ${label('late')}: he'd come late`;
      return null;   // a plain no to a passing idea isn't news: every evening has one
    case 'decision.reversed':
      return p.to === 'go' || p.to === 'late' ? `${day}: plan: ${label(p.to)}: he changed his mind and said yes` : `${day}: plan: ${label('go')}: he backed out`;
    case 'decision.expired':
      return `${day}: plan: ${label('go')}: it fell through`;
    case 'outcome.happened': {
      const v = OUTCOME_WORDS[p.outcome] ?? (p.badly === true ? OUTCOME_WORDS.badly : OUTCOME_WORDS.well);
      return `${day}: plan: ${label('go')}: ${v}`;
    }
    default: return null;
  }
}

function sceneLine(row, ev, day, venueNames) {
  const p = ev.payload ?? {};
  const out = [OUTCOME_WORDS[p.outcome], ENDING_WORDS[p.ending]].filter(Boolean).join('; ');
  const words = clean(row?.editedText || row?.text, 4000);
  // Explicit words stop here: the frame only.
  const highlight = clean(row?.detail?.highlight, 120);
  const told = p.heat !== 'explicit' && row?.sheet?.register !== 'explicit' && !heatProblem(words) && !heatProblem(highlight)
    ? scrubVenueNames([highlight, words.slice(0, WORDS_MAX.scene)].filter(Boolean).join(' · '), venueNames) : '';
  return `${day}: out together: ${out || 'nothing special'}${told ? `. ${told}` : ''}`;
}

/**
 * Must this text stay off the clerk's input? The word list knows one language, so it can't be the rule: the explicit register, an
 * explicit heat, a naughty tone, the word check, or an old row (no register recorded) whose heat says it wasn't tame.
 * A flirty text on the tame register stays readable.
 */
export function isPrivateTurn(payload, words) {
  const p = payload ?? {};
  if (p.register === 'explicit' || p.heat === 'explicit' || p.tone === 'naughty' || heatProblem(words)) return true;
  return p.register === undefined && p.heat === 'suggestive';
}

function textLine(row, ev, day, name) {
  const words = clean(row?.editedText || row?.text, 600);
  const who = ev.payload?.dir === 'out' ? 'he texted' : `${name} texted`;
  if (!words) return null;
  return isPrivateTurn(ev.payload, words) ? `${day}: ${who} (private)` : `${day}: ${who}: ${words.slice(0, WORDS_MAX.text)}`;
}

/** The words of this member's private turns and scenes in the read, for the note's echo check. Never sent anywhere. */
export function privateWordsOf(events, { castId, sceneRow, textRow }) {
  const out = [];
  for (const ev of events) {
    if (ev.type === 'phone.message' && ev.payload?.castId === castId) {
      const row = textRow(ev.id);
      const words = clean(row?.editedText || row?.text, 600);
      if (words && isPrivateTurn(ev.payload, words)) out.push(words);
    } else if (ev.type === 'scene.played' && castIdsOf(ev).includes(castId)) {
      const row = sceneRow(ev.id);
      const words = clean(row?.editedText || row?.text, 4000);
      if (words && (ev.payload?.heat === 'explicit' || row?.sheet?.register === 'explicit' || heatProblem(words))) out.push(words);
    }
  }
  return out;
}

function moveLine(ev, day) {
  const delta = isObj(ev.payload?.delta) ? ev.payload.delta : {};
  if (!NEWS_REASONS.has(ev.payload?.reason)) return null;
  const parts = Object.entries(delta)
    .filter(([k, v]) => METRIC_WORDS[k] && finite(v) && Math.abs(v) >= MOVE_MIN)
    .map(([k, v]) => (v > 0 ? METRIC_WORDS[k] : AWAY_WORDS[k]));
  return parts.length ? `${day}: between them: ${parts.join(', ')}` : null;
}

function arcLine(ev, day, arcOf, castId) {
  const p = ev.payload ?? {};
  const arc = ev.type === 'arc.started' ? p : arcOf(p.arcId);
  if (arc?.category !== 'romance' || !Array.isArray(arc.castIds) || !arc.castIds.includes(castId)) return null;
  if (ev.type === 'arc.started') return `${day}: romance: he got interested`;
  if (ev.type === 'arc.stage') return `${day}: romance: now ${clean(p.to, 24).replace(/_/g, ' ')}`;
  return `${day}: romance: ${ARC_OUTCOMES[p.outcome] ?? 'it ended'}`;
}

/**
 * One member's lines, oldest first. ctx: { castId, name, tz, isOut, heavyChain, heavyWindows, afterId (the base's as-of),
 * folds (decisionLog folds by id), sceneRow(eventId), textRow(eventId), arcOf(arcId), venueNames, lastMetAt (when they last met in person, or null) }.
 * `events` may hold the whole read: this member's and everyone else's.
 * → { lines: [{eventId, at, source, text}], counts: {source: n}, earlier: dropped }.
 */
export function linesFor(events, ctx) {
  const { castId, tz, afterId = 0, venueNames = [], lastMetAt = null } = ctx;
  const all = [];
  const add = (ev, source, text) => { if (text) all.push({ eventId: ev.id, at: ev.at, source, text }); };
  for (const ev of events) {
    if (ev.id <= afterId) continue;
    const day = dayLabel(ev.at, tz);
    if (PLAN_TYPES.has(ev.type)) {
      const fold = ctx.folds.get(ev.payload?.decisionId);
      if (!fold?.opened || !(fold.opened.payload?.subject?.castIds ?? []).includes(castId) || !eligible(ev, ctx)) continue;
      // Made in a chat, or for a real person: not his own to tell here.
      if (chatMade(fold) || fold.opened.redacted === true || fold.opened.subjectJid || !SELF_ORIGINS.has(fold.opened.originKind ?? 'self')) continue;
      add(ev, 'plan', planLine(ev, fold, day, venueNames));
    } else if (ev.type === 'scene.played') {
      if (!castIdsOf(ev).includes(castId) || ev.payload?.mode !== 'full' || ev.payload?.heavyWindow === true || !eligible(ev, ctx)) continue;
      const row = ctx.sceneRow(ev.id);
      if (row && row.heavyWindow !== true) add(ev, 'scene', sceneLine(row, ev, day, venueNames));
    } else if (ev.type === 'phone.message') {
      if (ev.payload?.castId !== castId || ev.payload?.heavyWindow === true || !eligible(ev, ctx)) continue;
      const row = ctx.textRow(ev.id);
      if (row?.status === 'live' && row.heavyWindow !== true) {
        const text = textLine(row, ev, day, ctx.name);
        add(ev, 'text', text ? scrubVenueNames(text, venueNames) : null);
      }
    } else if (ev.type === 'cast.beat') {
      if (ev.payload?.castId !== castId || !eligible(ev, ctx)) continue;
      const said = clean(ev.payload?.text ?? String(ev.payload?.kind ?? '').replace(/[_:]+/g, ' '), WORDS_MAX.beat);
      // "She's planning that evening", read after that evening: the clerk needs to know it's old news.
      const before = finite(lastMetAt) && ev.at < lastMetAt ? ' (before they last met)' : '';
      add(ev, 'beat', said ? `${day}: ${ctx.name}: ${scrubVenueNames(said, venueNames)}${before}` : null);
    } else if (ev.type === 'relationship.changed') {
      if (ev.payload?.castId !== castId) continue;
      const text = moveLine(ev, day);
      if (text && eligible(ev, ctx)) add(ev, 'relationship', text);
    } else if (ev.type === 'arc.started' || ev.type === 'arc.stage' || ev.type === 'arc.ended') {
      const text = arcLine(ev, day, ctx.arcOf, castId);
      if (text && eligible(ev, ctx)) add(ev, 'arc', text);
    }
  }
  all.sort((a, b) => a.eventId - b.eventId);
  const kept = [];
  const counts = Object.fromEntries(SOURCES.map(k => [k, 0]));
  for (let i = all.length - 1; i >= 0; i--) {
    const l = all[i];
    if (counts[l.source] >= CAPS[l.source]) continue;
    counts[l.source]++;
    kept.unshift(l);
  }
  return { lines: kept, counts, earlier: all.length - kept.length };
}

/** Has something happened that a note should know? One passing text can wait for the next. */
export function changedEnough({ counts }) {
  return counts.scene + counts.plan + counts.beat + counts.relationship + counts.arc > 0 || counts.text >= 2;
}

/** A word per metric: the same bands the writers' sheets use. */
export const band01 = (v) => (!finite(v) ? 'unknown' : v < 0.34 ? 'low' : v < 0.67 ? 'medium' : 'high');
