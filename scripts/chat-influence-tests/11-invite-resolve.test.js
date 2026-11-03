// 012 invitations, the resolution (plan §P2.2): code only, through the story
// facade (reconciler steps 4–10, never the owner mapping path): today/tomorrow
// only; a known place, else the world's venue for that kind, else nothing; cast
// names → cast ids; the inviter is the subject, another real member named (or a
// non-member) refuses; the owner's controls: a frozen social category or a
// pinned cast member → no decision and a refusal row, a paused Director → none,
// a guided one → an "Ask me" card; the invitation caps (day, chat, open).
import {
  setupScratchDb, bootInfluence, say, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions, setSkills,
  section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const t = await bootInfluence({ jev: inviteJev(), areas: { invites: true, mood: false, sleep: false, work: false } });
const BOT = '10000000000@s.whatsapp.net';
let n = 0;
t.config.chatInfluence.perSenderPerHour = 20;
t.config.chatInfluence.perChatPerHour = 60;
t.config.chatInfluence.invitesMaxPerDay = 10;
t.clock.advance({ minutes: 60 });                 // 19:00, home from the office
await t.life.tick();

async function invite(ex, { chat = t.GROUP, sender = t.A } = {}) {
  await inviteClerk(() => inviteExtraction(ex));
  const before = inviteDecisions(t)[0]?.id ?? 0;
  const id = `R${++n}`;
  await say(t, { chat, sender, text: 'cinema tonight at 9?', id, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  const d = inviteDecisions(t)[0];
  return d && d.id > before ? d : null;
}

async function reset() {
  for (const r of t.db.prepare(`SELECT pointer_event_id AS id FROM chat_influence_items WHERE kind = 'invite' AND pointer_event_id IS NOT NULL`).all()) {
    try { t.life.revertEvent(r.id, { reason: 'test reset', by: 'test' }); } catch { /* already out */ }
  }
  t.db.prepare(`DELETE FROM chat_influence_items WHERE kind = 'invite'`).run();
}

const tonight = (time = '21:00') => ({ date: null, relative: 'tonight', time, part: null });

section('the window: today or tomorrow only');
check('tonight → opens', !!(await invite({ when: tonight() })));
await reset();
check('tomorrow → opens', !!(await invite({ when: { date: null, relative: 'tomorrow', time: '21:00', part: null } })));
await reset();
check('next friday (more than 36 h away) → nothing', !(await invite({ when: { date: null, relative: 'next_friday', time: '21:00', part: null } })));
check('already over (yesterday) → nothing', !(await invite({ when: { date: null, relative: 'yesterday', time: '21:00', part: null } })));

section('the place: known, the world\'s venue for the kind, or nothing');
const known = await invite({ when: tonight(), place: 'park', kind: 'walk' });
eq('a known place by name → that place', known?.subject.placeId, 'place:park');
await reset();
const venue = await invite({ when: tonight(), place: 'Some Bar Nobody Knows', kind: 'movie' });
eq('an unknown place → the world\'s venue for that kind', venue?.subject.placeId, 'place:cinema');
await reset();
check('a kind with no venue and no known place (drinks) → nothing', !(await invite({ when: tonight(), place: null, kind: 'drinks' })));

section('people: cast → cast ids; the inviter is the subject; another real person refuses');
const withCast = await invite({ when: tonight(), people: ['my flatmate'] });
eq('"my flatmate" → the flatmate\'s cast id', withCast?.subject.castIds, ['cast:flatmate']);
eq('…and the inviter is the subject', withCast?.subjectJid, t.A);
await reset();
check('another member of this group named (Blake) → refused', !(await invite({ when: tonight(), people: ['Blake'] })));
check('a name nobody here has → refused', !(await invite({ when: tonight(), people: ['Zebulon'] })));
const dm = await invite({ when: tonight(), people: [] }, { chat: t.B, sender: t.B });
eq('a DM invitation: the DM person is the subject, the DM the origin', [dm?.subjectJid, dm?.origins?.[0]?.jid], [t.B, t.B]);
await reset();

section('the owner\'s controls (arcs on)');
await setSkills({ arcs: true });
const at = t.clock.now();
const refusals = () => t.db.prepare(`SELECT COUNT(*) AS n FROM story_refusals WHERE target = 'invite'`).get().n;
t.life.appendOwnerBatch([{ type: 'director.fate_set', at, payload: { category: 'social', mode: 'frozen' } }], { by: 'test' });
const r0 = refusals();
check('social frozen → no decision', !(await invite({ when: tonight() })));
check('…and a refusal row', refusals() > r0);
t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'social', mode: 'natural' } }], { by: 'test' });
t.life.appendOwnerBatch([{ type: 'director.pin_set', at: t.clock.now(), payload: { pinKey: 'cast:flatmate' } }], { by: 'test' });
const r1 = refusals();
check('a pinned cast member named → no decision', !(await invite({ when: tonight(), people: ['my flatmate'] })));
check('…and a refusal row', refusals() > r1);
check('…without them it still opens', !!(await invite({ when: tonight() })));
await reset();
t.life.appendOwnerBatch([{ type: 'director.pin_cleared', at: t.clock.now(), payload: { pinKey: 'cast:flatmate' } }], { by: 'test' });
t.life.appendOwnerBatch([{ type: 'director.paused', at: t.clock.now(), payload: {} }], { by: 'test' });
check('the Director paused → no decision', !(await invite({ when: tonight() })));
t.life.appendOwnerBatch([{ type: 'director.resumed', at: t.clock.now(), payload: {} }], { by: 'test' });
t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'social', mode: 'guided' } }], { by: 'test' });
const guided = await invite({ when: tonight() });
eq('social guided → an "Ask me" decision', guided?.mode, 'ask');
const { cardsView } = await import('../../src/life/story/index.js');
const cards = cardsView(t.life.getState(), { now: t.clock.now() });
check('…listed as an open card', Array.isArray(cards) && cards.some(c => c.id === guided?.id && c.status === 'open'), cards?.map?.(c => c.id));
t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'social', mode: 'natural' } }], { by: 'test' });
await reset();
await setSkills({ arcs: false });

section('the invitation caps: open at once, per chat per day, per day');
const o1 = await invite({ when: tonight('20:00') }, { chat: t.GROUP, sender: t.A });
const o2 = await invite({ when: tonight('21:00') }, { chat: t.OTHER, sender: t.C });
const o3 = await invite({ when: { date: null, relative: 'tomorrow', time: '21:00', part: null } }, { chat: t.C, sender: t.C });
check('two open at once at most', !!o1 && !!o2 && !o3);
await reset();
const c1 = await invite({ when: tonight('20:00') });
await reset();
t.db.prepare(`INSERT INTO chat_influence_items (kind, chat_jid, origin_kind, msg_id, sender_jid, pointer_event_id, status, created_at)
  VALUES ('invite', ?, 'group', 'FAKE1', ?, 1, 'reverted', ?), ('invite', ?, 'group', 'FAKE2', ?, 1, 'reverted', ?)`)
  .run(t.GROUP, t.A, t.clock.now(), t.GROUP, t.A, t.clock.now());
check('≤ 2 per chat per day', !!c1 && !(await invite({ when: tonight('21:00') })));
check('…another chat still may', !!(await invite({ when: tonight('21:00') }, { chat: t.OTHER, sender: t.C })));
await reset();
t.config.chatInfluence.invitesMaxPerDay = 0;
check('INVITES_MAX_PER_DAY 0 → none', !(await invite({ when: tonight('21:00') }, { chat: t.OTHER, sender: t.C })));

report();
