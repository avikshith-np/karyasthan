import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// `shouldHandle()` always returns false, so the normal response pipeline runs
// unchanged. This skill exists only to (a) appear in the Skills tab and (b) provide
// the runtime on/off switch for the story layer (spec 010): the registry `enabled`
// flag, flipped by the dashboard.
//
// The engine is src/life/story/ (cast lives, arcs, reconciler, Ask-me cards,
// journal, Director). It runs only while the "life" skill is on too, and it reads
// isSkillEnabled('arcs') on every call — so there is no onDisable side effect here:
// switching it off returns every seam to 009's behaviour at the next call. With it
// off, behaviour and prompts are exactly as without the feature. ARCS_ENABLED is
// only this skill's BOOT default.
export default {
  name: 'arcs',
  description:
    `Gives the simulated life (needs the "life" skill on) a story: cast members with their own lives and relationships, slow arcs (romance, career, family, rare heavy stretches behind a veto card), adoption of plans he mentions in chats into his world, Ask-me cards for big decisions, a private nightly journal and the dashboard Director (fate, pins, scenes, rewind). Off at boot unless ARCS_ENABLED=true (now ${config.arcs.enabled ? 'on' : 'off'} at boot).`,
  enabledByDefault: config.arcs.enabled,
  shouldHandle() {
    return false; // never intercept — the engine is src/life/story/, not this skill
  },
  handle() {
    return false;
  },
};
