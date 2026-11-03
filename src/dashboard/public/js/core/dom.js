// HTML building with automatic escaping (spec 007 FR-042).
//
//   html`<b title="${name}">${text}</b>`   every interpolation is escaped
//   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`   nested html passes through
//   raw('<i>trusted</i>')                  opt-out, for static markup only
//
// null / undefined / false render as nothing; arrays are joined. Nothing here
// touches the DOM at import time, so the module also loads in node (tests).

class Html {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

/** Mark a string as trusted markup (no escaping). Use for static strings only. */
export const raw = (s) => (s instanceof Html ? s : new Html(String(s ?? '')));

function part(v) {
  if (v == null || v === false) return '';
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return escapeHtml(v);
}

/** Tagged template: escapes every interpolation unless it is html`` or raw(). */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Html(out);
}

export const isHtml = (v) => v instanceof Html;
export const renderToString = (tpl) => part(tpl);

/** Replace an element's content with a template (or plain text, escaped). */
export function render(target, tpl) {
  if (!target) return;
  target.innerHTML = part(tpl);
}

/** Build a DOM node. Strings become text nodes; `on<event>` attrs add listeners. */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

/**
 * A setSlot that leaves the DOM alone when the template renders the same as last time, for pages
 * that poll: an open select, a scroll position, a pressed row and focus survive a poll with
 * nothing new.
 */
export function slotPainter(root) {
  const last = new Map();
  return (key, tpl) => {
    const next = part(tpl);
    if (last.get(key) === next) return;
    last.set(key, next);
    const node = root?.querySelector(`[data-slot="${key}"]`);
    if (node) node.innerHTML = next;
  };
}

export const $ = (root, sel) => root?.querySelector(sel) || null;
export const $$ = (root, sel) => (root ? [...root.querySelectorAll(sel)] : []);

/** Fill [data-slot] elements with text (never markup). null → an em dash. */
export function setSlots(root, map) {
  for (const [key, val] of Object.entries(map)) {
    const node = root?.querySelector(`[data-slot="${key}"]`);
    if (!node) continue;
    if (typeof Node !== 'undefined' && val instanceof Node) { node.replaceChildren(val); continue; }
    node.textContent = val == null ? '—' : String(val);
  }
}

/** Fill one [data-slot] with a template. */
export function setSlot(root, key, tpl) {
  render(root?.querySelector(`[data-slot="${key}"]`), tpl);
}
