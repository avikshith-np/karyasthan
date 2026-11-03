// 03 PEOPLE — registry of people seen, with a name/trait filter. Traits and
// interests here are the list API's merged view (operator sees everything).
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtRelative, maskPhone, padz } from '../core/fmt.js';
import { showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · CONTACTS · THE REAL PEOPLE HE KNOWS</div>
    <h1>Contacts</h1>
  </div>
  <div class="meta">
    <span>TOTAL <b data-slot="people-total">—</b></span>
    <span>RECENT <b data-slot="people-recent">—</b></span>
    <span>SHOWING <b data-slot="people-shown">—</b></span>
  </div>
</div>

<div class="toolbar" style="grid-template-columns:1fr auto;gap:8px;margin-bottom:12px">
  <input type="search" placeholder="FILTER · NAME / TRAIT" id="peopleFilter" aria-label="Filter people" />
  <select id="peopleTraitFilter" aria-label="Filter by trait"><option value="">ALL TRAITS</option></select>
</div>

<div class="panel">
  <div class="panel-head"><span>ALL CONTACTS<button type="button" class="guide-q" data-guide="registry" aria-label="Guide: all contacts">?</button></span><span class="mono mute">LATEST SEEN FIRST</span></div>
  <table class="data">
    <thead><tr><th>#</th><th>NAME</th><th>HANDLE</th><th>TRAITS</th><th>INTERESTS</th><th>MSG</th><th>LAST</th></tr></thead>
    <tbody data-slot="people-rows"><tr><td colspan="7" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`);

const chips = (list) => (list || []).length
  ? list.slice(0, 3).map((t) => html`<span class="chip">${t}</span>`)
  : html`<span class="mute mono">—</span>`;

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  try {
    const people = await api('/api/people?limit=200', { signal: ctx.signal });
    if (!ctx.alive()) return;
    const recentCutoff = Date.now() / 1000 - 7 * 86400;
    setSlots(root, {
      'people-total': people.length,
      'people-recent': people.filter((p) => p.lastSeen && p.lastSeen > recentCutoff).length,
      'people-shown': people.length,
    });

    const traitSel = $(root, '#peopleTraitFilter');
    const filterInput = $(root, '#peopleFilter');
    const traitsSeen = new Set();
    for (const p of people) for (const t of (p.traits || [])) traitsSeen.add(t);
    if (traitSel) {
      render(traitSel, html`<option value="">ALL TRAITS</option>${[...traitsSeen].sort().map((t) => html`<option value="${t}">${String(t).toUpperCase()}</option>`)}`);
    }

    const renderRows = () => {
      const q = (filterInput?.value || '').toLowerCase();
      const traitF = (traitSel?.value || '').toLowerCase();
      const rows = people.filter((p) => {
        const name = p.realName || p.pushName || p.jid;
        const text = `${name} ${(p.traits || []).join(' ')} ${(p.interests || []).join(' ')}`.toLowerCase();
        if (q && !text.includes(q)) return false;
        if (traitF && !(p.traits || []).map((t) => String(t).toLowerCase()).includes(traitF)) return false;
        return true;
      });
      setSlot(root, 'people-rows', rows.length
        ? rows.map((p, i) => html`
          <tr>
            <td class="id">${padz(i + 1, 3)}</td>
            <td><b><a href="#person/${encodeURIComponent(p.jid)}">${p.realName || p.pushName || p.jid}</a></b></td>
            <td class="id">${maskPhone(p.phone)}</td>
            <td>${chips(p.traits)}</td>
            <td>${chips(p.interests)}</td>
            <td class="num">${(p.messageCount || 0).toLocaleString()}</td>
            <td class="mono mute">${fmtRelative(p.lastSeen)}</td>
          </tr>`)
        : html`<tr><td colspan="7" class="empty">NO MATCHES</td></tr>`);
      setSlots(root, { 'people-shown': rows.length });
    };
    ctx.listen(filterInput, 'input', renderRows);
    ctx.listen(traitSel, 'change', renderRows);
    renderRows();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
  }
}
