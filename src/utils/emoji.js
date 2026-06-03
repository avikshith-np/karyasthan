// Matches a single emoji codepoint (Extended_Pictographic covers standard emojis).
export const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

// Joiners and modifiers that compose emoji sequences but aren't pictographic on their own.
const EMOJI_JOINERS = /[‍️\u{1f3fb}-\u{1f3ff}]/gu;

export function hasEmoji(s) {
  if (!s) return false;
  return /\p{Extended_Pictographic}/u.test(s);
}

export function isEmojiToken(s) {
  if (!s) return false;
  const stripped = s.replace(EMOJI_JOINERS, '');
  if (!stripped) return false;
  for (const ch of stripped) {
    if (!/\p{Extended_Pictographic}/u.test(ch)) return false;
  }
  return true;
}

export function extractEmojis(s) {
  if (!s) return [];
  return Array.from(s.matchAll(EMOJI_REGEX), m => m[0]);
}
