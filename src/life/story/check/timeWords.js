// The claim check's code pass (plan 020 E3), pure. What a writer said about when, compared with the times on its own sheet,
// through the same words the sheet uses: phone/facts.js relWhen ("last night, Sun 1 Nov 02:32: …"). A time word maps to the
// heads relWhen gives a moment inside its interval. So "tonight" is whatever relWhen would call tonight, and the two can't
// drift apart.
//
// This pass is deliberately narrow, because it runs on how people really talk. It speaks only when a past-tense sentence ties
// a time word to something the sheet has dated (a dinner, a coffee, a person seen), the sheet has it, and none of those fall in
// the interval. A new suggestion ("dinner tonight?"), a solo meal (the sheet lists time with people), someone else's evening
// and a line in another language get no verdict from code: silence here isn't a pass, the clerk still reads it.
//
//   rowsFromLines(lines, base)        sheet lines → dated rows
//   timeWordFindings(text, rows, o)   → [{ claim, about:'when', reason:'time_word', evidence }]
//   leftFindings(text, facts)         → [{ claim, about:'left', reason:'left_together', evidence }]

const norm = (s) => String(s ?? '').normalize('NFKC').replace(/[’‘]/g, "'");

// The words people use for an interval, and the relWhen heads inside it.
export const TIME_WORDS = Object.freeze(['last night', 'tonight', 'yesterday', 'this morning', 'this afternoon', 'this evening']);
const WORD_RE = /\b(last night|tonight|yesterday|this morning|this afternoon|this evening)\b/gi;
const PAST_ONLY = new Set(['last night', 'yesterday', 'this morning']);

// In the small hours today's evening is already "last night" or "yesterday" to anyone awake; both readings are fine then.
const SMALL_HOURS = 5;
const SAME_DAY_EVENING = ['earlier tonight', 'earlier this evening', 'earlier this afternoon', 'earlier this morning'];
// A daypart's edge is about an hour wide: relWhen calls 17:30 evening, and people still call it this afternoon.
const SAME_DAY_MORNING = ['earlier this morning', 'later this morning'];
const SAME_DAY_AFTERNOON = ['earlier this afternoon', 'later this afternoon'];
const SAME_DAY_EVE = ['earlier this evening', 'later this evening'];

/** Does a moment with relWhen head `head` (at local `hour`) fall in `word`, seen at local `atHour`? */
export function headFits(word, head, { atHour = 12, hour = null } = {}) {
  const h = String(head ?? '');
  if (h === 'right now') return !['last night', 'yesterday'].includes(word);
  const small = atHour < SMALL_HOURS;
  switch (word) {
    case 'last night':
      return h === 'last night' || h === 'yesterday evening' || (small && (h === 'earlier tonight' || h === 'earlier this evening'));
    case 'tonight':
      return ['tonight', 'earlier tonight', 'earlier this evening', 'later this evening'].includes(h) || (hour === 16 && SAME_DAY_AFTERNOON.includes(h));
    case 'yesterday':
      return h === 'last night' || h.startsWith('yesterday ') || (small && SAME_DAY_EVENING.includes(h));
    case 'this morning':
      return h === 'earlier this morning' || h === 'later this morning'
        || (Number.isFinite(hour) && hour < SMALL_HOURS && (h === 'last night' || h === 'earlier tonight'))
        || (hour === 12 && SAME_DAY_AFTERNOON.includes(h));
    case 'this afternoon':
      return SAME_DAY_AFTERNOON.includes(h) || (hour === 11 && SAME_DAY_MORNING.includes(h)) || (hour === 17 && SAME_DAY_EVE.includes(h));
    case 'this evening':
      return ['earlier this evening', 'later this evening', 'earlier tonight', 'tonight'].includes(h) || (hour === 16 && SAME_DAY_AFTERNOON.includes(h));
    default:
      return true;
  }
}

// What a row or a sentence is about. One word in a class matches any other: the sheet says "eat out at the restaurant", the text says "sushi".
const CLASSES = Object.freeze({
  meal: ['dinner', 'lunch', 'breakfast', 'brunch', 'supper', 'meal', 'food', 'restaurant', 'eat', 'sushi', 'pizza', 'burger', 'pasta', 'noodles'],
  coffee: ['coffee', 'cafe', 'café'],
  movie: ['movie', 'film', 'cinema'],
  drinks: ['drinks', 'beer', 'bar', 'pub', 'brewpub'],
  walk: ['walk', 'park'],
  gym: ['gym', 'workout'],
});
const WORD_CLASS = new Map(Object.entries(CLASSES).flatMap(([k, ws]) => ws.map(w => [w, k])));
// A named meal. Generic words (food, the restaurant, sushi) match any meal; lunch and dinner aren't the same meal.
const MEAL_SLOTS = Object.freeze({ breakfast: ['morning'], brunch: ['morning', 'midday'], lunch: ['midday'], dinner: ['night'], supper: ['night'] });

const tokensOf = (s) => norm(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
const classesIn = (tokens) => new Set(tokens.map(t => WORD_CLASS.get(t.replace(/'s$/, ''))).filter(Boolean));
const mealsIn = (tokens) => new Set(tokens.flatMap(t => MEAL_SLOTS[t.replace(/'s$/, '')] ?? []));

const HEAD_RE = /^(.+?), (?:[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}) (\d{2}):\d{2}(?:[–-]\d{2}:\d{2})?: (.*)$/;
const NOW_RE = /^right now \(since \d{2}:\d{2}\), until \d{2}:\d{2}: (.*)$/;
const FUTURE_HEAD = /^(tonight|tomorrow|later this|.*\(in \d+ days\))/;

/** One sheet line → a dated row, or null when it carries no relWhen time. `names`: the cast first names to look for. */
export function rowFromLine(line, { names = [] } = {}) {
  const l = norm(line);
  const now = NOW_RE.exec(l);
  const m = now ? null : HEAD_RE.exec(l);
  if (!now && !m) return null;
  const body = now ? now[1] : m[3];
  const head = now ? 'right now' : m[1];
  return {
    head, hour: m ? Number(m[2]) : null, line: String(line), past: now ? true : !FUTURE_HEAD.test(head),
    classes: [...classesIn(tokensOf(body))],
    meals: [...mealsIn(tokensOf(body))],
    names: names.filter(n => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(body)),
    together: /\[together\]|\[with them/.test(body),
  };
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function rowsFromLines(lines, opts) {
  return (Array.isArray(lines) ? lines : []).map(l => rowFromLine(l, opts)).filter(Boolean);
}

// ── sentences ───────────────────────────────────────────────────────────────

const FUTURE_RE = /\b(let'?s|wanna|want to|shall|should|could|can we|will|i'll|we'll|you'll|gonna|going to|plan|plans|planning|free|up for|how about|maybe|might|hope|hoping|looking forward|can't wait|soon|thinking|wondering|was going|were going|got a table|booked|booking|reserved)\b/i;
const PAST_RE = /\b(was|were|had|did|went|ate|loved|enjoyed|got|came|walked|left|saw|met|thanks for|thank you for|stayed|talked|sat|tried|shared|finished|ended)\b/i;
const NEGATED_RE = /\b(not|no|never|didn't|wasn't|weren't|skipped|missed|instead|unlike|than|if|wish|wished|would|would've|should've|could've|cancelled|canceled)\b/i;
const OTHERS_RE = /\b(her|his|their|my|your)\s+(sister|brother|mum|mom|mother|dad|father|parents|cousin|aunt|uncle|friend|friends|boss|manager|flatmate|roommate|colleague|colleagues)\b/i;
const SUBJECT_RE = /\b(i|i'm|i'd|i've|he|he'd|she|she'd)\b/i;
const SHARED_RE = /\b(we|we'd|we're|we've|us|our|together|with|they|they'd|them)\b/i;
const SHARED_FIRM_RE = /\b(we|we'd|we're|we've|us|our|together)\b/i;
const SHE_HE_RE = /\b(he|he'd|she|she'd)\b/i;
const UNLISTED_RE = /\b(team|office|everyone|everybody|whole|colleagues?|coworkers?|group|all of us)\b/i;   // company the sheet doesn't list
const SAW_RE = /\b(saw|met|hung out with|was with|were with)\b/i;
const WITH_NAME_RE = /\bwith ([A-Z][\p{L}']+)/u;
const NEAR = 6;   // words between the time word and what it dates

const sentencesOf = (text) => norm(text).split(/(?<=[.!?…])\s+|\n+/).map(s => s.trim()).filter(Boolean);

/** Is this sentence about a shared moment in the past, in plain enough words to judge? → false = no verdict from code. */
function judgeable(sentence, word, speaker, named) {
  if (sentence.includes('?')) return false;
  if (NEGATED_RE.test(sentence) || OTHERS_RE.test(sentence) || UNLISTED_RE.test(sentence)) return false;
  // "They talked about the coffee she had": a she or he with only a bare with / they is her time, not theirs. "with Asha" names it.
  if (SHE_HE_RE.test(sentence) && !SHARED_FIRM_RE.test(sentence) && SHARED_RE.test(sentence) && !named.some(n => new RegExp(`\\bwith ${escapeRe(n)}\\b`).test(sentence))) return false;
  if (SUBJECT_RE.test(sentence) && !SHARED_RE.test(sentence) && !(named.length && SAW_RE.test(sentence))) return false;
  if (speaker === 'cast' && /\bi\b/i.test(sentence) && !/\b(we|us|our|together|with you)\b/i.test(sentence)) return false;
  if (!PAST_ONLY.has(word) && (FUTURE_RE.test(sentence) || !PAST_RE.test(sentence))) return false;
  return true;
}

/** The words the time word dates: those near it, not the whole sentence. */
function tokensNear(sentence, word) {
  const tokens = tokensOf(sentence);
  const w = word.split(' ');
  const at = tokens.findIndex((t, i) => w.every((x, j) => tokens[i + j]?.replace(/'s$/, '') === x));
  return at < 0 ? [] : tokens.slice(Math.max(0, at - NEAR), at + w.length + NEAR);
}

/** Is this row about what the sentence dates? A meal is any meal, unless both name a different one. */
function rowAbout(r, anchors, meals) {
  return r.classes.some(c => anchors.has(c) && (c !== 'meal' || !meals.size || !r.meals?.length || r.meals.some(m => meals.has(m))));
}

/**
 * The code pass. rows: rowsFromLines of the sheet. o: { speaker 'narrator'|'his'|'cast', atHour (local hour at the moment of
 * writing), names (cast on the sheet) }. A contradiction needs rows the sentence is about and none of them in the interval.
 */
export function timeWordFindings(text, rows, { speaker = 'narrator', atHour = 12, names = [] } = {}) {
  const out = [];
  const usable = (Array.isArray(rows) ? rows : []).filter(r => speaker !== 'cast' || r.together);
  if (!usable.some(r => r.past)) return out;
  for (const sentence of sentencesOf(text)) {
    const words = [...sentence.matchAll(WORD_RE)].map(m => m[1].toLowerCase());
    if (words.length !== 1) continue;   // two of them ("better than last night's") compare, they don't date
    const word = words[0];
    const named = names.filter(n => new RegExp(`\\b${escapeRe(n)}\\b`).test(sentence));
    if (!judgeable(sentence, word, speaker, named)) continue;
    const withWhom = WITH_NAME_RE.exec(sentence)?.[1];
    if (withWhom && !names.includes(withWhom)) continue;   // someone the sheet doesn't list: not a moment it can speak to
    const near = tokensNear(sentence, word);
    const anchors = classesIn(near);
    let matched = anchors.size ? usable.filter(r => rowAbout(r, anchors, mealsIn(near))) : [];
    if (named.length && matched.length) matched = matched.filter(r => r.names.some(n => named.includes(n)));
    if (!anchors.size && named.length && SAW_RE.test(sentence)) matched = usable.filter(r => r.names.some(n => named.includes(n)));
    // A plan on the sheet can be what the word means: every matched row is tested, a past one is what it must contradict.
    const pastRows = matched.filter(r => r.past);
    if (!pastRows.length) continue;
    if (matched.some(r => headFits(word, r.head, { atHour, hour: r.hour }))) continue;
    out.push({ claim: sentence.slice(0, 160), about: 'when', reason: 'time_word', evidence: pastRows[pastRows.length - 1].line.slice(0, 200) });
  }
  return out;
}

// ── how he left ─────────────────────────────────────────────────────────────

const LEFT_TOGETHER_RE = /\b(left|headed home|went home|walked home|drove home|rode home)\b[^.!?\n]{0,30}\btogether\b|\b(walked|drove|dropped) (her|him|them) home\b|\btook (her|him) home\b|\bshared an? (cab|ride|auto)\b(?! to (?:the|a|an)\b)/i;
// Not how he left tonight: what might have been, or some other night.
const NOT_THIS_TIME_RE = /\b(could|should|remembered|remember|remembering|last time|used to|that time)\b/i;

/**
 * "They left together" when the sheet's afterwards says he left on his own (2026-11-02, pinned #8). facts: the sheet's
 * afterwards lines. Only when a line says so outright.
 */
export function leftFindings(text, afterwards) {
  const alone = (Array.isArray(afterwards) ? afterwards : []).find(l => /\bon his own\b|\bhe stayed home\b/.test(String(l)));
  if (!alone) return [];
  return sentencesOf(text)
    .filter(s => LEFT_TOGETHER_RE.test(s) && !s.includes('?') && !NEGATED_RE.test(s) && !NOT_THIS_TIME_RE.test(s))
    .map(s => ({ claim: s.slice(0, 160), about: 'left', reason: 'left_together', evidence: String(alone).slice(0, 200) }));
}
