/* public/reina-pilot-client.js
 *
 * Strict browser transport for the Reina read-only pilot. This is the single
 * client-side network seam shared by PR #84's typed controller and PR #86's
 * Voice adapter. It is deliberately not an authority boundary: it sends only
 * the current utterance and opaque turn identifiers, while the server derives
 * identity, role, capabilities, data access, tools, and evidence from the
 * authenticated Bearer session.
 *
 * Classic UMD: `window.ReinaPilotClient` in a browser and `module.exports` in
 * focused Node tests. No DOM APIs, HTML interpreters, navigation, microphone,
 * speech, business actions, or storage writes are used here.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaPilotClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var ENDPOINT = '/api/reina-pilot';
  var TRANSCRIPTION_ENDPOINT = '/api/reina-transcribe';
  var VOICE_DIAGNOSTIC_ENDPOINT = '/api/reina-voice-diagnostic';
  // How long any single token acquisition may take before the attempt is
  // abandoned with a name. Generous next to a real session read; finite next to
  // a lock that never releases.
  var TOKEN_DEADLINE_MS = 8000;
  var ENVELOPE_VERSION = 'reina.answer.v1';
  var EXECUTION_STATEMENT =
    'Nothing was executed. This is a read-only answer; no action was taken and no data was changed.';
  var REQUEST_KEYS = Object.freeze([
    'utterance', 'conversationId', 'turnId', 'idempotencyKey', 'transport',
  ]);
  var CONFIRM_RESPONSE_KEYS = Object.freeze([
    'ok', 'confirmed', 'intentId', 'executed', 'nothingExecuted',
    'businessActionAllowed', 'automationTaskAllowed', 'toolExecutionAllowed',
  ]);
  var BOOTSTRAP_KEYS = Object.freeze([
    'ok', 'sessionId', 'generatedAt', 'user', 'attention', 'review', 'uiIntent', 'executed',
  ]);
  var REVIEW_KEYS = Object.freeze(['intentId', 'available', 'expiresAt']);
  var UI_INTENT_KEYS = Object.freeze([
    'version', 'executed', 'requiresConfirmation', 'conversationId', 'turnId',
    'intentId', 'expiresAt', 'kind', 'destination', 'parameters',
  ]);
  var RESPONSE_KEYS = Object.freeze([
    'ok', 'enabled', 'stored', 'conversationId', 'turnId', 'idempotencyKey',
    'replayed', 'executed', 'nothingExecuted', 'businessActionAllowed',
    'automationTaskAllowed', 'toolExecutionAllowed', 'synthetic', 'dataAccess',
    'reviewAvailable', 'envelope', 'plainText', 'navigation',
  ]);
  var ENVELOPE_KEYS = Object.freeze([
    'version', 'answer', 'evidence', 'freshness', 'missingInformation',
    'conflictingInformation', 'uncertainty', 'refused', 'refusalReason',
    'executed', 'executionStatement',
  ]);
  var EVIDENCE_KEYS = Object.freeze([
    'source', 'sourceType', 'dataClass', 'synthetic', 'observedAt', 'asOf', 'detail',
  ]);
  var FRESHNESS_KEYS = Object.freeze(['known', 'asOf', 'note']);
  var CONFLICT_KEYS = Object.freeze(['summary', 'sources']);
  var NAVIGATION_KEYS = Object.freeze(['type', 'target', 'requiresExplicitUserIntent']);

  var MAX_UTTERANCE = 4000;
  var MAX_ID = 200;
  var SERVER_SESSION_RE = /^rp\.[0-9a-f]{64}$/;
  var MAX_RAW_IDEMPOTENCY = 1024;
  var MAX_RESPONSE_CHARS = 262144;
  var MAX_VOICE_AUDIO_BYTES = 2 * 1024 * 1024;
  var MAX_PLAIN_TEXT = 131072;
  var MAX_EVIDENCE = 64;
  var MAX_LIST = 64;
  var MAX_SOURCE_LIST = 16;
  var MAX_BINDINGS = 2048;
  var DEFAULT_TIMEOUT_MS = 15000;
  var MAX_TIMEOUT_MS = 30000;
  var SAFE_NORMALIZED_KEY_RE = /^rt\.[0-9a-f]{64}$/;
  var SAFE_REVIEW_INTENT_RE = /^rui\.[A-Za-z0-9._:-]{1,124}$/;
  var CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  var CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F]/;
  var EXECUTABLE_PATTERNS = Object.freeze([
    /<\s*script\b/i, /<\s*\/\s*script\s*>/i, /<\s*iframe\b/i,
    /<\s*object\b/i, /<\s*embed\b/i, /<\s*style\b/i,
    /<\s*link\b/i, /<\s*meta\b/i, /<\s*base\b/i,
    /<\s*form\b/i, /<\s*img\b/i, /\son\w+\s*=/i,
    /javascript\s*:/i, /vbscript\s*:/i,
    /data\s*:\s*text\s*\/\s*html/i, /data\s*:\s*[^,]*;\s*base64/i,
    /<\s*svg\b/i, /<\s*math\b/i,
    /&#x?0*(?:6a|106|4a|74)\b/i,
  ]);

  function captureRootFunction(name) {
    try {
      var descriptor = Object.getOwnPropertyDescriptor(root, name);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || typeof descriptor.value !== 'function') return null;
      return Function.prototype.bind.call(descriptor.value, root);
    } catch (_) {
      return null;
    }
  }

  function captureModuleFunction(moduleName, functionName) {
    try {
      var moduleDescriptor = Object.getOwnPropertyDescriptor(root, moduleName);
      if (!moduleDescriptor || !Object.prototype.hasOwnProperty.call(moduleDescriptor, 'value')) return null;
      var moduleValue = moduleDescriptor.value;
      if (moduleValue === null || (typeof moduleValue !== 'object' && typeof moduleValue !== 'function')) return null;
      var functionDescriptor = Object.getOwnPropertyDescriptor(moduleValue, functionName);
      if (!functionDescriptor || !Object.prototype.hasOwnProperty.call(functionDescriptor, 'value')
        || typeof functionDescriptor.value !== 'function') return null;
      return Function.prototype.bind.call(functionDescriptor.value, moduleValue);
    } catch (_) {
      return null;
    }
  }

  // Pin the browser network primitive when this trusted script loads. A later
  // same-realm global reassignment before auth activation cannot substitute a
  // fake server response in the signed-in Reina panel. Explicit test DI stays
  // available through createReinaPilotClient({ fetchFn }).
  var CAPTURED_FETCH = captureRootFunction('fetch');
  var CAPTURED_VALIDATE_BOOTSTRAP = captureModuleFunction('ReinaLoginBrief', 'validateBootstrap');

  function clientError(code, serverCode) {
    var err = new Error('reina_pilot_client:' + code);
    err.code = code;
    // The route's own short machine reason for a non-2xx, when it sent one.
    // Diagnostic only: it never becomes rendered prose and never widens what
    // the client will accept as an answer -- it exists so the panel can say
    // WHICH failure happened instead of collapsing every one into "try again".
    if (typeof serverCode === 'string' && serverCode) err.serverCode = serverCode;
    return err;
  }

  // A non-2xx body is still route-authored JSON, but it is parsed here under
  // the same suspicion as any other network text: bounded read, one shallow
  // JSON.parse, and the code is kept ONLY if it is a short lowercase
  // machine token. Anything else is dropped and the caller falls back to the
  // generic reason. Never rendered raw -- the host maps it to fixed copy.
  var SERVER_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
  var MAX_ERROR_BODY_CHARS = 4096;

  function serverErrorCode(exchange) {
    var rawText = exchange && exchange.rawText;
    if (typeof rawText !== 'string' || !rawText || rawText.length > MAX_ERROR_BODY_CHARS) return null;
    var parsed;
    try { parsed = JSON.parse(rawText); } catch (_) { return null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(parsed, 'error'); } catch (_) { return null; }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    var code = descriptor.value;
    return typeof code === 'string' && SERVER_ERROR_CODE_RE.test(code) ? code : null;
  }

  function hasExecutableContent(value) {
    if (typeof value !== 'string') return false;
    for (var i = 0; i < EXECUTABLE_PATTERNS.length; i += 1) {
      if (EXECUTABLE_PATTERNS[i].test(value)) return true;
    }
    return false;
  }

  // Byte-for-byte browser mirror of api/_lib/reina/evidence-envelope.js.
  function sanitizeText(value) {
    if (value == null) return '';
    var text = String(value);
    text = text.replace(/\r\n?/g, '\n');
    text = text.replace(/<[^>]*>/g, '');
    text = text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
    return text.trim();
  }

  function safePrototype(value, expected) {
    try { return Object.getPrototypeOf(value) === expected; } catch (_) { return false; }
  }

  // A refused-transcript explanation from the route, rebuilt field by field so
  // nothing arbitrary from the wire reaches a log line or a caller. Diagnostic
  // ONLY: no caller may branch on it, and an absent or malformed one is null
  // rather than a partial object.
  function boundedTranscriptionDiagnostic(value) {
    if (value === null || typeof value !== 'object') return null;
    var exact;
    try {
      exact = readExactObject(value, ['audioBytes', 'audioType', 'rawTextType', 'rawTextLength', 'rawTextSample']);
    } catch (_) { return null; }
    if (!exact) return null;
    var count = function (n) { return Number.isSafeInteger(n) && n >= 0 && n <= 1e9 ? n : null; };
    var label = function (s) { return typeof s === 'string' && s.length <= 80 && !CONTROL_RE.test(s) ? s : null; };
    return Object.freeze({
      audioBytes: count(exact.audioBytes),
      audioType: label(exact.audioType),
      rawTextType: label(exact.rawTextType),
      rawTextLength: count(exact.rawTextLength),
      rawTextSample: typeof exact.rawTextSample === 'string'
        ? sanitizeText(exact.rawTextSample).slice(0, 80) : null,
    });
  }

  // Read an object without invoking any caller-controlled accessor. Only plain
  // own, enumerable data properties are accepted; wrappers/classes/proxies and
  // symbols fail closed.
  function readExactObject(value, keys) {
    if (value === null || typeof value !== 'object') return null;
    try { if (Array.isArray(value)) return null; } catch (_) { return null; }
    var protoOk = safePrototype(value, Object.prototype) || safePrototype(value, null);
    if (!protoOk) return null;
    var names;
    var symbols;
    try {
      names = Object.getOwnPropertyNames(value);
      symbols = Object.getOwnPropertySymbols(value);
    } catch (_) { return null; }
    if (symbols.length !== 0 || names.length !== keys.length) return null;
    var allowed = Object.create(null);
    for (var i = 0; i < keys.length; i += 1) allowed[keys[i]] = true;
    var out = Object.create(null);
    for (var n = 0; n < names.length; n += 1) {
      var name = names[n];
      if (!allowed[name]) return null;
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, name); } catch (_) { return null; }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) return null;
      out[name] = descriptor.value;
    }
    return out;
  }

  function readDenseArray(value, max) {
    try { if (!Array.isArray(value)) return null; } catch (_) { return null; }
    if (!safePrototype(value, Array.prototype)) return null;
    var lengthDescriptor;
    var names;
    var symbols;
    try {
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      names = Object.getOwnPropertyNames(value);
      symbols = Object.getOwnPropertySymbols(value);
    } catch (_) { return null; }
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) return null;
    var length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > max || symbols.length !== 0 || names.length !== length + 1) return null;
    var out = [];
    for (var i = 0; i < length; i += 1) {
      var d;
      try { d = Object.getOwnPropertyDescriptor(value, String(i)); } catch (_) { return null; }
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.enumerable !== true) return null;
      out.push(d.value);
    }
    return out;
  }

  function isBoundedText(value, max, nonEmpty) {
    if (typeof value !== 'string' || value.length > max || CONTROL_RE.test(value)) return false;
    if (hasExecutableContent(value) || sanitizeText(value) !== value) return false;
    return !nonEmpty || value.length > 0;
  }

  // Shape alone is insufficient (Date.parse normalizes some impossible dates).
  // Require a full UTC timestamp and round-trip it through the calendar parser.
  function isCanonicalUtcTimestamp(value) {
    if (typeof value !== 'string' || !CANONICAL_UTC_RE.test(value)) return false;
    var milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return false;
    var normalized = value.indexOf('.') === -1 ? value.slice(0, -1) + '.000Z' : value;
    try { return new Date(milliseconds).toISOString() === normalized; } catch (_) { return false; }
  }

  function validateBootstrapReview(top) {
    var review = readExactObject(top.review, REVIEW_KEYS);
    var intent = readExactObject(top.uiIntent, UI_INTENT_KEYS);
    if (!review || !intent
      || typeof review.intentId !== 'string' || review.intentId.length < 1 || review.intentId.length > MAX_ID
      || review.available !== true
      || !isCanonicalUtcTimestamp(review.expiresAt)
      || intent.version !== 'reina.ui-intent.v1'
      || intent.executed !== false
      || intent.requiresConfirmation !== true
      || intent.conversationId !== top.sessionId
      || typeof intent.turnId !== 'string' || intent.turnId.length < 1 || intent.turnId.length > MAX_ID
      || CONTROL_RE.test(intent.turnId)
      || intent.intentId !== review.intentId
      || intent.expiresAt !== review.expiresAt
      || intent.kind !== 'navigate'
      || intent.destination !== 'standup') return false;
    var parameters = readExactObject(intent.parameters, []);
    return parameters !== null;
  }

  function validateBootstrapContent(top) {
    var user = readExactObject(top.user, ['displayName']);
    var attention = readExactObject(top.attention, [
      'total', 'asOf', 'reviewAvailable', 'categories', 'unavailableSources',
    ]);
    if (!user || !isBoundedText(user.displayName, 120, true) || !attention
      || attention.reviewAvailable !== true
      || !(attention.asOf === null || isCanonicalUtcTimestamp(attention.asOf))) return false;
    var categories = readDenseArray(attention.categories, 24);
    var unavailable = readDenseArray(attention.unavailableSources, 24);
    if (!categories || !unavailable) return false;
    var availableCount = 0;
    var availableTotal = 0;
    var seen = Object.create(null);
    for (var i = 0; i < categories.length; i += 1) {
      var category = readExactObject(categories[i], [
        'key', 'label', 'count', 'available', 'asOf', 'evidence',
      ]);
      if (!category || !isBoundedText(category.key, 80, true)
        || !isBoundedText(category.label, 120, true) || seen[category.key]
        || typeof category.available !== 'boolean') return false;
      seen[category.key] = true;
      var evidence = readDenseArray(category.evidence, 16);
      if (!evidence) return false;
      for (var e = 0; e < evidence.length; e += 1) {
        if (!isBoundedText(evidence[e], 1000, true)) return false;
      }
      if (category.available) {
        if (!Number.isSafeInteger(category.count) || category.count < 0 || category.count > 1000000
          || !isCanonicalUtcTimestamp(category.asOf)) return false;
        availableCount += 1;
        availableTotal += category.count;
      } else if (category.count !== null || category.asOf !== null) return false;
    }
    for (var u = 0; u < unavailable.length; u += 1) {
      if (!isBoundedText(unavailable[u], 1000, true)) return false;
    }
    return availableCount >= 1
      && Number.isSafeInteger(attention.total)
      && attention.total === availableTotal;
  }

  function validateRequest(raw, allowedTransports) {
    var request = readExactObject(raw, REQUEST_KEYS);
    if (!request) throw clientError('invalid_request_shape');
    if (typeof request.utterance !== 'string' || request.utterance.trim() === '' || request.utterance.length > MAX_UTTERANCE || CONTROL_RE.test(request.utterance)) {
      throw clientError('invalid_utterance');
    }
    if (typeof request.conversationId !== 'string' || request.conversationId.trim() === '' || request.conversationId.length > MAX_ID || CONTROL_RE.test(request.conversationId)) {
      throw clientError('invalid_conversation_id');
    }
    if (typeof request.turnId !== 'string' || request.turnId.trim() === '' || request.turnId.length > MAX_ID || CONTROL_RE.test(request.turnId)) {
      throw clientError('invalid_turn_id');
    }
    if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 1 || request.idempotencyKey.length > MAX_RAW_IDEMPOTENCY || CONTROL_RE.test(request.idempotencyKey)) {
      throw clientError('invalid_idempotency_key');
    }
    if (allowedTransports.indexOf(request.transport) === -1) throw clientError('invalid_transport');
    return Object.freeze({
      utterance: request.utterance,
      conversationId: request.conversationId,
      turnId: request.turnId,
      idempotencyKey: request.idempotencyKey,
      transport: request.transport,
    });
  }

  function validateStringArray(raw, maxLength) {
    var values = readDenseArray(raw, MAX_LIST);
    if (!values) return null;
    var out = [];
    for (var i = 0; i < values.length; i += 1) {
      if (!isBoundedText(values[i], maxLength, false)) return null;
      out.push(values[i]);
    }
    return Object.freeze(out);
  }

  function validateEvidence(raw) {
    var values = readDenseArray(raw, MAX_EVIDENCE);
    if (!values) return null;
    var out = [];
    for (var i = 0; i < values.length; i += 1) {
      var e = readExactObject(values[i], EVIDENCE_KEYS);
      if (!e) return null;
      if (!isBoundedText(e.source, 1024, true) || !isBoundedText(e.sourceType, 128, true) || !isBoundedText(e.detail, 8192, false)) return null;
      if (e.dataClass !== 'synthetic' && e.dataClass !== 'authorized_read') return null;
      if (e.synthetic !== (e.dataClass === 'synthetic')) return null;
      if (!(e.observedAt === null || isCanonicalUtcTimestamp(e.observedAt))) return null;
      if (!(e.asOf === null || isCanonicalUtcTimestamp(e.asOf))) return null;
      out.push(Object.freeze({
        source: e.source, sourceType: e.sourceType, dataClass: e.dataClass,
        synthetic: e.synthetic, observedAt: e.observedAt, asOf: e.asOf, detail: e.detail,
      }));
    }
    return Object.freeze(out);
  }

  function validateFreshness(raw) {
    var f = readExactObject(raw, FRESHNESS_KEYS);
    if (!f || typeof f.known !== 'boolean' || !isBoundedText(f.note, 4096, true)) return null;
    if (f.known) {
      if (!isCanonicalUtcTimestamp(f.asOf)) return null;
    } else if (f.asOf !== null) return null;
    return Object.freeze({ known: f.known, asOf: f.asOf, note: f.note });
  }

  function validateConflicts(raw) {
    var values = readDenseArray(raw, MAX_LIST);
    if (!values) return null;
    var out = [];
    for (var i = 0; i < values.length; i += 1) {
      var c = readExactObject(values[i], CONFLICT_KEYS);
      if (!c || !isBoundedText(c.summary, 4096, true)) return null;
      var sources = readDenseArray(c.sources, MAX_SOURCE_LIST);
      if (!sources) return null;
      var safeSources = [];
      for (var s = 0; s < sources.length; s += 1) {
        if (!isBoundedText(sources[s], 1024, true)) return null;
        safeSources.push(sources[s]);
      }
      out.push(Object.freeze({ summary: c.summary, sources: Object.freeze(safeSources) }));
    }
    return Object.freeze(out);
  }

  function validateCanonicalEnvelope(raw) {
    var e = readExactObject(raw, ENVELOPE_KEYS);
    if (!e || e.version !== ENVELOPE_VERSION || e.executed !== false || e.executionStatement !== EXECUTION_STATEMENT) {
      throw clientError('invalid_envelope');
    }
    if (!isBoundedText(e.answer, 16384, true) || typeof e.refused !== 'boolean') throw clientError('invalid_envelope');
    if (e.refused) {
      if (!isBoundedText(e.refusalReason, 2048, true)) throw clientError('invalid_envelope');
    } else if (e.refusalReason !== null) throw clientError('invalid_envelope');
    var evidence = validateEvidence(e.evidence);
    var freshness = validateFreshness(e.freshness);
    var missing = validateStringArray(e.missingInformation, 4096);
    var conflicts = validateConflicts(e.conflictingInformation);
    var uncertainty = validateStringArray(e.uncertainty, 4096);
    if (!evidence || !freshness || !missing || !conflicts || !uncertainty) throw clientError('invalid_envelope');
    return Object.freeze({
      version: ENVELOPE_VERSION,
      answer: e.answer,
      evidence: evidence,
      freshness: freshness,
      missingInformation: missing,
      conflictingInformation: conflicts,
      uncertainty: uncertainty,
      refused: e.refused,
      refusalReason: e.refusalReason,
      executed: false,
      executionStatement: EXECUTION_STATEMENT,
    });
  }

  function renderPlainText(envelope) {
    var lines = [];
    if (envelope.refused) {
      lines.push('REFUSED');
      lines.push('Reason: ' + sanitizeText(envelope.refusalReason));
      lines.push('');
    }
    lines.push(sanitizeText(envelope.answer));
    lines.push('');
    lines.push('Evidence:');
    if (envelope.evidence.length === 0) lines.push('  (none cited)');
    else {
      for (var i = 0; i < envelope.evidence.length; i += 1) {
        var e = envelope.evidence[i];
        var tag = e.dataClass === 'synthetic' ? '[SYNTHETIC] ' : '[authorized read] ';
        var when = e.observedAt ? ' (observed ' + sanitizeText(e.observedAt) + ')'
          : e.asOf ? ' (as of ' + sanitizeText(e.asOf) + ')'
            : ' (no observed/as-of time)';
        var detail = e.detail ? ' \u2014 ' + sanitizeText(e.detail) : '';
        lines.push('  - ' + tag + sanitizeText(e.source) + ' [' + sanitizeText(e.sourceType) + ']' + when + detail);
      }
    }
    lines.push('');
    if (envelope.freshness.known) lines.push('Freshness: data as of ' + sanitizeText(envelope.freshness.asOf) + '.');
    else lines.push('Freshness: ' + (sanitizeText(envelope.freshness.note) || 'unknown.'));
    lines.push('');
    lines.push('Missing information:');
    if (envelope.missingInformation.length === 0) lines.push('  (none noted)');
    else for (var m = 0; m < envelope.missingInformation.length; m += 1) lines.push('  - ' + sanitizeText(envelope.missingInformation[m]));
    lines.push('');
    lines.push('Conflicting information:');
    if (envelope.conflictingInformation.length === 0) lines.push('  (none found)');
    else {
      for (var c = 0; c < envelope.conflictingInformation.length; c += 1) {
        var conflict = envelope.conflictingInformation[c];
        var sourceText = conflict.sources.length ? ' [sources: ' + conflict.sources.map(sanitizeText).join(', ') + ']' : '';
        lines.push('  - ' + sanitizeText(conflict.summary) + sourceText);
      }
    }
    lines.push('');
    lines.push('Uncertainty:');
    if (envelope.uncertainty.length === 0) lines.push('  (none noted)');
    else for (var u = 0; u < envelope.uncertainty.length; u += 1) lines.push('  - ' + sanitizeText(envelope.uncertainty[u]));
    lines.push('');
    lines.push(sanitizeText(envelope.executionStatement || EXECUTION_STATEMENT));
    return lines.join('\n');
  }

  function validateNavigation(raw) {
    if (raw === null) return null;
    var nav = readExactObject(raw, NAVIGATION_KEYS);
    if (!nav || nav.type !== 'open_view' || nav.target !== 'standup' || nav.requiresExplicitUserIntent !== true) {
      throw clientError('invalid_navigation');
    }
    return Object.freeze({ type: 'open_view', target: 'standup', requiresExplicitUserIntent: true });
  }

  function expectedAccess(evidence) {
    var synthetic = false;
    var authorized = false;
    for (var i = 0; i < evidence.length; i += 1) {
      if (evidence[i].dataClass === 'synthetic') synthetic = true;
      if (evidence[i].dataClass === 'authorized_read') authorized = true;
    }
    if (synthetic && authorized) return { dataAccess: 'mixed', synthetic: true };
    if (synthetic) return { dataAccess: 'synthetic', synthetic: true };
    if (authorized) return { dataAccess: 'authorized_read', synthetic: false };
    return { dataAccess: 'none', synthetic: false };
  }

  function validateRouteResponse(raw, request) {
    var correlatedRequest = validateRequest(request, ['typed', 'voice']);
    if (!SAFE_NORMALIZED_KEY_RE.test(correlatedRequest.idempotencyKey)) throw clientError('invalid_idempotency_key');
    var response = readExactObject(raw, RESPONSE_KEYS);
    if (!response) throw clientError('invalid_response_shape');
    if (response.ok !== true || response.enabled !== true || response.stored !== true) throw clientError('unpersisted_response');
    if (response.conversationId !== correlatedRequest.conversationId) throw clientError('conversation_mismatch');
    if (response.turnId !== correlatedRequest.turnId) throw clientError('turn_mismatch');
    if (response.idempotencyKey !== correlatedRequest.idempotencyKey || !SAFE_NORMALIZED_KEY_RE.test(response.idempotencyKey)) {
      throw clientError('idempotency_mismatch');
    }
    if (typeof response.replayed !== 'boolean') throw clientError('invalid_replay_state');
    if (response.executed !== false || response.nothingExecuted !== true ||
        response.businessActionAllowed !== false || response.automationTaskAllowed !== false || response.toolExecutionAllowed !== false) {
      throw clientError('action_claim');
    }
    var envelope = validateCanonicalEnvelope(response.envelope);
    var access = expectedAccess(envelope.evidence);
    if (response.synthetic !== access.synthetic || response.dataAccess !== access.dataAccess) throw clientError('dishonest_data_access');
    // The production read-only pilot may return either model-only evidence,
    // authorized HiveLogic/web reads, or a truthful mixture of both. The
    // exact access markers above must match the validated evidence; an answer
    // with no evidence remains rejected.
    if (envelope.evidence.length === 0 || access.dataAccess === 'none') {
      throw clientError('missing_evidence');
    }
    if (typeof response.plainText !== 'string' || response.plainText.length > MAX_PLAIN_TEXT || response.plainText !== renderPlainText(envelope)) {
      throw clientError('plain_text_mismatch');
    }
    var navigation = validateNavigation(response.navigation);
    // This RC has no durable proof that can safely re-authorize an effectful
    // review directive on exact replay. Until that contract exists, both the
    // server and browser reject every offer/navigation response.
    if (navigation !== null) throw clientError('invalid_navigation');
    if (response.reviewAvailable !== false) throw clientError('invalid_review_offer');
    return Object.freeze({
      ok: true, enabled: true, stored: true,
      conversationId: response.conversationId,
      turnId: response.turnId,
      idempotencyKey: response.idempotencyKey,
      replayed: response.replayed,
      executed: false, nothingExecuted: true,
      businessActionAllowed: false, automationTaskAllowed: false, toolExecutionAllowed: false,
      synthetic: response.synthetic, dataAccess: response.dataAccess,
      reviewAvailable: response.reviewAvailable,
      envelope: envelope, plainText: response.plainText, navigation: navigation,
    });
  }

  function validateConfirmResponse(raw, intentId) {
    var response = readExactObject(raw, CONFIRM_RESPONSE_KEYS);
    if (!response || response.ok !== true || response.confirmed !== true
      || response.intentId !== intentId || !SAFE_REVIEW_INTENT_RE.test(response.intentId)
      || response.executed !== false || response.nothingExecuted !== true
      || response.businessActionAllowed !== false
      || response.automationTaskAllowed !== false
      || response.toolExecutionAllowed !== false) throw clientError('invalid_confirmation');
    return Object.freeze({ ok: true, intentId: response.intentId, executed: false });
  }

  function defaultGetAccessToken() {
    var sb = root && root.sb;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== 'function') return Promise.reject(clientError('auth_expired'));
    return Promise.resolve(sb.auth.getSession()).then(function (result) {
      var session = result && result.data && result.data.session;
      var token = session && session.access_token;
      if (typeof token !== 'string' || token.length < 1 || token.length > 16384) throw clientError('auth_expired');
      return token;
    });
  }

  function defaultHash(input) {
    var cryptoApi = root && root.crypto;
    var Encoder = root && root.TextEncoder;
    if (!cryptoApi || !cryptoApi.subtle || typeof cryptoApi.subtle.digest !== 'function' || typeof Encoder !== 'function') {
      return Promise.reject(clientError('secure_hash_unavailable'));
    }
    return cryptoApi.subtle.digest('SHA-256', new Encoder().encode(input)).then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      var hex = '';
      for (var i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    });
  }

  function createReinaPilotClient(options) {
    options = options || {};
    var fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn
      : CAPTURED_FETCH;
    var getAccessToken = typeof options.getAccessToken === 'function' ? options.getAccessToken : defaultGetAccessToken;
    var hashFn = typeof options.hashFn === 'function' ? options.hashFn : defaultHash;
    var onAuthExpired = typeof options.onAuthExpired === 'function' ? options.onAuthExpired : function () {};
    var timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    var setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn
      : root && typeof root.setTimeout === 'function' ? root.setTimeout.bind(root) : null;
    var clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn
      : root && typeof root.clearTimeout === 'function' ? root.clearTimeout.bind(root) : null;
    var AbortControllerCtor = typeof options.AbortControllerCtor === 'function'
      ? options.AbortControllerCtor : root && typeof root.AbortController === 'function' ? root.AbortController : null;
    if (!fetchFn) throw new Error('createReinaPilotClient: fetch is required');
    if (!setTimeoutFn || !clearTimeoutFn || !AbortControllerCtor) {
      throw new Error('createReinaPilotClient: bounded fetch cancellation is required');
    }

    var materialToKey = Object.create(null);
    var keyToMaterial = Object.create(null);
    var payloadByKey = Object.create(null);
    var acceptedByKey = Object.create(null);
    var pendingVoiceNavigation = Object.create(null);
    var bindingCount = 0;

    function lengthPart(value) { return value.length + ':' + value; }

    function signalAuthExpired() {
      try { onAuthExpired(); } catch (_) { /* a callback cannot alter the boundary */ }
      return clientError('auth_expired');
    }

    async function normalizedRequest(request) {
      // The route can independently recompute this identity from the exact
      // conversation/turn tuple. Transport is deliberately non-semantic so a
      // typed-to-Voice fallback cannot persist a duplicate turn. The raw
      // controller key remains a
      // browser-local replay binding and is never trusted or sent.
      var material = 'reina-pilot-idem-v3|' +
        lengthPart(request.conversationId) + '|' + lengthPart(request.turnId);
      var normalized = materialToKey[material];
      if (!normalized) {
        var digest;
        try { digest = await hashFn(material); } catch (_) { throw clientError('secure_hash_unavailable'); }
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw clientError('invalid_hash_result');
        normalized = 'rt.' + digest;
        if (keyToMaterial[normalized] && keyToMaterial[normalized] !== material) throw clientError('idempotency_hash_collision');
        if (bindingCount >= MAX_BINDINGS) throw clientError('idempotency_registry_full');
        materialToKey[material] = normalized;
        keyToMaterial[normalized] = material;
        bindingCount += 1;
      }
      var payloadIdentity = JSON.stringify([
        request.conversationId, request.turnId, request.utterance,
      ]);
      if (payloadByKey[normalized] && payloadByKey[normalized] !== payloadIdentity) throw clientError('idempotency_payload_conflict');
      payloadByKey[normalized] = payloadIdentity;
      return Object.freeze({
        utterance: request.utterance,
        conversationId: request.conversationId,
        turnId: request.turnId,
        idempotencyKey: normalized,
        transport: request.transport,
      });
    }

    function boundedOperation(work) {
      return new Promise(function (resolve, reject) {
        var state = { expired: false, abort: null };
        var settled = false;
        var timer = setTimeoutFn(function () {
          if (settled) return;
          settled = true;
          state.expired = true;
          if (typeof state.abort === 'function') {
            try { state.abort(); } catch (_) {}
          }
          reject(clientError('timeout'));
        }, timeoutMs);
        Promise.resolve().then(function () { return work(state); }).then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          resolve(value);
        }, function (err) {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          reject(err);
        });
      });
    }

    function assertLive(state) {
      if (state.expired) throw clientError('timeout');
    }

    // Bound ANY promise. supabase-js acquires a cross-tab Web Lock before it
    // will hand back a session, so `getSession()` can stay pending for as long
    // as another context holds that lock -- forever, if one died holding it.
    // Unbounded, that pending promise is not an error anywhere: the request is
    // never sent, no handler runs, nothing is rendered, and nothing is logged.
    // A voice turn that ends in silence is exactly what that looks like.
    function withDeadline(start, milliseconds, code) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeoutFn(function () {
          if (settled) return;
          settled = true;
          reject(clientError(code));
        }, milliseconds);
        var work;
        try { work = start(); } catch (err) { work = Promise.reject(err); }
        Promise.resolve(work).then(function (value) {
          if (settled) return;
          settled = true;
          try { clearTimeoutFn(timer); } catch (_) {}
          resolve(value);
        }, function (err) {
          if (settled) return;
          settled = true;
          try { clearTimeoutFn(timer); } catch (_) {}
          reject(err);
        });
      });
    }

    async function accessToken(state) {
      var token;
      try {
        token = await withDeadline(getAccessToken, TOKEN_DEADLINE_MS, 'auth_timeout');
      } catch (err) {
        // A stuck session lock is not an expired sign-in, and calling it one
        // sends the user to re-authenticate against a problem re-authenticating
        // cannot fix. Keep the two apart.
        if (err && err.code === 'auth_timeout') throw err;
        throw signalAuthExpired();
      }
      assertLive(state);
      if (typeof token !== 'string' || token.length < 1 || token.length > 16384 || /[\r\n]/.test(token)) {
        throw signalAuthExpired();
      }
      return token;
    }

    function boundedExchange(init, state, endpoint) {
      var controller;
      try { controller = new AbortControllerCtor(); } catch (_) { return Promise.reject(clientError('transport_failed')); }
      if (!controller || !controller.signal || typeof controller.abort !== 'function') {
        return Promise.reject(clientError('transport_failed'));
      }
      assertLive(state);
      state.abort = function () { controller.abort(); };
      init.signal = controller.signal;
      return Promise.resolve().then(function () {
        assertLive(state);
        return fetchFn(endpoint || ENDPOINT, init);
      }).then(function (response) {
        assertLive(state);
        if (!response) throw clientError('invalid_http_response');
        if (typeof response.text !== 'function') {
          return response.ok === true
            ? Promise.reject(clientError('invalid_http_response'))
            : { response: response, rawText: null };
        }
        return Promise.resolve(response.text()).then(function (rawText) {
          assertLive(state);
          return { response: response, rawText: rawText };
        });
      });
    }

    async function fetchRoute(request, state) {
      var token = await accessToken(state);
      var exchange;
      try {
        exchange = await boundedExchange({
          method: 'POST',
          headers: Object.freeze({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + token,
          }),
          body: JSON.stringify(request),
          credentials: 'same-origin',
          cache: 'no-store',
        }, state);
      } catch (err) {
        if (err && (err.code === 'auth_expired' || err.code === 'timeout' || err.code === 'invalid_http_response')) throw err;
        throw clientError('transport_failed');
      }
      var httpResponse = exchange && exchange.response;
      if (!httpResponse || httpResponse.ok !== true) {
        if (httpResponse && (httpResponse.status === 401 || httpResponse.status === 403)) throw signalAuthExpired();
        // Keep the route's reason (e.g. 'disabled' from the four-flag
        // production gate in api/reina-pilot.js). Dropping it here is what
        // made every backend state read as one generic "try again".
        throw clientError('route_unavailable', serverErrorCode(exchange));
      }
      var rawText = exchange.rawText;
      if (typeof rawText !== 'string' || rawText.length > MAX_RESPONSE_CHARS) throw clientError('response_too_large');
      var parsed;
      try { parsed = JSON.parse(rawText); } catch (_) { throw clientError('invalid_json'); }
      var validated = validateRouteResponse(parsed, request);

      // A stable key can only replay the same stored semantic result. The
      // transport never accepts a second "fresh" success or a changed replay.
      var semantic = JSON.stringify({
        ok: validated.ok, enabled: validated.enabled, stored: validated.stored,
        conversationId: validated.conversationId, turnId: validated.turnId,
        idempotencyKey: validated.idempotencyKey, executed: validated.executed,
        nothingExecuted: validated.nothingExecuted,
        businessActionAllowed: validated.businessActionAllowed,
        automationTaskAllowed: validated.automationTaskAllowed,
        toolExecutionAllowed: validated.toolExecutionAllowed,
        synthetic: validated.synthetic, dataAccess: validated.dataAccess,
        reviewAvailable: validated.reviewAvailable,
        envelope: validated.envelope, plainText: validated.plainText,
        navigation: validated.navigation,
      });
      if (acceptedByKey[request.idempotencyKey]) {
        if (validated.replayed !== true || acceptedByKey[request.idempotencyKey] !== semantic) throw clientError('replay_conflict');
      } else acceptedByKey[request.idempotencyKey] = semantic;
      return validated;
    }

    // Voice recording is deliberately a separate, authenticated upload. It
    // contains only a short browser-created Blob; it never carries identity,
    // role, prompt, history, or business data. The server transcribes and
    // discards it before the resulting plain text enters the normal voice turn.
    async function transcribeVoiceAudio(blob) {
      return boundedOperation(async function (state) {
        if (!blob || typeof blob !== 'object') throw clientError('invalid_audio');
        var size;
        var type;
        try { size = blob.size; type = blob.type; } catch (_) { throw clientError('invalid_audio'); }
        if (!Number.isSafeInteger(size) || size < 1 || size > MAX_VOICE_AUDIO_BYTES
          || typeof type !== 'string' || !/^audio\/(?:webm|ogg|mp4|wav|mpeg)(?:;|$)/i.test(type)) {
          throw clientError('invalid_audio');
        }
        var token = await accessToken(state);
        var exchange;
        try {
          exchange = await boundedExchange({
            method: 'POST',
            headers: Object.freeze({
              'Content-Type': type,
              'Accept': 'application/json',
              'Authorization': 'Bearer ' + token,
            }),
            body: blob,
            credentials: 'same-origin', cache: 'no-store',
          }, state, TRANSCRIPTION_ENDPOINT);
        } catch (err) {
          if (err && (err.code === 'auth_expired' || err.code === 'timeout' || err.code === 'invalid_http_response')) throw err;
          throw clientError('transcription_unavailable');
        }
        var response = exchange && exchange.response;
        if (!response || response.ok !== true) {
          if (response && (response.status === 401 || response.status === 403)) throw signalAuthExpired();
          var failedRaw = exchange && exchange.rawText;
          var failed;
          try { failed = typeof failedRaw === 'string' ? JSON.parse(failedRaw) : null; } catch (_) { failed = null; }
          var failedCode = failed && failed.ok === false && typeof failed.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(failed.code)
            ? failed.code : null;
          // The route explains a refused transcript (did the model answer with
          // nothing, or with something the sanitizer rejected?). Carry that
          // explanation to the console instead of dropping it on the floor --
          // bounded and re-validated here, because it arrived over the wire.
          var failedDiagnostic = boundedTranscriptionDiagnostic(failed && failed.diagnostic);
          if (response && response.status === 422) {
            return Object.freeze({ ok: false, code: failedCode || 'no_speech', diagnostic: failedDiagnostic });
          }
          if (failedCode) return Object.freeze({ ok: false, code: failedCode, diagnostic: failedDiagnostic });
          throw clientError('transcription_unavailable');
        }
        var rawText = exchange.rawText;
        if (typeof rawText !== 'string' || rawText.length > MAX_RESPONSE_CHARS) throw clientError('invalid_json');
        var parsed;
        try { parsed = JSON.parse(rawText); } catch (_) { throw clientError('invalid_json'); }
        var exact = readExactObject(parsed, ['ok', 'transcript']);
        if (!exact || exact.ok !== true || typeof exact.transcript !== 'string'
          || exact.transcript.length === 0 || exact.transcript.length > MAX_UTTERANCE
          || sanitizeText(exact.transcript) !== exact.transcript || hasExecutableContent(exact.transcript)) {
          throw clientError('invalid_transcript');
        }
        return Object.freeze({ ok: true, transcript: exact.transcript });
      });
    }

    // A voice failure describes itself to the server so it can be read from the
    // database instead of from somebody's console. Fire and forget by design:
    // it reports a failure, so it must never raise one, never block the voice
    // path, and never change what the caller does next. Anything that goes
    // wrong here -- no token, no network, a rejected record -- is swallowed.
    function reportVoiceDiagnostic(record) {
      var body;
      try {
        if (!record || typeof record !== 'object') return Promise.resolve(false);
        body = JSON.stringify(record);
        if (typeof body !== 'string' || body.length > 3000) return Promise.resolve(false);
      } catch (_) { return Promise.resolve(false); }
      // Its own token fetch is bounded too. Reporting that the token fetch
      // hung is worthless if the report waits on the token fetch.
      return withDeadline(getAccessToken, TOKEN_DEADLINE_MS, 'auth_timeout')
        .then(function (token) {
          if (typeof token !== 'string' || !token) return false;
          return fetchFn(VOICE_DIAGNOSTIC_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Authorization': 'Bearer ' + token,
            },
            body: body,
            credentials: 'same-origin',
            cache: 'no-store',
          }).then(function () { return true; }, function () { return false; });
        })
        .catch(function () { return false; });
    }

    async function send(raw, transports) {
      return boundedOperation(async function (state) {
        var original = validateRequest(raw, transports);
        var routeRequest = await normalizedRequest(original);
        assertLive(state);
        var response = await fetchRoute(routeRequest, state);
        return { original: original, routeRequest: routeRequest, response: response };
      });
    }

    function freezeJson(value, depth) {
      if (value === null || typeof value !== 'object') return value;
      if (depth > 32) throw clientError('invalid_bootstrap');
      var keys = Object.keys(value);
      if (keys.length > 256) throw clientError('invalid_bootstrap');
      for (var i = 0; i < keys.length; i += 1) freezeJson(value[keys[i]], depth + 1);
      return Object.freeze(value);
    }

    async function bootstrap() {
      return boundedOperation(async function (state) {
        var token = await accessToken(state);
        var exchange;
        try {
          exchange = await boundedExchange({
            method: 'GET',
            headers: Object.freeze({
              'Accept': 'application/json',
              'Authorization': 'Bearer ' + token,
            }),
            credentials: 'same-origin',
            cache: 'no-store',
          }, state);
        } catch (err) {
          if (err && (err.code === 'timeout' || err.code === 'invalid_http_response')) throw err;
          throw clientError('transport_failed');
        }
        var response = exchange && exchange.response;
        if (!response || response.ok !== true) {
          if (response && (response.status === 401 || response.status === 403)) throw signalAuthExpired();
          // Same as fetchRoute: a disabled/unavailable route must stay
          // distinguishable from a genuine transport failure.
          throw clientError('route_unavailable', serverErrorCode(exchange));
        }
        var rawText = exchange.rawText;
        if (typeof rawText !== 'string' || rawText.length > MAX_RESPONSE_CHARS) throw clientError('response_too_large');
        var parsed;
        try { parsed = JSON.parse(rawText); } catch (_) { throw clientError('invalid_json'); }
        var top = readExactObject(parsed, BOOTSTRAP_KEYS);
        if (!top || top.ok !== true || top.executed !== false || !SERVER_SESSION_RE.test(top.sessionId)
          || !isCanonicalUtcTimestamp(top.generatedAt) || !validateBootstrapReview(top)
          || !validateBootstrapContent(top)) {
          throw clientError('invalid_bootstrap');
        }
        // JSON.parse produced an own-data graph. Freeze the complete server
        // snapshot before invoking even the pinned validator, so no callback
        // can rewrite the identity/attention data that the host later renders.
        freezeJson(parsed, 0);
        return Object.freeze({ sessionId: top.sessionId, bootstrap: parsed });
      });
    }

    async function confirmReviewIntent(intentId) {
      if (typeof intentId !== 'string' || intentId.length > MAX_ID
        || !SAFE_REVIEW_INTENT_RE.test(intentId) || CONTROL_RE.test(intentId)) {
        throw clientError('invalid_review_intent');
      }
      return boundedOperation(async function (state) {
        var token = await accessToken(state);
        var request = Object.freeze({ action: 'confirm_review', intentId: intentId });
        var exchange;
        try {
          exchange = await boundedExchange({
            method: 'POST',
            headers: Object.freeze({
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Authorization': 'Bearer ' + token,
            }),
            body: JSON.stringify(request),
            credentials: 'same-origin',
            cache: 'no-store',
          }, state);
        } catch (err) {
          if (err && (err.code === 'auth_expired' || err.code === 'timeout'
            || err.code === 'invalid_http_response')) throw err;
          throw clientError('transport_failed');
        }
        var response = exchange && exchange.response;
        if (!response || response.ok !== true) {
          if (response && (response.status === 401 || response.status === 403)) throw signalAuthExpired();
          if (response && response.status === 408) return Object.freeze({ ok: false, reason: 'timeout' });
          if (response && response.status === 409) return Object.freeze({ ok: false, reason: 'duplicate' });
          if (response && response.status === 410) return Object.freeze({ ok: false, reason: 'expired' });
          if (response && (response.status === 400 || response.status === 404)) {
            return Object.freeze({ ok: false, reason: 'stale_intent' });
          }
          return Object.freeze({ ok: false, reason: 'confirmation_unavailable' });
        }
        var rawText = exchange.rawText;
        if (typeof rawText !== 'string' || rawText.length > MAX_RESPONSE_CHARS) {
          throw clientError('response_too_large');
        }
        var parsed;
        try { parsed = JSON.parse(rawText); } catch (_) { throw clientError('invalid_json'); }
        return validateConfirmResponse(parsed, intentId);
      });
    }

    // Direct dependency for PR #84. The response key is mapped back to the raw
    // controller key only after exact server correlation has been proved.
    async function submitTurn(raw) {
      var outcome = await send(raw, ['typed']);
      var response = outcome.response;
      return Object.freeze({
        ok: true, enabled: true, stored: true,
        conversationId: response.conversationId,
        turnId: response.turnId,
        idempotencyKey: outcome.original.idempotencyKey,
        replayed: response.replayed,
        executed: false, nothingExecuted: true,
        businessActionAllowed: false, automationTaskAllowed: false, toolExecutionAllowed: false,
        synthetic: response.synthetic, dataAccess: response.dataAccess,
        reviewAvailable: response.reviewAvailable,
        envelope: response.envelope, plainText: response.plainText, navigation: response.navigation,
      });
    }

    // Inject this as PR #86's `serverTransport`. It accepts only PR #86's exact
    // primitive canonical request, proves the strict route response, then maps
    // that result into PR #86's legacy Voice envelope. Navigation is exposed as
    // inert data and is never followed here.
    async function voiceServerTransport(raw) {
      var outcome = await send(raw, ['voice', 'typed']);
      var response = outcome.response;
      var envelope = response.envelope;
      var hasUncertainty = envelope.uncertainty.length > 0 || envelope.refused;
      var uncertainty = hasUncertainty ? Object.freeze({
        statements: envelope.uncertainty,
        refused: envelope.refused,
        refusalReason: envelope.refusalReason,
      }) : null;
      var mapped = Object.freeze({
        conversationId: response.conversationId,
        turnId: response.turnId,
        executed: false,
        nothingExecuted: true,
        state: response.synthetic ? 'synthetic' : 'unverified',
        // The written reply keeps the complete audit envelope.  Speech is the
        // concise server-authored answer only, so a voice user never has every
        // evidence/freshness/missing-data field read aloud.
        // Voice conversation leads with the concise answer. The complete
        // evidence envelope remains in the validated response, rather than
        // being recited or rendered as an audit dump for every spoken turn.
        answer: Object.freeze({ text: envelope.answer, speech: envelope.answer }),
        evidence: envelope.evidence,
        freshness: envelope.freshness,
        missingInformation: envelope.missingInformation,
        conflicts: envelope.conflictingInformation,
        uncertainty: uncertainty,
        navigation: response.navigation,
      });
      // Keep a validated Voice navigation directive inert until the Voice
      // session emits its non-stale, non-OFF onReply event. Network completion
      // alone is never permission to navigate.
      if (response.navigation) {
        var navigationKey = lengthPart(response.conversationId) + '|' + lengthPart(response.turnId);
        pendingVoiceNavigation[navigationKey] = response.navigation;
      }
      return mapped;
    }

    function takeVoiceNavigation(conversationId, turnId) {
      if (typeof conversationId !== 'string' || typeof turnId !== 'string'
        || conversationId.length < 1 || conversationId.length > MAX_ID
        || turnId.length < 1 || turnId.length > MAX_ID) return null;
      var key = lengthPart(conversationId) + '|' + lengthPart(turnId);
      var navigation = pendingVoiceNavigation[key] || null;
      if (navigation) delete pendingVoiceNavigation[key];
      return navigation;
    }

    return Object.freeze({
      submitTurn: submitTurn,
      confirmReviewIntent: confirmReviewIntent,
      voiceServerTransport: voiceServerTransport,
      serverTransport: voiceServerTransport,
      takeVoiceNavigation: takeVoiceNavigation,
      transcribeVoiceAudio: transcribeVoiceAudio,
      reportVoiceDiagnostic: reportVoiceDiagnostic,
      bootstrap: bootstrap,
    });
  }

  return Object.freeze({
    createReinaPilotClient: createReinaPilotClient,
    createPilotClient: createReinaPilotClient,
    validateRouteResponse: validateRouteResponse,
    validateConfirmResponse: validateConfirmResponse,
    validateCanonicalEnvelope: validateCanonicalEnvelope,
    renderPlainText: renderPlainText,
    sanitizeText: sanitizeText,
    ENDPOINT: ENDPOINT,
    ENVELOPE_VERSION: ENVELOPE_VERSION,
    EXECUTION_STATEMENT: EXECUTION_STATEMENT,
  });
});
