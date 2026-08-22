// test/invites-tenant.test.mjs
// Multi-tenant Phase 1 — api/invites.js create() must stamp the INVITING
// admin's company onto the invite (resolved from their membership), so the hire
// who redeems the token later lands in the right tenant. redeem()/finish()
// already source company_id from the invite/session, which is correct.
// Fully mocked. Run: node --experimental-test-module-mocks --test test/invites-tenant.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.RESEND_API_KEY;   // keep the email path off for the test

const handler = (await import('../api/invites.js')).default;

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

// membership: company_id the admin belongs to (null = none)
// companiesList: what the sole-company fallback count query returns
async function runCreate(body, { membership = 'co-9', companiesList = [{ id: 'co-9' }] } = {}) {
  const original = global.fetch;
  let insertBody = null;
  let emailedSubject = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'admin-1', email: 'admin@x.com' });
    if (u.includes('/rest/v1/company_members')) return jsonRes(membership ? [{ company_id: membership, role: 'owner' }] : []);
    if (u.includes('/rest/v1/companies') && u.includes('select=id')) return jsonRes(companiesList);
    if (u.includes('/rest/v1/companies') && u.includes('id=eq')) return jsonRes([{ id: 'co-9', name: 'Acme Electric' }]);
    if (u.includes('/rest/v1/invites') && method === 'GET') return jsonRes([]);           // no outstanding
    if (u.includes('/rest/v1/invites') && method === 'POST') { insertBody = JSON.parse(opts.body)[0]; return jsonRes([{ id: 'inv-1', ...insertBody }]); }
    return jsonRes({ error: 'unexpected ' + method + ' ' + u }, 500);
  };
  const req = { method: 'POST', query: { resource: 'create' }, headers: { authorization: 'Bearer t', host: 'app.test' }, body };
  const out = res();
  try { await handler(req, out); } finally { global.fetch = original; }
  return { out, insertBody };
}

test('create stamps the admin\'s resolved company_id onto the invite', async () => {
  const { out, insertBody } = await runCreate({ email: 'hire@x.com', first_name: 'Casey' });
  assert.equal(out.statusCode, 200);
  assert.equal(insertBody.company_id, 'co-9', 'invite carries the admin tenant');
  assert.equal(insertBody.email, 'hire@x.com');
  assert.equal(insertBody.created_by, 'admin-1');
  assert.ok(out.body.redeem_link.includes('/field/onboard.html?token='));
});

test('create 404s when the admin resolves to no company (2+ companies, no membership)', async () => {
  const { out, insertBody } = await runCreate({ email: 'hire@x.com' }, { membership: null, companiesList: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(out.statusCode, 404);
  assert.equal(insertBody, null, 'no invite written without a tenant');
});

test('create rejects an invalid email before resolving anything', async () => {
  const { out } = await runCreate({ email: 'not-an-email' });
  assert.equal(out.statusCode, 400);
});
