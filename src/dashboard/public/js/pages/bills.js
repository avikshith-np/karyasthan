// 07 BILLS — group expense ledger with a per-bill focus panel. The one write is
// EXPIRE on an open bill (POST /api/bills/:id/expire: readonly + CSRF + audit).
//
// States (billStore.js): PARSED (read, not started) and ACTIVE (splitting) are open;
// COMPLETED is done; CANCELLED and EXPIRED are void. Amounts are shown without a
// currency symbol unless the bill itself names one (bill.currency).
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtRelative } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { getStatus } from '../components/topbar.js';
import { showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · BILLS · RECEIPTS HE SPLIT IN GROUPS</div>
    <h1>Bills</h1>
  </div>
  <div class="meta">
    <span>OPEN <b class="amber" data-slot="bills-open">—</b></span>
    <span>COMPLETED <b data-slot="bills-completed">—</b></span>
    <span>VOID <b class="red" data-slot="bills-void">—</b></span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>OUTSTANDING</span></div><div class="val mono" data-slot="bills-kpi-outstanding">—</div><div class="sub" data-slot="bills-kpi-outstanding-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>TOTAL · ALL</span></div><div class="val mono" data-slot="bills-kpi-total">—</div><div class="sub" data-slot="bills-kpi-total-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>AVG PARTICIPANTS</span></div><div class="val mono" data-slot="bills-kpi-avgp">—</div><div class="sub">per bill</div></div>
  <div class="kpi alert"><div class="lab"><span>STALE &gt; 7D</span></div><div class="val mono red-bright" data-slot="bills-kpi-stale">—</div><div class="sub">open · untouched 7 days</div></div>
</div>

<div class="col-2" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>BILLS<button type="button" class="guide-q" data-guide="ledger" aria-label="Guide: bills">?</button></span><span class="mono mute" data-slot="bills-count">—</span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>#</th><th>RESTAURANT</th><th>STATE</th><th>GROUP</th><th>P</th><th>UPDATED</th></tr></thead>
      <tbody data-slot="bills-rows"><tr><td colspan="6" class="loading">LOADING</td></tr></tbody>
    </table></div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>THE BILL<button type="button" class="guide-q" data-guide="focus" aria-label="Guide: the bill">?</button></span><span class="mono mute" data-slot="bills-focus-id">—</span></div>
    <div class="panel-body" data-slot="bills-focus"><span class="mute mono">SELECT A BILL</span></div>
  </div>
</div>
`);

const OPEN = new Set(['ACTIVE', 'PARSED']);
const VOID = new Set(['CANCELLED', 'EXPIRED']);
const stateClass = (s) => (s === 'COMPLETED' ? 'ok' : OPEN.has(s) ? 'warn' : 'bad');
// A currency prefix only when the bill carries one (the receipt parser stores none today).
const curOf = (b) => (typeof b?.bill?.currency === 'string' && b.bill.currency.trim() ? `${b.bill.currency.trim().slice(0, 4)} ` : '');
const fmtTotal = (n, cur = '') => `${cur}${Math.round(n).toLocaleString()}`;

function focusView(b) {
  const cur = curOf(b);
  const rupees = (paisa) => `${cur}${(Number(paisa || 0) / 100).toFixed(2)}`;
  const items = b.bill?.items || [];
  const sub = [];
  if (b.bill?.subtotalPaisa) sub.push(html`<tr><td></td><td class="mute">SUBTOTAL</td><td class="num">${rupees(b.bill.subtotalPaisa)}</td></tr>`);
  if (b.bill?.taxPaisa) sub.push(html`<tr><td></td><td class="mute">TAX</td><td class="num">${rupees(b.bill.taxPaisa)}</td></tr>`);
  if (b.bill?.serviceChargePaisa) sub.push(html`<tr><td></td><td class="mute">SERVICE</td><td class="num">${rupees(b.bill.serviceChargePaisa)}</td></tr>`);
  if (b.bill?.discountPaisa) sub.push(html`<tr><td></td><td class="mute">DISCOUNT</td><td class="num">−${rupees(b.bill.discountPaisa)}</td></tr>`);
  if (b.bill?.totalPaisa) sub.push(html`<tr><td></td><td><b>TOTAL</b></td><td class="num"><b>${rupees(b.bill.totalPaisa)}</b></td></tr>`);

  // Per-person split: each assignment divides its item's total by its people.
  const perPerson = {};
  for (const p of b.people || []) perPerson[p] = 0;
  for (const a of b.assignments || []) {
    const it = items[a.itemIndex];
    if (!it || !a.people?.length) continue;
    const share = Number(it.totalPricePaisa || 0) / a.people.length;
    for (const p of a.people) perPerson[p] = (perPerson[p] || 0) + share;
  }
  const done = b.state === 'COMPLETED';
  const split = Object.entries(perPerson).sort((x, y) => y[1] - x[1]);
  const ro = getStatus()?.readOnly !== false;
  return html`
    <div class="cap mute" style="font-size: var(--t-label);display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${b.restaurant || '—'} · ${b.state}</span>${OPEN.has(b.state)
      ? html`<button type="button" class="danger" data-bill-expire="${b.id}" ${ro ? raw('disabled title="Dashboard is read-only"') : raw('title="Mark this open bill EXPIRED so it stops catching messages"')} style="padding:3px 8px;font-size: var(--t-micro)">EXPIRE</button>`
      : null}</div>
    <div class="table-wrap"><table class="data" style="margin-top:6px"><tbody>
      ${items.length ? items.map((it) => html`<tr><td class="id">×${it.qty || 1}</td><td>${it.name || '—'}</td><td class="num">${rupees(it.totalPricePaisa)}</td></tr>`)
        : html`<tr><td colspan="3" class="mute">NO LINE ITEMS</td></tr>`}
      ${sub}
    </tbody></table></div>
    <div class="divider" style="margin:14px 0"></div>
    <div class="cap mute" style="font-size: var(--t-label)">SPLIT · ${(b.people || []).length}-WAY</div>
    <div class="table-wrap"><table class="data" style="margin-top:6px"><tbody>
      ${split.length ? split.map(([name, paisa]) => html`<tr><td>${name}</td><td class="num">${rupees(paisa)}</td><td><span class="pill ${done ? 'ok' : 'warn'}">${done ? 'SETTLED' : 'PENDING'}</span></td></tr>`)
        : html`<tr><td colspan="3" class="mute">NO ASSIGNMENTS</td></tr>`}
    </tbody></table></div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const tbody = $(root, '[data-slot="bills-rows"]');
  let rows = [];
  let focusedId = null;

  const showFocus = (b) => {
    focusedId = b.id;
    setSlots(root, { 'bills-focus-id': `#${b.id} · ${b.state}` });
    setSlot(root, 'bills-focus', focusView(b));
  };

  async function load() {
    let list;
    try {
      list = await api('/api/bills?limit=100', { signal: ctx.signal });
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) showError(root, err);
      return;
    }
    if (!ctx.alive()) return;
    rows = Array.isArray(list) ? list : [];

    const open = rows.filter((b) => OPEN.has(b.state));
    const completed = rows.filter((b) => b.state === 'COMPLETED').length;
    const voided = rows.filter((b) => VOID.has(b.state)).length;
    const now = Math.floor(Date.now() / 1000);
    const stale = open.filter((b) => (now - (b.updatedAt || b.createdAt || 0)) > 7 * 86400).length;
    const billAmount = (b) => Number(b.bill?.totalPaisa || 0) / 100;
    const total = rows.reduce((acc, b) => acc + billAmount(b), 0);
    const outstanding = open.reduce((acc, b) => acc + billAmount(b), 0);
    // One currency across the listed bills → show it on the totals; mixed/none → no symbol.
    const curs = new Set(rows.map(curOf));
    const cur = curs.size === 1 ? [...curs][0] : '';
    setSlots(root, {
      'bills-open': open.length,
      'bills-completed': completed,
      'bills-void': voided,
      'bills-count': `${rows.length} BILLS`,
      'bills-kpi-outstanding': outstanding ? fmtTotal(outstanding, cur) : '—',
      'bills-kpi-outstanding-sub': `${open.length} open bills`,
      'bills-kpi-total': total ? fmtTotal(total, cur) : '—',
      'bills-kpi-total-sub': `${rows.length} bills · ${completed} done`,
      'bills-kpi-avgp': rows.length ? Math.round(rows.reduce((a, b) => a + (b.people?.length || 0), 0) / rows.length) : '—',
      'bills-kpi-stale': stale,
    });

    render(tbody, rows.length
      ? rows.map((b) => html`<tr data-bill-id="${b.id}" tabindex="0" style="cursor:pointer">
          <td class="id">#${b.id}</td>
          <td><b>${b.restaurant || '—'}</b></td>
          <td><span class="pill ${stateClass(b.state)}">${b.state}</span></td>
          <td class="id">${(b.groupJid || '').slice(-12)}</td>
          <td class="num">${(b.people || []).length || (b.participantJids || []).length || 0}</td>
          <td class="mono mute">${fmtRelative(b.updatedAt || b.createdAt)}</td>
        </tr>`)
      : html`<tr><td colspan="6" class="empty">NO BILLS</td></tr>`);

    const keep = rows.find((x) => x.id === focusedId) || rows[0];
    if (keep) showFocus(keep);
  }

  const pick = (e) => {
    const tr = e.target.closest?.('tr[data-bill-id]');
    if (!tr) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    if (e.type === 'keydown') e.preventDefault();
    const b = rows.find((x) => String(x.id) === tr.dataset.billId);
    if (b) showFocus(b);
  };
  ctx.listen(tbody, 'click', pick);
  ctx.listen(tbody, 'keydown', pick);

  ctx.listen($(root, '[data-slot="bills-focus"]'), 'click', async (e) => {
    const btn = e.target.closest?.('[data-bill-expire]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.billExpire;
    if (!(await askSheet({ label: `Expire bill #${id}`, text: 'It stops catching messages in that chat.', action: 'EXPIRE', danger: true })).ok || !ctx.alive()) return;
    btn.disabled = true;
    try {
      await api(`/api/bills/${encodeURIComponent(id)}/expire`, { method: 'POST', body: {} });
      flash(`BILL #${id} EXPIRED`);
      if (ctx.alive()) await load();
    } catch (err) {
      flash(err.message, 'bad');
      if (ctx.alive()) btn.disabled = false;
    }
  });

  await load();
}
