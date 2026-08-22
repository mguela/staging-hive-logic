/* public/reina-ui-intent-router.js
 *
 * Reina Evolution -- GOVERNED, READ-ONLY UI INTENT ROUTER.
 *
 * Lets Reina interact with the EXISTING HiveLogic interface through a tiny set
 * of tightly governed, read-only UI intents -- NEVER arbitrary model-generated
 * JavaScript, URLs, clicks, selectors, or DOM operations. Model prose is never
 * an executable intent: the router acts only on a canonical, server-issued
 * `reina.ui-intent.v1` object carried inside the injected canonical response,
 * and only after EXPLICIT confirmation tied to that exact pending intent.
 *
 * Supported intent classes (kinds):
 *   navigate      -> go to an existing allowlisted application view
 *   open_detail   -> open an existing record/detail panel
 *   apply_filter  -> apply an existing read-only filter/search
 *   focus_reina   -> focus the existing Reina panel
 * (The existing attention/review surface is reached as an allowlisted
 *  `navigate` destination -- no new kind is invented.)
 *
 * TRUST / SAFETY STANCE
 *   * The router NEVER touches the DOM. All navigation functions and element
 *     references are injected by the host; the router only calls the injected
 *     handler for the intent's kind with validated primitives.
 *   * HOSTILE-INPUT HARDENING: every field of the response, intent, context,
 *     dependencies, allowlist, param spec, and clock is read ONLY as an OWN data
 *     property via Object.getOwnPropertyDescriptor. Inherited properties are
 *     ignored, accessors (getters/setters) are rejected WITHOUT being invoked,
 *     throwing proxy traps fail closed, and Promise/exotic/malformed values are
 *     rejected. No input getter is ever invoked.
 *   * No global DOM searching on import or construction. Constructing the router
 *     performs no navigation, no handler call, and no side effect.
 *   * No innerHTML, eval, dynamic Function construction, event-handler strings,
 *     arbitrary selectors, or arbitrary URLs are ever produced or accepted.
 *   * Destinations are strict safe tokens; parameters are a flat map of
 *     primitives validated against a host allowlist. `javascript:`/`data:`/
 *     external HTTP(S)/other schemes, path traversal, control chars, malformed
 *     Unicode, HTML/script, accessors, proxies, and prototype-pollution keys are
 *     all rejected.
 *   * Client role, company, identity, capability, authorization, and policy
 *     claims are NEVER read or trusted; only the canonical intent fields are.
 *   * Structural `executed:false` and `requiresConfirmation:true` are required;
 *     a forged `executed:true` or `requiresConfirmation:false` is rejected.
 *   * Confirmation is explicit and bound to the exact pending intentId. Verbal
 *     "yes" and button confirmation both enter the SAME confirm(intentId) path.
 *     Duplicate confirmation navigates at most once. Expired / replaced /
 *     stale-turn / denied / malformed / already-used intents do nothing.
 *     Cancellation does nothing.
 *   * NAVIGATION SUCCESS IS EXPLICIT. A handler resolving is NOT success. The
 *     host handler MUST return (or resolve to) an explicit success result --
 *     either the primitive `true` or an object with an OWN data property
 *     `ok === true`. A malformed, false, missing, rejected, or throwing result
 *     is reported honestly as { executed:false, reason:'navigation_failed' }
 *     (never as completed).
 *   * BOUNDED NAVIGATION TIMEOUT. The handler runs under a timeout
 *     (deps.navigationTimeoutMs, small default). A never-settling (or slow)
 *     handler resolves to { executed:false, reason:'navigation_timeout' } and
 *     can NEVER complete later.
 *   * EVERY new propose() immediately revokes the prior pending intent FIRST --
 *     even when the new response has no intent, is malformed, is a hostile
 *     proxy, or fails validation.
 *   * RE-AUTHORIZATION AT CONFIRM. Immediately before invoking the handler, the
 *     injected host authorization (`allow`) is re-run against the EXACT FROZEN
 *     pending snapshot; primitive true is required or navigation is denied
 *     (reason 'authorization_revoked').
 *   * EXPLICIT HOST REVOCATION SEAM. revoke(reason) invalidates any pending
 *     confirmation (logout / auth expiry / session replacement / turn
 *     replacement); it is idempotent and makes a later confirm return
 *     { executed:false, reason }.
 *   * The caller-provided `source` label ('button'/'voice'/...) is AUDIT
 *     METADATA ONLY -- it never gates or proves a click/verbal event.
 *   * Confirmation reads ONLY the frozen pending snapshot (intentId + frozen
 *     kind/destination/parameters); the original response is never re-read.
 *   * propose() returns exactly { accepted:true } on success (the host obtains
 *     the id via getPending()) or { accepted:false, reason } on rejection.
 *   * Navigating / opening / filtering is UI-ONLY: it can never mutate business
 *     data. The router performs no form submission, schedule change, email
 *     action, payment, credential/permission change, upload/download execution,
 *     Automation submission, phone/Twilio, or arbitrary browser automation.
 *
 * PR #87 -> PR #88 ATTENTION-REVIEW SEAM (see host contract in the README-style
 * block at the bottom of this file):
 *   * The canonical attention-review ui-intent ORIGINATES FROM THE SERVER
 *     (carried in the bootstrap/answer response). PR #87's client-side review
 *     payload (categories, labels, counts) is NEVER read here and can neither
 *     create nor expand navigation authority.
 *   * PR #87 renders the SINGLE "would you like to review them?" prompt. The host
 *     proposes the server intent with `{ suppressConfirmRequest: true }` so the
 *     router does NOT emit a second confirmation prompt.
 *   * PR #87's verbal/button "yes" is the ONE explicit confirmation; the host
 *     calls `confirm(getPending().intentId)` -- the exact pending intentId.
 *   * Stale / replaced / mismatched / duplicate / expired / missing server
 *     intents perform nothing.
 *
 * Correlation is compatible with PR #84's canonical response correlation: an
 * intent is accepted only when its conversationId + turnId match the in-flight
 * turn (and any response-level ids agree).
 *
 * UMD: window.ReinaUiIntentRouter in the browser; module.exports in node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaUiIntentRouter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INTENT_VERSION = 'reina.ui-intent.v1';
  var KINDS = ['navigate', 'open_detail', 'apply_filter', 'focus_reina'];

  var MAX_ID_LEN = 200;
  var MAX_DEST_LEN = 64;
  var MAX_PARAM_KEYS = 16;
  var MAX_PARAM_VALUE_LEN = 256;
  var MAX_EXPIRY_HORIZON_MS = 15 * 60 * 1000; // future-bounded: at most 15 minutes ahead
  // Bounded navigation timeout. UI navigation is synchronous/near-instant, so a
  // small default fails a hung handler fast; hosts may raise it via
  // deps.navigationTimeoutMs.
  var DEFAULT_NAV_TIMEOUT_MS = 10;

  // A destination / token is a strict, scheme-less view name. This alone rejects
  // javascript:/data:/http(s)://, `//`, `..`, fragments, and control chars.
  var SAFE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
  var CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  var SCHEME_RE = /[a-z][a-z0-9+.\-]*:/i; // any URI scheme anywhere -> unsafe for free text
  var DANGEROUS_KEYS = { __proto__: true, prototype: true, constructor: true };

  function isFn(f) { return typeof f === 'function'; }
  function isNonEmptyStr(s) { return typeof s === 'string' && s.trim().length > 0; }
  function isPlainObject(o) { return o != null && typeof o === 'object' && !Array.isArray(o); }
  function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }

  // ---- HOSTILE-INPUT PRIMITIVE ---------------------------------------------
  // Read `key` from `obj` as an OWN DATA property only. Never invokes a getter,
  // never follows the prototype chain, and fails closed if a proxy trap throws.
  // Returns { ok:true, value } or { ok:false, reason }.
  function ownRead(obj, key) {
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
      return { ok: false, reason: 'not_object' };
    }
    var d;
    try {
      d = Object.getOwnPropertyDescriptor(obj, key);
    } catch (e) {
      return { ok: false, reason: 'read_failed' }; // hostile proxy getOwnPropertyDescriptor trap
    }
    if (!d) return { ok: false, reason: 'missing' }; // absent OR inherited-only
    if (typeof d.get === 'function' || typeof d.set === 'function' || !('value' in d)) {
      return { ok: false, reason: 'accessor' }; // getter/setter -> never invoke
    }
    return { ok: true, value: d.value };
  }
  // Own value or undefined (missing/inherited/accessor/throw -> undefined).
  function ownValue(obj, key) { var r = ownRead(obj, key); return r.ok ? r.value : undefined; }

  // Reject strings with unpaired (malformed) surrogates.
  function hasLoneSurrogate(s) {
    if (typeof s.isWellFormed === 'function') return !s.isWellFormed();
    return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  }

  // Detect tag-like / executable markup.
  function looksLikeHtml(s) {
    return typeof s === 'string' &&
      (/<[a-z!/][^>]*>/i.test(s) || /<\s*script/i.test(s) || /on\w+\s*=/i.test(s) || /javascript:/i.test(s));
  }

  function isSafeToken(s) {
    return typeof s === 'string' && s.length <= MAX_DEST_LEN && SAFE_TOKEN_RE.test(s);
  }

  // Bounded, plain search/filter text: no control chars, no HTML, no scheme
  // (blocks javascript:/data:/http(s):), no angle brackets, no lone surrogates.
  function isSafeText(s) {
    if (typeof s !== 'string') return false;
    if (s.length === 0 || s.length > MAX_PARAM_VALUE_LEN) return false;
    if (CONTROL_RE.test(s)) return false;
    if (hasLoneSurrogate(s)) return false;
    if (looksLikeHtml(s)) return false;
    if (/[<>]/.test(s)) return false;
    if (SCHEME_RE.test(s)) return false;
    if (/\.\.|\/\//.test(s)) return false; // path traversal / protocol-relative
    return true;
  }

  // A valid intentId is a bounded, nonempty primitive (safe string OR finite
  // number). Objects/booleans/null/undefined/etc. are rejected.
  function normalizeIntentId(raw) {
    if (typeof raw === 'string') {
      var s = raw.trim();
      if (!s || s.length > MAX_ID_LEN) return null;
      if (CONTROL_RE.test(s) || hasLoneSurrogate(s)) return null;
      return s;
    }
    if (isFiniteNum(raw)) {
      var n = String(raw);
      return n.length <= MAX_ID_LEN ? n : null;
    }
    return null;
  }

  // A valid expiry is a FUTURE, BOUNDED timestamp (epoch ms number or ISO
  // string). Must be > now and within MAX_EXPIRY_HORIZON_MS.
  function normalizeExpiry(raw, nowMs) {
    var ts = null;
    if (isFiniteNum(raw)) ts = raw;
    else if (typeof raw === 'string') { var p = Date.parse(raw); if (isFinite(p)) ts = p; }
    if (ts == null || !isFinite(ts)) return null;
    if (ts <= nowMs) return null; // not in the future
    if (ts - nowMs > MAX_EXPIRY_HORIZON_MS) return null; // not bounded
    return ts;
  }

  function valueMatchesSpec(v, spec) {
    if (Array.isArray(spec)) {
      // Enum of allowed literal primitives (strict).
      for (var i = 0; i < spec.length; i++) if (spec[i] === v) return true;
      return false;
    }
    if (spec === 'token') return isSafeToken(v);
    if (spec === 'text') return isSafeText(v);
    if (spec === 'int') return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 1e12;
    if (spec === 'bool') return typeof v === 'boolean';
    return false;
  }

  // An EXPLICIT navigation success signal from the host handler. A resolving
  // handler is NOT success. Only the primitive `true` or an OWN `ok === true`
  // data property counts. The result is read via descriptors so a hostile
  // handler-return getter is never invoked.
  function isExplicitSuccess(res) {
    if (res === true) return true;
    if (res == null || typeof res !== 'object') return false;
    var r = ownRead(res, 'ok');
    return r.ok && r.value === true;
  }

  // Validate a flat parameter object against the kind's allowlisted param spec.
  // Reads via own-property descriptors so accessors/proxies are rejected rather
  // than invoked, and refuses prototype-pollution keys + nested/non-primitive
  // values. Returns { ok:true, value:<plain copy> } or { ok:false, reason }.
  function validateParams(params, spec) {
    if (params == null) return { ok: true, value: {} };
    if (!isPlainObject(params)) return { ok: false, reason: 'bad_parameters' };
    var names;
    try {
      names = Object.getOwnPropertyNames(params);
    } catch (e) {
      return { ok: false, reason: 'parameter_read_failed' }; // hostile proxy trap
    }
    if (names.length > MAX_PARAM_KEYS) return { ok: false, reason: 'too_many_parameters' };
    var out = {};
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      if (DANGEROUS_KEYS[k] || k === '__proto__') return { ok: false, reason: 'prototype_pollution' };
      var dr = ownRead(params, k); // own DATA property only; accessor/proxy -> reject
      if (!dr.ok) {
        return { ok: false, reason: dr.reason === 'accessor' ? 'accessor' : 'parameter_read_failed' };
      }
      // Enumerability check (getOwnPropertyNames returns non-enumerable too).
      var d;
      try { d = Object.getOwnPropertyDescriptor(params, k); } catch (e) { return { ok: false, reason: 'parameter_read_failed' }; }
      if (!d || !d.enumerable) return { ok: false, reason: 'non_enumerable' };
      var v = dr.value;
      var t = typeof v;
      if (v !== null && (t === 'object' || t === 'function' || t === 'symbol')) {
        return { ok: false, reason: 'non_primitive_parameter' }; // rejects nested objects, promises, fns
      }
      var sr = ownRead(spec, k); // spec read hardened too (no inherited/accessor)
      if (!sr.ok) return { ok: false, reason: 'unknown_parameter' };
      if (!valueMatchesSpec(v, sr.value)) return { ok: false, reason: 'bad_parameter_value' };
      out[k] = v;
    }
    return { ok: true, value: out };
  }

  function shallowCopyParams(p) {
    var out = {};
    var keys = Object.keys(p);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = p[keys[i]];
    return out;
  }

  function createUiIntentRouter(deps) {
    // Read the dependency bag itself as own data properties only (a hostile deps
    // proxy cannot smuggle behavior through getters).
    var conversationId = ownValue(deps, 'conversationId');
    if (!isNonEmptyStr(conversationId)) {
      throw new Error('createUiIntentRouter: an explicit, server-issued conversationId is required');
    }
    var handlers = (function () { var v = ownValue(deps, 'handlers'); return isPlainObject(v) ? v : {}; })();
    var allowlist = (function () { var v = ownValue(deps, 'allowlist'); return isPlainObject(v) ? v : {}; })();
    var hostAllow = (function () { var v = ownValue(deps, 'allow'); return isFn(v) ? v : null; })();
    var nowDep = (function () { var v = ownValue(deps, 'now'); return isFn(v) ? v : null; })();
    var navTimeoutMs = (function () { var v = ownValue(deps, 'navigationTimeoutMs'); return (isFiniteNum(v) && v > 0) ? v : DEFAULT_NAV_TIMEOUT_MS; })();
    // Callbacks snapshotted once at construction (never re-read from a getter).
    var cbConfirmRequest = (function () { var v = ownValue(deps, 'onConfirmRequest'); return isFn(v) ? v : null; })();
    var cbExecuted = (function () { var v = ownValue(deps, 'onExecuted'); return isFn(v) ? v : null; })();
    var cbError = (function () { var v = ownValue(deps, 'onError'); return isFn(v) ? v : null; })();
    var cbDenied = (function () { var v = ownValue(deps, 'onDenied'); return isFn(v) ? v : null; })();
    var cbCancelled = (function () { var v = ownValue(deps, 'onCancelled'); return isFn(v) ? v : null; })();

    var pending = null;       // FROZEN snapshot { intentId, kind, destination, parameters, expiresAt, turnId, consumed }
    var lastPendingId = null; // id of the most recent intent that WAS validly pending (for honest confirm-after-gone)
    var revokedReason = null; // sticky host-revocation reason (logout/auth-expiry/session/turn replacement)
    var disposed = false;

    function safeEmit(fn, arg) { if (isFn(fn)) { try { fn(arg); } catch (e) { /* callback must never break the router */ } } }
    function assign(a, b) { if (b) { for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; } return a; }
    function emitDenied(reason, extra) { safeEmit(cbDenied, assign({ reason: reason }, extra)); }
    function emitError(reason, extra) { safeEmit(cbError, assign({ reason: reason }, extra)); }

    function deny(reason, silent) {
      if (!silent) emitDenied(reason, null);
      return { accepted: false, reason: reason };
    }
    function notExecuted(reason) { return { executed: false, reason: reason }; }

    // Read the clock as a hardened dependency: a throwing, Promise-returning, or
    // non-finite result fails closed to null.
    function readClock() {
      var v;
      try { v = nowDep ? nowDep() : Date.now(); } catch (e) { return null; }
      return isFiniteNum(v) ? v : null;
    }

    function validateDestination(kind, destination, allow) {
      var destsR = ownRead(allow, 'destinations');
      var dests = destsR.ok ? destsR.value : undefined;
      if (kind === 'focus_reina' && (destination == null || destination === '')) {
        return { ok: true, value: '' };
      }
      if (!isSafeToken(destination)) return { ok: false, reason: 'unsafe_destination' };
      if (Array.isArray(dests)) {
        if (dests.indexOf(destination) === -1) return { ok: false, reason: 'destination_not_allowlisted' };
        return { ok: true, value: destination };
      }
      return { ok: false, reason: 'destination_not_allowlisted' };
    }

    // Accept (only) a canonical server response's ui-intent, correlate it, fully
    // validate it, and -- on success -- store it as the single pending intent
    // (replacing any prior pending, which becomes stale) and request explicit
    // confirmation. Never executes anything. Every field read is an OWN data
    // property (no getter is ever invoked).
    //
    // context: { turnId, suppressConfirmRequest? }
    //   suppressConfirmRequest:true -> store pending but DO NOT emit
    //   onConfirmRequest (the PR #87 seam owns the single prompt).
    function propose(response, context) {
      if (disposed) return deny('disposed', true);
      // REQUIREMENT 1: EVERY new propose attempt immediately revokes the prior
      // pending intent FIRST -- before any validation -- so a no-intent /
      // malformed / hostile / failing new response still invalidates the old
      // pending. (lastPendingId is preserved so a later confirm is honest.)
      if (pending) { lastPendingId = pending.intentId; pending = null; }
      revokedReason = null; // a fresh proposal clears any sticky revoke reason
      try {
        if (!isPlainObject(response)) return deny('malformed_response');
        var intentR = ownRead(response, 'uiIntent');
        if (intentR.reason === 'accessor') return deny('accessor');
        // Prose or a response without a canonical own ui-intent -> nothing to do.
        if (!intentR.ok || !isPlainObject(intentR.value)) return deny('no_intent', true);
        var intent = intentR.value;

        // Read EVERY intent field once as an OWN DATA property. A getter/setter
        // on ANY field is rejected as 'accessor' WITHOUT being invoked, so an
        // accessor can never mutate kind (or anything) after validation.
        var F = {};
        var FIELDS = ['version', 'executed', 'requiresConfirmation', 'conversationId',
          'turnId', 'intentId', 'expiresAt', 'kind', 'destination', 'parameters'];
        for (var fi = 0; fi < FIELDS.length; fi++) {
          var fr = ownRead(intent, FIELDS[fi]);
          if (fr.reason === 'accessor') return deny('accessor');
          F[FIELDS[fi]] = fr.ok ? fr.value : undefined;
        }

        if (F.version !== INTENT_VERSION) return deny('unrecognized_version');
        // Structural, non-negotiable guards.
        if (F.executed !== false) return deny('false_execution_claim');
        if (F.requiresConfirmation !== true) return deny('confirmation_not_required');

        // Correlation (compatible with PR #84): conversation + turn must match.
        if (F.conversationId !== conversationId) return deny('conversation_mismatch');
        var expectedTurn = ownValue(context, 'turnId');
        if (!isNonEmptyStr(expectedTurn)) return deny('no_turn_context');
        if (F.turnId !== expectedTurn) return deny('turn_mismatch');
        // Response-level ids (if present as OWN properties) must also agree.
        var respConvR = ownRead(response, 'conversationId');
        if (respConvR.ok && respConvR.value !== conversationId) return deny('conversation_mismatch');
        var respTurnR = ownRead(response, 'turnId');
        if (respTurnR.ok && respTurnR.value !== expectedTurn) return deny('turn_mismatch');

        var intentId = normalizeIntentId(F.intentId);
        if (intentId == null) return deny('invalid_intent_id');

        var nowMs = readClock();
        if (nowMs == null) return deny('clock_unavailable');
        var expiresAt = normalizeExpiry(F.expiresAt, nowMs);
        if (expiresAt == null) return deny('invalid_expiry');

        var kind = F.kind;
        if (KINDS.indexOf(kind) === -1) return deny('unsupported_kind');

        // Handler + allowlist for the kind, read as OWN data properties.
        var handlerR = ownRead(handlers, kind);
        if (!handlerR.ok || !isFn(handlerR.value)) return deny('no_handler');
        var allowR = ownRead(allowlist, kind);
        if (!allowR.ok || !isPlainObject(allowR.value)) return deny('kind_not_allowlisted');
        var allow = allowR.value;

        var dres = validateDestination(kind, F.destination, allow);
        if (!dres.ok) return deny(dres.reason);

        var paramSpec = (function () { var r = ownRead(allow, 'params'); return r.ok ? r.value : undefined; })();
        var pres = validateParams(F.parameters, paramSpec);
        if (!pres.ok) return deny(pres.reason);

        // Optional extra host allowlist gate -- must return primitive true.
        if (hostAllow) {
          var ok;
          try {
            ok = hostAllow({ kind: kind, destination: dres.value, parameters: pres.value, intentId: intentId });
          } catch (e) {
            return deny('allowlist_error');
          }
          if (ok !== true) return deny('denied_by_host');
        }

        // Accept. Store a FROZEN snapshot (requirement 5): confirm reads ONLY
        // this snapshot -- kind/destination/parameters are captured now and the
        // original response is never re-read.
        pending = {
          intentId: intentId,
          kind: kind,
          destination: dres.value,
          parameters: pres.value,
          expiresAt: expiresAt,
          turnId: expectedTurn,
          consumed: false,
        };
        lastPendingId = intentId;
        // The PR #87 seam owns the single prompt; suppress a second one.
        if (ownValue(context, 'suppressConfirmRequest') !== true) {
          safeEmit(cbConfirmRequest, {
            intentId: intentId,
            kind: kind,
            destination: dres.value,
            parameters: shallowCopyParams(pres.value),
            expiresAt: expiresAt,
            requiresConfirmation: true,
          });
        }
        return { accepted: true };
      } catch (e) {
        // Any thrown error (e.g. a hostile proxy) -> fail closed, nothing pending.
        return deny('propose_failed');
      }
    }

    // Invoke the host handler under a BOUNDED timeout (requirement 2). A
    // never-settling (or slow) handler resolves to navigation_timeout and can
    // NEVER complete later (the settled latch drops any late resolution).
    // `source` is AUDIT METADATA ONLY (requirement 7) -- it never gates or
    // proves a click/verbal event; it is echoed into the onExecuted event only.
    function runWithTimeout(handler, p, source) {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          emitError('navigation_timeout', { intentId: p.intentId, kind: p.kind });
          resolve({ executed: false, reason: 'navigation_timeout' });
        }, navTimeoutMs);
        function clear() { try { clearTimeout(timer); } catch (e) {} }
        Promise.resolve()
          .then(function () {
            // UI-ONLY navigation via the host-injected handler. Validated
            // primitives only -- no URL, selector, or DOM string is constructed.
            return handler(p.destination, shallowCopyParams(p.parameters));
          })
          .then(function (res) {
            if (settled) return; // already timed out -> handler cannot complete later
            settled = true; clear();
            // SUCCESS IS EXPLICIT: a bare resolve is not success. Require the
            // documented host success signal (true | own { ok:true }, read via
            // descriptor). Anything else is honestly NOT executed.
            if (isExplicitSuccess(res)) {
              safeEmit(cbExecuted, { intentId: p.intentId, kind: p.kind, destination: p.destination, source: source });
              resolve({ executed: true, intentId: p.intentId, kind: p.kind, destination: p.destination, source: source });
            } else {
              emitError('navigation_failed', { intentId: p.intentId, kind: p.kind });
              resolve({ executed: false, reason: 'navigation_failed' });
            }
          })
          .catch(function () {
            if (settled) return;
            settled = true; clear();
            emitError('navigation_failed', { intentId: p.intentId, kind: p.kind });
            resolve({ executed: false, reason: 'navigation_failed' });
          });
      });
    }

    // The SINGLE execution path. Both verbal "yes" and button confirmation reach
    // navigation only through here, bound to the EXACT pending intentId + FROZEN
    // snapshot. Failure results are minimal { executed:false, reason }.
    function execute(intentId, source) {
      if (disposed) return Promise.resolve(notExecuted('disposed'));
      if (!pending) {
        // Nothing pending. Distinguish a host-revoked / gone intent (honest
        // reason) from an id that was never ours (bare not-executed).
        if (intentId === lastPendingId) {
          return Promise.resolve(revokedReason ? notExecuted(revokedReason) : notExecuted('nothing_pending'));
        }
        return Promise.resolve({ executed: false });
      }
      if (intentId !== pending.intentId) return Promise.resolve(notExecuted('intent_mismatch'));
      if (pending.consumed) return Promise.resolve(notExecuted('already_used')); // duplicate -> at most once
      var nowMs = readClock();
      if (nowMs == null) return Promise.resolve(notExecuted('clock_unavailable')); // cannot verify expiry -> nothing
      if (nowMs > pending.expiresAt) {
        var expiredId = pending.intentId;
        pending.consumed = true;
        emitError('expired', { intentId: expiredId });
        return Promise.resolve(notExecuted('expired'));
      }
      // Consume SYNCHRONOUSLY before any await so a duplicate confirm in the same
      // tick cannot double-fire the navigation.
      pending.consumed = true;
      var p = pending; // FROZEN snapshot; the original response is never re-read.
      // REQUIREMENT 3: re-run the injected host authorization against the exact
      // frozen snapshot immediately before invoking the handler. Primitive true
      // is required; anything else (or a throw) denies without navigating.
      if (hostAllow) {
        var ok;
        try {
          ok = hostAllow({ kind: p.kind, destination: p.destination, parameters: shallowCopyParams(p.parameters), intentId: p.intentId });
        } catch (e) {
          emitError('authorization_revoked', { intentId: p.intentId });
          return Promise.resolve(notExecuted('authorization_revoked'));
        }
        if (ok !== true) {
          emitError('authorization_revoked', { intentId: p.intentId });
          return Promise.resolve(notExecuted('authorization_revoked'));
        }
      }
      var handlerR = ownRead(handlers, p.kind);
      if (!handlerR.ok || !isFn(handlerR.value)) {
        emitError('no_handler', { intentId: p.intentId });
        return Promise.resolve(notExecuted('no_handler'));
      }
      return runWithTimeout(handlerR.value, p, source);
    }

    return {
      // Governed lifecycle
      propose: propose,
      confirm: function (intentId, source) { return execute(intentId, source || 'explicit'); },
      // Verbal "yes" -> same confirm path, bound to the current pending intentId.
      confirmPending: function (source) {
        if (disposed || !pending || pending.consumed) return Promise.resolve(notExecuted('nothing_pending'));
        return execute(pending.intentId, source || 'verbal');
      },
      cancel: function (intentId) {
        if (disposed || !pending) return { cancelled: false, reason: 'nothing_pending' };
        if (intentId != null && intentId !== pending.intentId) return { cancelled: false, reason: 'intent_mismatch' };
        var id = pending.intentId;
        lastPendingId = id;
        pending = null; // nothing is executed
        safeEmit(cbCancelled, { intentId: id });
        return { cancelled: true, intentId: id };
      },
      // REQUIREMENT 4: explicit, idempotent host revocation seam. The RC host
      // wires logout / authentication expiry / session replacement / turn
      // replacement to this. It invalidates any pending confirmation and makes a
      // subsequent confirm of that intent return { executed:false, reason }.
      // Idempotent: repeated calls are safe and keep the (first) reason sticky
      // until the next propose().
      revoke: function (reason) {
        if (disposed) return { revoked: false, reason: 'disposed' };
        var r = isNonEmptyStr(reason) ? reason : 'revoked';
        if (pending) { lastPendingId = pending.intentId; pending = null; }
        if (revokedReason == null) revokedReason = r; // sticky (idempotent)
        return { revoked: true, reason: revokedReason };
      },
      // Inspection (inert snapshots)
      getPending: function () {
        if (!pending || pending.consumed) return null;
        return {
          intentId: pending.intentId,
          kind: pending.kind,
          destination: pending.destination,
          parameters: shallowCopyParams(pending.parameters),
          expiresAt: pending.expiresAt,
        };
      },
      getConversationId: function () { return conversationId; },
      isDisposed: function () { return disposed; },
      dispose: function () { disposed = true; pending = null; },
    };
  }

  return {
    createUiIntentRouter: createUiIntentRouter,
    INTENT_VERSION: INTENT_VERSION,
    KINDS: KINDS.slice(),
    MAX_EXPIRY_HORIZON_MS: MAX_EXPIRY_HORIZON_MS,
  };
});

/* ===========================================================================
 * HOST CONTRACT for Codex 1's RC integration (public/index.html wiring)
 * ===========================================================================
 *
 * Construction (once per authenticated conversation):
 *   var router = createUiIntentRouter({
 *     conversationId: <server-issued string>,          // required
 *     handlers: {                                       // UI-only, host-owned
 *       navigate:     function (destination, params) { ...; return { ok: true }; },
 *       open_detail:  function (destination, params) { ...; return { ok: true }; },
 *       apply_filter: function (destination, params) { ...; return { ok: true }; },
 *       focus_reina:  function (destination, params) { ...; return { ok: true }; },
 *     },
 *     allowlist: {                                      // host-owned governance
 *       navigate:     { destinations: ['attention', ...], params: { ... } },
 *       ...
 *     },
 *     allow: function (intent) { return true; },        // optional gate; RE-RUN at confirm (primitive true)
 *     now:   function () { return Date.now(); },        // optional injected clock
 *     navigationTimeoutMs: 4000,                         // optional bounded handler timeout (small default)
 *     onConfirmRequest, onExecuted, onError, onDenied, onCancelled, // optional callbacks
 *   });
 *
 * HANDLER SUCCESS CONTRACT (REQUIRED):
 *   A handler MUST return (or resolve to) an EXPLICIT success result to be
 *   reported as executed: either the primitive `true` or `{ ok: true }`.
 *   Anything else (undefined, false, a malformed object, a thrown error, or a
 *   rejected promise) -> { executed:false, reason:'navigation_failed' }. A
 *   handler that does not settle within navigationTimeoutMs ->
 *   { executed:false, reason:'navigation_timeout' } and cannot complete later.
 *   Neither is ever surfaced as completed navigation.
 *
 * REVOCATION / RE-AUTH (REQUIRED WIRING for logout, auth expiry, session/turn
 * replacement): call router.revoke('authorization_expired' | 'logout' |
 * 'session_replaced' | 'turn_replaced'). After revoke, confirm() of that intent
 * returns { executed:false, reason } and never navigates. If an `allow` gate is
 * injected, it is ALSO re-run against the frozen snapshot at confirm time
 * (primitive true required, else reason 'authorization_revoked'). The `source`
 * label is audit metadata only and must not be treated as proof of a gesture.
 *
 * PR #87 -> PR #88 ATTENTION-REVIEW SEAM:
 *   1. The server bootstrap/answer response carries the canonical review intent:
 *        response.uiIntent = { version:'reina.ui-intent.v1', conversationId,
 *          turnId, intentId, kind:'navigate', destination:'attention',
 *          parameters:{}, requiresConfirmation:true, expiresAt, executed:false }
 *   2. PR #87 renders the SINGLE "would you like to review them?" prompt. The
 *      host proposes the SERVER intent WITHOUT a second prompt:
 *        router.propose(serverResponse, { turnId, suppressConfirmRequest: true });
 *   3. PR #87's verbal/button "yes" (its one explicit confirmation) -> host:
 *        var pend = router.getPending();
 *        if (pend) router.confirm(pend.intentId, source);   // exact pending id
 *   4. PR #87's client review payload (categories/labels/counts/destination) is
 *      NEVER passed here and cannot create or expand navigation authority: the
 *      destination + parameters come ONLY from the server intent and must pass
 *      the host allowlist. A forged client destination has no effect.
 *   5. Stale / replaced / mismatched / duplicate / expired / missing server
 *      intents perform nothing (confirm returns { executed:false, ... }).
 * =========================================================================== */
