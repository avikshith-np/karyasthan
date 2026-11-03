// The words of a remembered dream fragment and what a dream may never say (plan 020 G, moved out of
// story/dreams/plan.js so the phrase banks can read them). Code only. No persona, no place, no real
// name: {place} a place word, {person} a fictional first name, {task} what he was trying to do,
// {twist} what was strange, {twistCap} the same with a capital.

export const FRAGMENTS = Object.freeze({
  good: [
    'Something about {place} and {person}, everyone laughing. It was gone as soon as he reached for it.',
    'A good one, what he can keep of it: {place}, {person}, nothing wrong anywhere.',
    '{person} was there, and {place}, and he woke up in a better mood than the morning deserved.',
    'He was somewhere like {place} and it was easy. That\'s all that\'s left of it.',
    'Bits of a nice dream: {person}, the light at {place}. Then the alarm.',
    'He woke up smiling at something {person} said in a dream, and couldn\'t get it back.',
  ],
  flat: [
    'Something about {place}, {twist}. It made sense at the time.',
    'A strange one: {place}, {person} there for no reason. He lost the rest as he got up.',
    'He was {task}, at {place}, and then he wasn\'t.',
    'All he has of it is {place} and that {twist}.',
    '{person} turned up in a dream, at {place}, saying nothing useful.',
    'He dreamt about {place}, sort of. {twistCap}.',
  ],
  bad: [
    'A bad one, what he can remember of it: {place}, {task}, getting nowhere.',
    'He was {task} and {person} wouldn\'t look up. He woke up annoyed at nobody.',
    'Something had gone wrong at {place}, and he never found out what.',
    'He woke with it still on him: {task}, {twist}.',
    'In the dream {person} was waiting and he was {task}. It left a mood behind.',
    'He dreamt he was {task}. He checked his phone before he was properly awake.',
  ],
  nightmare: [
    'A nightmare, or the end of one: {place}, and {twist}. He woke with his heart going.',
    'He woke up fast. {twistCap}, at {place}, that much he remembers.',
    'He doesn\'t want the rest of that one: {place}, {twist}.',
    'Something was wrong at {place} and he couldn\'t get out. He lay awake a minute after.',
  ],
});

export const GRAPHIC_RE = /\b(blood\w*|gore|corpse\w*|dead body|stabb\w*|mutilat\w*|dismember\w*|suicid\w*|hang(ed|ing) himself|kill\w*|murder\w*|torture\w*)\b/i;
// The desire check only knows explicit vocabulary. A dream promises more than that: never sexual, not even suggestive, and nobody hurt. Dream-only: a hit keeps the template.
export const SEXUAL_RE = /\b(naked|nude|undress\w*|kiss\w*|in bed with|making love|made love|aroused|arousal|(?:his|her|their) lips (?:on|against|to|brush\w*|touch\w*|press\w*|met|part\w*)|lips (?:on|against) (?:his|her|their)|breasts?|thighs?|moan\w*|caress\w*|lingerie)\b/i;
export const HARM_RE = /\b((?<!\b(?:long|good|group|photo|screen|last|first|big) )shot(?! of\b| at (?:the|a|an) (?:title|job|goal)\b)|shoot\w*|stab\w*|bleed\w*|drown\w*|dying|died|dies|dead(?! (?:end|ends|tired|battery|phone|silence|quiet|air|calm|centre|center|still)\b)|wound\w*|injur\w*|throat|strangl\w*|choke\w*|choking)\b/i;
