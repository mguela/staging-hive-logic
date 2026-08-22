import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBoundedBody, recordRefusal, transcribeAudio } from '../api/reina-transcribe.js';

test('bounded audio reader accepts a small Buffer and rejects oversized input', async () => {
  const req = new EventEmitter();
  const promise = readBoundedBody(req, 4);
  req.emit('data', Buffer.from('four'));
  req.emit('end');
  assert.deepEqual(await promise, Buffer.from('four'));

  const oversized = new EventEmitter();
  const rejected = readBoundedBody(oversized, 3);
  oversized.emit('data', Buffer.from('four'));
  oversized.emit('end');
  assert.equal(await rejected, 'too_large');
});

test('transcription helper sends bounded audio to OpenAI and exposes only safe transcript text', async () => {
  let request;
  const result = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => ({ text: 'What needs attention?' }) };
    },
  });
  assert.deepEqual(result, { ok: true, transcript: 'What needs attention?' });
  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(request.init.headers.Authorization, `Bearer ${'x'.repeat(24)}`);
  assert.equal(request.init.body.get('language'), 'en');
  assert.equal(request.init.body.get('model'), 'gpt-4o-mini-transcribe');
});

test('transcription helper selects a filename matching the normalized audio type', async () => {
  let filename = '';
  await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/mp4', apiKey: 'x'.repeat(24),
    fetchImpl: async (_url, init) => {
      filename = (await init.body.get('file')).name;
      return { ok: true, json: async () => ({ text: 'Hello' }) };
    },
  });
  assert.equal(filename, 'reina-voice.mp4');
});

test('transcription helper returns only safe upstream categories', async () => {
  for (const [status, code] of [[401, 'transcription_auth'], [403, 'transcription_auth'], [400, 'transcription_bad_audio'], [429, 'transcription_rate_limited'], [500, 'transcription_unavailable']]) {
    const result = await transcribeAudio({
      bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: { message: 'do not expose' } }) }),
    });
    assert.deepEqual(result, { ok: false, code });
  }
});

test('transcription helper rejects empty, oversized, unsafe, or unusable results', async () => {
  assert.deepEqual(await transcribeAudio({ bytes: Buffer.alloc(0), type: 'audio/webm', apiKey: 'x'.repeat(24) }), { ok: false, code: 'unavailable' });
  // Markup inside a transcript is REMOVED, and the words around it survive. A
  // spoken sentence used to be discarded whole over one stray bracket and
  // reported to the user as an unheard microphone.
  const withMarkup = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: 'what jobs <b>need</b> attention' }) }),
  });
  assert.deepEqual(withMarkup, { ok: true, transcript: 'what jobs need attention' });

  // Nothing tag-shaped, control, or scheme-like may survive into the result --
  // the browser client independently refuses a transcript that is not already
  // sanitized, so stripping has to be enough on its own.
  const hostile = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ text: 'call​ me <img src=x onerror=alert(1)> back javascript:alert(2) today' }),
    }),
  });
  assert.equal(hostile.ok, true);
  assert.equal(hostile.transcript, 'call me back alert(2) today');
  assert.doesNotMatch(hostile.transcript, /<[^>]*>|javascript\s*:|[\p{Cc}\p{Cf}\p{Cs}]/u);

  // Output that is only markup leaves no words, and that refusal is named
  // separately from a model that answered with nothing at all.
  const onlyMarkup = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: '<script></script>' }) }),
  });
  assert.equal(onlyMarkup.code, 'no_speech');
  assert.equal(onlyMarkup.diagnostic.reason, 'empty_after_sanitizing');

  const silent = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: '' }) }),
  });
  assert.equal(silent.code, 'no_speech');
  assert.equal(silent.diagnostic.rawTextLength, 0);
  assert.equal(silent.diagnostic.rawTextSample, '');
  assert.equal(silent.diagnostic.reason, 'empty');

  const missing = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(missing.diagnostic.reason, 'not_a_string');
  assert.equal(missing.diagnostic.rawTextType, 'undefined');
  const unavailable = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  assert.deepEqual(unavailable, { ok: false, code: 'transcription_unavailable' });
});

test('a refused transcript records its shape durably, and never the words', async () => {
  const writes = [];
  await recordRefusal({
    audioBytes: 62177, audioType: 'audio/webm', rawTextType: 'string',
    rawTextLength: 0, reason: 'empty', model: 'gpt-4o-mini-transcribe',
  }, async (path, options) => { writes.push({ path, options }); return { ok: true }; });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, 'sync_log');
  assert.equal(writes[0].options.method, 'POST');
  const row = JSON.parse(writes[0].options.body);
  assert.equal(row.source, 'reina-transcribe');
  assert.equal(row.status, 'no_transcript');
  assert.deepEqual(row.details, {
    audioBytes: 62177, audioType: 'audio/webm', rawTextType: 'string',
    rawTextLength: 0, reason: 'empty', model: 'gpt-4o-mini-transcribe',
  });
  // The reason code is what separates the failures, so the speech itself is
  // never written to a business table.
  assert.equal(JSON.stringify(row).includes('rawTextSample'), false);
});

test('a failed log write never changes what the caller is told', async () => {
  await recordRefusal({ reason: 'empty' }, async () => { throw new Error('postgrest down'); });
  const result = await transcribeAudio({
    bytes: Buffer.from('audio'), type: 'audio/webm', apiKey: 'x'.repeat(24),
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: '' }) }),
  });
  assert.equal(result.code, 'no_speech');
});

// gpt-4o-mini-transcribe answers 200 with an empty string for audio whisper-1
// transcribes without complaint -- it is the stricter of the two about noisy or
// distant recordings. Seven recordings in one evening, peaks from 1 to 128
// across four microphones, every one empty on a 200, is that signature.
function upstream(responses) {
  const asked = [];
  const fetchImpl = async (_url, init) => {
    const model = init.body.get('model');
    asked.push(model);
    const next = responses[model];
    if (!next) return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => next };
  };
  return { fetchImpl, asked };
}

const AUDIO = { bytes: Buffer.from('x'.repeat(2048)), type: 'audio/webm', apiKey: 'k'.repeat(24) };

test('an empty answer earns a second opinion from a model that judges differently', async () => {
  const { fetchImpl, asked } = upstream({
    'gpt-4o-mini-transcribe': { text: '' },
    'whisper-1': { text: 'what needs attention today' },
  });
  const result = await transcribeAudio({ ...AUDIO, fetchImpl });
  assert.deepEqual(asked, ['gpt-4o-mini-transcribe', 'whisper-1'], 'the primary is asked first');
  assert.equal(result.ok, true);
  assert.equal(result.transcript, 'what needs attention today');
  assert.equal(result.model, 'whisper-1', 'the caller can see which model heard it');
});

test('a transcript from the primary is never second-guessed', async () => {
  const { fetchImpl, asked } = upstream({
    'gpt-4o-mini-transcribe': { text: 'pull up the Kendall job' },
    'whisper-1': { text: 'should not be reached' },
  });
  const result = await transcribeAudio({ ...AUDIO, fetchImpl });
  assert.deepEqual(asked, ['gpt-4o-mini-transcribe'], 'one call, not two');
  assert.equal(result.transcript, 'pull up the Kendall job');
});

test('both models hearing nothing is reported as exactly that', async () => {
  const { fetchImpl, asked } = upstream({
    'gpt-4o-mini-transcribe': { text: '' },
    'whisper-1': { text: '' },
  });
  const rows = [];
  const result = await transcribeAudio({ ...AUDIO, fetchImpl });
  assert.deepEqual(asked, ['gpt-4o-mini-transcribe', 'whisper-1']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_speech');
  // The refusal record is what makes "both were asked" readable afterwards.
  await recordRefusal({ reason: 'empty', model: 'whisper-1', secondOpinion: 'also_empty' },
    async (_table, init) => { rows.push(JSON.parse(init.body)); });
  assert.equal(rows[0].details.secondOpinion, 'also_empty');
});

test('an auth or rate-limit failure is not retried -- asking again changes nothing', async () => {
  const asked = [];
  const fetchImpl = async (_url, init) => {
    asked.push(init.body.get('model'));
    return { ok: false, status: 401 };
  };
  const result = await transcribeAudio({ ...AUDIO, fetchImpl });
  assert.deepEqual(asked, ['gpt-4o-mini-transcribe'], 'a rejected key is rejected for both models');
  assert.equal(result.code, 'transcription_auth');
});
