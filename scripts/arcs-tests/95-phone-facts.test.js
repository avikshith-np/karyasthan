// 019 (2026-11-01 live): the phone writers get his recent days and his plans as true lines,
// with day words worked out in code. Replays the live weekend: a Friday-night snack run
// (00:15–01:15 Sat) with one member, a Saturday-evening outing (17:30–23:30) with another,
// a bike ride home, sleep, a night wake by a text — and two plans set for Sunday afternoon /
// evening with her. Before this the texts moved last night's outing to "tonight", invented a
// 3 am cab and called the Friday-night snack "last night".

import { TEST_ZONE } from '../test-zone.js';
import { section, check, eq, report } from './_helpers.js';
import { relWhen, timelineLines, planLines, buildSheet } from '../../src/life/story/phone/facts.js';
import { HIS_CHARTER, CAST_CHARTER, renderUser } from '../../src/life/story/phone/charter.js';

const tz = TEST_ZONE;
const SUN_1305 = 1793538300;   // Sun 1 Nov 13:05
const SAT_1730 = 1793467800;   // Sat 31 Oct 17:30
const SAT_2330 = 1793489400;
const SAT_2348 = 1793490480;
const SUN_0058 = 1793494680;
const SUN_0232 = 1793500349;
const SUN_0245 = 1793501100;
const SAT_0015 = 1793405700;   // Sat 31 Oct 00:15 — Friday night
const SAT_0115 = 1793409300;
const CAFE = 1793545200;       // Sun 15:00
const CAFE_END = 1793552400;   // 17:00
const VISIT = 1793554200;      // Sun 17:30
const VISIT_END = 1793559600;  // 19:00

const places = new Map([
  ['place:home', { id: 'place:home', kind: 'home', name: 'Flat' }],
  ['place:rest', { id: 'place:rest', kind: 'restaurant', name: 'Noodle restaurant' }],
  ['place:stall', { id: 'place:stall', kind: 'street_food', name: 'Snack stall' }],
  ['place:cafe', { id: 'place:cafe', kind: 'cafe', name: 'Corner cafe' }],
]);
const cast = new Map([
  ['cast:a', { id: 'cast:a', name: 'Asha Quill', relation: 'acquaintance', metrics: { closeness: 0.4 } }],
  ['cast:b', { id: 'cast:b', name: 'Bina Moss', relation: 'friend', metrics: { closeness: 0.6 } }],
  ['cast:f', { id: 'cast:f', name: 'Flat Mate', relation: 'flatmate', metrics: { closeness: 0.5 } }],
]);
const decisions = new Map([
  [900, { id: 900, eventId: 900, kind: 'hangout', status: 'committed', committed: { optionId: 'go' }, origins: [{ kind: 'owner', jid: 'owner' }],
    subject: { eventAt: CAFE, placeId: 'place:cafe', castIds: ['cast:a'] }, options: [{ id: 'go', label: 'Afternoon hangout, just the two of them' }] }],
  [901, { id: 901, eventId: 901, kind: 'visit', status: 'committed', committed: { optionId: 'go' }, origins: [{ kind: 'owner', jid: 'owner' }],
    subject: { eventAt: VISIT, placeId: 'place:home', castIds: ['cast:a'] }, options: [{ id: 'go', label: 'She comes over' }] }],
  [902, { id: 902, eventId: 902, kind: 'movie', status: 'committed', committed: { optionId: 'go' }, origins: [{ kind: 'group', jid: 'x@g.us' }], chatOpened: true,
    subject: { eventAt: VISIT_END + 3600, placeId: 'place:cafe', castIds: [] }, options: [{ id: 'go', label: 'Movie with the gang' }] }],
  [903, { id: 903, eventId: 903, kind: 'hangout', status: 'committed', committed: { optionId: 'go' }, origins: [],
    subject: { eventAt: SAT_1730, placeId: 'place:rest', castIds: ['cast:a'] }, options: [{ id: 'go', label: 'Dinner with her and her friends' }] }],
  [904, { id: 904, eventId: 904, kind: 'hangout', status: 'committed', committed: { optionId: 'stay' }, origins: [],
    subject: { eventAt: CAFE, placeId: 'place:cafe', castIds: ['cast:b'] }, options: [{ id: 'go', label: 'Not going' }] }],
]);
const s = { places, cast, decisions, self: { homePlaceId: 'place:home' }, story: { departed: {} } };
const ends = { 900: CAFE_END, 901: VISIT_END, 902: VISIT_END + 3 * 3600, 903: SAT_2330, 904: CAFE_END };
const endOf = (d) => ends[d.id] ?? null;

const ev = (id, type, at, payload, extra = {}) => ({ id, type, at, payload, originKind: 'self', subjectJid: null, ...extra });
const EVENTS_RAW = [
  ev(1, 'activity.started', SAT_0015, { kind: 'hangout', placeId: 'place:stall', withCast: ['cast:b'] }),
  ev(2, 'activity.ended', SAT_0115, { kind: 'hangout', placeId: 'place:stall' }),
  ev(3, 'travel.started', SAT_0115, { from: 'place:stall', to: 'place:home', mode: 'walk' }),
  ev(4, 'travel.arrived', SAT_0115 + 720, { to: 'place:home' }),
  ev(5, 'activity.started', SAT_1730, { kind: 'hangout', placeId: 'place:rest', withCast: ['cast:a'] }),
  ev(6, 'activity.ended', SAT_2330, { kind: 'hangout', placeId: 'place:rest' }),
  ev(7, 'travel.started', SAT_2330, { from: 'place:rest', to: 'place:home', mode: 'bike' }),
  ev(8, 'travel.arrived', SAT_2348, { to: 'place:home' }),
  ev(9, 'sleep.started', SUN_0058, { until: SUN_1305 }),
  ev(10, 'woke', SUN_0232, { interrupted: true, reason: 'woken_up' }),
  ev(12, 'activity.started', SAT_0015 - 9 * 3600, { kind: 'meeting', placeId: 'place:home', withCast: ['cast:b'] }),
  ev(13, 'activity.ended', SAT_0015 - 9 * 3600 + 2700, { kind: 'meeting', placeId: 'place:home' }),
  ev(14, 'travel.started', SAT_0015 - 900, { from: 'place:home', to: 'place:stall', mode: 'walk' }),
  ev(11, 'activity.started', SAT_1730 + 600, { kind: 'hangout', placeId: 'place:cafe', withCast: [] }, { originKind: 'dm', subjectJid: '1@s.whatsapp.net' }),
];
const EVENTS = [...EVENTS_RAW].sort((a, b) => a.at - b.at || a.id - b.id);

section('day words: a time before 05:00 belongs to the night before; past and future');
{
  eq('Sat 17:30 seen Sun 13:05 → yesterday evening', relWhen(SAT_1730, SUN_1305, tz), 'yesterday evening, Sat 31 Oct 17:30');
  eq('Sat 00:15 seen Sun 13:05 → Friday night, the night before last', relWhen(SAT_0015, SUN_1305, tz), 'Fri night (the night before last), Sat 31 Oct 00:15');
  eq('Sun 02:32 seen Sun 13:05 → last night', relWhen(SUN_0232, SUN_1305, tz), 'last night, Sun 1 Nov 02:32');
  eq('Sun 00:58 seen Sun 02:45 → earlier tonight', relWhen(SUN_0058, SUN_0245, tz), 'earlier tonight, Sun 1 Nov 00:58');
  eq('Sun 15:00 seen 13:05 → later this afternoon', relWhen(CAFE, SUN_1305, tz), 'later this afternoon, Sun 1 Nov 15:00');
  eq('Sun 17:30 seen 13:05 → later this evening', relWhen(VISIT, SUN_1305, tz), 'later this evening, Sun 1 Nov 17:30');
  eq('Mon 09:00 seen Sun 13:05 → tomorrow morning', relWhen(SUN_1305 + 71700, SUN_1305, tz), 'tomorrow morning, Mon 2 Nov 09:00');
}

section('his recent days: the live weekend, true lines');
{
  const forA = timelineLines(EVENTS, s, { at: SUN_1305, tz, castId: 'cast:a' });
  const outing = forA.find(l => l.includes('Asha Quill'));
  check('the Saturday outing: yesterday evening, the restaurant, with her, 17:30–23:30, bike home by 23:48, [together]',
    outing?.startsWith('yesterday evening, Sat 31 Oct 17:30: hangout at the') && /17:30–23:30/.test(outing) && /then bike home, there by 23:48/.test(outing) && /\[together\]$/.test(outing), outing);
  check('the Friday-night snack is "Fri night (the night before last)", walked home, not [together] for her',
    forA.some(l => l.startsWith('Fri night (the night before last), Sat 31 Oct 00:15: hangout') && /with Bina Moss/.test(l) && /then walk home/.test(l) && !/\[together\]/.test(l)), forA);
  check('asleep 00:58 last night, woken by his phone 02:32', forA.includes('last night, Sun 1 Nov 00:58: fell asleep') && forA.includes('last night, Sun 1 Nov 02:32: woken up (by his phone)'), forA);
  check('a work meeting is no outing, and a trip hours later is not "how he left"', !forA.some(l => /meeting/.test(l)) && !forA.some(l => /then walk to/.test(l)), forA);
  check('a chat-made / real-person event never shows', !forA.some(l => /cafe/.test(l) && /17:40/.test(l)) && forA.length === 4, forA);
  const forB = timelineLines(EVENTS, s, { at: SUN_1305, tz, castId: 'cast:b' });
  check('for the Friday friend: that night is [together], the Saturday one is not', forB.some(l => /Bina Moss/.test(l) && /\[together\]$/.test(l)) && forB.some(l => /Asha Quill/.test(l) && !/\[together\]/.test(l)));
  const ongoing = timelineLines(EVENTS.filter(e => e.at <= SAT_1730 + 3600), s, { at: SAT_1730 + 3600, tz, castId: 'cast:a' });
  check('an outing still under way says so', ongoing.some(l => /still going on/.test(l)), ongoing);
}

section('≤ 10 lines: the shared outing is kept even when it is the oldest');
{
  const extra = Array.from({ length: 12 }, (_, i) => ev(100 + i, i % 2 ? 'woke' : 'sleep.started', SAT_1730 + 7 * 3600 + i * 600, {}));
  const evs = [...EVENTS.filter(e => e.id <= 4), ...extra].sort((a, b) => a.at - b.at || a.id - b.id);
  const lines = timelineLines(evs, s, { at: SUN_1305, tz, castId: 'cast:b' });
  check('10 lines, the [together] one among them', lines.length === 10 && lines.some(l => /Bina Moss/.test(l) && /\[together\]$/.test(l)), lines);
}

section('his plans: committed go / late ahead, with whom, chat-made ones only "busy"');
{
  const forA = planLines(s, { at: SUN_1305, tz, castId: 'cast:a', endOf });
  eq('two plans with her (café, then she comes over), a chat plan as busy; past and declined ones left out', forA.length, 3);
  check('the café: later this afternoon 15:00–17:00, at the café (a fictional place keeps its name), with her, [with them]',
    /^later this afternoon, Sun 1 Nov 15:00–17:00: Afternoon hangout, just the two of them \(at the Corner cafe\) with Asha Quill \[with them/.test(forA[0]), forA[0]);
  check('the visit: later this evening 17:30–19:00, she is coming over to his place, [with them]', /^later this evening, Sun 1 Nov 17:30–19:00: Asha Quill coming over to his place \[with them/.test(forA[1]), forA[1]);
  check('the chat-made plan: busy, no label, place or people', /: busy \(other plans\)$/.test(forA[2]) && !/Movie|gang|cafe|Corner/i.test(forA[2]), forA[2]);
  const forB = planLines(s, { at: SUN_1305, tz, castId: 'cast:b', endOf });
  check('texting someone else: the same plans, never marked [with them]', forB.length === 3 && forB.every(l => !/\[with them/.test(l)) && /with Asha Quill/.test(forB[0]));
  const during = planLines(s, { at: CAFE + 1800, tz, castId: 'cast:a', endOf });
  check('a plan under way reads "right now (since 15:00), until 17:00"', /^right now \(since 15:00\), until 17:00:/.test(during[0]), during);
}

section('the flatmate at home is not "coming over"');
{
  const d = new Map([[950, { id: 950, eventId: 950, kind: 'dinner', status: 'committed', committed: { optionId: 'go' }, origins: [], subject: { eventAt: VISIT, placeId: 'place:home', castIds: ['cast:f'] }, options: [{ id: 'go', label: 'Dinner in' }] }]]);
  const l = planLines({ ...s, decisions: d }, { at: SUN_1305, tz, endOf: () => VISIT_END });
  check('a plan at home with the flatmate keeps its own words', /Dinner in \(at his place\) with Flat Mate/.test(l[0]) && !/coming over/.test(l[0]), l);
}

section('the sheet and the writers');
{
  const { sheet } = buildSheet({ ...s, at: SUN_1305 }, { castId: 'cast:a', dir: 'in', trigger: 'reply' }, {
    tz, at: SUN_1305, side: 'cast', trigger: 'reply', persona: { displayName: 'Kiran' }, thread: [],
    timeline: timelineLines(EVENTS, s, { at: SUN_1305, tz, castId: 'cast:a' }), plans: planLines(s, { at: SUN_1305, tz, castId: 'cast:a', endOf }),
  });
  const u = renderUser(sheet);
  check('the facts block lists his recent days and his plans', /his recent days \(true, from his life; \[together\] = with them\):/.test(u) && /\n- yesterday evening, Sat 31 Oct 17:30: hangout/.test(u)
    && /his plans \(true\):/.test(u) && /\n- later this afternoon, Sun 1 Nov 15:00–17:00/.test(u), u.slice(0, 1600));
  const empty = renderUser(buildSheet({ ...s, decisions: new Map(), at: SUN_1305 }, { castId: 'cast:a', dir: 'out', trigger: 'reply' }, { tz, at: SUN_1305, side: 'his', trigger: 'reply', persona: { displayName: 'Kiran' }, thread: [] }).sheet);
  check('none known → said so (no room to invent "a recent night out")', /his recent days: nothing with anyone in the last two days/.test(empty) && /his plans: none set/.test(empty));
  check('her charter: she only KNOWS what is [together] / [with them] or what he told her; the rest is there not to contradict',
    /What you KNOW: only what is marked \[together\] \/ \[with them\] and what he has told you in the thread/.test(CAST_CHARTER) && /you don't know it, so never mention it unless he told you/.test(CAST_CHARTER));
  check('both charters: the facts win over the thread; day words as given; a shared plan is known to both',
    /Anything in the thread that contradicts them was a mistake/.test(HIS_CHARTER) && /Anything in the thread that contradicts them was a mistake/.test(CAST_CHARTER)
    && /\[with them\] is one you both know about/.test(HIS_CHARTER) && /never move something you did together to another day/.test(CAST_CHARTER) && /keep that time for it/.test(CAST_CHARTER));
  const day = renderUser({ ...sheet, chat: 'long', time: { day: 'Sun 1 Nov', at: '13:05', daypart: 'afternoon' } });
  const night = renderUser({ ...sheet, chat: 'long', time: { day: 'Sun 1 Nov', at: '02:45', daypart: 'late night' } });
  check('a long chat is "late at night" only at night', !/late at night/.test(day) && /late at night, both of them up/.test(night));
}

report();
