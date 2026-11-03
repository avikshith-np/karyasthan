import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — same pattern as imitate.skill.js.
//
// Global kill switch for imitate VOICE: while imitating someone who has enrolled a
// cloned voice (and the group's "use their voice" box is ticked), the bot may send
// voice notes in that person's voice. Also gates DM enrollment ("voice enroll").
//
// The engine lives in processMessage (src/index.js) and the enrollment flow in
// src/whatsapp/voiceEnrollment.js; both check isSkillEnabled('imitate-voice').
// IMITATE_VOICE_ENABLED is only the boot default.
export default {
  name: 'imitate-voice',
  description:
    'While imitating a member who has enrolled their voice (DM "voice enroll" or dashboard upload, both with a consent recording), voice notes use their cloned voice. Per-group opt-in on the group page; this toggle is the global kill switch.',
  enabledByDefault: config.imitate.voiceEnabled,
  shouldHandle() {
    return false; // never intercept — the engine lives in the response pipeline
  },
  handle() {
    return false;
  },
};
