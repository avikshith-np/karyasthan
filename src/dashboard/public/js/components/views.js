// The shared view pieces (plan 020 I2). Each returns html`` (every value escaped), so a page
// composes them with its own data and owns the fetching. Shown with example data on #kit.
// Nothing touches the DOM at import time, so this also loads in node (tests).
import { html } from '../core/dom.js';

/** One stat tile, for inside .kpi-grid. */
export const kpi = ({ label, id = null, value, sub = null, alert = false }) => html`
  <div class="kpi${alert ? ' alert' : ''}">
    <div class="lab"><span>${label}</span>${id ? html`<span class="id">${id}</span>` : ''}</div>
    <div class="val">${value}</div>
    ${sub ? html`<div class="sub">${sub}</div>` : ''}
  </div>`;

/** A panel that folds. Remembered per `id` once the page calls initFolds. */
export const fold = ({ id, title, meta = null, open = false, body }) => html`
  <details class="fold panel" data-fold="${id}"${open ? html` open` : ''}>
    <summary class="panel-head"><span>${title}</span><span class="fold-meta">${meta ? html`<span>${meta}</span>` : ''}<span class="fold-mark" aria-hidden="true"></span></span></summary>
    <div class="fold-body">${body}</div>
  </details>`;

const FOLD_PREFIX = 'ld.fold.';
/**
 * Restore and remember which folds are open. `data-wide-open` means open on desktop and closed
 * on a phone until you open it. Storage failing just means they don't persist.
 */
export function initFolds(root) {
  const wide = !globalThis.matchMedia?.('(max-width: 900px)').matches;
  for (const d of root.querySelectorAll('details[data-fold]')) {
    if (d.hasAttribute('data-wide-open')) d.open = wide;
    try {
      const saved = localStorage.getItem(FOLD_PREFIX + d.dataset.fold);
      if (saved !== null) d.open = saved === '1';
    } catch { /* private mode */ }
    if (d.dataset.foldWired) continue;
    d.dataset.foldWired = '1';
    d.addEventListener('toggle', () => {
      try { localStorage.setItem(FOLD_PREFIX + d.dataset.fold, d.open ? '1' : '0'); } catch { /* private mode */ }
    });
  }
}

/** Sections inside a page, one shown at a time: a strip of buttons, wired by the page (data-seg). */
export const segments = (items, active, { label = 'Sections' } = {}) => html`
  <div class="seg" role="group" aria-label="${label}">${items.map(([key, title, count]) => html`
    <button type="button" class="seg-item${key === active ? ' is-on' : ''}" data-seg="${key}" aria-pressed="${key === active ? 'true' : 'false'}">${title}${count ? html`<span class="nav-badge">${count}</span>` : ''}</button>`)}
  </div>`;

/** A label and its control; stacks on a phone. */
export const formRow = ({ label, hint = null, control }) => html`
  <label class="form-row"><span class="form-label">${label}</span><span class="form-control">${control}${hint ? html`<span class="form-hint">${hint}</span>` : ''}</span></label>`;

const SEVERITY = { high: 'HIGH', warn: 'WARN', info: 'INFO' };
/** One alert: severity in form as well as colour. With `href` it's a link. */
export function alertRow({ severity = 'info', title, detail = null, at = null, href = null, action = null }) {
  const sev = SEVERITY[severity] ? severity : 'info';
  const inner = html`
    <span class="v-alert-sev">${SEVERITY[sev]}</span>
    <span class="v-alert-main"><span class="v-alert-title">${title}</span>${detail ? html`<span class="v-alert-detail">${detail}</span>` : ''}</span>
    ${at ? html`<span class="v-alert-at mono">${at}</span>` : ''}
    ${action ? html`<span class="v-alert-act">${action}</span>` : ''}`;
  return href
    ? html`<a class="v-alert" data-sev="${sev}" href="${href}">${inner}</a>`
    : html`<div class="v-alert" data-sev="${sev}">${inner}</div>`;
}
export const alertList = (rows, { empty = 'NOTHING TO LOOK AT' } = {}) => (rows?.length
  ? html`<div class="v-alerts">${rows.map(alertRow)}</div>`
  : html`<div class="empty">${empty}</div>`);

/** The line of what's happening right now. `parts` are short strings; empty ones drop out. */
export const liveLine = ({ at, parts = [], live = true }) => html`
  <div class="v-live${live ? ' is-live' : ''}"><span class="v-live-at mono">${live ? html`<span class="dot-live" aria-hidden="true"></span>` : ''}${at}</span><span class="v-live-text">${parts.filter(Boolean).map((p, i) => html`${i ? html`<span class="v-live-sep" aria-hidden="true"> · </span>` : ''}<span>${p}</span>`)}</span></div>`;

/** One moment in a stream: a thought, his body, a feeling. `kind` sets the mark and the tone. */
export const streamRow = ({ at, kind = 'thought', text, note = null }) => html`
  <div class="v-stream-row" data-kind="${kind}"><span class="v-stream-at mono">${at}</span><span class="v-stream-text"><span class="v-sr">${kind}: </span>${text}${note ? html`<span class="v-stream-note">${note}</span>` : ''}</span></div>`;
export const stream = (rows, { empty = 'NOTHING YET' } = {}) => (rows?.length
  ? html`<div class="v-stream">${rows.map(streamRow)}</div>`
  : html`<div class="empty">${empty}</div>`);

/** Two sides of one moment: thought vs deed, what he told himself vs what drove it. */
export const twoCol = ({ title = null, at = null, leftLabel, left, rightLabel, right, differs = false, note = null }) => html`
  <article class="v-two${differs ? ' is-differs' : ''}">
    ${title || at ? html`<header class="v-two-head"><span>${title}</span>${at ? html`<span class="mono">${at}</span>` : ''}</header>` : ''}
    <div class="v-two-cols">
      <div class="v-two-col"><div class="v-two-label">${leftLabel}</div><div class="v-two-text">${left}</div></div>
      <div class="v-two-col"><div class="v-two-label">${rightLabel}</div><div class="v-two-text">${right}</div></div>
    </div>
    ${note ? html`<div class="v-two-note mono mute">${note}</div>` : ''}
  </article>`;

/** A real thought (plan 020 F3): what he told himself vs what actually drove it. `at` is formatted by the page. */
export const toldRow = ({ at, title = null, told, drove, differs = false, fromChat = false }) => twoCol({
  title: html`${title ?? 'A thought'}${fromChat ? ' · ◇ CHAT' : ''}`, at, differs,
  leftLabel: 'WHAT HE TOLD HIMSELF', left: told, rightLabel: 'WHAT ACTUALLY DROVE IT', right: drove,
});

/** Several, newest first: the newest whole, the rest folded on a phone so the stream under them stays in reach. */
export const toldRows = (rows) => (rows?.length
  ? html`${toldRow(rows[0])}${rows.length > 1 ? html`<details class="subfold m-older v-told-more" data-fold="thoughts.real.earlier" data-wide-open><summary class="mono">EARLIER · ${rows.length - 1}</summary><div class="m-older-body">${rows.slice(1).map(toldRow)}</div></details>` : ''}`
  : html``);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const TREND = { up: ['↑', 'rising'], down: ['↓', 'falling'], flat: ['→', 'steady'] };
/**
 * An interest (0..1) or an opinion (-1..1). The bar starts at 0 for an interest and at the
 * centre for an opinion, so "against" reads as a different thing from "little".
 * `whyId` adds a WHY button (data-why) for the page to open its evidence in a sheet.
 */
export function stanceRow({ topic, kind = 'interest', value = 0, trend = 'flat', confidence = null, pinned = false, whyId = null }) {
  const opinion = kind === 'opinion';
  const v = opinion ? clamp(value, -1, 1) : clamp(value, 0, 1);
  const left = opinion ? (v < 0 ? 50 + v * 50 : 50) : 0;
  const width = opinion ? Math.abs(v) * 50 : v * 100;
  const [arrow, word] = TREND[trend] || TREND.flat;
  return html`
    <div class="v-stance" data-kind="${opinion ? 'opinion' : 'interest'}">
      <div class="v-stance-topic">${topic}${pinned ? html` <span class="chip warn">PINNED</span>` : ''}</div>
      <div class="v-stance-bar" role="img" aria-label="${opinion ? 'Opinion' : 'Interest'} ${v.toFixed(2)}, ${word}"><i style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i></div>
      <div class="v-stance-num mono"><span>${v.toFixed(2)}</span><span class="v-stance-trend" data-trend="${TREND[trend] ? trend : 'flat'}" title="${word}">${arrow}</span><span class="mute">${opinion ? 'OPINION' : 'INTEREST'}</span>${confidence != null ? html`<span class="mute">SURE ${Math.round(clamp(confidence, 0, 1) * 100)}%</span>` : ''}</div>
      ${whyId != null ? html`<button type="button" class="v-stance-why" data-why="${whyId}">WHY</button>` : ''}
    </div>`;
}

// A long dream shows its opening; the rest is a tap away, so one vivid night doesn't bury the others.
const DREAM_FULL = 480;
const DREAM_OPENING = 360;
/** Where to cut: the last sentence end before the limit, else the last space, else the limit. */
function dreamCut(text) {
  const s = String(text ?? '');
  if (s.length <= DREAM_FULL) return s.length;
  const head = s.slice(0, DREAM_OPENING);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= DREAM_OPENING / 2) return sentence + 1;
  const space = head.lastIndexOf(' ');
  return space >= DREAM_OPENING / 2 ? space : DREAM_OPENING;
}
const dreamWords = (text) => {
  const s = String(text);
  const cut = dreamCut(s);
  return cut >= s.length
    ? html`<p class="v-dream-text">${s}</p>`
    : html`<p class="v-dream-text">${s.slice(0, cut)}</p><details class="subfold v-dream-more"><summary class="mono">READ THE REST</summary><p class="v-dream-text">${s.slice(cut).trim()}</p></details>`;
};

const DREAM_TONE = { good: 'GOOD', flat: 'ODD', bad: 'BAD', nightmare: 'NIGHTMARE' };
/** A remembered dream: the words if it was vivid, its scenes as fragments otherwise. */
export const dreamCard = ({ night, tone = 'flat', vivid = false, text = null, scenes = [] }) => html`
  <article class="v-dream" data-tone="${DREAM_TONE[tone] ? tone : 'flat'}">
    <header class="v-dream-head"><span class="mono">${night}</span><span class="chip">${DREAM_TONE[tone] || DREAM_TONE.flat}</span>${vivid ? html`<span class="chip">VIVID</span>` : html`<span class="chip">FRAGMENT</span>`}</header>
    ${text ? dreamWords(text) : ''}
    ${scenes.length ? html`<ul class="v-dream-scenes">${scenes.map((s) => html`<li><b>${s.place}</b>${s.person ? html` · ${s.person}` : ''}${s.twist ? html`<span class="mute"> · ${s.twist}</span>` : ''}</li>`)}</ul>` : ''}
  </article>`;
