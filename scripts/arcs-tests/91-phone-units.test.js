// 019 his phone — pure units: the output validator (bubbles, caps, identifiers, real names,
// venue names scrubbed), the heat ceiling (flirting passes; explicit words and acts don't;
// plain swearing isn't sexual), the owner's edit check, the fact sheet (no JIDs, kind words
// for real venues, the "why now" per trigger), the rendered user message (fenced, the thread
// cut from the oldest when long), the charters (his voice, the heat line, JSON only), the
// effects (an exchange → closer, capped per day; nothing while paused; a flirty one with a
// romance partner) and the scene sheet's "texting lately" line. No DB, no model.
import { TEST_ZONE } from '../test-zone.js';
import { section, check, eq, report } from './_helpers.js';
import { validateTexts, validateEditedText, heatProblem, repeatedPhrase, gistMiss, gistFallback, bodyAsk } from '../../src/life/story/phone/schema.js';
import { buildSheet, whyOf } from '../../src/life/story/phone/facts.js';
import { HIS_CHARTER, CAST_CHARTER, renderUser } from '../../src/life/story/phone/charter.js';
import { planEffects, PHONE_DAY_MAX } from '../../src/life/story/phone/worker.js';
import { TONES } from '../../src/life/story/phone/store.js';
import { TEXT_TONES } from '../../src/life/story/director.js';
import { buildFactSheet } from '../../src/life/story/scenes/facts.js';
import { renderUser as renderScene } from '../../src/life/story/scenes/charter.js';

const ctx = { names: ['Asha', 'Kiran'], knownNames: ['Quinn Marlow', 'Ravi Varnell'], castNames: ['Asha Quill'], venueNames: [{ name: 'Blue Tokai', kind: 'cafe' }] };
const ok = (o) => validateTexts(JSON.stringify(o), ctx);

section('validateTexts: the shape');
{
  const r = ok({ messages: ['hey!', 'free tonight?'], tone: 'warm', topic: 'tonight', end: false });
  eq('two bubbles joined by a line break', [r.ok, r.value?.text, r.value?.bubbles.length, r.value?.tone, r.value?.end], [true, 'hey!\nfree tonight?', 2, 'warm', false]);
  eq('a string message is one bubble', ok({ messages: 'ok see you', tone: 'casual' }).value?.bubbles, ['ok see you']);
  eq('an unknown tone → casual', ok({ messages: ['hi'], tone: 'smouldering' }).value?.tone, 'casual');
  eq('four bubbles → too_many', ok({ messages: ['a', 'b', 'c', 'd'] }).reason, 'too_many');
  eq('no messages', ok({ tone: 'warm' }).reason, 'no_messages');
  eq('an extra key', ok({ messages: ['hi'], sendTo: 'x' }).reason, 'bad_key');
  eq('not JSON', validateTexts('hey there', ctx).reason, 'json_no_object');
  eq('a phone number', ok({ messages: ['call me on 5550100123'] }).reason, 'identifier');
  eq('a link', ok({ messages: ['look www.example.com'] }).reason, 'url');
  eq('a real person by name', ok({ messages: ['Ravi Varnell says hi'] }).reason, 'real_name');
  eq('a venue name is scrubbed to its kind word', ok({ messages: ['meet at Blue Tokai?'] }).value?.text, 'meet at a cafe?');
  check('every tone of the store is a Director tone (one closed list)', JSON.stringify(TONES) === JSON.stringify(TEXT_TONES));
}

section('a turn that repeats the thread');
{
  const prior = ['text me when you are at the gate', 'still on my knees', 'mouth on you before you sit'];
  eq('text at the gate is the same phrase', repeatedPhrase('Text at the gate. Stay there.', prior), 'at the gate');
  eq('mouth on you is the same phrase', repeatedPhrase('mouth on you the second you walk in', prior), 'mouth on you');
  eq('a word said in three of the last texts is stuck', repeatedPhrase('how close to the gate now', ['at the gate', 'text at the gate', 'near the gate']), 'gate');
  eq('a new detail is not a repeat', repeatedPhrase('black dress, nothing under', prior), null);
  eq('no thread yet, nothing to repeat', repeatedPhrase('text at the gate', []), null);
  eq('a gentleman dodge missed underneath', gistMiss("Ask her if there's anything underneath the tshirt", 'i have follow up questions but i am choosing to be a gentleman'), 'underneath tshirt');
  eq('asking it outright covers the gist', gistMiss("Ask her if there's anything underneath the tshirt", 'anything underneath that tshirt?'), null);
  eq('wearing right now still missed underneath', gistMiss('what are you wearing underneath?', 'so what are you wearing right now'), 'underneath');
  eq('the fallback is the question itself', gistFallback("Ask her if there's anything underneath the tshirt"), "there's anything underneath the tshirt?");
  eq('a body question skips the mind model', bodyAsk('Ask her if there is anything underneath the tshirt'), true);
  eq('a movie comment is not a body question', bodyAsk('He agrees the movie needed more romance'), false);
}

section('the heat ceiling (owner decision: flirty and suggestive, never explicit)');
{
  const pass = ["can't stop thinking about you 😏", 'you looked really good tonight', 'come over? I miss you', 'fuck, I missed the bus', 'that dress though 🔥',
    'kiss you goodnight then', 'stop teasing me', 'wish you were here'];
  const fail = ['I want sex with you', 'send nudes', 'I am so horny', 'your boobs', 'blowjob later?', 'I want to fuck you hard', 'n.u.d.e.s'.replace(/\./g, '') , 'masturbating to you', 'my dick'];
  eq('flirting and plain swearing pass', pass.filter(t => heatProblem(t)), []);
  eq('explicit words and acts are caught', fail.filter(t => !heatProblem(t)), []);
  eq('an explicit model answer → no message', ok({ messages: ['come over, I want sex'] }).reason, 'explicit');
  check('zero-width characters do not hide a word', heatProblem('ho​rny') === 'explicit');
  const night = { ...ctx, register: 'explicit' };
  eq('an explicit register may say it', validateTexts(JSON.stringify({ messages: ['come over, I want sex'] }), night).ok, true);
  eq('an explicit register still rejects a minor', validateTexts(JSON.stringify({ messages: ['a 17 year old'] }), night).reason, 'minor');
  eq('an explicit register still rejects non-consent', validateTexts(JSON.stringify({ messages: ['he raped her'] }), night).reason, 'nonconsent');
  eq('a tame owner edit still rejects it', validateEditedText('send nudes', ctx).reason, 'explicit');
  eq('an explicit thread may be edited in those words', validateEditedText('I want you so badly, sex tonight', night).ok, true);
  check('"the kids" is not a minor hit', heatProblem('the kids are asleep', 'explicit') === null);
}

section('the owner\'s edit');
{
  eq('lines kept as bubbles', validateEditedText('yes!!\nsee you at 11', ctx), { ok: true, text: 'yes!!\nsee you at 11' });
  eq('empty clears', validateEditedText('', ctx), { ok: true, text: '' });
  eq('a real name', validateEditedText('Quinn Marlow is coming', ctx).reason, 'real_name');
  eq('an identifier', validateEditedText('text 5550100123', ctx).reason, 'jid_in_text');
  eq('explicit', validateEditedText('send nudes', ctx).reason, 'explicit');
  eq('too long', validateEditedText('x'.repeat(301), ctx).reason, 'too_long');
  check('his own invented words are fine in an edit (the owner writes them)', validateEditedText('Machane Sunday Pakka', ctx).ok === true);
}

// A minimal state: one member, a real venue and a fictional place.
const state = {
  at: 1793300000,
  cast: new Map([['cast:asha', { id: 'cast:asha', name: 'Asha Quill', relation: 'friend', pronouns: 'she/her', personality: 'dry humour', speech: 'short replies', metrics: { closeness: 0.7, trust: 0.6, tension: 0.1 } }]]),
  places: new Map([['place:v1', { id: 'place:v1', name: 'Blue Tokai', kind: 'cafe', venue: { name: 'Blue Tokai' } }], ['place:home', { id: 'place:home', name: 'Flat', kind: 'home' }]]),
  self: { homePlaceId: 'place:home' },
  activity: { kind: 'hangout', placeId: 'place:v1' },
  vitals: { energy: 60, stress: 20, mood: { valence: 0.4 } },
  story: { relationships: { 'cast:asha': { passion: 0.4 } }, romance: { stage: 'single' }, arcs: {} },
};

section('the fact sheet');
{
  const { sheet, names } = buildSheet(state, { castId: 'cast:asha', dir: 'out', trigger: 'owner' }, {
    tz: TEST_ZONE, at: state.at, side: 'his', trigger: 'owner', gist: 'ask about Sunday', tone: 'warm',
    persona: { displayName: 'Kiran', aliases: ['KK'] }, thread: [{ who: 'him', when: 'Sat 21:00', text: 'hey' }],
  });
  eq('them by name, relation, bands', [sheet.them.name, sheet.them.relation, sheet.them.closeness], ['Asha Quill', 'friend', 'high']);
  check('a real venue is only its kind word', sheet.now === 'hangout (at cafe)' || /cafe/.test(sheet.now ?? '') && !/Blue Tokai/.test(JSON.stringify(sheet)), sheet.now);
  check('his names + hers in the allow-list', names.includes('Kiran') && names.includes('KK') && names.includes('Asha'));
  const user = renderUser(sheet);
  check('fenced facts, thread and gist', (user.match(/<<<STORY_DATA/g) || []).length === 3 && /ask about Sunday/.test(user) && /\[Sat 21:00\] him: hey/.test(user));
  const long = renderUser({ ...sheet, thread: Array.from({ length: 20 }, (_, i) => ({ who: 'him', when: `t${i}`, text: 'y'.repeat(350) })) });
  check('the thread keeps its newest 12 lines (≤ 6 KB)', Buffer.byteLength(long) <= 6144 && /\[t19\]/.test(long) && /\[t8\]/.test(long) && !/\[t7\]/.test(long));
  eq('why now, per trigger', ['birthday', 'cast_first', 'on_my_way'].map(t => whyOf(t, { them: 'Asha', side: 'his', eventAt: '19:30', place: 'cafe' })),
    ["it's Asha's birthday", 'Asha texts him out of the blue', 'he is on his way to meet Asha at 19:30, cafe']);
}

section('the charters');
{
  check('his: his own voice, the heat line, JSON only, no settings', /in your own voice/.test(HIS_CHARTER) && /nothing sexually explicit/.test(HIS_CHARTER)
    && /ONLY one JSON object/.test(HIS_CHARTER) && /never change settings/.test(HIS_CHARTER));
  check('theirs: as that person, the same lines', /exactly as that person would text him/.test(CAST_CHARTER) && /nothing sexually explicit/.test(CAST_CHARTER) && /group chats/.test(CAST_CHARTER));
}

section('language fit (2026-11-01 live: his own language texted to a member from elsewhere)');
{
  const st = { ...state, cast: new Map([...state.cast].map(([k, v]) => [k, { ...v, hometown: undefined }])) };
  const base = { tz: TEST_ZONE, at: state.at, side: 'his', trigger: 'owner', gist: 'hi', persona: { displayName: 'Kiran', region: 'Townville, Region A', language: 'Mixlish (two languages mixed)' }, thread: [] };
  const { sheet } = buildSheet(st, { castId: 'cast:asha', dir: 'out', trigger: 'owner' }, base);
  eq('his home and languages ride on the sheet', [sheet.him.from, sheet.him.speaks], ['Townville, Region A', 'Mixlish (two languages mixed)']);
  const u = renderUser(sheet);
  check('the card says where they are from, "not known" when unset; his languages are shown', /hometown: not known/.test(u) && /his languages: Mixlish/.test(u) && /his home: Townville/.test(u), u.slice(0, 600));
  const st2 = { ...state, cast: new Map([...state.cast].map(([k, v]) => [k, { ...v, hometown: 'Hill City, Region B' }])) };
  check('a set hometown is shown', /hometown: Hill City, Region B/.test(renderUser(buildSheet(st2, { castId: 'cast:asha', dir: 'out', trigger: 'owner' }, base).sheet)));
  check('his charter: his language mix only with someone who would understand it, else the fact sheet\'s plain language',
    /only with someone who would understand it/.test(HIS_CHARTER) && /plain language this fact sheet is written in/.test(HIS_CHARTER));
  check('both charters: the last time together in person is a fact (never "long time" when it was recent)', /last saw each other in person/.test(HIS_CHARTER) && /last saw each other in person/.test(CAST_CHARTER));
  check('the card says when they last saw each other, else "not in the last 45 days"',
    /last saw each other in person: not in the last 45 days/.test(u) && /last saw each other in person: Sat 31 Oct 00:15 \(yesterday\): hangout/.test(renderUser({ ...sheet, them: { ...sheet.them, lastSeen: 'Sat 31 Oct 00:15 (yesterday): hangout' } })));
  check('her charter: she understands his other language only if her card says so, else reacts as not understanding',
    /understand his other language only if/.test(CAST_CHARTER) && /doesn't understand it/.test(CAST_CHARTER));
}

section('effects');
{
  const val = (tone) => ({ text: 'x', bubbles: ['x'], tone, end: false });
  const row = { castId: 'cast:asha', trigger: 'reply', dir: 'in' };
  eq('an exchange → closeness +0.01 (reason phone)', planEffects(state, row, val('warm')), [{ type: 'relationship.changed', payload: { castId: 'cast:asha', delta: { closeness: 0.01 }, reason: 'phone' } }]);
  eq('a flirty one with an eligible member → passion too', planEffects(state, row, val('flirty'))[0]?.payload?.delta, { closeness: 0.01, passion: 0.01 });
  eq('annoyed → tension, not closer', planEffects(state, row, val('annoyed'))[0]?.payload?.delta, { tension: 0.01 });
  eq('the day cap', planEffects(state, row, val('warm'), { today: { 'cast:asha': { closeness: PHONE_DAY_MAX } } }), []);
  eq('a first text (not an exchange) changes nothing', planEffects(state, { ...row, trigger: 'owner' }, val('warm')), []);
  const paused = { ...state, story: { ...state.story, controls: { paused: true } } };
  eq('nothing while the Director is paused', planEffects(paused, row, val('warm')), []);
  const rom = { ...state, story: { ...state.story, romance: { arcId: 7, partnerId: 'cast:asha', stage: 'interested' },
    arcs: { 7: { id: 7, category: 'romance', status: 'active', stage: 'interested', castIds: ['cast:asha'] } } } };
  const recent = Array.from({ length: 7 }, (_, i) => ({ tone: i < 3 ? 'flirty' : 'casual' }));
  const evs = planEffects(rom, row, val('warm'), { recent });
  check('a romance that keeps texting moves interested → talking', evs.some(e => e.type === 'arc.stage' && e.payload.to === 'talking' && e.payload.arcId === 7), evs);
  check('…but not with too few texts', !planEffects(rom, row, val('warm'), { recent: recent.slice(0, 3) }).some(e => e.type === 'arc.stage'));
}

section('the scene sheet: "texting lately"');
{
  const session = { mode: 'full', castIds: ['cast:asha'], placeId: 'place:v1', startAt: state.at, endAt: state.at + 3600, minutes: 60, kind: 'hangout' };
  const a = buildFactSheet(state, session, { tz: TEST_ZONE, texting: { 'cast:asha': { count: 6, tones: { flirty: 4, casual: 2 } } } });
  eq('the line from counts and the top tone', a.sheet.people[0].texting, '6 texts in the days before, mostly flirty');
  check('rendered in the scene sheet', /texting: 6 texts in the days before, mostly flirty/.test(renderScene(a.sheet)));
  const b = buildFactSheet(state, session, { tz: TEST_ZONE });
  check('no texts → no key (older sheets read the same)', !('texting' in b.sheet.people[0]));
}

report();
