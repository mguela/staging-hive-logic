// test/workforce-clockout-eod.test.mjs
//
// Bug (Chris, 2026-08-16): "when I try to clock out, it won't allow me. it asks
// for the EOD report, but it doesn't pop the report up."
//
// The End-of-Day exemption for the Owner existed ONLY in the browser
// (hlWfIsOwner in public/index.html). handleWorkforceClock's 'out' branch
// enforced the requirement unconditionally. So the Owner's clock-out skipped
// the client-side check -- the only branch that navigates to the EOD form --
// and was then refused by the server, which just toasted the requirement and
// stopped. Unsatisfiable: asked for a report, never shown the form, never
// clocked out.
//
// Two halves are fixed and pinned here:
//   1. the server honours the same Owner exemption the client already applied;
//   2. when the server DOES refuse for a missing report, it says so with an
//      explicit needsEodReport flag, and the client routes to the form.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/workforce-clockout-eod.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

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

const OPEN_SESSION = { id: 'sess-1', employee_id: 'user-1', status: 'active', on_break: false };

let scenario = {};

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: scenario.email });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: scenario.email, role: scenario.role || null }]);
    if (u.includes('/rest/v1/workforce_time_sessions')) {
      if (method === 'PATCH') return jsonRes([{ ...OPEN_SESSION, status: 'completed', clock_out: '2026-08-16T12:00:00Z' }]);
      return jsonRes(scenario.clockedIn === false ? [] : [OPEN_SESSION]);
    }
    if (u.includes('/rest/v1/workforce_daily_summaries')) return jsonRes(scenario.summaries || []);
    // Who the Owner is now comes from employee_roles.permission_roles, via
    // users.email -> jobber_id, rather than from a name in the source.
    if (u.includes('/rest/v1/users')) return jsonRes([{ jobber_id: 'jobber-1' }]);
    if (u.includes('/rest/v1/employee_roles')) {
      return jsonRes([{ permission_roles: scenario.permissionRoles || [], permission_role: null }]);
    }
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

const trackMod = await import('../api/track1.js');

async function clockOut() {
  const req = {
    method: 'POST',
    query: { resource: 'workforce_clock' },
    headers: { authorization: 'Bearer usertoken' },
    body: { action: 'out' },
  };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('the Owner can clock out with no End-of-Day report -- the exemption is no longer browser-only', async () => {
  scenario = { email: 'chris@ghgrp.net', role: 'superadmin', permissionRoles: ['owner', 'design_sales'], summaries: [] };
  const r = await withMockedFetch(clockOut);
  assert.equal(r.body.ok, true, 'the Owner must not be blocked server-side by the EOD requirement');
  assert.equal(r.body.session.status, 'completed');
});

test('the Owner exemption follows the role, whatever the address looks like', async () => {
  // This used to test that the email comparison survived casing and stray
  // whitespace -- necessary when identity WAS the email. Ownership is now the
  // 'owner' permission role from user setup, so the address it happens to be
  // stored under is not part of the answer at all. The cases are kept because
  // the lookup still goes through users.email.
  for (const email of ['Chris@ghgrp.net', 'CHRIS@GHGRP.NET', '  chris@ghgrp.net  ']) {
    scenario = { email, role: 'superadmin', permissionRoles: ['owner'], summaries: [] };
    const r = await withMockedFetch(clockOut);
    assert.equal(r.body.ok, true, `${JSON.stringify(email)} holds the owner role and must be exempt`);
  }
});

test('a second owner is exempt too -- the rule is not one person', async () => {
  // Lori Kendall holds 'owner' in production alongside Chris. The old email
  // check could only ever have exempted one of them.
  scenario = { email: 'lori@greenwichhandyman.net', role: 'crew', permissionRoles: ['owner'], summaries: [] };
  const r = await withMockedFetch(clockOut);
  assert.equal(r.body.ok, true, 'ownership is a role, and more than one person can hold it');
});

test('everyone else still has to submit an EOD report before clocking out', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', permissionRoles: ['office_manager'], summaries: [] };
  const r = await withMockedFetch(clockOut);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /End-of-Day report/);
});

test('the exemption is ownership, not seniority -- another superadmin still reports', async () => {
  // superadmin also covers Jomell, who does submit EOD reports (see the
  // timezone regression in workforce-team.test.mjs). Gating on the LOGIN role
  // would have silently exempted him along with the Owner -- which is why
  // ownership is its own permission role and not a rung on that ladder.
  scenario = { email: 'Jomell@ghgrp.net', role: 'superadmin', permissionRoles: ['project_manager'], summaries: [] };
  const r = await withMockedFetch(clockOut);
  assert.equal(r.body.ok, false, 'a superadmin who is not the Owner must still submit a report');
  assert.match(r.body.error, /End-of-Day report/);
});

test('a non-owner WITH a report submitted today clocks out normally', async () => {
  scenario = {
    email: 'patrick@ghgrp.net', role: 'admin',
    summaries: [{ id: 'sum-1', employee_id: 'user-1', summary_date: '2026-08-16' }],
  };
  const r = await withMockedFetch(clockOut);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.session.status, 'completed');
});

test('the EOD refusal is machine-readable, so the client can show the form instead of just the message', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', permissionRoles: ['office_manager'], summaries: [] };
  const r = await withMockedFetch(clockOut);
  assert.equal(r.body.needsEodReport, true, 'the refusal must be distinguishable from any other clock-out failure');
});

test('an unrelated clock-out failure is NOT flagged as an EOD problem', async () => {
  // On break: refused for a completely different reason. If this carried the
  // flag, the client would bounce the user to the EOD form for no reason.
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'patrick@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: 'patrick@ghgrp.net', role: 'admin' }]);
    if (u.includes('/rest/v1/workforce_time_sessions')) return jsonRes([{ ...OPEN_SESSION, on_break: true }]);
    return jsonRes({ error: 'not relevant' });
  };
  try {
    const r = await clockOut();
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /break/i);
    assert.notEqual(r.body.needsEodReport, true);
  } finally { global.fetch = original; }
});

// --- the client half -------------------------------------------------------
// Structural checks on public/index.html (one huge inline-JS file, no DOM
// harness in this repo), anchored on the exact load-bearing strings.

const html = fs.readFileSync('public/index.html', 'utf8');

test('the clock-out server-error path routes to the EOD form instead of dead-ending', () => {
  assert.match(
    html, /function hlWfGoToEodForm\(\)\{/,
    'the navigate-to-the-form step must be a named helper, reachable from both refusal paths',
  );
  assert.match(
    html,
    /if \(data && \(data\.needsEodReport \|\| \/End-of-Day report\/i\.test\(String\(data\.error \|\| ''\)\)\)\) \{/,
    'a server refusal for a missing EOD report must be detected client-side',
  );
  // The client-side pre-check and the server-refusal branch must call it --
  // plus, as of the manual clock-out form (2026-08-25), a third caller: that
  // form's own server-refusal handling hits the identical EOD-required
  // refusal (workforce_clock's 'out' action gates on it regardless of
  // whether manualClockOutAt was sent) and must redirect the same way.
  assert.equal(
    (html.match(/hlWfGoToEodForm\(\);/g) || []).length, 3,
    'the pre-check, the normal clock-out server-refusal path, and the manual clock-out server-refusal path must all show the form',
  );
});

test('the form the user is sent to still exists, and is still what the EOD submit reads', () => {
  assert.match(html, /id="wf-eod-card"/, 'the EOD card is the scroll target');
  for (const id of ['wf-tasks', 'wf-plans', 'wf-blockers', 'wf-support']) {
    assert.ok(html.includes('id="' + id + '"'), `${id} must still exist on the EOD form`);
  }
  // go('workforce') is what actually reveals #workforce -- showView() only
  // shows it for v==='ttx', so the helper depends on both calls.
  assert.match(html, /function go\(page\)\{/, 'go(page) must still exist');
  assert.match(html, /id="workforce"/, 'the Time Clock page container must still exist');
});

test('the browser and the server cannot disagree about who the Owner is', () => {
  // The bug this file pins was the two sides being edited independently, which
  // made the clock-out unsatisfiable. They used to be kept in step by both
  // hardcoding the same address -- two copies of one fact, which is the thing
  // that drifts. Now there is one copy: the server answers, the page is told.
  const api = fs.readFileSync('api/track1.js', 'utf8');
  // requesterIsOwner (2026-08-26) is computed once via isOwner(requester)
  // and reused for both isOwner and canViewScreenshots.
  assert.match(api, /const requesterIsOwner = await isOwner\(requester\);/);
  assert.match(api, /isOwner: requesterIsOwner,/,
    'workforce_status must carry the answer to the page');
  assert.match(html, /isOwner = !!\(data && data\.isOwner\);/,
    'and the page must take it from there rather than deciding for itself');
  assert.match(html, /var hlWfIsOwner = isOwner;/,
    'including at the clock-out, which is where the two used to diverge');
});
