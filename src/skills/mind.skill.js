import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// `shouldHandle()` always returns false, so the normal response pipeline runs
// unchanged. This skill exists only to (a) appear in the Skills tab and (b) provide
// the runtime on/off switch for the mind (the registry `enabled` flag, flipped by
// the dashboard). The engine is src/mind/ (cadence, glance/think/sleep, self-state,
// levers, proactive openers), which gates on isSkillEnabled('mind').
//
// MIND_ENABLED is only this skill's BOOT default. Pause (durable), proactive mode,
// review mode, bands and exclusions are owner settings on the dashboard Mind page.
//
// Turning it off cancels queued proactive sends at once (skillRunner calls
// onDisable). The facade is loaded lazily: it must never be a hard dependency of
// skill discovery (a failed import would drop the skill row and its kill switch).
export default {
  name: 'mind',
  description:
    `Gives the bot a slow inner loop over his chats: glances, a few deliberate thinks a day, one sleep per night that writes per-chat episodes, a self-state line, bounded lever nudges and (shadow by default) proactive openers. Off at boot unless MIND_ENABLED=true (now ${config.mind.enabled ? 'on' : 'off'} at boot). Pause, proactive mode and review live on the Mind page.`,
  enabledByDefault: config.mind.enabled,
  shouldHandle() {
    return false; // never intercept — the engine is src/mind/, not this skill
  },
  handle() {
    return false;
  },
  onDisable() {
    import('../mind/index.js')
      .then((mind) => { if (typeof mind.cancelQueued === 'function') mind.cancelQueued('skill_off'); })
      .catch((err) => { logger.debug({ err: err.message }, 'mind.skill: facade not loaded; nothing queued to cancel'); });
  },
};
