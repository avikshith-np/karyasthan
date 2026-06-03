import { decide } from '../src/brain/decisionEngine.js';
import { runMigrations } from '../src/memory/db.js';

// Initialize DB for decision engine queries
runMigrations();

const mockMessages = [
  { desc: 'Direct mention', content: 'karyasthan what do you think?', isGroup: true },
  { desc: 'Name in text', content: 'kary would know this', isGroup: true },
  { desc: 'Question to group', content: 'anyone know a good restaurant?', isGroup: true },
  { desc: 'Casual statement', content: 'just had lunch', isGroup: true },
  { desc: 'Forwarded BS', content: 'FORWARD THIS TO 10 PEOPLE for good luck!!!', isGroup: true },
  { desc: 'Humble brag', content: 'so annoying getting another promotion smh', isGroup: true },
  { desc: 'DM message', content: 'hey man whats up', isGroup: false, isDm: true },
  { desc: 'Short message', content: 'ok', isGroup: true },
  { desc: 'Self deprecation', content: "I'm such an idiot lol", isGroup: true },
  { desc: 'ALL CAPS', content: 'WHAT THE HELL IS HAPPENING', isGroup: true },
];

console.log('Decision Engine Test — 10 mock messages, 10 iterations each\n');
console.log('Message'.padEnd(30), 'Respond%', 'Avg Score');
console.log('-'.repeat(55));

for (const mock of mockMessages) {
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
    };

    const result = decide(msg, {
      isGroup: mock.isGroup !== false,
      isDm: mock.isDm || false,
    });

    if (result.shouldRespond) respondCount++;
    totalScore += result.score;
  }

  const pct = Math.round((respondCount / iterations) * 100);
  const avg = (totalScore / iterations).toFixed(3);
  console.log(mock.desc.padEnd(30), `${pct}%`.padStart(7), avg.padStart(9));
}

console.log('\n✓ Decision engine test complete');
process.exit(0);
