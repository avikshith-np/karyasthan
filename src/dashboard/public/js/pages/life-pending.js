// LIFE · PENDING (spec 010 T022, director-api §2, §7) — the Ask-me cards: big
// and guided decisions wait for the owner. Each card shows the question, the
// options with their costs (an expired option is greyed), a countdown to the
// deadline (ticking client-side every second at the life clock), the current
// lean with a sparkline of its history, and how a closed card ended. Silence
// commits the lean at the deadline. Heavy-arc veto cards sit on top.
//
// A pick or a veto is one owner event with a fixed effect, so there is no
// preview (FR-041 exception): POST /api/arcs/cards/:id/pick | heavy/:id/veto.
// Polls /api/arcs/cards every 15 s. Card text is code-built from the kind and
// option labels; it still only reaches the DOM through html`` (escaped).
import { api, isAbort } from '../core/api.js';
import { html, render, slotPainter, setSlots, $ } from '../core/dom.js';
import { fmtTime, fmtHm } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { showError } from '../components/ui.js';
import { askSheet } from '../components/sheet.js';
import { readOnly } from './life-now.js';
import { arcsStatus, arcsOffNote, countdownText, tickCountdowns, sparkline, upper, fx, finite } from './life-cast.js';

const POLL_MS = 15_000;

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · PENDING · DECISIONS THAT ASK YOU FIRST</div>
    <h1>Pending</h1>
  </div>
  <div class="meta">
    <span>OPEN <b class="amber" data-slot="lp-open">—</b></span>
    <span>VETO <b class="red" data-slot="lp-veto">—</b></span>
    <label class="mono"><input type="checkbox" id="lpClosed"> SHOW CLOSED</label>
  </div>
</div>
<div data-slot="lp-off"></div>
<div data-slot="lp-ro"></div>
<div class="story-cards" data-slot="lp-heavy"></div>
<div class="story-cards" data-slot="lp-cards"><div class="loading">LOADING</div></div>
<div data-slot="lp-closed"></div>
<div data-slot="lp-invites"></div>`;

const COSTS = ['energy', 'money', 'social', 'stress', 'travelMin'];

function costLine(c) {
  if (!c || typeof c !== 'object') return null;
  const parts = COSTS.filter((k) => finite(c[k]) && c[k] !== 0).map((k) => `${k === 'travelMin' ? 'travel' : k} ${c[k] > 0 && k !== 'travelMin' ? '+' : ''}${Math.round(c[k] * 100) / 100}`);
  return parts.length ? html`<div class="mono mute story-cost">${parts.join(' · ')}</div>` : null;
}

function leanLine(card) {
  const l = card.lean;
  if (!l) return html`<span class="mute">no lean yet</span>`;
  const label = (card.options || []).find((o) => o.id === l.optionId)?.label ?? l.optionId;
  return html`leans <b>${label}</b> <span class="mono">p ${fx(l.p)}</span> <span class="chip">${upper(l.by)}</span>${l.fallback ? html` <span class="chip warn" title="the lean came from the code fallback">FALLBACK · ${upper(l.fallback)}</span>` : ''}`;
}

function outcomeLine(card) {
  const o = card.outcome;
  if (!o) return null;
  const label = (card.options || []).find((x) => x.id === o.optionId)?.label ?? o.optionId;
  const how = { owner: 'you picked', lean: 'silence → the lean', sample: 'sampled', early: 'committed early', adopted: 'adopted from a chat', reply: 'his answer in a chat' }[o.by] || o.by;
  return html`<div class="story-outcome"><b class="green">${label}</b> <span class="mute">· ${how} · ${fmtTime(o.at)}</span></div>`;
}

// 013: the public site's audience votes on this card — a suggestion, never applied.
function audienceLine(card) {
  const a = card.audience;
  if (!a || !(a.total > 0)) return '';
  const label = (id) => (card.options || []).find((o) => o.id === id)?.label || id;
  return html`<div class="mono story-audience">AUDIENCE · ${a.options.map((o, i) => html`${i ? ' · ' : ''}${label(o.optionId)} ${Math.round(o.share * 100)}%`)} <span class="mute">(${a.total} vote${a.total === 1 ? '' : 's'} · a suggestion only)</span></div>`;
}

function decisionCard(card, ro, offset) {
  const open = card.status === 'open';
  const history = (card.leanHistory || []).map((p) => p.p);
  return html`<div class="panel story-card ${open ? 'is-open' : 'is-closed'}" data-card="${card.id}">
    <div class="panel-head"><span>${upper(card.category)} · ${upper(card.kind)}${card.big ? html` <span class="chip warn">BIG</span>` : ''}${card.guided ? html` <span class="chip">GUIDED</span>` : ''}${card.bigDowngraded ? html` <span class="chip" title="not enough lead time for a card">DOWNGRADED · ${upper(card.bigDowngraded)}</span>` : ''}</span>
      <span class="chip ${open ? 'warn' : card.status === 'committed' ? 'ok' : ''}">${upper(card.status)}</span></div>
    <div class="panel-body">
      <p class="story-question">${card.question}</p>
      ${open ? html`<div class="mono story-deadline">DECIDE BY ${fmtHm(card.decideBy)} · <b data-countdown="${card.decideBy}">${countdownText(card.decideBy, offset)}</b>${card.ponrAt ? html` · no return after ${fmtHm(card.ponrAt)}` : ''}</div>` : ''}
      <div class="story-lean">${leanLine(card)} ${history?.length ? sparkline(history, { label: `lean history of decision ${card.id}` }) : ''}</div>
      ${outcomeLine(card)}
      ${audienceLine(card)}
      <div class="story-options">${(card.options || []).map((o) => {
        const off = ro || !open || o.expired;
        const leading = card.lean?.optionId === o.id;
        return html`<button type="button" class="story-option lp-pick ${o.expired ? 'is-expired' : ''} ${leading ? 'is-leading' : ''}" data-id="${card.id}" data-option="${o.id}" ${off ? 'disabled' : ''} aria-label="Pick ${o.label}">
          <span class="story-option-label">${o.label}</span>${costLine(o.cost)}
          ${o.expired ? html`<span class="mono mute">EXPIRED</span>` : o.expiresAt ? html`<span class="mono mute">until ${fmtHm(o.expiresAt)} · <span data-countdown="${o.expiresAt}">${countdownText(o.expiresAt, offset)}</span></span>` : ''}
        </button>`;
      })}</div>
    </div>
  </div>`;
}

// 012: invitations from chats (GET /api/influence/invites; read-only here — an
// "Ask me" one is also a card above, and any of them reverts on the Timeline).
const ANSWER_WORD = { yes: 'said yes', late: 'will come later', no: 'said no', maybe: 'said maybe' };
const OPTION_WORD = { go: 'going', late: 'going late', stay: 'staying in' };

function inviteRow(i) {
  const state = i.decisionStatus === 'open' ? (i.answer ? 'OPEN · LEANING' : 'WAITING FOR HIS ANSWER')
    : i.decisionStatus === 'committed' ? `COMMITTED · ${upper(OPTION_WORD[i.committed] || i.committed || '')}` : upper(i.decisionStatus || i.status || '');
  const fu = i.followUp ? (i.followUp.sent ? 'follow-up sent' : 'follow-up skipped')
    : i.followupStatus ? `follow-up ${i.followupStatus}` : '';
  return html`<tr>
    <td class="mono">${fmtTime(i.createdAt)}</td>
    <td>${i.chatName || (i.originKind === 'dm' ? 'a DM' : 'a group')}</td>
    <td>${i.label || '—'}${i.eventAt ? html` <span class="mono mute">at ${fmtHm(i.eventAt)}</span>` : ''}${i.mode === 'ask' ? html` <span class="chip">ASK ME</span>` : ''}</td>
    <td>${i.answer ? ANSWER_WORD[i.answer] || i.answer : html`<span class="mute">—</span>`}</td>
    <td><span class="chip ${i.decisionStatus === 'open' ? 'warn' : i.decisionStatus === 'committed' ? 'ok' : ''}">${state}</span>${i.lean && i.decisionStatus === 'open' ? html` <span class="mono mute">leans ${OPTION_WORD[i.lean.optionId] || i.lean.optionId} p ${fx(i.lean.p)}</span>` : ''}</td>
    <td class="mono mute">${fu}</td>
    <td>${i.decisionId ? html`<a href="#life/timeline" class="mono">#${i.decisionId}</a>` : ''}</td>
  </tr>`;
}

function invitesPanel(res) {
  const list = Array.isArray(res?.invites) ? res.invites : [];
  if (!res?.running && !list.length) return null;
  return html`<div class="story-sub mono">INVITATIONS FROM CHATS</div>
  <div class="panel"><div class="panel-body">${list.length ? html`<table class="table"><thead><tr>
    <th>HEARD</th><th>CHAT</th><th>INVITATION</th><th>HIS ANSWER</th><th>STATE</th><th>FOLLOW-UP</th><th>DECISION</th>
  </tr></thead><tbody>${list.map(inviteRow)}</tbody></table>` : html`<div class="empty">NO INVITATIONS FROM CHATS YET</div>`}</div></div>`;
}

function vetoCard(card, ro, offset) {
  const h = card.heavy || {};
  const proposedId = String(card.id || '').replace(/^heavy:/, '');
  const pending = h.status === 'pending';
  return html`<div class="panel story-card story-veto ${pending ? 'is-open' : 'is-closed'}">
    <div class="panel-head"><span>HEAVY · ${upper(h.kind)}</span><span class="chip ${pending ? 'bad' : ''}">${upper(h.status)}</span></div>
    <div class="panel-body">
      <p class="story-question">${card.question || h.themeLabel || ''}</p>
      ${h.themeLabel ? html`<div class="mono mute">${h.themeLabel}</div>` : ''}
      <div class="mono story-deadline">ONSET ${fmtTime(h.onsetAt)}${pending ? html` · <b data-countdown="${h.onsetAt}">${countdownText(h.onsetAt, offset)}</b>` : ''}</div>
      <p class="mute">Something hard is due to happen in his life. Veto it and it never happens; do nothing and it starts at the onset.</p>
      <button type="button" class="danger lp-veto" data-id="${proposedId}" ${ro || !pending ? 'disabled' : ''}>VETO</button>
    </div>
  </div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const paintSlot = slotPainter(root);
  const setSlot = (_, key, tpl) => paintSlot(key, tpl);
  let offset = 0;

  async function load() {
    const st = await arcsStatus(ctx);
    if (!ctx.alive()) return;
    const showClosed = !!$(root, '#lpClosed')?.checked;
    const res = await api(`/api/arcs/cards${showClosed ? '?closed=1' : ''}`, { signal: ctx.signal });
    if (!ctx.alive()) return;
    const cards = Array.isArray(res?.cards) ? res.cards : [];
    const withNow = cards.find((c) => finite(c.now));
    offset = withNow ? withNow.now - Date.now() / 1000 : 0;
    const ro = readOnly();
    setSlot(root, 'lp-off', arcsOffNote(st));
    setSlot(root, 'lp-ro', ro ? html`<div class="panel life-off"><div class="panel-body"><b class="amber">READ-ONLY</b> <span class="mute">picks and vetoes need DASHBOARD_READONLY=false.</span></div></div>` : null);
    const veto = cards.filter((c) => c.type === 'heavy_veto');
    const dec = cards.filter((c) => c.type !== 'heavy_veto');
    const open = dec.filter((c) => c.status === 'open');
    const closed = dec.filter((c) => c.status !== 'open');
    setSlots(root, { 'lp-open': open.length, 'lp-veto': veto.filter((c) => c.heavy?.status === 'pending').length });
    setSlot(root, 'lp-heavy', veto.map((c) => vetoCard(c, ro, offset)));
    setSlot(root, 'lp-cards', open.length ? open.map((c) => decisionCard(c, ro, offset))
      : html`<div class="panel"><div class="empty">${res?.enabled ? 'NOTHING IS WAITING FOR YOU' : 'ARCS IS OFF'}</div></div>`);
    setSlot(root, 'lp-closed', showClosed && closed.length
      ? html`<div class="story-sub mono">CLOSED</div><div class="story-cards">${closed.map((c) => decisionCard(c, ro, offset))}</div>` : null);
    // 012: invitations from chats (works with arcs off; empty while chat influence never ran).
    let inv = null;
    try { inv = await api('/api/influence/invites', { signal: ctx.signal }); } catch (err) { if (isAbort(err)) throw err; inv = null; }
    if (!ctx.alive()) return;
    setSlot(root, 'lp-invites', invitesPanel(inv));
  }

  async function post(path, body, okMsg, btn) {
    btn.disabled = true;
    try {
      await api(path, { method: 'POST', body });
      flash(okMsg);
    } catch (err) {
      if (!isAbort(err)) flash(err.message, 'bad');
      btn.disabled = false;   // a poll with nothing new doesn't repaint it
    }
    if (ctx.alive()) await load().catch(() => {});
  }

  ctx.listen(root, 'click', async (e) => {
    const pick = e.target.closest?.('.lp-pick');
    if (pick && !pick.disabled) {
      const label = pick.querySelector('.story-option-label')?.textContent || pick.dataset.option;
      const { ok } = await askSheet({ label: 'Pick for him', text: `Pick "${label}"? This commits the decision now.`, action: 'PICK', danger: true });
      if (!ok || !ctx.alive()) return;
      post(`/api/arcs/cards/${encodeURIComponent(pick.dataset.id)}/pick`, { optionId: pick.dataset.option }, `PICKED · ${label}`, pick);
      return;
    }
    const veto = e.target.closest?.('.lp-veto');
    if (veto && !veto.disabled) {
      const { ok } = await askSheet({ label: 'Veto the heavy event', text: 'It will never happen.', action: 'VETO', danger: true });
      if (!ok || !ctx.alive()) return;
      post(`/api/arcs/cards/heavy/${encodeURIComponent(veto.dataset.id)}/veto`, {}, 'VETOED', veto);
    }
  });
  ctx.listen($(root, '#lpClosed'), 'change', () => { load().catch((err) => { if (!isAbort(err)) flash(err.message, 'bad'); }); });

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => tickCountdowns(root, offset), 1000);
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life pending poll', err); }); }, POLL_MS);
}
