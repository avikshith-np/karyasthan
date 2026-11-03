// CLAIM CHECK (plan 020 E3): what the writers said against the sheets they wrote from. Read-only, a poll every 30 s.
// A shadow measure: read the contradictions here for false alarms, his mixed speech above all, before anyone turns enforce on.
import { api, isAbort } from '../core/api.js';
import { html, render, slotPainter } from '../core/dom.js';
import { fmtInt, fmtRelative, fmtUsd } from '../core/fmt.js';
import { showError } from '../components/ui.js';
import { flash } from '../components/flash.js';
import { alertList, kpi } from '../components/views.js';

const WINDOWS = [7, 30, 90];
const WHO = { 'scene.narrator': 'Scenes', 'phone.his': 'Texts · his', 'phone.cast': 'Texts · theirs', 'journal.narrator': 'Journal' };
const ABOUT = { who: 'WHO', where: 'WHERE', when: 'WHEN', left: 'HOW HE LEFT', money: 'MONEY', plan: 'PLANS' };
const SKIP = {
  no_sheet: 'nothing on the sheet', cap: 'day cap reached', budget: 'budget reached', ledger: 'usage log unreadable', call_failed: 'the call failed',
  junk: 'the answer was unusable', too_long: 'output too long', too_old: 'queued too long', unpriced: 'the clerk model has no price',
};
// The $ cap only works on a priced model: with no price the gate stops the calls, and a local model has no bill.
const pricingWords = (r) => (r.pricing === 'unpriced' ? 'NO PRICE · CLERK CALLS STOPPED'
  : r.pricing === 'local' ? 'LOCAL MODEL · NO $ CAP'
    : r.monthUsd === null ? '—' : `${fmtUsd(r.monthUsd)} / ${fmtUsd(r.budgetUsd)}`);
const MODE = { off: 'OFF', shadow: 'SHADOW · CHANGES NOTHING', enforce: 'ENFORCE · ONE REWRITE' };

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · EVERY OUTPUT AGAINST ITS OWN FACT SHEET</div>
    <h1>Claim check</h1>
  </div>
  <div class="meta">
    <span>MODE <b data-slot="c-mode">—</b></span>
    <span>TODAY <b data-slot="c-today">—</b></span>
    <span>MONTH <b data-slot="c-month">—</b></span>
    <span><label for="cWindow">WINDOW</label> <select id="cWindow">${WINDOWS.map((d) => html`<option value="${d}" ${d === 30 ? 'selected' : ''}>${d} DAYS</option>`)}</select></span>
  </div>
</div>
<div class="kpi-grid" data-slot="c-kpis"></div>
<div class="panel">
  <div class="panel-head"><span>BY VOICE<button type="button" class="guide-q" data-guide="voices" aria-label="Guide: by voice">?</button></span><span class="mono mute" data-slot="c-skips">—</span></div>
  <div class="table-wrap"><table class="data no-cards cc-table">
    <thead><tr><th>VOICE</th><th>OUTPUTS</th><th>READ</th><th>CODE ONLY</th><th>SUPPORTED</th><th>UNKNOWN</th><th>CONTRADICTED</th><th>OF WHICH CODE</th><th>RATE</th></tr></thead>
    <tbody data-slot="c-rows"><tr><td colspan="9" class="loading">LOADING</td></tr></tbody>
  </table></div>
</div>
<div class="panel" style="margin-top:12px">
  <div class="panel-head"><span>LAST CONTRADICTIONS<button type="button" class="guide-q" data-guide="contradictions" aria-label="Guide: last contradictions">?</button></span><span class="mono mute">READ THESE FOR FALSE ALARMS</span></div>
  <div class="panel-body" data-slot="c-last"><span class="loading">LOADING</span></div>
</div>`;

const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export { pricingWords };

export function rowView(r) {
  const verdicts = r.supported + r.contradicted + r.unknown;
  const cell = (label, value, cls = '') => html`<td class="mono ${cls}" data-l="${label}">${value}</td>`;
  return html`<tr>
    <td class="cc-voice"><b>${WHO[`${r.writer}.${r.speaker}`] ?? `${r.writer} · ${r.speaker}`}</b></td>
    ${cell('OUTPUTS', fmtInt(r.runs))}${cell('READ', fmtInt(r.checked))}${cell('CODE ONLY', fmtInt(r.codeOnly), 'mute')}
    ${cell('SUPPORTED', fmtInt(r.supported))}${cell('UNKNOWN', fmtInt(r.unknown), 'mute')}
    ${cell('CONTRADICTED', fmtInt(r.contradicted), r.contradicted > 0 ? 'amber' : '')}${cell('OF WHICH CODE', fmtInt(r.codeContradicted), 'mute')}
    <td class="mono cc-rate" data-l="RATE">${pct(r.contradicted, verdicts)}</td>
  </tr>`;
}

export function contradictionRow(c) {
  const who = WHO[`${c.writer}.${c.speaker}`] ?? c.writer;
  return {
    severity: 'warn',
    title: c.fromChat ? `${who} · from a chat's plan: codes only` : (c.claim ?? 'a claim held back from storage'),
    detail: html`<span class="mono mute">${ABOUT[c.about] ?? c.about} · ${c.source === 'code' ? 'CODE' : 'CLERK'} · ${String(c.reason ?? '').replace(/_/g, ' ')} · ${who}</span>${c.evidence ? html`<br>The sheet says: ${c.evidence}` : ''}${c.excerpt ? html`<br><span class="mute">He wrote: ${c.excerpt}</span>` : ''}`,
    at: fmtRelative(c.at),
    href: c.href ?? null,
  };
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const painter = slotPainter(root);
  const paint = (slots) => Object.entries(slots).forEach(([k, v]) => painter(k, v));
  let days = 30;
  let asked = 0;       // the answer to an older window never paints over a newer one
  let shown = false;   // once there's something on the page, a failed poll leaves it there
  async function load() {
    const mine = ++asked;
    let r;
    try {
      r = await api(`/api/arcs/claim-checks?days=${days}`, { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err) || !ctx.alive() || mine !== asked) return;
      if (!shown) showError(root, err);
      else flash(`CLAIM CHECK: ${err.message}`, 'bad');
      return;
    }
    if (!ctx.alive() || mine !== asked) return;
    shown = true;
    if (!r?.enabled || r.ready === false) {
      paint({ 'c-mode': r?.ready === false ? 'WAITING FOR ITS TABLES' : 'NEEDS THE ARCS SKILL AND LIFE', 'c-rows': html`<tr><td colspan="9" class="empty">NOTHING TO SHOW</td></tr>`, 'c-last': html`<div class="empty">NOTHING TO SHOW</div>` });
      return;
    }
    const rows = Array.isArray(r.rows) ? r.rows : [];
    const skips = Array.isArray(r.skips) ? r.skips : [];
    const contradicted = sum(rows, 'contradicted');
    paint({
      'c-mode': MODE[r.mode] ?? '—',
      'c-today': r.today === null ? 'USAGE LOG UNREADABLE' : `${fmtInt(r.today)} / ${fmtInt(r.maxPerDay)} CALLS`,
      'c-month': pricingWords(r),
      'c-kpis': [
        kpi({ label: 'OUTPUTS', value: fmtInt(sum(rows, 'runs')), sub: `${fmtInt(sum(rows, 'checked'))} read by the clerk${r.pending ? ` · ${fmtInt(r.pending)} queued` : ''}` }),
        kpi({ label: 'SUPPORTED', value: fmtInt(sum(rows, 'supported')), sub: 'a sheet line says so' }),
        kpi({ label: 'UNKNOWN', value: fmtInt(sum(rows, 'unknown')), sub: 'the sheet is silent: normal' }),
        kpi({ label: 'CONTRADICTED', value: fmtInt(contradicted), alert: contradicted > 0, sub: `${fmtInt(sum(rows, 'codeContradicted'))} by code · ${fmtInt(r.rewrites ?? 0)} rewritten` }),
      ],
      'c-skips': skips.length ? skips.map((s) => `${SKIP[s.reason] ?? s.reason}: ${fmtInt(s.n)}`).join(' · ') : 'NO CALLS SKIPPED',
      'c-rows': rows.length ? rows.map(rowView) : html`<tr><td colspan="9" class="empty">NOTHING CHECKED IN THIS WINDOW</td></tr>`,
      'c-last': alertList((Array.isArray(r.last) ? r.last : []).map(contradictionRow), { empty: 'NO CONTRADICTIONS' }),
    });
  }
  ctx.listen(root.querySelector('#cWindow'), 'change', (e) => {
    days = Number(e.target.value) || 30;
    load();
  });
  ctx.setInterval(load, 30_000);
  await load();
}
