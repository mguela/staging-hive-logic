/* Natural Reina playback. This is the only browser playback source used by
 * the HiveLogic popup; it never falls back to SpeechSynthesis/system voices. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaNeuralSpeech = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ALLOWED_VOICES = Object.freeze(['marin', 'coral', 'nova', 'shimmer', 'sage']);
  var MIN_RATE = 0.75;
  var MAX_RATE = 1.75;
  var SILENT_WAV = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

  function allowedVoice(value) {
    return typeof value === 'string' && ALLOWED_VOICES.indexOf(value) >= 0 ? value : 'marin';
  }

  function createNeuralSynthesis(options) {
    options = options && typeof options === 'object' ? options : {};
    var fetchFn = options.fetchFn;
    var getAccessToken = options.getAccessToken;
    var AudioCtor = options.AudioCtor;
    var createObjectURL = options.createObjectURL;
    var revokeObjectURL = options.revokeObjectURL;
    var getVoice = typeof options.getVoice === 'function' ? options.getVoice : function () { return 'marin'; };
    var getRate = typeof options.getRate === 'function' ? options.getRate : function () { return 0.96; };
    var getOutputDevice = typeof options.getOutputDevice === 'function' ? options.getOutputDevice : function () { return ''; };
    if (typeof fetchFn !== 'function' || typeof getAccessToken !== 'function'
      || typeof AudioCtor !== 'function' || typeof createObjectURL !== 'function'
      || typeof revokeObjectURL !== 'function') return null;

    var current = null;
    var primedAudio = null;
    function cleanup(active) {
      if (!active) return;
      try { if (active.audio) { active.audio.pause(); active.audio.src = ''; } } catch (_) {}
      try { if (active.url) revokeObjectURL(active.url); } catch (_) {}
      if (current === active) current = null;
    }
    function fail(active, code) {
      if (!active || current !== active) return;
      var utterance = active.utterance;
      cleanup(active);
      try { if (typeof utterance.onerror === 'function') utterance.onerror({ error: code || 'synthesis-failed' }); } catch (_) {}
    }
    function cancel() {
      var active = current;
      if (!active) return;
      current = null;
      try { if (active.controller) active.controller.abort(); } catch (_) {}
      cleanup(active);
    }

    function unlock() {
      if (primedAudio) return true;
      var audio;
      try {
        audio = new AudioCtor(SILENT_WAV);
        // A muted warm-up is allowed even when autoplay is blocked, so it does
        // not prove that Chrome will permit the later audible reply. Prime the
        // reusable player as technically audible during the trusted purple-tab
        // gesture, while playing a genuinely silent WAV at near-zero volume.
        // The real response restores full volume before playback.
        audio.muted = false;
        audio.volume = 0.001;
        audio.preload = 'auto';
        audio.playsInline = true;
        primedAudio = audio;
        var started = audio.play();
        Promise.resolve(started).then(function () {
          // Do not interrupt real speech if the network response won this race
          // and reused the gesture-authorized player already.
          if (current && current.audio === audio) return;
          try { audio.pause(); audio.currentTime = 0; } catch (_) {}
        }, function () {
          if (!current || current.audio !== audio) primedAudio = null;
        });
        return true;
      } catch (_) {
        if (primedAudio === audio) primedAudio = null;
        return false;
      }
    }

    return Object.freeze({
      // Must be called synchronously from the user's purple-button gesture.
      // The same HTMLAudioElement is then reused after the async TTS response,
      // preventing Chrome from rejecting delayed playback as autoplay.
      unlock: unlock,
      cancel: cancel,
      speak: function (utterance) {
        var text = utterance && typeof utterance.text === 'string' ? utterance.text.trim() : '';
        if (!text || text.length > 6000
          || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\p{Cf}\p{Cs}]/u.test(text)
          || /<[^>]*>|javascript\s*:/iu.test(text)) {
          try { if (utterance && typeof utterance.onerror === 'function') utterance.onerror({ error: 'unsafe-text' }); } catch (_) {}
          return;
        }
        cancel();
        var AbortCtor = options.AbortControllerCtor;
        var active = { utterance: utterance, controller: typeof AbortCtor === 'function' ? new AbortCtor() : null, audio: null, url: '' };
        current = active;
        Promise.resolve().then(function () { return getAccessToken(); }).then(function (token) {
          if (current !== active || typeof token !== 'string' || !token) throw new Error('auth');
          // Do not pin this token into the request. HiveLogic's same-origin
          // fetch wrapper owns bearer injection and, critically, its one-time
          // refresh-and-retry path for a laptop/session that has gone stale.
          // Supplying Authorization here would mark it caller-owned and bypass
          // that recovery path, which caused production neural speech to 401.
          return fetchFn('/api/reina-neural-speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text, voice: allowedVoice(getVoice()) }),
            cache: 'no-store',
            signal: active.controller ? active.controller.signal : undefined,
          });
        }).then(function (response) {
          var contentType = '';
          try { contentType = response.headers.get('content-type') || ''; } catch (_) {}
          if (current !== active || !response || response.status !== 200
            || !/^audio\/(?:mpeg|mp3)/i.test(contentType) || typeof response.blob !== 'function') throw new Error('response');
          return response.blob();
        }).then(function (blob) {
          if (current !== active || !blob || typeof blob.size !== 'number' || blob.size < 100) throw new Error('audio');
          active.url = createObjectURL(blob);
          active.audio = primedAudio || new AudioCtor(active.url);
          active.audio.muted = false;
          active.audio.volume = 1;
          active.audio.src = active.url;
          // The old ceiling was 1.18 -- a tenth faster than normal, which is
          // not a speed control, it is a rounding error. Chrome preserves
          // pitch across playbackRate, so a genuinely quicker Reina still
          // sounds like Reina. Anything outside the range falls back to
          // natural rather than to silence.
          var rate = Number(getRate());
          active.audio.playbackRate = Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE ? rate : 0.96;
          active.audio.onplay = function () {
            if (current !== active) return;
            try { if (typeof utterance.onstart === 'function') utterance.onstart({}); } catch (_) {}
          };
          active.audio.onended = function () {
            if (current !== active) return;
            cleanup(active);
            try { if (typeof utterance.onend === 'function') utterance.onend({}); } catch (_) {}
          };
          active.audio.onerror = function () { fail(active, 'neural-voice-unavailable'); };
          var output = getOutputDevice();
          var routed = output && typeof active.audio.setSinkId === 'function'
            ? Promise.resolve(active.audio.setSinkId(output)).catch(function () {
              // Output-device IDs can become stale after a reboot, docking,
              // Bluetooth changes, or browser permission changes. Never let a
              // stale preference silence Reina: return to the system default
              // speaker and continue playback.
              try { return Promise.resolve(active.audio.setSinkId('')).catch(function () {}); }
              catch (_) { return Promise.resolve(); }
            }) : Promise.resolve();
          return routed.then(function () { return active.audio.play(); });
        }).catch(function () { fail(active, 'neural-voice-unavailable'); });
      },
    });
  }

  function createUtterance(text) { return { text: String(text == null ? '' : text), onstart: null, onend: null, onerror: null }; }
  return Object.freeze({
    createNeuralSynthesis: createNeuralSynthesis,
    createUtterance: createUtterance,
    ALLOWED_VOICES: ALLOWED_VOICES,
    MIN_RATE: MIN_RATE,
    MAX_RATE: MAX_RATE,
  });
});
