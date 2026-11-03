// 010 T007 — story reducer (src/life/story/reducer.js) and controls
// (src/life/story/controls.js). Unit only: hand-built event lists folded through
// 009's project() plus the story handlers/observers, the way projector.js merges
// them (009 handler first, then the story observer; 010 types → story handler).
// Once the projector lane (T009) merges the tables itself, the local fold steps
// aside and the same assertions run through the real projector. No DB writes,
// no model calls; invented names and ids only.
import { section, check, eq, near, report } from '../life-tests/_helpers.js';
import { createInitialState, project, serializeState, deserializeState } from '../../src/life/projector.js';
import { EVENT_TYPES, STORY_EVENT_TYPES } from '../../src/life/eventLog.js';
import {
  initialStory, STORY_HANDLERS, STORY_OBSERVERS, REWIND_KEEP, isRewindKept, ROUTINE_TYPES,
  worldOverlay, heavyGuardActive, storyEquivalent, CATEGORIES, SLIDERS, isPinKey, cleanSeedValue,
  ROMANCE_BREAKUP_COOLDOWN_DAYS,
} from '../../src/life/story/reducer.js';
import {
  check as controlsCheck, categoryOf, pinKeysFor, sliderFactor, fateOf, sliderValue, reconcilerModeOf, isPaused,
} from '../../src/life/story/controls.js';

const DAY = 86400;
const H = 3600;
const T0 = Date.UTC(2026, 0, 5, 6, 0) / 1000; // a Monday, 06:00 UTC

const WORLD = {
  timezone: 'UTC',
  self: { birthdate: '1998-04-02', homePlaceId: 'place:home', job: { title: 'Analyst', employerName: 'Example Works', officePlaceId: 'place:office' } },
  money: { salary: 1000, payday: 1 },
  places: [],
  cast: [],
};

const PROJECTOR_MERGED = !!createInitialState(WORLD).story;

// One event at a time, the way the merged projector will do it.
function apply(state, ev) {
  let next = project(state, ev, WORLD);
  if (PROJECTOR_MERGED) return next;
  const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
  if (STORY_HANDLERS[ev.type]) STORY_HANDLERS[ev.type](next, ev, p, WORLD);
  else if (STORY_OBSERVERS[ev.type]) STORY_OBSERVERS[ev.type](next, ev, p, WORLD);
  return next;
}

let nextId = 1;
function ev(type, at, payload = {}, extra = {}) {
  return { id: nextId++, at, type, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false, ...extra };
}
const owner = (type, at, payload) => ev(type, at, payload, { actor: 'owner', originKind: 'owner', originJid: 'owner' });
const fold = (events, from = createInitialState(WORLD)) => events.reduce(apply, from);

function baseEvents() {
  nextId = 1;
  return [
    ev('genesis', T0, { source: 'example', timezone: 'UTC', self: WORLD.self }),
    ev('place.created', T0, { id: 'place:home', name: 'Home', kind: 'home', lat: 10, lon: 20 }),
    ev('place.created', T0, { id: 'place:office', name: 'Office', kind: 'office', lat: 10.01, lon: 20.01 }),
    ev('place.created', T0, { id: 'place:office-2', name: 'New office', kind: 'office', lat: 10.02, lon: 20.02 }),
    ev('cast.created', T0, { id: 'cast:river', name: 'River', relation: 'flatmate', metrics: { closeness: 0.6, trust: 0.6, tension: 0.1 } }),
    ev('cast.created', T0, { id: 'cast:sky', name: 'Sky', relation: 'friend' }),
  ];
}

try {
  section('catalogue and tables');
  eq('initialStory has the data-model keys', Object.keys(initialStory()).sort(), ['adopted', 'arcs', 'bookmarks', 'career', 'castLife',
    'commitments', 'controls', 'daily', 'family', 'heavy', 'history', 'newCast', 'relationships', 'romance', 'seedOverlay', 'together', 'workLog'].sort());
  eq('fate natural in all 7 categories', Object.values(initialStory().controls.fate), CATEGORIES.map(() => 'natural'));
  eq('sliders default 0.5', Object.values(initialStory().controls.sliders), SLIDERS.map(() => 0.5));
  check('initialStory is fresh each call', initialStory() !== initialStory() && initialStory().arcs !== initialStory().arcs);
  check('initialStory is plain JSON', JSON.stringify(JSON.parse(JSON.stringify(initialStory()))) === JSON.stringify(initialStory()));
  const types009 = [...EVENT_TYPES].filter(t => !STORY_EVENT_TYPES.has(t));
  check('story handlers are 010 types only (009 names can never be shadowed)', Object.keys(STORY_HANDLERS).every(t => STORY_EVENT_TYPES.has(t)));
  check('observers are 009 types only', Object.keys(STORY_OBSERVERS).every(t => types009.includes(t)));
  eq('every 010 type has a handler except world.rewound (projector bookkeeping)',
    [...STORY_EVENT_TYPES].filter(t => !STORY_HANDLERS[t]), ['world.rewound']);
  eq('ROUTINE_TYPES', [...ROUTINE_TYPES].sort(), ['availability.changed', 'phone.check.ended', 'phone.check.started']);
  check('REWIND_KEEP has the R11 types', ['director.pin_set', 'world.rewound', 'event.reverted', 'heavy.vetoed', 'claim.flagged', 'claim.withdrawn'].every(t => REWIND_KEEP.has(t)));
  check('decision.expired kept only for owner/privacy reasons', isRewindKept({ type: 'decision.expired', payload: { reason: 'frozen' } })
    && isRewindKept({ type: 'decision.expired', payload: { reason: 'withdrawn' } })
    && isRewindKept({ type: 'decision.expired', payload: { reason: 'owner_cancelled' } })
    && isRewindKept({ type: 'decision.expired', payload: { reason: 'pinned' } })
    && !isRewindKept({ type: 'decision.expired', payload: { reason: 'rewound' } })
    && !isRewindKept({ type: 'decision.expired', payload: {} }));
  check('routine and story facts are not kept', !isRewindKept({ type: 'meal' }) && !isRewindKept({ type: 'arc.stage' }) && !isRewindKept(null));
  check('pin keys', ['self.job', 'self.home', 'self.relationship', 'arc:12.stage', 'cast:river'].every(isPinKey)
    && !['self.age', 'arc:x.stage', 'cast:', 'river', 'arc:0.stage'].some(isPinKey));
  eq('seed overlay bounds', [cleanSeedValue('career.appraisalMonth', 4), cleanSeedValue('career.appraisalMonth', 13),
    cleanSeedValue('family.callCadenceDays', [3, 9]), cleanSeedValue('family.callCadenceDays', [9, 3]), cleanSeedValue('nope', 1),
    cleanSeedValue('career.noticeDays', null)], [4, undefined, [3, 9], undefined, undefined, null]);

  section('cast and relationships');
  let s = fold(baseEvents());
  check('genesis seeds the career base (no overlay yet)', s.story.career.title === 'Analyst' && s.story.career.eventId === null);
  // 014 geo (plan §A0, R28): projected places win, so the identity needs a world
  // whose places match the projection (this fixture's WORLD has none: they merge in).
  const WORLD_P = { ...WORLD, places: [...s.places.values()].map(({ eventId, ...p }) => p) };
  check('worldOverlay is the identity before any career event', worldOverlay(s, WORLD_P) === WORLD_P);
  eq('…and event-created places merge into a world that lacks them', worldOverlay(s, WORLD).places.map(p => p.id),
    ['place:home', 'place:office', 'place:office-2']);
  eq('genesis cast does not count as new cast', s.story.newCast.ats, []);
  s = apply(s, ev('cast.updated', T0 + H, { castId: 'cast:river', fields: { status: 'learning to bake', job: 'x'.repeat(90), name: 'Renamed', birthday: 'not a date' }, reason: 'owner_edit' }));
  eq('cast.updated merges allowed fields with caps', [s.cast.get('cast:river').status, s.cast.get('cast:river').job.length, s.cast.get('cast:river').name, s.cast.get('cast:river').birthday], ['learning to bake', 60, 'River', null]);
  eq('status mirrored into castLife', s.story.castLife['cast:river'].status, 'learning to bake');
  s = apply(s, ev('cast.beat', T0 + 2 * H, { castId: 'cast:sky', kind: 'away', text: 'trip', until: T0 + 90 * DAY }));
  eq('away capped at 31 days', s.story.castLife['cast:sky'].away.until, T0 + 2 * H + 31 * DAY);
  s = apply(s, ev('cast.beat', T0 + 3 * H, { castId: 'cast:sky', kind: 'back' }));
  eq('back clears away', [s.story.castLife['cast:sky'].away, s.story.castLife['cast:sky'].lastBeat.kind], [null, 'back']);
  const nBeat = nextId;
  s = apply(s, ev('cast.beat', T0 + 3 * H, { castId: 'cast:nobody', kind: 'news' }));
  s = apply(s, ev('cast.beat', T0 + 3 * H, { castId: 'cast:sky', kind: 'gossip' }));
  check('unknown cast or beat kind ignored', !s.story.castLife['cast:nobody'] && s.story.castLife['cast:sky'].lastBeat.eventId < nBeat);
  for (let i = 0; i < 22; i++) s = apply(s, ev('cast.history_added', T0 + 4 * H + i, { castId: 'cast:river', text: `memory ${i}` }));
  s = apply(s, owner('cast.history_added', T0 + 5 * H, { castId: 'cast:river', text: 'an old memory', dated: T0 - 300 * DAY }));
  const hist = s.story.history['cast:river'];
  eq('history capped at 20, oldest (by date) dropped', [hist.length, hist[0].text, hist[hist.length - 1].text], [20, 'memory 2', 'memory 21']);
  s = apply(s, ev('relationship.changed', T0 + 6 * H, { castId: 'cast:river', delta: { closeness: 0.9, tension: -0.5, intimacy: 0.15, togetherMin: 5000 }, reason: 'shared_time' }));
  const river = s.cast.get('cast:river');
  near('closeness Δ clamped to +0.2', river.metrics.closeness, 0.8);
  near('tension clamped at 0', river.metrics.tension, 0);
  near('intimacy in story.relationships', s.story.relationships['cast:river'].intimacy, 0.15);
  eq('togetherMin Δ ≤ 1440', s.story.relationships['cast:river'].togetherMin, 1440);
  eq('shared_time counts as contact', s.story.relationships['cast:river'].lastContactAt, T0 + 6 * H);
  s = apply(s, ev('relationship.changed', T0 + 7 * H, { castId: 'cast:river', delta: { closeness: 0.2 } }));
  s = apply(s, ev('relationship.changed', T0 + 7 * H, { castId: 'cast:river', delta: { closeness: 0.2 } }));
  near('result clamped to 1', s.cast.get('cast:river').metrics.closeness, 1);
  s = apply(s, owner('place.updated', T0 + 7 * H, { placeId: 'place:office', name: 'Old office' }));
  eq('place.updated merges', [s.places.get('place:office').name, s.places.get('place:office').kind], ['Old office', 'office']);
  s = apply(s, ev('cast.created', T0 + 8 * H, { id: 'cast:wren', name: 'Wren', relation: 'neighbour' }, { actor: 'mind' }));
  eq('later cast counts toward the new-cast pace', s.story.newCast.ats, [T0 + 8 * H]);

  section('shared time');
  s = apply(s, ev('activity.started', T0 + 9 * H, { kind: 'dinner', placeId: 'place:home', withCast: ['cast:river', 'cast:sky'] }));
  s = apply(s, ev('activity.ended', T0 + 9 * H + 90 * 60, { kind: 'dinner' }));
  eq('90 min with each', [s.story.together['cast:river'].minutesSinceDaily, s.story.together['cast:sky'].minutesSinceDaily], [90, 90]);
  s = apply(s, ev('activity.started', T0 + 10 * H, { kind: 'walk', withCast: ['cast:river'] }));
  s = apply(s, ev('activity.started', T0 + 10 * H + 30 * 60, { kind: 'cafe', withCast: ['cast:river'] }));
  s = apply(s, ev('travel.started', T0 + 11 * H, { to: 'place:home', minutes: 10 }));
  eq('continuous company across activities counts once', s.story.together['cast:river'].minutesSinceDaily, 150);
  eq('contact recorded', s.story.relationships['cast:sky'].lastContactAt, T0 + 9 * H + 90 * 60);
  {
    // A work meeting's attendees (routine.js, social not set) are not company:
    // no session, no shared minutes, no contact — so they never move drift.
    const skyBefore = structuredClone(s.story.together['cast:sky']);
    const contactBefore = s.story.relationships['cast:sky'].lastContactAt;
    let m = apply(s, ev('activity.started', T0 + 12 * H, { kind: 'meeting', placeId: 'place:office', withCast: ['cast:sky'], social: false }));
    m = apply(m, ev('activity.ended', T0 + 12 * H + 45 * 60, { kind: 'meeting' }));
    eq('a meeting with attendees opens no shared-time session', m.story.together['cast:sky'], skyBefore);
    eq('… and records no contact', m.story.relationships['cast:sky'].lastContactAt, contactBefore);
    m = apply(m, ev('activity.started', T0 + 13 * H, { kind: 'meeting', placeId: 'place:office', withCast: ['cast:sky'], social: true }));
    m = apply(m, ev('activity.ended', T0 + 13 * H + 30 * 60, { kind: 'meeting' }));
    eq('control: a meeting marked social still counts', m.story.together['cast:sky'].minutesSinceDaily, skyBefore.minutesSinceDaily + 30);
  }
  s = apply(s, ev('story.daily_done', T0 + DAY, { date: '2026-01-06', rolls: {}, counts: {} }));
  eq('daily_done folds story.daily', s.story.daily, { lastDate: '2026-01-06', lastAt: T0 + DAY });
  eq('and resets the shared-time counters', s.story.together['cast:river'].minutesSinceDaily, 0);
  s = apply(s, ev('story.daily_done', T0 + DAY + 60, { date: '2026-01-04' }));
  eq('an older date never moves it back', s.story.daily.lastDate, '2026-01-06');

  section('shared time: a chat-origin activity credits nothing (review regression)');
  {
    const DM = '15550000099@s.whatsapp.net';
    const dm = (type, at, payload) => ev(type, at, payload, { originKind: 'dm', originJid: DM });
    const skyContact = s.story.relationships['cast:sky'].lastContactAt;
    const riverMin = s.story.together['cast:river'].minutesSinceDaily;
    let c = apply(s, dm('activity.started', T0 + DAY + 2 * H, { kind: 'dinner', placeId: 'place:home', withCast: ['cast:sky', 'cast:river'] }));
    check('the session is marked chat', c.story.together['cast:sky'].chat === true);
    c = apply(c, ev('activity.ended', T0 + DAY + 4 * H, { kind: 'dinner' }));
    eq('a DM-adopted outing adds no shared minutes', [c.story.together['cast:sky'].minutesSinceDaily, c.story.together['cast:river'].minutesSinceDaily], [0, riverMin]);
    eq('… and no contact', c.story.relationships['cast:sky'].lastContactAt, skyContact);
    c = apply(c, dm('activity.recorded', T0 + DAY + 5 * H, { kind: 'walk', castIds: ['cast:sky'], startAt: T0 + DAY + 4 * H, endAt: T0 + DAY + 5 * H, label: 'x' }));
    eq('a chat-origin activity.recorded touches no contact', c.story.relationships['cast:sky'].lastContactAt, skyContact);
    // Self company that turns into a chat-origin activity with the same person: the self part counts, the chat part doesn't.
    c = apply(c, ev('activity.started', T0 + DAY + 6 * H, { kind: 'walk', withCast: ['cast:sky'] }));
    c = apply(c, dm('activity.started', T0 + DAY + 6 * H + 30 * 60, { kind: 'cafe', withCast: ['cast:sky'] }));
    c = apply(c, ev('activity.ended', T0 + DAY + 8 * H, { kind: 'cafe' }));
    eq('self 30 min counted, the chat 90 min not', c.story.together['cast:sky'].minutesSinceDaily, 30);
    check('the closed session drops the chat flag', c.story.together['cast:sky'].chat === undefined && c.story.together['cast:sky'].openSince === null);
  }

  section('romance arc');
  const arcEv = ev('arc.started', T0 + 2 * DAY, { category: 'romance', kind: 'romance', castIds: ['cast:sky', 'cast:nope!'], stage: 'interested' });
  s = apply(s, arcEv);
  eq('romance arc started', [s.story.romance.arcId, s.story.romance.partnerId, s.story.romance.stage, s.self.relationship], [arcEv.id, 'cast:sky', 'interested', 'single']);
  s = apply(s, ev('arc.stage', T0 + 10 * DAY, { arcId: arcEv.id, from: 'interested', to: 'talking' }));
  s = apply(s, ev('arc.stage', T0 + 30 * DAY, { arcId: arcEv.id, from: 'talking', to: 'dating', commitEventId: 3 }));
  eq('stage → self.relationship', [s.story.arcs[arcEv.id].stage, s.story.romance.stage, s.self.relationship], ['dating', 'dating', 'dating']);
  s = apply(s, ev('arc.stage', T0 + 31 * DAY, { arcId: arcEv.id, to: 'single' }));
  s = apply(s, ev('arc.stage', T0 + 31 * DAY, { arcId: arcEv.id, to: 'spouse' }));
  eq('invalid romance stage ignored', s.story.romance.stage, 'dating');
  const dOpen = ev('decision.opened', T0 + 32 * DAY, { kind: 'romance:step', arcId: arcEv.id, category: 'romance', options: [{ id: 'step' }, { id: 'wait' }] });
  s = apply(s, dOpen);
  eq('arc decision ids tracked', s.story.arcs[arcEv.id].decisionIds, [dOpen.id]);
  s = apply(s, ev('arc.ended', T0 + 40 * DAY, { arcId: arcEv.id, outcome: 'broken_up' }));
  eq('breakup → single with cool-down', [s.story.romance.arcId, s.story.romance.stage, s.self.relationship, s.story.romance.cooldownUntil],
    [null, 'single', 'single', T0 + 40 * DAY + ROMANCE_BREAKUP_COOLDOWN_DAYS * DAY]);
  eq('arc closed', [s.story.arcs[arcEv.id].status, s.story.arcs[arcEv.id].outcome], ['ended', 'broken_up']);
  s = apply(s, ev('arc.stage', T0 + 41 * DAY, { arcId: arcEv.id, to: 'dating' }));
  eq('an ended arc takes no stage', s.self.relationship, 'single');

  section('career and the world overlay');
  s = apply(s, ev('career.appraisal', T0 + 50 * DAY, { year: 2026, band: 'good', pct: 40, salaryFrom: 1000, salaryTo: 1080, score: 0.6 }));
  eq('appraisal folds salary and year', [s.story.career.salary, s.story.career.lastAppraisalYear, s.story.career.lastAppraisal.pct], [1080, 2026, 20]);
  let w = worldOverlay(s, WORLD);
  check('overlay is a copy, world untouched', w !== WORLD && WORLD.money.salary === 1000 && WORLD.self.job.officePlaceId === 'place:office');
  eq('overlay salary', w.money.salary, 1080);
  eq('overlay keeps the other money fields', w.money.payday, 1);
  s = apply(s, ev('career.resigned', T0 + 60 * DAY, { decisionId: 99, noticeUntil: T0 + 90 * DAY, toEmployer: 'Other Works', toTitle: 'Lead', toOfficePlaceId: 'place:office-2' }));
  eq('notice recorded', s.story.career.notice.until, T0 + 90 * DAY);
  s = apply(s, ev('career.job_changed', T0 + 90 * DAY, { title: 'Lead', employerName: 'Other Works', officePlaceId: 'place:office-2' }));
  w = worldOverlay(s, WORLD);
  eq('job change → self.officePlaceId and the overlay office', [s.self.officePlaceId, w.self.job.officePlaceId, w.self.job.title, s.story.career.notice], ['place:office-2', 'place:office-2', 'Lead', null]);
  check('routine is not overlaid', w.routine === WORLD.routine);

  section('heavy arcs');
  const prop = ev('heavy.proposed', T0 + 100 * DAY, { themeId: 'theme-a', kind: 'minor_accident', onsetAt: T0 + 101 * DAY, roll: 0.001, p: 0.002 });
  s = apply(s, prop);
  eq('proposal pending', s.story.heavy.proposals[prop.id].status, 'pending');
  s = apply(s, owner('heavy.vetoed', T0 + 100 * DAY + H, { proposedId: prop.id }));
  eq('vetoed', s.story.heavy.proposals[prop.id].status, 'vetoed');
  s = apply(s, ev('heavy.lapsed', T0 + 101 * DAY, { proposedId: prop.id, reason: 'refused' }));
  eq('a vetoed proposal never lapses or restarts', s.story.heavy.proposals[prop.id].status, 'vetoed');
  const prop2 = ev('heavy.proposed', T0 + 200 * DAY, { themeId: 'theme-b', kind: 'pet_loss', onsetAt: T0 + 201 * DAY });
  s = apply(s, prop2);
  const start = ev('heavy.started', T0 + 201 * DAY, { proposedId: prop2.id, themeId: 'theme-b', kind: 'pet_loss', until: T0 + 400 * DAY }, { heavy: true });
  s = apply(s, start);
  eq('started; until capped at 30 days', [s.story.heavy.active.id, s.story.heavy.active.until, s.story.heavy.proposals[prop2.id].status], [start.id, T0 + 231 * DAY, 'started']);
  check('heavy guard during the arc', heavyGuardActive(s, T0 + 220 * DAY));
  check('not after its end', !heavyGuardActive(s, T0 + 231 * DAY));
  check('not with no state', !heavyGuardActive(null, T0) && !heavyGuardActive(createInitialState(WORLD), T0));
  s = apply(s, ev('heavy.ended', T0 + 210 * DAY, { heavyId: 12345, reason: 'due' }));
  check('a wrong heavyId does not end it', s.story.heavy.active !== null);
  s = apply(s, owner('heavy.ended', T0 + 211 * DAY, { heavyId: start.id, reason: 'owner' }));
  check('heavy.ended clears it', s.story.heavy.active === null && !heavyGuardActive(s, T0 + 212 * DAY));

  section('work log');
  // T0 is 06:00 UTC, so +10 h is 16:00 the same day.
  s = apply(s, ev('work.late', T0 + 300 * DAY + 10 * H, { extraMin: 60 }));
  s = apply(s, ev('work.crunch', T0 + 300 * DAY + 3 * H, { amount: 10 }));
  s = apply(s, ev('sick.started', T0 + 301 * DAY, { days: 2 }));
  s = apply(s, ev('work.late', T0 + 299 * DAY + 10 * H, {})); // catch-up: an earlier day written later
  const days = s.story.workLog.days;
  eq('days in date order', days.map(d => d.date), [...days.map(d => d.date)].sort());
  eq('counts per day', days.slice(-3).map(d => [d.late, d.crunch, d.sick]), [[1, 0, 0], [1, 1, 0], [0, 0, 2]]);

  section('claims → world');
  const adopted = ev('claim.adopted', T0 + 302 * DAY, { claimId: 7, reviewId: 3, as: 'decision', ref: null });
  s = apply(s, adopted);
  const adoptedDec = ev('decision.opened', T0 + 302 * DAY, { kind: 'plan', adopted: true, category: 'social', claimId: 7, options: [{ id: 'go' }, { id: 'stay' }] });
  s = apply(s, adoptedDec);
  eq('adoption tracks its decision', s.story.adopted[7], { eventId: adopted.id, reviewId: 3, as: 'decision', decisionId: adoptedDec.id, status: 'adopted', at: T0 + 302 * DAY });
  s = apply(s, ev('commitment.recorded', T0 + 302 * DAY, { dueAt: T0 + 305 * DAY, castIds: ['cast:river'], label: 'x' }));
  eq('pending commitment kept for the calendar fit', s.story.commitments.map(c => c.dueAt), [T0 + 305 * DAY]);
  s = apply(s, ev('claim.withdrawn', T0 + 303 * DAY, { claimId: 7, reason: 'forgotten' }));
  eq('withdrawn', s.story.adopted[7].status, 'withdrawn');

  section('director controls');
  s = apply(s, owner('director.fate_set', T0 + 310 * DAY, { category: 'romance', mode: 'frozen' }));
  s = apply(s, owner('director.fate_set', T0 + 310 * DAY, { category: 'romance', mode: 'chaos' }));
  s = apply(s, owner('director.fate_set', T0 + 310 * DAY, { category: 'astrology', mode: 'frozen' }));
  eq('fate set; bad values ignored', [s.story.controls.fate.romance, s.story.controls.fate.astrology], ['frozen', undefined]);
  s = apply(s, owner('director.slider_set', T0 + 310 * DAY, { slider: 'drama', value: 7 }));
  s = apply(s, owner('director.slider_set', T0 + 310 * DAY, { slider: 'romanceAppetite', value: 0.333 }));
  eq('sliders clamped and rounded', [s.story.controls.sliders.drama, s.story.controls.sliders.romanceAppetite], [1, 0.33]);
  const pinEv = owner('director.pin_set', T0 + 310 * DAY, { pinKey: 'self.job' });
  s = apply(s, pinEv);
  s = apply(s, owner('director.pin_set', T0 + 310 * DAY, { pinKey: 'self.salary' }));
  eq('pins', s.story.controls.pins, { 'self.job': { eventId: pinEv.id, at: T0 + 310 * DAY } });
  s = apply(s, owner('director.paused', T0 + 311 * DAY, { reason: 'busy week' }));
  s = apply(s, owner('director.paused', T0 + 312 * DAY, {}));
  eq('pause keeps its first time', [s.story.controls.paused, s.story.controls.pausedAt], [true, T0 + 311 * DAY]);
  const bm = owner('director.bookmark', T0 + 312 * DAY, { name: 'before the move', eventId: 5 });
  s = apply(s, bm);
  s = apply(s, owner('director.bookmark', T0 + 312 * DAY, { name: 'future', eventId: 999999 }));
  eq('bookmark (not to a future id)', s.story.bookmarks.map(b => b.name), ['before the move']);
  s = apply(s, owner('director.seed_set', T0 + 312 * DAY, { path: 'career.appraisalMonth', value: 4 }));
  s = apply(s, owner('director.seed_set', T0 + 312 * DAY, { path: 'career.employers', value: ['x'] }));
  eq('seed overlay allow-listed', s.story.seedOverlay, { 'career.appraisalMonth': 4 });
  s = apply(s, owner('director.reconciler_mode', T0 + 312 * DAY, { mode: 'review' }));
  eq('reconciler mode', reconcilerModeOf(s), 'review');

  section('tolerance');
  const before = JSON.stringify(serializeState(s));
  // Handlers whose event means something even with an empty payload.
  const MEANINGFUL_EMPTY = new Set(['story.daily_done', 'director.paused', 'director.resumed']);
  let threw = null;
  const scratch = deserializeState(JSON.parse(before));
  for (const type of Object.keys(STORY_HANDLERS)) {
    try {
      for (const p of [{}, { redacted: true }, { castId: 42, arcId: 'x', fields: 'no', delta: [1], pinKey: {}, value: NaN, kind: 7 }]) {
        STORY_HANDLERS[type](scratch, ev(type, T0 + 400 * DAY, p), p, WORLD);
        if (!MEANINGFUL_EMPTY.has(type)) STORY_HANDLERS[type](s, ev(type, T0 + 400 * DAY, p), p, WORLD);
      }
    } catch (err) { threw = `${type}: ${err.message}`; }
  }
  eq('no handler throws on empty, redacted or garbage payloads', threw, null);
  eq('… and none of them changes anything', JSON.stringify(serializeState(s)), before);
  const red = baseEvents();
  const redBeat = ev('cast.beat', T0 + H, { redacted: true }, { redacted: true });
  const sr = fold([...red, redBeat]);
  check('a redacted row folds to nothing', !sr.story.castLife['cast:river'] && !sr.story.castLife['cast:sky']);
  const noStory = createInitialState(WORLD);
  delete noStory.story;
  STORY_HANDLERS['director.paused'](noStory, owner('director.paused', T0, {}), {}, WORLD);
  check('a state without a story slice gets one', noStory.story?.controls?.paused === true);

  section('determinism, replay and snapshots');
  const script = () => {
    const evs = baseEvents();
    const a = ev('arc.started', T0 + DAY, { category: 'romance', kind: 'romance', castIds: ['cast:sky'] });
    evs.push(a,
      ev('activity.started', T0 + DAY + H, { kind: 'dinner', withCast: ['cast:sky'] }),
      ev('activity.ended', T0 + DAY + 3 * H, {}),
      ev('relationship.changed', T0 + DAY + 4 * H, { castId: 'cast:sky', delta: { passion: 0.1, togetherMin: 120 }, reason: 'shared_time' }),
      ev('arc.stage', T0 + 9 * DAY, { arcId: a.id, to: 'talking' }),
      ev('career.appraisal', T0 + 20 * DAY, { year: 2026, band: 'fair', pct: 2, salaryTo: 1020 }),
      owner('director.slider_set', T0 + 21 * DAY, { slider: 'drama', value: 0.8 }),
      ev('heavy.proposed', T0 + 22 * DAY, { themeId: 't', kind: 'pet_loss', onsetAt: T0 + 23 * DAY }),
      ev('story.daily_done', T0 + 23 * DAY, { date: '2026-01-28' }));
    return evs;
  };
  const evs = script();
  const live = fold(evs);
  const replay = fold(script());
  check('same log → same story (replay = live)', storyEquivalent(live, replay) && JSON.stringify(live.story) === JSON.stringify(replay.story));
  const mid = fold(evs.slice(0, 9));
  const restored = deserializeState(JSON.parse(JSON.stringify(serializeState(mid))));
  check('snapshot round trip keeps the story slice', JSON.stringify(restored.story) === JSON.stringify(mid.story));
  const resumed = evs.slice(9).reduce(apply, restored);
  check('snapshot + replay of the rest = full fold', storyEquivalent(resumed, live) && JSON.stringify(resumed.story) === JSON.stringify(live.story));
  const old009 = serializeState(createInitialState(WORLD));
  delete old009.story;
  const loaded = deserializeState(JSON.parse(JSON.stringify(old009)));
  if (loaded.story === undefined) console.log('  (not yet: T009) 009 snapshot → story defaults: deserializeState not extended yet');
  else check('a 009 snapshot without story loads with defaults', JSON.stringify(loaded.story) === JSON.stringify(initialStory()));

  section('storyEquivalent');
  const other = fold(script());
  other.story.bookmarks.push({ id: 1, name: 'x', eventId: 1, at: T0 });
  other.story.controls.paused = true;
  other.self = { ...other.self, age: 99 };
  check('ignores bookmarks, controls and age', storyEquivalent(live, other));
  const diff = fold(script());
  diff.story.romance.stage = 'dating';
  check('a different romance stage differs', !storyEquivalent(live, diff));
  const diffCast = fold(script());
  diffCast.cast.get('cast:sky').metrics.trust = 0.9;
  check('a different cast metric differs', !storyEquivalent(live, diffCast));
  const closed = fold(script());
  closed.decisions.set(999, { status: 'committed' });
  check('closed decisions are not compared', storyEquivalent(live, closed));
  const opened = fold(script());
  opened.decisions.set(999, { status: 'open' });
  check('open decisions are', !storyEquivalent(live, opened));
  const bare = createInitialState(WORLD);
  const bareNoStory = createInitialState(WORLD);
  delete bareNoStory.story;
  bare.story = initialStory();
  check('no story slice ≡ an empty one', storyEquivalent(bare, bareNoStory));

  section('controls');
  const st = (controls = {}) => ({ story: { ...initialStory(), controls: { ...initialStory().controls, ...controls } } });
  const c0 = st();
  eq('natural: engine start ok', controlsCheck({ source: 'engine', category: 'romance', action: 'start' }, c0), { ok: true });
  eq('state via opts.state', controlsCheck({ source: 'engine', category: 'romance', action: 'start', state: st({ paused: true }) }), { ok: false, reason: 'paused' });
  eq('invalid source', controlsCheck({ source: 'chat', category: 'romance', action: 'start' }, c0), { ok: false, reason: 'invalid' });
  eq('invalid action', controlsCheck({ source: 'engine', category: 'romance', action: 'delete' }, c0), { ok: false, reason: 'invalid' });
  eq('unknown category fails closed', controlsCheck({ source: 'engine', category: 'politics', action: 'beat' }, c0), { ok: false, reason: 'invalid' });
  eq('no args fails closed', controlsCheck(), { ok: false, reason: 'invalid' });
  const paused = st({ paused: true });
  for (const action of ['start', 'beat', 'decision', 'adopt']) {
    eq(`paused refuses ${action}`, controlsCheck({ source: 'engine', category: 'cast', action }, paused).reason, 'paused');
  }
  eq('paused lets consequences through', controlsCheck({ source: 'engine', category: 'career', action: 'change' }, paused), { ok: true });
  eq('paused reconciler adopt refused', controlsCheck({ source: 'reconciler', category: 'social', action: 'adopt' }, paused).reason, 'paused');
  const frozen = st({ fate: { ...initialStory().controls.fate, romance: 'frozen' } });
  for (const action of ['start', 'beat', 'decision', 'adopt', 'change']) {
    eq(`frozen refuses ${action}`, controlsCheck({ source: 'engine', category: 'romance', action }, frozen).reason, 'frozen');
  }
  eq('frozen is per category', controlsCheck({ source: 'engine', category: 'career', action: 'start' }, frozen), { ok: true });
  eq('frozen refuses reconciler adoptions (FR-004)', controlsCheck({ source: 'reconciler', category: 'romance', action: 'adopt' }, frozen).reason, 'frozen');
  eq('owner start refused when frozen', controlsCheck({ source: 'owner', category: 'romance', action: 'start' }, frozen).reason, 'frozen');
  eq('owner change allowed when frozen', controlsCheck({ source: 'owner', category: 'romance', action: 'change' }, frozen), { ok: true });
  eq('owner not paused', controlsCheck({ source: 'owner', category: 'romance', action: 'beat' }, paused), { ok: true });
  const pinned = st({ pins: { 'self.job': { eventId: 3, at: T0 }, 'cast:river': { eventId: 4, at: T0 } } });
  eq('pin refuses with its key', controlsCheck({ source: 'mind', category: 'career', action: 'change', pinKeys: ['self.relationship', 'self.job'] }, pinned), { ok: false, reason: 'pinned', pinKey: 'self.job' });
  eq('pin refuses the owner too (unpin first)', controlsCheck({ source: 'owner', category: 'cast', action: 'change', pinKeys: ['cast:river'] }, pinned), { ok: false, reason: 'pinned', pinKey: 'cast:river' });
  eq('unpinned keys pass', controlsCheck({ source: 'engine', category: 'cast', action: 'beat', pinKeys: ['cast:sky', 'garbage'] }, pinned), { ok: true });
  const guided = st({ fate: { ...initialStory().controls.fate, family: 'guided' } });
  eq('guided parks the mind', controlsCheck({ source: 'mind', category: 'family', action: 'beat' }, guided), { ok: false, reason: 'guided' });
  eq('guided engine decision opens as a card', controlsCheck({ source: 'engine', category: 'family', action: 'decision' }, guided), { ok: true, reason: 'guided', ask: true });
  eq('guided engine beat passes', controlsCheck({ source: 'engine', category: 'family', action: 'beat' }, guided), { ok: true });
  eq('paused beats frozen (reason order)', controlsCheck({ source: 'engine', category: 'romance', action: 'beat' }, st({ paused: true, fate: frozen.story.controls.fate })).reason, 'paused');
  eq('categoryOf', ['romance:step', 'career:offer', 'family', 'social:birthday', 'breakup', 'cast:new', 'weather', 'heavy', null, 'jobs:x'].map(categoryOf),
    ['romance', 'career', 'family', 'social', 'heavy', 'cast', null, 'heavy', null, null]);
  eq('fateOf', [fateOf('romance', frozen), fateOf('career', frozen), fateOf('career', null), fateOf('magic', c0)], ['frozen', 'natural', 'natural', null]);
  eq('sliderFactor 0.5 → ×1, heavy 2×', [sliderFactor('drama', c0), sliderFactor('heavyLikelihood', c0)], [1, 1]);
  const sl = st({ sliders: { ...initialStory().controls.sliders, drama: 1, heavyLikelihood: 0 } });
  eq('sliderFactor extremes', [sliderFactor('drama', sl), sliderFactor('heavyLikelihood', sl), sliderFactor('unknown', sl)], [1.5, 0, 1]);
  eq('sliderValue clamps stored garbage', sliderValue('drama', st({ sliders: { drama: 5 } })), 1);
  check('isPaused', isPaused(paused) && !isPaused(c0) && !isPaused(null));
  eq('reconciler mode fallback', [reconcilerModeOf(c0, 'review'), reconcilerModeOf(c0, 'bogus'), reconcilerModeOf(null)], ['review', 'auto', 'auto']);
  const ps = fold(baseEvents());
  const romanceArc = ev('arc.started', T0 + DAY, { category: 'romance', kind: 'romance', castIds: ['cast:sky'] });
  const ps2 = apply(ps, romanceArc);
  eq('pinKeysFor job change', pinKeysFor({ type: 'career.job_changed', payload: {} }), ['self.job']);
  eq('pinKeysFor cast beat', pinKeysFor({ type: 'cast.beat', payload: { castId: 'cast:river' } }), ['cast:river']);
  eq('pinKeysFor romance stage resolves the arc', pinKeysFor({ type: 'arc.stage', payload: { arcId: romanceArc.id } }, ps2).sort(),
    [`arc:${romanceArc.id}.stage`, 'cast:sky', 'self.relationship'].sort());
  eq('pinKeysFor heavy breakup', pinKeysFor({ type: 'heavy.started', payload: { kind: 'breakup' } }, ps2).sort(), [`arc:${romanceArc.id}.stage`, 'self.relationship'].sort());
  eq('pinKeysFor heavy illness on a member', pinKeysFor({ type: 'heavy.started', payload: { kind: 'family_illness', castId: 'cast:river' } }), ['cast:river']);
  eq('pinKeysFor career offer decision', pinKeysFor({ type: 'decision.opened', payload: { kind: 'career:offer', category: 'career', subject: { castIds: ['cast:river'] } } }).sort(), ['cast:river', 'self.job']);
  eq('pinKeysFor unknown/garbage', [pinKeysFor({ type: 'meal' }), pinKeysFor(null), pinKeysFor({ type: 'cast.beat', payload: { castId: 'Robert' } })], [[], [], []]);
} catch (err) {
  check('no unexpected throw', false, err?.stack ?? String(err));
}

report();
