// test/cost-model.test.mjs
// Company Setup + Cost Model V1 — Slice 2.
// Unit tests for the annualization function (all 11 frequency codes) + the
// pct_field_wages ordering dependency (field wages must be summed before
// percent-of-wages lines resolve), plus a hand-verified full rate roll-up and
// two handler-level tests (auth gate + happy path). Fully mocked — no network,
// no DB, no real secret.
// Run: node --experimental-test-module-mocks --test test/cost-model.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

const mod = await import('../api/cost-model.js');
const { annualizeLine, computeRates, deriveContext } = mod;

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

// ---------------------------------------------------------------------------
// annualizeLine — all 11 frequency codes + unknown
// ---------------------------------------------------------------------------
const CTX = {
  total_headcount: 14, vehicle_count: 5, revenue: 3_000_000, fleet_miles: 100_000,
  billable_hours: 16_072, field_paid_hours: 19_600, field_wages: 784_000, target_net_pct: 10,
};

test('annualizeLine: mo', () => near(annualizeLine({ frequency: 'mo', amount: 100 }, CTX), 1200));
test('annualizeLine: yr', () => near(annualizeLine({ frequency: 'yr', amount: 100 }, CTX), 100));
test('annualizeLine: wk', () => near(annualizeLine({ frequency: 'wk', amount: 100 }, CTX), 5200));
test('annualizeLine: per_employee_mo', () => near(annualizeLine({ frequency: 'per_employee_mo', amount: 10 }, CTX), 10 * 14 * 12));
test('annualizeLine: per_vehicle_mo', () => near(annualizeLine({ frequency: 'per_vehicle_mo', amount: 10 }, CTX), 10 * 5 * 12));
test('annualizeLine: pct_revenue', () => near(annualizeLine({ frequency: 'pct_revenue', amount: 5 }, CTX), 150_000));
test('annualizeLine: per_mile', () => near(annualizeLine({ frequency: 'per_mile', amount: 0.5 }, CTX), 50_000));
test('annualizeLine: per_billable_hour', () => near(annualizeLine({ frequency: 'per_billable_hour', amount: 2 }, CTX), 32_144));
test('annualizeLine: per_field_hour', () => near(annualizeLine({ frequency: 'per_field_hour', amount: 3 }, CTX), 58_800));
test('annualizeLine: pct_field_wages', () => near(annualizeLine({ frequency: 'pct_field_wages', amount: 25 }, CTX), 196_000));
test('annualizeLine: target_net (ignores amount, uses target_net_pct)', () => {
  near(annualizeLine({ frequency: 'target_net', amount: 999 }, CTX), 300_000);
});
test('annualizeLine: unknown frequency -> 0 (never NaN)', () => {
  assert.equal(annualizeLine({ frequency: 'bogus', amount: 100 }, CTX), 0);
});

// ---------------------------------------------------------------------------
// deriveContext — base_hours / field_paid_hours / billable_hours
// ---------------------------------------------------------------------------
test('deriveContext: base/field/billable hours', () => {
  const c = deriveContext({ field_headcount: 10, paid_hours_per_year: 2080, pto_days: 15, nonbillable_pct: 18 });
  assert.equal(c.base_hours, 1960);        // 2080 - 15*8
  assert.equal(c.field_paid_hours, 19600); // 10 * 1960
  near(c.billable_hours, 16072);           // 19600 * 0.82
});

// ---------------------------------------------------------------------------
// ordering dependency: pct_field_wages resolves off summed field wages
// regardless of line order in the array.
// ---------------------------------------------------------------------------
test('computeRates: pct_field_wages uses field_wages even when listed FIRST', () => {
  const assumptions = { field_headcount: 10, paid_hours_per_year: 2080, pto_days: 15, nonbillable_pct: 18, annual_revenue: 3_000_000 };
  const linesBurdenFirst = [
    { frequency: 'pct_field_wages', amount: 25, cost_type: 'direct' }, // listed BEFORE the wage line
    { frequency: 'per_field_hour', amount: 40, cost_type: 'direct' },
  ];
  const r = computeRates(assumptions, linesBurdenFirst);
  assert.equal(r.field_wages, 784_000);   // 40 * 19600
  assert.equal(r.field_burden, 196_000);  // 25% of 784000, not 0
});

// ---------------------------------------------------------------------------
// full hand-verified roll-up (mirrors sql/071 company_rates)
// ---------------------------------------------------------------------------
test('computeRates: full example matches hand-computed figures', () => {
  const assumptions = {
    annual_revenue: 3_000_000, field_headcount: 10, office_headcount: 3, owner_headcount: 1,
    paid_hours_per_year: 2080, pto_days: 15, nonbillable_pct: 18, vehicle_count: 5,
    fleet_miles_per_year: 100_000, workdays_per_year: 250, target_net_pct: 10,
  };
  const lines = [
    { frequency: 'per_field_hour', amount: 40, cost_type: 'direct' },      // wages 784000
    { frequency: 'pct_field_wages', amount: 25, cost_type: 'direct' },     // burden 196000
    { frequency: 'mo', amount: 1000, cost_type: 'fixed' },                 // 12000
    { frequency: 'yr', amount: 5000, cost_type: 'fixed' },                 // 5000
    { frequency: 'wk', amount: 100, cost_type: 'variable' },               // 5200
    { frequency: 'per_employee_mo', amount: 50, cost_type: 'fixed' },      // 8400
    { frequency: 'per_vehicle_mo', amount: 700, cost_type: 'variable', section: 'Vehicles & fleet' },   // 42000 (fleet)
    { frequency: 'pct_revenue', amount: 3, cost_type: 'variable' },        // 90000
    { frequency: 'per_mile', amount: 0.4, cost_type: 'variable', section: 'Vehicles & fleet' },         // 40000 (fleet)
    { frequency: 'per_billable_hour', amount: 1, cost_type: 'direct' },    // 16072
    { frequency: 'yr', amount: 6000, cost_type: 'reserve' },               // reserve 6000
    { frequency: 'target_net', amount: 0, cost_type: 'reserve' },          // profit 300000
  ];
  const r = computeRates(assumptions, lines);

  near(r.billable_hours, 16_072, 1e-6);
  assert.equal(r.field_wages, 784_000);
  assert.equal(r.field_burden, 196_000);
  near(r.direct_total, 784_000 + 196_000 + 16_072, 1e-6); // 996072
  assert.equal(r.overhead_total, 12_000 + 5_000 + 5_200 + 8_400 + 42_000 + 90_000 + 40_000); // 202600
  assert.equal(r.reserve_total, 6_000);
  assert.equal(r.profit_target, 300_000);
  near(r.gross_margin_pct, (3_000_000 - 996_072) / 3_000_000);
  near(r.net_pct, (3_000_000 - 996_072 - 202_600) / 3_000_000);
  near(r.loaded_labor_rate, 980_000 / 16_072);
  near(r.overhead_per_billable_hour, 202_600 / 16_072);
  near(r.breakeven_hourly_rate, 980_000 / 16_072 + 202_600 / 16_072);
  near(r.breakeven_revenue, 202_600 / ((3_000_000 - 996_072) / 3_000_000));
  near(r.min_markup_pct, (202_600 / 996_072) * 100);
  near(r.overhead_per_workday, 202_600 / 250);
  near(r.fleet_cost_per_mile, 82_000 / 100_000); // 0.82
});

test('computeRates: fleet_cost_per_mile counts monthly/annual fleet lines, not just per_mile/per_vehicle_mo', () => {
  const assumptions = { fleet_miles_per_year: 100_000, annual_revenue: 1_000_000, field_headcount: 1 };
  const lines = [
    { frequency: 'per_mile', amount: 0.2, cost_type: 'variable', section: 'Vehicles & fleet' },   // 20000
    { frequency: 'per_vehicle_mo', amount: 100, cost_type: 'fixed', section: 'Vehicles & fleet' }, // 100*0veh*12 = 0 (no vehicle_count)
    { frequency: 'mo', amount: 1000, cost_type: 'fixed', section: 'Vehicles & fleet' },            // 12000  (was MISSED before the fix)
    { frequency: 'yr', amount: 8000, cost_type: 'variable', section: 'Vehicles & fleet' },         // 8000   (was MISSED before the fix)
    { frequency: 'mo', amount: 5000, cost_type: 'fixed', section: 'Facilities' },                  // not fleet — excluded
  ];
  const r = computeRates(assumptions, lines);
  // fleet total = 20000 + 0 + 12000 + 8000 = 40000; per mile = 0.40
  near(r.fleet_cost_per_mile, 40_000 / 100_000);
});

test('computeRates: divide-by-zero guards yield null, not NaN', () => {
  const r = computeRates({}, []); // no revenue, no hours, no lines
  assert.equal(r.gross_margin_pct, null);
  assert.equal(r.loaded_labor_rate, null);
  assert.equal(r.breakeven_revenue, null);
  assert.equal(r.min_markup_pct, null);
  assert.equal(r.fleet_cost_per_mile, null);
  assert.equal(r.direct_total, 0);
});

// ---------------------------------------------------------------------------
// handler-level: auth gate + happy path (mocked fetch)
// ---------------------------------------------------------------------------
function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(scenario, fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return scenario.noUser ? jsonRes({}, 401) : jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/company_members')) return jsonRes([{ company_id: 'gh-1', role: 'owner' }]);
    if (u.includes('/rest/v1/companies')) return jsonRes([{ id: 'gh-1' }]);
    if (u.includes('/rest/v1/company_rates')) return jsonRes({}, 404); // force JS-mirror fallback
    if (u.includes('/rest/v1/cost_assumptions')) return jsonRes([{ company_id: 'gh-1', annual_revenue: 3_000_000, field_headcount: 10, office_headcount: 3, owner_headcount: 1, paid_hours_per_year: 2080, pto_days: 15, nonbillable_pct: 18, vehicle_count: 5, fleet_miles_per_year: 100_000, workdays_per_year: 250, target_net_pct: 10 }]);
    if (u.includes('/rest/v1/cost_lines')) return jsonRes([]);
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
  const r = await call('assumptions', { auth: null });
  assert.equal(r.statusCode, 401);
});

test('handler: assumptions GET returns assumptions + computed rates', async () => {
  const r = await call('assumptions', {});
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.assumptions);
  near(r.body.rates.billable_hours, 16_072, 1e-6);
  assert.equal(r.body.rates._source, 'computed');
});

test('handler: unknown resource 404s', async () => {
  const r = await call('nope', {});
  assert.equal(r.statusCode, 404);
});
