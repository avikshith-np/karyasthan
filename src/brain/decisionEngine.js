import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getRecentMessages } from '../memory/messageStore.js';
import { checkRateLimit, checkHourlyCaps, getSecondsSinceLastResponse, checkBurst } from '../behavior/rateLimiter.js';
import { getDb } from '../memory/db.js';
import { isBotMentionedByJid, textHasName } from '../utils/mentions.js';
import { knobs } from '../mind/index.js';
import { noteCappedReply, capCatchUpEnabled } from '../behavior/capCatchUp.js';

// Names the bot responds to
const SELF_NAMES = getPersona().aliases;

function urgeFrom(context) {
  const u = context?.urge;
  return typeof u === 'number' && Number.isFinite(u) ? Math.max(0, Math.min(1, u)) : 0;
}

function looksFlirtatious(text) {
  const s = String(text ?? '');
  return /\b(?:flirt\w*|horny|sexy|nude|nudes|thirsty|babe|come\s+over|miss\s+you)\b/i.test(s) || /[😉😘😍🥵😏💋]/.test(s);
}

/** DM flirt + urge ≥ 0.55 → up to 1.2. Groups and everything else → 1. */
export function urgeMultiplier({ isDm, content, urge } = {}) {
  const u = typeof urge === 'number' && Number.isFinite(urge) ? Math.max(0, Math.min(1, urge)) : 0;
  if (!isDm || u < 0.55 || !looksFlirtatious(content)) return 1;
  return 1 + 0.2 * Math.min(1, (u - 0.55) / 0.45);
}

/**
 * Decide whether the bot should respond to a message.
 * Returns { shouldRespond, responseType, score, factors }
 *
 * responseType: 'text' | 'reaction' | 'text_and_reaction' | 'skip'
 */
export function decide(msg, context) {
  const { isGroup, isDm, botJid, botLid } = context;
  const factors = {};

  // ── Hard overrides: NEVER respond ──
  if (msg.isFromSelf) return skip('own_message', factors);
  if (msg.messageType === 'reaction') return skip('reaction_message', factors);
  // A life catch-up turn (spec 009 §R10) answers its queued triggers, so an empty
  // newest message (a photo with no caption) doesn't skip the whole catch-up.
  const catchUpHasTriggers = Array.isArray(context.catchUp?.triggerIds) && context.catchUp.triggerIds.length > 0;
  if (!msg.content && msg.messageType !== 'sticker' && !catchUpHasTriggers) return skip('empty_content', factors);

  // ── DMs: always respond (bypass rate limits and sleep hours) ──
  // Urge: a flirtatious DM while he is wound up multiplies by at most 1.2.
  // The score stays clamped at 0.95, so this records the factor and does not
  // push a DM past the cap. Groups record urge and do not multiply.
  if (isDm) {
    factors.dm = true;
    const u = urgeFrom(context);
    factors.urge = u;
    const mult = urgeMultiplier({ isDm: true, content: msg.content, urge: u });
    factors.urgeMultiplier = mult;
    return respond(Math.min(0.95, 0.95 * mult), factors, 'text');
  }

  // A running skill flow (e.g. bill splitting) is not an override here: a message the
  // skill claims never reaches decide() (runSkills handled it, and the skill refreshes
  // its own flow); anything else in that group is scored like any other message.

  // Invitation follow-up (spec 012 §P2.7, life's phone): he got back to them about
  // an invitation. No mention bypass of the rate limit and no cap exemption (the
  // invitation may have @-mentioned him), the burst check too; no roll (the model
  // can still [SKIP]). Warmup, mute, the stale-turn guard and DRY_RUN apply as usual.
  if (isGroup && context.followUp) {
    factors.followUp = true;
    const rate = checkRateLimit(msg.groupJid);
    if (!rate.allowed) return skip(`rate_limited: ${rate.reason}`, factors);
    const caps = checkHourlyCaps(msg.groupJid, { isMention: false });
    if (!caps.allowed) return skip(`rate_limited: ${caps.reason}`, factors);
    if (checkBurst(msg.groupJid)) return skip('burst_cooldown', factors);
    return respond(0.95, factors, 'text');
  }

  // Life catch-up turn (spec 009 §R10): one reply covers several queued messages,
  // so any queued trigger that mentioned the bot counts as a mention of this turn.
  const triggers = isGroup && context.catchUp ? loadCatchUpTriggers(context.catchUp, msg) : [];
  if (triggers.length) factors.catchUpTriggers = triggers.length;

  // Check rate limits (but not for direct @mentions)
  const directMention = isDirectMention(msg, botJid, botLid)
    || triggers.some(t => isDirectMention(t, botJid, botLid));
  const rateCheck = checkRateLimit(msg.groupJid);
  if (!rateCheck.allowed) {
    // Still allow if directly mentioned
    if (!directMention) {
      return skip(`rate_limited: ${rateCheck.reason}`, factors);
    }
  }

  // Imitate mode: the bot answers to the name it is wearing. While a target is
  // active in this group, a text mention of their name/aliases is treated like
  // a direct mention. (The bot's own aliases still work too.)
  const imitatedMention = !!(context.imitation?.aliases?.length && msg.content)
    && context.imitation.aliases.some(a => msg.content.toLowerCase().includes(a));

  // Hourly caps: per group (mentions exempt — incl. the worn name while imitating;
  // a reply to the bot is NOT exempt, which bounds reply loops, spec 007 R10) and
  // global across groups (no exemption).
  const capCheck = checkHourlyCaps(msg.groupJid, { isMention: directMention || imitatedMention });
  // Cap catch-up (src/behavior/capCatchUp.js): a capped message is still scored as
  // if uncapped; if he'd have sent text, one catch-up reply is queued for when the
  // cap frees. The turn itself is the same cap skip as before (catchUpQueued in the
  // factors). A catch-up turn — life's or this one — never queues another.
  let capped = null;
  if (!capCheck.allowed) {
    if (context.catchUp || !capCatchUpEnabled()) return skip(`rate_limited: ${capCheck.reason}`, factors);
    capped = capCheck.reason;
  }
  const capSkip = (wouldText) => {
    factors.catchUpQueued = !!wouldText && noteCappedReply(msg, { isMention: directMention || imitatedMention });
    return skip(`rate_limited: ${capped}`, factors);
  };

  // The cap catch-up turn itself: its triggers already cleared the roll when the cap
  // blocked them, so no second roll (the model can still [SKIP]); the rate limit and
  // the caps above were re-checked, and the burst check still applies.
  // Its mention/question factors are still recorded: a mentioning trigger keeps the
  // mention threshold, the "directed" image rule and the fast delay downstream.
  if (isGroup && context.catchUp?.cap === true) {
    factors.capCatchUp = true;
    factors.mention = mentionFactorOf(msg, triggers, botJid, botLid);
    factors.question = computeQuestionFactor(msg.content);
    if (checkBurst(msg.groupJid)) return skip('burst_cooldown', factors);
    return respond(0.95, factors, 'text');
  }

  // ── Group messages: probability system ──
  // Mind levers (spec 008, contracts/levers.md): the base rate and a per-group
  // multiplier come from the knob overlay. With the mind off or paused, or no active
  // nudge, these are exactly config.responseRate and 1.
  let score = knobs.responseRate();
  const groupRate = knobs.groupRate(msg.groupJid);
  if (groupRate !== 1) factors.mindGroupRate = groupRate;
  score *= groupRate;

  // Factor 1: Mention (a catch-up takes the strongest of its queued triggers: a
  // reply to the bot counts for the override below, not for the cap exemption above)
  const mentionFactor = mentionFactorOf(msg, triggers, botJid, botLid);
  factors.mention = mentionFactor;
  score *= mentionFactor;

  // Hard override: direct @mention or reply to our message
  if (mentionFactor >= 5.0) {
    return capped ? capSkip(true) : respond(0.95, factors, 'text');
  }

  if (imitatedMention) {
    factors.imitatedMention = true;
    return capped ? capSkip(true) : respond(0.95, factors, 'text');
  }

  // Factor 2: Question
  const questionFactor = computeQuestionFactor(msg.content);
  factors.question = questionFactor;
  score *= questionFactor;

  // Factor 3: Command/request detection (sing, draw, etc.)
  const commandFactor = computeCommandFactor(msg.content);
  factors.command = commandFactor;
  score *= commandFactor;

  // Factor 4: Humor opportunity
  const humorFactor = computeHumorFactor(msg);
  factors.humor = humorFactor;
  score *= humorFactor;

  // Factor 5: Conversation momentum
  const momentumFactor = computeMomentumFactor(msg.groupJid);
  factors.momentum = momentumFactor;
  score *= momentumFactor;

  // Imitate mode: mimic the target's activity rhythm — quieter at hours they
  // rarely post, livelier at their peak hours. Gated on data sufficiency
  // (≥200 sampled messages) so thin histories don't produce a noisy schedule.
  const imitCard = context.imitation?.styleCard;
  if (imitCard?.activeHours && imitCard.count >= 200) {
    const cadenceFactor = computeImitationCadenceFactor(imitCard.activeHours);
    factors.imitCadence = cadenceFactor;
    score *= cadenceFactor;
  }

  // Factor 6: Recency (anti-spam backbone)
  const recencyFactor = computeRecencyFactor(msg.groupJid);
  factors.recency = recencyFactor;
  score *= recencyFactor;

  // Factor 7: BS detection
  const bsFactor = computeBsFactor(msg.content);
  factors.bs = bsFactor;
  score *= bsFactor;

  // Factor 8: Two-person conversation detection
  const convoFactor = computeConversationFactor(msg.groupJid);
  factors.conversation = convoFactor;
  score *= convoFactor;

  // Life availability (spec 009 §R9): the gate let this message through as
  // now/sneak; a busier state makes a group reply less likely, so a sneak can
  // still be skipped. Absent with life off → score untouched. Never boosts.
  const availabilityFactor = context.availability?.scoreFactor;
  if (typeof availabilityFactor === 'number' && Number.isFinite(availabilityFactor)) {
    const f = Math.max(0, Math.min(1, availabilityFactor));
    factors.availability = f;
    score *= f;
  }

  // Urge is recorded for groups and does not change the score.
  factors.urge = urgeFrom(context);
  factors.urgeMultiplier = 1;

  // Clamp
  score = Math.max(0, Math.min(0.95, score));
  factors.finalScore = score;

  // Roll the dice. Capture the roll so a skip can explain itself in the logs
  // ("score 0.18, rolled 0.44") — it rides along in factors on both paths.
  const roll = Math.random();
  factors.roll = roll;
  if (roll < score) {
    // Check burst AFTER deciding to respond (not while capped: checkBurst trips a
    // cooldown, and nothing is sent now — the catch-up re-checks it when it fires)
    if (!capped && checkBurst(msg.groupJid)) {
      logger.debug({ groupJid: msg.groupJid }, 'Burst detected, entering cooldown');
      return skip('burst_cooldown', factors);
    }

    // Decide response type. reactTendency f scales the reaction share (0.20·f); the
    // text share gives up the same delta, so f = 1 keeps the 0.70 / 0.90 cuts exactly.
    const reactF = knobs.reactTendency();
    const textCut = 0.70 - 0.20 * (reactF - 1);
    const typeRoll = Math.random();
    let responseType;
    if (typeRoll < textCut) responseType = 'text';
    else if (typeRoll < 0.90) responseType = 'reaction';
    else responseType = 'text_and_reaction';

    // A reaction-only outcome doesn't earn a text catch-up later.
    if (capped) return capSkip(responseType !== 'reaction');
    return respond(score, factors, responseType);
  }

  // Didn't pass threshold, but maybe react (5% chance; × reactTendency, ≤ 15%)
  if (Math.random() < Math.min(0.15, 0.05 * knobs.reactTendency()) && msg.content) {
    return capped ? capSkip(false) : respond(score, factors, 'reaction');
  }

  return capped ? capSkip(false) : skip('probability', factors);
}

// ── Factor computation ──

const CATCH_UP_TRIGGERS_MAX = 3;

/**
 * A catch-up's queued triggers (context.catchUp.triggerIds, ≤ 3 msg ids from life's
 * queue) as message-like objects, read from this chat's own stored messages only.
 * The turn's own message is skipped (already scored). Any error → no triggers.
 */
function loadCatchUpTriggers(catchUp, msg) {
  const ids = Array.isArray(catchUp?.triggerIds)
    ? [...new Set(catchUp.triggerIds.filter(id => typeof id === 'string' && id && id !== msg.id))].slice(0, CATCH_UP_TRIGGERS_MAX)
    : [];
  if (!ids.length || !msg.groupJid) return [];
  try {
    const rows = getDb().prepare(
      `SELECT id, content, quoted_id, quoted_content, metadata_json FROM messages
       WHERE group_jid = ? AND is_from_self = 0 AND (expires_at IS NULL OR expires_at > unixepoch())
         AND id IN (${ids.map(() => '?').join(',')})`,
    ).all(msg.groupJid, ...ids);
    return rows.map(r => {
      let metadata = {};
      try { metadata = JSON.parse(r.metadata_json || '{}') || {}; } catch { /* unreadable → no mention metadata */ }
      return { id: r.id, content: r.content, quotedId: r.quoted_id, quotedContent: r.quoted_content, metadata };
    });
  } catch (err) {
    logger.debug({ err: err.message }, 'Catch-up triggers unreadable — scoring the turn message only');
    return [];
  }
}

function isDirectMention(msg, botJid, botLid) {
  // Check WhatsApp @mention metadata
  if (isMentionedByJid(msg, botJid, botLid)) return true;

  // Check text-based name mention
  if (!msg.content) return false;
  return SELF_NAMES.some(name => textHasName(msg.content, name));
}

// Only the bot's own JID/LID counts — tagging a friend is not a mention of us.
function isMentionedByJid(msg, botJid, botLid) {
  return isBotMentionedByJid(msg.metadata?.mentionedJids, { botJid, botLid, configPhone: config.phoneNumber });
}

// The turn's message and any catch-up triggers: the strongest one counts.
function mentionFactorOf(msg, triggers, botJid, botLid) {
  let f = computeMentionFactor(msg, botJid, botLid);
  for (const t of triggers) f = Math.max(f, computeMentionFactor(t, botJid, botLid));
  return f;
}

function computeMentionFactor(msg, botJid, botLid) {
  // WhatsApp @mention (checks JID metadata)
  if (isMentionedByJid(msg, botJid, botLid)) return 6.0;

  // Direct name mention in text
  const lower = (msg.content || '').toLowerCase();
  if (lower && SELF_NAMES.some(name => textHasName(lower, name))) return 6.0;

  // Reply to our message — text or media (a voice note, sticker or captionless image
  // has no quoted text), in this chat
  if (msg.quotedId) {
    const quoted = getDb().prepare('SELECT is_from_self FROM messages WHERE id = ? AND group_jid = ?').get(msg.quotedId, msg.groupJid);
    if (quoted?.is_from_self) return 5.0;
  }
  if (!lower) return 1.0;

  // Generic address
  if (/\b(anyone|guys|everyone|makkale|aarelum|aare)\b/i.test(lower)) return 1.5;

  return 1.0;
}

function computeCommandFactor(content) {
  if (!content) return 1.0;
  const lower = content.toLowerCase();

  // Singing requests
  if (/\b(sing|padi|paatu|paad|gaanam|oru paattu)\b/i.test(lower)) return 3.0;

  // Drawing/image requests
  if (/\b(draw|sketch|generate|make an? image|picture)\b/i.test(lower)) return 2.5;

  return 1.0;
}

function computeQuestionFactor(content) {
  if (!content) return 1.0;

  // Direct question
  if (content.includes('?')) return 2.0;

  // Opinion solicitation
  if (/what do you.*(think|say|feel)|entha.*parayunne|how about/i.test(content)) return 2.5;

  return 1.0;
}

function computeHumorFactor(msg) {
  if (!msg.content) return 1.0;
  const content = msg.content;

  // Self-deprecation
  if (/i('m| am).*(stupid|dumb|idiot|useless)|ente.*kashtam/i.test(content)) return 1.8;

  // Exaggeration
  if (/literally|seriously dying|100%|definitely not/i.test(content)) return 1.5;

  // ALL CAPS (shouting)
  if (content.length > 5 && content === content.toUpperCase()) return 1.5;

  return 1.0;
}

function computeMomentumFactor(chatJid) {
  const recent = getRecentMessages(chatJid, 20);
  const now = Math.floor(Date.now() / 1000);
  const last5min = recent.filter(m => (now - m.timestamp) < 300 && !m.is_from_self);

  if (last5min.length >= 10) return 0.4;  // Very active chat — stay quiet
  if (last5min.length >= 6) return 0.6;   // Active — be selective
  if (last5min.length >= 3) return 1.0;   // Normal activity
  if (last5min.length >= 1) return 1.3;   // Quiet — contribution welcome
  return 0.8;                              // Dead chat — slight suppress, don't randomly resurrect
}

function computeRecencyFactor(chatJid) {
  const secsSinceLast = getSecondsSinceLastResponse(chatJid);

  // Check if bot is in an active conversation (last non-self message came
  // right after the bot's message — someone is talking TO the bot)
  const recent = getRecentMessages(chatJid, 4);
  const lastNonSelf = recent.filter(m => !m.is_from_self).at(-1);
  const lastSelf = recent.filter(m => m.is_from_self).at(-1);
  const inActiveConvo = lastSelf && lastNonSelf
    && lastNonSelf.timestamp >= lastSelf.timestamp;  // someone replied after bot spoke

  if (inActiveConvo) {
    // Relax suppression — bot is part of the conversation
    if (secsSinceLast < 60) return 0.6;
    if (secsSinceLast < 180) return 0.8;
    return 1.0;
  }

  // Normal suppression — bot is not being addressed
  if (secsSinceLast < 60) return 0.1;    // Just spoke — almost never respond again
  if (secsSinceLast < 180) return 0.3;   // Spoke recently
  if (secsSinceLast < 600) return 0.7;   // A few minutes ago
  return 1.0;                             // 10+ min silence — normal rate
}

function computeConversationFactor(chatJid) {
  // Detect when two people are in a back-and-forth
  const recent = getRecentMessages(chatJid, 6);

  // Check if bot is one of the participants (include self messages)
  const lastFewAll = recent.slice(-4);
  const allSenders = new Set(lastFewAll.map(m => m.is_from_self ? '__self__' : m.sender_jid));
  if (allSenders.has('__self__') && allSenders.size === 2) {
    // Bot is in a back-and-forth with someone — boost, don't suppress
    return 1.2;
  }

  // Check for two OTHER people in a back-and-forth — suppress jumping in
  const nonSelf = recent.filter(m => !m.is_from_self);
  if (nonSelf.length < 3) return 1.0;

  const lastFew = nonSelf.slice(-4);
  const senders = new Set(lastFew.map(m => m.sender_jid));

  if (senders.size === 2 && lastFew.length >= 4) return 0.2; // Strong back-and-forth
  if (senders.size === 2 && lastFew.length >= 3) return 0.4; // Mild back-and-forth
  return 1.0;
}

function computeBsFactor(content) {
  if (!content) return 1.0;
  const lower = content.toLowerCase();

  // Forwarded chain messages
  if (/forwarded|forward this|share this to|send to \d+ people/i.test(lower)) return 3.5;

  // Humble brag patterns
  if (/so annoying.*(first class|promotion|offer)|hate being.*(beautiful|rich|smart)/i.test(lower)) return 2.5;

  return 1.0;
}

function computeImitationCadenceFactor(activeHours) {
  const total = activeHours.reduce((s, n) => s + n, 0);
  if (!total) return 1.0;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(formatter.format(new Date()), 10);
  const share = activeHours[hour] / total; // uniform baseline ≈ 1/24 ≈ 0.042
  if (share < 0.01) return 0.4;   // they're basically never active now
  if (share < 0.025) return 0.7;  // below their normal activity
  if (share > 0.08) return 1.3;   // one of their peak hours
  return 1.0;
}

// ── Helpers ──

function respond(score, factors, responseType) {
  return { shouldRespond: true, responseType, score, factors };
}

function skip(reason, factors) {
  return { shouldRespond: false, responseType: 'skip', score: 0, factors: { ...factors, skipReason: reason } };
}
