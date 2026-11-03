// LIFE · JOURNAL (spec 010 T022, director-api §7, contracts/journal.md) — his
// private diary, one night at a time, written per origin: a "self" part from
// his own day and one part per chat whose adopted claims shaped it. Each part
// carries its origin badge (originCell). Dashboard-only: the journal never
// reaches a prompt. REGENERATE re-writes one night (2/hour); "WHAT'S ON HIS
// MIND" narrates his current thought (2/min, 20/h, 100/day; cached).
// Polls every 60 s. Diary and narration text reach the DOM through html`` only.
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, slotPainter, setSlots, $ } from '../core/dom.js';
import { flash } from '../components/flash.js';
import { showError } from '../components/ui.js';
import { askSheet } from '../components/sheet.js';
import { originCell } from '../components/provenance.js';
import { readOnly } from './life-now.js';
import { arcsStatus, arcsOffNote, upper } from './life-cast.js';

const POLL_MS = 60_000;

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · JOURNAL · HIS NIGHTS, IN HIS WORDS · NEVER IN A PROMPT</div>
    <h1>Journal</h1>
  </div>
  <div class="meta">
    <span>NIGHT <b data-slot="lj-night">—</b></span>
    <span>STATUS <b data-slot="lj-status">—</b></span>
  </div>
</div>
<div data-slot="lj-off"></div>
<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>THE NIGHT<button type="button" class="guide-q" data-guide="night" aria-label="Guide: night">?</button></span></div>
    <div class="lj-acts"><button type="button" id="ljPublish" title="Public site: publish this night's self part">PUBLISH</button> <button type="button" id="ljRegen">REGENERATE THIS NIGHT</button></div>
    <div class="panel-body" data-slot="lj-parts"><div class="loading">LOADING</div></div>
  </div>
  <div class="panel">
    <div class="panel-head"><span>NIGHTS<button type="button" class="guide-q" data-guide="nights" aria-label="Guide: nights">?</button></span><span class="mono mute">LAST 60</span></div>
    <div class="story-scroll" data-slot="lj-nights"></div>
    <div class="panel-head"><span>WHAT'S ON HIS MIND<button type="button" class="guide-q" data-guide="thought" aria-label="Guide: thought">?</button></span><button type="button" id="ljThought">NARRATE</button></div>
    <div class="panel-body" data-slot="lj-thought"><div class="mute">On demand; the narration is cached and never reaches a chat.</div></div>
  </div>
</div>`;

const STATUS_CLASS = { done: 'ok', partial: 'warn', failed: 'bad', skipped: '', missed: '', running: 'warn' };

function partView(p) {
  const row = { origin_kind: p.originKind, origin_label: p.originLabel };
  return html`<div class="story-part ${p.status !== 'active' ? 'is-off' : ''}">
    <div class="mono">${originCell(row)}${p.status && p.status !== 'active' ? html` <span class="chip ${p.status === 'fenced' ? 'bad' : ''}">${upper(p.status)}</span>` : ''}</div>
    <p class="story-diary">${p.status === 'fenced' ? html`<span class="mute">(forgotten: this part is fenced and will not be rebuilt)</span>` : p.text || html`<span class="mute">—</span>`}</p>
  </div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const paintSlot = slotPainter(root);
  let selected = null;   // night key, null = the latest
  let published = new Set();

  async function load() {
    const st = await arcsStatus(ctx);
    if (!ctx.alive()) return;
    const [nights, night, pub] = await Promise.all([
      api('/api/arcs/journal/nights?limit=60', { signal: ctx.signal }),
      api(`/api/arcs/journal${selected ? `?night=${encodeURIComponent(selected)}` : ''}`, { signal: ctx.signal }),
      api('/api/arcs/journal/published', { signal: ctx.signal }).catch(() => ({ nights: [] })),
    ]);
    if (!ctx.alive()) return;
    const list = Array.isArray(nights?.nights) ? nights.nights : [];
    const ro = readOnly();
    paintSlot('lj-off', arcsOffNote(st));
    setSlots(root, { 'lj-night': night?.night || '—', 'lj-status': night?.status ? `${upper(night.status)}${night.reason ? ` · ${upper(night.reason)}` : ''}` : '—' });
    const regen = $(root, '#ljRegen');
    if (regen) regen.disabled = ro || !night?.night || !st.enabled;
    const thought = $(root, '#ljThought');
    if (thought) thought.disabled = ro || !st.enabled;
    const parts = Array.isArray(night?.parts) ? night.parts : [];
    // 013: PUBLISH puts this night's self part on the public site (frozen, scrubbed);
    // chat parts are never published. UNPUBLISH takes it off at the next export.
    published = new Set((Array.isArray(pub?.nights) ? pub.nights : []).map((n) => n.night));
    const pubBtn = $(root, '#ljPublish');
    if (pubBtn) {
      const isPub = !!night?.night && published.has(night.night);
      const selfOk = parts.some((p) => p.originKind === 'self' && p.status === 'active' && p.text);
      pubBtn.textContent = isPub ? 'UNPUBLISH' : 'PUBLISH';
      pubBtn.dataset.mode = isPub ? 'unpublish' : 'publish';
      pubBtn.disabled = ro || !night?.night || (!isPub && (!selfOk || !st.enabled));
    }
    paintSlot('lj-parts', parts.length ? parts.map(partView)
      : html`<div class="empty">${night?.enabled ? 'NO DIARY FOR THIS NIGHT' : 'ARCS IS OFF'}</div>`);
    paintSlot('lj-nights', list.length
      ? html`<table class="data"><tbody>${list.map((n) => html`<tr class="${n.night === (night?.night ?? null) ? 'self' : ''}">
          <td><button type="button" class="lj-pick" data-night="${n.night}">${n.night}</button>${published.has(n.night) ? html` <span class="chip ok">PUBLIC</span>` : ''}</td>
          <td><span class="chip ${STATUS_CLASS[n.status] ?? ''}">${upper(n.status)}</span></td>
          <td class="mono mute">${Number.isFinite(n.parts) ? `${n.parts} part${n.parts === 1 ? '' : 's'}` : ''}</td></tr>`)}</tbody></table>`
      : html`<div class="empty">NO NIGHTS YET</div>`);
  }

  ctx.listen(root, 'click', async (e) => {
    const pick = e.target.closest?.('.lj-pick');
    if (pick) { selected = pick.dataset.night; load().catch((err) => { if (!isAbort(err)) flash(err.message, 'bad'); }); return; }
    const btn = e.target.closest?.('button');
    if (!btn || btn.disabled) return;
    if (btn.id === 'ljPublish') {
      const night = $(root, '[data-slot="lj-night"]')?.textContent;
      if (!night || night === '—') return;
      const un = btn.dataset.mode === 'unpublish';
      const { ok } = await askSheet(un
        ? { label: 'Off the public site', text: `Take the entry for ${night} off the public site?`, action: 'UNPUBLISH', danger: true }
        : { label: 'Publish this night', text: `Publish his own part of ${night} on the public site? Chat parts are never published.`, action: 'PUBLISH', danger: true });
      if (!ok || !ctx.alive()) return;
      btn.disabled = true;
      try {
        await api(`/api/arcs/journal/${encodeURIComponent(night)}/${un ? 'unpublish' : 'publish'}`, { method: 'POST', body: {} });
        flash(un ? `UNPUBLISHED · ${night}` : `PUBLISHED · ${night}`);
      } catch (err) {
        if (!isAbort(err)) flash(err.message, 'bad');
      }
      if (ctx.alive()) load().catch(() => {});
      return;
    }
    if (btn.id === 'ljRegen') {
      const night = $(root, '[data-slot="lj-night"]')?.textContent;
      if (!night || night === '—') return;
      const { ok } = await askSheet({ label: 'Regenerate the diary', text: `Write the diary for ${night} again? This replaces what is there and spends a model call. 2 per hour.`, action: 'REGENERATE', keep: 'NOT NOW' });
      if (!ok || !ctx.alive()) return;
      btn.disabled = true;
      try {
        const r = await api(`/api/arcs/journal/${encodeURIComponent(night)}/regenerate`, { method: 'POST', body: {} });
        flash(`NIGHT ${night} · ${upper(r?.status || 'done')}`);
      } catch (err) {
        if (!isAbort(err)) flash(err.message, 'bad');
      }
      if (ctx.alive()) load().catch(() => {});
    } else if (btn.id === 'ljThought') {
      btn.disabled = true;
      setSlot(root, 'lj-thought', html`<div class="loading">NARRATING</div>`);
      try {
        const r = await api('/api/arcs/narrate', { method: 'POST', body: { thought: true } });
        if (ctx.alive()) {
          setSlot(root, 'lj-thought', html`<p class="story-diary">${r?.text || ''}</p>
            <div class="mono mute">${(r?.origins || []).map((o) => html`<span class="chip">${o}</span>`)}${r?.cached ? ' · CACHED' : ''}</div>`);
        }
      } catch (err) {
        if (!isAbort(err) && ctx.alive()) setSlot(root, 'lj-thought', html`<div class="red mono">${err.message}</div>`);
      } finally {
        if (ctx.alive()) btn.disabled = readOnly();
      }
    }
  });

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life journal poll', err); }); }, POLL_MS);
}
