// Integration review fixes (015): writing someone out, and continuity texts.
//   cast.depart  a plan of today with only them is called off AND today is
//                re-planned (the evening refilled, WHAT CHANGES AHEAD shows it);
//                a plan that already happened is never cancelled after the fact;
//                a chat-made plan is kept, its warning `chat_plan_kept` is
//                fromChat and never reaches the story read's change fence
//   threads      a schedule edit over a committed plan counts it once
//   texts        every planner code has a text; the checker's specific text wins
//   suggestions  fired → a mood for the next morning; money below zero → an
//                income that keeps it above zero over his normal spending
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as storyRead from '../../src/life/story/storyRead.js';
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
const friend = () => [...S().cast.values()].find(c => c.relation !== 'flatmate' && !/^family/.test(c.relation ?? '') && !/manager|coworker/.test(c.relation ?? ''))
  ?? [...S().cast.values()].find(c => c.relation !== 'flatmate');
async function scene(label, startAt, castIds, placeId = 'place:restaurant', minutes = 120) {
  const p = await director.preview({ kind: 'scene', shape: 'outing', placeId, startAt, minutes, castIds, label }, { relax: true });
  await director.apply(p.previewId, p.fingerprint);
  return [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
}

// Decision 35: a real person's plan isn't the departed member's to take with them. A chat-made plan with
// only cast members now closes with them like any other (020 took its wall away): tested below it.
section('a real person\'s plan with them is kept, and the story read never hears of it');
{
  const s0 = S();
  const c = friend();
  const now = clock.now();
  const decisions = new Map(s0.decisions);
  decisions.set(990001, {
    id: 990001, status: 'committed', kind: 'hangout', category: 'social', adopted: true, claimId: 77, subjectJid: '15550002222@s.whatsapp.net',
    subject: { castIds: [c.id], placeId: 'place:cafe', eventAt: now + 6 * HOUR, endAt: now + 7.5 * HOUR },
    options: [{ id: 'go', label: 'Go' }, { id: 'stay', label: 'Stay in' }], committed: { optionId: 'go', by: 'adopted', at: now - 600 },
  });
  const state = { ...s0, decisions };
  const planned = await director.plan({ kind: 'cast.depart', castId: c.id, how: 'moved_away' }, state, { relax: true });
  const w = (planned.continuity?.warnings ?? []).find(x => x.code === 'chat_plan_kept');
  check('chat_plan_kept is marked fromChat', w?.fromChat === true, JSON.stringify(planned.continuity?.warnings));
  check('the owner line says the plan is kept', planned.warnings.includes(director.CHAT_PLAN_KEPT) && !planned.warnings.includes(director.CHAT_PLAN));
  check('no expiry of the chat plan', !planned.events.some(e => e.type === 'decision.expired' && e.payload?.decisionId === 990001));
  const block = storyRead.changeBlock(planned, null, { state, now, tz: 'UTC', listFn: () => [] });
  check('the story read\'s change fence has no chat-plan finding', !block.findings.some(f => /chat/.test(f.code) || /chat/.test(f.text)), JSON.stringify(block.findings));
  // No real person in it: it goes with them, and the warnings stay out of the story read.
  const d2 = { ...decisions.get(990001), id: 990002, subjectJid: undefined };
  const state2 = { ...s0, decisions: new Map([...s0.decisions, [990002, d2]]) };
  const planned2 = await director.plan({ kind: 'cast.depart', castId: c.id, how: 'moved_away' }, state2, { relax: true });
  check('a chat-made plan with only them closes', planned2.events.some(e => e.type === 'decision.expired' && e.payload?.decisionId === 990002 && e.payload?.reason === 'cast_departed'));
  const block2 = storyRead.changeBlock(planned2, null, { state: state2, now, tz: 'UTC', listFn: () => [] });
  check('…the story read gets no chat line', !block2.findings.some(f => /chat/.test(f.code) || /chat/.test(f.text)), JSON.stringify(block2.findings));
}

section('a schedule edit over a committed plan counts it once');
{
  const d = await scene('coffee break', at(16, 0), [], 'place:cafe', 60);
  // sched-fixes: an owner scene is kept by default (the range split around it) — named once there;
  // cancelled only when picked, then named once in overrides_open.
  const kept = await director.preview({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '15:00', to: '18:00' }] }, { relax: true });
  const k = (kept.continuity?.warnings ?? []).find(x => x.code === 'keeps_plan');
  check('kept by default: keeps_plan names the plan once', k && (k.text.match(/coffee break/g) || []).length === 1, JSON.stringify(kept.continuity?.warnings));
  const p = await director.preview({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '15:00', to: '18:00' }], resolutions: { [`decision:${d.id}`]: 'cancel' } }, { relax: true });
  const w = (p.continuity?.warnings ?? []).find(x => x.code === 'overrides_open');
  check('overrides_open names the plan once', w && (w.text.match(/coffee break/g) || []).length === 1, JSON.stringify(w));
  eq('one thread for it', (p.continuity?.threads ?? []).filter(t => t.id === d.id).length, 1);
}

let dinner = null;
section('writing out the person of tonight\'s date re-plans the evening');
{
  const c = friend();
  dinner = await scene('dinner date', at(19, 30), [c.id]);
  await simulateHours(1);
  check('the date is in today\'s plan', S().plan.blocks.some(b => b.decisionId === dinner.id));
  const p = await director.preview({ kind: 'cast.depart', castId: c.id, how: 'moved_away' }, { relax: true });
  const types = p.events.map(e => e.type);
  check('the date expires (cast_departed)', p.events.some(e => e.type === 'decision.expired' && e.payload?.decisionId === dinner.id && e.payload?.reason === 'cast_departed'));
  check('…and an engine re-plan follows', types.includes('plan.made'), JSON.stringify(types));
  const changed = (p.projection?.rows ?? []).filter(r => r.change !== 'same').length;
  check('WHAT CHANGES AHEAD shows the change', p.projection?.skipped || changed > 0, JSON.stringify(p.projection?.rows?.slice(0, 6)));
  const threads = (p.continuity?.threads ?? []).filter(t => t.kind === 'decision' && t.id === dinner.id);
  eq('one thread for the date', threads.length, 1);
  await director.apply(p.previewId, p.fingerprint);
  check('the plan in force no longer holds the date', !S().plan.blocks.some(b => b.decisionId === dinner.id));
  await simulateHours(Math.ceil((at(21, 0) - clock.now()) / HOUR));
  const there = listEvents({ types: ['activity.started'], limit: 500 }).filter(e => e.payload?.placeId === 'place:restaurant' && e.at >= at(19, 0) && e.at <= at(21, 0));
  eq('he never goes to the restaurant for it', there.map(e => e.payload.kind), []);
}

section('a date that already happened is never cancelled by a departure');
{
  const s0 = S();
  const c = friend();
  const other = [...s0.cast.values()].find(x => x.id !== c.id && x.relation !== 'flatmate');
  const now = clock.now();
  const decisions = new Map(s0.decisions);
  decisions.set(990002, {
    id: 990002, status: 'committed', kind: 'hangout', category: 'social',
    subject: { castIds: [other.id], placeId: 'place:restaurant', eventAt: now - 4 * HOUR, endAt: now - 2 * HOUR },
    options: [{ id: 'go', label: 'Go', minutes: 120 }, { id: 'stay', label: 'Stay in' }], committed: { optionId: 'go', by: 'owner', at: now - 6 * HOUR },
  });
  const planned = await director.plan({ kind: 'cast.depart', castId: other.id, how: 'moved_away' }, { ...s0, decisions }, { relax: true });
  check('no expiry of the past date', !planned.events.some(e => e.type === 'decision.expired' && e.payload?.decisionId === 990002));
  check('no thread for it either', !(planned.continuity?.threads ?? []).some(t => t.id === 990002));
}

section('texts: every planner code reads as a sentence');
{
  const p = await director.preview({ kind: 'money', mode: 'income', amount: 400000 }, { relax: true });
  const w = (p.continuity?.warnings ?? []).find(x => x.code === 'money_jump');
  check('money_jump keeps the checker\'s specific text', w && /a change of \d+/.test(w.text), JSON.stringify(w));
  for (const code of ['romance_cooldown', 'venue_negative', 'salary_jump', 'job_churn', 'notice_active', 'hunt_active', 'pattern_all_office',
    'closes_career_decision', 'money_jump', 'move_churn', 'mood_vs_state', 'sick_long', 'two_places', 'romance_cooldown_set', 'chat_plan_kept']) {
    check(`${code} has a text`, typeof director.__test?.WARNING_TEXT?.[code] === 'string' && director.__test.WARNING_TEXT[code].length > 8);
  }
}

section('suggestions that fix the problem');
{
  const bal = Math.round(S().vitals?.money ?? 0);
  const p = await director.preview({ kind: 'money', mode: 'expense', amount: bal + 5000 }, { relax: true });
  const sg = (p.continuity?.suggestions ?? []).find(x => x.action?.kind === 'money');
  check('money_negative suggests an income', !!sg, JSON.stringify(p.continuity?.suggestions));
  check('…that keeps the balance above zero (a buffer on top)', sg && sg.action.amount > 5000, JSON.stringify(sg?.action));
  const f = await director.preview({ kind: 'career', change: 'fire' }, { relax: true });
  const w = (f.continuity?.warnings ?? []).find(x => x.code === 'job_loss_big');
  const mood = (f.continuity?.suggestions ?? []).find(x => x.action?.kind === 'mood');
  check('job_loss_big offers a mood for the next morning', mood && mood.action.wakeDay === 1, JSON.stringify(f.continuity?.suggestions));
  check('…and points at it', Number.isInteger(w?.fix) && f.continuity.suggestions[w.fix]?.action?.kind === 'mood');
}

await stopLife();
report();
