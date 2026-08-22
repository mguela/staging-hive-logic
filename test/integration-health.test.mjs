import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildIntegrationHealth } from '../api/_lib/integration-health.js';
import { handleIntegrationHealth } from '../api/integrations-health.js';

const ALL_OAUTH_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-secret',
  JOBBER_CLIENT_ID: 'jobber-id',
  JOBBER_CLIENT_SECRET: 'jobber-secret',
  QBO_CLIENT_ID: 'qbo-id',
  QBO_CLIENT_SECRET: 'qbo-secret',
  GUSTO_CLIENT_ID: 'gusto-id',
  GUSTO_CLIENT_SECRET: 'gusto-secret',
};

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('integration health never returns stored token material', () => {
  const snapshot = buildIntegrationHealth({
    env: ALL_OAUTH_ENV,
    now: Date.parse('2026-08-16T12:00:00Z'),
    rows: [{
      key: 'jobber',
      access_token: 'must-not-leak',
      refresh_token: 'must-not-leak-either',
      updated_at: '2026-08-16T11:00:00Z',
      expires_at: '2026-08-16T13:00:00Z',
    }],
  });

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('access_token'), false);
  assert.equal(serialized.includes('refresh_token'), false);
});

test('stored OAuth connections are reported without refreshing or changing them', () => {
  const snapshot = buildIntegrationHealth({
    env: ALL_OAUTH_ENV,
    now: Date.parse('2026-08-16T12:00:00Z'),
    rows: [{ key: 'qbo', updated_at: '2026-08-16T11:00:00Z', expires_at: '2026-08-16T13:00:00Z' }],
  });
  const qbo = snapshot.integrations.find((item) => item.id === 'qbo');
  assert.equal(snapshot.readOnly, true);
  assert.equal(qbo.state, 'connected');
  assert.equal(qbo.connected, true);
  assert.equal(qbo.healthVerified, false);
  assert.equal(qbo.refreshMode, 'oauth');
  assert.match(qbo.detail, /stored OAuth connection/i);
});

test('an expired access token is refresh-due rather than falsely disconnected', () => {
  const snapshot = buildIntegrationHealth({
    env: ALL_OAUTH_ENV,
    now: Date.parse('2026-08-16T12:00:00Z'),
    rows: [{ key: 'jobber', updated_at: '2026-08-16T10:00:00Z', expires_at: '2026-08-16T11:59:00Z' }],
  });
  const jobber = snapshot.integrations.find((item) => item.id === 'jobber');
  assert.equal(jobber.state, 'refresh_due');
  assert.equal(jobber.connected, true);
  assert.equal(jobber.refreshDue, true);
});

test('Vercel OIDC is preferred over static AI credentials', () => {
  const snapshot = buildIntegrationHealth({
    env: { ...ALL_OAUTH_ENV, VERCEL_OIDC_TOKEN: 'short-lived-oidc', OPENAI_API_KEY: 'legacy' },
    rows: [],
  });
  const ai = snapshot.integrations.find((item) => item.id === 'ai-council');
  assert.equal(ai.state, 'configured');
  assert.equal(ai.healthVerified, false);
  assert.equal(ai.refreshMode, 'oidc');
  assert.match(ai.detail, /renew automatically/i);
});

test('Authorize.Net is reported honestly without attempting a charge', () => {
  const snapshot = buildIntegrationHealth({ env: ALL_OAUTH_ENV, rows: [] });
  const authnet = snapshot.integrations.find((item) => item.id === 'authorize-net');
  assert.equal(authnet.connected, false);
  assert.equal(authnet.state, 'not_configured');
  assert.match(authnet.detail, /not configured/i);
  assert.equal(snapshot.integrations.some((item) => item.id === 'stripe'), false);
});

test('Authorize.Net requires both payment and webhook credentials', () => {
  const partial = buildIntegrationHealth({
    env: { ...ALL_OAUTH_ENV, AUTHNET_API_LOGIN_ID: 'login', AUTHNET_TRANSACTION_KEY: 'transaction' },
  }).integrations.find((item) => item.id === 'authorize-net');
  assert.equal(partial.state, 'partial_setup');
  assert.equal(partial.healthVerified, false);
  assert.match(partial.detail, /signature key is missing/i);

  const configured = buildIntegrationHealth({
    env: {
      ...ALL_OAUTH_ENV,
      AUTHNET_API_LOGIN_ID: 'login',
      AUTHNET_TRANSACTION_KEY: 'transaction',
      AUTHNET_SIGNATURE_KEY: 'signature',
      AUTHNET_ENVIRONMENT: 'production',
    },
  }).integrations.find((item) => item.id === 'authorize-net');
  assert.equal(configured.state, 'configured');
  assert.match(configured.detail, /production/i);
  assert.match(configured.detail, /no live charge was attempted/i);
});

test('only the live Supabase metadata read is labeled verified', () => {
  const snapshot = buildIntegrationHealth({ env: ALL_OAUTH_ENV, rows: [] });
  const verified = snapshot.integrations.filter((item) => item.healthVerified);
  assert.deepEqual(verified.map((item) => item.id), ['supabase']);
});

test('the authenticated endpoint requests metadata fields only', () => {
  const source = fs.readFileSync(new URL('../api/integrations-health.js', import.meta.url), 'utf8');
  assert.match(source, /requireApiAuth/);
  assert.match(source, /select=key,expires_at,updated_at,realm_id,environment/);
  assert.doesNotMatch(source, /select=.*access_token/);
  assert.doesNotMatch(source, /select=.*refresh_token/);
  assert.match(source, /Cache-Control', 'no-store/);
});

test('Settings renders verified integration health instead of hard-coded connected badges', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /fetch\('\/api\/integrations-health'/);
  assert.match(source, /No key is rotated, revoked, or replaced from this screen/);
  assert.match(source, /item\.healthVerified\?'VERIFIED/);
  assert.doesNotMatch(source, /💳 Stripe<span[^\n]+CONNECTED ✓/);
  assert.match(source, /SETUP INCOMPLETE/);
});

test('the endpoint rejects anonymous callers before reading integration metadata', async () => {
  let reads = 0;
  const res = fakeResponse();
  await handleIntegrationHealth({ method: 'GET', headers: {} }, res, {
    requireAuth: async () => ({ ok: false, user: null }),
    supabase: async () => { reads += 1; throw new Error('must not read'); },
    env: ALL_OAUTH_ENV,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(reads, 0);
});

test('the endpoint returns safe metadata to a signed-in user and disables caching', async () => {
  let requestedPath = null;
  const res = fakeResponse();
  await handleIntegrationHealth({ method: 'GET', headers: {} }, res, {
    requireAuth: async () => ({ ok: true, user: { id: 'user-1' } }),
    supabase: async (path) => {
      requestedPath = path;
      return { ok: true, json: async () => ([{ key: 'jobber', updated_at: '2026-08-16T12:00:00Z' }]) };
    },
    env: ALL_OAUTH_ENV,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(requestedPath.includes('access_token'), false);
  assert.equal(requestedPath.includes('refresh_token'), false);
  assert.equal(JSON.stringify(res.body).includes('service-secret'), false);
});

// --- live checks outrank inference -------------------------------------------
//
// The panel reports Jobber and Gusto from stored-token inference, which is a
// floor, not an answer: "a token row exists" is not "the connection works".
// Both have endpoints that answer the real question, and main already had
// renderers for them. Those renderers target #hl-jobber-status and
// #hl-gusto-status, so the panel has to emit those ids and then hand off --
// otherwise replacing the old rows would have QUIETLY DOWNGRADED two live
// checks into guesses while looking like an upgrade.

test('the panel emits the ids the live renderers target, and only for those two', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /item\.id==='jobber'\|\|item\.id==='gusto'\)\?' id="hl-'\+item\.id\+'-status"'/,
    'jobber and gusto rows must carry the id their live renderer looks up');
  // The renderers do getElementById on exactly these.
  assert.match(source, /getElementById\('hl-jobber-status'\)/);
  assert.match(source, /getElementById\('hl-gusto-status'\)/);
});

test('the live renderers run after the panel paints, or they find nothing to update', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // Scoped to the function body. An indexOf across the whole 2.2MB file finds
  // the first `}).join('')` in some unrelated code thousands of lines earlier,
  // which makes the ordering check pass no matter where the calls actually sit
  // -- this test was written that way first and proved nothing.
  const open = source.indexOf('function hlIntegrationHealthRender(){');
  assert.ok(open > -1, 'hlIntegrationHealthRender must exist');
  const body = source.slice(open, source.indexOf('\nfunction ', open + 40));
  const paint = body.indexOf('root.innerHTML=d.integrations.map');
  const jobber = body.indexOf("hlJobberStatusRender();");
  const gusto = body.indexOf("hlGustoStatusRender();");
  assert.ok(paint > -1, 'the panel must assign innerHTML from the endpoint payload');
  assert.ok(jobber > -1 && gusto > -1, 'both live renderers must be invoked inside the panel');
  assert.ok(jobber > paint && gusto > paint,
    'the renderers must run AFTER innerHTML is assigned -- before it, the rows they target do not exist yet');
});

test('the panel reuses the real Connect/Reconnect handlers instead of navigating away', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /if\(id==='jobber' && typeof hlJobberReconnect==='function'\)\{ hlJobberReconnect\(btn\); return; \}/);
  assert.match(source, /if\(id==='gusto' && typeof hlGustoConnect==='function'\)\{ hlGustoConnect\(btn\); return; \}/);
});

test('no integration badge outside a live renderer states a connection as fact', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // Every surviving "CONNECTED ✓" literal must be inside a function that just
  // finished a real check. A bare one in modal markup is the old bug returning.
  const bad = source.split('\n').filter((line) =>
    line.includes('CONNECTED ✓')
    // comments describing the old bug are not the old bug
    && !line.trim().startsWith('//')
    && !line.includes('el.textContent')
    && !line.includes("item.state==='configured'"));
  assert.deepEqual(bad, [], `hardcoded connection badge(s) reintroduced: ${bad.join(' | ')}`);
});
