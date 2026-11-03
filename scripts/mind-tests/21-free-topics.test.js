// Plan 020 B, free topics: what he has actually come across. One bounded call a night; code checks every word; proposals wait for the owner; an approved one moves only on what it cites;
// revoked citations take the row with them. Scratch DB, fake clock, stubbed model and life, no network.
import { setupScratchDb, fakeClock, blockNetwork, seedPerson, seedGroup, setBot, section, check, eq, report, DAY } from './_helpers.js';

await setupScratchDb();
const net = blockNetwork();
const store = await import('../../src/mind/store.js');
const stance = await import('../../src/mind/stance.js');
const free = await import('../../src/mind/stanceFree.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
const clock = fakeClock(Date.UTC(2026, 9, 27, 20, 0) / 1000);
store.setStoreClock(clock.fn);
await setBot();

const A = await seedPerson({ jid: '81001@lid', name: 'Avery Stone' });
const B = await seedPerson({ jid: '81002@lid', name: 'Blake' });
const C = await seedPerson({ jid: '81003@lid', name: 'Casey' });
const G1 = await seedGroup({ jid: '120363000000081001@g.us', name: 'One', members: [A, B] });
const G2 = await seedGroup({ jid: '120363000000081002@g.us', name: 'Two', members: [A, C] });
const aud = (jid) => resolveAudience({ chatJid: jid, kind: jid.endsWith('@g.us') ? 'group' : 'dm' });

const cat = {
  kinds: new Map([['kind:cafe', 'cafe']]), places: new Map([['place:park', 'the park']]), cast: new Map([['cast:flatmate', 'Robin']]),
  fixed: new Map([['fixed:work', 'work']]), homes: new Set(), departed: ['Morgan'],
};
let encounters = [{ kind: 'scene', eventId: 501, at: clock.now(), text: 'the night buses being always late; swapping book lists' }, { kind: 'text', eventId: 502, at: clock.now(), text: 'that new night bus is a joke' }];
let excluded = new Set();
let sig = '0:0';
const life = {
  stanceCatalogue: () => cat, stanceEncounters: () => encounters, stanceLastEventId: () => 1, stanceExclusionSig: () => sig, stanceIsExcluded: (id) => excluded.has(id),
  stanceTextProblem: (t) => (/Priya Raman/i.test(t) ? 'real_name' : null),
  venueKindWords: (t) => t.replace(/bean bar/gi, 'a bar'),
  stanceLabel: (t) => t,
  stanceLived: () => ({ events: [], lastId: 1, ctx: { homeIds: new Set(), activeCast: new Set(), heavyAt: () => false, startOf: () => null, decisionOf: () => null } }),
};
let budget = { ok: true };
let reply = () => '{}';
let calls = [];
stance.__setDepsForTest({
  now: clock.fn, life: async () => life, budgetOk: async () => budget,
  persona: () => ({ name: 'Hero', displayName: 'Hero', aliases: ['heroic'], region: 'Riverton' }),
  callRole: async (role, sys, user, opts) => { calls.push({ role, sys, user, opts }); const r = reply(); return typeof r === 'string' ? { status: 'ok', text: r } : r; },
});
let n = 100;
const night = () => `2027-${String(++n)}`;
const propose = (...rows) => { reply = () => JSON.stringify({ proposals: rows, moved: [] }); };
const P = (label, extra = {}) => ({ label, kind: 'opinion', value: 0.1, why: 'it keeps coming up', evidence: ['E1'], ...extra });
const go = (entries = []) => stance.freeTopicsNight(night(), entries);
const row = (label) => store.listStances().find(r => r.label === label);
const fresh = () => { for (const r of store.listStances()) if (r.topic.startsWith('free:')) store.deleteStance(r.id); };

section('nothing approved: no call');
{
  propose(P('late night buses'));
  eq('skipped', await go(), { skipped: 'none' });
  eq('no call', calls.length, 0);
}
store.putStance({ topic: 'kind:cafe', label: 'cafe', kind: 'interest', value: 0.7, status: 'active', source: 'seed' });
store.putStance({ topic: 'fixed:work', label: 'work', kind: 'opinion', value: 0.1, status: 'active', source: 'seed' });
store.setStanceSetting('stance_cursor', 1);

section('a budget stop: no call, no rows');
{
  budget = { ok: false, reason: 'budget' };
  eq('skipped', await go(), { skipped: 'budget' });
  eq('no call', calls.length, 0);
  budget = { ok: true };
  reply = () => ({ skipped: 'budget' });
  eq('stopped at the call', (await go()).skipped, 'budget');
  reply = () => { throw Object.assign(new Error('x'), { name: 'BudgetError' }); };
  eq('thrown at the call', (await go()).skipped, 'budget');
  eq('no rows', store.listStances().filter(r => r.topic.startsWith('free:')).length, 0);
  calls = [];
}

section('nothing he came across: no call');
{
  const was = encounters;
  encounters = [];
  eq('skipped', await go(), { skipped: 'nothing' });
  eq('no call', calls.length, 0);
  encounters = was;
}

section('one proposal, and what the call is');
{
  propose(P('late night buses', { value: 0.9 }));
  const nk = night();
  const r = await stance.freeTopicsNight(nk, [{ chatJid: G1, kind: 'group', episodeId: 77, episode: 'they went on about how the buses never come', minLearnedAt: clock.now() - 3600 }]);
  eq('one proposed', [r.proposed, r.moved], [1, 0]);
  eq('role and caller', [calls.at(-1).role, calls.at(-1).opts.caller], ['mind', 'mind.stance.free']);
  check('items are labelled, from each source', /E1 \(a chat\)/.test(calls.at(-1).user) && /E2 \(an outing\)/.test(calls.at(-1).user) && /E3 \(a text\)/.test(calls.at(-1).user));
  check('no chat name goes in', !calls.at(-1).user.includes(G1) && !calls.at(-1).user.includes('One'));
  check('his list goes in, so it can avoid it', /Already on his list:.*work/.test(calls.at(-1).user));
  const b = row('late night buses');
  eq('waits for the owner', b.status, 'proposed');
  eq('a slug in code', b.topic, 'free:late-night-buses');
  eq('a start value kept mild', b.value, 0.4);
  eq('anchor with it', b.anchor, 0.4);
  const ev = store.stanceEvidence(b.id);
  eq('a citation with no weight, keeping its origin', [ev.length, ev[0].cause, ev[0].weight, ev[0].originKind, ev[0].originJid, ev[0].details.memoryId], [1, 'cited', 0, 'group', G1, 77]);
  eq('a second run that night does nothing', await stance.freeTopicsNight(nk, []), { skipped: 'done' });
  fresh();
}

section('read the prompt');
{
  propose();
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'group', episodeId: 92, episode: 'they went on about how the buses never come', minLearnedAt: clock.now() - 60 }]);
  if (process.env.FREE_DUMP) (await import('fs')).writeFileSync(process.env.FREE_DUMP, `${free.FREE_CHARTER}\n\n----\n\n${calls.at(-1).user}`);
  check('fenced as data, and the charter names that fence', /UNTRUSTED_CHAT_DATA/.test(calls.at(-1).user) && free.FREE_CHARTER.includes('UNTRUSTED_CHAT_DATA'));
}

section('inert until approved');
{
  propose(P('late night buses'));
  await go();
  const b = row('late night buses');
  check('not among the numbers', !stance.numbers().has(b.topic));
  stance.__resetLinesForTest();
  eq('no line', stance.linesFor(aud(G1), [{ text: 'the late night buses are awful' }]), []);
  check('not for the site', !stance.selfOriginRows().some(r => r.topic === b.topic));
  check('the panel shows it, with its why', (await stance.view()).stances.find(x => x.topic === b.topic)?.why === 'it keeps coming up');
  fresh();
}

section('what code refuses');
{
  // Real names arrive as nameTokens gives them (no accents); a line that writes the accent is the same name.
  const free = await import('../../src/mind/stanceFree.js');
  const { nameTokens } = await import('../../src/memory/mindReads.js');
  eq('an accented real name in a line is still a real name', free.wordsProblem('a long talk with josé about buses', { realNames: nameTokens('José') }), 'real_name');
  for (const n of ['ദീപ', 'मारी', 'ബിന്ദു']) {
    eq(`a line with ${n} is a real name`, free.wordsProblem(`a long talk with ${n} about buses`, { realNames: nameTokens(n) }), 'real_name');
    eq('…however it was typed', free.wordsProblem(`a long talk with ${n.normalize('NFD')} about buses`, { realNames: nameTokens(n) }), 'real_name');
  }
  eq('another name in that script isn\'t', free.wordsProblem('a long talk with മീര about buses', { realNames: nameTokens('ദീപ') }), null);
  eq('…and any word of a two-word name', free.wordsProblem('a long talk with ann about buses', { realNames: nameTokens('K Ann') }), 'real_name');
  for (const [label, why] of [
    ['priya raman at work', 'real_name'], ['avery and the buses', 'real_name'], ['blake', 'real_name'], ['robin and his habits', 'cast'], ['morgan and his moods', 'cast'], ['hero himself', 'self'], ['heroic deeds', 'self'],
    ['riverton traffic', 'region'], ['bean bar coffee', 'venue'], ['the Metro Line', 'proper_noun'], ['elections this year', 'forbidden'], ['local politics', 'forbidden'],
    ['the temple festival', 'forbidden'], ['religion in general', 'forbidden'], ['sex education', 'forbidden'], ['call 98765 now', 'identifier'], ['see example.com', 'identifier'], ['x', 'label_shape'], ['a very long topic name that goes on far too long to use', 'label_shape'],
  ]) {
    propose(P(label));
    const r = await go();
    eq(`"${label}"`, [r.proposed, r.dropped?.[0]], [0, why]);
  }
  propose(P('late night buses', { evidence: [] }));
  eq('nothing cited', (await go()).dropped, ['uncited']);
  propose(P('late night buses', { evidence: ['E99'] }));
  eq('citing what it never read', (await go()).dropped, ['uncited']);
  propose(P('late night buses', { kind: 'feeling' }));
  eq('a bad kind', (await go()).dropped, ['kind']);
  propose(P('late night buses', { value: 'lots' }));
  eq('a bad value', (await go()).dropped, ['value']);
  propose(P('late night buses', { why: 'Priya Raman said so' }));
  await go();
  eq('a why with a name is dropped, the topic kept', row('late night buses').why, null);
  fresh();
  reply = () => 'not json';
  eq('nonsense', (await go()).skipped, 'invalid');
  reply = () => ({ status: 'ok', text: JSON.stringify({ proposals: [P('late night buses')] }), fellBack: true });
  eq('a fell-back run is refused', (await go()).skipped, 'model_failed');
  reply = () => ({ status: 'error', text: '' });
  eq('a failed call', (await go()).skipped, 'model_failed');
  eq('no rows from any of that', store.listStances().filter(r => r.topic.startsWith('free:')).length, 0);
}

section('duplicates by another slug, and what is on his list already');
{
  propose(P('late night buses'));
  await go();
  for (const label of ['late-night buses', 'night buses', 'the late night bus', 'buses']) {
    propose(P(label));
    eq(`"${label}"`, (await go()).dropped, ['duplicate']);
  }
  propose(P('remote work'));
  eq('a fixed topic by another name', (await go()).dropped, ['duplicate']);
  propose(P('cafe culture'));
  eq('a kind by another name', (await go()).dropped, ['duplicate']);
  propose(P('the park'));
  eq('a place', (await go()).dropped, ['duplicate']);
  propose(P('book lists'), P('books and lists'));
  const both = await go();
  eq('two the same in one reply: one', [both.proposed, both.dropped], [1, ['duplicate']]);
  check('a different thing is fine', free.sameTopic('late night buses', 'rising rents') === false);
  fresh();
}

section('rejected topics are not re-proposed');
{
  propose(P('rising rents'));
  await go();
  stance.reject(row('rising rents').id);
  propose(P('rising rents'));
  eq('the same words', (await go()).dropped, ['duplicate']);
  check('it told the model too', /rising rents/.test(calls.at(-1).user));
  propose(P('rents'));
  eq('another wording', (await go()).dropped, ['duplicate']);
  eq('still the one rejected row', store.listStances({ status: 'rejected' }).filter(r => r.topic.startsWith('free:')).length, 1);
}

section('at most two a night, twelve live');
{
  propose(P('late night buses'), P('quiet mornings'), P('crowded trains'));
  const r = await go();
  eq('two', [r.proposed, r.dropped], [2, ['cap']]);
  const words = ['street food stalls', 'early flights', 'paper books', 'long weekends', 'vinyl records', 'board games', 'bike lanes', 'cold showers', 'night markets', 'rooftop gardens'];
  for (let i = 0; i < words.length; i += 2) { propose(P(words[i]), P(words[i + 1])); await go(); }
  const live = () => store.listStances({ status: ['active', 'proposed'] }).filter(x => x.topic.startsWith('free:')).length;
  eq('twelve', live(), 12);
  propose(P('sunday roasts'));
  const before = calls.length;
  eq('full, nothing live to move: no call', (await go()).skipped, 'full');
  eq('no call made', calls.length, before);
  fresh();
}

section('a proposal whose evidence is revoked before approval');
{
  propose(P('rising damp'));
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'group', episodeId: 88, episode: 'the flat has rising damp apparently', minLearnedAt: clock.now() - 60 }]);
  check('there', !!row('rising damp'));
  stance.removeEvidenceFor([G1], { since: clock.now() - 3600 });
  eq('a revoke of that chat: gone, words and all', row('rising damp'), undefined);

  propose(P('rising damp'));
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'group', episodeId: 89, episode: 'the flat has rising damp apparently', minLearnedAt: clock.now() - 60 }]);
  stance.removeEvidenceFor([], { memoryIds: [89] });
  eq('its episode deleted, however old: gone', row('rising damp'), undefined);

  // Citing a chat and his own day: losing the chat takes it (the section at the end has the rest of that rule).
  propose(P('slow lifts', { evidence: ['E1', 'E3'] }));
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'group', episodeId: 90, episode: 'the lift took ages', minLearnedAt: clock.now() - 60 }]);
  check('(setup) it cites both', !!row('slow lifts'));
  stance.removeEvidenceFor([], { memoryIds: [90] });
  eq('the chat gone: gone', row('slow lifts'), undefined);

  // Citing two of his own, no chat in the batch: losing one leaves it, a revert of the rest takes it.
  propose(P('slow escalators', { evidence: ['E1', 'E2'] }));
  await go();
  const lifts = row('slow escalators');
  excluded = new Set([501]);
  sig = '1:0';
  await stance.sweep();
  eq('one of two citations gone: still there', row('slow escalators')?.id, lifts.id);
  excluded = new Set([501, 502]);
  sig = '1:1';
  await stance.sweep();
  eq('the rest reverted: gone', row('slow escalators'), undefined);
  excluded = new Set();
  sig = '2:0';
  await stance.sweep();
}

section('approved: the same rules, moving only on what it cites');
{
  propose(P('quiet mornings', { kind: 'interest', value: 0.5, evidence: ['E2'] }));
  await go();
  const q = row('quiet mornings');
  await stance.approve([q.id]);
  eq('in force', store.getStance(q.id).status, 'active');
  check('among the numbers', stance.numbers().has(q.topic));
  const v0 = store.getStance(q.id).value;
  reply = () => JSON.stringify({ proposals: [], moved: [{ label: 'quiet mornings', dir: 'up', evidence: [] }] });
  eq('no citation, no move', (await go()).moved, 0);
  reply = () => JSON.stringify({ proposals: [], moved: [{ label: 'quiet mornings', dir: 'up', evidence: ['E99'] }, { label: 'never heard of it', dir: 'up', evidence: ['E1'] }, { label: 'quiet mornings', dir: 'sideways', evidence: ['E1'] }] });
  eq('a bad one, an unknown topic, a bad direction', (await go()).moved, 0);
  eq('it has not moved', store.getStance(q.id).value, v0);
  reply = () => JSON.stringify({ proposals: [], moved: [{ label: 'quiet mornings', dir: 'up', evidence: ['E2'] }] });
  eq('cited: it moves', (await go()).moved, 1);
  const v1 = store.getStance(q.id).value;
  check('a small bounded step', v1 > v0 && v1 - v0 <= 0.3 * 0.07 + 1e-9, [v0, v1]);
  const w = await stance.why(q.id);
  check('why, in plain words', w.lines.some(l => l.words === 'something he came across warmed him to it') && w.lines.some(l => l.words === 'it came up in his day'), w.lines);
  reply = () => JSON.stringify({ proposals: [], moved: [{ label: 'quiet mornings', dir: 'down', evidence: ['E2'] }] });
  await go();
  check('and back', store.getStance(q.id).value < v1);

  // The line rule: someone else raises it, once an hour, not on his own line.
  store.patchStance(q.id, { value: 0.8, baseValue: 0.8 });
  stance.__resetLinesForTest();
  eq('his own line: nothing', stance.linesFor(aud(G2), [{ text: 'quiet mornings are the best', fromMe: true }]), []);
  eq('someone else raises it', stance.linesFor(aud(G2), [{ text: 'i love quiet mornings' }]).length, 1);
  eq('not again this hour', stance.linesFor(aud(G2), [{ text: 'quiet mornings though' }]), []);
  eq('on a word that merely shares a part, nothing', stance.linesFor(aud(C), [{ text: 'a quiet evening' }]), []);
  eq('the site may have it: his own day', stance.selfOriginRows().some(r => r.topic === q.topic), true);
  fresh();
}

section('a chat-derived one: the audience rule, kept for good');
{
  propose(P('slow elevators', { value: 0.4 }));
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'group', episodeId: 91, episode: 'the elevators here are so slow', minLearnedAt: clock.now() - 60 }]);
  const e = row('slow elevators');
  await stance.approve([e.id]);
  store.patchStance(e.id, { value: 0.7, baseValue: 0.7 });
  stance.__resetLinesForTest();
  check('a line in that chat', stance.linesFor(aud(G1), [{ text: 'slow elevators again' }]).length === 1);
  stance.__resetLinesForTest();
  eq('not in another with someone from outside it', stance.linesFor(aud(G2), [{ text: 'slow elevators again' }]), []);
  check('never for the site', !stance.selfOriginRows().some(r => r.topic === e.topic));
  // Sixty nights on, ordinary evidence folds away. The citation, where its words came from, doesn't.
  store.stanceTx(() => {
    const hist = Array.from({ length: 70 }, (_, i) => ({ night: `2030-${String(i).padStart(3, '0')}`, before: 0.7, after: 0.7, confidence: 0.5, count: 0, since: 0, habit: [] }));
    store.writeStanceHistory(e.id, hist);
  });
  stance.recomputeAll();
  store.deleteStanceEvidenceThrough(e.id, '2099');
  check('still cited', store.stanceEvidence(e.id).some(x => x.source === 'cited'));
  stance.__resetLinesForTest();
  eq('still held to the rule', stance.linesFor(aud(G2), [{ text: 'slow elevators again' }]), []);
  check('and still not for the site', !stance.selfOriginRows().some(r => r.topic === e.topic));
  // An owner's reset forgets what moved it, not where it came from.
  stance.reset(e.id);
  check('a reset keeps the citation', store.stanceEvidence(e.id).some(x => x.source === 'cited'));
  stance.removeEvidenceFor([G1]);
  eq('a revoke after approval: gone too', row('slow elevators'), undefined);
  eq('why gives no chat name', JSON.stringify(free.FREE_CHARTER).includes(G1), false);
}

section('batch 3 review 2/26: a rejected row goes with its citations, and stops going to the model');
{
  fresh();
  propose(P('dentist waiting rooms'));
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'group', episodeId: 701, episode: 'dentist waiting rooms were packed', minLearnedAt: clock.now() - 60 }]);
  const r = row('dentist waiting rooms');
  check('(setup) proposed', !!r);
  stance.reject(r.id);
  eq('rejected, its citation standing, it stays', store.getStance(r.id)?.status, 'rejected');
  stance.removeEvidenceFor([G1], {});
  eq('its citation gone: the row is gone, words and all', store.getStance(r.id), null);
  propose();
  await go();
  check('the next night\'s call doesn\'t carry the label', !/dentist waiting rooms/.test(calls.at(-1).user));
}

section('batch 3 review 3: a chat in the batch counts, whatever the model cited; the owner sees where from');
{
  fresh();
  propose(P('quiet bus rides', { evidence: ['E2'], value: 0.4 }));
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'dm', episodeId: 702, episode: 'something someone said in a dm', minLearnedAt: clock.now() - 60 }]);
  const r = row('quiet bus rides');
  check('(setup) proposed, citing only his own item', !!r);
  const kinds = store.stanceEvidence(r.id).filter(e => e.source === 'cited').map(e => e.originKind).sort();
  check('the chat\'s origin is on it too', kinds.includes('dm') && kinds.includes('self'), kinds);
  eq('the card says where from, kinds only', (await stance.view()).stances.find(x => x.id === r.id).citedFrom, ['dm', 'self']);
  check('no JID in what the card gets', !JSON.stringify((await stance.view()).stances.find(x => x.id === r.id)).includes(G1));
  await stance.approve([r.id]);
  check('approved, it still stays off the site', !stance.selfOriginRows().some(x => x.topic === r.topic));
  fresh();
  propose(P('quiet tram rides', { evidence: ['E1'], value: 0.4 }));
  await go();
  check('a night with no chat in it stays his own', store.stanceEvidence(row('quiet tram rides').id).every(e => e.originKind === 'self'));
  for (const label of ['cancer treatment', 'dialysis clinics', 'fertility treatments', 'the hospital bills', 'ram mandir visits', 'local pastor']) eq(`${label}: forbidden`, free.wordsProblem(label, {}, { label: true }), 'forbidden');
  eq('healthy eating isn\'t anyone\'s health', free.wordsProblem('healthy lunches', {}, { label: true }), null);
}

section('batch 3 review 4: a reassign that took the only citation takes the row');
{
  fresh();
  propose(P('late trains', { value: 0.4 }));
  await stance.freeTopicsNight(night(), [{ chatJid: G1, kind: 'group', episodeId: 703, episode: 'late trains again', minLearnedAt: clock.now() - 60 }]);
  const r = row('late trains');
  await stance.approve([r.id]);
  for (const e of store.stanceEvidence(r.id)) store.deleteStanceEvidenceIds([e.id]);   // what the rekey did to shape C
  stance.recomputeAll();
  eq('gone, not passing as his own', store.getStance(r.id), null);
}

section('batch 3 review 31: names and places by their parts, another script, each free topic its own click');
{
  const words = free.personaWords({ name: 'Arun Kumar', displayName: 'Arun', aliases: ['AK47x'], region: 'Riverton, Eastvale' });
  eq('a surname alone is him', free.wordsProblem('kumar family', words, { label: true }), 'self');
  eq('a state alone is a place', free.wordsProblem('eastvale rains', words, { label: true }), 'region');
  eq('a city alone too', free.wordsProblem('riverton metro', words, { label: true }), 'region');
  eq('an ordinary topic passes', free.wordsProblem('metro rides', words, { label: true }), null);
  eq('a script the lists can\'t read', free.wordsProblem('രാഷ്ട്രീയം', {}, { label: true }), 'script');
  eq('…also beside English', free.wordsProblem('मारी rides', {}, { label: true }), 'script');
  eq('an accent in a Latin word is fine', free.wordsProblem('café crawls', {}, { label: true }), null);
  fresh();
  propose(P('window seats', { value: 0.3 }));
  await go();
  const r = row('window seats');
  store.putStance({ topic: 'kind:walk', label: 'walks', kind: 'interest', value: 0.5, status: 'proposed', source: 'seed' });
  await stance.approve();
  eq('APPROVE ALL leaves a free topic waiting', store.getStance(r.id).status, 'proposed');
  eq('…and takes the rest', store.listStances().find(x => x.topic === 'kind:walk').status, 'active');
  await stance.approve([r.id]);
  eq('its own click approves it', store.getStance(r.id).status, 'active');
  const fs = await import('fs');
  const page = fs.readFileSync(new URL('../../src/dashboard/public/js/pages/mind.js', import.meta.url), 'utf8');
  check('the button counts only what it approves', /oneClick = proposed\.filter\(\(x\) => !x\.free\)/.test(page) && /APPROVE ALL \$\{oneClick\.length\}/.test(page));
}

section('batch 3 review 33: an owner deleting an unrelated memory leaves an approved topic');
{
  fresh();
  propose(P('morning trains', { value: 0.4 }));
  await stance.freeTopicsNight(night(), [{ chatJid: G2, kind: 'group', episodeId: 13, episode: 'morning trains', minLearnedAt: clock.now() - 60 }]);
  const r = row('morning trains');
  await stance.approve([r.id]);
  const since = clock.now() - 30 * DAY;
  eq('the owner\'s delete keeps a citation', stance.removeEvidenceFor([G2], { since, memoryIds: [9999], keepCited: true }), 0);
  check('the row stands', !!store.getStance(r.id));
  check('through its own memory it goes', stance.removeEvidenceFor([G2], { since, memoryIds: [13], keepCited: true }) >= 1 && !store.getStance(r.id));
  const fs = await import('fs');
  check('the hook passes it for an owner delete', /keepCited: cause === 'owner'/.test(fs.readFileSync(new URL('../../src/mind/hooks.js', import.meta.url), 'utf8')));
  // A forget or a revoke still takes it by chat and time.
  propose(P('evening ferries', { value: 0.4 }));
  await stance.freeTopicsNight(night(), [{ chatJid: G2, kind: 'group', episodeId: 14, episode: 'evening ferries', minLearnedAt: clock.now() - 60 }]);
  const q = row('evening ferries');
  stance.removeEvidenceFor([G2], { since });
  eq('a revoke still takes it', store.getStance(q.id), null);
}

section('batch 3 review 3: lose one chat of its batch and the row goes, whatever else it cites');
{
  const { getDb } = await import('../../src/memory/db.js');
  const hooks = await import('../../src/mind/hooks.js');
  const dm = { chatJid: A, kind: 'dm', episodeId: 801, episode: 'someone said a thing in a dm', minLearnedAt: clock.now() - 60 };
  const grp = { chatJid: G1, kind: 'group', episodeId: 802, episode: 'a group said another thing', minLearnedAt: clock.now() - 60 };
  const born = async (label, entries) => { fresh(); propose(P(label, { evidence: [`E${entries.length + 1}`], value: 0.4 })); await stance.freeTopicsNight(night(), entries); const r = row(label); check(`(setup) ${label} cites his own item too`, store.stanceEvidence(r.id).some(e => e.originKind === 'self')); return r; };

  let r = await born('tiny balconies', [dm]);
  stance.removeEvidenceFor([A], {});
  eq('a forget of the chat: gone, not left as his own', store.getStance(r.id), null);
  check('not on the site', !stance.selfOriginRows().some(x => x.label === 'tiny balconies'));

  r = await born('corner bakeries', [dm, grp]);
  await stance.approve([r.id]);
  stance.removeEvidenceFor([G1], {});
  eq('approved, one of two chats forgotten: gone', store.getStance(r.id), null);

  r = await born('tall bookshelves', [dm, grp]);
  const db = getDb();
  db.transaction(() => hooks.handlePersonPurged(db, A, [A]))();
  eq('the purge path: gone', store.getStance(r.id), null);
  propose();
  await go();
  check('and off the next night\'s call', !/tall bookshelves/.test(calls.at(-1).user));

  r = await born('old radios', [dm]);
  stance.removeEvidenceFor([G2], {});
  check('another chat\'s forget leaves it', !!store.getStance(r.id));

  // No chat in the batch: his own citation is all there is, and a later move citing a chat doesn't tie it to that chat.
  fresh();
  propose(P('paper maps', { value: 0.4 }));
  await go();
  r = row('paper maps');
  await stance.approve([r.id]);
  store.addStanceEvidence(r.id, night(), { at: clock.now(), eventIds: [], originKind: 'group', originJid: G2, source: 'cited', cause: 'cited', weight: 0 });
  stance.removeEvidenceFor([G2], {});
  check('a citation from a later move: its forget leaves the row', !!store.getStance(r.id));
}

section('guards');
{
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../../src/mind/stanceFree.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../../src/mind/stance.js', import.meta.url), 'utf8');
  check('no chat or message read of its own', !/getRecentMessages|messageStore/.test(src));
  check('logs carry counts only', !/log\.\w+\(\{[^}]*\b(text|label|why|words|user)\b/.test(src));
}

eq('no network', net.length, 0);
stance.__setDepsForTest(null);
void DAY;
report();
