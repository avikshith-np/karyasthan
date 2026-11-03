// The weekly review (plan 020 E4): sampling, who is never sampled, private text, undone outputs,
// marking twice, a long scene, the stubs, the routes and their gates. Scratch DB, no model, no network.
import bcrypt from 'bcryptjs';
import { section, check, eq, report, setupScratchDb, PROJECT_ROOT, cleanup } from './life-tests/_helpers.js';
import fs from 'fs';

const USER = 'review-test';
const PASS = 'review-test-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4), DASHBOARD_COOKIE_SECRET: 'review-test-cookie-secret-0123456789abcdef',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.0/8,::1/128', DASHBOARD_READONLY: 'false',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '', JEV_API_KEY: '', LLM_LOCAL_API_KEY: '',
  LLM_BASE_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false',
  IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`, LIFE_ENABLED: 'false', ARCS_ENABLED: 'false', MIND_ENABLED: 'false',
});
const { db } = await setupScratchDb();
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in this test'); };

const { config } = await import('../src/utils/config.js');
const store = await import('../src/memory/reviewStore.js');
const { zonedToUnix, resolveTimezone } = await import('../src/life/clock.js');
const tz = resolveTimezone(config.timezone);
const T = (m, d, h = 12, y = 2026) => zonedToUnix(y, m, d, h, 0, tz);
const WEEK = store.weekOf(T(10, 28));         // Mon 26 Oct .. Sun 1 Nov 2026
const at = (day, h = 12) => WEEK.from + day * 86400 + h * 3600;

const event = (payload) => Number(db.prepare(`INSERT INTO world_events (at, type, actor, payload_json, origin_kind) VALUES (?, 'phone.message', 'engine', ?, 'self')`).run(WEEK.from, JSON.stringify(payload)).lastInsertRowid);
let actSeq = 1;
function scene({ when = at(2), status = 'done', text = 'They talked about nothing much.', subject = null, mode = 'full', origin = 'self', originJid = null, tier = 'clerk', caller = 'life.scene.clerk', heat = 'tame', sheet = '{"place":"a cafe"}' } = {}) {
  const eventId = heat === undefined ? null : event(heat === 'none' ? { castIds: ['cast:a'] } : { castIds: ['cast:a'], heat });
  return Number(db.prepare(`INSERT INTO story_scenes (activity_event_id, version, status, event_id, tier, mode, origin_kind, origin_jid, subject_jid, ended_at, text, sheet_json, caller, created_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(actSeq++, status, eventId, tier, mode, origin, originJid, subject, when, text, sheet, caller, when).lastInsertRowid);
}
let trig = 1;
function text({ when = at(3), status = 'live', words = 'you up?', tier = 'mouth', caller = 'life.phone.his', tone = 'warm', heat = 'tame' } = {}) {
  const eventId = event(heat === 'none' ? { castIds: ['cast:a'] } : { castIds: ['cast:a'], heat });
  return Number(db.prepare(`INSERT INTO story_messages (cast_id, dir, status, trigger, exchange, due_at, event_id, at, text, tone, tier, caller, created_at)
    VALUES ('cast:a', 'out', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`).run(status, `t${trig++}`, when, eventId, when, words, tone, tier, caller, when).lastInsertRowid);
}
function thought({ when = at(1), words = 'should eat something', origin = 'self', phrase = null } = {}) {
  return Number(db.prepare(`INSERT INTO story_thoughts (at, family, text, origin_kind, phrase_key, created_at) VALUES (?, 'body', ?, ?, ?, ?)`).run(when, words, origin, phrase, when).lastInsertRowid);
}
let ev2 = 5_000;
function dream({ when = at(4), words = 'a corridor that kept going', status = 'live', needs = 0 } = {}) {
  ev2++;
  return Number(db.prepare(`INSERT INTO story_dreams (event_id, sleep_event_id, night, at, recall, tone, plan_json, text, needs_words, status, created_at)
    VALUES (?, ?, '2026-10-29', ?, 'fragment', 'flat', '{}', ?, ?, ?, ?)`).run(ev2, ev2, when, words, needs, status, when).lastInsertRowid);
}
const wipeOutputs = () => { for (const t of ['review_items', 'review_weeks', 'story_scenes', 'story_messages', 'story_thoughts', 'story_dreams']) db.exec(`DELETE FROM ${t}`); };
const ofSurface = (s) => db.prepare('SELECT * FROM review_items WHERE surface = ?').all(s);
const cardsAll = () => store.queue({ limit: 500 }).cards;
const cardOf = (surface, sourceId) => { const i = db.prepare('SELECT id FROM review_items WHERE surface = ? AND source_id = ?').get(surface, sourceId); return { id: i?.id, card: cardsAll().find((c) => c.id === i?.id) }; };

section('the table keeps pointers, never words or people');
{
  const cols = db.prepare('PRAGMA table_info(review_items)').all().map((c) => c.name);
  check('no text or JID column', !cols.some((c) => /text|jid|words|name/.test(c)), cols.join());
  eq('no free-text note: only fixed codes', store.mark(1, { verdict: 'pass', note: 'free text here' }).error, 'bad_note');
}

section('the ladder has no placeholder steps');
{
  const { MIGRATIONS } = await import('../src/memory/migrations/index.js');
  eq('v19, v20 and v21 are the real steps', MIGRATIONS.filter((x) => x.version >= 19 && x.version <= 21).map((x) => x.name), ['standing', 'claim-check', 'weekly-review']);
}

section('weeks');
{
  eq('Monday 00:00 starts the week', store.weekOf(T(10, 26, 0)).week, '2026-W44');
  eq('Sunday night is still that week', store.weekOf(T(11, 1, 23)).week, '2026-W44');
  eq('…and Monday the next', store.weekOf(T(11, 2, 0)).week, '2026-W45');
  eq('the year turns inside a week', [store.weekOf(T(12, 31)).week, store.weekOf(T(1, 2, 12, 2027)).week], ['2026-W53', '2026-W53']);
  eq('…and the first full week', store.weekOf(T(1, 4, 12, 2027)).week, '2027-W01');
  const w = store.weekOf(T(10, 28));
  eq('seven days long', w.to - w.from, 7 * 86400);
}

section('nothing to review');
{
  wipeOutputs();
  eq('an empty week samples nothing', store.sampleWeek(WEEK, { at: at(8) }), 0);
  eq('queue empty', store.queue(), { cards: [], left: 0 });
  const st = store.stats();
  eq('stats empty, rates unknown not zero', [st.rows.length, st.left, st.failures, st.totals.every((t) => t.passRate === null)], [0, 0, 0, true]);
  eq('no failures to export', store.failureStubs().stubs, []);
}

section('sampling: the size, the spread, repeatable');
{
  wipeOutputs();
  for (let i = 0; i < 70; i++) scene({ when: at(i % 7, 8 + (i % 10)) });
  for (let i = 0; i < 3; i++) dream({ when: at(i) });
  const added = store.sampleWeek(WEEK, { at: at(8), closed: true });
  eq('at most the sample per surface, all of a thin one', [ofSurface('scene').length, ofSurface('dream').length, added], [store.SAMPLE_PER_SURFACE, 3, store.SAMPLE_PER_SURFACE + 3]);
  check('between 20 and 30', store.SAMPLE_PER_SURFACE >= 20 && store.SAMPLE_PER_SURFACE <= 30);
  const days = new Set(ofSurface('scene').map((i) => { const r = db.prepare('SELECT ended_at FROM story_scenes WHERE id = ?').get(i.source_id); return Math.floor((r.ended_at - WEEK.from) / 86400); }));
  eq('spread over all seven days', days.size, 7);
  eq('again: nothing more', store.sampleWeek(WEEK, { at: at(8), closed: true }), 0);
  const ids = ofSurface('scene').map((i) => i.source_id).sort((a, b) => a - b).join();
  db.exec('DELETE FROM review_items; DELETE FROM review_weeks');
  store.sampleWeek(WEEK, { at: at(9), closed: true });
  eq('the same week picks the same outputs', ofSurface('scene').map((i) => i.source_id).sort((a, b) => a - b).join(), ids);
  eq('another week wouldn\'t pick from this one', store.sampleWeek(store.weekOf(at(8)), { at: at(9) }), 0);
}
{
  wipeOutputs();
  for (let i = 0; i < 12; i++) thought({ when: at(0, i + 1), phrase: 'same-phrase' });
  for (let i = 0; i < 5; i++) thought({ when: at(1, i + 1), phrase: `p${i}` });
  store.sampleWeek(WEEK, { at: at(8) });
  const texts = ofSurface('thought').map((i) => db.prepare('SELECT phrase_key FROM story_thoughts WHERE id = ?').get(i.source_id).phrase_key);
  check('every distinct phrase before a repeat, repeats only to fill', new Set(texts).size === 6 && texts.length === 17, texts.join());
}

section('real people and chats: never');
{
  wipeOutputs();
  const ok = scene();
  const real = [scene({ subject: '155500000001@s.whatsapp.net' }), scene({ mode: 'self_only', tier: 'code' }), scene({ origin: 'group', originJid: '120363000000000001@g.us' }), scene({ origin: 'dm', originJid: '155500000001@s.whatsapp.net' })];
  const okT = thought();
  const chatT = [thought({ origin: 'group' }), thought({ origin: 'dm' })];
  const owners = text({ tier: null, caller: null, words: 'the owner typed this' });
  const okP = text();
  const pendingDream = dream({ needs: 1 });
  const okD = dream();
  store.sampleWeek(WEEK, { at: at(8) });
  eq('only his own scene', ofSurface('scene').map((i) => i.source_id), [ok]);
  check('(setup) those existed', real.length === 4);
  eq('only his own thought', ofSurface('thought').map((i) => i.source_id), [okT]);
  check('(setup) chat thoughts existed', chatT.length === 2);
  eq('the owner\'s own words aren\'t a writer\'s', ofSurface('phone').map((i) => i.source_id), [okP]);
  check('(setup) owner text existed', owners > 0);
  eq('a dream still waiting for words isn\'t sampled', ofSurface('dream').map((i) => i.source_id), [okD]);
  check('(setup) pending dream existed', pendingDream > 0);
  const dump = JSON.stringify(store.queue({ limit: 100 }));
  check('no JID reaches the queue', !/@s\.whatsapp|@g\.us/.test(dump));
}

section('private: behind a tap, and fails closed');
{
  wipeOutputs();
  const SECRET = 'PRIVATE_MARKER_WORDS';
  const cases = {
    tame: text({ words: 'plain words' }),
    explicit: text({ words: SECRET, heat: 'explicit' }),
    suggestive: text({ words: SECRET, heat: 'suggestive' }),
    unknown: text({ words: SECRET, heat: 'none' }),
    naughty: text({ words: SECRET, tone: 'naughty' }),
    desire: text({ words: SECRET, caller: 'life.phone.desire' }),
  };
  const sceneHot = scene({ text: SECRET, heat: 'explicit' });
  const sceneUnknown = scene({ text: SECRET, heat: 'none' });
  const sceneCode = scene({ text: 'He went out for a while.', heat: 'none', tier: 'code', caller: null });
  store.sampleWeek(WEEK, { at: at(8) });
  const c = (id, s = 'phone') => cardOf(s, id).card;
  check('tame shows', c(cases.tame).private === false && c(cases.tame).text === 'plain words');
  for (const k of ['explicit', 'suggestive', 'unknown', 'naughty', 'desire']) check(`${k}: marked private, no text`, c(cases[k]).private === true && c(cases[k]).text === null);
  check('scene: explicit and unknown heat private, a code line shown', c(sceneHot, 'scene').private && c(sceneUnknown, 'scene').private && c(sceneCode, 'scene').private === false);
  check('the queue never carries the words', !JSON.stringify(store.queue({ limit: 100 })).includes(SECRET));
  const { id } = cardOf('phone', cases.explicit);
  eq('the tap gets them', store.textOf(id).text, SECRET);
  store.mark(id, { verdict: 'fail', note: 'register' });
  const stub = store.failureStubs().stubs.find((s) => s.sourceId === cases.explicit);
  check('a private failure exports with no words', stub.private === true && stub.text === null && !JSON.stringify(store.failureStubs()).includes(SECRET), JSON.stringify(stub));
  eq('a thought or dream isn\'t private (they have no register)', store.isPrivate('dream', {}, null), false);
}

section('a real thought is a model\'s words, and a chat\'s is never sampled');
{
  wipeOutputs();
  const stream = thought({ words: 'a stream line' });
  const real = thought({ words: 'he told himself something' });
  const realChat = thought({ words: 'from a chat', origin: 'group' });
  const key = db.prepare('UPDATE story_thoughts SET dedupe_key = ? WHERE id = ?');
  key.run('real:a', real);
  key.run('real:b', realChat);
  store.sampleWeek(WEEK, { at: at(8) });
  const tiers = Object.fromEntries(store.queue({ limit: 100 }).cards.filter((c) => c.surface === 'thought').map((c) => [c.sourceId, c.tier]));
  eq('the stream\'s is code, the real one the mouth\'s', [tiers[stream], tiers[real]], ['code', 'mouth']);
  check('a real thought from a chat stays out', !(realChat in tiers));
}

section('an undone output leaves the queue');
{
  wipeOutputs();
  const s1 = scene({ text: 'scene one' });
  const s2 = scene({ text: 'scene two' });
  const s3 = scene({ text: 'scene three' });
  const m1 = text({ words: 'text one' });
  const t1 = thought();
  const d1 = dream();
  store.sampleWeek(WEEK, { at: at(8) });
  eq('(setup) six to go', store.queue().left, 6);
  const marked = cardOf('scene', s3).id;
  eq('(setup) one marked', store.mark(marked, { verdict: 'fail', note: 'flat' }).ok, true);
  const gone = cardOf('scene', s1).id;
  db.prepare("UPDATE story_scenes SET status = 'reverted', text = NULL WHERE id = ?").run(s1);
  db.prepare("UPDATE story_scenes SET status = 'superseded' WHERE id = ?").run(s2);
  db.prepare("UPDATE story_messages SET status = 'reverted', text = NULL WHERE id = ?").run(m1);
  db.prepare('DELETE FROM story_thoughts WHERE id = ?').run(t1);
  db.prepare("UPDATE story_dreams SET status = 'reverted', text = NULL WHERE id = ?").run(d1);
  eq('reverted, superseded, swept and deleted all leave', store.queue(), { cards: [], left: 0 });
  eq('marking it is refused', store.mark(gone, { verdict: 'pass' }).error, 'gone');
  eq('its text is gone', store.textOf(gone).error, 'gone');
  const st = store.stats();
  const row = st.rows.find((r) => r.surface === 'scene');
  eq('counted as undone, not left; the earlier mark still counts', [row.left, row.gone, row.fail, row.passRate], [0, 2, 1, 0]);
  db.prepare("UPDATE story_scenes SET status = 'reverted', text = NULL WHERE id = ?").run(s3);
  const stub = store.failureStubs().stubs[0];
  check('a failure undone since: the stub says so, without words', stub.gone === true && stub.text === null, JSON.stringify(stub));
}

section('a revert counts before the sweep gets there');
{
  wipeOutputs();
  const m = text({ words: 'text' });
  const n = text({ words: 'other' });
  store.sampleWeek(WEEK, { at: at(8) });
  const evOf = (id) => db.prepare('SELECT event_id AS e FROM story_messages WHERE id = ?').get(id).e;
  db.prepare(`INSERT INTO world_events (at, type, actor, payload_json, origin_kind) VALUES (?, 'event.reverted', 'owner', ?, 'self')`).run(at(8), JSON.stringify({ targetId: evOf(m), reason: 'test', by: 'owner' }));
  eq('the source still says live, the queue doesn\'t', [db.prepare('SELECT status FROM story_messages WHERE id = ?').get(m).status, store.queue().left], ['live', 1]);
  db.prepare('UPDATE world_events SET redacted = 1 WHERE id = ?').run(evOf(n));
  eq('a redaction too', store.queue().left, 0);
}

section('finding 21: the gist line holds the owner\'s words, so it isn\'t a writer\'s');
{
  wipeOutputs();
  const gist = text({ words: 'are you free friday?', tier: 'mouth', caller: null });
  const writer = text({ words: 'friday works' });
  store.sampleWeek(WEEK, { at: at(8) });
  eq('tier mouth with no caller isn\'t sampled', ofSurface('phone').map((i) => i.source_id), [writer]);
  check('(setup) the gist row exists', gist > 0);
  // Already queued before the fix: it leaves too.
  db.prepare(`INSERT OR IGNORE INTO review_items (week, surface, source_id, rank, sampled_at) VALUES (?, 'phone', ?, 'aaa', ?)`).run(WEEK.week, gist, at(8));
  const q = store.queue({ limit: 10 });
  eq('one already queued leaves', [q.left, q.cards.map((c) => c.sourceId)], [1, [writer]]);
  const mustGone = db.prepare('SELECT id FROM review_items WHERE surface = ? AND source_id = ?').get('phone', gist).id;
  eq('…and can\'t be marked', store.mark(mustGone, { verdict: 'pass' }).error, 'gone');
}

section('finding 22: a neglected queue stays quick and doesn\'t grow for ever');
{
  wipeOutputs();
  const ids = [];
  for (let i = 0; i < 300; i++) ids.push(text({ when: at(i % 7, 1 + (i % 20)), words: `text ${i}` }));
  const evOf = (id) => db.prepare('SELECT event_id AS e FROM story_messages WHERE id = ?').get(id).e;
  for (const [i, id] of ids.entries()) db.prepare(`INSERT OR IGNORE INTO review_items (week, surface, source_id, rank, sampled_at) VALUES (?, 'phone', ?, ?, ?)`).run(WEEK.week, id, String(i).padStart(4, '0'), at(8));
  // Reverted, redacted, and deleted-under-it each count as gone, wherever they sit in the order.
  db.prepare(`INSERT INTO world_events (at, type, actor, payload_json, origin_kind) VALUES (?, 'event.reverted', 'owner', ?, 'self')`).run(at(8), JSON.stringify({ targetId: evOf(ids[0]), reason: 't', by: 'owner' }));
  db.prepare('UPDATE world_events SET redacted = 1 WHERE id = ?').run(evOf(ids[1]));
  db.prepare("UPDATE story_messages SET status = 'reverted', text = NULL WHERE id = ?").run(ids[2]);
  // Count what the calls ask of the log. Timings would make this flaky; this can't be.
  const realPrepare = db.prepare.bind(db);
  let revertLookups = 0;
  let statements = 0;
  db.prepare = (sql) => { statements++; if (/event\.reverted/.test(sql)) revertLookups++; return realPrepare(sql); };
  const q = store.queue({ limit: 5 });
  const qRevert = revertLookups;
  const qStatements = statements;
  revertLookups = 0;
  statements = 0;
  const st = store.stats();
  const sRevert = revertLookups;
  const sStatements = statements;
  db.prepare = realPrepare;
  eq('left is exact: all three gone', q.left, 297);
  eq('the cards are the first live ones, in order', q.cards.map((c) => c.sourceId), ids.slice(3, 8));
  eq('stats agree', [st.left, st.rows[0].left, st.rows[0].gone], [297, 297, 3]);
  check('queue: the reverts are read once, not once per item', qRevert === 1, String(qRevert));
  check('queue: stops at its limit', qStatements < 60, String(qStatements));
  check('stats: the reverts are read once', sRevert === 1, String(sRevert));
  check('stats: no query per open item', sStatements < 60, String(sStatements));
  const exc = store.queue({ limit: 2, exclude: [q.cards[0].id, q.cards[1].id] });
  eq('leaving out what the page holds, the count stays', [exc.left, exc.cards.map((c) => c.sourceId)], [297, ids.slice(5, 7)]);
}
{
  wipeOutputs();
  const DAY = 86400;
  const old = text({ words: 'old unmarked' });
  const oldMarked = text({ words: 'old marked' });
  const oldFailed = text({ words: 'old failed' });
  const recent = text({ words: 'recent unmarked' });
  store.sampleWeek(WEEK, { at: at(8) });
  const idOf = (source) => db.prepare("SELECT id FROM review_items WHERE surface = 'phone' AND source_id = ?").get(source).id;
  const [a, b, c, d] = [old, oldMarked, oldFailed, recent].map(idOf);
  store.mark(b, { verdict: 'pass' });
  store.mark(c, { verdict: 'fail', note: 'flat' });
  const t0 = at(8);
  db.prepare('UPDATE review_items SET sampled_at = ? WHERE id IN (?, ?, ?)').run(t0 - 85 * DAY, a, b, c);
  db.prepare('UPDATE review_items SET sampled_at = ? WHERE id = ?').run(t0 - 83 * DAY, d);
  eq('past twelve weeks, one unmarked card goes', store.expireOpen?.(t0), 1);
  const left = db.prepare('SELECT id FROM review_items ORDER BY id').all().map((r) => r.id).sort((x, y) => x - y);
  eq('marks stay, whatever their age; a younger unmarked card stays', left, [b, c, d].sort((x, y) => x - y));
  check('a failure stays exportable', store.failureStubs().stubs.length === 1);
  db.prepare('UPDATE review_items SET sampled_at = ? WHERE id = ?').run(t0 - 85 * DAY, d);
  store.ensureWeeks(t0);
  check('the sampling timer\'s pass expires too', !db.prepare('SELECT 1 FROM review_items WHERE id = ?').get(d));
}

section('marking twice');
{
  wipeOutputs();
  const a = scene({ text: 'first' });
  const b = scene({ text: 'second' });
  store.sampleWeek(WEEK, { at: at(8) });
  const id = cardOf('scene', a).id;
  eq('first mark', store.mark(id, { verdict: 'pass', at: 100 }).already, undefined);
  eq('the same mark again: a no-op', store.mark(id, { verdict: 'pass', at: 200 }).already, true);
  eq('…the first time stands', db.prepare('SELECT marked_at FROM review_items WHERE id = ?').get(id).marked_at, 100);
  const other = store.mark(id, { verdict: 'fail' });
  eq('a different one is refused, and says what is there', [other.error, other.verdict], ['already_marked', 'pass']);
  eq('a marked card leaves the queue', store.queue().cards.map((c) => c.id).includes(id), false);
  eq('undo', store.unmark(id).was, 'pass');
  eq('…back in the queue', store.queue().cards.map((c) => c.id).includes(id), true);
  eq('undo again: a no-op', store.unmark(id).was, null);
  eq('…and it can be marked differently', store.mark(id, { verdict: 'fail', note: 'voice' }).ok, true);
  eq('unknown id', [store.mark(999_999, { verdict: 'pass' }).error, store.unmark(999_999).error, store.textOf(999_999).error], ['not_found', 'not_found', 'not_found']);
  eq('a bad verdict', store.mark(cardOf('scene', b).id, { verdict: 'maybe' }).error, 'bad_verdict');
}

section('a very long scene');
{
  wipeOutputs();
  const long = scene({ text: 'word '.repeat(10_000) });
  store.sampleWeek(WEEK, { at: at(8) });
  const c = cardOf('scene', long).card;
  check('capped, and says so', c.truncated && c.text.length === store.TEXT_MAX && c.length === 50_000, `${c.length}`);
}

section('the finished week, this week so far, downtime');
{
  wipeOutputs();
  const monday = store.weekOf(at(8)).from;
  scene({ when: at(1) });
  const so = store.sampleCurrentWeek(at(3));
  eq('this week so far', [so.week, so.added], [WEEK.week, 1]);
  eq('…stays open', db.prepare('SELECT closed FROM review_weeks WHERE week = ?').get(WEEK.week).closed, 0);
  scene({ when: at(5) });
  const before = store.ensureWeeks(monday + 3600);
  eq('the finished week tops it up, once', before, 1);
  eq('…closed', db.prepare('SELECT closed FROM review_weeks WHERE week = ?').get(WEEK.week).closed, 1);
  scene({ when: at(6) });
  eq('a closed week isn\'t sampled again', store.ensureWeeks(monday + 7200), 0);
  wipeOutputs();
  for (const back of [7, 14, 21, 28]) scene({ when: WEEK.from - back * 86400 + 3600 });
  const far = store.ensureWeeks(WEEK.from + 3600);
  check('after downtime: the last finished weeks, not all of history', far === 2 && db.prepare('SELECT COUNT(*) AS n FROM review_weeks').get().n === 2, String(far));
}

section('stubs for the incident suite');
{
  wipeOutputs();
  const plain = scene({ text: 'A scene that went wrong.', sheet: '{"place":"a cafe","outcome":"well"}' });
  const leak = scene({ text: 'ping 155500000001@s.whatsapp.net' });
  const leak2 = scene({ text: 'plain', sheet: '{"who":"155500000001@s.whatsapp.net"}' });
  const pass = scene({ text: 'fine' });
  store.sampleWeek(WEEK, { at: at(8) });
  for (const [id, verdict, note] of [[plain, 'fail', 'continuity'], [leak, 'fail', null], [leak2, 'fail', null], [pass, 'pass', null]]) store.mark(cardOf('scene', id).id, { verdict, note });
  const out = store.failureStubs();
  eq('only failures', out.stubs.length, 3);
  const s = out.stubs.find((x) => x.sourceId === plain);
  eq('shape', [out.v, out.kind, s.id, s.surface, s.note, s.text, s.sheet.place, s.expect], [1, 'incident-stubs', `review-${WEEK.week}-scene-${plain}`, 'scene', 'continuity', 'A scene that went wrong.', 'a cafe', 'fail']);
  check('a JID in the words or the sheet: withheld, never exported', !JSON.stringify(out).includes('@s.whatsapp.net') && out.stubs.filter((x) => x.withheld === 'jid').length === 2);
}

section('routes, gates, audit');
const { startDashboard } = await import('../src/dashboard/server.js');
const app = await startDashboard({ getSock: () => null });
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'review-test-csrf';
async function req(method, url, { body, csrf = true, auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = AUTH;
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, remoteAddress: '127.0.0.1', ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json, headers: res.headers };
}
{
  wipeOutputs();
  const WORDS = 'ROUTE_WORDS_NOT_IN_AUDIT';
  const a = scene({ text: WORDS });
  const hot = scene({ text: WORDS, heat: 'explicit' });
  store.sampleWeek(WEEK, { at: at(8) });
  const id = cardOf('scene', a).id;
  const hotId = cardOf('scene', hot).id;
  eq('no auth, no queue', (await req('GET', '/api/review/queue', { auth: false, csrf: false })).status, 401);
  const q = await req('GET', '/api/review/queue');
  check('the queue, with the note codes', q.status === 200 && q.json.left === 2 && q.json.notes.includes('voice'));
  check('a private card has no words in the queue', q.json.cards.find((c) => c.id === hotId).text === null);
  eq('the tap', (await req('GET', `/api/review/items/${hotId}/text`)).json.text, WORDS);
  eq('a bad id', (await req('GET', '/api/review/items/abc/text')).status, 400);
  check('finding 24: with life off a card says someone, never the raw id', q.json.cards.every((c) => c.who.every((w) => w === 'someone')) && !JSON.stringify(q.json.cards.map((c) => c.who)).includes('cast:'), JSON.stringify(q.json.cards.map((c) => c.who)));
  const { castNameFrom } = await import('../src/dashboard/routes/review.js');
  const state = { cast: new Map([['cast:here', { name: 'Robin' }]]), story: { departed: { 'cast:gone': { name: 'Sam', how: 'written_out' } } } };
  eq('finding 24: here, departed, unknown, no state', [castNameFrom(state, 'cast:here'), castNameFrom(state, 'cast:gone'), castNameFrom(state, 'cast:who'), castNameFrom(null, 'cast:here')], ['Robin', 'Sam', 'someone', 'someone']);
  const without = await req('GET', `/api/review/queue?exclude=${id},nonsense,-4`);
  check('what the page holds is left out, the count isn\'t', without.json.left === 2 && without.json.cards.length === 1 && without.json.cards[0].id === hotId, JSON.stringify(without.json.cards.map((c) => c.id)));
  config.dashboard.readOnly = true;
  eq('read-only: a mark is refused', (await req('POST', `/api/review/items/${id}/mark`, { body: { verdict: 'pass' } })).status, 403);
  eq('read-only: the sample too', (await req('POST', '/api/review/sample', { body: {} })).status, 403);
  eq('read-only: it still reads', (await req('GET', '/api/review/stats')).status, 200);
  config.dashboard.readOnly = false;
  eq('no CSRF token: refused', (await req('POST', `/api/review/items/${id}/mark`, { body: { verdict: 'pass' }, csrf: false })).status, 403);
  eq('…nothing was marked', db.prepare('SELECT verdict FROM review_items WHERE id = ?').get(id).verdict, null);
  eq('a mark', (await req('POST', `/api/review/items/${id}/mark`, { body: { verdict: 'fail', note: 'voice' } })).json.ok, true);
  eq('the same again is fine', (await req('POST', `/api/review/items/${id}/mark`, { body: { verdict: 'fail', note: 'voice' } })).json.already, true);
  eq('a different one: 409', (await req('POST', `/api/review/items/${id}/mark`, { body: { verdict: 'pass' } })).status, 409);
  eq('a bad note: 400', (await req('POST', `/api/review/items/${hotId}/mark`, { body: { verdict: 'pass', note: 'x' } })).status, 400);
  db.prepare("UPDATE story_scenes SET status = 'reverted', text = NULL WHERE id = ?").run(hot);
  eq('undone: 409 gone', (await req('POST', `/api/review/items/${hotId}/mark`, { body: { verdict: 'pass' } })).json.error, 'gone');
  const audit = db.prepare("SELECT action, target, payload_json AS p FROM dashboard_audit WHERE action LIKE 'review.%'").all();
  eq('one audit row per real mark', audit.filter((r) => r.action === 'review.mark').length, 1);
  check('audit: ids and codes, no words', audit.length > 0 && !JSON.stringify(audit).includes(WORDS));
  eq('unmark', (await req('POST', `/api/review/items/${id}/unmark`, { body: {} })).json.was, 'fail');
  store.mark(id, { verdict: 'fail', note: 'voice' });
  const dl = await req('GET', '/api/review/failures.json');
  check('the download', dl.status === 200 && /attachment/.test(dl.headers['content-disposition']) && dl.json.stubs.length === 1);
  const st = await req('GET', '/api/review/stats');
  check('stats by week and surface', st.status === 200 && st.json.rows[0].week === WEEK.week && st.json.notes[0].note === 'voice');
  const sampled = await req('POST', '/api/review/sample', { body: {} });
  check('sample this week: audited', sampled.status === 200 && db.prepare("SELECT COUNT(*) AS n FROM dashboard_audit WHERE action = 'review.sample'").get().n === 1);
}

section('guards');
{
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const [name, file] of [['store', '../src/memory/reviewStore.js'], ['route', '../src/dashboard/routes/review.js']]) {
    const s = src(file);
    check(`${name}: no model, no send`, !/callRole|callLlm|askJev|brain\/|sendText|whatsapp\//.test(s));
    check(`${name}: no story module`, !/life\/story\//.test(s));
  }
  check('store: never writes a source table', !/(INSERT|UPDATE|DELETE)[^`]*\bstory_|(INSERT|UPDATE|DELETE)[^`]*world_events/i.test(src('../src/memory/reviewStore.js')));
  check('route: logs no words', !/logger\.\w+\(\{[^}]*\b(text|words)\b/.test(src('../src/dashboard/routes/review.js')));
  const page = src('../src/dashboard/public/js/pages/review.js');
  check('page: no raw HTML, no browser dialog', !/innerHTML|raw\(|confirm\(|alert\(/.test(page));
  check('page: what waits in storage is ids and codes', /pending\.push\(\{ id: current\.id, verdict, note \}\)/.test(page) && !/setItem\(PENDING_KEY, JSON\.stringify\(cards/.test(page));
  eq('no network', fetches, 0);
}
await app.close?.();
cleanup();
report();
