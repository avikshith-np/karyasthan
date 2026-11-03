// Plan 020 B: the words about where he stands follow spec 006. A row a chat has shaped reaches a reply only where that chat's
// origin may be used; a writer's sheet only ever gets rows no chat has shaped; only what's being talked about, at most three.
import { setupScratchDb, fakeClock, blockNetwork, seedPerson, seedGroup, setBot, section, check, eq, report } from './_helpers.js';

await setupScratchDb();
const net = blockNetwork();
const store = await import('../../src/mind/store.js');
const stance = await import('../../src/mind/stance.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
const clock = fakeClock(Date.UTC(2026, 9, 27, 20, 0) / 1000);
store.setStoreClock(clock.fn);
stance.__setDepsForTest({ now: clock.fn });
await setBot();

const A = await seedPerson({ jid: '81001@lid', name: 'Avery' });
const B = await seedPerson({ jid: '81002@lid', name: 'Blake' });
const C = await seedPerson({ jid: '81003@lid', name: 'Casey' });
const G1 = await seedGroup({ jid: '120363000000081001@g.us', name: 'One', members: [A, B] });
const G2 = await seedGroup({ jid: '120363000000081002@g.us', name: 'Two', members: [A, C] });

const row = (topic, label, value, kind = 'interest') => store.putStance({ topic, label, kind, value, status: 'active', source: 'seed', confidence: 0.5 });
const say = (text) => [{ text }];
const aud = (jid) => resolveAudience({ chatJid: jid, kind: jid.endsWith('@g.us') ? 'group' : 'dm' });

const own = row('kind:cafe', 'cafe', 0.9);
const chatty = row('kind:gym', 'gym', 0.9);
store.addStanceEvidence(chatty.id, '2026-10-26', { at: clock.now() - 3600, source: 'scene', cause: 'scene:well', weight: 0.4, eventIds: [1], originKind: 'group', originJid: G1, originAt: clock.now() - 3600 });
const dmShaped = row('kind:walk', 'walk', 0.9);
store.addStanceEvidence(dmShaped.id, '2026-10-26', { at: clock.now() - 3600, source: 'chat', cause: 'invite_yes', weight: 0.1, eventIds: [2], originKind: 'dm', originJid: A, originAt: clock.now() - 3600 });
void own;
const fresh = () => stance.__resetLinesForTest();

section('only what is being talked about');
{
  fresh();
  eq('nothing said about it, no line', stance.linesFor(aud(G1), say('how was the traffic')), []);
  eq('nothing at all', stance.linesFor(aud(G1), []), []);
  eq('his own view, when it comes up', stance.linesFor(aud(G2), say('anyone for a CAFE later?')), ['You like cafes.']);
  fresh();
  eq('a whole word only', stance.linesFor(aud(G2), say('decafe is odd')), []);
  eq('the turn\'s trigger counts', stance.linesFor(aud(G2), [], { trigger: 'coffee later?' }), ['You like cafes.']);
}

section('finding 16: not on everyday words, not on his own lines, once an hour');
{
  fresh();
  const work = row('fixed:work', 'work', -0.5, 'opinion');
  const people = row('fixed:people', 'people', 0.6, 'opinion');
  const money = row('fixed:money', 'money', -0.6, 'opinion');
  void work; void people; void money;
  eq('"does this even work on android"', stance.linesFor(aud(G2), say('does this even work on android')), []);
  eq('"walk me through it"', stance.linesFor(aud(A), say('walk me through it')), []);
  eq('"she needs people around"', stance.linesFor(aud(G2), say("my mom's not feeling well, she needs people around")), []);
  eq('"he ran out of money"', stance.linesFor(aud(G2), say('he ran out of money')), []);
  eq('someone asks: that is about how he feels', stance.linesFor(aud(G2), say("how's your work going?")), ["You're not a fan of work."]);

  // A chat that keeps saying "work", every couple of minutes for two hours, some of it asking him.
  fresh();
  const lines = [];
  const lots = [];
  for (let i = 0; i < 60; i++) {
    clock.advance({ minutes: 2 });
    const text = i % 2 ? "how's your work?" : 'ugh work is killing me';
    lots.push({ text });
    const got = stance.linesFor(aud(G2), lots.slice(-10));
    if (got.length) lines.push(Math.floor(i / 30));
    if (got.length > 1) check('at most one line a turn', false, got);
  }
  eq('at most one line an hour, over two hours', lines, [0, 1]);

  fresh();
  eq('his own line alone: nothing', stance.linesFor(aud(G2), [{ text: 'hah how is work these days', fromMe: true }]), []);
  eq('he has just said it himself: nothing', stance.linesFor(aud(G2), [{ text: 'coffee was good', fromMe: true }, { text: 'coffee again tomorrow?' }]), []);
  eq('someone else raises it after, his old line out of reach: yes', stance.linesFor(aud(G2), [{ text: 'coffee was good', fromMe: true }, { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'coffee?' }]).length, 0);
  fresh();
  eq('only the newest lines', stance.linesFor(aud(G2), [{ text: 'coffee?' }, { text: 'a' }, { text: 'b' }, { text: 'c' }]), []);
  eq('and only one, with two raised', stance.linesFor(aud(G1), say('coffee or the gym?')).length, 1);
  store.stanceTx(() => { for (const t of ['fixed:work', 'fixed:people', 'fixed:money']) store.patchStance(store.getStanceByTopic(t).id, { status: 'rejected' }); });
}

section('re-review: a generic topic needs you or your on it');
{
  const weather = row('fixed:weather', 'the weather', -0.6, 'opinion');
  const food = row('fixed:food', 'food', 0.6, 'opinion');
  const again = ['fixed:work', 'fixed:people', 'fixed:money'].map(t => store.getStanceByTopic(t));
  for (const r of again) store.patchStance(r.id, { status: 'active' });
  for (const t of ['how is rahuls work going', 'im so sick of work', 'tired of people honestly', 'how are you people doing', 'how is the weather in dubai',
    'how is the food at that place', 'Do you mind if the work waits', 'how are the kids, food ok', "how's work?", 'what do you think about rahuls work']) {
    fresh();
    eq(`no line: ${t}`, stance.linesFor(aud(G2), say(t)), []);
  }
  for (const [t, line] of [["how's your work going?", "You're not a fan of work."], ['hows ur work', "You're not a fan of work."], ['how’s your work', "You're not a fan of work."],
    ['do you like the weather', "You're not a fan of the weather."], ['how is the weather at your place', "You're not a fan of the weather."], ['what do you think of the food here', 'You think well of food.'],
    ['your take on money?', "You're not a fan of money."], ['are you tired of people', 'You think well of people.'], ['u sick of work?', "You're not a fan of work."]]) {
    fresh();
    eq(`a line: ${t}`, stance.linesFor(aud(G2), say(t)), [line]);
  }
  for (const r of [weather, food, ...again]) store.patchStance(r.id, { status: 'rejected' });
}

section('re-review: a word that is also a name counts only as a name');
{
  const books = row('kind:books', 'books', 0.9);
  fresh();
  for (const t of ['can you book a cab', 'book the tickets', 'i will book it']) eq(`not books: ${t}`, stance.linesFor(aud(G2), say(t)), []);
  for (const t of ['any good books lately', 'reading a book', 'that novel was long']) { fresh(); eq(`books: ${t}`, stance.linesFor(aud(G2), say(t)), ['You like books.']); }
  store.patchStance(books.id, { status: 'rejected' });
  const will = row('cast:will', 'Will', 0.6, 'opinion');
  const mini = row('cast:mini', 'Mini', 0.7, 'opinion');
  const market = row('place:market', 'Market', 0.9);
  fresh();
  for (const t of ['i will come tomorrow', 'Will you come tomorrow?', 'WILL YOU COME', 'mini cooper is nice', 'the stock market crashed', 'at the Market now']) eq(`no line: ${t}`, stance.linesFor(aud(G2), say(t)), []);
  fresh();
  eq('as a name, inside a sentence', stance.linesFor(aud(G2), say('i saw Will at the station')), ['You think well of Will.']);
  fresh();
  eq('…the next line down is not inside the first', stance.linesFor(aud(G2), say('i saw it\nMini cooper is nice')), []);
  for (const r of [will, mini, market]) store.patchStance(r.id, { status: 'rejected' });
}

section('re-review: one DM, one cooldown, whichever form it comes in');
{
  const lidForm = await seedPerson({ jid: '81030@lid', name: 'Tobin', pn: '81030@s.whatsapp.net' });
  const r = row('place:mill', 'Mill Lane', 0.9);
  fresh();
  const viaLid = resolveAudience({ chatJid: lidForm, kind: 'dm' });
  const viaPn = resolveAudience({ chatJid: '81030@s.whatsapp.net', kind: 'dm' });
  check('the two forms are the same person', viaLid.personJid === viaPn.personJid && viaLid.chatJid !== viaPn.chatJid, [viaLid.chatJid, viaPn.chatJid]);
  eq('the first form gets it', stance.linesFor(viaLid, say('mill lane?')), ['You like Mill Lane.']);
  eq('the other form is the same chat', stance.linesFor(viaPn, say('mill lane?')), []);
  eq('a group keeps its own key', stance.cooldownChat({ kind: 'group', chatJid: G1 }), G1);
  eq('nobody known: the raw key', stance.cooldownChat({ kind: 'dm', chatJid: '99999@lid', personJid: null }), '99999@lid');
  eq('a resolver that throws: the raw key', stance.cooldownChat({ kind: 'dm', chatJid: '99999@lid', personJid: null }, () => { throw new Error('x'); }), '99999@lid');
  store.patchStance(r.id, { status: 'rejected' });
}

section('a chat-shaped row: the audience rule');
{
  fresh();
  eq('in its own chat', stance.linesFor(aud(G1), say('gym today?')), ['You like the gym.']);
  fresh();
  eq('not in a chat with someone from outside it', stance.linesFor(aud(G2), say('gym today?')), []);
  eq('not in a DM', stance.linesFor(aud(C), say('gym today?')), []);
  eq('a DM-shaped row in that DM', stance.linesFor(aud(A), say('going for a walk?')), ['You like going for walks.']);
  fresh();
  eq('…and nowhere else', stance.linesFor(aud(G1), say('going for a walk?')), []);
  eq('no audience, no lines (fail closed)', stance.linesFor(null, say('cafe')), []);
}

section('finding 6: held to the chat\'s own time, not the life event\'s');
{
  fresh();
  const r = row('kind:bowling', 'bowling', 0.9);
  // The evidence's own time is recent, but what the chat said is from before anyone in this audience could have seen it.
  store.addStanceEvidence(r.id, '2026-10-26', { at: clock.now() - 60, source: 'scene', cause: 'scene:well', weight: 0.4, eventIds: [5], originKind: 'group', originJid: G1, originAt: 0 });
  eq('an unknown or too-early chat time: no line outside that chat', stance.linesFor(aud(G2), say('bowling?')), []);
  fresh();
  eq('…in that chat, yes', stance.linesFor(aud(G1), say('bowling?')), ['You like bowling.']);
  store.deleteStanceEvidenceOf(r.id);
  store.patchStance(r.id, { status: 'rejected' });
}

section('finding 17: it reads, and two of a kind do not argue');
{
  fresh();
  const unknown = row('kind:mystery', 'mystery', 0.9);
  eq('a kind with no phrase has no line', stance.linesFor(aud(G2), say('a mystery today')), []);
  store.patchStance(unknown.id, { status: 'rejected' });
  const a1 = store.putStance({ topic: 'place:v1', label: 'a cafe', kind: 'interest', value: 0.9, status: 'active', source: 'code' });
  const a2 = store.putStance({ topic: 'place:v2', label: 'a cafe', kind: 'interest', value: 0.1, status: 'active', source: 'code' });
  const rest = store.putStance({ topic: 'place:v3', label: 'Restaurant', kind: 'interest', value: 0.9, status: 'active', source: 'code' });
  const out = store.putStance({ topic: 'place:v4', label: 'out', kind: 'interest', value: 0.9, status: 'active', source: 'code' });
  const named = store.putStance({ topic: 'place:v5', label: 'Mill Lane Bakes', kind: 'interest', value: 0.9, status: 'active', source: 'code' });
  eq('a place only named by its kind: no line', stance.linesFor(aud(G2), say('i was at a cafe yesterday, a restaurant after')).filter(l => /a cafe|Restaurant/.test(l)), []);
  eq('"figure it out"', stance.linesFor(aud(G2), say('figure it out')), []);
  eq('a place with a real name', stance.linesFor(aud(G2), say('mill lane bakes?')), ['You like Mill Lane Bakes.']);
  const pub = stance.selfOriginRows().filter(x => x.label === 'a cafe');
  eq('the site gets one row for the two, the stronger', pub.length, 1);
  for (const r of [a1, a2, rest, out, named]) store.patchStance(r.id, { status: 'rejected' });
}

section('finding 1: a cast name that is a real person\'s first name');
{
  fresh();
  const r = row('cast:avery', 'Avery', -0.7, 'opinion');
  eq('no line, in a chat where they are a member', stance.linesFor(aud(G1), say('Avery is coming to the party')), []);
  store.patchStance(r.id, { status: 'rejected' });
  const r2 = row('cast:robin', 'Robin', -0.7, 'opinion');
  eq('someone with no real namesake: yes', stance.linesFor(aud(G1), say('Robin is coming to the party')), ["You're not a fan of Robin."]);
  store.patchStance(r2.id, { status: 'rejected' });
}

section('re-review: the name people use, however it is written');
{
  const { getDb } = await import('../../src/memory/db.js');
  const { nameTokens, realFirstNames } = await import('../../src/memory/mindReads.js');
  eq('words of a name', [nameTokens('K Ann'), nameTokens('Brin🌸'), nameTokens('Dr. Maris'), nameTokens('Sara\u200b'), nameTokens('Renée-Marie')], [['ann'], ['brin'], ['maris'], ['sara'], ['renee', 'marie']]);
  await seedPerson({ jid: '81040@lid', name: 'K Ann' });
  await seedPerson({ jid: '81041@lid', name: 'Brin🌸' });
  await seedPerson({ jid: '81042@lid', name: 'Dr. Maris' });
  await seedPerson({ jid: '81043@lid', name: 'Sara\u200b' });
  const nick = await seedPerson({ jid: '81044@lid', name: 'Someone Else' });
  getDb().prepare("INSERT INTO nicknames (person_jid, nickname, origin_kind, origin_jid) VALUES (?, 'Tiko', 'group', ?)").run(nick, G1);
  check('a nickname counts', realFirstNames().has('tiko'));
  const rows = ['Ann', 'Brin', 'Maris', 'Sara', 'Tiko'].map(n => row(`cast:${n.toLowerCase()}`, n, -0.7, 'opinion'));
  for (const n of ['Ann', 'Brin', 'Maris', 'Sara', 'Tiko']) { fresh(); eq(`no line about ${n}`, stance.linesFor(aud(G1), say(`${n} is coming to the party`)), []); }
  // A vowel sign is part of a name in these scripts: it stays, and counts. Accents come off Latin letters only.
  const scripted = ['ദീപ', 'मारी', 'ബിന്ദു'];
  eq('the marks stay', scripted.map(nameTokens), scripted.map(n => [n.normalize('NFC')]));
  eq('however it was typed', scripted.map(n => nameTokens(n.normalize('NFD'))[0] === nameTokens(`${n[0]}\u200c${n.slice(1)}`)[0]), [true, true, true]);
  eq('José is josé is jose', [nameTokens('José'), nameTokens('jose\u0301'), nameTokens('JOSE')], [['jose'], ['jose'], ['jose']]);
  for (const [i, n] of scripted.entries()) await seedPerson({ jid: `8105${i}@lid`, name: n });
  for (const n of scripted) {
    check(`${n} is in the real names`, realFirstNames().has(nameTokens(n)[0]));
    check(`a cast name written ${n} gets no line`, stance.clashesWithRealName({ topic: 'cast:x', label: n }));
  }
  check('another name in that script still does', !stance.clashesWithRealName({ topic: 'cast:x', label: 'മീര' }));
  for (const r of rows) store.patchStance(r.id, { status: 'rejected' });
}

section('writers: only rows no chat has shaped');
{
  eq('a self-shaped row', stance.sheetLines({ kind: 'cafe' }), ['He likes cafes.']);
  eq('a chat-shaped row is left out', stance.sheetLines({ kind: 'gym' }), []);
  eq('a topic he has no row for', stance.sheetLines({ kind: 'bowlingg' }), []);
  row('cast:flatmate', 'Robin', 0.8, 'opinion');
  eq('someone in the scene', stance.sheetLines({ castIds: ['cast:flatmate'] }), ['He thinks well of Robin.']);
}

section('public: self-origin rows only, no people');
{
  const pub = stance.selfOriginRows().map(r => r.topic);
  check('his own', pub.includes('kind:cafe'));
  check('no chat-shaped row', !pub.includes('kind:gym') && !pub.includes('kind:walk'));
  check('no person', !pub.includes('cast:flatmate'));
}

section('a real person was part of it: 006, only where they are');
{
  const r = row('kind:bowling', 'bowling', 0.9);
  store.addStanceEvidence(r.id, '2026-10-26', { at: clock.now() - 3600, source: 'scene', cause: 'scene:well', weight: 0.4, eventIds: [3], originKind: 'self', subjectJid: B });
  eq('in a group they are in', stance.linesFor(aud(G1), say('bowling?')), ['You like bowling.']);
  eq('not in one they are not', stance.linesFor(aud(G2), say('bowling?')), []);
  eq('not in someone else\'s DM', stance.linesFor(aud(C), say('bowling?')), []);
  eq('not on a writer\'s sheet', stance.sheetLines({ kind: 'bowling' }), []);
  check('not public', !stance.selfOriginRows().some(x => x.topic === 'kind:bowling'));
  store.deleteStanceEvidenceOf(r.id);
}

section('the values are held in memory, and any write shows at once');
{
  const a = stance.numbers();
  check('the same map on a second read', stance.numbers() === a);
  const r = store.getStanceByTopic('kind:cafe');
  store.patchStance(r.id, { value: 0.8 });
  check('a new one after a write', stance.numbers() !== a);
  eq('with the new value', stance.numbers().get('kind:cafe'), 0.8);
  store.patchStance(r.id, { value: 0.9 });
}

section('revoked: the line comes back under the rule, and the chat stops counting');
{
  eq('removed', stance.removeEvidenceFor([G1]), 1);
  fresh();
  eq('now his own again', stance.linesFor(aud(G2), say('gym today?')), ['You like the gym.']);
}

section('purge goes with the person');
{
  eq('a DM origin', stance.removeEvidenceFor([A]), 1);
  eq('no evidence left', store.allStanceEvidence().length, 0);
}

section('the door: nothing while the mind is off or paused');
{
  const mind = await import('../../src/mind/index.js');
  const skills = await import('../../src/skills/skillRunner.js');
  await skills.loadSkills();
  skills.setSkillEnabled('mind', false);
  mind.__resetStanceActiveForTest();
  eq('skill off: no numbers', mind.stanceProvider.numbers(), null);
  eq('skill off: no sheet lines', mind.stanceProvider.sheetLines({ kind: 'cafe' }), []);
  eq('skill off: no reply lines', mind.stanceLines(aud(G2), say('cafe?')), '');
  skills.setSkillEnabled('mind', true);
  store.initFirstLive(clock.now());
  mind.__resetStanceActiveForTest();
  check('on: the numbers', mind.stanceProvider.numbers()?.get('kind:cafe') === 0.9);
  stance.__resetLinesForTest();
  eq('on: the line', mind.stanceLines(aud(G2), say('cafe?')), 'You like cafes.');
  stance.__resetLinesForTest();
  eq('never while imitating', mind.stanceLines(aud(G2), say('cafe?'), { imitation: { targetJid: A } }), '');
  mind.owner.setPaused(true, 'owner:tester');
  eq('a pause stops it at once', mind.stanceProvider.numbers(), null);
  eq('paused: no reply lines', mind.stanceLines(aud(G2), say('cafe?')), '');
  eq('paused: nothing for the site', mind.stanceProvider.publicRows(), null);
  mind.owner.setPaused(false, 'owner:tester');
  mind.__resetStanceActiveForTest();
  check('resumed', mind.stanceProvider.numbers() !== null);
  const site = mind.stanceProvider.publicRows();
  const row = site.find(x => x.topic === 'kind:cafe');
  check('the site gets his own rows, with a why in code words and a time', row && row.why === "how he's always been" && Number.isFinite(row.since), row);
  check('no chat-shaped row, no person, nothing a model wrote', !site.some(x => x.topic.startsWith('cast:')) && site.every(x => typeof x.why === 'string'));
  skills.setSkillEnabled('mind', false);
}

eq('no network', net.length, 0);
stance.__setDepsForTest(null);
report();
