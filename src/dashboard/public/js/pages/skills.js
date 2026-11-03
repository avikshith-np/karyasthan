// 11 SKILLS — loaded skills with runtime enable/disable.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, $ } from '../core/dom.js';
import { padz } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · SKILLS · WHAT HE CAN DO, ON OR OFF</div>
    <h1>Skills</h1>
  </div>
  <div class="meta">
    <span>LOADED <b data-slot="skills-loaded">—</b></span>
    <span>ENABLED <b class="green" data-slot="skills-enabled">—</b></span>
    <span>DISABLED <b class="mute" data-slot="skills-disabled">—</b></span>
  </div>
</div>

<div class="panel">
  <div class="table-wrap"><table class="data no-cards sk-table">
    <thead><tr><th>#</th><th>NAME</th><th>STATE</th><th>DESCRIPTION</th><th></th></tr></thead>
    <tbody data-slot="skills-rows"><tr><td colspan="5" class="loading">LOADING</td></tr></tbody>
  </table></div>
</div>
`);

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const tbody = $(root, '[data-slot="skills-rows"]');

  async function load() {
    const skills = await api('/api/skills', { signal: ctx.signal });
    if (!ctx.alive()) return;
    const list = Array.isArray(skills) ? skills : [];
    const enabled = list.filter((s) => s.enabled).length;
    setSlots(root, { 'skills-loaded': list.length, 'skills-enabled': enabled, 'skills-disabled': list.length - enabled });
    render(tbody, list.length
      ? list.map((s, i) => html`<tr>
          <td class="id">${padz(i + 1, 2)}</td>
          <td><b>${s.name}</b></td>
          <td><span class="pill ${s.enabled ? 'ok' : 'bad'}">${s.enabled ? 'ENABLED' : 'DISABLED'}</span>${typeof s.bootDefault === 'boolean' && s.bootDefault !== s.enabled
            ? html` <span class="pill warn" title="A toggle lasts until restart: the skill's *_ENABLED line in .env decides what it is after a restart">${s.bootDefault ? 'ON' : 'OFF'} AFTER RESTART</span>` : null}</td>
          <td class="sk-desc">${s.description || ''}</td>
          <td><button data-write type="button" class="${s.enabled ? 'danger' : 'primary'} skill-toggle" data-name="${s.name}" data-enabled="${s.enabled ? 'true' : 'false'}" aria-label="${s.enabled ? 'Disable' : 'Enable'} ${s.name}">${s.enabled ? 'DISABLE' : 'ENABLE'}</button></td>
        </tr>`)
      : html`<tr><td colspan="5" class="empty">NO SKILLS LOADED</td></tr>`);
  }

  ctx.listen(tbody, 'click', async (e) => {
    // On a phone a description is cut to two lines; a tap shows the rest.
    e.target.closest?.('.sk-desc')?.classList.toggle('is-open');
    const btn = e.target.closest?.('.skill-toggle');
    if (!btn) return;
    const name = btn.dataset.name;
    const wasEnabled = btn.dataset.enabled === 'true';
    btn.disabled = true;
    try {
      await api(`/api/skills/${encodeURIComponent(name)}/toggle`, { method: 'POST', body: { enabled: !wasEnabled } });
      flash(`${name.toUpperCase()} ${!wasEnabled ? 'ENABLED' : 'DISABLED'}`);
      if (ctx.alive()) await load();
    } catch (err) {
      if (isAbort(err)) return;
      flash(err.message, 'bad');
      btn.disabled = false;
    }
  });

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
  }
}
