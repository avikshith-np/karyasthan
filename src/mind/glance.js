// The glance (spec 008, research R3; contracts/mind-output.md §4).
//
//   runGlance(trigger, opts)  every ~45 min while awake (cadence.due decides), ≤ glanceMaxPerDay.
//     1. the morning reset: the first glance after a night's sleep is done hands the
//        staged morning mood / intentions to the day (selfState.morningReset);
//     2. Jev (askJev, caller 'mind.glance') over a state that has NO chat text, NO names,
//        NO chat ids and NO mood word: the persona's name/vibe, local time, a coarse life
//        summary (when life is on) and per-chat COUNTERS labelled C1…Cn;
//     3. code decides: p(think_now) ≥ 0.65 → want a think; base_mood (confidence ≥ 0.5) →
//        the origin-free base_mood element; p(reach_out) × appetite ≥ 0.6 → the next think
//        may look for a reach-out;
//     4. on a Jev error / timeout / BudgetError / disabled jev role it degrades to code
//        only (an unanswered direct question older than 2 h or a life anchor → think;
//        base mood from a vitals table when life is on; no reach-out) and is still
//        recorded ok with degraded:1 (FR-035).
//   → { status, runId, wantThink, lookForReachOut, degraded }. Never throws.
//
// The life / time helpers live in think.js (one import direction: glance → think).

import * as store from './store.js';
import { now as clockNow, dayKey, nightKey, daysBeforeKey, localHour } from './clock.js';
import { MOOD, noulProbability, choiceAnswer } from './schema.js';
import { codeDigests } from './digest.js';
import { baseGate, recordSkip, lifeView, localTimeLine, vitalsMood } from './think.js';
import { askJev, noul, choice } from '../brain/jev.js';
import { resolveRole } from '../brain/roles.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const HOUR = 3600;
export const THINK_NOW_MIN = 0.65;
export const REACH_OUT_MIN = 0.6;
export const BASE_MOOD_MIN_CONFIDENCE = 0.5;
export const UNANSWERED_HOURS = 2;
const COUNTED_RUN = ['running', 'ok', 'partial', 'invalid', 'failed'];

// Criteria for the base_mood choice (persona-neutral; the state carries no chat text).
export const MOOD_CRITERIA = Object.freeze({
  upbeat: 'in good spirits, light and positive',
  content: 'settled and fine, nothing pulling at him',
  calm: 'quiet and unhurried',
  playful: 'in a joking, teasing mood',
  excited: 'buzzing about something, high energy',
  tired: 'low on energy, would rather rest',
  drained: 'socially worn out, little left to give',
  restless: 'fidgety, wants something to happen',
  irritable: 'short-tempered, easily annoyed',
  low: 'a bit down',
  anxious: 'worried or under pressure',
  bored: 'nothing interesting going on',
});

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isMindOn: () => isSkillEnabled('mind'),
  askJev: (req) => askJev(req),
  jevDisabled: () => { try { return !!resolveRole('jev', config)?.disabled; } catch { return true; } },
  life: async () => import('../life/index.js'),
  selfState: async () => import('./selfState.js'),
  appetite: async () => {
    try {
      const k = await import('./knobs.js');
      const f = k.knobs?.proactiveAppetite || k.proactiveAppetite;
      const v = typeof f === 'function' ? Number(f()) : 1;
      return Number.isFinite(v) ? v : 1;
    } catch { return 1; }
  },
  getPersona: () => getPersona(),
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: { now, isMindOn, askJev, jevDisabled, life, selfState, appetite, getPersona }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const nowSec = () => Math.floor(deps.now());
const round1 = (v) => (fin(v) ? Math.round(v * 10) / 10 : null);
const codeOf = (err) => String(err?.code || err?.name || 'error').slice(0, 60);

// ── morning reset ────────────────────────────────────────────────────────────

/** The most recent night that is done and finished before t (the current or the previous night key). */
function lastDoneNight(t) {
  const nk = nightKey(t);
  for (const k of [nk, daysBeforeKey(nk, 1)]) {
    const n = store.getNight(k);
    if (n && n.status === 'done' && fin(n.finishedAt) && n.finishedAt <= t) return n;
  }
  return null;
}

let lastMorningNight = null;   // in memory: morningReset is idempotent, so a restart may call it once more

/** True while a finished night's morning reset has not run yet in this process (makes a glance due). */
export function morningPending(t = nowSec()) {
  try {
    const night = lastDoneNight(Math.floor(t));
    return !!night && lastMorningNight !== night.nightKey;
  } catch {
    return false;
  }
}

async function maybeMorningReset(t) {
  const night = lastDoneNight(t);
  if (!night || lastMorningNight === night.nightKey) return null;
  const ss = await deps.selfState();
  if (!ss || typeof ss.morningReset !== 'function') return null;
  const r = ss.morningReset({ at: t, sleptAt: night.finishedAt });
  lastMorningNight = night.nightKey;
  return { nightKey: night.nightKey, mood: r?.mood != null, today: Number(r?.today) || 0, intentions: (r?.intentions || []).length };
}

// ── state ────────────────────────────────────────────────────────────────────

/** Glances counted for the local day of t (skipped rows excluded). */
export function glancesToday(t = nowSec()) {
  return store.countRuns({ kind: 'glance', dayKey: dayKey(t), status: COUNTED_RUN });
}

/**
 * The glance's Jev state: counters only. Exported for tests (no text, no names, no
 * ids, no mood word). → { state, digests }
 */
export function buildGlanceState(t, { life = null, appetite = 1, lastGlanceAt = null, lastThinkAt = null } = {}) {
  const digests = codeDigests(dayKey(t));
  const persona = deps.getPersona() || {};
  const chats = digests.map((d, i) => ({
    label: `C${i + 1}`,
    kind: d.kind === 'group' ? 'group' : 'dm',
    messages_today: d.msgs,
    human_messages_today: d.humanMsgs,
    people_today: d.senders,
    mentions_of_you_today: d.botMentions,
    open_questions_to_you: d.openQuestions,
    your_messages_today: d.botMsgs,
    hours_since_human: d.hoursSinceHuman,
    hours_since_you: d.hoursSinceBot,
    new_since_last_glance: fin(lastGlanceAt) ? (fin(d.lastHumanAt) && d.lastHumanAt > lastGlanceAt) : d.humanMsgs > 0,
  }));
  let intentions = 0;
  try { intentions = store.activeElements(t).filter(e => e.kind === 'intention' && !(e.basis || []).some(b => b?.stage)).length; }
  catch { intentions = 0; }
  const lv = lifeView(life, t);
  const state = {
    you_are: { name: String(persona.name || '').slice(0, 60), vibe: String(persona.vibe || '').slice(0, 160) },
    local_time: localTimeLine(t).replace(/^Local time: |\.$/g, ''),
    local_hour: localHour(t),
    ...(lv ? { life: { availability: lv.availability, energy: lv.energy, stress: lv.stress, social_battery: lv.socialBattery,
      unwell: lv.sick } } : {}),
    chats,
    intentions_active: intentions,
    hours_since_last_think: fin(lastThinkAt) ? round1((t - lastThinkAt) / HOUR) : null,
    appetite: Math.round((fin(appetite) ? appetite : 1) * 100) / 100,
  };
  return { state, digests, lifeView: lv };
}

function questions() {
  return {
    think_now: noul('Is something going on that deserves a few minutes of real reflection now?'),
    base_mood: choice('Which word best fits how he feels right now, from his life and how busy his chats are?',
      Object.fromEntries(MOOD.map(w => [w, MOOD_CRITERIA[w]]))),
    reach_out: noul('Would a real friend in his position feel like texting someone first right now?'),
  };
}

/** The code-only think rule: an unanswered direct question older than 2 h, or an anchor. */
function codeThinkNow(digests, anchors) {
  if (Array.isArray(anchors) && anchors.length) return true;
  return digests.some(d => (Number(d.openQuestions) || 0) > 0 && fin(d.hoursSinceHuman) && d.hoursSinceHuman >= UNANSWERED_HOURS
    && (!fin(d.lastBotAt) || d.lastBotAt < d.lastHumanAt));
}

// ── the glance ───────────────────────────────────────────────────────────────

/**
 * One glance. trigger: 'tick' (cadence) | 'owner'. opts: { anchors }.
 * → { status: 'ok'|'skipped'|'failed', runId, wantThink, lookForReachOut, degraded, reason? }
 */
export async function runGlance(trigger = 'tick', opts = {}) {
  const t = nowSec();
  const trig = trigger === 'owner' ? 'owner' : 'tick';
  const none = { wantThink: false, lookForReachOut: false, degraded: false };
  const g = baseGate();
  if (g) return { ...recordSkip('glance', g, { trigger: trig, t }), ...none };
  const max = Math.max(0, Number(config.mind?.glanceMaxPerDay ?? 20));
  if (glancesToday(t) >= max) return { ...recordSkip('glance', 'cap', { trigger: trig, t }), ...none };

  let runId = null;
  try {
    const st = store.getState();
    runId = store.insertRun({ kind: 'glance', trigger: trig, startedAt: t });
    store.patchState({ lastGlanceAt: t });
    let morning = null;
    try { morning = await maybeMorningReset(t); } catch (err) { logger.warn({ evt: 'issue', where: 'mind.glance.morning', code: codeOf(err) }, 'mind: morning reset failed'); }

    let life = null;
    try { life = await deps.life(); } catch { life = null; }
    const appetite = await deps.appetite();
    const { state, digests, lifeView: lv } = buildGlanceState(t, { life, appetite, lastGlanceAt: st.lastGlanceAt, lastThinkAt: st.lastThinkAt });

    let degraded = false;
    let pThink = null;
    let pReach = null;
    let mood = null;
    let jevModel = null;
    let cost = null;
    let cause = null;
    if (deps.jevDisabled()) {
      degraded = true;
      cause = 'jev_disabled';
    } else {
      try {
        const res = await deps.askJev({ state, questions: questions(), caller: 'mind.glance' });
        jevModel = typeof res?.model === 'string' ? res.model.slice(0, 120) : null;
        cost = fin(Number(res?.usage?.cost)) ? Number(res.usage.cost) : null;
        const a = res?.answers || {};
        pThink = noulProbability(a.think_now);
        pReach = noulProbability(a.reach_out);
        mood = choiceAnswer(a.base_mood, MOOD);
        if (pThink === null) { degraded = true; cause = 'unreadable'; }
      } catch (err) {
        degraded = true;
        cause = err?.name === 'BudgetError' ? 'budget' : 'jev_error';
      }
    }

    let wantThink;
    let lookForReachOut;
    let baseMood = null;
    if (degraded) {
      wantThink = codeThinkNow(digests, opts.anchors);
      lookForReachOut = false;
      baseMood = vitalsMood(lv);
    } else {
      wantThink = pThink >= THINK_NOW_MIN;
      lookForReachOut = fin(pReach) && pReach * (fin(appetite) ? appetite : 1) >= REACH_OUT_MIN;
      if (mood && mood.confidence >= BASE_MOOD_MIN_CONFIDENCE) baseMood = mood.choice;
    }
    let baseMoodId = null;
    if (baseMood) {
      try {
        const ss = await deps.selfState();
        baseMoodId = ss?.applyBaseMood ? ss.applyBaseMood({ word: baseMood, intensity: degraded ? 0.4 : Math.max(0.3, mood?.confidence ?? 0.5) },
          { runId, at: t }) : null;
      } catch (err) { logger.warn({ evt: 'issue', where: 'mind.glance.mood', code: codeOf(err) }, 'mind: base mood not applied'); }
    }

    store.finishRun(runId, {
      status: 'ok', degraded, model: jevModel, costUsd: cost,
      input: { chats: state.chats.length, life: !!state.life, appetite: state.appetite, intentions: state.intentions_active },
      output: { thinkNow: pThink, reachOut: pReach, baseMood: baseMood || null, baseMoodId, wantThink, lookForReachOut,
        degradedCause: cause, morning },
    });
    return { status: 'ok', runId, wantThink, lookForReachOut, degraded };
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'mind.glance', code: codeOf(err) }, 'mind: glance failed');
    try { if (runId != null) store.finishRun(runId, { status: 'failed', error: codeOf(err) }); } catch { /* */ }
    return { status: 'failed', runId, ...none };
  }
}

/** Test helper: forget which night's morning reset already ran. */
export function __resetMorningForTest() {
  lastMorningNight = null;
}
