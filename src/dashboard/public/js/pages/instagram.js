// 13 INSTAGRAM — the reels phone: device state, browse/stop, share queue, group
// chat, member links, reel log, taste card, sessions and the device log. Live via
// the shared stream (topic `instagram`: snapshot | session | reel | queue | alert | chat).
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtClock, fmtDuration, fmtHm, fmtNum, fmtRelative, fmtTime } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { getStatus } from '../components/topbar.js';
import { showError } from '../components/ui.js';
import { initFolds } from '../components/views.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">INSTAGRAM · REELS PHONE</div>
    <h1>Instagram</h1>
  </div>
  <div class="meta">
    <span>AUTO <b data-slot="ig-skill">—</b></span>
    <span>MODE <b data-slot="ig-mode">—</b></span>
    <span>GROUP <b data-slot="ig-group">—</b></span>
    <span data-slot="ig-dry"></span>
  </div>
</div>

<div data-slot="ig-alert"></div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>PHONE</span></div>
    <div class="val" data-slot="ig-device">—</div>
    <div class="sub" data-slot="ig-device-sub">—</div>
  </div>
  <div class="kpi"><div class="lab"><span>TODAY</span></div>
    <div class="val mono" data-slot="ig-today">—</div>
    <div class="sub">likes · shares</div>
  </div>
  <div class="kpi"><div class="lab"><span>WARMUP</span></div>
    <div class="val mono" data-slot="ig-warmup">—</div>
    <div class="sub" data-slot="ig-warmup-sub">—</div>
  </div>
  <div class="kpi"><div class="lab"><span>LAST 24H</span></div>
    <div class="val mono" data-slot="ig-24h">—</div>
    <div class="sub" data-slot="ig-24h-sub">—</div>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>BROWSE<button type="button" class="guide-q" data-guide="browse" aria-label="Guide: browse">?</button></span><span class="mono mute" data-slot="ig-phase">IDLE</span></div>
    <div class="panel-body" style="display:grid;gap:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="igMinutes" aria-label="Session length"><option value="5">5 MIN</option><option value="10" selected>10 MIN</option><option value="15">15 MIN</option></select>
        <label class="mono" style="display:flex;gap:6px;align-items:center;font-size: var(--t-meta)"><input type="checkbox" id="igAllowShare" /> ALLOW SHARING THIS SESSION</label>
        <button data-write class="primary" id="igBrowse">BROWSE INSTAGRAM</button>
        <button data-write class="danger" id="igStop">STOP</button>
      </div>
      <div class="mono" style="font-size: var(--t-meta)" data-slot="ig-live">No session running.</div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><span>TODAY'S SCHEDULE<button type="button" class="guide-q" data-guide="schedule" aria-label="Guide: schedule">?</button></span><span class="mono mute">AUTO SESSIONS</span></div>
    <div class="panel-body mono" style="font-size: var(--t-meta)" data-slot="ig-schedule">—</div>
  </div>
</div>

<div class="panel" style="margin-top:12px">
  <div class="panel-head"><span>SHARE QUEUE<button type="button" class="guide-q" data-guide="queue" aria-label="Guide: queue">?</button></span><span class="mono mute" data-slot="ig-queue-count">—</span></div>
  <div data-slot="ig-queue"><div class="loading">LOADING</div></div>
</div>

<div class="col-2" style="margin-top:12px">
  <div class="panel">
    <details class="fold-in" data-fold="ig.chat" data-wide-open><summary class="panel-head"><span>GROUP CHAT<button type="button" class="guide-q" data-guide="chat" aria-label="Guide: chat">?</button></span><span class="mono mute" data-slot="ig-chat-status">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="panel-body" style="display:flex;gap:8px;align-items:center">
      <button data-write class="primary" id="igChatCheck" title="Manual override: opens the group thread now, even with the instagram-chat skill off">CHECK CHAT NOW · MANUAL</button>
      <span class="mono" style="font-size: var(--t-meta)" data-slot="ig-chat-skill">—</span>
      <span class="mono mute" style="font-size: var(--t-meta)" data-slot="ig-chat-last">—</span>
    </div>
    <div data-slot="ig-chat" style="max-height:520px;overflow:auto"><div class="loading">LOADING</div></div>
    </details>
    </div>
  <div class="panel">
    <details class="fold-in" data-fold="ig.members" data-wide-open><summary class="panel-head"><span>MEMBERS<button type="button" class="guide-q" data-guide="members" aria-label="Guide: members">?</button></span><span class="mono mute">LINK TO WHATSAPP PEOPLE</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>MEMBER</th><th>USERNAME</th><th>WHATSAPP PERSON</th></tr></thead>
      <tbody data-slot="ig-members"></tbody>
    </table></div>
    </details>
    </div>
</div>

<div class="panel" style="margin-top:12px">
  <details class="fold-in" data-fold="ig.reels" data-wide-open><summary class="panel-head"><span>REEL LOG<button type="button" class="guide-q" data-guide="reels" aria-label="Guide: reels">?</button></span><span class="mono mute">EVERY REEL HE SAW</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body toolbar" style="grid-template-columns:1fr auto;gap:8px">
    <input type="search" id="igSearch" aria-label="Search reels" placeholder="SEARCH · ACCOUNT / CAPTION / DESCRIPTION" />
    <select id="igAction" aria-label="Reel action"><option value="">ALL</option><option value="like_and_queue">QUEUED</option><option value="like">LIKED</option><option value="skip">SKIPPED</option></select>
  </div>
  <div data-slot="ig-reels"><div class="loading">LOADING</div></div>
  <div class="panel-body"><button id="igMore">LOAD MORE</button></div>
    </details>
    </div>

<div class="col-2" style="margin-top:12px">
  <div class="panel">
    <details class="fold-in" data-fold="ig.taste" data-wide-open><summary class="panel-head"><span>TASTE CARD<button type="button" class="guide-q" data-guide="taste" aria-label="Guide: taste">?</button></span><span class="mono mute" data-slot="ig-taste-src">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="panel-body" style="display:grid;gap:8px">
      <textarea id="igTaste" aria-label="Taste card JSON" rows="16" spellcheck="false" style="font-family:var(--font-mono);font-size: var(--t-meta)"></textarea>
      <div><button data-write class="primary" id="igTasteSave">SAVE TASTE CARD</button></div>
    </div>
    </details>
    </div>
  <div class="panel">
    <details class="fold-in" data-fold="ig.sessions" data-wide-open><summary class="panel-head"><span>SESSIONS<button type="button" class="guide-q" data-guide="sessions" aria-label="Guide: sessions">?</button></span><span class="mono mute">LAST 10</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>#</th><th>STARTED</th><th>TRIGGER</th><th>SEEN</th><th>LIKED</th><th>QUEUED</th><th>SHARED</th><th>END</th></tr></thead>
      <tbody data-slot="ig-sessions"></tbody>
    </table></div>
    </details>
    </div>
</div>

<div class="panel" style="margin-top:12px">
  <details class="fold-in" data-fold="ig.device" data-wide-open><summary class="panel-head"><span>DEVICE LOG<button type="button" class="guide-q" data-guide="devlog" aria-label="Guide: devlog">?</button></span><span class="mono mute">EVERY COMMAND SENT TO THE PHONE · INSTAGRAM ONLY</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>TIME</th><th>OP</th><th>ARGS</th><th>IN FRONT</th><th>MS</th><th>RESULT</th></tr></thead>
    <tbody data-slot="ig-devlog"></tbody>
  </table></div>
    </details>
    </div>
`);

const ACTION_PILL = {
  like_and_queue: html`<span class="pill ok">QUEUED</span>`,
  like: html`<span class="pill warn">LIKED</span>`,
  skip: html`<span class="pill">SKIP</span>`,
};
const SHARE_PILL = { queued: 'pill', approved: 'pill warn', sending: 'pill live', sent: 'pill ok', vetoed: 'pill bad', failed: 'pill bad' };
const selfName = () => getStatus()?.persona?.name || 'bot';

const thumbView = (r, placeholder = true) => (r.hasThumb
  ? html`<img loading="lazy" src="/api/instagram/reels/${encodeURIComponent(r.id)}/thumb" alt="" style="width:72px;height:128px;object-fit:cover;border:1px solid var(--line-2)" />`
  : placeholder ? html`<div style="width:72px;height:128px;border:1px dashed var(--line-2)"></div>` : null);

function reelRow(r) {
  const hz = (r.hazards || []).map((h) => html`<span class="pill bad">${h.hazard} ${fmtNum(h.p)}</span> `);
  const scores = r.humour != null
    ? html`HUMOUR <b>${fmtNum(r.humour)}</b> · FIT <b>${fmtNum(r.fit)}</b> · CONF <b>${fmtNum(r.confidence)}</b>${r.forWhom ? html` · FOR <b>${r.forWhom}</b>` : null}`
    : (r.jevAnswers?.quick?.worth_watching ? html`WORTH WATCHING <b>${fmtNum(r.jevAnswers.quick.worth_watching.noul)}</b>` : null);
  const lab = (v, txt) => html`<button data-write type="button" class="ig-label" data-id="${r.id}" data-label="${r.userLabel === v ? 0 : v}" aria-pressed="${r.userLabel === v ? 'true' : 'false'}" style="padding:3px 8px;${r.userLabel === v ? 'border-color:var(--red);color:var(--red-bright)' : ''}">${txt}</button>`;
  return html`<div style="display:grid;grid-template-columns:80px 1fr;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line-1)">
    <div>${thumbView(r)}</div>
    <div style="display:grid;gap:5px;min-width:0">
      <div class="mono" style="font-size: var(--t-meta)">${ACTION_PILL[r.action] || null} ${r.shareState ? html`<span class="${SHARE_PILL[r.shareState] || 'pill'}">${r.shareState}</span>` : null} <b>@${r.account || '?'}</b> <span class="mute">· ${r.createdAt ? fmtTime(r.createdAt) : '—'} · ${(r.depth || '').toUpperCase()}${r.language ? ` · ${r.language}` : ''}${r.liked ? ' · ♥' : ''}</span></div>
      ${r.caption ? html`<div class="mute" style="font-size: var(--t-data)">“${r.caption}”</div>` : null}
      <div style="font-size: var(--t-data);white-space:pre-wrap">${r.description || '(no description)'}</div>
      <div class="mono mute" style="font-size: var(--t-label)">${scores} ${hz} ${r.reason ? `· ${r.reason}` : ''}</div>
      <div style="display:flex;gap:6px;align-items:center"><span class="mono mute" style="font-size: var(--t-label)">JEV'S CALL:</span>${lab(1, 'GOOD')}${lab(-1, 'BAD')}</div>
    </div>
  </div>`;
}

/**
 * Approve body for a queued reel's caption box. Typed text is sent as is. A blank
 * box sends nothing (he writes one) only while no caption is stored; clearing a
 * stored caption sends '' = share with no caption.
 */
export function approveBody(boxValue, storedCaption) {
  const typed = String(boxValue ?? '');
  if (typed.trim()) return { caption: typed };
  return storedCaption ? { caption: '' } : {};
}

function queueRow(r) {
  const actionable = ['queued', 'approved', 'failed'].includes(r.shareState);
  return html`<div style="display:grid;grid-template-columns:80px 1fr;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line-1)">
    <div>${thumbView(r, false)}</div>
    <div style="display:grid;gap:6px;min-width:0">
      <div class="mono" style="font-size: var(--t-meta)"><span class="${SHARE_PILL[r.shareState] || 'pill'}">${r.shareState}</span> <b>@${r.account || '?'}</b> <span class="mute">· HUMOUR ${fmtNum(r.humour)} · FIT ${fmtNum(r.fit)}</span></div>
      <div style="font-size: var(--t-data)">${r.description || ''}</div>
      ${r.shareError ? html`<div class="mono red-bright" style="font-size: var(--t-label)">${r.shareError}</div>` : null}
      ${actionable ? html`<div style="display:grid;grid-template-columns:1fr auto auto;gap:6px">
        <input type="text" class="ig-caption" data-id="${r.id}" maxlength="140" aria-label="Caption" placeholder="${r.shareCaption === '' ? 'no caption (cleared) · type one to add it' : 'caption (blank = he writes one; Latin letters only)'}" value="${r.shareCaption || ''}" />
        <button data-write type="button" class="primary ig-approve" data-id="${r.id}">APPROVE &amp; SEND</button>
        <button data-write type="button" class="danger ig-veto" data-id="${r.id}">VETO</button>
      </div>` : null}
    </div>
  </div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  initFolds(root);
  const opt = { signal: ctx.signal };
  const q$ = (sel) => $(root, sel);
  let reels = [];

  const showLive = (st) => {
    if (!ctx.alive() || !st) return;
    const sess = st.session;
    setSlots(root, { 'ig-phase': sess ? String(sess.phase || '').toUpperCase() : (st.busy ? 'BUSY' : 'IDLE') });
    if (!sess) { setSlot(root, 'ig-live', 'No session running.'); return; }
    const left = Math.max(0, Math.round((sess.endsAt - Date.now()) / 1000));
    const r = sess.reel;
    const c = sess.counts || {};
    setSlot(root, 'ig-live', html`SESSION #${sess.id} · ${sess.trigger} · ${fmtDuration(left)} left · seen ${c.seen} · liked ${c.liked} · queued ${c.queued} · shared ${c.shared}
      ${r ? html`<div style="margin-top:6px">NOW: <b>@${r.account || '?'}</b> ${r.action ? (ACTION_PILL[r.action] || null) : html`<span class="mute">${r.step || ''}</span>`}<div class="mute" style="white-space:pre-wrap">${r.description || ''}</div></div>` : null}`);
  };

  const loadStatus = async () => {
    const st = await api('/api/instagram/status', opt);
    if (!ctx.alive()) return;
    const d = st.device || {};
    setSlots(root, {
      'ig-skill': st.enabled ? 'ON' : 'OFF',
      'ig-mode': String(st.settings?.approvalMode || '—').toUpperCase(),
      'ig-group': st.groupName || '—',
      'ig-device': d.connected ? (d.locked ? 'LOCKED' : 'CONNECTED') : 'OFFLINE',
      'ig-device-sub': d.connected
        ? `Android ${d.android} · battery ${d.battery?.level ?? '?'}% · ${d.battery?.tempC ?? '?'}°C · ${d.instagramInFront ? 'Instagram in front' : (d.foreground ? `in front: ${d.foreground}` : 'locked / screen off / overlay')}`
        : (d.error || '—'),
      'ig-today': `${st.today?.liked ?? 0}/${st.settings?.likesPerDay} · ${st.today?.shared ?? 0}/${st.settings?.sharesPerDay}`,
      'ig-warmup': st.warmup?.active ? `DAY ${st.warmup.day}/${st.warmup.of}` : 'DONE',
      'ig-warmup-sub': st.warmup?.active ? 'no in-session shares yet' : 'in-session shares allowed',
      'ig-24h': `${st.last24h?.seen || 0} SEEN`,
      'ig-24h-sub': `${st.last24h?.liked || 0} liked · ${st.last24h?.queued || 0} queued · $${Number(st.last24h?.cost || 0).toFixed(4)} Jev`,
    });
    setSlot(root, 'ig-dry', st.dryRun ? html`<span class="pill warn">DRY RUN · SHARES STOP BEFORE SEND</span>` : null);
    setSlot(root, 'ig-alert', st.alert ? html`<div class="panel" role="alert" style="border-color:var(--red);margin-bottom:12px"><div class="panel-body" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div><b class="red-bright">INSTAGRAM NEEDS YOU</b> <span class="mono">· ${st.alert.text}</span><div class="mute" style="font-size: var(--t-meta)">Automation is paused. Sort it out on the phone yourself, then clear this.</div></div>
      <button data-write type="button" class="danger" id="igClearAlert">CLEAR</button></div></div>` : null);
    const sched = st.schedule || [];
    setSlot(root, 'ig-schedule', sched.length
      ? sched.map((s, i) => html`${i ? ' · ' : ''}${fmtHm(s.at)} ${s.done ? html`<span class="mute">done</span>` : null}`)
      : html`<span class="mute">nothing left today</span>`);
    const sessions = st.sessions || [];
    setSlot(root, 'ig-sessions', sessions.length
      ? sessions.map((x) => html`<tr><td class="id">${x.id}</td><td>${fmtTime(x.started_at)}</td><td>${x.trigger_kind}</td><td class="num">${x.seen}</td><td class="num">${x.liked}</td><td class="num">${x.queued}</td><td class="num">${x.shared}</td><td class="mute">${x.end_reason || (x.ended_at ? '' : 'running')}</td></tr>`)
      : html`<tr><td colspan="8" class="empty">NO SESSIONS YET</td></tr>`);
    showLive(st);
  };

  let queue = [];   // last loaded share queue (the approve handler reads its stored captions)
  const loadQueue = async () => {
    const q = await api('/api/instagram/queue', opt);
    if (!ctx.alive()) return;
    queue = q;
    setSlots(root, { 'ig-queue-count': `${q.length} WAITING` });
    setSlot(root, 'ig-queue', q.length ? q.map(queueRow) : html`<div class="empty">NOTHING QUEUED · STRONG REELS LAND HERE (SAVED IN INSTAGRAM)</div>`);
  };

  const paintReels = () => setSlot(root, 'ig-reels', reels.length ? reels.map(reelRow) : html`<div class="empty">NO REELS YET · PRESS BROWSE INSTAGRAM</div>`);
  const loadReels = async (append = false) => {
    const params = new URLSearchParams({ limit: '30' });
    const q = q$('#igSearch').value.trim();
    const action = q$('#igAction').value;
    if (q) params.set('q', q);
    if (action) params.set('action', action);
    if (append && reels.length) params.set('before', String(reels[reels.length - 1].id));
    const rows = await api(`/api/instagram/reels?${params}`, opt);
    if (!ctx.alive()) return;
    reels = append ? reels.concat(rows) : rows;
    paintReels();
    q$('#igMore').disabled = rows.length < 30;
  };

  const loadTaste = async () => {
    const t = await api('/api/instagram/taste', opt);
    if (!ctx.alive()) return;
    setSlots(root, { 'ig-taste-src': t.source === 'example' ? 'USING THE EXAMPLE CARD' : 'taste.json' });
    const { source, ...card } = t;
    void source;
    q$('#igTaste').value = JSON.stringify(card, null, 2);
  };

  const loadDevLog = async () => {
    const rows = await api('/api/instagram/device-log?limit=80', opt);
    if (!ctx.alive()) return;
    setSlot(root, 'ig-devlog', rows.length
      ? rows.map((c) => html`<tr><td class="mono">${fmtClock(c.ts)}</td><td class="mono">${c.op}</td><td class="mono mute" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.args || ''}</td><td class="mono">${c.foreground || ''}</td><td class="num">${c.ms ?? ''}</td><td>${c.ok ? html`<span class="pill ok">OK</span>` : html`<span class="pill bad" title="${c.error || ''}">REFUSED/ERR</span>`}</td></tr>`)
      : html`<tr><td colspan="6" class="empty">NO COMMANDS YET</td></tr>`);
  };

  const loadChat = async () => {
    const c = await api('/api/instagram/chat?limit=80', opt);
    if (!ctx.alive()) return;
    setSlots(root, { 'ig-chat-status': c.enabled ? `AUTO · EVERY ${c.pollMinutes} MIN` : 'AUTO OFF (SKILLS TAB)' });
    // Like BROWSE, the button is a manual override: it works with the skill off too.
    setSlot(root, 'ig-chat-skill', c.enabled
      ? html`<span class="pill ok">SKILL ON</span>`
      : html`<span class="pill warn" title="The instagram-chat skill is off: no automatic checks. CHECK CHAT NOW still runs.">SKILL OFF · MANUAL STILL RUNS</span>`);
    const lc = c.lastCheck;
    setSlots(root, {
      'ig-chat-last': lc
        ? `last check ${fmtRelative(lc.at)} ago · ${lc.error ? `ERROR: ${lc.error}` : (lc.result?.unread ? `${lc.result.newMessages} new · ${lc.result.action || 'nothing to do'}${lc.result.reply ? ` · "${lc.result.reply}"` : ''}` : 'nothing new')}`
        : 'not checked yet',
    });
    const me = selfName();
    const msgs = c.messages || [];
    setSlot(root, 'ig-chat', msgs.length
      ? msgs.map((m) => {
        const body = m.kind === 'reel'
          ? html`<span class="pill">REEL</span> ${m.reelAccount ? `@${m.reelAccount}` : ''}${m.reelDescription ? html`<div class="mute" style="font-size: var(--t-meta);white-space:pre-wrap">${m.reelDescription}</div>` : null}`
          : html`${m.text || ''}`;
        const act = m.botAction && m.botAction !== 'backfill'
          ? html` <span class="pill ${/replied|sent/.test(m.botAction) ? 'ok' : /react/.test(m.botAction) ? 'warn' : ''}">${m.botAction}</span>` : null;
        return html`<div style="padding:6px 12px;border-bottom:1px solid var(--line-1);font-size: var(--t-data);${m.fromMe ? 'background:rgba(200,16,46,0.05)' : ''}">${m.fromMe ? html`<b class="red-bright">${me}</b>` : html`<b>${m.senderName || '?'}</b>`}${m.replyToMe ? html` <span class="mute">↩ to ${me}</span>` : null}: ${body}${act}</div>`;
      })
      : html`<div class="empty">NO MESSAGES READ YET</div>`);
    const box = q$('[data-slot="ig-chat"]');
    if (box) box.scrollTop = box.scrollHeight;
  };

  const loadMembers = async () => {
    const [members, people] = await Promise.all([api('/api/instagram/members', opt), api('/api/people?limit=500', opt)]);
    if (!ctx.alive()) return;
    const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
    const shown = (members || []).filter((m) => !m.isSelf);
    setSlot(root, 'ig-members', shown.length
      ? shown.map((m) => {
        const mine = words(`${m.displayName} ${m.username}`);
        const ranked = (people || []).map((p) => ({ p, score: [...words(`${p.realName} ${p.pushName}`)].filter((w) => mine.has(w)).length }))
          .sort((a, b) => b.score - a.score || String(a.p.realName || a.p.pushName).localeCompare(String(b.p.realName || b.p.pushName)));
        return html`<tr><td><b>${m.displayName || m.username}</b>${m.admin ? html` <span class="pill">ADMIN</span>` : null}${m.inGroup ? null : html` <span class="pill bad">LEFT</span>`}</td><td class="mono">${m.username}</td>
          <td><select class="ig-link" data-username="${m.username}" aria-label="WhatsApp person for ${m.username}"><option value="">— not linked —</option>${ranked.map(({ p, score }) => html`<option value="${p.jid}" ${p.jid === m.personJid ? raw('selected') : null}>${p.realName || p.pushName || p.jid}${score && p.jid !== m.personJid ? '  (suggested)' : ''}</option>`)}</select></td></tr>`;
      })
      : html`<tr><td colspan="3" class="empty">MEMBERS ARE READ ON THE FIRST CHAT CHECK</td></tr>`);
  };

  try {
    await Promise.all([loadStatus(), loadQueue(), loadReels(), loadTaste(), loadDevLog(), loadChat(), loadMembers()]);
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  if (!ctx.alive()) return;
  const quiet = (p) => p.catch(() => {});

  // ── actions (delegated on the page root; removed on navigation) ──
  ctx.listen(root, 'click', async (e) => {
    const t = e.target.closest?.('button');
    if (!t || !root.contains(t)) return;
    if (t.id === 'igClearAlert') {
      try { await api('/api/instagram/alert/clear', { method: 'POST' }); flash('ALERT CLEARED'); quiet(loadStatus()); } catch (err) { flash(err.message, 'bad'); }
    } else if (t.classList.contains('ig-approve')) {
      const id = t.dataset.id;
      const caption = root.querySelector(`.ig-caption[data-id="${CSS.escape(id)}"]`)?.value ?? '';
      if (!(await askSheet({ label: 'Send to the group', text: 'Send this reel to the Instagram group now?', action: 'SEND', danger: true })).ok || !ctx.alive()) return;
      t.disabled = true;
      try {
        const stored = queue.find((x) => String(x.id) === id)?.shareCaption ?? null;
        const res = await api(`/api/instagram/queue/${encodeURIComponent(id)}/approve`, { method: 'POST', body: approveBody(caption, stored) });
        flash(res.dryRun ? 'DRY RUN · STOPPED BEFORE SEND' : 'SENT TO THE GROUP');
      } catch (err) { flash(err.message, 'bad'); }
      quiet(loadQueue());
    } else if (t.classList.contains('ig-veto')) {
      try { await api(`/api/instagram/queue/${encodeURIComponent(t.dataset.id)}/veto`, { method: 'POST' }); flash('VETOED'); quiet(loadQueue()); } catch (err) { flash(err.message, 'bad'); }
    } else if (t.classList.contains('ig-label')) {
      // GOOD/BAD on Jev's call (click again to clear) — the labels thresholds get tuned against.
      const label = Number(t.dataset.label);
      try {
        await api(`/api/instagram/reels/${encodeURIComponent(t.dataset.id)}/label`, { method: 'POST', body: { label } });
        const r = reels.find((x) => String(x.id) === t.dataset.id);
        if (r) r.userLabel = label || null;
        if (ctx.alive()) paintReels();
      } catch (err) { flash(err.message, 'bad'); }
    } else if (t.id === 'igChatCheck') {
      t.disabled = true;
      flash('CHECKING THE GROUP CHAT…', 'warn');
      try { const r = await api('/api/instagram/chat/check', { method: 'POST' }); flash(r.result?.reply ? `REPLIED: ${r.result.reply}` : 'CHECKED'); } catch (err) { flash(err.message, 'bad'); }
      t.disabled = false;
      quiet(loadChat()); quiet(loadMembers()); quiet(loadDevLog());
    } else if (t.id === 'igBrowse') {
      const minutes = Number(q$('#igMinutes').value);
      const allowShare = q$('#igAllowShare').checked;
      if (allowShare && (!(await askSheet({ label: 'Allow sharing', text: 'Allow him to send strong reels straight into the group during this session?', action: 'ALLOW', danger: true })).ok || !ctx.alive())) return;
      try { const res = await api('/api/instagram/browse', { method: 'POST', body: { minutes, allowShare } }); flash(`SESSION #${res.sessionId} STARTED`); quiet(loadStatus()); } catch (err) { flash(err.message, 'bad'); }
    } else if (t.id === 'igStop') {
      try { const res = await api('/api/instagram/stop', { method: 'POST' }); flash(res.ok ? 'STOPPING' : 'NOTHING RUNNING', res.ok ? 'ok' : 'warn'); } catch (err) { flash(err.message, 'bad'); }
    } else if (t.id === 'igMore') {
      loadReels(true).catch((err) => { if (!isAbort(err)) flash(err.message, 'bad'); });
    } else if (t.id === 'igTasteSave') {
      let card;
      try { card = JSON.parse(q$('#igTaste').value); } catch { flash('TASTE CARD IS NOT VALID JSON', 'bad'); return; }
      try { await api('/api/instagram/taste', { method: 'PUT', body: card }); flash('TASTE CARD SAVED'); quiet(loadTaste()); } catch (err) { flash(err.message, 'bad'); }
    }
  });
  ctx.listen(root, 'change', async (e) => {
    const sel = e.target.closest?.('select.ig-link');
    if (!sel) return;
    try {
      await api(`/api/instagram/members/${encodeURIComponent(sel.dataset.username)}/link`, { method: 'POST', body: { personJid: sel.value || null } });
      flash(sel.value ? 'LINKED' : 'UNLINKED');
    } catch (err) { flash(err.message, 'bad'); }
  });
  let searchTimer = null;
  ctx.listen(q$('#igSearch'), 'input', () => { clearTimeout(searchTimer); searchTimer = ctx.setTimeout(() => quiet(loadReels()), 300); });
  ctx.listen(q$('#igAction'), 'change', () => quiet(loadReels()));

  // ── live: reel-by-reel progress, queue changes, alerts, chat ──
  let refreshTimer = null;
  ctx.on('instagram', (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.kind === 'snapshot' || data.kind === 'session') {
      if (data.state) showLive(data.state);
      if (data.ended) { quiet(loadStatus()); quiet(loadQueue()); quiet(loadDevLog()); }
    } else if (data.kind === 'reel') {
      api('/api/instagram/status', opt).then(showLive).catch(() => {});
      if (data.reel?.action) {
        clearTimeout(refreshTimer);
        refreshTimer = ctx.setTimeout(() => { quiet(loadReels()); quiet(loadDevLog()); }, 800);
      }
    } else if (data.kind === 'queue') {
      quiet(loadQueue());
    } else if (data.kind === 'alert') {
      quiet(loadStatus());
    } else if (data.kind === 'chat') {
      quiet(loadChat());
    }
  });
}
