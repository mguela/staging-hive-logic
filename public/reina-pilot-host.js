/* public/reina-pilot-host.js
 *
 * Browser host for the existing purple Reina panel. It composes the strict
 * ReinaPilotClient, the server-bootstrap login brief, and the typed-panel
 * controller. It also composes the accepted, governed UI-intent router and the
 * existing in-app Voice stack. All navigation authority remains a correlated
 * server intent; Voice and typed input share the same strict client transport.
 *
 * Classic UMD: window.ReinaPilotHost in a browser and module.exports in Node.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaPilotHost = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var MAX_USER_TEXT = 4000;
  // The speaking-pace choices, in one place. The <option> values in
  // public/index.html, the whitelist that restores the saved choice, and the
  // range the synthesiser will actually honour all have to agree, and a test
  // holds them to it -- three files silently drifting apart is how a control
  // that is still on screen stops doing anything.
  var VOICE_RATES = Object.freeze(['0.85', '0.96', '1.15', '1.35', '1.6']);
  var MAX_RENDER_TEXT = 131072;
  var CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F]/;
  var SERVER_SESSION_RE = /^rp\.[0-9a-f]{64}$/;
  var CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  var REVIEW_INTENT_VERSION = 'reina.ui-intent.v1';
  var REVIEW_DESTINATION = 'standup';
  var EXACT_REVIEW_YES_RE = /^(?:yes|yep|yeah|sure|please do|ok|okay|go ahead)[.!?]?$/i;
  var EXACT_REVIEW_NO_RE = /^(?:no|nope|not now|cancel|dismiss|later)[.!?]?$/i;
  var WAKE_PHRASE_RE = /^\s*hey\s+reina(?:\s*[,!?.-]+\s*|\s+)?(.*)$/iu;
  var PAGE_KEYS = Object.freeze(['fab', 'panel', 'mode', 'close', 'feed', 'input', 'send']);
  var PAGE_IDS = Object.freeze({
    fab: 'rnaFab', panel: 'rnaPanel', mode: 'rnaMode', close: 'rnaX',
    feed: 'rnaFeed', input: 'rnaIn', send: 'rnaSend',
  });
  var FIXED_ERRORS = Object.freeze({
    auth_expired: 'Your Reina session expired. Sign in again to continue.',
    bootstrap_failed: 'Reina could not verify this signed-in session.',
    unavailable: 'Reina\'s synthetic read-only preview is unavailable right now.',
    turn_failed: 'Reina could not complete this read-only preview turn. Please try again.',
    invalid_input: 'Enter a plain-text question of 4,000 characters or fewer.',
  });

  function hasOwnValue(descriptor) {
    return descriptor != null && Object.prototype.hasOwnProperty.call(descriptor, 'value');
  }

  function ownData(object, key) {
    if (object === null || typeof object !== 'object') return { ok: false };
    try {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!hasOwnValue(descriptor)) return { ok: false };
      return { ok: true, value: descriptor.value };
    } catch (_) {
      return { ok: false };
    }
  }

  function readExactDataObject(value, keys) {
    if (value === null || typeof value !== 'object') return null;
    try {
      if (Array.isArray(value)) return null;
      var names = Object.getOwnPropertyNames(value);
      var symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length !== 0 || names.length !== keys.length) return null;
      var allowed = Object.create(null);
      var output = Object.create(null);
      for (var i = 0; i < keys.length; i += 1) allowed[keys[i]] = true;
      for (var n = 0; n < names.length; n += 1) {
        var name = names[n];
        if (!allowed[name]) return null;
        var descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!hasOwnValue(descriptor) || descriptor.enumerable !== true) return null;
        output[name] = descriptor.value;
      }
      return output;
    } catch (_) {
      return null;
    }
  }

  function optionValue(options, key, fallback) {
    var result = ownData(options, key);
    return result.ok ? result.value : fallback;
  }

  function isFunction(value) { return typeof value === 'function'; }

  function captureFactory(moduleName, factoryName) {
    var moduleResult = ownData(root, moduleName);
    if (!moduleResult.ok || moduleResult.value === null || typeof moduleResult.value !== 'object') return null;
    var factoryResult = ownData(moduleResult.value, factoryName);
    return factoryResult.ok && isFunction(factoryResult.value) ? factoryResult.value : null;
  }

  function captureGlobalFunction(functionName) {
    var result = ownData(root, functionName);
    if (!result.ok || !isFunction(result.value)) return null;
    var fn = result.value;
    return function () { return fn.apply(root, arguments); };
  }

  function captureBoundMethod(receiver, methodName) {
    if (receiver === null || (typeof receiver !== 'object' && typeof receiver !== 'function')) return null;
    var cursor = receiver;
    for (var depth = 0; cursor && depth < 12; depth += 1) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(cursor, methodName); } catch (_) { return null; }
      if (descriptor) {
        if (!('value' in descriptor) || !isFunction(descriptor.value)) return null;
        var method = descriptor.value;
        return function () { return method.apply(receiver, arguments); };
      }
      try { cursor = Object.getPrototypeOf(cursor); } catch (_) { return null; }
    }
    return null;
  }

  // The dependency scripts load immediately before this host. Pin their exact
  // factory identities now; a later page script or delayed auth event cannot
  // replace a global with a forged greeting/answer source. Explicit test DI is
  // still accepted by createReinaPilotHost.
  var CAPTURED_CREATE_CLIENT = captureFactory('ReinaPilotClient', 'createReinaPilotClient');
  var CAPTURED_CREATE_LOGIN_BRIEF = captureFactory('ReinaLoginBrief', 'createLoginBrief');
  var CAPTURED_CREATE_TYPED_PANEL = captureFactory('ReinaTypedPanel', 'createTypedPanel');
  var CAPTURED_CREATE_INTENT_ROUTER = captureFactory('ReinaUiIntentRouter', 'createUiIntentRouter');
  var CAPTURED_SHOW_VIEW = captureGlobalFunction('showView');
  var CAPTURED_GO = captureGlobalFunction('go');
  var CAPTURED_CREATE_NEURAL_SYNTHESIS = captureFactory('ReinaNeuralSpeech', 'createNeuralSynthesis');
  var CAPTURED_CREATE_NEURAL_UTTERANCE = captureFactory('ReinaNeuralSpeech', 'createUtterance');
  var CAPTURED_FETCH = captureGlobalFunction('fetch');
  // Electron exposes native one-shot recognition through its preload bridge.
  // Capture the exact methods now; later page code cannot replace that bridge.
  var CAPTURED_NATIVE_RECOGNITION = (function () {
    var desktop = ownData(root, 'hivelogicDesktop');
    if (!desktop.ok || desktop.value === null || typeof desktop.value !== 'object') return null;
    var recognize = ownData(desktop.value, 'recognizeOnce');
    var cancel = ownData(desktop.value, 'cancelRecognition');
    if (!recognize.ok || !cancel.ok || !isFunction(recognize.value) || !isFunction(cancel.value)) return null;
    var receiver = desktop.value;
    var recognizeOnce = recognize.value;
    var cancelRecognition = cancel.value;
    return Object.freeze({
      recognizeOnce: function () { return recognizeOnce.call(receiver); },
      cancelRecognition: function () { return cancelRecognition.call(receiver); },
    });
  })();
  var CAPTURED_NATIVE_WAKE = (function () {
    var desktop = ownData(root, 'hivelogicDesktop');
    if (!desktop.ok || desktop.value === null || typeof desktop.value !== 'object') return null;
    var start = ownData(desktop.value, 'startWakeWord');
    var stop = ownData(desktop.value, 'stopWakeWord');
    var subscribe = ownData(desktop.value, 'onWakeDetected');
    if (!start.ok || !stop.ok || !subscribe.ok || !isFunction(start.value)
      || !isFunction(stop.value) || !isFunction(subscribe.value)) return null;
    var receiver = desktop.value;
    var startWakeWord = start.value;
    var stopWakeWord = stop.value;
    var onWakeDetected = subscribe.value;
    var resume = ownData(desktop.value, 'resumeWakeWord');
    var resumeWakeWord = resume.ok && isFunction(resume.value) ? resume.value : null;
    var disable = ownData(desktop.value, 'disableWakeWord');
    var disableWakeWord = disable.ok && isFunction(disable.value) ? disable.value : null;
    return Object.freeze({
      startWakeWord: function () { return startWakeWord.call(receiver); },
      stopWakeWord: function () { return stopWakeWord.call(receiver); },
      onWakeDetected: function (listener) { return onWakeDetected.call(receiver, listener); },
      resumeWakeWord: resumeWakeWord ? function () { return resumeWakeWord.call(receiver); } : null,
      disableWakeWord: disableWakeWord ? function () { return disableWakeWord.call(receiver); } : null,
    });
  })();
  var CAPTURED_SPEECH_RECOGNITION = (function () {
    var direct = ownData(root, 'SpeechRecognition');
    var webkit = ownData(root, 'webkitSpeechRecognition');
    return direct.ok && isFunction(direct.value) ? direct.value
      : webkit.ok && isFunction(webkit.value) ? webkit.value : null;
  })();
  var CAPTURED_AUDIO = (function () {
    var value = ownData(root, 'Audio');
    return value.ok && isFunction(value.value) ? value.value : null;
  })();
  var CAPTURED_ABORT_CONTROLLER = (function () {
    var value = ownData(root, 'AbortController');
    return value.ok && isFunction(value.value) ? value.value : null;
  })();
  var CAPTURED_URL_METHODS = (function () {
    var value = ownData(root, 'URL');
    if (!value.ok || (typeof value.value !== 'object' && typeof value.value !== 'function')) return null;
    var create = captureBoundMethod(value.value, 'createObjectURL');
    var revoke = captureBoundMethod(value.value, 'revokeObjectURL');
    return create && revoke ? Object.freeze({ create: create, revoke: revoke }) : null;
  })();

  var NATIVE_RECOGNITION_CODES = Object.freeze({
    no_speech: 'no-speech',
    permission_denied: 'not-allowed',
    os_microphone_denied: 'not-allowed',
    unavailable: 'audio-capture',
    timeout: 'timeout',
    canceled: 'aborted',
    recognition_error: 'recognition-error',
  });
  var NATIVE_VOICE_MESSAGES = Object.freeze({
    no_speech: 'I did not hear anything. Select Enable Hands-free and try again.',
    permission_denied: 'Microphone access was denied. Allow microphone access and try again.',
    no_microphone: 'No microphone was found. Connect or select one, then try again.',
    device_busy: 'The microphone is being used by another app. Close it and try again.',
    os_microphone_denied: 'Windows denied microphone access to HiveLogic Desktop. Typed Reina still works.',
    network: 'Chrome could not reach its speech service. You can type instead.',
    audio_capture: 'Chrome could not capture audio after microphone access was granted. Check the selected input device and try again.',
    unavailable: 'Voice recording could not start in this browser. Typed Reina still works.',
    timeout: 'I did not hear you in time. Select Enable Hands-free and try again.',
    canceled: 'Voice listening was canceled.',
    recognition_error: 'Voice input hit a problem. Select Enable Hands-free and try again.',
  });

  // Everything above is a MICROPHONE failure. A spoken turn can also fail after
  // the microphone succeeded -- the transport never answered, the answer failed
  // envelope validation, the sign-in expired, the answer came back empty. Those
  // failures used to render nothing at all: the panel changed state and the feed
  // stayed silent. Name each one, in the same voice as the microphone messages.
  var VOICE_TURN_MESSAGES = Object.freeze({
    // The recording reached transcription and came back with no words. Saying
    // "I did not hear anything -- select Enable Hands-free" here points the
    // user at the microphone, which is the half that demonstrably worked.
    //
    // It used to end "the transcription service, not your microphone, is the
    // problem". That was asserted, never measured, and it was wrong the one
    // time it was read in anger: the recording behind it peaked at 17 of 127
    // on a webcam microphone across the room. Anything quiet enough to be
    // suspect is now caught by the audible floor and named as such, so this
    // message no longer has to guess at fault -- and no longer claims to know.
    error_transcription_no_speech:
      'I recorded you, but transcription returned no words. Try again — if it keeps happening, check which microphone is selected in Settings.',
    // The attempt never came back at all. Saying nothing here is what left a
    // finished recording sitting in an empty panel with no outcome.
    error_transcription_timeout:
      'I recorded you, but transcription never answered. Nothing was sent. Typed Reina still works.',
    // Measured, not guessed: the recording peaked at the noise floor. Telling
    // this user "I did not hear anything, try again" invites them to repeat the
    // one thing that cannot work. The input is the problem, and the fix is in
    // Settings, not in speaking louder.
    // The advice used to be "pick a different microphone", which is only one of
    // the two reasons a recording comes back at the noise floor -- and it was
    // the wrong one for the person who read it: their microphone was the one
    // they wanted, its input level was simply turned down. Name both causes
    // and put the cheaper one first.
    error_input_too_quiet:
      'Your microphone recorded almost no sound. Turn its input volume up in your system sound settings — or pick a different microphone in Settings if that does not help.',
    // Measured, not guessed, same as its opposite: the recording railed the
    // meter repeatedly. Clipped audio comes back from transcription as an
    // empty string exactly like silence does, and until this existed both
    // produced the same unhelpful message -- so a user whose input was
    // distorting was told to check which microphone was selected, when the
    // microphone was the one they wanted and only its level was wrong.
    error_input_too_loud:
      'Your microphone is recording too loud and distorting, so nothing could be transcribed. Turn its input volume down in your system sound settings — around half is usually right.',
    // The browser was asked for the microphone and never answered either way.
    // This is the failure that produced no message at all: recording never
    // started, so no timer, no meter and no diagnostic had been armed yet, and
    // the panel simply waited. Name it, because the fix is the browser's
    // permission state, not anything about how the user spoke.
    error_microphone_open_timeout:
      'Your browser never opened the microphone, so nothing was recorded. Check the site\u2019s microphone permission, then try again. Typed Reina still works.',
    error_turn_failed: 'Reina could not answer that spoken turn. Typed Reina still works.',
    error_turn_timeout: 'Reina did not answer that spoken turn in time. Typed Reina still works.',
    error_turn_empty_reply: 'Reina returned no answer for that spoken turn. Typed Reina still works.',
    error_auth_expired: 'Your sign-in expired, so that spoken turn was not answered. Sign in again.',
  });

  // Every refusal in the voice path was a bare `return false`. When Voice would
  // not switch on there was nothing to read anywhere -- not in the panel, not in
  // the console, not in the DOM -- so diagnosing it meant reading the source and
  // guessing which of six conditions had fired. Record the reason and say it out
  // loud. This changes no behaviour: callers still get false.
  var LAST_VOICE_BLOCK = null;
  var LAST_TURN_BLOCK = null;
  // Voice REFUSING TO START was the last failure with no record anywhere. Every
  // other path -- a silent clip, a refused transcript, a failed turn -- writes a
  // row; this one only ever reached the console of whoever pressed the button,
  // so "nothing happened" and "the host declined to open the microphone" looked
  // identical from outside. Report it like the rest.
  var VOICE_BLOCK_REPORTER = null;
  function setVoiceBlockReporter(report) {
    VOICE_BLOCK_REPORTER = isFunction(report) ? report : null;
  }
  function noteVoiceBlock(reason) {
    LAST_VOICE_BLOCK = typeof reason === 'string' && reason ? reason : 'unknown';
    try {
      var c = root && root.console;
      if (c && isFunction(c.warn)) c.warn('[reina-voice] not starting: ' + LAST_VOICE_BLOCK);
    } catch (_) {}
    // Reasons carry a free-form tail (e.g. 'voice_host_threw:<message>'); keep
    // the code, drop the tail, so a row can only ever hold an enumerable cause.
    try {
      if (VOICE_BLOCK_REPORTER) {
        var code = LAST_VOICE_BLOCK.split(':', 1)[0].slice(0, 60);
        if (/^[a-z0-9_-]{1,60}$/i.test(code)) VOICE_BLOCK_REPORTER({ stage: 'startup', code: code });
      }
    } catch (_) {}
    return false;
  }
  // Same treatment for typed turns: Send did nothing at all when the session
  // was not ready, leaving the text in the box and no trace anywhere.
  function noteTurnBlock(reason) {
    LAST_TURN_BLOCK = typeof reason === 'string' && reason ? reason : 'unknown';
    try {
      var c = root && root.console;
      if (c && isFunction(c.warn)) c.warn('[reina-turn] not sent: ' + LAST_TURN_BLOCK);
    } catch (_) {}
    return false;
  }

  function createNativeRecognitionFactory(nativeRecognition, onIssue) {
    var recognize = ownData(nativeRecognition, 'recognizeOnce');
    var cancel = ownData(nativeRecognition, 'cancelRecognition');
    if (!recognize.ok || !cancel.ok || !isFunction(recognize.value) || !isFunction(cancel.value)) return null;
    var recognizeOnce = recognize.value;
    var cancelRecognition = cancel.value;
    var issue = isFunction(onIssue) ? onIssue : function () {};
    return function () {
      var instance = { lang: 'en-US', interimResults: false, continuous: false, onstart: null, onresult: null, onerror: null, onend: null };
      var active = false;
      var generation = 0;
      function emit(name, payload) {
        var callback;
        try { callback = instance[name]; } catch (_) { return; }
        try { if (isFunction(callback)) callback.call(instance, payload); } catch (_) {}
      }
      function finish(myGeneration) {
        if (!active || myGeneration !== generation) return;
        active = false;
        emit('onend', Object.freeze({}));
      }
      function fail(code, myGeneration) {
        if (!active || myGeneration !== generation) return;
        var safeCode = Object.prototype.hasOwnProperty.call(NATIVE_RECOGNITION_CODES, code) ? code : 'recognition_error';
        emit('onerror', Object.freeze({ error: NATIVE_RECOGNITION_CODES[safeCode] }));
        try { issue(safeCode); } catch (_) {}
        finish(myGeneration);
      }
      instance.start = function () {
        if (active) throw new Error('native_recognition_active');
        active = true;
        var myGeneration = ++generation;
        emit('onstart', Object.freeze({}));
        var pending;
        try { pending = recognizeOnce.call(nativeRecognition); } catch (_) { fail('recognition_error', myGeneration); return; }
        Promise.resolve(pending).then(function (raw) {
          if (!active || myGeneration !== generation) return;
          var success = readExactDataObject(raw, ['ok', 'transcript']);
          if (success && success.ok === true && safePrimitiveText(success.transcript, 1000, false)
            && success.transcript.trim() === success.transcript && success.transcript.indexOf('<') === -1 && success.transcript.indexOf('>') === -1) {
            var alternative = Object.freeze({ transcript: success.transcript });
            var result = Object.freeze({ 0: alternative, length: 1, isFinal: true });
            emit('onresult', Object.freeze({ resultIndex: 0, results: Object.freeze([result]) }));
            finish(myGeneration);
            return;
          }
          var failure = readExactDataObject(raw, ['ok', 'code']);
          fail(failure && failure.ok === false && typeof failure.code === 'string' ? failure.code : 'recognition_error', myGeneration);
        }, function () { fail('recognition_error', myGeneration); });
      };
      function cancelActive() {
        if (!active) return;
        var myGeneration = generation;
        try { Promise.resolve(cancelRecognition.call(nativeRecognition)).catch(function () {}); } catch (_) {}
        fail('canceled', myGeneration);
      }
      instance.stop = cancelActive;
      instance.abort = cancelActive;
      return instance;
    };
  }

  function createCapturedNativeRecognitionFactory(onIssue) {
    return CAPTURED_NATIVE_RECOGNITION ? createNativeRecognitionFactory(CAPTURED_NATIVE_RECOGNITION, onIssue) : null;
  }

  // The browser's own speech recognition. CAPTURED_SPEECH_RECOGNITION has been
  // read off the window since this file was written and then used NOWHERE --
  // and "native" here has always meant CAPTURED_NATIVE_RECOGNITION, which is
  // the Electron desktop bridge (window.hivelogicDesktop). In a browser that
  // bridge does not exist, so both native factories resolved null on every
  // load and voice fell through to the recorder-and-upload path every single
  // time. That path has not produced one usable transcript: measured peaks
  // from 1 to 128 across four microphones, every attempt answered by an empty
  // string on an HTTP 200.
  //
  // Meanwhile Chrome transcribes the same speaker, on the same microphone, in
  // the same room, with no upload at all -- verified directly on
  // /voice-lab.html, which read a crest factor of 18.6 (unambiguously speech)
  // and printed the words. The adapter contract in
  // reina-browser-speech-adapters.js is already the browser SpeechRecognition
  // shape verbatim -- .lang, .interimResults, .continuous, start/stop/abort,
  // onstart/onresult/onerror/onend -- so the constructor IS the factory.
  //
  // One real limitation, stated rather than hidden: SpeechRecognition uses the
  // system default input and cannot be pointed at a chosen device the way the
  // recorder's own microphone request can. The recorder path below still can,
  // and still runs whenever this is unavailable.
  function createCapturedBrowserRecognitionFactory() {
    if (!CAPTURED_SPEECH_RECOGNITION) return null;
    return function browserRecognition() {
      return new CAPTURED_SPEECH_RECOGNITION();
    };
  }

  function createNativeWakeRecognitionFactory(nativeWake, onWake, onIssue) {
    if (!nativeWake || typeof nativeWake !== 'object') return null;
    var start = ownData(nativeWake, 'startWakeWord');
    var stop = ownData(nativeWake, 'stopWakeWord');
    var subscribe = ownData(nativeWake, 'onWakeDetected');
    if (!start.ok || !stop.ok || !subscribe.ok || !isFunction(start.value)
      || !isFunction(stop.value) || !isFunction(subscribe.value)) return null;
    var startWakeWord = start.value;
    var stopWakeWord = stop.value;
    var onWakeDetected = subscribe.value;
    var issue = isFunction(onIssue) ? onIssue : function () {};
    var woke = isFunction(onWake) ? onWake : function () {};
    return function () {
      var instance = { lang: 'en-US', interimResults: false, continuous: false, onstart: null, onresult: null, onerror: null, onend: null };
      var active = false;
      var generation = 0;
      var unsubscribe = null;
      function emit(name, payload) {
        var callback;
        try { callback = instance[name]; } catch (_) { return; }
        try { if (isFunction(callback)) callback.call(instance, payload); } catch (_) {}
      }
      function detach() {
        var remove = unsubscribe;
        unsubscribe = null;
        try { if (isFunction(remove)) remove(); } catch (_) {}
      }
      function finish(myGeneration) {
        if (!active || myGeneration !== generation) return;
        active = false;
        detach();
        emit('onend', Object.freeze({}));
      }
      function fail(code, myGeneration) {
        if (!active || myGeneration !== generation) return;
        var safeCode = Object.prototype.hasOwnProperty.call(NATIVE_RECOGNITION_CODES, code) ? code : 'recognition_error';
        emit('onerror', Object.freeze({ error: NATIVE_RECOGNITION_CODES[safeCode] }));
        try { issue(safeCode); } catch (_) {}
        finish(myGeneration);
      }
      instance.start = function () {
        if (active) throw new Error('native_wake_active');
        active = true;
        var myGeneration = ++generation;
        emit('onstart', Object.freeze({}));
        try {
          unsubscribe = onWakeDetected.call(nativeWake, function () {
            if (active && myGeneration === generation) {
              try { woke(); } catch (_) {}
            }
          });
        } catch (_) { fail('recognition_error', myGeneration); return; }
        var pending;
        try { pending = startWakeWord.call(nativeWake); } catch (_) { fail('recognition_error', myGeneration); return; }
        Promise.resolve(pending).then(function (raw) {
          if (!active || myGeneration !== generation) return;
          var success = readExactDataObject(raw, ['ok', 'transcript']);
          if (success && success.ok === true && safePrimitiveText(success.transcript, 1000, false)
            && success.transcript.trim() === success.transcript && success.transcript.indexOf('<') === -1 && success.transcript.indexOf('>') === -1) {
            var alternative = Object.freeze({ transcript: 'Hey Reina ' + success.transcript });
            var result = Object.freeze({ 0: alternative, length: 1, isFinal: true });
            emit('onresult', Object.freeze({ resultIndex: 0, results: Object.freeze([result]) }));
            finish(myGeneration);
            return;
          }
          var failure = readExactDataObject(raw, ['ok', 'code']);
          fail(failure && failure.ok === false && typeof failure.code === 'string' ? failure.code : 'recognition_error', myGeneration);
        }, function () { fail('recognition_error', myGeneration); });
      };
      function cancelActive() {
        if (!active) return;
        var myGeneration = generation;
        try { Promise.resolve(stopWakeWord.call(nativeWake)).catch(function () {}); } catch (_) {}
        fail('canceled', myGeneration);
      }
      instance.stop = cancelActive;
      instance.abort = cancelActive;
      return instance;
    };
  }

  function createCapturedNativeWakeRecognitionFactory(onWake, onIssue) {
    return CAPTURED_NATIVE_WAKE
      ? createNativeWakeRecognitionFactory(CAPTURED_NATIVE_WAKE, onWake, onIssue)
      : null;
  }

  function defaultLoadVoiceModules() {
    return Promise.all([
      import('/reina-inapp-voice-host.js'),
      import('/reina-canonical-voice-transport.js'),
      import('/reina-controlled-transcription.js'),
    ]).then(function (modules) {
      return Object.freeze({
        createVoiceHost: modules[0] && modules[0].createReinaInAppVoiceHost,
        createVoiceTransport: modules[1] && modules[1].createCanonicalVoiceTransport,
        createControlledRecognitionFactory: modules[2] && modules[2].createControlledTranscriptionRecognitionFactory,
      });
    });
  }

  function safePrimitiveText(value, maximum, allowEmpty) {
    return typeof value === 'string'
      && value.length <= maximum
      && (allowEmpty || value.length > 0)
      && !CONTROL_RE.test(value);
  }

  function safeStringList(value, maximumItems, maximumText) {
    try {
      if (!Array.isArray(value) || value.length > maximumItems) return [];
      var output = [];
      for (var i = 0; i < value.length; i += 1) {
        var descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!hasOwnValue(descriptor) || !safePrimitiveText(descriptor.value, maximumText, true)) return [];
        output.push(descriptor.value);
      }
      return output;
    } catch (_) {
      return [];
    }
  }

  function canonicalUtc(value) {
    if (!safePrimitiveText(value, 64, false) || !CANONICAL_UTC_RE.test(value)) return false;
    var milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return false;
    var normalized = value.indexOf('.') === -1 ? value.slice(0, -1) + '.000Z' : value;
    try { return new Date(milliseconds).toISOString() === normalized; } catch (_) { return false; }
  }

  function exactDenseArray(value, maximum) {
    try {
      if (!Array.isArray(value) || value.length > maximum) return null;
      var names = Object.getOwnPropertyNames(value);
      var symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length !== 0 || names.length !== value.length + 1 || names[names.length - 1] !== 'length') return null;
      var output = [];
      for (var i = 0; i < value.length; i += 1) {
        var descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!hasOwnValue(descriptor) || descriptor.enumerable !== true) return null;
        output.push(descriptor.value);
      }
      return output;
    } catch (_) {
      return null;
    }
  }

  // PR #87 predates the server/client honesty contract for unavailable counts:
  // the canonical wire value is null, while its validator requires an integer.
  // This is a display-only copy made after strict own-data validation. PR #87
  // filters unavailable categories from rendered totals, so only those copies
  // receive count:0. The authoritative bootstrap and router intent are never
  // changed. At least one real available source is mandatory; an all-unknown
  // result must not become a false "nothing needs attention" greeting.
  function bootstrapForLoginBrief(raw, expectedSessionId) {
    var top = readExactDataObject(raw, [
      'ok', 'sessionId', 'generatedAt', 'user', 'attention', 'review', 'uiIntent', 'executed',
    ]);
    if (!top || top.ok !== true || top.executed !== false || top.sessionId !== expectedSessionId
      || !SERVER_SESSION_RE.test(top.sessionId) || !canonicalUtc(top.generatedAt)) return null;
    var user = readExactDataObject(top.user, ['displayName']);
    var attention = readExactDataObject(top.attention, [
      'total', 'asOf', 'reviewAvailable', 'categories', 'unavailableSources',
    ]);
    if (!user || !safePrimitiveText(user.displayName, 120, false) || !attention
      || attention.reviewAvailable !== true
      || !(attention.asOf === null || canonicalUtc(attention.asOf))) return null;
    var categories = exactDenseArray(attention.categories, 24);
    var unavailable = exactDenseArray(attention.unavailableSources, 24);
    if (!categories || !unavailable) return null;
    var safeCategories = [];
    var availableCount = 0;
    var availableTotal = 0;
    var seen = Object.create(null);
    for (var i = 0; i < categories.length; i += 1) {
      var category = readExactDataObject(categories[i], [
        'key', 'label', 'count', 'available', 'asOf', 'evidence',
      ]);
      if (!category || !safePrimitiveText(category.key, 80, false)
        || !safePrimitiveText(category.label, 120, false) || seen[category.key]
        || typeof category.available !== 'boolean') return null;
      seen[category.key] = true;
      var evidence = exactDenseArray(category.evidence, 16);
      if (!evidence) return null;
      var safeEvidence = [];
      for (var e = 0; e < evidence.length; e += 1) {
        if (!safePrimitiveText(evidence[e], 1000, false)) return null;
        safeEvidence.push(evidence[e]);
      }
      var displayCount;
      var displayAsOf = null;
      if (category.available === true) {
        if (!Number.isSafeInteger(category.count) || category.count < 0 || category.count > 1000000
          || !canonicalUtc(category.asOf)) return null;
        displayCount = category.count;
        displayAsOf = category.asOf;
        availableCount += 1;
        availableTotal += category.count;
      } else {
        if (category.count !== null || category.asOf !== null) return null;
        displayCount = 0;
      }
      safeCategories.push(Object.freeze({
        key: category.key, label: category.label, count: displayCount,
        available: category.available, asOf: displayAsOf,
        evidence: Object.freeze(safeEvidence),
      }));
    }
    if (availableCount < 1 || !Number.isSafeInteger(attention.total)
      || attention.total !== availableTotal) return null;
    var safeUnavailable = [];
    for (var u = 0; u < unavailable.length; u += 1) {
      if (!safePrimitiveText(unavailable[u], 1000, false)) return null;
      safeUnavailable.push(unavailable[u]);
    }
    return Object.freeze({
      ok: true, sessionId: top.sessionId, generatedAt: top.generatedAt,
      user: Object.freeze({ displayName: user.displayName }),
      attention: Object.freeze({
        total: attention.total, asOf: attention.asOf,
        reviewAvailable: true, categories: Object.freeze(safeCategories),
        unavailableSources: Object.freeze(safeUnavailable),
      }),
      review: top.review, uiIntent: top.uiIntent, executed: false,
    });
  }

  function text(node, value) {
    try { node.textContent = typeof value === 'string' ? value : ''; } catch (_) { /* presentation stays inert */ }
  }

  function fixedClass(node, className) {
    try { node.className = className; } catch (_) { /* cosmetic only */ }
  }

  function setDisplay(node, value) {
    try { if (node && node.style) node.style.display = value; } catch (_) { /* fail-closed state is independent */ }
  }

  function setDisabled(node, value) {
    try { node.disabled = value === true; } catch (_) { /* fail-closed state is independent */ }
  }

  function setTitle(node, value) {
    try { node.title = typeof value === 'string' ? value : ''; } catch (_) { /* cosmetic only */ }
  }

  function addClass(node, value) {
    try { if (node && node.classList && isFunction(node.classList.add)) node.classList.add(value); } catch (_) {}
  }

  function removeClass(node, value) {
    try { if (node && node.classList && isFunction(node.classList.remove)) node.classList.remove(value); } catch (_) {}
  }

  function resolveElements(documentRef) {
    if (!documentRef || !isFunction(documentRef.getElementById)) return null;
    var resolved = {};
    try {
      for (var i = 0; i < PAGE_KEYS.length; i += 1) {
        var key = PAGE_KEYS[i];
        var element = documentRef.getElementById(PAGE_IDS[key]);
        if (!element || typeof element !== 'object') return null;
        resolved[key] = element;
      }
    } catch (_) {
      return null;
    }
    return Object.freeze(resolved);
  }

  function validateElements(raw) {
    var values = readExactDataObject(raw, PAGE_KEYS);
    if (!values) return null;
    try {
      if (!isFunction(values.feed.appendChild)) return null;
      if (!values.panel.classList || !isFunction(values.panel.classList.add) || !isFunction(values.panel.classList.remove)) return null;
      if (!isFunction(values.input.addEventListener) || !isFunction(values.input.removeEventListener)) return null;
      if (!values.fab.style) return null;
      return Object.freeze({
        fab: values.fab, panel: values.panel, mode: values.mode, close: values.close,
        feed: values.feed, input: values.input, send: values.send,
      });
    } catch (_) {
      return null;
    }
  }

  function hidePage(elements) {
    if (!elements) return;
    setDisplay(elements.fab, 'none');
    removeClass(elements.panel, 'open');
    setDisabled(elements.input, true);
    setDisabled(elements.send, true);
    text(elements.mode, 'preview unavailable');
    removeClass(elements.mode, 'live');
  }

  // A session or Voice transport failure must never remove the Reina entry
  // point. Keep the purple button available, but never override the user's
  // choice to close the panel.
  function showUnavailablePage(elements) {
    if (!elements) return;
    setDisplay(elements.fab, 'flex');
    setDisabled(elements.input, true);
    setDisabled(elements.send, true);
    text(elements.mode, 'preview unavailable');
    removeClass(elements.mode, 'live');
  }

  function createReinaPilotHost(options) {
    if (options === null || typeof options !== 'object') {
      throw new Error('createReinaPilotHost: options are required');
    }

    var documentRef = optionValue(options, 'documentRef', root && root.document ? root.document : null);
    var suppliedElements = optionValue(options, 'elements', null);
    var page = validateElements(suppliedElements || resolveElements(documentRef));
    var createClient = optionValue(options, 'createClient', null);
    var createLoginBrief = optionValue(options, 'createLoginBrief', null);
    var createTypedPanel = optionValue(options, 'createTypedPanel', null);
    var createIntentRouter = optionValue(options, 'createIntentRouter', null);
    var loadVoiceModules = optionValue(options, 'loadVoiceModules', defaultLoadVoiceModules);
    var showView = optionValue(options, 'showView', CAPTURED_SHOW_VIEW);
    var go = optionValue(options, 'go', CAPTURED_GO);
    var suppliedNewId = optionValue(options, 'newId', null);
    var getAccessToken = optionValue(options, 'getAccessToken', null);
    var onAuthExpired = optionValue(options, 'onAuthExpired', function () {});
    var onState = optionValue(options, 'onState', function () {});
    var defaultSetHostTimeout = typeof setTimeout === 'function' ? setTimeout : function () { return null; };
    var defaultClearHostTimeout = typeof clearTimeout === 'function' ? clearTimeout : function () {};
    var setHostTimeout = optionValue(options, 'setTimeoutFn', defaultSetHostTimeout);
    var clearHostTimeout = optionValue(options, 'clearTimeoutFn', defaultClearHostTimeout);

    if (!isFunction(createClient)) createClient = CAPTURED_CREATE_CLIENT;
    if (!isFunction(createLoginBrief)) createLoginBrief = CAPTURED_CREATE_LOGIN_BRIEF;
    if (!isFunction(createTypedPanel)) createTypedPanel = CAPTURED_CREATE_TYPED_PANEL;
    if (!isFunction(createIntentRouter)) createIntentRouter = CAPTURED_CREATE_INTENT_ROUTER;
    var newId = isFunction(suppliedNewId) ? suppliedNewId : function () {
      var cryptoRef = root && root.crypto;
      if (!cryptoRef || !isFunction(cryptoRef.randomUUID)) throw new Error('secure_id_unavailable');
      return cryptoRef.randomUUID();
    };
    if (!documentRef || !isFunction(documentRef.createElement) || !page) {
      throw new Error('createReinaPilotHost: the exact Reina panel elements are required');
    }
    if (!isFunction(createClient) || !isFunction(createLoginBrief) || !isFunction(createTypedPanel)
      || !isFunction(createIntentRouter)) {
      throw new Error('createReinaPilotHost: Reina client, login, typed, and UI-intent factories are required');
    }
    if (!isFunction(onAuthExpired)) onAuthExpired = function () {};
    if (!isFunction(onState)) onState = function () {};
    if (!isFunction(setHostTimeout)) setHostTimeout = defaultSetHostTimeout;
    if (!isFunction(clearHostTimeout)) clearHostTimeout = defaultClearHostTimeout;

    var mounted = false;
    var disposed = false;
    var epoch = 0;
    var state = 'idle';
    var sessionId = null;
    var client = null;
    var loginBrief = null;
    var typedPanel = null;
    var intentRouter = null;
    var voiceHost = null;
    var voiceSynthesis = null;
    var voiceLoad = null;
    var voiceEnabled = false;
    var directListening = false;
    // A trusted header-toggle click is the consent boundary.  Once enabled,
    // hands-free listening is page-wide while HiveLogic remains open.
    var handsFreeEnabled = false;
    var handsFreeRearmTimer = null;
    var panelAutoCloseTimer = null;
    var emergencyOff = false;
    var pendingReview = null;
    var confirmationGrant = null;
    var view = null;
    var listeners = [];
    var renderedTurns = Object.create(null);
    var expirySignaled = false;
    var retrying = false;
    var sendIdleText = 'Send';
    var pendingSession = null;
    var refreshedDuringTurn = false;

    try {
      if (safePrimitiveText(page.send.textContent, 32, false)) sendIdleText = page.send.textContent;
    } catch (_) { /* fixed fallback stays safe */ }

    // ONE control, replacing three that each said the wrong thing: a Voice
    // On/Off toggle labelled with a state rather than an action, a "Stop
    // talking" button that stopped REINA and not the speaker, and a Listening
    // chip that repeated what the toggle should already have shown. This
    // button's label is always what clicking it will do.
    var topVoiceToggle = null;
    try { topVoiceToggle = documentRef.getElementById('rnaVoice'); } catch (_) { topVoiceToggle = null; }
    var topVoiceLabel = null;
    try { topVoiceLabel = documentRef.getElementById('rnaVoiceLabel'); } catch (_) { topVoiceLabel = null; }
    var topVoiceLive = null;
    try { topVoiceLive = documentRef.getElementById('rnaVoiceLive'); } catch (_) { topVoiceLive = null; }
    var voiceStage = null;
    try { voiceStage = documentRef.getElementById('rnaStage'); } catch (_) { voiceStage = null; }
    var voiceHint = null;
    try { voiceHint = documentRef.getElementById('rnaVoiceHint'); } catch (_) { voiceHint = null; }
    // 'off' | 'listening' | 'thinking' | 'speaking'
    var voicePhase = 'off';
    var settingsVoiceToggle = null;
    var popupSettings = null;
    var popupSettingsPanel = null;
    var popupHistory = null;
    var popupMinimize = null;
    var popupHead = null;
    var audioInputSelect = null;
    var audioOutputSelect = null;
    var refreshAudioDevicesButton = null;
    var audioDeviceStatus = null;
    var neuralVoiceSelect = null;
    var voiceRateSelect = null;
    try {
      settingsVoiceToggle = documentRef.getElementById('rnaSettingsVoiceToggle');
      popupSettings = documentRef.getElementById('rnaSettings');
      popupSettingsPanel = documentRef.getElementById('rnaSettingsPanel');
      popupHistory = documentRef.getElementById('rnaHistory');
      popupMinimize = documentRef.getElementById('rnaMin');
      popupHead = documentRef.getElementById('rnaHead');
      audioInputSelect = documentRef.getElementById('rnaAudioInput');
      audioOutputSelect = documentRef.getElementById('rnaAudioOutput');
      refreshAudioDevicesButton = documentRef.getElementById('rnaRefreshAudioDevices');
      audioDeviceStatus = documentRef.getElementById('rnaAudioDeviceStatus');
      neuralVoiceSelect = documentRef.getElementById('rnaNeuralVoice');
      voiceRateSelect = documentRef.getElementById('rnaVoiceRate');
    } catch (_) {}

    var AUDIO_INPUT_STORAGE_KEY = 'hivelogic-reina-audio-input-v1';
    var AUDIO_OUTPUT_STORAGE_KEY = 'hivelogic-reina-audio-output-v1';
    var NEURAL_VOICE_STORAGE_KEY = 'hivelogic-reina-neural-voice-v1';
    var VOICE_RATE_STORAGE_KEY = 'hivelogic-reina-voice-rate-v1';
    var PANEL_AUTO_CLOSE_MS = 20000;

    function storedAudioInput() {
      try {
        var value = root.localStorage && root.localStorage.getItem(AUDIO_INPUT_STORAGE_KEY);
        return safePrimitiveText(value, 512, true) ? value : '';
      } catch (_) { return ''; }
    }

    function saveAudioInput(value) {
      try {
        if (root.localStorage && isFunction(root.localStorage.setItem)) {
          root.localStorage.setItem(AUDIO_INPUT_STORAGE_KEY, safePrimitiveText(value, 512, true) ? value : '');
        }
      } catch (_) {}
    }

    function storedSetting(key, fallback, allowed) {
      try {
        var value = root.localStorage && root.localStorage.getItem(key);
        return allowed.indexOf(value) >= 0 ? value : fallback;
      } catch (_) { return fallback; }
    }

    function saveSetting(key, value) {
      try { if (root.localStorage && isFunction(root.localStorage.setItem)) root.localStorage.setItem(key, value); } catch (_) {}
    }

    function selectedNeuralVoice() {
      var value = '';
      try { value = neuralVoiceSelect ? neuralVoiceSelect.value : ''; } catch (_) {}
      return ['marin', 'coral', 'nova', 'shimmer', 'sage'].indexOf(value) >= 0 ? value : 'marin';
    }

    function selectedVoiceRate() {
      var value = '';
      try { value = voiceRateSelect ? voiceRateSelect.value : ''; } catch (_) {}
      return VOICE_RATES.indexOf(value) >= 0 ? Number(value) : 0.96;
    }

    function selectedAudioOutput() {
      try { return audioOutputSelect && safePrimitiveText(audioOutputSelect.value, 512, true) ? audioOutputSelect.value : ''; } catch (_) { return ''; }
    }

    function replaceDeviceOptions(select, devices, fallbackLabel, selectedValue) {
      if (!select || !Array.isArray(devices)) return;
      try {
        text(select, '');
        var fallback = documentRef.createElement('option');
        fallback.value = '';
        text(fallback, fallbackLabel);
        select.appendChild(fallback);
        for (var i = 0; i < devices.length; i += 1) {
          var device = devices[i];
          if (!device || !safePrimitiveText(device.deviceId, 512, false)) continue;
          var option = documentRef.createElement('option');
          option.value = device.deviceId;
          text(option, safePrimitiveText(device.label, 200, false) ? device.label : fallbackLabel + ' ' + (i + 1));
          select.appendChild(option);
        }
        select.value = selectedValue || '';
      } catch (_) {}
    }

    function refreshAudioDevices(requestPermission) {
      var mediaDevices;
      try { mediaDevices = root.navigator && root.navigator.mediaDevices; } catch (_) { mediaDevices = null; }
      if (!mediaDevices || !isFunction(mediaDevices.enumerateDevices)) {
        if (audioDeviceStatus) text(audioDeviceStatus, 'This browser cannot list audio devices. System defaults will be used.');
        return Promise.resolve(false);
      }
      if (audioDeviceStatus) text(audioDeviceStatus, 'Checking available audio devicesâ€¦');
      return Promise.resolve().then(function () { return mediaDevices.enumerateDevices(); }).then(function (devices) {
        var inputs = [];
        var outputs = [];
        for (var i = 0; i < devices.length; i += 1) {
          if (devices[i] && devices[i].kind === 'audioinput') inputs.push(devices[i]);
          else if (devices[i] && devices[i].kind === 'audiooutput') outputs.push(devices[i]);
        }
        replaceDeviceOptions(audioInputSelect, inputs, 'System default microphone', storedAudioInput());
        replaceDeviceOptions(audioOutputSelect, outputs, 'System default speaker', storedSetting(AUDIO_OUTPUT_STORAGE_KEY, '', outputs.map(function (item) { return item.deviceId; }).concat([''])));
        if (audioDeviceStatus) text(audioDeviceStatus, inputs.length
          ? inputs.length + ' microphone' + (inputs.length === 1 ? '' : 's') + ' available. Reina will use the selected input.'
          : 'No microphone was found.');
        return inputs.length > 0;
      }, function (error) {
        if (audioDeviceStatus) text(audioDeviceStatus, error && error.name === 'NotAllowedError'
          ? 'Microphone access is blocked. Allow it in Chrome, then refresh devices.'
          : 'Audio devices could not be loaded. System defaults will be used.');
        return false;
      });
    }

    // Every label is an instruction, and the same word never means two things.
    // "Stop Reina" stops Reina; "click to stop" stops listening. Nothing here
    // asks the reader to work out which of those a toggle is currently in.
    var VOICE_BUTTON = Object.freeze({
      off: { label: 'HOLD', hint: 'Hold to talk · release to send', title: 'Hold to talk, release to send', cls: '', live: '' },
      listening: { label: 'TALKING', hint: 'Release to send', title: 'Release to send', cls: 'listening', live: 'Recording' },
      thinking: { label: 'WAIT', hint: 'Reina is thinking…', title: 'Reina is working on what you said', cls: 'thinking', live: 'Thinking' },
      speaking: { label: 'STOP', hint: 'Reina is speaking · press to stop her', title: 'Press to stop Reina speaking', cls: 'speaking', live: 'Reina is speaking' },
    });

    function renderVoiceButton() {
      if (!topVoiceToggle) return;
      var shape = Object.prototype.hasOwnProperty.call(VOICE_BUTTON, voicePhase)
        ? VOICE_BUTTON[voicePhase] : VOICE_BUTTON.off;
      try {
        text(topVoiceLabel || topVoiceToggle, shape.label);
        topVoiceToggle.setAttribute('title', shape.title);
        // Pressed means VOICE IS ON, not "a phase is currently active". Voice
        // can be on while nothing is being captured yet, and a screen reader
        // should hear the toggle's real state rather than the momentary phase.
        topVoiceToggle.setAttribute('aria-pressed', voiceEnabled === true ? 'true' : 'false');
        for (var name in VOICE_BUTTON) {
          if (!Object.prototype.hasOwnProperty.call(VOICE_BUTTON, name)) continue;
          if (VOICE_BUTTON[name].cls) removeClass(topVoiceToggle, VOICE_BUTTON[name].cls);
        }
        if (shape.cls) addClass(topVoiceToggle, shape.cls);
        // The stage carries the glow and the waveform, the way Chirp's does.
        if (voiceStage) {
          for (var stageName in VOICE_BUTTON) {
            if (!Object.prototype.hasOwnProperty.call(VOICE_BUTTON, stageName)) continue;
            if (VOICE_BUTTON[stageName].cls) removeClass(voiceStage, VOICE_BUTTON[stageName].cls);
          }
          if (shape.cls) addClass(voiceStage, shape.cls);
        }
        if (voiceHint) text(voiceHint, shape.hint);
        // Thinking is the one phase where clicking does nothing useful, so the
        // button says so instead of silently ignoring the press.
        setDisabled(topVoiceToggle, voicePhase === 'thinking');
        if (topVoiceLive) text(topVoiceLive, shape.live);
      } catch (_) {}
    }

    function setVoicePhase(phase) {
      voicePhase = Object.prototype.hasOwnProperty.call(VOICE_BUTTON, phase) ? phase : 'off';
      renderVoiceButton();
    }

    function renderTopVoiceToggle(enabled) {
      if (!topVoiceToggle) return;
      try {
        // Switching voice ON must NOT claim we are listening. The microphone
        // may not have opened yet, and a button that says "Listening" before
        // anything is being captured is the exact lie that made a dead mic
        // look like a working one. Only the real state machine moves this to
        // 'listening'; here we just repaint.
        if (enabled !== true) setVoicePhase('off');
        else renderVoiceButton();
        if (settingsVoiceToggle) {
          settingsVoiceToggle.setAttribute('aria-pressed', enabled === true ? 'true' : 'false');
          text(settingsVoiceToggle, enabled === true ? 'Voice On' : 'Voice Off');
        }
        // Voice being switched off entirely is a reliable "definitely not
        // listening right now" signal, independent of whatever the state
        // machine's own per-turn render.status callback last said -- belt and
        // suspenders against the indicator getting stuck on across a forced
        // stop (emergencyVoiceOff/stopVoice both call this with false without
        // necessarily routing through render.status first).
        if (enabled !== true) renderListeningIndicator(false);
      } catch (_) {}
    }

    // Chris asked for a visible sign of when Reina's mic is actually hot --
    // previously the real listening/thinking/speaking state (reina-voice-
    // session.js) only ever reached a detached DOM node (view.voiceStatus)
    // that is deliberately never inserted into the visible popup (see the
    // "keep the popup conversation surface intentionally quiet" comment in
    // buildView() below). This renders the SAME live signal onto a small
    // header badge instead of adding any new state.
    function renderListeningIndicator(active) {
      if (active === true) { setVoicePhase('listening'); return; }
      if (voicePhase === 'listening') setVoicePhase(voiceEnabled ? 'off' : 'off');
    }

    function clearPanelAutoClose() {
      if (!panelAutoCloseTimer) return;
      try { clearHostTimeout(panelAutoCloseTimer); } catch (_) {}
      panelAutoCloseTimer = null;
    }

    function panelIsOpen() {
      try { return page.panel.classList.contains('open'); } catch (_) { return false; }
    }

    function armPanelAutoClose() {
      clearPanelAutoClose();
      if (disposed || state !== 'ready' || voiceEnabled || !panelIsOpen()) return;
      panelAutoCloseTimer = setHostTimeout(function () {
        panelAutoCloseTimer = null;
        if (disposed || state !== 'ready' || voiceEnabled || !panelIsOpen()) return;
        setSettingsOpen(false);
        setPanelOpen(false);
      }, PANEL_AUTO_CLOSE_MS);
      try {
        if (panelAutoCloseTimer && isFunction(panelAutoCloseTimer.unref)) panelAutoCloseTimer.unref();
      } catch (_) {}
    }

    function notePanelActivity() {
      if (panelAutoCloseTimer || (state === 'ready' && !voiceEnabled && panelIsOpen())) armPanelAutoClose();
    }

    function nodeWithin(container, target) {
      var cursor = target;
      for (var depth = 0; cursor && depth < 50; depth += 1) {
        if (cursor === container) return true;
        try { cursor = cursor.parentNode; } catch (_) { return false; }
      }
      return false;
    }

    function settingsAreOpen() {
      try { return !!popupSettingsPanel && popupSettingsPanel.classList.contains('open'); } catch (_) { return false; }
    }

    function dismissSettingsOutside(event) {
      if (!settingsAreOpen()) return;
      var target = event && event.target;
      if (target === popupSettings || nodeWithin(popupSettingsPanel, target)) return;
      setSettingsOpen(false);
    }

    function setPanelOpen(open) {
      clearPanelAutoClose();
      try {
        if (open) addClass(page.panel, 'open');
        else removeClass(page.panel, 'open');
        page.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      } catch (_) {}
      if (!open) setSettingsOpen(false);
    }

    function setSettingsOpen(open) {
      if (!popupSettingsPanel) return;
      try {
        if (open) addClass(popupSettingsPanel, 'open');
        else removeClass(popupSettingsPanel, 'open');
        popupSettingsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (popupSettings) popupSettings.setAttribute('aria-expanded', open ? 'true' : 'false');
      } catch (_) {}
      if (open) refreshAudioDevices(false);
    }

    function installPopupGeometry() {
      if (!popupHead || !page.panel || !isFunction(documentRef.addEventListener)) return;
      var interaction = null;
      function viewportWidth() { return typeof root.innerWidth === 'number' ? root.innerWidth : 1440; }
      function viewportHeight() { return typeof root.innerHeight === 'number' ? root.innerHeight : 900; }
      function start(kind, direction, event) {
        if (!event || event.isTrusted !== true || viewportWidth() <= 760) return;
        try {
          if (event.target && isFunction(event.target.closest)
            && event.target.closest('button,a,input,select,textarea')) return;
          var rect = page.panel.getBoundingClientRect();
          interaction = { kind: kind, direction: direction || '', x: event.clientX, y: event.clientY,
            left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          addClass(page.panel, 'dragging');
          if (isFunction(event.preventDefault)) event.preventDefault();
        } catch (_) { interaction = null; }
      }
      bind(popupHead, 'pointerdown', function (event) { start('move', '', event); });
      try {
        var handles = documentRef.querySelectorAll('[data-rna-resize]');
        for (var i = 0; i < handles.length; i += 1) {
          (function (handle) {
            bind(handle, 'pointerdown', function (event) {
              var direction = '';
              try { direction = handle.getAttribute('data-rna-resize') || ''; } catch (_) {}
              start('resize', direction, event);
            });
          })(handles[i]);
        }
      } catch (_) {}
      bind(documentRef, 'pointermove', function (event) {
        if (!interaction || !event) return;
        var dx = event.clientX - interaction.x;
        var dy = event.clientY - interaction.y;
        var left = interaction.left;
        var top = interaction.top;
        var width = interaction.width;
        var height = interaction.height;
        if (interaction.kind === 'move') { left += dx; top += dy; }
        else {
          if (interaction.direction.indexOf('e') >= 0) width += dx;
          if (interaction.direction.indexOf('s') >= 0) height += dy;
          if (interaction.direction.indexOf('w') >= 0) { width -= dx; left += dx; }
          if (interaction.direction.indexOf('n') >= 0) { height -= dy; top += dy; }
        }
        width = Math.max(340, Math.min(width, viewportWidth() - 16));
        height = Math.max(420, Math.min(height, viewportHeight() - 16));
        left = Math.max(8, Math.min(left, viewportWidth() - width - 8));
        top = Math.max(8, Math.min(top, viewportHeight() - height - 8));
        try {
          page.panel.style.left = left + 'px'; page.panel.style.top = top + 'px';
          page.panel.style.right = 'auto'; page.panel.style.bottom = 'auto';
          page.panel.style.width = width + 'px'; page.panel.style.height = height + 'px';
        } catch (_) {}
      });
      function finishGeometry() { interaction = null; removeClass(page.panel, 'dragging'); }
      bind(documentRef, 'pointerup', finishGeometry);
      bind(documentRef, 'pointercancel', finishGeometry);
    }

    hidePage(page);

    function snapshot(reason) {
      return Object.freeze({
        state: state,
        sessionId: sessionId,
        mounted: mounted,
        disposed: disposed,
        voiceEnabled: voiceEnabled,
        handsFreeEnabled: handsFreeEnabled,
        reviewAvailable: pendingReview !== null,
        executed: false,
        reason: typeof reason === 'string' ? reason : null,
      });
    }

    function emitState(reason) {
      var current = snapshot(reason);
      try { onState(current); } catch (_) { /* observers have no authority */ }
      return current;
    }

    function makeElement(tagName, className, initialText) {
      var node = documentRef.createElement(tagName);
      fixedClass(node, className);
      if (typeof initialText === 'string') text(node, initialText);
      return node;
    }

    function buildView() {
      if (view) return;
      try {
        text(page.feed, '');
        var notice = makeElement('p', 'rnaM q reina-pilot-notice', 'REINA · READ ONLY');
        var greeting = makeElement('p', 'rnaM q reina-pilot-greeting');
        var attention = makeElement('p', 'rnaM q reina-pilot-attention');
        var categories = makeElement('ul', 'rnaM q reina-pilot-categories');
        var disclosures = makeElement('ul', 'rnaM q reina-pilot-disclosures');
        var reviewQuestion = makeElement('p', 'rnaM q reina-pilot-review-question');
        var reviewControls = makeElement('div', 'rnaChips reina-pilot-review-controls');
        var reviewButton = makeElement('button', 'reina-pilot-review-button', 'Review items');
        reviewButton.type = 'button';
        reviewControls.appendChild(reviewButton);
        var messages = makeElement('div', 'reina-pilot-messages');
        var voiceControls = makeElement('div', 'rnaChips reina-pilot-voice-controls');
        var voiceStart = makeElement('button', 'reina-pilot-voice-start', 'Enable Hands-free');
        var voiceStop = makeElement('button', 'reina-pilot-voice-stop', 'Stop Voice');
        var voiceOff = makeElement('button', 'reina-pilot-voice-off', 'Emergency OFF');
        voiceStart.type = voiceStop.type = voiceOff.type = 'button';
        voiceControls.appendChild(voiceStart);
        voiceControls.appendChild(voiceStop);
        voiceControls.appendChild(voiceOff);
        var voiceStatus = makeElement('p', 'rnaM q reina-pilot-voice-status', 'Voice is off.');
        var voiceInterim = makeElement('p', 'rnaM u reina-pilot-voice-interim');
        var voiceConfirm = makeElement('p', 'rnaM q reina-pilot-voice-confirm');
        var voiceError = makeElement('p', 'rnaM q reina-pilot-voice-error');
        var status = makeElement('p', 'rnaM q reina-pilot-status');
        var error = makeElement('p', 'rnaM q reina-pilot-error');
        // Keep the popup conversation surface intentionally quiet. The header
        // owns mode, voice, history, and settings. The feed owns only the
        // user's transcript, Reina's answer, and a real error when one occurs.
        // The briefing/review nodes remain detached so the state machine can
        // retain its verified data without flooding this small conversation UI.
        page.feed.appendChild(messages);
        page.feed.appendChild(voiceError);
        page.feed.appendChild(error);
        view = Object.freeze({
          notice: notice, greeting: greeting, attention: attention,
          categories: categories, disclosures: disclosures, messages: messages,
          reviewQuestion: reviewQuestion, reviewControls: reviewControls, reviewButton: reviewButton,
          voiceControls: voiceControls, voiceStart: voiceStart, voiceStop: voiceStop, voiceOff: voiceOff,
          voiceStatus: voiceStatus, voiceInterim: voiceInterim,
          voiceConfirm: voiceConfirm, voiceError: voiceError,
          status: status, error: error,
        });
        setDisplay(reviewControls, 'none');
        setDisabled(reviewButton, true);
        setDisabled(voiceStart, true);
        setDisabled(voiceStop, true);
        setDisabled(voiceOff, true);
      } catch (_) {
        view = null;
        throw new Error('createReinaPilotHost: panel construction failed');
      }
    }

    function bind(node, eventName, handler) {
      if (!node || !isFunction(node.addEventListener)) return;
      node.addEventListener(eventName, handler);
      listeners.push({ node: node, eventName: eventName, handler: handler, property: false });
    }

    function bindOwnedClick(node, handler) {
      try {
        node.onclick = handler;
        listeners.push({ node: node, eventName: 'onclick', handler: handler, property: true });
      } catch (_) {
        bind(node, 'click', handler);
      }
    }

    function enableInput(enabled) {
      setDisabled(page.input, !enabled);
      setDisabled(page.send, !enabled);
    }

    function normalInput(enabled) {
      text(page.send, sendIdleText);
      setTitle(page.send, '');
      enableInput(enabled);
    }

    // Bug fix (2026-08-13, jomell's screenshot): #rnaSend is a fixed 40x40
    // circle sized for a single glyph (normally "➤"). Setting its content
    // to the literal word "Retry" overflowed that fixed box -- flex items get
    // an implicit content-based minimum width unless overridden, so the button
    // rendered as an oversized pill overlapping the rest of the input bar
    // instead of the small circle it's meant to be. A matching short glyph
    // keeps the circle the same size in both states; the title gives it a
    // readable label on hover.
    function retryInput() {
      setDisabled(page.input, true);
      setDisabled(page.send, false);
      text(page.send, '↻');
      setTitle(page.send, 'Retry');
    }

    function showVerifiedPanel() {
      setDisplay(page.fab, 'flex');
      // A new authenticated briefing must open at its verified greeting, not at
      // the scroll position left by an earlier conversation or disclosure list.
      try { page.feed.scrollTop = 0; } catch (_) {}
      text(page.mode, 'reina · read only');
      addClass(page.mode, 'live');
      normalInput(true);
    }

    function clearPresentation() {
      if (!view) return;
      text(view.greeting, '');
      text(view.attention, '');
      text(view.categories, '');
      text(view.disclosures, '');
      text(view.reviewQuestion, '');
      setDisplay(view.reviewControls, 'none');
      setDisabled(view.reviewButton, true);
      text(view.messages, '');
      text(view.voiceStatus, 'Voice is off.');
      text(view.voiceInterim, '');
      text(view.voiceConfirm, '');
      text(view.voiceError, '');
      setDisabled(view.voiceStart, true);
      setDisabled(view.voiceStop, true);
      setDisabled(view.voiceOff, true);
      text(view.status, '');
      text(view.error, '');
      try { page.input.value = ''; } catch (_) { /* inert */ }
      hidePage(page);
      text(page.send, sendIdleText);
      renderedTurns = Object.create(null);
      retrying = false;
    }

    function appendList(target, values) {
      text(target, '');
      for (var i = 0; i < values.length; i += 1) {
        var item = makeElement('li', 'reina-pilot-list-item', values[i]);
        target.appendChild(item);
      }
    }

    function scrollConversationToLatest() {
      try {
        var height = Number(page.feed.scrollHeight);
        page.feed.scrollTop = Number.isFinite(height) && height >= 0 ? height : 1000000;
      } catch (_) { /* presentation only */ }
    }

    function appendMessage(role, message) {
      if (!view || !safePrimitiveText(message, MAX_RENDER_TEXT, false)) return false;
      try {
        if (role === 'user') {
          text(view.voiceError, '');
          text(view.error, '');
        }
        var row = makeElement('div', role === 'user' ? 'rnaM u' : 'rnaM q');
        var label = makeElement('span', 'reina-pilot-message-label', role === 'user' ? 'You: ' : 'Reina: ');
        var body = makeElement('span', 'reina-pilot-message-body', message);
        row.appendChild(label);
        row.appendChild(body);
        view.messages.appendChild(row);
        scrollConversationToLatest();
        return true;
      } catch (_) {
        return false;
      }
    }

    function appendAssistantMessage(answer, details) {
      if (!view || !safePrimitiveText(answer, MAX_RENDER_TEXT, false)) return false;
      try {
        var row = makeElement('div', 'rnaM q');
        var label = makeElement('span', 'reina-pilot-message-label', 'Reina: ');
        var body = makeElement('span', 'reina-pilot-message-body', answer);
        row.appendChild(label);
        row.appendChild(body);
        // Evidence remains in the server-owned response and durable history,
        // but is not repeated inside the compact voice popup.
        view.messages.appendChild(row);
        scrollConversationToLatest();
        return true;
      } catch (_) {
        return false;
      }
    }

    function trustedGesture(event) {
      try { return event !== null && typeof event === 'object' && event.isTrusted === true; } catch (_) { return false; }
    }

    function emptyOwnDataObject(value) {
      return readExactDataObject(value, []) !== null;
    }

    function reviewSnapshot(bootstrap, expectedEpoch) {
      var reviewValue = ownData(bootstrap, 'review');
      var intentValue = ownData(bootstrap, 'uiIntent');
      var review = reviewValue.ok
        ? readExactDataObject(reviewValue.value, ['intentId', 'available', 'expiresAt']) : null;
      var intent = intentValue.ok ? readExactDataObject(intentValue.value, [
        'version', 'executed', 'requiresConfirmation', 'conversationId', 'turnId',
        'intentId', 'expiresAt', 'kind', 'destination', 'parameters',
      ]) : null;
      if (!review || !intent || review.available !== true
        || !safePrimitiveText(review.intentId, 200, false)
        || !safePrimitiveText(review.expiresAt, 64, false)
        || intent.version !== REVIEW_INTENT_VERSION || intent.executed !== false
        || intent.requiresConfirmation !== true || intent.conversationId !== sessionId
        || !safePrimitiveText(intent.turnId, 200, false)
        || intent.intentId !== review.intentId || intent.expiresAt !== review.expiresAt
        || intent.kind !== 'navigate' || intent.destination !== REVIEW_DESTINATION
        || !emptyOwnDataObject(intent.parameters)) return null;
      return Object.freeze({
        epoch: expectedEpoch, sessionId: sessionId, turnId: intent.turnId,
        intentId: intent.intentId, kind: intent.kind,
        destination: intent.destination, expiresAt: intent.expiresAt,
        uiIntent: intentValue.value,
      });
    }

    function reviewStillCurrent(candidate) {
      return !disposed && candidate && candidate === pendingReview
        && candidate.epoch === epoch && candidate.sessionId === sessionId;
    }

    function revokeReview(reason, declineLogin) {
      confirmationGrant = null;
      var previousRouter = intentRouter;
      pendingReview = null;
      if (previousRouter && isFunction(previousRouter.revoke)) {
        try { previousRouter.revoke(typeof reason === 'string' ? reason : 'revoked'); } catch (_) {}
      }
      if (declineLogin === true && loginBrief && isFunction(loginBrief.decline)) {
        try { loginBrief.decline('new_turn'); } catch (_) {}
      }
      if (view) {
        text(view.reviewQuestion, '');
        setDisplay(view.reviewControls, 'none');
        setDisabled(view.reviewButton, true);
      }
    }

    function fixedReviewAllow(candidate) {
      var exact = readExactDataObject(candidate, ['kind', 'destination', 'parameters', 'intentId']);
      return !!(exact && pendingReview && reviewStillCurrent(pendingReview)
        && exact.kind === pendingReview.kind
        && exact.destination === pendingReview.destination
        && exact.intentId === pendingReview.intentId
        && emptyOwnDataObject(exact.parameters));
    }

    function applyStandupNavigation(destination, parameters) {
      var grant = confirmationGrant;
      if (!grant || grant.used !== true || !reviewStillCurrent(grant.review)
        || destination !== REVIEW_DESTINATION || !emptyOwnDataObject(parameters)
        || !isFunction(showView) || !isFunction(go)) return false;
      try {
        showView('');
        go(REVIEW_DESTINATION);
        var target = documentRef.getElementById(REVIEW_DESTINATION);
        return !!(target && target.style && target.style.display === 'block');
      } catch (_) {
        return false;
      }
    }

    function registerReviewIntent(bootstrap, expectedEpoch) {
      var expected = reviewSnapshot(bootstrap, expectedEpoch);
      if (!expected) return false;
      var frozenHandlers = Object.freeze({ navigate: applyStandupNavigation });
      var frozenParams = Object.freeze({});
      var frozenDestinationList = Object.freeze([REVIEW_DESTINATION]);
      var frozenAllowlist = Object.freeze({
        navigate: Object.freeze({ destinations: frozenDestinationList, params: frozenParams }),
      });
      var created;
      pendingReview = expected;
      try {
        created = createIntentRouter(Object.freeze({
          conversationId: sessionId,
          handlers: frozenHandlers,
          allowlist: frozenAllowlist,
          allow: fixedReviewAllow,
          navigationTimeoutMs: 1000,
        }));
      } catch (_) {
        pendingReview = null;
        return false;
      }
      if (!created || !isFunction(created.propose) || !isFunction(created.confirm)
        || !isFunction(created.revoke) || !isFunction(created.dispose)) {
        pendingReview = null;
        return false;
      }
      var proposal;
      try {
        proposal = created.propose(Object.freeze({ uiIntent: expected.uiIntent }), Object.freeze({
          turnId: expected.turnId,
          suppressConfirmRequest: true,
        }));
      } catch (_) { proposal = null; }
      if (!proposal || proposal.accepted !== true) {
        pendingReview = null;
        try { created.dispose(); } catch (_) {}
        return false;
      }
      intentRouter = created;
      return true;
    }

    function strictReviewConfirmation(intentId) {
      var grant = confirmationGrant;
      if (!grant || grant.used === true || !reviewStillCurrent(grant.review)
        || intentId !== grant.review.intentId || !intentRouter || !client
        || !isFunction(client.confirmReviewIntent)) {
        confirmationGrant = null;
        return Promise.resolve({ ok: false, reason: 'stale_intent' });
      }
      grant.used = true;
      var serverResult;
      try { serverResult = client.confirmReviewIntent(intentId); } catch (error) {
        serverResult = Promise.reject(error);
      }
      return Promise.resolve(serverResult).then(function (serverValue) {
        var serverExact = readExactDataObject(serverValue, ['ok', 'intentId', 'executed']);
        var current = confirmationGrant === grant && reviewStillCurrent(grant.review);
        if (!current) {
          if (confirmationGrant === grant) confirmationGrant = null;
          return { ok: false, reason: 'stale_intent' };
        }
        if (!serverExact || serverExact.ok !== true
          || serverExact.intentId !== grant.review.intentId || serverExact.executed !== false) {
          var denied = readExactDataObject(serverValue, ['ok', 'reason']);
          confirmationGrant = null;
          if (denied && denied.ok === false
            && (denied.reason === 'duplicate' || denied.reason === 'expired'
              || denied.reason === 'stale_intent')) {
            return { ok: false, reason: 'stale_intent' };
          }
          return { ok: false, reason: 'navigation_failed' };
        }

        var result;
        try { result = intentRouter.confirm(intentId, grant.origin); } catch (_) { result = null; }
        return Promise.resolve(result).then(function (value) {
          var exact = readExactDataObject(value, ['executed', 'intentId', 'kind', 'destination', 'source']);
          var stillCurrent = confirmationGrant === grant && reviewStillCurrent(grant.review);
          confirmationGrant = null;
          if (!stillCurrent || !exact || exact.executed !== true
            || exact.intentId !== grant.review.intentId
            || exact.kind !== grant.review.kind
            || exact.destination !== grant.review.destination
            || exact.source !== grant.origin) {
            return { ok: false, reason: stillCurrent ? 'navigation_failed' : 'stale_intent' };
          }
          pendingReview = null;
          if (view) {
            text(view.reviewQuestion, '');
            setDisplay(view.reviewControls, 'none');
            setDisabled(view.reviewButton, true);
          }
          return { ok: true };
        }, function () {
          if (confirmationGrant === grant) confirmationGrant = null;
          return { ok: false, reason: 'navigation_failed' };
        });
      }, function (error) {
        var failure = error && error.code === 'auth_expired'
          ? 'authorization_expired' : 'navigation_failed';
        if (confirmationGrant === grant) confirmationGrant = null;
        return { ok: false, reason: failure };
      });
    }

    function beginReviewConfirmation(origin) {
      if ((origin !== 'button' && origin !== 'voice') || !pendingReview
        || !reviewStillCurrent(pendingReview) || !loginBrief || confirmationGrant) {
        return Promise.resolve({ accepted: false, reason: 'review_unavailable' });
      }
      var grant = { origin: origin, review: pendingReview, used: false };
      confirmationGrant = grant;
      var work;
      try { work = loginBrief.confirmReview(origin); } catch (_) { work = null; }
      return Promise.resolve(work).then(function (result) {
        if (confirmationGrant === grant) confirmationGrant = null;
        return result;
      }, function () {
        if (confirmationGrant === grant) confirmationGrant = null;
        return { accepted: false, reason: 'navigation_failed' };
      });
    }

    function voiceControlsSnapshot(controlState) {
      if (!view) return;
      var canStart = ownData(controlState, 'canStart');
      var canStop = ownData(controlState, 'canStop');
      var off = ownData(controlState, 'off');
      setDisabled(view.voiceStart, emergencyOff || !voiceHost || (!handsFreeEnabled && (!canStart.ok || canStart.value !== true)));
      setDisabled(view.voiceStop, !voiceHost || !canStop.ok || canStop.value !== true);
      setDisabled(view.voiceOff, emergencyOff || !voiceHost);
      setDisabled(topVoiceToggle, emergencyOff || !voiceHost || (!handsFreeEnabled && (!canStart.ok || canStart.value !== true)));
      setDisabled(settingsVoiceToggle, emergencyOff || !voiceHost || (!handsFreeEnabled && (!canStart.ok || canStart.value !== true)));
      if (off.ok && off.value === true) text(view.voiceStatus, 'Voice emergency OFF is active.');
    }

    function stopVoice(reason) {
      voiceEnabled = false;
      handsFreeEnabled = false;
      directListening = false;
      renderTopVoiceToggle(false);
      if (handsFreeRearmTimer) {
        try { clearTimeout(handsFreeRearmTimer); } catch (_) {}
        handsFreeRearmTimer = null;
      }
      if (reason === 'hands_free_disabled' && CAPTURED_NATIVE_WAKE
        && isFunction(CAPTURED_NATIVE_WAKE.disableWakeWord)) {
        try { Promise.resolve(CAPTURED_NATIVE_WAKE.disableWakeWord()).catch(function () {}); } catch (_) {}
      }
      if (voiceHost) {
        try { if (isFunction(voiceHost.interrupt)) voiceHost.interrupt(); } catch (_) {}
        try { if (isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
      }
      if (view) {
        text(view.voiceInterim, '');
        text(view.voiceConfirm, '');
        if (!emergencyOff) text(view.voiceStatus, 'Voice is off.');
      }
      emitState(reason || 'voice_stopped');
    }

    // Stop Voice finishes the bounded clip. Panel close, auth teardown, and
    // emergency off still use stopVoice()'s cancellation behavior.
    var holdingToTalk = false;

    // ---- the path that actually works ---------------------------------------
    // Proven standalone on /voice-lab.html and then rebuilt here, deliberately
    // small: construct the browser's recognizer, read the transcript, hand it
    // to the same submit a typed message uses. That is the whole thing.
    //
    // It replaces, for browsers, a five-module chain -- voice host, bridge,
    // session state machine, speech adapter, MediaRecorder plus an upload to
    // OpenAI -- which never produced a single usable transcript across a month
    // of attempts: measured peaks from 1 to 128 on four microphones, every one
    // answered with an empty string on an HTTP 200. Chrome transcribes the same
    // speaker, on the same microphone, in the same room, with none of it.
    //
    // The chain is still there and still runs where the browser has no
    // recognizer, so nothing is lost by preferring the part that works.
    var liveRecognizer = null;
    // Holding is the turn. Chrome's recogniser has its own opinions about when
    // to stop -- at the first pause, after a stretch of silence, at its own
    // internal limits -- and every one of them used to end the turn early and
    // send half a sentence. The button, not the recogniser, decides when a turn
    // is over.
    var liveHolding = false;
    var liveSubmitted = false;
    var liveFinalText = '';
    var liveInterimText = '';
    var liveRestarts = 0;
    var liveDeliverTimer = null;
    var LIVE_MAX_RESTARTS = 60;

    // ---- the spoken reply ----------------------------------------------------
    // The live path hands its transcript to the same submit a typed message
    // uses -- which is exactly why it works, and exactly why the first version
    // of it answered in text and said nothing at all. Speech is not a property
    // of the recogniser. It is what should happen to a reply that was ASKED FOR
    // out loud, and this flag is the one fact that carries that from the press
    // through to the answer.
    var spokenReplyPending = false;

    // Reina's voice used to be built halfway through installing the five-module
    // recognition chain, so if any part of that chain failed to load she also
    // lost the ability to SPEAK -- two unrelated capabilities tied to one
    // outcome. Playback needs a fetch, an Audio element and a token; nothing
    // else. Build it on its own, once, and let installVoice share it.
    function ensureVoiceSynthesis() {
      if (voiceSynthesis) return voiceSynthesis;
      if (!isFunction(CAPTURED_CREATE_NEURAL_SYNTHESIS) || !CAPTURED_FETCH || !CAPTURED_AUDIO
        || !CAPTURED_URL_METHODS || !isFunction(getAccessToken)) return null;
      var built;
      try {
        built = CAPTURED_CREATE_NEURAL_SYNTHESIS(Object.freeze({
          fetchFn: CAPTURED_FETCH,
          getAccessToken: getAccessToken,
          AudioCtor: CAPTURED_AUDIO,
          AbortControllerCtor: CAPTURED_ABORT_CONTROLLER,
          createObjectURL: CAPTURED_URL_METHODS.create,
          revokeObjectURL: CAPTURED_URL_METHODS.revoke,
          getVoice: selectedNeuralVoice,
          getRate: selectedVoiceRate,
          getOutputDevice: selectedAudioOutput,
        }));
      } catch (_) { built = null; }
      voiceSynthesis = built || null;
      return voiceSynthesis;
    }

    // Chrome will not play audio that arrives seconds after the gesture unless
    // the same player was started during it. The recorder path already primes
    // it from its trusted gesture; the hold button has to do the same or the
    // reply is fetched, decoded, and then silently refused at play().
    function unlockSpeechFromGesture() {
      var synthesis = ensureVoiceSynthesis();
      if (!synthesis || !isFunction(synthesis.unlock)) return;
      try { synthesis.unlock(); } catch (_) {}
    }

    function stopSpeaking() {
      if (voiceSynthesis && isFunction(voiceSynthesis.cancel)) {
        try { voiceSynthesis.cancel(); } catch (_) {}
      }
    }

    function speakReply(answer) {
      if (emergencyOff || disposed) return false;
      var spoken = typeof answer === 'string' ? answer.trim() : '';
      if (!spoken) return false;
      var synthesis = ensureVoiceSynthesis();
      if (!synthesis || !isFunction(synthesis.speak) || !isFunction(CAPTURED_CREATE_NEURAL_UTTERANCE)) {
        noteVoiceBlock('speech_unavailable');
        return false;
      }
      var utterance;
      try { utterance = CAPTURED_CREATE_NEURAL_UTTERANCE(spoken); } catch (_) { utterance = null; }
      if (!utterance) return false;
      // The button reads STOP only while sound is actually coming out, so
      // pressing it always does what it says. Until playback starts we are
      // still waiting, and the button still says WAIT.
      utterance.onstart = function () { setVoicePhase('speaking'); };
      utterance.onend = function () { if (voicePhase === 'speaking') setVoicePhase('off'); };
      utterance.onerror = function (event) {
        var code = event && typeof event.error === 'string' ? event.error : 'speech_failed';
        noteVoiceBlock('speech_' + code.replace(/[^a-z0-9_-]/gi, '_'));
        if (voicePhase === 'speaking' || voicePhase === 'thinking') setVoicePhase('off');
      };
      try { synthesis.speak(utterance); } catch (_) { return false; }
      return true;
    }

    // Called for every completed turn, spoken or typed. A turn that was asked
    // for out loud gets spoken back; any turn at all releases the button from
    // WAIT, which is what left it stuck reading "Reina is thinking..." after
    // she had already answered.
    function finishSpokenTurn(answer) {
      var wanted = spokenReplyPending;
      spokenReplyPending = false;
      if (wanted && speakReply(answer)) return;
      if (voicePhase === 'thinking') setVoicePhase('off');
    }

    function abandonSpokenTurn() {
      spokenReplyPending = false;
      stopSpeaking();
      if (voicePhase === 'thinking' || voicePhase === 'speaking') setVoicePhase('off');
    }

    function liveVoiceMessage(code) {
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        return 'Chrome is blocking the microphone for this site. Allow it in the padlock menu, then try again.';
      }
      if (code === 'network') return 'Chrome could not reach its speech service. Check the connection and try again.';
      if (code === 'no-speech') return 'I did not catch that. Hold the button and speak again.';
      if (code === 'audio-capture') return 'No microphone is available to Chrome right now.';
      return 'Voice could not complete that turn. Typed Reina still works.';
    }

    function liveTranscript() {
      return (liveFinalText + ' ' + liveInterimText).replace(/\s+/g, ' ').trim();
    }

    function clearLiveDeliverTimer() {
      if (!liveDeliverTimer) return;
      try { clearHostTimeout(liveDeliverTimer); } catch (_) {}
      liveDeliverTimer = null;
    }

    // Everything said during one hold, sent once, when the button comes up.
    function liveDeliver() {
      clearLiveDeliverTimer();
      if (liveSubmitted) return;
      liveSubmitted = true;
      liveHolding = false;
      var trimmed = liveTranscript();
      liveFinalText = '';
      liveInterimText = '';
      if (!trimmed) {
        if (voicePhase === 'listening') setVoicePhase('off');
        return;
      }
      setVoicePhase('thinking');
      // This turn was asked for out loud, so its answer is owed out loud.
      spokenReplyPending = true;
      var accepted;
      try { accepted = submitTyped(trimmed); } catch (_) { accepted = null; }
      if (!accepted || accepted.accepted !== true) abandonSpokenTurn();
    }

    function liveMakeRecognizer() {
      var recognizer;
      try { recognizer = new CAPTURED_SPEECH_RECOGNITION(); } catch (_) { return null; }
      try {
        recognizer.lang = 'en-US';
        recognizer.interimResults = true;
        // Non-continuous recognition ends at the first pause. Pausing mid
        // sentence while still holding the button is normal speech, not the
        // end of a turn.
        recognizer.continuous = true;
      } catch (_) {}
      recognizer.onresult = function (event) {
        var finals = '';
        var interim = '';
        try {
          // resultIndex, not zero: with continuous recognition the results list
          // grows, and re-reading it from the start duplicates every word.
          for (var i = event.resultIndex; i < event.results.length; i += 1) {
            var result = event.results[i];
            if (result.isFinal === true) finals += result[0].transcript;
            else interim += result[0].transcript;
          }
        } catch (_) { return; }
        if (finals) liveFinalText = (liveFinalText + ' ' + finals).replace(/\s+/g, ' ').trim();
        liveInterimText = interim;
        // Show the words as they land -- a person needs to see they are being
        // heard before the turn completes.
        var shown = liveTranscript();
        if (view && shown) text(view.voiceStatus, shown);
      };
      recognizer.onerror = function (event) {
        var code = event && typeof event.error === 'string' ? event.error : 'recognition-error';
        if (code === 'aborted') return;
        noteVoiceBlock('live_' + code.replace(/[^a-z0-9_-]/gi, '_'));
        // Silence is not a failure while the button is held. Chrome reports
        // 'no-speech' for a person who has not started talking yet, and ending
        // the turn there is exactly the impatience this control must not have.
        if (code === 'no-speech' && liveHolding) return;
        if (view) {
          text(view.voiceStatus, liveVoiceMessage(code));
          text(view.voiceError, liveVoiceMessage(code));
        }
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
          // Nothing will be captured, so there is nothing to deliver.
          liveHolding = false;
          liveSubmitted = true;
          liveFinalText = '';
          liveInterimText = '';
          clearLiveDeliverTimer();
          if (voicePhase === 'listening') setVoicePhase('off');
        }
      };
      recognizer.onend = function () {
        if (liveRecognizer === recognizer) liveRecognizer = null;
        // Chrome stopped listening. While the button is still down that is an
        // interruption, not the end of the turn: start again and keep every
        // word already collected.
        if (liveHolding && !liveSubmitted && !emergencyOff && !disposed
          && liveRestarts < LIVE_MAX_RESTARTS) {
          liveRestarts += 1;
          if (liveStartRecognizer()) return;
        }
        liveDeliver();
      };
      return recognizer;
    }

    function liveStartRecognizer() {
      var recognizer = liveMakeRecognizer();
      if (!recognizer) return false;
      try { recognizer.start(); } catch (_) { return false; }
      liveRecognizer = recognizer;
      return true;
    }

    // Hard stop: emergency off and a closed panel end a hold outright, with
    // nothing submitted.
    function liveAbort() {
      liveHolding = false;
      liveSubmitted = true;
      liveFinalText = '';
      liveInterimText = '';
      clearLiveDeliverTimer();
      var recognizer = liveRecognizer;
      liveRecognizer = null;
      if (!recognizer) return;
      try { recognizer.onend = null; recognizer.onresult = null; recognizer.onerror = null; } catch (_) {}
      try { recognizer.abort(); } catch (_) {}
    }

    function liveVoiceStart() {
      if (!CAPTURED_SPEECH_RECOGNITION || emergencyOff || disposed || state !== 'ready') return false;
      try {
        if (liveRecognizer) { liveRecognizer.onend = null; liveRecognizer.abort(); }
      } catch (_) {}
      clearLiveDeliverTimer();
      liveRecognizer = null;
      liveHolding = true;
      liveSubmitted = false;
      liveFinalText = '';
      liveInterimText = '';
      liveRestarts = 0;
      if (!liveStartRecognizer()) { liveHolding = false; return false; }
      setVoicePhase('listening');
      return true;
    }

    function liveVoiceStop() {
      if (!liveHolding) return;
      liveHolding = false;
      if (!liveRecognizer) { liveDeliver(); return; }
      try { liveRecognizer.stop(); } catch (_) { liveDeliver(); return; }
      // stop() normally finalises the last words and fires 'end', which
      // delivers. If it does not, the turn must not be lost with the button
      // stuck on TALKING.
      clearLiveDeliverTimer();
      liveDeliverTimer = setHostTimeout(function () {
        liveDeliverTimer = null;
        liveDeliver();
      }, 1500);
    }

    function beginHoldToTalk(event) {
      if (holdingToTalk) return;
      // While Reina is speaking the button says "Stop Reina", so pressing it
      // stops her rather than starting a recording over the top of her.
      if (voicePhase === 'speaking') {
        try { if (voiceHost && isFunction(voiceHost.interrupt)) voiceHost.interrupt(); } catch (_) {}
        stopSpeaking();
        spokenReplyPending = false;
        if (view) text(view.voiceStatus, 'Reina stopped speaking.');
        setVoicePhase('off');
        return;
      }
      if (voicePhase === 'thinking') return;
      holdingToTalk = true;
      // Synchronously, while the press is still trusted: anything later is
      // autoplay as far as Chrome is concerned, and the reply plays silently.
      unlockSpeechFromGesture();
      // The browser's own recognizer first. Only where it does not exist does
      // this fall back to the recorder-and-upload chain.
      if (liveVoiceStart()) return;
      // directStart: this is a deliberate press-and-hold, not a mode toggle,
      // so it must always begin a recording rather than switch voice off.
      enableVoiceFromGesture(event, false, true);
    }

    function endHoldToTalk() {
      if (!holdingToTalk) return;
      holdingToTalk = false;
      // liveRecognizer is briefly null between restarts; liveHolding is the
      // fact that matters, and it is what decides which path ends the turn.
      if (liveHolding) { liveVoiceStop(); return; }
      finishVoiceRecording();
    }

    function finishVoiceRecording() {
      if (!voiceHost || !isFunction(voiceHost.stop) || emergencyOff || disposed) return;
      handsFreeEnabled = false;
      try { voiceHost.stop(); } catch (_) { return; }
      if (view) text(view.voiceStatus, 'Finishing recording…');
      emitState('voice_finishing');
    }

    function emergencyVoiceOff() {
      if (emergencyOff) return { off: true, executed: false };
      emergencyOff = true;
      // Emergency off means silence, including a reply already being spoken
      // and a hold that is still open.
      liveAbort();
      abandonSpokenTurn();
      voiceEnabled = false;
      handsFreeEnabled = false;
      directListening = false;
      renderTopVoiceToggle(false);
      if (handsFreeRearmTimer) {
        try { clearTimeout(handsFreeRearmTimer); } catch (_) {}
        handsFreeRearmTimer = null;
      }
      if (voiceHost && isFunction(voiceHost.emergencyOff)) {
        try { voiceHost.emergencyOff(); } catch (_) {}
      }
      if (view) {
        text(view.voiceStatus, 'Voice emergency OFF is active.');
        text(view.voiceInterim, '');
        text(view.voiceConfirm, '');
        setDisabled(view.voiceStart, true);
        setDisabled(view.voiceStop, true);
        setDisabled(view.voiceOff, true);
      }
      emitState('voice_off');
      return { off: true, executed: false };
    }

    function exactVoiceEvent(meta) {
      var exact = readExactDataObject(meta, ['text', 'isFinal', 'eventId']);
      if (!exact || exact.isFinal !== true || !safePrimitiveText(exact.text, MAX_USER_TEXT, false)) return null;
      if (!((typeof exact.eventId === 'string' && safePrimitiveText(exact.eventId, 200, false))
        || (typeof exact.eventId === 'number' && Number.isFinite(exact.eventId)))) return null;
      var normalized = exact.text.trim();
      return normalized ? { text: normalized, eventId: exact.eventId } : null;
    }

    function wakeRemainder(textValue) {
      if (!safePrimitiveText(textValue, MAX_USER_TEXT, false)) return null;
      var match;
      try { match = textValue.match(WAKE_PHRASE_RE); } catch (_) { return null; }
      if (!match) return null;
      var remainder = typeof match[1] === 'string' ? match[1].trim() : '';
      return remainder.length <= MAX_USER_TEXT ? remainder : null;
    }

    function rearmHandsFree(delayMs) {
      if (!handsFreeEnabled || !voiceEnabled || emergencyOff || disposed || !voiceHost
        || !isFunction(voiceHost.startListening)) return;
      if (handsFreeRearmTimer) return;
      handsFreeRearmTimer = setTimeout(function () {
        handsFreeRearmTimer = null;
        if (!handsFreeEnabled || !voiceEnabled || emergencyOff || disposed) return;
        var started;
        try { started = voiceHost.startListening(); } catch (_) { started = false; }
        Promise.resolve(started).then(function (ok) {
          if (!ok || !view || !handsFreeEnabled) return;
          text(view.voiceStatus, 'Hands-free is on. Say “Hey Reina”.');
        }, function () {});
      }, typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 0);
    }

    function assessVoiceTranscript(meta) {
      var exact = exactVoiceEvent(meta);
      if (!exact || !voiceEnabled || emergencyOff || disposed) return { decision: 'reject' };
      if (handsFreeEnabled) {
        var remainder = wakeRemainder(exact.text);
        if (remainder === null) {
          if (view) text(view.voiceStatus, 'Hands-free is on. Say “Hey Reina”.');
          rearmHandsFree();
          return { decision: 'reject' };
        }
        if (!remainder) {
          if (view) text(view.voiceStatus, 'I heard “Hey Reina”. What can I help with?');
          exact.text = 'Hi Reina';
        } else {
          exact.text = remainder;
        }
      }
      if (!page.panel.classList.contains('open')) setPanelOpen(true);
      if (pendingReview && reviewStillCurrent(pendingReview) && loginBrief) {
        if (EXACT_REVIEW_YES_RE.test(exact.text)) {
          try { if (voiceHost && isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
          var generation = isFunction(loginBrief.getGeneration) ? loginBrief.getGeneration() : null;
          var grant = { origin: 'voice', review: pendingReview, used: false };
          confirmationGrant = grant;
          var work;
          try {
            work = loginBrief.submitVoiceConfirmation(Object.freeze({
              source: 'reina.voice.final', final: true, generation: generation,
              eventId: exact.eventId, text: exact.text,
            }));
          } catch (_) { work = null; }
          Promise.resolve(work).then(function () {
            if (confirmationGrant === grant) confirmationGrant = null;
          }, function () {
            if (confirmationGrant === grant) confirmationGrant = null;
          });
          return { decision: 'reject' };
        }
        if (EXACT_REVIEW_NO_RE.test(exact.text)) {
          try {
            loginBrief.submitVoiceConfirmation(Object.freeze({
              source: 'reina.voice.final', final: true,
              generation: isFunction(loginBrief.getGeneration) ? loginBrief.getGeneration() : null,
              eventId: exact.eventId, text: exact.text,
            }));
          } catch (_) {}
          revokeReview('declined', false);
          return { decision: 'reject' };
        }
      }
      revokeReview('turn_replaced', true);
      appendMessage('user', exact.text);
      state = 'submitting';
      normalInput(false);
      emitState(null);
      return handsFreeEnabled ? { decision: 'accept', text: exact.text } : { decision: 'accept' };
    }

    function enableVoiceFromGesture(event, automaticStart, directStart) {
      var authorizedStart = trustedGesture(event) || automaticStart === true;
      if (trustedGesture(event) && voiceEnabled && directStart !== true) {
        stopVoice('hands_free_disabled');
        return true;
      }
      if (!authorizedStart || disposed || state !== 'ready' || emergencyOff
        || !voiceHost || !isFunction(voiceHost.startListening)) {
        return noteVoiceBlock(!authorizedStart ? 'untrusted_gesture'
          : disposed ? 'host_disposed'
            : state !== 'ready' ? ('panel_state_' + state)
              : emergencyOff ? 'emergency_off'
                : !voiceHost ? 'voice_never_installed'
                  : 'no_start_listening');
      }
      // Unlock Chrome's audio playback while the trusted purple-button click
      // is still active. Reina's MP3 arrives later, after transcription and
      // reasoning, and reuses this exact authorized player.
      if (trustedGesture(event) && voiceSynthesis && isFunction(voiceSynthesis.unlock)) {
        try { voiceSynthesis.unlock(); } catch (_) {}
      }
      var started;
      try { started = voiceHost.startListening(); } catch (e3) { started = false; noteVoiceBlock('start_listening_threw:' + ((e3 && e3.message) || 'unknown')); }
      if (started && isFunction(started.then)) {
        Promise.resolve(started).then(function (value) {
          voiceEnabled = value === true && !disposed && state === 'ready' && !emergencyOff;
          if (!voiceEnabled) {
            noteVoiceBlock(value !== true ? 'recognition_refused_to_start'
              : disposed ? 'disposed_mid_start'
                : state !== 'ready' ? ('panel_state_' + state + '_mid_start')
                  : 'emergency_off_mid_start');
          }
          handsFreeEnabled = voiceEnabled && directStart !== true;
          directListening = voiceEnabled && directStart === true;
          renderTopVoiceToggle(voiceEnabled);
          if (voiceEnabled && loginBrief && isFunction(loginBrief.onVoiceEnabled)) {
            try { loginBrief.onVoiceEnabled(); } catch (_) { voiceEnabled = false; }
          }
          if (!voiceEnabled && value === true) {
            try { if (isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
          }
          if (view) text(view.voiceStatus, voiceEnabled
            ? (directListening ? 'I\'m listening.' : 'Hands-free is on. Say “Hey Reina”.')
            : 'Voice input is unavailable in this browser.');
          emitState(voiceEnabled ? 'voice_enabled' : 'voice_unavailable');
        }, function (err) {
          noteVoiceBlock('start_listening_rejected:' + ((err && err.message) || 'unknown'));
          voiceEnabled = false;
          handsFreeEnabled = false;
          directListening = false;
          renderTopVoiceToggle(false);
          if (view) text(view.voiceStatus, 'Voice input is unavailable in this browser.');
          emitState('voice_unavailable');
        });
        return true;
      }
      voiceEnabled = started === true;
      handsFreeEnabled = voiceEnabled && directStart !== true;
      directListening = voiceEnabled && directStart === true;
      renderTopVoiceToggle(voiceEnabled);
      if (voiceEnabled && loginBrief && isFunction(loginBrief.onVoiceEnabled)) {
        try { loginBrief.onVoiceEnabled(); } catch (_) { voiceEnabled = false; }
      }
      if (!voiceEnabled && started === true) {
        try { if (isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
        started = false;
      }
      if (view) text(view.voiceStatus, started === true
        ? (directListening ? 'I\'m listening.' : 'Hands-free is on. Say “Hey Reina”.')
        : 'Voice input is unavailable in this browser.');
      emitState(started === true ? 'voice_enabled' : 'voice_unavailable');
      return started === true;
    }

    function restartDirectListeningFromGesture(event) {
      if (!trustedGesture(event) || disposed || state !== 'ready' || emergencyOff
        || !voiceHost || !isFunction(voiceHost.interrupt)) return false;
      if (voiceSynthesis && isFunction(voiceSynthesis.unlock)) {
        try { voiceSynthesis.unlock(); } catch (_) {}
      }
      clearPanelAutoClose();
      handsFreeEnabled = false;
      directListening = true;
      voiceEnabled = true;
      renderTopVoiceToggle(true);
      if (view) {
        text(view.voiceError, '');
        text(view.voiceStatus, 'I\'m listening.');
      }
      emitState('voice_restarting');
      var restarted;
      try { restarted = voiceHost.interrupt(); } catch (_) { restarted = false; }
      Promise.resolve(restarted).then(function (ok) {
        if (ok !== false || disposed || emergencyOff) return;
        voiceEnabled = false;
        directListening = false;
        renderTopVoiceToggle(false);
        if (view) text(view.voiceStatus, 'Voice input is unavailable in this browser.');
        emitState('voice_unavailable');
      }, function () {
        if (disposed || emergencyOff) return;
        voiceEnabled = false;
        directListening = false;
        renderTopVoiceToggle(false);
        if (view) text(view.voiceStatus, 'Voice input is unavailable in this browser.');
        emitState('voice_unavailable');
      });
      return true;
    }

    function installVoice(expectedEpoch, expectedClient) {
      if (!isFunction(loadVoiceModules) || voiceLoad) return;
      var pending;
      try { pending = loadVoiceModules(); } catch (_) { pending = null; }
      voiceLoad = Promise.resolve(pending).then(function (modules) {
        if (disposed || expectedEpoch !== epoch || expectedClient !== client || !sessionId) {
          // No sessionId is the one that took Voice down when the login brief
          // rejected the route's bootstrap: no accepted bootstrap, no session,
          // and Voice silently never installs.
          return noteVoiceBlock(!sessionId ? 'no_session_id' : 'stale_client_or_epoch');
        }
        var exact = readExactDataObject(modules, ['createVoiceHost', 'createVoiceTransport', 'createControlledRecognitionFactory']);
        if (!exact || !isFunction(exact.createVoiceHost) || !isFunction(exact.createVoiceTransport)
          || !isFunction(exact.createControlledRecognitionFactory) || !isFunction(client.voiceServerTransport)
          || !isFunction(client.transcribeVoiceAudio)) {
          return noteVoiceBlock(!exact ? 'voice_modules_missing'
            : !isFunction(client.transcribeVoiceAudio) ? 'client_cannot_transcribe'
              : !isFunction(client.voiceServerTransport) ? 'client_has_no_voice_transport'
                : 'voice_module_export_missing');
        }
        var transport;
        var created;
        try {
          transport = exact.createVoiceTransport(Object.freeze({
            serverTransport: function (request) {
              if (disposed || expectedEpoch !== epoch || expectedClient !== client) {
                return Promise.reject(new Error('auth_expired'));
              }
              return client.voiceServerTransport(request);
            },
            timeoutMs: 15000,
          }));
          if (!transport || !isFunction(transport.submitTurn)) return false;
          var nativeWakeRecognitionFactory = createCapturedNativeWakeRecognitionFactory(function () {
            if (disposed || emergencyOff || !voiceEnabled) return;
            if (!page.panel.classList.contains('open')) setPanelOpen(true);
            if (view) text(view.voiceStatus, 'I\'m listening.');
          }, function (code) {
            if (!view || disposed || emergencyOff || code === 'canceled') return;
            var message = Object.prototype.hasOwnProperty.call(NATIVE_VOICE_MESSAGES, code)
              ? NATIVE_VOICE_MESSAGES[code] : NATIVE_VOICE_MESSAGES.recognition_error;
            text(view.voiceStatus, message);
            text(view.voiceError, message);
          });
          var browserRecognitionFactory = createCapturedBrowserRecognitionFactory();
          var nativeRecognitionFactory = nativeWakeRecognitionFactory ? null
            : createCapturedNativeRecognitionFactory(function (code) {
              if (!view || disposed || emergencyOff || code === 'canceled') return;
              var message = Object.prototype.hasOwnProperty.call(NATIVE_VOICE_MESSAGES, code)
                ? NATIVE_VOICE_MESSAGES[code] : NATIVE_VOICE_MESSAGES.recognition_error;
              text(view.voiceStatus, message);
              text(view.voiceError, message);
            });
          // Browser voice deliberately uses the controlled short-recording path,
          // not Chrome's separate SpeechRecognition service. The authenticated
          // client transcribes one bounded clip, then the existing Voice stack
          // submits its text through the same canonical Reina transport.
          var controlledRecognitionFactory = (nativeWakeRecognitionFactory || nativeRecognitionFactory) ? null
            : exact.createControlledRecognitionFactory(Object.freeze({
              windowRef: root,
              getAudioConstraints: function () {
                var selected = '';
                try { selected = audioInputSelect && safePrimitiveText(audioInputSelect.value, 512, true) ? audioInputSelect.value : ''; } catch (_) {}
                // The <select> is only populated by refreshAudioDevices(), which
                // runs when the Settings panel is OPENED and when its refresh
                // button is pressed -- nowhere else. So on any page load where
                // Settings was not opened, this element still has no options and
                // no value, `selected` came out empty, and NO deviceId constraint
                // was sent at all. The browser then opened whatever it considers
                // the default.
                //
                // That is the reported bug: a user picked their headset, the
                // choice was saved, and on the next load the webcam microphone
                // opened instead -- its capture LED giving it away while the
                // panel reported nothing wrong. Every diagnostic row from that
                // machine named the webcam, across four separate attempts.
                //
                // The saved choice is the user's choice whether or not the
                // Settings UI has been rendered this session. Read it.
                if (!selected) selected = storedAudioInput();
                // DO NOT CHANGE THESE WITHOUT A MEASUREMENT. This exact trio ran
                // from 2026-08-04 to 2026-08-16 and voice worked. #325 then set
                // autoGainControl:false on the theory that the browser's gain was
                // fighting the OS's; capture dropped to the noise floor that same day
                // (measured peaks of 1 to 14 out of 127, across a Bluetooth headset
                // AND a webcam) and every transcript came back empty. #393 was my
                // attempt at a fix and it guessed a third combination rather than
                // returning here, which cost another day.
                //
                // The configuration below is not a theory about audio processing. It
                // is the one that demonstrably worked for twelve days.
                var audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
                // ALWAYS `exact`. Asking for an alias as a preference was wrong: a
                // preference lets the browser satisfy the constraint with ANY device,
                // and it did -- a user who had picked "Default - Headset" had the
                // webcam microphone opened instead, its capture LED giving it away
                // while the panel reported the headset. A person choosing an input is
                // not expressing a preference. If the chosen device cannot be opened,
                // that belongs in the error path, not in a silent substitution.
                if (selected) audio.deviceId = { exact: selected };
                return { audio: audio };
              },
              transcribeAudio: function (blob) { return client.transcribeVoiceAudio(blob); },
              // Microphone failures are invisible to the server -- they never
              // reach it. Send their shape so they can be read from the
              // database instead of from the console of whoever was speaking.
              reportDiagnostic: function (record) {
                if (!isFunction(client.reportVoiceDiagnostic)) return;
                return client.reportVoiceDiagnostic(record);
              },
              maximumMs: 15_000,
              silenceMs: 900,
              initialSilenceMs: 6_000,
              activityThreshold: 4,
            }));
          var neuralSynthesis = ensureVoiceSynthesis();
          created = exact.createVoiceHost(Object.freeze({
            conversationId: sessionId,
            newId: newId,
            submitTurn: transport.submitTurn,
            assessTranscript: assessVoiceTranscript,
            isSpeechAllowed: function () {
              return voiceEnabled && !emergencyOff && !disposed
                && expectedEpoch === epoch && expectedClient === client;
            },
            isEmergencyOff: function () { return emergencyOff || disposed || expectedEpoch !== epoch; },
            // Desktop bridge first where it exists, then the browser's own
            // recognizer, and only then the record-and-upload fallback. The
            // middle term is new; without it a browser always landed on the
            // fallback.
            recognitionFactory: nativeWakeRecognitionFactory || nativeRecognitionFactory
              || browserRecognitionFactory || controlledRecognitionFactory,
            // Native Windows recognition remains the Desktop default. Browser
            // Voice records one short clip directly instead of relying on
            // Chromium's unstable hosted speech-recognition service.
            // Keep the controlled recorder as the only browser input path.
            // Spoken output is neural-only; never pass the browser's built-in
            // speechSynthesis voice as a fallback.
            windowRef: null,
            synthesis: neuralSynthesis,
            utteranceFactory: neuralSynthesis && isFunction(CAPTURED_CREATE_NEURAL_UTTERANCE)
              ? CAPTURED_CREATE_NEURAL_UTTERANCE : null,
            labels: Object.freeze({
              error_network: 'error_network',
              error_audio_capture: 'error_audio_capture',
              error_no_speech: 'error_no_speech',
              error_timeout: 'error_timeout',
              error_permission_denied: 'error_permission_denied',
              error_no_microphone: 'error_recognition_no_microphone',
              error_device_busy: 'error_recognition_device_busy',
              error_recognition_error: 'error_recognition_error',
              error_recognition_unavailable: 'error_recognition_unavailable',
              error_recognition_no_speech: 'error_recognition_no_speech',
              error_recognition_timeout: 'error_recognition_timeout',
              error_recognition_network: 'error_network',
              error_recognition_audio_capture: 'error_audio_capture',
              error_recognition_transcription_auth: 'error_transcription_auth',
              error_recognition_transcription_bad_audio: 'error_transcription_bad_audio',
              error_recognition_transcription_rate_limited: 'error_transcription_rate_limited',
              error_recognition_transcription_unavailable: 'error_transcription_unavailable',
              error_recognition_transcription_no_speech: 'error_transcription_no_speech',
              error_recognition_transcription_timeout: 'error_transcription_timeout',
              error_recognition_input_too_quiet: 'error_input_too_quiet',
              error_recognition_input_too_loud: 'error_input_too_loud',
              error_recognition_microphone_open_timeout: 'error_microphone_open_timeout',
              // Turn-stage failures (the bridge maps every session failure onto
              // this small set), so a spoken turn that fails after the recording
              // succeeded says so instead of leaving an empty feed.
              error_turn_failed: 'error_turn_failed',
              error_turn_timeout: 'error_turn_timeout',
              error_turn_empty_reply: 'error_turn_empty_reply',
              error_auth_expired: 'error_auth_expired',
            }),
            controls: Object.freeze({}),
            render: Object.freeze({
              status: function (value) {
                if (view && safePrimitiveText(value, 120, true)) text(view.voiceStatus, value ? 'Voice: ' + value : '');
                // Guarded on voiceEnabled, not just the value: stopVoice() clears
                // the indicator synchronously via renderTopVoiceToggle(false),
                // but then calls voiceHost.interrupt()/.stop() asynchronously --
                // an already-in-flight recognition attempt (e.g. the browser's
                // mic-open request still resolving from just before the
                // toggle-off) can still report 'listening' AFTER voice was
                // turned off, with nothing left to clear it again. Found live:
                // the indicator stuck lit after Voice was switched off, which
                // then looks like a real session is running when nothing is
                // actually being recorded.
                // The session already reported thinking and speaking; only
                // 'listening' was ever rendered, so the header went blank while
                // Reina was working and while she was talking -- the two moments
                // a person most wants a word from the interface. All four now
                // reach the one button. The voiceEnabled guard stays: a
                // recognition attempt already in flight can report 'listening'
                // AFTER voice was switched off, and without it the button
                // sticks lit as though something were being recorded.
                if (voiceEnabled !== true) setVoicePhase('off');
                else if (value === 'listening' || value === 'thinking' || value === 'speaking') setVoicePhase(value);
                else setVoicePhase('off');
                if (value === 'idle') {
                  if (directListening && !handsFreeEnabled) {
                    voiceEnabled = false;
                    directListening = false;
                    renderTopVoiceToggle(false);
                    emitState(null);
                  } else {
                    rearmHandsFree();
                  }
                  armPanelAutoClose();
                }
              },
              interim: function (value) { if (view && safePrimitiveText(value, MAX_USER_TEXT, true)) text(view.voiceInterim, value); },
              reply: function (value) {
                if (!view || !safePrimitiveText(value, MAX_RENDER_TEXT, false)
                  || emergencyOff || disposed || expectedEpoch !== epoch) return;
                appendMessage('assistant', value);
                state = 'ready';
                normalInput(true);
                text(view.status, 'Synthetic read-only reply. Nothing was executed.');
                emitState(null);
                if (!voiceEnabled) armPanelAutoClose();
              },
              confirm: function (value) { if (view && safePrimitiveText(value, 500, true)) text(view.voiceConfirm, value); },
              error: function (value) {
                if (!view) return;
                // An EMPTY value is the panel CLEARING this surface -- it is what
                // mount() and reset() send, and it is not a failure. Treating it
                // as one printed "Voice could not complete that turn" into the
                // feed of a panel that had never run a turn, and ran every
                // failure side effect with it (typed input reset, one-shot Voice
                // switched off, the panel armed to auto-close).
                if (value === '' || value == null) { text(view.voiceError, ''); return; }
                var safe = value === 'error_permission_denied' || value === 'error_recognition_permission_denied'
                  ? NATIVE_VOICE_MESSAGES.permission_denied
                  : value === 'error_recognition_no_microphone'
                    ? NATIVE_VOICE_MESSAGES.no_microphone
                  : value === 'error_recognition_device_busy'
                    ? NATIVE_VOICE_MESSAGES.device_busy
                  : value === 'error_network'
                    ? NATIVE_VOICE_MESSAGES.network
                  : value === 'error_audio_capture'
                    ? NATIVE_VOICE_MESSAGES.audio_capture
                  : value === 'error_no_speech' || value === 'error_recognition_no_speech'
                    ? NATIVE_VOICE_MESSAGES.no_speech
                    : value === 'error_timeout' || value === 'error_recognition_timeout'
                      ? NATIVE_VOICE_MESSAGES.timeout
                      : value === 'error_unavailable' || value === 'error_recognition_unavailable'
                        ? NATIVE_VOICE_MESSAGES.unavailable
                        : typeof value === 'string'
                          && Object.prototype.hasOwnProperty.call(VOICE_TURN_MESSAGES, value)
                          ? VOICE_TURN_MESSAGES[value]
                          : typeof value === 'string' && /^error_[a-z0-9_]{1,80}$/.test(value)
                            ? 'Voice failed (' + value + '). Typed Reina still works.'
                            : 'Voice could not complete that turn. Typed Reina still works.';
                text(view.voiceError, safe);
                // A recognition/playback/transport failure is not an
                // authorization decision.  Restore the typed path so the
                // user can continue in the same visible Reina panel.
                if (!emergencyOff && !disposed && state !== 'auth_expired' && state !== 'unavailable') {
                  state = 'ready';
                  normalInput(true);
                }
                if (value === 'error_no_speech' || value === 'error_recognition_no_speech'
                  || value === 'error_timeout' || value === 'error_recognition_timeout') rearmHandsFree(250);
                // A one-shot purple-tab turn is complete even when recording,
                // transport, or neural playback fails. Do not leave the popup
                // permanently "Voice On" with no active work. Keep the error
                // visible for 20 seconds, then close unless the user interacts.
                if (directListening && !handsFreeEnabled) {
                  voiceEnabled = false;
                  directListening = false;
                  renderTopVoiceToggle(false);
                  emitState(null);
                }
                if (!voiceEnabled) armPanelAutoClose();
              },
              controls: voiceControlsSnapshot,
            }),
            // Session-level refusals: a guard that declined to open the
            // microphone, or a recognition error dropped before it could reach
            // the session's failure path. Neither is a state or an error, so
            // neither had any way out of those modules -- the microphone did
            // not open and nothing anywhere recorded why.
            onBlock: function (reason) {
              noteVoiceBlock('session_' + String(reason == null ? 'unknown' : reason));
            },
            onControlEvent: function (event) {
              var type = ownData(event, 'type');
              var detail = ownData(event, 'detail');
              // Panel-level refusals, reported through the same seam.
              if (type.ok && type.value === 'blocked' && detail.ok) {
                var blockReason = ownData(detail.value, 'reason');
                noteVoiceBlock('panel_' + (blockReason.ok && typeof blockReason.value === 'string'
                  ? blockReason.value : 'unknown'));
                return;
              }
              if (type.ok && type.value === 'error' && detail.ok) {
                var reason = ownData(detail.value, 'reason');
                // The rendered message is deliberately non-technical. Say the
                // exact reason out loud once, the same way the microphone and
                // transcription paths already do, so a failure a user reports
                // can be read instead of guessed at.
                if (reason.ok && safePrimitiveText(reason.value, 120, false)) {
                  try {
                    var voiceConsole = root && root.console;
                    if (voiceConsole && isFunction(voiceConsole.warn)) voiceConsole.warn('[reina-voice] turn error', reason.value);
                  } catch (_) {}
                }
                // Turn-stage failures reach the server as a request but never as
                // a record of their own outcome. Report them beside the
                // microphone ones so a broken voice turn is one query, not one
                // screenshot.
                if (reason.ok && safePrimitiveText(reason.value, 60, false)
                  && client && isFunction(client.reportVoiceDiagnostic)) {
                  try { client.reportVoiceDiagnostic({ stage: 'turn', code: reason.value }); } catch (_) {}
                }
                if (reason.ok && reason.value === 'auth_expired') expireSession();
              }
            },
          }));
        } catch (e) { return noteVoiceBlock('voice_host_threw:' + ((e && e.message) || 'unknown')); }
        if (!created || !isFunction(created.mount) || !isFunction(created.dispose)) {
          return noteVoiceBlock('voice_host_not_constructed');
        }
        var mountedVoice;
        try { mountedVoice = created.mount(); } catch (e2) { mountedVoice = 'threw:' + ((e2 && e2.message) || 'unknown'); }
        if (mountedVoice !== true) {
          try { created.dispose(); } catch (_) {}
          return noteVoiceBlock('mount_failed:' + String(mountedVoice));
        }
        voiceHost = created;
        if (view) {
          setDisabled(view.voiceStart, !isFunction(created.isVoiceAvailable) || created.isVoiceAvailable() !== true);
          setDisabled(view.voiceOff, false);
          setDisabled(topVoiceToggle, !isFunction(created.isVoiceAvailable) || created.isVoiceAvailable() !== true);
          setDisabled(settingsVoiceToggle, !isFunction(created.isVoiceAvailable) || created.isVoiceAvailable() !== true);
          renderTopVoiceToggle(false);
          text(view.voiceStatus, isFunction(created.isVoiceAvailable) && created.isVoiceAvailable() === true
            ? 'Voice is off. Click the purple Reina tab to open this conversation and start listening.'
            : 'Voice input is unavailable in this browser.');
        }
        emitState('voice_ready');
        return true;
      }, function () { return false; });
    }

    function fixedFailure(code, keepPanelOpen) {
      var message = FIXED_ERRORS[code] || FIXED_ERRORS.unavailable;
      if (keepPanelOpen === true) showUnavailablePage(page);
      if (view) {
        text(view.error, message);
        text(view.status, '');
      }
      return message;
    }

    function beginPendingSession(expectedEpoch) {
      var resolvePending;
      var record = {
        epoch: expectedEpoch,
        settled: false,
        promise: new Promise(function (resolve) { resolvePending = resolve; }),
        resolve: resolvePending,
      };
      pendingSession = record;
      return record;
    }

    function settlePendingSession(record, result) {
      if (!record || record.settled === true) return false;
      record.settled = true;
      if (pendingSession === record) pendingSession = null;
      record.resolve(result);
      return true;
    }

    function cancelPendingSession(reason) {
      var record = pendingSession;
      if (!record) return false;
      return settlePendingSession(record, { ok: false, reason: reason });
    }

    function stopControllers() {
      var previousLogin = loginBrief;
      var previousTyped = typedPanel;
      var previousRouter = intentRouter;
      var previousVoice = voiceHost;
      loginBrief = null;
      typedPanel = null;
      intentRouter = null;
      voiceHost = null;
      voiceLoad = null;
      confirmationGrant = null;
      pendingReview = null;
      voiceEnabled = false;
      directListening = false;
      emergencyOff = false;
      client = null;
      sessionId = null;
      setVoiceBlockReporter(null);
      if (previousRouter && isFunction(previousRouter.revoke)) {
        try { previousRouter.revoke('session_replaced'); } catch (_) {}
      }
      if (previousRouter && isFunction(previousRouter.dispose)) {
        try { previousRouter.dispose(); } catch (_) {}
      }
      if (previousVoice && isFunction(previousVoice.emergencyOff)) {
        try { previousVoice.emergencyOff(); } catch (_) {}
      }
      if (previousVoice && isFunction(previousVoice.dispose)) {
        try { previousVoice.dispose(); } catch (_) {}
      }
      if (previousTyped && isFunction(previousTyped.reset)) {
        try { previousTyped.reset(); } catch (_) { /* discarded */ }
      }
      if (previousLogin && isFunction(previousLogin.onAuthExpired)) {
        try { previousLogin.onAuthExpired(); } catch (_) { /* discarded */ }
      }
    }

    function expireSession() {
      if (disposed || state === 'auth_expired') return snapshot('auth_expired');
      var recoverAfterTurn = refreshedDuringTurn;
      refreshedDuringTurn = false;
      cancelPendingSession('auth_expired');
      epoch += 1;
      stopControllers();
      clearPresentation();
      state = 'auth_expired';
      fixedFailure('auth_expired', true);
      if (!expirySignaled) {
        expirySignaled = true;
        try { onAuthExpired(); } catch (_) { /* callback cannot alter reset */ }
      }
      var expired = emitState('auth_expired');
      if (recoverAfterTurn) {
        // The old-token operation has already produced its terminal 403. Let
        // the typed controller consume that rejection, then bootstrap a fresh
        // session without retrying or duplicating the semantic turn.
        Promise.resolve().then(function () { return Promise.resolve(); }).then(function () {
          if (!disposed && mounted && state === 'auth_expired') startSession();
        });
      }
      return expired;
    }

    function renderLoginView(model, expectedLogin, expectedEpoch, settle) {
      if (disposed || expectedEpoch !== epoch || expectedLogin !== loginBrief) {
        settle({ ok: false, reason: disposed ? 'disposed' : 'superseded' });
        return;
      }
      var stateValue = ownData(model, 'state');
      if (!stateValue.ok || typeof stateValue.value !== 'string') {
        refreshedDuringTurn = false;
        state = 'unavailable';
        fixedFailure('bootstrap_failed', true);
        emitState('bootstrap_failed');
        settle({ ok: false, reason: 'bootstrap_failed' });
        return;
      }
      if (stateValue.value === 'loading') {
        state = 'loading';
        text(view.status, 'Loading Reina\'s read-only preview…');
        emitState(null);
        return;
      }
      if (stateValue.value === 'greeted') {
        var greeting = ownData(model, 'greeting');
        var summary = ownData(model, 'attentionSummary');
        var categories = ownData(model, 'categories');
        var disclosures = ownData(model, 'unavailableDisclosures');
        var reviewAvailable = ownData(model, 'reviewAvailable');
        var question = ownData(model, 'question');
        if (!greeting.ok || !summary.ok
          || !safePrimitiveText(greeting.value, 500, false)
          || !safePrimitiveText(summary.value, 1000, false)
          || !reviewAvailable.ok || typeof reviewAvailable.value !== 'boolean'
          || !question.ok || !safePrimitiveText(question.value, 500, true)) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed', true);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
          return;
        }
        var categoryLines = [];
        try {
          if (Array.isArray(categories.value)) {
            for (var i = 0; i < categories.value.length && i < 24; i += 1) {
              var category = ownData(categories.value, String(i));
              if (!category.ok) continue;
              var label = ownData(category.value, 'label');
              var count = ownData(category.value, 'count');
              var asOf = ownData(category.value, 'asOf');
              if (label.ok && count.ok && asOf.ok
                && safePrimitiveText(label.value, 120, false)
                && Number.isSafeInteger(count.value)
                && safePrimitiveText(asOf.value, 64, false)) {
                categoryLines.push(label.value + ': ' + count.value + ' (as of ' + asOf.value + ')');
              }
            }
          }
        } catch (_) { categoryLines = []; }
        var unavailable = disclosures.ok ? safeStringList(disclosures.value, 48, 1000) : [];
        if (reviewAvailable.value === false) unavailable.push('Review navigation is unavailable in this release candidate.');
        text(view.greeting, greeting.value);
        text(view.attention, summary.value + ' Let me know where you\'d like to start.');
        appendList(view.categories, categoryLines);
        appendList(view.disclosures, unavailable);
        text(view.reviewQuestion, reviewAvailable.value === true ? question.value : '');
        setDisplay(view.reviewControls, reviewAvailable.value === true ? 'flex' : 'none');
        setDisabled(view.reviewButton, reviewAvailable.value !== true);
        text(view.error, '');
        text(view.status, 'Synthetic read-only preview. Nothing can be executed.');
        refreshedDuringTurn = false;
        state = 'ready';
        showVerifiedPanel();
        emitState(null);
        settle({ ok: true, sessionId: sessionId });
        return;
      }
      if (stateValue.value === 'review_requested') {
        pendingReview = null;
        confirmationGrant = null;
        text(view.reviewQuestion, 'Opening the existing attention review surface.');
        setDisplay(view.reviewControls, 'none');
        setDisabled(view.reviewButton, true);
        text(view.error, '');
        state = 'ready';
        normalInput(true);
        emitState('review_opened');
        return;
      }
      if (stateValue.value === 'review_failed') {
        confirmationGrant = null;
        setDisplay(view.reviewControls, 'none');
        setDisabled(view.reviewButton, true);
        text(view.reviewQuestion, 'The review surface could not be opened.');
        state = 'ready';
        normalInput(true);
        emitState('review_failed');
        return;
      }
      if (stateValue.value === 'declined') {
        revokeReview('declined', false);
        text(view.reviewQuestion, 'Review was not opened.');
        state = 'ready';
        normalInput(true);
        emitState('review_declined');
        return;
      }
      if (stateValue.value === 'expired') {
        expireSession();
        settle({ ok: false, reason: 'auth_expired' });
        return;
      }
      state = 'unavailable';
      refreshedDuringTurn = false;
      fixedFailure('bootstrap_failed', true);
      emitState('bootstrap_failed');
      settle({ ok: false, reason: 'bootstrap_failed' });
    }

    function assistantText(model) {
      var parts = [];
      var answer = ownData(model, 'answer');
      var evidence = ownData(model, 'evidence');
      var freshness = ownData(model, 'freshness');
      var missing = ownData(model, 'missingInformation');
      var conflicts = ownData(model, 'conflictingInformation');
      var uncertainty = ownData(model, 'uncertainty');
      var refusal = ownData(model, 'refusalReason');
      var execution = ownData(model, 'executionNotice');
      if (!answer.ok || !safePrimitiveText(answer.value, 16384, false)) return null;
      parts.push(answer.value);
      var evidenceValues = evidence.ok ? safeStringList(evidence.value, 64, 8192) : [];
      if (evidenceValues.length) parts.push('Evidence: ' + evidenceValues.join(' | '));
      if (freshness.ok && safePrimitiveText(freshness.value, 4096, true) && freshness.value) parts.push(freshness.value);
      var missingValues = missing.ok ? safeStringList(missing.value, 64, 4096) : [];
      if (missingValues.length) parts.push('Missing information: ' + missingValues.join(' | '));
      var conflictValues = conflicts.ok ? safeStringList(conflicts.value, 64, 4096) : [];
      if (conflictValues.length) parts.push('Conflicting information: ' + conflictValues.join(' | '));
      var uncertaintyValues = uncertainty.ok ? safeStringList(uncertainty.value, 64, 4096) : [];
      if (uncertaintyValues.length) parts.push('Uncertainty: ' + uncertaintyValues.join(' | '));
      if (refusal.ok && safePrimitiveText(refusal.value, 2048, true) && refusal.value) parts.push('Refusal: ' + refusal.value);
      if (!execution.ok || !safePrimitiveText(execution.value, 500, false)) return null;
      parts.push(execution.value);
      var details = parts.slice(1).join('\n\n');
      return details.length <= MAX_RENDER_TEXT
        ? Object.freeze({ answer: answer.value, details: details })
        : null;
    }

    function renderTypedView(model, expectedTyped, expectedEpoch) {
      if (disposed || expectedEpoch !== epoch || expectedTyped !== typedPanel) return;
      var stateValue = ownData(model, 'state');
      var turnValue = ownData(model, 'turnId');
      if (!stateValue.ok || typeof stateValue.value !== 'string') {
        refreshedDuringTurn = false;
        state = 'turn_error';
        abandonSpokenTurn();
        fixedFailure('turn_failed');
        retryInput();
        emitState('turn_failed');
        return;
      }
      if (stateValue.value === 'loading') {
        state = 'submitting';
        text(view.error, '');
        text(view.status, 'Checking the synthetic read-only preview…');
        if (retrying) {
          setDisabled(page.input, true);
          setDisabled(page.send, true);
        } else normalInput(false);
        emitState(null);
        return;
      }
      if (stateValue.value === 'answered') {
        var turnId = turnValue.ok && typeof turnValue.value === 'string' ? turnValue.value : null;
        var rendered = assistantText(model);
        if (!turnId || !rendered || renderedTurns[turnId]) {
          refreshedDuringTurn = false;
          retrying = false;
          state = 'turn_error';
          abandonSpokenTurn();
          fixedFailure('turn_failed');
          retryInput();
          emitState('turn_failed');
          return;
        }
        renderedTurns[turnId] = true;
        if (!appendAssistantMessage(rendered.answer, rendered.details)) {
          refreshedDuringTurn = false;
          retrying = false;
          state = 'turn_error';
          abandonSpokenTurn();
          fixedFailure('turn_failed');
          retryInput();
          emitState('turn_failed');
          return;
        }
        text(view.error, '');
        text(view.status, 'Synthetic read-only reply. Nothing was executed.');
        refreshedDuringTurn = false;
        retrying = false;
        state = 'ready';
        normalInput(true);
        finishSpokenTurn(rendered.answer);
        emitState(null);
        return;
      }
      if (stateValue.value === 'auth_expired') {
        retrying = false;
        abandonSpokenTurn();
        expireSession();
        return;
      }
      if (stateValue.value === 'error' || stateValue.value === 'unavailable') {
        refreshedDuringTurn = false;
        retrying = false;
        state = 'turn_error';
        abandonSpokenTurn();
        // 'unavailable' means the preview is switched off server-side, not
        // that this turn hit a blip -- FIXED_ERRORS already carries the honest
        // copy for it, but both states were being rendered as 'turn_failed'
        // ("please try again"), which invited users to retry something that
        // cannot succeed until the route is enabled.
        var failureKey = stateValue.value === 'unavailable' ? 'unavailable' : 'turn_failed';
        fixedFailure(failureKey);
        retryInput();
        emitState(failureKey);
      }
    }

    function startSession() {
      if (disposed || !mounted) return Promise.resolve({ ok: false, reason: 'not_mounted' });
      if (pendingSession) return pendingSession.promise;
      refreshedDuringTurn = false;
      epoch += 1;
      var myEpoch = epoch;
      var pending = beginPendingSession(myEpoch);
      function settle(value) { settlePendingSession(pending, value); }
      stopControllers();
      clearPresentation();
      expirySignaled = false;
      state = 'loading';
      text(view.status, 'Verifying the signed-in Reina preview…');
      emitState(null);

      try {
        var clientOptions = {
          onAuthExpired: function () { if (myEpoch === epoch) expireSession(); },
        };
        if (isFunction(getAccessToken)) clientOptions.getAccessToken = getAccessToken;
        client = createClient(Object.freeze(clientOptions));
      } catch (_) {
        client = null;
      }
      // Wire the refusal path to the same reporter the recorder uses, as soon
      // as there is a client able to post it. A refusal before this point has
      // no transport to report through and stays console-only.
      setVoiceBlockReporter(client && isFunction(client.reportVoiceDiagnostic)
        ? function (record) { return client.reportVoiceDiagnostic(record); }
        : null);
      if (!client || !isFunction(client.bootstrap) || !isFunction(client.submitTurn)
        || !isFunction(client.confirmReviewIntent)) {
        state = 'unavailable';
        fixedFailure('unavailable', true);
        emitState('unavailable');
        settle({ ok: false, reason: 'unavailable' });
        return pending.promise;
      }

      var bootstrapPromise;
      try { bootstrapPromise = client.bootstrap(); } catch (_) { bootstrapPromise = Promise.reject(new Error('bootstrap')); }
      Promise.resolve(bootstrapPromise).then(function (result) {
        if (disposed || myEpoch !== epoch) {
          settle({ ok: false, reason: disposed ? 'disposed' : 'superseded' });
          return;
        }
        var exact = readExactDataObject(result, ['sessionId', 'bootstrap']);
        if (!exact || typeof exact.sessionId !== 'string' || !SERVER_SESSION_RE.test(exact.sessionId)) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed', true);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
          return;
        }
        sessionId = exact.sessionId;
        var loginBootstrap = bootstrapForLoginBrief(exact.bootstrap, sessionId);
        if (!loginBootstrap || !registerReviewIntent(exact.bootstrap, myEpoch)) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed', true);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
          return;
        }
        var createdLogin;
        var createdTyped;
        try {
          createdLogin = createLoginBrief({
            fetchBootstrap: function (request) {
              var requested = ownData(request, 'sessionId');
              if (!requested.ok || requested.value !== sessionId) return Promise.reject(new Error('session'));
              return Promise.resolve(loginBootstrap);
            },
            confirmIntent: strictReviewConfirmation,
            onView: function (model) { renderLoginView(model, createdLogin, myEpoch, settle); },
          });
          createdTyped = createTypedPanel({
            conversationId: sessionId,
            newId: newId,
            submitTurn: function (request) { return client.submitTurn(request); },
            onAuthExpired: function () { if (myEpoch === epoch) expireSession(); },
            onView: function (model) { renderTypedView(model, createdTyped, myEpoch); },
          });
        } catch (_) {
          revokeReview('controller_unavailable', false);
          if (intentRouter && isFunction(intentRouter.dispose)) {
            try { intentRouter.dispose(); } catch (_) {}
          }
          intentRouter = null;
          state = 'unavailable';
          fixedFailure('unavailable', true);
          emitState('unavailable');
          settle({ ok: false, reason: 'unavailable' });
          return;
        }
        loginBrief = createdLogin;
        typedPanel = createdTyped;
        installVoice(myEpoch, client);
        var accepted;
        try { accepted = loginBrief.onAuthenticated(sessionId); } catch (_) { accepted = null; }
        if (!accepted || accepted.accepted !== true) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed', true);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
        }
      }).catch(function (error) {
        if (disposed || myEpoch !== epoch) {
          settle({ ok: false, reason: disposed ? 'disposed' : 'superseded' });
          return;
        }
        var errorCode = ownData(error, 'code');
        var code = errorCode.ok && errorCode.value === 'auth_expired' ? 'auth_expired' : 'bootstrap_failed';
        if (code === 'auth_expired') {
          expireSession();
          settle({ ok: false, reason: 'auth_expired' });
          return;
        }
        state = 'unavailable';
        fixedFailure(code, true);
        emitState(code);
        settle({ ok: false, reason: code });
      });
      return pending.promise;
    }

    function submitTyped(value) {
      // This refused silently: no message in the feed, no console line, and the
      // typed text left sitting in the box. Pressing Send simply did nothing,
      // which is indistinguishable from a dead button. Record which condition
      // fired. The return value is unchanged.
      if (disposed || state !== 'ready' || !typedPanel) {
        noteTurnBlock(disposed ? 'host_disposed'
          : !typedPanel ? 'typed_panel_missing'
            : ('panel_state_' + state));
        return { accepted: false, reason: 'session_unavailable' };
      }
      if (!safePrimitiveText(value, MAX_USER_TEXT, false)) {
        fixedFailure('invalid_input');
        return { accepted: false, reason: 'invalid_input' };
      }
      var normalized = value.trim();
      if (!normalized || CONTROL_RE.test(normalized)) {
        fixedFailure('invalid_input');
        return { accepted: false, reason: 'invalid_input' };
      }
      var outcome;
      revokeReview('turn_replaced', true);
      // Typed input must not touch the Voice session before the host-owned
      // trusted-gesture latch is set. In PR #81, interrupt() deliberately
      // restarts recognition; calling it on an otherwise dormant Voice host
      // would activate the microphone without consent.
      if (voiceEnabled && voiceHost) {
        try { if (isFunction(voiceHost.interrupt)) voiceHost.interrupt(); } catch (_) {}
        try { if (isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
      }
      refreshedDuringTurn = false;
      retrying = false;
      try { outcome = typedPanel.submit(normalized); } catch (_) { outcome = null; }
      if (!outcome || outcome.accepted !== true) {
        if (outcome && outcome.reason === 'busy') return { accepted: false, reason: 'busy' };
        fixedFailure('turn_failed');
        return { accepted: false, reason: 'turn_failed' };
      }
      appendMessage('user', normalized);
      try { page.input.value = ''; } catch (_) { /* inert */ }
      return { accepted: true, turnId: outcome.turnId };
    }

    function submitFromInput() {
      if (state === 'turn_error') return retryTurn();
      var value;
      try { value = page.input.value; } catch (_) { value = null; }
      return submitTyped(value);
    }

    function retryTurn() {
      if (disposed || state !== 'turn_error' || !typedPanel || !isFunction(typedPanel.retry)) {
        return { accepted: false, reason: 'nothing_to_retry' };
      }
      var outcome;
      retrying = true;
      try { outcome = typedPanel.retry(); } catch (_) { outcome = null; }
      if (!outcome || outcome.accepted !== true) {
        retrying = false;
        retryInput();
        fixedFailure('turn_failed');
        return { accepted: false, reason: 'turn_failed' };
      }
      return { accepted: true, turnId: outcome.turnId };
    }

    function mount() {
      if (disposed) return Promise.resolve({ ok: false, reason: 'disposed' });
      if (!mounted) {
        buildView();
        mounted = true;
        try { if (isFunction(page.input.setAttribute)) page.input.setAttribute('data-hl-voice-input', 'off'); } catch (_) {}
        bindOwnedClick(page.fab, function (event) {
          if (state !== 'ready' && state !== 'submitting' && state !== 'turn_error'
            && state !== 'unavailable' && state !== 'auth_expired') return;
          setPanelOpen(true);
          // The purple tab is an explicit push-to-talk gesture. Accept the
          // next verified transcript directly; do not require the user to say
          // a wake phrase after already pressing Reina, and do not re-arm the
          // microphone in a silent polling loop after the turn.
          if (voiceEnabled) restartDirectListeningFromGesture(event);
          else enableVoiceFromGesture(event, false, true);
        });
        bindOwnedClick(page.close, function () { setPanelOpen(false); });
        if (popupMinimize) bindOwnedClick(popupMinimize, function () { setPanelOpen(false); });
        bindOwnedClick(page.send, function () { submitFromInput(); });
        bindOwnedClick(view.reviewButton, function (event) {
          if (!trustedGesture(event)) return;
          beginReviewConfirmation('button');
        });
        bindOwnedClick(view.voiceStart, function (event) { enableVoiceFromGesture(event); });
        // Press and hold to talk, release to send -- the same walkie-talkie
        // model as the Chirp button, which people already use without being
        // told. Holding removes the whole class of confusion a toggle creates:
        // there is no mode to be in and no state to remember, because the
        // microphone is open for exactly as long as a finger is down.
        if (topVoiceToggle) {
          bind(topVoiceToggle, 'pointerdown', function (event) {
            if (!trustedGesture(event)) return;
            try { if (isFunction(event.preventDefault)) event.preventDefault(); } catch (_) {}
            beginHoldToTalk(event);
          });
          // Release, leave the button while still holding, or have the gesture
          // cancelled out from under us -- all end the recording. Chirp treats
          // mouseleave the same way, and a recording left running because a
          // cursor slid off a button is the worst of both worlds.
          bind(topVoiceToggle, 'pointerup', function () { endHoldToTalk(); });
          bind(topVoiceToggle, 'pointerleave', function () { endHoldToTalk(); });
          bind(topVoiceToggle, 'pointercancel', function () { endHoldToTalk(); });
          // Hold-to-talk is a mouse gesture, and a keyboard has no equivalent.
          // Space and Enter hold while the key is down and send on release, so
          // the control is not reserved for people using a pointer.
          bind(topVoiceToggle, 'keydown', function (event) {
            if (!trustedGesture(event)) return;
            var key = event && event.key;
            if (key !== ' ' && key !== 'Spacebar' && key !== 'Enter') return;
            if (event.repeat) return;
            try { if (isFunction(event.preventDefault)) event.preventDefault(); } catch (_) {}
            beginHoldToTalk(event);
          });
          bind(topVoiceToggle, 'keyup', function (event) {
            var key = event && event.key;
            if (key !== ' ' && key !== 'Spacebar' && key !== 'Enter') return;
            endHoldToTalk();
          });
        }
        if (settingsVoiceToggle) bindOwnedClick(settingsVoiceToggle, function (event) { enableVoiceFromGesture(event); });
        if (popupSettings) bindOwnedClick(popupSettings, function () {
          var open = false;
          try { open = !popupSettingsPanel.classList.contains('open'); } catch (_) {}
          setSettingsOpen(open);
          notePanelActivity();
        });
        bind(documentRef, 'pointerdown', dismissSettingsOutside);
        bind(documentRef, 'touchstart', dismissSettingsOutside);
        bind(documentRef, 'wheel', function () { setSettingsOpen(false); });
        bind(documentRef, 'scroll', function () { setSettingsOpen(false); });
        bind(page.feed, 'scroll', function () { setSettingsOpen(false); notePanelActivity(); });
        bind(page.panel, 'pointerdown', notePanelActivity);
        bind(page.panel, 'touchstart', notePanelActivity);
        bind(page.panel, 'wheel', notePanelActivity);
        bind(page.panel, 'keydown', notePanelActivity);
        bind(page.panel, 'input', notePanelActivity);
        if (refreshAudioDevicesButton) bindOwnedClick(refreshAudioDevicesButton, function (event) {
          if (!trustedGesture(event)) return;
          refreshAudioDevices(true);
        });
        if (audioInputSelect) bind(audioInputSelect, 'change', function () {
          var selected = '';
          try { selected = audioInputSelect.value; } catch (_) {}
          saveAudioInput(selected);
          if (audioDeviceStatus) text(audioDeviceStatus, selected
            ? 'Selected microphone saved. Reina will use it on the next command.'
            : 'System default microphone selected.');
        });
        if (audioOutputSelect) bind(audioOutputSelect, 'change', function () {
          saveSetting(AUDIO_OUTPUT_STORAGE_KEY, selectedAudioOutput());
        });
        if (neuralVoiceSelect) {
          try { neuralVoiceSelect.value = storedSetting(NEURAL_VOICE_STORAGE_KEY, 'marin', ['marin', 'coral', 'nova', 'shimmer', 'sage']); } catch (_) {}
          bind(neuralVoiceSelect, 'change', function () { saveSetting(NEURAL_VOICE_STORAGE_KEY, selectedNeuralVoice()); });
        }
        if (voiceRateSelect) {
          try { voiceRateSelect.value = storedSetting(VOICE_RATE_STORAGE_KEY, '0.96', VOICE_RATES); } catch (_) {}
          bind(voiceRateSelect, 'change', function () { saveSetting(VOICE_RATE_STORAGE_KEY, String(selectedVoiceRate())); });
        }
        if (popupHistory) bindOwnedClick(popupHistory, function () {
          setSettingsOpen(false);
          try { page.feed.scrollTop = 0; } catch (_) {}
        });
        bindOwnedClick(view.voiceStop, function (event) { if (trustedGesture(event)) finishVoiceRecording(); });
        bindOwnedClick(view.voiceOff, function () { emergencyVoiceOff(); });
        installPopupGeometry();
        bind(page.input, 'keydown', function (event) {
          try {
            if (event && event.key === 'Enter' && event.shiftKey !== true) {
              if (isFunction(event.preventDefault)) event.preventDefault();
              submitFromInput();
            }
          } catch (_) { /* malformed event does nothing */ }
        });
      } else if (state === 'loading' && pendingSession) {
        return pendingSession.promise;
      } else if (state === 'ready' || state === 'submitting') {
        return Promise.resolve({ ok: true, sessionId: sessionId });
      }
      return startSession();
    }

    function resetSession() {
      if (disposed || !mounted) return Promise.resolve({ ok: false, reason: 'not_mounted' });
      cancelPendingSession('superseded');
      refreshedDuringTurn = false;
      epoch += 1;
      stopControllers();
      clearPresentation();
      state = 'idle';
      emitState('session_reset');
      return startSession();
    }

    function dispose() {
      if (disposed) return { disposed: true, executed: false };
      epoch += 1;
      disposed = true;
      refreshedDuringTurn = false;
      clearPanelAutoClose();
      cancelPendingSession('disposed');
      // A closed panel must not keep talking, or keep listening.
      spokenReplyPending = false;
      liveAbort();
      stopSpeaking();
      stopControllers();
      for (var i = 0; i < listeners.length; i += 1) {
        var listener = listeners[i];
        try {
          if (listener.property === true) {
            if (listener.node.onclick === listener.handler) listener.node.onclick = null;
          } else if (isFunction(listener.node.removeEventListener)) {
            listener.node.removeEventListener(listener.eventName, listener.handler);
          }
        } catch (_) { /* stale listener is inert */ }
      }
      listeners = [];
      clearPresentation();
      text(page.feed, '');
      hidePage(page);
      view = null;
      mounted = false;
      state = 'disposed';
      emitState(null);
      return { disposed: true, executed: false };
    }

    function noteAuthRefresh() {
      if (disposed || (state !== 'loading' && state !== 'submitting')) return false;
      refreshedDuringTurn = true;
      return true;
    }

    return Object.freeze({
      mount: mount,
      dispose: dispose,
      resetSession: resetSession,
      submitTyped: submitTyped,
      retryTurn: retryTurn,
      emergencyVoiceOff: emergencyVoiceOff,
      stopVoice: function () { stopVoice('voice_stopped'); return { stopped: true, executed: false }; },
      noteAuthRefresh: noteAuthRefresh,
      getState: function () { return snapshot(null); },
      getElements: function () { return page; },
      getViewElements: function () { return view; },
    });
  }

  function installReinaPilotPage(options) {
    options = options && typeof options === 'object' ? options : {};
    var documentRef = optionValue(options, 'documentRef', root && root.document ? root.document : null);
    var authClient = optionValue(options, 'authClient', root && root.sb ? root.sb : null);
    var createHost = optionValue(options, 'createHost', createReinaPilotHost);
    var page = resolveElements(documentRef);
    var authValue = ownData(authClient, 'auth');
    var auth = authValue.ok ? authValue.value : null;
    var getSession = captureBoundMethod(auth, 'getSession');
    var onAuthStateChangeMethod = captureBoundMethod(auth, 'onAuthStateChange');

    function getAccessToken() {
      if (!getSession) return Promise.reject(new Error('auth_expired'));
      var pending;
      try { pending = getSession(); } catch (_) { return Promise.reject(new Error('auth_expired')); }
      return Promise.resolve(pending).then(function (result) {
        var data = ownData(result, 'data');
        var session = data.ok ? ownData(data.value, 'session') : { ok: false };
        var user = session.ok ? ownData(session.value, 'user') : { ok: false };
        var principal = user.ok ? ownData(user.value, 'id') : { ok: false };
        var token = session.ok ? ownData(session.value, 'access_token') : { ok: false };
        if (!principal.ok || !safePrimitiveText(principal.value, 512, false)
          || principal.value !== activePrincipalId
          || !token.ok || !safePrimitiveText(token.value, 16384, false)) throw new Error('auth_expired');
        return token.value;
      }, function () { throw new Error('auth_expired'); });
    }

    var stopped = false;
    var host = null;
    var generation = 0;
    var subscription = null;
    var activePrincipalId = null;
    var activateRetryCount = 0;

    function sessionPrincipalId(session) {
      var user = ownData(session, 'user');
      if (!user.ok) return null;
      var id = ownData(user.value, 'id');
      return id.ok && safePrimitiveText(id.value, 512, false) ? id.value : null;
    }

    function currentHostState() {
      if (!host || !isFunction(host.getState)) return null;
      try {
        var value = host.getState();
        var stateValue = ownData(value, 'state');
        return stateValue.ok && typeof stateValue.value === 'string' ? stateValue.value : null;
      } catch (_) {
        return null;
      }
    }

    function deactivate() {
      generation += 1;
      var previous = host;
      host = null;
      activePrincipalId = null;
      if (previous && isFunction(previous.dispose)) {
        try { previous.dispose(); } catch (_) { /* presentation still hidden below */ }
      }
      hidePage(page);
      if (page) text(page.feed, '');
    }

    function makeHost() {
      if (!page || !isFunction(createHost)) return null;
      try {
        return createHost(Object.freeze({ documentRef: documentRef, elements: page, getAccessToken: getAccessToken }));
      } catch (_) {
        return null;
      }
    }

    function retryOrHide() {
      if (activateRetryCount < 3) {
        activateRetryCount += 1;
        var delay = activateRetryCount === 1 ? 2000 : (activateRetryCount === 2 ? 5000 : 10000);
        var myGenerationAtSchedule = generation;
        try { if (root && root.console && isFunction(root.console.warn)) root.console.warn('[Reina] session start failed, retry ' + activateRetryCount + '/3 in ' + delay + 'ms'); } catch (_) {}
        setTimeout(function () { if (!stopped && myGenerationAtSchedule === generation) activate(); }, delay);
      } else {
        try { if (root && root.console && isFunction(root.console.warn)) root.console.warn('[Reina] session start failed after 3 attempts, keeping pilot available'); } catch (_) {}
        showUnavailablePage(page);
      }
    }

    function activate() {
      if (stopped) return;
      var myGeneration = ++generation;
      if (!host) host = makeHost();
      if (!host) {
        showUnavailablePage(page);
        return;
      }
      var work;
      try {
        work = host.mount();
      } catch (_) {
        showUnavailablePage(page);
        return;
      }
      Promise.resolve(work).then(function (result) {
        if (stopped || myGeneration !== generation) return;
        if (!result || result.ok !== true) { retryOrHide(); } else { activateRetryCount = 0; }
      }, function () {
        if (stopped || myGeneration !== generation) return;
        retryOrHide();
      });
    }

    function onAuthStateChange(event, session) {
      if (stopped || typeof event !== 'string') return;
      if (event === 'SIGNED_OUT' || session == null) {
        deactivate();
        return;
      }
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN'
        || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        var nextPrincipalId = sessionPrincipalId(session);
        if (!nextPrincipalId) {
          deactivate();
          return;
        }
        if (!host) {
          activePrincipalId = nextPrincipalId;
          activate();
          return;
        }
        if (activePrincipalId && nextPrincipalId && activePrincipalId !== nextPrincipalId) {
          deactivate();
          activePrincipalId = nextPrincipalId;
          activate();
          return;
        }
        if (!activePrincipalId && nextPrincipalId) activePrincipalId = nextPrincipalId;
        var hostState = currentHostState();
        if (event === 'TOKEN_REFRESHED' && (hostState === 'loading' || hostState === 'submitting')
          && isFunction(host.noteAuthRefresh)) {
          try { host.noteAuthRefresh(); } catch (_) { /* the in-flight turn remains fenced */ }
        }
        if (hostState === 'unavailable' || hostState === 'auth_expired') activate();
      }
    }

    function stop() {
      if (stopped) return { stopped: true, executed: false };
      stopped = true;
      deactivate();
      if (subscription && isFunction(subscription.unsubscribe)) {
        try { subscription.unsubscribe(); } catch (_) { /* local teardown already complete */ }
      }
      subscription = null;
      try { if (root && root.hlReinaPilotStop === stop) root.hlReinaPilotStop = null; } catch (_) {}
      return { stopped: true, executed: false };
    }

    hidePage(page);
    if (!page || !auth || !onAuthStateChangeMethod || !getSession || !isFunction(createHost)) {
      return Object.freeze({
        installed: false,
        stop: stop,
        getHost: function () { return host; },
      });
    }

    var registered;
    try { registered = onAuthStateChangeMethod(onAuthStateChange); } catch (_) { registered = null; }
    try {
      var registeredData = ownData(registered, 'data');
      var subscriptionValue = registeredData.ok ? ownData(registeredData.value, 'subscription') : { ok: false };
      subscription = subscriptionValue.ok ? subscriptionValue.value : null;
    } catch (_) { subscription = null; }
    try { if (root) root.hlReinaPilotStop = stop; } catch (_) {}
    return Object.freeze({
      installed: true,
      stop: stop,
      getHost: function () { return host; },
    });
  }

  return Object.freeze({
      createReinaPilotHost: createReinaPilotHost,
      installReinaPilotPage: installReinaPilotPage,
      resolveElements: resolveElements,
      createNativeRecognitionFactory: createNativeRecognitionFactory,
      createCapturedNativeRecognitionFactory: createCapturedNativeRecognitionFactory,
      createNativeWakeRecognitionFactory: createNativeWakeRecognitionFactory,
      createCapturedNativeWakeRecognitionFactory: createCapturedNativeWakeRecognitionFactory,
      nativeRecognitionAvailable: CAPTURED_NATIVE_RECOGNITION !== null,
      nativeWakeRecognitionAvailable: CAPTURED_NATIVE_WAKE !== null,
      // Why Voice last refused to start, for support and for the console.
      // Read-only; it reports a decision, it cannot influence one.
      lastVoiceBlock: function () { return LAST_VOICE_BLOCK; },
      lastTurnBlock: function () { return LAST_TURN_BLOCK; },
      VOICE_RATES: VOICE_RATES,
      NATIVE_VOICE_MESSAGES: NATIVE_VOICE_MESSAGES,
      FIXED_ERRORS: FIXED_ERRORS,
    PAGE_IDS: PAGE_IDS,
  });
});
