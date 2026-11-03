// LIFE · WALLET (spec 018 §B) — his money: the balance now, his salary and next
// payday, the month's in / out by category, the month's balance line and the
// log of every money event (salary, rent, bills, groceries, food, outings,
// fares, owner adjustments). Read from GET /api/life/wallet (the facade's
// walletView); #life/wallet/<YYYY-MM> opens another month. The operator view:
// chat-made spends are listed too, marked ◇. REVERT goes through the normal
// life revert route (readonly + CSRF, audited) and shows only where the
// facade says the event is revertible. Amounts are plain grouped numbers (no
// currency is assumed here). Polls every 30 s; text reaches the DOM through html``.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlot, setSlots, $ } from '../core/dom.js';
import { fmtWhen, fmtDay } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { showError } from '../components/ui.js';
import { readOnly, offNote } from './life-now.js';

const POLL_MS = 30_000;
const REASON_MAX = 200;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// The closed categories of §B, in the order the bars show them.
export const CATEGORIES = {
  salary: 'Salary', income: 'Income', rent: 'Rent', bills: 'Bills', groceries: 'Groceries', food: 'Food',
  outing: 'Outings', travel: 'Travel', setback: 'Setback', adjustment: 'Adjustment', other: 'Other',
};
export const catLabel = (c) => CATEGORIES[c] || 'Other';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** A grouped number with at most two decimals; '—' when unknown. */
export const money = (v) => (finite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—');
/** Signed amount for a log row: + for money in, − for money out. */
export const signedAmount = (e) => `${e?.dir === 'in' ? '+' : '−'}${money(Math.abs(Number(e?.amount)))}`;

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · WALLET · WHAT HE EARNS AND SPENDS</div>
    <h1>Wallet</h1>
  </div>
  <div class="meta">
    <span>MONTH <b data-slot="lw-month">—</b></span>
    <span>BALANCE <b data-slot="lw-balance">—</b></span>
  </div>
</div>
<div data-slot="lw-off"></div>
<div class="panel">
  <div class="panel-head"><span>THIS MONTH<button type="button" class="guide-q" data-guide="month" aria-label="Guide: month">?</button></span>
    <span class="lw-months" data-slot="lw-picker"></span></div>
  <div class="panel-body" data-slot="lw-summary"><div class="loading">LOADING</div></div>
</div>
<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>BY CATEGORY<button type="button" class="guide-q" data-guide="categories" aria-label="Guide: categories">?</button></span></div>
    <div class="panel-body" data-slot="lw-cats"></div>
  </div>
  <div class="panel">
    <div class="panel-head"><span>BALANCE<button type="button" class="guide-q" data-guide="balance" aria-label="Guide: balance">?</button></span><span class="mono mute">END OF EACH DAY</span></div>
    <div class="panel-body lw-line" data-slot="lw-line"></div>
  </div>
</div>
<div class="panel">
  <div class="panel-head"><span>THE LOG<button type="button" class="guide-q" data-guide="log" aria-label="Guide: log">?</button></span><span class="mono mute" data-slot="lw-count"></span></div>
  <div class="table-wrap" data-slot="lw-log"></div>
</div>`);

/** cast id → fictional name, from /api/arcs/cast (best effort). */
export function castNames(cast) {
  const m = new Map();
  for (const c of Array.isArray(cast) ? cast : []) if (c && typeof c.id === 'string' && typeof c.name === 'string') m.set(c.id, c.name);
  return m;
}

/** A name for a cast id: the cast list's, else the id's own words ("cast:wren-vale" → "wren vale"). */
export function nameOf(id, names) {
  if (names?.has?.(id)) return names.get(id);
  return String(id || '').replace(/^cast:/, '').replace(/[-_]+/g, ' ').trim() || '?';
}

export function summaryView(w) {
  const t = w?.totals || {};
  const s = w?.salary;
  const now = Date.now() / 1000;
  const days = s && finite(s.nextAt) ? Math.max(0, Math.ceil((s.nextAt - now) / 86400)) : null;
  return html`<div class="lw-stats">
    <div class="lw-stat"><span class="label">BALANCE NOW</span><b class="${finite(w?.balance) && w.balance < 0 ? 'red' : ''}">${money(w?.balance)}</b></div>
    <div class="lw-stat"><span class="label">IN</span><b class="green">+${money(t.in ?? 0)}</b></div>
    <div class="lw-stat"><span class="label">OUT</span><b class="red">−${money(t.out ?? 0)}</b></div>
    <div class="lw-stat"><span class="label">NET</span><b class="${finite(t.net) && t.net < 0 ? 'red' : 'green'}">${finite(t.net) ? `${t.net < 0 ? '−' : '+'}${money(Math.abs(t.net))}` : '—'}</b></div>
  </div>
  <div class="mono lw-salary">${s && finite(s.amount)
    ? html`SALARY <b>${money(s.amount)}</b> on day ${s.payday ?? '—'} of the month · next ${finite(s.nextAt) ? html`<b>${fmtDay(s.nextAt)}</b>${days !== null ? ` (in ${days} day${days === 1 ? '' : 's'})` : ''}` : '—'}${finite(s.lastAt) ? html` · last ${fmtDay(s.lastAt)}` : html` · <span class="mute">not paid yet</span>`}`
    : html`<span class="mute">NO SALARY (no job or no pay set)</span>`}
    ${finite(w?.baseline) && w.baseline > 0 ? html`<span class="mute"> · usual month's spending ${money(w.baseline)}</span>` : ''}</div>`;
}

export function categoryBars(w) {
  const by = w?.totals?.byCategory && typeof w.totals.byCategory === 'object' ? w.totals.byCategory : {};
  const rows = Object.entries(by).filter(([, v]) => finite(v) && v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!rows.length) return html`<div class="empty">NOTHING THIS MONTH</div>`;
  const max = Math.max(...rows.map(([, v]) => Math.abs(v)));
  const incoming = new Set(['salary', 'income']);
  return html`${rows.map(([c, v]) => html`<div class="factor-bar"><span class="label">${catLabel(c).toUpperCase()}</span>
    <span class="track"><span class="f ${incoming.has(c) ? 'lw-in' : 'lw-out'}" style="width:${Math.max(2, Math.round((Math.abs(v) / max) * 100))}%"></span></span>
    <span class="num">${money(v)}</span></div>`)}`;
}

const LW = 600;
const LH = 120;
/** The month's end-of-day balance as an inline SVG polyline (zero line when it dips below 0). */
export function balanceLine(w) {
  const pts = (Array.isArray(w?.daily) ? w.daily : []).filter((d) => finite(d?.balance));
  if (!pts.length) return html`<div class="empty">NO DAYS YET</div>`;
  const vals = pts.map((d) => d.balance);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(...vals, lo + 1);
  const x = (i) => (pts.length === 1 ? LW / 2 : (i / (pts.length - 1)) * LW);
  const y = (v) => LH - 4 - ((v - lo) / (hi - lo)) * (LH - 8);
  const line = pts.map((d, i) => `${x(i).toFixed(1)},${y(d.balance).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return html`<svg viewBox="0 0 ${LW} ${LH}" preserveAspectRatio="none" role="img" aria-label="His balance at the end of each day of the month">
      ${lo < 0 ? html`<line class="lw-zero" x1="0" x2="${LW}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>` : ''}
      <polyline class="lw-bal" points="${line}"></polyline>
    </svg>
    <div class="mono mute lw-axis"><span>${pts[0].date}</span><span>low ${money(Math.min(...vals))} · high ${money(Math.max(...vals))}</span><span>${last.date} · ${money(last.balance)}</span></div>`;
}

function originChip(e) {
  if (e.fromChat || e.origin === 'chat') return html`<span class="chip warn" title="caused by a chat (an outing from a chat)">◇ CHAT</span>`;
  if (e.origin === 'owner' || e.actor === 'owner') return html`<span class="chip">OWNER</span>`;
  return '';
}

export function entryRow(e, names, ro) {
  const ids = Array.isArray(e.castIds) ? e.castIds : [];
  const given = Array.isArray(e.castNames) ? e.castNames : [];
  const withWhom = ids.map((id, i) => (typeof given[i] === 'string' && given[i]) || nameOf(id, names)).join(', ');
  return html`<tr data-ev="${e.id}">
    <td class="mono">${fmtWhen(e.at)}</td>
    <td>${e.label || catLabel(e.category)} <span class="chip">${catLabel(e.category).toUpperCase()}</span> ${originChip(e)}</td>
    <td>${e.placeName || html`<span class="mute">—</span>`}</td>
    <td>${withWhom || html`<span class="mute">—</span>`}</td>
    <td class="mono lw-amt ${e.dir === 'in' ? 'green' : 'red'}">${signedAmount(e)}</td>
    <td>${e.revertible ? html`<button type="button" class="danger lw-revert" data-id="${e.id}" ${ro ? raw('disabled title="Dashboard is read-only (DASHBOARD_READONLY=true)"') : ''}>REVERT</button>` : ''}</td>
  </tr>`;
}

export function logView(w, names, ro) {
  const rows = Array.isArray(w?.entries) ? w.entries : [];
  if (!rows.length) return html`<div class="empty">NO MONEY MOVED THIS MONTH</div>`;
  return html`<table class="data no-cards lw-table"><thead><tr><th>WHEN</th><th>WHAT</th><th>WHERE</th><th>WITH</th><th>AMOUNT</th><th></th></tr></thead>
    <tbody>${rows.map((e) => entryRow(e, names, ro))}</tbody></table>`;
}

/** Month links: the months that have entries (newest first), plus the shown one. */
export function monthPicker(w) {
  const months = [...new Set([w?.month, ...(Array.isArray(w?.months) ? w.months : [])].filter((m) => MONTH_RE.test(String(m || ''))))]
    .sort().reverse().slice(0, 24);
  if (months.length < 2) return '';
  return html`<select class="lw-pick" aria-label="Month">${months.map((m) => html`<option value="${m}" ${m === w.month ? raw('selected') : ''}>${m}</option>`)}</select>`;
}

export async function mount(ctx, monthParam) {
  const root = ctx.root;
  render(root, SHELL);
  const month = MONTH_RE.test(String(monthParam || '')) ? monthParam : null;
  let names = new Map();
  let namesAt = 0;
  let painted = '';   // a poll with nothing new touches nothing, so an open month picker stays open

  async function load() {
    const w = await api(`/api/life/wallet${month ? `?month=${encodeURIComponent(month)}` : ''}`, { signal: ctx.signal });
    if (!ctx.alive()) return;
    if (Date.now() - namesAt > 5 * 60_000) {
      const cast = await api('/api/arcs/cast', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return null; });
      if (!ctx.alive()) return;
      if (cast) { names = castNames(cast.cast); namesAt = Date.now(); }
    }
    const ro = readOnly();
    if (!w?.running) {
      setSlot(root, 'lw-off', offNote(w?.skill));
      setSlots(root, { 'lw-month': month || '—', 'lw-balance': '—', 'lw-count': '' });
      for (const k of ['lw-summary', 'lw-cats', 'lw-line', 'lw-log']) setSlot(root, k, html`<div class="empty">LIFE IS NOT RUNNING</div>`);
      setSlot(root, 'lw-picker', '');
      return;
    }
    const sig = JSON.stringify([w, ro, names.size]);
    if (sig === painted) return;
    painted = sig;
    setSlot(root, 'lw-off', '');
    setSlots(root, {
      'lw-month': w.month || '—',
      'lw-balance': money(w.balance),
      'lw-count': `${(w.entries || []).length} ENTR${(w.entries || []).length === 1 ? 'Y' : 'IES'}`,
    });
    setSlot(root, 'lw-picker', monthPicker(w));
    setSlot(root, 'lw-summary', summaryView(w));
    setSlot(root, 'lw-cats', categoryBars(w));
    setSlot(root, 'lw-line', balanceLine(w));
    setSlot(root, 'lw-log', logView(w, names, ro));
  }

  ctx.listen(root, 'change', (e) => {
    const sel = e.target.closest?.('.lw-pick');
    if (sel && MONTH_RE.test(sel.value)) location.hash = `#life/wallet/${sel.value}`;
  });
  ctx.listen(root, 'click', async (e) => {
    const btn = e.target.closest?.('.lw-revert');
    if (!btn || btn.disabled || readOnly()) return;
    const id = btn.dataset.id;
    const { ok, reason } = await askSheet({ label: `Revert money event #${id}`, text: 'Anything it caused goes too.', action: 'REVERT', danger: true, reasonLabel: 'Reason (optional)', reasonMax: REASON_MAX });
    if (!ok || !ctx.alive()) return;
    btn.disabled = true;
    try {
      const r = await api(`/api/life/events/${encodeURIComponent(id)}/revert`, { method: 'POST', body: { reason } });
      flash(r?.already ? `#${id} WAS ALREADY REVERTED` : `#${id} REVERTED`);
    } catch (err) {
      if (isAbort(err)) return;
      flash(err.message, 'bad');
    }
    if (ctx.alive()) load().catch(() => {});
  });

  try {
    await load();
  } catch (err) {
    if (isAbort(err) || !ctx.alive()) return;
    if (err?.status === 409) setSlot(root, 'lw-summary', html`<div class="empty">THE WALLET IS NOT AVAILABLE IN THIS BUILD YET</div>`);
    else showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life wallet poll', err); }); }, POLL_MS);
}
