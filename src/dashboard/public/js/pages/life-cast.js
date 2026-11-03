// LIFE · PEOPLE (spec 010 T022, director-api §7; the nav calls his cast People) — one card per
// person (initials avatar, relation, age, closeness / trust / tension, status, away, romance
// stage; the whole card opens them) and the relationship web (inline SVG: him in the middle,
// the cast around him; line width = closeness, colour = tension), folded away on a phone. Polls
// /api/arcs/cast + /api/arcs/web every 30 s, repainting only what changed. Read-only page.
//
// Also the shared helpers of the story pages (avatar, metric bars, sparkline,
// line chart, countdown, the "arcs is off" note). Every string from the world,
// the seed, a model or a chat reaches the DOM only through html`` (escaped).
import { api, isAbort } from '../core/api.js';
import { $, html, render, setSlot, setSlots } from '../core/dom.js';
import { fmtDuration, fmtTime } from '../core/fmt.js';
import { showError } from '../components/ui.js';
import { fold, initFolds } from '../components/views.js';
import { offNote } from './life-now.js';

const POLL_MS = 30_000;

// ── shared helpers (imported by the other story pages) ─────────────────────

export const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export const pct = (v) => (finite(v) ? Math.max(0, Math.min(100, Math.round(v * 100))) : 0);
export const fx = (v, d = 2) => (finite(v) ? v.toFixed(d) : '—');
export const upper = (v) => String(v ?? '—').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase().replace(/_/g, ' ');
export const castHref = (id) => `#life/cast/${encodeURIComponent(String(id || ''))}`;

/** GET /api/arcs/status (never throws: an unreachable API reads as off). */
export async function arcsStatus(ctx) {
  try {
    return await api('/api/arcs/status', { signal: ctx.signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    return { enabled: false, running: false, skill: false, counts: {} };
  }
}

/** Shown on every story page while the story layer is not on. */
export function arcsOffNote(st) {
  if (!st || st.enabled) return null;
  if (!st.running) return offNote(st.lifeSkill);
  const why = !st.skill
    ? 'Switch the "arcs" skill on in the Skills tab (it needs the "life" skill on; ARCS_ENABLED is only its boot default). Until then his day runs exactly as before: no cast lives, no arcs, no reconciler, no journal.'
    : !st.facade
      ? 'The arcs skill is on, but the story engine is not loaded in this process (check the logs for an arcs issue).'
      : 'The arcs skill is on, but the story layer has not attached to the life engine yet (it attaches at the next life boot).';
  return html`<div class="panel life-off story-off"><div class="panel-body"><b class="amber">ARCS IS OFF</b><p class="mute">${why}</p></div></div>`;
}

/** The AWAY chip's text: the away beat's own label (only some beats carry one), then the return time. */
export function awayText(away, fmt = null) {
  if (!away || typeof away !== 'object') return String(away || '');
  const parts = [away.label || (away.heavy ? 'a heavy stretch' : '')];
  if (away.until && fmt) parts.push(`until ${fmt(away.until)}`);
  return parts.filter(Boolean).join(' · ');
}

/** Initials avatar (no images). */
export function avatar(initials, { kind = '', title = '' } = {}) {
  const txt = String(initials || '?').slice(0, 3).toUpperCase();
  return html`<span class="story-avatar ${kind ? `story-avatar-${kind}` : ''}" title="${title}" aria-hidden="true">${txt}</span>`;
}

/** closeness / trust / tension as three thin bars. */
export function metricBars(m) {
  const row = (label, v, cls) => html`<div class="story-metric"><span class="story-metric-lab">${label}</span><span class="story-metric-track"><span class="story-metric-f ${cls}" style="width:${pct(v)}%"></span></span><span class="story-metric-num">${fx(v)}</span></div>`;
  if (!m) return html`<span class="mute">—</span>`;
  return html`<div class="story-metrics">${row('CLOSE', m.closeness, 'is-close')}${row('TRUST', m.trust, 'is-trust')}${row('TENSION', m.tension, 'is-tension')}</div>`;
}

/** closeness / trust / tension side by side, for a card. */
export function metricsMini(m) {
  if (!m) return null;
  const cell = (label, v, cls) => html`<span class="lc-metric"><span class="lc-metric-top"><span class="story-metric-lab">${label}</span><span class="story-metric-num">${fx(v)}</span></span><span class="story-metric-track"><span class="story-metric-f ${cls}" style="width:${pct(v)}%"></span></span></span>`;
  return html`<span class="lc-metrics">${cell('CLOSE', m.closeness, 'is-close')}${cell('TRUST', m.trust, 'is-trust')}${cell('TENSION', m.tension, 'is-tension')}</span>`;
}

// A name in the web has room for about this much before it runs into the next one or the edge.
const WEB_LABEL_MAX = 22;
export const webLabel = (s) => (s.length > WEB_LABEL_MAX ? `${s.slice(0, WEB_LABEL_MAX - 1).trimEnd()}…` : s);

/** A 0..1 sparkline (inline SVG); `values` oldest first. */
export function sparkline(values, { w = 120, h = 28, label = '' } = {}) {
  const v = (values || []).filter(finite);
  if (!v.length) return html`<span class="mute mono">no lean yet</span>`;
  const step = v.length > 1 ? w / (v.length - 1) : 0;
  const pts = v.map((p, i) => `${(i * step).toFixed(1)},${(h - 2 - Math.max(0, Math.min(1, p)) * (h - 4)).toFixed(1)}`).join(' ');
  const last = v[v.length - 1];
  return html`<svg class="story-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label || `lean history, ${v.length} points, last ${fx(last)}`}">
    <line class="story-spark-mid" x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}"></line>
    <polyline class="story-spark-line" points="${pts}"></polyline>
    <circle class="story-spark-dot" cx="${((v.length - 1) * step).toFixed(1)}" cy="${(h - 2 - Math.max(0, Math.min(1, last)) * (h - 4)).toFixed(1)}" r="2.5"></circle>
  </svg>`;
}

/** Metrics over time: one polyline per key, `series` = [{at, closeness, trust, tension}] oldest first. */
export function lineChart(series, keys = ['closeness', 'trust', 'tension'], { w = 600, h = 140 } = {}) {
  const pts = (series || []).filter((p) => finite(p?.at)).sort((a, b) => a.at - b.at);
  if (pts.length < 2) return html`<div class="empty">NOT ENOUGH HISTORY YET</div>`;
  const t0 = pts[0].at;
  const span = Math.max(1, pts[pts.length - 1].at - t0);
  const x = (at) => (((at - t0) / span) * (w - 8) + 4).toFixed(1);
  const y = (v) => (h - 6 - Math.max(0, Math.min(1, v)) * (h - 12)).toFixed(1);
  const line = (k) => pts.filter((p) => finite(p[k])).map((p) => `${x(p.at)},${y(p[k])}`).join(' ');
  return html`<svg class="story-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="metrics over time, ${pts.length} points">
    ${[0, 0.5, 1].map((g) => html`<line class="story-chart-grid" x1="0" x2="${w}" y1="${y(g)}" y2="${y(g)}"></line>`)}
    ${keys.map((k) => html`<polyline class="story-chart-line story-chart-${k}" points="${line(k)}"></polyline>`)}
  </svg>
  <div class="life-legend mono">${keys.map((k) => html`<span class="life-swatch story-sw-${k}"></span>${upper(k)} `)}</div>`;
}

/** "2 h 05 m" until `at` (unix s) at the life clock offset; "PASSED" after. */
export function countdownText(at, offsetSec = 0) {
  if (!finite(at)) return '—';
  const left = Math.round(at - (Date.now() / 1000 + offsetSec));
  if (left <= 0) return 'PASSED';
  if (left < 60) return `${left} s`;
  return fmtDuration(left);
}

/** Refresh every [data-countdown] in `root` (textContent only). */
export function tickCountdowns(root, offsetSec = 0) {
  if (!root) return;
  for (const n of root.querySelectorAll('[data-countdown]')) {
    const t = countdownText(Number(n.dataset.countdown), offsetSec);
    if (n.textContent !== t) n.textContent = t;
    n.classList.toggle('is-passed', t === 'PASSED');
  }
}

// ── the relationship web ───────────────────────────────────────────────────

const WEB_W = 640;
const WEB_H = 420;

// The web's circles, in ring order; each gets one arc of the ring and a label.
const WEB_GROUPS = [['home', 'HOME'], ['work', 'WORK'], ['family', 'FAMILY'], ['friends', 'FRIENDS & OTHERS']];

export function webSvg(web) {
  const nodes = Array.isArray(web?.nodes) ? web.nodes : [];
  const edges = Array.isArray(web?.edges) ? web.edges : [];
  if (!nodes.length) return html`<div class="empty">NO CAST YET</div>`;
  const cx = WEB_W / 2;
  const cy = WEB_H / 2;
  const groupOf = (n) => (WEB_GROUPS.some(([g]) => g === n.group) ? n.group : 'friends');
  // Ring order: by circle, then by name, so a circle's people sit together on one arc.
  const others = nodes.filter((n) => n.id !== 'self')
    .sort((a, b) => WEB_GROUPS.findIndex(([g]) => g === groupOf(a)) - WEB_GROUPS.findIndex(([g]) => g === groupOf(b))
      || String(a.label || '').localeCompare(String(b.label || '')));
  const pos = new Map([['self', { x: cx, y: cy }]]);
  const rx = WEB_W / 2 - 70;
  const ry = WEB_H / 2 - 60;
  const angle = (i) => (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
  others.forEach((n, i) => pos.set(n.id, { x: cx + Math.cos(angle(i)) * rx, y: cy + Math.sin(angle(i)) * ry }));
  const met = new Map(others.map((n) => [n.id, n.met !== false]));
  // Circle labels, outside the ring at the middle of each circle's arc.
  const labels = WEB_GROUPS.map(([g, label]) => {
    const idx = others.map((n, i) => (groupOf(n) === g ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return null;
    const a = (angle(idx[0]) + angle(idx[idx.length - 1])) / 2;
    return html`<text class="story-web-group" text-anchor="middle" x="${(cx + Math.cos(a) * (rx + 46)).toFixed(1)}" y="${(cy + Math.sin(a) * (ry + 40)).toFixed(1)}">${label}</text>`;
  });
  // Lines to him (width = closeness, colour = tension or the tie) and "met via" lines. Who
  // belongs together (coworkers, family) is shown by the circles, not by lines between them.
  const edge = (e) => {
    if (e.kind === 'coworkers' || e.kind === 'family') return null;
    const p = pos.get(e.a);
    const q = pos.get(e.b);
    if (!p || !q) return null;
    const notMet = e.a === 'self' && (e.met === false || met.get(e.b) === false);
    const wdt = notMet ? '1' : finite(e.closeness) ? (1 + e.closeness * 4).toFixed(1) : '1.5';
    const tense = notMet ? '' : finite(e.tension) && e.tension >= 0.5 ? 'is-tense' : finite(e.tension) && e.tension >= 0.25 ? 'is-strained' : '';
    const title = notMet ? 'not met yet' : `${e.kind === 'metVia' ? 'met via' : e.kind || ''} ${finite(e.closeness) ? `closeness ${fx(e.closeness)}` : ''} ${finite(e.tension) ? `tension ${fx(e.tension)}` : ''}`;
    return html`<line class="story-web-edge story-web-${e.kind || 'other'} ${tense} ${notMet ? 'is-not-met' : ''}" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke-width="${wdt}"><title>${title}</title></line>`;
  };
  const node = (n) => {
    const p = pos.get(n.id);
    if (!p) return null;
    const self = n.id === 'self';
    const notMet = !self && n.met === false;
    const full = `${n.label || ''}${notMet ? ' · not met yet' : ''}`;
    const body = html`${self ? '' : html`<circle r="30" class="story-web-hit"></circle>`}<circle r="${self ? 24 : 18}" class="story-web-dot ${self ? 'is-self' : ''} ${notMet ? 'is-not-met' : ''}"></circle>
      <text class="story-web-ini" text-anchor="middle" dy="4">${String(n.initials || '?').slice(0, 3).toUpperCase()}</text>
      <text class="story-web-lab" text-anchor="middle" dy="${self ? 40 : 33}"><title>${full}</title>${webLabel(full)}</text>`;
    return self
      ? html`<g class="story-web-node" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">${body}</g>`
      : html`<a href="${castHref(n.id)}" class="story-web-node" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" aria-label="${n.label || n.id}">${body}</a>`;
  };
  return html`<svg class="story-web" viewBox="0 0 ${WEB_W} ${WEB_H}" role="img" aria-label="relationship web, ${others.length} people">
    ${labels}${edges.map(edge)}${nodes.map(node)}
  </svg>
  <div class="life-legend mono">LINE TO HIM: WIDTH = CLOSENESS · <span class="life-swatch story-sw-flatmate"></span>FLATMATE · <span class="life-swatch story-sw-strained"></span>STRAINED ≥ 0.25 · <span class="life-swatch story-sw-tense"></span>TENSE ≥ 0.5 · DOTTED = NOT MET YET · DASHED (BETWEEN TWO PEOPLE) = MET VIA · PEOPLE ARE GROUPED BY CIRCLE</div>`;
}

// ── page ───────────────────────────────────────────────────────────────────

const shell = (wide) => html`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · PEOPLE · THE PEOPLE IN HIS LIFE</div>
    <h1>People</h1>
  </div>
  <div class="meta">
    <span>CAST <b data-slot="lc-count">—</b></span>
    <span>AWAY <b data-slot="lc-away">—</b></span>
    <span>PINNED <b data-slot="lc-pinned">—</b></span>
  </div>
</div>
<div data-slot="lc-off"></div>
<div class="lc-grid">
  <div class="panel lc-who">
    <div class="panel-head"><span>WHO<button type="button" class="guide-q" data-guide="who" aria-label="Guide: who">?</button></span><span class="mono mute">TAP FOR THEIR PAGE</span></div>
    <div class="lc-cards" data-slot="lc-rows"><div class="loading">LOADING</div></div>
  </div>
  ${fold({
    id: 'people.web',
    open: wide,
    title: html`RELATIONSHIP WEB<button type="button" class="guide-q" data-guide="web" aria-label="Guide: web">?</button>`,
    meta: 'CAST ONLY · NO REAL PEOPLE',
    body: html`<div class="panel-body story-web-wrap" data-slot="lc-web"><div class="loading">LOADING</div></div>`,
  })}
</div>`;

function romanceCell(r) {
  if (!r) return null;
  return html`<div class="mono story-romance">${upper(r.stage)} · I ${fx(r.intimacy)} · P ${fx(r.passion)} · C ${fx(r.commitment)}${finite(r.togetherH) ? ` · ${Math.round(r.togetherH)} h together` : ''}</div>`;
}

/** One person: the whole card opens their page. */
export function personCard(c) {
  return html`<a class="lc-card${c.away ? ' is-away' : ''}" href="${castHref(c.id)}">
    ${avatar(c.initials, { kind: String(c.relation || '').split(':')[0], title: c.relation || '' })}
    <span class="lc-main">
      <span class="lc-name">${c.name || c.id}${c.pinned ? html` <span class="chip warn">PINNED</span>` : ''}${c.away ? html` <span class="chip">AWAY</span>` : ''}</span>
      <span class="lc-sub mono">${c.label || c.relation || '—'}${finite(c.age) ? ` · age ${c.age}` : ''}</span>
    </span>
    ${metricsMini(c.metrics)}
    ${c.status || c.away ? html`<span class="lc-status">${c.status || ''}${c.away ? html`<span class="mono mute lc-away">${awayText(c.away, fmtTime)}</span>` : ''}</span>` : ''}
    ${romanceCell(c.romance)}
  </a>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, shell(!globalThis.matchMedia?.('(max-width: 900px)').matches));
  initFolds(root);
  let webSig = '';
  let rowsSig = '';

  // On a phone the web is wider than the screen: start with him in the middle.
  const centreWeb = () => {
    const box = $(root, '.story-web-wrap');
    if (box && box.scrollWidth > box.clientWidth) box.scrollLeft = (box.scrollWidth - box.clientWidth) / 2;
  };
  ctx.listen($(root, '[data-fold="people.web"]'), 'toggle', centreWeb);

  async function load() {
    const st = await arcsStatus(ctx);
    if (!ctx.alive()) return;
    setSlot(root, 'lc-off', arcsOffNote(st));
    const [cast, web] = await Promise.all([
      api('/api/arcs/cast', { signal: ctx.signal }),
      api('/api/arcs/web', { signal: ctx.signal }),
    ]);
    if (!ctx.alive()) return;
    const list = Array.isArray(cast?.cast) ? cast.cast : [];
    setSlots(root, {
      'lc-count': list.length,
      'lc-away': list.filter((c) => c.away).length,
      'lc-pinned': list.filter((c) => c.pinned).length,
    });
    // Only what changed, so a poll leaves the web's scroll and a pressed card alone.
    const nextWeb = JSON.stringify(web);
    if (nextWeb !== webSig) { webSig = nextWeb; setSlot(root, 'lc-web', webSvg(web)); centreWeb(); }
    const nextRows = JSON.stringify([list, cast?.enabled]);
    if (nextRows !== rowsSig) {
      rowsSig = nextRows;
      setSlot(root, 'lc-rows', list.length ? list.map(personCard) : html`<div class="empty">${cast?.enabled ? 'NO CAST YET' : 'ARCS IS OFF'}</div>`);
    }
  }

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life cast poll', err); }); }, POLL_MS);
}
