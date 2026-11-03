import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// `shouldHandle()` always returns false, so the normal response pipeline runs
// unchanged. This skill exists only to (a) appear in the Skills tab and (b) provide
// a runtime on/off switch for the Jev "would he reply?" pre-filter.
//
// The pre-filter itself runs in processMessage (src/index.js → runWithPrefilter in
// src/brain/prefilter.js), which gates on isSkillEnabled('jev-prefilter').
// JEV_PREFILTER_ENABLED is only this skill's BOOT default; the mode (shadow/enforce)
// and threshold are config.prefilter.* (JEV_PREFILTER_MODE / _SKIP_BELOW, dashboard-tunable).
export default {
  name: 'jev-prefilter',
  description:
    'Asks Jev "would he send a message right now?" on ordinary group turns. Shadow mode (default) only logs agreement with the reply model; enforce mode skips generation when Jev is confident he would stay silent.',
  enabledByDefault: config.prefilter.enabled,
  shouldHandle() {
    return false; // never intercept — the engine is the pre-filter hook in processMessage
  },
  handle() {
    return false;
  },
};
