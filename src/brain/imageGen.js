import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// In-memory rate limiter
let imageCount = 0;
let rateWindowStart = Date.now();

/**
 * Extract an image generation marker from LLM output.
 * Searches for [IMAGE: prompt] anywhere in the text.
 * Text before/after the marker becomes the caption.
 * Returns { prompt, caption } or null if no marker found.
 */
export function extractImageMarker(text) {
  if (!text || !config.imageGen.enabled) return null;

  const markerIdx = text.search(/\[(?:IMAGE|IMG):/i);
  if (markerIdx === -1) return null;

  const beforeMarker = text.slice(0, markerIdx).trim();
  const markerText = text.slice(markerIdx);

  let prompt;
  let afterMarker = '';

  const closed = markerText.match(/^\[(?:IMAGE|IMG):\s*(.+?)\]\s*\n?([\s\S]*)$/si);
  if (closed) {
    prompt = closed[1].trim();
    afterMarker = closed[2]?.trim() || '';
  } else {
    // LLM output truncated before closing `]` — treat the rest as the prompt.
    const open = markerText.match(/^\[(?:IMAGE|IMG):\s*([\s\S]*)$/i);
    if (!open) return null;
    prompt = open[1].trim();
  }

  if (!prompt) return null;

  const caption = [beforeMarker, afterMarker].filter(Boolean).join('\n');

  return { prompt, caption };
}

/**
 * Generate an image using Gemini Imagen 4 API.
 * Returns { buffer, mimeType } or null on failure.
 */
export async function generateImage(prompt) {
  const apiKey = config.llm.geminiApiKey || config.llm.apiKey;
  if (!apiKey) {
    logger.warn('No Gemini API key for image generation');
    return null;
  }

  // Rate limit check
  const now = Date.now();
  if (now - rateWindowStart > 60 * 60 * 1000) {
    imageCount = 0;
    rateWindowStart = now;
  }
  if (imageCount >= config.imageGen.maxPerHour) {
    logger.warn({ imageCount, max: config.imageGen.maxPerHour }, 'Image generation rate limit exceeded');
    return null;
  }

  const model = config.imageGen.model;
  const url = `${GEMINI_API_URL}/${model}:predict?key=${apiKey}`;

  try {
    const startTime = Date.now();

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1 },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'Imagen API error');
      return null;
    }

    const data = await res.json();
    const prediction = data.predictions?.[0];

    if (!prediction?.bytesBase64Encoded) {
      logger.warn({ data: JSON.stringify(data).slice(0, 300) }, 'Imagen returned no image data');
      return null;
    }

    const buffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
    const mimeType = prediction.mimeType || 'image/png';
    const latencyMs = Date.now() - startTime;

    imageCount++;
    logger.info({ model, latencyMs, bufferSize: buffer.length, imageCount }, 'Image generated');

    return { buffer, mimeType };
  } catch (err) {
    logger.warn({ err: err.message, model }, 'Image generation failed');
    return null;
  }
}

/**
 * Edit an existing image using Gemini 2.5 Flash Image (image-in → image-out).
 * Returns { buffer, mimeType } or null on failure.
 */
export async function editImage(imageBuffer, mimeType, prompt) {
  const apiKey = config.llm.geminiApiKey || config.llm.apiKey;
  if (!apiKey) {
    logger.warn('No Gemini API key for image editing');
    return null;
  }

  if (!imageBuffer || !imageBuffer.length) {
    logger.warn('editImage called with empty buffer');
    return null;
  }

  // Rate limit check (shared with generateImage)
  const now = Date.now();
  if (now - rateWindowStart > 60 * 60 * 1000) {
    imageCount = 0;
    rateWindowStart = now;
  }
  if (imageCount >= config.imageGen.maxPerHour) {
    logger.warn({ imageCount, max: config.imageGen.maxPerHour }, 'Image edit rate limit exceeded');
    return null;
  }

  const model = config.imageGen.editModel;
  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;
  const cleanMime = (mimeType || 'image/jpeg').split(';')[0].trim();
  const base64 = imageBuffer.toString('base64');

  try {
    const startTime = Date.now();

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: cleanMime, data: base64 } },
          ],
        }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'Image edit API error');
      return null;
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.data || p.inline_data?.data);

    if (!imagePart) {
      logger.warn({ data: JSON.stringify(data).slice(0, 300) }, 'Image edit returned no image data');
      return null;
    }

    const inline = imagePart.inlineData || imagePart.inline_data;
    const buffer = Buffer.from(inline.data, 'base64');
    const outMime = inline.mimeType || inline.mime_type || 'image/png';
    const latencyMs = Date.now() - startTime;

    imageCount++;
    logger.info({ model, latencyMs, bufferSize: buffer.length, imageCount }, 'Image edited');

    return { buffer, mimeType: outMime };
  } catch (err) {
    logger.warn({ err: err.message, model }, 'Image edit failed');
    return null;
  }
}
