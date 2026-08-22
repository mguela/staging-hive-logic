// public/reina-inapp-voice-bridge.js
//
// Reina Evolution -- transport-neutral IN-APP VOICE BRIDGE.
//
// This is the thin, dependency-injected wiring that connects three existing,
// separately-owned pieces into one voice-capable conversation surface:
//
//   * createVoiceSession            (public/reina-voice-session.js  -- PR #56)
//       the state machine + the ONE submit path (typed OR spoken).
//   * createSpeechRecognitionAdapter (public/reina-browser-speech-adapters.js -- PR #61)
//       normalizes browser recognition events into transcript events.
//   * createSpeechPlaybackAdapter    (public/reina-browser-speech-adapters.js -- PR #61)
//       speaks plain, engine-produced, speech-safe text.
//
// It OWNS none of their logic and MODIFIES none of their files. It only routes:
//
//   recognition events  --(bridge)-->  session.handleTranscript / handleRecognitionError
//   session.recognizer  --(bridge)-->  recognition adapter start/stop
//   session.synthesizer --(bridge)-->  playback adapter speak/cancel
//   session.submitTurn                 the caller's SHARED transport (typed + spoken)
//
// INVARIANTS (all enforced by the pieces above; the bridge must not weaken any):
//   * ONE server-issued conversationId is shared across typed and spoken turns.
//   * Spoken finals enter the EXACT SAME injected submitTurn transport as typed.
//   * No separate endpoint, model, prompt, history, authorization, or brain is
//     created here. No identity/role/company/capability/system/tool/history
//     claim is minted or forwarded. Nothing executes a business action.
//   * The recognition generation and the recognition event id reach the session
//     UNCHANGED (the generation as the session's active generation; the per-final
//     recognition generation as the session eventId -- one final per generation).
//   * Interim speech is display-only and never submitted.
//   * Unclear speech asks for confirmation and is never auto-submitted.
//   * The session owns listening / thinking / speaking / error / off state.
//   * Written replies are always delivered (playback is separate + optional).
//   * Only explicit speechSafe text may reach playback, and only when the
//     injected policy returns the primitive `true`. No confidence threshold is
//     invented anywhere.
//   * Every injected boundary (recognition, playback, transport, policy,
//     callback) FAILS CLOSED on throw/reject/malformed output.
//   * dispose() stops recognition, cancels playback, invalidates pending
//     generations, and prevents any later callback.
//
// ES module (imported by the test). Also publishes window.ReinaInAppVoiceBridge
// for later panel wiring. The bridge does NOT touch index.html, the purple
// panel, voice-input.js, API routes, or phone/Twilio.

import * as voiceSessionNamespace from './reina-voice-session.js';
import {
  createSpeechRecognitionAdapter as defaultCreateRecognitionAdapter,
  createSpeechPlaybackAdapter as defaultCreatePlaybackAdapter,
} from './reina-browser-speech-adapters.js';

// `reina-voice-session.js` is a UMD component. Node exposes its CommonJS value
// as `default`, while a native browser module evaluates the UMD side effect and
// publishes `window.ReinaVoiceSession`. Resolve both forms explicitly so a real
// browser does not require a non-existent ESM default export.
const voiceSessionModule =
  voiceSessionNamespace?.default?.createVoiceSession
    ? voiceSessionNamespace.default
    : voiceSessionNamespace?.createVoiceSession
      ? voiceSessionNamespace
      : globalThis?.ReinaVoiceSession;

const defaultCreateVoiceSession =
  voiceSessionModule && typeof voiceSessionModule.createVoiceSession === 'function'
    ? voiceSessionModule.createVoiceSession
    : null;

// Map a normalized recognition error code (from the recognition adapter) to a
// session recognition-error kind. The session prefixes 'recognition_'.
function mapRecognitionErrorKind(code) {
  switch (code) {
    case 'denied':
      return 'permission_denied';
    case 'no-microphone':
      return 'no_microphone';
    case 'device-busy':
      return 'device_busy';
    case 'no-speech':
      return 'no_speech';
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'audio-capture':
      return 'audio_capture';
    case 'unavailable':
      return 'unavailable';
    case 'transcription-auth':
      return 'transcription_auth';
    case 'transcription-bad-audio':
      return 'transcription_bad_audio';
    case 'transcription-rate-limited':
      return 'transcription_rate_limited';
    case 'transcription-unavailable':
      return 'transcription_unavailable';
    case 'transcription-no-speech':
      return 'transcription_no_speech';
    case 'transcription-timeout':
      return 'transcription_timeout';
    case 'input-too-quiet':
      return 'input_too_quiet';
    case 'input-too-loud':
      return 'input_too_loud';
    case 'microphone-open-timeout':
      return 'microphone_open_timeout';
    default:
      return 'recognition_error';
  }
}

// Map a SESSION failure reason (the detail of an 'error' state) onto the small
// set of panel error codes. A session failure is everything that can go wrong
// after -- or instead of -- recording: the transport never answered, the answer
// failed envelope validation, the sign-in expired, the reply came back empty,
// the microphone could not be started or stopped. None of it reached the panel
// before: the state changed to 'error' and NOTHING was ever rendered, so a
// spoken turn that failed simply went quiet. Returns null for a reason with
// nothing to tell the user.
function mapTurnErrorKind(reason) {
  switch (reason) {
    case 'auth_expired':
      return 'auth_expired'; // the host re-authenticates on exactly this reason
    case 'timeout':
      return 'turn_timeout';
    case 'empty_reply':
      return 'turn_empty_reply';
    case 'recognition_start_failed':
      return 'unavailable'; // recording never started
    case 'recognition_stop_failed':
      return 'turn_failed'; // recording would not stop, so nothing was sent
    case 'speech_cancel_failed':
      return null; // playback-only; the written answer is already shown
    default:
      // Any other recognition_* reason mirrors an adapter error event that is
      // reported with its own normalized code; that one is authoritative.
      if (typeof reason === 'string' && reason.indexOf('recognition_') === 0) return null;
      // Every remaining reason (transport_failed, route_unavailable, envelope
      // validation, invalid_turn_id, turn_failed, ...) means the same thing to
      // the person waiting: no answer came back.
      return 'turn_failed';
  }
}

export function createInAppVoiceBridge(deps = {}) {
  const createVoiceSession = deps.createVoiceSession || defaultCreateVoiceSession;
  const createRecognitionAdapter =
    deps.createSpeechRecognitionAdapter || defaultCreateRecognitionAdapter;
  const createPlaybackAdapter =
    deps.createSpeechPlaybackAdapter || defaultCreatePlaybackAdapter;

  if (typeof createVoiceSession !== 'function') {
    throw new Error('createInAppVoiceBridge: createVoiceSession dependency is unavailable');
  }
  if (typeof deps.submitTurn !== 'function') {
    throw new Error('createInAppVoiceBridge: a shared submitTurn transport is required');
  }

  let disposed = false;

  // ---- outward callbacks: never throw, and never fire after dispose ---------
  function safeCall(fn, arg) {
    if (disposed || typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (_e) {
      /* a consumer callback failure must never break the bridge */
    }
  }
  function emitState(state, detail) {
    if (disposed || typeof deps.onState !== 'function') return;
    try {
      deps.onState(state, detail);
    } catch (_e) {
      /* fail closed */
    }
  }
  const emitReply = (r) => safeCall(deps.onReply, r);
  const emitInterim = (i) => safeCall(deps.onInterim, i);
  const emitConfirm = (c) => safeCall(deps.onNeedsConfirmation, c);
  const emitError = (e) => safeCall(deps.onError, e);

  // ---- playback: wrap the event-based adapter as an awaitable speak() -------
  const playbackAdapter = createPlaybackAdapter({
    synthesis: deps.synthesis,
    utteranceFactory: deps.utteranceFactory,
  });
  let playbackTurn = 0;

  // The session AWAITS synthesizer.speak() to hold the 'speaking' state until
  // playback settles. We resolve on natural end / stop / interruption (all are
  // "playback finished") and REJECT on error / denial so the session records a
  // non-spoken outcome and moves on. Never throws to the caller.
  function speakViaPlayback(text) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('disposed'));
        return;
      }
      const myTurn = ++playbackTurn;
      let settled = false;
      const off = playbackAdapter.on((ev) => {
        if (settled || !ev) return;
        if (ev.turn != null && ev.turn !== myTurn) return; // another turn's event
        switch (ev.type) {
          case 'end':
          case 'stopped':
          case 'interrupted':
            settled = true;
            off();
            resolve();
            break;
          case 'error':
            settled = true;
            off();
            reject(new Error('playback_' + (ev.code || 'error')));
            break;
          case 'denied':
            settled = true;
            off();
            reject(new Error('playback_denied_' + (ev.reason || '')));
            break;
          default:
            break; // 'start' etc. -> keep waiting
        }
      });
      let ok;
      try {
        // Pass the engine text THROUGH verbatim. allow:true only because the
        // session has ALREADY passed its speech policy before calling us; the
        // playback adapter independently refuses markup/SSML (defense in depth).
        ok = playbackAdapter.speak(String(text == null ? '' : text), {
          allow: true,
          turn: myTurn,
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          off();
          reject(e);
        }
        return;
      }
      if (ok === false && !settled) {
        // A synchronous refusal that emitted no event we recognized.
        settled = true;
        off();
        reject(new Error('playback_refused'));
      }
    });
  }

  // ---- recognition: the object the SESSION drives ---------------------------
  const recognitionAdapter = createRecognitionAdapter({
    recognitionFactory: deps.recognitionFactory,
    requestMicrophone: deps.requestMicrophone,
    lang: deps.lang,
  });

  // The session calls recognizer.start()/stop()/mute(). We fail closed if the
  // adapter cannot start (unavailable) by THROWING, so the session's own
  // start-failure handling drives an error state instead of a false 'listening'.
  const recognizer = {
    start() {
      const started = recognitionAdapter.start();
      if (started === false) throw new Error('recognition_unavailable');
      return started;
    },
    stop() {
      // A user stop is graceful: a recorder is allowed to finish its current
      // bounded clip and deliver one final transcript. Emergency-off, dispose,
      // and interruption still use the adapter's hard-abort paths below.
      recognitionAdapter.stop();
    },
    mute() {
      // The recognition adapter has no mute; the session-level muted flag
      // already suppresses transcripts. Kept as a no-op to honor the contract.
    },
  };

  const synthesizer = {
    speak(text) {
      return speakViaPlayback(text);
    },
    cancel() {
      try {
        playbackAdapter.stop();
      } catch (_e) {
        /* fail closed */
      }
    },
  };

  // ---- the session ----------------------------------------------------------
  const session = createVoiceSession({
    conversationId: deps.conversationId,
    newId: deps.newId,
    recognizer,
    synthesizer,
    submitTurn: deps.submitTurn, // the SHARED transport (typed + spoken)
    assessTranscript: deps.assessTranscript, // unclear/confirm policy (default: confirm)
    isSpeechAllowed: deps.isSpeechAllowed, // speech policy (default: false)
    isEmergencyOff: deps.isEmergencyOff,
    onBlock: deps.onBlock, // refusals that never become a state or an error

    onState: (state, detail) => {
      emitState(state, detail);
      if (state !== 'error') return;
      let reason = null;
      try {
        reason = detail && typeof detail.reason === 'string' ? detail.reason : null;
      } catch (_e) {
        reason = null; // a throwing detail getter must never break the bridge
      }
      if (!reason) return;
      const kind = mapTurnErrorKind(reason);
      if (kind) emitError({ stage: 'turn', reason: kind });
    },
    onReply: (reply) => emitReply(reply), // written reply ALWAYS delivered
  });

  // ---- recognition event routing -------------------------------------------
  // The recognition adapter guarantees: interim is display-only, at most one
  // final per generation, and stale/late/duplicate suppression. We forward its
  // events into the session's ONE transcript path.
  let activeRecognitionGen = null;

  function handleFinalResult(ev, res) {
    // An accepted final -> handleTranscript returned the (async) submit promise.
    if (res && typeof res.then === 'function') {
      res
        .then((r) => {
          if (disposed) return;
          if (r && r.accepted === false) emitError({ stage: 'submit', reason: r.reason });
        })
        .catch(() => {
          if (!disposed) emitError({ stage: 'submit', reason: 'submit_failed' });
        });
      return;
    }
    if (!res || res.accepted !== false) return;
    // Not accepted: surface confirmation, silently drop the rest. Critically,
    // NOTHING here re-submits -- unclear/confirm/reject never auto-dispatch.
    if (res.reason === 'confirmation_required') {
      emitConfirm({ text: ev.transcript, reason: res.decision || 'confirm', generation: ev.generation });
    }
  }

  function routeRecognitionEvent(ev) {
    if (disposed || !ev) return;
    try {
      switch (ev.type) {
        case 'start':
          activeRecognitionGen = ev.generation;
          return;
        case 'end':
          if (ev.generation === activeRecognitionGen) activeRecognitionGen = null;
          // Tell the session. Clearing the local generation was all this did,
          // so a recognition that ended with neither a transcript nor an error
          // left the session in 'listening' -- and the panel, which mirrors it,
          // refused every later press with no way to see why.
          try {
            session.handleRecognitionEnd({ generation: session.getGeneration() });
          } catch (_e) {
            /* fail closed */
          }
          return;
        case 'error': {
          // Fail closed: hand the normalized error to the session with its
          // CURRENT generation (the session's handler demands the exact gen).
          const kind = mapRecognitionErrorKind(ev.code);
          try {
            session.handleRecognitionError({
              kind,
              generation: session.getGeneration(),
              error: new Error('recognition_' + (ev.code || 'error')),
            });
          } catch (_e) {
            /* fail closed */
          }
          // Preserve the adapter's normalized, non-sensitive cause for the
          // panel. The session state remains authoritative; this is only the
          // user-visible explanation and never retries or submits anything.
          emitError({ stage: 'recognition', reason: kind });
          return;
        }
        case 'unclear':
          // Unclear speech is reported for confirmation and NEVER submitted.
          emitConfirm({ text: null, reason: 'unclear', generation: ev.generation });
          return;
        case 'interim':
        case 'final': {
          // Belt-and-suspenders stale drop (the adapter already suppresses these).
          if (activeRecognitionGen != null && ev.generation !== activeRecognitionGen) return;
          // The session's active generation is applied unchanged to the transcript.
          const g = session.getGeneration();
          if (ev.type === 'interim') {
            const ir = safeHandleTranscript(ev.transcript, { generation: g, final: false });
            if (ir && ir.accepted && ir.reason === 'interim') {
              emitInterim({ text: ev.transcript, generation: g }); // DISPLAY-ONLY
            }
            return;
          }
          // FINAL: forward the recognition generation UNCHANGED as the eventId
          // (one final per recognition generation -> a stable, unique id).
          const fr = safeHandleTranscript(ev.transcript, {
            generation: g,
            final: true,
            eventId: ev.generation,
          });
          handleFinalResult(ev, fr);
          return;
        }
        default:
          return;
      }
    } catch (_e) {
      // A routing failure must never escape into the adapter or the session.
    }
  }

  function safeHandleTranscript(text, opts) {
    try {
      return session.handleTranscript(text, opts);
    } catch (_e) {
      return { accepted: false, reason: 'handle_failed' };
    }
  }

  const unsubscribeRecognition = recognitionAdapter.on(routeRecognitionEvent);

  // ---- public, panel-facing API --------------------------------------------
  const api = {
    // ---- inspection ----
    getState() {
      return session.getState();
    },
    getConversationId() {
      return session.getConversationId();
    },
    getGeneration() {
      return session.getGeneration();
    },
    isMuted() {
      return session.isMuted();
    },
    isDisposed() {
      return disposed;
    },

    // ---- microphone ----
    async startListening() {
      if (disposed) return false;
      return session.startListening();
    },
    stopListening() {
      if (disposed) return;
      session.stopListening();
    },
    async interrupt() {
      if (disposed) return false;
      return session.interrupt();
    },

    // ---- mute (audio in + out) ----
    mute() {
      if (disposed) return;
      try {
        playbackAdapter.mute(); // cancel + deny any in-flight/future audio
      } catch (_e) {
        /* fail closed */
      }
      session.mute();
    },
    unmute() {
      if (disposed) return;
      try {
        playbackAdapter.unmute();
      } catch (_e) {
        /* fail closed */
      }
      session.unmute();
    },

    // ---- the ONE shared transport (typed turn) ----
    async submit(text) {
      if (disposed) return { accepted: false, reason: 'disposed' };
      return session.submit(text, 'text');
    },

    // ---- stable-identity retry (same turnId + idempotencyKey) ----
    retry() {
      if (disposed) return { accepted: false, reason: 'disposed' };
      return session.retry();
    },

    // ---- emergency OFF: stop mic, cancel playback, suppress pending, block new ----
    emergencyOff() {
      if (disposed) return;
      try {
        session.emergencyOff();
      } catch (_e) {
        /* fail closed */
      }
      // Defense in depth: also halt the transports directly.
      try {
        recognitionAdapter.abort();
      } catch (_e) {
        /* fail closed */
      }
      try {
        playbackAdapter.stop();
      } catch (_e) {
        /* fail closed */
      }
    },

    // ---- dispose: teardown + prevent any later callback ----
    dispose() {
      if (disposed) return;
      // Flip the flag FIRST so nothing that follows (including the session's own
      // OFF transition) can emit an outward callback.
      disposed = true;
      try {
        session.emergencyOff(); // stops recognizer, cancels playback, blocks new turns
      } catch (_e) {
        /* fail closed */
      }
      try {
        unsubscribeRecognition();
      } catch (_e) {
        /* fail closed */
      }
      try {
        recognitionAdapter.abort(); // invalidate any pending recognition generation
      } catch (_e) {
        /* fail closed */
      }
      try {
        playbackAdapter.stop();
      } catch (_e) {
        /* fail closed */
      }
      activeRecognitionGen = null;
    },
  };

  return api;
}

// Browser global for later panel wiring. No-op under Node/test.
if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined') {
  globalThis.window.ReinaInAppVoiceBridge = { createInAppVoiceBridge };
}

export default { createInAppVoiceBridge };
