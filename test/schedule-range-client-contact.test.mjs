// resource=schedule_range -- the client contact details the Schedule board's
// job sheet reads.
//
// Why this endpoint grew them: the board's sheet used to print a phone, an
// email and a street address built from a hash of the client's name, because
// it had no real ones to print. Real values exist -- phone_e164 is populated
// for 7,434 of 8,690 clients, email for 7,962, and client_locations holds a
// street for 6,409 -- they were simply never sent. Fully mocked: no network.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => data, text: async () => JSON.stringify(data),
});

const VISIT = {
  jobber_id: 'vis-1', title: 'Deck rebuild', start_at: '2026-08-13T13:00:00Z', end_at: '2026-08-13T17:00:00Z',
  arrival_window_start: null, arrival_window_end: null, visit_status: 'ACTIVE',
  assigned_users: [{ id: 'u1', name: 'Alex Ruiz' }], client_id: 'cli-1', job_id: 'job-1',
};

let urls = [];
let tables = {};

async function callScheduleRange({ visits = [VISIT], clients, locations, jobs, enriched } = {}) {
  tables = {
    visits,
    clients: clients ?? [{ jobber_id: 'cli-1', name: 'Mrs Vance', phone: null, phone_e164: '+12035550134', email: 'vance@example.com' }],
    client_locations: locations ?? [{ jobber_id: 'cli-1', street: '12 Orchard St', city: 'Greenwich', province: 'CT', postal_code: '06830' }],
    jobs: jobs ?? [{ jobber_id: 'job-1', job_number: 2041, title: 'Deck rebuild', job_status: 'active', jobber_web_uri: 'https://jobber/2041' }],
    jobs_enriched: enriched ?? [{ jobber_id: 'job-1', gps_lat: 41.03, gps_lng: -73.62, loc_city: 'Greenwich' }],
  };
  urls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    const table = (u.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
    return jsonRes(tables[table] ?? []);
  };
  try {
    const mod = await import('../api/track1.js');
    const req = {
      method: 'GET',
      query: { resource: 'schedule_range', start: '2026-08-13', end: '2026-08-13' },
      headers: { authorization: 'Bearer usertoken' },
      readableEnded: true,
    };
    const r = res();
    await mod.default(req, r);
    return r;
  } finally {
    global.fetch = original;
  }
}

test('a visit carries the client id and their real contact details', async () => {
  const r = await callScheduleRange();
  assert.equal(r.statusCode, 200);
  const v = r.body.visits[0];
  assert.equal(v.clientName, 'Mrs Vance');
  assert.equal(v.clientId, 'cli-1');
  assert.equal(v.clientPhone, '+12035550134');
  assert.equal(v.clientEmail, 'vance@example.com');
  assert.equal(v.clientAddress, '12 Orchard St, Greenwich, CT 06830');
});

test('phone_e164 is the phone that exists -- clients.phone is empty for every client', async () => {
  // The sync populates phone_e164 (7,434 clients) and leaves phone at 0.
  // Reading only `phone` is how you conclude there are no phone numbers.
  const r = await callScheduleRange();
  assert.equal(r.body.visits[0].clientPhone, '+12035550134');
});

test('a raw phone is used when there is no e164 one', async () => {
  const r = await callScheduleRange({
    clients: [{ jobber_id: 'cli-1', name: 'Mr Poole', phone: '203-555-0199', phone_e164: null, email: null }],
  });
  assert.equal(r.body.visits[0].clientPhone, '203-555-0199');
});

test('missing details come back null, never invented', async () => {
  const r = await callScheduleRange({
    clients: [{ jobber_id: 'cli-1', name: 'Mr Poole', phone: null, phone_e164: null, email: null }],
    locations: [],
  });
  const v = r.body.visits[0];
  assert.equal(v.clientName, 'Mr Poole');
  assert.equal(v.clientPhone, null);
  assert.equal(v.clientEmail, null);
  assert.equal(v.clientAddress, null);
});

test('a location row with no street is not an address', async () => {
  // 2,281 client_locations rows carry a city but no street. "Greenwich" on its
  // own is not somewhere a crew can drive to, and must not read as one.
  const r = await callScheduleRange({
    locations: [{ jobber_id: 'cli-1', street: null, city: 'Greenwich', province: 'CT', postal_code: null }],
  });
  assert.equal(r.body.visits[0].clientAddress, null);
});

test('an address is assembled from the parts that exist', async () => {
  const r = await callScheduleRange({
    locations: [{ jobber_id: 'cli-1', street: '4 Lake Ave', city: null, province: null, postal_code: null }],
  });
  assert.equal(r.body.visits[0].clientAddress, '4 Lake Ave');
});

test('a visit with no client at all still returns', async () => {
  const r = await callScheduleRange({
    visits: [{ ...VISIT, client_id: null }],
    clients: [],
    locations: [],
  });
  const v = r.body.visits[0];
  assert.equal(v.clientName, null);
  assert.equal(v.clientId, null);
  assert.equal(v.clientPhone, null);
  assert.equal(v.clientAddress, null);
});

test('contact details cost one extra round trip for the whole range, not one per visit', async () => {
  // The board asks for a week at a time. A per-visit lookup would be dozens of
  // requests to render one board.
  await callScheduleRange({
    visits: [VISIT, { ...VISIT, jobber_id: 'vis-2' }, { ...VISIT, jobber_id: 'vis-3', client_id: 'cli-2' }],
    clients: [{ jobber_id: 'cli-1', name: 'A', phone_e164: '+12035550101', email: null }],
  });
  const clientCalls = urls.filter((u) => u.includes('/rest/v1/clients'));
  const locCalls = urls.filter((u) => u.includes('/rest/v1/client_locations'));
  assert.equal(clientCalls.length, 1, 'one batched clients query');
  assert.equal(locCalls.length, 1, 'one batched client_locations query');
  assert.match(clientCalls[0], /jobber_id=in\.\(cli-1,cli-2\)/, 'both clients in one query');
  assert.match(locCalls[0], /jobber_id=in\.\(cli-1,cli-2\)/);
});

test('the clients query asks for the contact columns it now needs', async () => {
  await callScheduleRange();
  const clientCall = urls.find((u) => u.includes('/rest/v1/clients'));
  assert.match(clientCall, /phone_e164/);
  assert.match(clientCall, /email/);
});
