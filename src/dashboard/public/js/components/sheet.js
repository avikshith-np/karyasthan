// A sheet: from the bottom on a phone, a side panel on desktop. One native <dialog> in the
// top layer, so the browser gives it the focus trap, Escape, inert page behind it and focus
// back to the opener. It lives outside #content, so a page's poll can't re-render it away.
//
//   const s = openSheet({ label: 'All pages', content: html`…`, onClose });
//   s.body                 fill or re-render it yourself
//   s.close()              also on Escape, the scrim, CLOSE, a drag down
//   strict: true           only s.close() closes it: for a question that must be answered
//
// A page opens its sheets with ctx: ctx.onDispose(s.close). Nothing here touches the DOM at
// import time.
import { html, render } from '../core/dom.js';

const CLOSE_MS = 160;
const DRAG_CLOSE_PX = 90;
let open = null;

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Close whichever sheet is open (navigation does this). */
export const closeSheet = () => open?.close();

export function openSheet({ label, content = null, onClose = null, strict = false } = {}) {
  open?.close({ now: true });

  const dlg = document.createElement('dialog');
  dlg.className = strict ? 'sheet is-strict' : 'sheet';
  dlg.setAttribute('aria-label', label || 'Details');
  render(dlg, html`
    <div class="sheet-grab" aria-hidden="true"><i></i></div>
    <div class="sheet-head"><span class="sheet-title">${label || ''}</span><button type="button" class="sheet-close">CLOSE ×</button></div>
    <div class="sheet-body"></div>`);
  const body = dlg.querySelector('.sheet-body');
  if (content) render(body, content);
  document.body.appendChild(dlg);

  let closed = false;
  const finish = () => {
    if (open === api) open = null;
    // A toast shown from inside the sheet (flash.js) outlives it.
    const region = dlg.querySelector('.flash-region');
    if (region) document.body.appendChild(region);
    if (dlg.open) dlg.close();
    dlg.remove();
    if (!open) document.documentElement.classList.remove('sheet-open');
    try { onClose?.(); } catch (err) { console.error(err); }
  };
  const api = {
    body,
    el: dlg,
    close({ now = false } = {}) {
      if (closed) return;
      closed = true;
      if (now || reducedMotion()) { finish(); return; }
      dlg.classList.add('is-closing');
      setTimeout(finish, CLOSE_MS);
    },
  };

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!strict) api.close(); }); // Escape
  dlg.addEventListener('click', (e) => {
    if (strict) return;
    if (e.target === dlg) api.close(); // the scrim: a click on the dialog box itself, outside its content
    else if (e.target.closest('.sheet-close')) api.close();
  });

  // Drag the handle down to dismiss.
  const grab = dlg.querySelector('.sheet-grab');
  let startY = null;
  grab.addEventListener('pointerdown', (e) => { if (strict) return; startY = e.clientY; grab.setPointerCapture(e.pointerId); dlg.classList.add('is-dragging'); });
  grab.addEventListener('pointermove', (e) => { if (startY !== null) dlg.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`; });
  const drop = (e) => {
    if (startY === null) return;
    const moved = e.clientY - startY;
    startY = null;
    dlg.classList.remove('is-dragging');
    dlg.style.transform = '';
    if (moved > DRAG_CLOSE_PX) api.close();
  };
  grab.addEventListener('pointerup', drop);
  grab.addEventListener('pointercancel', drop);

  dlg.showModal();
  document.documentElement.classList.add('sheet-open');
  open = api;
  return api;
}

/**
 * Ask before doing something, in a sheet (a browser confirm can't say much and looks foreign on
 * a phone). → Promise<{ ok, reason }>. `reasonLabel` adds an optional reason field.
 *
 * Focus starts on the safe choice. `danger` is for anything destructive or that really sends:
 * only the two buttons answer it (no Escape, no scrim, no drag), and Enter in the reason field
 * doesn't confirm. Leaving the page answers no.
 */
export function askSheet({ label, text, action, danger = false, reasonLabel = null, reasonMax = 200, keep = 'KEEP IT' }) {
  return new Promise((resolve) => {
    let answer = { ok: false, reason: '' };
    const sheet = openSheet({
      label,
      strict: danger,
      content: html`<form class="ask-form">
        <p class="ask-text">${text}</p>
        ${reasonLabel ? html`<label class="form-row"><span class="form-label">${reasonLabel}</span><input type="text" name="reason" maxlength="${reasonMax}"></label>` : ''}
        <div class="ask-acts"><button type="button" data-ask="no">${keep}</button><button type="submit" class="${danger ? 'danger' : 'primary'}">${action}</button></div>
      </form>`,
      onClose: () => resolve(answer),
    });
    const form = sheet.body.querySelector('form');
    const safe = form.querySelector('[data-ask="no"]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (danger && e.submitter !== form.querySelector('button[type="submit"]')) return; // Enter in the field
      answer = { ok: true, reason: String(new FormData(form).get('reason') || '').trim() };
      sheet.close();
    });
    safe.addEventListener('click', () => sheet.close());
    safe.focus();
  });
}
