// Plan 020 C1–C2: the state and the words of the live line, from fixtures. Phases over time, moods by
// outcome, moodlets that fade, the repeat memory over a 4-hour session, grammar for she / he / they, what the
// phrase table may never say, sick, tired, a film, the private form. Pure: no DB, no clock, no network.
import { section, check, eq, report } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { buildBase, walkSession, lineParts, liveView, traceOf, interruptionsOf, placeClass, pronounsOf, firstName, phaseAt, PHASES } from '../../src/life/liveSession.js';
import * as P from '../../src/life/livePhrases.js';
import { rngFor } from '../../src/life/rng.js';

const T0 = 1793300000;
const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
const hourOf = (t) => new Date(t * 1000).getUTCHours();
const SHE = [{ id: 'cast:ana', name: 'Ana Reed', pronouns: 'she/her' }];
const HE = [{ id: 'cast:bo', name: 'Bo', pronouns: 'he/him' }];
const THEY = [{ id: 'cast:f', name: 'Flatmate (example)', pronouns: 'they/them' }];
const facts = (o = {}) => ({ activityId: 100, startAt: T0, endAt: T0 + 240 * 60, kind: 'hangout', placeKind: 'cafe', placeWord: 'cafe', cast: SHE, closeness: 0.6, tension: 0.1, outcome: 'fine', topicCodes: ['beat:news', 'job'], ...o });
const make = (o) => buildBase(facts(o), { rngFor, date: '2026-11-05', hhmm, hourOf });
const inputs = (base, events = [], vit = () => ({ energy: 60, mood: { valence: 0.1 } })) => { base.facts.nameOf = (id) => id.split(':')[1]; return { moodlets: interruptionsOf(base, events), vitalsAt: vit }; };
const lines = (base, inp, to = base.endAt) => walkSession(base, inp, to).map(s => lineParts(base, s).slice(1));
const text = (id, at, castId, dir = 'in') => ({ id, at: T0 + at * 60, type: 'phone.message', payload: { castId, dir } });

section('phases');
{
  const b = make();
  eq('it starts arriving', phaseAt(b, T0), 'arriving');
  eq('it ends leaving', phaseAt(b, b.endAt - 60), 'leaving');
  const order = b.spans.map(s => s.phase);
  check('in order, with lulls inside the main stretch', order[0] === 'arriving' && order[1] === 'settling' && order.at(-2) === 'winding' && order.at(-1) === 'leaving' && order.includes('lull'), order.join(','));
  check('no gaps, no overlaps', b.spans.every((s, i) => i === 0 || s.from === b.spans[i - 1].to), JSON.stringify(b.spans));
  check('all known', order.every(p => PHASES.includes(p)));
  const short = make({ endAt: T0 + 20 * 60 });
  eq('a 20-minute one still has its phases', [short.spans[0].phase, short.spans.at(-1).phase], ['arriving', 'leaving']);
  check('…no lulls in it', !short.spans.some(s => s.phase === 'lull'));
  const flat = make({ outcome: 'flat' });
  const well = make({ outcome: 'well' });
  check('going flat: more lulls than going well', flat.spans.filter(s => s.phase === 'lull').length > well.spans.filter(s => s.phase === 'lull').length);
  const wind = (x) => x.spans.find(s => s.phase === 'winding').from;
  check('going badly: it winds down sooner', wind(make({ outcome: 'badly' })) < wind(make({ outcome: 'well' })));
  const tired = make({ energyAtStart: 15 });
  check('tired: it winds down sooner', wind(tired) < wind(make({ energyAtStart: 80 })));
  check('a film has no lull', !make({ kind: 'movie', placeKind: 'cinema' }).spans.some(s => s.phase === 'lull'));
  eq('past its end, still there: leaving', phaseAt(b, b.endAt + 600), 'leaving');
}

section('what kind of outing');
{
  eq('a film', placeClass('movie', 'cinema', false), 'watch');
  eq('eating out', placeClass('eat-out', 'restaurant', false), 'food');
  eq('drinks', placeClass('drinks', 'bar', false), 'bar');
  eq('a walk', placeClass('walk', 'park', false), 'outdoor');
  eq('a visit at home', placeClass('visit', 'home', true), 'home');
  eq('a hangout at a cafe', placeClass('hangout', 'cafe', false), 'cafe');
  eq('a hangout at the park', placeClass('hangout', 'park', false), 'outdoor');
  eq('something new: somewhere to sit and talk', placeClass('some-new-kind', null, false), 'cafe');
  eq('a kind with a prefix', placeClass('career:movie', null, false), 'watch');
  eq('pronouns', [pronounsOf(SHE).she, pronounsOf(HE).them, pronounsOf(THEY)["she's"], pronounsOf([...SHE, ...HE]).her, pronounsOf([{ id: 'x' }]).she], ['she', 'him', "they're", 'their', 'they']);
  eq('names', [firstName('Ana Reed'), firstName('Flatmate (example)'), firstName(null)], ['Ana', 'Flatmate', 'them']);
}

section('mood follows the outcome; the same every read');
{
  const end = (outcome) => { const b = make({ outcome }); return liveView(b, inputs(b), T0 + 230 * 60).them[0].mood; };
  eq('going well, near the end', end('well'), 'high');
  eq('going badly, near the end', end('badly'), 'low');
  const b1 = make(); const b2 = make();
  eq('deterministic', JSON.stringify(lines(b1, inputs(b1))), JSON.stringify(lines(b2, inputs(b2))));
  const other = make({ activityId: 101 });
  check('another outing reads differently', JSON.stringify(lines(other, inputs(other))) !== JSON.stringify(lines(b1, inputs(b1))));
  const at = T0 + 90 * 60;
  const whole = walkSession(b1, inputs(b1), T0 + 240 * 60);
  const upTo = walkSession(b1, inputs(b1), at);
  eq('the line at a moment doesn\'t depend on what came after', JSON.stringify(upTo.at(-1).parts), JSON.stringify(whole[upTo.length - 1].parts));
}

section('moodlets dip and fade in 10–20 minutes');
{
  const b = make();
  const inp = inputs(b, [text(1, 60, 'cast:mum')]);
  const m = inp.moodlets[0];
  check('its fade is 10–20 minutes', m.fade >= 600 && m.fade <= 1200, String(m.fade));
  const at = (min) => liveView(b, inp, T0 + min * 60);
  const none = (() => { const c = make(); return liveView(c, inputs(c), T0 + 60 * 60).attention.value; })();
  check('it dips attention at once', at(60).attention.value < none, `${none} vs ${at(60).attention.value}`);
  check('…and closeness', at(60).closeness.value < (() => { const c = make(); return liveView(c, inputs(c), T0 + 60 * 60).closeness.value; })());
  check('half gone by half its fade', at(60 + m.fade / 120).interruptions[0].fades < 0.6);
  eq('gone by 21 minutes', at(81).interruptions.length, 0);
  const big = inputs(b, Array.from({ length: 12 }, (_, i) => text(i + 1, 60, 'cast:mum')));
  check('a pile of them is capped', liveView(b, big, T0 + 60 * 60).attention.value >= 0.3, String(liveView(b, big, T0 + 60 * 60).attention.value));
  const here = inputs(b, [text(1, 60, 'cast:ana')]);
  eq('from the person he is with: not one', here.moodlets.length, 0);
  const load = inputs(b, [{ id: 9, at: T0 + 60 * 60, type: 'chat.load', payload: { sent: 0, received: 0 } }]);
  eq('an empty chat load: not one', load.moodlets.length, 0);
}

section('his phone: shown from the log');
{
  const b = make();
  const parts = (evs, min) => lineParts(b, walkSession(b, inputs(b, evs), T0 + min * 60).at(-1)).join(' · ');
  check('a text in: on the line that very step', /phone|text|mum/.test(parts([text(1, 60, 'cast:mum')], 60)), parts([text(1, 60, 'cast:mum')], 60));
  check('…gone from it the next', !/his phone (buzzed|lit)|text came|texted/.test(parts([text(1, 58, 'cast:mum')], 70)), parts([text(1, 58, 'cast:mum')], 70));
  check('he answered: says so, by name', /mum/.test(parts([text(1, 60, 'cast:mum'), text(2, 60, 'cast:mum', 'out')], 60)), parts([text(1, 60, 'cast:mum'), text(2, 60, 'cast:mum', 'out')], 60));
  const chats = [{ id: 3, at: T0 + 60 * 60, type: 'chat.load', payload: { sent: 0, received: 12 } }];
  const line = parts(chats, 60);
  check('a real chat: no name, no number on the line', /group|chat|messages/.test(line) && !/\d/.test(line), line);
  const many = [text(1, 60, 'cast:a'), text(2, 60, 'cast:b'), text(3, 60, 'cast:c')];
  check('three at once: one line', /keeps|run of|will not stop/.test(parts(many, 60)), parts(many, 60));
}

section('a 4-hour session does not repeat itself');
for (const [title, o] of [['she, cafe, well', { outcome: 'well' }], ['he, bar, badly', { cast: HE, kind: 'drinks', placeKind: 'bar', outcome: 'badly' }], ['they, restaurant', { cast: THEY, kind: 'eat-out', placeKind: 'restaurant' }], ['home', { kind: 'visit', home: true, placeKind: 'home' }]]) {
  const b = make(o);
  const steps = walkSession(b, inputs(b), b.endAt);
  const vibes = [];
  for (const s of steps) if (s.parts.vibe && s.parts.vibe !== vibes.at(-1)) vibes.push(s.parts.vibe);
  eq(`${title}: every detail appears once`, vibes.length, new Set(vibes).size);
  const topics = steps.map(s => s.parts.topic).filter(Boolean);
  eq(`${title}: no topic form repeats word for word`, topics.length, new Set(topics).size);
  const distinct = new Set(steps.map(s => lineParts(b, s).join('|'))).size;
  check(`${title}: the line changes through the evening`, distinct >= steps.length * 0.4, `${distinct} of ${steps.length}`);
  check(`${title}: silence is allowed`, steps.some(s => lineParts(b, s).length === 1));
  let run = 1; let longest = 1;
  for (let i = 1; i < steps.length; i++) { run = lineParts(b, steps[i]).join() === lineParts(b, steps[i - 1]).join() ? run + 1 : 1; longest = Math.max(longest, run); }
  check(`${title}: no line sits for more than half an hour`, longest <= 6, String(longest));
  check(`${title}: at most three details at a time`, steps.every(s => lineParts(b, s).length <= 4));
}

section('every phrase, every pronoun');
{
  const flat = [];
  const walk = (v) => { if (typeof v === 'string') flat.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  for (const t of [P.GENERAL, P.SITTING, P.KNOWN, P.EMPLOYED, P.EVENING, P.PLACES, P.DETAILS, P.PHONE, P.PRIVATE, P.TOPIC_WORDS, P.TOPIC_NEW, P.TOPIC_NEW_HERS, P.TOPIC_STILL, P.TOPIC_BACK]) walk(t);
  check('a real variety of them', flat.length >= 250, String(flat.length));
  const sets = [SHE, HE, THEY, [...SHE, ...HE]].map(pronounsOf);
  const fill = (s, p) => s.replaceAll("{she's}", p["she's"]).replaceAll('{she}', p.she).replaceAll('{her}', p.her).replaceAll('{them}', p.them).replaceAll('{name}', 'Ana').replaceAll('{who}', 'Bo').replaceAll('{t}', 'x');
  const bad = [];
  for (const s of flat) for (const p of sets) {
    const out = fill(s, p);
    if (/[{}]/.test(out)) bad.push(`token: ${out}`);
    if (/they're (?:been|got|gone|had|done|left|come|seen|taken)\b/.test(out)) bad.push(`tense: ${out}`);
    if (/\bthey (?:has|is|was|wants|does|goes|says)\b|\bshe (?:have|are|want|go)\b|\bhe (?:have|are|want|go)\b/.test(out)) bad.push(`verb: ${out}`);
  }
  eq('every phrase reads right for she, he, they and two people', bad, []);

  // What the table must never hold: nothing sexual, at any heat, and nothing about anyone real.
  const NEVER = /\b(sex|sexy|naked|nude|undress|strip|kiss(ed|ing)?|bed|bedroom|moan|touch(ed|ing)?|horny|aroused|lust|breast|thigh|lips|skin|tongue|orgasm|condom|fuck|shag)\b/i;
  eq('no phrase is sexual or suggestive', flat.filter(s => NEVER.test(s)), []);
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../src/life/livePhrases.js'), 'utf8');
  check('the table reads nothing: no import, no state', !/\bimport\b/.test(src) && !/getPersona|persona\.|config\./.test(src));
  const persona = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../src/personality/persona.example.json'), 'utf8'));
  const terms = [persona.name, persona.displayName, ...(persona.aliases ?? [])].filter(Boolean).map(s => s.toLowerCase());
  eq('no persona name', flat.filter(s => terms.some(t => new RegExp(`\\b${t}\\b`).test(s.toLowerCase()))), []);
  eq('no timezone or region word', flat.filter(s => /Asia\/|Europe\/|America\/|India|Malayalam|Manglish|rupee/i.test(s)), []);
  for (const s of flat) if (s.length > 70) check(`short enough for a phone: ${s}`, false);
}

section('it says only what fits the moment');
{
  const all = (o, vit, events = []) => { const b = make(o); return walkSession(b, inputs(b, events, vit), b.endAt).map(s => lineParts(b, s).slice(1).join(' · ')).join('\n'); };
  const morning = { startAt: T0 - 8 * 3600, endAt: T0 - 8 * 3600 + 120 * 60 };   // about 10:53–12:53
  check('no "evening" or fading light in the morning', !/evening|light is going/.test(all({ ...morning, kind: 'walk', placeKind: 'park' })), all({ ...morning, kind: 'walk', placeKind: 'park' }));
  check('no late-night line in the morning', !/getting late|still up|streets/.test(all(morning)));
  const walk = all({ kind: 'walk', placeKind: 'park' });
  check('no door or chair on a walk', !/out the door|where to sit|getting up to go/.test(walk), walk);
  const first = all({ firstMeet: true, topicCodes: ['job'], closeness: 0.5 });
  check('no "catching up" on a first meeting', !/catching up|how've you been|usual how/.test(first), first);
  check('…some first-meeting words instead', /working each other out|first few careful|in common|first impressions|short version/.test(first), first);
  const out = all({ employed: false, topicCodes: [] });
  check('out of work: nothing about his work', !/his work|at work|manager|the office|complained about work/.test(out), out);
  const film = all({ kind: 'movie', placeKind: 'cinema' });
  check('a film: no topics of talk, no "catching up"', !/talking about (?!it)|got onto|catching up|on to /.test(film), film);
  const short = { endAt: T0 + 120 * 60 };
  const fb = make({ kind: 'movie', placeKind: 'cinema', ...short });
  const fs2 = walkSession(fb, inputs(fb), fb.endAt).map(s => s.parts.vibe);
  const mid = fs2.map((v, i) => (v === 'about halfway through' ? i : -1)).filter(i => i >= 0);
  check('"about halfway through" only about halfway', mid.every(i => i / fs2.length > 0.3 && i / fs2.length < 0.75), JSON.stringify(mid));
  const sick = all({ sick: true }, () => ({ energy: 20, sick: true, mood: { valence: -0.4 } }));
  check('sick: he reads sick', /not feeling great|trying not to cough|shouldn't have come out/.test(sick), sick);
  const b = make({ sick: true });
  eq('…his bands say so', liveView(b, inputs(b, [], () => ({ energy: 20, sick: true, mood: { valence: -0.4 } })), T0 + 60 * 60).his, { mood: 'low', energy: 'low', sick: true });
  const tired = all({}, () => ({ energy: 15, mood: { valence: 0 } }));
  check('tired: he reads tired', /yawn|fading|energy is going|could sleep|not much sleep/.test(tired), tired);
  check('rain at a cafe', /rain|pouring/.test(all({ rain: true })), all({ rain: true }));
  check('rain on a walk', /wet|rain|sheltering/.test(all({ rain: true, kind: 'walk', placeKind: 'park' })));
  {
    const b2 = make({ kind: 'eat-out', placeKind: 'restaurant' });
    const seq = walkSession(b2, inputs(b2), b2.endAt).map(s => s.parts.vibe ?? '');
    const first = (re) => seq.findIndex(v => re.test(v));
    const eating = first(/each other's food|stealing from|halfway through the plates|too full/);
    const arrived = first(/food arrived|first plates/);
    check('a meal in order: nobody eats before it comes', eating < 0 || arrived < 0 || arrived < eating, JSON.stringify(seq.filter(Boolean).slice(0, 12)));
    const longGone = first(/plates are long gone|nothing left on it/);
    check('…and nothing is "long gone" in the first half', longGone < 0 || longGone > seq.length * 0.5, String(longGone));
    const rainy = make({ rain: true });
    const rs = walkSession(rainy, inputs(rainy), rainy.endAt);
    check('rain is said early on, not hours later', rs.every(s => !/rain|pouring/.test(s.parts.vibe ?? '') || s.t - T0 < 115 * 60));
  }
  check('no rain without rain', !/rain|pouring|sheltering|getting wet/.test(all({})));
  check('late: he says so, early on', /late, apologising|been waiting|owes/.test(all({ lateMin: 25 })), all({ lateMin: 25 }));
  check('not late: no such line', !/late, apologising|been waiting a while|owes/.test(all({ lateMin: 3 })));
}

section('the private form');
{
  const b = make({ kind: 'visit', home: true, placeKind: 'home', register: 'private', topicCodes: ['job'] });
  const inp = inputs(b, [text(1, 60, 'cast:mum')]);
  const steps = walkSession(b, inp, b.endAt);
  eq('no topic', steps.filter(s => s.parts.topic).length, 0);
  eq('no phone line either', steps.filter(s => s.parts.phone).length, 0);
  check('only its few neutral words', steps.every(s => !s.parts.vibe || P.PRIVATE.includes(s.parts.vibe)), JSON.stringify([...new Set(steps.map(s => s.parts.vibe))]));
  eq('its trace has no topics', traceOf(b, inp, b.endAt).topics, []);
}

section('the trace');
{
  const b = make({ outcomeBy: 'code', lateMin: 15 });
  const tr = traceOf(b, inputs(b, [text(1, 60, 'cast:mum'), text(2, 62, 'cast:mum', 'out'), { id: 3, at: T0 + 100 * 60, type: 'chat.load', payload: { sent: 2, received: 5 } }]), T0 + 200 * 60);
  eq('the shape', Object.keys(tr).sort(), ['activityEventId', 'attention', 'endAt', 'interruptions', 'late', 'minutes', 'mood', 'outcome', 'outcomeBy', 'phases', 'startAt', 'topics'].sort());
  eq('how long', tr.minutes, 200);
  eq('how late', tr.late, 15);
  check('phases stop at its end', tr.phases.at(-1).to <= T0 + 200 * 60);
  check('topics carry codes and words', tr.topics[0].code === 'beat:news' && typeof tr.topics[0].words === 'string');
  const [i1, i2, i3] = tr.interruptions;
  eq('a text: who, and whether he answered', [i1.kind, i1.who, i1.answered], ['text', 'mum', true]);
  eq('his answer', [i2.kind, i2.who], ['answered', 'mum']);
  eq('a real chat: counts', [i3.kind, i3.sent, i3.received, i3.who], ['chats_sent', 2, 5, undefined]);
  check('small enough for a sheet', JSON.stringify(tr).length < 3000, String(JSON.stringify(tr).length));
  check('mood as changes over time', tr.mood.length >= 1 && tr.mood[0].at === T0);
}

report();
