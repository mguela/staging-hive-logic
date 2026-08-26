// test/eod-reports.test.mjs
//
// Reports > EOD Reports (2026-08-27): a Superadmin/Owner-only,
// date-parameterized view of who submitted today's -- or any past day's --
// End-of-Day report. Every EOD view that existed before this
// (handleWorkforceTeam, Monitor's "EOD Today" column) was hardcoded to
// today only; this is the first that takes a real date.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/eod-reports.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const PROFILES = [
  { id: 'user-1', email: 'chris@ghgrp.net', full_name: 'Chris Kendall' }, // owner -- excluded
  { id: 'user-2', email: 'patrick@ghgrp.net', full_name: 'Patrick' },
  { id: 'user-3', email: 'jomell@ghgrp.net', full_name: 'Jomell' },
];
const SUMMARIES_2026_08_20 = [
  { employee_id: 'user-2', summary_date: '2026-08-20', tasks_completed: 'Finished the estimate', plans_tomorrow: 'Site visit', blockers: '', support_needed: '', hours_worked: '8', submitted_at: '2026-08-20T20:00:00Z' },
  // user-3 did not submit on this date
];

let scenario = {};

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'requester-1', email: scenario.email });
    if (u.includes('/rest/v1/profiles')) {
      if (u.includes('id=eq.requester-1')) return jsonRes([{ id: 'requester-1', email: scenario.email, role: scenario.role }]);
      return jsonRes(PROFILES);
    }
    // Two different callers hit /rest/v1/users with different shapes:
    // isOwner()'s getPermissionRoles (the REQUESTER's own email -> jobber_id),
    // and handleEodReports' bulk owner-jobberId -> email resolution.
    if (u.includes('/rest/v1/users')) {
      if (u.includes('email=eq.')) return jsonRes(scenario.jobberId ? [{ jobber_id: scenario.jobberId }] : []);
      if (u.includes('jobber_id=in.')) return jsonRes(scenario.jobberId ? [{ email: 'chris@ghgrp.net' }] : []);
      return jsonRes([]);
    }
    if (u.includes('/rest/v1/employee_roles') && u.includes('permission_roles=cs.')) {
      return jsonRes(scenario.jobberId ? [{ jobber_id: scenario.jobberId }] : []);
    }
    // isOwner() lookup for the REQUESTER (users.email -> jobber_id -> employee_roles)
    if (u.includes('/rest/v1/employee_roles?jobber_id=eq.')) {
      return jsonRes([{ permission_roles: scenario.requesterPermissionRoles || [], permission_role: null }]);
    }
    if (u.includes('/rest/v1/workforce_daily_summaries')) {
      return jsonRes(scenario.date === '2026-08-20' ? SUMMARIES_2026_08_20 : []);
    }
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

const trackMod = await import('../api/track1.js');

async function eodReports(date) {
  const query = { resource: 'eod_reports' };
  if (date) query.date = date;
  const req = { method: 'GET', query, headers: { authorization: 'Bearer usertoken' } };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('a plain admin is refused', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', requesterPermissionRoles: ['office_manager'], jobberId: 'jobber-1', date: '2026-08-20' };
  const r = await withMockedFetch(() => eodReports('2026-08-20'));
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /Superadmin\/Owner/);
});

test('a superadmin sees the real per-person data for the requested date, owner excluded', async () => {
  scenario = { email: 'jomell@ghgrp.net', role: 'superadmin', requesterPermissionRoles: [], jobberId: 'jobber-1', date: '2026-08-20' };
  const r = await withMockedFetch(() => eodReports('2026-08-20'));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.date, '2026-08-20');
  const ids = r.body.roster.map((p) => p.employeeId);
  assert.ok(!ids.includes('user-1'), 'the Owner must not appear in the roster at all');
  assert.equal(r.body.roster.length, 2, 'only the two non-owner profiles');
  const patrick = r.body.roster.find((p) => p.employeeId === 'user-2');
  assert.equal(patrick.submitted, true);
  assert.equal(patrick.summary.tasks_completed, 'Finished the estimate');
  const jomell = r.body.roster.find((p) => p.employeeId === 'user-3');
  assert.equal(jomell.submitted, false);
  assert.equal(jomell.summary, null);
});

test('an Owner (plain admin login role) succeeds too', async () => {
  scenario = { email: 'chris@ghgrp.net', role: 'admin', requesterPermissionRoles: ['owner'], jobberId: 'jobber-1', date: '2026-08-20' };
  const r = await withMockedFetch(() => eodReports('2026-08-20'));
  assert.equal(r.body.ok, true);
});

test('counts add up to the roster length', async () => {
  scenario = { email: 'jomell@ghgrp.net', role: 'superadmin', requesterPermissionRoles: [], jobberId: 'jobber-1', date: '2026-08-20' };
  const r = await withMockedFetch(() => eodReports('2026-08-20'));
  assert.equal(r.body.countSubmitted + r.body.countMissing, r.body.roster.length);
  assert.equal(r.body.countSubmitted, 1);
  assert.equal(r.body.countMissing, 1);
});

test('a date with no submissions at all reports everyone missing, not an error', async () => {
  scenario = { email: 'jomell@ghgrp.net', role: 'superadmin', requesterPermissionRoles: [], jobberId: 'jobber-1', date: '2099-01-01' };
  const r = await withMockedFetch(() => eodReports('2099-01-01'));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.countSubmitted, 0);
  assert.equal(r.body.countMissing, 2);
});

test('an invalid date falls back to today rather than erroring', async () => {
  scenario = { email: 'jomell@ghgrp.net', role: 'superadmin', requesterPermissionRoles: [], jobberId: 'jobber-1', date: null };
  const r = await withMockedFetch(() => eodReports('not-a-date'));
  assert.equal(r.body.ok, true);
  assert.match(r.body.date, /^\d{4}-\d{2}-\d{2}$/);
});
