import { config, getPersona } from '../utils/config.js';
import { callRole } from './llm.js';
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

// Upper bound on a caller's guard note in the judge prompt (code-written today; a cap keeps it bounded).
const GUARD_NOTE_MAX = 600;

// Emoji sentiment for feedback tracking
const POSITIVE_EMOJIS = new Set(['😂', '🤣', '❤️', '🔥', '💯', '👑', '💪', '👏', '😍', '🫡', '❤', '♥️', '👍']);
const NEGATIVE_EMOJIS = new Set(['👎', '😡', '💩', '🤮', '🤡']);

/**
 * Evaluate a candidate response before sending.
 * Returns { pass, score, reason, latencyMs }
 *
 * options: { isMention, imitate, clonedVoice, harmNote, caller,
 *   sneak      life sneak turn → the mention threshold (spec 009 FR-024),
 *   guardNote  life embargo note appended to the judge prompt (spec 009 §R15) }
 */
export async function evaluateResponse(responseText, conversationSnippet, options = {}) {
  // Deterministic backstop — runs even when the LLM gate is disabled. postProcess
  // is the primary guard; anything that still smells of leaked chain-of-thought
  // here is blocked outright without spending an LLM call.
  if (hasReasoningArtifact(responseText)) {
    logger.warn({ responseText: responseText?.slice(0, 120) }, 'Quality gate: artifact leak (hard fail)');
    return { pass: false, score: 0, reason: 'artifact_leak', latencyMs: 0 };
  }

  // A voice note in a member's CLONED voice fails closed: no verdict → not sent
  // (the caller falls back to nothing, never to an unjudged impersonation).
  const failOpen = (reason, latencyMs) => options.clonedVoice
    ? { pass: false, score: null, reason: `${reason} (cloned voice fails closed)`, latencyMs }
    : { pass: true, score: null, reason, latencyMs };

  if (!config.qualityGate.enabled) {
    return failOpen('gate_disabled', 0);
  }

  const startTime = Date.now();

  try {
    // Imitate mode: the candidate deliberately wears a group member's voice —
    // judge believability-in-context, not assistant helpfulness or persona fit.
    const systemPrompt = options.imitate
      ? `${GATE_SYSTEM_PROMPT}\n\nNOTE: This reply is deliberately imitating a specific group member's writing style (their casing, slang, terseness, quirks). Score believability-in-context — do NOT penalize it for being terse, oddly cased, or unlike ${getPersona().name}'s usual voice.`
      : GATE_SYSTEM_PROMPT;
    const fullSystemPrompt = options.clonedVoice
      ? `${systemPrompt}\n\nNOTE: This text will be SPOKEN ALOUD in that member's real (cloned) voice as a voice note. Score 0.0 if it asks anyone for money, OTPs, passwords, or personal details; makes promises, commitments or confessions on the member's behalf; or could damage the member's reputation or relationships. Sound cues like <laugh> are allowed.`
      : systemPrompt;
    // A caller-written harm note (e.g. relay.js: a message passed on for a member).
    const harmedPrompt = typeof options.harmNote === 'string' && options.harmNote.trim()
      ? `${fullSystemPrompt}\n\nNOTE: ${options.harmNote.trim()}`
      : fullSystemPrompt;
    // A life guard note (spec 009 §R15: lifeGuardNote() during a heavy-event
    // embargo — no asking anyone for money/help, no unprompted personal news in a
    // group). Additive: appended after any harm note, both apply.
    const judgeSystemPrompt = typeof options.guardNote === 'string' && options.guardNote.trim()
      ? `${harmedPrompt}\n\nNOTE: ${options.guardNote.trim().slice(0, GUARD_NOTE_MAX)}`
      : harmedPrompt;

    const candidateAuthor = options.imitate ? 'the bot (imitating a group member)' : getPersona().name;
    const userMessage = `Recent conversation:\n${conversationSnippet}\n\nCandidate response from ${candidateAuthor}:\n"${responseText}"\n\nRate this response.`;

    // The `gate` role supplies provider, model, effort, maxTokens, timeoutMs and its
    // fallback chain (empty fallback → mouth's), so a flaky/slow primary judge
    // doesn't silently bypass the gate; each chain link is bounded by timeoutMs.
    const res = await callRole('gate', judgeSystemPrompt, userMessage, {
      caller: typeof options.caller === 'string' && options.caller ? options.caller : 'gate',
      temperature: config.qualityGate.temperature,
    });
    const response = res?.text || null;

    const latencyMs = Date.now() - startTime;

    // Fail-open branches: when the judge can't produce a usable verdict we send the
    // (already-generated) reply anyway, but log it loudly (warn + evt:'issue') so a
    // silently-bypassed gate is visible on the dashboard and in journald. A skipped
    // judge (over budget, disabled, no key) takes the same path; a cloned voice
    // still fails closed via failOpen.
    if (!response) {
      const reason = res?.skipped ? `skipped_${res.skipped}` : 'no_response';
      logger.warn({ evt: 'issue', reason, latencyMs }, `Quality gate bypassed — judge ${res?.skipped ? `skipped (${res.skipped})` : 'returned no response'} (fail-open)`);
      return failOpen(reason, latencyMs);
    }

    // Parse JSON from response (handle potential markdown wrapping)
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      logger.warn({ evt: 'issue', reason: 'parse_error', latencyMs, response: response.slice(0, 100) }, 'Quality gate bypassed — judge output not parseable (fail-open)');
      return failOpen('parse_error', latencyMs);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const score = typeof parsed.score === 'number' ? parsed.score : null;
    const reason = parsed.reason || 'unknown';

    if (score === null) {
      logger.warn({ evt: 'issue', reason: 'invalid_score', latencyMs }, 'Quality gate bypassed — judge gave no numeric score (fail-open)');
      return failOpen('invalid_score', latencyMs);
    }

    // Select threshold: mentions, imitation replies and life sneak turns (spec 009:
    // a few words snuck in a meeting) use the softer bar — a deliberately terse
    // reply shouldn't be systematically gated.
    const threshold = (options.isMention || options.imitate || options.sneak)
      ? config.qualityGate.mentionThreshold
      : config.qualityGate.threshold;

    const pass = score >= threshold;

    logger.debug({ score, reason, threshold, pass, latencyMs }, 'Quality gate result');
    return { pass, score, reason, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    logger.warn({ evt: 'issue', reason: 'error', err: err.message, latencyMs }, 'Quality gate bypassed — judge call errored (fail-open)');
    return failOpen(`error: ${err.message}`, latencyMs);
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
