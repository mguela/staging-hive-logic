// Regression test for the Job Setup & Readiness ("Setup Queue") view's
// stuck "Loading real jobs..." bug (master to-do, HiveLogic Live known bugs:
// "[MED] Setup Queue tab permanently stuck 'Loading real jobs...'.").
//
// Root cause: view-jsx is rendered inside its own <iframe>. Its loadReal()
// function calls fetch(jsxOrigin()+'/api/jobs?...') with NO Authorization
// header. Since the 7/29 P0 security fix, /api/jobs requires a signed-in
// session server-side (requireUser()) -- so this iframe fetch has 401'd for
// every single user since that fix shipped, every time, with no way to ever
// recover: Promise.all(...).then(...) sees jobsResp.ok === false and throws,
// which the .catch() turns into a permanent "Could not load real jobs"
// state. The outer page's own window.fetch auth-shim (added in that same
// P0 commit to auto-attach a bearer token to same-origin /api/ calls) lives
// on the OUTER page's window object and does not reach into a separate
// iframe's own global scope, so it never covered this call.
//
// Fix: a new jsxAuthHeaders() helper reaches across to the parent frame via
// window.parent.hlTokenSync() -- the exact same token-lookup function every
// other authenticated fetch in this codebase already uses -- and both
// loadReal() reads now pass it as their fetch init. This mirrors the
// existing jsxOrigin()/jsxCurrentUser() pattern in this exact file, which
// already reaches into window.parent (for location.origin and for the
// Supabase client respectively), so this is not a new kind of cross-frame
// access, just applying the established pattern to fix a real gap.
//
// Structural/string checks against the real public/index.html source (this
// is a huge static HTML+inline-JS file with no DOM harness wired up here,
// same approach as the sibling create-job-button test) -- every assertion
// anchors to exact, load-bearing strings so a future edit that removes the
// header or reverts the fetch calls will fail this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');

test('jsxAuthHeaders() exists and reaches the parent frame\'s real token helper', () => {
  assert.match(
    html,
    /function jsxAuthHeaders\(\)\{ try \{ var t = window\.parent\.hlTokenSync\(\); return t \? \{ headers: \{ Authorization: 'Bearer ' \+ t \} \} : \{\}; \} catch\(e\) \{ return \{\}; \} \}/,
    'jsxAuthHeaders() must exist and call window.parent.hlTokenSync(), the same token lookup used everywhere else'
  );
});

test('the loadReal() /api/jobs fetch (the one gated by requireUser()) now attaches jsxAuthHeaders()', () => {
  assert.match(
    html,
    /fetch\(jsxOrigin\(\)\+'\/api\/jobs\?status=active&limit=1000', jsxAuthHeaders\(\)\)\.then\(function\(r\)\{return r\.json\(\);\}\),/,
    'the /api/jobs read must pass jsxAuthHeaders() so it stops 401ing for every signed-in user'
  );
});

test('the loadReal() /api/track1 fetch also attaches jsxAuthHeaders() (harmless today, future-proofed)', () => {
  assert.match(
    html,
    /fetch\(jsxOrigin\(\)\+'\/api\/track1\?resource=job_workflow_list', jsxAuthHeaders\(\)\)\.then\(function\(r\)\{return r\.json\(\);\}\)/,
    'the job_workflow_list read should also carry the same headers object'
  );
});

test('hlTokenSync() still exists on the outer page for jsxAuthHeaders() to reach', () => {
  assert.match(html, /function hlTokenSync\(\)\{/, 'hlTokenSync() must still exist on the outer page');
});

test('the established window.parent cross-frame pattern this fix follows is still present (jsxOrigin, jsxCurrentUser)', () => {
  assert.match(html, /function jsxOrigin\(\)\{ try \{ return window\.parent\.location\.origin;/, 'jsxOrigin() precedent must still exist');
  assert.match(html, /window\.parent\.sb\.auth\.getSession\(\)/, 'jsxCurrentUser()\'s window.parent.sb precedent must still exist');
});

test('the error-handling path this fix feeds into is unchanged -- a real failure still surfaces a message, not a silent infinite spinner', () => {
  assert.match(html, /if\(!jobsResp\.ok\) throw new Error\(jobsResp\.error \|\| 'jobs load failed'\);/);
  assert.match(html, /Could not load real jobs -- '\+e\.message/);
});
