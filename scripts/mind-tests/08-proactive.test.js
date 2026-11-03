// T018 — src/mind/proactive.js (contracts/proactive.md, research R15–R19, quickstart §2 row 08).
// Eligibility (A1–A12), intent (stage B), voice + gate (stage C), shadow/live outcome,
// dispatch re-checks (D1–D12), cancel, and the 14-day shadow simulation (SC-002, SC-009).
// Scratch DB, fake clock, fake models/gate/socket/lock/life. No network, no real model.
import fs from 'fs';
import {
  setupScratchDb, fakeClock, fakeCallRole, fakeGate, fakeSendText, fakeWithChatLock, fakeLife, fakeSock,
  blockNetwork, seedPerson, seedGroup, seedMessage, setBot, section, check, eq, report, DAY, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
const net = blockNetwork();
const store = await import('../../src/mind/store.js');
const clockMod = await import('../../src/mind/clock.js');
const P = await import('../../src/mind/proactive.js');
const { buildLabelMap } = await import('../../src/mind/labels.js');
const { config } = await import('../../src/utils/config.js');
const identity = await import('../../src/memory/identity.js');
const groupStore = await import('../../src/memory/groupStore.js');
const membership = await import('../../src/memory/membership.js');

const MIN = 60;
const realNow = Math.floor(Date.now() / 1000);
const T0 = P.dayStart(realNow) + 12 * HOUR;   // local noon today
const clock = fakeClock(T0);
clockMod.setClock(clock.fn);
await setBot();

// ── people and chats (invented names) ───────────────────────────────────────
const longAgo = T0 - 200 * DAY;
const A = await seedPerson({ jid: '83001@lid', name: 'Avery', pn: '155500003001@s.whatsapp.net' });
const A_PN = '155500003001@s.whatsapp.net';
const B = await seedPerson({ jid: '83002@lid', name: 'Blake' });
const C = await seedPerson({ jid: '83003@lid', name: 'Casey' });
const D = await seedPerson({ jid: '83004@lid', name: 'Drew' });
const E = await seedPerson({ jid: '83005@lid', name: 'Emery', pn: '155500003005@s.whatsapp.net' });
const F = await seedPerson({ jid: '83006@lid', name: 'Finley' });
const H = await seedPerson({ jid: '83008@lid', name: 'Harper' });

const G = await seedGroup({ jid: '120363000000083001@g.us', name: 'Trail club', at: longAgo,
  members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }, { jid: C, joinedAt: T0 - DAY }] });
const G2 = await seedGroup({ jid: '120363000000083002@g.us', name: 'Book nook', at: longAgo,
  members: [{ jid: A, joinedAt: longAgo }, { jid: C, joinedAt: longAgo }] });           // subset of G with the late joiner
const G3 = await seedGroup({ jid: '120363000000083003@g.us', name: 'Chess', at: longAgo,
  members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }] });           // subset of G, early joiners
const G4 = await seedGroup({ jid: '120363000000083004@g.us', name: 'Kayak', at: longAgo,
  members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }] });
const G5 = await seedGroup({ jid: '120363000000083005@g.us', name: 'Pottery', at: longAgo,
  members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }] });

const resync = () => { for (const g of [G, G2, G3, G4, G5]) membership.__markSyncedForTest(g); membership.invalidateMembership?.(); };

/**
 * A digest whose threads are backed by real messages. threads: [{ text, lines: [{ sender, text, chat? }] }].
 * DM lines are stored under `form` (e.g. a PN form) when given.
 */
async function digest(chatJid, { periodStart = clock.now() - 3 * HOUR, summary = 'a calm chat', todayNote = null,
  threads = [], form = null, sender = null } = {}) {
  const ev = [];
  const th = [];
  let maxRow = 0;
  let ts = periodStart;
  for (const [i, t] of threads.entries()) {
    const ids = [];
    const authors = [];
    for (const l of t.lines) {
      const m = await seedMessage({ chat: l.chat ?? form ?? chatJid, sender: l.sender, text: l.text, ts: ts += 60 });
      ids.push(m.id); authors.push(l.sender); ev.push({ msgId: m.id, ts: m.ts }); maxRow = m.rowid;
    }
    th.push({ k: i + 1, text: t.text, evidence: ids, authors: [...new Set(authors)] });
  }
  if (!ev.length) {
    const m = await seedMessage({ chat: form ?? chatJid, sender: sender ?? (chatJid.endsWith('@g.us') ? A : chatJid),
      text: 'just checking in on the day', ts: ts += 60 });
    ev.push({ msgId: m.id, ts: m.ts }); maxRow = m.rowid;
  }
  return store.insertDigest({ chatJid, originKind: chatJid.endsWith('@g.us') ? 'group' : 'dm', fromRowid: 0,
    toRowid: maxRow, periodStart, periodEnd: ts, summary, todayNote, tone: 'warm', threads: th, evidence: ev });
}

/** Label map: entries { chat, id? } in order (a target without a digest just gets a label). */
function lm(...entries) {
  return buildLabelMap(entries.map((e) => {
    const d = e.id != null ? store.getDigest(e.id) : null;
    return { chatJid: e.chat, digestId: e.id ?? null, threads: d?.threads || [], todayNote: d?.todayNote || null };
  }));
}

/** A reach_out candidate in validateThink's shape. basis: [{ id, thread? | today:true }]. */
function cand(map, targetChat, kind, basis, { urgency = 0.8, reason = 'SECRET_REASON_XYZ' } = {}) {
  const labelOf = (pred) => Object.keys(map).find(k => pred(map[k]));
  const target = labelOf(e => e.chatJid === targetChat);
  return {
    kind, target, targetChat, targetKind: map[target]?.kind, urgency, reason,
    basis: basis.map((b) => {
      const l = labelOf(e => e.digestId === b.id);
      return { label: l, chatJid: map[l]?.chatJid, chatKind: map[l]?.kind, digestId: b.id,
        ...(b.today ? { today: true } : { thread: b.thread ?? 1 }) };
    }),
  };
}

// ── fakes ────────────────────────────────────────────────────────────────────
const S = {
  mindOn: true, degraded: false, budget: true, appetite: 1, fun: true, recordSent: 0,
  muted: new Set(), imitating: new Set(),
  warm: { allowed: true, responseType: 'text' }, rate: { allowed: true }, hourly: { allowed: true },
  draft: () => '{"v":1,"skip":false,"intent":"ask how the weekend went"}',
  mouth: () => 'hey, how did the weekend go?',
  funText: () => 'funalt yo',
};
const prompts = [];
const cr = fakeCallRole({
  'mind.draft': (sys, user, opts, i) => S.draft(sys, user, opts, i),
  'mind.proactive': (sys, user, opts, i) => S.mouth(sys, user, opts, i),
  'fun.proactive': (sys, user, opts, i) => S.funText(sys, user, opts, i),
});
const gate = fakeGate({ pass: true, score: 0.8, reason: 'fine' });
const st = fakeSendText();
const lock = fakeWithChatLock();
const sock = fakeSock();
const life = fakeLife({ on: true, availability: 'free', guardNote: null });

P.__setDepsForTest({
  callRole: cr.fn, evaluateResponse: gate.fn, sendText: st.fn, withChatLock: lock.fn, life: () => life,
  isMindOn: () => S.mindOn, isDegraded: () => S.degraded, budgetOk: async () => S.budget, funAvailable: () => S.fun,
  appetite: () => S.appetite, selfStateLine: async () => '',
  buildPrompt: async (q) => { prompts.push(q); return { system: { core: 'CORE', profile: '' }, user: `CHAT ${q.chatJid} OPENER ${q.opener.kind}: ${q.opener.intent}` }; },
  isGroupMuted: (j) => S.muted.has(j), imitating: (j) => S.imitating.has(j),
  checkWarmup: () => S.warm, checkRateLimit: () => S.rate, checkHourlyCaps: () => S.hourly,
  recordSent: () => { S.recordSent++; },
});

const OWNER = 'owner:test';
const setMode = (m) => store.owner.setSetting('proactive_mode', m, OWNER);
const rows = () => db.prepare('SELECT * FROM mind_proactive ORDER BY id').all();
const row = (id) => store.getDraft(id);
function resetAll() {
  db.prepare('DELETE FROM mind_proactive').run();
  db.prepare('DELETE FROM mind_exclusions').run();
  cr.reset(); gate.reset(); st.reset(); lock.reset(); sock.reset(); prompts.length = 0;
  gate.set({ pass: true, score: 0.8, reason: 'fine' });
  Object.assign(S, { mindOn: true, degraded: false, budget: true, appetite: 1, fun: true, recordSent: 0,
    warm: { allowed: true, responseType: 'text' }, rate: { allowed: true }, hourly: { allowed: true },
    draft: () => '{"v":1,"skip":false,"intent":"ask how the weekend went"}',
    mouth: () => 'hey, how did the weekend go?', funText: () => 'funalt yo' });
  S.muted.clear(); S.imitating.clear();
  Object.assign(life, { on: true, availability: 'free', embargo: false, phoneCheck: false, guardNote: null });
  config.mind.funAb = false;
  config.dryRun = true;
  config.ownerJids = [];
  try { store.owner.setSetting('paused', false, OWNER); store.owner.setSetting('exclude_all', false, OWNER); } catch { /* not yet */ }
  resync();
}
const notesOf = (r) => r.notes.map(n => n.reason);

// ── digests used throughout ─────────────────────────────────────────────────
const dG = await digest(G, { periodStart: T0 - 3 * DAY, summary: 'planning a saturday walk',
  threads: [{ text: 'the saturday walk plan', lines: [{ sender: A, text: 'saturday walk at the lake?' }] },
    { text: 'kayak trip idea', lines: [{ sender: B, text: 'we should try a kayak trip soon' }] }] });
const dDM_D = await digest(D, { summary: 'DMSECRET talk about a hospital visit', todayNote: 'DMSECRET hospital',
  threads: [{ text: 'DMSECRET worry', lines: [{ sender: D, text: 'feeling low about the hospital visit' }] }] });
const dDM_A = await digest(A, { form: A_PN, summary: 'chatting about a new job', todayNote: 'started a new job today',
  threads: [{ text: 'the new job', lines: [{ sender: A, text: 'first day at the new job went ok', chat: A_PN }] }] });
const dRelay = await digest(G3, { summary: 'chess club chat',
  threads: [{ text: 'a favour', lines: [{ sender: A, text: 'hey, DM Blake and ask when he is paying me back' }] }] });
const dRelay2 = await digest(G4, { summary: 'kayak chat',
  threads: [{ text: 'news for the group', lines: [{ sender: A, text: 'tell everyone in the group that I am late' }] }] });

// ═════════════════════════════════════════════════════════════════════════════
section('A1: global gate (run notes, no row)');
resetAll();
{
  const map = lm({ chat: G, id: dG });
  const c = cand(map, G, 'follow_up', [{ id: dG, thread: 1 }]);
  let r = await P.considerCandidates([c], map, 1);
  eq('not initialised → note', notesOf(r), ['not_initialised']);
  store.seedDefaults();
  store.initFirstLive(T0 - 2 * DAY, 14);
  S.mindOn = false;
  r = await P.considerCandidates([c], map, 1);
  eq('skill off → note', notesOf(r), ['skill_off']);
  S.mindOn = true; S.degraded = true;
  eq('degraded → note', notesOf(await P.considerCandidates([c], map, 1)), ['degraded']);
  S.degraded = false;
  store.owner.setSetting('paused', true, OWNER);
  eq('paused → note', notesOf(await P.considerCandidates([c], map, 1)), ['paused']);
  store.owner.setSetting('paused', false, OWNER);
  setMode('off');
  eq('mode off → note', notesOf(await P.considerCandidates([c], map, 1)), ['mode_off']);
  setMode('shadow');
  life.embargo = true;
  eq('life embargo → note', notesOf(await P.considerCandidates([c], map, 1)), ['embargo']);
  life.embargo = false; life.guardNote = 'heavy week';
  eq('lifeGuardNote set → embargo', notesOf(await P.considerCandidates([c], map, 1)), ['embargo']);
  life.guardNote = null;
  store.owner.setSetting('exclude_all', true, OWNER);
  eq('exclude_all → note', notesOf(await P.considerCandidates([c], map, 1)), ['exclude_all']);
  store.owner.setSetting('exclude_all', false, OWNER);
  eq('no rows from A1 failures', rows().length, 0);
  eq('no model calls from A1 failures', cr.calls.length, 0);
}

section('Shadow happy path: group target, own basis → would_send, never sent');
resetAll();
{
  const map = lm({ chat: G, id: dG }, { chat: D, id: dDM_D });
  const r = await P.considerCandidates([cand(map, G, 'follow_up', [{ id: dG, thread: 1 }])], map, 7);
  eq('one draft', [r.drafted.length, notesOf(r)], [1, []]);
  const d = row(r.drafted[0].id);
  eq('status would_send', d.status, 'would_send');
  eq('mode shadow', d.mode, 'shadow');
  eq('origins = basis digest chat + period_start', d.origins, [{ originJid: G, minLearnedAt: store.getDigest(dG).periodStart }]);
  eq('basis stored', d.basis, [{ digestId: dG, thread: 1 }]);
  check('intent stored', d.intent === 'ask how the weekend went');
  // postProcess may add a random humane typo/casing change, so compare loosely here.
  check('voiced text stored', typeof d.voicedText === 'string' && d.voicedText.length > 10);
  eq('gate score stored', d.gateScore, 0.8);
  check('audience snapshot has members + origins + content', Array.isArray(d.audience?.members) && d.audience.members.length === 3
    && Array.isArray(d.audience.origins) && d.audience.content?.hash);
  eq('run id kept', d.runId, 7);
  const draftCall = cr.callsFor('mind.draft')[0];
  check('stage B: role mind, effort low, maxTokens 1500', draftCall?.role === 'mind' && draftCall.opts.effort === 'low'
    && draftCall.opts.maxTokens === 1500);
  check('stage B input has the basis thread', draftCall.user.includes('the saturday walk plan'));
  check('stage B input never has the think reason', !draftCall.user.includes('SECRET_REASON'));
  check('stage B input never has another chat (DM digest in the run)', !draftCall.user.includes('DMSECRET'));
  check('stage B input is fenced', draftCall.user.includes('<<<UNTRUSTED_CHAT_DATA'));
  const mouth = cr.callsFor('mind.proactive')[0];
  check('stage C: mouth role, groupJid, msgId', mouth?.role === 'mouth' && mouth.opts.groupJid === G
    && mouth.opts.msgId === `proactive_${d.id}`);
  check('shadow: mouth called WITHOUT send', mouth.opts.send === undefined);
  eq('prompt built for Y with audience of Y', [prompts[0].chatJid, prompts[0].audience.chatJid], [G, G]);
  eq('opener carries kind + intent', prompts[0].opener, { kind: 'follow_up', intent: 'ask how the weekend went' });
  const g = gate.calls[0];
  check('gate isMention:false, caller mind.gate, harm note', g.opts.isMention === false && g.opts.caller === 'mind.gate'
    && g.opts.harmNote === P.PROACTIVE_HARM && !('relay' in g.opts));
  check('draft run recorded (kind draft)', db.prepare(`SELECT COUNT(*) FROM mind_runs WHERE kind = 'draft' AND status = 'ok'`).pluck().get() === 1);
  const disp = await P.dispatchDue(sock);
  eq('dispatch in shadow: nothing due', disp.handled.length, 0);
  eq('shadow never calls sendText', st.sent.length, 0);
  eq('shadow never touches the socket', sock.sent.length, 0);
}

section('A9: a DM-origin basis never drafts into another chat (FR-027)');
resetAll();
{
  const map = lm({ chat: G, id: dG }, { chat: D, id: dDM_D }, { chat: A, id: dDM_A });
  let r = await P.considerCandidates([cand(map, G, 'follow_up', [{ id: dDM_D, thread: 1 }])], map, 1);
  eq('DM basis → group: basis_audience', notesOf(r), ['basis_audience']);
  r = await P.considerCandidates([cand(map, A, 'follow_up', [{ id: dDM_D, thread: 1 }])], map, 1);
  eq('DM basis → another person: basis_audience', notesOf(r), ['basis_audience']);
  r = await P.considerCandidates([cand(map, A, 'check_in', [{ id: dDM_D, today: true }])], map, 1);
  eq('check_in from another DM: basis_audience', notesOf(r), ['basis_audience']);
  r = await P.considerCandidates([cand(map, G, 'check_in', [{ id: dG, thread: 1 }])], map, 1);
  eq('check_in to a group: basis_audience', notesOf(r), ['basis_audience']);
  eq('no rows, no model calls', [rows().length, cr.calls.length], [0, 0]);
  r = await P.considerCandidates([cand(map, A, 'check_in', [{ id: dDM_A, today: true }])], map, 1);
  eq('check_in from the target DM itself: drafted', r.drafted.map(x => x.status), ['would_send']);
  check('DM row: person_jid + send_jid (the stored DM form)', row(r.drafted[0].id).personJid === A
    && row(r.drafted[0].id).sendJid === A_PN);
  check('no fun call for a DM target even with funAb on', cr.callsFor('fun.proactive').length === 0);
}

section('A9: the join-time floor (member joined G after the thread; subset groups)');
resetAll();
{
  const dGC = await digest(G, { periodStart: T0 - 3 * DAY, threads: [{ text: 'old plan by casey', lines: [{ sender: C, text: 'old message from casey' }] }] });
  // Casey's own line before... she joined only yesterday: use a thread authored by Avery for the DM checks
  const map = lm({ chat: C }, { chat: G2 }, { chat: G3 }, { chat: G, id: dG }, { chat: A });
  let r = await P.considerCandidates([cand(map, C, 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  eq('DM to a member who joined G after the thread: basis_audience', notesOf(r), ['basis_audience']);
  r = await P.considerCandidates([cand(map, G2, 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  eq('subset group G2 containing the late joiner: basis_audience', notesOf(r), ['basis_audience']);
  r = await P.considerCandidates([cand(map, G3, 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  eq('subset group G3 of early members: drafted', r.drafted.length, 1);
  r = await P.considerCandidates([cand(map, A, 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  eq('DM to the thread author with a group basis: drafted', r.drafted.length, 1);
  void dGC;
}

section('A10/A11: relay-like threads, author rule, foreign-DM trigger');
resetAll();
{
  const map = lm({ chat: G3, id: dRelay }, { chat: G4, id: dRelay2 }, { chat: B }, { chat: A }, { chat: G, id: dG });
  let r = await P.considerCandidates([cand(map, G3, 'follow_up', [{ id: dRelay, thread: 1 }])], map, 1);
  eq('"DM <name> and ask" thread: relay_like', notesOf(r), ['relay_like']);
  r = await P.considerCandidates([cand(map, G4, 'share', [{ id: dRelay2, thread: 1 }])], map, 1);
  eq('"tell everyone in the group" thread: relay_like', notesOf(r), ['relay_like']);
  r = await P.considerCandidates([cand(map, B, 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  eq('DM to someone who did not author the group thread: not_author', notesOf(r), ['not_author']);
  // Another DM digest in the run names the target → foreign_dm_trigger.
  const dDM_H = await digest(H, { summary: 'Harper vented about Avery being distant', threads: [] });
  const map2 = lm({ chat: A }, { chat: G, id: dG }, { chat: H, id: dDM_H });
  r = await P.considerCandidates([cand(map2, A, 'follow_up', [{ id: dG, thread: 1 }])], map2, 1);
  eq('another DM digest names the target: foreign_dm_trigger', notesOf(r), ['foreign_dm_trigger']);
  // A message id that can no longer be read fails closed.
  const dGone = await digest(G5, { threads: [{ text: 'pottery class', lines: [{ sender: A, text: 'pottery class on friday' }] }] });
  db.prepare('DELETE FROM messages WHERE id = ?').run(store.getDigest(dGone).threads[0].evidence[0]);
  const map3 = lm({ chat: G5, id: dGone });
  r = await P.considerCandidates([cand(map3, G5, 'follow_up', [{ id: dGone, thread: 1 }])], map3, 1);
  eq('unreadable evidence: relay_like (fail closed)', notesOf(r), ['relay_like']);
  eq('no rows', rows().length, 0);
}

section('A4/A5: targets, owner, exclusions, mute, imitation, opt-outs');
resetAll();
{
  const dDM_E = await digest(E, { todayNote: 'busy day at work' });
  const map = lm({ chat: E, id: dDM_E }, { chat: G, id: dG }, { chat: D, id: dDM_D }, { chat: 'ig:group' });
  config.ownerJids = ['+1 55500 003005'];
  let r = await P.considerCandidates([cand(map, E, 'check_in', [{ id: dDM_E, today: true }])], map, 1);
  eq('owner (raw phone form) as DM target: owner_target', notesOf(r), ['owner_target']);
  config.ownerJids = ['83005@lid'];
  r = await P.considerCandidates([cand(map, E, 'check_in', [{ id: dDM_E, today: true }])], map, 1);
  eq('owner (LID form): owner_target', notesOf(r), ['owner_target']);
  config.ownerJids = [];
  check('isOwnerJid matches any form', (config.ownerJids = ['155500003005'], P.isOwnerJid('155500003005:3@s.whatsapp.net') && P.isOwnerJid(E)));
  config.ownerJids = [];
  r = await P.considerCandidates([cand(map, 'ig:group', 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  eq('Instagram target: bad_target', notesOf(r), ['bad_target']);
  S.imitating.add(G);
  r = await P.considerCandidates([cand(map, G, 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  eq('imitating group: bad_target', notesOf(r), ['bad_target']);
  S.imitating.clear();
  S.muted.add(G);
  eq('muted group: muted', notesOf(await P.considerCandidates([cand(map, G, 'follow_up', [{ id: dG, thread: 1 }])], map, 1)), ['muted']);
  S.muted.clear();
  store.owner.addExclusion({ kind: 'group', jid: G }, OWNER);
  eq('owner group exclusion: excluded', notesOf(await P.considerCandidates([cand(map, G, 'follow_up', [{ id: dG, thread: 1 }])], map, 1)), ['excluded']);
  // Person exclusions never exclude groups; they exclude DMs (matched over every identity form).
  store.owner.addExclusion({ kind: 'person', jid: A_PN }, OWNER);
  const mapA = lm({ chat: A, id: dDM_A });
  eq('person exclusion on the PN form excludes the canonical DM', notesOf(await P.considerCandidates([cand(mapA, A, 'check_in', [{ id: dDM_A, today: true }])], mapA, 1)), ['excluded']);
  db.prepare('DELETE FROM mind_exclusions').run();
  store.upsertDetected({ jid: A, kind: 'person', msgId: 'x1', p: 0.9 });
  eq('detected opt-out: dont_text', notesOf(await P.considerCandidates([cand(mapA, A, 'check_in', [{ id: dDM_A, today: true }])], mapA, 1)), ['dont_text']);
  db.prepare('DELETE FROM mind_exclusions').run();
  // Lookback: an old "don't text me first" with no exclusion row yet.
  await seedMessage({ chat: D, sender: D, text: "please don't text me first", ts: T0 - 10 * DAY });
  const mapD = lm({ chat: D, id: dDM_D });
  eq('lookback hit: dont_text', notesOf(await P.considerCandidates([cand(mapD, D, 'check_in', [{ id: dDM_D, today: true }])], mapD, 1)), ['dont_text']);
  check('lookback wrote a detected row (p null)', store.exclusionsFor([D]).some(x => x.source === 'detected' && x.p === null));
  // Review fix (R16): a failed lookback read (mindReads → null) is never "no opt-out".
  db.prepare('DELETE FROM mind_exclusions').run();
  const dontTextMod = await import('../../src/mind/dontText.js');
  dontTextMod.__setDepsForTest({ dontTextLookback: async () => null });
  try {
    dontTextMod.__setDepsForTest({ dontTextLookback: async () => [] });
    check('control: an empty lookback read is not dont_text', !notesOf(await P.considerCandidates([cand(mapA, A, 'check_in', [{ id: dDM_A, today: true }])], mapA, 1)).includes('dont_text'));
    db.prepare('DELETE FROM mind_proactive').run();
    dontTextMod.__setDepsForTest({ dontTextLookback: async () => null });
    eq('failed lookback read: dont_text (fail closed)', notesOf(await P.considerCandidates([cand(mapA, A, 'check_in', [{ id: dDM_A, today: true }])], mapA, 1)), ['dont_text']);
  } finally { dontTextMod.__setDepsForTest(null); }
  db.prepare('DELETE FROM mind_exclusions').run();
  eq('no rows', rows().length, 0);
}

section('A6–A8, A12: back-off, caps, appetite, duplicates, the daily draft cap');
resetAll();
{
  const map = lm({ chat: G, id: dG }, { chat: G3 }, { chat: G4 }, { chat: G5 }, { chat: A });
  const c = (target, o) => cand(map, target, 'follow_up', [{ id: dG, thread: 1 }], o);
  let r = await P.considerCandidates([c(G), c(G)], map, 1);
  eq('two candidates for one chat → one row + duplicate', [r.drafted.length, notesOf(r)], [1, ['duplicate']]);
  r = await P.considerCandidates([c(G)], map, 1);
  eq('second group draft the same local day: cap (or backoff first)', notesOf(r).length === 1 && ['cap', 'backoff'].includes(notesOf(r)[0]), true);
  // Back-off: an ignored would_send blocks the chat for groupBackoffDays (3) even on later days.
  clock.advance({ days: 1 });
  eq('next day, ignored → backoff', notesOf(await P.considerCandidates([c(G)], map, 1)), ['backoff']);
  db.prepare(`UPDATE mind_proactive SET replied_at = ? WHERE chat_jid = ?`).run(clock.now() - HOUR, G);
  eq('after a reply → no backoff', (await P.considerCandidates([c(G)], map, 1)).drafted.length, 1);
  clock.advance({ days: 3 });
  db.prepare('DELETE FROM mind_proactive').run();
  r = await P.considerCandidates([c(G, { urgency: 0.4 })], map, 1);
  eq('urgency under 0.5: appetite', notesOf(r), ['appetite']);
  S.appetite = 0.5;
  eq('appetite 0.5 → bar 0.9: appetite', notesOf(await P.considerCandidates([c(G, { urgency: 0.85 })], map, 1)), ['appetite']);
  S.appetite = 2;
  eq('appetite 2 → bar 0.25: drafted', (await P.considerCandidates([c(G, { urgency: 0.3 })], map, 1)).drafted.length, 1);
  S.appetite = 1;
  db.prepare('DELETE FROM mind_proactive').run();
  // Global ≤ 4 per local day (would_send rows), here with groups G3, G4, G5 and DM A.
  r = await P.considerCandidates([c(G3), c(G4)], map, 1);
  r = await P.considerCandidates([c(G5), c(A)], map, 1);
  const counted = db.prepare(`SELECT COUNT(*) FROM mind_proactive WHERE status IN ('sent','dry_run','send_failed','would_send','queued')`).pluck().get();
  eq('global: 4 counted today', counted, 4);
  const extra = await seedGroup({ jid: '120363000000083009@g.us', name: 'Extra', at: longAgo,
    members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }] });
  const mapX = lm({ chat: extra }, { chat: G, id: dG });
  eq('a 5th chat the same day: cap', notesOf(await P.considerCandidates([cand(mapX, extra, 'follow_up', [{ id: dG, thread: 1 }])], mapX, 1)), ['cap']);
  // DM: ≤ 1 per 3 days.
  clock.advance({ days: 1 });
  db.prepare(`UPDATE mind_proactive SET replied_at = ?`).run(clock.now());
  eq('DM again after 1 day (replied): cap', notesOf(await P.considerCandidates([c(A)], map, 1)), ['cap']);
  clock.advance({ days: 2, minutes: 1 });
  eq('DM after 3 days: drafted', (await P.considerCandidates([c(A)], map, 1)).drafted.length, 1);
  // Daily draft (cost) cap counts every row, dropped ones too.
  clock.advance({ days: 1 });
  db.prepare('DELETE FROM mind_proactive').run();
  const prev = config.mind.proactive.draftsPerDay;
  config.mind.proactive.draftsPerDay = 1;
  S.draft = () => '{"v":1,"skip":true}';
  r = await P.considerCandidates([c(G3), c(G4)], map, 1);
  eq('draftsPerDay 1: first dropped (mind_skip), second cap', [r.drafted.map(x => x.dropReason), notesOf(r)], [['mind_skip'], ['cap']]);
  config.mind.proactive.draftsPerDay = prev;
  S.budget = false;
  eq('mind budget gate: budget note', notesOf(await P.considerCandidates([c(G5)], map, 1)), ['budget']);
  S.budget = true;
  // A12: a drafting row younger than 15 min blocks the chat; an older one does not.
  db.prepare('DELETE FROM mind_proactive').run();
  const mk = (age) => store.insertDraft({ chatJid: G5, chatKind: 'group', kind: 'follow_up', basis: [{ digestId: dG, thread: 1 }],
    origins: [{ originJid: G, minLearnedAt: 0 }], mode: 'shadow', status: 'drafting', createdAt: clock.now() - age });
  mk(5 * MIN);
  eq('fresh drafting row: duplicate', notesOf(await P.considerCandidates([c(G5)], map, 1)), ['duplicate']);
  db.prepare('DELETE FROM mind_proactive').run();
  mk(20 * MIN);
  eq('stale drafting row does not block forever', (await P.considerCandidates([c(G5)], map, 1)).drafted.length, 1);
}

section('Stages B/C: intent checks, mouth skip, gate verdicts, fun A/B');
clock.advance({ days: 4 });
resetAll();
{
  const map = lm({ chat: G, id: dG });
  const c = () => cand(map, G, 'follow_up', [{ id: dG, thread: 1 }]);
  const once = async () => { db.prepare('DELETE FROM mind_proactive').run(); const r = await P.considerCandidates([c()], map, 1); return r.drafted[0]; };
  S.draft = () => '{"v":1,"skip":false,"intent":"ask them to send me the link for tickets"}';
  eq('intent with a harm term: intent_forbidden', (await once()).dropReason, 'intent_forbidden');
  S.draft = () => '{"v":1,"skip":false,"intent":"ask for 155512345678 to be saved"}';
  eq('intent with a phone number: intent_forbidden', (await once()).dropReason, 'intent_forbidden');
  S.draft = () => '{"v":1,"skip":false,"intent":"ask whether Drew is joining the walk"}';
  eq('intent naming a non-member: intent_outsider_name', (await once()).dropReason, 'intent_outsider_name');
  S.draft = () => '{"v":1,"skip":false,"intent":"ask whether Blake is joining the walk"}';
  eq('intent naming a member: ok', (await once()).status, 'would_send');
  S.draft = () => 'not json at all';
  eq('unparsable intent: intent_invalid', (await once()).dropReason, 'intent_invalid');
  S.draft = () => ({ skipped: 'budget', text: null, status: 'budget' });
  eq('mind call skipped: budget', (await once()).dropReason, 'budget');
  S.draft = () => '{"v":1,"skip":false,"intent":"ask how the weekend went"}';
  check('the mouth never saw a rejected intent', cr.callsFor('mind.proactive').every(x => !/link|9198|Drew/.test(x.user)));
  S.mouth = () => '[SKIP]';
  eq('mouth [SKIP]: mouth_skip', (await once()).dropReason, 'mouth_skip');
  S.mouth = () => ({ skipped: 'budget', text: null, status: 'budget' });
  eq('mouth over budget: budget', (await once()).dropReason, 'budget');
  S.mouth = () => 'hey, how did the weekend go?';
  gate.set({ pass: true, score: null, reason: 'gate_disabled' });
  eq('gate_disabled (score null): gate_no_verdict', (await once()).dropReason, 'gate_no_verdict');
  gate.set({ pass: true, score: null, reason: 'parse_error' });
  eq('fail-open no score: gate_no_verdict', (await once()).dropReason, 'gate_no_verdict');
  gate.set({ pass: true, score: 0.45, reason: 'meh' });
  eq('score 0.45 over threshold 0.4 but under the 0.5 minimum: gate', (await once()).dropReason, 'gate');
  gate.set({ pass: false, score: 0.7, reason: 'judge said no' });
  eq('gate pass:false: gate', (await once()).dropReason, 'gate');
  gate.set({ pass: true, score: 0.5, reason: 'ok' });
  eq('score exactly at the minimum: passes', (await once()).status, 'would_send');
  // Review fix: a life guard note that appears after A1 reaches the judge via harmNote.
  S.mouth = () => { life.guardNote = 'GUARD_NOTE_X'; return 'hey, how did the weekend go?'; };
  const gn = gate.calls.length;
  await once();
  life.guardNote = null;
  S.mouth = () => 'hey, how did the weekend go?';
  const gOpts = gate.calls[gn]?.opts || {};
  check('life guard note appended to the gate harmNote (the field the judge reads)',
    typeof gOpts.harmNote === 'string' && gOpts.harmNote.startsWith(P.PROACTIVE_HARM) && gOpts.harmNote.includes('GUARD_NOTE_X')
    && !('guardNote' in gOpts));
  check('proactive.js never calls recordQuality', !/\brecordQuality\s*\(|import[^;]*recordQuality/.test(fs.readFileSync(new URL('../../src/mind/proactive.js', import.meta.url), 'utf8')));
  // Fun A/B: groups only, without `send`, stored as alt_text.
  config.mind.funAb = true;
  const f = await once();
  const fr = row(f.id);
  eq('fun alt text stored with its model', [fr.altText, fr.altModel], ['funalt yo', 'fake-fun']);
  const fc = cr.callsFor('fun.proactive').at(-1);
  check('fun called without send, role fun', fc.role === 'fun' && fc.opts.send === undefined);
  S.fun = false;
  const before = cr.callsFor('fun.proactive').length;
  await once();
  eq('fun unavailable (disabled/budget): not called', cr.callsFor('fun.proactive').length, before);
  config.mind.funAb = false;
  // A deletion hook firing mid-pipeline (during stage B) is never undone by a later write.
  db.prepare('DELETE FROM mind_proactive').run();
  S.draft = () => { P.cancelForChat([G], 'content_changed'); return '{"v":1,"skip":false,"intent":"ask how the weekend went"}'; };
  const mouthBefore = cr.callsFor('mind.proactive').length;
  const h = (await P.considerCandidates([c()], map, 1)).drafted[0];
  eq('hook during stage B: row stays dropped content_changed', [row(h.id).status, row(h.id).dropReason], ['dropped', 'content_changed']);
  eq('…and the mouth is never called for it', cr.callsFor('mind.proactive').length, mouthBefore);
}

section('Live without OWNER_JIDS behaves as shadow');
clock.advance({ days: 4 });
resetAll();
{
  setMode('live');
  const map = lm({ chat: G, id: dG });
  const r = await P.considerCandidates([cand(map, G, 'follow_up', [{ id: dG, thread: 1 }])], map, 1);
  const d = row(r.drafted[0].id);
  eq('mode shadow, never queued', [d.mode, d.status], ['shadow', 'would_send']);
  check('mouth without send', cr.callsFor('mind.proactive')[0].opts.send === undefined);
  eq('effectiveMode', P.effectiveMode(), 'shadow');
  // Review fix: OWNER_JIDS entries that resolve to nothing count as unset.
  for (const bad of [['typo'], ['  '], ['abc@example.com'], ['12345']]) {
    config.ownerJids = bad;
    check(`OWNER_JIDS=${JSON.stringify(bad)}: unresolved, effectiveMode stays shadow`,
      P.ownerJidsResolved() === false && P.effectiveMode() === 'shadow');
  }
  config.ownerJids = ['typo', '155500003005'];
  check('one valid entry among typos resolves → live', P.ownerJidsResolved() === true && P.effectiveMode() === 'live');
  config.ownerJids = ['83005@lid'];
  check('a LID form resolves (exact-form match)', P.ownerJidsResolved() === true);
  config.ownerJids = [];
}

// ── live helpers ────────────────────────────────────────────────────────────
async function queue(target, basis, kind = 'follow_up', mapEntries = null) {
  const map = mapEntries || lm({ chat: target }, { chat: G, id: dG });
  const r = await P.considerCandidates([cand(map, target, kind, basis)], map, 1);
  return r.drafted[0] ? row(r.drafted[0].id) : { notes: notesOf(r) };
}
const goLive = () => { config.ownerJids = ['155500003005']; setMode('live'); };
const due = () => clock.advance({ minutes: 21 });

section('Live: queue, DRY_RUN, a real send, one per tick, send_failed, DM send form');
clock.advance({ days: 4 });
resetAll();
{
  goLive();
  eq('effectiveMode live with OWNER_JIDS', P.effectiveMode(), 'live');
  const q = await queue(G, [{ id: dG, thread: 1 }], 'follow_up', lm({ chat: G, id: dG }));
  eq('queued in live', [q.status, q.mode], ['queued', 'live']);
  check('send_after in 2..20 min', q.sendAfter >= clock.now() + 2 * MIN && q.sendAfter <= clock.now() + 20 * MIN);
  check('mouth called with send:true', cr.callsFor('mind.proactive')[0].opts.send === true);
  eq('not due yet: nothing handled', (await P.dispatchDue(sock)).handled.length, 0);
  due();
  let out = await P.dispatchDue(sock);
  eq('DRY_RUN → dry_run without sendText', [out.handled[0].outcome, st.sent.length], ['dry_run', 0]);
  check('dispatch ran inside the chat lock', lock.locks.includes(G));
  db.prepare(`UPDATE mind_proactive SET replied_at = ?`).run(clock.now());
  eq('a dry_run fills the group cap', (await queue(G, [{ id: dG, thread: 1 }], 'follow_up', lm({ chat: G, id: dG }))).notes, ['cap']);
  // A real send (config.dryRun off; sendText is the fake): the cap check excludes the row itself.
  config.dryRun = false;
  config.mind.funAb = true;
  const q3 = await queue(G3, [{ id: dG, thread: 1 }]);
  eq('G3 queued (the dry_run row counts toward the global cap only)', q3.status, 'queued');
  due();
  out = await P.dispatchDue(sock);
  eq('one queued group draft is actually sent', out.handled.map(h => h.outcome), ['sent']);
  eq('sent to the group with exactly the stored voiced text', [st.sent[0]?.jid, st.sent[0]?.text], [G3, row(q3.id).voicedText]);
  check('alt_text never reaches sendText', row(q3.id).altText === 'funalt yo' && st.sent.every(s => !s.text.includes('funalt')));
  const s3 = row(q3.id);
  check('sent row: sent_at + msg_id + recordSent', s3.status === 'sent' && s3.sentAt === clock.now() && s3.msgId === 'sent-1' && S.recordSent === 1);
  config.mind.funAb = false;
  // Two due rows → one send per tick.
  db.prepare('DELETE FROM mind_proactive').run();
  st.reset();
  const q4 = await queue(G4, [{ id: dG, thread: 1 }]);
  const q5 = await queue(G5, [{ id: dG, thread: 1 }]);
  eq('two queued', [q4.status, q5.status], ['queued', 'queued']);
  due();
  out = await P.dispatchDue(sock);
  eq('≤ 1 send per tick', [out.sent, st.sent.length], [1, 1]);
  out = await P.dispatchDue(sock);
  eq('the other goes on the next tick', st.sent.length, 2);
  // send_failed counts toward caps.
  clock.advance({ days: 4 });
  db.prepare('DELETE FROM mind_proactive').run();
  st.reset();
  st.failNext();
  const qf = await queue(G4, [{ id: dG, thread: 1 }]);
  due();
  out = await P.dispatchDue(sock);
  eq('null from sendText → send_failed', [out.handled[0].outcome, row(qf.id).status], ['send_failed', 'send_failed']);
  db.prepare(`UPDATE mind_proactive SET replied_at = ?`).run(clock.now());
  const again = await queue(G4, [{ id: dG, thread: 1 }]);
  eq('send_failed fills the group cap', again.notes, ['cap']);
  // DM: sent to the stored DM form (send_jid).
  const qa = await queue(A, [{ id: dDM_A, today: true }], 'check_in', lm({ chat: A, id: dDM_A }));
  eq('DM queued with send_jid = PN form', [qa.status, qa.sendJid], ['queued', A_PN]);
  due();
  st.reset();
  await P.dispatchDue(sock);
  eq('DM sent to send_jid', st.sent.map(s => s.jid), [A_PN]);
  check('DM dispatch locked on the arrival form (events.js lock key)', lock.locks.at(-1) === A_PN);
  check('no send ever to an owner form', st.sent.every(s => !P.isOwnerJid(s.jid)));
}

section('Dispatch re-checks drop or hold the send (D1–D11)');
async function freshQueued(target = G, basis = [{ id: dG, thread: 1 }], kind = 'follow_up', map = null, before = null) {
  clock.advance({ days: 4 });
  resetAll();
  goLive();
  config.dryRun = false;
  if (before) await before();
  const q = await queue(target, basis, kind, map || (target === G ? lm({ chat: G, id: dG }) : lm({ chat: target }, { chat: G, id: dG })));
  if (q.status !== 'queued') throw new Error(`setup: expected queued, got ${JSON.stringify(q)}`);
  return q;
}
async function dispatchOutcome(q) {
  due();
  const out = await P.dispatchDue(sock);
  const r = row(q.id);
  return { outcome: out.handled[0]?.outcome, status: r.status, reason: r.dropReason, sends: st.sent.length };
}
{
  let q = await freshQueued();
  await groupStore.upsertMember(G, F, 'member', clock.now());
  resync();
  let o = await dispatchOutcome(q);
  eq('a new member in Y: audience_changed, no send', [o.status, o.reason, o.sends], ['dropped', 'audience_changed', 0]);
  eq('…and the dropped row keeps no text (review repair)', [row(q.id).intent, row(q.id).voicedText, row(q.id).altText], [null, null, null]);
  groupStore.removeMember(G, F);
  resync();

  q = await freshQueued(A, [{ id: dG, thread: 1 }], 'follow_up', lm({ chat: A }, { chat: G, id: dG }));
  groupStore.removeMember(G, A);
  resync();
  o = await dispatchOutcome(q);
  eq('the DM target left the origin group: audience_changed', [o.status, o.reason, o.sends], ['dropped', 'audience_changed', 0]);
  groupStore.upsertMember(G, A, 'member', longAgo);
  resync();

  q = await freshQueued();
  await seedMessage({ chat: G, sender: B, text: 'anyone around?', ts: clock.now() + 60 });
  o = await dispatchOutcome(q);
  eq('a human message in Y since created_at: conversation_active', [o.reason, o.sends], ['conversation_active', 0]);

  const lastInG = () => db.prepare('SELECT id FROM messages WHERE group_jid = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1').pluck().get(G, clock.now());
  q = await freshQueued();
  db.prepare('UPDATE messages SET no_learn = 1 WHERE id = ?').run(lastInG());
  o = await dispatchOutcome(q);
  eq('a message in Y fenced after the draft: content_changed', [o.reason, o.sends], ['content_changed', 0]);

  q = await freshQueued();
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('edited text', lastInG());
  o = await dispatchOutcome(q);
  eq('a message in Y edited after the draft: content_changed', [o.reason, o.sends], ['content_changed', 0]);

  let victim = null;
  q = await freshQueued(G, [{ id: dG, thread: 1 }], 'follow_up', null,
    async () => { victim = await seedMessage({ chat: G, sender: B, text: 'see you all there', ts: clock.now() - 30 }); });
  db.prepare('DELETE FROM messages WHERE id = ?').run(victim.id);   // a revoke deletes the row
  o = await dispatchOutcome(q);
  eq('a revoke in Y after the draft (fewer messages): content_changed', [o.reason, o.sends], ['content_changed', 0]);

  q = await freshQueued(A, [{ id: dDM_A, today: true }], 'check_in', lm({ chat: A, id: dDM_A }));
  config.ownerJids = ['155500003005', A_PN];
  o = await dispatchOutcome(q);
  eq('target became an OWNER_JIDS form: owner_target, no send', [o.reason, o.sends], ['owner_target', 0]);

  q = await freshQueued(A, [{ id: dDM_A, today: true }], 'check_in', lm({ chat: A, id: dDM_A }));
  db.prepare('UPDATE person_identities SET person_jid = ? WHERE jid = ?').run(B, A);
  identity.__clearIdentityCacheForTest();
  o = await dispatchOutcome(q);
  eq('reassigned number: identity_changed', [o.reason, o.sends], ['identity_changed', 0]);
  db.prepare('UPDATE person_identities SET person_jid = ? WHERE jid = ?').run(A, A);
  identity.__clearIdentityCacheForTest();

  q = await freshQueued();
  store.owner.setSetting('paused', true, OWNER);
  eq('pause → cancelQueued cancels', P.cancelQueued('paused'), 1);
  o = await dispatchOutcome(q);
  eq('cancelled row is never sent', [o.status, o.reason, o.sends], ['cancelled', 'paused', 0]);

  q = await freshQueued();
  store.owner.setSetting('paused', true, OWNER);            // race: no cancelQueued call
  o = await dispatchOutcome(q);
  eq('paused at dispatch: cancelled', [o.status, o.reason, o.sends], ['cancelled', 'paused', 0]);

  q = await freshQueued();
  S.mindOn = false;
  o = await dispatchOutcome(q);
  eq('skill off at dispatch: cancelled', [o.status, o.reason, o.sends], ['cancelled', 'skill_off', 0]);

  q = await freshQueued();
  eq('skill off → cancelQueued(skill_off)', [P.cancelQueued('skill_off'), row(q.id).status, row(q.id).dropReason], [1, 'cancelled', 'skill_off']);

  q = await freshQueued();
  setMode('shadow');
  o = await dispatchOutcome(q);
  eq('mode switched to shadow: cancelled', [o.status, o.reason, o.sends], ['cancelled', 'mode_changed', 0]);

  q = await freshQueued();
  config.ownerJids = [];
  o = await dispatchOutcome(q);
  eq('OWNER_JIDS removed: no longer live → cancelled', [o.status, o.sends], ['cancelled', 0]);

  q = await freshQueued();
  clock.advance({ hours: 7 });
  o = await dispatchOutcome(q);
  eq('older than the TTL: expired', [o.status, o.sends], ['expired', 0]);

  q = await freshQueued();
  P.__setDepsForTest({ withChatLock: async (jid, fn) => fn({ turnSignal: { aborted: true } }) });
  o = await dispatchOutcome(q);
  P.__setDepsForTest({ withChatLock: lock.fn });
  eq('aborted turn signal: aborted', [o.reason, o.sends], ['aborted', 0]);

  q = await freshQueued();
  S.warm = { allowed: true, responseType: 'reaction', downgraded: true };
  o = await dispatchOutcome(q);
  eq('warmup downgraded to reactions: warmup', [o.reason, o.sends], ['warmup', 0]);

  q = await freshQueued();
  S.hourly = { allowed: false, reason: 'hourly cap (global)' };
  o = await dispatchOutcome(q);
  eq('hourly caps: rate_limited', [o.reason, o.sends], ['rate_limited', 0]);

  q = await freshQueued();
  S.muted.add(G);
  o = await dispatchOutcome(q);
  eq('muted since drafting: muted', [o.reason, o.sends], ['muted', 0]);

  q = await freshQueued();
  store.owner.addExclusion({ kind: 'group', jid: G }, OWNER);
  o = await dispatchOutcome(q);
  eq('owner exclusion since drafting: excluded', [o.reason, o.sends], ['excluded', 0]);

  q = await freshQueued();
  db.prepare('UPDATE mind_digests SET period_start = period_start + 1 WHERE id = ?').run(dG);
  o = await dispatchOutcome(q);
  eq('basis digest no longer matches origins_json: basis_gone', [o.reason, o.sends], ['basis_gone', 0]);
  eq('…text nulled on a basis_gone drop', [row(q.id).intent, row(q.id).voicedText], [null, null]);
  db.prepare('UPDATE mind_digests SET period_start = period_start - 1 WHERE id = ?').run(dG);

  q = await freshQueued();
  life.availability = 'busy';
  o = await dispatchOutcome(q);
  eq('busy in life: stays queued', [o.outcome, o.status, o.sends], ['unavailable', 'queued', 0]);
  life.phoneCheck = true;
  o = await dispatchOutcome(q);
  eq('a phone check while busy: sent', [o.status, o.sends], ['sent', 1]);

  q = await freshQueued();
  S.degraded = true;
  o = await dispatchOutcome(q);
  eq('degraded: stays queued, no send', [o.status, o.sends], ['queued', 0]);
  S.degraded = false;

  q = await freshQueued();
  life.on = false;
  const sleepy = clockMod.inSleepHours(clock.now() + 21 * MIN);
  o = await dispatchOutcome(q);
  eq('life off: the quiet-hours rule decides', o.status, sleepy ? 'queued' : 'sent');
}

section('cancelForChat (deletion hook) and boot-time stale drafting');
clock.advance({ days: 4 });
resetAll();
{
  const map = lm({ chat: G, id: dG });
  const sh = (await P.considerCandidates([cand(map, G, 'follow_up', [{ id: dG, thread: 1 }])], map, 1)).drafted[0].id;
  const q = store.insertDraft({ chatJid: G, chatKind: 'group', kind: 'follow_up', basis: [{ digestId: dG, thread: 1 }],
    origins: [{ originJid: G, minLearnedAt: 0 }], mode: 'live', status: 'queued', intent: 'x intent here', voicedText: 'v', createdAt: clock.now() });
  const r = P.cancelForChat([G], 'content_changed');
  eq('one pending dropped, one shadow nulled', r, { dropped: 1, nulled: 1 });
  const qr = row(q);
  eq('pending → dropped content_changed, text null', [qr.status, qr.dropReason, qr.intent, qr.voicedText], ['dropped', 'content_changed', null, null]);
  const sr = row(sh);
  eq('shadow row keeps status, loses text', [sr.status, sr.intent, sr.voicedText], ['would_send', null, null]);
  eq('empty forms: no-op', P.cancelForChat([], 'x'), { dropped: 0, nulled: 0 });
}

section('14-day shadow simulation (SC-002, SC-009): never a send, caps hold');
clock.advance({ days: 4 });
resetAll();
setMode('shadow');
config.mind.funAb = true;
{
  // Deterministic PRNG.
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const groups = [G, G3, G4, G5];
  const dms = [A, B];
  const start = P.dayStart(clock.now());
  let candidates = 0;
  const simNotes = [];
  for (let day = 0; day < 14; day++) {
    const d0 = start + day * DAY;
    // New digests for the day (each group thread authored by A, each DM its own today note).
    clock.set(d0 + 8 * HOUR);
    const dig = {};
    for (const g of groups) {
      dig[g] = await digest(g, { periodStart: clock.now() - HOUR, threads: [{ text: `day ${day} plan`, lines: [{ sender: A, text: `plan for day ${day}` }] }] });
    }
    for (const p of dms) dig[p] = await digest(p, { periodStart: clock.now() - HOUR, todayNote: `day ${day} note`, sender: p });
    const map = lm(...groups.map(g => ({ chat: g, id: dig[g] })), ...dms.map(p => ({ chat: p, id: dig[p] })));
    for (const hour of [10, 14, 18]) {
      clock.set(d0 + hour * HOUR);
      const list = [];
      for (let k = 0; k < 2; k++) {
        const pick = rnd();
        if (pick < 0.6) { const g = groups[Math.floor(rnd() * groups.length)]; list.push(cand(map, g, 'follow_up', [{ id: dig[g], thread: 1 }], { urgency: 0.6 + rnd() * 0.4 })); }
        else { const p = dms[Math.floor(rnd() * dms.length)]; list.push(cand(map, p, 'check_in', [{ id: dig[p], today: true }], { urgency: 0.6 + rnd() * 0.4 })); }
      }
      candidates += list.length;
      simNotes.push(...notesOf(await P.considerCandidates(list, map, 1)));
      // Hourly dispatch ticks; sometimes someone answers.
      for (let h = 0; h < 4; h++) { clock.advance({ hours: 1 }); await P.dispatchDue(sock); }
      if (rnd() < 0.5) db.prepare(`UPDATE mind_proactive SET replied_at = ? WHERE status = 'would_send' AND replied_at IS NULL`).run(clock.now());
    }
  }
  const all = rows();
  check(`simulation produced drafts (${all.length} rows from ${candidates} candidates)`, all.length > 10);
  eq('shadow: sendText never called', st.sent.length, 0);
  eq('shadow: socket never used', sock.sent.length, 0);
  eq('shadow: no queued/sent/dry_run/send_failed rows', all.filter(r => ['queued', 'sent', 'dry_run', 'send_failed'].includes(r.status)).length, 0);
  eq('every row mode shadow', all.every(r => r.mode === 'shadow'), true);
  const COUNTED = ['sent', 'dry_run', 'send_failed', 'would_send', 'queued'];
  const counted = all.filter(r => COUNTED.includes(r.status));
  check('some would_send rows', counted.length > 0);
  const byDay = new Map();
  for (const r of counted) { const k = clockMod.dayKey(r.created_at); byDay.set(k, (byDay.get(k) || 0) + 1); }
  check('global ≤ 4 per local day', [...byDay.values()].every(n => n <= 4), [...byDay.entries()]);
  check('the global cap actually bound on some day', Math.max(...byDay.values()) === 4, [...byDay.entries()]);
  check('caps / back-off refused candidates during the run', simNotes.some(n => n === 'cap') && simNotes.some(n => n === 'backoff'),
    [...new Set(simNotes)]);
  const perGroupDay = new Map();
  for (const r of counted.filter(x => x.chat_kind === 'group')) {
    const k = `${r.chat_jid}|${clockMod.dayKey(r.created_at)}`;
    perGroupDay.set(k, (perGroupDay.get(k) || 0) + 1);
  }
  check('group ≤ 1 per local day', [...perGroupDay.values()].every(n => n <= 1));
  let dmOk = true;
  for (const p of dms) {
    const ts = counted.filter(x => x.chat_jid === p).map(x => x.created_at).sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] < 3 * DAY) dmOk = false;
  }
  check('DM ≤ 1 per 3 days', dmOk);
  const draftsPerDay = new Map();
  for (const r of all) { const k = clockMod.dayKey(r.created_at); draftsPerDay.set(k, (draftsPerDay.get(k) || 0) + 1); }
  check('drafts ≤ 8 per local day', [...draftsPerDay.values()].every(n => n <= 8));
  check('fun never called for a DM target', cr.callsFor('fun.proactive').every(c => !dms.some(p => c.user.includes(p))));
  check('fun was exercised for groups', cr.callsFor('fun.proactive').length > 0);
  check('no network', net.length === 0, net);
}

section('Default prompt path (real buildSystemParts/buildConversationContext, null trigger)');
{
  P.__setDepsForTest(null);
  const crd = fakeCallRole({ 'mind.proactive': () => 'hey there' });
  P.__setDepsForTest({ callRole: crd.fn, evaluateResponse: async () => ({ pass: true, score: 0.9, reason: 'ok' }) });
  const { resolveAudience } = await import('../../src/memory/recall.js');
  const v = await P.voice({ id: 999, kind: 'follow_up' }, { target: { Y: G, isGroup: true, person: null },
    audience: resolveAudience({ chatJid: G, kind: 'group' }), intent: 'ask how the weekend went', mode: 'shadow' });
  eq('voiced through the real prompt builder', v.text, 'hey there');
  const u = crd.calls[0]?.user || '';
  check('opener instruction reaches the mouth', u.includes('You are texting first') && u.includes('ask how the weekend went'));
  check('system is the {core, profile} pair', typeof crd.calls[0]?.system?.core === 'string');
}

report();
