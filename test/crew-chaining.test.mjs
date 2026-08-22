// test/crew-chaining.test.mjs
// Crew chaining: chain secondaries to a lead, group-clock the whole crew, and
// let a tech peel themselves off one job.
//
// The three things most worth pinning down, because each was a real defect or a
// real temptation:
//   1. A group clock-in must write ONE ROW PER PERSON. The field app's "WHOLE
//      TEAM" button used to write a single job_time_entries row with a
//      whole_team boolean on it, so a lead starting a 3-person job produced one
//      time record and payroll silently under-counted two people.
//   2. The proximity check must never accuse someone it cannot actually place.
//      Only people with a truck assigned in Jobber have GPS; a helper riding in
//      the lead's truck is UNVERIFIED, not flagged.
//   3. Self-unchain is authorized by being the person named -- a tech with no
//      dispatch rights can take themselves off a job and nobody else.
// Fully mocked -- no network, no DB, no real secret.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const LEAD = 'jobber-lead', HELPER = 'jobber-helper', OTHER = 'jobber-other';

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
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

// world describes the DB; captured records every write we make.
function makeFetch(world, captured) {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method !== 'GET') captured.push({ url: u, method, body });

    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: world.viewerEmail });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: world.viewerEmail, role: world.profileRole || null }]);
    if (u.includes('/rest/v1/users')) {
      // caller identity lookup by email vs. the vehicle join by jobber_id
      if (u.includes('email=eq.')) return jsonRes([{ jobber_id: world.viewerJid }]);
      return jsonRes(world.vehicleAssignments || []);
    }
    if (u.includes('/rest/v1/employee_roles')) {
      if (u.includes('is_lead=is.true')) return jsonRes((world.leads || []).map((j) => ({ jobber_id: j })));
      // the row being EDITED (its stored roles), vs the caller's own row
      if (world.storedRoles && u.includes(encodeURIComponent(HELPER))) {
        return jsonRes([{ permission_roles: world.storedRoles, permission_role: world.storedRoles[0] || null, is_lead: !!world.storedIsLead }]);
      }
      return jsonRes([{ permission_roles: world.permissionRoles || [], permission_role: (world.permissionRoles || [])[0] || null }]);
    }
    if (u.includes('/rest/v1/vehicles')) return jsonRes(world.vehicles || []);
    if (u.includes('/rest/v1/visits')) {
      if (world.failVisitLookup) return jsonRes({ message: 'visit lookup failed' }, 500);
      return jsonRes([{
        assigned_users: world.assignedUsers || [],
        job_id: Object.hasOwn(world, 'jobId') ? world.jobId : 'job-1',
        client_id: Object.hasOwn(world, 'clientId') ? world.clientId : 'client-1',
      }]);
    }
    if (u.includes('/rest/v1/hl_crew_overrides')) {
      if (world.failOverrideLookup) return jsonRes({ message: 'override lookup failed' }, 500);
      return jsonRes(world.overrides || []);
    }
    if (u.includes('/rest/v1/rpc/hl_clock_crew_in')) {
      if (world.failAtomicCrew) return jsonRes({ message: 'atomic write failed' }, 500);
      return jsonRes(body.p_rows || []);
    }
    if (u.includes('/rest/v1/rpc/hl_field_time_start')) {
      if (world.failAtomicField) return jsonRes({ message: 'atomic field write failed' }, 500);
      return jsonRes({ entry: { id: 'jte-1', ...(body.p_entry || {}) }, clock: body.p_crew_rows || [] });
    }
    if (u.includes('/rest/v1/rpc/hl_field_time_stop')) {
      if (world.failAtomicField) return jsonRes({ message: 'atomic field stop failed' }, 500);
      return jsonRes({ closed: 1, crew_changed: (body.p_crew_jids || []).length });
    }
    if (u.includes('/rest/v1/hl_clock')) return jsonRes(method === 'POST' ? body : [{ id: 'c1' }]);
    if (u.includes('/rest/v1/hl_rechain_requests')) return jsonRes(method === 'POST' ? [{ id: 'r1', ...body }] : (world.rechain || []));
    if (u.includes('/rest/v1/hl_appointments')) return jsonRes(world.appointments || []);
    return jsonRes([]);
  };
}

async function withWorld(world, fn) {
  const original = global.fetch;
  const captured = [];
  global.fetch = makeFetch(world, captured);
  try { return await fn(captured); } finally { global.fetch = original; }
}

async function callHl(world, body) {
  return withWorld(world, async (captured) => {
    const mod = await import('../api/schedule/hl.js');
    const req = { method: 'POST', query: {}, headers: { authorization: 'Bearer t' }, body };
    const r = res();
    await mod.default(req, r);
    return { r, captured };
  });
}

const DISPATCH = { viewerEmail: 'dispatch@ghgrp.net', viewerJid: 'jobber-dispatch', permissionRoles: ['dispatch'] };
const clockRows = (captured) => {
  const crewRpc = captured.find((c) => c.url.includes('rpc/hl_clock_crew_in') && c.method === 'POST');
  if (crewRpc) return crewRpc.body.p_rows || [];
  const fieldRpc = captured.find((c) => c.url.includes('rpc/hl_field_time_start') && c.method === 'POST');
  return fieldRpc ? (fieldRpc.body.p_crew_rows || []) : [];
};

// ---------------------------------------------------------------- 1. per-person rows
test('group clock-in writes one row per crew member, not one row for the crew', async () => {
  const { r, captured } = await callHl({ ...DISPATCH, leads: [LEAD] }, {
    action: 'clock_in', employees: [LEAD, HELPER, OTHER], target_id: 'visit-1', lead_jid: LEAD,
  });
  assert.equal(r.statusCode, 200);
  const rows = clockRows(captured);
  assert.equal(rows.length, 3, 'payroll pays people: three on the job means three records');
  assert.deepEqual(rows.map((x) => x.employee_jid).sort(), [HELPER, LEAD, OTHER].sort());
  // the lead is not chained to anybody; the other two are chained to the lead
  assert.equal(rows.find((x) => x.employee_jid === LEAD).chained_to, null);
  assert.equal(rows.find((x) => x.employee_jid === HELPER).chained_to, LEAD);
});

test('prior sessions and replacement rows use one atomic crew RPC', async () => {
  const { captured } = await callHl({ ...DISPATCH, leads: [LEAD] }, {
    action: 'clock_in', employees: [LEAD, HELPER], target_id: 'visit-1',
  });
  const atomic = captured.find((c) => c.url.includes('rpc/hl_clock_crew_in') && c.method === 'POST');
  assert.ok(atomic, 'the database RPC closes old sessions and inserts replacements in one transaction');
  assert.equal(atomic.body.p_rows.length, 2);
  assert.ok(!captured.some((c) => c.url.includes('/hl_clock?') && c.method === 'PATCH'),
    'there must be no separately committed close before the replacement insert');
});

test('an atomic crew insert failure does not issue a separately committed close', async () => {
  const { r, captured } = await callHl({ ...DISPATCH, leads: [LEAD], failAtomicCrew: true }, {
    action: 'clock_in', employees: [LEAD, HELPER], target_id: 'visit-1',
  });
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.ok, false);
  assert.ok(!captured.some((c) => c.url.includes('/hl_clock?') && c.method === 'PATCH'));
});

// ---------------------------------------------------------------- 2. honest proximity
test('a crew member with no truck is UNVERIFIED, never flagged', async () => {
  // Only the lead has a vehicle. The helper rides with them and has no GPS.
  const world = {
    ...DISPATCH, leads: [LEAD],
    vehicleAssignments: [{ jobber_id: LEAD, assigned_vehicle_id: 'v1' }],
    vehicles: [{ jobber_id: 'v1', fleetsharp_latitude: 41.1, fleetsharp_longitude: -73.6, fleetsharp_updated_at: minutesAgo(2) }],
  };
  const { r, captured } = await callHl(world, { action: 'clock_in', employees: [LEAD, HELPER], target_id: 'visit-1' });
  const helper = clockRows(captured).find((x) => x.employee_jid === HELPER);
  assert.equal(helper.proximity_m, null, 'no signal means no distance, not a fabricated one');
  assert.equal(helper.proximity_flag, false, 'unverifiable is not an accusation');
  assert.deepEqual(r.body.unverified, [HELPER]);
  assert.deepEqual(r.body.flagged, []);
});

test('a crew member whose truck is far from the lead IS flagged', async () => {
  const world = {
    ...DISPATCH, leads: [LEAD],
    vehicleAssignments: [{ jobber_id: LEAD, assigned_vehicle_id: 'v1' }, { jobber_id: OTHER, assigned_vehicle_id: 'v2' }],
    vehicles: [
      { jobber_id: 'v1', fleetsharp_latitude: 41.1, fleetsharp_longitude: -73.6, fleetsharp_updated_at: minutesAgo(2) },
      { jobber_id: 'v2', fleetsharp_latitude: 41.3, fleetsharp_longitude: -73.9, fleetsharp_updated_at: minutesAgo(2) }, // ~30km away
    ],
  };
  const { r, captured } = await callHl(world, { action: 'clock_in', employees: [LEAD, OTHER], target_id: 'visit-1' });
  const other = clockRows(captured).find((x) => x.employee_jid === OTHER);
  assert.ok(other.proximity_m > 500, 'distance is measured, not guessed');
  assert.equal(other.proximity_flag, true);
  assert.deepEqual(r.body.flagged, [OTHER]);
});

test('a stale GPS fix proves nothing -- unverified, not flagged', async () => {
  const world = {
    ...DISPATCH, leads: [LEAD],
    vehicleAssignments: [{ jobber_id: LEAD, assigned_vehicle_id: 'v1' }, { jobber_id: OTHER, assigned_vehicle_id: 'v2' }],
    vehicles: [
      { jobber_id: 'v1', fleetsharp_latitude: 41.1, fleetsharp_longitude: -73.6, fleetsharp_updated_at: minutesAgo(2) },
      { jobber_id: 'v2', fleetsharp_latitude: 41.3, fleetsharp_longitude: -73.9, fleetsharp_updated_at: minutesAgo(180) }, // hours old
    ],
  };
  const { r, captured } = await callHl(world, { action: 'clock_in', employees: [LEAD, OTHER], target_id: 'visit-1' });
  assert.equal(clockRows(captured).find((x) => x.employee_jid === OTHER).proximity_flag, false);
  assert.deepEqual(r.body.flagged, []);
});

test('the clock-in still succeeds when the position lookup is unavailable', async () => {
  const world = { ...DISPATCH, leads: [LEAD], vehicleAssignments: null, vehicles: null };
  const { r, captured } = await callHl(world, { action: 'clock_in', employees: [LEAD, HELPER], target_id: 'visit-1' });
  assert.equal(r.statusCode, 200, 'proximity is advisory -- it must never block clocking in');
  assert.equal(clockRows(captured).length, 2);
});

// ---------------------------------------------------------------- 3. lead election
test('dispatch\'s per-job lead election beats the person-level flag', async () => {
  const world = { ...DISPATCH, leads: [LEAD] };
  const { r } = await callHl(world, { action: 'clock_in', employees: [LEAD, HELPER], lead_jid: HELPER, target_id: 'visit-1' });
  assert.equal(r.body.lead, HELPER, 'when dispatch picks, dispatch wins');
});

test('two flagged leads on one job leaves the lead unset for dispatch to break the tie', async () => {
  const world = { ...DISPATCH, leads: [LEAD, OTHER] };
  const { r } = await callHl(world, { action: 'clock_in', employees: [LEAD, OTHER], target_id: 'visit-1' });
  assert.equal(r.body.lead, null, 'we must not silently pick one of two leads');
});

// ---------------------------------------------------------------- 4. self-unchain
test('a tech with no dispatch rights can unchain THEMSELVES', async () => {
  const world = { viewerEmail: 'helper@ghgrp.net', viewerJid: HELPER, permissionRoles: ['field_crew'] };
  const { r, captured } = await callHl(world, { action: 'self_unchain', visit_jid: 'visit-1', employee_jid: HELPER });
  assert.equal(r.statusCode, 200);
  const ovWrite = captured.find((c) => c.url.includes('hl_crew_overrides'));
  assert.ok(ovWrite.body.remove_jids.includes(HELPER), 'they come off this job');
  const reqWrite = captured.find((c) => c.url.includes('hl_rechain_requests') && c.method === 'POST');
  assert.ok(reqWrite, 'dispatch is asked to rechain them -- it is not a silent disappearance');
  assert.equal(reqWrite.body.status, 'open');
});

test('a tech cannot unchain SOMEONE ELSE', async () => {
  const world = { viewerEmail: 'helper@ghgrp.net', viewerJid: HELPER, permissionRoles: ['field_crew'] };
  const { r } = await callHl(world, { action: 'self_unchain', visit_jid: 'visit-1', employee_jid: OTHER });
  assert.equal(r.statusCode, 403);
});

test('self-unchain closes that person\'s clock on the job they left', async () => {
  const world = { viewerEmail: 'helper@ghgrp.net', viewerJid: HELPER, permissionRoles: ['field_crew'] };
  const { captured } = await callHl(world, { action: 'self_unchain', visit_jid: 'visit-1', employee_jid: HELPER });
  const closer = captured.find((c) => c.url.includes('hl_clock') && c.method === 'PATCH');
  assert.ok(closer, 'you cannot stay on the clock for a job you took yourself off');
  assert.ok(closer.url.includes(encodeURIComponent(HELPER)));
});

test('a tech still cannot do dispatch-only things', async () => {
  const world = { viewerEmail: 'helper@ghgrp.net', viewerJid: HELPER, permissionRoles: ['field_crew'] };
  for (const action of ['chain', 'set_visit_lead', 'clock_in', 'cancel_appointment']) {
    const { r } = await callHl(world, { action, visit_jid: 'visit-1', employee_jid: OTHER, employees: [OTHER], id: 'x' });
    assert.equal(r.statusCode, 403, `${action} must stay behind the dispatch gate`);
  }
});

// ---------------------------------------------------------------- 5. rechain resolution
test('rechaining a tech puts them back on the job and closes the request', async () => {
  const world = { ...DISPATCH, rechain: [{ id: 'r1', target_id: 'visit-1', employee_jid: HELPER, status: 'open' }], overrides: [{ visit_jid: 'visit-1', add_jids: [], remove_jids: [HELPER] }] };
  const { r, captured } = await callHl(world, { action: 'resolve_rechain', id: 'r1', resolution: 'rechain' });
  assert.equal(r.statusCode, 200);
  const ov = captured.find((c) => c.url.includes('hl_crew_overrides'));
  assert.ok(ov.body.add_jids.includes(HELPER), 'back on the job');
  assert.ok(!ov.body.remove_jids.includes(HELPER), 'and no longer removed from it');
  const closed = captured.find((c) => c.url.includes('hl_rechain_requests') && c.method === 'PATCH');
  assert.equal(closed.body.status, 'rechained');
});

test('dismissing a rechain request leaves the tech off the job', async () => {
  const world = { ...DISPATCH, rechain: [{ id: 'r1', target_id: 'visit-1', employee_jid: HELPER, status: 'open' }], overrides: [{ visit_jid: 'visit-1', add_jids: [], remove_jids: [HELPER] }] };
  const { captured } = await callHl(world, { action: 'resolve_rechain', id: 'r1', resolution: 'dismiss' });
  assert.ok(!captured.some((c) => c.url.includes('hl_crew_overrides') && c.method !== 'GET'), 'dismissal changes no crew');
  const closed = captured.find((c) => c.url.includes('hl_rechain_requests') && c.method === 'PATCH');
  assert.equal(closed.body.status, 'dismissed');
});

// ---------------------------------------------------------------- 6. the field app fix
test('the field app\'s WHOLE TEAM start clocks in every chained crew member', async () => {
  // This is the defect the whole change exists for: before, this wrote one
  // job_time_entries row with whole_team=true and no record for anyone else.
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
  };
  const captured = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const req = {
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', client_ref: 'client-1', kind: 'onsite', whole_team: true },
    };
    await mod.default(req, res());
    return cap;
  });
  const rows = clockRows(captured);
  assert.equal(rows.length, 2, 'the lead\'s tap must produce a record for the helper too');
  assert.deepEqual(rows.map((x) => x.employee_jid).sort(), [HELPER, LEAD].sort());
  assert.ok(rows.every((x) => x.source === 'field'), 'recorded as coming from the phone');
});

test('the field app still writes the per-job activity entry for T&M billing', async () => {
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
  };
  const captured = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const req = {
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', kind: 'onsite', whole_team: true },
    };
    await mod.default(req, res());
    return cap;
  });
  const jte = captured.find((c) => c.url.includes('rpc/hl_field_time_start') && c.method === 'POST');
  assert.ok(jte, 'the atomic field RPC still writes the activity that feeds the T&M live meter');
  assert.equal(jte.body.p_entry.kind, 'onsite');
});

test('crew proximity reads only the canonical FleetSharp position fields', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../api/_lib/crew-clock.js', import.meta.url), 'utf8'));
  assert.match(source, /select=jobber_id,\$\{VEHICLE_GPS_COLUMNS\}/);
  assert.doesNotMatch(source, /select=jobber_id,latitude,longitude,gps_updated_at/);
});

test('field activity and whole-crew clock-in are submitted in the same transaction', async () => {
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
  };
  const { r, captured } = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const response = res();
    await mod.default({
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', kind: 'onsite', whole_team: true },
    }, response);
    return { r: response, captured: cap };
  });
  assert.equal(r.statusCode, 200);
  const calls = captured.filter((c) => c.url.includes('rpc/hl_field_time_start'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.p_crew_rows.length, 2);
  assert.ok(!captured.some((c) => c.url.includes('/job_time_entries') && c.method !== 'GET'));
  assert.ok(!captured.some((c) => c.url.includes('/hl_clock?') && c.method === 'PATCH'));
});

test('field atomic failure reports failure without issuing partial REST writes', async () => {
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
    failAtomicField: true,
  };
  const { r, captured } = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const response = res();
    await mod.default({
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', kind: 'onsite', whole_team: true },
    }, response);
    return { r: response, captured: cap };
  });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.ok, false);
  assert.ok(!captured.some((c) => c.url.includes('/job_time_entries') && c.method !== 'GET'));
  assert.ok(!captured.some((c) => c.url.includes('/hl_clock?') && c.method === 'PATCH'));
});

test('an assigned helper cannot group-clock a crew when they are not the elected lead', async () => {
  const world = {
    viewerEmail: 'helper@ghgrp.net', viewerJid: HELPER, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
  };
  const { r, captured } = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const response = res();
    await mod.default({
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', client_ref: 'client-1', kind: 'onsite', whole_team: true },
    }, response);
    return { r: response, captured: cap };
  });
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /elected crew lead|dispatch/i);
  assert.ok(!captured.some((c) => c.url.includes('rpc/hl_field_time_start')));
});

test('an authenticated but unassigned staff profile cannot clock another visit crew', async () => {
  const world = {
    viewerEmail: 'other@ghgrp.net', viewerJid: OTHER, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
  };
  const { r, captured } = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const response = res();
    await mod.default({
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', client_ref: 'client-1', kind: 'onsite', whole_team: true },
    }, response);
    return { r: response, captured: cap };
  });
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /not assigned/i);
  assert.ok(!captured.some((c) => c.url.includes('rpc/hl_field_time_start')));
});

test('a crew override read failure fails closed instead of clocking the raw assignment', async () => {
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
    failOverrideLookup: true,
  };
  const { r, captured } = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const response = res();
    await mod.default({
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', client_ref: 'client-1', kind: 'onsite', whole_team: true },
    }, response);
    return { r: response, captured: cap };
  });
  assert.equal(r.statusCode, 502);
  assert.match(r.body.error, /temporarily unavailable/i);
  assert.ok(!captured.some((c) => c.url.includes('rpc/hl_field_time_start')));
});

test('caller-supplied job and client references must match the authoritative visit', async () => {
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }],
  };
  const { r } = await withWorld(world, async () => {
    const mod = await import('../api/fieldops.js');
    const response = res();
    await mod.default({
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'wrong-job', visit_ref: 'visit-1', client_ref: 'client-1', kind: 'onsite' },
    }, response);
    return { r: response };
  });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /job does not match/i);
});

test('whole-team stop passes the visit scope into the atomic database function', async () => {
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
  };
  const { r, captured } = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const response = res();
    await mod.default({
      method: 'POST', query: { action: 'time_stop' }, headers: { authorization: 'Bearer t' },
      body: { whole_team: true, visit_ref: 'visit-1' },
    }, response);
    return { r: response, captured: cap };
  });
  assert.equal(r.statusCode, 200);
  const stop = captured.find((c) => c.url.includes('rpc/hl_field_time_stop'));
  assert.equal(stop.body.p_target_id, 'visit-1');
});

test('a solo tech starting a job clocks in only themselves', async () => {
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }],
  };
  const captured = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const req = {
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', kind: 'onsite', whole_team: false },
    };
    await mod.default(req, res());
    return cap;
  });
  assert.equal(clockRows(captured).length, 0, 'no whole_team means no crew clock -- just their own entry');
});

// ---------------------------------------------------------------- 7. the lead toggle
// Live rows hold permission roles ('field_crew', 'subcontractor') that are NOT in
// VALID_PERMISSION_ROLES, so a lead toggle that echoed the stored roles back would
// 400 on exactly the field crew it exists for.
async function callRoster(world, body) {
  return withWorld(world, async (captured) => {
    const mod = await import('../api/track1.js');
    const req = { method: 'POST', query: { resource: 'employee_roster' }, headers: { authorization: 'Bearer t' }, body };
    const r = res();
    await mod.default(req, r);
    return { r, captured };
  });
}
const ADMIN = { viewerEmail: 'chris@ghgrp.net', viewerJid: 'jobber-admin', profileRole: 'admin', permissionRoles: ['owner'] };

test('setting the lead flag works for a real crew member whose stored role is not in the whitelist', async () => {
  const world = { ...ADMIN, storedRoles: ['field_crew'] };
  const { r } = await callRoster(world, { jobberId: HELPER, lens: 'crew', crewLabel: 'Team 3 helper', isLead: true });
  assert.equal(r.statusCode, 200, 'the lead toggle must not 400 on a live field_crew row');
  assert.equal(r.body.isLead, true);
});

test('omitting roles carries the stored ones forward instead of wiping them', async () => {
  const world = { ...ADMIN, storedRoles: ['field_crew'] };
  const { captured } = await callRoster(world, { jobberId: HELPER, lens: 'crew', isLead: true });
  const upsert = captured.find((c) => c.url.includes('employee_roles') && c.method === 'POST');
  assert.deepEqual(upsert.body.permission_roles, ['field_crew'], 'a lead edit must not blank someone\'s roles');
});

test('a caller that DOES send roles is still validated', async () => {
  const { r } = await callRoster({ ...ADMIN }, { jobberId: HELPER, lens: 'crew', permissionRoles: ['not-a-real-role'] });
  assert.equal(r.statusCode, 400, 'the whitelist still applies when roles are actually being set');
});

test('crew overrides are applied before the crew is clocked in', async () => {
  // Someone peeled off this job must not be clocked into it by the lead's tap.
  const world = {
    viewerEmail: 'lead@ghgrp.net', viewerJid: LEAD, permissionRoles: ['field_crew'], leads: [LEAD],
    assignedUsers: [{ id: LEAD, name: 'Lead' }, { id: HELPER, name: 'Helper' }],
    overrides: [{ visit_jid: 'visit-1', add_jids: [OTHER], remove_jids: [HELPER] }],
  };
  const captured = await withWorld(world, async (cap) => {
    const mod = await import('../api/fieldops.js');
    const req = {
      method: 'POST', query: { action: 'time_start' }, headers: { authorization: 'Bearer t' },
      body: { job_ref: 'job-1', visit_ref: 'visit-1', kind: 'onsite', whole_team: true },
    };
    await mod.default(req, res());
    return cap;
  });
  const jids = clockRows(captured).map((x) => x.employee_jid);
  assert.ok(!jids.includes(HELPER), 'a tech who unchained themselves stays off the clock');
  assert.ok(jids.includes(OTHER), 'a tech dispatch chained on is included');
});
