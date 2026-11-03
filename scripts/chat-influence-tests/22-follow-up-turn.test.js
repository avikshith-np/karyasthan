// 020 §A4, final review 4, 5, 8: the real turn of a follow-up, through processMessage (src/index.js with
// no socket or timers), the LLM's HTTP stubbed: a reaction is never its fallback, the gate takes the
// mention threshold and sees the line it answers, no skill and no image fallback can take that old line,
// and a plan that came back drops the send. Scratch DB, no network.
process.env.KARYASTHAN_NO_START = '1';
import { setupScratchDb, section, check, eq, report, setBot, seedPeople, seedGroups, setSkills } from './_helpers.js';

await setupScratchDb();
const bot = await setBot();
const [A] = await seedPeople([{ jid: '7201@lid', name: 'Avery' }], { at: Date.UTC(2026, 6, 1) / 1000 });
const [GROUP] = await seedGroups([{ jid: '120363000000770001@g.us', name: 'Test group', members: [A] }], { at: Date.UTC(2026, 6, 1) / 1000 });
const { config } = await import('../../src/utils/config.js');
const { storeMessage } = await import('../../src/memory/messageStore.js');
const { startFlow, clearFlow } = await import('../../src/behavior/activeFlows.js');
const { isImageRequestForBot } = await import('../../src/utils/mentions.js');
const skills = await setSkills({ life: false, arcs: false, 'chat-influence': false, imitate: false, 'bill-split': true });
config.dryRun = false;
config.warmupEnabled = false;
config.maxPerGroupHour = 0;
config.maxGlobalHour = 0;
config.qualityGate.enabled = true;
config.qualityGate.threshold = 0.4;
config.qualityGate.mentionThreshold = 0.25;
config.llm.baseUrl = 'http://127.0.0.1:9/v1';
for (const r of ['mouth', 'gate']) {
  config.roles[r].provider = 'local';
  config.roles[r].model = 'stub';
  config.roles[r].fallbackProvider = '';
  config.roles[r].fallbackModel = '';
  config.roles[r].budgetUsd = 0;
}
config.imageGen.enabled = true;

// The model and the judge.
let reply = 'sorry, can\'t make it tonight';
let score = 0.9;
const gateCalls = [];
const other = [];
globalThis.fetch = async (url, opts = {}) => {
  let body = {};
  try { body = JSON.parse(opts.body); } catch { /* not JSON */ }
  const text = JSON.stringify(body.messages ?? '');
  if (!String(url).startsWith('http://127.0.0.1:9')) { other.push(String(url)); throw new Error('no network'); }
  const content = text.includes('Rate this response') ? (gateCalls.push(body), JSON.stringify({ score, reason: 'stub' })) : reply;
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

// The socket: what really went out.
const sent = [];
const sock = {
  user: { id: bot.pn, lid: bot.lid },
  sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: `OUT${sent.length}`, remoteJid: jid, fromMe: true }, message: {} }; },
  sendPresenceUpdate: async () => {},
  readMessages: async () => {},
};
const reactions = () => sent.filter(x => x.content?.react);
const texts = () => sent.filter(x => typeof x.content?.text === 'string');
const images = () => sent.filter(x => x.content?.image);

const { __processMessageForTest: processMessage } = await import('../../src/index.js');

const realRandom = Math.random;
Math.random = () => 0;   // every "maybe react" says yes: a reaction here is the code path, not luck

let n = 0;
const T0 = Math.floor(Date.now() / 1000);
const line = (chat, sender, content, ts = T0 - 3600) => {
  const m = { id: `L${++n}`, groupJid: chat, senderJid: sender, senderName: 'Avery', content, messageType: 'text', timestamp: ts, metadata: { mentionedJids: [] }, isFromSelf: false };
  storeMessage(m);
  return m;
};
const turn = (msg, chat, extra = {}) => {
  const followUp = { decisionId: 1, outcome: 'not_going', ...extra };
  const isGroup = chat.endsWith('@g.us');
  const ctx = { isGroup, isDm: !isGroup, chatJid: chat, rawMsg: null, botJid: bot.pn, botLid: bot.lid,
    catchUp: { followUp: true, followUpKind: 'back_out', triggerIds: [msg.id], itemIds: [] }, followUp, promptNotes: ['You can\'t make it after all — tell them briefly.'] };
  return { ctx, run: processMessage(sock, msg, ctx) };
};
const reset = () => { sent.length = 0; gateCalls.length = 0; other.length = 0; };

section('a follow-up the judge likes goes out; a score between the two bars passes: the mention threshold');
{
  reset();
  const inv = line(GROUP, A, 'movie tonight?');
  // A group that moved on.
  for (const w of ['and then', 'he said', 'so anyway', 'lol true', 'what time is the match']) line(GROUP, A, w, T0 - 60);
  score = 0.3;
  const { run } = turn(inv, GROUP);
  await run;
  eq('it went out', texts().length, 1);
  const judged = JSON.stringify(gateCalls[0]?.messages ?? '');
  check('the judge saw the line it answers', judged.includes('movie tonight?'), judged.slice(0, 400));
  check('…and was told it may be off topic on purpose', judged.includes('off the current topic on purpose'));
}

section('blocked by the judge: no reaction, the phone is told, nothing goes out');
{
  reset();
  const inv = line(GROUP, A, 'dinner tonight?');
  score = 0.1;
  const { ctx, run } = turn(inv, GROUP);
  await run;
  eq('no text', texts().length, 0);
  eq('no reaction (a 🔥 on an invitation he can\'t make reads as yes)', reactions().length, 0);
  eq('the phone can give it its one retry', ctx.followUp.blocked, 'gate');
  // The same block on an ordinary turn still may react: unchanged.
}

section('[SKIP] from the model: no reaction');
{
  reset();
  reply = '[SKIP]';
  const inv = line(GROUP, A, 'coffee?');
  const { ctx, run } = turn(inv, GROUP);
  await run;
  eq('nothing at all', [texts().length, reactions().length], [0, 0]);
  eq('not a gate block', ctx.followUp.blocked ?? null, null);
  reply = 'sorry, can\'t make it tonight';
  score = 0.9;
}

section('no skill and no image fallback take that old line');
{
  reset();
  // A bill-split flow with this person running in the group: the skill would claim any line of theirs.
  startFlow(GROUP, 'skill:bill-split', { initiatorJid: A, participantJids: new Set([A]), people: [] });
  const inv = line(GROUP, A, 'dinner at eight?');
  eq('(the running flow would claim this line on an ordinary turn)', skills.skillWouldHandle(inv, { isGroup: true, isDm: false, botJid: bot.pn, botLid: bot.lid }), 'bill-split');
  const { run } = turn(inv, GROUP);
  await run;
  clearFlow(GROUP);
  eq('the back-out went out, not the flow', texts().length, 1);

  // A DM: their newest line asks for a picture, the model skips: no image goes out.
  reset();
  reply = '[SKIP]';
  const ask = line(A, A, 'draw me a cat please');
  check('(an image ask aimed at him on an ordinary turn)', isImageRequestForBot(ask.content, { directed: true }));
  const { run: r2 } = turn(ask, A);
  await r2;
  eq('no image, nothing sent', [images().length, sent.length], [0, 0]);
  eq('no image model was called', other.filter(u => /image|generate/i.test(u)).length, 0);
  reply = 'sorry, can\'t make it tonight';
}

section('the plan came back before the send: nothing goes out');
{
  reset();
  const inv = line(GROUP, A, 'lunch tomorrow?');
  const { run } = turn(inv, GROUP, { stillApplies: () => false });
  await run;
  eq('nothing sent', sent.length, 0);
  reset();
  const inv2 = line(GROUP, A, 'lunch friday?');
  const { run: r2 } = turn(inv2, GROUP, { stillApplies: () => { throw new Error('read failed'); } });
  await r2;
  eq('a failed re-read fails closed', sent.length, 0);
  reset();
  const inv3 = line(GROUP, A, 'lunch monday?');
  const { run: r3 } = turn(inv3, GROUP, { stillApplies: () => true });
  await r3;
  eq('still true: it goes', texts().length, 1);
}

Math.random = realRandom;
report();
process.exit(0);
