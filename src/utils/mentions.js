// "Is this message aimed at the bot?" — one source of truth for the response
// pipeline (events.js debounce, decisionEngine, bill-split skill) and for the
// explicit image-request check in index.js.
//
// @-mentions are matched ONLY against the bot's own identities (phone JID, LID,
// configured number). There used to be a "a single @mention is probably for us"
// fallback for LID ↔ phone mismatches; it made the bot answer every time someone
// tagged a friend. Unknown identities now mean "not mentioned" (fail toward silence).

import { textHasName } from './nameMatch.js';
import { config, getPersona } from './config.js';
import { logger } from './logger.js';

/**
 * Normalise a JID to "user@server" with the device suffix stripped and the
 * server folded to 's.whatsapp.net' (phone) or 'lid'. Returns null for
 * anything else (groups, broadcasts, junk, non-strings).
 *   "15550100123:12@s.whatsapp.net" → "15550100123@s.whatsapp.net"
 *   "123456789012345:3@lid"          → "123456789012345@lid"
 */
export function normalizeUserJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const at = jid.indexOf('@');
  if (at <= 0) return null;
  const user = jid.slice(0, at).split(':')[0].split('_')[0];
  const server = jid.slice(at + 1).toLowerCase();
  if (!/^\d+$/.test(user)) return null;
  if (server === 's.whatsapp.net' || server === 'c.us') return `${user}@s.whatsapp.net`;
  if (server === 'lid') return `${user}@lid`;
  return null;
}

/**
 * The bot's own identities as a Set of normalised JIDs. `configPhone` is the
 * configured WA_PHONE_NUMBER (digits) — kept as a phone identity for the brief
 * window where sock.user is unset.
 */
export function botIdentities({ botJid, botLid, configPhone } = {}) {
  const ids = new Set();
  const pn = normalizeUserJid(botJid);
  if (pn) ids.add(pn);
  const lid = normalizeUserJid(botLid);
  if (lid) ids.add(lid);
  const digits = String(configPhone || '').replace(/\D/g, '');
  if (digits) ids.add(`${digits}@s.whatsapp.net`);
  return ids;
}

/**
 * True when any @-mentioned JID is one of the bot's own identities.
 * Unknown identities → false.
 */
export function isBotMentionedByJid(mentionedJids, identity = {}) {
  if (!Array.isArray(mentionedJids) || !mentionedJids.length) return false;
  const ids = botIdentities(identity);
  if (!ids.size) return false;
  return mentionedJids.some(jid => {
    const n = normalizeUserJid(jid);
    return !!n && ids.has(n);
  });
}

export { textHasName };

/** Text-based name/alias address. */
export function isBotAddressedInText(content, aliases = getPersona().aliases) {
  if (!content || !Array.isArray(aliases) || !aliases.length) return false;
  return aliases.some(a => textHasName(content, a));
}

/**
 * Combined check used by the pipeline: @-mention of the bot's own JID/LID, or
 * its name/alias in the text. `context` carries botJid (sock.user.id) and
 * botLid (sock.user.lid).
 */
export function isBotMentioned(msg, context = {}, { logTag = 'mentions' } = {}) {
  const mentionedJids = msg?.metadata?.mentionedJids;
  if (mentionedJids?.length) {
    const identity = { botJid: context.botJid, botLid: context.botLid, configPhone: config.phoneNumber };
    if (isBotMentionedByJid(mentionedJids, identity)) return true;
    logger.debug({
      mentionedJids,
      botJid: context.botJid || null,
      botLid: context.botLid || null,
      msgId: msg.id,
    }, `${logTag}: @mention JIDs did not match the bot — treating as someone else being tagged`);
  }
  return isBotAddressedInText(msg?.content);
}

// ── Explicit image requests ─────────────────────────────────────────────────
// A request verb with an image noun in the same sentence ("send me a meme pic",
// "make a wallpaper of…"), an imperative "draw me/a/the …" / "generate a …", or "image/photo of …". Bare verbs like
// "imagine if we…" or "create a plan" are NOT image requests.
const IMG_VERB = '(?:draw|generate|create|make|send|show)';
const IMG_NOUN = '(?:images?|pics?|pictures?|photos?|drawings?|memes?|art|artwork|wallpapers?)';
const VERB_THEN_NOUN = new RegExp(`\\b${IMG_VERB}\\b[^.!?\\n]{0,60}?\\b${IMG_NOUN}\\b`, 'i');
const NOUN_THEN_VERB = new RegExp(`\\b${IMG_NOUN}\\b[^.!?\\n]{0,20}?\\b${IMG_VERB}\\b`, 'i');
const DRAW_SOMETHING = /\bdraw\s+(?:me|us|him|her|them|a|an|the|my|our|his|their|some|something|this|that)\b\s*\S/i;
const GENERATE_A = /\bgenerate\s+(?:me\s+|us\s+)?(?:a|an)\s+\S/i;
// "image of a sunset", "photo of …" — a noun phrase that only makes sense as an ask.
const NOUN_OF = new RegExp(`\\b${IMG_NOUN}\\s+of\\s+\\S`, 'i');
const NEGATED = new RegExp(`\\b(?:don'?t|do\\s+not|dont|never|stop|no\\s+need\\s+to)\\s+(?:\\w+\\s+){0,2}?${IMG_VERB}\\b`, 'i');

export function isExplicitImageRequest(content) {
  if (!content || typeof content !== 'string') return false;
  const text = content.replace(/@\S+/g, ' ');
  if (NEGATED.test(text)) return false;
  return VERB_THEN_NOUN.test(text) || NOUN_THEN_VERB.test(text) || DRAW_SOMETHING.test(text) || GENERATE_A.test(text) || NOUN_OF.test(text);
}

/**
 * An image request the bot should act on: explicit AND directed at the bot
 * (DM, @-mention, name/alias, or reply to the bot — decided by the caller).
 */
export function isImageRequestForBot(content, { directed = false } = {}) {
  return !!directed && isExplicitImageRequest(content);
}

/**
 * May a text reply to an image become an image EDIT (index.js 4.5)? Same rule as an
 * image request: directed at the bot — a DM, or mention factor ≥ 5 (its own @JID/LID,
 * name/alias, or a reply to the bot) — and only over a plain probability skip, never a
 * hard skip or a rate-limit / burst-cooldown guard; and `warmup` (checkWarmup('text'),
 * when given) must allow text.
 */
export function isImageEditForBot({ isDm = false, mentionFactor = 0, decision = {}, warmup = null } = {}) {
  if (!isDm && !(mentionFactor >= 5)) return false;
  if (!decision.shouldRespond && decision.factors?.skipReason !== 'probability') return false;
  if (warmup && (!warmup.allowed || warmup.responseType === 'reaction')) return false;
  return true;
}
