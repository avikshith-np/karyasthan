#!/usr/bin/env node
// Public site (spec 013): a design fixture — a realistic public.json built by the REAL
// exporter (life → publicView → build → validate) from a FICTIONAL sample world on a
// scratch DB: invented cast and place names, a few simulated days with the story layer on
// (stubbed models, no network), one chat-caused outing with an opted-in fictional friend,
// one story chapter, one open Ask-me decision and one published journal night.
// Never reads the live database or this install's world.
//
//   node scripts/public-fixture.js --out ../karyasthan-site/site/fixture/public.json [--days 5]
import fs from 'fs';
import path from 'path';
import {
  setupScratchDb, bootLife, simulateDays, simulateHours, fakeJevFixed, exampleWorld, HOUR, DAY,
} from './arcs-tests/_helpers.js';

const args = process.argv.slice(2);
const outArg = args[args.indexOf('--out') + 1];
const days = Number(args.includes('--days') ? args[args.indexOf('--days') + 1] : 5);
if (!args.includes('--out') || !outArg) { console.error('usage: --out <path> [--days N]'); process.exit(2); }

const { db } = await setupScratchDb();

// A fictional world: the example world with invented names (no real person, no real business).
const base = await exampleWorld();
const CAST = { flatmate: 'Corin Ash', 'coworker-a': 'Lena Brandt', 'coworker-b': 'Teo Marsh', manager: 'Hanne Lowe', parent: 'Mum', sibling: 'Ines' };
const PLACES = { 'Café': 'Filter & Foam', Gym: 'Ironside Gym', 'Grocery store': 'Daily Needs Store', Park: 'Lakeside Park', Restaurant: 'Harbour Kitchen', Cinema: 'Starlight Cinema', Office: 'Office' };
const world = JSON.parse(JSON.stringify(base));
for (const c of world.cast) {
  const key = Object.keys(CAST).find((k) => c.id.includes(k) || c.relation?.includes(k.split('-')[0]));
  if (key) c.name = CAST[key];
}
const used = new Set();
for (const c of world.cast) { if (used.has(c.name) || /example/i.test(c.name)) c.name = ['Pell Darrow', 'Sal Finch', 'Kit Harlow'][used.size % 3]; used.add(c.name); }
for (const p of world.places) if (PLACES[p.name]) p.name = PLACES[p.name];

const { life, clock } = await bootLife({ world, jev: fakeJevFixed({ go: 0.6, late: 0.15, stay: 0.25 }) });
await simulateDays(days);
await simulateHours(10);
await life.stopLife();

const { appendEvent } = await import('../src/life/eventLog.js');
const { rebuild } = await import('../src/life/projector.js');
const { openDecision } = await import('../src/life/decisions.js');
const state0 = rebuild({ world });
const t = clock.now();
const cast = [...state0.cast.values()];
const flatmate = cast.find((c) => c.relation === 'flatmate') ?? cast[0];
const coworker = cast.find((c) => c.relation === 'coworker') ?? cast[1];
const park = [...state0.places.values()].find((p) => p.kind === 'park');
const cinema = [...state0.places.values()].find((p) => p.kind === 'cinema');

// A fictional friend who is opted in, and a chat-caused outing with them yesterday evening.
const FRIEND = '10000000000777@lid';
db.prepare("INSERT INTO people (jid, push_name, real_name) VALUES (?, 'Ann', 'Ann Sample')").run(FRIEND);
const G = '120363000000000777@g.us';
db.prepare("INSERT INTO groups (jid, name, joined_at, last_active) VALUES (?, 'Sample group', unixepoch(), unixepoch())").run(G);
const ptr = appendEvent({ type: 'chat.trigger', actor: 'chat', at: t - 26 * HOUR, originKind: 'group', originJid: G, payload: { decisionId: null, toward: null } });
const out = appendEvent({ type: 'activity.started', actor: 'engine', at: t - 26 * HOUR + 120, causeId: ptr.id, subjectJid: FRIEND,
  payload: { kind: 'movie', placeId: cinema?.id ?? park.id, end: t - 23 * HOUR, availability: 'busy', withCast: [], social: true } });
appendEvent({ type: 'activity.ended', actor: 'engine', at: t - 23 * HOUR, causeId: out.id, payload: { kind: 'movie', placeId: cinema?.id ?? park.id } });
// A chapter with two moments and a beat on it.
const arc = appendEvent({ type: 'arc.started', actor: 'engine', at: t - 3 * DAY, payload: { category: 'social', kind: 'running-club', stage: 'curious', castIds: [flatmate.id] } });
appendEvent({ type: 'cast.beat', actor: 'mind', at: t - 3 * DAY + 600, payload: { castId: flatmate.id, kind: 'hobby', text: `${flatmate.name.split(' ')[0]} dragged him to a 5 km run around the lake and only stopped twice.` } });
appendEvent({ type: 'arc.stage', actor: 'engine', at: t - DAY, payload: { arcId: arc.id, to: 'regular' } });
appendEvent({ type: 'cast.beat', actor: 'mind', at: t - 5 * HOUR, payload: { castId: coworker.id, kind: 'news', text: `${coworker.name.split(' ')[0]} finally shipped the billing migration and brought sweets to the office.` } });

// An open Ask-me decision for the votes view (on the log before the engine boots).
{
  let state = rebuild({ world });
  const eventAt = t + 30 * HOUR;
  await openDecision(() => state, {
    kind: 'social:plan', category: 'social', mode: 'ask',
    subject: { eventAt, placeId: park.id, castIds: [flatmate.id], minutes: 90 },
    options: [
      { id: 'go', label: `Sunday run at ${park.name}`, go: true, kind: 'leisure', fun: 4, bias: 1.5 },
      { id: 'late', label: 'Join for the last lap', go: 'late', kind: 'leisure', minutes: 30, fun: 2, bias: 1 },
      { id: 'stay', label: 'Sleep in', kind: 'rest' },
    ],
  }, { world, at: clock.now(), append: (spec) => { const ev = appendEvent(spec); state = rebuild({ world }); return ev; }, noJev: true });
}
await bootLife({ world, jev: fakeJevFixed({ go: 0.6, late: 0.15, stay: 0.25 }), clock });

const pub = await import('../src/public/index.js');
pub.__setDepsForTest({ enabled: () => true, dryRun: () => true, now: () => clock.now(), soonMs: null, outDir: () => path.join(process.cwd(), 'data', `public-fixture-${process.pid}`) });
pub.setOptIn(FRIEND, { optedIn: true, displayName: 'Ann' });
const night = new Date((t - DAY) * 1000).toISOString().slice(0, 10);
const j = pub.publishJournal(night, 'Long day at the office, then a slow walk home in the drizzle. Rohan made too much rice again, so we ate on the balcony and argued about whether the lake run counts if you stop for chai halfway. It counts.');
if (!j.ok) console.warn('journal refused:', j.reason);
const res = await pub.exportNow({ upload: false });
const doc = await pub.preview();
if (res.status !== 'ok' || !doc) { console.error('export failed', res); process.exit(1); }
fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
fs.writeFileSync(path.resolve(outArg), JSON.stringify(doc, null, 1));
fs.rmSync(path.join(process.cwd(), 'data', `public-fixture-${process.pid}`), { recursive: true, force: true });
console.log(`wrote ${outArg}: ${res.size} bytes · today ${doc.today.rows.length} rows · ${doc.days.length} days · ${doc.people.cast.length} cast · ${doc.story.chapters.length} chapters · ${doc.votes.length} votes · ${doc.journal.length} journal`);
await life.stopLife();
process.exit(0);
