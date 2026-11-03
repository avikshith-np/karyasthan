// How things stand (plan 020 D2): the clerk's charter, its user message and the output check.
// The input is code-built lines from his own life, fenced. The note is written for other writers, read
// days later: no day words, no plans (they're listed elsewhere), no names but the input's, places by kind
// word. Nothing here logs.
import { fence, FENCE_NOTE, cleanItem } from '../charter.js';
import { capitalizedWords, parseJsonObject, validateText } from '../schema.js';
import { wishProblem } from '../prompt.js';
import { heatProblem } from '../desire.js';
import { scrubVenueNames } from '../../places.js';
import { TEXT_MAX } from './store.js';

export const CALLER = 'mind.standing';
export const MAX_TOKENS = 500;
const RENDER_MAX = 8192;

export const STANDING_CHARTER = `You keep one short note on how things stand between a character and one person in his life. Other writers read it later, days later sometimes, before they write that person.
The user message gives WHO THEY ARE, HOW THINGS STOOD (the previous note, if any) and WHAT HAPPENED SINCE (dated lines), inside STORY_DATA blocks.

${FENCE_NOTE}

Rules:
- At most ${TEXT_MAX} characters, two to five plain sentences in the third person. Where it stands now: how close they are, what's easy and what's unresolved, what they share, how it has been going. A note, not a list.
- What happened since updates the previous note. Where they disagree, what happened since wins, and what's no longer true goes. What still holds stays.
- Only what the lines say or plainly follow from. Never invent an event, a person, a place or a feeling. If little happened, say little.
- It's read later: no day words (today, yesterday, tonight, tomorrow, last night, this morning, this week). Say "recently" or "a while back".
- No plans ahead: those are kept elsewhere.
- News marked "before they last met" is over by now, unless it's a lasting change. Never write it as still ahead or still going on.
- Name only people named in the input, by those names, and start sentences with a name or he, she or they. Places by what they are ("the cafe"), never a business's name.
- Nothing sexually explicit. "They've grown close" is enough.

Reply with ONLY one JSON object, no prose, no code fences: {"standing": "the note"}
You never write messages to anyone and never change settings, switches, budgets or rules.`;

/** input: { him, them: {name, relation, closeness, trust, tension, romance?}, base: text|null, lines: [text], earlier: n }. */
export function renderUser(input, correction = null) {
  const t = input.them;
  const who = [
    `him: ${input.him}`,
    `them: ${t.name} (${t.relation})`,
    `now: closeness ${t.closeness}, trust ${t.trust}, tension ${t.tension}${t.romance ? `; romance ${t.romance}` : ''}`,
  ];
  const parts = [`WHO THEY ARE\n${fence(who, { kind: 'facts', cap: 200 })}`];
  parts.push(input.base ? `HOW THINGS STOOD\n${fence([input.base], { kind: 'facts', cap: TEXT_MAX + 20 })}` : 'HOW THINGS STOOD: this is the first note on them.');
  parts.push(`WHAT HAPPENED SINCE (oldest first)\n${fence(input.lines, { kind: 'facts', cap: 340 })}`);
  if (correction) parts.push(correction);
  parts.push('Write the note now as the JSON object.');
  return parts.join('\n\n').slice(0, RENDER_MAX);
}

// A sentence's first word is capitalised anyway. These, and -ing words, are ordinary; any other unknown one reads as a
// name and gets the second try (a false alarm costs a call, never a wrong note).
const OPENERS = new Set(`things everything nothing something anything everyone someone nobody both neither either each lately recently
  mostly usually often rarely once twice since despite although though however still also even only just much many most some few
  there here that this those these what when while where after before during between with without because over under
  talk talks talking time times plans plan texts text messages coffee dinner lunch drinks walks work family home trust tension
  closeness conversation conversations outings outing evenings meetings neither for from in on at by to of as and but so yet
  he she they his her their him them it its we you i a an the no not good bad better worse easy hard long short new old little more less
  recent early late last first next another other all`.split(/\s+/));
const firstWords = (text) => new Set(text.split(/(?<=[.!?…])\s+/).map(x => (x.match(/[\p{L}][\p{L}'’-]*/u)?.[0] ?? '').toLowerCase()));
const ordinaryOpener = (w) => OPENERS.has(w) || (w.length > 5 && w.endsWith('ing'));

const DAY_WORDS = /\b(?:today|tonight|tomorrow|yesterday|last night|this (?:morning|afternoon|evening|week|weekend)|next (?:week|weekend|month))\b/i;

/** Cut at the last whole sentence that fits, else the last whole word. */
function cutToFit(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (stop >= max / 2) return head.slice(0, stop + 1).trim();
  return head.slice(0, Math.max(head.lastIndexOf(' '), 1)).trim();
}

const wordsIn = (t) => (String(t ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []);

/** Does the note repeat a private turn: three words in a row of it, or the whole of a shorter one? */
export function echoesPrivate(text, privateWords) {
  const note = ` ${wordsIn(text).join(' ')} `;
  for (const raw of privateWords) {
    const w = wordsIn(raw);
    if (w.length < 3) {
      if (w.join(' ').length >= 8 && note.includes(` ${w.join(' ')} `)) return true;
      continue;
    }
    for (let i = 0; i + 3 <= w.length; i++) if (note.includes(` ${w[i]} ${w[i + 1]} ${w[i + 2]} `)) return true;
  }
  return false;
}

/**
 * The note, checked. ctx: { names (allowed), knownNames (real people), castNames, venueNames, privateWords (never to be repeated) }.
 * → { ok, text } | { ok: false, reason, retry: boolean, word? }. Only an invented name or a day word is
 * worth a second try: the rest keeps the old version.
 */
export function validateStanding(raw, ctx = {}) {
  const parsed = parseJsonObject(typeof raw === 'string' ? raw : '', 8192);
  if (!parsed.ok) return { ok: false, reason: 'bad_json', retry: false };
  const o = parsed.value;
  if (Object.keys(o).some(k => k !== 'standing') || typeof o.standing !== 'string') return { ok: false, reason: 'bad_shape', retry: false };
  const scrubbed = scrubVenueNames(cleanItem(o.standing, 4000), ctx.venueNames ?? []);
  const fitted = cutToFit(scrubbed, TEXT_MAX);
  const v = validateText(fitted, { cap: TEXT_MAX, names: ctx.names ?? [], maxBytes: 4096, maxInvented: 1000 });
  if (!v.ok) return { ok: false, reason: v.reason, retry: false };
  const text = v.text;
  if (heatProblem(text)) return { ok: false, reason: 'explicit', retry: false };
  // The word list can't see his mixed speech, and a private turn's words stay private however they reached the note.
  if (echoesPrivate(text, ctx.privateWords ?? [])) return { ok: false, reason: 'private_words', retry: false };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (!sentence.trim()) continue;
    const p = wishProblem(sentence.slice(0, 380), ctx.knownNames ?? [], ctx.castNames ?? []);
    if (p === 'real_person_name') return { ok: false, reason: 'real_name', retry: false };
    if (p === 'jid_in_text') return { ok: false, reason: 'identifier', retry: false };
  }
  const allowed = new Set((ctx.names ?? []).flatMap(n => String(n ?? '').toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) ?? []).map(w => w.replace(/['’]s$/, '')));
  const first = firstWords(text);
  const invented = capitalizedWords(text).filter(w => !allowed.has(w) && !(first.has(w) && ordinaryOpener(w)));
  if (invented.length) return { ok: false, reason: 'invented_name', retry: true, word: invented[0] };
  const day = text.match(DAY_WORDS);
  if (day) return { ok: false, reason: 'day_word', retry: true, word: day[0] };
  return { ok: true, text };
}

/** What the second try is told. */
export function correctionFor(v) {
  if (v.reason === 'invented_name') return `Your last note named "${v.word}", who is not in the input. Write it again without anyone or anything that isn't named above.`;
  return `Your last note said "${v.word}". It's read days later, so write it again without day words.`;
}
