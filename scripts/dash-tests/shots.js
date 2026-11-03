// Screenshot every dashboard route at phone and desktop width and measure what a phone
// user hits: horizontal page scroll, content wider than the screen, small tap targets,
// console errors. Needs preview-server.js running.
//
//   node scripts/dash-tests/shots.js --out <dir> [--port 7073] [--only life,mind] [--widths 320x568,390x844,844x390,1440x900]
//
// Writes <dir>/<width>/<route>.png + <dir>/report.json, prints a table.
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { ROUTES } from '../../src/dashboard/public/js/routes.js';

const argOf = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const OUT = argOf('out', null);
if (!OUT) { console.error('--out <dir> required'); process.exit(2); }
const PORT = argOf('port', '7073');
const ONLY = argOf('only', '')?.split(',').filter(Boolean);
// Anything narrower than a laptop is a touch phone here; 844x390 is a phone held sideways.
const WIDTHS = argOf('widths', '390x844,1440x900').split(',').map((x) => {
  const [w, h] = x.split('x').map(Number);
  return { w, h, mobile: w < 1000 };
});
const BASE = `http://127.0.0.1:${PORT}`;

const hashOf = (r, api) => {
  if (r.hash === 'status') return '#status';
  if (r.hash === 'group') return api.group ? `#group/${encodeURIComponent(api.group)}` : null;
  if (r.hash === 'person') return api.person ? `#person/${encodeURIComponent(api.person)}` : null;
  if (r.hash === 'life/cast/member') return api.cast ? `#life/cast/${encodeURIComponent(api.cast)}` : null;
  return `#${r.hash}`;
};

// Runs in the page. Only what a phone user feels; off-screen and hidden things don't count.
function measure() {
  const vw = document.documentElement.clientWidth;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const scrolledInside = (el) => { for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  const wide = new Map();
  for (const el of document.querySelectorAll('.content *, .topbar *')) {
    if (!visible(el) || el.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && !scrolledInside(el)) { const k = el.className && typeof el.className === 'string' ? `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}` : el.tagName.toLowerCase(); wide.set(k, Math.max(wide.get(k) || 0, Math.round(r.right - vw))); }
  }
  const tappable = [...document.querySelectorAll('.content a, .content button, .content input, .content select, .content textarea, .content [role=button], .topbar a, .topbar button')].filter(visible);
  // An inline link in running text isn't a target of its own; .guide-q's hit area is larger than its box.
  const inProse = (el) => el.tagName === 'A' && el.closest('p, li, dd, .mute') && el.parentElement.textContent.trim().length > el.textContent.trim().length + 20;
  const small = tappable.filter((el) => { const r = el.getBoundingClientRect(); const lab = el.matches('input[type=checkbox], input[type=radio]') ? el.closest('label')?.getBoundingClientRect() : null;
    return (r.height < 40 || r.width < 40) && !(lab && lab.height >= 40) && !el.matches('.guide-q') && !inProse(el); });
  const smallBy = {};
  for (const el of small) { const c = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''; const k = el.tagName.toLowerCase() + c + (el.type === 'checkbox' ? ':cb' : ''); smallBy[k] = (smallBy[k] || 0) + 1; }
  const fonts = [...document.querySelectorAll('.content *')].filter((el) => visible(el) && el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  // SVG text is sized in viewBox units, not screen pixels.
  const tiny = fonts.filter((el) => !el.closest('svg') && parseFloat(getComputedStyle(el).fontSize) < 11).length;
  const inputsZoom = tappable.filter((el) => /INPUT|SELECT|TEXTAREA/.test(el.tagName) && parseFloat(getComputedStyle(el).fontSize) < 16).length;
  const scrollTables = [...document.querySelectorAll('.content table')].filter(visible).filter((t) => t.getBoundingClientRect().width > vw).length;
  return { scrollW: document.documentElement.scrollWidth, vw, pageH: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth - vw,
    wide: [...wide].sort((a, b) => b[1] - a[1]).slice(0, 5), tap: tappable.length, small: small.length, smallBy: Object.entries(smallBy).sort((a, b) => b[1] - a[1]).slice(0, 4), tiny, textEls: fonts.length, inputsZoom, scrollTables };
}

const browser = await chromium.launch();
const report = {};
try {
  for (const { w, h, mobile } of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
      httpCredentials: { username: 'admin', password: 'preview' }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_NAME|ERR_INTERNET|net::/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${BASE}/#status`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const api = await page.evaluate(async () => {
      const j = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };
      const g = await j('/api/groups'); const p = await j('/api/people'); const c = await j('/api/arcs/cast');
      const first = (x) => (Array.isArray(x) ? x[0] : null);
      return { group: first(g?.groups ?? g)?.jid ?? null, person: first(p?.people ?? p?.rows ?? p)?.jid ?? null, cast: first(c?.cast ?? c)?.id ?? null };
    });
    const dir = path.join(OUT, `${w}x${h}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const r of ROUTES) {
      if (ONLY.length && !ONLY.some((o) => r.hash.includes(o))) continue;
      const hash = hashOf(r, api);
      if (!hash) continue;
      errors.length = 0;
      await page.evaluate((x) => { window.location.hash = x; }, hash);
      await page.waitForTimeout(1300);
      const m = await page.evaluate(measure);
      const file = `${r.hash.replace(/\//g, '-')}.png`;
      await page.screenshot({ path: path.join(dir, file), fullPage: false });
      (report[r.hash] ??= {})[`${w}x${h}`] = { ...m, errors: [...errors].slice(0, 3) };
    }
    await ctx.close();
  }
} finally { await browser.close(); }
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('route', 18), ...WIDTHS.map(({ w }) => pad(`over${w}`, 8)), pad('zoom', 5), pad('<11px', 6), pad('small/taps', 11), pad('pageH', 6), 'smallest offenders / wide / errors');
for (const [k, v] of Object.entries(report)) {
  const first = v[`${WIDTHS[0].w}x${WIDTHS[0].h}`] || {};
  const wide = WIDTHS.flatMap(({ w, h }) => (v[`${w}x${h}`]?.wide || []).slice(0, 2).map(([n, d]) => `${w}:${n}+${d}`));
  const errs = WIDTHS.flatMap(({ w, h }) => v[`${w}x${h}`]?.errors || []);
  // The worst of the touch widths, so a problem at one width can't hide behind another; a desktop's mouse-sized rows don't count.
  const touch = WIDTHS.filter((x) => x.mobile).map(({ w, h }) => ({ w, m: v[`${w}x${h}`] })).filter((x) => x.m);
  const worst = (key) => (touch.length ? Math.max(...touch.map((x) => x.m[key] ?? 0)) : first[key] ?? '-');
  const smallest = touch.flatMap((x) => (x.m.smallBy || []).map(([n, c]) => `${x.w}:${n}×${c}`)).join(' ');
  console.log(pad(k, 18), ...WIDTHS.map(({ w, h }) => pad(v[`${w}x${h}`]?.overflow ?? '-', 8)), pad(worst('inputsZoom'), 5), pad(worst('tiny'), 6), pad(`${worst('small')}/${first.tap ?? '-'}`, 11), pad(first.pageH ?? '-', 6),
    smallest, wide.join(' '), errs.slice(0, 1).join(' ').slice(0, 80));
}
