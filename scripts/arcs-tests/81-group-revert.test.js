// 017 UNDO ALL OF THIS: a Tell-the-story bundle applies as several
// `director.action`s sharing one fingerprint and apply time
// (eventLog.directorGroup). `life.revertChangePreview / revertChange(id,
// {group:true})` take every part of that apply in ONE transaction — refused as a
// whole when any part is past its window — and the folded world is back to
// before the apply; a single part still reverts alone; godView().changes marks
// the parts with a shared groupId; the route takes `group` and audits it.
// Example world, fake clock, stubbed models, no network.
import { PROJECT_ROOT, section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, setSkills, HOUR } from './_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'group-revert-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4), DASHBOARD_COOKIE_SECRET: 'group-revert-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128', DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '', JEV_API_KEY: '',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false', IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
});
const { db } = await setupScratchDb();
const { config } = await import('../../src/utils/config.js');
const { startDashboard } = await import('../../src/dashboard/server.js');
const { directorGroup, getEvent } = await import('../../src/life/eventLog.js');

const { life, clock } = await bootLife();
await simulateHours(30);               // Wed, mid-morning
const story = await import('../../src/life/story/index.js');
const D = story.director;
const S = () => life.getState();

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'group-revert-csrf-token';
const app = await startDashboard({ getSock: () => null });
async function req(method, url, { body, csrf = true } = {}) {
  const headers = { authorization: AUTH };
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let j = null;
  try { j = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json: j };
}
const audits = (action) => db.prepare('SELECT payload_json FROM dashboard_audit WHERE action = ? ORDER BY id').all(action).map(r => JSON.parse(r.payload_json));

async function applyBundle(actions) {
  const pv = await D.preview({ kind: 'bundle', actions: actions.map(a => ({ ...a, source: 'prompt' })) }, { source: 'prompt' });
  const res = await D.apply(pv.previewId, pv.fingerprint);
  const ids = res.eventIds.map(getEvent).filter(e => e.type === 'director.action').map(e => e.id);
  return { pv, res, ids };
}
// What the owner sees of his world: members, decisions, beats, weather windows.
const worldView = () => JSON.stringify({
  cast: [...S().cast.keys()].sort(),
  decisions: [...S().decisions.values()].filter(d => d.status === 'open' || d.status === 'committed').map(d => [d.id, d.status]).sort(),
  beats: Object.fromEntries(Object.entries(S().story.castLife ?? {}).map(([k, v]) => [k, v?.lastBeat ?? null])),
  windows: (S().weatherWindows ?? []).map(w => w.id ?? w.eventId),
});
const evening = () => clock.now() + 30 * HOUR;
const outing = () => ({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', castIds: ['cast:flatmate'],
  newCast: { name: 'Ivy Marr', relation: 'acquaintance' }, startAt: evening(), minutes: 90, label: 'dinner with a new friend' });
const beat = (castId, text) => ({ kind: 'scene', shape: 'cast.beat', castId, beatKind: 'status', text });
const rain = () => ({ kind: 'weather', weatherKind: 'rain', intensity: 0.6, from: clock.now() + 20 * HOUR, to: clock.now() + 23 * HOUR });

try {
  config.dashboard.readOnly = false;
  await setSkills({ arcs: true });

  section('a three-part bundle: siblings, groupId, UNDO ALL restores the world');
  {
    const single = await D.preview({ kind: 'quick', button: 'tired' });
    const singleRes = await D.apply(single.previewId, single.fingerprint);
    const before = worldView();
    const { ids } = await applyBundle([outing(), beat('cast:flatmate', 'reading a lot'), rain()]);
    eq('three director.actions', ids.length, 3);
    eq('directorGroup from the middle part → all three', directorGroup(getEvent(ids[1])).map(e => e.id), ids);
    eq('a single change is its own group', directorGroup(getEvent(singleRes.actionEventId ?? singleRes.eventIds[0])).length, 1);
    const changes = story.godView().changes;
    eq('godView: the parts share the first part\'s id as groupId', ids.map(id => changes.find(c => c.id === id)?.groupId), [ids[0], ids[0], ids[0]]);
    check('…a single change has none', changes.filter(c => !ids.includes(c.id)).every(c => c.groupId === null), JSON.stringify(changes));
    check('the bundle changed his world', worldView() !== before);

    eq('route: a non-boolean group → 400', (await req('POST', '/api/director/revert-change', { body: { actionEventId: ids[1], group: 'yes' } })).status, 400);
    const pv = await req('POST', '/api/director/revert-change', { body: { actionEventId: ids[1], group: true } });
    eq('route preview: 200, group, every part', [pv.status, pv.json?.group, pv.json?.actionEventIds, pv.json?.parts?.length], [200, true, ids, 3]);
    eq('…no refusals', pv.json?.refusals, []);
    const one = await req('POST', '/api/director/revert-change', { body: { actionEventId: ids[1] } });
    check('without group: only that part, another fingerprint', one.json?.group === undefined && one.json?.fingerprint !== pv.json?.fingerprint);
    const stale = await req('POST', '/api/director/revert-change', { body: { actionEventId: ids[1], group: true, fingerprint: one.json?.fingerprint } });
    eq('the single-part fingerprint is stale for the group → 409', [stale.status, stale.json?.error], [409, 'stale']);
    const done = await req('POST', '/api/director/revert-change', { body: { actionEventId: ids[1], group: true, fingerprint: pv.json?.fingerprint } });
    eq('reverted as one: ok, group, all three changes', [done.status, done.json?.ok, done.json?.group, done.json?.actionEventIds], [200, true, true, ids]);
    eq('his world is back to before the apply', worldView(), before);
    const a = audits('director.revert_change').at(-1);
    check('audited with group and the change ids', a?.group === true && JSON.stringify(a?.actionEventIds) === JSON.stringify(ids), JSON.stringify(a));
    const again = life.revertChangePreview(ids[0], { group: true });
    check('a second UNDO ALL has nothing left', again.already === true, JSON.stringify(again));
  }

  section('one part of a bundle still reverts alone');
  {
    const siblingBefore = S().story.castLife['cast:sibling']?.status ?? null;
    const { ids } = await applyBundle([beat('cast:flatmate', 'learning to cook'), beat('cast:sibling', 'busy with exams')]);
    const p = life.revertChangePreview(ids[1]);
    life.revertChange(ids[1], { fingerprint: p.fingerprint });
    eq('the sibling\'s beat is gone (status as before), the flatmate\'s stays',
      [S().story.castLife['cast:sibling']?.status ?? null, S().story.castLife['cast:flatmate']?.status],
      [siblingBefore, 'learning to cook']);
    const g = life.revertChangePreview(ids[0], { group: true });
    eq('the group preview now covers only what is left', g.targets.length > 0 && g.parts.find(x => x.actionEventId === ids[1])?.targets.length, 0);
  }

  section('a part past its window refuses the whole group');
  {
    const { ids } = await applyBundle([rain(), { kind: 'career', change: 'salary', salary: 91000 }]);
    const before = worldView();
    const g = life.revertChangePreview(ids[0], { group: true });
    check('the applied career change is refused already_happened', g.refusals.some(x => x.type === 'career.set' && x.reason === 'already_happened'), JSON.stringify(g.refusals));
    const r = await req('POST', '/api/director/revert-change', { body: { actionEventId: ids[0], group: true, fingerprint: g.fingerprint } });
    eq('route: 409 refused with the refusals', [r.status, r.json?.error, r.json?.refusals?.some(x => x.type === 'career.set')], [409, 'refused', true]);
    eq('nothing was reverted', worldView(), before);
    const w = life.revertChangePreview(ids[0]);
    life.revertChange(ids[0], { fingerprint: w.fingerprint });
    check('the weather part alone still reverts', worldView() !== before && !w.refusals.length);
  }
} finally {
  try { await app.close(); } catch { /* ignore */ }
  await stopLife();
}
report();
