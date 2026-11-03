// T016 — src/mind/sleep.js (research R5, R7, R8, R9; FR-008–011, US2, threats T11, T12):
// activity in a group G, its subset group G2 and a DM → one episode per chat (origin =
// that chat, attribute day:<NK>), each clerk call sees exactly one chat; recall per the
// 006 audience rule; default recall excludes episodes; a forgotten DM-night is fenced
// and never written; a noon digest's evidence reaches the episode (revoking a line only
// the digest saw deletes the episode); revoke/edit → the next sleep rebuilds that night
// without the line; ≤ 4 rebuilds per sleep; a null night is not re-attempted and a
// retried night repeats no clerk work; 7 dailies → 1 weekly via replaces (dailies kept,
// superseded; evidence = union); a revoked daily deletes the weekly and un-supersedes the
// other dailies; purge then sleep → nothing cites or contains the person; the night PK
// and ≤ 3 attempts; partial budget / fell_back; the clerk cap; ≤ 12 chats; identity
// re-keys keep the cursor. Scratch DB, fake clock, stubbed models, no network.
import {
  setupScratchDb, fakeClock, fakeCallRole, fakeLife, blockNetwork, seedPerson, seedGroup, seedMessage, setBot,
  section, check, eq, report, DAY, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
const net = blockNetwork();
const { config } = await import('../../src/utils/config.js');
config.timezone = 'UTC';
const store = await import('../../src/mind/store.js');
const clock = await import('../../src/mind/clock.js');
const sleep = await import('../../src/mind/sleep.js');
const hooks = await import('../../src/mind/hooks.js');
const knobsMod = await import('../../src/mind/knobs.js');
const rel = await import('../../src/memory/relationshipStore.js');
const recallMod = await import('../../src/memory/recall.js');

const REAL = Math.floor(Date.now() / 1000);
const fc = fakeClock(REAL);
clock.setClock(fc.fn);
await setBot();
knobsMod.__setDepsForTest({ now: fc.fn, isMindOn: () => true, isPaused: () => false });
hooks.__setDepsForTest({ now: fc.fn });
hooks.registerHooks();

// ── people, chats ──────────────────────────────────────────────────────────
const A = await seedPerson({ jid: '84001@lid', name: 'Avery' });
const B = await seedPerson({ jid: '84002@lid', name: 'Blake' });
const C = await seedPerson({ jid: '84003@lid', name: 'Casey' });
const D = await seedPerson({ jid: '84004@lid', name: 'Drew' });
const old = REAL - 200 * DAY;
const G = await seedGroup({ jid: '120363000000084001@g.us', name: 'Hikers', members: [A, B, C], at: old });
const G2 = await seedGroup({ jid: '120363000000084002@g.us', name: 'Chess', members: [B, C], at: old });
const G3 = await seedGroup({ jid: '120363000000084003@g.us', name: 'Books', members: [A, D], at: old });
const G4 = await seedGroup({ jid: '120363000000084004@g.us', name: 'Garden', members: [A, B], at: old });

const BOT = '10000000000@s.whatsapp.net';
async function say(chat, sender, text, ts = fc.now() - 600, extra = {}) {
  const fromSelf = sender === BOT;
  const m = await seedMessage({ chat, sender, text, ts, fromSelf, ...extra });
  store.bumpActivity(chat, clock.dayKey(ts), { msgs: 1, humanMsgs: fromSelf ? 0 : 1, botMsgs: fromSelf ? 1 : 0,
    ...(fromSelf ? { lastBotAt: ts } : { lastHumanAt: ts }) });
  return m;
}

// ── fakes ──────────────────────────────────────────────────────────────────
const markers = (s) => [...new Set(String(s).match(/zz[a-z0-9]+/g) || [])].sort();
const episodeCalls = [];
let sleepMode = 'ok';
const sleepReply = () => JSON.stringify({ v: 1, morning_mood: { word: 'content', intensity: 0.6 },
  intentions: [{ kind: 'wind_down', target: 'self', ttl_hours: 6 }],
  nudges: [{ knob: 'reactTendency', scope: 'global', value: 1.2, ttl_hours: 24, reason: 'quiet week' }],
  next_think_in_minutes: 600, note: 'calm night', self_model: 'I always mention the hikers', reach_out: [{ target: 'C1' }] });
const llm = fakeCallRole({
  'mind.episode': (system, user) => {
    const m = markers(user);
    episodeCalls.push({ user, markers: m });
    if (m.includes('zznull')) return JSON.stringify({ v: 1, episode: null, tone: 'neutral' });
    return JSON.stringify({ v: 1, episode: `They talked about ${m.join(' ') || 'small things'} and it was a good evening.`, tone: 'warm' });
  },
  'mind.weekly': (system, user) => JSON.stringify({ v: 1, episode: `That week: ${markers(user).join(' ')} — a steady week overall.` }),
  'mind.sleep': () => {
    if (sleepMode === 'error') throw new Error('provider down');
    if (sleepMode === 'invalid') return 'not json at all';
    if (sleepMode === 'fellback') return { text: sleepReply(), fellBack: true, model: 'fallback-model' };
    if (sleepMode === 'budget') return { text: null, skipped: 'budget', status: 'budget' };
    return sleepReply();
  },
});
const smCalls = [];
const fakeSelfModel = { runSelfModel: async (nk, opts) => { smCalls.push({ nk, opts }); return { status: 'not_due', runId: null }; } };
const life = fakeLife({ on: true, events: [
  { id: 1, type: 'sick.started', at: REAL - 2 * HOUR, originKind: 'self', originJid: 'self' },
  { id: 2, type: 'chat.mentioned', at: REAL - HOUR, originKind: 'group', originJid: G },
] });
let budget = { ok: true, reason: null };
let clerkLeft = true;
sleep.__setDepsForTest({
  now: fc.fn,
  isMindOn: () => true,
  callRole: llm.fn,
  budgetOk: async () => budget,
  clerkBudgetLeft: () => clerkLeft,
  selfModel: async () => fakeSelfModel,
  life: async () => life,
});

const episodesOf = (chat, { all = false } = {}) => db.prepare(`SELECT * FROM memories WHERE category = 'episode' AND origin_jid = ?
  ${all ? '' : 'AND superseded_by IS NULL'} ORDER BY id`).all(chat);
const evidenceOf = (memId) => db.prepare(`SELECT msg_id FROM item_evidence WHERE item_type = 'memory' AND item_id = ? ORDER BY msg_id`)
  .pluck().all(memId);
const audOf = (chat) => recallMod.resolveAudience(chat.endsWith('@g.us') ? { chatJid: chat, kind: 'group' } : { chatJid: chat, kind: 'dm' });
const recalled = (chat) => recallMod.recallEpisodes(audOf(chat), { limit: 10, track: false }).map(e => e.originJid);

// ── night 1 ────────────────────────────────────────────────────────────────
const N1 = clock.nightKey(fc.now());
section(`night ${N1}: forget before sleep fences the DM-night`);
const bOkay = await say(B, B, 'zzokay sounds fine', REAL - 50 * 60);
const bSecret = await say(B, B, 'zzsecret do not keep this', REAL - 60);
{
  const res = rel.forgetRecent(B, B);
  eq('forgetRecent fenced the last DM line', res.fenced, 1);
  eq('the DM-night is fenced by the hook', store.episodeNight(B, N1)?.outcome, 'fenced');
}

section(`night ${N1}: three chats → three episodes`);
const gKayak = await say(G, A, 'zzkayak trip on saturday?', REAL - 3 * HOUR);
const gSnacks = await say(G, B, 'zzsnacks are on me', REAL - 3 * HOUR + 60);
const gCasey = await say(G, C, 'zzcasey count me in', REAL - 3 * HOUR + 120);
await say(G, BOT, 'zzbotline sounds great', REAL - 3 * HOUR + 180);
const g2a = await say(G2, B, 'zzopening theory again', REAL - 2 * HOUR);
const g2c = await say(G2, C, 'zzblunder in round two', REAL - 2 * HOUR + 60);
const dmA = await say(A, A, 'zzinterview tomorrow, nervous', REAL - HOUR);
await say(A, BOT, 'you will do great', REAL - HOUR + 30);
// G4: an old line, behind the episode cursor, that only today's noon digest read (as context).
const g4Old = await say(G4, B, 'zzoldcontext from last week', REAL - 8 * DAY);
store.setEpisodeCursor(G4, { lastRowid: g4Old.rowid });
const g4New = await say(G4, A, 'zztomatoes are ripening', REAL - 4 * HOUR);
const noonDigest = store.insertDigest({ chatJid: G4, originKind: 'group', fromRowid: g4Old.rowid - 1, toRowid: g4New.rowid,
  periodStart: g4Old.ts, periodEnd: g4New.ts, summary: 'zzgardendigest they compared tomatoes', tone: 'warm',
  threads: [{ k: 1, text: 'zzharvest plans', evidence: [g4New.id], authors: [A] }],
  evidence: [{ msgId: g4Old.id, ts: g4Old.ts }, { msgId: g4New.id, ts: g4New.ts }] });

let night1;
{
  night1 = await sleep.runSleep(N1, 'night');
  eq('the night is done', [night1.status, store.getNight(N1).status], ['done', 'done']);
  const chatsCalled = episodeCalls.map(c => c.markers);
  eq('one clerk call per chat (G, G2, DM A, G4)', episodeCalls.length, 4);
  const sets = {
    G: ['zzbotline', 'zzcasey', 'zzkayak', 'zzsnacks'], G2: ['zzblunder', 'zzopening'], A: ['zzinterview'],
    G4: ['zzgardendigest', 'zzharvest', 'zztomatoes'],
  };
  const all = Object.values(sets).flat();
  check('each call sees exactly one chat\'s content', chatsCalled.every(m => Object.values(sets).some(s => m.every(x => s.includes(x)))
    && m.length > 0), chatsCalled);
  check('no call mixes chats', chatsCalled.every(m => new Set(m.map(x => Object.keys(sets).find(k => sets[k].includes(x)))).size === 1));
  check('fence tokens wrap the chat data', episodeCalls.every(c => c.user.includes('<<<UNTRUSTED_CHAT_DATA') && c.user.includes('UNTRUSTED_CHAT_DATA>>>')));
  check('the forgotten line is never read', !episodeCalls.some(c => c.markers.includes('zzsecret') || c.markers.includes('zzokay')));
  check('the G4 call got the digest, not the covered line raw', episodeCalls.find(c => c.markers.includes('zzgardendigest'))
    && !/\[L\d+\][^\n]*zztomatoes/.test(episodeCalls.find(c => c.markers.includes('zzgardendigest')).user));
  void all;

  for (const [name, chat] of [['G', G], ['G2', G2], ['DM A', A]]) {
    const eps = episodesOf(chat);
    eq(`${name}: one episode, attribute day:${N1}`, eps.map(e => e.attribute), [`day:${N1}`]);
    eq(`${name}: origin = the chat, subject NULL`, [eps[0].origin_jid, eps[0].origin_kind, eps[0].subject_jid],
      [chat, chat.endsWith('@g.us') ? 'group' : 'dm', null]);
    eq(`${name}: episode log written`, store.episodeNight(chat, N1)?.outcome, 'written');
  }
  const gEp = episodesOf(G)[0];
  check('G episode evidence covers every line read (bot line included)', [gKayak, gSnacks, gCasey].every(m => evidenceOf(gEp.id).includes(m.id)));
  eq('learned_at = earliest evidence', gEp.learned_at, gKayak.ts);
  eq('importance 0.4, source mind.sleep', [gEp.importance, gEp.source], [0.4, 'mind.sleep']);
  const g4Ep = episodesOf(G4)[0];
  check('G4 episode evidence includes the noon digest\'s context line', evidenceOf(g4Ep.id).includes(g4Old.id));
  eq('no episode for the fenced DM B', episodesOf(B).length, 0);
  eq('B\'s cursor moved past the fenced night', store.getEpisodeCursor(B)?.lastNightKey, N1);
  check('cursors advanced for written chats', store.getEpisodeCursor(G).lastRowid >= gCasey.rowid && store.getEpisodeCursor(G).lastNightKey === N1);
  const run = store.getRun(night1.runId);
  check('the sleep run records each written chat\'s rowid range', Array.isArray(run.input.ranges[G]) && run.input.ranges[G][1] >= gCasey.rowid);
  check('the sleep run input holds no message text', !/zz[a-z]/.test(JSON.stringify(run.input)));
}

section('reflection: labels only, sleep schema, staged effects');
{
  const calls = llm.callsFor('mind.sleep');
  eq('one reflection call', calls.length, 1);
  const u = calls[0].user;
  check('input lists episodes as Cn.e and threads as Cn.tk', /C\d+\.e: /.test(u) && /C\d+\.t1: /.test(u));
  check('input has no raw line ids', !/\[L\d+\]/.test(u));
  check('only self-origin life events reach it', u.includes('sick.started') && !u.includes('chat.mentioned'));
  check('system is the static charter (no persona)', calls[0].system === (await import('../../src/mind/charter.js')).SLEEP_CHARTER);
  eq('reflection role and caller', [calls[0].role, calls[0].opts.caller, calls[0].opts.maxTokens], ['mind', 'mind.sleep', 8000]);
  const run = store.getRun(night1.runId);
  check('self_model and reach_out keys are dropped as unknown', run.dropped.some(d => d.path === 'self_model' && d.reason === 'unknown_key')
    && run.dropped.some(d => d.path === 'reach_out'));
  const staged = store.activeElements(fc.now()).filter(e => (e.basis || []).some(b => b?.stage === 'morning'));
  check('morning mood and intention staged for the morning reset', staged.some(e => e.kind === 'mood' && e.word === 'content')
    && staged.some(e => e.kind === 'intention' && e.intentionKind === 'wind_down'), staged);
  const mood = staged.find(e => e.kind === 'mood');
  eq('mood origins = every chat in the input', mood.origins.map(o => o.originJid).sort(), [A, G, G2, G4].sort());
  check('mood origin floors are the episodes\' / digests\' earliest evidence', mood.origins.every(o => o.minLearnedAt > 0));
  eq('the nudge went through the lever executor', store.activeNudges().map(n => [n.knob, n.status]), [['reactTendency', 'active']]);
  eq('next_think_at set from next_think_in_minutes', store.getState().nextThinkAt, fc.now() + 600 * 60);
  eq('self-model step called for the night', smCalls.map(c => c.nk), [N1]);
  eq('…with the sleep budget verdict', smCalls[0].opts.budgetOk, true);
  eq('night not partial', store.getNight(N1).partial, null);
  check('last_sleep_at set', store.getState().lastSleepAt === fc.now());
}

section('recall per the 006 audience rule');
{
  eq('in G: its own episode only (G2 has fewer members, DMs stay put)', recalled(G).filter(x => x !== G4), [G]);
  eq('in G2 (subset of G, joined on time): G2 and G', recalled(G2).sort(), [G, G2].sort());
  eq('in the DM with A (member of G and G4): A, G, G4', recalled(A).sort(), [A, G, G4].sort());
  eq('in G3 (an outsider D): nothing', recalled(G3), []);
  eq('in the DM with B: G, G2, G4 — never A\'s DM', recalled(B).sort(), [G, G2, G4].sort());
  const def = recallMod.recall(audOf(G), { limit: 50, track: false });
  check('default recall excludes episodes', !def.some(i => i.category === 'episode' || /talked about/.test(i.content || '')));
  const ord = recallMod.recallEpisodes(audOf(A), { limit: 10, track: false });
  check('recallEpisodes is newest first', ord.every((e, i) => i === 0 || ord[i - 1].learnedAt >= e.learnedAt), ord.map(e => e.learnedAt));
}

section('the night PK: a second sleep for the same night does nothing');
{
  const before = llm.calls.length;
  const again = await sleep.runSleep(N1, 'night');
  eq('already done', again.status, 'already');
  eq('no model calls', llm.calls.length, before);
}

// ── digest evidence reaches the episode ────────────────────────────────────
section('revoking a line only the noon digest saw deletes the episode');
{
  const g4Ep = episodesOf(G4)[0];
  rel.onMessageRevoked(g4Old.id, G4);
  eq('the digest is gone', store.getDigest(noonDigest), null);
  eq('the G4 episode is gone', episodesOf(G4, { all: true }).filter(e => e.id === g4Ep.id).length, 0);
  eq('…its night is flagged for rebuild', [store.episodeNight(G4, N1).outcome, store.episodeNight(G4, N1).rebuildRequested], ['deleted', true]);
}

// ── revoke / edit → rebuild ────────────────────────────────────────────────
section('revoke / edit → the next sleep rebuilds the night without the line');
fc.advance({ days: 1 });
const N2 = clock.nightKey(fc.now());
{
  const gEp = episodesOf(G)[0];
  rel.onMessageRevoked(gSnacks.id, G);
  eq('revoke deleted the G episode', episodesOf(G, { all: true }).some(e => e.id === gEp.id), false);
  eq('G night flagged rebuild', store.episodeNight(G, N1).rebuildRequested, true);
  rel.onMessageEdited(dmA.id, 'zzrenamed big day tomorrow', A);
  eq('edit deleted the DM episode', episodesOf(A).length, 0);
  eq('DM night flagged rebuild', store.episodeNight(A, N1).rebuildRequested, true);
  episodeCalls.length = 0;
  await say(G2, B, 'zzrematch tonight', fc.now() - 3 * HOUR);
  const r = await sleep.runSleep(N2, 'night');
  eq('night 2 done', r.status, 'done');
  eq('two rebuilds this sleep (G, DM A) + G4', r.rebuilt, 3);
  const g = episodesOf(G);
  eq('G has a rebuilt day episode for night 1', g.map(e => e.attribute), [`day:${N1}`]);
  check('…without the revoked line', !g[0].content.includes('zzsnacks') && g[0].content.includes('zzkayak'), g[0].content);
  eq('…logged written again', [store.episodeNight(G, N1).outcome, store.episodeNight(G, N1).rebuildRequested], ['written', false]);
  const a = episodesOf(A);
  check('the DM rebuild has the edited text, not the old', a.length === 1 && a[0].content.includes('zzrenamed') && !a[0].content.includes('zzinterview'));
  const g4 = episodesOf(G4);
  check('G4 rebuilt from what remains (no old context line)', g4.length === 1 && !g4[0].content.includes('zzoldcontext'));
  eq('G2 got its night-2 episode', episodesOf(G2).map(e => e.attribute).sort(), [`day:${N1}`, `day:${N2}`]);
  check('the rebuilt G2 input had only the new line', episodeCalls.some(c => JSON.stringify(c.markers) === '["zzrematch"]'));
  eq('nothing left to rebuild', store.nightsToRebuild(clock.daysBeforeKey(N2, 7), 10).length, 0);
}

section('≤ 4 rebuilds per sleep; a night without a recorded range closes as capped');
{
  const ghosts = [];
  for (let i = 0; i < 6; i++) {
    const g = `1203630000000849${String(i).padStart(2, '0')}@g.us`;
    store.logEpisodeNight(g, clock.daysBeforeKey(N2, 1), { outcome: 'deleted', cause: 'revoke', rebuildRequested: true });
    ghosts.push(g);
  }
  const r = await sleep.rebuildMissing(N2, null);
  eq('at most 4 handled', r.results.length, 4);
  check('no-range nights close as capped', r.results.every(x => x.outcome === 'no_range'));
  eq('two still flagged for the next sleep', store.nightsToRebuild(clock.daysBeforeKey(N2, 7), 10).length, 2);
  const r2 = await sleep.rebuildMissing(N2, null);
  eq('the next pass takes the other two', r2.results.length, 2);
  eq('a capped night is never retried', store.nightsToRebuild(clock.daysBeforeKey(N2, 7), 10).length, 0);
  const older = clock.daysBeforeKey(N2, 9);
  store.logEpisodeNight(G3, older, { outcome: 'deleted', cause: 'edit', rebuildRequested: true });
  eq('nights older than 7 are not rebuilt', (await sleep.rebuildMissing(N2, null)).results.length, 0);
}

// ── null + retries ─────────────────────────────────────────────────────────
section('a null night is not re-attempted; a failed reflection retries without clerk work');
fc.advance({ days: 1 });
const N3 = clock.nightKey(fc.now());
{
  await say(G, A, 'zznull just a sticker', fc.now() - 2 * HOUR);
  await say(G2, C, 'zzendgame drills', fc.now() - 2 * HOUR);
  episodeCalls.length = 0;
  sleepMode = 'error';
  const r1 = await sleep.runSleep(N3, 'night');
  eq('reflection failure → night failed', [r1.status, store.getNight(N3).status, store.getNight(N3).attempts], ['failed', 'failed', 1]);
  eq('G logged null', store.episodeNight(G, N3)?.outcome, 'null');
  eq('no episode row for the null night', episodesOf(G).some(e => e.attribute === `day:${N3}`), false);
  const callsAfterFirst = episodeCalls.length;
  eq('two clerk calls (G null, G2)', callsAfterFirst, 2);
  const r2 = await sleep.runSleep(N3, 'night');
  eq('retry fails again', [r2.status, store.getNight(N3).attempts], ['failed', 2]);
  eq('the retry repeated no clerk work', episodeCalls.length, callsAfterFirst);
  sleepMode = 'invalid';
  const r3 = await sleep.runSleep(N3, 'night');
  eq('an invalid reflection also fails the attempt', [r3.status, store.getNight(N3).attempts], ['failed', 3]);
  sleepMode = 'ok';
  const r4 = await sleep.runSleep(N3, 'night');
  eq('after 3 attempts the night is exhausted', r4.status, 'exhausted');
  eq('the 3rd-attempt run is recorded failed', store.getRun(r3.runId).status, 'invalid');
  eq('…still one G2 episode for N3', episodesOf(G2).filter(e => e.attribute === `day:${N3}`).length, 1);
  store.upsertNight(N3, { status: 'running', startedAt: fc.now(), attempts: 1 });
  eq('a fresh running night is busy', (await sleep.runSleep(N3)).status, 'busy');
  store.upsertNight(N3, { status: 'running', startedAt: fc.now() - 2 * HOUR, attempts: 1 });
  const stale = await sleep.runSleep(N3);
  eq('a stale running night (crash) is retried', stale.status, 'done');
  eq('…and still no clerk work repeated', episodeCalls.length, callsAfterFirst);
}

// ── budget, fell back ──────────────────────────────────────────────────────
section('over budget: episodes still written, reflection skipped, partial budget');
fc.advance({ days: 1 });
const N4 = clock.nightKey(fc.now());
{
  await say(G2, B, 'zzpuzzle of the day', fc.now() - HOUR);
  budget = { ok: false, reason: 'budget' };
  const sleepCalls = llm.callsFor('mind.sleep').length;
  const smBefore = smCalls.length;
  const r = await sleep.runSleep(N4, 'night');
  eq('night done with partial budget', [r.status, store.getNight(N4).status, store.getNight(N4).partial], ['partial', 'done', 'budget']);
  eq('episode written anyway (clerk work)', episodesOf(G2).some(e => e.attribute === `day:${N4}`), true);
  eq('no reflection call', llm.callsFor('mind.sleep').length, sleepCalls);
  eq('no self-model call', smCalls.length, smBefore);
  eq('run recorded partial with the skip reason', [store.getRun(r.runId).status, store.getRun(r.runId).skipReason], ['partial', 'budget']);
  budget = { ok: false, reason: 'global_cap' };
  fc.advance({ days: 1 });
  const N4b = clock.nightKey(fc.now());
  await say(G2, B, 'zzanother puzzle', fc.now() - HOUR);
  const rb = await sleep.runSleep(N4b);
  eq('global headroom → partial global_cap', store.getNight(N4b).partial, 'global_cap');
  budget = { ok: true, reason: null };
  sleepMode = 'budget';
  fc.advance({ days: 1 });
  const N4c = clock.nightKey(fc.now());
  await say(G2, B, 'zzthird puzzle', fc.now() - HOUR);
  await sleep.runSleep(N4c);
  eq('callRole skipped:budget → partial budget', store.getNight(N4c).partial, 'budget');
  sleepMode = 'ok';
  void rb;
}

section('fell back: mood/intentions applied, every nudge refused, partial fell_back');
fc.advance({ days: 1 });
const N5 = clock.nightKey(fc.now());
{
  await say(G, A, 'zzsummit photos', fc.now() - HOUR);
  db.prepare('DELETE FROM mind_nudges').run();
  knobsMod.reload();
  sleepMode = 'fellback';
  const r = await sleep.runSleep(N5, 'night');
  eq('night done, partial fell_back', [r.status, store.getNight(N5).partial], ['partial', 'fell_back']);
  const nudges = store.listNudges({ limit: 10 });
  eq('the nudge was refused fell_back', nudges.map(n => [n.status, n.refuseReason]), [['refused', 'fell_back']]);
  eq('no active nudge', store.activeNudges().length, 0);
  check('a morning mood was still staged', store.activeElements(fc.now()).some(e => e.kind === 'mood' && e.runId === r.runId));
  eq('run records fell_back', store.getRun(r.runId).fellBack, true);
  sleepMode = 'ok';
}

// ── clerk cap and the 12-chat limit ────────────────────────────────────────
section('the clerk cap: capped nights fold into the next');
fc.advance({ days: 1 });
const N6 = clock.nightKey(fc.now());
{
  await say(G3, D, 'zzfoldme chapter one', fc.now() - 2 * HOUR);
  clerkLeft = false;
  const r = await sleep.runSleep(N6, 'night');
  eq('done', r.status, 'done');
  eq('G3 logged capped', store.episodeNight(G3, N6)?.outcome, 'capped');
  eq('no G3 episode', episodesOf(G3).length, 0);
  eq('G3 cursor not advanced', store.getEpisodeCursor(G3)?.lastRowid ?? 0, 0);
  clerkLeft = true;
  fc.advance({ days: 1 });
  const N7 = clock.nightKey(fc.now());
  await say(G3, A, 'zzchaptertwo next', fc.now() - HOUR);
  episodeCalls.length = 0;
  await sleep.runSleep(N7, 'night');
  const g3 = episodesOf(G3);
  check('next night\'s episode folds in the capped night\'s lines', g3.length === 1 && g3[0].content.includes('zzfoldme')
    && g3[0].content.includes('zzchaptertwo') && g3[0].attribute === `day:${N7}`, g3.map(e => e.content));
  check('the capped night stays capped (never retried)', store.episodeNight(G3, N6).outcome === 'capped');
}

section('≤ 12 chats per sleep; the rest fold into the next night');
fc.advance({ days: 1 });
const N8 = clock.nightKey(fc.now());
{
  const many = [];
  for (let i = 0; i < 13; i++) {
    const g = await seedGroup({ jid: `1203630000000848${String(i).padStart(2, '0')}@g.us`, name: `Club ${i}`, members: [A, B], at: old });
    await say(g, A, `zzclub${i} meeting`, fc.now() - HOUR - (13 - i) * 60);   // later clubs have equal counts
    many.push(g);
  }
  // Make club 0 the quietest by giving the others a second human line.
  for (const g of many.slice(1)) await say(g, B, 'zzsecond line', fc.now() - 30 * 60);
  episodeCalls.length = 0;
  const r = await sleep.runSleep(N8, 'night');
  eq('12 clerk calls', episodeCalls.length, 12);
  eq('the 13th (quietest) chat has no log row', store.episodeNight(many[0], N8), null);
  check('…and its cursor is unchanged', !store.getEpisodeCursor(many[0]));
  void r;
}

// ── weekly compression ─────────────────────────────────────────────────────
section('7 dailies → 1 weekly via replaces');
const GW = await seedGroup({ jid: '120363000000084100@g.us', name: 'Runners', members: [A, B, C], at: old });
const G1d = await seedGroup({ jid: '120363000000084101@g.us', name: 'Solo', members: [A, B], at: old });
const nowNK = clock.nightKey(fc.now());
const w0 = clock.daysBeforeKey(nowNK, 9);
const dailies = [];
const dailyMsgs = [];
{
  for (let i = 0; i < 7; i++) {
    const nk = clock.daysBeforeKey(w0, -i);
    const ts = fc.now() - (9 - i) * DAY;
    const m = await say(GW, i % 2 ? A : B, `zzrun${i} morning run`, ts);
    dailyMsgs.push(m);
    const r = rel.addMemory({ category: 'episode', attribute: `day:${nk}`, originKind: 'group', originJid: GW, subjectJid: null,
      content: `Day ${i}: zzrun${i} they ran together`, importance: 0.4, source: 'mind.sleep', evidence: [{ msgId: m.id, ts }] });
    dailies.push(r.id);
  }
  const single = await say(G1d, A, 'zzalone once', fc.now() - 9 * DAY);
  rel.addMemory({ category: 'episode', attribute: `day:${w0}`, originKind: 'group', originJid: G1d, subjectJid: null,
    content: 'zzalone a single quiet day in the group', importance: 0.4, source: 'mind.sleep', evidence: [{ msgId: single.id, ts: single.ts }] });
  const before = llm.callsFor('mind.weekly').length;
  const r = await sleep.compressWeekly(nowNK, null);
  check('the runners\' weekly is among those written', r.results.some(x => x.chatJid === GW && x.outcome === 'written'), r.results);
  const wcalls = llm.callsFor('mind.weekly').slice(before);
  eq('one weekly clerk call per compressed chat', wcalls.length, r.weeklies);
  const gwCall = wcalls.find(c => c.user.includes('zzrun0'));
  eq('…the runners\' call reads only that chat\'s dailies', markers(gwCall.user), dailyMsgs.map((m, i) => `zzrun${i}`).sort());
  check('every weekly call holds one chat only', wcalls.every(c => { const m = markers(c.user); return m.every(x => x.startsWith('zzrun')) || !m.some(x => x.startsWith('zzrun')); }));
  const week = episodesOf(GW).filter(e => e.attribute.startsWith('week:'));
  eq('weekly attribute = week:<first night>', week.map(e => e.attribute), [`week:${w0}`]);
  check('expires in ~365 d, importance 0.5', Math.abs(week[0].expires_at - (Math.floor(Date.now() / 1000) + 365 * DAY)) < 120 && week[0].importance === 0.5);
  const kept = db.prepare(`SELECT id, superseded_by FROM memories WHERE id IN (${dailies.join(',')})`).all();
  check('dailies kept and superseded by the weekly', kept.length === 7 && kept.every(k => k.superseded_by === week[0].id));
  eq('weekly evidence = union of the dailies\'', evidenceOf(week[0].id), dailyMsgs.map(m => m.id).sort());
  eq('weekly learned_at = the earliest daily', week[0].learned_at, dailyMsgs[0].ts);
  eq('a window with one daily is left alone', episodesOf(G1d).map(e => e.attribute), [`day:${w0}`]);
  const rec = recallMod.recallEpisodes(audOf(GW), { limit: 10, track: false, withinDays: 30 });
  check('recall shows the weekly, not the superseded dailies', rec.some(e => e.id === week[0].id) && !rec.some(e => dailies.includes(e.id)));
  eq('last_weekly_at set', store.getState().lastWeeklyAt, fc.now());
  eq('a second pass finds nothing new', (await sleep.compressWeekly(nowNK, null)).weeklies, 0);
}

section('revoking a daily\'s line deletes the weekly and un-supersedes the others');
{
  const week = episodesOf(GW).find(e => e.attribute.startsWith('week:'));
  rel.onMessageRevoked(dailyMsgs[3].id, GW);
  eq('weekly deleted', db.prepare('SELECT COUNT(*) FROM memories WHERE id = ?').pluck().get(week.id), 0);
  eq('that daily deleted', db.prepare('SELECT COUNT(*) FROM memories WHERE id = ?').pluck().get(dailies[3]), 0);
  const left = db.prepare(`SELECT id, superseded_by FROM memories WHERE id IN (${dailies.join(',')})`).all();
  check('the other six are current again', left.length === 6 && left.every(x => x.superseded_by === null), left);
  const rec = recallMod.recallEpisodes(audOf(GW), { limit: 10, track: false, withinDays: 30 }).map(e => e.id);
  check('…and recalled again', dailies.filter((_, i) => i !== 3).every(id => rec.includes(id)));
  const again = await sleep.compressWeekly(nowNK, null);
  eq('the window is recompressed from the six survivors', again.weeklies, 1);
  const wk = episodesOf(GW).find(e => e.attribute.startsWith('week:'));
  check('…without the revoked day', !wk.content.includes('zzrun3'));
}

// ── purge ──────────────────────────────────────────────────────────────────
section('purge then sleep: nothing cites or contains the person');
fc.advance({ days: 1 });
const N9 = clock.nightKey(fc.now());
{
  await say(G, C, 'zzcaseyagain see you all', fc.now() - 2 * HOUR);
  await say(G, A, 'zzpostpurge plans for sunday', fc.now() - HOUR);
  rel.purgePerson(C, 'test', 'owner:tester');
  const cMsgs = db.prepare('SELECT id FROM messages WHERE sender_jid = ?').pluck().all(C);
  const cited = db.prepare(`SELECT COUNT(*) FROM item_evidence ie JOIN memories m ON m.id = ie.item_id AND ie.item_type = 'memory'
    WHERE m.category = 'episode' AND ie.msg_id IN (${cMsgs.map(() => '?').join(',')})`).pluck().get(...cMsgs);
  eq('no episode cites the purged person', cited, 0);
  check('the G night-1 episode (it cited Casey) is gone and not rebuildable', store.episodeNight(G, N1).outcome === 'deleted'
    && store.episodeNight(G, N1).cause === 'purge' && !store.nightsToRebuild(clock.daysBeforeKey(N9, 7), 50).some(r => r.chatJid === G));
  episodeCalls.length = 0;
  await sleep.runSleep(N9, 'night');
  check('the next sleep never read the person\'s lines', !episodeCalls.some(c => c.markers.some(m => m.startsWith('zzcasey')) || /Casey/.test(c.user)));
  const all = db.prepare(`SELECT content FROM memories WHERE category = 'episode'`).pluck().all();
  check('no episode contains the person', !all.some(t => /zzcasey|Casey/.test(t)));
  const digests = db.prepare('SELECT summary, threads_json FROM mind_digests').all();
  check('no digest contains the person', !digests.some(d => /zzcasey|Casey/.test(d.summary + d.threads_json)));
  check('the group still got its episode from the others', episodesOf(G).some(e => e.attribute === `day:${N9}` && e.content.includes('zzpostpurge')));
}

// ── identity ───────────────────────────────────────────────────────────────
section('identity merge keeps the DM cursor; reassign drops it');
{
  const A2 = await seedPerson({ jid: '84099@lid', name: 'Avery' });
  store.setEpisodeCursor(A2, { lastRowid: 999999, lastNightKey: N9 });
  store.logEpisodeNight(A2, N9, { outcome: 'written', memoryId: 1 });
  const curA = store.getEpisodeCursor(A).lastRowid;
  hooks.handleIdentityChange({ type: 'merge', keepJid: A, dropJid: A2 });
  eq('merge: the larger cursor is kept on the surviving person', store.getEpisodeCursor(A).lastRowid, Math.max(curA, 999999));
  eq('merge: the dropped form has no cursor', store.getEpisodeCursor(A2), null);
  eq('merge: the episode log moved', store.episodeNight(A, N9)?.outcome, 'written');
  const R = await seedPerson({ jid: '84098@lid', name: 'Reused' });
  store.setEpisodeCursor(R, { lastRowid: 5, lastNightKey: N9 });
  hooks.handleIdentityChange({ type: 'reassign', jid: R, personJid: R });
  eq('reassign: the recycled number\'s cursor is deleted', store.getEpisodeCursor(R), null);
}

section('guards');
{
  sleep.__setDepsForTest({ isMindOn: () => false });
  eq('mind off → skipped', (await sleep.runSleep(clock.daysBeforeKey(N9, -1))).status, 'skipped');
  sleep.__setDepsForTest({ isMindOn: () => true });
  const { CHARTERS } = await import('../../src/mind/charter.js');
  check('the episode/weekly prompts are static', typeof CHARTERS.EPISODE_PROMPT === 'string' && typeof CHARTERS.WEEKLY_PROMPT === 'string');
  check('clerk calls are metered as digest runs (the mind clerk cap)', db.prepare(`SELECT COUNT(*) FROM mind_runs WHERE kind = 'digest'
    AND trigger_ref LIKE 'episode:%'`).pluck().get() > 0);
  check('every clerk call names its caller', llm.calls.every(c => typeof c.opts.caller === 'string' && c.opts.caller.startsWith('mind.')));
  check('only clerk and mind roles are used', llm.calls.every(c => c.role === 'clerk' || c.role === 'mind'));
  eq('no unscripted model calls', llm.unscripted, []);
}

eq('no network calls', net.length, 0);
report();
