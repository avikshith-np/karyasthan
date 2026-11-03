// 010 T020 — preview tomorrow (src/life/story/tomorrow.js, research R23,
// contracts/director-api.md §5, FR-044): the next 24 h on a copy of the
// projection, no model calls and nothing written.
//   - world_events and every story_* table keep their row counts; the live
//     projection is untouched; the fake callRole and askJev are never called;
//   - simAppend is the only appender in tomorrow.js (static);
//   - planned blocks cover the window; decisions carry a code lean; story items
//     are offered with sim:true and their refusals come back in memory;
//   - a heavy proposal due inside the window is reported.
// unit: a realistic log from the 009 facade (stopped). Invented names; no network.
import fs from 'fs';
import path from 'path';
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, fakeCallRole, fakeJevFixed,
  skipSimUnlessWired, STORY_TABLES, PROJECT_ROOT, HOUR, DAY,
} from './_helpers.js';
import { rebuild, applyAppended } from '../../src/life/projector.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { setJev } from '../../src/life/decisions.js';
import { getDb } from '../../src/memory/db.js';
import { setRngSeed } from '../../src/life/rng.js';
import * as tomorrow from '../../src/life/story/tomorrow.js';

await setupScratchDb();
const jev = fakeJevFixed({ go: 0.7, late: 0.2, stay: 0.1 });
const callRole = fakeCallRole({});
const booted = await bootLife({ jev, callRole });
const { world, clock } = booted;
await simulateDays(1);
await stopLife();
jev.calls.length = 0;
callRole.reset();   // the wired facade journals the sim night (T024); the preview itself must call nothing
setJev(jev.fn);

let state = rebuild({ world });
const append = (spec) => { const ev = appendEvent(spec); state = applyAppended(state, ev, { world }); return ev; };
// A pending heavy proposal whose onset falls inside the window.
const prop = append({ type: 'heavy.proposed', at: clock.now(), actor: 'engine', payload: { themeId: 'minor-accident', kind: 'minor_accident', label: 'a small accident', onsetAt: clock.now() + 10 * HOUR, roll: 0.0001, p: 0.001, nominated: false, durationDays: 2 } });

const counts = () => Object.fromEntries(['world_events', 'world_snapshots', ...STORY_TABLES].map(t => [t, getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

section('a 24 h preview writes nothing and calls no model');
{
  const before = counts();
  const live = JSON.stringify({ last: state.lastEventId, at: state.at, plan: state.plan?.eventId });
  const offered = [];
  const refusals = [];
  const storyItems = (s, g, opts) => {
    offered.push(opts?.sim === true);
    if (opts?.refusals) opts.refusals.push({ reason: 'paused', target: 'cast:flatmate' });
    return [];
  };
  const t0 = Date.now();
  const res = await tomorrow.previewTomorrow(state, world, { now: clock.now(), storyItems, refusals });
  const ms = Date.now() - t0;
  eq('row counts unchanged (world_events, snapshots, story_*)', counts(), before);
  eq('live projection untouched', JSON.stringify({ last: state.lastEventId, at: state.at, plan: state.plan?.eventId }), live);
  eq('no Jev calls', jev.calls.length, 0);
  eq('no model calls', callRole.calls.length, 0);
  eq('window', [res.from, res.to - res.from], [clock.now(), 24 * HOUR]);
  check('planned blocks inside the window', res.planned.length > 3 && res.planned.every(b => b.end > res.from && b.start < res.to));
  check('a sleep block and a wake-up plan', res.planned.some(b => b.kind === 'sleep') && res.planned.some(b => b.kind !== 'sleep'));
  check('story items were offered with sim:true', offered.length > 0 && offered.every(Boolean));
  check('refusals come back in memory', res.refusals.length > 0 && res.refusals[0].reason === 'paused');
  eq('notes', res.notes, ['no model calls', 'nothing written']);
  check('the due heavy onset is reported', res.heavy && res.heavy.kind === 'minor_accident' && res.heavy.onsetAt <= res.to, res.heavy);
  check('every decision has a code lean (or none)', res.decisions.every(d => d.leanFromCosts === null || typeof d.leanFromCosts.optionId === 'string'));
  check(`fast enough (${ms} ms)`, ms < 5000);
}

section('the sim keeps the evening invitation on (isEnabled → true)');
{
  // The invitation is a per-date roll (p = 0.4): try a few RNG seeds over 48 h
  // windows (under the 72 h catch-up cap) until one day has it.
  let seen = 0;
  let tries = 0;
  for (let seed = 1; seed <= 20 && !seen; seed++, tries++) {
    setRngSeed(seed);
    const r = await tomorrow.previewTomorrow(state, world, { now: clock.now(), hours: 48 });
    seen += r.decisions.length;
    if (r.decisions.length) check('the invitation carries a code lean', r.decisions.every(d => typeof d.leanFromCosts?.optionId === 'string'));
  }
  setRngSeed(42);
  check(`an evening invitation appears in the sim (${tries} seeds tried)`, seen > 0, { seen });
  eq('still no Jev calls', jev.calls.length, 0);
}

section('createSimLog: in-memory ids, origins as appendEvent');
{
  const log = tomorrow.createSimLog(state, world);
  const a = log.append({ type: 'cast.beat', at: clock.now(), actor: 'engine', payload: { castId: 'cast:sibling', kind: 'news', text: 'x' } });
  eq('ids continue above the real log', a.id, state.lastEventId + 1);
  eq('self origin with no cause', a.originKind, 'self');
  const o = log.append({ type: 'director.slider_set', at: clock.now(), actor: 'owner', payload: { slider: 'drama', value: 0.2 } });
  eq('owner origin', o.originKind, 'owner');
  eq('sim folded the slider', log.getState().story.controls.sliders.drama, 0.2);
  eq('the real projection did not', state.story.controls.sliders.drama, 0.5);
  check('getEvent of a real id reads the log', log.getEvent(prop.id)?.type === 'heavy.proposed');
  check('a heavy sim event starts a sim embargo (as makeAppend)', (() => {
    const h = log.append({ type: 'heavy.started', at: clock.now(), actor: 'engine', heavy: true, causeId: prop.id, payload: { proposedId: prop.id, kind: 'minor_accident', until: clock.now() + DAY } });
    return log.events.some(e => e.type === 'embargo.started' && e.causeId === h.id);
  })());
}

section('static: simAppend is the only appender in tomorrow.js');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'life', 'story', 'tomorrow.js'), 'utf8');
  check('no appendEvent call', !/appendEvent\s*\(/.test(src));
  check('no store import', !/from '\.\/store\.js'/.test(src));
  check('no model client import', !/brain\/(llm|jev)\.js/.test(src));
}

if (!(await skipSimUnlessWired())) {
  section('sim: preview tomorrow through the life facade');
  const story = await import('../../src/life/story/index.js');
  check('the story facade exposes previewTomorrow', typeof story.director?.previewTomorrow === 'function');
}

report();
