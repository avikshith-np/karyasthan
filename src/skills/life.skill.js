import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// `shouldHandle()` always returns false, so the normal response pipeline runs
// unchanged. This skill exists only to (a) appear in the Skills tab and (b) provide
// the runtime on/off switch for the life simulation (the registry `enabled` flag,
// flipped by the dashboard).
//
// The ACTUAL simulation is the engine under src/life/ (pulse, availability gate,
// phone checks, inner-state lines), which gates on isSkillEnabled('life'). With it
// off, the bot behaves exactly as without the feature (sleep hours, delayed read
// receipts, no availability gate). LIFE_ENABLED is only this skill's BOOT default.
export default {
  name: 'life',
  description:
    'Gives the bot a simulated day on the real clock — routine, commute, meals, sleep, moods and small decisions — so he answers when he would actually be on his phone. Toggle to turn the whole simulation on/off at runtime.',
  enabledByDefault: config.life.enabled,
  shouldHandle() {
    return false; // never intercept — the engine is src/life/, not this skill
  },
  handle() {
    return false;
  },
};
