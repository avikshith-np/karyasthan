import { buildSystemPrompt, buildConversationContext } from '../personality/systemPrompt.js';
import { callLlm } from './llm.js';
import { logger } from '../utils/logger.js';

/**
 * Generate a response from the LLM for a given message context.
 * Returns { text, fixatedWords } or null if it chose to skip / failed.
 */
export async function generateResponse(msg, context) {
  const { isGroup, isDm } = context;
  const chatJid = msg.groupJid;

  const systemPrompt = buildSystemPrompt(chatJid, isGroup);
  const { text: userMessage, fixatedWords } = buildConversationContext(chatJid, msg, isGroup);

  logger.debug({
    systemPromptLen: systemPrompt.length,
    userMessageLen: userMessage.length,
  }, 'Calling LLM');

  const response = await callLlm(systemPrompt, userMessage);

  if (!response) {
    logger.warn('LLM returned no response');
    return null;
  }

  // Check if the LLM decided to skip
  const trimmed = response.trim();
  if (trimmed === '[SKIP]' || trimmed === 'SKIP') {
    logger.debug('LLM chose to skip');
    return null;
  }

  return { text: trimmed, fixatedWords };
}
