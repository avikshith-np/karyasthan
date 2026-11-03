// 016 scenes — the dashboard side, against a stub story facade in the real
// engine's shape (story.sceneDetail / sceneRegenerate / sceneEditText; the engine
// itself is covered by 71–73; a check here pins those names on the real facade):
//   - GET /api/arcs/scenes/:id: off shape while life / arcs is off, 404 for an
//     unknown scene, "not available" without the facade read, the closed route
//     shape, {FRIEND} → the person's name (never the JID);
//   - POST …/regenerate and PUT …/text: readonly 403, CSRF 403, 409 while off or
//     without the facade function, 400 on bad ids / long or JID text, StoryError
//     codes, audit rows with ids / lengths only (never the hint or the text),
//     regenerate 2/min with no loopback exemption;
//   - the Director's scene.tone kind and outcome {tone}: shape checks;
//   - CHANGES text for scene kinds (story/changeText.js);
//   - the HOW IT WENT panel, the Day chip, the cast scene list and the OUTCOMES
//     tone box render through html`` (escaped), and the guides cover them.
// Scratch DB, no network, no model.
import { PROJECT_ROOT, setupScratchDb, section, check, eq, report, setSkills } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'scenes-ui-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4), DASHBOARD_COOKIE_SECRET: 'scenes-ui-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.0/8,::1/128', DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false', IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
  LIFE_ENABLED: 'false', ARCS_ENABLED: 'false', MIND_ENABLED: 'false',
});

const { db } = await setupScratchDb();
globalThis.fetch = async () => { throw new Error('network is off in arcs tests'); };

const { config } = await import('../../src/utils/config.js');
const arcsRoutes = await import('../../src/dashboard/routes/arcs.js');
const dirRoutes = await import('../../src/dashboard/routes/director.js');
const { startDashboard } = await import('../../src/dashboard/server.js');

class StubError extends Error {
  constructor(code, reason = null) { super(`story: ${code} SECRET-MESSAGE`); this.code = code; this.reason = reason; }
}
const SECRET = 'SECRET-SCENE-TEXT';
const FRIEND_JID = '155500000301@s.whatsapp.net';
db.prepare("INSERT INTO people (jid, phone, push_name) VALUES (?, '155500000301', 'Neha <b>')").run(FRIEND_JID);

const calls = [];
let storyOn = true;
// story.sceneDetail's shape (src/life/story/index.js): the facade already swapped {FRIEND}.
const SCENE = {
  sceneId: 7, eventId: 70, activityEventId: 60, version: 1, status: 'done', live: true, at: 1_800_000_000, endedAt: 1_800_003_600,
  kind: 'eat-out', kindWords: 'eat-out', place: 'Corner <i>Cafe</i>', with: [{ castId: 'cast:asha', name: 'Asha Varnell', pronouns: 'she/her', firstMeet: true }],
  realPerson: false, friend: null, fallback: false, excluded: false,
  mode: 'full', tier: 'mind', model: 'fake-mind', fellBack: false, text: `${SECRET} para one <script>x</script>\n\nPara two.`,
  impressions: { him: [{ castId: 'cast:asha', name: 'Asha Varnell', text: 'Funny.' }], them: [{ castId: 'cast:asha', name: 'Asha Varnell', pronouns: 'she/her', text: 'Kind.' }] },
  topics: ['books', 'rain'], highlight: 'The mix-up.', awkward: 'Forgot her name.', chemistry: 0.72, ending: 'swapped_numbers', endingWords: 'swapped numbers',
  outcome: 'well', outcomeBy: 'code', tone: null, revertible: true, secretField: 'x',
  effects: [{ id: 81, type: 'relationship.changed', castId: 'cast:asha', summary: 'closeness +0.04', excluded: false }, { id: 82, type: 'scene.followup', castId: 'cast:asha', summary: 'a plan to meet again opened', excluded: false }],
  versions: [{ sceneId: 7, version: 1, status: 'done', eventId: 70, createdAt: 1 }],
};
const stub = {
  storyOn: () => storyOn,
  status: () => ({ counts: {} }),
  sceneDetail: (id) => {
    calls.push(['scene', id]);
    if (id === 7) return SCENE;
    if (id === 11) return { ...SCENE, sceneId: 11, version: 2 };
    if (id === 8) return { ...SCENE, sceneId: 8, mode: 'self_only', realPerson: true, friend: 'Neha <b>', text: 'He met Neha <b> at the park.', impressions: null, chemistry: null, effects: [] };
    return null;
  },
  sceneRegenerate: async (id, { tone, outcome, by }) => {
    calls.push(['regen', id, tone, by, outcome]);
    if (id === 404) throw new StubError('not_found', 'scene');
    if (id === 409) throw new StubError('refused', 'regen_cap');
    if (id === 410) return { status: 'refused', reason: 'regen_cap' };
    if (id === 411) return { status: 'failed', reason: 'model_failed', sceneId: 411 };
    return { status: 'done', sceneId: 11, eventId: 71 };
  },
  sceneEditText: (id, text, { by }) => {
    calls.push(['edit', id, text.length, by]);
    if (id === 400) throw new StubError('invalid', 'real_person_name');
    // This stub scene is a short one. The route allows up to the long cap; the facade keeps 1200 here.
    if (text.length > 1200) throw new StubError('invalid', 'too_long');
    return { ok: true, sceneId: id, length: text.length };
  },
  director: {
    preview: async (action) => { calls.push(['preview', action]); return { previewId: crypto.randomUUID(), fingerprint: 'f'.repeat(64), events: [], diff: [], warnings: [], refusals: [] }; },
  },
};

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'scenes-ui-csrf-token';
const app = await startDashboard({ getSock: () => null });
async function req(method, url, { body, csrf = true, ip = '127.0.0.1' } = {}) {
  const headers = { authorization: AUTH };
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, remoteAddress: ip, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json };
}
const audits = (action) => db.prepare('SELECT target, payload_json FROM dashboard_audit WHERE action = ? ORDER BY id').all(action);
const setRO = (v) => { config.dashboard.readOnly = v; };

try {
  section('off');
  {
    const r = await req('GET', '/api/arcs/scenes/7');
    check('GET while life is stopped → 200 off shape', r.status === 200 && r.json?.enabled === false && r.json?.scene === null, JSON.stringify(r.json));
    eq('GET a bad id → 400', (await req('GET', '/api/arcs/scenes/abc')).status, 400);
    setRO(true);
    eq('readonly → regenerate 403', (await req('POST', '/api/arcs/scenes/7/regenerate', { body: {} })).status, 403);
    eq('readonly → edit 403', (await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'x' } })).status, 403);
    setRO(false);
    eq('no CSRF → regenerate 403', (await req('POST', '/api/arcs/scenes/7/regenerate', { body: {}, csrf: false, ip: '127.0.0.30' })).status, 403);
    const off = await req('POST', '/api/arcs/scenes/7/regenerate', { body: {}, ip: '127.0.0.31' });
    check('regenerate while life is stopped → 409', off.status === 409 && off.json?.error === 'life is not running', JSON.stringify(off.json));
    const offE = await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'x' }, ip: '127.0.0.31' });
    check('edit while life is stopped → 409', offE.status === 409);
    arcsRoutes.__setStoryForTest(stub, { lifeRunning: () => true });
    await setSkills({ life: true, arcs: false });
    check('arcs skill off → GET off shape, writes 409', (await req('GET', '/api/arcs/scenes/7')).json?.enabled === false
      && (await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'x' }, ip: '127.0.0.32' })).json?.error === 'arcs is off');
    await setSkills({ life: true, arcs: true });
    check('no facade call was made while off', !calls.some((c) => c[0] === 'regen' || c[0] === 'edit'));
  }

  section('read');
  {
    const r = await req('GET', '/api/arcs/scenes/7');
    const s = r.json?.scene;
    check('GET → the scene', r.status === 200 && r.json?.enabled === true && s?.id === 7 && s.eventId === 70 && s.ending === 'swapped_numbers' && s.chemistry === 0.72);
    check('…closed shape (an unknown facade field is not passed on)', s && !('secretField' in s) && Array.isArray(s.effects) && s.effects.length === 2 && s.effects[1] === 'a plan to meet again opened');
    check('…impressions with names and pronouns', s.impressions?.them?.[0]?.pronouns === 'she/her' && s.impressions.him[0].text === 'Funny.');
    eq('unknown scene → 404', (await req('GET', '/api/arcs/scenes/99')).status, 404);
    const f = (await req('GET', '/api/arcs/scenes/8')).json?.scene;
    check('a real person: {FRIEND} → their name in the operator view, no JID in the reply',
      f?.text === 'He met Neha <b> at the park.' && f.realPerson === true && !JSON.stringify(f).includes('155500000301'), JSON.stringify(f));
    const noRead = { ...stub, sceneDetail: undefined };
    arcsRoutes.__setStoryForTest(noRead, { lifeRunning: () => true });
    const na = await req('GET', '/api/arcs/scenes/7');
    check('a facade without sceneDetail() → 200 available:false', na.status === 200 && na.json?.available === false && na.json?.scene === null);
    arcsRoutes.__setStoryForTest(stub, { lifeRunning: () => true });
  }

  section('regenerate / edit');
  {
    setRO(false);
    eq('R23: a tone without its outcome word → 400 outcome_required', (await req('POST', '/api/arcs/scenes/7/regenerate', { body: { tone: 'they hit it off' }, ip: '127.0.0.39' })).json?.error, 'outcome_required');
    eq('…a bad outcome word → 400', (await req('POST', '/api/arcs/scenes/7/regenerate', { body: { tone: 'they hit it off', outcome: 'great' }, ip: '127.0.0.38' })).status, 400);
    const r = await req('POST', '/api/arcs/scenes/7/regenerate', { body: { tone: `${SECRET} they hit it off`, outcome: 'well' }, ip: '127.0.0.40' });
    check('regenerate → ok with the new version', r.status === 200 && r.json?.version === 2 && r.json?.sceneId === 11, JSON.stringify(r.json));
    check('…the facade got the tone, its outcome and the actor', calls.some((c) => c[0] === 'regen' && c[1] === 7 && c[2] === `${SECRET} they hit it off` && c[3] && c[4] === 'well'));
    const a = audits('arcs.scene.regenerate');
    check('…audited with ids, version and the hint length only', a.length === 1 && a[0].target === '7' && !a[0].payload_json.includes(SECRET) && /"version":2/.test(a[0].payload_json) && /"toneChars":/.test(a[0].payload_json), a[0]?.payload_json);
    eq('tone over 120 chars → 400', (await req('POST', '/api/arcs/scenes/7/regenerate', { body: { tone: 'x'.repeat(121), outcome: 'fine' }, ip: '127.0.0.41' })).status, 400);
    eq('tone with a JID → 400', (await req('POST', '/api/arcs/scenes/7/regenerate', { body: { tone: 'like 155500000301@s.whatsapp.net', outcome: 'fine' }, ip: '127.0.0.42' })).status, 400);
    const nf = await req('POST', '/api/arcs/scenes/404/regenerate', { body: {}, ip: '127.0.0.43' });
    check('StoryError not_found → 404 (no message echoed)', nf.status === 404 && !JSON.stringify(nf.json).includes('SECRET-MESSAGE'));
    const cap = await req('POST', '/api/arcs/scenes/409/regenerate', { body: {}, ip: '127.0.0.44' });
    check('StoryError refused regen_cap → 409 regen_cap', cap.status === 409 && cap.json?.error === 'regen_cap', JSON.stringify(cap.json));
    const rf = await req('POST', '/api/arcs/scenes/410/regenerate', { body: {}, ip: '127.0.0.46' });
    check('a refusal in the result (regen_cap) → 409 with its code, not ok', rf.status === 409 && rf.json?.error === 'regen_cap', JSON.stringify(rf.json));
    const fl = await req('POST', '/api/arcs/scenes/411/regenerate', { body: {}, ip: '127.0.0.46' });
    check('a failed rewrite (old version kept) → 409 model_failed', fl.status === 409 && fl.json?.error === 'model_failed', JSON.stringify(fl.json));
    eq('…neither is audited', audits('arcs.scene.regenerate').length, 1);
    const lim = [];
    for (let i = 0; i < 3; i++) lim.push((await req('POST', '/api/arcs/scenes/7/regenerate', { body: {}, ip: '127.0.0.45' })).status);
    eq('regenerate is 2/min per peer (loopback not exempt)', lim, [200, 200, 429]);

    const e = await req('PUT', '/api/arcs/scenes/7/text', { body: { text: `${SECRET} a new narration.` }, ip: '127.0.0.50' });
    check('edit → ok', e.status === 200 && e.json?.ok === true);
    const ea = audits('arcs.scene.edit');
    check('…audited with the length only', ea.length === 1 && !ea[0].payload_json.includes(SECRET) && /"length":\d+/.test(ea[0].payload_json));
    eq('edit with no text → 400', (await req('PUT', '/api/arcs/scenes/7/text', { body: { text: ' ' }, ip: '127.0.0.51' })).status, 400);
    eq('edit over 1200 chars on a short scene → 400', (await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'y'.repeat(1201) }, ip: '127.0.0.51' })).status, 400);
    eq('edit over the long cap → 400 at the route', (await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'y'.repeat(2401) }, ip: '127.0.0.58' })).status, 400);
    eq('edit with a JID → 400', (await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'at 155500000301@s.whatsapp.net' }, ip: '127.0.0.51' })).status, 400);
    const ok1200 = await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'z'.repeat(1200) }, ip: '127.0.0.52' });
    eq('edit of exactly 1200 chars passes the route (the body cap of 400 doesn\'t apply)', ok1200.status, 200);
    const rn = await req('PUT', '/api/arcs/scenes/400/text', { body: { text: 'Someone Real came.' }, ip: '127.0.0.53' });
    check('StoryError invalid → 400 with its reason', rn.status === 400 && rn.json?.error === 'real_person_name');
    arcsRoutes.__setStoryForTest({ ...stub, sceneRegenerate: undefined, sceneEditText: undefined }, { lifeRunning: () => true });
    const na1 = await req('POST', '/api/arcs/scenes/7/regenerate', { body: {}, ip: '127.0.0.54' });
    const na2 = await req('PUT', '/api/arcs/scenes/7/text', { body: { text: 'x' }, ip: '127.0.0.54' });
    check('no facade function → 409 not_available (never 500)', na1.status === 409 && na1.json?.error === 'not_available' && na2.status === 409 && na2.json?.error === 'not_available');
    arcsRoutes.__setStoryForTest(stub, { lifeRunning: () => true });
    setRO(true);
  }

  section('the real facade has the names the routes call');
  {
    const story = await import('../../src/life/story/index.js');
    const life = await import('../../src/life/index.js');
    check('story: sceneDetail / sceneRegenerate / sceneEditText / godView / castDetail; life: publicScenes',
      ['sceneDetail', 'sceneRegenerate', 'sceneEditText', 'godView', 'castDetail'].every((k) => typeof story[k] === 'function') && typeof life.publicScenes === 'function');
    const pv = await import('../../src/life/publicView.js');
    const st = { story: { scenes: {} }, places: new Map([['p1', { id: 'p1', name: 'X', kind: 'cafe', venue: { area: 'Old Town' } }]]), cast: new Map(), self: {} };
    const raw = pv.buildPublicRaw({ state: st, world: {}, at: 1_800_000_000, tz: 'UTC', events: () => [], getEvent: () => null, isOut: () => false });
    check('publicView: raw.scenes is an array and places carry venue / area', Array.isArray(raw.scenes) && raw.places[0].venue === true && raw.places[0].area === 'Old Town');
  }

  section('director: scene.tone and outcome {tone}');
  {
    const ap = dirRoutes.actionProblem;
    eq('scene.tone with a decision, a hint and its outcome word → fine', ap({ kind: 'scene.tone', decisionId: 5, tone: 'they hit it off', outcome: 'well' }), null);
    eq('R23: scene.tone without its outcome word → bad_outcome', ap({ kind: 'scene.tone', decisionId: 5, tone: 'they hit it off' }), 'bad_outcome');
    eq('scene.tone without a decision → bad_decisionId', ap({ kind: 'scene.tone', tone: 'x' }), 'bad_decisionId');
    eq('scene.tone without a hint → bad_tone', ap({ kind: 'scene.tone', decisionId: 5 }), 'bad_tone');
    eq('scene.tone over 120 chars → bad_tone', ap({ kind: 'scene.tone', decisionId: 5, tone: 'x'.repeat(121) }), 'bad_tone');
    eq('scene.tone blank → bad_tone', ap({ kind: 'scene.tone', decisionId: 5, tone: '   ' }), 'bad_tone');
    eq('outcome with a tone → fine', ap({ kind: 'outcome', decisionId: 5, outcome: 'well', tone: 'awkward but sweet' }), null);
    eq('outcome with a bad tone → bad_tone', ap({ kind: 'outcome', decisionId: 5, outcome: 'well', tone: 7 }), 'bad_tone');
    eq('a tone hint naming a JID → jid_in_text', ap({ kind: 'scene.tone', decisionId: 5, tone: 'with 155500000301@s.whatsapp.net', outcome: 'well' }), 'jid_in_text');
    eq('a text with tone naughty passes the route', ap({ kind: 'text', castId: 'cast:asha', gist: 'say goodnight', tone: 'naughty' }), null);
    eq('a text with an unknown tone is bad_tone', ap({ kind: 'text', castId: 'cast:asha', gist: 'say goodnight', tone: 'filthy' }), 'bad_tone');
    setRO(false);
    const pv = await req('POST', '/api/director/preview', { body: { action: { kind: 'scene.tone', decisionId: 5, tone: 'they hit it off', outcome: 'well' } }, ip: '127.0.0.60' });
    check('preview of scene.tone reaches the planner', pv.status === 200 && calls.some((c) => c[0] === 'preview' && c[1]?.kind === 'scene.tone'), `${pv.status} ${JSON.stringify(pv.json)?.slice(0, 120)}`);
    setRO(true);
  }

  section('CHANGES text');
  {
    const { describeChange, KIND_HEADS } = await import('../../src/life/story/changeText.js');
    const state = { cast: new Map([['cast:asha', { name: 'Asha' }]]), decisions: new Map([[5, { options: [{ id: 'go', label: 'Dinner with Asha' }] }]]), places: new Map() };
    const t = describeChange({ action: { payload: { kind: 'scene.tone' }, at: 1 }, parts: [{ id: 2, type: 'scene.tone_set', payload: { decisionId: 5, tone: 'they hit it off' } }], state, tz: 'UTC' });
    eq('scene.tone in words', t, "Scene tone · tone for Dinner with Asha: 'they hit it off'");
    const o = describeChange({ action: { payload: { kind: 'outcome' }, at: 1 }, parts: [{ id: 2, type: 'outcome.set', payload: { decisionId: 5, outcome: 'well' } }, { id: 3, type: 'scene.tone_set', payload: { decisionId: 5, tone: 'awkward but sweet' } }], state, tz: 'UTC' });
    check('outcome with a tone says both', o.includes('went well') && o.includes("'awkward but sweet'"), o);
    const chat = describeChange({ action: { payload: { kind: 'scene.tone' }, at: 1 }, parts: [{ id: 2, type: 'scene.tone_set', payload: { decisionId: 6, tone: 'x' } }], state: { ...state, decisions: new Map([[6, { adopted: true, options: [{ id: 'go', label: 'SECRET chat plan' }] }]]) }, tz: 'UTC' });
    check('a chat plan is never named', chat.includes('a plan from a chat') && !chat.includes('SECRET'), chat);
    const sp = describeChange({ action: { payload: { kind: 'scene.regenerate' }, at: 1 }, parts: [{ id: 2, type: 'scene.regenerated', payload: {} }], effects: [], state, tz: 'UTC' });
    check('heads for scene.tone / scene.regenerate', KIND_HEADS['scene.tone'] === 'Scene tone' && sp.startsWith('Scene rewritten'), sp);
  }

  section('frontend');
  {
    const PUBLIC = path.join(PROJECT_ROOT, 'src/dashboard/public');
    const imp = (f) => import(pathToFileURL(path.join(PUBLIC, 'js', f)).href);
    const src = (f) => fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf-8');
    const { renderToString: rts } = await imp('core/dom.js');
    const sp = await imp('components/scene-panel.js');
    const out = (await req('GET', '/api/arcs/scenes/7')).json.scene;
    const v = rts(sp.sceneView(out, { ro: false }));
    check('panel: narration paragraphs escaped', v.includes('&lt;script&gt;') && !v.includes('<script>') && (v.match(/<p>/g) || []).length === 2);
    check('panel: HE THOUGHT / SHE THOUGHT, TALKED ABOUT chips, HIGHLIGHT, AWKWARD, CHEMISTRY, ENDING, WHAT CHANGED',
      ['HE THOUGHT', 'SHE THOUGHT', 'TALKED ABOUT', 'HIGHLIGHT', 'AWKWARD', 'CHEMISTRY', 'SWAPPED NUMBERS', 'WHAT CHANGED', 'closeness +0.04', 'written by the mind'].every((w) => v.includes(w)));
    check('panel: REGENERATE / EDIT TEXT / REVERT THIS CHANGE enabled in write mode', ['REGENERATE', 'EDIT TEXT', 'REVERT THIS CHANGE'].every((w) => v.includes(w)) && !/data-scene-act="regen" disabled/.test(v));
    const vr = rts(sp.sceneView(out, { ro: true }));
    check('panel: buttons disabled when read-only', /data-scene-act="regen" disabled/.test(vr) && /data-scene-act="edit" disabled/.test(vr) && /data-scene-act="revert" disabled/.test(vr));
    const vx = rts(sp.sceneView({ ...out, excluded: true }, { ro: false }));
    check('panel: a reverted scene says so and offers nothing', vx.includes('REVERTED') && /data-scene-act="revert" disabled/.test(vx));
    check('panel: the owner\'s edit wins over the model text', rts(sp.sceneView({ ...out, editedText: 'Owner words.' }, {})).includes('Owner words.') && rts(sp.sceneView({ ...out, editedText: 'Owner words.' }, {})).includes('EDITED'));
    const vf = rts(sp.sceneView((await req('GET', '/api/arcs/scenes/8')).json.scene, {}));
    check('panel: a real person\'s scene says it is his side only and changes nothing', vf.includes('his side only') && vf.includes('changes nothing') && vf.includes('Neha &lt;b&gt;'));
    const vg = rts(sp.sceneView(out, { regen: true, ro: false }));
    check('panel: REGENERATE shows the tone box with chips', vg.includes('id="sceneTone"') && sp.TONE_CHIPS.every((c) => vg.includes(c)));
    check('panel: thought labels (pronouns, else the name; several people → by name)', sp.thoughtLabel('them', { pronouns: 'she/her' }, false) === 'SHE THOUGHT'
      && sp.thoughtLabel('them', { name: 'Ravi Das' }, false) === 'RAVI THOUGHT' && sp.thoughtLabel('him', { name: 'Ravi Das' }, true) === 'HE THOUGHT OF RAVI');
    check('panel: no raw HTML sink, no raw(), only the scene/revert routes', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\braw\(/.test(src('components/scene-panel.js'))
      && src('components/scene-panel.js').includes('/api/arcs/scenes/') && src('components/scene-panel.js').includes('/api/life/events/'));
    const day = await imp('pages/life-day.js');
    const chip = rts(day.sceneChip({ row: 'span', scene: { sceneId: 7, ending: 'plan_to_meet' } }));
    check('Day: a past span with a scene gets ❖ HOW IT WENT with the ending', chip.includes('HOW IT WENT') && chip.includes('PLAN TO MEET AGAIN') && chip.includes('data-scene="7"'));
    check('Day: a planned outing with someone links to the Director tone box; nothing else gets a chip',
      rts(day.sceneChip({ row: 'span', future: true, decisionId: 4, with: ['Asha'] })).includes('#life/director') && rts(day.sceneChip({ row: 'span' })) === '');
    check('Day: the panel is mounted under WHY and the page keeps one raw() (its shell)', src('pages/life-day.js').includes('mountScenePanel(ctx') && (src('pages/life-day.js').match(/raw\(/g) || []).length === 1
      && src('pages/life-day.js').includes('data-guide="scene"'));
    const cm = await imp('pages/life-cast-member.js');
    const list = rts(cm.scenesView([{ sceneId: 7, at: 1_800_000_000, place: 'Cafe <b>', ending: 'swapped_numbers', chemistry: 0.7, highlight: 'Omelette <i>', firstMeet: true }, { sceneId: 6, excluded: true }]));
    check('Cast: the scene history with READ THE SCENE, escaped, reverted marked', list.includes('READ THE SCENE') && list.includes('FIRST MEETING') && list.includes('Omelette &lt;i&gt;') && list.includes('REVERTED'));
    check('Cast: an empty history says so', rts(cm.scenesView([])).includes('NO SCENES YET'));
    const god = await imp('pages/life-director-god.js');
    check('Director: an outing (social/family with go) takes a tone hint; others do not',
      god.toneable({ category: 'social', options: [{ id: 'go' }] }) && god.toneable({ category: 'family', options: [{ id: 'go' }, { id: 'stay' }] })
      && !god.toneable({ category: 'career', options: [{ id: 'go' }] }) && !god.toneable({ category: 'social', options: [{ id: 'accept' }] }));
    const gs = src('pages/life-director-god.js');
    check('Director: TONE previews scene.tone; SET sends the tone with the outcome; chips fill the box',
      gs.includes("kind: 'scene.tone'") && /kind: 'outcome'[^\n]*tone/.test(gs) && gs.includes('data-tone-chip') && gs.includes('TONE HINT (OPTIONAL)'));
    const { GUIDES } = await imp('guides/index.js');
    const g = async (k) => (await GUIDES[k]()).default;
    const gDay = await g('life/day');
    const gCast = await g('life/cast/member');
    const gDir = JSON.stringify(await g('life/director'));
    check('guides: Day (scene section, REGENERATE / EDIT TEXT / REVERT THIS CHANGE, the read-only exception)',
      gDay.sections.some((x) => x.id === 'scene') && JSON.stringify(gDay).includes('EDIT TEXT') && JSON.stringify(gDay.intro).includes('HOW IT WENT'));
    check('guides: Cast member (scenes section backing its "?" buttons)', gCast.sections.some((x) => x.id === 'scenes')
      && [...src('pages/life-cast-member.js').matchAll(/data-guide="([a-z-]+)"/g)].every((m) => gCast.sections.some((x) => x.id === m[1])));
    check('guides: Director (tone hint in OUTCOMES, its CHANGES line)', gDir.includes('TONE HINT') && gDir.includes('Scene tone'));
  }
} catch (err) {
  check(`no harness error (${err?.message})`, false, err?.stack);
} finally {
  arcsRoutes.__setStoryForTest(null);
  setRO(true);
  await app.close().catch(() => {});
}
report();
