// 010 T008 — eventLog.js seams (contracts/story-api.md §3.1, data-model §2.1):
// an owner cause yields a self consequence (research R3) while a chat cause still
// taints; OWNER_ONLY_TYPES; the heavy.started-only heavy rule; the adoption rule;
// the chat-origin deny-list for story families (009's chat chains unchanged); and
// the new reads leanHistory / listRewinds / lastHeavyAt. Scratch DB, fake clock,
// invented jids only.
import { setupScratchDb, fakeClock, section, check, eq, throws, report } from './_helpers.js';
import { setClock } from '../../src/life/clock.js';
import {
  appendEvent, getEvent, revertEvent, redactPerson, lastEventId,
  leanHistory, listRewinds, lastHeavyAt,
  EVENT_TYPES, STORY_EVENT_TYPES, OWNER_ONLY_TYPES, CHAT_FORBIDDEN_TYPES,
} from '../../src/life/eventLog.js';

await setupScratchDb();
const clock = fakeClock();
setClock(clock.fn);
const T0 = clock.now();
const H = 3600;

const GROUP = '120363000000000101@g.us';
const DM = '15550000101@s.whatsapp.net';
const PERSON = '15550000102@s.whatsapp.net';

try {
  section('catalogue');
  eq('37 story types added', STORY_EVENT_TYPES.size, 37);
  check('every story type is in EVENT_TYPES', [...STORY_EVENT_TYPES].every(t => EVENT_TYPES.has(t)));
  check('009 types still there', EVENT_TYPES.has('event.reverted') && EVENT_TYPES.has('claim.flagged'));
  for (const t of ['story.daily_done', 'heavy.lapsed', 'world.rewound', 'vitals.nudged', 'claim.adopted', 'director.reconciler_mode']) {
    check(`has ${t}`, EVENT_TYPES.has(t));
  }
  // 011 adds four (its weather windows and goals) to 010's 13; 014 geo its own list (route.recorded),
  // 014 sched its two schedule overrides; 015 eight god types; 016 scene.tone_set + scene.regenerated; wake him its wake.set.
  const { GEO_EVENT_TYPES, SCHEDULE_EVENT_TYPES, WAKE_EVENT_TYPES } = await import('../../src/life/eventLog.js');
  // 019: + phone.text_set (the owner's "he texts …").
  eq('27 owner-only types (010: 13, 011: 4, 015: 8, 016: 2) + the 014 geo and sched lists + wake.set + phone.text_set', OWNER_ONLY_TYPES.size,
    27 + GEO_EVENT_TYPES.size + SCHEDULE_EVENT_TYPES.size + WAKE_EVENT_TYPES.size + 1);
  check('011 owner-only: weather windows and goals', ['weather.window_set', 'weather.window_ended', 'goal.set', 'goal.cancelled']
    .every(t => OWNER_ONLY_TYPES.has(t)));
  check('deny-list covers the families', ['career.appraisal', 'family.call', 'heavy.started', 'arc.stage', 'story.daily_done',
    'relationship.changed', 'cast.created', 'cast.beat', 'place.created', 'place.updated', 'vitals.nudged', 'money.salary',
    'sick.started', 'sick.ended'].every(t => CHAT_FORBIDDEN_TYPES.has(t)));
  check('deny-list spares 009 outing chains', !['decision.lean', 'decision.committed', 'plan.made', 'activity.started',
    'travel.started', 'money.spent', 'meal', 'work.late', 'sleep.started', 'claim.adopted', 'activity.recorded',
    'commitment.recorded', 'claim.withdrawn', 'chat.trigger', 'claim.flagged'].some(t => CHAT_FORBIDDEN_TYPES.has(t)));

  section('owner cause → self consequence (R3)');
  const genesis = appendEvent({ type: 'genesis', actor: 'engine', payload: { source: 'example' } });
  const ownerPlan = appendEvent({ type: 'plan.made', actor: 'owner', payload: { date: '2026-10-27', blocks: [] } });
  eq('owner plan is origin owner', [ownerPlan.originKind, ownerPlan.originJid], ['owner', 'owner']);
  const block = appendEvent({ type: 'activity.started', actor: 'engine', causeId: ownerPlan.id, payload: { kind: 'free' } });
  eq('engine block of an owner plan.made → self', [block.originKind, block.originJid, block.causeId], ['self', 'self', ownerPlan.id]);
  const explicitSelf = appendEvent({ type: 'meal', actor: 'engine', causeId: ownerPlan.id, originKind: 'self' });
  eq('explicit self under an owner cause passes the taint check', explicitSelf.originKind, 'self');
  const grandchild = appendEvent({ type: 'activity.ended', actor: 'engine', causeId: block.id });
  eq('and stays self down the chain', grandchild.originKind, 'self');
  const ownerPick = appendEvent({ type: 'decision.committed', actor: 'owner', payload: { decisionId: 1, optionId: 'go', by: 'owner' } });
  const stage = appendEvent({ type: 'arc.stage', actor: 'engine', causeId: ownerPick.id, payload: { arcId: 1, from: 'talking', to: 'dating' } });
  eq('story consequence of an owner pick → self (allowed)', stage.originKind, 'self');
  throws('engine still cannot claim origin owner', () => appendEvent({ type: 'meal', actor: 'engine', causeId: ownerPlan.id, originKind: 'owner' }), /only the owner/);

  section('chat cause still taints');
  const trig = appendEvent({ type: 'chat.trigger', actor: 'chat', originKind: 'group', originJid: GROUP, payload: { decisionId: 1, toward: 'go' } });
  const lean = appendEvent({ type: 'decision.lean', actor: 'jev', causeId: trig.id, payload: { decisionId: 1, optionId: 'go', p: 0.6 } });
  eq('lean inherits the group', [lean.originKind, lean.originJid], ['group', GROUP]);
  throws('no laundering to self', () => appendEvent({ type: 'decision.committed', actor: 'engine', causeId: lean.id, originKind: 'self' }), /does not match/);
  const ownerOverChat = appendEvent({ type: 'cast.updated', actor: 'owner', causeId: trig.id, payload: { castId: 'cast:river', fields: { status: 'x' } } });
  eq('owner writes stay owner even under a chat cause (deny-list is non-owner)', ownerOverChat.originKind, 'owner');

  section('009 chat chains unchanged');
  const commit = appendEvent({ type: 'decision.committed', actor: 'engine', causeId: lean.id, payload: { decisionId: 1, optionId: 'go' } });
  const amended = appendEvent({ type: 'plan.made', actor: 'engine', causeId: commit.id, payload: { amendedFor: 1, blocks: [] } });
  const chain = [amended];
  for (const type of ['travel.started', 'money.spent', 'activity.started', 'meal', 'activity.ended', 'work.late', 'sleep.started']) {
    chain.push(appendEvent({ type, actor: 'engine', causeId: chain[chain.length - 1].id, payload: {} }));
  }
  check('decision → plan.made → travel/spend/activity/meal/late/sleep all carry the group', chain.every(e => e.originJid === GROUP));

  section('chat-origin deny-list');
  const n0 = lastEventId();
  const forbidden = ['career.appraisal', 'career.job_changed', 'family.call', 'heavy.proposed', 'arc.started', 'arc.stage',
    'story.daily_done', 'relationship.changed', 'cast.created', 'cast.beat', 'cast.history_added', 'place.created',
    'place.updated', 'vitals.nudged', 'money.salary', 'sick.started', 'sick.ended'];
  for (const type of forbidden) {
    throws(`${type} caused by a chat chain refused`, () => appendEvent({ type, actor: 'engine', causeId: amended.id, payload: {} }), /cannot have a chat origin/);
  }
  throws('mind cannot either', () => appendEvent({ type: 'cast.beat', actor: 'mind', causeId: lean.id, payload: {} }), /chat origin/);
  throws('explicit chat origin without a cause refused', () => appendEvent({ type: 'cast.created', actor: 'engine', originKind: 'dm', originJid: DM, payload: {} }), /chat origin/);
  throws('ig origin counts as chat', () => appendEvent({ type: 'relationship.changed', actor: 'engine', originKind: 'ig', originJid: 'ig:group', payload: {} }), /chat origin/);
  throws('call origin counts as chat', () => appendEvent({ type: 'heavy.ended', actor: 'engine', originKind: 'call', originJid: DM, payload: {} }), /chat origin/);
  eq('nothing appended by the refused writes', lastEventId(), n0);
  const selfBeat = appendEvent({ type: 'cast.beat', actor: 'engine', payload: { castId: 'cast:river', kind: 'status', text: 'x' } });
  eq('self-origin story events are fine', selfBeat.originKind, 'self');
  const mindBeat = appendEvent({ type: 'cast.beat', actor: 'mind', payload: { castId: 'cast:river', kind: 'news', text: 'y' } });
  eq('mind beats are self', mindBeat.originKind, 'self');

  section('owner-only types');
  for (const actor of ['engine', 'mind', 'jev']) {
    throws(`director.fate_set by ${actor} refused`, () => appendEvent({ type: 'director.fate_set', actor, payload: { category: 'romance', mode: 'frozen' } }), /only the owner/);
  }
  throws('world.rewound by engine refused', () => appendEvent({ type: 'world.rewound', actor: 'engine', payload: { toEventId: 1 } }), /only the owner/);
  throws('heavy.vetoed by engine refused', () => appendEvent({ type: 'heavy.vetoed', actor: 'engine', payload: { proposedId: 1 } }), /only the owner/);
  throws('director.* by chat refused', () => appendEvent({ type: 'director.paused', actor: 'chat', originKind: 'group', originJid: GROUP }), /chat cannot append/);
  const fate = appendEvent({ type: 'director.fate_set', actor: 'owner', payload: { category: 'romance', mode: 'guided' } });
  eq('owner director event is origin owner', [fate.actor, fate.originKind], ['owner', 'owner']);

  section('heavy rule');
  throws('heavy.started must be heavy', () => appendEvent({ type: 'heavy.started', actor: 'engine', payload: { kind: 'minor_accident' } }), /must be heavy/);
  throws('mind cannot start a heavy arc', () => appendEvent({ type: 'heavy.started', actor: 'mind', heavy: true, payload: {} }), /cannot start a heavy arc/);
  throws('jev cannot either', () => appendEvent({ type: 'heavy.started', actor: 'jev', heavy: true, payload: {} }), /heavy/);
  throws('heavy.proposed cannot be heavy', () => appendEvent({ type: 'heavy.proposed', actor: 'engine', heavy: true, payload: {} }), /cannot be heavy/);
  throws('cast.beat cannot be heavy', () => appendEvent({ type: 'cast.beat', actor: 'owner', heavy: true, payload: {} }), /cannot be heavy/);
  const engineHeavy = appendEvent({ type: 'heavy.started', actor: 'engine', heavy: true, payload: { kind: 'minor_accident', until: T0 + 3 * 86400 } });
  check('engine heavy.started accepted', engineHeavy.heavy && engineHeavy.originKind === 'self');
  const ownerHeavy = appendEvent({ type: 'heavy.started', actor: 'owner', heavy: true, payload: { kind: 'pet_loss' } });
  check('owner heavy.started accepted', ownerHeavy.heavy && ownerHeavy.originKind === 'owner');
  const mind009 = appendEvent({ type: 'work.crunch', actor: 'mind', heavy: true, payload: {} });
  check('009 types keep the 009 heavy rule (mind may)', mind009.heavy);

  section('adoption rule');
  const claim = appendEvent({ type: 'claim.flagged', actor: 'chat', originKind: 'dm', originJid: DM, payload: { claimId: 7 } });
  throws('claim.adopted needs actor engine', () => appendEvent({ type: 'claim.adopted', actor: 'mind', causeId: claim.id, payload: {} }), /must be an engine event/);
  throws('owner cannot write claim.adopted', () => appendEvent({ type: 'claim.adopted', actor: 'owner', causeId: claim.id, payload: {} }), /engine event/);
  throws('claim.adopted needs a cause', () => appendEvent({ type: 'claim.adopted', actor: 'engine', payload: {} }), /needs a cause/);
  throws('activity.recorded needs a cause', () => appendEvent({ type: 'activity.recorded', actor: 'engine', payload: {} }), /needs a cause/);
  throws('missing cause still refused', () => appendEvent({ type: 'claim.withdrawn', actor: 'engine', causeId: 99999, payload: {} }), /does not exist/);
  const adopted = appendEvent({ type: 'claim.adopted', actor: 'engine', causeId: claim.id, payload: { claimId: 7, reviewId: 1, as: 'commitment', ref: null } });
  eq('adoption inherits the DM origin', [adopted.originKind, adopted.originJid], ['dm', DM]);
  const rec = appendEvent({ type: 'commitment.recorded', actor: 'engine', causeId: adopted.id, payload: { dueAt: T0 + 86400, castIds: [], label: 'x' } });
  eq('record inherits it too', rec.originJid, DM);
  throws('record cannot be laundered to self', () => appendEvent({ type: 'activity.recorded', actor: 'engine', causeId: adopted.id, originKind: 'self', payload: {} }), /does not match/);
  throws('an adoption cannot reach a story family', () => appendEvent({ type: 'cast.created', actor: 'engine', causeId: adopted.id, payload: {} }), /chat origin/);
  const withdrawn = appendEvent({ type: 'claim.withdrawn', actor: 'engine', causeId: claim.id, payload: { claimId: 7, reason: 'forgotten' } });
  eq('claim.withdrawn caused by the pointer', withdrawn.causeId, claim.id);

  section('leanHistory');
  const dA = appendEvent({ type: 'decision.opened', actor: 'engine', payload: { kind: 'romance:step', options: [{ id: 'step' }, { id: 'wait' }] } });
  const dB = appendEvent({ type: 'decision.opened', actor: 'engine', payload: { kind: 'plan', options: [{ id: 'go' }, { id: 'stay' }] } });
  const leansA = [];
  for (let i = 0; i < 4; i++) {
    clock.advance({ minutes: 5 });
    leansA.push(appendEvent({ type: 'decision.lean', actor: i % 2 ? 'jev' : 'engine', payload: { decisionId: dA.id, optionId: i % 2 ? 'wait' : 'step', p: 0.5 + i / 10, fallback: i % 2 ? null : 'code_costs' } }));
    appendEvent({ type: 'decision.lean', actor: 'engine', payload: { decisionId: dB.id, optionId: 'go', p: 0.9 } });
  }
  const hA = leanHistory(dA.id);
  eq('only that decision, in id order', hA.map(x => x.at), leansA.map(e => e.at));
  eq('shape {at, optionId, p, actor, fallback}', hA[0], { at: leansA[0].at, optionId: 'step', p: 0.5, actor: 'engine', fallback: 'code_costs' });
  eq('actor and null fallback kept', [hA[1].actor, hA[1].fallback, hA[1].optionId], ['jev', null, 'wait']);
  eq('limit keeps the newest, oldest first', leanHistory(dA.id, 2).map(x => x.at), leansA.slice(2).map(e => e.at));
  eq('string id accepted', leanHistory(String(dA.id)).length, 4);
  eq('unknown decision → []', leanHistory(987654), []);
  eq('garbage id → []', leanHistory('1 OR 1=1'), []);
  for (let i = 0; i < 55; i++) appendEvent({ type: 'decision.lean', actor: 'engine', payload: { decisionId: dB.id, optionId: 'go', p: 0.9 } });
  eq('capped at 50 points', leanHistory(dB.id, 500).length, 50);
  eq('bad limit → default', leanHistory(dB.id, 'x').length, 50);

  section('lastHeavyAt (raw log)');
  // engineHeavy/ownerHeavy above were stamped at the clock then.
  const before = lastHeavyAt();
  eq('counts heavy.started rows', before, Math.max(engineHeavy.at, ownerHeavy.at));
  clock.advance({ days: 1 });
  const prop = appendEvent({ type: 'heavy.proposed', actor: 'engine', payload: { themeId: 'theme-a', kind: 'minor_accident', onsetAt: clock.now() + 30 * H } });
  eq('a proposal moves it', lastHeavyAt(), prop.at);
  revertEvent(prop.id, { reason: 'test' });
  eq('a reverted proposal still counts', lastHeavyAt(), prop.at);
  appendEvent({ type: 'heavy.proposed', actor: 'engine', at: prop.at - 10 * 86400, payload: { themeId: 'theme-a' } });
  eq('a backdated row never lowers it', lastHeavyAt(), prop.at);
  clock.advance({ days: 1 });
  const named = appendEvent({ type: 'heavy.proposed', actor: 'engine', payload: { themeId: 'theme-b', note: PERSON } });
  redactPerson(PERSON);
  check('the row was redacted', getEvent(named.id).redacted);
  eq('a redacted row still counts', lastHeavyAt(), named.at);

  section('listRewinds');
  eq('none yet', listRewinds(), []);
  const target = lastEventId() - 3;
  const rw = appendEvent({ type: 'world.rewound', actor: 'owner', payload: { toEventId: target, uptoEventId: lastEventId(), reason: 'test' } });
  eq('range = (toEventId, rewindId)', listRewinds(), [{ rewindId: rw.id, from: target + 1, to: rw.id - 1 }]);
  appendEvent({ type: 'world.rewound', actor: 'owner', payload: { toEventId: lastEventId(), reason: 'nothing in between' } });
  appendEvent({ type: 'world.rewound', actor: 'owner', payload: { reason: 'malformed' } });
  eq('empty and malformed ranges left out', listRewinds().length, 1);
  const rw2 = appendEvent({ type: 'world.rewound', actor: 'owner', payload: { toEventId: rw.id - 1, reason: `about ${PERSON}` } });
  redactPerson(PERSON);
  check('a rewind is never redacted (its range would vanish)', !getEvent(rw2.id).redacted);
  eq('nested rewinds listed oldest first', listRewinds().map(r => r.rewindId), [rw.id, rw2.id]);
} catch (err) {
  check('no unexpected throw', false, err?.stack ?? String(err));
}

report();
