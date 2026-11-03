import { config } from '../utils/config.js';

// CONTROL-SURFACE ("manifest") skill — never intercepts messages.
//
// Master switch for phone calls (src/calls/). While off, inbound calls are refused
// with "busy" before answering and the dashboard cannot place calls. CALLS_ENABLED is
// only the boot default; the toggle is in-memory and resets on restart.
export default {
  name: 'calls',
  description:
    'Answers and places cellular calls on the gateway phone, talking through Gemini Live with the person\'s 1:1 or group context. Calls are started from the person/group pages; this toggle is the global kill switch.',
  enabledByDefault: config.calls.enabled,
  shouldHandle() {
    return false;
  },
  handle() {
    return false;
  },
};
