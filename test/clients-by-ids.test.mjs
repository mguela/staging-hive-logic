// test/clients-by-ids.test.mjs
// Tests for getClientsByIds() and the POST branch of api/clients.js's
// handler(), added 2026-07-25 alongside the Invoices client-name-lookup
// fix (was paging the entire clients table -- 9 requests for 8,600+ rows --
// on every single Invoices load just to resolve ~1,000 client names).
// Every scenario here is mocked: no real network call, no real secret, ever.
// Run with:
//
//   node test/clients-by-ids.test.mjs
//
// Exit code 0 if every check passes, 1 if anything fails.

import assert from 'node:assert/strict';
import handler, { getClientsByIds } from '../api/clients.js';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function jsonRes(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}

function mockClientRow(id, name) {
  return { jobber_id: id, name, first_name: null, last_name: null, company_name: null, email: null, balance: 0, is_lead: false, is_archived: false, jobber_web_uri: null, jobber_updated_at: null };
}

function fakeRes() {
  const calls = [];
  return {
    calls,
    status(code) {
      calls.push({ code });
      return { json: (body) => calls.push({ body }) };
    },
  };
}


// P0 auth gate (2026-07-29): handler() now requires a signed-in Supabase
// session. authedReq() + authAwareFetch() wrap the pre-existing scenarios:
// identical mocked behavior, plus a stubbed /auth/v1/user success so the
// gate passes. Dedicated checks below cover the signed-out/bad-token 401s.
function authedReq(req) {
  return { headers: { authorization: 'Bearer test-token' }, ...req };
}
function authAwareFetch(dataFetch) {
  return async (url, opts) => {
    if (String(url).includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: 'test-user', email: 't@example.com' }) };
    }
    return dataFetch(url, opts);
  };
}


// ---------- 1. No ids -> empty result, zero network calls ----------
check('empty/missing ids returns an empty result without calling supabaseRequest', async () => {
  let called = false;
  const deps = { supabaseRequest: async () => { called = true; throw new Error('should not be called'); } };
  const result = await getClientsByIds([], deps);
  assert.deepEqual(result, { totalCount: 0, returned: 0, clients: [] });
  assert.equal(called, false);
});

check('non-array ids (null/undefined) is treated as empty, does not throw', async () => {
  const deps = { supabaseRequest: async () => { throw new Error('should not be called'); } };
  assert.deepEqual(await getClientsByIds(null, deps), { totalCount: 0, returned: 0, clients: [] });
  assert.deepEqual(await getClientsByIds(undefined, deps), { totalCount: 0, returned: 0, clients: [] });
});

// ---------- 2. Dedup ----------
check('duplicate ids are deduped before querying', async () => {
  const seenFilters = [];
  const deps = {
    supabaseRequest: async (path) => {
      seenFilters.push(path);
      return jsonRes([mockClientRow('c1', 'Aaron Read')]);
    },
  };
  const result = await getClientsByIds(['c1', 'c1', 'c1'], deps);
  assert.equal(seenFilters.length, 1);
  assert.match(seenFilters[0], /jobber_id=in\.\(c1\)/);
  assert.equal(result.clients.length, 1);
});

// ---------- 3. Chunking ----------
check('more than 250 unique ids is split into multiple chunked requests', async () => {
  const ids = Array.from({ length: 260 }, (_, i) => 'id' + i);
  const calls = [];
  const deps = {
    supabaseRequest: async (path) => {
      calls.push(path);
      // echo back one row per id found in this chunk's filter
      const inner = path.match(/in\.\(([^)]*)\)/)[1];
      const chunkIds = inner.split(',');
      return jsonRes(chunkIds.map((id) => mockClientRow(id, 'Client ' + id)));
    },
  };
  const result = await getClientsByIds(ids, deps);
  assert.equal(calls.length, 2, 'expected two chunk requests for 260 ids at chunk size 250');
  assert.equal(result.clients.length, 260, 'results from all chunks should be concatenated');
  assert.equal(result.totalCount, 260);
});

// ---------- 4. IDS_MAX cap ----------
check('more than 5000 unique ids is capped at 5000', async () => {
  const ids = Array.from({ length: 5200 }, (_, i) => 'id' + i);
  let totalRequested = 0;
  const deps = {
    supabaseRequest: async (path) => {
      const inner = path.match(/in\.\(([^)]*)\)/)[1];
      const chunkIds = inner.split(',');
      totalRequested += chunkIds.length;
      return jsonRes(chunkIds.map((id) => mockClientRow(id, 'Client ' + id)));
    },
  };
  const result = await getClientsByIds(ids, deps);
  assert.equal(totalRequested, 5000);
  assert.equal(result.clients.length, 5000);
});

// ---------- 5. Mapping shape matches getClientsData's row mapping ----------
check('mapped client shape matches the existing getClientsData fields', async () => {
  const deps = {
    supabaseRequest: async () => jsonRes([
      { jobber_id: 'c1', name: null, first_name: 'Aaron', last_name: 'Read', company_name: null, email: 'a@example.com', balance: 42, is_lead: false, is_archived: false, jobber_web_uri: 'https://x', jobber_updated_at: '2026-01-01' },
    ]),
  };
  const result = await getClientsByIds(['c1'], deps);
  assert.deepEqual(result.clients[0], {
    id: 'c1',
    name: 'Aaron Read',
    companyName: null,
    email: 'a@example.com',
    balance: 42,
    isLead: false,
    isArchived: false,
    jobberUrl: 'https://x',
    updatedAt: '2026-01-01',
  });
});

// ---------- 6. Error propagation ----------
check('a failed Supabase request surfaces as a thrown error', async () => {
  const deps = { supabaseRequest: async () => ({ ok: false, text: async () => 'mock: supabase down' }) };
  await assert.rejects(() => getClientsByIds(['c1'], deps));
});

// ---------- 7. Special characters in ids are percent-encoded ----------
check('ids with base64 padding/special characters are percent-encoded in the filter', async () => {
  const seen = [];
  const deps = {
    supabaseRequest: async (path) => { seen.push(path); return jsonRes([]); },
  };
  await getClientsByIds(['Z2lkOi8vSm9iYmVyL0NsaWVudC82NDMxOTMxMw=='], deps);
  assert.ok(seen[0].includes(encodeURIComponent('Z2lkOi8vSm9iYmVyL0NsaWVudC82NDMxOTMxMw==')), 'id should be percent-encoded, e.g. = becomes %3D');
});

// ---------- 8. handler() POST branch routes to getClientsByIds ----------
check('handler POST with ids[] returns ok:true without touching the GET path', async () => {
  const originalFetch = global.fetch;
  global.fetch = authAwareFetch(async () => { throw new Error('data fetch should not be called for empty ids'); });
  try {
    const req = authedReq({ method: 'POST', body: { ids: [] }, query: {} });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 200);
    assert.equal(res.calls[1].body.ok, true);
    assert.deepEqual(res.calls[1].body.clients, []);
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------- 9. handler() falls back to the default GET path for a malformed POST ----------
check('handler POST without a valid ids array falls back to the existing getClientsData path', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = authAwareFetch(async () => {
    fetchCalled = true;
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => [],
    };
  });
  try {
    const req = authedReq({ method: 'POST', body: {}, query: {} });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 200);
    assert.equal(res.calls[1].body.ok, true);
    assert.equal(fetchCalled, true, 'malformed POST body should fall back to the real getClientsData path');
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------- 10. handler() GET path is unchanged (regression guard) ----------
check('handler GET path still works exactly as before this change', async () => {
  const originalFetch = global.fetch;
  global.fetch = authAwareFetch(async () => ({
    ok: true,
    headers: { get: (name) => (name === 'content-range' ? '0-0/1' : null) },
    json: async () => [mockClientRow('c1', 'Aaron Read')],
  }));
  try {
    const req = authedReq({ method: 'GET', query: {} });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 200);
    assert.equal(res.calls[1].body.ok, true);
    assert.equal(res.calls[1].body.clients[0].name, 'Aaron Read');
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------- 11. P0 auth gate: signed-out gets 401, no data leaves ----------
check('handler with no Authorization header returns 401 and never queries data', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('no upstream call should happen when signed out'); };
  try {
    const req = { method: 'GET', query: {}, headers: {} };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 401);
    assert.equal(res.calls[1].body.ok, false);
    assert.equal(res.calls[1].body.clients, undefined, 'no client data in a 401 response');
  } finally {
    global.fetch = originalFetch;
  }
});

check('handler with an invalid token returns 401', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, status: 401 };
    throw new Error('data fetch should not happen for a rejected token');
  };
  try {
    const req = { method: 'GET', query: {}, headers: { authorization: 'Bearer bad' } };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 401);
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------- runner ----------
let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log('  ok  -', name);
    pass++;
  } catch (e) {
    console.log('  FAIL -', name, '\n       ', e.message);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
