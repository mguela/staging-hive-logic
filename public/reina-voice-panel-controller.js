// public/reina-voice-panel-controller.js
//
// Reina Evolution -- browser-side VOICE PANEL PRESENTER / CONTROLLER.
//
// This is the thin, dependency-injected presenter that can LATER connect the
// existing purple Reina panel to the in-app Voice bridge (PR #72) WITHOUT
// modifying the panel, index.html, or any bridge file. It owns no markup and no
// page globals: the host injects element references and/or plain-text render
// callbacks, and the controller only reflects bridge state into them.
//
// It is DORMANT until explicitly constructed and mounted, and it NEVER activates
// the microphone on its own -- mic start happens only from an explicit control
// seam (a bound control click or a programmatic startListening() call), never on
// import, mount, reply, error recovery, or page load.
//
// Bridge surface consumed (PR #72, public/reina-inapp-voice-bridge.js):
//   callbacks: onState(state, detail) | onReply({reply,...}) |
//              onInterim({text,generation}) | onNeedsConfirmation({text,reason,generation}) |
//              onError({stage,reason})
//   controls:  startListening() | stopListening() | interrupt() | mute() |
//              unmute() | submit(text) | retry() | emergencyOff() | dispose()
//   states:    idle | listening | thinking | speaking | error | off
//
// Hard rules honored here:
//   * Text is rendered ONLY through textContent or an injected plain-text sink.
//     Never innerHTML, trusted HTML, SSML, or executable markup.
//   * Unclear transcripts are NEVER auto-submitted -- an explicit host/user
//     confirmation seam is required. No confidence threshold is invented; the
//     controller consumes only the bridge's existing unclear/confirmation signal.
//   * Written replies stay available even when speech is denied, muted,
//     unavailable, interrupted, or fails (they arrive on the separate onReply
//     channel and are rendered regardless of playback outcome).
//   * Emergency OFF shows OFF immediately, disables new-listening controls,
//     suppresses late interim/reply/speaking events, and stays OFF until the
//     explicit host-authorized reset() seam is invoked.
//   * dispose() is idempotent: removes owned listeners, calls the bridge cleanup
//     seam, and suppresses all later callbacks.
//   * Missing / malformed / throwing / async dependencies fail closed with no
//     unhandled rejections.
//   * The controller creates NO conversation ids, turn ids, authorization,
//     persistence, policy, transport, or model behavior -- all of that lives in
//     the host-provided bridge factory.
//
// ES module. Also publishes window.ReinaVoicePanelController for later wiring.

'use strict';

var VALID_STATES = ['idle', 'listening', 'thinking', 'speaking', 'error', 'off'];

function noop() {}
function isFn(f) {
  return typeof f === 'function';
}

// The five render slots the presenter knows how to fill. Each is filled either
// by an injected render callback (render[slot](plainText)) or by setting
// .textContent on an injected element (elements[slot]). Anything else is a
// no-op (fail closed) -- a missing sink never throws.
var TEXT_SLOTS = ['status', 'interim', 'reply', 'confirm', 'error'];

export function createVoicePanelController(deps) {
  deps = deps || {};

  var render = deps.render && typeof deps.render === 'object' ? deps.render : {};
  var elements = deps.elements && typeof deps.elements === 'object' ? deps.elements : {};
  var controls = deps.controls && typeof deps.controls === 'object' ? deps.controls : {};
  var labels = deps.labels && typeof deps.labels === 'object' ? deps.labels : {};
  // The host-owned bridge factory. Called ONCE at mount with the controller's
  // callbacks. Kept out of the controller so no transport/policy lives here.
  var createBridge = isFn(deps.createBridge) ? deps.createBridge : null;
  var onControlEvent = isFn(deps.onControlEvent) ? deps.onControlEvent : noop;

  // ---- private state --------------------------------------------------------
  var mounted = false;
  var disposed = false;
  var offLatched = false; // emergency OFF latch; cleared only by reset()
  var currentState = 'idle';
  var muted = false;
  var pendingConfirm = null; // { text, reason } awaiting explicit confirm/dismiss
  var pendingStart = false; // guards duplicate start clicks before 'listening' lands
  var bridge = null;
  var boundListeners = []; // { target, type, handler } we own and must remove
  var epoch = 0; // bumped on mount/reset; stale async work checks it

  // ---- plain-text rendering (textContent / injected sink ONLY) --------------
  function setText(slot, text) {
    if (disposed) return;
    var plain = text == null ? '' : String(text);
    var rfn = render[slot];
    if (isFn(rfn)) {
      try {
        rfn(plain); // injected plain-text sink -- host guarantees it is text-only
      } catch (_e) {
        /* throwing render target must not break the controller */
      }
      return;
    }
    var el = elements[slot];
    if (el) {
      try {
        el.textContent = plain; // NEVER innerHTML / no markup interpretation
      } catch (_e) {
        /* throwing textContent setter must not break the controller */
      }
      return;
    }
    // No sink for this slot -> fail closed (render nothing).
  }

  function stateLabel(state) {
    if (labels[state] != null) return String(labels[state]);
    return state;
  }

  // Reflect enablement so the host can style controls. Also toggles .disabled on
  // any injected control elements. Never throws.
  function renderControls() {
    var canStart =
      mounted && !disposed && !offLatched && !pendingStart &&
      (currentState === 'idle' || currentState === 'error');
    var canStop = mounted && !disposed && !offLatched &&
      (currentState === 'listening' || currentState === 'thinking' || currentState === 'speaking');
    var canInterrupt = mounted && !disposed && !offLatched &&
      (currentState === 'speaking' || currentState === 'thinking' || currentState === 'listening');
    var canMute = mounted && !disposed && !offLatched;
    var snapshot = {
      state: currentState,
      off: offLatched,
      muted: muted,
      disposed: disposed,
      canStart: canStart,
      canStop: canStop,
      canInterrupt: canInterrupt,
      canMute: canMute,
    };
    if (isFn(render.controls)) {
      try {
        render.controls(snapshot);
      } catch (_e) {
        /* fail closed */
      }
    }
    setDisabled(controls.start, !canStart);
    setDisabled(controls.stop, !canStop);
    setDisabled(controls.interrupt, !canInterrupt);
    setDisabled(controls.mute, !canMute);
    setDisabled(controls.unmute, !canMute);
    // OFF disables everything except an explicit reset control.
    setDisabled(controls.reset, !(mounted && !disposed && offLatched));
    return snapshot;
  }

  function setDisabled(el, isDisabled) {
    if (!el) return;
    try {
      el.disabled = !!isDisabled;
    } catch (_e) {
      /* some hosts pass non-DOM handles; ignore */
    }
  }

  function renderState() {
    setText('status', stateLabel(currentState));
    renderControls();
  }

  function notify(kind, detail) {
    try {
      onControlEvent({ type: kind, state: currentState, detail: detail == null ? null : detail });
    } catch (_e) {
      /* host notification must never break the controller */
    }
  }

  // ---- bridge callback handlers (wired via createBridge at mount) -----------
  // Every handler is guarded: disposed -> ignore; not mounted -> ignore; OFF
  // suppresses late interim/reply/speaking/confirm/error.
  function handleState(state, _detail) {
    if (disposed || !mounted) return;
    var next = VALID_STATES.indexOf(state) !== -1 ? state : 'error';
    // OFF is the emergency latch. Once latched, only reset() leaves it.
    if (next === 'off') {
      enterOff();
      return;
    }
    if (offLatched) return; // suppress any non-OFF transition while latched
    // Leaving 'idle' clears the duplicate-start guard.
    if (next !== 'idle') pendingStart = false;
    if (next === 'idle') pendingStart = false;
    currentState = next;
    renderState();
    notify('state', { state: next });
  }

  function handleReply(payload) {
    if (disposed || !mounted || offLatched) return; // OFF suppresses late replies
    var text = payload && typeof payload.reply === 'string' ? payload.reply : '';
    // Written reply is ALWAYS shown here -- independent of speech outcome
    // (denied / muted / unavailable / interrupted / failed).
    setText('reply', text);
    notify('reply', { hasText: text.length > 0 });
  }

  function handleInterim(payload) {
    if (disposed || !mounted || offLatched) return; // display-only + OFF-suppressed
    var text = payload && typeof payload.text === 'string' ? payload.text : '';
    setText('interim', text);
  }

  function handleConfirm(payload) {
    if (disposed || !mounted || offLatched) return;
    // Consume ONLY the bridge's unclear/confirmation signal. Never auto-submit.
    var reason = payload && payload.reason ? String(payload.reason) : 'confirm';
    var text =
      payload && typeof payload.text === 'string' && payload.text.length > 0
        ? payload.text
        : null;
    pendingConfirm = { text: text, reason: reason };
    var prompt =
      reason === 'unclear'
        ? stateLabel('confirm_unclear') || "Didn't catch that -- try again?"
        : (text ? 'Did you mean: ' + text : 'Please confirm.');
    setText('confirm', prompt);
    renderControls();
    notify('confirm', { reason: reason, hasText: !!text });
  }

  function handleError(payload) {
    if (disposed || !mounted || offLatched) return;
    var reason = payload && payload.reason ? String(payload.reason) : 'error';
    // Recoverable, honest error surface. We do NOT auto-retry or auto-restart.
    setText('error', stateLabel('error_' + reason) || ('Something went wrong (' + reason + ').'));
    notify('error', { reason: reason });
  }

  // ---- OFF / reset ----------------------------------------------------------
  function enterOff() {
    offLatched = true;
    pendingStart = false;
    pendingConfirm = null;
    currentState = 'off';
    // Clear transient surfaces so nothing stale lingers under OFF.
    setText('interim', '');
    setText('confirm', '');
    setText('status', stateLabel('off'));
    renderControls();
    notify('off', null);
  }

  // ---- safe async control invocation (no unhandled rejections) --------------
  function callAsync(fn) {
    if (!isFn(fn)) return;
    var out;
    try {
      out = fn();
    } catch (_e) {
      return; // synchronous throw -> fail closed
    }
    if (out && isFn(out.then)) {
      try {
        out.then(noop, noop); // swallow rejection -> no unhandled rejection
      } catch (_e) {
        /* fail closed */
      }
    }
  }

  // ---- control seams --------------------------------------------------------
  // Every refusal below used to be a bare `return false`: the microphone did
  // not open, the panel said nothing, the console said nothing, and no
  // diagnostic row was written. From outside, a refused start and a start that
  // hung were the same event -- "I pressed it and nothing happened" -- which is
  // exactly how they were reported, repeatedly, and could not be told apart.
  // Name the guard that fired. This changes no behaviour: callers still get
  // false, and nothing here opens the microphone.
  function blockedStart(reason) {
    notify('blocked', { reason: reason });
    return false;
  }

  // The ONLY path that ever activates the microphone. Always explicit.
  function startListening() {
    if (disposed) return blockedStart('disposed');
    if (!mounted) return blockedStart('not_mounted');
    if (offLatched) return blockedStart('off_latched');
    if (!bridge) return blockedStart('no_bridge');
    if (pendingStart) return blockedStart('start_already_pending'); // duplicate-click guard
    if (!(currentState === 'idle' || currentState === 'error')) {
      // The one that can strand the panel: a state that never returned to idle
      // leaves the button permanently inert with no way to see why.
      return blockedStart('state_' + currentState);
    }
    pendingStart = true;
    renderControls();
    notify('start', null);
    callAsync(function () {
      return bridge.startListening();
    });
    return true;
  }

  function stop() {
    if (disposed || !mounted || offLatched || !bridge) return;
    notify('stop', null);
    callAsync(function () {
      return bridge.stopListening();
    });
    // A graceful browser stop may still deliver one final transcript, which the
    // session continues to accept. The panel itself must nevertheless release
    // its Start control immediately so the user can begin a new generation;
    // that new start retires the old recognizer and suppresses any stale result.
    if (currentState === 'listening') {
      currentState = 'idle';
      pendingStart = false;
      renderState();
      notify('state', { state: 'idle', reason: 'stop_requested' });
    }
  }

  function interrupt() {
    if (disposed || !mounted || offLatched || !bridge) return;
    notify('interrupt', null);
    callAsync(function () {
      return bridge.interrupt();
    });
  }

  function mute() {
    if (disposed || !mounted || offLatched || !bridge) return;
    muted = true;
    callAsync(function () {
      return bridge.mute();
    });
    renderControls();
    notify('mute', null);
  }

  function unmute() {
    if (disposed || !mounted || offLatched || !bridge) return;
    muted = false;
    callAsync(function () {
      return bridge.unmute();
    });
    renderControls();
    notify('unmute', null);
  }

  function emergencyOff() {
    if (disposed || !mounted) return;
    // Show OFF immediately and latch, BEFORE poking the bridge, so late bridge
    // events cannot slip a non-OFF surface through.
    enterOff();
    if (bridge) {
      callAsync(function () {
        return bridge.emergencyOff();
      });
    }
  }

  // Host-authorized reset seam -- the ONLY way out of the OFF latch. Never
  // activates the microphone; it only returns the panel to a dormant idle.
  function reset() {
    if (disposed || !mounted) return false;
    if (!offLatched) return false;
    offLatched = false;
    pendingStart = false;
    pendingConfirm = null;
    currentState = 'idle';
    epoch += 1;
    setText('interim', '');
    setText('reply', '');
    setText('confirm', '');
    setText('error', '');
    renderState();
    notify('reset', null);
    return true;
  }

  // Explicit user confirmation of an unclear/confirm transcript. This is the
  // ONLY place an unclear transcript may be submitted, and only on an explicit
  // call -- never automatically. Empty/unclear (no text) submits nothing.
  function confirmUnclear() {
    if (disposed || !mounted || offLatched || !bridge) return false;
    var pending = pendingConfirm;
    pendingConfirm = null;
    setText('confirm', '');
    renderControls();
    if (!pending || !pending.text) {
      notify('confirm_dismissed', { reason: 'no_text' });
      return false; // nothing to submit -> host may choose to re-listen
    }
    notify('confirm_submitted', { reason: pending.reason });
    callAsync(function () {
      return bridge.submit(pending.text); // explicit, user-initiated submit
    });
    return true;
  }

  function dismissUnclear() {
    if (disposed || !mounted) return;
    pendingConfirm = null;
    setText('confirm', '');
    renderControls();
    notify('confirm_dismissed', { reason: 'dismissed' });
  }

  // ---- control-element binding ---------------------------------------------
  function bind(target, type, handler) {
    if (!target || !isFn(target.addEventListener)) return;
    try {
      target.addEventListener(type, handler);
      boundListeners.push({ target: target, type: type, handler: handler });
    } catch (_e) {
      /* non-bindable handle -> ignore */
    }
  }

  function bindControls() {
    // Each bound handler swallows the DOM event and calls a guarded seam. The
    // seams themselves ignore redundant/duplicate activations.
    if (controls.start) bind(controls.start, 'click', function () { startListening(); });
    if (controls.stop) bind(controls.stop, 'click', function () { stop(); });
    if (controls.interrupt) bind(controls.interrupt, 'click', function () { interrupt(); });
    if (controls.mute) bind(controls.mute, 'click', function () { mute(); });
    if (controls.unmute) bind(controls.unmute, 'click', function () { unmute(); });
    if (controls.off) bind(controls.off, 'click', function () { emergencyOff(); });
    if (controls.reset) bind(controls.reset, 'click', function () { reset(); });
    if (controls.confirm) bind(controls.confirm, 'click', function () { confirmUnclear(); });
    if (controls.dismiss) bind(controls.dismiss, 'click', function () { dismissUnclear(); });
  }

  function unbindControls() {
    for (var i = 0; i < boundListeners.length; i++) {
      var b = boundListeners[i];
      try {
        if (b.target && isFn(b.target.removeEventListener)) {
          b.target.removeEventListener(b.type, b.handler);
        }
      } catch (_e) {
        /* ignore */
      }
    }
    boundListeners = [];
  }

  // ---- lifecycle ------------------------------------------------------------
  // Construct the bridge (via the host factory) and wire listeners. Renders the
  // honest initial 'idle'. Does NOT touch the microphone.
  function mount() {
    if (disposed) return false;
    if (mounted) return true; // idempotent mount
    mounted = true;
    epoch += 1;
    offLatched = false;
    currentState = 'idle';
    pendingConfirm = null;
    pendingStart = false;

    if (createBridge) {
      try {
        bridge = createBridge({
          onState: handleState,
          onReply: handleReply,
          onInterim: handleInterim,
          onNeedsConfirmation: handleConfirm,
          onError: handleError,
        });
      } catch (_e) {
        bridge = null; // bridge construction failed -> controls stay inert
      }
      if (bridge && typeof bridge !== 'object') bridge = null;
    }

    bindControls();
    // Clear any pre-existing surfaces and show a dormant idle.
    setText('interim', '');
    setText('reply', '');
    setText('confirm', '');
    setText('error', '');
    renderState();
    notify('mount', { hasBridge: !!bridge });
    return true;
  }

  function isMounted() {
    return mounted && !disposed;
  }
  function isOff() {
    return offLatched;
  }
  function getState() {
    return disposed ? 'off' : currentState;
  }
  function isDisposed() {
    return disposed;
  }

  // Idempotent teardown. Removes owned listeners, calls the bridge cleanup seam,
  // and suppresses every later callback (all handlers check `disposed`).
  function dispose() {
    if (disposed) return; // idempotent
    disposed = true;
    mounted = false;
    pendingConfirm = null;
    pendingStart = false;
    unbindControls();
    if (bridge && isFn(bridge.dispose)) {
      try {
        bridge.dispose();
      } catch (_e) {
        /* bridge cleanup must not throw out */
      }
    }
    bridge = null;
    notify('dispose', null);
  }

  return {
    // lifecycle
    mount: mount,
    dispose: dispose,
    unmount: dispose, // alias
    // inspection
    isMounted: isMounted,
    isOff: isOff,
    isDisposed: isDisposed,
    getState: getState,
    // control seams (programmatic; also driven by bound control elements)
    startListening: startListening,
    stop: stop,
    interrupt: interrupt,
    mute: mute,
    unmute: unmute,
    emergencyOff: emergencyOff,
    reset: reset,
    confirmUnclear: confirmUnclear,
    dismissUnclear: dismissUnclear,
  };
}

// Browser global for later panel wiring. No-op under Node/test.
if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined') {
  globalThis.window.ReinaVoicePanelController = { createVoicePanelController: createVoicePanelController };
}

export default { createVoicePanelController: createVoicePanelController };
