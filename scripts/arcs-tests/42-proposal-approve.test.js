// Weekly proposals → PREVIEW APPROVE → APPLY on the live wiring (audit 2026-10-30):
// the story facade configures director.proposalDescriptors from weekly.js, so a
// pending beat / new cast / new place / arc opener in a guided category plans as
// 'mind' events under the owner's director.action, re-checked against the world
// as it is NOW (cast gone, id taken, caps, region, pins). A heavy nomination has
// no event form: it is refused and stays rejectable. Example world, fake clock,
// stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours } from './_helpers.js';
import { getEvent, listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as store from '../../src/life/story/store.js';

await setupScratchDb();
const { clock, life } = await bootLife();
await simulateHours(30);
const S = () => life.getState();

const propose = (kind, payload, category = 'cast') => store.createProposal({ runId: 1, weekKey: '2026-W44', category, kind, payload, createdAt: clock.now() });
async function code(p) {
  try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
async function approve(pid) {
  const p = await director.preview({ kind: 'proposal.approve', proposalId: pid });
  const parts = p.events.filter(e => e.type !== 'director.action');
  if (!parts.length) return { p, parts, r: null, events: [] };
  const r = await director.apply(p.previewId, p.fingerprint);
  return { p, parts, r, events: r.eventIds.map(getEvent) };
}
const ownerApply = async (action) => {
  const p = await director.preview(action);
  return director.apply(p.previewId, p.fingerprint);
};

section('wiring: a pending proposal previews (no longer refused unsupported)');
{
  const pid = propose('beat', { castId: 'cast:flatmate', kind: 'hobby', text: 'started learning the guitar' });
  eq('preview is not refused', await code(director.preview({ kind: 'proposal.approve', proposalId: pid })), null);
  const a = await approve(pid);
  eq('one cast.beat, a mind event', a.parts.map(e => `${e.type}/${e.actor}`), ['cast.beat/mind']);
  eq('…caused by the owner action', a.events.find(e => e.type === 'cast.beat')?.causeId, a.r?.actionEventId);
  eq('the proposal is applied', store.getProposal(pid).status, 'applied');
  eq('applying twice → conflict', await code(director.preview({ kind: 'proposal.approve', proposalId: pid })), 'conflict:proposal_state');
}

section('beat: a status beat also updates the status; pins and gone members refuse');
{
  const pid = propose('beat', { castId: 'cast:coworker-a', kind: 'status', text: 'busy with a big move' });
  const a = await approve(pid);
  eq('cast.beat → cast.updated', a.parts.map(e => e.type), ['cast.beat', 'cast.updated']);
  eq('the status took', S().cast.get('cast:coworker-a')?.status, 'busy with a big move');
  await ownerApply({ kind: 'pin', pinKey: 'cast:coworker-b' });
  const pinned = await director.preview({ kind: 'proposal.approve', proposalId: propose('beat', { castId: 'cast:coworker-b', kind: 'hobby', text: 'took up chess' }) });
  check('a pinned member → refused pinned, nothing planned', pinned.refusals.some(r => r.reason === 'pinned')
    && !pinned.events.some(e => e.type === 'cast.beat'), JSON.stringify(pinned.refusals));
  await ownerApply({ kind: 'unpin', pinKey: 'cast:coworker-b' });
  const gone = await director.preview({ kind: 'proposal.approve', proposalId: propose('beat', { castId: 'cast:nobody', kind: 'hobby', text: 'took up chess' }) });
  check('an unknown member → refused not_found', gone.refusals.some(r => r.reason === 'not_found') && gone.events.length === 0);
}

section('new cast: created at a fresh id with the first closeness step');
{
  // The stored id is taken by now (the world moved on): a fresh one is built.
  const pid = propose('new_cast', { id: 'cast:flatmate', name: 'Quill Varden', relation: 'friend', birthday: '1994-05-02',
    metrics: { closeness: 0.1, trust: 0.4, tension: 0 } });
  const a = await approve(pid);
  eq('cast.created → relationship.changed', a.parts.map(e => e.type), ['cast.created', 'relationship.changed']);
  const id = a.events.find(e => e.type === 'cast.created')?.payload?.id;
  check('a new id (not the taken one)', typeof id === 'string' && id !== 'cast:flatmate' && /^cast:quill-varden/.test(id), id);
  check('…in his life now, closeness 0.3', S().cast.has(id) && Math.abs(S().cast.get(id).metrics.closeness - 0.3) < 1e-9);
  const twin = await director.preview({ kind: 'proposal.approve', proposalId: propose('new_cast', { id: 'cast:quill', name: 'Quill Varden', relation: 'friend' }) });
  check('the same name again → refused name_collision', twin.refusals.some(r => r.reason === 'name_collision') && !twin.events.some(e => e.type === 'cast.created'));
}

section('new place: inside the region box, else refused');
{
  const pid = propose('new_place', { id: 'place:cafe', name: 'Corner Bakery', kind: 'cafe', lat: 0.02, lon: 0.02 }, 'social');
  const a = await approve(pid);
  const created = a.events.find(e => e.type === 'place.created');
  check('place.created at a fresh id', created && created.payload.id !== 'place:cafe' && S().places.has(created.payload.id), created?.payload?.id);
  const far = await director.preview({ kind: 'proposal.approve', proposalId: propose('new_place', { id: 'place:far', name: 'Far Diner', kind: 'restaurant', lat: 5, lon: 5 }, 'social') });
  check('outside the region → refused region', far.refusals.some(r => r.reason === 'region') && !far.events.some(e => e.type === 'place.created'));
}

let arcDecisionId = null;
section('arc opener: opens the code-built decision (guided → an Ask-me card)');
{
  await ownerApply({ kind: 'fate', category: 'social', mode: 'frozen' });
  const frozen = await director.preview({ kind: 'proposal.approve', proposalId: propose('arc_decision', { kind: 'social_plan', castId: null, note: '' }, 'social') });
  check('a frozen category → refused frozen', frozen.refusals.some(r => r.reason === 'frozen') && !frozen.events.some(e => e.type === 'decision.opened'), JSON.stringify(frozen.refusals));
  await ownerApply({ kind: 'fate', category: 'social', mode: 'natural' });
  await ownerApply({ kind: 'fate', category: 'social', mode: 'guided' });
  const pid = propose('arc_decision', { kind: 'cast_meetup', castId: 'cast:flatmate', note: 'they could catch up' }, 'social');
  const a = await approve(pid);
  const opened = a.events.find(e => e.type === 'decision.opened');
  check('one decision.opened, a mind event', !!opened && opened.actor === 'mind', JSON.stringify(a.parts.map(e => e.type)));
  const d = opened ? S().decisions.get(opened.id) : null;
  eq('open, social, ask mode', [d?.status, d?.category, d?.mode, d?.kind], ['open', 'social', 'ask', 'social:meetup']);
  check('…in the future, with go / late / stay', d && d.subject.eventAt > clock.now() && d.options.map(o => o.id).join() === 'go,late,stay');
  check('the model\'s note is nowhere in the events', !JSON.stringify(a.events).includes('catch up'));
  eq('proposal applied', store.getProposal(pid).status, 'applied');
  arcDecisionId = opened?.id ?? null;
}

section('heavy nomination: no event form — refused, still rejectable');
{
  const pid = propose('heavy_nomination', { themeId: 'theme:x' }, 'heavy');
  const p = await director.preview({ kind: 'proposal.approve', proposalId: pid });
  check('refused unsupported, no events', p.refusals.some(r => r.reason === 'unsupported') && p.events.length === 0, JSON.stringify(p));
  eq('…the row stays pending', store.getProposal(pid).status, 'pending');
}

section('the pulse takes it from there (no lean at opening; it leans and commits by its deadline)');
{
  await simulateHours(24 * 10);
  const of = (type) => (arcDecisionId ? listEvents({ types: [type], limit: 2000 }).filter(e => e.payload?.decisionId === arcDecisionId) : []);
  check('the approved decision was leaned on', of('decision.lean').length >= 1);
  check('…and committed by its deadline', of('decision.committed').length === 1, JSON.stringify(of('decision.expired').map(e => e.payload)));
}

await stopLife();
report();
