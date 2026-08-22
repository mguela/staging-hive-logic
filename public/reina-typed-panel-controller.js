/* public/reina-typed-panel-controller.js
 *
 * UNWIRED, dependency-injected TYPED conversation host for the purple Reina
 * preview panel. Pure controller/state-machine — no DOM, network, speech, or
 * persistence of its own. It connects natural free-form typed text to the panel
 * through a single injected `submitTurn(request)` seam (Claude 2's backend
 * composer attaches here) and exposes an inert, textContent-only view model.
 *
 * SECURITY / SCOPE POSTURE
 *   - The ONLY thing sent to the backend is the fixed typed request shape:
 *       { utterance, conversationId, turnId, idempotencyKey, transport: 'typed' }
 *     No client role, company, identity, capability, authorization, system
 *     prompt, tools, evidence, or execution claim is ever sent or trusted.
 *   - A server response is ACCEPTED only when it correlates to the in-flight
 *     turn (matching conversationId + turnId), carries a validated canonical
 *     `reina.answer.v1` envelope with structural `executed:false` and the exact
 *     "nothing was executed" statement, exposes all transparency fields
 *     (evidence, freshness, missing, conflicts, uncertainty/refusal), affirms
 *     persistence (`stored:true`), and contains NO HTML payload.
 *   - Everything else is REJECTED fail-closed: mismatched IDs, malformed
 *     envelopes, HTML payloads, executed:true, missing transparency fields,
 *     replay conflicts, and unsaved-success responses.
 *   - Read-only, preview-only, admin-only, no-action: the controller never
 *     performs or claims a business/Automation/tool action, and the panel stays
 *     dormant behind the existing preview/admin gate (host decides mount).
 *   - Rendering is inert: the view model is all HTML-stripped strings destined
 *     for `.textContent`; the controller never emits markup.
 *
 * No microphone/speech here — Claude 3 owns Voice.
 *
 * UMD: window.ReinaTypedPanel in the browser; module.exports in node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaTypedPanel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENVELOPE_VERSION = 'reina.answer.v1';
  var EXECUTION_STATEMENT =
    'Nothing was executed. This is a read-only answer; no action was taken and no data was changed.';
  var PREVIEW_NOTICE = 'REINA · READ ONLY';
  var MAX_UTTERANCE_CHARS = 4000;

  function noop() {}
  function isFn(f) { return typeof f === 'function'; }
  function isStr(s) { return typeof s === 'string'; }
  function isNonEmptyStr(s) { return typeof s === 'string' && s.trim().length > 0; }
  function isPlainObject(o) { return o != null && typeof o === 'object' && !Array.isArray(o); }
  function isArray(a) { return Array.isArray(a); }

  // Detect tag-like / executable markup so HTML payloads can be REJECTED.
  function looksLikeHtml(s) {
    return typeof s === 'string' && (/<[a-z!/][^>]*>/i.test(s) || /<\s*script/i.test(s) || /on\w+\s*=/i.test(s) || /javascript:/i.test(s));
  }
  // Coerce any string to inert plain text safe for `.textContent`.
  function inert(value) {
    if (value == null) return '';
    var s = String(value);
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/<[^>]*>/g, '');                 // drop tag-like sequences
    s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ''); // drop control chars (keep \t,\n)
    return s.trim();
  }
  function inertList(arr) {
    if (!isArray(arr)) return [];
    return arr.map(function (x) { return isPlainObject(x) ? inert(x.detail || x.note || x.source || JSON.stringify(x)) : inert(x); })
              .filter(function (x) { return x.length > 0; });
  }

  // Any string field that contains HTML makes the whole envelope unsafe.
  function anyHtml(values) {
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (isStr(v) && looksLikeHtml(v)) return true;
      if (isArray(v) && anyHtml(v)) return true;
      if (isPlainObject(v)) { for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k) && isStr(v[k]) && looksLikeHtml(v[k])) return true; } }
    }
    return false;
  }

  // Validate the canonical reina.answer.v1 envelope structurally + fail-closed.
  // Returns { ok:true } or { ok:false, reason }.
  function validateEnvelope(env) {
    if (!isPlainObject(env)) return { ok: false, reason: 'malformed_envelope' };
    if (env.version !== ENVELOPE_VERSION) return { ok: false, reason: 'unrecognized_version' };
    // Structural executed:false is the single most important guard.
    if (!('executed' in env) || env.executed !== false) return { ok: false, reason: 'false_execution_claim' };
    if (env.executionStatement !== EXECUTION_STATEMENT) return { ok: false, reason: 'missing_execution_statement' };
    if (!isNonEmptyStr(env.answer)) return { ok: false, reason: 'missing_answer' };
    // Required transparency fields must all be present + correctly typed.
    if (!isArray(env.evidence)) return { ok: false, reason: 'missing_evidence' };
    if (!isPlainObject(env.freshness)) return { ok: false, reason: 'missing_freshness' };
    if (!isArray(env.missingInformation)) return { ok: false, reason: 'missing_missingInformation' };
    if (!isArray(env.conflictingInformation)) return { ok: false, reason: 'missing_conflictingInformation' };
    if (!isArray(env.uncertainty)) return { ok: false, reason: 'missing_uncertainty' };
    if (typeof env.refused !== 'boolean') return { ok: false, reason: 'missing_refused' };
    if (env.refused && !isNonEmptyStr(env.refusalReason)) return { ok: false, reason: 'missing_refusalReason' };
    // No HTML payload anywhere.
    if (looksLikeHtml(env.answer) || anyHtml([env.evidence, env.missingInformation, env.conflictingInformation, env.uncertainty, env.freshness, env.refusalReason])) {
      return { ok: false, reason: 'html_payload' };
    }
    return { ok: true };
  }

  // Validate the full server response correlates to the in-flight turn.
  function validateResponse(resp, turn) {
    if (!isPlainObject(resp)) return { ok: false, reason: 'malformed_response' };
    if (resp.ok !== true) return { ok: false, reason: 'not_ok' };
    // Correlation: BOTH ids must match the in-flight turn.
    if (resp.conversationId !== turn.conversationId) return { ok: false, reason: 'conversation_mismatch' };
    if (resp.turnId !== turn.turnId) return { ok: false, reason: 'turn_mismatch' };
    if ('idempotencyKey' in resp && resp.idempotencyKey !== turn.idempotencyKey) return { ok: false, reason: 'idempotency_mismatch' };
    // Replay must not be presented as a fresh conflicting turn.
    if (resp.replayed === true && resp.idempotencyKey !== turn.idempotencyKey) return { ok: false, reason: 'replay_conflict' };
    // Unsaved success is rejected: a successful answer must affirm persistence.
    if (resp.stored !== true) return { ok: false, reason: 'unsaved_success' };
    // Read-only/action markers and evidence-derived access markers must be
    // honest. Authorized read evidence is permitted; actions are not.
    if (resp.toolExecutionAllowed === true || resp.businessActionAllowed === true || resp.automationTaskAllowed === true) {
      return { ok: false, reason: 'action_allowed_claim' };
    }
    var ev = validateEnvelope(resp.envelope);
    if (!ev.ok) return ev;
    var hasSynthetic = false;
    var hasAuthorizedRead = false;
    if (resp.envelope.evidence.length === 0) return { ok: false, reason: 'missing_evidence' };
    for (var i = 0; i < resp.envelope.evidence.length; i += 1) {
      var entry = resp.envelope.evidence[i];
      if (!isPlainObject(entry)) return { ok: false, reason: 'missing_evidence' };
      if (entry.dataClass === 'synthetic') hasSynthetic = true;
      else if (entry.dataClass === 'authorized_read') hasAuthorizedRead = true;
      else return { ok: false, reason: 'invalid_evidence_class' };
    }
    var expectedAccess = hasSynthetic && hasAuthorizedRead ? 'mixed'
      : hasAuthorizedRead ? 'authorized_read' : 'synthetic';
    if (resp.dataAccess !== expectedAccess || resp.synthetic !== hasSynthetic) {
      return { ok: false, reason: 'dishonest_data_access' };
    }
    return { ok: true };
  }

  // Build the inert, textContent-only view model from a validated envelope.
  function toViewModel(state, env, extra) {
    var vm = {
      state: state,
      previewNotice: PREVIEW_NOTICE,
      executionNotice: EXECUTION_STATEMENT,
      syntheticNotice: 'Read-only evidence. No action was taken.',
      answer: '', evidence: [], freshness: '', missingInformation: [],
      conflictingInformation: [], uncertainty: [], refused: false, refusalReason: '',
    };
    if (env) {
      vm.answer = inert(env.answer);
      vm.evidence = inertList(env.evidence);
      vm.freshness = env.freshness && env.freshness.known ? inert('As of ' + (env.freshness.asOf || 'unknown') + (env.freshness.note ? (' — ' + env.freshness.note) : ''))
                                                          : 'Freshness unknown (no live source consulted).';
      vm.missingInformation = inertList(env.missingInformation);
      vm.conflictingInformation = inertList(env.conflictingInformation);
      vm.uncertainty = inertList(env.uncertainty);
      vm.refused = env.refused === true;
      vm.refusalReason = inert(env.refusalReason);
    }
    return Object.assign(vm, extra || {});
  }

  function createTypedPanel(deps) {
    deps = deps || {};
    if (!isNonEmptyStr(deps.conversationId)) throw new Error('createTypedPanel: an explicit conversationId is required');
    if (!isFn(deps.newId)) throw new Error('createTypedPanel: a collision-resistant newId() is required');
    if (!isFn(deps.submitTurn)) throw new Error('createTypedPanel: an injected submitTurn(request) seam is required');

    var conversationId = deps.conversationId;
    var newId = deps.newId;
    var submitTurn = deps.submitTurn;                     // Claude 2 attachment seam
    var onView = isFn(deps.onView) ? deps.onView : noop;  // host assigns fields via .textContent
    var onAuthExpired = isFn(deps.onAuthExpired) ? deps.onAuthExpired : noop;

    var state = 'idle';        // idle|loading|answered|error|auth_expired|unavailable
    var busy = false;          // one submit at a time (duplicate click/Enter suppression)
    var generation = 0;        // supersede stale in-flight responses
    var current = null;        // active turn {utterance,turnId,idempotencyKey,conversationId,attempts,gen}
    var usedTurnIds = {};

    function idempotencyKey(turnId) { return 'conv:' + conversationId + '::turn:' + turnId; }

    function emit(vm) { onView(vm); }
    function toState(next, extra) { state = next; emit(toViewModel(next, null, extra)); }
    function expire(turn) {
      state = 'auth_expired';
      try { onAuthExpired(); } catch (_) {}
      emit(toViewModel('auth_expired', null, { recoverable: 'reauth', turnId: turn ? turn.turnId : null }));
    }

    // Build a NEW turn from a fresh utterance (new stable turnId + idem key).
    function makeTurn(utterance) {
      var id;
      try { id = newId(); } catch (e) { return null; }
      if (!isNonEmptyStr(id) || id.length > 200 || usedTurnIds[id]) return null;
      usedTurnIds[id] = true;
      return { utterance: utterance, turnId: id, idempotencyKey: idempotencyKey(id), conversationId: conversationId, attempts: 0 };
    }

    // The ONLY request shape ever sent. Nothing else is included or trusted.
    function requestOf(turn) {
      return { utterance: turn.utterance, conversationId: conversationId, turnId: turn.turnId, idempotencyKey: turn.idempotencyKey, transport: 'typed' };
    }

    function dispatch(turn) {
      turn.attempts += 1;
      busy = true;
      var myGen = ++generation;
      turn.gen = myGen;
      current = turn;
      toState('loading', { turnId: turn.turnId });
      var p;
      try { p = submitTurn(requestOf(turn)); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (resp) {
        if (myGen !== generation) return;               // superseded -> ignore
        busy = false;
        // typed backend/auth/availability signals
        if (isPlainObject(resp) && resp.ok !== true) {
          var code = resp.error || resp.code;
          if (code === 'auth_expired' || code === 'authorization_expired') return expire(turn);
          if (code === 'unavailable' || code === 'disabled' || code === 'not_enabled' || resp.enabled === false) { state = 'unavailable'; return emit(toViewModel('unavailable', null, { turnId: turn.turnId })); }
          return fail('backend_error', turn, code);
        }
        var v = validateResponse(resp, turn);
        if (!v.ok) return fail(v.reason, turn);
        state = 'answered';
        emit(toViewModel('answered', resp.envelope, { turnId: turn.turnId, replayed: resp.replayed === true }));
      }).catch(function (err) {
        if (myGen !== generation) return;
        busy = false;
        if (err && err.code === 'auth_expired') return expire(turn);
        // A rejected transport used to land here as 'network_error' no matter
        // what the route actually said, which made the availability branch
        // above unreachable for any HTTP-level failure -- the route returns
        // 503 {"error":"disabled"}, the client rejected, and the panel blamed
        // the network. Honour the route's own reason when it sent one.
        var serverCode = err && err.serverCode;
        if (serverCode === 'auth_expired' || serverCode === 'authorization_expired') return expire(turn);
        if (serverCode === 'unavailable' || serverCode === 'disabled' || serverCode === 'not_enabled') {
          state = 'unavailable';
          return emit(toViewModel('unavailable', null, { turnId: turn.turnId }));
        }
        fail(serverCode ? 'backend_error' : 'network_error', turn, serverCode);
      });
    }

    // Honest failure: never rendered as a successful/grounded answer; retryable.
    function fail(reason, turn, detail) {
      state = 'error';
      emit(toViewModel('error', null, { reason: reason, turnId: turn ? turn.turnId : null, recoverable: 'retry' }));
    }

    return {
      // Natural free-form typed submission. New utterance -> new stable turn.
      // One submit at a time: duplicate click/Enter while busy is suppressed.
      submit: function (utterance) {
        if (busy) return { accepted: false, reason: 'busy' };
        var t = isStr(utterance) ? utterance.trim() : '';
        if (!t) return { accepted: false, reason: 'empty' };
        if (t.length > MAX_UTTERANCE_CHARS) return { accepted: false, reason: 'too_long' };
        var turn = makeTurn(t);
        if (!turn) return { accepted: false, reason: 'turn_id_unavailable' };
        dispatch(turn);
        return { accepted: true, turnId: turn.turnId, idempotencyKey: turn.idempotencyKey, conversationId: conversationId };
      },
      // Stable retry: SAME turnId + idempotencyKey (no new id) so the backend can
      // deduplicate. Only from an error/unavailable state.
      retry: function () {
        if (busy) return { accepted: false, reason: 'busy' };
        if (state !== 'error' && state !== 'unavailable') return { accepted: false, reason: 'nothing_to_retry' };
        if (!current) return { accepted: false, reason: 'nothing_to_retry' };
        dispatch(current);
        return { accepted: true, turnId: current.turnId, idempotencyKey: current.idempotencyKey };
      },
      reset: function () { busy = false; generation++; current = null; toState('idle'); },
      getState: function () { return state; },
      isBusy: function () { return busy; },
      getConversationId: function () { return conversationId; },
      getCurrentTurn: function () { return current ? { turnId: current.turnId, idempotencyKey: current.idempotencyKey, attempts: current.attempts } : null; },
    };
  }

  return {
    createTypedPanel: createTypedPanel,
    validateEnvelope: validateEnvelope,
    validateResponse: validateResponse,
    renderPlainText: function (env) { var v = validateEnvelope(env); return v.ok ? inert(env.answer) : ''; },
    toViewModel: toViewModel,
    ENVELOPE_VERSION: ENVELOPE_VERSION,
    EXECUTION_STATEMENT: EXECUTION_STATEMENT,
    PREVIEW_NOTICE: PREVIEW_NOTICE,
    MAX_UTTERANCE_CHARS: MAX_UTTERANCE_CHARS,
  };
});
