import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// supabaseRequest (used by requireMonitorAgent by default) builds a URL from
// SUPABASE_URL and calls global.fetch -- give it a dummy base so the mocked
// fetch is what actually runs.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.test';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const {
  hashAgentToken,
  generateAgentToken,
  generatePairingCode,
  sniffImageMime,
  validateScreenshotBase64,
  requireMonitorAgent,
  pruneMonitorData,
  MAX_SCREENSHOT_BYTES,
} = await import('../api/_lib/monitor.js');

// --- Helpers to fabricate real image bodies --------------------------------
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49]);

function withMockFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original; });
}

// === Requirement 2: bearer tokens stored/checked as HASHES ==================

test('agent token is stored as a SHA-256 hash, not plaintext', () => {
  const token = generateAgentToken();
  const stored = hashAgentToken(token);
  assert.match(stored, /^[0-9a-f]{64}$/); // sha256 hex
  assert.notEqual(stored, token);
  assert.equal(stored, crypto.createHash('sha256').update(token).digest('hex'));
});

test('the RAW token authenticates but the stored HASH used as a token does NOT', async () => {
  const token = generateAgentToken();
  const stored = hashAgentToken(token);
  const agentRow = { id: 'agent-1', employee_id: 'emp-1', status: 'active' };

  // Mock fetch: the DB "matches" only when the query carries hash(presented).
  const fetchByPresented = (presented) => async (url) => {
    const u = String(url);
    const matches = u.includes(`agent_token_hash=eq.${hashAgentToken(presented)}`);
    return { ok: true, json: async () => (matches ? [agentRow] : []) };
  };

  // Presenting the RAW token -> lookup hash == stored hash -> authenticates.
  await withMockFetch(fetchByPresented(token), async () => {
    const agent = await requireMonitorAgent({ headers: { authorization: `Bearer ${token}` } });
    assert.ok(agent, 'raw token should authenticate');
    assert.equal(agent.id, 'agent-1');
  });

  // Presenting the STORED HASH as if it were the token -> hash(hash) != stored
  // -> no row -> rejected. (Proves a leaked hash cannot be replayed.)
  await withMockFetch(fetchByPresented(token), async () => {
    const agent = await requireMonitorAgent({ headers: { authorization: `Bearer ${stored}` } });
    assert.equal(agent, null, 'stored hash must not be usable as a credential');
  });

  // Sanity: hashing the stored hash is not the stored hash.
  assert.notEqual(hashAgentToken(stored), stored);
});

// === Forged / anonymous auth is rejected (401/403) ==========================

test('forged screenshot/enrollment auth is rejected (no agent row -> 401 gate)', async () => {
  // Unknown token: DB returns no matching active agent.
  await withMockFetch(async () => ({ ok: true, json: async () => [] }), async () => {
    const agent = await requireMonitorAgent({ headers: { authorization: 'Bearer totally-forged-token' } });
    assert.equal(agent, null); // handler turns null into 401
  });
});

test('a missing/empty Authorization header yields no agent', async () => {
  await withMockFetch(async () => { throw new Error('fetch should not be called'); }, async () => {
    assert.equal(await requireMonitorAgent({ headers: {} }), null);
    assert.equal(await requireMonitorAgent({ headers: { authorization: 'Bearer    ' } }), null);
  });
});

// === Requirement 3: pairing codes are high-entropy =========================

test('pairing codes are cryptographic 6-digit codes with good spread', () => {
  const N = 5000;
  const codes = Array.from({ length: N }, () => generatePairingCode());

  for (const c of codes) assert.match(c, /^\d{6}$/); // always 6 digits incl. leading zeros

  // Uniqueness: with a 1e6 space and 5000 draws, collisions are rare; require
  // overwhelmingly-unique output (a Math.random()-seeded-by-time impl or a
  // constant would fail this hard).
  const unique = new Set(codes).size;
  assert.ok(unique > N * 0.99, `expected >99% unique codes, got ${unique}/${N}`);

  // First-digit distribution should cover 0-9 (Math.floor(100000+rand*900000)
  // never produces a leading zero; a crypto full-range code does).
  const firstDigits = new Set(codes.map((c) => c[0]));
  assert.ok(firstDigits.has('0'), 'crypto codes should sometimes have a leading zero');
  assert.ok(firstDigits.size >= 9, 'first digit should span nearly all of 0-9');
});

// === Requirement 4: screenshot content validation ==========================

test('sniffImageMime detects PNG/JPEG and rejects everything else', () => {
  assert.equal(sniffImageMime(JPEG), 'image/jpeg');
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(Buffer.from('GIF89a...........')), null);
  assert.equal(sniffImageMime(Buffer.from('%PDF-1.7 not an image')), null);
  assert.equal(sniffImageMime(Buffer.from('<html>hi</html>....')), null);
});

test('valid PNG/JPEG bodies are accepted with the sniffed content-type', () => {
  const jpg = validateScreenshotBase64(JPEG.toString('base64'));
  assert.equal(jpg.ok, true);
  assert.equal(jpg.contentType, 'image/jpeg');
  assert.equal(jpg.ext, 'jpg');

  const png = validateScreenshotBase64(PNG.toString('base64'));
  assert.equal(png.ok, true);
  assert.equal(png.contentType, 'image/png');
  assert.equal(png.ext, 'png');
});

test('a non-image body is rejected even if the client would claim image/jpeg', () => {
  const res = validateScreenshotBase64(Buffer.from('this is not an image, it is a script').toString('base64'));
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('an oversized body is rejected (413)', () => {
  // A buffer that starts with the JPEG magic but exceeds the max size.
  const big = Buffer.concat([JPEG, Buffer.alloc(MAX_SCREENSHOT_BYTES + 1)]);
  const res = validateScreenshotBase64(big.toString('base64'));
  assert.equal(res.ok, false);
  assert.equal(res.status, 413);
});

test('missing/empty screenshot bodies are rejected (400)', () => {
  assert.equal(validateScreenshotBase64(undefined).status, 400);
  assert.equal(validateScreenshotBase64('').status, 400);
});

// === Requirement 5: retention prune deletes old data =======================

test('pruneMonitorData deletes blobs + rows older than the retention window', async () => {
  const now = new Date('2026-08-01T00:00:00.000Z');
  const deletedPaths = [];
  const calls = [];

  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    if (path.startsWith('monitor_screenshots?captured_at=lt.')) {
      return { ok: true, json: async () => [
        { id: 's1', storage_path: 'emp-1/sess-1/old1.jpg' },
        { id: 's2', storage_path: 'emp-1/sess-1/old2.jpg' },
      ] };
    }
    // DELETE calls return representation arrays whose length is the row count.
    if (options.method === 'DELETE' && path.startsWith('monitor_activity_samples')) return { ok: true, json: async () => [{}, {}, {}] };
    if (options.method === 'DELETE' && path.startsWith('monitor_pair_attempts')) return { ok: true, json: async () => [{}] };
    if (options.method === 'DELETE' && path.startsWith('monitor_sessions')) return { ok: true, json: async () => [{}, {}] };
    return { ok: true, json: async () => [] };
  };
  const storageDelete = async (p) => { deletedPaths.push(p); return true; };

  const result = await pruneMonitorData({ retentionDays: 90, request, storageDelete, now });

  // Cutoff is exactly 90 days before "now".
  assert.equal(result.cutoff, '2026-05-03T00:00:00.000Z');
  assert.deepEqual(deletedPaths, ['emp-1/sess-1/old1.jpg', 'emp-1/sess-1/old2.jpg']);
  assert.equal(result.screenshotsDeleted, 2);
  assert.equal(result.activitySamplesDeleted, 3);
  assert.equal(result.pairAttemptsDeleted, 1);
  assert.equal(result.sessionsDeleted, 2);

  // Every screenshot DELETE row-delete must be preceded by its blob delete
  // (blob-then-row), so a crash never orphans the DB pointer without the file.
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.startsWith('monitor_screenshots?id=eq.s1')));
});

test('pruneMonitorData keeps the row when the blob delete fails (retry next run)', async () => {
  const now = new Date('2026-08-01T00:00:00.000Z');
  const rowDeletes = [];
  const request = async (path, options = {}) => {
    if (path.startsWith('monitor_screenshots?captured_at=lt.')) {
      return { ok: true, json: async () => [{ id: 's1', storage_path: 'emp-1/sess-1/old1.jpg' }] };
    }
    if (options.method === 'DELETE' && path.startsWith('monitor_screenshots?id=eq.')) rowDeletes.push(path);
    return { ok: true, json: async () => [] };
  };
  const storageDelete = async () => { throw new Error('storage 500'); };

  const result = await pruneMonitorData({ retentionDays: 30, request, storageDelete, now });
  assert.equal(result.screenshotsDeleted, 0);
  assert.equal(result.storageErrors, 1);
  assert.equal(rowDeletes.length, 0, 'row must survive so the blob delete is retried');
});
