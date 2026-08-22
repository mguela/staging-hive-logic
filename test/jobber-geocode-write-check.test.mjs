// test/jobber-geocode-write-check.test.mjs
//
// 2026-08-19: client_locations.geocoded_at sat frozen at 2026-08-01 for 17
// days. Live-confirmed via a real triggered run: the endpoint reported
// "processed: 100, geocoded: 3, noMatch: 97" -- looked completely healthy --
// but a direct SQL check right after showed max(geocoded_at) had NOT moved
// at all. The PATCH that writes lat/lng/geocoded_at back to client_locations
// was never checked for success; a failing write looked identical to a
// successful one because geocoded/noMatch were incremented off the
// in-memory `hit` value, not off whether the write actually landed.
//
// This only counts a row as geocoded/noMatch once its write is confirmed,
// and surfaces the first failure's real HTTP status + body so the next time
// this breaks, the JSON response itself says why -- no multi-turn live
// investigation required.
//
// Fully mocked -- no network, no DB, no real Jobber/Supabase credentials.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function jsonRes(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
    headers: { get: (h) => headers[h.toLowerCase()] || null },
  };
}

const res = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

const ROW_A = { jobber_id: 'a', street: '1 Main St', city: 'Bedford', province: 'NY', postal_code: '10506', country: 'US' };
const ROW_B = { jobber_id: 'b', street: '2 Main St', city: 'Bedford', province: 'NY', postal_code: '10506', country: 'US' };

function mockFetch() {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/auth/v1/user')) return jsonRes({ message: 'invalid token' }, 401); // not a staff session -- cron secret path
    if (u.includes('/rest/v1/office_location')) return jsonRes([{ lat: 41.1 }]); // already geocoded
    if (u.includes('nominatim.openstreetmap.org')) {
      // ROW_A gets a rooftop-grade hit; ROW_B gets no usable Nominatim result.
      if (u.includes('street=1+Main+St') || u.includes('street=1%20Main%20St')) {
        return jsonRes([{ lat: '41.2', lon: '-73.6', addresstype: 'building', category: 'building', type: 'yes' }]);
      }
      return jsonRes([]);
    }
    if (u.includes('geocoding.geo.census.gov')) {
      return jsonRes({ result: { addressMatches: [] } }); // ROW_B: no Census match either
    }
    if (u.includes('/rest/v1/client_locations') && method === 'HEAD') {
      return jsonRes(null, 200, { 'content-range': '0-0/0' }); // no locked candidates
    }
    if (u.includes('/rest/v1/client_locations') && method === 'PATCH') {
      // Simulate the real-world failure: ROW_A's write 500s, ROW_B's succeeds.
      if (u.includes('jobber_id=eq.a')) return jsonRes({ message: 'simulated db error' }, 500);
      if (u.includes('jobber_id=eq.b')) return jsonRes(null, 204);
      throw new Error('unexpected PATCH target: ' + u);
    }
    if (u.includes('/rest/v1/client_locations') && method === 'GET') {
      return jsonRes([ROW_A, ROW_B]); // the candidate batch
    }
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
}

test('a failed write is not counted as geocoded, and the real error is surfaced', async () => {
  const original = global.fetch;
  global.fetch = mockFetch();
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default({ method: 'GET', query: { resource: 'geocode' }, headers: { authorization: 'Bearer test-cron-secret' } }, r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.attempted, 2);
    assert.equal(r.body.processed, 2);
    // ROW_A found a real Nominatim hit but its write 500'd -- must NOT count as geocoded.
    assert.equal(r.body.geocoded, 0);
    assert.equal(r.body.viaNominatim, 0);
    // ROW_B found no match anywhere, but its write succeeded -- counts as noMatch.
    assert.equal(r.body.noMatch, 1);
    assert.equal(r.body.writeErrors, 1);
    assert.match(r.body.firstWriteError, /HTTP 500/);
    assert.match(r.body.firstWriteError, /simulated db error/);
  } finally {
    global.fetch = original;
  }
});

test('when every write succeeds, writeErrors is zero and firstWriteError is null', async () => {
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/auth/v1/user')) return jsonRes({ message: 'invalid token' }, 401);
    if (u.includes('/rest/v1/office_location')) return jsonRes([{ lat: 41.1 }]);
    if (u.includes('nominatim.openstreetmap.org')) return jsonRes([]);
    if (u.includes('geocoding.geo.census.gov')) return jsonRes({ result: { addressMatches: [] } });
    if (u.includes('/rest/v1/client_locations') && method === 'HEAD') return jsonRes(null, 200, { 'content-range': '0-0/0' });
    if (u.includes('/rest/v1/client_locations') && method === 'PATCH') return jsonRes(null, 204);
    if (u.includes('/rest/v1/client_locations') && method === 'GET') return jsonRes([ROW_B]);
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default({ method: 'GET', query: { resource: 'geocode' }, headers: { authorization: 'Bearer test-cron-secret' } }, r);
    assert.equal(r.body.writeErrors, 0);
    assert.equal(r.body.firstWriteError, null);
    assert.equal(r.body.noMatch, 1);
  } finally {
    global.fetch = original;
  }
});
