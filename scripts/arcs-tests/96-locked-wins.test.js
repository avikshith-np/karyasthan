// 2026-11-01 live: his routine "brewpub with a friend" (16:00–18:00, committed by his own lean) reached
// its point of no return at 15:39 and pulled him out of the owner's café date with a member (15:00–17:00,
// a locked outing). A plan that isn't locked never takes him out of, or across, a locked outing's
// blocks: amendPlanForOuting refuses (the pulse expires it could_not_go). And an owner-started
// romance isn't ended for low passion on its first days (it fizzled 4 h in).

import fs from 'node:fs';
import { section, check, report } from './_helpers.js';
import { lockedOverlap, isLockedOuting } from '../../src/life/pulse.js';

const H = 3600;
const T = 1793520000;
const cafe = { id: 884, status: 'committed', committed: { optionId: 'go', by: 'owner' }, subject: { eventAt: T + H } };
const brew = { id: 245, status: 'committed', committed: { optionId: 'go', by: 'sample' }, subject: { eventAt: T + 2 * H } };
const plan = { blocks: [
  { kind: 'commute', start: T + 0.8 * H, end: T + H, decisionId: 884 },
  { kind: 'hangout', start: T + H, end: T + 3 * H, decisionId: 884 },
  { kind: 'free', start: T + 3 * H, end: T + 5 * H },
] };
const state = { decisions: new Map([[884, cafe], [245, brew]]) };

section('a locked outing in the window blocks another plan');
{
  check('the owner\'s café is locked, the routine brewpub is not', isLockedOuting(cafe) && !isLockedOuting(brew));
  check('the brewpub window (16:00–18:00 over the café 15:00–17:00) overlaps a locked block', lockedOverlap(state, plan, T + 2 * H - 1260, T + 4 * H) === true);
  check('after the café is over, nothing locked is in the way', lockedOverlap(state, plan, T + 3 * H, T + 5 * H) === false);
  check('no locked decision at all → false', lockedOverlap({ decisions: new Map([[245, brew]]) }, plan, T, T + 5 * H) === false);
  const src = fs.readFileSync(new URL('../../src/life/pulse.js', import.meta.url), 'utf8');
  check('amendPlanForOuting refuses a non-locked outing across a locked one (→ could_not_go at its point of no return)',
    /if \(!isLockedOuting\(d\) && lockedOverlap\(state, plan, at, endAt\)\) return null;/.test(src));
}

section('a new romance is not ended for low passion on its first days');
{
  const src = fs.readFileSync(new URL('../../src/life/story/romance.js', import.meta.url), 'utf8');
  check('FIZZLE_GRACE_DAYS guards the passion fizzle', /export const FIZZLE_GRACE_DAYS = 5;/.test(src) && /m\.passion < FIZZLE_PASSION && !young/.test(src));
}

report();
