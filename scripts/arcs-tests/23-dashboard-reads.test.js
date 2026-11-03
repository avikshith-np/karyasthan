// 010 dashboard reads of the story facade (src/life/story/index.js) that the
// story pages draw from, against a real booted world:
//   - castDetail().metrics: closeness/trust/tension over time, walked back from
//     the current metrics through relationship.changed (one point per local day,
//     oldest first); a reverted change is skipped and its event is `excluded`;
//   - memberSummary: the fictional cast fields (job, employer, pronouns, …) incl. a
//     Director cast.updated edit, metVia from the cast.created payload, and the
//     away beat's own text as away.label;
//   - web(): a metVia edge;
//   - arcsBoard(): ≤ 3 last beats per arc, the arc's own next decision, active arcs
//     first with status/outcome for an ended one.
// Scratch DB, fake clock, fake Jev and models, no network. Invented names.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, blockNetwork, DAY,
} from './_helpers.js';
import { dateKey } from '../../src/life/clock.js';

const net = blockNetwork();
await setupScratchDb();
const { life, world } = await bootLife();
const story = await import('../../src/life/story/index.js');
await simulateHours(2);

const A = 'cast:coworker-a';
const at = life.getState().at;
// The genesis value: every relationship change of A (the daily pass's too) is walked back.
const before = { ...world.cast.find(c => c.id === A).metrics };

section('cast member: metrics over time from relationship.changed');
let revId;
{
  const { eventIds } = life.appendOwnerBatch([
    { type: 'relationship.changed', actor: 'engine', at: at - 3 * DAY, payload: { castId: A, delta: { closeness: 0.1 }, reason: 'drift' } },
    { type: 'relationship.changed', actor: 'engine', at: at - 2 * DAY, payload: { castId: A, delta: { tension: 0.15 }, reason: 'drift' } },
    { type: 'relationship.changed', actor: 'engine', at: at - DAY, payload: { castId: A, delta: { trust: 0.05, closeness: 0.05 }, reason: 'drift' } },
    { type: 'relationship.changed', actor: 'engine', at: at - DAY + 60, payload: { castId: 'cast:coworker-b', delta: { closeness: 0.2 }, reason: 'drift' } },
  ], { by: 'test' });
  revId = eventIds[1];
  life.revertEvent(revId, { reason: 'test' });
  const m = life.getState().cast.get(A).metrics;
  const d = story.castDetail(A);
  const series = d.metrics;
  check('a series is sent', Array.isArray(series) && series.length >= 3, series);
  check('oldest first', series.every((p, i) => i === 0 || p.at >= series[i - 1].at));
  const last = series[series.length - 1];
  check('the last point is now, at the current metrics', Math.abs(last.closeness - m.closeness) < 1e-3 && Math.abs(last.trust - m.trust) < 1e-3
    && Math.abs(last.tension - m.tension) < 1e-3, { last, m });
  const first = series[0];
  check('the first point is the genesis value (the reverted tension never counted)',
    Math.abs(first.closeness - before.closeness) < 1e-3 && Math.abs(first.trust - before.trust) < 1e-3 && Math.abs(first.tension - before.tension) < 1e-3,
    { first, before });
  const tz = world.timezone;
  const days = series.slice(1).map(p => dateKey(p.at, tz));
  eq('one point per local day (plus the starting value)', new Set(days).size, days.length);
  check('another member\'s change is not in this series', series.every(p => p.closeness <= Math.max(before.closeness, m.closeness) + 1e-9), series);
  const ev = d.events.find(e => e.id === revId);
  check('the reverted change is listed as excluded', ev?.excluded === true, ev);
}

section('cast member: identity fields, Director edit, metVia, away label');
{
  const m0 = story.castDetail(A).member;
  eq('world fields reach the dashboard', [m0.job, m0.employer, m0.pronouns, m0.birthday, m0.availability],
    ['Analyst', 'Example Co.', 'she/her', '1997-02-18', 'office hours']);
  check('personality and speech too', typeof m0.personality === 'string' && typeof m0.speech === 'string');
  life.appendOwnerBatch([{ type: 'cast.updated', at, payload: { castId: A, fields: { job: 'Lead analyst' }, reason: 'owner_edit' } }], { by: 'test' });
  eq('a Director cast.edit shows', story.castDetail(A).member.job, 'Lead analyst');

  life.appendOwnerBatch([
    { type: 'cast.created', at, payload: { id: 'cast:quinn', name: 'Quinn Example', relation: 'friend', metVia: 'cast:flatmate',
      metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } },
    { type: 'cast.beat', actor: 'engine', at, payload: { castId: 'cast:coworker-b', kind: 'away', until: at + 3 * DAY, text: 'visiting an old friend' } },
    { type: 'cast.beat', actor: 'engine', at, payload: { castId: 'cast:manager', kind: 'away', until: at + 2 * DAY } },
  ], { by: 'test' });
  const q = story.castDetail('cast:quinn')?.member;
  const flat = life.getState().cast.get('cast:flatmate').name;
  eq('metVia from the cast.created payload (name + id)', [q?.metVia, q?.metViaId], [flat, 'cast:flatmate']);
  eq('no metVia for a genesis member without one', story.castDetail(A).member.metVia, null);
  const b = story.castDetail('cast:coworker-b').member;
  eq('away carries the beat\'s own text', [b.away?.label, b.away?.until], ['visiting an old friend', at + 3 * DAY]);
  eq('an away beat without text → label null', story.castDetail('cast:manager').member.away?.label, null);
  const edges = story.web().edges;
  check('web: a dashed metVia edge', edges.some(e => e.a === 'cast:quinn' && e.b === 'cast:flatmate' && e.kind === 'metVia'));
  eq('web: only one metVia edge', edges.filter(e => e.kind === 'metVia').length, 1);
  const nodes = new Map(story.web().nodes.map(n => [n.id, n]));
  eq('web: circles by relation', [nodes.get('cast:flatmate')?.group, nodes.get('cast:manager')?.group, nodes.get('cast:quinn')?.group],
    ['home', 'work', 'friends']);
  check('web: genesis cast count as met', nodes.get('cast:flatmate')?.met === true && nodes.get('cast:manager')?.met === true);
  eq('web: someone the owner just added, with no contact yet, is not met', nodes.get('cast:quinn')?.met, false);
  eq('web: their line to him says so too', edges.find(e => e.a === 'self' && e.b === 'cast:quinn')?.met, false);
}

section('story board: last beats, per-arc next decision, active first');
{
  const { eventIds: [old] } = life.appendOwnerBatch([
    { type: 'arc.started', at: at - 5 * DAY, payload: { category: 'cast', kind: 'rivalry', castIds: ['cast:coworker-b'], stage: 'started' } },
  ], { by: 'test' });
  life.appendOwnerBatch([{ type: 'arc.ended', at: at - 4 * DAY, payload: { arcId: old, outcome: 'done' } }], { by: 'test' });
  const { eventIds: [arc] } = life.appendOwnerBatch([
    { type: 'arc.started', at: at - DAY, payload: { category: 'cast', kind: 'friendship', castIds: [A], stage: 'started' } },
  ], { by: 'test' });
  life.appendOwnerBatch([
    { type: 'arc.stage', at: at - DAY + 600, payload: { arcId: arc, to: 'closer' } },
    { type: 'cast.beat', actor: 'engine', at: at - DAY + 900, payload: { castId: A, kind: 'news', text: 'got a new bike' } },
    { type: 'cast.beat', actor: 'engine', at: at - 2 * DAY, payload: { castId: A, kind: 'hobby' } },
  ], { by: 'test' });
  const cat = story.arcsBoard().categories.find(c => c.category === 'cast');
  const ids = cat.arcs.map(a => a.id);
  eq('active arcs first, then ended', [ids.indexOf(arc) < ids.indexOf(old), cat.arcs.find(a => a.id === old)?.status, cat.arcs.find(a => a.id === old)?.outcome],
    [true, 'ended', 'done']);
  const a = cat.arcs.find(x => x.id === arc);
  check('≤ 3 last beats, newest first', a.lastBeats.length === 3 && a.lastBeats.every((b, i) => i === 0 || b.id < a.lastBeats[i - 1].id), a.lastBeats);
  check('the stage step and the cast news are among them', a.lastBeats.some(b => b.type === 'arc.stage' && /closer/.test(b.summary))
    && a.lastBeats.some(b => b.type === 'cast.beat' && /new bike/.test(b.summary)), a.lastBeats);
  check('a beat from before the arc started is not', !a.lastBeats.some(b => /hobby/.test(b.summary)), a.lastBeats);
  const oldArc = cat.arcs.find(x => x.id === old);
  check('the ended arc keeps its own beats (start + end)', oldArc.lastBeats.some(b => b.type === 'arc.ended') && oldArc.lastBeats.some(b => b.type === 'arc.started'),
    oldArc.lastBeats);
  check('no next decision on an arc without one', a.nextDecision === null);

  const { eventIds: [dec] } = life.appendOwnerBatch([{ type: 'decision.opened', actor: 'engine', at, payload: {
    kind: 'friendship_step', category: 'cast', arcId: arc, mode: 'ask', decideBy: at + 2 * DAY,
    subject: { eventAt: at + 2 * DAY, castIds: [A] }, options: [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }],
  } }], { by: 'test' });
  const { eventIds: [loose] } = life.appendOwnerBatch([{ type: 'decision.opened', actor: 'engine', at, payload: {
    kind: 'cast_other', category: 'cast', decideBy: at + 3 * DAY, subject: { eventAt: at + 3 * DAY, castIds: [] },
    options: [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }],
  } }], { by: 'test' });
  const cat2 = story.arcsBoard().categories.find(c => c.category === 'cast');
  eq('the arc\'s own next decision (with its mode)', cat2.arcs.find(x => x.id === arc).nextDecision, { id: dec, kind: 'friendship_step', decideBy: at + 2 * DAY, mode: 'ask' });
  eq('the category NEXT is the one no arc shows', cat2.nextDecision?.id, loose);
}

await stopLife();
eq('no network calls', net.length ?? net.count ?? 0, 0);
report();
