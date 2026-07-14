import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getRecentMessages } from '../memory/messageStore.js';
import { checkRateLimit, getSecondsSinceLastResponse, checkBurst } from '../behavior/rateLimiter.js';
import { getDb } from '../memory/db.js';
import { phoneFromJid } from '../utils/jidUtils.js';
import { getActiveFlow, refreshFlow } from '../behavior/activeFlows.js';

// Names the bot responds to
const SELF_NAMES = getPersona().aliases;

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
  if (!msg.content && msg.messageType !== 'sticker') return skip('empty_content', factors);

  // ── DMs: always respond (bypass rate limits and sleep hours) ──
  if (isDm) {
    factors.dm = true;
    return respond(0.95, factors, 'text');
  }

  // ── Active flow: force response (e.g. bill splitting) ──
  if (isGroup) {
    const flow = getActiveFlow(msg.groupJid);
    if (flow) {
      factors.activeFlow = flow.type;
      refreshFlow(msg.groupJid);
      return respond(0.95, factors, 'text');
    }
  }

  // Check rate limits (but not for direct @mentions)
  const rateCheck = checkRateLimit(msg.groupJid);
  if (!rateCheck.allowed) {
    // Still allow if directly mentioned
    if (!isDirectMention(msg, botJid, botLid)) {
      return skip(`rate_limited: ${rateCheck.reason}`, factors);
    }
  }

  // Check sleep hours (temporarily disabled)
  // if (isSleepHours()) {
  //   return skip('sleep_hours', factors);
  // }

  // ── Group messages: probability system ──
  let score = config.responseRate;

  // Factor 1: Mention
  const mentionFactor = computeMentionFactor(msg, botJid, botLid);
  factors.mention = mentionFactor;
  score *= mentionFactor;

  // Hard override: direct @mention or reply to our message
  if (mentionFactor >= 5.0) {
    return respond(0.95, factors, 'text');
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

  // Factor 4: Conversation momentum
  const momentumFactor = computeMomentumFactor(msg.groupJid);
  factors.momentum = momentumFactor;
  score *= momentumFactor;

  // Factor 5: Recency (anti-spam backbone)
  const recencyFactor = computeRecencyFactor(msg.groupJid);
  factors.recency = recencyFactor;
  score *= recencyFactor;

  // Factor 6: BS detection
  const bsFactor = computeBsFactor(msg.content);
  factors.bs = bsFactor;
  score *= bsFactor;

  // Factor 7: Two-person conversation detection
  const convoFactor = computeConversationFactor(msg.groupJid);
  factors.conversation = convoFactor;
  score *= convoFactor;

  // Clamp
  score = Math.max(0, Math.min(0.95, score));
  factors.finalScore = score;

  // Roll the dice. Capture the roll so a skip can explain itself in the logs
  // ("score 0.18, rolled 0.44") — it rides along in factors on both paths.
  const roll = Math.random();
  factors.roll = roll;
  if (roll < score) {
    // Check burst AFTER deciding to respond
    if (checkBurst(msg.groupJid)) {
      logger.debug({ groupJid: msg.groupJid }, 'Burst detected, entering cooldown');
      return skip('burst_cooldown', factors);
    }

    // Decide response type
    const typeRoll = Math.random();
    let responseType;
    if (typeRoll < 0.70) responseType = 'text';
    else if (typeRoll < 0.90) responseType = 'reaction';
    else responseType = 'text_and_reaction';

    return respond(score, factors, responseType);
  }

  // Didn't pass threshold, but maybe react (5% chance)
  if (Math.random() < 0.05 && msg.content) {
    return respond(score, factors, 'reaction');
  }

  return skip('probability', factors);
}

// ── Factor computation ──

function isDirectMention(msg, botJid, botLid) {
  // Check WhatsApp @mention metadata
  if (isMentionedByJid(msg, botJid, botLid)) return true;

  // Check text-based name mention
  if (!msg.content) return false;
  const lower = msg.content.toLowerCase();
  return SELF_NAMES.some(name => lower.includes(name));
}

function isMentionedByJid(msg, botJid, botLid) {
  const mentionedJids = msg.metadata?.mentionedJids;
  if (!mentionedJids?.length) return false;
  const botPhone = botJid ? phoneFromJid(botJid) : null;
  const botLidId = botLid ? phoneFromJid(botLid) : null;
  const configPhone = config.phoneNumber;
  const matched = mentionedJids.some(jid => {
    const phone = phoneFromJid(jid);
    return (botPhone && phone === botPhone)
      || (botLidId && phone === botLidId)
      || (configPhone && phone === configPhone);
  });
  if (matched) return true;

  // LID mismatch fallback: single @mention is very likely for us
  if (mentionedJids.length === 1) {
    logger.debug({
      mentionedJids, botPhone, botLidId, configPhone,
    }, 'isMentionedByJid: LID mismatch fallback — assuming single @mention is for bot');
    return true;
  }
  return false;
}

function computeMentionFactor(msg, botJid, botLid) {
  // WhatsApp @mention (checks JID metadata)
  if (isMentionedByJid(msg, botJid, botLid)) return 6.0;

  if (!msg.content) return 1.0;
  const lower = msg.content.toLowerCase();

  // Direct name mention in text
  if (SELF_NAMES.some(name => lower.includes(name))) return 6.0;

  // Reply to our message
  if (msg.quotedContent !== null && msg.quotedId) {
    // Check if the quoted message was from us
    const db = getDb();
    const quoted = db.prepare('SELECT is_from_self FROM messages WHERE id = ?').get(msg.quotedId);
    if (quoted?.is_from_self) return 5.0;
  }

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

function isSleepHours() {
  const now = new Date();
  // Convert to configured timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(formatter.format(now), 10);

  const { sleepStartHour, sleepEndHour } = config;

  if (sleepStartHour < sleepEndHour) {
    return hour >= sleepStartHour && hour < sleepEndHour;
  }
  // Wraps around midnight (e.g., 23 to 7)
  return hour >= sleepStartHour || hour < sleepEndHour;
}

// ── Helpers ──

function respond(score, factors, responseType) {
  return { shouldRespond: true, responseType, score, factors };
}

function skip(reason, factors) {
  return { shouldRespond: false, responseType: 'skip', score: 0, factors: { ...factors, skipReason: reason } };
}
