// test/company-profile.test.mjs
// Finish Company Setup: api/company.js `update` grew from name/dba to the full
// business profile (address, contact, tax IDs, licensing, locale). This locks in
// the whitelist + validation so onboarding and the edit page persist a real
// profile and can't smuggle arbitrary columns into the companies table.
// Fully mocked — no network, no DB. Run:
//   node --experimental-test-module-mocks --test test/company-profile.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const handler = (await import('../api/company.js')).default;

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

const COMPANY = { id: 'co-1', name: 'Greenwich Handyman', slug: 'greenwich-handyman', plan: 'pro', status: 'active', dba: 'GH Co.' };

// Runs the update handler with a mocked fetch; returns { out, patch } where
// patch is the JSON body sent to the PATCH companies call (or null).
async function runUpdate(body) {
  const original = global.fetch;
  let patch = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    // Tenant resolver: user-1 is an owner-member of co-1.
    if (u.includes('/rest/v1/company_members')) return jsonRes([{ company_id: 'co-1', role: 'owner' }]);
    if (u.includes('/rest/v1/companies') && method === 'GET') return jsonRes([COMPANY]);
    if (u.includes('/rest/v1/companies') && method === 'PATCH') {
      patch = JSON.parse(opts.body || '{}');
      return jsonRes([Object.assign({}, COMPANY, patch)]);
    }
    return jsonRes({ error: 'unexpected ' + method + ' ' + u }, 500);
  };
  const req = {
    method: 'POST',
    query: { resource: 'update' },
    body,
    headers: { authorization: 'Bearer test-token' },
  };
  const out = res();
  try { await handler(req, out); } finally { global.fetch = original; }
  return { out, patch };
}

test('update whitelists the full profile and ignores unknown fields', async () => {
  const { out, patch } = await runUpdate({
    name: 'GH, LLC', dba: 'Greenwich Handyman', phone: '(203) 555-0100',
    website: 'greenwichhandyman.net', ein: '00-1234567', license_number: '103278',
    timezone: 'America/New_York', primary_trade: 'handyman', region: 'northeast',
    city: 'Greenwich', postal_code: '06830',
    hacker_column: 'DROP', is_superadmin: true,   // must be dropped
  });
  assert.equal(out.statusCode, 200);
  assert.equal(patch.name, 'GH, LLC');
  assert.equal(patch.phone, '(203) 555-0100');
  assert.equal(patch.ein, '00-1234567');
  assert.equal(patch.license_number, '103278');
  assert.equal(patch.primary_trade, 'handyman');
  assert.ok(!('hacker_column' in patch), 'unknown column not persisted');
  assert.ok(!('is_superadmin' in patch), 'unknown column not persisted');
});

test('blank email/whitespace clears the column; empty dba -> null', async () => {
  const { out, patch } = await runUpdate({ dba: '   ', website: '' });
  assert.equal(out.statusCode, 200);
  assert.equal(patch.dba, null);
  assert.equal(patch.website, null);
});

test('invalid email is rejected with 400 and no write', async () => {
  const { out, patch } = await runUpdate({ email: 'not-an-email' });
  assert.equal(out.statusCode, 400);
  assert.equal(patch, null);
});

test('valid email passes through', async () => {
  const { out, patch } = await runUpdate({ email: 'office@ghgrp.net' });
  assert.equal(out.statusCode, 200);
  assert.equal(patch.email, 'office@ghgrp.net');
});

test('blank legal name is rejected (never null the company name)', async () => {
  const { out, patch } = await runUpdate({ name: '   ' });
  assert.equal(out.statusCode, 400);
  assert.equal(patch, null);
});

test('state is upper-cased', async () => {
  const { out, patch } = await runUpdate({ state: 'ct' });
  assert.equal(out.statusCode, 200);
  assert.equal(patch.state, 'CT');
});

test('nothing to update -> 400', async () => {
  const { out } = await runUpdate({});
  assert.equal(out.statusCode, 400);
});
