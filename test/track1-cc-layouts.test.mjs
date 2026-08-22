// test/track1-cc-layouts.test.mjs
// resource=cc_layouts -- per-user saved Command Center layouts (2026-08-16,
// Chris's layout-editor fix pass, R6/R7/R8).
//
// Proves: the endpoint is signed-in-only; every query is scoped to the calling
// user's own rows (this handler talks to PostgREST with the service key, which
// bypasses RLS, so the user_id filter is the thing doing the scoping); setting a
// layout active clears the previous one; and -- the R8 invariant -- a payload
// that dropped or hid Today's Decisions is rejected with a clear error rather
// than persisted. Fully mocked: no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

const VALID_LAYOUT = {
  widgets: [
    { id: 'cc-map', x: 0, y: 0, w: 4, h: 13 },
    { id: 'cc-brief', x: 4, y: 0, w: 5, h: 22 },
  ],
  background: null,
};

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

// Every /rest/v1/command_center_layouts call the handler makes, in order.
let calls = [];
let rows = [];
let authUser = { id: 'user-1', email: 'chris@ghgrp.net' };

async function withMockedFetch(fn) {
  const original = global.fetch;
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) {
      return authUser ? jsonRes(authUser) : jsonRes({ error: 'bad token' }, 401);
    }
    if (u.includes('/rest/v1/command_center_layouts')) {
      calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      return jsonRes(rows);
    }
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function callCcLayouts({ method = 'GET', body = {}, query = {}, authHeader = 'Bearer usertoken' }) {
  const mod = await import('../api/track1.js');
  const req = {
    method,
    query: { resource: 'cc_layouts', ...query },
    headers: { authorization: authHeader },
    body,
    readableEnded: true,
  };
  const r = res();
  await mod.default(req, r);
  return r;
}

test('cc_layouts requires a signed-in user', async () => {
  await withMockedFetch(async () => {
    authUser = null;
    const r = await callCcLayouts({ method: 'GET' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.ok, false);
    assert.equal(calls.length, 0, 'an unauthenticated request must never reach the table');
    authUser = { id: 'user-1', email: 'chris@ghgrp.net' };
  });
});

test('GET returns only the calling user\'s own layouts', async () => {
  await withMockedFetch(async () => {
    rows = [{ id: 'row-1', name: 'Custom Layout 1', layout: VALID_LAYOUT, is_active: true }];
    const r = await callCcLayouts({ method: 'GET' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.layouts.length, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /user_id=eq\.user-1/, 'the read must be scoped to the caller');
  });
});

test('POST creates a custom layout owned by the caller and makes it active', async () => {
  await withMockedFetch(async () => {
    rows = [{ id: 'row-9', name: 'Custom Layout 1', layout: VALID_LAYOUT, is_active: true }];
    const r = await callCcLayouts({ method: 'POST', body: { name: 'Custom Layout 1', layout: VALID_LAYOUT } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.layout.id, 'row-9');
    // 1) clear the previous active row, 2) insert the new one.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'PATCH');
    assert.match(calls[0].url, /user_id=eq\.user-1&is_active=is\.true/);
    assert.deepEqual(calls[0].body, { is_active: false });
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].body.user_id, 'user-1', 'the row is owned by the caller, never by a client-supplied id');
    assert.equal(calls[1].body.is_active, true);
  });
});

test('POST ignores a client-supplied user_id -- you cannot write a layout into someone else\'s account', async () => {
  await withMockedFetch(async () => {
    rows = [{ id: 'row-9', name: 'X', layout: VALID_LAYOUT, is_active: true }];
    await callCcLayouts({ method: 'POST', body: { name: 'X', layout: VALID_LAYOUT, user_id: 'someone-else' } });
    const insert = calls.find((c) => c.method === 'POST');
    assert.equal(insert.body.user_id, 'user-1');
  });
});

test('POST requires a name', async () => {
  await withMockedFetch(async () => {
    const r = await callCcLayouts({ method: 'POST', body: { layout: VALID_LAYOUT } });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /name is required/);
    assert.equal(calls.length, 0);
  });
});

test('PATCH scopes the update to the caller\'s own row and clears the other active layout', async () => {
  await withMockedFetch(async () => {
    rows = [{ id: 'row-1', name: 'Renamed', layout: VALID_LAYOUT, is_active: true }];
    const r = await callCcLayouts({ method: 'PATCH', body: { id: 'row-1', name: 'Renamed', is_active: true } });
    assert.equal(r.statusCode, 200);
    assert.equal(calls[0].method, 'PATCH');
    assert.match(calls[0].url, /is_active=is\.true&id=neq\.row-1/, 'the previously-active layout is stood down first');
    assert.match(calls[1].url, /id=eq\.row-1&user_id=eq\.user-1/);
    assert.deepEqual(calls[1].body, { name: 'Renamed', is_active: true });
  });
});

test('PATCH on a row that is not yours returns 404, not a silent success', async () => {
  await withMockedFetch(async () => {
    rows = []; // the user_id filter matched nothing
    const r = await callCcLayouts({ method: 'PATCH', body: { id: 'someone-elses-row', name: 'Mine now' } });
    assert.equal(r.statusCode, 404);
    assert.equal(r.body.ok, false);
  });
});

test('DELETE scopes to the caller and 404s when nothing matched', async () => {
  await withMockedFetch(async () => {
    rows = [{ id: 'row-1' }];
    const ok = await callCcLayouts({ method: 'DELETE', query: { id: 'row-1' } });
    assert.equal(ok.statusCode, 200);
    assert.match(calls[0].url, /id=eq\.row-1&user_id=eq\.user-1/);
    assert.equal(calls[0].method, 'DELETE');

    rows = [];
    const missing = await callCcLayouts({ method: 'DELETE', query: { id: 'not-mine' } });
    assert.equal(missing.statusCode, 404);
  });
});

// ---- R8: Today's Decisions can never be removed -----------------------------

test("R8: a save payload with Today's Decisions removed is rejected, not persisted", async () => {
  await withMockedFetch(async () => {
    const tampered = { widgets: [{ id: 'cc-map', x: 0, y: 0, w: 4, h: 13 }] };
    const r = await callCcLayouts({ method: 'POST', body: { name: 'Sneaky', layout: tampered } });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /Today's Decisions can be moved and resized, but it can't be removed/);
    assert.equal(calls.length, 0, 'a rejected payload must never reach the table');
  });
});

test("R8: a save payload with Today's Decisions marked hidden is rejected too", async () => {
  await withMockedFetch(async () => {
    const tampered = { widgets: [{ id: 'cc-brief', x: 0, y: 0, w: 5, h: 22, hidden: true }] };
    const r = await callCcLayouts({ method: 'POST', body: { name: 'Sneaky', layout: tampered } });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /can't be removed/);
    assert.equal(calls.length, 0);
  });
});

test('R8: the same guard applies to PATCH, not just POST', async () => {
  await withMockedFetch(async () => {
    const r = await callCcLayouts({ method: 'PATCH', body: { id: 'row-1', layout: { widgets: [{ id: 'cc-map', x: 0, y: 0, w: 4, h: 4 }] } } });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /can't be removed/);
    assert.equal(calls.length, 0);
  });
});

test('a malformed layout is rejected with a specific message', async () => {
  await withMockedFetch(async () => {
    for (const [layout, pattern] of [
      ['not an object', /layout must be an object/],
      [{ widgets: 'nope' }, /layout\.widgets must be an array/],
      [{ widgets: [{ x: 0 }] }, /needs a string id/],
      [{ widgets: [{ id: 'cc-brief', x: 'left' }] }, /must be a number/],
    ]) {
      const r = await callCcLayouts({ method: 'POST', body: { name: 'X', layout } });
      assert.equal(r.statusCode, 400, `expected 400 for ${JSON.stringify(layout)}`);
      assert.match(r.body.error, pattern);
    }
    assert.equal(calls.length, 0);
  });
});

test('an unsupported method is a 405, not a crash', async () => {
  await withMockedFetch(async () => {
    const r = await callCcLayouts({ method: 'PUT', body: {} });
    assert.equal(r.statusCode, 405);
  });
});

test('the table being absent (085 not applied) surfaces as a 502, so the client can fall back', async () => {
  const original = global.fetch;
  try {
    calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1' });
      return jsonRes({ message: 'relation "public.command_center_layouts" does not exist' }, 404);
    };
    const r = await callCcLayouts({ method: 'GET' });
    assert.equal(r.statusCode, 502);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /Command Center layouts unavailable/);
  } finally {
    global.fetch = original;
  }
});
