// api/bookkeeping/_security.test.mjs
// Exercises the shared security helper (applySecurityHeaders, checkRateLimit,
// guardBookkeepingRequest) against a fake res object -- no server, no network.
//
// Run: node --test api/bookkeeping/_security.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySecurityHeaders, checkRateLimit, guardBookkeepingRequest, _resetRateLimiterForTests } from './_security.js';

function fakeRes() {
  const headers = {};
  const res = {
    headers,
    statusCode: null,
    body: null,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; }
  };
  return res;
}

function fakeReq({ method = 'GET', ip = '203.0.113.5', forwarded } = {}) {
  return {
    method,
    socket: { remoteAddress: ip },
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {}
  };
}

test('applySecurityHeaders sets the core hardening headers', () => {
  const res = fakeRes();
  applySecurityHeaders(res);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'same-origin');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(res.headers['content-security-policy'].includes("default-src 'none'"));
});

test('HSTS header is only set in production, never in development/test', () => {
  const res = fakeRes();
  const originalEnv = process.env.NODE_ENV;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.NODE_ENV = 'test';
  process.env.VERCEL_ENV = '';
  applySecurityHeaders(res);
  assert.equal(res.headers['strict-transport-security'], undefined);
  process.env.VERCEL_ENV = 'production';
  const res2 = fakeRes();
  applySecurityHeaders(res2);
  assert.equal(res2.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  process.env.NODE_ENV = originalEnv;
  process.env.VERCEL_ENV = originalVercelEnv;
});

test('checkRateLimit allows requests under the limit and rejects over it, separately for reads and writes', () => {
  _resetRateLimiterForTests();
  const readReq = fakeReq({ method: 'GET', ip: '198.51.100.1' });
  for (let i = 0; i < 300; i += 1) {
    const result = checkRateLimit(readReq, null);
    assert.equal(result.ok, true, `read request ${i + 1} should be allowed`);
  }
  const over = checkRateLimit(readReq, null);
  assert.equal(over.ok, false);
  assert.ok(over.retryAfter > 0);

  // A different IP is a completely separate bucket.
  const otherReq = fakeReq({ method: 'GET', ip: '198.51.100.2' });
  assert.equal(checkRateLimit(otherReq, null).ok, true);

  // Writes have a stricter, independent limit even for the same IP that's
  // already exhausted its read bucket.
  const writeReq = fakeReq({ method: 'POST', ip: '198.51.100.1' });
  for (let i = 0; i < 60; i += 1) {
    const result = checkRateLimit(writeReq, null);
    assert.equal(result.ok, true, `write request ${i + 1} should be allowed`);
  }
  assert.equal(checkRateLimit(writeReq, null).ok, false);
});

test('checkRateLimit keys on a real actor id when one is known, not just IP', () => {
  _resetRateLimiterForTests();
  const req = fakeReq({ method: 'GET', ip: '203.0.113.9' });
  // Two different authenticated actors behind the SAME IP (e.g. a shared
  // office network) get independent buckets when an actor id is passed.
  for (let i = 0; i < 300; i += 1) checkRateLimit(req, 'user-a');
  assert.equal(checkRateLimit(req, 'user-a').ok, false, 'user-a should now be limited');
  assert.equal(checkRateLimit(req, 'user-b').ok, true, 'user-b, same IP, should be unaffected');
});

test('checkRateLimit reads the real client IP from x-forwarded-for, not the proxy socket address', () => {
  _resetRateLimiterForTests();
  const req = fakeReq({ method: 'GET', ip: '10.0.0.1', forwarded: '203.0.113.42, 10.0.0.1' });
  for (let i = 0; i < 300; i += 1) checkRateLimit(req, null);
  assert.equal(checkRateLimit(req, null).ok, false);
  // A request from a DIFFERENT real client behind the same Vercel proxy
  // socket address must not inherit the first client's exhausted bucket.
  const otherReq = fakeReq({ method: 'GET', ip: '10.0.0.1', forwarded: '203.0.113.99, 10.0.0.1' });
  assert.equal(checkRateLimit(otherReq, null).ok, true);
});

test('guardBookkeepingRequest sets headers, allows a fresh request through, and writes a real 429 once exhausted', () => {
  _resetRateLimiterForTests();
  const req = fakeReq({ method: 'POST', ip: '203.0.113.77' });
  for (let i = 0; i < 60; i += 1) {
    const res = fakeRes();
    const allowed = guardBookkeepingRequest(req, res);
    assert.equal(allowed, true, `request ${i + 1} should be allowed through`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', 'headers must be applied even while still under the limit');
    assert.equal(res.statusCode, null, 'guard must not itself respond while under the limit');
  }
  const finalRes = fakeRes();
  const allowed = guardBookkeepingRequest(req, finalRes);
  assert.equal(allowed, false);
  assert.equal(finalRes.statusCode, 429);
  assert.equal(finalRes.body.ok, false);
  assert.ok(finalRes.headers['retry-after']);
});
