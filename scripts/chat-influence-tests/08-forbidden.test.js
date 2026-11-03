// 012 never-list (owner decisions): no chain from a chat.perceived pointer can
// reach a chat-forbidden family (sickness, heavy, money, career, family, arcs,
// cast/place creation, relationship metrics, vitals nudges) — appendEvent refuses
// each; a busy run of perceptions writes only the allowed types; and the mood
// overlay never tips a story-family decision: the Jev request for a career, a
// family and a romance decision is byte-equal with and without blips, while an
// everyday decision does see the mood (non-vacuous).
import { setupScratchDb, bootInfluence, say, eventsOf, fakeJev, section, check, eq, report, throws } from './_helpers.js';

await setupScratchDb();
const t = await bootInfluence({
  jev: (await import('./_helpers.js')).perceiveJev((req, i) => ({
    kind: 'affect', target: 'him', affect: ['roast', 'argument', 'bad_news', 'praise', 'flirt'][i % 5], intensity: 'high',
  })),
});
const eventLog = await import('../../src/life/eventLog.js');
const decisions = await import('../../src/life/decisions.js');
const BOT = '10000000000@s.whatsapp.net';

section('appendEvent refuses every forbidden family under a chat pointer');
const ptr = eventLog.appendEvent({ type: 'chat.perceived', at: t.clock.now(), actor: 'chat', originKind: 'group', originJid: t.GROUP, payload: { kind: 'affect' } });
const refused = [];
const accepted = [];
for (const type of eventLog.CHAT_FORBIDDEN_TYPES) {
  try {
    eventLog.appendEvent({ type, at: t.clock.now(), actor: 'engine', causeId: ptr.id, payload: {}, ...(type === 'heavy.started' ? { heavy: true } : {}) });
    accepted.push(type);
  } catch { refused.push(type); }
}
eq('no forbidden type accepted with a chat cause', accepted, []);
check('…every one tried (non-vacuous)', refused.length === eventLog.CHAT_FORBIDDEN_TYPES.size && refused.length >= 20, refused.length);
throws('a jev actor cannot either', () => eventLog.appendEvent({ type: 'sick.started', at: t.clock.now(), actor: 'jev', causeId: ptr.id, payload: {} }));

section('what a busy run of perceptions writes');
const before = eventLog.lastEventId();
for (let i = 0; i < 10; i++) {
  await say(t, { chat: [t.GROUP, t.OTHER][i % 2], sender: [t.A, t.B, t.C][i % 3], text: `you clown number ${i}, honestly`, mentioned: [BOT] });
  t.clock.advance({ minutes: 3 });
}
const chatOrigin = eventLog.eventsAfter(before, 10000).filter(e => ['group', 'dm'].includes(e.originKind));
const types = [...new Set(chatOrigin.map(e => e.type))].sort();
eq('only the pointer and the mood blip have a chat origin', types, ['chat.perceived', 'mood.chat']);
check('…and nothing forbidden at all', !eventLog.eventsAfter(before, 10000).some(e => eventLog.CHAT_FORBIDDEN_TYPES.has(e.type)));

section('the overlay never reaches a story-family decision');
check('blips are live (the view has an overlay)', 'vitalsBase' in t.life.getState());
const { createInitialState } = await import('../../src/life/projector.js');
void createInitialState;
const captured = [];
decisions.setJev(async (req) => { captured.push(structuredClone(req.state)); return { model: 'f', answers: { pick: { type: 'choice', choice: 'b', probabilities: { a: 0.5, b: 0.5 }, confidence: 0.5 } }, usage: {}, ms: 0 }; });
const at = t.clock.now();
async function openOnce(spec) {
  captured.length = 0;
  await decisions.openDecision(() => t.life.getState(), spec,
    { world: t.world, at, append: (s) => eventLog.appendEvent(s), noJev: false });
  return JSON.stringify(captured[0] ?? null);
}
const SPECS = [
  ['career', { kind: 'career:interview', category: 'career', subject: { eventAt: at + 2 * 86400, minutes: 60 },
    options: [{ id: 'a', label: 'Go for it' }, { id: 'b', label: 'Stay put' }], decideBy: at + 86400 }],
  ['family', { kind: 'family:visit', category: 'family', subject: { eventAt: at + 2 * 86400, minutes: 60 },
    options: [{ id: 'a', label: 'Visit' }, { id: 'b', label: 'Call instead' }], decideBy: at + 86400 }],
  ['romance', { kind: 'romance:step', category: 'romance', subject: { eventAt: at + 2 * 86400, minutes: 60 },
    options: [{ id: 'a', label: 'Ask them out' }, { id: 'b', label: 'Give it more time' }], decideBy: at + 86400 }],
  ['everyday', { kind: 'movie', subject: { eventAt: at + 2 * 86400, minutes: 60 },
    options: [{ id: 'a', label: 'Go to the movie' }, { id: 'b', label: 'Stay in' }], decideBy: at + 86400 }],
];
for (const [name, spec] of SPECS) {
  t.config.chatInfluence.mood = true;
  const withBlips = await openOnce(spec);
  t.config.chatInfluence.mood = false;            // closes the overlay gate: the no-blip view
  const without = await openOnce(spec);
  t.config.chatInfluence.mood = true;
  if (name === 'everyday') check('an everyday decision does see the mood (non-vacuous)', withBlips !== without && withBlips !== 'null', [withBlips.slice(0, 160), without.slice(0, 160)]);
  else check(`a ${name} decision: the Jev state is byte-equal with and without blips`, withBlips !== 'null' && withBlips === without,
    [withBlips.slice(0, 120), without.slice(0, 120)]);
}
decisions.setJev(null);
void fakeJev; void eventsOf;

report();
