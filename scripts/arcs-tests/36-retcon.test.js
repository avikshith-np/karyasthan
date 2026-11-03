// 015 Phase 3 — the retcon (src/life/story/director.js planRetcon, rewind.js
// applyRewind; plan Phase 3, review #27): a rewind to T plus new actions dated
// NOW, previewed and applied as ONE transaction — the range excluded, the actions
// caused under their own director.action after world.rewound; continuity reads the
// rewound log (events in the range don't count); a failing action rolls the
// rewind back too; stale when the log moved; an action dated in the past is
// refused; adopted reviews in the range return to the tray; pulse.rebase once;
// the rewind report never reaches the story read; not prompt-draftable.
//
// integration: a realistic log from the life facade (example world, timers off),
// then the Director on a local projection and appender. Invented, persona-neutral
// names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, exampleArcSeed, fakeCallRole, HOUR,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent, getEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended, isExcludedId } from '../../src/life/projector.js';
import { zonedToUnix, dateKey, dayStart, addDays, resolveTimezone } from '../../src/life/clock.js';
import * as store from '../../src/life/story/store.js';
import * as director from '../../src/life/story/director.js';
import * as storyRead from '../../src/life/story/storyRead.js';
import * as promptMod from '../../src/life/story/prompt.js';
import { validatePromptOutput } from '../../src/life/story/schema.js';
import { actionProblem, partsProblem } from '../../src/dashboard/routes/director.js';
import { getDb } from '../../src/memory/db.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
await simulateDays(1);
await simulateHours(5);
await stopLife();

let state = rebuild({ world });
let failAt = null;
let appended = 0;
const append = (spec) => {
  appended += 1;
  if (failAt !== null && appended === failAt) throw new Error('forced append failure');
  const ev = appendEvent(spec);
  state = applyAppended(state, ev, { world });
  return ev;
};
let rebased = 0;
const seed = await exampleArcSeed();
director.__setDepsForTest({
  now: () => clock.now(), getState: () => state, world, append, pulse: { rebase: () => { rebased += 1; } },
  knownNames: () => [], seed: () => seed, setClaimStatus: () => {}, fit: () => null, countSelfReplies: () => 3, chatName: () => 'SECRET-CHAT-NAME',
  onApplyFailed: () => { state = rebuild({ world }); }, projectionBudgetMs: 60_000,
});
const tz = resolveTimezone(world.timezone ?? config.timezone);
const now = () => clock.now();
const tomorrow = addDays(dayStart(now(), tz), 1, tz);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM world_events').get().n;
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code}:${e.reason}${Number.isInteger(e.part) ? `@${e.part}` : ''}`; } };
async function applyAction(action) {
  const p = await director.preview(action, { project: false });
  return director.apply(p.previewId, p.fingerprint, { by: 'tester' });
}

// ── fixture: a bookmark, then story after it (beats, an adopted claim) ──────
await applyAction({ kind: 'bookmark', name: 'before the week' });
const bookmark = state.story.bookmarks.at(-1);
clock.advance({ minutes: 30 });
const beat1 = append({ type: 'cast.beat', at: now(), actor: 'owner', payload: { castId: 'cast:flatmate', kind: 'status', text: 'learning guitar' } });
const beat2 = append({ type: 'cast.beat', at: now(), actor: 'owner', payload: { castId: 'cast:sibling', kind: 'status', text: 'exams' } });
const dm = '15550008888@s.whatsapp.net';
let reviewId;
{
  const t = now();
  const claimId = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, ?, ?, 'commitment', 0.9, 'flagged', ?)`).run(dm, dm, `MSG${t}`, 'SECRET-CLAIM tea tomorrow', t).lastInsertRowid);
  const flagged = append({ type: 'claim.flagged', at: t, actor: 'chat', originKind: 'dm', originJid: dm, payload: { claimId } });
  reviewId = store.createReview({ claimId, claimEventId: flagged.id, chatJid: dm, originKind: 'dm', originJid: dm, createdAt: t, status: 'tray' }).id;
  store.updateReview(reviewId, { reason: 'review_mode', extraction: { type: 'plan', kind: 'tea', summary: 'SECRET-SUMMARY', people: [] },
    resolution: { placeId: 'place:cafe', castIds: [], subjectJid: dm, span: { start: at(tomorrow, 16, 0), end: at(tomorrow, 17, 0) } } });
  await applyAction({ kind: 'tray.adopt', reviewId });
}
clock.advance({ minutes: 10 });
const outing = (h) => ({ kind: 'scene', shape: 'outing', placeId: 'place:park', startAt: at(tomorrow, h, 0), minutes: 60, castIds: ['cast:flatmate'], label: 'a walk' });

section('plan: the rewind batch, then the actions dated now, renumbered');
{
  const p = director.plan({ kind: 'retcon', to: { bookmarkId: bookmark.id }, actions: [outing(18)], reason: 'try again' }, state, { now: now() });
  eq('the rewind batch first', p.events.slice(0, 3).map(e => e.type), ['director.action', 'world.rewound', 'world.reanchored']);
  const i = p.events.findIndex((e, k) => k > 0 && e.type === 'director.action');
  check('then the action\'s own director.action parent', i > 2 && p.events[i].payload.kind === 'scene');
  check('… and its events caused under it, refs continuing the rewind\'s', p.events.slice(i + 1).every(e => typeof e.causeRef === 'string')
    && new Set(p.events.map(e => e.ref)).size === p.events.length);
  check('every action event is dated now', p.events.slice(i).every(e => e.at === now()));
  eq('the target is the bookmark\'s event', p.extra.toEventId, bookmark.eventId);
  eq('parts', p.parts, [{ kind: 'scene', source: 'hand' }]);
  check('continuity on the actions', Array.isArray(p.continuity?.warnings));
}

section('continuity reads the rewound log: events in the range don\'t count');
{
  const keep = config.arcs.beatsPerWeek;
  config.arcs.beatsPerWeek = 2;
  const beat = { kind: 'scene', shape: 'cast.beat', castId: 'cast:parent', beatKind: 'status', text: 'gardening' };
  const plain = director.plan(beat, state, { now: now() });
  check('a plain beat after two beats this week → beats_week', plain.continuity.warnings.some(w => w.code === 'beats_week'));
  const re = director.plan({ kind: 'retcon', to: { bookmarkId: bookmark.id }, actions: [beat] }, state, { now: now() });
  check('the same beat in a retcon (the two beats are rewound) → no beats_week', !re.continuity.warnings.some(w => w.code === 'beats_week'));
  config.arcs.beatsPerWeek = keep;
}

section('refusals: past start, excluded parts, stale, rollback');
{
  const past = { ...outing(18), startAt: now() - 2 * HOUR };
  eq('an action dated in the past → invalid bad_startAt @0', await codeOf(() => director.plan({ kind: 'retcon', to: { bookmarkId: bookmark.id }, actions: [past] }, state, { now: now() })),
    'invalid:bad_startAt@0');
  eq('a rewind inside a retcon → bad_kind', await codeOf(() => director.plan({ kind: 'retcon', to: { bookmarkId: bookmark.id }, actions: [{ kind: 'rewind', toEventId: 3 }] }, state, { now: now() })),
    'invalid:bad_kind@0');
  eq('no target → bad_to', await codeOf(() => director.plan({ kind: 'retcon', to: {}, actions: [outing(18)] }, state, { now: now() })), 'invalid:bad_to');
  eq('route: bad target → bad_to', actionProblem({ kind: 'retcon', to: { at: -1 }, actions: [outing(18)] }), 'bad_to');
  eq('route: a well-formed retcon passes', actionProblem({ kind: 'retcon', to: { bookmarkId: 4 }, actions: [outing(18)], reason: 'x' }), null);
  eq('route: a nested retcon part → bad_kind with its index', partsProblem({ kind: 'retcon', to: { eventId: 4 }, actions: [outing(18), { kind: 'retcon' }] }), { error: 'bad_kind', part: 1 });

  const pv = await director.preview({ kind: 'retcon', to: { bookmarkId: bookmark.id }, actions: [outing(18)] }, { project: false });
  append({ type: 'cast.beat', at: now(), actor: 'owner', payload: { castId: 'cast:parent', kind: 'status', text: 'moved the furniture' } });
  eq('the log moved → stale', await codeOf(() => director.apply(pv.previewId, pv.fingerprint, { by: 'tester' })), 'stale:stale');

  const pv2 = await director.preview({ kind: 'retcon', to: { bookmarkId: bookmark.id }, actions: [outing(18)] }, { project: false });
  const before = count();
  const r0 = rebased;
  appended = 0;
  failAt = pv2.events.length;                   // the last action event
  eq('a failing action → conflict apply_failed', await codeOf(() => director.apply(pv2.previewId, pv2.fingerprint, { by: 'tester' })), 'conflict:apply_failed');
  failAt = null;
  eq('… and the rewind rolled back with it: nothing written', count(), before);
  check('… the beats are still live (no exclusion folded)', !isExcludedId(state, beat1.id) && !isExcludedId(state, beat2.id));
  eq('… no rebase', rebased, r0);
}

section('apply: one transaction, the range excluded, reviews back to the tray, one rebase');
{
  const pv = await director.preview({ kind: 'retcon', to: { bookmarkId: bookmark.id }, actions: [outing(18)], reason: 'a different week' });
  check('the preview carries the rewind summary and a projection from the rewound world', pv.extra?.toEventId === bookmark.eventId
    && Array.isArray(pv.projection?.rows), JSON.stringify(pv.projection).slice(0, 120));
  // The story read of a retcon: never the rewind report.
  const cr = fakeCallRole({ 'director.continuity': () => JSON.stringify({ warnings: [], suggestions: [] }) });
  storyRead.__setDepsForTest(null);
  storyRead.__setDepsForTest({ now: () => clock.now(), getState: () => state, world, callRole: cr.fn, mindBudgetOk: async () => ({ ok: true }),
    getUsageByCaller: () => [], knownNames: () => [] });
  const sr = await storyRead.runStoryRead(pv.previewId);
  const user = cr.calls[0]?.user ?? '';
  check('the story read ran', sr.status === 'ok');
  check('… with no rewind report (no world.rewound, cancelled counts, chat names, claims)', !/world\.rewound|byType|cancelled|SECRET-CHAT-NAME|SECRET-CLAIM|mismatched/.test(user));
  const before = count();
  const r0 = rebased;
  const res = await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
  eq('one apply appended the whole batch', count() - before, res.eventIds.length);
  check('the beats in the range are excluded', isExcludedId(state, beat1.id) && isExcludedId(state, beat2.id));
  const evs = res.eventIds.map(getEvent);
  const rew = evs.findIndex(e => e.type === 'world.rewound');
  const opened = evs.findIndex(e => e.type === 'decision.opened');
  check('the outing came after world.rewound, owner, under its own parent', rew >= 0 && opened > rew && evs[opened].actor === 'owner'
    && getEvent(evs[opened].causeId)?.type === 'director.action');
  check('the outing is live in the new timeline', state.decisions.get(evs[opened].id)?.status === 'committed');
  eq('the adopted review returned to the tray', store.getReview(reviewId)?.status, 'returned');
  eq('pulse.rebase called once', rebased - r0, 1);
  eq('apply reports the target and parts (audit)', [res.toEventId, res.parts], [bookmark.eventId, [{ kind: 'scene', source: 'hand' }]]);
}

section('not prompt-draftable (R10)');
{
  check('retcon is not a prompt kind', !director.PROMPT_ACTION_KINDS.includes('retcon'));
  const v = validatePromptOutput(JSON.stringify({ actions: [{ action: { kind: 'retcon', to: { bookmarkId: 1 }, actions: [] } }] }),
    promptMod.buildCatalogue(state, world, now(), tz).check, promptMod.VOCAB);
  eq('a model retcon → not_allowed', v.dropped.map(d => d.reason), ['not_allowed']);
  check('a story-read retcon suggestion → not allowed', !storyRead.suggestionAllowed({ kind: 'retcon' }));
}

report();
