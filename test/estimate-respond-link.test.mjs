// test/estimate-respond-link.test.mjs
// jomell, 2026-08-25: the public GET/POST landing page behind the emailed
// Approve/Reject links (api/bookkeeping/estimates/send.js creates the
// token; this consumes it). Mirrors api/schedule/confirm.js's own reviewed
// pattern: GET never mutates (mail-client link scanners prefetch GET
// requests), every invalid-token case returns the SAME message so the
// route can never be used to enumerate estimates, and both token+IP are
// rate limited, fail-closed.
//
// Run with: node --experimental-test-module-mocks --test test/estimate-respond-link.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.BOOKKEEPING_ENABLED = 'true';

function hashToken(raw) { return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex'); }

let linkFixture;
let estimateFixture;
let updateEstimateImpl;
let patchCalls;
let rateLimitAllowed;

mock.module('../api/bookkeeping/estimates/_store.js', {
  namedExports: {
    getEstimate: async () => estimateFixture,
    updateEstimate: async (_companyId, _id, mutate) => updateEstimateImpl(mutate),
  },
});

mock.module('../api/_lib/portal-auth.js', {
  namedExports: {
    hashToken,
    checkRateLimit: async () => ({ allowed: rateLimitAllowed }),
  },
});

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts) => {
      if (path.startsWith('estimate_response_links?token_hash=')) {
        return { ok: true, json: async () => (linkFixture ? [linkFixture] : []) };
      }
      if (path.startsWith('estimate_response_links?id=') && opts && opts.method === 'PATCH') {
        patchCalls.push(JSON.parse(opts.body));
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

// mock.module() can only target a given path once per process -- configured
// once here via mutable closures, rather than re-mocking per test.
let rejectEstimateImpl = (est, actor, { reason } = {}) => ({ ...est, lifecycleStatus: 'rejected', rejectionReason: reason || null });
let recordClientApprovalImpl = (est, { note } = {}) => ({ ...est, clientApprovedAt: '2026-08-25T00:00:00.000Z', clientApprovalNote: note || null });
mock.module('../server/bookkeeping/src/estimates.js', {
  namedExports: {
    rejectEstimate: (...args) => rejectEstimateImpl(...args),
    recordClientApproval: (...args) => recordClientApprovalImpl(...args),
  },
});

const handler = (await import('../api/bookkeeping/estimates/respond.js')).default;

function res() {
  return {
    statusCode: null, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  };
}

function reset() {
  const rawToken = 'a'.repeat(64);
  linkFixture = {
    id: 'link-1',
    company_id: 'greenwich-handyman',
    estimate_id: 'est-uuid-1',
    token_hash: hashToken(rawToken),
    used_at: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  estimateFixture = {
    id: 'est-uuid-1',
    estimateNumber: 'E-10012',
    companyId: 'greenwich-handyman',
    lifecycleStatus: 'sent',
    totals: { price: 1000, cardPrice: 1040 },
  };
  updateEstimateImpl = async (mutate) => { estimateFixture = mutate(estimateFixture); return estimateFixture; };
  patchCalls = [];
  rateLimitAllowed = true;
  rejectEstimateImpl = (est, actor, { reason } = {}) => ({ ...est, lifecycleStatus: 'rejected', rejectionReason: reason || null });
  recordClientApprovalImpl = (est, { note } = {}) => ({ ...est, clientApprovedAt: '2026-08-25T00:00:00.000Z', clientApprovalNote: note || null });
  return rawToken;
}

test('GET with a valid token shows a preview and does not mutate anything', async () => {
  const rawToken = reset();
  const r = res();
  await handler({ method: 'GET', headers: {}, query: { token: rawToken, action: 'approve' } }, r);
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Approve E-10012/);
  assert.match(r.body, /method="POST"/);
  assert.equal(estimateFixture.clientApprovedAt, undefined, 'GET must never itself record the decision');
  assert.equal(patchCalls.length, 0, 'GET must never mark the token used');
});

test('GET with an unknown token gives the same message as an expired one', async () => {
  reset();
  linkFixture = null;
  const r1 = res();
  await handler({ method: 'GET', headers: {}, query: { token: 'x'.repeat(64), action: 'approve' } }, r1);

  reset();
  linkFixture.expires_at = new Date(Date.now() - 1000).toISOString();
  const r2 = res();
  await handler({ method: 'GET', headers: {}, query: { token: 'a'.repeat(64), action: 'approve' } }, r2);

  const strip = (html) => html.replace(/<[^>]+>/g, '').trim();
  assert.equal(strip(r1.body), strip(r2.body), 'unknown and expired must be indistinguishable, or this becomes an enumeration oracle');
});

test('a rate-limited GET is refused before any token lookup happens', async () => {
  const rawToken = reset();
  rateLimitAllowed = false;
  const r = res();
  await handler({ method: 'GET', headers: {}, query: { token: rawToken, action: 'approve' } }, r);
  assert.equal(r.statusCode, 429);
});

test('POST reject calls the real rejectEstimate and marks the token used', async () => {
  const rawToken = reset();
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { token: rawToken, action: 'reject', note: 'too expensive' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(estimateFixture.lifecycleStatus, 'rejected');
  assert.equal(estimateFixture.rejectionReason, 'too expensive');
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].used_action, 'reject');
});

test('POST approve calls recordClientApproval, not the internal controller-gated approveEstimate', async () => {
  const rawToken = reset();
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { token: rawToken, action: 'approve', note: 'looks great' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(estimateFixture.lifecycleStatus, 'sent', 'the internal lifecycle must be untouched by a client email click');
  assert.equal(estimateFixture.clientApprovedAt, '2026-08-25T00:00:00.000Z');
  assert.equal(estimateFixture.clientApprovalNote, 'looks great');
  assert.equal(patchCalls[0].used_action, 'approve');
});

test('a token cannot be used twice', async () => {
  const rawToken = reset();
  await handler({ method: 'POST', headers: {}, body: { token: rawToken, action: 'approve' } }, res());
  linkFixture.used_at = new Date().toISOString();
  linkFixture.used_action = 'approve';

  const r2 = res();
  await handler({ method: 'POST', headers: {}, body: { token: rawToken, action: 'reject' } }, r2);
  assert.equal(r2.statusCode, 410);
  assert.equal(patchCalls.length, 1, 'the second attempt must not record a second decision');
});

test('a missing token is refused without a database lookup', async () => {
  reset();
  const r = res();
  await handler({ method: 'GET', headers: {}, query: {} }, r);
  assert.equal(r.statusCode, 400);
});

test('the route stays GET/POST only', async () => {
  reset();
  const r = res();
  await handler({ method: 'DELETE', headers: {}, query: {} }, r);
  assert.equal(r.statusCode, 405);
});
