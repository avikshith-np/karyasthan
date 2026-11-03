// 010 T013 — the daily cast pass (src/life/story/cast.js) and the prompt
// fragment + cast overlay (src/life/story/fragment.js). Research R7, R21.
//
//   unit  pure planning on hand-built projections: status lines from the seed
//         pool only, drift / shared time / tension, late birthdays, controls
//         (pause, frozen, pins) decided when the item is offered, the marker
//         always appended (zero deltas, a throwing roll, a failing append),
//         birthday decisions, the fragment's audience rules and the overlay;
//   pulse the real 009 pulse on a scratch DB with the cast items as its
//         storyItems seam: one story.daily_done per date, a zero-delta day
//         still reaches sleep, reverting a relationship.changed never re-runs
//         the pass, catch-up writes the same log as live;
//   sim   the same through the life facade once T024 wires the story
//         (`SKIP sim: facade not wired` until then).
// Offline: fake clock, no model calls, invented names only.
import {
  setupScratchDb, fakeClock, section, check, eq, near, report, exampleWorld, exampleArcSeed,
  skipSimUnlessWired, bootLife, simulateDays, stopLife, blockNetwork, DAY,
} from './_helpers.js';
import { setClock, zonedToUnix, dateKey } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { appendEvent, eventsAfter, revertEvent } from '../../src/life/eventLog.js';
import { createInitialState, project, applyAppended, rebuild } from '../../src/life/projector.js';
import { setJev, resetDecisionCounters } from '../../src/life/decisions.js';
import { createPulse, genesis } from '../../src/life/pulse.js';
import { innerStateLine, castCard, castCards, setDecisionFilter } from '../../src/life/innerState.js';
import {
  dailyItems, planDaily, drift, statusPick, lateBirthdays, historyEntries, DAILY_OFFSET_SEC, MAX_BEATS,
} from '../../src/life/story/cast.js';
import { promptFragment, castOverlay, FRAGMENT_MAX, __setEventAllowedForTest } from '../../src/life/story/fragment.js';
import { listRefusals } from '../../src/life/story/store.js';

const H = 3600;
const MIN = 60;
blockNetwork();
setRngSeed(7);

const NO = () => () => 0.99;                                   // every roll says no
const rfOnly = (prefix) => (date, purpose) => () => (purpose.startsWith(prefix) ? 0 : 0.99);

await setupScratchDb();
const WORLD = await exampleWorld();
const SEED = await exampleArcSeed();
const TZ = WORLD.timezone;
const T0 = zonedToUnix(2026, 10, 26, 5, 0, TZ);                 // Mon 26 Oct 05:00, asleep

// ── Hand-built projections ────────────────────────────────────────────────

let nextId = 1;
function ev(type, at, payload = {}, extra = {}) {
  return { id: nextId++, at, type, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false, ...extra };
}
function baseState(world = WORLD) {
  nextId = 1;
  let s = createInitialState(world);
  s = project(s, ev('genesis', T0, { source: 'example', timezone: TZ, self: world.self }), world);
  for (const p of world.places) s = project(s, ev('place.created', T0, p), world);
  for (const c of world.cast) s = project(s, ev('cast.created', T0, c), world);
  return s;
}
const apply = (s, e) => project(s, e, WORLD);
const ids = (s) => [...s.cast.keys()].sort();
const FLAT = 'cast:flatmate';
const PARENT = 'cast:parent';
const withPlan = (s, date, wakeAt) => { s.plan = { date, wakeAt, eventId: 1, blocks: [] }; s.at = wakeAt; return s; };
const collect = () => { const list = []; let id = 1000; const add = (e) => { const x = { ...e, id: id++ }; list.push(x); return x; }; return { list, add }; };

try {
  check('the projector carries the story slice (T009)', !!createInitialState(WORLD).story);

  // ── statusPick ──────────────────────────────────────────────────────────
  section('statusPick: seed pool only');
  {
    const r = () => 0.4;
    const pick = statusPick(r, 'flatmate', SEED);
    check('a flatmate status comes from the flatmate pool', SEED.castStatus.flatmate.includes(pick));
    check('family:<role> uses the family pool', SEED.castStatus.family.includes(statusPick(r, 'family:parent', SEED)));
    check('an unknown relation falls back to any', SEED.castStatus.any.includes(statusPick(r, 'neighbour', SEED)));
    const cur = SEED.castStatus.flatmate[1];
    for (let i = 0; i < 20; i++) {
      const x = statusPick(() => i / 20, 'flatmate', SEED, cur);
      if (x === cur) { check('never repeats the current status', false, x); break; }
    }
    check('never repeats the current status', true);
    eq('no seed → null (no text from code)', statusPick(r, 'flatmate', null), null);
    eq('a pool of only the current line → null', statusPick(r, 'friend', { castStatus: { friend: ['x'] } }, 'x'), null);
    const all = new Set();
    for (let i = 0; i < 200; i++) all.add(statusPick(() => (i * 0.37) % 1, 'coworker', SEED));
    check('every pick is a seed string', [...all].every(x => SEED.castStatus.coworker.includes(x)));
  }

  // ── drift ───────────────────────────────────────────────────────────────
  section('drift: contact, shared time, tension (R7)');
  {
    let s = baseState();
    const at30 = T0 + 30 * DAY;
    s.at = at30;
    const d = drift(s, 1, at30);
    const flat = d.find(x => x.castId === FLAT);
    near('30 days without contact: closeness −0.004 for one day', flat.cast.closeness, -0.004, 1e-9);
    eq('… reason drift (the "no contact" reason)', flat.reason, 'drift');
    near('tension decays −0.01/day', flat.cast.tension, -0.01, 1e-9);
    const g = drift(s, 10, at30).find(x => x.castId === FLAT);
    near('a 10-day gap aggregates: −0.04 closeness', g.cast.closeness, -0.04, 1e-9);
    eq('… reason gap with days', [g.reason, g.days], ['gap', 10]);
    eq('days is capped at 60', drift(s, 500, at30)[0].days, 60);
    const at10 = T0 + 10 * DAY;
    check('within 14 days of contact: no closeness decay', !drift(s, 1, at10).some(x => 'closeness' in x.cast));
    // floors
    const low = structuredClone(s);
    low.cast = new Map(s.cast);
    low.cast.set(FLAT, { ...s.cast.get(FLAT), metrics: { closeness: 0.152, trust: 0.5, tension: 0 } });
    low.cast.set(PARENT, { ...s.cast.get(PARENT), metrics: { closeness: 0.351, trust: 0.5, tension: 0 } });
    const lf = drift(low, 1, at30);
    near('the floor (0.15) bounds the decay', lf.find(x => x.castId === FLAT).cast.closeness, -0.002, 1e-9);
    near('family floor 0.35', lf.find(x => x.castId === PARENT).cast.closeness, -0.001, 1e-9);
    low.cast.set(FLAT, { ...s.cast.get(FLAT), metrics: { closeness: 0.15, trust: 0.5, tension: 0 } });
    check('at the floor: no closeness change', !('closeness' in (drift(low, 1, at30).find(x => x.castId === FLAT)?.cast ?? {})));
    // shared time
    let s2 = baseState();
    s2 = apply(s2, ev('activity.started', T0 + 3 * H, { kind: 'dinner', placeId: 'place:home', withCast: [FLAT], start: T0 + 3 * H, end: T0 + 4.5 * H }));
    s2 = apply(s2, ev('activity.ended', T0 + 4.5 * H, { kind: 'dinner' }));
    const sh = drift(s2, 1, T0 + 20 * H).find(x => x.castId === FLAT);
    eq('90 min together → shared_time', [sh.reason, sh.sharedMin, sh.cast.togetherMin], ['shared_time', 90, 90]);
    near('… closeness +0.03', sh.cast.closeness, 0.03, 1e-9);
    check('… with the romance part (intimacy, passion) for an eligible member', sh.romance.intimacy > 0 && sh.romance.passion > 0);
    let s3 = baseState();
    s3 = apply(s3, ev('activity.started', T0 + 1 * H, { kind: 'hike', placeId: 'place:park', withCast: [FLAT], start: T0 + H, end: T0 + 9 * H }));
    const open = drift(s3, 1, T0 + 9 * H).find(x => x.castId === FLAT);
    eq('an open session counts up to now', open.sharedMin, 480);
    near('shared closeness is capped at +0.05/day', open.cast.closeness, 0.05, 1e-9);
    check('family get no romance metrics', !Object.keys(drift(s2, 1, T0 + 20 * H).find(x => x.castId === PARENT)?.romance ?? {}).length);
  }

  // ── late birthdays ──────────────────────────────────────────────────────
  section('late birthdays (after a re-anchor gap)');
  {
    const s = baseState();
    const flatBday = s.cast.get(FLAT).birthday.slice(5);         // 08-03
    const self = s.self.birthdate.slice(5);                      // 04-12
    eq('no previous pass → none', lateBirthdays(s, null, '2026-08-10'), []);
    eq('a birthday strictly inside the gap', lateBirthdays(s, '2026-07-30', '2026-08-10'), [{ castId: FLAT, date: `2026-${flatBday}` }]);
    eq('not the pass date itself (009 logs today\'s at wake)', lateBirthdays(s, '2026-07-30', `2026-${flatBday}`), []);
    eq('his own birthday counts (castId null)', lateBirthdays(s, '2026-04-01', '2026-04-20'), [{ castId: null, date: `2026-${self}` }]);
    const logged = structuredClone(s);
    logged.cast = new Map(s.cast);
    logged.cast.set(FLAT, { ...s.cast.get(FLAT), lastBirthdayAt: zonedToUnix(2026, 8, 3, 8, 0, TZ) });
    eq('one already logged that day is skipped', lateBirthdays(logged, '2026-07-30', '2026-08-10'), []);
    const far = lateBirthdays(s, '2025-01-01', '2026-08-10');
    check('a long gap reaches back at most 60 days', far.every(b => b.date >= '2026-06-11') && far.some(b => b.castId === FLAT));
  }

  // ── history ─────────────────────────────────────────────────────────────
  section('history: one short entry per shared outing, never from a chat');
  {
    const s = baseState();
    const act = (id, kind, placeId, withCast, originKind = 'self', mins = 90) => ({
      id, type: 'activity.started', at: T0 + id * MIN, originKind, originJid: originKind === 'self' ? 'self' : '120363000000000009@g.us',
      payload: { kind, placeId, withCast, start: T0 + id * MIN, end: T0 + id * MIN + mins * MIN },
    });
    const h = historyEntries(s, [act(901, 'movie', 'place:cinema', [FLAT], 'self', 150), act(902, 'cafe', 'place:cafe', [FLAT], 'self', 60)]);
    eq('the longest self outing with them → "<kind> together"', h, [{ castId: FLAT, text: 'movie together', dated: T0 + 901 * MIN, eventId: 901 }]);
    eq('a chat-origin (adopted) outing never writes history', historyEntries(s, [act(903, 'eat-out', 'place:restaurant', [FLAT], 'group')]), []);
    eq('an everyday block (lunch with coworkers) never does', historyEntries(s, [act(904, 'lunch', 'place:cafe', ['cast:coworker-a'])]), []);
    eq('at home → none', historyEntries(s, [act(905, 'walk', 'place:home', [FLAT])]), []);
    eq('an owner scene counts', historyEntries(s, [act(906, 'walk', 'place:park', [FLAT], 'owner')]).length, 1);
    eq('≤ 2 members per pass', historyEntries(s, [act(907, 'movie', 'place:cinema', [FLAT, 'cast:coworker-a', 'cast:coworker-b'])]).length, 2);
    const wake = zonedToUnix(2026, 10, 27, 7, 10, TZ);
    const sp = withPlan(baseState(), '2026-10-27', wake);
    const p = planDaily(sp, { date: '2026-10-27', at: wake + 300, world: WORLD, seed: SEED, rngFor: NO, activities: [act(908, 'movie', 'place:cinema', [FLAT])] });
    eq('planDaily appends cast.history_added', p.events.filter(e => e.type === 'cast.history_added').map(e => e.payload), [{ castId: FLAT, text: 'movie together', dated: T0 + 908 * MIN }]);
    sp.story.controls.pins[FLAT] = { eventId: 2, at: T0 };
    eq('… not for a pinned member', planDaily(sp, { date: '2026-10-27', at: wake + 300, world: WORLD, seed: SEED, rngFor: NO, activities: [act(909, 'movie', 'place:cinema', [FLAT])] })
      .events.filter(e => e.type === 'cast.history_added').length, 0);
  }

  // ── items + plan ────────────────────────────────────────────────────────
  section('daily item: when it is offered');
    {
    const wake = zonedToUnix(2026, 10, 27, 7, 10, TZ);
    const s = withPlan(baseState(), '2026-10-27', wake);
    eq('not due before wake + 5 min', dailyItems(s, wake + 4 * MIN, WORLD, SEED, { rngFor: NO }).length, 0);
    const it = dailyItems(s, wake + DAILY_OFFSET_SEC, WORLD, SEED, { rngFor: NO });
    eq('due at wake + 5 min, keyed by the date', [it.length, it[0]?.at, it[0]?.label, it[0]?.id], [1, wake + DAILY_OFFSET_SEC, 'daily', '2026-10-27']);
    const done = structuredClone(s);
    done.story.daily = { lastDate: '2026-10-27', lastAt: wake + 300 };
    eq('never twice for a date', dailyItems(done, wake + 2 * H, WORLD, SEED).length, 0);
    const paused = structuredClone(s);
    paused.story.controls.paused = true;
    eq('paused → no daily item at all', dailyItems(paused, wake + 2 * H, WORLD, SEED).length, 0);
    const frozen = structuredClone(s);
    frozen.story.controls.fate.cast = 'frozen';
    eq('cast frozen → still offered (it always appends its marker)', dailyItems(frozen, wake + 2 * H, WORLD, SEED, { rngFor: NO }).length, 1);
    const later = withPlan(baseState(), '2026-10-27', wake);
    later.at = wake + 3 * H;
    eq('a projection already past wake+5 dates the item now', dailyItems(later, wake + 3 * H, WORLD, SEED, { rngFor: NO })[0].at, wake + 3 * H);
    const asleep = baseState();
    eq('no current plan → nothing', dailyItems(asleep, T0 + H, WORLD, SEED).length, 0);
  }

  section('daily item: run() always appends story.daily_done');
  {
    const wake = zonedToUnix(2026, 10, 27, 7, 10, TZ);
    const s = withPlan(baseState(), '2026-10-27', wake);
    for (const id of ids(s)) s.cast.set(id, { ...s.cast.get(id), metrics: { ...s.cast.get(id).metrics, tension: 0 } });
    const [item] = dailyItems(s, wake + H, WORLD, SEED, { rngFor: NO, recordRefusal: () => {} });
    const c = collect();
    await item.run(c.add);
    eq('a zero-delta day appends exactly the marker', c.list.map(e => e.type), ['story.daily_done']);
    const p = c.list[0];
    eq('… engine, no cause, dated at the item', [p.actor, p.causeId ?? null, p.at], ['engine', null, wake + DAILY_OFFSET_SEC]);
    eq('… with the date, counts and roll outcomes', [p.payload.date, p.payload.counts.events, p.payload.rolls.romance], ['2026-10-27', 0, 'no']);

    const [item2] = dailyItems(s, wake + H, WORLD, SEED, {
      rngFor: NO, recordRefusal: () => {},
      rolls: { heavy: async () => ({ outcome: 'no', p: 0.0013891, junk: { deep: 1 } }), appraisal: () => { throw new Error('boom'); }, 'bad name': () => 'x' },
    });
    const c2 = collect();
    await item2.run(c2.add);
    const r = c2.list.at(-1).payload.rolls;
    eq('external rolls land in rolls (cleaned, flat)', r.heavy, { outcome: 'no', p: 0.0014 });
    eq('a throwing roll is recorded, never thrown', r.appraisal, 'error');
    check('a bad roll name is ignored', !('bad name' in r));
    eq('… and the marker is still last', c2.list.at(-1).type, 'story.daily_done');

    const s4 = withPlan(baseState(), '2026-10-27', wake);
    s4.at = wake;
    const [item4] = dailyItems(s4, wake + H, WORLD, SEED, { rngFor: () => () => 0, recordRefusal: () => {}, openDecision: async () => { throw new Error('no'); } });
    let n = 0;
    const list4 = [];
    let err4 = null;
    try {
      await item4.run((e) => { if (e.type !== 'story.daily_done' && n++ === 1) throw new Error('db hiccup'); list4.push(e); return { ...e, id: 1 }; });
    } catch (err) { err4 = err; }
    // All-or-nothing: the pass throws and the story facade's item wrapper reverts what it wrote (19-facade).
    check('a failing sub-append aborts the pass: it throws, no marker', err4?.message === 'db hiccup' && list4.length === 1
      && !list4.some(e => e.type === 'story.daily_done'), [err4?.message, list4.map(e => e.type)]);
    const c5 = collect();
    await dailyItems(s4, wake + H, WORLD, SEED, { rngFor: () => () => 0, recordRefusal: () => {}, openDecision: async () => { throw new Error('no'); } })[0].run(c5.add);
    const beats = c5.list.filter(e => e.type === 'cast.updated' || e.type === 'cast.beat').length;
    check(`≤ ${MAX_BEATS} status/away beats per pass (every roll yes)`, beats <= MAX_BEATS, beats);
    eq('… an opener that throws before appending is an error roll, not an abort', c5.list.at(-1).type, 'story.daily_done');

    const [item6] = dailyItems(s, wake + H, WORLD, SEED, {
      rngFor: NO, recordRefusal: () => {},
      rolls: { career: async ({ add, at }) => { add({ type: 'cast.beat', at, actor: 'engine', payload: { castId: FLAT, kind: 'news' } }); throw new Error('half'); } },
    });
    const c6 = collect();
    let err6 = null;
    try { await item6.run(c6.add); } catch (err) { err6 = err; }
    check('a roll that throws after appending aborts the pass (no marker)', err6?.message === 'half'
      && !c6.list.some(e => e.type === 'story.daily_done'), [err6?.message, c6.list.map(e => e.type)]);
  }

  section('daily item: controls decided when offered (pins, frozen, refusals)');
  {
    const wake = zonedToUnix(2026, 11, 30, 7, 0, TZ);
    let s = withPlan(baseState(), '2026-11-30', wake);
    s.story.controls.pins[FLAT] = { eventId: 9, at: T0 };
    const refusals = [];
    const p = planDaily(s, { date: '2026-11-30', at: wake + 300, world: WORLD, seed: SEED, rngFor: NO });
    check('a pinned member gets no relationship.changed', !p.events.some(e => e.payload?.castId === FLAT));
    check('… other members still drift', p.events.some(e => e.type === 'relationship.changed'));
    const r = p.refusals.find(x => x.target === FLAT);
    eq('… and the refusal names the pin', [r?.reason, r?.pinKey, r?.category, r?.action], ['pinned', FLAT, 'cast', 'beat']);
    const [item] = dailyItems(s, wake + H, WORLD, SEED, { rngFor: NO, recordRefusal: (x) => refusals.push(x) });
    await item.run(collect().add);
    check('run() writes the planned refusals (deduped by the store)', refusals.some(x => x.target === FLAT && x.reason === 'pinned'));
    const [real] = dailyItems(s, wake + H, WORLD, SEED, { rngFor: NO });
    await real.run(collect().add);
    check('the default writer is store.recordRefusal', listRefusals({ reason: 'pinned' }).some(x => x.target === FLAT));
    const simRef = [];
    const [simItem] = dailyItems(s, wake + H, WORLD, SEED, { rngFor: NO, sim: true, recordRefusal: (x) => simRef.push(x) });
    await simItem.run(collect().add);
    eq('sim:true writes no refusal row', simRef.length, 0);
    let listed = 0;
    const simWake = withPlan(baseState(), '2026-12-01', wake + DAY);
    dailyItems(simWake, wake + DAY + H, WORLD, SEED, { rngFor: NO, sim: true });
    dailyItems(simWake, wake + DAY + H, WORLD, SEED, { rngFor: NO, listActivities: () => { listed++; return []; } });
    eq('sim:true reads no activities from the log (an injected reader is still used)', listed, 1);
    const fz = structuredClone(s);
    delete fz.story.controls.pins[FLAT];
    fz.story.controls.fate.cast = 'frozen';
    const pf = planDaily(fz, { date: '2026-11-30', at: wake + 300, world: WORLD, seed: SEED, rngFor: () => () => 0 });
    check('cast frozen: no drift, no status or away beats', !pf.events.some(e => ['relationship.changed', 'cast.updated', 'cast.beat'].includes(e.type)
      && !(e.type === 'relationship.changed' && Object.keys(e.payload.delta).every(k => ['intimacy', 'passion', 'commitment'].includes(k)))));
  }

  section('birthday decisions');
  {
    // The parent's birthday (Jan 25); closeness 0.8, a known home place.
    const wake = zonedToUnix(2027, 1, 25, 7, 0, TZ);
    const s = withPlan(baseState(), '2027-01-25', wake);
    const p = planDaily(s, { date: '2027-01-25', at: wake + 300, world: WORLD, seed: SEED, rngFor: rfOnly('story:birthday:') });
    const d = p.decisions.find(x => x.spec.kind === 'social:birthday');
    eq('a social:birthday decision, category social, not big', [d?.spec.category, d?.spec.big ?? false, d?.spec.subject.castIds], ['social', false, [PARENT]]);
    eq('… go|late|stay at their (known) home', [d?.spec.options.map(o => o.id), d?.spec.subject.placeId], [['go', 'late', 'stay'], 'place:family-home']);
    check('… in the evening of the day', dateKey(d?.spec.subject.eventAt, TZ) === '2027-01-25' && d.spec.subject.eventAt > wake + 2 * H);
    // The flatmate (Aug 3) lives with him: no place to go to → call|text|skip.
    const w2 = zonedToUnix(2027, 8, 3, 7, 0, TZ);
    const s2 = withPlan(baseState(), '2027-08-03', w2);
    const d2 = planDaily(s2, { date: '2027-08-03', at: w2 + 300, world: WORLD, seed: SEED, rngFor: rfOnly('story:birthday:') }).decisions[0];
    eq('no distinct place → call|text|skip, no placeId', [d2?.spec.options.map(o => o.id), d2?.spec.subject.placeId], [['call', 'text', 'skip'], null]);
    // Closeness below 0.5 → none (the manager's May 9, closeness 0.3).
    const w3 = zonedToUnix(2027, 5, 9, 7, 0, TZ);
    const s3 = withPlan(baseState(), '2027-05-09', w3);
    eq('closeness < 0.5 → no decision', planDaily(s3, { date: '2027-05-09', at: w3 + 300, world: WORLD, seed: SEED, rngFor: rfOnly('story:birthday:') }).decisions.length, 0);
    // Already opened today (a restart mid-pass) → no duplicate.
    const dup = structuredClone(s);
    dup.decisions.set(77, { id: 77, kind: 'social:birthday', subject: { castIds: [PARENT] }, opensAt: wake + 300, status: 'open', options: [] });
    eq('no duplicate after a restart', planDaily(dup, { date: '2027-01-25', at: wake + 600, world: WORLD, seed: SEED, rngFor: rfOnly('story:birthday:') })
      .decisions.filter(x => x.spec.kind === 'social:birthday').length, 0);
    // run(): opened through the injected opener; sim → not opened.
    const opened = [];
    const [item] = dailyItems(s, wake + H, WORLD, SEED, { rngFor: rfOnly('story:birthday:'), recordRefusal: () => {}, openDecision: async (st, spec, ctx) => { opened.push({ spec, ctx }); } });
    const c = collect();
    await item.run(c.add);
    eq('run() opens it with the item time and the pulse append', [opened.length, opened[0]?.ctx.at, typeof opened[0]?.ctx.append], [1, wake + DAILY_OFFSET_SEC, 'function']);
    eq('… and records it', c.list.at(-1).payload.rolls.birthday, 'opened');
    const [simItem] = dailyItems(s, wake + H, WORLD, SEED, { rngFor: rfOnly('story:birthday:'), sim: true, openDecision: async () => { opened.push(1); } });
    await simItem.run(collect().add);
    eq('sim:true opens nothing', opened.length, 1);
    const fz = structuredClone(s);
    fz.story.controls.fate.social = 'frozen';
    eq('social frozen → no birthday decision', planDaily(fz, { date: '2027-01-25', at: wake + 300, world: WORLD, seed: SEED, rngFor: rfOnly('story:birthday:') }).decisions.length, 0);
  }

  section('away trips and the back item');
  {
    const wake = zonedToUnix(2026, 11, 2, 7, 0, TZ);
    let s = withPlan(baseState(), '2026-11-02', wake);
    const p = planDaily(s, { date: '2026-11-02', at: wake + 300, world: WORLD, seed: SEED, rngFor: rfOnly('story:away:') });
    const away = p.events.filter(e => e.type === 'cast.beat' && e.payload.kind === 'away');
    check('away beats: ≤ 2 per pass, 2..7 days', away.length >= 1 && away.length <= MAX_BEATS
      && away.every(e => e.payload.until - e.at >= 2 * DAY && e.payload.until - e.at <= 7 * DAY));
    check('… no text built in code', away.every(e => e.payload.text === undefined));
    s = apply(s, ev('cast.beat', wake + 300, { castId: FLAT, kind: 'away', until: wake + 3 * DAY }));
    eq('no back item before until', dailyItems(s, wake + 2 * DAY, WORLD, SEED, { rngFor: NO }).filter(i => i.label === 'cast:back').length, 0);
    const back = dailyItems({ ...s, at: wake + 3 * DAY }, wake + 3 * DAY + H, WORLD, SEED, { rngFor: NO }).find(i => i.label === 'cast:back');
    eq('the back item is due at until', [back?.at, back?.id], [wake + 3 * DAY, FLAT]);
    const c = collect();
    back.run(c.add);
    eq('… and appends the back beat', c.list.map(e => [e.type, e.payload.kind, e.payload.castId]), [['cast.beat', 'back', FLAT]]);
    const pinned = structuredClone(s);
    pinned.story.controls.pins[FLAT] = { eventId: 3, at: T0 };
    eq('a pinned member\'s back is not offered (the overlay ignores a past trip)', dailyItems(pinned, wake + 4 * DAY, WORLD, SEED, { rngFor: NO }).filter(i => i.label === 'cast:back').length, 0);
  }

  section('castCards: an open decision the story filter drops pulls in no card (R21)');
  {
    const DMA = { kind: 'dm', chatJid: '7002@lid', members: new Set(['7002@lid']) };
    const s = baseState();
    s.at = T0 + 3 * H;
    const parent = s.cast.get(PARENT).name;
    const open = (id, category) => ({ id, kind: 'romance:step', category, status: 'open', opensAt: s.at, decideBy: s.at + DAY,
      subject: { castIds: [PARENT] }, options: [{ id: 'step', label: 'step' }, { id: 'wait', label: 'wait' }] });
    s.decisions = new Map([[901, open(901, 'romance')]]);
    const cards = () => castCards(s, s.at, DMA, '', 3, { world: WORLD, overBudget: false });
    check('no filter (009): an open decision\'s subject gets a card', cards().some(c => c.includes(parent)), cards());
    // The story's filter while on (story/index.js decisionKept): arc decisions other than social are dropped.
    setDecisionFilter((d) => !(typeof d.category === 'string' && d.category !== '' && d.category !== 'social'));
    check('filter installed: the romance decision pulls in no card', !cards().some(c => c.includes(parent)), cards());
    s.decisions.set(902, open(902, 'social'));
    check('… a kept (social) one still does', cards().some(c => c.includes(parent)), cards());
    s.decisions.delete(902);
    setDecisionFilter(() => { throw new Error('boom'); });
    check('… a throwing filter fails closed', !cards().some(c => c.includes(parent)), cards());
    setDecisionFilter(null);
  }

  // ── fragment + overlay ──────────────────────────────────────────────────
  section('promptFragment (R21) and castOverlay');
  {
    const GROUP = { kind: 'group', chatJid: '120363000000000001@g.us', members: new Set() };
    const DM = { kind: 'dm', chatJid: '7001@lid', members: new Set(['7001@lid']) };
    const CALL = { kind: 'call', chatJid: '7001@lid', members: new Set(['7001@lid']) };
    // Hand-built events are not in the log, so the 006 rule is stubbed here
    // (allow all, then deny all); the real lookup runs in the pulse section.
    __setEventAllowedForTest(() => true);
    let s = baseState();
    s.at = T0 + 10 * DAY;
    eq('nothing active → empty', promptFragment(s, GROUP), '');
    s = apply(s, ev('arc.started', T0 + 9 * DAY, { category: 'romance', kind: 'romance', castIds: [FLAT], stage: 'interested' }));
    s.at = T0 + 10 * DAY;
    const f = promptFragment(s, GROUP);
    check('a fresh romance gives one short situation line', f.length > 0 && f.length <= FRAGMENT_MAX, f);
    check('… that never names the partner', !f.toLowerCase().includes('flatmate') && !f.includes(s.cast.get(FLAT).name));
    eq('tone mode → empty', promptFragment(s, GROUP, { mode: 'tone' }), '');
    eq('embargo mode → empty', promptFragment(s, GROUP, { mode: 'embargo' }), '');
    __setEventAllowedForTest(() => false);
    eq('an event the audience may not see → empty', promptFragment(s, GROUP), '');
    __setEventAllowedForTest(() => true);
    // heavy: DM/call only, and the only fragment while it lasts
    let h = apply(s, ev('heavy.started', T0 + 10 * DAY, { kind: 'minor_accident', themeId: 'minor-accident', until: T0 + 15 * DAY }, { heavy: true }));
    h.at = T0 + 11 * DAY;
    eq('heavy active: a group gets nothing at all', promptFragment(h, GROUP), '');
    eq('… IG too', promptFragment(h, { kind: 'ig', chatJid: 'ig:x', members: new Set() }), '');
    eq('… an unknown audience too', promptFragment(h, null), '');
    const dmLine = promptFragment(h, DM);
    check('… a DM gets the low-mood line', dmLine.length > 0 && dmLine.length <= FRAGMENT_MAX, dmLine);
    eq('… a call the same', promptFragment(h, CALL), dmLine);
    check('… which never names the event', !/accident/i.test(dmLine));
    // inside 009's line
    const line = innerStateLine(s, s.at, GROUP, { world: WORLD, overBudget: false });
    check('innerStateLine is unchanged without the seam (default off)', typeof line === 'string' && !line.includes(f), line);
    // overlay
    let o = castOverlay(s, FLAT);
    check('overlay: derived age only (interested → no label)', Number.isInteger(o.age) && o.label === undefined);
    s = apply(s, ev('arc.stage', T0 + 40 * DAY, { arcId: s.story.romance.arcId, from: 'interested', to: 'dating', reason: 'decision' }));
    s.at = T0 + 41 * DAY;
    o = castOverlay(s, FLAT);
    eq('dating → label Dating', o.label, 'Dating');
    eq('… not on anyone else', castOverlay(s, PARENT).label, undefined);
    s = apply(s, ev('cast.beat', T0 + 41 * DAY, { castId: PARENT, kind: 'away', until: T0 + 44 * DAY }));
    s.at = T0 + 41 * DAY + H;
    check('away → "away until <weekday>"', /^away until [A-Z][a-z]{2}$/.test(castOverlay(s, PARENT).statusSuffix ?? ''), castOverlay(s, PARENT));
    s.at = T0 + 45 * DAY;
    eq('a past trip shows nothing', castOverlay(s, PARENT).statusSuffix, undefined);
    const card = castCard(s.cast.get(FLAT), castOverlay(s, FLAT));
    check('castCard takes the overlay', card.startsWith('Dating '), card);
    eq('unknown member → {}', castOverlay(s, 'cast:nobody'), {});
    eq('no story slice → {} / empty', [castOverlay({}, FLAT), promptFragment({}, GROUP)], [{}, '']);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20000; i++) { castOverlay(s, FLAT); promptFragment(s, DM); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check(`overlay + fragment are cheap (20k calls in ${ms.toFixed(0)} ms)`, ms < 1000);
    __setEventAllowedForTest(null);
    eq('the real 006 rule: an event missing from the log fails closed', promptFragment(s, GROUP), '');
  }

  // ── The real pulse ──────────────────────────────────────────────────────
  section('pulse: the cast items through the storyItems seam');
  const calm = structuredClone(WORLD);
  for (const c of calm.cast) c.metrics = { ...(c.metrics || {}), tension: 0 };
  async function runPulse({ world = WORLD, days = 3, deps = {}, until = null, hook = null } = {}) {
    await setupScratchDb();
    resetDecisionCounters();
    const clock = fakeClock(T0);
    setClock(clock.fn);
    const sim = { clock, live: createInitialState(world) };
    sim.append = (spec) => { const e = appendEvent(spec); sim.live = applyAppended(sim.live, e, { world }); return e; };
    genesis(sim.append, world, T0);
    const storyItems = (s, g) => dailyItems(s, g, world, SEED, { getState: () => sim.live, ...deps });
    sim.pulse = createPulse({ world, getState: () => sim.live, append: sim.append, now: clock.fn, tickMinutes: 15, storyItems });
    const end = until ?? T0 + days * DAY;
    while (clock.now() < end) {
      clock.advance({ minutes: 15 });
      await sim.pulse.tick();
      if (hook) await hook(sim);
    }
    sim.events = eventsAfter(0, 100000);
    return sim;
  }
  setJev(async () => ({ model: 'fake', answers: {}, usage: {}, ms: 0 }));
  {
    const A = await runPulse({ world: calm, until: T0 + 20 * H, deps: { rngFor: NO } });
    const marks = A.events.filter(e => e.type === 'story.daily_done');
    eq('day 1: one marker', marks.map(e => e.payload.date), [dateKey(T0, TZ)]);
    const m = marks[0];
    eq('… a zero-delta day (counts.events 0)', m.payload.counts.events, 0);
    check('… self origin, engine, no cause', m.originKind === 'self' && m.actor === 'engine' && m.causeId === null);
    const woke = A.events.find(e => e.type === 'woke');
    eq('… at wake + 5 min', m.at, woke.at + DAILY_OFFSET_SEC);
    check('… and the pulse still reaches sleep that day', A.events.some(e => e.type === 'sleep.started' && e.at > m.at && dateKey(e.at - 6 * H, TZ) === dateKey(T0, TZ)));
    eq('… no story change events that day', A.events.filter(e => ['relationship.changed', 'cast.updated', 'cast.beat'].includes(e.type)).length, 0);
  }
  {
    const B = await runPulse({ days: 6 });
    const marks = B.events.filter(e => e.type === 'story.daily_done');
    const dates = marks.map(e => e.payload.date);
    eq('6 days: one marker per date', dates.length, new Set(dates).size);
    check('… one for each day he woke', dates.length === B.events.filter(e => e.type === 'woke').length, dates);
    const rc = B.events.filter(e => e.type === 'relationship.changed');
    check('shared time (lunch, outings) moves closeness', rc.some(e => e.payload.reason === 'shared_time' && e.payload.delta.closeness > 0));
    check('every daily event is engine/self with no cause', rc.every(e => e.actor === 'engine' && e.originKind === 'self' && e.causeId === null));
    const perDay = new Map();
    for (const e of rc) { const k = `${e.at}|${e.payload.castId}`; perDay.set(k, (perDay.get(k) || 0) + 1); }
    check('≤ one relationship.changed per member per pass', [...perDay.values()].every(n => n === 1));
    const st = B.events.filter(e => e.type === 'cast.updated');
    check('status lines come from the seed pool only', st.every(e => Object.values(SEED.castStatus).flat().includes(e.payload.fields.status)));
    const hist = B.events.filter(e => e.type === 'cast.history_added');
    check(`history entries (${hist.length}) only from outings, as kind words`, hist.every(e => / together$/.test(e.payload.text) && !/^lunch/.test(e.payload.text)));
    check('the pass never wrote a story event while asleep', marks.every(mk => B.events.find(w => w.type === 'woke' && dateKey(w.at, TZ) === mk.payload.date)));

    // Revert one relationship.changed: the pass is not re-run for that date.
    const target = rc[0];
    const date = marks.find(mk => mk.at === target.at).payload.date;
    revertEvent(target.id, { reason: 'test', at: B.clock.now() });
    B.live = rebuild({ world: WORLD });
    eq('after the revert the projection still knows the date is done', B.live.story.daily.lastDate >= date, true);
    for (let i = 0; i < 12; i++) { B.clock.advance({ minutes: 15 }); await B.pulse.tick(); }
    const after = eventsAfter(0, 100000);
    eq('… no second marker for that date', after.filter(e => e.type === 'story.daily_done' && e.payload.date === date).length, 1);
    eq('… and no re-append of the reverted change', after.filter(e => e.type === 'relationship.changed' && e.at === target.at && e.payload.castId === target.payload.castId).length, 1);
  }
  {
    // Catch-up writes the same log as live: run 2 days live vs. 2 days with a 30 h stop.
    const shape = (list) => list.filter(e => e.type !== 'phone.check.started' && e.type !== 'phone.check.ended')
      .map(e => `${e.at}|${e.type}|${JSON.stringify(e.payload)}`);
    const L = await runPulse({ days: 3 });
    const live = shape(L.events.filter(e => e.at <= T0 + 3 * DAY));
    await setupScratchDb();
    resetDecisionCounters();
    const clock = fakeClock(T0);
    setClock(clock.fn);
    let live2 = createInitialState(WORLD);
    const append = (spec) => { const e = appendEvent(spec); live2 = applyAppended(live2, e, { world: WORLD }); return e; };
    genesis(append, WORLD, T0);
    const mk = () => createPulse({ world: WORLD, getState: () => live2, append, now: clock.fn, tickMinutes: 15,
      storyItems: (s, g) => dailyItems(s, g, WORLD, SEED, { getState: () => live2 }) });
    let p = mk();
    while (clock.now() < T0 + 30 * H) { clock.advance({ minutes: 15 }); await p.tick(); }
    clock.advance({ hours: 30 });
    live2 = rebuild({ world: WORLD });
    p = mk();
    await p.tick();
    while (clock.now() < T0 + 3 * DAY) { clock.advance({ minutes: 15 }); await p.tick(); }
    const caught = shape(eventsAfter(0, 100000).filter(e => e.at <= T0 + 3 * DAY));
    const storyOnly = (l) => l.filter(x => /\|(story\.daily_done|relationship\.changed|cast\.updated|cast\.beat)\|/.test(x));
    eq('catch-up writes the same story events as live', storyOnly(caught), storyOnly(live));
  }

  // ── Through the life facade (T024) ──────────────────────────────────────
  section('sim: the facade');
  if (!(await skipSimUnlessWired())) {
    await setupScratchDb();
    const { life, clock } = await bootLife();
    const st = await simulateDays(14, { stepMinutes: 30 });
    const evs = eventsAfter(0, 200000);
    const marks = evs.filter(e => e.type === 'story.daily_done');
    eq('14 days: one marker per date', marks.length, new Set(marks.map(e => e.payload.date)).size);
    check('a marker every day he woke', marks.length >= 13, marks.length);
    check('status lines from the seed only', evs.filter(e => e.type === 'cast.updated' && e.payload.reason === 'status_rotate')
      .every(e => Object.values(SEED.castStatus).flat().includes(e.payload.fields.status)));
    check('the projection carries the last date', st.story?.daily?.lastDate === marks.at(-1)?.payload.date);
    check('clock advanced', clock.now() > T0);
    await stopLife();
    void life;
  }
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}

report();
