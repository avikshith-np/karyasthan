// CONTROL · REVIEW (plan 020 E4): one card at a time, big PASS / FAIL, a note code on a fail. Results by
// week and surface, and the failures as a download for the incident suite.
//
// A mark moves on at once and goes out behind the card, so a dropped connection doesn't stop the
// review: marks wait in this browser (ids and codes only, never words) and go when it's back.
// A private card's text isn't in the queue at all: it comes on a tap, and can't be marked unread.
// Every string reaches the DOM through html`` (escaped).
import { api, isAbort } from '../core/api.js';
import { html, render, slotPainter, setSlots, $ } from '../core/dom.js';
import { fmtTime } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { showError } from '../components/ui.js';
import { segments, kpi } from '../components/views.js';
import { readOnly } from './life-now.js';

const SEG_KEY = 'ld.review.seg';
const PENDING_KEY = 'ld.review.pending';
const SURFACE = { scene: 'SCENE', phone: 'TEXT', thought: 'THOUGHT', dream: 'DREAM' };
const NOTE_WORDS = {
  voice: 'NOT HIS VOICE', repetitive: 'REPETITIVE', continuity: 'CONTINUITY', time: 'WRONG TIME', invented: 'MADE UP',
  ai_tell: 'SOUNDS LIKE AI', too_long: 'TOO LONG', flat: 'FLAT', register: 'WRONG TONE', other: 'OTHER',
};
const GUARD_MS = 280;      // a second tap of a double tap must not mark the next card
const REFILL_BELOW = 3;
const RETRY_MS = 15_000;
const TOPBAR_PX = 52;
const STATS_AFTER_MS = 1500;   // marks come quickly: the counts follow, not every tap

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · REVIEW <button type="button" class="guide-q" data-guide="how" aria-label="Guide: review">?</button></div>
    <h1>Review</h1>
  </div>
  <div class="meta rv-head-meta"><span>LEFT <b class="amber" data-slot="rv-left">—</b></span><span>FAILED <b data-slot="rv-failed">—</b></span></div>
</div>
<div data-slot="rv-ro"></div>
<div data-slot="rv-net"></div>
<div data-slot="rv-seg"></div>
<div data-slot="rv-body"><div class="loading">LOADING</div></div>`;

// Marks waiting to go: [{ id, verdict, note }]. Storage can fail: they're then in memory only.
function readPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v) ? v.filter((m) => Number.isSafeInteger(m?.id) && (m.verdict === 'pass' || m.verdict === 'fail')) : [];
  } catch { return []; }
}
function writePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* memory only */ }
}

const metaLine = (c) => [c.dir === 'out' ? 'HE WROTE' : c.dir === 'in' ? 'TO HIM' : null, c.who?.length ? `WITH ${c.who.join(', ').toUpperCase()}` : null, c.kind ? String(c.kind).replace(/_/g, ' ').toUpperCase() : null, c.at ? fmtTime(c.at) : null].filter(Boolean).join(' · ');

export function cardView(c, { position, total, revealed, failing, ro, offline, canUndo = false }) {
  const hidden = c.private && revealed == null;
  const text = c.private ? revealed : c.text;
  const locked = ro || hidden;
  const pct = total > 0 ? Math.min(100, Math.round(((position - 1) / total) * 100)) : 0;
  return html`<article class="panel rv-card" tabindex="-1" aria-label="${SURFACE[c.surface] || c.surface} to review">
    <div class="rv-progress" role="progressbar" aria-label="Reviewed so far" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
    <div class="rv-top">
      <span class="chip">${SURFACE[c.surface] || c.surface}</span>
      ${c.private ? html`<span class="chip warn">PRIVATE</span>` : ''}
      ${c.tier ? html`<span class="mono mute">${String(c.tier).toUpperCase()}</span>` : ''}
      <span class="mono mute rv-pos">${position} OF ${total} · ${c.week}</span>
    </div>
    <div class="mono mute rv-meta">${metaLine(c)}</div>
    ${hidden
      ? html`<div class="rv-hidden"><p class="mute">Private. The words stay hidden until you ask.</p><button type="button" class="rv-reveal" ${offline ? 'disabled' : ''}>${offline ? 'NEEDS A CONNECTION' : 'TAP TO READ'}</button></div>`
      : html`<p class="rv-text">${text}</p>${c.private ? html`<div class="rv-hide-row"><button type="button" class="rv-hide">HIDE AGAIN</button></div>` : ''}`}
    ${c.truncated && !hidden ? html`<div class="mono mute">CUT AT ${String(text?.length ?? 0)} OF ${c.length} CHARACTERS</div>` : ''}
    <div class="rv-bar">
      ${failing
        ? html`<div class="rv-why" role="group" aria-label="What was wrong">
            <div class="mono mute rv-why-q">WHAT WAS WRONG? (OPTIONAL)</div>
            <div class="rv-notes">${Object.entries(NOTE_WORDS).map(([k, w]) => html`<button type="button" class="rv-note" data-note="${k}">${w}</button>`)}</div>
            <div class="rv-acts"><button type="button" class="rv-back">BACK</button><button type="button" class="danger rv-send">FAIL, NO NOTE</button></div>
          </div>`
        : html`<div class="rv-acts rv-main">
            <button type="button" class="rv-fail danger" data-write ${locked ? 'disabled' : ''}>FAIL</button>
            <button type="button" class="rv-pass primary" data-write ${locked ? 'disabled' : ''}>PASS</button>
          </div>
          <div class="rv-acts rv-small"><button type="button" class="rv-skip">SKIP</button><button type="button" class="rv-undo" data-write ${ro || !canUndo ? 'disabled' : ''}>UNDO LAST</button></div>`}
    </div>
  </article>`;
}

function resultsView(st, ro) {
  const rows = st.rows || [];
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  return html`
    <div class="rv-kpis">${(st.totals || []).map((t) => kpi({ label: SURFACE[t.surface], value: pct(t.passRate), sub: `${t.pass} PASS · ${t.fail} FAIL` }))}</div>
    <div class="panel"><div class="panel-head"><span>BY WEEK<button type="button" class="guide-q" data-guide="results" aria-label="Guide: results">?</button></span><span class="mono mute">A MARK STAYS COUNTED IF THE OUTPUT IS UNDONE</span></div>
      ${rows.length ? html`<div class="table-wrap"><table class="data"><thead><tr><th>WEEK</th><th>WHAT</th><th>SAMPLED</th><th>PASS</th><th>FAIL</th><th>LEFT</th><th>UNDONE</th><th>RATE</th></tr></thead><tbody>
        ${rows.map((r) => html`<tr><td class="mono">${r.week}</td><td>${SURFACE[r.surface]}</td><td>${r.sampled}</td><td>${r.pass}</td><td>${r.fail}</td><td>${r.left}</td><td>${r.gone}</td><td>${pct(r.passRate)}</td></tr>`)}
      </tbody></table></div>` : html`<div class="empty">NOTHING SAMPLED YET</div>`}
    </div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><span>WHAT WAS WRONG</span></div>
      ${st.notes?.length ? html`<div class="panel-body rv-notecounts">${st.notes.map((n) => html`<span class="chip">${SURFACE[n.surface]} · ${NOTE_WORDS[n.note] || n.note} · ${n.n}</span>`)}</div>` : html`<div class="empty">NO NOTES YET</div>`}
    </div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><span>FAILURES<button type="button" class="guide-q" data-guide="export" aria-label="Guide: export">?</button></span></div>
      <div class="panel-body rv-export">
        ${st.failures ? html`<a class="rv-download" href="/api/review/failures.json" download="review-failures.json">DOWNLOAD ${st.failures} AS STUBS</a>` : html`<span class="mute">Nothing failed yet.</span>`}
        <button type="button" class="rv-sample" data-write ${ro ? 'disabled' : ''}>SAMPLE THIS WEEK SO FAR</button>
      </div>
    </div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const paint = slotPainter(root);
  let seg = 'cards';
  try { seg = localStorage.getItem(SEG_KEY) === 'results' ? 'results' : 'cards'; } catch { /* the default */ }
  let cards = [];          // held in memory only, so a dropped connection can finish them
  let skipped = [];        // SKIP: back of the queue, after everything not seen yet
  let remaining = 0;       // unmarked, this card included
  let done = 0;
  const tally = { pass: 0, fail: 0 };   // this sitting, for the end of the queue
  let current = null;
  let revealed = null;
  let failing = false;
  let lastMarked = null;
  let lastCard = null;
  let pending = readPending();
  let flushing = false;
  let offline = false;
  let guardUntil = 0;
  let stats = null;

  const ro = () => readOnly();
  const queued = () => new Set(pending.map((m) => m.id));

  function paintChrome() {
    paint('rv-ro', ro() ? html`<div class="panel life-off"><div class="panel-body"><b class="amber">READ-ONLY</b> <span class="mute">You can read the cards. Marks need write mode (DASHBOARD_READONLY=false).</span></div></div>` : null);
    paint('rv-net', offline || pending.length
      ? html`<div class="panel life-off rv-net"><div class="panel-body"><b class="amber">${offline ? 'OFFLINE' : 'SENDING'}</b> <span class="mute">${pending.length} mark${pending.length === 1 ? '' : 's'} waiting. They go when the connection is back; you can keep going.</span></div></div>`
      : null);
    paint('rv-seg', segments([['cards', 'CARDS', remaining], ['results', 'RESULTS']], seg, { label: 'Review' }));
    setSlots(root, { 'rv-left': remaining, 'rv-failed': stats?.failures ?? '—' });
  }

  function paintBody() {
    if (seg === 'results') {
      render($(root, '[data-slot="rv-body"]'), stats ? resultsView(stats, ro()) : html`<div class="loading">LOADING</div>`);
      return;
    }
    const box = $(root, '[data-slot="rv-body"]');
    if (!current) {
      render(box, html`<div class="panel"><div class="empty rv-none">
        <p>${offline ? 'NO CARDS HELD HERE · BACK ONLINE FOR MORE' : done ? 'THAT WAS THE LAST ONE' : 'NOTHING TO REVIEW'}</p>
        ${!offline && done ? html`<p class="mono rv-tally">${tally.pass} PASS · ${tally.fail} FAIL THIS TIME</p>
          <button type="button" class="primary" data-seg="results">SEE THE RESULTS</button>
          <button type="button" class="rv-undo" data-write ${ro() || !lastCard ? 'disabled' : ''}>UNDO LAST</button>` : offline ? '' : html`<p class="mute rv-none-sub">A sample of each week's writing lands here after the week ends.</p>
          <button type="button" class="rv-sample" data-write ${ro() ? 'disabled' : ''}>SAMPLE THIS WEEK SO FAR</button>`}
      </div></div>`);
      return;
    }
    render(box, cardView(current, { position: done + 1, total: done + remaining, revealed, failing, ro: ro(), offline, canUndo: !!lastCard }));
  }

  function next() {
    current = cards.shift() ?? skipped.shift() ?? null;
    revealed = null;
    failing = false;
    guardUntil = Date.now() + GUARD_MS;
    paintBody();
    paintChrome();
    // Deep in a long one: back to the top of the next card, not the top of the page.
    const card = root.querySelector('.rv-card');
    if (card) {
      const top = card.getBoundingClientRect().top + window.scrollY - TOPBAR_PX;
      if (window.scrollY > top) window.scrollTo(0, Math.max(0, top));
      card.focus({ preventScroll: true });
    }
    if (cards.length < REFILL_BELOW) refill().catch(lostTouch);
  }

  const lostTouch = (err) => {
    if (isAbort(err) || err?.status || !ctx.alive()) return;
    offline = true;
    paintChrome();
    if (!current) paintBody();
  };
  async function refill() {
    if (offline) return;
    const held = () => { const ids = queued(); if (current) ids.add(current.id); for (const c of [...cards, ...skipped]) ids.add(c.id); return ids; };
    const q = await api(`/api/review/queue?limit=12&exclude=${[...held()].join(',')}`, { signal: ctx.signal });
    if (!ctx.alive()) return;
    const have = held();
    cards.push(...(q.cards || []).filter((c) => !have.has(c.id)));
    remaining = Math.max((q.left ?? 0) - pending.length, (current ? 1 : 0) + cards.length + skipped.length);
    if (!current && cards.length) next();
    else { paintChrome(); if (!current && seg === 'cards') paintBody(); }
  }

  async function flush() {
    if (flushing || !pending.length) return;
    flushing = true;
    let dropped = 0;
    let sent = 0;
    try {
      while (pending.length && ctx.alive()) {
        const m = pending[0];
        try {
          await api(`/api/review/items/${m.id}/mark`, { method: 'POST', body: { verdict: m.verdict, ...(m.note ? { note: m.note } : {}) } });
        } catch (err) {
          if (isAbort(err)) return;
          // The server answered no: this mark can't ever go (undone since, or marked elsewhere).
          if (err?.status === 404 || err?.status === 409 || err?.status === 400) dropped++;
          else {
            offline = !err?.status;
            return;
          }
        }
        offline = false;
        pending.shift();
        writePending(pending);
        sent++;
      }
    } finally {
      flushing = false;
      if (dropped && ctx.alive()) flash(dropped === 1 ? 'ONE MARK NOT COUNTED · THAT OUTPUT WAS UNDONE OR ALREADY MARKED' : `${dropped} MARKS NOT COUNTED · UNDONE OR ALREADY MARKED`);
      if (ctx.alive()) {
        paintChrome();
        if (seg === 'results') loadStats().catch(() => {});
        else if (sent) statsSoon();
      }
    }
  }

  function markCurrent(verdict, note = null) {
    if (!current || ro() || Date.now() < guardUntil) return;
    if (current.private && revealed == null) return;
    lastMarked = { id: current.id, verdict };
    lastCard = current;
    pending.push({ id: current.id, verdict, note });
    writePending(pending);
    done++;
    tally[verdict]++;
    remaining = Math.max(0, remaining - 1);
    flush();
    next();
  }

  async function undo() {
    if (!lastMarked || !lastCard) { flash('NOTHING TO UNDO'); return; }
    const { id, verdict } = lastMarked;
    const waiting = pending.findIndex((m) => m.id === id);
    if (waiting >= 0 && !(flushing && waiting === 0)) {
      pending.splice(waiting, 1);
      writePending(pending);
    } else {
      try {
        await flushDone();
        await api(`/api/review/items/${id}/unmark`, { method: 'POST', body: {} });
        statsSoon();
      } catch (err) {
        if (!isAbort(err)) flash(err?.status ? err.message : 'UNDO NEEDS A CONNECTION', 'bad');
        return;
      }
    }
    if (!ctx.alive()) return;
    if (current) cards.unshift(current);
    skipped = skipped.filter((c) => c.id !== lastCard.id);
    current = lastCard;
    done = Math.max(0, done - 1);
    tally[verdict] = Math.max(0, tally[verdict] - 1);
    remaining++;
    lastMarked = null;
    lastCard = null;
    revealed = null;
    failing = false;
    guardUntil = Date.now() + GUARD_MS;
    paintBody();
    paintChrome();
  }
  const flushDone = async () => { for (let i = 0; flushing && i < 50; i++) await new Promise((r) => setTimeout(r, 100)); };

  let statsTimer = null;
  function statsSoon() {
    if (statsTimer) return;
    statsTimer = ctx.setTimeout(() => { statsTimer = null; loadStats().catch(() => {}); }, STATS_AFTER_MS);
  }
  async function loadStats() {
    stats = await api('/api/review/stats', { signal: ctx.signal });
    if (!ctx.alive()) return;
    paintChrome();
    if (seg === 'results') paintBody();
  }

  async function sampleNow(btn) {
    btn.disabled = true;
    try {
      const r = await api('/api/review/sample', { method: 'POST', body: {} });
      flash(r.added ? `${r.added} ADDED FROM ${r.week}` : `NOTHING NEW IN ${r.week}`);
      await refill();
      await loadStats();
    } catch (err) {
      if (!isAbort(err)) flash(err.message, 'bad');
    }
    if (ctx.alive()) { btn.disabled = false; paintBody(); }
  }

  ctx.listen(root, 'click', async (e) => {
    const t = e.target.closest?.('button');
    if (!t || t.disabled) return;
    if (t.dataset.seg) {
      seg = t.dataset.seg;
      try { localStorage.setItem(SEG_KEY, seg); } catch { /* not remembered, then */ }
      paintChrome();
      paintBody();
      if (seg === 'results') loadStats().catch((err) => { if (!isAbort(err)) flash(err.message, 'bad'); });
      return;
    }
    if (t.classList.contains('rv-pass')) { markCurrent('pass'); return; }
    if (t.classList.contains('rv-fail')) {
      if (Date.now() < guardUntil) return;
      failing = true;
      guardUntil = Date.now() + GUARD_MS;   // the double tap's second half mustn't land on a note
      paintBody();
      return;
    }
    if (t.classList.contains('rv-back')) { failing = false; paintBody(); return; }
    if (t.classList.contains('rv-send')) { markCurrent('fail'); return; }
    if (t.classList.contains('rv-note')) { markCurrent('fail', t.dataset.note); return; }
    if (t.classList.contains('rv-skip')) {
      if (!current) return;
      const c = current;
      if (!cards.length && !skipped.length) { flash('THE ONLY CARD HELD HERE'); return; }
      skipped.push(c);
      next();
      return;
    }
    if (t.classList.contains('rv-undo')) { undo(); return; }
    if (t.classList.contains('rv-hide')) { revealed = null; paintBody(); return; }
    if (t.classList.contains('rv-sample')) { sampleNow(t); return; }
    if (t.classList.contains('rv-reveal')) {
      const id = current?.id;
      t.disabled = true;
      try {
        const r = await api(`/api/review/items/${id}/text`, { signal: ctx.signal });
        if (ctx.alive() && current?.id === id) { revealed = r.text; current = { ...current, truncated: r.truncated, length: r.length }; paintBody(); }
      } catch (err) {
        if (isAbort(err) || !ctx.alive()) return;
        if (err?.status === 409) { flash('THAT ONE WAS UNDONE · IT LEFT THE QUEUE'); remaining = Math.max(0, remaining - 1); next(); return; }
        flash(err?.status ? err.message : 'NEEDS A CONNECTION', 'bad');
        t.disabled = false;
      }
    }
  });

  // The server can be out of reach with the phone still "online" (a dropped tunnel), so a timer
  // tries too; the browser's events only make it quicker.
  const retry = async () => {
    if (!offline && !pending.length) return;
    const was = offline;
    offline = false;
    try {
      await flush();
      if (offline) return;
      await refill();
      if (was && ctx.alive()) { paintChrome(); if (current?.private && revealed == null) paintBody(); }
    } catch (err) { lostTouch(err); }
  };
  const goOffline = () => { offline = true; paintChrome(); paintBody(); };
  ctx.listen(window, 'online', retry);
  ctx.listen(window, 'offline', goOffline);
  ctx.setInterval(retry, RETRY_MS);

  try {
    offline = globalThis.navigator?.onLine === false;
    paintChrome();
    await flush();
    if (!offline) await refill();
    if (!ctx.alive()) return;
    paintChrome();
    paintBody();
    await loadStats();
  } catch (err) {
    if (isAbort(err) || !ctx.alive()) return;
    if (!err?.status) { lostTouch(err); paintBody(); return; }
    showError(root, err);
  }
}
