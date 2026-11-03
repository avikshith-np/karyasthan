// 10 IDENTITY — edit identity.md (hot-reloaded on save). Warns when the file
// still carries the legacy capability sections that the prompt now strips
// (spec 007 O6); the heading list comes from the API, not from this file.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · IDENTITY · WHO HE IS</div>
    <h1>Identity</h1>
  </div>
  <div class="meta">
    <span>BYTES <b class="mono" data-slot="id-bytes">—</b></span>
    <span>LINES <b class="mono" data-slot="id-lines">—</b></span>
  </div>
</div>

<div style="background:rgba(198,146,20,0.08);border:1px solid var(--amber);padding:10px 14px;margin-bottom:14px;font-family:var(--font-mono);font-size: var(--t-meta)">
  <b class="amber">⚠ APPLIES AT ONCE</b> · saving rewrites <code style="color:var(--ink-1)">src/personality/identity.md</code> and the next LLM call uses the new prompt. <b>The bot's personality is overwritten the moment you save.</b>
</div>

<div data-slot="id-legacy"></div>

<div class="panel">
  <div class="panel-head"><span>IDENTITY.MD · MARKDOWN<button type="button" class="guide-q" data-guide="editor" aria-label="Guide: editor">?</button></span><span class="mono"><span class="caret-mono" data-slot="id-cursor">L 1 · COL 1</span></span></div>
  <textarea id="idEditor" aria-label="identity.md" spellcheck="false" style="display:block;width:100%;min-height:520px;padding:14px;background:var(--bg-1);border:none;border-top:1px solid var(--line-2);color:var(--ink-1);font-family:var(--font-mono);font-size: var(--t-data);line-height:1.65;resize:vertical">LOADING</textarea>
  <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-top:1px solid var(--line-2);background:var(--bg-2)">
    <div class="mono mute" style="font-size: var(--t-label)" data-slot="id-statusline">—</div>
    <div style="display:flex;gap:6px"><button id="idDiscard">↩ DISCARD</button><button data-write class="primary" id="idSave">SAVE</button></div>
  </div>
</div>
`);

function legacyFound(text, list) {
  const lines = new Set(String(text).split('\n').map((l) => l.trimEnd()));
  return (list || []).filter((h) => lines.has(h));
}

function legacyView(found) {
  if (!found.length) return null;
  return html`<div role="note" style="background:rgba(198,146,20,0.08);border:1px solid var(--amber);padding:10px 14px;margin-bottom:14px;font-family:var(--font-mono);font-size: var(--t-meta)">
    <b class="amber">⚠ LEGACY CAPABILITY SECTIONS</b> · ${found.map((h) => html`<span class="chip warn">${h}</span>`)}
    <div class="mute" style="margin-top:6px">These sections duplicate the capability manuals that now live in code and are left out of the prompt when it is built. Remove them here to keep the file and the prompt in step; nothing else changes.</div>
  </div>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  let data;
  try {
    data = await api('/api/identity', { signal: ctx.signal });
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  if (!ctx.alive()) return;
  let saved = String(data?.text ?? '');
  const list = Array.isArray(data?.legacyHeadingList) ? data.legacyHeadingList : [];
  const editor = $(root, '#idEditor');
  editor.value = saved;

  const updateMeta = () => {
    const v = editor.value;
    const lines = v.split('\n').length;
    const cursor = v.slice(0, editor.selectionStart);
    const line = cursor.split('\n').length;
    const col = cursor.length - cursor.lastIndexOf('\n');
    setSlots(root, {
      'id-bytes': v.length.toLocaleString(),
      'id-lines': lines,
      'id-cursor': `L ${line} · COL ${col}`,
      'id-statusline': `${lines} LINES · ${v.length} BYTES${v !== saved ? ' · UNSAVED' : ''}`,
    });
  };
  let lastFound = null;
  const updateLegacy = () => {
    const found = legacyFound(editor.value, list);
    const key = found.join('|');
    if (key === lastFound) return;
    lastFound = key;
    setSlot(root, 'id-legacy', legacyView(found));
  };
  updateMeta();
  updateLegacy();
  ctx.listen(editor, 'input', () => { updateMeta(); updateLegacy(); });
  ctx.listen(editor, 'keyup', updateMeta);
  ctx.listen(editor, 'click', updateMeta);

  ctx.listen($(root, '#idDiscard'), 'click', async () => {
    if (!(await askSheet({ label: 'Discard your changes', text: 'Go back to the saved text?', action: 'DISCARD' })).ok || !ctx.alive()) return;
    editor.value = saved;
    updateMeta();
    updateLegacy();
  });
  ctx.listen($(root, '#idSave'), 'click', async () => {
    const text = editor.value;
    try {
      await api('/api/identity', { method: 'PUT', body: { text } });
      saved = text;
      flash('IDENTITY SAVED · IN USE NOW');
      if (ctx.alive()) updateMeta();
    } catch (err) {
      flash(err.message, 'bad');
    }
  });
}
