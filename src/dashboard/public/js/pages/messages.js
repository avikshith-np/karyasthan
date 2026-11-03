// 06 SEARCH — full-text search over stored messages (FTS5), with facets.
//
// Facet chips refine: a GROUP chip re-runs the query inside that group on the server
// (/api/messages/search?group=), a SENDER or DATE chip filters the loaded hits in the
// page (the API has no sender/date filter). Clicking an active chip clears it.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtHm } from '../core/fmt.js';
import { getStatus } from '../components/topbar.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · SEARCH · EVERY STORED MESSAGE</div>
    <h1>Search</h1>
  </div>
  <div class="meta">
    <span>HITS <b data-slot="msg-hits">—</b></span>
    <span>TOOK (MS) <b data-slot="msg-ms">—</b></span>
  </div>
</div>

<div class="panel" style="margin-bottom:14px">
  <div class="panel-body toolbar" style="grid-template-columns:1fr auto;gap:8px;align-items:center">
    <input type="search" id="msgQuery" aria-label="Search messages" placeholder='word or "phrase"' />
    <button class="primary" id="msgRun">SEARCH</button>
  </div>
  <div style="padding:8px 12px;border-top:1px solid var(--line-2);font-family:var(--font-mono);font-size: var(--t-label);color:var(--ink-3);display:flex;gap:14px">
    <span><span class="kbd">/</span> focus</span>
    <span><span class="kbd">↵</span> run</span>
    <span data-slot="msg-summary" class="red-bright">—</span>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>HITS<button type="button" class="guide-q" data-guide="hits" aria-label="Guide: hits">?</button></span><span class="mono mute">NEWEST FIRST</span></div>
    <div style="max-height:540px;overflow-y:auto" data-slot="msg-results"><div class="empty">TYPE A SEARCH ABOVE</div></div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>FILTERS<button type="button" class="guide-q" data-guide="facets" aria-label="Guide: filters">?</button></span><span class="mono mute" data-slot="msg-refine">CLICK TO REFINE</span></div>
    <div class="panel-body">
      <div class="cap mute" style="font-size: var(--t-label)">BY GROUP</div>
      <div style="margin-top:6px" data-slot="msg-facet-group"><span class="mute mono">—</span></div>
      <div class="divider" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size: var(--t-label)">BY SENDER</div>
      <div style="margin-top:6px" data-slot="msg-facet-sender"><span class="mute mono">—</span></div>
      <div class="divider" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size: var(--t-label)">BY DATE</div>
      <div style="margin-top:6px" data-slot="msg-facet-date"><span class="mute mono">—</span></div>
    </div>
  </div>
</div>
`);

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Search terms for highlighting: words and quoted phrases, minus FTS operators. */
function queryTerms(q) {
  const terms = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? '').replace(/^[(]+|[)*]+$/g, '').trim();
    if (!t || /^(AND|OR|NOT|NEAR)$/i.test(t)) continue;
    terms.push(t);
  }
  return terms;
}

/** Text with matches wrapped in <mark>; every piece escaped (no markup from data). */
function highlight(text, terms) {
  if (!terms.length) return html`${text}`;
  const re = new RegExp(`(${terms.map(reEscape).join('|')})`, 'gi');
  return String(text).split(re).map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : html`${part}`));
}

// entries: [value, label, count]; the active value is highlighted (aria-pressed).
const chips = (facet, entries, active) => (entries.length
  ? entries.map(([value, label, n]) => html`<button type="button" class="chip${value === active ? ' warn' : ''}" data-facet="${facet}" data-value="${value}" aria-pressed="${value === active ? 'true' : 'false'}" style="cursor:pointer">${label} · ${n}</button>`)
  : html`<span class="mute mono">—</span>`);

const DATE_WINDOWS = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const input = $(root, '#msgQuery');
  const runBtn = $(root, '#msgRun');
  const results = $(root, '[data-slot="msg-results"]');
  let timer = null;
  let seq = 0; // newest query wins; an older response arriving late is dropped
  let rows = [];
  let lastMs = '—';
  let lastQ = '';
  const refine = { group: null, sender: null, date: null };

  // Hits + facets from the loaded rows. Facet counts are over the server's hits (so a
  // chip stays visible while it is active); the list shows the sender/date-filtered ones.
  function paintResults() {
    const now = Date.now() / 1000;
    const shown = rows.filter((m) => (!refine.sender || (m.sender_name || '—') === refine.sender)
      && (!refine.date || (m.timestamp && now - m.timestamp < DATE_WINDOWS[refine.date])));
    const filtered = shown.length !== rows.length;
    setSlots(root, {
      'msg-hits': filtered ? `${shown.length}/${rows.length}` : rows.length,
      'msg-ms': lastMs,
      'msg-summary': `${filtered ? `${shown.length} of ${rows.length}` : rows.length} hits · ${lastMs}ms`,
      'msg-refine': refine.group || refine.sender || refine.date ? 'REFINED · CLICK AN ACTIVE CHIP TO CLEAR' : 'CLICK TO REFINE',
    });
    const terms = queryTerms(lastQ);
    const selfName = getStatus()?.persona?.name || 'bot';
    render(results, shown.length
      ? shown.map((m) => html`<div class="logline" style="grid-template-columns:60px 110px 1fr${m.is_from_self ? ';background:rgba(200,16,46,0.04)' : ''}"><span class="lt">${m.timestamp ? fmtHm(m.timestamp) : '—'}</span><span class="mute">${(m.group_jid || '').slice(-12)}</span><span>${m.is_from_self ? html`<b class="red-bright">${selfName}</b>` : html`<b>${m.sender_name || '—'}</b>`}: ${highlight(m.content || `[${m.message_type || 'media'}]`, terms)}</span></div>`)
      : html`<div class="empty">NO HITS</div>`);

    const byGroup = {};
    const bySender = {};
    for (const m of rows) {
      byGroup[m.group_jid || '—'] = (byGroup[m.group_jid || '—'] || 0) + 1;
      bySender[m.sender_name || '—'] = (bySender[m.sender_name || '—'] || 0) + 1;
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8);
    setSlot(root, 'msg-facet-group', chips('group', top(byGroup).filter(([k]) => k !== '—').map(([k, v]) => [k, k.slice(-12), v]), refine.group));
    setSlot(root, 'msg-facet-sender', chips('sender', top(bySender).map(([k, v]) => [k, k, v]), refine.sender));
    const counts = { '24h': 0, '7d': 0, '30d': 0 };
    for (const m of rows) {
      if (!m.timestamp) continue;
      const age = now - m.timestamp;
      for (const [k, sec] of Object.entries(DATE_WINDOWS)) if (age < sec) counts[k]++;
    }
    setSlot(root, 'msg-facet-date', chips('date', Object.entries(counts).map(([k, v]) => [k, k, v]), refine.date));
  }

  async function execute() {
    const q = input.value.trim();
    const mine = ++seq;
    if (q !== lastQ) { refine.sender = null; refine.date = null; }
    if (!q) {
      rows = [];
      lastQ = '';
      refine.group = null;
      render(results, html`<div class="empty">TYPE A SEARCH ABOVE</div>`);
      setSlots(root, { 'msg-hits': '—', 'msg-ms': '—', 'msg-summary': '—', 'msg-refine': 'CLICK TO REFINE' });
      for (const k of ['group', 'sender', 'date']) setSlot(root, `msg-facet-${k}`, html`<span class="mute mono">—</span>`);
      return;
    }
    render(results, html`<div class="loading">SEARCHING</div>`);
    const t0 = performance.now();
    try {
      const groupQs = refine.group ? `&group=${encodeURIComponent(refine.group)}` : '';
      const list = await api(`/api/messages/search?q=${encodeURIComponent(q)}&limit=100${groupQs}`, { signal: ctx.signal });
      if (!ctx.alive() || mine !== seq) return;
      lastMs = (performance.now() - t0).toFixed(1);
      lastQ = q;
      rows = Array.isArray(list) ? list : [];
      paintResults();
    } catch (err) {
      if (isAbort(err) || !ctx.alive() || mine !== seq) return;
      render(results, html`<div class="empty" role="alert" style="color:var(--red-bright)">ERROR · ${err.message}</div>`);
    }
  }

  // Facet chips: group → server re-query; sender/date → filter the loaded hits.
  ctx.listen($(root, '.col-2'), 'click', (e) => {
    const chip = e.target.closest?.('[data-facet]');
    if (!chip) return;
    const facet = chip.dataset.facet;
    const value = chip.dataset.value;
    refine[facet] = refine[facet] === value ? null : value;
    if (facet === 'group') { refine.sender = null; refine.date = null; execute(); } else paintResults();
  });

  const debounce = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; if (ctx.alive()) execute(); }, 300); };
  ctx.onDispose(() => { if (timer) clearTimeout(timer); });
  ctx.listen(input, 'input', debounce);
  ctx.listen(input, 'keydown', (e) => { if (e.key === 'Enter') { if (timer) clearTimeout(timer); execute(); } });
  ctx.listen(runBtn, 'click', execute);
  // "/" focuses the query (as the hint row says), unless already typing somewhere.
  ctx.listen(document, 'keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    input?.focus();
  });
}
