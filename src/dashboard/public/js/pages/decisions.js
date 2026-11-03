// 05 DECISIONS — last 200 evaluations, live via the shared stream (topic `decisions`).
//
// response_log.decided: the pipeline writes skip | text | reaction | text_and_reaction;
// dashboard force-sends write text | gif | sticker | voice | sing (| image). Anything
// that isn't 'skip' fired — an unknown future type still counts as FIRE, never SKIP
// (cleanup F3). An explicit image request that overrode a skip is logged as 'text'
// with factors.imageOverride. A skip's row score is 0; its computed probability is
// factors.finalScore, which the feed and breakdown show when present.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtClock, fmtHm, hourOf } from '../core/fmt.js';
import { renderSparkbar, showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · DECISIONS · WHY HE ANSWERED OR STAYED QUIET</div>
    <h1>Decisions</h1>
  </div>
  <div class="meta">
    <span>SAMPLES <b data-slot="dec-samples">—</b></span>
    <span>FIRED <b class="red" data-slot="dec-fired">—</b></span>
    <span>RATE <b data-slot="dec-rate">—</b></span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>DECISIONS · WINDOW</span></div><div class="val mono" data-slot="dec-kpi-eval">—</div><div class="sub" data-slot="dec-kpi-eval-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>FIRED</span></div><div class="val mono" data-slot="dec-kpi-fired">—</div><div class="sub" data-slot="dec-kpi-fired-sub">TEXT — · REACT —</div></div>
  <div class="kpi"><div class="lab"><span>QUALITY · GATED</span></div><div class="val mono amber" data-slot="dec-kpi-gated">—</div><div class="sub">post-LLM rejected</div></div>
  <div class="kpi alert"><div class="lab"><span>BS DETECTED</span></div><div class="val mono red-bright" data-slot="dec-kpi-bs">—</div><div class="sub">factor.bs &gt; 1 · forwards, humblebrags</div></div>
</div>

<div class="col-2" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>LIVE · LAST 200 DECISIONS<button type="button" class="guide-q" data-guide="feed" aria-label="Guide: live · last 200 decisions">?</button></span><span class="dot-live"></span></div>
    <div style="max-height:540px;overflow-y:auto" data-slot="dec-feed"></div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>FACTORS · LATEST FIRE<button type="button" class="guide-q" data-guide="factors" aria-label="Guide: factors · latest fire">?</button></span><span class="mono mute" data-slot="dec-factor-target">—</span></div>
    <div class="panel-body">
      <div class="factor-bar"><span class="label">MENTION</span><span class="track"><span class="f" data-slot="dec-f-mention" style="width:0%"></span></span><span class="num" data-slot="dec-n-mention">—</span></div>
      <div class="factor-bar"><span class="label">QUESTION</span><span class="track"><span class="f" data-slot="dec-f-question" style="width:0%"></span></span><span class="num" data-slot="dec-n-question">—</span></div>
      <div class="factor-bar"><span class="label">COMMAND</span><span class="track"><span class="f" data-slot="dec-f-command" style="width:0%"></span></span><span class="num" data-slot="dec-n-command">—</span></div>
      <div class="factor-bar"><span class="label">HUMOR</span><span class="track"><span class="f" data-slot="dec-f-humor" style="width:0%;background:var(--ink-3)"></span></span><span class="num" data-slot="dec-n-humor">—</span></div>
      <div class="factor-bar"><span class="label">MOMENTUM</span><span class="track"><span class="f" data-slot="dec-f-momentum" style="width:0%"></span></span><span class="num" data-slot="dec-n-momentum">—</span></div>
      <div class="factor-bar"><span class="label">RECENCY</span><span class="track"><span class="f" data-slot="dec-f-recency" style="width:0%"></span></span><span class="num" data-slot="dec-n-recency">—</span></div>
      <div class="factor-bar"><span class="label">BS-DETECT</span><span class="track"><span class="f" data-slot="dec-f-bs" style="width:0%;background:var(--green)"></span></span><span class="num" data-slot="dec-n-bs">—</span></div>
      <div class="factor-bar"><span class="label">CONVO</span><span class="track"><span class="f" data-slot="dec-f-conversation" style="width:0%"></span></span><span class="num" data-slot="dec-n-conversation">—</span></div>
      <div class="mute mono" style="font-size: var(--t-label);margin-top:4px">BARS ARE RELATIVE TO EACH FACTOR'S MAXIMUM · ×1.00 = NEUTRAL</div>
      <div class="divider" style="margin:10px 0"></div>
      <div class="factor-bar" style="font-weight:700"><span class="label">SCORE</span><span class="track"><span class="f" data-slot="dec-f-score" style="width:0%"></span></span><span class="num red-bright" data-slot="dec-n-score">—</span></div>
      <div class="mute mono" style="font-size: var(--t-label);margin-top:8px">DECISION <b class="red-bright" data-slot="dec-decision">—</b></div>

      <div class="divider-thick" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size: var(--t-label);margin-bottom:6px">DECISIONS PER HOUR · 24H</div>
      <div class="sparkbar" style="height:50px" data-slot="dec-sparkbar"></div>
      <div class="mute mono" style="font-size: var(--t-label);display:flex;justify-content:space-between;margin-top:4px"><span>00:00</span><span data-slot="dec-now">—</span><span>23:59</span></div>
    </div>
  </div>
</div>
`);

export const DECISION_LABELS = {
  text: ['red-bright', 'TEXT'],
  reaction: ['amber', 'REACT'],
  text_and_reaction: ['red-bright', 'TEXT+REACT'],
  voice: ['red-bright', 'VOICE'],
  sing: ['red-bright', 'SING'],
  gif: ['amber', 'GIF'],
  sticker: ['amber', 'STICKER'],
  image: ['red-bright', 'IMAGE'],
};
const TEXTUAL = new Set(['text', 'text_and_reaction']);
const REACTS = new Set(['reaction', 'text_and_reaction']);

export const decisionFired = (d) => !!d && d !== 'skip';

export function decisionLabel(d) {
  if (!d) return html`<b class="mute">—</b>`;
  if (d === 'skip') return html`<b class="mute">SKIP</b>`;
  const [cls, name] = DECISION_LABELS[d] || ['red-bright', String(d).toUpperCase()];
  return html`<b class="${cls}">FIRE · ${name}</b>`;
}

/** Counts for the KPIs: fired = anything but skip; media = fired and neither text nor react. */
export function decisionCounts(rows) {
  let fired = 0; let text = 0; let react = 0; let media = 0; let bs = 0;
  for (const r of rows) {
    const d = r.decided;
    if (decisionFired(d)) {
      fired++;
      if (TEXTUAL.has(d)) text++;
      if (REACTS.has(d)) react++;
      if (!TEXTUAL.has(d) && !REACTS.has(d)) media++;
    }
    if ((r.factors?.bs ?? 1) > 1) bs++;   // computeBsFactor: 1.0 neutral, 2.5 / 3.5 on a hit
  }
  return { fired, text, react, media, bs };
}

const MAX_ROWS = 200;
// The eight engine factors and the largest value each can take (decisionEngine.js),
// so a bar shows how close a multiplier came to its ceiling; the number is the ×value.
const FACTOR_MAX = { mention: 6, question: 2.5, command: 3, humor: 1.8, momentum: 1.3, recency: 1, bs: 3.5, conversation: 1.2 };
const FACTORS = Object.keys(FACTOR_MAX);

/** The probability a decision was rolled against: a skip keeps it in factors.finalScore. */
export const scoreOf = (r) => (typeof r?.factors?.finalScore === 'number' ? r.factors.finalScore : r?.score);

const fromEvent = (ev) => ({
  messageId: ev.messageId,
  groupJid: ev.groupJid,
  score: ev.score,
  decided: ev.decided,
  factors: ev.factors || {},
  createdAt: ev.ts ? Math.floor(ev.ts / 1000) : Math.floor(Date.now() / 1000),
  message: ev.content ? { senderName: ev.senderName, content: ev.content } : null,
});

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  let rows = null;
  let pending = [];
  let gatedCount = 0;

  function paint() {
    const c = decisionCounts(rows);
    setSlots(root, {
      'dec-samples': rows.length,
      'dec-fired': c.fired,
      'dec-rate': rows.length ? `${((c.fired / rows.length) * 100).toFixed(1)}%` : '—',
      'dec-kpi-eval': rows.length.toLocaleString(),
      'dec-kpi-eval-sub': `last ${rows.length} evaluations`,
      'dec-kpi-fired': c.fired,
      'dec-kpi-fired-sub': `TEXT ${c.text} · REACT ${c.react}${c.media ? ` · MEDIA ${c.media}` : ''}`,
      'dec-kpi-gated': gatedCount,
      'dec-kpi-bs': c.bs,
    });

    setSlot(root, 'dec-feed', rows.length
      ? rows.slice(0, 60).map((r) => html`<div class="logline" style="grid-template-columns:60px 1fr"><span class="lt">${r.createdAt ? fmtClock(r.createdAt) : '—'}</span><span>${decisionLabel(r.decided)} <span class="mono mute">[${typeof scoreOf(r) === 'number' ? scoreOf(r).toFixed(2) : '—'}]</span>${r.factors?.imageOverride ? html` <span class="pill warn">IMAGE ASK</span>` : null} · ${r.message?.senderName || '—'} · ${(r.message?.content || '[message gone]').slice(0, 100)}</span></div>`)
      : html`<div class="empty">NO DECISIONS YET</div>`);

    // Factor breakdown — the latest row that fired (else the latest row).
    const latest = rows.find((r) => decisionFired(r.decided)) || rows[0];
    if (latest) {
      const f = latest.factors || {};
      const setBar = (slot, value, max, mult) => {
        const v = typeof value === 'number' ? value : null;
        const bar = $(root, `[data-slot="dec-f-${slot}"]`);
        if (bar) bar.style.width = v != null ? `${Math.max(0, Math.min(100, Math.round((v / max) * 100)))}%` : '0%';
        const num = $(root, `[data-slot="dec-n-${slot}"]`);
        if (num) num.textContent = v != null ? `${mult ? '×' : ''}${v.toFixed(2)}` : '—';
      };
      for (const k of FACTORS) setBar(k, f[k], FACTOR_MAX[k], true);
      const sc = scoreOf(latest);
      setBar('score', sc, 1, false);
      setSlots(root, {
        'dec-factor-target': `${String(latest.message?.senderName || '—').toUpperCase()} · ${typeof sc === 'number' ? sc.toFixed(2) : '—'}`,
      });
      setSlot(root, 'dec-decision', decisionLabel(latest.decided));
    }

    // Evaluations per hour of day, in the bot's timezone.
    const hourly = new Array(24).fill(0);
    for (const r of rows) {
      const h = r.createdAt ? hourOf(r.createdAt) : null;
      if (h != null) hourly[h]++;
    }
    renderSparkbar($(root, '[data-slot="dec-sparkbar"]'), hourly, 5);
    setSlots(root, { 'dec-now': fmtHm(Date.now()) });
  }

  // Subscribe before the fetch so nothing decided meanwhile is lost; events that
  // arrive first are held until the initial rows are in.
  ctx.on('decisions', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const row = fromEvent(ev);
    if (!rows) { pending.push(row); return; }
    rows.unshift(row);
    if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
    paint();
  });

  try {
    const [initial, q] = await Promise.all([
      api('/api/decisions?limit=200', { signal: ctx.signal }),
      api('/api/quality', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { stats: {} }; }),
    ]);
    if (!ctx.alive()) return;
    gatedCount = q?.stats?.gated_count ?? 0;
    const list = Array.isArray(initial) ? initial : [];
    const seen = new Set(list.map((r) => `${r.messageId}|${r.decided}`));
    rows = [...pending.filter((r) => !seen.has(`${r.messageId}|${r.decided}`)).reverse(), ...list].slice(0, MAX_ROWS);
    pending = [];
    paint();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
  }
}
