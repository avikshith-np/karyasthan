// 016 scene play-outs — the pure parts (plan §P1.2–§P1.6, §P2.1, §P2.2, D1/D6/D9/D10/D14):
// eligibility (office lunch, meeting, dinner at home, a solo eat-out → none; an outing
// with someone, a family visit, an invitation → yes; < 20 min, a departed member, a heavy
// start, an excluded start), the tier, the fact sheet (no JID / real name / chat text,
// {FRIEND}, negative wording, size), the code outcome (deterministic, drama-scaled),
// output validation (closed keys, caps, labels, outcome consistency, self_only rejects,
// {FRIEND} surviving sanitize, maxInvented on a realistic 1200-char scene while the
// journal / narration keep a limit of 1, real names, URL / JID, venue scrub), effects
// (bounds, the daily cap, the 015 double-count rule, pins / frozen / paused, chat origin,
// onset gates, follow-up intent) and the follow-up pulse items (fit, lapse).
// Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR, DAY,
} from './_helpers.js';
import { sanitizeWebContent } from '../../src/brain/webSearch.js';
import { rngFor } from '../../src/life/rng.js';
import { isSceneSession, sessionOf, tierOf, firstMeetOf } from '../../src/life/story/scenes/detect.js';
import { buildFactSheet, codeOutcome, oneLiner, FRIEND } from '../../src/life/story/scenes/facts.js';
import { renderUser, RENDER_MAX, SCENE_CHARTER } from '../../src/life/story/scenes/charter.js';
import { validateSceneOutput, validateEditedText } from '../../src/life/story/scenes/schema.js';
import { planEffects, followupItems, PER_SCENE_MAX, PER_DAY_MAX } from '../../src/life/story/scenes/effects.js';
import { validateNarration, validateJournalPart, validateText } from '../../src/life/story/schema.js';

await setupScratchDb();
const booted = await bootLife();
const { life, clock, world } = booted;
await simulateHours(3);
const base = () => life.getState();   // a deep-copied view: safe to edit
const tz = world.timezone;

let nextId = 900000;
const ev = (type, at, payload, extra = {}) => ({ id: ++nextId, at, type, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false, ...extra });
const pair = (kind, withCast, minutes = 60, extra = {}) => {
  const t0 = clock.now() - 3 * HOUR;
  const st = ev('activity.started', t0, { kind, placeId: 'place:cafe', withCast, social: true }, extra);
  const en = ev('activity.ended', t0 + minutes * 60, { kind }, { causeId: st.id });
  return [st, en];
};

section('eligibility (D1)');
{
  const s = base();
  const verdict = (kind, cast, min, extra) => { const [a, b] = pair(kind, cast, min, extra); return isSceneSession(a, b, s).reason ?? 'ok'; };
  eq('office lunch with coworkers → routine', verdict('lunch', ['cast:coworker-a', 'cast:coworker-b']), 'routine');
  eq('a meeting → routine', verdict('meeting', ['cast:manager']), 'routine');
  eq('dinner at home with the flatmate → routine', verdict('dinner', ['cast:flatmate']), 'routine');
  eq('a solo eat-out → alone', verdict('eat-out', []), 'alone');
  eq('an eat-out with the flatmate → ok', verdict('eat-out', ['cast:flatmate']), 'ok');
  eq('a family visit → ok', verdict('visit', ['cast:parent']), 'ok');
  eq('an invitation (a real person, no cast) → ok', verdict('hangout', [], 60, { subjectJid: '15550001111@s.whatsapp.net' }), 'ok');
  eq('19 minutes → short', verdict('hangout', ['cast:flatmate'], 19), 'short');
  eq('a heavy start → heavy', verdict('hangout', ['cast:flatmate'], 60, { heavy: true }), 'heavy');
  eq('an unknown cast id → alone', verdict('hangout', ['cast:nobody']), 'alone');
  const gone = base();
  gone.story.departed = { 'cast:flatmate': { departedAt: clock.now() } };
  const [a, b] = pair('hangout', ['cast:flatmate']);
  eq('a departed member is dropped → alone', isSceneSession(a, b, gone).reason, 'alone');
  const ex = base();
  ex.excluded.add(a.id);
  eq('an excluded start → excluded', isSceneSession(a, b, ex).reason, 'excluded');
}

section('session, mode, tier (D7/D10)');
{
  const s = base();
  const [a, b] = pair('hangout', ['cast:flatmate', 'cast:coworker-a']);
  const sess = sessionOf(a, b, s);
  eq('cast sorted, full mode, 60 min', [sess.castIds, sess.mode, sess.minutes], [['cast:coworker-a', 'cast:flatmate'], 'full', 60]);
  const [c, d] = pair('hangout', ['cast:flatmate'], 60, { originKind: 'group', originJid: '120363000000000001@g.us' });
  eq('chat origin → narration_only', sessionOf(c, d, s).mode, 'narration_only');
  const [e, f] = pair('hangout', ['cast:flatmate'], 60, { subjectJid: '15550001111@s.whatsapp.net' });
  const so = sessionOf(e, f, s);
  eq('a real person → self_only, a code scene (D17: never a model call)', [so.mode, tierOf(so, s, { firstMeet: ['cast:flatmate'] })], ['self_only', 'code']);
  eq('a routine outing with cast met at genesis → clerk', tierOf(sess, s, { firstMeet: firstMeetOf(sess, s) }), 'clerk');
  eq('a first meeting → mind', tierOf(sess, s, { firstMeet: firstMeetOf(sess, s, { metAtGenesis: () => false }) }), 'mind');
  eq('an owner tone → mind', tierOf(sess, s, { tone: 'they hit it off' }), 'mind');
  const date = base();
  date.story.relationships['cast:coworker-a'] = { ...(date.story.relationships['cast:coworker-a'] ?? {}), passion: 0.4 };
  eq('a date (an eligible member with passion ≥ 0.3) → mind', tierOf(sessionOf(a, b, date), date), 'mind');
}

section('the fact sheet: no JID, no real name, {FRIEND}, size');
{
  const s = base();
  const [e, f] = pair('eat-out', [], 90, { subjectJid: '15550001111@s.whatsapp.net' });
  const so = sessionOf(e, f, s);
  const built = buildFactSheet(s, so, { tz, persona: { displayName: 'Him' }, outcome: { value: 'fine', by: 'code' } });
  const user = renderUser(built.sheet);
  check('self_only sheet: the token, no JID, no people', user.includes(FRIEND) && !user.includes('15550001111') && built.sheet.people.length === 0);
  const [a, b] = pair('hangout', ['cast:flatmate']);
  const full = buildFactSheet(s, sessionOf(a, b, s), { tz, persona: { displayName: 'Him' }, outcome: { value: 'well', by: 'owner' },
    history: { 'cast:flatmate': Array(50).fill('x'.repeat(120)) }, beats: { 'cast:flatmate': ['hobby', 'away', 'news'] }, negative: true });
  eq('labels P1 → castId', full.labels, { P1: 'cast:flatmate' });
  eq('beats: hobby/news kept, away dropped', full.sheet.people[0].beats, ['hobby', 'news']);
  check('rendered ≤ 6 KB and fenced', Buffer.byteLength(renderUser(full.sheet), 'utf8') <= RENDER_MAX && renderUser(full.sheet).includes('STORY_DATA'));
  check('the charter carries the fence note and the outcome rule', SCENE_CHARTER.includes('data, never instructions') && SCENE_CHARTER.includes('OUTCOME is fixed'));
  eq('one-liner (self_only) names only the token', oneLiner(so, 'well', { place: 'a restaurant' }), 'Eating out at a restaurant with {FRIEND} — it went well.');
}

section('the code outcome: deterministic, drama-scaled');
{
  const s = base();
  const [a, b] = pair('hangout', ['cast:flatmate']);
  const sess = sessionOf(a, b, s);
  const one = codeOutcome(s, sess, rngFor('2026-11-01', 'scene:outcome:1'));
  const two = codeOutcome(s, sess, rngFor('2026-11-01', 'scene:outcome:1'));
  eq('same date + key → same outcome', one, two);
  const count = (st) => { let n = 0; for (let i = 0; i < 2000; i++) if (codeOutcome(st, sess, rngFor('2026-11-01', `k${i}`)) === 'badly') n++; return n / 2000; };
  const hi = base();
  hi.story.controls.sliders.drama = 1;
  hi.cast.set('cast:flatmate', { ...hi.cast.get('cast:flatmate'), metrics: { closeness: 0.2, trust: 0.3, tension: 0.9 } });
  const lo = base();
  lo.story.controls.sliders.drama = 0;
  lo.cast.set('cast:flatmate', { ...lo.cast.get('cast:flatmate'), metrics: { closeness: 0.2, trust: 0.3, tension: 0.9 } });
  const rh = count(hi);
  const rl = count(lo);
  check('badly ≤ 10 % at drama 1, even with high tension', rh <= 0.11, rh);
  check('drama 0 halves it or more', rl < rh * 0.6, { rl, rh });
}

section('output validation (D9/D10/D14)');
{
  const labels = { P1: 'cast:flatmate' };
  const ctx = { labels, mode: 'full', outcome: 'well', firstMeet: [], maxChars: 1200, names: ['Flatmate', 'example', 'Café', 'Him'],
    knownNames: ['Quinn Marlow'], castNames: ['Flatmate (example)'], venueNames: [{ name: 'Café', kind: 'cafe' }] };
  const ok = (o) => JSON.stringify({ narration: 'They spent the evening at the Café talking about books and old trips, and the time went quickly. He walked home pleased with how easy it had all felt.', topics: ['books'], highlight: 'talking about books', awkward: null, chemistry: 0.5, focus: 'P1', ending: 'nothing', effects: [], ...o });
  check('a good one passes', validateSceneOutput(ok({}), ctx).ok);
  eq('an unknown key → rejected', validateSceneOutput(ok({ secret: 1 }), ctx).reason, 'unknown_key');
  eq('an unknown label → rejected', validateSceneOutput(ok({ focus: 'P9' }), ctx).reason, 'bad_label');
  eq('well + parted_badly → outcome mismatch', validateSceneOutput(ok({ ending: 'parted_badly' }), ctx).reason, 'outcome_mismatch');
  eq('badly + closeness up → outcome mismatch', validateSceneOutput(ok({ effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'small' }] }), { ...ctx, outcome: 'badly' }).reason, 'outcome_mismatch');
  eq('impressions only for a first meeting', validateSceneOutput(ok({ impressions: { him: [{ p: 'P1', text: 'kind' }], them: [] } }), ctx).reason, 'impression_not_first_meet');
  eq('a real full name → rejected', validateSceneOutput(ok({ narration: 'They ran into Quinn Marlow at the Café and talked for an hour about everything and nothing, and then he went home happy with the evening.' }), ctx).reason, 'real_name');
  eq('a URL → rejected', validateSceneOutput(ok({ highlight: 'see www.example.com later' }), ctx).reason, 'url');
  eq('a phone number → rejected', validateSceneOutput(ok({ highlight: 'he saved 5551234567 in his phone' }), ctx).reason, 'identifier');
  eq('too short → rejected', validateSceneOutput(ok({ narration: 'Nice.' }), ctx).reason, 'too_short');
  const neg = validateSceneOutput(ok({ narration: 'The Café was dirty and loud, and the food was awful. They left early and walked home in silence, both tired and a little cross with the whole evening.', ending: 'left_early', highlight: 'leaving the Café early' }), { ...ctx, outcome: 'badly' });
  check('a negative scene never names the venue', neg.ok && !/Café/.test(neg.value.narration + neg.value.highlight), neg);

  const so = { ...ctx, mode: 'self_only', labels: {}, outcome: 'fine' };
  const sOk = (o) => JSON.stringify({ narration: 'He met {FRIEND} at the Café after work. He ordered too much, ate slowly and found himself relaxing for the first time in days, then walked home feeling lighter.', topics: [], highlight: 'ordering too much', awkward: null, chemistry: null, focus: null, ending: 'nothing', effects: [], ...o });
  check('{FRIEND} survives sanitizeWebContent', sanitizeWebContent('with {FRIEND} at 7').includes('{FRIEND}'));
  check('self_only good one passes', validateSceneOutput(sOk({}), so).ok, validateSceneOutput(sOk({}), so));
  eq('self_only without the token → rejected', validateSceneOutput(sOk({ narration: 'He went out to the Café after work and ordered too much, ate slowly and found himself relaxing for the first time in days, then walked home.' }), so).reason, 'friend_missing');
  eq('self_only with a quote → rejected', validateSceneOutput(sOk({ narration: 'He met {FRIEND} at the Café after work. "Great to see you," he said, and ordered too much, ate slowly and relaxed for the first time in days.' }), so).reason, 'quote');
  eq('self_only attribution after the token → rejected', validateSceneOutput(sOk({ narration: 'He met {FRIEND} at the Café after work and {FRIEND} told him about a new job. He ordered too much and walked home slowly, feeling lighter.' }), so).reason, 'attribution');
  eq('self_only chemistry → rejected', validateSceneOutput(sOk({ chemistry: 0.7 }), so).reason, 'their_side');
  eq('self_only effects → rejected', validateSceneOutput(sOk({ effects: [{ p: 'P1', metric: 'trust', dir: 'up', size: 'small' }] }), so).reason, 'bad_label');
  eq('a full scene may not use the token', validateSceneOutput(ok({ narration: 'They met {FRIEND} at the Café and talked about books and old trips; the time went quickly, and he walked home pleased with the evening.' }), ctx).reason, 'friend_token');

  // D14: a realistic 1200-char scene with a few invented capitalised words passes; journal / narration keep their limit of 1.
  const long = ['They met at the Café just after seven, when the rain had eased and the street smelled of wet dust.',
    'Flatmate had already found a table by the window and was halfway through a story about an old street where a cousin had once lived.',
    'He ordered the usual and listened, laughing at the right places, and found that he did not need to try very hard.',
    'They talked about the week, about work that never quite ended, and about a trip to Lakeshore they kept meaning to take.',
    'Somewhere in the middle the conversation drifted to old flatmates and worse landlords, and they spent a long time trading stories, each one a little more unlikely than the last.',
    'By nine the Café was emptying out. They split the bill without fuss and walked back slowly, still talking, past the closed shops and the bus stop with its flickering light.',
    'At the corner they stopped for a minute to finish a story neither of them wanted to cut short.',
    'It had been an easy evening, the kind that leaves a quiet good mood behind it, and he went to bed later than he meant to.'].join(' ');
  check('the fixture is ~1000–1200 chars', long.length >= 900 && long.length <= 1200, long.length);
  const lr = validateSceneOutput(ok({ narration: long }), ctx);
  check('maxInvented scales with length: a long realistic scene passes', lr.ok, lr);
  eq('…with the journal / narration limit of 1 it would be rejected', validateText(long, { cap: 1300, names: ctx.names, maxBytes: 8192 }).reason, 'invented_name');
  check('journal and narration keep their limit (the default stays 1)', validateNarration('Lunch with Kestrel and Varn at noon.').ok === false && validateJournalPart('Lunch with Kestrel and Varn.').ok === false);
  eq('an owner edit: same rules, any invented words', validateEditedText('Short and sweet: they had tea at the Corner Kettle.', { mode: 'full', knownNames: ['Quinn Marlow'] }).ok, true);
  eq('an owner edit of a self_only scene must keep the token', validateEditedText('He met someone for dinner.', { mode: 'self_only', knownNames: [] }).reason, 'friend_missing');
}

section('effects (§P2.1): bounds, daily cap, double count, controls, chat origin');
{
  const s = base();
  const [a, b] = pair('hangout', ['cast:flatmate']);
  const sess = sessionOf(a, b, s);
  const out = (o = {}) => ({ chemistry: 0.4, focus: 'cast:flatmate', ending: 'nothing', effects: [
    { castId: 'cast:flatmate', metric: 'closeness', dir: 'up', size: 'medium' },
    { castId: 'cast:flatmate', metric: 'closeness', dir: 'up', size: 'medium' },
    { castId: 'cast:flatmate', metric: 'tension', dir: 'down', size: 'small' }], ...o });
  const ctx = { tier: 'clerk', at: clock.now(), tz, seed: null, todayScene: {}, outcomeHappened: false, lastOnsetAt: null };
  const e1 = planEffects(s, sess, out(), ctx);
  eq('per scene |Σ| ≤ 0.05', e1[0]?.payload?.delta, { closeness: PER_SCENE_MAX, tension: -0.02 });
  const e2 = planEffects(s, sess, out(), { ...ctx, todayScene: { 'cast:flatmate': { closeness: 0.04 } } });
  eq('per day closeness ≤ 0.06 across scenes', e2[0]?.payload?.delta?.closeness, Math.round((PER_DAY_MAX - 0.04) * 1000) / 1000);
  const e3 = planEffects(s, sess, out(), { ...ctx, outcomeHappened: true });
  eq("015's outcome already moved closeness/tension → only the rest", e3.length, 0);
  const pinned = base();
  pinned.story.controls.pins['cast:flatmate'] = { eventId: 1, at: clock.now() };
  eq('a pinned member: no effects', planEffects(pinned, sessionOf(a, b, pinned), out(), ctx).length, 0);
  const frozen = base();
  frozen.story.controls.fate.social = 'frozen';
  eq('social frozen: narration only', planEffects(frozen, sessionOf(a, b, frozen), out(), ctx).length, 0);
  const paused = base();
  paused.story.controls.paused = true;
  eq('the Director paused: narration only', planEffects(paused, sessionOf(a, b, paused), out(), ctx).length, 0);
  const [c, d] = pair('hangout', ['cast:flatmate'], 60, { originKind: 'dm', originJid: '15550001111@s.whatsapp.net' });
  eq('a chat-origin outing: no effects', planEffects(s, sessionOf(c, d, s), out(), ctx).length, 0);
  const passionUp = { effects: [{ castId: 'cast:coworker-a', metric: 'passion', dir: 'up', size: 'medium' }] };
  const [g, h] = pair('hangout', ['cast:coworker-a', 'cast:parent']);
  const pe = planEffects(s, sessionOf(g, h, s), { chemistry: 0.3, focus: 'cast:coworker-a', ending: 'nothing', ...passionUp }, ctx);
  eq('passion up needs chemistry ≥ 0.5', pe.length, 0);
  const fam = planEffects(s, sessionOf(g, h, s), { chemistry: 0.9, focus: 'cast:parent', ending: 'nothing', effects: [{ castId: 'cast:parent', metric: 'intimacy', dir: 'up', size: 'small' }] }, ctx);
  eq('intimacy never for family', fam.length, 0);
}

section('romance onset (D6) and the follow-up intent');
{
  const seed = { romance: {} };
  const s = base();
  s.story.relationships['cast:coworker-a'] = { ...(s.story.relationships['cast:coworker-a'] ?? {}), passion: 0.28 };
  const [a, b] = pair('hangout', ['cast:coworker-a']);
  const sess = sessionOf(a, b, s);
  const out = (o = {}) => ({ chemistry: 0.8, focus: 'cast:coworker-a', ending: 'swapped_numbers',
    effects: [{ castId: 'cast:coworker-a', metric: 'passion', dir: 'up', size: 'small' }], ...o });
  const ctx = { tier: 'mind', at: clock.now(), tz, seed, todayScene: {}, outcomeHappened: false, lastOnsetAt: null };
  const types = (list) => list.map(e => e.type);
  eq('mind, chemistry 0.8, swapped numbers, passion over 0.3 → onset + follow-up', types(planEffects(s, sess, out(), ctx)), ['relationship.changed', 'arc.started', 'scene.followup']);
  eq('a fell-back mind run → no onset', types(planEffects(s, sess, out(), { ...ctx, tier: 'clerk', fellBack: true })).includes('arc.started'), false);
  eq('clerk tier needs chemistry ≥ 0.85', types(planEffects(s, sess, out({ chemistry: 0.85 }), { ...ctx, tier: 'clerk' })).includes('arc.started'), true);
  eq('a scene-caused onset within 30 days → none', types(planEffects(s, sess, out(), { ...ctx, lastOnsetAt: clock.now() - 10 * DAY })).includes('arc.started'), false);
  eq('no romance section in the seed → none', types(planEffects(s, sess, out(), { ...ctx, seed: {} })).includes('arc.started'), false);
  eq('ending nothing → neither', types(planEffects(s, sess, out({ ending: 'nothing' }), ctx)), ['relationship.changed']);
  const f = planEffects(s, sess, out(), ctx).find(e => e.type === 'scene.followup');
  check('the follow-up starts tomorrow 17:00 for 7 days, at a public place', f && f.payload.to - f.payload.from === 7 * DAY && f.payload.placeId === 'place:cafe' && f.payload.from > clock.now(), f);
  const busy = base();
  busy.story.followups = { 5: { id: 5, castId: 'cast:coworker-a', status: 'open', at: clock.now() - DAY } };
  eq('an open follow-up with them already → no new one', types(planEffects(busy, sessionOf(a, b, busy), out({ chemistry: 0.6, ending: 'plan_to_meet' }), { ...ctx, seed: {} })), ['relationship.changed']);
}

section('follow-up pulse items (§P2.2): fit → an unlocked decision; lapse');
{
  await simulateHours(Math.max(0, 9 - 3));
  const s = base();
  const now = clock.now();
  s.story.followups = { 77: { id: 77, castId: 'cast:flatmate', from: now - HOUR, to: now + 3 * DAY, placeId: 'place:cafe', bias: 1.2, status: 'open' } };
  const items = followupItems(s, now, { world, rngFor });
  eq('one fit item', items.map(i => i.label), ['scene:followup_fit']);
  const added = [];
  let id = 1;
  items[0]?.run((spec) => { const e = { ...spec, id: id++ }; added.push(e); return e; });
  eq('decision.opened {followupId} + a code lean, NOT committed', added.map(e => e.type), ['decision.opened', 'decision.lean']);
  eq('opened carries the follow-up, the go option its bias', [added[0]?.payload?.followupId, added[0]?.payload?.options?.find(o => o.id === 'go')?.bias], [77, 1.2]);
  s.story.followups[77].to = now - 1;
  eq('window over → lapse {window}', followupItems(s, now, { world, rngFor }).map(i => i.label), ['scene:followup_lapse']);
  s.story.followups[77].to = now + DAY;
  s.cast.delete('cast:flatmate');
  const lap = [];
  followupItems(s, now, { world, rngFor })[0]?.run((spec) => { lap.push(spec); return { ...spec, id: 1 }; });
  eq('member gone → lapse {departed}', lap.map(e => e.payload.reason), ['departed']);
  const fr = base();
  fr.story.followups = { 78: { id: 78, castId: 'cast:flatmate', from: now - HOUR, to: now + DAY, status: 'open' } };
  fr.story.controls.fate.social = 'frozen';
  const lf = [];
  followupItems(fr, now, { world, rngFor })[0]?.run((spec) => { lf.push(spec); return { ...spec, id: 1 }; });
  eq('social frozen → lapse {frozen}', lf.map(e => e.payload.reason), ['frozen']);
}

report();
await stopLife();
