// T008a — the 006 seams the mind reads and hooks into (spec 008 T005–T008):
// src/memory/mindReads.js (ELIGIBLE parity with batch learning, scan, digest lines,
// episodes, the "don't text me first" lookback, names, style counts),
// src/memory/recall.js (episode kind; default recall and recallFallback exclude
// episodes; recallEpisodes over the 006 audience matrix),
// src/memory/relationshipStore.js (ITEM_TABLES.mind_digest; onItemsDeleted on
// forget/revoke/edit/purge; a throwing listener never undoes a revoke; purge fences
// no_learn, deletes digests and subject-NULL episodes by chat and by evidence, runs
// onPersonPurged, and a throwing purge hook rolls the whole purge back; unsupersede)
// and src/brain/usage.js getUsageByCaller. Scratch DB, no network, no model.
import fs from 'fs';
import path from 'path';
import {
  setupScratchDb, blockNetwork, seedPerson, seedGroup, seedMessage, setBot,
  section, check, eq, throws, report, DAY, HOUR, PROJECT_ROOT,
} from './_helpers.js';

const { db } = await setupScratchDb();
blockNetwork();
const reads = await import('../../src/memory/mindReads.js');
const recallMod = await import('../../src/memory/recall.js');
const store = await import('../../src/memory/relationshipStore.js');
const mindStore = await import('../../src/mind/store.js');
const usage = await import('../../src/brain/usage.js');

const NOW = Math.floor(Date.now() / 1000);
const BOT = await setBot();                       // { pn, lid } bare
const BOT_PN = BOT.pn;

// People (invented names). D and F get purged. E joined G late.
const A = await seedPerson({ jid: '82001@lid', name: 'Avery', pn: '15550002001@s.whatsapp.net' });
const B = await seedPerson({ jid: '82002@lid', name: 'Blake' });
const C = await seedPerson({ jid: '82003@lid', name: 'Casey' });
const D = await seedPerson({ jid: '82004@lid', name: 'Drew', pn: '15550002004@s.whatsapp.net' });
const E = await seedPerson({ jid: '82005@lid', name: 'Emery' });
const F = await seedPerson({ jid: '82006@lid', name: 'Finley' });
const A_PN = '15550002001@s.whatsapp.net';
const D_PN = '15550002004@s.whatsapp.net';
const D_DEV = '15550002004:7@s.whatsapp.net';     // a device-suffixed DM form

const OLD = NOW - 100 * DAY;
const G = await seedGroup({ jid: '120363000000082001@g.us', name: 'Weekend Crew', at: OLD,
  members: [A, B, D, F, { jid: E, joinedAt: NOW - 1 * DAY }] });
const G2 = await seedGroup({ jid: '120363000000082002@g.us', name: 'Two of us', at: OLD, members: [A, B] });       // ⊆ G
const G3 = await seedGroup({ jid: '120363000000082003@g.us', name: 'Mixed', at: OLD, members: [A, C] });           // C ∉ G
const G4 = await seedGroup({ jid: '120363000000082004@g.us', name: 'Late', at: OLD, members: [A, E] });            // E joined G late

const aud = (chatJid, kind) => recallMod.resolveAudience({ chatJid, kind });
const audG = aud(G); const audG2 = aud(G2); const audG3 = aud(G3); const audG4 = aud(G4);
const audA = aud(A_PN, 'dm'); const audB = aud(B, 'dm'); const audC = aud(C, 'dm');

const msg = (o) => seedMessage(o);
const episode = (o) => store.addMemory({ category: 'episode', subjectJid: null, source: 'mind', importance: 0.5, ...o });
const exists = (table, id) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
const noLearn = (id) => db.prepare('SELECT no_learn FROM messages WHERE id = ?').pluck().get(id);
const digest = (chatJid, kind, evidence, extra = {}) => mindStore.insertDigest({
  chatJid, originKind: kind, fromRowid: 0, toRowid: 1, periodStart: NOW - DAY, periodEnd: NOW,
  summary: 'a summary', tone: 'neutral', evidence: evidence.map(m => ({ msgId: m.id, ts: m.ts })), ...extra,
});

// ── ELIGIBLE parity + scan ────────────────────────────────────────────────
section('ELIGIBLE parity with batch learning');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src/memory/learningPipeline.js'), 'utf-8');
  const m = src.match(/const ELIGIBLE = `([^`]*)`;/);
  check('learningPipeline.js still defines ELIGIBLE', !!m);
  eq('mindReads.ELIGIBLE is the same filter, verbatim', reads.ELIGIBLE, m?.[1]);
}

let scanStart;
let mText, mReact, mFenced, mExpired, mBot, mMention, mAlias, mLong, mDmPn, mSelfChat;
section('scanSince');
{
  scanStart = db.prepare('SELECT COALESCE(MAX(rowid), 0) FROM messages').pluck().get();
  const t = NOW - 2 * HOUR;
  mText = await msg({ chat: G, sender: A, text: 'are we still on for saturday', ts: t });
  mReact = await msg({ chat: G, sender: B, text: '👍', ts: t + 1, type: 'reaction' });
  mFenced = await msg({ chat: G, sender: B, text: 'fenced line', ts: t + 2, noLearn: true });
  mExpired = await msg({ chat: G, sender: B, text: 'disappearing', ts: t + 3, expiresAt: NOW + DAY });
  mBot = await msg({ chat: G, sender: `${BOT_PN}`, text: 'sure, saturday works', ts: t + 4, fromSelf: true });
  mMention = await msg({ chat: G, sender: B, text: '@10000000000 you coming?', ts: t + 5,
    mentions: ['10000000000:1@s.whatsapp.net'] });
  mAlias = await msg({ chat: G, sender: B, text: 'tagging a friend', ts: t + 6, mentions: ['15550009999@s.whatsapp.net'] });
  mLong = await msg({ chat: G, sender: A, text: 'x'.repeat(900), ts: t + 7 });
  mDmPn = await msg({ chat: A_PN, sender: A_PN, text: 'hey, quick question', ts: t + 8 });
  mSelfChat = await msg({ chat: `${BOT_PN}`, sender: `${BOT_PN}`, text: 'note to self', ts: t + 9, fromSelf: true });

  const rows = reads.scanSince(scanStart);
  const ids = rows.map(r => r.id);
  const sqlIds = db.prepare(`SELECT id FROM messages WHERE rowid > ? AND ${reads.ELIGIBLE} ORDER BY rowid`).pluck().all(scanStart)
    .filter(id => id !== mSelfChat.id);
  eq('returns exactly the ELIGIBLE rows (minus the bot\'s own chat), oldest first', ids, sqlIds);
  check('reaction / no_learn / expires_at rows are never read',
    ![mReact.id, mFenced.id, mExpired.id].some(id => ids.includes(id)));
  check('the bot\'s own chat is skipped…', !ids.includes(mSelfChat.id));
  eq('…but lastRowid moves past it', rows.lastRowid, mSelfChat.rowid);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  eq('group row shape', [byId[mText.id].chatJid, byId[mText.id].isGroup, byId[mText.id].senderJid, byId[mText.id].isFromSelf],
    [G, true, A, false]);
  eq('DM row keyed by the canonical person (PN form stored)', [byId[mDmPn.id].chatJid, byId[mDmPn.id].isGroup,
    byId[mDmPn.id].senderJid], [A, false, A]);
  check('bot line flagged isFromSelf', byId[mBot.id].isFromSelf === true && byId[mBot.id].mentionsBot === false);
  check('@-mention of the bot\'s own id → mentionsBot', byId[mMention.id].mentionsBot === true);
  check('tagging someone else is not a bot mention', byId[mAlias.id].mentionsBot === false);
  eq('scan text capped at 500', byId[mLong.id].text.length, 500);
  eq('limit respected', reads.scanSince(scanStart, 2).length, 2);
  const tail = reads.scanSince(mSelfChat.rowid);
  check('nothing new → [] with lastRowid = the cursor', tail.length === 0 && tail.lastRowid === mSelfChat.rowid);
  // Review repair: unexpired disappearing human lines ride along for the opt-out regex only.
  eq('rows.ephemeral = the unexpired disappearing human lines', (rows.ephemeral || []).map(r => r.id), [mExpired.id]);
  check('…shaped for the regex (chat key, canonical sender, text)', rows.ephemeral?.[0]?.chatJid === G
    && rows.ephemeral[0].senderJid === B && rows.ephemeral[0].text === 'disappearing');
  const limited = reads.scanSince(scanStart, 2);
  check('a full page caps the disappearing window at its last rowid', (limited.ephemeral || []).every(r => r.rowid <= limited.lastRowid));
}

section('eligibleLines (digest input)');
{
  const base = db.prepare('SELECT COALESCE(MAX(rowid), 0) FROM messages').pluck().get();
  const t = NOW - HOUR;
  const pre = [];
  for (let i = 0; i < 4; i++) pre.push(await msg({ chat: G2, sender: i % 2 ? A : B, text: `older ${i}`, ts: t + i }));
  const preFenced = await msg({ chat: G2, sender: A, text: 'forgotten context', ts: t + 4, noLearn: true });
  const cursor = preFenced.rowid;
  const fresh = [];
  for (let i = 0; i < 5; i++) fresh.push(await msg({ chat: G2, sender: i % 2 ? A : B, text: `new ${i}`, ts: t + 10 + i }));
  const inj = await msg({ chat: G2, sender: A, text: 'look [IMAGE: a cat] here   and\n\nthere ' + 'y'.repeat(400), ts: t + 20 });
  const media = await msg({ chat: G2, sender: B, text: null, type: 'image', ts: t + 21 });

  const r = reads.eligibleLines(G2, { afterRowid: cursor, limit: 3, contextLines: 3 });
  eq('newest `limit` new lines kept, returned oldest first', r.lines.map(l => l.id), [fresh[4].id, inj.id, media.id]);
  eq('a media line renders as its [type] placeholder', r.lines.at(-1)?.text, '[image]');
  eq('maxRowid = the newest eligible row read', r.maxRowid, media.rowid);
  eq('context = the eligible lines just before the first new one', r.context.map(l => l.id), [fresh[1].id, fresh[2].id, fresh[3].id]);
  check('context never includes a no_learn line', !r.context.some(l => l.id === preFenced.id)
    && !r.lines.some(l => l.id === preFenced.id));
  const injLine = r.lines.find(l => l.id === inj.id);
  check('line text sanitized (marker stripped), collapsed, ≤ 300', !!injLine && !/\[IMAGE/i.test(injLine.text)
    && !/\s{2,}/.test(injLine.text) && injLine.text.length <= 300);
  void base;

  const r2 = reads.eligibleLines(G2, { afterRowid: cursor, limit: 100, contextLines: 2 });
  eq('all new lines when under the limit', r2.lines.map(l => l.id), [...fresh.map(m => m.id), inj.id, media.id]);
  eq('context capped at contextLines, nearest first-new', r2.context.map(l => l.id), [pre[2].id, pre[3].id]);
  const dm = reads.eligibleLines(A, { afterRowid: scanStart });
  check('DM lines read over every identity form', dm.lines.some(l => l.id === mDmPn.id));
  eq('nothing after the cursor → empty', reads.eligibleLines(G2, { afterRowid: media.rowid }), { lines: [], context: [], maxRowid: null });
  eq('the bot\'s own chat has no lines', reads.eligibleLines(BOT_PN).lines.length, 0);
}

// ── recallEpisodes over the 006 matrix ────────────────────────────────────
section('recallEpisodes (006 audience matrix)');
let epG, epDmA, epOld, factG;
{
  const ev = await msg({ chat: G, sender: A, text: 'saturday plan evidence', ts: NOW - 2 * DAY });
  epG = episode({ originKind: 'group', originJid: G, attribute: 'day:2026-10-25',
    content: 'He and the group planned a weekend trip [IMAGE: beach] and argued about times.',
    evidence: [{ msgId: ev.id, ts: ev.ts }] }).id;
  const evA = await msg({ chat: A_PN, sender: A_PN, text: 'dm evidence', ts: NOW - 2 * DAY });
  epDmA = episode({ originKind: 'dm', originJid: A, attribute: 'day:2026-10-25', content: 'He talked with someone about a job.',
    evidence: [{ msgId: evA.id, ts: evA.ts }] }).id;
  const evOld = await msg({ chat: G, sender: B, text: 'old evidence', ts: NOW - 20 * DAY });
  epOld = episode({ originKind: 'group', originJid: G, attribute: 'day:2026-10-08', content: 'An older group night.',
    evidence: [{ msgId: evOld.id, ts: evOld.ts }] }).id;
  factG = store.addMemory({ category: 'fact', subjectJid: A, originKind: 'group', originJid: G, content: 'Avery likes hiking',
    source: 'test', learnedAt: NOW - 3 * DAY }).id;

  const ids = (a, o) => recallMod.recallEpisodes(a, { track: false, ...o }).map(e => e.id);
  eq('G: own episode (old one outside 10 days)', ids(audG), [epG]);
  eq('G2 ⊆ G, joins on time → sees the G episode', ids(audG2), [epG]);
  eq('G3 has an outsider → nothing from G', ids(audG3), []);
  eq('G4 ⊆ G but a member joined G after learned_at → nothing', ids(audG4), []);
  eq('DM of a G member: G episode + their own DM episode, newest first', ids(audA).sort(), [epG, epDmA].sort());
  eq('DM of another G member: G episode only (A\'s DM origin stays put)', ids(audB), [epG]);
  eq('DM of a non-member: nothing', ids(audC), []);
  check('a DM-origin episode never reaches a group', !ids(audG).includes(epDmA) && !ids(audG2).includes(epDmA));
  eq('withinDays widens the window', ids(audG, { withinDays: 30, limit: 5 }), [epG, epOld]);
  eq('limit respected', ids(audG, { withinDays: 30, limit: 1 }), [epG]);
  const one = recallMod.recallEpisodes(audG, { track: false })[0];
  check('shape + sanitized content', one && one.attribute === 'day:2026-10-25' && one.originJid === G
    && one.originKind === 'group' && Number.isFinite(one.learnedAt) && !/\[IMAGE/i.test(one.content));
  eq('self audience → []', recallMod.recallEpisodes({ kind: 'self' }), []);
  eq('no audience → []', recallMod.recallEpisodes(null), []);
  const rc = () => db.prepare('SELECT COALESCE(recall_count, 0) FROM memories WHERE id = ?').pluck().get(epG);
  const before = rc();
  recallMod.recallEpisodes(audG, { track: false });
  eq('track:false does not bump recall_count', rc(), before);
  recallMod.recallEpisodes(audG);
  eq('default track bumps recall_count', rc(), before + 1);
  db.prepare('UPDATE memories SET learned_at = NULL WHERE id = ?').run(epOld);
  check('a NULL learned_at never passes the window (fail closed)', !ids(audG, { withinDays: 400, limit: 10 }).includes(epOld));
}

section('default recall and recallFallback exclude episodes');
{
  const def = recallMod.recall(audG, { limit: 50, track: false }).map(i => i.id);
  check('default recall: the fact, no episode', def.includes(factG) && !def.includes(epG));
  const asKind = recallMod.recall(audG, { kinds: ['episode'], limit: 50, track: false }).map(i => i.id);
  check('kinds:[episode] is an explicit opt-in', asKind.includes(epG) && !asKind.includes(factG));
  const unknownKinds = recallMod.recall(audG, { kinds: ['bogus'], limit: 50, track: false }).map(i => i.id);
  check('only unknown kinds (filtered to empty) → still excludes episodes', !unknownKinds.includes(epG));
  // kinds: 'x' (not an array) makes recall throw inside → recallFallback. The G2 probe
  // proves the fallback really ran (it has no subset path), so a future coercion of
  // `kinds` cannot turn these checks into a no-op.
  check('normal recall in G2 sees the G fact via the subset path',
    recallMod.recall(audG2, { limit: 50, track: false }).some(i => i.id === factG));
  check('the forced fallback in G2 does not (same chat only) → the catch path ran',
    !recallMod.recall(audG2, { kinds: 'x', limit: 50, track: false }).some(i => i.id === factG));
  const fb = recallMod.recall(audG, { kinds: 'x', limit: 50, track: false }).map(i => i.id);
  check('recallFallback ran (same-chat fact returned)', fb.includes(factG));
  check('recallFallback excludes episodes', !fb.includes(epG));
  const fbA = recallMod.recall(audA, { kinds: 'x', limit: 50, track: false }).map(i => i.id);
  check('recallFallback in a DM excludes its DM episode too', !fbA.includes(epDmA));
}

section('episodesFor / episodeExists');
{
  const all = reads.episodesFor(G, { current: true });
  check('own chat only, current', all.some(e => e.id === epG) && !all.some(e => e.id === epDmA));
  const one = all.find(e => e.id === epG);
  check('evidence = message ids', one && one.evidence.length === 1 && typeof one.evidence[0] === 'string');
  eq('attributes filter', reads.episodesFor(G, { attributes: ['DAY:2026-10-08'] }).map(e => e.id), [epOld]);
  eq('DM key (a PN form resolves to the person)', reads.episodesFor(A_PN).map(e => e.id), [epDmA]);
  check('episodeExists true for a written key (case-insensitive)', reads.episodeExists(G, 'Day:2026-10-25'));
  check('episodeExists false for an unwritten key', !reads.episodeExists(G, 'day:2026-01-01'));
  check('episodeExists false for another chat', !reads.episodeExists(G2, 'day:2026-10-25'));
}

// ── forget / revoke / edit cascade ────────────────────────────────────────
section('forget / revoke / edit → mind_digest cascade + onItemsDeleted');
{
  const events = [];
  const off = store.onItemsDeleted((_db, info) => events.push(info));

  // Revoke: a group message that a digest and an episode cite.
  const m1 = await msg({ chat: G, sender: B, text: 'revoked soon', ts: NOW - 3 * HOUR });
  const m2 = await msg({ chat: G, sender: A, text: 'stays', ts: NOW - 3 * HOUR + 1 });
  const dg = digest(G, 'group', [m1, m2]);
  const ep = episode({ originKind: 'group', originJid: G, attribute: 'day:2026-10-27', content: 'A revoke-test night.',
    evidence: [{ msgId: m1.id, ts: m1.ts }, { msgId: m2.id, ts: m2.ts }] }).id;
  const keep = digest(G, 'group', [m2]);
  const r = store.onMessageRevoked(m1.id, G);
  check('revoke removed the message', r.removed === 1 && !exists('messages', m1.id));
  check('revoke deleted the digest it evidences', !exists('mind_digests', dg));
  eq('…and its item_evidence rows', db.prepare(`SELECT COUNT(*) FROM item_evidence WHERE item_type = 'mind_digest' AND item_id = ?`)
    .pluck().get(dg), 0);
  check('a digest not citing it stays', exists('mind_digests', keep));
  check('revoke deleted the episode', !exists('memories', ep));
  const ev = events.at(-1);
  check('onItemsDeleted fired once with cause revoke', events.length === 1 && ev.cause === 'revoke');
  eq('…chat key, msgIds', [ev.chatJid, ev.msgIds], [G, [m1.id]]);
  check('…byType names the digest and the episode', ev.byType.mind_digest?.includes(dg) && ev.byType.memory?.includes(ep));
  eq('…episodes snapshot (read before the delete)', ev.episodes, [{ id: ep, originJid: G, attribute: 'day:2026-10-27' }]);
  check('…chatForms contains the group', Array.isArray(ev.chatForms) && ev.chatForms.includes(G));

  // Revoke with chatJid = null derives the chat from the stored row (a DM, PN form).
  const md = await msg({ chat: A_PN, sender: A_PN, text: 'dm revoke', ts: NOW - 2 * HOUR });
  store.onMessageRevoked(md.id, null);
  const evd = events.at(-1);
  check('revoke without chatJid → hook gets the canonical DM key + its forms', evd.cause === 'revoke' && evd.chatJid === A
    && evd.chatForms.includes(A_PN) && evd.chatForms.includes(A));

  // A revoke whose chat does not match touches nothing and fires nothing.
  const m3 = await msg({ chat: G, sender: B, text: 'other chat id', ts: NOW - 2 * HOUR });
  const n = events.length;
  store.onMessageRevoked(m3.id, G2);
  check('chat mismatch → no revoke, no hook', exists('messages', m3.id) && events.length === n);

  // Edit.
  const m4 = await msg({ chat: G, sender: B, text: 'before edit', ts: NOW - 2 * HOUR });
  const dg4 = digest(G, 'group', [m4]);
  store.onMessageEdited(m4.id, 'after edit', G);
  check('edit deleted the digest it evidences', !exists('mind_digests', dg4));
  check('edit hook: cause edit, msgIds', events.at(-1).cause === 'edit' && events.at(-1).msgIds[0] === m4.id
    && events.at(-1).chatJid === G);

  // Forget (DM): fences the requester's last lines; a DM digest citing them goes.
  const f1 = await msg({ chat: A_PN, sender: A_PN, text: 'my secret', ts: NOW - 60 });
  const dgDm = digest(A, 'dm', [f1]);
  const fr = store.forgetRecent(A, A_PN);
  check('forget fenced the line', fr.fenced >= 1 && noLearn(f1.id) === 1);
  check('forget deleted the DM digest it evidences', !exists('mind_digests', dgDm));
  const evf = events.at(-1);
  check('forget hook: cause forget, chat = the person, msgIds include the fenced line', evf.cause === 'forget'
    && evf.chatJid === A && evf.msgIds.includes(f1.id) && evf.byType.mind_digest?.includes(dgDm));

  off();
  const m5 = await msg({ chat: G, sender: B, text: 'after unsubscribe', ts: NOW - HOUR });
  const k = events.length;
  store.onMessageRevoked(m5.id, G);
  eq('unsubscribe stops notifications', events.length, k);
}

section('a throwing forget/revoke/edit listener never undoes the change');
{
  const seen = [];
  const offs = [
    store.onItemsDeleted((d) => {   // writes, then throws: its write must roll back (savepoint)
      d.prepare(`INSERT INTO dashboard_audit (actor, action, target, payload_json) VALUES ('test', 'listener.partial', 'x', '{}')`).run();
      throw new Error('mind bug');
    }),
    store.onItemsDeleted(async () => { /* async: not allowed, logged */ }),
    store.onItemsDeleted((_d, info) => seen.push(info.cause)),
  ];
  const m = await msg({ chat: G, sender: B, text: 'revoke with a broken listener', ts: NOW - HOUR });
  const dg = digest(G, 'group', [m]);
  let threw = false;
  try { store.onMessageRevoked(m.id, G); } catch { threw = true; }
  check('revoke does not throw', !threw);
  check('the message is still revoked and its digest deleted', !exists('messages', m.id) && !exists('mind_digests', dg));
  check('the failing listener\'s partial write was rolled back', !db.prepare(`SELECT 1 FROM dashboard_audit WHERE action = 'listener.partial'`).get());
  eq('later listeners still ran', seen, ['revoke']);
  const me = await msg({ chat: G, sender: B, text: 'edit with a broken listener', ts: NOW - HOUR });
  const r = store.onMessageEdited(me.id, 'edited', G);
  check('edit still applied', r.updated === 1 && db.prepare('SELECT content FROM messages WHERE id = ?').pluck().get(me.id) === 'edited');
  const mf = await msg({ chat: B, sender: B, text: 'forget me', ts: NOW - 30 });
  const fr = store.forgetRecent(B, B);
  check('forget still fenced', fr.fenced >= 1 && noLearn(mf.id) === 1);
  for (const off of offs) off();
}

// ── purge ─────────────────────────────────────────────────────────────────
section('purgePerson: no_learn, digests and episodes by chat and evidence, hooks');
{
  const t = NOW - 5 * HOUR;
  const dG = await msg({ chat: G, sender: D, text: 'D in the group', ts: t });
  const aG = await msg({ chat: G, sender: A, text: 'A in the group', ts: t + 1 });
  const aOnly = await msg({ chat: G, sender: A, text: 'A only', ts: t + 2 });
  const dDm1 = await msg({ chat: D_PN, sender: D_PN, text: 'D in their DM', ts: t + 3 });
  const dDm2 = await msg({ chat: D_DEV, sender: D_DEV, text: 'D from a device', ts: t + 4 });
  const botDm = await msg({ chat: D_PN, sender: BOT_PN, text: 'bot reply in D\'s DM', ts: t + 5, fromSelf: true });

  const epByD = episode({ originKind: 'group', originJid: G, attribute: 'day:2026-10-26', content: 'A night D was part of.',
    evidence: [{ msgId: dG.id, ts: dG.ts }, { msgId: aG.id, ts: aG.ts }] }).id;
  const epNoD = episode({ originKind: 'group', originJid: G2, attribute: 'day:2026-10-26', content: 'A night without D.',
    evidence: [{ msgId: aOnly.id, ts: aOnly.ts }] }).id;
  const factByD = store.addMemory({ category: 'fact', subjectJid: A, originKind: 'group', originJid: G,
    content: 'Avery has a new bike', source: 'test', evidence: [{ msgId: dG.id, ts: dG.ts }] }).id;
  const dgByD = digest(G, 'group', [dG, aG]);
  const dgNoD = digest(G, 'group', [aOnly]);
  const dgDm = digest(D, 'dm', []);          // keyed by chat, no evidence
  const dgDmPn = digest(D_PN, 'dm', []);     // a stale non-canonical key form

  const items = []; const purged = [];
  const offA = store.onItemsDeleted((_d, info) => items.push(info));
  const offB = store.onPersonPurged((d, person, forms) => {
    purged.push({ person, forms });
    // Hook runs inside the transaction: the deletes are visible to it already.
    purged.at(-1).digestGone = !d.prepare('SELECT 1 FROM mind_digests WHERE id = ?').get(dgByD);
  });

  const res = store.purgePerson(D, 'test', 'owner:test');
  check('purge returns a count', res.deleted > 0);
  eq('D\'s own group line fenced', noLearn(dG.id), 1);
  eq('A\'s group lines untouched', [noLearn(aG.id), noLearn(aOnly.id)], [0, 0]);
  eq('every line of D\'s DM fenced (device form and the bot\'s replies included)', [noLearn(dDm1.id), noLearn(dDm2.id),
    noLearn(botDm.id)], [1, 1, 1]);
  check('subject-NULL group episode evidenced by D deleted', !exists('memories', epByD));
  check('episode without D\'s evidence kept', exists('memories', epNoD));
  check('a non-episode fact about someone else stays (006 semantics unchanged)', exists('memories', factByD));
  check('group digest evidenced by D deleted, other kept', !exists('mind_digests', dgByD) && exists('mind_digests', dgNoD));
  check('D\'s DM digests deleted by chat key (every form)', !exists('mind_digests', dgDm) && !exists('mind_digests', dgDmPn));
  eq('no orphan mind_digest evidence', db.prepare(`SELECT COUNT(*) FROM item_evidence e WHERE e.item_type = 'mind_digest'
    AND NOT EXISTS (SELECT 1 FROM mind_digests g WHERE g.id = e.item_id)`).pluck().get(), 0);
  const pi = items.find(i => i.cause === 'purge');
  check('onItemsDeleted fired with cause purge, msgIds []', !!pi && pi.chatJid === D && Array.isArray(pi.msgIds)
    && pi.msgIds.length === 0 && pi.chatForms.includes(D_PN));
  check('…byType names the deleted digests and episode', pi && [dgByD, dgDm, dgDmPn].every(id => pi.byType.mind_digest?.includes(id))
    && pi.byType.memory?.includes(epByD));
  check('…episodes snapshot has the group episode', pi && pi.episodes.some(e => e.id === epByD && e.originJid === G));
  eq('onPersonPurged ran once with the person and every form', purged.map(p => [p.person, p.forms.includes(D_PN)]), [[D, true]]);
  check('onPersonPurged runs after the deletes', purged[0]?.digestGone === true);
  check('purge audited', !!db.prepare(`SELECT 1 FROM dashboard_audit WHERE action = 'memory.purge' AND target = ?`).get(D));
  const after = reads.scanSince(scanStart).map(r => r.id);
  check('mind scan no longer reads D\'s lines', ![dG.id, dDm1.id, dDm2.id, botDm.id].some(id => after.includes(id)));
  offA(); offB();
}

section('a throwing purge hook rolls the whole purge back');
{
  const t = NOW - 4 * HOUR;
  const fG = await msg({ chat: G, sender: F, text: 'F in the group', ts: t });
  const fDm = await msg({ chat: F, sender: F, text: 'F in their DM', ts: t + 1 });
  const epF = episode({ originKind: 'group', originJid: G, attribute: 'day:2026-10-24', content: 'A night with F.',
    evidence: [{ msgId: fG.id, ts: fG.ts }] }).id;
  const memF = store.addMemory({ category: 'fact', subjectJid: F, originKind: 'group', originJid: G, content: 'Finley plays chess',
    source: 'test', learnedAt: t }).id;
  const dgF = digest(F, 'dm', [fDm]);
  const audits = () => db.prepare(`SELECT COUNT(*) FROM dashboard_audit WHERE action = 'memory.purge' AND target = ?`).pluck().get(F);

  const intact = (label) => {
    check(`${label}: memories, episode, digest, identities and no_learn all intact`,
      exists('memories', memF) && exists('memories', epF) && exists('mind_digests', dgF)
      && noLearn(fG.id) === 0 && noLearn(fDm.id) === 0
      && !!db.prepare('SELECT 1 FROM person_identities WHERE person_jid = ?').get(F) && audits() === 0);
  };

  const off1 = store.onPersonPurged(() => { throw new Error('mind purge hook failed'); });
  throws('purgePerson throws when an onPersonPurged hook throws', () => store.purgePerson(F, 'test'), /mind purge hook failed/);
  intact('onPersonPurged error');
  off1();

  const off2 = store.onItemsDeleted((_d, info) => { if (info.cause === 'purge') throw new Error('items hook failed'); });
  throws('purgePerson throws when an onItemsDeleted listener throws under purge', () => store.purgePerson(F, 'test'), /items hook failed/);
  intact('onItemsDeleted error');
  off2();

  const off3 = store.onPersonPurged(async () => {});
  throws('an async purge hook is refused (it could not roll back)', () => store.purgePerson(F, 'test'), /synchronous/);
  intact('async hook');
  off3();

  const r = store.purgePerson(F, 'test');
  check('with the hooks gone the purge goes through', r.deleted > 0 && !exists('memories', memF) && !exists('memories', epF)
    && !exists('mind_digests', dgF) && noLearn(fG.id) === 1);
  throws('onItemsDeleted needs a function', () => store.onItemsDeleted(null), /function/);
  throws('onPersonPurged needs a function', () => store.onPersonPurged('x'), /function/);
}

// ── unsupersede ───────────────────────────────────────────────────────────
section('unsupersede');
{
  const t = NOW - 6 * DAY;
  const e1 = await msg({ chat: G2, sender: A, text: 'night one', ts: t });
  const e2 = await msg({ chat: G2, sender: B, text: 'night two', ts: t + DAY });
  const ew = await msg({ chat: G2, sender: A, text: 'weekly only', ts: t + 2 * DAY });
  const d1 = episode({ originKind: 'group', originJid: G2, attribute: 'day:2026-10-21', content: 'Daily one.',
    evidence: [{ msgId: e1.id, ts: e1.ts }] }).id;
  const d2 = episode({ originKind: 'group', originJid: G2, attribute: 'day:2026-10-22', content: 'Daily two.',
    evidence: [{ msgId: e2.id, ts: e2.ts }] }).id;
  const w = episode({ originKind: 'group', originJid: G2, attribute: 'week:2026-10-21', content: 'The week.',
    replaces: [d1, d2], expiresInDays: 365, evidence: [{ msgId: ew.id, ts: ew.ts }] }).id;
  const sup = (id) => db.prepare('SELECT superseded_by FROM memories WHERE id = ?').pluck().get(id);
  eq('the weekly supersedes both dailies', [sup(d1), sup(d2)], [w, w]);
  eq('superseder alive → nothing to clear', store.unsupersede([d1, d2]), 0);
  const seen = () => recallMod.recallEpisodes(audG2, { track: false, limit: 10 }).map(e => e.id);
  check('recall shows the weekly, not the dailies', seen().includes(w) && !seen().includes(d1));
  store.onMessageRevoked(ew.id, G2);
  check('the weekly is gone; dailies still point at it', !exists('memories', w) && sup(d1) === w && sup(d2) === w);
  check('…and are invisible to recall', !seen().includes(d1) && !seen().includes(d2));
  eq('unsupersede clears both', store.unsupersede([d1, d2, 'x', null]), 2);
  check('the dailies are back in recall', seen().includes(d1) && seen().includes(d2));
  eq('re-running is a no-op', store.unsupersede([d1, d2]), 0);
  // A dead superseder but a current row with the same fingerprint → skipped (unique index).
  const e3 = await msg({ chat: G2, sender: A, text: 'night three', ts: t + 3 * DAY });
  const d3 = episode({ originKind: 'group', originJid: G2, attribute: 'day:2026-10-24', content: 'Daily three.',
    evidence: [{ msgId: e3.id, ts: e3.ts }] }).id;
  const fp = db.prepare('SELECT fingerprint FROM memories WHERE id = ?').pluck().get(d3);
  db.prepare('UPDATE memories SET superseded_by = 999999, superseded_at = ? WHERE id = ?').run(NOW, d3);
  db.prepare(`INSERT INTO memories (category, content, origin_kind, origin_jid, fingerprint, created_at)
    VALUES ('episode', 'Daily three.', 'group', ?, ?, ?)`).run(G2, fp, NOW);
  eq('a fingerprint clash is skipped, not thrown', store.unsupersede([d3]), 0);
  eq('empty input → 0', store.unsupersede([]), 0);
}

// ── names ─────────────────────────────────────────────────────────────────
section('nameSet / namesOf');
{
  db.prepare('UPDATE people SET real_name = ? WHERE jid = ?').run('Avery Quinlan', A);
  db.prepare(`INSERT OR IGNORE INTO people (jid, push_name) VALUES (?, ?)`).run(`${BOT.lid}`, 'SelfName');
  const nick = (person, nickname, group = null) => db.prepare(`INSERT INTO nicknames (person_jid, nickname, origin_kind,
    origin_jid) VALUES (?, ?, 'group', ?)`).run(person, nickname, group || G);
  nick(A, 'Ave');
  nick(B, 'Big Blake', G2);
  nick(C, 'Cee');
  db.prepare(`INSERT INTO ig_members (username, display_name, person_jid, is_self) VALUES (?, ?, ?, 0), (?, ?, NULL, 0), (?, ?, NULL, 1)`)
    .run('avery.q', 'Avery Q', A, 'stranger_ig', 'Some Stranger', 'bot_self_ig', 'Bot Self');
  const all = reads.nameSet();
  const want = ['avery', 'avery quinlan', 'quinlan', 'blake', 'casey', 'emery', 'ave', 'big blake', 'cee',
    'weekend crew', 'two of us', 'mixed', 'avery.q', 'stranger_ig', 'some stranger'];
  const missing = want.filter(n => !all.has(n));
  eq('every person name, nickname, group name and IG member is covered', missing, []);
  check('person-name words of ≥ 3 letters are added; shorter ones are not', all.has('big') && all.has('quinlan')
    && !all.has('q'));
  check('the bot\'s own people row and IG self are left out', !all.has('selfname') && !all.has('bot_self_ig') && !all.has('bot self'));
  check('group names stay whole (no common-word fragments)', !all.has('weekend') && !all.has('crew'));
  const a = reads.namesOf(A_PN);
  check('namesOf(A) via a PN form: push, real, nickname, linked IG', ['avery', 'avery quinlan', 'ave', 'avery.q', 'avery q']
    .every(n => a.has(n)));
  check('namesOf(A) has no one else\'s names', !a.has('blake') && !a.has('cee') && !a.has('stranger_ig'));
  eq('namesOf(unknown) → empty', reads.namesOf('99999@lid').size, 0);
  eq('namesOf(the bot) → empty', reads.namesOf(`${BOT_PN}`).size, 0);
}

// ── don't-text lookback ───────────────────────────────────────────────────
section('dontTextLookback');
{
  const t = NOW - 10 * DAY;
  const hit = await msg({ chat: G3, sender: C, text: 'please stop texting me first', ts: t });
  const hitDm = await msg({ chat: C, sender: C, text: "don't message me randomly", ts: t + DAY });
  await msg({ chat: G3, sender: C, text: 'see you at the game', ts: t + 2 * DAY });
  await msg({ chat: G3, sender: A, text: 'stop texting me', ts: t + 2 * DAY });                    // someone else
  const fenced = await msg({ chat: C, sender: C, text: 'leave me alone', ts: t + 3 * DAY, noLearn: true });
  const old = await msg({ chat: C, sender: C, text: 'stop texting me', ts: NOW - 300 * DAY });
  const ids = (since, o) => reads.dontTextLookback(C, since, o).map(r => r.id);
  eq('their matching lines only, newest first', ids(NOW - 180 * DAY), [hitDm.id, hit.id]);
  check('no_learn and older-than-window lines excluded', !ids(NOW - 180 * DAY).includes(fenced.id)
    && !ids(NOW - 180 * DAY).includes(old.id));
  const r = reads.dontTextLookback(C, NOW - 180 * DAY)[0];
  check('row shape { id, ts, text }', r && typeof r.text === 'string' && Number.isFinite(r.ts));
  db.prepare(`INSERT INTO mind_exclusions (kind, jid, source, cleared_at, created_at) VALUES ('person', ?, 'owner_cleared', ?, ?)`)
    .run(C, t + DAY + 10, NOW);
  eq('only after the person\'s cleared_at', ids(NOW - 180 * DAY), []);
  db.prepare(`DELETE FROM mind_exclusions WHERE jid = ?`).run(C);
  eq('custom tokens', ids(NOW - 180 * DAY, { tokens: ['game'] }).length, 1);
  eq('unknown person → []', reads.dontTextLookback('99999@lid', 0), []);

  // Review fix: the FTS prefilter covers every regex verb (call, reach out), and a
  // chatty person's later "text"/"msg" lines cannot push an older opt-out past the cap.
  const t2 = NOW - 150 * DAY;
  const optOut = await msg({ chat: C, sender: C, text: 'stop texting me first please', ts: t2 });
  const callOut = await msg({ chat: G3, sender: C, text: 'never call me unless I ask', ts: t2 + HOUR });
  const reachOut = await msg({ chat: C, sender: C, text: 'do not reach out to me first', ts: t2 + 2 * HOUR });
  for (let i = 0; i < 30; i++) {
    await msg({ chat: G3, sender: C, text: `i will text you the msg about the dm thing ${i}`, ts: t2 + DAY + i * HOUR });
  }
  const got = ids(NOW - 180 * DAY);
  check('an older opt-out survives 30 newer chatty text/msg/dm lines', got.includes(optOut.id));
  check('"never call me unless…" is fetched (call is a lookback token)', got.includes(callOut.id));
  check('"do not reach out to me first" is fetched (reach is a lookback token)', got.includes(reachOut.id));
  check('lines without a negation are not fetched by the default query', got.length < 10);

  // Review fix (R16): a failing read returns null (never []), so the caller fails closed.
  db.exec('ALTER TABLE messages_fts RENAME TO messages_fts_off');
  let failed;
  try { failed = reads.dontTextLookback(C, NOW - 180 * DAY); } finally { db.exec('ALTER TABLE messages_fts_off RENAME TO messages_fts'); }
  eq('a failed read → null (not [])', failed, null);
  check('…and the table is back', ids(NOW - 180 * DAY).includes(optOut.id));
}

// ── style stats ───────────────────────────────────────────────────────────
section('styleStats (the bot\'s own lines, counts only)');
{
  db.prepare('UPDATE messages SET no_learn = 1 WHERE is_from_self = 1').run();   // isolate this section's lines
  const t = NOW - HOUR;
  const lines = ['sure thing 😄', 'what time?', 'γεια σου', 'ok γεια', 'WOW nice!', 'hmm...'];
  for (let i = 0; i < lines.length; i++) await msg({ chat: G, sender: `${BOT_PN}`, text: lines[i], ts: t + i, fromSelf: true });
  await msg({ chat: G, sender: A, text: 'not the bot?', ts: t + 10 });
  const s = reads.styleStats(t - 1);
  eq('message count', s.msgs, 6);
  check('rates are numbers in 0..1', [s.emojiRate, s.questionRate, s.langMix.latin, s.langMix.other, s.langMix.mixed,
    s.markers.exclaim, s.markers.ellipsis, s.markers.caps, s.markers.lowerStart].every(x => typeof x === 'number' && x >= 0 && x <= 1));
  eq('emoji / question shares', [s.emojiRate, s.questionRate], [0.167, 0.167]);
  eq('script mix (Latin only / other only / both)', s.langMix, { latin: 0.667, other: 0.167, mixed: 0.167 });
  eq('markers', s.markers, { exclaim: 0.167, ellipsis: 0.167, caps: 0.167, lowerStart: 0.833 });
  check('median length is a number', Number.isInteger(s.medianLen) && s.medianLen > 0);
  check('no strings anywhere in the result (counts only)', !JSON.stringify(s).match(/"[^"]*":"/));
  eq('nothing since → zeros', reads.styleStats(NOW + DAY).msgs, 0);
}

// ── usage by caller ───────────────────────────────────────────────────────
section('getUsageByCaller');
{
  const ins = db.prepare(`INSERT INTO llm_usage (ts, role, provider, model, input_tokens, output_tokens, cost_usd, cost_source, caller)
    VALUES (?, ?, 'p', 'm', ?, ?, ?, 'table', ?)`);
  ins.run(NOW - 100, 'mind', 1000, 200, 0.5, 'mind.think');
  ins.run(NOW - 90, 'mind', 500, 100, 0.25, 'mind.think');
  ins.run(NOW - 80, 'jev', 10, 1, null, 'mind.glance');
  ins.run(NOW - 70, 'clerk', 10, 1, 0.01, 'mindful');
  ins.run(NOW - 60, 'clerk', 10, 1, 0.02, 'mind_x');
  ins.run(NOW - 50, 'clerk', 10, 1, 0.03, 'mindXx');
  ins.run(NOW - 10 * DAY, 'mind', 1, 1, 9, 'mind.old');
  const rows = usage.getUsageByCaller('mind.', NOW - DAY);
  eq('prefix + since filter', rows.map(r => r.caller), ['mind.think', 'mind.glance']);
  const think = rows.find(r => r.caller === 'mind.think');
  eq('sums', [think.calls, think.costUsd, think.input, think.output], [2, 0.75, 1500, 300]);
  eq('unpriced cost counts 0', rows.find(r => r.caller === 'mind.glance').costUsd, 0);
  eq("'_' matches literally", usage.getUsageByCaller('mind_', NOW - DAY).map(r => r.caller), ['mind_x']);
  eq("'%' matches literally", usage.getUsageByCaller('%', 0), []);
  check('bad since → from 0 (all rows)', usage.getUsageByCaller('mind.', 'x').some(r => r.caller === 'mind.old'));
  eq('injection-shaped prefix is just data', usage.getUsageByCaller("x' OR 1=1 --", 0), []);
}

report();
