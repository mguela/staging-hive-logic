// test/gusto-provision.test.mjs
// #2 — onboarding → Gusto provisioning. Verifies name splitting, the pay-type →
// Gusto compensation mapping, the 3-step create flow, and graceful failure when
// Gusto isn't connected. Fully mocked — no network. Run:
//   node --experimental-test-module-mocks --test test/gusto-provision.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../api/_lib/gusto-provision.js');

test('splitName: from display name, and explicit first/last wins', () => {
  assert.deepEqual(m.splitName('Casey Field'), { first_name: 'Casey', last_name: 'Field' });
  assert.deepEqual(m.splitName('Madonna'), { first_name: 'Madonna', last_name: 'Hire' });
  assert.deepEqual(m.splitName('ignored', 'Sam', 'Rae'), { first_name: 'Sam', last_name: 'Rae' });
  assert.deepEqual(m.splitName(''), { first_name: 'New', last_name: 'Hire' });
});

test('compensationFor: hourly vs salary mapping', () => {
  assert.deepEqual(m.compensationFor('hourly', 40, '2026-08-15'),
    { rate: '40', payment_unit: 'Hour', flsa_status: 'Nonexempt', effective_date: '2026-08-15' });
  assert.deepEqual(m.compensationFor('salary', 60000, '2026-08-15'),
    { rate: '60000', payment_unit: 'Year', flsa_status: 'Exempt', effective_date: '2026-08-15' });
});

function ok(data) { return { ok: true, status: 201, data }; }

test('provisionEmployee: creates employee → job → hourly compensation', async () => {
  const calls = [];
  const deps = {
    gustoConfigured: () => true,
    gustoConnected: async () => true,
    getGustoCompanyId: async () => 'co-1',
    today: '2026-08-15',
    gustoPost: async (path, body) => {
      calls.push(['POST', path, body]);
      if (path.endsWith('/employees')) return ok({ uuid: 'emp-1' });
      // Job create embeds the auto-created compensation (as Gusto does).
      if (path.includes('/employees/emp-1/jobs')) return ok({ uuid: 'job-1', compensations: [{ uuid: 'comp-1', version: 'v1', effective_date: '2026-08-15' }] });
      return { ok: false, status: 404, data: 'unexpected ' + path };
    },
    gustoGet: async () => [],
    gustoPut: async (path, body) => { calls.push(['PUT', path, body]); return ok({ uuid: 'comp-1' }); },
  };
  const r = await m.provisionEmployee({ display_name: 'Casey Field', email: 'casey@x.com', pay_type: 'hourly', rate: 40 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.gusto_employee_uuid, 'emp-1');
  assert.equal(r.gusto_job_uuid, 'job-1');
  assert.equal(r.self_onboarding, true);
  // employee created with self_onboarding and no SSN in the payload
  const empCall = calls.find(([, p]) => p.endsWith('/employees'));
  assert.equal(empCall[2].self_onboarding, true);
  assert.equal(empCall[2].first_name, 'Casey');
  assert.ok(!('ssn' in empCall[2]), 'never sends SSN');
  // compensation set hourly via PUT to the existing comp (keeps its date)
  const compPut = calls.find(([method, p]) => method === 'PUT' && p.includes('/compensations/comp-1'));
  assert.ok(compPut, 'updates the existing compensation');
  assert.equal(compPut[2].payment_unit, 'Hour');
  assert.ok(!('effective_date' in compPut[2]), 'update must not resend effective_date');
  assert.equal(compPut[2].version, 'v1');
});

test('updateGustoCompensation: finds the job comp and PUTs the new pay in place', async () => {
  const calls = [];
  const deps = {
    today: '2026-08-15',
    gustoGet: async (path) => {
      if (path.includes('/jobs/job-9/compensations')) return [{ uuid: 'comp-9', version: 'v3', effective_date: '2026-08-01' }];
      return [];
    },
    gustoPut: async (path, body) => { calls.push([path, body]); return { ok: true, status: 200, data: { uuid: 'comp-9' } }; },
  };
  const r = await m.updateGustoCompensation({ gusto_job_uuid: 'job-9', pay_type: 'hourly', rate: 45 }, deps);
  assert.equal(r.ok, true);
  const put = calls.find(([p]) => p.includes('/compensations/comp-9'));
  assert.ok(put, 'PUTs the existing comp');
  assert.equal(put[1].payment_unit, 'Hour');
  assert.equal(put[1].rate, '45');
  assert.equal(put[1].version, 'v3');
  assert.ok(!('effective_date' in put[1]), 'no effective_date on update');
});

test('updateGustoCompensation: no job uuid -> clean failure', async () => {
  const r = await m.updateGustoCompensation({ pay_type: 'hourly', rate: 30 }, {});
  assert.equal(r.ok, false);
});

test('provisionEmployee: not connected → clean failure, no throw', async () => {
  const r = await m.provisionEmployee({ display_name: 'X Y' }, {
    gustoConfigured: () => true, gustoConnected: async () => false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.connected, false);
});

test('provisionEmployee: create-employee error is surfaced, flow stops', async () => {
  const r = await m.provisionEmployee({ display_name: 'X Y', pay_type: 'hourly' }, {
    gustoConfigured: () => true, gustoConnected: async () => true, getGustoCompanyId: async () => 'co-1',
    gustoPost: async () => ({ ok: false, status: 403, data: { error: 'forbidden' } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'create_employee');
  assert.equal(r.gusto_status, 403);
});
