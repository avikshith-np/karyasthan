// sched-fixes — the CHANGES descriptions (story/changeText.js describeChange):
// one code-built line per Director change kind, from its own events — scene,
// schedule (+ what it cancelled when applied, never a later expiry), outcome,
// career, money, home, mood / health, cast changes, weather, goal, place, quick
// buttons, controls — chat-made plans never named, owner labels quoted and cut
// at a word, ≤ 240 chars. Pure: no DB, no clock beyond the formatting.
import { section, check, eq, report } from './_helpers.js';
import { describeChange, KIND_HEADS } from '../../src/life/story/changeText.js';
import { zonedToUnix, dayLabel } from '../../src/life/clock.js';

const tz = 'UTC';
const T = (d, h, m = 0) => zonedToUnix(2026, 10, d, h, m, tz);
const NOW = T(30, 22);
const state = {
  cast: new Map([['cast:ana', { id: 'cast:ana', name: 'Ana' }], ['cast:bo', { id: 'cast:bo', name: 'Bo' }]]),
  places: new Map([['place:cafe', { id: 'place:cafe', name: 'Corner Cafe' }], ['place:home-2', { id: 'place:home-2', name: 'New flat' }]]),
  story: { departed: { 'cast:cy': { id: 'cast:cy', name: 'Cy' } } },
  decisions: new Map([
    [7, { id: 7, kind: 'outing', status: 'cancelled', options: [{ id: 'go', label: 'Late-night snack run' }] }],
    [8, { id: 8, kind: 'movie', status: 'cancelled', adopted: true, origins: [{ kind: 'dm' }], options: [{ id: 'go', label: 'Movie with a friend' }] }],
  ]),
  scheduleOverrides: { 40: { id: 40, date: '2026-10-31' } },
};
let nextId = 100;
const action = (kind, extra = {}) => ({ id: nextId++, type: 'director.action', actor: 'owner', at: NOW, payload: { kind, previewAt: NOW, count: 0, ...extra } });
const ev = (type, payload, extra = {}) => ({ id: nextId++, type, actor: 'owner', at: NOW, payload, ...extra });
const say = (kind, parts, effects = [], extra = {}) => describeChange({ action: action(kind, extra), parts, effects, state, tz, eventOf: () => null });

section('schedule: the day, the stretch, its label, what it cancelled');
{
  const set = ev('schedule.override_set', { op: 'set', date: '2026-10-31', ranges: [{ activity: 'home', from: T(31, 1, 15), to: T(31, 2, 30), label: 'Stays up late finishing the show' }], conflicts: [] });
  const exp = ev('decision.expired', { decisionId: 7, reason: 'schedule' }, { actor: 'engine', causeId: set.id });
  eq('the owner\'s example', say('schedule', [set], [exp]), `Schedule · ${dayLabel(T(31, 1), tz)} · home 01:15–02:30 'Stays up late finishing…' · cancelled: Late-night snack run`);
  const late = { ...exp, at: NOW + 3600 };
  eq('a later engine expiry is not this change', say('schedule', [set], [late]), `Schedule · ${dayLabel(T(31, 1), tz)} · home 01:15–02:30 'Stays up late finishing…'`);
  const chat = ev('decision.expired', { decisionId: 8, reason: 'schedule' }, { actor: 'engine' });
  check('a chat-made plan is never named', /cancelled: a plan from a chat$/.test(say('schedule', [set], [chat])) && !/Movie/.test(say('schedule', [set], [chat])));
  const bg = ev('schedule.override_set', { op: 'set', date: '2026-10-31', background: { activity: 'off', from: T(31, 0), to: T(31, 23), wholeDay: true },
    ranges: [{ activity: 'out', placeId: 'place:cafe', from: T(31, 16), to: T(31, 18) }] });
  eq('a day off + out at a place', say('schedule', [bg]), `Schedule · ${dayLabel(T(31, 16), tz)} · day off (whole day) · out at Corner Cafe 16:00–18:00`);
  eq('a move', say('schedule', [ev('schedule.override_set', { op: 'move', date: '2026-10-31', blockKind: 'gym', moveTo: T(31, 19) })]), `Schedule · ${dayLabel(T(31, 19), tz)} · moves gym to 19:00`);
  eq('a clear', say('schedule.clear', [ev('schedule.override_cleared', { overrideId: 40, from: NOW })]), 'Schedule cleared · schedule change #40 (2026-10-31) cleared');
}

section('scene, pick, outcome');
{
  const opened = ev('decision.opened', { kind: 'outing', subject: { eventAt: T(31, 0, 15), endAt: T(31, 1, 15), placeId: 'place:cafe', castIds: ['cast:ana'] },
    options: [{ id: 'go', label: 'Late-night snack run' }, { id: 'late' }, { id: 'stay' }] });
  const commit = ev('decision.committed', { decisionId: opened.id, optionId: 'go', by: 'owner' });
  eq('a scene', say('scene', [opened, commit]), `Scene · Late-night snack run at Corner Cafe with Ana · ${dayLabel(T(31, 0), tz)} 00:15–01:15 · committed: go`);
  eq('a pick on an existing plan', say('decision.pick', [ev('decision.committed', { decisionId: 7, optionId: 'stay', by: 'owner' })]), 'Pick · Late-night snack run → stay');
  eq('a reversal', say('decision.pick', [ev('decision.reversed', { decisionId: 7, from: 'go', to: 'stay', by: 'owner' })]), 'Pick · Late-night snack run: go → stay');
  eq('an outcome', say('outcome', [ev('outcome.set', { decisionId: 7, outcome: 'badly' })]), 'Outcome · Late-night snack run went badly');
  eq('CANCEL TONIGHT (quick)', say('quick', [ev('decision.expired', { decisionId: 7, reason: 'owner_cancelled' })]), 'Quick · cancelled: Late-night snack run');
  eq('a decision not in the state: from its decision.opened', describeChange({ action: action('outcome'), parts: [ev('outcome.set', { decisionId: 99, outcome: 'well' })], state, tz,
    eventOf: (id) => (id === 99 ? { id: 99, type: 'decision.opened', originKind: 'self', payload: { kind: 'dinner', options: [{ id: 'go', label: 'Dinner out' }] } } : null) }), 'Outcome · Dinner out went well');
}

section('career, money, home, mood, health');
{
  eq('career: a new job later', say('career', [ev('career.set', { reason: 'job', title: 'Senior planner', salary: 90000, effectiveAt: T(31, 9) })]),
    `Career · new job 'Senior planner' salary 90,000 from ${dayLabel(T(31, 9), tz)} 09:00`);
  eq('career: fired', say('career', [ev('career.set', { reason: 'fire' })]), 'Career · fired');
  eq('money', say('money', [ev('money.adjusted', { mode: 'expense', amount: 1250.5, label: 'new phone' })]), "Money · expense 1,251 'new phone'");
  eq('home', say('home', [ev('place.created', { id: 'place:home-2', name: 'New flat', kind: 'home' }), ev('self.moved', { homePlaceId: 'place:home-2', fromPlaceId: 'place:home' })]),
    'Home · new place New flat (home) · moves to New flat');
  eq('mood on waking', say('mood', [ev('vitals.planned', { delta: { mood: -0.3 }, label: 'low', wakeDate: '2026-10-31' })]), "Mood · 'low' mood −0.3 on waking 2026-10-31");
  eq('health later', say('health', [ev('sick.planned', { startAt: T(31, 8), days: 3 })]), `Health · sick from ${dayLabel(T(31, 8), tz)} 08:00 for 3 days`);
  eq('well again', say('health', [ev('sick.ended', {})]), 'Health · well again');
}

section('cast, weather, goal, place, controls');
{
  eq('a departure + the plans it ended', say('cast.depart', [ev('cast.departed', { castId: 'cast:bo', how: 'moved_away' })], [ev('decision.expired', { decisionId: 7, reason: 'cast_departed' }, { actor: 'engine' })]),
    'Cast leaves · Bo leaves (moved away) · cancelled: Late-night snack run');
  eq('a return (a departed name still resolves)', say('cast.return', [ev('cast.returned', { castId: 'cast:cy' })]), 'Cast returns · Cy is back');
  eq('cast numbers', say('cast.metrics', [ev('relationship.changed', { castId: 'cast:ana', delta: { trust: 0.1, closeness: -0.05 }, reason: 'owner' })]), 'Cast numbers · Ana trust +0.1, closeness −0.05');
  eq('a new cast member', say('scene', [ev('cast.created', { id: 'cast:dee', name: 'Dee', relation: 'friend' })]), 'Scene · new: Dee (friend)');
  eq('weather', say('weather', [ev('weather.window_set', { from: T(31, 14), to: T(31, 18), sky: 'rain', intensity: 'heavy' })]), `Weather · rain (heavy) ${dayLabel(T(31, 14), tz)} 14:00–18:00`);
  eq('goal', say('goal', [ev('goal.set', { goalKind: 'meet', castId: 'cast:ana', from: T(31, 0), to: T(31, 0) + 7 * 86400, label: 'catch up' })]),
    `Goal · meet 'catch up' with Ana ${dayLabel(T(31, 0), tz)} – ${dayLabel(T(31, 0) + 7 * 86400, tz)}`);
  eq('a goal cancelled', say('goal.cancel', [ev('goal.cancelled', { goalId: 12 })]), 'Goal cancelled · goal #12 cancelled');
  eq('a real place', say('place.real', [ev('place.updated', { placeId: 'place:cafe', name: 'Blue Door Cafe' }), ev('route.recorded', {})]), "Place · Corner Cafe renamed 'Blue Door Cafe'");
  eq('a slider', say('slider', [ev('director.slider_set', { slider: 'drama', value: 0.3 })]), 'Slider · drama 0.3');
  eq('a pin', say('pin', [ev('director.pin_set', { pinKey: 'cast:ana' })]), 'Pin · pin cast:ana');
}

section('limits');
{
  check('every Director action kind has a head', ['scene', 'schedule', 'decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health', 'cast.depart', 'cast.return',
    'cast.metrics', 'weather', 'goal', 'place.real', 'place.edit', 'quick'].every(k => typeof KIND_HEADS[k] === 'string'));
  const many = Array.from({ length: 30 }, (_, i) => ev('money.adjusted', { mode: 'income', amount: 1000 + i, label: `bonus number ${i}` }));
  const long = say('money', many);
  check('≤ 240 chars, ends with …', long.length <= 240 && long.endsWith('…'), long.length);
  check('an unknown kind / event type reads as words', say('mystery.kind', [ev('odd.thing', {})]) === 'Mystery kind · odd thing');
  check('never throws on junk', typeof describeChange({ action: null, parts: [null, 1, { type: 'x' }] }) === 'string');
  check('no JID or chat text ever (a chat-made decision.opened)', !/whatsapp|Movie/.test(describeChange({ action: action('outcome'), state: { decisions: new Map() }, tz,
    parts: [ev('outcome.set', { decisionId: 98, outcome: 'well' })],
    eventOf: () => ({ id: 98, type: 'decision.opened', originKind: 'dm', subjectJid: '15550001111@s.whatsapp.net', payload: { options: [{ id: 'go', label: 'Movie' }] } }) })));
}

report();
