/**
 * The words of a name, as they'd be compared: no format characters, emoji, digits or punctuation, lower case, accents off Latin letters
 * only. "K Ann", "Brin🌸", "Dr. Maris" all hold the name people actually use, and it isn't always the first token. In Indian scripts a
 * mark is a vowel, part of the name: it stays, and counts toward the 3-character floor (counted decomposed, so a name's length doesn't
 * depend on how it was typed). Pure.
 */
export function nameTokens(name) {
  if (typeof name !== 'string') return [];
  return name.normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').replace(/\p{Cf}/gu, '').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{M}]+/gu, ' ').trim().split(' ').filter(t => [...t.normalize('NFD')].length >= 3);
}
