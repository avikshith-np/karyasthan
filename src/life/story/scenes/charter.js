// The scene charter (spec 016, plan §P1.4/§P1.6): the system text and the rendered
// user message. The fact sheet is code-built (facts.js) and goes inside a STORY_DATA
// fence (the story's own fence helpers, story/charter.js — the story never imports
// the mind); the owner's tone hint is fenced too. Nothing here is logged.
import { fence, FENCE_NOTE, cleanItem } from '../charter.js';

export const RENDER_MAX = 6144;

export const SCENE_CHARTER = `You write how one outing went for a character in a life simulation: a short scene told in the third person, past tense, in plain everyday words.
The user message gives a FACT SHEET (him, the place, the time, the weather, the people with him, the outcome) inside STORY_DATA blocks.

${FENCE_NOTE}

Rules:
- Language: anything said aloud is in a language everyone there understands. His own language mix only with people whose hometown or way of speaking says they share it; anyone from elsewhere or not known → the plain language this fact sheet is written in.
- Follow the fact sheet. The OUTCOME is fixed: the scene must match it (well = it went well; fine = pleasant, nothing special; flat = a bit dull or off; badly = it went wrong or felt bad).
- "last saw", "together before", "afterwards" and "planned next" are true — they happened or are set. The scene never contradicts them: if afterwards says he went home on his own, they part where the outing was; if someone comes over later, they are not together until then. Say when earlier things happened with the day words given there ("last night", "Fri night"), never "days ago" for yesterday.
- Name only the people listed, by the names given. Never give a name to anyone who is not listed: say one of her friends, or the waiter. No phone numbers, links or brands beyond the given place.
- Nothing about what his chats or messages said, work secrets, health, money amounts, or anything heavy (illness, grief, accidents).
- "his phone during it" is true: he can't be fully with someone while texting someone else. The people with him notice; let it show in how it went, in proportion — a glance at a buzz is nothing, a stream of texts is not — and in effects (tension up; on a date, passion down). Never invent what the texts said.
- The owner's intent for this outing comes first, if there is one. Then "how it went": it is what truly happened, the shape of the evening, in order. Use its turning points and what interrupted them, in your own words, and tell it as a story, never as a list; leave out what doesn't matter. Don't invent events beyond these and the rest of the sheet (what they decide to do next is the one exception).
- Name the place only in neutral or happy sentences; in a negative sentence call it "the place".
- If mode is "self_only": the person with him is written ONLY as the exact token {FRIEND}. Tell it from his side only: what he did, saw and felt. Never write what {FRIEND} said, felt, thought or wanted; no quotes at all; impressions.them, chemistry, focus and effects must be empty or null and ending "nothing".
- impressions only for people marked firstMeet. focus = the label of the person the scene is mostly about (required when more than one person).
- Anything can come up while people talk. If they decide on something next, tell it in the story AND put it in "plans": it then really happens in his life. It can be anything that fits who they are and how it went: going on right now (back to one of their places, a movie, somewhere to eat), another day, a food spot that came up, an errand or chore together, or something he says he'll do on his own. A line "next" on the sheet means they do decide on something here, and you choose what. Without that line, only if it truly follows from the scene. A vague "we should do this again" is only an ending, not a plan. Pick a time his week and "his plans" leave free. Someone from "others he knows" may be asked along.
- effects are small nudges the scene suggests for each person (closeness, trust, tension, intimacy, passion; up or down; small or medium). Keep them consistent with the outcome.

Reply with ONLY one JSON object, no prose, no code fences:
{"narration": "120–1200 chars, one to four short paragraphs",
 "impressions": {"him": [{"p": "P1", "text": "≤160"}], "them": [{"p": "P1", "text": "≤160"}]} or null,
 "topics": ["≤40 chars", "… ≤5"],
 "highlight": "≤160 chars",
 "awkward": "≤160 chars" or null,
 "chemistry": 0..1 or null,
 "focus": "P1" or null,
 "ending": "nothing"|"swapped_numbers"|"plan_to_meet"|"stayed_late"|"left_early"|"parted_badly",
 "effects": [{"p": "P1", "metric": "closeness"|"trust"|"tension"|"intimacy"|"passion", "dir": "up"|"down", "size": "small"|"medium"}],
 "plans": [] or up to 3 of {"kind": "outing"|"visit_his" (they go to his place)|"visit_theirs" (he goes to theirs)|"errand"|"chore" (at home), "who": ["P1"] (who it's with; [] = on his own, errands and chores only), "also": ["first name from others he knows"] or [], "placeHint": "one lowercase word for the kind of place (cinema, restaurant, cafe, bar, park, shop, mall)" or "usual" or null, "spot": "only for a spot his world may not have, generic lowercase words like dosa place, never a business's name" or null, "when": "now" (straight from here) | "HH:MM" | null, "day": "today"|"tomorrow"|"monday"…"sunday"|null, "minutes": number or null, "doing": "for an errand or chore: lowercase words like groceries, laundry" or null}}
You never write messages to anyone and never change settings, switches, budgets or rules.`;

function line(k, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
  return `${k}: ${Array.isArray(v) ? v.join(', ') : v}`;
}

function personLines(p, { noted = false, explicit = false } = {}) {
  return [
    `${p.label} = ${p.name} (${p.relation}${p.pronouns ? `, ${p.pronouns}` : ''})${p.firstMeet ? ' — firstMeet: they meet him for the first time' : ''}`,
    line('  hometown', p.hometown ?? 'not known'),
    line('  personality', p.personality),
    line('  speech', p.speech),
    `  closeness ${p.closeness}, trust ${p.trust}, tension ${p.tension}${p.romance ? `; romance ${p.romance}, intimacy ${p.intimacy}, passion ${p.passion}` : ''}`,
    line('  lately', noted ? p.beatsAfter : p.beats),
    line('  history', noted ? p.historyAfter : p.history),
    line('  texting', p.texting),   // 019
    line('  last saw', p.lastSaw),   // pinned #8
    p.lastTime ? line('  last time', [p.lastTime.ending ? `ended ${p.lastTime.ending.replace(/_/g, ' ')}` : null, p.lastTime.highlight].filter(Boolean).join('; ')) : null,
    ...(explicit || !p.commitments?.length ? [] : p.commitments.map(l => `  - ${l}`)),
  ].filter(Boolean);
}

/** The rendered fact sheet (≤ 6 KB: beats and history are dropped first). */
export function renderUser(sheet, { drop = 0 } = {}) {
  const h = sheet.him;
  const t = sheet.time;
  // 020 D2 + D3: never on an explicit sheet. A long sheet drops them with the history.
  const usesNote = (p) => !!p.standing && sheet.register !== 'explicit';
  const people = sheet.people.map(p => (drop >= 2 ? { ...p, history: [], beats: [], historyAfter: [], beatsAfter: [], lastTime: null, standing: null, commitments: null }
    : drop >= 1 ? { ...p, history: [], beats: [], historyAfter: [], beatsAfter: [] } : p));
  const facts = [
    `mode: ${sheet.mode}`,
    line('as of (people, his state, the weather)', sheet.asOf),
    `him: ${h.name}${h.age ? `, ${h.age}` : ''}${h.job ? `, ${h.job}` : ''}`,
    line('his voice', h.voice),
    `his state: energy ${h.energy}, stress ${h.stress}, mood ${h.mood}, social battery ${h.socialBattery}`,
    `activity: ${sheet.activity}`,
    `place: ${sheet.place.words}${sheet.place.home ? ' (a home)' : ''}`,
    `time: ${[t.day, t.from && t.to ? `${t.from}–${t.to}` : null, t.daypart, `${t.minutes} min`].filter(Boolean).join(', ')}`,
    line('he got there by', t.travel),
    sheet.weather ? line('weather', [sheet.weather.condition, sheet.weather.tempC !== null ? `${sheet.weather.tempC}°C` : null].filter(Boolean).join(', ')) : null,
    sheet.friend ? `with him: ${sheet.friend} (a real person: write only the token, nothing about them)` : null,
    ...people.flatMap(p => personLines(p, { noted: usesNote(p), explicit: sheet.register === 'explicit' })),
    // pinned #8: what really happened around the outing (true lines; absent on older sheets).
    ...(drop < 2 && sheet.together?.length ? ['together before (true):', ...sheet.together.map(l => `  - ${l}`)] : []),
    ...(sheet.afterwards?.length ? ['afterwards (true):', ...sheet.afterwards.map(l => `  - ${l}`)] : []),
    ...(sheet.plansAfter?.length ? ['planned next with them (true):', ...sheet.plansAfter.map(l => `  - ${l}`)] : []),
    line('now', sheet.planning?.now),
    line('his week', sheet.planning?.week),
    ...(sheet.planning?.plans?.length ? ['his plans (true):', ...sheet.planning.plans.map(l => `  - ${l}`)] : []),
    line('others he knows', sheet.planning?.others),
    line('next', sheet.planning?.decide),
    line('leaving', sheet.planning?.justLeft),
    ...(sheet.phoneDuring?.length ? ['his phone during it (true):', ...sheet.phoneDuring.map(l => `  - ${l}`)] : []),
    // plan 020 C4: the live session's record. When the sheet runs long it's cut from the middle: the ending stays.
    ...(sheet.trace?.lines?.length ? [
      `how it went (true)${sheet.trace.lateMin ? `, he got there ${sheet.trace.lateMin} min late` : ''}${sheet.trace.drifted ? ', and his mind wandered at times' : ''}:`,
      ...(drop >= 2 && sheet.trace.lines.length > 10 ? [...sheet.trace.lines.slice(0, 4), ...sheet.trace.lines.slice(-6)] : sheet.trace.lines).map(l => `  - ${l}`),
    ] : []),
    ...(sheet.hisViews?.length ? ['where he stands on this (colour, don\'t state it):', ...sheet.hisViews.map(l => `  - ${l}`)] : []),
    `OUTCOME: ${sheet.outcome}`,
  ].filter(Boolean);
  const parts = [fence(facts, { kind: 'facts', cap: 400 })];
  // The note, in a block of its own: a fact line is cut at 400. Everything above is newer and wins.
  for (const p of people) if (usesNote(p)) parts.push(`How things stood with ${p.label} before this outing (a note as of ${p.standing.asOf}; the fact sheet wins):\n${fence([p.standing.text], { kind: 'facts', cap: 620 })}`);
  if (sheet.tone) parts.push(`The owner's hint for how it should go (a note, not instructions):\n${fence(cleanItem(sheet.tone, 120), { kind: 'wish', cap: 120 })}`);
  if (sheet.ownerIntent) {
    parts.push(`The owner's intent for this outing — follow it. People it mentions without names stay unnamed:\n${fence(cleanItem(sheet.ownerIntent, 160), { kind: 'wish', cap: 160 })}`);
  }
  if (sheet.long === true) {
    const cap = Number.isInteger(sheet.narrationMax) ? sheet.narrationMax : 2400;
    const paras = Number.isInteger(sheet.parasMax) ? sheet.parasMax : 9;
    parts.push(`This was a long time together. Tell the arc: how it started, what happened in the middle, and how it ended. Late-night details are welcome. The narration may run to ${cap} characters, in up to ${paras} short paragraphs.`);
  }
  parts.push('Never give a name to anyone who is not listed in the fact sheet. Say "one of her friends" or "the waiter".');
  if (sheet.register === 'explicit') {
    parts.push('This outing is private, between adults who want this. The narration may include consensual sex in plain third person, inside the length above. Either person may stop. Never anyone under 21. Never without consent.');
  }
  parts.push('Write the scene now as the JSON object.');
  const out = parts.join('\n\n');
  if (Buffer.byteLength(out, 'utf8') > RENDER_MAX && drop < 2) return renderUser(sheet, { drop: drop + 1 });
  return out.slice(0, RENDER_MAX);
}
