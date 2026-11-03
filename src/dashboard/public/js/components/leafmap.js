// Leaflet maps for Life · Map and Life · Day (spec 014 §B.2).
//
// Leaflet 1.9.4 is vendored under /vendor/leaflet/1.9.4/ (pinned by sha256 in
// SHA256SUMS; no CDN) and loaded lazily: nothing here touches the DOM or
// Leaflet at import time, so page modules still import in node, and a failed
// import (or a missing file) makes mountMap() answer null — the page then
// draws its local SVG grid instead.
//
// Tiles: loaded by the viewer's browser from the server's LIFE_MAP_TILE_URL
// (null → no tile layer, a plain background, "no tiles" in the attribution),
// with referrerPolicy 'origin' (the tile host sees the dashboard's origin,
// never its path). The map is mounted once per page visit; callers refill
// layers on a poll and never remount or cache-bust tiles (OSM tile policy).
//
// HTML sinks (plan R15): page data never reaches Leaflet as markup.
// textTooltip() is the one place a tooltip is bound, and it binds a DOM node
// whose text is set with textContent. The attribution is the server's
// constant, escaped, set once below. Map pages call none of Leaflet's HTML
// entry points themselves (test:dashboard checks the sources).
import { el, html } from '../core/dom.js';

export const LEAFLET_VERSION = '1.9.4';
const CSS_ID = 'leafletCss';
const CSS_WAIT_MS = 4000;
const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const MAX_ZOOM = 19;
const TOOLTIP_DIRECTIONS = new Set(['auto', 'top', 'bottom', 'left', 'right', 'center']);

const defaultImport = () => import('../../vendor/leaflet/1.9.4/leaflet-src.esm.js');
let cached = null;

/** Add Leaflet's stylesheet once (an el()-built <link>, no markup); resolves when loaded or after a short wait. */
function ensureCss(doc) {
  if (doc.getElementById(CSS_ID)) return Promise.resolve();
  const link = el('link', { id: CSS_ID, rel: 'stylesheet', href: new URL('../../vendor/leaflet/1.9.4/leaflet.css', import.meta.url).href });
  const ready = new Promise((resolve) => {
    const t = setTimeout(resolve, CSS_WAIT_MS);
    const done = () => { clearTimeout(t); resolve(); };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
  });
  doc.head.appendChild(link);
  return ready;
}

/**
 * The Leaflet module, or null when it can't load (no DOM, import failure, a
 * module without the API we use). `importer` is injectable for tests; only
 * the default import is cached (a failure is retried on the next page visit).
 */
export async function loadLeaflet({ importer = null, doc = globalThis.document } = {}) {
  if (!doc?.head || typeof doc.getElementById !== 'function') return null;
  const own = typeof importer === 'function';
  try {
    const p = own ? Promise.resolve().then(importer) : (cached ||= defaultImport());
    const [L] = await Promise.all([p, ensureCss(doc)]);
    if (!L || typeof L.map !== 'function' || typeof L.tileLayer !== 'function') throw new Error('leaflet: unexpected module');
    return L;
  } catch {
    if (!own) cached = null;
    return null;
  }
}

/** The attribution markup: the server's constant (escaped; OSM linked to its copyright page) + Leaflet. */
export function attributionMarkup(tileUrl, attribution) {
  if (!tileUrl) return String(html`no tiles · Leaflet`);
  const text = typeof attribution === 'string' && attribution.trim() ? attribution.trim().slice(0, 120) : 'map tiles';
  return /openstreetmap/i.test(text)
    ? String(html`<a href="${OSM_COPYRIGHT}" target="_blank" rel="noopener noreferrer">${text}</a> · Leaflet`)
    : String(html`${text} · Leaflet`);
}

/**
 * Mount a Leaflet map into `container` (it must have a size; the CSS gives
 * .leaf-map one). → { L, map, layer(name), setView, fit, textTooltip, dispose }
 * or null when Leaflet can't load or the page went away meanwhile. Disposed
 * with the page (ctx.onDispose).
 */
export async function mountMap(container, { tileUrl = null, attribution = null, ctx = null, load = loadLeaflet, doc = globalThis.document } = {}) {
  if (!container) return null;
  let L = null;
  try { L = await load({ doc }); } catch { L = null; }
  if (!L || (ctx && !ctx.alive())) return null;
  let map;
  try {
    map = L.map(container, { zoomControl: true, attributionControl: true, worldCopyJump: false, maxZoom: MAX_ZOOM });
  } catch {
    return null;
  }
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(attributionMarkup(tileUrl, attribution));
  if (tileUrl) {
    L.tileLayer(tileUrl, { maxZoom: MAX_ZOOM, referrerPolicy: 'origin' }).addTo(map);
  } else {
    container.classList?.add('leaf-notiles');
  }
  L.control.scale({ imperial: false }).addTo(map);

  const layers = new Map();
  const layer = (name) => {
    if (!layers.has(name)) layers.set(name, L.layerGroup().addTo(map));
    return layers.get(name);
  };

  /** The one tooltip sink: a text node, never markup. */
  const textTooltip = (target, text, opts = {}) => {
    const node = doc.createElement('span');
    node.textContent = String(text ?? '');
    target.bindTooltip(node, {
      permanent: opts.permanent === true,
      direction: TOOLTIP_DIRECTIONS.has(opts.direction) ? opts.direction : 'top',
      className: opts.label ? 'leaf-label' : 'leaf-tip',
      offset: [0, opts.label ? 0 : -6],
    });
    return target;
  };

  const setView = (lat, lon, zoom = 15) => map.setView([lat, lon], zoom);
  /** Fit [[lat, lon]…]; one point → a street-level view; none → nothing. */
  const fit = (points) => {
    const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return;
    if (pts.length === 1) { map.setView(pts[0], 15); return; }
    map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 16 });
  };

  // Leaflet measures its container: once after mount and when it first gets a size (R40).
  const raf = globalThis.requestAnimationFrame?.(() => map.invalidateSize());
  let ro = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    ro = new globalThis.ResizeObserver(() => map.invalidateSize());
    ro.observe(container);
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (raf != null) globalThis.cancelAnimationFrame?.(raf);
    ro?.disconnect();
    layers.clear();
    try { map.remove(); } catch { /* already gone */ }
  };
  ctx?.onDispose?.(dispose);
  return { L, map, layer, setView, fit, textTooltip, dispose };
}
