// T014 — heavy-event embargo (src/life/embargo.js): heavy → embargo.started +
// alert.raised descriptors for the configured hours; chat- and Jev-made / non-heavy
// events refused; isActive boundaries; extension never shortens; end detection
// dated at `until` (catch-up = live); guard note + tone only while active and never
// built from the heavy event's content; projector fold; every descriptor is
// accepted by the real eventLog.appendEvent (engine, owner-made and chat-tainted
// heavy events).
import { setupScratchDb, section, check, eq, report } from './_helpers.js';
import {
  isHeavy, startFromHeavy, isActive, endIfDue, lifeGuardNote, embargoTone, applyEmbargoEvent,
  GUARD_NOTE, EMBARGO_TONE,
} from '../../src/life/embargo.js';
import { appendEvent, getEvent } from '../../src/life/eventLog.js';
import { setClock } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

const { db } = await setupScratchDb();

const T = Date.UTC(2026, 9, 27, 9, 0) / 1000;
const H = 3600;
setClock(() => T);
const PAYLOAD = { what: 'grandmother hospital emergency', who: 'cast:parent' };
const WORDS = ['grandmother', 'hospital', 'emergency', 'parent'];
const heavy = (over = {}) => ({
  id: 41, at: T, type: 'sick.started', actor: 'engine', heavy: true, payload: PAYLOAD, ...over,
});
const appendHeavy = (over = {}) =>
  appendEvent({ type: 'sick.started', at: T, actor: 'engine', heavy: true, payload: PAYLOAD, ...over });
const leaks = (obj) => WORDS.some(w => JSON.stringify(obj).toLowerCase().includes(w));
const eventCount = () => db.prepare('SELECT COUNT(*) AS n FROM world_events').get().n;

try {
  section('which events start an embargo');
  check('heavy engine event', isHeavy(heavy()));
  for (const actor of ['mind', 'owner']) check(`heavy ${actor} event`, isHeavy(heavy({ actor })));
  check('heavy: 1 (raw row) also counts', isHeavy(heavy({ heavy: 1 })));
  check('chat-made heavy event refused', !isHeavy(heavy({ actor: 'chat' })));
  check('Jev-made heavy event refused (matches eventLog)', !isHeavy(heavy({ actor: 'jev' })));
  check('unknown actor refused', !isHeavy(heavy({ actor: 'someone' })));
  check('not heavy', !isHeavy(heavy({ heavy: false })) && !isHeavy(heavy({ heavy: '1' })) && !isHeavy(null));
  eq('chat heavy → no events', startFromHeavy(heavy({ actor: 'chat' })).events, []);
  eq('non-heavy → no events', startFromHeavy(heavy({ heavy: false })).events, []);
  eq('unappended (no id) → no events', startFromHeavy(heavy({ id: undefined })).events, []);
  const existing = { until: T + 5 * H, eventId: 7, heavyEventId: 6, startedAt: T - H };
  check('refusal keeps the current embargo', startFromHeavy(heavy({ actor: 'chat' }), existing).embargo === existing);

  section('start');
  const h1 = appendHeavy();
  eq('heavy event stored heavy', getEvent(h1.id).heavy, true);
  const { embargo: e1, events } = startFromHeavy(h1);
  eq('two descriptors', events.map(e => e.type), ['embargo.started', 'alert.raised']);
  const [started, alert] = events;
  eq(`until = at + ${config.life.embargoHours} h`, started.payload.until, T + config.life.embargoHours * H);
  eq('started at the heavy event time', started.at, T);
  eq('caused by the heavy event', started.causeId, h1.id);
  eq('alert caused by the heavy event', alert.causeId, h1.id);
  eq('alert kind embargo', alert.payload.kind, 'embargo');
  check('engine actor for an engine heavy event', events.every(e => e.actor === 'engine'));
  check('no origin set (appendEvent inherits it)', events.every(e => !('originKind' in e) && !('originJid' in e)));
  check('payloads carry no heavy-event content', !events.some(e => leaks(e.payload)));
  eq('state until', e1.until, started.payload.until);
  eq('custom hours', startFromHeavy(h1, null, { hours: 2 }).events[0].payload.until, T + 2 * H);
  eq('bad hours → config', startFromHeavy(h1, null, { hours: -3 }).events[0].payload.until, T + config.life.embargoHours * H);
  eq('hours capped at a week', startFromHeavy(h1, null, { hours: 10_000 }).events[0].payload.until, T + 168 * H);
  eq('deterministic', JSON.stringify(startFromHeavy(h1).events), JSON.stringify(events));

  section('descriptors are accepted by appendEvent');
  const sRow = appendEvent(started);
  const aRow = appendEvent(alert);
  check('embargo.started appended', sRow?.id > 0 && sRow.type === 'embargo.started');
  check('alert.raised appended', aRow?.id > 0 && aRow.type === 'alert.raised');
  eq('self origin inherited', [sRow.originKind, sRow.originJid], ['self', 'self']);
  eq('cause chain kept', sRow.causeId, h1.id);
  check('embargo events are not heavy themselves', !sRow.heavy && !aRow.heavy);

  section('owner-made and chat-tainted heavy events');
  const ownerHeavy = appendHeavy({ actor: 'owner', at: T + 100 * H });
  const ownerStart = startFromHeavy(ownerHeavy);
  check('owner heavy → owner-actor consequences', ownerStart.events.every(e => e.actor === 'owner'));
  const oRows = ownerStart.events.map(d => appendEvent(d));
  eq('owner origin inherited', oRows.map(r => r.originKind), ['owner', 'owner']);
  const GROUP = '120363000000000001@g.us';
  const trig = appendEvent({ type: 'chat.trigger', at: T + 200 * H, actor: 'chat', originKind: 'group', originJid: GROUP, payload: { kind: 'mention' } });
  // 010: sick.* may not carry a chat origin (CHAT_FORBIDDEN_TYPES); work.crunch still may.
  const mindHeavy = appendHeavy({ type: 'work.crunch', actor: 'mind', at: T + 200 * H, causeId: trig.id });
  eq('chat-caused heavy event carries the chat origin', mindHeavy.originJid, GROUP);
  const cRows = startFromHeavy(mindHeavy).events.map(d => appendEvent(d));
  check('embargo stays tagged with that chat', cRows.every(r => r.originKind === 'group' && r.originJid === GROUP));
  const n = eventCount();
  eq('appended chat-made heavy row is impossible anyway → no events',
    startFromHeavy({ ...mindHeavy, actor: 'chat' }).events, []);
  eq('nothing appended for it', eventCount(), n);

  section('projector fold');
  let proj = applyEmbargoEvent(null, sRow);
  eq('started → embargo', proj, { until: started.payload.until, eventId: sRow.id, heavyEventId: h1.id, startedAt: T });
  check('unrelated event leaves it', applyEmbargoEvent(proj, { type: 'meal', at: T + H }) === proj);
  check('malformed started ignored', applyEmbargoEvent(null, { type: 'embargo.started', at: T, payload: {} }) === null);
  check('null event ignored', applyEmbargoEvent(proj, null) === proj);

  section('active window');
  check('active at start', isActive(proj, T));
  check('active one second before until', isActive(proj, proj.until - 1));
  check('inactive at until', !isActive(proj, proj.until));
  check('bounded by until only (no lower bound)', isActive(proj, T - 10));
  check('null / bad time', !isActive(null, T) && !isActive(proj, NaN) && !isActive({ until: 'x' }, T));

  section('guard note + tone');
  eq('note while active', lifeGuardNote(proj, T + H), GUARD_NOTE);
  eq('no note after', lifeGuardNote(proj, proj.until), null);
  eq('no note without embargo', lifeGuardNote(null, T), null);
  check('note forbids money and help asks', /money/i.test(GUARD_NOTE) && /help/i.test(GUARD_NOTE));
  check('note forbids unprompted group news', /group/i.test(GUARD_NOTE) && /news/i.test(GUARD_NOTE));
  check('note shares no word with the heavy payload', !leaks(GUARD_NOTE));
  check('note is marker-free', !/\[[A-Z]+\s*:/.test(GUARD_NOTE) && !/@\d/.test(GUARD_NOTE));
  eq('tone while active', embargoTone(proj, T + H), EMBARGO_TONE);
  eq('no tone after', embargoTone(proj, proj.until + 1), null);
  check('tone shares no word with the heavy payload', !leaks(EMBARGO_TONE));

  section('a second heavy event extends, never shortens');
  const h2 = appendHeavy({ at: T + 6 * H });
  const later = startFromHeavy(h2, proj, { hours: 12 });
  eq('until moves out', later.events[0].payload.until, T + 18 * H);
  eq('marks what it extends', later.events[0].payload.extends, sRow.id);
  eq('keeps original start', later.embargo.startedAt, T);
  const shorter = startFromHeavy(heavy({ id: 51, at: T + H }), proj, { hours: 1 });
  eq('shorter one keeps the longer until', shorter.events[0].payload.until, proj.until);
  const s2 = appendEvent(later.events[0]);
  eq('extension caused by the second heavy event', s2.causeId, h2.id);
  proj = applyEmbargoEvent(proj, s2);
  eq('fold takes the max', proj.until, T + 18 * H);
  eq('fold keeps first start', proj.startedAt, T);
  eq('fold points at the latest started event', proj.eventId, s2.id);
  const afterGap = startFromHeavy(heavy({ id: 60, at: T + 30 * H }), proj, { hours: 12 });
  eq('after the embargo ended: a fresh one', afterGap.events[0].payload.until, T + 42 * H);
  check('fresh one does not mark extends', !('extends' in afterGap.events[0].payload));
  eq('fresh one restarts the clock', afterGap.embargo.startedAt, T + 30 * H);
  const staleFold = applyEmbargoEvent({ until: T, eventId: 1, startedAt: T - H },
    { id: 9, type: 'embargo.started', at: T + H, payload: { until: T + 3 * H } });
  eq('fold after an expired one starts fresh', staleFold, { until: T + 3 * H, eventId: 9, heavyEventId: null, startedAt: T + H });

  section('end detection');
  eq('not due while active', endIfDue(proj, T + 17 * H), null);
  eq('due at until', endIfDue(proj, T + 18 * H)?.type, 'embargo.ended');
  const late = endIfDue(proj, T + 40 * H);
  eq('a late tick dates it at until (catch-up = live)', late.at, T + 18 * H);
  eq('points at the started event in the payload', late.payload.startedEventId, s2.id);
  eq('caused by time, not an event', late.causeId, null);
  check('no heavy content in the end payload', !leaks(late.payload));
  eq('no embargo → nothing to end', endIfDue(null, T), null);
  const eRow = appendEvent(late);
  check('embargo.ended accepted by appendEvent', eRow?.type === 'embargo.ended');
  const chatEnd = endIfDue(applyEmbargoEvent(null, cRows[0]), T + 300 * H);
  check('ending a chat-tainted embargo is accepted too', appendEvent(chatEnd)?.id > 0);
  const ownerEnd = endIfDue(applyEmbargoEvent(null, oRows[0]), T + 300 * H);
  check('ending an owner embargo is accepted too', appendEvent(ownerEnd)?.id > 0);
  proj = applyEmbargoEvent(proj, eRow);
  eq('ended → null', proj, null);
  eq('nothing after the end', lifeGuardNote(proj, T + 19 * H), null);
  eq('end is idempotent', endIfDue(proj, T + 50 * H), null);

  section('reverting an owner-made heavy event lifts its embargo');
  const { rebuild } = await import('../../src/life/projector.js');
  const { revertEvent } = await import('../../src/life/eventLog.js');
  const oh = appendHeavy({ actor: 'owner', at: T + 400 * H });
  for (const e of startFromHeavy(oh).events) appendEvent(e);
  let st = rebuild({ useSnapshot: false });
  eq('in force before the revert', st.embargo?.heavyEventId, oh.id);
  const alertsBefore = st.alerts.length;
  revertEvent(oh.id, { at: T + 401 * H });
  st = rebuild({ useSnapshot: false });
  check('owner-actor embargo dropped with its heavy event', st.embargo?.heavyEventId !== oh.id, st.embargo);
  eq('… and its alert', st.alerts.length, alertsBefore - 1);
} finally {
  setClock(null);
}

report();
