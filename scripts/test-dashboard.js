// Dashboard test (spec 007 US5 / SC-006). Boots startDashboard() on
// 127.0.0.1:7072 without Baileys, on a scratch DB under data/ (deleted at exit),
// with DRY_RUN=true and no provider keys. No network beyond loopback: nothing
// here calls a model (POST /api/llm/test is deliberately not exercised).
//
//   npm run test:dashboard
//
// Covers: auth (401 / cookie login / logout), every frontend module + CSS file
// served with the right type, every API the pages call on load, the multiplexed
// SSE stream (keepalive, injected event, resume, topic/stream limits; the pre-007
// per-feature aliases are gone), readonly + CSRF + audit on a write, the frontend mux (50 subscribe /
// dispose cycles → no leaked handler, ≤ 1 EventSource), the html auto-escape, the
// router's generation token, and that no persona name or hardcoded timezone
// lives in the new frontend.
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import bcrypt from 'bcryptjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'src/dashboard/public');
const SCRATCH_DB = path.join(ROOT, 'data', `k007-dash-${process.pid}.db`);
const PORT = 7072;
const USER = 'admin';
const PASS = 'test-pass';

fs.mkdirSync(path.dirname(SCRATCH_DB), { recursive: true });
Object.assign(process.env, {
  DB_PATH: SCRATCH_DB,
  DRY_RUN: 'true',
  LOG_LEVEL: 'info',
  DASHBOARD_ENABLED: 'true',
  DASHBOARD_HOST: '127.0.0.1',
  DASHBOARD_PORT: String(PORT),
  DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4),
  DASHBOARD_COOKIE_SECRET: 'test-dashboard-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128',
  DASHBOARD_READONLY: 'true',
  // No keys of any kind, and the phone is unreachable (status reads fail closed).
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '', XAI_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: '',
  IG_ADB_PATH: path.join(ROOT, 'data', 'no-such-adb'), IG_DEVICE_SERIAL: '', IG_ENABLED: 'false',
  CALLS_ENABLED: 'false',
});

// Silence the bot's JSON log lines on stdout (they still reach the dashboard ring).
if (!process.env.VERBOSE) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => (String(chunk).startsWith('{"level"') ? true : write(chunk, ...rest));
}

const { config } = await import('../src/utils/config.js');
const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
const { startDashboard } = await import('../src/dashboard/server.js');
const { emitDashboardEvent } = await import('../src/dashboard/events.js');
const { logger } = await import('../src/utils/logger.js');
const { openStreams, MAX_STREAMS_PER_IP } = await import('../src/dashboard/sse.js');

runMigrations();

// A group, two members and an owner note, so the group/person detail pages'
// APIs have something to return (spec 006 pages ported in 007 Phase 12).
const SEED_GROUP = '120363000000000077@g.us';
const SEED_PERSON = '155500000077@s.whatsapp.net';
const SEED_OTHER = '155500000078@s.whatsapp.net';
{
  const d = getDb();
  d.prepare("INSERT INTO groups (jid, name, vibe, joined_at, last_active) VALUES (?, 'Test group', 'chill · banter', unixepoch(), unixepoch())").run(SEED_GROUP);
  for (const [jid, name] of [[SEED_PERSON, 'Asha'], [SEED_OTHER, 'Biju']]) {
    d.prepare('INSERT INTO people (jid, phone, push_name) VALUES (?, ?, ?)').run(jid, jid.split('@')[0], name);
    d.prepare('INSERT INTO group_members (group_jid, person_jid) VALUES (?, ?)').run(SEED_GROUP, jid);
  }
}

// ── harness ──────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
const eq2 = (name, got, want) => check(name, got === want, `got ${got}`);
function check(name, ok, detail = '') {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app = null;
async function cleanup() {
  try { await app?.close(); } catch {}
  try { closeDb(); } catch {}
  for (const f of [SCRATCH_DB, `${SCRATCH_DB}-wal`, `${SCRATCH_DB}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
process.on('uncaughtException', async (err) => {
  console.error('FATAL', err);
  await cleanup();
  process.exit(1);
});

const jar = {};
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorbCookies(res) {
  for (const line of [].concat(res.headers['set-cookie'] || [])) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a) || /max-age=0\b/i.test(a.trim()));
    if (expired || value === '') delete jar[name]; else jar[name] = value;
  }
}

function request(method, urlPath, { body, headers = {}, auth = false, cookies = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (cookies && Object.keys(jar).length) h.Cookie = cookieHeader();
    if (auth) h.Authorization = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, res });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// An SSE client that keeps the connection open and collects parsed frames.
function openSse(urlPath, { headers = {}, cookies = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Accept: 'text/event-stream', ...headers };
    if (cookies && Object.keys(jar).length) h.Cookie = cookieHeader();
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: urlPath, headers: h }, (res) => {
      const s = { status: res.statusCode, headers: res.headers, frames: [], comments: 0, req, res, buf: '', body: '' };
      if (res.statusCode !== 200) {
        res.on('data', (c) => { s.body += c; });
        res.on('end', () => resolve(s));
        return;
      }
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        s.buf += chunk;
        let idx;
        while ((idx = s.buf.indexOf('\n\n')) >= 0) {
          const block = s.buf.slice(0, idx);
          s.buf = s.buf.slice(idx + 2);
          const frame = { event: 'message', id: null, data: '' };
          let any = false;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) { s.comments++; continue; }
            const c = line.indexOf(':');
            const k = c < 0 ? line : line.slice(0, c);
            const v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (k === 'event') { frame.event = v; any = true; }
            else if (k === 'id') { frame.id = v; any = true; }
            else if (k === 'data') { frame.data += v; any = true; }
          }
          if (any) {
            try { frame.json = JSON.parse(frame.data); } catch {}
            s.frames.push(frame);
          }
        }
      });
      resolve(s);
    });
    req.on('error', reject);
    req.end();
  });
}
const closeSse = (s) => { try { s.req.destroy(); } catch {} try { s.res.destroy(); } catch {} };
async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
}

// ── boot ─────────────────────────────────────────────────────────────────────
const fakeSock = { user: null };
app = await startDashboard({ getSock: () => fakeSock });
check('dashboard boots on 127.0.0.1:7072', !!app);
if (!app) { await cleanup(); process.exit(1); }

try {
  // ── auth ───────────────────────────────────────────────────────────────────
  {
    const r = await request('GET', '/api/status', { cookies: false });
    check('unauthenticated /api/status → 401', r.status === 401, `got ${r.status}`);
    const s = await openSse('/api/stream?topics=logs', { cookies: false });
    check('unauthenticated /api/stream → 401', s.status === 401, `got ${s.status}`);
    const day = await request('GET', '/api/life/day', { cookies: false });
    check('unauthenticated /api/life/day → 401', day.status === 401, `got ${day.status}`);
    closeSse(s);
    const login = await request('POST', '/api/login', { auth: true, cookies: false });
    absorbCookies(login);
    check('login → 200 + session + csrf cookies', login.status === 200 && !!jar.dash_session && !!jar.csrf_token);
    const st = await request('GET', '/api/status');
    check('cookie session → /api/status 200', st.status === 200, `got ${st.status}`);
    const p = st.json?.persona;
    check('/api/status has persona {name, displayName}', !!p && typeof p.name === 'string' && p.name.length > 0 && typeof p.displayName === 'string');
    check('/api/status has timezone', st.json?.timezone === config.timezone);
    check('/api/status has the consent language for voice enrollment (a known statement)', ['en-US', 'ml-IN'].includes(st.json?.voiceConsentLanguage));
    check('/api/status has a roles summary with state', !!st.json?.roles?.mouth && 'state' in st.json.roles.mouth && 'provider' in st.json.roles.mouth);
    check('/api/status keeps the legacy llm/sleepWindow/toggles fields', !!st.json?.llm && !!st.json?.sleepWindow && !!st.json?.toggles);
  }

  // ── static frontend ────────────────────────────────────────────────────────
  {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : [p];
    });
    const jsFiles = fs.existsSync(path.join(PUBLIC, 'js')) ? walk(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js')) : [];
    const cssFiles = fs.existsSync(path.join(PUBLIC, 'css')) ? walk(path.join(PUBLIC, 'css')).filter((f) => f.endsWith('.css')) : [];
    check('frontend has ES modules under public/js', jsFiles.length >= 10, `${jsFiles.length} files`);
    let bad = [];
    for (const f of jsFiles) {
      const rel = '/' + path.relative(PUBLIC, f).split(path.sep).join('/');
      const r = await request('GET', rel);
      if (r.status !== 200 || !/javascript/.test(r.headers['content-type'] || '')) bad.push(`${rel} ${r.status} ${r.headers['content-type']}`);
    }
    check('every /js module → 200 with a JS content type', !bad.length, bad.join('; '));
    bad = [];
    for (const f of cssFiles) {
      const rel = '/' + path.relative(PUBLIC, f).split(path.sep).join('/');
      const r = await request('GET', rel);
      if (r.status !== 200 || !/css/.test(r.headers['content-type'] || '')) bad.push(`${rel} ${r.status}`);
    }
    check('every /css file → 200 text/css', cssFiles.length >= 3 && !bad.length, bad.join('; ') || `${cssFiles.length} files`);
    const idx = await request('GET', '/');
    check('index.html boots /js/main.js as a module', idx.status === 200 && /<script type="module" src="\/js\/main\.js"/.test(idx.text));
    check('index.html keeps #content (the router mounts pages into it)', /id="content"/.test(idx.text));
    check('index.html loads no pre-007 classic scripts', !/src="\/(app|pages)\.js"/.test(idx.text) && !/style\.css/.test(idx.text));
    const gone = ['app.js', 'pages.js', 'style.css', 'js/legacy.js'].filter((f) => fs.existsSync(path.join(PUBLIC, f)));
    check('legacy frontend files are deleted (007 T060)', !gone.length, gone.join(','));
    const deep = await request('GET', '/some/deep/link');
    check('unknown non-API path falls back to index.html', deep.status === 200 && /js\/main\.js/.test(deep.text));

    // Every route in the registry has a module that exists.
    const { ROUTES } = await import(pathToFileURL(path.join(PUBLIC, 'js/routes.js')).href);
    const hashes = ROUTES.map((r) => r.hash);
    check('route registry has the 15 existing routes + #usage + #mind', [
      'status', 'groups', 'group', 'people', 'person', 'memories', 'decisions', 'messages', 'bills', 'logs',
      'instagram', 'settings', 'identity', 'skills', 'audit', 'usage', 'mind',
    ].every((h) => hashes.includes(h)), hashes.join(','));
    const mindRoute = ROUTES.find((r) => r.hash === 'mind');
    check('#mind sits in the Life nav section (plan 020 I1)', mindRoute?.section === 'Life' && mindRoute.nav === true && mindRoute.re.test('#mind'));
    const missing = ROUTES.filter((r) => r.module && !fs.existsSync(path.join(PUBLIC, 'js', r.module)));
    check('every routed page module exists on disk', !missing.length, missing.map((r) => r.module).join(','));
    // Each page module must load without a DOM (nothing at import time) and export mount().
    const unloadable = [];
    for (const r of ROUTES.filter((x) => x.module)) {
      try {
        const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', r.module)).href);
        if (typeof mod.mount !== 'function') unloadable.push(`${r.module}: no mount()`);
      } catch (err) {
        unloadable.push(`${r.module}: ${err.message}`);
      }
    }
    check('every page module imports in node and exports mount()', !unloadable.length, unloadable.join('; '));
    // Spec 006's UI lives in the modules now (the legacy files held the only copy).
    const src = (f) => fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf-8');
    const want = {
      'pages/memories.js': ['<th>ORIGIN</th>', '<th>AUDIENCE</th>', 'memOriginFilter', 'memSuperseded', 'relay-rows', '/api/relays', 'mem-vis'],
      'pages/person.js': ['pd-facets', 'pd-merges', '/api/people/merge-queue/', 'pdPurge', '/purge', 'IDENTITIES', 'originCell'],
      'pages/group.js': ['SYNCED_AT', 'members_synced_at', 'membership_fresh', 'gd-nicks', 'audience_summary', 'mountCalls'],
      'components/calls.js': ["ctx.on('calls'", 'ctx.listen(', 'ctx.setInterval('],
    };
    const missing006 = [];
    for (const [f, needles] of Object.entries(want)) for (const n of needles) if (!src(f).includes(n)) missing006.push(`${f}: ${n}`);
    check('006 UI (origin/audience, facets, merge queue, purge, relays, sync time) ported to modules', !missing006.length, missing006.join('; '));
    // Live logs: web / audio module lines carry their tag; their warnings stay WARN.
    const logsMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/logs.js')).href);
    check('logs: mod web/audio info lines → WEB / AUDIO; warnings stay WARN; evt still wins',
      logsMod.logCategory({ level: 30, mod: 'web' }) === 'web' && logsMod.logCategory({ level: 20, mod: 'audio' }) === 'audio'
      && logsMod.logCategory({ level: 40, mod: 'web' }) === 'warn' && logsMod.logCategory({ level: 50, mod: 'audio' }) === 'issue'
      && logsMod.logCategory({ level: 30, mod: 'web', evt: 'reply' }) === 'reply' && logsMod.logCategory({ level: 30 }) === 'info');
    // A committed plan still ahead never reads as done (Life · Now / Life · Day), and the
    // Director prompt's dropped drafts and real-venue outings (arcs-tests/58).
    {
      const fmtMod = await import(pathToFileURL(path.join(PUBLIC, 'js/core/fmt.js')).href);
      const dayMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-day.js')).href);
      const dirMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-director.js')).href);
      const { PROMPT_DROP_REASONS } = await import(pathToFileURL(path.join(ROOT, 'src/life/story/schema.js')).href);
      const at = 1_800_000_000;
      const ahead = fmtMod.decidedAhead('go', at + 3 * 86400, at);
      check('not-yet: a committed plan ahead → "decided: go · <day> HH:MM (not yet)"', /^decided: go · \S+ \d+ \S+ \d{2}:\d{2} \(not yet\)$/.test(ahead), ahead);
      check('not-yet: a plan already under way / over → no "not yet"', fmtMod.decidedAhead('go', at - 60, at) === '' && fmtMod.decidedAhead('go', null, at) === '');
      const tick = { cat: 'decision', type: 'decision.committed', detail: { label: 'go', eventAt: at + 86400 } };
      check('not-yet: the Day page\'s committed tick says so', /\(not yet\)$/.test(dayMod.rowText(tick, at)) && dayMod.rowText(tick, at + 2 * 86400) === 'decided: go', dayMod.rowText(tick, at));
      check('not-yet: Life · Now uses it', src('pages/life-now.js').includes('decidedAhead(') && src('pages/life-now.js').includes('NOT YET'));
      const noText = PROMPT_DROP_REASONS.filter((r) => typeof dirMod.DROP_REASONS?.[r] !== 'string');
      check('prompt drops: every validator reason has plain words on the Director page', !noText.length, noText.join(', '));
      check('prompt drops: the list shows the words, not only the code', /dropText\(x\.reason\)/.test(src('pages/life-director-story.js')));
      const sp = src('components/schedule-panel.js');
      check('venue outing: the card picks a real place for the outing, or a known place without the lookup',
        sp.includes('REAL PLACE FOR THE OUTING') && sp.includes('ld-p-known') && /field === 'place'/.test(sp));
    }
    // 017: TELL THE STORY step by step — card states, bundles, ticks, the views, the guide.
    {
      const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
      const tell = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-director-story.js')).href);
      const at = 1_800_000_000;
      const ready = (index, action, extra = {}) => ({ draft: { index, action, summary: `change ${index}`, ...extra }, preview: { events: [{ type: 'director.action' }, { type: 'x.y' }], refusals: [] }, applied: false, removed: false });
      const scene = { kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:a'] };
      const beat = { kind: 'cast.beat', castId: 'cast:a', beatKind: 'news', text: 'x' };
      const bm = { kind: 'bookmark', label: 'that morning' };
      const cards = [ready(0, scene), ready(1, beat, { side: true, dependsOn: [0] }), ready(2, bm, { side: true, dependsOn: [0] })];
      check('tell: a previewed draft with no refusal is READY', tell.cardState(cards[0], cards).key === 'ready');
      check('tell: a venue to pick / a later start he can make → NEEDS YOU; no route / refused → WON\'T WORK; checking while previewing',
        tell.cardState({ draft: { index: 0, action: scene, status: 'needs_pick' } }, []).key === 'needs'
        && tell.cardState({ draft: { index: 0, action: scene, status: 'too_soon', earliestAt: at } }, []).fix === 'early'
        && tell.cardState({ draft: { index: 0, action: scene, status: 'no_route' } }, []).key === 'wont'
        && tell.cardState({ draft: { index: 0, action: scene }, preview: { refusals: [{ reason: 'unfit' }] } }, []).text === 'it does not fit into his day'
        && tell.cardState({ draft: { index: 0, action: scene }, previewing: true }, []).key === 'checking');
      const leftOut = cards.map((c, i) => (i === 0 ? { ...c, removed: true } : c));
      check('tell: a side draft whose main was left out WON\'T HAPPEN', tell.cardState(leftOut[1], leftOut).key === 'gone');
      const b = tell.bundlesOf(cards);
      check('tell: one bundle of the mains (side drafts after their main), bookmarks after the bundle',
        JSON.stringify(b) === '{"bundles":[[0,1]],"after":[2]}', JSON.stringify(b));
      check('tell: a left-out or not-ready draft never goes', JSON.stringify(tell.bundlesOf(leftOut).bundles) === '[]'
        && JSON.stringify(tell.bundlesOf([ready(0, scene), { draft: { index: 1, action: scene, status: 'needs_venue' } }]).bundles) === '[[0]]');
      const seven = Array.from({ length: 7 }, (_, i) => ready(i, { ...scene, label: `o${i}` }));
      check('tell: more than five mains → two parts', JSON.stringify(tell.bundlesOf(seven).bundles) === '[[0,1,2,3,4],[5,6]]');
      const act = tell.bundleAction(cards, [0, 1]);
      check('tell: the bundle\'s parts are tagged source prompt (strict rules), ≤ 5', act.kind === 'bundle' && act.actions.every((a) => a.source === 'prompt') && act.actions.length === 2
        && tell.bundleAction(seven, [0, 1, 2, 3, 4], [{ kind: 'mood', source: 'code' }]).actions.length === 5);
      check('tell: the plan line is the server\'s code-built one, else the cards\' summaries',
        tell.planLineOf({ planLine: 'On Saturday…' }, cards) === 'On Saturday…' && tell.planLineOf({}, cards) === 'change 0; change 1; change 2.'
        && tell.planLineOf({ planLine: 'On Saturday…' }, [{ ...cards[0], draft: { ...cards[0].draft, phrase: 'Sat 10:30: an outing' } }, { ...cards[1], removed: true }]) === 'Sat 10:30: an outing.');
      check('tell: a draft whose preview appends nothing is not READY', tell.cardState({ draft: { index: 0, action: scene }, preview: { events: [{ type: 'director.action' }], refusals: [] } }, []).key === 'wont');
      const p = { previewId: 'p', fingerprint: 'f'.repeat(64), events: [{ type: 'director.action' }, { type: 'decision.opened', actor: 'owner' }], refusals: [], warnings: [],
        continuity: { warnings: [{ code: 'cancels_plan', severity: 'high', text: 'this cancels <b>gym</b> at 11:30', keep: ['decision:9'] }, { code: 'cancels_plan', severity: 'high', text: 'again' }] },
        projection: { today: null, rows: [{ at, end: at + 3600, kind: 'hangout', change: 'added', place: 'Corner Café', cast: ['Juno'] }], energyAtSleep: { before: 62, after: 58 }, money: { before: 100, after: 90 } } };
      const loose = [ready(0, scene), ready(1, { kind: 'unpin', pinKey: 'romance' })];
      check('tell: MAKE IT HAPPEN waits for each HIGH code once and each draft that loosens a control',
        JSON.stringify(tell.ticksNeeded(p, loose, [0, 1])) === '["high:cancels_plan","loosens:1"]');
      const mk = (ticks) => ({ step: 'check', tech: false, cards: loose, check: { part: 0, total: 1, idx: [0, 1], ticks: new Set(ticks), applying: false,
        cont: { main: p, read: null, reading: false, added: new Set(), rebundling: false }, shown: () => p } });
      const applyBtn = (h) => (h.match(/<button[^>]*ld-tell-apply[^>]*>/) || [''])[0];
      const h1 = rts(tell.checkView(mk([]), false));
      check('tell: step 3 escapes model / world text and shows his day', h1.includes('this cancels &lt;b&gt;gym&lt;/b&gt;') && !h1.includes('<b>gym') && h1.includes('Corner Café') && h1.includes('62 → 58'));
      check('tell: step 3 offers KEEP IT INSTEAD and the ticks; the button is disabled until they are ticked',
        h1.includes('ld-tell-keep') && h1.includes('data-tick="high:cancels_plan"') && h1.includes('data-tick="loosens:1"') && /disabled/.test(applyBtn(h1)));
      const h2 = rts(tell.checkView(mk(['high:cancels_plan', 'loosens:1']), false));
      check('tell: …enabled once ticked (and disabled read-only)', !/disabled/.test(applyBtn(h2)) && /disabled/.test(applyBtn(rts(tell.checkView(mk(['high:cancels_plan', 'loosens:1']), true)))));
      const plan = { step: 'plan', tech: false, lastWish: '<i>w</i>', res: { dropped: [{ index: 3, kind: 'bookmark', reason: 'unrequested' }], cantDo: ['messaging anyone'] },
        cards: [ready(0, scene, { summary: '<script>x</script>', texts: [{ field: 'label', value: 'Breakfast <b>' }] }), { draft: { index: 1, action: scene, status: 'needs_pick', summary: 'outing' }, applied: false, removed: false }] };
      const hp = rts(tell.planView(plan, false, []));
      check('tell: step 2 escapes the wish, summaries and texts; shows READY / NEEDS YOU; NOT IN THE PLAN in words',
        hp.includes('&lt;script&gt;') && !hp.includes('<script>x') && hp.includes('Breakfast &lt;b&gt;') && hp.includes('&lt;i&gt;w&lt;/i&gt;')
        && hp.includes('READY') && hp.includes('NEEDS YOU') && hp.includes('a bookmark you did not ask for') && hp.includes('messaging anyone'));
      check('tell: CHECK HOW HIS DAY CHANGES is disabled while a change needs you', /<button[^>]*ld-tell-tocheck[^>]*disabled/.test(hp));
      const hpt = rts(tell.planView({ ...plan, tech: true }, false, []));
      check('tell: TECHNICAL adds the engine words and APPLY THIS ONE BY ITSELF', hpt.includes('ld-p-open') && hpt.includes('one by one') && hpt.includes('unrequested') && !hp.includes('ld-p-open'));
      const ls = src('pages/life-director-story.js');
      check('tell: the technical switch is per browser, guarded (try/catch), off by default', /try \{ return localStorage\.getItem\(TECH_KEY\) === '1'; \} catch \{ return false; \}/.test(ls));
      check('tell: a stale check is previewed again and asked again, never applied silently',
        /stale\|expired_preview[\s\S]{0,200}await previewCheck\(\);[\s\S]{0,120}\} else/.test(ls) && !/apply[\s\S]{0,40}fresh\.fingerprint/.test(ls));
      check('tell: bookmarks only after the bundle(s) succeeded', /if \(bundles\.length\) \{[\s\S]{0,200}return;\s*\}\s*await applyBookmarks\(\);/.test(ls));
      const guide = (await import(pathToFileURL(path.join(PUBLIC, 'js/guides/life-director.js')).href)).default;
      const gp = JSON.stringify(guide.sections.find((x) => x.id === 'prompt'));
      check('tell: the guide walks through every step', ['YOUR WISH', 'CHECK THE PLAN', 'MAKE IT HAPPEN', 'NEEDS YOU', 'WON\'T WORK', 'TECHNICAL', 'UNDO ALL OF THIS', 'KEEP IT INSTEAD'].every((w) => gp.includes(w)));
    }
    // sched-fixes: loud cancels + KEEP IT INSTEAD, CHANGES in words, tonight past midnight on Day, plans of the next 12 h on Now.
    {
      const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
      const dirMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-director.js')).href);
      const godMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-director-god.js')).href);
      const dayMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-day.js')).href);
      const nowMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-now.js')).href);
      const sched = { kind: 'schedule', day: 1, ranges: [{ activity: 'home', from: '19:00', to: '23:00' }], resolutions: { 'goal:3': 'reopen' } };
      const kept = dirMod.keepInstead(sched, ['decision:5', 'x:1', '<b>']);
      check('keep-instead: the keys go to keep, others stay, junk keys are dropped',
        JSON.stringify(kept.resolutions) === '{"goal:3":"reopen","decision:5":"keep"}' && kept !== sched && sched.resolutions['decision:5'] === undefined);
      check('keep-instead: no valid key → the same action; a bundle → its schedule parts only',
        dirMod.keepInstead(sched, ['nope']) === sched
        && JSON.stringify(dirMod.keepInstead({ kind: 'bundle', actions: [{ kind: 'scene' }, sched] }, ['invite:9']).actions.map((a) => a.resolutions?.['invite:9'] ?? null)) === '[null,"keep"]');
      const ld = src('pages/life-director.js');
      const ls = src('pages/life-director-story.js');
      check('keep-instead: the modal row (data-act="keep-instead") and TELL THE STORY step 3 (ld-tell-keep → keepInstead, checked again) offer it',
        ld.includes('data-act="keep-instead"') && ld.includes("act === 'keep-instead'") && ls.includes('ld-tell-keep')
        && /ld-tell-keep'\) && s\.check\) \{[\s\S]{0,400}keepInstead\([\s\S]{0,200}previewCheck\(\)/.test(ls));
      check('keep-instead: the I KNOW tick lists each HIGH code once', /const highCodes = \(p\) => \[\.\.\.new Set\(/.test(ld));
      const cancelOnly = { action: { kind: 'schedule' }, events: [{ type: 'director.action' }, { type: 'schedule.override_set' }], warnings: [],
        continuity: { warnings: [{ code: 'cancels_plan', severity: 'high' }, { code: 'keeps_plan', severity: 'warn' }] } };
      check('keep-instead: a schedule edit\'s own cancel / keep lines alone start no story read (a model call); another WARN still does',
        dirMod.autoStoryRead(cancelOnly) === false
        && dirMod.autoStoryRead({ ...cancelOnly, continuity: { warnings: [...cancelOnly.continuity.warnings, { code: 'two_places', severity: 'warn' }] } }) === true);
      const sp = src('components/schedule-panel.js');
      check('keep-instead: the SCHEDULE panel too (ld-s-keep), a cancelled row in red, a trimmed one says so', sp.includes('ld-s-keep') && sp.includes("c.outcome === 'cancelled' ? 'bad'") && sp.includes('RANGE TRIMMED AROUND IT'));
      // 2026-11-02 #7: an owner outing / visit over a plan — KEEP IT INSTEAD keeps both; its own lines start no story read.
      const sceneOut = { kind: 'scene', shape: 'outing', placeId: 'place:x', startAt: 1 };
      check('clash: keep-instead also rewrites an owner outing / visit (not other scene shapes)',
        dirMod.keepInstead(sceneOut, ['decision:4']).resolutions?.['decision:4'] === 'keep'
        && dirMod.keepInstead({ kind: 'scene', shape: 'visit', castIds: ['cast:a'] }, ['goal:2']).resolutions?.['goal:2'] === 'keep'
        && dirMod.keepInstead({ kind: 'scene', shape: 'cast.beat' }, ['decision:4']).resolutions === undefined);
      check('clash: an outing\'s overlaps_plan line (both kept) alone starts no story read',
        dirMod.autoStoryRead({ action: sceneOut, events: [{ type: 'director.action' }, { type: 'decision.opened' }], warnings: [],
          continuity: { warnings: [{ code: 'overlaps_plan', severity: 'warn' }, { code: 'cancels_plan', severity: 'high' }] } }) === false);
      // 2026-11-02 #4: the SCHEDULE form round-trips every preset (NOW / UNTIL SLEEP ticks, not a time input).
      {
        const spMod = await import(pathToFileURL(path.join(PUBLIC, 'js/components/schedule-panel.js')).href);
        const { scheduleProblem } = await import(pathToFileURL(path.join(ROOT, 'src/dashboard/routes/director.js')).href);
        const fakeForm = () => {
          const el = {};
          const dflt = { day: '0', bgWhen: 'whole' };
          const mk = (n) => (el[n] ??= { value: dflt[n] ?? '', checked: false, disabled: false, validity: { badInput: false },
            dataset: /^r\dnow$/.test(n) ? { time: n.replace('now', 'from') } : /^r\deod$/.test(n) ? { time: n.replace('eod', 'to') } : {} });
          return { el, elements: { namedItem: mk }, reset() { for (const [k, x] of Object.entries(el)) { x.value = dflt[k] ?? ''; x.checked = false; } } };
        };
        const bad = [];
        for (const name of ['rest_off', 'wfh_tomorrow', 'stay_in', 'sleep_in']) {
          const f = fakeForm();
          const a = spMod.presetAction(name);
          spMod.fillScheduleForm(f, a);
          const back = spMod.scheduleAction(f);
          if (JSON.stringify(back) !== JSON.stringify(a) || scheduleProblem(back) !== null || spMod.scheduleFormProblem(f) !== '') bad.push(`${name}: ${JSON.stringify(back)} ${spMod.scheduleFormProblem(f)}`);
        }
        check('schedule form: each preset fills the form so PREVIEW sends exactly the preset (a valid body)', !bad.length, bad.join('; '));
        const f = fakeForm();
        spMod.fillScheduleForm(f, spMod.presetAction('stay_in'));
        check('schedule form: STAY IN TONIGHT ticks NOW / UNTIL SLEEP and turns their time inputs off',
          f.el.r0now.checked && f.el.r0eod.checked && f.el.r0from.disabled && f.el.r0to.disabled && f.el.r0from.value === '');
        const manual = { kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '17:15', to: '17:30' }] };
        spMod.fillScheduleForm(f, manual);
        check('schedule form: a manual 15-min stretch after a preset carries nothing of it (HOME 17:15–17:30)',
          JSON.stringify(spMod.scheduleAction(f)) === JSON.stringify(manual) && scheduleProblem(spMod.scheduleAction(f)) === null && !f.el.r0from.disabled, JSON.stringify(spMod.scheduleAction(f)));
        f.el.r0from.value = '17:15:00';
        check('schedule form: a time with seconds is sent as HH:MM', spMod.scheduleAction(f).ranges[0].from === '17:15');
        f.el.r0from.value = '';
        f.el.r0from.validity.badInput = true;
        check('schedule form: a half-typed time is caught before sending (no 400)', /STRETCH 1 FROM: THE TIME IS NOT COMPLETE/.test(spMod.scheduleFormProblem(f)), spMod.scheduleFormProblem(f));
        f.el.r0from.validity.badInput = false;
        check('schedule form: an empty FROM says to pick a time or NOW', spMod.scheduleFormProblem(f) === 'STRETCH 1 FROM: PICK A TIME, OR NOW');
        f.el.r0from.value = '17:15';
        f.el.r1act.value = 'home'; f.el.r1from.value = '17:20'; f.el.r1to.value = '18:00';
        check('schedule form: two overlapping stretches are caught', /OVERLAP/.test(spMod.scheduleFormProblem(f)));
        f.el.r1act.value = ''; f.el.day.value = '1'; f.el.r0now.checked = true;
        check('schedule form: NOW on another day is caught', spMod.scheduleFormProblem(f) === 'NOW IS FOR TODAY ONLY');
        check('schedule form: PREVIEW checks the form first; a tick toggles its time input', sp.includes('scheduleFormProblem(form)') && sp.includes('CHECK THE FORM') && sp.includes('syncTimes('));
      }
      check('changes: CHANGES shows the description (escaped), else the kind',
        godMod.changeText({ kind: 'schedule', description: 'Schedule · Sat 31 Oct' }) === 'Schedule · Sat 31 Oct' && godMod.changeText({ kind: 'scene' }) === 'SCENE'
        && /changeText\(c\)/.test(src('pages/life-director-god.js')));
      const card = rts(godMod.revertConfirmCard({ actionEventId: 7, kind: 'schedule', description: "Schedule · home 01:15–02:30 '<b>late</b>'", targets: [{ id: 8, type: 'schedule.override_set' }], riding: [], refusals: [] }));
      check('changes: the REVERT THIS CHANGE confirm repeats it (escaped)', card.includes('Schedule · home 01:15–02:30') && card.includes('&lt;b&gt;late&lt;/b&gt;') && !card.includes('<b>late'));
      const at = 1_800_000_000;
      const v = { today: true, at, from: at - 20 * 3600, to: at + 2 * 3600, past: { spans: [], ticks: [], decisions: [] }, chats: [],
        future: { spans: [{ at, end: at + 3600, cat: 'activity', kind: 'free' }], ticks: [], decisions: [] },
        tonight: { from: at + 2 * 3600, to: at + 9 * 3600, spans: [{ at: at + 2 * 3600, end: at + 9 * 3600, cat: 'sleep', kind: 'sleep' }], ticks: [],
          decisions: [{ id: 4, at: at + 2 * 3600 + 900, kind: 'outing', status: 'committed', odds: [] }] } };
      const rows = dayMod.buildRows(v);
      const ti = rows.findIndex((r) => r.row === 'tonight');
      check('tonight: Day rows end with a TONIGHT strip and its rows (after today\'s projection)',
        ti > rows.findIndex((r) => r.row === 'now') && rows.slice(ti + 1).length === 2 && rows.slice(ti + 1).every((r) => r.tonight && r.future) && rows[ti].to === at + 9 * 3600);
      check('tonight: not on another day\'s page; the separator says so', !dayMod.buildRows({ ...v, today: false }).some((r) => r.row === 'tonight')
        && src('pages/life-day.js').includes('TONIGHT (CONTINUES TOMORROW)'));
      const nx = nowMod.nextRows({ next: [{ start: at + 600, end: at + 3600, kind: 'free' }], upcoming: [{ id: 1, start: at + 300, end: at + 900, label: 'Snack run', status: 'committed', committed: 'go', inPlan: false },
        { id: 2, start: at + 1200, label: 'In the plan', inPlan: true }] });
      check('now: plans of the next 12 h not in the plan are merged into NEXT BLOCKS by time', nx.length === 2 && nx[0].plan?.id === 1 && nx[0].kind === 'Snack run' && nx[1].kind === 'free');
      const { GUIDES } = await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href);
      const gDir = JSON.stringify((await GUIDES['life/director']()).default);
      const gDay = JSON.stringify((await GUIDES['life/day']()).default);
      const gNow = JSON.stringify((await GUIDES.life()).default);
      check('guides: Director (kept by default, loud cancel, KEEP IT INSTEAD, CHANGES in words), Day (TONIGHT), Now (next 12 hours)',
        /KEPT by default/.test(gDir) && gDir.includes('KEEP IT INSTEAD') && gDir.includes('this cancels') && /each said in words/.test(gDir)
        && gDay.includes('TONIGHT (CONTINUES TOMORROW)') && gNow.includes('next 12 hours'));
    }
    check('logs: WEB / AUDIO filters match the module at any level',
      logsMod.inBucket({ cat: 'warn', mod: 'web' }, 'web') && !logsMod.inBucket({ cat: 'info', mod: null }, 'web')
      && logsMod.inBucket({ cat: 'warn', mod: 'web' }, 'issues') && logsMod.inBucket({ cat: 'skip', mod: null }, 'decisions'));
    const webSrc = ['webSearch', 'webBrowse'].map((f) => fs.readFileSync(path.join(ROOT, 'src/brain', `${f}.js`), 'utf-8'));
    const audioSrc = ['transcribe', 'voiceGen', 'voiceClone'].map((f) => fs.readFileSync(path.join(ROOT, 'src/brain', `${f}.js`), 'utf-8'));
    check('web / audio modules log through a mod-tagged child logger', webSrc.every((t) => t.includes("rootLogger.child({ mod: 'web' })"))
      && audioSrc.every((t) => t.includes("rootLogger.child({ mod: 'audio' })")));
    // Re-pair (POST /api/pair/start spawns scripts/pair.js) writes where the bot reads (AUTH_PATH);
    // setup writes .env owner-only like envWriter; the IG taste card is generated at boot.
    const pairSrc = fs.readFileSync(path.join(ROOT, 'scripts/pair.js'), 'utf-8');
    check('pair.js uses config.authPath (AUTH_PATH), not a hardcoded ./data path', pairSrc.includes('const AUTH_DIR = safePath(config.authPath)') && pairSrc.includes('useMultiFileAuthState(AUTH_DIR)') && !pairSrc.includes("'./data/auth_info_baileys'"));
    const setupSrc = fs.readFileSync(path.join(ROOT, 'scripts/setup.js'), 'utf-8');
    check('setup.js writes .env only through writeEnvFile (0600) and chmods the copied example',
      !/fs\.writeFileSync\(ENV_PATH/.test(setupSrc.replace("fs.writeFileSync(ENV_PATH, body, { mode: 0o600 })", '')) && /copyFileSync\(ENV_EXAMPLE_PATH, ENV_PATH\);\s*fs\.chmodSync\(ENV_PATH, 0o600\)/.test(setupSrc));
    check('startInstagram generates the taste card (ensureTasteCard has a caller)', /ensureTasteCard\(\)\.catch/.test(fs.readFileSync(path.join(ROOT, 'src/instagram/index.js'), 'utf-8')));
    // Instagram: clearing a stored caption sends '' (no caption), a never-set one sends nothing (he writes one).
    const igMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/instagram.js')).href);
    check('instagram approve body: typed → caption, cleared → "", blank+none stored → {}',
      JSON.stringify(igMod.approveBody('hi there', null)) === '{"caption":"hi there"}' && JSON.stringify(igMod.approveBody('  ', 'old caption')) === '{"caption":""}'
      && JSON.stringify(igMod.approveBody('', null)) === '{}' && JSON.stringify(igMod.approveBody('', '')) === '{}');
    check('person page: consent language comes from /api/status (no hardcoded locale)', !/'ml-IN'|'en-US'/.test(src('pages/person.js'))
      && src('pages/person.js').includes('voiceConsentLanguage'));
    check('calls panel opens no EventSource of its own', !/new EventSource/.test(src('components/calls.js')));
    const noModule = ROUTES.filter((r) => !r.module || typeof r.load !== 'function').map((r) => r.hash).sort();
    check('every route has a page module (no legacy adapter left)', !noModule.length && ROUTES.every((r) => !('legacy' in r)), noModule.join(','));
    const sections = new Set(ROUTES.filter((r) => r.nav).map((r) => r.section));
    check('nav sections are Life / Chats / Control',
      ['Life', 'Chats', 'Control'].every((s) => sections.has(s)) && [...sections].every((s) => ['Life', 'Chats', 'Control'].includes(s)));
    // Spec 009 T040: the three Life pages, routed and in the Life nav section.
    const lifeRoutes = ROUTES.filter((r) => r.section === 'Life');
    check('Life section routes #life, #life/timeline, #life/map',
      ['life', 'life/map'].every((h) => lifeRoutes.some((r) => r.hash === h && r.nav)) && lifeRoutes.some((r) => r.hash === 'life/timeline' && r.tabs === 'day') && ['#life', '#life/timeline', '#life/map'].every((h) => ROUTES.find((r) => r.re.test(h))?.section === 'Life'),
      lifeRoutes.map((r) => r.hash).join(','));
    // Life · Day (#life/day, #life/day/<date>): right after Now, Now stays the landing page.
    const dayIdx = ROUTES.findIndex((r) => r.hash === 'life/day');
    check('#life/day is routed right after Now (title Day), with an optional date',
      dayIdx === ROUTES.findIndex((r) => r.hash === 'life') + 1 && ROUTES[dayIdx]?.title === 'Day' && ROUTES[dayIdx]?.nav === true
      && ROUTES[dayIdx].re.test('#life/day') && ROUTES[dayIdx].re.test('#life/day/2026-10-29') && !ROUTES[dayIdx].re.test('#life/day/x')
      && ROUTES.find((r) => r.re.test('#life'))?.hash === 'life');
    const { GUIDES } = await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href);
    // Every guide is a lazy import: one stray apostrophe in a '…' string breaks that page's "?" entirely.
    const badGuides = [];
    for (const [k, load] of Object.entries(GUIDES)) {
      try { const m = await load(); if (!m.default?.sections?.length) badGuides.push(k); } catch { badGuides.push(k); }
    }
    check('every page guide module parses and has sections', badGuides.length === 0, badGuides.join(','));
    // 020 E3: the Claim check page.
    {
      const ccRoute = (await import(pathToFileURL(path.join(PUBLIC, 'js/routes.js')).href)).ROUTES.find((r) => r.hash === 'claim-check');
      check('claim: the page is in Control', ccRoute?.section === 'Control' && ccRoute?.nav === true);
      const ccSrc = src('pages/claim-check.js');
      const ccMod = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/claim-check.js')).href);
      const { renderToString } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
      const row = renderToString(ccMod.rowView({ writer: 'phone', speaker: 'his', runs: 3, checked: 2, codeOnly: 1, supported: 4, unknown: 5, contradicted: 1, codeContradicted: 1 }));
      check('claim: his own speech has its row', row.includes('Texts · his') && row.includes('10%'), row);
      const hostile = ccMod.contradictionRow({ writer: 'scene', speaker: 'narrator', at: 1, source: 'clerk', about: 'left', reason: 'left_wrong', claim: '<img src=x>', evidence: '<b>sheet</b>', excerpt: '<script>x</script>', href: '#life/day' });
      const shown = renderToString(hostile.detail);
      check('claim: a reason reads in words', renderToString(ccMod.contradictionRow({ writer: 'scene', speaker: 'narrator', at: 1, source: 'code', about: 'when', reason: 'time_word_mismatch' }).detail).includes('time word mismatch'));
      check('claim: words are escaped', !shown.includes('<b>sheet') && !shown.includes('<script>') && hostile.title === '<img src=x>');
      const chatRow = ccMod.contradictionRow({ writer: 'journal', speaker: 'narrator', at: 1, source: 'clerk', about: 'when', reason: 'when_wrong', fromChat: true, claim: null, evidence: null, excerpt: null });
      check('claim: a chat\'s output shows codes, no words', /codes only/.test(chatRow.title) && !renderToString(chatRow.detail).includes('The sheet says'));
      check('claim: no price for the clerk reads as that, not $0.00 of a cap', /NO PRICE/.test(ccMod.pricingWords({ pricing: 'unpriced', monthUsd: 0, budgetUsd: 0.5 })) && /LOCAL/.test(ccMod.pricingWords({ pricing: 'local', monthUsd: 0, budgetUsd: 0.5 })) && !/NO PRICE|LOCAL/.test(ccMod.pricingWords({ pricing: 'priced', monthUsd: 0.1, budgetUsd: 0.5 })));
      const ccGuide = (await GUIDES['claim-check']()).default;
      const qs = [...ccSrc.matchAll(/data-guide="([a-z-]+)"/g)].map((m) => m[1]);
      check('claim: a guide backs every "?"', qs.length >= 2 && qs.every((q) => ccGuide.sections.some((x) => x.id === q)));
      check('claim: read-only (no write call), through the kit', !/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(ccSrc) && /components\/views\.js/.test(ccSrc));
    }
    const dayGuide =GUIDES['life/day'] ? (await GUIDES['life/day']()).default : null;
    const dayQs = [...src('pages/life-day.js').matchAll(/data-guide="([a-z-]+)"/g)].map((m) => m[1]);
    check('Life · Day has a guide whose sections back every "?" button',
      !!dayGuide && dayQs.length >= 3 && dayQs.every((id) => dayGuide.sections.some((x) => x.id === id)), dayQs.join(','));
    check('Life · Day has no raw HTML sink (raw() only for the static shell)',
      !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src('pages/life-day.js')) && (src('pages/life-day.js').match(/raw\(/g) || []).length === 1);
    check('Life pages poll (no EventSource of their own) and use the html`` escaper',
      ['pages/life-now.js', 'pages/life-day.js', 'pages/life-timeline.js', 'pages/life-map.js'].every((f) => !/new EventSource|innerHTML\s*=/.test(src(f)) && /ctx\.setInterval\(/.test(src(f)) && /html`/.test(src(f))));
    check('Life · Day labels the chat-influence rows from /api/influence/lane (012 §F) and its guide says so',
      /\/api\/influence\/lane\?from=/.test(src('pages/life-day.js')) && /buildRows\(v, lane\)/.test(src('pages/life-day.js'))
      && !!dayGuide && JSON.stringify(dayGuide).includes('Chats on his day'));
    check('index.html has the topbar life badge (hidden until status.life)', /id="lifeCell"[^>]*hidden/.test(idx.text) && /id="topLife"/.test(idx.text));
    check('Life map draws locally (no tile or CDN fetch in the module)', !/https?:\/\//.test(src('pages/life-map.js').replace(/^\s*\/\/.*$/gm, '')));
  }

  // ── APIs the pages call on load ────────────────────────────────────────────
  {
    const apis = [
      '/api/health', '/api/status', '/api/stats/activity?days=30', '/api/config', '/api/config/diff', '/api/llm/roles',
      '/api/decisions?limit=200', '/api/quality', '/api/messages/search?q=hello&limit=100', '/api/bills?limit=100',
      '/api/identity', '/api/skills', '/api/audit?limit=200', '/api/groups', '/api/people?limit=500',
      '/api/memories', '/api/pair/status',
      '/api/instagram/status', '/api/instagram/queue', '/api/instagram/reels?limit=30', '/api/instagram/taste',
      '/api/instagram/device-log?limit=80', '/api/instagram/chat?limit=80', '/api/instagram/members',
      '/api/usage?days=30', '/api/usage/budgets', '/api/usage/prefilter',
      // 006-overlap pages (groups, group, people, person, memories + relays, calls panel)
      '/api/people?limit=200', '/api/memories?limit=300', '/api/memories?limit=300&include_superseded=1',
      '/api/relays?limit=100', '/api/relays?limit=100&state=sent', '/api/people/merge-queue',
      `/api/groups/${encodeURIComponent(SEED_GROUP)}`, `/api/people/${encodeURIComponent(SEED_PERSON)}`,
      `/api/calls?group=${encodeURIComponent(SEED_GROUP)}`, `/api/calls?person=${encodeURIComponent(SEED_PERSON)}`,
      `/api/calls/dialable/${encodeURIComponent(SEED_PERSON)}`,
      // spec 008 Mind page (empty shapes until the facade is initialised)
      '/api/mind/status', '/api/mind/self-state', `/api/mind/self-state?as=${encodeURIComponent(SEED_GROUP)}`,
      '/api/mind/runs?limit=30', '/api/mind/digests?limit=30', '/api/mind/episodes?limit=50', '/api/mind/self-model',
      '/api/mind/nudges?limit=100', '/api/mind/bands', '/api/mind/proactive?limit=50', '/api/mind/exclusions', '/api/mind/stances', '/api/arcs/dreams',
      // 020 E3 Claim check
      '/api/arcs/claim-checks', '/api/arcs/claim-checks?days=7',
      // 009 Life pages (engine not started here → the "off" shapes)
      '/api/life/now', '/api/life/timeline', '/api/life/map', '/api/life/events?limit=200', '/api/life/decisions',
      '/api/life/claims?status=flagged&limit=50', '/api/life/day', '/api/life/day?date=2026-10-28',
      // 018 Life · Wallet
      '/api/life/wallet', '/api/life/wallet?month=2026-10',
      // 014 map: the Day page's trip map
      '/api/life/map?date=2026-10-28',
      // 012 Life · Now's chat-influence panel, Life · Pending's invitations, the Day page's lane
      '/api/influence/now', '/api/influence/invites', '/api/influence/lane', '/api/influence/lane?from=1793000000&to=1793086400',
      // 012 P3: the advice tray (Story · From chats, Director · Suggestions from chats)
      '/api/influence/advice', '/api/influence/advice?status=pending&limit=50',
    ];
    const bad = [];
    for (const a of apis) {
      const r = await request('GET', a);
      if (r.status !== 200) bad.push(`${a} → ${r.status} ${r.text.slice(0, 80)}`);
    }
    check(`every page-load API → 200 (${apis.length})`, !bad.length, bad.join(' | '));
    const u = await request('GET', '/api/usage?days=9999');
    check('/api/usage clamps days to 180', u.json?.window === 180 && Array.isArray(u.json?.days) && Array.isArray(u.json?.unpriced));
    const u0 = await request('GET', '/api/usage?days=0');
    check('/api/usage clamps days to ≥ 1', u0.json?.window === 1);
    const ux = await request('GET', `/api/usage?days=${encodeURIComponent("1; DROP TABLE llm_usage")}`);
    check('/api/usage ignores a non-numeric days', ux.status === 200 && ux.json?.window === 30);
    const b = await request('GET', '/api/usage/budgets');
    check('/api/usage/budgets lists roles + global', Array.isArray(b.json) && b.json.some((x) => x.name === 'global') && b.json.some((x) => x.name === 'mouth'));
    const pf = await request('GET', '/api/usage/prefilter');
    check('/api/usage/prefilter has agreement + mode/enabled', typeof pf.json?.n === 'number' && 'recommendEnforce' in pf.json && typeof pf.json?.mode === 'string' && typeof pf.json?.enabled === 'boolean');
    const ms = await request('GET', '/api/mind/status');
    check('/api/mind/status → reminder codes only + ownerJidsSet as a boolean (never the JIDs)',
      typeof ms.json?.ownerJidsSet === 'boolean' && !('ownerJids' in (ms.json || {}))
      && Array.isArray(ms.json?.reminders) && ms.json.reminders.every((r) => /^[a-z_0-9]+$/.test(r.code)));
    const ln = await request('GET', '/api/life/now');
    check('/api/life/now with the engine stopped → running:false shape', ln.json?.running === false && Array.isArray(ln.json?.queue?.byChat) && Array.isArray(ln.json?.next) && Array.isArray(ln.json?.upcoming));
    const st = await request('GET', '/api/status');
    check('/api/status has a life field', !!st.json?.life && 'availability' in st.json.life && 'until' in st.json.life && 'activity' in st.json.life && 'enabled' in st.json.life);
    const inf = await request('GET', '/api/influence/now');
    check('/api/influence/now with the engine stopped → running:false shape', inf.json?.running === false && Array.isArray(inf.json?.blips)
      && !('excerpt' in (inf.json || {})));
    const infAnon = await request('GET', '/api/influence/now', { cookies: false });
    check('unauthenticated /api/influence/now → 401', infAnon.status === 401, `got ${infAnon.status}`);
    const invs = await request('GET', '/api/influence/invites');
    check('/api/influence/invites with the engine stopped → running:false, no invitations', invs.json?.running === false && Array.isArray(invs.json?.invites)
      && invs.json.invites.length === 0);
    const lane = await request('GET', `/api/influence/lane?from=1&to=${encodeURIComponent('9; DROP TABLE x')}`);
    check('/api/influence/lane ignores a non-numeric bound and caps the window at 48 h', lane.status === 200 && Array.isArray(lane.json?.lane)
      && lane.json.to - lane.json.from <= 2 * 86400);
    const adv = await request('GET', '/api/influence/advice?status=pending');
    check('/api/influence/advice with the engine stopped → an empty tray', adv.status === 200 && Array.isArray(adv.json?.advice) && adv.json.advice.length === 0);
    const advBad = await request('GET', '/api/influence/advice?status=bogus');
    check('/api/influence/advice rejects an unknown status (400)', advBad.status === 400, `got ${advBad.status}`);
    for (const path of ['/api/influence/invites', '/api/influence/lane', '/api/influence/advice']) {
      const anon = await request('GET', path, { cookies: false });
      check(`unauthenticated ${path} → 401`, anon.status === 401, `got ${anon.status}`);
    }
    const ld = await request('GET', '/api/life/day');
    check('/api/life/day with the engine stopped → running:false shape', ld.status === 200 && ld.json?.running === false);
    const ldBad = await request('GET', '/api/life/day?date=29-10-2026');
    check('/api/life/day rejects a malformed date (400)', ldBad.status === 400, `got ${ldBad.status}`);
    const lm = await request('GET', '/api/life/map');
    check('/api/life/map reports tileUrl + attribution keys', 'tileUrl' in (lm.json || {}) && 'attribution' in (lm.json || {}));
    // Every dashboard-mutable key either persists to a real .env variable or is
    // explicitly marked "not persistable" (a key in neither silently reverted on restart).
    const cfg = await request('GET', '/api/config');
    const { KEY_TO_ENV, NOT_PERSISTABLE } = await import('../src/dashboard/envWriter.js');
    const mutable = cfg.json?.mutableKeys || [];
    const orphan = mutable.filter((k) => !(k in KEY_TO_ENV) && !NOT_PERSISTABLE.has(k));
    check('every mutable config key is persistable or explicitly marked not persistable', mutable.length > 50 && !orphan.length, orphan.join(','));
    check('/api/config lists persistable / notPersistable + per-key types',
      Array.isArray(cfg.json?.persistable) && Array.isArray(cfg.json?.notPersistable)
      && mutable.every((k) => cfg.json.persistable.includes(k) !== cfg.json.notPersistable.includes(k))
      && cfg.json?.types?.['capCatchUp.maxAgeMinutes'] === 'int:1..1440' && cfg.json?.types?.['life.commitP'] === 'float:0.51..1');
    check('/api/config bounds every life.* key (2026-10-31 audit)',
      ['life.jevMaxPerDay', 'life.commitP', 'life.selfMentionBudget', 'life.queueMaxAgeHours'].every((k) => /^(int|float):/.test(cfg.json?.types?.[k] || '')),
      JSON.stringify(cfg.json?.types && Object.fromEntries(Object.entries(cfg.json.types).filter(([k]) => k.startsWith('life.')))));
    check('/api/config lists the enum choices for the Settings selects',
      Array.isArray(cfg.json?.enums?.['enum:mindEffort']) && cfg.json.enums['enum:mindEffort'].includes('high'));
    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
    const unknownEnv = Object.entries(KEY_TO_ENV).filter(([k]) => !k.startsWith('roles.'))
      .filter(([, env]) => !new RegExp(`^#?\\s*${env}=`, 'm').test(envExample)).map(([k, env]) => `${k}→${env}`);
    check('every persisted (non-role) key maps to a variable named in .env.example', !unknownEnv.length, unknownEnv.join(','));
    check('.env-only SSRF/secret surfaces stay out of KEY_TO_ENV',
      ['webSearch.searxngUrl', 'webSearch.browse.allowPrivate', 'llm.baseUrl', 'llm.apiKey', 'llm.openrouterApiKey', 'media.giphyApiKey']
        .every((k) => !(k in KEY_TO_ENV) && !mutable.includes(k)));
    const roles = await request('GET', '/api/llm/roles');
    const keysOnlyBool = roles.json && Object.values(roles.json.keys || {}).every((v) => typeof v === 'boolean');
    check('/api/llm/roles → key flags are booleans only', keysOnlyBool);
  }

  // ── multiplexed SSE ────────────────────────────────────────────────────────
  {
    logger.info({ evt: 'info' }, 'test-dashboard: line before connect');
    await sleep(30);
    const s = await openSse('/api/stream?topics=logs,decisions');
    check('/api/stream?topics=logs,decisions → 200 event-stream', s.status === 200 && /text\/event-stream/.test(s.headers['content-type'] || ''));
    await waitFor(() => s.comments > 0);
    check('stream sends a keepalive comment on connect', s.comments > 0);
    await waitFor(() => s.frames.some((f) => f.event === 'logs'));
    const logFrames = s.frames.filter((f) => f.event === 'logs');
    check('logs backlog arrives as event "logs" with id logs:<seq>', logFrames.length > 0 && logFrames.every((f) => /^logs:\d+$/.test(f.id || '')));
    emitDashboardEvent('decision', { messageId: 'TEST-1', groupJid: 'g@g.us', decided: 'text', score: 0.9, factors: {} });
    await waitFor(() => s.frames.some((f) => f.event === 'decisions'));
    const dec = s.frames.find((f) => f.event === 'decisions');
    check('injected emitDashboardEvent("decision") arrives as event "decisions"', dec?.json?.messageId === 'TEST-1');
    logger.warn('test-dashboard: live line');
    await waitFor(() => s.frames.some((f) => f.event === 'logs' && /live line/.test(f.data)));
    check('live log line arrives on the open stream', s.frames.some((f) => f.event === 'logs' && /live line/.test(f.data)));
    const lastId = [...s.frames].reverse().find((f) => f.event === 'logs')?.id;
    closeSse(s);
    await waitFor(() => openStreams('127.0.0.1') === 0);
    check('closing a stream releases its slot', openStreams('127.0.0.1') === 0, `open=${openStreams('127.0.0.1')}`);

    // Resume: ?since= (the mux) and Last-Event-ID (browser auto-reconnect).
    logger.info('test-dashboard: after disconnect');
    await sleep(30);
    const r1 = await openSse(`/api/stream?topics=logs&since=${encodeURIComponent(lastId)}`);
    await waitFor(() => r1.frames.some((f) => /after disconnect/.test(f.data)));
    const seqOf = (id) => Number(String(id).split(':')[1]);
    check('?since=logs:<id> replays only newer lines', r1.frames.length > 0 && r1.frames.every((f) => seqOf(f.id) > seqOf(lastId)) && r1.frames.some((f) => /after disconnect/.test(f.data)), `${r1.frames.length} frames`);
    closeSse(r1);
    const r2 = await openSse('/api/stream?topics=logs', { headers: { 'Last-Event-ID': lastId } });
    await waitFor(() => r2.frames.length > 0);
    check('Last-Event-ID: logs:<id> resumes without duplicates', r2.frames.length > 0 && r2.frames.every((f) => seqOf(f.id) > seqOf(lastId)));
    closeSse(r2);

    const unk = await openSse('/api/stream?topics=logs,secrets');
    check('unknown topic → 400', unk.status === 400, `got ${unk.status}`);
    const seven = await openSse('/api/stream?topics=logs,decisions,calls,instagram,usage,logs,decisions');
    check('7 topics → 400', seven.status === 400, `got ${seven.status}`);
    const none = await openSse('/api/stream');
    check('no topics → 400', none.status === 400, `got ${none.status}`);

    await waitFor(() => openStreams('127.0.0.1') === 0);
    const held = [];
    for (let i = 0; i < MAX_STREAMS_PER_IP; i++) held.push(await openSse('/api/stream?topics=usage'));
    check(`${MAX_STREAMS_PER_IP} streams per peer open`, held.every((h) => h.status === 200), held.map((h) => h.status).join(','));
    const fifth = await openSse('/api/stream?topics=usage');
    check(`stream ${MAX_STREAMS_PER_IP + 1} from the same peer → 429`, fifth.status === 429, `got ${fifth.status}`);
    held.forEach(closeSse);
    await waitFor(() => openStreams('127.0.0.1') === 0);
    const after = await openSse('/api/stream?topics=usage');
    check('slots free again after the streams close', after.status === 200, `got ${after.status}`);
    closeSse(after);

    // Snapshot topics.
    const snap = await openSse('/api/stream?topics=calls,instagram');
    await waitFor(() => snap.frames.length >= 2);
    check('calls + instagram send a snapshot on connect', snap.frames.some((f) => f.event === 'calls' && f.json?.kind === 'snapshot') && snap.frames.some((f) => f.event === 'instagram' && f.json?.kind === 'snapshot'));
    closeSse(snap);
    // The pre-007 per-feature endpoints were removed with the legacy frontend (T060).
    const aliasStatus = [];
    for (const alias of ['logs', 'decisions', 'calls', 'instagram']) {
      const r = await request('GET', `/api/stream/${alias}`);
      aliasStatus.push(`${alias}:${r.status}`);
    }
    check('/api/stream/{logs,decisions,calls,instagram} aliases are gone (404)', aliasStatus.every((x) => x.endsWith(':404')), aliasStatus.join(','));
    // Routes no page called were removed (audit dashfront-3).
    const goneStatus = [];
    for (const path of ['/api/messages/recent', '/api/public/votes/1', '/api/groups/muted', '/api/calls/status']) {
      const r = await request('GET', path);
      goneStatus.push(`${path}:${r.status}`);
    }
    check('unused routes are gone (404): messages/recent, public/votes/:id, groups/muted, calls/status', goneStatus.every((x) => x.endsWith(':404')), goneStatus.join(','));
    emitDashboardEvent('usage', { role: 'mouth' });
    await waitFor(() => openStreams('127.0.0.1') === 0);
  }

  // ── readonly / CSRF / audit ────────────────────────────────────────────────
  {
    config.dashboard.readOnly = true;
    const ro = await request('PATCH', '/api/config', { body: { responseRate: 0.2 }, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('readonly=true → PATCH 403', ro.status === 403, `got ${ro.status}`);
    config.dashboard.readOnly = false;
    const noCsrf = await request('PATCH', '/api/config', { body: { responseRate: 0.2 } });
    check('readonly=false → PATCH without CSRF 403', noCsrf.status === 403, `got ${noCsrf.status}`);
    const before = getDb().prepare("SELECT COUNT(*) AS n FROM dashboard_audit WHERE action = 'config.patch'").get().n;
    const ok = await request('PATCH', '/api/config', { body: { responseRate: 0.2 }, headers: { 'X-CSRF-Token': jar.csrf_token } });
    const afterN = getDb().prepare("SELECT COUNT(*) AS n FROM dashboard_audit WHERE action = 'config.patch'").get().n;
    check('readonly=false → PATCH with CSRF 200 + audit row', ok.status === 200 && afterN === before + 1, `status ${ok.status}, audit ${before}→${afterN}`);
    const range = await request('PATCH', '/api/config', { body: { 'capCatchUp.maxAgeMinutes': 99999, 'mind.thinkMaxPerDay': 'x' }, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('out-of-range PATCH value → rejected with the allowed range (bad type only for a wrong type)',
      /^out of range \(allowed 1\.\.1440/.test(range.json?.rejected?.['capCatchUp.maxAgeMinutes'] || '')
      && /^bad type/.test(range.json?.rejected?.['mind.thinkMaxPerDay'] || '') && config.capCatchUp.maxAgeMinutes !== 99999,
      JSON.stringify(range.json?.rejected));
    // DELETE /api/memories/:id goes through 006's delete path: tombstoned, audited without text.
    const { addMemory, isTombstoned } = await import('../src/memory/relationshipStore.js');
    const learned = addMemory({ category: 'fact', subjectJid: SEED_PERSON, originKind: 'group', originJid: SEED_GROUP,
      content: 'Asha runs marathons', source: 'batch' });
    const del = await request('DELETE', `/api/memories/${learned.id}`, { headers: { 'X-CSRF-Token': jar.csrf_token } });
    const delAudit = getDb().prepare("SELECT payload_json FROM dashboard_audit WHERE action = 'memory.delete' AND target = ?").get(String(learned.id));
    check('memory DELETE → tombstoned (not relearnable), audited without the text',
      del.status === 200 && del.json?.tombstoned === true && isTombstoned('-', { originJid: SEED_GROUP, content: 'Asha runs marathons' })
      && !!delAudit && !/marathon/.test(delAudit.payload_json)
      && addMemory({ category: 'fact', subjectJid: SEED_PERSON, originKind: 'group', originJid: SEED_GROUP, content: 'Asha runs marathons', source: 'batch' }).refused === 'tombstoned',
      `status ${del.status}`);
    // Spec 009 owner writes go through the same guards.
    const lifeNoCsrf = await request('POST', '/api/life/claims/1/dismiss', { body: {} });
    check('readonly=false → life write without CSRF 403', lifeNoCsrf.status === 403, `got ${lifeNoCsrf.status}`);
    const lifeOff = await request('POST', '/api/life/phone/check', { body: {}, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('life write with CSRF but the engine stopped → 409 (not 500)', lifeOff.status === 409, `got ${lifeOff.status}`);
    const advNoCsrf = await request('POST', '/api/influence/advice/1/approve', { body: {} });
    check('readonly=false → advice approve without CSRF 403', advNoCsrf.status === 403, `got ${advNoCsrf.status}`);
    const advOff = await request('POST', '/api/influence/advice/1/reject', { body: {}, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('advice reject with CSRF but the engine stopped → 409 (not 500)', advOff.status === 409, `got ${advOff.status}`);
    // 016 scenes: the read answers an off shape, the owner writes 409 while life is stopped.
    const scRead = await request('GET', '/api/arcs/scenes/1');
    const scEdit = await request('PUT', '/api/arcs/scenes/1/text', { body: { text: 'x' }, headers: { 'X-CSRF-Token': jar.csrf_token } });
    const scRegen = await request('POST', '/api/arcs/scenes/1/regenerate', { body: {}, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('scenes (016): GET off shape 200; edit / regenerate with CSRF but life stopped → 409',
      scRead.status === 200 && scRead.json?.enabled === false && scEdit.status === 409 && scRegen.status === 409, `${scRead.status} ${scEdit.status} ${scRegen.status}`);
    // Owner vibe / language: marked as the owner's, handed back on request (audited).
    const gv = await request('PATCH', `/api/groups/${encodeURIComponent(SEED_GROUP)}`, { body: { vibe: 'owner vibe', language: 'Hindi' }, headers: { 'X-CSRF-Token': jar.csrf_token } });
    const gAfter = await request('GET', `/api/groups/${encodeURIComponent(SEED_GROUP)}`);
    check('group PATCH vibe + language → set by owner (GET shows the sources)', gv.status === 200 && gAfter.json?.vibe === 'owner vibe'
      && gAfter.json?.language === 'Hindi' && gAfter.json?.field_sources?.vibe === 'owner' && gAfter.json?.field_sources?.language === 'owner',
      `${gv.status} ${JSON.stringify(gAfter.json?.field_sources)}`);
    const { learnVibe } = await import('../src/memory/groupStore.js');
    learnVibe(SEED_GROUP, 'learned vibe');
    check('…learning cannot overwrite it', getDb().prepare('SELECT vibe FROM groups WHERE jid = ?').pluck().get(SEED_GROUP) === 'owner vibe');
    const gRel = await request('PATCH', `/api/groups/${encodeURIComponent(SEED_GROUP)}`, { body: { release: ['vibe', 'language'] }, headers: { 'X-CSRF-Token': jar.csrf_token } });
    learnVibe(SEED_GROUP, 'learned vibe');
    const gBack = (await request('GET', `/api/groups/${encodeURIComponent(SEED_GROUP)}`)).json;
    check('…hand back: learning writes again, language back to en, audited', gRel.status === 200 && gBack?.vibe === 'learned vibe'
      && gBack?.language === 'en' && gBack?.field_sources?.vibe === 'learned' && gBack?.field_sources?.language === 'default'
      && !!getDb().prepare("SELECT 1 FROM dashboard_audit WHERE action = 'group.patch' AND target = ? AND payload_json LIKE '%released%'").get(SEED_GROUP));
    const gBad = await request('PATCH', `/api/groups/${encodeURIComponent(SEED_GROUP)}`, { body: { release: ['name'] }, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('…release of an unknown field → 400', gBad.status === 400, `got ${gBad.status}`);

    // ── audit fixes (dashback) ──
    const H = { 'X-CSRF-Token': jar.csrf_token };
    // .env line injection: no CR/LF/NUL in a mutable string or a provider key.
    const modelBefore = config.roles.mouth.model;
    const inj = await request('PATCH', '/api/config', { body: { 'roles.mouth.model': 'x\nWEB_BROWSE_ALLOW_PRIVATE=true' }, headers: H });
    check('PATCH a role model with a newline → rejected, value unchanged',
      !!inj.json?.rejected?.['roles.mouth.model'] && config.roles.mouth.model === modelBefore,
      `${inj.status} ${JSON.stringify(inj.json?.rejected)} model=${JSON.stringify(config.roles.mouth.model)}`);
    const orBefore = config.llm.openrouterApiKey;
    const keyInj = await request('POST', '/api/llm/keys', { body: { field: 'openrouterApiKey', value: 'sk-x\nLLM_BASE_URL=http://169.254.169.254' }, headers: H });
    check('POST /api/llm/keys with a newline in the value → 400, key unchanged',
      keyInj.status === 400 && config.llm.openrouterApiKey === orBefore, `got ${keyInj.status}`);
    {
      // The xAI key field: settable, persisted through the isolated path, never echoed.
      const XAI = 'xai-FAKEdashkey00000001';
      const flag = async () => (await request('GET', '/api/llm/roles')).json?.keys?.xai;
      check('xai key flag starts false', (await flag()) === false);
      const page = await request('GET', '/js/pages/settings.js');
      check('the API keys panel lists XAI_API_KEY', page.status === 200 && page.text.includes("['xaiApiKey', 'XAI_API_KEY', 'xai']"));
      const envDir = fs.mkdtempSync(path.join(ROOT, 'data', `k007-xai-${process.pid}-`));
      const rootBefore = config.projectRoot;
      config.projectRoot = envDir;
      try {
        fs.writeFileSync(path.join(envDir, '.env'), 'A=1\n');
        const set = await request('POST', '/api/llm/keys', { body: { field: 'xaiApiKey', value: XAI, persist: true }, headers: H });
        check('POST /api/llm/keys sets xaiApiKey', set.status === 200 && config.llm.xaiApiKey === XAI, `got ${set.status}`);
        check('…the reply never holds the value', !set.text.includes(XAI));
        check('…the flag turns true, booleans only', (await flag()) === true);
        const env = fs.readFileSync(path.join(envDir, '.env'), 'utf-8');
        check('…persist writes XAI_API_KEY to .env, and only that', env.includes(`XAI_API_KEY=${XAI}`) && !/OPENROUTER_API_KEY/.test(env));
        const cfg = await request('GET', '/api/config');
        check('/api/config says configured, without the value', cfg.json?.values?.llm?.xaiKeyConfigured === true && !cfg.text.includes(XAI));
        check('/api/config offers the direct Grok ids', cfg.json?.models?.xai?.includes('grok-4.7'));
        const audit = getDb().prepare("SELECT * FROM dashboard_audit WHERE action = 'llm.keys.set' ORDER BY id DESC LIMIT 1").get();
        check('the audit names the field, never the value', JSON.stringify(audit).includes('xaiApiKey') && !JSON.stringify(audit).includes(XAI));
        const models = await request('GET', '/api/llm/roles');
        check('/api/llm/roles offers provider xai, no value', models.json?.providers?.includes('xai') && !models.text.includes(XAI));
      } finally {
        config.projectRoot = rootBefore;
        config.llm.xaiApiKey = '';
        fs.rmSync(envDir, { recursive: true, force: true });
      }
    }
    {
      const { writeEnvVars, computeEnvDiff } = await import('../src/dashboard/envWriter.js');
      const envDir = fs.mkdtempSync(path.join(ROOT, 'data', `k007-env-${process.pid}-`));
      const rootBefore = config.projectRoot;
      config.projectRoot = envDir;
      try {
        fs.writeFileSync(path.join(envDir, '.env'), 'A=1\n');
        let threw = false;
        try { writeEnvVars({ A: '2\nB=3' }); } catch { threw = true; }
        check('writeEnvVars refuses a value with a control character (file untouched)',
          threw && fs.readFileSync(path.join(envDir, '.env'), 'utf-8') === 'A=1\n');
        const w1 = writeEnvVars({ A: '2' });
        const w2 = writeEnvVars({ A: '3' });
        check('two .env writes in the same second keep two backups (the first holds the original)',
          !!w1.backup && !!w2.backup && w1.backup !== w2.backup && fs.readFileSync(w1.backup, 'utf-8') === 'A=1\n'
          && fs.readFileSync(w2.backup, 'utf-8') === 'A=2\n', `${w1.backup} ${w2.backup}`);
        writeEnvVars({ M: 'a#b' });
        check('a value with # is quoted so dotenv reads it whole',
          /^M='a#b'$/m.test(fs.readFileSync(path.join(envDir, '.env'), 'utf-8')) && Array.isArray(computeEnvDiff().diffs));
      } finally {
        config.projectRoot = rootBefore;
        fs.rmSync(envDir, { recursive: true, force: true });
      }
    }
    // Instagram queue approve: the state guard runs before anything is written.
    for (const st of ['vetoed', 'sent', null]) {
      const id = getDb().prepare("INSERT INTO ig_reels (account, share_state) VALUES ('acct', ?)").run(st).lastInsertRowid;
      const r = await request('POST', `/api/instagram/queue/${id}/approve`, { body: { caption: 'hi' }, headers: H });
      const row = getDb().prepare('SELECT share_state, share_caption FROM ig_reels WHERE id = ?').get(id);
      check(`IG approve of a ${st || 'never-queued'} reel → 409, state + caption untouched, not audited`,
        r.status === 409 && row.share_state === st && row.share_caption === null
        && !getDb().prepare("SELECT 1 FROM dashboard_audit WHERE action = 'instagram.approve' AND target = ?").get(String(id)),
        `${r.status} ${JSON.stringify(row)}`);
    }
    // Mute: a bad duration is refused, an unknown group 404s.
    const muteBad = await request('POST', `/api/groups/${encodeURIComponent(SEED_GROUP)}/mute`, { body: { durationMinutes: 'abc' }, headers: H });
    const muteNeg = await request('POST', `/api/groups/${encodeURIComponent(SEED_GROUP)}/mute`, { body: { durationMinutes: -5 }, headers: H });
    const muteUnknown = await request('POST', `/api/groups/${encodeURIComponent('120363999999999999@g.us')}/mute`, { body: {}, headers: H });
    check('mute with a non-numeric / negative duration → 400 and not muted; unknown group → 404',
      muteBad.status === 400 && muteNeg.status === 400 && muteUnknown.status === 404
      && !getDb().prepare('SELECT 1 FROM muted_groups WHERE jid IN (?, ?)').get(SEED_GROUP, '120363999999999999@g.us'),
      `${muteBad.status} ${muteNeg.status} ${muteUnknown.status}`);
    // Bill EXPIRE: open bills only.
    const billId = getDb().prepare("INSERT INTO bill_splits (group_jid, bill_json, state) VALUES (?, '{}', 'COMPLETED')").run(SEED_GROUP).lastInsertRowid;
    const bx = await request('POST', `/api/bills/${billId}/expire`, { body: {}, headers: H });
    const openId = getDb().prepare("INSERT INTO bill_splits (group_jid, bill_json, state) VALUES (?, '{}', 'ACTIVE')").run(SEED_GROUP).lastInsertRowid;
    const bo = await request('POST', `/api/bills/${openId}/expire`, { body: {}, headers: H });
    const bMissing = await request('POST', '/api/bills/999999/expire', { body: {}, headers: H });
    const bState = (id) => getDb().prepare('SELECT state FROM bill_splits WHERE id = ?').pluck().get(id);
    check('bill EXPIRE: COMPLETED → 409 (kept), ACTIVE → 200 EXPIRED, unknown → 404',
      bx.status === 409 && bState(billId) === 'COMPLETED' && bo.status === 200 && bState(openId) === 'EXPIRED' && bMissing.status === 404,
      `${bx.status}/${bState(billId)} ${bo.status}/${bState(openId)} ${bMissing.status}`);
    // Voice delete under an alternate form of the person's JID.
    {
      const LID = '77700000077@lid';
      getDb().prepare("INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', unixepoch())").run(LID, SEED_PERSON);
      const { savePersonVoice } = await import('../src/memory/voiceStore.js');
      savePersonVoice({ personJid: SEED_PERSON, voiceId: 'voice_test', languageCode: 'en-US', consentRef: 'test', via: 'dashboard', expireTime: null });
      const vd = await request('DELETE', `/api/people/${encodeURIComponent(LID)}/voice`, { headers: H });
      const vRow = getDb().prepare('SELECT revoked_at FROM person_voice WHERE person_jid = ?').get(SEED_PERSON);
      check('voice DELETE under the LID form → revokes the canonical person\'s voice', vd.status === 200 && !!vRow?.revoked_at, `got ${vd.status}`);
    }
    // /api/llm/test: 10/min, loopback not exempt (an unknown provider → 400, no model call).
    {
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await request('POST', '/api/llm/test', { body: { provider: 'nope' }, headers: H })).status);
      check('/api/llm/test is limited on loopback (11th call → 429)', codes.slice(0, 10).every((c) => c === 400) && codes[10] === 429, codes.join(','));
    }
    // Session cookie: the issue time is signed and checked on the server.
    {
      const { sign } = await import('@fastify/cookie');
      const secret = config.dashboard.cookieSecret;
      const saved = jar.dash_session;
      const old = Math.floor(Date.now() / 1000) - 31 * 86400;
      jar.dash_session = encodeURIComponent(sign(`${old}.${'a'.repeat(32)}`, secret));
      const stale = await request('GET', '/api/status');
      jar.dash_session = encodeURIComponent(sign('b'.repeat(32), secret));
      const bare = await request('GET', '/api/status');
      jar.dash_session = saved;
      const fresh = await request('GET', '/api/status');
      check('a 31-day-old or bare-nonce session cookie → 401; the issued one → 200',
        stale.status === 401 && bare.status === 401 && fresh.status === 200, `${stale.status} ${bare.status} ${fresh.status}`);
    }
    config.dashboard.readOnly = true;
    const lifeRo = await request('POST', '/api/life/events/1/revert', { body: {}, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('readonly=true → life revert 403', lifeRo.status === 403, `got ${lifeRo.status}`);
    const advRo = await request('POST', '/api/influence/advice/1/approve', { body: {}, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('readonly=true → advice approve 403', advRo.status === 403, `got ${advRo.status}`);
    const scRo = await request('POST', '/api/arcs/scenes/1/regenerate', { body: {}, headers: { 'X-CSRF-Token': jar.csrf_token } });
    check('readonly=true → scene regenerate 403', scRo.status === 403, `got ${scRo.status}`);
    config.dashboard.readOnly = false;
    const sse = await openSse('/api/stream?topics=logs', { headers: { 'X-CSRF-Token': 'nope' } });
    check('SSE GET needs no CSRF token (read-only)', sse.status === 200);
    closeSse(sse);
    config.dashboard.readOnly = true;
  }

  // ── frontend units (node, no DOM) ──────────────────────────────────────────
  {
    const { createMux } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/stream.js')).href);
    const sources = [];
    class FakeES {
      constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; this.readyState = 1; sources.push(this); }
      addEventListener(evt, fn) { if (!this.listeners.has(evt)) this.listeners.set(evt, new Set()); this.listeners.get(evt).add(fn); }
      removeEventListener(evt, fn) { this.listeners.get(evt)?.delete(fn); }
      close() { this.closed = true; this.readyState = 2; }
      emit(evt, data, lastEventId = '') { for (const fn of this.listeners.get(evt) || []) fn({ data: JSON.stringify(data), lastEventId }); }
    }
    const mux = createMux(FakeES, { debounceMs: 0 });
    let fired = 0;
    for (let i = 0; i < 50; i++) {
      const off1 = mux.subscribe('logs', () => { fired++; });
      const off2 = mux.subscribe('decisions', () => { fired++; });
      await sleep(1);
      off1(); off2();
    }
    await sleep(5);
    const open = sources.filter((s) => !s.closed);
    check('mux: 50 subscribe/dispose cycles → 0 handlers', mux.handlerCount() === 0, `handlers=${mux.handlerCount()}`);
    check('mux: ≤ 1 open EventSource after the cycles', open.length <= 1, `open=${open.length}`);
    check('mux: no EventSource left once nothing is subscribed', open.length === 0, `open=${open.length}`);

    let got = 0;
    const offA = mux.subscribe('logs', () => { got++; });
    const offB = mux.subscribe('decisions', () => { got++; });
    await sleep(5);
    const live = sources.filter((s) => !s.closed);
    check('mux: one EventSource carries the union of topics', live.length === 1 && /topics=decisions%2Clogs|topics=decisions,logs|topics=logs%2Cdecisions|topics=logs,decisions/.test(live[0].url), live.map((s) => s.url).join(' '));
    live[0].emit('logs', { id: 7 }, 'logs:7');
    live[0].emit('decisions', { x: 1 });
    check('mux: events reach their topic handlers', got === 2, `got=${got}`);
    offA();
    await sleep(5);
    const stale = live[0];
    stale.emit('logs', { id: 8 }, 'logs:8');
    check('mux: a disposed handler never fires again', got === 2);
    const now = sources.filter((s) => !s.closed);
    check('mux: topic change reconnects with the remaining topics', now.length === 1 && /topics=decisions/.test(now[0].url) && !/logs/.test(now[0].url.split('since')[0].split('topics=')[1] || ''));
    offB();
    await sleep(5);
    const offC = mux.subscribe('logs', () => {});
    await sleep(5);
    const re = sources.filter((s) => !s.closed);
    check('mux: re-subscribing to logs resumes via ?since=logs:<last id>', re.length === 1 && /since=logs(%3A|:)7/.test(re[0].url), re.map((s) => s.url).join(' '));
    offC();
    mux.close();

    // A non-200 (e.g. 429) ends an EventSource CLOSED for good → the mux retries with backoff.
    {
      const srcs = [];
      class ClosingES extends FakeES { constructor(url) { super(url); srcs.push(this); } }
      const rmux = createMux(ClosingES, { debounceMs: 0, retryDelaysMs: [10, 20] });
      const offR = rmux.subscribe('logs', () => {});
      await sleep(5);
      const first = srcs.at(-1);
      first.readyState = 0; first.emit('error', {});
      await sleep(30);
      check('mux: error while the browser is reconnecting (readyState 0) → no extra source', srcs.length === 1, `sources=${srcs.length}`);
      first.readyState = 2; first.emit('error', {});
      await sleep(30);
      check('mux: error with readyState CLOSED → reopens after the backoff', srcs.length === 2 && first.closed && !srcs[1].closed && /topics=logs/.test(srcs[1].url), `sources=${srcs.length}`);
      srcs[1].readyState = 2; srcs[1].emit('error', {});
      rmux.close();
      await sleep(40);
      check('mux: close() cancels a pending retry', srcs.length === 2 && srcs.every((x) => x.closed), `sources=${srcs.length}`);
      offR();
    }

    const { html, raw, renderToString } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const out = renderToString(html`<div title="${evil}">${evil}${[html`<b>${evil}</b>`, 'x<y']}${raw('<i>ok</i>')}${null}${undefined}${false}</div>`);
    check('html``: every interpolation escaped, nested html + raw pass through',
      !out.includes('<img') && out.includes('&lt;img') && out.includes('&quot;') && out.includes('&#39;') && out.includes('<b>&lt;img') && out.includes('x&lt;y') && out.includes('<i>ok</i>') && !/null|undefined|false/.test(out), out);

    const { createRouter } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/router.js')).href);
    const writes = [];
    let resolveSlow;
    const routes = [
      { hash: 'slow', re: /^#slow$/, load: async () => ({ mount: async (ctx) => { await new Promise((r) => { resolveSlow = r; }); if (ctx.alive()) writes.push('slow'); } }) },
      { hash: 'fast', re: /^#fast$/, load: async () => ({ mount: async (ctx) => { if (ctx.alive()) writes.push('fast'); } }) },
    ];
    const fakeWin = { location: { hash: '#slow' }, addEventListener() {}, removeEventListener() {}, setInterval, clearInterval, scrollTo() {} };
    const router = createRouter({ routes, win: fakeWin, onRoute() {}, onUnknown() {}, stream: null });
    const p1 = router.navigate('#slow');
    await sleep(5);
    const disposedSignals = [];
    const p2 = router.navigate('#fast');
    await p2;
    resolveSlow();
    await p1;
    check('router: a stale async render does not write after navigation', writes.join(',') === 'fast', writes.join(','));
    check('router: each navigation bumps the generation token', router.generation() === 2, `gen=${router.generation()}`);
    void disposedSignals;
  }

  // ── map-* (spec 014 §B): vendored Leaflet, the one tooltip sink, fallbacks ─
  {
    const VENDOR = path.join(PUBLIC, 'vendor/leaflet/1.9.4');
    // Pinned: Leaflet 1.9.4 from the npm tarball (registry integrity sha512-nxS1ynzJ…FA74PA==).
    const PINNED = {
      'leaflet-src.esm.js': '39ee93464f11fe3847137e50c0dc8189f706c460e36989ea7871bf7d540f3306',
      'leaflet.css': 'a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6',
      LICENSE: '53e8dc25862014e4324741ca18fbe3611e11d42ef69f59f86ea8c5389647d4cb',
    };
    const sums = fs.existsSync(path.join(VENDOR, 'SHA256SUMS'))
      ? Object.fromEntries(fs.readFileSync(path.join(VENDOR, 'SHA256SUMS'), 'utf-8').trim().split('\n').map((l) => l.trim().split(/\s+/).reverse()))
      : {};
    const actual = Object.fromEntries(Object.keys(PINNED).map((f) => [f, fs.existsSync(path.join(VENDOR, f)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR, f))).digest('hex') : null]));
    check('map-vendor: Leaflet 1.9.4 files match SHA256SUMS and the pinned hashes',
      Object.keys(PINNED).every((f) => actual[f] === PINNED[f] && sums[f] === PINNED[f]) && Object.keys(sums).length === 3,
      JSON.stringify({ actual, sums }));
    check('map-vendor: no marker images, no other files', fs.readdirSync(VENDOR).sort().join(',') === 'LICENSE,SHA256SUMS,leaflet-src.esm.js,leaflet.css', fs.readdirSync(VENDOR).join(','));
    const vjs = await request('GET', '/vendor/leaflet/1.9.4/leaflet-src.esm.js');
    const vcss = await request('GET', '/vendor/leaflet/1.9.4/leaflet.css');
    check('map-vendor: served under auth with JS / CSS content types',
      vjs.status === 200 && /javascript/.test(vjs.headers['content-type'] || '') && vjs.text.includes('Leaflet 1.9.4')
      && vcss.status === 200 && /text\/css/.test(vcss.headers['content-type'] || ''), `${vjs.status} ${vjs.headers['content-type']} / ${vcss.status}`);
    const vanon = await request('GET', '/vendor/leaflet/1.9.4/leaflet-src.esm.js', { cookies: false });
    check('map-vendor: unauthenticated → 401', vanon.status === 401, `got ${vanon.status}`);
    check('map-vendor: index.html does not load Leaflet (the map component imports it lazily)', !/vendor\/leaflet/.test(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf-8')));

    // The sink ban (R15): page data reaches Leaflet only as text.
    const msrc = (f) => fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf-8');
    const code = (t) => t.replace(/^\s*\/\/.*$/gm, '');
    const leafSrc = code(msrc('components/leafmap.js'));
    const count = (t, re) => (t.match(re) || []).length;
    check('map-sinks: leafmap.js binds tooltips once (a text node), attribution once, setPrefix(false) only',
      count(leafSrc, /bindTooltip\(/g) === 1 && /bindTooltip\(node,/.test(leafSrc) && /node\.textContent = /.test(leafSrc)
      && count(leafSrc, /addAttribution\(/g) === 1 && count(leafSrc, /setPrefix\(/g) === 1 && /setPrefix\(false\)/.test(leafSrc)
      && !/bindPopup|setContent|divIcon|innerHTML|outerHTML|insertAdjacentHTML|\bL\.marker\(|\.marker\(/.test(leafSrc));
    check('map-sinks: the tile layer gets referrerPolicy origin and no attribution option',
      /tileLayer\(tileUrl, \{[^}]*referrerPolicy: 'origin'[^}]*\}\)/.test(leafSrc) && !/tileLayer\([^)]*attribution/.test(leafSrc));
    const jsDir = path.join(PUBLIC, 'js');
    const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walkJs(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const sinkHits = walkJs(jsDir).filter((f) => !f.endsWith(`components${path.sep}leafmap.js`))
      .filter((f) => /bindPopup|bindTooltip|setContent\(|divIcon|addAttribution|setPrefix\(|tileLayer\(/.test(code(fs.readFileSync(f, 'utf-8'))))
      .map((f) => path.relative(jsDir, f));
    check('map-sinks: no Leaflet HTML entry point outside leafmap.js', !sinkHits.length, sinkHits.join(','));
    check('map-load: Leaflet only by dynamic import of the vendored file (no static import, no CDN)',
      /import\('\.\.\/\.\.\/vendor\/leaflet\/1\.9\.4\/leaflet-src\.esm\.js'\)/.test(leafSrc) && !/^import .*vendor/m.test(leafSrc)
      && !/https?:\/\/(?!www\.openstreetmap\.org\/copyright)/.test(leafSrc)
      && walkJs(jsDir).every((f) => f.endsWith(`components${path.sep}leafmap.js`) || !/vendor\/leaflet/.test(fs.readFileSync(f, 'utf-8'))));
    check('map-pages: Map and Day mount Leaflet with the SVG grid as the fallback',
      ['pages/life-map.js', 'pages/life-day.js'].every((f) => msrc(f).includes('mountMap(') && msrc(f).includes('mapSvg(')));

    // leafmap.js in node: an import failure → null (the page draws its grid); a fake Leaflet records what it is given.
    const leaf = await import(pathToFileURL(path.join(PUBLIC, 'js/components/leafmap.js')).href);
    const fakeDoc = { head: {}, getElementById: () => ({}), createElement: (tag) => ({ tag, textContent: '' }) };
    check('map-load: no DOM → loadLeaflet() is null (no throw)', (await leaf.loadLeaflet()) === null);
    check('map-load: a failing import → null', (await leaf.loadLeaflet({ importer: () => Promise.reject(new Error('blocked')), doc: fakeDoc })) === null);
    check('map-load: a module without the Leaflet API → null', (await leaf.loadLeaflet({ importer: async () => ({}), doc: fakeDoc })) === null);
    check('map-load: mountMap with Leaflet unavailable → null', (await leaf.mountMap({}, { tileUrl: 'https://tiles.invalid/{z}/{x}/{y}.png', load: async () => null, doc: fakeDoc })) === null);
    const calls = [];
    const group = () => { const g = { items: [], addTo() { return g; }, clearLayers() { g.items = []; }, addLayer(x) { g.items.push(x); return g; } }; return g; };
    const shape = (kind) => (a, o) => ({ kind, a, o, tip: null, bindTooltip(node, opts) { this.tip = { node, opts }; return this; } });
    const fakeL = {
      map: (el, o) => { calls.push(['map', o]); return { attributionControl: { setPrefix: (v) => calls.push(['setPrefix', v]), addAttribution: (t) => calls.push(['addAttribution', t]) }, invalidateSize() {}, remove: () => calls.push(['remove']), setView: (p, z) => calls.push(['setView', p, z]), fitBounds: (b) => calls.push(['fitBounds', b]) }; },
      tileLayer: (url, o) => { calls.push(['tileLayer', url, o]); return { addTo() {} }; },
      control: { scale: () => ({ addTo() {} }) },
      layerGroup: group,
      latLngBounds: (pts) => ({ pts, pad() { return this; } }),
      circle: shape('circle'), circleMarker: shape('circleMarker'), polyline: shape('polyline'),
    };
    const disposers = [];
    const fctx = { alive: () => true, onDispose: (fn) => disposers.push(fn) };
    const elClasses = [];
    const h = await leaf.mountMap({ classList: { add: (c) => elClasses.push(c) } }, { tileUrl: 'https://tiles.invalid/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', ctx: fctx, load: async () => fakeL, doc: fakeDoc });
    const tl = calls.find((c) => c[0] === 'tileLayer');
    const attr = calls.filter((c) => c[0] === 'addAttribution');
    check('map-mount: tiles from the server URL, referrerPolicy origin, no attribution option, one escaped attribution',
      !!h && tl?.[1] === 'https://tiles.invalid/{z}/{x}/{y}.png' && tl[2].referrerPolicy === 'origin' && !('attribution' in tl[2])
      && calls.some((c) => c[0] === 'setPrefix' && c[1] === false) && attr.length === 1 && /OpenStreetMap contributors<\/a> · Leaflet$/.test(attr[0][1])
      && /href="https:\/\/www\.openstreetmap\.org\/copyright"/.test(attr[0][1]), JSON.stringify(calls));
    check('map-mount: attribution text is escaped', !/<script/.test(leaf.attributionMarkup('x', '<script>alert(1)</script> OpenStreetMap')) && leaf.attributionMarkup(null, 'x') === 'no tiles · Leaflet');
    const target = shape('t')();
    const evil = '<img src=x onerror=alert(1)>';
    h.textTooltip(target, evil);
    check('map-mount: textTooltip binds a span whose textContent is the raw text (never markup)', target.tip?.node?.tag === 'span' && target.tip.node.textContent === evil);
    disposers.forEach((fn) => fn());
    check('map-mount: disposed with the page (map.remove)', calls.some((c) => c[0] === 'remove'));
    calls.length = 0;
    const h0 = await leaf.mountMap({ classList: { add: (c) => elClasses.push(c) } }, { tileUrl: null, attribution: null, ctx: fctx, load: async () => fakeL, doc: fakeDoc });
    check('map-mount: no tile URL → no tile layer, a plain background, "no tiles" attribution',
      !!h0 && !calls.some((c) => c[0] === 'tileLayer') && elClasses.includes('leaf-notiles') && calls.find((c) => c[0] === 'addAttribution')?.[1] === 'no tiles · Leaflet');
    check('map-mount: a page gone during the load → null', (await leaf.mountMap({}, { tileUrl: null, ctx: { alive: () => false }, load: async () => fakeL, doc: fakeDoc })) === null);

    // The page helpers: routed vs straight, planned dashed, home as an area, VENUE/AREA columns.
    const lm = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-map.js')).href);
    const mplaces = [
      { id: 'p:home', name: 'Home', kind: 'home', lat: 0.01, lon: 0.01, area: null, venue: false },
      { id: 'p:office', name: 'Office', kind: 'office', lat: 0.048, lon: 0.042, area: null, venue: false },
      { id: 'p:cafe', name: 'Bean <b>', kind: 'cafe', lat: 0.016, lon: 0.0175, area: 'Invented Quarter', venue: true },
    ];
    const mtrips = [
      { from: 'p:home', to: 'p:office', mode: 'cab', startAt: 1793000000, endAt: 1793001200, arrivedAt: 1793001300, eventId: 7, pts: [[0.01, 0.01], [0.03, 0.02], [0.048, 0.042]] },
      { from: 'p:office', to: 'p:cafe', mode: 'walk', startAt: 1793010000, endAt: 1793011800, arrivedAt: null, eventId: 9 },
      { from: 'p:cafe', to: 'p:home', mode: 'walk', startAt: 1793020000, endAt: 1793020900, arrivedAt: null, eventId: null, planned: true },
    ];
    const mm = { running: true, places: mplaces, trips: mtrips, position: { lat: 0.02, lon: 0.02, travelling: true }, home: { placeId: 'p:home', lat: 0.01, lon: 0.01, radiusM: 400 }, tileUrl: 'https://tiles.invalid/{z}/{x}/{y}.png' };
    check('map-page: Leaflet only with tiles and life running', lm.wantsLeaflet(mm) && !lm.wantsLeaflet({ ...mm, tileUrl: null }) && !lm.wantsLeaflet({ ...mm, running: false }));
    const byIdM = new Map(mplaces.map((p) => [p.id, p]));
    check('map-page: a trip with pts follows them, one without is a straight line, unknown places → none',
      lm.tripLine(mtrips[0], byIdM).routed === true && lm.tripLine(mtrips[0], byIdM).latlngs.length === 3
      && JSON.stringify(lm.tripLine(mtrips[1], byIdM)) === JSON.stringify({ latlngs: [[0.048, 0.042], [0.016, 0.0175]], routed: false })
      && lm.tripLine({ from: 'x', to: 'y' }, byIdM) === null);
    const layers = new Map();
    const fh = { L: fakeL, layer: (n) => { if (!layers.has(n)) layers.set(n, group()); return layers.get(n); }, textTooltip: (t, text, o) => { t.text = text; t.tipOpts = o; return t; } };
    lm.drawLeaf(fh, mm);
    lm.drawMe(fh, mm.position);
    const tripsL = layers.get('trips').items;
    const homeL = layers.get('home').items;
    const placesL = layers.get('places').items;
    check('map-page: planned trips dashed, done ones solid, routed ones along their pts',
      tripsL.length === 3 && tripsL.filter((x) => x.o.dashArray).length === 1 && /is-planned/.test(tripsL.find((x) => x.o.dashArray).o.className)
      && tripsL.some((x) => x.a.length === 3 && /is-routed/.test(x.o.className)) && tripsL.every((x) => typeof x.text === 'string'));
    check('map-page: home is a 400 m circle and not also a dot; other places are circle markers',
      homeL.length === 1 && homeL[0].kind === 'circle' && homeL[0].o.radius === 400
      && placesL.length === 2 && placesL.every((x) => x.kind === 'circleMarker') && !placesL.some((x) => x.a[0] === 0.01 && x.a[1] === 0.01));
    check('map-page: tooltips carry text only (names unescaped, as text)', placesL.some((x) => x.text === 'Bean <b>') && lm.placeTip(mplaces[2]) === 'Bean <b> · cafe · Invented Quarter · real venue');
    check('map-page: his position is its own layer', layers.get('me').items.length === 1 && /is-moving/.test(layers.get('me').items[0].o.className));
    check('map-page: the redraw signature changes with the trips only', lm.leafSig(mm) === lm.leafSig({ ...mm, position: { lat: 1, lon: 1 } })
      && lm.leafSig(mm) !== lm.leafSig({ ...mm, trips: mtrips.slice(1) }));
    const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const t1 = lm.placeTable(mplaces);
    const t0 = lm.placeTable(mplaces.map((p) => ({ ...p, area: null, venue: false })));
    check('map-page: PLACES shows VENUE / AREA only when a row carries them', /VENUE<\/th><th>AREA/.test(rts(t1.head)) && rts(t1.rows).includes('Invented Quarter')
      && !/VENUE/.test(rts(t0.head)) && rts(t1.rows).includes('Bean &lt;b&gt;'));
    const svg = rts(lm.mapSvg(mm));
    check('map-page: the SVG fallback draws pts as a polyline and planned trips dashed', /<polyline points="/.test(svg) && /lm-trip[^"]*is-planned/.test(svg));
    const ld = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-day.js')).href);
    check('map-day: fits the day\'s trips, else home; the note counts trips and roads',
      ld.dayFitPoints(mm).length === 6 && JSON.stringify(ld.dayFitPoints({ ...mm, trips: [] })) === '[[0.01,0.01]]'
      && ld.dayMapNote(mm, null) === '2 TRIPS + 1 PLANNED · 1 BY ROAD · LOCAL GRID' && /LEAFLET$/.test(ld.dayMapNote(mm, {})));

    const GUIDES_DAY = async () => (await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href)).GUIDES['life/day']();
    {
      const lp = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-phone.js')).href);
      const dsrc2 = fs.readFileSync(path.join(ROOT, 'src/life/story/director.js'), 'utf8');
      const m = dsrc2.match(/export const TEXT_TONES = Object\.freeze\(\[([^\]]*)\]\)/);
      const serverTones = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
      check('phone: SEND A TEXT offers exactly the Director\'s tones as a dropdown (no free-typed bad_tone)', JSON.stringify(lp.TEXT_TONES) === JSON.stringify(serverTones)
        && /<select name="tone"/.test(rts(lp.sendForm({ name: 'X', departed: false }, false))), { page: lp.TEXT_TONES, server: serverTones });
      const fd = (o) => ({ get: (k) => o[k] ?? null });
      check('phone: an unknown typed tone is dropped, a known one is sent lowercased', !('tone' in lp.sendAction('cast:x', fd({ gist: 'g', tone: 'Horny' }))) && lp.sendAction('cast:x', fd({ gist: 'g', tone: 'Naughty' })).tone === 'naughty');
    }
    // Day page at phone width (2026-10-31): folded quiet rows, money in words, the bottom sheet.
    {
      const q = (at, cat, kind) => ({ row: 'tick', at, cat, kind, eventId: at });
      const rows = [q(1, 'phone'), q(2, 'phone'), q(3, 'mind', 'glance'), { row: 'span', at: 4, cat: 'activity' }, q(5, 'phone'), q(6, 'phone'), q(7, 'mind', 'think'), { ...q(8, 'phone'), future: true }];
      const f = ld.foldQuiet(rows);
      check('day-mobile: ≥ 3 phone checks / glances in a row fold into one quiet row; 2, a think or a future row never',
        f.length === 6 && f[0].row === 'quiet' && f[0].phone === 2 && f[0].glance === 1 && f[0].rows.length === 3 && f[1].row === 'span' && f.filter((r) => r.row === 'quiet').length === 1, f.map((r) => r.row));
      const fo = ld.foldQuiet(rows, new Set([f[0].key]));
      check('day-mobile: an open fold keeps its row and shows its rows under it', fo[0].row === 'quiet' && fo[0].open === true && fo.length === 9 && fo[1].at === 1);
      check('day-mobile: the fold in words', ld.quietText(f[0]) === '2 phone checks · 1 mind glance', ld.quietText(f[0]));
      check('day-mobile: money rows in words (salary in, your income / expense / set with its label, a spend and what for)',
        ld.moneyText('money.salary', { amount: 175000 }).startsWith('salary +') && ld.moneyText('money.adjusted', { mode: 'income', amount: 300000, label: 'Broke his FD' }).startsWith('you added +')
        && ld.moneyText('money.adjusted', { mode: 'income', amount: 1, label: 'Broke his FD' }).endsWith('· Broke his FD') && ld.moneyText('money.adjusted', { mode: 'expense', amount: 5 }).startsWith('you took −')
        && ld.moneyText('money.adjusted', { mode: 'set', amount: 9 }).startsWith('you set his money to') && ld.moneyText('money.spent', { amount: 680, for: 'food', kind: 'hangout' }) === 'spent −680 · food · hangout'
        && !/spent/.test(ld.moneyText('money.adjusted', { mode: 'income', amount: 3 })));
      const css = fs.readFileSync(path.join(PUBLIC, 'css/components.css'), 'utf8');
      const dsrc = msrc('pages/life-day.js');
      check('day-mobile: the day and WHY stack under 900 px (after .ld-cols), WHY / HOW IT WENT is a bottom sheet under 720 px, still motion-safe',
        /@media \(max-width: 900px\) \{\s*\.ld-cols \{ grid-template-columns: 1fr; \}/.test(css) && css.indexOf('@media (max-width: 900px) {\n  .ld-cols') > css.indexOf('.ld-cols { grid-template-columns: 2fr 1fr')
        && /\.ld-side \{ position: fixed;[^}]*transform: translateY\(100%\)/.test(css) && /\.ld-side\.is-open \{ transform: none/.test(css) && /prefers-reduced-motion[^{]*\{\s*\.ld-side, \.ld-side\.is-open \{ transition: none/.test(css));
      check('day-mobile: CLOSE / Escape close the sheet, ALL ROWS is remembered behind try/catch, a fold is a real button',
        dsrc.includes('id="ldSideClose"') && /'Escape' && side\?\.classList\.contains\('is-open'\)/.test(dsrc) && /try \{ allRows = localStorage\.getItem\('ld\.day\.allRows'\)/.test(dsrc)
        && /try \{ localStorage\.setItem\('ld\.day\.allRows'/.test(dsrc) && /<button type="button" class="ld-row ld-quiet/.test(dsrc) && /aria-expanded=/.test(dsrc));
      check('day-scene: an outing\'s decision row opens that outing\'s scene; a row without one clears the panel (never another outing\'s scene)',
        /sceneOf\.get\(id\) \?\? sceneOfDecision\.get\(id\)/.test(dsrc) && /r\.scene\.decisionId, r\.scene\.sceneId/.test(dsrc) && /scenePanel\.clear\(\)/.test(dsrc)
        && /decisionId: Number\.isSafeInteger\(sc\.decisionId\)/.test(fs.readFileSync(path.join(ROOT, 'src/life/day.js'), 'utf8')));
      const gd = JSON.stringify((await GUIDES_DAY()).default);
      check('day-mobile: the guide explains folded rows, ALL ROWS, money rows and the sheet', /Folded rows/.test(gd) && /ALL ROWS/.test(gd) && /sheet from the bottom/.test(gd) && /Life · Wallet/.test(gd));
    }

    // Guides: the tile privacy note and the fallbacks.
    const { GUIDES } = await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href);
    const gMap = JSON.stringify((await GUIDES['life/map']()).default);
    const gDay = JSON.stringify((await GUIDES['life/day']()).default);
    check('map-guides: Map and Day say the browser loads tiles from LIFE_MAP_TILE_URL (IP, origin), how to turn them off, and straight-line fallback',
      [gMap, gDay].every((g) => g.includes('LIFE_MAP_TILE_URL') && /your browser/.test(g) && /IP address/.test(g) && /empty/.test(g) && /straight line/.test(g) && /tile policy/.test(g)));
    const dayQs = [...msrc('pages/life-day.js').matchAll(/data-guide="([a-z-]+)"/g)].map((x) => x[1]);
    check('map-guides: the Day map\'s "?" has its guide section', dayQs.includes('map') && gDay.includes('"id":"map"'));
    const lmBad = await request('GET', '/api/life/map?date=28-10-2026');
    check('map-api: /api/life/map?date= rejects a malformed date (400)', lmBad.status === 400, `got ${lmBad.status}`);
    const lmOff = await request('GET', '/api/life/map?date=2026-10-28');
    check('map-api: engine stopped → off shape with home null and the tile settings', lmOff.json?.running === false && lmOff.json.home === null && 'tileUrl' in lmOff.json);
  }

  // ── memory: plan 020 D2 + D3 — the panels from fixtures (the data: arcs-tests/99-standing, 99-commitments) ─
  {
    const ln = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-now.js')).href);
    const lm = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-cast-member.js')).href);
    const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const { GUIDES } = await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href);
    const evil = '<img src=x onerror=alert(1)>';
    const rows = [
      { status: 'overdue', who: 'A', what: `coffee ${evil}`, when: 1_793_400_000, source: 'decision', weight: 2, code: null },
      { status: 'no_plan', who: 'B', what: 'said "see you" in texts, nothing set', when: null, source: 'text', weight: 2, code: 'too_soon' },
      { status: 'on', who: 'a friend', what: 'a plan from a chat', when: 1_793_400_000, source: 'invitation', weight: 2, code: null },
    ];
    const c = rts(ln.commitmentRows({ running: true, rows }));
    check('commitments: status, who, weight and source in words, escaped', /OVERDUE/.test(c) && /NO PLAN/.test(c) && /INVITATION/.test(c) && /PROMISE/.test(c) && /too soon/.test(c) && !c.includes('<img') && c.includes('&lt;img'), c.slice(0, 200));
    check('commitments: nothing', /NOTHING HE'S SAID HE'D DO|NOTHING HE&#39;S SAID/.test(rts(ln.commitmentRows({ running: true, rows: [] }))));
    check('commitments: the note: off, failed, counts', ln.commitmentsNote(null) === 'LIFE NOT RUNNING' && /COULD NOT/.test(ln.commitmentsNote({ running: true, failed: true }))
      && /1 ON/.test(ln.commitmentsNote({ running: true, counts: { on: 1, overdue: 2 } })) && /2 TO LOOK AT/.test(ln.commitmentsNote({ running: true, counts: { on: 1, overdue: 2 } })));
    const st = { enabled: true, current: { id: 2, text: `easy ${evil}`, validFrom: 1_793_400_000, evidenceCount: 3 }, versions: [
      { id: 2, status: 'live', text: 'x', validFrom: 1_793_400_000, validTo: null, reason: null },
      { id: 1, status: 'invalidated', text: `old ${evil}`, validFrom: 1_793_300_000, validTo: 1_793_400_000, reason: 'evidence_gone' },
    ] };
    const v = rts(lm.standingView(st));
    check('standing: the note and its versions, escaped', v.includes('easy') && /EARLIER VERSIONS/.test(v) && /UNDONE/.test(v) && /left his life/.test(v) && !v.includes('<img'), v.slice(0, 200));
    check('standing: none yet / off / undone', /NO NOTE YET/.test(rts(lm.standingView({ enabled: true, versions: [] }))) && /SWITCHED OFF/.test(rts(lm.standingView({ enabled: false })))
      && /UNDONE · REBUILT/.test(rts(lm.standingView({ enabled: true, current: null, versions: [st.versions[1]] }))));
    check('standing: the header note', /AS OF .*3 EVENTS/.test(lm.standingNote(st)) && lm.standingNote({}) === '');
    check('standing: switched off, no "as of" beside it', lm.standingNote({ ...st, enabled: false }) === '');
    const ids = async (key) => ((await GUIDES[key]()).default.sections ?? []).map(x => x.id);
    check('memory: both panels have a guide section', (await ids('life')).includes('commitments') && (await ids('life/cast/member')).includes('standing'));
  }

  // ── sweep: plan 020 E1 + F1 — the panels from fixtures (the routes: life-tests/73-sweep-routes) ─
  {
    const ln = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-now.js')).href);
    const ld = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-day.js')).href);
    const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const { GUIDES } = await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href);
    const evil = '<img src=x onerror=alert(1)>';
    const alerts = {
      running: true, lastRunAt: 1_793_400_000, count: 1, ruleErrors: [], corrupt: false,
      findings: [{ fp: 'a'.repeat(32), rule: 'spend_once', severity: 'high', at: 1_793_400_000, eventIds: [5, 6], text: `paid twice ${evil}` }],
    };
    const a = rts(ln.alertRows(alerts, false));
    check('sweep: a finding shows its rule, severity, events and words, escaped', /SPEND ONCE/.test(a) && /HIGH/.test(a) && /EVENTS 5, 6/.test(a) && !a.includes('<img') && a.includes('&lt;img'), a.slice(0, 200));
    check('sweep: DISMISS names its fingerprint', a.includes(`data-fp="${'a'.repeat(32)}"`) && !/disabled/.test(a));
    check('sweep: read-only disables DISMISS', /disabled/.test(rts(ln.alertRows(alerts, true))));
    check('sweep: no findings', /NO PLOT HOLES FOUND/.test(rts(ln.alertRows({ running: true, findings: [] }, false))));
    check('sweep: the note: off, no run yet, a run, corrupt, a failed rule',
      ln.alertsNote(null) === 'LIFE NOT RUNNING' && /NO SWEEP YET/.test(ln.alertsNote({ running: true })) && /LAST SWEEP/.test(ln.alertsNote(alerts))
      && /UNREADABLE/.test(ln.alertsNote({ running: true, corrupt: true })) && /1 RULE/.test(ln.alertsNote({ running: true, ruleErrors: ['two_places'] })));
    const td = {
      running: true,
      rows: [
        { id: 7, at: 1_793_400_000, label: `Coffee ${evil}`, text: `leaning stay (0.72)… went anyway (deadline draw) ${evil}`, against: true, fromChat: false, chatNudged: false, spansDays: true, leanCount: 2,
          deed: { at: 1_793_400_000 }, leans: [{ at: 1_793_400_000, optionId: 'go', p: 0.5, fromChat: true, fallback: null }, { at: 1_793_400_000, optionId: 'stay', p: 0.72, fromChat: false, fallback: 'jev_error' }] },
        { id: 8, at: 1_793_400_000, label: 'a plan from a chat', text: 'no lean… expired: he never answered', against: false, fromChat: true, chatNudged: false, spansDays: false, leanCount: 0, deed: { at: null }, leans: [] },
      ],
    };
    const t = rts(ld.thoughtDeedRows(td));
    check('thought: the line, AGAINST HIS LEAN, ACROSS DAYS, escaped', /went anyway/.test(t) && /AGAINST HIS LEAN/.test(t) && /ACROSS DAYS/.test(t) && !t.includes('<img'), t.slice(0, 200));
    check('thought: the lean history with its chat and fallback marks', /LEANS/.test(t) && /◇/.test(t) && /jev_error/.test(t));
    check('thought: a chat\'s plan is marked', /a plan from a chat · ◇ CHAT/.test(t), t);
    check('thought: off and empty', /NOT RUNNING/.test(rts(ld.thoughtDeedRows(null))) && /NO DECISIONS/.test(rts(ld.thoughtDeedRows({ running: true, rows: [] }))));
    check('thought: the note counts', ld.thoughtDeedNote(td) === '2 DECISIONS · 1 AGAINST HIS LEAN', ld.thoughtDeedNote(td));
    const nowGuide = (await GUIDES.life()).default;
    const dayGuide = (await GUIDES['life/day']()).default;
    check('sweep: the Now guide explains the panel and what it can\'t see', /plan step/.test(JSON.stringify(nowGuide.sections.find(x => x.id === 'alerts'))));
    check('thought: the Day guide explains the panel', /ACROSS DAYS/.test(JSON.stringify(dayGuide.sections.find(x => x.id === 'thought-deed'))));
    check('sweep: the topbar shows the count from status.life, in text', /topLifeAlerts/.test(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'))
      && /l\.alerts/.test(fs.readFileSync(path.join(PUBLIC, 'js/components/topbar.js'), 'utf8')) && /textContent/.test(fs.readFileSync(path.join(PUBLIC, 'js/components/topbar.js'), 'utf8')));
    const nowSrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-now.js'), 'utf8');
    check('sweep: no raw sink, and the page reads /api/life/alerts', !/innerHTML|outerHTML|insertAdjacentHTML/.test(nowSrc) && /\/api\/life\/alerts/.test(nowSrc));
  }

  // ── phrases: Life · Phrases (plan 020 H2) — today's lines beside the bank's, read only ─
  {
    const pg = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-phrases.js')).href);
    const ok = await request('GET', '/api/life/phrases?bank=live&limit=5');
    check('phrases: GET /api/life/phrases → that bank, paged, with the switch and where the words come from', ok.status === 200 && ok.json?.bank === 'live' && ok.json.rows?.length === 5
      && ok.json.total > 100 && ok.json.on === false && typeof ok.json.disk?.source === 'string' && 'source' in (ok.json.running ?? {}) && typeof ok.json.restartNeeded === 'boolean', `got ${ok.status}`);
    const q = await request('GET', '/api/life/phrases?bank=thought&q=rain&only=english&offset=0&limit=100');
    check('phrases: search and filter reach the view', q.status === 200 && q.json.rows.every((r) => r.source.toLowerCase().includes('rain')) && q.json.rows.length > 0);
    for (const [bad, code] of [['bank=other', 'bad_bank'], ['only=nope', 'bad_only'], ['limit=500', 'bad_page'], ['offset=-1', 'bad_page'], [`q=${'x'.repeat(61)}`, 'bad_q']]) {
      const r = await request('GET', `/api/life/phrases?${bad}`);
      check(`phrases: ${bad.slice(0, 16)} → 400 ${code}`, r.status === 400 && r.json?.error === code, `got ${r.status}`);
    }
    check('phrases: the words of a warning and an issue', /one language/.test(pg.warningText('one_language_other:live')) && /corrupted/.test(pg.issueText('corrupt')) && /refused/.test(pg.issueText('invalid:bad_shape')) && pg.issueText(null) === '');
    const asText = (o) => pg.activeText(o);
    check('phrases: the page says which is active, and that a restart applies the file', /Active: gen-1.*gen-2.*restart applies/.test(asText({ running: { source: 'phrases.json', version: 'gen-1' }, disk: { source: 'phrases.json', version: 'gen-2' }, restartNeeded: true }))
      && /same as the file/.test(asText({ running: { source: 'phrases.json', version: 'gen-1' }, disk: { source: 'phrases.json', version: 'gen-1' }, restartNeeded: false }))
      && /loads when life starts/.test(asText({ running: { source: null }, disk: { source: 'example' }, restartNeeded: false })));
    check('phrases: a line\'s tags read in order', pg.tagsOf({ t: 'x', time: 'night', mood: 'low' }) === 'low · night');
    const pageSrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-phrases.js'), 'utf-8');
    check('phrases: raw only for the static shell, no write call', (pageSrc.match(/raw\(/g) || []).length === 1 && !/method:|'POST'|'PATCH'/.test(pageSrc));
    const guide = (await import(pathToFileURL(path.join(PUBLIC, 'js/guides/life-phrases.js')).href)).default;
    check('phrases: the guide says how to make one and how to switch it on', JSON.stringify(guide).includes('gen-phrases.js') && JSON.stringify(guide).includes('life.phraseBanks'));
    check('phrases: Mind links to it', fs.readFileSync(path.join(PUBLIC, 'js/pages/mind.js'), 'utf-8').includes('#life/phrases'));
  }

  // ── wallet: Life · Wallet (spec 018 §B) — the route over a stubbed facade, the page from a fixture ─
  {
    const lifeRoutes = await import(pathToFileURL(path.join(ROOT, 'src/dashboard/routes/life.js')).href);
    const wal = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-wallet.js')).href);
    const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const { ROUTES } = await import(pathToFileURL(path.join(PUBLIC, 'js/routes.js')).href);
    const { GUIDES } = await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href);
    const at = 1_793_400_000;
    // §B's shape: one month, a salary, a chat-made outing spend (revertible), an owner income, a fare.
    const FIX = {
      month: '2026-10', months: ['2026-10', '2026-09'], balance: 61234.5, currencyHint: null,
      salary: { amount: 175000, payday: 28, lastAt: null, nextAt: at + 20 * 86400 },
      baseline: 78000,
      totals: { in: 5000, out: 1324.76, net: 3675.24, byCategory: { income: 5000, outing: 1300, travel: 24.76 } },
      daily: [{ date: '2026-10-29', in: 0, out: 24.76, balance: 87475.24 }, { date: '2026-10-30', in: 5000, out: 1300, balance: 91175.24 },
        { date: '2026-10-31', in: 0, out: 0, balance: -200 }],
      entries: [
        { id: 901, at, dir: 'out', amount: 1300, category: 'outing', label: 'Coffee <b>', placeId: 'place:corner-cafe', placeName: 'Corner <i>Café</i>',
          castIds: ['cast:juno', 'cast:wren-vale'], origin: 'chat', fromChat: true, actor: 'engine', revertible: true },
        { id: 902, at: at - 3600, dir: 'in', amount: 5000, category: 'income', label: 'Extra income', placeId: null, placeName: null,
          castIds: [], origin: 'owner', fromChat: false, actor: 'owner', revertible: false },
        { id: 903, at: at - 7200, dir: 'out', amount: 24.76, category: 'travel', label: 'Auto fare', placeId: null, placeName: null,
          castIds: [], origin: 'self', fromChat: false, actor: 'engine', revertible: false },
      ],
    };
    let asked = null;
    lifeRoutes.__setWalletForTest({ running: true, view: async (o) => { asked = o; return FIX; } });
    try {
      const ok = await request('GET', '/api/life/wallet?month=2026-10');
      check('wallet: GET /api/life/wallet?month= → the facade\'s view for that month, running', ok.status === 200 && ok.json?.running === true
        && asked?.month === '2026-10' && ok.json.entries?.length === 3 && ok.json.salary?.payday === 28, `got ${ok.status}`);
      await request('GET', '/api/life/wallet');
      check('wallet: no month → the facade picks (this month)', asked && asked.month === undefined);
      const bad = await Promise.all(['2026-13', '2026-1', '26-10', 'x', '2026-10-01'].map((m) => request('GET', `/api/life/wallet?month=${encodeURIComponent(m)}`)));
      check('wallet: a malformed month → 400', bad.every((r) => r.status === 400), bad.map((r) => r.status).join(','));
      const anon = await request('GET', '/api/life/wallet', { cookies: false });
      check('wallet: unauthenticated → 401', anon.status === 401, `got ${anon.status}`);
      lifeRoutes.__setWalletForTest({ running: true, view: undefined });
      const na = await request('GET', '/api/life/wallet');
      check('wallet: a facade without walletView → 409 not_available', na.status === 409 && na.json?.error === 'not_available', `got ${na.status}`);
      lifeRoutes.__setWalletForTest({ running: true, view: async () => { throw Object.assign(new Error('x'), { name: 'WalletError', code: 'out_of_range' }); } });
      const oor = await request('GET', '/api/life/wallet?month=2001-01');
      check('wallet: a month outside his life → 404', oor.status === 404, `got ${oor.status}`);
      lifeRoutes.__setWalletForTest({ running: false, view: async () => FIX });
      const off = await request('GET', '/api/life/wallet?month=2026-10');
      check('wallet: engine stopped → the off shape (200, running false, the month echoed)', off.status === 200 && off.json?.running === false && off.json.month === '2026-10' && !('entries' in off.json));
    } finally {
      lifeRoutes.__setWalletForTest(null);
    }
    const real = await request('GET', '/api/life/wallet');
    check('wallet: the real route with life not running → off shape', real.status === 200 && real.json?.running === false);

    const r = ROUTES.find((x) => x.hash === 'life/wallet');
    check('wallet: #life/wallet in the Life nav, with an optional month',
      r?.section === 'Life' && r.nav === true && r.re.test('#life/wallet') && r.re.test('#life/wallet/2026-10') && !r.re.test('#life/wallet/2026-13')
      && ROUTES.find((x) => x.re.test('#life/wallet/2026-10'))?.hash === 'life/wallet');
    const names = wal.castNames([{ id: 'cast:juno', name: 'Juno' }, { id: 'x' }]);
    const log = rts(wal.logView(FIX, names, false));
    check('wallet: the log escapes labels and place names, names the cast (list, else the id\'s words)',
      log.includes('Coffee &lt;b&gt;') && !log.includes('Coffee <b>') && log.includes('Corner &lt;i&gt;Café&lt;/i&gt;') && log.includes('Juno, wren vale'));
    const given = rts(wal.entryRow({ id: 7, at: 1793428200, dir: 'out', amount: 900, category: 'outing', label: 'Coffee', castIds: ['cast:wren-vale', 'cast:x'], castNames: ['Wren <b>L</b>', ''] }, names, false));
    check('wallet: an entry\'s own castNames win (escaped), else the cast list / the id\'s words', given.includes('Wren &lt;b&gt;L&lt;/b&gt;, x') && !given.includes('Wren <b>'));
    check('wallet: a chat-made spend is marked ◇ CHAT, an owner one OWNER', log.includes('◇ CHAT') && log.includes('>OWNER<'));
    check('wallet: amounts signed with grouping (+ in, − out), no currency symbol',
      log.includes('−1,300') && log.includes('+5,000') && log.includes('−24.76') && !/[₹$€£]/.test(log + rts(wal.summaryView(FIX))));
    check('wallet: REVERT only on revertible rows', (log.match(/lw-revert/g) || []).length === 1 && /data-id="901"/.test(log));
    check('wallet: REVERT disabled on a read-only dashboard', /lw-revert[^>]*disabled/.test(rts(wal.logView(FIX, names, true))));
    const empty = { ...FIX, entries: [], daily: [], totals: { in: 0, out: 0, net: 0, byCategory: {} }, salary: null, months: [] };
    check('wallet: an empty month says so in every panel', rts(wal.logView(empty, names, false)).includes('NO MONEY MOVED') && rts(wal.categoryBars(empty)).includes('NOTHING THIS MONTH')
      && rts(wal.balanceLine(empty)).includes('NO DAYS YET') && rts(wal.summaryView(empty)).includes('NO SALARY') && wal.monthPicker(empty) === '');
    const sum = rts(wal.summaryView(FIX));
    check('wallet: the summary shows balance, in / out / net, salary, next payday, not paid yet, the usual month',
      sum.includes('61,234.5') && sum.includes('+5,000') && sum.includes('−1,324.76') && sum.includes('175,000') && sum.includes('day 28') && sum.includes('not paid yet') && sum.includes('78,000'));
    const line = rts(wal.balanceLine(FIX));
    check('wallet: the balance line is an inline SVG polyline with a zero line when it dips below 0', /<svg[^>]*role="img"/.test(line) && /<polyline class="lw-bal" points="[\d., ]+"/.test(line) && line.includes('lw-zero'));
    const bars = rts(wal.categoryBars(FIX));
    check('wallet: category bars, biggest first, in green / out red', bars.indexOf('INCOME') < bars.indexOf('OUTINGS') && bars.indexOf('OUTINGS') < bars.indexOf('TRAVEL') && bars.includes('lw-in') && bars.includes('lw-out'));
    check('wallet: the month picker lists the months with entries', (rts(wal.monthPicker(FIX)).match(/<option/g) || []).length === 2);
    const ws = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-wallet.js'), 'utf-8');
    check('wallet: no raw HTML sink; raw() only for static attributes / the shell; polls; checks ctx.alive',
      !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(ws) && /ctx\.setInterval\(/.test(ws) && /ctx\.alive\(\)/.test(ws)
      && !/raw\((?!['`])/.test(ws) && !/raw\('[^']*\$\{/.test(ws));
    const gw = (await GUIDES['life/wallet']()).default;
    const qs = [...ws.matchAll(/data-guide="([a-z-]+)"/g)].map((m) => m[1]);
    check('wallet: the guide backs every "?" and explains ◇ CHAT and REVERT', qs.length >= 4 && qs.every((id) => gw.sections.some((x) => x.id === id))
      && JSON.stringify(gw).includes('◇ CHAT') && JSON.stringify(gw).includes('REVERT'));
  }

  // ── live: plan 020 C2 — the route with the engine stopped, the line from fixtures ─
  {
    const off = await request('GET', '/api/life/live');
    check('live: GET /api/life/live with the engine stopped → the off shape', off.status === 200 && off.json?.running === false && off.json?.active === false, JSON.stringify(off.json));
    const lnp = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-now.js')).href);
    const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const evil = '<img src=x onerror=alert(1)>';
    check('live: nothing shown while no outing is on', lnp.liveStrip({ active: false }) === null && lnp.liveStrip(null) === null);
    const full = rts(lnp.liveStrip({ active: true, mode: 'full', line: { at: '20:14', parts: ['cafe', `talking about ${evil}`] }, phaseWords: 'in full swing', minutesLeft: 40, attention: { band: 'ok' }, them: [{ name: 'Ana', mood: 'high' }] }));
    check('live: the line and its small print, escaped', full.includes('20:14') && full.includes('cafe') && /IN FULL SWING/.test(full) && /40 MIN LEFT/.test(full) && !full.includes('<img') && full.includes('&lt;img'), full);
    const min = rts(lnp.liveStrip({ active: true, mode: 'minimal', reason: 'real_person', line: { at: '20:14', parts: ['out with a friend'] } }));
    check('live: a real person: the line alone', min.includes('out with a friend') && !/ATTENTION|REAL_PERSON/i.test(min), min);
    const liveSrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-now.js'), 'utf8');
    check('live: the page fetches it on its own timer and uses the kit\'s line', /\/api\/life\/live/.test(liveSrc) && /liveLine\(/.test(liveSrc) && /ctx\.setInterval\(loadLive/.test(liveSrc));
    const gl = (await import(pathToFileURL(path.join(PUBLIC, 'js/guides/life-now.js')).href)).default;
    check('live: the guide explains it', /out with a friend/.test(JSON.stringify(gl.sections.find(x => x.id === 'live'))));
  }

  // ── thoughts: plan 020 F2 — the route with the engine stopped, the stream from fixtures ─
  {
    const off = await request('GET', '/api/life/thoughts');
    check('thoughts: GET /api/life/thoughts with the engine stopped → the off shape', off.status === 200 && off.json?.running === false && Array.isArray(off.json?.thoughts) && off.json.thoughts.length === 0, JSON.stringify(off.json));
    const bad = await Promise.all(['/api/life/thoughts?date=nope', '/api/life/thoughts?date=2026-13-40', '/api/life/thoughts?limit=0', '/api/life/thoughts?limit=999', '/api/life/thoughts?limit=x'].map((u) => request('GET', u)));
    check('thoughts: a bad date or limit → 400', bad.every((r) => r.status === 400), bad.map((r) => r.status).join(','));
    const lnp = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-now.js')).href);
    const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const evil = '<img src=x onerror=alert(1)>';
    const t = rts(lnp.thoughtRows({ running: true, thoughts: [
      { id: 1, at: 1793400000, family: 'reaction', kind: 'thought', text: `ugh, rain ${evil}`, fromChat: false },
      { id: 2, at: 1793400300, family: 'wordless', kind: 'feeling', text: '(that stung, a bit)', fromChat: true },
      { id: 3, at: 1793400600, family: 'body', kind: 'body', text: 'starving', fromChat: false },
    ] }));
    check('thoughts: the kit\'s stream, newest first, escaped', /v-stream/.test(t) && t.indexOf('starving') < t.indexOf('ugh, rain') && !t.includes('<img') && t.includes('&lt;img'), t.slice(0, 200));
    check('thoughts: body and feeling rows are marked', /data-kind="body"/.test(t) && /data-kind="feeling"/.test(t) && /data-kind="thought"/.test(t));
    check('thoughts: from a chat says so, no more', /from a chat/.test(t));
    check('thoughts: nothing yet', /NOTHING ON HIS MIND YET/.test(rts(lnp.thoughtRows({ running: true, thoughts: [] }))));
    // F3: real thoughts, the kit's two columns.
    check('thoughts: off shape has no real thoughts', Array.isArray(off.json?.real) && off.json.real.length === 0, JSON.stringify(off.json));
    const rt = rts(lnp.realThoughtRows({ real: [{ id: 9, at: 1793400000, title: `drinks ${evil}`, told: `fine, needed it ${evil}`, drove: 'He was leaning stay (72%). The draw at the deadline came up go.', differs: true, fromChat: true }] }));
    check('thoughts: real ones in two columns, labelled', /v-two/.test(rt) && /WHAT HE TOLD HIMSELF/.test(rt) && /WHAT ACTUALLY DROVE IT/.test(rt) && /is-differs/.test(rt) && /CHAT/.test(rt), rt.slice(0, 300));
    check('thoughts: real ones escaped', !rt.includes('<img') && rt.includes('&lt;img'));
    check('thoughts: no real ones, no empty card', rts(lnp.realThoughtRows({ real: [] })).trim() === '' && rts(lnp.realThoughtRows(null)).trim() === '');
    const threeReal = rts(lnp.realThoughtRows({ real: [1, 2, 3].map((id) => ({ id, at: 1793400000, title: `t${id}`, told: `told${id}`, drove: 'd' })) }));
    check('thoughts: the newest whole, the others under EARLIER, all still there', threeReal.indexOf('told1') < threeReal.indexOf('EARLIER · 2') && threeReal.indexOf('EARLIER · 2') < threeReal.indexOf('told2') && threeReal.includes('told3'));
    const daySrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-day.js'), 'utf8');
    check('thoughts: Life · Day has the two columns', /ld-th-real/.test(daySrc) && /toldRow/.test(daySrc));
    check('thoughts: Life · Day reads its date\'s stream through the kit', /\/api\/life\/thoughts\?date=/.test(daySrc) && /stream\(/.test(daySrc) && !/innerHTML/.test(daySrc));
    const gn = (await import(pathToFileURL(path.join(PUBLIC, 'js/guides/life-now.js')).href)).default;
    const gd = (await import(pathToFileURL(path.join(PUBLIC, 'js/guides/life-day.js')).href)).default;
    check('thoughts: both guides explain the panel', /never a word/.test(JSON.stringify(gn.sections.find(x => x.id === 'thoughts'))) && !!gd.sections.find(x => x.id === 'thoughts'));
    check('thoughts: both guides explain the two columns', /WHAT ACTUALLY DROVE IT/.test(JSON.stringify(gn.sections.find(x => x.id === 'thoughts'))) && /WHAT ACTUALLY DROVE IT/.test(JSON.stringify(gd.sections.find(x => x.id === 'thoughts'))));
  }

  // ── phone: Life · Phone (spec 019) — the routes over a stubbed facade, the page from a fixture ─
  {
    const arcsRoutes = await import(pathToFileURL(path.join(ROOT, 'src/dashboard/routes/arcs.js')).href);
    const ph = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-phone.js')).href);
    const cm = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-cast-member.js')).href);
    const ldp = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-day.js')).href);
    const { renderToString: rts } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const { ROUTES } = await import(pathToFileURL(path.join(PUBLIC, 'js/routes.js')).href);
    const { GUIDES } = await import(pathToFileURL(path.join(PUBLIC, 'js/guides/index.js')).href);
    const at = 1_793_400_000;
    const THREADS = [
      { castId: 'cast:lena-brandt', name: 'Lena <b>Brandt</b>', departed: false, count: 3, last: { at, dir: 'in', preview: 'see you <i>sunday</i>' } },
      { castId: 'cast:juno', name: 'Juno', departed: true, count: 0, last: null },
      { castId: 'not a cast id', name: 'x', count: 1, last: null },
    ];
    const MSGS = [
      { id: 11, eventId: 501, at: at - 90000, dir: 'out', text: 'free <script>x</script> sunday?', edited: false, status: 'live', tier: 'mouth', trigger: 'owner', revertible: true, regenerable: true },
      { id: 12, eventId: 502, at: at - 600, dir: 'in', text: 'yes!! where', edited: true, status: 'live', tier: 'clerk', trigger: 'reply', revertible: true, regenerable: true },
      { id: 13, eventId: 503, at, dir: 'in', text: 'see you sunday', edited: false, status: 'reverted', tier: 'clerk', trigger: 'reply', revertible: false, regenerable: false, extra: 'dropped' },
    ];
    let asked = null;
    const calls = [];
    const stub = {
      phoneThreads: () => THREADS,
      phoneThread: (castId, o) => { asked = { castId, ...o }; return castId === 'cast:lena-brandt' ? { castId, name: 'Lena Brandt', departed: false, messages: MSGS } : null; },
      phoneEdit: async (id, text) => {
        calls.push(['edit', id, text]);
        if (id === 404) throw Object.assign(new Error('nope'), { code: 'not_found' });
        if (id === 400) throw Object.assign(new Error('Pell'), { code: 'real_name' });
        if (id === 409) throw Object.assign(new Error('gone'), { code: 'reverted' });
        return { ok: true };
      },
      phoneRegenerate: async (id) => { calls.push(['regen', id]); return id === 12 ? { ok: true, id: 14 } : { code: 'regen_cap' }; },
    };
    const H = { 'X-CSRF-Token': jar.csrf_token };
    config.dashboard.readOnly = false;
    arcsRoutes.__setPhoneForTest(stub);
    try {
      const list = await request('GET', '/api/arcs/phone');
      check('phone: GET /api/arcs/phone → the threads, closed shape (a bad cast id dropped, no extra keys)', list.status === 200 && list.json?.enabled === true
        && list.json.threads?.length === 2 && list.json.threads[0].last?.preview === 'see you <i>sunday</i>' && list.json.threads[1].last === null && list.json.threads[1].departed === true, `got ${list.status}`);
      const one = await request('GET', '/api/arcs/phone/cast:lena-brandt?before=1793300000&limit=20');
      check('phone: GET a thread → its messages (closed shape), before / limit passed on', one.status === 200 && one.json?.thread?.messages?.length === 3
        && asked?.castId === 'cast:lena-brandt' && asked.before === 1793300000 && asked.limit === 20 && !('extra' in one.json.thread.messages[2])
        && one.json.thread.messages[2].status === 'reverted' && one.json.thread.messages[1].edited === true, `got ${one.status}`);
      const enc = await request('GET', `/api/arcs/phone/${encodeURIComponent('cast:lena-brandt')}`);
      check('phone: an encoded cast id works too', enc.status === 200 && enc.json?.thread?.castId === 'cast:lena-brandt');
      const nf = await request('GET', '/api/arcs/phone/cast:nobody');
      const bads = await Promise.all(['/api/arcs/phone/x', '/api/arcs/phone/cast:lena-brandt?before=abc', '/api/arcs/phone/cast:lena-brandt?before=-5'].map((u) => request('GET', u)));
      check('phone: an unknown thread → 404; a bad cast id / before → 400', nf.status === 404 && bads.every((r) => r.status === 400), [nf.status, ...bads.map((r) => r.status)].join(','));
      const anon = await request('GET', '/api/arcs/phone', { cookies: false });
      check('phone: unauthenticated → 401', anon.status === 401, `got ${anon.status}`);

      const ed = await request('PUT', '/api/arcs/phone/messages/12/text', { body: { text: '  yes!! where?  ' }, headers: H });
      check('phone: EDIT → the facade gets the id and the text, 200', ed.status === 200 && ed.json?.ok === true && calls.some((c) => c[0] === 'edit' && c[1] === 12), `got ${ed.status}`);
      const edBad = await Promise.all([{ text: '' }, { text: 'x'.repeat(301) }, { text: 'call 123@s.whatsapp.net' }].map((b) => request('PUT', '/api/arcs/phone/messages/12/text', { body: b, headers: H })));
      check('phone: EDIT empty / over 300 / a JID → 400 before the facade', edBad.every((r) => r.status === 400) && edBad[1].json?.error === 'too_long', edBad.map((r) => r.status).join(','));
      const edCodes = await Promise.all([404, 400, 409].map((id) => request('PUT', `/api/arcs/phone/messages/${id}/text`, { body: { text: 'ok' }, headers: H })));
      check('phone: the facade\'s codes → not_found 404, real_name 400, reverted 409 (the code, never the message)',
        edCodes.map((r) => r.status).join(',') === '404,400,409' && edCodes[1].json?.error === 'real_name' && !JSON.stringify(edCodes.map((r) => r.json)).includes('Pell'),
        edCodes.map((r) => r.status).join(','));
      const rg = await request('POST', '/api/arcs/phone/messages/12/regenerate', { body: {}, headers: H });
      check('phone: REWRITE → the new id', rg.status === 200 && rg.json?.id === 14, `got ${rg.status}`);
      const rgNo = await request('POST', '/api/arcs/phone/messages/11/regenerate', { body: {}, headers: H });
      check('phone: a refused REWRITE ({code} returned) → 409 with the code', rgNo.status === 409 && rgNo.json?.error === 'regen_cap', `got ${rgNo.status}`);
      const audits = getDb().prepare("SELECT action, payload_json FROM dashboard_audit WHERE action LIKE 'arcs.phone.%'").all();
      check('phone: writes audited arcs.phone.edit / .regenerate with ids and lengths, never the text',
        audits.some((a) => a.action === 'arcs.phone.edit') && audits.some((a) => a.action === 'arcs.phone.regenerate') && !audits.some((a) => /yes!!|where/.test(a.payload_json || '')));
      config.dashboard.readOnly = true;
      const ro = await request('PUT', '/api/arcs/phone/messages/12/text', { body: { text: 'x' }, headers: H });
      check('phone: a read-only dashboard refuses EDIT (403)', ro.status === 403, `got ${ro.status}`);
      config.dashboard.readOnly = false;
      arcsRoutes.__setPhoneForTest({ phoneThreads: () => THREADS });
      const na = await Promise.all([request('PUT', '/api/arcs/phone/messages/12/text', { body: { text: 'x' }, headers: H }), request('GET', '/api/arcs/phone/cast:lena-brandt')]);
      check('phone: a facade without the calls → 409 not_available', na.every((r) => r.status === 409 && r.json?.error === 'not_available'), na.map((r) => r.status).join(','));
      arcsRoutes.__setPhoneForTest(stub, { enabled: false });
      const off = await request('GET', '/api/arcs/phone');
      const offW = await request('PUT', '/api/arcs/phone/messages/12/text', { body: { text: 'x' }, headers: H });
      check('phone: arcs off → reads 200 off shape, writes 409', off.status === 200 && off.json?.enabled === false && off.json.threads.length === 0 && offW.status === 409, `${off.status} ${offW.status}`);
    } finally {
      arcsRoutes.__setPhoneForTest(null);
      config.dashboard.readOnly = true;
    }

    const r = ROUTES.find((x) => x.hash === 'life/phone');
    check('phone: #life/phone in the Life nav, with an optional thread',
      r?.section === 'Life' && r.nav === true && r.re.test('#life/phone') && r.re.test('#life/phone/cast%3Alena-brandt') && r.re.test('#life/phone/cast:lena-brandt')
      && ROUTES.find((x) => x.re.test('#life/phone/cast:lena-brandt'))?.hash === 'life/phone');
    const tl = rts(ph.threadList(THREADS.slice(0, 2), 'cast:lena-brandt'));
    check('phone: the chat list escapes names and previews, marks the open one and LEFT, says "no texts yet"',
      tl.includes('Lena &lt;b&gt;Brandt&lt;/b&gt;') && !tl.includes('<b>Brandt') && tl.includes('see you &lt;i&gt;sunday&lt;/i&gt;') && /lp-trow is-on/.test(tl)
      && tl.includes('LEFT') && tl.includes('no texts yet') && tl.includes('href="#life/phone/cast%3Alena-brandt"'));
    check('phone: an empty list says how texts happen', rts(ph.threadList([], null)).includes('NO TEXTS YET'));
    const mv = rts(ph.messagesView(MSGS, { sel: 12, ro: false, more: true }));
    check('phone: bubbles — his right (is-out), theirs left (is-in), text escaped, a day line, LOAD OLDER',
      /lp-row is-out/.test(mv) && /lp-row is-in/.test(mv) && mv.includes('free &lt;script&gt;') && !mv.includes('<script>x') && /lp-day/.test(mv) && mv.includes('LOAD OLDER'));
    check('phone: EDITED and REVERTED marks; a reverted bubble is faded', mv.includes('EDITED') && mv.includes('REVERTED') && /lp-msg is-in is-reverted/.test(mv));
    check('phone: the tapped message shows EDIT / REWRITE / REVERT (REVERT carries its eventId)', mv.includes('data-act="edit"') && mv.includes('data-act="regen"') && /data-act="revert" data-ev="502"/.test(mv)
      && (mv.match(/data-act="edit"/g) || []).length === 1);
    const roAct = rts(ph.messagesView(MSGS, { sel: 12, ro: true }));
    check('phone: read-only → the actions are disabled', /data-act="edit"[^>]*disabled/.test(roAct) && /data-act="regen"[^>]*disabled/.test(roAct) && /data-act="revert"[^>]*disabled/.test(roAct));
    const revSel = rts(ph.messagesView(MSGS, { sel: 13, ro: false }));
    check('phone: a reverted message can\'t be edited, rewritten or reverted again', /data-act="edit"[^>]*disabled/.test(revSel) && /data-act="regen"[^>]*disabled/.test(revSel) && /data-act="revert"[^>]*disabled/.test(revSel));
    const edv = rts(ph.messagesView(MSGS, { editing: 11, ro: false }));
    check('phone: EDIT is a textarea (≤ 300) with the old text escaped, SAVE / CANCEL', /<textarea name="text" maxlength="300"/.test(edv) && edv.includes('free &lt;script&gt;') && edv.includes('SAVE') && edv.includes('CANCEL'));
    const sf = rts(ph.sendForm({ name: 'Lena', departed: false }, false));
    const sfOff = rts(ph.sendForm({ name: 'Juno', departed: true }, false));
    check('phone: SEND A TEXT (gist + optional tone) is open, disabled for someone who left', sf.includes('SEND A TEXT') && !/<button[^>]*disabled/.test(sf) && /<button[^>]*disabled/.test(sfOff) && sfOff.includes('has left'));
    const pageSrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-phone.js'), 'utf-8');
    check('phone: SEND A TEXT previews the Director kind text (from sendAction) in the shared modal (nothing written before APPLY)',
      /import \{ openPreview \} from '\.\/life-director\.js'/.test(pageSrc) && /const action = sendAction\(castId, new FormData\(form\)\);/.test(pageSrc) && /openPreview\(ctx, action, \{/.test(pageSrc));
    check('phone: a chat opens at its newest message; a poll with nothing new repaints nothing; SEND A TEXT is a sheet, so a poll can\'t wipe a draft',
      /const stick = !opened \|\| nearEnd\(el\)/.test(pageSrc) && /if \(sig === painted\) return;/.test(pageSrc) && /openSheet\(\{/.test(pageSrc) && !/setSlot\(root, 'lp-send', sendForm/.test(pageSrc));
    check('phone: REWRITE and REVERT ask in a sheet, not a browser dialog', !/window\.(confirm|prompt)/.test(pageSrc) && /askSheet\(\{ label: 'Revert/.test(pageSrc));
    check('phone: the form asks who texts first (him / them), her exact first words, a long chat, and says her text wakes him',
      /name="from" value="him" checked/.test(sf) && /name="from" value="them"/.test(sf) && /Lena does/.test(sf) && /name="words"/.test(sf) && /name="chat" value="long"/.test(sf) && /wakes him/.test(sf));
    {
      const fdOf = (o) => ({ get: (k) => o[k] ?? null });
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const a1 = ph.sendAction('cast:wren', fdOf({ from: 'them', gist: 'felt a spark', words: 'Hey. Are you awake?', chat: 'long' }));
      check('phone: sendAction → the owner\'s scenario shape', same(a1, { kind: 'text', castId: 'cast:wren', gist: 'felt a spark', words: 'Hey. Are you awake?', from: 'them', chat: 'long' }), a1);
      const a2 = ph.sendAction('cast:wren', fdOf({ from: 'him', gist: 'say hi' }));
      check('phone: sendAction → him, a gist, short (no from/chat keys)', same(a2, { kind: 'text', castId: 'cast:wren', gist: 'say hi' }), a2);
      check('phone: sendAction → null with neither gist nor words', ph.sendAction('cast:wren', fdOf({ from: 'them' })) === null);
    }
    check('phone: REVERT uses the life revert route on the eventId; EDIT / REWRITE their own routes',
      /\/api\/life\/events\/\$\{encodeURIComponent\(ev\)\}\/revert/.test(pageSrc) && /\/api\/arcs\/phone\/messages\/\$\{encodeURIComponent\(id\)\}\/text/.test(pageSrc) && /\/regenerate`/.test(pageSrc));
    check('phone: no raw HTML sink; raw() only for the static shell; polls; checks ctx.alive',
      !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(pageSrc) && /ctx\.setInterval\(/.test(pageSrc) && /ctx\.alive\(\)/.test(pageSrc)
      && (pageSrc.match(/raw\(/g) || []).length === 1 && !/raw\('[^']*\$\{/.test(pageSrc));
    const tx = rts(cm.textsView(MSGS));
    check('phone: the cast member\'s TEXTS shows the last few as read-only bubbles', /lp-row is-out/.test(tx) && !tx.includes('data-act="edit"') && rts(cm.textsView([])).includes('NO TEXTS YET'));
    check('phone: Life · Day reads a text row "texted <name>" / "<name> texted" / "a text", never folded with phone checks',
      ldp.rowText({ type: 'phone.message', cat: 'phone', detail: { with: ['Lena'], dir: 'out' } }) === 'texted Lena'
      && ldp.rowText({ type: 'phone.message', cat: 'event', detail: { with: ['Lena'], dir: 'in' } }) === 'Lena texted'
      && ldp.rowText({ type: 'phone.message', cat: 'event', detail: {} }) === 'a text'
      && ldp.foldQuiet([1, 2, 3].map((i) => ({ row: 'tick', at: i, cat: 'phone', type: 'phone.message' }))).every((x) => x.row === 'tick'));
    const gp = (await GUIDES['life/phone']()).default;
    const pq = [...pageSrc.matchAll(/data-guide="([a-z-]+)"/g)].map((m) => m[1]);
    const gpj = JSON.stringify(gp);
    check('phone: the guide backs every "?", says the public site shows these chats and real chats never appear',
      pq.length >= 1 && pq.every((id) => gp.sections.some((x) => x.id === id)) && /public site/.test(gpj) && /Real chats, real groups and real people never appear/.test(gpj));
    const gcm = (await GUIDES['life/cast/member']?.())?.default ?? null;
    const cmSrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-cast-member.js'), 'utf-8');
    const cmQs = [...cmSrc.matchAll(/data-guide="([a-z-]+)"/g)].map((m) => m[1]);
    check('phone: the cast member\'s TEXTS "?" has its guide section', cmQs.includes('texts') && (!gcm || gcm.sections.some((x) => x.id === 'texts')));
  }

  // ── no persona / timezone literal in the new frontend ──────────────────────
  {
    const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : [p];
    }) : []);
    const files = [...walk(path.join(PUBLIC, 'js')), ...walk(path.join(PUBLIC, 'css')), path.join(PUBLIC, 'index.html')];
    // The project/brand name is allowed (an install may also use it as an alias).
    const brand = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).name || '').toLowerCase();
    const names = new Set();
    for (const f of ['persona.example.json', 'persona.json']) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/personality', f), 'utf-8'));
        for (const n of [p.name, p.displayName, ...(p.aliases || [])]) {
          if (n && String(n).length >= 3 && String(n).toLowerCase() !== brand) names.add(String(n));
        }
        if (p.region && String(p.region).length >= 4) names.add(String(p.region));
      } catch {}
    }
    const hits = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf-8');
      const rel = path.relative(PUBLIC, f);
      if (/\b(?:Asia|Europe|America|Africa|Australia|Pacific)\/[A-Z]/.test(text)) hits.push(`${rel}: a zone name`);
      if (/\d\.\d+\s*\*\s*3600/.test(text)) hits.push(`${rel}: an offset in code`);
      if (/\b(?:[A-Z]ST|[A-Z]DT)\b/.test(text)) hits.push(`${rel}: a zone abbreviation`);
      for (const n of names) {
        const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        // Report the file, never the name (persona.json is private).
        if (re.test(text)) hits.push(`${rel}: persona literal`);
      }
    }
    check('no persona name / region / hardcoded timezone in public/js, public/css, index.html', !hits.length, hits.join('; '));
  }

  // ── phone baseline (plan 020 I3): static; the 390 px pass itself is scripts/dash-tests/shots.js ──
  {
    const cssFiles = ['tokens', 'chrome', 'components', 'touch'].map((n) => [n, fs.readFileSync(path.join(PUBLIC, 'css', `${n}.css`), 'utf-8')]);
    const idx = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf-8');
    const viewport = idx.match(/<meta name="viewport" content="([^"]+)"/)?.[1] || '';
    {
      // Questions are sheets: a browser dialog can't say much and looks foreign on a phone.
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name.startsWith('.') ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
      const dialogs = walk(path.join(PUBLIC, 'js')).filter((f) => /\b(window\.)?(confirm|prompt|alert)\(/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\b(renderPrompt|\.prompt)\(/g, '')));
      check('base: no page asks through a browser dialog', !dialogs.length, dialogs.map((f) => path.basename(f)).join(', '));
      const tellSrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-director-story.js'), 'utf8');
      check('director: the wish wakes up once the page knows it may write (it stayed disabled after a load)', /refresh\(\) \{\s*if \(ro\(\) !== drawnRo\) draw\(\);/.test(tellSrc));
      const storyPage = await import(pathToFileURL(path.join(PUBLIC, 'js/pages/life-story.js')).href);
      const names = (id) => ({ 'cast:a': 'Robin' }[id] || id);
      const line = (kind, payload) => storyPage.proposalLine({ kind, payload }, names);
      check('story: each proposal kind reads in words',
        line('beat', { castId: 'cast:a', kind: 'news', text: 'got a dog' }) === 'Robin: got a dog'
        && line('new_cast', { name: 'Sam', relation: 'neighbour', personality: 'dry' }) === 'Someone new: Sam, neighbour'
        && line('new_place', { name: 'The Pier', kind: 'cafe', lat: 1, lon: 2 }) === 'A new place: The Pier, cafe'
        && line('arc_decision', { kind: 'cast_meetup', castId: 'cast:a' }) === 'A meetup with Robin'
        && line('arc_decision', { kind: 'career_hunt' }) === 'Looking for a new job'
        && /theme-1/.test(line('heavy_nomination', { themeId: 'theme-1' })));
      check('story: an unknown kind or a broken payload has no line (DETAILS only), and never throws',
        line('something_new', { a: 1 }) === null && line('beat', {}) === null && line('new_cast', null) === null && storyPage.proposalLine(null) === null);
      const dayCss = fs.readFileSync(path.join(PUBLIC, 'css/views.css'), 'utf8');
      const daySrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/life-day.js'), 'utf8');
      check('day: the row sheet has a scrim, holds the page inert and lets go when leaving',
        /\.ld-side\.is-open \+ \.ld-side-scrim/.test(dayCss) && /sib\.inert = true/.test(daySrc) && /onDispose\?\.\(\(\) => closeSide\(\{ refocus: false \}\)\)/.test(daySrc));
      const routes = fs.readFileSync(path.join(PUBLIC, 'js/routes.js'), 'utf8');
      check('director: #life/director/<section> is a route', routes.includes(String.raw`re: /^#life\/director(?:\/([a-z]+))?$/`));
    }
    check('base: viewport fits the notch, zoom is never disabled', /viewport-fit=cover/.test(viewport) && !/user-scalable|maximum-scale/.test(viewport), viewport);
    check('base: theme-color + dark color-scheme, touch.css loads last',
      /name="theme-color"/.test(idx) && /name="color-scheme" content="dark"/.test(idx)
      && idx.lastIndexOf('rel="stylesheet"') === idx.indexOf('href="/css/touch.css"') - 'rel="stylesheet" '.length);

    // Every :hover sits inside a (hover: hover) and (pointer: fine) block: a tap would leave it stuck otherwise.
    const ungated = [];
    for (const [name, text] of cssFiles) {
      const stack = [];
      let start = 0;
      const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] === '{') { stack.push(clean.slice(start, i).trim()); start = i + 1; }
        else if (clean[i] === '}') { stack.pop(); start = i + 1; }
        else if (clean[i] === ';') start = i + 1;
        else if (clean.startsWith(':hover', i) && !stack.some((h) => /\(hover:\s*hover\)/.test(h))) ungated.push(`${name}.css: ${clean.slice(start, i + 6).trim().slice(-50)}`);
      }
    }
    check('base: every :hover rule is limited to mouse devices', !ungated.length, ungated.slice(0, 4).join(' | '));

    const rawSize = [];
    for (const [name, text] of cssFiles) {
      for (const line of text.split('\n')) {
        if (/font-size:\s*\d/.test(line) && !/^\s*--/.test(line) && !/\btext \{/.test(line) && !/16px !important/.test(line)) rawSize.push(`${name}.css: ${line.trim().slice(0, 60)}`);
      }
    }
    check('base: CSS font sizes come from the type tokens (SVG text excepted)', !rawSize.length, rawSize.slice(0, 4).join(' | '));
    const vhOnly = [];
    for (const [name, text] of cssFiles) {
      for (const rule of text.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
        for (const m of rule.matchAll(/(min-height|max-height|height):[^;]*\dvh\b[^;]*;/g)) {
          if (!new RegExp(`${m[1]}:[^;]*\\ddvh\\b`).test(rule)) vhOnly.push(`${name}.css: ${m[0].slice(0, 50)}`);
        }
      }
    }
    check('base: heights in vh carry a dvh line (the URL bar moves on phones)', !vhOnly.length, vhOnly.slice(0, 4).join(' | '));

    const touch = cssFiles.find(([n]) => n === 'touch')[1];
    const coarse = touch.slice(touch.indexOf('@media (pointer: coarse)'));
    check('base: on touch, fields are 16 px (no iOS zoom) and targets use --tap',
      /input, select, textarea \{ font-size: 16px !important; \}/.test(coarse) && /min-height: var\(--tap\)/.test(coarse) && /--tap: 44px/.test(cssFiles[0][1]));
    const tokens = cssFiles[0][1];
    const phone = tokens.slice(tokens.indexOf('@media (max-width: 900px)'));
    const phonePx = (t) => Number(phone.match(new RegExp(`--t-${t}: (\\d+)px`))?.[1] || 0);
    check('base: phone scale: labels at least 11 px, values and text at least 14 px',
      phonePx('micro') >= 11 && phonePx('label') >= 11 && phonePx('data') >= 14 && phonePx('body') >= 14);
    const lightTheme = cssFiles.some(([, t]) => /prefers-color-scheme|data-theme/.test(t));
    check('base: dark only (owner, 2 Nov): no second theme in the CSS', !lightTheme);
  }

  // ── the shell (plan 020 I1): one registry, nothing unreachable, no old address lost ──
  {
    const { ROUTES, navSections, tabsOf } = await import(pathToFileURL(path.join(PUBLIC, 'js/routes.js')).href);
    const at = (h) => ROUTES.find((r) => r.re.test(h))?.hash;
    const OLD_LINKS = {
      '#life': 'life', '#life/day': 'life/day', '#life/day/2026-11-02': 'life/day', '#life/timeline': 'life/timeline', '#life/map': 'life/map',
      '#life/wallet': 'life/wallet', '#life/wallet/2026-10': 'life/wallet', '#life/phone': 'life/phone', '#life/phone/cast%3Aa': 'life/phone',
      '#life/cast': 'life/cast', '#life/cast/cast%3Aa': 'life/cast/member', '#life/story': 'life/story', '#life/pending': 'life/pending',
      '#life/journal': 'life/journal', '#life/director': 'life/director', '#status': 'status', '#memories': 'memories', '#decisions': 'decisions',
      '#usage': 'usage', '#mind': 'mind', '#groups': 'groups', '#group/x%40g.us': 'group', '#people': 'people', '#person/x': 'person',
      '#messages': 'messages', '#bills': 'bills', '#instagram': 'instagram', '#settings': 'settings', '#identity': 'identity', '#skills': 'skills',
      '#logs': 'logs', '#public': 'public', '#audit': 'audit',
    };
    const lost = Object.entries(OLD_LINKS).filter(([h, want]) => at(h) !== want).map(([h]) => h);
    check('shell: every pre-020 address still opens its page', !lost.length, lost.join(','));
    check('shell: # and an empty hash open Now; #status still opens Status', at('#') === 'life' && at('') === 'life' && at('#status') === 'status');

    // Every page is reachable: a nav link, a tab next to one, or a detail page lighting one.
    const links = new Set(ROUTES.filter((r) => r.nav).map((r) => r.hash));
    const stranded = ROUTES.filter((r) => !r.nav && !links.has(r.navKey)).map((r) => r.hash);
    check('shell: every route hangs off a nav link', !stranded.length, stranded.join(','));
    const tabless = ROUTES.filter((r) => r.tabs && !tabsOf(r).some((t) => t.nav)).map((r) => r.hash);
    check('shell: every tab strip has its nav link in it', !tabless.length, tabless.join(','));
    eq2('shell: 25 sidebar links', ROUTES.filter((r) => r.nav).length, 25);
    const shellHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf-8');
    const chromeCss = fs.readFileSync(path.join(PUBLIC, 'css/chrome.css'), 'utf-8');
    check('shell: a phone gets the left sidebar from a menu button, no bottom bar', /id="menuToggle"[^>]*aria-controls="sidebar"/.test(shellHtml) && /id="drawerBackdrop"/.test(shellHtml)
      && !/bottom-nav|bottomNav/.test(shellHtml + chromeCss) && ROUTES.every((r) => !('bar' in r)));
    const drawerSrc = fs.readFileSync(path.join(PUBLIC, 'js/components/drawer.js'), 'utf-8');
    check('shell: the panel makes the page inert, closes on Escape and navigation, returns focus', /main\.inert = next/.test(drawerSrc) && /Escape/.test(drawerSrc) && /closeForNav/.test(fs.readFileSync(path.join(PUBLIC, 'js/main.js'), 'utf-8')) && /focusTo\?\.focus/.test(drawerSrc));
    const drawerMod = await import(pathToFileURL(path.join(PUBLIC, 'js/components/drawer.js')).href);
    check('shell: drawer.js loads with no DOM', typeof drawerMod.initDrawer === 'function');
    check('shell: People is his cast, Contacts the real ones', ROUTES.find((r) => r.hash === 'life/cast').title === 'People' && ROUTES.find((r) => r.hash === 'people').title === 'Contacts');
    eq2('shell: tab strips', ['life/day', 'life/story'].map((h) => tabsOf(ROUTES.find((r) => r.hash === h)).map((r) => r.title).join('+')).join(' '), 'Day+Timeline Story+Director+Pending+Journal');
    eq2('shell: nav sections in order', navSections().map((s) => s.name).join(','), 'Life,Chats,Control');
    const pageFiles = fs.readdirSync(path.join(PUBLIC, 'js/pages')).filter((f) => f.endsWith('.js'));
    const numbered = pageFiles.filter((f) => /class="seq"/.test(fs.readFileSync(path.join(PUBLIC, 'js/pages', f), 'utf-8')));
    check('shell: no stale page numbers in page headers', !numbered.length, numbered.join(','));

    const sheetSrc = fs.readFileSync(path.join(PUBLIC, 'js/components/sheet.js'), 'utf-8');
    const mainSrc = fs.readFileSync(path.join(PUBLIC, 'js/main.js'), 'utf-8');
    check('shell: sheets are a modal <dialog> outside #content; navigation closes them', /showModal\(\)/.test(sheetSrc) && /document\.body\.appendChild\(dlg\)/.test(sheetSrc) && /closeSheet\(\)/.test(mainSrc));
    const sheet = await import(pathToFileURL(path.join(PUBLIC, 'js/components/sheet.js')).href);
    check('shell: sheet.js loads with no DOM, closing nothing is safe', typeof sheet.openSheet === 'function' && sheet.closeSheet() === undefined);
  }

  // ── the shared pieces (plan 020 I2): one module, everything escaped, on the kit page ──
  {
    const v = await import(pathToFileURL(path.join(PUBLIC, 'js/components/views.js')).href);
    const { renderToString } = await import(pathToFileURL(path.join(PUBLIC, 'js/core/dom.js')).href);
    const X = '<script>x</script>';
    const out = [
      v.kpi({ label: X, id: X, value: X, sub: X }),
      v.fold({ id: X, title: X, meta: X, body: X }),
      v.segments([[X, X, X]], X, { label: X }),
      v.formRow({ label: X, hint: X, control: X }),
      v.alertRow({ severity: X, title: X, detail: X, at: X, href: X }),
      v.alertList([], { empty: X }),
      v.liveLine({ at: X, parts: [X, X] }),
      v.streamRow({ at: X, kind: X, text: X, note: X }),
      v.stream([], { empty: X }),
      v.twoCol({ title: X, at: X, leftLabel: X, left: X, rightLabel: X, right: X }),
      v.stanceRow({ topic: X, kind: X, value: X, trend: X, whyId: X }),
      v.dreamCard({ night: X, tone: X, text: X, scenes: [{ place: X, person: X, twist: X }] }),
    ].map((t) => renderToString(t));
    check('views: every value is escaped', out.every((h) => !h.includes('<script>')), out.findIndex((h) => h.includes('<script>')));
    const bar = (o) => renderToString(v.stanceRow(o)).match(/left:([\d.]+)%;width:([\d.]+)%/).slice(1).map(Number).join(',');
    eq2('views: an interest grows from the left', bar({ topic: 'a', kind: 'interest', value: 0.7 }), '0,70');
    eq2('views: a positive opinion grows right of centre', bar({ topic: 'a', kind: 'opinion', value: 0.5 }), '50,25');
    eq2('views: a negative opinion grows left of centre', bar({ topic: 'a', kind: 'opinion', value: -0.5 }), '25,25');
    eq2('views: values are clamped to their range', bar({ topic: 'a', kind: 'interest', value: 3 }), '0,100');
    const opening = (text) => renderToString(v.dreamCard({ night: 'n', text })).match(/<p class="v-dream-text">([^<]*)<\/p>/)[1];
    const cutAt = opening('One sentence that goes on for a while here. '.repeat(30));
    check('views: a long dream cuts at a sentence, a short one not at all', cutAt.endsWith('here.') && cutAt.length <= 360 && opening('short') === 'short' && opening('x'.repeat(480)).length === 480);
    eq2('views: one unbroken word is still cut', opening('x'.repeat(2000)).length, 360);
    const rendered = renderToString(v.dreamCard({ night: 'n', text: `${'<b>a</b> '.repeat(100)}` }));
    check('views: both halves of a long dream are escaped', !rendered.includes('<b>') && /READ THE REST/.test(rendered));
    check('views: an unknown severity reads as info', renderToString(v.alertRow({ severity: 'nope', title: 'a' })).includes('data-sev="info"'));
    check('views: an empty list says so', renderToString(v.alertList([])).includes('class="empty"') && renderToString(v.stream(null)).includes('class="empty"'));

    const { ROUTES } = await import(pathToFileURL(path.join(PUBLIC, 'js/routes.js')).href);
    const kit = ROUTES.find((r) => r.hash === 'kit');
    // Labels say what the thing is (owner, 3 Nov 2026): no console or surveillance theatre.
    {
      const shown = (dir) => fs.readdirSync(path.join(PUBLIC, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);
      const sources = ['index.html', 'js/main.js', ...shown('js/pages'), ...shown('js/components'), ...shown('js/guides')]
        .map((f) => [f, fs.readFileSync(path.join(PUBLIC, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')]);
      const THEATRE = /PANOPTICON|SECTOR-7|UPLINK|TS-MESH|monitored\. always|EYES ONLY|UNDER OBSERVATION|OBSERVATION DECK|DOSSIER|REGISTRY|IMMUTABLE|LEDGER|OPERATORS|\bFRAME\b|\bCHAN\b|INITIALISING|BOOTING|ENCODED FACTS|LOADED MODULES|CHARACTER DEFINITION|LIVE PARAMETERS|RIBBON|operator view/;
      const bad = sources.filter(([, t]) => THEATRE.test(t)).map(([f, t]) => `${f}:${t.match(THEATRE)[0]}`);
      check('plain words: no decorative labels on any page, guide or the shell', bad.length === 0, bad.join(' '));
      const prefix = sources.filter(([, t]) => /(?<![=/:])>\/\/ |(?:placeholder=["']|class="crumb">)\/\/ /.test(t)).map(([f]) => f);
      check('plain words: no decorative // in front of a label', prefix.length === 0, prefix.join(' '));
      check('plain words: no glitch effect, tile codes, nav numbers or sidebar foot',
        !sources.some(([, t]) => /class="[^"]*glitch|class="id mono">[^<$]*<\/span>|sidebar-foot|frameNo|frameTwo|padz\(\+\+i\)/.test(t))
        && !/\.glitch|\.sidebar-foot|@keyframes flicker/.test(['tokens', 'chrome', 'components', 'views', 'touch'].map((c) => fs.readFileSync(path.join(PUBLIC, `css/${c}.css`), 'utf8')).join('\n')));
    }
    check('kit: routed, not in the nav', !!kit && !kit.nav && kit.re.test('#kit'));
    const kitSrc = fs.readFileSync(path.join(PUBLIC, 'js/pages/kit.js'), 'utf-8');
    const exported = [...fs.readFileSync(path.join(PUBLIC, 'js/components/views.js'), 'utf-8').matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
    const unshown = exported.filter((n) => !['alertRow', 'streamRow'].includes(n) && !kitSrc.includes(n));
    check('kit: shows every shared piece', !unshown.length, unshown.join(','));
    const views = fs.readFileSync(path.join(PUBLIC, 'js/components/views.js'), 'utf-8');
    check('views + tables + kit: no raw() or innerHTML', ![views, kitSrc, fs.readFileSync(path.join(PUBLIC, 'js/components/tables.js'), 'utf-8')].some((t) => /\braw\(|innerHTML/.test(t)));
    check('tables: wired after every render, opt-out exists', /syncTables\(content\)/.test(fs.readFileSync(path.join(PUBLIC, 'js/main.js'), 'utf-8')) && /no-cards/.test(fs.readFileSync(path.join(PUBLIC, 'js/components/tables.js'), 'utf-8')));
  }

  // ── logout ─────────────────────────────────────────────────────────────────
  {
    const r = await request('POST', '/api/logout');
    absorbCookies(r);
    check('logout → 200 and clears the session cookie', r.status === 200 && !jar.dash_session, Object.keys(jar).join(','));
    const after = await request('GET', '/api/status');
    check('after logout the API needs auth again', after.status === 401, `got ${after.status}`);
  }
} catch (err) {
  failures++;
  console.error('FAIL  harness error —', err?.stack || err);
}

await cleanup();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
