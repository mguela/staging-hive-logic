// test/jobber-geocode-staff-trigger.test.mjs
//
// 2026-08-19 investigation: client_locations.geocoded_at sat stale for 17
// days (184 real candidate rows waiting, confirmed live) but /api/jobber/
// sync-extended?resource=geocode only accepted the shared CRON_SECRET --
// the same secret every other cron on this endpoint uses, and marked
// "Sensitive" in Vercel so nobody could even read it to test by hand without
// rotating it (risky: it authenticates every other cron too).
//
// geocode is the one resource on this endpoint that is a safe, idempotent,
// non-destructive maintenance action (worst case it retries a row that
// already failed), so it now also accepts a signed-in admin/superadmin
// session -- giving staff a way to run it on demand without ever touching
// the cron secret. Every OTHER resource on this endpoint is unchanged: cron
// secret only.
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
    text: async () => JSON.stringify(data),
    headers: { get: (h) => headers[h.toLowerCase()] || null },
  };
}

const res = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

function mockFetch({ profileRole } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/auth/v1/user')) {
      const authed = (opts.headers && opts.headers.Authorization) === 'Bearer staff-session-token';
      return authed ? jsonRes({ id: 'u1', email: 'staff@example.com' }) : jsonRes({ message: 'invalid token' }, 401);
    }
    if (u.includes('/rest/v1/profiles')) {
      return jsonRes([{ id: 'u1', email: 'staff@example.com', full_name: 'Staff Member', role: profileRole }]);
    }
    if (u.includes('/rest/v1/office_location')) return jsonRes([{ lat: 41.1 }]); // already geocoded, geocodeOffice() short-circuits
    if (u.includes('/rest/v1/client_locations') && u.includes('geocode_locked=is.true')) {
      return jsonRes(null, 200, { 'content-range': '0-0/0' });
    }
    if (u.includes('/rest/v1/client_locations')) return jsonRes([]); // no candidate rows -- keeps this test to the auth gate only
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
}

test('geocode with no auth at all is rejected, same as every other resource', async () => {
  const original = global.fetch;
  global.fetch = mockFetch({ profileRole: 'superadmin' });
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default({ method: 'GET', query: { resource: 'geocode' }, headers: {} }, r);
    assert.equal(r.statusCode, 401);
  } finally {
    global.fetch = original;
  }
});

test('geocode accepts a signed-in superadmin session in place of the cron secret', async () => {
  const original = global.fetch;
  global.fetch = mockFetch({ profileRole: 'superadmin' });
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default({ method: 'GET', query: { resource: 'geocode' }, headers: { authorization: 'Bearer staff-session-token' } }, r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.action, 'geocode');
  } finally {
    global.fetch = original;
  }
});

test('geocode rejects a signed-in session that is not admin/superadmin', async () => {
  const original = global.fetch;
  global.fetch = mockFetch({ profileRole: 'staff' });
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default({ method: 'GET', query: { resource: 'geocode' }, headers: { authorization: 'Bearer staff-session-token' } }, r);
    assert.equal(r.statusCode, 401);
  } finally {
    global.fetch = original;
  }
});

test('every other resource still requires the cron secret -- a staff session is not accepted', async () => {
  const original = global.fetch;
  global.fetch = mockFetch({ profileRole: 'superadmin' });
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default({ method: 'GET', query: { resource: 'quotes' }, headers: { authorization: 'Bearer staff-session-token' } }, r);
    assert.equal(r.statusCode, 401);
  } finally {
    global.fetch = original;
  }
});

test('the cron secret still works for geocode, unchanged from before', async () => {
  const original = global.fetch;
  global.fetch = mockFetch({ profileRole: 'superadmin' });
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default({ method: 'GET', query: { resource: 'geocode' }, headers: { authorization: 'Bearer test-cron-secret' } }, r);
    assert.equal(r.statusCode, 200);
  } finally {
    global.fetch = original;
  }
});
