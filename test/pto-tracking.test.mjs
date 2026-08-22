// test/pto-tracking.test.mjs
// Real PTO tracking (2026-08-11), replacing two disconnected, fully-mock
// pages (Team > PTO Tracking, Employee Portal's request form) that had no
// backend at all -- their approve/decline buttons fabricated success
// toasts ("Day board updated, Steve notified") with zero real effect.
// Covers: auth requirement, employee request submission, scope=mine vs
// scope=all visibility, owner-only approve/decline (incl. the
// status=eq.pending race guard), and the yearly-allowance balance math.
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/pto-tracking.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// scenario controls what the mocked Supabase/auth layer returns
let scenario = {};

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: scenario.email || 'field@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: scenario.email || 'field@ghgrp.net', role: scenario.profileRole || null }]);
    if (u.includes('/rest/v1/users') && u.includes('status=neq.DEACTIVATED')) return jsonRes(scenario.activeUsers || []);
    if (u.includes('/rest/v1/users')) return jsonRes(scenario.userRow ? [scenario.userRow] : []);
    if (u.includes('/rest/v1/employee_roles')) return jsonRes(scenario.permissionRoles ? [{ permission_roles: scenario.permissionRoles }] : []);
    if (u.includes('/rest/v1/pto_requests') && opts && opts.method === 'POST') {
      const inserted = JSON.parse(opts.body)[0];
      const row = Object.assign({ id: 'req-new', status: 'pending', requested_at: '2026-08-11T00:00:00Z', decided_by_email: null, decided_at: null, decision_note: null }, inserted);
      scenario.insertedRow = row;
      return jsonRes([row]);
    }
    if (u.includes('/rest/v1/pto_requests') && opts && opts.method === 'PATCH') {
      if (scenario.decideMatches === false) return jsonRes([]);
      const patch = JSON.parse(opts.body);
      return jsonRes([Object.assign({ id: 'req-1', employee_jobber_id: 'J1', employee_name: 'Steve', start_date: '2026-08-15', end_date: '2026-08-16', request_type: 'vacation', note: null }, patch)]);
    }
    if (u.includes('/rest/v1/pto_requests')) return jsonRes(scenario.requestRows || []);
    if (u.includes('/rest/v1/pto_allowances') && opts && opts.method === 'POST') {
      const row = JSON.parse(opts.body)[0];
      return jsonRes([row]);
    }
    if (u.includes('/rest/v1/pto_allowances')) return jsonRes(scenario.allowanceRows || []);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

function todayPlus(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const trackMod = await import('../api/track1.js');

async function callTrack1(resource, { method = 'GET', body, query = {}, authHeader = 'Bearer usertoken' } = {}) {
  const req = { method, query: Object.assign({ resource }, query), headers: { authorization: authHeader }, body };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

// ---------------------------------------------------- auth

test('pto_requests: an anonymous request 401s', async () => {
  const r = await withMockedFetch(() => callTrack1('pto_requests', { authHeader: '' }));
  assert.equal(r.statusCode, 401);
});

// ---------------------------------------------------- submission

test('pto_requests POST: an employee can submit a request, resolved to their real Jobber record by email', async () => {
  scenario = { email: 'steve@ghgrp.net', userRow: { jobber_id: 'J1', name: 'Steve' } };
  const r = await withMockedFetch(() => callTrack1('pto_requests', {
    method: 'POST',
    body: { startDate: '2026-08-15', endDate: '2026-08-16', requestType: 'vacation', note: 'Family trip' },
  }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.request.employeeJobberId, 'J1');
  assert.equal(r.body.request.status, 'pending');
  assert.equal(r.body.request.days, 2);
});

test('pto_requests POST: rejects a request with no matching employee record, does not insert', async () => {
  scenario = { email: 'unknown@ghgrp.net', userRow: null };
  const r = await withMockedFetch(() => callTrack1('pto_requests', {
    method: 'POST',
    body: { startDate: '2026-08-15', endDate: '2026-08-16' },
  }));
  assert.equal(r.statusCode, 400);
  assert.equal(scenario.insertedRow, undefined);
});

test('pto_requests POST: rejects endDate before startDate', async () => {
  scenario = { email: 'steve@ghgrp.net', userRow: { jobber_id: 'J1', name: 'Steve' } };
  const r = await withMockedFetch(() => callTrack1('pto_requests', {
    method: 'POST',
    body: { startDate: '2026-08-16', endDate: '2026-08-15' },
  }));
  assert.equal(r.statusCode, 400);
});

// ---------------------------------------------------- visibility (scope=mine vs all)

test('pto_requests GET scope=all: a non-owner is rejected 403', async () => {
  scenario = { email: 'field@ghgrp.net', userRow: { jobber_id: 'J3', name: 'Field Tech' }, permissionRoles: ['field_tech'] };
  const r = await withMockedFetch(() => callTrack1('pto_requests', { query: { scope: 'all' } }));
  assert.equal(r.statusCode, 403);
});

test('pto_requests GET scope=all: an owner sees every request', async () => {
  scenario = { email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'], requestRows: [
    { id: 'r1', employee_jobber_id: 'J1', employee_name: 'Steve', start_date: '2026-08-15', end_date: '2026-08-16', request_type: 'vacation', status: 'pending', note: null, requested_at: '2026-08-01T00:00:00Z' },
    { id: 'r2', employee_jobber_id: 'J2', employee_name: 'Jeff', start_date: '2026-09-01', end_date: '2026-09-01', request_type: 'personal', status: 'pending', note: null, requested_at: '2026-08-02T00:00:00Z' },
  ] };
  const r = await withMockedFetch(() => callTrack1('pto_requests', { query: { scope: 'all' } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.requests.length, 2);
  assert.equal(r.body.canApprove, true);
});

test('pto_requests GET (default scope=mine): a field tech only sees their own requests', async () => {
  scenario = { email: 'steve@ghgrp.net', userRow: { jobber_id: 'J1', name: 'Steve' }, permissionRoles: ['field_tech'],
    requestRows: [{ id: 'r1', employee_jobber_id: 'J1', employee_name: 'Steve', start_date: '2026-08-15', end_date: '2026-08-16', request_type: 'vacation', status: 'pending', note: null, requested_at: '2026-08-01T00:00:00Z' }] };
  const r = await withMockedFetch(() => callTrack1('pto_requests'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.canApprove, false);
  assert.equal(r.body.requests.length, 1);
});

// ---------------------------------------------------- approve/decline

test('pto_decide: a non-owner cannot approve or decline', async () => {
  scenario = { email: 'field@ghgrp.net', userRow: { jobber_id: 'J3', name: 'Field Tech' }, permissionRoles: ['field_tech'] };
  const r = await withMockedFetch(() => callTrack1('pto_decide', { method: 'POST', body: { id: 'r1', decision: 'approved' } }));
  assert.equal(r.statusCode, 403);
});

test('pto_decide: an owner can approve a pending request', async () => {
  scenario = { email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'] };
  const r = await withMockedFetch(() => callTrack1('pto_decide', { method: 'POST', body: { id: 'r1', decision: 'approved' } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.request.status, 'approved');
  assert.equal(r.body.request.decidedByEmail, 'chris@ghgrp.net');
});

test('pto_decide: deciding an already-decided request returns 409, not a silent success', async () => {
  scenario = { email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'], decideMatches: false };
  const r = await withMockedFetch(() => callTrack1('pto_decide', { method: 'POST', body: { id: 'r1', decision: 'approved' } }));
  assert.equal(r.statusCode, 409);
});

test('pto_decide: rejects an invalid decision value', async () => {
  scenario = { email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'] };
  const r = await withMockedFetch(() => callTrack1('pto_decide', { method: 'POST', body: { id: 'r1', decision: 'maybe' } }));
  assert.equal(r.statusCode, 400);
});

// ---------------------------------------------------- balances

test('pto_balances scope=all: computes remaining = allowance - approved days used, per employee, and includes employees with no history yet', async () => {
  scenario = {
    email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'],
    activeUsers: [{ jobber_id: 'J1', name: 'Steve' }, { jobber_id: 'J2', name: 'Jeff' }, { jobber_id: 'J4', name: 'New Hire' }],
    allowanceRows: [{ employee_jobber_id: 'J1', year: 2026, allowance_days: 15 }, { employee_jobber_id: 'J2', year: 2026, allowance_days: 10 }],
    requestRows: [
      { employee_jobber_id: 'J1', employee_name: 'Steve', start_date: '2026-08-15', end_date: '2026-08-16' }, // 2 days
      { employee_jobber_id: 'J1', employee_name: 'Steve', start_date: '2026-03-01', end_date: '2026-03-01' }, // 1 day
    ],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { scope: 'all', year: '2026' } }));
  assert.equal(r.statusCode, 200);
  const steve = r.body.balances.find((b) => b.employeeJobberId === 'J1');
  const jeff = r.body.balances.find((b) => b.employeeJobberId === 'J2');
  const newHire = r.body.balances.find((b) => b.employeeJobberId === 'J4');
  assert.equal(steve.allowanceDays, 15);
  assert.equal(steve.usedDays, 3);
  assert.equal(steve.remainingDays, 12);
  assert.equal(jeff.usedDays, 0);
  assert.equal(jeff.remainingDays, 10);
  assert.ok(newHire, 'an active employee with zero PTO history must still appear so an owner can set their allowance');
  assert.equal(newHire.allowanceDays, 0);
  assert.equal(newHire.remainingDays, 0);
});

test('pto_balances (own view): a non-owner only gets their own balance, not the whole roster', async () => {
  scenario = {
    email: 'steve@ghgrp.net', userRow: { jobber_id: 'J1', name: 'Steve' }, permissionRoles: ['field_tech'],
    allowanceRows: [{ employee_jobber_id: 'J1', year: 2026, allowance_days: 15 }],
    requestRows: [{ employee_jobber_id: 'J1', employee_name: 'Steve', start_date: '2026-08-15', end_date: '2026-08-16' }],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { year: '2026' } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.balances, undefined);
  assert.equal(r.body.allowanceDays, 15);
  assert.equal(r.body.usedDays, 2);
  assert.equal(r.body.remainingDays, 13);
});

// ---------------------------------------------------- allowance set

test('pto_allowance_set: only an owner can set an allowance', async () => {
  scenario = { email: 'field@ghgrp.net', userRow: { jobber_id: 'J3', name: 'Field Tech' }, permissionRoles: ['field_tech'] };
  const r = await withMockedFetch(() => callTrack1('pto_allowance_set', { method: 'POST', body: { employeeJobberId: 'J1', year: 2026, allowanceDays: 15 } }));
  assert.equal(r.statusCode, 403);
});

test('pto_allowance_set: rejects a negative allowance', async () => {
  scenario = { email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'] };
  const r = await withMockedFetch(() => callTrack1('pto_allowance_set', { method: 'POST', body: { employeeJobberId: 'J1', year: 2026, allowanceDays: -5 } }));
  assert.equal(r.statusCode, 400);
});

test('pto_allowance_set: an owner can set a valid allowance', async () => {
  scenario = { email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'] };
  const r = await withMockedFetch(() => callTrack1('pto_allowance_set', { method: 'POST', body: { employeeJobberId: 'J1', year: 2026, allowanceDays: 15 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.allowance.allowance_days, 15);
});

// ---------------------------------------------------- accrual, pending, upcoming, burnout (Phase 1 coverage/accrual pass)

test('pto_balances scope=all: accruedDays is the full allowance for a past year (fully accrued)', async () => {
  const pastYear = new Date().getUTCFullYear() - 1;
  scenario = {
    email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'],
    activeUsers: [{ jobber_id: 'J1', name: 'Steve' }],
    allowanceRows: [{ employee_jobber_id: 'J1', year: pastYear, allowance_days: 12 }],
    requestRows: [],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { scope: 'all', year: String(pastYear) } }));
  assert.equal(r.statusCode, 200);
  const steve = r.body.balances.find((b) => b.employeeJobberId === 'J1');
  assert.equal(steve.accruedDays, 12);
});

test('pto_balances scope=all: accruedDays is 0 for a future year (nothing accrued yet)', async () => {
  const futureYear = new Date().getUTCFullYear() + 1;
  scenario = {
    email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'],
    activeUsers: [{ jobber_id: 'J1', name: 'Steve' }],
    allowanceRows: [{ employee_jobber_id: 'J1', year: futureYear, allowance_days: 12 }],
    requestRows: [],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { scope: 'all', year: String(futureYear) } }));
  assert.equal(r.statusCode, 200);
  const steve = r.body.balances.find((b) => b.employeeJobberId === 'J1');
  assert.equal(steve.accruedDays, 0);
});

test('pto_balances (own view): accruedDays is included alongside allowance/used/remaining', async () => {
  const pastYear = new Date().getUTCFullYear() - 1;
  scenario = {
    email: 'steve@ghgrp.net', userRow: { jobber_id: 'J1', name: 'Steve' }, permissionRoles: ['field_tech'],
    allowanceRows: [{ employee_jobber_id: 'J1', year: pastYear, allowance_days: 12 }],
    requestRows: [],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { year: String(pastYear) } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.accruedDays, 12);
});

test('pto_balances scope=all: pendingDays sums an employee\'s pending (not approved) requests separately from usedDays', async () => {
  const pastYear = new Date().getUTCFullYear() - 1;
  scenario = {
    email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'],
    activeUsers: [{ jobber_id: 'J1', name: 'Steve' }],
    allowanceRows: [{ employee_jobber_id: 'J1', year: pastYear, allowance_days: 12 }],
    // the mock's generic /rest/v1/pto_requests matcher returns this same
    // array for both the approved-only and pending-only queries the handler
    // makes -- fine here since none of these rows are 'approved'.
    requestRows: [
      { employee_jobber_id: 'J1', employee_name: 'Steve', start_date: pastYear + '-06-01', end_date: pastYear + '-06-03' },
    ],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { scope: 'all', year: String(pastYear) } }));
  const steve = r.body.balances.find((b) => b.employeeJobberId === 'J1');
  assert.equal(steve.usedDays, 3, 'the approved-days query also matches these rows in the mock, so usedDays picks them up too -- pendingDays below is what this test actually checks');
  assert.equal(steve.pendingDays, 3);
});

test('pto_balances scope=all: upcomingApproved surfaces the nearest not-yet-finished approved request, ignoring past ones', async () => {
  scenario = {
    email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'],
    activeUsers: [{ jobber_id: 'J1', name: 'Steve' }],
    allowanceRows: [{ employee_jobber_id: 'J1', year: new Date().getUTCFullYear(), allowance_days: 20 }],
    requestRows: [
      { employee_jobber_id: 'J1', employee_name: 'Steve', start_date: todayPlus(-30), end_date: todayPlus(-28) },
      { employee_jobber_id: 'J1', employee_name: 'Steve', start_date: todayPlus(5), end_date: todayPlus(7) },
    ],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { scope: 'all' } }));
  const steve = r.body.balances.find((b) => b.employeeJobberId === 'J1');
  assert.ok(steve.upcomingApproved, 'a future approved request should surface as upcomingApproved');
  assert.equal(steve.upcomingApproved.startDate, todayPlus(5));
  assert.equal(steve.upcomingApproved.endDate, todayPlus(7));
});

test('pto_balances scope=all: burnoutFlag trips when most of a fully-accrued (past-year) allowance is still unused', async () => {
  const pastYear = new Date().getUTCFullYear() - 1;
  scenario = {
    email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'],
    activeUsers: [{ jobber_id: 'J1', name: 'Gerry' }, { jobber_id: 'J2', name: 'Steve' }],
    allowanceRows: [{ employee_jobber_id: 'J1', year: pastYear, allowance_days: 12 }, { employee_jobber_id: 'J2', year: pastYear, allowance_days: 12 }],
    requestRows: [
      { employee_jobber_id: 'J2', employee_name: 'Steve', start_date: pastYear + '-06-01', end_date: pastYear + '-06-08' }, // 8 of 12 used -> not a burnout case
    ],
  };
  const r = await withMockedFetch(() => callTrack1('pto_balances', { query: { scope: 'all', year: String(pastYear) } }));
  const gerry = r.body.balances.find((b) => b.employeeJobberId === 'J1');
  const steve = r.body.balances.find((b) => b.employeeJobberId === 'J2');
  assert.equal(gerry.usedDays, 0);
  assert.equal(gerry.burnoutFlag, true, 'a fully-accrued year with 0 of 12 days used should trip the burnout flag');
  assert.equal(steve.burnoutFlag, false, 'only 4 of 12 days remaining (33%) should not trip the burnout flag');
});

// ---------------------------------------------------- coverage map

test('pto_coverage: an anonymous request 401s', async () => {
  const r = await withMockedFetch(() => callTrack1('pto_coverage', { authHeader: '' }));
  assert.equal(r.statusCode, 401);
});

test('pto_coverage: a non-owner is rejected 403', async () => {
  scenario = { email: 'field@ghgrp.net', userRow: { jobber_id: 'J3', name: 'Field Tech' }, permissionRoles: ['field_tech'] };
  const r = await withMockedFetch(() => callTrack1('pto_coverage'));
  assert.equal(r.statusCode, 403);
});

test('pto_coverage: owner sees a 14-day grid, per-employee, with approved PTO taking priority over a pending request on the same day', async () => {
  scenario = {
    email: 'chris@ghgrp.net', userRow: { jobber_id: 'CHRIS1', name: 'Chris' }, permissionRoles: ['owner'],
    activeUsers: [{ jobber_id: 'J1', name: 'Steve' }, { jobber_id: 'J2', name: 'Jeff' }],
    requestRows: [
      { employee_jobber_id: 'J1', start_date: todayPlus(1), end_date: todayPlus(2), status: 'approved' },
      { employee_jobber_id: 'J2', start_date: todayPlus(1), end_date: todayPlus(2), status: 'pending' },
    ],
  };
  const r = await withMockedFetch(() => callTrack1('pto_coverage'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.days.length, 14);
  assert.equal(r.body.days[0], todayPlus(0));
  assert.equal(r.body.days[13], todayPlus(13));
  const steve = r.body.employees.find((e) => e.employeeJobberId === 'J1');
  const jeff = r.body.employees.find((e) => e.employeeJobberId === 'J2');
  assert.equal(steve.days[0], 'working');
  assert.equal(steve.days[1], 'pto');
  assert.equal(steve.days[2], 'pto');
  assert.equal(steve.days[3], 'working');
  assert.equal(jeff.days[1], 'pending');
});
