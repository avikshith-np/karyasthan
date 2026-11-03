// Dreams (plan 020 G): the wake, the words and what's read. Only story/index.js imports this. Everything but a vivid dream's
// words is code: ingredients, plan, timing and recall at the wake, a fragment from the phrase table, a template for the vivid
// one until its one small model call answers (or doesn't). No text in a heavy window; nothing from chats or real people.
// Live only: a sim has no dreams, since the pulse only gets atDream from the live attach. Logs carry codes only.
import * as store from './store.js';
import {
  DREAM_CHARTER, bondsMoved, fragmentOf, planDream, planLines, recallAt, remPeriods, residueOf, toneOf, vividTemplate, wordsProblem,
} from './plan.js';
import { fence, FENCE_NOTE } from '../charter.js';
import { dateKey, dayStart, localParts } from '../../clock.js';
import { causeChain, getEvent, listEvents } from '../../eventLog.js';
import { isExcludedId } from '../../projector.js';
import { kindWord, isHomeKind } from '../../places.js';
import { config } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';

const HOUR = 3600;
const DAY = 86400;
export const CALLER = 'life.dream';
export const MIN_SLEEP_SEC = 90 * 60;
const STALE_WAKE_SEC = 2 * HOUR;          // downtime replayed over the night: no back-dated dream
const ONE_A_NIGHT_SEC = 12 * HOUR;
const RECENT_SEC = 36 * HOUR;
const LAG_FROM_SEC = 7 * DAY;
const LAG_TO_SEC = 5 * DAY;
const TAIL_UNTIL_HOUR = 14;
const MOOD = Object.freeze({ good: { dv: 0.03, ds: 0 }, flat: { dv: 0, ds: 0 }, bad: { dv: -0.02, ds: 1 }, nightmare: { dv: -0.05, ds: 3 } });
const RESIDUE_TYPES = Object.freeze(['scene.played', 'work.crunch', 'work.late', 'career.appraisal', 'career.job_changed', 'commute.soaked',
  'money.spent', 'family.occasion', 'family.call', 'cast.beat', 'birthday', 'phone.message', 'activity.started', 'relationship.changed']);
const OWN_ORIGINS = new Set(['self', 'owner', null, undefined]);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
let deps = {};

/** { now, getState, tz, rngFor, callRole, spend(at, tz), knownNames, heavyAt(s, t) } */
export function configure(d = {}) {
  deps = { ...deps, ...d };
}

const nowSec = () => Math.floor(deps.now());

/** A place in kind words, never a venue's name. */
function placeWord(s, id) {
  if (!id) return null;
  const p = s.places instanceof Map ? s.places.get(id) : null;
  if (!p) return null;
  if (id === s.self?.homePlaceId) return 'his place';
  if (p.kind === 'office' || id === s.self?.officePlaceId) return 'the office';
  if (isHomeKind(s, id)) return 'a house he knew';
  const w = kindWord(p.kind);
  return w === 'out' ? 'somewhere he knew' : w;
}

function nameOf(s, id) {
  const c = s.cast instanceof Map ? s.cast.get(id) : null;
  if (!c?.name || Object.hasOwn(s.story?.departed ?? {}, id)) return null;   // someone who left stays out of it
  return String(c.name).split(/\s+/)[0];
}

// Only what's his: live, his or the owner's, no real person, no chat, nothing heavy.
function lived(s, from, to) {
  // Near a heavy stretch nothing counts, even a scene that says nothing of it: a scene from around one reaches only a DM or a call. Checked by the hour, since this runs once a morning.
  const nearHeavy = new Map();
  const near = (at) => {
    const k = Math.floor(at / HOUR);
    if (!nearHeavy.has(k)) nearHeavy.set(k, deps.heavyAt(s, at));
    return nearHeavy.get(k);
  };
  const heavyCause = (e) => {
    try { return causeChain(e.id).some(x => x?.heavy === true || x?.type === 'heavy.started'); } catch { return true; }
  };
  return listEvents({ types: RESIDUE_TYPES, from, to, limit: 1000 }).filter(e => !e.redacted && e.heavy !== true && !isExcludedId(s, e.id)
    && OWN_ORIGINS.has(e.originKind ?? null) && !e.subjectJid && e.payload?.heavyWindow !== true && !near(e.at) && !heavyCause(e));
}

function concernOf(residue, vitals) {
  const hit = residue.find(r => r.concern);
  if (hit) return hit.concern;
  return finite(vitals?.workPressure) && vitals.workPressure >= 60 ? 'work' : null;
}

/**
 * At his wake: the pulse hands in the state before it, and what it knows of the sleep. Appends `dream.had` only when he
 * remembers something. Never throws past the pulse's own guard, and a failure means no dream, nothing else.
 */
export function atDream(s, { at, add, sleepEventId, startedAt, interrupted = false, wokeId = null }) {
  if (config.arcs?.dreamsEnabled === false) return null;
  if (!Number.isSafeInteger(sleepEventId) || !finite(startedAt) || !finite(at)) return null;   // no sleep, or the first boot
  if (at - startedAt < MIN_SLEEP_SEC) return null;                                              // a nap, a doze
  if (nowSec() - at > STALE_WAKE_SEC) return null;                                              // replayed downtime
  const tz = deps.tz(s);
  const startHour = localParts(startedAt, tz).hour;
  if (startHour >= 8 && startHour < 18) return null;                                            // daytime sleep isn't his night
  const last = s.story?.dream;
  if (finite(last?.at) && at - last.at < ONE_A_NIGHT_SEC) return null;
  const sleepEv = getEvent(sleepEventId);
  if (!sleepEv || sleepEv.redacted || !OWN_ORIGINS.has(sleepEv.originKind ?? null)) return null;
  if (deps.heavyAt(s, startedAt) || deps.heavyAt(s, at)) return null;                           // nothing in a heavy window

  const date = dateKey(at, tz);
  const rng = deps.rngFor(date, `dream:${sleepEventId}`);
  const vitals = s.vitals ?? {};
  const day = lived(s, startedAt - RECENT_SEC, startedAt);
  const recent = residueOf(day);
  const placesToday = [...new Set(day.filter(e => e.type === 'activity.started' && placeWord(s, e.payload?.placeId)).map(e => e.payload.placeId))].filter(id => id !== s.self?.homePlaceId);
  const tone = toneOf(vitals, recent, rng);
  const periods = remPeriods(startedAt, at + 2 * HOUR, rng, { debtHours: finite(vitals.sleepDebt) ? vitals.sleepDebt : 0 });
  const recall = recallAt(at, periods, tone, rng);
  if (!recall) return null;

  const before = store.recentDreams(at - 21 * DAY);
  const avoid = { places: before.slice(0, 7).flatMap(d => d.plan?.placeIds ?? []), people: before.slice(0, 7).flatMap(d => d.plan?.castIds ?? []) };
  const plan = planDream({
    tone, recent, lag: residueOf(lived(s, startedAt - LAG_FROM_SEC, startedAt - LAG_TO_SEC)).filter(r => r.placeId || r.castId),
    remote: {
      placeIds: (s.places instanceof Map ? [...s.places.keys()] : []).filter(id => placeWord(s, id) && id !== s.self?.homePlaceId),
      castIds: (s.cast instanceof Map ? [...s.cast.keys()] : []).filter(id => nameOf(s, id)),
    },
    bonds: bondsMoved(day).filter(id => nameOf(s, id)), placesToday,
    concern: concernOf(recent, vitals), wordOfPlace: (id) => placeWord(s, id), nameOf: (id) => nameOf(s, id), avoid, home: s.self?.homePlaceId ?? null,
  }, rng);
  if (!plan) return null;

  const { key, text } = recall === 'fragment'
    ? fragmentOf(plan, tone, rng, before.map(d => d.phraseKey).filter(Boolean).slice(0, 12))
    : { key: null, text: vividTemplate(plan) };
  const noon = dayStart(at, tz) + 12 * HOUR;
  const until = Math.max(noon, at + 2 * HOUR);
  const mood = MOOD[tone] ?? MOOD.flat;
  const ev = add({
    // A wake the owner set: if it's undone, so is what he woke with.
    type: 'dream.had', at, actor: 'engine', causeId: Number.isSafeInteger(wokeId) ? wokeId : sleepEventId,
    payload: {
      recall, tone, castIds: plan.castIds, placeIds: plan.placeIds, interrupted: interrupted === true, until,
      ...(mood.dv ? { dv: mood.dv } : {}), ...(mood.ds ? { ds: mood.ds } : {}),
    },
  });
  if (!ev?.id) return null;
  store.insertDream({ eventId: ev.id, sleepEventId, night: dateKey(startedAt - 6 * HOUR, tz), at, recall, tone, plan, text, phraseKey: key, needsWords: recall === 'vivid' }, nowSec());
  logger.info({ evt: 'dream', recall, tone, interrupted: interrupted === true }, 'dream: remembered');
  return ev;
}

/** A vivid dream's words: at most one call a night, its own month's cap, the template stays on any failure. */
export async function processWords() {
  const [row] = store.pendingWords(1);
  if (!row) return { status: 'none' };
  const s = deps.getState();
  const at = nowSec();
  const tz = deps.tz(s);
  const stop = (reason) => { store.giveUpWords(row.id); logger.info({ evt: 'dream', skip: reason }, 'dream: template kept'); return { status: 'template', reason }; };
  if (config.arcs?.dreamsEnabled === false) return stop('off');
  if (at - row.at > DAY) return stop('too_old');
  if (deps.heavyAt(s, row.at)) { store.setWords(row.id, null, 'code'); return { status: 'heavy' }; }   // no text in a heavy window
  if (store.countCallsSince(dayStart(row.at, tz)) >= 1) return stop('one_a_night');
  let spent = null;
  try { spent = await deps.spend(at, tz); } catch { spent = null; }
  if (!finite(spent)) return stop('ledger');
  if (!(spent < Number(config.arcs?.dreamBudgetUsd ?? 0.3))) return stop('budget');
  let knownNames;
  try { knownNames = deps.knownNames(); if (!Array.isArray(knownNames)) return stop('names_unavailable'); } catch { return stop('names_unavailable'); }
  const names = row.plan.scenes.map(x => x.person).filter(Boolean);
  const user = `${FENCE_NOTE}\n\n${fence(planLines(row.plan, row.tone), { kind: 'dream', cap: 200 })}\n\nWrite the dream now as the JSON object.`;
  let res;
  try { res = await deps.callRole('clerk', DREAM_CHARTER, user, { caller: CALLER, maxTokens: 260, temperature: 0.9, timeoutMs: 30_000 }); } catch { res = null; }
  if (!res || res.status !== 'ok' || typeof res.text !== 'string') return stop(res?.skipped ? 'budget' : 'model_failed');
  let text = null;
  try { const a = res.text.indexOf('{'); text = JSON.parse(res.text.slice(a, res.text.lastIndexOf('}') + 1)).text; } catch { return stop('invalid'); }
  const problem = wordsProblem(text, { names, knownNames });
  if (problem) return stop(problem);
  store.setWords(row.id, text.trim(), 'clerk');
  logger.info({ evt: 'dream', tier: 'clerk' }, 'dream: words');
  return { status: 'written' };
}

export function sweep(isGone) {
  return store.sweep(isGone);
}

// ── what's read ─────────────────────────────────────────────────────────────

/** The newest dream of this morning, while it's still on his mind (until about 14:00), and not in a heavy window. */
function morningDream(s, at) {
  const d = s.story?.dream;
  if (!finite(d?.at) || !Number.isSafeInteger(d.eventId) || d.at > at) return null;
  const tz = deps.tz(s);
  if (dateKey(d.at, tz) !== dateKey(at, tz) || localParts(at, tz).hour >= TAIL_UNTIL_HOUR) return null;
  if (isExcludedId(s, d.eventId) || deps.heavyAt(s, d.at)) return null;
  return d;
}

const LINE_TURNS_PER_CHAT = 2;
const DREAM_WORD = /\b(dream|dreamt|dreamed|dreaming)\b/i;
let lineDay = { date: null, told: false, turns: new Map() };   // this morning's: lost on a restart, like cooldowns
export function __resetDreamLineForTest() { lineDay = { date: null, told: false, turns: new Map() }; }

/**
 * One line for this morning's replies: in a DM only, the first turn or two of it, until he has mentioned a dream once that day. Never in a group, where the
 * person in it would be a stranger, and he doesn't tell it twice. recentText: [{ text, fromMe }].
 */
export function dreamLine(s, at, { audience = null, recentText = [] } = {}) {
  if (audience?.kind !== 'dm') return '';
  const d = morningDream(s, at);
  if (!d) return '';
  const day = dateKey(at, deps.tz(s));
  if (lineDay.date !== day) lineDay = { date: day, told: false, turns: new Map() };
  if (recentText.some(m => m?.fromMe && typeof m.text === 'string' && DREAM_WORD.test(m.text))) lineDay.told = true;
  if (lineDay.told) return '';
  const chat = audience.personJid ?? audience.chatJid ?? 'none';
  const seen = lineDay.turns.get(chat) ?? 0;
  if (seen >= LINE_TURNS_PER_CHAT) return '';
  const row = store.byEvent(d.eventId);
  if (!row?.text || row.status !== 'live') return '';
  lineDay.turns.set(chat, seen + 1);
  const text = row.text.length > 220 ? `${row.text.slice(0, 217)}...` : row.text;
  return `Last night you dreamt ("he" is you): ${text} (bring it up only if it comes up naturally)`;
}

/** For the public site: the words of live dreams, outside a heavy window. Map(event id → { text, night }). */
export function publicDreams(s, eventIds) {
  const out = new Map();
  for (const id of eventIds) {
    const row = store.byEvent(id);
    if (!row?.text || row.status !== 'live' || row.needsWords || deps.heavyAt(s, row.at)) continue;
    out.set(id, { text: row.text, night: row.night });
  }
  return out;
}

/** The dashboard's list, with the words and the plan's scenes. */
export function dreamsView({ limit = 30 } = {}) {
  return store.listDreams({ limit }).map(d => ({
    id: d.id, night: d.night, at: d.at, tone: d.tone, recall: d.recall, vivid: d.recall === 'vivid', text: d.text, tier: d.tier,
    scenes: (d.plan?.scenes ?? []).map(x => ({ place: x.place, person: x.person, twist: x.twist, source: x.source })),
    task: d.plan?.task ?? null,
  }));
}
