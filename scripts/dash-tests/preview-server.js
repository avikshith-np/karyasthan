// A dashboard you can look at: the real app on 127.0.0.1:7073 over a scratch DB, the
// example world lived for a week (fake clock, stubbed models, no network), a few invented
// real-world rows. For screenshots and phone-width checks, never for anything live.
//
//   node scripts/dash-tests/preview-server.js [--days 7] [--port 7073] [--write] [--worst | --empty] [--tiles] [--mind] [--sends]
//
// --write turns DASHBOARD_READONLY off, so write controls render. Login: admin / preview.
// --worst uses very long and awkward names. --empty is a fresh install: life and arcs off, no rows.
// --tiles turns the Leaflet map on, with a tile URL that goes nowhere (a test serves the tiles).
// --mind runs the mind skill, with an invented OWNER_JIDS. Its models have no keys, so it writes nothing.
// --sends turns DRY_RUN off over a fake socket: every send prints `SENT <json>` and goes nowhere.
// --review adds outputs for the weekly review: a very long scene, one with unbroken words, a text the log calls private (placeholder words).
// --batch3 adds a free topic waiting (one cited from a chat), real thoughts, and a note on how things stand with his flatmate.
// --inner adds what the Mind page's lower panels show: stances in each state, dreams of each kind, awkward lengths included.
// --story adds what waits for the owner: a claim in the tray, a proposal, an ask-me decision and a
// heavy veto card (Director, Story, Pending), and lets the stubbed Director prompt run.
// Every name here is invented and persona-neutral. The scratch DB is deleted at exit.
import {
  setupScratchDb, bootLife, simulateHours, fakeCallRole, cleanup, PROJECT_ROOT,
} from '../arcs-tests/_helpers.js';
import bcrypt from 'bcryptjs';

const argOf = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const PORT = Number(argOf('port', '7073'));
const DAYS = Number(argOf('days', '7'));
const WRITE = process.argv.includes('--write');
const WORST = process.argv.includes('--worst');
const EMPTY = process.argv.includes('--empty');
const MIND = process.argv.includes('--mind');
const SENDS = process.argv.includes('--sends');
const REVIEW = process.argv.includes('--review');
const INNER = process.argv.includes('--inner');
const BATCH3 = process.argv.includes('--batch3');
const STORY = process.argv.includes('--story');

Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: String(PORT),
  DASHBOARD_USER: 'admin', DASHBOARD_PASS_HASH: await bcrypt.hash('preview', 4),
  DASHBOARD_COOKIE_SECRET: 'dash-preview-cookie-secret-0123456789abcdef',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.0/8,::1/128', DASHBOARD_READONLY: WRITE ? 'false' : 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '', XAI_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9',
  ...(SENDS ? { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'preview-not-a-key', GIPHY_API_KEY: 'preview-not-a-key' } : {}),
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false', IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
  LIFE_ENABLED: EMPTY ? 'false' : 'true', ARCS_ENABLED: EMPTY ? 'false' : 'true', MIND_ENABLED: MIND ? 'true' : 'false', OWNER_JIDS: MIND ? '155500000399' : '', LIFE_MAP_TILE_URL: process.argv.includes('--tiles') ? 'https://tiles.invalid/{z}/{x}/{y}.png' : '',
});

const { db } = await setupScratchDb();
process.on('exit', () => { try { cleanup(); } catch { /* gone */ } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const LINES = [
  ['hey, you up?', 'been thinking about that place near the station'],
  ['ha, you always say that', 'fine, this weekend then'],
  ['long day. the meeting ran over again', 'you?'],
  ['same here', 'anyway, tell me about the trip'],
];
let n = 0;
const text = () => JSON.stringify({ messages: LINES[n++ % LINES.length], tone: 'warm', topic: 'small things', end: n % 5 === 0 });
const scene = () => JSON.stringify({
  narration: 'They met after work and talked for a long while about small things. The rain had stopped and the street was quiet. '
    + 'He laughed more than he had all week, and by the end they were trading stories about bad flatmates and worse landlords.',
  impressions: null, topics: ['old flatmates', 'weekend plans'], highlight: 'trading stories about bad landlords', awkward: null,
  chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'small' }],
});
const cr = fakeCallRole({
  'life.phone.his': text, 'life.phone.mind': text, 'life.phone.cast': text,
  'life.scene.clerk': scene, 'life.scene.mind': scene,
  'director.prompt': () => JSON.stringify({ actions: [{ action: { kind: 'weather', weatherKind: 'rain', intensity: 0.6, from: { inMinutes: 60 }, to: { inMinutes: 240 } }, why: 'the rain you asked for' }], cantDo: [] }),
  'life.narrate': () => 'He had been meaning to do it for a while, and that day he finally did.',
  'life.journal': () => 'A quiet day. Work, the walk back, a long look at nothing out of the window. Nothing worth writing down, and here it is anyway.',
});

const started = Date.now();
let life = null;
let clock = null;
if (EMPTY) {
  await import('../arcs-tests/_helpers.js').then((h) => h.setSkills({ life: false, arcs: false }));
} else {
  const { zonedToUnix, localParts, resolveTimezone } = await import('../../src/life/clock.js');
  const { exampleWorld } = await import('../arcs-tests/_helpers.js');
  const world = await exampleWorld();
  // Worst case: the longest a name can be, one unbroken word, another script, an emoji.
  const LONG = ['Wolfeschlegelsteinhausenbergerdorffwelchevoralternwaren', 'दीर्घनाम परीक्षण उदाहरण व्यक्ति दीर्घनाम परीक्षण', 'Ana 👩‍🚀🚀🚀 of the very long surname & <Co>', 'X'];
  if (WORST) {
    world.cast.forEach((c, i) => { c.name = LONG[i % LONG.length]; });
    world.places.forEach((pl, i) => { if (i % 2) pl.name = LONG[i % LONG.length]; });
  }
  const tz = resolveTimezone(world.timezone);
  const nowReal = Math.floor(Date.now() / 1000);
  const p = localParts(nowReal - DAYS * 86400, tz);
  const { fakeClock } = await import('../life-tests/_helpers.js');
  clock = fakeClock(zonedToUnix(p.year, p.month, p.day, 6, 0, tz));
  ({ life } = await bootLife({ world, clock, callRole: cr }));
  const story = await import('../../src/life/story/index.js');
  const { config } = await import('../../src/utils/config.js');
  config.arcs.phoneOrganicPerDay = 6;

  // An outing with his flatmate the evening before last, so a scene exists to look at.
  const director = await import('../../src/life/story/director.js');
  let outing = DAYS < 2;
  while (clock.now() < nowReal) {
    await simulateHours(0.25);
    await story.idle?.();
    await story.runPhoneNow?.();
    await story.runScenesNow?.();
    await story.idle?.();
    if (!outing && clock.now() > nowReal - 40 * 3600) {
      outing = true;
      const q = localParts(clock.now(), tz);
      const today = zonedToUnix(q.year, q.month, q.day, 19, 0, tz);
      const startAt = today > clock.now() + 3 * 3600 ? today : today + 86400;
      try {
        const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:flatmate'], startAt, minutes: 90, label: 'Catch-up' });
        await director.apply(pv.previewId, pv.fingerprint);
      } catch (err) { console.warn(`no preview outing: ${err?.code || err?.message}`); }
    }
  }
  clock.set(Math.floor(Date.now() / 1000));

  if (STORY) {
    const store = await import('../../src/life/story/store.js');
    const chat = '120363000000000301@g.us';
    const claim = Number(db.prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, text, kind, p, status, created_at)
      VALUES (?, 'group', ?, 'going to the cinema with a friend on friday', 'commitment', 0.9, 'flagged', ?)`).run(chat, chat, clock.now()).lastInsertRowid);
    store.createReview({ claimId: claim, chatJid: chat, originKind: 'group', originJid: chat, createdAt: clock.now(), status: 'tray' });
    const runId = store.recordRun({ kind: 'weekly', caller: 'life.arcs.weekly', status: 'ok', startedAt: clock.now(), finishedAt: clock.now() });
    store.createProposal({ runId, weekKey: '2026-W44', category: 'cast', kind: 'beat', payload: { castId: 'cast:flatmate', kind: 'news', text: 'picked up a new hobby' }, createdAt: clock.now() });
    // Written raw, then the world is folded again: a card is what the projection says it is.
    const { appendEvent } = await import('../../src/life/eventLog.js');
    const { stopLife } = await import('../../src/life/index.js');
    const t = clock.now();
    const at = t + 30 * 3600;
    appendEvent({ type: 'decision.opened', at: t, actor: 'engine', payload: {
      kind: 'hangout', mode: 'ask', subject: { eventAt: at, placeId: 'place:cafe', castIds: ['cast:flatmate'], minutes: 90 },
      options: [{ id: 'go', label: 'Go for coffee', costs: { energy: -5 } }, { id: 'stay', label: 'Stay in' }],
      opensAt: t, decideBy: at - 2 * 3600, ponrAt: at - 3600,
    } });
    appendEvent({ type: 'heavy.proposed', at: t, actor: 'engine', payload: { themeId: 'preview', kind: 'minor_accident', label: 'A bad week', onsetAt: t + 36 * 3600, roll: 0.1, p: 0.2, nominated: false, durationDays: 7 } });
    await stopLife();
    ({ life } = await bootLife({ world, clock, callRole: cr }));
    story.__setDepsForTest({ mindBudgetOk: async () => ({ ok: true }), getUsageByCaller: () => [], knownNames: () => [] });
  }

  if (REVIEW) {
    const t = clock.now() - 3600;
    const ev = (payload) => Number(db.prepare(`INSERT INTO world_events (at, type, actor, payload_json, origin_kind) VALUES (?, 'phone.message', 'engine', ?, 'self')`).run(t, JSON.stringify(payload)).lastInsertRowid);
    const sc = (act, text) => db.prepare(`INSERT INTO story_scenes (activity_event_id, version, status, event_id, tier, mode, origin_kind, ended_at, text, caller, created_at) VALUES (?, 1, 'done', ?, 'clerk', 'full', 'self', ?, ?, 'life.scene.clerk', ?)`)
      .run(act, ev({ castIds: ['cast:flatmate'], heat: 'tame' }), t, text, t);
    sc(9_000_001, Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}. They walked for a while and neither of them said much, and then the rain started and they stood under the awning until it passed.`).join('\n\n'));
    sc(9_000_002, `${'unbroken'.repeat(120)} and then they went home.`);
    db.prepare(`INSERT INTO story_messages (cast_id, dir, status, trigger, exchange, due_at, event_id, at, text, tone, tier, caller, created_at) VALUES ('cast:flatmate', 'out', 'live', 'preview-private', 0, ?, ?, ?, 'PLACEHOLDER private words', 'warm', 'mouth', 'life.phone.his', ?)`)
      .run(t, ev({ castIds: ['cast:flatmate'], heat: 'explicit' }), t, t);
    db.prepare(`INSERT INTO story_dreams (event_id, sleep_event_id, night, at, recall, tone, plan_json, text, created_at) VALUES (?, ?, 'preview', ?, 'fragment', 'flat', '{}', 'A corridor that kept going, and a door he knew.', ?)`)
      .run(9_000_003, 9_000_003, t, t);
  }

  if (BATCH3) {
    const t = clock.now();
    config.arcs.standingEnabled = true;
    const st = db.prepare(`INSERT INTO self_stance (topic, label, kind, value, confidence, anchor, base_value, base_confidence, status, pinned, why, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0.3, ?, ?, 0.3, 'proposed', 0, ?, 'code', ?, ?)`);
    const ev = db.prepare(`INSERT INTO self_stance_evidence (stance_id, night, at, source, cause_code, weight, origin_kind, origin_jid, created_at) VALUES (?, '2026-10-30', ?, 'cited', 'free_topic', 0, ?, ?, ?)`);
    const free = [
      ['free:trains', 'Night trains', 'interest', 0.4, 'He keeps looking up routes he will not take.', 'self', null],
      ['free:long', 'Whether the new flyover near the old market was ever going to fix the traffic or just move it two junctions along', 'opinion', -0.3, 'Everyone he talks to has a view on it, and his has been getting firmer than he expected, mostly from sitting in it twice a week.', 'group', '120363000000000301@g.us'],
    ];
    for (const [topic, label, kind, value, why, ok, oj] of free) {
      const id = st.run(topic, label, kind, value, value, value, why, t, t).lastInsertRowid;
      ev.run(id, t - 86400, ok, oj, t);
      if (ok !== 'self') ev.run(id, t - 86400, 'self', null, t);
    }
    const th = db.prepare(`INSERT INTO story_thoughts (at, family, text, codes_json, origin_kind, origin_jid, dedupe_key, cause_code, created_at) VALUES (?, 'excuse', ?, ?, ?, ?, ?, 'real', ?)`);
    th.run(t - 600, 'I went because I said I would, and that is all there is to it.', JSON.stringify({ kind: 'real', moment: 'against_lean', lean: 'stay', did: 'go', p: 0.72, by: 'draw', reversals: 0 }), 'self', null, 'real:preview:1', t);
    th.run(t - 500, 'Honestly I just had a feeling about it, and I am not going to pretend I thought it through any more carefully than that, because I did not, and it turned out to be the kind of evening that makes you stop asking.', JSON.stringify({ kind: 'real', moment: 'against_lean', lean: 'go', did: 'stay', p: 0.61, by: 'draw', reversals: 1 }), 'self', null, 'real:preview:2', t);
    th.run(t - 400, 'They were right to say it. I needed the night off.', JSON.stringify({ kind: 'real', moment: 'mood_swing', from: 'low', to: 'fine', minutes: 40, drivers: [] }), 'group', '120363000000000301@g.us', 'real:preview:3', t);
    const stand = db.prepare(`INSERT INTO story_standing (cast_id, text, as_of_event_id, valid_from, valid_to, status, invalid_reason, night, created_at) VALUES ('cast:flatmate', ?, 1, ?, ?, ?, ?, '2026-10-30', ?)`);
    const old1 = stand.run('They split the bills without talking about it, and that has held for a while now.', t - 20 * 86400, t - 9 * 86400, 'superseded', null, t).lastInsertRowid;
    stand.run('He said something sharp about the dishes and took it back the next morning. It was undone when that week was rewound.', t - 9 * 86400, t - 5 * 86400, 'invalidated', 'rewound', t);
    const live = stand.run('Easy again since the weekend. They talk over dinner most nights, mostly about nothing; he still owes an apology about the flat keys and both of them know it.', t - 5 * 86400, null, 'live', null, t).lastInsertRowid;
    const se = db.prepare(`INSERT INTO story_standing_evidence (version_id, event_id, at, source) VALUES (?, 1, ?, 'preview')`);
    se.run(live, t - 5 * 86400);
    se.run(old1, t - 20 * 86400);
  }

  if (INNER) {
    const t = clock.now();
    const LONGWORD = 'Wolfeschlegelsteinhausenbergerdorffwelchevoralternwaren';
    const st = db.prepare(`INSERT INTO self_stance (topic, label, kind, value, confidence, anchor, base_value, base_confidence, status, pinned, why, source, created_at, updated_at, last_reinforced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0.5, ?, ?, ?, 'seed', ?, ?, ?)`);
    const rows = [
      ['place:cafe', 'Cafes', 'interest', 0.72, 0.6, 0.5, 'active', 0, 'He has always liked somewhere to sit that isn\'t home.'],
      ['activity:music', 'Live music', 'interest', 0.2, 0.3, 0.4, 'active', 0, 'It used to matter more.'],
      ['place:office', 'The office', 'opinion', -0.62, 0.9, -0.3, 'active', 1, 'Too many meetings, and the commute.'],
      ['activity:wfh', 'Working from home', 'opinion', 0.55, 0.5, 0.5, 'active', 0, null],
      ['free:neutral', 'Rain', 'opinion', 0, 0.5, 0, 'proposed', 0, 'He hasn\'t made up his mind.'],
      ['free:proposed', 'Long walks after dinner when the streets go quiet and nobody needs anything from him', 'interest', 0.48, 0.5, 0.48, 'proposed', 0, 'A habit he fell into.'],
      ['free:long', LONGWORD, 'opinion', 1, 1, 1, 'active', 1, null],
      ['free:gone', 'A gym he left', 'interest', 0.1, 0.2, 0.1, 'archived', 0, null],
    ];
    for (const [topic, label, kind, value, confidence, anchor, status, pinned, why] of rows) {
      const id = st.run(topic, label, kind, value, confidence, anchor, anchor, status, pinned, why, t, t, t).lastInsertRowid;
      if (status === 'active') {
        const ev = db.prepare(`INSERT INTO self_stance_evidence (stance_id, night, at, source, cause_code, weight, created_at) VALUES (?, ?, ?, 'preview', 'went_well', ?, ?)`);
        const hist = db.prepare('INSERT INTO self_stance_history (stance_id, night, before_value, after_value, confidence, evidence_count) VALUES (?, ?, ?, ?, ?, 1)');
        for (let i = 0; i < 4; i++) {
          ev.run(id, `2026-10-${20 + i}`, t - (4 - i) * 86400, value >= anchor ? 0.05 : -0.05, t);
          hist.run(id, `2026-10-${20 + i}`, anchor + (value - anchor) * (i / 4), anchor + (value - anchor) * ((i + 1) / 4), confidence);
        }
      }
    }
    const dr = db.prepare(`INSERT INTO story_dreams (event_id, sleep_event_id, night, at, recall, tone, plan_json, text, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const DREAMS = [
      ['vivid', 'nightmare', 'clerk', 'The office again, but the stairs kept going down, and someone from school was at the bottom holding his phone. He knew he had missed something and could not read what it said.', []],
      ['vivid', 'good', 'clerk', Array.from({ length: 14 }, () => 'He was on a long road by the sea with his sibling and the light would not go down.').join(' '), [{ place: 'a road by the sea', person: 'his sibling', twist: 'the light would not go down' }]],
      ['fragment', 'flat', 'code', 'Something about a corridor.', [{ place: 'the old flat', person: 'his flatmate', twist: 'everything a little too small' }, { place: 'a train', person: null, twist: 'no stops' }]],
      ['fragment', 'bad', 'code', null, [{ place: LONGWORD, person: LONGWORD, twist: LONGWORD }]],
      ['fragment', 'flat', 'code', 'A stairwell, then nothing.', []],
      ['fragment', 'good', 'code', 'Somewhere warm.', []],
    ];
    DREAMS.forEach(([recall, tone, tier, text, scenes], i) => dr.run(9_100_000 + i, 9_100_000 + i, `2026-10-${28 - i}`, t - (i + 1) * 86400, recall, tone, JSON.stringify({ scenes, task: null, ending: 'woke' }), text, tier, t));
    const th = db.prepare(`INSERT INTO story_thoughts (at, family, text, origin_kind, origin_jid, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    // Enough right now that "today" has a full list whatever the hour (even just past midnight).
    for (let i = 0; i < 20; i++) th.run(t - 320 - i * 10, 'reaction', `a passing thought, number ${i + 1}`, 'self', null, t);
    th.run(t - 300, 'people', 'Something somebody said is still sitting wrong.', 'group', '120363000000000301@g.us', t);
    th.run(t - 240, 'wordless', 'A long thought that keeps going, about whether he should have said something back then, and whether anyone would have noticed if he had, and what difference it would have made by now anyway.', 'self', null, t);
    th.run(t - 180, 'body', LONGWORD.repeat(3), 'self', null, t);
  }

  // Invented real-world rows, so the Real world and Mind pages have something on them.
  const now = clock.now();
  const GROUPS = [['120363000000000301@g.us', WORST ? LONG[0] + LONG[0] : 'Weekend crew', 'chill · banter'], ['120363000000000302@g.us', WORST ? LONG[1] : 'Flat 4B', 'logistics · jokes'], ['120363000000000303@g.us', WORST ? LONG[2] : 'Old office', 'gossip']];
  const PEOPLE = [['155500000301@s.whatsapp.net', WORST ? LONG[0] : 'Avery'], ['155500000302@s.whatsapp.net', WORST ? LONG[1] : 'Blake'], ['155500000303@s.whatsapp.net', WORST ? LONG[2] : 'Casey'], ['155500000304@s.whatsapp.net', WORST ? LONG[3] : 'Drew']];
  for (const [jid, name, vibe] of GROUPS) db.prepare('INSERT INTO groups (jid, name, vibe, joined_at, last_active) VALUES (?, ?, ?, ?, ?)').run(jid, name, vibe, now - 864000, now - 600);
  for (const [jid, name] of PEOPLE) {
    db.prepare('INSERT INTO people (jid, phone, push_name) VALUES (?, ?, ?)').run(jid, jid.split('@')[0], name);
    for (const [g] of GROUPS) db.prepare('INSERT INTO group_members (group_jid, person_jid) VALUES (?, ?)').run(g, jid);
  }
  const CHAT = [...(WORST ? [`${LONG[0]}${LONG[0]}${LONG[0]}`] : []), 'anyone around tonight?', 'the usual place?', 'running late, start without me', 'who has the spare key', 'that was the worst film i have seen this year', 'send the photos'];
  const insertMsg = db.prepare('INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 90; i++) {
    const [jid, name] = PEOPLE[i % PEOPLE.length];
    insertMsg.run(`PREVIEW${i}`, GROUPS[i % GROUPS.length][0], jid, name, CHAT[i % CHAT.length], now - i * 2400);
  }
  // A bill still open, and two reels waiting in the share queue.
  db.prepare("INSERT INTO bill_splits (group_jid, restaurant, bill_json, state, created_at, updated_at) VALUES (?, 'The corner place', '{\"items\":[],\"total\":420}', 'ACTIVE', ?, ?)").run(GROUPS[0][0], now, now);
  const reel = db.prepare("INSERT INTO ig_reels (shortcode, account, description, queued, share_state, created_at) VALUES (?, 'an_account', 'a dog on a skateboard', 1, 'queued', ?)");
  reel.run('PREVIEW1', now); reel.run('PREVIEW2', now - 60);
  const insertMem = db.prepare("INSERT INTO memories (category, subject_jid, group_jid, content, importance, origin_kind, origin_jid, learned_at) VALUES (?, ?, ?, ?, ?, 'group', ?, ?)");
  for (let i = 0; i < 14; i++) {
    const [jid, name] = PEOPLE[i % PEOPLE.length];
    const [g] = GROUPS[i % GROUPS.length];
    insertMem.run(['fact', 'lore', 'preference'][i % 3], jid, g, `${name} keeps saying they will host, and never does (${i}).`, 0.4 + (i % 5) / 10, g, now - i * 7200);
  }

}

// What the bot's start does for the dashboard's own state (mutes).
(await import('../../src/dashboard/state.js')).loadMutedGroups();
const { startDashboard } = await import('../../src/dashboard/server.js');
// --sends: the only outside answers are these two fakes; anything else is refused.
if (SENDS) {
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.includes('openrouter.ai')) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'tired cat' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('api.giphy.com')) return new Response(JSON.stringify({ data: [{ id: 'preview', images: { fixed_width: { webp: 'https://media.preview.invalid/a.webp', mp4: 'https://media.preview.invalid/a.mp4' } } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://media.preview.invalid/')) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    throw new Error(`network is off in the preview: ${new URL(url).host}`);
  };
}

// The only socket here: a stand-in that prints what it was asked to send.
const fakeSocket = {
  user: { id: '155500000300@s.whatsapp.net' },
  sendMessage: async (jid, content) => {
    console.log(`SENT ${JSON.stringify({ jid, kinds: Object.keys(content || {}) })}`);
    return { key: { id: `FAKE${Date.now()}`, remoteJid: jid, fromMe: true } };
  },
  sendPresenceUpdate: async () => {},
  readMessages: async () => {},
};
const getSock = () => (SENDS ? fakeSocket : null);
if (SENDS) (await import('../../src/utils/config.js')).config.dryRun = false;
if (MIND) {
  const skills = await import('../arcs-tests/_helpers.js');
  await skills.setSkills({ mind: true });
  (await import('../../src/mind/index.js')).startMind({ getSock });
}
await startDashboard({ getSock });

// Keep his clock on the real one, so the pages poll a living world.
if (life) setInterval(() => { clock.set(Math.floor(Date.now() / 1000)); life.tick().catch(() => {}); }, 60_000).unref?.();
console.log(`READY http://127.0.0.1:${PORT}/ · ${EMPTY ? 'empty' : `${DAYS} days${WORST ? ', worst names' : ''}`} in ${Math.round((Date.now() - started) / 1000)} s · ${WRITE ? 'writes on' : 'readonly'}`);
setInterval(() => {}, 1 << 30);
