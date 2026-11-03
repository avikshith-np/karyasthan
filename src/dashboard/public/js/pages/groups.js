// 02 GROUPS — registry of chats the bot is in, with a name/JID/vibe filter.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtRelative, padz } from '../core/fmt.js';
import { showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · GROUPS · THE GROUPS HE IS IN</div>
    <h1>Groups</h1>
  </div>
  <div class="meta">
    <span>TOTAL <b data-slot="groups-total">—</b></span>
    <span>ACTIVE <b data-slot="groups-active">—</b></span>
    <span>MUTED <b class="red" data-slot="groups-muted">—</b></span>
  </div>
</div>

<div class="toolbar" style="grid-template-columns:1fr auto;gap:8px;margin-bottom:12px">
  <input type="search" placeholder="FILTER · NAME / JID / VIBE" id="groupsFilter" aria-label="Filter groups" />
  <select id="groupsVibeFilter" aria-label="Filter by vibe"><option value="">ALL VIBES</option></select>
</div>

<div class="panel">
  <div class="panel-head"><span>ALL GROUPS<button type="button" class="guide-q" data-guide="registry" aria-label="Guide: all groups">?</button></span><span class="mono mute" data-slot="groups-sort">LATEST ACTIVE FIRST</span></div>
  <table class="data">
    <thead><tr><th>#</th><th>NAME</th><th>JID</th><th>VIBE</th><th>MEMBERS</th><th>MSG·30D</th><th>LAST</th><th>STATE</th></tr></thead>
    <tbody data-slot="groups-rows"><tr><td colspan="8" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`);

/** Short, delimited vibe fragments become chips; anything else stays one string. */
export function vibeChunks(vibe) {
  if (!vibe) return [];
  const parts = vibe.split(/[,·•|]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => p.length <= 24)) return parts;
  return [vibe];
}

function vibeCell(vibe) {
  if (!vibe) return html`<span class="mute">—</span>`;
  const chunks = vibeChunks(vibe);
  return chunks.length > 1
    ? chunks.map((v) => html`<span class="chip">${v}</span>`)
    : html`<span class="mute mono" style="font-size: var(--t-label)" title="${vibe}">${vibe.slice(0, 60)}${vibe.length > 60 ? '…' : ''}</span>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  try {
    const groups = await api('/api/groups', { signal: ctx.signal });
    if (!ctx.alive()) return;
    const total = groups.length;
    const muted = groups.filter((g) => g.muted).length;
    setSlots(root, {
      'groups-total': total,
      'groups-active': total - muted,
      'groups-muted': muted,
      'groups-sort': `LATEST ACTIVE FIRST · ${total}`,
    });

    const vibeSel = $(root, '#groupsVibeFilter');
    const filterInput = $(root, '#groupsFilter');
    const vibesSeen = new Set();
    for (const g of groups) for (const v of vibeChunks(g.vibe)) if (v.length <= 24) vibesSeen.add(v);
    if (vibeSel) {
      render(vibeSel, html`<option value="">ALL VIBES</option>${[...vibesSeen].sort().map((v) => html`<option value="${v}">${v.toUpperCase()}</option>`)}`);
    }

    const renderRows = () => {
      const q = (filterInput?.value || '').toLowerCase();
      const vibeF = (vibeSel?.value || '').toLowerCase();
      const rows = groups.filter((g) => {
        const text = `${g.name || ''} ${g.jid} ${g.vibe || ''}`.toLowerCase();
        if (q && !text.includes(q)) return false;
        if (vibeF && !(g.vibe || '').toLowerCase().includes(vibeF)) return false;
        return true;
      });
      setSlot(root, 'groups-rows', rows.length
        ? rows.map((g, i) => {
          const jidShort = g.jid?.length > 20 ? '…' + g.jid.slice(-12) : g.jid;
          return html`
          <tr>
            <td class="id">${padz(i + 1, 2)}</td>
            <td><b><a href="#group/${encodeURIComponent(g.jid)}">${g.name || g.jid}</a></b></td>
            <td class="id">${jidShort || '—'}</td>
            <td>${vibeCell(g.vibe)}</td>
            <td class="num">${g.memberCount ?? '—'}</td>
            <td class="num">${(g.messageCount || 0).toLocaleString()}</td>
            <td class="mono mute">${fmtRelative(g.lastActive)}</td>
            <td>${g.muted ? html`<span class="pill bad">MUTED</span>` : html`<span class="pill ok">ACTIVE</span>`}</td>
          </tr>`;
        })
        : html`<tr><td colspan="8" class="empty">NO MATCHES</td></tr>`);
    };
    ctx.listen(filterInput, 'input', renderRows);
    ctx.listen(vibeSel, 'change', renderRows);
    renderRows();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
  }
}
