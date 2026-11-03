// Learning + memory-write suite (spec 006, T026). Batch learning runs over fixed
// scratch chat logs with a stubbed model; asserts provenance, label mapping,
// evidence rules, dedupe/supersession, learned_at vs joins, forget / revoke /
// tombstones / purge, slang scope, and the ingest-time counter. Exits non-zero if a
// check fails.
//
// Usage:  node scripts/test-memory.js
// Runs against an isolated scratch DB (data/test-memory.db), deleted on exit. No
// network: the LLM is replaced through learningPipeline.__setLlmForTest.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DB_PATH = path.join(ROOT, 'data', 'test-memory.db');
process.env.DRY_RUN = 'true';

const { config } = await import('../src/utils/config.js');
const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
const { setSelfIdentity } = await import('../src/utils/selfIdentity.js');
const membership = await import('../src/memory/membership.js');
const groupStore = await import('../src/memory/groupStore.js');
const { storeMessage } = await import('../src/memory/messageStore.js');
const store = await import('../src/memory/relationshipStore.js');
const learning = await import('../src/memory/learningPipeline.js');
const { memoryFingerprint } = await import('../src/memory/migrations/fingerprint.js');
const { resolveAudience, recall, canUseIn, recallSlang, recallNicknames, recallFacets, recallRelationships } = await import('../src/memory/recall.js');
const identity = await import('../src/memory/identity.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`); }
}

function cleanup() {
  try { closeDb(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.resolve(config.dbPath + suffix)); } catch {}
  }
}

cleanup();
process.on('exit', cleanup);
runMigrations();
const db = getDb();

// ── Fixture ──────────────────────────────────────────────────────────────────
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const T0 = NOW - 100 * DAY;
const JOIN_C = NOW - 20 * DAY;      // Carol joins G1 here

const BOT_PN = '155500001999:7@s.whatsapp.net';
const BOT_LID = '99999@lid';
setSelfIdentity({ id: BOT_PN, lid: BOT_LID });

const G1 = 'friends@g.us';          // Alice, Bob (T0), Carol (JOIN_C)
const G2 = 'work@g.us';             // Alice, Dave
const G3 = 'pair@g.us';             // Bob, Carol (both also in G1)
const ALICE = '111@lid';
const BOB = '222@lid';
const CAROL = '333@lid';
const DAVE = '444@lid';
const ALICE_PN = '155500000111@s.whatsapp.net';

const run = (sql, ...p) => db.prepare(sql).run(...p);
for (const [jid, name] of [[G1, 'Friends'], [G2, 'Work'], [G3, 'Pair']]) {
  run('INSERT INTO groups (jid, name, joined_at) VALUES (?, ?, ?)', jid, name, T0 - DAY);
}
for (const [jid, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CAROL, 'Carol'], [DAVE, 'Dave']]) {
  run('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)', jid, name, T0);
  run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', ?)`, jid, jid, T0);
}
run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'pn', 'sync', ?)`, ALICE_PN, ALICE, T0);
for (const [g, p, j] of [[G1, ALICE, T0], [G1, BOB, T0], [G1, CAROL, JOIN_C], [G2, ALICE, T0], [G2, DAVE, T0],
  [G3, BOB, T0], [G3, CAROL, T0]]) {
  groupStore.upsertMember(g, p, 'member', j);
}
for (const g of [G1, G2, G3]) membership.__markSyncedForTest(g);

let msgN = 0;
function msg(chat, sender, content, ts, extra = {}) {
  const id = `M${++msgN}`;
  storeMessage({ id, groupJid: chat, senderJid: sender, senderName: extra.name ?? null, content, messageType: extra.type || 'text',
    isFromSelf: !!extra.self, timestamp: ts });
  if (extra.expiresAt) run('UPDATE messages SET expires_at = ? WHERE id = ?', extra.expiresAt, id);
  return id;
}
function filler(chat, senders, n, ts0) {
  for (let i = 0; i < n; i++) msg(chat, senders[i % senders.length], `filler chat line ${i} about nothing much`, ts0 + i);
}
// Learning windows start "now" for each chat (as the v5 backfill seeds them).
function resetWindow(chat) {
  run(`INSERT INTO learning_state (chat_jid, msgs_since_batch, last_batch_rowid) VALUES (?, 0, (SELECT COALESCE(MAX(rowid), 0) FROM messages))
       ON CONFLICT(chat_jid) DO UPDATE SET last_batch_rowid = excluded.last_batch_rowid, msgs_since_batch = 0`, chat);
}

// Stub model: reads the roster and line ids out of the prompt, then answers with
// whatever the current test asks for (a function of those maps).
let answer = () => ({});
let lastPrompt = '';
const stubLlm = async (_system, prompt) => {
  lastPrompt = prompt;
  const roster = new Map();   // name → label
  for (const m of prompt.matchAll(/^(P\d+): (.+)$/gm)) roster.set(m[2].trim(), m[1]);
  const lines = [];           // { id, speaker, text }
  for (const m of prompt.matchAll(/^\[([LC]\d+)\] (\S+): (.*)$/gm)) lines.push({ id: m[1], speaker: m[2], text: m[3] });
  const line = (needle) => lines.find(l => l.text.includes(needle))?.id;
  const out = answer({ P: (name) => roster.get(name), line, lines, prompt });
  return typeof out === 'string' ? out : JSON.stringify(out);
};
learning.__setLlmForTest(stubLlm);
// A batch whose model call waits for release() — to land a forget / revoke mid-batch.
function gatedLlm() {
  let release;
  const gate = new Promise(r => { release = r; });
  learning.__setLlmForTest(async (system, prompt) => { await gate; return stubLlm(system, prompt); });
  return () => { release(); learning.__setLlmForTest(stubLlm); };
}

const current = (sql, ...p) => db.prepare(`SELECT * FROM memories WHERE superseded_by IS NULL AND ${sql}`).all(...p);
const evidenceOf = (type, id) => db.prepare('SELECT msg_id FROM item_evidence WHERE item_type = ? AND item_id = ?').pluck().all(type, id);

// ── 1. Group batch: provenance + label mapping ───────────────────────────────
console.log('\nGroup batch: provenance, labels, evidence rules');
let jobId, loreId, slangMsg;
{
  resetWindow(G1);
  const t = NOW - 10 * DAY;
  filler(G1, [ALICE, BOB], 10, t - 100);
  const mJob = msg(G1, ALICE, 'finally joined Zeta Labs as a designer last week', t);
  const mBob = msg(G1, BOB, 'Alice and me go way back, college roommates', t + 1);
  const mJoke = msg(G1, BOB, 'never trust the samosa guy again lol', t + 2);
  slangMsg = msg(G1, ALICE, 'that movie was pwolich ngl', t + 3);
  const mNick = msg(G1, BOB, 'ok ali, see you at 8', t + 4);
  const mBot = msg(G1, BOT_PN, 'Alice works at Globex I heard', t + 5, { self: true });
  msg(G1, CAROL, 'reaction', t + 6, { type: 'reaction' });
  msg(G1, ALICE, 'disappearing secret plan', t + 7, { expiresAt: NOW + DAY });
  filler(G1, [ALICE, BOB, CAROL], 12, t + 10);
  answer = ({ P, line }) => ({
    facts: [
      { subject: P('Alice'), category: 'fact', attribute: 'job', content: `${P('Alice')} works at Zeta Labs as a designer`,
        confidence: 0.9, evidence: [line('Zeta Labs')] },
      // BOT line only → dropped (the bot can't launder what it heard elsewhere)
      { subject: P('Alice'), category: 'fact', attribute: 'employer', content: 'Alice works at Globex', confidence: 0.9,
        evidence: [line('Globex')] },
      // unknown label → dropped, not guessed
      { subject: 'P99', category: 'fact', content: 'Someone owns a boat', confidence: 0.9, evidence: [line('Zeta Labs')] },
      // malformed item must not sink the others
      null,
      { subject: P('Bob'), content: 'x', evidence: 'nope' },
    ],
    relationships: [{ a: P('Alice'), b: P('Bob'), type: 'old friends', description: 'college roommates', strength: 0.8,
      evidence: [line('way back')] }],
    inside_jokes: [{ content: 'The samosa guy cannot be trusted', evidence: [line('samosa guy')] }],
    profiles: [{ person: P('Alice'), summary: 'designer, into films', traits: ['witty'], interests: ['films'],
      evidence: [line('pwolich')] }],
    nicknames: [{ person: P('Alice'), nickname: 'ali', used_by: P('Bob'), evidence: [line('ok ali')] },
      { person: P('Bob'), nickname: 'bobzilla', used_by: 'BOT', evidence: [line('Globex')] }],
    slang: [{ term: 'pwolich', meaning: 'awesome / great', example: line('pwolich') }],
    group_vibe: 'teasing college friends',
  });
  const counts = await learning.runBatchAnalysis(G1);
  check('batch ran and reported counts', !!counts && counts.facts === 1);

  check('prompt uses P-labels and no phone numbers / JIDs', /^P1: /m.test(lastPrompt) && !/@lid|@s\.whatsapp|9198/.test(lastPrompt));
  check('prompt marks bot lines as context only', /\] BOT: Alice works at Globex.*context only/.test(lastPrompt));
  check('reactions, disappearing messages excluded from the prompt',
    !lastPrompt.includes('disappearing secret') && !/\] \S+: reaction$/m.test(lastPrompt));

  const jobs = current("origin_jid = ? AND attribute = 'job'", G1);
  jobId = jobs[0]?.id;
  check('fact stored with origin group G1, subject Alice', jobs.length === 1 && jobs[0].origin_kind === 'group' && jobs[0].subject_jid === ALICE);
  check('label in content mapped to the name', /^Alice works at Zeta Labs/.test(jobs[0]?.content || ''));
  check('learned_at = evidence timestamp (not write time)', jobs[0]?.learned_at === t);
  check('fact evidence recorded', evidenceOf('memory', jobId).includes(mJob));
  check('fact from a BOT line is not stored', current("content LIKE '%Globex%'").length === 0);
  check('unknown label item dropped', current("content LIKE '%boat%'").length === 0);
  const lore = current("category = 'lore' AND origin_jid = ?", G1);
  loreId = lore[0]?.id;
  check('inside joke stored as lore, no subject, G1 origin', lore.length === 1 && lore[0].subject_jid === null && lore[0].learned_at === t + 2);
  const rel = db.prepare('SELECT * FROM relationships WHERE origin_jid = ?').all(G1);
  check('relationship stored with origin + learned_at + evidence', rel.length === 1 && rel[0].origin_kind === 'group'
    && rel[0].learned_at === t + 1 && evidenceOf('relationship', rel[0].id).includes(mBob));
  const facet = db.prepare('SELECT rowid AS rid, * FROM person_facets WHERE person_jid = ? AND origin_jid = ?').get(ALICE, G1);
  check('profile → G1 facet for Alice with learned_at = evidence', !!facet && facet.origin_kind === 'group'
    && facet.learned_at === t + 3 && JSON.parse(facet.interests_json).includes('films'));
  const nick = db.prepare('SELECT * FROM nicknames WHERE person_jid = ? AND nickname = ?').get(ALICE, 'ali');
  check('nickname stored in G1 scope, used_by Bob, learned_at = evidence', nick?.origin_jid === G1 && nick?.used_by === BOB
    && nick?.learned_at === t + 4 && evidenceOf('nickname', nick.id).includes(mNick));
  check('nickname used only by the bot is not learned', !db.prepare("SELECT 1 FROM nicknames WHERE nickname = 'bobzilla'").get());
  const sl = db.prepare("SELECT * FROM slang WHERE term = 'pwolich'").all();
  check('slang scoped to G1 with the cited example', sl.length === 1 && sl[0].origin_jid === G1 && /pwolich/.test(sl[0].example || ''));
  check('group vibe updated', groupStore.getGroup(G1)?.vibe === 'teasing college friends');
  check('learning window advanced', db.prepare('SELECT last_batch_rowid FROM learning_state WHERE chat_jid = ?').pluck().get(G1)
    === db.prepare('SELECT MAX(rowid) FROM messages WHERE group_jid = ?').pluck().get(G1));
  check('item stays recallable in its own group', recall(resolveAudience({ chatJid: G1 }), { limit: 50, track: false })
    .some(i => i.id === jobId));
  check('nickname recalled in G1 only', (recallNicknames(resolveAudience({ chatJid: G1 }), [ALICE]).get(ALICE) || [])
    .some(n => n.nickname === 'ali') && !(recallNicknames(resolveAudience({ chatJid: G2 }), [ALICE]).get(ALICE) || []).length);
}

// ── 1b. An owner-set vibe sticks (dashboard) ────────────────────────────────
console.log('\nOwner-set group vibe / language');
{
  groupStore.setOwnerGroupField(G1, 'vibe', 'owner says: chill planning group');
  groupStore.setOwnerGroupField(G1, 'language', 'Hindi');
  const vibeBatch = async (vibe, at) => {
    resetWindow(G1);
    filler(G1, [ALICE, BOB], 22, at);
    answer = () => ({ group_vibe: vibe });
    await learning.runBatchAnalysis(G1);
  };
  await vibeBatch('loud meme group', NOW - 9 * DAY);
  check('batch learning does not overwrite the owner\'s vibe', groupStore.getGroup(G1)?.vibe === 'owner says: chill planning group');
  check('sources say set by owner', JSON.stringify(groupStore.groupFieldSources(groupStore.getGroup(G1))) === '{"vibe":"owner","language":"owner"}');
  groupStore.releaseOwnerGroupField(G1, 'vibe');
  groupStore.releaseOwnerGroupField(G1, 'language');
  check('hand back keeps the vibe until learning writes one; language back to en', groupStore.getGroup(G1)?.vibe === 'owner says: chill planning group'
    && groupStore.getGroup(G1)?.language === 'en' && groupStore.groupFieldSources(groupStore.getGroup(G1)).vibe === 'learned');
  await vibeBatch('teasing college friends', NOW - 8 * DAY);
  check('after hand back, learning writes the vibe again', groupStore.getGroup(G1)?.vibe === 'teasing college friends');

  // Edits made before owner marks existed: the boot backfill marks them from the
  // audit log when the value still stands; a later release or a learned value wins.
  const audit = (target, changes) => db.prepare(`INSERT INTO dashboard_audit (actor, action, target, payload_json)
    VALUES ('test', 'group.patch', ?, ?)`).run(target, JSON.stringify(changes));
  groupStore.updateVibe(G1, 'old owner vibe');
  groupStore.updateLanguage(G1, 'Tamil');
  audit(G1, { vibe: 'old owner vibe', language: 'Tamil' });
  check('an unmarked non-default language already reads as the owner\'s',
    groupStore.groupFieldSources(groupStore.getGroup(G1)).language === 'owner');
  check('backfill marks a pre-mark owner vibe + language', groupStore.backfillOwnerGroupMarks() === 2
    && JSON.stringify(groupStore.groupFieldSources(groupStore.getGroup(G1))) === '{"vibe":"owner","language":"owner"}');
  await vibeBatch('loud meme group', NOW - 7 * DAY);
  check('…and learning then leaves the backfilled vibe alone', groupStore.getGroup(G1)?.vibe === 'old owner vibe');
  check('backfill is idempotent', groupStore.backfillOwnerGroupMarks() === 0);
  groupStore.releaseOwnerGroupField(G1, 'vibe');
  audit(G1, { released: ['vibe'] });
  check('a later hand back is not re-marked by the backfill', groupStore.backfillOwnerGroupMarks() === 0
    && groupStore.groupFieldSources(groupStore.getGroup(G1)).vibe === 'learned');
  groupStore.updateVibe(G2, 'learned since');
  audit(G2, { vibe: 'owner vibe learning replaced' });
  check('an audited vibe learning has since replaced is not marked', groupStore.backfillOwnerGroupMarks() === 0
    && groupStore.groupFieldSources(groupStore.getGroup(G2)).vibe === 'learned');
  groupStore.releaseOwnerGroupField(G1, 'language');
}

// ── 2. Dedupe + supersession ────────────────────────────────────────────────
console.log('\nDedupe and supersession');
{
  resetWindow(G1);
  const t = NOW - 5 * DAY;
  filler(G1, [ALICE, BOB], 12, t - 50);
  msg(G1, ALICE, 'still at zeta labs designing stuff', t);
  msg(G1, BOB, 'samosa guy strikes again', t + 1);
  msg(G1, ALICE, 'I live in Lisbon now btw', t + 2);
  filler(G1, [ALICE, BOB], 10, t + 10);
  answer = ({ P, line }) => ({
    facts: [
      // exact same claim → fingerprint merge
      { subject: P('Alice'), category: 'fact', attribute: 'job', content: 'Alice works at Zeta Labs as a designer',
        confidence: 0.9, evidence: [line('still at zeta')] },
      { subject: P('Alice'), category: 'fact', attribute: 'location', content: 'Alice lives in Lisbon', confidence: 0.9,
        evidence: [line('Lisbon')] },
    ],
    inside_jokes: [{ content: 'Samosa guy is back to his tricks', evidence: [line('strikes again')], same_as: `M${loreId}` }],
  });
  const c = await learning.runBatchAnalysis(G1);
  check('re-observation merged (no duplicate row)', current("origin_jid = ? AND attribute = 'job'", G1).length === 1 && c?.merged >= 1);
  check('merge moves learned_at to MAX(existing, new)', current('id = ?', jobId)[0]?.learned_at === t);
  check('same_as → lore re-observed, not duplicated', current("category = 'lore' AND origin_jid = ?", G1).length === 1
    && evidenceOf('memory', loreId).length === 2);

  resetWindow(G1);
  const t2 = NOW - 2 * DAY;
  filler(G1, [ALICE, BOB], 12, t2 - 50);
  msg(G1, ALICE, 'moved to Porto last weekend!', t2);
  filler(G1, [ALICE, BOB], 10, t2 + 10);
  const oldLoc = current("origin_jid = ? AND attribute = 'location'", G1)[0];
  answer = ({ P, line }) => ({
    facts: [{ subject: P('Alice'), category: 'fact', attribute: 'location', content: 'Alice moved to Porto',
      confidence: 0.9, evidence: [line('Porto')] }],
  });
  await learning.runBatchAnalysis(G1);
  const locs = current("origin_jid = ? AND attribute = 'location'", G1);
  check('contradiction supersedes (same subject + attribute + origin)', locs.length === 1 && /Porto/.test(locs[0].content)
    && db.prepare('SELECT superseded_by FROM memories WHERE id = ?').pluck().get(oldLoc.id) === locs[0].id);
  check('superseded item never recalled', !recall(resolveAudience({ chatJid: G1 }), { limit: 100, track: false })
    .some(i => i.id === oldLoc.id));

  // A DM item with the same attribute must not supersede the group's.
  const dm = store.addMemory({ category: 'fact', subjectJid: ALICE, originKind: 'dm', originJid: ALICE, attribute: 'location',
    content: 'Alice is thinking of moving to Northport', source: 'test', learnedAt: NOW - DAY });
  check('supersession is same-origin only', !dm.superseded && current("origin_jid = ? AND attribute = 'location'", G1).length === 1);
  const cross = store.addMemory({ category: 'fact', subjectJid: ALICE, originKind: 'dm', originJid: ALICE,
    content: 'Alice dislikes Porto traffic', source: 'test', learnedAt: NOW - DAY, replaces: locs[0].id });
  check('explicit replaces of another origin\'s item is refused', !cross.superseded && current('id = ?', locs[0].id).length === 1);
}

// ── 3. learned_at straddling a join ──────────────────────────────────────────
console.log('\nlearned_at vs join time');
{
  // G3 = Bob + Carol, both in G1. Carol joined G1 at JOIN_C.
  const g3 = resolveAudience({ chatJid: G3 });
  resetWindow(G1);
  const before = JOIN_C - 5 * DAY;
  filler(G1, [ALICE, BOB], 12, before - 50);
  const mOld = msg(G1, BOB, 'I have a pet iguana named Rex', before);
  filler(G1, [ALICE, BOB], 10, before + 10);
  answer = ({ P, line }) => ({
    facts: [{ subject: P('Bob'), category: 'fact', attribute: 'pet', content: 'Bob has a pet iguana named Rex',
      confidence: 0.9, evidence: [line('iguana')] }],
  });
  await learning.runBatchAnalysis(G1);
  const item = current("content LIKE '%iguana%'")[0];
  check('learned before Carol joined → not usable in G3 (Carol was not there)', !!item && item.learned_at === before
    && !canUseIn({ originJid: G1, originKind: 'group', learnedAt: item.learned_at }, g3)
    && !recall(g3, { limit: 100, track: false }).some(i => i.id === item.id));

  // Written now, evidence old → still not usable (learned_at is the evidence time).
  check('write time does not leak a pre-join item', item.created_at >= JOIN_C && item.learned_at < JOIN_C);

  // Re-derived from wholly post-join evidence → learned_at moves → usable in G3.
  resetWindow(G1);
  const after = NOW - DAY;
  filler(G1, [BOB, CAROL], 12, after - 50);
  msg(G1, BOB, 'Rex the iguana says hi', after);
  filler(G1, [BOB, CAROL], 10, after + 10);
  answer = ({ P, line }) => ({
    facts: [{ subject: P('Bob'), category: 'fact', attribute: 'pet', content: 'Bob has a pet iguana named Rex',
      confidence: 0.9, evidence: [line('says hi')] }],
  });
  await learning.runBatchAnalysis(G1);
  const re = current('id = ?', item.id)[0];
  check('post-join re-observation: learned_at = MAX(existing, new) → visible in G3', re?.learned_at === after
    && recall(g3, { limit: 100, track: false }).some(i => i.id === item.id));
  check('evidence of both observations kept', evidenceOf('memory', item.id).includes(mOld) && evidenceOf('memory', item.id).length === 2);
}

// Merged rows (facets, relationships): new evidence vouches only for what it adds.
console.log('\nlearned_at on merged facets / relationships');
{
  const g3 = resolveAudience({ chatJid: G3 });
  const before = JOIN_C - 4 * DAY;
  resetWindow(G1);
  filler(G1, [ALICE, BOB], 12, before - 50);
  msg(G1, BOB, 'honestly I cheat at every board game', before);
  msg(G1, ALICE, 'Bob and I have been rivals since school', before + 1);
  filler(G1, [ALICE, BOB], 10, before + 10);
  answer = ({ P, line }) => ({
    profiles: [{ person: P('Bob'), summary: 'OLDSUMMARY board game cheat', traits: ['oldsecrettrait'], evidence: [line('board game')] }],
    relationships: [{ a: P('Alice'), b: P('Bob'), type: 'rivals', description: 'OLDDYNAMIC school rivalry', strength: 0.7,
      evidence: [line('rivals since')] }],
  });
  await learning.runBatchAnalysis(G1);
  const rivals = db.prepare("SELECT * FROM relationships WHERE origin_jid = ? AND relationship = 'rivals'").get(G1);
  check('relationship wholly replaced by older evidence takes that evidence time (not the newer row time)',
    rivals?.learned_at === before + 1);
  const after = NOW - 2 * DAY;
  resetWindow(G1);
  filler(G1, [BOB, CAROL], 12, after - 50);
  msg(G1, CAROL, 'Bob is hilarious honestly', after);
  msg(G1, CAROL, 'Alice and Bob are friends now', after + 1);
  filler(G1, [BOB, CAROL], 10, after + 10);
  answer = ({ P, line }) => ({
    profiles: [{ person: P('Bob'), traits: ['funny'], evidence: [line('hilarious')] }],
    relationships: [{ a: P('Alice'), b: P('Bob'), type: 'friends', strength: 0.6, evidence: [line('friends now')] }],
  });
  await learning.runBatchAnalysis(G1);
  const facet = db.prepare('SELECT * FROM person_facets WHERE person_jid = ? AND origin_jid = ?').get(BOB, G1);
  check('facet merged with a later batch keeps the EARLIEST learned_at', facet?.learned_at === before
    && /funny/.test(facet.traits_json) && /oldsecrettrait/.test(facet.traits_json));
  const seen = JSON.stringify(recallFacets(g3, [BOB]).get(BOB) || {});
  check('…so a later joiner never sees the old summary / trait', !/OLDSUMMARY|oldsecrettrait/.test(seen));
  const rel = db.prepare('SELECT * FROM relationships WHERE origin_jid = ? AND relationship = ?').get(G1, 'friends');
  check('relationship partly replaced keeps the earlier learned_at', rel?.learned_at === before + 1 && /OLDDYNAMIC/.test(rel.dynamic || ''));
  check('…and the old dynamic stays out of G3', !recallRelationships(g3).some(r => /OLDDYNAMIC/.test(r.dynamic || '')));
  resetWindow(G1);
  filler(G1, [BOB, CAROL], 12, after + 100);
  msg(G1, CAROL, 'Alice and Bob are best mates, always gaming', after + 200);
  filler(G1, [BOB, CAROL], 10, after + 210);
  answer = ({ P, line }) => ({
    relationships: [{ a: P('Alice'), b: P('Bob'), type: 'best mates', description: 'always gaming together', strength: 0.8,
      evidence: [line('best mates')] }],
  });
  await learning.runBatchAnalysis(G1);
  const rel2 = db.prepare('SELECT * FROM relationships WHERE id = ?').get(rel.id);
  check('relationship wholly replaced by post-join evidence → learned_at moves forward', rel2?.learned_at === after + 200
    && recallRelationships(g3).some(r => r.relationship === 'best mates'));
}

// ── 4. DM batch: third-party fact, DM framing, no slang ──────────────────────
console.log('\nDM batch');
let dmFactId, dmMsg;
{
  resetWindow(ALICE);
  const t = NOW - 3 * 3600;
  for (let i = 0; i < 8; i++) msg(ALICE_PN, ALICE_PN, `dm chit chat ${i}`, t - 100 + i);
  dmMsg = msg(ALICE_PN, ALICE_PN, 'between us, Bob got laid off yesterday', t);
  msg(ALICE_PN, BOT_PN, 'oh no, that is rough', t + 1, { self: true });
  msg(ALICE_PN, ALICE_PN, 'yeah he is job hunting quietly', t + 2);
  answer = ({ P, line, prompt }) => ({
    facts: [{ subject: P('Bob'), category: 'event', attribute: 'job', content: 'Bob got laid off and is job hunting quietly',
      confidence: 0.9, evidence: [line('laid off'), line('job hunting')] }],
    slang: [{ term: 'quietly', meaning: 'secretly', example: line('quietly') }],
    _framing: /one-to-one/.test(prompt),
  });
  await learning.runBatchAnalysis(ALICE);
  check('DM prompt uses one-to-one framing and has no slang section', /one-to-one/.test(lastPrompt) && !/"slang"/.test(lastPrompt));
  check('third party named in the DM is a roster label', /^P\d+: Bob$/m.test(lastPrompt));
  const f = current("content LIKE '%laid off%'")[0];
  dmFactId = f?.id;
  check('third-party DM fact: subject Bob, origin Alice\'s DM', f?.subject_jid === BOB && f?.origin_kind === 'dm' && f?.origin_jid === ALICE);
  check('…recalled in Alice\'s DM', recall(resolveAudience({ chatJid: ALICE_PN }), { limit: 50, track: false }).some(i => i.id === dmFactId));
  check('…never in Bob\'s DM or any group', ![BOB, G1, G3].some(c => recall(resolveAudience({ chatJid: c }), { limit: 100, track: false })
    .some(i => i.id === dmFactId)));
  check('DM batch stores no slang', !db.prepare("SELECT 1 FROM slang WHERE term = 'quietly'").get());
  check('upsertSlang refuses a DM origin', groupStore.upsertSlang('xyz', 'abc', 'dm', ALICE, null) === null);
}

// ── 5. Revoke, edit ─────────────────────────────────────────────────────────
console.log('\nRevoke / edit');
{
  const r = store.onMessageRevoked(dmMsg);
  check('revoke drops the item learned from it and the message', r.deleted >= 1 && r.removed === 1
    && !current('id = ?', dmFactId).length && !db.prepare('SELECT 1 FROM item_evidence WHERE item_id = ? AND item_type = ?').get(dmFactId, 'memory'));
  check('revoked message gone from FTS', !db.prepare(`SELECT 1 FROM messages_fts WHERE messages_fts MATCH '"laid"'`).get());
  const slId = db.prepare("SELECT id FROM slang WHERE term = 'pwolich'").pluck().get();
  const e = store.onMessageEdited(slangMsg, 'that movie was meh');
  check('edit replaces content and drops items evidenced by the old text', e.updated === 1 && e.deleted >= 1
    && !db.prepare('SELECT 1 FROM slang WHERE id = ?').get(slId)
    && !db.prepare('SELECT 1 FROM person_facets WHERE person_jid = ? AND origin_jid = ?').get(ALICE, G1));
}

// ── 6. Forget before batch, tombstones ───────────────────────────────────────
console.log('\nForget');
{
  resetWindow(ALICE);
  const t = NOW - 60;
  for (let i = 0; i < 8; i++) msg(ALICE_PN, ALICE_PN, `more dm chat ${i}`, NOW - 3000 + i);
  const secret = msg(ALICE_PN, ALICE_PN, 'my salary is 40 lakhs, keep it quiet', t);
  // An item already learned from the secret (as if a batch had just run).
  const learned = store.addMemory({ category: 'fact', subjectJid: ALICE, originKind: 'dm', originJid: ALICE,
    content: 'Alice earns 40 lakhs', source: 'batch', evidence: [{ msgId: secret, ts: t }] });
  const res = store.forgetRecent(ALICE, ALICE_PN, { withinSec: 600, maxMessages: 5 });
  check('forget fences the recent messages and deletes their items', res.fenced >= 1 && res.deleted >= 1
    && !current('id = ?', learned.id).length
    && db.prepare('SELECT no_learn FROM messages WHERE id = ?').pluck().get(secret) === 1);
  check('older DM messages outside the window are not fenced',
    db.prepare("SELECT COUNT(*) FROM messages WHERE content LIKE 'more dm chat%' AND no_learn = 1").pluck().get() === 0);
  check('forget is audited without content', (() => {
    const a = db.prepare("SELECT * FROM dashboard_audit WHERE action = 'memory.forget' ORDER BY id DESC").get();
    return a?.actor === `person:${ALICE}` && !/salary|lakhs/.test(a.payload_json);
  })());
  const fp = memoryFingerprint({ originJid: ALICE, subjectJid: ALICE, content: 'Alice earns 40 lakhs' });
  check('fingerprint tombstoned', store.isTombstoned(fp));
  const again = store.addMemory({ category: 'fact', subjectJid: ALICE, originKind: 'dm', originJid: ALICE,
    content: 'Alice earns 40 lakhs', source: 'batch' });
  check('tombstone blocks re-learning', again.id === null && again.refused === 'tombstoned');
  const fenced = store.addMemory({ category: 'fact', subjectJid: ALICE, originKind: 'dm', originJid: ALICE,
    content: 'Alice has a big salary', source: 'batch', evidence: [{ msgId: secret, ts: t }] });
  check('a write citing a fenced message is refused (batch raced the forget)', fenced.id === null && fenced.refused === 'fenced');

  for (let i = 0; i < 8; i++) msg(ALICE_PN, ALICE_PN, `after forget ${i}`, NOW - 30 + i);
  answer = () => ({ facts: [] });
  await learning.runBatchAnalysis(ALICE);
  check('forgotten messages never reach the model', !lastPrompt.includes('salary') && lastPrompt.includes('after forget'));
}

// A batch in flight across a "forget that" / a revoke writes nothing from those lines.
console.log('\nBatch racing forget / revoke');
{
  resetWindow(ALICE);
  for (let i = 0; i < 8; i++) msg(ALICE_PN, ALICE_PN, `race dm chat ${i}`, NOW - 2000 + i);
  msg(ALICE_PN, ALICE_PN, 'Bob and Carol are secretly dating', NOW - 20);
  answer = ({ P, line }) => ({
    relationships: [{ a: P('Bob'), b: P('Carol'), type: 'dating', description: 'secret couple', strength: 0.9,
      evidence: [line('secretly dating')] }],
  });
  const done = gatedLlm();
  const pending = learning.runBatchAnalysis(ALICE);
  store.forgetRecent(ALICE, ALICE_PN, { withinSec: 600, maxMessages: 5 });
  done();
  await pending;
  check('relationship citing a message forgotten mid-batch is not written',
    !db.prepare("SELECT 1 FROM relationships WHERE relationship = 'dating'").get());

  resetWindow(G2);
  filler(G2, [ALICE, DAVE], 20, NOW - 5000);
  const kid = msg(G2, DAVE, 'that launch was kidilam', NOW - 4000);
  msg(G2, ALICE, 'Dave is my mentor here', NOW - 3999);
  filler(G2, [ALICE, DAVE], 4, NOW - 3990);
  answer = ({ P, line }) => ({
    slang: [{ term: 'kidilam', meaning: 'superb', example: line('kidilam') }],
    relationships: [{ a: P('Alice'), b: P('Dave'), type: 'mentor', description: 'kidilam mentor', strength: 0.6,
      evidence: [line('kidilam')] }],
  });
  const done2 = gatedLlm();
  const pending2 = learning.runBatchAnalysis(G2);
  check('revoke from another chat is ignored', store.onMessageRevoked(kid, G1).removed === 0
    && !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(kid));
  store.onMessageRevoked(kid, G2);
  done2();
  await pending2;
  check('slang citing a message revoked mid-batch is not written', !db.prepare("SELECT 1 FROM slang WHERE term = 'kidilam'").get());
  check('…nor a relationship citing it', !db.prepare("SELECT 1 FROM relationships WHERE relationship = 'mentor'").get());
}

// "forget that" tombstones survive an identity merge.
console.log('\nForget tombstones across a merge');
{
  const ZED_PN = '155500000321@s.whatsapp.net'; const ZED = '321@lid';
  run('INSERT INTO people (jid, phone, push_name, first_seen) VALUES (?, ?, ?, ?)', ZED_PN, '155500000321', 'Zed', T0);
  const zmsg = msg(ZED_PN, ZED_PN, 'I owe the bank 5 lakhs', NOW - 30);
  store.addMemory({ category: 'fact', subjectJid: ZED_PN, originKind: 'dm', originJid: ZED_PN,
    content: 'Zed owes the bank 5 lakhs', evidence: [{ msgId: zmsg, ts: NOW - 30 }] });
  store.forgetRecent(ZED_PN, ZED_PN);
  const merged = identity.mergePeople(ZED, ZED_PN, 'test');
  const again = store.addMemory({ category: 'fact', subjectJid: ZED, originKind: 'dm', originJid: ZED,
    content: 'Zed owes the bank 5 lakhs' });
  check('restated after the merge → still refused', merged.merged && again.id === null && again.refused === 'tombstoned');
  check('tombstone re-keyed to the kept id, text not stored',
    !!db.prepare('SELECT 1 FROM learning_exclusions WHERE origin_jid = ? AND content_key IS NOT NULL').get(ZED)
    && !JSON.stringify(db.prepare('SELECT * FROM learning_exclusions').all()).includes('lakhs'));
}

// The owner's dashboard DELETE goes through the same tombstone + hook path as forget.
console.log('\nOwner delete (dashboard)');
{
  const ev = msg(G1, BOB, 'I am moving to Northport next month', NOW - 500);
  const m = store.addMemory({ category: 'fact', subjectJid: BOB, originKind: 'group', originJid: G1,
    content: 'Bob is moving to Northport', source: 'batch', evidence: [{ msgId: ev, ts: NOW - 500 }] });
  const seen = [];
  const off = store.onItemsDeleted((_db, evt) => { seen.push(evt); });
  const r = store.deleteMemory(m.id);
  off();
  check('deleteMemory removes the row and its evidence/origin links', r.deleted === 1 && !current('id = ?', m.id).length
    && !db.prepare("SELECT 1 FROM item_evidence WHERE item_type = 'memory' AND item_id = ?").get(m.id)
    && !db.prepare("SELECT 1 FROM item_origins WHERE item_type = 'memory' AND item_id = ?").get(m.id));
  const fp = memoryFingerprint({ originJid: G1, subjectJid: BOB, content: 'Bob is moving to Northport' });
  check('a learned memory is tombstoned (fingerprint + content key)', r.tombstoned && store.isTombstoned(fp)
    && store.isTombstoned('nope', { originJid: G1, content: 'Bob is moving to Northport' }));
  const again = store.addMemory({ category: 'fact', subjectJid: BOB, originKind: 'group', originJid: G1,
    content: 'Bob is moving to Northport', source: 'batch', evidence: [{ msgId: ev, ts: NOW - 500 }] });
  check('the next batch cannot relearn it', again.id === null && again.refused === 'tombstoned');
  check("onItemsDeleted listeners run with cause 'owner', the origin chat and the deleted id",
    seen.length === 1 && seen[0].cause === 'owner' && seen[0].chatJid === G1 && seen[0].chatForms.includes(G1)
    && seen[0].byType.memory?.[0] === m.id && Array.isArray(seen[0].msgIds) && !seen[0].msgIds.length);
  check('the tombstone stores no text', !JSON.stringify(db.prepare('SELECT * FROM learning_exclusions').all()).includes('Northport'));
  const note = store.addMemory({ category: 'fact', subjectJid: BOB, originKind: 'owner', content: 'Bob prefers tea', source: 'dashboard' });
  const rn = store.deleteMemory(note.id);
  const renote = store.addMemory({ category: 'fact', subjectJid: BOB, originKind: 'owner', content: 'Bob prefers tea', source: 'dashboard' });
  check('an owner note is deleted without a tombstone (the owner may write it again)', rn.deleted === 1 && !rn.tombstoned && !!renote.id);
  const failing = store.onItemsDeleted(() => { throw new Error('listener bug'); });
  const m2 = store.addMemory({ category: 'fact', subjectJid: BOB, originKind: 'group', originJid: G1, content: 'Bob plays chess', source: 'batch' });
  const r2 = store.deleteMemory(m2.id);
  failing();
  check('a failing listener never undoes the delete', r2.deleted === 1 && !current('id = ?', m2.id).length);
  check('unknown id → nothing deleted', store.deleteMemory(99999999).deleted === 0);
}

// ── 7. Slang scope ───────────────────────────────────────────────────────────
console.log('\nSlang scope');
{
  groupStore.upsertSlang('scene', 'a problem / trouble', 'group', G1, 'ex1');
  check('one chat → not global', !db.prepare("SELECT is_global FROM slang WHERE term = 'scene'").pluck().get());
  groupStore.upsertSlang('scene', 'trouble', 'group', G2, 'ex2');
  check('≥ 2 group chats, no names → global', db.prepare("SELECT MIN(is_global) FROM slang WHERE term = 'scene'").pluck().get() === 1);
  groupStore.upsertSlang('carolmode', 'what Carol does when late', 'group', G1, null);
  groupStore.upsertSlang('carolmode', 'Carol being dramatic', 'group', G2, null);
  check('meaning naming a member stays scoped', db.prepare("SELECT MAX(is_global) FROM slang WHERE term = 'carolmode'").pluck().get() === 0);
  const g3 = recallSlang(resolveAudience({ chatJid: G3 }), 50).map(s => s.term);
  check('G3 gets the global term, not the scoped one', g3.includes('scene') && !g3.includes('carolmode'));
}

// ── 8. Ingest: counter, threshold, self-declared nickname ────────────────────
console.log('\nIngest');
{
  resetWindow(G2);
  let triggered = null;
  answer = ({ P, line }) => ({ facts: [{ subject: P('Dave'), category: 'fact', attribute: 'pet', content: 'Dave has two cats',
    confidence: 0.9, evidence: [line('two cats')] }] });
  for (let i = 0; i < 100; i++) {
    const sender = i % 2 ? ALICE : DAVE;
    const text = i === 50 ? 'I have two cats at home' : i === 51 ? 'you can call me dee' : `work talk ${i}`;
    const id = msg(G2, sender, text, NOW - 500 + i);
    const p = learning.onIngest({ id, groupJid: G2, senderJid: sender, content: text, messageType: 'text', timestamp: NOW - 500 + i });
    if (p) triggered = p;
    if (i === 0) {
      // bot / reaction messages are not counted
      learning.onIngest({ id: 'x', groupJid: G2, senderJid: BOT_PN, isFromSelf: true, content: 'hi', timestamp: NOW });
      learning.onIngest({ id: 'y', groupJid: G2, senderJid: ALICE, messageType: 'reaction', content: '👍', timestamp: NOW });
    }
  }
  check('batch triggered at the 100th human group message', !!triggered);
  await triggered;
  check('…and persisted with G2 origin', current("origin_jid = ? AND content = 'Dave has two cats'", G2).length === 1);
  check('counter reset and persisted', db.prepare('SELECT msgs_since_batch FROM learning_state WHERE chat_jid = ?').pluck().get(G2) === 0);
  const selfNick = db.prepare(`SELECT * FROM nicknames WHERE nickname = 'dee'`).get();
  check('self-declared nickname at ingest (G2 scope, learned_at = message ts)', selfNick?.person_jid === ALICE
    && selfNick?.origin_jid === G2 && selfNick?.source === 'self_declared' && selfNick?.learned_at === NOW - 500 + 51);
  const before = db.prepare('SELECT COUNT(*) FROM nicknames').pluck().get();
  const id = msg(ALICE_PN, ALICE_PN, 'call me boss', NOW);
  learning.onIngest({ id, groupJid: ALICE_PN, senderJid: ALICE_PN, content: 'call me boss', timestamp: NOW });
  check('no self-declared nickname from a DM', db.prepare('SELECT COUNT(*) FROM nicknames').pluck().get() === before);
  check('DM counter keyed by the canonical person', !!db.prepare('SELECT 1 FROM learning_state WHERE chat_jid = ?').get(ALICE)
    && !db.prepare('SELECT 1 FROM learning_state WHERE chat_jid = ?').get(ALICE_PN));
  check('the old fact regexes are gone (no "is a doctor" fact)', !current("content LIKE '%doctor%'").length);
}

// ── 9. addMemory needs an explicit origin ───────────────────────────────────
console.log('\naddMemory origin');
{
  let threw = false;
  try { store.addMemory({ category: 'fact', content: 'no origin' }); } catch { threw = true; }
  check('object form without an origin throws (fail closed)', threw);
  threw = false;
  try { store.addMemory('fact', ALICE, G1, 'Alice v0 positional note', 0.6); } catch { threw = true; }
  check('the v0 positional form is gone (throws, nothing stored)', threw && !current("content = 'Alice v0 positional note'").length);
}

// ── 10. Purge ───────────────────────────────────────────────────────────────
console.log('\nPurge');
{
  store.addMemory({ category: 'fact', subjectJid: DAVE, originKind: 'dm', originJid: DAVE, content: 'Dave DM thing', source: 'test', learnedAt: NOW });
  store.addMemory({ category: 'fact', subjectJid: ALICE, originKind: 'dm', originJid: DAVE, content: 'Dave said Alice is nice', source: 'test', learnedAt: NOW });
  store.upsertRelationship(ALICE, DAVE, 'group', G2, 'colleagues', null, 0.5, { learnedAt: NOW });
  const r = store.purgePerson(DAVE, 'test');
  const left = (sql, ...p) => db.prepare(sql).pluck().get(...p);
  check('purge removes memories about them and from their DM', r.deleted > 0
    && left("SELECT COUNT(*) FROM memories WHERE subject_jid = ? OR origin_jid = ?", DAVE, DAVE) === 0);
  check('purge removes relationships, nicknames, facets, identities',
    left('SELECT COUNT(*) FROM relationships WHERE person_a_jid = ? OR person_b_jid = ?', DAVE, DAVE) === 0
    && left('SELECT COUNT(*) FROM person_facets WHERE person_jid = ?', DAVE) === 0
    && left('SELECT COUNT(*) FROM person_identities WHERE person_jid = ?', DAVE) === 0);
  check('purge leaves orphan-free evidence', left(`SELECT COUNT(*) FROM item_evidence e WHERE e.item_type = 'memory'
    AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.item_id)`) === 0);
  check('purge audited', !!db.prepare("SELECT 1 FROM dashboard_audit WHERE action = 'memory.purge' AND target = ?").get(DAVE));
}

// ── 11. Maintenance ──────────────────────────────────────────────────────────
console.log('\nMaintenance');
{
  const old = NOW - 60 * DAY;
  const a = store.addMemory({ category: 'fact', subjectJid: BOB, originKind: 'group', originJid: G1, content: 'Bob low value never recalled',
    importance: 0.1, source: 'test', learnedAt: old });
  const b = store.addMemory({ category: 'fact', subjectJid: BOB, originKind: 'group', originJid: G1, content: 'Bob low value but recalled',
    importance: 0.1, source: 'test', learnedAt: old });
  run('UPDATE memories SET recall_count = 1, last_recalled_at = ? WHERE id = ?', NOW, b.id);
  store.decayMemories();
  check('decay removes unrecalled low-importance items, spares recalled ones', !current('id = ?', a.id).length && current('id = ?', b.id).length === 1);
  run('UPDATE memories SET superseded_at = ? WHERE superseded_by IS NOT NULL', NOW - 200 * DAY);
  const pruned = store.pruneSuperseded();
  check('superseded history pruned after 180 days', pruned > 0 && left0('SELECT COUNT(*) FROM memories WHERE superseded_by IS NOT NULL') === 0);
}
function left0(sql) { return db.prepare(sql).pluck().get(); }

// ── 12. Audit fixes (2026-10) ────────────────────────────────────────────────
console.log('\nIdentity merge keeps an unknown learned_at unknown');
{
  const YAN_PN = '155500000654@s.whatsapp.net'; const YAN = '654@lid';
  run('INSERT INTO people (jid, phone, push_name, first_seen) VALUES (?, ?, ?, ?)', YAN_PN, '155500000654', 'Yan', T0);
  run('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)', YAN, 'Yan', T0);
  const dated = T0 + 10 * DAY;
  run(`INSERT INTO person_facets (person_jid, origin_kind, origin_jid, summary, traits_json, learned_at)
    VALUES (?, 'group', ?, 'YANFACET unknown provenance', '["yantrait"]', NULL)`, YAN, G1);
  run(`INSERT INTO person_facets (person_jid, origin_kind, origin_jid, summary, traits_json, learned_at)
    VALUES (?, 'group', ?, NULL, '["yandated"]', ?)`, YAN_PN, G1, dated);
  run(`INSERT INTO nicknames (person_jid, nickname, origin_kind, origin_jid, learned_at) VALUES (?, 'yanny', 'group', ?, NULL)`, YAN, G1);
  run(`INSERT INTO nicknames (person_jid, nickname, origin_kind, origin_jid, learned_at) VALUES (?, 'yanny', 'group', ?, ?)`, YAN_PN, G1, dated);
  run(`INSERT INTO relationships (person_a_jid, person_b_jid, relationship, dynamic, origin_kind, origin_jid, learned_at)
    VALUES (?, ?, 'cousins', 'YANREL', 'group', ?, NULL)`, ...[ALICE, YAN].sort(), G1);
  run(`INSERT INTO relationships (person_a_jid, person_b_jid, relationship, origin_kind, origin_jid, learned_at)
    VALUES (?, ?, 'cousins', 'group', ?, ?)`, ...[ALICE, YAN_PN].sort(), G1, dated);
  const self = store.addMemory({ category: 'fact', originKind: 'self', originJid: 'self', content: 'YANDERIVED a derived note' });
  run(`INSERT INTO item_origins (item_type, item_id, origin_jid, min_learned_at) VALUES ('memory', ?, ?, NULL)`, self.id, YAN);
  run(`INSERT INTO item_origins (item_type, item_id, origin_jid, min_learned_at) VALUES ('memory', ?, ?, ?)`, self.id, YAN_PN, dated);
  const merged = identity.mergePeople(YAN, YAN_PN, 'test');
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  check('merge ran', merged.merged);
  check('merged facet keeps the NULL learned_at', one('SELECT learned_at FROM person_facets WHERE person_jid = ? AND origin_jid = ?', YAN, G1)?.learned_at === null);
  check('merged nickname keeps the NULL learned_at', one("SELECT learned_at FROM nicknames WHERE person_jid = ? AND nickname = 'yanny'", YAN)?.learned_at === null);
  check('merged relationship keeps the NULL learned_at', one("SELECT learned_at FROM relationships WHERE relationship = 'cousins'")?.learned_at === null);
  check('merged item_origins floor stays NULL', one('SELECT min_learned_at FROM item_origins WHERE item_id = ? AND origin_jid = ?', self.id, YAN)
    ?.min_learned_at === null);
  const aliceDm = resolveAudience({ chatJid: ALICE });
  check('…so the G1 facet does not reach Alice\'s DM', !recallFacets(aliceDm, [YAN]).get(YAN));
  check('…nor the relationship', !recallRelationships(aliceDm).some(r => r.dynamic === 'YANREL'));
}

console.log('\nSlang is_global after a delete');
{
  const a = groupStore.upsertSlang('vibezz', 'great mood', 'group', G1, null);
  const b = groupStore.upsertSlang('vibezz', 'good mood', 'group', G2, null);
  check('two groups → global', db.prepare("SELECT MIN(is_global) FROM slang WHERE term = 'vibezz'").pluck().get() === 1);
  const ev = msg(G2, DAVE, 'vibezz means good mood', NOW - 40);
  store.addEvidence('slang', b.id, [{ msgId: ev, ts: NOW - 40 }]);
  store.onMessageRevoked(ev);
  check('revoke deleted the G2 row', !db.prepare('SELECT 1 FROM slang WHERE id = ?').get(b.id));
  check('…and the G1 row is no longer global', db.prepare('SELECT is_global FROM slang WHERE id = ?').pluck().get(a.id) === 0);
  check('…so G3 no longer gets it', !recallSlang(resolveAudience({ chatJid: G3 }), 50).some(s => s.term === 'vibezz'));
}

console.log('\nBatch window over the cap');
{
  const G5 = 'busy@g.us';
  run('INSERT INTO groups (jid, name, joined_at) VALUES (?, ?, ?)', G5, 'Busy', T0 - DAY);
  for (const p of [ALICE, BOB]) groupStore.upsertMember(G5, p, 'member', T0);
  resetWindow(G5);
  const t = NOW - 3000;
  for (let i = 0; i < 200; i++) {
    const text = i === 0 ? 'EARLIESTLINE marker here' : i === 199 ? 'LATESTLINE marker here' : `busy line ${i} chatter`;
    msg(G5, i % 4 === 3 ? BOT_PN : i % 2 ? ALICE : BOB, text, t + i, { self: i % 4 === 3 });
  }
  const upTo = db.prepare('SELECT MAX(rowid) FROM messages WHERE group_jid = ?').pluck().get(G5);
  const state = () => db.prepare('SELECT last_batch_rowid, msgs_since_batch FROM learning_state WHERE chat_jid = ?').get(G5);
  answer = () => ({});
  await learning.runBatchAnalysis(G5);
  check('a truncated window analyses the OLDEST pending lines first', lastPrompt.includes('EARLIESTLINE') && !lastPrompt.includes('LATESTLINE'));
  check('…advances only to the last analysed line', state().last_batch_rowid < upTo);
  check('…and leaves the counter at the threshold for a follow-up', state().msgs_since_batch >= 100);
  await learning.runBatchAnalysis(G5);
  check('the follow-up analyses the rest', lastPrompt.includes('LATESTLINE') && state().last_batch_rowid === upTo);
}

console.log('\nRe-observed claim after its temporary copy expired');
{
  const base = { category: 'temporary', subjectJid: BOB, originKind: 'group', originJid: G1, content: 'Bob is in Northport for work',
    source: 'test', learnedAt: NOW - 10 * DAY };
  const tmp = store.addMemory({ ...base, expiresInDays: -3 });
  const again = store.addMemory({ ...base, learnedAt: NOW - DAY });
  check('merged into the same row', again.merged && again.id === tmp.id);
  check('the permanent re-observation clears the stale expiry', db.prepare('SELECT expires_at FROM memories WHERE id = ?').pluck().get(tmp.id) === null);
  check('…so it is recalled again', recall(resolveAudience({ chatJid: G1 }), { limit: 100, track: false }).some(m => m.id === tmp.id));
}

console.log('\nPurge clears the identity cache');
{
  const WEN = '987@lid'; const WEN_PN = '155500000987@s.whatsapp.net';
  run('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)', WEN, 'Wen', T0);
  run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', ?)`, WEN, WEN, T0);
  run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'pn', 'sync', ?)`, WEN_PN, WEN, T0);
  check('resolves before the purge (cached)', identity.resolvePerson(WEN_PN) === WEN);
  store.purgePerson(WEN, 'test');
  check('…and not after it', identity.resolvePerson(WEN_PN) === null && identity.resolvePerson(WEN) === null);
}

cleanup();

if (failures) {
  console.log(`\n${failures} memory check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll memory checks passed');
