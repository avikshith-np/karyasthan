// One person, one stream of attention (owner 2026-11-02: while one of them was at his flat at night he
// was texting another "full on"). While he is with someone in person his own texts wait until they
// part; an owner-started chat still goes out — a deliberate interruption that costs with the
// people there (tension; with a romance partner passion, and a jealous step for a warm text to
// someone else), capped per day and caused by the text. The scene sheet lists what his phone did
// during the outing (fictional cast by name, his real chats as counts only).
import { TEST_ZONE } from '../test-zone.js';
import { section, check, eq, report } from './_helpers.js';
import {
  attentionEffects, presentWith, waitFor, ATTENTION_STEP, ATTENTION_JEALOUS, ATTENTION_DAY_MAX,
} from '../../src/life/story/phone/worker.js';
import { buildFactSheet } from '../../src/life/story/scenes/facts.js';
import { renderUser, SCENE_CHARTER } from '../../src/life/story/scenes/charter.js';

const T = 1793560000;
const PARTNER = 'cast:a';
const OTHER = 'cast:b';
const FLAT = 'cast:flatmate';
function world({ withCast = [PARTNER], romance = true, paused = false, at = T } = {}) {
  return {
    at,
    cast: new Map([[PARTNER, { id: PARTNER, name: 'Ann Lee', metrics: { closeness: 0.6, trust: 0.6, tension: 0.1 } }],
      [OTHER, { id: OTHER, name: 'Bea Roy', metrics: { closeness: 0.5, trust: 0.5, tension: 0 } }],
      [FLAT, { id: FLAT, name: 'Cal Moss', relation: 'flatmate', metrics: {} }]]),
    activity: { kind: 'visit', withCast, endAt: at + 3 * 3600 },
    story: {
      romance: romance ? { arcId: 'r1', partnerId: PARTNER } : {},
      arcs: romance ? { r1: { id: 'r1', status: 'active', category: 'romance', castIds: [PARTNER], stage: 'talking' } } : {},
      relationships: { [PARTNER]: { passion: 0.5, intimacy: 0.4 } },
      ...(paused ? { controls: { paused: true } } : {}),
    },
  };
}
const out = (castId, tone = 'friendly') => [{ dir: 'out', castId, trigger: 'reply' }, { tone }];

section('who he is with');
eq('his current activity\'s company', presentWith(world()), [PARTNER]);
eq('nobody → []', presentWith(world({ withCast: [] })), []);

section('the cost of texting someone else while with her');
{
  const [e] = attentionEffects(world(), ...out(OTHER));
  eq('a plain text: tension up a step, passion down a step (she is his romance partner)', e?.payload, { castId: PARTNER, delta: { tension: ATTENTION_STEP, passion: -ATTENTION_STEP }, reason: 'attention' });
  const [w] = attentionEffects(world(), ...out(OTHER, 'flirty'));
  eq('a flirty text to someone else: a jealous step more', w?.payload?.delta?.tension, ATTENTION_STEP + ATTENTION_JEALOUS);
  const [f] = attentionEffects(world({ romance: false }), ...out(OTHER, 'flirty'));
  eq('not a romance: tension only, no jealousy', f?.payload?.delta, { tension: ATTENTION_STEP });
  eq('texting the person he is with costs nothing (those texts wait anyway)', attentionEffects(world(), ...out(PARTNER)), []);
  eq('nobody with him → nothing', attentionEffects(world({ withCast: [] }), ...out(OTHER)), []);
  eq('their texts (the buzz) cost nothing by themselves', attentionEffects(world(), { dir: 'in', castId: OTHER, trigger: 'reply' }, { tone: 'flirty' }), []);
  const capped = attentionEffects(world(), ...out(OTHER, 'flirty'), { today: { [PARTNER]: { tension: ATTENTION_DAY_MAX - 0.005, passion: ATTENTION_DAY_MAX } } });
  eq('capped per member per day', capped[0]?.payload?.delta, { tension: 0.005 });
}

section('his own texts wait while he is with someone; the owner\'s go through');
{
  const tz = TEST_ZONE;
  const at = T + 12 * 3600;   // midday: no one's night in the way
  const w0 = world({ at });
  const row = { id: 7, dir: 'out', castId: OTHER, trigger: 'reply', createdAt: at, tries: 0 };
  const w = waitFor(w0, row, at, tz, null, null);
  check('an organic turn of his waits until the visit is over', Number.isFinite(w) && w >= at + 3 * 3600, w);
  const o = waitFor(w0, row, at, tz, null, { id: 99, at });
  check('a turn in an owner-started chat is not held for company', !(Number.isFinite(o) && o >= at + 3 * 3600), o);
  const inc = waitFor(w0, { ...row, dir: 'in' }, at, tz, null, null);
  check('their side is not held by his company', !(Number.isFinite(inc) && inc >= at + 3 * 3600), inc);
}

section('the scene sees his phone');
{
  const s = world();
  const session = { mode: 'full', castIds: [PARTNER], placeId: 'place:home', startAt: T, endAt: T + 3 * 3600, minutes: 180, kind: 'visit', originKind: 'self', home: true };
  const built = buildFactSheet(s, session, {
    tz: TEST_ZONE, phoneNames: ['Bea Roy'],
    phoneDuring: ['he texted Bea Roy 9 times, mostly flirty', 'his phone kept going off with his group chats; he replied 3 times'],
  });
  const user = renderUser(built.sheet);
  check('rendered as true lines', user.includes('his phone during it (true):') && user.includes('he texted Bea Roy 9 times'), user);
  check('the other person\'s name is allowed in the scene', built.names.includes('Bea') && built.names.includes('Roy'));
  check('the charter: they notice, in proportion, and it shows in effects', /can't be fully with someone while texting/.test(SCENE_CHARTER) && /Never invent what the texts said/.test(SCENE_CHARTER));
  check('real chats stay counts only (no names in the line builder)', !/group chat [A-Z]/.test(user));
}

report();
