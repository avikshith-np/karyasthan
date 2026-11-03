// T019 — src/mind/think.js + src/mind/glance.js budget and failure behaviour (research R3,
// R4, R23; FR-035, SC-003): callRole skips (budget / no_key / disabled) → the think is
// skipped and sleep still writes episodes with a `partial` night; the REAL resolveRole
// chain for the mind role (fallback '' inherits the mouth's) → a fell-back run is
// recorded, its nudges refused, the dashboard shows a fell_back reminder; with
// LLM_MIND_FALLBACK_PROVIDER=none and no key the REAL callRole skips no_key without a
// network call; the 80 % reserve (think/draft stop, sleep still allowed); global
// headroom 70 % / 90 %; an unpriced mind model fails closed; a timed-out call counts
// its estimate; mind clerk calls stop at clerkMaxPerDay; every priced mind ledger row
// has cost_usd; a Jev BudgetError degrades the glance to code only; a reply turn built
// while the mind fails still gets the last valid self-state (no throw).
// Scratch DB, fake clock, stubbed models, no network.
import {
  setupScratchDb, fakeClock, fakeCallRole, fakeJev, jevNoul, jevChoice, blockNetwork, seedPerson, seedGroup, seedMessage,
  setBot, section, check, eq, report, DAY, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
const net = blockNetwork();
const { config } = await import('../../src/utils/config.js');
config.timezone = 'UTC';
for (const k of ['apiKey', 'anthropicApiKey', 'geminiApiKey', 'glmApiKey', 'openrouterApiKey']) {
  if (k in config.llm) config.llm[k] = '';
}
const store = await import('../../src/mind/store.js');
const clock = await import('../../src/mind/clock.js');
const think = await import('../../src/mind/think.js');
const glance = await import('../../src/mind/glance.js');
const digest = await import('../../src/mind/digest.js');
const sleep = await import('../../src/mind/sleep.js');
const selfState = await import('../../src/mind/selfState.js');
const levers = await import('../../src/mind/levers.js');
const knobsMod = await import('../../src/mind/knobs.js');
const hooks = await import('../../src/mind/hooks.js');
const usage = await import('../../src/brain/usage.js');
const { resolveRole } = await import('../../src/brain/roles.js');
const { callRole: realCallRole } = await import('../../src/brain/llm.js');
const skills = await import('../../src/skills/skillRunner.js');
const mind = await import('../../src/mind/index.js');

const REAL = Math.floor(Date.now() / 1000);
const fc = fakeClock(REAL);
clock.setClock(fc.fn);
await setBot();
await skills.loadSkills();
skills.setSkillEnabled('mind', true);
knobsMod.__setDepsForTest({ now: fc.fn });
hooks.__setDepsForTest({ now: fc.fn });

// ── seed: a group and a DM with fresh lines, an initialised mind ─────────────
const A = await seedPerson({ jid: '90901@lid', name: 'Avery' });
const B = await seedPerson({ jid: '90902@lid', name: 'Blake' });
const G = await seedGroup({ jid: '120363000000090901@g.us', name: 'Climbers', members: [A, B], at: REAL - 200 * DAY });
const BOT = '10000000000@s.whatsapp.net';
async function say(chat, sender, text, ts = fc.now() - 600) {
  const fromSelf = sender === BOT;
  const m = await seedMessage({ chat, sender, text, ts, fromSelf });
  store.bumpActivity(chat, clock.dayKey(ts), { msgs: 1, humanMsgs: fromSelf ? 0 : 1, botMsgs: fromSelf ? 1 : 0,
    ...(fromSelf ? { lastBotAt: ts } : { lastHumanAt: ts }) });
  return m;
}
await say(G, A, 'are we still on for the wall on saturday?', fc.now() - 3000);
await say(G, B, 'yes, I booked the slot at ten', fc.now() - 2900);
await say(A, A, 'did you see the new route grades?', fc.now() - 2000);
store.initFirstLive(fc.now() - DAY, 14);

const THINK_JSON = (extra = {}) => JSON.stringify({ v: 1, mood: { word: 'calm', intensity: 0.5 },
  nudges: [{ knob: 'reactTendency', scope: 'global', value: 1.2, ttl_hours: 12, reason: 'set responseRate to 1' }],
  next_think_in_minutes: 240, ...extra });

// A refreshDigests stand-in that stores one digest per chat (the clerk is test 03's).
function fakeRefresh() {
  const calls = [];
  return {
    calls,
    async fn(chats, runId) {
      calls.push({ chats: [...chats], runId });
      const results = [];
      for (const chatJid of chats) {
        const id = store.insertDigest({ chatJid, originKind: chatJid.endsWith('@g.us') ? 'group' : 'dm', fromRowid: 0,
          toRowid: 1, periodStart: fc.now() - 4000, periodEnd: fc.now() - 100, summary: 'climbing plans for the weekend',
          todayNote: 'a climbing slot is booked', tone: 'warm',
          threads: [{ k: 1, text: 'the saturday wall session', evidence: [], authors: [A] }], runId });
        results.push({ chatJid, status: 'ok', digestId: id });
      }
      return { results, calls: chats.length };
    },
  };
}

const think0 = { now: fc.fn, isMindOn: () => true, isDegraded: () => false };
function resetThink(extra = {}) {
  think.__setDepsForTest(null);
  think.__setDepsForTest({ ...think0, ...extra });
  store.patchState({ lastThinkAt: null, nextThinkAt: null });
}
const thinkRows = (status) => db.prepare(`SELECT * FROM mind_runs WHERE kind = 'think' ${status ? 'AND status = ?' : ''} ORDER BY id`)
  .all(...(status ? [status] : []));
function ledger({ role = 'mind', provider = 'anthropic', model = 'claude-opus-5-5', cost = null, source = 'table', ok = 1,
  status = 'ok', caller = 'mind.think', ts = REAL - 60 } = {}) {
  db.prepare(`INSERT INTO llm_usage (ts, role, provider, model, cost_usd, cost_source, ok, status, caller)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ts, role, provider, model, cost, source, ok, status, caller);
}
function clearLedger() { db.prepare('DELETE FROM llm_usage').run(); usage.__test.reset(); }
const savedGlobal = config.llm.monthlyBudgetUsd;
config.llm.monthlyBudgetUsd = 30;
config.roles.mind.budgetUsd = 10;

try {
  // ── callRole skips ──────────────────────────────────────────────────────────
  section('callRole skipped budget / no_key / disabled → think skipped, last state kept');
  {
    const prior = selfState.applyMood({ word: 'content', intensity: 0.6 }, { labelMap: {}, at: fc.now() - 60 });
    for (const reason of ['budget', 'no_key', 'disabled']) {
      const fake = fakeCallRole({ 'mind.think': () => ({ skipped: reason, text: null }) });
      const refresh = fakeRefresh();
      resetThink({ callRole: fake.fn, refreshDigests: refresh.fn });
      const r = await think.runThink('glance');
      const row = store.getRun(r.runId);
      check(`${reason}: skipped with skip_reason ${reason}`, r.status === 'skipped' && r.reason === reason && row?.status === 'skipped'
        && row.skipReason === reason, { r, row: row && { status: row.status, skipReason: row.skipReason } });
      check(`${reason}: last_think_at not set (no call was made), the earlier mood is still active`,
        store.getState().lastThinkAt == null && store.activeElements(fc.now()).some(e => e.id === prior && e.status === 'active'));
      if (reason !== 'budget') {
        const again = await think.runThink('glance');
        check(`${reason}: the next think skips early without a model call or a second row this hour`,
          again.status === 'skipped' && again.reason === reason && fake.callsFor('mind.think').length === 1 && !again.recorded);
      }
    }
  }

  section('sleep over budget → episodes still written, night partial (no reflection)');
  {
    const day = clock.nightKey(fc.now());
    const fake = fakeCallRole({
      'mind.episode': () => JSON.stringify({ v: 1, episode: 'They planned a climbing session for saturday morning.', tone: 'warm' }),
      'mind.sleep': () => { throw new Error('reflection must not be called over budget'); },
    });
    sleep.__setDepsForTest(null);
    sleep.__setDepsForTest({ now: fc.fn, isMindOn: () => true, callRole: fake.fn, candidateChats: () => [G],
      budgetOk: (kind) => think.mindBudgetOk(kind),
      selfModel: async () => ({ runSelfModel: async () => ({ status: 'not_due' }) }) });
    clearLedger();
    ledger({ cost: 10.5 });   // over the $10 mind budget
    usage.__test.reset();
    const r = await sleep.runSleep(day, 'night');
    const night = store.getNight(day);
    check('the night is done with partial budget', night?.status === 'done' && night.partial === 'budget', { r, night });
    check('the episode clerk ran, the reflection did not', fake.callsFor('mind.episode').length === 1 && fake.callsFor('mind.sleep').length === 0);
    check('an episode memory was written for the group', db.prepare(`SELECT COUNT(*) FROM memories WHERE category = 'episode' AND origin_jid = ?`)
      .pluck().get(G) === 1);
    sleep.__setDepsForTest(null);
    clearLedger();
  }

  // ── fell back (the real resolveRole chain) ──────────────────────────────────
  section('the real resolveRole chain: mind inherits the mouth fallback → fell_back recorded, nudges refused');
  {
    const saved = { ...config.roles.mind };
    const savedMouth = { ...config.roles.mouth };
    config.roles.mind.fallbackProvider = '';
    config.roles.mind.fallbackModel = '';
    config.roles.mouth.fallbackProvider = 'gemini';
    config.roles.mouth.fallbackModel = 'gemini-3.8-flash';
    const role = resolveRole('mind', config);
    check('resolveRole: mind primary anthropic, fallback = the mouth\'s gemini', role.provider === 'anthropic'
      && role.fallback?.provider === 'gemini' && role.chain.length === 2, role);
    const fake = fakeCallRole({ 'mind.think': () => ({ text: THINK_JSON(), fellBack: true, provider: 'gemini',
      model: 'gemini-3.8-flash', costUsd: 0.001, usage: { input: 3000, output: 400, cacheRead: 0, cacheWrite: 0 } }) });
    const refresh = fakeRefresh();
    resetThink({ callRole: fake.fn, refreshDigests: refresh.fn });
    knobsMod.__setDepsForTest({ now: fc.fn, isMindOn: () => true, isPaused: () => false });
    const r = await think.runThink('glance');
    const row = store.getRun(r.runId);
    check('think ok with fell_back = 1 and the fallback model recorded', r.status === 'ok' && row.fellBack === true
      && row.model === 'gemini-3.8-flash' && row.costUsd === 0.001, row && { status: row.status, fellBack: row.fellBack, model: row.model });
    const nudges = store.listNudges({ limit: 10 });
    check('its nudge was refused fell_back (never active)', nudges.length >= 1 && nudges[0].status === 'refused'
      && nudges[0].refuseReason === 'fell_back' && !store.activeNudges().length, nudges[0]);
    check('its mood still applied (pointer-only output)', store.activeElements(fc.now()).some(e => e.kind === 'mood' && e.runId === r.runId));
    check('the clerk refresh got the chats with new lines and this run id', refresh.calls[0]?.runId === r.runId
      && refresh.calls[0].chats.includes(G));
    const st = mind.getStatus();
    check('status reminders include fell_back (a code + fixed text)', st.reminders.some(x => x.code === 'fell_back' && typeof x.text === 'string'));
    const sys = fake.calls[0]?.system;
    check('the persona name is in the user message only (system = the static charter)', typeof sys === 'string'
      && !sys.includes(String((await import('../../src/utils/config.js')).getPersona().name || '\u0000')));
    Object.assign(config.roles.mind, saved);
    Object.assign(config.roles.mouth, savedMouth);
    knobsMod.__setDepsForTest({ now: fc.fn });
  }

  section('LLM_MIND_FALLBACK_PROVIDER=none and no key → the REAL callRole skips no_key, no network');
  {
    const saved = { ...config.roles.mind };
    config.roles.mind.fallbackProvider = 'none';
    config.roles.mind.fallbackModel = '';
    const role = resolveRole('mind', config);
    check('resolveRole: single-link chain', role.chain.length === 1 && role.fallback === null);
    resetThink({ callRole: (r, s, u, o) => realCallRole(r, s, u, o), refreshDigests: fakeRefresh().fn });
    const r = await think.runThink('glance');
    check('think skipped no_key', r.status === 'skipped' && r.reason === 'no_key', r);
    eq('no network call was attempted', net, []);
    const lrow = db.prepare(`SELECT status, caller FROM llm_usage WHERE role = 'mind' ORDER BY id DESC LIMIT 1`).get();
    check('the ledger has the no_key row with caller mind.think', lrow?.status === 'no_key' && lrow.caller === 'mind.think', lrow);
    Object.assign(config.roles.mind, saved);
    clearLedger();
  }

  // ── the gate (R23) ──────────────────────────────────────────────────────────
  section('mindBudgetOk: 80 % reserve, global headroom 70 / 90 %');
  {
    resetThink();
    clearLedger();
    check('empty ledger → every kind ok', ['think', 'draft', 'sleep', 'selfmodel'].every(k => think.mindBudgetOk(k).ok));
    ledger({ cost: 8.1 });
    usage.__test.reset();
    const t = think.mindBudgetOk('think');
    check('spent $8.1 of $10 → think stops (budget)', !t.ok && t.reason === 'budget', t);
    check('… draft stops too', think.mindBudgetOk('draft').reason === 'budget');
    check('… sleep and selfmodel are still allowed (the 20 % reserve)', think.mindBudgetOk('sleep').ok && think.mindBudgetOk('selfmodel').ok);
    config.mind.sleepReservePct = 10;
    check('sleepReservePct 10 → think allowed again at $8.1', think.mindBudgetOk('think').ok);
    config.mind.sleepReservePct = 20;
    ledger({ cost: 2 });
    usage.__test.reset();
    check('spent $10.1 → sleep stops too (role budget)', think.mindBudgetOk('sleep').reason === 'budget');
    clearLedger();
    ledger({ role: 'mouth', provider: 'gemini', model: 'gemini-3.8-flash', cost: 21, caller: 'reply' });
    usage.__test.reset();
    check('global $21 of $30 (70 %) → think/draft global_cap', think.mindBudgetOk('think').reason === 'global_cap'
      && think.mindBudgetOk('draft').reason === 'global_cap');
    check('… sleep allowed below 90 %', think.mindBudgetOk('sleep').ok);
    ledger({ role: 'mouth', provider: 'gemini', model: 'gemini-3.8-flash', cost: 6.1, caller: 'reply' });
    usage.__test.reset();
    check('global $27.1 (≥ 90 %) → sleep / selfmodel global_cap', think.mindBudgetOk('sleep').reason === 'global_cap'
      && think.mindBudgetOk('selfmodel').reason === 'global_cap');
    const fake = fakeCallRole({ 'mind.think': () => THINK_JSON() });
    resetThink({ callRole: fake.fn, refreshDigests: fakeRefresh().fn });
    const r = await think.runThink('glance');
    check('a think over the global headroom is skipped global_cap before any clerk or mind call', r.status === 'skipped'
      && r.reason === 'global_cap' && fake.calls.length === 0, r);
    clearLedger();
  }

  section('unpriced → fail closed; a timed-out call counts its estimate');
  {
    resetThink();
    usage.__test.setPrices({});
    check('no price for the mind primary → unpriced for every kind', ['think', 'sleep', 'draft', 'selfmodel']
      .every(k => think.mindBudgetOk(k).reason === 'unpriced'));
    usage.__test.setPrices(null);
    ledger({ provider: 'anthropic', model: 'some-new-model', source: 'unknown', cost: null });
    check('latest ok mind row unpriced (and still unpriced) → unpriced', think.mindBudgetOk('think').reason === 'unpriced');
    ledger({ provider: 'anthropic', model: 'claude-opus-5-5', source: 'table', cost: 0.05, ts: REAL - 30 });
    usage.__test.reset();
    check('a newer priced row clears it', think.mindBudgetOk('think').ok);
    const st = mind.getStatus();
    check('status gate ok', st.budget.gate === 'ok');
    clearLedger();
    ledger({ cost: 7.9 });
    usage.__test.reset();
    check('$7.9 spent → think ok', think.mindBudgetOk('think').ok);
    ledger({ cost: null, ok: 0, status: 'timeout', source: 'unknown', caller: 'mind.think' });
    const g = think.mindBudgetOk('think');
    check('+ one timed-out mind.think link (6000 × $20/M = $0.12 estimate) → budget', !g.ok && g.reason === 'budget'
      && Math.abs(g.spentUsd - 8.02) < 1e-6, g);
    clearLedger();
    usage.__test.setPrices({});
    resetThink();
    const st2 = mind.getStatus();
    check('status shows the unpriced reminder', st2.reminders.some(x => x.code === 'unpriced'));
    usage.__test.setPrices(null);
  }

  section('mind clerk calls stop at clerkMaxPerDay');
  {
    const saved = config.mind.clerkMaxPerDay;
    config.mind.clerkMaxPerDay = 2;
    for (let i = 0; i < 2; i++) {
      const id = store.insertRun({ kind: 'digest', startedAt: fc.now() - 100 });
      store.finishRun(id, { status: 'ok' });
    }
    const fake = fakeCallRole({ 'mind.digest': () => '{}' });
    digest.__setDepsForTest({ now: fc.fn, callRole: fake.fn });
    check('clerkBudgetLeft false at the cap', digest.clerkBudgetLeft() === false);
    const r = await digest.refreshClerkDigests([G, A], null);
    check('refreshClerkDigests: every chat skipped cap, no clerk call', r.calls === 0 && r.results.every(x => x.status === 'skipped'
      && x.reason === 'cap') && fake.calls.length === 0, r);
    config.mind.clerkMaxPerDay = saved;
    digest.__setDepsForTest(null);
  }

  section('every priced mind ledger row has cost_usd');
  {
    clearLedger();
    usage.recordUsage({ role: 'mind', provider: 'anthropic', model: 'claude-opus-5-5', caller: 'mind.think',
      usage: { input: 3000, output: 2500, cacheRead: 0, cacheWrite: 2000 }, ok: true, status: 'ok', latencyMs: 10 });
    usage.recordUsage({ role: 'mind', provider: 'gemini', model: 'gemini-3.8-flash', caller: 'mind.sleep', fellBack: true,
      usage: { input: 3000, output: 900 }, ok: true, status: 'ok', latencyMs: 10 });
    const rows = db.prepare(`SELECT cost_usd, cost_source FROM llm_usage WHERE role = 'mind' AND ok = 1`).all();
    check('priced rows (table) carry a non-null cost', rows.length === 2 && rows.every(r => r.cost_source !== 'unknown' && r.cost_usd > 0), rows);
    clearLedger();
  }

  // ── glance: Jev BudgetError → code only ─────────────────────────────────────
  section('glance: Jev BudgetError → code-only (degraded), still recorded ok');
  {
    const jev = fakeJev(() => ({ think_now: jevNoul(0.9), base_mood: jevChoice('calm'), reach_out: jevNoul(0.9) }));
    await jev.failBudget();
    glance.__setDepsForTest({ now: fc.fn, isMindOn: () => true, askJev: jev.fn, jevDisabled: () => false,
      life: async () => null });
    think.__setDepsForTest({ ...think0 });
    // an unanswered direct question older than 2 h → the code rule wants a think
    const Cq = await seedPerson({ jid: '90903@lid', name: 'Casey' });
    store.bumpActivity(Cq, clock.dayKey(fc.now()), { msgs: 1, humanMsgs: 1, openQuestions: 1, lastHumanAt: fc.now() - 3 * HOUR });
    store.patchState({ lastGlanceAt: null });
    const r = await glance.runGlance('tick');
    const row = store.getRun(r.runId);
    check('glance ok + degraded, run row degraded = 1', r.status === 'ok' && r.degraded === true && row.status === 'ok'
      && row.degraded === true, { r, row: row && { status: row.status, degraded: row.degraded } });
    check('code rule: an unanswered question > 2 h → wantThink; no reach-out', r.wantThink === true && r.lookForReachOut === false);
    check('Jev was asked once with caller mind.glance', jev.calls.length === 1 && jev.calls[0].caller === 'mind.glance');
    const state = JSON.stringify(jev.calls[0].state);
    check('the glance state has no names, no chat ids, no mood word, no message text', !/Avery|Blake|Climbers|@lid|@g\.us|saturday|climb/i.test(state)
      && !/"(word|mood)"/.test(state) && !/\b(calm|content|upbeat)\b/.test(state), state.slice(0, 400));
    jev.recover();
    const ok = await (async () => { fc.advance({ minutes: 50 }); return glance.runGlance('tick'); })();
    check('Jev healthy → not degraded; think_now 0.9 → wantThink; reach_out 0.9 × appetite 1 → lookForReachOut',
      ok.status === 'ok' && !ok.degraded && ok.wantThink && ok.lookForReachOut, ok);
    check('base_mood calm (confidence 1) → a base_mood element with no origins', store.activeElements(fc.now())
      .some(e => e.kind === 'base_mood' && e.word === 'calm' && (e.origins || []).length === 0));
    glance.__setDepsForTest(null);
  }

  // ── a reply turn while the mind is failing ──────────────────────────────────
  section('a reply turn built while the mind is over budget / failing → normal output, last valid self-state');
  {
    clearLedger();
    ledger({ cost: 50 });
    usage.__test.reset();
    const fake = fakeCallRole({ 'mind.think': () => { throw new Error('boom'); } });
    resetThink({ callRole: fake.fn, refreshDigests: fakeRefresh().fn });
    const r = await think.runThink('owner');
    check('the think is skipped (budget), nothing thrown', r.status === 'skipped' && r.reason === 'budget');
    const recall = await import('../../src/memory/recall.js');
    const aud = recall.resolveAudience({ chatJid: G, kind: 'group' });
    let line = null;
    let threw = false;
    try { line = mind.selfStateLine(aud, { chatJid: G, isGroup: true, track: false }); } catch { threw = true; }
    check('selfStateLine does not throw and still renders the last valid state', !threw && typeof line === 'string' && line.length > 0, line);
    let threw2 = false;
    try { mind.selfModelBlock({}); mind.replyLengthLine(G); mind.recentEpisodes(aud, {}); mind.selfStateNote({ line }); } catch { threw2 = true; }
    check('the other prompt surfaces never throw', !threw2);
    clearLedger();
  }

  eq('no network call in the whole file', net, []);
} catch (err) {
  check('harness error', false, err?.stack || String(err));
} finally {
  config.llm.monthlyBudgetUsd = savedGlobal;
  usage.__test.setPrices(null);
}

report();
