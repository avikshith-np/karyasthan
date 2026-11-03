// LIFE · DIRECTOR — PLACES (spec 014 geo, plan §A3, §A4): real venues from
// OpenStreetMap. Lookups happen on the owner's click only:
//   SEARCH (Enter or the button; never as-you-type — the public geocoder
//   forbids autocomplete) → candidates held on the server under ids → NEW PLACE
//   or REPLACE an existing generic place → the normal Director preview → apply.
//   MAKE PLACES REAL → a job (nearest venue of the same kind per place, then
//   road routes) → a dry table of every swap (tick / untick, flagged long names
//   unticked) → preview → APPLY (held while a tick differs from the dry run:
//   RE-PREVIEW first, so APPLY never applies a table the owner has changed). REFRESH ROUTES → a job → preview → apply.
// Home, the family home, his office and cast homes are never switched (the
// server refuses them). Nothing is written until APPLY; each swap reverts on
// its own from the Timeline, or with a rewind. Every string reaches the DOM
// through html`` only; the page sends ids, never names or coordinates.
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, $ } from '../core/dom.js';
import { flash } from './flash.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL';
const JOB_POLL_MS = 2000;
const JOB_WAIT_MAX = 150;   // × 2 s

const dis = (off) => (off ? 'disabled' : '');
const km = (v) => (Number.isFinite(v) ? `${Math.round(v * 10) / 10} km` : '—');

/** The panel's static shell (the Director page places it in its own SHELL). */
export const placesPanelShell = html`<div class="panel ldp" data-panel="places">
  <div class="panel-head"><span>PLACES · REAL VENUES<button type="button" class="guide-q" data-guide="places" aria-label="Guide: places">?</button></span><span class="mono mute" data-slot="ldp-status">—</span></div>
  <div class="panel-body">
    <form id="ldpSearch" class="story-form" autocomplete="off">
      <label>FIND A VENUE <input type="text" name="q" maxlength="80" placeholder="name and area, e.g. a cafe you know"></label>
      <button type="submit" id="ldpSearchGo">SEARCH</button>
    </form>
    <div data-slot="ldp-results"></div>
    <div class="story-buttons" style="margin-top:12px">
      <button type="button" id="ldpRealify">MAKE PLACES REAL</button>
      <button type="button" id="ldpRoutes">REFRESH ROUTES</button>
    </div>
    <div data-slot="ldp-job"></div>
    <div data-slot="ldp-dry"></div>
    <div class="mono mute ldp-attr">${ATTRIBUTION} · lookups only when you click · home, the family home, his office and friends' homes stay generic</div>
  </div>
</div>`;

function statusText(g) {
  if (!g || g.enabled === false) return 'LOOKUPS OFF';
  const h = g.hosts || {};
  const on = (x) => (x?.configured ? 'ON' : 'OFF');
  return `SEARCH ${on(h.nominatim)} · NEARBY ${on(h.overpass)} · ROUTES ${on(h.osrm)}${g.today ? ` · TODAY ${g.today.count}/${g.today.cap}` : ''}`;
}

function resultsView(res, places, off) {
  const list = Array.isArray(res?.candidates) ? res.candidates : [];
  const dropped = res?.dropped || {};
  const nDropped = (dropped.unsafe_name || 0) + (dropped.out_of_region || 0) + (dropped.not_allowed || 0);
  if (!list.length) return html`<div class="empty">NO VENUE FOUND IN HIS AREA${nDropped ? ` · ${nDropped} RESULTS LEFT OUT` : ''}</div>`;
  const swappable = places.filter((p) => p.kind !== 'home' && p.kind !== 'office');
  return html`<table class="data ldp-results"><thead><tr><th>VENUE</th><th>KIND</th><th>AREA</th><th>FROM HOME</th><th></th></tr></thead><tbody>
    ${list.map((c) => html`<tr>
      <td>${c.name}${(c.flags || []).length ? html` <span class="chip warn">${c.flags.join(', ')}</span>` : ''}</td>
      <td class="mono">${c.kind}</td><td>${c.area || '—'}</td><td class="mono">${km(c.distKmFromHome)}</td>
      <td class="ldp-acts">
        <button type="button" class="ldp-new" data-cand="${c.id}" ${dis(off)}>NEW PLACE</button>
        <select class="ldp-target" data-cand="${c.id}" aria-label="Place to replace">${swappable.map((p) => html`<option value="${p.id}">${p.name || p.id}</option>`)}</select>
        <button type="button" class="ldp-replace" data-cand="${c.id}" ${dis(off || !swappable.length)}>REPLACE</button>
      </td></tr>`)}
  </tbody></table>${nDropped ? html`<div class="mono mute">${nDropped} results left out (outside his area, not a public venue, or an unsafe name)</div>` : ''}`;
}

/** True when a tick differs from what the dry run was built with (APPLY would apply the old one). */
export function ticksChanged(p, ticks) {
  const rows = Array.isArray(p?.extra?.realify?.rows) ? p.extra.realify.rows : [];
  return rows.some((r) => ticks.has(r.placeId) && ticks.get(r.placeId) !== !!r.ticked);
}

/**
 * The places.realify action for the table as it is ticked now. It carries every
 * row's state, not just this round's changes: the server rebuilds the table from
 * the job result each time, so an untick made before an earlier RE-PREVIEW must
 * be sent again (the server reads `untick` for plain rows, `tick` for flagged ones).
 */
export function realifyActionOf(resultId, p, ticks) {
  const rows = (Array.isArray(p?.extra?.realify?.rows) ? p.extra.realify.rows : []).filter((r) => r.outcome === 'swap' || r.outcome === 'unticked');
  const on = (r) => (ticks.has(r.placeId) ? ticks.get(r.placeId) : !!r.ticked);
  const untick = rows.filter((r) => !on(r)).map((r) => r.placeId);
  const tick = rows.filter((r) => on(r)).map((r) => r.placeId);
  return { kind: 'places.realify', resultId, ...(untick.length ? { untick } : {}), ...(tick.length ? { tick } : {}) };
}

export function dryView(p, ticks, off) {
  const t = p?.extra?.realify;
  if (!t) return null;
  const rows = Array.isArray(t.rows) ? t.rows : [];
  const kept = Array.isArray(t.kept) ? t.kept : [];
  const checked = (r) => (ticks.has(r.placeId) ? ticks.get(r.placeId) : r.ticked);
  const stale = ticksChanged(p, ticks);
  return html`<div class="ldp-dry">
    <div class="story-sub mono">DRY RUN · ${t.swaps} SWAP${t.swaps === 1 ? '' : 'S'} · ${t.routes} ROUTE${t.routes === 1 ? '' : 'S'} · ${t.unsafeName || 0} UNSAFE NAME${t.unsafeName === 1 ? '' : 'S'} LEFT OUT · NOTHING IS WRITTEN UNTIL APPLY</div>
    ${(p.warnings || []).length ? html`<ul class="story-warnings">${p.warnings.map((w) => html`<li class="amber">⚠ ${w}</li>`)}</ul>` : ''}
    <table class="data"><thead><tr><th></th><th>PLACE</th><th>NOW</th><th>BECOMES</th><th>AREA</th><th>MOVES</th><th>KIND</th><th>STATE</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr>
        <td><input type="checkbox" class="ldp-tick" data-place="${r.placeId}" ${checked(r) ? 'checked' : ''} ${dis(off || !['swap', 'unticked'].includes(r.outcome))} aria-label="Switch this place"></td>
        <td class="mono">${r.placeId}</td><td>${r.oldName || '—'}</td><td>${r.newName || '—'}${(r.flags || []).length ? html` <span class="chip warn">${r.flags.join(', ')}</span>` : ''}</td>
        <td>${r.area || '—'}</td><td class="mono">${km(r.movedKm)}</td><td class="mono">${r.kind || '—'}</td><td><span class="chip">${r.outcome}</span></td></tr>`)}
      ${kept.map((k) => html`<tr class="mute"><td></td><td class="mono">${k.placeId}</td><td>${k.name || '—'}</td><td>stays generic</td><td></td><td></td><td></td><td><span class="chip">${k.reason}</span></td></tr>`)}
    </tbody></table>
    <div class="story-buttons">
      <button type="button" id="ldpRepreview" ${dis(off)}>RE-PREVIEW WITH THESE TICKS</button>
      <button type="button" class="primary" id="ldpApply" ${dis(off || stale || !t.swaps)}>APPLY ${t.swaps} SWAP${t.swaps === 1 ? '' : 'S'}</button>
      ${stale ? html`<span class="mono amber">TICKS CHANGED · RE-PREVIEW FIRST</span>` : ''}
    </div>
  </div>`;
}

/**
 * Mount the panel's behaviour. deps: { openPreview(ctx, action, {title}) → {applied},
 * ro() → read-only?, places() → [{id, name, kind}], reload() }.
 */
export function mountPlacesPanel(ctx, root, deps) {
  const box = $(root, '[data-panel="places"]');
  if (!box) return { refresh: async () => {} };
  let geo = null;
  let results = null;
  let dry = null;            // the realify preview { previewId, fingerprint, extra, … }
  let dryResultId = null;
  const ticks = new Map();   // placeId → bool (owner's change from the row default)
  let busy = false;
  const off = () => deps.ro() || busy || !geo?.enabled;

  function paint() {
    setSlot(box, 'ldp-status', statusText(geo));
    if (results) setSlot(box, 'ldp-results', resultsView(results, deps.places(), off()));
    setSlot(box, 'ldp-dry', dry ? dryView(dry, ticks, off()) : null);
    for (const b of box.querySelectorAll('#ldpSearchGo, #ldpRealify, #ldpRoutes')) b.disabled = off();
    const routes = $(box, '#ldpRoutes');
    if (routes && !geo?.hosts?.osrm?.configured) routes.disabled = true;
  }

  async function refresh() {
    try { geo = await api('/api/places/geo-status', { signal: ctx.signal }); } catch (e) { if (isAbort(e)) throw e; geo = null; }
    if (ctx.alive()) paint();
  }

  async function runJob(path, label) {
    busy = true;
    paint();
    setSlot(box, 'ldp-job', html`<div class="loading">${label} · STARTING</div>`);
    try {
      const { jobId } = await api(path, { method: 'POST', body: {} });
      for (let i = 0; i < JOB_WAIT_MAX; i++) {
        await new Promise((r) => { ctx.setTimeout(r, JOB_POLL_MS); });
        if (!ctx.alive()) return null;
        const j = await api(`/api/places/jobs/${encodeURIComponent(jobId)}`, { signal: ctx.signal });
        setSlot(box, 'ldp-job', html`<div class="loading mono">${label} · ${String(j.phase || '').toUpperCase()} ${j.done ?? 0}/${j.total ?? 0}</div>`);
        if (j.phase === 'done') { setSlot(box, 'ldp-job', null); return j.resultId; }
        if (j.phase === 'failed') { setSlot(box, 'ldp-job', html`<div class="red mono">${label} FAILED · ${j.error || 'lookup failed'} · NOTHING CHANGED</div>`); return null; }
      }
      setSlot(box, 'ldp-job', html`<div class="red mono">${label} TIMED OUT · NOTHING CHANGED</div>`);
      return null;
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) setSlot(box, 'ldp-job', html`<div class="red mono">${label} · ${err.message}</div>`);
      return null;
    } finally {
      busy = false;
      if (ctx.alive()) paint();
    }
  }

  const realifyAction = () => realifyActionOf(dryResultId, dry, ticks);

  async function previewRealify() {
    try {
      dry = await api('/api/director/preview', { method: 'POST', body: { action: realifyAction() } });
    } catch (err) {
      if (!isAbort(err)) flash(err.message, 'bad');
      dry = null;
    }
    ticks.clear();
    if (ctx.alive()) paint();
  }

  // Submitted on Enter or SEARCH only — no input listener (no autocomplete).
  ctx.listen($(box, '#ldpSearch'), 'submit', async (e) => {
    e.preventDefault();
    const q = String(e.target.elements.namedItem('q').value || '').trim();
    if (!q) { flash('WRITE A VENUE NAME', 'bad'); return; }
    busy = true;
    paint();
    setSlot(box, 'ldp-results', html`<div class="loading">LOOKING UP</div>`);
    try {
      results = await api('/api/places/search', { method: 'POST', body: { q } });
    } catch (err) {
      results = null;
      if (!isAbort(err) && ctx.alive()) setSlot(box, 'ldp-results', html`<div class="red mono">${err.message} · NOTHING CHANGED</div>`);
    } finally {
      busy = false;
      if (ctx.alive()) paint();
    }
  });
  ctx.listen(box, 'change', (e) => {
    const t = e.target;
    if (!t.classList?.contains('ldp-tick')) return;
    ticks.set(t.dataset.place, !!t.checked);
    // The dry run was built with the old ticks: APPLY waits for a RE-PREVIEW.
    if (!ctx.alive()) return;
    paint();
    box.querySelector(`input.ldp-tick[data-place="${CSS.escape(t.dataset.place)}"]`)?.focus();
  });
  ctx.listen(box, 'click', async (e) => {
    const t = e.target.closest?.('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('ldp-new')) {
      const r = await deps.openPreview(ctx, { kind: 'place.real', candidateId: t.dataset.cand, as: 'new' }, { title: 'NEW REAL PLACE' });
      if (r?.applied) deps.reload();
      return;
    }
    if (t.classList.contains('ldp-replace')) {
      const sel = box.querySelector(`select.ldp-target[data-cand="${CSS.escape(t.dataset.cand)}"]`);
      if (!sel?.value) return;
      const r = await deps.openPreview(ctx, { kind: 'place.real', candidateId: t.dataset.cand, as: 'replace', placeId: sel.value }, { title: `REPLACE ${sel.value}` });
      if (r?.applied) deps.reload();
      return;
    }
    if (t.id === 'ldpRealify') {
      dry = null;
      const resultId = await runJob('/api/places/realify', 'MAKE PLACES REAL');
      if (!resultId || !ctx.alive()) return;
      dryResultId = resultId;
      await previewRealify();
      return;
    }
    if (t.id === 'ldpRepreview') { await previewRealify(); return; }
    if (t.id === 'ldpApply' && dry && !ticksChanged(dry, ticks)) {
      busy = true;
      paint();
      try {
        await api('/api/director/apply', { method: 'POST', body: { previewId: dry.previewId, fingerprint: dry.fingerprint } });
        flash('PLACES SWITCHED · EACH ONE REVERTS ON ITS OWN FROM THE TIMELINE');
        dry = null;
        deps.reload();
      } catch (err) {
        if (!isAbort(err)) flash(`${err.message}${/stale|expired/.test(err.message) ? ' · RE-PREVIEW' : ''}`, 'bad');
      } finally {
        busy = false;
        if (ctx.alive()) paint();
      }
      return;
    }
    if (t.id === 'ldpRoutes') {
      const resultId = await runJob('/api/places/routes/refresh', 'REFRESH ROUTES');
      if (!resultId || !ctx.alive()) return;
      const r = await deps.openPreview(ctx, { kind: 'routes.refresh', resultId }, { title: 'REFRESH ROUTES' });
      if (r?.applied) deps.reload();
    }
  });

  return { refresh, paint };
}
