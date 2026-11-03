// LIFE · NOW (spec 009 T037) — vitals, availability, the phone queue by chat,
// the next plan blocks with his plans of the next 12 h merged in (across
// midnight: a 00:15 outing shows at 22:00 even before his plan holds it), the current thought (template line, no LLM), open
// decisions with their mode, flagged claims with dismiss, "check phone now",
// the world source badge and (spec 012) what chats did to his day — mood blips,
// tonight's sleep push, the work flag, each revertible. Polls /api/life/now and
// /api/influence/now every 30 s (no SSE topic).
//
// Every string from the world file or the log (places, cast, claim text) is
// untrusted: it only ever reaches the DOM through html`` / setSlots (escaped).
// Writes are owner operations; with the dashboard read-only the buttons are
// disabled and the server answers 403 anyway.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, slotPainter, $ } from '../core/dom.js';
import { fmtHm, fmtRelative, fmtInt, decidedAhead, fmtDay, fmtWhen } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { showError } from '../components/ui.js';
import { getStatus } from '../components/topbar.js';
import { alertRow, initFolds, liveLine, stream, toldRows } from '../components/views.js';

const POLL_MS = 30_000;

/** Availability state → chip class (shared by the Life pages). */
export const AVAIL_CLASS = { free: 'ok', light: 'ok', busy: 'warn', meeting: 'warn', dnd: 'bad', asleep: '' };
export const AVAIL_STATES = ['free', 'light', 'busy', 'meeting', 'dnd', 'asleep'];

export function availChip(state) {
  if (!state) return html`<span class="chip">—</span>`;
  return html`<span class="chip life-av life-av-${state} ${AVAIL_CLASS[state] ?? ''}">${String(state).toUpperCase()}</span>`;
}

/** Shown on every Life page while the engine is not running. */
export function offNote(skillOn) {
  return html`<div class="panel life-off"><div class="panel-body">
    <b class="amber">LIFE IS NOT RUNNING</b>
    <p class="mute">${skillOn
      ? 'The life skill is on, but the engine has not started in this process yet (it starts within a minute of the skill being switched on).'
      : 'Switch the "life" skill on in the Skills tab (LIFE_ENABLED is only its boot default). Until then the bot answers as before: sleep hours, delayed read receipts, no availability gate.'}</p>
  </div></div>`;
}

export const readOnly = () => getStatus()?.readOnly !== false;

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · NOW · HIS DAY ON THE REAL CLOCK</div>
    <h1>Now</h1>
  </div>
  <div class="meta">
    <span>WORLD <b data-slot="ln-world">—</b></span>
    <span>LIFE TIME <b data-slot="ln-at">—</b></span>
    <span>FLAGGED <b class="amber" data-slot="ln-flagged">—</b></span>
  </div>
</div>
<div data-slot="ln-off"></div>
<div data-slot="ln-embargo"></div>
<div data-slot="ln-live"></div>


<div class="panel ln-holes">
  <div class="panel-head"><span>PLOT HOLES<button type="button" class="guide-q" data-guide="alerts" aria-label="Guide: plot holes">?</button></span><span class="mono mute" data-slot="ln-alerts-note">—</span></div>
  <div data-slot="ln-alerts"></div>
  <div class="panel-body ln-sweep"><button type="button" data-write id="lnAlertsRun">SWEEP NOW</button></div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>AVAILABILITY</span></div><div class="val mono" data-slot="ln-avail">—</div><div class="sub" data-slot="ln-avail-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>DOING</span></div><div class="val mono life-val-sm" data-slot="ln-act">—</div><div class="sub" data-slot="ln-act-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>PHONE</span></div><div class="val mono life-val-sm" data-slot="ln-phone">—</div><div class="sub" data-slot="ln-phone-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>QUEUED</span></div><div class="val mono" data-slot="ln-queued">—</div><div class="sub" data-slot="ln-queued-sub">—</div></div>
</div>

<div class="ln-grid">
  <div class="ln-col">
    <div class="panel">
    <div class="panel-head"><span>CURRENT THOUGHT<button type="button" class="guide-q" data-guide="thought" aria-label="Guide: thought">?</button></span><span class="mono mute">TEMPLATE · NO LLM</span></div>
    <div class="panel-body"><p class="life-thought" data-slot="ln-thought">—</p></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>ON HIS MIND<button type="button" class="guide-q" data-guide="thoughts" aria-label="Guide: on his mind">?</button></span><span class="mono mute" data-slot="ln-th-note">—</span></div>
  <div data-slot="ln-th-real"></div>
  <div data-slot="ln-th"></div>
    </div>
    <div class="panel">
    <div class="panel-head"><span>NEXT BLOCKS<button type="button" class="guide-q" data-guide="next" aria-label="Guide: next">?</button></span><span class="mono mute" data-slot="ln-plan-date"></span></div>
    <div class="table-wrap"><table class="data no-cards ln-next">
      <thead><tr><th>FROM</th><th>TO</th><th>WHAT</th><th>WHERE</th><th>AVAIL</th></tr></thead>
      <tbody data-slot="ln-next"><tr><td colspan="5" class="loading">LOADING</td></tr></tbody>
    </table></div>
    </div>
  </div>
  <div class="ln-col">
    <div class="panel">
    <div class="panel-head"><span>VITALS<button type="button" class="guide-q" data-guide="vitals" aria-label="Guide: vitals">?</button></span><span class="mono mute" data-slot="ln-sick"></span></div>
    <div class="panel-body ln-vitals" data-slot="ln-vitals"></div>
    </div>
    <div class="panel">
    <div class="panel-head"><span>PHONE QUEUE · BY CHAT<button type="button" class="guide-q" data-guide="queue" aria-label="Guide: queue">?</button></span>
      <span style="display:flex;gap:8px;align-items:center"><span class="mono mute" style="font-size: var(--t-label)" data-slot="ln-check-note"></span><button type="button" class="primary" id="lnCheckPhone">CHECK PHONE NOW</button></span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>CHAT</th><th>WAITING</th><th>OLDEST</th><th>MENTIONS</th></tr></thead>
      <tbody data-slot="ln-queue"></tbody>
    </table></div>
    </div>
  </div>
</div>

<div class="panel ln-wide">
  <details class="fold-in" data-fold="now.decisions" data-wide-open><summary class="panel-head"><span>DECISIONS · OPEN + LAST 24 H<button type="button" class="guide-q" data-guide="decisions" aria-label="Guide: decisions">?</button></span><span class="mono mute" data-slot="ln-decisions-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>#</th><th>WHAT</th><th>STATUS</th><th>LEAN / CHOSEN</th><th>DECIDE BY</th><th>MODE</th></tr></thead>
    <tbody data-slot="ln-decisions"></tbody>
  </table></div>
  </details>
  </div>

<div class="panel">
  <details class="fold-in" data-fold="now.commitments" data-wide-open><summary class="panel-head"><span>HIS COMMITMENTS · WHAT HE SAID HE'D DO<button type="button" class="guide-q" data-guide="commitments" aria-label="Guide: commitments">?</button></span><span class="mono mute" data-slot="ln-com-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="table-wrap"><table class="data no-cards ln-com-table">
    <thead><tr><th>STATUS</th><th>WHO</th><th>WHAT</th><th>WHEN</th><th>FROM</th></tr></thead>
    <tbody data-slot="ln-com"></tbody>
  </table></div>
  </details>
</div>
<div class="ln-pair">
  <div class="panel">
    <details class="fold-in" data-fold="now.claims" data-wide-open><summary class="panel-head"><span>FLAGGED CLAIMS · WHAT HE SAID ABOUT HIS LIFE<button type="button" class="guide-q" data-guide="claims" aria-label="Guide: claims">?</button></span><span class="mono mute" data-slot="ln-claims-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div data-slot="ln-claims"></div>
  </details>
  </div>
  <div class="panel">
    <details class="fold-in" data-fold="now.chats" data-wide-open><summary class="panel-head"><span>CHATS ON HIS DAY<button type="button" class="guide-q" data-guide="influence" aria-label="Guide: influence">?</button></span><span class="mono mute" data-slot="ln-inf-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body" data-slot="ln-inf-summary"></div>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>WHAT</th><th>CHAT</th><th>WHEN</th><th>LEFT</th><th></th></tr></thead>
    <tbody data-slot="ln-inf"></tbody>
  </table></div>
  </details>
  </div>
</div>
`);

/** The live outing's line (plan 020 C2), or nothing while he isn't on one. */
export function liveStrip(v) {
  if (!v?.active || !v.line) return null;
  const meta = v.mode === 'full'
    ? [v.phaseWords, v.minutesLeft ? `${v.minutesLeft} min left` : null, v.them?.[0] ? `${v.them.length > 1 ? 'they' : v.them[0].name}: ${v.them[0].mood}` : null,
      v.attention ? `attention ${v.attention.band}` : null, v.private ? 'private' : null].filter(Boolean).join(' · ')
    : '';
  return html`${liveLine({ at: v.line.at, parts: v.line.parts })}${meta ? html`<div class="mono mute ln-live-meta">${meta.toUpperCase()}</div>` : ''}`;
}

/** Real thoughts (plan 020 F3) in the kit's two columns, newest first. Nothing while there are none: the stream says enough. */
export function realThoughtRows(t) {
  return toldRows((t?.real ?? []).map((x) => ({ ...x, at: fmtHm(x.at) })));
}

/** The thought stream's rows (plan 020 F2) in the kit's stream. Text is escaped by html``. */
export function thoughtRows(t, { empty = 'NOTHING ON HIS MIND YET' } = {}) {
  return stream((t?.thoughts ?? []).map((x) => ({ at: fmtHm(x.at), kind: x.kind, text: x.text, note: x.fromChat ? 'from a chat' : null })).reverse(), { empty });
}

const VITALS = [
  ['ENERGY', (v) => v.energy, 0, 100],
  ['STRESS', (v) => v.stress, 0, 100],
  ['HUNGER', (v) => v.hunger, 0, 100],
  ['SOCIAL BATT.', (v) => v.socialBattery, 0, 100],
  ['WORK PRESSURE', (v) => v.workPressure, 0, 100],
  ['SLEEP DEBT h', (v) => v.sleepDebt, 0, 20],
  ['MOOD', (v) => v.mood?.valence, -1, 1],
  ['AROUSAL', (v) => v.mood?.arousal, 0, 1],
];

function vitalsView(v) {
  if (!v) return html`<div class="empty">NO VITALS</div>`;
  return html`${VITALS.map(([label, get, lo, hi]) => {
    const n = get(v);
    const ok = typeof n === 'number' && Number.isFinite(n);
    const pct = ok ? Math.max(0, Math.min(100, Math.round(((n - lo) / (hi - lo)) * 100))) : 0;
    const shown = ok ? (hi <= 1 ? n.toFixed(2) : hi <= 20 ? n.toFixed(1) : Math.round(n)) : '—';
    return html`<div class="factor-bar"><span class="label">${label}</span><span class="track"><span class="f life-f" style="width:${pct}%"></span></span><span class="num">${shown}</span></div>`;
  })}
  <div class="factor-bar"><span class="label">MONEY</span><span class="mono">${fmtInt(v.money)}</span><span></span></div>`;
}

const signed = (n, digits) => (typeof n === 'number' && Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(digits)}` : '—');

const SEVERITY_CHIP = { high: 'bad', warn: 'warn', info: '' };

/** The header note of the PLOT HOLES panel (020 E1). */
export function alertsNote(a) {
  if (!a?.running) return 'LIFE NOT RUNNING';
  const last = a.lastRunAt ? `LAST SWEEP ${fmtWhen(a.lastRunAt)}` : 'NO SWEEP YET';
  return `${last}${a.corrupt ? ' · STORED FINDINGS WERE UNREADABLE, REBUILT AT THE NEXT SWEEP' : ''}${a.ruleErrors?.length ? ` · ${a.ruleErrors.length} RULE(S) FAILED` : ''}`;
}

/** One row per finding: when, what in plain words, DISMISS. Text goes through html`` (escaped). */
export function alertRows(a, ro) {
  const rows = a?.findings || [];
  if (!rows.length) return html`<div class="empty ln-noholes">NO PLOT HOLES FOUND</div>`;
  return html`<div class="v-alerts">${rows.map((f) => alertRow({
    severity: f.severity,
    title: f.text,
    detail: `${String(f.rule || '').replace(/_/g, ' ').toUpperCase()}${f.eventIds?.length ? ` · EVENTS ${f.eventIds.join(', ')}` : ''}`,
    at: f.at ? fmtWhen(f.at) : null,
    action: html`<button type="button" class="ln-alert-dismiss" data-write data-fp="${f.fp}" ${ro ? raw('disabled') : ''} aria-label="Dismiss this finding">DISMISS</button>`,
  }))}</div>`;
}

const COMMITMENT_STATUS = { overdue: ['OVERDUE', 'bad'], no_plan: ['NO PLAN', 'warn'], open: ['OPEN', 'warn'], on: ['ON', 'ok'], kept: ['KEPT', ''], broken: ['BACKED OUT', 'warn'], lapsed: ['FELL THROUGH', ''] };
const COMMITMENT_SOURCE = { decision: 'HIS PLAN', invitation: 'INVITATION', claim: 'SAID IN A CHAT', goal: 'A GOAL', text: 'TEXTS' };
const COMMITMENT_WEIGHT = { 3: 'OWNER', 2: 'PROMISE', 1: 'WISH' };

/** The header note of HIS COMMITMENTS (020 D3). */
export function commitmentsNote(c) {
  if (!c?.running) return 'LIFE NOT RUNNING';
  if (c.failed) return 'COULD NOT READ THEM';
  const n = c.counts ?? {};
  const pressing = (n.overdue ?? 0) + (n.no_plan ?? 0);
  return `${n.on ?? 0} ON${n.open ? ` · ${n.open} OPEN` : ''}${pressing ? ` · ${pressing} TO LOOK AT` : ''}`;
}

/** One row per commitment. Who is a fictional name or "a friend", a chat's plan is unnamed. Text goes through html`` (escaped). */
export function commitmentRows(c) {
  const rows = c?.rows || [];
  if (!rows.length) return html`<tr><td colspan="5" class="empty">NOTHING HE'S SAID HE'D DO RIGHT NOW</td></tr>`;
  return rows.map((r) => {
    const [word, tone] = COMMITMENT_STATUS[r.status] ?? [String(r.status || '—').toUpperCase(), ''];
    const past = r.status === 'kept' || r.status === 'broken' || r.status === 'lapsed';
    return html`<tr class="${past ? 'is-past' : ''}">
      <td class="c-status"><span class="chip ${tone}">${word}</span></td>
      <td class="c-who">${r.who || html`<span class="mute">—</span>`}</td>
      <td class="c-what">${r.what}${r.code ? html`<div class="mute mono">${String(r.code).replace(/_/g, ' ')}</div>` : ''}</td>
      <td class="c-when mono">${r.when ? fmtWhen(r.when) : html`<span class="mute">—</span>`}</td>
      <td class="c-from mono">${COMMITMENT_SOURCE[r.source] ?? r.source}${r.weight ? html`<span class="mute c-weight"> ${COMMITMENT_WEIGHT[r.weight] ?? ''}</span>` : ''}</td>
    </tr>`;
  });
}

function influenceNote(inf) {
  if (!inf?.running) return 'LIFE NOT RUNNING';
  if (!inf.skill) return 'SKILL OFF · NO CHAT CHANGES HIS DAY';
  if (inf.degraded) return 'DEGRADED · A DELETION IS STILL BEING APPLIED · INFLUENCE PAUSED';
  const on = Object.entries(inf.on || {}).filter(([, v]) => v).map(([k]) => k.toUpperCase());
  return on.length ? `ON · ${on.join(' · ')}` : 'ON · EVERY AREA SWITCHED OFF';
}

function influenceSummary(inf) {
  if (!inf?.running || !inf.skill) return html`<span class="mute">Nothing a chat says changes his life while the "chat-influence" skill is off.</span>`;
  const o = inf.overlay;
  return html`<div class="mono" style="font-size:11px">
    MOOD NOW <b>${o ? signed(o.valence, 3) : '±0'}</b> · STRESS <b>${o ? signed(o.stress, 1) : '±0'}</b> · SOCIAL <b>${o ? signed(o.social, 1) : '±0'}</b>
    · PERCEIVED TODAY <b>${inf.caps ? `${fmtInt(inf.caps.jevToday)} / ${fmtInt(inf.caps.jevMaxPerDay)}` : '—'}</b>${inf.caps && !inf.caps.ledgerOk ? html` <span class="amber">USAGE LOG UNREADABLE · CAPPED</span>` : ''}
    · WORK <b>${inf.workBehindToday ? 'FELL BEHIND TODAY' : 'ON TRACK'}</b>
  </div>${outcomesView(inf.perceptions)}`;
}

// Today's perception outcomes (codes and counts; no message, no name).
function outcomesView(p) {
  if (!p) return '';
  const reasons = Object.entries(p.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return html`<div class="mono" style="font-size:11px;margin-top:4px">
    OUTCOMES TODAY · APPLIED <b>${fmtInt(p.applied ?? 0)}</b> · HELD <b>${fmtInt(p.held ?? 0)}</b> · DROPPED <b>${fmtInt(p.dropped ?? 0)}</b> · NOTHING <b>${fmtInt(p.nothing ?? 0)}</b>
    ${reasons.length ? html`<span class="mute"> · ${reasons.map(([k, n]) => `${k.replace(/_/g, ' ').toUpperCase()} ${n}`).join(' · ')}</span>` : ''}
  </div>`;
}

function influenceRows(inf, ro) {
  const rows = [];
  const btn = (id, label) => html`<button type="button" class="ln-inf-revert" data-id="${id}" ${ro ? raw('disabled') : ''} aria-label="Revert event ${id}">${label}</button>`;
  if (inf?.sleep) {
    rows.push(html`<tr><td>SLEEP PUSHED <span class="mono mute">+${inf.sleep.totalMin} min</span></td><td>${inf.sleep.chatName || inf.sleep.chatJid || '—'}</td>
      <td class="mono">until ${fmtHm(inf.sleep.until)}</td><td class="mono">—</td><td>${inf.sleep.eventId ? btn(inf.sleep.eventId, 'REVERT') : ''}</td></tr>`);
  }
  for (const b of inf?.blips || []) {
    rows.push(html`<tr><td>${String(b.affect || 'mood').replace(/_/g, ' ').toUpperCase()}</td><td>${b.chatName || b.chatJid || '—'}</td>
      <td class="mono">${b.ageMin} min ago</td><td class="mono">${signed(b.valence, 3)}</td><td>${b.pointerId ? btn(b.pointerId, 'REVERT') : ''}</td></tr>`);
  }
  return rows.length ? rows : html`<tr><td colspan="5" class="empty">NOTHING FROM CHATS RIGHT NOW</td></tr>`;
}

const range = (a, b) => `${fmtHm(a)}–${b ? fmtHm(b) : '…'}`;

// A time on another day than `now` (past midnight) carries its day.
export const hmOrDay = (ts, now) => (ts && now && fmtDay(ts) !== fmtDay(now) ? fmtWhen(ts) : fmtHm(ts));

/**
 * NEXT BLOCKS: the plan's next blocks, with his plans of the next 12 h that the
 * blocks don't hold yet (a plan past midnight before tonight's plan fits it)
 * merged in by time. → [{ start, end, kind, place, availability, plan? }]
 */
export function nextRows(n) {
  const rows = (n?.next || []).map((b) => ({ ...b }));
  for (const u of n?.upcoming || []) {
    if (u.inPlan) continue;
    rows.push({ start: u.start, end: u.end, kind: u.label, place: u.place, availability: null, plan: { id: u.id, status: u.status, committed: u.committed } });
  }
  return rows.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

function decisionRow(d, ro, now) {
  const what = [d.kind, d.subject?.place, ...(d.subject?.cast || [])].filter(Boolean).join(' · ');
  // A committed plan still ahead says so plainly: it has not happened yet.
  const ahead = d.status === 'committed' && d.committed ? decidedAhead(d.committed.label, d.subject?.eventAt, now) : '';
  const leanTxt = ahead
    ? html`<b class="green">${ahead}</b>`
    : d.committed
    ? html`<b class="green">${d.committed.label}</b>`
    : d.lean ? html`${d.lean.label} <span class="mute mono">${typeof d.lean.p === 'number' ? `p ${d.lean.p.toFixed(2)}` : ''}</span>` : html`<span class="mute">—</span>`;
  const open = d.status === 'open';
  return html`<tr>
    <td class="id">${d.id}</td>
    <td>${what || '—'}${d.subject?.eventAt ? html` <span class="mute mono">@ ${fmtHm(d.subject.eventAt)}</span>` : ''}</td>
    <td><span class="chip ${open ? 'warn' : d.status === 'committed' ? 'ok' : ''}">${String(d.status || '—').toUpperCase()}${ahead ? ' · NOT YET' : ''}</span></td>
    <td>${leanTxt}</td>
    <td class="mono">${d.decideBy ? fmtHm(d.decideBy) : '—'}</td>
    <td>${open
      ? html`<select class="ln-mode" data-id="${d.id}" aria-label="Mode for decision ${d.id}" ${ro ? raw('disabled') : ''}>
          <option value="auto" ${d.mode !== 'ask' ? raw('selected') : ''}>auto</option>
          <option value="ask" ${d.mode === 'ask' ? raw('selected') : ''}>ask</option>
        </select>`
      : html`<span class="mono mute">${d.mode || 'auto'}</span>`}</td>
  </tr>`;
}

function claimRow(c, ro) {
  return html`<div class="life-claim">
    <div class="mono mute">${fmtRelative(c.createdAt)} ago · ${String(c.kind || 'claim').toUpperCase()} · p ${typeof c.p === 'number' ? c.p.toFixed(2) : '—'} · ${c.originKind}</div>
    <div class="life-claim-text">${c.text}</div>
    <button type="button" class="ln-dismiss" data-id="${c.id}" ${ro ? raw('disabled') : ''} aria-label="Dismiss claim ${c.id}">DISMISS</button>
  </div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  initFolds(root);
  // A poll with nothing new touches nothing: an open mode picker stays open.
  const paintSlot = slotPainter(root);
  const setSlot = (_, key, tpl) => paintSlot(key, tpl);
  const ro = readOnly();
  const checkBtn = $(root, '#lnCheckPhone');
  let decisionsWaiting = null;
  let asleep = false;   // from the last /api/life/now (a check that is still running can't say yet)
  const phoneCheckMessage = (r) => {
    if (r?.skipped) return `PHONE CHECK SKIPPED · ${r.skipped}`;
    if (r?.started) return asleep ? 'PHONE CHECK STARTED · ASLEEP: READING ONLY, NO REPLIES' : 'PHONE CHECK STARTED · ON HIS PHONE';
    return r?.readOnly ? 'PHONE CHECKED · ASLEEP: READ ONLY, NOTHING ANSWERED (HE ANSWERS WHEN HE\'S UP)' : `PHONE CHECKED · ${r?.drained ?? 0} ANSWERED`;
  };
  if (checkBtn) {
    checkBtn.disabled = ro;
    if (ro) checkBtn.title = 'Dashboard is read-only (DASHBOARD_READONLY=true)';
  }

  async function loadLive() {
    let live = { active: false };
    try { live = await api('/api/life/live', { signal: ctx.signal }); } catch (e) { if (isAbort(e)) return; }
    if (ctx.alive()) setSlot(root, 'ln-live', liveStrip(live));
    let th = null;
    try { th = await api('/api/life/thoughts?limit=8', { signal: ctx.signal }); } catch (e) { if (isAbort(e)) return; }
    if (!ctx.alive()) return;
    setSlots(root, { 'ln-th-note': th?.running ? `${th.count ?? 0} TODAY` : '—' });
    setSlot(root, 'ln-th-real', realThoughtRows(th));
    initFolds($(root, '[data-slot="ln-th-real"]'));
    setSlot(root, 'ln-th', thoughtRows(th));
  }
  loadLive();
  ctx.setInterval(loadLive, 30000);

  async function load() {
    const [now, claims, arcs, inf, alerts, commitments] = await Promise.all([
      api('/api/life/now', { signal: ctx.signal }),
      api('/api/life/claims?status=flagged&limit=50', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { claims: [] }; }),
      api('/api/arcs/status', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { enabled: false }; }),
      api('/api/influence/now', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { running: false }; }),
      api('/api/life/alerts', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { running: false }; }),
      api('/api/life/commitments', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { running: false }; }),
    ]);
    if (!ctx.alive()) return;
    paint(now, claims?.claims || [], arcs || {});
    paintInfluence(inf || { running: false });
    paintAlerts(alerts || { running: false });
    setSlots(root, { 'ln-com-note': commitmentsNote(commitments) });
    // Folded on a phone: the head says when one needs a look.
    root.querySelector('[data-slot="ln-com-note"]')?.classList.toggle('amber', ((commitments?.counts?.overdue ?? 0) + (commitments?.counts?.no_plan ?? 0)) > 0);
    setSlot(root, 'ln-com', commitmentRows(commitments));
  }

  function paintAlerts(a) {
    setSlots(root, { 'ln-alerts-note': alertsNote(a) });
    setSlot(root, 'ln-alerts', alertRows(a, readOnly()));
    const run = $(root, '#lnAlertsRun');
    if (run) { run.disabled = readOnly() || !a?.running; if (readOnly()) run.title = 'Dashboard is read-only (DASHBOARD_READONLY=true)'; }
  }

  function paintInfluence(inf) {
    setSlots(root, { 'ln-inf-note': influenceNote(inf) });
    setSlot(root, 'ln-inf-summary', influenceSummary(inf));
    setSlot(root, 'ln-inf', influenceRows(inf, readOnly()));
  }

  function paint(n, claims, arcs) {
    const arcsOn = arcs.enabled === true;
    // With the story layer (arcs skill) on, flagged claims go to its reconciler and
    // an "ask" decision opens as an Ask-me card on Life · Pending; without it,
    // claims can only be dismissed and "ask" is just stored.
    setSlots(root, {
      'ln-claims-note': arcsOn ? `ARCS ON · RECONCILER ${String(arcs.reconcilerMode || 'auto').toUpperCase()} · TRAY ON LIFE · PENDING` : 'ARCS OFF · DISMISS ONLY',
      'ln-decisions-note': arcsOn ? 'MODE ask = ASK-ME CARD ON LIFE · PENDING' : 'MODE ask = STORED ONLY (ARCS OFF)',
    });
    setSlot(root, 'ln-off', !n.running ? offNote(n.skill) : !n.enabled
      ? html`<div class="panel life-off"><div class="panel-body"><b class="amber">SKILL OFF · ENGINE TICKING · GATE INACTIVE</b>
          <span class="mute">his day keeps running so it stays consistent, but replies, receipts and presence are back to normal until the "life" skill is switched on again.</span></div></div>`
      : null);
    setSlot(root, 'ln-embargo', n.embargo
      ? html`<div class="panel life-embargo"><div class="panel-body"><b class="red">QUIET DAY</b> <span class="mute">a heavy event is holding his tone low until ${fmtHm(n.embargo.until)} (embargo)</span></div></div>`
      : null);
    setSlots(root, {
      'ln-world': n.worldSource ? (n.worldSource === 'example' ? 'EXAMPLE' : String(n.worldSource).toUpperCase()) : '—',
      'ln-at': n.running ? fmtHm(n.at) : '—',
      'ln-flagged': n.claimsFlagged ?? 0,
    });
    const worldEl = $(root, '[data-slot="ln-world"]');
    if (worldEl) worldEl.className = n.worldSource === 'example' ? 'amber' : '';

    const a = n.availability;
    asleep = a?.state === 'asleep';
    // Before the click: a check while he's asleep only reads (no behaviour change, just said).
    setSlots(root, { 'ln-check-note': asleep ? 'ASLEEP · A CHECK NOW ONLY READS (BLUE TICKS), ANSWERS WHEN HE\'S UP' : '' });
    setSlot(root, 'ln-avail', a ? availChip(a.state) : '—');
    setSlots(root, {
      'ln-avail-sub': a ? `since ${fmtHm(a.since)}${a.until ? ` · until ${fmtHm(a.until)}` : ''}${a.onPhone ? ' · ON PHONE' : ''}` : '—',
      'ln-act': n.activity?.kind ? String(n.activity.kind).toUpperCase() : '—',
      'ln-act-sub': n.position?.travel
        ? `${n.position.travel.fromName || '?'} → ${n.position.travel.toName || '?'} · ${n.position.travel.mode || ''} · arrives ${fmtHm(n.position.travel.endAt)}`
        : n.activity?.kind ? `${n.activity.place || n.position?.place || 'somewhere'} · ${range(n.activity.startAt, n.activity.endAt)}${n.activity.withCast?.length ? ` · with ${n.activity.withCast.join(', ')}` : ''}` : '—',
      'ln-phone': n.phone ? (n.availability?.onPhone ? 'LOOKING' : n.phone.nextCheckAt ? `NEXT ${fmtHm(n.phone.nextCheckAt)}` : 'IDLE') : '—',
      'ln-phone-sub': n.phone?.lastCheckEndAt || n.phone?.lastCheckAt ? `last check ${fmtRelative(n.phone.lastCheckEndAt || n.phone.lastCheckAt)} ago` : 'no check yet',
    });
    const q = n.queue?.byChat || [];
    const total = q.reduce((s, c) => s + (c.count || 0), 0);
    setSlots(root, {
      'ln-queued': total,
      'ln-queued-sub': q.length ? `${q.length} chat${q.length === 1 ? '' : 's'} · oldest ${fmtRelative(Math.min(...q.map((c) => c.oldestAt || Infinity)))} ago` : 'nothing waiting',
      'ln-thought': n.thought || (n.running ? '—' : 'not running'),
      'ln-plan-date': n.next?.length || n.upcoming?.length ? `${n.next?.length ?? 0} AHEAD${n.upcoming?.length ? ` · ${n.upcoming.length} PLAN${n.upcoming.length === 1 ? '' : 'S'} IN 12 H` : ''}` : '',
      'ln-sick': n.vitals?.sick ? 'SICK' : '',
    });
    setSlot(root, 'ln-vitals', vitalsView(n.vitals));
    const next = nextRows(n);
    setSlot(root, 'ln-next', next.length
      ? next.map((b) => html`<tr><td class="mono">${hmOrDay(b.start, n.at)}</td><td class="mono">${b.end ? hmOrDay(b.end, n.at) : '—'}</td>
          <td>${b.plan ? html`<span class="chip ${b.plan.status === 'committed' ? 'ok' : 'warn'}">PLAN · ${String(b.plan.committed || b.plan.status || '').toUpperCase()}</span> ` : ''}${b.kind}</td>
          <td>${b.place || '—'}</td><td>${b.plan ? html`<span class="mute mono">not in his plan yet</span>` : availChip(b.availability)}</td></tr>`)
      : html`<tr><td colspan="5" class="empty">NO PLAN AHEAD</td></tr>`);
    setSlot(root, 'ln-queue', q.length
      ? q.map((c) => html`<tr><td>${c.name || c.chatJid}${c.dms ? html` <span class="chip">DM</span>` : ''}</td><td class="mono">${c.count}</td><td class="mono">${fmtRelative(c.oldestAt)} ago</td><td class="mono">${c.mentions || 0}</td></tr>`)
      : html`<tr><td colspan="4" class="empty">QUEUE EMPTY</td></tr>`);
    const ro = readOnly();
    setSlot(root, 'ln-claims', claims.length
      ? claims.map((c) => claimRow(c, ro))
      : html`<div class="empty">NO FLAGGED CLAIMS</div>`);
    // On a phone the fold opens when a decision starts waiting on its deadline and closes when
    // none is; in between it stays as you left it.
    const waiting = (n.decisions || []).some((d) => d.status === 'open' && Number(d.decideBy) > Number(n.at ?? Date.now() / 1000));
    if (waiting !== decisionsWaiting && globalThis.matchMedia?.('(max-width: 900px)').matches) {
      const fold = $(root, '[data-fold="now.decisions"]');
      if (fold) fold.open = waiting;
    }
    decisionsWaiting = waiting;
    setSlot(root, 'ln-decisions', n.decisions?.length
      ? n.decisions.map((d) => decisionRow(d, ro, n.at ?? Math.floor(Date.now() / 1000)))
      : html`<tr><td colspan="6" class="empty">NO DECISIONS</td></tr>`);
  }

  async function write(path, body, okMsg, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await api(path, { method: 'POST', body: body || {} });
      flash(typeof okMsg === 'function' ? okMsg(res) : okMsg);
      if (btn === checkBtn && ctx.alive()) btn.disabled = readOnly();
      if (ctx.alive()) await load();
    } catch (err) {
      if (isAbort(err)) return;
      flash(err.message, 'bad');
      if (btn && ctx.alive()) btn.disabled = false;
      // A refused change (no longer open, read-only, rate limit) must not leave a
      // control showing a value the server doesn't hold (the mode select).
      if (ctx.alive()) load().catch(() => {});
    }
  }

  ctx.listen(checkBtn, 'click', () => write('/api/life/phone/check', {}, phoneCheckMessage, checkBtn));
  ctx.listen(root, 'click', (e) => {
    const rev = e.target.closest?.('.ln-inf-revert');
    if (rev) {
      askSheet({ label: `Revert event #${rev.dataset.id}`, text: 'Undo what this chat did to his day, with anything it caused.', action: 'REVERT', danger: true }).then(({ ok }) => {
        if (ok && ctx.alive()) write(`/api/life/events/${encodeURIComponent(rev.dataset.id)}/revert`, { reason: 'owner: undo a chat influence (Life · Now)' }, `EVENT ${rev.dataset.id} REVERTED`, rev);
      });
      return;
    }
    const dismiss = e.target.closest?.('.ln-alert-dismiss');
    if (dismiss && !dismiss.disabled) {
      write(`/api/life/alerts/${encodeURIComponent(dismiss.dataset.fp)}/dismiss`, {}, 'FINDING DISMISSED', dismiss);
      return;
    }
    if (e.target.closest?.('#lnAlertsRun')) {
      write('/api/life/alerts/run', {}, (r) => `SWEEP DONE · ${r?.count ?? 0} OPEN`, e.target.closest('#lnAlertsRun'));
      return;
    }
    const btn = e.target.closest?.('.ln-dismiss');
    if (!btn) return;
    write(`/api/life/claims/${encodeURIComponent(btn.dataset.id)}/dismiss`, {}, 'CLAIM DISMISSED', btn);
  });
  ctx.listen(root, 'change', (e) => {
    const sel = e.target.closest?.('.ln-mode');
    if (!sel) return;
    write(`/api/life/decisions/${encodeURIComponent(sel.dataset.id)}/mode`, { mode: sel.value }, `DECISION ${sel.dataset.id} → ${sel.value.toUpperCase()}`, sel);
  });

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life now poll', err); }); }, POLL_MS);
}

