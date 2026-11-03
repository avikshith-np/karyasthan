// T004a — src/mind/store.js, the only door to the v10 mind tables
// (contracts/mind-api.md "Store API", data-model.md): CRUD for every table, the
// AUTOINCREMENT guarantee (a deleted max id is never reused), the one-active /
// one-queued unique indexes, owner-only settings (fail-closed review state, the
// one-time first-live init), the monotonic digest cursor, cursor seeding, sticky
// episode-log outcomes, exclusions (detected → owner_cleared → reopened only by a
// newer message), identity merge/record/reassign, DM-row deletion, retention
// windows incl. the 7-day free-text nulling, and nullFreeText by chat.
// Scratch DB, fake clock, no network, no model.
import fs from 'fs';
import path from 'path';
import {
  setupScratchDb, fakeClock, blockNetwork, seedPerson, seedGroup, seedMessage, setBot,
  section, check, eq, throws, report, DAY, HOUR, PROJECT_ROOT,
} from './_helpers.js';

const { db } = await setupScratchDb();
blockNetwork();
const store = await import('../../src/mind/store.js');
const { config } = await import('../../src/utils/config.js');

const clock = fakeClock(Date.UTC(2026, 9, 27, 6, 0) / 1000);
store.setStoreClock(clock.fn);
await setBot();

const ALICE = await seedPerson({ jid: '81001@lid', name: 'Avery', pn: '15550001001@s.whatsapp.net' });
const BOB = await seedPerson({ jid: '81002@lid', name: 'Blake' });
const G = await seedGroup({ jid: '120363000000081001@g.us', name: 'Weekend', members: [ALICE, BOB] });
const OWNER = 'owner:tester';

const seqOf = (t) => db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').pluck().get(t);

// ── state ──────────────────────────────────────────────────────────────────
section('mind_state');
{
  const s0 = store.getState();
  eq('defaults before any write', [s0.lastRowid, s0.lastEventId, s0.nextThinkAt], [0, 0, null]);
  const s1 = store.patchState({ lastTickAt: clock.now(), nextThinkAt: clock.now() + 3600, lastRowid: 5 });
  eq('patchState writes allow-listed fields', [s1.lastTickAt, s1.nextThinkAt, s1.lastRowid], [clock.now(), clock.now() + 3600, 5]);
  eq('patchState keeps the singleton', db.prepare('SELECT COUNT(*) FROM mind_state').pluck().get(), 1);
  eq('null clears a clock', store.patchState({ nextThinkAt: null }).nextThinkAt, null);
  throws('unknown field throws (no caller key becomes SQL)', () => store.patchState({ 'id = 2; --': 1 }), /no writable field/);
  throws('non-numeric cursor throws', () => store.patchState({ lastRowid: 'x' }), /finite/);
}

// ── settings ───────────────────────────────────────────────────────────────
section('mind_settings (owner-only, fail closed)');
{
  let s = store.getSettings();
  eq('missing review state reads as review', [s.reviewMode, s.reviewUntil], ['review', null]);
  eq('missing pause/exclude_all → false', [s.paused, s.excludeAll], [false, false]);
  eq('missing proactive_mode → the .env seed (shadow)', s.proactiveMode, config.mind.proactiveMode);
  check('reviewState is not auto with nothing set', store.reviewState(clock.now()).autoActive === false);

  // Corrupt rows (written behind the store's back) fail closed.
  const raw = (k, v) => db.prepare(`INSERT OR REPLACE INTO mind_settings (key, value, updated_at, updated_by) VALUES (?, ?, 1, 'x')`).run(k, v);
  raw('review_mode', '"window"');
  raw('review_until', 'null');
  eq("'window' without a finite review_until → review", store.getSettings().reviewMode, 'review');
  check('…and never auto-applies (now >= null trap)', store.reviewState(clock.now()).autoActive === false);
  raw('review_mode', '"bogus"');
  eq('an unknown review_mode → review', store.getSetting('review_mode'), 'review');
  raw('paused', '{not json');
  raw('exclude_all', 'nope');
  raw('proactive_mode', '"loud"');
  s = store.getSettings();
  eq('unparsable pause/exclude_all → true (fail closed)', [s.paused, s.excludeAll], [true, true]);
  eq('an invalid proactive_mode → off', s.proactiveMode, 'off');
  db.prepare(`DELETE FROM mind_settings`).run();

  eq('seedDefaults writes the .env proactive mode once', store.seedDefaults(), true);
  eq('…and only once', store.seedDefaults(), false);
  eq('seed row is a system write', db.prepare(`SELECT updated_by FROM mind_settings WHERE key = 'proactive_mode'`).pluck().get(), 'system');

  const t0 = clock.now();
  eq('initFirstLive initialises once', store.initFirstLive(t0, 14), true);
  s = store.getSettings();
  eq('first_enabled_at / review_until / window', [s.firstEnabledAt, s.reviewUntil, s.reviewMode], [t0, t0 + 14 * DAY, 'window']);
  clock.advance({ days: 1 });
  eq('a second initFirstLive is a no-op', store.initFirstLive(clock.now(), 3), false);
  eq('…nothing moved', [store.getSettings().firstEnabledAt, store.getSettings().reviewUntil], [t0, t0 + 14 * DAY]);
  check('window not over → not auto', store.reviewState(t0 + 13 * DAY).autoActive === false);
  check('window over → auto', store.reviewState(t0 + 14 * DAY).autoActive === true);

  // owner setters
  throws('owner.setSetting needs an owner actor', () => store.owner.setSetting('paused', true, 'mind'), /owner:<user>/);
  throws('owner.setSetting refuses system keys', () => store.owner.setSetting('first_enabled_at', 1, OWNER), /not an owner setting/);
  throws('owner.setSetting validates enums', () => store.owner.setSetting('proactive_mode', 'loud', OWNER), /one of/);
  throws('owner.setSetting validates booleans', () => store.owner.setSetting('paused', 'yes', OWNER), /boolean/);
  throws('owner.setSetting validates bands', () => store.owner.setSetting('bands', [1, 2], OWNER), /object/);
  eq('owner.setSetting writes', store.owner.setSetting('review_mode', 'review', OWNER), { ok: true, key: 'review_mode', value: 'review' });
  eq('…recorded as the owner', db.prepare(`SELECT updated_by FROM mind_settings WHERE key = 'review_mode'`).pluck().get(), OWNER);
  store.owner.setSetting('paused', true, OWNER);
  store.owner.setSetting('bands', { responseRate: { min: 0.1, max: 0.2 } }, OWNER);
  s = store.getSettings();
  eq('owner values read back', [s.paused, s.reviewMode, s.bands?.responseRate?.max], [true, 'review', 0.2]);
  check('"always review" sticks past the window', store.reviewState(t0 + 30 * DAY).autoActive === false);
  store.owner.setSetting('paused', false, OWNER);

  // initFirstLive never overrides an owner's earlier choice of review mode.
  db.prepare(`DELETE FROM mind_settings WHERE key IN ('first_enabled_at', 'review_until')`).run();
  store.owner.setSetting('review_mode', 'auto', OWNER);
  store.initFirstLive(clock.now(), 14);
  eq("initFirstLive keeps an owner's review_mode", store.getSettings().reviewMode, 'auto');

  store.setLastAutoApply(clock.now());
  eq('setLastAutoApply is a system write', db.prepare(`SELECT updated_by FROM mind_settings WHERE key = 'last_auto_apply_at'`).pluck().get(), 'system');

  // Static: the only system writes are the three named functions, and they touch only their keys.
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src/mind/store.js'), 'utf-8');
  const systemKeys = [...src.matchAll(/writeSetting\(db, '([a-z_]+)'/g)].map(m => m[1]);
  // + the opt-out lookback's Jev-cleared message ids and the hooks' durable degraded marker
  // (audit fixes) — system bookkeeping keys, never owner settings.
  check('system writeSetting calls touch only first_enabled_at / review_until / review_mode / dont_text_jev_cleared / degraded',
    systemKeys.length > 0 && systemKeys.every(k => ['first_enabled_at', 'review_until', 'review_mode', 'dont_text_jev_cleared', 'degraded'].includes(k)), systemKeys);
  {
    let refused = 0;
    for (const k of ['dont_text_jev_cleared', 'degraded']) { try { store.owner.setSetting(k, null, OWNER); } catch { refused++; } }
    eq('the two bookkeeping keys are not owner settings', refused, 2);
    const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
    store.addJevClearedOptOut('m-a', clock.now() - 200 * 86400, clock.now(), H1);
    store.addJevClearedOptOut('m-b', clock.now(), clock.now(), H2);
    eq('Jev-cleared ids: older than the 180-day lookback are dropped', [...store.jevClearedOptOuts()], [['m-b', H2]]);
    eq('…an id without the hash of the judged text is not stored', store.addJevClearedOptOut('m-c', clock.now(), clock.now()), false);
    db.prepare(`UPDATE mind_settings SET value = ? WHERE key = 'dont_text_jev_cleared'`)
      .run(JSON.stringify([['m-old', clock.now()], ['m-b', clock.now(), H2]]));
    eq('…a stored id without a hash (pre-hash row) clears nothing (fail closed)', [...store.jevClearedOptOuts().keys()], ['m-b']);
    store.setDegraded({ at: 5, source: 'itemsDeleted', cause: 'revoke' });
    eq('degraded marker round-trips', store.getDegraded(), { at: 5, source: 'itemsDeleted', cause: 'revoke' });
    db.prepare(`UPDATE mind_settings SET value = '{bad' WHERE key = 'degraded'`).run();
    eq('an unreadable degraded marker stays degraded (fail closed)', store.getDegraded()?.at, null);
    store.setDegraded(null);
    eq('cleared', store.getDegraded(), null);
  }
  check("the only other system settings writes are last_auto_apply_at and the proactive_mode seed",
    /writeSetting\(getDb\(\), 'last_auto_apply_at'/.test(src) && (src.match(/INSERT OR IGNORE INTO mind_settings/g) || []).length === 1
    && (src.match(/writeSetting\(/g) || []).length === systemKeys.length + 4);   // + definition, setLastAutoApply, owner.setSetting, setStanceSetting
  check('no export other than owner.* takes an owner setting key',
    !/export function set(Paused|ProactiveMode|ReviewMode|Bands|ExcludeAll)/.test(src));
}

// ── runs ───────────────────────────────────────────────────────────────────
section('mind_runs');
{
  const id = store.insertRun({ kind: 'think', trigger: 'scheduled', input: { labels: { C1: { chatJid: G } } } });
  let r = store.getRun(id);
  eq('insertRun defaults (running, day key, started_at)', [r.status, r.dayKey, r.startedAt], ['running', store.localDateKey(clock.now()), clock.now()]);
  eq('input_json parsed on read', r.input.labels.C1.chatJid, G);
  clock.advance({ minutes: 2 });
  store.finishRun(id, { status: 'ok', output: { v: 1, note: 'quiet day', nudges: [{ knob: 'responseRate', reason: 'calm' }] },
    dropped: [{ path: 'today[0]', reason: 'unknown_ref' }], model: 'm', tokensIn: 10, tokensOut: 5, costUsd: 0.01, fellBack: true });
  r = store.getRun(id);
  eq('finishRun sets fields + finished_at', [r.status, r.finishedAt, r.fellBack, r.costUsd, r.dropped[0].reason],
    ['ok', clock.now(), true, 0.01, 'unknown_ref']);
  throws('bad kind throws', () => store.insertRun({ kind: 'dream' }), /one of/);
  throws('bad skip reason throws', () => store.finishRun(id, { skipReason: 'bored' }), /one of/);
  throws('kind is not changeable by finishRun', () => store.finishRun(id, { kind: 'sleep' }), /no writable field/);

  const big = store.insertRun({ kind: 'glance', input: { blob: 'x'.repeat(5000) }, dropped: Array.from({ length: 400 }, (_, i) => ({ path: `p${i}`, reason: 'r' })) });
  const b = store.getRun(big);
  check('input_json over 4 KB is replaced by a marker', b.input._truncated === true);
  check('dropped_json is trimmed to ≤ 4 KB', JSON.stringify(b.dropped).length <= 4096 && b.dropped.length > 0);
  store.finishRun(big, { status: 'skipped', skipReason: 'asleep', error: 'e'.repeat(400) });
  eq('error capped at 300', store.getRun(big).error.length, 300);

  eq('countRuns by kind/day/status', store.countRuns({ kind: 'think', dayKey: store.localDateKey(clock.now()), status: ['ok'] }), 1);
  eq('lastSkip', store.lastSkip('glance', 'asleep'), clock.now());
  eq('lastSkip of nothing → null', store.lastSkip('think', 'budget'), null);
  const list = store.listRuns({ limit: 500 });
  check('listRuns newest first, summary only', list[0].id === big && list[0].output === undefined && list.length === 2);
  eq('listRuns before', store.listRuns({ before: big }).map(x => x.id), [id]);

  // AUTOINCREMENT: delete the max row → the next id is still new.
  db.prepare('DELETE FROM mind_runs WHERE id = ?').run(big);
  const next = store.insertRun({ kind: 'pulse' });
  check('a deleted max run id is never reused', next > big, { next, big });
}

// ── nights ─────────────────────────────────────────────────────────────────
section('mind_nights');
{
  throws('a new night needs a status', () => store.upsertNight('2026-10-26', {}), /status/);
  let n = store.upsertNight('2026-10-26', { status: 'running', startedAt: clock.now(), incAttempts: true });
  eq('created with attempts 1', [n.status, n.attempts], ['running', 1]);
  n = store.upsertNight('2026-10-26', { status: 'failed', incAttempts: true });
  eq('incAttempts on update', [n.status, n.attempts], ['failed', 2]);
  n = store.upsertNight('2026-10-26', { status: 'done', partial: 'fell_back', episodes: 3 });
  eq('done + partial', [n.status, n.partial, n.episodes, n.attempts], ['done', 'fell_back', 3, 2]);
  eq('getNight', store.getNight('2026-10-26').status, 'done');
  throws('the PK is one row per night', () => db.prepare(`INSERT INTO mind_nights (night_key, status) VALUES ('2026-10-26', 'running')`).run());
  throws('bad night key', () => store.upsertNight('yesterday', { status: 'running' }), /night key/);
}

// ── activity ───────────────────────────────────────────────────────────────
section('mind_chat_activity');
{
  const dk = store.localDateKey(clock.now());
  store.bumpActivity(G, dk, { msgs: 3, humanMsgs: 2, botMentions: 1, lastHumanAt: clock.now() - 60 });
  const a = store.bumpActivity(G, dk, { msgs: 1, botMsgs: 1, lastBotAt: clock.now(), lastHumanAt: clock.now() - 600 });
  eq('counters add, times keep the max', [a.msgs, a.humanMsgs, a.botMentions, a.botMsgs, a.lastHumanAt, a.lastBotAt],
    [4, 2, 1, 1, clock.now() - 60, clock.now()]);
  eq('activityFor(day key)', store.activityFor(dk).length, 1);
  eq('activityFor(time)', store.activityFor(clock.now() + 1).length, 0);
  throws('unknown counter throws', () => store.bumpActivity(G, dk, { evil: 1 }), /unknown field/);
}

// ── digests + cursor ───────────────────────────────────────────────────────
section('mind_digests + the monotonic digest cursor');
let d1;
let d2;
{
  const base = { chatJid: G, originKind: 'group', periodStart: clock.now() - 3600, periodEnd: clock.now(), summary: 'planned a trip', tone: 'warm' };
  d1 = store.insertDigest({ ...base, fromRowid: 0, toRowid: 10, todayNote: 'trip on saturday',
    threads: [{ k: 1, text: 'trip', evidence: ['m1'], authors: [ALICE] }], evidence: [{ msgId: 'm1', ts: 1 }, { msgId: 'm2', ts: 2 }] });
  d2 = store.insertDigest({ ...base, fromRowid: 10, toRowid: 20, evidence: [{ msgId: 'm3', ts: 3 }] });
  eq('cursor = newest to_rowid', store.digestCursor(G), 20);
  eq('digest evidence stored as item_evidence(mind_digest)', store.digestEvidence(d1).map(e => e.msgId), ['m1', 'm2']);
  eq('latestDigest', store.latestDigest(G).id, d2);
  eq('getDigest parses threads', store.getDigest(d1).threads[0].authors, [ALICE]);
  eq('digestsFor oldest first', store.digestsFor(G).map(d => d.id), [d1, d2]);
  db.prepare('DELETE FROM mind_digests WHERE id = ?').run(d2);
  eq('deleting the newest digest never steps the cursor back', store.digestCursor(G), 20);
  const d3 = store.insertDigest({ ...base, chatJid: BOB, originKind: 'dm', fromRowid: 0, toRowid: 5 });
  check('a deleted max digest id is never reused (AUTOINCREMENT)', d3 > d2, { d3, d2 });
  store.insertDigest({ ...base, fromRowid: 5, toRowid: 8 });
  eq('an older range never lowers the cursor', store.digestCursor(G), 20);
  throws('bad tone throws', () => store.insertDigest({ ...base, fromRowid: 0, toRowid: 1, tone: 'angry' }), /one of/);
  throws('summary is required', () => store.insertDigest({ ...base, summary: null, fromRowid: 0, toRowid: 1 }), /required/);
  const capped = store.insertDigest({ ...base, fromRowid: 20, toRowid: 21, summary: 's'.repeat(900), todayNote: 't'.repeat(200) });
  eq('summary ≤ 400 / today_note ≤ 80', [store.getDigest(capped).summary.length, store.getDigest(capped).todayNote.length], [400, 80]);
  eq('digestCursor of an unknown chat → 0', store.digestCursor('nobody@g.us'), 0);
}

// ── episode cursor + seeding ───────────────────────────────────────────────
section('mind_episode_cursor + seedCursorsToMax');
{
  store.setEpisodeCursor(G, { lastRowid: 30, lastNightKey: '2026-10-26' });
  store.setEpisodeCursor(G, { lastRowid: 12 });
  const c = store.getEpisodeCursor(G);
  eq('last_rowid is monotonic; night key kept', [c.lastRowid, c.digestRowid, c.lastNightKey], [30, 21, '2026-10-26']);

  const ts = clock.now() - 100;
  const m1 = await seedMessage({ chat: G, sender: ALICE, text: 'one', ts });
  const m2 = await seedMessage({ chat: G, sender: BOB, text: 'two', ts: ts + 1 });
  const dmPn = await seedMessage({ chat: '15550001001@s.whatsapp.net', sender: '15550001001@s.whatsapp.net', text: 'hi', ts: ts + 2 });
  const dmLid = await seedMessage({ chat: ALICE, sender: ALICE, text: 'again', ts: ts + 3 });
  db.prepare(`INSERT INTO world_events (at, type, actor) VALUES (?, 'test', 'engine')`).run(clock.now());
  const evMax = db.prepare('SELECT MAX(id) FROM world_events').pluck().get();
  const seeded = store.seedCursorsToMax();
  eq('scan cursor → MAX(messages.rowid) (never below the stored one)', seeded.lastRowid, Math.max(5, dmLid.rowid));
  eq('event cursor → MAX(world_events.id)', seeded.lastEventId, evMax);
  const gc = store.getEpisodeCursor(G);
  eq('group cursors → its MAX(rowid)', [gc.lastRowid, gc.digestRowid], [Math.max(30, m2.rowid), Math.max(21, m2.rowid)]);
  const ac = store.getEpisodeCursor(ALICE);
  eq('a DM under PN + LID forms is one chat (chatKeyOf)', [ac?.lastRowid, ac?.digestRowid], [dmLid.rowid, dmLid.rowid]);
  check('no cursor under the raw PN form', !store.getEpisodeCursor('15550001001@s.whatsapp.net'));
  check('m1/dmPn seeded rows exist', m1.rowid < dmPn.rowid);
  store.patchState({ lastRowid: dmLid.rowid + 100 });
  eq('seeding never steps the scan cursor back', store.seedCursorsToMax().lastRowid, dmLid.rowid + 100);
}

// ── episode log ────────────────────────────────────────────────────────────
section('mind_episode_log (sticky outcomes, rebuild list)');
{
  store.logEpisodeNight(G, '2026-10-20', { outcome: 'written', memoryId: 501 });
  store.logEpisodeNight(G, '2026-10-21', { outcome: 'deleted', cause: 'revoke' });
  store.logEpisodeNight(G, '2026-10-22', { outcome: 'deleted', cause: 'forget', rebuildRequested: true });
  store.logEpisodeNight(G, '2026-10-23', { outcome: 'fenced', cause: 'forget' });
  store.logEpisodeNight(G, '2026-10-24', { outcome: 'deleted', cause: 'purge', rebuildRequested: true });
  store.logEpisodeNight(BOB, '2026-10-24', { outcome: 'deleted', cause: 'edit' });
  store.logEpisodeNight(G, '2026-10-25', { outcome: 'null' });
  eq('only revoke/edit deletions are rebuildable', store.nightsToRebuild('2026-10-01', 10).map(r => `${r.chatJid === G ? 'G' : 'B'}:${r.nightKey}`),
    ['B:2026-10-24', 'G:2026-10-21']);
  eq('nightsToRebuild honours since + limit', store.nightsToRebuild('2026-10-22', 10).length, 1);
  store.logEpisodeNight(G, '2026-10-23', { outcome: 'deleted', cause: 'revoke' });
  eq('a fenced night stays fenced (never rebuilt)', [store.episodeNight(G, '2026-10-23').outcome, store.episodeNight(G, '2026-10-23').rebuildRequested],
    ['fenced', false]);
  store.logEpisodeNight(G, '2026-10-24', { outcome: 'written', memoryId: 9 });
  eq('a purge-deleted night stays deleted', store.episodeNight(G, '2026-10-24').outcome, 'deleted');
  store.logEpisodeNight(G, '2026-10-21', { outcome: 'fenced', cause: 'forget' });
  eq('a forget after a revoke fences the night', [store.episodeNight(G, '2026-10-21').outcome, store.nightsToRebuild('2026-10-01', 10).length], ['fenced', 1]);
  eq('episodeNightsForMemories', store.episodeNightsForMemories([501]).map(r => r.nightKey), ['2026-10-20']);
  throws('bad outcome throws', () => store.logEpisodeNight(G, '2026-10-26', { outcome: 'lost' }), /one of/);
}

// ── self-state ─────────────────────────────────────────────────────────────
section('mind_self_state');
let elG;
{
  const exp = clock.now() + 24 * HOUR;
  const mood = store.insertElement({ kind: 'mood', word: 'calm', intensity: 0.4, expiresAt: exp,
    origins: [{ originJid: G, minLearnedAt: 100 }, { originJid: ALICE, minLearnedAt: 200 }] });
  elG = store.insertElement({ kind: 'intention', intentionKind: 'follow_up', targetChat: G, basis: [{ digestId: d1, thread: 1 }],
    origins: [{ originJid: G, minLearnedAt: 100 }], expiresAt: exp });
  const old = store.insertElement({ kind: 'today', basis: [{ digestId: d1, today: true }], expiresAt: clock.now() - 1 });
  eq('activeElements excludes expired-by-time', store.activeElements().map(e => e.id).sort(), [mood, elG].sort());
  eq('parsed basis/origins', [store.getElement(elG).basis[0].digestId, store.getElement(mood).origins.length], [d1, 2]);
  eq('expireElements', store.expireElements(clock.now()), 1);
  eq('…status expired', store.getElement(old).status, 'expired');
  eq('setElementStatus', store.setElementStatus([mood], 'superseded'), 1);
  throws('bad intention kind', () => store.insertElement({ kind: 'intention', intentionKind: 'stalk', expiresAt: exp }), /one of/);
  throws('expires_at is required', () => store.insertElement({ kind: 'mood' }), /required/);
  store.setElementStatus([mood], 'active');
}

// ── self-model ─────────────────────────────────────────────────────────────
section('mind_self_model (one active, invalid keeps no text)');
{
  const seed = store.seedSelfModel();
  eq('seed: version 0, empty, active', [seed.version, seed.text, seed.status, seed.source], [0, '', 'active', 'seed']);
  store.seedSelfModel();
  eq('seeding twice writes once', db.prepare('SELECT COUNT(*) FROM mind_self_model').pluck().get(), 1);
  const p1 = store.insertSelfModel({ source: 'mind', status: 'proposed', text: 'I keep it short lately.', baseVersion: 0,
    diff: [{ op: '+', line: 'I keep it short lately.' }], rationale: 'r' });
  eq('version auto-increments', store.getSelfModel(p1).version, 1);
  const bad = store.insertSelfModel({ source: 'mind', status: 'invalid', text: 'unscrubbed original with a name', scrub: { rejectReason: 'names' } });
  eq('an invalid proposal stores no text', store.getSelfModel(bad).text, '');
  eq('setSelfModelStatus active swaps the active row', store.setSelfModelStatus(p1, 'active', { decidedBy: OWNER, decidedAt: clock.now() }), 1);
  eq('one active row', [store.activeSelfModel().id, store.getSelfModel(seed.id).status], [p1, 'superseded']);
  throws('the partial unique index allows only one active', () => db.prepare(`UPDATE mind_self_model SET status = 'active' WHERE id = ?`).run(seed.id));
  const own = store.insertSelfModel({ source: 'owner', status: 'active', text: 'Owner edit.' });
  eq('inserting an active row supersedes the old one', [store.activeSelfModel().id, store.getSelfModel(p1).status], [own, 'superseded']);
  check('activated_at set', store.getSelfModel(own).activatedAt === clock.now());
  store.setSelfModelStatus(p1, 'invalid');
  eq("'invalid' blanks the text", store.getSelfModel(p1).text, '');
  eq('listSelfModel newest first', store.listSelfModel({ limit: 2 }).map(v => v.version), [3, 2]);
  eq('listSelfModel by status', store.listSelfModel({ status: ['superseded'] }).length, 1);
  const long = store.insertSelfModel({ source: 'mind', status: 'proposed', text: 'x'.repeat(2000) });
  eq('text capped at 1500', store.getSelfModel(long).text.length, 1500);
  throws('a duplicate version is refused', () => store.insertSelfModel({ source: 'mind', status: 'proposed', text: 'a', version: 1 }));
}

// ── nudges ─────────────────────────────────────────────────────────────────
section('mind_nudges (one active per knob/scope)');
{
  const band = { min: 0.1, max: 0.2, base: 0.15 };
  const n1 = store.insertNudge({ knob: 'responseRate', scope: 'global', prevValue: 0.15, value: 0.17, requested: 0.17, band, status: 'active',
    reason: 'lively', expiresAt: clock.now() + DAY });
  check('active by status', store.getNudge(n1).active === true && store.getNudge(n1).value === 0.17);
  const n2 = store.insertNudge({ knob: 'responseRate', scope: 'global', prevValue: 0.17, value: 0.2, requested: 0.3, band, status: 'clamped',
    expiresAt: clock.now() + DAY });
  eq('a new active nudge replaces the old one', [store.getNudge(n1).status, store.getNudge(n1).active, store.getNudge(n1).endedBy], ['replaced', false, 'replaced']);
  eq('…clamped rows are active', [store.getNudge(n2).active, store.getNudge(n2).requested], [true, 0.3]);
  throws('the partial unique index allows one active per knob/scope', () =>
    db.prepare(`INSERT INTO mind_nudges (knob, scope, prev_value, value, requested, band_json, status, active) VALUES ('responseRate', 'global', '1', '1', '1', '{}', 'active', 1)`).run());
  const r = store.insertNudge({ knob: 'reactTendency', scope: 'global', prevValue: 1, value: 1, requested: 9, band, status: 'refused', refuseReason: 'no_change' });
  check('refused rows are never active', store.getNudge(r).active === false);
  store.insertNudge({ knob: 'replyLength', scope: G, prevValue: 'normal', value: 'shorter', requested: 'shorter', band: { allowed: ['shorter', 'normal'] }, status: 'active', expiresAt: clock.now() + DAY });
  eq('activeNudges', store.activeNudges().map(n => n.knob), ['responseRate', 'replyLength']);
  eq('endNudge ends an active row once', [store.endNudge(n2, 'reverted', OWNER), store.endNudge(n2, 'expired', 'expiry')], [1, 0]);
  eq('lastApplied ignores refused rows', [store.lastApplied('responseRate', 'global'), store.lastApplied('reactTendency', 'global')], [clock.now(), null]);
  throws('forbidden knob name → throws', () => store.insertNudge({ knob: 'dryRun', scope: 'global', prevValue: 1, value: 1, requested: 1, band, status: 'active' }), /one of/);
  throws('values must be JSON scalars', () => store.insertNudge({ knob: 'responseRate', scope: 'global', prevValue: { a: 1 }, value: 1, requested: 1, band, status: 'active' }), /scalar/);
  eq('listNudges', store.listNudges({ knob: 'responseRate' }).length, 2);
}

// ── proactive ──────────────────────────────────────────────────────────────
section('mind_proactive (one queued per chat)');
let q1;
{
  const base = { chatJid: G, chatKind: 'group', kind: 'follow_up', basis: [{ digestId: d1, thread: 1 }], origins: [{ originJid: G, minLearnedAt: 100 }], mode: 'live' };
  q1 = store.insertDraft({ ...base, status: 'drafting', reason: 'trip follow-up' });
  store.updateDraft(q1, { status: 'queued', intent: 'ask how the trip plan is going', voicedText: 'so is saturday still on?',
    audience: { members: [ALICE, BOB] }, sendAfter: clock.now() + 60 });
  const q2 = store.insertDraft({ ...base, status: 'drafting' });
  let err = null;
  try { store.updateDraft(q2, { status: 'queued' }); } catch (e) { err = e; }
  check('a second queued draft for the chat is refused (unique index)', err?.code === 'SQLITE_CONSTRAINT_UNIQUE');
  eq('dueQueued respects send_after', [store.dueQueued(clock.now()).length, store.dueQueued(clock.now() + 60).length], [0, 1]);
  eq('countDrafts (caps) excludes its own row', [
    store.countDrafts({ chatJid: G, statuses: store.DRAFT_COUNTED, since: 0 }),
    store.countDrafts({ chatJid: G, statuses: store.DRAFT_COUNTED, since: 0, excludeId: q1 })], [1, 0]);
  throws('countDrafts needs statuses', () => store.countDrafts({ chatJid: G }), /statuses/);
  const sh = store.insertDraft({ ...base, mode: 'shadow', status: 'would_send', voicedText: 'shadow text' });
  eq('lastSentTo sees would_send', store.lastSentTo(G).id, sh);
  clock.advance({ minutes: 20 });
  eq('dropStaleDrafting', store.dropStaleDrafting(clock.now() - 15 * 60), 1);
  eq('…as stale_draft', [store.getDraft(q2).status, store.getDraft(q2).dropReason], ['dropped', 'stale_draft']);
  const dm = store.insertDraft({ chatJid: ALICE, chatKind: 'dm', personJid: ALICE, sendJid: '15550001001@s.whatsapp.net', kind: 'check_in',
    basis: [{ digestId: d1, today: true }], origins: [{ originJid: ALICE, minLearnedAt: 1 }], mode: 'live', status: 'drafting' });
  eq('updateDraftsWhere by chat forms', store.updateDraftsWhere({ chatForms: [ALICE], statuses: ['drafting', 'queued'] },
    { status: 'cancelled', dropReason: 'skill_off' }), 1);
  eq('…left other chats alone', store.getDraft(q1).status, 'queued');
  eq('updateDraftsWhere with an empty form list touches nothing', store.updateDraftsWhere({ chatForms: [], statuses: ['queued'] }, { status: 'cancelled' }), 0);
  throws('updateDraftsWhere cannot re-key a chat', () => store.updateDraftsWhere({ statuses: ['queued'] }, { chatJid: BOB }), /no writable field/);
  eq('listDrafts filters', store.listDrafts({ chatJid: ALICE }).map(d => d.id), [dm]);
  const del = store.insertDraft({ ...base, chatJid: BOB, chatKind: 'dm', status: 'dropped' });
  db.prepare('DELETE FROM mind_proactive WHERE id = ?').run(del);
  check('a deleted max draft id is never reused', store.insertDraft({ ...base, chatJid: BOB, chatKind: 'dm', status: 'dropped' }) > del);
  throws('bad status throws', () => store.insertDraft({ ...base, status: 'posted' }), /one of/);
}

// ── exclusions ─────────────────────────────────────────────────────────────
section('mind_exclusions (detected → owner_cleared → reopened by a newer message)');
{
  const det = store.upsertDetected({ jid: BOB, msgId: 'mx1', msgTs: clock.now() - 50, p: null });
  eq('detected inserted (p null = fail closed)', [det.action, store.getExclusion(det.id).source, store.getExclusion(det.id).p], ['inserted', 'detected', null]);
  eq('exclusionsFor finds it', store.exclusionsFor([BOB, 'x@s.whatsapp.net']).length, 1);
  throws('owner.removeExclusion needs an owner', () => store.owner.removeExclusion(det.id, 'mind'), /owner/);
  eq('removing a detected row clears it (kept)', store.owner.removeExclusion(det.id, OWNER).action, 'cleared');
  const cleared = store.getExclusion(det.id);
  eq('…owner_cleared with cleared_at', [cleared.source, cleared.clearedAt], ['owner_cleared', clock.now()]);
  eq('an owner_cleared row does not exclude', store.exclusionsFor([BOB]).length, 0);
  eq('…but exclusionRows still shows it', store.exclusionRows([BOB]).length, 1);
  eq('the same old message does not re-create it', store.upsertDetected({ jid: BOB, msgId: 'mx1', msgTs: clock.now() - 50 }).action, 'kept');
  eq('a hit without a message time does not reopen it', store.upsertDetected({ jid: BOB, msgId: 'mx2' }).action, 'kept');
  clock.advance({ seconds: 10 });
  eq('a newer message reopens it', store.upsertDetected({ jid: BOB, msgId: 'mx3', msgTs: clock.now(), p: 0.9 }).action, 'reopened');
  eq('…detected again', store.exclusionsFor([BOB])[0].source, 'detected');

  const o = store.owner.addExclusion({ kind: 'group', jid: G, note: 'family group' }, OWNER);
  eq('owner exclusion added', store.getExclusion(o.id).source, 'owner');
  eq('a detection never downgrades an owner row', store.upsertDetected({ kind: 'group', jid: G, msgId: 'mz', msgTs: clock.now() }).action, 'kept');
  eq('owner add over a detected row upgrades it', store.getExclusion(store.owner.addExclusion({ kind: 'person', jid: BOB }, OWNER).id).source, 'owner');
  eq('removing an owner row deletes it', store.owner.removeExclusion(o.id, OWNER).action, 'deleted');
  eq('…gone', store.getExclusion(o.id), null);
  throws('addExclusion validates kind', () => store.owner.addExclusion({ kind: 'everyone', jid: 'x' }, OWNER), /person\|group/);
  eq('listExclusions', store.listExclusions().length, 1);
}

// ── identity: merge / record / reassign ────────────────────────────────────
section('rekey: merge and record re-key rows (incl. origins_json)');
{
  const KEEP = '82001@lid';
  const DROP = '15550002001@s.whatsapp.net';
  const dk = store.localDateKey(clock.now());
  store.bumpActivity(KEEP, dk, { msgs: 2, humanMsgs: 2, lastHumanAt: 100 });
  store.bumpActivity(DROP, dk, { msgs: 3, humanMsgs: 1, lastHumanAt: 300 });
  store.bumpActivity(DROP, '2026-10-01', { msgs: 1 });
  const dd = store.insertDigest({ chatJid: DROP, originKind: 'dm', fromRowid: 0, toRowid: 40, periodStart: 1, periodEnd: 2, summary: 's', tone: 'neutral' });
  store.setEpisodeCursor(KEEP, { lastRowid: 10, lastNightKey: '2026-10-20' });
  store.setEpisodeCursor(DROP, { lastRowid: 50, lastNightKey: '2026-10-25' });
  store.logEpisodeNight(DROP, '2026-10-25', { outcome: 'fenced', cause: 'forget' });
  store.logEpisodeNight(KEEP, '2026-10-25', { outcome: 'deleted', cause: 'revoke' });
  const el = store.insertElement({ kind: 'intention', intentionKind: 'check_in', targetChat: DROP, expiresAt: clock.now() + DAY,
    origins: [{ originJid: DROP, minLearnedAt: 500 }, { originJid: KEEP, minLearnedAt: 400 }] });
  const dq = store.insertDraft({ chatJid: DROP, chatKind: 'dm', personJid: DROP, kind: 'check_in', basis: [{ digestId: dd, today: true }],
    origins: [{ originJid: DROP, minLearnedAt: 1 }], mode: 'live', status: 'queued' });
  const kq = store.insertDraft({ chatJid: KEEP, chatKind: 'dm', personJid: KEEP, kind: 'check_in', basis: [{ digestId: dd, today: true }],
    origins: [{ originJid: KEEP, minLearnedAt: 1 }], mode: 'live', status: 'queued' });
  store.upsertDetected({ jid: DROP, msgId: 'q1', p: 0.8 });
  store.owner.addExclusion({ kind: 'person', jid: KEEP }, OWNER);
  db.prepare(`UPDATE mind_exclusions SET source = 'owner_cleared', cleared_at = 1 WHERE jid = ?`).run(KEEP);

  const res = store.rekey({ type: 'merge', keepJid: KEEP, dropJid: DROP });
  check('merge reports counts', res.type === 'merge' && res.digests === 1);
  const act = store.activityFor('2026-01-01').filter(a => a.chatJid === KEEP);
  eq('activity: clash summed, other day moved', act.map(a => [a.dayKey, a.msgs, a.humanMsgs, a.lastHumanAt]).sort(),
    [['2026-10-01', 1, 0, null], [dk, 5, 3, 300]].sort());
  eq('no rows left under the dropped form', db.prepare(`SELECT
      (SELECT COUNT(*) FROM mind_chat_activity WHERE chat_jid = ?) + (SELECT COUNT(*) FROM mind_digests WHERE chat_jid = ?)
    + (SELECT COUNT(*) FROM mind_episode_cursor WHERE chat_jid = ?) + (SELECT COUNT(*) FROM mind_episode_log WHERE chat_jid = ?)
    + (SELECT COUNT(*) FROM mind_proactive WHERE chat_jid = ? OR person_jid = ?) + (SELECT COUNT(*) FROM mind_exclusions WHERE jid = ?)`)
    .pluck().get(DROP, DROP, DROP, DROP, DROP, DROP, DROP), 0);
  eq('digest re-keyed', store.getDigest(dd).chatJid, KEEP);
  const cur = store.getEpisodeCursor(KEEP);
  eq('cursor: the larger values kept', [cur.lastRowid, cur.digestRowid, cur.lastNightKey], [50, 40, '2026-10-25']);
  eq('episode log: the fenced (never-rebuild) outcome wins', store.episodeNight(KEEP, '2026-10-25').outcome, 'fenced');
  const e2 = store.getElement(el);
  eq('element target + origins_json re-keyed (merged with the earlier floor)', [e2.targetChat, e2.origins],
    [KEEP, [{ originJid: KEEP, minLearnedAt: 400 }]]);
  eq("the dropped form's queued draft is dropped (one queued per chat)", [store.getDraft(dq).status, store.getDraft(dq).dropReason, store.getDraft(dq).chatJid],
    ['dropped', 'identity_changed', KEEP]);
  eq('the kept queued draft stays queued', store.getDraft(kq).status, 'queued');
  eq('exclusion moved; the stronger source wins', store.exclusionRows([KEEP]).map(x => x.source), ['detected']);

  // record: a raw form bound to an existing person.
  const RAW = '15550003001@s.whatsapp.net';
  const PERSON = '83001@lid';
  const rd = store.insertDraft({ chatJid: RAW, chatKind: 'dm', personJid: RAW, kind: 'follow_up', basis: [{ digestId: dd, thread: 1 }],
    origins: [{ originJid: RAW, minLearnedAt: 7 }, { originJid: G, minLearnedAt: 3 }], mode: 'shadow', status: 'shadow' });
  store.bumpActivity(RAW, dk, { msgs: 1 });
  store.rekey({ type: 'record', jid: RAW, personJid: PERSON });
  const r2 = store.getDraft(rd);
  eq('record: draft chat/person/origins re-keyed', [r2.chatJid, r2.personJid, r2.origins.map(o => o.originJid)], [PERSON, PERSON, [PERSON, G]]);
  eq('record: activity re-keyed', store.activityFor(dk).some(a => a.chatJid === PERSON), true);
  eq('record onto itself is a no-op', store.rekey({ type: 'record', jid: PERSON, personJid: PERSON }).activity, 0);
  throws('unknown change type throws', () => store.rekey({ type: 'swap' }), /unknown change/);
}

section('rekey: reassign deletes DM rows, drops queued drafts, copies exclusions');
{
  const PN = '15550004001@s.whatsapp.net';
  const PREV = '84001@lid';
  const NEW = '84002@lid';
  const dk = store.localDateKey(clock.now());
  store.bumpActivity(PN, dk, { msgs: 4 });
  const pd = store.insertDigest({ chatJid: PN, originKind: 'dm', fromRowid: 0, toRowid: 3, periodStart: 1, periodEnd: 2, summary: 's', tone: 'sad',
    evidence: [{ msgId: 'pm1', ts: 1 }] });
  store.setEpisodeCursor(PN, { lastRowid: 3 });
  store.logEpisodeNight(PN, '2026-10-25', { outcome: 'written', memoryId: 77 });
  const pq = store.insertDraft({ chatJid: PN, chatKind: 'dm', personJid: PN, kind: 'check_in', basis: [{ digestId: pd, today: true }],
    origins: [{ originJid: PN, minLearnedAt: 1 }], mode: 'live', status: 'queued', voicedText: 'hey, all ok?', intent: 'check in' });
  const ps = store.insertDraft({ chatJid: PN, chatKind: 'dm', personJid: PN, kind: 'check_in', basis: [{ digestId: pd, today: true }],
    origins: [{ originJid: PN, minLearnedAt: 1 }], mode: 'live', status: 'sent', voicedText: 'old opener' });
  const pe = store.insertElement({ kind: 'intention', intentionKind: 'check_in', targetChat: PN, expiresAt: clock.now() + DAY });
  store.upsertDetected({ jid: PN, msgId: 'stop1', p: 0.7 });
  db.prepare(`INSERT INTO dashboard_audit (actor, action, target, payload_json) VALUES ('system:identity', 'identity.reassign', ?, ?)`)
    .run(PN, JSON.stringify({ from: PREV, to: NEW, source: 'sync' }));

  const res = store.rekey({ type: 'reassign', jid: PN, personJid: NEW });
  eq('queued draft → dropped:identity_changed, text nulled', [store.getDraft(pq)?.status, store.getDraft(pq)?.dropReason, store.getDraft(pq)?.voicedText, store.getDraft(pq)?.intent],
    ['dropped', 'identity_changed', null, null]);
  eq('other DM-keyed draft rows deleted', store.getDraft(ps), null);
  eq('activity / digest / cursor / episode log deleted', [store.activityFor(dk).some(a => a.chatJid === PN), store.getDigest(pd),
    store.getEpisodeCursor(PN), store.episodeNight(PN, '2026-10-25')], [false, null, null, null]);
  eq("the digest's evidence rows are gone too", store.digestEvidence(pd).length, 0);
  eq('self-state element targeting it superseded', store.getElement(pe).status, 'superseded');
  eq('the exclusion is copied to both people (and kept on the number)', [PN, PREV, NEW].map(j => store.exclusionsFor([j]).length), [1, 1, 1]);
  check('reassign counts', res.dropped === 1 && res.exclusionsCopied === 2, res);
}

// ── deleteDmRows (purge) ───────────────────────────────────────────────────
section('deleteDmRows (purge primitive; errors propagate)');
{
  const P = '85001@lid';
  const PF = '15550005001@s.whatsapp.net';
  const dk = store.localDateKey(clock.now());
  store.bumpActivity(PF, dk, { msgs: 1 });
  const dg = store.insertDigest({ chatJid: P, originKind: 'dm', fromRowid: 0, toRowid: 2, periodStart: 1, periodEnd: 2, summary: 's', tone: 'neutral' });
  store.insertDraft({ chatJid: P, chatKind: 'dm', personJid: P, kind: 'check_in', basis: [{ digestId: dg, today: true }],
    origins: [{ originJid: P, minLearnedAt: 1 }], mode: 'live', status: 'queued' });
  const pe = store.insertElement({ kind: 'mood', word: 'low', expiresAt: clock.now() + DAY, origins: [{ originJid: P, minLearnedAt: 1 }] });
  store.upsertDetected({ jid: P, msgId: 'n1', p: null });
  const counts = db.transaction(() => store.deleteDmRows(db, [P, PF]))();
  eq('rows of every form deleted', [counts.activity, counts.digests, counts.proactive], [1, 1, 1]);
  eq('element with the DM origin superseded', store.getElement(pe).status, 'superseded');
  eq('exclusions are kept on purge', store.exclusionsFor([P]).length, 1);
  throws('errors propagate (no try/catch)', () => store.deleteDmRows({ prepare() { throw new Error('boom'); } }, [P]), /boom/);
}

// ── nullFreeText ───────────────────────────────────────────────────────────
section('nullFreeText by chat');
{
  const G2 = '120363000000081002@g.us';
  const rG = store.insertRun({ kind: 'think', input: { labels: { C1: { chatJid: G } } } });
  store.finishRun(rG, { status: 'ok', output: { v: 1, note: 'about G', nudges: [{ knob: 'responseRate', value: 0.2, reason: 'G is lively' }],
    reach_out: [{ target: 'C1', reason: 'trip' }], mood: { word: 'calm', intensity: 0.3 } } });
  const rG2 = store.insertRun({ kind: 'think', input: { labels: { C1: { chatJid: G2 } } } });
  store.finishRun(rG2, { status: 'ok', output: { v: 1, note: 'about G2' } });
  const sm = store.insertSelfModel({ source: 'mind', status: 'proposed', text: 'x', rationale: 'because of G', runId: rG });
  const shadow = store.insertDraft({ chatJid: G, chatKind: 'group', kind: 'share', basis: [], origins: [{ originJid: G, minLearnedAt: 1 }],
    mode: 'shadow', status: 'would_send', intent: 'share the trip', voicedText: 'look at this', altText: 'alt', reason: 'r' });
  const fromOrigin = store.insertDraft({ chatJid: BOB, chatKind: 'dm', personJid: BOB, kind: 'follow_up', basis: [],
    origins: [{ originJid: G, minLearnedAt: 1 }], mode: 'shadow', status: 'shadow', intent: 'ask about G thread' });
  const res = store.nullFreeText({ chatForms: [G] });
  const out = store.getRun(rG).output;
  eq('free text nulled in runs that read the chat', [out.note, out.nudges[0].reason, out.reach_out[0].reason], [null, null, null]);
  eq('…structure and enums kept', [out.v, out.nudges[0].value, out.mood.word], [1, 0.2, 'calm']);
  eq('a run of another chat untouched', store.getRun(rG2).output.note, 'about G2');
  eq('self-model rationale of that run nulled', store.getSelfModel(sm).rationale, null);
  eq('proactive text of the chat nulled', [store.getDraft(shadow).intent, store.getDraft(shadow).voicedText, store.getDraft(shadow).altText], [null, null, null]);
  eq('…and of drafts whose origins name it', store.getDraft(fromOrigin).intent, null);
  eq('the queued draft is left for the caller to cancel', store.getDraft(q1).voicedText, 'so is saturday still on?');
  check('counts', res.runs >= 1 && res.selfModel === 1 && res.proactive >= 2, res);
  eq('no chat and no time → nothing', store.nullFreeText({}), { runs: 0, selfModel: 0, proactive: 0 });
}

// ── retention ──────────────────────────────────────────────────────────────
section('retention windows (incl. the 7-day free-text nulling)');
{
  const T = clock.now();
  const at = (days) => T - days * DAY;
  const run = (kind, days, output = { note: 'n' }) => {
    const id = store.insertRun({ kind, startedAt: at(days), dayKey: store.localDateKey(at(days)) });
    store.finishRun(id, { status: 'ok', output, finishedAt: at(days) });
    return id;
  };
  const glance31 = run('glance', 31);
  const glance29 = run('glance', 29);
  const think179 = run('think', 179);
  const think181 = run('think', 181);
  const think8 = run('think', 8, { note: 'old note', nudges: [{ reason: 'r' }] });
  const think6 = run('think', 6, { note: 'fresh note' });
  const stale = store.insertRun({ kind: 'sleep', startedAt: T - 7 * HOUR });
  store.bumpActivity(G, store.localDateKey(at(15)), { msgs: 1 });
  store.bumpActivity(G, store.localDateKey(at(13)), { msgs: 1 });
  const dOld = store.insertDigest({ chatJid: G, originKind: 'group', fromRowid: 100, toRowid: 101, periodStart: 1, periodEnd: 2, summary: 's',
    tone: 'neutral', createdAt: at(8), evidence: [{ msgId: 'old-ev', ts: 1 }] });
  const dNew = store.insertDigest({ chatJid: G, originKind: 'group', fromRowid: 101, toRowid: 102, periodStart: 1, periodEnd: 2, summary: 's',
    tone: 'neutral', createdAt: at(6) });
  const eOld = store.insertElement({ kind: 'mood', word: 'calm', createdAt: at(9), expiresAt: at(8), status: 'expired' });
  const eAct = store.insertElement({ kind: 'mood', word: 'calm', createdAt: at(9), expiresAt: T + DAY });
  const smRej = store.insertSelfModel({ source: 'mind', status: 'rejected', text: 'r', createdAt: at(91) });
  const smSup = store.insertSelfModel({ source: 'mind', status: 'superseded', text: 's', createdAt: at(91) });
  const smOldActive = store.insertSelfModel({ source: 'mind', status: 'superseded', text: 'was active', createdAt: at(200), activatedAt: at(199) });
  const smRat = store.insertSelfModel({ source: 'mind', status: 'proposed', text: 'p', rationale: 'why', createdAt: at(8) });
  const nOld = store.insertNudge({ knob: 'reactTendency', scope: 'global', prevValue: 1, value: 1.1, requested: 1.1, band: {}, status: 'expired', active: false, createdAt: at(181) });
  const pOld = store.insertDraft({ chatJid: BOB, chatKind: 'dm', kind: 'follow_up', basis: [], origins: [], mode: 'shadow', status: 'shadow', createdAt: at(91) });
  const pSent = store.insertDraft({ chatJid: BOB, chatKind: 'dm', kind: 'follow_up', basis: [], origins: [], mode: 'live', status: 'sent',
    voicedText: 'sent text', intent: 'i', reason: 'r', createdAt: at(8), audience: { members: [BOB] } });
  const pDrop = store.insertDraft({ chatJid: BOB, chatKind: 'dm', kind: 'follow_up', basis: [], origins: [], mode: 'shadow', status: 'would_send',
    voicedText: 'unsent', altText: 'alt', createdAt: at(8), audience: { members: [BOB] } });
  const pFresh = store.insertDraft({ chatJid: '120363000000081009@g.us', chatKind: 'group', kind: 'share', basis: [], origins: [], mode: 'live',
    status: 'queued', voicedText: 'queued text', createdAt: T - 60, audience: { members: [ALICE] } });
  db.prepare(`INSERT INTO mind_episode_log (chat_jid, night_key, outcome, updated_at) VALUES (?, '2026-09-01', 'written', ?)`).run(G, at(31));
  db.prepare(`INSERT INTO mind_nights (night_key, status) VALUES ('2025-09-01', 'done')`).run();

  const out = store.retention(T);
  eq('a run left running > 6 h is failed', [store.getRun(stale).status, store.getRun(stale).error], ['failed', 'stale_running']);
  eq('glance runs: 30 d', [store.getRun(glance31), !!store.getRun(glance29)], [null, true]);
  eq('think runs: 180 d', [!!store.getRun(think179), store.getRun(think181)], [true, null]);
  eq('free text nulled after 7 d', [store.getRun(think8).output.note, store.getRun(think8).output.nudges[0].reason, store.getRun(think6).output.note],
    [null, null, 'fresh note']);
  eq('activity: 14 d', store.activityFor('2000-01-01').filter(a => a.chatJid === G).map(a => a.dayKey).includes(store.localDateKey(at(15))), false);
  eq('digests: 7 d (+ their evidence)', [store.getDigest(dOld), !!store.getDigest(dNew), store.digestEvidence(dOld).length], [null, true, 0]);
  eq('self-state: non-active after 7 d', [store.getElement(eOld), !!store.getElement(eAct)], [null, true]);
  eq('self-model: rejected / never-active superseded after 90 d; once-active kept', [store.getSelfModel(smRej), store.getSelfModel(smSup), !!store.getSelfModel(smOldActive)],
    [null, null, true]);
  eq('self-model rationale nulled after 7 d', store.getSelfModel(smRat).rationale, null);
  eq('nudges: 180 d', store.getNudge(nOld), null);
  eq('proactive: 90 d', store.getDraft(pOld), null);
  eq('sent: text kept, reason/intent nulled, audience nulled', [store.getDraft(pSent).voicedText, store.getDraft(pSent).intent, store.getDraft(pSent).audience],
    ['sent text', null, null]);
  eq('unsent: voiced/alt nulled after 7 d', [store.getDraft(pDrop).voicedText, store.getDraft(pDrop).altText, store.getDraft(pDrop).audience], [null, null, null]);
  eq('queued: untouched (audience kept while pending)', [store.getDraft(pFresh).voicedText, !!store.getDraft(pFresh).audience], ['queued text', true]);
  eq('episode log: 30 d', db.prepare(`SELECT COUNT(*) FROM mind_episode_log WHERE night_key = '2026-09-01'`).pluck().get(), 0);
  eq('nights: 400 d', store.getNight('2025-09-01'), null);
  check('retention reports counts', out.digests >= 1 && out.runs >= 2, out);
  eq('selfCheck reads every table', store.selfCheck(), true);
}

// ── static: no 006 provenance SQL, no text in logs ─────────────────────────
section('static');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src/mind/store.js'), 'utf-8');
  check('no SQL on the 006 provenance tables', !/\b(?:FROM|JOIN|INTO|UPDATE)\s+(memories|nicknames|relationships|person_facets|slang)\b/i.test(src));
  check('item_evidence is touched only for mind_digest rows', [...src.matchAll(/item_evidence[^`]*/g)].every(m => /mind_digest/.test(m[0]) || /^item_evidence (rows|as)/.test(m[0]) || !/(INSERT|DELETE|SELECT)/.test(m[0])));
  check('the store never logs', !/\blogger\b/.test(src));
}

report();
