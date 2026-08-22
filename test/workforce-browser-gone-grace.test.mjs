// test/workforce-browser-gone-grace.test.mjs
//
// The browser-close auto-clockout, and why it needed a grace window.
//
// Two bugs, one fix:
//
// 1. It had been DEAD since 2026-08-01. navigator.sendBeacon cannot set an
//    Authorization header -- the frontend puts the token in the body and
//    getRequestingProfile() reads it from there -- but middleware.js only ever
//    looks at the header, so every beacon 401'd at the edge. Production proof:
//    close_reason 'browser_closed' stops dead at 2026-08-01 16:34 while
//    'idle_timeout' (same endpoint, ordinary authenticated fetch) still fires.
//
// 2. Simply unblocking it would have made things WORSE. `pagehide` fires on a
//    refresh exactly as on a real close, so an immediate clock-out would cost
//    someone their clock-in every time they hit reload -- which is how Chris
//    found this: he hard-refreshed, stayed clocked in, and asked whether that
//    was right. It was right; the reason was a bug.
//
// So the beacon now MARKS (browser_gone_at) and a cron sweep closes the
// session five minutes later, backdated to the mark, only if nobody came back.
//
// Fully mocked -- no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

const { decideAccess, isPublicResourcePath, isCronPath } = await import('../api/_lib/guard.js');

function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const trackMod = await import('../api/track1.js');

// --- The edge gate ---------------------------------------------------------

test('the clock-out beacon can reach its handler without an Authorization header', () => {
  // This is the whole 2026-08-01 regression: sendBeacon physically cannot send
  // one, so a header-only gate refused every single beacon for fifteen days.
  const sp = new URLSearchParams({ resource: 'workforce_auto_clockout' });
  assert.equal(isPublicResourcePath('/api/track1', sp, 'POST'), true);
  const d = decideAccess({
    pathname: '/api/track1', searchParams: sp,
    hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST',
  });
  assert.equal(d.allow, true, 'the beacon must not be 401d at the edge');
  assert.equal(d.reason, 'public-resource-allowlist');
});

test('the beacon exemption is POST-only and does not open track1 generally', () => {
  for (const m of ['GET', 'PUT', 'DELETE']) {
    assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams({ resource: 'workforce_auto_clockout' }), m), false);
  }
  for (const r of ['workforce_clock', 'workforce_status', 'workforce_settings']) {
    assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams({ resource: r }), 'POST'), false, `${r} must still require a session`);
  }
});

test('the sweep is cron-only: reachable with the secret, refused without it', () => {
  const sp = () => new URLSearchParams({ resource: 'workforce_sweep_gone' });
  assert.equal(isCronPath('/api/track1', sp(), 'GET'), true);
  assert.equal(isPublicResourcePath('/api/track1', sp(), 'GET'), false, 'the sweep must never be public');
  const anon = decideAccess({ pathname: '/api/track1', searchParams: sp(), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' });
  assert.equal(anon.allow, false);
  const cron = decideAccess({ pathname: '/api/track1', searchParams: sp(), hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: 'GET' });
  assert.equal(cron.allow, true);
  // GET-pinned: never a write door.
  assert.equal(isCronPath('/api/track1', sp(), 'POST'), false);
});

// --- Marking, not closing --------------------------------------------------

const SESSION = { id: 'sess-1', employee_id: 'user-1', status: 'active', on_break: false };

function mockFetch({ sessions = [SESSION], capture }) {
  return async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'patrick@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: 'patrick@ghgrp.net', role: 'admin' }]);
    if (u.includes('/rest/v1/workforce_daily_summaries')) return jsonRes([]);
    if (u.includes('/rest/v1/workforce_time_sessions')) {
      if (method === 'PATCH') { capture.push(JSON.parse(opts.body)); return jsonRes([{ ...sessions[0], ...JSON.parse(opts.body) }]); }
      return jsonRes(sessions);
    }
    return jsonRes({});
  };
}

async function callTrack1(resource, { method = 'GET', body, headers = { authorization: 'Bearer usertoken' } } = {}) {
  const req = { method, query: { resource }, headers, body };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('a browser going away MARKS the session -- it does not clock anyone out', async () => {
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({ capture });
  try {
    // sendBeacon can't set headers, so the token arrives in the body.
    const r = await callTrack1('workforce_auto_clockout', {
      method: 'POST', headers: {}, body: { access_token: 'usertoken', reason: 'browser_gone' },
    });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.marked, true);
    assert.equal(capture.length, 1);
    assert.ok(capture[0].browser_gone_at, 'the moment the page went away must be recorded');
    assert.equal(capture[0].status, undefined, 'the session must NOT be completed here');
    assert.equal(capture[0].clock_out, undefined, 'nobody is clocked out on pagehide -- that is the refresh bug');
  } finally { global.fetch = original; }
});

test('the idle-timeout caller is unchanged and still clocks out immediately', async () => {
  // It has already watched the person do nothing for 30 minutes; there is
  // nothing to wait for.
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({ capture });
  try {
    const r = await callTrack1('workforce_auto_clockout', { method: 'POST', body: { reason: 'idle_timeout' } });
    assert.equal(r.body.ok, true);
    assert.equal(capture[0].status, 'completed');
    assert.equal(capture[0].close_reason, 'idle_timeout');
  } finally { global.fetch = original; }
});

test('coming back clears the mark -- this is what makes a refresh free', async () => {
  // workforce_status is polled every 60s by an open tab and runs on every page
  // load, so a refresh clears its own mark seconds after setting it, long
  // before the five-minute sweep.
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({ sessions: [{ ...SESSION, browser_gone_at: '2026-08-16T12:00:00Z' }], capture });
  try {
    const r = await callTrack1('workforce_status');
    assert.equal(r.body.ok, true);
    assert.equal(capture.length, 1);
    assert.equal(capture[0].browser_gone_at, null, 'the pending clock-out must be cancelled');
    assert.equal(r.body.activeSession.browser_gone_at, null, 'and the response must not still advertise it');
  } finally { global.fetch = original; }
});

test('a status check with no mark set writes nothing', async () => {
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({ capture });
  try {
    await callTrack1('workforce_status');
    assert.equal(capture.length, 0, 'no needless write on the common path');
  } finally { global.fetch = original; }
});

// --- The sweep -------------------------------------------------------------

test('the sweep refuses to run without the cron secret', async () => {
  const r = await callTrack1('workforce_sweep_gone', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.ok, false);
});

test('the sweep backdates the clock-out to when the browser went, not to now', async () => {
  // The point of backdating: nobody is paid for the gap between leaving and
  // the sweep noticing.
  const goneAt = '2026-08-16T12:00:00Z';
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({ sessions: [{ ...SESSION, browser_gone_at: goneAt }], capture });
  try {
    const r = await callTrack1('workforce_sweep_gone', { headers: { authorization: 'Bearer test-cron-secret' } });
    assert.equal(r.body.ok, true);
    assert.equal(capture[0].clock_out, goneAt, 'clock_out must equal the moment the browser went away');
    assert.equal(capture[0].status, 'completed');
    assert.equal(capture[0].close_reason, 'browser_closed');
    assert.equal(capture[0].browser_gone_at, null, 'the mark is consumed, so a re-run is a no-op');
    assert.equal(r.body.closed.length, 1);
  } finally { global.fetch = original; }
});

test('the sweep only asks the database for sessions already past the grace window', async () => {
  // The cutoff is applied in the query, so a session marked seconds ago is
  // never even returned -- a refresh cannot be caught by a sweep that happens
  // to run in between.
  const queries = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/workforce_time_sessions')) { queries.push(u); return jsonRes([]); }
    return jsonRes({});
  };
  try {
    const r = await callTrack1('workforce_sweep_gone', { headers: { authorization: 'Bearer test-cron-secret' } });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.considered, 0);
    assert.equal(r.body.graceMinutes, 5);
    const q = queries[0];
    assert.match(q, /status=eq\.active/, 'only still-open sessions');
    assert.match(q, /browser_gone_at=not\.is\.null/, 'only marked sessions');
    assert.match(q, /browser_gone_at=lt\./, 'only marks older than the grace window');
    // And the cutoff really is ~5 minutes back, not now.
    const cutoff = new Date(decodeURIComponent(/browser_gone_at=lt\.([^&]+)/.exec(q)[1]));
    const ageMs = Date.now() - cutoff.getTime();
    assert.ok(ageMs > 4.5 * 60000 && ageMs < 6 * 60000, `cutoff should be ~5 min back, was ${Math.round(ageMs / 1000)}s`);
  } finally { global.fetch = original; }
});

test('a session on break is closed cleanly, with break time counted up to the moment they left', async () => {
  const goneAt = '2026-08-16T12:00:00Z';
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({
    sessions: [{ ...SESSION, browser_gone_at: goneAt, on_break: true, break_started_at: '2026-08-16T11:50:00Z', total_break_seconds: 60 }],
    capture,
  });
  try {
    await callTrack1('workforce_sweep_gone', { headers: { authorization: 'Bearer test-cron-secret' } });
    assert.equal(capture[0].on_break, false);
    assert.equal(capture[0].break_started_at, null);
    assert.equal(capture[0].total_break_seconds, 60 + 600, 'break runs to when they left, not to now');
  } finally { global.fetch = original; }
});

// --- Old cached pages ------------------------------------------------------
// This endpoint was 401'd at the edge for fifteen days, so every tab that was
// already open when the fix shipped is running pre-fix JavaScript: its beacon
// carries no `reason` at all. If a reason-less beacon were treated as an
// immediate close, unblocking the endpoint would clock those people out on
// their very next refresh -- the exact bug this change exists to prevent,
// aimed at everyone who had NOT reloaded yet. So marking is the default and
// only an explicit 'idle_timeout' closes on the spot.

test('a beacon from an old cached page marks, it does not clock anyone out', async () => {
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({ capture });
  try {
    // Exactly what pre-fix index.html sends: token in the body, no reason.
    const r = await callTrack1('workforce_auto_clockout', {
      method: 'POST', headers: {}, body: { access_token: 'usertoken' },
    });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.marked, true, 'a reason-less beacon must take the grace path');
    assert.ok(capture[0].browser_gone_at);
    assert.equal(capture[0].status, undefined, 'an old cached page must not cause an immediate clock-out');
    assert.equal(capture[0].clock_out, undefined);
  } finally { global.fetch = original; }
});

test('only an explicit idle_timeout still closes immediately', async () => {
  for (const reason of [undefined, 'browser_gone', 'browser_closed', 'something_unknown']) {
    const capture = [];
    const original = global.fetch;
    global.fetch = mockFetch({ capture });
    try {
      await callTrack1('workforce_auto_clockout', { method: 'POST', body: { reason } });
      assert.equal(capture[0].status, undefined, `reason=${reason} must NOT close immediately`);
      assert.ok(capture[0].browser_gone_at, `reason=${reason} must mark instead`);
    } finally { global.fetch = original; }
  }
  const capture = [];
  const original = global.fetch;
  global.fetch = mockFetch({ capture });
  try {
    await callTrack1('workforce_auto_clockout', { method: 'POST', body: { reason: 'idle_timeout' } });
    assert.equal(capture[0].status, 'completed', 'idle_timeout is the ONLY immediate close');
    assert.equal(capture[0].close_reason, 'idle_timeout');
  } finally { global.fetch = original; }
});

// --- The beacon's token source --------------------------------------------
// Production, 2026-08-16: Chris closed his browser twice while clocked in and
// the database recorded NOTHING -- no write, and no rejected request either.
// The beacon was never sent at all.
//
// Cause: supabase-js is loaded UNPINNED (@supabase/supabase-js@2), so browsers
// get the CDN's latest v2, and current versions store the session
// base64-encoded ("base64-<encoded>") rather than as raw JSON. The beacon
// scraped localStorage and JSON.parse'd it; the parse threw, the throw was
// swallowed by a catch, the token stayed null, and `if (!token) return;` meant
// no beacon left the browser. A silent failure with nothing to find in a log.

import fsSync from 'node:fs';
const indexHtml = fsSync.readFileSync('public/index.html', 'utf8');

test('the beacon reads its token from the auth client, not only from localStorage', () => {
  assert.match(
    indexHtml, /window\.__hlAccessToken = null;/,
    'an in-memory token must be maintained for the unload beacon',
  );
  assert.match(
    indexHtml, /sb\.auth\.onAuthStateChange\(function\(_event, session\)\{[\s\S]*?window\.__hlAccessToken = \(session && session\.access_token\) \|\| null;/,
    'the in-memory token must track sign-in, refresh and sign-out',
  );
  assert.match(
    indexHtml, /var token = window\.__hlAccessToken \|\| null;/,
    'the beacon must prefer the auth client token over scraping storage',
  );
});

test('the storage fallback survives the base64 layout that broke it', () => {
  // \r?\n, not a bare \n: this file is checked out with CRLF line endings on
  // any Windows machine with core.autocrlf=true (the common default) even
  // though the committed blob is LF -- a literal \n here made this test fail
  // on every such machine while passing in CI (Linux, no conversion), which
  // is exactly the kind of pass-in-CI/fail-for-a-dev split that erodes trust
  // in the suite. The code itself was never broken.
  const fallback = /if \(!token\) \{[\s\S]*?\r?\n    \}\r?\n    if \(!token\) return;/.exec(indexHtml);
  assert.ok(fallback, 'the localStorage fallback block must still exist');
  assert.match(fallback[0], /indexOf\('base64-'\) === 0/, 'it must recognise the base64- prefix');
  assert.match(fallback[0], /atob\(/, 'it must decode it rather than JSON.parse the encoded string');
  assert.match(fallback[0], /currentSession/, 'it must also handle the wrapped-session layout');
});

test('the beacon still refuses to fire with no token at all', () => {
  // Guardrail: the fix must not turn "no session" into an unauthenticated
  // POST. A signed-out tab closing must stay silent.
  assert.match(indexHtml, /if \(!token\) return;/, 'no token must still mean no beacon');
});

test('the beacon still sends the token in the body and marks rather than closes', () => {
  assert.match(
    indexHtml,
    /JSON\.stringify\(\{ access_token: token, reason: 'browser_gone' \}\)/,
    'sendBeacon cannot set a header, so the token rides in the body -- with the grace-path reason',
  );
  assert.match(indexHtml, /navigator\.sendBeacon\('\/api\/track1\?resource=workforce_auto_clockout', blob\)/);
});
