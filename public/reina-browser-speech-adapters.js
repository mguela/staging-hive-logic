// public/reina-browser-speech-adapters.js
//
// Reina Evolution -- browser speech transport adapters.
//
// Two small, dependency-injected adapters that will later sit under
// public/reina-voice-session.js to give Reina an in-app voice connection:
//
//   1. createSpeechRecognitionAdapter -- turns raw browser speech-recognition
//      events (SpeechRecognition / webkitSpeechRecognition) into clean,
//      de-duplicated transcript events.
//   2. createSpeechPlaybackAdapter    -- speaks plain text the shared Reina
//      engine already produced, using browser speech synthesis.
//
// DESIGN CONTRACT (deliberately narrow -- these are TRANSPORT adapters):
//
//   * They are pure I/O plumbing. They carry NO identity, authorization,
//     role, company, tool list, or conversation history. They do not decide
//     what Reina says or whether the user is allowed to say it -- that is the
//     shared engine's job. They never open a model, prompt, endpoint, or
//     second "brain".
//   * Every browser dependency (the recognition constructor, the synthesis
//     object, the utterance constructor) is INJECTED, so the tests drive them
//     with fakes and need no real microphone or speakers.
//   * They FAIL CLOSED. If the browser speech APIs are missing, recognition
//     start and playback speak refuse and report 'unavailable' instead of
//     throwing or silently doing nothing dangerous.
//
// The file is a plain ES module (matches the repo's other importable .js).
// It also attaches a `window.ReinaBrowserSpeechAdapters` global so a plain
// <script type="module"> include -- or later wiring -- can pick it up.

'use strict';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// A minimal listener fan-out. Adapters emit plain event objects; callers pass
// a single `onEvent` handler and/or subscribe with `.on(fn)`. A throwing
// listener never breaks the adapter or the other listeners.
function makeEmitter(onEvent) {
  const listeners = new Set();
  if (typeof onEvent === 'function') listeners.add(onEvent);
  return {
    on(fn) {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (_e) {
          /* a listener's failure must not corrupt adapter state */
        }
      }
    },
  };
}

// Markup / SSML sniff. We never INTERPRET or MODIFY response text, so the only
// safe move when text carries angle-bracket markup (HTML or SSML such as
// <speak>, <break>, <prosody>) is to refuse it outright -- stripping would be
// "modifying the response", which is also disallowed.
const MARKUP_RE = /<[^>]*>/;

function looksLikeMarkup(text) {
  return typeof text === 'string' && MARKUP_RE.test(text);
}

// ---------------------------------------------------------------------------
// 1. Speech-recognition adapter
// ---------------------------------------------------------------------------
//
// Injected dependency:
//   recognitionFactory() -> a browser-SpeechRecognition-like object with:
//       .lang, .interimResults, .continuous  (writable config)
//       .start(), .stop(), .abort()
//       .onstart, .onresult, .onerror, .onend  (assignable handlers)
//     Its onresult event mirrors the DOM shape:
//       { resultIndex, results: [ { isFinal, length, 0:{ transcript } } ] }
//     Its onerror event mirrors: { error: '<code-string>' }
//
// Emitted events (via onEvent / .on):
//   { type:'start',   generation }
//   { type:'interim', generation, transcript }   display-only, never submitted
//   { type:'final',   generation, transcript }   at most ONE per generation
//   { type:'unclear', generation, reason }       report-for-confirmation
//   { type:'error',   generation, code }         normalized code (see below)
//   { type:'end',     generation, reason }       'stopped' | 'aborted' | 'natural'
//
// Normalized error codes:
//   'unavailable'        -- API missing / audio-capture / network
//   'denied'             -- permission not granted
//   'timeout'            -- no-speech style timeout surfaced as timeout
//   'no-speech'          -- recognizer heard nothing
//   'recognition-error'  -- any other recognizer failure
//
// A "generation" is one start()..end() lifecycle. Every recognition instance
// is tagged with the generation that created it; any event that arrives tagged
// with an older generation (a late result after abort, a rapid restart, a
// zombie onend) is dropped as stale. Within a live generation, the first usable
// final settles it -- later finals/interims are suppressed as duplicates.

export function createSpeechRecognitionAdapter(options = {}) {
  const { recognitionFactory, onEvent, requestMicrophone, lang = 'en-US' } = options;

  const emitter = makeEmitter(onEvent);

  // Support check is a pure function of the injected dependency -- fail closed.
  const supported = typeof recognitionFactory === 'function';
  const canPreflight = typeof requestMicrophone === 'function';

  let generation = 0; // increments on every start()
  let current = null; // the live recognition instance, or null
  let currentGen = 0; // generation of `current`
  let settled = false; // a final/unclear already emitted this generation
  let lastInterim = null; // last interim text, to suppress duplicate interims
  let lastFinal = null; // last final text emitted, to suppress duplicate finals
  let stopping = false; // graceful stop requested (keep pending final)
  let pendingPreflight = null; // an explicit, user-triggered microphone probe

  function normalizeError(raw) {
    switch (raw) {
      case 'not-allowed':
      case 'service-not-allowed':
        return 'denied';
      case 'no-speech':
        return 'no-speech';
      case 'no-microphone':
        return 'no-microphone';
      case 'device-busy':
        return 'device-busy';
      case 'unavailable':
        return 'unavailable';
      // These need distinct user-facing handling. A successful microphone
      // preflight does not prove that Chrome's separate recognition service is
      // reachable or can capture audio, so do not collapse either condition.
      case 'audio-capture':
        return 'audio-capture';
      case 'network':
        return 'network';
      case 'timeout':
        return 'timeout';
      case 'transcription-auth':
      case 'transcription-bad-audio':
      case 'transcription-rate-limited':
      case 'transcription-unavailable':
      // Audio reached transcription and came back with no words -- distinct
      // from 'no-speech', which means the microphone captured nothing.
      case 'transcription-no-speech':
      // The transcription attempt never answered at all.
      case 'transcription-timeout':
      // The recording was audible only as noise -- the input is not hearing
      // the speaker, which no amount of retrying transcription can fix.
      case 'input-too-quiet':
      // The other end of the same problem: the signal is railed and the
      // waveform above the ceiling has been flattened away.
      case 'input-too-loud':
      // getUserMedia never settled, so recording never began.
      case 'microphone-open-timeout':
        return raw;
      default:
        return 'recognition-error';
    }
  }

  // Pull the top-alternative transcript out of the final results, trimmed.
  // We NEVER read a confidence score or invent a threshold -- clarity is
  // decided by whether the recognizer produced any words at all.
  function extractFinal(ev) {
    let out = '';
    const results = (ev && ev.results) || [];
    const from = ev && typeof ev.resultIndex === 'number' ? ev.resultIndex : 0;
    for (let i = from; i < results.length; i++) {
      const r = results[i];
      if (r && r.isFinal && r[0] && typeof r[0].transcript === 'string') {
        out += r[0].transcript;
      }
    }
    return out.trim();
  }

  function extractInterim(ev) {
    let out = '';
    const results = (ev && ev.results) || [];
    const from = ev && typeof ev.resultIndex === 'number' ? ev.resultIndex : 0;
    for (let i = from; i < results.length; i++) {
      const r = results[i];
      if (r && !r.isFinal && r[0] && typeof r[0].transcript === 'string') {
        out += r[0].transcript;
      }
    }
    return out.trim();
  }

  // True only for events coming from the current, live recognition instance.
  function isLive(instance, gen) {
    return instance === current && gen === currentGen && gen === generation;
  }

  function detach(instance) {
    if (!instance) return;
    instance.onstart = null;
    instance.onresult = null;
    instance.onerror = null;
    instance.onend = null;
  }

  // Hard tear-down of the live instance without emitting a natural 'end'.
  // Used by abort()/interrupt() and by rapid restart.
  function teardownCurrent() {
    const dead = current;
    // Advance the generation FIRST so any late event from `dead` is stale.
    current = null;
    generation++;
    settled = true;
    stopping = false;
    if (dead) {
      try {
        dead.abort();
      } catch (_e) {
        /* browser abort may throw on an already-dead recognizer */
      }
      detach(dead);
    }
  }

  function stopTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    try {
      const tracks = stream.getTracks();
      if (!Array.isArray(tracks)) return;
      tracks.forEach((track) => {
        try {
          if (track && typeof track.stop === 'function') track.stop();
        } catch (_e) {}
      });
    } catch (_e) {}
  }

  function preflightError(error) {
    const name = error && typeof error.name === 'string' ? error.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'denied';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no-microphone';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'device-busy';
    return 'unavailable';
  }

  function wire(instance, gen) {
    instance.onstart = function () {
      if (!isLive(instance, gen)) return;
      emitter.emit({ type: 'start', generation: gen });
    };

    instance.onresult = function (ev) {
      if (!isLive(instance, gen)) return; // stale / late result -> drop
      if (settled) return; // one final per generation already handled

      const finalText = extractFinal(ev);
      if (finalText) {
        // Duplicate final (same words as the last emitted final) -> drop.
        if (finalText === lastFinal) {
          settled = true;
          return;
        }
        settled = true;
        lastFinal = finalText;
        emitter.emit({ type: 'final', generation: gen, transcript: finalText });
        return;
      }

      // No final words yet -- see if there is an interim to display.
      const interimText = extractInterim(ev);
      if (interimText) {
        if (interimText === lastInterim) return; // duplicate interim -> drop
        lastInterim = interimText;
        // Interim is DISPLAY-ONLY. It is never a submission and never settles
        // the generation.
        emitter.emit({ type: 'interim', generation: gen, transcript: interimText });
        return;
      }

      // A final result arrived but carried no usable words: unclear speech.
      // Report it for confirmation -- do NOT guess or fabricate a transcript.
      const results = (ev && ev.results) || [];
      const hadFinalResult = Array.prototype.some.call(results, (r) => r && r.isFinal);
      if (hadFinalResult) {
        settled = true;
        emitter.emit({ type: 'unclear', generation: gen, reason: 'empty-final' });
      }
    };

    instance.onerror = function (ev) {
      if (!isLive(instance, gen)) return; // stale error -> drop
      const raw = ev && ev.error;
      // 'aborted' is a normal consequence of stop()/abort()/interrupt(); it is
      // not a user-facing error. Let onend deliver the end event instead.
      if (raw === 'aborted') return;
      const code = normalizeError(raw);
      // We report the error and do NOT retry or restart automatically.
      emitter.emit({ type: 'error', generation: gen, code });
    };

    instance.onend = function () {
      if (!isLive(instance, gen)) return; // stale / zombie end -> drop
      const reason = stopping ? 'stopped' : 'natural';
      // Retire this generation. Nothing is auto-resubmitted or auto-restarted.
      current = null;
      generation++;
      settled = true;
      stopping = false;
      detach(instance);
      emitter.emit({ type: 'end', generation: gen, reason });
    };
  }

  function beginRecognition() {
    let instance;
    try {
      instance = recognitionFactory();
    } catch (_e) {
      emitter.emit({ type: 'error', generation: generation, code: 'unavailable' });
      return false;
    }
    if (!instance) {
      emitter.emit({ type: 'error', generation: generation, code: 'unavailable' });
      return false;
    }

    generation++;
    const gen = generation;
    current = instance;
    currentGen = gen;
    settled = false;
    stopping = false;
    lastInterim = null;
    try {
      instance.lang = lang;
      instance.interimResults = true;
      instance.continuous = false;
    } catch (_e) {}
    wire(instance, gen);
    try {
      const started = instance.start();
      if (started && typeof started.then === 'function') {
        return Promise.resolve(started).then(
          (ok) => {
            if (ok === true) return true;
            if (isLive(instance, gen)) {
              current = null;
              detach(instance);
              emitter.emit({ type: 'error', generation: gen, code: 'unavailable' });
            }
            return false;
          },
          () => {
            if (isLive(instance, gen)) {
              current = null;
              detach(instance);
              emitter.emit({ type: 'error', generation: gen, code: 'unavailable' });
            }
            return false;
          },
        );
      }
    } catch (_e) {
      current = null;
      detach(instance);
      emitter.emit({ type: 'error', generation: gen, code: 'unavailable' });
      return false;
    }
    return true;
  }

  return {
    isSupported() {
      return supported;
    },

    // Are we currently listening?
    isListening() {
      return current !== null;
    },

    // Begin a new recognition generation. Returns true if recognition started.
    // Fails closed (emits 'unavailable') if the API is missing or the browser
    // constructor throws. A rapid second start() cleanly retires the first.
    start() {
      if (!supported) {
        emitter.emit({ type: 'error', generation: generation, code: 'unavailable' });
        return false;
      }
      // Rapid restart: retire any in-flight recognition first so its late
      // events are dropped as stale.
      if (current) teardownCurrent();
      if (!canPreflight) return beginRecognition();
      const token = {};
      pendingPreflight = token;
      return Promise.resolve()
        .then(() => requestMicrophone())
        .then((stream) => {
          stopTracks(stream);
          if (pendingPreflight !== token) return false;
          pendingPreflight = null;
          return beginRecognition();
        }, (error) => {
          if (pendingPreflight !== token) return false;
          pendingPreflight = null;
          emitter.emit({ type: 'error', generation: generation, code: preflightError(error) });
          return false;
        });
    },

    // Graceful stop: ask the recognizer to finish. A final it delivers on the
    // way down is still honored; onend then closes the generation.
    stop() {
      pendingPreflight = null;
      if (!current) return;
      stopping = true;
      try {
        current.stop();
      } catch (_e) {
        /* if stop throws, fall back to a hard teardown + explicit end */
        const gen = currentGen;
        teardownCurrent();
        emitter.emit({ type: 'end', generation: gen, reason: 'stopped' });
      }
    },

    // Hard abort: discard the current generation immediately. Any pending or
    // late result is dropped. Emits a single 'end' with reason 'aborted'.
    abort() {
      pendingPreflight = null;
      if (!current) return;
      const gen = currentGen;
      teardownCurrent();
      emitter.emit({ type: 'end', generation: gen, reason: 'aborted' });
    },

    // Barge-in interruption (e.g. the user starts talking over playback). Same
    // hard semantics as abort but named for intent so callers read cleanly.
    interrupt() {
      pendingPreflight = null;
      if (!current) return;
      const gen = currentGen;
      teardownCurrent();
      emitter.emit({ type: 'end', generation: gen, reason: 'aborted' });
    },

    on(fn) {
      return emitter.on(fn);
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Speech-playback adapter
// ---------------------------------------------------------------------------
//
// Injected dependencies:
//   synthesis         -- a speechSynthesis-like object with .speak(u), .cancel()
//   utteranceFactory(text) -> a SpeechSynthesisUtterance-like object with a
//                             .text property and assignable .onstart/.onend/
//                             .onerror handlers.
//
// speak(text, { allow, turn }) contract:
//   * PLAYBACK IS DENIED UNLESS `allow === true`. The caller (the voice
//     session, gated by the shared engine) must explicitly permit each turn.
//   * `text` must be plain text ALREADY produced by the shared engine. We do
//     not model, prompt, summarize, or modify it. Markup (HTML/SSML) is
//     refused, not stripped.
//   * `turn` is an optional monotonic sequence number. A speak whose turn is
//     older than the newest requested turn is dropped as stale, and starting a
//     newer turn cancels the previous utterance (barge-in / superseded reply).
//
// Emitted events:
//   { type:'start',       turn }
//   { type:'end',         turn }                 natural completion
//   { type:'stopped',     turn }                 explicit stop()
//   { type:'interrupted', turn }                 superseded by a newer turn
//   { type:'denied',   reason }  'not-allowed' | 'muted' | 'empty' | 'stale' | 'unavailable'
//   { type:'error',    code }    'unavailable' | 'unsafe-text' | 'synthesis-error'

export function createSpeechPlaybackAdapter(options = {}) {
  const { synthesis, utteranceFactory, onEvent } = options;

  const emitter = makeEmitter(onEvent);

  const supported =
    !!synthesis &&
    typeof synthesis.speak === 'function' &&
    typeof synthesis.cancel === 'function' &&
    typeof utteranceFactory === 'function';

  let muted = false;
  let turnSeq = 0; // newest turn number we have accepted
  let activeUtterance = null; // currently speaking utterance
  let activeTurn = 0; // its turn number
  let activeSettled = false; // its end/error/stop already emitted

  // Cancel whatever is speaking without emitting a natural end. `emitType` (if
  // given) is emitted for the outgoing turn ('stopped' | 'interrupted').
  function cancelActive(emitType) {
    const dying = activeUtterance;
    const dyingTurn = activeTurn;
    activeUtterance = null;
    activeSettled = true;
    if (dying) {
      dying.onstart = null;
      dying.onend = null;
      dying.onerror = null;
    }
    if (synthesis && typeof synthesis.cancel === 'function') {
      try {
        synthesis.cancel();
      } catch (_e) {
        /* cancel on an idle synth may throw in some browsers */
      }
    }
    if (emitType && dying) {
      emitter.emit({ type: emitType, turn: dyingTurn });
    }
  }

  return {
    isSupported() {
      return supported;
    },

    isSpeaking() {
      return activeUtterance !== null;
    },

    isMuted() {
      return muted;
    },

    // Speak plain engine text. Denied unless explicitly allowed. Returns true
    // only if the utterance was handed to the synthesizer.
    speak(text, opts = {}) {
      const allow = opts.allow === true;
      const turn = typeof opts.turn === 'number' ? opts.turn : turnSeq + 1;

      // Fail closed if the browser synthesis API is unavailable.
      if (!supported) {
        emitter.emit({ type: 'denied', reason: 'unavailable' });
        return false;
      }
      // Explicit-allow gate: no allow, no audio.
      if (!allow) {
        emitter.emit({ type: 'denied', reason: 'not-allowed' });
        return false;
      }
      // Stale turn: a newer reply has already been requested; drop this one.
      if (turn < turnSeq) {
        emitter.emit({ type: 'denied', reason: 'stale' });
        return false;
      }
      // Refuse markup outright -- we neither interpret nor modify the text.
      if (looksLikeMarkup(text)) {
        emitter.emit({ type: 'error', code: 'unsafe-text' });
        return false;
      }
      // Nothing to say.
      if (typeof text !== 'string' || text.trim() === '') {
        emitter.emit({ type: 'denied', reason: 'empty' });
        return false;
      }
      // Muted: accept the turn (advance the sequence, cancel any prior speech)
      // but produce no audio.
      if (muted) {
        turnSeq = turn;
        cancelActive('interrupted');
        emitter.emit({ type: 'denied', reason: 'muted' });
        return false;
      }

      // A newer turn supersedes anything currently speaking.
      turnSeq = turn;
      cancelActive('interrupted');

      let utterance;
      try {
        // We pass the text THROUGH verbatim -- no modification, no summary.
        utterance = utteranceFactory(String(text));
      } catch (_e) {
        emitter.emit({ type: 'error', code: 'unavailable' });
        return false;
      }
      if (!utterance) {
        emitter.emit({ type: 'error', code: 'unavailable' });
        return false;
      }

      activeUtterance = utterance;
      activeTurn = turn;
      activeSettled = false;
      const myTurn = turn;

      utterance.onstart = function () {
        if (utterance !== activeUtterance) return; // stale
        emitter.emit({ type: 'start', turn: myTurn });
      };
      utterance.onend = function () {
        if (utterance !== activeUtterance || activeSettled) return; // stale/superseded
        activeSettled = true;
        activeUtterance = null;
        emitter.emit({ type: 'end', turn: myTurn });
      };
      utterance.onerror = function (ev) {
        if (utterance !== activeUtterance || activeSettled) return; // stale/superseded
        activeSettled = true;
        activeUtterance = null;
        // 'interrupted'/'canceled' are the normal result of cancel(); not errors.
        const raw = ev && ev.error;
        if (raw === 'interrupted' || raw === 'canceled') return;
        emitter.emit({ type: 'error', code: 'synthesis-error' });
      };

      try {
        synthesis.speak(utterance);
      } catch (_e) {
        activeUtterance = null;
        activeSettled = true;
        emitter.emit({ type: 'error', code: 'synthesis-error' });
        return false;
      }
      return true;
    },

    // Explicit stop of the current turn. Emits 'stopped' for it.
    stop() {
      if (!activeUtterance) {
        // Still cancel the synth defensively, but nothing to announce.
        if (supported) {
          try {
            synthesis.cancel();
          } catch (_e) {
            /* ignore */
          }
        }
        return;
      }
      cancelActive('stopped');
    },

    // Barge-in interruption of the current turn. Emits 'interrupted' for it.
    interrupt() {
      if (!activeUtterance) return;
      cancelActive('interrupted');
    },

    // Mute/unmute. Muting cancels any in-flight speech; while muted, speak()
    // accepts and sequences turns but emits no audio.
    mute() {
      muted = true;
      cancelActive('interrupted');
    },
    unmute() {
      muted = false;
    },
    setMuted(v) {
      if (v) this.mute();
      else this.unmute();
    },

    on(fn) {
      return emitter.on(fn);
    },
  };
}

// ---------------------------------------------------------------------------
// Browser global (for plain <script type="module"> include / later wiring).
// No effect under Node/test where `window` is undefined.
// ---------------------------------------------------------------------------
if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined') {
  globalThis.window.ReinaBrowserSpeechAdapters = {
    createSpeechRecognitionAdapter,
    createSpeechPlaybackAdapter,
  };
}

export default {
  createSpeechRecognitionAdapter,
  createSpeechPlaybackAdapter,
};
