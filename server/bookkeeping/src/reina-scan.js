// server/bookkeeping/src/reina-scan.js
//
// Task 8 (Receipt scanning / OCR pipeline). Scoped per the 2026-07-24
// investigation (see reina/accounting-control-parity-phase1-2026-07-23.md,
// "Post-Phase-4 / task 4"): a DEDICATED engine that calls Anthropic
// directly -- the reference's own Tier-3 pattern in scanWithReina()
// (server.js in hivelogic-expense-control) -- rather than routing through
// this app's api/chat.js (Reina's business-data chat assistant, which
// carries an unrelated persona/system-prompt and a 4-tool tool-use loop
// that has no reason to trigger here but could).
//
// Deliberately does NOT port the reference's Tier 1
// (HIVELOGIC_REINA_RECEIPT_URL, an external OCR service this app has never
// had) or Tier 2 (routing through this app's own /api/chat) branches --
// this app only has the Tier 3 credential (ANTHROPIC_API_KEY, already
// configured and proven live by api/chat.js) and the investigation
// recommended against Tier 2 for the reasons above. When no API key is
// configured, returns the reference's own honest stub shape
// ({needsAiConnection: true, ...echoed input}) -- never invents values.
//
// Output shape matches exactly what server/bookkeeping/src/reina-learning.js's
// annotateScanConfidence() already expects (documentType, vendor,
// transactionDate, subtotal, total, lineItems[], confidence,
// fieldConfidence, etc.) -- confirmed by reading that function in full
// before writing this. This file does not need to know anything about
// confidence scoring; the route layer runs the scan result through the
// already-ported, already-tested confidence/learning pipeline.

import Anthropic from '@anthropic-ai/sdk';

// Verbatim from the approved reference's scanWithReina() (server.js),
// adapted only by removing the two field names that don't exist in this
// app's confidence pipeline are otherwise identical -- reused as-is per
// this project's "parity first" mandate, since annotateScanConfidence()
// was itself ported to expect this exact field list.
// Bug fix (2026-08-07): the classification list below used to have no way
// to say "I can't read this" -- every category was a real document type
// (including "other"), which forced the model to pick one and then fill in
// plausible-sounding fields to match it, even for a blank, degraded, or
// unrelated image. A self-consistent fabrication (numbers that add up to
// EACH OTHER, just not to a real receipt) also slips past the arithmetic-
// reconciliation check downstream, since that only catches internally
// inconsistent fakes. Adding "unreadable" as an explicit, sanctioned
// category gives the model somewhere honest to land instead of guessing.
const CLASSIFICATION_PROMPT =
  'Act as the HiveLogic bookkeeping document reader. Classify this file as receipt, vendor_bill, bank_statement, credit_card_statement, loan_statement, payroll_summary, tax_notice, unreadable, or other. ' +
  'Use "unreadable" -- never a guessed category -- when the image is blank, too degraded/blurry, cut off, or does not contain an actual financial document you can confidently identify; in that case set every other field to null, set confidence below 0.3, and add a warning explaining what made it unreadable. Never invent a plausible-looking vendor, date, or amount to fill in a category you are not actually confident about. ' +
  'Return ONLY JSON with documentType, vendor, transactionDate (YYYY-MM-DD), dueDate (YYYY-MM-DD for vendor bills), statementStartDate, statementEndDate, receiptNumber, paymentMethod, cardLast4, accountLast4, ' +
  'subtotal (number), discount (number), shipping (number), salesTaxTotal (number), salesTaxState (2-letter US state if visible), total (number), beginningBalance (number), endingBalance (number), currency, memo, ' +
  'receiptText (short), confidence (0-1), fieldConfidence (object containing a separate 0-1 confidence for every returned top-level field), warnings (array), lineItems, and transactions. ' +
  'Each lineItems entry must have description, nickname, sku, quantity, unitPrice, discount, subtotal, confidence, descriptionConfidence, skuConfidence, subtotalConfidence, and productImageRegion. ' +
  'nickname should be a short, contractor-friendly, searchable product name of two to six words, or null when the item is unclear. ' +
  'When a distinct product photo or thumbnail for that exact line is visible, productImageRegion must tightly bound only the product as {left,top,right,bottom,confidence}, with every edge normalized from 0 to 1 relative to the full uploaded image: left/top are the upper-left edge and right/bottom are the lower-right edge. ' +
  'Visually verify that the box includes the entire product and excludes all neighboring words. Exclude text, logos, barcodes, status icons, and page chrome. Use null when no reliable product photo is visible. ' +
  'Each transactions entry must have postedDate (YYYY-MM-DD), description, signed amount (money out negative, money in positive), externalId if printed, and confidence. ' +
  'Reconcile arithmetic and statement balances. Never invent unreadable values; use null and add a warning.';

// The reference caps at max_tokens: 2400 -- task 4's investigation flagged
// this as a real, plausible truncation risk specifically for this app's
// contractor supply-house receipts, which can run 20+ line items each
// carrying 9 fields (description/nickname/sku/quantity/unitPrice/discount/
// subtotal/confidence x3/productImageRegion). Sized up accordingly; still
// far under this model's real output ceiling.
const MAX_TOKENS = 8000;
const MODEL = process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function reinaScanConfigured() {
  return Boolean(anthropic);
}

function stubScan(input) {
  // Matches the reference's own honest fallback shape exactly -- echoes
  // back whatever the caller already knew, never fabricates a vendor,
  // date, or amount that wasn't actually read from the document.
  return {
    documentType: input.documentType || 'other',
    vendor: input.vendor || '',
    transactionDate: input.transactionDate || '',
    dueDate: input.dueDate || '',
    subtotal: Number(input.subtotal) || 0,
    salesTaxTotal: Number(input.salesTaxTotal) || 0,
    salesTaxState: input.salesTaxState || '',
    total: Number(input.total) || 0,
    lineItems: input.lineItems || [],
    transactions: input.transactions || [],
    receiptText: input.receiptText || '',
    confidence: 0.45,
    fieldConfidence: {},
    warnings: ['ANTHROPIC_API_KEY is not configured for this deployment -- no document was actually read.'],
    needsAiConnection: true
  };
}

export function extractJson(text) {
  // Claude is asked for "ONLY JSON" but real responses sometimes wrap it
  // in a ```json fence, or add a short preamble -- strip a fence first,
  // then fall back to slicing the first {...last} block, same technique
  // the reference itself uses for its Tier 2 branch.
  const fenceStripped = String(text || '').replace(/^```json\s*|```$/g, '').trim();
  try {
    return JSON.parse(fenceStripped);
  } catch {
    const start = fenceStripped.indexOf('{');
    const end = fenceStripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Reina\'s scan response did not contain a parseable JSON object.');
    }
    return JSON.parse(fenceStripped.slice(start, end + 1));
  }
}

// input: { imageBase64, mimeType, documentType?, vendor?, transactionDate?,
// subtotal?, salesTaxTotal?, salesTaxState?, total?, lineItems?,
// transactions?, receiptText? } -- the optional fields are only used by
// the stub fallback (echoed back, never invented); a real scan ignores
// them and reads the actual document.
export async function scanReceiptWithReina(input = {}) {
  if (!input.imageBase64 || !input.mimeType) {
    throw new Error('imageBase64 and mimeType are required to scan a document.');
  }
  if (!anthropic) return stubScan(input);

  const isPdf = input.mimeType === 'application/pdf';
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 } };

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: [media, { type: 'text', text: CLASSIFICATION_PROMPT }] }]
  });

  const textBlock = (response.content || []).find(part => part.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('Reina\'s scan returned no readable content.');
  }
  return extractJson(textBlock.text);
}
