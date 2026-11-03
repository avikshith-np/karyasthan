// Dashboard boot (spec 007 R11, plan 020 I1): session login, topbar, the nav parts from the
// route registry, the hash router with per-page cleanup, the shell notice and logout.
import { api, login, logout, markOffline, onApiHealth } from './core/api.js';
import { html, render } from './core/dom.js';
import { createRouter } from './core/router.js';
import { stream } from './core/stream.js';
import { ROUTES } from './routes.js';
import { initDrawer } from './components/drawer.js';
import { renderNav, renderTabs, setActiveNav, setBadges } from './components/nav.js';
import { closeSheet } from './components/sheet.js';
import { onPhoneChange, syncTables } from './components/tables.js';
import { getStatus, onStatus, refreshTopbar, startTopbar, stopTopbar } from './components/topbar.js';
import { setGuideRoute, startGuides } from './components/guide.js';

const BRAND = 'Karyasthan';
const BADGES_EVERY_MS = 60_000;
const OFFLINE_RETRY_MS = 5000;
const $id = (id) => document.getElementById(id);

// A browser remembers a failed import for the life of the page, so a page whose code couldn't
// load needs a reload once the server is back. At most one every 30 s: the RELOAD button stays
// on the error view if that didn't cure it.
function reloadOnce() {
  try {
    if (Date.now() - Number(sessionStorage.getItem('dash.reloadAt') || 0) < 30_000) return;
    sessionStorage.setItem('dash.reloadAt', String(Date.now()));
  } catch { return; }
  window.location.reload();
}

// A line above the page when the server can't be reached or the session is gone. Polling and
// the stream's own retries bring the app back; the line just says what's going on.
function paintHealth(state) {
  const box = $id('shellNotice');
  if (!box) return;
  box.hidden = state === 'ok';
  box.dataset.state = state;
  if (state === 'offline') render(box, html`<span class="dot-live"></span><span>CONNECTION LOST · RETRYING</span>`);
  else if (state === 'signedOut') render(box, html`<span>SESSION ENDED</span><button type="button" data-act="reload">SIGN IN AGAIN</button>`);
  else box.replaceChildren();
}

// Readonly: every control marked data-write is disabled, however the page re-renders it. The
// server refuses the write anyway; this is so the owner never taps something that can't work.
function syncReadOnly() {
  const ro = getStatus()?.readOnly !== false && !!getStatus();
  const chip = $id('roChip');
  if (chip) chip.hidden = !ro;
  if (!ro) return;
  for (const b of document.querySelectorAll('[data-write]:not(:disabled)')) {
    b.disabled = true;
    b.title = 'Read-only: DASHBOARD_READONLY is on';
  }
}

// What's waiting on the owner: Ask-me cards and the claim tray on Pending, proposals on Story.
let badgesAt = 0;
async function refreshBadges() {
  if (document.hidden || Date.now() - badgesAt < BADGES_EVERY_MS) return;
  badgesAt = Date.now();
  try {
    const c = (await api('/api/arcs/status'))?.counts;
    if (!c) return;
    const pending = (c.cards || 0) + (c.vetoCards || 0) + (c.tray || 0);
    const proposals = c.proposals || 0;
    setBadges({ 'life/story': pending + proposals, 'life/pending': pending });
  } catch { /* the badge just stays as it was */ }
}

function errorView(err) {
  return html`<div class="empty" role="alert" style="color:var(--red-bright)">ERROR · ${err?.message || String(err)}</div>`;
}

async function boot() {
  const nav = $id('nav');
  const content = $id('content');
  const tabs = $id('pageTabs');
  renderNav(nav, ROUTES);
  const drawer = initDrawer({ sidebar: $id('sidebar'), button: $id('menuToggle'), backdrop: $id('drawerBackdrop'), main: document.querySelector('main'), content });

  window.addEventListener('online', () => { refreshTopbar(); });

  startGuides();
  await login();
  // Pages read the persona name / timezone from the first status, so wait for it
  // (one loopback round-trip; a failed status still lets the router start).
  await startTopbar().catch(() => {});
  onStatus(refreshBadges);
  onStatus(syncReadOnly);
  onStatus((st) => setBadges({ life: st?.life?.alerts })); // open alerts, on Now and the menu button
  // After every render, before paint: what the shell keeps true of any page's content.
  const syncContent = () => { syncReadOnly(); syncTables(content); };
  new MutationObserver(syncContent).observe(content, { childList: true, subtree: true });
  // Sheets and the preview window live outside #content, and their write buttons count too.
  new MutationObserver(syncReadOnly).observe(document.body, { childList: true, subtree: true });
  onPhoneChange(syncContent);

  let retryPage = false;
  let offlineTimer = null;
  const router = createRouter({
    routes: ROUTES,
    win: window,
    root: () => content,
    stream,
    onRoute(route) {
      setActiveNav(route.navKey || route.hash);
      renderTabs(tabs, route);
      setGuideRoute(route);
      document.title = `${route.title} · ${BRAND}`;
      closeSheet();
      drawer.closeForNav();
      render(content, html`<div class="loading">LOADING</div>`);
      window.scrollTo(0, 0);
    },
    onUnknown(hash) {
      setActiveNav(null);
      renderTabs(tabs, null);
      closeSheet();
      drawer.closeForNav();
      render(content, html`<div class="empty">NO SUCH PAGE · ${hash}</div>`);
    },
    onError(err) {
      console.error(err);
      render(content, errorView(err));
      // A page's code didn't load: try the page again as soon as the server answers.
      if (err instanceof TypeError && /import|fetch/i.test(err.message)) {
        retryPage = true;
        // The message would be a raw URL: say what it means.
        render(content, html`<div class="empty" role="alert" style="color:var(--red-bright)">THIS PAGE COULDN'T LOAD · IT OPENS ONCE THE CONNECTION IS BACK</div><button type="button" data-act="reload">RELOAD</button>`);
        markOffline();
      }
    },
  });
  onApiHealth((state) => {
    paintHealth(state);
    // A dropped link doesn't always fire 'online' (a VPN, a sleeping phone): keep asking.
    clearInterval(offlineTimer);
    if (state === 'offline') offlineTimer = setInterval(refreshTopbar, OFFLINE_RETRY_MS);
    if (state === 'ok' && retryPage) { retryPage = false; reloadOnce(); }
  });

  async function signOut() {
    closeSheet();
    drawer.closeForNav();
    router.stop();
    renderTabs(tabs, null);
    stopTopbar();
    try { stream().close(); } catch {}
    await logout();
    render(content, html`
      <div class="page-header"><div>
        <div class="crumb">SESSION</div>
        <h1>Signed out</h1>
      </div></div>
      <div class="panel"><div class="panel-body">
        <p class="mute">The session cookie is cleared and the browser's saved login was replaced. Reload to sign in again.</p>
        <button type="button" class="primary" id="signInAgain">Sign in again</button>
      </div></div>`);
    $id('signInAgain')?.addEventListener('click', () => { window.location.hash = '#life'; window.location.reload(); });
  }

  document.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'logout') signOut();
    else if (act === 'reload') window.location.reload();
  });

  router.start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
