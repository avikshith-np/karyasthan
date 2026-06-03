import { config, getPersona } from '../utils/config.js';
import { callLlm } from './llm.js';
import { getDb } from '../memory/db.js';
import { logger } from '../utils/logger.js';
import { hasReasoningArtifact } from './postProcess.js';

const GATE_SYSTEM_PROMPT = `You are a quality checker for a WhatsApp group chat bot named ${getPersona().name}.
You will be given a candidate bot response and the recent conversation context.
Rate the response on a 0.0-1.0 scale.

Scoring criteria:
- RELEVANCE (0-0.3): Does the response relate to what people are actually talking about? Is it directed at the right topic/person?
- COHERENCE (0-0.3): Is it grammatically sensible? Does it make logical sense? Is it gibberish or nonsensical?
- TONE (0-0.2): Does it sound like a natural WhatsApp message? Not robotic, not overly formal?
- VALUE (0-0.2): Does it add something? Is it better than saying nothing?

Return ONLY this JSON (no markdown, no explanation):
{"score": 0.7, "reason": "brief reason"}

HARD FAIL: If the candidate contains meta-commentary about its own wording or reasoning, a quoted draft of itself, self-approval ("Good.", "I used X", "this works"), or formatting scaffolding (bullets, stray asterisks), score 0.0 regardless of relevance — that is leaked chain-of-thought, not a chat message.

Score guide:
0.0-0.2: Gibberish, hallucination, or completely irrelevant
0.2-0.4: Poor — wrong topic, forced, or barely coherent
0.4-0.6: Acceptable — relevant but not great
0.6-0.8: Good — natural and on-topic
0.8-1.0: Excellent — witty, valuable, perfectly fitting`;

// Emoji sentiment for feedback tracking
const POSITIVE_EMOJIS = new Set(['😂', '🤣', '❤️', '🔥', '💯', '👑', '💪', '👏', '😍', '🫡', '❤', '♥️', '👍']);
const NEGATIVE_EMOJIS = new Set(['👎', '😡', '💩', '🤮', '🤡']);

/**
 * Evaluate a candidate response before sending.
 * Returns { pass, score, reason, latencyMs }
 */
export async function evaluateResponse(responseText, conversationSnippet, options = {}) {
  // Deterministic backstop — runs even when the LLM gate is disabled. postProcess
  // is the primary guard; anything that still smells of leaked chain-of-thought
  // here is blocked outright without spending an LLM call.
  if (hasReasoningArtifact(responseText)) {
    logger.warn({ responseText: responseText?.slice(0, 120) }, 'Quality gate: artifact leak (hard fail)');
    return { pass: false, score: 0, reason: 'artifact_leak', latencyMs: 0 };
  }

  if (!config.qualityGate.enabled) {
    return { pass: true, score: null, reason: 'gate_disabled', latencyMs: 0 };
  }

  const startTime = Date.now();

  try {
    const userMessage = `Recent conversation:\n${conversationSnippet}\n\nCandidate response from ${getPersona().name}:\n"${responseText}"\n\nRate this response.`;

    const response = await callLlm(GATE_SYSTEM_PROMPT, userMessage, {
      provider: config.qualityGate.provider,
      model: config.qualityGate.model,
      maxTokens: config.qualityGate.maxTokens,
      temperature: config.qualityGate.temperature,
      timeoutMs: config.qualityGate.timeoutMs,
      noFallback: true,
    });

    const latencyMs = Date.now() - startTime;

    if (!response) {
      logger.debug({ latencyMs }, 'Quality gate: no response (fail-open)');
      return { pass: true, score: null, reason: 'no_response', latencyMs };
    }

    // Parse JSON from response (handle potential markdown wrapping)
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      logger.debug({ response: response.slice(0, 100), latencyMs }, 'Quality gate: bad JSON (fail-open)');
      return { pass: true, score: null, reason: 'parse_error', latencyMs };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const score = typeof parsed.score === 'number' ? parsed.score : null;
    const reason = parsed.reason || 'unknown';

    if (score === null) {
      return { pass: true, score: null, reason: 'invalid_score', latencyMs };
    }

    // Select threshold based on whether this is a mention
    const threshold = options.isMention
      ? config.qualityGate.mentionThreshold
      : config.qualityGate.threshold;

    const pass = score >= threshold;

    logger.debug({ score, reason, threshold, pass, latencyMs }, 'Quality gate result');
    return { pass, score, reason, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    logger.debug({ err: err.message, latencyMs }, 'Quality gate error (fail-open)');
    return { pass: true, score: null, reason: `error: ${err.message}`, latencyMs };
  }
}

/**
 * Record a quality assessment to the database.
 */
export function recordQuality({ messageId, groupJid, responseText, triggerMsgId, score, reason, latencyMs, wasGated }) {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO response_quality
        (message_id, group_jid, response_text, trigger_msg_id, quality_score, quality_reason, quality_latency_ms, was_gated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(messageId, groupJid, responseText, triggerMsgId, score, reason, latencyMs, wasGated ? 1 : 0);
  } catch (err) {
    logger.debug({ err: err.message }, 'Failed to record quality (non-critical)');
  }
}

/**
 * Record a user reaction to a bot message.
 */
export function recordReaction(messageId, emoji, reactorJid) {
  try {
    const db = getDb();

    // Determine sentiment
    let sentiment = 'neutral';
    if (POSITIVE_EMOJIS.has(emoji)) sentiment = 'positive';
    else if (NEGATIVE_EMOJIS.has(emoji)) sentiment = 'negative';

    // Check if a response_quality row exists for this message
    const existing = db.prepare('SELECT id, user_reactions, reaction_count, positive_reactions, negative_reactions FROM response_quality WHERE message_id = ?').get(messageId);

    const reaction = { emoji, reactor_jid: reactorJid, timestamp: Math.floor(Date.now() / 1000), sentiment };

    if (existing) {
      const reactions = JSON.parse(existing.user_reactions || '[]');
      reactions.push(reaction);
      const posInc = sentiment === 'positive' ? 1 : 0;
      const negInc = sentiment === 'negative' ? 1 : 0;

      db.prepare(
        `UPDATE response_quality SET
          user_reactions = ?, reaction_count = reaction_count + 1,
          positive_reactions = positive_reactions + ?, negative_reactions = negative_reactions + ?,
          updated_at = unixepoch()
        WHERE id = ?`
      ).run(JSON.stringify(reactions), posInc, negInc, existing.id);
    } else {
      // Bot sent this message before quality gate was deployed — create a minimal row
      db.prepare(
        `INSERT OR IGNORE INTO response_quality
          (message_id, group_jid, user_reactions, reaction_count, positive_reactions, negative_reactions)
         VALUES (?, '', ?, 1, ?, ?)`
      ).run(messageId, JSON.stringify([reaction]), sentiment === 'positive' ? 1 : 0, sentiment === 'negative' ? 1 : 0);
    }

    logger.debug({ messageId, emoji, sentiment }, 'Recorded reaction feedback');
  } catch (err) {
    logger.debug({ err: err.message }, 'Failed to record reaction (non-critical)');
  }
}

/**
 * Get quality insights for a group (for system prompt feedback loop).
 * Returns a short text block or empty string if not enough data.
 */
export function getQualityInsights(groupJid) {
  try {
    const db = getDb();
    const recent = db.prepare(
      `SELECT quality_score, quality_reason, response_text, positive_reactions, negative_reactions
       FROM response_quality
       WHERE group_jid = ? AND was_gated = 0 AND quality_score IS NOT NULL
       ORDER BY created_at DESC LIMIT 20`
    ).all(groupJid);

    if (recent.length < 5) return '';

    const avgScore = recent.reduce((sum, r) => sum + r.quality_score, 0) / recent.length;
    const totalPos = recent.reduce((sum, r) => sum + r.positive_reactions, 0);
    const totalNeg = recent.reduce((sum, r) => sum + r.negative_reactions, 0);

    // Find well-received responses (high score + positive reactions)
    const good = recent
      .filter(r => r.quality_score >= 0.6 && r.positive_reactions > 0)
      .slice(0, 3);

    // Find poorly-received responses
    const bad = recent
      .filter(r => r.quality_score < 0.4 || r.negative_reactions > 0)
      .slice(0, 2);

    const parts = [`\n## Response quality (avg: ${avgScore.toFixed(2)}, +${totalPos} -${totalNeg} reactions)`];

    if (good.length > 0) {
      parts.push('What worked:');
      for (const r of good) {
        parts.push(`- "${r.response_text?.slice(0, 60)}" (${r.quality_reason})`);
      }
    }

    if (bad.length > 0) {
      parts.push('What to avoid:');
      for (const r of bad) {
        parts.push(`- "${r.response_text?.slice(0, 60)}" (${r.quality_reason})`);
      }
    }

    return parts.join('\n');
  } catch {
    return '';
  }
}
