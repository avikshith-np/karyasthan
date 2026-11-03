// 04 MEMORIES — the memory ledger with spec 006 provenance: origin (kind + where
// learned) and audience columns, origin/category filters, superseded rows on
// demand, owner notes with a selectable visibility, and the read-only DM → chat
// relays list.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtRelative, fmtTime } from '../core/fmt.js';
import { showError } from '../components/ui.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { originCell, VISIBILITY_LABELS } from '../components/provenance.js';

const CATEGORY_OPTIONS = '<option value="fact">fact</option><option value="event">event</option><option value="temporary">temporary</option><option value="interest">interest</option><option value="lore">lore</option><option value="preference">preference</option>';
// The filter also lists the mind's daily/weekly episodes (never created by hand).
const FILTER_CATEGORY_OPTIONS = `${CATEGORY_OPTIONS}<option value="episode">episode</option>`;

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · MEMORIES · WHAT HE LEARNED, AND YOUR NOTES</div>
    <h1>Memories</h1>
  </div>
  <div class="meta">
    <span>LOADED <b data-slot="mem-total">—</b></span>
    <span>FACT <b data-slot="mem-fact">—</b></span>
    <span>TEMP <b class="amber" data-slot="mem-temp">—</b></span>
    <span>INTEREST <b data-slot="mem-interest">—</b></span>
  </div>
</div>

<div class="toolbar" style="grid-template-columns:1fr auto auto auto auto;gap:8px;margin-bottom:12px">
  <input type="search" placeholder="FILTER · CONTENT / ORIGIN" id="memFilter" aria-label="Filter memories" />
  <select id="memCatFilter" aria-label="Category"><option value="">ALL CATEGORIES</option>${FILTER_CATEGORY_OPTIONS}</select>
  <select id="memOriginFilter" aria-label="Origin"><option value="">ALL ORIGINS</option><option value="group">group</option><option value="dm">dm</option><option value="call">call</option><option value="ig">instagram</option><option value="owner">owner</option><option value="self">self</option></select>
  <label class="mono mute" style="display:flex;align-items:center;gap:4px;font-size: var(--t-label)"><input type="checkbox" id="memSuperseded" /> SUPERSEDED</label>
  <button data-write type="button" class="primary" id="memAddBtn">+ ADD NOTE</button>
</div>

<div class="panel" id="memAddPanel" style="margin-bottom:12px;display:none">
  <div class="panel-head"><span>NEW OWNER NOTE<button type="button" class="guide-q" data-guide="add" aria-label="Guide: add">?</button></span><span class="mono mute">origin = owner · not tied to a chat</span></div>
  <div class="panel-body">
    <form id="memAddForm" class="toolbar" style="grid-template-columns:repeat(3,1fr);gap:8px">
      <select name="category" required aria-label="Category">${CATEGORY_OPTIONS}</select>
      <input type="text" name="subject_jid" placeholder="subject_jid (person · needed unless 'everywhere')" aria-label="Subject JID" />
      <select name="visibility" aria-label="Who may hear it">
        <option value="subject_dm">who hears it · their DM only (default)</option>
        <option value="subject_groups">their DM + outsider-free groups they're in</option>
        <option value="everywhere">everywhere</option>
      </select>
      <input type="text" name="content" placeholder="content" required aria-label="Content" style="grid-column:span 2" />
      <input type="number" name="importance" step="0.05" min="0" max="1" value="0.5" placeholder="importance" aria-label="Importance" />
      <input type="number" name="expires_in_days" placeholder="expires_in_days (opt)" aria-label="Expires in days" />
      <button type="button" id="memAddCancel">CANCEL</button>
      <button data-write class="primary" type="submit" style="grid-column:span 2">CREATE</button>
    </form>
  </div>
</div>

<div class="kpi-grid" style="margin-bottom:14px">
  <div class="kpi"><div class="lab"><span>MEMORIES · LOADED</span></div>
    <div class="val mono" data-slot="mem-kpi-writes">—</div><div class="sub">newest ≤ 300 · all categories</div></div>
  <div class="kpi"><div class="lab"><span>RECALLS · LOADED</span></div>
    <div class="val mono" data-slot="mem-kpi-recalls">—</div><div class="sub">summed recall_count of loaded rows</div></div>
  <div class="kpi"><div class="lab"><span>EXPIRING · 24H</span></div>
    <div class="val mono amber" data-slot="mem-kpi-expiring">—</div><div class="sub">temp · auto-purge</div></div>
  <div class="kpi alert"><div class="lab"><span>LOW-CONFIDENCE</span></div>
    <div class="val mono" data-slot="mem-kpi-lowconf">—</div><div class="sub">imp &lt; 0.30 · review</div></div>
</div>

<div class="panel">
  <div class="panel-head"><span>ALL MEMORIES<button type="button" class="guide-q" data-guide="ledger" aria-label="Guide: all memories">?</button></span><span class="mono mute">NEWEST FIRST</span></div>
  <table class="data">
    <thead><tr><th>ID</th><th>CAT</th><th>SUBJECT</th><th>ORIGIN</th><th>CONTENT</th><th>AUDIENCE</th><th>IMP</th><th>RECALL</th><th>LEARNED</th><th>EXPIRES</th><th></th></tr></thead>
    <tbody data-slot="mem-rows"><tr><td colspan="11" class="loading">LOADING</td></tr></tbody>
  </table>
</div>

<div class="panel" style="margin-top:14px">
  <div class="panel-head"><span>RELAYS · DM → CHAT<button type="button" class="guide-q" data-guide="relays" aria-label="Guide: relays">?</button></span>
    <select id="relayStateFilter" aria-label="Relay state" style="font-size: var(--t-label);padding:2px 4px"><option value="">ALL STATES</option><option value="pending">pending</option><option value="confirmed">confirmed</option><option value="sent">sent</option><option value="declined">declined</option><option value="expired">expired</option><option value="failed">failed</option></select>
  </div>
  <table class="data">
    <thead><tr><th>ID</th><th>REQUESTER</th><th>TARGET</th><th>CONTENT</th><th>STATE</th><th>CREATED</th><th>CONFIRMED</th><th>SENT</th></tr></thead>
    <tbody data-slot="relay-rows"><tr><td colspan="8" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`);

// Kept across visits in this tab, like the pre-007 page.
let showSuperseded = false;

/** KPI counts for the header and tiles. */
export function memoryCounts(mems, now = Math.floor(Date.now() / 1000)) {
  const byCat = {};
  let recalls = 0; let expiringSoon = 0; let lowConf = 0;
  for (const m of mems) {
    byCat[m.category] = (byCat[m.category] || 0) + 1;
    recalls += Number(m.recall_count || 0);
    if (m.expires_at && m.expires_at > now && m.expires_at < now + 86400) expiringSoon++;
    if ((m.importance ?? 1) < 0.30) lowConf++;
  }
  return { byCat, recalls, expiringSoon, lowConf };
}

function audienceCell(m) {
  if (m.origin_kind !== 'owner') return m.audience_summary || '—';
  const vis = m.visibility || 'subject_dm';
  return html`<select class="mem-vis" data-id="${m.id}" aria-label="Visibility of #${m.id}" style="font-size: var(--t-label);padding:2px 4px">${Object.entries(VISIBILITY_LABELS).map(([v, l]) => html`<option value="${v}" ${vis === v ? raw('selected') : ''}>${l}</option>`)}</select><div>${m.audience_summary || ''}</div>`;
}

function memoryRow(m) {
  return html`
    <tr data-mem-id="${m.id}" style="${m.superseded_by ? 'opacity:.5' : ''}">
      <td class="id">#${m.id}</td>
      <td><span class="${m.category === 'temporary' ? 'chip warn' : 'chip'}">${m.category}</span></td>
      <td>${m.subject_name || '—'}</td>
      <td>${originCell(m)}</td>
      <td>${m.content || ''}${m.superseded_by ? html` <span class="mono mute" style="font-size: var(--t-label)">· superseded by #${m.superseded_by}</span>` : ''}</td>
      <td class="mute" style="font-size: var(--t-label)">${audienceCell(m)}</td>
      <td class="num">${(m.importance ?? 0).toFixed(2)}</td>
      <td class="num">${m.recall_count || 0}${m.last_recalled_at ? html`<div class="mono mute" style="font-size: var(--t-micro)">${fmtRelative(m.last_recalled_at)}</div>` : ''}</td>
      <td class="mono mute" title="${`created ${fmtTime(m.created_at)} · source ${m.source || '?'}`}">${fmtRelative(m.learned_at ?? m.created_at)}</td>
      <td>${m.expires_at ? html`<span class="amber mono">${fmtRelative(m.expires_at)}</span>` : html`<span class="mute">—</span>`}</td>
      <td><button data-write type="button" class="danger mem-del" data-id="${m.id}" style="padding:3px 6px;font-size: var(--t-micro)">DEL</button></td>
    </tr>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const filterInput = $(root, '#memFilter');
  const catSel = $(root, '#memCatFilter');
  const originSel = $(root, '#memOriginFilter');
  const supBox = $(root, '#memSuperseded');
  const relaySel = $(root, '#relayStateFilter');
  const addPanel = $(root, '#memAddPanel');
  if (supBox) supBox.checked = showSuperseded;
  let mems = [];

  const renderRows = () => {
    const q = (filterInput?.value || '').toLowerCase();
    const cat = catSel?.value || '';
    const origin = originSel?.value || '';
    const rows = mems.filter((m) => {
      if (cat && m.category !== cat) return false;
      if (origin && m.origin_kind !== origin) return false;
      if (q && !`${m.content || ''} ${m.origin_label || ''} ${m.subject_name || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    setSlot(root, 'mem-rows', rows.length ? rows.map(memoryRow) : html`<tr><td colspan="11" class="empty">NO MATCHES</td></tr>`);
  };

  async function load() {
    try {
      mems = await api(`/api/memories?limit=300${showSuperseded ? '&include_superseded=1' : ''}`, { signal: ctx.signal });
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) showError(root, err);
      return;
    }
    if (!ctx.alive()) return;
    const c = memoryCounts(mems);
    setSlots(root, {
      'mem-total': mems.length,
      'mem-fact': c.byCat.fact || 0,
      'mem-temp': c.byCat.temporary || 0,
      'mem-interest': c.byCat.interest || 0,
      'mem-kpi-writes': mems.length,
      'mem-kpi-recalls': c.recalls.toLocaleString(),
      'mem-kpi-expiring': c.expiringSoon,
      'mem-kpi-lowconf': c.lowConf,
    });
    renderRows();
  }

  async function loadRelays() {
    try {
      const relays = await api(`/api/relays?limit=100${relaySel?.value ? `&state=${encodeURIComponent(relaySel.value)}` : ''}`, { signal: ctx.signal });
      if (!ctx.alive()) return;
      setSlot(root, 'relay-rows', relays.length
        ? relays.map((r) => html`<tr>
            <td class="id">#${r.id}</td>
            <td>${r.requester_name || r.requester_jid}</td>
            <td>${r.target_name || r.target_jid || '—'}</td>
            <td>${r.content || ''}${r.error ? html` <span class="mono amber" style="font-size: var(--t-label)">· ${r.error}</span>` : ''}</td>
            <td><span class="chip ${r.state === 'failed' ? 'warn' : ''}">${r.state}</span></td>
            <td class="mono mute">${fmtRelative(r.created_at)}</td>
            <td class="mono mute">${fmtRelative(r.confirmed_at)}</td>
            <td class="mono mute">${fmtRelative(r.sent_at)}</td></tr>`)
        : html`<tr><td colspan="8" class="empty">NO RELAYS</td></tr>`);
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) setSlot(root, 'relay-rows', html`<tr><td colspan="8" class="empty">${err.message}</td></tr>`);
    }
  }

  ctx.listen(filterInput, 'input', renderRows);
  ctx.listen(catSel, 'change', renderRows);
  ctx.listen(originSel, 'change', renderRows);
  ctx.listen(supBox, 'change', () => { showSuperseded = !!supBox.checked; load(); });
  ctx.listen(relaySel, 'change', loadRelays);

  // Owner-note visibility (delegated: rows are re-rendered on every filter).
  ctx.listen(root, 'change', async (e) => {
    const sel = e.target;
    if (!(sel instanceof Element) || !sel.classList.contains('mem-vis')) return;
    const id = sel.dataset.id;
    if (sel.value !== 'subject_dm' && !(await askSheet({ label: 'Who may hear it', text: `Widen who may hear owner note #${id} to "${VISIBILITY_LABELS[sel.value]}"?`, action: 'WIDEN', danger: true })).ok) { if (ctx.alive()) load(); return; }
    if (!ctx.alive()) return;
    try {
      await api(`/api/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: { visibility: sel.value } });
      flash(`#${id} · ${VISIBILITY_LABELS[sel.value].toUpperCase()}`);
    } catch (err) { flash(err.message, 'bad'); }
    load();
  });

  ctx.listen(root, 'click', async (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn) return;
    if (btn.classList.contains('mem-del')) {
      const id = btn.dataset.id;
      if (!(await askSheet({ label: `Delete memory #${id}`, text: 'A learned memory will not be relearned.', action: 'DELETE', danger: true })).ok || !ctx.alive()) return;
      try {
        const r = await api(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
        flash(`DELETED #${id}${r?.tombstoned ? ' · WILL NOT BE RELEARNED' : ''}`);
        load();
      } catch (err) { flash(err.message, 'bad'); }
      return;
    }
    if (btn.id === 'memAddBtn' && addPanel) addPanel.style.display = addPanel.style.display === 'none' ? '' : 'none';
    if (btn.id === 'memAddCancel' && addPanel) addPanel.style.display = 'none';
  });

  ctx.listen(root, 'submit', async (e) => {
    if (e.target?.id !== 'memAddForm') return;
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      category: fd.get('category'),
      subject_jid: fd.get('subject_jid') || null,
      visibility: fd.get('visibility') || 'subject_dm',
      content: fd.get('content'),
      importance: Number(fd.get('importance')) || 0.5,
      expires_in_days: fd.get('expires_in_days') ? Number(fd.get('expires_in_days')) : null,
    };
    try { await api('/api/memories', { method: 'POST', body }); flash('MEMORY CREATED'); e.target.reset(); load(); } catch (err) { flash(err.message, 'bad'); }
  });

  loadRelays();
  await load();
}
