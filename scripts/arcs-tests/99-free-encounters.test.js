// Plan 020 B, free topics: what the mind's night call may read of his own days, from the real log: his outings' talking points and his texts. Never a chat's, a real person's or
// anything heavy or explicit. Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, DAY, HOUR } from './_helpers.js';
import { appendEvent, eventsAfter } from '../../src/life/eventLog.js';
import { getDb } from '../../src/memory/db.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { zonedToUnix, localParts, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const sceneJson = () => JSON.stringify({
  narration: 'They met up after work and talked for a long while about small things. The street was quiet. He laughed more than he had all week, and by the end they were trading stories about nothing much at all.',
  impressions: null, topics: ['late night buses'], highlight: 'complaining about the buses', awkward: null, chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [],
});
const { world, clock, life } = await bootLife({ callRole: fakeCallRole({ 'life.scene.clerk': sceneJson, 'life.scene.mind': sceneJson }) });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] });
config.arcs.phoneOrganicPerDay = 0;
const tz = resolveTimezone(world.timezone);
const at = (off, h) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, h, 0, tz) + off * DAY; };
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h); };
await simulateHours(4);
await story.idle();

section('a real outing: its talking points, not its narration');
const start = at(1, 15);
{
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: start, minutes: 90, castIds: ['cast:flatmate'], label: 'Out' }, { relax: true });
  await director.apply(pv.previewId, pv.fingerprint);
  await stepTo(start + 2 * HOUR);
  await story.runScenesNow();
  await story.idle();
  const got = life.stanceEncounters({ from: start - HOUR, to: clock.now() });
  const sc = got.find(x => x.kind === 'scene');
  check('its talking points', sc?.text === 'complaining about the buses; late night buses', got);
  check('not the narration', !got.some(x => /met up after work/.test(x.text)));
}

const ins = getDb().prepare(`INSERT INTO story_messages (event_id, cast_id, at, dir, text, status, trigger, due_at, created_at) VALUES (?, 'cast:flatmate', ?, 'out', ?, 'live', 'test', ?, ?)`);
const text = (words, extra = {}) => {
  const ev = appendEvent({ type: 'phone.message', at: clock.now(), actor: 'engine', ...extra, payload: { castId: 'cast:flatmate', threadId: 'cast:flatmate', dir: 'out', ...(extra.payload ?? {}) } });
  ins.run(ev.id, ev.at, words, ev.at, clock.now());
  return ev;
};

section('his texts, under the same rule');
{
  const own = text('that new bus route is a joke');
  const chat = (() => { try { return text('CHATWORDS', { originKind: 'group', originJid: '120363000000099001@g.us' }); } catch { return null; } })();
  const hot = text('HOTWORDS', { payload: { heat: 'explicit' } });
  const warm = text('WARMWORDS', { payload: { heat: 'suggestive' } });
  story.__rebuildForTest();
  const got = life.stanceEncounters({ from: clock.now() - HOUR, to: clock.now() });
  void own; void chat; void hot; void warm;
  check('his own text', got.some(x => x.kind === 'text' && x.text === 'that new bus route is a joke'), got);
  check('never a chat-shaped one', !got.some(x => x.text === 'CHATWORDS'));
  check('never an explicit or suggestive one', !got.some(x => /HOTWORDS|WARMWORDS/.test(x.text)));
}

section('a heavy stretch: nothing from around it');
{
  appendEvent({ type: 'heavy.started', at: clock.now(), actor: 'engine', heavy: true, payload: { kind: 'loss', themeId: 'x', until: clock.now() + 3 * DAY } });
  story.__rebuildForTest();
  eq('nothing', life.stanceEncounters({ from: start - HOUR, to: clock.now() }), []);
}

void eventsAfter;
await stopLife();
report();
