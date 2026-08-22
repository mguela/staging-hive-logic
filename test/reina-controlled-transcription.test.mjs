import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlledTranscriptionRecognitionFactory } from '../public/reina-controlled-transcription.js';

function makeStream() {
  let stopped = 0;
  const track = { readyState: 'live', enabled: true, stop: () => { stopped += 1; } };
  return { getTracks: () => [track], getAudioTracks: () => [track], get stopped() { return stopped; } };
}

function makeRecorderFactory() {
  const created = [];
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(stream, options) { this.stream = stream; this.options = options; this.state = 'inactive'; this.mimeType = options?.mimeType || 'audio/webm'; created.push(this); }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; this.onstart?.(); }
    stop() { if (this.state !== 'recording') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['spoken words '.repeat(128)], { type: 'audio/webm' }) }); this.onstop?.(); }
  }
  return { Recorder, created };
}

test('controlled recorder sends one short clip, produces a final transcript, and releases the microphone', async () => {
  const stream = makeStream();
  const { Recorder, created } = makeRecorderFactory();
  const finals = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async (blob) => {
      assert.equal(blob.type, 'audio/webm;codecs=opus');
      assert.ok(blob.size > 0);
      return { ok: true, transcript: 'What needs attention?' };
    },
    maximumMs: 12_000,
  });
  const recognition = factory();
  recognition.onresult = (event) => finals.push(event.results[0][0].transcript);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(created[0].options.mimeType, 'audio/webm;codecs=opus');
  assert.equal(created[0].timeslice, 250);
  created[0].stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(finals, ['What needs attention?']);
  assert.equal(stream.stopped, 1);
});

test('controlled recorder always requests explicit audio constraints from the browser microphone API', async () => {
  const stream = makeStream();
  const { Recorder } = makeRecorderFactory();
  const calls = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    windowRef: {
      navigator: {
        mediaDevices: {
          getUserMedia: async (constraints) => {
            calls.push(constraints);
            return stream;
          },
        },
      },
      MediaRecorder: Recorder,
    },
    transcribeAudio: async () => ({ ok: false, code: 'no_speech' }),
  });
  const recognition = factory();
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ audio: true }]);
  recognition.abort();
  assert.equal(stream.stopped, 1);
});

test('controlled recorder uses the browser default microphone even when Insta360 is present', async () => {
  const stream = makeStream();
  const { Recorder } = makeRecorderFactory();
  const calls = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    windowRef: {
      navigator: {
        mediaDevices: {
          getUserMedia: async (constraints) => {
            calls.push(constraints);
            return stream;
          },
        },
      },
      MediaRecorder: Recorder,
    },
    transcribeAudio: async () => ({ ok: false, code: 'no_speech' }),
  });
  const recognition = factory();
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ audio: true }]);
  recognition.abort();
  assert.equal(stream.stopped, 1);
});

test('controlled recorder falls back to browser defaults when no preferred mime is supported', async () => {
  const stream = makeStream();
  let constructedWithoutOptions = false;
  class Recorder {
    static isTypeSupported() { return false; }
    constructor(_stream, options) { constructedWithoutOptions = options === undefined; this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {}
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream, MediaRecorder: Recorder, transcribeAudio: async () => ({ ok: false }),
  });
  const recognition = factory();
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  recognition.abort();
  assert.equal(constructedWithoutOptions, true);
  assert.equal(stream.stopped, 1);
});

test('controlled recorder reports unsupported recorder start honestly', async () => {
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; }
    start() { const error = new Error('unsupported'); error.name = 'NotSupportedError'; throw error; }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream, MediaRecorder: Recorder, transcribeAudio: async () => ({ ok: false }),
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['unavailable']);
  assert.equal(stream.stopped, 1);
});

test('controlled recorder maps recorder runtime errors to unavailable', async () => {
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; }
    start() { this.state = 'recording'; queueMicrotask(() => this.onerror?.({})); }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream, MediaRecorder: Recorder, transcribeAudio: async () => ({ ok: false }),
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['unavailable']);
  assert.equal(stream.stopped, 1);
});

test('controlled recorder fails closed on microphone denial and never transcribes', async () => {
  let transcribed = false;
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; },
    MediaRecorder: class {},
    transcribeAudio: async () => { transcribed = true; },
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['not-allowed']);
  assert.equal(transcribed, false);
});

test('controlled recorder does not report started without a live enabled audio track', async () => {
  const track = { readyState: 'ended', enabled: true, stop() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let constructed = false;
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: class { constructor() { constructed = true; } },
    transcribeAudio: async () => ({ ok: true, transcript: 'must not run' }),
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  assert.equal(await recognition.start(), false);
  assert.equal(constructed, false);
  assert.deepEqual(errors, ['unavailable']);
});

test('controlled recorder rejects a tiny clip before it reaches transcription', async () => {
  const stream = makeStream();
  let calls = 0;
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['tiny']) }); this.onstop?.(); }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream, MediaRecorder: Recorder,
    transcribeAudio: async () => { calls += 1; return { ok: true, transcript: 'must not run' }; },
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
  assert.deepEqual(errors, ['no-speech']);
});

test('controlled recorder preserves safe transcription failures', async () => {
  const stream = makeStream();
  const { Recorder, created } = makeRecorderFactory();
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream, MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: false, code: 'transcription_auth' }),
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  created[0].stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['transcription-auth']);
});

test('controlled recorder never submits after abort', async () => {
  const stream = makeStream();
  const { Recorder, created } = makeRecorderFactory();
  let calls = 0;
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream, MediaRecorder: Recorder,
    transcribeAudio: async () => { calls += 1; return { ok: true, transcript: 'must not submit' }; },
  });
  const recognition = factory();
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  recognition.abort();
  created[0].stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
  assert.equal(stream.stopped, 1);
});

test('controlled recorder stops shortly after speech ends instead of waiting for its maximum duration', async () => {
  const stream = makeStream();
  const { Recorder, created } = makeRecorderFactory();
  let clock = 0;
  let level = 0;
  let poll = null;
  let clearedMaximum = 0;
  class AudioContext {
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 512,
        connect() {}, disconnect() {},
        getByteTimeDomainData(buffer) { buffer.fill(128); buffer[0] = 128 + level; },
      };
    }
    close() { return Promise.resolve(); }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    AudioContext,
    now: () => clock,
    setInterval: (callback) => { poll = callback; return 77; },
    clearInterval: () => { poll = null; },
    setTimeout: () => 88,
    clearTimeout: () => { clearedMaximum += 1; },
    maximumMs: 12_000,
    silenceMs: 850,
    transcribeAudio: async () => ({ ok: true, transcript: 'Hello Reina' }),
  });
  const recognition = factory();
  const finals = [];
  recognition.onresult = (event) => finals.push(event.results[0][0].transcript);
  await recognition.start();
  assert.equal(created[0].state, 'recording');
  assert.equal(typeof poll, 'function');

  clock = 100;
  level = 24;
  poll();
  assert.equal(created[0].state, 'recording');

  clock = 1_000;
  level = 0;
  poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(finals, ['Hello Reina']);
  assert.equal(created[0].state, 'inactive');
  assert.ok(clearedMaximum >= 1);
  assert.equal(stream.stopped, 1);
});

test('controlled recorder uses the microphone constraints selected by Reina settings', async () => {
  const stream = makeStream();
  const { Recorder } = makeRecorderFactory();
  const calls = [];
  const selected = { audio: { deviceId: { exact: 'selected-microphone' }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async (constraints) => { calls.push(constraints); return stream; },
    getAudioConstraints: () => selected,
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: false, code: 'no_speech' }),
  });
  const recognition = factory();
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [selected]);
  recognition.abort();
  assert.equal(stream.stopped, 1);
});

test('controlled recorder resumes a suspended analyser and detects quiet speech with the faster production endpoint', async () => {
  const stream = makeStream();
  const { Recorder, created } = makeRecorderFactory();
  let clock = 0;
  let level = 0;
  let poll = null;
  let resumed = 0;
  class AudioContext {
    constructor() { this.state = 'suspended'; }
    resume() { resumed += 1; this.state = 'running'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 512,
        connect() {}, disconnect() {},
        getByteTimeDomainData(buffer) { buffer.fill(128); buffer[0] = 128 + level; },
      };
    }
    close() { return Promise.resolve(); }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    AudioContext,
    now: () => clock,
    setInterval: (callback) => { poll = callback; return 77; },
    clearInterval: () => { poll = null; },
    setTimeout: () => 88,
    clearTimeout: () => {},
    transcribeAudio: async () => ({ ok: true, transcript: 'Pull up the client' }),
  });
  const recognition = factory();
  const finals = [];
  recognition.onresult = (event) => finals.push(event.results[0][0].transcript);
  await recognition.start();
  assert.equal(resumed, 1);

  clock = 500;
  // 20 of 127, not 5: a clip peaking at 5 was measured in production and came
  // back from transcription as an empty string. This test is about a pause not
  // ending a turn, so it needs a level that is genuinely audible.
  level = 20;
  poll();
  assert.equal(created[0].state, 'recording');

  // An ordinary 800ms thinking pause must not end the turn.
  clock = 1_300;
  level = 0;
  poll();
  assert.equal(created[0].state, 'recording');

  // The turn closes promptly at 900ms of silence.
  clock = 1_400;
  poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(finals, ['Pull up the client']);
  assert.equal(stream.stopped, 1);
});

test('a recording the route could not turn into words is not reported as an unheard microphone', async () => {
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      // Well past the tiny-clip floor: the microphone plainly captured audio.
      this.ondataavailable?.({ data: new Blob(['x'.repeat(52485)]) });
      this.onstop?.();
    }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({
      ok: false,
      code: 'no_speech',
      diagnostic: { audioBytes: 52485, audioType: 'audio/webm', rawTextType: 'string', rawTextLength: 0, rawTextSample: '' },
    }),
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 'no-speech' is reserved for a microphone that captured nothing; this clip
  // reached transcription and came back empty, which is a different failure
  // with a different fix.
  assert.deepEqual(errors, ['transcription-no-speech']);
});

test('every microphone failure reports its shape, including ones no server ever sees', async () => {
  const reports = [];
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['tiny']) });
      this.onstop?.();
    }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: true, transcript: 'must not run' }),
    reportDiagnostic: (record) => { reports.push(record); },
  });
  const recognition = factory();
  await recognition.start();
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // A clip too small to send never reaches the route, so this row is the only
  // record that the attempt happened at all.
  assert.equal(reports.length, 1);
  assert.equal(reports[0].stage, 'recognition');
  assert.equal(reports[0].code, 'no-speech');
  assert.equal(reports[0].audioBytes, 4);
  assert.equal(reports[0].mimeType, 'audio/webm;codecs=opus');
  assert.equal(typeof reports[0].peak, 'number');
  assert.equal(typeof reports[0].msSinceStart, 'number');
  assert.equal(reports[0].speechSeen, 0);
});

test('a reporter that throws or rejects never breaks the recording', async () => {
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['tiny']) }); this.onstop?.(); }
  }
  const errors = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: true, transcript: 'must not run' }),
    reportDiagnostic: () => { throw new Error('reporting is down'); },
  });
  const recognition = factory();
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['no-speech']);
});

test('a transcription attempt that never answers becomes a reported failure, not silence', async () => {
  const reports = [];
  const errors = [];
  const timers = [];
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['x'.repeat(62177)]) });
      this.onstop?.();
    }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    // The exact failure seen in production: the request is issued and never
    // settles, so nothing downstream ever runs.
    transcribeAudio: () => new Promise(() => {}),
    reportDiagnostic: (record) => { reports.push(record); },
    transcriptionMs: 5_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  const recognition = factory();
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const deadline = timers.find((timer) => timer.ms === 5_000);
  assert.ok(deadline, 'the attempt is bounded');
  deadline.fn();

  assert.deepEqual(errors, ['transcription-timeout']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'transcription-timeout');
  assert.equal(reports[0].audioBytes, 62177);
  assert.equal(reports[0].stage, 'transcription');
});

test('an answer that arrives normally cancels the deadline and is not double-reported', async () => {
  const reports = [];
  const results = [];
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'.repeat(4096)]) }); this.onstop?.(); }
  }
  const timers = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: true, transcript: 'what needs attention' }),
    reportDiagnostic: (record) => { reports.push(record); },
    transcriptionMs: 5_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  const recognition = factory();
  recognition.onresult = (event) => results.push(event.results[0][0].transcript);
  await recognition.start();
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(results, ['what needs attention']);

  // A late deadline must not turn a delivered transcript into a failure.
  timers.find((timer) => timer.ms === 5_000)?.fn();
  assert.deepEqual(reports, []);
});

// ---------------------------------------------------------------------------
// Selected-input-device fallback. A previously-picked microphone (persisted
// across sessions) can stop existing for all sorts of ordinary reasons --
// unplugged, USB re-enumeration, a Windows update -- and getUserMedia throws
// OverconstrainedError for an exact deviceId it can no longer satisfy. Before
// this fix that failed voice outright with a vague "could not start" message;
// found while investigating a live report of Reina "not picking up" a user's
// mic. Mirrors the existing output-device fallback in reina-neural-speech.js.
// ---------------------------------------------------------------------------

test('a selected input device that no longer exists falls back to the system default microphone', async () => {
  const stream = makeStream();
  const { Recorder } = makeRecorderFactory();
  const calls = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async (constraints) => {
      calls.push(constraints);
      if (constraints.audio && constraints.audio.deviceId) {
        const error = new Error('overconstrained'); error.name = 'OverconstrainedError'; throw error;
      }
      return stream;
    },
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: true, transcript: 'hello' }),
    getAudioConstraints: () => ({ audio: { deviceId: { exact: 'stale-device-id' } } }),
  });
  const recognition = factory();
  const results = [];
  recognition.onresult = (event) => results.push(event.results[0][0].transcript);
  await recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 2, 'the exact-device attempt and the fallback attempt must both have happened');
  assert.deepEqual(calls[0], { audio: { deviceId: { exact: 'stale-device-id' } } });
  assert.deepEqual(calls[1], { audio: {} }, 'the fallback must drop deviceId, not retry the same broken constraint');
});

test('the stale-device fallback is reported as a diagnostic, not just a console warning', async () => {
  const stream = makeStream();
  const { Recorder } = makeRecorderFactory();
  const reports = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async (constraints) => {
      if (constraints.audio && constraints.audio.deviceId) {
        const error = new Error('overconstrained'); error.name = 'OverconstrainedError'; throw error;
      }
      return stream;
    },
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: true, transcript: 'hello' }),
    getAudioConstraints: () => ({ audio: { deviceId: { exact: 'stale-device-id' } } }),
    reportDiagnostic: (record) => { reports.push(record); },
  });
  const recognition = factory();
  await recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const fallbackReport = reports.find((r) => r.stage === 'device-fallback');
  assert.ok(fallbackReport, `expected a device-fallback diagnostic, got: ${JSON.stringify(reports)}`);
  assert.equal(fallbackReport.code, 'device-not-found');
  assert.equal(fallbackReport.deviceId, 'stale-device-id');
});

test('OverconstrainedError with no specific device requested is not retried -- it just fails', async () => {
  const calls = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async (constraints) => {
      calls.push(constraints);
      const error = new Error('overconstrained'); error.name = 'OverconstrainedError'; throw error;
    },
    MediaRecorder: class {},
    transcribeAudio: async () => { throw new Error('must not be called'); },
    getAudioConstraints: () => ({ audio: true }),
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1, 'no retry makes sense when there was no specific device to fall back from');
  assert.deepEqual(errors, ['device-not-found']);
});

test('if the fallback device also fails, the real error still surfaces', async () => {
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async (constraints) => {
      if (constraints.audio && constraints.audio.deviceId) {
        const error = new Error('overconstrained'); error.name = 'OverconstrainedError'; throw error;
      }
      const error = new Error('denied'); error.name = 'NotAllowedError'; throw error;
    },
    MediaRecorder: class {},
    transcribeAudio: async () => { throw new Error('must not be called'); },
    getAudioConstraints: () => ({ audio: { deviceId: { exact: 'stale-device-id' } } }),
  });
  const recognition = factory();
  const errors = [];
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(errors, ['not-allowed'], 'the fallback attempt failing for a real reason must not be swallowed');
});

test('a recording that only ever reached the noise floor is named, not sent to transcription', async () => {
  const reports = [];
  const errors = [];
  let transcribed = 0;
  const stream = makeStream();
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      // The real clip: 20197 bytes, and every sample at the noise floor.
      this.ondataavailable?.({ data: new Blob(['x'.repeat(20197)]) });
      this.onstop?.();
    }
  }
  // A real analyser reading a real (inaudible) signal: every sample one step
  // off centre, a peak of 1 against a floor of 12.
  let poll = null;
  class FlatAudioContext {
    constructor() { this.state = 'running'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 512,
        connect() {}, disconnect() {},
        getByteTimeDomainData(buffer) { buffer.fill(129); },
      };
    }
    close() {}
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => { transcribed += 1; return { ok: true, transcript: 'must not run' }; },
    reportDiagnostic: (record) => { reports.push(record); },
    AudioContext: FlatAudioContext,
    setInterval: (fn) => { poll = fn; return 1; },
    clearInterval: () => { poll = null; },
  });
  const recognition = factory();
  recognition.onerror = (event) => errors.push(event.error);
  await recognition.start();
  poll();
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // No peak was ever observed, so the clip cannot have been audible. Sending it
  // costs a round trip and comes back "no words", which reads as the user's
  // fault rather than the input's.
  assert.deepEqual(errors, ['input-too-quiet']);
  assert.equal(transcribed, 0);
  assert.equal(reports[0].code, 'input-too-quiet');
  assert.equal(reports[0].audioBytes, 20197);
});

// The failure that produced no message at all: the panel was switched on, the
// browser was asked for the microphone, and getUserMedia never settled either
// way. Recording never started, so the maximum timer and the silence poll --
// every other bound in this file -- had not been armed yet. Nothing failed,
// nothing was reported, and the panel simply waited.
test('a microphone open that never settles fails on a deadline instead of waiting forever', async () => {
  const errors = [];
  const ends = [];
  const reports = [];
  const timers = [];
  const { Recorder } = makeRecorderFactory();
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: () => new Promise(() => {}),
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: true, transcript: 'never reached' }),
    reportDiagnostic: (record) => { reports.push(record); },
    startupMs: 7_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  const recognition = factory();
  recognition.onerror = (event) => errors.push(event.error);
  recognition.onend = () => ends.push(true);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const startup = timers.find((entry) => entry.ms === 7_000);
  assert.ok(startup, 'opening the microphone is bounded');
  startup.fn();

  assert.deepEqual(errors, ['microphone-open-timeout']);
  // onend is what returns the panel to idle. Without it the panel stays on
  // LISTENING no matter what the error said.
  assert.deepEqual(ends, [true]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'microphone-open-timeout');
  assert.equal(reports[0].stage, 'startup');
});

test('a microphone that opens normally does not later trip the startup deadline', async () => {
  const errors = [];
  const results = [];
  const timers = [];
  const stream = makeStream();
  const { Recorder, created } = makeRecorderFactory();
  const cleared = [];
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: true, transcript: 'what needs attention' }),
    startupMs: 7_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (handle) => { cleared.push(handle); },
  });
  const recognition = factory();
  recognition.onerror = (event) => errors.push(event.error);
  recognition.onresult = (event) => results.push(event.results[0][0].transcript);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cleared, [1], 'the startup deadline is disarmed once recording begins');
  created[0].stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(results, ['what needs attention']);
  assert.deepEqual(errors, []);
});

// requestStop() clears the maximum timer and the silence poll before calling
// MediaRecorder.stop(), and sets stopRequested so no later call can restart
// any of it. If the browser then never fires 'stop', nothing is left running
// anywhere: the captured audio sits in hand and the panel waits on LISTENING
// with no error and no diagnostic. That is the state a user sat in for a full
// minute against a fifteen-second cap.
test('a recorder that never reports stopping still delivers the audio it captured', async () => {
  const results = [];
  const reports = [];
  const timers = [];
  const stream = makeStream();
  let recorderRef = null;
  class WedgedRecorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; recorderRef = this; }
    start() { this.state = 'recording'; }
    // Accepts the request, releases the state, and never fires 'stop'.
    stop() { this.state = 'inactive'; }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: WedgedRecorder,
    transcribeAudio: async (blob) => {
      assert.ok(blob.size >= 1024, 'the audio captured before the wedge is what gets sent');
      return { ok: true, transcript: 'the audio survived' };
    },
    reportDiagnostic: (record) => { reports.push(record); },
    stopMs: 3_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  const recognition = factory();
  recognition.onresult = (event) => results.push(event.results[0][0].transcript);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The timeslice chunks that had already arrived before the recorder wedged.
  recorderRef.ondataavailable({ data: new Blob(['spoken words '.repeat(256)]) });
  recognition.stop();

  const backstop = timers.find((entry) => entry.ms === 3_000);
  assert.ok(backstop, 'stopping the recorder is bounded');
  backstop.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(results, ['the audio survived'], 'a wedged stop yields a transcript, not a hang');
  const wedge = reports.find((record) => record.code === 'recorder-stop-timeout');
  assert.ok(wedge, 'the wedge itself is reported, not silently papered over');
  assert.equal(wedge.stage, 'recorder-stop-timeout');
  // The open tracks are what keep a wedged recorder alive.
  assert.equal(stream.stopped, 1);
});

test('a recording delivered by the stop event is not delivered a second time by the backstop', async () => {
  const results = [];
  const transcribeCalls = [];
  const timers = [];
  const stream = makeStream();
  class SlowStopRecorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      // Real browsers fire 'stop' asynchronously, so the backstop is armed
      // first and must stand down when the event does arrive.
      Promise.resolve().then(() => {
        this.ondataavailable?.({ data: new Blob(['spoken words '.repeat(256)]) });
        this.onstop?.();
      });
    }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: SlowStopRecorder,
    transcribeAudio: async () => { transcribeCalls.push(true); return { ok: true, transcript: 'delivered once' }; },
    stopMs: 3_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  const recognition = factory();
  recognition.onresult = (event) => results.push(event.results[0][0].transcript);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  recognition.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(results, ['delivered once']);

  timers.find((entry) => entry.ms === 3_000)?.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(results, ['delivered once']);
  assert.equal(transcribeCalls.length, 1, 'the backstop never re-sends an already-delivered recording');
});

// The audible floor was 12, set from a single clip that peaked at 5. Every
// measured attempt after that -- peaks of 1, 5, 14 and 17 across four inputs --
// also came back with an empty transcript, and the two that cleared 12 were
// told the transcription service was at fault for a recording that had peaked
// at 13% of full scale. No transcript has ever returned from a peak below 20.
test('a recording that peaks at the level of a distant microphone is named as too quiet', async () => {
  const reports = [];
  const errors = [];
  const transcribeCalls = [];
  const stream = makeStream();
  let poll = null;
  let clock = 0;
  // 17 of 127 -- the exact level measured on a webcam microphone several feet
  // from the speaker -- then silence, so the recording actually terminates.
  let quietLevel = 17;
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'.repeat(8192)]) }); this.onstop?.(); }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => { transcribeCalls.push(true); return { ok: true, transcript: 'should never be asked for' }; },
    reportDiagnostic: (record) => { reports.push(record); },
    AudioContext: function () {
      return {
        state: 'running',
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
        createAnalyser: () => ({
          fftSize: 512,
          connect() {}, disconnect() {},
          getByteTimeDomainData: (buf) => { buf.fill(128); buf[0] = 128 + quietLevel; },
        }),
        close() {},
      };
    },
    now: () => clock,
    setInterval: (callback) => { poll = callback; return 7; },
    clearInterval: () => {},
    setTimeout: () => 8,
    clearTimeout: () => {},
  });
  const recognition = factory();
  recognition.onerror = (event) => errors.push(event.error);
  recognition.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  poll();                       // peak 17 -> above activityThreshold, so speech is seen
  quietLevel = 0;
  clock += 2_000;
  poll();                       // ... then silence long enough to stop
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(errors, ['input-too-quiet'],
    'a peak of 17 is the input failing, not the transcription service');
  assert.deepEqual(transcribeCalls, [],
    'nothing this quiet is worth spending a transcription call on');
  const quiet = reports.find((r) => r.code === 'input-too-quiet');
  assert.ok(quiet);
  assert.equal(quiet.peak, 17);
});

test('the panel no longer claims to know that transcription is at fault', async () => {
  const { readFile } = await import('node:fs/promises');
  const host = await readFile('public/reina-pilot-host.js', 'utf8');
  assert.ok(!/the transcription service, not your microphone, is the problem/.test(host),
    'that sentence was asserted, never measured, and was wrong when it was read');
});

// The opposite end of the audible floor, and until now it had no name.
// Measured on a real turn: peak 128 of 128, 58 KB over 5.5 seconds, empty
// transcript. The meter reports Math.abs(sample - 128) over a Uint8 buffer, so
// 128 IS the rail -- the waveform above it has been flattened away. Clipped
// audio comes back from transcription as an empty string exactly like silence,
// and both used to produce the same message, which sent a user to check which
// microphone was selected when the microphone was the one they wanted.
function clippingHarness(levels, options = {}) {
  const reports = [];
  const errors = [];
  const transcribeCalls = [];
  const stream = makeStream();
  let poll = null;
  let clock = 0;
  let index = 0;
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'.repeat(8192)]) }); this.onstop?.(); }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => { transcribeCalls.push(true); return { ok: true, transcript: 'heard you' }; },
    reportDiagnostic: (record) => { reports.push(record); },
    AudioContext: function () {
      return {
        state: 'running',
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
        createAnalyser: () => ({
          fftSize: 512,
          connect() {}, disconnect() {},
          getByteTimeDomainData: (buf) => {
            const level = index < levels.length ? levels[index] : 0;
            buf.fill(128);
            buf[0] = 128 + level;
          },
        }),
        close() {},
      };
    },
    now: () => clock,
    setInterval: (callback) => { poll = callback; return 7; },
    clearInterval: () => {},
    setTimeout: () => 8,
    clearTimeout: () => {},
    ...options,
  });
  const recognition = factory();
  recognition.onerror = (event) => errors.push(event.error);
  return {
    recognition, reports, errors, transcribeCalls, stream,
    async run() {
      recognition.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (index = 0; index < levels.length; index += 1) { poll(); clock += 100; }
      clock += 2_000;               // silence after speech -> stop
      poll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test('a recording that repeatedly rails the meter is named as too loud, not sent', async () => {
  const h = clippingHarness([127, 128, 127, 128]);
  await h.run();
  assert.deepEqual(h.errors, ['input-too-loud'],
    'clipping is its own failure, not a generic one');
  assert.deepEqual(h.transcribeCalls, [],
    'distorted audio is not worth a transcription call');
  const clip = h.reports.find((r) => r.code === 'input-too-loud');
  assert.ok(clip);
  assert.equal(clip.peak, 128);
  assert.ok(clip.clippedPolls > 2);
});

test('a single transient at the rail is not clipping', async () => {
  // Loud speech touches the ceiling. Only sustained railing is distortion.
  const h = clippingHarness([60, 128, 70, 55]);
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.transcribeCalls, [true], 'a healthy loud take still transcribes');
});

test('a comfortably loud recording is transcribed untouched', async () => {
  const h = clippingHarness([64, 80, 72, 90]);
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.transcribeCalls, [true]);
});

test('every diagnostic carries the railed-window count, so a near miss is visible', async () => {
  // Above the activity threshold (so the recorder arms and stops normally) but
  // below the audible floor, so it fails as too quiet rather than as clipping.
  const h = clippingHarness([6, 7, 6]);
  await h.run();
  const quiet = h.reports.find((r) => r.code === 'input-too-quiet' || r.code === 'no-speech');
  assert.ok(quiet, 'sanity: a quiet take still fails its own way');
  assert.equal(quiet.clippedPolls, 0);
});

// Peak could not tell a loud voice from a loud room, and that ambiguity cost a
// whole evening: seven recordings, peaks from 1 to 128 across four
// microphones, every one returning an empty transcript, with no way to say
// which were too quiet, which were distorted, and which were simply a room
// being amplified. Speech is spiky and its average sits far below its peak; a
// steady noise floor is flat and its average sits near it.
function meteredHarness(sampleAt) {
  const reports = [];
  const stream = makeStream();
  let poll = null;
  let clock = 0;
  let tick = 0;
  let silent = false;
  class Recorder {
    static isTypeSupported() { return false; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'.repeat(8192)]) }); this.onstop?.(); }
  }
  const factory = createControlledTranscriptionRecognitionFactory({
    openMicrophone: async () => stream,
    MediaRecorder: Recorder,
    transcribeAudio: async () => ({ ok: false, code: 'no_speech' }),
    reportDiagnostic: (record) => { reports.push(record); },
    AudioContext: function () {
      return {
        state: 'running',
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
        createAnalyser: () => ({
          fftSize: 512,
          connect() {}, disconnect() {},
          getByteTimeDomainData: (buf) => {
            for (let i = 0; i < buf.length; i += 1) buf[i] = 128 + (silent ? 0 : sampleAt(tick, i));
          },
        }),
        close() {},
      };
    },
    now: () => clock,
    setInterval: (callback) => { poll = callback; return 7; },
    clearInterval: () => {},
    setTimeout: () => 8,
    clearTimeout: () => {},
  });
  const recognition = factory();
  return {
    reports,
    async run(ticks) {
      recognition.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (tick = 0; tick < ticks; tick += 1) { poll(); clock += 100; }
      // Fall silent so the recorder terminates the way it does in life.
      silent = true;
      clock += 2_000;
      poll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test('a steady tone is reported with a low crest factor -- loud, but not speech', async () => {
  // Every sample at the same magnitude: rms equals peak, crest is 1.
  const h = meteredHarness(() => 60);
  await h.run(4);
  const record = h.reports.find((r) => typeof r.crest === 'number');
  assert.ok(record, 'the diagnostic carries the shape of the sound, not just its size');
  assert.equal(record.peak, 60);
  // Not exactly 60: the trailing silence that ends the recording is averaged
  // in, as it is in life. The point is that it sits CLOSE to the peak.
  assert.ok(record.rms > 45, 'a flat signal averages near its peak: ' + record.rms);
  assert.ok(record.crest < 2, 'a flat signal is a room, not a voice: ' + record.crest);
});

test('a spiky signal is reported with a high crest factor -- the shape of speech', async () => {
  // One loud sample per window over near-silence, the way syllables sit in a
  // recording. Same peak as the steady case, very different average.
  const h = meteredHarness((_tick, i) => (i === 0 ? 60 : 1));
  await h.run(4);
  const record = h.reports.find((r) => typeof r.crest === 'number');
  assert.ok(record);
  assert.equal(record.peak, 60, 'identical peak to the steady tone');
  assert.ok(record.rms < 10, 'but a far lower average');
  assert.ok(record.crest > 4, 'which is what distinguishes it: ' + record.crest);
});

test('rms and crest ride on a failing row, so a bad take can be read after the fact', async () => {
  const h = meteredHarness(() => 60);
  await h.run(4);
  const record = h.reports.find((r) => r.stage === 'recognition' || r.stage === 'transcription');
  assert.ok(record, 'the failure itself carries the measurement');
  assert.equal(typeof record.rms, 'number');
  assert.equal(typeof record.crest, 'number');
});
