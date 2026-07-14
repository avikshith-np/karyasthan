import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { callLlm } from './llm.js';
import { flattenContent } from '../utils/transcript.js';

const GIPHY_BASE = 'https://api.giphy.com/v1';

const STICKER_CACHE_DIR = path.join(config.projectRoot, 'data', 'media-cache', 'stickers');
const GIF_CACHE_DIR = path.join(config.projectRoot, 'data', 'media-cache', 'gifs');
const CACHE_MAX_FILES = 200;
const CACHE_PRUNE_BATCH = 20;

const STICKER_MAX_BYTES = 500 * 1024;
const GIF_MAX_BYTES = 1024 * 1024;

fs.mkdirSync(STICKER_CACHE_DIR, { recursive: true });
fs.mkdirSync(GIF_CACHE_DIR, { recursive: true });

let stickerCount = 0;
let gifCount = 0;
let rateWindowStart = Date.now();
let warnedNoKey = false;

function rolloverRateWindow() {
  const now = Date.now();
  if (now - rateWindowStart > 60 * 60 * 1000) {
    stickerCount = 0;
    gifCount = 0;
    rateWindowStart = now;
  }
}

function checkRateLimit(kind) {
  rolloverRateWindow();
  if (kind === 'sticker') {
    if (stickerCount >= config.media.stickerMaxPerHour) return false;
  } else {
    if (gifCount >= config.media.gifMaxPerHour) return false;
  }
  return true;
}

function recordSent(kind) {
  rolloverRateWindow();
  if (kind === 'sticker') stickerCount++;
  else gifCount++;
}

function extractMarker(text, label) {
  if (!text) return null;
  const head = `(?:${label}):`;
  const re = new RegExp(`\\[${head}`, 'i');
  const markerIdx = text.search(re);
  if (markerIdx === -1) return null;

  const beforeMarker = text.slice(0, markerIdx).trim();
  const markerText = text.slice(markerIdx);

  let query;
  let afterMarker = '';

  const closed = markerText.match(new RegExp(`^\\[${head}\\s*(.+?)\\]\\s*\\n?([\\s\\S]*)$`, 'si'));
  if (closed) {
    query = closed[1].trim();
    afterMarker = closed[2]?.trim() || '';
  } else {
    const open = markerText.match(new RegExp(`^\\[${head}\\s*([\\s\\S]*)$`, 'i'));
    if (!open) return null;
    query = open[1].trim();
  }

  if (!query) return null;

  query = query.slice(0, 50);
  const caption = [beforeMarker, afterMarker].filter(Boolean).join('\n');
  return { query, caption };
}

export function extractStickerMarker(text) {
  return extractMarker(text, 'STICKER|STKR');
}

export function extractGifMarker(text) {
  return extractMarker(text, 'GIF');
}

function pruneCacheIfFull(dir) {
  try {
    const files = fs.readdirSync(dir);
    if (files.length <= CACHE_MAX_FILES) return;
    const stats = files.map(name => {
      const full = path.join(dir, name);
      try { return { full, mtimeMs: fs.statSync(full).mtimeMs }; }
      catch { return null; }
    }).filter(Boolean);
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const s of stats.slice(0, CACHE_PRUNE_BATCH)) {
      try { fs.unlinkSync(s.full); } catch {}
    }
  } catch {}
}

function cachePathFor(kind, id) {
  const ext = kind === 'sticker' ? 'webp' : 'mp4';
  const dir = kind === 'sticker' ? STICKER_CACHE_DIR : GIF_CACHE_DIR;
  return path.join(dir, `${id}.${ext}`);
}

function readFromCache(kind, id) {
  try {
    const p = cachePathFor(kind, id);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      try { fs.utimesSync(p, new Date(), new Date()); } catch {}
      return buf;
    }
  } catch {}
  return null;
}

function writeToCache(kind, id, buffer) {
  try {
    const dir = kind === 'sticker' ? STICKER_CACHE_DIR : GIF_CACHE_DIR;
    fs.writeFileSync(cachePathFor(kind, id), buffer);
    pruneCacheIfFull(dir);
  } catch (err) {
    logger.debug({ err: err.message, kind, id }, 'GIPHY cache write failed');
  }
}

async function downloadVariant(url, maxBytes) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    if (buf.length === 0 || buf.length > maxBytes) return null;
    return buf;
  } catch {
    return null;
  }
}

function pickStickerVariantUrl(images) {
  if (!images) return null;
  const order = ['fixed_width_small', 'fixed_width', 'original'];
  for (const key of order) {
    const variant = images[key];
    if (variant?.webp) return variant.webp;
  }
  return null;
}

function pickGifVariantUrl(images) {
  if (!images) return null;
  const order = ['fixed_width', 'original', 'fixed_width_small'];
  for (const key of order) {
    const variant = images[key];
    if (variant?.mp4) return variant.mp4;
  }
  return null;
}

async function fetchGiphyResults(query, kind) {
  const apiKey = config.media.giphyApiKey;
  const path = kind === 'sticker' ? '/stickers/search' : '/gifs/search';
  const url = `${GIPHY_BASE}${path}?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&limit=8&rating=pg-13&lang=en`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 200), kind, query }, 'GIPHY API error');
      return [];
    }
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    logger.warn({ err: err.message, kind, query }, 'GIPHY request failed');
    return [];
  }
}

async function tryResults(results, kind) {
  const maxBytes = kind === 'sticker' ? STICKER_MAX_BYTES : GIF_MAX_BYTES;
  const pickUrl = kind === 'sticker' ? pickStickerVariantUrl : pickGifVariantUrl;

  for (const item of results) {
    const id = item?.id;
    if (!id) continue;

    const cached = readFromCache(kind, id);
    if (cached && cached.length <= maxBytes) {
      logger.info({ kind, id }, 'GIPHY cache hit');
      return { id, buffer: cached };
    }

    const variantUrl = pickUrl(item.images);
    if (!variantUrl) continue;

    const buf = await downloadVariant(variantUrl, maxBytes);
    if (!buf) continue;

    writeToCache(kind, id, buf);
    logger.info({ kind, id, bytes: buf.length }, 'GIPHY fetched');
    return { id, buffer: buf };
  }
  return null;
}

/**
 * Search GIPHY for a sticker or GIF and return a downloadable buffer.
 * Returns { id, buffer } on success, null on failure.
 *
 * opts:
 *   ignoreRateLimit — bypass the per-hour cap (used by dashboard force-sends)
 */
export async function searchGiphy(query, kind, opts = {}) {
  if (!config.media.giphyApiKey) {
    if (!warnedNoKey) {
      logger.warn('GIPHY_API_KEY not configured — sticker/GIF sends disabled');
      warnedNoKey = true;
    }
    return null;
  }

  if (!query || typeof query !== 'string') return null;
  if (kind !== 'sticker' && kind !== 'gif') return null;

  if (!opts.ignoreRateLimit && !checkRateLimit(kind)) {
    logger.warn({ kind, stickerCount, gifCount }, 'GIPHY rate limit exceeded');
    return null;
  }

  const trimmed = query.trim().slice(0, 50);
  let results = await fetchGiphyResults(trimmed, kind);
  let hit = await tryResults(results, kind);

  if (!hit) {
    const firstWord = trimmed.split(/\s+/)[0];
    if (firstWord && firstWord !== trimmed) {
      logger.debug({ original: trimmed, fallback: firstWord, kind }, 'GIPHY fallback to first word');
      results = await fetchGiphyResults(firstWord, kind);
      hit = await tryResults(results, kind);
    }
  }

  if (!hit) return null;

  recordSent(kind);
  return hit;
}

/**
 * Pick a 1-4 word GIPHY search query from the recent chat context.
 * Used by the dashboard "Send sticker / Send GIF" buttons.
 * Returns the query string or null.
 */
export async function pickContextualQuery(recentMessages, kind) {
  if (!Array.isArray(recentMessages) || !recentMessages.length) return null;

  const transcript = recentMessages
    .slice(-15)
    .map(m => `[${m.sender_name || 'Unknown'}]: ${flattenContent(m.content, m.message_type)}`)
    .join('\n');

  const kindLabel = kind === 'sticker' ? 'sticker' : 'GIF';
  const systemPrompt = `You pick GIPHY search queries. Given a WhatsApp conversation, output ONLY a 1-4 word search query for a ${kindLabel} that fits the latest moment. No quotes, no punctuation, no explanation, no prefix. Just the bare query words. Keep it visual: "crying laughing", "thumbs up", "facepalm", "side eye", "shocked pikachu".`;

  const text = await callLlm(systemPrompt, transcript, {
    provider: config.qualityGate.provider,
    model: config.qualityGate.model,
    maxTokens: 256, // short query, but thinking models need headroom or content comes back empty
    temperature: 0.4,
    timeoutMs: 5000,
    noFallback: true,
  });

  if (!text) return null;
  const cleaned = text
    .replace(/["'`]/g, '')
    .replace(/[.!?,]+$/g, '')
    .trim()
    .split('\n')[0]
    .trim()
    .slice(0, 50);

  return cleaned || null;
}
