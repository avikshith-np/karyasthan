// Golden inertness scenario for spec 012 (01-inert.test.js). Run as its own
// process (config reads DB_PATH once):
//
//   node scripts/chat-influence-tests/_golden.js <variant> <mode> <out.json>
//
// variant  life  — 7 days of the 009 engine (example world, mocked Jev), the arcs skill off
//          arcs  — 3 days with the arcs skill on (story seams live, unscripted clerk)
// mode     base       — the recording run (no chat-influence code needed)
//          off        — the chat-influence skill off (its boot default)
//          areas-off  — the skill on with every area toggled off
//
// The run feeds chat messages through perceiveChat, sent replies through
// onReplySent, reads the prompt lines (time, inner state, cast cards) for a
// group, a DM and the dashboard every 3 h, the gate for both chats, and at the
// end the reply prompt (buildConversationContext with the life opt). It writes
// a compact digest — the event-type multiset, a hash of every event (minus the
// wall-clock recorded_at) per local day, the snapshot rows' hash, the final
// serialized state's hash and the line texts — so the recorded base fixture can
// be compared byte for byte with the same run on the new code. Offline: scratch
// DB, fake clock, mocked Jev and clerk, no network.
import {
  setupScratchDb, setBot, seedPeople, seedGroups, bootLife, stopLife, setSkills, fakeJev, fakeClock,
} from '../arcs-tests/_helpers.js';
import crypto from 'crypto';
import fs from 'fs';

const [variant = 'life', mode = 'base', outFile] = process.argv.slice(2);
if (!['life', 'arcs'].includes(variant) || !['base', 'off', 'areas-off'].includes(mode) || !outFile) {
  console.error('usage: _golden.js <life|arcs> <base|off|areas-off> <out.json>');
  process.exit(2);
}

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

const { db } = await setupScratchDb();
// 011's rain gear (umbrella rolls, rainy walks, soaked trips) postdates these
// fixtures: switch it off so the rest of the engine is still compared byte for
// byte with the pre-012 base. 011 tests its rain gear in life-tests/36.
if (mode !== 'base') (await import('../../src/life/commute.js')).__setRainGearForTest(false);
// Earned trust (2026-10-30) postdates them too: off here (its daily deltas, the
// decision lean and the card hint); arcs-tests/27-trust tests it.
if (mode !== 'base') (await import('../../src/life/story/cast.js')).__setTrustForTest(false);
// Scene play-outs (spec 016) postdate them as well: off here; arcs-tests/71–73 test them.
if (mode !== 'base') (await import('../../src/utils/config.js')).config.arcs.scenesEnabled = false;
// Dreams (plan 020 G) as well: off here; arcs-tests/99-dreams tests them.
if (mode !== 'base') (await import('../../src/utils/config.js')).config.arcs.dreamsEnabled = false;
// His wallet (spec 018: the cut-over, itemized spends, the salary catch-up) as well: off here; life-tests/60-wallet tests it.
if (mode !== 'base') (await import('../../src/life/spending.js')).__setWalletForTest(false);
// 020's one-being rules (plan weights, a nudge doesn't recolour a commit): off here; arcs-tests/99-one-being tests them.
if (mode !== 'base') (await import('../../src/life/planWeight.js')).__setOneBeingForTest(false);
const { zonedToUnix, dateKey } = await import('../../src/life/clock.js');
const { loadWorld, EXAMPLE_PATH } = await import('../../src/life/world.js');
const { softmax } = await import('../../src/life/decisions.js');
const { eventsAfter } = await import('../../src/life/eventLog.js');
const { serializeState } = await import('../../src/life/projector.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
const { storeMessage } = await import('../../src/memory/messageStore.js');

await setBot();
const [ALICE, BOB, CAROL] = await seedPeople([
  { jid: '7101@lid', name: 'Avery' }, { jid: '7102@lid', name: 'Blake' }, { jid: '7103@lid', name: 'Casey' },
], { at: Date.UTC(2026, 6, 1) / 1000 });
const [GROUP] = await seedGroups([{ jid: '120363000000990001@g.us', name: 'Golden group', members: [ALICE, BOB, CAROL] }],
  { at: Date.UTC(2026, 6, 1) / 1000 });
const DM = ALICE;

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const T0 = zonedToUnix(2026, 10, 27, 6, 0, tz);

// A few stored lines, dated well before the run (the transcript of the final prompt).
const msgAt = zonedToUnix(2026, 10, 20, 19, 0, tz);
const lines = [
  [GROUP, ALICE, 'Avery', 'anyone up for the late show this week?', 0],
  [GROUP, BOB, 'Blake', 'maybe thursday', 60],
  [GROUP, null, null, 'thursday works for me', 120],
  [DM, ALICE, 'Avery', 'hey, how was work today', 180],
];
lines.forEach(([chat, sender, name, content, dt], i) => storeMessage({
  id: `GOLD${i}`, groupJid: chat, senderJid: sender ?? '10000000000@s.whatsapp.net', senderName: name, content,
  messageType: 'text', isFromSelf: !sender, timestamp: msgAt + dt,
}));

// Jev: decisions lean by the softmax of their utilities (the dry run's "costs"
// policy); claims say commitment for a plan, none otherwise. Live wire shapes.
const jev = fakeJev((req) => {
  const answers = {};
  for (const [key, q] of Object.entries(req?.questions || {})) {
    if (q?.type !== 'choice') continue;
    const ids = Object.keys(q.criteria || {});
    if (key === 'kind' && ids.includes('commitment')) {
      const plan = /going|gym/i.test(String(req?.state?.his_reply ?? ''));
      const probs = plan ? { none: 0.05, claim: 0.05, commitment: 0.9 } : { none: 0.9, claim: 0.05, commitment: 0.05 };
      answers[key] = { type: 'choice', choice: plan ? 'commitment' : 'none', probabilities: probs, confidence: 0.9 };
      continue;
    }
    const us = {};
    for (const o of req?.state?.options || []) if (ids.includes(o.id)) us[o.id] = Number(o.utility) || 0;
    const probs = Object.keys(us).length ? softmax(us) : Object.fromEntries(ids.map(i => [i, 1 / ids.length]));
    const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best) answers[key] = { type: 'choice', choice: best, probabilities: probs, confidence: probs[best] };
  }
  return answers;
});

const skills = { life: true, arcs: variant === 'arcs' };
if (mode === 'areas-off') {
  const { config } = await import('../../src/utils/config.js');
  for (const k of ['mood', 'sleep', 'work', 'invites', 'advice']) config.chatInfluence[k] = false;
  skills['chat-influence'] = true;
}
// Every other loaded skill off: only the ones named above may differ between runs.
const reg = await setSkills({});
for (const s of reg.listSkills()) if (!(s.name in skills)) reg.setSkillEnabled(s.name, false);

const clock = fakeClock(T0);
const { life } = await bootLife({ world, jev, seed: 42, skills, clock });

const out = { variant, lines: [], gates: [], perceive: [], replies: [] };
const aud = { group: () => resolveAudience({ chatJid: GROUP }), dm: () => resolveAudience({ chatJid: DM }), dash: () => ({ kind: 'dashboard' }) };
const CHAT = [
  [GROUP, ALICE, 'are we still on for tonight? might be a bit late'],
  [GROUP, BOB, 'skip it, lets just stay in'],
  [DM, ALICE, 'you coming or not?'],
  [GROUP, CAROL, 'Golden group movie at 9?'],
];
let n = 0;
const days = variant === 'arcs' ? 3 : 7;
const steps = days * 96;
for (let i = 0; i < steps; i++) {
  const t = clock.advance({ minutes: 15 });
  await life.tick();
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t * 1000)));
  const m = Math.round((t % 3600) / 60);
  if (m === 0 && h >= 12) {
    // A fixed line in the evening; otherwise one naming an open decision's kind (so noteChat matches).
    const open = [...(life.getState()?.decisions?.values?.() || [])].find(d => d.status === 'open');
    let pick = [18, 19, 20, 21].includes(h) ? CHAT[n++ % CHAT.length] : null;
    if (!pick && open) pick = [i % 2 ? GROUP : DM, ALICE, `${open.kind} later? ${i % 3 ? 'you coming' : 'nah skip it'}`];
    if (pick) {
      const [chat, sender, content] = pick;
      const msg = { id: `GIN${i}`, groupJid: chat, senderJid: sender, senderName: 'x', content, messageType: 'text', timestamp: t };
      const res = await life.perceiveChat(msg, resolveAudience({ chatJid: chat }));
      out.perceive.push([t, res?.matched ?? null, (res?.events || []).map(e => e.type)]);
    }
  }
  if (m === 0 && h === 22) {
    const res = await life.onReplySent({ chatJid: GROUP, text: "I'm going to the gym tomorrow evening", msgId: `GR${i}` });
    out.replies.push([t, res?.flagged ? res.flagged.kind : res?.skipped ?? null]);
  }
  if (m === 0 && h % 3 === 0) {
    out.lines.push([t, life.timeLine(), life.innerStateLine(aud.group()), life.innerStateLine(aud.dm()),
      life.innerStateLine(aud.dash()), life.castCards(aud.group(), 'work today?', 3), life.castCards(aud.dm(), '', 3)]);
    out.gates.push([t, life.gateMessage({ id: `G${i}`, groupJid: GROUP, senderJid: ALICE }, { isGroup: true }).outcome,
      life.gateMessage({ id: `D${i}`, groupJid: DM, senderJid: ALICE }, { isDm: true }).outcome]);
  }
}

const { buildConversationContext } = await import('../../src/personality/systemPrompt.js');
const trig = { id: 'GTRIG', groupJid: GROUP, senderJid: ALICE, senderName: 'Avery', content: 'how is your day going?', messageType: 'text' };
const dmTrig = { ...trig, id: 'GTRIG2', groupJid: DM };
out.prompts = [
  buildConversationContext(GROUP, trig, true, { audience: aud.group(), life: { availability: 'free' } }).text,
  buildConversationContext(DM, dmTrig, false, { audience: aud.dm(), life: { availability: 'free' } }).text,
];

const events = eventsAfter(0, 100000).map(({ recordedAt, ...e }) => e);
const types = {};
for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
const byDay = {};
for (const e of events) (byDay[dateKey(e.at, tz)] ||= []).push(e);
out.eventCount = events.length;
out.types = Object.fromEntries(Object.entries(types).sort());
out.eventsHash = sha(events);
out.dayHashes = Object.fromEntries(Object.entries(byDay).sort().map(([d, list]) => [d, sha(list)]));
// The fixtures were recorded at snapshot format v2: a format bump alone (v3, 2026-11-02:
// the revert cascade's plan barrier, no fold change for a log without reverts) is not
// a behaviour change, so the version field is hashed as the recorded one.
const atRecordedV = (o) => ({ ...o, v: 2 });
const snaps = db.prepare('SELECT upto_event_id, at, state_json FROM world_snapshots ORDER BY upto_event_id, id').all()
  .map(r => ({ ...r, state_json: JSON.stringify(atRecordedV(JSON.parse(r.state_json))) }));
out.snapshotCount = snaps.length;
out.snapshotsHash = sha(snaps);
const { view, viewAt, ...stateRest } = life.getState();
void view; void viewAt;
out.stateHash = sha(atRecordedV(serializeState({ ...stateRest })));
out.stateKeys = Object.keys(serializeState({ ...stateRest })).sort();
out.jevCalls = jev.calls.length;
out.jevCallers = [...new Set(jev.calls.map(c => c.caller ?? null))].sort();

await stopLife();
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
process.exit(0);
