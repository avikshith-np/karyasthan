import { config } from '../utils/config.js';
import { stopSession } from '../instagram/session.js';

// CONTROL-SURFACE ("manifest") skill — never intercepts messages.
//
// Master switch for AUTOMATIC Instagram browsing sessions on the Instagram phone
// (src/instagram/, specs/005). While off, the scheduler starts nothing; the dashboard's
// Browse button and queue approvals still work (they are explicit owner actions).
// Turning it off also stops a running session. IG_ENABLED is only the boot default.
export default {
  name: 'instagram-reels',
  description:
    'Browses Reels on the Instagram phone a few times a day in character: describes each reel, lets Jev judge it, likes what fits, and queues the best for the Instagram group. Toggle = automatic sessions on/off.',
  enabledByDefault: config.instagram.enabled,
  shouldHandle() {
    return false;
  },
  handle() {
    return false;
  },
  onDisable() {
    stopSession();
  },
};
