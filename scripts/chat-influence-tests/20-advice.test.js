// 012 advice → the owner's tray (plan §P3): an accepted `kind: advice`
// perception becomes ONE pending row and nothing else — no world event — and only
// with the arcs skill on (the tray is the story's); a frozen category or a paused
// story → none; ≤ 3 pending per category and one per sender and category; a
// deferred message's advice waits (held) until he reads it; 14-day expiry;
// approve → approved + the Director preset, still no world event; reject;
// forget / revoke / edit → withdrawn and the live excerpt gone; purge deletes.
// Then the dashboard API on the real app (Fastify inject): the list (summary +
// live excerpt, bad status → 400), approve/reject behind readonly + CSRF, 409
// while arcs is off, 404 for an unknown row, audit rows with ids and the
// category only, and the 10/min limit with no loopback exemption.
import {
  setupScratchDb, bootInfluence, say, idle, perceiveJev, perceiveCalls, eventsOf, setSkills, section, check, eq, report,
} from './_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'advice-dash-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4), DASHBOARD_COOKIE_SECRET: 'advice-dashboard-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.0/8,::1/128', DASHBOARD_READONLY: 'true',
});

await setupScratchDb();
let spec = { kind: 'advice', target: 'him', advice: 'career', intensity: 'mid' };
const t = await bootInfluence({ jev: perceiveJev(() => spec), skills: { arcs: true }, areas: { advice: true, mood: false, sleep: false, work: false } });
const rs = await import('../../src/memory/relationshipStore.js');
const BOT = '10000000000@s.whatsapp.net';
t.config.chatInfluence.perSenderPerHour = 20;
t.config.chatInfluence.perChatPerHour = 60;
t.config.chatInfluence.jevMaxPerDay = 200;
const rows = () => t.db.prepare(`SELECT * FROM chat_influence_items WHERE kind = 'advice' ORDER BY id`).all();
const row = (msgId) => t.db.prepare(`SELECT * FROM chat_influence_items WHERE kind = 'advice' AND msg_id = ?`).get(msgId);
const lastEventId = () => t.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM world_events').get().n;
const clear = () => t.db.prepare(`DELETE FROM chat_influence_items WHERE kind = 'advice'`).run();
let n = 0;

async function advise({ chat = t.GROUP, sender = t.A, category = 'career', text = 'you should really look for a new job', verdict = 'now', at } = {}) {
  spec = { kind: 'advice', target: 'him', advice: category, intensity: 'mid' };
  const id = `V${++n}`;
  await say(t, { chat, sender, text, id, verdict, mentioned: chat.endsWith('@g.us') ? [BOT] : [], ...(at ? { at } : {}) });
  await idle(t);
  return id;
}

section('advice lands on the tray, and nowhere in his world');
const e0 = lastEventId();
const v1 = await advise();
const r1 = row(v1);
check('one pending career row: the chat, the sender, no pointer, no text', r1?.status === 'pending' && r1.category === 'career'
  && r1.chat_jid === t.GROUP && r1.sender_jid === t.A && r1.pointer_event_id === null && !/new job/.test(JSON.stringify(r1)), r1);
eq('…it expires in 14 days', r1.expires_at - r1.created_at, 14 * 86400);
eq('…and no world event was appended', lastEventId(), e0);
const view = t.life.influenceAdvice({ status: 'pending', nameOf: (j) => (j === t.GROUP ? 'Test group' : null) });
check('the owner\'s view: code-built summary + the live excerpt', view[0]?.summary === 'advice from Test group about career'
  && /new job/.test(view[0]?.excerpt || ''), view[0]);

section('only with the arcs skill on');
await setSkills({ arcs: false });
const c0 = perceiveCalls(t).length;
const v2 = await advise({ sender: t.B });
eq('arcs off (advice the only area): no perception call, no row', [perceiveCalls(t).length - c0, row(v2) ?? null], [0, null]);
t.config.chatInfluence.mood = true;
const v2b = await advise({ sender: t.B });
check('…with mood on the call happens, but advice still makes no row', perceiveCalls(t).length > c0 && !row(v2b));
t.config.chatInfluence.mood = false;
await setSkills({ arcs: true });
t.config.chatInfluence.advice = false;
const v3 = await advise({ sender: t.B });
eq('the advice area off → no row', row(v3) ?? null, null);
t.config.chatInfluence.advice = true;

section('the owner\'s controls');
t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'romance', mode: 'frozen' } }], { by: 'test' });
eq('a frozen category gets no proposal', row(await advise({ category: 'romance', sender: t.B })) ?? null, null);
t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'romance', mode: 'guided' } }], { by: 'test' });
check('…a guided one does (the owner decides anyway)', row(await advise({ category: 'romance', sender: t.B }))?.status === 'pending');
t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'romance', mode: 'natural' } }], { by: 'test' });
t.life.appendOwnerBatch([{ type: 'director.paused', at: t.clock.now(), payload: {} }], { by: 'test' });
eq('a paused story gets none', row(await advise({ category: 'family', sender: t.B })) ?? null, null);
t.life.appendOwnerBatch([{ type: 'director.resumed', at: t.clock.now(), payload: {} }], { by: 'test' });

section('caps: 3 pending per category, one per sender and category');
clear();
await advise({ sender: t.A, category: 'health' });
const dup = await advise({ sender: t.A, category: 'health', text: 'and you need to sleep more, seriously' });
eq('the same sender, the same category again → deduped', row(dup) ?? null, null);
await advise({ sender: t.B, category: 'health' });
t.config.chatInfluence.advicePerCategory = 2;
const over = await advise({ chat: t.C, sender: t.C, category: 'health', text: 'you should start running again' });
eq('the category is full (cap 2 here) → refused', row(over) ?? null, null);
const other = await advise({ chat: t.C, sender: t.C, category: 'social', text: 'you should go out more' });
check('…another category still has room', row(other)?.status === 'pending');
t.config.chatInfluence.advicePerCategory = 3;
const third = await advise({ chat: t.OTHER, sender: t.C, category: 'health', text: 'see a doctor about that back' });
check('…with the default cap (3) the third sender\'s health advice joins', row(third)?.status === 'pending' && row(third).sender_jid === t.C);
const again = await advise({ chat: t.C, sender: t.C, category: 'health', text: 'and stretch every morning' });
eq('…C again in their DM: the same person, deduped across chats', row(again) ?? null, null);
const fresh = await advise({ chat: t.A, sender: t.A, category: 'family', text: 'you should call your parents more often' });
check('a DM works the same (origin dm, the person as sender)', row(fresh)?.origin_kind === 'dm' && row(fresh)?.sender_jid === t.A);

section('a deferred message waits until he reads it');
clear();
const held = await advise({ sender: t.B, category: 'career', verdict: 'defer' });
eq('defer → a held row (codes only)', [row(held)?.status, row(held)?.kind, /new job/.test(row(held)?.held || '')], ['held', 'advice', false]);
check('…not on the tray yet', t.life.influenceAdvice({ status: 'pending' }).length === 0);
await t.influence.beforeDrainTurn(t.GROUP, [held], t.clock.now());
check('…his catch-up turn reads it → pending, expiring 14 days from then', row(held)?.status === 'pending' && row(held).category === 'career'
  && row(held).expires_at === t.clock.now() + 14 * 86400 && row(held).held === null, row(held));
const ig = await advise({ sender: t.C, category: 'career', verdict: 'ignore' });
eq('ignore → nothing', row(ig) ?? null, null);

section('expiry');
clear();
const old = await advise({ sender: t.A, category: 'career' });
// 14 days later (moved back in the row rather than replaying 14 days of pulse).
t.db.prepare('UPDATE chat_influence_items SET created_at = created_at - ?, expires_at = expires_at - ? WHERE id = ?')
  .run(14 * 86400 + 60, 14 * 86400 + 60, row(old).id);
check('past 14 days the view lists it as expired, before any tick', t.life.influenceAdvice({ status: 'expired' }).some(a => a.id === row(old).id)
  && !t.life.influenceAdvice({ status: 'pending' }).length);
eq('…it cannot be approved any more', t.life.influenceAdviceDecide(row(old).id, 'approve', { by: 'test' }), { ok: false, reason: 'not_pending' });
t.clock.advance({ minutes: 15 });
await t.life.tick();
eq('…and the tick marks it expired', row(old)?.status, 'expired');

section('approve / reject: no world event, only the preset');
clear();
const a1 = await advise({ sender: t.A, category: 'career' });
const a2 = await advise({ sender: t.B, category: 'romance', text: 'you should ask her out already' });
const e1 = lastEventId();
const ok = t.life.influenceAdviceDecide(row(a1).id, 'approve', { by: 'owner-x' });
eq('approve → approved, the arc.start preset in its category', ok, { ok: true, id: row(a1).id, status: 'approved', category: 'career',
  preset: { shape: 'arc.start', category: 'career' } });
check('…recorded who and when, nothing appended to his world', row(a1).decided_by === 'owner-x' && row(a1).decided_at === t.clock.now() && lastEventId() === e1);
eq('…a second approve is refused', t.life.influenceAdviceDecide(row(a1).id, 'approve', {}).reason, 'not_pending');
eq('reject → rejected, no preset', t.life.influenceAdviceDecide(row(a2).id, 'reject', {}), { ok: true, id: row(a2).id, status: 'rejected', category: 'romance' });
eq('an unknown id / a non-advice row → not_found', [t.life.influenceAdviceDecide(999999, 'approve').reason, t.life.influenceAdviceDecide(row(a1).id, 'drop').reason],
  ['not_found', 'not_found']);
await setSkills({ arcs: false });
const a3 = t.db.prepare(`INSERT INTO chat_influence_items (kind, chat_jid, origin_kind, msg_id, sender_jid, category, status, created_at, expires_at)
  VALUES ('advice', ?, 'group', 'X1', ?, 'social', 'pending', ?, ?)`).run(t.GROUP, t.C, t.clock.now(), t.clock.now() + 86400).lastInsertRowid;
eq('arcs off → the owner verdict is refused (off), the row stays pending', [t.life.influenceAdviceDecide(Number(a3), 'approve').reason,
  t.db.prepare('SELECT status FROM chat_influence_items WHERE id = ?').get(a3).status], ['off', 'pending']);
await setSkills({ arcs: true });

section('forget / revoke / edit → withdrawn, the excerpt gone');
clear();
const settle = () => new Promise(r => setImmediate(r));
const rv = await advise({ sender: t.A, category: 'career' });
rs.onMessageRevoked(rv, t.GROUP);
await settle();
check('revoke → withdrawn', row(rv)?.status === 'withdrawn' && row(rv).withdraw_reason === 'revoke', row(rv));
const wv = t.life.influenceAdvice({ status: 'withdrawn' }).find(a => a.id === row(rv).id);
check('…its excerpt is gone from the owner view', wv && wv.excerpt === null);
const ed = await advise({ sender: t.B, category: 'career' });
rs.onMessageEdited(ed, 'never mind', t.GROUP);
await settle();
eq('edit → withdrawn', row(ed)?.status, 'withdrawn');
const fg = await advise({ chat: t.C, sender: t.C, category: 'family', text: 'you should visit your gran', at: Math.floor(Date.now() / 1000) });
check('(setup) a DM advice row', row(fg)?.status === 'pending');
rs.forgetRecent(t.C, t.C);
await settle();
eq('forget → withdrawn', row(fg)?.status, 'withdrawn');
const sw = await advise({ sender: t.A, category: 'social', text: 'you should join a club or something' });
t.db.prepare('UPDATE messages SET no_learn = 1 WHERE id = ?').run(sw);
t.clock.advance({ minutes: 15 });
await t.life.tick();
eq('a missed hook: the tick sweep withdraws advice whose message is no longer prompt-visible', row(sw)?.status, 'withdrawn');
check('withdrawn advice is not reverted or re-listed (it has no pointer)', !t.db.prepare(`SELECT 1 FROM chat_influence_items WHERE kind = 'advice' AND status = 'reverted'`).get());

section('purge deletes');
const pg = await advise({ sender: t.B, category: 'health', text: 'you should drink more water' });
check('(setup) B has a pending row', row(pg)?.status === 'pending');
rs.purgePerson(t.B, 'test', 'test');
eq('purge of the sender → every advice row of theirs deleted', t.db.prepare(`SELECT COUNT(*) AS n FROM chat_influence_items WHERE kind = 'advice' AND sender_jid = ?`).get(t.B).n, 0);
eq('…and no world event mentions advice', (await eventsOf(['chat.perceived'])).filter(e => e.payload?.kind === 'advice').length, 0);

// ── the dashboard API ───────────────────────────────────────────────────────

section('dashboard: list, approve / reject, guards, audit, limits');
clear();
const d1 = await advise({ sender: t.A, category: 'career', text: 'you should <b>quit</b> that job' });
const d2 = await advise({ sender: t.C, category: 'romance', text: 'just text her' });
const { config } = await import('../../src/utils/config.js');
const { startDashboard } = await import('../../src/dashboard/server.js');
const app = await startDashboard({ getSock: () => null });
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'advice-test-csrf-token';
async function req(method, url, { body, csrf = true, auth = true, ip = '127.0.0.1' } = {}) {
  const headers = {};
  if (auth) headers.authorization = AUTH;
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, remoteAddress: ip, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json };
}
const audit = (action) => t.db.prepare('SELECT * FROM dashboard_audit WHERE action = ? ORDER BY id').all(action);
const id1 = row(d1).id;
const id2 = row(d2).id;
t.db.prepare(`INSERT OR IGNORE INTO groups (jid, name, joined_at, last_active) VALUES (?, 'Test group', unixepoch(), unixepoch())`).run(t.GROUP);

const list = await req('GET', '/api/influence/advice?status=pending');
const it1 = list.json?.advice?.find(a => a.id === id1);
check('GET pending: summary with the chat name, the live excerpt, the category', list.status === 200 && it1?.category === 'career'
  && /about career/.test(it1.summary) && /quit/.test(it1.excerpt || ''), list.json);
eq('GET with a bad status → 400', (await req('GET', '/api/influence/advice?status=nope')).status, 400);
eq('GET unauthenticated → 401', (await req('GET', '/api/influence/advice', { auth: false })).status, 401);
config.dashboard.readOnly = true;
eq('readonly → approve 403', (await req('POST', `/api/influence/advice/${id1}/approve`, { body: {} })).status, 403);
config.dashboard.readOnly = false;
eq('no CSRF → 403', (await req('POST', `/api/influence/advice/${id1}/approve`, { body: {}, csrf: false })).status, 403);
eq('a bad id → 400, an unknown one → 404', [(await req('POST', '/api/influence/advice/x/approve', { body: {} })).status,
  (await req('POST', '/api/influence/advice/999999/approve', { body: {} })).status], [400, 404]);
await setSkills({ arcs: false });
const off = await req('POST', `/api/influence/advice/${id1}/approve`, { body: {} });
eq('arcs off → 409 "arcs is off"', [off.status, off.json?.error], [409, 'arcs is off']);
await setSkills({ arcs: true });
const e2 = lastEventId();
const ap = await req('POST', `/api/influence/advice/${id1}/approve`, { body: {} });
check('approve → 200 with the preset; no world event', ap.status === 200 && ap.json?.preset?.shape === 'arc.start' && ap.json.preset.category === 'career'
  && lastEventId() === e2, ap.json);
eq('…a second approve → 409 not_pending', [(await req('POST', `/api/influence/advice/${id1}/approve`, { body: {} })).status], [409]);
eq('reject → 200', (await req('POST', `/api/influence/advice/${id2}/reject`, { body: {} })).status, 200);
const rows1 = [...audit('chatInfluence.advice.approve'), ...audit('chatInfluence.advice.reject')];
check('one audit row per accepted write: the id and the category, never the text', rows1.length === 2
  && rows1.every(r => !/quit|text her/.test(String(r.payload_json))) && /"category":"career"/.test(rows1[0].payload_json), rows1);
const burst = [];
for (let i = 0; i < 11; i++) burst.push((await req('POST', `/api/influence/advice/${id2}/reject`, { body: {}, ip: '127.0.0.9' })).status);
check('10/min on one peer, loopback not exempt (the 11th → 429)', burst.slice(0, 10).every(s => s === 409) && burst[10] === 429, burst.join(','));
await app.close();

report();
