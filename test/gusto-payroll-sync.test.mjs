// test/gusto-payroll-sync.test.mjs
// Overhead Registries + Payroll Integration — Slice 5.
// Read-only Gusto -> employee_pay sync: burden computed from real runs, is_field
// guessed + flagged, SSN/bank dropped at the boundary, dry-run writes nothing.
// Fully mocked — no network, no DB. Run:
//   node --experimental-test-module-mocks --test test/gusto-payroll-sync.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../api/_lib/gusto-payroll-sync.js');

test('inferIsField: field titles true, office titles false, always a guess', () => {
  assert.equal(m.inferIsField('Lead Carpenter'), true);
  assert.equal(m.inferIsField('HVAC Technician'), true);
  assert.equal(m.inferIsField('Office Manager'), false);
  assert.equal(m.inferIsField('Estimator'), false);
  assert.equal(m.inferIsField(''), true); // default field
});

test('sanitizeEmployee: drops SSN and bank details at the boundary', () => {
  const raw = { uuid: 'e1', first_name: 'Sam', last_name: 'Rae', email: 'SAM@x.com',
    ssn: '123-45-6789', dob: '1990-01-01', bank_account_number: '000123', routing_number: '111000025', home_address: '1 Main' };
  const out = m.sanitizeEmployee(raw);
  assert.deepEqual(Object.keys(out).sort(), ['email', 'first_name', 'last_name', 'terminated', 'uuid']);
  const s = JSON.stringify(out);
  assert.ok(!/123-45-6789|000123|111000025|Main/.test(s), 'no sensitive data survives');
});

test('computeBurdenFromRuns: employer taxes / gross and benefits / gross', () => {
  const payrolls = [
    { totals: { gross_pay: 10000, employer_taxes: 810, benefits: 500 } },
    { totals: { gross_pay: 10000, employer_taxes: 810, benefits: 500 } },
    { totals: { gross_pay: 0 } }, // ignored (no gross)
  ];
  const b = m.computeBurdenFromRuns(payrolls);
  assert.equal(b.runs, 2);
  assert.equal(b.payroll_tax_pct, 8.1);   // 1620/20000
  assert.equal(b.other_burden_pct, 5);    // 1000/20000
});

test('matchProfileId: lowercased trimmed email; null when no match', () => {
  const profiles = [{ id: 'p1', email: 'sam@x.com' }, { id: 'p2', email: 'jo@x.com' }];
  assert.equal(m.matchProfileId('  SAM@X.com ', profiles), 'p1');
  assert.equal(m.matchProfileId('nobody@x.com', profiles), null);
});

test('buildEmployeePayRows: maps pay type, rate, is_field, burden, source=imported', () => {
  const employees = [{ uuid: 'e1', first_name: 'Sam', last_name: 'Rae', email: 'sam@x.com', ssn: 'X' }];
  const jobsByEmp = { e1: [{ primary: true, title: 'Carpenter', compensations: [{ rate: '32', payment_unit: 'Hour' }] }] };
  const rows = m.buildEmployeePayRows(employees, jobsByEmp, [{ id: 'p1', email: 'sam@x.com' }], { payroll_tax_pct: 8.1, other_burden_pct: 5 });
  const r = rows[0];
  assert.equal(r.pay_type, 'hourly');
  assert.equal(r.base_rate, 32);
  assert.equal(r.is_field, true);
  assert.equal(r.profile_id, 'p1');
  assert.equal(r.payroll_tax_pct, 8.1);
  assert.equal(r.source, 'imported');
  assert.ok(!/"ssn"/.test(JSON.stringify(r)));
});

test('runPayrollSync: dry-run returns counts and writes nothing', async () => {
  const calls = [];
  const deps = {
    gustoConnected: async () => true,
    getGustoCompanyId: async () => 'co-1',
    __profiles: [{ id: 'p1', email: 'sam@x.com' }],
    supabaseRequest: async (path, opts) => { calls.push([path, opts && opts.method]); return { ok: true, json: async () => [] }; },
    gustoGet: async (path) => {
      if (path.endsWith('/employees')) return [
        { uuid: 'e1', first_name: 'Sam', last_name: 'Rae', email: 'sam@x.com', ssn: 'X' },
        { uuid: 'e2', first_name: 'Jo', last_name: 'Kim', email: 'jo@x.com' },
      ];
      if (path.includes('/employees/e1/jobs')) return [{ primary: true, title: 'Carpenter', compensations: [{ rate: '32', payment_unit: 'Hour' }] }];
      if (path.includes('/employees/e2/jobs')) return [{ primary: true, title: 'Office Manager', compensations: [{ rate: '62400', payment_unit: 'Year' }] }];
      if (path.includes('/payrolls')) return [{ processed: true, pay_period: { start_date: '2026-07-01', end_date: '2026-07-15' }, totals: { gross_pay: 20000, employer_taxes: 1620, benefits: 1000, company_debit: 22620 } }];
      return [];
    },
  };
  const plan = await m.runPayrollSync({ dryRun: true, deps });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.employees, 2);
  assert.equal(plan.would_write_employee_pay, 2);
  assert.deepEqual(plan.by_pay_type, { hourly: 1, salary: 1 });
  assert.deepEqual(plan.field_office, { field: 1, office: 1 });
  assert.equal(plan.payroll_periods, 1);
  assert.equal(plan.burden.payroll_tax_pct, 8.1);
  // dry run must not have issued any write (POST/PATCH) to supabase
  assert.ok(!calls.some(([, method]) => method === 'POST' || method === 'PATCH'), 'no writes in dry-run');
  // no SSN anywhere in the plan
  assert.ok(!/"ssn"|:"X"/.test(JSON.stringify(plan)));
});

test('runPayrollSync: not connected returns a clean error, no throw', async () => {
  const plan = await m.runPayrollSync({ dryRun: true, deps: { gustoConnected: async () => false } });
  assert.equal(plan.ok, false);
  assert.equal(plan.connected, false);
});
