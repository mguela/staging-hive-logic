// test/company-export.test.mjs
// Phase 2 — read-only company data export ("your data is yours"). Owner/admin
// only; best-effort per table; never deletes. Fully mocked.
// Run: node --experimental-test-module-mocks --test test/company-export.test.mjs

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

async function runExport({ role = 'owner' } = {}) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'owner@co.com' });
    if (u.includes('/rest/v1/company_members')) return jsonRes([{ company_id: 'co-1', role }]);
    if (u.includes('/rest/v1/companies') && u.includes('id=eq')) return jsonRes([{ id: 'co-1', name: 'Acme', plan: 'pro' }]);
    if (u.includes('/rest/v1/org_units')) return jsonRes([{ id: 'd1', name: 'Electric' }]);
    if (u.includes('/rest/v1/employee_pay')) return jsonRes([{ id: 'e1', display_name: 'Casey' }]);
    if (u.includes('/rest/v1/cost_lines')) return jsonRes([{ id: 'cl1' }]);
    if (u.includes('/rest/v1/cost_assumptions')) return jsonRes([{ id: 'ca1' }]);
    if (u.includes('/rest/v1/company_rates')) return jsonRes([{ overhead_total: 1000 }]);
    if (u.includes('/rest/v1/insurance_policies')) return jsonRes([{ id: 'ins1' }]);
    if (u.includes('/rest/v1/registry_overhead')) return jsonRes([{ annual_amount: 500 }]);
    return jsonRes({ error: 'unexpected ' + u }, 500);
  };
  const req = { method: 'GET', query: { resource: 'export' }, headers: { authorization: 'Bearer t' } };
  const out = res();
  try { await handler(req, out); } finally { global.fetch = original; }
  return out;
}

test('owner gets a full read-only export bundle', async () => {
  const out = await runExport({ role: 'owner' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.company.id, 'co-1');
  assert.ok(out.body.exported_at);
  assert.equal(out.body.entitlements.plan, 'pro');
  assert.deepEqual(out.body.data.divisions, [{ id: 'd1', name: 'Electric' }]);
  assert.deepEqual(out.body.data.roster, [{ id: 'e1', display_name: 'Casey' }]);
  assert.ok('cost_lines' in out.body.data && 'insurance_policies' in out.body.data);
});

test('admin can export too', async () => {
  const out = await runExport({ role: 'admin' });
  assert.equal(out.statusCode, 200);
});

test('a non-owner/admin member is refused', async () => {
  const out = await runExport({ role: 'member' });
  assert.equal(out.statusCode, 403);
});
