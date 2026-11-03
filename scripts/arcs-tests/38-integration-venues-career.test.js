// Integration review fixes (014 + 015), venues and career, through the real
// facades (no stubbed venue-name source: the facade's own log reader is the one
// under test).
//   §A7 source  life.venueNamesEver() reads the log (the first page has no
//               `after`: listEvents refuses after:0) → owner text naming a venue
//               with a negative cue is refused, the mouth's tone line names it
//   career      his office is never a real venue (by id, or a new place named
//               like one); a prompt draft's venue office id is left out
//   outcome     "badly" at a venue: the venue is worded by its kind at the
//               outcome's time (negativeAt maps outcome.happened to its place);
//               venue_negative carries its text
//   drift key   an immediate career change's re-plan stores the real ids in
//               plan.made.payload.driftKey, never the preview's placeholders
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as places from '../../src/life/places.js';
import { validatePromptOutput } from '../../src/life/story/schema.js';
import * as promptMod from '../../src/life/story/prompt.js';
import { dateKey, dayStart, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(30);              // Wed, mid-morning
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (h, m = 0) => {
  const [y, mo, d] = dateKey(dayStart(clock.now(), tz) + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
async function refusal(action) {
  try { await director.preview(action, { relax: true }); return 'accepted'; } catch (e) { return `${e.code}:${e.reason}`; }
}

const VENUE = 'place:v1a2b3c4d';
const NAME = 'Blue Lagoon Cafe';
section('§A7: the facade reads every venue name from the log (no stub)');
{
  const P0 = [...S().places.values()].find(p => p.kind !== 'home');
  life.appendOwnerBatch([{ type: 'place.created', actor: 'owner', at: clock.now(), payload: {
    id: VENUE, name: NAME, kind: 'cafe', lat: P0.lat + 0.004, lon: P0.lon + 0.004, venue: { src: 'osm', ref: 'node/1', area: 'Old Town' } } }]);
  await simulateHours(0.25);
  check('life.venueNamesEver() lists it', life.venueNamesEver().includes(NAME), JSON.stringify(life.venueNamesEver()));
  check('places.venueNamesNow() (the installed source) too', places.venueNamesNow().some(e => e.name === NAME));
  eq('owner text pairing it with a negative cue is refused', await refusal({ kind: 'money', mode: 'expense', amount: 300, label: `food poisoning at ${NAME}` }), 'invalid:negative_at_venue');
  check('the mouth\'s tone line names it', places.venueToneNote(`lunch at ${NAME}`).includes(NAME));
  check('a stored label in a negative context loses it', !places.negativeLabel(`Go to ${NAME}`, true).includes(NAME));
  eq('life.venueKindWords → the kind word', typeof life.venueKindWords === 'function' ? life.venueKindWords(`Dinner at ${NAME} was bad.`) : null, 'Dinner at a cafe was bad.');
}

section('career: never a real business as his office');
{
  eq('a new job at a venue (officePlaceId) → real_business', await refusal({ kind: 'career', change: 'job', title: 'Analyst', officePlaceId: VENUE }), 'invalid:real_business');
  const P0 = [...S().places.values()].find(p => p.kind === 'park') ?? [...S().places.values()].find(p => p.kind !== 'home');
  eq('a new office place named like a venue → real_business',
    await refusal({ kind: 'career', change: 'job', title: 'Analyst', newPlace: { name: NAME, near: P0.id, offsetKm: 1 } }), 'invalid:real_business');
  eq('an employer named like a venue → real_business', await refusal({ kind: 'career', change: 'job', title: 'Analyst', employerName: `${NAME} Ltd` }), 'invalid:real_business');
  const generic = [...S().places.values()].find(p => p.kind === 'office')?.id;
  eq('a generic office is fine', await refusal({ kind: 'career', change: 'job', title: 'Analyst', officePlaceId: generic }), 'accepted');
  // The prompt's validator: a venue id from the catalogue is left out of a career draft.
  const { check: cat } = promptMod.buildCatalogue(S(), world, clock.now(), tz);
  check('the catalogue marks the venue as one', cat.venuePlaceIds?.has(VENUE) && !cat.venuePlaceIds.has(generic));
  const v = validatePromptOutput(JSON.stringify({ actions: [{ action: { kind: 'career', change: 'job', title: 'Analyst', officePlaceId: VENUE }, why: 'x' }], cantDo: [] }), cat, promptMod.VOCAB);
  const a = (v.drafts ?? v.actions ?? [])[0]?.action ?? null;
  check('a model draft with a venue office keeps no officePlaceId', a && a.officePlaceId === undefined, JSON.stringify(v).slice(0, 300));
}

section('outcome "badly" at a venue: worded by its kind at the outcome time');
{
  const p = await director.preview({ kind: 'scene', shape: 'outing', placeId: VENUE, startAt: at(19, 0), minutes: 60, castIds: [], label: 'coffee' }, { relax: true });
  await director.apply(p.previewId, p.fingerprint);
  const d = [...S().decisions.values()].find(x => x.subject?.placeId === VENUE);
  check('the venue outing is committed', d?.status === 'committed');
  const po = await director.preview({ kind: 'outcome', decisionId: d.id, outcome: 'badly' }, { relax: true });
  const w = (po.continuity?.warnings ?? []).find(x => x.code === 'venue_negative');
  check('venue_negative carries a real text (not the bare code)', w && w.text !== 'venue negative', JSON.stringify(w));
  await director.apply(po.previewId, po.fingerprint);
  await simulateHours(Math.ceil((at(21, 0) - clock.now()) / HOUR));
  const ev = listEvents({ types: ['outcome.happened'], limit: 50 }).find(e => e.payload?.decisionId === d.id);
  check('the outcome happened', !!ev);
  eq('life.placeLabel at the outcome time → the kind word', ev ? life.placeLabel(VENUE, { at: ev.at }) : null, 'a cafe');
  eq('…and the venue keeps its name a day later', life.placeLabel(VENUE, { at: ev.at + 30 * HOUR }), NAME);
}

section('drift key: an immediate career change stores real ids');
{
  const p = await director.preview({ kind: 'career', change: 'fire' }, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  const plans = listEvents({ types: ['plan.made'], limit: 200 }).filter(e => r.eventIds.includes(e.id));
  const set = listEvents({ types: ['career.set'], limit: 50 }).find(e => r.eventIds.includes(e.id));
  check('the fire re-planned today', plans.length > 0);
  for (const e of plans) {
    const dk = e.payload?.driftKey;
    check(`plan #${e.id}: no placeholder id in its drift key`, dk === undefined || !/\d{13,}/.test(dk), dk);
    if (dk !== undefined) eq(`plan #${e.id}: the drift key names the career.set`, dk.split('|')[0], String(set?.id));
  }
  eq('the folded plan has the same key', S().plan?.driftKey, `${set?.id}|`);
}

await stopLife();
report();
