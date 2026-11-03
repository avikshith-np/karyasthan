// Bug A (wake-fix): REVERT THIS CHANGE of a change that cancelled an owner
// outing restores the decision, and the running engine must re-arm it: he
// leaves for it at its time — in the same process (no fresh boot). Before the
// fix CANCEL TONIGHT's change could not be reverted at all (its revert of the
// fitted plan is final: refused `not_revertible`), and with that part riding
// along the fitted plan's `amended:<id>` signature stayed "happened and undone",
// so the pulse never fitted / amended the restored outing again (could_not_go).
// Outcome-cancelled and schedule-cancel changes are covered too.
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents, getEvent } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import { dateKey, dayStart, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';
import { isLockedOuting, outingInPlan } from '../../src/life/pulse.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(30);              // Wed, mid-morning: an office day
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const hoursUntil = (t) => Math.max(0, Math.ceil((t - clock.now()) / HOUR));
async function apply(action) {
  const p = await director.preview(action, { relax: true, project: false });
  const r = await director.apply(p.previewId, p.fingerprint);
  return { p, r };
}
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
const wentTo = (place, from) => listEvents({ types: ['travel.started'], limit: 3000 }).filter(e => e.payload?.to === place && e.at >= from);
function revertChange(actionEventId) {
  const p = life.revertChangePreview(actionEventId);
  return { p, res: p.refusals.length || !p.targets.length ? null : life.revertChange(actionEventId, { fingerprint: p.fingerprint }) };
}

async function scenario(label, place, h, cancel) {
  const day0 = dayStart(clock.now(), tz);
  await apply({ kind: 'scene', shape: 'outing', placeId: place, startAt: at(day0, h, 0), minutes: 90, castIds: [], label });
  await simulateHours(1);
  const d = decisionOf(label);
  check(`${label}: the owner outing is locked and fitted`, isLockedOuting(d) && outingInPlan(S().plan, d), JSON.stringify(d?.committed));
  const { r } = await cancel(d);
  await simulateHours(1);
  check(`${label}: cancelled — no longer committed / in the plan`, S().decisions.get(d.id)?.status !== 'committed' || !outingInPlan(S().plan, d),
    JSON.stringify(S().decisions.get(d.id)?.status));
  const { p, res } = revertChange(r.actionEventId);
  check(`${label}: REVERT THIS CHANGE runs`, !!res, JSON.stringify(p));
  check(`${label}: no amended:<id> signature blocks the restored outing`,
    !(S().excludedSigs ?? []).some(x => x.type === 'plan.made' && x.key === `amended:${d.id}`), JSON.stringify(S().excludedSigs));
  eq(`${label}: the decision is committed again`, S().decisions.get(d.id)?.status, 'committed');
  await simulateHours(hoursUntil(at(day0, h + 2, 30)));
  const trips = wentTo(place, at(day0, 12, 0));
  check(`${label}: he leaves for it (same process, across its point of no return)`, trips.length > 0,
    JSON.stringify({ blocks: S().plan.blocks.map(b => [b.kind, b.placeId ?? b.to, b.decisionId ?? null]), sigs: S().excludedSigs }));
  eq(`${label}: no could_not_go`, listEvents({ types: ['decision.expired'], limit: 500 })
    .filter(e => e.payload?.decisionId === d.id && !S().excluded?.has?.(e.id)).map(e => e.payload.reason), []);
  await simulateHours(24 - ((clock.now() - day0) / HOUR) + 9);   // next morning
}

section('outcome cancelled (now) → REVERT THIS CHANGE → he still goes');
await scenario('rearm dinner two', 'place:restaurant', 19, async (d) => {
  await simulateHours(hoursUntil(d.subject.eventAt - 1 * HOUR));
  return apply({ kind: 'outcome', decisionId: d.id, outcome: 'cancelled' });
});

section('schedule edit that cancels it → REVERT THIS CHANGE → he still goes');
await scenario('rearm dinner four', 'place:restaurant', 19, (d) => apply({ kind: 'schedule', day: 0,
  ranges: [{ activity: 'home', from: '18:00', to: '22:00', label: 'quiet night in' }], resolutions: { [`decision:${d.id}`]: 'cancel' } }));

section('CANCEL TONIGHT → REVERT THIS CHANGE → he still goes');
await scenario('rearm dinner one', 'place:restaurant', 19, () => apply({ kind: 'quick', button: 'cancel_tonight' }));

await stopLife();
report();
