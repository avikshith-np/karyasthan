import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// Web SEARCH via a self-hosted SearXNG instance (JSON API, no API key).
// Browsing (Playwright) lives in webBrowse.js. The shared marker extractor and
// untrusted-content sanitizer live here because both paths use them.
//
// IMPORTANT: SearXNG only returns JSON if `search.formats` includes `json` in its
// settings.yml (it ships `[html]` only). Without it we degrade to "(no results)".

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const CACHE_MAX = 100;
const cache = new Map(); // normalizedQuery → { text, expires }

// Hourly rate-limit (mirrors src/brain/mediaSearch.js).
let searchCount = 0;
let rateWindowStart = Date.now();

function rolloverRateWindow() {
  const now = Date.now();
  if (now - rateWindowStart > 60 * 60 * 1000) {
    searchCount = 0;
    rateWindowStart = now;
  }
}

function checkSearchRateLimit() {
  rolloverRateWindow();
  return searchCount < config.webSearch.searchMaxPerHour;
}

function recordSearch() {
  rolloverRateWindow();
  searchCount++;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.text;
}

function cacheSet(key, text) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { text, expires: Date.now() + CACHE_TTL_MS });
}

// Strip anything that looks like one of our own system/media markers, plus bare
// @digit mention tokens and control characters, from UNTRUSTED web content before
// it is fed back to the LLM. This is the highest-impact prompt-injection guard:
// without it a malicious page could plant e.g. "[IMAGE: ...]" which the next hop
// echoes into the final answer — bypassing the quality gate (skipped for media
// markers) and triggering a real image generation + send.
const MARKER_TOKEN_RE = /\[(?:IMAGE|IMG|VOICE|SING|STICKER|STKR|GIF|REPLY|SEARCH|BROWSE)\s*:[^\]]*\]?/gi;
const MENTION_TOKEN_RE = /(^|\s)@\d{3,}/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g; // strip control chars, keep \t and \n

export function sanitizeWebContent(text) {
  if (!text) return '';
  return String(text)
    .replace(MARKER_TOKEN_RE, ' ')
    .replace(MENTION_TOKEN_RE, '$1')
    .replace(CONTROL_CHARS_RE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract a web tool marker from LLM output. Lenient (finds the marker even amid
 * filler like "sure, [SEARCH: x]") and UNCAPPED (URLs/queries exceed 50 chars),
 * modeled on imageGen.js extractImageMarker. Matches ONLY [SEARCH:]/[BROWSE:]
 * (case-insensitive) so it never collides with the media markers, which are
 * extracted later in index.js from the final text.
 * Returns { kind: 'search'|'browse', arg } or null.
 */
export function extractWebMarker(text) {
  if (!text) return null;
  const markerIdx = text.search(/\[(?:SEARCH|BROWSE)\s*:/i);
  if (markerIdx === -1) return null;

  const markerText = text.slice(markerIdx);
  let m = markerText.match(/^\[(SEARCH|BROWSE)\s*:\s*(.+?)\]/si); // closed
  if (!m) m = markerText.match(/^\[(SEARCH|BROWSE)\s*:\s*([\s\S]+)$/i); // unclosed/truncated
  if (!m) return null;

  const kind = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  if (!arg) return null;
  return { kind, arg };
}

/**
 * Search the web via SearXNG. Always returns a STRING (formatted results, an
 * instant answer, or a clear "(no results)" / limit notice) — never throws and
 * never returns null, so a dead or misconfigured instance degrades gracefully.
 */
export async function searchWeb(query) {
  const q = String(query || '').trim();
  if (!q) return '(no results)';

  const key = q.toLowerCase().slice(0, 200);
  const cached = cacheGet(key);
  if (cached !== null) {
    logger.info({ q: q.slice(0, 80) }, 'Web search cache hit');
    return cached;
  }

  if (!checkSearchRateLimit()) {
    logger.warn({ searchCount }, 'Web search hourly rate limit reached');
    return '(search limit reached — answer from what you already know)';
  }

  const base = config.webSearch.searxngUrl;
  if (!base) return '(no results)';
  // News-like queries go to SearXNG's news category: general engines return
  // newspaper homepages for these, while news engines return actual headlines.
  const isNewsQuery = /\b(news|headline|breaking|varthakal?|vartha)\b/i.test(q);
  const url = `${base}/search?q=${encodeURIComponent(q)}&format=json&safesearch=1&language=en${isNewsQuery ? '&categories=news' : ''}`;

  let data;
  try {
    const startTime = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.webSearch.timeoutMs),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, errBody: errBody.slice(0, 300), q: q.slice(0, 80) },
        'SearXNG error (is formats:[json] enabled in settings.yml?)',
      );
      return '(no results)';
    }

    try {
      data = await res.json();
    } catch (err) {
      logger.warn(
        { err: err.message, q: q.slice(0, 80) },
        'SearXNG returned non-JSON — enable formats:[json] in settings.yml',
      );
      return '(no results)';
    }

    logger.info(
      { q: q.slice(0, 80), latencyMs: Date.now() - startTime, count: data?.results?.length || 0 },
      'Web search',
    );
  } catch (err) {
    logger.warn({ err: err.message, q: q.slice(0, 80) }, 'Web search request failed (SearXNG down?)');
    return '(no results)';
  }

  recordSearch();

  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) {
    const answer = Array.isArray(data?.answers) && data.answers.length ? data.answers.join(' ') : '';
    const out = answer ? sanitizeWebContent(answer).slice(0, 500) : '(no results)';
    cacheSet(key, out);
    return out;
  }

  const lines = results.slice(0, config.webSearch.maxResults).map((r, i) => {
    const title = sanitizeWebContent(r.title || '').slice(0, 120);
    const link = typeof r.url === 'string' ? r.url.slice(0, 300) : '';
    const snippet = sanitizeWebContent(r.content || '').slice(0, 200);
    return `${i + 1}. ${title} — ${link}\n   ${snippet}`;
  });
  const out = lines.join('\n');
  cacheSet(key, out);
  return out;
}
