// His phone: the same question twice (live 2026-11-03). A line in the charter kept steering every flirty chat toward one question, and past
// 12 texts neither writer remembered it had been asked and answered. The clothes line only on a turn the owner asked about clothes; a question the
// owner had him ask stops following the chat; what this side said in the last 24 h gets one rewrite, and what was asked is on the sheet. Marker words only.
import fs from 'fs';
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole } from './_helpers.js';
import { repeatedPhrase, repeatedToday, questionsIn } from '../../src/life/story/phone/schema.js';
import { HIS_CHARTER, CAST_CHARTER, BODY_ASK_LINE, charterFor, renderUser } from '../../src/life/story/phone/charter.js';
import * as story from '../../src/life/story/index.js';
import * as director from '../../src/life/story/director.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import { config } from '../../src/utils/config.js';
import { getDb } from '../../src/memory/db.js';
import { __setWalletForTest } from '../../src/life/spending.js';
import { resolveTimezone, localParts, zonedToUnix } from '../../src/life/clock.js';
__setWalletForTest(false);

section('the standing prompt no longer names it');
for (const [n, c] of [['his', HIS_CHARTER], ['theirs', CAST_CHARTER]]) {
  check(`${n}: no clothes line`, !/underneath|clothes/i.test(c));
  check(`${n}: the owner's ask is still asked outright`, /When the owner told you to ask something, ask it\. Do not hint/.test(c));
  check(`${n}: an explicit turn still swaps the heat line`, /You may be sexually explicit/.test(charterFor(c, 'explicit')));
}
check('the clothes line exists for a turn that needs it', /can be asked outright/.test(BODY_ASK_LINE));

section('repeatedToday');
{
  const earlier = ['maybe a little\nhow is that leaky kitchen tap doing since the weekend?', 'good morning to you'];
  eq('the same question, 22 texts on', repeatedToday("don't remind me\nhow is that leaky kitchen tap doing anyway?", earlier), 'is that leaky');
  eq('her same answer', repeatedToday('Still dripping into a bucket\nPlumber comes thursday honestly', ['Still dripping into a bucket.\nPlumber comes thursday.']), 'still dripping into');
  eq('something new', repeatedToday('how was the meeting then', earlier), null);
  eq('only small words is no repeat', repeatedToday('what are you up to', ['so what are you up to']), null);
  eq('nothing earlier', repeatedToday('how is that leaky tap', []), null);
  eq('junk', repeatedToday(null, earlier), null);
  check('repeatedPhrase alone misses it past its window', repeatedPhrase('how is that leaky kitchen tap doing anyway?', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) === null);
}

section('questionsIn');
{
  eq('question bubbles, newest kept', questionsIn(['one?\nno question', 'two?', 'three?', 'four?', 'five?'], 3), ['three?', 'four?', 'five?']);
  eq('none', questionsIn(['statement'], 3), []);
  eq('junk', questionsIn([null, 3], 3), []);
}

section('a long chat, on the stub writers');
await setupScratchDb();
let n = 0;
const STALE = 'tell me what zebra colour you picked today?';
let staleFrom = 3;   // these calls say the old question again
let staleUntil = 3;
const seen = [];
const his = (sys, user) => {
  n += 1;
  seen.push({ n, user, sys });
  const line = n === 1 || (n >= staleFrom && n <= staleUntil) ? STALE : `plain line quokka${n} wombat${n} b${n}x?`;
  return JSON.stringify({ messages: [line], tone: 'warm', end: false });
};
let m = 0;
const theirs = () => { m += 1; return JSON.stringify({ messages: [`answer number capybara${m} otter${m}`], tone: 'warm', end: false }); };
const cr = fakeCallRole({ 'life.phone.his': his, 'life.phone.mind': his, 'life.phone.cast': theirs });
const { life, clock, world } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: false }), knownNames: () => ['Quinn Marlow'], identity: async () => 'You are Kiran, from the example town.' });
config.arcs.phoneOrganicPerDay = 0;
config.arcs.claimCheckEnabled = false;
const flat = 'cast:flatmate';
const tz = resolveTimezone(world.timezone);
const drain = async () => { await story.idle(); await story.runPhoneNow(); await story.idle(); };
await simulateHours(0.5); await drain();
const p = localParts(clock.now(), tz);
const evening = zonedToUnix(p.year, p.month, p.day, 18, 0, tz) + 86400;
while (clock.now() < evening) await simulateHours(0.25);
const pv = await director.preview({ kind: 'text', castId: flat, gist: 'he says hello and it turns into a long catch-up', tone: 'warm', chat: 'long' });
const applied = await director.apply(pv.previewId, pv.fingerprint);
check('the owner started a long chat', applied?.ok === true, applied);
const outs = () => phoneStore.threadOf(flat, { live: true, limit: 200 }).filter(r => r.dir === 'out').map(r => r.text);
const until = async (pred, steps = 80) => { for (let i = 0; i < steps && !pred(); i++) { await simulateHours(0.25); await drain(); } return pred(); };
{
  staleFrom = 99; staleUntil = 99;
  check('enough turns went by', await until(() => n >= 2), n);
  eq('the question went out once', outs().filter(t => t === STALE).length, 1);
  const later = seen.at(-1);
  check('no clothes line on an ordinary turn', !/can be asked outright/.test(later?.sys ?? ''));
  check('a description stays as the chat\'s note', /long catch-up/.test(later?.user ?? ''));
}

section('the same question past the thread: one rewrite naming it, and the second try goes out whatever it says');
{
  await story.idle();
  // Ten more texts, so the question has left what the writer and the strict check can see.
  const t0 = clock.now();
  const db = getDb();
  for (let i = 0; i < 12; i++) {
    db.prepare(`INSERT INTO story_messages (cast_id, dir, status, trigger, exchange, due_at, at, text, tone, created_at, finished_at)
      VALUES (?, ?, 'live', 'reply', ?, ?, ?, ?, 'warm', ?, ?)`).run(flat, i % 2 ? 'in' : 'out', 50 + i, t0 - 60 + i, t0 - 60 + i, `filler kestrel${i} heron${i}`, t0 - 60 + i, t0 - 60 + i);
  }
  const before = outs().filter(t => t === STALE).length;
  const n0 = n;
  staleFrom = n0 + 2; staleUntil = n0 + 3;   // his owner turn is fresh; his reply says the old question on both tries
  const pv2 = await director.preview({ kind: 'text', castId: flat, gist: 'he says hello again and they keep talking', tone: 'warm', chat: 'long' });
  const a2 = await director.apply(pv2.previewId, pv2.fingerprint);
  check('another chat started', a2?.ok === true, a2);
  check('both tries were written', await until(() => n >= n0 + 3, 40), n - n0);
  const retry = seen.find(x => x.n === n0 + 3);
  check('the rewrite names it', /You already said "[^"]+" earlier today/.test(retry?.user ?? ''), retry?.user?.slice(-200));
  check('the sheet listed what he had asked', (retry?.user ?? '').includes('Already asked earlier today') && retry.user.includes(STALE));
  await until(() => outs().filter(t => t === STALE).length > before, 8);
  eq('it went out on the second try, so no turn was lost', outs().filter(t => t === STALE).length, before + 1);
}
section('wiring');
{
  const w = fs.readFileSync(new URL('../../src/life/story/phone/worker.js', import.meta.url), 'utf8');
  check('the clothes line only when the owner asked about clothes, never on explicit', /bodyAsk\(ask\.gist\) && register !== 'explicit' \? `\\n\$\{BODY_ASK_LINE\}`/.test(w));
  check('a question the owner had him ask stops following the chat', /!gistIsAsk\(ownerEv\.payload\.gist\) \? ownerEv\.payload\.gist : null/.test(w));
  check('an owner\'s ask is never held to it', /!phrase && !ask\.gist && !echoed \? repeatedToday/.test(w));
}
section('the sheet lists what was asked, once past the thread');
check('the writer passes it on from what has left the thread', /askedEarlier: ask\.gist \? \[\] : questionsIn\(today\.older\)/.test(fs.readFileSync(new URL('../../src/life/story/phone/worker.js', import.meta.url), 'utf8')));
{
  const s = { side: 'his', him: {}, them: { name: 'Asha', relation: 'friend' }, time: {}, thread: [], recent: [], plans: [], askedEarlier: ['what colour did you pick?'], why: 'x' };
  const u = renderUser(s);
  check('on the sheet', /Already asked earlier today/.test(u) && /what colour did you pick/.test(u));
  check('absent with none', !/Already asked/.test(renderUser({ ...s, askedEarlier: undefined })));
}
void life; void cr;
report();
process.exit(0);
