// test/resource-dispatch-client-filter.test.mjs
// jomell, 2026-08-27: the client profile modal's Requests tab and Client
// Schedule section need one client's real requests/visits, not the whole
// table -- the generic RESOURCE_CONFIG dispatch (api/track1.js) had no
// clientId filter at all before this. Also pins the widened `visits` shape
// (status/assignedUsers), previously dropped even though already synced.
//
// Run with: node --experimental-test-module-mocks --test test/resource-dispatch-client-filter.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let lastPath = null;
let rows = [];

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      lastPath = String(path);
      return { ok: true, json: async () => rows, headers: { get: () => null } };
    },
    jobberGraphQL: async () => ({}),
  },
});

mock.module('../api/_lib/guard.js', {
  namedExports: {
    requireApiAuth: async () => ({ ok: true, via: 'session' }),
    checkCronSecret: () => false,
  },
});

globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'user-1' }) });

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function call(resource, query = {}) {
  const req = { method: 'GET', query: { resource, ...query }, headers: { authorization: 'Bearer t' } };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('requests: a clientId filters to that client only', async () => {
  rows = [];
  await call('requests', { clientId: 'C1' });
  assert.match(lastPath, /^requests\?/);
  assert.match(lastPath, /client_id=eq\.C1/);
});

test('requests: no clientId means no client filter at all', async () => {
  rows = [];
  await call('requests');
  assert.doesNotMatch(lastPath, /client_id=eq\./);
});

test('visits: a clientId filters to that client only', async () => {
  rows = [];
  await call('visits', { clientId: 'C2' });
  assert.match(lastPath, /^visits\?/);
  assert.match(lastPath, /client_id=eq\.C2/);
});

test('visits: the shape now carries real status and assigned crew names', async () => {
  rows = [{
    jobber_id: 'V1', title: 'Visit for Job #2780', start_at: '2026-08-30T13:00:00Z', end_at: null,
    completed_at: null, is_all_day: false, client_id: 'C2', job_id: 'J1', jobber_web_uri: null,
    visit_status: 'unscheduled', assigned_users: [{ id: 'u1', name: 'Danny' }, { id: 'u2', name: 'Diego' }],
  }];
  const r = await call('visits', { clientId: 'C2' });
  const v = r.body.visits[0];
  assert.equal(v.status, 'unscheduled');
  assert.deepEqual(v.assignedUsers, ['Danny', 'Diego']);
});

test('visits: no status/assignment on file reports honestly, not fabricated', async () => {
  rows = [{
    jobber_id: 'V2', title: 'Visit for Job #2781', start_at: null, end_at: null,
    completed_at: null, is_all_day: false, client_id: 'C2', job_id: 'J1', jobber_web_uri: null,
    visit_status: null, assigned_users: null,
  }];
  const r = await call('visits', { clientId: 'C2' });
  const v = r.body.visits[0];
  assert.equal(v.status, null);
  assert.deepEqual(v.assignedUsers, []);
});

test('hl_appointments: excludes canceled ones unconditionally, and filters by client_ref', async () => {
  rows = [];
  await call('hl_appointments', { clientId: 'C3' });
  assert.match(lastPath, /^hl_appointments\?/);
  assert.match(lastPath, /canceled=eq\.false/);
  assert.match(lastPath, /client_ref=eq\.C3/);
});

test('hl_appointments: reports a real crew count, not fabricated names', async () => {
  rows = [{ id: 'a1', title: 'Job #2780 kickoff', start_at: null, end_at: null, status: 'unscheduled', client_ref: 'C3', job_ref: 'J1', crew_jids: ['jid1', 'jid2'] }];
  const r = await call('hl_appointments', { clientId: 'C3' });
  assert.equal(r.body.hl_appointments[0].crewCount, 2);
});

test('hl_appointments: no crew assigned reports 0, not undefined', async () => {
  rows = [{ id: 'a2', title: 'Unassigned visit', start_at: null, end_at: null, status: null, client_ref: 'C3', job_ref: 'J1', crew_jids: null }];
  const r = await call('hl_appointments', { clientId: 'C3' });
  assert.equal(r.body.hl_appointments[0].crewCount, 0);
});

test('a resource with no client_id column (users) ignores an unrelated clientId param rather than erroring', async () => {
  rows = [];
  const r = await call('users', { clientId: 'C1' });
  assert.equal(r.statusCode, 200);
  assert.doesNotMatch(lastPath, /client_id=eq\./);
});
