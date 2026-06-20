import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config, getPersona } from './utils/config.js';
import { logger } from './utils/logger.js';
import { runMigrations, closeDb } from './memory/db.js';
import { connectToWhatsApp, disconnectFromWhatsApp } from './whatsapp/connection.js';
import { registerEventHandlers, setMessageProcessor, buildQuotedWAMessage } from './whatsapp/events.js';
import { sendText, sendReaction, sendImage, sendVoiceNote, sendSticker, sendGif, sendRecording, stopTyping, setPresence } from './whatsapp/actions.js';
import { decide } from './brain/decisionEngine.js';
import { generateResponse } from './brain/contextBuilder.js';
import { postProcess, maybeSplit, pickReactionEmoji } from './brain/postProcess.js';
import { waitResponseDelay, simulateTyping, delayedReadReceipt, interMessagePause } from './behavior/timing.js';
import { extractHeuristics, maybeRunBatchAnalysis } from './memory/learningPipeline.js';
import { checkWarmup, recordSent } from './behavior/warmup.js';
import { getDb } from './memory/db.js';
// activeFlows used by skills directly, not needed here anymore
import { cleanExpiredMemories, decayMemories } from './memory/relationshipStore.js';
import { evaluateResponse, recordQuality } from './brain/qualityGate.js';
import { getRecentMessages } from './memory/messageStore.js';
import { loadSkills, runSkills } from './skills/skillRunner.js';
import { extractImageMarker, generateImage, editImage } from './brain/imageGen.js';
import { extractVoiceMarker, extractSingMarker, generateVoiceNote } from './brain/voiceGen.js';
import { extractStickerMarker, extractGifMarker, searchGiphy } from './brain/mediaSearch.js';
import { closeBrowser } from './brain/webBrowse.js';
import { expireAllActiveBills, expireStaleBills } from './memory/billStore.js';
import { findPersonInGroupByName, findPersonInGroupByPhoneSuffix } from './memory/peopleStore.js';
import { phoneFromJid } from './utils/jidUtils.js';
import { startDashboard } from './dashboard/server.js';
import { emitDashboardEvent } from './dashboard/events.js';
import { isGroupMuted, loadMutedGroups } from './dashboard/state.js';

logger.info({
  dryRun: config.dryRun,
  provider: config.llm.provider,
  model: config.llm.model,
}, `${getPersona().name} starting up...`);

// ── Initialize database ──
runMigrations();

// ── Expire any ACTIVE bill splits from a previous session ──
try {
  const result = expireAllActiveBills();
  if (result.changes > 0) {
    logger.info({ count: result.changes }, 'Expired stale bill splits from previous session');
  }
} catch (err) {
  logger.debug({ err: err.message }, 'Failed to expire stale bills on startup (non-critical)');
}

// ── Periodic memory maintenance ──
function runMemoryMaintenance() {
  try {
    const expired = cleanExpiredMemories();
    const decayed = decayMemories();
    const staleBills = expireStaleBills(2 * 60 * 60); // 2 hours
    if (expired > 0 || decayed.changes > 0 || staleBills.changes > 0) {
      logger.info({ expired, decayed: decayed.changes, staleBills: staleBills.changes }, 'Memory maintenance complete');
    }
  } catch (err) {
    logger.debug({ err }, 'Memory maintenance error (non-critical)');
  }
}
runMemoryMaintenance(); // run once on startup
setInterval(runMemoryMaintenance, 6 * 60 * 60 * 1000); // then every 6 hours

// ── Outcome narrative ───────────────────────────────────────────────────────
// One human-readable line per evaluated message saying what the bot did and why.
// `evt` drives the dashboard live-log category tag (reply | react | skip | block);
// the sentence reads naturally in plain stdout/journald too. Structured fields
// (score, factors, reason, group, msgId) ride along so the dashboard can render the
// "why" without dumping raw JSON. Emitted at info so every decision is visible by
// default on the live-logs page.
function logOutcome(evt, sentence, fields = {}) {
  logger.info({ evt, ...fields }, sentence);
}

// ── Message processing pipeline ──
async function processMessage(sock, msg, context) {
  const startTime = Date.now();

  // 1. Run heuristic learning (async, fire-and-forget)
  try { extractHeuristics(msg); } catch {}

  // 2. Schedule batch analysis check
  maybeRunBatchAnalysis(msg.groupJid).catch(() => {});

  // 3. Delayed read receipt
  if (context.rawMsg?.key) {
    delayedReadReceipt(sock, context.rawMsg.key);
  }

  // 3.4. Muted groups: skip response pipeline entirely. Learning + read
  // receipts still happen above — we observe but stay silent.
  if (context.isGroup && msg.groupJid && isGroupMuted(msg.groupJid)) {
    logOutcome('block', 'Suppressed — group is muted', { msgId: msg.id, group: msg.groupJid, reason: 'group muted' });
    return;
  }

  // 3.5. Skills intercept (bypasses decision engine + LLM if matched)
  const skillResult = await runSkills(sock, msg, context);
  if (skillResult.handled) return;

  // 4. Decision engine
  const decision = decide(msg, context);

  // 4.5. Edit-replied-image branch — direct path, bypasses LLM.
  // Triggers when:
  //   - DM: any reply to an image with text (no mention needed — it's 1:1)
  //   - Group: reply to an image AND (@mentioned OR explicit edit-intent keywords in text)
  // Edit-intent regex covers typical image-editing verbs so the bot responds even
  // when users in a group don't @-tag it (they often just say "edit this" / "add a …").
  const editIntentRegex = /\b(edit|modify|photoshop|recolor|colorize|colorise|enhance|inpaint|uncrop|outpaint|animate)\b|\b(add|put|place|stick|replace|remove|erase|delete|crop)\s+(a|an|the|some|this|that|him|her|them|it|in|on|to|from)\b|\b(make|turn|change)\s+(this|it|him|her|them|the\s+\w+)\b/i;
  const mentionFactor = decision.factors?.mention ?? 0;
  const isMentionEarly = mentionFactor >= 5.0;
  const quotedIsImage = msg.quotedMessageType === 'image' && !!msg.quotedRawMessage;
  const hasEditIntent = !!(msg.content && editIntentRegex.test(msg.content));
  const editIntentAllowed = context.isDm || isMentionEarly || hasEditIntent;

  if (quotedIsImage) {
    logger.debug({
      msgId: msg.id,
      isDm: context.isDm,
      isMentionEarly,
      mentionFactor,
      hasEditIntent,
      editIntentAllowed,
      imageGenEnabled: config.imageGen.enabled,
    }, 'Quoted image detected on incoming message');
  }

  if (quotedIsImage && editIntentAllowed && config.imageGen.enabled) {
    const editPrompt = (msg.content || '').replace(/@\S+/g, '').trim();
    if (editPrompt) {
      const quotedWAMsg = buildQuotedWAMessage(msg);
      if (quotedWAMsg) {
        logger.info({ msgId: msg.id, isDm: context.isDm, prompt: editPrompt.slice(0, 80) }, 'Image edit request detected');
        try {
          await simulateTyping(sock, msg.groupJid, 400);
          const buffer = await downloadMediaMessage(quotedWAMsg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });
          if (!buffer || !buffer.length) {
            logger.warn({ msgId: msg.id }, 'Quoted image downloaded as empty buffer');
          } else {
            const mimeType = (msg.quotedRawMessage.imageMessage?.mimetype || 'image/jpeg').split(';')[0];
            logger.debug({ msgId: msg.id, bufferSize: buffer.length, mimeType }, 'Quoted image downloaded');
            const edited = await editImage(buffer, mimeType, editPrompt);
            if (edited) {
              await sendImage(sock, msg.groupJid, edited.buffer, '', context);
              recordSent();
              logger.info({ msgId: msg.id }, 'Image edit response sent');
              return;
            }
            logger.warn({ msgId: msg.id }, 'Image edit returned null, falling through to normal flow');
          }
        } catch (err) {
          logger.warn({ err: err.message, msgId: msg.id }, 'Image edit failed, falling through');
        }
      } else {
        logger.warn({ msgId: msg.id, hasQuotedId: !!msg.quotedId, hasParticipant: !!msg.quotedParticipant }, 'buildQuotedWAMessage returned null despite quoted image');
      }
    } else {
      logger.debug({ msgId: msg.id }, 'Quoted image but empty edit prompt after stripping mentions');
    }
  }

  // Check if message looks like an explicit image generation request
  const looksLikeImageRequest = msg.content && /\b(draw|generate|create|imagine)\b|\b(send|make|show)\b.*\b(image|picture|photo|pic|meme|nudes?)\b|\b(image|picture|photo|pic|meme)\b.*\b(of|for|about)\b/i.test(msg.content);

  // Log the decision
  try {
    getDb().prepare(
      `INSERT INTO response_log (message_id, group_jid, score, decided, factors_json, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())`
    ).run(msg.id, msg.groupJid, decision.score, decision.responseType, JSON.stringify(decision.factors));
  } catch (err) {
    logger.debug({ err: err.message, msgId: msg.id }, 'Failed to write decision to response_log (non-critical)');
  }

  emitDashboardEvent('decision', {
    messageId: msg.id,
    groupJid: msg.groupJid,
    senderName: msg.senderName,
    content: msg.content?.slice(0, 200),
    score: decision.score,
    decided: decision.responseType,
    shouldRespond: decision.shouldRespond,
    factors: decision.factors,
  });

  if (!decision.shouldRespond && !looksLikeImageRequest) {
    const reason = decision.factors.skipReason || 'unknown';
    const isGuard = reason.startsWith('rate_limited') || reason === 'burst_cooldown';
    let sentence;
    if (reason === 'burst_cooldown') sentence = 'Suppressed — burst cooldown (replying too fast)';
    else if (reason.startsWith('rate_limited')) sentence = `Suppressed — rate-limited (${reason.replace('rate_limited: ', '')})`;
    else if (reason === 'probability') sentence = "Stayed silent — message didn't clear the response bar";
    else sentence = `Stayed silent — ${reason}`;
    logOutcome(isGuard ? 'block' : 'skip', sentence, {
      msgId: msg.id,
      group: msg.groupJid,
      sender: msg.senderName,
      score: decision.factors.finalScore ?? decision.score,
      factors: decision.factors,
      reason,
    });
    return;
  }

  // 5. Check warm-up constraints
  const warmup = checkWarmup(decision.responseType);
  if (!warmup.allowed) {
    logOutcome('block', `Suppressed — ${warmup.reason}`, { msgId: msg.id, group: msg.groupJid, reason: warmup.reason });
    return;
  }

  // 6. Handle reaction-only responses (but not if it looks like an image request)
  if (decision.responseType === 'reaction' && !looksLikeImageRequest) {
    const emoji = pickReactionEmoji(msg.content);
    await waitResponseDelay({ isDm: context.isDm });
    await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
    recordSent();
    logOutcome('react', `Reacted ${emoji} to ${msg.senderName || 'someone'}`, {
      msgId: msg.id, group: msg.groupJid, sender: msg.senderName, emoji, score: decision.score, factors: decision.factors,
    });
    return;
  }

  // 7. Generate LLM response (a web search/browse loop may run inside, so time it
  //    and credit that time against the response delay below).
  const genStart = Date.now();
  let llmResult = await generateResponse(msg, context, { sock });
  const genMs = Date.now() - genStart;

  // 7a. Fallback: if LLM skipped but this is an explicit image request, generate directly
  if (!llmResult && looksLikeImageRequest && config.imageGen.enabled) {
    const prompt = msg.content.replace(/@\S+/g, '').trim();
    logger.info({ msgId: msg.id, prompt: prompt.slice(0, 80) }, 'LLM skipped image request, generating directly');
    await simulateTyping(sock, msg.groupJid, 200);
    const image = await generateImage(prompt);
    if (image) {
      await sendImage(sock, msg.groupJid, image.buffer, '', context);
      recordSent();
      return;
    }
  }

  if (!llmResult) {
    // LLM chose to skip ([SKIP]) or generation failed — either way the bot stays
    // silent. Any failure detail is logged separately in llm.js as an `issue`.
    logOutcome('skip', 'Stayed silent — model declined or generation failed', { msgId: msg.id, group: msg.groupJid });
    // maybe still react
    if (Math.random() < 0.1 && msg.content) {
      const emoji = pickReactionEmoji(msg.content);
      await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
    }
    return;
  }

  // 7.5. Check for image generation marker
  const imageRequest = extractImageMarker(llmResult.text);

  // 7.6. Check for sticker/GIF markers (mutually exclusive — sticker wins)
  const afterImage = imageRequest ? imageRequest.caption : llmResult.text;
  const stickerRequest = extractStickerMarker(afterImage);
  const afterSticker = stickerRequest ? stickerRequest.caption : afterImage;
  const gifRequest = !stickerRequest ? extractGifMarker(afterSticker) : null;
  const afterGif = gifRequest ? gifRequest.caption : afterSticker;

  // 7.7. Check for voice/sing note marker
  const singRequest = extractSingMarker(afterGif);
  const voiceRequest = singRequest || extractVoiceMarker(afterGif);
  const isSing = !!singRequest;

  // 8. Post-process (with fixation safety net)
  const textToProcess = voiceRequest
    ? voiceRequest.caption
    : stickerRequest
      ? stickerRequest.caption
      : gifRequest
        ? gifRequest.caption
        : (imageRequest ? imageRequest.caption : llmResult.text);

  // Resolver for @-mention tokens emitted by the LLM (e.g. "@Rohith" or "@5432").
  // Only wired up for groups — DMs don't need tagging.
  const peopleResolver = (token) => {
    if (!context.isGroup) return null;
    const t = String(token || '').trim();
    if (!t) return null;
    // Pure-digit token → phone suffix match; otherwise name match.
    const digitsOnly = t.replace(/\D/g, '');
    let hit = null;
    if (digitsOnly && digitsOnly.length >= 4 && /^\+?\d+$/.test(t)) {
      hit = findPersonInGroupByPhoneSuffix(msg.groupJid, digitsOnly);
    } else {
      hit = findPersonInGroupByName(msg.groupJid, t);
    }
    if (!hit) return null;
    // WhatsApp only renders a tappable mention when the literal text is `@<userpart-of-JID>`.
    // Clients map the digits to the saved contact name on the receiver's side.
    const userpart = phoneFromJid(hit.jid);
    const display = /^\d{5,}$/.test(userpart || '') ? userpart : t;
    return { jid: hit.jid, displayText: display };
  };

  const processed = textToProcess
    ? postProcess(textToProcess, llmResult.fixatedWords, { isGroup: context.isGroup, peopleResolver })
    : null;
  // `processed` is { text, replyToId, mentions } when opts is provided, or null if text stripped to nothing.
  const processedText = processed?.text || null;
  const processedReplyToId = processed?.replyToId || null;
  const processedMentions = processed?.mentions || [];

  if (!imageRequest && !voiceRequest && !stickerRequest && !gifRequest && !processedText) {
    logOutcome('skip', 'Stayed silent — response was emptied by cleanup', { msgId: msg.id, group: msg.groupJid });
    return;
  }

  // Resolve [REPLY:<suffix>] to a concrete message id in this chat (suffix match on id).
  let replyQuoteKey = null;
  if (processedReplyToId && context.isGroup) {
    try {
      const row = getDb().prepare(
        `SELECT id FROM messages WHERE group_jid = ? AND id LIKE ? ORDER BY timestamp DESC LIMIT 1`
      ).get(msg.groupJid, `%${processedReplyToId}`);
      if (row?.id) replyQuoteKey = { id: row.id };
    } catch (err) {
      logger.debug({ err: err.message, msgId: msg.id }, 'Reply-target resolution failed (non-critical)');
    }
  }

  // 8.5. Quality gate — LLM-as-judge before sending (skip for image/voice/sticker/gif responses)
  const isMention = decision.factors.mention >= 5.0;
  if (!imageRequest && !voiceRequest && !stickerRequest && !gifRequest && context.isGroup) {
    const recentForGate = getRecentMessages(msg.groupJid, 5)
      .filter(m => !m.is_from_self)
      .slice(-5)
      .map(m => `[${m.sender_name || 'Unknown'}]: ${m.content || `[${m.message_type}]`}`)
      .join('\n');

    const gateResult = await evaluateResponse(processedText, recentForGate, { isMention });

    if (!gateResult.pass) {
      logOutcome('block', `Blocked by quality gate — ${gateResult.reason || 'low quality'}`, {
        msgId: msg.id,
        group: msg.groupJid,
        sender: msg.senderName,
        score: gateResult.score,
        reason: gateResult.reason,
        latencyMs: gateResult.latencyMs,
      });

      recordQuality({
        messageId: `gated_${msg.id}_${Date.now()}`,
        groupJid: msg.groupJid,
        responseText: processedText,
        triggerMsgId: msg.id,
        score: gateResult.score,
        reason: gateResult.reason,
        latencyMs: gateResult.latencyMs,
        wasGated: true,
      });

      // Downgrade: maybe send a reaction instead of gibberish
      if (Math.random() < 0.3 && msg.content) {
        const emoji = pickReactionEmoji(msg.content);
        await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
      }
      return;
    }
  }

  // 9. Wait human-like delay
  const isQuestion = decision.factors.question >= 2.0;
  await waitResponseDelay({
    isMention,
    isQuestion,
    isDm: context.isDm,
    isDeadChat: decision.factors.momentum >= 1.8,
  }, { alreadyElapsedMs: genMs });

  // 10. Send response
  let sentMessageId = null;

  // First-message send opts: thread the @-mentions and (optionally) the quote-key
  // from the [REPLY:<id>] marker. Subsequent split parts go in clean.
  const firstSendOpts = {
    mentions: processedMentions.length ? processedMentions : undefined,
    quotedKey: replyQuoteKey || undefined,
  };

  // 10a. Voice note branch
  if (voiceRequest) {
    await sendRecording(sock, msg.groupJid);
    const voice = await generateVoiceNote(voiceRequest.text, { sing: isSing });
    await stopTyping(sock, msg.groupJid);
    if (voice) {
      const sent = await sendVoiceNote(sock, msg.groupJid, voice.buffer, voice.duration, context, { quotedKey: replyQuoteKey || undefined, waveform: voice.waveform });
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
      logger.info({ msgId: msg.id, duration: voice.duration }, 'Voice note sent');

      // Also send caption as text if present
      if (processedText) {
        await interMessagePause();
        await simulateTyping(sock, msg.groupJid, processedText.length);
        await sendText(sock, msg.groupJid, processedText, null, { mentions: firstSendOpts.mentions });
      }
    } else if (processedText) {
      // Fallback: voice gen failed, send just the caption as text
      await simulateTyping(sock, msg.groupJid, processedText.length);
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
    }
  } else if (stickerRequest) {
  // 10b. Sticker branch (GIPHY)
    await simulateTyping(sock, msg.groupJid, 200);
    const sticker = await searchGiphy(stickerRequest.query, 'sticker');
    if (sticker) {
      const sent = await sendSticker(sock, msg.groupJid, sticker.buffer, context, { quotedKey: replyQuoteKey || undefined });
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
      logger.info({ msgId: msg.id, query: stickerRequest.query, giphyId: sticker.id }, 'Sticker response sent');

      if (processedText) {
        await interMessagePause();
        await simulateTyping(sock, msg.groupJid, processedText.length);
        await sendText(sock, msg.groupJid, processedText, null, { mentions: firstSendOpts.mentions });
      }
    } else if (processedText) {
      await simulateTyping(sock, msg.groupJid, processedText.length);
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
    }
  } else if (gifRequest) {
  // 10c. GIF branch (GIPHY → MP4 with gifPlayback)
    await simulateTyping(sock, msg.groupJid, 200);
    const gif = await searchGiphy(gifRequest.query, 'gif');
    if (gif) {
      const sent = await sendGif(sock, msg.groupJid, gif.buffer, processedText || '', context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
      logger.info({ msgId: msg.id, query: gifRequest.query, giphyId: gif.id }, 'GIF response sent');
    } else if (processedText) {
      await simulateTyping(sock, msg.groupJid, processedText.length);
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
    }
  } else if (imageRequest) {
  // 10d. Image generation branch
    await simulateTyping(sock, msg.groupJid, 200);
    const image = await generateImage(imageRequest.prompt);
    if (image) {
      const sent = await sendImage(sock, msg.groupJid, image.buffer, processedText || '', context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
      logger.info({ msgId: msg.id, prompt: imageRequest.prompt.slice(0, 80) }, 'Image response sent');
    } else if (processedText) {
      // Fallback: image gen failed, send just the caption as text
      await simulateTyping(sock, msg.groupJid, processedText.length);
      const sent = await sendText(sock, msg.groupJid, processedText, context, firstSendOpts);
      if (sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();
    }
  } else {
    // 10e. Split message if needed
    const parts = maybeSplit(processedText);

    // 11. Type and send each part
    for (let i = 0; i < parts.length; i++) {
      await simulateTyping(sock, msg.groupJid, parts[i].length);
      const sent = await sendText(
        sock,
        msg.groupJid,
        parts[i],
        i === 0 ? context : null,
        i === 0 ? firstSendOpts : {},
      );
      if (i === 0 && sent?.key?.id) sentMessageId = sent.key.id;
      recordSent();

      if (i < parts.length - 1) {
        await interMessagePause();
      }
    }
  }

  // Record quality score for the sent response
  if (sentMessageId && context.isGroup) {
    try {
      recordQuality({
        messageId: sentMessageId,
        groupJid: msg.groupJid,
        responseText: processedText || '[generated image]',
        triggerMsgId: msg.id,
        score: null, // already evaluated above, score logged there
        reason: 'sent',
        latencyMs: 0,
        wasGated: false,
      });
    } catch (err) {
      logger.debug({ err: err.message, msgId: sentMessageId }, 'Failed to record sent-response quality (non-critical)');
    }
  }

  // 12. Maybe also react (for text_and_reaction type)
  if (decision.responseType === 'text_and_reaction' && msg.content) {
    const emoji = pickReactionEmoji(msg.content);
    await sendReaction(sock, msg.groupJid, msg.id, emoji, msg.senderJid);
  }

  const elapsed = Date.now() - startTime;
  logOutcome('reply', `Replied to ${msg.senderName || 'someone'}`, {
    msgId: msg.id,
    group: msg.groupJid,
    sender: msg.senderName,
    score: decision.score,
    factors: decision.factors,
    responseLen: processedText?.length || 0,
    imageGen: !!imageRequest,
    sticker: !!stickerRequest,
    gif: !!gifRequest,
    mentions: processedMentions.length,
    replyThreaded: !!replyQuoteKey,
    elapsedMs: elapsed,
  });
}

// ── Wire up the message processor ──
setMessageProcessor(processMessage);

// ── Connect to WhatsApp ──
async function start() {
  try {
    await loadSkills();

    let liveSock = null;
    loadMutedGroups();
    await startDashboard({ getSock: () => liveSock });

    await connectToWhatsApp(async (connectedSock) => {
      liveSock = connectedSock;
      registerEventHandlers(connectedSock);
      await setPresence(connectedSock, 'available');
      logger.info(`${getPersona().name} is ready`);
    });
  } catch (err) {
    logger.fatal({ err }, 'Failed to start');
    process.exit(1);
  }
}

// ── Graceful shutdown ──
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  // Close the headless browser first (raced with a timeout so a hung close can't
  // block exit) — prevents orphaned Chromium processes accumulating across restarts.
  try {
    await Promise.race([
      closeBrowser('shutdown'),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {}
  await disconnectFromWhatsApp();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── GO ──
start();
