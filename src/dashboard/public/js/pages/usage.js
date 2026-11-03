// USAGE — the model-call ledger (spec 007 US2, FR-024): month-to-date spend vs
// budget per role and the global cap, a per-role per-day table (calls, tokens,
// cache, cost, fallbacks, failures), models that ran without a price, and the
// Jev pre-filter's shadow agreement. Live: topic `usage` (the server throttles
// to 1/s; the page debounces its refetch on top of that).
import { api, isAbort } from '../core/api.js';
import { html, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtInt, fmtPct, fmtUsd } from '../core/fmt.js';
import { showError } from '../components/ui.js';

const WINDOWS = [7, 30, 90, 180];
const STATE_PILL = { ok: 'ok', over: 'bad', none: '' };

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · USAGE · EVERY MODEL CALL AND ITS COST</div>
    <h1>Usage</h1>
  </div>
  <div class="meta">
    <span>MONTH <b data-slot="u-month">—</b></span>
    <span>GLOBAL CAP <b data-slot="u-cap">—</b></span>
    <span><label for="uWindow">WINDOW</label> <select id="uWindow">${WINDOWS.map((d) => html`<option value="${d}" ${d === 30 ? 'selected' : ''}>${d} DAYS</option>`)}</select></span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi" data-slot="u-kpi-spend-card"><div class="lab"><span>SPENT · THIS MONTH</span></div><div class="val mono" data-slot="u-kpi-spend">—</div><div class="sub" data-slot="u-kpi-spend-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>CALLS · WINDOW</span></div><div class="val mono" data-slot="u-kpi-calls">—</div><div class="sub" data-slot="u-kpi-calls-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>FELL BACK</span></div><div class="val mono amber" data-slot="u-kpi-fb">—</div><div class="sub">primary failed → fallback answered</div></div>
  <div class="kpi"><div class="lab"><span>FAILED</span></div><div class="val mono red-bright" data-slot="u-kpi-failed">—</div><div class="sub" data-slot="u-kpi-failed-sub">no answer (incl. budget / no key)</div></div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>MONTH TO DATE · PER ROLE<button type="button" class="guide-q" data-guide="budgets" aria-label="Guide: budgets">?</button></span><span class="mono mute">BUDGET 0 = NO ROLE CAP</span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>ROLE / LABEL</th><th>SPENT</th><th>BUDGET</th><th style="width:30%">USE</th><th>STATE</th></tr></thead>
      <tbody data-slot="u-budgets"><tr><td colspan="5" class="loading">LOADING</td></tr></tbody>
    </table></div>
  </div>
  <div>
    <div class="panel" style="margin-bottom:14px">
      <div class="panel-head"><span>JEV PRE-FILTER · SHADOW AGREEMENT<button type="button" class="guide-q" data-guide="prefilter" aria-label="Guide: prefilter">?</button></span><span class="mono mute" data-slot="u-pf-mode">—</span></div>
      <div class="panel-body" data-slot="u-prefilter"><div class="loading">LOADING</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>UNPRICED MODELS · WINDOW<button type="button" class="guide-q" data-guide="unpriced" aria-label="Guide: unpriced">?</button></span><span class="mono mute">TOKENS COUNTED · $0 AGAINST BUDGETS</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>PROVIDER</th><th>MODEL</th><th>CALLS</th></tr></thead>
        <tbody data-slot="u-unpriced"><tr><td colspan="3" class="loading">LOADING</td></tr></tbody>
      </table></div>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <div class="panel-head"><span>PER ROLE · PER DAY<button type="button" class="guide-q" data-guide="days" aria-label="Guide: days">?</button></span><span class="mono mute" data-slot="u-days-count">—</span></div>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>DAY</th><th>ROLE</th><th>CALLS</th><th>IN</th><th>OUT</th><th>CACHE R</th><th>CACHE W</th><th>COST</th><th>FELL BACK</th><th>FAILED</th><th>UNPRICED</th></tr></thead>
    <tbody data-slot="u-days"><tr><td colspan="11" class="loading">LOADING</td></tr></tbody>
  </table></div>
</div>`;

function budgetRow(b) {
  const pct = b.budgetUsd > 0 ? Math.min(100, Math.round((b.spentUsd / b.budgetUsd) * 100)) : 0;
  return html`<tr class="${b.name === 'global' ? 'self' : ''}">
    <td class="mono">${b.name === 'global' ? html`<b>GLOBAL</b>` : b.name}</td>
    <td class="num">${fmtUsd(b.spentUsd || 0)}</td>
    <td class="num">${b.budgetUsd > 0 ? fmtUsd(b.budgetUsd) : html`<span class="mute">—</span>`}</td>
    <td>${b.budgetUsd > 0 ? html`<div class="factor-bar" style="grid-template-columns:1fr 40px;padding:0"><span class="track" role="img" aria-label="${pct}% of budget"><span class="f" style="width:${pct}%;${b.state === 'over' ? '' : 'background:var(--ink-3)'}"></span></span><span class="num">${pct}%</span></div>` : null}</td>
    <td><span class="pill ${STATE_PILL[b.state] ?? ''}">${b.state === 'none' ? 'no cap' : b.state}</span></td>
  </tr>`;
}

function prefilterView(p) {
  if (p.unavailable) return html`<div class="mute mono" style="font-size: var(--t-meta)">▸ NO PRE-FILTER LOG YET (TABLE MISSING — RUN MIGRATIONS)</div>`;
  const ready = p.n >= p.target;
  const verdict = p.recommendEnforce
    ? html`<span class="pill ok">RECOMMEND ENFORCE</span>`
    : ready ? html`<span class="pill warn">NOT YET · THRESHOLDS NOT MET</span>` : html`<span class="pill">COLLECTING ${p.n} / ${p.target}</span>`;
  return html`<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-family:var(--font-mono);font-size: var(--t-meta)">
      <span class="mute">TURNS JUDGED</span><b>${fmtInt(p.n)} <span class="mute">/ ${fmtInt(p.target)}</span></b>
      <span class="mute">SKIP BELOW</span><b>${typeof p.skipBelow === 'number' ? p.skipBelow.toFixed(2) : '—'}</b>
      <span class="mute">LLM SKIPPED</span><b>${fmtInt(p.llmSkips)}</b>
      <span class="mute">CAUGHT BY JEV</span><b>${fmtInt(p.caughtSkips)} <span class="mute">· ${fmtPct(p.catchRate)} (need ≥ 90%)</span></b>
      <span class="mute">LLM REPLIED</span><b>${fmtInt(p.replies)}</b>
      <span class="mute">FALSE SKIPS</span><b class="${(p.falseSkipRate ?? 0) > 0.05 ? 'red-bright' : ''}">${fmtInt(p.falseSkips)} <span class="mute">· ${fmtPct(p.falseSkipRate)} (need ≤ 5%)</span></b>
    </div>
    <div style="margin-top:10px">${verdict}</div>
    <div class="mute" style="font-size: var(--t-meta);margin-top:6px">Shadow mode asks Jev on every eligible group turn and logs what it would have done; nothing is skipped until the mode is switched to enforce (Settings · prefilter.mode) with the jev-prefilter skill on.</div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const sel = $(root, '#uWindow');
  let inflight = null;
  let again = false;

  async function load() {
    const days = Number(sel.value) || 30;
    const opt = { signal: ctx.signal };
    const [usage, budgets, pf] = await Promise.all([
      api(`/api/usage?days=${days}`, opt),
      api('/api/usage/budgets', opt),
      api('/api/usage/prefilter', opt),
    ]);
    if (!ctx.alive()) return;
    const rows = Array.isArray(usage?.days) ? usage.days : [];
    const list = Array.isArray(budgets) ? budgets : [];
    const g = list.find((b) => b.name === 'global');
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);

    setSlots(root, {
      'u-month': g ? fmtUsd(g.spentUsd || 0) : '—',
      'u-cap': g ? (g.budgetUsd > 0 ? fmtUsd(g.budgetUsd) : 'NONE') : '—',
      'u-kpi-spend': g ? fmtUsd(g.spentUsd || 0) : '—',
      'u-kpi-spend-sub': g ? (g.budgetUsd > 0 ? `of ${fmtUsd(g.budgetUsd)} global cap · ${g.state}` : 'no global cap') : '—',
      'u-kpi-calls': fmtInt(sum('calls')),
      'u-kpi-calls-sub': `${usage?.window ?? days} days · ${fmtUsd(sum('costUsd'))} · ${fmtInt(sum('input'))} in / ${fmtInt(sum('output'))} out`,
      'u-kpi-fb': fmtInt(sum('fellBack')),
      'u-kpi-failed': fmtInt(sum('failed')),
      'u-days-count': `${rows.length} ROWS · ${usage?.window ?? days} DAYS`,
      'u-pf-mode': `${pf?.enabled ? 'ON' : 'OFF'} · ${String(pf?.mode || 'shadow').toUpperCase()}`,
    });
    $(root, '[data-slot="u-kpi-spend-card"]')?.classList.toggle('alert', g?.state === 'over');

    // Roles that spent or have a budget first; zero rows after, global last.
    const shown = list.filter((b) => b.name !== 'global')
      .sort((a, b) => (b.spentUsd || 0) - (a.spentUsd || 0) || (b.budgetUsd || 0) - (a.budgetUsd || 0));
    setSlot(root, 'u-budgets', [...shown, ...(g ? [g] : [])].map(budgetRow));

    setSlot(root, 'u-days', rows.length
      ? rows.map((r) => html`<tr>
          <td class="mono">${r.day}</td><td class="mono">${r.role}</td>
          <td class="num">${fmtInt(r.calls)}</td><td class="num">${fmtInt(r.input)}</td><td class="num">${fmtInt(r.output)}</td>
          <td class="num">${fmtInt(r.cacheRead)}</td><td class="num">${fmtInt(r.cacheWrite)}</td>
          <td class="num">${fmtUsd(Number(r.costUsd) || 0)}</td>
          <td class="num ${r.fellBack ? 'amber' : 'mute'}">${fmtInt(r.fellBack || 0)}</td>
          <td class="num ${r.failed ? 'red-bright' : 'mute'}">${fmtInt(r.failed || 0)}</td>
          <td class="num ${r.unpricedCalls ? 'amber' : 'mute'}">${fmtInt(r.unpricedCalls || 0)}</td>
        </tr>`)
      : html`<tr><td colspan="11" class="empty">NO METERED CALLS IN THIS WINDOW</td></tr>`);

    const unpriced = Array.isArray(usage?.unpriced) ? usage.unpriced : [];
    setSlot(root, 'u-unpriced', unpriced.length
      ? unpriced.map((u) => html`<tr><td class="mono">${u.provider}</td><td class="mono">${u.model}</td><td class="num">${fmtInt(u.calls)}</td></tr>`)
      : html`<tr><td colspan="3" class="mute">every model in the window has a price</td></tr>`);

    setSlot(root, 'u-prefilter', prefilterView(pf || {}));
  }

  // One refetch at a time; a request during one queues exactly one more.
  const refresh = () => {
    if (inflight) { again = true; return inflight; }
    inflight = load()
      .catch((err) => { if (!isAbort(err) && ctx.alive()) console.warn('usage refresh', err); })
      .finally(() => { inflight = null; if (again && ctx.alive()) { again = false; refresh(); } });
    return inflight;
  };

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  if (!ctx.alive()) return;

  ctx.listen(sel, 'change', refresh);
  let timer = null;
  ctx.on('usage', () => {
    if (timer) return;
    timer = ctx.setTimeout(() => { timer = null; refresh(); }, 1500);
  });
}
