import { buildEnvelope } from './evidence-envelope.js';

const MAX_TEXT = 4_000;

// This is a refusal boundary, not an intent router. It recognizes only an
// action-seeking prefix and never turns advisory questions into authority.
const ACTION_VERBS = '(?:send|reply|forward|mark|schedule|reschedule|book|confirm|cancel|pay|settle|transfer|wire|refund|issue|void|charge|delete|remove|update|change|edit|create|add|rename|post|publish|share|download|export|deploy|sign|call|text|email|notify|approve|reject|accept|submit|execute|dispatch|assign|close|complete|archive|upload|move|run\\s+automation|invite|hire|fire|clock|contact|remind|reconcile|generate|print|place|order|purchase)';
const COMPLETED_ACTION_VERBS = '(?:sent|replied|forwarded|marked|scheduled|rescheduled|booked|confirmed|cancelled|paid|settled|transferred|wired|refunded|issued|voided|charged|deleted|removed|updated|changed|edited|created|added|renamed|posted|published|shared|downloaded|exported|deployed|signed|called|texted|emailed|notified|approved|rejected|accepted|submitted|executed|dispatched|assigned|closed|completed|archived|uploaded|moved|processed|invited|hired|fired|clocked|contacted|reminded|reconciled|generated|printed|placed|ordered|purchased)';
const ACTION_PREFIX = new RegExp('^\\s*(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+(?:you|reina)\\s+(?:please\\s+)?|i(?:[\\u2019\']d|\\s+would)\\s+like\\s+you\\s+to\\s+|i\\s+(?:want|need)\\s+you\\s+to\\s+|let\\s+us\\s+)?' + ACTION_VERBS + '\\b', 'iu');
const ACTION_AFTER_CONNECTOR = new RegExp('(?:\\b(?:and|then|also|after\\s+that)\\s+|[,;]\\s*|\\bthen\\s+when\\s+ready\\s+)(?:(?:please|kindly)\\s+)?' + ACTION_VERBS + '\\b', 'iu');
const ACTION_DELEGATION = /^(?:\s*)(?:make\s+sure\b[^.?!]{0,160}\b(?:gets?\s+)?(?:paid|sent|scheduled|booked|confirmed|closed)|take\s+care\s+of\b|have\b[^.?!]{0,120}\b(?:sent|paid|scheduled|booked|confirmed|dispatched|closed)|please\s+take\s+care\s+of\b)/iu;
const ACTION_PASSIVE_REQUEST = /^(?:\s*)(?:can|could|would|will)\s+(?:the|this|that|your)\b[^.?!]{0,160}\b(?:be|get)\s+(?:sent|paid|settled|transferred|refunded|deleted|updated|created|added|renamed|shared|downloaded|exported|deployed|signed|scheduled|booked|confirmed|approved|submitted|dispatched|assigned|closed|completed|archived|uploaded|moved)\b/iu;
const ACTION_CONFIRMATION = new RegExp(
  '^\\s*(?:(?:yes(?:\\s+please)?|ok(?:ay)?|sure)(?:[,;\\s]+(?:do\\s+it|go\\s+ahead|' + ACTION_VERBS.slice(3, -1) + '))?|go\\s+ahead|do\\s+it|proceed|please\\s+take\\s+care\\s+of\\s+it)\\s*[.!?]*\\s*$',
  'iu',
);
const RESULT_ENTITY = '(?:(?:the|your|that|this)\\s+)?(?:e-?mail|message|invoice|payment|transfer|wire|funds?|refund|charge|visit|job|appointment|order|upload|post|automation|customer|crew|quote|bid|report|user|employee)|it';
const RESULT_STATE = '(?:sent|delivered|paid|settled|complete|completed|successful|succeeded|processed|refunded|charged|scheduled|booked|confirmed|cancelled|closed|archived|uploaded|posted|approved|accepted|executed|dispatched|transferred|run|ran|emailed|notified|invited|hired|fired|clocked|contacted|reminded|reconciled|generated|printed|placed|ordered)';
const ACTION_COMPLETION_PATTERNS = Object.freeze([
  new RegExp('\\b(?:i|we|reina)\\s*(?:(?:have\\s+|[\\u2019\']ve\\s*)?(?:(?:just|already|successfully)\\s+)*(?:went\\s+ahead\\s+and\\s+)?)?' + COMPLETED_ACTION_VERBS + '\\b', 'iu'),
  new RegExp('\\b(?:i|we|reina)\\s+did\\s+' + ACTION_VERBS + '\\b', 'iu'),
  /\b(?:i|we|reina)(?:(?:\s+have)|[\u2019']ve)?\s+(?:(?:just|already|successfully)\s+)*(?:processed\s+the\s+refund|made\s+the\s+payment|(?:took|taken)\s+care\s+of\s+(?:it|the\s+(?:payment|invoice|e-?mail|message|refund|job|visit))|completed\s+the\s+payment)/iu,
  new RegExp('\\b(?:' + RESULT_ENTITY + ')(?:[\\u2019\']s\\s+been\\s+|\\s+(?:(?:has|have)\\s+(?:been\\s+)?|(?:was|were|is|are)\\s+(?:now\\s+)?))' + RESULT_STATE + '\\b', 'iu'),
  new RegExp('\\b(?:' + RESULT_ENTITY + ')\\s*(?:[-\\u2010-\\u2015]\\s*)?' + RESULT_STATE + '(?:\\s+successfully)?\\b', 'iu'),
  new RegExp('\\b(?:' + RESULT_ENTITY + ')\\s+(?:went\\s+(?:out|through)|is\\s+confirmed)\\b', 'iu'),
  new RegExp('\\b(?:' + RESULT_ENTITY + ')\\s+(?:is|are)\\s+on\\s+(?:its|the)\\s+way\\b', 'iu'),
  new RegExp('(?:^|[.!?]\\s+)(?:done|successfully)[.!:\\s\\u2014-]+(?:(?:i|we|reina)\\s+)?' + COMPLETED_ACTION_VERBS + '\\b', 'iu'),
  /\b(?:payment|transfer|refund|charge|automation)\s*[:\-\u2014]?\s*(?:complete|completed|successful|succeeded|processed|ran)\b/iu,
  /\b(?:that(?:[\u2019']s|\s+is)|it(?:[\u2019']s|\s+is))\s+(?:done|complete|completed|settled|sent|paid|scheduled|closed)\b/iu,
  /\ball\s+set\b[^.\n]{0,120}\b(?:calendar|scheduled|booked|confirmed|closed|sent|paid|done)\b/iu,
  /(?:^|[.!?]\s+)completed\s+successfully\b/iu,
  /\b(?:sam|alex|the\s+(?:customer|employee|user|bid|report|invoice|order))\s+(?:was|has\s+been)\s+(?:accepted|hired|fired|invited|clocked|contacted|reminded|reconciled|generated|printed|placed)\b/iu,
]);

function detectionText(value) {
  try {
    return value.normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
      .replace(/[\u2010-\u2015]/g, '-');
  } catch {
    return null;
  }
}

export function isActionSeekingText(value) {
  return typeof value === 'string'
    && value.length > 0
    && (() => {
      const normalized = detectionText(value);
      return normalized !== null && (ACTION_PREFIX.test(normalized)
        || ACTION_AFTER_CONNECTOR.test(normalized)
        || ACTION_DELEGATION.test(normalized)
        || ACTION_PASSIVE_REQUEST.test(normalized)
        || ACTION_CONFIRMATION.test(normalized));
    })();
}

export function containsActionCompletionClaim(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalized = detectionText(value);
  return normalized !== null && ACTION_COMPLETION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function buildActionRefusalEnvelope() {
  const built = buildEnvelope({
    answer: 'I can explain what I found and suggest a next step, but I cannot perform that action in this read-only pilot.',
    evidence: [{
      source: 'Reina synthetic pilot policy',
      sourceType: 'server_policy',
      dataClass: 'synthetic',
      detail: 'The finite pilot registry contains no mutation, communication, scheduling, payment, tool, or Automation operation.',
    }],
    freshness: {
      known: false,
      note: 'No data source was consulted because the request asked for an action.',
    },
    missingInformation: [],
    conflictingInformation: [],
    uncertainty: [
      'The request was stopped at the server action boundary before any model or read adapter ran.',
    ],
    refused: true,
    refusalReason: 'Business actions, communications, scheduling changes, payments, tools, and Automation are not permitted in this pilot.',
  });
  return built.ok ? built.envelope : null;
}

export const _internals = Object.freeze({
  ACTION_PREFIX,
  ACTION_AFTER_CONNECTOR,
  ACTION_DELEGATION,
  ACTION_PASSIVE_REQUEST,
  ACTION_CONFIRMATION,
  ACTION_COMPLETION_PATTERNS,
  MAX_TEXT,
});
