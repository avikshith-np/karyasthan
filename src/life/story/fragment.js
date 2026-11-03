import { ageOn, dayLabel } from '../clock.js';
import { eventAllowed as eventAllowedDefault } from '../innerState.js';
import { activeRomance } from './romance.js';
import { trustHint } from './cast.js';

// Arc facts in prompts (spec 010 research R21): ONE short story fragment for
// 009's inner-state line (prio 40, inside its 240-char budget) and the cast
// card overlay. Read-only, sync, clock-free (the projection's `at` is "now"
// unless the caller passes one), < 1 ms.
//
// promptFragment(state, audience, { at, mode }) → '' or ≤ 80 chars:
//   - situation + feeling, never an instruction to bring it up, never a name;
//   - '' in tone/embargo modes (009 drops the line's extras there anyway);
//   - while a heavy arc is active the ONLY fragment is the low-mood line, and
//     only for DM and call audiences: a group / IG / unknown audience gets ''
//     (nothing may hint at it there, R17); a short "getting back to normal"
//     afterglow follows for DM/call only;
//   - otherwise the most salient arc: notice period > a recent romance stage >
//     a job hunt > a fresh appraisal > a recent family call > a steady romance;
//   - each candidate's carrying event must pass the 006 audience rule
//     (innerState.eventAllowed: self/owner pass, chat origins per canUseIn).
// The `storyOn()` gate is the facade's: it installs a wrapper that returns ''
// while the arcs skill is off.
//
// castOverlay(state, castId, member?, audience?) → { label?, statusSuffix?, age?, hint? }, O(1):
//   label from the romance stage when they are the partner (dating and on),
//   "away until <day>" while an away trip runs, the age derived from birthday,
//   and a short code-built hint ("not sure you can count on her") while their
//   earned trust is under cast.js TRUST_HINT_BELOW (self-origin numbers: every
//   audience that sees the card may see it).
//   An away trip a heavy onset caused (friend_moving_away) shows only to DM and
//   call audiences (R17); every other audience, unknown included, gets the plain card.
//
// sickVisible(state, audience) → false when the sickness in force is a heavy
// onset's effect (minor_accident) and the audience is not a DM or a call: 009's
// line then says the plain tone instead of "home sick" (R17).

export const FRAGMENT_MAX = 80;
export const HEAVY_AUDIENCES = Object.freeze(new Set(['dm', 'call']));

const DAY = 86400;
const RECENT_STAGE_DAYS = 30;
const APPRAISAL_DAYS = 14;
const FAMILY_CALL_DAYS = 2;
const AFTERGLOW_DAYS = 45;

const ROMANCE_TEXT = Object.freeze({
  interested: 'quietly into someone',
  talking: 'talking to someone new',
  dating: 'seeing someone, early days',
  committed: 'in a relationship',
  engaged: 'engaged to be married',
  married: 'married',
});
const ROMANCE_STEADY = Object.freeze({ dating: 'seeing someone' });
const PARTNER_LABEL = Object.freeze({ dating: 'Dating', committed: 'Partner', engaged: 'Engaged to', married: 'Spouse' });
const APPRAISAL_TEXT = Object.freeze({ poor: 'stung by the appraisal', good: 'pleased with the appraisal', great: 'buzzing after the appraisal' });
const HEAVY_TEXT = 'on a low stretch';
const AFTERGLOW_TEXT = 'getting back to normal';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

let eventAllowedFn = eventAllowedDefault;

/** Test seam: replace the audience check (null restores innerState.eventAllowed). */
export function __setEventAllowedForTest(fn) {
  eventAllowedFn = typeof fn === 'function' ? fn : eventAllowedDefault;
}

function allowed(eventId, audience) {
  try { return eventAllowedFn(eventId, audience) === true; } catch { return false; }
}

function clip(text) {
  return text.length <= FRAGMENT_MAX ? text : text.slice(0, FRAGMENT_MAX).replace(/\s+\S*$/, '');
}

/** One story fragment for this audience ('' for none). */
export function promptFragment(state, audience = null, opts = {}) {
  try {
    const st = state?.story;
    if (!isObj(st)) return '';
    const mode = opts?.mode;
    if (mode === 'tone' || mode === 'embargo') return '';
    const at = finite(opts?.at) ? opts.at : state?.at;
    if (!finite(at)) return '';
    const kind = audience?.kind;
    const private1 = HEAVY_AUDIENCES.has(kind) || kind === 'dashboard';

    // Heavy: the only fragment while it lasts, DM/call only.
    const h = st.heavy;
    if (isObj(h?.active) && finite(h.active.until) && at < h.active.until) {
      return private1 && allowed(h.active.id, audience) ? HEAVY_TEXT : '';
    }

    const cands = [];
    const c = st.career;
    if (isObj(c?.notice) && finite(c.notice.until) && at < c.notice.until) {
      cands.push({ prio: 1, text: 'serving notice at work', eventId: c.notice.eventId });
    }
    const r = activeRomance(state);
    if (r && ROMANCE_TEXT[r.arc.stage]) {
      const recent = finite(r.arc.stageAt) && at - r.arc.stageAt <= RECENT_STAGE_DAYS * DAY;
      const text = recent ? ROMANCE_TEXT[r.arc.stage] : (ROMANCE_STEADY[r.arc.stage] ?? ROMANCE_TEXT[r.arc.stage]);
      cands.push({ prio: recent ? 2 : 6, text, eventId: r.arc.lastBeatEventId ?? r.arc.id });
    }
    if (c?.huntArcId && c.huntPhase !== 'paused' && c.huntPhase !== 'ended') {
      cands.push({ prio: 3, text: 'quietly job hunting', eventId: st.arcs?.[c.huntArcId]?.lastBeatEventId ?? c.huntArcId });
    }
    const ap = c?.lastAppraisal;
    if (isObj(ap) && APPRAISAL_TEXT[ap.band] && finite(ap.at) && at - ap.at >= 0 && at - ap.at <= APPRAISAL_DAYS * DAY) {
      cands.push({ prio: 4, text: APPRAISAL_TEXT[ap.band], eventId: ap.eventId });
    }
    const fam = st.family;
    if (finite(fam?.lastCallAt) && at - fam.lastCallAt >= 0 && at - fam.lastCallAt <= FAMILY_CALL_DAYS * DAY) {
      cands.push({ prio: 5, text: 'family pushing about the usual', eventId: null });
    }
    if (private1 && finite(h?.lastOnsetAt) && at - h.lastOnsetAt <= AFTERGLOW_DAYS * DAY) {
      cands.unshift({ prio: 0, text: AFTERGLOW_TEXT, eventId: null });
    }
    cands.sort((a, b) => a.prio - b.prio);
    for (const x of cands) {
      if (allowed(x.eventId, audience)) return clip(x.text);
    }
    return '';
  } catch {
    return '';
  }
}

const privateAudience = (audience) => HEAVY_AUDIENCES.has(audience?.kind) || audience?.kind === 'dashboard';

/** May this audience hear that he is sick? (false only for a heavy-caused sickness outside DM/call) */
export function sickVisible(state, audience = null) {
  try {
    const id = state?.sick?.eventId;
    const heavyId = state?.story?.heavy?.sickEventId;
    if (!Number.isSafeInteger(id) || id !== heavyId) return true;
    return privateAudience(audience);
  } catch {
    return false;
  }
}

/** Cast card overlay (R21): { label?, statusSuffix?, age?, hint? } — {} when there is nothing to add. */
export function castOverlay(state, castId, member = null, audience = null) {
  try {
    const m = member ?? (state?.cast instanceof Map ? state.cast.get(castId) : null);
    if (!isObj(m)) return {};
    const out = {};
    const tz = state?.world?.timezone;
    const at = state?.at;
    const rom = state?.story?.romance;
    if (rom?.partnerId === castId && rom.arcId && PARTNER_LABEL[rom.stage]) out.label = PARTNER_LABEL[rom.stage];
    const away = state?.story?.castLife?.[castId]?.away;
    if (finite(away?.until) && finite(at) && away.until > at && (away.heavy !== true || privateAudience(audience))) {
      const label = dayLabel(away.until, tz); // 'Fri 30 Oct'
      out.statusSuffix = `away until ${away.until - at <= 6 * DAY ? label.split(' ')[0] : label.split(' ').slice(1).join(' ')}`;
    }
    if (typeof m.birthday === 'string' && finite(at)) {
      const age = ageOn(m.birthday, at, tz);
      if (Number.isInteger(age) && age > 0 && age < 130) out.age = age;
    }
    const hint = trustHint(m);
    if (hint) out.hint = hint;
    return out;
  } catch {
    return {};
  }
}
