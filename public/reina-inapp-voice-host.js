// public/reina-inapp-voice-host.js
//
// Reina Evolution -- explicit IN-APP VOICE HOST FACTORY.
//
// One factory that ASSEMBLES the full Voice stack for the future purple-panel
// integration and hands back a small, bounded lifecycle. It wires:
//
//   browser recognition adapter + browser playback adapter  (PR #61 / PR #72)
//     -> in-app Voice bridge                                  (PR #72)
//       -> panel-state controller                             (PR #75)
//
// It OWNS none of their logic and MODIFIES none of their files. Everything the
// stack needs -- element/text sinks, the server-issued conversationId, a
// collision-resistant newId, the SAME submitTurn transport typed conversation
// uses, the transcript/speech/emergency policies, and the browser speech
// dependencies -- is INJECTED by the host. The factory itself invents no
// conversation id, turn id, identity, company, role, capability, authorization,
// confidence threshold, or source-of-truth policy.
//
// DORMANT BY DESIGN. Importing or constructing this host does NOT start
// recognition, request microphone permission, speak, submit a turn, or query the
// page globally. Only an explicit, post-mount control action begins listening.
//
// Typed and spoken turns share ONE bridge/session, so they share the same
// conversationId, the same submitTurn transport (and thus the same
// authorization/persistence server path), and the same written-response
// renderer -- and the written response stays available even when speech is OFF,
// denied, muted, unavailable, interrupted, or fails.
//
// ES module. Also publishes window.ReinaInAppVoiceHost for later wiring (a
// write-only namespace publish, never a page query).

'use strict';

import { createInAppVoiceBridge as defaultCreateInAppVoiceBridge } from './reina-inapp-voice-bridge.js';
import { createVoicePanelController as defaultCreateVoicePanelController } from './reina-voice-panel-controller.js';

function isFn(f) {
  return typeof f === 'function';
}
function isNonEmptyString(s) {
  return typeof s === 'string' && s.trim().length > 0;
}
function noop() {}

// Resolve the browser speech dependencies from explicit injections OR from an
// injected window-like object. NEVER touches the real global window/document --
// the caller passes whatever window-like it wants (real or fake). Returns only
// what could be resolved; missing pieces simply degrade Voice gracefully.
function resolveSpeechDeps(options) {
  var recognitionFactory = isFn(options.recognitionFactory) ? options.recognitionFactory : null;
  var requestMicrophone = isFn(options.requestMicrophone) ? options.requestMicrophone : null;
  var synthesis = options.synthesis || null;
  var utteranceFactory = isFn(options.utteranceFactory) ? options.utteranceFactory : null;
  var w = options.windowRef && typeof options.windowRef === 'object' ? options.windowRef : null;

  if (!recognitionFactory && w) {
    var SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (isFn(SR)) {
      recognitionFactory = function () {
        return new SR();
      };
    }
  }
  if (!requestMicrophone && w) {
    try {
      var devices = w.navigator && w.navigator.mediaDevices;
      var openMicrophone = devices && devices.getUserMedia;
      if (isFn(openMicrophone)) {
        requestMicrophone = function () { return openMicrophone.call(devices, { audio: true }); };
      }
    } catch (_e) {
      requestMicrophone = null;
    }
  }
  if (!synthesis && w && w.speechSynthesis) {
    synthesis = w.speechSynthesis;
  }
  if (!utteranceFactory && w && isFn(w.SpeechSynthesisUtterance)) {
    var U = w.SpeechSynthesisUtterance;
    utteranceFactory = function (t) {
      return new U(t);
    };
  }
  return { recognitionFactory: recognitionFactory, requestMicrophone: requestMicrophone, synthesis: synthesis, utteranceFactory: utteranceFactory };
}

export function createReinaInAppVoiceHost(options) {
  options = options || {};

  // ---- required conversation identity/transport (server-owned) --------------
  // These are hard requirements for ANY turn (typed or spoken). We fail closed
  // synchronously on a wiring mistake -- no side effects, no async, no mic.
  if (!isNonEmptyString(options.conversationId)) {
    throw new Error('createReinaInAppVoiceHost: a server-issued conversationId is required');
  }
  if (!isFn(options.newId)) {
    throw new Error('createReinaInAppVoiceHost: a collision-resistant newId() is required');
  }
  if (!isFn(options.submitTurn)) {
    throw new Error('createReinaInAppVoiceHost: the shared submitTurn transport is required');
  }

  var conversationId = options.conversationId;
  var newId = options.newId;
  var submitTurn = options.submitTurn;

  // ---- injected policies (safe defaults live in the bridge/session) ---------
  var assessTranscript = options.assessTranscript; // transcript assessment policy
  var isSpeechAllowed = options.isSpeechAllowed; // speech-allowed policy (default: deny)
  var isEmergencyOff = options.isEmergencyOff; // emergency-OFF policy
  var authorizeReset = options.authorizeReset; // host authorization gate for reset()

  // ---- browser speech dependencies (injected; window-like) ------------------
  var speech = resolveSpeechDeps(options);
  var lang = options.lang;
  // Listening needs a recognition constructor; speaking needs synthesis +
  // utterance. Absent pieces degrade gracefully -- typed conversation still runs.
  var canListen = isFn(speech.recognitionFactory);

  // ---- pluggable constructors (default to the real stack; overridable) ------
  var buildBridge = isFn(options.createInAppVoiceBridge)
    ? options.createInAppVoiceBridge
    : defaultCreateInAppVoiceBridge;
  var buildController = isFn(options.createVoicePanelController)
    ? options.createVoicePanelController
    : defaultCreateVoicePanelController;

  // Optional. The host reports refusals the same way it reports microphone and
  // transcription failures, so "nothing happened" always has a written cause.
  var onBlock = isFn(options.onBlock) ? options.onBlock : noop;

  var hostDisposed = false;
  var bridgeRef = null; // captured when the controller builds the bridge at mount

  // The host-owned bridge factory the controller calls ONCE at mount, merging
  // the host's server/policy/speech deps with the controller's callbacks. All
  // conversation identity + transport + policy live here, never in the
  // controller. We capture the instance so submitTyped() can reuse the exact
  // same bridge/session as spoken turns.
  function hostCreateBridge(callbacks) {
    var b = buildBridge({
      conversationId: conversationId,
      newId: newId,
      submitTurn: submitTurn,
      assessTranscript: assessTranscript,
      isSpeechAllowed: isSpeechAllowed,
      isEmergencyOff: isEmergencyOff,
      // Session-level refusals: a guard that declined to open the microphone,
      // or a recognition error dropped before it could become a state.
      onBlock: onBlock,
      recognitionFactory: speech.recognitionFactory,
      requestMicrophone: speech.requestMicrophone,
      synthesis: speech.synthesis,
      utteranceFactory: speech.utteranceFactory,
      lang: lang,
      onState: callbacks.onState,
      onReply: callbacks.onReply,
      onInterim: callbacks.onInterim,
      onNeedsConfirmation: callbacks.onNeedsConfirmation,
      onError: callbacks.onError,
    });
    bridgeRef = b && typeof b === 'object' ? b : null;
    return bridgeRef;
  }

  // ---- assemble the panel controller (bridge is built lazily at mount) ------
  var controller = buildController({
    elements: options.elements,
    render: options.render,
    controls: options.controls,
    labels: options.labels,
    onControlEvent: isFn(options.onControlEvent) ? options.onControlEvent : noop,
    createBridge: hostCreateBridge,
  });

  // ---- safe async settle (no unhandled rejections) --------------------------
  function settle(value, onFail) {
    if (value && isFn(value.then)) {
      return value.then(
        function (r) {
          return r;
        },
        function () {
          return onFail;
        },
      );
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // Bounded lifecycle
  // ---------------------------------------------------------------------------
  var api = {
    // ---- inspection ----
    isMounted: function () {
      return !hostDisposed && controller.isMounted();
    },
    isOff: function () {
      return controller.isOff();
    },
    isDisposed: function () {
      return hostDisposed || controller.isDisposed();
    },
    getState: function () {
      return controller.getState();
    },
    // Whether Voice input can be started at all (recognition constructor present).
    isVoiceAvailable: function () {
      return canListen;
    },
    getConversationId: function () {
      return conversationId;
    },

    // ---- lifecycle ----
    // Constructs + connects the whole stack and renders a dormant idle. Never
    // touches the microphone.
    mount: function () {
      if (hostDisposed) return false;
      return controller.mount();
    },

    // Typed turn -> the EXACT same bridge/session/transport as spoken turns
    // (shared conversationId, submitTurn, server path, written renderer).
    submitTyped: function (text) {
      if (hostDisposed) return Promise.resolve({ accepted: false, reason: 'disposed' });
      if (controller.isOff()) return Promise.resolve({ accepted: false, reason: 'off' });
      if (!controller.isMounted()) return Promise.resolve({ accepted: false, reason: 'not_mounted' });
      if (!bridgeRef || !isFn(bridgeRef.submit)) {
        return Promise.resolve({ accepted: false, reason: 'unavailable' });
      }
      var out;
      try {
        out = bridgeRef.submit(text);
      } catch (_e) {
        return Promise.resolve({ accepted: false, reason: 'submit_failed' });
      }
      return Promise.resolve(settle(out, { accepted: false, reason: 'submit_failed' }));
    },

    // The ONLY microphone-activating seam, and only when recognition is
    // available. Missing speech APIs disable Voice gracefully (returns false)
    // while typed conversation stays usable.
    startListening: function () {
      if (hostDisposed) return false;
      if (!canListen) return false; // Voice input unavailable -> graceful no-op
      return controller.startListening();
    },
    stop: function () {
      if (hostDisposed) return;
      controller.stop();
    },
    mute: function () {
      if (hostDisposed) return;
      controller.mute();
    },
    unmute: function () {
      if (hostDisposed) return;
      controller.unmute();
    },
    interrupt: function () {
      if (hostDisposed) return false;
      return controller.interrupt();
    },

    // Emergency OFF latches across ALL layers: controller suppresses late panel
    // events; the bridge/session/adapters suppress pending + block new turns.
    emergencyOff: function () {
      if (hostDisposed) return;
      controller.emergencyOff();
    },

    // reset() ONLY through injected host authorization. The authorization may be
    // sync or async; only a primitive `true` result permits the reset. Missing,
    // throwing, rejected, or non-true authorization denies (fail closed). Reset
    // never activates the microphone.
    reset: function () {
      if (hostDisposed) return Promise.resolve(false);
      if (!controller.isOff()) return Promise.resolve(false);
      var v;
      try {
        v = isFn(authorizeReset) ? authorizeReset() : false;
      } catch (_e) {
        return Promise.resolve(false);
      }
      return Promise.resolve(v).then(
        function (resolved) {
          if (resolved !== true) return false;
          return controller.reset();
        },
        function () {
          return false; // rejected authorization -> deny
        },
      );
    },

    // Explicit user confirmation of an unclear/confirm transcript (never
    // automatic). Empty/unclear submits nothing.
    confirmUnclear: function () {
      if (hostDisposed) return false;
      return controller.confirmUnclear();
    },
    dismissUnclear: function () {
      if (hostDisposed) return;
      controller.dismissUnclear();
    },

    // Idempotent teardown across all layers: controller removes its listeners
    // and calls the bridge cleanup seam; both suppress every later callback.
    dispose: function () {
      if (hostDisposed) return;
      hostDisposed = true;
      try {
        controller.dispose();
      } catch (_e) {
        /* teardown must never throw out */
      }
      bridgeRef = null;
    },
  };

  return api;
}

// Browser namespace publish for later panel wiring. Write-only + guarded; no
// page query, and a no-op under Node/test where window is undefined.
if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined') {
  globalThis.window.ReinaInAppVoiceHost = { createReinaInAppVoiceHost: createReinaInAppVoiceHost };
}

export default { createReinaInAppVoiceHost: createReinaInAppVoiceHost };
