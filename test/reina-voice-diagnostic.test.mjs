import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import handler, { boundedRecord, readBoundedJson } from '../api/reina-voice-diagnostic.js';

function makeRequest(body, method = 'POST') {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  const payload = body === undefined
    ? null
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  // The handler awaits authentication before it reads, so the body has to wait
  // for a subscriber rather than firing into an empty emitter.
  const subscribe = req.on.bind(req);
  req.on = (name, listener) => {
    const result = subscribe(name, listener);
    if (name === 'end') {
      setImmediate(() => {
        if (payload) req.emit('data', payload);
        req.emit('end');
      });
    }
    return result;
  };
  return req;
}

function makeResponse() {
  const sent = { headers: {} };
  return {
    sent,
    setHeader(name, value) { sent.headers[name] = value; },
    status(code) { sent.status = code; return this; },
    json(payload) { sent.body = payload; return this; },
  };
}

const allow = async () => ({ ok: true, userId: 'user-1' });

test('a microphone failure the server never saw becomes a readable row', async () => {
  const writes = [];
  const res = makeResponse();
  await handler(makeRequest({
    stage: 'recognition',
    code: 'no-speech',
    peak: 26,
    activityThreshold: 4,
    speechSeen: 1,
    msSinceStart: 4154,
    audioBytes: 62177,
    mimeType: 'audio/webm;codecs=opus',
    deviceLabel: 'Microphone (Insta360 Link)',
  }), res, {
    verifyRequestUser: allow,
    supabaseRequest: async (path, options) => { writes.push({ path, options }); return { ok: true }; },
  });

  assert.equal(res.sent.status, 202);
  assert.deepEqual(res.sent.body, { ok: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, 'sync_log');
  const row = JSON.parse(writes[0].options.body);
  assert.equal(row.source, 'reina-voice-client');
  assert.equal(row.status, 'no-speech');
  assert.deepEqual(row.details, {
    stage: 'recognition',
    code: 'no-speech',
    peak: 26,
    activityThreshold: 4,
    speechSeen: 1,
    msSinceStart: 4154,
    audioBytes: 62177,
    mimeType: 'audio/webm;codecs=opus',
    deviceLabel: 'Microphone (Insta360 Link)',
  });
});

test('the record is rebuilt from a whitelist, so nothing else survives into the row', () => {
  const record = boundedRecord({
    stage: 'transcription',
    code: 'transcription-no-speech',
    peak: 3,
    transcript: 'the words I said out loud',
    audio: 'AAAA'.repeat(500),
    audioBytes: -5,
    msSinceStart: 9_000_000,
    deviceLabel: '<script>alert(1)</script>Headset',
    __proto__: { polluted: true },
  });
  assert.deepEqual(record, {
    stage: 'transcription',
    code: 'transcription-no-speech',
    peak: 3,
    deviceLabel: 'alert(1)Headset',
  });
  // Speech, audio, out-of-range numbers and unknown keys are absent entirely --
  // not nulled, not truncated.
  assert.equal('transcript' in record, false);
  assert.equal('audio' in record, false);
  assert.equal('audioBytes' in record, false);
  assert.equal('msSinceStart' in record, false);
});

test('an unusable record is refused and an unknown stage or code never reaches the log', async () => {
  for (const body of [
    { code: 'no-speech' },
    { stage: 'recognition' },
    { stage: 'not-a-stage', code: 'no-speech' },
    { stage: 'recognition', code: 'has spaces and (parens)' },
    { stage: 'recognition', code: 'x'.repeat(61) },
    'not json at all',
    [],
  ]) {
    const writes = [];
    const res = makeResponse();
    await handler(makeRequest(body), res, {
      verifyRequestUser: allow,
      supabaseRequest: async (...args) => { writes.push(args); return { ok: true }; },
    });
    assert.equal(res.sent.status, 400, `expected refusal for ${JSON.stringify(body)}`);
    assert.equal(writes.length, 0);
  }
});

test('reporting requires a signed-in caller and refuses anything but POST', async () => {
  const denied = makeResponse();
  await handler(makeRequest({ stage: 'turn', code: 'turn_failed' }), denied, {
    verifyRequestUser: async () => ({ ok: false, reason: 'expired' }),
    supabaseRequest: async () => { throw new Error('must not be called'); },
  });
  assert.equal(denied.sent.status, 401);

  const wrongMethod = makeResponse();
  await handler(makeRequest(undefined, 'GET'), wrongMethod, {
    verifyRequestUser: allow,
    supabaseRequest: async () => { throw new Error('must not be called'); },
  });
  assert.equal(wrongMethod.sent.status, 405);
});

test('an oversized body is dropped rather than buffered', async () => {
  const req = makeRequest('x'.repeat(9000));
  assert.equal(await readBoundedJson(req, 4096), null);
});

test('a failed log write still answers the browser, because reporting must not fail twice', async () => {
  const res = makeResponse();
  await handler(makeRequest({ stage: 'startup', code: 'voice_modules_missing' }), res, {
    verifyRequestUser: allow,
    supabaseRequest: async () => { throw new Error('postgrest down'); },
  });
  assert.equal(res.sent.status, 202);
});

// Every measurement added to the browser has to be added here too, or it is
// taken and then discarded at the boundary. That happened twice: clippedPolls
// arrived with the clipping detector and rms/crest with the shape measurement,
// and neither reached a single row -- so an evening of failing recordings was
// written down without the numbers that would have explained them.
test('the railed-window count survives the whitelist', () => {
  const record = boundedRecord({ stage: 'recognition', code: 'input-too-loud', peak: 128, clippedPolls: 7 });
  assert.equal(record.clippedPolls, 7);
});

test('rms and crest survive it, decimals included', () => {
  // boundedCount rejects non-integers, so a ratio needed its own guard.
  const record = boundedRecord({ stage: 'transcription', code: 'transcription-no-speech', peak: 60, rms: 53.7, crest: 1.1 });
  assert.equal(record.rms, 53.7);
  assert.equal(record.crest, 1.1);
});

test('a ratio is still bounded, and nonsense is still dropped', () => {
  const hostile = boundedRecord({
    stage: 'recognition', code: 'input-too-quiet',
    rms: -1, crest: Number.POSITIVE_INFINITY, clippedPolls: 10 ** 9,
  });
  assert.equal('rms' in hostile, false);
  assert.equal('crest' in hostile, false);
  assert.equal('clippedPolls' in hostile, false);
});

test('a ratio arriving as a string is not coerced', () => {
  const record = boundedRecord({ stage: 'recognition', code: 'input-too-quiet', rms: '53.7', crest: '1.1' });
  assert.equal('rms' in record, false);
  assert.equal('crest' in record, false);
});
