import test from 'node:test';
import assert from 'node:assert/strict';

import { createNeuralSpeech } from '../api/reina-neural-speech.js';
import NeuralSpeech from '../public/reina-neural-speech.js';

const { createNeuralSynthesis, createUtterance, splitForSpeech } = NeuralSpeech;

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('server neural speech uses the natural Reina model, selected female voice, and executive delivery', async () => {
  let request;
  const bytes = new Uint8Array(256).fill(7);
  const result = await createNeuralSpeech({
    text: 'Here is what needs your attention today.',
    voice: 'marin',
    apiKey: 'sk-test-key-that-is-long-enough',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, arrayBuffer: async () => bytes.buffer };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.openai.com/v1/audio/speech');
  const body = JSON.parse(request.options.body);
  assert.equal(body.voice, 'marin');
  assert.equal(body.model, 'gpt-4o-mini-tts');
  assert.match(body.instructions, /warm American executive assistant/i);
  assert.match(body.instructions, /Never sound robotic/i);
  assert.equal(body.response_format, 'mp3');
});

test('server neural speech honors an explicitly configured supported model', async () => {
  const previous = process.env.REINA_TTS_MODEL;
  process.env.REINA_TTS_MODEL = 'gpt-4o-mini-tts-2025-12-15';
  try {
    let request;
    const bytes = new Uint8Array(256).fill(8);
    const result = await createNeuralSpeech({
      text: 'Configured voice model check.',
      voice: 'coral',
      apiKey: 'sk-test-key-that-is-long-enough',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(request.options.body).model, 'gpt-4o-mini-tts-2025-12-15');
  } finally {
    if (previous === undefined) delete process.env.REINA_TTS_MODEL;
    else process.env.REINA_TTS_MODEL = previous;
  }
});

test('server neural speech fails closed for invalid voices, missing keys, and upstream failures', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('offline'); };
  assert.deepEqual(await createNeuralSpeech({ text: 'Hello', voice: 'male-system', apiKey: 'sk-test-key-that-is-long-enough', fetchImpl }), { ok: false, code: 'unavailable' });
  assert.deepEqual(await createNeuralSpeech({ text: 'Hello', voice: 'marin', apiKey: '', fetchImpl }), { ok: false, code: 'unavailable' });
  assert.deepEqual(await createNeuralSpeech({ text: 'Hello', voice: 'marin', apiKey: 'sk-test-key-that-is-long-enough', fetchImpl }), { ok: false, code: 'neural_voice_unavailable' });
  assert.equal(calls, 1);
});

test('browser neural speech uses the self-healing auth wrapper, honors voice pace and output, and completes naturally', async () => {
  const calls = [];
  const audioInstances = [];
  const revoked = [];
  class FakeAudio {
    constructor(url) { this.url = url; this.playbackRate = 1; this.sink = ''; audioInstances.push(this); }
    setSinkId(value) { this.sink = value; return Promise.resolve(); }
    play() { this.onplay?.(); queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
    pause() {}
  }
  const synthesis = createNeuralSynthesis({
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        headers: { get: () => 'audio/mpeg' },
        blob: async () => ({ size: 250 }),
      };
    },
    // The session can become stale between this check and playback. The
    // captured HiveLogic fetch wrapper must own bearer refresh/retry.
    getAccessToken: async () => 'possibly-stale-signed-token',
    AudioCtor: FakeAudio,
    AbortControllerCtor: AbortController,
    createObjectURL: () => 'blob:reina-natural',
    revokeObjectURL: (url) => revoked.push(url),
    getVoice: () => 'coral',
    getRate: () => 1.06,
    getOutputDevice: () => 'speaker-2',
  });
  const utterance = createUtterance('I found the three jobs that need attention.');
  let starts = 0;
  let ends = 0;
  let errors = 0;
  utterance.onstart = () => { starts += 1; };
  utterance.onend = () => { ends += 1; };
  utterance.onerror = () => { errors += 1; };
  synthesis.speak(utterance);
  await tick();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/reina-neural-speech');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: utterance.text, voice: 'coral' });
  assert.equal(audioInstances[0].playbackRate, 1.06);
  assert.equal(audioInstances[0].sink, 'speaker-2');
  assert.equal(starts, 1);
  assert.equal(ends, 1);
  assert.equal(errors, 0);
  assert.deepEqual(revoked, ['blob:reina-natural']);
});

test('purple-button audio unlock reuses the gesture-authorized player for delayed neural speech', async () => {
  const instances = [];
  class FakeAudio {
    constructor(url) {
      this.src = url || '';
      this.muted = false;
      this.volume = 1;
      this.currentTime = 0;
      this.playbackRate = 1;
      this.playCalls = 0;
      instances.push(this);
    }
    play() {
      this.playCalls += 1;
      if (this.playCalls > 1) {
        this.onplay?.();
        queueMicrotask(() => this.onended?.());
      }
      return Promise.resolve();
    }
    pause() {}
  }
  const synthesis = createNeuralSynthesis({
    fetchFn: async () => ({
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      blob: async () => ({ size: 250 }),
    }),
    getAccessToken: async () => 'signed-token',
    AudioCtor: FakeAudio,
    AbortControllerCtor: AbortController,
    createObjectURL: () => 'blob:reina-delayed',
    revokeObjectURL: () => {},
  });

  assert.equal(synthesis.unlock(), true);
  assert.equal(instances.length, 1);
  assert.match(instances[0].src, /^data:audio\/wav;base64,/);
  assert.equal(instances[0].muted, false, 'warm-up must not use the autoplay-exempt muted path');
  assert.equal(instances[0].volume, 0.001, 'silent warm-up is technically audible during the trusted gesture');
  const utterance = createUtterance('This should play after the network delay.');
  let ended = 0;
  utterance.onend = () => { ended += 1; };
  synthesis.speak(utterance);
  await tick();
  await tick();

  assert.equal(instances.length, 1, 'real speech reuses the gesture-authorized audio element');
  assert.equal(instances[0].playCalls, 2);
  assert.equal(instances[0].volume, 1, 'real neural speech restores normal output volume');
  assert.equal(ended, 1);
});

test('delayed neural speech is primed through an audible gesture path instead of muted autoplay', async () => {
  let unlockedByGesture = false;
  let gestureActive = true;
  class AutoplayPolicyAudio {
    constructor(url) {
      this.src = url || '';
      this.muted = false;
      this.volume = 1;
      this.playCalls = 0;
    }
    play() {
      this.playCalls += 1;
      if (gestureActive && this.muted === false && this.volume > 0) unlockedByGesture = true;
      if (!gestureActive && !unlockedByGesture) return Promise.reject(new Error('NotAllowedError'));
      if (this.playCalls > 1) {
        this.onplay?.();
        queueMicrotask(() => this.onended?.());
      }
      return Promise.resolve();
    }
    pause() {}
  }
  const synthesis = createNeuralSynthesis({
    fetchFn: async () => ({
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      blob: async () => ({ size: 250 }),
    }),
    getAccessToken: async () => 'signed-token',
    AudioCtor: AutoplayPolicyAudio,
    AbortControllerCtor: AbortController,
    createObjectURL: () => 'blob:reina-after-network-delay',
    revokeObjectURL: () => {},
  });

  assert.equal(synthesis.unlock(), true);
  gestureActive = false;
  const utterance = createUtterance('The delayed response must still speak.');
  let ended = 0;
  let errors = 0;
  utterance.onend = () => { ended += 1; };
  utterance.onerror = () => { errors += 1; };
  synthesis.speak(utterance);
  await tick();
  await tick();

  assert.equal(unlockedByGesture, true);
  assert.equal(ended, 1);
  assert.equal(errors, 0);
});

test('stale saved speaker falls back to the system default and still plays', async () => {
  const sinks = [];
  let plays = 0;
  class FakeAudio {
    constructor(url) { this.src = url || ''; }
    setSinkId(value) {
      sinks.push(value);
      return value === 'missing-speaker' ? Promise.reject(new Error('device missing')) : Promise.resolve();
    }
    play() {
      plays += 1;
      this.onplay?.();
      queueMicrotask(() => this.onended?.());
      return Promise.resolve();
    }
    pause() {}
  }
  const synthesis = createNeuralSynthesis({
    fetchFn: async () => ({
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      blob: async () => ({ size: 250 }),
    }),
    getAccessToken: async () => 'signed-token',
    AudioCtor: FakeAudio,
    AbortControllerCtor: AbortController,
    createObjectURL: () => 'blob:reina-output-fallback',
    revokeObjectURL: () => {},
    getOutputDevice: () => 'missing-speaker',
  });
  const utterance = createUtterance('Reina should still speak.');
  let ended = 0;
  let errors = 0;
  utterance.onend = () => { ended += 1; };
  utterance.onerror = () => { errors += 1; };
  synthesis.speak(utterance);
  await tick();
  await tick();

  assert.deepEqual(sinks, ['missing-speaker', '']);
  assert.equal(plays, 1);
  assert.equal(ended, 1);
  assert.equal(errors, 0);
});

test('browser neural speech reports failure without creating or invoking a system voice', async () => {
  let audioCreated = 0;
  const synthesis = createNeuralSynthesis({
    fetchFn: async () => ({ status: 503, headers: { get: () => 'application/json' }, blob: async () => ({ size: 0 }) }),
    getAccessToken: async () => 'signed-token',
    AudioCtor: class { constructor() { audioCreated += 1; } },
    createObjectURL: () => 'should-not-run',
    revokeObjectURL: () => {},
  });
  const utterance = createUtterance('Do not use the robotic fallback.');
  let error = '';
  utterance.onerror = (event) => { error = event.error; };
  synthesis.speak(utterance);
  await tick();
  await tick();
  assert.equal(audioCreated, 0);
  assert.equal(error, 'neural-voice-unavailable');
});

// ---- Time-to-first-word ---------------------------------------------------
//
// She used to say nothing until the WHOLE answer had been synthesised. On a
// 1,900-character answer that was 30-45 seconds of silence sitting under a
// finished written answer -- indistinguishable from broken. What matters is not
// total synthesis time, which is unavoidable, but that the first word does not
// wait for the last one.

function sentences(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`This is sentence number ${i} and it carries enough words to be worth speaking aloud.`);
  }
  return out.join(' ');
}

test('a long answer is cut at sentence ends, never mid-sentence', () => {
  const text = sentences(12);
  const chunks = splitForSpeech(text, 420, 900);
  assert.ok(chunks.length > 1, 'a 12-sentence answer must not be one blob');
  assert.equal(chunks.join(' '), text.replace(/\s+/g, ' ').trim(), 'no words may be lost or reordered');
  for (const chunk of chunks) {
    assert.match(chunk, /[.!?]$/, `chunk ends mid-sentence: ${JSON.stringify(chunk)}`);
    assert.ok(chunk.length <= 900, `chunk over the hard maximum: ${chunk.length}`);
  }
});

test('a single sentence longer than the maximum is broken at a word boundary', () => {
  const long = `${'word '.repeat(400)}end.`;
  const chunks = splitForSpeech(long, 420, 900);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 900);
    assert.doesNotMatch(chunk, /^\s|\s$/, 'chunks are trimmed');
  }
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' ').trim());
});

test('she starts speaking after the first piece, not after the last', async () => {
  const requested = [];
  let released;
  const held = new Promise((resolve) => { released = resolve; });
  const players = [];
  class FakeAudio {
    constructor(url) { this.src = url || ''; this.plays = 0; players.push(this); }
    setSinkId() { return Promise.resolve(); }
    play() { this.plays += 1; this.onplay?.(); return Promise.resolve(); }
    pause() {}
  }
  const synthesis = createNeuralSynthesis({
    fetchFn: async (_url, options) => {
      const body = JSON.parse(options.body);
      requested.push(body.text);
      // Every piece after the first hangs, standing in for slow synthesis.
      if (requested.length > 1) await held;
      return { status: 200, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 250 }) };
    },
    getAccessToken: async () => 'signed-token',
    AudioCtor: FakeAudio,
    AbortControllerCtor: AbortController,
    createObjectURL: () => `blob:piece-${requested.length}`,
    revokeObjectURL: () => {},
    getVoice: () => 'marin',
    getRate: () => 1,
    getOutputDevice: () => '',
  });

  const utterance = createUtterance(sentences(12));
  let started = 0;
  utterance.onstart = () => { started += 1; };
  synthesis.speak(utterance);
  for (let i = 0; i < 8; i += 1) await tick();

  assert.equal(started, 1, 'the first piece must play while the rest are still being made');
  assert.ok(requested.length >= 2, 'the next piece is fetched during playback, not after it');
  assert.ok(
    requested.length < 12,
    `every piece was requested before a word was spoken (${requested.length})`,
  );
  released();
  synthesis.cancel();
});

test('every piece is spoken, in order, and the answer ends exactly once', async () => {
  const spoken = [];
  class FakeAudio {
    constructor(url) { this.src = url || ''; }
    setSinkId() { return Promise.resolve(); }
    play() { this.onplay?.(); queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
    pause() {}
  }
  const synthesis = createNeuralSynthesis({
    fetchFn: async (_url, options) => {
      spoken.push(JSON.parse(options.body).text);
      return { status: 200, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 250 }) };
    },
    getAccessToken: async () => 'signed-token',
    AudioCtor: FakeAudio,
    AbortControllerCtor: AbortController,
    createObjectURL: () => 'blob:piece',
    revokeObjectURL: () => {},
    getVoice: () => 'marin',
    getRate: () => 1,
    getOutputDevice: () => '',
  });

  const text = sentences(9);
  const utterance = createUtterance(text);
  let starts = 0;
  let ends = 0;
  let errors = 0;
  utterance.onstart = () => { starts += 1; };
  utterance.onend = () => { ends += 1; };
  utterance.onerror = () => { errors += 1; };
  synthesis.speak(utterance);
  for (let i = 0; i < 40; i += 1) await tick();

  assert.equal(errors, 0);
  assert.equal(starts, 1, 'one answer, one start');
  assert.equal(ends, 1, 'one answer, one end -- not one per piece');
  assert.equal(spoken.join(' '), text.replace(/\s+/g, ' ').trim(), 'the whole answer was spoken');
});

test('cancelling mid-answer releases pieces fetched ahead but never played', async () => {
  const revoked = [];
  let made = 0;
  class FakeAudio {
    constructor(url) { this.src = url || ''; }
    setSinkId() { return Promise.resolve(); }
    play() { this.onplay?.(); return Promise.resolve(); } // holds on the first piece
    pause() {}
  }
  const synthesis = createNeuralSynthesis({
    fetchFn: async () => ({ status: 200, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 250 }) }),
    getAccessToken: async () => 'signed-token',
    AudioCtor: FakeAudio,
    AbortControllerCtor: AbortController,
    createObjectURL: () => { made += 1; return `blob:piece-${made}`; },
    revokeObjectURL: (url) => revoked.push(url),
    getVoice: () => 'marin',
    getRate: () => 1,
    getOutputDevice: () => '',
  });

  synthesis.speak(createUtterance(sentences(12)));
  for (let i = 0; i < 8; i += 1) await tick();
  assert.ok(made >= 2, 'at least one piece was fetched ahead');
  synthesis.cancel();
  for (let i = 0; i < 4; i += 1) await tick();

  assert.equal(revoked.length, made, `${made} pieces made, ${revoked.length} released`);
});
