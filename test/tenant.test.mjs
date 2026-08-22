// test/tenant.test.mjs
// Multi-tenant Phase 1 — the resolver that replaces the hardcoded
// `slug = 'greenwich-handyman'`. Verifies the precedence: explicit membership
// first, sole-company fallback only while exactly one company exists, null when
// ambiguous. Fully injected supabaseRequest — no network.
// Run: node --test test/tenant.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveCompany, companyForUser, companySlugForUser } = await import('../api/_lib/tenant.js');

function json(data, ok = true) {
  return { ok, json: async () => data, text: async () => JSON.stringify(data) };
}
// Build an injectable supabaseRequest from a path->response map function.
function sb(route) { return async (path) => route(path); }

test('membership wins — never falls back to companies', async () => {
  const calls = [];
  const deps = { supabaseRequest: sb((path) => {
    calls.push(path);
    if (path.startsWith('company_members')) return json([{ company_id: 'c1', role: 'admin' }]);
    throw new Error('must not query companies when a membership exists');
  }) };
  const t = await resolveCompany({ id: 'u1' }, deps);
  assert.deepEqual(t, { company_id: 'c1', role: 'admin', via: 'membership' });
  assert.ok(calls[0].includes('user_id=eq.u1'));
});

test('signed-in user with no membership -> null (must provision; never falls into another tenant)', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('company_members')) return json([]);
    if (path.startsWith('companies?select=id')) return json([{ id: 'only' }]);
    return json([], false);
  }) };
  const t = await resolveCompany({ id: 'u1' }, deps);
  assert.equal(t, null);
});

test('no membership + two companies -> null (never guess across tenants)', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('company_members')) return json([]);
    if (path.startsWith('companies?select=id')) return json([{ id: 'a' }, { id: 'b' }]);
    return json([], false);
  }) };
  const t = await resolveCompany({ id: 'u1' }, deps);
  assert.equal(t, null);
});

test('cron/service call (no user) still resolves the sole company as service', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('companies?select=id')) return json([{ id: 'only' }]);
    return json([], false);
  }) };
  const t = await resolveCompany(null, deps);
  assert.deepEqual(t, { company_id: 'only', role: 'service', via: 'sole-company' });
});

test('user membership query failure -> null, never falls into the sole company', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('company_members')) return json({ error: 'boom' }, false);
    if (path.startsWith('companies?select=id')) return json([{ id: 'only' }]);
    return json([], false);
  }) };
  const t = await resolveCompany({ id: 'u1' }, deps);
  assert.equal(t, null);
});

test('companyForUser returns the full company row', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('company_members')) return json([{ company_id: 'c1', role: 'owner' }]);
    if (path.startsWith('companies?id=eq.c1')) return json([{ id: 'c1', name: 'Acme LLC', dba: 'Acme' }]);
    return json([], false);
  }) };
  const r = await companyForUser({ id: 'u1' }, deps);
  assert.equal(r.role, 'owner');
  assert.equal(r.via, 'membership');
  assert.equal(r.company.name, 'Acme LLC');
});

test('companyForUser returns null when no company resolves', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('company_members')) return json([]);
    if (path.startsWith('companies?select=id')) return json([{ id: 'a' }, { id: 'b' }]);
    return json([], false);
  }) };
  const r = await companyForUser({ id: 'u1' }, deps);
  assert.equal(r, null);
});

test('companySlugForUser returns the slug (text-keyed subsystems)', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('company_members')) return json([{ company_id: 'c1', role: 'owner' }]);
    if (path.startsWith('companies?id=eq.c1')) return json([{ id: 'c1', slug: 'acme-electric', name: 'Acme' }]);
    return json([], false);
  }) };
  const slug = await companySlugForUser({ id: 'u1' }, deps);
  assert.equal(slug, 'acme-electric');
});

test('companySlugForUser returns null when no company resolves', async () => {
  const deps = { supabaseRequest: sb((path) => {
    if (path.startsWith('company_members')) return json([]);
    if (path.startsWith('companies?select=id')) return json([{ id: 'a' }, { id: 'b' }]);
    return json([], false);
  }) };
  const slug = await companySlugForUser({ id: 'u1' }, deps);
  assert.equal(slug, null);
});
