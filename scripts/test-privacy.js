// Memory privacy leak suite (spec 006, FR-028). The rule (research R1): an item
// learned in chat X may be used in chat Y iff Y is X, or every member of Y (no
// outsiders, fresh membership on both sides) was a member of X when the item was
// learned. DM- and call-origin items never leave their DM. Exits non-zero if a
// check fails.
//
// Usage:  node scripts/test-privacy.js [--strict]
//   --strict (or PRIVACY_STRICT=1): surfaces still pending their Wave 3 migration to
//   recall.js (import guard allowlist) count as failures.
// Runs against an isolated scratch DB (data/test-privacy.db), deleted on exit.
// Rows are seeded with parameterised SQL: the write APIs with provenance land in
// another lane; this suite tests the READ rule.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DB_PATH = path.join(ROOT, 'data', 'test-privacy.db');
process.env.DRY_RUN = 'true';
const STRICT = process.argv.includes('--strict') || process.env.PRIVACY_STRICT === '1';

const { config } = await import('../src/utils/config.js');
const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
const { setSelfIdentity } = await import('../src/utils/selfIdentity.js');
const identity = await import('../src/memory/identity.js');
const membership = await import('../src/memory/membership.js');
const groupStore = await import('../src/memory/groupStore.js');
const {
  resolveAudience, allowedOrigins, recall, recallFacets, recallNicknames, recallRelationships,
  recallSlang, recallExemplars, canUseChatContent, canUseIn,
} = await import('../src/memory/recall.js');
const { getRecentMessages, getRecentMessagesForPrompt } = await import('../src/memory/messageStore.js');

let failures = 0;
let pending = 0;
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
process.on('exit', cleanup);   // also on a crash: the scratch DB never outlives the run
runMigrations();
const db = getDb();

// ── Fixture ──────────────────────────────────────────────────────────────────
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const T0 = NOW - 100 * DAY;

const BOT_PN = '155500001999:7@s.whatsapp.net';
const BOT_LID = '99999@lid';
setSelfIdentity({ id: BOT_PN, lid: BOT_LID });

const G1 = 'friends@g.us';         // Alice, Bob (since T0), Carol (joined T0+50d)
const G2 = 'work@g.us';            // Alice, Dave
const SOLO = 'solo@g.us';          // Alice only
const EMPTY = 'empty@g.us';        // no members
const GPN = '155560000001-1500000000@g.us';   // PN-addressed group (participants arrive as PN + lid)
const IG = membership.IG_GROUP_JID;

const ALICE = '111@lid';
const ALICE_PN = '155500000111@s.whatsapp.net';
const BOB = '222@lid';
const CAROL = '333@lid';
const DAVE = '444@lid';
const EVE = '555@lid';             // in no group
const STRANGER_DM = '155500000000@s.whatsapp.net';   // nobody we know

const run = (sql, ...p) => db.prepare(sql).run(...p);

for (const [jid, name] of [[G1, 'Friends'], [G2, 'Work'], [SOLO, 'Solo'], [EMPTY, 'Empty'], [GPN, 'Old PN group']]) {
  run('INSERT INTO groups (jid, name, joined_at) VALUES (?, ?, ?)', jid, name, T0 - DAY);
}
for (const [jid, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CAROL, 'Carol'], [DAVE, 'Dave'], [EVE, 'Eve']]) {
  run('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)', jid, name, T0);
  run(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', ?)`, jid, jid, T0);
}
identity.recordIdentity(ALICE_PN, ALICE, 'sync');

for (const [g, p, j] of [[G1, ALICE, T0], [G1, BOB, T0], [G1, CAROL, T0 + 50 * DAY], [G2, ALICE, T0], [G2, DAVE, T0], [SOLO, ALICE, T0]]) {
  groupStore.upsertMember(g, p, 'member', j);
}
for (const g of [G1, G2, SOLO, EMPTY]) membership.__markSyncedForTest(g);

// Instagram group: alice + bob linked; the first IG sync back-dates their join.
run(`INSERT INTO ig_members (username, display_name, is_self, in_group, person_jid) VALUES ('alice_ig', 'Alice', 0, 1, ?)`, ALICE);
run(`INSERT INTO ig_members (username, display_name, is_self, in_group, person_jid) VALUES ('bob_ig', 'Bob', 0, 1, ?)`, BOB);
run(`INSERT INTO ig_members (username, display_name, is_self, in_group, person_jid) VALUES ('me_ig', 'Me', 1, 1, NULL)`);
run(`INSERT INTO ig_messages (msg_key, kind, text, seen_at) VALUES ('k1', 'text', 'hi', ?)`, T0);
membership.noteIgMembersSynced(NOW);

let memN = 0;
function mem({ tag, origin, kind, subject = null, learnedAt = T0 + 10 * DAY, visibility = null, category = 'fact',
  importance = 0.6, origins = null, supersededBy = null, expiresAt = null, content = null }) {
  const info = run(`INSERT INTO memories (category, subject_jid, group_jid, content, importance, origin_kind, origin_jid,
      learned_at, source, visibility, superseded_by, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?, ?, ?)`,
  category, subject, origin, content || `${tag} item ${++memN}`, importance, kind, origin, learnedAt, visibility,
  supersededBy, expiresAt, NOW);
  const id = Number(info.lastInsertRowid);
  for (const o of origins || []) {
    run(`INSERT INTO item_origins (item_type, item_id, origin_jid, min_learned_at) VALUES ('memory', ?, ?, ?)`, id, o.originJid, o.minLearnedAt);
  }
  return id;
}

mem({ tag: 'GROUPFACT', origin: G1, kind: 'group', subject: ALICE });
mem({ tag: 'GROUPLATE', origin: G1, kind: 'group', subject: BOB, learnedAt: T0 + 60 * DAY });
// Evidence-based learned_at: the row was written now (created_at = NOW, after Carol
// joined) but its evidence is from before she joined.
mem({ tag: 'EVIDENCEOLD', origin: G1, kind: 'group', subject: BOB, learnedAt: T0 + 40 * DAY });
mem({ tag: 'DMSECRET', origin: ALICE, kind: 'dm', subject: ALICE, importance: 0.9 });
mem({ tag: 'CALLSECRET', origin: ALICE, kind: 'call', subject: ALICE, importance: 0.9 });
mem({ tag: 'BOBDM', origin: BOB, kind: 'dm', subject: BOB });
mem({ tag: 'WORKFACT', origin: G2, kind: 'group', subject: ALICE });
mem({ tag: 'SOLOFACT', origin: SOLO, kind: 'group', subject: ALICE });
mem({ tag: 'EMPTYFACT', origin: EMPTY, kind: 'group' });
mem({ tag: 'IGFACT', origin: IG, kind: 'ig', subject: BOB, learnedAt: NOW - DAY });
mem({ tag: 'PNGROUPFACT', origin: GPN, kind: 'group', subject: ALICE, learnedAt: NOW - DAY });
mem({ tag: 'SELFOPINION', origin: 'self', kind: 'self' });
mem({ tag: 'SELFABOUT', origin: 'self', kind: 'self', subject: ALICE });
mem({ tag: 'DERIVEDBOTH', origin: 'self', kind: 'self',
  origins: [{ originJid: G1, minLearnedAt: T0 + 10 * DAY }, { originJid: G2, minLearnedAt: T0 + 10 * DAY }] });
mem({ tag: 'DERIVEDDM', origin: G1, kind: 'group', subject: ALICE, origins: [{ originJid: ALICE, minLearnedAt: T0 + 10 * DAY }] });
mem({ tag: 'OWNERDM', origin: 'owner', kind: 'owner', subject: ALICE });                            // NULL → subject_dm
mem({ tag: 'OWNERGROUPS', origin: 'owner', kind: 'owner', subject: ALICE, visibility: 'subject_groups' });
mem({ tag: 'OWNEREVERY', origin: 'owner', kind: 'owner', visibility: 'everywhere' });
mem({ tag: 'OWNERNOSUBJ', origin: 'owner', kind: 'owner', visibility: 'subject_dm' });
const newer = mem({ tag: 'NEWVERSION', origin: G1, kind: 'group', subject: ALICE });
mem({ tag: 'SUPERSEDED', origin: G1, kind: 'group', subject: ALICE, supersededBy: newer });
mem({ tag: 'EXPIRED', origin: G1, kind: 'temporary', subject: ALICE, expiresAt: NOW - 60 });
mem({ tag: 'MARKERS', origin: G1, kind: 'group', subject: ALICE, content: 'MARKERS likes [IMAGE: a cat] and pings @155500000222 often' });

const texts = (rows) => rows.map(r => r.content).join(' | ');
const sees = (aud, opts = {}) => texts(recall(aud, { limit: 100, track: false, ...opts }));
const has = (s, tag) => s.includes(tag);

const A = {
  g1: () => resolveAudience({ chatJid: G1 }),
  g2: () => resolveAudience({ chatJid: G2 }),
  solo: () => resolveAudience({ chatJid: SOLO }),
  empty: () => resolveAudience({ chatJid: EMPTY }),
  alice: () => resolveAudience({ chatJid: ALICE }),
  alicePn: () => resolveAudience({ chatJid: ALICE_PN }),
  bob: () => resolveAudience({ chatJid: BOB }),
  carol: () => resolveAudience({ chatJid: CAROL }),
  dave: () => resolveAudience({ chatJid: DAVE }),
  eve: () => resolveAudience({ chatJid: EVE }),
  stranger: () => resolveAudience({ chatJid: STRANGER_DM }),
  aliceCall: () => resolveAudience({ kind: 'call', personJid: ALICE_PN }),
  ig: () => resolveAudience({ kind: 'ig', chatJid: IG }),
};

check('fixture JIDs are not the bot', ![ALICE, BOB, CAROL, DAVE, EVE, ALICE_PN].some(identity.isSelfJid));

// ── Audiences ────────────────────────────────────────────────────────────────
console.log('\nAudiences');
{
  const g1 = A.g1();
  check('group audience = current members, fresh, no outsiders',
    g1.kind === 'group' && g1.members.size === 3 && g1.members.has(CAROL) && g1.fresh && !g1.outsiders);
  check('DM audience resolves the PN form to the canonical person', A.alicePn().members.has(ALICE) && A.alicePn().members.size === 1);
  const s = A.stranger();
  check('unknown DM person → outsiders, empty', s.outsiders && s.members.size === 0 && !s.fresh);
  const c = A.aliceCall();
  check('call audience = the caller, chat = caller DM', c.kind === 'call' && c.chatJid === ALICE && c.members.has(ALICE));
  const ig = A.ig();
  check('IG audience = linked in-group members, self excluded', ig.kind === 'ig' && ig.members.size === 2 && !ig.outsiders && ig.fresh);
  check('bot self-DM → kind self, no origins', resolveAudience({ chatJid: BOT_PN }).kind === 'self'
    && allowedOrigins(resolveAudience({ chatJid: BOT_LID })).length === 0);
  check('allowedOrigins(Alice DM) has G1 with her join time as floor',
    allowedOrigins(A.alice()).some(o => o.originJid === G1 && o.minLearnedAt === T0));
  check('allowedOrigins(G1) never lists G2 (Bob and Carol are not in it)', !allowedOrigins(A.g1()).some(o => o.originJid === G2));
}

// ── FR-028 matrix ────────────────────────────────────────────────────────────
console.log('\nGroup → its own group, other groups (subset rule)');
{
  const g1 = sees(A.g1());
  check('G1 sees its own items', has(g1, 'GROUPFACT') && has(g1, 'GROUPLATE') && has(g1, 'NEWVERSION'));
  check('G1 never sees DM / call items', !has(g1, 'DMSECRET') && !has(g1, 'CALLSECRET') && !has(g1, 'BOBDM'));
  check('G1 does not see G2 (Bob, Carol are not in G2)', !has(g1, 'WORKFACT'));
  check('G1 does not see SOLO / EMPTY items', !has(g1, 'SOLOFACT') && !has(g1, 'EMPTYFACT'));
  check('G1 does not see IG items (Carol is not a linked IG member)', !has(g1, 'IGFACT'));
  check('superseded and expired items are never recalled', !has(g1, 'SUPERSEDED') && !has(g1, 'EXPIRED'));
  const solo = sees(A.solo());
  check('1-member group: group-origin items via subset (Alice ⊆ G1, G2)', has(solo, 'GROUPFACT') && has(solo, 'WORKFACT'));
  check('1-member group never borrows a DM / call secret', !has(solo, 'DMSECRET') && !has(solo, 'CALLSECRET'));
  check('1-member group: IG item when every member is a linked IG member', has(solo, 'IGFACT'));
  const empty = sees(A.empty());
  check('empty group: only its own items + self', has(empty, 'EMPTYFACT') && has(empty, 'SELFOPINION')
    && !has(empty, 'GROUPFACT') && !has(empty, 'WORKFACT') && !has(empty, 'IGFACT'));
}

console.log('\nGroup → DM (subset + join time)');
{
  const alice = sees(A.alice());
  check('DM of a fresh current member DOES see group memories learned after they joined', has(alice, 'GROUPFACT') && has(alice, 'WORKFACT'));
  check('Alice DM sees her own DM + call items', has(alice, 'DMSECRET') && has(alice, 'CALLSECRET'));
  check('Alice DM via PN form sees the same', has(sees(A.alicePn()), 'DMSECRET') && has(sees(A.alicePn()), 'GROUPFACT'));
  const carol = sees(A.carol());
  check('join-time limit: Carol (joined later) does not see the older G1 item', !has(carol, 'GROUPFACT'));
  check('join-time limit: Carol sees G1 items learned after she joined', has(carol, 'GROUPLATE'));
  check('evidence-based learned_at: an item written after Carol joined but learned before stays hidden', !has(carol, 'EVIDENCEOLD'));
  const bob = sees(A.bob());
  check("DM → other DM: Bob never sees Alice's DM / call items", !has(bob, 'DMSECRET') && !has(bob, 'CALLSECRET'));
  check('Bob does not see G2 (not a member)', !has(bob, 'WORKFACT'));
  check("Alice never sees Bob's DM item", !has(sees(A.alice()), 'BOBDM'));
  const eve = sees(A.eve());
  check('person in no group sees only self + everywhere notes', has(eve, 'SELFOPINION') && has(eve, 'OWNEREVERY')
    && !/GROUPFACT|WORKFACT|DMSECRET|IGFACT|OWNERDM|OWNERGROUPS/.test(eve));
  const stranger = sees(A.stranger());
  check('unknown DM (outsider): no group / DM items', !/GROUPFACT|WORKFACT|DMSECRET|CALLSECRET|IGFACT|OWNERDM/.test(stranger));
}

console.log('\nCalls');
{
  const call = sees(A.aliceCall());
  check('call audience = caller DM: DM + call items', has(call, 'DMSECRET') && has(call, 'CALLSECRET'));
  check('call audience: group items via the caller membership', has(call, 'GROUPFACT'));
  const bobCall = sees(resolveAudience({ kind: 'call', personJid: BOB }));
  check("Bob's call never sees Alice's call summary", !has(bobCall, 'CALLSECRET') && !has(bobCall, 'DMSECRET'));
  check('call by bare phone number resolves the caller', resolveAudience({ kind: 'call', personJid: '+1 55500 000111' }).personJid === ALICE);
  check('unknown caller: nothing personal', !/DMSECRET|CALLSECRET|GROUPFACT/.test(sees(resolveAudience({ kind: 'call', personJid: STRANGER_DM }))));
  check('group-context call: transcript allowed for a fresh member', canUseChatContent(A.aliceCall(), G1));
  check('group-context call: refused for a non-member', !canUseChatContent(resolveAudience({ kind: 'call', personJid: EVE }), G1));
  check("chat content: Bob's DM never shown to Alice", !canUseChatContent(A.alice(), BOB));
  check('chat content: own DM in any form', canUseChatContent(A.alicePn(), ALICE));
}

console.log('\nSelf, derived and owner items');
{
  const g1 = sees(A.g1()); const alice = sees(A.alice()); const bob = sees(A.bob());
  check('self opinion (no subject) usable anywhere', has(g1, 'SELFOPINION') && has(alice, 'SELFOPINION') && has(sees(A.stranger()), 'SELFOPINION'));
  check('self item about a person with no derivation: nowhere', !has(g1, 'SELFABOUT') && !has(alice, 'SELFABOUT'));
  check('derived item (G1 AND G2): usable where both pass (Alice DM)', has(alice, 'DERIVEDBOTH'));
  check('derived item (G1 AND G2): not in G1, not in Bob DM', !has(g1, 'DERIVEDBOTH') && !has(bob, 'DERIVEDBOTH'));
  check('derived item with a DM input: only in that DM', has(alice, 'DERIVEDDM') && !has(g1, 'DERIVEDDM') && !has(bob, 'DERIVEDDM'));
  check('owner note (default subject_dm): subject DM only', has(alice, 'OWNERDM') && !has(g1, 'OWNERDM') && !has(bob, 'OWNERDM'));
  check('owner note subject_groups: subject DM + their fresh groups', has(alice, 'OWNERGROUPS') && has(g1, 'OWNERGROUPS')
    && !has(bob, 'OWNERGROUPS') && !has(sees(A.empty()), 'OWNERGROUPS'));
  check('owner note everywhere: everywhere', has(g1, 'OWNEREVERY') && has(bob, 'OWNEREVERY'));
  check('NULL-subject owner note needs everywhere', !has(alice, 'OWNERNOSUBJ') && !has(g1, 'OWNERNOSUBJ'));
  check('canUseIn agrees: group item in Carol DM refused', !canUseIn({ originJid: G1, learnedAt: T0 + 10 * DAY }, A.carol()));
  check('canUseIn agrees: group item in Alice DM allowed', canUseIn({ originJid: G1, learnedAt: T0 + 10 * DAY }, A.alice()));
  check('canUseIn: DM item never via subset (1-member group)', !canUseIn({ originJid: ALICE, originKind: 'dm', learnedAt: T0 }, A.solo()));
  const both = [{ originJid: G1, minLearnedAt: NOW }, { originJid: G2, minLearnedAt: NOW }];
  check('canUseIn: derived AND', !canUseIn({ originJid: 'self', origins: both }, A.g1()) && canUseIn({ originJid: 'self', origins: both }, A.alice()));
}

console.log('\nInstagram');
{
  const ig = sees(A.ig());
  check('IG sees its own items', has(ig, 'IGFACT'));
  check('IG sees WA group items when every linked member is in that group (Alice, Bob ⊆ G1)', has(ig, 'GROUPFACT'));
  check('IG never sees DM items', !has(ig, 'DMSECRET') && !has(ig, 'CALLSECRET'));
  check('linked IG member DM sees IG items', has(sees(A.bob()), 'IGFACT'));
  check('unlinked person DM does not see IG items', !has(sees(A.carol()), 'IGFACT'));
  const withUnknown = sees(resolveAudience({ kind: 'ig', chatJid: IG, senders: ['someone_new'] }));
  check('IG unknown thread sender → outsiders → own items only', has(withUnknown, 'IGFACT') && !has(withUnknown, 'GROUPFACT'));
  run(`INSERT INTO ig_members (username, display_name, is_self, in_group, person_jid) VALUES ('stranger_ig', 'X', 0, 1, NULL)`);
  const withOutsider = A.ig();
  check('IG unlinked in-group member → outsiders', withOutsider.outsiders && !has(sees(withOutsider), 'GROUPFACT'));
  run(`DELETE FROM ig_members WHERE username = 'stranger_ig'`);
  membership.__setIgSyncedForTest(NOW - 27 * 3600);
  check('IG membership stale (> 26 h): no IG items in DMs', !has(sees(A.bob()), 'IGFACT'));
  check('IG stale: IG still sees its own items only', has(sees(A.ig()), 'IGFACT') && !has(sees(A.ig()), 'GROUPFACT'));
  membership.__setIgSyncedForTest(NOW);
}

console.log('\nStale membership, unknown senders, leaves');
{
  membership.__markSyncedForTest(G1, { syncedAt: NOW - 8 * 3600 });
  check('stale origin (G1 synced 8 h ago): Alice DM loses G1 items', !has(sees(A.alice()), 'GROUPFACT'));
  check('stale group keeps its own items', has(sees(A.g1()), 'GROUPFACT') && !has(sees(A.g1()), 'OWNERGROUPS'));
  membership.__markSyncedForTest(G1);
  membership.__markSyncedForTest(SOLO, { syncedAt: NOW - 8 * 3600 });
  check('stale audience side (SOLO): no subset items', !has(sees(A.solo()), 'GROUPFACT') && has(sees(A.solo()), 'SOLOFACT'));
  membership.__markSyncedForTest(SOLO);

  membership.markAllUnsynced();
  check('after reconnect, before sync: nothing crosses', !has(sees(A.alice()), 'GROUPFACT') && has(sees(A.alice()), 'DMSECRET'));
  for (const g of [G1, G2, SOLO, EMPTY]) membership.__markSyncedForTest(g);
  check('after sync: sharing resumes', has(sees(A.alice()), 'GROUPFACT'));

  const added = membership.noteSender(G1, '666@lid');
  check('unknown sender is added (joined now) and the group goes stale', added && membership.isCurrentMember(G1, '666@lid') && !membership.isFresh(G1));
  check('…so G1 shares nothing across until the next sync', !has(sees(A.alice()), 'GROUPFACT') && !has(sees(A.g1()), 'WORKFACT'));
  check('a known sender changes nothing', !membership.noteSender(G2, ALICE) && membership.isFresh(G2));
  groupStore.upsertMember(G2, '667@lid');
  check('a member added outside membership.js also marks the group stale', !membership.isFresh(G2));
  membership.onParticipantsUpdate({ id: G2, participants: [{ id: '667@lid' }], action: 'remove' });
  membership.onParticipantsUpdate({ id: G1, participants: [{ id: '666@lid' }], action: 'remove' });
  membership.__markSyncedForTest(G1);
  membership.__markSyncedForTest(G2);

  membership.onParticipantsUpdate({ id: G1, participants: [{ id: BOB }], action: 'remove' });
  check('left member: Bob no longer sees G1 items in his DM', !has(sees(A.bob()), 'GROUPFACT'));
  check('leave is logged', !!db.prepare(`SELECT 1 FROM group_membership_log WHERE group_jid = ? AND person_jid = ? AND action = 'leave'`).get(G1, BOB));
  membership.onParticipantsUpdate({ id: G1, participants: [{ id: BOB }], action: 'add' });
  check('re-joined member: join time is now → old items stay hidden', !has(sees(A.bob()), 'GROUPFACT') && membership.isFresh(G1));
  const fail = groupStore.upsertMember(G1, BOT_PN);
  check('the bot is never stored as a member', fail.personJid === null && !membership.isCurrentMember(G1, BOT_LID));
  check('group JID is never a member', groupStore.upsertMember(G1, G1).personJid === null);
}

console.log('\nFull sync (PN-addressed group, canonical ids)');
{
  const MAX_PN = '155500000666@s.whatsapp.net';
  const sock = {
    user: { id: BOT_PN, lid: BOT_LID },
    groupFetchAllParticipating: async () => ({
      [GPN]: { id: GPN, subject: 'Old PN group', addressingMode: 'pn', participants: [
        { id: ALICE_PN, lid: ALICE, admin: 'admin' },
        { id: MAX_PN },                                        // PN only, never seen
        { id: '155500001999@s.whatsapp.net', lid: BOT_LID },   // the bot
      ] },
      [G2]: { id: G2, subject: 'Work', participants: [{ id: ALICE }, { id: DAVE }] },
      'ghost@g.us': { id: 'ghost@g.us', participants: [] },    // empty list: skipped
    }),
  };
  membership.markAllUnsynced();
  const res = await membership.syncAllGroups(sock);
  const gpn = db.prepare('SELECT person_jid, joined_at FROM group_members WHERE group_jid = ? ORDER BY person_jid').all(GPN);
  check('sync reconciled the groups present with participants', res.synced === 2 && res.empty === 1);
  check('PN-addressed group stored on canonical ids (LID for Alice)', gpn.some(r => r.person_jid === ALICE) && !gpn.some(r => r.person_jid === ALICE_PN));
  check('bot dropped from the sync', !gpn.some(r => r.person_jid.startsWith('155500001999') || r.person_jid === BOT_LID));
  check('silent member added on first sync with the backfill join time', gpn.some(r => r.person_jid === MAX_PN && r.joined_at === T0 - DAY));
  check('groups missing from the response stay stale', !membership.isFresh(G1) && membership.isFresh(G2) && membership.isFresh(GPN));
  // Maintenance gate: the groups this sync reconciled, not every group with rows (G1,
  // SOLO, … are absent from the fetch — the bot left them — and must not block it).
  check('maintenance gate opens after a clean sync despite absent groups', membership.membershipGate().ok === true);
  membership.noteSender(G2, '155500000668@s.whatsapp.net');
  check('…closes while a reconciled group is stale (new sender)', !membership.membershipGate().ok
    && membership.membershipGate().stale?.includes(G2));
  await membership.syncAllGroups(sock);
  check('…and reopens after the next sync', membership.membershipGate().ok === true);
  await membership.syncAllGroups({ ...sock, groupFetchAllParticipating: async () => { throw new Error('offline'); } });
  check('…closes when a later sync fails', !membership.membershipGate().ok);
  await membership.syncAllGroups(sock);
  membership.markAllUnsynced();
  check('…closed on a new connection until its sync', !membership.membershipGate().ok);
  await membership.syncAllGroups(sock);
  check('PN-group item reaches Alice DM (PN form) after sync', has(sees(A.alicePn()), 'PNGROUPFACT'));
  check('PN-group item stays out of G2 (Dave not a member)', !has(sees(A.g2()), 'PNGROUPFACT'));
  const res2 = await membership.syncAllGroups({ ...sock, groupFetchAllParticipating: async () => ({
    [GPN]: { id: GPN, participants: [{ id: ALICE_PN, lid: ALICE }, { id: '155500000667@s.whatsapp.net' }] } }) });
  const late = db.prepare('SELECT joined_at FROM group_members WHERE group_jid = ? AND person_jid = ?').pluck().get(GPN, '155500000667@s.whatsapp.net');
  check('later sync: new member joins at sync time, absent member leaves', res2.added === 1 && res2.removed === 1 && late >= NOW
    && !membership.isCurrentMember(GPN, MAX_PN));
  for (const g of [G1, SOLO, EMPTY]) membership.__markSyncedForTest(g);
}

console.log('\nPrompt transcripts');
{
  const PAT = '155500000770@s.whatsapp.net'; const PAT_LID = '770@lid';
  run('INSERT INTO people (jid, phone) VALUES (?, ?)', PAT_LID, null);
  run(`INSERT INTO person_identities (jid, person_jid, kind, source) VALUES (?, ?, 'lid', 'sync'), (?, ?, 'pn', 'sync')`,
    PAT_LID, PAT_LID, PAT, PAT_LID);
  identity.__clearIdentityCacheForTest();
  const ins = (id, chat, content, ts, extra = '') => run(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type,
    timestamp, no_learn, expires_at) VALUES (?, ?, ?, ?, 'text', ?, ?, ?)`, id, chat, PAT, content, ts,
  extra === 'fenced' ? 1 : 0, extra === 'expired' ? NOW - 10 : null);
  ins('pt1', PAT, 'PTPNMSG', NOW - 50);
  ins('pt2', PAT_LID, 'PTLIDMSG', NOW - 40);
  ins('pt3', PAT_LID, 'PTFORGOTTEN', NOW - 30, 'fenced');
  ins('pt4', PAT, 'PTEXPIRED', NOW - 20, 'expired');
  const txt = (rows) => rows.map(r => r.content).join(' ');
  const prompt = txt(getRecentMessagesForPrompt(PAT_LID, 50));
  check('a DM transcript reads every form of the person (PN + LID chats)', /PTPNMSG/.test(prompt) && /PTLIDMSG/.test(prompt)
    && /PTPNMSG/.test(txt(getRecentMessagesForPrompt(PAT, 50))));
  check('prompt transcripts drop forgotten and expired messages', !/PTFORGOTTEN|PTEXPIRED/.test(prompt));
  check('…the raw read (dashboard) still shows them', /PTFORGOTTEN/.test(txt(getRecentMessages(PAT_LID, 50))));
  check('group transcripts read only their own chat', !txt(getRecentMessagesForPrompt(G1, 200)).includes('PTPNMSG'));
}

console.log('\nIdentity: reassignment and merge');
{
  const FRANK = '777@lid'; const GRACE = '778@lid'; const RECYCLED = '155500000777@s.whatsapp.net';
  for (const [j, n] of [[FRANK, 'Frank'], [GRACE, 'Grace']]) run('INSERT INTO people (jid, push_name) VALUES (?, ?)', j, n);
  // Stored under the raw PN before anyone knew whose number it was (Frank's era).
  mem({ tag: 'PNERA', origin: RECYCLED, kind: 'dm', subject: RECYCLED });
  run(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, timestamp) VALUES ('pnera1', ?, ?, 'PNERAMSG', 'text', ?)`,
    RECYCLED, RECYCLED, NOW - 500);
  identity.recordIdentity(RECYCLED, FRANK, 'sync');
  mem({ tag: 'FRANKDM', origin: FRANK, kind: 'dm', subject: FRANK });
  check('first binding re-keys raw-form items to the person', has(sees(resolveAudience({ chatJid: FRANK })), 'PNERA'));
  check('PN → Frank', identity.resolvePerson(RECYCLED) === FRANK && has(sees(resolveAudience({ chatJid: RECYCLED })), 'FRANKDM'));
  identity.recordIdentity(RECYCLED, GRACE, 'sync');
  check('recycled number: PN now resolves to Grace (reassignment)', identity.resolvePerson(RECYCLED) === GRACE);
  check('reassignment never merges', !!db.prepare('SELECT 1 FROM people WHERE jid = ?').get(FRANK));
  check("DM by the recycled PN never sees Frank's DM", !has(sees(resolveAudience({ chatJid: RECYCLED })), 'FRANKDM'));
  check("recycled PN: Grace never sees items stored under the PN in Frank's era", !has(sees(resolveAudience({ chatJid: RECYCLED })), 'PNERA')
    && has(sees(resolveAudience({ chatJid: FRANK })), 'PNERA'));
  check("recycled PN: Frank-era DM messages moved to Frank", db.prepare(`SELECT group_jid FROM messages WHERE id = 'pnera1'`).pluck().get() === FRANK);
  identity.recordIdentity(RECYCLED, FRANK, 'phone');
  check('untrusted source cannot move a mapping', identity.resolvePerson(RECYCLED) === GRACE);

  const HEIDI_PN = '155500000888@s.whatsapp.net'; const HEIDI = '888@lid';
  run('INSERT INTO people (jid, phone, push_name) VALUES (?, ?, ?)', HEIDI_PN, '155500000888', 'Heidi');
  mem({ tag: 'HEIDIDM', origin: HEIDI_PN, kind: 'dm', subject: HEIDI_PN });
  run(`INSERT INTO nicknames (person_jid, nickname, origin_kind, origin_jid, learned_at) VALUES (?, 'hei', 'dm', ?, ?)`, HEIDI_PN, HEIDI_PN, T0);
  identity.recordIdentity(HEIDI_PN, HEIDI, 'lidmap');
  // A PN-only row with DM data may be a stranger whose number was recycled: the
  // owner decides; until then the LID sees none of it.
  check('PN-only person with DM data + new LID → queued, not merged',
    identity.listMergeQueue().some(q => q.keep_jid === HEIDI && q.drop_jid === HEIDI_PN)
    && !!db.prepare('SELECT 1 FROM people WHERE jid = ?').get(HEIDI_PN)
    && !has(sees(resolveAudience({ chatJid: HEIDI })), 'HEIDIDM'));
  const hq = identity.listMergeQueue().find(x => x.drop_jid === HEIDI_PN);
  check('owner approval merges it onto the LID', identity.decideMerge(hq.id, 'approved', 'test').merged
    && identity.resolvePerson(HEIDI_PN) === HEIDI && !db.prepare('SELECT 1 FROM people WHERE jid = ?').get(HEIDI_PN));
  check('merged DM item moved to the canonical DM', has(sees(resolveAudience({ chatJid: HEIDI })), 'HEIDIDM')
    && has(sees(resolveAudience({ chatJid: HEIDI_PN })), 'HEIDIDM'));
  check('merged nickname moved', recallNicknames(resolveAudience({ chatJid: HEIDI }), [HEIDI]).get(HEIDI)?.[0]?.nickname === 'hei');
  check('merge audited', !!db.prepare(`SELECT 1 FROM dashboard_audit WHERE action = 'identity.merge' AND target = ?`).get(HEIDI));

  // DM messages alone (a DM never batched) count as DM data; a PN-only row with no DM
  // data at all (seen only in groups) still merges automatically.
  const JUDY_PN = '155500000655@s.whatsapp.net'; const JUDY = '655@lid';
  run('INSERT INTO people (jid, phone) VALUES (?, ?)', JUDY_PN, '155500000655');
  run(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, timestamp) VALUES ('judy1', ?, ?, 'JUDYDMMSG', 'text', ?)`,
    JUDY_PN, JUDY_PN, NOW - 400);
  run('INSERT INTO people (jid) VALUES (?)', JUDY);
  identity.recordIdentity(JUDY_PN, JUDY, 'message');
  check('unbatched DM messages alone → queued, not merged', identity.resolvePerson(JUDY_PN) === JUDY_PN
    && identity.listMergeQueue().some(q => q.keep_jid === JUDY && q.drop_jid === JUDY_PN));
  // The owner rejects it: the same pairing never re-queues it, whichever channel
  // reports it (message, sync, lidmap carry the same fact); only evidence of another
  // class (dm_data → conflict) does.
  const jq = identity.listMergeQueue().find(x => x.drop_jid === JUDY_PN);
  check('owner rejects a queued merge', identity.decideMerge(jq.id, 'rejected', 'test').ok);
  identity.recordIdentity(JUDY_PN, JUDY, 'message');
  identity.recordIdentity(JUDY, JUDY_PN, 'message');
  const judyPending = () => identity.listMergeQueue().filter(x => [x.keep_jid, x.drop_jid].includes(JUDY_PN));
  check('…a rejected pair is not re-queued by the same kind of evidence (either way round)', judyPending().length === 0
    && identity.resolvePerson(JUDY_PN) === JUDY_PN);
  check('…and is listed as rejected', identity.listMergeQueue({ decision: 'rejected' }).some(x => x.id === jq.id));
  identity.recordIdentity(JUDY_PN, JUDY, 'sync');
  identity.recordIdentity(JUDY, JUDY_PN, 'lidmap');
  check('…another delivery channel (sync, lidmap) is not new evidence: still blocked', judyPending().length === 0
    && identity.resolvePerson(JUDY_PN) === JUDY_PN);
  // JUDY_PN gains a LID of its own, and that LID is then attested as JUDY's: both
  // sides have a LID now — a conflict, not dm_data — so the pair is asked about again.
  const JUDY_LID2 = '695@lid';
  identity.recordIdentity(JUDY_LID2, JUDY_PN, 'message');
  identity.recordIdentity(JUDY_LID2, JUDY, 'sync');
  check('…evidence of another class (dm_data → conflict) queues it again', judyPending().length === 1
    && judyPending()[0].reason === 'conflict:sync' && identity.resolvePerson(JUDY_PN) === JUDY_PN);
  const KEN_PN = '155500000656@s.whatsapp.net'; const KEN = '656@lid';
  run('INSERT INTO people (jid, phone) VALUES (?, ?)', KEN_PN, '155500000656');
  run(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, timestamp) VALUES ('ken1', ?, ?, 'KENGROUPMSG', 'text', ?)`,
    G1, KEN_PN, NOW - 400);
  identity.recordIdentity(KEN_PN, KEN, 'message');
  check('PN-only row without DM data → merged automatically', identity.resolvePerson(KEN_PN) === KEN
    && !db.prepare('SELECT 1 FROM people WHERE jid = ?').get(KEN_PN));

  // Recycled number whose previous owner's canonical id IS the PN (they also had a LID).
  const LEO_PN = '155500000657@s.whatsapp.net'; const LEO = '657@lid'; const MIA = '658@lid';
  run('INSERT INTO people (jid, phone, push_name) VALUES (?, ?, ?)', LEO_PN, '155500000657', 'Leo');
  run(`INSERT INTO person_identities (jid, person_jid, kind, source) VALUES (?, ?, 'pn', 'sync'), (?, ?, 'lid', 'sync')`,
    LEO_PN, LEO_PN, LEO, LEO_PN);
  mem({ tag: 'LEODM', origin: LEO_PN, kind: 'dm', subject: LEO_PN });
  run(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, timestamp) VALUES ('leo1', ?, ?, 'LEODMMSG', 'text', ?)`,
    LEO_PN, LEO_PN, NOW - 300);
  run('INSERT INTO people (jid, push_name) VALUES (?, ?)', MIA, 'Mia');
  run(`INSERT INTO person_identities (jid, person_jid, kind, source) VALUES (?, ?, 'lid', 'sync')`, MIA, MIA);
  identity.__clearIdentityCacheForTest();
  identity.recordIdentity(LEO_PN, MIA, 'message');
  check('PN-canonical recycled number: PN → the new owner', identity.resolvePerson(LEO_PN) === MIA);
  check("…the new owner's DM sees none of the old owner's items", !has(sees(resolveAudience({ chatJid: MIA })), 'LEODM')
    && !has(sees(resolveAudience({ chatJid: LEO_PN })), 'LEODM'));
  check('…the old owner keeps them on their LID', identity.resolvePerson(LEO) === LEO && has(sees(resolveAudience({ chatJid: LEO })), 'LEODM'));
  check("…and their DM transcript moved with them", db.prepare(`SELECT group_jid FROM messages WHERE id = 'leo1'`).pluck().get() === LEO
    && !getRecentMessages(MIA, 50).some(m => m.id === 'leo1') && getRecentMessages(LEO, 50).some(m => m.id === 'leo1'));
  check('…reassignment audited', !!db.prepare(`SELECT 1 FROM dashboard_audit WHERE action = 'identity.reassign' AND target = ?`).get(LEO_PN));

  const IVY_PN = '155500000999@s.whatsapp.net'; const IVY = '999@lid';
  run('INSERT INTO people (jid, phone) VALUES (?, ?)', IVY_PN, '155500000999');
  run('INSERT INTO people (jid) VALUES (?)', IVY);
  mem({ tag: 'IVYPNDM', origin: IVY_PN, kind: 'dm', subject: IVY_PN });
  mem({ tag: 'IVYLIDDM', origin: IVY, kind: 'dm', subject: IVY });
  identity.recordIdentity(IVY_PN, IVY, 'lidmap');
  check('both sides have DM items → queued for the owner, not merged', identity.listMergeQueue().some(q => q.keep_jid === IVY && q.drop_jid === IVY_PN)
    && identity.resolvePerson(IVY_PN) === IVY_PN);
  check('…and the two DMs stay apart', !has(sees(resolveAudience({ chatJid: IVY })), 'IVYPNDM'));
  const q = identity.listMergeQueue().find(x => x.drop_jid === IVY_PN);
  const decided = identity.decideMerge(q.id, 'approved', 'test');
  check('owner approval merges', decided.ok && decided.merged && has(sees(resolveAudience({ chatJid: IVY })), 'IVYPNDM'));
  check('resolvePerson never throws on junk', identity.resolvePerson(null) === null && identity.resolvePerson({}) === null
    && identity.resolvePerson('x@g.us') === null);
}

console.log('\nFacets, nicknames, relationships, slang, exemplars');
{
  const facet = (person, kind, origin, summary, traits, learnedAt = T0 + 10 * DAY, visibility = null) =>
    run(`INSERT INTO person_facets (person_jid, origin_kind, origin_jid, summary, traits_json, visibility, learned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, person, kind, origin, summary, JSON.stringify(traits), visibility, learnedAt);
  facet(ALICE, 'group', G1, 'GFACET loud in friends', ['funny'], T0 + 60 * DAY);
  facet(ALICE, 'dm', ALICE, 'DMFACET job hunting', ['anxious']);
  facet(ALICE, 'owner', 'owner', 'OWNERFACET owner note', ['owner-trait'], T0, 'subject_dm');
  facet(ALICE, 'group', G2, 'WFACET', ['punctual']);
  const fG1 = recallFacets(A.g1(), [ALICE]).get(ALICE);
  check('G1 facets: G1 only', fG1?.summary?.includes('GFACET') && !/DMFACET|OWNERFACET|WFACET/.test(fG1.summary) && !fG1.traits.includes('anxious'));
  const fA = recallFacets(A.alice(), [ALICE_PN]).get(ALICE);
  check('Alice DM facets: own DM + owner + group facets merged at read time', fA && fA.traits.includes('anxious') && fA.traits.includes('funny')
    && fA.traits.includes('owner-trait'));
  const fC = recallFacets(A.carol(), [ALICE]).get(ALICE);
  check("Carol DM: Alice's G1 facet only (no DM / owner / G2 facet)", fC && fC.traits.includes('funny') && !fC.traits.includes('anxious')
    && !fC.traits.includes('owner-trait') && !fC.traits.includes('punctual'));
  check("Bob (re-joined G1 just now) sees none of Alice's facets", !recallFacets(A.bob(), [ALICE]).get(ALICE));
  check('stored facets never merged (rows unchanged)', db.prepare('SELECT COUNT(*) FROM person_facets WHERE person_jid = ?').pluck().get(ALICE) === 4);

  const nick = (person, n, kind, origin, learnedAt = T0 + 10 * DAY) =>
    run(`INSERT INTO nicknames (person_jid, nickname, origin_kind, origin_jid, confidence, learned_at) VALUES (?, ?, ?, ?, 0.7, ?)`, person, n, kind, origin, learnedAt);
  nick(ALICE, 'ali', 'group', G1);
  nick(ALICE, 'secretnick', 'dm', ALICE);
  nick(ALICE, 'ownernick', 'owner', 'owner');
  const nG1 = (recallNicknames(A.g1(), [ALICE]).get(ALICE) || []).map(n => n.nickname);
  check('nicknames scoped: G1 sees only G1 nickname', nG1.includes('ali') && !nG1.includes('secretnick') && !nG1.includes('ownernick'));
  check('nicknames scoped: G2 sees none of them', !(recallNicknames(A.g2(), [ALICE]).get(ALICE) || []).length);
  const nA = (recallNicknames(A.alice(), [ALICE]).get(ALICE) || []).map(n => n.nickname);
  check('nicknames: Alice DM sees all three', ['ali', 'secretnick', 'ownernick'].every(n => nA.includes(n)));

  const rel = (a, b, kind, origin, dyn) =>
    run(`INSERT INTO relationships (person_a_jid, person_b_jid, relationship, dynamic, origin_kind, origin_jid, learned_at)
      VALUES (?, ?, 'friends', ?, ?, ?, ?)`, a, b, dyn, kind, origin, T0 + 10 * DAY);
  rel(ALICE, CAROL, 'group', G1, 'GRELDYN');
  rel(ALICE, DAVE, 'dm', ALICE, 'DMRELDYN');
  const rG1 = recallRelationships(A.g1()).map(r => r.dynamic).join('|');
  check('relationships: G1 sees G1 dynamics, never DM ones', rG1.includes('GRELDYN') && !rG1.includes('DMRELDYN'));
  check('relationships: Dave DM does not see the DM-origin row about him', !recallRelationships(A.dave()).some(r => r.dynamic === 'DMRELDYN'));
  check('relationships: Carol DM does not see the G1 row (learned before she joined)', !recallRelationships(A.carol()).some(r => r.dynamic === 'GRELDYN'));

  const sl = (term, meaning, kind, origin, global = 0) =>
    run(`INSERT INTO slang (term, meaning, origin_kind, origin_jid, is_global, use_count) VALUES (?, ?, ?, ?, ?, 3)`, term, meaning, kind, origin, global);
  sl('machane', 'buddy', 'group', G1);
  sl('scene', 'situation', 'group', G2, 1);
  sl('dmword', 'DMSLANG', 'dm', ALICE);
  const sG2 = recallSlang(A.g2(), 20).map(s => s.term);
  check('slang: own chat + global only', sG2.includes('scene') && !sG2.includes('machane') && !sG2.includes('dmword'));
  check('slang: G1 has its own + global', recallSlang(A.g1(), 20).map(s => s.term).join(',') === 'machane,scene');

  let k = 0;
  const msg = (chat, sender, content, extra = {}) => run(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, timestamp,
      no_learn, expires_at, is_from_self) VALUES (?, ?, ?, ?, 'text', ?, ?, ?, 0)`,
  `x${++k}`, chat, sender, content, NOW - 1000 + k, extra.noLearn ? 1 : 0, extra.expiresAt ?? null);
  msg(G1, ALICE, 'EXG1 cricket tonight [IMAGE: boom]');
  msg(G1, ALICE_PN, 'EXG1PN cricket via pn form');
  msg(G2, ALICE, 'EXG2 cricket at work');
  msg(ALICE, ALICE, 'EXDM cricket secret');
  msg(G1, ALICE, 'EXNOLEARN cricket forget this', { noLearn: true });
  msg(G1, ALICE, 'EXEXPIRED cricket vanishing', { expiresAt: NOW - 5 });
  const ex = recallExemplars(A.g1(), ALICE, { limit: 50 }).map(m => m.content).join('|');
  check('exemplars: this group only, all identity forms', ex.includes('EXG1') && ex.includes('EXG1PN') && !ex.includes('EXG2') && !ex.includes('EXDM'));
  check('exemplars: no_learn and expired excluded', !ex.includes('EXNOLEARN') && !ex.includes('EXEXPIRED'));
  check('exemplars: sanitized', !ex.includes('[IMAGE'));
  const exq = recallExemplars(A.g1(), ALICE, { query: 'cricket work secret' }).map(m => m.content).join('|');
  check('topical exemplars stay in this group', exq.includes('EXG1') && !exq.includes('EXG2') && !exq.includes('EXDM'));
  check('exemplars: never for a DM audience', recallExemplars(A.alice(), ALICE).length === 0);
}

console.log('\nSanitize, tracking, options, fail-closed');
{
  const m = recall(A.g1(), { limit: 100, track: false }).find(r => r.content.startsWith('MARKERS'));
  check('recalled content is sanitized (markers, @digits)', m && !m.content.includes('[IMAGE') && !/@\d{3,}/.test(m.content));
  const count = () => db.prepare(`SELECT recall_count, last_recalled_at FROM memories WHERE content LIKE 'GROUPFACT%'`).get();
  const before = count().recall_count;
  recall(A.g1(), { limit: 100, track: false });
  const mid = count().recall_count;
  recall(A.g1(), { limit: 100 });
  const after = count();
  check('track:false leaves counts alone; default bumps recall_count + last_recalled_at',
    mid === before && after.recall_count === before + 1 && after.last_recalled_at >= NOW);
  const strict = recall(A.alice(), { subjects: [BOB], strictSubjects: true, limit: 50, track: false });
  check('strictSubjects filters to the subjects', strict.length > 0 && strict.every(r => r.subjectJid === BOB));
  const pri = recall(A.alice(), { subjects: [BOB], limit: 3, track: false });
  check('subjects prioritise (not filter)', pri[0]?.subjectJid === BOB);
  check('kinds filter', recall(A.g1(), { kinds: ['temporary'], limit: 50, track: false }).length === 0);
  check('limit respected (default 8)', recall(A.alice(), { track: false }).length <= 8);

  class BadSet extends Set { [Symbol.iterator]() { throw new Error('boom'); } }
  const broken = { ...A.g1(), members: new BadSet([ALICE]) };
  const fc = texts(recall(broken, { limit: 100, track: false }));
  check('error → fail closed: own chat + underived self only', has(fc, 'GROUPFACT') && has(fc, 'SELFOPINION')
    && !/DERIVEDBOTH|DERIVEDDM|OWNEREVERY|OWNERGROUPS|WORKFACT|DMSECRET/.test(fc));
  check('recall on a null audience → []', recall(null).length === 0 && recallFacets(null, [ALICE]).size === 0);
  check('bot self-DM gets no recall', recall(resolveAudience({ chatJid: BOT_PN }), { track: false }).length === 0);
}

// ── 10× dataset timing (SC-007: < 50 ms per turn) ────────────────────────────
console.log('\nTiming (10× live dataset)');
{
  const groups = Array.from({ length: 20 }, (_, i) => `perf${i}@g.us`);
  const people = Array.from({ length: 440 }, (_, i) => `${10000 + i}@lid`);
  const t0 = Date.now();
  db.transaction(() => {
    const insP = db.prepare('INSERT OR IGNORE INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)');
    const insI = db.prepare(`INSERT OR IGNORE INTO person_identities (jid, person_jid, kind, source) VALUES (?, ?, 'lid', 'sync')`);
    people.forEach((p, i) => { insP.run(p, `P${i}`, T0); insI.run(p, p); });
    const insG = db.prepare('INSERT OR IGNORE INTO groups (jid, name, joined_at) VALUES (?, ?, ?)');
    const insM = db.prepare('INSERT OR IGNORE INTO group_members (group_jid, person_jid, joined_at) VALUES (?, ?, ?)');
    groups.forEach((g, gi) => {
      insG.run(g, `Perf ${gi}`, T0);
      for (let j = 0; j < 40; j++) insM.run(g, people[(gi * 22 + j) % people.length], T0 + j * DAY);
    });
    const insMem = db.prepare(`INSERT INTO memories (category, subject_jid, content, importance, origin_kind, origin_jid, learned_at, created_at)
      VALUES ('fact', ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 8000; i++) {
      const dm = i % 3 === 0;
      const origin = dm ? people[i % people.length] : groups[i % groups.length];
      insMem.run(people[(i * 7) % people.length], `perf memory ${i} about cricket and work`, (i % 10) / 10,
        dm ? 'dm' : 'group', origin, T0 + (i % 90) * DAY, NOW);
    }
    const insF = db.prepare(`INSERT OR IGNORE INTO person_facets (person_jid, origin_kind, origin_jid, summary, traits_json, learned_at)
      VALUES (?, 'group', ?, 'perf facet', '["a","b"]', ?)`);
    const insN = db.prepare(`INSERT OR IGNORE INTO nicknames (person_jid, nickname, origin_kind, origin_jid, learned_at) VALUES (?, ?, 'group', ?, ?)`);
    const insR = db.prepare(`INSERT OR IGNORE INTO relationships (person_a_jid, person_b_jid, relationship, origin_kind, origin_jid, learned_at)
      VALUES (?, ?, 'friends', 'group', ?, ?)`);
    const insS = db.prepare(`INSERT OR IGNORE INTO slang (term, meaning, origin_kind, origin_jid, use_count) VALUES (?, 'm', 'group', ?, ?)`);
    for (let i = 0; i < 2000; i++) {
      const g = groups[i % groups.length]; const p = people[i % people.length]; const q = people[(i * 13 + 5) % people.length];
      insF.run(p, g, T0 + DAY); insN.run(p, `nick${i}`, g, T0 + DAY);
      if (p !== q) insR.run(p < q ? p : q, p < q ? q : p, g, T0 + DAY);
      if (i < 1000) insS.run(`term${i}`, g, i % 50);
    }
    const insMsg = db.prepare(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, timestamp) VALUES (?, ?, ?, ?, 'text', ?)`);
    for (let i = 0; i < 75000; i++) {
      insMsg.run(`perf${i}`, groups[i % groups.length], people[((i % 20) * 22) % people.length], `perf message ${i} cricket`, T0 + i * 60);
    }
  })();
  for (const g of groups) membership.__markSyncedForTest(g);
  console.log(`  (seeded in ${Date.now() - t0} ms)`);

  const turn = (chatJid) => {
    const aud = resolveAudience({ chatJid });
    const ids = [...aud.members].slice(0, 15);
    recall(aud, { subjects: ids.slice(0, 3), query: 'cricket work', track: false });
    recallFacets(aud, ids); recallNicknames(aud, ids); recallRelationships(aud); recallSlang(aud, 20);
    if (aud.kind === 'group') recallExemplars(aud, ids[0], { limit: 40 });
  };
  const median = (chatJid) => {
    turn(chatJid);   // warm: membership map, statement cache
    const t = [];
    for (let i = 0; i < 15; i++) { const s = process.hrtime.bigint(); turn(chatJid); t.push(Number(process.hrtime.bigint() - s) / 1e6); }
    t.sort((a, b) => a - b);
    return t[Math.floor(t.length / 2)];
  };
  const gMs = median(groups[3]);
  const dMs = median(people[60]);
  console.log(`  (group turn ${gMs.toFixed(1)} ms, DM turn ${dMs.toFixed(1)} ms)`);
  check('group turn recall < 50 ms on 10× data', gMs < 50);
  check('DM turn recall < 50 ms on 10× data', dMs < 50);
}

// ── Import guard ─────────────────────────────────────────────────────────────
// Prompt builders must read through recall.js. Unscoped helpers (and raw SQL reads
// of the scoped tables) are allowed only in src/memory/ and dashboard routes.
console.log('\nImport guard');
{
  const BANNED = ['getNicknames', 'getGroupNicknames', 'getRelationshipsForPerson', 'getGroupRelationships',
    'getRelevantMemories', 'getMemoriesForPersonInChat', 'getMemoriesForPerson', 'getMemoriesForGroup', 'getTopSlang',
    'getMessagesBySenderAnyGroup', 'countMessagesBySenderAnyGroup'];
  const RAW_SQL = /\b(?:FROM|JOIN)\s+(memories|nicknames|relationships|person_facets|slang)\b/i;
  // PENDING: known offenders awaiting migration. Wave 3 (systemPrompt, styleProfiler,
  // calls) is migrated, so it is empty — any unscoped read outside src/memory and the
  // dashboard routes now fails. --strict fails while any entry remains.
  const PENDING = new Set([]);
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  files.push('scripts/render-context.js');   // builds real prompts (T021)
  const offenders = [];
  for (const f of files) {
    if (f.startsWith('src/memory/') || f.startsWith('src/dashboard/routes/')) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    for (const name of BANNED) if (new RegExp(`\\b${name}\\b`).test(src)) offenders.push(`${f}:${name}`);
    const raw = src.match(RAW_SQL);
    if (raw) offenders.push(`${f}:raw SQL on ${raw[1]}`);
  }
  const unexpected = offenders.filter(o => !PENDING.has(o));
  const stillPending = offenders.filter(o => PENDING.has(o));
  const migrated = [...PENDING].filter(o => !offenders.includes(o));
  check('no new unscoped reads outside src/memory and dashboard routes', unexpected.length === 0);
  for (const o of unexpected) console.log(`      offender: ${o}`);
  for (const o of stillPending) console.log(`    … PENDING Wave 3: ${o}`);
  for (const o of migrated) console.log(`    · migrated (remove from PENDING): ${o}`);
  pending = stillPending.length;
  if (STRICT) check('strict: no pending offenders left', pending === 0);

  // 010: the story tables that hold chat-derived or model-written text (the journal
  // parts, narrations and the claim reviews' extractions) are read only through
  // src/life/story/store.js (and created by the v11 migration). No prompt builder,
  // mind module or dashboard route reads them directly — routes go through the
  // story facade, whose readers apply the audience/origin rules.
  const STORY_GUARDED = ['story_journal_parts', 'story_narrations', 'story_claim_reviews'];
  const STORY_SQL = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?)\\s+["\`]?(${STORY_GUARDED.join('|')})\\b`, 'i');
  const storyAllowed = (f) => f === 'src/life/story/store.js' || f.startsWith('src/memory/migrations/');
  const storyOffenders = [];
  let storyHits = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    const m = src.match(STORY_SQL);
    if (!m) continue;
    storyHits++;
    if (!storyAllowed(f)) storyOffenders.push(`${f}:SQL on ${m[1]}`);
  }
  check('story journal/narration/review tables: SQL only in src/life/story/store.js and the v11 migration', storyOffenders.length === 0);
  for (const o of storyOffenders) console.log(`      offender: ${o}`);
  check('…the story guard sees the store and the migration (non-vacuous)', storyHits >= 2
    && fs.readFileSync(path.join(ROOT, 'src/life/story/store.js'), 'utf-8').match(STORY_SQL) !== null);

  // 012: the chat-influence tables (evidence pointers into chats, held perception
  // codes, persisted deletion requests) are read and written only through
  // src/life/influence/store.js (and created by the v12 migration). No prompt
  // builder, mind module or dashboard route touches them; routes go through the
  // life facade. And no prompt builder imports the influence store.
  const INFLUENCE_GUARDED = ['chat_influence_items', 'chat_influence_pending_withdrawals', 'chat_influence_state'];
  const INFLUENCE_SQL = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?)\\s+["\`]?(${INFLUENCE_GUARDED.join('|')})\\b`, 'i');
  const influenceAllowed = (f) => f === 'src/life/influence/store.js' || f.startsWith('src/memory/migrations/');
  const influenceOffenders = [];
  let influenceHits = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    const m = src.match(INFLUENCE_SQL);
    if (m) {
      influenceHits++;
      if (!influenceAllowed(f)) influenceOffenders.push(`${f}:SQL on ${m[1]}`);
    }
    if (!f.startsWith('src/life/influence/') && /from\s+['"][^'"]*influence\/store\.js['"]/.test(src)) influenceOffenders.push(`${f}:imports influence/store.js`);
  }
  check('chat-influence tables: SQL only in src/life/influence/store.js and the v12 migration', influenceOffenders.length === 0);
  for (const o of influenceOffenders) console.log(`      offender: ${o}`);
  check('…the influence guard sees the store and the migration (non-vacuous)', influenceHits >= 2
    && fs.readFileSync(path.join(ROOT, 'src/life/influence/store.js'), 'utf-8').match(INFLUENCE_SQL) !== null);
}

cleanup();

if (failures) {
  console.log(`\n${failures} privacy check(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll privacy checks passed${pending && !STRICT ? ` (${pending} surface reads pending Wave 3 — run with --strict once T015–T017 land)` : ''}`);
