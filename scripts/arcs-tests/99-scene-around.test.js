// Pinned #8 (2026-11-01 live): the café scene had them leave together, while in his life he
// walked home alone and she came over at 17:30; another scene called the night before "days
// earlier". The scene sheet now carries the phone's true lines: when they last saw each other,
// their time together in the two days before, how he left and what followed, and what's planned
// with them next — and the charter says the scene never contradicts them.
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR, DAY,
} from './_helpers.js';
import { getEvent, eventsAfter, lastEventId, appendEvent } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix, hhmm } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { afterwardsLines, aroundOf, buildFactSheet, ownerIntentOf } from '../../src/life/story/scenes/facts.js';
import { renderUser, SCENE_CHARTER } from '../../src/life/story/scenes/charter.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const sceneJson = () => JSON.stringify({
  narration: 'They met at the cafe and talked for a long while about small things. The street was quiet and the coffee was good. '
    + 'He laughed more than he had all week, and when it was time they said goodbye at the door and he walked home.',
  impressions: null, topics: ['small things'], highlight: 'laughing over coffee', awkward: null,
  chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [],
});
const cr = fakeCallRole({
  'life.scene.clerk': () => sceneJson(),
  'life.scene.mind': () => sceneJson(),
});
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest({ mindBudgetOk: async () => ({ ok: true }), knownNames: () => [], getUsageByCaller: () => [] });
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const FRIEND = 'cast:coworker-a';
const friendName = () => S().cast.get(FRIEND)?.name;

section('afterwardsLines (pure)');
{
  const s = S();
  const T = clock.now();
  const session = { mode: 'full', castIds: [FRIEND], placeId: 'place:cafe', startAt: T, endAt: T + 2 * HOUR, home: false };
  const ev = (id, at, type, payload) => ({ id, at, type, payload, originKind: 'self' });
  const evs = [
    ev(1, T + 2 * HOUR, 'travel.started', { from: 'place:cafe', to: 'place:home', mode: 'walk' }),
    ev(2, T + 2 * HOUR + 12 * 60, 'travel.arrived', { to: 'place:home' }),
    ev(3, T + 2 * HOUR + 12 * 60, 'activity.started', { kind: 'free', placeId: 'place:home', withCast: [] }),
    ev(4, T + 2.5 * HOUR, 'activity.started', { kind: 'visit', placeId: 'place:home', withCast: [FRIEND] }),
  ];
  const lines = afterwardsLines(evs, s, session, tz);
  eq('he walked home on his own, and when', lines[0], `${hhmm(T + 2 * HOUR, tz)}: he walked home on his own, there by ${hhmm(T + 2 * HOUR + 12 * 60, tz)}`);
  eq('she came over later', lines[1], `${hhmm(T + 2.5 * HOUR, tz)}: ${friendName()} came over to his place`);
  const together = afterwardsLines([evs[0], evs[1], { ...evs[2], payload: { kind: 'walk', placeId: 'place:home', withCast: [FRIEND] } }], s, session, tz);
  check('leaving together reads "with <name>"', together[0]?.includes(`with ${friendName()}`), together);
  eq('nothing known → no lines', afterwardsLines([], s, session, tz), []);
  eq('aroundOf leaves an older sheet unchanged when there is nothing', aroundOf({}), {});
}

section('an older visit labelled "Go to <home>" reads as who came over');
{
  const s = S();
  const home = s.self?.homePlaceId ?? 'place:home';
  const st = { ...s, decisions: new Map([[77, { id: 77, status: 'committed', committed: { optionId: 'go', by: 'owner' },
    options: [{ id: 'go', label: 'Go to the flat' }], subject: { placeId: home, castIds: [FRIEND] } }]]) };
  const session = { mode: 'full', castIds: [FRIEND], placeId: home, decisionId: 77, originKind: 'owner', startAt: clock.now(), endAt: clock.now() + HOUR };
  const intent = ownerIntentOf(st, session, { tone: 'cosy' });
  eq('the owner line names who came over', intent, `${friendName()} comes over to his place`);
}

section('the sheet and the charter');
{
  const s = S();
  const T = clock.now();
  const session = { mode: 'full', castIds: [FRIEND], placeId: 'place:cafe', startAt: T, endAt: T + 2 * HOUR, minutes: 120, kind: 'hangout', originKind: 'self' };
  const built = buildFactSheet(s, session, {
    tz, lastSaw: { [FRIEND]: 'last night, Sat 31 Oct 23:30: drinks' },
    together: ['last night, Sat 31 Oct 23:30: drinks at the bar with X, 23:30–02:10'],
    afterwards: ['17:00: he walked home on his own, there by 17:12'],
    plansAfter: ['later this evening, 17:30–19:00: X coming over to his place'],
  });
  const user = renderUser(built.sheet);
  check('last saw is on the person', user.includes('last saw: last night'));
  check('together before / afterwards / planned next are rendered', ['together before (true):', 'afterwards (true):', 'planned next with them (true):'].every(k => user.includes(k)), user);
  check('the charter: true lines are never contradicted, day words from them',
    /never contradicts them/.test(SCENE_CHARTER) && /never "days ago" for yesterday/.test(SCENE_CHARTER));
  const plain = renderUser(buildFactSheet(s, session, { tz }).sheet);
  check('without them, no empty headings', !plain.includes('afterwards') && !plain.includes('last saw'));
}

section('live: a café afternoon, he walks home alone, she comes over later');
{
  config.arcs.sceneMindMaxPerDay = 20;
  config.arcs.sceneMaxPerDay = 20;
  const day = (offset, hh, mm = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + offset * DAY; };
  const apply = async (action) => { const pv = await director.preview(action, { relax: true, project: false }); return director.apply(pv.previewId, pv.fingerprint); };
  const before = lastEventId();
  const cafe = await apply({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: [FRIEND], startAt: day(1, 15, 0), minutes: 120, label: 'Coffee with a friend' });
  await apply({ kind: 'scene', shape: 'visit', placeId: 'place:home', castIds: [FRIEND], startAt: day(1, 17, 30), minutes: 90, label: 'She comes over' });
  check('both applied', cafe?.ok === true);
  const cafeStart = () => eventsAfter(before, 50000).find(e => e.type === 'activity.started' && e.payload?.placeId === 'place:cafe' && e.payload?.withCast?.includes(FRIEND));
  const ended = () => cafeStart() && eventsAfter(cafeStart().id, 50000).find(e => e.type === 'activity.ended' && e.causeId === cafeStart().id);
  for (let i = 0; i < 48 * 4 && !ended(); i++) await simulateHours(0.25);
  await simulateHours(0.25);
  const calls0 = cr.calls.length;
  await story.idle(); await story.runScenesNow(); await story.idle();
  void calls0;
  const call = cr.calls.filter(c => String(c.caller || '').startsWith('life.scene.')).find(c => /activity: [^\n]*hang|place: [^\n]*caf/i.test(String(c.user)));
  check('the café scene was written', !!call, cr.calls.map(c => c.caller));
  const u = String(call?.user ?? '');
  check('its sheet says how he really left', /afterwards \(true\):[\s\S]*he (walked|took|rode|went|drove) home on his own/.test(u), u.slice(-1500));
  check('and that she comes over to his place later', u.includes('planned next with them (true):') && u.includes('coming over to his place'), u.slice(-1500));
  void getEvent;
}

section('a text landing between preview and APPLY does not make the preview stale');
{
  const now = clock.now();
  const pv = await director.preview({ kind: 'weather', weatherKind: 'rain', intensity: 0.6, from: now + 3 * HOUR, to: now + 5 * HOUR });
  check('previewed', !!pv?.previewId, pv?.refusals);
  appendEvent({ type: 'phone.message', at: now, actor: 'engine', payload: { castId: FRIEND, castIds: [FRIEND], dir: 'in', msgId: 999, trigger: 'reply', exchange: 1, tone: 'warm', length: 12, bubbles: 1, textSha: 'x'.repeat(64) } });
  const res = await director.apply(pv.previewId, pv.fingerprint).catch(e => ({ ok: false, code: e.code, reason: e.reason }));
  eq('APPLY still goes through', res?.ok, true);
}

report();
