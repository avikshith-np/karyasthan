// Navigation, all from the route registry (spec 007 FR-043, plan 020 I1): the sidebar (a
// slide-out panel on a phone, components/drawer.js) and the tab strip above a page.
import { html, render } from '../core/dom.js';
import { navSections, ROUTES, tabsOf } from '../routes.js';

// Counts of what's waiting, by route: { life: 1, 'life/story': 3, 'life/pending': 2 }. The menu
// button shows the total of the sidebar's links (a tab's count is already in its link's).
let badges = {};
const badgeText = (n) => (n > 99 ? '99+' : String(n));
const badge = (key) => html`<span class="nav-badge" data-badge="${key}" hidden></span>`;
const onSidebar = (key) => ROUTES.some((r) => r.hash === key && r.nav);

function paintBadges(rootEl = document) {
  for (const el of rootEl.querySelectorAll('[data-badge]')) {
    const n = el.dataset.badge === 'menu'
      ? Object.entries(badges).filter(([k]) => onSidebar(k)).reduce((sum, [, v]) => sum + v, 0)
      : badges[el.dataset.badge] || 0;
    el.hidden = !n;
    el.textContent = n ? badgeText(n) : '';
    if (n) el.setAttribute('aria-label', `${n} waiting`); else el.removeAttribute('aria-label');
  }
}

/** Merge counts in; a count that isn't a positive number clears that badge. */
export function setBadges(next) {
  for (const [key, n] of Object.entries(next || {})) {
    if (Number.isFinite(n) && n > 0) badges[key] = n; else delete badges[key];
  }
  paintBadges();
}

export function renderNav(container, routes = ROUTES) {
  render(container, html`${navSections(routes).map((s) => html`
    <div class="nav-section" role="group" aria-label="${s.name}">
      <div class="nav-section-title">${s.name}</div>
      ${s.routes.map((r) => html`<a class="nav-link" data-page="${r.hash}" href="#${r.hash}"><span class="nav-dot" aria-hidden="true"></span>${r.title}${badge(r.hash)}</a>`)}
    </div>`)}
    <div class="nav-section">
      <button type="button" class="nav-link nav-logout" data-act="logout"><span class="nav-dot" aria-hidden="true"></span>Log out</button>
    </div>`);
  paintBadges();
}

export function renderTabs(container, route, routes = ROUTES) {
  const tabs = tabsOf(route, routes);
  container.hidden = !tabs.length;
  if (!tabs.length) { container.replaceChildren(); return; }
  render(container, html`${tabs.map((r) => html`<a class="page-tab${r.hash === route.hash ? ' is-on' : ''}" href="#${r.hash}"${r.hash === route.hash ? html` aria-current="page"` : ''}><span>${r.title}</span>${r.nav ? '' : badge(r.hash)}</a>`)}`);
  paintBadges(container);
  container.querySelector('.is-on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

export function setActiveNav(key) {
  for (const a of document.querySelectorAll('a.nav-link')) {
    const on = a.dataset.page === key;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
