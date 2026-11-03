// How a live call's language rules read, from the persona's language. Pure.
//
// A live model slides into assistant-style English under pressure, so a persona with another
// everyday language has it pinned as the default. A language with an entry here is one a persona's
// description may only hint at (a spoken mix, "X and English"); any other reads as written.

const CALL_LANGUAGES = [
  { match: /malayalam|manglish/i, spoken: 'Malayalam', languages: 'English and Malayalam, often mixed (Manglish)' },
  { match: /hinglish/i, spoken: 'Hindi', languages: 'English and Hindi, often mixed (Hinglish)' },
  { match: /spanglish/i, spoken: 'Spanish', languages: 'English and Spanish, often mixed (Spanglish)' },
  { match: /taglish/i, spoken: 'Tagalog', languages: 'English and Tagalog, often mixed (Taglish)' },
  { match: /tanglish/i, spoken: 'Tamil', languages: 'English and Tamil, often mixed (Tanglish)' },
  { match: /franglais/i, spoken: 'French', languages: 'English and French, often mixed' },
];

/** { languages, languageLine } for callRules. */
export function callLanguageLines(persona = {}) {
  const row = CALL_LANGUAGES.find(l => l.match.test(persona.language || ''));
  const languages = row ? row.languages : (persona.language || 'English');
  const spoken = row ? row.spoken : (persona.language || 'English');
  const languageLine = /^english$/i.test(spoken)
    ? '- Talk the way people actually talk on the phone, in the mix they use with you.'
    : `- Speak ${spoken} the way people from ${(persona.region || 'your region').replace(/\s*\(.*\)$/, '')} talk on the phone (mixing in
  English words is fine). Don't switch to full English sentences unless they speak English to you first.
  Your words are turned into speech, so write ${spoken} words in ${spoken} script, never in English
  letters (the chat history is typed in English letters; that's only how you text).`;
  return { languages, languageLine };
}
