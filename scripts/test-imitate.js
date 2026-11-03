// Exercises imitate mode end-to-end without WhatsApp: style-card stats, the
// exemplar marker-scrub, activation/expiry/membership guards, the postProcess
// imitate opt-outs, prompt assembly, and the decision-engine alias override.
// No test framework: direct imports + console asserts, mirroring
// scripts/test-search.js. Exits non-zero if a deterministic check fails.
//
// Usage:  node scripts/test-imitate.js
// Runs against an isolated scratch DB (data/test-imitate.db) — the live DB is
// never touched. The scratch DB is deleted on exit.

import fs from 'fs';
import path from 'path';

// Point the DB at a scratch file BEFORE any src import loads config
// (dotenv never overrides pre-set env vars).
process.env.DB_PATH = './data/test-imitate.db';
process.env.DRY_RUN = 'true';

const { config } = await import('../src/utils/config.js');
const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
const { storeMessage } = await import('../src/memory/messageStore.js');
const { upsertPerson } = await import('../src/memory/peopleStore.js');
const {
  buildStyleCard, buildImitationBundle, renderStyleCardLines,
  pickImitationReaction, imitationTypingFactor,
} = await import('../src/personality/styleProfiler.js');
const { buildSystemPrompt, buildConversationContext } = await import('../src/personality/systemPrompt.js');
const { postProcess } = await import('../src/brain/postProcess.js');
const { decide } = await import('../src/brain/decisionEngine.js');
const {
  loadImitationModes, getImitationTarget, setImitationTarget, clearImitationTarget,
} = await import('../src/behavior/imitationState.js');
const { getPersona } = await import('../src/utils/config.js');
const { addMemory } = await import('../src/memory/relationshipStore.js');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}`);
  }
}

// ── Fixture data ────────────────────────────────────────────────────────────
runMigrations();
const db = getDb();

const GROUP = 'testgroup@g.us';
const TARGET = 'target@s.whatsapp.net';
const OTHER = 'other@s.whatsapp.net';

db.prepare(`INSERT OR IGNORE INTO groups (jid, name) VALUES (?, ?)`).run(GROUP, 'Test Group');
upsertPerson(TARGET, '15550100123', 'Bob');
upsertPerson(OTHER, '155512345678', 'Alice');
db.prepare(`INSERT OR IGNORE INTO group_members (group_jid, person_jid) VALUES (?, ?)`).run(GROUP, TARGET);
db.prepare(`INSERT OR IGNORE INTO group_members (group_jid, person_jid) VALUES (?, ?)`).run(GROUP, OTHER);

const now = Math.floor(Date.now() / 1000);
const bobLines = [
  'machane ith kandille 💀', 'poli sanam alle', 'njan parayunnath ketto machane',
  'adipoli 🔥🔥', 'entha scene ivide', 'machane vaa online',
  'ath kollam pakshe', 'evide okke aan ippo', 'poli aayirunnu innale match',
  'kidu goal aayirunnu 💀', 'machane free aano ippo', 'nale kaanam',
  'sathyam parayaam ath mosham aayirunnu', 'poli twist aayirunnu climax',
  'ivan oru sanam aanu', 'machane call cheyy', 'okke sheri aakum',
  'engane und new phone', 'battery pani aanu', 'ath enik ishtapettu 🔥',
];
let seq = 0;
function addMsg(sender, name, content, tsOffset = 0) {
  storeMessage({
    id: `m${++seq}`, groupJid: GROUP, senderJid: sender, senderName: name,
    content, messageType: 'text', timestamp: now - 3600 + tsOffset, metadata: {},
  });
}
for (let i = 0; i < 45; i++) {
  addMsg(TARGET, 'Bob', bobLines[i % bobLines.length] + (i % 7 === 0 ? ` ${i}` : ''), i * 30);
}
// Hostile exemplars: a marker and a raw @digits mention must never reach the prompt.
addMsg(TARGET, 'Bob', 'check this [IMAGE: nsfw thing] haha', 1500);
addMsg(TARGET, 'Bob', 'call @15550100123 now', 1530);
addMsg(OTHER, 'Alice', 'bob entha scene innu', 1600);

// ── buildStyleCard ──────────────────────────────────────────────────────────
console.log('\n== buildStyleCard ==');
{
  const rows = db.prepare(`SELECT * FROM messages WHERE sender_jid = ?`).all(TARGET);
  const card = buildStyleCard(rows);
  check('card built with count', card && card.count === rows.length);
  check('median length sane', card.medianLen > 5 && card.medianLen < 100);
  check('lowercase habit detected', card.pctLowercase >= 60);
  check('emoji favorites captured', card.topEmojis.includes('💀') || card.topEmojis.includes('🔥'));
  check('catchphrases mined ("machane"/"poli")', card.catchphrases.includes('machane') || card.catchphrases.includes('poli'));
  check('signature multi-word phrases mined', Array.isArray(card.phrases) && card.phrases.length > 0 && card.phrases.every(p => p.includes(' ')));
  check('activeHours histogram has 24 buckets', Array.isArray(card.activeHours) && card.activeHours.length === 24);
  check('renderStyleCardLines produces bullets', renderStyleCardLines(card).length >= 3);
  check('pickImitationReaction returns a top emoji', card.topEmojis.includes(pickImitationReaction(card)));
  check('typing factor within bounds', imitationTypingFactor(card) >= 0.5 && imitationTypingFactor(card) <= 1.3);
}

// ── buildImitationBundle + marker scrub ─────────────────────────────────────
console.log('\n== buildImitationBundle ==');
let bundle;
{
  bundle = buildImitationBundle(GROUP, TARGET, 'Bob', { topicHint: 'entha scene machane' });
  check('bundle built', !!bundle);
  check('exemplars present and capped', bundle.exemplars.length > 0 && bundle.exemplars.length <= 25);
  check('exemplars deduplicated', new Set(bundle.exemplars).size === bundle.exemplars.length);
  const joined = bundle.exemplars.join('\n');
  check('marker scrubbed from exemplars ([IMAGE:] neutralized)', !/\[IMAGE:/i.test(joined));
  check('@digits scrubbed from exemplars', !/@\d{3,}/.test(joined));
  check('aliases include bob', bundle.aliases.includes('bob'));
}

// ── imitationState: activation, expiry, membership ──────────────────────────
console.log('\n== imitationState ==');
{
  loadImitationModes();
  check('no target initially', getImitationTarget(GROUP) === null);

  setImitationTarget(GROUP, { targetJid: TARGET, label: 'Bob', durationMinutes: 60, enabledBy: 'test' });
  const t = getImitationTarget(GROUP);
  check('target active after set', t && t.targetJid === TARGET && t.label === 'Bob');

  // Force-expire in the DB + cache, then confirm lazy expiry clears it.
  db.prepare(`UPDATE group_imitation SET active_until = ? WHERE group_jid = ?`).run(now - 10, GROUP);
  loadImitationModes(); // reload cache from DB (simulates a restart with a stale row)
  check('expired target lazily cleared', getImitationTarget(GROUP) === null);
  check('expired row deleted from DB', !db.prepare(`SELECT 1 FROM group_imitation WHERE group_jid = ?`).get(GROUP));

  // Membership revalidation: target leaves the group → auto-clear.
  setImitationTarget(GROUP, { targetJid: TARGET, label: 'Bob', durationMinutes: 60, enabledBy: 'test' });
  db.prepare(`DELETE FROM group_members WHERE group_jid = ? AND person_jid = ?`).run(GROUP, TARGET);
  check('target auto-cleared when they leave the group', getImitationTarget(GROUP) === null);
  db.prepare(`INSERT OR IGNORE INTO group_members (group_jid, person_jid) VALUES (?, ?)`).run(GROUP, TARGET);
  clearImitationTarget(GROUP);
}

// ── postProcess imitate opt-outs ────────────────────────────────────────────
console.log('\n== postProcess({imitate:true}) ==');
{
  const im = { isGroup: true, imitate: true };
  const base = { isGroup: true };

  const terse = postProcess('lol', [], im);
  check('terse in-character "lol" survives', terse?.text === 'lol');
  check('same "lol" is nuked WITHOUT imitate (contrast)', postProcess('lol', [], base) === null);

  const fix = postProcess('machane ith poli aanu.', ['machane'], im);
  check('catchphrase sentence survives (no stripFixatedWords)', !!fix?.text?.includes('machane'));
  check('catchphrase stripped WITHOUT imitate (contrast)', postProcess('machane ith poli aanu.', ['machane'], base) === null);

  const marker = postProcess('nice [IMAGE: cat pic] haha', [], im);
  check('media marker still stripped while imitating', !!marker && !/\[IMAGE:/i.test(marker.text));

  const artifact = postProcess('I used "machane" as instructed. Good.', [], im);
  check('reasoning artifact still rejected while imitating', artifact === null);

  const sure = postProcess('sure da, varaam', [], im);
  check('"sure" opener survives imitate (relaxed AI patterns)', sure?.text?.startsWith('sure'));
}

// ── prompt assembly ─────────────────────────────────────────────────────────
console.log('\n== prompt assembly ==');
{
  const personaName = getPersona().name;
  addMemory({ category: 'fact', subjectJid: TARGET, originKind: 'group', originJid: GROUP, content: 'works at a startup in Testville', importance: 0.8 });

  const sys = buildSystemPrompt(GROUP, true, bundle);
  check('identity replaced with imitation identity', sys.includes('You are now Bob'));
  check('exemplar fence present', sys.includes("Bob's ACTUAL MESSAGES"));
  check('quality insights suppressed', !sys.includes('## Response quality'));
  check('target annotated as YOU in people block', sys.includes('this is YOU'));
  check('strict identity rule disavows persona biography', sys.includes('STRICT IDENTITY RULE') && sys.includes(`NONE of ${personaName}'s biography`));
  check("target's real facts injected", sys.includes('works at a startup in Testville'));
  check('style rule demands copying own vocabulary', sys.includes('STYLE RULE') && sys.includes("OWN vocabulary"));
  check('group slang section suppressed while imitating', !sys.includes('## Group slang'));

  const sysBase = buildSystemPrompt(GROUP, true, null);
  check('base prompt unchanged without imitation', !sysBase.includes('You are now Bob'));

  // Pre-takeover bot message: sent as the base persona BEFORE imitation started.
  // It must render under the persona's name, never as "Bob (you)".
  storeMessage({
    id: 'selfold', groupJid: GROUP, senderJid: 'bot@s.whatsapp.net', senderName: personaName,
    content: 'njan oru designer aanu, porto-kaaran', messageType: 'text',
    isFromSelf: true, timestamp: now - 300, metadata: {},
  });
  bundle.enabledAt = now - 100; // takeover happened AFTER that self message

  const trigger = { id: `m${seq}`, groupJid: GROUP, senderJid: OTHER, content: 'bob entha scene innu' };
  const { text: ctx } = buildConversationContext(GROUP, trigger, true, false, bundle);
  check('instruction says Reply as Bob', ctx.includes('Reply as Bob'));
  check('no-harm line present', ctx.includes('money, passwords, or OTPs'));
  check('self-voice transcript note present', ctx.includes('YOUR OWN past messages'));
  check('avoid-list suppressed while imitating', !ctx.includes('Avoid these recently-overused words'));
  check('voice/sing instructions removed while imitating', !ctx.includes('[VOICE:') && !ctx.includes('[SING:'));
  check('final style check is the last instruction', ctx.trimEnd().endsWith("words first.") && ctx.includes('FINAL CHECK'));
  const { text: ctxBase } = buildConversationContext(GROUP, trigger, true, false, null);
  // Spec 007 R8: the base voice manual lives once in the system core, not the user message.
  check('voice instructions intact without imitation', sysBase.includes('[VOICE:') && !ctxBase.includes('[VOICE:'));
  check('no base voice/sing manual in the imitation system prompt', !sys.includes('[VOICE:') && !sys.includes('[SING:'));
  check('pre-takeover bot message NOT labeled as target', !/\[Bob \(you\)\][^\n]*njan oru designer/.test(ctx));
  check('pre-takeover bot message labeled as persona', ctx.includes(`[${personaName}]`) && ctx.includes('njan oru designer'));
  check('different-speaker warning for persona lines present', ctx.includes(`Lines labeled [${personaName}]`));

  // Post-takeover self message keeps the imitated (you) label.
  storeMessage({
    id: 'selfnew', groupJid: GROUP, senderJid: 'bot@s.whatsapp.net', senderName: personaName,
    content: 'machane ith poli', messageType: 'text',
    isFromSelf: true, timestamp: now - 50, metadata: {},
  });
  const { text: ctx2 } = buildConversationContext(GROUP, trigger, true, false, bundle);
  check('post-takeover self message labeled as target (you)', /\[Bob \(you\)\][^\n]*machane ith poli/.test(ctx2));
}

// ── decision engine: alias mention override ─────────────────────────────────
console.log('\n== decisionEngine imitated mention ==');
{
  const msg = {
    id: 'dx1', groupJid: GROUP, senderJid: OTHER, senderName: 'Alice',
    content: 'bob entha scene', messageType: 'text', isFromSelf: false, metadata: {},
  };
  const ctx = { isGroup: true, isDm: false, botJid: 'bot@s.whatsapp.net', imitation: bundle };
  const d = decide(msg, ctx);
  check('mention of imitated name forces a reply', d.shouldRespond && d.factors.imitatedMention === true);

  const d2 = decide({ ...msg, content: 'random talk nothing here' }, ctx);
  check('non-mention does not force-fire the override', d2.factors.imitatedMention !== true);
}

// ── dashboard activation: corpus floor counts what the runtime imitates from ──
console.log('\n== activation corpus floor ==');
{
  const Fastify = (await import('fastify')).default;
  const groupsRoutes = (await import('../src/dashboard/routes/groups.js')).default;
  const app = Fastify();
  await app.register(groupsRoutes, { getSock: () => null });
  const LIGHT = 'light@s.whatsapp.net';
  upsertPerson(LIGHT, '155500000444', 'Lite');
  db.prepare(`INSERT OR IGNORE INTO group_members (group_jid, person_jid) VALUES (?, ?)`).run(GROUP, LIGHT);
  // Plenty of messages elsewhere, a handful here: imitation would run as the base
  // persona every turn, so activation is refused.
  for (let i = 0; i < 60; i++) {
    storeMessage({ id: `el${i}`, groupJid: 'elsewhere@g.us', senderJid: LIGHT, senderName: 'Lite',
      content: `elsewhere line ${i}`, messageType: 'text', timestamp: now - 7200 + i, metadata: {} });
  }
  for (let i = 0; i < 6; i++) addMsg(LIGHT, 'Lite', `here line ${i}`, 2000 + i);
  const post = (targetJid) => app.inject({ method: 'POST', url: `/api/groups/${encodeURIComponent(GROUP)}/imitate`,
    payload: { targetJid, durationMinutes: 5 } });
  const light = await post(LIGHT);
  check('target with messages only elsewhere → refused (400)', light.statusCode === 400 && /in this group/.test(light.body));
  // The success path is not POSTed here: it fire-and-forgets a real LLM voice-descriptor
  // build. The route counts with exactly this call.
  const { resolveAudience, recallExemplars } = await import('../src/memory/recall.js');
  check('target with enough messages here passes the same count',
    recallExemplars(resolveAudience({ chatJid: GROUP }), TARGET, { limit: config.imitate.minCorpus }).length >= config.imitate.minCorpus);
  await app.close();
}

// ── cleanup ─────────────────────────────────────────────────────────────────
closeDb();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(path.resolve(config.projectRoot, `data/test-imitate.db${suffix}`)); } catch {}
}

console.log(failures === 0 ? '\nAll imitate-mode checks passed.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
