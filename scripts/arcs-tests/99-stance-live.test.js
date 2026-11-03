// Plan 020 B on the real log: a real revert and rewind take back what they evidenced, a heavy stretch teaches nothing,
// someone who left is set aside, and his interests reach his plans, his decisions and his sheets only through the seam.
import { setupScratchDb, bootLife, stopLife, simulateDays, fakeCallRole, section, check, eq, report, HOUR, DAY } from './_helpers.js';

await setupScratchDb();
const store = await import('../../src/mind/store.js');
const stance = await import('../../src/mind/stance.js');
const clockMod = await import('../../src/mind/clock.js');
const seam = await import('../../src/life/stanceSeam.js');
const routine = await import('../../src/life/routine.js');
const decisions = await import('../../src/life/decisions.js');
const phoneFacts = await import('../../src/life/story/phone/facts.js');
const { clock, life, world } = await bootLife({ callRole: fakeCallRole({}) });
clockMod.setClock?.(clock.fn);
store.setStoreClock(clock.fn);
stance.__setDepsForTest({ now: clock.fn, life: async () => life });

const put = (topic, value) => store.putStance({ topic, label: topic.split(':')[1], kind: topic.startsWith('kind:') || topic.startsWith('place:') ? 'interest' : 'opinion', value, status: 'active', source: 'seed' });

section('the catalogue is his world: fictional names, ids, no home, no office');
{
  const cat = life.stanceCatalogue();
  check('leisure kinds', cat.kinds.has('kind:cafe') && !cat.kinds.has('kind:groceries'));
  check('places by their own id', cat.places.has('place:cafe') && !cat.places.has('place:home') && !cat.places.has('place:office'));
  check('findings 12, 25: no home of any kind, no shop', !cat.places.has('place:family-home') && !cat.places.has('place:grocery') && cat.homes.has('place:family-home') && cat.homes.has('place:grocery'), [...cat.places.keys()]);
  check('cast by their own id', cat.cast.has('cast:flatmate'));
  eq('a topic reads in words', life.stanceLabel('kind:eat-out'), 'eat out');
}

section('the real text check');
{
  eq('a full clean sentence passes', life.stanceTextProblem('Cafes are where this person goes to think, with a long table and nobody asking anything of them.'), null);
  check('a JID does not', life.stanceTextProblem('Ask 15550001001@s.whatsapp.net about it') !== null);
}

section('no provider: nothing moves');
{
  eq('no view', seam.stanceOf('cafe', 'place:cafe'), null);
  const items = [{ kind: 'cafe', placeId: 'place:cafe', weight: 3 }];
  check('the very same array', seam.leanedLeisure(items) === items);
  eq('no sheet lines', seam.stanceSheetLines({ kind: 'cafe' }), []);
}

const days = new Set();
const update = async () => { const nk = clockMod.nightKey(clock.now()); if (days.has(nk)) return; days.add(nk); await stance.nightlyUpdate(nk); };
put('fixed:work', 0.1);
put('kind:cafe', 0.5);
put('place:cafe', 0.5);
put('cast:flatmate', 0.2);
store.setStanceSetting('stance_cursor', life.stanceLastEventId());
store.setStanceSetting('stance_exclusion_sig', life.stanceExclusionSig());

section('a real event, a real revert');
{
  await simulateDays(4, { stepMinutes: 30, onStep: () => update() });
  check('he lived something', store.allStanceEvidence().length > 0, store.allStanceEvidence().length);
  // work.late is on the revertible list: the owner can really undo it.
  const row = store.getStanceByTopic('fixed:work');
  const ev = store.stanceEvidence(row.id).find(e => e.cause === 'work_late' || e.cause === 'work_crunch');
  check('work moved it, through a live event', !!ev, store.stanceEvidence(row.id).map(e => e.cause));
  const moved = store.getStance(row.id).value;
  const res = life.revertEvent(ev.eventIds[0], { reason: 'test' });
  check('the owner reverted it', Number.isSafeInteger(res.revertEventId));
  eq('the log says it left', life.stanceIsExcluded(ev.eventIds[0]), true);
  check('the signature moved', life.stanceExclusionSig() !== store.getSetting('stance_exclusion_sig', null));
  check('the sweep took it', (await stance.sweep()).swept >= 1);
  eq('none of it left', store.stanceEvidence(row.id).some(e => e.eventIds.includes(ev.eventIds[0])), false);
  check('the value went back up', store.getStance(row.id).value > moved, [moved, store.getStance(row.id).value]);
}

section('a rewind across a night update');
{
  const story = await import('../../src/life/story/index.js');
  // Not bookkeeping (a revert stays through a rewind and can't be its target): the last thing he actually did.
  const lastBefore = life.stanceLived({ afterId: 0 }).events.at(-1).id;
  const before = store.allStanceEvidence().length;
  const nightsBefore = store.getSetting('stance_last_night', null);
  await simulateDays(3, { stepMinutes: 30, onStep: () => update() });
  check('a night update ran across the range', store.getSetting('stance_last_night', null) > nightsBefore);
  const added = store.allStanceEvidence().filter(e => e.eventIds.some(id => id > lastBefore));
  check('those days left evidence', added.length > 0 && store.allStanceEvidence().length > before, added.length);
  const pv = await story.director.preview({ kind: 'rewind', toEventId: lastBefore, reason: 'test' });
  check('the rewind previews', !pv.refusals?.length, JSON.stringify(pv.refusals));
  await story.director.apply(pv.previewId, pv.fingerprint);
  check('the events left the log', added.some(e => life.stanceIsExcluded(e.eventIds[0])));
  check('the sweep took what they evidenced', (await stance.sweep()).swept >= added.length * 0.5);
  eq('nothing past the rewind stays', store.allStanceEvidence().some(e => e.eventIds.some(id => id > lastBefore && life.stanceIsExcluded(id))), false);
}

section('heavy: read from the real log');
{
  const lived = life.stanceLived({ afterId: 0 });
  check('reads live events', lived.events.length > 0);
  check('a time in no heavy stretch is not heavy', lived.ctx.heavyAt(clock.now()) === false);
  const { appendEvent } = await import('../../src/life/eventLog.js');
  const at = clock.now();
  const h = appendEvent({ type: 'heavy.started', at, actor: 'engine', heavy: true, payload: { kind: 'loss', themeId: 'x', until: at + 3 * DAY } });
  const after = life.stanceLived({ afterId: 0 });
  check('inside the stretch', after.ctx.heavyAt(at + DAY) === true);
  check('after it', after.ctx.heavyAt(at + 4 * DAY) === false);
  const rules = await import('../../src/mind/stanceRules.js');
  eq('a scene inside it teaches nothing', rules.evidenceFrom([{ id: h.id + 1, type: 'scene.played', at: at + DAY, originKind: 'self', payload: { outcome: 'badly', kind: 'cafe', mode: 'full' } }], after.ctx), []);
}

section('the writers really get the lines');
{
  const sceneCharter = await import('../../src/life/story/scenes/charter.js');
  const phoneCharter = await import('../../src/life/story/phone/charter.js');
  const s = life.getState();
  seam.setStanceProvider({ sheetLines: () => ['He thinks well of them.'] });
  const built = phoneFacts.buildSheet(s, { castId: 'cast:flatmate', id: 1 }, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his' });
  check('in the phone writer\'s message', phoneCharter.renderUser(built.sheet).includes('He thinks well of them.'));
  seam.setStanceProvider(null);
  const none = phoneFacts.buildSheet(s, { castId: 'cast:flatmate', id: 1 }, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his' });
  check('nothing about it without a view', !phoneCharter.renderUser(none.sheet).includes('where he stands'));
  const sheet = { mode: 'full', him: { name: 'x' }, activity: 'cafe', place: { words: 'the cafe' }, time: { minutes: 60 }, people: [], outcome: 'fine', hisViews: ['He likes cafes.'] };
  check('in the scene writer\'s message', sceneCharter.renderUser(sheet).includes('He likes cafes.'));
  check('nothing about it without a view (scene)', !sceneCharter.renderUser({ ...sheet, hisViews: undefined }).includes('where he stands'));
}

section('a provider: he leans');
{
  seam.setStanceProvider({ numbers: () => new Map([['kind:cafe', 0.95], ['place:cafe', 0.9], ['kind:gym', 0.05]]), sheetLines: () => ['He likes cafe.'] });
  const view = seam.stanceOf('cafe', 'place:cafe');
  check('bump is positive and capped', view.bump > 0 && view.bump <= seam.BUMP_MAX, view);
  eq('no view on what he has none on', seam.stanceOf('movie', 'place:cinema'), null);
  const items = [{ kind: 'cafe', placeId: 'place:cafe', weight: 1 }, { kind: 'gym', placeId: 'place:gym', weight: 1 }];
  const leaned = seam.leanedLeisure(items);
  check('a liked thing weighs more, a disliked one less', leaned[0].weight > 1 && leaned[1].weight < 1, leaned);
  eq('the world is not touched', items[0].weight, 1);

  const s = life.getState();
  const d = { id: 1, kind: 'cafe', subject: { placeId: 'place:cafe', castIds: [], eventAt: clock.now() + 4 * HOUR }, options: [{ id: 'go', label: 'Go', go: true, kind: 'cafe', cost: {} }, { id: 'stay', label: 'Stay', kind: 'rest', cost: {} }], decideBy: clock.now() + 2 * HOUR, ponrAt: clock.now() + 3 * HOUR, status: 'open', opensAt: clock.now() };
  const us = decisions.utilities(d, s, world, { at: clock.now() });
  seam.setStanceProvider(null);
  const base = decisions.utilities(d, s, world, { at: clock.now() });
  check('go is worth more when he likes it', us.go > base.go, [us.go, base.go]);
  eq('stay is not touched', us.stay, base.stay);
  const j0 = decisions.jevState(d, s, clock.now(), base, { trigger: 'x' });
  check('Jev sees no new keys without a view', !('interest' in j0) && !('place_liking' in j0));
  seam.setStanceProvider({ numbers: () => new Map([['kind:cafe', 0.95]]) });
  const j1 = decisions.jevState(d, s, clock.now(), us, { trigger: 'x' });
  eq('Jev sees the number', j1.interest, 0.95);
  check('only for what he has a view on', !('place_liking' in j1));
  seam.setStanceProvider(null);
}

section('findings 10, 23: the evening proposal leans, and without a provider nothing moves');
{
  const pulseMod = await import('../../src/life/pulse.js');
  const s = life.getState();
  const count = () => {
    const by = {};
    for (let i = 0; i < 600; i++) {
      const d = new Date(Date.UTC(2027, 0, 1) + i * DAY * 1000).toISOString().slice(0, 10);
      const wakeAt = Date.parse(`${d}T01:00:00Z`) / 1000;
      const r = pulseMod.eveningProposal({ date: d, wakeAt, blocks: [], dayType: 'weekday' }, s, world);
      if (r?.spec?.kind) by[r.spec.kind] = (by[r.spec.kind] ?? 0) + 1;
    }
    return by;
  };
  const base = count();
  check('it proposes things', Object.values(base).reduce((a, b) => a + b, 0) > 50, base);
  eq('no provider, the same draws', count(), base);
  const kinds = Object.keys(base);
  seam.setStanceProvider({ numbers: () => new Map([[`kind:${kinds[0]}`, 1], ...kinds.slice(1).map(k => [`kind:${k}`, 0])]) });
  const leaned = count();
  seam.setStanceProvider(null);
  check('a kind he loves comes up more, one he doesn\'t less', (leaned[kinds[0]] ?? 0) > base[kinds[0]], [base, leaned]);
}

section('the phone sheet: his side only, absent without a view');
{
  const s = life.getState();
  const row = { castId: 'cast:flatmate', id: 1 };
  const base = phoneFacts.buildSheet(s, row, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his' });
  check('absent with no provider', !('hisViews' in base.sheet));
  seam.setStanceProvider({ sheetLines: () => ['He thinks well of them.'] });
  eq('on his side', phoneFacts.buildSheet(s, row, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his' }).sheet.hisViews, ['He thinks well of them.']);
  check('never the other side', !('hisViews' in phoneFacts.buildSheet(s, row, { tz: world.timezone, at: clock.now(), persona: {}, side: 'cast' }).sheet));
  check('never an explicit sheet', !('hisViews' in phoneFacts.buildSheet(s, row, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his', register: 'explicit' }).sheet));
  const fs = await import('fs');
  check('…a scene\'s either', fs.readFileSync(new URL('../../src/life/story/scenes/worker.js', import.meta.url), 'utf8').includes("if (built.sheet.register === 'explicit') delete built.sheet.hisViews;"));
  seam.setStanceProvider(null);
}

section('all the way into a reply: the tail, with the real door');
{
  const skills = await import('../../src/skills/skillRunner.js');
  const mind = await import('../../src/mind/index.js');
  const { buildConversationContext, buildSystemParts } = await import('../../src/personality/systemPrompt.js');
  const { resolveAudience } = await import('../../src/memory/recall.js');
  const { getDb } = await import('../../src/memory/db.js');
  const GROUP = '120363000000099001@g.us';
  const audience = resolveAudience({ chatJid: GROUP, kind: 'group' });
  const row = store.getStanceByTopic('kind:cafe');
  store.patchStance(row.id, { value: 0.95, baseValue: 0.95, anchor: 0.9, label: 'cafes' });
  const trigger = { id: 'S-1', groupJid: GROUP, senderJid: '81009@lid', senderName: 'Avery', content: 'anyone up for cafes later?', messageType: 'text', timestamp: clock.now() };
  getDb().prepare(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, is_from_self, timestamp, metadata_json) VALUES (?, ?, ?, ?, 'text', 0, ?, '{}')`)
    .run(trigger.id, GROUP, trigger.senderJid, trigger.content, trigger.timestamp);
  const render = () => buildConversationContext(GROUP, trigger, true, { audience, life: { availability: 'free', sneak: false } }).text;
  skills.setSkillEnabled('mind', false);
  mind.__resetStanceActiveForTest();
  const LINE = 'You like cafes.';
  check('mind off: no line', !render().includes(LINE));
  skills.setSkillEnabled('mind', true);
  store.initFirstLive(clock.now());
  mind.__resetStanceActiveForTest();
  check('mind on, and it is being talked about: the line is in the tail', render().includes(LINE), render().slice(-600));
  const stanceMod = await import('../../src/mind/stance.js');
  stanceMod.__resetLinesForTest();
  const { appendEvent } = await import('../../src/life/eventLog.js');
  const storyFacade = await import('../../src/life/story/index.js');
  check('finding 20: over his self-mention budget or under an embargo, no line', (() => {
    const appended = appendEvent({ type: 'embargo.started', at: clock.now(), actor: 'engine', payload: { until: clock.now() + DAY } });
    storyFacade.__rebuildForTest();
    void appended;
    return life.lineOpen(audience) === false && !render().includes(LINE);
  })());
  stanceMod.__resetLinesForTest();
  const { core, profile } = buildSystemParts(GROUP, true, null, { audience, track: false });
  check('never in the cached prefix', !`${core}\n${profile}`.includes(LINE));
  skills.setSkillEnabled('mind', false);
}

void routine; void DAY;
await stopLife();
stance.__setDepsForTest(null);
report();
