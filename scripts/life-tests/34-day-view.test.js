// Life · Day — life.dayView({date}) (src/life/day.js) and GET /api/life/day:
//   - shape: range/prev/next, a NOW card for today, past rows (spans, ticks,
//     decisions, vitals series) and the projection (sim runs, odds, forecast);
//   - past/future split at now; projected rows carry no event ids;
//   - an open decision's projected outcome odds sum to 1 over the runs;
//   - the projection is cached per lastEventId (same odds, no recompute) and is
//     shared by today and tomorrow;
//   - no writes: world_events / world_snapshots counts, the live projection and
//     the install RNG seed are unchanged by a projection;
//   - projector.vitalsAt matches advanceTo(...).vitals;
//   - arcs off → 009's day plan and the forecast, no odds;
//   - unknown and chat-origin event types render as generic rows;
//   - the route: 200 with chats (counts + names, no text) and mind runs, 400 on a
//     bad date, 404 out of range, 401 without auth.
// Example world, fake clock, mocked Jev, scratch DB; no network. Prints the
// projection timings.
import {
  setupScratchDb, bootLife, simulateDays, simulateHours, fakeJevFixed, setSkills, section, check, eq, report, HOUR, PROJECT_ROOT,
} from '../arcs-tests/_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'life-day-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '7075',
  DASHBOARD_USER: USER, DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4),
  DASHBOARD_COOKIE_SECRET: 'life-day-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128', DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: '',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false', IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
});

const { db } = await setupScratchDb();
const { zonedToUnix, dateKey } = await import('../../src/life/clock.js');
const { getRngSeed } = await import('../../src/life/rng.js');
const { rebuild, vitalsAt, advanceTo } = await import('../../src/life/projector.js');
const { appendEvent } = await import('../../src/life/eventLog.js');
const { openDecision } = await import('../../src/life/decisions.js');
const day = await import('../../src/life/day.js');

const booted = await bootLife({ jev: fakeJevFixed({ go: 0.5, late: 0.2, stay: 0.3 }) });
const { life, clock, world } = booted;
const tz = world.timezone;
await simulateDays(2);                                     // → Thu 29 Oct 06:00
await simulateHours(10);                                   // → 16:00
const counts = () => Object.fromEntries(['world_events', 'world_snapshots'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

// An evening plan he hasn't decided yet: open it on the log, then let the facade rebuild.
await life.stopLife();
{
  let state = rebuild({ world });
  const home = state.self.homePlaceId;
  const place = [...state.places.values()].find((p) => p.id !== home && p.id !== state.self.officePlaceId) ?? [...state.places.values()].find((p) => p.id !== home);
  const flatmate = [...state.cast.values()].find((c) => c.relation === 'flatmate');
  const eventAt = zonedToUnix(2026, 10, 29, 21, 0, tz);
  await openDecision(() => state, {
    kind: 'movie',
    subject: { eventAt, placeId: place.id, castIds: flatmate ? [flatmate.id] : [], minutes: 120 },
    options: [
      { id: 'go', label: 'Go to the movie', go: true, kind: 'leisure', spend: 300, fun: 5, bias: 2 },
      { id: 'late', label: 'Join later', go: 'late', kind: 'leisure', minutes: 60, spend: 300, fun: 3, bias: 1.5 },
      { id: 'stay', label: 'Stay in and rest', kind: 'rest' },
    ],
  }, { world, at: clock.now(), append: (spec) => { const ev = appendEvent(spec); state = rebuild({ world }); return ev; }, noJev: true });
}
await bootLife({ jev: fakeJevFixed({ go: 0.5, late: 0.2, stay: 0.3 }), clock });
// A chat-origin pointer and an event type this page has never heard of (as a later spec would add).
{
  const GROUP = '120363000000000034@g.us';
  db.prepare("INSERT INTO groups (jid, name, joined_at, last_active) VALUES (?, 'Weekend crew', unixepoch(), unixepoch())").run(GROUP);
  const t = clock.now() - 2 * HOUR;
  db.prepare("INSERT INTO messages (id, group_jid, sender_jid, content, is_from_self, timestamp) VALUES ('d-1', ?, 'me@s.whatsapp.net', 'secret words', 1, ?)").run(GROUP, t);
  db.prepare("INSERT INTO messages (id, group_jid, sender_jid, content, is_from_self, timestamp) VALUES ('d-2', ?, 'me@s.whatsapp.net', 'more secret words', 1, ?)").run(GROUP, t + 60);
  db.prepare(`INSERT INTO life_queue (chat_jid, msg_id, msg_key_json, availability, enqueued_at, status, drained_at)
    VALUES (?, 'q-1', '{}', 'busy', ?, 'drained', ?)`).run(GROUP, t - 600, t + 30);
  db.prepare(`INSERT INTO mind_runs (kind, day_key, started_at, finished_at, status, output_json)
    VALUES ('glance', ?, ?, ?, 'ok', '{"private":"model text"}')`).run(dateKey(t, tz), t, t + 5);
}

section('dayView: today');
const before = counts();
const seed0 = getRngSeed();
const live0 = life.getState();
day.resetDayCache();
const t0 = performance.now();
const v = await life.dayView({});
const firstMs = Math.round(performance.now() - t0);
console.log(`  · projection: ${v.future?.runs} runs in ${v.future?.ms} ms (horizon now → end of tomorrow, ${Math.round((v.future ? (zonedToUnix(2026, 10, 31, 0, 0, tz) - clock.now()) : 0) / 3600)} h); dayView ${firstMs} ms`);
eq('date / today / range', [v.date, v.today, v.range.first, v.range.last], ['2026-10-29', true, '2026-10-27', '2026-10-30']);
eq('prev / next', [v.prev, v.next], ['2026-10-28', '2026-10-30']);
check('a NOW card: doing, availability, reply odds, vitals', !!v.now?.doing?.kind && typeof v.now.availability?.state === 'string'
  && Math.abs(Object.values(v.now.reply.dm).reduce((a, b) => a + b, 0) - 1) < 0.02 && typeof v.now.vitals?.energy === 'number', v.now);
check('past: spans and ticks, all before now, with event ids', v.past.spans.length > 3 && [...v.past.spans, ...v.past.ticks].every((r) => r.at <= v.at && (r.eventId === null || r.eventId > 0)));
check('past: the running block is open (ongoing)', v.past.spans.at(-1)?.end === null && v.past.spans.at(-1)?.ongoing === true);
check('past: a vitals series every 30 min', Array.isArray(v.past.vitals) && v.past.vitals.length >= 28 && v.past.vitals.every((p) => p.at <= v.at && typeof p.energy === 'number'));
check('past: the open decision is listed (open, with a lean)', v.past.decisions.some((d) => d.kind === 'movie' && d.status === 'open'), { decisions: v.past.decisions, ticks: v.past.ticks.filter((t) => t.cat === 'decision'), at: v.at });
check('future: simulated', v.future?.source === 'sim' && v.future.runs >= day.DAY_MIN_RUNS && v.future.runs <= day.DAY_RUNS && typeof v.future.ms === 'number');
check('future: spans after now, no event ids', v.future.spans.length > 1 && v.future.spans.every((s) => (s.end === null || s.end > v.at) && s.eventId === null && s.future === true));
check('future: ticks after now', v.future.ticks.every((t) => t.at >= v.at && t.eventId === null));
check('future: projected vitals and a forecast', v.future.vitals.length > 4 && v.future.weather.length >= 2 && v.future.weather.every((w) => typeof w.tempC === 'number'));
const movie = v.future.decisions.find((d) => d.kind === 'movie');
check('future: the open decision has outcome odds over its options', !!movie && movie.status === 'live' && movie.odds.length >= 2 && movie.odds.every((o) => ['go', 'late', 'stay', 'expired', 'undecided', 'not_opened'].includes(o.id)), v.future.decisions);
const sum = movie ? movie.odds.reduce((a, o) => a + o.p, 0) : 0;
check(`odds sum to 1 (${sum.toFixed(3)})`, Math.abs(sum - 1) < 0.01, movie?.odds);
check('every projected decision sums to 1', v.future.decisions.every((d) => Math.abs(d.odds.reduce((a, o) => a + o.p, 0) - 1) < 0.01));
eq('no writes: world_events / world_snapshots counts', counts(), before);
eq('no writes: the install seed', getRngSeed(), seed0);
eq('the live projection is untouched', life.getState().lastEventId, live0.lastEventId);

section('cache');
const t1 = performance.now();
const v2 = await life.dayView({});
const cachedMs = Math.round(performance.now() - t1);
check(`second read is cached (${cachedMs} ms)`, v2.future.cached === true && cachedMs < 500);
eq('same odds', JSON.stringify(v2.future.decisions.map((d) => d.odds)), JSON.stringify(v.future.decisions.map((d) => d.odds)));
const vt = await life.dayView({ date: '2026-10-30' });
check('tomorrow: projection only, from the shared run', vt.tomorrow === true && vt.past.spans.length === 0 && vt.future.cached === true && vt.future.spans.length > 3 && vt.now === null);
eq('tomorrow: no next day', vt.next, null);
// A new event: the copy is kept for RECOMPUTE_MIN_MS (stale), then recomputed.
appendEvent({ type: 'alert.raised', at: clock.now(), actor: 'engine', payload: { kind: 'test' } });
await life.stopLife();
await bootLife({ jev: fakeJevFixed({ go: 0.5, late: 0.2, stay: 0.3 }), clock });
const v3 = await life.dayView({});
check('a changed log within a minute → the stale copy', v3.future.cached === true && v3.future.stale === true);

section('a past day');
const vy = await life.dayView({ date: '2026-10-28' });
check('yesterday: no projection, no NOW card', vy.future === null && vy.now === null && vy.today === false);
check('yesterday: spans across the day and a vitals series', vy.past.spans.length > 5 && vy.past.vitals?.length >= 40);
check('the first day has no prev', (await life.dayView({ date: '2026-10-27' })).prev === null);
let err = null;
try { await life.dayView({ date: '2026-09-01' }); } catch (e) { err = e; }
eq('before genesis → DayError out_of_range', [err?.name, err?.code], ['DayError', 'out_of_range']);
err = null;
try { await life.dayView({ date: '2026-02-31' }); } catch (e) { err = e; }
eq('impossible date → bad_date', err?.code, 'bad_date');

section('vitalsAt = advanceTo(...).vitals');
{
  const s = rebuild({ world });
  const at = s.at + 47 * 60;
  const a = vitalsAt(s, at, world);
  const b = advanceTo(s, at, world).vitals;
  eq('energy / hunger / stress / mood', [a.energy, a.hunger, a.stress, a.mood?.valence], [b.energy, b.hunger, b.stress, b.mood?.valence]);
}

section('generic rows');
{
  const n = { places: new Map(), cast: new Map([['cast:x', { name: 'Someone' }]]) };
  const rows = day.__test.rowsOf([
    { id: 1, at: 100, type: 'future.kind', actor: 'chat', originKind: 'group', payload: { kind: 'lifted', castId: 'cast:x' } },
    { id: 4, at: 110, type: 'mood.chat', actor: 'engine', originKind: 'group', payload: { affect: 'roast' } },
    { id: 2, at: 200, type: 'relationship.changed', actor: 'engine', originKind: 'self', payload: { castId: 'cast:x' } },
    { id: 3, at: 210, type: 'relationship.changed', actor: 'engine', originKind: 'self', payload: { castId: 'cast:x' } },
  ], { place: () => null, cast: (id) => n.cast.get(id)?.name ?? id, castList: (ids) => ids.map((id) => n.cast.get(id)?.name ?? id) });
  const u = rows.ticks.find((t) => t.type === 'future.kind');
  check('an unknown type is a neutral tick with its type and the chat marker', u?.cat === 'event' && u.origin === 'group' && u.detail.kind === 'lifted' && u.detail.with?.[0] === 'Someone');
  check('012 mood.chat is quiet (its chat.perceived pointer is the row)', !rows.ticks.some((t) => t.type === 'mood.chat'));
  eq('a burst of one type in a minute is one row', rows.ticks.filter((t) => t.type === 'relationship.changed').map((t) => t.count), [2]);
}

section('the route');
const { startDashboard } = await import('../../src/dashboard/server.js');
const app = await startDashboard({ getSock: () => null });
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const get = async (url, auth = true) => {
  const res = await app.inject({ method: 'GET', url, headers: auth ? { authorization: AUTH } : {} });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json, text: res.body };
};
eq('no credentials → 401', (await get('/api/life/day', false)).status, 401);
const r = await get('/api/life/day');
eq('today → 200 running', [r.status, r.json?.running, r.json?.date], [200, true, '2026-10-29']);
if (process.env.DAY_DUMP) (await import('fs')).writeFileSync(process.env.DAY_DUMP, r.text);
const crew = r.json?.chats?.find((c) => c.name === 'Weekend crew');
check('chats: per-chat counts and the chat name', !!crew && r.json.chats.filter((c) => c.name === 'Weekend crew').reduce((a, c) => a + c.sent, 0) === 2
  && r.json.chats.some((c) => c.answered === 1) && r.json.chats.some((c) => c.deferred === 1), r.json?.chats);
check('no message text and no mind output in the answer', !/secret words|model text/.test(r.text));
check('mind runs: kind + status', r.json?.mind?.some((m) => m.kind === 'glance' && m.status === 'ok'));
eq('bad date → 400', (await get('/api/life/day?date=2026-1-1')).status, 400);
eq('out of range → 404', (await get('/api/life/day?date=2025-01-01')).status, 404);
eq('a past day is not rate limited', (await Promise.all(Array.from({ length: 14 }, () => get('/api/life/day?date=2026-10-28')))).every((x) => x.status === 200), true);
const todays = [];
for (let i = 0; i < 13; i++) todays.push((await get('/api/life/day')).status);
check('today/tomorrow reads are limited (12/min → 429)', todays.includes(429) && todays.slice(0, 10).every((x) => x === 200), todays.join(','));
await app.close();

section('arcs off → the day plan, no odds');
await setSkills({ life: true, arcs: false });
day.resetDayCache();
const before2 = counts();
const vp = await life.dayView({});
check('today: plan source, no odds, no projected vitals', vp.future?.source === 'plan' && vp.future.decisions.length === 0 && vp.future.vitals === null && vp.future.spans.length > 0);
check('… still a forecast', vp.future.weather.length >= 1);
const vpt = await life.dayView({ date: '2026-10-30' });
check('tomorrow: routine.planDay blocks', vpt.future?.source === 'plan' && vpt.future.spans.some((s) => s.cat === 'sleep') && vpt.future.spans.length > 3);
eq('no writes with arcs off either', counts(), before2);

await life.stopLife();
report();
