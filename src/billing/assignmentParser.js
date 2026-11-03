import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { geminiGenerate } from '../brain/geminiMedia.js';

const ASSIGNMENT_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: { type: 'string' },
      description: 'Full list of everyone eating. Keep existing names, add new ones. Use names from the People list verbatim.',
    },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemIndex: { type: 'integer', description: 'Zero-based index of the bill item.' },
          item: { type: 'string', description: 'Item name (only if itemIndex is unknown).' },
          people: {
            type: 'array',
            items: { type: 'string' },
            description: 'All people sharing this item.',
          },
        },
        required: ['people'],
      },
    },
    equal_split: { type: 'boolean', description: 'True only if the user explicitly wants to split equally.' },
    confirmed: { type: 'boolean', description: 'True only if all items were already assigned and user is confirming.' },
    not_about_bill: { type: 'boolean', description: 'True if the message is clearly unrelated to the split (side conversation, meta-question to another human).' },
    message: { type: 'string', description: 'Short casual reply to the user (1-3 lines).' },
  },
  required: ['message'],
};

/**
 * Parse a bill-split assignment message using native Gemini with schema-enforced JSON.
 * Returns the parsed object or null on failure.
 */
export async function parseAssignment(systemPrompt, userMessage, { maxTokens = 2048, temperature = 0.3 } = {}) {
  const model = config.billSplitModel || 'gemini-2.5-pro';

  try {
    // GEMINI_API_KEY only, header auth, `bill` budget, one llm_usage row (geminiMedia.js).
    const r = await geminiGenerate({
      label: 'bill',
      caller: 'bill.assign',
      model,
      role: 'user',
      parts: [{ text: userMessage }],
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ASSIGNMENT_SCHEMA,
        temperature,
        maxOutputTokens: maxTokens,
      },
    });

    if (!r.ok) {
      if (r.status === 'no_key') logger.warn('No Gemini API key for assignment parsing');
      else logger.warn({ status: r.status, model }, 'Assignment parser API error');
      return null;
    }

    const text = r.text;

    if (!text) {
      logger.warn({ userMessage: userMessage.slice(0, 200) }, 'Assignment parser returned empty response');
      return null;
    }

    return JSON.parse(text);
  } catch (err) {
    logger.warn({ err: err.message, userMessage: userMessage.slice(0, 200) }, 'Assignment parsing failed');
    return null;
  }
}
