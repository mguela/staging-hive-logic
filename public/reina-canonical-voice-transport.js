// public/reina-canonical-voice-transport.js
//
// Reina Evolution -- CANONICAL VOICE TRANSPORT ADAPTER.
//
// The missing adapter between PR #81's Voice stack and Reina's ONE canonical
// typed/backend turn contract. It lets the Voice host submit SPOKEN turns
// through the exact same canonical turn interface typed Reina uses -- so voice
// and typed answers come from ONE canonical response, never a separate Voice
// model, prompt, endpoint, or "Voice brain".
//
// It plugs into PR #81 at a single seam: it produces a `submitTurn(payload)`
// function shaped exactly for `createReinaInAppVoiceHost({ submitTurn })` (and,
// underneath, the bridge/session), and it consumes an injected server transport
// that speaks the canonical contract.
//
//   bridge/session payload   { text, conversationId, turnId, idempotencyKey, source }
//        |  (this adapter maps -> canonical request, forwarding NOTHING else)
//        v
//   canonical request        { utterance, conversationId, turnId, idempotencyKey, transport }
//        |  serverTransport(request)   <-- Claude 2's backend attaches HERE
//        v
//   canonical response       (validated envelope; see CANONICAL_RESPONSE below)
//        |  (this adapter validates IDs + envelope BEFORE anything renders/speaks)
//        v
//   bridge/session result    { reply, speechSafe }   (BOTH from the one envelope)
//
// SECURITY / TRUST STANCE
//   * The canonical request carries ONLY: utterance, conversationId, turnId,
//     idempotencyKey, transport. The adapter never accepts or forwards client
//     role, company, identity, capability, authorization, system prompt, tools,
//     evidence, loader selection, source selection, or execution claims. It
//     builds the request from scratch -- it does not spread the payload.
//   * It VALIDATES the response's conversationId + turnId and the whole envelope
//     BEFORE returning anything to render or speak.
//   * It FAILS CLOSED (rejects, so the session enters an error state and NEVER
//     speaks a success) on authorization / network / model / persistence /
//     validation / timeout / storage failure, on executed:true / false
//     completion claims, malformed evidence, HTML/script payloads, mismatched
//     IDs, and replay conflicts.
//   * Authorization expiry is propagated with code 'auth_expired' so the session
//     stops speech and requires reauthentication.
//   * It executes NO business action, tool call, Jobs loader, Automation
//     submission, or phone/Twilio. It relays and validates -- nothing more.
//
// Duplicate-final, stale-generation, unclear-confirmation, stop, mute,
// interruption, emergency OFF, retry (stable idempotency), and disposal are all
// PRESERVED by PR #81's layers -- this adapter is downstream of them and does
// not weaken any. It invents NO voice-confidence threshold.
//
// ES module. Also publishes window.ReinaCanonicalVoiceTransport for later wiring.

'use strict';

// The canonical transport tags. Voice turns carry 'voice'; typed turns that flow
// through the same host carry 'typed'. Both share conversationId + idempotency.
export var CANONICAL_TRANSPORT_VOICE = 'voice';
export var CANONICAL_TRANSPORT_TYPED = 'typed';

// Angle-bracket markup / SSML sniff. Canonical text must be plain: any tag-like
// payload is refused (never interpreted, never sanitized-and-forwarded).
var MARKUP_RE = /<[^>]*>/;

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o);
}
function isNonEmptyString(s) {
  return typeof s === 'string' && s.trim().length > 0;
}
function isSafeText(s) {
  return typeof s === 'string' && !MARKUP_RE.test(s);
}

// A typed, fail-closed adapter error. `.code` lets the session route auth expiry
// (and lets tests assert the exact failure) while never leaking partial output.
function transportError(code, cause) {
  var e = new Error('canonical_voice_transport:' + code);
  e.code = code;
  if (cause && cause.message) e.cause = cause.message;
  return e;
}

// Validate the canonical response envelope against the request. Returns a code
// string on the FIRST violation, or null when the envelope is fully valid.
//
// Expected canonical envelope (CANONICAL_RESPONSE):
//   {
//     conversationId: <string, MUST equal request.conversationId>,
//     turnId:         <string, MUST equal request.turnId>,
//     executed:       false,               // structural non-execution (MUST be false)
//     nothingExecuted:true,                // explicit "nothing was executed"
//     state:          'synthetic'|'unverified',  // explicit synthetic/unverified state
//     answer: { text: <safe written>, speech?: <safe speech, derived from same envelope> },
//     evidence:       Array<object>,       // present (may be empty)
//     freshness:      <present, any shape>,
//     missingInformation: Array,           // present
//     conflicts:      Array,               // present (substantive data conflicts)
//     uncertainty:    object|null,         // uncertainty / refusal
//   }
function validateEnvelope(res, req) {
  if (!isPlainObject(res)) return 'malformed_envelope';

  // --- response IDs must match the request (before anything renders/speaks) ---
  if (res.conversationId !== req.conversationId) return 'conversation_id_mismatch';
  if (res.turnId !== req.turnId) return 'turn_id_mismatch';

  // --- structural non-execution: reject any execution / false-completion claim ---
  if (res.executed !== false) return 'execution_claimed'; // executed:true OR missing
  if (res.nothingExecuted !== true) return 'execution_claimed';
  if (res.toolCalls != null || res.actions != null || res.sideEffects != null) {
    return 'execution_claimed';
  }

  // --- explicit synthetic / unverified state (never "verified"/"executed") ---
  if (res.state !== 'synthetic' && res.state !== 'unverified') return 'unverified_state_missing';

  // --- answer: safe written + safe speech, both from THIS envelope ---
  if (!isPlainObject(res.answer)) return 'malformed_envelope';
  if (!isNonEmptyString(res.answer.text)) return 'empty_written';
  if (!isSafeText(res.answer.text)) return 'unsafe_payload';
  var speech = typeof res.answer.speech === 'string' ? res.answer.speech : res.answer.text;
  if (!isSafeText(speech)) return 'unsafe_payload';

  // --- evidence + structured fields must be present + well-formed ---
  if (!Array.isArray(res.evidence)) return 'malformed_evidence';
  for (var i = 0; i < res.evidence.length; i++) {
    if (!isPlainObject(res.evidence[i])) return 'malformed_evidence';
  }
  if (!Array.isArray(res.missingInformation)) return 'malformed_envelope';
  if (!Array.isArray(res.conflicts)) return 'malformed_envelope';
  if (typeof res.freshness === 'undefined') return 'malformed_envelope';
  if (!(res.uncertainty === null || isPlainObject(res.uncertainty))) return 'malformed_envelope';

  return null;
}

// Pull the speech text out of a VALID envelope (validation already guaranteed it
// is safe). Both written and spoken derive from this single envelope.
function envelopeSpeech(res) {
  return typeof res.answer.speech === 'string' ? res.answer.speech : res.answer.text;
}

export function createCanonicalVoiceTransport(options) {
  options = options || {};

  var serverTransport = options.serverTransport;
  if (typeof serverTransport !== 'function') {
    throw new Error('createCanonicalVoiceTransport: an injected serverTransport(request) is required');
  }

  // Optional network/model timeout. 0 (default) means "no adapter-level timeout"
  // -- rely on the serverTransport. Timer primitives are injectable for tests.
  var timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 0;
  var setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : (typeof setTimeout !== 'undefined' ? setTimeout : null);
  var clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : (typeof clearTimeout !== 'undefined' ? clearTimeout : null);

  // Race the transport against a timeout. Fails closed with code 'timeout'.
  function withTimeout(promise) {
    if (!timeoutMs || !setTimeoutFn) return promise;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeoutFn(function () {
        if (done) return;
        done = true;
        reject(transportError('timeout'));
      }, timeoutMs);
      Promise.resolve(promise).then(
        function (v) {
          if (done) return;
          done = true;
          if (clearTimeoutFn) clearTimeoutFn(timer);
          resolve(v);
        },
        function (e) {
          if (done) return;
          done = true;
          if (clearTimeoutFn) clearTimeoutFn(timer);
          reject(e);
        },
      );
    });
  }

  // Build the canonical request from ONLY the five allowed fields. Nothing else
  // from the payload -- no role/company/identity/capability/authorization/
  // system/tools/evidence/loader/source/execution -- is ever read or forwarded.
  function toCanonicalRequest(payload) {
    payload = payload || {};
    var transport =
      payload.source === 'text' || payload.source === 'typed'
        ? CANONICAL_TRANSPORT_TYPED
        : CANONICAL_TRANSPORT_VOICE;
    return {
      utterance: String(payload.text == null ? '' : payload.text),
      conversationId: payload.conversationId,
      turnId: payload.turnId,
      idempotencyKey: payload.idempotencyKey,
      transport: transport,
    };
  }

  // The submitTurn the Voice host/bridge/session calls. Voice and typed turns
  // BOTH flow through here, sharing conversationId + idempotency semantics.
  // Returns { reply, speechSafe } on a valid canonical response; otherwise it
  // REJECTS (fail closed) so nothing is spoken after a failure.
  async function submitTurn(payload) {
    var request = toCanonicalRequest(payload);

    var response;
    try {
      response = await withTimeout(
        Promise.resolve().then(function () {
          return serverTransport(request);
        }),
      );
    } catch (err) {
      // Propagate authorization expiry verbatim so the session stops speech and
      // requires reauthentication; everything else is a generic fail-closed.
      var code = err && (err.code || err.name);
      if (code === 'auth_expired') throw transportError('auth_expired', err);
      throw transportError(code || 'transport_failed', err);
    }

    // A response can ALSO signal auth expiry in-band.
    if (isPlainObject(response) && (response.authExpired === true || response.error === 'auth_expired')) {
      throw transportError('auth_expired');
    }

    // Validate IDs + envelope BEFORE producing anything to render or speak.
    var violation = validateEnvelope(response, request);
    if (violation) throw transportError(violation);

    // Written AND spoken derive from this single validated envelope.
    return {
      reply: response.answer.text,
      speechSafe: envelopeSpeech(response),
    };
  }

  return {
    submitTurn: submitTurn,
    // Exposed for host-side unit checks / documentation; not required for wiring.
    toCanonicalRequest: toCanonicalRequest,
  };
}

// Browser namespace publish for later wiring. Write-only + guarded; no page query.
if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined') {
  globalThis.window.ReinaCanonicalVoiceTransport = {
    createCanonicalVoiceTransport: createCanonicalVoiceTransport,
    CANONICAL_TRANSPORT_VOICE: CANONICAL_TRANSPORT_VOICE,
    CANONICAL_TRANSPORT_TYPED: CANONICAL_TRANSPORT_TYPED,
  };
}

export default {
  createCanonicalVoiceTransport: createCanonicalVoiceTransport,
  CANONICAL_TRANSPORT_VOICE: CANONICAL_TRANSPORT_VOICE,
  CANONICAL_TRANSPORT_TYPED: CANONICAL_TRANSPORT_TYPED,
};
