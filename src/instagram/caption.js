import { callLlm } from '../brain/llm.js';
import { postProcess } from '../brain/postProcess.js';
import { evaluateResponse } from '../brain/qualityGate.js';
import { getPersona } from '../utils/config.js';
import { getIdentityText } from '../personality/systemPrompt.js';
import { logger } from '../utils/logger.js';

// The short line the bot sends with a shared reel, in persona voice. `input text` on the
// phone can type only printable ASCII, so the caption is Latin script with no emoji —
// the persona's normal register for romanised languages anyway. Returns '' to send the
// reel on its own (the LLM said [SKIP], or the quality gate rejected the line).

const MAX_LEN = 140;

export function toTypeable(text) {
  return String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ').trim()
    .slice(0, MAX_LEN);
}

export async function writeShareCaption(reel, groupName) {
  const p = getPersona();
  const system = `${getIdentityText().slice(0, 6000)}

You are ${p.name}. You are about to share an Instagram reel into your friends' group chat "${groupName}".
Write the one short line you'd send with it, the way you'd actually type it: ${p.language}, casual, under 15 words.
Write in Latin script only (no emoji, no non-Latin script) — the keyboard can't type them.
No hashtags, no quotes around it, don't describe the reel back to them. If the reel speaks for itself, reply exactly [SKIP].`;
  const user = `The reel (description written for you):\n${reel.description || '(no description)'}\n\nPosted by: ${reel.account || 'unknown'}${reel.for_whom ? `\nIt reminds you of: ${reel.for_whom}` : ''}`;

  const raw = await callLlm(system, user, { role: 'mouth', caller: 'ig.caption', send: true, temperature: 0.9, maxTokens: 300, timeoutMs: 45_000 });
  if (!raw || /^\s*\[?SKIP\]?\s*$/i.test(raw)) return '';
  const processed = postProcess(raw, []);
  const line = toTypeable(typeof processed === 'string' ? processed : processed?.text);
  if (!line || line.length < 2) return '';

  const verdict = await evaluateResponse(line, `[${p.name} is sharing an Instagram reel into the group: ${reel.description || ''}]`);
  if (!verdict.pass) {
    logger.info({ line, reason: verdict.reason }, 'reel caption failed the quality gate; sending without caption');
    return '';
  }
  return line;
}
