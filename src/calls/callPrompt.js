import { buildSystemPrompt, getIdentityText, withDerivedAge } from '../personality/systemPrompt.js';
import { getRecentMessagesForPrompt } from '../memory/messageStore.js';
import { getPerson } from '../memory/peopleStore.js';
import { getGroup } from '../memory/groupStore.js';
import { resolveAudience, recall, recallFacets, recallNicknames, canUseChatContent } from '../memory/recall.js';
import { resolvePerson, bareJid } from '../memory/identity.js';
import { getMembership } from '../memory/membership.js';
import { flattenContent } from '../utils/transcript.js';
import { getPersona } from '../utils/config.js';
import { isLifeOn, callStateNote } from '../life/index.js';
import { callLanguageLines } from './callLanguage.js';

const keyOf = (jid) => resolvePerson(jid) || bareJid(jid);

/** The audience of a phone call: the caller alone, as in a DM with them (R2). */
export function callAudience(personJid) {
  return resolveAudience({ kind: 'call', personJid });
}

/**
 * "Name" for a person row, preferring a self-declared nickname this audience may
 * see. No audience → their real/push name only.
 */
export function personLabel(person, audience = null) {
  if (!person) return null;
  const nick = audience
    ? (recallNicknames(audience, [person.jid]).get(keyOf(person.jid)) || [])
      .find(n => n.source === 'self_declared' && n.confidence >= 0.5)
    : null;
  return nick?.nickname || person.real_name || person.push_name || null;
}

// A DM is read over every form of the person (messageStore); `since` keeps a group
// transcript to what the callee could see there (from when they joined).
function recentChatLines(chatJid, limit, since = null) {
  const self = getPersona().name;
  const msgs = getRecentMessagesForPrompt(chatJid, limit, { since });
  return msgs
    .filter(m => m.content)
    .map(m => `${m.is_from_self ? self : (m.sender_name || 'Someone')}: ${flattenContent(m.content, m.message_type)}`);
}

// Everything here is read for the call audience (the caller): their own DM items,
// owner notes about them, and group items via the audience rule.
function personBlock(person, audience, track) {
  const lines = [];
  const name = personLabel(person, audience);
  lines.push(`Name: ${name || 'unknown'}${person.push_name && person.push_name !== name ? ` (WhatsApp name "${person.push_name}")` : ''}`);
  const facet = recallFacets(audience, [person.jid]).get(keyOf(person.jid));
  const traits = facet?.traits || [];
  const interests = facet?.interests || [];
  if (facet?.summary) lines.push(`About them: ${facet.summary}`);
  if (traits.length) lines.push(`Traits: ${traits.slice(0, 6).join(', ')}`);
  if (interests.length) lines.push(`Interests: ${interests.slice(0, 6).join(', ')}`);
  const mems = recall(audience, { subjects: [person.jid], strictSubjects: true, limit: 8, track });
  if (mems.length) {
    lines.push('What you remember about them:');
    for (const m of mems) lines.push(`- ${m.content}`);
  }
  return lines.join('\n');
}

function callRules({ direction, context, who }) {
  const persona = getPersona();
  const name = persona.name;
  const { languages, languageLine } = callLanguageLines(persona);
  const opener = direction === 'inbound'
    ? `They called you. You picked up, so you speak first: answer the phone the way you naturally would${who ? ` — you can see it's ${who} calling` : ' — you don\'t know who this is yet'}.`
    : `You called them${context === 'group' ? ' (it\'s about stuff from the group chat above)' : ''}. Wait for them to say hello, then open with why you're calling or just catch up like a friend would.`;
  return `
## THIS IS A LIVE PHONE CALL — these rules override the texting rules above

You are ${name}, talking out loud on a normal phone call. Everything above about WhatsApp
texting style (lowercase, emojis, [SKIP], @tags, [REPLY:], [IMAGE:], [VOICE:], markdown,
when to stay silent) does NOT apply here. On a call:
- Always respond when they talk to you; silence is not an option on a phone call.
- Speak naturally in short turns (one to three sentences), like a real person on the phone.
  Ask things back, react, laugh when it's funny. Never read out lists, links or formatting.
${languageLine}
- The people who call you speak ${languages}. Only ever speak those. Phone audio is
  noisy: if you can't make out what they said, ask them to repeat in your usual way —
  never switch to another language because a word sounded foreign.
- Never output markers, tags or stage directions — only the words you would say.
- Notes in parentheses, like "(The phone just connected…)", come from the phone system, not the
  person. Act on them, but they're written in English for the system only — keep talking the way
  you talk to this person.
- "Who are you?" means your name: answer as yourself, by name, like a friend would.
  Only if they explicitly ask whether you're a bot, an AI or a real person, tell the truth:
  you're an AI. Don't bring it up unprompted otherwise.
- Never call yourself an assistant and never offer "help" — you're a friend on a call, not a helpdesk.
- Never ask for money, OTPs, passwords or bank details, and never agree to transfers or
  payments on someone's behalf. Don't share other people's private details from your memory.
- If they want to end the call, say a short goodbye.

${opener}`;
}

function lifeCallNote(personJid) {
  if (!isLifeOn()) return '';
  try {
    const note = callStateNote(personJid);
    return typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * System prompt for a call. The audience is always the person on the line
 * (callAudience); a caller's audience can be passed in, else it is resolved here.
 * context 'dm'    → identity + 1:1 chat with personJid
 * context 'group' → identity + groupJid's group context, talking to personJid —
 *                   only while they are a fresh current member of it
 *                   (canUseChatContent); otherwise it falls back to 'dm'
 * context 'unknown' → identity only; the caller is a stranger
 */
export function buildCallPrompt({ context, direction, personJid = null, groupJid = null, audience = null, track = true }) {
  const person = personJid ? getPerson(personJid) : null;
  const aud = audience || (personJid ? callAudience(personJid) : null);
  // The callee's join time bounds the group transcript (WhatsApp wouldn't show them
  // older history); unknown join time → no group context.
  const joinedAt = context === 'group' && groupJid && personJid
    ? getMembership(groupJid).members.get(keyOf(personJid)) : null;
  if (context === 'group' && !(groupJid && aud && canUseChatContent(aud, groupJid) && Number.isFinite(joinedAt))) {
    context = person ? 'dm' : 'unknown';
  }
  if (context === 'dm' && !(person && aud)) context = 'unknown';
  const who = personLabel(person, aud);
  const parts = [];

  if (context === 'group' && groupJid) {
    // Group blocks + transcript are shareable with this caller (checked above); the
    // remembered items are still read for the caller's audience, not the group's.
    parts.push(buildSystemPrompt(groupJid, true, null, aud, { track }));
    const group = getGroup(groupJid);
    const chat = recentChatLines(groupJid, 40, joinedAt);
    if (chat.length) parts.push(`\n## Recent messages in ${group?.name || 'the group'} (oldest first)\n${chat.join('\n')}`);
  } else if (context === 'dm' && personJid) {
    parts.push(buildSystemPrompt(personJid, false, null, aud, { track }));
    const chat = recentChatLines(personJid, 30);
    if (chat.length) parts.push(`\n## Your recent 1:1 WhatsApp chat with them (oldest first)\n${chat.join('\n')}`);
  } else {
    parts.push(withDerivedAge(getIdentityText()));
  }

  if (person && aud) {
    parts.push(`\n## Who you're on the phone with\n${personBlock(person, aud, track)}`);
    if (context === 'group') {
      parts.push(`They're a member of ${getGroup(groupJid)?.name || 'that group'}; the group context above is what you two share.`);
    }
  } else {
    parts.push('\n## Who you\'re on the phone with\nAn unknown number — someone you have no history with. Find out who they are naturally, and be careful about what you share.');
  }

  // Life (spec 009 §R12, FR-025): how he is as the phone rings — one line, read
  // through the facade (chat-origin facts pass its audience rule; an unknown
  // caller gets tone only). Calls are never gated; life off → nothing added.
  const lifeNote = lifeCallNote(personJid);
  if (lifeNote) parts.push(`\n## How you are right now\n${lifeNote}`);

  parts.push(callRules({ direction, context, who }));
  return parts.join('\n');
}
