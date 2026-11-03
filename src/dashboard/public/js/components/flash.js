// Transient toast in the corner. Text only (never markup); announced to screen
// readers through a polite live region.

let region = null;
function liveRegion() {
  if (!region) {
    region = document.createElement('div');
    region.className = 'flash-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
  }
  // An open sheet is in the top layer, above anything in the page: a toast goes inside it.
  const host = document.querySelector('dialog[open]') || document.body;
  if (region.parentElement !== host) host.appendChild(region);
  return region;
}

export function flash(msg, type = 'ok', ms = 3500) {
  const bar = document.createElement('div');
  bar.className = `flash ${type}`;
  bar.textContent = String(msg ?? '');
  liveRegion().appendChild(bar);
  setTimeout(() => bar.remove(), ms);
}
