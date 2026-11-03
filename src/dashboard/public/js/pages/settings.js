// SETTINGS — live parameters, model-role routing (generated from
// /api/llm/roles), provider keys, the .env diff/persist, WhatsApp re-pairing and
// maintenance jobs.
//
// Routing rows come from the registry: per role provider, model, effort,
// fallback, timeout and budget. Inputs hold the RAW value ('' = inherit/default)
// and show the EFFECTIVE value as a placeholder / option label. The `fun` role is
// shadow-only. Every write goes through PATCH /api/config (readonly + CSRF + audit).
//
// A phone gets the sections folded (the forms stay in the DOM, so applying sees everything),
// one role's card at a time from a picker, and a box to find a setting by name. Nothing here
// polls: what you type stays until you apply it.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $, $$ } from '../core/dom.js';
import { fmtUsd } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { labelCells } from '../components/tables.js';
import { refreshTopbar } from '../components/topbar.js';
import { showError } from '../components/ui.js';
import { fold, initFolds } from '../components/views.js';

const shell = (wide) => html`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · SETTINGS · HOW THE BOT RUNS</div>
    <h1>Settings</h1>
  </div>
  <div class="meta"><span class="stamp" data-slot="settings-stamp">READ-ONLY</span></div>
</div>

<div style="background:rgba(200,16,46,0.08);border:1px solid var(--red-deep);padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
  <span class="dot-live"></span>
  <div class="mono" style="font-size: var(--t-meta)"><b class="red-bright">CAUTION</b> · CHANGES ARE IN-MEMORY ONLY. PM2 RESTART REVERTS UNLESS PERSISTED TO .ENV.</div>
</div>

${fold({ id: 'settings.roles', open: wide, title: html`MODEL ROLES · ROUTING<button type="button" class="guide-q" data-guide="roles" aria-label="Guide: roles">?</button>`, meta: html`<span class="mono mute" data-slot="roles-global">—</span>`, body: html`<div class="panel-body">
      <div class="mute mono" style="font-size: var(--t-label);margin-bottom:8px">▸ EMPTY = INHERIT / DEFAULT (THE EFFECTIVE VALUE IS SHOWN GREYED) · FALLBACK "none" = NO FALLBACK · BUDGET 0 = NO ROLE CAP (GLOBAL CAP STILL APPLIES) · VOICE TRANSCRIPTION + IMAGE/STICKER DESCRIPTION ARE NOT ROLE CALLS: THEY USE TRANSCRIPTION_MODEL (VIA OPENROUTER WHEN ITS KEY IS SET, ELSE GEMINI), METERED AS SENSES</div>
    <label class="set-rolepick"><span class="form-label">ROLE</span><select id="roleFocus" aria-label="Which role to show"></select></label>
    <div class="table-wrap"><table class="data no-cards set-roles" id="rolesTable">
      <thead><tr><th>ROLE</th><th>PROVIDER</th><th>MODEL</th><th>EFFORT</th><th>MAX TOK</th><th>FALLBACK</th><th>FALLBACK MODEL</th><th>TIMEOUT MS</th><th>BUDGET $</th><th>MONTH</th><th></th></tr></thead>
      <tbody data-slot="roles-rows"><tr><td colspan="11" class="loading">LOADING</td></tr></tbody>
    </table></div>
    <div data-slot="roles-datalists"></div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button data-write class="primary" type="button" id="rolesApply">APPLY ROUTING (IN-MEMORY)</button>
      <button type="button" id="rolesReset">RESET</button>
    </div>
    <div class="mono" data-slot="llm-test-result" role="status" style="font-size: var(--t-meta);margin-top:10px;min-height:14px"></div>
  
    </div>` })}

<div class="set-grid">
  <div class="set-col">
    ${fold({ id: 'settings.live', open: wide, title: html`MUTABLE · APPLY LIVE<button type="button" class="guide-q" data-guide="live" aria-label="Guide: live">?</button>`, meta: html`<span class="mono mute" data-slot="settings-keycount">— KEYS</span>`, body: html`<div class="panel-body">
      <input type="search" id="settingsFind" class="set-find" placeholder="find a setting" aria-label="Find a setting by name">
      <div class="mono mute set-find-none" id="settingsFindNone" hidden>NOTHING BY THAT NAME</div>
      <form id="settingsForm">
        <div class="table-wrap"><table class="data no-cards set-rows">
          <tbody data-slot="settings-rows"><tr><td colspan="3" class="loading">LOADING</td></tr></tbody>
        </table></div>
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          <button data-write class="primary" type="submit">APPLY (IN-MEMORY)</button>
          <button type="reset">RESET</button>
          <button data-write class="danger" type="button" id="settingsPersist">PERSIST → .ENV</button>
        </div>
      </form>
      
      <div data-slot="settings-diff" style="margin-top:14px"></div>
    </div>` })}
  </div>
  <div class="set-col">
    ${fold({ id: 'settings.keys', open: wide, title: html`API KEYS<button type="button" class="guide-q" data-guide="keys" aria-label="Guide: keys">?</button>`, meta: html`<span class="mono mute">SET IN-MEMORY · NEVER SHOWN</span>`, body: html`<div class="panel-body">
      <div class="mute mono" style="font-size: var(--t-label)">EACH PROVIDER USES ONLY ITS OWN KEY · TICK TO ALSO WRITE .ENV (0600)</div>
        <div class="table-wrap"><table class="data no-cards set-keys" style="margin-top:6px">
          <tbody data-slot="llm-keys-rows"></tbody>
        </table></div>
        <label class="mono mute" style="font-size: var(--t-label);display:inline-block;margin-top:8px"><input type="checkbox" id="llmKeyPersist" /> PERSIST KEY → .ENV (0600)</label>
      
    </div>` })}
    ${fold({ id: 'settings.static', open: wide, title: html`STATIC · REQUIRES .ENV + RESTART<button type="button" class="guide-q" data-guide="static" aria-label="Guide: static">?</button>`, meta: html`<span class="mono mute">VALUES</span>`, body: html`<div class="panel-body">
      <pre class="mono" style="font-size: var(--t-meta);color:var(--ink-1);margin:0;line-height:1.7" data-slot="settings-static">—</pre>
    </div>` })}
    ${fold({ id: 'settings.pair', open: wide, title: html`RE-PAIR WHATSAPP<button type="button" class="guide-q" data-guide="pair" aria-label="Guide: pair">?</button>`, meta: html`<span class="mono mute">DISCONNECTED ONLY</span>`, body: html`<div class="panel-body">
      <div class="mute mono" style="font-size: var(--t-meta)">UNLINK FROM PHONE FIRST · THEN ENTER NUMBER WITH COUNTRY CODE</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
          <input type="text" id="pairPhone" aria-label="Phone number with country code" placeholder="+&lt;country code&gt; &lt;number&gt;" style="flex:1 1 180px;min-width:0" />
          <button data-write class="primary" id="pairBtn">START PAIRING</button>
        </div>
        <div class="mono" id="pairCodeBanner" style="display:none;margin-top:10px;padding:10px;border:1px solid var(--green);text-align:center;font-size: var(--t-h3);font-weight:700;color:#8bc06b">—</div>
        <div class="mono" id="pairLog" style="display:none;margin-top:10px;padding:10px;border:1px dashed var(--line-3);font-size: var(--t-label);color:var(--ink-3);max-height:160px;overflow-y:auto"></div>
      
    </div>` })}
    ${fold({ id: 'settings.maint', open: wide, title: html`MAINTENANCE<button type="button" class="guide-q" data-guide="maintenance" aria-label="Guide: maintenance">?</button>`, meta: html`<span class="mono mute">RUN ON DEMAND</span>`, body: html`<div class="panel-body" style="display:flex;gap:8px;flex-wrap:wrap">
      <button data-write id="mntMemBtn">▸ MEMORY CLEANUP</button>
        <button data-write id="mntBillBtn">▸ EXPIRE STALE BILLS</button>
      
    </div>` })}
  </div>
</div>
`;

const getByPath = (obj, p) => p.split('.').reduce((o, k) => o?.[k], obj);

/** 'int' | 'float' | 'int:a..b' | 'float:a..b' → { integer, min, max }; anything else → null. */
function numType(type) {
  if (type === 'int' || type === 'float') return { integer: type === 'int', min: null, max: null };
  const m = /^(int|float):(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(String(type || ''));
  return m ? { integer: m[1] === 'int', min: Number(m[2]), max: Number(m[3]) } : null;
}
const COLS = ['provider', 'model', 'effort', 'maxTokens', 'fallbackProvider', 'fallbackModel', 'timeoutMs', 'budgetUsd'];
const NUMERIC = new Set(['maxTokens', 'timeoutMs', 'budgetUsd']);
const STATE_PILL = { ok: 'ok', over: 'bad', none: '' };

// Provider key fields settable from the dashboard (field → .env name, flag key).
const KEY_FIELDS = [
  ['anthropicApiKey', 'ANTHROPIC_API_KEY', 'anthropic'],
  ['apiKey', 'LLM_API_KEY (OpenAI only)', 'openai'],
  ['geminiApiKey', 'GEMINI_API_KEY', 'gemini'],
  ['glmApiKey', 'GLM_API_KEY', 'glm'],
  ['openrouterApiKey', 'OPENROUTER_API_KEY', 'openrouter'],
  ['xaiApiKey', 'XAI_API_KEY', 'xai'],
];
const PROVIDER_KEY_FLAG = { anthropic: 'anthropic', openai: 'openai', gemini: 'gemini', glm: 'glm', openrouter: 'openrouter', xai: 'xai' };

function usableFn(rolesData) {
  return (p) => {
    if (p === 'ollama') return true;
    if (p === 'local') return !!rolesData.localConfigured;
    const flagKey = PROVIDER_KEY_FLAG[p];
    return flagKey ? !!rolesData.keys?.[flagKey] : true;
  };
}

function providerOptions(providers, usable, current, empty) {
  return html`${empty ? html`<option value="">${empty}</option>` : null}${providers.map((p) => html`<option value="${p}" ${p === current ? raw('selected') : null}>${p}${usable(p) ? '' : p === 'local' ? ' (no url)' : ' (no key)'}</option>`)}`;
}

function cell(row, field, ctxData) {
  const f = row.fields.find((x) => x.field === field);
  if (!f) return html`<td></td>`;
  const raw0 = row.values?.[field];
  const val = raw0 == null ? '' : raw0;
  const eff = row.effective || {};
  const { providers, efforts, usable } = ctxData;
  const key = f.key;
  const inherits = !!row.inherit;
  if (field === 'provider') {
    const required = f.type === 'enum:provider';
    const empty = required ? null : inherits ? `inherit → ${eff.provider || '—'}` : '— disabled —';
    return html`<td><select data-role-key="${key}" data-role="${row.role}" data-field="provider" aria-label="${row.label} provider" style="width:120px">${providerOptions(providers, usable, val, empty)}</select></td>`;
  }
  if (field === 'fallbackProvider') {
    const effFb = eff.fallback ? `${eff.fallback.provider}` : 'none';
    // '' on mouth = no fallback; on other roles = mouth's fallback.
    const empty = row.role === 'mouth' ? '— none —' : `default → ${effFb}`;
    return html`<td><select data-role-key="${key}" data-role="${row.role}" data-field="fallbackProvider" aria-label="${row.label} fallback provider" style="width:120px">
      <option value="">${empty}</option>
      <option value="none" ${val === 'none' ? raw('selected') : null}>none</option>
      ${providers.map((p) => html`<option value="${p}" ${p === val ? raw('selected') : null}>${p}${usable(p) ? '' : p === 'local' ? ' (no url)' : ' (no key)'}</option>`)}
    </select></td>`;
  }
  if (field === 'effort') {
    const emptyLabel = inherits ? `inherit → ${eff.effort || 'none'}` : 'none';
    return html`<td><select data-role-key="${key}" data-role="${row.role}" data-field="effort" aria-label="${row.label} effort" style="width:100px">${efforts.map((e) => html`<option value="${e}" ${e === val ? raw('selected') : null}>${e || emptyLabel}</option>`)}</select></td>`;
  }
  if (field === 'model' || field === 'fallbackModel') {
    const ph = field === 'model' ? (eff.model || '') : (eff.fallback?.model || '');
    const prov = field === 'model' ? (row.values?.provider || eff.provider || row.fixedProvider || '') : (row.values?.fallbackProvider || eff.fallback?.provider || '');
    return html`<td style="white-space:nowrap"><input type="text" data-role-key="${key}" data-role="${row.role}" data-field="${field}" list="${prov ? `models-${prov}` : ''}" value="${val}" placeholder="${ph}" aria-label="${row.label} ${field === 'model' ? 'model' : 'fallback model'}" style="width:190px" />${field === 'model' && row.kind === 'chat' ? html`<button data-write type="button" class="role-addmodel" data-role="${row.role}" title="Add a model id to this provider's list" aria-label="Add a model for ${row.label}" style="padding:4px 8px;margin-left:4px">+</button>` : null}</td>`;
  }
  // numeric
  const effNum = field === 'budgetUsd' ? (eff.budgetUsd ?? row.budget?.budgetUsd ?? '') : eff[field];
  return html`<td><input type="number" min="0" ${field === 'budgetUsd' ? raw('step="0.01"') : raw('step="1"')} data-role-key="${key}" data-role="${row.role}" data-field="${field}" data-type="${f.type}" value="${val}" placeholder="${effNum ?? ''}" aria-label="${row.label} ${field}" style="width:${field === 'budgetUsd' ? 80 : 96}px" /></td>`;
}

function roleRow(row, ctxData) {
  const eff = row.effective || {};
  const b = row.budget;
  const stateCls = eff.disabled ? '' : row.shadowOnly ? 'warn' : (STATE_PILL[b?.state] ?? '');
  const stateTxt = eff.disabled ? 'disabled' : row.shadowOnly ? 'shadow-only' : (!b?.state || b.state === 'none' ? 'no cap' : b.state);
  const month = b ? (b.budgetUsd > 0 ? `${fmtUsd(b.spentUsd)} / ${fmtUsd(b.budgetUsd)}` : fmtUsd(b.spentUsd || 0)) : '—';
  const testable = row.kind === 'chat';
  return html`<tr data-role-row="${row.role}">
    <td title="${row.description || ''}"><b>${row.label}</b>${row.shadowOnly ? html` <span class="pill warn">SHADOW ONLY</span>` : null}${row.kind === 'label' ? html` <span class="pill">METER</span>` : null}<div class="mono mute" style="font-size: var(--t-label);min-width:200px;max-width:280px;white-space:normal">${row.description || ''}${row.inherit ? html` · empty fields inherit from <b>${row.inherit}</b>` : null}</div></td>
    ${COLS.map((c) => cell(row, c, ctxData))}
    <td class="mono" style="white-space:nowrap"><span class="pill ${stateCls}">${stateTxt}</span><div class="mute" style="font-size: var(--t-label)">${month}</div></td>
    <td>${testable ? html`<button data-write type="button" class="role-test" data-role="${row.role}" aria-label="Test ${row.label}">TEST</button>` : null}</td>
  </tr>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, shell(!globalThis.matchMedia?.('(max-width: 900px)').matches));
  initFolds(root);
  const opt = { signal: ctx.signal };
  let cfg;
  let rolesData;
  try {
    [cfg, rolesData] = await Promise.all([api('/api/config', opt), api('/api/llm/roles', opt)]);
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  if (!ctx.alive()) return;
  let values = cfg.values || {};
  const catalog = { ...(cfg.models || {}) };
  const genericKeys = (cfg.mutableKeys || []).filter((k) => !k.startsWith('roles.'));
  setSlots(root, {
    'settings-keycount': `${genericKeys.length} KEYS`,
    'settings-stamp': values.dashboard?.readOnly ? 'READ-ONLY' : 'READ/WRITE',
  });

  // ── generic live parameters ──
  // The step and bounds come from the key's declared type (GET /api/config `types`),
  // never from its current value: a float setting that holds 0 or 1 still takes 0.5.
  const types = cfg.types || {};
  const notPersistable = new Set(cfg.notPersistable || []);
  const rowsBody = $(root, '[data-slot="settings-rows"]');
  const paintGeneric = () => render(rowsBody, genericKeys.map((key) => {
    const v = getByPath(values, key);
    const t = numType(types[key]);
    const isBool = types[key] === 'bool' || typeof v === 'boolean';
    const choices = (cfg.enums || {})[types[key]];
    const isNum = !!t || typeof v === 'number';
    const step = t ? (t.integer ? '1' : 'any') : 'any';
    const input = isBool
      ? html`<label class="set-check"><input type="checkbox" data-key="${key}" aria-label="${key}" ${v ? raw('checked') : null} /></label>`
      : Array.isArray(choices)
        ? html`<select data-key="${key}" aria-label="${key}" style="width:160px">${choices.map((c) => html`<option value="${c}" ${c === (v ?? '') ? raw('selected') : null}>${c || '(role default)'}</option>`)}</select>`
      : isNum
        ? html`<input type="number" data-key="${key}" aria-label="${key}" value="${v ?? ''}" step="${step}" ${t?.min != null ? html`min="${t.min}"` : null} ${t?.max != null ? html`max="${t.max}"` : null} style="width:160px" />`
        : html`<input type="text" data-key="${key}" aria-label="${key}" value="${v ?? ''}" style="width:160px" />`;
    const kind = isBool ? (v ? 'on' : 'off') : Array.isArray(choices) ? 'choice' : t ? `${t.integer ? 'whole' : 'decimal'}${t.min != null ? ` ${t.min}..${t.max}` : ''}` : isNum ? 'numeric' : 'string';
    return html`<tr><td class="mono mute">${key}</td><td>${input}</td><td class="mute">${kind}${notPersistable.has(key) ? html` · <span class="pill warn" title="No .env variable: this change lasts until restart">not persistable</span>` : null}</td></tr>`;
  }));
  // Find a setting by name; a repaint (after APPLY) keeps the filter.
  const findBox = $(root, '#settingsFind');
  const applyFind = () => {
    const q = (findBox?.value || '').trim().toLowerCase();
    let shown = 0;
    for (const tr of $$(rowsBody, 'tr')) {
      const on = !q || tr.querySelector('td')?.textContent.toLowerCase().includes(q);
      tr.hidden = !on;
      if (on) shown++;
    }
    const none = $(root, '#settingsFindNone');
    if (none) none.hidden = shown > 0;
  };
  ctx.listen(findBox, 'input', applyFind);
  paintGeneric();

  const form = $(root, '#settingsForm');
  ctx.listen(form, 'submit', async (e) => {
    e.preventDefault();
    const patch = {};
    const problems = [];
    for (const inp of $$(form, '[data-key]')) {
      const key = inp.dataset.key;
      const orig = getByPath(values, key);
      let val;
      if (typeof orig === 'boolean') val = inp.checked;
      else if (inp.type === 'number') {
        // An emptied box is not 0: refuse it rather than send a silent zero.
        if (inp.value.trim() === '') {
          if (orig != null && orig !== '') problems.push(`${key} needs a number`);
          continue;
        }
        val = Number(inp.value);
        if (!Number.isFinite(val)) { problems.push(`${key} needs a number`); continue; }
      } else val = inp.value;
      if (val !== orig) patch[key] = val;
    }
    if (problems.length) { flash(problems.join(' · '), 'warn'); return; }
    if (!Object.keys(patch).length) { flash('NO CHANGES', 'warn'); return; }
    try {
      const result = await api('/api/config', { method: 'PATCH', body: patch });
      const aN = Object.keys(result.applied || {}).length;
      const rej = Object.entries(result.rejected || {});
      flash(`APPLIED ${aN}${rej.length ? ` · REJECTED ${rej.map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}`, rej.length ? 'warn' : 'ok');
      if (result.values) values = result.values;
      // Repaint from the server's values: a rejected or rounded entry must not stay
      // in its box (it would be re-sent, and rejected again, on every APPLY).
      if (ctx.alive()) { paintGeneric(); applyFind(); }
      refreshTopbar();
      if (ctx.alive()) refreshDiff();
    } catch (err) { flash(err.message, 'bad'); }
  });

  // ── model roles ──
  const rolesBody = $(root, '[data-slot="roles-rows"]');
  const testOut = $(root, '[data-slot="llm-test-result"]');
  const paintDatalists = () => setSlot(root, 'roles-datalists', Object.entries(catalog).map(([p, models]) => html`<datalist id="models-${p}">${(models || []).map((m) => html`<option value="${m}"></option>`)}</datalist>`));
  // On a phone one role's card shows at a time (every role's inputs stay in the form).
  const focusSel = $(root, '#roleFocus');
  const paintRoleFocus = () => {
    const roles = rolesData.roles || [];
    const keep = roles.some((r) => r.role === focusSel.value) ? focusSel.value : roles[0]?.role;
    render(focusSel, roles.map((r) => html`<option value="${r.role}" ${r.role === keep ? raw('selected') : null}>${r.label}</option>`));
    for (const tr of $$(rolesBody, 'tr')) tr.classList.toggle('is-focus', tr.dataset.roleRow === keep);
  };
  ctx.listen(focusSel, 'change', () => {
    for (const tr of $$(rolesBody, 'tr')) tr.classList.toggle('is-focus', tr.dataset.roleRow === focusSel.value);
  });
  const paintRoles = () => {
    const ctxData = { providers: rolesData.providers || cfg.providers || [], efforts: rolesData.efforts || [''], usable: usableFn(rolesData) };
    const jev = (rolesData.roles || []).find((r) => r.kind === 'jev');
    if (jev) jev.fixedProvider = 'openrouter';
    render(rolesBody, (rolesData.roles || []).map((r) => roleRow(r, ctxData)));
    labelCells($(root, '#rolesTable'));
    paintRoleFocus();
    const g = rolesData.global;
    setSlots(root, { 'roles-global': g ? `GLOBAL ${g.budgetUsd > 0 ? `${fmtUsd(g.spentUsd)} / ${fmtUsd(g.budgetUsd)}` : `${fmtUsd(g.spentUsd)} · NO CAP`} · ${String(g.state).toUpperCase()}` : '—' });
  };
  paintDatalists();
  paintRoles();
  const reloadRoles = async () => {
    rolesData = await api('/api/llm/roles', opt);
    if (ctx.alive()) paintRoles();
  };

  // Keep each model input's suggestion list on its row's provider.
  ctx.listen(rolesBody, 'change', (e) => {
    const sel = e.target.closest?.('select[data-field="provider"], select[data-field="fallbackProvider"]');
    if (!sel) return;
    const tr = sel.closest('tr');
    const row = (rolesData.roles || []).find((r) => r.role === sel.dataset.role);
    const target = $(tr, `input[data-field="${sel.dataset.field === 'provider' ? 'model' : 'fallbackModel'}"]`);
    const eff = row?.effective || {};
    const prov = sel.value || (sel.dataset.field === 'provider' ? eff.provider : eff.fallback?.provider) || '';
    if (target) target.setAttribute('list', prov && prov !== 'none' ? `models-${prov}` : '');
  });

  ctx.listen($(root, '#rolesReset'), 'click', () => { paintRoles(); flash('ROUTING FORM RESET', 'warn'); });

  ctx.listen($(root, '#rolesApply'), 'click', async () => {
    const patch = {};
    const problems = [];
    for (const inp of $$(rolesBody, '[data-role-key]')) {
      const key = inp.dataset.roleKey;
      const row = (rolesData.roles || []).find((r) => r.role === inp.dataset.role);
      const field = inp.dataset.field;
      const orig = row?.values?.[field];
      const origStr = orig == null ? '' : String(orig);
      const cur = inp.value.trim();
      if (cur === origStr) continue;
      if (NUMERIC.has(field)) {
        const type = inp.dataset.type || '';
        if (cur === '') {
          if (type.endsWith('?')) patch[key] = '';
          else problems.push(`${row?.label || ''} ${field} needs a number`);
          continue;
        }
        const n = Number(cur);
        if (!Number.isFinite(n) || n < 0) { problems.push(`${row?.label || ''} ${field} must be ≥ 0`); continue; }
        patch[key] = n;
      } else {
        patch[key] = cur;
      }
    }
    if (problems.length) { flash(problems.join(' · '), 'warn'); return; }
    if (!Object.keys(patch).length) { flash('NO ROUTING CHANGES', 'warn'); return; }
    try {
      const result = await api('/api/config', { method: 'PATCH', body: patch });
      const aN = Object.keys(result.applied || {}).length;
      const rej = Object.entries(result.rejected || {});
      flash(`ROUTING APPLIED ${aN}${rej.length ? ` · REJECTED ${rej.map(([k, v]) => `${k.replace(/^roles\./, '')}: ${v}`).join(', ')}` : ''}`, rej.length ? 'warn' : 'ok');
      if (result.values) values = result.values;
      refreshTopbar();
      if (ctx.alive()) { await reloadRoles().catch(() => {}); refreshDiff(); }
    } catch (err) { flash(err.message, 'bad'); }
  });

  // TEST: the role's applied routing ({role}); if the row's provider/model were
  // edited and not applied yet, probe the edited pair instead (no fallback).
  ctx.listen(rolesBody, 'click', async (e) => {
    const add = e.target.closest?.('.role-addmodel');
    if (add) {
      const tr = add.closest('tr');
      const row = (rolesData.roles || []).find((r) => r.role === add.dataset.role);
      const provider = $(tr, 'select[data-field="provider"]')?.value || row?.effective?.provider;
      if (!provider) { flash('PICK A PROVIDER FIRST', 'warn'); return; }
      const { ok, reason: name } = await askSheet({ label: 'Add a model', text: `New model id for "${provider}".`, action: 'ADD', keep: 'CANCEL', reasonLabel: 'Model id', reasonMax: 120 });
      if (!ok || !name || !ctx.alive()) return;
      try {
        const r = await api('/api/llm/models', { method: 'POST', body: { provider, model: name } });
        catalog[provider] = r.models;
        if (!ctx.alive()) return;
        paintDatalists();
        const inp = $(tr, 'input[data-field="model"]');
        if (inp) inp.value = name;
        flash(`MODEL ADDED · ${name}`, 'ok');
      } catch (err) { flash(err.message, 'bad'); }
      return;
    }
    const btn = e.target.closest?.('.role-test');
    if (!btn) return;
    const tr = btn.closest('tr');
    const row = (rolesData.roles || []).find((r) => r.role === btn.dataset.role);
    if (!row) return;
    const eff = row.effective || {};
    const provSel = $(tr, 'select[data-field="provider"]');
    const modelInp = $(tr, 'input[data-field="model"]');
    const editedProv = (provSel?.value ?? '') !== String(row.values?.provider ?? '');
    const editedModel = (modelInp?.value.trim() ?? '') !== String(row.values?.model ?? '');
    let body;
    let label;
    if (editedProv || editedModel) {
      const provider = provSel?.value || eff.provider;
      const model = modelInp?.value.trim() || eff.model || '';
      body = { provider, model };
      label = `${provider}/${model || '?'}`;
    } else {
      body = { role: row.role };
      label = `${row.label} (${eff.provider || '—'}/${eff.model || '—'})`;
    }
    btn.disabled = true;
    render(testOut, html`<span class="mute">TESTING ${label}…</span>`);
    try {
      const r = await api('/api/llm/test', { method: 'POST', body });
      if (!ctx.alive()) return;
      if (r.ok) {
        render(testOut, html`<span style="color:var(--green-ink)">✓ ${label} OK · ${r.latencyMs}ms${typeof r.costUsd === 'number' ? ` · ${fmtUsd(r.costUsd)}` : ''} · "${r.reply || ''}"</span>`);
      } else {
        const er = r.error;
        const reason = typeof er === 'string' ? er : (er?.body || er?.message || (er?.status ? `HTTP ${er.status}` : 'no response'));
        render(testOut, html`<span style="color:var(--red-bright)">✗ ${label} FAILED · ${r.latencyMs}ms · ${reason}</span>`);
      }
    } catch (err) {
      if (ctx.alive()) render(testOut, html`<span style="color:var(--red-bright)">TEST ERR · ${err.message}</span>`);
    } finally {
      btn.disabled = false;
    }
  });

  // ── provider keys (field names only ever leave this page; values are never shown) ──
  const keyRows = $(root, '[data-slot="llm-keys-rows"]');
  const paintKeys = () => render(keyRows, html`${KEY_FIELDS.map(([field, label, flagKey]) => {
    const set = !!rolesData.keys?.[flagKey];
    return html`<tr><td class="mono mute" style="font-size: var(--t-label)">${label}<br><span style="color:${set ? 'var(--green-ink)' : 'var(--ink-3)'}">${set ? '✓ SET' : '· NOT SET'}</span></td><td><input type="password" data-llm-key="${field}" aria-label="${label}" placeholder="${set ? '•••• replace' : 'paste key'}" autocomplete="off" style="width:180px" /></td><td><button data-write type="button" data-llm-savekey="${field}">SAVE</button></td></tr>`;
  })}<tr><td class="mono mute" style="font-size: var(--t-label)">JEV (OPENROUTER / JEV_API_KEY)<br><span style="color:${rolesData.keys?.jev ? 'var(--green-ink)' : 'var(--ink-3)'}">${rolesData.keys?.jev ? '✓ SET' : '· NOT SET'}</span></td><td class="mute" colspan="2" style="font-size: var(--t-label)">uses the OpenRouter key unless JEV_API_KEY is set in .env</td></tr>`);
  paintKeys();
  ctx.listen(keyRows, 'click', async (e) => {
    const btn = e.target.closest?.('[data-llm-savekey]');
    if (!btn) return;
    const field = btn.dataset.llmSavekey;
    const inp = keyRows.querySelector(`[data-llm-key="${CSS.escape(field)}"]`);
    if (!inp?.value.trim()) { flash('ENTER A KEY', 'warn'); return; }
    const persist = $(root, '#llmKeyPersist')?.checked === true;
    try {
      const r = await api('/api/llm/keys', { method: 'POST', body: { field, value: inp.value, persist } });
      inp.value = '';
      flash(`KEY SAVED · ${field}${r.persisted ? ' · PERSISTED .ENV' : ''}`, 'ok');
      if (ctx.alive()) { await reloadRoles().catch(() => {}); paintKeys(); }
    } catch (err) { flash(err.message, 'bad'); }
  });

  // ── static (.env + restart) ──
  const statics = [
    ['SLEEP_START_HOUR', values.sleepStartHour], ['SLEEP_END_HOUR', values.sleepEndHour], ['TIMEZONE', values.timezone],
    ['DASHBOARD_HOST', values.dashboard?.host], ['DASHBOARD_PORT', values.dashboard?.port], ['DASHBOARD_READONLY', values.dashboard?.readOnly],
  ];
  setSlot(root, 'settings-static', statics.map(([k, v], i) => html`${i ? '\n' : ''}${k.padEnd(24)}= <b>${v ?? '—'}</b>`));

  // ── diff & persist ──
  const diffSlot = $(root, '[data-slot="settings-diff"]');
  async function refreshDiff() {
    render(diffSlot, html`<div class="loading">LOADING DIFF</div>`);
    try {
      const { diffs } = await api('/api/config/diff', opt);
      if (!ctx.alive()) return;
      render(diffSlot, !diffs.length
        ? html`<div class="mute mono" style="font-size: var(--t-meta)">▸ LIVE CONFIG MATCHES .ENV — NOTHING TO PERSIST</div>`
        : html`<div class="cap mute" style="font-size: var(--t-label)">PENDING DIFF · ${diffs.length} KEY(S)</div>
          <div class="table-wrap"><table class="data no-cards" style="margin-top:6px"><thead><tr><th>KEY</th><th>.ENV</th><th>LIVE</th></tr></thead>
          <tbody>${diffs.map((d) => html`<tr><td class="mono">${d.envKey}</td><td class="mute">${d.envValue ?? '—'}</td><td><b>${d.liveValue}</b></td></tr>`)}</tbody></table></div>`);
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) render(diffSlot, html`<div class="empty" style="color:var(--red-bright)">DIFF ERR · ${err.message}</div>`);
    }
  }
  refreshDiff();
  ctx.listen($(root, '#settingsPersist'), 'click', async () => {
    const { ok } = await askSheet({ label: 'Persist to .env', text: 'Write the live config to .env. The old file is kept as a backup.', action: 'PERSIST', danger: true });
    if (!ok || !ctx.alive()) return;
    try {
      const r = await api('/api/config/persist', { method: 'POST', body: { confirm: true } });
      flash(`PERSISTED ${r.applied?.length || 0} KEY(S)`);
      if (ctx.alive()) refreshDiff();
    } catch (err) { flash(err.message, 'bad'); }
  });

  // ── re-pair WhatsApp: its own per-session stream (/api/pair/:id/stream) ──
  // The job outlives the page: on mount (and when START answers 409 because a job is
  // already running) the page re-attaches to the running job's stream, which replays
  // its buffered lines and pairing code.
  const pairBtn = $(root, '#pairBtn');
  const pairBanner = $(root, '#pairCodeBanner');
  const pairLog = $(root, '#pairLog');
  let pairEs = null;
  const closePair = () => { if (pairEs) { try { pairEs.close(); } catch {} pairEs = null; } };
  ctx.onDispose(closePair);
  const attachPair = (id) => {
    if (!ctx.alive()) return;
    pairLog.style.display = 'block';
    pairLog.replaceChildren();
    pairBanner.style.display = 'none';
    closePair();
    const es = new EventSource(`/api/pair/${encodeURIComponent(id)}/stream`);
    pairEs = es;
    const parse = (e) => { try { return JSON.parse(e.data); } catch { return {}; } };
    es.addEventListener('line', (e) => {
      if (!ctx.alive()) return;
      const div = document.createElement('div');
      div.textContent = String(parse(e).text ?? '');
      pairLog.appendChild(div);
      pairLog.scrollTop = pairLog.scrollHeight;
    });
    es.addEventListener('code', (e) => {
      if (!ctx.alive()) return;
      pairBanner.textContent = `PAIRING CODE · ${parse(e).code ?? ''}`;
      pairBanner.style.display = 'block';
    });
    es.addEventListener('paired', () => {
      if (ctx.alive()) {
        pairBanner.textContent = 'PAIRED ✓ — RESTART THE BOT';
        pairBanner.style.display = 'block';
      }
      closePair();
    });
    es.addEventListener('exit', closePair);
    es.addEventListener('closed', closePair);
  };
  const runningPairJob = async () => {
    try {
      const st = await api('/api/pair/status', opt);
      return st?.active && !st.done ? st.id : null;
    } catch { return null; }
  };
  runningPairJob().then((id) => { if (id && ctx.alive()) { attachPair(id); flash(`RE-ATTACHED TO PAIRING ${id}`); } });
  ctx.listen(pairBtn, 'click', async () => {
    const phone = ($(root, '#pairPhone').value || '').replace(/\D/g, '');
    if (phone.length < 8) { flash('ENTER PHONE WITH COUNTRY CODE', 'warn'); return; }
    try {
      const { id } = await api('/api/pair/start', { method: 'POST', body: { phone } });
      if (!ctx.alive()) return;
      flash(`PAIRING ${id} STARTED`);
      attachPair(id);
    } catch (err) {
      // 409 also means "bot is connected": only re-attach when a job is really running.
      const id = err?.status === 409 ? await runningPairJob() : null;
      if (id && ctx.alive()) { attachPair(id); flash(`PAIRING ${id} ALREADY RUNNING · RE-ATTACHED`, 'warn'); return; }
      flash(err.message, 'bad');
    }
  });

  // ── maintenance ──
  ctx.listen($(root, '#mntMemBtn'), 'click', async () => {
    try { const r = await api('/api/maintenance/memory', { method: 'POST', body: {} }); flash(`EXPIRED ${r.expired} · DECAYED ${r.decayed}`); } catch (err) { flash(err.message, 'bad'); }
  });
  ctx.listen($(root, '#mntBillBtn'), 'click', async () => {
    try { const r = await api('/api/maintenance/bills', { method: 'POST', body: {} }); flash(`EXPIRED ${r.expired} BILLS`); } catch (err) { flash(err.message, 'bad'); }
  });
}
