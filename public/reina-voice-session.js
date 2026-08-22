/* public/reina-voice-session.js
 *
 * UNWIRED, dependency-injected in-app voice SESSION CORE for Reina. Pure
 * controller/state-machine — no real speech, network, persistence, or DOM work.
 * Safe to ship unwired (does not touch index.html, voice-input.js, preview, or
 * phone/Twilio).
 *
 * States: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error' | 'off'.
 * Reply delivery is a SEPARATE onReply callback (not a pseudo-state).
 *
 * Hardening summary:
 *  - startListening()/interrupt() handle synchronous throws AND rejected start
 *    promises without unhandled rejection or a false 'listening' state.
 *  - Every transcript carries the EXACT active generation (missing/stale/stopped
 *    -> deny); recognition errors likewise require the exact generation.
 *  - Physical recognition is STOPPED (awaited, fail-closed) before any accepted
 *    typed/spoken turn is dispatched.
 *  - Every FINAL transcript needs a bounded, nonempty PRIMITIVE eventId.
 *  - Generated ids are validated + unique; idempotency keys use an unambiguous,
 *    length-prefixed encoding of (conversationId, turnId) that cannot collide
 *    across the component boundary, and are stable across retries.
 *  - Speech policy is evaluated safely for sync OR async isSpeechAllowed; speech
 *    is permitted only when the final primitive result is exactly `true`. false,
 *    Promise-resolving-false, malformed values, throws, and rejections all deny.
 *  - Emergency OFF wins the mic-start race: if OFF happens while start() is
 *    pending, a later successful start is stopped again and the session stays
 *    OFF, accepting no transcript or turn.
 *  - interrupt() awaits synthesizer.cancel() BEFORE starting recognition; a
 *    thrown/rejected cancellation fails closed and never starts the mic.
 *  - Injected-dependency failures (throwing/malformed isEmergencyOff, throwing
 *    verdict.decision getter, throwing/rejected speech policy) never escape a
 *    public method: they become typed, bounded, fail-closed results and nothing
 *    is dispatched, spoken, or started.
 *  - Preserved: speech disabled by default; only speechSafe is spoken; emergency
 *    OFF; auth-expiry; stable retry identity; no panel/phone wiring.
 *
 * UMD: window.ReinaVoiceSession in the browser; module.exports in node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaVoiceSession = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function noop() {}
  function isFn(f) { return typeof f === 'function'; }
  function isNonEmptyStr(s) { return typeof s === 'string' && s.trim().length > 0; }
  var MAX_ID_LEN = 200;
  var MAX_CONV_ID_LEN = 200;
  var MAX_EVENT_ID_LEN = 200;
  var MAX_TRANSCRIPT_LEN = 4000;

  // A valid final-transcript eventId is a bounded, nonempty PRIMITIVE (string or
  // finite number). Booleans, objects, arrays, null/undefined are rejected.
  function normalizeEventId(raw) {
    if (typeof raw === 'string') { var s = raw.trim(); return (s && s.length <= MAX_EVENT_ID_LEN) ? s : null; }
    if (typeof raw === 'number' && isFinite(raw)) { var n = String(raw); return n.length <= MAX_EVENT_ID_LEN ? n : null; }
    return null;
  }

  // An assessment may safely remove an app-owned wake phrase from the already
  // transcribed final. It may not synthesize authority or replace it with an
  // arbitrary object/value: absent or invalid replacement always uses the
  // original transcript.
  function acceptedText(verdict, fallback) {
    var replacement;
    try { replacement = verdict && verdict.text; } catch (e) { return fallback; }
    if (typeof replacement !== 'string') return fallback;
    replacement = replacement.trim();
    return replacement && replacement.length <= MAX_TRANSCRIPT_LEN ? replacement : fallback;
  }

  function createVoiceSession(deps) {
    deps = deps || {};
    if (!isNonEmptyStr(deps.conversationId) || deps.conversationId.length > MAX_CONV_ID_LEN) throw new Error('createVoiceSession: an explicit, bounded conversationId is required');
    if (!isFn(deps.newId)) throw new Error('createVoiceSession: a collision-resistant newId() is required (no weak defaults)');

    var conversationId = deps.conversationId;
    var newId = deps.newId;
    var recognizer = deps.recognizer || { start: noop, stop: noop, mute: noop };
    var synthesizer = deps.synthesizer || { speak: function () { return Promise.resolve(); }, cancel: noop };
    var submitTurn = isFn(deps.submitTurn) ? deps.submitTurn : function () { return Promise.reject(new Error('no transport')); };
    var assessTranscript = isFn(deps.assessTranscript) ? deps.assessTranscript : function () { return { decision: 'confirm' }; };
    var isSpeechAllowed = isFn(deps.isSpeechAllowed) ? deps.isSpeechAllowed : function () { return false; };
    var isEmergencyOff = isFn(deps.isEmergencyOff) ? deps.isEmergencyOff : function () { return false; };
    var onState = isFn(deps.onState) ? deps.onState : noop;
    var onReply = isFn(deps.onReply) ? deps.onReply : noop; // separate reply channel (not a state)
    // Optional. Receives the name of a guard that declined to start the
    // microphone, or a recognition error that was dropped before it could
    // reach fail(). Neither of those is a state change, so neither had any
    // channel out of this module before.
    var onBlock = isFn(deps.onBlock) ? deps.onBlock : null;

    var state = 'idle';
    var muted = false;
    var offed = false;
    var generation = 0;          // increments per listening start / accepted turn / interrupt
    var seq = 0;                 // increments per submitted turn; tags responses
    var current = null;          // active turn
    var seenFinalEvents = {};    // stable-id de-dup of repeated final events
    var usedIds = {};            // unique-within-session id enforcement

    function set(next, detail) { state = next; onState(state, detail || null); }
    // Injected, optional and wrapped: a session must keep running whether or
    // not anything is listening to its refusals. Returns false so a guard can
    // read `return noteBlock(...)` in place of `return false`.
    function noteBlock(reason) {
      try { if (typeof onBlock === 'function') onBlock(String(reason)); } catch (e) {}
      return false;
    }
    function fail(reason, err, meta) { set('error', Object.assign({ reason: reason, message: err && err.message }, meta || {})); return { accepted: false, reason: reason }; }

    // A throwing OR malformed emergency-OFF signal must never escape and must
    // FAIL CLOSED: only an explicit `false` permits operation; `true`, a throw,
    // or any non-boolean value is treated as OFF (blocks dispatch/speak/start).
    function emergencyOffSignaled() {
      var v;
      try { v = isEmergencyOff(); } catch (e) { return true; }
      if (v === false) return false;
      return true; // v === true OR any malformed non-boolean -> OFF
    }
    function emergencyGuard() { if (offed || emergencyOffSignaled()) { forceOff('emergency'); return true; } return false; }
    function forceOff(reason) {
      offed = true; generation++; current = null;
      try { recognizer.stop(); } catch (e) {}
      try { synthesizer.cancel(); } catch (e) {}
      set('off', { reason: reason || 'emergency_off' });
    }

    // Validate + reserve a fresh turn id: nonempty bounded string, unique.
    function reserveTurnId() {
      var id;
      try { id = newId(); } catch (e) { return null; }
      if (!isNonEmptyStr(id) || id.length > MAX_ID_LEN) return null;
      if (usedIds[id]) return null; // reuse rejected
      usedIds[id] = true;
      return id;
    }

    // Unambiguous, collision-free idempotency identity. A naive delimiter join
    // ("conv:<c>::turn:<t>") lets a crafted conversationId absorb the boundary
    // so that (c="a::turn:b", t="c") and (c="a", t="b::turn:c") collide. Encode
    // each component with an explicit length prefix so the boundary can never be
    // forged; both components are length-bounded.
    function idempotencyKey(turnId) {
      return 'rvk1|' + conversationId.length + ':' + conversationId + '|' + turnId.length + ':' + turnId;
    }

    // ---- microphone control -------------------------------------------------
    // async: returns false for a synchronous throw OR a rejected start promise,
    // and never leaves a false 'listening' state. If emergency OFF (or a new
    // generation) lands while start() is pending, a now-active recognizer is
    // stopped again and we remain OFF/superseded — never listening.
    async function startListening() {
      // Both refusals below were bare `return false`. A press that lands while
      // a previous turn is still thinking or speaking looked identical to a
      // press that did nothing at all -- no state change, no event, no row.
      if (emergencyGuard()) return noteBlock('emergency_off');
      if (state === 'thinking' || state === 'speaking') return noteBlock('busy_' + state);
      var myGen = ++generation;
      seenFinalEvents = {};
      try {
        var started = await Promise.resolve().then(function () { return recognizer.start(); });
        if (started === false) return false;
      } catch (e) {
        recognitionError({ kind: 'start_failed', generation: myGen, error: e });
        return false;
      }
      // Re-check OFF + generation AFTER startup settles. Emergency OFF may have
      // occurred (and already called stop()) while start() was pending, leaving
      // a now-active recognizer; stop/abort it again and remain OFF.
      if (offed || emergencyOffSignaled()) {
        try { recognizer.stop(); } catch (e) {}
        if (!offed) forceOff('emergency');
        return false;
      }
      if (myGen !== generation) {
        try { recognizer.stop(); } catch (e) {} // superseded during start; don't leave it running
        return false;
      }
      set('listening', { generation: myGen });
      return true;
    }
    function stopListening() {
      if (offed) return;
      // Preserve the active generation while a controlled recorder delivers
      // its one final transcript during a graceful stop.
      try { recognizer.stop(); } catch (e) {}
    }
    function mute() {
      muted = true; try { recognizer.mute(true); } catch (e) {}
      if (state === 'speaking') { try { synthesizer.cancel(); } catch (e) {} seq++; current = null; set('idle', { muted: true }); }
    }
    function unmute() { muted = false; try { recognizer.mute(false); } catch (e) {} }
    function isMuted() { return muted; }

    // ---- generation-scoped recognition-error handler ------------------------
    // Wire recognizer errors (permission_denied | no_speech | network | aborted
    // | start_failed | stale) here. The EXACT active generation is required: a
    // missing generation is denied, a stale generation is ignored.
    function recognitionError(err) {
      err = err || {};
      // A dropped recognition error never reaches fail(), so the session never
      // enters 'error' and the panel never returns to a startable state -- the
      // button goes inert and nothing anywhere says why.
      if (err.generation == null) { noteBlock('recognition_missing_generation'); return { handled: false, reason: 'missing_generation' }; }
      if (err.generation !== generation) { noteBlock('recognition_stale_generation'); return { handled: false, reason: 'stale_generation' }; }
      if (offed) { noteBlock('recognition_while_off'); return { handled: false, reason: 'off' }; }
      var kind = isNonEmptyStr(err.kind) ? err.kind : 'recognition_error';
      try { recognizer.stop(); } catch (e) {}
      fail('recognition_' + kind, err.error, { kind: kind });
      return { handled: true, kind: kind };
    }

    // A recognition can end WITHOUT a final transcript and WITHOUT an error:
    // the user closes the panel, cancels, or the recorder simply stops having
    // heard nothing worth sending. Nothing then moved this session out of
    // 'listening'. The panel mirrors session state, so it sat on LISTENING --
    // and its start guard refuses any press while the state is neither idle
    // nor error, so the microphone button went permanently dead until reload.
    // That is the defect behind a whole day of "I pressed it and nothing
    // happened"; the refusal that reported it named `panel_state_listening`.
    //
    // A result or an error has already moved the state on by the time 'end'
    // arrives, so only a still-'listening' session is stranded, and only that
    // one is returned to idle here. Nothing is retried and nothing is sent.
    function recognitionEnded(info) {
      info = info || {};
      if (info.generation == null) return { handled: false, reason: 'missing_generation' };
      if (info.generation !== generation) return { handled: false, reason: 'stale_generation' };
      if (offed) return { handled: false, reason: 'off' };
      if (state !== 'listening') return { handled: false, reason: 'not_listening' };
      set('idle', { reason: 'recognition_ended' });
      return { handled: true };
    }

    // Read verdict.decision defensively: a throwing getter must not escape.
    function readDecision(verdict) {
      try { return (verdict && verdict.decision) || null; } catch (e) { return null; }
    }

    // ---- transcription ------------------------------------------------------
    function handleTranscript(text, opts) {
      if (emergencyGuard()) return { accepted: false, reason: 'off' };
      opts = opts || {};
      if (state !== 'listening') return { accepted: false, reason: 'not_listening' };
      // The EXACT active generation is required on every transcript.
      if (opts.generation == null) return { accepted: false, reason: 'missing_generation' };
      if (opts.generation !== generation) return { accepted: false, reason: 'stale_generation' };
      if (muted) return { accepted: false, reason: 'muted' };
      var t = String(text == null ? '' : text).trim();
      if (!t) return { accepted: false, reason: 'empty' };

      if (opts.final) {
        // Every FINAL transcript must carry a bounded, nonempty PRIMITIVE
        // eventId. No valid id -> deny (we cannot de-dup an unidentifiable final).
        var eid = normalizeEventId(opts.eventId);
        if (!eid) return { accepted: false, reason: 'invalid_event_id' };
        if (seenFinalEvents[eid]) return { accepted: false, reason: 'duplicate_final' };
        seenFinalEvents[eid] = true;
        var verdict = null;
        try { verdict = assessTranscript({ text: t, isFinal: true, eventId: eid }); } catch (e) { verdict = null; }
        var decision = readDecision(verdict); // throwing getter cannot escape
        if (decision === 'accept') return submit(acceptedText(verdict, t), 'voice');
        if (decision === 'reject') return { accepted: false, reason: 'rejected' };
        return { accepted: false, reason: 'confirmation_required', decision: decision || 'confirm' };
      }
      return { accepted: true, reason: 'interim' };
    }

    // ---- the ONE submit path (typed OR spoken) ------------------------------
    // async: physical recognition must STOP SUCCESSFULLY before we dispatch. A
    // synchronous throw OR a rejected stop promise means we dispatch NOTHING and
    // enter a typed error state (recognition_stop_failed).
    async function submit(text, source) {
      if (emergencyGuard()) return { accepted: false, reason: 'off' };
      var t = String(text == null ? '' : text).trim();
      if (!t) return { accepted: false, reason: 'empty' };
      var turnId = reserveTurnId();
      if (!turnId) return fail('invalid_turn_id');
      // Supersede any in-flight generation, then AWAIT a successful physical stop
      // before invoking the transport.
      generation++;
      try {
        await Promise.resolve().then(function () { return recognizer.stop(); });
      } catch (e) {
        return fail('recognition_stop_failed', e); // dispatch nothing; typed error state
      }
      if (emergencyGuard()) return { accepted: false, reason: 'off' };
      if (state === 'speaking') { try { synthesizer.cancel(); } catch (e) {} } // barge-in

      seq += 1;
      var turn = { turnId: turnId, text: t, idempotencyKey: idempotencyKey(turnId), seq: seq, attempts: 0, source: source || 'text' };
      current = turn;
      dispatch(turn);
      return { accepted: true, turnId: turnId, seq: turn.seq, conversationId: conversationId };
    }

    function dispatch(turn) {
      turn.attempts += 1;
      set('thinking', { turnId: turn.turnId, conversationId: conversationId });
      var p;
      try { p = submitTurn({ text: turn.text, conversationId: conversationId, turnId: turn.turnId, idempotencyKey: turn.idempotencyKey, source: turn.source }); }
      catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (res) {
        if (offed || emergencyOffSignaled()) { forceOff('emergency'); return; }
        if (!current || turn.seq !== current.seq) return; // stale/superseded -> suppress
        var reply = res && typeof res.reply === 'string' ? res.reply : '';
        if (!isNonEmptyStr(reply)) return fail('empty_reply'); // whitespace-only handled honestly
        onReply({ turnId: turn.turnId, conversationId: conversationId, reply: reply }); // SEPARATE reply channel
        // maybeSpeak is fully self-contained and never rejects; guard anyway.
        Promise.resolve(maybeSpeak(turn, res && res.speechSafe)).catch(noop);
      }).catch(function (err) {
        if (offed) return;
        if (!current || turn.seq !== current.seq) return;
        var code = err && (err.code || err.name);
        if (code === 'auth_expired') return fail('auth_expired', err, { recoverable: 'reauth' });
        fail(code || 'turn_failed', err, { recoverable: 'retry' });
      });
    }

    // Evaluate the speech policy safely for a SYNC or ASYNC isSpeechAllowed.
    // Permit speech ONLY when the final primitive result is exactly `true`.
    // false, Promise-resolving-false, malformed values, throws, and rejections
    // all deny — and never leak an unhandled rejection.
    async function evalSpeechAllowed() {
      var v;
      try { v = isSpeechAllowed(); } catch (e) { return false; }
      try { v = await Promise.resolve(v); } catch (e) { return false; }
      return v === true;
    }

    // Speech is policy-gated + OFF by default, and only ever speaks the separate
    // speech-safe payload. State stays 'speaking' until playback settles. Never
    // throws/rejects to its caller.
    async function maybeSpeak(turn, speechSafe) {
      var allowed = await evalSpeechAllowed();
      if (!allowed || !isNonEmptyStr(speechSafe)) {
        if (current === turn && !offed) { current = null; set('idle', { turnId: turn.turnId, spoken: false }); }
        return;
      }
      // Re-check both the local latch and the injected authoritative OFF signal
      // after the async policy boundary. A signal that flips while
      // isSpeechAllowed() is pending must win before playback can start.
      if (offed || emergencyOffSignaled()) {
        if (!offed) forceOff('emergency');
        return;
      }
      if (current !== turn) return;
      set('speaking', { turnId: turn.turnId });
      // Defense in depth: state/render callbacks above are injected and may
      // synchronously flip the authoritative OFF signal.
      if (offed || emergencyOffSignaled()) {
        if (!offed) forceOff('emergency');
        return;
      }
      var playback;
      try { playback = synthesizer.speak(speechSafe); } catch (e) { playback = Promise.reject(e); }
      try {
        await Promise.resolve(playback);
        if (state === 'speaking' && current === turn) { current = null; set('idle', { turnId: turn.turnId, spoken: true }); }
      } catch (e) {
        if (state === 'speaking' && current === turn) { current = null; set('idle', { turnId: turn.turnId, spoken: false, speechError: true }); }
      }
    }

    // Explicit retry: SAME turn id + stable idempotency key + seq (no new id).
    function retry() {
      if (emergencyGuard()) return { accepted: false, reason: 'off' };
      if (state !== 'error' || !current) return { accepted: false, reason: 'nothing_to_retry' };
      dispatch(current);
      return { accepted: true, turnId: current.turnId, idempotencyKey: current.idempotencyKey };
    }

    // Barge-in: supersede the in-flight turn, AWAIT cancellation of playback, and
    // only THEN attempt to (re)start recognition. The mic never enters listening
    // while cancellation is unsettled; a thrown/rejected cancel fails closed and
    // never starts recognition. It only claims 'listening' if the recognizer
    // actually starts — never a false listening state.
    async function interrupt() {
      if (offed) return false;
      seq += 1; current = null;
      if (emergencyGuard()) return false;
      try {
        await Promise.resolve().then(function () { return synthesizer.cancel(); });
      } catch (e) {
        fail('speech_cancel_failed', e); // typed error; recognition NEVER started
        return false;
      }
      if (offed || emergencyOffSignaled()) { if (!offed) forceOff('emergency'); return false; }
      // Clear any speaking/thinking so startListening can (re)start recognition.
      state = 'idle';
      return await startListening();
    }

    return {
      getState: function () { return state; },
      getConversationId: function () { return conversationId; },
      getGeneration: function () { return generation; },
      isMuted: isMuted,
      startListening: startListening,
      stopListening: stopListening,
      mute: mute,
      unmute: unmute,
      handleTranscript: handleTranscript,
      handleRecognitionError: recognitionError,
      handleRecognitionEnd: recognitionEnded,
      submit: submit,
      retry: retry,
      interrupt: interrupt,
      emergencyOff: function () { forceOff('manual'); },
    };
  }

  return { createVoiceSession: createVoiceSession };
});
