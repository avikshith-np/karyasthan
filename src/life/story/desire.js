// Urge and the heat register for in-world texts and private outings.
// Pure: no DB, no model, no clock read of its own. Urge is computed at read
// time (urgeValue in vitals.js). It is not mood.arousal and it is not stored
// on the vitals object, so a log from before this change folds as it did.
//
// A relationship does not cap the rise. Family, the manager, a real person,
// a heavy stretch, sickness, low trust, high tension, or a persona under 21
// stay tame. Minor-age framing and non-consent fail closed on every register.
import { urgeValue } from '../vitals.js';
import { sliderValue } from './controls.js';
import { activeRomance, metricsOf, romanceEligible } from './romance.js';

// Real WhatsApp prompts get this instead of the graphic transcript. The public
// site and the dashboard publish the words themselves (owner, 2026-10-31).
export const PHONE_GIST = 'you were texting; it got heated';

const LOVE_STAGES = new Set(['interested', 'talking', 'dating', 'committed', 'engaged', 'married']);
const EXPLICIT_LOVE = new Set(['talking', 'dating', 'committed', 'engaged', 'married']);
const PARTNERED = new Set(['dating', 'committed', 'engaged', 'married']);
const SOME_PASSION = 0.2;
const LUST_PASSION = 0.45;
const LUST_CLOSENESS = 0.35;

// Explicit sexual content. Plain swearing ("fuck, I'm late") is not on it.
// "slept together" / "made love" count; "the kids" does not.
const EXPLICIT_RES = [
  /\b(?:cock|dick|penis|pussy|cunt|vagina|clit(?:oris)?|tits|titties|boobs|nipples?|genitals?|balls\s+deep)\b/i,
  /\b(?:blow\s*-?\s*jobs?|hand\s*-?\s*jobs?|rim\s*-?\s*jobs?|cumm?(?:ing|s|shot)?|jizz|orgasms?|masturbat\w*|jerk(?:ing)?\s+off|wank\w*|fingering)\b/i,
  /\b(?:sex|sexting|nudes?|naked\s+(?:pics?|photos?)|porn\w*|onlyfans|horny|anal|penetrat\w*|erections?|hard[\s-]?on|wet\s+for\s+(?:you|me))\b/i,
  /\b(?:fuck|fucking|screw|ride|suck)\s+(?:me|you|him|her|it)\s+(?:hard|good|all\s+night)\b/i,
  /\b(?:69|bdsm|threesome|deepthroat)\b/i,
  /\b(?:slept\s+together|made\s+love|had\s+sex)\b/i,
];

// Age and school framing. Bare "kids" / "the kids" is not a match.
const MINOR_RES = [
  /\b(?:underage|pre-?teen|school-?girl|school-?boy|jail-?bait|loli|lolita|shota|pedo(?:phile)?|child\s*porn)\b/i,
  /\b(?:1[0-7]|[0-9])\s*[- ]?(?:years?\s*old|yo|y\/o)\b/i,
  /\b(?:teen(?:ager)?s?|minors?)\b(?:\s+\w+){0,3}\s+\b(?:sex|nude|naked|fuck)/i,
];

const NONCONSENT_RES = [
  /\b(?:rap(?:e|ed|ing|ist)|non-?consensual|against\s+(?:her|his|their)\s+will)\b/i,
  /\bforced\s+(?:her|him|them)\b/i,
];

const FLIRT_RES = [
  /\b(?:flirt\w*|horny|sexy|nude|nudes|thirsty|babe|come\s+over|miss\s+you)\b/i,
  /[😉😘😍🥵😏💋]/,
];

const SEXUAL_WISH_RE = /\b(?:sex|sexy|sexual|horny|naughty|nude|naked|sext|make\s+love|slept\s+together|hook\s*-?\s*up)\b/i;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function norm(text) {
  return String(text ?? '').normalize('NFKC').replace(/[​-‍⁠­]/g, '');
}

/** 'explicit' | 'minor' | 'nonconsent' | null. */
export function contentProblem(text) {
  const s = norm(text);
  if (!s) return null;
  if (MINOR_RES.some(re => re.test(s))) return 'minor';
  if (NONCONSENT_RES.some(re => re.test(s))) return 'nonconsent';
  if (EXPLICIT_RES.some(re => re.test(s))) return 'explicit';
  return null;
}

/**
 * Heat ceiling for a turn. Explicit words pass only when `register` is
 * 'explicit'. Minor-age framing and non-consent fail on every register.
 * One argument (or any register other than explicit) keeps the old ceiling.
 */
export function heatProblem(text, register = 'tame') {
  const p = contentProblem(text);
  if (p === 'minor' || p === 'nonconsent') return p;
  if (p === 'explicit' && register !== 'explicit') return 'explicit';
  return null;
}

/** True when the words themselves are graphic (the public-site backstop). */
export function explicitHeat(text) {
  return contentProblem(text) === 'explicit';
}

/** Heat stored on the event. An explicit register with tame words is suggestive, so urge does not drop. */
export function heatOf({ text, register, tone } = {}) {
  if (register === 'explicit' && contentProblem(text) === 'explicit') return 'explicit';
  if (register === 'explicit') return 'suggestive';
  if (tone === 'flirty' || tone === 'teasing' || tone === 'naughty') return 'suggestive';
  return 'tame';
}

export function personaAdult(age) {
  const n = Number(age);
  return Number.isFinite(n) && n >= 21;
}

/** Active romance partner from `interested` up, or null. */
export function loveInterest(state) {
  const rom = activeRomance(state);
  const id = rom?.partnerId;
  if (!id || !LOVE_STAGES.has(rom.arc?.stage)) return null;
  if (!romanceEligible(state, id)) return null;
  return id;
}

/** Up to two romance-eligible people who are not the partner, highest passion first. */
export function lustInterests(state) {
  const partner = loveInterest(state);
  const cast = state?.cast;
  if (!(cast instanceof Map)) return [];
  const out = [];
  for (const id of cast.keys()) {
    if (id === partner || !romanceEligible(state, id)) continue;
    const m = metricsOf(state, id);
    if (m.passion >= LUST_PASSION && m.closeness >= LUST_CLOSENESS) out.push({ id, passion: m.passion });
  }
  out.sort((a, b) => b.passion - a.passion || (a.id < b.id ? -1 : 1));
  return out.slice(0, 2).map(x => x.id);
}

/** 'love' | 'lust' | null. */
export function interestKind(state, castId) {
  if (!castId) return null;
  if (loveInterest(state) === castId) return 'love';
  if (lustInterests(state).includes(castId)) return 'lust';
  return null;
}

/**
 * 'tame' | 'suggestive' | 'explicit', chosen before the model speaks.
 * ctx: { age, urge, private, heavy, sick, realPerson, tone, cooled }.
 * Owner tone 'naughty' forces explicit once the hard gates pass.
 */
export function registerOf(state, castId, ctx = {}) {
  if (!personaAdult(ctx.age)) return 'tame';
  if (ctx.realPerson || ctx.heavy || ctx.sick) return 'tame';
  if (!romanceEligible(state, castId)) return 'tame';
  const m = metricsOf(state, castId);
  if (m.trust < 0.35 || m.tension > 0.65) return 'tame';
  if (ctx.tone === 'naughty') return 'explicit';
  const kind = interestKind(state, castId);
  const urge = finite(ctx.urge) ? ctx.urge : 0;
  let reg = 'tame';
  if (kind) {
    const stage = activeRomance(state)?.arc?.stage;
    const loveOk = kind === 'love' && EXPLICIT_LOVE.has(stage);
    if (urge < 40) reg = 'suggestive';
    else if ((loveOk || kind === 'lust') && urge >= 55 && ctx.private) reg = 'explicit';
    else reg = 'suggestive';
  } else if (m.passion >= SOME_PASSION) {
    reg = 'suggestive';
  }
  if (ctx.cooled && reg === 'explicit') return 'suggestive';
  return reg;
}

/**
 * Face-to-face register. Explicit only for exactly one eligible love or lust
 * interest, mode full, not a first meeting, outcome well or fine, private place.
 * ctx: { age, urge, castIds, mode, firstMeet, outcome, privatePlace, heavy, sick, realPerson }.
 */
export function sceneRegister(state, ctx = {}) {
  if (ctx.mode !== 'full' || ctx.realPerson) return 'tame';
  if (!personaAdult(ctx.age) || ctx.heavy || ctx.sick) return 'tame';
  const ids = Array.isArray(ctx.castIds) ? ctx.castIds : [];
  if (ids.length !== 1) return 'tame';
  const id = ids[0];
  if (!romanceEligible(state, id)) return 'tame';
  const m = metricsOf(state, id);
  if (m.trust < 0.35 || m.tension > 0.65) return 'tame';
  const kind = interestKind(state, id);
  if (!kind) return m.passion >= SOME_PASSION ? 'suggestive' : 'tame';
  if (ctx.firstMeet) return 'suggestive';
  if (ctx.outcome === 'flat' || ctx.outcome === 'badly') return 'suggestive';
  const urge = finite(ctx.urge) ? ctx.urge : 0;
  if (urge < 40) return 'suggestive';
  const stage = activeRomance(state)?.arc?.stage;
  const loveOk = kind === 'love' && EXPLICIT_LOVE.has(stage);
  if ((loveOk || kind === 'lust') && urge >= 55 && ctx.privatePlace && (ctx.outcome === 'well' || ctx.outcome === 'fine')) return 'explicit';
  return 'suggestive';
}

/** True when he is dating or further along with someone else. A note, not a refusal. */
export function outsidePartner(state, castId) {
  const rom = activeRomance(state);
  if (!rom?.partnerId || rom.partnerId === castId) return false;
  return PARTNERED.has(rom.arc?.stage);
}

/**
 * Draw weight for an organic explicit-leaning text. The partner is 1.
 * Someone else stays in the draw: smaller, rising with urge, passion and drama,
 * shrinking as commitment to the partner rises. Never zero when they qualify.
 */
export function organicWeight(state, castId, { urge = 0, drama = 0.5 } = {}) {
  const kind = interestKind(state, castId);
  if (!kind) return 0;
  if (kind === 'love') return 1;
  const m = metricsOf(state, castId);
  const partner = loveInterest(state);
  const commitment = partner ? metricsOf(state, partner).commitment : 0;
  const u = clamp01(((finite(urge) ? urge : 0) - 55) / 45);
  const d = clamp01(finite(drama) ? drama : 0.5);
  const w = (0.15 + 0.5 * u) * (0.4 + clamp01(m.passion)) * (0.5 + d) * (1 - 0.75 * clamp01(commitment));
  return Math.max(0.02, Math.round(w * 1000) / 1000);
}

/**
 * Who an organic text prefers when urge ≥ 55. null → the caller keeps today's
 * closest-friend roll. `roll` is in [0, 1).
 */
export function organicPick(state, { urge = 0, drama = 0.5, roll = 0 } = {}) {
  if (!(urge >= 55)) return null;
  const ids = [];
  const love = loveInterest(state);
  if (love) ids.push(love);
  for (const id of lustInterests(state)) if (!ids.includes(id)) ids.push(id);
  const cands = ids.map(id => ({ id, w: organicWeight(state, id, { urge, drama }) })).filter(c => c.w > 0);
  if (!cands.length) return null;
  const sum = cands.reduce((a, c) => a + c.w, 0);
  let x = (finite(roll) ? roll : 0) * sum;
  for (const c of cands) {
    x -= c.w;
    if (x <= 0) return c.id;
  }
  return cands[cands.length - 1].id;
}

/** Urge 0–100 at `now`, from the projection. Stage is not an input. */
export function urgeNow(state, { now, tz, sawInterest = false } = {}) {
  const at = finite(now) ? now : (finite(state?.at) ? state.at : 0);
  const kind = state?.activity?.kind;
  const asleep = kind === 'sleep' || kind === 'asleep';
  const v = state?.vitals ?? {};
  const appetite = sliderValue('romanceAppetite', state);
  return urgeValue({
    now: at,
    tz,
    asleep,
    lastReleaseAt: finite(state?.story?.desire?.lastReleaseAt) ? state.story.desire.lastReleaseAt : null,
    stress: finite(v.stress) ? v.stress : 0,
    socialBattery: finite(v.socialBattery) ? v.socialBattery : 100,
    romanceAppetite: appetite == null ? 0.5 : appetite,
    sawInterest: sawInterest === true,
  });
}

/** True when any of these cast ids is a love or lust interest, or a scene with one ended in the last day. */
export function sawInterest(state, castIds, at) {
  const ids = new Set(Array.isArray(castIds) ? castIds : []);
  const scenes = state?.story?.scenes;
  if (scenes && typeof scenes === 'object') {
    for (const sc of Object.values(scenes)) {
      const when = sc?.endedAt ?? sc?.at;
      if (!finite(when) || !finite(at) || at - when > 86400 || at < when) continue;
      for (const id of sc?.castIds ?? []) ids.add(id);
    }
  }
  for (const id of state?.activity?.withCast ?? []) ids.add(id);
  for (const id of ids) if (interestKind(state, id)) return true;
  return false;
}

export function urgeBand(urge) {
  if (!finite(urge) || urge < 40) return 'low';
  if (urge < 55) return 'wound up';
  return 'high';
}

/** A flirtatious DM, for the decision engine. No model call. */
export function looksFlirtatious(text) {
  return FLIRT_RES.some(re => re.test(String(text ?? '')));
}

/** The owner's wish asked for something sexual (the one Director-prompt retry). */
export function wishSexual(text) {
  return SEXUAL_WISH_RE.test(String(text ?? ''));
}

/**
 * Bounded utility added to a go / attend option spent with a love or lust
 * interest when urge is high. 0 at 55, about 2 at 100. Never a forced commit.
 */
export function urgeUtility(state, castIds, { at } = {}) {
  const ids = Array.isArray(castIds) ? castIds : [];
  if (!ids.some(id => interestKind(state, id))) return 0;
  const tz = state?.world?.timezone ?? state?.tz ?? null;
  const urge = urgeNow(state, { now: at ?? state?.at, tz });
  if (urge < 55) return 0;
  return Math.round((2 * clamp01((urge - 55) / 45)) * 1000) / 1000;
}

/** Local night, at a home, or the thread already went graphic. */
export function phonePrivate({ hour, atHome, threadExplicit } = {}) {
  const h = finite(hour) ? hour : 12;
  return h >= 21 || h < 5 || atHome === true || threadExplicit === true;
}
