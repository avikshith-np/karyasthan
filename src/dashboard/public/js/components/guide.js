// Page guides: a GUIDE button in the topbar opens plain-language docs for the
// page you are on — what each panel and control does and how it changes him.
//
//   setGuideRoute(route)   main.js calls it on every navigation; the button is
//                          hidden on pages without a guide
//   openGuide(hash, id?)   open a page's guide, optionally scrolled to a section
//   [data-guide="<id>"]    any element inside #content opens the current page's
//                          guide at that section (the "?" buttons on panel heads)
//   ?                      keyboard shortcut (outside inputs)
//
// Guide content lives in js/guides/<page>.js as plain data (strings only, no
// markup) and is rendered through html``, so nothing in a guide is ever raw HTML.
// Shape:
//   { title, intro: [para…], sections: [{ id, title, where?, text?: [para…],
//     items?: [[term, desc]…], tips?: [string…], examples?: [string…] }] }
import { html, render, el, $, $$ } from '../core/dom.js';
import { GUIDES } from '../guides/index.js';

let currentHash = null;
let openBox = null;

const btn = () => document.getElementById('guideBtn');

/** Track the route for the topbar button; closes an open guide on navigation. */
export function setGuideRoute(route) {
  currentHash = route?.hash ?? null;
  const b = btn();
  if (b) b.hidden = !(currentHash && GUIDES[currentHash]);
  closeGuide();
}

export function hasGuide(hash = currentHash) {
  return !!(hash && GUIDES[hash]);
}

function closeGuide() {
  if (!openBox) return;
  openBox.cleanup();
  openBox = null;
}

const paras = (list) => (Array.isArray(list) ? list : []).map((p) => html`<p>${p}</p>`);

function sectionView(s) {
  const items = Array.isArray(s.items) ? s.items : [];
  const tips = Array.isArray(s.tips) ? s.tips : [];
  const examples = Array.isArray(s.examples) ? s.examples : [];
  return html`<section class="guide-section" id="guide-${s.id}" data-guide-section="${s.id}">
    <h3>${s.title}${s.where ? html` <span class="guide-where">${s.where}</span>` : ''}</h3>
    ${paras(s.text)}
    ${items.length ? html`<dl class="guide-items">${items.map(([term, desc]) => html`<dt>${term}</dt><dd>${desc}</dd>`)}</dl>` : ''}
    ${examples.length ? html`<div class="guide-examples"><div class="guide-label">EXAMPLES</div><ul>${examples.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    ${tips.length ? tips.map((t) => html`<div class="guide-tip">${t}</div>`) : ''}
  </section>`;
}

function guideView(g) {
  const sections = Array.isArray(g.sections) ? g.sections : [];
  return html`<div class="story-modal-card guide-card" tabindex="-1">
    <div class="panel-head"><span>GUIDE · ${g.title}</span>
      <span class="guide-head-tools">
        <input type="search" class="guide-filter" placeholder="filter…" aria-label="Filter the guide">
        <button type="button" data-act="close" aria-label="Close the guide">CLOSE</button>
      </span></div>
    <div class="guide-body">
      <nav class="guide-toc" aria-label="Guide sections">${sections.map((s) => html`<a href="#" data-goto="${s.id}">${s.title}</a>`)}</nav>
      <div class="guide-main">
        ${g.intro?.length ? html`<div class="guide-intro">${paras(g.intro)}</div>` : ''}
        ${sections.map(sectionView)}
        <div class="guide-empty" hidden>NOTHING MATCHES</div>
      </div>
    </div>
  </div>`;
}

function scrollToSection(box, id) {
  const target = id ? box.querySelector(`[data-guide-section="${CSS.escape(String(id))}"]`) : null;
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  target.classList.add('is-hit');
  setTimeout(() => target.classList.remove('is-hit'), 1600);
}

function applyFilter(box, q) {
  const needle = q.trim().toLowerCase();
  let shown = 0;
  for (const s of $$(box, '[data-guide-section]')) {
    const hit = !needle || s.textContent.toLowerCase().includes(needle);
    s.hidden = !hit;
    if (hit) shown++;
  }
  for (const a of $$(box, '[data-goto]')) {
    const s = box.querySelector(`[data-guide-section="${CSS.escape(a.dataset.goto)}"]`);
    a.hidden = !!s?.hidden;
  }
  const empty = $(box, '.guide-empty');
  if (empty) empty.hidden = shown > 0;
}

/** Open the guide of `hash` (default: the current page), scrolled to section `id`. */
export async function openGuide(hash = currentHash, id = null) {
  const load = hash ? GUIDES[hash] : null;
  if (!load) return;
  closeGuide();
  const box = el('div', { class: 'story-modal guide-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Page guide' });
  document.body.appendChild(box);
  render(box, html`<div class="story-modal-card"><div class="loading">LOADING GUIDE</div></div>`);
  const onKey = (e) => { if (e.key === 'Escape') closeGuide(); };
  const onClick = (e) => {
    const goto = e.target.closest?.('[data-goto]');
    if (goto) { e.preventDefault(); scrollToSection(box, goto.dataset.goto); return; }
    if (e.target === box || e.target.closest?.('[data-act="close"]')) closeGuide();
  };
  const onInput = (e) => { if (e.target.classList?.contains('guide-filter')) applyFilter(box, e.target.value); };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', onClick);
  box.addEventListener('input', onInput);
  const me = {
    cleanup() {
      document.removeEventListener('keydown', onKey);
      box.remove();
    },
  };
  openBox = me;
  let g;
  try {
    g = (await load()).default;
  } catch (err) {
    if (openBox !== me) return;
    render(box, html`<div class="story-modal-card"><div class="panel-body"><b class="red">GUIDE FAILED TO LOAD</b><p class="mono">${err?.message || String(err)}</p>
      <div class="story-modal-foot"><button type="button" data-act="close">CLOSE</button></div></div></div>`);
    return;
  }
  if (openBox !== me) return;
  render(box, guideView(g));
  $(box, '.guide-card')?.focus?.();
  scrollToSection(box, id);
}

/** Wire the topbar button, the "?" shortcut and [data-guide] buttons (once, at boot). */
export function startGuides() {
  btn()?.addEventListener('click', () => openGuide());
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-guide]');
    if (!t || !document.getElementById('content')?.contains(t)) return;
    e.preventDefault();
    openGuide(currentHash, t.dataset.guide);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || openBox) return;
    if (document.documentElement.classList.contains('drawer-open')) return; // the page is behind the panel
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
    if (!hasGuide()) return;
    e.preventDefault();
    openGuide();
  });
}
