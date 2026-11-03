// 12 AUDIT — every dashboard write, newest first, with filter + JSONL export.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, $ } from '../core/dom.js';
import { fmtRelative, fmtTime } from '../core/fmt.js';
import { showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · AUDIT · EVERY CHANGE MADE HERE</div>
    <h1>Audit</h1>
  </div>
  <div class="meta">
    <span>WRITES <b data-slot="audit-total">—</b></span>
    <span>BY <b data-slot="audit-actors">—</b></span>
  </div>
</div>

<div class="toolbar" style="display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-bottom:12px">
  <input type="search" id="auditFilter" aria-label="Filter audit rows" placeholder="FILTER · ACTION / WHO / TARGET" />
  <select id="auditActionFilter" aria-label="Action"><option value="">ALL ACTIONS</option></select>
  <button id="auditExport">↧ EXPORT JSONL</button>
</div>

<div class="panel">
  <div class="panel-head"><span>LATEST WRITES<button type="button" class="guide-q" data-guide="ledger" aria-label="Guide: latest writes">?</button></span><span class="mono mute" data-slot="audit-shown">—</span></div>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>#</th><th>WHEN</th><th>WHO</th><th>ACTION</th><th>TARGET</th><th>PAYLOAD</th></tr></thead>
    <tbody data-slot="audit-rows"><tr><td colspan="6" class="loading">LOADING</td></tr></tbody>
  </table></div>
</div>
`);

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  let rows;
  try {
    rows = await api('/api/audit?limit=200', { signal: ctx.signal });
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  if (!ctx.alive()) return;
  rows = Array.isArray(rows) ? rows : [];
  const actors = [...new Set(rows.map((r) => r.actor).filter(Boolean))];
  const who = actors.slice(0, 2).join(', ') + (actors.length > 2 ? ` +${actors.length - 2}` : '');
  setSlots(root, { 'audit-total': rows.length, 'audit-actors': who || '—', 'audit-shown': `${rows.length} ENTRIES` });

  const actionSel = $(root, '#auditActionFilter');
  const filterInput = $(root, '#auditFilter');
  const tbody = $(root, '[data-slot="audit-rows"]');
  const actions = [...new Set(rows.map((r) => r.action).filter(Boolean))].sort();
  render(actionSel, html`<option value="">ALL ACTIONS</option>${actions.map((a) => html`<option value="${a}">${a}</option>`)}`);

  const renderRows = () => {
    const q = (filterInput?.value || '').toLowerCase();
    const action = actionSel?.value || '';
    const shown = rows.filter((r) => {
      if (action && r.action !== action) return false;
      if (!q) return true;
      return `${r.action || ''} ${r.actor || ''} ${r.target || ''} ${JSON.stringify(r.payload || {})}`.toLowerCase().includes(q);
    });
    setSlots(root, { 'audit-shown': `${shown.length} / ${rows.length} ENTRIES` });
    render(tbody, shown.length
      ? shown.map((r) => html`<tr>
          <td class="id">#${r.id}</td>
          <td class="mono mute" title="${fmtTime(r.ts)}">${fmtRelative(r.ts)}</td>
          <td><b>${r.actor || '—'}</b></td>
          <td><span class="chip">${r.action || '—'}</span></td>
          <td class="mono" style="font-size: var(--t-meta)">${r.target || '—'}</td>
          <td class="mono mute" style="font-size: var(--t-label)">${r.payload ? JSON.stringify(r.payload).slice(0, 80) : ''}</td>
        </tr>`)
      : html`<tr><td colspan="6" class="empty">NO MATCHES</td></tr>`);
  };
  ctx.listen(filterInput, 'input', renderRows);
  ctx.listen(actionSel, 'change', renderRows);
  renderRows();

  ctx.listen($(root, '#auditExport'), 'click', () => {
    const blob = new Blob([rows.map((r) => JSON.stringify(r)).join('\n')], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${Date.now()}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
}
