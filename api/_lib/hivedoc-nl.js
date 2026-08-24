// api/_lib/hivedoc-nl.js
//
// The natural-language layer over HiveDoc's file search. Chris types "latest
// invoice from Joe the plumber on the John Smith job" into Reina's quick tab;
// this turns that sentence into the filters api/hivedoc.js already accepts.
//
// IT DOES NOT SEARCH. That is the whole design constraint from the spec: there
// is one search implementation (api/_lib/hivedoc-search.js) and this module
// only translates English into its inputs. If matching behaviour needs to
// change, it changes there and both the typed Global Search bar and the spoken
// question change with it. Anything else and the two drift.
//
// Two parsers, in this order:
//
//   1. Claude, via the same Anthropic SDK the rest of Reina uses, with a forced
//      tool call so the result is a validated object rather than prose we have
//      to regex. This is the real parser.
//   2. A deterministic fallback that runs when ANTHROPIC_API_KEY is missing or
//      the model call fails. It handles the shapes that actually recur --
//      "photos of X", "permit for Y", "latest ... from VENDOR on the Z job" --
//      so file search degrades instead of dying. api/documents.js already uses
//      exactly this belt-and-braces shape for classification.
//
// Which one ran is reported back to the caller as `parsedBy`, because a
// fallback parse is measurably worse and the UI should be able to say so.

import { CATEGORIES, normalizeCategory } from './hivedoc-search.js';

export function hivedocNlModel() {
  return process.env.HIVEDOC_NL_MODEL || 'claude-opus-5';
}

const SYSTEM = [
  'You turn a contractor\'s plain-English question about their files into search filters.',
  'HiveLogic stores every file against a client, usually a job, and one category.',
  '',
  'Rules:',
  '- Extract only what the question actually says. Leave a field out rather than guessing it.',
  '- client is a person or company the work was done FOR ("John Smith", "Gorjana Jewelry").',
  '- vendor is a supplier/subcontractor the file came FROM ("Joe the Plumber"). A question',
  '  can have both: "invoice from Joe the plumber on the John Smith job" has client John',
  '  Smith and vendor Joe the Plumber. Never put a vendor in the client field.',
  '- job is the project name ("kitchen reno", "bathroom remodel"). Partial names are fine;',
  '  the search matches them fuzzily, so pass the words as written.',
  '- category must be one of: ' + CATEGORIES.join(', ') + '. Map naturally: "pictures"/"photos"',
  '  -> Photo, "bill" -> Invoice, "signed agreement"/"signed contract" -> Contract.',
  '- sort is "newest" unless the question asks for the earliest/oldest/first.',
  '  "latest", "most recent", "last" all mean newest.',
  '- q is for words that are none of the above and still worth matching on. Usually empty.',
].join('\n');

function parseTool() {
  return {
    name: 'file_search_filters',
    description: 'The structured filters that answer the question.',
    // strict + additionalProperties:false so the returned object validates
    // exactly and we never have to defend against a stray field downstream.
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        client: { type: ['string', 'null'], description: 'Client name, or null if none named.' },
        job: { type: ['string', 'null'], description: 'Job/project name as written, or null.' },
        category: { type: ['string', 'null'], enum: [...CATEGORIES, null], description: 'One category, or null.' },
        vendor: { type: ['string', 'null'], description: 'Vendor/subcontractor the file came from, or null.' },
        q: { type: ['string', 'null'], description: 'Leftover words worth matching, or null.' },
        sort: { type: 'string', enum: ['newest', 'oldest'], description: 'Result order.' },
      },
      required: ['client', 'job', 'category', 'vendor', 'q', 'sort'],
    },
  };
}

function cleanField(value) {
  if (value == null) return '';
  const s = String(value).trim();
  // The model occasionally echoes a literal "null"/"none" instead of the JSON
  // null the schema asks for; treat those as absent rather than searching for
  // a client actually named "null".
  if (!s || /^(null|none|n\/a|unknown|any)$/i.test(s)) return '';
  return s;
}

function toFilters(raw) {
  return {
    client: cleanField(raw.client),
    job: cleanField(raw.job),
    category: normalizeCategory(cleanField(raw.category)) || '',
    vendor: cleanField(raw.vendor),
    q: cleanField(raw.q),
    sort: raw.sort === 'oldest' ? 'oldest' : 'newest',
  };
}

// ---------------------------------------------------------------------------
// The deterministic fallback
// ---------------------------------------------------------------------------

const CATEGORY_WORDS = [
  [/\b(photos?|pictures?|pics?|images?|shots?)\b/i, 'Photo'],
  [/\b(permits?)\b/i, 'Permit'],
  [/\b(invoices?|bills?)\b/i, 'Invoice'],
  [/\b(receipts?)\b/i, 'Receipt'],
  [/\b(contracts?|agreements?)\b/i, 'Contract'],
  [/\b(estimates?|quotes?|proposals?)\b/i, 'Estimate'],
  [/\b(payroll|paystubs?|w-?2s?|1099s?)\b/i, 'Payroll'],
];

const OLDEST = /\b(oldest|earliest|first|original)\b/i;

// Words that introduce a job, a client, or a vendor. Order matters: the vendor
// clause is pulled out before the client clause, because "from Joe the plumber
// on the John Smith job" would otherwise hand "Joe the plumber on the..." to
// the client field.
const VENDOR_CLAUSE = /\bfrom\s+(.+?)(?=\s+\b(?:on|for|at|in)\b|$)/i;
const JOB_CLAUSE = /\b(?:on|for)\s+the\s+(.+?)\s+\b(?:job|project)\b/i;
const JOB_TRAILING = /\b(?:job|project)\b/i;
const CLIENT_CLAUSE = /\b(?:of|for|on)\s+(?:the\s+)?(.+?)(?=\s+\b(?:job|project)\b|$)/i;

const NOISE = /\b(the|a|an|me|my|our|show|find|get|pull|up|please|latest|most|recent|last|newest|oldest|earliest|first|all|any|every|files?|documents?|docs?)\b/gi;

function stripNoise(value) {
  return String(value || '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
}

export function fallbackParse(question) {
  const text = String(question || '').trim();
  const out = { client: '', job: '', category: '', vendor: '', q: '', sort: 'newest' };
  if (!text) return out;

  if (OLDEST.test(text)) out.sort = 'oldest';

  const catHit = CATEGORY_WORDS.find(([re]) => re.test(text));
  if (catHit) out.category = catHit[1];

  // Pull the vendor clause out first and remove it, so later clauses cannot
  // swallow it.
  let rest = text;
  const vendorMatch = VENDOR_CLAUSE.exec(rest);
  if (vendorMatch) {
    out.vendor = stripNoise(vendorMatch[1]);
    rest = rest.replace(vendorMatch[0], ' ');
  }

  // "on the kitchen reno job" -> job "kitchen reno"
  const jobMatch = JOB_CLAUSE.exec(rest);
  if (jobMatch) {
    out.job = stripNoise(jobMatch[1]);
    rest = rest.replace(jobMatch[0], ' ');
  }

  const clientMatch = CLIENT_CLAUSE.exec(rest);
  if (clientMatch) {
    let candidate = stripNoise(clientMatch[1]).replace(JOB_TRAILING, '').trim();
    // "photos of John Smith job" gives "John Smith"; "permit for the kitchen
    // reno" gives "kitchen reno", which is a job name, not a client. Without a
    // reliable way to tell them apart from grammar alone, a phrase that is not
    // capitalised like a name is treated as a job -- and when a job is already
    // known, the leftover is the client.
    if (candidate) {
      const looksLikeName = /^[A-Z][a-z]+(\s+[A-Z][a-z'.-]+)*$/.test(candidate);
      if (looksLikeName || out.job) out.client = candidate;
      else out.job = out.job || candidate;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// The real parser
// ---------------------------------------------------------------------------

async function claudeParse(question, anthropic) {
  const tool = parseTool();
  const resp = await anthropic.messages.create({
    model: hivedocNlModel(),
    max_tokens: 512,
    // Extraction from one short sentence -- there is nothing here that repays
    // deeper reasoning, and this call sits in front of a search box.
    output_config: { effort: 'low' },
    system: SYSTEM,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: String(question).slice(0, 500) }],
  });

  const call = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!call || !call.input) throw new Error('the file question came back unparsed');
  return call.input;
}

/**
 * Parse one plain-English file question into search filters.
 *
 * Returns { filters, parsedBy } where parsedBy is 'claude' or 'fallback'.
 * Never throws for a parse failure -- an unparseable question degrades to the
 * deterministic reading rather than erroring out a search box.
 */
export async function parseFileQuestion(question, deps = {}) {
  const anthropic = deps.anthropic || (await defaultAnthropic());
  if (anthropic) {
    try {
      return { filters: toFilters(await claudeParse(question, anthropic)), parsedBy: 'claude' };
    } catch (e) {
      // Logged, not swallowed silently: a model outage that quietly halves
      // search quality is exactly the kind of thing that goes unnoticed.
      console.error('HiveDoc NL parse fell back to the deterministic reader', { message: e?.message || 'unknown' });
    }
  }
  return { filters: toFilters(fallbackParse(question)), parsedBy: 'fallback' };
}

async function defaultAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch {
    return null;
  }
}

export const _internals = Object.freeze({ toFilters, cleanField, parseTool, SYSTEM });
