// Runs against an isolated scratch DB (data/test-decision.db) — the live DB is
// never touched. The scratch DB is deleted on exit.
import fs from 'fs';
import path from 'path';

// Point the DB at a scratch file BEFORE any src import loads config
// (dotenv never overrides pre-set env vars).
process.env.DB_PATH = './data/test-decision.db';
process.env.DRY_RUN = 'true';

const { config, getPersona } = await import('../src/utils/config.js');
const { decide } = await import('../src/brain/decisionEngine.js');
const { runMigrations, closeDb } = await import('../src/memory/db.js');

// Initialize the scratch DB for decision engine queries
runMigrations();

// The bot's own identity for this run: an @-mention counts only when a mentionedJid
// matches it (src/utils/mentions.js), and the name factor reads the persona's aliases.
const BOT_JID = '19990000001:7@s.whatsapp.net';
const BOT_LID = '88880000001@lid';
const alias = getPersona().aliases?.[0] || getPersona().name || 'bot';

const mockMessages = [
  { desc: '@-mention', content: 'what do you think?', isGroup: true, mentionedJids: ['19990000001@s.whatsapp.net'], expect: 'respond' },
  { desc: '@-mention (LID)', content: 'thoughts?', isGroup: true, mentionedJids: [BOT_LID], expect: 'respond' },
  { desc: 'Name in text', content: `${alias} would know this`, isGroup: true, expect: 'respond' },
  { desc: 'Tagging a friend', content: 'what do you think?', isGroup: true, mentionedJids: ['15550000002@s.whatsapp.net'], expect: 'noMention' },
  { desc: 'Question to group', content: 'anyone know a good restaurant?', isGroup: true },
  { desc: 'Casual statement', content: 'just had lunch', isGroup: true },
  { desc: 'Forwarded BS', content: 'FORWARD THIS TO 10 PEOPLE for good luck!!!', isGroup: true },
  { desc: 'Humble brag', content: 'so annoying getting another promotion smh', isGroup: true },
  { desc: 'DM message', content: 'hey man whats up', isGroup: false, isDm: true, expect: 'respond' },
  { desc: 'Short message', content: 'ok', isGroup: true, expect: 'noMention' },
  { desc: 'Self deprecation', content: "I'm such an idiot lol", isGroup: true },
  { desc: 'ALL CAPS', content: 'WHAT THE HELL IS HAPPENING', isGroup: true },
];

console.log(`Decision Engine Test — ${mockMessages.length} mock messages, 10 iterations each\n`);
console.log('Message'.padEnd(30), 'Respond%', 'Avg Score');
console.log('-'.repeat(55));

const stats = {};
const failures = [];
for (const mock of mockMessages) {
  let mentionLeaks = 0;
  let respondCount = 0;
  let totalScore = 0;
  const iterations = 10;

  for (let i = 0; i < iterations; i++) {
    const msg = {
      id: `test_${Date.now()}_${i}`,
      groupJid: 'test@g.us',
      senderJid: 'sender@s.whatsapp.net',
      senderName: 'TestUser',
      content: mock.content,
      messageType: 'text',
      quotedId: null,
      quotedContent: null,
      isFromSelf: false,
      timestamp: Math.floor(Date.now() / 1000),
      metadata: mock.mentionedJids ? { mentionedJids: mock.mentionedJids } : {},
    };

    const result = decide(msg, {
      isGroup: mock.isGroup !== false,
      isDm: mock.isDm || false,
      botJid: BOT_JID,
      botLid: BOT_LID,
    });

    if (result.shouldRespond) respondCount++;
    totalScore += result.score;
    if (mock.expect === 'noMention' && (result.factors?.mention ?? 1) >= 5) mentionLeaks++;
  }

  const pct = Math.round((respondCount / iterations) * 100);
  const avg = (totalScore / iterations).toFixed(3);
  console.log(mock.desc.padEnd(30), `${pct}%`.padStart(7), avg.padStart(9));
  stats[mock.desc] = { pct, avg: totalScore / iterations };
  // Deterministic bounds only (the group roll is random): a mention, the persona's own
  // name and a DM always answer at the 0.95 override; tagging someone else or a bare
  // "ok" never takes the mention override.
  if (mock.expect === 'respond' && !(respondCount === iterations && totalScore / iterations >= 0.9)) {
    failures.push(`${mock.desc}: expected an always-respond ≥ 0.9, got ${pct}% avg ${avg}`);
  }
  if (mock.expect === 'noMention' && mentionLeaks) failures.push(`${mock.desc}: took the mention factor (${mentionLeaks}×)`);
}
if (!(stats['Short message'].avg < stats['@-mention'].avg)) failures.push('"ok" scored at least as high as an @-mention');
if (!(stats['DM message'].avg > stats['Casual statement'].avg)) failures.push('a DM did not outscore a casual group line');

closeDb();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(path.resolve(config.projectRoot, `data/test-decision.db${suffix}`)); } catch {}
}

if (failures.length) {
  console.log(`\n✗ ${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ Decision engine test complete (bounds checks passed)');
process.exit(0);
