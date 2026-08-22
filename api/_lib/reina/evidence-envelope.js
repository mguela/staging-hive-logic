// api/_lib/reina/evidence-envelope.js
//
// Reina's strict evidence & transparency contract — the transport-neutral core
// of her first conversational slice.
//
// Reina is a read-only advisor. Every answer she returns to a human MUST be an
// *envelope* that makes her epistemic state explicit and impossible to skip:
// what she said, what evidence backs it, how fresh that evidence is (or that
// its freshness is unknown), what she is missing, where her sources conflict,
// what she is uncertain about, whether she refused and why, and — always — that
// she executed nothing. This module is the single place that validates and
// produces that envelope. It has no knowledge of HTTP, sockets, or any
// transport; it only takes plain data in and returns plain data out.
//
// Design stance (why this file is defensive to the point of paranoia):
//
//   1. The written answer, the evidence, and the "I did nothing" promise travel
//      together or not at all. A caller cannot construct a "successful" envelope
//      that omits any transparency dimension — omission is a validation error,
//      not a silent default that reads as "all clear".
//
//   2. Authority is never carried in the payload. A caller (or a compromised
//      transport, or a model coaxed into echoing an attacker's JSON) does not
//      get to assert a role, a company, an identity, a set of tools, a system
//      message, or — above all — that anything was executed. Those fields are
//      rejected on sight, never trusted, never merged. `executed` is a constant
//      `false` that this module writes itself.
//
//   3. Uncertainty is descriptive, not permissive. "I'm not sure" is data we
//      surface to the human; it is never a lever that unlocks an action, and we
//      never invent a numeric confidence or a threshold to gate behaviour on.
//      Attempts to smuggle a `confidence` / `threshold` field in are rejected.
//
//   4. The output is plain text destined for `.textContent`. Executable or
//      markup content in any string field is rejected; whatever survives is
//      stripped to inert prose. Nothing this module returns should be able to
//      run in a browser even if a caller later (wrongly) assigns it to
//      `.innerHTML`.
//
//   5. Errors are structured and sanitized. We return a stable error `code` and
//      a generic human message. We never leak stack traces, input echoes, or
//      internal field values that could help an attacker probe the contract.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ENVELOPE_VERSION = 'reina.answer.v1';

// The one and only execution statement. Reina executes nothing in this slice;
// the envelope says so in words a human can read, every time.
export const EXECUTION_STATEMENT =
  'Nothing was executed. This is a read-only answer; no action was taken and no data was changed.';

// How a piece of evidence is classified. This is the load-bearing distinction
// the contract demands: authorized real reads vs. synthetic/illustrative data.
export const DATA_CLASS = Object.freeze({
  AUTHORIZED_READ: 'authorized_read', // observed from a real, authorized source
  SYNTHETIC: 'synthetic',             // generated / illustrative / not a real read
});
const ALLOWED_DATA_CLASSES = new Set(Object.values(DATA_CLASS));

// Stable, enumerated error codes. Callers switch on these; humans read the
// generic message. Neither ever contains internal state.
export const ERROR_CODES = Object.freeze({
  MALFORMED: 'malformed',                       // input is not a usable object
  INCOMPLETE: 'incomplete',                     // a required transparency field is missing
  UNKNOWN_FIELD: 'unknown_field',               // an unrecognized field was supplied
  FORGED_AUTHORITY: 'forged_authority',         // client tried to assert authority/identity/role/etc.
  FALSE_EXECUTION_CLAIM: 'false_execution_claim', // client tried to claim something was executed
  INVALID_EVIDENCE: 'invalid_evidence',         // an evidence entry is malformed or unsourced
  INVALID_FRESHNESS: 'invalid_freshness',       // freshness claim is internally inconsistent
  INVALID_REFUSAL: 'invalid_refusal',           // refusal status/reason are inconsistent
  UNSAFE_CONTENT: 'unsafe_content',             // executable / unsafe markup detected
  INVALID_FIELD: 'invalid_field',               // a field has the wrong type/shape
});

// Fields a caller / transport / model MUST NOT supply. Every one of these is an
// attempt to assert authority, identity, execution, or a fabricated confidence
// gate. Presence anywhere in the input is a hard rejection, never a silent
// strip — masking an injection attempt is itself a failure mode.
const FORBIDDEN_KEYS = new Set([
  // identity / authority
  'authorization', 'authorized', 'auth', 'role', 'roles', 'permission',
  'permissions', 'scope', 'scopes', 'company', 'companyid', 'company_id',
  'org', 'orgid', 'org_id', 'tenant', 'tenantid', 'identity', 'user', 'userid',
  'user_id', 'actor', 'principal', 'credential', 'credentials', 'session',
  'sessionid', 'session_id', 'token', 'apikey', 'api_key', 'trusted',
  'verified', 'signed',
  // system / model control surface
  'system', 'systemmessage', 'system_message', 'systemprompt', 'system_prompt',
  'messages', 'tool', 'tools', 'toolcalls', 'tool_calls', 'function',
  'functions',
  // execution claims
  'executed', 'execute', 'execution', 'ran', 'performed', 'applied', 'committed',
  'action', 'actions', 'sideeffect', 'side_effect', 'sideeffects',
  // invented confidence gates — the contract forbids inventing thresholds
  'confidence', 'confidencethreshold', 'confidence_threshold', 'threshold',
  'thresholds', 'certainty',
]);

const ALLOWED_INPUT_KEYS = new Set([
  'answer', 'evidence', 'freshness', 'missingInformation',
  'conflictingInformation', 'uncertainty', 'refused', 'refusalReason',
]);

const ALLOWED_EVIDENCE_KEYS = new Set([
  'source', 'sourceType', 'dataClass', 'observedAt', 'asOf', 'detail',
  // `synthetic` is a derived boolean this module writes. It is accepted on
  // input only when it agrees with dataClass, so a re-validated envelope
  // round-trips while a client cannot use it to disguise synthetic data.
  'synthetic',
]);

const ALLOWED_CONFLICT_KEYS = new Set(['summary', 'sources']);

const ALLOWED_FRESHNESS_KEYS = new Set(['known', 'asOf', 'note']);

// One canonical timestamp grammar shared by the server and browser: complete
// UTC seconds with either no fractional part or exactly three milliseconds.
// Shape is not enough; isCanonicalUtcTimestamp also round-trips through Date so
// impossible calendar values can never masquerade as provenance/freshness.
const CANONICAL_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isCanonicalUtcTimestamp(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = value.includes('.') ? value : `${value.slice(0, -1)}.000Z`;
  try { return new Date(milliseconds).toISOString() === normalized; } catch { return false; }
}

// Patterns that mark a string as carrying executable or active markup. If any
// matches, the whole string is rejected (UNSAFE_CONTENT) rather than sanitized —
// we do not want to be in the business of "cleaning" an attack into something
// that looks fine.
const EXECUTABLE_PATTERNS = [
  /<\s*script\b/i,
  /<\s*\/\s*script\s*>/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
  /<\s*style\b/i,
  /<\s*link\b/i,
  /<\s*meta\b/i,
  /<\s*base\b/i,
  /<\s*form\b/i,
  /\son\w+\s*=/i,                 // inline event handler: onerror=, onload=, ...
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\s*\/\s*html/i,
  /data\s*:\s*[^,]*;\s*base64/i,  // base64 data URIs (opaque, treat as unsafe)
  /<\s*svg\b/i,
  /<\s*math\b/i,
  /&#x?0*(?:6a|106|4a|74)\b/i,    // html-entity-encoded 'j'/'J' (javascript: obfuscation)
];

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A structured, sanitized failure. `message` is intentionally generic; nothing
// derived from the offending input is ever placed in it.
function fail(code, message) {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) });
}

// True if `value` contains anything that could execute or inject markup.
function containsExecutableContent(value) {
  if (value == null) return false;
  const s = String(value);
  return EXECUTABLE_PATTERNS.some((re) => re.test(s));
}

// Coerce to inert plain text safe to assign to `.textContent`.
//   - strips any residual HTML/XML tags (defense in depth; overtly executable
//     content has already been rejected upstream),
//   - removes control characters (keeping only tab and newline),
//   - normalizes CRLF to LF,
//   - trims.
// The result contains no tags and no control chars, so it cannot open an
// element even if a caller later mis-renders it via innerHTML.
function sanitizeText(value) {
  if (value == null) return '';
  let s = String(value);
  s = s.replace(/\r\n?/g, '\n');          // CRLF / lone CR -> LF
  s = s.replace(/<[^>]*>/g, '');          // drop tag-like sequences
  s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ''); // drop control chars (keep \t, \n)
  return s.trim();
}

// Reject if any own key of `obj` (case-insensitively) is on the forbidden list.
// Returns an error result, or null if clean. `authorityCode` lets evidence-level
// checks share the top-level FORGED_AUTHORITY / FALSE_EXECUTION_CLAIM codes.
function checkForbiddenKeys(obj) {
  for (const key of Object.keys(obj)) {
    const norm = key.toLowerCase().replace(/[\s_-]/g, '');
    if (
      norm === 'executed' || norm === 'execute' || norm === 'execution' ||
      norm === 'ran' || norm === 'performed' || norm === 'applied' ||
      norm === 'committed' || norm === 'action' || norm === 'actions' ||
      norm === 'sideeffect' || norm === 'sideeffects'
    ) {
      return fail(
        ERROR_CODES.FALSE_EXECUTION_CLAIM,
        'Execution claims are not accepted; Reina executes nothing and sets this herself.',
      );
    }
    if (FORBIDDEN_KEYS.has(norm)) {
      return fail(
        ERROR_CODES.FORGED_AUTHORITY,
        'Authority, identity, role, system, tool, or confidence-threshold fields are not accepted from the caller.',
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field validators / normalizers (shared by build + validate)
// ---------------------------------------------------------------------------

// Validate & normalize a single evidence entry. Returns { entry } or { error }.
function normalizeEvidenceEntry(raw) {
  if (!isPlainObject(raw)) {
    return { error: fail(ERROR_CODES.INVALID_EVIDENCE, 'Each evidence entry must be an object.') };
  }
  const forbidden = checkForbiddenKeys(raw);
  if (forbidden) return { error: forbidden };

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_EVIDENCE_KEYS.has(key)) {
      return { error: fail(ERROR_CODES.INVALID_EVIDENCE, 'An evidence entry has an unrecognized field.') };
    }
  }

  // Unsafe content is rejected before anything else — a payload that would be
  // stripped to '' by sanitizeText must not be mistaken for a "missing source".
  if (containsExecutableContent(raw.source) ||
      (raw.sourceType != null && containsExecutableContent(raw.sourceType)) ||
      (raw.detail != null && containsExecutableContent(raw.detail))) {
    return { error: fail(ERROR_CODES.UNSAFE_CONTENT, 'Evidence contains unsafe or executable content.') };
  }

  // source — required, non-empty. A citation with no identifiable source is a
  // fabricated citation and is refused.
  if (typeof raw.source !== 'string' || sanitizeText(raw.source) === '') {
    return { error: fail(ERROR_CODES.INVALID_EVIDENCE, 'Each evidence entry must identify a non-empty source.') };
  }

  // dataClass — required, must clearly distinguish authorized reads from synthetic.
  if (!ALLOWED_DATA_CLASSES.has(raw.dataClass)) {
    return {
      error: fail(
        ERROR_CODES.INVALID_EVIDENCE,
        'Each evidence entry must declare dataClass "authorized_read" or "synthetic".',
      ),
    };
  }

  // A supplied `synthetic` flag must agree with dataClass — no disguising
  // synthetic data as an authorized read (or vice versa).
  if (raw.synthetic != null && raw.synthetic !== (raw.dataClass === DATA_CLASS.SYNTHETIC)) {
    return { error: fail(ERROR_CODES.INVALID_EVIDENCE, 'Evidence "synthetic" flag disagrees with its dataClass.') };
  }

  // sourceType — required, non-empty string.
  if (typeof raw.sourceType !== 'string' || sanitizeText(raw.sourceType) === '') {
    return { error: fail(ERROR_CODES.INVALID_EVIDENCE, 'Each evidence entry must declare a non-empty sourceType.') };
  }

  // observedAt / asOf — optional, but when present must look like a real time.
  for (const tk of ['observedAt', 'asOf']) {
    if (raw[tk] != null) {
      if (typeof raw[tk] !== 'string' || !isCanonicalUtcTimestamp(raw[tk].trim())) {
        return { error: fail(ERROR_CODES.INVALID_EVIDENCE, 'Evidence time (observedAt/asOf) must be an ISO-8601 timestamp when provided.') };
      }
    }
  }

  const entry = {
    source: sanitizeText(raw.source),
    sourceType: sanitizeText(raw.sourceType),
    dataClass: raw.dataClass,
    synthetic: raw.dataClass === DATA_CLASS.SYNTHETIC,
    observedAt: raw.observedAt != null ? raw.observedAt.trim() : null,
    asOf: raw.asOf != null ? raw.asOf.trim() : null,
    detail: raw.detail != null ? sanitizeText(raw.detail) : '',
  };
  return { entry };
}

function normalizeEvidenceList(raw) {
  if (!Array.isArray(raw)) {
    return { error: fail(ERROR_CODES.INVALID_FIELD, 'evidence must be an array.') };
  }
  const out = [];
  for (const item of raw) {
    const { entry, error } = normalizeEvidenceEntry(item);
    if (error) return { error };
    out.push(Object.freeze(entry));
  }
  return { list: out };
}

// freshness — either a known as-of time, or an explicit "freshness unknown".
// A caller may NOT claim freshness is known without supplying an as-of time;
// that would be a fabricated freshness claim.
function normalizeFreshness(raw) {
  if (raw == null) {
    return {
      value: {
        known: false,
        asOf: null,
        note: 'Freshness is unknown; no as-of time was recorded for this answer.',
      },
    };
  }
  if (!isPlainObject(raw)) {
    return { error: fail(ERROR_CODES.INVALID_FRESHNESS, 'freshness must be an object when provided.') };
  }
  const forbidden = checkForbiddenKeys(raw);
  if (forbidden) return { error: forbidden };
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FRESHNESS_KEYS.has(key)) {
      return { error: fail(ERROR_CODES.INVALID_FRESHNESS, 'freshness has an unrecognized field.') };
    }
  }
  if (typeof raw.known !== 'boolean') {
    return { error: fail(ERROR_CODES.INVALID_FRESHNESS, 'freshness.known must be a boolean.') };
  }
  if (raw.known) {
    if (typeof raw.asOf !== 'string' || !isCanonicalUtcTimestamp(raw.asOf.trim())) {
      return { error: fail(ERROR_CODES.INVALID_FRESHNESS, 'freshness.known=true requires an ISO-8601 asOf time.') };
    }
    return {
      value: {
        known: true,
        asOf: raw.asOf.trim(),
        note: raw.note != null ? sanitizeText(raw.note) : 'Data observed as of the stated time.',
      },
    };
  }
  // known === false: freshness is explicitly missing.
  if (raw.asOf != null) {
    return { error: fail(ERROR_CODES.INVALID_FRESHNESS, 'freshness.known=false must not carry an asOf time.') };
  }
  return {
    value: {
      known: false,
      asOf: null,
      note: raw.note != null && sanitizeText(raw.note) !== ''
        ? sanitizeText(raw.note)
        : 'Freshness is unknown; no as-of time was recorded for this answer.',
    },
  };
}

// A list of short plain-text statements (missingInformation, uncertainty).
function normalizeStatementList(raw, fieldName) {
  if (raw == null) return { list: [] };
  if (!Array.isArray(raw)) {
    return { error: fail(ERROR_CODES.INVALID_FIELD, `${fieldName} must be an array of strings.`) };
  }
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { error: fail(ERROR_CODES.INVALID_FIELD, `${fieldName} must contain only strings.`) };
    }
    if (containsExecutableContent(item)) {
      return { error: fail(ERROR_CODES.UNSAFE_CONTENT, `${fieldName} contains unsafe or executable content.`) };
    }
    const clean = sanitizeText(item);
    if (clean !== '') out.push(clean);
  }
  return { list: out };
}

// conflictingInformation — each entry names the conflict and the sources.
function normalizeConflicts(raw) {
  if (raw == null) return { list: [] };
  if (!Array.isArray(raw)) {
    return { error: fail(ERROR_CODES.INVALID_FIELD, 'conflictingInformation must be an array.') };
  }
  const out = [];
  for (const item of raw) {
    if (!isPlainObject(item)) {
      return { error: fail(ERROR_CODES.INVALID_FIELD, 'Each conflictingInformation entry must be an object.') };
    }
    const forbidden = checkForbiddenKeys(item);
    if (forbidden) return { error: forbidden };
    for (const key of Object.keys(item)) {
      if (!ALLOWED_CONFLICT_KEYS.has(key)) {
        return { error: fail(ERROR_CODES.INVALID_FIELD, 'A conflictingInformation entry has an unrecognized field.') };
      }
    }
    if (containsExecutableContent(item.summary)) {
      return { error: fail(ERROR_CODES.UNSAFE_CONTENT, 'conflictingInformation contains unsafe or executable content.') };
    }
    if (typeof item.summary !== 'string' || sanitizeText(item.summary) === '') {
      return { error: fail(ERROR_CODES.INVALID_FIELD, 'Each conflictingInformation entry needs a non-empty summary.') };
    }
    let sources = [];
    if (item.sources != null) {
      if (!Array.isArray(item.sources)) {
        return { error: fail(ERROR_CODES.INVALID_FIELD, 'conflictingInformation.sources must be an array of strings.') };
      }
      for (const s of item.sources) {
        if (typeof s !== 'string') {
          return { error: fail(ERROR_CODES.INVALID_FIELD, 'conflictingInformation.sources must contain only strings.') };
        }
        if (containsExecutableContent(s)) {
          return { error: fail(ERROR_CODES.UNSAFE_CONTENT, 'conflictingInformation contains unsafe or executable content.') };
        }
        const clean = sanitizeText(s);
        if (clean !== '') sources.push(clean);
      }
    }
    out.push(Object.freeze({ summary: sanitizeText(item.summary), sources: Object.freeze(sources) }));
  }
  return { list: out };
}

// ---------------------------------------------------------------------------
// Public: buildEnvelope
// ---------------------------------------------------------------------------

/**
 * Build a validated, sanitized answer envelope from trusted server-side inputs.
 *
 * The caller supplies ONLY epistemic content — never authority, identity, or
 * execution claims. This function writes `executed: false` and the execution
 * statement itself; it rejects any attempt to supply them.
 *
 * @param {object} input
 * @param {string}  input.answer                    the written answer (required)
 * @param {Array}   [input.evidence]                evidence/provenance entries
 * @param {object}  [input.freshness]               { known, asOf?, note? }
 * @param {string[]}[input.missingInformation]      what Reina does not know
 * @param {Array}   [input.conflictingInformation]  [{ summary, sources }]
 * @param {string[]}[input.uncertainty]             descriptive uncertainty notes
 * @param {boolean} [input.refused]                 whether Reina refused
 * @param {string}  [input.refusalReason]           required iff refused === true
 * @returns {{ok:true, envelope:object} | {ok:false, error:{code,message}}}
 */
export function buildEnvelope(input) {
  if (!isPlainObject(input)) {
    return fail(ERROR_CODES.MALFORMED, 'Envelope input must be an object.');
  }

  // 1. Refuse forged authority / execution claims BEFORE anything else.
  const forbidden = checkForbiddenKeys(input);
  if (forbidden) return forbidden;

  // 2. Reject unknown fields — an incomplete/typo'd contract is denied loudly.
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return fail(ERROR_CODES.UNKNOWN_FIELD, 'Envelope input contains an unrecognized field.');
    }
  }

  // 3. answer — required, non-empty, inert.
  if (typeof input.answer !== 'string') {
    return fail(ERROR_CODES.INCOMPLETE, 'A written answer is required.');
  }
  if (containsExecutableContent(input.answer)) {
    return fail(ERROR_CODES.UNSAFE_CONTENT, 'The answer contains unsafe or executable content.');
  }
  const answer = sanitizeText(input.answer);
  if (answer === '') {
    return fail(ERROR_CODES.INCOMPLETE, 'A non-empty written answer is required.');
  }

  // 4. refusal status + reason.
  const refused = input.refused === true;
  if (input.refused != null && typeof input.refused !== 'boolean') {
    return fail(ERROR_CODES.INVALID_REFUSAL, 'refused must be a boolean.');
  }
  let refusalReason = null;
  if (refused) {
    if (typeof input.refusalReason !== 'string' || sanitizeText(input.refusalReason) === '') {
      return fail(ERROR_CODES.INVALID_REFUSAL, 'A refusal requires a non-empty reason.');
    }
    if (containsExecutableContent(input.refusalReason)) {
      return fail(ERROR_CODES.UNSAFE_CONTENT, 'The refusal reason contains unsafe or executable content.');
    }
    refusalReason = sanitizeText(input.refusalReason);
  } else if (input.refusalReason != null) {
    return fail(ERROR_CODES.INVALID_REFUSAL, 'refusalReason must only be present when refused is true.');
  }

  // 5. evidence / freshness / missing / conflicts / uncertainty.
  const ev = normalizeEvidenceList(input.evidence == null ? [] : input.evidence);
  if (ev.error) return ev.error;

  const fr = normalizeFreshness(input.freshness);
  if (fr.error) return fr.error;

  const missing = normalizeStatementList(input.missingInformation, 'missingInformation');
  if (missing.error) return missing.error;

  const conflicts = normalizeConflicts(input.conflictingInformation);
  if (conflicts.error) return conflicts.error;

  const uncertainty = normalizeStatementList(input.uncertainty, 'uncertainty');
  if (uncertainty.error) return uncertainty.error;

  // 6. Assemble. executed / executionStatement are OURS, never the caller's.
  const envelope = Object.freeze({
    version: ENVELOPE_VERSION,
    answer,
    evidence: Object.freeze(ev.list),
    freshness: Object.freeze(fr.value),
    missingInformation: Object.freeze(missing.list),
    conflictingInformation: Object.freeze(conflicts.list),
    uncertainty: Object.freeze(uncertainty.list),
    refused,
    refusalReason,
    executed: false,
    executionStatement: EXECUTION_STATEMENT,
  });

  return Object.freeze({ ok: true, envelope });
}

// ---------------------------------------------------------------------------
// Public: validateEnvelope
// ---------------------------------------------------------------------------

/**
 * Validate an already-shaped envelope — e.g. one that has crossed a transport,
 * been JSON round-tripped, or been reconstructed from model output — before it
 * is trusted or rendered. This is the fail-closed gate: a tampered envelope
 * that claims `executed: true`, drops a required transparency field, or smuggles
 * authority/unsafe content is rejected.
 *
 * On success it returns a freshly re-normalized, deep-frozen envelope built from
 * the candidate's own fields, so the returned object is guaranteed to satisfy
 * every invariant regardless of what the candidate looked like.
 *
 * @param {object} candidate
 * @returns {{ok:true, envelope:object} | {ok:false, error:{code,message}}}
 */
export function validateEnvelope(candidate) {
  if (!isPlainObject(candidate)) {
    return fail(ERROR_CODES.MALFORMED, 'Envelope must be an object.');
  }

  // executed MUST be present and MUST be false. A missing or truthy value is a
  // false execution claim — the single most dangerous tamper.
  if (!('executed' in candidate) || candidate.executed !== false) {
    return fail(
      ERROR_CODES.FALSE_EXECUTION_CLAIM,
      'Envelope must explicitly state executed: false.',
    );
  }
  if (candidate.executionStatement !== EXECUTION_STATEMENT) {
    return fail(
      ERROR_CODES.INCOMPLETE,
      'Envelope must carry the exact "nothing was executed" statement.',
    );
  }
  if (candidate.version !== ENVELOPE_VERSION) {
    return fail(ERROR_CODES.INCOMPLETE, 'Envelope version is missing or unrecognized.');
  }

  // Every transparency dimension must be present. Absence is INCOMPLETE, not a
  // silent default — an envelope missing "conflicting information" must not read
  // as "no conflicts".
  const required = [
    'answer', 'evidence', 'freshness', 'missingInformation',
    'conflictingInformation', 'uncertainty', 'refused',
  ];
  for (const field of required) {
    if (!(field in candidate)) {
      return fail(ERROR_CODES.INCOMPLETE, 'Envelope is missing a required transparency field.');
    }
  }
  if (!('refusalReason' in candidate)) {
    return fail(ERROR_CODES.INCOMPLETE, 'Envelope is missing a required transparency field.');
  }

  // Rebuild through the same strict path used for construction. This re-checks
  // forged authority, unsafe content, evidence sourcing, freshness consistency,
  // and refusal consistency — and returns a guaranteed-clean envelope.
  return buildEnvelope({
    answer: candidate.answer,
    evidence: candidate.evidence,
    freshness: candidate.freshness,
    missingInformation: candidate.missingInformation,
    conflictingInformation: candidate.conflictingInformation,
    uncertainty: candidate.uncertainty,
    refused: candidate.refused,
    ...(candidate.refused === true ? { refusalReason: candidate.refusalReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Public: renderPlainText
// ---------------------------------------------------------------------------

/**
 * Render an envelope to a plain-text block safe for `.textContent`. Every line
 * is already-sanitized prose; the output contains no tags and no control chars.
 * This is a convenience for transports that show Reina's answer as text — it
 * never introduces markup.
 *
 * @param {object} envelope  an envelope returned by buildEnvelope/validateEnvelope
 * @returns {string}
 */
export function renderPlainText(envelope) {
  if (!isPlainObject(envelope)) return '';
  const lines = [];

  if (envelope.refused) {
    lines.push('REFUSED');
    lines.push(`Reason: ${sanitizeText(envelope.refusalReason)}`);
    lines.push('');
  }

  lines.push(sanitizeText(envelope.answer));
  lines.push('');

  // Evidence — synthetic entries are labelled so they can never be mistaken for
  // authorized real reads.
  lines.push('Evidence:');
  if (!Array.isArray(envelope.evidence) || envelope.evidence.length === 0) {
    lines.push('  (none cited)');
  } else {
    for (const e of envelope.evidence) {
      const tag = e.dataClass === DATA_CLASS.SYNTHETIC ? '[SYNTHETIC] ' : '[authorized read] ';
      const when = e.observedAt ? ` (observed ${sanitizeText(e.observedAt)})`
        : e.asOf ? ` (as of ${sanitizeText(e.asOf)})`
        : ' (no observed/as-of time)';
      const detail = e.detail ? ` — ${sanitizeText(e.detail)}` : '';
      lines.push(`  - ${tag}${sanitizeText(e.source)} [${sanitizeText(e.sourceType)}]${when}${detail}`);
    }
  }
  lines.push('');

  // Freshness.
  if (envelope.freshness && envelope.freshness.known) {
    lines.push(`Freshness: data as of ${sanitizeText(envelope.freshness.asOf)}.`);
  } else {
    lines.push(`Freshness: ${sanitizeText(envelope.freshness ? envelope.freshness.note : '') || 'unknown.'}`);
  }
  lines.push('');

  lines.push('Missing information:');
  if (!Array.isArray(envelope.missingInformation) || envelope.missingInformation.length === 0) {
    lines.push('  (none noted)');
  } else {
    for (const m of envelope.missingInformation) lines.push(`  - ${sanitizeText(m)}`);
  }
  lines.push('');

  lines.push('Conflicting information:');
  if (!Array.isArray(envelope.conflictingInformation) || envelope.conflictingInformation.length === 0) {
    lines.push('  (none found)');
  } else {
    for (const c of envelope.conflictingInformation) {
      const srcs = Array.isArray(c.sources) && c.sources.length
        ? ` [sources: ${c.sources.map(sanitizeText).join(', ')}]`
        : '';
      lines.push(`  - ${sanitizeText(c.summary)}${srcs}`);
    }
  }
  lines.push('');

  lines.push('Uncertainty:');
  if (!Array.isArray(envelope.uncertainty) || envelope.uncertainty.length === 0) {
    lines.push('  (none noted)');
  } else {
    for (const u of envelope.uncertainty) lines.push(`  - ${sanitizeText(u)}`);
  }
  lines.push('');

  lines.push(sanitizeText(envelope.executionStatement || EXECUTION_STATEMENT));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Also exported for reuse / testing.
// ---------------------------------------------------------------------------

export { sanitizeText, containsExecutableContent };
