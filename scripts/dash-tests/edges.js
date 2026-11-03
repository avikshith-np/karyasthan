// The owner's edge cases for the shell and pages, on real Chromium. Boots preview-server.js
// itself in each mode it needs (scratch DBs). Manual per-slice pass, not part of `npm test`.
//
//   node scripts/dash-tests/edges.js [--only shell,empty,worst] [--out <dir>]
//
// shell: deep links, the sidebar panel (keyboard, scrim, swipe, 320, landscape), with a sheet or
//        modal open, panels across a 30 s poll, the alert badge, a dropped session, no
//        connection, stream reconnect, readonly
// empty: a fresh install (life, arcs off, no rows) on every route: a message, never a hang
// worst: very long names on every route at 320 px: no sideways page scroll
// write: real writes through the phone UI on a scratch DB (cards, sheets, a renewed session)
// phone: Life · Phone reading (opens at the newest, a draft across a poll) and its real writes
// people: Life · People and one person: cards, folds, sheets, and real writes
// wallet: compact log, a poll leaving the month picker alone, a real revert
// map: Leaflet and the grid fallback on a phone, lists, polls
// settings: folded sections, the role picker, finding a setting, real writes
// chats: a group, a contact, Instagram, Skills: folds, compact rows, real writes
// mind: folds, questions in sheets, real writes
// golive: the real-send switch on the Mind page, with the mind skill on
// now: Life · Now with an outing on, thoughts and plot holes; real writes
// director: Director sections (a phone opens on TELL, deep link, memory, typed text through a poll, EDIT reveals its form);
//   Story / Pending / Journal; each question a sheet with a real write on a scratch DB (--write --story)
// inner: stances grouped, the WHY sheet (blank anchor, real writes), dreams, ON HIS MIND at four widths (--inner)
// b3: real thoughts, free topics, commitments, how things stand, claim check, phrases at four widths; races, failures, empties; real approve / reject
// day: Life · Day and Timeline: folds, two columns, a folded map, the chain in a sheet; real writes
// dialogs: every question in a sheet: same request as before, none on Escape, the scrim or KEEP IT; real writes, PURGE, media to a fake socket
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { ROUTES } from '../../src/dashboard/public/js/routes.js';

const argOf = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const ONLY = argOf('only', 'kit,write,phone,people,wallet,map,settings,chats,mind,golive,dialogs,now,day,director,review,inner,b3,shell,empty,worst').split(',');
const OUT = argOf('out', null);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (OUT) fs.mkdirSync(OUT, { recursive: true });

let fails = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` — ${detail}` : ''}`);
}

const serverOut = []; // what the preview server printed: the fake socket's SENT lines
async function withServer(flags, port, fn) {
  serverOut.length = 0;
  const child = spawn('node', ['scripts/dash-tests/preview-server.js', '--port', String(port), '--days', '3', ...flags], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('preview server did not start')), 120_000);
      child.stdout.on('data', (d) => { serverOut.push(String(d)); if (String(d).includes('READY')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`preview server exited ${c}`)));
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
  }
}

const browser = await chromium.launch();
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESK = { viewport: { width: 1440, height: 900 } };
async function open(device, base, hash) {
  const ctx = await browser.newContext({ ...device, httpCredentials: { username: 'admin', password: 'preview' } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page-header, .empty, .panel', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}
const go = async (page, hash) => { await page.evaluate((h) => { window.location.hash = h; }, hash); await page.waitForTimeout(900); };
const lit = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim()).join(','), sel);
const hashes = (api) => ROUTES.map((r) => {
  if (r.hash === 'group') return api.group ? `#group/${encodeURIComponent(api.group)}` : null;
  if (r.hash === 'person') return api.person ? `#person/${encodeURIComponent(api.person)}` : null;
  if (r.hash === 'life/cast/member') return api.cast ? `#life/cast/${encodeURIComponent(api.cast)}` : null;
  return `#${r.hash}`;
}).filter(Boolean);
const firstIds = (page) => page.evaluate(async () => {
  const j = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };
  const first = (x) => (Array.isArray(x) ? x[0] : null);
  const g = await j('/api/groups'); const p = await j('/api/people'); const c = await j('/api/arcs/cast');
  return { group: first(g?.groups ?? g)?.jid ?? null, person: first(p?.people ?? p?.rows ?? p)?.jid ?? null, cast: first(c?.cast ?? c)?.id ?? null };
});

async function shellEdges(base) {
  // ── deep links ──
  {
    const { ctx, page, errors } = await open(PHONE, base, '');
    check('# opens Now', await page.evaluate(() => document.title.startsWith('Now')), await page.title());
    const litNav = () => page.evaluate(() => document.querySelector('a.nav-link.active')?.textContent.replace(/^\d+/, '').trim() || '');
    check('Now is lit in the sidebar', (await litNav()) === 'Now', await litNav());
    await go(page, '#life/director');
    check('deep link behind a tab: Director tab on, Story lit', (await lit(page, '.page-tab.is-on')) === 'Director' && (await litNav()).startsWith('Story'), await lit(page, '.page-tab.is-on'));
    await go(page, '#life/timeline');
    check('Timeline: its tab on, Day lit', (await lit(page, '.page-tab.is-on')) === 'Timeline' && (await litNav()) === 'Day');
    await go(page, '#life/day/2026-10-30');
    check('a dated Day link keeps the Day tab', (await lit(page, '.page-tab.is-on')) === 'Day');
    const { cast } = await firstIds(page);
    await go(page, `#life/cast/${encodeURIComponent(cast)}`);
    check('a cast member lights People, no tab strip', (await litNav()) === 'People' && await page.locator('#pageTabs').isHidden());
    await go(page, '#status');
    check('#status still works, under Control', await page.evaluate(() => document.title.startsWith('Status')) && (await litNav()) === 'Status');
    await go(page, '#no-such-page');
    check('unknown route: a message, nothing lit', (await page.locator('#content').innerText()).includes('NO SUCH PAGE') && !(await litNav()));
    check('no page errors on the way', !errors.length, errors[0] || '');
    await ctx.close();
    const d = await open(DESK, base, '#life/pending');
    check('desktop deep link: Pending tab on, Story lit in the sidebar', (await lit(d.page, '.page-tab.is-on')).startsWith('Pending') && (await lit(d.page, '.nav-link.active')).includes('Story'));
    check('desktop: the sidebar is always there, no menu button', await d.page.locator('#sidebar').isVisible() && await d.page.locator('#menuToggle').isHidden());
    await d.ctx.close();
  }

  // ── the sidebar panel ──
  {
    const { ctx, page, errors } = await open(PHONE, base, '#life');
    const panel = page.locator('#sidebar');
    const menu = page.locator('#menuToggle');
    const isOpen = () => page.evaluate(() => { const r = document.getElementById('sidebar').getBoundingClientRect(); return document.getElementById('sidebar').classList.contains('is-open') && r.left >= 0 && getComputedStyle(document.getElementById('sidebar')).visibility === 'visible'; });
    check('closed: not in the way, Tab can\'t reach it', !(await isOpen()) && await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).visibility === 'hidden') && await menu.isVisible());
    await menu.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(320);
    check('the menu button opens it from the keyboard', await isOpen() && (await menu.getAttribute('aria-expanded')) === 'true');
    const titles = await page.locator('#sidebar a.nav-link').allInnerTexts();
    check('plain words: sidebar links have no numbers, it ends at Log out, the brand is one line', await page.evaluate(() => {
      const links = [...document.querySelectorAll('#nav .nav-link')];
      const side = document.getElementById('sidebar');
      return links.every((l) => !/^\s*\d/.test(l.textContent)) && links.at(-1).textContent.trim() === 'Log out'
        && side.lastElementChild.id === 'nav' && document.querySelector('.brand').innerText.replace(/\s+/g, ' ').trim() === 'K KARYASTHAN';
    }));
    check('it has every sidebar link', ROUTES.filter((r) => r.nav).every((r) => titles.some((t) => t.toUpperCase().includes(r.title.toUpperCase()))) && titles.length === 25, String(titles.length));
    check('sections and Log out are there', (await page.locator('#sidebar .nav-section-title').allInnerTexts()).join(' ').toUpperCase().includes('CHATS') && await page.locator('#sidebar [data-act="logout"]').isVisible());
    const small = await page.evaluate(() => [...document.querySelectorAll('#sidebar .nav-link')].filter((a) => a.getBoundingClientRect().height < 44).length);
    check('links are at least 44 px', small === 0, String(small));
    check('the current page is highlighted', await page.locator('#sidebar a.nav-link.active').count() === 1 && (await page.locator('#sidebar a.nav-link.active').innerText()).toUpperCase().includes('NOW'));
    let inside = true;
    for (let i = 0; i < 60; i++) { await page.keyboard.press('Tab'); inside = inside && await page.evaluate(() => !!document.activeElement?.closest('#sidebar') || document.activeElement === document.body); }
    check('Tab stays in the panel: the page behind is inert', inside && await page.evaluate(() => document.querySelector('main').inert));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(320);
    check('Escape closes it, focus back on the button, the page live again', !(await isOpen()) && await page.evaluate(() => document.activeElement?.id === 'menuToggle' && !document.querySelector('main').inert));
    await menu.tap();
    await page.waitForTimeout(320);
    await page.touchscreen.tap(380, 400);
    await page.waitForTimeout(320);
    check('a tap on the scrim closes it', !(await isOpen()));
    await menu.tap();
    await page.waitForTimeout(320);
    const b = await panel.boundingBox();
    await page.mouse.move(b.x + b.width - 20, 300);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 140, 305, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(320);
    check('a swipe to the left closes it, and is no tap on a link', !(await isOpen()) && (await page.evaluate(() => location.hash)) === '#life');
    await menu.tap();
    await page.waitForTimeout(320);
    await page.locator('#sidebar a.nav-link', { hasText: 'Wallet' }).tap();
    await page.waitForTimeout(500);
    check('a link navigates and closes it', !(await isOpen()) && (await page.evaluate(() => location.hash)) === '#life/wallet');
    await menu.tap();
    await page.waitForTimeout(320);
    await page.locator('#sidebar a.nav-link', { hasText: 'Wallet' }).tap();
    await page.waitForTimeout(350);
    check('tapping the page you are on just closes it', !(await isOpen()));

    // Small and sideways: it must scroll to its last link.
    for (const [w, h] of [[320, 568], [844, 390]]) {
      await page.setViewportSize({ width: w, height: h });
      await menu.tap();
      await page.waitForTimeout(320);
      const m = await page.evaluate(() => { const s = document.getElementById('sidebar'); const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight, scrolls: s.scrollHeight > s.clientHeight, over: document.documentElement.scrollWidth - innerWidth }; });
      check(`${w}x${h}: fits the screen with room left for the scrim, no sideways scroll`, m.left >= 0 && m.right <= m.vw - 30 && m.top >= 0 && m.bottom <= m.vh + 1 && m.over <= 0, JSON.stringify(m));
      const out = page.locator('#sidebar [data-act="logout"]');
      await out.scrollIntoViewIfNeeded();
      const seen = await out.boundingBox();
      check(`${w}x${h}: taller than the screen it scrolls to Log out`, m.scrolls && !!seen && seen.y + seen.height <= m.vh + 1, JSON.stringify({ scrolls: m.scrolls, y: seen?.y }));
      if (OUT) await page.screenshot({ path: path.join(OUT, `sidebar-${w}x${h}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(320);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // With something else open.
    await go(page, '#life/day');
    await page.waitForTimeout(500);
    const row = page.locator('.ld-row.is-click').first();
    await row.scrollIntoViewIfNeeded();
    await row.tap();
    await page.waitForTimeout(400);
    const sideOpen = await page.locator('.ld-side.is-open').count();
    const box = await menu.boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + box.width / 2, box.y + box.height / 2]);
    if (OUT) await page.screenshot({ path: path.join(OUT, 'day-sheet-scrim.png') });
    check('Day\'s sheet open: a scrim covers the page, MENU too, like any sheet', sideOpen === 1 && hit === 'ldSideScrim', String(hit));
    const held = await page.evaluate(() => { const c = document.getElementById('ldSideClose'); const insideOnly = document.querySelector('.topbar').closest('[inert]') !== null && !!c && document.activeElement === c; return insideOnly && !document.querySelector('.ld-side').closest('[inert]'); });
    check('…the page behind it is inert, focus is in it', held);
    check('…the topbar stays where it was on a scrolled page', await page.evaluate(() => scrollY > 0 && document.getElementById('menuToggle').getBoundingClientRect().top === 0), await page.evaluate(() => `${scrollY} ${document.getElementById('menuToggle').getBoundingClientRect().top}`));
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
    check('…a tap on the scrim closes it, the menu stays shut, the page is live again', await page.locator('.ld-side.is-open').count() === 0 && !(await isOpen()) && await page.evaluate(() => !document.querySelector('[inert]') || !!document.querySelector('.sidebar[inert]') || !document.querySelector('.topbar').closest('[inert]')));
    await row.tap();
    await page.waitForTimeout(350);
    await page.locator('.ld-side.is-open .guide-q').first().tap();
    await page.waitForTimeout(500);
    const guideUp = await page.locator('.story-modal').count();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('…a guide opened from it works, and Escape closes the guide, not the sheet', guideUp === 1 && await page.locator('.story-modal').count() === 0 && await page.locator('.ld-side.is-open').count() === 1);
    await page.evaluate(() => { window.location.hash = '#life/map'; });
    await page.waitForTimeout(600);
    check('…leaving the page by the back way lets go of everything', await page.evaluate(() => !document.querySelector('.topbar').closest('[inert]') && !document.documentElement.classList.contains('ld-side-open')));
    await go(page, '#life/day');
    await page.waitForTimeout(400);
    await menu.tap();
    await page.waitForTimeout(320);
    await page.keyboard.press('?');
    await page.waitForTimeout(400);
    check('…the ? shortcut does nothing while the panel is open', await page.locator('.story-modal').count() === 0);
    await page.locator('#sidebar a.nav-link', { hasText: 'Map' }).tap();
    await page.waitForTimeout(500);
    check('…leaving the page closes the panel', !(await isOpen()));
    await page.locator('#guideBtn').tap();
    await page.waitForTimeout(600);
    const covered = await page.evaluate(() => { const m = document.querySelector('.story-modal'); const r = document.getElementById('menuToggle').getBoundingClientRect(); return !!m && !document.elementFromPoint(r.left + 10, r.top + 10)?.closest('#menuToggle'); });
    check('a modal open covers the menu button, so the two can\'t stack', covered);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('no page errors in all that', !errors.length, errors[0] || '');
    await ctx.close();
  }

  // ── the alert count: life.alerts on /api/status, tolerating its absence ──
  {
    const { ctx, page, errors } = await open(PHONE, base, '#life');
    const onMenu = page.locator('#menuToggle .nav-badge');
    check('alerts: no field, no badge, no error', await onMenu.isHidden() && !errors.length);
    await page.route('**/api/status', async (r) => {
      const res = await r.fetch();
      const body = await res.json();
      body.life = { ...(body.life || {}), alerts: 3 };
      await r.fulfill({ response: res, json: body });
    });
    await page.waitForTimeout(31_000);
    check('alerts: life.alerts 3 shows on the menu button', (await onMenu.innerText().catch(() => '')) === '3');
    await page.locator('#menuToggle').tap();
    await page.waitForTimeout(320);
    check('alerts: …and on Now in the panel', (await page.locator('#sidebar a.nav-link[data-page="life"] .nav-badge').innerText().catch(() => '')) === '3');
    await page.keyboard.press('Escape');
    await page.unroute('**/api/status');
    await page.route('**/api/status', async (r) => {
      const res = await r.fetch();
      const body = await res.json();
      body.life = { ...(body.life || {}), alerts: 'nonsense' };
      await r.fulfill({ response: res, json: body });
    });
    await page.waitForTimeout(31_000);
    check('alerts: a value that is not a number clears it', await onMenu.isHidden());
    await ctx.close();
  }

  // ── a sheet open across a 30 s poll ──
  {
    const { ctx, page } = await open(PHONE, base, '#life/day');
    const row = page.locator('.ld-row.is-click').first();
    await row.scrollIntoViewIfNeeded();
    await row.tap();
    await page.waitForTimeout(500);
    const openBefore = await page.locator('.ld-side.is-open').count();
    await page.waitForTimeout(32_000);
    check('Day: its row sheet survives a 30 s poll', openBefore === 1 && await page.locator('.ld-side.is-open').count() === 1);
    await page.locator('.ld-side-close').tap().catch(() => {});
    await page.locator('#menuToggle').tap();
    await page.waitForTimeout(320);
    await page.locator('#sidebar a.nav-link', { hasText: 'Story' }).focus();
    await page.waitForTimeout(32_000);
    check('the panel + focus survive a 30 s poll', await page.evaluate(() => document.getElementById('sidebar').classList.contains('is-open') && document.activeElement?.textContent?.includes('Story')));
    await ctx.close();
  }

  // ── a dropped session ──
  {
    const { ctx, page } = await open(PHONE, base, '#life');
    await ctx.clearCookies();
    let once = true;
    await page.route('**/api/groups*', async (r) => { if (once) { once = false; await r.fulfill({ status: 401, body: '{}' }); } else await r.continue(); });
    await go(page, '#groups');
    await page.waitForTimeout(800);
    check('cookie gone + a 401: renewed from the saved login, the page loads, no notice', await page.locator('#shellNotice').isHidden() && !once && !(await page.locator('#content').innerText()).includes('ERROR'));
    check('…the session cookie is back', (await ctx.cookies()).some((c) => c.name === 'dash_session'));
    await page.route('**/api/**', (r) => r.fulfill({ status: 401, body: '{}' }));
    await go(page, '#audit');
    await page.waitForTimeout(800);
    const notice = await page.locator('#shellNotice').innerText().catch(() => '');
    check('login refused too: SESSION ENDED with a way back', notice.includes('SESSION ENDED') && await page.locator('#shellNotice [data-act="reload"]').isVisible(), notice);
    if (OUT) await page.screenshot({ path: path.join(OUT, 'session-ended.png') });
    await page.unroute('**/api/**');
    await page.unroute('**/api/groups*');
    await page.locator('#shellNotice [data-act="reload"]').tap();
    await page.waitForTimeout(1800);
    check('SIGN IN AGAIN reloads into a working app', await page.locator('#shellNotice').isHidden());
    await ctx.close();
  }

  // ── no connection ──
  {
    const { ctx, page } = await open(PHONE, base, '#life');
    await ctx.setOffline(true);
    await go(page, '#groups');
    await page.waitForTimeout(600);
    const off = await page.locator('#shellNotice').innerText().catch(() => '');
    check('offline: says so', off.includes('CONNECTION LOST'), off);
    if (OUT) await page.screenshot({ path: path.join(OUT, 'offline.png') });
    await ctx.setOffline(false);
    await page.waitForTimeout(9000);
    check('back online: the notice clears by itself', await page.locator('#shellNotice').isHidden());
    check('…and a page that could not load opens now', !(await page.locator('#content').innerText()).includes('ERROR'));
    await ctx.close();
  }

  // ── the stream reconnects ──
  {
    const { ctx, page } = await open(DESK, base, '#status');
    let blocked = 0;
    await page.route('**/api/stream*', (r) => { blocked++; return r.fulfill({ status: 503, body: 'down' }); });
    await go(page, '#logs');
    await page.waitForTimeout(4500);
    const reopened = page.waitForResponse((r) => r.url().includes('/api/stream') && r.status() === 200, { timeout: 15000 }).then(() => true).catch(() => false);
    await page.unroute('**/api/stream*');
    check('stream: retries while the server refuses it', blocked >= 2, `${blocked} attempts`);
    check('stream: reconnects when the server is back', await reopened);
    await ctx.close();
  }

  // ── iOS zoom on focus ──
  {
    const { ctx, page } = await open(PHONE, base, '#memories');
    await page.locator('input[type="search"], input[type="text"]').first().focus();
    await page.waitForTimeout(150);
    const size = await page.evaluate(() => parseFloat(getComputedStyle(document.activeElement).fontSize));
    check('a focused field is 16 px, so iOS does not zoom', size >= 16, String(size));
    await ctx.close();
  }

  // ── readonly ──
  {
    const { ctx, page } = await open(PHONE, base, '#life');
    const ids = await firstIds(page);
    const live = {};
    for (const h of hashes(ids)) {
      await go(page, h);
      const on = await page.evaluate(() => [...document.querySelectorAll('.content button.primary:not(:disabled), .content button.danger:not(:disabled)')].filter((b) => b.offsetParent).map((b) => b.textContent.trim().slice(0, 24)));
      const marked = await page.evaluate(() => [...document.querySelectorAll('[data-write]:not(:disabled)')].length);
      if (marked) live[`${h} (marked, enabled!)`] = [String(marked)];
      if (on.length) live[h] = on;
    }
    check('readonly: the RO chip shows, nothing marked data-write is enabled', await page.locator('#roChip').isVisible() && !Object.keys(live).some((k) => k.includes('marked')), Object.keys(live).filter((k) => k.includes('marked')).join(' '));
    for (const [h, on] of Object.entries(live)) console.log(`INFO  readonly ${h}: ${on.join(' | ')}`);
    await ctx.close();
  }
}

async function emptyEdges(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life');
  const ids = await firstIds(page);
  for (const h of hashes(ids)) {
    errors.length = 0;
    await go(page, h);
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const c = document.getElementById('content');
      return { text: c.innerText.trim(), loading: !!c.querySelector('.loading'), alert: c.querySelector('[role=alert]')?.innerText || null, over: document.documentElement.scrollWidth - innerWidth };
    });
    const unknownRow = /UNKNOWN/.test(r.text);
    check(`empty ${h}`, !errors.length && r.text.length > 20 && !r.alert && !unknownRow && r.over <= 0,
      errors[0] || r.alert || (r.loading ? 'still loading (part)' : '') || (r.over > 0 ? `over ${r.over}` : ''));
    if (OUT) await page.screenshot({ path: path.join(OUT, `empty-${h.replace(/\W+/g, '-')}.png`) });
  }
  await ctx.close();
}

async function worstEdges(base) {
  const small = { ...PHONE, viewport: { width: 320, height: 568 } };
  const { ctx, page, errors } = await open(small, base, '#life');
  const ids = await firstIds(page);
  const threads = await page.evaluate(async () => ((await (await fetch('/api/arcs/phone')).json())?.threads || []).map((t) => t.castId));
  for (const h of [...hashes(ids), ...threads.slice(0, 3).map((id) => `#life/phone/${encodeURIComponent(id)}`)]) {
    errors.length = 0;
    await go(page, h);
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
      for (const el of document.querySelectorAll('#content *, .topbar *, .page-tabs *')) {
        if (el.closest('svg') || !el.offsetParent) continue;
        const b = el.getBoundingClientRect();
        if (b.right > vw + 1 && !inScroller(el)) out.push(`${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''}+${Math.round(b.right - vw)}`);
      }
      return { over: document.documentElement.scrollWidth - innerWidth, out: [...new Set(out)].slice(0, 4), bodyOver: document.body.scrollWidth - innerWidth };
    });
    check(`worst names 320 px ${h}`, r.over <= 0 && !r.out.length && !errors.length, [errors[0], ...r.out].filter(Boolean).join(' '));
    if (OUT) await page.screenshot({ path: path.join(OUT, `worst-${h.replace(/\W+/g, '-')}.png`) });
  }
  await ctx.close();
}

async function writeEdges(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#memories');
  await page.waitForTimeout(800);
  check('write mode: no RO chip, buttons on', await page.locator('#roChip').isHidden() && await page.locator('#memAddBtn').isEnabled());

  // Memories: a wide table as cards. Add a note through its form, delete it from its card.
  check('Memories is cards on a phone', await page.locator('table.data.cards').count() > 0);
  await page.locator('#memAddBtn').tap();
  await page.waitForTimeout(200);
  const form = page.locator('#memAddForm');
  const note = `edge note ${Date.now()}`;
  await form.locator('select[name="visibility"]').selectOption('everywhere');
  await form.locator('input[name="content"]').fill(note);
  await form.locator('button[type="submit"]').tap();
  await page.waitForTimeout(900);
  const row = page.locator('table.data.cards tr', { hasText: note });
  check('write: a note added on a phone lands in the cards', await row.count() === 1);
  check('write: …the audit has it', (await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=5')).json()))).includes('memor'));
  const label = await row.locator('td').nth(1).getAttribute('data-label');
  check('write: …the new card is labelled too', !!label, String(label));
  await row.locator('.mem-del').tap();
  await page.waitForTimeout(350);
  await page.locator('dialog.sheet button[type="submit"]').tap();
  await page.waitForTimeout(900);
  check('write: DEL on a card removes it', await page.locator('table.data.cards tr', { hasText: note }).count() === 0);

  // A dropped cookie before a write: renewed, and the CSRF cookie comes with it.
  await ctx.clearCookies();
  if (!await form.isVisible()) await page.locator('#memAddBtn').tap();
  await page.waitForTimeout(200);
  const note2 = `edge note after a dropped cookie ${Date.now()}`;
  await form.locator('select[name="visibility"]').selectOption('everywhere');
  await form.locator('input[name="content"]').fill(note2);
  await form.locator('button[type="submit"]').tap();
  await page.waitForTimeout(1200);
  check('write: a write with no cookies renews the session and goes through', await page.locator('table.data tr', { hasText: note2 }).count() === 1 && (await ctx.cookies()).some((c) => c.name === 'csrf_token'));

  // Skills: a toggle on a card, and its toast on screen.
  await go(page, '#skills');
  await page.waitForTimeout(400);
  const toggle = page.locator('.skill-toggle').first();
  const before = await toggle.getAttribute('data-enabled');
  await toggle.tap();
  await page.waitForTimeout(900);
  const flashBox = await page.evaluate(() => { const f = document.querySelector('.flash-region .flash'); return f ? { bottom: f.getBoundingClientRect().bottom, vh: innerHeight } : null; });
  check('write: a skill toggles from its card', (await page.locator('.skill-toggle').first().getAttribute('data-enabled')) !== before);
  check('write: …its toast is on screen', !!flashBox && flashBox.bottom <= flashBox.vh, JSON.stringify(flashBox));
  await page.locator('.skill-toggle').first().tap(); // back as it was
  await page.waitForTimeout(600);

  // The kit: a toast from inside a sheet is above the sheet, and leaving the page closes it.
  await go(page, '#kit');
  await page.locator('#kitSheet').tap();
  await page.waitForTimeout(300);
  await page.locator('#kitSheetFlash').tap();
  await page.waitForTimeout(150);
  check('kit: a toast from inside a sheet shows inside the top layer', await page.locator('dialog.sheet .flash-region .flash').count() >= 1);
  await page.evaluate(() => { window.location.hash = '#status'; });
  await page.waitForTimeout(700);
  check('leaving the page closes its sheet; the toast region is back in the page', await page.locator('dialog.sheet').count() === 0 && await page.evaluate(() => !document.querySelector('dialog .flash-region')));
  check('no page errors in write mode', !errors.length, errors[0] || '');
  await ctx.close();
}

async function phoneRead(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/phone');
  check('Phone: the chat list, with no page sideways scroll', await page.locator('.lp-trow').count() > 0);
  const withTexts = page.locator('.lp-trow:not(:has-text("no texts yet"))').first();
  await withTexts.tap();
  await page.waitForTimeout(1000);
  const v = await page.evaluate(() => {
    const se = document.scrollingElement;
    const last = [...document.querySelectorAll('.lp-msg')].pop()?.getBoundingClientRect();
    const head = document.querySelector('.lp-thread-head').getBoundingClientRect();
    return { hidden: getComputedStyle(document.querySelector('.page-header')).display === 'none', atEnd: se.scrollHeight - se.scrollTop - se.clientHeight < 90, lastOn: !!last && last.bottom <= innerHeight, top: head.top };
  });
  check('Phone: a chat is the whole screen and opens at its newest message', v.hidden && v.atEnd && v.lastOn, JSON.stringify(v));
  if (OUT) await page.screenshot({ path: path.join(OUT, 'phone-thread-390.png') });
  check('Phone: readonly: SEND A TEXT is off, and a bubble\'s actions too', await page.locator('.lp-compose').isDisabled());
  await page.locator('.lp-msg').last().tap();
  await page.waitForTimeout(200);
  check('Phone: readonly: a tapped bubble shows its actions, disabled', await page.locator('[data-act="edit"]').isDisabled());
  await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
  await page.waitForTimeout(150);
  const head = await page.evaluate(() => { const h = document.querySelector('.lp-thread-head').getBoundingClientRect(); const t = document.querySelector('.topbar').getBoundingClientRect(); const bar = document.querySelector('.lp-sendbar').getBoundingClientRect(); return { top: h.top, topbar: t.bottom, bar: bar.bottom, vh: innerHeight }; });
  check('Phone: scrolled up, the head stays under the topbar and SEND A TEXT at the bottom edge', head.top >= head.topbar - 1 && head.top <= head.topbar + 1 && head.bar <= head.vh + 1, JSON.stringify(head));
  const y = await page.evaluate(() => document.scrollingElement.scrollTop);
  await page.waitForTimeout(32_000);
  check('Phone: a poll leaves your place alone', (await page.evaluate(() => document.scrollingElement.scrollTop)) === y);
  await page.locator('.lp-back').tap();
  await page.waitForTimeout(500);
  check('Phone: ‹ ALL CHATS goes back to the list', await page.locator('.lp-trow').first().isVisible() && await page.locator('.page-header').isVisible());
  await go(page, '#life/phone/cast:nobody-here');
  await page.waitForTimeout(500);
  check('Phone: an unknown chat says so, with a way back', (await page.locator('.lp-msgs').innerText()).includes('NO THREAD') && await page.locator('.lp-back').isVisible());
  for (const [w, h] of [[320, 568], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await go(page, '#life/phone');
    await page.locator('.lp-trow:not(:has-text("no texts yet"))').first().tap();
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, bar: document.querySelector('.lp-sendbar').getBoundingClientRect().bottom, vh: innerHeight }));
    check(`Phone ${w}x${h}: a chat fits, SEND A TEXT on screen`, m.over <= 0 && m.bar <= m.vh + 1, JSON.stringify(m));
    if (OUT) await page.screenshot({ path: path.join(OUT, `phone-thread-${w}x${h}.png`) });
  }
  check('Phone: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
  const d = await open(DESK, base, '#life/phone');
  await d.page.locator('.lp-trow:not(:has-text("no texts yet"))').first().click();
  await d.page.waitForTimeout(1000);
  const dm = await d.page.evaluate(() => { const m = document.querySelector('.lp-msgs'); const r = document.querySelector('.lp-sendbar').getBoundingClientRect(); return { atEnd: m.scrollHeight - m.scrollTop - m.clientHeight < 80, bar: r.bottom, vh: innerHeight, list: getComputedStyle(document.querySelector('.lp-list')).display }; });
  check('Phone desktop: list beside the chat, at its newest message, SEND A TEXT on screen', dm.atEnd && dm.bar <= dm.vh && dm.list !== 'none', JSON.stringify(dm));
  if (OUT) await d.page.screenshot({ path: path.join(OUT, 'phone-thread-1440.png') });
  await d.ctx.close();
}

async function phoneWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/phone');
  await page.locator('.lp-trow:not(:has-text("no texts yet"))').first().tap();
  await page.waitForTimeout(1000);
  const bubbles = page.locator('.lp-msg');
  const count = await bubbles.count();

  // SEND A TEXT: the draft survives a poll and a cancelled preview; a real apply writes.
  await page.locator('.lp-compose').tap();
  await page.waitForTimeout(300);
  const sheet = page.locator('dialog.sheet');
  check('Phone write: SEND A TEXT opens in a sheet', await sheet.isVisible());
  await sheet.locator('input[name="gist"]').fill('ask how the trip went');
  await page.waitForTimeout(32_000);
  check('Phone write: what you typed survives a 30 s poll', (await sheet.locator('input[name="gist"]').inputValue()) === 'ask how the trip went');
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(1500);
  check('Phone write: the preview opens, the sheet closes', await page.locator('.story-modal-card').isVisible() && await sheet.count() === 0);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'phone-preview.png') });
  await page.locator('.story-modal [data-act="close"]').first().tap();
  await page.waitForTimeout(300);
  await page.locator('.lp-compose').tap();
  await page.waitForTimeout(300);
  check('Phone write: cancelling the preview keeps the draft', (await sheet.locator('input[name="gist"]').inputValue()) === 'ask how the trip went');
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(1500);
  await page.locator('.story-modal [data-act="apply"]').first().tap();
  await page.waitForTimeout(1500);
  const audit = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=8')).json()));
  check('Phone write: APPLY writes it, audited', audit.includes('director.text'), audit.slice(0, 120));
  await page.locator('.story-modal [data-act="close"]').first().tap().catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('.lp-compose').tap();
  await page.waitForTimeout(300);
  check('Phone write: after it is sent the form is empty', (await sheet.locator('input[name="gist"]').inputValue()) === '');
  await sheet.locator('input[name="gist"]').fill('a thought');
  await sheet.locator('.sheet-close').tap();
  await page.waitForTimeout(350);
  await page.locator('.lp-compose').tap();
  await page.waitForTimeout(300);
  check('Phone write: closing the sheet keeps what you typed too', (await sheet.locator('input[name="gist"]').inputValue()) === 'a thought');
  await sheet.locator('.sheet-close').tap();
  await page.waitForTimeout(350);

  // EDIT on a bubble.
  const target = bubbles.nth(count - 1);
  await target.tap();
  await page.waitForTimeout(200);
  await page.locator('[data-act="edit"]').tap();
  await page.waitForTimeout(200);
  await page.locator('.lp-edit textarea').fill('edited on a phone');
  await page.locator('.lp-edit button[type="submit"]').tap();
  await page.waitForTimeout(900);
  check('Phone write: EDIT changes the words and marks it', (await page.locator('.lp-msg', { hasText: 'edited on a phone' }).innerText()).includes('EDITED'));

  // REVERT, asked in a sheet: KEEP IT does nothing; REVERT takes it out.
  await page.locator('.lp-msg', { hasText: 'edited on a phone' }).tap();
  await page.waitForTimeout(200);
  await page.locator('[data-act="revert"]').tap();
  await page.waitForTimeout(300);
  await page.locator('dialog.sheet [data-ask="no"]').tap();
  await page.waitForTimeout(350);
  check('Phone write: KEEP IT leaves it live', !(await page.locator('.lp-msg', { hasText: 'edited on a phone' }).innerText()).includes('REVERTED'));
  await page.locator('[data-act="revert"]').tap();
  await page.waitForTimeout(300);
  await page.locator('dialog.sheet input[name="reason"]').fill('checking');
  await page.locator('dialog.sheet button[type="submit"]').tap();
  await page.waitForTimeout(1200);
  check('Phone write: REVERT takes it out of his world, marked', (await page.locator('.lp-msg.is-reverted').count()) >= 1);
  check('Phone write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function peopleRead(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/cast');
  await page.waitForTimeout(500);
  const cards = page.locator('.lc-card');
  check('People: one card per person, no table', await cards.count() === 6 && await page.locator('.lc-who table').count() === 0, String(await cards.count()));
  const small = await page.evaluate(() => [...document.querySelectorAll('.lc-card')].filter((c) => c.getBoundingClientRect().height < 44).length);
  check('People: cards are big enough to tap', small === 0);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  check('People: the page got shorter than its cards-table version (2,030 px)', h < 1500, `${h} px`);
  const web = page.locator('[data-fold="people.web"]');
  check('People: on a phone the web is folded away', !(await web.getAttribute('open') !== null));
  if (OUT) await page.screenshot({ path: path.join(OUT, 'people-390.png') });
  await web.locator('summary .guide-q').tap();
  await page.waitForTimeout(500);
  check('People: the ? in a fold\'s head opens the guide and leaves the fold alone', await page.locator('.guide-card').count() === 1 && await web.getAttribute('open') === null);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await web.locator('summary').tap();
  await page.waitForTimeout(300);
  const box = await page.evaluate(() => { const b = document.querySelector('.story-web-wrap'); return { scrolled: b.scrollLeft, canScroll: b.scrollWidth > b.clientWidth, over: document.documentElement.scrollWidth - innerWidth }; });
  check('People: opened, the web scrolls in its own box, centred on him', box.over <= 0 && (!box.canScroll || box.scrolled > 0), JSON.stringify(box));
  if (OUT) { await web.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, 'people-web-390.png') }); }
  await page.waitForTimeout(32_000);
  check('People: a poll leaves the web open and where it was', await web.getAttribute('open') !== null && (await page.evaluate(() => document.querySelector('.story-web-wrap').scrollLeft)) === box.scrolled);
  await web.locator('summary').tap();
  await cards.first().tap();
  await page.waitForTimeout(1000);
  check('People: a card opens that person', (await page.evaluate(() => location.hash)).startsWith('#life/cast/cast'));

  // One person
  const order = await page.evaluate(() => [...document.querySelectorAll('.lm-col > *')].map((x) => x.querySelector('.panel-head')?.textContent.trim().slice(0, 12)));
  check('Person: leads with NOW, HOW THINGS STAND, TEXTS, HISTORY WITH HIM', /NOW/.test(order[0]) && /HOW THING/.test(order[1]) && /TEXTS/.test(order[2]) && /HISTORY W/.test(order[3]), JSON.stringify(order));
  check('Person: on a phone the reference panels are folded', await page.locator('.lm-col details[open]').count() === 0);
  const pageH = await page.evaluate(() => document.documentElement.scrollHeight);
  check('Person: the page got shorter (it was 4,301 px)', pageH < 3000, `${pageH} px`);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'person-390.png') });
  await page.locator('[data-fold="member.events"] summary').tap();
  await page.waitForTimeout(300);
  check('Person: EVENTS opens, as cards', await page.locator('[data-fold="member.events"] table.data.cards').count() === 1 || await page.locator('[data-fold="member.events"] td .empty, [data-fold="member.events"] td.empty').count() === 1);
  await page.reload();
  await page.waitForSelector('.lm-grid');
  await page.waitForTimeout(1200);
  check('Person: an opened fold is remembered', await page.locator('[data-fold="member.events"]').getAttribute('open') !== null);
  const why = page.locator('.lm-why').first();
  if (await why.count()) {
    await why.tap();
    await page.waitForTimeout(800);
    check('Person: WHY opens in a sheet with the chain', await page.locator('dialog.sheet .life-chain li').count() >= 1);
    if (OUT) await page.screenshot({ path: path.join(OUT, 'person-why-390.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }
  check('Person: readonly: NARRATE is off', await page.locator('.lm-narrate').first().isDisabled());
  await page.locator('[data-fold="member.events"] summary').tap(); // leave it as it was
  await go(page, '#life/cast/cast:nobody-here');
  await page.waitForTimeout(600);
  check('Person: an unknown id says so', (await page.locator('[data-slot="lm-off"]').innerText()).includes('NO SUCH'));
  check('People: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
  const d = await open(DESK, base, '#life/cast');
  await d.page.waitForTimeout(500);
  check('People desktop: cards beside the web, open', await d.page.locator('[data-fold="people.web"]').getAttribute('open') !== null && await d.page.locator('.lc-card').count() === 6);
  if (OUT) await d.page.screenshot({ path: path.join(OUT, 'people-1440.png') });
  await d.page.locator('.lc-card').first().click();
  await d.page.waitForTimeout(1000);
  check('Person desktop: two columns, panels open', await d.page.locator('.lm-col').count() === 2 && await d.page.locator('.lm-col details[open]').count() === 4);
  if (OUT) await d.page.screenshot({ path: path.join(OUT, 'person-1440.png') });
  await d.ctx.close();
}

async function peopleWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/cast');
  await page.waitForTimeout(500);
  const ids = await page.evaluate(async () => ((await (await fetch('/api/arcs/cast')).json())?.cast || []).map((c) => c.id));
  await go(page, `#life/cast/${encodeURIComponent(ids[0])}`);
  await page.waitForTimeout(800);
  // NARRATE: a real write through a sheet.
  await page.locator('[data-fold="member.events"] summary').tap();
  await page.waitForTimeout(300);
  await page.locator('.lm-narrate').first().tap();
  await page.waitForTimeout(1500);
  const narrated = await page.locator('dialog.sheet').innerText().catch(() => '');
  check('Person write: NARRATE shows its text in a sheet', narrated.includes('finally did') || narrated.includes('CACHED') || narrated.includes('NEW'), narrated.slice(0, 80));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  const audit = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=5')).json()));
  check('Person write: it is audited', audit.includes('narrate'), audit.slice(0, 100));

  // READ THE SCENE: edit its words, in the sheet (any person with a scene).
  let done = false;
  for (const id of ids) {
    await go(page, `#life/cast/${encodeURIComponent(id)}`);
    await page.waitForTimeout(600);
    const read = page.locator('.lm-scene').first();
    if (!await read.count()) continue;
    await read.tap();
    await page.waitForTimeout(800);
    const sheet = page.locator('dialog.sheet');
    check('Person write: READ THE SCENE opens in a sheet', await sheet.isVisible() && (await sheet.innerText()).length > 60);
    if (OUT) await page.screenshot({ path: path.join(OUT, 'person-scene-390.png') });
    const edit = sheet.getByRole('button', { name: /EDIT/ }).first();
    if (await edit.count()) {
      await edit.tap();
      await page.waitForTimeout(250);
      await sheet.locator('textarea').first().fill('They talked on the steps for a while, and it was better than either of them had expected.');
      await sheet.getByRole('button', { name: /SAVE/ }).first().tap();
      await page.waitForTimeout(900);
      check('Person write: a scene edited in the sheet keeps its new words', (await sheet.innerText()).includes('better than either'));
      const a2 = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=5')).json()));
      check('Person write: …audited', a2.includes('arcs.scene'), a2.slice(0, 100));
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    done = true;
    break;
  }
  if (!done) console.log('INFO  no scene in this world: scene edit not exercised');
  check('Person write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function walletEdges(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/wallet');
  await page.waitForTimeout(600);
  check('Wallet: the log has its own compact rows, not generic cards', await page.locator('.lw-table tr').count() > 3 && await page.locator('.lw-table.cards').count() === 0);
  const row = await page.evaluate(() => { const rows = [...document.querySelectorAll('.lw-table tbody tr')]; const heights = rows.map((r) => r.getBoundingClientRect().height); const first = rows[0]; const what = first.children[1].getBoundingClientRect(); const amt = first.querySelector('.lw-amt').getBoundingClientRect(); return { max: Math.max(...heights), sameLine: Math.abs(what.top - amt.top) < 8, amtRight: amt.right, vw: innerWidth }; });
  check('Wallet: what and the amount share a line, amounts at the right edge, rows stay short', row.sameLine && row.amtRight > row.vw * 0.8 && row.max < 170, JSON.stringify(row));
  const rev = page.locator('.lw-revert').first();
  await rev.scrollIntoViewIfNeeded();
  if (OUT) await page.screenshot({ path: path.join(OUT, 'wallet-log-390.png') });
  const before = await page.evaluate(() => document.querySelector('.lw-table').outerHTML.length);
  await page.evaluate(() => { document.querySelector('.lw-table').dataset.mark = 'same'; });
  await page.waitForTimeout(31_000);
  check('Wallet: a poll with nothing new repaints nothing', (await page.evaluate(() => document.querySelector('.lw-table').dataset.mark)) === 'same' && before > 0);
  await go(page, '#life/wallet/2020-01');
  await page.waitForTimeout(600);
  check('Wallet: a month out of range says so', (await page.locator('#content').innerText()).length > 20);
  for (const [w, h] of [[320, 568], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await go(page, '#life/wallet');
    await page.waitForTimeout(600);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`Wallet ${w}x${h}: no sideways scroll`, over <= 0, String(over));
  }
  check('Wallet: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function walletWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/wallet');
  await page.waitForTimeout(800);
  const rows = page.locator('.lw-table tbody tr');
  const count = await rows.count();
  const btn = page.locator('.lw-revert:not(:disabled)').first();
  check('Wallet write: a money event offers REVERT', await btn.count() === 1);
  const id = await btn.getAttribute('data-id');
  await btn.tap();
  await page.waitForTimeout(300);
  await page.locator('dialog.sheet [data-ask="no"]').tap();
  await page.waitForTimeout(350);
  check('Wallet write: KEEP IT does nothing', await rows.count() === count && await page.locator(`.lw-table tr[data-ev="${id}"]`).count() === 1);
  await page.locator(`.lw-revert[data-id="${id}"]`).tap();
  await page.waitForTimeout(300);
  await page.locator('dialog.sheet input[name="reason"]').fill('checking');
  await page.locator('dialog.sheet button[type="submit"]').tap();
  await page.waitForTimeout(1200);
  check('Wallet write: REVERT takes it off the log', await page.locator(`.lw-table tr[data-ev="${id}"]`).count() === 0);
  const audit = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=5')).json()));
  check('Wallet write: …audited', audit.includes('life.revert'), audit.slice(0, 100));
  check('Wallet write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function mapGrid(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/map');
  await page.waitForTimeout(700);
  const v = await page.evaluate(() => { const w = document.querySelector('.life-map-wrap'); const me = document.querySelector('.lm-me'); const a = me?.getBoundingClientRect(); const b = w.getBoundingClientRect(); return { scrolls: w.scrollWidth > w.clientWidth, meOn: !!a && a.left >= b.left && a.right <= b.right, over: document.documentElement.scrollWidth - innerWidth, x: w.scrollLeft }; });
  check('Map grid: scrolls in its box, starts with him in view, no page scroll', v.over <= 0 && v.meOn, JSON.stringify(v));
  if (OUT) await page.screenshot({ path: path.join(OUT, 'map-grid-390.png') });
  const order = await page.evaluate(() => [...document.querySelectorAll('.lm-lists > *')].map((x) => x.querySelector('.panel-head')?.textContent.trim().slice(0, 8)));
  check('Map: trips first, places folded on a phone', /TRIPS/.test(order[0]) && await page.locator('[data-fold="map.places"]').getAttribute('open') === null, JSON.stringify(order));
  await page.evaluate(() => { document.querySelector('.life-map-wrap').scrollLeft = 0; });
  await page.waitForTimeout(31_000);
  check('Map grid: a poll leaves your scroll alone', (await page.evaluate(() => document.querySelector('.life-map-wrap').scrollLeft)) === 0);
  await page.locator('[data-fold="map.places"] summary').tap();
  await page.waitForTimeout(300);
  check('Map: places open, as cards', await page.locator('[data-fold="map.places"] tbody tr').count() > 3);
  await page.locator('[data-fold="map.places"] summary').tap();
  check('Map: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function mapLeaflet(base) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  for (const [name, device] of [['390', PHONE], ['320', { ...PHONE, viewport: { width: 320, height: 568 } }], ['landscape', { ...PHONE, viewport: { width: 844, height: 390 } }], ['1440', DESK]]) {
    const ctx = await browser.newContext({ ...device, httpCredentials: { username: 'admin', password: 'preview' } });
    await ctx.route('https://tiles.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#life/map`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.leaflet-container', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => { const c = document.querySelector('.leaflet-container'); const r = c?.getBoundingClientRect(); const z = document.querySelector('.leaflet-control-zoom a')?.getBoundingClientRect(); return { map: !!c, h: r?.height, w: r?.width, vh: innerHeight, vw: innerWidth, zoom: z?.height, over: document.documentElement.scrollWidth - innerWidth, places: document.querySelectorAll('.leaf-place').length }; });
    const below = m.vh > 500 ? m.h < m.vh * 0.75 : true;
    check(`Map Leaflet ${name}: mounted with its places, leaves room to scroll past, no page scroll`, m.map && m.places > 3 && below && m.w <= m.vw && m.over <= 0 && !errors.length, JSON.stringify(m) + (errors[0] || ''));
    if (device.isMobile) check(`Map Leaflet ${name}: zoom buttons big enough`, m.zoom >= 44, String(m.zoom));
    if (OUT) await page.screenshot({ path: path.join(OUT, `map-leaflet-${name}.png`) });
    await ctx.close();
  }
}

async function settingsRead(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#settings');
  await page.waitForTimeout(800);
  const folds = page.locator('details[data-fold^="settings."]');
  check('Settings: six sections, folded on a phone', await folds.count() === 6 && await page.locator('details[data-fold^="settings."][open]').count() === 0);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  check('Settings: the page is short now (it was 9,164 px)', h < 1200, `${h} px`);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'settings-390.png') });
  check('Settings: meta in the section heads survived', (await page.locator('[data-fold="settings.roles"] summary').innerText()).includes('GLOBAL'));
  await page.locator('[data-fold="settings.roles"] summary').tap();
  await page.waitForTimeout(300);
  const shown = () => page.evaluate(() => [...document.querySelectorAll('#rolesTable tbody tr')].filter((r) => r.offsetParent).map((r) => r.dataset.roleRow));
  const one = await shown();
  check('Settings: roles show one card at a time', one.length === 1, JSON.stringify(one));
  const opts = await page.locator('#roleFocus option').allTextContents();
  check('Settings: the picker lists every role', opts.length >= 6, opts.join(','));
  await page.locator('#roleFocus').selectOption({ index: 2 });
  await page.waitForTimeout(150);
  const two = await shown();
  check('Settings: the picker changes the card', two.length === 1 && two[0] !== one[0], JSON.stringify(two));
  check('Settings: a card\'s fields are labelled', (await page.locator('#rolesTable tr.is-focus td').nth(1).getAttribute('data-label')) === 'PROVIDER');
  if (OUT) { await page.locator('#roleFocus').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, 'settings-role-390.png') }); }
  await page.locator('[data-fold="settings.roles"] summary').tap();
  await page.locator('[data-fold="settings.live"] summary').tap({ position: { x: 12, y: 12 } });
  await page.waitForTimeout(300);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.set-rows tbody tr')].filter((r) => r.offsetParent).length);
  const all = await rows();
  await page.locator('#settingsFind').fill('responseRate');
  await page.waitForTimeout(100);
  const found = await rows();
  check('Settings: the box finds a setting by name', all > 10 && found >= 1 && found < all, `${all} → ${found}`);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'settings-find-390.png') });
  await page.locator('#settingsFind').fill('no-such-setting-at-all');
  await page.waitForTimeout(100);
  check('Settings: nothing found says so', await page.locator('#settingsFindNone').isVisible() && (await rows()) === 0);
  await page.locator('#settingsFind').fill('');
  await page.waitForTimeout(100);
  const smallBoxes = await page.evaluate(() => [...document.querySelectorAll('.set-rows input[type="checkbox"]')].filter((i) => i.offsetParent).filter((i) => i.closest('label').getBoundingClientRect().height < 44).length);
  check('Settings: every checkbox has a 44 px target', smallBoxes === 0, String(smallBoxes));
  if (OUT) { await page.locator('.set-rows').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, 'settings-live-390.png') }); }
  check('Settings: readonly: APPLY and PERSIST are off', await page.locator('#settingsForm button[type="submit"]').isDisabled() && await page.locator('#settingsPersist').isDisabled());
  for (const [w, hh] of [[320, 568], [844, 390]]) {
    await page.setViewportSize({ width: w, height: hh });
    for (const key of ['roles', 'live', 'keys', 'static', 'pair', 'maint']) await page.evaluate((k) => { document.querySelector(`[data-fold="settings.${k}"]`).open = true; }, key);
    await page.waitForTimeout(250);
    const over = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, wide: [...document.querySelectorAll('.set-grid *, [data-fold="settings.roles"] *')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('pre, .table-wrap')).slice(0, 3).map((e) => `${e.tagName}.${e.className}`) }));
    check(`Settings ${w}x${hh}: everything open, nothing wider than the screen`, over.over <= 0 && !over.wide.length, JSON.stringify(over));
    if (OUT) await page.screenshot({ path: path.join(OUT, `settings-${w}x${hh}.png`), fullPage: true });
    for (const key of ['roles', 'live', 'keys', 'static', 'pair', 'maint']) await page.evaluate((k) => { document.querySelector(`[data-fold="settings.${k}"]`).open = false; }, key);
  }
  check('Settings: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
  const d = await open(DESK, base, '#settings');
  await d.page.waitForTimeout(800);
  check('Settings desktop: all open, every role in the table', await d.page.locator('details[data-fold^="settings."][open]').count() === 6 && await d.page.evaluate(() => [...document.querySelectorAll('#rolesTable tbody tr')].filter((r) => r.offsetParent).length) >= 6);
  check('Settings desktop: the role picker is hidden', await d.page.locator('#roleFocus').isHidden());
  if (OUT) await d.page.screenshot({ path: path.join(OUT, 'settings-1440.png') });
  await d.ctx.close();
}

async function settingsWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#settings');
  await page.waitForTimeout(800);
  const cfg = () => page.evaluate(async () => (await (await fetch('/api/config')).json()).values);
  await page.locator('[data-fold="settings.live"] summary').tap({ position: { x: 12, y: 12 } });
  await page.waitForTimeout(250);
  await page.locator('#settingsFind').fill('responseRate');
  const rate = page.locator('input[data-key="responseRate"]');
  const was = (await cfg()).responseRate;
  const next = was === 0.2 ? 0.25 : 0.2;
  await rate.fill(String(next));
  await page.locator('#settingsForm button[type="submit"]').tap();
  await page.waitForTimeout(900);
  check('Settings write: a number applied from the phone form', (await cfg()).responseRate === next, String((await cfg()).responseRate));
  check('Settings write: …the finder keeps its filter after APPLY', await page.locator('input[data-key="responseRate"]').isVisible() && (await page.evaluate(() => [...document.querySelectorAll('.set-rows tbody tr')].filter((r) => r.offsetParent).length)) < 5);
  await page.locator('#settingsFind').fill('');
  const box = page.locator('.set-check input').first();
  const key = await box.getAttribute('data-key');
  const before = await box.isChecked();
  await box.locator('..').tap();
  check('Settings write: tapping the whole target flips the checkbox', (await page.locator(`input[data-key="${key}"]`).isChecked()) !== before);
  await page.locator('#settingsForm button[type="submit"]').tap();
  await page.waitForTimeout(900);
  const audit = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=5')).json()));
  check('Settings write: audited', audit.includes('config'), audit.slice(0, 100));
  await page.locator('[data-fold="settings.live"] summary').tap({ position: { x: 12, y: 12 } });

  // Two roles changed through the picker, one APPLY.
  await page.locator('[data-fold="settings.roles"] summary').tap();
  await page.waitForTimeout(250);
  const rowsOf = await page.evaluate(() => [...document.querySelectorAll('#rolesTable tbody tr')].filter((r) => r.querySelector('input[data-field="maxTokens"]')).map((r) => r.dataset.roleRow));
  await page.locator('#roleFocus').selectOption(rowsOf[0]);
  await page.locator(`#rolesTable tr[data-role-row="${rowsOf[0]}"] input[data-field="maxTokens"]`).fill('2111');
  await page.locator('#roleFocus').selectOption(rowsOf[1]);
  await page.locator(`#rolesTable tr[data-role-row="${rowsOf[1]}"] input[data-field="maxTokens"]`).fill('2222');
  await page.locator('#rolesApply').tap();
  await page.waitForTimeout(1000);
  const roles = await page.evaluate(async () => (await (await fetch('/api/llm/roles')).json()).roles);
  const mt = (r) => roles.find((x) => x.role === r)?.values?.maxTokens;
  check('Settings write: two roles changed via the picker both apply', Number(mt(rowsOf[0])) === 2111 && Number(mt(rowsOf[1])) === 2222, `${mt(rowsOf[0])} ${mt(rowsOf[1])}`);
  check('Settings write: the picker stays on the role you were on', (await page.locator('#roleFocus').inputValue()) === rowsOf[1]);

  // PERSIST asks first. KEEP IT writes nothing (a real persist would write this tree's .env, so it isn't run).
  await page.locator('[data-fold="settings.live"] summary').tap({ position: { x: 12, y: 12 } });
  await page.waitForTimeout(250);
  await page.locator('#settingsPersist').tap();
  await page.waitForTimeout(300);
  check('Settings write: PERSIST asks in a sheet', (await page.locator('dialog.sheet').innerText()).includes('.env'));
  await page.locator('dialog.sheet [data-ask="no"]').tap();
  await page.waitForTimeout(350);
  check('Settings write: KEEP IT writes no .env', !fs.existsSync(path.join(ROOT, '.env')));
  await page.goto(`${base}/#audit`);
  await page.waitForSelector('[data-slot="audit-rows"] tr td:nth-child(3)');
  check('Audit: BY names who made the changes, and so does the WHO column', await page.evaluate(() => document.querySelector('[data-slot="audit-actors"]').textContent === 'admin' && document.querySelector('[data-slot="audit-rows"] td:nth-child(3)').textContent.trim() === 'admin'));
  check('Settings write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function chatsRead(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#groups');
  await page.waitForTimeout(500);
  const { group, person } = await firstIds(page);
  const height = () => page.evaluate(() => document.documentElement.scrollHeight);
  await go(page, `#group/${encodeURIComponent(group)}`);
  await page.waitForTimeout(600);
  check('Group: controls come first', await page.evaluate(() => { const c = document.querySelector('.gd-controls').getBoundingClientRect(); const f = [...document.querySelectorAll('.panel-head')].find((h) => h.textContent.includes('ABOUT THIS GROUP')).getBoundingClientRect(); return c.top < f.top; }));
  check('Group: everything else folds on a phone', await page.locator('details[data-fold^="group."][open]').count() === 0 && await page.locator('details[data-fold^="group."]').count() >= 5);
  const gh = await height();
  check('Group: the page got shorter (it was 2,770 px)', gh < 1900, `${gh} px`);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'group-390.png') });
  await page.locator('[data-fold="group.members"] summary').tap();
  await page.waitForTimeout(250);
  check('Group: a fold opens with its rows', await page.locator('[data-fold="group.members"] tbody tr').count() >= 1);
  await page.locator('[data-fold="group.members"] summary').tap();
  await go(page, `#person/${encodeURIComponent(person)}`);
  await page.waitForTimeout(600);
  const ph = await height();
  check('Contact: the page got shorter (it was 4,072 px)', ph < 1800, `${ph} px`);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'person-390.png') });
  await page.locator('[data-fold="person.edit"] summary').tap();
  await page.waitForTimeout(200);
  const clipped = await page.evaluate(() => { const f = document.querySelector('#pdEditForm').getBoundingClientRect(); const box = document.querySelector('#pdEditForm').closest('.panel-body').getBoundingClientRect(); return [...document.querySelectorAll('#pdEditForm input, #pdEditForm select')].filter((i) => i.getBoundingClientRect().right > box.right - 4).length + (f.right > box.right ? 1 : 0); });
  check('Contact: the edit fields fit their panel (they were cut off at the right)', clipped === 0, String(clipped));
  if (OUT) await page.screenshot({ path: path.join(OUT, 'person-edit-390.png') });
  await page.locator('[data-fold="person.edit"] summary').tap();
  await go(page, '#instagram');
  await page.waitForTimeout(700);
  const ih = await height();
  check('Instagram: the page got shorter (it was 3,077 px)', ih < 2300, `${ih} px`);
  await go(page, '#skills');
  await page.waitForTimeout(500);
  const sh = await height();
  check('Skills: the page got shorter (it was 3,610 px)', sh < 1900, `${sh} px`);
  const d0 = page.locator('.sk-desc').first();
  const h0 = await d0.evaluate((e) => e.getBoundingClientRect().height);
  await d0.tap();
  await page.waitForTimeout(100);
  const h1 = await d0.evaluate((e) => e.getBoundingClientRect().height);
  check('Skills: a tap shows the whole description', h1 > h0, `${h0} → ${h1}`);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'skills-390.png') });
  check('Chats: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
  const d = await open(DESK, base, `#group/${encodeURIComponent(group)}`);
  await d.page.waitForTimeout(600);
  check('Desktop: a group has its folds open', await d.page.locator('details[data-fold^="group."]:not([open])').count() === 0);
  if (OUT) await d.page.screenshot({ path: path.join(OUT, 'group-1440.png') });
  await d.ctx.close();
}

async function chatsWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#groups');
  await page.waitForTimeout(500);
  const { group, person } = await firstIds(page);
  const audit = () => page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=6')).json()));
  await go(page, `#group/${encodeURIComponent(group)}`);
  await page.waitForTimeout(600);
  await page.locator('#gdVibe').fill('quiet · dry');
  await page.locator('#gdSaveVibe').tap();
  await page.waitForTimeout(800);
  check('Group write: SAVE VIBE', (await page.evaluate(async (j) => (await (await fetch(`/api/groups/${encodeURIComponent(j)}`)).json()).vibe, group)) === 'quiet · dry');
  await page.locator('#gdMuteMin').fill('30');
  await page.locator('#gdMute').tap();
  await page.waitForTimeout(800);
  check('Group write: MUTE shows UNMUTE', await page.locator('#gdUnmute').isVisible());
  await page.locator('#gdUnmute').tap();
  await page.waitForTimeout(800);
  check('Group write: UNMUTE', await page.locator('#gdUnmute').count() === 0);
  check('Group write: audited', (await audit()).includes('mute'), (await audit()).slice(0, 100));
  await go(page, `#person/${encodeURIComponent(person)}`);
  await page.waitForTimeout(600);
  await page.locator('[data-fold="person.edit"] summary').tap();
  await page.waitForTimeout(200);
  await page.locator('#pdEditForm input[name="summary"]').fill('an owner note on a phone');
  await page.locator('#pdEditForm button[type="submit"]').tap();
  await page.waitForTimeout(900);
  check('Contact write: SAVE OWNER PROFILE shows in the dossier', (await page.locator('[data-slot="pd-meta"]').innerText()).includes('an owner note on a phone'));
  check('Contact write: audited', (await audit()).includes('people') || (await audit()).includes('person'), (await audit()).slice(0, 120));
  check('Chats write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function mindRead(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#mind');
  await page.waitForTimeout(900);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  check('Mind: the page got shorter (it was 3,650 px)', h < 2500, `${h} px`);
  check('Mind: self-state open, the rest folded on a phone', await page.locator('[data-fold="mind.selfstate"]').getAttribute('open') !== null && await page.locator('details[data-fold^="mind."][open]').count() === 1 && await page.locator('details[data-fold^="mind."]').count() === 11);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'mind-390.png'), fullPage: true });
  await page.locator('[data-fold="mind.selfmodel"] summary').tap();
  await page.waitForTimeout(250);
  check('Mind: a fold opens with its form', await page.locator('#mSmEdit').isVisible());
  await page.waitForTimeout(31_000);
  check('Mind: a poll leaves it open', await page.locator('[data-fold="mind.selfmodel"]').getAttribute('open') !== null);
  await page.locator('[data-fold="mind.selfmodel"] summary').tap();
  check('Mind: readonly: its write buttons are off', await page.locator('#mPause').isDisabled());
  for (const [w, hh] of [[320, 568], [844, 390]]) {
    await page.setViewportSize({ width: w, height: hh });
    await page.waitForTimeout(250);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`Mind ${w}x${hh}: no sideways scroll`, over <= 0, String(over));
  }
  check('Mind: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
  const d = await open(DESK, base, '#mind');
  await d.page.waitForTimeout(900);
  check('Mind desktop: all open', await d.page.locator('details[data-fold^="mind."]:not([open])').count() === 0);
  if (OUT) await d.page.screenshot({ path: path.join(OUT, 'mind-1440.png') });
  await d.ctx.close();
}

async function mindWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#mind');
  await page.waitForTimeout(900);
  const audit = () => page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=8')).json()));
  const sheet = page.locator('dialog.sheet');
  // PAUSE asks first: KEEP IT leaves it, PAUSE writes.
  await page.locator('#mPause').tap();
  await page.waitForTimeout(300);
  check('Mind write: PAUSE asks in a sheet', (await sheet.innerText()).includes('Queued proactive'));
  await sheet.locator('[data-ask="no"]').tap();
  await page.waitForTimeout(350);
  check('Mind write: KEEP IT writes nothing', !(await audit()).includes('mind.pause'));
  await page.locator('#mPause').tap();
  await page.waitForTimeout(300);
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(1000);
  const a1 = await audit();
  console.log(`INFO  mind pause: ${a1.includes('mind.pause') ? 'written' : 'refused while the mind is off'}`);
  // The exclude-everyone box: unticked until it's confirmed.
  await page.locator('[data-fold="mind.exclusions"] summary').tap();
  await page.waitForTimeout(250);
  const box = page.locator('#mExcludeAll');
  await box.tap();
  await page.waitForTimeout(300);
  check('Mind write: the box stays unticked while it asks', !(await box.isChecked()) || await sheet.isVisible());
  await sheet.locator('[data-ask="no"]').tap();
  await page.waitForTimeout(350);
  check('Mind write: KEEP IT leaves the box unticked', !(await box.isChecked()));
  check('Mind write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function goLive(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#mind');
  await page.waitForTimeout(1200);
  const status = () => page.evaluate(async () => (await (await fetch('/api/mind/status')).json()));
  const st = await status();
  check('GO LIVE: the mind skill is on, OWNER_JIDS set, mode shadow', st.enabled === true && st.ownerJidsSet === true && st.proactiveMode === 'shadow', JSON.stringify({ enabled: st.enabled, owner: st.ownerJidsSet, mode: st.proactiveMode, available: st.available }));
  const bodies = [];
  page.on('request', (r) => { if (r.url().includes('/api/mind/proactive/mode')) bodies.push(r.postData()); });
  await page.locator('[data-fold="mind.proactive"] summary .fold-mark').tap();
  await page.waitForTimeout(250);
  const live = page.locator('[data-mode="live"]');
  const sheet = page.locator('dialog.sheet');
  await live.tap();
  await page.waitForTimeout(350);
  check('GO LIVE: the sheet opens and nothing is sent yet', await sheet.isVisible() && (await sheet.innerText()).includes('Go LIVE?') && bodies.length === 0);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'golive-sheet-390.png') });
  check('GO LIVE: focus starts on the safe choice', await page.evaluate(() => document.activeElement?.dataset?.ask === 'no'));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(350);
  check('GO LIVE: Enter on it answers no, nothing sent', await sheet.count() === 0 && bodies.length === 0);
  await live.tap();
  await page.waitForTimeout(350);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('GO LIVE: Escape does nothing: still asking, nothing sent', await sheet.isVisible() && bodies.length === 0);
  await page.touchscreen.tap(195, 12);
  await page.waitForTimeout(300);
  check('GO LIVE: a tap on the scrim does nothing', await sheet.isVisible() && bodies.length === 0);
  check('GO LIVE: no CLOSE and no drag handle while it asks', await sheet.locator('.sheet-close').isHidden() && await sheet.locator('.sheet-grab').isHidden());
  await sheet.locator('[data-ask="no"]').tap();
  await page.waitForTimeout(350);
  check('GO LIVE: KEEP IT sends nothing and leaves the mode', bodies.length === 0 && (await status()).proactiveMode === 'shadow');
  const refused = await page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('csrf_token='))?.split('=')[1];
    const r = await fetch('/api/mind/proactive/mode', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: JSON.stringify({ mode: 'live' }) });
    return r.status;
  });
  check('GO LIVE: the route itself refuses live with no confirm', refused === 400, String(refused));
  check('GO LIVE: …and the mode is unchanged', (await status()).proactiveMode === 'shadow');
  bodies.length = 0;
  await live.tap();
  await page.waitForTimeout(350);
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(1200);
  check('GO LIVE: confirmed, exactly one request, carrying confirm:true', bodies.length === 1 && JSON.stringify(JSON.parse(bodies[0])) === '{"mode":"live","confirm":true}', JSON.stringify(bodies));
  const after = await status();
  check('GO LIVE: the mode is live', after.proactiveMode === 'live', after.proactiveMode);
  const audit = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=5')).json()));
  check('GO LIVE: audited mind.proactive.mode, target live', /"action":"mind\.proactive\.mode","target":"live"/.test(audit), audit.slice(0, 140));
  bodies.length = 0;
  await page.locator('[data-mode="shadow"]').tap();
  await page.waitForTimeout(900);
  check('GO LIVE: back to shadow needs no question, sends no confirm', bodies.length === 1 && JSON.stringify(JSON.parse(bodies[0])) === '{"mode":"shadow"}' && (await status()).proactiveMode === 'shadow', JSON.stringify(bodies));
  check('GO LIVE: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function dialogs(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#groups');
  await page.waitForTimeout(500);
  const dlgs = [];
  page.on('dialog', (d) => { dlgs.push(d.message()); d.dismiss(); });
  const posts = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/') && !r.url().endsWith('/api/login')) posts.push([r.method(), r.url().replace(base, ''), r.postData()]); });
  const sheet = page.locator('dialog.sheet');
  const audit = () => page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=8')).json()));

  // The same drill for anything destructive or that really sends: the question stands until
  // one of its two buttons answers; only the confirm sends, and sends what it always sent.
  async function drill(name, open, want) {
    posts.length = 0;
    await open();
    await page.waitForTimeout(350);
    const asked = await sheet.isVisible();
    const focus = await page.evaluate(() => document.activeElement?.dataset?.ask === 'no');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const afterEsc = await sheet.isVisible();
    await page.touchscreen.tap(195, 10);
    await page.waitForTimeout(200);
    const afterScrim = await sheet.isVisible();
    check(`${name}: asks, focus on the safe choice, Escape and the scrim do nothing, nothing sent`, asked && focus && afterEsc && afterScrim && !posts.length, JSON.stringify({ asked, focus, afterEsc, afterScrim, posts }));
    await sheet.locator('[data-ask="no"]').tap();
    await page.waitForTimeout(350);
    check(`${name}: KEEP IT sends nothing`, await sheet.count() === 0 && !posts.length, JSON.stringify(posts));
    await open();
    await page.waitForTimeout(350);
    await sheet.locator('button[type="submit"]').tap();
    await page.waitForTimeout(1200);
    const hit = posts.filter(([, u]) => u.includes(want.path));
    check(`${name}: the confirm sends one ${want.method} ${want.path}, same body as before`, hit.length === 1 && hit[0][0] === want.method && (want.body === undefined || JSON.stringify(JSON.parse(hit[0][2] || 'null')) === JSON.stringify(want.body)), JSON.stringify(posts));
  }

  const ids = await firstIds(page);
  const everyone = await page.evaluate(async () => { const p = await (await fetch('/api/people')).json(); return (p.people ?? p.rows ?? p).map((x) => x.jid); });
  const victim = everyone[everyone.length - 1];

  // Group: a real send to the fake socket.
  await go(page, `#group/${encodeURIComponent(ids.group)}`);
  await page.waitForTimeout(600);
  const sent = () => serverOut.join('').split('\n').filter((l) => l.startsWith('SENT '));
  await page.locator('#gdForceText').fill('see you all at eight');
  await page.locator('#gdForce').tap();
  await page.waitForTimeout(1500);
  check('Group: FORCE REPLY with exact text reaches the fake socket', sent().some((l) => l.includes(ids.group) && l.includes('"text"')), sent().join(' ').slice(-120));
  await page.locator('#gdSendSticker').tap();
  await page.waitForTimeout(2500);
  check('Group: SEND STICKER reaches the fake socket', sent().some((l) => l.includes('"sticker"')), sent().join(' ').slice(-160));
  await page.locator('#gdSendGif').tap();
  await page.waitForTimeout(2500);
  check('Group: SEND GIF reaches the fake socket', sent().some((l) => l.includes('"video"')), sent().join(' ').slice(-160));

  // Contact: widen who may hear, the public site, PURGE.
  await go(page, `#person/${encodeURIComponent(ids.person)}`);
  await page.waitForTimeout(700);
  await page.locator('[data-fold="person.edit"] summary .fold-mark').tap();
  await page.waitForTimeout(200);
  await page.locator('#pdEditForm select[name="visibility"]').selectOption('everywhere');
  await drill('Contact widen', () => page.locator('#pdEditForm button[type="submit"]').tap(), { method: 'PATCH', path: '/api/people/', body: { visibility: 'everywhere' } });
  await page.locator('[data-fold="person.edit"] summary .fold-mark').tap().catch(() => {});
  await page.locator('[data-fold="person.public"] summary .fold-mark').tap();
  await page.waitForTimeout(200);
  await page.locator('#pdPublicForm input[name="optedIn"]').check();
  await page.locator('#pdPublicForm input[name="displayName"]').fill('Av');
  await drill('Contact public site', () => page.locator('#pdPublicForm button[type="submit"]').tap(), { method: 'PUT', path: '/api/public/people/', body: { optedIn: true, displayName: 'Av' } });
  await go(page, `#person/${encodeURIComponent(victim)}`);
  await page.waitForTimeout(700);
  await page.locator('[data-fold="person.forget"] summary .fold-mark').tap();
  await page.waitForTimeout(200);
  const theirs = () => page.evaluate(async (j) => { const m = await (await fetch('/api/memories?limit=300')).json(); return (m.memories ?? m.rows ?? m).filter((x) => x.subject_jid === j).length; }, victim);
  const had = await theirs();
  await drill('Contact PURGE', () => page.locator('#pdPurge').tap(), { method: 'POST', path: '/purge', body: { confirm: true } });
  const left = await theirs();
  check('Contact PURGE: audited, and the memories about them are gone', (await audit()).includes('purge') && had > 0 && left === 0, `${had} → ${left}`);

  // Memories: widen a note, delete it.
  await go(page, '#memories');
  await page.waitForTimeout(700);
  await page.locator('#memAddBtn').tap();
  await page.waitForTimeout(200);
  const form = page.locator('#memAddForm');
  await form.locator('input[name="subject_jid"]').fill(ids.person);
  await form.locator('input[name="content"]').fill('a note to widen');
  await form.locator('button[type="submit"]').tap();
  await page.waitForTimeout(900);
  const row = page.locator('table.data tr', { hasText: 'a note to widen' });
  await drill('Memories widen', () => row.locator('.mem-vis').selectOption('everywhere'), { method: 'PATCH', path: '/api/memories/', body: { visibility: 'everywhere' } });
  await drill('Memories DEL', () => page.locator('table.data tr', { hasText: 'a note to widen' }).locator('.mem-del').tap(), { method: 'DELETE', path: '/api/memories/' });
  check('Memories: the note is gone', await page.locator('table.data tr', { hasText: 'a note to widen' }).count() === 0);

  // Bills: expire the open one.
  await go(page, '#bills');
  await page.waitForTimeout(700);
  await page.locator('table.data tbody tr').first().tap().catch(() => {});
  await page.waitForTimeout(600);
  await drill('Bills EXPIRE', () => page.locator('[data-bill-expire]').first().tap(), { method: 'POST', path: '/expire', body: {} });
  const billState = await page.evaluate(async () => { const b = await (await fetch('/api/bills?limit=20')).json(); return (b.bills ?? b.rows ?? b).find((x) => x.id === 1)?.state; });
  check('Bills: it is expired, audited', /EXPIRED/i.test(String(billState)) && (await audit()).includes('bill.expire'), String(billState));

  // Instagram: SEND asks first (no phone here, so the route answers with an error, shown as a toast).
  await go(page, '#instagram');
  await page.waitForTimeout(900);
  await drill('Instagram SEND', () => page.locator('.ig-approve').first().tap(), { method: 'POST', path: '/approve' });
  await page.locator('#igAllowShare').check();
  await drill('Instagram ALLOW SHARING', () => page.locator('#igBrowse').tap(), { method: 'POST', path: '/api/instagram/browse' });
  await page.locator('#igAllowShare').uncheck();
  posts.length = 0;
  await page.locator('.ig-veto').last().tap();
  await page.waitForTimeout(800);
  const shareState = await page.evaluate(async () => (await (await fetch('/api/instagram/queue')).json()).find((r) => r.id === 2)?.shareState);
  check('Instagram: with no phone the SEND is recorded as approved, not sent, and stays in the queue for a retry', ['approved', 'failed'].includes(shareState) && !serverOut.join('').includes('instagram.sent'), String(shareState));
  check('Instagram: VETO is a real write, no question as before', posts.some(([, u]) => u.includes('/veto')) && (await audit()).includes('veto'), JSON.stringify(posts).slice(0, 160));

  // Public site: TAKE OFFLINE (no bucket here: local only).
  await go(page, '#public');
  await page.waitForTimeout(900);
  await drill('Public TAKE OFFLINE', () => page.locator('#psTakedown').tap(), { method: 'POST', path: '/api/public/takedown', body: { confirm: true } });
  check('Public: audited public.takedown', (await audit()).includes('public.takedown'), (await audit()).slice(0, 120));

  // Identity: not destructive, Escape cancels. A real save writes this worktree's gitignored file, removed after.
  await go(page, '#identity');
  await page.waitForTimeout(700);
  const editor = page.locator('#idEditor');
  const original = await editor.inputValue();
  await editor.fill(`${original}\nA line to discard.`);
  await page.locator('#idDiscard').tap();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  check('Identity: Escape keeps your text', (await editor.inputValue()).includes('A line to discard') && await sheet.count() === 0);
  await page.locator('#idDiscard').tap();
  await page.waitForTimeout(300);
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(350);
  check('Identity: DISCARD goes back to the saved text', (await editor.inputValue()) === original);
  const idFile = path.join(ROOT, 'src/personality/identity.md');
  if (!fs.existsSync(idFile) && ROOT.includes('karyasthan-wt-')) {
    await editor.fill(`${original}\nA saved line.`);
    posts.length = 0;
    await page.locator('#idSave').tap();
    await page.waitForTimeout(900);
    check('Identity: SAVE writes, audited', posts.some(([m, u]) => m === 'PUT' && u.includes('/api/identity')) && (await audit()).includes('identity.put'), JSON.stringify(posts).slice(0, 120));
    fs.rmSync(idFile, { force: true });
  } else console.log('INFO  identity.md exists here: SAVE not exercised');

  // Settings: add a model.
  await go(page, '#settings');
  await page.waitForTimeout(800);
  await page.locator('[data-fold="settings.roles"] summary .fold-mark').tap();
  await page.waitForTimeout(250);
  posts.length = 0;
  await page.locator('#rolesTable tr.is-focus .role-addmodel').first().tap();
  await page.waitForTimeout(300);
  await sheet.locator('input[name="reason"]').fill('a-model-id');
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(800);
  check('Settings: + adds a model from the sheet', posts.some(([m, u, b]) => m === 'POST' && u.includes('/api/llm/models') && b.includes('a-model-id')), JSON.stringify(posts).slice(0, 160));
  await page.locator('#rolesTable tr.is-focus .role-addmodel').first().tap();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  check('Settings: that question is no danger: Escape closes it', await sheet.count() === 0);

  check('No browser dialog appeared anywhere on these pages', !dlgs.length, dlgs.join(' | '));
  check('Dialogs: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

const FAKE_LIVE = { active: true, mode: 'full', phaseWords: 'settling in', minutesLeft: 70, them: [{ name: 'Avery', mood: 'laughing' }], attention: { band: 'high' }, line: { at: '20:14', parts: ['the cafe', 'talking about her new job', "she's laughing", 'his phone buzzed, he put it face down'] } };
const FAKE_THOUGHTS = { running: true, count: 3, thoughts: [{ at: 1793620000, kind: 'body', text: 'starving' }, { at: 1793621000, kind: 'feeling', text: 'something off about today' }, { at: 1793622000, kind: 'thought', text: 'just go', fromChat: true }] };
const FAKE_ALERTS = { running: true, lastRunAt: 1793622000, count: 2, ruleErrors: [], corrupt: false, findings: [{ fp: 'a'.repeat(32), rule: 'spend_once', severity: 'high', at: 1793620000, eventIds: [5, 6], text: 'A dinner was paid for twice on Saturday.' }, { fp: 'b'.repeat(32), rule: 'text_plan', severity: 'warn', at: 1793621000, eventIds: [9], text: 'A plan agreed in texts has no plan.' }] };

async function nowRead(base) {
  for (const [name, device] of [['390', PHONE], ['320', { ...PHONE, viewport: { width: 320, height: 568 } }], ['landscape', { ...PHONE, viewport: { width: 844, height: 390 } }], ['1440', DESK]]) {
    const ctx = await browser.newContext({ ...device, httpCredentials: { username: 'admin', password: 'preview' } });
    await ctx.route('**/api/life/live', (r) => r.fulfill({ json: FAKE_LIVE }));
    await ctx.route('**/api/life/thoughts*', (r) => r.fulfill({ json: FAKE_THOUGHTS }));
    await ctx.route('**/api/life/alerts', (r) => r.fulfill({ json: FAKE_ALERTS }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#life`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.v-live', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, h: document.documentElement.scrollHeight, live: !!document.querySelector('.v-live'), alerts: document.querySelectorAll('.v-alert').length, stream: document.querySelectorAll('.v-stream-row').length }));
    check(`Now ${name}: fits, with the live line, plot holes and stream showing`, m.over <= 0 && m.live && m.alerts === 2 && m.stream === 3 && !errors.length, JSON.stringify(m) + (errors[0] || ''));
    if (OUT) await page.screenshot({ path: path.join(OUT, `now-${name}.png`) });
    if (device.isMobile) {
      await page.evaluate(() => window.scrollTo(0, 700));
      await page.waitForTimeout(200);
      const st = await page.evaluate(() => { const l = document.querySelector('.v-live').getBoundingClientRect(); const t = document.querySelector('.topbar').getBoundingClientRect(); return { top: l.top, bar: t.bottom }; });
      check(`Now ${name}: the live line stays under the topbar`, Math.abs(st.top - st.bar) <= 2, JSON.stringify(st));
      if (name === '390') {
        check('Now: decisions, commitments, claims and chats fold on a phone', await page.locator('details[data-fold^="now."][open]').count() === 0 && await page.locator('details[data-fold^="now."]').count() === 4);
        check('Now 390: the page is short enough to scan (it was 2,257 px with less on it)', m.h < 2300, `${m.h} px`);
        const nextRow = await page.evaluate(() => { const r = document.querySelector('.ln-next tbody tr'); return r ? r.getBoundingClientRect().height : 0; });
        check('Now: a next block is a compact row', nextRow > 0 && nextRow < 70, String(nextRow));
      }
    }
    await ctx.close();
  }
  // The real panels, no fakes: a poll with nothing new leaves an open picker alone.
  const { ctx, page, errors } = await open(DESK, base, '#life');
  await page.waitForTimeout(800);
  await page.evaluate(() => { const b = document.querySelector('[data-slot="ln-vitals"]'); if (b) b.dataset.mark = '1'; const n = document.querySelector('[data-slot="ln-queue"] tr'); if (n) n.dataset.mark = '1'; });
  await page.waitForTimeout(31_000);
  check('Now: a poll with nothing new repaints nothing', (await page.evaluate(() => document.querySelector('[data-slot="ln-queue"] tr')?.dataset.mark)) === '1');
  check('Now desktop: its folds are open', await page.locator('details[data-fold^="now."]:not([open])').count() === 0);
  check('Now: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

async function nowWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life');
  await page.waitForTimeout(800);
  const audit = () => page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=6')).json()));
  await page.locator('#lnAlertsRun').tap();
  await page.waitForTimeout(1200);
  check('Now write: SWEEP NOW runs, audited', (await audit()).includes('life.alert.run'), (await audit()).slice(0, 120));
  await page.locator('#lnCheckPhone').tap();
  await page.waitForTimeout(1500);
  check('Now write: CHECK PHONE NOW, audited', (await audit()).includes('life.phone.check'), (await audit()).slice(0, 120));
  await page.locator('[data-fold="now.decisions"] summary .fold-mark').tap();
  await page.waitForTimeout(250);
  const mode = page.locator('.ln-mode').first();
  if (await mode.count()) {
    const next = (await mode.inputValue()) === 'ask' ? 'auto' : 'ask';
    await mode.selectOption(next);
    await page.waitForTimeout(900);
    check('Now write: a decision\'s mode changes, audited', (await audit()).includes('life.decision.mode'), (await audit()).slice(0, 120));
  } else console.log('INFO  no open decision in this world: mode not exercised');
  check('Now write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();
}

const FAKE_DEED = { running: true, rows: [
  { id: 7, at: 1793620000, label: 'Coffee with Avery', text: 'leaning stay (0.72)… went anyway (deadline draw)', against: true, fromChat: false, chatNudged: false, spansDays: false, leanCount: 2, deed: { at: 1793620000 }, leans: [{ at: 1793610000, optionId: 'go', p: 0.5 }, { at: 1793615000, optionId: 'stay', p: 0.72 }] },
  { id: 8, at: 1793620000, label: 'a plan from a chat', text: 'no lean… expired: he never answered', against: false, fromChat: true, chatNudged: false, spansDays: false, leanCount: 0, deed: { at: null }, leans: [] },
] };
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function dayRead(base) {
  const device = (d) => browser.newContext({ ...d, httpCredentials: { username: 'admin', password: 'preview' } });
  const ctx = await device(PHONE);
  await ctx.route('https://tiles.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
  await ctx.route('**/api/life/thought-deed*', (r) => r.fulfill({ json: FAKE_DEED }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#life/day`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ld-row', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  check('Day: vitals, thoughts, thought vs deed and the map fold on a phone', await page.locator('details[data-fold^="day."]').count() === 4 && await page.locator('details[data-fold^="day."][open]').count() === 0);
  check('Day: it lands on the now line', await page.evaluate(() => { const r = document.getElementById('ldNowLine')?.getBoundingClientRect(); return !!r && r.top > 0 && r.bottom < innerHeight; }));
  if (OUT) await page.screenshot({ path: path.join(OUT, 'day-390.png') });
  const row = page.locator('.ld-row.is-click').first();
  await row.scrollIntoViewIfNeeded();
  await row.tap();
  await page.waitForTimeout(700);
  check('Day: a tapped row opens WHY in its sheet', await page.locator('.ld-side.is-open .life-chain li').count() >= 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Day: Escape closes it and focus goes back to a row', await page.locator('.ld-side.is-open').count() === 0 && await page.evaluate(() => !!document.activeElement?.closest?.('.ld-row')), await page.evaluate(() => document.activeElement?.className || ''));
  await page.locator('.ld-row.is-click').first().tap();
  await page.waitForTimeout(350);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(250);
  check('Day: turned sideways, nothing stays held', await page.evaluate(() => !document.querySelector('.topbar').closest('[inert]') && !document.documentElement.classList.contains('ld-side-open') && !document.querySelector('.ld-side.is-open')));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);

  // Timeline: the lane names stay, the ribbon's events stay tappable under them.
  await go(page, '#life/timeline');
  await page.waitForTimeout(700);
  const lanes = (at) => page.evaluate((left) => {
    const box = document.querySelector('.life-ribbon-wrap');
    box.scrollLeft = left === 'end' ? box.scrollWidth : 0;
    const b = box.getBoundingClientRect();
    return new Promise((res) => requestAnimationFrame(() => res([...document.querySelectorAll('.lt-labels text')].map((t) => t.getBoundingClientRect()).every((r) => r.left >= b.left - 1 && r.right <= b.right + 1 && r.width > 0))));
  }, at);
  check('Timeline: lane names in view at the latest hours (where it opens)', await lanes('end'));
  check('Timeline: …and at the earliest', await lanes('start'));
  await lanes('start');
  const ticks = await page.evaluate(() => { const all = [...document.querySelectorAll('.lt-tick-label')].map((t) => t.getBoundingClientRect()); const l = document.querySelector('.lt-labels').getBoundingClientRect(); const m = document.querySelector('.lt-ribbon-grid > svg:not(.lt-labels)').getBoundingClientRect(); return [all[0].left >= l.right - 1, all.at(-1).right <= m.right + 1]; });
  check('Timeline: the first and last hour labels are whole', ticks.every(Boolean), ticks.join());
  const aligned = await page.evaluate(() => { const m = document.querySelector('.lt-ribbon-grid > svg:not(.lt-labels)').getBoundingClientRect(); const l = document.querySelector('.lt-labels').getBoundingClientRect(); return [Math.abs(m.height - l.height) < 2, Math.abs(l.width - m.width * 0.078) < 2]; });
  check('Timeline: both layers keep one scale', aligned.every(Boolean), aligned.join());
  await page.evaluate(() => { document.querySelector('.life-ribbon-wrap').scrollLeft = 300; });
  const under = await page.evaluate(() => { const l = document.querySelector('.lt-labels').getBoundingClientRect(); return document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2)?.closest?.('.lt-labels') === null; });
  check('Timeline: the names let taps through', under);
  if (OUT) await page.screenshot({ path: `${OUT}/timeline-lanes-390.png` });
  // Any sheet, on a scrolled page: the sticky bar stays (html's overflow used to make body its scroller).
  await page.evaluate(() => window.scrollTo(0, 300));
  const stuck = await page.evaluate(async () => {
    const { openSheet } = await import('/js/components/sheet.js');
    const before = scrollY;
    const s = openSheet({ label: 'probe', content: 'x' });
    await new Promise((r) => setTimeout(r, 100));
    const top = document.getElementById('menuToggle').getBoundingClientRect().top;
    s.close({ now: true });
    return [before > 0, top === 0, scrollY === before];
  });
  check('a sheet on a scrolled page: the topbar stays, the scroll is kept', stuck.every(Boolean), stuck.join());
  await page.evaluate(() => window.scrollTo(0, 0));
  await go(page, '#life/day');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  await page.locator('[data-fold="day.deed"] summary .fold-mark').tap();
  await page.waitForTimeout(300);
  const two = page.locator('[data-slot="ld-td"] .v-two');
  check('Day: thought vs deed side by side: leaned, did, marked when against his lean', await two.count() === 2 && (await two.first().innerText()).includes('leaning stay') && (await two.first().innerText()).includes('went anyway') && await page.locator('.v-two.is-differs').count() === 1);
  check('Day: …the lean history stays', (await two.first().innerText()).includes('LEANS'));
  if (OUT) { await two.first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, 'day-deed-390.png') }); }
  await page.locator('[data-fold="day.deed"] summary .fold-mark').tap();
  await page.locator('[data-fold="day.map"] summary .fold-mark').tap();
  await page.waitForTimeout(900);
  const map = await page.evaluate(() => { const c = document.querySelector('[data-fold="day.map"] .leaflet-container'); const r = c?.getBoundingClientRect(); return { on: !!c, w: r?.width, h: r?.height, tiles: c?.querySelectorAll('img.leaflet-tile').length }; });
  check('Day: a map that mounted folded gets its size when the fold opens', map.on && map.w > 200 && map.h > 100 && map.tiles > 0, JSON.stringify(map));
  if (OUT) { await page.locator('[data-fold="day.map"]').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, 'day-map-390.png') }); }
  await page.locator('[data-fold="day.map"] summary .fold-mark').tap();
  for (const [w, h] of [[320, 568], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`Day ${w}x${h}: no sideways scroll`, over <= 0, String(over));
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // Timeline
  await go(page, '#life/timeline');
  await page.waitForTimeout(1200);
  const nav = await page.evaluate(() => ['ltPrev', 'ltNow', 'ltNext'].map((id) => document.getElementById(id).getBoundingClientRect().top));
  check('Timeline: its three buttons share a row', nav[0] === nav[1] && nav[1] === nav[2], JSON.stringify(nav));
  check('Timeline: the legend folds on a phone', await page.locator('[data-fold="timeline.legend"]').getAttribute('open') === null);
  const box = await page.evaluate(() => { const b = document.querySelector('.life-ribbon-wrap'); return { x: b.scrollLeft, can: b.scrollWidth > b.clientWidth, over: document.documentElement.scrollWidth - innerWidth }; });
  check('Timeline: the ribbon scrolls in its box, starting at the latest hours', box.can && box.x > 0 && box.over <= 0, JSON.stringify(box));
  if (OUT) await page.screenshot({ path: path.join(OUT, 'timeline-390.png') });
  await page.evaluate(() => { document.querySelector('.life-ribbon-wrap').scrollLeft = 10; });
  await page.waitForTimeout(31_000);
  check('Timeline: a poll leaves your scroll alone', (await page.evaluate(() => document.querySelector('.life-ribbon-wrap').scrollLeft)) === 10);
  await page.locator('.life-evline').first().tap();
  await page.waitForTimeout(700);
  check('Timeline: a tapped event opens its chain in a sheet', await page.locator('dialog.sheet .life-chain li').count() >= 1);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'timeline-chain-390.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  check('Timeline: Escape closes it, and leaves the page where it was', await page.locator('dialog.sheet').count() === 0);
  check('Day + Timeline: no page errors', !errors.length, errors[0] || '');
  await ctx.close();

  // Desktop
  const dctx = await device(DESK);
  await dctx.route('https://tiles.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
  const d = await dctx.newPage();
  await d.goto(`${base}/#life/day`, { waitUntil: 'domcontentloaded' });
  await d.waitForSelector('.ld-row', { timeout: 20000 }).catch(() => {});
  await d.waitForTimeout(1200);
  const dm = await d.evaluate(() => {
    const list = document.querySelector('.ld-rows');
    const box = list.getBoundingClientRect();
    const now = list.querySelector('#ldNowLine')?.getBoundingClientRect();
    // Just past midnight NOW is at the top with nowhere to scroll: what counts is that it's in view.
    return { y: scrollY, nowInView: !!now && now.top >= box.top - 1 && now.bottom <= box.bottom + 1, open: document.querySelectorAll('details[data-fold^="day."][open]').length };
  });
  check('Day desktop: folds open; the list moves to now, the page under you does not', dm.y === 0 && dm.nowInView && dm.open === 4, JSON.stringify(dm));
  if (OUT) await d.screenshot({ path: path.join(OUT, 'day-1440.png') });
  await d.evaluate(() => { location.hash = '#life/timeline'; });
  await d.waitForTimeout(1200);
  await d.locator('.life-evline').first().click();
  await d.waitForTimeout(700);
  check('Timeline desktop: the chain stays in its panel, no sheet', await d.locator('[data-slot="lt-detail"] .life-chain li').count() >= 1 && await d.locator('dialog.sheet').count() === 0);
  if (OUT) await d.screenshot({ path: path.join(OUT, 'timeline-1440.png') });
  await dctx.close();
}

async function dayWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/timeline');
  await page.waitForTimeout(1200);
  const audit = () => page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=6')).json()));
  const sheet = page.locator('dialog.sheet');
  // A real revert, from the chain's sheet: the first event that offers one.
  const lines = page.locator('.life-evline');
  const count = await lines.count();
  let reverted = false;
  for (let i = 0; i < Math.min(count, 30) && !reverted; i++) {
    await lines.nth(i).tap();
    await page.waitForTimeout(500);
    if (await sheet.locator('#ltRevertForm').count()) {
      await sheet.locator('#ltReason').fill('checking');
      await sheet.locator('#ltRevertForm button[type="submit"]').tap();
      await page.waitForTimeout(1200);
      reverted = true;
      check('Timeline write: REVERT from the sheet, audited, the sheet says so', (await audit()).includes('life.revert') && (await sheet.innerText()).includes('REVERTED'), (await audit()).slice(0, 120));
    } else {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  }
  if (!reverted) console.log('INFO  nothing revertible in the first events');
  if (await sheet.count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }

  // A real write on Day: a scene's words, from its ❖ chip, on whichever day has one.
  let edited = false;
  for (let back = 0; back < 3 && !edited; back++) {
    const date = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    await go(page, `#life/day/${date}`);
    await page.waitForSelector('.ld-row', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const chip = page.locator('.ld-row [data-scene]').first();
    if (!await chip.count()) continue;
    await chip.scrollIntoViewIfNeeded();
    await chip.tap();
    await page.waitForTimeout(800);
    const side = page.locator('.ld-side.is-open');
    const edit = side.getByRole('button', { name: /EDIT/ }).first();
    if (await edit.count()) {
      await edit.tap();
      await page.waitForTimeout(250);
      await side.locator('textarea').first().fill('They stayed longer than they meant to, and neither of them minded at all.');
      await side.getByRole('button', { name: /SAVE/ }).first().tap();
      await page.waitForTimeout(900);
      check('Day write: a scene edited from its chip, audited', (await side.innerText()).includes('neither of them minded') && (await audit()).includes('arcs.scene'), (await audit()).slice(0, 120));
      edited = true;
    }
  }
  if (!edited) console.log('INFO  no scene on the last three days: Day write not exercised');
  check('Day write: no page errors', !errors.length, errors[0] || '');
  await ctx.close();

  // Now: REVERT of a chat influence asks first; the Decisions fold follows a waiting decision.
  const c2 = await browser.newContext({ ...PHONE, httpCredentials: { username: 'admin', password: 'preview' } });
  let inject = true;
  await c2.route('**/api/influence/now', async (r) => { const res = await r.fetch(); const b = await res.json(); b.running = true; b.skill = true; b.blips = [{ affect: 'annoyed', chatName: 'Weekend crew', ageMin: 5, valence: -0.1, pointerId: 987654 }]; await r.fulfill({ response: res, json: b }); });
  await c2.route('**/api/life/now', async (r) => { const res = await r.fetch(); const b = await res.json(); if (inject) b.decisions = [{ id: 41, kind: 'dinner', status: 'open', mode: 'auto', decideBy: Math.floor(Date.now() / 1000) + 3600, subject: {} }]; else b.decisions = []; await r.fulfill({ response: res, json: b }); });
  const p2 = await c2.newPage();
  const posts = [];
  p2.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/revert')) posts.push(r.postData()); });
  await p2.goto(`${base}/#life`, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.ln-next', { timeout: 15000 }).catch(() => {});
  await p2.waitForTimeout(1200);
  const fold = p2.locator('[data-fold="now.decisions"]');
  check('Now: with a decision waiting on its deadline its fold is open on a phone', await fold.getAttribute('open') !== null);
  await p2.locator('[data-fold="now.chats"] summary .fold-mark').tap();
  await p2.waitForTimeout(250);
  await p2.locator('.ln-inf-revert').first().tap();
  await p2.waitForTimeout(350);
  const s2 = p2.locator('dialog.sheet');
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(200);
  check('Now: REVERT of a chat influence asks first; Escape does nothing, nothing sent', await s2.isVisible() && !posts.length);
  await s2.locator('[data-ask="no"]').tap();
  await p2.waitForTimeout(350);
  check('Now: KEEP IT sends nothing', await s2.count() === 0 && !posts.length);
  await p2.locator('.ln-inf-revert').first().tap();
  await p2.waitForTimeout(350);
  await s2.locator('button[type="submit"]').tap();
  await p2.waitForTimeout(800);
  check('Now: confirmed, one revert with the same reason as before', posts.length === 1 && JSON.parse(posts[0]).reason === 'owner: undo a chat influence (Life · Now)', JSON.stringify(posts));
  inject = false;
  await p2.waitForTimeout(31_000);
  check('Now: with none waiting any more the fold closes', await fold.getAttribute('open') === null);
  await c2.close();
}

// Director, Story, Pending, Journal: one section at a time on a phone, forms survive a switch and
// a poll, a preset reveals its section, and every question is a sheet that sends what it always sent.
const DIR_SECTIONS = ['tell', 'day', 'build', 'god', 'controls', 'all'];
const visiblePanels = (page) => page.evaluate(() => [...document.querySelectorAll('.ld-dir .panel-head > span:first-child')]
  .filter((n) => n.getBoundingClientRect().height > 0).map((n) => n.textContent.replace(/\?/g, '').trim().replace(/^\/\/ /, '').split(' · ')[0]));
const seg = (page, k) => page.locator(`[data-slot="ld-seg"] [data-seg="${k}"]`);

async function directorRead(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/director');
  await page.waitForTimeout(800);
  const on = () => page.evaluate(() => document.querySelector('.ld-dir').dataset.show);
  check('director: a phone opens on TELL', await on() === 'tell', await on());
  const seen = {};
  for (const k of DIR_SECTIONS) {
    await seg(page, k).tap();
    await page.waitForTimeout(150);
    seen[k] = await visiblePanels(page);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`  ${k.padEnd(9)} ${String(h).padStart(6)} px  ${seen[k].join(' | ')}`);
    check(`director ${k}: no sideways page scroll at 390`, over <= 0, String(over));
  }
  check('director: TELL holds the story only', seen.tell.length === 1 && /TELL THE STORY/.test(seen.tell[0]), seen.tell.join());
  check('director: DAY holds quick, tomorrow, schedule', ['QUICK', 'PREVIEW TOMORROW', 'SCHEDULE'].every((n) => seen.day.includes(n)) && seen.day.length === 3, seen.day.join());
  check('director: BUILD holds the forms that make things', ['SCENE', 'WEATHER', 'GOALS', 'PLACES', 'EDIT CAST', 'REWRITE THE PAST'].every((n) => seen.build.includes(n)), seen.build.join());
  check('director: GOD holds play god', seen.god.length === 1 && /PLAY GOD/.test(seen.god[0]), seen.god.join());
  check('director: CONTROLS holds the switches', ['FATE', 'PINS', 'CLAIM TRAY', 'SUGGESTIONS FROM CHATS', 'REWIND', 'BOOKMARKS', 'SEED', 'REFUSALS'].every((n) => seen.controls.includes(n)), seen.controls.join());
  const union = new Set(['tell', 'day', 'build', 'god', 'controls'].flatMap((k) => seen[k]));
  check('director: every panel is in a section', seen.all.every((n) => union.has(n)), seen.all.filter((n) => !union.has(n)).join());
  check('director: all panels in ALL', seen.all.length === union.size, `${seen.all.length} vs ${union.size}`);

  // Remembered per browser; a deep link opens a section without changing what is remembered.
  await seg(page, 'build').tap();
  await go(page, '#life/story');
  await go(page, '#life/director');
  check('director: the section is remembered', await on() === 'build', await on());
  await go(page, '#life/director/god');
  check('director: a deep link opens its section', await on() === 'god', await on());
  check('director: …without changing what is remembered', await page.evaluate(() => localStorage.getItem('ld.director.seg')) === 'build');
  await go(page, '#life/director/nonsense');
  check('director: an unknown section falls back', await on() === 'build', await on());

  check('director: phone read: no errors', !errors.length, errors.join(' | '));
  await ctx.close();

  // Narrow, sideways, desktop; storage that throws.
  for (const [label, dev, wantDefault] of [['320', { ...PHONE, viewport: { width: 320, height: 568 } }, 'tell'], ['landscape', { ...PHONE, viewport: { width: 844, height: 390 } }, 'tell'], ['1440', { viewport: { width: 1440, height: 900 } }, 'all']]) {
    const o = await open(dev, base, '#life/director');
    await o.page.waitForTimeout(600);
    const first = await o.page.evaluate(() => document.querySelector('.ld-dir').dataset.show);
    check(`director ${label}: opens on ${wantDefault}`, first === wantDefault, first);
    for (const k of DIR_SECTIONS) {
      await seg(o.page, k).click();
      await o.page.waitForTimeout(100);
      const over = await o.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const box = await seg(o.page, k).boundingBox();
      const vw = await o.page.evaluate(() => innerWidth);
      check(`director ${label} ${k}: no sideways scroll, its button in view`, over <= 0 && box.x >= 0 && box.x + box.width <= vw + 1, `${over} ${JSON.stringify(box)}`);
    }
    await seg(o.page, 'controls').click();
    await o.page.waitForTimeout(100);
    const cut = await o.page.locator('.ld-rewind-ev').evaluateAll((ns) => ns.filter((n) => { const r = n.getBoundingClientRect(); const box = n.closest('.story-scroll').getBoundingClientRect(); return r.right > box.right + 1; }).length);
    check(`director ${label}: REWIND HERE is on screen in its list`, cut === 0, String(cut));
    if (OUT) await o.page.screenshot({ path: `${OUT}/director-all-${label}.png` });
    check(`director ${label}: no errors`, !o.errors.length, o.errors.join(' | '));
    await o.ctx.close();
  }
  const blocked = await browser.newContext({ ...PHONE, httpCredentials: { username: 'admin', password: 'preview' } });
  await blocked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  const bp = await blocked.newPage();
  const berr = [];
  bp.on('pageerror', (e) => berr.push(e.message));
  await bp.goto(`${base}/#life/director`);
  await bp.waitForTimeout(1500);
  const bshow = await bp.evaluate(() => document.querySelector('.ld-dir')?.dataset.show);
  if (bshow) { await seg(bp, 'day').tap(); await bp.waitForTimeout(100); }
  check('director: blocked storage still works', !bshow || (await bp.evaluate(() => document.querySelector('.ld-dir').dataset.show)) === 'day', String(bshow));
  await blocked.close();

  // Story, Pending, Journal sit on the phone.
  const s = await open(PHONE, base, '#life/story');
  await s.page.waitForTimeout(700);
  const idle = await s.page.evaluate(() => { const b = document.querySelector('.story-board').getBoundingClientRect().top; return [...document.querySelectorAll('.ls-wait.is-idle')].every((p) => p.getBoundingClientRect().top > b); });
  check('story: a panel with nothing waiting sits under the board', idle);
  const quiet = await s.page.locator('.story-cat.is-quiet').count();
  const lines = await s.page.locator('.story-cat.is-quiet').evaluateAll((ns) => ns.every((n) => n.getBoundingClientRect().height < 64));
  check('story: an empty category is one line', quiet > 0 && lines, String(quiet));
  check('story: no errors', !s.errors.length, s.errors.join(' | '));
  await s.ctx.close();
}

async function directorWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#life/director');
  await page.waitForTimeout(800);
  const dlgs = [];
  page.on('dialog', (d) => { dlgs.push(d.message()); d.dismiss(); });
  const posts = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/') && !r.url().endsWith('/api/login')) posts.push([r.method(), r.url().replace(base, ''), r.postData()]); });
  const sheet = page.locator('dialog.sheet');
  const applied = (path) => posts.filter(([, u]) => u.includes(path));

  // Read-only state aside: the same drill for each question.
  async function drill(name, openIt, wantPath, wantBody = null) {
    await openIt();
    await page.waitForTimeout(350);
    const before = applied(wantPath).length;
    const asked = await sheet.isVisible();
    const focus = await page.evaluate(() => document.activeElement?.dataset?.ask === 'no');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const afterEsc = await sheet.isVisible();
    check(`${name}: a sheet, safe focus, Escape does nothing, nothing sent`, asked && focus && afterEsc && applied(wantPath).length === before, `${asked} ${focus} ${afterEsc}`);
    await sheet.locator('[data-ask="no"]').tap();
    await page.waitForTimeout(350);
    check(`${name}: KEEP sends nothing`, await sheet.count() === 0 && applied(wantPath).length === before);
    await openIt();
    await page.waitForTimeout(350);
    await sheet.locator('button[type="submit"]').tap();
    await page.waitForTimeout(900);
    const sent = applied(wantPath);
    check(`${name}: the confirm sends once`, sent.length === before + 1, JSON.stringify(sent));
    if (wantBody !== null) check(`${name}: same body`, sent.at(-1)?.[2] === wantBody, String(sent.at(-1)?.[2]));
  }

  check('tell: the wish and its button are live once the page has loaded (they stayed disabled)',
    await page.evaluate(() => !document.querySelector('#ldWish').disabled && !document.querySelector('#ldSuggest').disabled));

  // Text typed in one section survives a switch and a real poll.
  await seg(page, 'tell').tap();
  await page.fill('#ldWish', 'he takes the long way home');
  await seg(page, 'build').tap();
  await page.fill('#ldGoal [name="label"]', 'a label I typed');
  await seg(page, 'controls').tap();
  await page.fill('#ldBookmarkName', 'kept');
  await page.locator('[data-slot="ld-events"]').evaluate((n) => { n.closest('.story-scroll').scrollTop = 80; });
  const scrollBefore = await page.locator('[data-slot="ld-events"]').evaluate((n) => n.closest('.story-scroll').scrollTop);
  await page.waitForTimeout(31000);
  const vals = await page.evaluate(() => [document.querySelector('#ldWish').value, document.querySelector('#ldGoal [name="label"]').value, document.querySelector('#ldBookmarkName').value]);
  check('director: typed text survives switches and a poll', vals.join('|') === 'he takes the long way home|a label I typed|kept', vals.join('|'));
  const scrollAfter = await page.locator('[data-slot="ld-events"]').evaluate((n) => n.closest('.story-scroll').scrollTop);
  check('director: a poll leaves the event list where it was', scrollAfter === scrollBefore, `${scrollBefore} → ${scrollAfter}`);

  // A real scene, from BUILD: the preview window, apply, the form resets.
  await seg(page, 'build').tap();
  await page.selectOption('#ldShape', 'cast.beat');
  await page.waitForTimeout(100);
  await page.fill('#ldScene [name="text"]', 'found an old photo');
  await page.locator('#ldScenePreview').tap();
  await page.waitForTimeout(900);
  const modal = page.locator('.story-modal');
  check('write: the scene previews', await modal.isVisible());
  const applyBtn = modal.locator('[data-act="apply"]');
  await applyBtn.tap();
  await page.waitForTimeout(900);
  check('write: the scene applied through the window', await modal.count() === 0 && applied('/api/director/apply').length === 1, JSON.stringify(posts.slice(-2)));

  // Waiting count on the strip, a claim rejected through a sheet (scratch DB, seeded).
  await page.waitForTimeout(100);
  await seg(page, 'controls').tap();
  check('write: the strip counts what waits', /CONTROLS\s*\d/.test(await seg(page, 'controls').innerText()), await seg(page, 'controls').innerText());
  await drill('reject claim', () => page.locator('.ld-reject').first().tap(), '/reject', '{}');

  // Pending: a real pick and a real veto (seeded cards, scratch DB).
  await go(page, '#life/pending');
  await page.waitForTimeout(600);
  const pick = page.locator('.lp-pick:not([disabled])').first();
  check('pending: the seeded card is here', await pick.count() > 0);
  const optionId = await pick.getAttribute('data-option');
  await drill('pick a card', () => page.locator('.lp-pick:not([disabled])').first().tap(), '/pick', JSON.stringify({ optionId }));
  await page.waitForTimeout(400);
  check('pending: the picked card closed', await page.locator('.lp-pick:not([disabled])').count() === 0);
  check('pending: the veto card is here', await page.locator('.lp-veto:not([disabled])').count() > 0);
  await drill('veto a heavy event', () => page.locator('.lp-veto:not([disabled])').first().tap(), '/veto', '{}');
  await page.waitForTimeout(400);
  check('pending: the vetoed card closed', await page.locator('.lp-veto:not([disabled])').count() === 0);

  await go(page, '#life/director');
  // Last of the seeded rows: a rewind sets aside what's after its point, and the seed is recent.
  // A rewrite of the past: the sheet sits above the preview, whose own Escape stays out of it.
  await seg(page, 'build').tap();
  await page.fill('#ldRetconHours', '2');
  await page.selectOption('#ldRetconWhat', 'weather');
  await page.locator('#ldRetconGo').tap();
  await page.waitForTimeout(1500);
  check('retcon: previews', await modal.isVisible());
  const tick = modal.locator('[data-act="tick"]');
  if (await tick.count()) await tick.first().check().catch(() => {});
  const retconApply = modal.locator('[data-act="apply"]');
  await retconApply.tap();
  await page.waitForTimeout(350);
  check('retcon: a sheet asks, above the preview', await sheet.isVisible() && (await sheet.innerText()).includes('never deleted'), await sheet.innerText().catch(() => ''));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('retcon: Escape leaves both open, nothing applied', await sheet.isVisible() && await modal.isVisible() && applied('/api/director/apply').length === 1);
  await sheet.locator('[data-ask="no"]').tap();
  await page.waitForTimeout(350);
  check('retcon: KEEP keeps the preview open, nothing applied', await sheet.count() === 0 && await modal.isVisible() && applied('/api/director/apply').length === 1);
  await retconApply.tap();
  await page.waitForTimeout(350);
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(1500);
  check('retcon: the confirm applies once', await modal.count() === 0 && applied('/api/director/apply').length === 2, JSON.stringify(applied('/api/director/apply')));
  await page.waitForTimeout(400);

  // Tell the story to its end (stubbed mind call), then UNDO ALL.
  await seg(page, 'tell').tap();
  await page.fill('#ldWish', 'it rains for a few hours');
  await page.locator('#ldSuggest').tap();
  await page.waitForTimeout(2200);
  const next = page.locator('.ld-tell-tocheck');
  if (await next.count()) {
    // EDIT sends a draft to its form: the form's section opens; TELL still holds the plan.
    const remembered = await page.evaluate(() => localStorage.getItem('ld.director.seg'));
    await page.locator('.ld-p-edit').first().tap();
    await page.waitForTimeout(500);
    const atForm = await page.evaluate(() => [document.querySelector('.ld-dir').dataset.show, document.querySelector('#ldWeather [name="weatherKind"]').value, document.querySelector('#ldWeather').getBoundingClientRect().height > 0]);
    check('edit a draft: its form\'s section opens, filled in', atForm.join() === 'build,rain,true', atForm.join());
    check('edit a draft: what is remembered doesn\'t change', await page.evaluate(() => localStorage.getItem('ld.director.seg')) === remembered);
    await seg(page, 'tell').tap();
    await page.waitForTimeout(150);
    check('edit a draft: TELL still holds the plan', await next.isVisible());
    await next.first().tap();
    await page.waitForTimeout(1800);
    const makeIt = page.locator('.ld-tell-apply');
    await makeIt.first().tap();
    await page.waitForTimeout(1500);
    const beforeUndo = applied('/api/director/revert-change').length;
    await page.locator('.ld-tell-undo').tap();
    await page.waitForTimeout(800);
    check('undo all: a sheet with what it undoes', await sheet.isVisible() && (await sheet.innerText()).length > 20, await sheet.innerText().catch(() => ''));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('undo all: Escape does nothing', await sheet.isVisible());
    await sheet.locator('[data-ask="no"]').tap();
    await page.waitForTimeout(350);
    const previewsOnly = applied('/api/director/revert-change').length - beforeUndo;
    await page.locator('.ld-tell-undo').tap();
    await page.waitForTimeout(800);
    await sheet.locator('button[type="submit"]').tap();
    await page.waitForTimeout(1500);
    const withPrint = applied('/api/director/revert-change').filter(([, , b]) => /fingerprint/.test(b || ''));
    check('undo all: the confirm reverts with the fingerprint', withPrint.length >= 1 && previewsOnly >= 1, JSON.stringify(withPrint));
  } else {
    check('tell: reached the plan (stubbed mind call)', false, await page.locator('[data-slot="ld-tell-body"]').innerText().catch(() => ''));
  }

  // Story: the proposal waits on top; a real reject.
  await go(page, '#life/story');
  await page.waitForTimeout(500);
  const order = await page.evaluate(() => { const p = document.querySelector('[data-wait="proposals"]'); const b = document.querySelector('.story-board'); return p.getBoundingClientRect().top < b.getBoundingClientRect().top && !p.classList.contains('is-idle'); });
  check('story: what waits comes before the board', order);
  const what = await page.locator('[data-wait="proposals"] tbody').innerText();
  check('story: a proposal reads in words, its payload behind DETAILS', /Flatmate[^:]*: picked up a new hobby/.test(what) && !(await page.locator('.ls-details .story-payload').first().isVisible()) && await page.locator('.ls-details').count() === 1, what);
  await page.locator('.ls-details summary').first().tap();
  check('story: DETAILS opens', await page.locator('.ls-details .story-payload').first().isVisible());
  await page.locator('.ls-reject').first().tap();
  await page.waitForTimeout(800);
  check('story: a real proposal reject, panel goes idle', applied('/proposals/').length === 1 && await page.locator('[data-wait="proposals"].is-idle').count() === 1, JSON.stringify(applied('/proposals/')));

  // Journal: real publish and unpublish, real regenerate (stubbed clerk).
  await go(page, '#life/journal');
  await page.waitForTimeout(700);
  await drill('publish a night', () => page.locator('#ljPublish').tap(), '/publish', '{}');
  await page.waitForTimeout(500);
  check('journal: the button now says UNPUBLISH, the night is marked', (await page.locator('#ljPublish').innerText()) === 'UNPUBLISH' && await page.locator('[data-slot="lj-nights"] .chip.ok', { hasText: 'PUBLIC' }).count() >= 1, await page.locator('#ljPublish').innerText());
  await drill('unpublish a night', () => page.locator('#ljPublish').tap(), '/unpublish', '{}');
  await page.waitForTimeout(500);
  await page.locator('#ljRegen').tap();
  await page.waitForTimeout(350);
  check('regenerate: asks in a sheet, safe focus', await sheet.isVisible() && await page.evaluate(() => document.activeElement?.dataset?.ask === 'no'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('regenerate: Escape is no (it isn\'t destructive)', await sheet.count() === 0 && !applied('/regenerate').length);
  await page.locator('#ljRegen').tap();
  await page.waitForTimeout(350);
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(1500);
  check('regenerate: the confirm sends once', applied('/regenerate').length === 1, JSON.stringify(applied('/regenerate')));

  check('write: no browser dialog anywhere', !dlgs.length, dlgs.join(' | '));
  check('write: no page errors', !errors.length, errors.join(' | '));
  const aud = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=30')).json()));
  check('write: the writes are audited', /director\./.test(aud) && /journal/.test(aud), aud.slice(0, 300));
  await ctx.close();

}

// Weekly review: one card at a time; a private card; a very long scene; a real revert; a second tap;
// offline mid-review; real writes on a scratch DB (--write --review).
async function reviewEmpty(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#review');
  await page.waitForTimeout(600);
  check('review: nothing to review says so', /NOTHING TO REVIEW/.test(await page.locator('[data-slot="rv-body"]').innerText()));
  check('review: read-only, it can\'t mark or sample', await page.locator('.rv-sample').isDisabled());
  await page.locator('[data-seg="results"]').tap();
  await page.waitForTimeout(400);
  check('review: empty results', /NOTHING SAMPLED YET/.test(await page.locator('[data-slot="rv-body"]').innerText()));
  check('review: no errors, empty', !errors.length, errors.join(' | '));
  await ctx.close();
}

async function reviewWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#review');
  await page.waitForTimeout(500);
  const dlgs = [];
  page.on('dialog', (d) => { dlgs.push(d.message()); d.dismiss(); });
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/review/')) posts.push([r.url().replace(base, ''), r.postData()]); });
  const marks = () => posts.filter(([u]) => u.endsWith('/mark'));
  const left = async () => Number(await page.locator('[data-slot="rv-left"]').textContent());
  const cardId = () => page.locator('.rv-card').count();
  const q = () => page.evaluate(async () => (await fetch('/api/review/queue?limit=30')).json());

  await page.locator('.rv-sample').first().tap();
  await page.waitForTimeout(1200);
  check('review: SAMPLE THIS WEEK fills the queue', await left() > 3 && await cardId() === 1, String(await left()));
  const first = await page.locator('.rv-pos').innerText();
  check('review: one card, its place in the queue', /^1 OF \d+/.test(first), first);
  const start = await left();
  check('review: nothing to undo yet: UNDO LAST is off', await page.locator('.rv-undo').isDisabled());
  check('review: on a phone the count is on the strip, not twice', !(await page.locator('.rv-head-meta').isVisible()) && /\d/.test(await page.locator('[data-seg="cards"]').innerText()));
  const cardTop = (await page.locator('.rv-card').boundingBox()).y;
  check('review: the words start high on a phone', cardTop < 260, String(cardTop));

  // PASS, and a double tap marks only one.
  const passBox = await page.locator('.rv-pass').boundingBox();
  check('review: big buttons', passBox.height >= 60 && passBox.width >= 150, JSON.stringify(passBox));
  await page.touchscreen.tap(passBox.x + 40, passBox.y + 20);
  await page.touchscreen.tap(passBox.x + 40, passBox.y + 20);
  await page.waitForTimeout(600);
  eq_('review: a double tap marks one card', marks().length, 1);
  eq_('review: …the queue moved on by one', await left(), start - 1);
  await page.waitForTimeout(320);

  // FAIL with a note; a double tap doesn't land on a note.
  const failBox = await page.locator('.rv-fail').boundingBox();
  await page.touchscreen.tap(failBox.x + 40, failBox.y + 20);
  await page.touchscreen.tap(failBox.x + 40, failBox.y + 20);
  await page.waitForTimeout(350);
  check('review: FAIL asks what was wrong, nothing sent yet', await page.locator('.rv-note').count() === 10 && marks().length === 1);
  if (OUT) await page.screenshot({ path: `${OUT}/review-why-390.png` });
  await page.locator('.rv-back').tap();
  check('review: BACK changes its mind', await page.locator('.rv-pass').count() === 1 && marks().length === 1);
  await page.waitForTimeout(320);
  await page.locator('.rv-fail').tap();
  await page.waitForTimeout(320);
  await page.locator('.rv-note[data-note="voice"]').tap();
  await page.waitForTimeout(500);
  check('review: a fail with its code', marks().length === 2 && marks()[1][1] === '{"verdict":"fail","note":"voice"}', JSON.stringify(marks()[1]));
  const failedNow = async () => Number(await page.locator('[data-slot="rv-failed"]').textContent());
  await page.waitForTimeout(1900);
  eq_('review: FAILED in the head follows a fail while on CARDS', await failedNow(), 1);

  // UNDO LAST brings it back; the server's mark is gone.
  await page.waitForTimeout(320);
  const undone = marks()[1][0].match(/items\/(\d+)/)[1];
  await page.locator('.rv-undo').tap();
  await page.waitForTimeout(700);
  check('review: UNDO LAST: the card is back', posts.some(([u]) => u.endsWith(`/items/${undone}/unmark`)) && await page.locator('.rv-pass').count() === 1, JSON.stringify(posts.slice(-1)));
  eq_('review: …the count too', await left(), start - 1);
  await page.waitForTimeout(1900);
  eq_('review: …and FAILED goes back down', await failedNow(), 0);

  // SKIP goes to the back, unmarked.
  await page.waitForTimeout(320);
  const before = await page.locator('.rv-card').innerText();
  await page.locator('.rv-skip').tap();
  await page.waitForTimeout(350);
  check('review: SKIP moves on, nothing sent', (await page.locator('.rv-card').innerText()) !== before && marks().length === 2);

  // A private card: no words in the queue or the page until the tap; can't be marked unread.
  const all = await q();
  const priv = all.cards.find((c) => c.private);
  check('review: a private card comes without its words', !!priv && priv.text === null && !JSON.stringify(all).includes('PLACEHOLDER private'), JSON.stringify(priv));
  for (let i = 0; i < 40 && !(await page.locator('.rv-hidden').count()); i++) { await page.waitForTimeout(290); await page.locator('.rv-skip').tap(); }
  check('review: the private card shows its mark and hides the words', await page.locator('.rv-card .chip.warn', { hasText: 'PRIVATE' }).count() === 1 && !(await page.content()).includes('PLACEHOLDER private'));
  check('review: unread, it can\'t be marked', await page.locator('.rv-pass').isDisabled() && await page.locator('.rv-fail').isDisabled());
  if (OUT) await page.screenshot({ path: `${OUT}/review-private-390.png` });
  await page.locator('.rv-reveal').tap();
  await page.waitForTimeout(500);
  check('review: the tap shows them, and it can be marked', (await page.locator('.rv-text').innerText()).includes('PLACEHOLDER private') && !(await page.locator('.rv-pass').isDisabled()));
  await page.locator('.rv-hide').tap();
  await page.waitForTimeout(150);
  check('review: HIDE AGAIN puts them away, and it can\'t be marked again until read', !(await page.content()).includes('PLACEHOLDER private') && await page.locator('.rv-pass').isDisabled());
  await page.locator('.rv-reveal').tap();
  await page.waitForTimeout(500);
  await page.waitForTimeout(300);
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(500);

  // A very long scene at each width: the buttons stay in reach, nothing runs off the page.
  for (let i = 0; i < 40 && !(await page.locator('.rv-text', { hasText: 'Paragraph 60' }).count()); i++) { await page.waitForTimeout(290); await page.locator('.rv-skip').tap(); }
  const longShown = await page.locator('.rv-text', { hasText: 'Paragraph 60' }).count();
  check('review: the very long scene arrived', longShown === 1);
  for (const [label, w, h] of [['390', 390, 844], ['320', 320, 568], ['landscape', 844, 390], ['1440', 1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(120);
    const m = await page.evaluate(() => { const b = document.querySelector('.rv-main').getBoundingClientRect(); return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, inView: b.bottom <= innerHeight + 1 && b.top >= 0, tall: document.documentElement.scrollHeight > innerHeight }; });
    check(`review ${label}: long scene: PASS / FAIL in view while scrolled, no sideways scroll`, m.over <= 0 && m.inView && m.tall, JSON.stringify(m));
    if (OUT) await page.screenshot({ path: `${OUT}/review-long-${label}.png` });
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(150);
  const sideBar = await page.locator('.rv-bar').boundingBox();
  check('review: sideways, the buttons take one row', sideBar.height < 90, JSON.stringify(sideBar));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(320);
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(500);
  const nextTop = (await page.locator('.rv-card').boundingBox()).y;
  check('review: out of a long one, the next card starts in view, under the top bar', nextTop >= 40 && nextTop < 260, String(nextTop));
  await page.evaluate(() => window.scrollTo(0, 0));

  // Unbroken words.
  for (let i = 0; i < 40 && !(await page.locator('.rv-text', { hasText: 'unbrokenunbroken' }).count()); i++) { await page.waitForTimeout(290); await page.locator('.rv-skip').tap(); }
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('review: an unbroken word wraps', await page.locator('.rv-text', { hasText: 'unbrokenunbroken' }).count() === 1 && over <= 0, String(over));
  await page.waitForTimeout(320);
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(600);

  // Offline mid-review: keep going, marks wait, nothing lost, they go when it's back.
  const countMarked = () => page.evaluate(async () => { const s = await (await fetch('/api/review/stats')).json(); return s.rows.reduce((n, r) => n + r.pass + r.fail, 0); });
  const atStart = await countMarked();
  await ctx.setOffline(true);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForTimeout(320);
  check('review: offline says so', /OFFLINE/.test(await page.locator('[data-slot="rv-net"]').innerText()));
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(350);
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(350);
  const stored = await page.evaluate(() => localStorage.getItem('ld.review.pending'));
  check('review: two marks wait, with no words in them', (JSON.parse(stored) || []).length === 2 && !/text|PLACEHOLDER/.test(stored), stored);
  check('review: the page still has a card', await page.locator('.rv-card').count() === 1);
  if (OUT) await page.screenshot({ path: `${OUT}/review-offline-390.png` });
  await ctx.setOffline(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rv-card', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  eq_('review: back online, even after a reload: both arrived, once', await countMarked(), atStart + 2);
  check('review: nothing left waiting', await page.evaluate(() => JSON.parse(localStorage.getItem('ld.review.pending') || '[]').length) === 0);
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForTimeout(350);
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(350);
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(900);
  eq_('review: …and without one', await countMarked(), atStart + 3);
  check('review: the banner goes', (await page.locator('[data-slot="rv-net"]').innerText()) === '', await page.locator('[data-slot="rv-net"]').innerText());

  // Out of reach with the phone still "online" (a dropped tunnel): the marks wait all the same.
  await page.route('**/api/review/**', (r) => r.abort());
  await page.waitForTimeout(320);
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(600);
  check('review: a dropped tunnel: says offline, the mark waits', /OFFLINE/.test(await page.locator('[data-slot="rv-net"]').innerText()) && (await page.evaluate(() => JSON.parse(localStorage.getItem('ld.review.pending') || '[]').length)) === 1);
  await page.unroute('**/api/review/**');
  await page.waitForTimeout(16_000);
  eq_('review: …and goes on the timer', await countMarked(), atStart + 4);

  // A mark from another tab: the same is fine, a different one isn't a crash.
  const twice = await page.evaluate(async () => {
    const csrf = document.cookie.match(/csrf_token=([^;]+)/)?.[1];
    const m = (id, verdict) => fetch(`/api/review/items/${id}/mark`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ verdict }) }).then((r) => r.status);
    const { cards } = await (await fetch('/api/review/queue?limit=3')).json();
    return [await m(cards[2].id, 'pass'), await m(cards[2].id, 'pass'), await m(cards[2].id, 'fail')];
  });
  eq_('review: marking twice: ok, ok, refused', twice.join(), '200,200,409');

  // A real revert: the output leaves the queue; the mark on a card held here isn't counted.
  const reverted = await page.evaluate(async () => {
    const csrf = document.cookie.match(/csrf_token=([^;]+)/)?.[1];
    const q = await (await fetch('/api/review/queue?limit=30')).json();
    const before = q.left;
    const sampled = new Set(q.cards.filter((c) => c.surface === 'phone' && !c.private).map((c) => c.sourceId));
    const { events } = await (await fetch('/api/life/events?limit=500')).json();
    const ev = events.find((e) => e.type === 'phone.message' && e.revertible && sampled.has(e.payload?.msgId));
    if (!ev) return { none: true, sampled: sampled.size };
    const r = await fetch(`/api/life/events/${ev.id}/revert`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ reason: 'test' }) });
    const after = (await (await fetch('/api/review/queue?limit=1')).json()).left;
    return { status: r.status, before, after };
  });
  if (reverted.none) console.log(`  NOT RUN: a real revert (no revertible sampled phone.message on this world, ${reverted.sampled} sampled)`);
  else check('review: a real revert: the output left the queue', reverted.status === 200 && reverted.after === reverted.before - 1, JSON.stringify(reverted));

  // The end of the queue says what you did, not "nothing to review".
  await page.evaluate(async () => {
    const csrf = document.cookie.match(/csrf_token=([^;]+)/)?.[1];
    for (;;) {
      const { cards, left: n } = await (await fetch('/api/review/queue?limit=30')).json();
      if (n <= 1) break;
      for (const c of cards.slice(0, n - 1)) await fetch(`/api/review/items/${c.id}/mark`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ verdict: 'pass' }) });
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rv-card', { timeout: 8000 });
  await page.waitForTimeout(600);
  if (await page.locator('.rv-hidden').count()) { await page.locator('.rv-reveal').tap(); await page.waitForTimeout(400); }
  await page.waitForTimeout(320);
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(800);
  const endText = await page.locator('[data-slot="rv-body"]').innerText();
  check('review: the last card: what you did, and the way to the results', /THAT WAS THE LAST ONE/.test(endText) && /1 PASS · 0 FAIL/.test(endText) && !/NOTHING TO REVIEW/.test(endText), endText);
  if (OUT) await page.screenshot({ path: `${OUT}/review-end-390.png` });
  await page.locator('.rv-undo').tap();
  await page.waitForTimeout(700);
  check('review: UNDO LAST from the end brings it back', await page.locator('.rv-card').count() === 1);
  await page.waitForTimeout(320);
  if (await page.locator('.rv-hidden').count()) { await page.locator('.rv-reveal').tap(); await page.waitForTimeout(400); }
  await page.locator('.rv-pass').tap();
  await page.waitForTimeout(800);
  await page.locator('[data-slot="rv-body"] [data-seg="results"]').tap();
  await page.waitForTimeout(500);
  check('review: SEE THE RESULTS goes there', /BY WEEK/.test(await page.locator('[data-slot="rv-body"]').innerText()));
  await page.locator('[data-slot="rv-seg"] [data-seg="cards"]').tap();
  await page.waitForTimeout(200);

  // Results and the download.
  await page.locator('[data-slot="rv-seg"] [data-seg="results"]').tap();
  await page.waitForTimeout(600);
  const res = await page.locator('[data-slot="rv-body"]').innerText();
  check('review results: by surface and week, notes', /TEXT/.test(res) && /SCENE/.test(res) && /\d+%/.test(res), res.slice(0, 200));
  if (OUT) await page.screenshot({ path: `${OUT}/review-results-390.png`, fullPage: true });
  const over2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('review results: no sideways scroll', over2 <= 0, String(over2));
  const stubs = await page.evaluate(async () => (await fetch('/api/review/failures.json')).json());
  check('review: the download holds no private words', stubs.kind === 'incident-stubs' && !JSON.stringify(stubs).includes('PLACEHOLDER private'));
  await page.evaluate(() => { localStorage.setItem('ld.review.seg', 'cards'); });

  check('review: no browser dialog', !dlgs.length, dlgs.join());
  check('review: no page errors', !errors.length, errors.join(' | '));
  const aud = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=60')).json()));
  check('review: audited with no words', /review\.mark/.test(aud) && !/PLACEHOLDER|Paragraph 1/.test(aud));
  await ctx.close();
}
const eq_ = (name, got, want) => check(name, got === want, `${got} (want ${want})`);

// Inner life on a phone: stances grouped with what waits first, the WHY sheet, dreams, ON HIS MIND.
// Real writes on a scratch DB (--write --inner).
const panelOf = (page, key) => page.locator(`details[data-fold="mind.${key}"]`);
const openFold = async (page, key) => { await page.evaluate((k) => { const d = document.querySelector(`details[data-fold="mind.${k}"]`); if (d) d.open = true; }, key); await page.waitForTimeout(120); };

async function innerRead(base) {
  for (const [label, dev] of [['390', PHONE], ['320', { ...PHONE, viewport: { width: 320, height: 568 } }], ['landscape', { ...PHONE, viewport: { width: 844, height: 390 } }], ['1440', DESK]]) {
    const { ctx, page, errors } = await open(dev, base, '#mind');
    await page.waitForTimeout(1500);
    await openFold(page, 'stances');
    await openFold(page, 'dreams');
    const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`inner ${label}: Mind has no sideways scroll`, await over() <= 0, String(await over()));
    const heads = await panelOf(page, 'stances').locator('.story-sub, summary.mono').allInnerTexts();
    check(`inner ${label}: what waits comes first, set aside last`, /^WAITING FOR YOU · 2/.test(heads[0]) && /^WHAT HE HOLDS/.test(heads[1]) && /^SET ASIDE · 1/.test(heads[2]), heads.join(' | '));
    check(`inner ${label}: set aside is folded`, await panelOf(page, 'stances').locator('.m-older').evaluate((d) => !d.open));
    const nums = await panelOf(page, 'stances').locator('.m-st-group:not(.is-waiting) .v-stance-num > span:first-child').allInnerTexts();
    const abs = nums.map((n) => Math.abs(Number(n)));
    check(`inner ${label}: what he holds, strongest first`, abs.length > 2 && abs.every((v, i) => !i || v <= abs[i - 1]), nums.join());
    const noConf = await panelOf(page, 'stances').innerText();
    check(`inner ${label}: plain words: SURE, INTEREST, OPINION`, !/conf /.test(noConf) && /SURE \d+%/.test(noConf) && /OPINION/.test(noConf) && /INTEREST/.test(noConf));
    const cut = await panelOf(page, 'stances').locator('.v-stance-why, .m-st-acts button').evaluateAll((ns) => ns.filter((n) => { const r = n.getBoundingClientRect(); return r.width && r.right > document.documentElement.clientWidth; }).length);
    check(`inner ${label}: every stance button on screen`, cut === 0, String(cut));
    const oneLine = await panelOf(page, 'dreams').locator('.v-dream-head').first().evaluate((h) => { const r = [...h.children].map((k) => k.getBoundingClientRect()); return r.every((x) => x.top < r[0].bottom); });
    check(`inner ${label}: a dream's date and chips share a line (320 may wrap)`, oneLine || label === '320');
    check(`inner ${label}: no time to the second on a dream`, !/\d:\d\d:\d\d/.test(await panelOf(page, 'dreams').locator('.v-dream-head').first().innerText()));
    const shown = await panelOf(page, 'dreams').locator(':scope > .panel-body > .v-dream').count();
    check(`inner ${label}: five dreams, the rest fold`, shown === 5 && /OLDER DREAMS · \d/.test(await panelOf(page, 'dreams').locator('.m-older summary').innerText()), String(shown));
    const more = panelOf(page, 'dreams').locator('.v-dream-more').first();
    const before = await more.locator('xpath=ancestor::article').boundingBox();
    check(`inner ${label}: a long dream opens short`, await more.count() === 1 && !(await more.evaluate((d) => d.open)) && before.height < 420, JSON.stringify(before));
    await more.locator('summary').click();
    await page.waitForTimeout(120);
    check(`inner ${label}: READ THE REST shows it all`, /light would not go down\.$/.test((await more.locator('.v-dream-text').innerText()).trim()) && await over() <= 0);
    if (OUT) await panelOf(page, 'dreams').screenshot({ path: `${OUT}/inner-dreams-${label}.png` });
    if (OUT) await panelOf(page, 'stances').screenshot({ path: `${OUT}/inner-stances-${label}.png` });
    check(`inner ${label}: Mind: no errors`, !errors.length, errors.join(' | '));

    await go(page, '#life');
    await page.waitForTimeout(600);
    const nowRows = page.locator('[data-slot="ln-th"] .v-stream-row');
    check(`inner ${label}: Now holds the latest few`, await nowRows.count() <= 8 && await nowRows.count() >= 3, String(await nowRows.count()));
    check(`inner ${label}: a chat's feeling says so, no more`, /from a chat/.test(await page.locator('[data-slot="ln-th"]').innerText()) && !/120363|@g\.us/.test(await page.locator('[data-slot="ln-th"]').innerText()));
    check(`inner ${label}: each row's kind in words for a reader`, await page.locator('[data-slot="ln-th"] .v-sr').count() === await nowRows.count());
    check(`inner ${label}: Now: no sideways scroll`, await over() <= 0);

    await go(page, '#life/day');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const d = document.querySelector('details[data-fold="day.mind"]'); if (d) d.open = true; });
    const earlier = page.locator('.ld-earlier');
    await earlier.waitFor({ timeout: 6000 }).catch(() => {});
    const dayState = [await earlier.count(), await earlier.evaluate((d) => d.open).catch(() => null), await page.locator('[data-slot="ld-th"] > .v-stream > .v-stream-row').count(), await earlier.locator('summary').innerText().catch(() => '')];
    check(`inner ${label}: Day: the day's earlier thoughts fold, latest twelve show`, dayState[0] === 1 && dayState[1] === false && dayState[2] === 12 && /EARLIER · \d+/.test(dayState[3]), JSON.stringify(dayState));
    await earlier.locator('summary').click();
    await page.waitForTimeout(150);
    check(`inner ${label}: Day: EARLIER opens, in order`, await earlier.locator('.v-stream-row').count() > 4 && await over() <= 0);
    await go(page, '#life');
    await go(page, '#life/day');
    await page.waitForTimeout(700);
    check(`inner ${label}: Day: EARLIER stays as you left it`, await page.locator('.ld-earlier').evaluate((d) => d.open));
    await page.locator('.ld-earlier summary').click().catch(() => {});
    if (label !== '1440') {
      const small = await page.locator('.ld-row.is-click').evaluateAll((ns) => ns.filter((n) => { const h = n.getBoundingClientRect().height; return h > 0 && h < 43.5; }).map((n) => `${n.className}:${n.getBoundingClientRect().height}`));
      check(`inner ${label}: Day's tappable rows are a finger high`, small.length === 0, small.join(' '));
    }
    if (OUT) await page.screenshot({ path: `${OUT}/inner-day-${label}.png` });
    await ctx.close();
  }
}

async function innerWrite(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#mind');
  await page.waitForTimeout(1500);
  await openFold(page, 'stances');
  const dlgs = [];
  page.on('dialog', (d) => { dlgs.push(d.message()); d.dismiss(); });
  const posts = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/mind/stances')) posts.push([r.method(), r.url().replace(base, ''), r.postData()]); });
  const sheet = page.locator('dialog.sheet');
  const holds = () => panelOf(page, 'stances').locator('.m-st-group:not(.is-waiting) .v-stance').count();
  const count0 = await holds();

  // Approve and reject, for real: each from its own row.
  const wait = panelOf(page, 'stances').locator('.m-st-wait');
  const first = await wait.first().locator('.v-stance-topic').innerText();
  await wait.first().locator('[data-stance-approve]').tap();
  await page.waitForTimeout(900);
  check('inner write: APPROVE moves it to what he holds', await holds() === count0 + 1 && (await panelOf(page, 'stances').locator('.m-st-group:not(.is-waiting)').innerText()).includes(first), first);
  await page.waitForTimeout(100);
  await wait.first().locator('[data-stance-reject]').tap();
  await page.waitForTimeout(900);
  check('inner write: REJECT: nothing waits, the group goes', await panelOf(page, 'stances').locator('.is-waiting').count() === 0);

  // WHY: its words, the blank anchor, a real anchor, pin, reset.
  await panelOf(page, 'stances').locator('.v-stance-why').first().tap();
  await page.waitForTimeout(600);
  check('inner write: WHY opens a sheet with its kind and numbers', /(OPINION|INTEREST) · NOW -?\d/.test(await sheet.innerText()), await sheet.innerText().catch(() => ''));
  check('inner write: its input is big enough not to zoom', await sheet.locator('input[name="anchor"]').evaluate((n) => parseFloat(getComputedStyle(n).fontSize) >= 16));
  const n0 = posts.length;
  await sheet.locator('input[name="anchor"]').fill('');
  await sheet.locator('form button[type="submit"]').tap();
  await page.waitForTimeout(300);
  check('inner write: a blank anchor isn\'t 0: nothing sent', posts.length === n0 && await sheet.isVisible());
  await sheet.locator('input[name="anchor"]').fill('0.25');
  await sheet.locator('form button[type="submit"]').tap();
  await page.waitForTimeout(800);
  check('inner write: an anchor, sent as a number', posts.at(-1)?.[2] === '{"anchor":0.25}' && posts.at(-1)?.[0] === 'PUT' && await sheet.count() === 0, JSON.stringify(posts.at(-1)));
  await panelOf(page, 'stances').locator('.v-stance-why').first().tap();
  await page.waitForTimeout(500);
  const pinWord = await sheet.locator('[data-stance-pin]').innerText();
  await sheet.locator('[data-stance-pin]').tap();
  await page.waitForTimeout(800);
  check('inner write: PIN toggles for real', /\/pin$/.test(posts.at(-1)?.[1]) && JSON.parse(posts.at(-1)?.[2]).pinned === (pinWord === 'PIN'), JSON.stringify(posts.at(-1)));
  await panelOf(page, 'stances').locator('.v-stance-why').first().tap();
  await page.waitForTimeout(500);
  await sheet.locator('[data-stance-reset]').tap();
  await page.waitForTimeout(500);
  const asked = await sheet.innerText();
  const n1 = posts.length;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('inner write: RESET asks; Escape does nothing, nothing sent', /Back to where he returns to/.test(asked) && await sheet.isVisible() && posts.length === n1, asked);
  await sheet.locator('button[type="submit"]').tap();
  await page.waitForTimeout(800);
  check('inner write: RESET sends once', posts.length === n1 + 1 && /\/reset$/.test(posts.at(-1)[1]), JSON.stringify(posts.at(-1)));
  const aud = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=20')).json()));
  check('inner write: audited', /mind\./.test(aud), aud.slice(0, 200));
  check('inner write: no browser dialog', !dlgs.length, dlgs.join());
  check('inner write: no errors', !errors.length, errors.join(' | '));
  await ctx.close();
}

async function innerReadOnly(base) {
  const { ctx, page } = await open(PHONE, base, '#mind');
  await page.waitForTimeout(1500);
  await openFold(page, 'stances');
  check('inner read-only: APPROVE disabled', await panelOf(page, 'stances').locator('[data-stance-approve]').first().isDisabled());
  await panelOf(page, 'stances').locator('.v-stance-why').first().tap();
  await page.waitForTimeout(500);
  const sheet = page.locator('dialog.sheet');
  check('inner read-only: WHY still reads, its controls are off', /NOW/.test(await sheet.innerText()) && await sheet.locator('[data-stance-pin]').isDisabled() && await sheet.locator('form button[type="submit"]').isDisabled());
  await ctx.close();
}

// Batch 3: real thoughts, free topics, commitments, how things stand, claim check, phrases. Commitments, claim
// checks and phrases are served with awkward data (they need weeks of life); their empty states and the rest are real.
const B3_LONG = 'Wolfeschlegelsteinhausenbergerdorffwelchevoralternwaren';
const b3Now = () => Math.floor(Date.now() / 1000);
const B3_COMMITMENTS = () => ({ running: true, at: b3Now(), counts: { overdue: 1, no_plan: 1, on: 2, kept: 1 }, rows: [
  { status: 'overdue', who: 'Flatmate', what: 'Coffee at the usual place', when: b3Now() - 7200, source: 'decision', weight: 2, code: 'past_point_of_no_return' },
  { status: 'no_plan', who: 'a friend', what: 'They agreed in texts to see that film some time next week, once the rain stops', when: b3Now() + 259200, source: 'text', weight: 2 },
  { status: 'open', who: null, what: 'A plan from a chat', when: null, source: 'claim', weight: 1 },
  { status: 'on', who: B3_LONG, what: B3_LONG + B3_LONG, when: b3Now() + 86400, source: 'goal', weight: 3 },
  { status: 'kept', who: 'Parent', what: 'Call on Sunday', when: b3Now() - 86400, source: 'decision', weight: 2 },
] });
const B3_CLAIMS = (mode = 'shadow') => ({ enabled: true, ready: true, mode, today: 12, maxPerDay: 200, pricing: 'priced', monthUsd: 0.42, budgetUsd: 3, pending: 4, rewrites: 0,
  rows: [{ writer: 'scene', speaker: 'narrator', runs: 120, checked: 96, codeOnly: 24, supported: 310, unknown: 220, contradicted: 9, codeContradicted: 3 }, { writer: 'phone', speaker: 'his', runs: 8000, checked: 6400, codeOnly: 1600, supported: 90000, unknown: 120000, contradicted: 3100, codeContradicted: 1200 }],
  skips: [{ reason: 'cap', n: 3 }],
  last: [{ writer: 'phone', speaker: 'his', about: 'where', source: 'clerk', reason: 'contradicts_sheet', claim: 'I was at the office all day', evidence: 'He worked from home that day.', at: b3Now() - 7200 }, { writer: 'phone', speaker: 'cast', fromChat: true, about: 'plan', source: 'code', reason: 'no_such_plan', at: b3Now() - 9000 }, { writer: 'scene', speaker: 'narrator', about: 'money', source: 'clerk', reason: 'r', claim: B3_LONG + B3_LONG, evidence: B3_LONG, at: b3Now() - 10000 }] });
const B3_PHRASES = (q = '') => ({ on: false, running: { source: 'phrases.json', version: 'v3' }, restartNeeded: true, banks: ['thought', 'live', 'dream'], total: 64,
  disk: { source: 'phrases.json', version: 'v4', issue: null, warnings: ['partial', 'english_changed_since'], coverage: { thought: { voiced: 48, slots: 64, entries: 120 } }, health: { thought: { language: 'mixed', englishWordPct: 41, topWords: [{ word: 'word', count: 18 }] } }, rejected: { too_long: 3 } },
  rows: Array.from({ length: 30 }, (_, i) => ({ pools: [i ? `BODY.line${i}` : `query:${q}`], source: `line ${i}`, variants: i % 3 ? [{ t: i === 1 ? B3_LONG + B3_LONG : `his line ${i}`, mood: 'tired' }] : [] })) });
const b3Wire = (page) => Promise.all([
  page.route('**/api/life/commitments*', (r) => r.fulfill({ json: B3_COMMITMENTS() })),
  page.route('**/api/arcs/claim-checks*', (r) => r.fulfill({ json: B3_CLAIMS() })),
  page.route('**/api/life/phrases*', (r) => r.fulfill({ json: B3_PHRASES(new URL(r.request().url()).searchParams.get('q') ?? '') })),
]);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function b3Read(base) {
  for (const [label, dev, phone] of [['390', PHONE, true], ['320', { ...PHONE, viewport: { width: 320, height: 568 } }, true], ['landscape', { ...PHONE, viewport: { width: 844, height: 390 } }, true], ['1440', DESK, false]]) {
    const ctx = await browser.newContext({ ...dev, httpCredentials: { username: 'admin', password: 'preview' } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await b3Wire(page);
    await page.goto(`${base}/#life`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-slot="ln-th-real"] .v-two', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    // Real thoughts: the newest whole, the rest one tap away on a phone.
    const more = page.locator('[data-slot="ln-th-real"] .v-told-more');
    const moreOpen = await more.evaluate((d) => d.open).catch(() => null);
    check(`b3 ${label}: real thoughts: the newest whole, the rest ${phone ? 'folded' : 'open'}`, moreOpen === !phone && await page.locator('[data-slot="ln-th-real"] > .v-two').count() === 1, String(moreOpen));
    const [l, r] = await page.locator('[data-slot="ln-th-real"] > .v-two .v-two-col').evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect()).map((x) => ({ x: Math.round(x.x), y: Math.round(x.y) })));
    check(`b3 ${label}: its two sides ${label === '390' || label === '320' ? 'stack' : 'hold'}`, (label === '390' || label === '320') ? l.y < r.y : true, JSON.stringify([l, r]));
    // Commitments.
    await page.evaluate(() => { const d = document.querySelector('details[data-fold="now.commitments"]'); if (d) d.open = true; });
    await page.waitForTimeout(120);
    check(`b3 ${label}: commitments: the note says something waits`, await page.locator('[data-slot="ln-com-note"].amber').count() === 1 && /2 TO LOOK AT/.test(await page.locator('[data-slot="ln-com-note"]').innerText()));
    if (phone && label !== 'landscape') {
      const shape = await page.locator('.ln-com-table tbody tr').first().evaluate((tr) => { const pos = (c) => tr.querySelector(c).getBoundingClientRect(); const s = pos('.c-status'); const w = pos('.c-when'); const what = pos('.c-what'); const who = pos('.c-who'); return { statusWhen: Math.abs(s.top - w.top) < 14 && w.left > s.left, whatBelow: what.top >= s.bottom - 1, whoBelow: who.top >= what.bottom - 1, wide: what.width > tr.getBoundingClientRect().width * 0.8, labels: getComputedStyle(tr.querySelector('.c-what'), '::before').content }; });
      check(`b3 ${label}: a commitment reads status + when, what, who + from, no labels`, shape.statusWhen && shape.whatBelow && shape.whoBelow && shape.wide && shape.labels === 'none', JSON.stringify(shape));
      check(`b3 ${label}: no table head on a phone`, !(await page.locator('.ln-com-table thead').isVisible()));
      const cellLines = await page.locator('.ln-com-table tbody td').evaluateAll((ns) => ns.filter((n) => parseFloat(getComputedStyle(n).borderBottomWidth) > 0).length);
      check(`b3 ${label}: a row is one row, no lines between its cells`, cellLines === 0, String(cellLines));
    }
    check(`b3 ${label}: Now: no sideways scroll, a long name wraps`, await noSideways(page) <= 0, String(await noSideways(page)));
    if (OUT) await page.locator('details[data-fold="now.commitments"]').locator('xpath=..').screenshot({ path: `${OUT}/b3-com-${label}.png` });
    check(`b3 ${label}: Now: no errors`, !errors.length, errors.join(' | '));

    // Free topics.
    await go(page, '#mind');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const d = document.querySelector('details[data-fold="mind.stances"]'); if (d) d.open = true; });
    await page.waitForTimeout(120);
    const fromLines = page.locator('.m-st-from');
    check(`b3 ${label}: free topic: says what it cites, a chat among them in amber`, await fromLines.count() === 2 && await page.locator('.m-st-cites.is-chat').count() === 1 && /A GROUP/.test(await page.locator('.m-st-cites.is-chat').innerText()));
    const stanceText = await page.locator('details[data-fold="mind.stances"]').innerText();
    check(`b3 ${label}: free topic: no JID or chat name in its origin line`, !/@g\.us|12036|Weekend crew|Flat 4B/.test(stanceText));
    const aligned = await page.locator('.m-st-wait').first().evaluate((w) => { const left = (c) => { const n = w.querySelector(c); const r = document.createRange(); r.selectNodeContents(n); return Math.round(r.getBoundingClientRect().left); }; return [left('.v-stance-topic'), left('.m-st-why'), left('.m-st-from'), Math.round(w.querySelector('.m-st-acts button').getBoundingClientRect().left)]; });
    check(`b3 ${label}: free topic: its lines share a left edge`, aligned.every((v) => Math.abs(v - aligned[0]) <= 1), aligned.join());
    if (OUT) await page.locator('details[data-fold="mind.stances"]').screenshot({ path: `${OUT}/b3-free-${label}.png` });

    // How things stand.
    await go(page, '#life/cast/cast%3Aflatmate');
    await page.waitForTimeout(800);
    const note = await page.locator('[data-slot="lm-standing-note"]').innerText();
    check(`b3 ${label}: standing: the note, a short date`, /AS OF \w+ \d+ \w+ \d\d:\d\d · 1 EVENT$/i.test(note.trim()) && await page.locator('.lm-standing-now').count() === 1, note);
    const older = page.locator('.lm-standing-older');
    check(`b3 ${label}: standing: earlier versions fold`, !(await older.evaluate((d) => d.open)) && /EARLIER VERSIONS · 2/.test(await older.locator('summary').innerText()));
    const sumH = (await older.locator('summary').boundingBox()).height;
    check(`b3 ${label}: standing: the fold is a finger high`, !phone || sumH >= 43.5, String(sumH));
    await older.locator('summary').click();
    await page.waitForTimeout(120);
    check(`b3 ${label}: standing: an undone version says why`, /rewound/.test(await older.innerText()) && await noSideways(page) <= 0);
    if (OUT) await page.locator('[data-slot="lm-standing"]').locator('xpath=..').screenshot({ path: `${OUT}/b3-stand-${label}.png` });

    // Claim check.
    await go(page, '#claim-check');
    await page.waitForTimeout(500);
    check(`b3 ${label}: claim check: no sideways scroll, long words wrap`, await noSideways(page) <= 0, String(await noSideways(page)));
    if (phone && label !== 'landscape') {
      const v = await page.locator('.cc-table tbody tr').nth(1).evaluate((tr) => { const a = tr.querySelector('.cc-voice').getBoundingClientRect(); const b = tr.querySelector('.cc-rate').getBoundingClientRect(); const cells = [...tr.querySelectorAll('td[data-l]:not(.cc-rate)')]; return { sameLine: Math.abs(a.top - b.top) < 8 && b.left > a.left, label: getComputedStyle(cells[0], '::before').content, grid: new Set(cells.map((c) => Math.round(c.getBoundingClientRect().left))).size }; });
      check(`b3 ${label}: a voice: its name and rate on a line, then labelled numbers`, v.sameLine && /OUTPUTS/.test(v.label) && v.grid === (label === '320' ? 2 : 3), JSON.stringify(v));
      const broken = await page.locator('.cc-table td[data-l="CONTRADICTED"]').first().evaluate((td) => { const box = td.getBoundingClientRect(); return td.scrollWidth > td.clientWidth + 1 || box.height > 56; });
      check(`b3 ${label}: CONTRADICTED stays one word`, !broken);
    }
    check(`b3 ${label}: claim check: a reason in words`, /contradicts sheet/.test(await page.locator('[data-slot="c-last"]').innerText()));
    if (OUT) await page.screenshot({ path: `${OUT}/b3-claim-${label}.png`, fullPage: true });

    // Phrases.
    await go(page, '#life/phrases');
    await page.waitForTimeout(500);
    const tabs = await page.locator('[data-slot="lp-tabs"] .seg-item').evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return r.right <= document.documentElement.clientWidth + 1 && n.scrollWidth <= n.clientWidth + 1; }));
    check(`b3 ${label}: phrases: all three tabs fit`, tabs.length === 3 && tabs.every(Boolean), tabs.join());
    const q = await page.locator('[data-el="lp-q"]').boundingBox();
    check(`b3 ${label}: phrases: a search box you can use`, q.width >= 150 && (!phone || q.height >= 43.5), JSON.stringify(q));
    check(`b3 ${label}: phrases: no sideways scroll`, await noSideways(page) <= 0, String(await noSideways(page)));
    if (OUT) await page.screenshot({ path: `${OUT}/b3-phr-${label}.png`, fullPage: true });
    check(`b3 ${label}: no errors`, !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // Failures and races, on a phone.
  const ctx = await browser.newContext({ ...PHONE, httpCredentials: { username: 'admin', password: 'preview' } });
  const page = await ctx.newPage();
  await b3Wire(page);
  await page.goto(`${base}/#claim-check`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cc-table tbody tr', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.route('**/api/arcs/claim-checks*', (r) => r.abort());
  await page.selectOption('#cWindow', '7');
  await page.waitForTimeout(500);
  check('b3: claim check: a failed load leaves the page', await page.locator('.cc-table tbody tr').count() === 2 && await page.locator('#cWindow').count() === 1);
  await page.unroute('**/api/arcs/claim-checks*');
  await page.route('**/api/arcs/claim-checks*', async (r) => {
    const days = new URL(r.request().url()).searchParams.get('days');
    if (days === '7') await new Promise((res) => setTimeout(res, 900));
    await r.fulfill({ json: B3_CLAIMS(days === '7' ? 'off' : 'enforce') });
  });
  await page.selectOption('#cWindow', '7');
  await page.waitForTimeout(100);
  await page.selectOption('#cWindow', '90');
  await page.waitForTimeout(1400);
  check('b3: claim check: an older window\'s answer doesn\'t paint over a newer one', /ENFORCE/.test(await page.locator('[data-slot="c-mode"]').innerText()), await page.locator('[data-slot="c-mode"]').innerText());
  await go(page, '#life/phrases');
  await page.waitForTimeout(500);
  await page.route('**/api/life/phrases*', async (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') ?? '';
    if (q === 'ab') await new Promise((res) => setTimeout(res, 900));
    await r.fulfill({ json: B3_PHRASES(q) });
  });
  await page.fill('[data-el="lp-q"]', 'ab');
  await page.waitForTimeout(350);
  await page.fill('[data-el="lp-q"]', 'abc');
  await page.waitForTimeout(1500);
  check('b3: phrases: fast typing: the last search wins', /query:abc/.test(await page.locator('[data-slot="lp-rows"]').innerText()));
  await page.route('**/api/life/phrases*', (r) => r.abort());
  await page.fill('[data-el="lp-q"]', 'abcd');
  await page.waitForTimeout(700);
  check('b3: phrases: a failed search keeps the lines and what was typed', await page.locator('.v-two').count() > 0 && await page.inputValue('[data-el="lp-q"]') === 'abcd');
  await page.unroute('**/api/life/phrases*');
  await page.route('**/api/life/phrases*', (r) => r.fulfill({ json: B3_PHRASES('') }));
  await page.locator('[data-act="next"]').scrollIntoViewIfNeeded();
  await page.locator('[data-act="next"]').tap();
  await page.waitForTimeout(500);
  const top = await page.locator('[data-slot="lp-rows"]').evaluate((n) => n.getBoundingClientRect().top);
  check('b3: phrases: MORE goes back to the first line of the new page', top >= -1 && top < 200, String(top));
  await ctx.close();
}

async function b3Empty(base) {
  // Nothing served: what a fresh world really shows.
  for (const [label, dev] of [['390', PHONE], ['1440', DESK]]) {
    const { ctx, page, errors } = await open(dev, base, '#life');
    await page.waitForTimeout(1200);
    check(`b3 empty ${label}: no real thoughts, no empty card`, await page.locator('[data-slot="ln-th-real"] .v-two').count() === 0);
    await page.evaluate(() => { const d = document.querySelector('details[data-fold="now.commitments"]'); if (d) d.open = true; });
    await page.waitForTimeout(150);
    const comText = await page.locator('details[data-fold="now.commitments"]').innerText();
    check(`b3 empty ${label}: commitments read`, /NOTHING HE|ON/.test(comText) && await noSideways(page) <= 0, comText.slice(0, 120));
    await go(page, '#claim-check');
    await page.waitForTimeout(800);
    check(`b3 empty ${label}: claim check says so`, /NOTHING|NO CONTRADICTIONS/.test(await page.locator('.content').innerText()) && await noSideways(page) <= 0);
    await go(page, '#life/phrases');
    await page.waitForTimeout(800);
    const ph = await page.locator('.content').innerText();
    check(`b3 empty ${label}: phrases with no bank: says what's in use, shows today's lines`, /English/.test(ph) && await noSideways(page) <= 0, ph.slice(0, 160));
    if (OUT) await page.screenshot({ path: `${OUT}/b3-phr-real-${label}.png`, fullPage: false });
    await go(page, '#life/cast/cast%3Aflatmate');
    await page.waitForTimeout(800);
    check(`b3 empty ${label}: standing: none yet, no "as of"`, /NO NOTE YET|SWITCHED OFF/.test(await page.locator('[data-slot="lm-standing"]').innerText()) && (await page.locator('[data-slot="lm-standing-note"]').innerText()).trim() === '');
    check(`b3 empty ${label}: no errors`, !errors.length, errors.join(' | '));
    await ctx.close();
  }
}

async function b3Write(base) {
  const { ctx, page, errors } = await open(PHONE, base, '#mind');
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const d = document.querySelector('details[data-fold="mind.stances"]'); if (d) d.open = true; });
  await page.waitForTimeout(120);
  const posts = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/mind/stances')) posts.push([r.url().replace(base, ''), r.postData()]); });
  check('b3 write: a free topic takes its own click: no APPROVE ALL for them', await page.locator('[data-stance-approve-all]').count() === 0);
  const wait = page.locator('.m-st-wait');
  const label = await wait.first().locator('.v-stance-topic').innerText();
  const id = await wait.first().locator('[data-stance-approve]').getAttribute('data-stance-approve');
  await wait.first().locator('[data-stance-approve]').tap();
  await page.waitForTimeout(900);
  check('b3 write: a real approve, one id, moves it to what he holds', posts.at(-1)?.[1] === `{"ids":[${id}]}` && (await page.locator('.m-st-group:not(.is-waiting)').innerText()).includes(label), JSON.stringify(posts.at(-1)));
  check('b3 write: approved, the origin line goes with the question', await page.locator('.m-st-group:not(.is-waiting) .m-st-from').count() === 0);
  await wait.first().locator('[data-stance-reject]').tap();
  await page.waitForTimeout(900);
  check('b3 write: a real reject: nothing waits', await page.locator('.is-waiting').count() === 0 && /\/reject$/.test(posts.at(-1)?.[0]), JSON.stringify(posts.at(-1)));
  const aud = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit?limit=10')).json()));
  check('b3 write: audited', /mind\.stance/.test(aud), aud.slice(0, 200));
  check('b3 write: no errors', !errors.length, errors.join(' | '));
  await ctx.close();
}

async function kitEdges(base) {
  for (const [name, device] of [['320', { ...PHONE, viewport: { width: 320, height: 568 } }], ['390', PHONE], ['landscape', { ...PHONE, viewport: { width: 844, height: 390 } }], ['1440', DESK]]) {
    const { ctx, page, errors } = await open(device, base, '#kit');
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      for (const el of document.querySelectorAll('#content *')) {
        if (!el.offsetParent || el.closest('.seg, .panel:has(> table.data), .table-wrap')) continue;
        const b = el.getBoundingClientRect();
        if (b.right > vw + 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}+${Math.round(b.right - vw)}`);
      }
      return { over: document.documentElement.scrollWidth - innerWidth, out: [...new Set(out)].slice(0, 5) };
    });
    check(`kit ${name}: fits with the worst-case rows`, r.over <= 0 && !r.out.length && !errors.length, [errors[0], ...r.out].filter(Boolean).join(' '));
    if (OUT) await page.screenshot({ path: path.join(OUT, `kit-${name}.png`), fullPage: true });
    if (name === '390') {
      const wide = await page.locator('table.data').first().evaluate((t) => t.classList.contains('cards'));
      const short = await page.locator('table.data').nth(1).evaluate((t) => t.classList.contains('cards'));
      check('kit: the 6-column table is cards, the 3-column one stays a table', wide && !short);
      const msg = await page.locator('table.data tr td[colspan]').first().getAttribute('data-label');
      check('kit: a spanning row has no label', msg === '');
    }
    await ctx.close();
  }
}

try {
  if (ONLY.includes('kit')) await withServer([], 7077, kitEdges);
  if (ONLY.includes('write')) await withServer(['--write'], 7078, writeEdges);
  if (ONLY.includes('phone')) { await withServer([], 7079, phoneRead); await withServer(['--write'], 7080, phoneWrite); }
  if (ONLY.includes('people')) { await withServer([], 7081, peopleRead); await withServer(['--write', '--days', '7'], 7082, peopleWrite); }
  if (ONLY.includes('wallet')) { await withServer([], 7083, walletEdges); await withServer(['--write'], 7084, walletWrite); }
  if (ONLY.includes('map')) { await withServer([], 7085, mapGrid); await withServer(['--tiles'], 7086, mapLeaflet); }
  if (ONLY.includes('settings')) { await withServer([], 7087, settingsRead); await withServer(['--write'], 7088, settingsWrite); }
  if (ONLY.includes('chats')) { await withServer([], 7089, chatsRead); await withServer(['--write'], 7090, chatsWrite); }
  if (ONLY.includes('mind')) { await withServer([], 7092, mindRead); await withServer(['--write'], 7093, mindWrite); }
  if (ONLY.includes('golive')) await withServer(['--write', '--mind'], 7094, goLive);
  if (ONLY.includes('dialogs')) await withServer(['--write', '--sends'], 7095, dialogs);
  if (ONLY.includes('now')) { await withServer([], 7096, nowRead); await withServer(['--write'], 7097, nowWrite); }
  if (ONLY.includes('day')) { await withServer(['--tiles'], 7098, dayRead); await withServer(['--write'], 7099, dayWrite); }
  if (ONLY.includes('director')) { await withServer([], 7100, directorRead); await withServer(['--write', '--story'], 7101, directorWrite); }
  if (ONLY.includes('review')) { await withServer(['--empty'], 7102, reviewEmpty); await withServer(['--write', '--review'], 7103, reviewWrite); }
  if (ONLY.includes('inner')) { await withServer(['--inner', '--days', '4'], 7104, innerRead); await withServer(['--inner', '--days', '3'], 7105, innerReadOnly); await withServer(['--write', '--inner'], 7106, innerWrite); }
  if (ONLY.includes('b3')) { await withServer(['--batch3'], 7107, b3Read); await withServer([], 7108, b3Empty); await withServer(['--write', '--batch3'], 7109, b3Write); }
  if (ONLY.includes('shell')) await withServer([], 7074, shellEdges);
  if (ONLY.includes('empty')) await withServer(['--empty'], 7075, emptyEdges);
  if (ONLY.includes('worst')) await withServer(['--worst'], 7076, worstEdges);
} catch (err) {
  fails++;
  console.error('FAIL  harness —', err?.stack || err);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
