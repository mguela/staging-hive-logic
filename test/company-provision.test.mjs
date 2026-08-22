// test/company-provision.test.mjs
// Phase 2 self-serve — api/company.js `provision`: a signed-in user with no
// company creates one and becomes its owner (company + company_members + profile).
// Idempotent when they already belong to a company. Fully mocked.
// Run: node --experimental-test-module-mocks --test test/company-provision.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const handler = (await import('../api/company.js')).default;

function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

// membership: null = user has no company; object = existing membership
async function runProvision(body, { membership = null } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-9', email: 'owner@newco.com' });
    if (u.includes('/rest/v1/company_members') && method === 'GET') return jsonRes(membership ? [membership] : []);
    if (u.includes('/rest/v1/companies') && u.includes('id=eq')) return jsonRes([{ id: membership && membership.company_id, name: 'Existing Co' }]);
    if (u.includes('/rest/v1/companies') && u.includes('slug=eq')) return jsonRes([]);            // slug free
    if (u.includes('/rest/v1/companies') && method === 'POST') { const b = JSON.parse(opts.body)[0]; calls.push(['companies', b]); return jsonRes([{ id: 'co-new', ...b }], 201); }
    if (u.includes('/rest/v1/company_members') && method === 'POST') { calls.push(['members', JSON.parse(opts.body)[0]]); return jsonRes([], 201); }
    if (u.includes('/rest/v1/profiles') && method === 'POST') { calls.push(['profiles', JSON.parse(opts.body)[0]]); return jsonRes([], 201); }
    return jsonRes({ error: 'unexpected ' + method + ' ' + u }, 500);
  };
  const req = { method: 'POST', query: { resource: 'provision' }, headers: { authorization: 'Bearer t' }, body };
  const out = res();
  try { await handler(req, out); } finally { global.fetch = original; }
  return { out, calls };
}

test('provision creates company + owner membership + profile for a company-less user', async () => {
  const { out, calls } = await runProvision({ name: 'New Co Electric', region: 'northeast' });
  assert.equal(out.statusCode, 201);
  assert.equal(out.body.company.id, 'co-new');
  const co = calls.find((c) => c[0] === 'companies')[1];
  assert.equal(co.name, 'New Co Electric');
  assert.equal(co.slug, 'new-co-electric');
  assert.equal(co.plan, 'trial');
  const mem = calls.find((c) => c[0] === 'members')[1];
  assert.equal(mem.user_id, 'user-9');
  assert.equal(mem.role, 'owner');
  assert.equal(mem.company_id, 'co-new');
  assert.ok(calls.find((c) => c[0] === 'profiles'), 'ensures a profile row');
});

test('provision is idempotent — existing member gets their company back, no new company', async () => {
  const { out, calls } = await runProvision({ name: 'Ignored' }, { membership: { company_id: 'co-1', role: 'owner' } });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.already, true);
  assert.equal(out.body.company.id, 'co-1');
  assert.ok(!calls.find((c) => c[0] === 'companies'), 'must not create a second company');
});

test('provision requires a name', async () => {
  const { out } = await runProvision({ name: '   ' });
  assert.equal(out.statusCode, 400);
});
