// test/reina-browser-speech-adapters.test.mjs
//
// Adversarial tests for the browser speech transport adapters. Everything is
// driven through INJECTED fakes -- no real microphone, speakers, or browser.
// Focus: the safety contract, not the happy path -- duplicate finals, stale
// generations, late events after abort, rapid restart, permission denial,
// unclear transcripts, playback policy denial, stale playback, interruption,
// thrown browser APIs, and unsafe (markup/SSML) text.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSpeechRecognitionAdapter,
  createSpeechPlaybackAdapter,
} from '../public/reina-browser-speech-adapters.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// Browser-SpeechRecognition-like fake. Test code fires events explicitly.
class FakeRecognition {
  constructor() {
    this.lang = null;
    this.interimResults = null;
    this.continuous = null;
    this.started = false;
    this.stopped = false;
    this.aborted = false;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  }
  start() {
    this.started = true;
    if (this.onstart) this.onstart({});
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  // --- test drivers ---
  fireResult(ev) {
    if (this.onresult) this.onresult(ev);
  }
  fireError(code) {
    if (this.onerror) this.onerror({ error: code });
  }
  fireEnd() {
    if (this.onend) this.onend({});
  }
}

// DOM-shaped result events.
function finalResult(transcript) {
  return { resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript } }] };
}
function interimResult(transcript) {
  return { resultIndex: 0, results: [{ isFinal: false, length: 1, 0: { transcript } }] };
}
function emptyFinalResult() {
  // A final result that carried no usable words -> "unclear".
  return { resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript: '   ' } }] };
}

// Build a recognition adapter wired to a fresh recognizer list + event log.
function makeRec(overrides = {}) {
  const recs = [];
  const events = [];
  const factory =
    'recognitionFactory' in overrides
      ? overrides.recognitionFactory
      : () => {
          const r = new FakeRecognition();
          recs.push(r);
          return r;
        };
  const adapter = createSpeechRecognitionAdapter({
    recognitionFactory: factory,
    onEvent: (e) => events.push(e),
    ...(({ recognitionFactory, ...rest }) => rest)(overrides),
  });
  return { adapter, recs, events, types: () => events.map((e) => e.type) };
}

// Browser-SpeechSynthesis-like fakes.
class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
  fireStart() {
    if (this.onstart) this.onstart({});
  }
  fireEnd() {
    if (this.onend) this.onend({});
  }
  fireError(code) {
    if (this.onerror) this.onerror({ error: code });
  }
}
class FakeSynthesis {
  constructor() {
    this.spoken = [];
    this.cancelled = 0;
  }
  speak(u) {
    this.spoken.push(u);
  }
  cancel() {
    this.cancelled++;
  }
}

function makePlay(overrides = {}) {
  const utts = [];
  const events = [];
  const synthesis = 'synthesis' in overrides ? overrides.synthesis : new FakeSynthesis();
  const utteranceFactory =
    'utteranceFactory' in overrides
      ? overrides.utteranceFactory
      : (text) => {
          const u = new FakeUtterance(text);
          utts.push(u);
          return u;
        };
  const adapter = createSpeechPlaybackAdapter({
    synthesis,
    utteranceFactory,
    onEvent: (e) => events.push(e),
  });
  return { adapter, synthesis, utts, events, types: () => events.map((e) => e.type) };
}

// ===========================================================================
// Speech-recognition adapter
// ===========================================================================

test('recognition: happy path emits start -> interim -> final -> end', () => {
  const { adapter, recs, events, types } = makeRec();
  assert.equal(adapter.isSupported(), true);
  assert.equal(adapter.start(), true);
  const rec = recs[0];
  rec.fireResult(interimResult('hello wor'));
  rec.fireResult(finalResult('hello world'));
  rec.fireEnd();

  assert.deepEqual(types(), ['start', 'interim', 'final', 'end']);
  const final = events.find((e) => e.type === 'final');
  assert.equal(final.transcript, 'hello world');
  const end = events.find((e) => e.type === 'end');
  assert.equal(end.reason, 'natural');
});

test('recognition: interim is display-only and never becomes a submission', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start();
  recs[0].fireResult(interimResult('draft one'));
  recs[0].fireResult(interimResult('draft two'));
  // Two interims, zero finals -- nothing has been "submitted".
  assert.equal(events.filter((e) => e.type === 'interim').length, 2);
  assert.equal(events.filter((e) => e.type === 'final').length, 0);
});

test('recognition: duplicate finals collapse to exactly one per generation', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start();
  recs[0].fireResult(finalResult('confirm order'));
  recs[0].fireResult(finalResult('confirm order')); // duplicate
  recs[0].fireResult(finalResult('confirm order')); // duplicate
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
});

test('recognition: identical final across generations is suppressed as duplicate', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start();
  recs[0].fireResult(finalResult('yes'));
  recs[0].fireEnd();
  adapter.start(); // new generation
  recs[1].fireResult(finalResult('yes')); // same words -> duplicate
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
});

test('recognition: unclear (empty final) is reported for confirmation, not guessed', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start();
  recs[0].fireResult(emptyFinalResult());
  const unclear = events.find((e) => e.type === 'unclear');
  assert.ok(unclear, 'expected an unclear event');
  assert.equal(unclear.reason, 'empty-final');
  // A real final arriving afterwards in the same generation is suppressed --
  // we never overwrite the confirmation prompt with a guess.
  recs[0].fireResult(finalResult('maybe this'));
  assert.equal(events.filter((e) => e.type === 'final').length, 0);
});

test('recognition: abort emits one end and drops late results/ends', () => {
  const { adapter, recs, events, types } = makeRec();
  adapter.start();
  const rec = recs[0];
  adapter.abort();
  assert.equal(rec.aborted, true);
  const before = types().join(',');
  // Late events after abort must be ignored.
  rec.fireResult(finalResult('too late'));
  rec.fireEnd();
  assert.equal(types().join(','), before);
  assert.equal(events.filter((e) => e.type === 'end').length, 1);
  assert.equal(events.find((e) => e.type === 'end').reason, 'aborted');
  assert.equal(events.filter((e) => e.type === 'final').length, 0);
});

test('recognition: stale generation events are dropped on rapid restart', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start(); // rec0
  adapter.start(); // rapid restart -> rec1, rec0 retired
  assert.equal(recs.length, 2);
  assert.equal(recs[0].aborted, true, 'first recognizer should be aborted');

  // A late final from the STALE recognizer is ignored...
  recs[0].fireResult(finalResult('stale words'));
  assert.equal(events.filter((e) => e.type === 'final').length, 0);

  // ...while the live recognizer's final is emitted exactly once.
  recs[1].fireResult(finalResult('fresh words'));
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].transcript, 'fresh words');
});

test('recognition: permission denial normalizes to "denied" and does NOT retry', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start();
  recs[0].fireError('not-allowed');
  const err = events.find((e) => e.type === 'error');
  assert.equal(err.code, 'denied');
  // No automatic restart: still exactly one recognizer was ever created.
  assert.equal(recs.length, 1);

  // service-not-allowed maps the same way.
  const b = makeRec();
  b.adapter.start();
  b.recs[0].fireError('service-not-allowed');
  assert.equal(b.events.find((e) => e.type === 'error').code, 'denied');
});

test('recognition: error codes preserve actionable raw causes', () => {
  const cases = [
    ['no-speech', 'no-speech'],
    ['timeout', 'timeout'],
    ['audio-capture', 'audio-capture'],
    ['network', 'network'],
    ['no-microphone', 'no-microphone'],
    ['device-busy', 'device-busy'],
    ['unavailable', 'unavailable'],
    ['language-not-supported', 'recognition-error'],
  ];
  for (const [raw, expected] of cases) {
    const { adapter, recs, events } = makeRec();
    adapter.start();
    recs[0].fireError(raw);
    assert.equal(events.find((e) => e.type === 'error').code, expected, `raw=${raw}`);
  }
});

test('recognition: "aborted" browser error is not surfaced as an error', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start();
  recs[0].fireError('aborted');
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
});

test('recognition: fails closed when the API is unavailable', () => {
  const { adapter, events } = makeRec({ recognitionFactory: undefined });
  assert.equal(adapter.isSupported(), false);
  assert.equal(adapter.start(), false);
  assert.equal(events.find((e) => e.type === 'error').code, 'unavailable');
});

test('recognition: thrown browser constructor fails closed', () => {
  const { adapter, events } = makeRec({
    recognitionFactory: () => {
      throw new Error('SecurityError');
    },
  });
  assert.equal(adapter.start(), false);
  assert.equal(events.find((e) => e.type === 'error').code, 'unavailable');
});

test('recognition: microphone preflight opens and releases audio before recognition starts', async () => {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop() { stopped += 1; } }] };
  const { adapter, recs, events } = makeRec({
    requestMicrophone: async () => stream,
  });
  assert.equal(await adapter.start(), true);
  assert.equal(stopped, 1);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].started, true);
  assert.equal(events.some((event) => event.type === 'start'), true);
});

test('recognition: denied or missing microphone preflight never constructs recognition', async () => {
  const denied = makeRec({
    requestMicrophone: async () => { const error = new Error('no'); error.name = 'NotAllowedError'; throw error; },
  });
  assert.equal(await denied.adapter.start(), false);
  assert.equal(denied.recs.length, 0);
  assert.equal(denied.events.find((event) => event.type === 'error').code, 'denied');

  const missing = makeRec({
    requestMicrophone: async () => { const error = new Error('no'); error.name = 'NotFoundError'; throw error; },
  });
  assert.equal(await missing.adapter.start(), false);
  assert.equal(missing.recs.length, 0);
  assert.equal(missing.events.find((event) => event.type === 'error').code, 'no-microphone');
});

test('recognition: thrown start() fails closed and clears the session', () => {
  const throwingRec = new FakeRecognition();
  throwingRec.start = () => {
    throw new Error('InvalidStateError');
  };
  const { adapter, events } = makeRec({ recognitionFactory: () => throwingRec });
  assert.equal(adapter.start(), false);
  assert.equal(adapter.isListening(), false);
  assert.equal(events.find((e) => e.type === 'error').code, 'unavailable');
});

test('recognition: stop() is graceful -- a final delivered on the way down still counts', () => {
  const { adapter, recs, events } = makeRec();
  adapter.start();
  adapter.stop();
  assert.equal(recs[0].stopped, true);
  recs[0].fireResult(finalResult('last word')); // browsers may deliver on stop
  recs[0].fireEnd();
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
  assert.equal(events.find((e) => e.type === 'end').reason, 'stopped');
});

test('recognition: a throwing listener never corrupts adapter state', () => {
  const events = [];
  const recs = [];
  const adapter = createSpeechRecognitionAdapter({
    recognitionFactory: () => {
      const r = new FakeRecognition();
      recs.push(r);
      return r;
    },
    onEvent: () => {
      throw new Error('listener boom');
    },
  });
  adapter.on((e) => events.push(e));
  adapter.start();
  recs[0].fireResult(finalResult('still works'));
  assert.equal(events.find((e) => e.type === 'final').transcript, 'still works');
});

// ===========================================================================
// Speech-playback adapter
// ===========================================================================

test('playback: happy path emits start -> end for allowed plain text', () => {
  const { adapter, synthesis, utts, events } = makePlay();
  assert.equal(adapter.isSupported(), true);
  assert.equal(adapter.speak('Your invoice is ready.', { allow: true }), true);
  assert.equal(synthesis.spoken.length, 1);
  assert.equal(utts[0].text, 'Your invoice is ready.');
  utts[0].fireStart();
  utts[0].fireEnd();
  assert.deepEqual(events.map((e) => e.type), ['start', 'end']);
});

test('playback: DENIED unless the caller explicitly allows it', () => {
  const { adapter, synthesis, events } = makePlay();
  assert.equal(adapter.speak('should not speak'), false);
  assert.equal(adapter.speak('should not speak', { allow: false }), false);
  assert.equal(synthesis.spoken.length, 0);
  assert.ok(events.every((e) => e.type === 'denied' && e.reason === 'not-allowed'));
});

test('playback: refuses markup/SSML instead of interpreting or modifying it', () => {
  const { adapter, synthesis, events } = makePlay();
  assert.equal(adapter.speak('<speak>hi<break time="2s"/></speak>', { allow: true }), false);
  assert.equal(adapter.speak('<b>bold</b>', { allow: true }), false);
  assert.equal(adapter.speak('plain <not closed', { allow: true }), true); // no full tag -> allowed verbatim
  assert.equal(synthesis.spoken.length, 1);
  assert.equal(events.filter((e) => e.type === 'error' && e.code === 'unsafe-text').length, 2);
});

test('playback: passes text through verbatim (no modification/summary)', () => {
  const { adapter, utts } = makePlay();
  const text = 'Line one. Line two, with punctuation & numbers 42.';
  adapter.speak(text, { allow: true });
  assert.equal(utts[0].text, text);
});

test('playback: empty text is denied, never spoken', () => {
  const { adapter, synthesis, events } = makePlay();
  assert.equal(adapter.speak('   ', { allow: true }), false);
  assert.equal(synthesis.spoken.length, 0);
  assert.equal(events.find((e) => e.type === 'denied').reason, 'empty');
});

test('playback: a newer turn cancels the stale one; late end of stale is dropped', () => {
  const { adapter, synthesis, utts, events } = makePlay();
  adapter.speak('first reply', { allow: true, turn: 1 });
  utts[0].fireStart();
  adapter.speak('second reply', { allow: true, turn: 2 });
  // Older utterance was cancelled and announced interrupted.
  assert.ok(events.some((e) => e.type === 'interrupted' && e.turn === 1));
  assert.equal(synthesis.spoken.length, 2);
  // A late completion from the superseded utterance must be ignored.
  utts[0].fireEnd();
  assert.equal(events.filter((e) => e.type === 'end').length, 0);
  utts[1].fireEnd();
  assert.deepEqual(
    events.filter((e) => e.type === 'end').map((e) => e.turn),
    [2],
  );
});

test('playback: an out-of-order (older) turn is dropped as stale', () => {
  const { adapter, synthesis, events } = makePlay();
  adapter.speak('newest', { allow: true, turn: 5 });
  const spokenAfterNew = synthesis.spoken.length;
  assert.equal(adapter.speak('older, arrived late', { allow: true, turn: 3 }), false);
  assert.equal(synthesis.spoken.length, spokenAfterNew); // not spoken
  assert.ok(events.some((e) => e.type === 'denied' && e.reason === 'stale'));
});

test('playback: interrupt() cancels current turn and drops its late completion', () => {
  const { adapter, synthesis, utts, events } = makePlay();
  adapter.speak('speaking now', { allow: true });
  utts[0].fireStart();
  adapter.interrupt();
  assert.ok(synthesis.cancelled >= 1);
  assert.ok(events.some((e) => e.type === 'interrupted'));
  utts[0].fireEnd(); // stale
  assert.equal(events.filter((e) => e.type === 'end').length, 0);
});

test('playback: stop() cancels and announces stopped', () => {
  const { adapter, synthesis, utts, events } = makePlay();
  adapter.speak('halt me', { allow: true });
  adapter.stop();
  assert.ok(synthesis.cancelled >= 1);
  assert.ok(events.some((e) => e.type === 'stopped'));
  utts[0].fireEnd(); // stale, ignored
  assert.equal(events.filter((e) => e.type === 'end').length, 0);
});

test('playback: mute denies audio but still sequences the turn', () => {
  const { adapter, synthesis, events } = makePlay();
  adapter.mute();
  assert.equal(adapter.isMuted(), true);
  assert.equal(adapter.speak('quiet please', { allow: true }), false);
  assert.equal(synthesis.spoken.length, 0);
  assert.ok(events.some((e) => e.type === 'denied' && e.reason === 'muted'));
  // Unmuting restores audio.
  adapter.unmute();
  assert.equal(adapter.speak('audible again', { allow: true }), true);
  assert.equal(synthesis.spoken.length, 1);
});

test('playback: mute interrupts anything already speaking', () => {
  const { adapter, synthesis, utts, events } = makePlay();
  adapter.speak('mid sentence', { allow: true });
  utts[0].fireStart();
  adapter.mute();
  assert.ok(synthesis.cancelled >= 1);
  assert.ok(events.some((e) => e.type === 'interrupted'));
});

test('playback: fails closed when synthesis is unavailable', () => {
  const { adapter, events } = makePlay({ synthesis: undefined });
  assert.equal(adapter.isSupported(), false);
  assert.equal(adapter.speak('no synth', { allow: true }), false);
  assert.equal(events.find((e) => e.type === 'denied').reason, 'unavailable');
});

test('playback: thrown synthesis.speak fails closed with synthesis-error', () => {
  const synthesis = new FakeSynthesis();
  synthesis.speak = () => {
    throw new Error('NotAllowedError');
  };
  const { adapter, events } = makePlay({ synthesis });
  assert.equal(adapter.speak('boom', { allow: true }), false);
  assert.equal(events.find((e) => e.type === 'error').code, 'synthesis-error');
  assert.equal(adapter.isSpeaking(), false);
});

test('playback: thrown utteranceFactory fails closed', () => {
  const { adapter, events } = makePlay({
    utteranceFactory: () => {
      throw new Error('cannot construct utterance');
    },
  });
  assert.equal(adapter.speak('boom', { allow: true }), false);
  assert.equal(events.find((e) => e.type === 'error').code, 'unavailable');
});

test('playback: synthesis error event surfaces, but interrupted/canceled do not', () => {
  const { adapter, utts, events } = makePlay();
  adapter.speak('one', { allow: true });
  utts[0].fireError('synthesis-failed');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);

  const p2 = makePlay();
  p2.adapter.speak('two', { allow: true });
  p2.utts[0].fireError('interrupted'); // normal result of cancel()
  assert.equal(p2.events.filter((e) => e.type === 'error').length, 0);
});
