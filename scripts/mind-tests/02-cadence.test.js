// T020 — src/mind/cadence.js + the facade lifecycle (research R1, R3, R5, R13; FR-001–004,
// FR-007, FR-036, SC-004): a fake 24 h with life on, driven through a stub life.onTick →
// glances ≤ 20/day, ≥ 45 min apart, awake only; thinks ≤ thinkMaxPerDay with the 90-min
// gap; exactly one sleep at night; the onTick callback returns in < 1 ms (work deferred).
// A tick before startMind waits in the inbox. Life absent → the fallback timer (armed
// after 20 min, 15-min beats); the first tick cancels it. Life up but its skill off →
// the quiet-hours rule. A 3-day downtime → 1 glance + 1 catch-up sleep, earlier nights
// missed. The night PK blocks a second sleep; a failing sleep retries ≤ 3 times in its
// night. Pause stops runs, the pulse continues. The skill switched on at runtime →
// cursors re-seeded to MAX(rowid), first_enabled_at / review window set (not under
// DRY_RUN), proposals stay `proposed` (review window); a missing review state reads as
// review. Skill on→off cancels queued sends. A skipped scheduled think clears (or, on
// gap/cap, pushes) next_think_at; a skipped kind/reason is recorded ≤ 1 per hour.
// Scratch DB, fake clock, fake life/Jev/models/timers, no network.
import {
  setupScratchDb, fakeClock, fakeCallRole, fakeJev, fakeLife, jevNoul, jevChoice, blockNetwork, seedPerson, seedGroup,
  seedMessage, setBot, section, check, eq, report, DAY, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
const net = blockNetwork();
const { config } = await import('../../src/utils/config.js');
config.timezone = 'UTC';
config.sleepStartHour = 0;
config.sleepEndHour = 7;
const store = await import('../../src/mind/store.js');
const clock = await import('../../src/mind/clock.js');
const cadence = await import('../../src/mind/cadence.js');
const glance = await import('../../src/mind/glance.js');
const think = await import('../../src/mind/think.js');
const sleep = await import('../../src/mind/sleep.js');
const knobsMod = await import('../../src/mind/knobs.js');
const hooks = await import('../../src/mind/hooks.js');
const skills = await import('../../src/skills/skillRunner.js');
const mind = await import('../../src/mind/index.js');

const MIN = 60;
const REAL = Math.floor(Date.now() / 1000);
const D0 = Math.floor(REAL / DAY) * DAY + DAY;          // tomorrow 00:00 UTC
const fc = fakeClock(D0 + 6 * HOUR);                      // 06:00 UTC
clock.setClock(fc.fn);
await setBot();
await skills.loadSkills();
skills.setSkillEnabled('mind', true);
knobsMod.__setDepsForTest({ now: fc.fn });
hooks.__setDepsForTest({ now: fc.fn });

const A = await seedPerson({ jid: '92001@lid', name: 'Avery' });
const B = await seedPerson({ jid: '92002@lid', name: 'Blake' });
const G = await seedGroup({ jid: '120363000000092001@g.us', name: 'Runners', members: [A, B], at: REAL - 300 * DAY });
let n = 0;
const talk = (ts = fc.now() - 30) => seedMessage({ chat: G, sender: n++ % 2 ? A : B, text: `morning run plan ${n}`, ts });

// ── fakes ──────────────────────────────────────────────────────────────────
const awakeHour = (u) => { const h = new Date(u * 1000).getUTCHours(); return h >= 7 && h < 23; };
const life = fakeLife({ on: true, awake: awakeHour });
const jev = fakeJev(() => ({ think_now: jevNoul(0.9), base_mood: jevChoice('calm'), reach_out: jevNoul(0.1) }));
const models = fakeCallRole({
  'mind.think': () => JSON.stringify({ v: 1, mood: { word: 'calm', intensity: 0.4 } }),
  'mind.episode': () => JSON.stringify({ v: 1, episode: 'They planned the week of morning runs and a new route.', tone: 'warm' }),
  'mind.sleep': () => JSON.stringify({ v: 1, morning_mood: { word: 'content', intensity: 0.6 } }),
});
function fakeRefresh() {
  return async (chats, runId) => {
    const results = [];
    for (const chatJid of chats) {
      const id = store.insertDigest({ chatJid, originKind: 'group', fromRowid: 0, toRowid: 1, periodStart: fc.now() - HOUR,
        periodEnd: fc.now(), summary: 'running plans', tone: 'warm', threads: [], runId });
      results.push({ chatJid, status: 'ok', digestId: id });
    }
    return { results, calls: chats.length };
  };
}
const dispatched = [];
let sleepLife = null;
glance.__setDepsForTest({ now: fc.fn, askJev: jev.fn, jevDisabled: () => false, life: async () => null });
think.__setDepsForTest({ now: fc.fn, callRole: models.fn, refreshDigests: fakeRefresh(), life: async () => null });
sleep.__setDepsForTest({ now: fc.fn, callRole: models.fn, life: async () => sleepLife,
  selfModel: async () => ({ runSelfModel: async () => ({ status: 'not_due' }) }) });
function cadenceDeps(extra = {}) {
  cadence.__setDepsForTest({ now: fc.fn, life: () => life, dryRun: () => false,
    dispatchDue: async () => { dispatched.push(fc.now()); return { handled: [], sent: 0 }; }, ...extra });
}
cadenceDeps();

const runs = (kind, extra = '') => db.prepare(`SELECT id, kind, trigger, status, skip_reason AS skipReason, day_key AS dayKey,
  night_key AS nightKey, started_at AS startedAt FROM mind_runs WHERE kind = ? ${extra} ORDER BY id`).all(kind);
const realRuns = (kind) => runs(kind, `AND status != 'skipped'`);
async function tickAt(t) {
  fc.set(t);
  const ms = life.tick(null, { at: t });
  await cadence.idle();
  return ms;
}

try {
  // ── a tick before startMind waits ────────────────────────────────────────────
  section('a life tick before startMind waits in the inbox');
  {
    check('the cadence subscribed to the (fake) life onTick', life.subscribers() === 1);
    await tickAt(fc.now());
    check('no pass ran before startMind (drain is a no-op)', cadence.lastPassSummary() === null && store.getState().updatedAt == null);
    mind.startMind({ getSock: () => ({ user: null }) });
    await cadence.idle();
    const p = cadence.lastPassSummary();
    check('startMind → the waiting tick is drained: one pass, cursors seeded on the off→on edge', !!p && p.source === 'tick'
      && store.getState().updatedAt != null);
    check('the lazy first-live initialisation ran (DRY_RUN off for the cadence): first_enabled_at + window',
      store.getSettings().firstEnabledAt === fc.now() && store.reviewState().mode === 'window'
      && store.getSettings().reviewUntil === fc.now() + 14 * DAY);
  }

  // ── 24 h with life on ────────────────────────────────────────────────────────
  section('a fake 24 h with life on (15-min ticks)');
  {
    const start = D0 + 6 * HOUR + 15 * MIN;
    const durations = [];
    for (let t = start; t <= start + 25 * HOUR; t += 15 * MIN) {
      fc.set(t);
      if (awakeHour(t) && (t / (15 * MIN)) % 2 === 0) await talk(t - 60);
      durations.push(await tickAt(t));
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)];
    check(`the onTick callback returns fast (p95 ${p95.toFixed(3)} ms < 1 ms; the work is deferred)`, p95 < 1);
    const gl = realRuns('glance');
    const perDay = {};
    for (const r of gl) perDay[r.dayKey] = (perDay[r.dayKey] || 0) + 1;
    check('glances ≤ 20 per local day', Object.values(perDay).every(c => c <= 20) && gl.length > 10, perDay);
    check('glances only while awake', gl.every(r => awakeHour(r.startedAt)));
    const gaps = gl.slice(1).map((r, i) => r.startedAt - gl[i].startedAt);
    check('glances ≥ 45 min apart', gaps.every(g => g >= 45 * MIN), gaps.slice(0, 5));
    const th = realRuns('think');
    const tperDay = {};
    for (const r of th) tperDay[r.dayKey] = (tperDay[r.dayKey] || 0) + 1;
    check(`thinks ≤ thinkMaxPerDay (${config.mind.thinkMaxPerDay}) per day and at least one`, th.length >= 1
      && Object.values(tperDay).every(c => c <= config.mind.thinkMaxPerDay), tperDay);
    const tg = th.slice(1).map((r, i) => r.startedAt - th[i].startedAt);
    check('thinks ≥ 90 min apart', tg.every(g => g >= 90 * MIN), tg);
    check('the think got a glance trigger and the mind role', th.every(r => ['glance', 'scheduled', 'anchor'].includes(r.trigger))
      && models.callsFor('mind.think').every(c => c.role === 'mind'));
    const sl = realRuns('sleep');
    const night = clock.nightKey(D0 + 23 * HOUR + 30 * MIN);
    check('exactly one sleep in the 24 h, for the night, while asleep', sl.length === 1 && sl[0].nightKey === night
      && !awakeHour(sl[0].startedAt) && store.getNight(night)?.status === 'done', sl.map(r => [r.nightKey, r.status]));
    const skippedCap = runs('think', `AND status = 'skipped' AND skip_reason = 'cap'`);
    const capHours = new Set(skippedCap.map(r => Math.floor(r.startedAt / HOUR)));
    check('skipped (cap) think rows: at most one per hour', skippedCap.length === capHours.size
      && skippedCap.slice(1).every((r, i) => r.startedAt - skippedCap[i].startedAt >= HOUR));
    const morningGlance = gl.find(r => r.startedAt > sl[0].startedAt);
    check('the first glance after the night ran the morning reset (staged mood live at half intensity)', !!morningGlance
      && store.getRun(morningGlance.id)?.output?.morning?.mood === true
      && db.prepare(`SELECT COUNT(*) FROM mind_self_state WHERE kind = 'mood' AND word = 'content' AND intensity = 0.3
        AND created_at = ?`).pluck().get(morningGlance.startedAt) === 1);
    check('nothing was dispatched (no queued drafts)', dispatched.length === 0);
  }

  // ── the PK and retries ───────────────────────────────────────────────────────
  section('mind_nights PK blocks a second sleep; a failing sleep retries ≤ 3 in its night');
  {
    const night = clock.nightKey(D0 + 23 * HOUR + 30 * MIN);
    const again = await sleep.runSleep(night, 'night');
    eq('runSleep for a done night → already', again.status, 'already');
    // Next night: give the reflection something (a self life event) and make it fail.
    sleepLife = { isLifeOn: () => true, listEvents: () => [{ id: 1, type: 'meal', originKind: 'self', at: fc.now() - 600 }] };
    const failing = fakeCallRole({ 'mind.sleep': () => ({ text: null, status: 'error' }),
      'mind.episode': () => JSON.stringify({ v: 1, episode: null, tone: 'neutral' }) });
    sleep.__setDepsForTest({ callRole: failing.fn });
    const nightStart = D0 + DAY + 23 * HOUR + 30 * MIN;
    for (let t = nightStart; t <= nightStart + 2 * HOUR; t += 15 * MIN) await tickAt(t);
    const nk2 = clock.nightKey(nightStart);
    const rows = runs('sleep').filter(r => r.nightKey === nk2);
    check('exactly 3 attempts in that night, then exhausted', rows.length === 3 && store.getNight(nk2)?.attempts === 3
      && store.getNight(nk2)?.status === 'failed', rows.map(r => r.status));
    sleep.__setDepsForTest({ callRole: models.fn });
    sleepLife = null;
  }

  // ── 3-day downtime ───────────────────────────────────────────────────────────
  section('a 3-day downtime → 1 glance + 1 catch-up sleep; earlier nights missed');
  {
    const before = { g: realRuns('glance').length, s: realRuns('sleep').length };
    const back = D0 + 5 * DAY + 10 * HOUR;                  // 10:00, three nights later
    await talk(back - 120);
    await tickAt(back);
    const gl = realRuns('glance').length - before.g;
    const sl = realRuns('sleep').slice(before.s);
    const L = clock.nightKey(back);                          // the night that just ended
    check('one pass → exactly 1 glance and 1 sleep (trigger catchup, the latest finished night)', gl === 1 && sl.length === 1
      && sl[0].trigger === 'catchup' && sl[0].nightKey === L, { gl, sl: sl.map(r => [r.trigger, r.nightKey]) });
    const missed = db.prepare(`SELECT night_key FROM mind_nights WHERE status = 'missed' ORDER BY night_key`).pluck().all();
    check('the nights between the last sleep and the caught-up one are missed', missed.length >= 2
      && missed.every(k => k < L), missed);
    await tickAt(back + 15 * MIN);
    check('the next pass runs no further sleep', realRuns('sleep').length - before.s === 1);
  }

  // ── pause ────────────────────────────────────────────────────────────────────
  section('pause stops runs; the pulse continues');
  {
    mind.owner.setPaused(true, 'owner:test');
    const before = { g: realRuns('glance').length, t: realRuns('think').length, act: store.getState().lastRowid };
    let t = fc.now() + 2 * HOUR;
    store.patchState({ nextThinkAt: t - 60 });
    for (let i = 0; i < 4; i++, t += 15 * MIN) { await talk(t - 30); await tickAt(t); }
    check('no glance or think ran while paused', realRuns('glance').length === before.g && realRuns('think').length === before.t);
    check('the pulse kept scanning (cursor moved, activity counted)', store.getState().lastRowid > before.act);
    const pausedSkips = runs('glance', `AND status = 'skipped' AND skip_reason = 'paused'`);
    check('the paused glance skip is recorded once in that hour', pausedSkips.length === 1, pausedSkips.length);
    check('a skipped scheduled think (paused) cleared next_think_at', store.getState().nextThinkAt == null);
    mind.owner.setPaused(false, 'owner:test');
  }

  section('a skipped think on gap pushes next_think_at to now + gap');
  {
    const t = fc.now() + 10 * MIN;
    fc.set(t);
    store.patchState({ lastThinkAt: t - 10 * MIN, nextThinkAt: t - 60 });
    const r = await think.runThink('scheduled');
    check('skipped gap', r.status === 'skipped' && r.reason === 'gap');
    eq('next_think_at = now + thinkMinGapMinutes', store.getState().nextThinkAt, t + config.mind.thinkMinGapMinutes * MIN);
    const r2 = await think.runThink('scheduled');
    check('a second gap skip in the same hour writes no new row', r2.status === 'skipped' && !r2.recorded);
  }

  // ── fallback timer ───────────────────────────────────────────────────────────
  section('life absent → the fallback timer; the first tick cancels it');
  {
    mind.stopMind();
    const timers = { timeouts: [], intervals: [], cleared: [] };
    const absent = fakeLife({ on: false });
    cadence.__setDepsForTest(null);
    cadenceDeps({
      life: () => absent,
      setTimeout: (fn, ms) => { const h = { fn, ms, kind: 't' }; timers.timeouts.push(h); return h; },
      setInterval: (fn, ms) => { const h = { fn, ms, kind: 'i' }; timers.intervals.push(h); return h; },
      clearTimeout: (h) => timers.cleared.push(h),
      clearInterval: (h) => timers.cleared.push(h),
    });
    cadence.start({ getSock: () => null });
    check('start() arms only a 20-min boot timer', timers.timeouts.length === 1 && timers.timeouts[0].ms === 20 * 60_000
      && timers.intervals.length === 0);
    fc.set(fc.now() + 20 * MIN);
    timers.timeouts[0].fn();
    await cadence.idle();
    check('no tick within 20 min → a 15-min interval runs passes (and one ran now)', timers.intervals.length === 1
      && timers.intervals[0].ms === 15 * 60_000 && cadence.fallbackActive() && cadence.lastPassSummary()?.at === fc.now());
    fc.set(fc.now() + 15 * MIN);
    timers.intervals[0].fn();
    await cadence.idle();
    check('a fallback beat runs a pass', cadence.lastPassSummary()?.at === fc.now());
    absent.tick(null, { at: fc.now() });
    await cadence.idle();
    check('the first life tick clears the fallback interval', timers.cleared.includes(timers.intervals[0]) && !cadence.fallbackActive());
    // A tick before the boot timer fires cancels the boot timer instead.
    cadence.__setDepsForTest(null);
    timers.timeouts.length = 0; timers.cleared.length = 0;
    cadenceDeps({ life: () => absent, setTimeout: (fn, ms) => { const h = { fn, ms }; timers.timeouts.push(h); return h; },
      clearTimeout: (h) => timers.cleared.push(h), clearInterval: (h) => timers.cleared.push(h) });
    cadence.start({});
    absent.tick(null, { at: fc.now() });
    await cadence.idle();
    check('a tick before 20 min cancels the boot timer', timers.cleared.includes(timers.timeouts[0]));
  }

  section('life up but its skill off → the quiet-hours rule; life on → its schedule');
  {
    const off = fakeLife({ on: false, awake: () => true });
    cadence.__setDepsForTest({ life: () => off });
    check('life off: 03:00 asleep, 10:00 awake (quiet hours 0–7)', cadence.awakeAt(D0 + 3 * HOUR) === false && cadence.awakeAt(D0 + 10 * HOUR) === true);
    const onLife = fakeLife({ on: true, awake: () => false });
    cadence.__setDepsForTest({ life: () => onLife });
    check('life on: its isAwakeAt wins (asleep at 10:00)', cadence.awakeAt(D0 + 10 * HOUR) === false);
    cadence.__setDepsForTest({ life: () => life });
  }

  // ── skill edges ──────────────────────────────────────────────────────────────
  section('skill on→off cancels queued sends; off→on re-seeds the cursors to MAX(rowid)');
  {
    cadence.__setDepsForTest(null);
    cadenceDeps();
    cadence.start({});
    let t = fc.now() + HOUR;
    await tickAt(t);
    const q = store.insertDraft({ chatJid: G, chatKind: 'group', kind: 'share', basis: [], origins: [], mode: 'live', status: 'queued',
      sendAfter: t + HOUR });
    skills.setSkillEnabled('mind', false);
    await tickAt(t += 15 * MIN);
    await new Promise(r => setTimeout(r, 20));
    check('queued draft cancelled skill_off', store.getDraft(q).status === 'cancelled' && store.getDraft(q).dropReason === 'skill_off');
    const before = db.prepare(`SELECT COALESCE(SUM(msgs), 0) FROM mind_chat_activity`).pluck().get();
    for (let i = 0; i < 5; i++) await talk(t - 10 + i);
    await tickAt(t += 15 * MIN);
    eq('skill off → no pulse (activity unchanged)', db.prepare(`SELECT COALESCE(SUM(msgs), 0) FROM mind_chat_activity`).pluck().get(), before);
    skills.setSkillEnabled('mind', true);
    await tickAt(t += 15 * MIN);
    const maxRow = db.prepare('SELECT MAX(rowid) FROM messages').pluck().get();
    check('off→on: last_rowid re-seeded to MAX(rowid); the lines said while off were never scanned',
      store.getState().lastRowid === maxRow && db.prepare(`SELECT COALESCE(SUM(msgs), 0) FROM mind_chat_activity`).pluck().get() === before);
  }

  section('first enabled at runtime: not under DRY_RUN; the review window; a missing review state reads review');
  {
    for (const k of ['first_enabled_at', 'review_mode', 'review_until']) db.prepare('DELETE FROM mind_settings WHERE key = ?').run(k);
    eq('missing review state → review (no auto-apply)', [store.reviewState().mode, store.reviewState().autoActive], ['review', false]);
    cadence.__setDepsForTest({ dryRun: () => true });
    skills.setSkillEnabled('mind', false);
    let t = fc.now() + HOUR;
    await tickAt(t);
    skills.setSkillEnabled('mind', true);
    store.patchState({ lastGlanceAt: null });
    await talk(t + 10);
    await tickAt(t += 15 * MIN);
    check('DRY_RUN: the edge seeds cursors but leaves first_enabled_at unset', store.getSettings().firstEnabledAt == null);
    const ni = runs('glance', `AND status = 'skipped' AND skip_reason = 'not_initialised'`);
    check('… and runs are skipped not_initialised', ni.length >= 1);
    eq('status shows the not_initialised reminder', mind.getStatus().reminders.some(r => r.code === 'not_initialised'), true);
    {
      // Review fix: an OWNER_JIDS that resolves to nothing reads as unset in the facade.
      const savedOwners = config.ownerJids;
      config.ownerJids = ['typo'];
      const st = mind.getStatus();
      check('OWNER_JIDS=typo → status ownerJidsSet false + owner_jids_unset reminder',
        st.ownerJidsSet === false && st.reminders.some(r => r.code === 'owner_jids_unset'));
      let e = null;
      try { mind.owner.setProactiveMode('live', 'owner:test'); } catch (x) { e = x; }
      check('OWNER_JIDS=typo → setProactiveMode(live) refused 409 owner_jids_unset',
        e?.code === 'owner_jids_unset' && e?.http === 409 && store.getSettings().proactiveMode !== 'live');
      config.ownerJids = savedOwners;
    }
    // Audit fix: DRY_RUN switched off live (PATCH /api/config) with the skill left on
    // starts the first live day on the next pass — no off→on edge needed.
    cadence.__setDepsForTest({ dryRun: () => false });
    await tickAt(t += 15 * MIN);
    const s = store.getSettings();
    check('DRY_RUN off (skill left on): next pass sets first_enabled_at = now, review_until = now + 14 d, mode window', s.firstEnabledAt === t
      && s.reviewUntil === t + 14 * DAY && store.reviewState(t).mode === 'window');
    check('inside the window auto-apply is off (a sleep-time proposal stays proposed)', store.reviewState(t + DAY).autoActive === false
      && store.reviewState(t + 15 * DAY).autoActive === true);
  }

  section('facade: isMindActive, owner runNow refusals');
  {
    check('isMindActive: on, initialised, not paused, not degraded', mind.isMindActive() === true);
    fc.set(D0 + 8 * DAY + 3 * HOUR);   // asleep (life awake 7–23)
    let err = null;
    try { await mind.owner.runNow('glance', 'owner:test'); } catch (e) { err = e; }
    check('glance while asleep → OwnerError asleep 409', err?.code === 'asleep' && err?.http === 409, err?.code);
    fc.set(D0 + 8 * DAY + 12 * HOUR);
    err = null;
    try { await mind.owner.runNow('sleep', 'owner:test'); } catch (e) { err = e; }
    check('sleep while awake → OwnerError awake 409', err?.code === 'awake', err?.code);
    mind.owner.setPaused(true, 'owner:test');
    err = null;
    try { await mind.owner.runNow('think', 'owner:test'); } catch (e) { err = e; }
    check('think while paused → OwnerError paused 409', err?.code === 'paused', err?.code);
    mind.owner.setPaused(false, 'owner:test');
    const ok = await mind.owner.runNow('glance', 'owner:test');
    check('an owner glance runs through the queue → {ok, runId, status}', ok.ok && ok.runId > 0 && ok.status === 'ok', ok);
    skills.setSkillEnabled('mind', false);
    err = null;
    try { await mind.owner.runNow('think', 'owner:test'); } catch (e) { err = e; }
    check('skill off → skill_off', err?.code === 'skill_off');
    skills.setSkillEnabled('mind', true);
  }

  section('restart with the skill on: cursors resume (recent last pulse); a long gap or an observed off re-seeds');
  {
    const activity = () => db.prepare(`SELECT COALESCE(SUM(msgs), 0) FROM mind_chat_activity`).pluck().get();
    const epCursor = () => db.prepare(`SELECT COALESCE(MIN(last_rowid), 0) FROM mind_episode_cursor`).pluck().get();
    const bootAt = async (t) => { cadence.__setDepsForTest(null); cadenceDeps(); cadence.start({}); await tickAt(t); };
    let t = fc.now() + HOUR;
    skills.setSkillEnabled('mind', true);
    await tickAt(t);                                    // a live pass: last_tick_at = t
    const tickAtBefore = store.getState().lastTickAt;
    check('a pass with the skill on records last_tick_at', tickAtBefore === t);
    const cur = store.getState().lastRowid;
    const ep = epCursor();
    for (let i = 0; i < 4; i++) await talk(t + 60 + i);  // said while the process was down
    const before = activity();
    await bootAt(t += 20 * MIN);                        // pm2 restart 20 min later
    check('restart ≤ 6 h after the last pulse: the lines said while down are scanned (cursor resumed)',
      activity() === before + 4 && store.getState().lastRowid === db.prepare('SELECT MAX(rowid) FROM messages').pluck().get()
      && store.getState().lastRowid > cur);
    check('…and the episode cursors were not bumped to MAX', epCursor() === ep);

    // A long downtime is an off→on edge: history is never analysed in bulk.
    for (let i = 0; i < 3; i++) await talk(t + 60 + i);
    const before2 = activity();
    await bootAt(t += cadence.RESUME_MAX_GAP_SEC + HOUR);
    check('restart after a gap > 6 h: re-seeded to MAX, the old lines never scanned',
      activity() === before2 && store.getState().lastRowid === db.prepare('SELECT MAX(rowid) FROM messages').pluck().get());

    // An observed on→off clears last_tick_at, so the next boot re-seeds even soon after.
    skills.setSkillEnabled('mind', false);
    await tickAt(t += 15 * MIN);
    check('on→off clears last_tick_at', store.getState().lastTickAt == null);
    skills.setSkillEnabled('mind', true);
    for (let i = 0; i < 3; i++) await talk(t + 60 + i);
    const before3 = activity();
    await bootAt(t += 15 * MIN);
    check('boot after an observed off: re-seeded (the lines said while off never scanned)',
      activity() === before3 && store.getState().lastRowid === db.prepare('SELECT MAX(rowid) FROM messages').pluck().get());
    fc.set(t);
  }

  eq('no network call', net, []);
} catch (err) {
  check('harness error', false, err?.stack || String(err));
} finally {
  mind.stopMind();
  cadence.__setDepsForTest(null);
}

report();
