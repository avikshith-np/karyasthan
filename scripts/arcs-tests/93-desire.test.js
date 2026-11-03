// Urge and the explicit register. Pure: no DB, no model.
// The public site keeps the words. Real-chat memory is the only gist.
import fs from 'fs';
import path from 'path';
import { section, check, eq, report } from './_helpers.js';
import {
  registerOf, sceneRegister, heatOf, organicPick, organicWeight, urgeNow, outsidePartner, looksFlirtatious,
} from '../../src/life/story/desire.js';
import { charterFor, HIS_CHARTER } from '../../src/life/story/phone/charter.js';
import { SCENE_CHARTER, renderUser as renderScene } from '../../src/life/story/scenes/charter.js';
import { urgeMultiplier } from '../../src/brain/decisionEngine.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function member(id, { relation = 'friend', closeness = 0.6, trust = 0.6, tension = 0.1, passion = 0.5 } = {}) {
  return [id, { id, name: id, relation, metrics: { closeness, trust, tension }, }];
}

function world({ stage = 'single', partner = null, extra = [] } = {}) {
  const cast = new Map([
    member('cast:asha', { passion: 0.7, closeness: 0.7 }),
    member('cast:nia', { passion: 0.55, closeness: 0.5 }),
    member('cast:sis', { relation: 'family:sister', passion: 0.9, closeness: 0.9 }),
    member('cast:boss', { relation: 'manager', passion: 0.6, closeness: 0.6 }),
    ...extra,
  ]);
  const story = {
    relationships: {
      'cast:asha': { passion: 0.7, commitment: 0.2 },
      'cast:nia': { passion: 0.55, commitment: 0.1 },
    },
    romance: { arcId: partner ? 7 : null, partnerId: partner, stage },
    arcs: partner ? { 7: { id: 7, category: 'romance', status: 'active', stage, castIds: [partner] } } : {},
  };
  return {
    at: Date.UTC(2026, 9, 31, 22, 0) / 1000,
    cast, story,
    vitals: { stress: 20, socialBattery: 80 },
    activity: { kind: 'free', placeId: 'place:home' },
    self: { homePlaceId: 'place:home' },
    places: new Map([['place:home', { id: 'place:home', kind: 'home', name: 'Flat' }]]),
    world: { timezone: 'UTC' },
  };
}

section('register');
{
  const s = world();
  const night = { age: 28, urge: 70, private: true };
  eq('a lust interest at night, high urge → explicit', registerOf(s, 'cast:asha', night), 'explicit');
  eq('the same person in the afternoon, not private → suggestive', registerOf(s, 'cast:asha', { ...night, private: false }), 'suggestive');
  eq('urge under 40 stays suggestive', registerOf(s, 'cast:asha', { ...night, urge: 30 }), 'suggestive');
  eq('family stays tame', registerOf(s, 'cast:sis', night), 'tame');
  eq('the manager stays tame', registerOf(s, 'cast:boss', night), 'tame');
  eq('under 21 stays tame', registerOf(s, 'cast:asha', { ...night, age: 20 }), 'tame');
  eq('a missing age stays tame', registerOf(s, 'cast:asha', { ...night, age: null }), 'tame');
  const cool = world();
  cool.cast.get('cast:asha').metrics.trust = 0.2;
  eq('trust under 0.35 stays tame', registerOf(cool, 'cast:asha', night), 'tame');
  eq('owner naughty forces explicit when she is eligible', registerOf(s, 'cast:asha', { age: 28, urge: 10, private: false, tone: 'naughty' }), 'explicit');
  eq('owner naughty to a sister is not eligible', registerOf(s, 'cast:sis', { age: 28, urge: 90, private: true, tone: 'naughty' }), 'tame');
  const partnered = world({ stage: 'married', partner: 'cast:asha' });
  eq('married, the rise still allows the partner', registerOf(partnered, 'cast:asha', night), 'explicit');
  eq('a lust interest stays available while he is married', registerOf(partnered, 'cast:nia', night), 'explicit');
  eq('outside the partner from dating on', outsidePartner(partnered, 'cast:nia'), true);
  eq('the partner herself is not outside', outsidePartner(partnered, 'cast:asha'), false);
  const single = world();
  eq('single has no outside-partner note', outsidePartner(single, 'cast:nia'), false);
}

section('urge does not care that he is committed');
{
  const open = world();
  const married = world({ stage: 'married', partner: 'cast:asha' });
  const at = open.at;
  eq('same clock, same body → same urge', urgeNow(open, { now: at, tz: 'UTC' }), urgeNow(married, { now: at, tz: 'UTC' }));
}

section('organic pick can land on someone else');
{
  const s = world({ stage: 'committed', partner: 'cast:asha' });
  s.story.relationships['cast:asha'].commitment = 0.9;
  const partnerW = organicWeight(s, 'cast:asha', { urge: 80, drama: 0.5 });
  const otherW = organicWeight(s, 'cast:nia', { urge: 80, drama: 0.5 });
  check('the partner outweighs the other person', partnerW > otherW && otherW > 0, [partnerW, otherW]);
  eq('a low roll picks the partner', organicPick(s, { urge: 80, drama: 0.5, roll: 0.05 }), 'cast:asha');
  eq('a roll past the partner can pick someone else', organicPick(s, { urge: 90, drama: 1, roll: 0.99 }), 'cast:nia');
  eq('below 55 the evening roll stays the old one', organicPick(s, { urge: 40, roll: 0.1 }), null);
}

section('heat of a written turn');
{
  eq('explicit words on an explicit turn settle urge', heatOf({ text: 'I want sex', register: 'explicit', tone: 'naughty' }), 'explicit');
  eq('a tame reply on an explicit turn does not', heatOf({ text: 'haha stop', register: 'explicit', tone: 'teasing' }), 'suggestive');
  eq('flirting on a tame turn is suggestive', heatOf({ text: 'you looked good', register: 'suggestive', tone: 'flirty' }), 'suggestive');
}

section('charters');
{
  check('the phone constants still carry the old ceiling', /nothing sexually explicit/.test(HIS_CHARTER));
  check('an explicit turn swaps that line', /Never anyone under 21/.test(charterFor(HIS_CHARTER, 'explicit')) && !/nothing sexually explicit/.test(charterFor(HIS_CHARTER, 'explicit')));
  check('the scene constant is unchanged', !/consensual sex/.test(SCENE_CHARTER));
  const sheet = { mode: 'full', him: { name: 'A' }, time: {}, people: [], place: { words: 'home' }, activity: 'hangout', outcome: 'well', register: 'explicit' };
  check('a private explicit scene may include sex', /consensual sex/.test(renderScene(sheet)));
  check('a tame scene sheet does not add that paragraph', !/consensual sex/.test(renderScene({ ...sheet, register: 'suggestive' })));
}

section('decision engine');
{
  eq('a flirtatious DM at urge 1 bumps by 1.2', urgeMultiplier({ isDm: true, content: 'come over, I miss you', urge: 1 }), 1.2);
  eq('urge under 0.55 does not bump', urgeMultiplier({ isDm: true, content: 'come over', urge: 0.5 }), 1);
  eq('a plain DM does not bump', urgeMultiplier({ isDm: true, content: 'what time is dinner', urge: 0.9 }), 1);
  eq('a group does not bump', urgeMultiplier({ isDm: false, content: 'come over', urge: 1 }), 1);
  check('the heuristic sees a flirt', looksFlirtatious('you look sexy tonight') === true);
}

section('where the words go');
{
  const phoneMem = read('src/life/story/phone/memory.js');
  const sceneMem = read('src/life/story/scenes/memory.js');
  const pub = read('src/public/index.js') + read('src/public/build.js') + read('src/life/publicView.js');
  check('a real chat gets the gist, not the sext', /it got heated/.test(phoneMem) && /contentProblem/.test(phoneMem));
  check('the public export does not swap in a fade line', !/the conversation got private/.test(pub) && !/they stayed in/.test(pub));
  check('publicPhone still returns the stored text', /r\.editedText \|\| r\.text/.test(phoneMem));
  check('a real-chat scene drops a graphic body', /graphic/.test(sceneMem));
  const phoneWorker = read('src/life/story/phone/worker.js');
  const sceneWorker = read('src/life/story/scenes/worker.js');
  check('an explicit text uses desire and does not try the next tier', /explicit \? 'desire'/.test(phoneWorker) && /if \(register === 'explicit'\) break/.test(phoneWorker));
  check('an explicit scene uses desire once', /explicit \? 'desire'/.test(sceneWorker) && /noFallback: true/.test(sceneWorker));
}

section('a private scene register');
{
  const s = world({ stage: 'dating', partner: 'cast:asha' });
  const base = { age: 28, urge: 80, castIds: ['cast:asha'], mode: 'full', outcome: 'well', privatePlace: true, firstMeet: false };
  eq('home with his partner, well → explicit', sceneRegister(s, base), 'explicit');
  eq('a public venue stays suggestive', sceneRegister(s, { ...base, privatePlace: false }), 'suggestive');
  eq('a first meeting stays suggestive', sceneRegister(s, { ...base, firstMeet: true }), 'suggestive');
  eq('a bad night stays suggestive', sceneRegister(s, { ...base, outcome: 'badly' }), 'suggestive');
  eq('two people stay tame', sceneRegister(s, { ...base, castIds: ['cast:asha', 'cast:nia'] }), 'tame');
  eq('someone else, at home, is still explicit', sceneRegister(s, { ...base, castIds: ['cast:nia'] }), 'explicit');
}

report();
