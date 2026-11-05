// LIFE · DAY — his day read top to bottom like a diary: what actually
// happened (the world log: activities, trips, availability, phone checks,
// weather, decisions, story moments, the mind's runs, chat activity as counts
// per chat), a NOW line, and the projected rest of today / tomorrow (faded):
// the most likely blocks of several simulation runs, decisions with their odds
// and the weather forecast. A NOW card on top answers "what is he doing, and
// would he reply right now?". #life/day/<YYYY-MM-DD> opens another day (the
// genesis day … tomorrow). Polls GET /api/life/day every 30 s while showing
// today; clicking a past row shows its cause chain (GET /api/life/events/:id/explain).
// 012: chat influence rows (a message that got to him, invitations and his
// answers, follow-ups, sleep pushes, falling behind at work) are labelled from
// GET /api/influence/lane for the shown day, with the chat's name; if that read
// fails they stay generic rows.
// sched-fixes: today's page after 18:00 ends with a TONIGHT (CONTINUES TOMORROW)
// strip — the projected hours past midnight up to his next wake (≥ 6 h) and the
// plans set for then (an outing at 00:15 shows here, not only on tomorrow's page).
// 014: a small map of the shown day's trips under the timeline
// (GET /api/life/map?date=…: past trips solid, today's planned ones dashed;
// road geometry when a trip has it, else straight lines). Leaflet when tiles
// are configured and it loads, else Life · Map's SVG grid; a failed read only
// leaves a note. Redrawn only when the trip list changes.
//
// 016: an outing someone was with him on carries a ❖ HOW IT WENT chip; picking it
// opens the scene panel (components/scene-panel.js, GET /api/arcs/scenes/:id) under
// WHY. That panel is the page's one exception to read-only: REGENERATE, EDIT TEXT
// and REVERT THIS CHANGE for the scene (write mode only). A planned outing ahead
// links to the Director, where a tone hint for its scene is set.
//
// 019: a text to or from someone in his world reads "texted Lena" / "Lena texted" (never folded).
//
// Phone width (2026-10-31): runs of three or more phone checks / mind glances fold into
// one QUIET row (tap to open it; ALL ROWS in the panel head turns folding off, kept
// per browser); WHY and HOW IT WENT open as a sheet from the bottom when a row or a
// ❖ chip is picked (CLOSE, Escape or a tap outside), and the date bar is one row.
//
// Every other row is read only. Every string from the world file or the log
// (places, cast, chat names) reaches the DOM through html`` / setSlots (escaped).
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, slotPainter, $ } from '../core/dom.js';
import { fmtHm, fmtTime, fmtWhen, decidedAhead } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { showError } from '../components/ui.js';
import { getStatus } from '../components/topbar.js';
import { offNote, availChip, readOnly } from './life-now.js';
import { mountScenePanel, endingWord } from '../components/scene-panel.js';
import { chainList } from './life-timeline.js';
import { mountMap } from '../components/leafmap.js';
import { initFolds, stream, toldRows, twoCol } from '../components/views.js';
import { mapSvg, drawLeaf, drawMe, leafSig, wantsLeaflet } from './life-map.js';

const POLL_MS = 30_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SW = 1000;            // sparkline viewBox
const SH = 120;
const SERIES = [
  ['energy', 'ENERGY', (v) => v.energy],
  ['stress', 'STRESS', (v) => v.stress],
  ['social', 'SOCIAL', (v) => v.social],
  ['mood', 'MOOD', (v) => (typeof v.valence === 'number' ? (v.valence + 1) * 50 : null)],
];
const CAT_ICON = {
  activity: '■', trip: '→', sleep: '☾', wake: '☀', meal: '◆', phone: '▣', weather: '☂', decision: '?',
  story: '✦', money: '¤', work: '▲', health: '+', chat: '◇', owner: '◎', mind: '◉', chats: '◇', event: '·',
};

const SHELL = raw(`
<div class="ld-page">
<div class="page-header">
  <div>
    <div class="crumb">LIFE · DAY · HIS DAY TOP TO BOTTOM</div>
    <h1>Day</h1>
  </div>
  <div class="meta ld-nav">
    <button type="button" id="ldPrev" aria-label="Previous day">◀ <span data-slot="ld-prev">—</span></button>
    <b class="ld-date" data-slot="ld-date">—</b>
    <button type="button" id="ldNext" aria-label="Next day"><span data-slot="ld-next">—</span> ▶</button>
    <button type="button" id="ldToday" class="primary">NOW · <span data-slot="ld-clock">—</span></button>
  </div>
</div>
<div data-slot="ld-off"></div>
<div data-slot="ld-now"></div>

<div data-slot="ld-goals"></div>

<div class="panel">
  <details class="fold-in" data-fold="day.vitals" data-wide-open><summary class="panel-head"><span>VITALS<button type="button" class="guide-q" data-guide="vitals" aria-label="Guide: vitals">?</button></span><span class="mono mute" data-slot="ld-vitals-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body"><div data-slot="ld-spark" class="ld-spark"></div><div class="life-legend mono" data-slot="ld-spark-legend"></div></div>
  </details>
  </div>

<div class="col-2 ld-cols" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>THE DAY<button type="button" class="guide-q" data-guide="rows" aria-label="Guide: rows">?</button></span><span class="ld-dayhead"><span class="mono mute" data-slot="ld-proj">—</span><button type="button" id="ldAllRows" class="ld-allrows" aria-pressed="false">ALL ROWS</button></span></div>
    <div class="ld-rows" data-slot="ld-rows"><div class="loading">LOADING</div></div>
  </div>
  <div class="panel ld-side" id="ldSide" aria-label="Why and how it went">
    <button type="button" class="ld-side-close" id="ldSideClose">CLOSE ✕</button>
    <div class="panel-head"><span>WHY · CAUSE CHAIN<button type="button" class="guide-q" data-guide="why" aria-label="Guide: why">?</button></span><span class="mono mute" data-slot="ld-sel">NOTHING SELECTED</span></div>
    <div class="panel-body" data-slot="ld-why"><div class="empty">TAP A PAST ROW</div></div>
    <div class="panel-head" id="ldSceneHead"><span>HOW IT WENT<button type="button" class="guide-q" data-guide="scene" aria-label="Guide: how it went">?</button></span><span class="mono mute" data-slot="ld-scene-sel">PICK AN OUTING WITH ❖</span></div>
    <div class="panel-body" data-slot="ld-scene"><div class="empty">AN OUTING WITH SOMEONE GETS A SCENE WHEN IT ENDS</div></div>
  </div>
  <div class="ld-side-scrim" id="ldSideScrim"></div>
</div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="day.mind" data-wide-open><summary class="panel-head"><span>ON HIS MIND<button type="button" class="guide-q" data-guide="thoughts" aria-label="Guide: on his mind">?</button></span><span class="mono mute" data-slot="ld-th-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div data-slot="ld-th-real"></div>
  <div data-slot="ld-th" class="ld-stream"></div>
  </details>
  </div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="day.deed" data-wide-open><summary class="panel-head"><span>THOUGHT VS DEED<button type="button" class="guide-q" data-guide="thought-deed" aria-label="Guide: thought vs deed">?</button></span><span class="mono mute" data-slot="ld-td-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body" data-slot="ld-td"><div class="empty">LOADING</div></div>
  </details>
  </div>

<div class="panel" style="margin-top:14px">
  <details class="fold-in" data-fold="day.map" data-wide-open><summary class="panel-head"><span>TRIPS · MAP<button type="button" class="guide-q" data-guide="map" aria-label="Guide: map">?</button></span><span class="mono mute" data-slot="ld-map-note">—</span><span class="fold-mark" aria-hidden="true"></span></summary>
  <div class="panel-body"><div class="leaf-map ld-map" data-leaf hidden></div><div data-slot="ld-map-svg" class="life-map ld-map-svg"></div></div>
  </details>
  </div>
</div>
`);

const pct = (p) => (typeof p === 'number' && Number.isFinite(p) ? `${Math.round(p * 100)}%` : '—');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : '—');

/** '2026-10-29' → 'THU 29 OCT' (a calendar date: formatted as a UTC date, no zone of his involved). */
export function dayLabel(date) {
  if (!DATE_RE.test(String(date || ''))) return '—';
  const [y, m, d] = date.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' })
      .format(new Date(Date.UTC(y, m - 1, d))).replace(',', '').toUpperCase();
  } catch {
    return date;
  }
}

function withText(names) {
  return names?.length ? ` with ${names.join(', ')}` : '';
}

/** One line of what a span / tick is (text only; the caller escapes it). `now`: the view's clock (seconds). */
/** 019: an in-world text, whatever category the log gives it: "texted Lena" / "Lena texted" (else "a text"). */
export function textRowText(r) {
  const d = r.detail || {};
  const who = Array.isArray(d.with) && d.with.length ? d.with[0] : (typeof d.name === 'string' && d.name ? d.name : null);
  const n = r.count > 1 ? ` ×${r.count}` : '';
  if (!who) return `a text${n}`;
  return `${d.dir === 'in' ? `${who} texted` : `texted ${who}`}${n}`;
}

export function rowText(r, now = r.now) {
  const d = r.detail || {};
  if (r.type === 'phone.message') return textRowText(r);
  if (r.type === 'dream.had') {
    const word = { good: 'a good dream', bad: 'a bad dream', nightmare: 'a nightmare' }[r.detail?.tone] ?? 'an odd dream';
    const who = r.detail?.with?.length ? ` · ${r.detail.with.join(', ')}` : '';
    return `woke remembering ${word}${who}`;
  }
  switch (r.cat) {
    case 'sleep': return 'asleep';
    case 'trip': return `${r.mode || 'trip'}${r.from || r.to ? ` · ${r.from || '?'} → ${r.to || '?'}` : ''}${r.minutes ? ` · ${r.minutes} min` : ''}${withText(r.with)}`;
    case 'activity': return `${r.kind || 'activity'}${r.place ? ` · ${r.place}` : ''}${withText(r.with)}${r.planned ? ' (planned)' : ''}`;
    case 'phone': return `phone check${r.end ? ` until ${fmtHm(r.end)}` : ''}${r.readOnly ? ' · read only' : ''}`;
    case 'wake': return r.type === 'genesis' ? 'his world began' : r.type === 'world.reanchored' ? 're-anchored after downtime'
      : d.via === 'phone' ? 'woken up by his phone' : `woke up${d.lateBy ? ` · ${d.lateBy} min late` : ''}`;
    case 'meal': return `${d.kind || 'meal'}`;
    case 'weather': return r.type === 'commute.soaked'
      ? `caught in the rain on the way${d.mode ? ` (${d.mode})` : ''}${d.changeClothes ? ' · changed clothes' : ''}${d.lateMin ? ` · ${d.lateMin} min late` : ''}`
      : `${String(d.condition || 'weather').replace(/_/g, ' ')}${typeof d.tempC === 'number' ? `, ${d.tempC}°` : ''}`;
    case 'owner':
      if (r.type === 'weather.window_set') return `you set the weather: ${d.sky || '?'}`;
      if (r.type === 'weather.window_ended') return 'you ended a weather window';
      if (r.type === 'goal.set') return `you set a goal: ${d.goalKind || '?'}${d.label ? ` · ${d.label}` : ''}${d.with?.length ? ` with ${d.with.join(', ')}` : ''}`;
      if (r.type === 'goal.cancelled') return 'you cancelled a goal';
      return otherText(r, d);
    case 'money': return moneyText(r.type, d);
    case 'work': return r.type === 'work.late' ? `working late${d.extraMin ? ` (+${d.extraMin} min)` : ''}` : r.type === 'work.crunch' ? 'a deadline crunch' : r.type;
    case 'decision': return r.type === 'goal.fitted' ? `fitted a goal${d.place ? ` · ${d.place}` : ''}${d.with?.length ? ` with ${d.with.join(', ')}` : ''}`
      : r.type === 'goal.deferred' ? `goal not today${d.reason ? ` (${d.reason})` : ''}`
        : r.type === 'goal.done' ? 'goal done' : r.type === 'goal.expired' ? 'a goal lapsed (never fitted)'
          : r.type === 'decision.committed' ? decidedAhead(d.label || d.optionId, d.eventAt, now) || `decided: ${d.label || d.optionId || '?'}`
      : r.type === 'decision.reversed' ? `changed his mind: ${d.label || d.optionId || '?'}${decidedAhead('', d.eventAt, now) ? ` · ${fmtWhen(d.eventAt)} (not yet)` : ''}`
        : r.type === 'decision.expired' ? `let it pass${d.reason ? ` (${d.reason})` : ''}` : r.type;
    case 'mind': return `mind · ${r.kind}${r.status && r.status !== 'ok' ? ` (${r.status}${r.skipReason ? `: ${r.skipReason}` : ''})` : ''}`;
    default: return otherText(r, d);
  }
}

function otherText(r, d) {
  const bits = [r.type, d.kind, d.stage, d.label, d.reason, d.place, d.with?.length ? `with ${d.with.join(', ')}` : null].filter(Boolean);
  return `${bits.join(' · ')}${r.count > 1 ? ` ×${r.count}` : ''}`;
}

// How a plan was settled, in words (a code otherwise): 019 a plan agreed in texts.
const BY_WORDS = Object.freeze({ text: 'agreed in texts', scene: 'agreed in person' });
const byWord = (by) => BY_WORDS[by] ?? by;

function decisionText(d, future, now = d.now) {
  const what = [d.kind, d.place, d.with?.length ? `with ${d.with.join(', ')}` : null].filter(Boolean).join(' · ');
  const by = d.decideBy ? ` (decide by ${fmtHm(d.decideBy)})` : '';
  if (future && d.odds?.length) return `${what}: ${d.odds.map((o) => `${o.label} ${pct(o.p)}`).join(' · ')}${by}`;
  // A committed plan still ahead is not something that happened: "decided: … (not yet)".
  const ahead = !future && d.status === 'committed' && d.outcome?.label ? decidedAhead(d.outcome.label, d.eventAt, now) : '';
  const out = ahead ? ` → ${ahead}${d.outcome.by ? ` (${byWord(d.outcome.by)})` : ''}`
    : d.outcome?.label ? ` → ${d.outcome.label}${d.outcome.by ? ` (${byWord(d.outcome.by)})` : ''}`
    : d.outcome?.expired ? ` → expired (${d.outcome.expired})`
      : d.lean?.label ? ` · leaning ${d.lean.label}${typeof d.lean.p === 'number' ? ` ${pct(d.lean.p)}` : ''}` : '';
  return `${what}${out}${d.status === 'open' ? by : ''}`;
}

/** Chat activity inside [a, b), per chat: { name, sent, deferred, answered }. */
function chatsIn(chats, a, b) {
  const by = new Map();
  for (const c of chats) {
    if (c.at < a || c.at >= b) continue;
    const k = c.chatJid;
    const e = by.get(k) ?? { name: c.name || (c.dm ? 'a DM' : 'a group'), dm: c.dm, sent: 0, deferred: 0, answered: 0 };
    e.sent += c.sent; e.deferred += c.deferred; e.answered += c.answered;
    by.set(k, e);
  }
  return [...by.values()];
}

function chatsCell(list) {
  if (!list.length) return '';
  const sum = (f) => list.reduce((s, c) => s + c[f], 0);
  const parts = [sum('sent') ? `${sum('sent')} sent` : null, sum('deferred') ? `${sum('deferred')} deferred` : null, sum('answered') ? `${sum('answered')} answered later` : null].filter(Boolean);
  const names = list.map((c) => `${c.name}${c.dm ? ' (DM)' : ''}: ${[c.sent && `${c.sent} sent`, c.deferred && `${c.deferred} deferred`, c.answered && `${c.answered} later`].filter(Boolean).join(', ')}`).join(' · ');
  return html`<span class="ld-chats" title="${names}">▣ ${parts.join(' · ')}</span><span class="ld-chat-names mute">${names}</span>`;
}

// 012 lane entries ({ type, kind, state, affect, chatName }) → one line (codes and names only).
const LANE_KIND = { affect: 'a message got to him', invite: 'invited out', cancel: 'the inviter called it off', live: 'kept chatting at bedtime' };
export function laneText(e) {
  const where = e.chatName ? ` · ${e.chatName}` : '';
  switch (e.type) {
    case 'chat.perceived': return `${LANE_KIND[e.kind] ?? 'a chat message'}${e.kind === 'affect' && e.affect ? ` (${String(e.affect).replace(/_/g, ' ')})` : ''}${where}`;
    case 'sleep.delayed': return `sleep pushed by a chat${e.state ? ` · ${e.state} min later tonight` : ''}${where}`;
    case 'work.behind': return 'behind at work (a lot of chatting this morning)';
    case 'invite.answered': return `answered the invitation: ${e.state || '?'}${where}`;
    case 'invite.followed_up': return `followed up on the invitation · ${e.state === 'sent' ? 'sent' : 'nothing sent'}${where}`;
    default: return `${e.type}${where}`;
  }
}

const RANK = { span: 0, decision: 1, tick: 2, chats: 3 };
const byTime = (a, b) => (a.at ?? 0) - (b.at ?? 0) || (RANK[a.row] ?? 9) - (RANK[b.row] ?? 9);

/** Every row of the day in time order (past, then the NOW line, then the projection). lane: [012 lane entries]. */
const amountText = (a) => (typeof a === 'number' && Number.isFinite(a) ? Math.round(a).toLocaleString() : '');

/** A money row in words: salary in, an owner's change (added / took / set), or a spend and what for. */
export function moneyText(type, d = {}) {
  const amt = amountText(d.amount);
  const lab = d.label ? ` · ${d.label}` : '';
  if (type === 'money.salary') return `salary +${amt}`;
  if (type === 'money.adjusted') {
    if (d.mode === 'income') return `you added +${amt}${lab}`;
    if (d.mode === 'expense') return `you took −${amt}${lab}`;
    if (d.mode === 'set') return `you set his money to ${amt}${lab}`;
    return `money changed ${amt}${lab}`;
  }
  const what = [d.for, d.kind].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ');
  return `spent −${amt}${what ? ` · ${what}` : ''}`;
}

// Quiet rows: a past phone check or a mind glance. Three or more in a row fold into one.
const QUIET_MIN = 3;
const isQuiet = (r) => r.row === 'tick' && !r.future && !r.lane && r.type !== 'phone.message' && (r.cat === 'phone' || (r.cat === 'mind' && r.kind === 'glance'));

/** Folds runs of ≥ QUIET_MIN quiet rows into one { row:'quiet', key, at, end, rows, phone, glance }; `open` keys stay unfolded. */
export function foldQuiet(rows, open = new Set()) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= QUIET_MIN) {
      const key = `q${run[0].at}`;
      const fold = { row: 'quiet', key, at: run[0].at, end: run.at(-1).end ?? run.at(-1).at, rows: run,
        phone: run.filter((r) => r.cat === 'phone').length, glance: run.filter((r) => r.cat === 'mind').length, open: open.has(key) };
      out.push(fold);
      if (fold.open) out.push(...run);
    } else out.push(...run);
    run = [];
  };
  for (const r of rows) {
    if (isQuiet(r)) { run.push(r); continue; }
    flush();
    out.push(r);
  }
  flush();
  return out;
}

export function quietText(q) {
  const parts = [];
  if (q.phone) parts.push(`${q.phone} phone check${q.phone === 1 ? '' : 's'}`);
  if (q.glance) parts.push(`${q.glance} mind glance${q.glance === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function buildRows(v, lane = []) {
  const byEvent = new Map((Array.isArray(lane) ? lane : []).filter((e) => Number.isSafeInteger(e?.eventId)).map((e) => [e.eventId, e]));
  const rows = [];
  const pastEnd = Math.min(v.to, v.at);
  const chats = Array.isArray(v.chats) ? v.chats : [];
  const covered = new Set();
  const past = v.past || {};
  const spans = past.spans || [];
  spans.forEach((s, i) => {
    const end = s.end ?? pastEnd;
    const list = chatsIn(chats, s.at, end);
    chats.forEach((c, j) => { if (c.at >= s.at && c.at < end) covered.add(j); });
    rows.push({ ...s, end, row: 'span', chats: list, ongoing: s.end === null && v.today, i });
  });
  for (const t of past.ticks || []) {
    const e = byEvent.get(t.eventId);
    rows.push(e ? { ...t, row: 'tick', cat: 'chat', lane: e } : { ...t, row: 'tick', now: v.at });
  }
  for (const d of past.decisions || []) rows.push({ ...d, cat: 'decision', row: 'decision', eventId: d.id, now: v.at });
  for (const m of v.mind || []) rows.push({ at: m.at, cat: 'mind', kind: m.kind, status: m.status, skipReason: m.skipReason, row: 'tick' });
  chats.forEach((c, j) => { if (!covered.has(j)) rows.push({ at: c.at, cat: 'chats', row: 'chats', chats: chatsIn([c], c.at, c.at + 1) }); });
  const fut = v.future;
  const out = rows.sort(byTime);
  if (v.today) out.push({ row: 'now', at: v.at });
  if (fut) {
    const f = [];
    for (const s of fut.spans || []) f.push({ ...s, row: 'span', future: true });
    for (const t of fut.ticks || []) f.push({ ...t, row: 'tick', future: true });
    for (const d of fut.decisions || []) f.push({ ...d, at: d.decideBy ?? d.at, cat: 'decision', row: 'decision', future: true });
    for (const w of fut.weather || []) if (!v.today || w.from > v.at) f.push({ at: w.from, cat: 'weather', row: 'tick', future: true, detail: { condition: w.condition, tempC: w.tempC }, forecast: true, owner: w.owner === true });
    f.sort(byTime);
    out.push(...f);
  }
  // Tonight past midnight (today after 18:00): a strip of its own below today's rows.
  const tn = v.today ? v.tonight : null;
  if (tn && ((tn.spans || []).length || (tn.decisions || []).length)) {
    const t = [];
    for (const s of tn.spans || []) t.push({ ...s, row: 'span', future: true, tonight: true });
    for (const k of tn.ticks || []) t.push({ ...k, row: 'tick', future: true, tonight: true });
    for (const d of tn.decisions || []) t.push({ ...d, cat: 'decision', row: 'decision', future: true, tonight: true });
    t.sort(byTime);
    out.push({ row: 'tonight', at: tn.from, to: tn.to }, ...t);
  }
  return out;
}

function rowView(r, selected) {
  if (r.row === 'now') {
    return html`<div class="ld-nowline" id="ldNowLine" role="separator"><span>${fmtHm(r.at)}</span><b>NOW</b></div>`;
  }
  if (r.row === 'quiet') {
    return html`<button type="button" class="ld-row ld-quiet${r.open ? ' is-open' : ''}" data-quiet="${r.key}" aria-expanded="${r.open ? 'true' : 'false'}">
    <span class="ld-time mono">${fmtHm(r.at)}<span class="mute">–${fmtHm(r.end)}</span></span>
    <span class="ld-bar" aria-hidden="true">${r.open ? '▾' : '▸'}</span>
    <span class="ld-what">${quietText(r)} <span class="mute">${r.open ? 'HIDE' : 'SHOW'}</span></span>
  </button>`;
  }
  if (r.row === 'tonight') {
    return html`<div class="ld-nowline ld-tonightline" role="separator"><span>${fmtHm(r.at)}</span><b>TONIGHT (CONTINUES TOMORROW)</b><span class="mute">until ${fmtHm(r.to)} · projected</span></div>`;
  }
  const clickable = !r.future && Number.isSafeInteger(r.eventId) && r.eventId > 0;
  const cls = ['ld-row', `ld-${r.row}`, `ld-cat-${r.cat}`, r.future ? 'is-future' : '', clickable ? 'is-click' : '', selected && r.eventId === selected ? 'is-sel' : '', r.ongoing ? 'is-ongoing' : ''].filter(Boolean).join(' ');
  const text = r.row === 'decision' ? decisionText(r, r.future) : r.row === 'chats' ? 'chat activity'
    : r.lane ? `${laneText(r.lane)}${r.count > 1 ? ` ×${r.count}` : ''}` : rowText(r);
  const until = r.ongoing ? (r.expectedEnd ? `~${fmtHm(r.expectedEnd)}` : '…') : fmtHm(r.end);
  const time = r.row === 'span' && r.end ? html`${fmtHm(r.at)}<span class="mute">–${until}</span>` : fmtHm(r.at);
  return html`<div class="${cls}" ${clickable ? html`data-ev="${r.eventId}" role="button" tabindex="0"` : ''}>
    <span class="ld-time mono">${time}</span>
    <span class="ld-bar" aria-hidden="true">${CAT_ICON[r.cat] ?? '·'}</span>
    <span class="ld-what">${text}${r.owner ? html` <span class="chip warn">SET BY YOU</span>` : ''}${r.subject ? html` <span class="chip">${r.subject}</span>` : ''}${r.origin || r.lane ? html` <span class="chip warn" title="caused by a chat">CHAT · ${r.lane?.chatName || r.origin || 'chat'}</span>` : ''}${r.clipped ? html` <span class="mute">(since ${fmtHm(r.at)})</span>` : ''}</span>
    ${r.row === 'span' ? sceneChip(r) : ''}
    <span class="ld-av">${r.row === 'span' && r.availability ? availChip(r.availability) : ''}</span>
    <span class="ld-extra mono">${r.chats?.length ? chatsCell(r.chats) : ''}</span>
  </div>`;
}

// 016: a past span's scene chip (how the outing went), or a planned outing's tone link.
export function sceneChip(r) {
  const sc = r.scene;
  if (!r.future && sc && Number.isSafeInteger(sc.sceneId)) {
    const end = endingWord(sc.ending);
    return html`<span class="chip ok ld-scene-chip" data-scene="${sc.sceneId}" title="how it went — open the scene">❖ HOW IT WENT${end ? ` · ${end}` : ''}${sc.fallback ? ' · ONE LINE' : ''}</span>`;
  }
  if (r.future && Number.isSafeInteger(r.decisionId) && Array.isArray(r.with) && r.with.length) {
    return html`<a class="chip ld-scene-tone" href="#life/director/god" title="set how its scene should go (Director · PLAY GOD · OUTCOMES)">❖ TONE</a>`;
  }
  return '';
}

// 011: the owner's soft goals — open, planned at a time, deferred (why), or closed (shown 3 days).
export function goalsStrip(goals) {
  if (!Array.isArray(goals) || !goals.length) return null;
  const status = (g) => (g.status === 'planned' ? `planned at ${fmtHm(g.slotStart)}`
    : g.status === 'open' ? (g.lastTry?.reason ? `deferred: ${g.lastTry.reason}` : 'open') : g.status);
  return html`<div class="panel story-goal-strip">
    <div class="panel-head"><span>GOALS<button type="button" class="guide-q" data-guide="goals" aria-label="Guide: goals">?</button></span><span class="mono mute">SET ON THE DIRECTOR · FITTED INTO A FREE SLOT</span></div>
    <div class="panel-body story-goal-list">${goals.map((g) => html`<span class="chip ${g.status === 'planned' ? 'ok' : g.status === 'expired' ? 'bad' : g.status === 'open' ? '' : 'mute'}">#${g.id} ${String(g.goalKind || '').toUpperCase()}${g.with ? ` · ${g.with}` : ''}${g.place ? ` · ${g.place}` : ''}${g.label ? ` · ${g.label}` : ''} · ${fmtTime(g.from)} → ${fmtTime(g.to)} · ${status(g)}</span> `)}</div>
  </div>`;
}

function points(list, get, x, y) {
  return list.map((p) => [get(p), p.at]).filter(([v]) => typeof v === 'number' && Number.isFinite(v)).map(([v, t]) => `${x(t)},${y(v)}`).join(' ');
}

/**
 * The vitals sparkline: past solid, projection dashed, a NOW marker. The SVG
 * stretches to the panel (lines only, strokes unscaled); the hour axis is
 * HTML below it so its labels never stretch.
 */
export function sparkline(v) {
  const from = v.from;
  const to = v.to;
  const x = (t) => +(((Math.max(from, Math.min(to, t)) - from) / Math.max(1, to - from)) * SW).toFixed(1);
  const y = (n) => +(4 + (1 - Math.max(0, Math.min(100, n)) / 100) * (SH - 8)).toFixed(1);
  const past = v.past?.vitals || [];
  const fut = v.future?.vitals || [];
  const grid = [];
  for (let h = 3; h < 24; h += 3) grid.push(html`<line class="ld-grid" x1="${x(from + h * 3600)}" x2="${x(from + h * 3600)}" y1="0" y2="${SH}"></line>`);
  const lines = SERIES.map(([key, , get]) => html`
    <polyline class="ld-v ld-v-${key}" points="${points(past, get, x, y)}"></polyline>
    <polyline class="ld-v ld-v-${key} is-future" points="${points(fut, get, x, y)}"></polyline>`);
  const now = v.today ? html`<line class="ld-now" x1="${x(v.at)}" x2="${x(v.at)}" y1="0" y2="${SH}"></line>` : '';
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  return html`<svg viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none" role="img" aria-label="Energy, stress, social battery and mood over the day (0 to 100)">
    <line class="ld-grid" x1="0" x2="${SW}" y1="${y(50)}" y2="${y(50)}"></line>${grid}${lines}${now}</svg>
    <div class="ld-spark-axis mono" aria-hidden="true">${hours.map((h) => html`<span>${String(h).padStart(2, '0')}</span>`)}</div>`;
}

function oddsLine(o) {
  return `${pct(o.now)} now · ${pct((o.sneak || 0))} a quick look · ${pct(o.defer)} later${o.react ? ` · ${pct(o.react)} react` : ''}${o.ignore ? ` · ${pct(o.ignore)} ignore` : ''}`;
}

function nowCard(n) {
  const d = n.doing || {};
  const what = d.cat === 'trip' ? `${d.mode || 'travelling'} ${d.from || '?'} → ${d.to || '?'}${d.until ? ` · arrives ${fmtHm(d.until)}` : ''}`
    : `${d.kind || '—'}${d.place ? ` at ${d.place}` : ''}${withText(d.with)}`;
  const av = n.availability || {};
  const next = n.next;
  const vt = n.vitals || {};
  const bar = (label, val, lo = 0, hi = 100) => {
    const ok = typeof val === 'number' && Number.isFinite(val);
    const p = ok ? Math.max(0, Math.min(100, Math.round(((val - lo) / (hi - lo)) * 100))) : 0;
    return html`<div class="factor-bar"><span class="label">${label}</span><span class="track"><span class="f life-f" style="width:${p}%"></span></span><span class="num">${ok ? (hi <= 1 ? val.toFixed(2) : Math.round(val)) : '—'}</span></div>`;
  };
  const reply = av.onPhone || av.state === 'free' ? 'yes — he is on his phone or free'
    : av.state === 'asleep' ? 'no — asleep (DMs wait for the morning)' : `maybe — ${oddsLine(n.reply?.dm || {})} for a DM`;
  return html`<div class="panel ld-nowcard">
    <div class="panel-head"><span>NOW · ${fmtHm(n.at)}<button type="button" class="guide-q" data-guide="now" aria-label="Guide: now">?</button></span>
      <span>${availChip(av.state)}${av.onPhone ? html` <span class="chip ok">ON PHONE</span>` : ''}${n.embargo ? html` <span class="chip bad">QUIET DAY</span>` : ''}</span></div>
    <div class="panel-body ld-now-body">
      <div class="ld-now-main">
        <div class="ld-doing">${what}</div>
        <div class="mono mute">${d.since ? `since ${fmtHm(d.since)}` : ''}${d.until ? ` · until ${fmtHm(d.until)}` : ''}${av.until ? ` · ${av.state} until ${fmtHm(av.until)}` : ''}${n.weather ? ` · ${String(n.weather.condition || '').replace(/_/g, ' ')}, ${num(n.weather.tempC)}°` : ''}</div>
        <div class="ld-reply"><b>Would he reply now?</b> ${reply}</div>
        <div class="mono mute">group mention: ${oddsLine(n.reply?.mention || {})} · group chatter: ${oddsLine(n.reply?.chatter || {})}</div>
        <div class="ld-next mono">${next ? `next: ${rowText(next)} ~${fmtHm(next.at)}` : 'next: —'}${n.phone?.nextCheckAt ? ` · phone check ~${fmtHm(n.phone.nextCheckAt)}` : ''}</div>
      </div>
      <div class="ld-now-vitals">
        ${bar('ENERGY', vt.energy)}${bar('STRESS', vt.stress)}${bar('SOCIAL BATT.', vt.social)}${bar('MOOD', vt.valence, -1, 1)}
        ${bar('HUNGER', n.hunger)}${bar('WORK PRESSURE', n.workPressure)}
      </div>
    </div>
  </div>`;
}

function projectionNote(f) {
  if (!f) return 'NO PROJECTION (THE DAY IS OVER)';
  if (f.source === 'plan') return 'PROJECTION · THE DAY PLAN (ARCS OFF · NO ODDS)';
  const age = Math.max(0, Math.round(Date.now() / 1000 - (f.computedAt || 0)));
  return `PROJECTION · ${f.runs} RUNS · ${f.ms} MS${f.cached ? ` · CACHED ${age < 60 ? `${age}s` : `${Math.round(age / 60)}m`}` : ''}${f.stale ? ' · REFRESHING' : ''}`;
}

/** Points the day map fits: the day's trips (their lines or places), else home. */
export function dayFitPoints(m) {
  const byId = new Map((m.places || []).map((p) => [p.id, p]));
  const pts = [];
  for (const t of m.trips || []) {
    if (Array.isArray(t.pts) && t.pts.length >= 2) { pts.push(t.pts[0], t.pts[t.pts.length - 1]); continue; }
    for (const id of [t.from, t.to]) {
      const p = byId.get(id);
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) pts.push([p.lat, p.lon]);
    }
  }
  if (!pts.length && m.home) pts.push([m.home.lat, m.home.lon]);
  return pts;
}

/** The day map's note: trip counts and which map is drawn. */
export function dayMapNote(m, leaf) {
  const past = (m.trips || []).filter((t) => !t.planned).length;
  const planned = (m.trips || []).length - past;
  const road = (m.trips || []).filter((t) => Array.isArray(t.pts) && t.pts.length >= 2).length;
  const what = `${past} TRIP${past === 1 ? '' : 'S'}${planned ? ` + ${planned} PLANNED` : ''}${road ? ` · ${road} BY ROAD` : ''}`;
  return `${what} · ${leaf ? 'LEAFLET' : m.tileUrl ? 'LOCAL GRID' : 'LOCAL GRID (NO TILES)'}`;
}

// 020 F1: what he leaned to vs what he did. Text is code-built; a plan from a chat has code labels only.
export function thoughtDeedNote(t) {
  if (!t?.running) return '—';
  const against = (t.rows || []).filter((r) => r.against).length;
  return `${t.rows?.length ?? 0} DECISION${t.rows?.length === 1 ? '' : 'S'} · ${against} AGAINST HIS LEAN`;
}

export function thoughtDeedRows(t) {
  const rows = t?.rows || [];
  if (!t?.running) return html`<div class="empty">LIFE IS NOT RUNNING</div>`;
  if (!rows.length) return html`<div class="empty">NO DECISIONS THIS DAY</div>`;
  return html`${rows.map((r) => {
    // "leaning stay (0.72)… went anyway" is one code-built line: its two halves go side by side.
    const [told, ...did] = String(r.text ?? '').split('…');
    return twoCol({
      title: html`#${r.id} · ${r.label}${r.fromChat || r.chatNudged ? ' · ◇ CHAT' : ''}${r.spansDays ? ' · ACROSS DAYS' : ''}${r.against ? html` <span class="chip warn">AGAINST HIS LEAN</span>` : ''}`,
      at: r.deed?.at ? fmtHm(r.deed.at) : fmtHm(r.at),
      differs: !!r.against,
      leftLabel: 'WHAT HE LEANED TO',
      left: told.trim(),
      rightLabel: 'WHAT HE DID',
      right: did.join('…').trim() || '—',
      note: r.leanCount > 1 ? html`LEANS ${r.leans.map((l) => `${fmtHm(l.at)} ${l.optionId ?? '?'}${typeof l.p === 'number' ? ` ${l.p.toFixed(2)}` : ''}${l.fromChat ? ' ◇' : ''}${l.fallback ? ` (${l.fallback})` : ''}`).join(' → ')}` : null,
    });
  })}`;
}

// A day holds dozens of thoughts: the latest in full, the rest behind one tap, in order.
const THOUGHTS_SHOWN = 12;
export function dayThoughts(rows, opts) {
  if (rows.length <= THOUGHTS_SHOWN + 4) return stream(rows, opts);
  const cut = rows.length - THOUGHTS_SHOWN;
  return html`<details class="subfold ld-earlier" data-fold="thoughts.day.earlier"><summary class="mono">EARLIER · ${cut}</summary>${stream(rows.slice(0, cut), opts)}</details>${stream(rows.slice(cut), opts)}`;
}

export async function mount(ctx, dateParam) {
  const root = ctx.root;
  render(root, SHELL);
  initFolds(root);
  // A poll with nothing new touches nothing: the scroll of the rows and a selection survive.
  const paintSlot = slotPainter(root);
  const setSlot = (_, key, tpl) => paintSlot(key, tpl);
  const date = DATE_RE.test(String(dateParam || '')) ? dateParam : null;
  let data = null;
  let lane = [];
  let selected = null;
  let scrolled = false;
  const leafBox = $(root, '[data-leaf]');
  let leaf = null;
  let leafTry = null;
  let leafFailed = false;
  let mapSig = '';
  let meSig = '';
  let lastMap = null;
  // Leaflet can't fit a map it can't see: a folded one gets its view when the fold opens.
  ctx.listen($(root, '[data-fold="day.map"]'), 'toggle', (e) => {
    if (!e.target.open || !leaf || !lastMap) return;
    leaf.map.invalidateSize();
    leaf.fit(dayFitPoints(lastMap));
  });
  const scenePanel = mountScenePanel(ctx, $(root, '[data-slot="ld-scene"]'), { readOnly, onChanged: () => { load().catch(() => {}); } });
  let sceneOf = new Map();   // span event id → scene id (this paint's rows)
  let sceneOfDecision = new Map();   // the outing's decision id → its scene id (the decision rows open the same scene)
  const openQuiet = new Set();
  let allRows = false;
  try { allRows = localStorage.getItem('ld.day.allRows') === '1'; } catch { /* storage off: fold */ }
  const narrow = () => { try { return window.matchMedia?.('(max-width: 720px)')?.matches === true; } catch { return false; } };
  const side = $(root, '#ldSide');
  // Under 720 px the panel is a modal sheet: a scrim, the page behind it inert (so Tab stays in
  // it), focus back where it came from. It stays in the page's DOM, because on a wider screen the
  // same element is the day's side column.
  let trapped = [];
  let opener = null;
  const openSide = () => {
    if (!side || !narrow()) return;
    if (!side.classList.contains('is-open')) {
      opener = document.activeElement;
      side.classList.add('is-open');
      side.setAttribute('role', 'dialog');
      side.setAttribute('aria-modal', 'true');
      document.documentElement.classList.add('ld-side-open');
      const scrim = $(root, '#ldSideScrim');
      for (let n = side; n !== document.body && n.parentElement; n = n.parentElement) {
        for (const sib of n.parentElement.children) {
          if (sib === n || sib === scrim || sib.inert || sib.matches('script, style, dialog, .flash-region, .story-modal')) continue;
          sib.inert = true;
          trapped.push(sib);
        }
      }
    }
    side.scrollTop = 0;
    $(root, '#ldSideClose')?.focus?.({ preventScroll: true });
  };
  const closeSide = ({ refocus = true } = {}) => {
    if (!side?.classList.contains('is-open')) return;
    side.classList.remove('is-open');
    side.removeAttribute('role');
    side.removeAttribute('aria-modal');
    document.documentElement.classList.remove('ld-side-open');
    for (const n of trapped) n.inert = false;
    trapped = [];
    if (refocus) {
      // Picking a row repaints the rows, so the opener may be gone: its row, then.
      const row = selected != null ? root.querySelector(`.ld-row[data-ev="${CSS.escape(String(selected))}"]`) : null;
      (opener?.isConnected && opener !== document.body ? opener : row)?.focus?.({ preventScroll: true });
    }
    opener = null;
  };
  ctx.onDispose?.(() => closeSide({ refocus: false }));
  // Turned sideways: the same element is a column again, nothing to hold.
  try { ctx.listen(window.matchMedia('(max-width: 720px)'), 'change', (e) => { if (!e.matches) closeSide({ refocus: false }); }); } catch { /* no matchMedia */ }
  setSlot(root, 'ld-spark-legend', html`${SERIES.map(([k, l]) => html`<span class="life-swatch ld-sw-${k}"></span>${l} `)}<span class="mute"> · dashed = projected · 0–100 (mood −1…1 scaled)</span>`);

  const go = (d) => { location.hash = d ? `#life/day/${d}` : '#life/day'; };

  function paint() {
    if (!data) return;
    const v = data;
    setSlot(root, 'ld-off', v.running ? null : offNote(getStatus()?.life?.skill === true));
    if (!v.running) {
      setSlot(root, 'ld-rows', html`<div class="empty">LIFE IS NOT RUNNING</div>`);
      return;
    }
    setSlots(root, {
      'ld-date': `${dayLabel(v.date)}${v.today ? ' · TODAY' : v.tomorrow ? ' · TOMORROW' : ''}`,
      'ld-prev': v.prev ? dayLabel(v.prev) : '—',
      'ld-next': v.next ? dayLabel(v.next) : '—',
      'ld-clock': fmtHm(Date.now() / 1000),
      'ld-proj': projectionNote(v.future),
      'ld-vitals-note': `${v.past?.vitals ? `${v.past.vitals.length} PAST POINTS` : 'NO PAST SERIES'}${v.future?.vitals ? ` · ${v.future.vitals.length} PROJECTED` : ''}`,
      'ld-sel': selected ? `EVENT #${selected}` : 'NOTHING SELECTED',
    });
    const prev = $(root, '#ldPrev');
    const next = $(root, '#ldNext');
    if (prev) prev.disabled = !v.prev;
    if (next) next.disabled = !v.next;
    setSlot(root, 'ld-now', v.now ? nowCard(v.now) : null);
    setSlot(root, 'ld-goals', goalsStrip(v.goals));
    setSlot(root, 'ld-spark', sparkline(v));
    const rows = buildRows(v, lane);
    const withScene = rows.filter((r) => r.row === 'span' && !r.future && Number.isSafeInteger(r.eventId) && Number.isSafeInteger(r.scene?.sceneId));
    sceneOf = new Map(withScene.map((r) => [r.eventId, r.scene.sceneId]));
    sceneOfDecision = new Map(withScene.filter((r) => Number.isSafeInteger(r.scene.decisionId)).map((r) => [r.scene.decisionId, r.scene.sceneId]));
    const shown = allRows ? rows : foldQuiet(rows, openQuiet);
    const allBtn = $(root, '#ldAllRows');
    if (allBtn) allBtn.setAttribute('aria-pressed', allRows ? 'true' : 'false');
    setSlot(root, 'ld-rows', shown.length ? shown.map((r) => rowView(r, selected)) : html`<div class="empty">NOTHING LOGGED THIS DAY</div>`);
    if (!scrolled && v.today) {
      scrolled = true;
      const line = $(root, '#ldNowLine');
      // A phone scrolls the page; on desktop only the day's own list moves, not the page under you.
      if (narrow()) line?.scrollIntoView?.({ block: 'center' });
      else if (line && rowsEl) rowsEl.scrollTop = line.offsetTop - rowsEl.offsetTop - rowsEl.clientHeight / 2;
    }
  }

  async function loadThoughts(v) {
    if (!v?.running || !DATE_RE.test(String(v.date || ''))) return;
    let th = null;
    try { th = await api(`/api/life/thoughts?date=${encodeURIComponent(v.date)}`, { signal: ctx.signal }); } catch (err) { if (isAbort(err)) throw err; }
    if (!ctx.alive()) return;
    setSlots(root, { 'ld-th-note': th?.running ? `${th.count ?? 0} THIS DAY` : '—' });
    setSlot(root, 'ld-th-real', toldRows((th?.real ?? []).map((x) => ({ ...x, at: fmtHm(x.at) }))));
    initFolds($(root, '[data-slot="ld-th-real"]'));
    setSlot(root, 'ld-th', dayThoughts((th?.thoughts ?? []).map((x) => ({ at: fmtHm(x.at), kind: x.kind, text: x.text, note: x.fromChat ? 'from a chat' : null })), { empty: 'NOTHING THIS DAY' }));
    initFolds($(root, '[data-slot="ld-th"]'));
  }

  async function loadThoughtDeed(v) {
    if (!v?.running || !DATE_RE.test(String(v.date || ''))) { setSlot(root, 'ld-td', thoughtDeedRows(null)); return; }
    let t = null;
    try {
      t = await api(`/api/life/thought-deed?date=${encodeURIComponent(v.date)}`, { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
    }
    if (!ctx.alive()) return;
    setSlots(root, { 'ld-td-note': t ? thoughtDeedNote(t) : 'UNAVAILABLE' });
    setSlot(root, 'ld-td', t ? thoughtDeedRows(t) : html`<div class="empty">UNAVAILABLE</div>`);
  }

  // The chat-influence lane of the shown day (past part only); a failed read → no labels.
  async function loadLane(v) {
    if (!v?.running || !Number.isSafeInteger(v.from) || !Number.isSafeInteger(v.to) || v.from >= Math.min(v.to, v.at ?? v.to)) return [];
    try {
      const r = await api(`/api/influence/lane?from=${v.from}&to=${Math.min(v.to, Math.ceil(v.at ?? v.to))}`, { signal: ctx.signal });
      return Array.isArray(r?.lane) ? r.lane : [];
    } catch (err) {
      if (isAbort(err)) throw err;
      return [];
    }
  }

  // 014: the day's trip map. Mounted once (Leaflet) per visit; redrawn only when the trips change.
  function ensureLeaf(m) {
    if (leaf || leafFailed || !wantsLeaflet(m)) return Promise.resolve(leaf);
    if (!leafTry) {
      leafBox.hidden = false;
      leafTry = mountMap(leafBox, { tileUrl: m.tileUrl, attribution: m.attribution, ctx }).then((h) => {
        leaf = h;
        if (!h) { leafFailed = true; leafBox.hidden = true; }
        return h;
      });
    }
    return leafTry;
  }

  async function loadMap(v) {
    if (!v?.running || !DATE_RE.test(String(v.date || ''))) { setSlots(root, { 'ld-map-note': '—' }); return; }
    let m;
    try {
      m = await api(`/api/life/map?date=${encodeURIComponent(v.date)}`, { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (ctx.alive()) setSlots(root, { 'ld-map-note': 'MAP UNAVAILABLE · SHOWING THE LAST READ' });
      return;
    }
    if (!ctx.alive() || !m?.running) return;
    const h = await ensureLeaf(m);
    if (!ctx.alive()) return;
    lastMap = m;
    setSlots(root, { 'ld-map-note': dayMapNote(m, h) });
    const next = leafSig(m);
    const nextMe = JSON.stringify(m.position && Number.isFinite(m.position.lat) ? [m.position.lat.toFixed(5), m.position.lon.toFixed(5), !!m.position.travelling] : null);
    if (next === mapSig && nextMe === meSig) return;
    const first = !mapSig;
    const changed = next !== mapSig;
    mapSig = next;
    meSig = nextMe;
    if (h) {
      setSlot(root, 'ld-map-svg', null);
      if (changed) drawLeaf(h, m, { labels: false });
      drawMe(h, m.position);
      if (first) h.fit(dayFitPoints(m));
    } else {
      setSlot(root, 'ld-map-svg', mapSvg(m));
    }
  }

  async function load() {
    const v = await api(`/api/life/day${date ? `?date=${encodeURIComponent(date)}` : ''}`, { signal: ctx.signal });
    if (!ctx.alive()) return;
    const l = await loadLane(v);
    if (!ctx.alive()) return;
    data = v;
    lane = l;
    paint();
    await Promise.all([loadMap(v), loadThoughtDeed(v), loadThoughts(v)]);
  }

  async function select(id, { scene = false } = {}) {
    selected = id;
    paint();
    openSide();
    const toScene = () => { if (scene && narrow()) $(root, '#ldSceneHead')?.scrollIntoView?.({ block: 'start' }); };
    toScene();
    const sceneId = sceneOf.get(id) ?? sceneOfDecision.get(id);
    if (sceneId && sceneId !== scenePanel.current()) {
      setSlots(root, { 'ld-scene-sel': `SCENE #${sceneId}` });
      scenePanel.show(sceneId);
    } else if (!sceneId && scenePanel.current()) {
      // A row without a scene never leaves another outing's scene standing beside it.
      scenePanel.clear();
      setSlots(root, { 'ld-scene-sel': 'NO SCENE FOR THIS ROW' });
    }
    setSlot(root, 'ld-why', html`<div class="loading">LOADING</div>`);
    try {
      const r = await api(`/api/life/events/${encodeURIComponent(id)}/explain`, { signal: ctx.signal });
      if (!ctx.alive() || selected !== id) return;
      setSlot(root, 'ld-why', r.chain?.length
        ? html`${chainList(r.chain, id)}<div class="mono mute">undo it on <a href="#life/timeline">Life · Timeline</a></div>`
        : html`<div class="empty">NO SUCH EVENT</div>`);
      toScene();
    } catch (err) {
      if (isAbort(err) || !ctx.alive()) return;
      setSlot(root, 'ld-why', html`<div class="empty">${err.message}</div>`);
    }
  }

  const pick = (e) => {
    const chip = e.target.closest?.('[data-scene]');
    if (chip && !e.target.closest?.('[data-ev]')) {
      const sid = Number(chip.dataset.scene);
      if (Number.isSafeInteger(sid) && sid > 0) {
        setSlots(root, { 'ld-scene-sel': `SCENE #${sid}` });
        scenePanel.show(sid);
        openSide();
        if (narrow()) $(root, '#ldSceneHead')?.scrollIntoView?.({ block: 'start' });
      }
      return;
    }
    const fold = e.target.closest?.('[data-quiet]');
    if (fold) {
      const k = fold.dataset.quiet;
      if (openQuiet.has(k)) openQuiet.delete(k); else openQuiet.add(k);
      paint();
      return;
    }
    const hit = e.target.closest?.('[data-ev]');
    const id = hit ? Number(hit.dataset.ev) : NaN;
    if (Number.isSafeInteger(id) && id > 0) select(id, { scene: !!chip });
  };
  const rowsEl = $(root, '[data-slot="ld-rows"]');
  ctx.listen(rowsEl, 'click', pick);
  ctx.listen(rowsEl, 'keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest?.('button')) { e.preventDefault(); pick(e); } });
  ctx.listen($(root, '#ldAllRows'), 'click', () => {
    allRows = !allRows;
    try { localStorage.setItem('ld.day.allRows', allRows ? '1' : '0'); } catch { /* per-visit only */ }
    paint();
  });
  ctx.listen($(root, '#ldSideClose'), 'click', () => closeSide());
  ctx.listen($(root, '#ldSideScrim'), 'click', () => closeSide());
  // A guide or a question opened from inside it answers its own Escape first.
  ctx.listen(document, 'keydown', (e) => { if (e.key === 'Escape' && side?.classList.contains('is-open') && !document.querySelector('dialog[open], .story-modal')) closeSide(); });
  ctx.listen($(root, '#ldPrev'), 'click', () => { if (data?.prev) go(data.prev); });
  ctx.listen($(root, '#ldNext'), 'click', () => { if (data?.next) go(data.next); });
  ctx.listen($(root, '#ldToday'), 'click', () => {
    if (!date || date === data?.range?.today) { scrolled = false; paint(); } else go(null);
  });

  try {
    await load();
  } catch (err) {
    if (isAbort(err) || !ctx.alive()) return;
    if (err?.status === 429) flash('TOO MANY DAY READS · TRY AGAIN IN A MINUTE', 'bad');
    showError(root, err);
    return;
  }
  ctx.setInterval(() => {
    if (!data?.today) return;
    load().catch((err) => {
      if (isAbort(err)) return;
      if (err?.status === 429) { setSlots(root, { 'ld-proj': 'RATE LIMITED · SHOWING THE LAST READ' }); return; }
      console.warn('life day poll', err);
    });
  }, POLL_MS);
}
