// PUBLIC SITE (spec 013) — the exporter's status, the exact JSON the site gets,
// the people shown by name, and the kill switch. Everything here is public data by
// construction (the exporter's filter + scrubber + schema ran on it); the people table
// is the operator view (their real names, so you know who is who). Polls every 30 s.
// Text reaches the DOM through html`` only.
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, setSlots, $ } from '../core/dom.js';
import { fmtTime, fmtRelative } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { showError } from '../components/ui.js';
import { readOnly } from './life-now.js';

const POLL_MS = 30_000;

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · PUBLIC SITE · A FILTERED SNAPSHOT OF HIS LIFE, PUSHED TO CLOUDFLARE</div>
    <h1>Public site</h1>
  </div>
  <div class="meta">
    <span>SKILL <b data-slot="ps-skill">—</b></span>
    <span>LAST EXPORT <b data-slot="ps-last">—</b></span>
    <span>UPLOAD <b data-slot="ps-upload">—</b></span>
  </div>
</div>
<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>STATUS<button type="button" class="guide-q" data-guide="status" aria-label="Guide: status">?</button></span>
      <span><button type="button" id="psExport">EXPORT NOW</button> <button type="button" class="danger" id="psTakedown">TAKE OFFLINE</button></span></div>
    <div class="panel-body" data-slot="ps-status"><div class="loading">LOADING</div></div>
    <div class="panel-head" style="border-top:1px solid var(--line-2)"><span>PEOPLE SHOWN BY NAME<button type="button" class="guide-q" data-guide="people" aria-label="Guide: people">?</button></span></div>
    <div class="panel-body" data-slot="ps-people"></div>
  </div>
  <div class="panel">
    <div class="panel-head"><span>WHAT'S PUBLIC NOW<button type="button" class="guide-q" data-guide="preview" aria-label="Guide: preview">?</button></span><span class="mono mute" data-slot="ps-size">—</span></div>
    <div class="panel-body"><pre class="mono" style="white-space:pre-wrap;max-height:70vh;overflow:auto;font-size: var(--t-meta)" data-slot="ps-preview"></pre></div>
  </div>
</div>`;

const kb = (n) => (Number.isFinite(n) ? `${(n / 1024).toFixed(1)} KB` : '—');

function statusView(s) {
  const issue = s.lastIssue;
  const rows = [
    ['R2', s.r2 === 'configured' ? html`<span class="chip ok">CONFIGURED</span>` : html`<span class="chip warn">${String(s.r2 || '—').toUpperCase()}</span>`],
    ['VOTES WORKER', s.votes === 'configured' ? html`<span class="chip ok">CONFIGURED</span>` : html`<span class="chip">${String(s.votes || '—').toUpperCase()}</span>`],
    ['SITE DATA URL', s.publicUrl ? html`<a href="${s.publicUrl}" target="_blank" rel="noopener noreferrer">${s.publicUrl}</a>` : html`<span class="mute">PUBLIC_JSON_URL not set</span>`],
    ['DRY_RUN', s.dryRun ? html`<span class="chip warn">ON · local file only</span>` : 'off'],
    ['EVERY', `${s.intervalMinutes} min while the skill is on`],
    ['LAST BUILD', s.last?.status ? html`<span class="chip ${s.last.status === 'ok' ? 'ok' : 'bad'}">${s.last.status.toUpperCase()}</span> ${s.last.at ? fmtTime(s.last.at) : ''}${s.last.status === 'history_too_large' ? html` <span class="red">· his event log is longer than one export may read — nothing is published until the limit is raised (the previous snapshot stays up)</span>` : ''}` : '—'],
    ['REFUSED FIELDS', s.last?.errors?.length ? html`<span class="red">${s.last.errors.join(' · ')}</span>` : html`<span class="mute">none</span>`],
    ['LAST ISSUE', issue ? html`${issue.code}${issue.reason ? ` · ${issue.reason}` : ''} <span class="mute">${fmtRelative(issue.at)} ago</span>` : html`<span class="mute">none</span>`],
    ['PRIVACY REFRESH', s.privacyRefreshPending ? html`<span class="chip warn">PENDING · an opt-out, purge or unpublish is waiting to reach the site (retried every tick; the site goes offline if it can't)</span>` : html`<span class="mute">none pending</span>`],
    ['NAMED PEOPLE', String(s.optedIn ?? 0)],
    ['PUBLISHED NIGHTS', String(s.journal ?? 0)],
  ];
  return html`<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-family:var(--font-mono);font-size: var(--t-meta)">${rows.map(([k, v]) => html`<span class="mute">${k}</span><span>${v}</span>`)}</div>`;
}

function peopleView(list) {
  if (!list.length) return html`<div class="empty">NOBODY YET · everyone appears as "a friend". Switch a person on from their page.</div>`;
  return html`<table class="data"><thead><tr><th>PERSON</th><th>SHOWN AS</th><th>STATE</th><th>CHANGED</th></tr></thead><tbody>${list.map((p) => html`<tr>
    <td><a href="#person/${encodeURIComponent(p.personJid)}">${p.realName || p.pushName || p.personJid}</a></td>
    <td>${p.displayName}</td>
    <td><span class="chip ${p.optedIn ? 'ok' : ''}">${p.optedIn ? 'SHOWN' : 'OFF'}</span></td>
    <td class="mono mute">${fmtTime(p.updatedAt)}</td></tr>`)}</tbody></table>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);

  async function load() {
    const [s, people, prev] = await Promise.all([
      api('/api/public/status', { signal: ctx.signal }),
      api('/api/public/people', { signal: ctx.signal }),
      api('/api/public/preview', { signal: ctx.signal }).catch(() => ({ doc: null })),
    ]);
    if (!ctx.alive()) return;
    const ro = readOnly();
    setSlots(root, {
      'ps-skill': s.enabled ? 'ON' : 'OFF',
      'ps-last': s.lastExport?.at ? `${fmtRelative(s.lastExport.at)} ago` : '—',
      'ps-upload': s.last?.uploadStatus ? String(s.last.uploadStatus).toUpperCase() : '—',
      'ps-size': kb(s.last?.size),
    });
    setSlot(root, 'ps-status', statusView(s));
    setSlot(root, 'ps-people', peopleView(Array.isArray(people?.people) ? people.people : []));
    setSlot(root, 'ps-preview', prev?.doc ? JSON.stringify(prev.doc, null, 1) : 'Nothing built yet (life not running?).');
    const ex = $(root, '#psExport');
    if (ex) ex.disabled = ro;
    const td = $(root, '#psTakedown');
    if (td) td.disabled = ro;
  }

  ctx.listen(root, 'click', async (e) => {
    const btn = e.target.closest?.('button');
    if (!btn || btn.disabled) return;
    if (btn.id === 'psExport') {
      btn.disabled = true;
      try {
        const r = await api('/api/public/export', { method: 'POST', body: {} });
        flash(`EXPORT · ${String(r?.status || 'done').toUpperCase()}${r?.uploaded ? ' · UPLOADED' : ''}`, r?.status === 'ok' || r?.status === 'unchanged' ? undefined : 'warn');
      } catch (err) { if (!isAbort(err)) flash(err.message, 'bad'); }
      if (ctx.alive()) load().catch(() => {});
    } else if (btn.id === 'psTakedown') {
      if (!(await askSheet({ label: 'Take the site offline', text: 'Replace the live site with an "offline" notice now? Turn the public-site skill off too, or the next export puts it back.', action: 'TAKE OFFLINE', danger: true })).ok || !ctx.alive()) return;
      btn.disabled = true;
      try {
        const r = await api('/api/public/takedown', { method: 'POST', body: { confirm: true } });
        flash(r?.uploaded ? 'OFFLINE NOTICE UPLOADED' : `OFFLINE · ${String(r?.reason || 'local only').toUpperCase()}`, r?.uploaded ? undefined : 'warn');
      } catch (err) { if (!isAbort(err)) flash(err.message, 'bad'); }
      if (ctx.alive()) load().catch(() => {});
    }
  });

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('public poll', err); }); }, POLL_MS);
}
