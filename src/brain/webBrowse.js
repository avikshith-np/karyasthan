import net from 'net';
import dns from 'dns';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { sanitizeWebContent } from './webSearch.js';

// Web BROWSING via Playwright headless Chromium. URLs here come from UNTRUSTED group
// chat (the LLM emits [BROWSE: url] partly driven by what members say), so the SSRF
// guard below is load-bearing. The app-layer DNS check is best-effort (TOCTOU /
// DNS-rebinding can bypass it) — the SUPPORTED hardening is network-level egress
// filtering (drop outbound to RFC1918 + 169.254 from the bot's namespace/firewall).
//
// Playwright is a LAZY import so the bot still boots if Chromium isn't installed
// (`npx playwright install chromium`); browse then degrades to null and search still works.

// ── SSRF guard ──────────────────────────────────────────────────────────────

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isBlockedIPv4(ip) {
  const n = ipv4ToLong(ip);
  if (n === null) return true; // unparseable → block
  const inRange = (base, bits) => {
    const b = ipv4ToLong(base);
    if (b === null) return false;
    const shift = 32 - bits;
    return (n >>> shift) === (b >>> shift);
  };
  return (
    inRange('0.0.0.0', 8) ||       // "this" network
    inRange('10.0.0.0', 8) ||      // private
    inRange('100.64.0.0', 10) ||   // CGNAT / shared
    inRange('127.0.0.0', 8) ||     // loopback
    inRange('169.254.0.0', 16) ||  // link-local incl. 169.254.169.254 cloud metadata
    inRange('172.16.0.0', 12) ||   // private
    inRange('192.168.0.0', 16) ||  // private
    inRange('224.0.0.0', 4) ||     // multicast
    inRange('240.0.0.0', 4)        // reserved / broadcast
  );
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (lower === '::1' || lower === '::') return true;          // loopback / unspecified
  if (/^fe[89ab]/.test(lower)) return true;                   // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true;                      // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true;                    // multicast
  return false;
}

function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true; // not an IP we recognize → block
}

function hostFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Throws if the URL must not be fetched. Checks: protocol (http/https only),
 * the bot's own dashboard host:port, the SearXNG host, and — for the hostname —
 * every resolved IP against private/loopback/link-local/metadata/multicast ranges.
 * Bypassed entirely only when browse.allowPrivate is set (.env escape hatch).
 */
async function assertUrlAllowed(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`blocked protocol: ${parsed.protocol}`);
  }
  if (config.webSearch.browse.allowPrivate) return;

  const host = parsed.hostname.toLowerCase();

  // Explicitly block our own infrastructure (defense-in-depth on top of IP checks).
  const dashHost = (config.dashboard.host || '').toLowerCase();
  const dashPort = String(config.dashboard.port || '');
  const reqPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (dashHost && host === dashHost && reqPort === dashPort) throw new Error('blocked: own dashboard');
  const searxHost = hostFromUrl(config.webSearch.searxngUrl);
  if (searxHost && host === searxHost) throw new Error('blocked: searxng host');

  const stripped = host.replace(/^\[|\]$/g, ''); // IPv6 literal brackets
  if (net.isIP(stripped)) {
    if (isBlockedIp(stripped)) throw new Error(`blocked IP literal: ${stripped}`);
    return;
  }

  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (err) {
    throw new Error(`DNS lookup failed: ${err.message}`);
  }
  if (!addrs.length) throw new Error('DNS returned no addresses');
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error(`blocked resolved IP: ${a.address}`);
  }
}

// ── Browser lifecycle ───────────────────────────────────────────────────────

let browserPromise = null;
let browseUnavailable = false; // set once if Playwright/Chromium can't be loaded
let activeBrowses = 0;
let idleTimer = null;

// Hourly rate-limit (mirrors mediaSearch.js).
let browseCount = 0;
let browseRateWindowStart = Date.now();

function rolloverBrowseWindow() {
  const now = Date.now();
  if (now - browseRateWindowStart > 60 * 60 * 1000) {
    browseCount = 0;
    browseRateWindowStart = now;
  }
}
function checkBrowseRateLimit() {
  rolloverBrowseWindow();
  return browseCount < config.webSearch.browse.maxPerHour;
}
function recordBrowse() {
  rolloverBrowseWindow();
  browseCount++;
}

async function getBrowser() {
  if (browseUnavailable) return null;
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: true,
      // --no-sandbox: bots often run as root under systemd/pm2.
      // --disable-dev-shm-usage: avoid /dev/shm exhaustion on small VPSes.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
    });
    logger.info('Headless browser launched');
    return browser;
  })().catch((err) => {
    browseUnavailable = true;
    browserPromise = null;
    logger.warn(
      { err: err.message },
      'Playwright/Chromium unavailable — browsing disabled (run: npx playwright install chromium). Search still works.',
    );
    return null;
  });
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeBrowses === 0) closeBrowser('idle');
  }, config.webSearch.browse.idleMs);
  if (idleTimer.unref) idleTimer.unref();
}

/**
 * Fetch a URL with a real headless browser and return its readable text
 * (sanitized + truncated), or null on any failure / disallowed URL.
 */
export async function browseUrl(url) {
  if (!config.webSearch.browse.enabled) return null;

  const raw = String(url || '').trim();
  if (!raw) return null;

  try {
    await assertUrlAllowed(raw);
  } catch (err) {
    logger.warn({ url: raw.slice(0, 120), reason: err.message }, 'Browse URL blocked (SSRF guard)');
    return null;
  }

  if (!checkBrowseRateLimit()) {
    logger.warn({ browseCount }, 'Browse hourly rate limit reached');
    return null;
  }
  if (activeBrowses >= config.webSearch.browse.maxConcurrent) {
    logger.warn({ activeBrowses }, 'Browse concurrency cap reached, skipping');
    return null;
  }

  const browser = await getBrowser();
  if (!browser) return null;

  activeBrowses++;
  recordBrowse();
  let context = null;
  try {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      acceptDownloads: false,
    });

    // Block heavy resources (NOT css/script — those are needed to render text). Cancel downloads.
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    page.on('download', (d) => { d.cancel().catch(() => {}); });

    const startTime = Date.now();
    await page.goto(raw, { waitUntil: 'domcontentloaded', timeout: config.webSearch.browse.timeoutMs });

    // Redirect backstop — re-check the final URL after navigation.
    try {
      await assertUrlAllowed(page.url());
    } catch (err) {
      logger.warn(
        { from: raw.slice(0, 120), to: page.url().slice(0, 120), reason: err.message },
        'Browse blocked after redirect (SSRF guard)',
      );
      return null;
    }

    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const cleaned = sanitizeWebContent(bodyText).slice(0, config.webSearch.browse.maxContentChars);
    logger.info(
      { url: raw.slice(0, 120), latencyMs: Date.now() - startTime, chars: cleaned.length },
      'Browsed page',
    );
    return cleaned || null;
  } catch (err) {
    logger.warn({ url: raw.slice(0, 120), err: err.message }, 'Browse failed');
    return null;
  } finally {
    if (context) { try { await context.close(); } catch {} }
    activeBrowses--;
    scheduleIdleClose();
  }
}

/**
 * Close the shared browser (graceful shutdown or idle). Safe to call when no
 * browser is open. The next browseUrl lazily relaunches.
 */
export async function closeBrowser(reason = 'shutdown') {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try {
    const browser = await p;
    if (browser) {
      await browser.close();
      logger.info({ reason }, 'Headless browser closed');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Error closing browser');
  }
}
