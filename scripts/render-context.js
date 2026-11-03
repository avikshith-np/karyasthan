#!/usr/bin/env node
/**
 * Print exactly what the LLM would see for a chat right now: the system prompt's
 * "People in this group" block and the conversation transcript. Read-only.
 *
 *   node scripts/render-context.js <chatJid> [--as <chatJid>] [--full] [--lines N] [--sizes] [--web]
 *
 *   --as     render the remembered things (people block, dynamics, slang, memories)
 *            for another chat's audience — e.g. a group's prompt as a DM member would
 *            see it — to check what crosses over (spec 006). Default: the chat's own.
 *   --full   print the whole system prompt (core, profile) and the user message
 *   --sizes  print chars and ≈tokens (chars/4) of core, profile and tail (the user
 *            message: recall head + transcript + per-turn rules), and the total
 *   --web    render as if the web-search skill were on (adds the web manual to core)
 *
 * Never migrates (assertSchemaCurrent) and reads recall with track:false, so recall
 * counts are untouched. This process has no WhatsApp connection, so no group counts
 * as freshly synced: only same-chat items render (the strictest view).
 *
 * Use it before/after any change to labels, nicknames, mentions, or the message
 * window — it is the fastest way to spot misattribution bugs. Point DB_PATH at a
 * copy of the database, never at the live file.
 */
import { assertSchemaCurrent, closeDb } from '../src/memory/db.js';
import { buildSystemParts, buildConversationContext } from '../src/personality/systemPrompt.js';
import { resolveAudience } from '../src/memory/recall.js';

const USAGE = 'usage: node scripts/render-context.js <chatJid> [--as <chatJid>] [--full] [--lines N] [--sizes] [--web]';
const args = process.argv.slice(2);
const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const flagValues = new Set(['--as', '--lines'].map(valueOf).filter(Boolean));
const chatJid = args.find(a => !a.startsWith('--') && !flagValues.has(a));
if (!chatJid) {
  console.error(USAGE);
  process.exit(1);
}
const full = args.includes('--full');
const sizes = args.includes('--sizes');
const webEnabled = args.includes('--web');
const maxLines = parseInt(valueOf('--lines') || '60', 10) || 60;
const asJid = valueOf('--as');
const isGroup = chatJid.endsWith('@g.us');

try {
  assertSchemaCurrent();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// The composition the reply path sends: one system message = core + '\n' + profile
// (Anthropic: two cached blocks), then the user message (recall head first).
const audience = resolveAudience({ chatJid: asJid || chatJid });
const { core, profile } = buildSystemParts(chatJid, isGroup, null, { webEnabled, audience, track: false });
const systemPrompt = profile ? `${core}\n${profile}` : core;
const { text, fixatedWords } = buildConversationContext(chatJid, null, isGroup, { webEnabled, audience, track: false });
const [transcript, instruction] = text.split('===END OF CONVERSATION===');

console.log(`(audience: ${audience.kind} ${asJid || chatJid}, ${audience.members.size} member(s), `
  + `fresh=${audience.fresh}, outsiders=${audience.outsiders})`);
if (full) {
  console.log('===== SYSTEM PROMPT: CORE =====\n' + core);
  console.log('\n===== SYSTEM PROMPT: PROFILE =====\n' + profile);
  console.log('\n===== USER MESSAGE =====\n' + transcript + '===END OF CONVERSATION===' + instruction);
} else if (!sizes) {
  const people = profile.split('## People in this group:')[1]?.split('\n## ')[0];
  console.log('===== PEOPLE =====' + (people || '\n(none)'));
  console.log(`\n===== TRANSCRIPT (last ${maxLines} lines) =====`);
  console.log(transcript.trim().split('\n').slice(-maxLines).join('\n'));
}
if (sizes) {
  const tok = (n) => Math.round(n / 4);
  const row = (label, n) => `${label.padEnd(8)}${String(n).padStart(8)} chars  ≈${String(tok(n)).padStart(6)} tokens`;
  const total = systemPrompt.length + text.length;
  console.log('===== PROMPT SIZES =====');
  console.log(row('core', core.length));
  console.log(row('profile', profile.length));
  console.log(row('tail', text.length));
  console.log(row('total', total));
}
console.log(`\n(system prompt ${systemPrompt.length} chars, user message ${text.length} chars, fixated: ${JSON.stringify(fixatedWords)})`);
closeDb();
