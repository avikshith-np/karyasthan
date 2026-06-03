import { upsertNickname, upsertPerson } from './peopleStore.js';
import { upsertSlang } from './groupStore.js';
import { upsertRelationship, addMemory } from './relationshipStore.js';
import { getRecentMessages } from './messageStore.js';
import { callLlm } from '../brain/llm.js';
import { logger } from '../utils/logger.js';
import { hasEmoji } from '../utils/emoji.js';
import { getPersona } from '../utils/config.js';

// Counters for batched LLM analysis
const groupMessageCounts = new Map(); // groupJid → messages since last analysis
const BATCH_THRESHOLD = 100;

/**
 * Tier 1: Heuristic extraction (runs on every message, zero LLM cost)
 */
export function extractHeuristics(msg) {
  if (!msg.content) return;

  try {
    extractNicknames(msg);
    extractFacts(msg);
    trackSlang(msg);
  } catch (err) {
    logger.debug({ err }, 'Heuristic extraction error (non-critical)');
  }
}

/**
 * Tier 2: Check if we should run batched LLM analysis
 */
export async function maybeRunBatchAnalysis(chatJid) {
  const count = (groupMessageCounts.get(chatJid) || 0) + 1;
  groupMessageCounts.set(chatJid, count);

  if (count >= BATCH_THRESHOLD) {
    groupMessageCounts.set(chatJid, 0);
    await runBatchAnalysis(chatJid);
  }
}

// ── Nickname detection ──

function extractNicknames(msg) {
  const content = msg.content;
  const senderJid = msg.senderJid;
  const groupJid = msg.groupJid;

  // Pattern: "ok [word] calm down" / "chill [word]" / "shut up [word]"
  const addressPatterns = [
    /(?:ok|okay|chill|shut up|stfu|da|mone|machane|eda|edi)\s+(\w+)/i,
    /(\w+)\s+(?:da|mone|machane|bro|dude|man)/i,
    /^(\w+)[,!]\s/i,  // "Name, ..." at start of message
  ];

  for (const pattern of addressPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const nickname = match[1].toLowerCase();
      // Filter out common words that aren't nicknames
      if (nickname.length >= 2 && nickname.length <= 15 && !COMMON_WORDS.has(nickname)) {
        // We can't easily map this to a person without more context,
        // but store it as a potential nickname for the person being addressed
        // For now, just log it
        logger.debug({ nickname, sender: msg.senderName, group: groupJid }, 'Potential nickname detected');
      }
    }
  }

  // Self-declared nickname patterns
  const selfDeclarePatterns = [
    // "call me X", "just call me X", "you can call me X" — supports multi-word (up to 3)
    /(?:call me|address me as|you can call me|just call me)\s+([\w]+(?:\s+[\w]+){0,2})/i,
    // "my name is X" / "my name's X"
    /my name(?:'s| is)\s+([\w]+)/i,
    // "I go by X"
    /i go by\s+([\w]+)/i,
    // "I'm X" — single word only to avoid false positives ("I'm going")
    /i(?:'m| am)\s+(\w+)/i,
    // Manglish: "enne X ennu vilikk" / "enne X vilikk"
    /enne\s+([\w]+)\s+(?:ennu?\s+)?vilik/i,
    // Manglish: "name/per X aanu"
    /(?:name|per)\s+([\w]+)\s+(?:aanu|ann?u)/i,
  ];

  for (const pattern of selfDeclarePatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const nick = match[1].trim().toLowerCase();
      // For multi-word, check each word isn't ALL common words
      const words = nick.split(/\s+/);
      const allCommon = words.every(w => COMMON_WORDS.has(w));
      if (nick.length >= 2 && nick.length <= 25 && !allCommon) {
        upsertNickname(senderJid, nick, groupJid, senderJid, 0.7, 'self_declared');
        logger.debug({ nick, sender: msg.senderName }, 'Self-declared nickname');
        break; // one match is enough
      }
    }
  }
}

// ── Fact extraction ──

function extractFacts(msg) {
  const content = msg.content;
  const senderJid = msg.senderJid;
  const groupJid = msg.groupJid;
  const name = msg.senderName || 'Unknown';

  // ── Permanent memories (no expiry) ──

  // Profession: "I'm a [profession]" / "I work as [profession]"
  const profMatch = content.match(/i(?:'m| am) a(?:n)?\s+([\w\s]+?)(?:\.|,|!|\?|$)/i)
    || content.match(/i work (?:as|in)\s+([\w\s]+?)(?:\.|,|!|\?|$)/i);
  if (profMatch) {
    const prof = profMatch[1].trim();
    if (prof.length > 2 && prof.length < 30) {
      addMemory('fact', senderJid, groupJid, `${name} is a ${prof}`, 0.6);
    }
  }

  // Location: "I live in [place]" / "I'm from [place]"
  const locMatch = content.match(/i(?:'m| am) from\s+([\w\s]+?)(?:\.|,|!|\?|$)/i)
    || content.match(/i live in\s+([\w\s]+?)(?:\.|,|!|\?|$)/i);
  if (locMatch) {
    const loc = locMatch[1].trim();
    if (loc.length > 2 && loc.length < 30) {
      addMemory('fact', senderJid, groupJid, `${name} is from ${loc}`, 0.6);
    }
  }

  // Birthday: "my birthday is [date]" / "born on [date]"
  const bdayMatch = content.match(/(?:my birthday|born on|b'?day)\s+(?:is\s+)?(.+?)(?:\.|,|!|\?|$)/i);
  if (bdayMatch) {
    addMemory('fact', senderJid, groupJid, `${name}'s birthday: ${bdayMatch[1].trim()}`, 0.8);
  }

  // Life events: bought something, got married, new job, moved
  const lifeEventMatch = content.match(/i (?:just )?(?:bought|got) (?:a |an |my )?(new )?([\w\s]+?)(?:\.|,|!|\?|$)/i);
  if (lifeEventMatch) {
    const thing = lifeEventMatch[2].trim();
    if (thing.length > 2 && thing.length < 30 && !/cold|flu|fever|headache/i.test(thing)) {
      addMemory('fact', senderJid, groupJid, `${name} bought/got ${thing}`, 0.7);
    }
  }

  if (/i(?:'m| am) (?:getting )?married|got engaged|wedding/i.test(content)) {
    addMemory('fact', senderJid, groupJid, `${name} is getting married / got engaged`, 0.9);
  }

  if (/(?:got|new|started|joined).{0,10}(?:job|company|role|position)/i.test(content)
      && /\bi\b/i.test(content)) {
    const jobMatch = content.match(/(?:at|in|with)\s+([\w\s]+?)(?:\.|,|!|\?|$)/i);
    const where = jobMatch ? ` at ${jobMatch[1].trim()}` : '';
    addMemory('fact', senderJid, groupJid, `${name} got a new job${where}`, 0.7);
  }

  // ── Short-term memories (3-7 days) ──

  // Health: sick, cold, fever, etc.
  if (/i(?:'m| am| have| got).*(?:sick|cold|fever|flu|covid|headache|unwell|not feeling well)/i.test(content)) {
    addMemory('temporary', senderJid, groupJid, `${name} is sick/unwell`, 0.5, 5);
  }

  // Mood: stressed, sad, feeling low
  if (/i(?:'m| am).*(?:stressed|anxious|feeling low|depressed|burnt out|overwhelmed)/i.test(content)) {
    addMemory('temporary', senderJid, groupJid, `${name} is feeling stressed/low`, 0.4, 5);
  }

  // On leave / traveling this week
  if (/(?:on leave|taking leave|off today|off tomorrow|day off|wfh)/i.test(content)
      && /\bi\b/i.test(content)) {
    addMemory('temporary', senderJid, groupJid, `${name} is on leave / off`, 0.4, 3);
  }

  if (/(?:traveling|going) to\s+([\w\s]+?)(?:\s+(?:this|next|for)|\.|,|!|\?|$)/i.test(content)
      && /\bi\b/i.test(content)) {
    const dest = content.match(/(?:traveling|going) to\s+([\w\s]+?)(?:\s+(?:this|next|for)|\.|,|!|\?|$)/i);
    if (dest) {
      addMemory('temporary', senderJid, groupJid, `${name} is traveling to ${dest[1].trim()}`, 0.5, 7);
    }
  }

  // Exams / deadlines
  if (/(?:exam|exams|deadline|submission|interview)\s*(?:tomorrow|today|this week|next week)/i.test(content)
      && /\bi\b|my\b/i.test(content)) {
    addMemory('temporary', senderJid, groupJid, `${name} has exams/deadline coming up`, 0.5, 7);
  }

  // ── Medium-term memories (30 days) ──

  // Hobbies / shows / books
  if (/i(?:'m| am|'ve| have been) (?:watching|binging|hooked on)\s+([\w\s]+?)(?:\.|,|!|\?|$)/i.test(content)) {
    const showMatch = content.match(/(?:watching|binging|hooked on)\s+([\w\s]+?)(?:\.|,|!|\?|$)/i);
    if (showMatch) {
      addMemory('interest', senderJid, groupJid, `${name} is watching ${showMatch[1].trim()}`, 0.5, 30);
    }
  }

  if (/i(?:'m| am|'ve| have been) (?:reading|into)\s+([\w\s]+?)(?:\.|,|!|\?|$)/i.test(content)) {
    const readMatch = content.match(/(?:reading|into)\s+([\w\s]+?)(?:\.|,|!|\?|$)/i);
    if (readMatch) {
      addMemory('interest', senderJid, groupJid, `${name} is reading ${readMatch[1].trim()}`, 0.5, 30);
    }
  }

  if (/i (?:just )?started\s+([\w\s]+?)(?:\.|,|!|\?|$)/i.test(content)) {
    const startMatch = content.match(/i (?:just )?started\s+([\w\s]+?)(?:\.|,|!|\?|$)/i);
    if (startMatch && startMatch[1].trim().length > 2) {
      addMemory('interest', senderJid, groupJid, `${name} started ${startMatch[1].trim()}`, 0.5, 30);
    }
  }
}

// ── Slang tracking ──

function trackSlang(msg) {
  if (!msg.content) return;
  const words = msg.content.toLowerCase().split(/\s+/);

  for (const word of words) {
    // Skip short words, numbers, and common English
    if (word.length < 3 || /^\d+$/.test(word) || COMMON_WORDS.has(word)) continue;
    // Emojis aren't slang — they have their own feedback path (fixation detector)
    if (hasEmoji(word)) continue;

    // Detect potential non-English / slang words
    // Simple heuristic: if the word isn't in common English and appears multiple times
    if (!ENGLISH_COMMON.has(word) && word.length <= 20) {
      upsertSlang(word, null, msg.groupJid, msg.content.slice(0, 100));
    }
  }
}

// ── Batched LLM analysis ──

async function runBatchAnalysis(chatJid) {
  logger.info({ chatJid }, 'Running batched LLM analysis');

  const messages = getRecentMessages(chatJid, 100);
  if (messages.length < 20) return;

  // Build a name → JID map for resolving LLM-extracted names to JIDs
  const senderMap = new Map();
  for (const m of messages) {
    if (!m.is_from_self && m.sender_name && m.sender_jid) {
      senderMap.set(m.sender_name.toLowerCase(), m.sender_jid);
    }
  }

  const chatLog = messages.map(m => {
    const name = m.is_from_self ? getPersona().name : (m.sender_name || 'Unknown');
    return `[${name}]: ${m.content || `[${m.message_type}]`}`;
  }).join('\n');

  const prompt = `Analyze this WhatsApp group chat excerpt. Extract the following as JSON:

{
  "people_facts": [{"name": "...", "fact": "..."}],
  "relationships": [{"person_a": "...", "person_b": "...", "type": "...", "description": "..."}],
  "group_vibe": "one sentence describing the group's personality",
  "inside_jokes": ["..."],
  "slang": [{"term": "...", "meaning": "..."}],
  "nicknames": [{"person": "...", "nickname": "...", "used_by": "..."}]
}

Only include things you're fairly confident about. Be concise.

Chat log:
${chatLog}`;

  try {
    const response = await callLlm(
      'You are a social analyst. Extract structured data from chat logs. Return ONLY valid JSON, no markdown.',
      prompt,
      { model: undefined } // use default model
    );

    if (!response) return;

    // Try to parse JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const data = JSON.parse(jsonMatch[0]);

    // Process extracted data
    if (data.group_vibe) {
      const { getDb } = await import('./db.js');
      getDb().prepare('UPDATE groups SET vibe = ?, updated_at = unixepoch() WHERE jid = ?')
        .run(data.group_vibe, chatJid);
    }

    if (data.slang) {
      for (const s of data.slang) {
        if (s.term && s.meaning) {
          upsertSlang(s.term, s.meaning, chatJid, null);
        }
      }
    }

    if (data.nicknames) {
      for (const n of data.nicknames) {
        if (n.person && n.nickname) {
          const personJid = senderMap.get(n.person.toLowerCase());
          if (personJid) {
            const usedByJid = n.used_by ? senderMap.get(n.used_by.toLowerCase()) || null : null;
            upsertNickname(personJid, n.nickname.toLowerCase(), chatJid, usedByJid, 0.4, 'batch_llm');
          }
        }
      }
    }

    logger.info({
      facts: data.people_facts?.length || 0,
      relationships: data.relationships?.length || 0,
      slang: data.slang?.length || 0,
      nicknames: data.nicknames?.length || 0,
    }, 'Batch analysis complete');
  } catch (err) {
    logger.warn({ err: err.message }, 'Batch analysis failed');
  }
}

// ── Common words sets (to filter false positives) ──

const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'is', 'it', 'this', 'that', 'was', 'are', 'be', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should',
  'not', 'no', 'yes', 'ok', 'okay', 'yeah', 'yep', 'nah', 'nope',
  'what', 'who', 'how', 'why', 'when', 'where', 'which',
  'i', 'me', 'my', 'we', 'us', 'you', 'your', 'he', 'she', 'they',
  'him', 'her', 'his', 'its', 'our', 'their', 'them',
  'just', 'also', 'very', 'too', 'so', 'if', 'then', 'than', 'more',
  'some', 'any', 'all', 'each', 'every', 'both', 'few', 'many', 'much',
  'lol', 'lmao', 'bro', 'bruh', 'dude', 'man', 'like', 'got', 'get',
  'know', 'think', 'want', 'need', 'see', 'come', 'go', 'say', 'said',
  'one', 'two', 'first', 'new', 'good', 'bad', 'big', 'old', 'right',
  'well', 'still', 'after', 'before', 'now', 'here', 'there', 'only',
  'about', 'with', 'from', 'been', 'were', 'being', 'other', 'into',
  'over', 'down', 'out', 'up', 'off', 'way', 'day', 'time', 'back',
  'even', 'make', 'take', 'let', 'put', 'give', 'tell', 'call',
]);

const ENGLISH_COMMON = new Set([
  ...COMMON_WORDS,
  'going', 'doing', 'coming', 'taking', 'making', 'getting', 'having',
  'actually', 'really', 'already', 'probably', 'maybe', 'always', 'never',
  'today', 'tomorrow', 'yesterday', 'morning', 'night', 'evening',
  'people', 'thing', 'stuff', 'work', 'home', 'house', 'place',
  'money', 'phone', 'food', 'water', 'movie', 'game', 'music',
  'brother', 'sister', 'friend', 'family', 'mother', 'father',
  'because', 'since', 'while', 'though', 'although', 'unless',
  'nothing', 'everything', 'something', 'anything', 'someone',
  'same', 'different', 'next', 'last', 'long', 'short', 'sure',
  'again', 'please', 'thanks', 'thank', 'sorry', 'hello', 'bye',
  'wait', 'stop', 'start', 'keep', 'help', 'try', 'use', 'ask',
  'send', 'sent', 'done', 'read', 'love', 'hate', 'feel', 'look',
  'chat', 'group', 'message', 'reply', 'text', 'photo', 'video',
]);
