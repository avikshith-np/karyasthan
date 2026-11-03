// T014 — src/mind/selfState.js (research R10/R11, quickstart §2 row 05): elements with
// code-computed origins, the audience-filtered self-state line, morning reset, expiry.
// Scratch DB, fake clock, fake life facade, no network, no model.
import {
  setupScratchDb, fakeClock, fakeLife, blockNetwork, seedPerson, seedGroup, seedMessage, setBot,
  section, check, eq, report, DAY, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
const net = blockNetwork();
const store = await import('../../src/mind/store.js');
const clockMod = await import('../../src/mind/clock.js');
const ss = await import('../../src/mind/selfState.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
const relationshipStore = await import('../../src/memory/relationshipStore.js');
const { buildLabelMap } = await import('../../src/mind/labels.js');

const T0 = Date.UTC(2026, 9, 27, 6, 0) / 1000;
const clock = fakeClock(T0);
clockMod.setClock(clock.fn);
await setBot();

// People: Avery and Blake have been in the groups for ages; Casey joined G yesterday.
const A = await seedPerson({ jid: '82001@lid', name: 'Avery' });
const B = await seedPerson({ jid: '82002@lid', name: 'Blake' });
const C = await seedPerson({ jid: '82003@lid', name: 'Casey' });
const longAgo = T0 - 100 * DAY;
const G = await seedGroup({ jid: '120363000000082001@g.us', name: 'Trail club',
  members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }, { jid: C, joinedAt: T0 - DAY }], at: longAgo });
const G2 = await seedGroup({ jid: '120363000000082002@g.us', name: 'Book nook',
  members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }], at: longAgo });

let mindOn = true;
let degraded = false;
let replyLen = 'normal';
let life = fakeLife({ on: false, guardNote: null });
ss.__setDepsForTest({
  isMindOn: () => mindOn,
  isDegraded: () => degraded,
  life: () => life,
  replyLength: () => replyLen,
});

const audG = () => resolveAudience({ chatJid: G, kind: 'group' });
const audG2 = () => resolveAudience({ chatJid: G2, kind: 'group' });
const audA = () => resolveAudience({ chatJid: A, kind: 'dm' });
const audC = () => resolveAudience({ chatJid: C, kind: 'dm' });
const line = (aud, chatJid, extra = {}) => ss.renderLine(aud, { chatJid, track: false, ...extra });

/** A digest backed by one real message (so a revoke cascades to it). */
async function digest(chatJid, { periodStart = clock.now() - 2 * HOUR, todayNote = null, threads = [], sender = A } = {}) {
  const msg = await seedMessage({ chat: chatJid, sender, text: 'some line', ts: periodStart });
  const id = store.insertDigest({ chatJid, originKind: chatJid.endsWith('@g.us') ? 'group' : 'dm', fromRowid: 0,
    toRowid: msg.rowid, periodStart, periodEnd: periodStart + 600, summary: 'a summary', todayNote, tone: 'warm',
    threads: threads.map((text, i) => ({ k: i + 1, text, evidence: [msg.id], authors: [sender] })),
    evidence: [{ msgId: msg.id, ts: periodStart }] });
  return { id, msg };
}

const dG = await digest(G, { todayNote: 'a laugh about the muddy trail', threads: ['the saturday hike plan'] });
const dG2 = await digest(G2, { todayNote: 'argued over a novel ending', threads: ['next month book pick'] });
const dA = await digest(A, { todayNote: 'heard about a hard week at work', threads: ['the interview on friday'] });

// ── switches ───────────────────────────────────────────────────────────────
section('switches: off / imitation / embargo / degraded / no life facade → ""');
{
  ss.applyBaseMood({ word: 'calm', intensity: 0.5 }, { runId: null });
  eq('base mood renders in a group (origins [] = self)', line(audG(), G), 'How you are today: calm.');
  mindOn = false;
  eq('mind off → ""', line(audG(), G), '');
  mindOn = true;
  eq('imitating → ""', line(audG(), G, { imitation: { targetJid: A } }), '');
  degraded = true;
  eq('degraded → ""', line(audG(), G), '');
  degraded = false;
  life.embargo = true;
  eq('life embargo (embargoActive) → ""', line(audG(), G), '');
  life.embargo = false;
  life.guardNote = 'quiet day';
  eq('life guard note present → ""', line(audG(), G), '');
  life.guardNote = null;
  const saved = life;
  life = null;
  eq('life facade not loaded → "" (fail closed)', line(audG(), G), '');
  life = saved;
  eq('no audience → ""', ss.renderLine(null, { chatJid: G }), '');
  eq('self audience → nothing usable', line({ kind: 'self', chatJid: 'x', members: new Set(), sameChat: [] }, G), '');
}

// ── mood origins and fallback ──────────────────────────────────────────────
section('mood: origins = every input chat; falls back to base_mood');
{
  const map = buildLabelMap([{ chatJid: G, digestId: dG.id }, { chatJid: A, digestId: dA.id }]);
  const id = ss.applyMood({ word: 'tired', intensity: 0.9 }, { labelMap: map, runId: null });
  const el = store.getElement(id);
  eq('mood origins = every chat in the run input, with the digest period_start',
    el.origins.map(o => [o.originJid, o.minLearnedAt]).sort(),
    [[A, store.getDigest(dA.id).periodStart], [G, store.getDigest(dG.id).periodStart]].sort());
  eq('group prompt: DM origin fails → base_mood instead', line(audG(), G), 'How you are today: calm.');
  eq("Avery's DM: both origins usable → the mood (with intensity)", line(audA(), A), 'How you are today: very tired.');
  eq('derived element with 2 origins fails in a chat where either fails (G2)', line(audG2(), G2), 'How you are today: calm.');
  life.on = true;
  eq('life on → no mood word at all', line(audA(), A), '');
  life.on = false;
  check('an invalid mood word is refused', ss.applyMood({ word: 'ecstatic', intensity: 1 }) === null);
}

// ── today picks ────────────────────────────────────────────────────────────
section('today: DM-derived pick omitted in the group prompt');
{
  const r = ss.applyToday([{ digestId: dA.id, chatJid: A }, { digestId: dG.id, chatJid: G }]);
  eq('both picks applied', r.applied.length, 2);
  const g = line(audG(), G);
  check('group line has the group today note', g.includes('a laugh about the muddy trail'), g);
  check('group line omits the DM today note (never paraphrased)', !g.includes('hard week'), g);
  const a = line(audA(), A);
  check("Avery's DM sees both (G origin usable for a member)", a.includes('hard week') && a.includes('muddy trail'), a);
  const g2 = line(audG2(), G2);
  check('G2 (members ⊆ G, joined before) sees the G note but never the DM note', g2.includes('muddy') && !g2.includes('hard week'), g2);
  const bad = ss.applyToday([{ digestId: dG.id, chatJid: A }, { digestId: 999999 }]);
  eq('mismatched chat / missing digest picks dropped', bad.dropped.map(d => d.reason), ['chat_mismatch', 'digest_gone']);
}

// ── intentions ─────────────────────────────────────────────────────────────
section('intentions: target chat or self only');
{
  const r = ss.applyIntentions([
    { kind: 'follow_up', target: 'C1', targetChat: G, basis: [{ digestId: dG.id, chatJid: G, thread: 1 }], ttlHours: 24 },
    { kind: 'keep_quiet', target: 'self', targetChat: null, basis: [], ttlHours: 6 },
  ]);
  eq('two intentions applied', [r.applied.length, r.dropped.length], [2, 0]);
  const g = line(audG(), G);
  check('follow_up rendered in its target group', g.includes('meaning to ask about the saturday hike plan'), g);
  check('self intention rendered', g.includes('not in a chatty mood'), g);
  const a = line(audA(), A);
  check('follow_up for G not shown in a DM', !a.includes('saturday hike'), a);
  check('self intention shown in the DM too', a.includes('not in a chatty mood'), a);
  check('not shown in G2', !line(audG2(), G2).includes('saturday hike'));

  const ci = ss.applyIntentions([
    { kind: 'check_in', targetChat: A, basis: [{ digestId: dG.id, chatJid: G, today: true }] },
    { kind: 'check_in', targetChat: A, basis: [{ digestId: dA.id, chatJid: A, today: true }] },
    { kind: 'check_in', targetChat: G, basis: [{ digestId: dG.id, chatJid: G, today: true }] },
  ]);
  eq('check_in from another chat → foreign_basis; group check_in → bad_basis',
    ci.dropped.map(d => d.reason), ['foreign_basis', 'bad_basis']);
  const nt = ss.applyIntentions([{ kind: 'follow_up', targetChat: G, basis: [{ digestId: dG.id, thread: 3 }] },
    { kind: 'share', targetChat: G, basis: [] }]);
  eq('missing thread → no_thread; share without a thread basis → bad_basis', nt.dropped.map(d => d.reason),
    ['no_thread', 'bad_basis']);
  check("check_in on Avery's own DM digest renders only there", line(audA(), A).includes('check in on them')
    && !line(audG(), G).includes('check in'));
  ss.applyIntentions([{ kind: 'wind_down', target: 'self', basis: [] }]);
  eq('at most 3 active intentions', store.activeElements(clock.now()).filter(e => e.kind === 'intention').length, 3);
}

// ── join-time floor ────────────────────────────────────────────────────────
section("join-time floor: a basis older than a member's join is not shown in that member's DM");
{
  // Casey joined G a day ago; dGold covers lines from three days ago.
  const dGold = await digest(G, { periodStart: clock.now() - 3 * DAY, threads: ['the old camping story'] });
  const r = ss.applyIntentions([{ kind: 'follow_up', targetChat: C, basis: [{ digestId: dGold.id, chatJid: G, thread: 1 }] }]);
  eq('apply drops it (basis_audience)', r.dropped.map(d => d.reason), ['basis_audience']);
  // Even a row written around the apply check never renders there.
  const old = store.getDigest(dGold.id);
  store.insertElement({ kind: 'intention', intentionKind: 'follow_up', targetChat: C,
    basis: [{ digestId: old.id, thread: 1 }], origins: [{ originJid: G, originKind: 'group', minLearnedAt: old.periodStart }],
    expiresAt: clock.now() + DAY });
  check("render in Casey's DM omits it", !line(audC(), C).includes('camping'), line(audC(), C));
  const r2 = ss.applyIntentions([{ kind: 'follow_up', targetChat: A, basis: [{ digestId: dGold.id, chatJid: G, thread: 1 }] }]);
  eq('the same basis is fine for a long-time member (Avery)', r2.dropped.length, 0);
}

// ── cap ────────────────────────────────────────────────────────────────────
section('line cap: ≤ 160 chars, whole fragments dropped from the end');
{
  for (const c of [G, A]) {
    const l = line(c === G ? audG() : audA(), c);
    check(`line for ${c === G ? 'G' : 'DM'} ≤ 160 (${l.length})`, l.length <= 160 && l.length > 0, l);
    check('…starts with the fixed head and ends with "."', l.startsWith('How you are today: ') && l.endsWith('.'), l);
  }
  const a = line(audA(), A);
  check('mood fragment kept first when trimming', a.startsWith('How you are today: very tired'), a);
  check('no partial fragment (never cut mid-word)', !/\w$/.test(a.slice(0, -1)) || a.endsWith('.'));
}

// ── no cache: revoke / deleted / mismatched basis ──────────────────────────
section('basis re-read by PK on every call (no cache)');
{
  const dRev = await digest(G2, { todayNote: 'a quiz night win', threads: ['the quiz rematch'] });
  store.setElementStatus(store.activeElements(clock.now()).filter(e => e.kind === 'today').map(e => e.id), 'done');
  ss.applyToday([{ digestId: dRev.id, chatJid: G2 }]);
  check('G2 shows its today pick', line(audG2(), G2).includes('quiz night'));
  relationshipStore.onMessageRevoked(dRev.msg.id, G2);
  check('…the digest is gone after the revoke', store.getDigest(dRev.id) === null);
  check('…and the very next line omits the element', !line(audG2(), G2).includes('quiz night'), line(audG2(), G2));

  // A basis row whose chat/period no longer matches origins_json (rowid reuse) is dropped.
  const dX = await digest(G2, { todayNote: 'a board game marathon' });
  ss.applyToday([{ digestId: dX.id, chatJid: G2 }]);
  check('G2 shows the new pick', line(audG2(), G2).includes('board game'));
  db.prepare('UPDATE mind_digests SET chat_jid = ? WHERE id = ?').run(G, dX.id);
  check('basis now points at another chat → not rendered anywhere',
    !line(audG2(), G2).includes('board game') && !line(audG(), G).includes('board game'));
  // AUTOINCREMENT: deleting the max digest then inserting one for another chat never reuses its id.
  const maxId = db.prepare('SELECT MAX(id) FROM mind_digests').pluck().get();
  db.prepare("DELETE FROM item_evidence WHERE item_type = 'mind_digest' AND item_id = ?").run(maxId);
  db.prepare('DELETE FROM mind_digests WHERE id = ?').run(maxId);
  const dY = await digest(G, { todayNote: 'other chat note' });
  check('a new digest after deleting the max one gets a new id', dY.id > maxId, [dY.id, maxId]);
}

// ── self-mention budget ────────────────────────────────────────────────────
section('today vs the self-mention budget');
{
  ss.applyToday([{ digestId: dG.id, chatJid: G }]);
  // Life on: its own 24 h self-mention budget (claims.js) decides.
  life.on = true;
  life.overBudget = (chat) => chat === G;
  check('life on, over budget in G → no today fragment', !line(audG(), G).includes('muddy'));
  life.overBudget = () => false;
  check('…back under budget → today again', line(audG(), G).includes('muddy'));
  const lifeTracked = [];
  for (let i = 0; i < 4; i++) lifeTracked.push(ss.renderLine(audG(), { chatJid: G, track: true }).includes('muddy'));
  eq('life on: tracked renders do not use the mind count (life decides)', lifeTracked, [true, true, true, true]);
  life.on = false;
  // Life off with the facade function present: claims.js never counts then (its
  // onReplySent runs only while life is on), so the mind's own count applies.
  life.overBudget = () => false;
  const offSeen = [];
  for (let i = 0; i < 5; i++) offSeen.push(ss.renderLine(audG(), { chatJid: G, track: true }).includes('muddy'));
  eq('life off: own budget, 3 tracked renders carry today, then none', offSeen, [true, true, true, false, false]);
  check('untracked (preview) renders do not count and still obey the budget', !line(audG(), G).includes('muddy'));
  // Without the facade function: the same own count (in G2, a fresh chat-day key).
  ss.applyToday([{ digestId: dG2.id, chatJid: G2 }]);
  const lite = { isLifeOn: () => false, lifeGuardNote: () => null };
  const saved = life;
  life = lite;
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(ss.renderLine(audG2(), { chatJid: G2, track: true }).includes('novel'));
  eq('no facade function: 3 tracked renders carry today, then none', seen, [true, true, true, false, false]);
  life = saved;
}

// ── notes and reply length ─────────────────────────────────────────────────
section('SELF_NOTE and the replyLength line');
{
  eq('SELF_NOTE when the line renders and life note not emitted',
    ss.selfStateNote({ lifeNoteEmitted: false, line: 'How you are today: calm.' }), ss.SELF_NOTE);
  eq('no SELF_NOTE when LIFE_SITUATION_NOTE was emitted', ss.selfStateNote({ lifeNoteEmitted: true, line: 'x' }), '');
  eq('no SELF_NOTE for an empty line', ss.selfStateNote({ lifeNoteEmitted: false, line: '' }), '');
  replyLen = 'shorter';
  eq('shorter → "Keep replies brief."', ss.replyLengthLine(G), 'Keep replies brief.');
  replyLen = 'longer';
  eq('longer → "You can say a bit more."', ss.replyLengthLine(G), 'You can say a bit more.');
  check('…≤ 30 chars', ss.replyLengthLine(G).length <= 30);
  eq('renders even when the self-state line is empty (imitating)', [line(audG(), G, { imitation: { t: 1 } }), ss.replyLengthLine(G)],
    ['', 'You can say a bit more.']);
  replyLen = 'normal';
  eq('normal → ""', ss.replyLengthLine(G), '');
  mindOn = false;
  replyLen = 'shorter';
  eq('mind off → ""', ss.replyLengthLine(G), '');
  mindOn = true;
  replyLen = 'normal';
}

// ── morning reset ──────────────────────────────────────────────────────────
section('sleep staging + morning reset');
{
  const map = buildLabelMap([{ chatJid: G, digestId: dG.id }]);
  const before = line(audG(), G);
  const sid = ss.applyMood({ word: 'content', intensity: 0.8 }, { labelMap: map, morning: true });
  ss.applyIntentions([{ kind: 'follow_up', targetChat: G, basis: [{ digestId: dG.id, chatJid: G, thread: 1 }], ttlHours: 10 }],
    { morning: true });
  eq('staged morning rows never render', line(audG(), G), before);
  const sleptAt = clock.now();
  clock.advance({ hours: 7 });
  const r = ss.morningReset({ sleptAt });
  const mood = store.getElement(r.mood);
  eq('morning reset halves the staged mood intensity', [mood.word, mood.intensity], ['content', 0.4]);
  eq('…origins kept', mood.origins.map(o => o.originJid), [G]);
  eq('…staged row consumed', store.getElement(sid).status, 'done');
  eq("today picks made before the night are ended", store.activeElements(clock.now()).filter(e => e.kind === 'today').length, 0);
  const it = store.getElement(r.intentions[0]);
  eq('staged intention: ttl counts from the reset', it.expiresAt - it.createdAt, 10 * HOUR);
  check('…and has no stage marker any more', !it.basis.some(b => b.stage));
  const again = ss.morningReset({ sleptAt });
  eq('a second reset is a no-op', [again.mood, again.intentions.length, again.today], [null, 0, 0]);
  check('G line now shows the morning mood (G-only origins)', line(audG(), G).startsWith('How you are today: content'), line(audG(), G));
}

// ── expiry ─────────────────────────────────────────────────────────────────
section('expiry');
{
  ss.applyIntentions([{ kind: 'catch_up', target: 'self', basis: [], ttlHours: 99 }]);
  const el = store.activeElements(clock.now()).find(e => e.intentionKind === 'catch_up');
  eq('ttl clamped to intentionTtlHours (24 h)', el.expiresAt - el.createdAt, 24 * HOUR);
  clock.advance({ hours: 24, seconds: 1 });
  ss.expire(clock.now());
  eq('intentions expired after 24 h', store.activeElements(clock.now()).filter(e => e.kind === 'intention').length, 0);
  eq('mood (12 h) and base mood (6 h) expired too', store.activeElements(clock.now()).filter(e => /mood/.test(e.kind)).length, 0);
  eq('nothing left → ""', line(audG(), G), '');
}

// ── dashboard view + perf ──────────────────────────────────────────────────
section('elementsView and timing');
{
  ss.applyBaseMood({ word: 'playful', intensity: 0.5 });
  ss.applyToday([{ digestId: dA.id, chatJid: A }]);
  const v = ss.elementsView({ audience: audG(), chatJid: G });
  eq('preview = the exact line that chat would get', v.preview, line(audG(), G));
  const today = v.elements.find(e => e.kind === 'today');
  eq('DM-derived pick listed with usableIn:false for G', today.usableIn, false);
  check('elements carry origin tags', today.origins[0].originJid === A);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) ss.renderLine(audA(), { chatJid: A, track: false });
  const per = (performance.now() - t0) / 200;
  check(`renderLine incl. resolveAudience-free path < 2 ms (${per.toFixed(3)} ms)`, per < 2);
  eq('no network used', net.length, 0);
}

ss.__setDepsForTest(null);
report();
