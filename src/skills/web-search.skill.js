import { config } from '../utils/config.js';
import { closeBrowser } from '../brain/webBrowse.js';

// CONTROL-SURFACE ("manifest") skill — it deliberately does NOT intercept messages.
//
// `shouldHandle()` always returns false, so the normal response pipeline runs
// unchanged. This skill exists only to (a) appear in the Skills tab and (b) provide
// a runtime on/off switch (the registry `enabled` flag, flipped by the dashboard).
//
// The ACTUAL web search/browse runs inside generateResponse()'s marker re-prompt loop
// (src/brain/contextBuilder.js), which gates on isSkillEnabled('web-search'). Toggling
// this skill off in the Skills tab immediately stops the bot from advertising or using
// [SEARCH:]/[BROWSE:]. WEB_SEARCH_ENABLED is only this skill's BOOT default.
export default {
  name: 'web-search',
  description:
    'Lets the bot search the web (SearXNG) and open pages (Playwright) mid-reply via [SEARCH:]/[BROWSE:] markers. Toggle to turn the whole capability on/off at runtime.',
  enabledByDefault: config.webSearch.enabled,
  shouldHandle() {
    return false; // never intercept — the engine is the marker loop, not this skill
  },
  handle() {
    return false;
  },
  onDisable() {
    // Free the headless browser when the capability is switched off.
    closeBrowser('skill-disabled').catch(() => {});
  },
};
