import { config, getProviderKey } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { geminiPost } from './geminiMedia.js';

// Both calls go through geminiPost (spec 007 R6/R7): GEMINI_API_KEY only, key in the
// x-goog-api-key header, `image` budget (over it → null → the caller sends text),
// one llm_usage row per call (Imagen reports no tokens → the price table's perCall).
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
  if (!getProviderKey('gemini')) {
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

  try {
    const startTime = Date.now();

    const r = await geminiPost({
      label: 'image',
      caller: 'image.generate',
      model,
      method: 'predict',
      timeoutMs: 20000,
      body: {
        instances: [{ prompt }],
        parameters: { sampleCount: 1 },
      },
    });

    if (!r.ok) {
      if (r.status !== 'budget') logger.warn({ status: r.status, model }, 'Imagen API error');
      return null;
    }

    const data = r.data;
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
  if (!getProviderKey('gemini')) {
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
  const cleanMime = (mimeType || 'image/jpeg').split(';')[0].trim();
  const base64 = imageBuffer.toString('base64');

  try {
    const startTime = Date.now();

    const r = await geminiPost({
      label: 'image',
      caller: 'image.edit',
      model,
      method: 'generateContent',
      timeoutMs: 30000,
      body: {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: cleanMime, data: base64 } },
          ],
        }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      },
    });

    if (!r.ok) {
      if (r.status !== 'budget') logger.warn({ status: r.status, model }, 'Image edit API error');
      return null;
    }

    const data = r.data;
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
