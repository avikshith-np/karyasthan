// LIFE · TIMELINE (spec 009 T038) — an SVG 24 h ribbon: the day's plan
// (planned lane, from plan.made) against what actually happened (activity /
// travel / sleep spans), decision spans (open → commit/expiry), and every event
// as a tick. Clicking a span or tick loads GET /api/life/events/:id/explain;
// its cause chain is drawn as arrows between ticks and listed beside the
// ribbon, with a revert button for event types the engine lets the owner undo.
// Polls every 30 s while looking at the current day. On a phone the chain opens in a sheet, the
// legend folds, and the ribbon scrolls in its own box, starting at the latest hours.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, slotPainter, $ } from '../core/dom.js';
import { fmtHm, fmtDay, fmtTime } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { openSheet } from '../components/sheet.js';
import { initFolds } from '../components/views.js';
import { showError } from '../components/ui.js';
import { offNote, readOnly, AVAIL_STATES } from './life-now.js';
import { getStatus } from '../components/topbar.js';

const POLL_MS = 30_000;
const DAY = 24 * 3600;
const PAGES = 5;            // ≤ 1000 events per window
const W = 1000;
const L = 78;               // left gutter for lane labels
const R = 12;
const LANES = { planned: [26, 22], actual: [58, 22], decisions: [92, 40], events: [146, 26] };
const H = 196;
const NOISY = new Set(['vitals.checkpoint', 'chat.load']);
// Phone checks are his most frequent events and say little on their own (Day shows them); kept out of the window.
const PHONE = new Set(['phone.check.started', 'phone.check.ended']);
// chat.load (every ≥ 30 min of chatting, counts only) says nothing on its own either: its effect is the vitals.
const HIDDEN = new Set([...PHONE, 'chat.load']);
const REASON_MAX = 200;

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · TIMELINE · PLANNED VS ACTUAL</div>
    <h1>Timeline</h1>
  </div>
  <div class="meta lt-nav">
    <button type="button" id="ltPrev" aria-label="Previous 24 hours">◀ 24 H</button>
    <button type="button" id="ltNow">NOW</button>
    <button type="button" id="ltNext" aria-label="Next 24 hours">24 H ▶</button>
    <span class="lt-window">WINDOW <b data-slot="lt-window">—</b></span>
  </div>
</div>
<div data-slot="lt-off"></div>

<div class="panel">
  <div class="panel-head"><span>LAST 24 H<button type="button" class="guide-q" data-guide="ribbon" aria-label="Guide: last 24 h">?</button></span><span class="mono mute" data-slot="lt-counts">—</span></div>
  <div class="panel-body life-ribbon-wrap"><div data-slot="lt-svg" class="life-ribbon"></div></div>
  <div class="panel-body lt-legend-box"><details class="subfold" data-fold="timeline.legend" data-wide-open><summary class="cap mute">LEGEND<span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="life-legend mono" data-slot="lt-legend"></div>
  </details></div>
</div>

<div class="col-2" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>EVENTS IN WINDOW<button type="button" class="guide-q" data-guide="events" aria-label="Guide: events">?</button></span><span class="mono mute">NEWEST FIRST · CLICK FOR WHY</span></div>
    <div class="life-events" data-slot="lt-events"></div>
  </div>
  <div class="panel">
    <div class="panel-head"><span>WHY · CAUSE CHAIN<button type="button" class="guide-q" data-guide="why" aria-label="Guide: why">?</button></span><span class="mono mute" data-slot="lt-sel">NOTHING SELECTED</span></div>
    <div class="panel-body" data-slot="lt-detail"><div class="empty">CLICK A SPAN OR A TICK</div></div>
  </div>
</div>
`);

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function payloadSummary(p) {
  if (!p || typeof p !== 'object') return '';
  try {
    const s = JSON.stringify(p);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return '';
  }
}

export function ribbon({ from, to, planned, actual, decisions, events, links, orphaned, selected, chain, nowAt }) {
  const span = Math.max(1, to - from);
  const x = (t) => +(L + (clampN(t, from, to) - from) / span * (W - L - R)).toFixed(1);
  const wOf = (a, b) => Math.max(1.5, x(b) - x(a));
  const grid = [];
  for (let h = 0; h <= 24; h += 3) {
    const t = from + h * 3600;
    grid.push(html`<line class="lt-grid" x1="${x(t)}" x2="${x(t)}" y1="16" y2="${H - 18}"></line>
      <text class="lt-tick-label" x="${x(t)}" y="${H - 4}" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}">${fmtHm(t)}</text>`);
  }
  const lane = (name, label) => html`<text class="lt-lane-label" x="4" y="${LANES[name][0] + LANES[name][1] / 2 + 4}">${label}</text>`;
  const sel = selected || null;
  const plannedEls = planned.map((b) => html`<rect class="lt-span lt-av-${b.availability || 'none'} ${sel === b.planEventId ? 'is-sel' : ''}" data-ev="${b.planEventId}"
      x="${x(b.start)}" y="${LANES.planned[0]}" width="${wOf(b.start, b.end)}" height="${LANES.planned[1]}" rx="2">
      <title>${`PLANNED ${b.kind} ${fmtHm(b.start)}–${fmtHm(b.end)}${b.place ? ` · ${b.place}` : ''} · ${b.availability || ''}`}</title></rect>`);
  const actualEls = actual.map((b) => html`<rect class="lt-span lt-kind-${String(b.kind).replace(/[^a-z_-]/gi, '')} ${sel === b.eventId ? 'is-sel' : ''}" data-ev="${b.eventId}"
      x="${x(b.start)}" y="${LANES.actual[0]}" width="${wOf(b.start, b.end)}" height="${LANES.actual[1]}" rx="2">
      <title>${`ACTUAL ${b.kind} ${fmtHm(b.start)}–${fmtHm(b.end)}${b.place ? ` · ${b.place}` : ''}`}</title></rect>`);
  const rows = Math.max(1, Math.min(3, decisions.length));
  const rowH = LANES.decisions[1] / rows;
  const decEls = decisions.map((d, i) => {
    const a = d.opensAt ?? from;
    const b = d.closedAt ?? d.decideBy ?? to;
    const y = LANES.decisions[0] + (i % rows) * rowH;
    const commitX = d.committed?.at ? x(d.committed.at) : null;
    return html`<g class="lt-dec lt-dec-${d.status}">
      <rect class="lt-span ${sel === d.id ? 'is-sel' : ''}" data-ev="${d.id}" x="${x(a)}" y="${y + 2}" width="${wOf(a, b)}" height="${Math.max(4, rowH - 4)}" rx="2">
        <title>${`DECISION #${d.id} ${d.kind} · ${d.status}${d.lean ? ` · lean ${d.lean.optionId} p ${Number(d.lean.p ?? 0).toFixed(2)}` : ''}${d.committed ? ` · chose ${d.committed.optionId}` : ''}`}</title></rect>
      ${d.ponrAt ? html`<line class="lt-ponr" x1="${x(d.ponrAt)}" x2="${x(d.ponrAt)}" y1="${y + 1}" y2="${y + rowH - 1}"></line>` : ''}
      ${commitX != null ? html`<circle class="lt-commit" cx="${commitX}" cy="${y + rowH / 2}" r="4"></circle>` : ''}
    </g>`;
  });
  const orph = new Set(orphaned || []);
  const evX = new Map(events.map((e) => [e.id, x(e.at)]));
  const tickTop = LANES.events[0];
  const tickH = LANES.events[1];
  const evEls = events.filter((e) => !NOISY.has(e.type)).map((e) => html`<g class="lt-ev ${e.reverted ? 'is-reverted' : ''} ${orph.has(e.id) ? 'is-orphan' : ''} ${sel === e.id ? 'is-sel' : ''} lt-actor-${e.actor}" data-ev="${e.id}">
      <rect class="lt-hit" x="${evX.get(e.id) - 4}" y="${tickTop}" width="8" height="${tickH}"></rect>
      <line x1="${evX.get(e.id)}" x2="${evX.get(e.id)}" y1="${tickTop + 3}" y2="${tickTop + tickH - 3}"></line>
      <title>${`#${e.id} ${e.type} · ${fmtHm(e.at)} · ${e.actor}${e.reverted ? ' · REVERTED' : ''}${orph.has(e.id) ? ' · ORPHANED' : ''}`}</title></g>`);
  // Cause arrows: the selected chain, else every link touching the selection.
  const pairs = [];
  if (chain?.length > 1) for (let i = 1; i < chain.length; i++) pairs.push([chain[i - 1].id, chain[i].id]);
  else if (sel) for (const l of links || []) if (l.from === sel || l.to === sel) pairs.push([l.from, l.to]);
  const arrowY = tickTop + 2;
  const arrows = pairs.filter(([a, b]) => evX.has(a) && evX.has(b)).map(([a, b]) => {
    const x1 = evX.get(a); const x2 = evX.get(b);
    const lift = Math.min(40, 10 + Math.abs(x2 - x1) / 6);
    return html`<path class="lt-arrow" marker-end="url(#ltArrowHead)" d="M${x1},${arrowY} C${x1},${arrowY - lift} ${x2},${arrowY - lift} ${x2},${arrowY}"></path>`;
  });
  const nowLine = nowAt >= from && nowAt <= to
    ? html`<line class="lt-now" x1="${x(nowAt)}" x2="${x(nowAt)}" y1="12" y2="${H - 18}"></line><text class="lt-now-label" x="${x(nowAt) + 3}" y="12">NOW</text>`
    : '';
  // The lane names are their own layer, sticky in the scrolling box: on a phone the ribbon is wider
  // than the screen and opens on its latest hours, so names drawn in it would be off-screen.
  return html`<div class="lt-ribbon-grid"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="24 hour timeline, planned against actual">
    <defs><marker id="ltArrowHead" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="lt-arrow-head"></path></marker></defs>
    ${grid}
    ${plannedEls}${actualEls}${decEls}${evEls}${arrows}${nowLine}
  </svg><svg class="lt-labels" viewBox="0 0 ${L} ${H}" aria-hidden="true">${lane('planned', 'PLANNED')}${lane('actual', 'ACTUAL')}${lane('decisions', 'DECISIONS')}${lane('events', 'EVENTS')}</svg></div>`;
}

function legend() {
  return html`<span class="mute">PLANNED BY AVAILABILITY:</span> ${AVAIL_STATES.map((s) => html`<span class="life-swatch lt-av-${s}"></span>${s} `)}
    <br><span class="mute">ACTUAL BY KIND:</span> ${[['sleep', 'sleep'], ['commute', 'commute'], ['work', 'work'], ['meeting', 'meeting'], ['social', 'social / leisure'], ['other', 'other']].map(([k, l]) => html`<span class="life-swatch lt-sw-kind-${k}"></span>${l} `)}
    <br><span class="mute">TICKS:</span> <span class="life-swatch lt-sw-engine"></span>engine <span class="life-swatch lt-sw-jev"></span>jev
    <span class="life-swatch lt-sw-chat"></span>chat <span class="life-swatch lt-sw-owner"></span>owner
    <span class="mute"> · dashed = reverted · ring = orphaned · ● committed · | point of no return</span>`;
}

/** The cause chain (root first) as a list; Life · Day shows it too. */
export function chainList(chain, targetId) {
  return html`<ol class="life-chain">${chain.map((e) => html`<li class="${e.id === targetId ? 'is-target' : ''}">
      <div class="mono"><b>#${e.id}</b> ${e.type} <span class="mute">· ${fmtTime(e.at)} · ${e.actor} · ${e.originKind}${e.originJid && e.originJid !== 'self' && e.originJid !== 'owner' ? ` ${e.originJid}` : ''}</span>
        ${e.reverted ? html`<span class="chip bad">REVERTED</span>` : ''}${e.redacted ? html`<span class="chip">REDACTED</span>` : ''}${e.heavy ? html`<span class="chip warn">HEAVY</span>` : ''}</div>
      <div class="mono mute life-payload">${payloadSummary(e.payload)}</div>
    </li>`)}</ol>`;
}

function chainView(chain, targetId, ro) {
  if (!chain?.length) return html`<div class="empty">NO SUCH EVENT</div>`;
  const target = chain[chain.length - 1];
  const canRevert = target.id === targetId && target.revertible && !target.reverted;
  return html`
    ${chainList(chain, targetId)}
    ${canRevert ? html`<form class="life-revert" id="ltRevertForm">
        <label class="mono mute" for="ltReason">REVERT #${target.id} (${target.type}) — reason, optional</label>
        <input id="ltReason" name="reason" maxlength="${REASON_MAX}" autocomplete="off" ${ro ? raw('disabled') : ''}>
        <button type="submit" class="danger" ${ro ? raw('disabled') : ''}>REVERT</button>
        ${ro ? html`<div class="mono mute">read-only dashboard</div>` : ''}
      </form>`
    : html`<div class="mono mute">${target.reverted ? 'already reverted' : `${target.type} is not revertible now (the pulse would re-derive it, or it has already taken effect)`}</div>`}`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  initFolds(root);
  // A poll with nothing new touches nothing: the ribbon's scroll and a selection survive.
  const paintSlot = slotPainter(root);
  const setSlot = (_, key, tpl) => paintSlot(key, tpl);
  setSlot(root, 'lt-legend', legend());
  const narrow = () => globalThis.matchMedia?.('(max-width: 900px)').matches === true;
  let sheet = null;
  let ribbonPlaced = false;
  // Where the chain goes: the sheet on a phone, its panel on desktop.
  const showDetail = (tpl) => { if (sheet) render(sheet.body, tpl); else setSlot(root, 'lt-detail', tpl); };
  const ensureSheet = () => {
    if (sheet || !narrow()) return;
    sheet = openSheet({ label: 'Why · cause chain', content: html`<div class="loading">LOADING</div>`, onClose: () => { sheet = null; } });
    ctx.onDispose(sheet.close);
    sheet.body.addEventListener('submit', onRevert);
  };
  let offsetDays = 0;
  let selected = null;
  let chain = null;
  let data = null;

  async function fetchEvents(from, to) {
    const out = [];
    let before = '';
    for (let i = 0; i < PAGES; i++) {
      const r = await api(`/api/life/events?from=${from}&to=${to}&limit=200${before ? `&before=${before}` : ''}`, { signal: ctx.signal });
      out.push(...(r.events || []));
      if (!r.nextBefore) break;
      before = r.nextBefore;
    }
    return out;
  }

  function paint() {
    if (!data) return;
    const { tl } = data;
    const events = data.events.filter((e) => !HIDDEN.has(e.type));
    const phoneHidden = data.events.filter((e) => PHONE.has(e.type)).length;
    setSlot(root, 'lt-off', tl.running ? null : offNote(getStatus()?.life?.skill === true));
    setSlots(root, {
      'lt-window': `${fmtDay(tl.from)} ${fmtHm(tl.from)} → ${fmtDay(tl.to)} ${fmtHm(tl.to)}`,
      'lt-counts': `${tl.planned.length} PLANNED · ${tl.actual.length} ACTUAL · ${tl.decisions.length} DECISIONS · ${events.length} EVENTS${phoneHidden ? ` · ${phoneHidden} PHONE CHECKS HIDDEN` : ''}`,
      'lt-sel': selected ? `EVENT #${selected}` : 'NOTHING SELECTED',
    });
    setSlot(root, 'lt-svg', ribbon({ ...tl, events, selected, chain, nowAt: Math.floor(Date.now() / 1000) }));
    if (!ribbonPlaced) {
      ribbonPlaced = true;
      const box = $(root, '.life-ribbon-wrap');
      if (box) box.scrollLeft = box.scrollWidth;
    }
    setSlot(root, 'lt-events', events.length
      ? events.slice(0, 120).map((e) => html`<div class="logline life-evline ${e.id === selected ? 'is-sel' : ''} ${e.reverted ? 'is-reverted' : ''}" data-ev="${e.id}" role="button" tabindex="0" style="grid-template-columns:52px 1fr">
          <span class="lt">${fmtHm(e.at)}</span><span><b>#${e.id}</b> ${e.type} <span class="mute">· ${e.actor}</span>${e.reverted ? html` <span class="chip bad">REVERTED</span>` : ''}</span></div>`)
      : html`<div class="empty">NO EVENTS IN THIS WINDOW</div>`);
  }

  async function load() {
    const to = Math.floor(Date.now() / 1000) - offsetDays * DAY;
    const from = to - DAY;
    const [tl, events] = await Promise.all([
      api(`/api/life/timeline?from=${from}&to=${to}`, { signal: ctx.signal }),
      fetchEvents(from, to),
    ]);
    if (!ctx.alive()) return;
    data = { tl, events };
    paint();
  }

  async function select(id) {
    selected = id;
    chain = null;
    paint();
    try {
      const r = await api(`/api/life/events/${encodeURIComponent(id)}/explain`, { signal: ctx.signal });
      if (!ctx.alive() || selected !== id) return;
      chain = r.chain || [];
      showDetail(chainView(chain, id, readOnly()));
      paint();
    } catch (err) {
      if (isAbort(err) || !ctx.alive()) return;
      showDetail(html`<div class="empty">${err.message}</div>`);
    }
  }

  const pick = (e) => {
    const hit = e.target.closest?.('[data-ev]');
    const id = hit ? Number(hit.dataset.ev) : NaN;
    if (Number.isSafeInteger(id) && id > 0) { ensureSheet(); select(id); }
  };
  ctx.listen($(root, '[data-slot="lt-svg"]'), 'click', pick);
  ctx.listen($(root, '[data-slot="lt-events"]'), 'click', pick);
  ctx.listen($(root, '[data-slot="lt-events"]'), 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
  const shift = (d) => { offsetDays = Math.max(0, offsetDays + d); load().catch((err) => { if (!isAbort(err) && ctx.alive()) flash(err.message, 'bad'); }); };
  ctx.listen($(root, '#ltPrev'), 'click', () => shift(1));
  ctx.listen($(root, '#ltNext'), 'click', () => shift(-1));
  ctx.listen($(root, '#ltNow'), 'click', () => shift(-offsetDays));
  async function onRevert(e) {
    if (e.target?.id !== 'ltRevertForm') return;
    e.preventDefault();
    const id = selected;
    const reason = String(e.target.querySelector('#ltReason')?.value || '').slice(0, REASON_MAX);
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const r = await api(`/api/life/events/${encodeURIComponent(id)}/revert`, { method: 'POST', body: { reason } });
      flash(r.already ? `#${id} WAS ALREADY REVERTED` : `#${id} REVERTED`);
      if (!ctx.alive()) return;
      await load();
      await select(id);
    } catch (err) {
      if (isAbort(err)) return;
      flash(err.message, 'bad');
      if (btn && ctx.alive()) btn.disabled = false;
    }
  }
  ctx.listen(root, 'submit', onRevert);

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => {
    if (offsetDays === 0) load().catch((err) => { if (!isAbort(err)) console.warn('life timeline poll', err); });
  }, POLL_MS);
}

