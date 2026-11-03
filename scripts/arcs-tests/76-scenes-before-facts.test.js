// 016 scenes × "before the outing" facts (the live first-meeting bug, 2026-10-31): a
// member the Director created in the night (owner cast.created), an owner outing with them
// 10:30–12:00, and the daily cast pass at 10:57 — mid-outing — crediting that outing's
// time together (relationship.changed togetherMin 27) and its history line ("hangout
// together", dated 10:30). The scene written at 12:00 read the state then, saw time
// together + a history line and returned firstMeet: [] (no first-meeting framing, no
// impressions), and a REGENERATE reused that frozen list (R16).
//
// The class: every fact the sheet states about the world BEFORE the outing (firstMeet,
// the metrics bands, history, beats, the date check → the tier) comes from the world as of
// the outing's activity.started (worker.stateAtStart), never from the state at write time.
// Guard: a pass credit, a back-dated history line, a beat and a relationship drift landing
// at several points inside the session leave those facts exactly as a context taken with
// nothing mid-session; then the live replay of today's shape, and a REGENERATE that
// recomputes a wrong v1 firstMeet. Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR,
} from './_helpers.js';
import { appendEvent, getEvent, listEvents } from '../../src/life/eventLog.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import { contextFor, stateAtStart } from '../../src/life/story/scenes/worker.js';
import { sessionOf, tierOf, firstMeetOf } from '../../src/life/story/scenes/detect.js';
import { buildFactSheet } from '../../src/life/story/scenes/facts.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();

const sceneJson = () => JSON.stringify({
  narration: 'They met for breakfast at the cafe and stayed long after the plates were cleared. It was the first time they had sat down '
    + 'together, and by the second coffee they were swapping stories about the city and the jobs they almost took.',
  impressions: { him: [{ p: 'P1', text: 'easy to talk to, quick to laugh' }], them: [{ p: 'P1', text: 'warmer than he first seemed' }] },
  topics: ['the city', 'old jobs'], highlight: 'the second coffee', awkward: null,
  chemistry: 0.4, focus: 'P1', ending: 'swapped_numbers', effects: [],
});
const cr = fakeCallRole({ 'life.scene.mind': () => sceneJson(), 'life.scene.clerk': () => sceneJson() });
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => [] });
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
const since = (id, types) => listEvents({ types, limit: 5000 }).filter(e => e.id > id);
const lastId = () => Math.max(0, ...listEvents({ limit: 5000 }).map(e => e.id));
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); }
// Mid-session events as the daily pass / a beat / a drift append them (engine, self origin).
const inject = (d) => { const e = appendEvent({ actor: 'engine', ...d }); story.__rebuildForTest(); return e; };

// The before-facts a sheet states, compared field by field.
const beforeFacts = (ctx, built, session, s) => ({
  firstMeet: ctx.firstMeet,
  bands: built.sheet.people.map(p => [p.label, p.closeness, p.trust, p.tension, p.firstMeet]),
  history: built.sheet.people.map(p => p.history.length),
  beats: built.sheet.people.map(p => p.beats.join(',')),
  tierNoOwner: tierOf({ ...session, decisionId: null }, s, { firstMeet: ctx.firstMeet, before: ctx.before }),
});

const today0 = dayStart(clock.now(), tz);
const day2 = addDays(today0, 1, tz);
const PLACE = 'place:cafe';

section('scenes on; in the night the Director creates a new member and a breakfast outing with them');
let newId = null;
let decisionId = null;
let mark = 0;
{
  await simulateHours(14);
  await drain();
  check('cursor seeded', sceneStore.getCursor() !== null);
  await stepTo(at(day2, 3, 1));
  mark = lastId();
  const outing = {
    kind: 'scene', shape: 'outing', placeId: PLACE, startAt: at(day2, 10, 30), minutes: 90, label: 'Breakfast with Tamsin',
    newCast: { name: 'Tamsin Reed', relation: 'friend' },
  };
  const p = await story.director.preview(outing, { relax: true });
  const r = await story.director.apply(p.previewId, p.fingerprint);
  check('applied', r?.ok === true, JSON.stringify(r));
  const created = since(mark, ['cast.created']).find(e => e.payload?.name === 'Tamsin Reed');
  newId = created?.payload?.id ?? null;
  check('an owner cast.created in the night', !!newId && created.actor === 'owner', JSON.stringify(created));
  decisionId = [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === 'Breakfast with Tamsin')?.id ?? null;
  check('the outing decision exists', !!decisionId);
}

section('the outing starts; a context taken now (nothing mid-session yet) is the baseline');
let start = null;
let baseline = null;
{
  await stepTo(at(day2, 10, 35));
  start = since(mark, ['activity.started']).find(e => e.payload?.placeId === PLACE && (e.payload?.withCast ?? []).includes(newId));
  check('the outing with the new member started', !!start, JSON.stringify(since(mark, ['activity.started']).map(e => e.payload?.kind)));
  const session = sessionOf(start, { id: start.id + 1e6, at: start.at + 90 * 60, type: 'activity.ended' }, S());
  const ctx = contextFor(S(), session);
  baseline = beforeFacts(ctx, buildFactSheet(ctx.before, session, ctx), session, S());
  eq('baseline: a first meeting', baseline.firstMeet, [newId]);
  eq('…so the tier is mind even without the owner\'s direction', baseline.tierNoOwner, 'mind');
}

section('mid-session: a beat at 10:45, the daily pass at 10:57 (time together + a back-dated history line), a drift at 11:30');
{
  await stepTo(at(day2, 10, 45));
  inject({ type: 'cast.beat', at: clock.now(), payload: { castId: newId, kind: 'hobby', text: 'started a pottery class' } });
  await stepTo(at(day2, 10, 57));
  inject({ type: 'relationship.changed', at: clock.now(), payload: { castId: newId, delta: { togetherMin: 27, closeness: 0.04 }, reason: 'shared_time' } });
  inject({ type: 'cast.history_added', at: clock.now(), payload: { castId: newId, text: 'hangout together', dated: start.at } });
  await stepTo(at(day2, 11, 30));
  inject({ type: 'relationship.changed', at: clock.now(), payload: { castId: newId, delta: { closeness: 0.3, trust: 0.3, tension: 0.4 }, reason: 'drift' } });
  const rel = S().story?.relationships?.[newId];
  check('the state now says they have met (time together + a history line)', rel?.togetherMin > 0 && (S().story?.history?.[newId] ?? []).length > 0, JSON.stringify(rel));
  const end = { id: start.id + 1e6, at: start.at + 90 * 60, type: 'activity.ended' };
  const session = sessionOf(start, end, S());
  eq('the old read (the state at write time) loses the first meeting', firstMeetOf(session, S(), { metAtGenesis: () => false }), []);
  const ctx = contextFor(S(), session);
  check('the world before the outing was read', ctx.fromStart === true);
  eq('before-facts equal the baseline (firstMeet, bands, history, beats, tier)', beforeFacts(ctx, buildFactSheet(ctx.before, session, ctx), session, S()), baseline);
  check('stateAtStart is the fold up to the activity.started (its own id excluded)', stateAtStart(session)?.lastEventId < start.id, String(stateAtStart(session)?.lastEventId));
}

section('the outing ends at 12:00 → its scene is a first meeting, mind tier, with impressions');
let row = null;
{
  await stepTo(at(day2, 12, 20));
  const ended = since(mark, ['activity.ended']).find(e => e.causeId === start.id);
  check('…and ended', !!ended);
  await drain();
  [row] = sceneStore.versionsOf(start.id);
  eq('one scene row, done, mind tier', [row?.status, row?.tier], ['done', 'mind']);
  const played = getEvent(row?.eventId);
  eq('scene.played firstMeet = [the new member]', played?.payload?.firstMeet, [newId]);
  eq('the row\'s detail too', row?.detail?.firstMeet, [newId]);
  // The validator refuses impressions of anyone not first-met (impression_not_first_meet): kept here.
  check('impressions kept (only a first meeting may have them)', row?.detail?.impressions?.them?.[0]?.text === 'warmer than he first seemed', JSON.stringify(row?.detail?.impressions));
  const mind = cr.callsFor('life.scene.mind');
  check('the mind was told P1 meets him for the first time', mind.length === 1 && String(mind[0]?.user ?? '').includes('firstMeet: they meet him for the first time'), String(mind[0]?.user ?? '').slice(0, 300));
}

section('a REGENERATE recomputes firstMeet from the world before the outing (never a frozen wrong v1 list)');
{
  // A v1 written by the old code: firstMeet [] in the row (the reused roll's fallback source).
  sceneStore.update(row.id, { detail: { ...row.detail, firstMeet: [] } });
  const session = sessionOf(start, getEvent(row.eventId) && { id: start.id + 1e6, at: start.at + 90 * 60, type: 'activity.ended' }, S());
  const ctx = contextFor(S(), session, { fixed: { outcome: 'well', outcomeBy: 'code', firstMeet: [], sheet: null } });
  eq('with v1\'s list [] the rewrite still finds the first meeting', ctx.firstMeet, [newId]);
  eq('…and keeps v1\'s outcome (R16)', ctx.outcome.value, 'well');
  const res = await story.sceneRegenerate(row.id, {});
  check('regenerated', ['done', 'fallback'].includes(res?.status), JSON.stringify(res));
  const v2 = sceneStore.getScene(res?.sceneId);
  eq('v2: firstMeet = [the new member], mind tier', [v2?.detail?.firstMeet, v2?.tier], [[newId], 'mind']);
  eq('v2 keeps v1\'s outcome', v2?.detail?.outcome, row.detail.outcome);
}

report();
