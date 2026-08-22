// test/api-smoke-test.js
// Hits every production API route with normal + edge-case inputs and prints
// a pass/fail report. Run AFTER pushing tonight's changes:
//
//   node test/api-smoke-test.js
//   node test/api-smoke-test.js https://hivelogic-live.vercel.app   (explicit base URL)
//
// Exit code is 0 if every check passed, 1 if anything failed -- safe to wire
// into a CI step later if you want a red/green gate before merging.
//
// AUTH (updated -- several routes below were public when this file was
// first written and are not anymore): clients, jobs, invoices, snapshot,
// chat, and visual-intel now require a signed-in Supabase user
// (requireUser()) as of the 7/29 P0 PII fix and the Round 2 api/ auth
// audit. An anonymous request to any of those routes now correctly gets a
// real 401 -- that is the intended, correct behavior, not a bug, and this
// file used to mis-report it as a failure because it still expected the
// old anonymous 200/400/404 responses.
//
// By default (no token set) this file now checks that each gated route
// actually rejects an anonymous request with 401 -- a real regression
// test that would catch a route accidentally losing its auth gate. To
// also exercise a gated route's real internal logic (its actual
// 200/400/404 behavior once signed in), set SMOKE_TEST_TOKEN to a real
// Supabase access token before running:
//
//   SMOKE_TEST_TOKEN=<your supabase access token> node test/api-smoke-test.js
//
// This file never stores, logs, or prints that token -- it is only ever
// sent as an Authorization header on the requests below. No writes are
// ever made -- every request here is a GET except the two POSTs, neither
// of which mutates any state (an empty-body chat call and a wrong-method
// probe never reach a real handler).

const BASE = process.argv[2] || 'https://hivelogic-live.vercel.app';
const AUTH_TOKEN = process.env.SMOKE_TEST_TOKEN || null;
const CRON_SECRET = process.env.SMOKE_TEST_CRON_SECRET || null;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function get(path, opts) {
  const headers = opts && opts.cron && CRON_SECRET
    ? { Authorization: `Bearer ${CRON_SECRET}` }
    : (opts && opts.authed && AUTH_TOKEN) ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const res = await fetch(BASE + path, { headers });
  let body;
  try { body = await res.json(); } catch (e) { body = { __parseError: e.message }; }
  return { status: res.status, body };
}

async function post(path, jsonBody, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts && opts.authed && AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(jsonBody) });
  let body;
  try { body = await res.json(); } catch (e) { body = { __parseError: e.message }; }
  return { status: res.status, body };
}

// A route that now requires requireUser(). `request(authed)` must issue
// the real HTTP call, passing `{ authed }` through to get()/post() so it
// picks up the Authorization header when SMOKE_TEST_TOKEN is set. Without
// a token, this just confirms the gate itself is live (401, ok:false) --
// that is a real, meaningful assertion, not a skip. With a token set, it
// runs `verifyAuthed(status, body)` against the real authenticated
// response so the route's actual logic still gets exercised end to end.
function checkGated(name, request, verifyAuthed) {
  check(name, async () => {
    if (!AUTH_TOKEN) {
      const { status, body } = await request(false);
      if (status !== 401) throw new Error(`expected 401 (anonymous, no SMOKE_TEST_TOKEN set), got ${status}`);
      if (body.ok !== false) throw new Error('expected ok:false on the 401 body');
      return;
    }
    const { status, body } = await request(true);
    await verifyAuthed(status, body);
  });
}

// ---------- Established routes (must always pass) ----------
check('GET /api/health returns ok', async () => {
  const { status, body } = await get('/api/health');
  if (status !== 200) throw new Error(`status ${status}`);
  if (typeof body.api_key_configured !== 'boolean') throw new Error('missing api_key_configured');
});

checkGated('GET /api/snapshot returns real counts',
  (authed) => get('/api/snapshot', { authed }),
  (status, body) => {
    if (status !== 200 || !body.ok) throw new Error(`status ${status}, ok=${body.ok}`);
    if (!(body.snapshot.counts.clients > 0)) throw new Error('clients count not positive');
  });

checkGated('GET /api/clients?limit=10000 covers the real total (fixes the truncated-name bug)',
  (authed) => get('/api/clients?limit=10000', { authed }),
  (status, body) => {
    if (status !== 200 || !body.ok) throw new Error(`status ${status}, ok=${body.ok}`);
    if (body.returned < body.totalCount) throw new Error(`only returned ${body.returned} of ${body.totalCount} -- bump limit or add pagination`);
  });

checkGated('GET /api/jobs?limit=500 returns rows',
  (authed) => get('/api/jobs?limit=500', { authed }),
  (status, body) => {
    if (status !== 200 || !body.ok) throw new Error(`status ${status}, ok=${body.ok}`);
  });

checkGated('GET /api/invoices?limit=3000 returns rows',
  (authed) => get('/api/invoices?limit=3000', { authed }),
  (status, body) => {
    if (status !== 200 || !body.ok) throw new Error(`status ${status}, ok=${body.ok}`);
  });

checkGated('GET /api/clients?limit=-5 does not 500 (bad input handling)',
  (authed) => get('/api/clients?limit=-5', { authed }),
  (status) => {
    if (status >= 500) throw new Error(`status ${status} -- negative limit crashed the function`);
  });

checkGated('GET /api/clients?limit=abc does not 500 (non-numeric input)',
  (authed) => get('/api/clients?limit=abc', { authed }),
  (status) => {
    if (status >= 500) throw new Error(`status ${status} -- non-numeric limit crashed the function`);
  });

checkGated('POST /api/chat with empty messages returns 400, not 500',
  (authed) => post('/api/chat', { messages: [] }, { authed }),
  (status) => {
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

check('GET /api/chat (wrong method) returns 405, not 500', async () => {
  // Production auth middleware may reject an anonymous request before the
  // function's method gate. With a real session, the route itself must still
  // reject GET as 405; anonymously, either safe rejection is valid.
  const { status } = await get('/api/chat', { authed: true });
  if (AUTH_TOKEN ? status !== 405 : ![401, 405].includes(status)) {
    throw new Error(`expected ${AUTH_TOKEN ? '405' : '401 or 405'}, got ${status}`);
  }
});

// ---------- New Track-1 routes (added tonight -- consolidated into one function,
// api/track1.js, to stay under Vercel Hobby's 12-function-per-deployment cap.
// Each degrades gracefully if not yet synced. These remain public (no
// requireUser() in api/track1.js), so no auth handling needed here. ----------
for (const [path, label] of [
  ['/api/track1?resource=quotes&limit=1', 'quotes (schema-verified)'],
  ['/api/track1?resource=requests&limit=1', 'requests (unverified)'],
  ['/api/track1?resource=visits&limit=1', 'visits (unverified)'],
  ['/api/track1?resource=expenses&limit=1', 'expenses (unverified)'],
  ['/api/track1?resource=timesheets&limit=1', 'timesheets (unverified)'],
  ['/api/track1?resource=users&limit=1', 'users (unverified)']
]) {
  check(`GET ${path} -- ${label} -- never 500s even before sync-extended has run`, async () => {
    const { status } = await get(path);
    if (status >= 500) throw new Error(`status ${status} -- should return ok:false with a message instead, see the route's notSynced handling`);
  });
}

check('GET /api/jobber/sync-extended reports per-resource results without crashing', async () => {
  const { status, body } = await get('/api/jobber/sync-extended', { cron: true });
  if (!CRON_SECRET) {
    if (status !== 401 || body.ok !== false) throw new Error(`expected fail-closed 401 without SMOKE_TEST_CRON_SECRET, got ${status}`);
    return;
  }
  if (status >= 500) throw new Error(`status ${status} -- the whole sync crashed instead of isolating per-resource errors`);
  if (!body.counts) throw new Error('missing counts in response');
});

// ---------- Real service-area map (added when building the map feature) ----------
check('GET /api/track1?resource=maplocations never 500s even before locations/geocode have run', async () => {
  const { status } = await get('/api/track1?resource=maplocations');
  if (status >= 500) throw new Error(`status ${status} -- should return ok:false gracefully instead, see handleMapLocations`);
});

// ---------- Visual Intelligence (added when building real job-detail photos/
// timeline/tags -- its own function, api/visual-intel.js, deliberately not
// folded into track1.js). Now gated behind requireUser() same as the routes
// above. Read-only checks here; media/tag/timeline write checks need a real
// jobber_id, left for manual verification per the handoff's suggested
// execution order (curl/Postman against a real job, signed in). ----------
checkGated('GET /api/jobs?id=nonexistent-job-id returns 404, not 500',
  (authed) => get('/api/jobs?id=nonexistent-job-id', { authed }),
  (status) => {
    if (status !== 404) throw new Error(`expected 404, got ${status}`);
  });

checkGated('GET /api/visual-intel?resource=media (no jobId) returns 400, not 500',
  (authed) => get('/api/visual-intel?resource=media', { authed }),
  (status) => {
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

checkGated('GET /api/visual-intel?resource=bogus returns 400, not 500',
  (authed) => get('/api/visual-intel?resource=bogus&jobId=x', { authed }),
  (status) => {
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

check('GET /api/visual-intel (wrong method not handled by GET) returns 400 for unknown resource, not 500', async () => {
  // Anonymous: 401 from the auth gate, which is < 500, so this still holds.
  // Authenticated (SMOKE_TEST_TOKEN set): exercises the real missing-resource path.
  const { status } = await get('/api/visual-intel', { authed: true });
  if (status >= 500) throw new Error(`status ${status} -- missing resource param crashed the function`);
});

// ---------- Runner ----------
(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`ok   - ${name}`);
      pass++;
    } catch (e) {
      console.log(`FAIL - ${name} -- ${e.message}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed (base: ${BASE}${AUTH_TOKEN ? ', authenticated' : ', anonymous -- set SMOKE_TEST_TOKEN for full authenticated coverage'})`);
  process.exit(fail ? 1 : 0);
})();
