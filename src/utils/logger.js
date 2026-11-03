import pino from 'pino';
import { config } from './config.js';
import { logSink } from '../dashboard/logStream.js';

const streams = [{ stream: process.stdout }];
if (config.dashboard.enabled) {
  streams.push({ stream: logSink });
}

// Key-bearing fields are censored before a line reaches stdout or the dashboard log
// ring (→ SSE logs topic → browser). Spec 007 FR-013 / R7. Request headers are
// dropped whole: they only ever carry auth.
const REDACT_PATHS = [
  'authorization', 'Authorization', 'apiKey', 'headers', '["x-api-key"]', '["x-goog-api-key"]',
  '*.authorization', '*.Authorization', '*["x-api-key"]', '*["x-goog-api-key"]', '*.apiKey', '*.headers',
];

export const logger = pino(
  { level: config.logLevel, name: 'karyasthan', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
  pino.multistream(streams),
);

// Every configured secret value, read at call time (keys can be set from the
// dashboard). Short values are skipped: replacing a 3-char string would mangle text.
function configuredSecrets() {
  const l = config.llm || {};
  return [
    l.apiKey, l.anthropicApiKey, l.geminiApiKey, l.glmApiKey, l.openrouterApiKey, l.xaiApiKey, l.localApiKey,
    config.instagram?.jevApiKey, config.media?.giphyApiKey,
  ].filter((v) => typeof v === 'string' && v.length >= 8);
}

/**
 * Strip key material from a string before it is logged or returned (provider error
 * bodies, exception messages, URLs): `key=…` query params, `Bearer …` tokens,
 * `sk-…` / `xai-…` / `AIza…` shaped keys, and any configured key value verbatim.
 */
export function scrubSecrets(input) {
  if (input == null) return input;
  let s = typeof input === 'string' ? input : String(input);
  for (const secret of configuredSecrets()) {
    if (s.includes(secret)) s = s.split(secret).join('[REDACTED]');
  }
  return s
    .replace(/([?&#\s"'(]|^)((?:api[_-]?)?key)=([^&\s"'#)]+)/gi, '$1$2=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bxai-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}
