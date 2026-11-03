import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — never intercepts WhatsApp messages.
//
// Master switch for the bot in the INSTAGRAM group chat (src/instagram/chat.js): every
// IG_CHAT_POLL_MINUTES while awake, and after each browsing session, he checks whether the
// group thread is unread; if so he reads it, watches reels members sent, and replies or
// reacts on his own (Jev decides; a mention always gets a reply). The dashboard's
// "Check chat now" works regardless. IG_CHAT_ENABLED is only the boot default.
export default {
  name: 'instagram-chat',
  description:
    'Reads the Instagram group chat every ~20 min while awake, watches reels members send, and replies or hearts messages on his own (Jev decides; a mention always gets a reply).',
  enabledByDefault: config.instagram.chatEnabled,
  shouldHandle() {
    return false;
  },
  handle() {
    return false;
  },
};
