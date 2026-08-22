// test/registries.test.mjs
// Overhead Registries + Payroll Integration — Slice 1.
// Unit tests for registry annualization (mo ×12, wk ×52, yr ×1) and the
// vehicle_costs -> loans_obligations link, plus handler auth-gate + list.
// Fully mocked — no network, no DB, no real secret.
// Run: node --experimental-test-module-mocks --test test/registries.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

const mod = await import('../api/registries.js');
const { annualizeRegistry, linkVehicleLoan, REGISTRIES, overheadWithRegistryDedup } = mod;

// ---- annualization: mo ×12, wk ×52, yr ×1 --------------------------------
test('annualizeRegistry: mo -> ×12', () => assert.equal(annualizeRegistry(1180, 'mo'), 14160));
test('annualizeRegistry: wk -> ×52', () => assert.equal(annualizeRegistry(60, 'wk'), 3120));
test('annualizeRegistry: yr -> ×1', () => assert.equal(annualizeRegistry(9600, 'yr'), 9600));
test('annualizeRegistry: unknown freq treated as already annual', () => assert.equal(annualizeRegistry(500, 'once'), 500));
test('annualizeRegistry: non-numeric -> 0', () => assert.equal(annualizeRegistry(null, 'mo'), 0));

// ---- vehicle_costs -> loans_obligations link -----------------------------
test('linkVehicleLoan: resolves the linked loan by loan_id', () => {
  const loans = [{ id: 'loan-1', lender: 'Ally' }, { id: 'loan-2', lender: 'Chase' }];
  const vehicle = { id: 'v1', vehicle_name: 'Truck 12', loan_id: 'loan-2' };
  assert.equal(linkVehicleLoan(vehicle, loans).lender, 'Chase');
});
test('linkVehicleLoan: null when no loan_id', () => {
  assert.equal(linkVehicleLoan({ id: 'v1' }, [{ id: 'loan-1' }]), null);
});
test('linkVehicleLoan: null when loan_id has no match', () => {
  assert.equal(linkVehicleLoan({ id: 'v1', loan_id: 'nope' }, [{ id: 'loan-1' }]), null);
});

// ---- config sanity: 6 registries, subscriptions not company-scoped -------
test('REGISTRIES: six registries, subscriptions is not company-scoped', () => {
  assert.deepEqual(Object.keys(REGISTRIES).sort(), ['insurance', 'leases', 'licenses', 'loans', 'subscriptions', 'vehicles']);
  assert.equal(REGISTRIES.subscriptions.companyScoped, false);
  assert.equal(REGISTRIES.insurance.companyScoped, true);
});

// ---- Slice 2: registry dedup suppresses benchmark, per section -----------
test('overheadWithRegistryDedup: one insurance policy suppresses benchmark insurance lines only', () => {
  const costLines = [
    { section: 'Insurance & bonds', source: 'benchmark', cost_type: 'fixed', annualized: 14160 }, // GL benchmark -> suppressed
    { section: 'Insurance & bonds', source: 'benchmark', cost_type: 'fixed', annualized: 3360 },  // umbrella benchmark -> suppressed
    { section: 'Insurance & bonds', source: 'confirmed', cost_type: 'fixed', annualized: 5000 },  // confirmed -> KEPT
    { section: 'Facilities & occupancy', source: 'benchmark', cost_type: 'fixed', annualized: 50400 }, // other section -> KEPT
  ];
  const registryRows = [{ section: 'Insurance & bonds', annual_amount: 14160 }];
  const r = overheadWithRegistryDedup(costLines, registryRows);

  // benchmark insurance lines gone; confirmed insurance + facilities benchmark kept; registry added
  assert.equal(r.overhead_from_registry, 14160);
  assert.equal(r.overhead_total, 5000 + 50400 + 14160); // 69560
  assert.deepEqual(r.suppressed_sections, ['Insurance & bonds']);
});

test('overheadWithRegistryDedup: no registry rows -> nothing suppressed', () => {
  const costLines = [
    { section: 'Insurance & bonds', source: 'benchmark', cost_type: 'fixed', annualized: 14160 },
    { section: 'Facilities & occupancy', source: 'benchmark', cost_type: 'fixed', annualized: 50400 },
  ];
  const r = overheadWithRegistryDedup(costLines, []);
  assert.equal(r.overhead_total, 14160 + 50400);
  assert.equal(r.overhead_from_registry, 0);
});

// ---- handler: auth gate + list happy path (mocked fetch) -----------------
function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
async function withMockedFetch(scenario, fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return scenario.noUser ? jsonRes({}, 401) : jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/company_members')) return jsonRes([{ company_id: 'gh-1', role: 'owner' }]);
    if (u.includes('/rest/v1/companies')) return jsonRes([{ id: 'gh-1' }]);
    if (u.includes('/rest/v1/insurance_policies')) return jsonRes([{ id: 'ins-1', policy_type: 'General liability', status: 'active' }]);
    if (u.includes('/rest/v1/company_rates')) return jsonRes([{ company_id: 'gh-1', overhead_total: 100000 }]);
    if (u.includes('/rest/v1/registry_overhead')) return jsonRes([{ annual_amount: 14160 }, { annual_amount: 9600 }]);
    return jsonRes({ error: 'unhandled ' + u }, 500);
  };
  try { return await fn(); } finally { global.fetch = original; }
}
async function call(resource, { method = 'GET', body, query = {}, auth = 'Bearer usertoken' } = {}, scenario = {}) {
  const req = { method, query: Object.assign({ resource }, query), headers: auth ? { authorization: auth } : {}, body };
  const r = res();
  await withMockedFetch(scenario, () => mod.default(req, r));
  return r;
}

test('handler: anonymous request 401s', async () => {
  const r = await call('insurance', { auth: null });
  assert.equal(r.statusCode, 401);
});
test('handler: insurance list returns items + rates with overhead_from_registry', async () => {
  const r = await call('insurance', {});
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.rates.overhead_from_registry, 14160 + 9600);
});
test('handler: unknown resource 404s', async () => {
  const r = await call('bogus', {});
  assert.equal(r.statusCode, 404);
});
