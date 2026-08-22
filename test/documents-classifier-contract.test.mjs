import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.ANTHROPIC_API_KEY;
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const {
  default: handler,
  decodedBase64ByteLength,
  MAX_CLASSIFIER_SAMPLE_BYTES,
} = await import('../api/documents.js');

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(body, { method = 'POST', token = 'user-token' } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/auth\/v1\/user$/);
    return { ok: true, status: 200, json: async () => ({ id: 'user-1' }) };
  };
  try {
    const req = {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    };
    const res = response();
    await handler(req, res);
    return res;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('base64 length validation measures decoded bytes without allocating a second buffer', () => {
  assert.equal(decodedBase64ByteLength('TQ=='), 1);
  assert.equal(decodedBase64ByteLength('SGVsbG8='), 5);
  assert.equal(decodedBase64ByteLength('not base64!'), null);
});

test('the AI classifier remains unavailable to anonymous callers', async () => {
  const res = await call({ filename: 'invoice.pdf' }, { token: null });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test('an authenticated request gets the deterministic filename fallback when AI is not configured', async () => {
  const res = await call({ filename: 'Vendor Invoice 42.pdf', mimeType: 'application/pdf' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.suggestion.docType, 'invoice');
  assert.equal(res.body.suggestion.confidence, 0.4);
});

test('malformed base64 is refused before any model call', async () => {
  const res = await call({ filename: 'invoice.pdf', mimeType: 'application/pdf', dataBase64: '***not-base64***' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /valid base64/i);
});

test('oversized classifier samples are refused with a filing-safe message', async () => {
  const sample = Buffer.alloc(MAX_CLASSIFIER_SAMPLE_BYTES + 1).toString('base64');
  const res = await call({ filename: 'large.pdf', mimeType: 'application/pdf', dataBase64: sample });
  assert.equal(res.statusCode, 413);
  assert.match(res.body.error, /without automatic classification/i);
  assert.equal(res.body.maxSampleBytes, MAX_CLASSIFIER_SAMPLE_BYTES);
});

test('the classifier is POST-only', async () => {
  const res = await call({ filename: 'invoice.pdf' }, { method: 'GET' });
  assert.equal(res.statusCode, 405);
});
