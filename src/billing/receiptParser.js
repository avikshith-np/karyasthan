import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const RECEIPT_PROMPT = `Extract all items, quantities, prices, tax, service charges, discounts, and total from this restaurant bill/receipt image.
Convert all amounts to numbers (rupees with decimals, e.g. 450.00).
If an item has quantity > 1, the total_price_rupees should be qty × unit_price.
If you cannot determine a field, use 0.
If this is NOT a food bill or receipt, return empty items array.`;

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    restaurant: { type: 'string', description: 'Restaurant or establishment name' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Item name' },
          qty: { type: 'integer', description: 'Quantity ordered' },
          unit_price_rupees: { type: 'number', description: 'Price per unit in rupees' },
          total_price_rupees: { type: 'number', description: 'Total price for this item (qty × unit_price) in rupees' },
        },
        required: ['name', 'qty', 'total_price_rupees'],
      },
    },
    subtotal_rupees: { type: 'number', description: 'Subtotal before tax/charges' },
    tax_rupees: { type: 'number', description: 'Total tax amount (GST, CGST+SGST, VAT, etc.)' },
    service_charge_rupees: { type: 'number', description: 'Service charge if any' },
    discount_rupees: { type: 'number', description: 'Discount amount if any' },
    total_rupees: { type: 'number', description: 'Final total (what you pay)' },
  },
  required: ['items', 'total_rupees'],
};

/**
 * Parse a receipt image using Gemini 2.5 Pro with structured JSON output.
 *
 * @param {string} base64 - Base64-encoded image data
 * @param {string} mimetype - Image MIME type (e.g., 'image/jpeg')
 * @returns {object|null} Parsed bill in paisa format, or null if not a receipt
 */
export async function parseReceipt(base64, mimetype) {
  const apiKey = config.llm.geminiApiKey;
  if (!apiKey) {
    logger.warn('No Gemini API key for receipt parsing');
    return null;
  }

  const model = config.billSplitModel || 'gemini-2.5-pro';
  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: RECEIPT_PROMPT },
            { inline_data: { mime_type: mimetype, data: base64 } },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RECEIPT_SCHEMA,
          temperature: 0.1,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn({ status: res.status, errBody: errBody.slice(0, 300), model }, 'Receipt parser API error');
      return null;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      logger.warn('Receipt parser returned empty response');
      return null;
    }

    const parsed = JSON.parse(text);

    // Validate: must have items
    if (!parsed.items || parsed.items.length === 0) {
      logger.info('Not a receipt or no items found');
      return null;
    }

    // Convert to paisa (integer) format
    const bill = {
      restaurant: parsed.restaurant || null,
      items: parsed.items.map(item => ({
        name: item.name,
        qty: item.qty || 1,
        unitPricePaisa: Math.round((item.unit_price_rupees || 0) * 100),
        totalPricePaisa: Math.round((item.total_price_rupees || 0) * 100),
      })),
      subtotalPaisa: Math.round((parsed.subtotal_rupees || 0) * 100),
      taxPaisa: Math.round((parsed.tax_rupees || 0) * 100),
      serviceChargePaisa: Math.round((parsed.service_charge_rupees || 0) * 100),
      discountPaisa: Math.round((parsed.discount_rupees || 0) * 100),
      totalPaisa: Math.round((parsed.total_rupees || 0) * 100),
    };

    // If subtotal wasn't extracted, calculate from items
    if (bill.subtotalPaisa === 0) {
      bill.subtotalPaisa = bill.items.reduce((sum, item) => sum + item.totalPricePaisa, 0);
    }

    // If total wasn't extracted, calculate it
    if (bill.totalPaisa === 0) {
      bill.totalPaisa = bill.subtotalPaisa + bill.taxPaisa + bill.serviceChargePaisa - bill.discountPaisa;
    }

    logger.info({
      restaurant: bill.restaurant,
      itemCount: bill.items.length,
      total: bill.totalPaisa,
    }, 'Receipt parsed successfully');

    return bill;
  } catch (err) {
    logger.warn({ err: err.message }, 'Receipt parsing failed');
    return null;
  }
}
