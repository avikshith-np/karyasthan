import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// The runtime on/off switch of the public site (spec 013): while it is on, the exporter
// (src/public/) builds a filtered snapshot of his life every few minutes and pushes it to
// Cloudflare R2 (when R2 is configured in .env and DRY_RUN is off). Switching it off stops
// the exports; the dashboard's Public page has the TAKE OFFLINE button that replaces the
// live snapshot with an "offline" notice. PUBLIC_SITE_ENABLED is only the BOOT default.
// Nothing here is read by a prompt builder.
export default {
  name: 'public-site',
  description:
    `Publishes a filtered, live snapshot of his simulated life (what he's doing, his day, cast, story chapters, stats, journal entries you published, open Ask-me votes) to the public site on Cloudflare. Never chat text, chat or group names, numbers, real names of people you haven't opted in, his home or the mind's notes. Needs the "life" skill on. Off at boot unless PUBLIC_SITE_ENABLED=true (now ${config.publicSite.enabled ? 'on' : 'off'} at boot).`,
  enabledByDefault: config.publicSite.enabled,
  shouldHandle() {
    return false; // never intercept — the engine is src/public/, not this skill
  },
  handle() {
    return false;
  },
};
