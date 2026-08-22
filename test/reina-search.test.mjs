import assert from 'node:assert/strict';
import test from 'node:test';
import { handleReinaSearch, searchHiveLogic } from '../api/reina-search.js';

const enabledEnv = Object.freeze({ NODE_ENV: 'test', REINA_GLOBAL_SEARCH_ENABLED: 'true' });

function response(rows, ok = true) {
  return { ok, json: async () => rows, text: async () => (ok ? '' : 'internal failure') };
}

function resHarness() {
  return {
    code: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function adminRequest(paths, rowsByTable = {}) {
  return async (path) => {
    paths.push(path);
    if (path.startsWith('profiles?')) return response([{ id: 'user-1', role: 'admin' }]);
    const table = path.split('?')[0];
    return response(rowsByTable[table] || []);
  };
}

test('route requires a verified admin profile and sets no-store hardening headers', async () => {
  const res = resHarness();
  await handleReinaSearch(
    { method: 'GET', query: { q: 'Maria' }, headers: {} },
    res,
    { env: enabledEnv, requireUser: async () => ({ id: 'user-1' }), supabaseRequest: async () => response([{ id: 'user-1', role: 'field' }]) },
  );
  assert.equal(res.code, 403);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
});

test('route returns normalized real records without contact, banking, or raw payload fields', async () => {
  const paths = [];
  const res = resHarness();
  await handleReinaSearch(
    { method: 'GET', query: { q: 'Maria' }, headers: { authorization: 'Bearer test' } },
    res,
    {
      env: enabledEnv,
      requireUser: async () => ({ id: 'user-1' }),
      supabaseRequest: adminRequest(paths, {
        clients: [{ jobber_id: 'c1', name: 'Maria Allwin', company_name: null, is_lead: false, is_archived: false, jobber_updated_at: '2026-08-07T12:00:00Z', email: 'must-not-leak@example.com' }],
        jobs_enriched: [{ jobber_id: 'j1', job_number: '421', title: 'Kitchen', job_status: 'active', client_name: 'Maria Allwin', loc_city: 'Greenwich', loc_province: 'CT', jobber_updated_at: '2026-08-07T12:00:00Z', gps_lat: 1 }],
        quotes: [{ jobber_id: 'q1', quote_number: '88', title: 'Kitchen estimate', quote_status: 'draft', client_name: 'Maria Allwin', total: '1250', jobber_updated_at: '2026-08-07T12:00:00Z' }],
      }),
    },
  );
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.results.length, 3);
  assert.deepEqual(res.body.results.map((x) => x.kind), ['CLIENT', 'JOB', 'ESTIMATE']);
  const serialized = JSON.stringify(res.body);
  for (const forbidden of ['must-not-leak', 'gps_lat', 'email', 'phone', 'bank', 'payroll', 'private_note']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
  assert.equal(res.body.results[1].navigation.recordId, 'j1');
  assert.equal(res.body.results[2].amount, 1250);
  assert.ok(paths.every((path) => !path.includes('select=*')));
  assert.ok(paths.some((path) => path.startsWith('clients?select=jobber_id,name,company_name')));
});

test('search sanitizes PostgREST grammar and tolerates one unavailable source', async () => {
  const paths = [];
  const data = await searchHiveLogic('  Maria),email.ilike.*  ', {
    supabaseRequest: async (path) => {
      paths.push(path);
      if (path.startsWith('invoices?')) return response([], false);
      return response([]);
    },
  });
  assert.deepEqual(data.unavailable, ['INVOICE']);
  assert.ok(paths.every((path) => !path.includes('email.ilike')));
  assert.ok(paths.every((path) => !path.includes('select=*')));
});

test('search is default-off and production requires a separate explicit gate', async () => {
  for (const env of [
    {},
    { VERCEL_ENV: 'preview' },
    { VERCEL_ENV: 'production', REINA_GLOBAL_SEARCH_ENABLED: 'true' },
  ]) {
    const res = resHarness();
    let authenticated = false;
    await handleReinaSearch(
      { method: 'GET', query: { q: 'Maria' } },
      res,
      { env, requireUser: async () => { authenticated = true; } },
    );
    assert.equal(res.code, 503);
    assert.equal(res.body.code, 'REINA_SEARCH_DISABLED');
    assert.equal(authenticated, false);
  }

  const res = resHarness();
  await handleReinaSearch(
    { method: 'GET', query: { q: '' } },
    res,
    {
      env: { VERCEL_ENV: 'production', REINA_GLOBAL_SEARCH_ENABLED: 'true', REINA_GLOBAL_SEARCH_PRODUCTION_ENABLED: 'true' },
      requireUser: async () => ({ id: 'user-1' }),
      supabaseRequest: async () => response([{ id: 'user-1', role: 'admin' }]),
    },
  );
  assert.equal(res.code, 200);
});

test('non-GET requests are rejected before feature gating and authentication', async () => {
  const res = resHarness();
  let authenticated = false;
  await handleReinaSearch({ method: 'POST', query: {} }, res, { env: enabledEnv, requireUser: async () => { authenticated = true; } });
  assert.equal(res.code, 405);
  assert.equal(res.headers.Allow, 'GET');
  assert.equal(authenticated, false);
});
