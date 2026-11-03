import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// `shouldHandle()` always returns false, so the normal response pipeline runs
// unchanged. This skill exists only to (a) appear in the Skills tab and (b) provide
// the global runtime kill switch for imitate mode (the registry `enabled` flag,
// flipped by the dashboard).
//
// The ACTUAL imitation runs inside processMessage (src/index.js), which resolves
// the per-group target from group_imitation (src/behavior/imitationState.js) and
// gates on isSkillEnabled('imitate'). Per-group targets are set on each group's
// dashboard page (POST /api/groups/:jid/imitate). IMITATE_MODE_ENABLED is only
// this skill's BOOT default — after a restart imitation stays off until the
// master is re-enabled, then unexpired persisted targets resume.
export default {
  name: 'imitate',
  description:
    'Lets the bot impersonate a chosen group member — their vocabulary, length, emoji and casing habits — using their real message history. Targets are set per group on the group page; this toggle is the global kill switch.',
  enabledByDefault: config.imitate.enabled,
  shouldHandle() {
    return false; // never intercept — the engine lives in the response pipeline
  },
  handle() {
    return false;
  },
};
