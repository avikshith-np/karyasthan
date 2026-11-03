import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// `shouldHandle()` always returns false, so the normal response pipeline runs
// unchanged. This skill exists only to (a) appear in the Skills tab and (b) provide
// the runtime on/off switch for chat influence (spec 012): the registry `enabled`
// flag, flipped by the dashboard.
//
// The engine is src/life/influence/ (perception, mood overlay, sleep push, work
// counter, invitations, the advice tray). It runs only while the "life" skill is on too, and it reads
// isSkillEnabled('chat-influence') on every call — so there is no onDisable side
// effect here: switching it off removes the mood overlay and stops every new
// influence at the next call. With it off, prompts and the world are exactly as
// without the feature. CHAT_INFLUENCE_ENABLED is only this skill's BOOT default;
// the per-area toggles (chatInfluence.mood/sleep/work/invites/advice) are settings.
export default {
  name: 'chat-influence',
  description:
    `Lets what people say in chats shape his simulated life (needs the "life" skill on): a subtle, decaying mood shift from a roast, praise, an argument or good news (the reason shows only in that chat), a sleep pushed up to 2 h while a chat is live, work pressure when he chats through a work hour, invitations he answers yes / no / maybe (a maybe gets one follow-up once he decides), and life advice from chats waiting on the Director tray for the owner (needs "arcs" too). Never sickness, heavy events, money, job or relationships. Off at boot unless CHAT_INFLUENCE_ENABLED=true (now ${config.chatInfluence.enabled ? 'on' : 'off'} at boot).`,
  enabledByDefault: config.chatInfluence.enabled,
  shouldHandle() {
    return false; // never intercept — the engine is src/life/influence/, not this skill
  },
  handle() {
    return false;
  },
};
