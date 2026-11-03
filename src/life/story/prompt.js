// The Director prompt (spec 011 Phase 1, plan §P1, review log R1–R29): the
// owner describes what should happen in words; ONE mind call turns the wish
// into at most 6 DRAFTS — ordinary Director actions from a closed allow-list —
// which the owner previews and applies through the unchanged preview → apply
// path (director.js). The prompt writes nothing: no world event, no story row,
// no stored wish.
//
//   runPrompt(wish, {by})   gates → catalogue → one callRole('mind', …,
//                           {caller:'director.prompt'}) → validatePromptOutput
//                           → a dry plan per draft. Pre-call refusals throw a
//                           StoryError; after the call it always resolves
//                           { status, drafts, dropped, cantDo, … }.
//   buildCatalogue(state, world, now, tz)   the model's only input besides the
//                           wish: code-built (no chat text, claims, subjects, journal, real
//                           names); a plan made in a chat only as times, codes and marks (020).
//
// Gates, in order (each refusal costs nothing): the wish (≤ 400, JIDs/phones
// with dates masked, real names case-insensitively, the names list read fail
// closed), one prompt at a time, the day cap from the ledger (strict reader:
// a read error = cap reached), the prompt's own $ sub-cap AND the combined
// life.arcs.* + director.prompt total under ARCS_MIND_BUDGET_USD, then 008's
// mindBudgetOk('think') (absent → refused).
//
// Logging and audit: statuses, lengths and counts only — never the wish, a
// `why` or a cantDo line.

import { config, getPersona } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { now as clockNow, dateKey, dayStart, addDays, hhmm as clockHhmm, weekday as weekdayOf, resolveTimezone } from '../clock.js';
import { getEvent } from '../eventLog.js';
import { realPeopleNames, normalizeName, textNameCollisions } from '../world.js';
import { activityClass } from '../vitals.js';
import { forecast } from '../weather.js';
import { CATEGORIES, FATE_MODES, SLIDERS, ROMANCE_STAGES, SEED_PATHS, isPinKey } from './reducer.js';
import { cleanItem, fence, FENCE_NOTE } from './charter.js';
import { validatePromptOutput, PROMPT_MAX_ACTIONS, PROMPT_CANTDO_MAX, PROMPT_DROP_REASONS } from './schema.js';
import { arcsCallerSpend } from './seed.js';
import { planDay } from '../routine.js';   // 014 sched
import * as directorMod from './director.js';
import { wishSexual } from './desire.js';
import { isChatDecision } from './pending.js';   // 015
import { earliestStart } from './outing.js';
import { wakeFor } from '../pulse.js';   // wake him

const HOUR = 3600;
export const PROMPT_CALLER = 'director.prompt';
export const WISH_MAX = 400;
export const STATE_MAX = 8192;
const CALL_TIMEOUT_MS = 45_000;
const MAX_TOKENS = 2000;
const CATALOGUE_DAYS = 14;
const LIST_CAPS = { cast: 24, places: 48, arcs: 16 };
const TIGHTEN_ONLY_SLIDERS = Object.freeze(['heavyLikelihood', 'drama']);
const NEW_CAST_RELATIONS = Object.freeze(['friend', 'acquaintance', 'neighbour', 'coworker', 'flatmate']);   // 015: + flatmate
const BEAT_KINDS = Object.freeze(['status', 'away', 'back', 'hobby', 'news', 'milestone', 'trip']);
const WEEKDAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
// Kinds a draft never auto-applies through APPLY ALL (review R2/R3/R7/R10): they
// resolve their target when planned, loosen a control, or carry free text the
// owner must read first. batchableOf adds a fate other than "frozen" and the
// heavy-lever sliders (TIGHTEN_ONLY_SLIDERS).
const REVIEW_KINDS = new Set(['unpin', 'resume', 'cast.edit', 'cast.history', 'place.edit', 'seed.set',
  'scene.tone',   // 016: free text
  'text']);       // 019: the owner's gist (free text)
const REVIEW_QUICK = new Set(['cancel_tonight', 'free_evening']);
const REVIEW_SHAPES = new Set(['new_cast', 'new_place', 'cast.beat', 'cast.history']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The Director's closed lists, handed to the (planner-free) validator. */
export const VOCAB = Object.freeze({
  actionKinds: directorMod.ACTION_KINDS,
  promptKinds: directorMod.PROMPT_ACTION_KINDS,
  promptSceneShapes: directorMod.PROMPT_SCENE_SHAPES,
  quickButtons: directorMod.QUICK_BUTTONS,
  categories: CATEGORIES,
  fateModes: FATE_MODES,
  sliders: SLIDERS,
  tightenOnlySliders: TIGHTEN_ONLY_SLIDERS,
  seedPaths: Object.keys(SEED_PATHS),
  romanceStages: ROMANCE_STAGES,
  arcKinds: directorMod.ARC_KINDS,
  beatKinds: BEAT_KINDS,
  newCastRelations: NEW_CAST_RELATIONS,
  whenDaysMax: directorMod.WHEN_DAYS_MAX,
  // 011 Phase 2
  weatherKinds: directorMod.WEATHER_KINDS,
  weatherDaysMax: 3,
  goalKinds: directorMod.GOAL_KINDS,
  goalDaysMax: directorMod.GOAL_DAYS_MAX,
  textTones: directorMod.TEXT_TONES,   // 019
  // 014 sched
  scheduleDaysMax: directorMod.SCHEDULE_DAYS_MAX,
  // 015 Director as god
  outcomes: ['well', 'badly', 'cancelled'],
  careerChanges: directorMod.CAREER_CHANGES,
  moneyModes: directorMod.MONEY_MODES,
  moodPresets: Object.keys(directorMod.MOOD_PRESETS),
  healthChanges: directorMod.HEALTH_CHANGES,
  arcEndOutcomes: directorMod.ARC_END_OUTCOMES,
  departHow: ['moved_away', 'moved_out', 'written_out'],
  homeFlatmate: directorMod.HOME_FLATMATE,
});


// ── Charter (static, persona-neutral, generated from the planner's own lists) ─

const list = (xs) => xs.map(x => `"${x}"`).join('|');
const arcKindsText = Object.entries(directorMod.ARC_KINDS).map(([c, ks]) => `${c}: ${list(ks)}`).join('; ');

// 015 (plan §P1.9): the opened powers, generated from the planner's own lists.
const GOD_CHARTER = `- {"kind":"decision.pick","decisionId":<id from "decisions">,"optionId":"<one of its options>"}: choose for him (an open one) or change his mind (a committed one, before he has to leave).
- {"kind":"outcome","decisionId":<id from "decisions">,"outcome":"well"|"badly"|"cancelled","when":TIME (optional, the cancel time)}: how that outing turns out — "well"/"badly" happen once it is over, "cancelled" falls through at that time.
- {"kind":"scene.tone","decisionId":<id from "decisions">,"tone":"at most 120","outcome":"well"|"fine"|"flat"|"badly"}: a hint for how that outing should go once it happens ("they hit it off", "awkward but sweet") and the outcome it implies (it sets the outcome, so the two must agree) — no names of real people, nothing bad about a named place.
- {"kind":"career","change":${list(directorMod.CAREER_CHANGES)},"title":"at most 60 (hire / job / promote)","salary":0..1000000000 (optional),"officePlaceId":"<place id>" (optional),"pattern":{"officeDays":[0..6],"wfhDays":[0..6]} (pattern),"when":TIME (optional, when it takes effect)}: his job — never name the employer (the owner fills it in).
- {"kind":"money","mode":${list(directorMod.MONEY_MODES)},"amount":number,"label":"at most 80, optional"}: set his balance, or a one-off income / expense.
- {"kind":"home","near":"<place id>","flatmate":${list(directorMod.HOME_FLATMATE)} (optional),"when":TIME (optional)}: he moves to a new home in that neighbourhood.
- {"kind":"mood","preset":${list(Object.keys(directorMod.MOOD_PRESETS))},"wakeDay":0..${directorMod.WAKE_DAYS_MAX} or "when":TIME,"label":"at most 80, optional"}: how he feels when he wakes on that day, or at that time (not right now: use "quick").
- {"kind":"health","change":${list(directorMod.HEALTH_CHANGES)},"days":1..${directorMod.SICK_DAYS_MAX} (sick),"when":TIME (optional)}: he falls ill (now or later) or gets better.
- {"kind":"arc.end","arcId":<open arc id>,"outcome":${list(directorMod.ARC_END_OUTCOMES)}}: end a storyline.
- {"kind":"cast.depart","castId":"<cast id>","how":"moved_away"|"moved_out"|"written_out"}: someone leaves his life (they can come back).
- {"kind":"cast.return","castId":"<id from "departed">"}: someone who left comes back.
- {"kind":"wake","reason":${list(directorMod.WAKE_REASONS)},"at":"HH:MM" (optional: default right now; a time while he is asleep tonight),"until":"HH:MM" (optional, not for "early_start": when he goes back to sleep)}: wake him in the night — "cant_sleep" (he can't sleep) or "woken_up" (something woke him): he is up at home, then sleeps again until his usual wake (later if he goes out); "early_start": he gets up early and starts his day. "sleep" in the state block says whether he is asleep, since when, when he wakes and tonight's bedtime. "He can't sleep and goes out to X" = a "wake" about 15 minutes before he must leave plus the outing scene at its time (the outing "accompanies" the wake).
- {"kind":"text","castId":"<cast id>","gist":"what the first texter wants to say, at most 160 — the intent, not the words","tone":${list(directorMod.TEXT_TONES)} (optional),"at":"HH:MM" (optional: default now),"from":"him"|"them" (optional, default "him": "them" = that person texts him first),"words":"the first text word for word, at most 160" (optional: ONLY when the owner quoted the exact message),"chat":"short"|"long" (optional: "long" when the owner wants a long chat or a late-night chat session)}: a text conversation on his phone with someone in his life (only his own cast; the rest is written in their own words and they go back and forth). When he is asleep and they text him first, their text wakes him on its own — do not add a separate wake for it. Flirting and innuendo are fine. A "naughty" tone is allowed only for a romance-eligible adult (never family, never the manager); the text itself is written later.`;

export const PROMPT_CHARTER = `You help the owner of a life simulation steer the everyday life of a fictional character. The owner writes a wish in plain words; you turn it into at most ${PROMPT_MAX_ACTIONS} actions from the closed list below. You never write events yourself: the owner reviews every action before anything happens.
The user message holds the current state inside a STORY_DATA block of kind "state" (people with cast ids, places with place ids, open arcs, switches, the next days) and the owner's wish inside a STORY_DATA block of kind "wish".

${FENCE_NOTE}

Actions ("action" objects; use ONLY ids that appear in the state block):
- {"kind":"quick","button":${list(directorMod.QUICK_BUTTONS)}}: right now only (tired / energised / a free evening today / cancel tonight's plan / rain now / a sick day / a bad or good day at work).
- {"kind":"fate","category":${list(CATEGORIES)},"mode":${list(FATE_MODES)}}: natural = the engine decides, guided = ask the owner, frozen = nothing new. Category "heavy" may only be set to "frozen".
- {"kind":"slider","name":${list(SLIDERS)},"value":0..1}: "heavyLikelihood" and "drama" may only be lowered.
- {"kind":"pin"|"unpin","pinKey":"self.job"|"self.relationship"|"<cast id>"|"arc:<arc id>.stage"}: a pin stops the engine changing that thing.
- {"kind":"pause"|"resume","reason":"at most 200 characters, optional"}: pause or resume the whole story.
- {"kind":"bookmark","name":"at most 60 characters"}: ONLY when the owner explicitly asks to bookmark, remember, mark or save this moment — never as an extra next to a scene or any other change.
- {"kind":"scene","shape":"outing","placeId":"<place id>" or "venue":{"name":"at most 60","area":"at most 40"} (a real business or landmark the owner named) or "newPlace":{"name":"at most 60, invented and generic","placeKind":"one lowercase word","near":"<place id>","offsetKm":0..5},"castIds":["<cast id>", at most 4],"newCast":{"name":"at most 40, invented","relation":${list(NEW_CAST_RELATIONS)}} (optional),"when":TIME,"minutes":15..360,"label":"at most 80, optional"}: he goes out.
- {"kind":"scene","shape":"visit","castIds":[…],"when":TIME,"minutes":15..360}: people visit him at home.
- {"kind":"scene","shape":"cast.beat","castId":"<cast id>","beatKind":${list(BEAT_KINDS)},"text":"at most 120, third person","untilDays":1..31 (optional)}: news in someone's life.
- {"kind":"scene","shape":"cast.history","castId":"<cast id>","text":"at most 160","daysAgo":0..36500 (optional)}: a shared memory.
- {"kind":"scene","shape":"new_cast","name":"at most 40, an invented ordinary name","relation":${list(NEW_CAST_RELATIONS)},"pronouns":"…","personality":"at most 200","speech":"at most 160","status":"at most 160"}: only when caps.castLeft > 0.
- {"kind":"scene","shape":"new_place","name":"at most 60, generic","placeKind":"one lowercase word","near":"<place id>","offsetKm":0..5}: only when caps.placesLeft > 0.
- {"kind":"scene","shape":"arc.start","category":…,"arcKind":…,"castIds":[…]}: start a slow storyline; arc kinds per category: ${arcKindsText}. Romance needs exactly one cast id and no open romance.
- {"kind":"scene","shape":"arc.stage","arcId":<open romance arc id>,"to":${list(ROMANCE_STAGES)}}: one step forward or back only (the owner can make bigger jumps by hand).
- {"kind":"cast.edit","castId":"<cast id>","fields":{"status"|"availability"|"personality"|"speech":"…","job":"at most 60","employer":"at most 80, fictional"}}: never a rename.
- {"kind":"cast.metrics","castId":"<cast id>","closeness":0..1,"trust":0..1,"tension":0..1 (at least one; the others stay)}: set how close he is to someone, how far he trusts them, how tense it is between them (the state block's cast shows the current numbers; trust otherwise moves only with kept or broken plans).
- {"kind":"place.edit","placeId":"<place id>","name":"at most 60","placeKind":"one lowercase word"}.
- {"kind":"weather","weatherKind":${list(directorMod.WEATHER_KINDS)},"intensity":0..1 (optional),"from":TIME,"to":TIME}: the weather for a window starting at most 72 hours ahead, 30 minutes to 72 hours long; it replaces the forecast in that window only ("weather" in the state block is the forecast, "owner": true where a window already set it).
- {"kind":"weather.end","windowId":<id from "windows">}: end a weather window early.
- {"kind":"goal","goalKind":${list(directorMod.GOAL_KINDS)},"castId":"<cast id>" (meet needs one; call: a family member, optional),"placeId":"<place id>" (optional),"fromDay":0..${directorMod.GOAL_DAYS_MAX},"toDay":0..${directorMod.GOAL_DAYS_MAX},"minutes":15..240 (optional),"label":"at most 80, optional"}: something he should get round to between those days; the engine fits it into a free evening slot when he has the energy, and it lapses visibly if it never fits.
- {"kind":"goal.cancel","goalId":<id from "goals">}: drop a goal.
- {"kind":"schedule","day":0..${directorMod.SCHEDULE_DAYS_MAX},"background":{"activity":"off"|"work_home"|"work_office","from":"HH:MM"|"now","to":"HH:MM"|"endOfDay"} or {"activity":…,"wholeDay":true} (optional),"ranges":[{"activity":"home"|"out"|"sleep"|"errand"|"gym"|"work_office"|"work_home","from":"HH:MM"|"now","to":"HH:MM"|"endOfDay","placeId":"<place id>" (out; optional for gym / errand),"castIds":[…] (optional),"label":"at most 80, optional"}] (at most 3)}: change his schedule on one day — a day off or working from home / at the office (the whole day, or from a time), plus up to three stretches on top: at home, out at a place, the gym, an errand, sleeping in ("sleep" from "00:00" to when he gets up) or an early night ("sleep" until "endOfDay"). "now" = right now (day 0 only); "endOfDay" = when he would go to sleep that day ("schedule" in the state block lists each day's type, work, wake and sleep).
- {"kind":"schedule","day":0..${directorMod.SCHEDULE_DAYS_MAX},"op":"remove"|"move","blockKind":"<a kind of that day>","moveTo":"HH:MM" (move only)}: drop or move one of his routine stretches.
- {"kind":"schedule.clear","overrideId":<id from "overrides">}: undo a schedule change early (one change per day and time: clear the old one before setting an overlapping one).
${GOD_CHARTER}
TIME is {"day":0..${directorMod.WHEN_DAYS_MAX},"time":"HH:MM"} (day 0 = today in the state block, 24 h clock) or {"inMinutes":0..1440}.

Rules:
- Use only the people, places and arcs listed; never invent a real person, a real company, an address, a link or a phone number.
- If part of the wish can't be done with these actions (hard life events — the Director's heavy panel; rewinding or rewriting the past; anything about real people; messaging real people or the chats — only his own cast can be texted, with "text"; claims from chats; the reconciler switch; anything sexually explicit), say so in "cantDo" instead of approximating it with something heavier.
- A plan marked "fromChat" (in "decisions" or "tonight") was made in a chat with a real person: keep it unless the wish asks to change it. One marked "realPerson" takes only a pick or the outcome "cancelled", never "well" or "badly" or a tone.
- "the rest of the day off and go to X" is ONE schedule action: a background "off" from "now" plus an "out" range.
- "make sure he sees / calls / does X this week" is a goal, not a fixed scene; a fixed time is a scene.
- An outing or visit "now", "right away", "suddenly" or "in a bit" still needs him to get ready (prep) and travel there, so it never starts in 0–15 minutes: its "inMinutes" is at least that place's "leadMin" in the state block (prep + the trip from where he is now; a visit: his home place's; a "venue" or a "newPlace": at least 60). A sooner start is refused.
- A real venue the owner names (a business or landmark by its name, often with its area) is never a "newPlace": in an outing it goes in "venue" ({"name":"at most 60","area":"at most 40"}), in a schedule range in "venueQuery" (the same shape); the server looks it up and the owner picks the result. "newPlace" / "new_place" are only for an invented generic place the owner didn't name. You never write coordinates or addresses, and never invent a venue the owner didn't name. Places marked "venue": true are real businesses already in his world (use their place id).
- At most ${PROMPT_MAX_ACTIONS} actions, most important first; "why" says in at most 120 characters what each one is for. An action that only makes sense together with another of yours carries "accompanies": <that action's position, 0-based> beside "why"; it is never applied without it. At most ${PROMPT_CANTDO_MAX} "cantDo" lines of at most 120 characters.

Reply with ONLY one JSON object, no prose, no code fences. You never write messages to anyone and never change settings, budgets or rules.
{"actions":[{"action":{"kind":"scene","shape":"outing","placeId":"place:…","castIds":["cast:…"],"when":{"day":1,"time":"19:30"},"minutes":120,"label":"dinner"},"why":"…"}],"cantDo":["…"]}`;

// ── Deps (the story facade wires the live ones; tests stub them) ──────────

const DEFAULT_DEPS = {
  now: () => clockNow(),
  getState: () => null,
  world: null,
  callRole: null,            // default: brain/llm.js callRole (lazy import)
  mindBudgetOk: null,        // 008's gate; absent → refused (fail closed)
  getUsageByCaller: null,    // default: brain/usage.js getUsageByCallerStrict (lazy import)
  knownNames: () => realPeopleNames(),   // a throw → names_unavailable (fail closed)
  persona: null,
  // 014 geo (A6b): the life facade's geo service ({search, venueQueryProblem}); null → no lookups.
  geo: null,
  logger,
};
let deps = { ...DEFAULT_DEPS };
let busy = false;

export function configure(over = {}) {
  if (isObj(over)) deps = { ...deps, ...over };
}

export function __setDepsForTest(over) {
  if (over === null) { deps = { ...DEFAULT_DEPS }; busy = false; return; }
  deps = { ...deps, ...(isObj(over) ? over : {}) };
}

const err = (code, reason) => new directorMod.StoryError(code, reason);

// ── The wish ──────────────────────────────────────────────────────────────

const JID_RE = /[0-9A-Za-z._:+-]{3,}@(?:s\.whatsapp\.net|g\.us|lid|c\.us|broadcast)|@\s?\d{3,}/i;
const PHONE_RE = /\+?\d[\d\s-]{8,}\d/;
// Dates and clock times are masked before the phone check (review R9): a wish names days.
// A date takes one non-space separator, the same twice — a space-grouped phone
// number ("0612 34 56 78") is never read as a date.
const DATE_MASKS = [/\b\d{4}([-/.])\d{1,2}\1\d{1,2}\b/g, /\b\d{1,2}([-/.])\d{1,2}\1\d{2,4}\b/g,
  /\b\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?\b/g];

/**
 * Why a wish is refused before any model call, or null. Real names are checked
 * case-insensitively (any token equal to a known first name of ≥ 3 letters, or a
 * known full name). First names of his current cast are exempt as a bare token —
 * the model sees them in the catalogue anyway — but a real full name is refused
 * even when its first name is a cast member's (only a cast member's own full name passes).
 */
export function wishProblem(wish, knownNames, castNames = []) {
  if (typeof wish !== 'string' || !wish.trim()) return 'bad_wish';
  if (wish.length > WISH_MAX) return 'too_long';
  if (JID_RE.test(wish)) return 'jid_in_text';
  let masked = wish;
  for (const re of DATE_MASKS) masked = masked.replace(re, ' ');
  if (PHONE_RE.test(masked)) return 'jid_in_text';
  const castNorm = castNames.map(n => normalizeName(n)).filter(Boolean);
  const exempt = new Set(castNorm.map(n => n.split(' ')[0]));
  const castFull = new Set(castNorm);
  const full = new Set();
  const first = new Set();
  for (const n of knownNames || []) {
    const norm = normalizeName(n);
    if (!norm) continue;
    if (norm.includes(' ') && !castFull.has(norm)) full.add(norm);
    const f = norm.split(' ')[0];
    if (f.length >= 3 && !exempt.has(f)) first.add(f);
  }
  const norm = ` ${normalizeName(wish)} `;
  for (const f of full) if (norm.includes(` ${f} `)) return 'real_person_name';
  for (const tok of norm.trim().split(' ')) if (first.has(tok)) return 'real_person_name';
  // The planner's own rule too, for parity. Its list leaves out the names whose
  // first name is a cast member's: it flags any capitalized known first name, so
  // the full list would refuse "Sibling visits"; their full names are refused above.
  if (textNameCollisions({ places: [{ name: wish }] }, (knownNames || []).filter(n => !exempt.has(normalizeName(n).split(' ')[0]))).length) {
    return 'real_person_name';
  }
  return null;
}

// ── The catalogue (the model's only other input) ───────────────────────────

const CHAT_KINDS = new Set(['dm', 'group', 'call', 'ig']);
function chatOriginEvent(id) {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    const ev = getEvent(id);
    return !!ev && (CHAT_KINDS.has(ev.originKind) || typeof ev.subjectJid === 'string');
  } catch {
    return true;   // unknown → treat as chat (mask)
  }
}

function hm(at, tz) {
  return finite(at) ? clockHhmm(at, tz) : null;
}

// workEnds / sleepsAt from the plan as MADE (its event payload), never from later
// folds; a chat-caused plan (amendment, chat origin) → the base routine plan (R13).
function planTimes(state, tz) {
  const plan = state.plan;
  if (!isObj(plan)) return { workEnds: null, sleepsAt: null, dayType: null };
  let src = null;
  const own = Number.isSafeInteger(plan.eventId) ? plan.eventId : null;
  const base = Number.isSafeInteger(plan.basePlanEventId) ? plan.basePlanEventId : null;
  const amended = Number.isSafeInteger(plan.amendedFor) || (Array.isArray(plan.blocks) && plan.blocks.some(b => b?.fromAmendment || b?.subjectJid));
  for (const id of amended || chatOriginEvent(own) ? [base] : [own, base]) {
    if (!id || chatOriginEvent(id)) continue;
    try { const ev = getEvent(id); if (isObj(ev?.payload) && Array.isArray(ev.payload.blocks)) { src = ev.payload; break; } } catch { /* next */ }
  }
  if (!src) return { workEnds: null, sleepsAt: null, dayType: typeof plan.dayType === 'string' ? plan.dayType : null };
  const work = src.blocks.filter(b => b?.kind === 'work' || b?.kind === 'meeting').map(b => b.end).filter(finite);
  return {
    workEnds: work.length ? hm(Math.max(...work), tz) : null,
    sleepsAt: hm(src.sleepAt, tz),
    dayType: typeof src.dayType === 'string' ? src.dayType.slice(0, 16) : null,
  };
}

function pinKeysOf(state) {
  const keys = ['self.job', 'self.relationship'];
  for (const id of state.cast instanceof Map ? state.cast.keys() : []) keys.push(id);
  for (const a of Object.values(state.story?.arcs ?? {})) if (a?.status === 'active') keys.push(`arc:${a.id}.stage`);
  return keys.filter(k => { try { return isPinKey(k); } catch { return false; } });
}

/**
 * The model's input: code-built, origin-free. → { model, check } where `model` is
 * the object serialized into the state fence and `check` the id sets the
 * validator needs.
 */
export function buildCatalogue(state, world, now, tz) {
  const zone = resolveTimezone(tz);
  const today = dateKey(now, zone);
  const day0 = dayStart(now, zone);
  const days = [];
  for (let i = 0; i < CATALOGUE_DAYS; i++) {
    const d = addDays(day0, i, zone);
    days.push({ day: i, date: dateKey(d, zone), weekday: WEEKDAY_NAMES[weekdayOf(d + 12 * HOUR, zone)] ?? null });
  }
  const activityChat = chatOriginEvent(state.activity?.eventId);
  const times = planTimes(state, zone);
  const castEntries = [...(state.cast instanceof Map ? state.cast.values() : [])].filter(c => typeof c?.id === 'string');
  const castLife = state.story?.castLife ?? {};
  const metric = (m, k) => (finite(m?.[k]) ? Math.round(m[k] * 100) / 100 : null);
  const cast = castEntries.slice(0, LIST_CAPS.cast).map(c => ({
    id: c.id, name: cleanItem(c.name, 40), relation: cleanItem(c.relation, 24) || null,
    pinned: !!state.story?.controls?.pins?.[c.id], away: !!castLife[c.id]?.away,
    closeness: metric(c.metrics, 'closeness'), trust: metric(c.metrics, 'trust'), tension: metric(c.metrics, 'tension'),
  }));
  const places = [...(state.places instanceof Map ? state.places.values() : [])].filter(p => typeof p?.id === 'string')
    .slice(0, LIST_CAPS.places).map(p => ({ id: p.id, name: cleanItem(p.name, 60), kind: cleanItem(p.kind, 24) || null,
      ...(p.venue && typeof p.venue === 'object' ? { venue: true } : {}),   // 014 geo (P.3.6)
      ...leadOf(state, world, now, p.id) }));
  const arcs = Object.values(state.story?.arcs ?? {}).filter(a => a?.status === 'active').slice(0, LIST_CAPS.arcs)
    .map(a => ({ id: a.id, category: a.category, kind: cleanItem(a.kind, 24), stage: cleanItem(a.stage, 24),
      castIds: (Array.isArray(a.castIds) ? a.castIds : []).filter(id => typeof id === 'string').slice(0, 4) }));
  const ctl = state.story?.controls ?? {};
  const target = directorMod.tonightTarget(state, now, zone);
  const castMax = Math.min(24, finite(config.arcs?.castMax) ? config.arcs.castMax : 24);
  const bookmarksMax = Math.min(30, finite(config.arcs?.bookmarksMax) ? config.arcs.bookmarksMax : 30);
  const model = {
    now: { date: today, weekday: days[0].weekday, time: clockHhmm(now, zone) },
    days,
    self: {
      doing: activityChat ? 'busy' : activityClass(state.activity, world),
      dayType: times.dayType,
      workEnds: times.workEnds,
      sleepsAt: times.sleepsAt,
      romanceStage: ROMANCE_STAGES.includes(state.story?.romance?.stage) ? state.story.romance.stage : 'single',
      sick: !!(state.sick || state.vitals?.sick === true),
    },
    cast,
    places,
    arcs,
    controls: {
      paused: ctl.paused === true,
      fate: Object.fromEntries(CATEGORIES.map(c => [c, FATE_MODES.includes(ctl.fate?.[c]) ? ctl.fate[c] : 'natural'])),
      sliders: Object.fromEntries(SLIDERS.map(n => [n, finite(ctl.sliders?.[n]) ? ctl.sliders[n] : 0.5])),
      pins: Object.keys(ctl.pins ?? {}).filter(k => typeof k === 'string').slice(0, 32),
    },
    // 020: tonight's plan, marked when it was made in a chat (the same plan as in "decisions").
    tonight: { eveningPlan: !!target, ...(target?.fromChat ? { fromChat: true } : {}) },
    // 011 Phase 2: the next 72 h of weather (owner windows marked), the open windows and goals.
    weather: weatherBlocks(state, world, now, zone),
    windows: (Array.isArray(state.weatherWindows) ? state.weatherWindows : [])
      .filter(w => finite(w?.to) && w.to > now && Number.isSafeInteger(w.id)).slice(0, 8)
      .map(w => ({ id: w.id, from: relTime(w.from, now, zone), to: relTime(w.to, now, zone), sky: w.sky })),
    goals: Object.values(isObj(state.goals) ? state.goals : {})
      .filter(g => g?.status === 'open' || g?.status === 'fitted').slice(0, 8)
      .map(g => ({ id: g.id, goalKind: g.goalKind, castId: g.castId ?? null, placeId: g.placeId ?? null,
        toDay: dayIndex(g.to - 1, now, zone), status: g.status })),
    // 014 sched: the next 8 days as planned (code-built, origin-free) and the owner's open schedule changes.
    schedule: scheduleDays(state, world, now, zone, times),
    // Wake him: is he asleep, since when, when he wakes, tonight's bedtime (times only).
    sleep: sleepOf(state, world, zone),
    overrides: overridesOf(state, now, zone),
    // 015 (plan §P1.9): decisions in the next 14 days (020: chat-made ones marked), his job / home / money, who left, what's scheduled.
    decisions: godDecisions(state, now, zone),
    me: godSelf(state, world),
    departed: Object.values(isObj(state.story?.departed) ? state.story.departed : {}).filter(c => typeof c?.id === 'string')
      .slice(0, 16).map(c => ({ id: c.id, name: cleanItem(c.name, 40), relation: cleanItem(c.relation, 24) || null })),
    pending: Object.entries(isObj(state.story?.pending) ? state.story.pending : {}).slice(0, 16)
      .map(([id, e]) => ({ id: Number(id), type: e?.type ?? null, day: e?.due?.at ? dayIndex(e.due.at, now, zone) : (e?.due?.wakeDate ?? null) })),
    caps: {
      castLeft: Math.max(0, castMax - (state.cast?.size ?? 0)),
      placesLeft: Math.max(0, 48 - (state.places?.size ?? 0)),
      bookmarksLeft: Math.max(0, bookmarksMax - (state.story?.bookmarks?.length ?? 0)),
    },
  };
  // Fit the fence by dropping list tails, never by cutting characters (R29).
  const fits = () => JSON.stringify(model).length <= STATE_MAX - 64;
  for (const k of ['schedule', 'weather', 'pending', 'departed', 'decisions', 'arcs', 'places', 'cast']) while (!fits() && model[k].length > 1) model[k].pop();   // 014 sched: schedule first
  const check = {
    today,
    castIds: new Set(model.cast.map(c => c.id)),
    placeIds: new Set(model.places.map(p => p.id)),
    // 015: real venues and owner-renamed places are never his office (plan §P1.2).
    venuePlaceIds: new Set([...(state.places instanceof Map ? state.places.values() : [])]
      .filter(p => typeof p?.id === 'string' && ((p.venue && typeof p.venue === 'object') || p.ownerNamed === true)).map(p => p.id)),
    arcIds: new Set(model.arcs.map(a => a.id)),
    pinKeys: new Set(pinKeysOf(state).filter(k => !k.startsWith('cast:') || model.cast.some(c => c.id === k))),
    pins: new Set(model.controls.pins),
    sliders: model.controls.sliders,
    windowIds: new Set(model.windows.map(w => w.id)),
    goalIds: new Set(model.goals.map(g => g.id)),
    overrideIds: new Set(model.overrides.map(o => o.id)),   // 014 sched
    // 015
    decisionIds: new Set(model.decisions.map(d => d.id)),
    decisionOptions: new Map(model.decisions.map(d => [d.id, d.options])),
    departedIds: new Set(model.departed.map(c => c.id)),
  };
  return { model, check };
}

// 014 sched: days 0–7 — type, work, wake, sleep, the overrides each carries.
// Day 0 from the plan as made (planTimes: a chat-amended plan reads as its base,
// R13); later days from planDay on the current state (pure).
function scheduleDays(state, world, now, tz, times) {
  const out = [];
  const d0 = dayStart(now, tz);
  const workOf = (t) => (t === 'office' ? 'office' : t === 'wfh' ? 'wfh' : 'none');
  for (let i = 0; i <= directorMod.SCHEDULE_DAYS_MAX; i++) {
    const date = dateKey(addDays(d0, i, tz), tz);
    if (i === 0 && state.plan?.date === date) {
      out.push({ day: 0, dayType: times.dayType, work: workOf(times.dayType), wakes: hm(state.plan.wakeAt, tz), sleeps: times.sleepsAt,
        overrides: Array.isArray(state.plan.overrides) ? state.plan.overrides.slice(0, 8) : [] });
      continue;
    }
    let p = null;
    try { p = world ? planDay(state, date, world) : null; } catch { p = null; }
    if (!p) { out.push({ day: i, dayType: null, work: null, wakes: null, sleeps: null, overrides: [] }); continue; }
    out.push({ day: i, dayType: typeof p.dayType === 'string' ? p.dayType : null, work: workOf(p.dayType), wakes: hm(p.wakeAt, tz), sleeps: hm(p.sleepAt, tz),
      overrides: Array.isArray(p.overrides) ? p.overrides.slice(0, 8) : [] });
  }
  return out;
}

function sleepOf(state, world, tz) {
  const asleep = state?.activity?.kind === 'sleep';
  let wakes = null;
  try { wakes = asleep ? wakeFor(state, world)?.at ?? null : state?.plan?.nextWakeAt ?? null; } catch { wakes = null; }
  return {
    asleep, since: asleep && finite(state.activity.startAt) ? hm(state.activity.startAt, tz) : null,
    wakes: finite(wakes) ? hm(wakes, tz) : null, bedtime: !asleep && finite(state?.plan?.sleepAt) ? hm(state.plan.sleepAt, tz) : null,
  };
}

function overridesOf(state, now, tz) {
  const rel = (at) => (finite(at) ? hm(at, tz) : null);
  return Object.values(isObj(state.scheduleOverrides) ? state.scheduleOverrides : {})
    .filter(o => o?.status === 'active' && Number.isSafeInteger(o.id)).slice(0, 12)
    .map(o => ({
      id: o.id, day: dayIndex(planDateStart(o.date, tz), now, tz),
      background: o.background ? { activity: o.background.activity, ...(o.background.wholeDay ? { wholeDay: true } : { from: rel(o.background.from), to: rel(o.background.to) }) } : null,
      ranges: (o.ranges || []).map(r => ({ activity: r.activity, from: rel(r.from), to: rel(r.to) })),
      ...(o.op && o.op !== 'set' ? { op: o.op, blockKind: o.blockKind } : {}),
    }));
}

function planDateStart(date, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  return m ? dayStart(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) / 1000, tz) : null;
}

// 015: open / committed decisions the owner may steer. 020: chat-made ones too — by codes and code-built
// fields only (`fromChat`), never a chat's words or a real person (no subject, no label).
function godDecisions(state, now, tz) {
  const horizon = now + CATALOGUE_DAYS * 86400;
  return [...(state.decisions instanceof Map ? state.decisions.values() : [])]
    .filter(d => (d?.status === 'open' || d?.status === 'committed')
      && finite(d.subject?.eventAt) && d.subject.eventAt <= horizon && d.subject.eventAt + 6 * 3600 > now)
    .sort((a, b) => a.subject.eventAt - b.subject.eventAt).slice(0, 12)
    .map(d => ({
      id: d.id, kind: cleanItem(d.kind, 24), ...relTime(d.subject.eventAt, now, tz),
      placeId: typeof d.subject.placeId === 'string' ? d.subject.placeId : null,
      castIds: (Array.isArray(d.subject.castIds) ? d.subject.castIds : []).filter(id => typeof id === 'string').slice(0, 4),
      options: (Array.isArray(d.options) ? d.options : []).map(o => o?.id).filter(x => typeof x === 'string').slice(0, 6),
      committed: d.status === 'committed' ? (d.committed?.optionId ?? null) : null,
      outcome: state.story?.outcomes?.[d.id]?.outcome ?? null,
      ...(isChatDecision(d) ? { fromChat: true } : {}),
      ...(typeof d.subjectJid === 'string' ? { realPerson: true } : {}),
    }));
}

// 015: his job title (never the employer), office pattern, home and money (rounded).
// Minutes from now to the earliest start he can still make at a place (getting
// ready + the trip from where he is; the Director's too_soon check and its MOVE TO
// use the same code) → { leadMin } | {} (no route, or not within a few hours).
function leadOf(state, world, now, placeId) {
  try {
    const at = earliestStart({ state, now, world }, { placeId });
    return finite(at) ? { leadMin: Math.max(0, Math.ceil((at - now) / 60)) } : {};
  } catch {
    return {};
  }
}

function godSelf(state, world) {
  const c = state.story?.career ?? {};
  const employed = c.employed !== false;
  const title = employed ? cleanItem(c.title ?? world?.self?.job?.title, 60) || null : null;
  const pat = isObj(c.pattern) ? c.pattern : null;
  const money = finite(state.vitals?.money) ? Math.round(state.vitals.money / 100) * 100 : null;
  return {
    employed, job: title ? { title } : null, ...(pat ? { pattern: { officeDays: pat.officeDays, wfhDays: pat.wfhDays } } : {}),
    homePlaceId: typeof state.self?.homePlaceId === 'string' ? state.self.homePlaceId : null, money,
  };
}

// Days since today of a local time (0 = today; null past 60 days or before today).
function dayIndex(at, now, tz) {
  if (!finite(at)) return null;
  const key = dateKey(at, tz);
  const d0 = dayStart(now, tz);
  for (let i = 0; i <= 60; i++) if (dateKey(addDays(d0, i, tz), tz) === key) return i;
  return null;
}

function relTime(at, now, tz) {
  return finite(at) ? { day: dayIndex(at, now, tz), time: clockHhmm(at, tz) } : null;
}

function weatherBlocks(state, world, now, tz) {
  let list = [];
  try { list = forecast(now, 72, world, { state, tz }); } catch { list = []; }
  return list.slice(0, 32).map(w => ({
    ...relTime(Math.max(w.from, now), now, tz), sky: typeof w.condition === 'string' ? w.condition : null,
    tempC: finite(w.tempC) ? w.tempC : null, ...(w.owner ? { owner: true } : {}),
  }));
}

// ── Drafts → what the page shows ──────────────────────────────────────────

/** Free-text fields of a draft, labelled (the card shows each verbatim, R3). */
export function textsOf(action) {
  const out = [];
  const add = (field, v) => { if (typeof v === 'string' && v) out.push({ field, value: v }); };
  for (const k of ['label', 'text', 'name', 'reason', 'pronouns', 'personality', 'speech', 'status', 'title', 'employerName', 'gist', 'words']) add(k, action[k]);
  for (const [k, v] of Object.entries(isObj(action.fields) ? action.fields : {})) add(`fields.${k}`, v);
  for (const [k, v] of Object.entries(isObj(action.newCast) ? action.newCast : {})) add(`newCast.${k}`, v);
  for (const [k, v] of Object.entries(isObj(action.newPlace) ? action.newPlace : {})) add(`newPlace.${k}`, v);
  return out;
}

/** May APPLY ALL apply this draft without the modal? → { batchable, reviewReason } */
export function batchableOf(action, planned = null) {
  const why = (reviewReason) => ({ batchable: false, reviewReason });
  // 015: every god change gets the modal; so does any draft whose dry plan warns (≥ warn).
  if (directorMod.GOD_ACTION_KINDS.includes(action.kind)) return why('god_change');
  if ((planned?.continuity?.warnings ?? []).some(w => w?.severity === 'warn' || w?.severity === 'high')) return why('continuity');
  if (REVIEW_KINDS.has(action.kind)) return why(action.kind === 'unpin' || action.kind === 'resume' ? 'loosens_control' : 'free_text');
  // A fate other than "frozen" can unfreeze a category or end "guided"; a heavy
  // lever's draft carries an absolute value that was checked against the slider
  // at prompt time only (the owner may have moved it since) — both get the modal.
  if (action.kind === 'fate' && action.mode !== 'frozen') return why('loosens_control');
  if (action.kind === 'slider' && TIGHTEN_ONLY_SLIDERS.includes(action.name)) return why('loosens_control');
  if (action.kind === 'quick' && REVIEW_QUICK.has(action.button)) return why('target_resolved');
  if (action.kind === 'scene' && REVIEW_SHAPES.has(action.shape)) return why('free_text');
  // 014: an outing at a picked real venue creates the place when planned.
  if (action.kind === 'scene' && action.candidateId) return why('target_resolved');
  if (action.kind === 'scene' && (action.newCast || action.newPlace)) return why('free_text');
  // 014 sched (R34): a schedule draft resolves its conflicts when planned — never in APPLY ALL from here.
  if (action.kind === 'schedule') return why('target_resolved');
  // Wake him: his night is re-planned from the time — always the modal.
  if (action.kind === 'wake') return why('target_resolved');
  return { batchable: true, reviewReason: null };
}

function whenText(action, key = 'when') {
  const w = action[key];
  if (!isObj(w)) return null;
  if (finite(w.inMinutes)) return `in ${Math.max(directorMod.IN_MINUTES_MIN, w.inMinutes)} min`;
  return `${w.date} ${w.time}`;
}

const nameOf = (state, id) => (typeof id === 'string' ? cleanItem(state.cast?.get?.(id)?.name, 40) || id : null);
const placeNameOf = (state, id) => (typeof id === 'string' ? cleanItem(state.places?.get?.(id)?.name, 60) || id : null);
const up = (s) => String(s ?? '').toUpperCase().replace(/[._]/g, ' ');

/** A code-built one-line summary (never model text). */
export function summaryOf(action, state, now, tz, extra = {}) {
  const parts = [up(action.kind)];
  switch (action.kind) {
    case 'quick':
      parts.push(up(action.button));
      if (action.button === 'cancel_tonight' && extra.target) {
        parts.push(`${cleanItem(extra.target.label, 60) || 'tonight'} at ${hm(extra.target.eventAt, tz) ?? '?'}`);
      }
      break;
    case 'fate': parts.push(up(action.category), up(action.mode)); break;
    case 'slider': parts.push(up(action.name), String(action.value)); break;
    case 'pin': case 'unpin': parts.push(action.pinKey); break;
    case 'bookmark': break;
    case 'scene': {
      parts.push(up(action.shape));
      if (action.placeId) parts.push(placeNameOf(state, action.placeId));
      if (action.newPlace) parts.push('a new place');
      if (action.candidateId || (extra.venue && !action.placeId && !action.newPlace)) parts.push('a real place (pick it below)');
      const w = whenText(action);
      if (w) parts.push(w);
      if (finite(action.minutes)) parts.push(`${action.minutes} min`);
      const who = [...(action.castIds ?? []).map(id => nameOf(state, id)), ...(action.newCast ? ['someone new'] : [])];
      if (action.castId) who.push(nameOf(state, action.castId));
      if (who.length) parts.push(`with ${who.join(', ')}`);
      if (action.category) parts.push(up(action.category));
      if (action.arcId) parts.push(`arc #${action.arcId} → ${up(action.to)}`);
      break;
    }
    case 'cast.edit': case 'cast.history': parts.push(nameOf(state, action.castId)); break;
    case 'cast.metrics':
      parts.push(nameOf(state, action.castId));
      for (const k of directorMod.METRIC_FIELDS) if (finite(action[k])) parts.push(`${k} ${action[k]}`);
      break;
    case 'place.edit': parts.push(placeNameOf(state, action.placeId)); break;
    case 'seed.set': parts.push(action.path, JSON.stringify(action.value)); break;
    case 'weather':
      parts.push(up(action.weatherKind));
      if (finite(action.intensity)) parts.push(`intensity ${action.intensity}`);
      parts.push(`${whenText(action, 'from') ?? '?'} → ${whenText(action, 'to') ?? '?'}`);
      break;
    case 'weather.end': case 'goal.cancel': parts.push(`#${action.windowId ?? action.goalId}`); break;
    // 014 sched
    case 'schedule': {
      parts.push(action.date);
      if (action.op && action.op !== 'set') parts.push(`${up(action.op)} ${action.blockKind}${action.moveTo ? ` → ${action.moveTo}` : ''}`);
      const bg = action.background;
      if (bg) parts.push(`${up(bg.activity)}${bg.wholeDay ? ' ALL DAY' : ` ${bg.from}–${bg.to}`}`);
      for (const r of action.ranges ?? []) parts.push(`${up(r.activity)}${r.placeId ? ` ${placeNameOf(state, r.placeId)}` : ''} ${r.from}–${r.to}`);
      break;
    }
    case 'schedule.clear': parts.push(`#${action.overrideId}`); break;
    // 015 Director as god
    case 'decision.pick': parts.push(`#${action.decisionId}`, `→ ${up(action.optionId)}`); break;
    case 'outcome': parts.push(`#${action.decisionId}`, up(action.outcome), whenText(action)); break;
    case 'scene.tone': parts.push(`#${action.decisionId}`, 'HOW IT SHOULD GO'); break;   // 016
    case 'career':
      parts.push(up(action.change));
      if (action.title) parts.push(cleanItem(action.title, 60));
      if (finite(action.salary)) parts.push(`salary ${action.salary}`);
      if (action.when) parts.push(whenText(action));
      break;
    case 'money': parts.push(up(action.mode), String(action.amount)); break;
    case 'home': parts.push(`near ${placeNameOf(state, action.near)}`, action.flatmate ? `flatmate ${action.flatmate}` : null, whenText(action)); break;
    case 'wake': parts.push(String(action.reason ?? '').replace(/_/g, ' '), typeof action.at === 'string' ? `at ${action.at}` : 'now', typeof action.until === 'string' ? `until ${action.until}` : null); break;
    case 'text': parts.push(action.from === 'them' ? `from ${nameOf(state, action.castId)}` : `to ${nameOf(state, action.castId)}`, action.tone ? up(action.tone) : null, typeof action.at === 'string' ? `at ${action.at}` : 'now', action.chat === 'long' ? 'LONG CHAT' : null); break;   // 019
    case 'mood': parts.push(up(action.preset ?? 'custom'), Number.isInteger(action.wakeDay) ? `wake day ${action.wakeDay}` : whenText(action)); break;
    case 'health': parts.push(up(action.change), finite(action.days) ? `${action.days} d` : null, whenText(action)); break;
    case 'arc.end': parts.push(`arc #${action.arcId}`, up(action.outcome)); break;
    case 'cast.depart': parts.push(nameOf(state, action.castId) ?? state.story?.departed?.[action.castId]?.name, up(action.how)); break;
    case 'cast.return': parts.push(cleanItem(state.story?.departed?.[action.castId]?.name, 40) || action.castId); break;
    case 'goal':
      parts.push(up(action.goalKind));
      if (action.castId) parts.push(`with ${nameOf(state, action.castId)}`);
      if (action.placeId) parts.push(placeNameOf(state, action.placeId));
      parts.push(`${action.fromDate} – ${action.toDate}`);
      if (finite(action.minutes)) parts.push(`${action.minutes} min`);
      break;
    default: break;
  }
  return parts.filter(Boolean).join(' · ').slice(0, 200);
}

// ── 017: the plan in one line, and how the page applies it ─────────────────
//
// `planLineOf` is the Tell-the-story page's "the plan, in one line": built in code
// from the kept drafts (their actions, fictional names, places, times) — never
// model text (a new member is "someone new"; their name shows verbatim on the
// card). `promptBundles` splits the drafts the page applies into ≤ BUNDLE_MAX
// bundles (one preview / apply each) and the bookmarks that apply after them.
export const PLAN_LINE_MAX = 240;

const listOf = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function dayOf(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// A scene's (or goal's) time in words: "Sat 31 Oct 10:30", "in 40 min", or null.
function whenWords(action, tz, key = 'when') {
  if (key === 'when' && Number.isSafeInteger(action.startAt)) return [dayOf(dateKey(action.startAt, tz)), hm(action.startAt, tz)].filter(Boolean).join(' ');
  const w = action[key];
  if (!isObj(w)) return null;
  if (finite(w.inMinutes)) return `in ${Math.max(directorMod.IN_MINUTES_MIN, w.inMinutes)} min`;
  return [dayOf(w.date), typeof w.time === 'string' ? w.time : null].filter(Boolean).join(' ') || null;
}

function phraseOf(action, state, tz) {
  const who = (ids) => (Array.isArray(ids) ? ids : []).map(id => nameOf(state, id)).filter(Boolean);
  const at = (p) => (p ? ` at ${p}` : '');
  switch (action.kind) {
    case 'scene': {
      if (action.shape === 'outing' || action.shape === 'visit') {
        const people = [...who(action.castIds), ...(action.newCast ? ['someone new'] : [])];
        const place = action.placeId ? placeNameOf(state, action.placeId) : action.newPlace ? 'a new place' : 'a real place you pick';
        const time = whenWords(action, tz);
        return `${time ? `${time}: ` : ''}${action.shape === 'visit' ? 'a visit' : 'an outing'}${at(place)}${people.length ? ` with ${listOf(people)}` : ''}${finite(action.minutes) ? ` (${action.minutes} min)` : ''}`;
      }
      if (action.shape === 'new_cast') return 'someone new comes into his life';
      if (action.shape === 'cast.beat') return `news from ${nameOf(state, action.castId) ?? 'someone he knows'}`;
      if (action.shape === 'arc.start') return `a new ${String(action.category ?? 'story').replace(/_/g, ' ')} storyline`;
      return `a ${String(action.shape ?? 'scene').replace(/[._]/g, ' ')}`;
    }
    case 'schedule': return `${dayOf(action.date) ?? action.date}: his day is rearranged`;
    case 'schedule.clear': return 'a schedule change is cleared';
    case 'wake': return `he is woken${typeof action.at === 'string' ? ` at ${action.at}` : ' now'}`;
    case 'text': return `${action.from === 'them' ? `${nameOf(state, action.castId) ?? 'someone'} texts him` : `he texts ${nameOf(state, action.castId) ?? 'someone'}`}${typeof action.at === 'string' ? ` at ${action.at}` : ''}${action.chat === 'long' ? ' and they chat for a while' : ''}`;   // 019
    case 'weather': {
      const from = whenWords(action, tz, 'from');
      return `${String(action.weatherKind ?? 'different').replace(/_/g, ' ')} weather${from ? ` from ${from}` : ''}`;
    }
    case 'weather.end': return 'the set weather ends';
    case 'goal': {
      const people = who([action.castId]);
      return `a goal to ${String(action.goalKind ?? 'do something')}${people.length ? ` with ${people[0]}` : ''} by ${dayOf(action.toDate) ?? action.toDate}`;
    }
    case 'goal.cancel': return 'a goal is cancelled';
    case 'mood': return `a ${String(action.preset ?? 'different').replace(/_/g, ' ')} mood`;
    case 'health': return action.change === 'well' ? 'he gets better' : `he falls sick${finite(action.days) ? ` for ${action.days} days` : ''}`;
    case 'career': return `a job change (${String(action.change ?? 'change').replace(/_/g, ' ')})`;
    case 'money': return `money: ${String(action.mode ?? 'change')}${finite(action.amount) ? ` ${action.amount}` : ''}`;
    case 'home': return 'he moves home';
    case 'cast.metrics': return `${nameOf(state, action.castId) ?? 'someone'} feels closer or further`;
    case 'cast.edit': case 'cast.history': return `${nameOf(state, action.castId) ?? 'someone'}'s story is updated`;
    case 'cast.depart': return `${nameOf(state, action.castId) ?? 'someone'} leaves his life`;
    case 'cast.return': return `${cleanItem(state.story?.departed?.[action.castId]?.name, 40) || 'someone'} comes back`;
    case 'decision.pick': return 'he makes up his mind on a plan';
    case 'outcome': return `a plan turns out ${String(action.outcome ?? '').replace(/_/g, ' ')}`.trim();
    case 'bookmark': return 'a bookmark of the moment';
    default: return 'a change to his world';
  }
}

/** The plan in one sentence (≤ PLAN_LINE_MAX) from the drafts, in draft order → string | null. */
export function planLineOf(drafts, state, now, tz) {
  void now;
  const list = (Array.isArray(drafts) ? drafts : []).filter(d => isObj(d?.action));
  if (!list.length || !isObj(state)) return null;
  const zone = resolveTimezone(tz);
  const phrases = list.map(d => cleanItem(phraseOf(d.action, state, zone), 160)).filter(Boolean);
  if (!phrases.length) return null;
  let line = '';
  for (let i = 0; i < phrases.length; i++) {
    const rest = phrases.length - i - 1;
    const sep = i === 0 ? '' : '; ';
    const tail = rest ? `; and ${rest} more change${rest === 1 ? '' : 's'}` : '';
    if ((line + sep + phrases[i] + tail).length + 1 > PLAN_LINE_MAX) {
      const left = phrases.length - i;
      line = i === 0 ? phrases[0].slice(0, PLAN_LINE_MAX - 2) : `${line}; and ${left} more change${left === 1 ? '' : 's'}`;
      break;
    }
    line += sep + phrases[i];
  }
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`.slice(0, PLAN_LINE_MAX);
}

const BOOKMARK_KINDS = new Set(['bookmark', 'bookmark.remove']);

/**
 * How the page applies the kept drafts → { bundles: [[draft index…] ≤ BUNDLE_MAX],
 * after: [bookmark indexes], waiting: [indexes with a status (needs_pick, too_soon …)] }.
 * Main drafts first in draft order, then side drafts that can ride in a bundle; a
 * bookmark (never in a bundle) applies after every bundle succeeded; a draft that
 * plans to nothing (no events, no status) is left out.
 */
export function promptBundles(drafts) {
  const list = (Array.isArray(drafts) ? drafts : []).filter(d => isObj(d?.action) && Number.isSafeInteger(d.index));
  const waiting = list.filter(d => !!d.status).map(d => d.index);
  const ready = list.filter(d => !d.status && (d.events ?? 1) > 0);
  const after = ready.filter(d => BOOKMARK_KINDS.has(d.action.kind)).map(d => d.index);
  const ride = ready.filter(d => !BOOKMARK_KINDS.has(d.action.kind) && !directorMod.BUNDLE_EXCLUDED.has(d.action.kind));
  const order = [...ride.filter(d => d.side !== true), ...ride.filter(d => d.side === true)].map(d => d.index);
  const bundles = [];
  for (let i = 0; i < order.length; i += directorMod.BUNDLE_MAX) bundles.push(order.slice(i, i + directorMod.BUNDLE_MAX));
  return { bundles, after, waiting };
}

// ── Ledger reads (strict: a read error = cap reached) ──────────────────────

async function usageReader() {
  return deps.getUsageByCaller ?? (await import('../../brain/usage.js')).getUsageByCallerStrict;
}

/** director.prompt calls today (local day) — null on any read error. */
export async function promptCallsToday(now, tz) {
  try {
    const rows = (await usageReader())(PROMPT_CALLER, dayStart(now, resolveTimezone(tz)));
    if (!Array.isArray(rows)) return null;
    return rows.filter(r => r?.caller === PROMPT_CALLER).reduce((s, r) => s + (Number(r?.calls) || 0), 0);
  } catch {
    return null;
  }
}

/** { monthUsd, capUsd, today, dayCap } for /api/arcs/status (null fields on a read error). */
export async function promptBudgetStatus(now, tz) {
  const usd = await arcsCallerSpend(now, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [PROMPT_CALLER] });
  return {
    promptMonthUsd: finite(usd) ? usd : null,
    promptCapUsd: Number(config.arcs?.promptBudgetUsd ?? 0.5),
    promptToday: await promptCallsToday(now, tz),
    promptDayCap: Number(config.arcs?.promptMaxPerDay ?? 20),
  };
}

// ── The run ───────────────────────────────────────────────────────────────

function tzOf(state) {
  return resolveTimezone(state?.world?.timezone ?? deps.world?.timezone ?? config.timezone);
}

/** Pre-call gates after the wish → throws a StoryError, or { today, cap }. */
async function gates(now, tz) {
  const cap = Number(config.arcs?.promptMaxPerDay ?? 20);
  if (!(cap > 0)) throw err('refused', 'prompt_off');
  const today = await promptCallsToday(now, tz);
  if (today === null || today >= cap) throw err('rate', 'rate');
  const spentOwn = await arcsCallerSpend(now, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [PROMPT_CALLER] });
  if (!(spentOwn < Number(config.arcs?.promptBudgetUsd ?? 0.5))) throw err('refused', 'caller_cap');
  // 015: the continuity story read shares the arcs cap (life.arcs.* + director.prompt + director.continuity).
  const spentAll = await arcsCallerSpend(now, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: ['life.arcs.', PROMPT_CALLER, 'director.continuity'] });
  if (!(spentAll < Number(config.arcs?.mindBudgetUsd ?? 1))) throw err('refused', 'caller_cap');
  if (typeof deps.mindBudgetOk !== 'function') throw err('refused', 'budget');
  let b;
  try { b = await deps.mindBudgetOk('think'); } catch { b = null; }
  if (b?.ok !== true) throw err('refused', b?.reason === 'unpriced' ? 'unpriced' : 'budget');
  return { today, cap };
}

/**
 * One prompt. Pre-call refusals throw StoryError (invalid ← the wish; rate ← the
 * day cap or an unreadable ledger; conflict busy; refused ← names_unavailable |
 * prompt_off | caller_cap | budget | unpriced). After the call it resolves
 * { status: ok|invalid_output|model_failed|skipped, reason?, drafts, dropped,
 *   cantDo, model, fellBack, usage:{today, cap}, length }.
 */
export async function runPrompt(wish, { by = 'owner' } = {}) {
  void by;
  const started = Date.now();
  const state = deps.getState?.();
  if (!isObj(state) || state.genesisAt === null || state.genesisAt === undefined) throw err('not_running');
  if (typeof wish !== 'string' || !wish.trim()) throw err('invalid', 'bad_wish');
  if (wish.length > WISH_MAX) throw err('invalid', 'too_long');
  let knownNames;
  try {
    knownNames = deps.knownNames();
    if (!Array.isArray(knownNames)) throw new Error('names');
  } catch {
    throw err('refused', 'names_unavailable');
  }
  const castNames = [...(state.cast instanceof Map ? state.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  const problem = wishProblem(wish, knownNames, castNames);
  if (problem) throw err('invalid', problem);
  if (busy) throw err('conflict', 'busy');
  busy = true;
  try {
    const now = Math.floor(deps.now());
    const tz = tzOf(state);
    const { today, cap } = await gates(now, tz);
    const { model, check } = buildCatalogue(state, deps.world, now, tz);
    const persona = deps.persona ?? getPersona();
    const who = `You are helping the owner direct the life of ${cleanItem(persona?.name, 40) || 'the character'} (${cleanItem(persona?.voiceDescriptor, 120) || 'an ordinary person'}).`;
    const user = `${who}\n${fence(JSON.stringify(model), { kind: 'state', cap: STATE_MAX })}\n${fence(wish, { kind: 'wish', cap: WISH_MAX })}`;
    const call = deps.callRole ?? (await import('../../brain/llm.js')).callRole;
    const base = { drafts: [], dropped: [], cantDo: [], model: null, fellBack: false, usage: { today: today + 1, cap }, length: wish.length };
    let res;
    try {
      res = await call('mind', PROMPT_CHARTER, user, { caller: PROMPT_CALLER, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: CALL_TIMEOUT_MS });
    } catch {
      res = null;
    }
    // Opus drafts the action, not the prose. If that call is refused and the wish
    // itself asked for something sexual, try once on desire. A second refusal
    // stays the usual prompt error. Never send:true.
    const promptFailed = !res || res.status === 'error' || res.skipped || typeof res.text !== 'string' || !res.text.trim();
    if (promptFailed && wishSexual(wish)) {
      try {
        const retry = await call('desire', PROMPT_CHARTER, user, { caller: PROMPT_CALLER, maxTokens: MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS, noFallback: true });
        if (retry && !retry.skipped && retry.status !== 'error' && typeof retry.text === 'string' && retry.text.trim()) res = retry;
      } catch { /* keep the first failure */ }
    }
    const meta = { model: typeof res?.model === 'string' ? res.model.slice(0, 80) : null, fellBack: !!res?.fellBack };
    let out;
    if (!res || res.status === 'error') out = { ...base, ...meta, status: 'model_failed' };
    else if (res.skipped) out = { ...base, ...meta, status: 'skipped', reason: ['budget', 'disabled', 'no_key'].includes(res.skipped) ? res.skipped : 'budget' };
    else if (typeof res.text !== 'string' || !res.text.trim()) out = { ...base, ...meta, status: 'invalid_output' };
    else {
      const v = validatePromptOutput(res.text, check, VOCAB);
      out = v.invalid ? { ...base, ...meta, status: 'invalid_output' } : { ...base, ...meta, status: 'ok', ...dryPlan(dropUnrequested(v, wish), state, now, tz, knownNames) };
      if (out.status === 'ok') {
        out.venueLookups = await fillVenueDrafts(out, { knownNames, state });   // 014 geo (A6b)
        flagLooksReal(out, wish);
        holdSideDrafts(out);   // last: venue lookups and the looks-real net change status / batchable
        // 017: each draft's phrase, the plan in one line, and the default apply plan (all code-built).
        for (const d of out.drafts) d.phrase = cleanItem(phraseOf(d.action, state, resolveTimezone(tz)), 160);
        out.planLine = planLineOf(out.drafts, state, now, tz);
        out.bundlePlan = promptBundles(out.drafts);
      }
    }
    // Codes only: each dropped draft's index, kind and reason (never the wish or a model string).
    deps.logger.info({ evt: 'arcs.director.prompt', status: out.status, drafts: out.drafts.length, dropped: out.dropped.length,
      drops: dropCodes(out.dropped), ms: Date.now() - started }, 'story: director prompt');
    return out;
  } finally {
    busy = false;
  }
}

// Each draft through the planner's pure plan() (reads only): a thrown StoryError
// drops it with its reason; refusals and warnings stay on the draft. An outing he
// can't make in time (too_soon, with `earliestAt` when there is a start he can
// make) or can't reach at all (no_route) stays a card with that status: never
// moved by itself, never in APPLY ALL — the card offers MOVE TO EARLIEST.
export const TIMING_STATUSES = Object.freeze(['too_soon', 'no_route']);

function dryPlan(v, state, now, tz, knownNames) {
  const drafts = [];
  const dropped = [...v.dropped];
  const target = directorMod.tonightTarget(state, now, tz);
  for (const d of v.drafts) {
    const kind = d.action.kind;
    // 014: a draft waiting for a venue pick (a schedule range, an outing's place) is
    // shown, never planned yet: geo's post-step looks it up (fillVenueDrafts).
    if (d.status === 'needs_venue' || d.status === 'needs_pick') {
      drafts.push({ index: d.index, action: d.action, why: d.why, summary: summaryOf(d.action, state, now, tz, { target, venue: true }),
        texts: textsOf(d.action), refusals: [], warnings: [], events: 0, batchable: false, reviewReason: 'target_resolved',
        status: d.status, venues: d.venues, ...sideOf(d) });
      continue;
    }
    let planned;
    try {
      planned = directorMod.plan(d.action, state, { now, knownNames });
    } catch (e) {
      if (e?.code === 'refused' && TIMING_STATUSES.includes(e.reason)) {
        const at = e.reason === 'too_soon' && Number.isSafeInteger(e.earliestAt) && e.earliestAt > now ? e.earliestAt : null;
        drafts.push({ index: d.index, action: d.action, why: d.why, summary: summaryOf(d.action, state, now, tz, { target }),
          texts: textsOf(d.action), refusals: [], warnings: [], events: 0, batchable: false, reviewReason: e.reason,
          status: e.reason, earliestAt: at, ...sideOf(d) });
        continue;
      }
      const reason = typeof e?.reason === 'string' && /^[a-z][A-Za-z0-9_]{0,39}$/.test(e.reason) ? e.reason
        : (typeof e?.code === 'string' && /^[a-z_]{1,20}$/.test(e.code) ? e.code : 'bad_field');
      dropped.push({ index: d.index, kind, reason, ...sideOf(d) });
      continue;
    }
    const b = batchableOf(d.action, planned);
    // The looks-real safety net (a planner continuity warning) shows on the card too.
    const looksReal = (planned.continuity?.warnings ?? []).some(w => w?.code === directorMod.LOOKS_REAL_PLACE);
    drafts.push({
      index: d.index, action: d.action, why: d.why,
      summary: summaryOf(d.action, state, now, tz, { target }),
      texts: textsOf(d.action),
      refusals: planned.refusals.map(r => ({ reason: r.reason, target: r.target ?? null })),
      warnings: [...(looksReal ? [directorMod.LOOKS_REAL_TEXT] : []), ...planned.warnings].slice(0, 8),
      events: planned.events.filter(e => e.type !== 'director.action').length,
      ...b, ...sideOf(d),
    });
  }
  for (const x of dropped) if (!PROMPT_DROP_REASONS.includes(x.reason) && !/^[a-z][A-Za-z0-9_]{0,39}$/.test(x.reason)) x.reason = 'bad_field';
  return { drafts, dropped: dropped.sort((a, b) => a.index - b.index), cantDo: v.cantDo };
}

const sideOf = (d) => (d?.side === true ? { side: true } : {});

// ── Side drafts: a bookmark only when asked, never an orphan ──────────────
//
// A bookmark is a "remember this moment" marker: the model adds one to a scene
// unasked, and alone it changes nothing — so the wish must ask for it (bookmark,
// remember this, mark this, save this moment), else it is dropped `unrequested`.
const BOOKMARK_WISH_RE = /\bbook\s?mark|\bremember\s+(?:this|that|it)\b|\bmark\s+(?:this|that|it|the\s+moment)\b|\bsave\s+(?:this|that|the)\s+(?:moment|day|night|evening)\b/i;

export function asksForBookmark(wish) {
  return typeof wish === 'string' && BOOKMARK_WISH_RE.test(wish);
}

/** Validator output → the same, minus model bookmarks the wish never asked for. */
export function dropUnrequested(v, wish) {
  if (asksForBookmark(wish) || !Array.isArray(v?.drafts)) return v;
  const keep = [];
  const dropped = [...(v.dropped ?? [])];
  for (const d of v.drafts) {
    if (d.action?.kind === 'bookmark') dropped.push({ index: d.index, kind: 'bookmark', reason: 'unrequested', side: true });
    else keep.push(d);
  }
  return { ...v, drafts: keep, dropped };
}

/**
 * The no-orphans rule. A side draft (a bookmark, or one the model marked
 * `accompanies`) belongs to the wish's main drafts — every other draft, kept or
 * dropped. It carries `dependsOn` (those indexes) and, when any main was dropped,
 * waits for a venue pick, starts too soon / has no route, or is not batchable
 * itself, it is held: `batchable:false`, `reviewReason:'depends_on_main'`. The
 * page applies a side draft only once every main in `dependsOn` is applied on that
 * page (a dropped main never is), and APPLY ALL takes the mains first. A wish
 * with side drafts only (an asked-for bookmark) is unchanged.
 */
export function holdSideDrafts(out) {
  if (!Array.isArray(out?.drafts)) return;
  const mains = out.drafts.filter(d => d?.side !== true);
  const mainDrops = (Array.isArray(out.dropped) ? out.dropped : []).filter(x => x?.side !== true);
  if (!mains.length && !mainDrops.length) return;
  const dependsOn = [...mains.map(d => d.index), ...mainDrops.map(x => x.index)]
    .map(i => (Number.isSafeInteger(i) ? i : -1)).sort((a, b) => a - b);
  const held = mainDrops.length > 0 || mains.some(d => !!d.status || d.batchable !== true);
  for (const d of out.drafts) {
    if (d?.side !== true) continue;
    d.dependsOn = dependsOn;
    if (held) { d.batchable = false; d.reviewReason = 'depends_on_main'; }
  }
}

// ── 014 geo (plan §A6b): a draft that names a real venue → candidates to pick ──
//
// The validator marks a draft that names a venue — a schedule range, or a scene
// outing's place — with `status:'needs_venue'` and `venues:[{range, query:{name,
// area}}]` (an outing's slot is `{field:'place', query}`). Each query
// passes the wish checks (JID / phone / real name), the venue charset and the
// blocklist (else the draft is dropped, `bad_venue`), then ONE server lookup
// (≤ 3 per prompt) fills `venues[k].candidates` (opaque ids; the model never
// writes coordinates) and the draft becomes `needs_pick`. A lookup failure or
// no geo leaves it `needs_venue` ("pick a known place"). → lookups made.
export const VENUE_LOOKUPS_MAX = 3;

export async function fillVenueDrafts(out, { knownNames = [], state = null } = {}) {
  let lookups = 0;
  if (!Array.isArray(out?.drafts)) return lookups;
  const castNames = [...(state?.cast instanceof Map ? state.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  const keep = [];
  for (const d of out.drafts) {
    if (d?.status !== 'needs_venue' || !Array.isArray(d.venues)) { keep.push(d); continue; }
    let bad = false;
    for (const v of d.venues) {
      const name = typeof v?.query?.name === 'string' ? v.query.name : '';
      const area = typeof v?.query?.area === 'string' ? v.query.area : '';
      const q = `${name}${area ? ` ${area}` : ''}`.trim();
      if (!name || name.length > 60 || area.length > 40 || wishProblem(q, knownNames, castNames)) { bad = true; break; }
      let p = null;
      try { p = deps.geo?.venueQueryProblem?.(name, area) ?? null; } catch { p = 'bad_venue'; }
      if (p) { bad = true; break; }
    }
    if (bad) {
      out.dropped = [...(out.dropped || []), { index: d.index ?? null, kind: d.action?.kind ?? null, reason: 'bad_venue', ...sideOf(d) }];
      continue;
    }
    let all = true;
    for (const v of d.venues) {
      if (lookups >= VENUE_LOOKUPS_MAX || typeof deps.geo?.search !== 'function') { all = false; break; }
      lookups += 1;
      try {
        const q = `${v.query.name}${v.query.area ? ` ${v.query.area}` : ''}`.trim();
        const res = await deps.geo.search(q, { limit: 5 });
        v.candidates = (Array.isArray(res?.candidates) ? res.candidates : []).slice(0, 5)
          .map(c => ({ id: c.id, name: c.name, kind: c.kind, area: c.area ?? null, distKmFromHome: c.distKmFromHome ?? null, flags: c.flags ?? [] }));
        if (!v.candidates.length) all = false;
      } catch {
        all = false;
      }
    }
    if (all) d.status = 'needs_pick';
    keep.push(d);
  }
  out.drafts = keep;
  return lookups;
}

// ── Drop codes and the looks-real safety net ───────────────────────────────

const DROP_CODE_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;

/** The dropped drafts as codes for the info log: [{index, kind, reason}] (≤ 16). */
export function dropCodes(dropped) {
  return (Array.isArray(dropped) ? dropped : []).slice(0, 16).map(x => ({
    index: Number.isSafeInteger(x?.index) ? x.index : null,
    kind: typeof x?.kind === 'string' && directorMod.ACTION_KINDS.includes(x.kind) ? x.kind : null,
    reason: typeof x?.reason === 'string' && DROP_CODE_RE.test(x.reason) ? x.reason : 'bad_field',
  }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The name the owner typed in the wish, as a proper name: whole words, any case,
// written there with a capital first letter ("Corner Bistro", not "a cafe"), ≥ 3 letters.
function ownerTyped(name, wish) {
  const n = String(name ?? '').trim();
  if (n.length < 3 || typeof wish !== 'string') return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(n)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  for (const m of wish.matchAll(re)) if (/^\p{Lu}/u.test(m[2])) return true;
  return false;
}

/**
 * The prompt's half of the looks-real safety net (the planner's half — a known
 * venue name or venue area — is director.js `looks_real_place`): an invented
 * place (an outing's newPlace, a new_place scene) named as the owner wrote it in
 * the wish, or like a venue looked up in this run, is probably the real place
 * the owner meant → the warning on the card, and never in APPLY ALL.
 */
export function flagLooksReal(out, wish) {
  if (!Array.isArray(out?.drafts)) return;
  const looked = out.drafts.flatMap(d => (Array.isArray(d?.venues) ? d.venues : []))
    .flatMap(v => [v?.query?.name, ...(Array.isArray(v?.candidates) ? v.candidates.map(c => c?.name) : [])])
    .filter(n => typeof n === 'string').map(n => normalizeName(n));
  for (const d of out.drafts) {
    const a = d?.action;
    if (a?.kind !== 'scene') continue;
    const name = a.shape === 'new_place' ? a.name : a.newPlace?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const norm = normalizeName(name);
    if (!ownerTyped(name, wish) && !looked.some(n => n.replace(/ /g, '').length >= 4 && ` ${norm} `.includes(` ${n} `))) continue;
    if (!(d.warnings ?? []).includes(directorMod.LOOKS_REAL_TEXT)) d.warnings = [directorMod.LOOKS_REAL_TEXT, ...(d.warnings ?? [])].slice(0, 8);
    d.batchable = false;
    d.reviewReason = 'continuity';
  }
}

export const __test = { gates, planTimes };
