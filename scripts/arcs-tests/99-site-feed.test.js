// Plan 020: the real readers behind the site's keys. test:public checks the filter and the schema with stubs; here `publicLive` and
// `publicDreams` run on the real log: a fictional outing has a line and beats, a chat's or a real person's has none, a private one says only that.
// Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR, DAY } from './_helpers.js';
import { appendEvent, eventsAfter, getEvent, lastEventId } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as dreamStore from '../../src/life/story/dreams/store.js';
import { publicBeats } from '../../src/life/liveSession.js';
import { zonedToUnix, localParts, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const { world, clock, life } = await bootLife({ callRole: fakeCallRole({}) });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => [] });
config.arcs.scenesEnabled = false;
config.arcs.phoneOrganicPerDay = 0;
const tz = resolveTimezone(world.timezone);
const FLAT = 'cast:flatmate';
const at = (off, h) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, h, 0, tz) + off * DAY; };
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
await simulateHours(4);
await story.idle();

section('nothing on');
eq('no outing: null', life.publicLive(), null);

section('out with someone fictional');
{
  const start = at(1, 15);
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: start, minutes: 120, castIds: [FLAT], label: 'an afternoon out' }, { relax: true });
  await director.apply(pv.previewId, pv.fingerprint);
  await stepTo(start + 40 * 60);
  const v = life.publicLive();
  check('a line', typeof v?.line === 'string' && v.line.length > 0, v);
  eq('his cast, by internal id for the exporter to salt', v.castIds, [FLAT]);
  eq('the place by id', v.placeId, 'place:cafe');
  check('a phase, and times', ['arriving', 'settling', 'main', 'lull', 'winding', 'leaving'].includes(v.phase) && Number.isFinite(v.startAt) && Number.isFinite(v.until));
  check('the place isn\'t in the words: the site has it by id', !/^(a |the )?caf[eé]\b/i.test(v.line), v.line);
  check('beats: code words, newest last', v.beats.every((b, i) => typeof b.text === 'string' && (i === 0 || b.at >= v.beats[i - 1].at)) && v.beats.length <= 6, v.beats);
  await stepTo(start + 125 * 60);
}

section('beats never carry a word of a chat');
{
  const beats = publicBeats({ topics: [{ words: 'their work lately', from: 10 }], interruptions: [{ at: 20, kind: 'chats', sent: 0, received: 9 }, { at: 30, kind: 'chats_sent', sent: 2, received: 1 }, { at: 40, kind: 'text', who: 'Robin', answered: true }, { at: 50, kind: 'answered', who: 'Robin' }] });
  eq('code words only', beats.map(b => b.text), ['talking about their work lately', 'his phone buzzed', 'he was on his phone for a bit', 'a text from Robin; he answered it', 'he texted Robin']);
  eq('at most six, the newest', publicBeats({ topics: Array.from({ length: 9 }, (_, i) => ({ words: `t${i}`, from: i })) }).map(b => b.text).at(-1), 'talking about t8');
  eq('nothing to say', publicBeats(null), []);
}

const fixture = (extra = {}) => {
  const t = clock.now();
  return appendEvent({ type: 'activity.started', at: t, actor: 'engine', ...extra, payload: { kind: 'hangout', placeId: 'place:cafe', end: t + 2 * HOUR, withCast: [FLAT], social: true } });
};

section('a real person\'s outing, a chat\'s, a heavy one: null');
{
  fixture({ subjectJid: '15550000099@s.whatsapp.net' });
  story.__rebuildForTest();
  eq('a real person', life.publicLive(), null);
  await simulateHours(3);
  const chat = fixture({ originKind: 'group', originJid: '120363000000099001@g.us' });
  story.__rebuildForTest();
  check('…it is underway', life.getState().activity?.eventId === chat.id);
  eq('a chat', life.publicLive(), null);
  await simulateHours(3);
}

section('a private session: that, and nothing more');
{
  const orig = life.liveSession;
  void orig;
  // The private flag comes from liveContext's register (arcs 99-live-session reads it). Its shape is checked in test:public; here, its read:
  const src = (await import('fs')).readFileSync(new URL('../../src/life/index.js', import.meta.url), 'utf8');
  const body = src.split('export function publicLive()')[1].split('\n}\n')[0];
  check('it returns before any place, person, line or beat is read', body.indexOf("if (v.private === true) return { private: true };") > 0 && body.indexOf("if (v.private === true)") < body.indexOf('liveSessionTrace(') && body.indexOf("if (v.private === true)") < body.indexOf('placeId'));
}

section('the real dream words');
{
  const sleep = eventsAfter(0, 500000).filter(e => e.type === 'sleep.started').at(-1);
  const ev = appendEvent({ type: 'dream.had', at: clock.now(), actor: 'engine', causeId: sleep.id, payload: { recall: 'fragment', tone: 'flat', castIds: [FLAT], placeIds: ['place:cafe'], until: clock.now() + HOUR } });
  story.__rebuildForTest();
  dreamStore.insertDream({ eventId: ev.id, sleepEventId: sleep.id, night: '2026-10-30', at: ev.at, recall: 'fragment', tone: 'flat', plan: { scenes: [], castIds: [FLAT] }, text: 'Something about a cafe. It made sense at the time.' }, clock.now());
  eq('the words and the night', life.publicDreams([ev.id]).get(ev.id), { text: 'Something about a cafe. It made sense at the time.', night: '2026-10-30' });
  const raw = life.publicRaw({ days: 14 });
  check('it is listed', raw.dreams.some(d => d.eventId === ev.id));
  const pending = appendEvent({ type: 'dream.had', at: clock.now(), actor: 'engine', causeId: sleep.id, payload: { recall: 'vivid', tone: 'flat', castIds: [], placeIds: [], until: clock.now() + HOUR } });
  story.__rebuildForTest();
  dreamStore.insertDream({ eventId: pending.id, sleepEventId: sleep.id, night: '2026-10-30', at: pending.at, recall: 'vivid', tone: 'flat', plan: { scenes: [] }, text: 'A template.', needsWords: true }, clock.now());
  check('a vivid dream still waiting for its words: not yet', !life.publicDreams([pending.id]).has(pending.id));
  dreamStore.sweep((id) => id === ev.id);
  check('swept: gone', !life.publicDreams([ev.id]).has(ev.id));
}

void lastEventId; void getEvent;
await stopLife();
report();
