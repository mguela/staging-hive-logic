// api/_lib/reina-plan-read.js
//
// HiveGrid Live Workbench -- "REINA READS SHEET" / "READ ALL SHEETS". Reads
// one already-rendered plan sheet image and asks Reina to describe what's on
// it: rooms, dimensions, symbols by trade, fixtures, notes, and candidate
// takeoff line items with an estimated quantity.
//
// Deliberately mirrors server/bookkeeping/src/reina-scan.js's Tier-3 pattern
// (call Anthropic directly, using the ANTHROPIC_API_KEY already configured
// and proven live by api/chat.js / receipt-scan.js) rather than introducing a
// second AI-calling convention. Not reused directly because that module's
// prompt and output shape are receipt/statement-specific (vendor, subtotal,
// lineItems with SKUs) -- a plan sheet has none of those fields and needs its
// own construction-reading prompt. The generic JSON-extraction helper is
// small enough to keep local rather than reaching into the bookkeeping
// domain's internals from an unrelated feature.
//
// SAFETY: this module only reads and returns a description. It never writes
// to the takeoffs table, never pushes a mark or condition, and never touches
// WBCONDS/WB.marks -- every field it returns is a suggestion for a human to
// review. Never invents a room, dimension, symbol count, or quantity that
// is not visible on the sheet; an unreadable/blank sheet gets an honest
// "unreadable" drawingType, not a guessed one.

import Anthropic from '@anthropic-ai/sdk';

const PLAN_READ_PROMPT =
  'Act as the HiveLogic construction takeoff reader (Reina). You are reading ONE sheet from a contractor\'s construction plan set. ' +
  'Describe only what is actually visible on this sheet -- never invent a room, dimension, symbol, or quantity that is not there. ' +
  'Return ONLY JSON with: sheetNumber (string from the sheet\'s own title block, or null), sheetTitle (string, or null), ' +
  'drawingType (one of floor_plan, electrical, plumbing, elevation, section, detail, demolition, site_plan, structural, mechanical, finish_schedule, cover, other, unreadable), ' +
  'rooms (array of {name, notes}), dimensions (array of short dimension-callout strings), ' +
  'symbols (array of {label, trade, count, notes} for distinct symbol types you can actually count), ' +
  'doors (array of {type, count}), windows (array of {type, count}), cabinets (array of {run, notes}), ' +
  'flooring (array of {area, material, notes}), demolition (array of {area, notes} for existing-to-be-removed items), ' +
  'existingVsNew (short note on how existing vs. new construction is indicated, or null), ' +
  'fixtures (array of {type, trade, count, notes}), materials (array of {name, notes}), notes (array of short general/spec note strings), ' +
  'takeoffCandidates (array of {name, type, unit, trade, estimatedQty, confidence, notes} -- type is one of count/linear/area, unit is one of EA/LF/SF, trade is one of GEN/CARP/ELEC/PLUMB/TILE/PAINT/VENDOR, estimatedQty is a number or null, confidence is 0-1 -- these are suggestions only and are never saved automatically), ' +
  'issues (array of short strings describing illegible areas, missing scale, or ambiguous symbols), ' +
  'confidence (0-1 overall), warnings (array of short strings). ' +
  'Use drawingType "unreadable" -- and leave every array empty -- when the image is blank, too degraded, cut off, or is not actually a construction drawing you can confidently read. ' +
  'When you are not sure of an exact count, say so honestly in confidence/notes rather than presenting a guess as certain.';

const MAX_TOKENS = 6000;
const MODEL = process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function reinaPlanReadConfigured() {
  return Boolean(anthropic);
}

function stubRead() {
  return {
    sheetNumber: null,
    sheetTitle: null,
    drawingType: 'other',
    rooms: [], dimensions: [], symbols: [], doors: [], windows: [], cabinets: [],
    flooring: [], demolition: [], existingVsNew: null, fixtures: [], materials: [],
    notes: [], takeoffCandidates: [], issues: [],
    confidence: 0,
    warnings: ['ANTHROPIC_API_KEY is not configured for this deployment -- no sheet was actually read.'],
    needsAiConnection: true,
  };
}

// Claude is asked for "ONLY JSON" but real responses sometimes wrap it in a
// ```json fence, or add a short preamble -- strip a fence first, then fall
// back to slicing the first {...last} block.
export function extractJson(text) {
  const fenceStripped = String(text || '').replace(/^```json\s*|```$/g, '').trim();
  try {
    return JSON.parse(fenceStripped);
  } catch {
    const start = fenceStripped.indexOf('{');
    const end = fenceStripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Reina\'s sheet-read response did not contain a parseable JSON object.');
    }
    return JSON.parse(fenceStripped.slice(start, end + 1));
  }
}

// input: { imageBase64, mimeType }
export async function scanPlanSheetWithReina(input = {}) {
  if (!input.imageBase64 || !input.mimeType) {
    throw new Error('imageBase64 and mimeType are required to read a plan sheet.');
  }
  if (!anthropic) return stubRead();

  const isPdf = input.mimeType === 'application/pdf';
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 } };

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: [media, { type: 'text', text: PLAN_READ_PROMPT }] }],
  });

  const textBlock = (response.content || []).find((part) => part.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('Reina\'s sheet read returned no readable content.');
  }
  return extractJson(textBlock.text);
}

// Runs scanPlanSheetWithReina over several sheets with limited concurrency --
// "Read All Sheets" must not fire one Anthropic call per sheet all at once,
// and one bad sheet must never take the rest of the batch down with it.
// sheets: [{ index, name, imageBase64, mimeType }]
// returns: [{ index, name, ok, analysis? , error? }] in the same order given.
export async function readPlanSheetsWithReina(sheets, { concurrency = 3 } = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      const s = list[i];
      try {
        const analysis = await scanPlanSheetWithReina({ imageBase64: s.imageBase64, mimeType: s.mimeType });
        results[i] = { index: s.index, name: s.name, ok: true, analysis };
      } catch (error) {
        results[i] = { index: s.index, name: s.name, ok: false, error: error.message || 'Reina could not read this sheet.' };
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker);
  await Promise.all(workers);
  return results;
}
