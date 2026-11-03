// 012 perception after the gate's verdict (processTurn's order): 009's matcher
// runs first (perceiveChat with influence:false), the availability gate decides,
// and only then does the perception start (perceiveInfluence, the verdict hook in
// applyLifeGate) — and the invitation note of a `now` turn still arrives within
// the wait, timed from the turn's start like processTurn's startTime.
import {
  setupScratchDb, bootInfluence, idle, inviteJev, inviteClerk, inviteDecisions, fakeSock, section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const jev = inviteJev({
  perceive: (req) => (/\?/.test(String(req.state?.message ?? '')) ? { kind: 'invite', target: 'him', intensity: 'mid' } : { kind: 'none' }),
});
const sock = fakeSock();
const t = await bootInfluence({
  jev, areas: { invites: true, mood: false, sleep: false, work: false },
  getSock: () => sock,
  processMessage: async () => {},
});
await inviteClerk();
const { resolveAudience } = await import('../../src/memory/recall.js');
const { storeMessage } = await import('../../src/memory/messageStore.js');
const BOT = '10000000000@s.whatsapp.net';
const ctx = { botJid: '10000000000:1@s.whatsapp.net', botLid: '10000000000:1@lid' };
const audG = resolveAudience({ chatJid: t.GROUP });
const perceives = () => t.jev.calls.filter(c => c.caller === 'life.chat.perceive').length;

function store(id, text) {
  const msg = { id, groupJid: t.GROUP, senderJid: t.A, senderName: 'Avery', content: text, messageType: 'text',
    timestamp: t.clock.now(), metadata: { mentionedJids: [BOT] } };
  storeMessage(msg);
  return msg;
}

section('ignore / react: no perception call, no invitation');
for (const verdict of ['ignore', 'react']) {
  const msg = store(`NO-${verdict}`, 'cinema at 8 tonight?');
  const c0 = perceives();
  await t.life.perceiveChat(msg, audG, { ...ctx, influence: false });
  t.life.perceiveInfluence(msg, audG, ctx, verdict);
  t.life.gateOutcome(t.GROUP, msg.id, verdict);
  await idle(t);
  eq(`${verdict} → no Jev call`, perceives() - c0, 0);
  eq(`…no note`, await t.life.inviteNote(t.GROUP, msg.id, audG, { startedAt: Date.now() }), '');
}
eq('…and no invitation decision', inviteDecisions(t).length, 0);

section('now: the perception starts at the verdict, the detailed note arrives within the wait');
{
  const msg = store('ORD1', 'cinema at 8 tonight?');
  const startedAt = Date.now();                                   // processTurn's startTime
  const c0 = perceives();
  await t.life.perceiveChat(msg, audG, { ...ctx, influence: false });
  eq('no perception before the verdict', perceives() - c0, 0);
  t.life.perceiveInfluence(msg, audG, ctx, 'now');                // applyLifeGate's verdict hook (synchronous)
  t.life.gateOutcome(t.GROUP, msg.id, 'now');
  const note = await t.life.inviteNote(t.GROUP, msg.id, audG, { startedAt });
  const waited = Date.now() - startedAt;
  eq('…one perception call', perceives() - c0, 1);
  check('…the detailed note, within the wait', /^Avery just invited you: a movie at Cinema with a friend at 20:00\. /.test(note)
    && waited < 2000, { note, waited });
  await idle(t);
  eq('…an invitation decision opened', inviteDecisions(t).length, 1);
}

report();
