import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const handler = (await import('../api/onboarding.js')).default;

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function output() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke({ signedIn = true } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('/auth/v1/user')) {
      return signedIn ? response({ id: 'user-1', email: 'owner@example.test' }) : response({}, 401);
    }
    if (value.includes('/rest/v1/trades')) {
      return response([
        { category: 'General', category_sort: 1, name: 'Handyman', slug: 'handyman', sort_order: 1 },
        { category: 'General', category_sort: 1, name: 'Design Build', slug: 'design-build', sort_order: 2 },
        { category: 'Exterior', category_sort: 2, name: 'Roofing', slug: 'roofing', sort_order: 1 },
      ]);
    }
    return response({ error: `unexpected ${value}` }, 500);
  };

  const req = { method: 'GET', query: { resource: 'trades' }, headers: { authorization: 'Bearer test' } };
  const res = output();
  try { await handler(req, res); } finally { global.fetch = original; }
  return { res, calls };
}

test('authenticated setup loads and groups the live trades catalog', async () => {
  const { res, calls } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.categories.map(item => [item.category, item.trades.length]), [
    ['General', 2],
    ['Exterior', 1],
  ]);
  assert.ok(calls.some(value => value.includes('/rest/v1/trades')));
  assert.ok(!calls.some(value => value.includes('/rest/v1/company_members')), 'global catalog does not require an existing membership');
});

test('anonymous setup cannot read the trades catalog', async () => {
  const { res, calls } = await invoke({ signedIn: false });
  assert.equal(res.statusCode, 401);
  assert.ok(!calls.some(value => value.includes('/rest/v1/trades')));
});
