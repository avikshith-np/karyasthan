// 2026-11-01 live: the owner set up a café date and, later, a visit at his place
// on the same day, each with its own tone. The visit's commit re-made the day's
// plan (plan.made {amendedFor: the visit}), and the café date was then started
// from that plan's café block. scenes/detect.decisionOf read the plan's
// amendedFor before the block's own decisionId, so the café scene got the
// visit's decision and its tone ("she comes over… changes into his track pants").
// The block that started the activity now decides (eventLog.planBlockDecision);
// amendedFor is only a fallback, at the same place. Also: a visit at his home
// reads "<name> comes over to his place" (option label, the scene's owner
// intent, CHANGES), never "Go to <his flat>".
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR,
} from './_helpers.js';
import { listEvents, getEvent } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import { sessionOf } from '../../src/life/story/scenes/detect.js';
import { homeLabel } from '../../src/life/story/outing.js';
import { dateKey, dayStart, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const sceneJson = () => JSON.stringify({
  narration: 'They talked for a long while about small things and laughed at the same moments. The light went soft and neither of them hurried to leave.',
  impressions: null, topics: ['books'], highlight: 'laughing at the same moments', awkward: null,
  chemistry: 0.5, focus: 'P1', ending: 'nothing', effects: [],
});
const cr = fakeCallRole({
  'life.scene.clerk': () => sceneJson(),
  'life.scene.mind': () => sceneJson(),
});
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => [] });
await simulateHours(54);   // a morning, two days in
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const day0 = dayStart(clock.now(), tz);
const today = dateKey(day0 + 12 * HOUR, tz);
const at = (h, m = 0) => { const [y, mo, d] = today.split('-').map(Number); return zonedToUnix(y, mo, d, h, m, tz); };
async function apply(action, what) {
  const p = await director.preview(action, { relax: true, project: false });
  check(`${what}: previews without refusals`, !p.refusals?.length, JSON.stringify(p.refusals));
  return director.apply(p.previewId, p.fingerprint);
}
const places = [...(S().world?.places ?? world.places ?? [])].filter(p => p && !/home/i.test(p.kind ?? '') && !/home/i.test(p.id));
const cafe = (places.find(p => /cafe|coffee|restaurant|bar|park/i.test(`${p.kind} ${p.id}`)) ?? places.find(p => !/office|work/i.test(`${p.kind} ${p.id}`)))?.id;
const home = S().self?.homePlaceId;
const friend = [...S().cast.values()].find(c => c.relation !== 'flatmate')?.id;
const flatmate = [...S().cast.values()].find(c => c.relation === 'flatmate')?.id;
const friendName = S().cast.get(friend)?.name;
check('the example world has a place out, a home and a friend', !!cafe && !!home && !!friend && !!friendName);

const startOf = (d) => listEvents({ types: ['activity.started'], limit: 3000 })
  .find(e => e.at >= d.subject.eventAt - 5 * 60 && e.at < d.subject.eventAt + 30 * 60 && e.payload?.kind === d.kind && e.payload?.placeId === d.subject.placeId);
const goLabel = (d) => d?.options?.find(o => o.id === 'go')?.label;

section('the visit label');
{
  const s = S();
  eq('a friend at his home', homeLabel(s, home, [friend]), `${friendName} comes over to his place`);
  check('two friends come over', homeLabel(s, home, [...s.cast.values()].filter(c => c.relation !== 'flatmate').slice(0, 2).map(c => c.id))?.endsWith(' come over to his place'));
  if (flatmate) eq('the flatmate lives there: no "comes over" label', homeLabel(s, home, [flatmate, friend]), null);
  eq('not at his home → none', homeLabel(s, cafe, [friend]), null);
  eq('nobody named → none', homeLabel(s, home, []), null);
}

section('the live day: a café date, then a visit set up after it, each with a tone');
const cafeApply = await apply({ kind: 'scene', shape: 'outing', placeId: cafe, startAt: at(15, 0), minutes: 120, castIds: [friend], label: 'Café date' }, 'café');
const cafeD = S().decisions.get(getEvent(cafeApply.eventIds.find(id => getEvent(id)?.type === 'decision.opened'))?.id);
await apply({ kind: 'scene.tone', decisionId: cafeD.id, tone: 'they talk about books over cold coffee', outcome: 'well' }, 'café tone');
await simulateHours(1);
const visitApply = await apply({ kind: 'scene', shape: 'visit', placeId: home, startAt: at(17, 30), minutes: 90, castIds: [friend] }, 'visit');
const visitD = S().decisions.get(getEvent(visitApply.eventIds.find(id => getEvent(id)?.type === 'decision.opened'))?.id);
await apply({ kind: 'scene.tone', decisionId: visitD.id, tone: 'she changes into his track pants', outcome: 'well' }, 'visit tone');
eq('the visit reads "<name> comes over to his place"', goLabel(visitD), `${friendName} comes over to his place`);
eq('the café keeps the owner\'s label', goLabel(cafeD), 'Café date');
{
  const text = story.changeDescription(visitApply.actionEventId) ?? '';
  check('CHANGES: the visit in words, without "Go to" or a repeated "at … with …"',
    text.includes(`${friendName} comes over to his place`) && !/Go to/.test(text) && !text.includes(`with ${friendName}`), text);
}
{
  // Life · Day before the café: the planned café span's ❖ TONE link is the café's decision.
  const dv = await life.dayView({ date: today });
  const span = (dv?.future?.spans ?? []).find(x => x.cat === 'activity' && x.with?.length && Math.abs(x.at - cafeD.subject.eventAt) <= 1800);
  if (span) eq('Day: the planned café span carries the café decision', span.decisionId, cafeD.id);
}

await simulateHours(Math.ceil((at(20, 0) - clock.now()) / HOUR));
await story.idle(); await story.runScenesNow(); await story.idle();
const cafeStart = startOf(cafeD);
const visitStart = startOf(visitD);
check('he went to both', !!cafeStart && !!visitStart, JSON.stringify({ cafe: cafeStart?.id, visit: visitStart?.id }));
const cafePlan = cafeStart ? getEvent(cafeStart.causeId) : null;
check('precondition (the live shape): the café was started from a plan re-made for the visit',
  cafePlan?.type === 'plan.made' && cafePlan.payload?.amendedFor === visitD.id, JSON.stringify({ plan: cafePlan?.id, amendedFor: cafePlan?.payload?.amendedFor }));

section('each scene takes its own decision');
{
  const end = listEvents({ types: ['activity.ended'], limit: 5000 }).find(e => e.causeId === cafeStart.id);
  eq('detect: the café session is the café decision', sessionOf(cafeStart, end, S(), { causeEv: cafePlan })?.decisionId, cafeD.id);
  const cafeRow = sceneStore.versionsOf(cafeStart.id)[0];
  const visitRow = sceneStore.versionsOf(visitStart.id)[0];
  eq('the café scene was written with the café tone', [cafeRow?.status, cafeRow?.tone], ['done', 'they talk about books over cold coffee']);
  eq('the café sheet carries the café label', cafeRow?.sheet?.ownerIntent, 'Café date');
  const calls = cr.callsFor('life.scene.mind').concat(cr.callsFor('life.scene.clerk'));
  const cafeCall = calls.find(c => c.user.includes('Café date'));
  check('the café call has its own tone, not the visit\'s', !!cafeCall && cafeCall.user.includes('cold coffee') && !cafeCall.user.includes('track pants'));
  eq('the visit scene was written with the visit tone', [visitRow?.status, visitRow?.tone], ['done', 'she changes into his track pants']);
  eq('the visit sheet says she comes over', visitRow?.sheet?.ownerIntent, `${friendName} comes over to his place`);
}

report();
