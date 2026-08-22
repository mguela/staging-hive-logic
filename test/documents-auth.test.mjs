import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_ANON_KEY = 'publishable-test-key';
delete process.env.ANTHROPIC_API_KEY;

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('/api/documents refuses anonymous classification before any upstream call', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('anonymous request reached upstream'); };
  try {
    const { default: handler } = await import('../api/documents.js');
    const res = response();
    await handler({ method: 'POST', headers: {}, body: { filename: 'invoice.pdf' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls, 0);
  } finally {
    global.fetch = original;
  }
});

test('/api/documents accepts a verified session and returns the safe fallback when AI is unconfigured', async () => {
  const original = global.fetch;
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://supabase.test/auth/v1/user');
    return { ok: true, status: 200, json: async () => ({ id: 'user-1' }) };
  };
  try {
    const { default: handler } = await import('../api/documents.js');
    const res = response();
    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer valid-user-session' },
      body: { filename: 'invoice-100.pdf' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.suggestion.docType, 'invoice');
  } finally {
    global.fetch = original;
  }
});
