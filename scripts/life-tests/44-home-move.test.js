// 015 Director as god — home (plan §P1.4): a move to an owner-created home
// (place:home-<n>, kind home, rounded to 0.01°, never an address) changes
// s.self.homePlaceId and keeps the old one in homeHistory; the next morning's
// plan is made at the new home (014 A0 seam: worldWithPlaces resolves the
// event-created place); a later move waits pending and applies at its time; the
// self.home pin warns for a hand-built move and refuses a draft; every home-kind
// place and former home is private. Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours,
} from '../arcs-tests/_helpers.js';
import { getEvent, listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import { isPrivatePlace } from '../../src/life/places.js';
import { worldOf } from '../../src/life/story/index.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(28);
const S = () => life.getState();

async function applyOk(action, opts = { relax: true }) {
  const p = await director.preview(action, opts);
  const r = await director.apply(p.previewId, p.fingerprint);
  return { p, events: r.eventIds.map(getEvent) };
}

section('a move now');
{
  const oldHome = S().self.homePlaceId;
  const near = [...S().places.values()].find(p => p.kind !== 'home' && p.id !== oldHome);
  const { p, events } = await applyOk({ kind: 'home', near: near.id, flatmate: 'stays' });
  const created = events.find(e => e.type === 'place.created');
  const moved = events.find(e => e.type === 'self.moved');
  check('a new home place, kind home, id place:home-<n>', /^place:home-\d+$/.test(created.payload.id) && created.payload.kind === 'home');
  check('…neighbourhood-level coordinates (2 decimals)', Math.round(created.payload.lat * 100) / 100 === created.payload.lat
    && Math.round(created.payload.lon * 100) / 100 === created.payload.lon);
  check('owner self.moved, from the old home', moved.actor === 'owner' && moved.payload.fromPlaceId === oldHome);
  eq('homePlaceId is the new home', S().self.homePlaceId, created.payload.id);
  check('the old home is in homeHistory', (S().self.homeHistory ?? []).includes(oldHome));
  check('both are private', isPrivatePlace(S(), created.payload.id) && isPrivatePlace(S(), oldHome));
  check('the overlay world resolves the new home', worldOf(S(), world).self.homePlaceId === created.payload.id
    && (worldOf(S(), world).places ?? []).some(x => x.id === created.payload.id));
  check('the preview says it is a god change', p.warnings.some(w => /rewrites his future/.test(w)));
  const id = created.payload.id;
  await simulateHours(24);
  const plan = listEvents({ types: ['plan.made'], after: moved.id, limit: 200 }).filter(e => e.actor === 'engine').pop();
  check('the next plan has blocks at the new home', (plan?.payload?.blocks ?? []).some(b => b.placeId === id));
  check('…and none at the old one', !(plan?.payload?.blocks ?? []).some(b => b.placeId === oldHome));
  let msg = null;
  try { life.revertEvent(moved.id, { reason: 'test' }); } catch (e) { msg = e.message; }
  check('an applied move cannot be reverted (he lived there since)', /cannot be reverted/.test(msg ?? ''), msg);
}

section('a later move waits pending, then applies');
{
  const before = S().self.homePlaceId;
  const near = [...S().places.values()].find(p => p.kind !== 'home');
  const { events } = await applyOk({ kind: 'home', near: near.id, when: { inMinutes: 180 } });
  const moved = events.find(e => e.type === 'self.moved');
  check('pending (effectiveAt later)', !!S().story.pending?.[moved.id] && S().self.homePlaceId === before);
  await simulateHours(4);
  const applied = listEvents({ types: ['change.applied'], after: moved.id, limit: 50 }).find(e => e.causeId === moved.id);
  check('change.applied caused by the move', !!applied && applied.actor === 'engine');
  eq('he lives at the new place', S().self.homePlaceId, moved.payload.homePlaceId);
}

section('the self.home pin');
{
  await applyOk({ kind: 'pin', pinKey: 'self.home' });
  const near = [...S().places.values()].find(p => p.kind !== 'home');
  const hand = await director.preview({ kind: 'home', near: near.id }, { relax: true });
  check('hand-built: plans with overrides_pin', hand.refusals.length === 0 && (hand.continuity?.warnings ?? []).some(w => w.code === 'overrides_pin'));
  const draft = director.plan({ kind: 'home', near: near.id }, S(), { now: clock.now() });
  check('a draft is refused pinned', draft.refusals.some(r => r.reason === 'pinned'));
}

await stopLife();
report();
