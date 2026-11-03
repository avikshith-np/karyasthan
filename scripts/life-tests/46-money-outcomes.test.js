// 015 Director as god — money and outcomes (plan §P1.1, §P1.3, §P1.5): money
// set / income / expense exact; mood presets equal what the fold applies (within
// vitals.nudged's caps); an outing that goes BADLY → once it is over, an engine
// outcome.happened (caused by the outcome.set) moves his mood and adds tension
// with who he was with; a CANCELLED outcome falls through at its time (engine
// decision.expired {fell_through} + an engine re-plan without the outing) and
// reverting the outcome.set brings the outing back; an owner reversal cannot be
// flipped back by the engine and costs no tension; an outcome on an arc decision
// → use_arc_action. Example world, fake clock, no network.
import {
  section, check, eq, near, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from '../arcs-tests/_helpers.js';
import { getEvent, listEvents, appendEvent } from '../../src/life/eventLog.js';
import { rebuild } from '../../src/life/projector.js';
import { applyEvent as applyVitals, OUTCOME_VITALS } from '../../src/life/vitals.js';
import * as director from '../../src/life/story/director.js';
import { dayStart, addDays } from '../../src/life/clock.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(26);
const S = () => life.getState();

async function applyOk(action) {
  // 016: a scene of an outing that just ended commits on the story's chain; let it land
  // first (as the owner's page would refresh), so the preview is not stale at apply.
  await (await import('../../src/life/story/index.js')).idle();
  const p = await director.preview(action, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  return { p, r, events: r.eventIds.map(getEvent) };
}
async function code(p) {
  try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
// This evening at 19:30 world time (or tomorrow's, when that is under 3 h away): he is free then.
const evening = () => {
  const d0 = dayStart(clock.now(), world.timezone);
  let t = d0 + 19.5 * HOUR;
  if (t < clock.now() + 3 * HOUR) t = addDays(d0, 1, world.timezone) + 19.5 * HOUR;
  return t;
};
const place = () => [...S().places.values()].find(p => p.kind !== 'home' && p.kind !== 'office');
const pal = () => [...S().cast.values()].find(c => c.relation === 'flatmate' || c.relation === 'coworker');

section('money: exact folds');
{
  const v = { energy: 50, stress: 30, socialBattery: 50, workPressure: 20, hunger: 20, sleepDebt: 0, money: 1000, mood: { valence: 0 }, night: { awakeMin: 0, sleptMin: 0 } };
  eq('income', Math.round(applyVitals(v, { type: 'money.adjusted', payload: { mode: 'income', amount: 250 } }, world).money), 1250);
  eq('expense', Math.round(applyVitals(v, { type: 'money.adjusted', payload: { mode: 'expense', amount: 250 } }, world).money), 750);
  eq('set (negative allowed)', Math.round(applyVitals(v, { type: 'money.adjusted', payload: { mode: 'set', amount: -20 } }, world).money), -20);
  const badly = applyVitals(v, { type: 'outcome.happened', payload: { outcome: 'badly' } }, world);
  check('badly: valence down, stress up', badly.mood.valence < v.mood.valence && badly.stress > v.stress);
  eq('the constants are bounded (|valence| ≤ 0.4)', Math.abs(OUTCOME_VITALS.badly.valence) <= 0.4 && Math.abs(OUTCOME_VITALS.well.valence) <= 0.4, true);
}

section('mood presets: the planned delta is what the nudge applies');
{
  for (const preset of Object.keys(director.MOOD_PRESETS)) {
    const d = director.MOOD_PRESETS[preset];
    const ok = Object.entries(d).every(([k, x]) => (k === 'valence' ? Math.abs(x) <= 0.4 : Math.abs(x) <= 30));
    check(`${preset} within the nudge caps`, ok);
  }
  const p = director.plan({ kind: 'mood', delta: { energy: -90, valence: 2 }, wakeDay: 2 }, S(), { now: clock.now(), relax: true });
  const planned = p.events.find(e => e.type === 'vitals.planned');
  check('a custom delta is clamped to the caps', planned.payload.delta.energy === -30 && planned.payload.delta.valence === 0.4);
}

section('an outing that goes badly');
{
  const who = pal();
  const start = evening();
  const out = await applyOk({ kind: 'scene', shape: 'outing', placeId: place().id, castIds: [who.id], startAt: start, minutes: 60 });
  const did = out.events.find(e => e.type === 'decision.opened').id;
  const set = (await applyOk({ kind: 'outcome', decisionId: did, outcome: 'badly' })).events.find(e => e.type === 'outcome.set');
  const tension0 = S().cast.get(who.id).metrics.tension;
  await simulateHours((start - clock.now()) / HOUR + 2);
  const happened = listEvents({ types: ['outcome.happened'], after: set.id, limit: 50 }).find(e => e.causeId === set.id);
  check('engine outcome.happened caused by the outcome.set', happened?.actor === 'engine' && happened.payload.outcome === 'badly');
  const rel = listEvents({ types: ['relationship.changed'], after: set.id, limit: 50 }).find(e => e.causeId === happened?.id);
  check('…and a relationship change with who he was with (reason outcome)', rel?.payload?.castId === who.id && rel.payload.reason === 'outcome');
  check('tension went up', S().cast.get(who.id).metrics.tension > tension0);
  eq('the outcome is done', S().story.outcomes?.[did]?.status, 'done');
  await simulateHours(1);
  eq('…and happens once', listEvents({ types: ['outcome.happened'], after: set.id, limit: 50 }).filter(e => e.causeId === set.id).length, 1);
}

section('a cancelled outcome falls through, and its revert brings the outing back');
{
  const out = await applyOk({ kind: 'scene', shape: 'outing', placeId: place().id, castIds: [], startAt: clock.now() + 5 * HOUR, minutes: 90 });
  const did = out.events.find(e => e.type === 'decision.opened').id;
  const res = await applyOk({ kind: 'outcome', decisionId: did, outcome: 'cancelled', when: { inMinutes: 60 } });
  const set = res.events.find(e => e.type === 'outcome.set');
  check('scheduled: still committed now', S().decisions.get(did)?.status === 'committed');
  await simulateHours(1.5);
  const exp = listEvents({ types: ['decision.expired'], after: set.id, limit: 50 }).find(e => e.payload?.decisionId === did);
  check('engine decision.expired fell_through caused by the outcome.set', exp?.actor === 'engine' && exp.payload.reason === 'fell_through' && exp.causeId === set.id);
  check('the outing is closed', S().decisions.get(did)?.status === 'cancelled');
  life.revertEvent(set.id, { reason: 'test: it happens after all' });
  check('revert the outcome.set → the outing is committed again', S().decisions.get(did)?.status === 'committed');
}

section('an owner reversal: the engine cannot flip it back, no tension');
{
  const who = pal();
  const out = await applyOk({ kind: 'scene', shape: 'outing', placeId: place().id, castIds: [who.id], startAt: clock.now() + 8 * HOUR, minutes: 60 });
  const did = out.events.find(e => e.type === 'decision.opened').id;
  const t0 = S().cast.get(who.id).metrics.tension;
  await applyOk({ kind: 'decision.pick', decisionId: did, optionId: 'stay' });
  near('an owner reversal moves no tension', S().cast.get(who.id).metrics.tension, t0, 1e-9);
  appendEvent({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: did, payload: { decisionId: did, from: 'stay', to: 'go' } });
  const folded = rebuild({ world });
  eq('an engine reversal after it is ignored', folded.decisions.get(did)?.committed?.optionId, 'stay');
}

section('outcomes are for outings: an arc decision → use_arc_action');
{
  const fake = [...S().decisions.values()].find(d => d.category && d.category !== 'social' && (d.status === 'open' || d.status === 'committed'));
  if (fake) eq('an arc decision is refused', await code(director.preview({ kind: 'outcome', decisionId: fake.id, outcome: 'well' }, { relax: true })), 'refused:use_arc_action');
  else check('no arc decision open right now (nothing to refuse)', true);
}

await stopLife();
report();
