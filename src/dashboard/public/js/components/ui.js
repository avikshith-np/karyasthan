// Small shared view helpers for page modules: error box, sparkbar, area chart
// paths, ON/off flags. Nothing touches the DOM at import time.
import { html, render } from '../core/dom.js';

/** Replace a page root with an error line (text only). */
export function showError(root, err) {
  render(root, html`<div class="empty" role="alert" style="color:var(--red-bright)">ERROR · ${err?.message || String(err)}</div>`);
}

/** Bars scaled to the max; the top `hiCount` values are highlighted. */
export function renderSparkbar(container, values, hiCount = 3) {
  if (!container) return;
  container.replaceChildren();
  if (!values.length) return;
  const max = Math.max(1, ...values);
  const sortedDesc = [...values].sort((a, b) => b - a);
  const hiThreshold = sortedDesc[Math.min(hiCount, sortedDesc.length) - 1] ?? 0;
  for (const v of values) {
    const span = document.createElement('span');
    span.style.height = Math.max(2, Math.round((v / max) * 100)) + '%';
    if (v > 0 && v >= hiThreshold) span.className = 'hi';
    container.appendChild(span);
  }
}

/** SVG path data (line + closed fill) for an area chart. */
export function buildAreaPath(values, w = 700, h = 220, top = 0, bottom = 220, scaleMax = null) {
  const n = values.length;
  if (!n) return { line: '', fill: '', max: 0 };
  // scaleMax: draw against a shared maximum (two series on one axis), else this series' own.
  const max = Math.max(1, scaleMax ?? 0, ...values);
  const stepX = w / Math.max(n - 1, 1);
  const range = bottom - top;
  const pts = values.map((v, i) => `${+(i * stepX).toFixed(1)},${+(bottom - (v / max) * range).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  return { line, fill: `${line} L${w},${bottom} L0,${bottom} Z`, max };
}

/** "▣ ON" (amber) / "▢ off" (green) flag cell. */
export const flag = (v) => (v ? html`<b class="amber">▣ ON</b>` : html`<b class="green">▢ off</b>`);
