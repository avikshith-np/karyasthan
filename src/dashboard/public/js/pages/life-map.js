// LIFE · MAP (spec 009 T039, 014 §B.4) — his places, where he is now
// (interpolated while travelling), the trips of the last 48 h and the rest of
// today's planned ones.
//
// 014: a Leaflet map (components/leafmap.js, vendored Leaflet) with tiles from
// LIFE_MAP_TILE_URL, loaded by the viewer's browser: places as circle markers,
// home as a 400 m area, his position, trips along their stored road geometry
// (trips[].pts from /api/life/map) or as straight lines; solid = done, dashed
// = planned. The map is mounted once per visit; the 30 s poll refills its
// layers only when the places or trips change. When tiles are off
// (tileUrl null) or Leaflet can't load, the self-contained inline SVG grid
// below (equirectangular, x scaled by cos(mean latitude); no external
// request) is drawn instead. Page data reaches Leaflet only as text
// (leafmap.js textTooltip).
import { api, isAbort } from '../core/api.js';
import { html, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtHm, fmtRelative } from '../core/fmt.js';
import { showError } from '../components/ui.js';
import { fold, initFolds } from '../components/views.js';
import { offNote } from './life-now.js';
import { getStatus } from '../components/topbar.js';
import { mountMap } from '../components/leafmap.js';

const POLL_MS = 30_000;
const W = 1000;
const H = 620;
const PAD = 70;
const KM_PER_DEG = 111.32;
const MIN_SPAN_KM = 1.5;
const FAR_MIN_KM = 15;
const FAR_FACTOR = 4;
const EDGE = 26;

const shell = (wide) => html`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · MAP · PLACES + TRIPS (48 H)</div>
    <h1>Map</h1>
  </div>
  <div class="meta">
    <span>PLACES <b data-slot="lm-places">—</b></span>
    <span>TRIPS <b data-slot="lm-trips">—</b></span>
    <span>NOW <b data-slot="lm-where">—</b></span>
  </div>
</div>
<div data-slot="lm-off"></div>
<div class="panel">
  <div class="panel-head"><span>MAP<button type="button" class="guide-q" data-guide="map" aria-label="Guide: map">?</button></span><span class="mono mute" data-slot="lm-tiles">—</span></div>
  <div class="panel-body life-map-wrap"><div class="leaf-map" data-leaf hidden></div><div data-slot="lm-svg" class="life-map"></div></div>
</div>
<div class="lm-lists">
  <div class="panel">
    <div class="panel-head"><span>TRIPS · NEWEST FIRST · PLANNED ON TOP<button type="button" class="guide-q" data-guide="trips" aria-label="Guide: trips">?</button></span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>LEFT</th><th>FROM → TO</th><th>MODE</th><th>ARRIVED</th></tr></thead>
      <tbody data-slot="lm-trip-rows"></tbody>
    </table></div>
  </div>
  ${fold({
    id: 'map.places',
    open: wide,
    title: html`PLACES<button type="button" class="guide-q" data-guide="places" aria-label="Guide: places">?</button>`,
    meta: 'WHERE HE GOES',
    // Not in the head: there a tap meant to open the fold would land on the link.
    body: html`<div class="panel-body lm-places-note"><a class="mono" href="#life/director/build">find / make places real on the Director page</a></div>
    <div class="table-wrap"><table class="data">
      <thead data-slot="lm-place-head"><tr><th>ID</th><th>NAME</th><th>KIND</th><th>LAT, LON</th></tr></thead>
      <tbody data-slot="lm-place-rows"></tbody>
    </table></div>`,
  })}
</div>
`;

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const kindClass = (k) => `lm-kind-${String(k || 'place').toLowerCase().replace(/[^a-z_-]/g, '')}`;

/** Fit lat/lon points into the viewBox. Returns { x(lon), y(lat), kmPerPx } or null. */
export function projection(points, w = W, h = H, pad = PAD) {
  const pts = points.filter((p) => ok(p.lat) && ok(p.lon));
  if (!pts.length) return null;
  let minLat = Math.min(...pts.map((p) => p.lat));
  let maxLat = Math.max(...pts.map((p) => p.lat));
  let minLon = Math.min(...pts.map((p) => p.lon));
  let maxLon = Math.max(...pts.map((p) => p.lon));
  const midLat = (minLat + maxLat) / 2;
  const k = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  // A minimum span so one place (or two on top of each other) doesn't divide by zero.
  const minDeg = MIN_SPAN_KM / KM_PER_DEG;
  if (maxLat - minLat < minDeg) { const c = (minLat + maxLat) / 2; minLat = c - minDeg / 2; maxLat = c + minDeg / 2; }
  if ((maxLon - minLon) * k < minDeg) { const c = (minLon + maxLon) / 2; minLon = c - minDeg / (2 * k); maxLon = c + minDeg / (2 * k); }
  const spanX = (maxLon - minLon) * k;
  const spanY = maxLat - minLat;
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const offX = (w - spanX * scale) / 2;
  const offY = (h - spanY * scale) / 2;
  return {
    x: (lon) => +(offX + (lon - minLon) * k * scale).toFixed(1),
    y: (lat) => +(h - offY - (lat - minLat) * scale).toFixed(1),
    kmPerPx: KM_PER_DEG / scale,
    bounds: { minLat, maxLat, minLon, maxLon },
  };
}

function niceKm(km) {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  return steps.find((s) => s >= km) ?? km;
}

/** Rough ground distance in km (equirectangular; fine at city scale). */
export function kmBetween(a, b) {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat), (a.lon - b.lon) * k) * KM_PER_DEG;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/**
 * Split places into the local cluster (fitted on the map) and far ones (a
 * family home in another town) drawn as edge markers, so one distant place
 * doesn't squash the neighbourhood into a corner. Far = more than
 * max(FAR_MIN_KM, FAR_FACTOR × the median distance) from the median point.
 */
export function splitFar(places) {
  const pts = places.filter((p) => ok(p.lat) && ok(p.lon));
  if (pts.length < 3) return { local: pts, far: [], center: pts[0] || null };
  const center = { lat: median(pts.map((p) => p.lat)), lon: median(pts.map((p) => p.lon)) };
  const d = new Map(pts.map((p) => [p, kmBetween(p, center)]));
  const limit = Math.max(FAR_MIN_KM, FAR_FACTOR * median([...d.values()]));
  const local = pts.filter((p) => d.get(p) <= limit);
  const far = pts.filter((p) => d.get(p) > limit).map((p) => ({ ...p, km: d.get(p) }));
  return local.length ? { local, far, center } : { local: pts, far: [], center };
}

// A minute's slack: an arrival logged within it of the plan counts as on time.
const LATE_SLACK_SEC = 60;
/**
 * ARRIVED cell: the actual arrival from the log; the planned one only when late or
 * not (yet) arrived. `enRoute`: this is the trip he is on now.
 */
export function arrivedCell(t, enRoute = false) {
  if (!Number.isFinite(t.arrivedAt)) {
    return html`<span class="mute">${enRoute ? 'en route' : 'not logged'} · planned ${fmtHm(t.endAt)}</span>`;
  }
  return t.arrivedAt > t.endAt + LATE_SLACK_SEC
    ? html`${fmtHm(t.arrivedAt)} <span class="mute">(planned ${fmtHm(t.endAt)})</span>`
    : html`${fmtHm(t.arrivedAt)}`;
}

export function mapSvg({ places = [], position = null, trips = [] }) {
  const byId = new Map(places.map((p) => [p.id, p]));
  const { local, far, center } = splitFar(places);
  const farIds = new Set(far.map((p) => p.id));
  const pts = [...local];
  // His position joins the fit only while it is near the cluster (else it is an edge marker too).
  const posFar = position && ok(position.lat) && ok(position.lon) && center && far.length
    && kmBetween(position, center) > Math.max(FAR_MIN_KM, ...local.map((p) => kmBetween(p, center)));
  if (position && ok(position.lat) && !posFar) pts.push(position);
  const pr = projection(pts);
  if (!pr) return html`<div class="empty">NO PLACES WITH COORDINATES</div>`;
  const cx = pr.x(center?.lon ?? (pr.bounds.minLon + pr.bounds.maxLon) / 2);
  const cy = pr.y(center?.lat ?? (pr.bounds.minLat + pr.bounds.maxLat) / 2);
  const k = Math.max(0.05, Math.cos(((center?.lat ?? 0) * Math.PI) / 180));
  // Where a far point sits on the frame: the ray from the cluster centre, clipped EDGE px inside.
  const edge = (p) => {
    const dx = (p.lon - (center?.lon ?? 0)) * k;
    const dy = -(p.lat - (center?.lat ?? 0));
    const tx = dx > 0 ? (W - EDGE - cx) / dx : dx < 0 ? (EDGE - cx) / dx : Infinity;
    const ty = dy > 0 ? (H - EDGE - cy) / dy : dy < 0 ? (EDGE - cy) / dy : Infinity;
    const t = Math.min(tx, ty);
    return Number.isFinite(t) ? { x: +(cx + dx * t).toFixed(1), y: +(cy + dy * t).toFixed(1) } : { x: cx, y: EDGE };
  };
  const at = (p) => (farIds.has(p.id) ? edge(p) : { x: pr.x(p.lon), y: pr.y(p.lat) });
  // Grid: ~6 lines across, in whole multiples of a nice step.
  const grid = [];
  const { minLat, maxLat, minLon, maxLon } = pr.bounds;
  const pad = (PAD / H) * (maxLat - minLat) * 2;
  const step = niceKm(((maxLat - minLat + pad) * KM_PER_DEG) / 6) / KM_PER_DEG;
  for (let lat = Math.floor((minLat - pad) / step) * step, n = 0; lat <= maxLat + pad && n < 60; lat += step, n++) {
    const y = pr.y(lat);
    if (y >= 0 && y <= H) grid.push(html`<line class="lm-grid" x1="0" x2="${W}" y1="${y}" y2="${y}"></line>`);
  }
  const lonStep = step / Math.max(0.05, Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
  for (let lon = Math.floor((minLon - pad * 3) / lonStep) * lonStep, n = 0; lon <= maxLon + pad * 3 && n < 80; lon += lonStep, n++) {
    const x = pr.x(lon);
    if (x >= 0 && x <= W) grid.push(html`<line class="lm-grid" x1="${x}" x2="${x}" y1="0" y2="${H}"></line>`);
  }
  // Trips: straight lines between the two places (014: along the stored road
  // geometry when the trip has pts and both places are on the map), newest
  // drawn last (on top); dashed to a far place; planned ones dashed and faint.
  const sorted = [...trips].sort((a, b) => a.startAt - b.startAt);
  const pastN = sorted.filter((t) => !t.planned).length;
  let pastI = 0;
  const tripEls = sorted.map((t) => {
    const a = byId.get(t.from); const b = byId.get(t.to);
    if (!a || !b || !ok(a.lat) || !ok(b.lat)) return '';
    const recent = !t.planned && pastI++ >= pastN - 3;
    const far = farIds.has(a.id) || farIds.has(b.id);
    const p1 = at(a); const p2 = at(b);
    const road = !far && Array.isArray(t.pts) && t.pts.length >= 2 && t.pts.every((q) => Array.isArray(q) && ok(q[0]) && ok(q[1]));
    const shape = road
      ? html`<polyline points="${t.pts.map((q) => `${pr.x(q[1])},${pr.y(q[0])}`).join(' ')}" marker-end="url(#lmArrow)"></polyline>`
      : html`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" marker-end="url(#lmArrow)"></line>`;
    return html`<g class="lm-trip ${recent ? 'is-recent' : ''} ${far ? 'is-far' : ''} ${t.planned ? 'is-planned' : ''}">
      ${shape}
      <title>${`${a.name} → ${b.name} · ${t.mode || ''} · ${fmtHm(t.startAt)}–${fmtHm(t.arrivedAt ?? t.endAt)}${t.planned ? ' · planned' : ''}`}</title>
    </g>`;
  });
  const placeEls = local.map((p) => {
    const x = pr.x(p.lon); const y = pr.y(p.lat);
    const left = x > W - 180;
    return html`<g class="lm-place ${kindClass(p.kind)}">
      <circle cx="${x}" cy="${y}" r="7"></circle>
      <text x="${left ? x - 11 : x + 11}" y="${y + 4}" text-anchor="${left ? 'end' : 'start'}">${p.name}</text>
      <title>${`${p.name} · ${p.kind || 'place'} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}</title>
    </g>`;
  });
  const farEls = far.map((p) => {
    const { x, y } = edge(p);
    const left = x > W / 2;
    const up = y > H / 2;
    return html`<g class="lm-place lm-far ${kindClass(p.kind)}">
      <rect x="${x - 6}" y="${y - 6}" width="12" height="12" transform="rotate(45 ${x} ${y})"></rect>
      <text x="${left ? x - 14 : x + 14}" y="${up ? y - 10 : y + 16}" text-anchor="${left ? 'end' : 'start'}">${`${p.name} · ${Math.round(p.km)} km`}</text>
      <title>${`${p.name} · ${p.kind || 'place'} · ${Math.round(p.km)} km away (off this map) · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}</title>
    </g>`;
  });
  let me = '';
  if (position && ok(position.lat) && ok(position.lon)) {
    const { x, y } = posFar ? edge(position) : { x: pr.x(position.lon), y: pr.y(position.lat) };
    me = html`<g class="lm-me ${position.travelling ? 'is-moving' : ''}">
      <circle class="lm-me-halo" cx="${x}" cy="${y}" r="16"></circle>
      <circle class="lm-me-dot" cx="${x}" cy="${y}" r="6"></circle>
      <title>${position.travelling ? 'Travelling now' : 'He is here'}</title>
    </g>`;
  }
  const barKm = niceKm(pr.kmPerPx * 120);
  const barPx = barKm / pr.kmPerPx;
  const scaleBar = html`<g class="lm-scale"><line x1="20" x2="${20 + barPx}" y1="${H - 22}" y2="${H - 22}"></line>
    <line x1="20" x2="20" y1="${H - 27}" y2="${H - 17}"></line><line x1="${20 + barPx}" x2="${20 + barPx}" y1="${H - 27}" y2="${H - 17}"></line>
    <text x="20" y="${H - 30}">${barKm < 1 ? `${Math.round(barKm * 1000)} m` : `${barKm} km`}</text></g>`;
  return html`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of his places and recent trips">
    <defs><marker id="lmArrow" viewBox="0 0 8 8" refX="14" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="lm-arrow-head"></path></marker></defs>
    <rect class="lm-bg" x="0" y="0" width="${W}" height="${H}"></rect>
    ${grid}${tripEls}${placeEls}${farEls}${me}${scaleBar}
  </svg>`;
}

// ── 014: the Leaflet map ────────────────────────────────────────────────────

const LEAF_RECENT = 3;

/** Which map the page draws: Leaflet needs tiles configured and life running (else the SVG grid). */
export const wantsLeaflet = (m) => !!(m && m.running && typeof m.tileUrl === 'string' && m.tileUrl);

/** A trip's line: its stored road geometry (pts) when present, else the straight line between its places. */
export function tripLine(t, byId) {
  if (Array.isArray(t?.pts) && t.pts.length >= 2 && t.pts.every((p) => Array.isArray(p) && ok(p[0]) && ok(p[1]))) {
    return { latlngs: t.pts, routed: true };
  }
  const a = byId.get(t?.from);
  const b = byId.get(t?.to);
  if (!a || !b || !ok(a.lat) || !ok(a.lon) || !ok(b.lat) || !ok(b.lon)) return null;
  return { latlngs: [[a.lat, a.lon], [b.lat, b.lon]], routed: false };
}

/** Tooltip text of a trip (text only; leafmap's textTooltip sets it with textContent). */
export function tripTip(t, name, routed) {
  const when = `${fmtHm(t.startAt)}–${fmtHm(t.arrivedAt ?? t.endAt)}`;
  return `${name(t.from)} → ${name(t.to)} · ${t.mode || 'trip'} · ${when}${t.planned ? ' · planned' : ''}${routed ? ' · by road' : ' · straight line'}`;
}

/** Tooltip text of a place: name, kind, and the area of a real venue. */
export function placeTip(p) {
  return `${p.name} · ${p.kind || 'place'}${p.area ? ` · ${p.area}` : ''}${p.venue ? ' · real venue' : ''}`;
}

/** What the layers show; the poll redraws only when this changes (never a remount, never new tile URLs). */
export function leafSig(m) {
  return JSON.stringify([
    (m?.places || []).map((p) => [p.id, p.name, p.kind, p.lat, p.lon, p.area ?? null, !!p.venue]),
    (m?.trips || []).map((t) => [t.eventId ?? null, t.from, t.to, t.mode, t.startAt, t.endAt, t.arrivedAt ?? null, !!t.planned, t.pts?.length ?? 0]),
    m?.home ? [m.home.placeId ?? null, m.home.lat, m.home.lon, m.home.radiusM] : null,
  ]);
}

/**
 * Refill the map's layers from a /api/life/map answer: home as an area, the
 * other places as circle markers (local ones labelled), trips as lines (solid
 * = done, the last few highlighted; dashed = planned). Text only.
 */
export function drawLeaf(h, m, { labels = true } = {}) {
  const { L } = h;
  const places = m.places || [];
  const byId = new Map(places.map((p) => [p.id, p]));
  const name = (id) => byId.get(id)?.name || id || '?';
  const { far } = splitFar(places);
  const farIds = new Set(far.map((p) => p.id));
  for (const n of ['home', 'trips', 'places']) h.layer(n).clearLayers();
  const homeId = m.home?.placeId ?? null;
  if (m.home && ok(m.home.lat) && ok(m.home.lon)) {
    const area = L.circle([m.home.lat, m.home.lon], { radius: m.home.radiusM || 400, className: 'leaf-home', weight: 1.5 });
    h.textTooltip(area, `${name(homeId)} · home (drawn as a ${m.home.radiusM || 400} m area)`);
    h.layer('home').addLayer(area);
  }
  const trips = [...(m.trips || [])].sort((a, b) => a.startAt - b.startAt);
  const past = trips.filter((t) => !t.planned);
  trips.forEach((t) => {
    const line = tripLine(t, byId);
    if (!line) return;
    const recent = !t.planned && past.indexOf(t) >= past.length - LEAF_RECENT;
    const cls = ['leaf-trip', t.planned ? 'is-planned' : 'is-done', recent ? 'is-recent' : '', line.routed ? 'is-routed' : ''].filter(Boolean).join(' ');
    const pl = L.polyline(line.latlngs, { className: cls, weight: recent || t.planned ? 3 : 2, ...(t.planned ? { dashArray: '6 6' } : {}) });
    h.textTooltip(pl, tripTip(t, name, line.routed));
    h.layer('trips').addLayer(pl);
  });
  for (const p of places) {
    if (p.id === homeId || !ok(p.lat) || !ok(p.lon)) continue;
    const dot = L.circleMarker([p.lat, p.lon], { radius: 6, weight: 2, fillOpacity: 0.9, className: `leaf-place ${kindClass(p.kind)}${p.venue ? ' is-venue' : ''}` });
    h.textTooltip(dot, labels && !farIds.has(p.id) ? p.name : placeTip(p), labels && !farIds.has(p.id) ? { permanent: true, direction: 'right', label: true } : {});
    h.layer('places').addLayer(dot);
  }
}

/** His position marker (its own layer: it moves between redraws of the rest). */
export function drawMe(h, position) {
  h.layer('me').clearLayers();
  if (!position || !ok(position.lat) || !ok(position.lon)) return;
  const me = h.L.circleMarker([position.lat, position.lon], { radius: 7, weight: 2, fillOpacity: 1, className: `leaf-me${position.travelling ? ' is-moving' : ''}` });
  h.textTooltip(me, position.travelling ? 'Travelling now' : 'He is here');
  h.layer('me').addLayer(me);
}

/** Points the first view fits: the local places (not a far family home) and where he is. */
export function fitPoints(m) {
  const { local } = splitFar(m.places || []);
  const pts = local.map((p) => [p.lat, p.lon]);
  if (m.position && ok(m.position.lat) && ok(m.position.lon) && pts.length < 3) pts.push([m.position.lat, m.position.lon]);
  return pts;
}

/** PLACES rows; VENUE / AREA columns only when some row carries them (014 geo). */
export function placeTable(places) {
  const extra = places.some((p) => p.venue || p.area);
  const head = html`<tr><th>ID</th><th>NAME</th><th>KIND</th>${extra ? html`<th>VENUE</th><th>AREA</th>` : ''}<th>LAT, LON</th></tr>`;
  const rows = places.length
    ? places.map((p) => html`<tr><td class="id">${p.id}</td><td>${p.name}</td><td>${p.kind || '—'}</td>${extra ? html`<td>${p.venue ? 'real' : '—'}</td><td>${p.area || '—'}</td>` : ''}<td class="mono">${ok(p.lat) ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '—'}</td></tr>`)
    : html`<tr><td colspan="${extra ? 6 : 4}" class="empty">NO PLACES</td></tr>`;
  return { head, rows };
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, shell(!globalThis.matchMedia?.('(max-width: 900px)').matches));
  initFolds(root);
  const box = $(root, '[data-leaf]');
  let svgSig = '';
  let listSig = '';

  // The grid map is wider than a phone: it scrolls in its own box and starts with him in view.
  const centreSvg = () => {
    const wrap = $(root, '.life-map-wrap');
    const me = $(root, '.lm-me');
    if (!wrap || !me || wrap.scrollWidth <= wrap.clientWidth) return;
    const a = me.getBoundingClientRect();
    const b = wrap.getBoundingClientRect();
    wrap.scrollLeft += a.left + a.width / 2 - b.left - wrap.clientWidth / 2;
  };
  let leaf = null;        // the Leaflet handle, once mounted
  let leafTry = null;     // the one mount attempt (a promise), per visit
  let leafFailed = false;
  let sig = '';
  let meSig = '';

  // Mount Leaflet once, when tiles are configured and life runs; null → the SVG grid.
  function ensureLeaf(m) {
    if (leaf || leafFailed || !wantsLeaflet(m)) return Promise.resolve(leaf);
    if (!leafTry) {
      box.hidden = false;
      leafTry = mountMap(box, { tileUrl: m.tileUrl, attribution: m.attribution, ctx }).then((h) => {
        leaf = h;
        if (!h) { leafFailed = true; box.hidden = true; }
        return h;
      });
    }
    return leafTry;
  }

  async function load() {
    const m = await api('/api/life/map', { signal: ctx.signal });
    if (!ctx.alive()) return;
    const h = await ensureLeaf(m);
    if (!ctx.alive()) return;
    const byId = new Map((m.places || []).map((p) => [p.id, p]));
    const name = (id) => byId.get(id)?.name || id || '?';
    const pos = m.position;
    const past = (m.trips || []).filter((t) => !t.planned);
    const planned = (m.trips || []).filter((t) => t.planned);
    setSlot(root, 'lm-off', m.running ? null : offNote(getStatus()?.life?.skill === true));
    setSlots(root, {
      'lm-places': (m.places || []).length,
      'lm-trips': planned.length ? `${past.length} + ${planned.length} PLANNED` : past.length,
      'lm-where': !m.running ? '—' : pos?.travelling ? 'TRAVELLING' : pos?.placeId ? name(pos.placeId) : '—',
      'lm-tiles': !m.tileUrl
        ? 'TILES DISABLED (LIFE_MAP_TILE_URL EMPTY) · LOCAL GRID'
        : h ? 'LEAFLET · TILES LOADED BY YOUR BROWSER'
          : leafFailed ? 'LEAFLET DID NOT LOAD · LOCAL GRID' : 'LOCAL GRID',
    });
    if (h && m.running) {
      setSlot(root, 'lm-svg', null);
      const next = leafSig(m);
      if (next !== sig) {
        const first = !sig;
        sig = next;
        drawLeaf(h, m);
        if (first) h.fit(fitPoints(m));
      }
      const nextMe = pos && ok(pos.lat) ? `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)},${!!pos.travelling}` : '';
      if (nextMe !== meSig) { meSig = nextMe; drawMe(h, pos); }
    } else {
      // Only when something moved, so a poll leaves the scroll and a tap on the map alone.
      const nextSvg = JSON.stringify([m.running, m.places, m.trips, pos]);
      if (nextSvg !== svgSig) {
        const first = !svgSig;
        svgSig = nextSvg;
        setSlot(root, 'lm-svg', m.running ? mapSvg(m) : html`<div class="empty">LIFE IS NOT RUNNING</div>`);
        if (first) centreSvg();
      }
    }
    const nextList = JSON.stringify([m.places, m.trips]);
    if (nextList === listSig) return;
    listSig = nextList;
    const pt = placeTable(m.places || []);
    setSlot(root, 'lm-place-head', pt.head);
    setSlot(root, 'lm-place-rows', pt.rows);
    const trips = [...planned.sort((a, b) => b.startAt - a.startAt), ...past.sort((a, b) => b.startAt - a.startAt)];
    setSlot(root, 'lm-trip-rows', trips.length
      ? trips.map((t, i) => t.planned
        ? html`<tr class="lm-planned"><td class="mono">${fmtHm(t.startAt)} <span class="mute">planned</span></td><td>${name(t.from)} → ${name(t.to)}</td><td>${t.mode || '—'}</td><td class="mono"><span class="mute">planned ${fmtHm(t.endAt)}</span></td></tr>`
        : html`<tr><td class="mono">${fmtHm(t.startAt)} <span class="mute">${fmtRelative(t.startAt)} ago</span></td><td>${name(t.from)} → ${name(t.to)}</td><td>${t.mode || '—'}</td><td class="mono">${arrivedCell(t, i === planned.length && !!m.position?.travelling)}</td></tr>`)
      : html`<tr><td colspan="4" class="empty">NO TRIPS IN 48 H</td></tr>`);
  }

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life map poll', err); }); }, POLL_MS);
}
