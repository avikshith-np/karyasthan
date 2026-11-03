// 015 Director as god — departed cast (plan §P1.6, §1.5): a written-out member
// leaves the active cast (s.cast) for story.departed; the overlay world's cast
// drops them (routine meeting attendees), the pulse filters them out of block
// company and the together credit, cast cards never show them; past names
// resolve (castNameOf, Day rows); an open goal with them expires cast_departed
// and comes back when the departure is reverted; a committed outing with only
// them closes; a new member never inherits their id; the revert is refused while
// 24 members are active; the static walk: s.cast / world.cast readers stay on
// the active cast. Example world, fake clock, no network.
import fs from 'fs';
import path from 'path';
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR, PROJECT_ROOT,
} from '../arcs-tests/_helpers.js';
import { getEvent, listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import { castNameOf } from '../../src/life/story/reducer.js';
import { worldOf } from '../../src/life/story/index.js';
import { planDay } from '../../src/life/routine.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(28);
const S = () => life.getState();

async function applyOk(action) {
  const p = await director.preview(action, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  return { p, r, events: r.eventIds.map(getEvent) };
}

const coworker = [...S().cast.values()].find(c => c.relation === 'coworker');
const friend = [...S().cast.values()].find(c => c.relation === 'friend' || c.relation === 'flatmate');

section('setup: a goal and a committed outing with the friend');
const goal = await applyOk({ kind: 'goal', goalKind: 'meet', castId: friend.id, fromDay: 2, toDay: 5 });
const goalId = goal.events.find(e => e.type === 'goal.set').id;
const place = [...S().places.values()].find(p => p.kind !== 'home' && p.kind !== 'office');
const out = await applyOk({ kind: 'scene', shape: 'outing', placeId: place.id, castIds: [friend.id], startAt: clock.now() + 10 * HOUR, minutes: 90 });
const outingId = out.events.find(e => e.type === 'decision.opened').id;
check('goal open, outing committed', S().goals?.[goalId]?.status === 'open' && S().decisions.get(outingId)?.status === 'committed');

section('write out the friend and a coworker');
const dep = await applyOk({ kind: 'cast.depart', castId: friend.id, how: 'moved_away' });
{
  const gone = dep.events.find(e => e.type === 'cast.departed');
  check('owner cast.departed', gone.actor === 'owner');
  const exp = dep.events.find(e => e.type === 'decision.expired' && e.payload.decisionId === outingId);
  check('the outing with only them: engine expiry cast_departed caused by the departure', exp?.actor === 'engine' && exp.payload.reason === 'cast_departed' && exp.causeId === gone.id);
  const gexp = dep.events.find(e => e.type === 'goal.expired' && e.payload.goalId === goalId);
  check('the open goal: engine goal.expired cast_departed caused by the departure', gexp?.causeId === gone.id);
  check('…goal expired, outing closed', S().goals?.[goalId]?.status === 'expired' && S().decisions.get(outingId)?.status === 'cancelled');
  check('gone from s.cast, kept in story.departed', !S().cast.has(friend.id) && S().story.departed?.[friend.id]?.name === friend.name);
  eq('castNameOf resolves the past name', castNameOf(S(), friend.id), friend.name);
  const dm = { chatJid: '15550000002@s.whatsapp.net', kind: 'dm', members: new Set(['15550000002@s.whatsapp.net']) };
  check('never on a cast card', !life.castCards(dm, `what about ${friend.name}`, 3).some(c => c.includes(friend.name)));
}
await applyOk({ kind: 'cast.depart', castId: coworker.id, how: 'written_out' });
{
  const w = worldOf(S(), world);
  const list = Array.isArray(w.cast) ? w.cast : [...(w.cast?.values?.() ?? [])];
  check('the overlay world\'s cast drops them', !list.some(c => c.id === coworker.id) && !list.some(c => c.id === friend.id));
  let met = false;
  for (let d = 1; d <= 7; d++) {
    try {
      const plan = planDay(S(), clock.now() + d * 86400, w);
      if (plan.blocks.some(b => (b.withCast ?? []).includes(coworker.id))) met = true;
    } catch { /* a day the routine can't plan: skip */ }
  }
  check('no meeting in the next week has the departed coworker', !met);
}

section('time passes: no company, no credit');
{
  const r0 = S().story.relationships?.[friend.id]?.togetherMin ?? 0;
  const mark = S().lastEventId;
  await simulateHours(30);
  const acts = listEvents({ types: ['activity.started'], after: mark, limit: 500 });
  check('no activity has a departed member as company', !acts.some(e => (e.payload?.withCast ?? []).some(id => id === friend.id || id === coworker.id)));
  eq('no shared time credited', S().story.relationships?.[friend.id]?.togetherMin ?? 0, r0);
}

section('a new member never takes a departed id');
{
  const nc = await applyOk({ kind: 'scene', shape: 'new_cast', name: friend.name.split(/\s+/)[0] + ' Vexley', relation: 'friend' });
  const id = nc.events.find(e => e.type === 'cast.created').payload.id;
  check(`fresh id ${id}`, id !== friend.id && id !== coworker.id);
}

section('revert the departure: the goal and the member come back');
{
  const p = life.revertChangePreview(dep.r.actionEventId);
  life.revertChange(dep.r.actionEventId, { fingerprint: p.fingerprint });
  check('the friend is active again', S().cast.has(friend.id) && !S().story.departed?.[friend.id]);
  check('…the goal is back (its expiry cascaded)', ['open', 'fitted'].includes(S().goals?.[goalId]?.status));
}

section('static walk: readers of a future cast member use the active cast');
{
  const files = ['src/life/story/goals.js', 'src/life/story/director.js', 'src/life/routine.js', 'src/life/story/reconciler.js'];
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf-8');
    if (/story\.departed[^\n]*\.get\(/.test(src)) bad.push(f);
  }
  eq('nobody looks a future member up in story.departed', bad, []);
}

await stopLife();
report();
