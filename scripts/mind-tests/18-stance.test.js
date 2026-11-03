// Plan 020 B, the starting set: one mind call drafts rows that wait for the owner; nothing is active until
// approved; a budget stop writes nothing; the model's topics, values and whys are checked in code.
import { setupScratchDb, fakeClock, blockNetwork, section, check, eq, report, DAY } from './_helpers.js';

await setupScratchDb();
const net = blockNetwork();
const store = await import('../../src/mind/store.js');
const stance = await import('../../src/mind/stance.js');
const rules = await import('../../src/mind/stanceRules.js');
const clockMod = await import('../../src/mind/clock.js');

const clock = fakeClock(Date.UTC(2026, 9, 27, 18, 0) / 1000);
store.setStoreClock(clock.fn);
clockMod.setClock?.(clock.fn);

const CAT = {
  kinds: new Map([['kind:cafe', 'cafe'], ['kind:walk', 'walk']]),
  places: new Map([['place:park', 'the park']]),
  cast: new Map([['cast:flatmate', 'Robin']]),
  fixed: new Map([['fixed:work', 'work']]),
  homes: new Set(['place:home']),
};
const lifeStub = {
  stanceCatalogue: () => CAT,
  stanceTextProblem: (t) => (/Real Person|@s\.whatsapp/.test(t) ? 'jid_in_text' : null),
  stanceLastEventId: () => 42,
  stanceExclusionSig: () => '0:0',
  stanceLabel: (topic) => CAT.kinds.get(topic) ?? CAT.places.get(topic) ?? CAT.cast.get(topic) ?? CAT.fixed.get(topic) ?? null,
};
let calls = [];
let reply = '';
let budget = { ok: true };
stance.__setDepsForTest({
  now: clock.fn,
  life: async () => lifeStub,
  identity: async () => 'A person.',
  budgetOk: async () => budget,
  callRole: async (role, sys, user, opts) => { calls.push({ role, sys, user, opts }); return { status: 'ok', text: reply }; },
});

section('budget stop: no call, no rows');
{
  budget = { ok: false, reason: 'budget' };
  const r = await stance.seed();
  eq('refused', r, { ok: false, reason: 'budget' });
  eq('no model call', calls.length, 0);
  eq('no rows', store.listStances().length, 0);
  budget = { ok: true };
}

section('nothing to draft from while life is off');
{
  stance.__setDepsForTest({ life: async () => ({ stanceCatalogue: () => null }) });
  eq('refused', (await stance.seed()).reason, 'life_off');
  stance.__setDepsForTest({ life: async () => lifeStub });
}

section('the seed call, and what is kept of its answer');
{
  reply = JSON.stringify({ stances: [
    { topic: 'kind:cafe', value: 0.8, why: 'Cafes are where this person thinks.' },
    { topic: 'kind:walk', value: 9, why: 'Clamped into the range.' },
    { topic: 'fixed:work', value: -0.3, why: 'Reminded of Real Person at work.' },
    { topic: 'cast:flatmate', value: 0.4 },
    { topic: 'free:politics', value: 1, why: 'Not on the list.' },
    { topic: 'kind:cafe', value: 0.1, why: 'A second row for the same topic.' },
  ] });
  const r = await stance.seed();
  eq('four kept', r, { ok: true, count: 4 });
  eq('one mind call', calls.length, 1);
  eq('role + caller', [calls[0].role, calls[0].opts.caller], ['mind', 'mind.stance.seed']);
  check('the catalogue is in the prompt', calls[0].user.includes('kind:cafe (interest): cafe') && calls[0].user.includes('cast:flatmate (opinion): Robin'));
  const by = new Map(store.listStances().map(x => [x.topic, x]));
  eq('all wait for the owner', [...by.values()].every(x => x.status === 'proposed'), true);
  eq('first row wins', by.get('kind:cafe').value, 0.8);
  eq('value clamped to range', by.get('kind:walk').value, 1);
  eq('anchor starts at value', by.get('fixed:work').anchor, -0.3);
  eq('a why naming a real person is dropped', by.get('fixed:work').why, null);
  check('an unknown topic is dropped', !by.has('free:politics'));
  eq('fixed topics take less up', by.get('fixed:work').uptake, 0.6);
  eq('a second seed is refused', (await stance.seed()).reason, 'exists');
  eq('still one call', calls.length, 1);
}

section('a full-sentence why survives the check (the 80-char query cap is not the rule here)');
{
  const long = 'Cafes are where this person goes to think, with a long table and nobody asking anything of them.';
  check('over 80 characters', long.length > 80);
  const out = stance.cleanSeed([{ topic: 'kind:cafe', value: 0.5, why: long }], [{ topic: 'kind:cafe', label: 'cafe' }], () => null);
  eq('kept', out[0].why, long);
}

section('approving with life off starts nothing');
{
  stance.__setDepsForTest({ life: async () => ({ stanceLastEventId: () => null }) });
  eq('refused', (await stance.approve()).reason, 'life_off');
  eq('still waiting', store.listStances({ status: 'proposed' }).length > 0, true);
  eq('no cursor', store.getSetting('stance_cursor', null), null);
  stance.__setDepsForTest({ life: async () => lifeStub });
}

section('a broken answer writes nothing');
{
  store.stanceTx(() => { for (const x of store.listStances()) store.patchStance(x.id, { status: 'rejected' }); });
  reply = 'not json';
  eq('invalid', (await stance.seed()).reason, 'invalid');
  eq('no proposed rows', store.listStances({ status: 'proposed' }).length, 0);
  reply = JSON.stringify({ stances: [{ topic: 'kind:cafe', value: 0.8, why: 'Cafes.' }, { topic: 'fixed:work', value: -0.3, why: 'Long days.' }, { topic: 'cast:flatmate', value: 0.4, why: 'Easy to live with.' }] });
  const r = await stance.seed();
  eq('after rejecting everything a new draft is allowed', r.count, 3);
}

section('owner: approve, reject, pin, anchor, reset');
{
  const by = () => new Map(store.listStances().map(x => [x.topic, x]));
  eq('nothing starts the cursor before approval', store.getSetting('stance_cursor', null), null);
  eq('reject', stance.reject(by().get('cast:flatmate').id).ok, true);
  eq('rejected is not listed for the page', (await stance.view()).stances.some(x => x.topic === 'cast:flatmate'), false);
  eq('approving a single row', (await stance.approve([by().get('kind:cafe').id])).approved, 1);
  eq('the cursor starts at the log end', store.getSetting('stance_cursor', null), 42);
  eq('the rest still wait', by().get('fixed:work').status, 'proposed');
  eq('set anchor on a proposed row moves its value', [stance.setAnchor(by().get('fixed:work').id, -0.5).ok, by().get('fixed:work').value], [true, -0.5]);
  eq('out of range', stance.setAnchor(by().get('kind:cafe').id, -0.5).reason, 'out_of_range');
  eq('approve the rest', (await stance.approve()).approved, 1);
  eq('nothing left', (await stance.approve()).reason, 'nothing_proposed');
  eq('anchor on an active row leaves its value', [stance.setAnchor(by().get('kind:cafe').id, 0.6).anchor, by().get('kind:cafe').value], [0.6, 0.8]);
  eq('pin', [stance.setPinned(by().get('kind:cafe').id, true).ok, by().get('kind:cafe').pinned], [true, true]);
  eq('reset: value back to anchor', [stance.reset(by().get('kind:cafe').id).ok, by().get('kind:cafe').value], [true, 0.6]);
  eq('unknown id', stance.reset(9999).reason, 'not_found');
}

section('why: plain words, never a chat\'s');
{
  const row = store.getStanceByTopic('kind:cafe');
  store.addStanceEvidence(row.id, '2026-10-27', { at: clock.fn(), source: 'scene', cause: 'scene:well', weight: 1, eventIds: [7] });
  store.addStanceEvidence(row.id, '2026-10-27', { at: clock.fn(), source: 'chat', cause: 'chat:roast', weight: -0.6, eventIds: [8], originKind: 'group', originJid: '120363000000081001@g.us' });
  const w = await stance.why(row.id);
  eq('two lines', w.lines.map(l => [l.words, l.direction]), [['it went well', 'up'], ['a roasting in a chat', 'down']]);
  check('no chat id in the why', !JSON.stringify(w).includes('g.us'));
  eq('the page view has no jid either', JSON.stringify(await stance.view()).includes('g.us'), false);
}

section('the labels follow a rename');
{
  const orig = CAT.kinds.get('kind:cafe');
  CAT.kinds.set('kind:cafe', 'coffee');
  eq('label from the world', (await stance.view()).stances.find(x => x.topic === 'kind:cafe').label, 'coffee');
  CAT.kinds.set('kind:cafe', orig);
}

section('rules are pure and bounded');
{
  eq('range', [rules.rangeOf('interest'), rules.rangeOf('opinion')], [[0, 1], [-1, 1]]);
  eq('topic kinds', ['kind:x', 'place:y', 'cast:z', 'fixed:work'].map(rules.kindOfTopic), ['interest', 'interest', 'opinion', 'opinion']);
}

eq('no network', net.length, 0);
stance.__setDepsForTest(null);
report();
