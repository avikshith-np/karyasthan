// MIND — the owner's view of the mind and the levers over it (spec 008 US3,
// contracts/dashboard-api.md). Panels, top to bottom: status bar, self-state,
// timeline (runs + digests + episodes), self-model, nudges + bands, proactive,
// exclusions. The status polls every 30 s (no SSE topic, research R25); the other
// panels load on mount and refresh after a write or on demand.
//
// Every model- or chat-derived string (digests, episodes, intents, voiced/alt text,
// notes, reasons, rationale, self-model text) is rendered through `html` tagged
// templates, which escape. This file never uses the unescaped markup helper
// (test 11 greps for it): the self-model diff is built per line from nested
// `html` templates.
import { api, isAbort, readCookie } from '../core/api.js';
import { html, render, setSlot, setSlots, $ } from '../core/dom.js';
import { fmtClock, fmtNum, fmtRelative, fmtTime, fmtUsd, fmtWhen } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet, openSheet } from '../components/sheet.js';
import { dreamCard, initFolds, stanceRow } from '../components/views.js';
import { originCell } from '../components/provenance.js';
import { showError } from '../components/ui.js';

const POLL_MS = 30_000;
const DREAMS_SHOWN = 5;
const RUN_KINDS = ['', 'glance', 'think', 'sleep', 'selfmodel', 'draft', 'digest', 'pulse'];
const DRAFT_FILTERS = ['', 'shadow', 'would_send', 'queued', 'sent', 'dry_run', 'send_failed', 'dropped', 'cancelled', 'expired'];
const STATUS_PILL = { ok: 'ok', skipped: '', invalid: 'bad', failed: 'bad', partial: 'warn', running: 'warn' };
const FUN_AB_NOTE = 'group targets only; sends the group\'s recent messages, recall and profile to the fun provider (Grok via OpenRouter)';

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · MIND · WHAT IT THINKS, WHAT IT MAY CHANGE</div>
    <h1>Mind</h1>
  </div>
  <div class="meta">
    <span><a href="#life/phrases">PHRASES</a></span>
    <span>STATE <b data-slot="m-state">—</b></span>
    <span>PROACTIVE <b data-slot="m-mode">—</b></span>
    <span>REVIEW <b data-slot="m-review">—</b></span>
    <span>UPDATED <b data-slot="m-updated">—</b></span>
  </div>
</div>

<div class="panel">
  <div class="panel-head"><span>STATUS<button type="button" class="guide-q" data-guide="status" aria-label="Guide: status">?</button></span><span class="mono mute">POLLS EVERY 30 S</span></div>
  <div class="panel-body">
    <div data-slot="m-reminders"></div>
    <div class="kpi-grid" style="margin-top:8px">
      <div class="kpi"><div class="lab"><span>MIND SPEND · MONTH</span></div><div class="val mono" data-slot="m-spend">—</div><div class="sub" data-slot="m-spend-sub">—</div></div>
      <div class="kpi"><div class="lab"><span>GLOBAL CAP</span></div><div class="val mono" data-slot="m-global">—</div><div class="sub" data-slot="m-global-sub">—</div></div>
      <div class="kpi"><div class="lab"><span>TODAY</span></div><div class="val mono" data-slot="m-today">—</div><div class="sub" data-slot="m-today-sub">—</div></div>
      <div class="kpi"><div class="lab"><span>LAST RUN</span></div><div class="val mono" data-slot="m-last">—</div><div class="sub" data-slot="m-last-sub">—</div></div>
    </div>
    <div data-slot="m-status-detail" style="margin-top:10px"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      <button data-write type="button" id="mPause">PAUSE</button>
      <button data-write type="button" class="primary" id="mThinkNow">THINK NOW</button>
      <button data-write type="button" data-review-extend="7">EXTEND REVIEW 7 DAYS</button>
      <button data-write type="button" data-review-mode="window">REVIEW WINDOW (DEFAULT)</button>
      <button data-write type="button" data-review-mode="review">ALWAYS REVIEW</button>
      <button data-write type="button" data-review-mode="auto">AUTO-APPLY NOW</button>
    </div>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <details class="fold-in" data-fold="mind.selfstate" open><summary class="panel-head"><span>SELF-STATE<button type="button" class="guide-q" data-guide="selfstate" aria-label="Guide: selfstate">?</button></span><span class="mono mute" data-slot="m-ss-count">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="panel-body">
      <label class="mono mute" style="font-size: var(--t-label)">RENDER AS CHAT
        <select id="mAsChat"><option value="">— everything, unfiltered —</option></select>
      </label>
      <div data-slot="m-ss-preview" style="margin-top:8px"></div>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>KIND</th><th>STATE</th><th>ORIGINS</th><th>EXPIRES</th><th data-slot="m-ss-usable-h"></th></tr></thead>
      <tbody data-slot="m-ss"><tr><td colspan="5" class="loading">LOADING</td></tr></tbody>
    </table></div>
  </details>
  </div>

  <div class="panel">
    <details class="fold-in" data-fold="mind.timeline" data-wide-open><summary class="panel-head"><span>TIMELINE<button type="button" class="guide-q" data-guide="timeline" aria-label="Guide: timeline">?</button></span>
      <span><label for="mRunKind" class="mono mute">KIND</label> <select id="mRunKind">${RUN_KINDS.map((k) => html`<option value="${k}">${k || 'all'}</option>`)}</select></span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="table-wrap" style="max-height:320px;overflow:auto"><table class="data">
      <thead><tr><th>#</th><th>KIND</th><th>STATUS</th><th>STARTED</th><th>MODEL</th><th>TOKENS</th><th>COST</th></tr></thead>
      <tbody data-slot="m-runs"><tr><td colspan="7" class="loading">LOADING</td></tr></tbody>
    </table></div>
    <div style="padding:6px 12px"><button type="button" id="mRunsOlder">OLDER</button></div>
    <div class="panel-body" data-slot="m-run-detail"><span class="mute mono" style="font-size: var(--t-meta)">▸ click a run to see its input summary, output and dropped actions</span></div>
  </details>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <details class="fold-in" data-fold="mind.digests" data-wide-open><summary class="panel-head"><span>DIGESTS<button type="button" class="guide-q" data-guide="digests" aria-label="Guide: digests">?</button></span><span class="mono mute">CLERK SUMMARIES PER CHAT</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="table-wrap" style="max-height:300px;overflow:auto"><table class="data">
      <thead><tr><th>CHAT</th><th>TONE</th><th>SUMMARY</th><th>PERIOD</th></tr></thead>
      <tbody data-slot="m-digests"><tr><td colspan="4" class="loading">LOADING</td></tr></tbody>
    </table></div>
  </details>
  </div>
  <div class="panel">
    <details class="fold-in" data-fold="mind.episodes" data-wide-open><summary class="panel-head"><span>EPISODES<button type="button" class="guide-q" data-guide="episodes" aria-label="Guide: episodes">?</button></span><span class="mono mute">INCLUDES SUPERSEDED</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="table-wrap" style="max-height:300px;overflow:auto"><table class="data">
      <thead><tr><th>DAY</th><th>EPISODE</th><th>ORIGIN</th><th>EVID.</th></tr></thead>
      <tbody data-slot="m-episodes"><tr><td colspan="4" class="loading">LOADING</td></tr></tbody>
    </table></div>
  </details>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="mind.selfmodel" data-wide-open><summary class="panel-head"><span>SELF-MODEL<button type="button" class="guide-q" data-guide="selfmodel" aria-label="Guide: selfmodel">?</button></span><span class="mono mute" data-slot="m-sm-active-meta">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body">
    <div class="cap mute" style="font-size: var(--t-label)">ACTIVE</div>
    <pre class="mono" style="white-space:pre-wrap;margin:6px 0 0;font-size: var(--t-data)" data-slot="m-sm-active">—</pre>
    <div class="divider" style="margin:14px 0"></div>
    <div class="cap mute" style="font-size: var(--t-label)">PENDING PROPOSALS</div>
    <div data-slot="m-sm-pending" style="display:grid;gap:10px;margin-top:8px"></div>
    <div class="divider" style="margin:14px 0"></div>
    <div class="cap mute" style="font-size: var(--t-label)">EDIT (BECOMES THE ACTIVE VERSION · LINES WITH PHONE NUMBERS, IDS, EMAILS OR LINKS ARE REMOVED · NAMES ARE KEPT WITH A WARNING · ≤ 1500 CHARS)</div>
    <form id="mSmEdit" style="display:grid;gap:6px;margin-top:8px">
      <textarea name="text" rows="6" maxlength="1500" aria-label="Self-model text"></textarea>
      <div style="display:flex;gap:6px;align-items:center"><button data-write class="primary" type="submit">SAVE AS ACTIVE</button><span class="mono mute" style="font-size: var(--t-label)" data-slot="m-sm-count">0 / 1500</span></div>
    </form>
  </div>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>VERSION</th><th>STATUS</th><th>SOURCE</th><th>CREATED</th><th>DECIDED BY</th><th>CHANGES</th><th></th></tr></thead>
    <tbody data-slot="m-sm-versions"><tr><td colspan="7" class="loading">LOADING</td></tr></tbody>
  </table></div>
  </details>
  </div>

<div class="col-2">
  <div class="panel">
    <details class="fold-in" data-fold="mind.nudges" data-wide-open><summary class="panel-head"><span>NUDGES<button type="button" class="guide-q" data-guide="nudges" aria-label="Guide: nudges">?</button></span><span class="mono mute">THE MIND'S OVERLAY · NEVER .ENV</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>KNOB</th><th>SCOPE</th><th>VALUE</th><th>BAND</th><th>STATUS</th><th>EXPIRES</th><th></th></tr></thead>
      <tbody data-slot="m-nudges"><tr><td colspan="7" class="loading">LOADING</td></tr></tbody>
    </table></div>
  </details>
  </div>
  <div class="panel">
    <details class="fold-in" data-fold="mind.bands" data-wide-open><summary class="panel-head"><span>GUARD BANDS<button type="button" class="guide-q" data-guide="bands" aria-label="Guide: bands">?</button></span><span class="mono mute">OWNER ONLY</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="panel-body">
      <div data-slot="m-knobs" class="mute" style="font-size: var(--t-meta)"></div>
      <form id="mBands" style="display:grid;gap:6px;margin-top:8px">
        <textarea name="bands" rows="10" class="mono" aria-label="Guard bands JSON"></textarea>
        <div><button data-write class="primary" type="submit">SAVE BANDS</button></div>
      </form>
    </div>
  </details>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="mind.proactive" data-wide-open><summary class="panel-head"><span>PROACTIVE<button type="button" class="guide-q" data-guide="proactive" aria-label="Guide: proactive">?</button></span><span class="mono mute" data-slot="m-pro-mode">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body">
    <div data-slot="m-pro-banner"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <span class="mono mute" style="font-size: var(--t-label)">MODE</span>
      <button data-write type="button" data-mode="off">OFF</button>
      <button data-write type="button" data-mode="shadow">SHADOW</button>
      <button data-write type="button" class="danger" data-mode="live">LIVE…</button>
      <span style="flex:1"></span>
      <label class="mono" style="font-size: var(--t-label)"><input type="checkbox" id="mFunAb" /> FUN A/B</label>
    </div>
    <div class="mute" style="font-size: var(--t-meta);margin-top:6px">Fun A/B: ${FUN_AB_NOTE}. Its output is stored here only and never sent.</div>
    <div style="margin-top:8px"><label for="mProStatus" class="mono mute" style="font-size: var(--t-label)">STATUS</label> <select id="mProStatus">${DRAFT_FILTERS.map((s) => html`<option value="${s}">${s || 'all'}</option>`)}</select></div>
  </div>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>CREATED</th><th>CHAT</th><th>KIND</th><th>MODE / STATUS</th><th>INTENT</th><th>VOICED</th><th>ALT</th><th>GATE</th><th></th></tr></thead>
    <tbody data-slot="m-drafts"><tr><td colspan="9" class="loading">LOADING</td></tr></tbody>
  </table></div>
  </details>
  </div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="mind.stances" data-wide-open><summary class="panel-head"><span>INTERESTS &amp; OPINIONS<button type="button" class="guide-q" data-guide="stances" aria-label="Guide: stances">?</button></span><span class="mono mute" data-slot="m-stance-count">—</span></summary>
  <div class="panel-body">
    <div style="display:flex;gap:6px;flex-wrap:wrap" data-slot="m-stance-actions"></div>
    <div class="m-stances" data-slot="m-stances"><span class="loading">LOADING</span></div>
  </div>
  </details>
</div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="mind.dreams" data-wide-open><summary class="panel-head"><span>DREAMS<button type="button" class="guide-q" data-guide="dreams" aria-label="Guide: dreams">?</button></span><span class="mono mute" data-slot="m-dream-count">—</span></summary>
  <div class="panel-body" style="display:grid;gap:10px" data-slot="m-dreams"><span class="loading">LOADING</span></div>
  </details>
</div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="mind.exclusions" data-wide-open><summary class="panel-head"><span>EXCLUSIONS<button type="button" class="guide-q" data-guide="exclusions" aria-label="Guide: exclusions">?</button></span><span class="mono mute">NEVER REACH OUT TO THESE</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body">
    <label class="mono" style="font-size: var(--t-meta)"><input type="checkbox" id="mExcludeAll" /> EXCLUDE EVERYONE (no proactive message to anyone)</label>
    <form id="mExclAdd" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      <select name="chat" aria-label="Person or group to exclude"><option value="">— pick a chat —</option></select>
      <input type="text" name="note" maxlength="120" placeholder="note (optional)" aria-label="Exclusion note" />
      <button data-write class="primary" type="submit">+ EXCLUDE</button>
    </form>
  </div>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>KIND</th><th>WHO</th><th>SOURCE</th><th>P</th><th>NOTE</th><th>SINCE</th><th></th></tr></thead>
    <tbody data-slot="m-excl"><tr><td colspan="7" class="loading">LOADING</td></tr></tbody>
  </table></div>
  </details>
  </div>`;

// ── view helpers (pure) ─────────────────────────────────────────────────────

const list = (v) => (Array.isArray(v) ? v : []);
const short = (s, n = 160) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const when = (ts) => (ts ? html`<span title="${fmtTime(ts)}">${fmtRelative(ts)}</span>` : html`<span class="mute">—</span>`);
const until = (ts) => {
  if (!ts) return html`<span class="mute">—</span>`;
  const sec = Number(ts) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(sec)) return html`<span class="mute">—</span>`;
  const label = sec <= 0 ? 'due' : sec < 3600 ? `in ${Math.ceil(sec / 60)}m` : sec < 86400 ? `in ${Math.round(sec / 3600)}h` : `in ${Math.round(sec / 86400)}d`;
  return html`<span title="${fmtTime(ts)}">${label}</span>`;
};
const json = (v) => {
  try { return JSON.stringify(v ?? null, null, 2); } catch { return String(v); }
};

/** Origin tags of an element/draft ({originJid, originKind}) through the shared originCell. */
export function originTags(origins, nameOf = () => null) {
  const rows = list(origins);
  if (!rows.length) return html`<span class="chip">self</span>`;
  return rows.map((o) => originCell({
    origin_kind: o.originKind ?? o.origin_kind,
    origin_jid: o.originJid ?? o.origin_jid,
    origin_label: nameOf(o.originJid ?? o.origin_jid),
  }));
}

/**
 * Line diff → nested html (never unescaped markup). Accepts [{op:'+'|'-'|' ', text}],
 * [{type:'add'|'del'|'same', line}], or ['+line', '-line', ' line'].
 */
export function diffView(diff) {
  const lines = list(diff);
  if (!lines.length) return html`<span class="mute mono" style="font-size: var(--t-meta)">no diff</span>`;
  return html`<pre class="mono" style="white-space:pre-wrap;margin:0;font-size: var(--t-meta)">${lines.map((d) => {
    let op = ' ';
    let text = '';
    if (typeof d === 'string') { op = d[0] === '+' || d[0] === '-' ? d[0] : ' '; text = op === ' ' && d[0] !== ' ' ? d : d.slice(1); }
    else if (d && typeof d === 'object') {
      const t = d.op ?? d.type ?? d.kind;
      op = t === '+' || t === 'add' || t === 'added' || t === 'ins' ? '+' : t === '-' || t === 'del' || t === 'removed' || t === 'remove' ? '-' : ' ';
      text = d.text ?? d.line ?? d.value ?? '';
    }
    if (op === '+') return html`<ins style="color:#8bc06b;text-decoration:none">+ ${text}</ins>\n`;
    if (op === '-') return html`<del style="color:var(--red-bright)">- ${text}</del>\n`;
    return html`<span class="mute">  ${text}</span>\n`;
  })}</pre>`;
}

function scrubView(scrub) {
  if (!scrub || typeof scrub !== 'object') return null;
  const entries = Object.entries(scrub).filter(([, v]) => v !== null && v !== undefined && v !== false && !(Array.isArray(v) && !v.length));
  if (!entries.length) return html`<span class="chip ok">scrub clean</span>`;
  return entries.map(([k, v]) => html`<span class="chip warn" title="${typeof v === 'object' ? json(v) : String(v)}">${k}${typeof v === 'number' ? html` · ${v}` : Array.isArray(v) ? html` · ${v.length}` : ''}</span>`);
}

function elementState(e) {
  const bits = [];
  if (e.word) bits.push(html`<b>${e.word}</b>`);
  if (typeof e.intensity === 'number') bits.push(html` <span class="mute">${fmtNum(e.intensity, 2)}</span>`);
  if (e.intentionKind) bits.push(html` <span class="chip">${e.intentionKind}</span>`);
  if (e.text && e.text !== e.word) bits.push(html`<div>${e.text}</div>`);
  return bits.length ? bits : html`<span class="mute">—</span>`;
}

function bandText(b) {
  if (!b || typeof b !== 'object') return '—';
  if (Array.isArray(b.allowed)) return b.allowed.join('|');
  const lo = b.min ?? b.lo;
  const hi = b.max ?? b.hi;
  if (lo != null || hi != null) return `${fmtNum(Number(lo), 2)}–${fmtNum(Number(hi), 2)}`;
  return json(b).slice(0, 60);
}

const scalar = (v) => (v == null ? '—' : typeof v === 'number' ? fmtNum(v, 3) : String(v));

// ── page ───────────────────────────────────────────────────────────────────

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  initFolds(root);
  const opt = () => ({ signal: ctx.signal });
  let status = null;
  let runsBefore = null;
  let selfModel = null;
  const names = new Map();
  const nameOf = (jid) => (jid ? names.get(jid) || null : null);

  /** A write: CSRF header from the session cookie (as api() does), error reason surfaced. */
  async function send(path, method, body) {
    const headers = {};
    const csrf = readCookie('csrf_token');
    if (csrf) headers['X-CSRF-Token'] = csrf;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(path, { credentials: 'include', method, headers, body: payload, signal: ctx.signal });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const why = data?.reason || data?.field || data?.error || res.statusText;
      throw new Error(`${res.status}: ${data?.error || 'error'}${why && why !== data?.error ? ` · ${why}` : ''}`);
    }
    return data;
  }

  async function act(path, method, body, okMsg, after = []) {
    try {
      const r = await send(path, method, body);
      if (!ctx.alive()) return null;
      flash(okMsg);
      await Promise.all([loadStatus(), ...after.map((fn) => fn())]);
      return r;
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) flash(err.message, 'bad', 6000);
      return null;
    }
  }

  // 1 · status ---------------------------------------------------------------
  async function loadStatus() {
    const st = await api('/api/mind/status', opt());
    if (!ctx.alive()) return;
    status = st;
    const stateLabel = !st.available ? 'NOT INITIALISED' : !st.enabled ? 'OFF' : st.paused ? 'PAUSED' : 'ON';
    const review = st.review ? `${String(st.review.mode || '—').toUpperCase()}${st.review.autoActive ? ' · AUTO' : ''}` : '—';
    const spend = st.spend || {};
    const g = st.global || {};
    const t = st.today || {};
    const caps = st.caps || {};
    const lr = st.lastRun;
    setSlots(root, {
      'm-state': stateLabel,
      'm-mode': String(st.proactiveMode || '—').toUpperCase(),
      'm-review': review,
      'm-updated': fmtClock(),
      'm-spend': fmtUsd(Number(spend.monthUsd) || 0),
      'm-spend-sub': st.budget ? `role budget ${Number(st.budget.budgetUsd) > 0 ? fmtUsd(st.budget.budgetUsd) : 'none'}${st.budget.allowed === false ? ` · STOPPED (${st.budget.reason || 'over'})` : ''}` : '—',
      'm-global': Number(g.budgetUsd) > 0 ? fmtUsd(g.budgetUsd) : 'NONE',
      'm-global-sub': g.spentUsd != null ? `${fmtUsd(Number(g.spentUsd) || 0)} spent${typeof g.headroomPct === 'number' ? ` · ${fmtNum(g.headroomPct, 0)}% headroom` : ''}` : '—',
      'm-today': `${t.thinks ?? 0} / ${caps.thinkMaxPerDay ?? '—'}`,
      'm-today-sub': `thinks · ${t.glances ?? 0} glances · ${t.sleeps ?? 0} sleeps · ${t.drafts ?? 0} drafts · ${t.sends ?? 0} sends`,
      'm-last': lr ? String(lr.kind || '—').toUpperCase() : '—',
      'm-last-sub': lr ? `${lr.status || '—'}${lr.skipReason ? ` · ${lr.skipReason}` : ''} · ${fmtRelative(lr.at)} ago` : 'no run yet',
      'm-pro-mode': `MODE ${String(st.proactiveMode || '—').toUpperCase()}${st.modeSince ? ` · SINCE ${fmtTime(st.modeSince)}` : ''}`,
    });
    setSlot(root, 'm-reminders', list(st.reminders).length
      ? html`<div style="display:grid;gap:4px">${list(st.reminders).map((r) => html`<div class="mono" style="font-size: var(--t-meta)"><span class="chip warn">${r.code}</span> ${r.text || ''}</div>`)}</div>`
      : html`<span class="mute mono" style="font-size: var(--t-meta)">▸ no reminders</span>`);
    const next = st.next || {};
    setSlot(root, 'm-status-detail', html`<div class="m-detail">
      <span class="mute">NEXT GLANCE</span><b>${until(next.glanceAt)}</b>
      <span class="mute">NEXT THINK</span><b>${until(next.thinkAt)}</b>
      <span class="mute">NEXT SLEEP</span><b>${next.sleepNight || '—'}</b>
      <span class="mute">LIFE</span><b>${st.life ? `${st.life.on ? 'on' : 'off'}${st.life.availability ? ` · ${st.life.availability}` : ''}` : '—'}</b>
      <span class="mute">REVIEW UNTIL</span><b>${st.review?.until ? fmtTime(st.review.until) : '—'}</b>
      <span class="mute">PAUSED</span><b>${st.paused ? `yes · ${fmtRelative(st.pausedAt)} ago` : 'no'}</b>
      <span class="mute">OWNER_JIDS</span><b>${st.ownerJidsSet ? 'set' : 'not set'}</b>
      <span class="mute">BY CALLER</span><b>${list(spend.byCaller).length ? list(spend.byCaller).map((c) => html`<span class="chip">${c.caller} · ${c.calls} · ${fmtUsd(Number(c.costUsd) || 0)}</span>`) : '—'}</b>
    </div>`);
    const pause = $(root, '#mPause');
    if (pause) { pause.textContent = st.paused ? 'RESUME' : 'PAUSE'; pause.className = st.paused ? 'primary' : 'danger'; }
    const fun = $(root, '#mFunAb');
    if (fun) fun.checked = !!caps.funAb;
    const excl = $(root, '#mExcludeAll');
    if (excl && st.excludeAll !== undefined) excl.checked = !!st.excludeAll;
    setSlot(root, 'm-pro-banner', st.ownerJidsSet ? null
      : html`<div class="mono amber" style="font-size: var(--t-meta);margin-bottom:8px">▸ OWNER_JIDS is not set in .env: live mode is refused, shadow works as usual.</div>`);
  }

  // 2 · self-state -----------------------------------------------------------
  async function loadSelfState() {
    const as = $(root, '#mAsChat')?.value || '';
    const ss = await api(`/api/mind/self-state${as ? `?as=${encodeURIComponent(as)}` : ''}`, opt());
    if (!ctx.alive()) return;
    const els = list(ss?.elements);
    setSlots(root, { 'm-ss-count': `${els.length} ELEMENTS`, 'm-ss-usable-h': as ? 'USABLE HERE' : '' });
    setSlot(root, 'm-ss-preview', as
      ? html`<div class="mono" style="font-size: var(--t-meta)"><span class="mute">LINE THIS CHAT GETS:</span> ${ss?.preview ? html`<b>${ss.preview}</b>` : html`<span class="mute">(empty)</span>`}</div>`
      : null);
    setSlot(root, 'm-ss', els.length
      ? els.map((e) => html`<tr>
          <td class="mono"><span class="chip">${e.kind}</span></td>
          <td>${elementState(e)}${e.targetChat ? html`<div class="mute mono" style="font-size: var(--t-label)">→ ${nameOf(e.targetChat) || e.targetChat}</div>` : ''}</td>
          <td>${originTags(e.origins, nameOf)}</td>
          <td class="mono">${until(e.expiresAt)}</td>
          <td>${as ? (e.usableIn ? html`<span class="chip ok">yes</span>` : html`<span class="chip bad">no</span>`) : ''}</td>
        </tr>`)
      : html`<tr><td colspan="5" class="empty">NO ACTIVE SELF-STATE</td></tr>`);
  }

  // 3 · timeline -------------------------------------------------------------
  async function loadRuns({ older = false } = {}) {
    const kind = $(root, '#mRunKind')?.value || '';
    const qs = new URLSearchParams({ limit: '30' });
    if (kind) qs.set('kind', kind);
    if (older && runsBefore) qs.set('before', String(runsBefore));
    const runs = list(await api(`/api/mind/runs?${qs}`, opt()));
    if (!ctx.alive()) return;
    runsBefore = runs.length ? runs[runs.length - 1].id : runsBefore;
    setSlot(root, 'm-runs', runs.length
      ? runs.map((r) => html`<tr data-run="${r.id}" style="cursor:pointer">
          <td class="id">${r.id}</td>
          <td class="mono">${r.kind}${r.trigger ? html` <span class="mute">· ${r.trigger}</span>` : ''}</td>
          <td><span class="pill ${STATUS_PILL[r.status] ?? ''}">${r.status}</span>${r.skipReason ? html` <span class="mute mono" style="font-size: var(--t-label)">${r.skipReason}</span>` : ''}${r.degraded ? html` <span class="chip warn">degraded</span>` : ''}${r.fellBack ? html` <span class="chip warn">fell back</span>` : ''}</td>
          <td class="mono">${when(r.startedAt)}</td>
          <td class="mono mute" style="font-size: var(--t-label)">${r.model || '—'}</td>
          <td class="num">${r.tokensIn ?? '—'} / ${r.tokensOut ?? '—'}</td>
          <td class="num">${r.costUsd != null ? fmtUsd(Number(r.costUsd)) : '—'}</td>
        </tr>`)
      : html`<tr><td colspan="7" class="empty">${older ? 'NO OLDER RUNS' : 'NO RUNS YET'}</td></tr>`);
  }

  async function showRun(id) {
    const r = await api(`/api/mind/runs/${encodeURIComponent(id)}`, opt());
    if (!ctx.alive()) return;
    const input = r.input ?? r.inputJson ?? r.input_json;
    const output = r.output ?? r.outputJson ?? r.output_json;
    const dropped = r.dropped ?? r.droppedJson ?? r.dropped_json;
    setSlot(root, 'm-run-detail', html`
      <div class="mono" style="font-size: var(--t-meta);margin-bottom:6px">RUN #${r.id} · ${r.kind} · ${r.status}${r.error ? html` · <span class="red-bright">${short(r.error, 120)}</span>` : ''}</div>
      <details open><summary class="mono mute" style="font-size: var(--t-label)">INPUT SUMMARY</summary><pre class="mono" style="white-space:pre-wrap;font-size: var(--t-label);max-height:220px;overflow:auto">${json(input)}</pre></details>
      <details><summary class="mono mute" style="font-size: var(--t-label)">OUTPUT</summary><pre class="mono" style="white-space:pre-wrap;font-size: var(--t-label);max-height:260px;overflow:auto">${json(output)}</pre></details>
      <details><summary class="mono mute" style="font-size: var(--t-label)">DROPPED ACTIONS</summary><pre class="mono" style="white-space:pre-wrap;font-size: var(--t-label);max-height:220px;overflow:auto">${json(dropped)}</pre></details>`);
  }

  async function loadDigests() {
    const rows = list(await api('/api/mind/digests?limit=30', opt()));
    if (!ctx.alive()) return;
    setSlot(root, 'm-digests', rows.length
      ? rows.map((d) => html`<tr>
          <td>${originCell({ origin_kind: d.originKind, origin_jid: d.chatJid, origin_label: d.chatName })}</td>
          <td><span class="chip">${d.tone}</span></td>
          <td>${d.summary}${d.todayNote ? html`<div class="mute" style="font-size: var(--t-meta)">today: ${d.todayNote}</div>` : ''}${list(d.threads).length ? html`<div>${list(d.threads).slice(0, 6).map((t) => html`<span class="chip">${typeof t === 'string' ? t : (t?.topic ?? t?.text ?? json(t))}</span>`)}</div>` : ''}</td>
          <td class="mono" style="font-size: var(--t-label)">${when(d.periodEnd)}</td>
        </tr>`)
      : html`<tr><td colspan="4" class="empty">NO DIGESTS YET</td></tr>`);
  }

  async function loadEpisodes() {
    const rows = list(await api('/api/mind/episodes?limit=50', opt()));
    if (!ctx.alive()) return;
    setSlot(root, 'm-episodes', rows.length
      ? rows.map((e) => html`<tr>
          <td class="mono" style="font-size: var(--t-label)">${e.attribute || '—'}${e.current ? '' : html` <span class="chip">superseded</span>`}</td>
          <td>${e.content}</td>
          <td>${originCell({ origin_kind: e.originKind, origin_jid: e.originJid, origin_label: e.originLabel })}</td>
          <td class="num">${e.evidenceCount ?? 0}</td>
        </tr>`)
      : html`<tr><td colspan="4" class="empty">NO EPISODES YET</td></tr>`);
  }

  // 4 · self-model -----------------------------------------------------------
  async function loadSelfModel() {
    const sm = await api('/api/mind/self-model', opt());
    if (!ctx.alive()) return;
    selfModel = sm || {};
    const active = selfModel.active;
    setSlots(root, {
      'm-sm-active': active?.text ? active.text : '(empty)',
      'm-sm-active-meta': active ? `ACTIVE v${active.version} · ${active.source || '—'} · ${active.activatedAt ? fmtTime(active.activatedAt) : '—'}` : 'NO ACTIVE VERSION',
    });
    const pending = list(selfModel.pending);
    if (!pending.length) {
      setSlot(root, 'm-sm-pending', html`<span class="mute mono" style="font-size: var(--t-meta)">▸ nothing waiting for review</span>`);
    } else {
      const details = await Promise.all(pending.map((p) => api(`/api/mind/self-model/${encodeURIComponent(p.id)}`, opt()).catch(() => null)));
      if (!ctx.alive()) return;
      setSlot(root, 'm-sm-pending', pending.map((p, i) => {
        const d = details[i] || {};
        return html`<div style="border:1px solid var(--line-2);padding:8px">
          <div class="mono" style="font-size: var(--t-meta);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <b>v${p.version}</b><span class="mute">${p.source || ''} · ${when(p.createdAt)}</span>${scrubView(d.scrub)}
            <span style="flex:1"></span>
            <button data-write type="button" class="primary" data-sm-approve="${p.id}">APPROVE</button>
            <button data-write type="button" data-sm-reject="${p.id}">REJECT</button>
          </div>
          ${p.changesSummary ? html`<div style="margin-top:6px">${p.changesSummary}</div>` : ''}
          ${d.rationale ? html`<div class="mute" style="font-size: var(--t-meta);margin-top:4px">why: ${d.rationale}</div>` : ''}
          <div style="margin-top:6px">${diffView(d.diff)}</div>
        </div>`;
      }));
    }
    const versions = list(selfModel.versions);
    setSlot(root, 'm-sm-versions', versions.length
      ? versions.map((v) => html`<tr>
          <td class="mono">v${v.version}</td>
          <td><span class="pill ${v.status === 'active' ? 'ok' : v.status === 'invalid' || v.status === 'rejected' ? 'bad' : v.status === 'proposed' ? 'warn' : ''}">${v.status}</span></td>
          <td class="mono">${v.source || '—'}</td>
          <td class="mono">${when(v.createdAt)}</td>
          <td class="mono mute" style="font-size: var(--t-label)">${v.decidedBy || '—'}</td>
          <td>${v.changesSummary ? short(v.changesSummary, 120) : html`<span class="mute">—</span>`}${v.ownerReason ? html`<div class="mute" style="font-size: var(--t-meta)">rejected: ${short(v.ownerReason, 200)}</div>` : ''}</td>
          <td>${v.status !== 'active' && v.status !== 'invalid' ? html`<button data-write type="button" data-sm-revert="${v.id}" style="padding:3px 6px;font-size: var(--t-micro)">REVERT TO</button>` : ''}</td>
        </tr>`)
      : html`<tr><td colspan="7" class="empty">NO VERSIONS</td></tr>`);
    const ta = $(root, '#mSmEdit textarea');
    if (ta && document.activeElement !== ta) { ta.value = active?.text || ''; countChars(); }
  }

  function countChars() {
    const ta = $(root, '#mSmEdit textarea');
    setSlots(root, { 'm-sm-count': `${ta ? ta.value.length : 0} / 1500` });
  }

  // 5 · nudges + bands -------------------------------------------------------
  async function loadNudges() {
    const rows = list(await api('/api/mind/nudges?limit=100', opt()));
    if (!ctx.alive()) return;
    setSlot(root, 'm-nudges', rows.length
      ? rows.map((n) => html`<tr>
          <td class="mono">${n.knob}</td>
          <td class="mono" style="font-size: var(--t-label)">${n.scope === 'global' ? 'global' : (nameOf(n.scope) || n.scope)}</td>
          <td class="mono">${scalar(n.prevValue ?? n.prev)} → <b>${scalar(n.value)}</b>${n.effective != null && n.effective !== n.value ? html` <span class="mute">(eff. ${scalar(n.effective)})</span>` : ''}${n.requested != null && n.requested !== n.value ? html` <span class="mute">(asked ${scalar(n.requested)})</span>` : ''}</td>
          <td class="mono" style="font-size: var(--t-label)">${bandText(n.band)}</td>
          <td><span class="pill ${n.status === 'active' ? 'ok' : n.status === 'refused' ? 'bad' : ''}">${n.status}</span>${n.refuseReason ? html` <span class="mute mono" style="font-size: var(--t-label)">${n.refuseReason}</span>` : ''}${n.reason ? html`<div class="mute" style="font-size: var(--t-label)">${short(n.reason, 160)}</div>` : ''}</td>
          <td class="mono">${n.active || n.status === 'active' ? until(n.expiresAt) : when(n.endedAt)}</td>
          <td>${n.active || n.status === 'active' ? html`<button data-write type="button" data-nudge-revert="${n.id}" style="padding:3px 6px;font-size: var(--t-micro)">REVERT</button>` : ''}</td>
        </tr>`)
      : html`<tr><td colspan="7" class="empty">NO NUDGES</td></tr>`);
  }

  async function loadBands() {
    const b = await api('/api/mind/bands', opt());
    if (!ctx.alive()) return;
    const knobs = b?.knobs && typeof b.knobs === 'object' ? b.knobs : {};
    const entries = Array.isArray(knobs) ? knobs.map((k) => [k.name ?? k.knob, k]) : Object.entries(knobs);
    setSlot(root, 'm-knobs', entries.length
      ? html`<div style="display:flex;gap:4px;flex-wrap:wrap">${entries.map(([name, k]) => html`<span class="chip" title="${json(k)}">${name}${k?.label ? html` · ${k.label}` : ''}${k?.valueType || k?.type ? html` · ${k.valueType || k.type}` : ''}</span>`)}</div>`
      : html`<span class="mono">▸ no knob metadata (mind not initialised)</span>`);
    const ta = $(root, '#mBands textarea');
    if (ta && document.activeElement !== ta) ta.value = b?.bands ? json(b.bands) : '';
  }

  // 6 · proactive ------------------------------------------------------------
  async function loadDrafts() {
    const st = $(root, '#mProStatus')?.value || '';
    const rows = list(await api(`/api/mind/proactive?limit=50${st ? `&status=${encodeURIComponent(st)}` : ''}`, opt()));
    if (!ctx.alive()) return;
    setSlot(root, 'm-drafts', rows.length
      ? rows.map((d) => html`<tr>
          <td class="mono">${when(d.createdAt)}</td>
          <td>${d.chatName || nameOf(d.chatJid) || d.chatJid} <span class="chip">${d.chatKind}</span></td>
          <td class="mono">${d.kind}${typeof d.urgency === 'number' ? html` <span class="mute">${fmtNum(d.urgency, 2)}</span>` : ''}</td>
          <td><span class="chip">${d.mode}</span> <span class="pill ${d.status === 'sent' ? 'ok' : d.status === 'dropped' || d.status === 'send_failed' ? 'bad' : d.status === 'queued' ? 'warn' : ''}">${d.status}</span>${d.dropReason ? html`<div class="mute mono" style="font-size: var(--t-label)">${d.dropReason}</div>` : ''}${d.sendAfter && d.status === 'queued' ? html`<div class="mute mono" style="font-size: var(--t-label)">send ${until(d.sendAfter)}</div>` : ''}</td>
          <td>${d.intent ? short(d.intent, 200) : html`<span class="mute">—</span>`}${d.reason ? html`<div class="mute" style="font-size: var(--t-label)">why: ${short(d.reason, 160)}</div>` : ''}</td>
          <td>${d.voicedText || html`<span class="mute">—</span>`}</td>
          <td>${d.altText ? html`${d.altText}<div class="mute mono" style="font-size: var(--t-label)">${d.altModel || ''}</div>` : html`<span class="mute">—</span>`}</td>
          <td class="num">${typeof d.gateScore === 'number' ? fmtNum(d.gateScore, 2) : '—'}${d.gateReason ? html`<div class="mute" style="font-size: var(--t-label);text-align:left">${short(d.gateReason, 80)}</div>` : ''}</td>
          <td>${d.status === 'queued' || d.status === 'drafting' ? html`<button data-write type="button" class="danger" data-draft-drop="${d.id}" style="padding:3px 6px;font-size: var(--t-micro)">DROP</button>` : ''}</td>
        </tr>`)
      : html`<tr><td colspan="9" class="empty">NO DRAFTS</td></tr>`);
  }

  // 7 · exclusions -----------------------------------------------------------
  async function loadDreams() {
    const r = await api('/api/arcs/dreams', opt());
    if (!ctx.alive()) return;
    const rows = list(r?.dreams);
    setSlot(root, 'm-dream-count', rows.length ? `${rows.length} REMEMBERED` : 'NONE YET');
    const dream = (d) => dreamCard({ night: fmtWhen(d.at), tone: d.tone, vivid: d.vivid, text: d.text, scenes: d.text ? [] : list(d.scenes) });
    setSlot(root, 'm-dreams', rows.length
      ? html`${rows.slice(0, DREAMS_SHOWN).map(dream)}${rows.length > DREAMS_SHOWN
        ? html`<details class="subfold m-older"><summary class="mono">OLDER DREAMS · ${rows.length - DREAMS_SHOWN}</summary><div class="m-older-body">${rows.slice(DREAMS_SHOWN).map(dream)}</div></details>` : ''}`
      : html`<span class="mute mono" style="font-size: var(--t-meta)">▸ most nights he remembers nothing. A dream he does remember shows here.</span>`);
  }

  const CITED_WORDS = { self: 'HIS OWN DAY', group: 'A GROUP', dm: 'A DM', call: 'A CALL', ig: 'INSTAGRAM' };
  const citedWords = (kinds) => (Array.isArray(kinds) && kinds.length ? `CITES ${kinds.map((k) => CITED_WORDS[k] ?? 'ELSEWHERE').join(' · ')}` : '');

  async function loadStances() {
    const r = await api('/api/mind/stances', opt());
    if (!ctx.alive()) return;
    const rows = list(r?.stances);
    const proposed = rows.filter((x) => x.status === 'proposed');
    const oneClick = proposed.filter((x) => !x.free);   // a free topic always takes its own click
    setSlot(root, 'm-stance-count', rows.length ? `${r.counts?.active ?? 0} ACTIVE · ${proposed.length} WAITING` : 'NONE YET');
    setSlot(root, 'm-stance-actions', html`
      ${rows.length ? '' : html`<button data-write type="button" class="primary" data-stance-seed="1">DRAFT A STARTING SET</button>`}
      ${oneClick.length ? html`<button data-write type="button" class="primary" data-stance-approve-all="1">APPROVE ALL ${oneClick.length}</button>` : ''}`);
    // What waits for you first, its buttons on its own row; then what he holds, strongest first; what's set aside folds away.
    const row = (x) => html`${stanceRow({ topic: x.label, kind: x.kind, value: x.value, trend: x.trend, confidence: x.confidence, pinned: x.pinned, whyId: x.id })}
      ${x.free && x.why ? html`<p class="m-st-why">${x.why}</p>` : ''}`;
    const active = rows.filter((x) => x.status === 'active').sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const aside = rows.filter((x) => x.status === 'archived');
    setSlot(root, 'm-stances', rows.length
      ? html`${proposed.length ? html`<section class="m-st-group is-waiting"><div class="story-sub mono">WAITING FOR YOU · ${proposed.length}</div>${proposed.map((x) => html`<div class="m-st-wait">
            ${row(x)}
            ${x.free ? html`<div class="m-st-from"><span class="chip">SOMETHING HE CAME ACROSS</span> <span class="mono m-st-cites${list(x.citedFrom).some((k) => k !== 'self') ? ' is-chat' : ''}">${citedWords(x.citedFrom)}</span></div>` : ''}
            <div class="m-st-acts"><button data-write type="button" data-stance-approve="${x.id}">APPROVE</button><button data-write type="button" data-stance-reject="${x.id}">REJECT</button></div>
          </div>`)}</section>` : ''}
        ${active.length ? html`<section class="m-st-group"><div class="story-sub mono">WHAT HE HOLDS · ${active.length}</div>${active.map(row)}</section>` : ''}
        ${aside.length ? html`<details class="subfold m-older"><summary class="mono">SET ASIDE · ${aside.length} · NO LONGER IN HIS LIFE</summary><div class="m-older-body">${aside.map(row)}</div></details>` : ''}`
      : html`<span class="mute mono" style="font-size: var(--t-meta)">▸ nothing yet. A starting set is one mind call over who he is; nothing reads it until you approve it.</span>`);
  }

  async function showStance(id) {
    const r = await api(`/api/mind/stances/${encodeURIComponent(id)}/why`, opt());
    if (!ctx.alive()) return;
    const content = html`<div class="stance-why" style="display:grid;gap:10px">
      <div class="mono" style="font-size: var(--t-meta)">${r.kind === 'opinion' ? 'OPINION' : 'INTEREST'} · NOW ${r.value.toFixed(2)} · RETURNS TO ${r.anchor.toFixed(2)} · SURE ${Math.round(r.confidence * 100)}%</div>
      ${r.startedAs ? html`<p style="margin:0">${r.startedAs}</p>` : ''}
      ${list(r.lines).length
    ? html`<ul style="margin:0;padding-left:18px">${r.lines.map((l) => html`<li>${l.direction === 'up' ? '↑' : l.direction === 'down' ? '↓' : '→'} ${l.words}${l.count > 1 ? html` <span class="mute">× ${l.count}</span>` : ''}</li>`)}</ul>`
    : html`<span class="mute">Nothing he lived has moved this yet.</span>`}
      <form data-stance-anchor-form style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <label class="mono" style="font-size: var(--t-meta)">RETURNS TO <input type="number" name="anchor" step="0.05" min="${r.kind === 'opinion' ? -1 : 0}" max="1" value="${r.anchor}" required inputmode="decimal" class="m-anchor" /></label>
        <button data-write type="submit">SET</button>
      </form>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-write type="button" data-stance-pin="1">${r.pinned ? 'UNPIN' : 'PIN'}</button>
        <button data-write type="button" data-stance-reset="1">RESET</button>
      </div>
    </div>`;
    const sheet = openSheet({ label: r.label, content });
    const box = sheet.body;
    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = String(new FormData(e.target).get('anchor') ?? '').trim();
      if (raw === '') { flash('SAY WHERE IT RETURNS TO', 'bad'); return; }   // blank would read as 0
      const n = Number(raw);
      await act(`/api/mind/stances/${encodeURIComponent(id)}/anchor`, 'PUT', { anchor: n }, 'ANCHOR SET', [loadStances]);
      sheet.close();
    });
    box.addEventListener('click', async (e) => {
      const b = e.target instanceof Element ? e.target.closest('button') : null;
      if (!b) return;
      if (b.dataset.stancePin) {
        await act(`/api/mind/stances/${encodeURIComponent(id)}/pin`, 'POST', { pinned: !r.pinned }, r.pinned ? 'UNPINNED' : 'PINNED', [loadStances]);
        sheet.close();
      } else if (b.dataset.stanceReset) {
        sheet.close();
        if (!await ask('Reset this', 'Back to where he returns to, and forget what moved it.', 'RESET', true) || !ctx.alive()) return;
        await act(`/api/mind/stances/${encodeURIComponent(id)}/reset`, 'POST', {}, 'RESET', [loadStances]);
      }
    });
  }

  async function loadExclusions() {
    const ex = await api('/api/mind/exclusions', opt());
    if (!ctx.alive()) return;
    const box = $(root, '#mExcludeAll');
    if (box) box.checked = !!ex?.excludeAll;
    const rows = list(ex?.rows);
    setSlot(root, 'm-excl', rows.length
      ? rows.map((x) => html`<tr>
          <td class="mono"><span class="chip">${x.kind}</span></td>
          <td>${x.name || nameOf(x.jid) || x.jid} <span class="mute mono" style="font-size: var(--t-label)">${x.jid}</span></td>
          <td><span class="chip ${x.source === 'detected' ? 'warn' : x.source === 'owner_cleared' ? '' : 'ok'}">${x.source}</span></td>
          <td class="num">${typeof x.p === 'number' ? fmtNum(x.p, 2) : x.source === 'detected' ? 'n/a' : '—'}</td>
          <td>${x.note || html`<span class="mute">—</span>`}</td>
          <td class="mono">${when(x.createdAt)}</td>
          <td>${x.source === 'owner_cleared' ? '' : html`<button data-write type="button" data-excl-remove="${x.id}" style="padding:3px 6px;font-size: var(--t-micro)">${x.source === 'detected' ? 'DISMISS' : 'REMOVE'}</button>`}</td>
        </tr>`)
      : html`<tr><td colspan="7" class="empty">NO EXCLUSIONS</td></tr>`);
  }

  // chats for the pickers and names in tables
  async function loadChats() {
    const [groups, people] = await Promise.all([
      api('/api/groups', opt()).catch(() => []),
      api('/api/people?limit=200', opt()).catch(() => []),
    ]);
    if (!ctx.alive()) return;
    const gs = list(groups).filter((g) => g?.jid);
    const ps = list(people).filter((p) => p?.jid);
    for (const g of gs) names.set(g.jid, g.name || g.jid);
    for (const p of ps) names.set(p.jid, p.realName || p.pushName || p.jid);
    const options = html`
      <optgroup label="Groups">${gs.map((g) => html`<option value="group|${g.jid}">${g.name || g.jid}</option>`)}</optgroup>
      <optgroup label="People (DM)">${ps.map((p) => html`<option value="person|${p.jid}">${p.realName || p.pushName || p.jid}</option>`)}</optgroup>`;
    const asSel = $(root, '#mAsChat');
    if (asSel) {
      render(asSel, html`<option value="">— everything, unfiltered —</option>
        <optgroup label="Groups">${gs.map((g) => html`<option value="${g.jid}">${g.name || g.jid}</option>`)}</optgroup>
        <optgroup label="People (DM)">${ps.map((p) => html`<option value="${p.jid}">${p.realName || p.pushName || p.jid}</option>`)}</optgroup>`);
    }
    const target = $(root, '#mExclAdd select');
    if (target) render(target, html`<option value="">— pick a chat —</option>${options}`);
  }

  const safe = (fn) => async (...a) => {
    try { await fn(...a); } catch (err) { if (!isAbort(err) && ctx.alive()) flash(err.message, 'bad', 6000); }
  };

  const ask = async (label, text, action, danger = false) => (await askSheet({ label, text, action, danger })).ok;

  // events -----------------------------------------------------------------
  ctx.listen(root, 'change', (e) => {
    const id = e.target?.id;
    if (id === 'mAsChat') safe(loadSelfState)();
    else if (id === 'mRunKind') { runsBefore = null; safe(loadRuns)(); }
    else if (id === 'mProStatus') safe(loadDrafts)();
    else if (id === 'mFunAb') {
      const on = !!e.target.checked;
      const box = e.target;
      (async () => {
        if (on) {
          box.checked = false; // on only once it's confirmed
          if (!await ask('Fun A/B', `Turn on fun A/B? It ${FUN_AB_NOTE}.`, 'TURN ON') || !ctx.alive()) return;
          box.checked = true;
        }
        try {
          const r = await send('/api/config', 'PATCH', { 'mind.funAb': on });
          if (!ctx.alive()) return;
          if (r?.rejected && r.rejected['mind.funAb']) throw new Error(`refused · ${r.rejected['mind.funAb']}`);
          flash(on ? 'FUN A/B ON (in memory; persist on Settings)' : 'FUN A/B OFF');
        } catch (err) {
          if (!isAbort(err) && ctx.alive()) { flash(err.message, 'bad', 6000); e.target.checked = !on; }
        }
      })();
    } else if (id === 'mExcludeAll') {
      const on = !!e.target.checked;
      const box = e.target;
      (async () => {
        if (on) {
          box.checked = false;
          if (!await ask('Exclude everyone', 'No proactive message goes to anyone, and queued ones are cancelled.', 'EXCLUDE EVERYONE', true) || !ctx.alive()) return;
          box.checked = true;
        }
        act('/api/mind/exclusions/global', 'POST', { excludeAll: on }, on ? 'EVERYONE EXCLUDED' : 'GLOBAL EXCLUSION OFF', [loadExclusions, loadDrafts]);
      })();
    }
  });

  ctx.listen(root, 'input', (e) => { if (e.target?.closest?.('#mSmEdit')) countChars(); });

  ctx.listen(root, 'submit', async (e) => {
    const form = e.target;
    if (form?.id === 'mSmEdit') {
      e.preventDefault();
      const text = form.text.value;
      if (text.length > 1500) { flash('At most 1500 characters', 'bad'); return; }
      if (!await ask('Save the self-model', 'Replace the active self-model with this text?', 'REPLACE') || !ctx.alive()) return;
      form.text.blur();
      await act('/api/mind/self-model', 'PUT', { text }, 'SELF-MODEL SAVED', [loadSelfModel]);
    } else if (form?.id === 'mBands') {
      e.preventDefault();
      let bands;
      try { bands = JSON.parse(form.bands.value); } catch { flash('Bands must be valid JSON', 'bad'); return; }
      form.bands.blur();
      await act('/api/mind/bands', 'PUT', bands, 'BANDS SAVED', [loadBands, loadNudges]);
    } else if (form?.id === 'mExclAdd') {
      e.preventDefault();
      const [kind, jid] = String(form.chat.value || '').split('|');
      if (!kind || !jid) { flash('Pick a chat', 'bad'); return; }
      const note = form.note.value.trim();
      const r = await act('/api/mind/exclusions', 'POST', { kind, jid, ...(note ? { note } : {}) }, 'EXCLUDED', [loadExclusions, loadDrafts]);
      if (r && ctx.alive()) form.reset();
    }
  });

  ctx.listen(root, 'click', async (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const row = el?.closest('tr[data-run]');
    if (row && !el.closest('button')) { safe(showRun)(row.dataset.run); return; }
    const btn = el?.closest('button');
    if (!btn) return;
    const d = btn.dataset;
    if (btn.id === 'mPause') {
      const pausing = !status?.paused;
      if (pausing && (!await ask('Pause the mind', 'Queued proactive sends are cancelled.', 'PAUSE', true) || !ctx.alive())) return;
      await act('/api/mind/pause', 'POST', { paused: pausing }, pausing ? 'MIND PAUSED' : 'MIND RESUMED', [loadDrafts]);
    } else if (btn.id === 'mThinkNow') {
      btn.disabled = true;
      const r = await act('/api/mind/run', 'POST', { kind: 'think' }, 'THINK QUEUED', [() => loadRuns()]);
      if (ctx.alive()) btn.disabled = false;
      if (r?.status && ctx.alive()) flash(`THINK · ${r.status}`);
    } else if (btn.id === 'mRunsOlder') {
      safe(loadRuns)({ older: true });
    } else if (d.reviewExtend) {
      await act('/api/mind/review', 'POST', { extendDays: Number(d.reviewExtend) }, 'REVIEW WINDOW EXTENDED');
    } else if (d.reviewMode) {
      const mode = d.reviewMode;
      if (mode === 'auto' && (!await ask('Auto-apply', 'Let the mind apply valid self-model proposals on its own (at most once every 3 days)?', 'AUTO-APPLY') || !ctx.alive())) return;
      await act('/api/mind/review', 'POST', { mode }, `REVIEW · ${mode.toUpperCase()}`);
    } else if (d.mode) {
      const mode = d.mode;
      if (mode === 'live') {
        if (!status?.ownerJidsSet) { flash('OWNER_JIDS is not set in .env: live mode is refused', 'bad', 6000); return; }
        if (!await ask('Go live', 'Go LIVE? The mind will send real proactive messages to people and groups (within the caps and exclusions). Shadow drafts stop being shadow.', 'GO LIVE', true) || !ctx.alive()) return;
        await act('/api/mind/proactive/mode', 'POST', { mode: 'live', confirm: true }, 'PROACTIVE · LIVE', [loadDrafts]);
      } else {
        await act('/api/mind/proactive/mode', 'POST', { mode }, `PROACTIVE · ${mode.toUpperCase()}`, [loadDrafts]);
      }
    } else if (d.draftDrop) {
      await act(`/api/mind/proactive/${encodeURIComponent(d.draftDrop)}/drop`, 'POST', {}, 'DRAFT DROPPED', [loadDrafts]);
    } else if (d.smApprove) {
      if (!await ask('Approve the proposal', 'Activate this self-model proposal now?', 'APPROVE') || !ctx.alive()) return;
      await act(`/api/mind/self-model/${encodeURIComponent(d.smApprove)}/approve`, 'POST', {}, 'PROPOSAL APPROVED', [loadSelfModel]);
    } else if (d.smReject) {
      const { ok, reason } = await askSheet({ label: 'Reject the proposal', text: 'It won\'t become part of the self-model.', action: 'REJECT', danger: true, reasonLabel: 'Reason (optional)', reasonMax: 200 });
      if (!ok || !ctx.alive()) return;
      await act(`/api/mind/self-model/${encodeURIComponent(d.smReject)}/reject`, 'POST', reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}, 'PROPOSAL REJECTED', [loadSelfModel]);
    } else if (d.smRevert) {
      if (!await ask('Back to this version', 'Make a new active version from this one? Its text goes through the owner-edit scrub first.', 'MAKE ACTIVE') || !ctx.alive()) return;
      await act(`/api/mind/self-model/${encodeURIComponent(d.smRevert)}/revert`, 'POST', {}, 'REVERTED', [loadSelfModel]);
    } else if (d.nudgeRevert) {
      await act(`/api/mind/nudges/${encodeURIComponent(d.nudgeRevert)}/revert`, 'POST', {}, 'NUDGE REVERTED', [loadNudges]);
    } else if (d.why !== undefined && btn.classList.contains('v-stance-why')) {
      safe(showStance)(d.why);
    } else if (d.stanceSeed) {
      btn.disabled = true;
      await act('/api/mind/stances/seed', 'POST', {}, 'STARTING SET DRAFTED', [loadStances]);
      if (ctx.alive()) btn.disabled = false;
    } else if (d.stanceApproveAll) {
      if (!await ask('Approve the starting set', 'These start shaping his days, his picks and his replies.', 'APPROVE') || !ctx.alive()) return;
      await act('/api/mind/stances/approve', 'POST', {}, 'APPROVED', [loadStances]);
    } else if (d.stanceApprove) {
      await act('/api/mind/stances/approve', 'POST', { ids: [Number(d.stanceApprove)] }, 'APPROVED', [loadStances]);
    } else if (d.stanceReject) {
      await act(`/api/mind/stances/${encodeURIComponent(d.stanceReject)}/reject`, 'POST', {}, 'REJECTED', [loadStances]);
    } else if (d.exclRemove) {
      await act(`/api/mind/exclusions/${encodeURIComponent(d.exclRemove)}`, 'DELETE', undefined, 'EXCLUSION REMOVED', [loadExclusions]);
    }
  });

  // boot ---------------------------------------------------------------------
  try {
    await loadStatus();
  } catch (err) {
    if (isAbort(err) || !ctx.alive()) return;
    showError(root, err);
    return;
  }
  await safe(loadChats)();
  if (!ctx.alive()) return;
  await Promise.all([
    safe(loadSelfState)(), safe(loadRuns)(), safe(loadDigests)(), safe(loadEpisodes)(), safe(loadSelfModel)(),
    safe(loadNudges)(), safe(loadBands)(), safe(loadDrafts)(), safe(loadExclusions)(), safe(loadStances)(), safe(loadDreams)(),
  ]);
  ctx.setInterval(() => { safe(loadStatus)(); }, POLL_MS);
}
