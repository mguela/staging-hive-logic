// test/api-auth-guard.test.mjs
// Item 3 (2026-08-01): proves the global /api auth choke point. Two layers:
//   A. The pure decision logic in api/_lib/guard.js — the exact rules the
//      Edge middleware enforces — across public/user/cron/anonymous cases.
//   B. Handler-level: the three named high-value endpoints (track1,
//      bookkeeping/reference-data, import-companycam) reject anonymous
//      requests with 401 and never reach their data code.
// Fully mocked — no network, no DB, no real secret. Run with:
//   node --test test/api-auth-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPublicApiPath,
  isCronPath,
  isPublicResourcePath,
  decideAccess,
  checkCronSecret,
} from '../api/_lib/guard.js';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function res() {
  const calls = [];
  return {
    calls,
    statusCode: null,
    body: null,
    setHeader() {},
    status(c) { this.statusCode = c; calls.push({ code: c }); return this; },
    json(b) { this.body = b; calls.push({ body: b }); return this; },
  };
}

// =====================================================================
// A. Pure decision logic
// =====================================================================

test('public allowlist covers portals, webhooks, oauth callbacks, health, agents', () => {
  for (const p of [
    '/api/health', '/api/health-test',
    '/api/jobber/callback', '/api/jobber/webhook',
    '/api/qbo', '/api/msmail',
    '/api/authnet-webhook', '/api/resend-webhook', '/api/voice-webhook', '/api/voice',
    '/api/clientportal', '/api/subportal',
    '/api/agents/enrollment', '/api/agents/device', '/api/agents/control',
    '/api/ai-workroom',
    '/api/marketing-unsubscribe', '/api/test-workflow',
  ]) {
    assert.equal(isPublicApiPath(p), true, `${p} should be public`);
  }
});

test('the estimate Approve/Reject link (respond.js) is public, same as /api/schedule/confirm -- both are token-authenticated, no HiveLogic session can ever exist', () => {
  // Found live, 2026-08-27: respond.js was built to mirror /api/schedule/confirm
  // exactly (its own header comment says so) but was never actually added
  // here, so the edge gate 401'd every real client who clicked a real emailed
  // Approve/Reject link -- unreachable since the feature shipped, because
  // nobody had a working Resend key to click a real one until now.
  assert.equal(isPublicApiPath('/api/bookkeeping/estimates/respond'), true);
  // A narrow, exact allowlist entry -- it must not blow open the rest of the
  // bookkeeping API, which stays session-gated.
  assert.equal(isPublicApiPath('/api/bookkeeping/reference-data'), false);
  assert.equal(isPublicApiPath('/api/bookkeeping/estimates'), false);
  assert.equal(isPublicApiPath('/api/bookkeeping/estimates/respond-lookalike'), false);
});

test('protected data endpoints are NOT on the public allowlist', () => {
  for (const p of [
    '/api/track1', '/api/bookkeeping/reference-data', '/api/import-companycam',
    '/api/clients', '/api/jobs', '/api/invoices', '/api/documents', '/api/fieldops',
    '/api/snapshot', '/api/takeoffs', '/api/visual-intel', '/api/reports/summary',
    '/api/schedule/move-visit', '/api/chat', '/api/marketing', '/api/health-cron',
  ]) {
    assert.equal(isPublicApiPath(p), false, `${p} must NOT be public`);
  }
});

test('a public prefix cannot be spoofed by a lookalike path', () => {
  assert.equal(isPublicApiPath('/api/healthy-secrets'), false); // not '/api/health' exact/segment
  assert.equal(isPublicApiPath('/api/clientportal-admin'), false);
  assert.equal(isPublicApiPath('/api/agents'), false); // '/api/agents/' requires the slash segment
  assert.equal(isPublicApiPath('/api/ai-workroom-secrets'), false);
});

test('cron paths are recognized (whole-path and resource-scoped)', () => {
  const sp = (o) => new URLSearchParams(o);
  assert.equal(isCronPath('/api/jobber/sync', sp({ resource: 'clients' })), true);
  assert.equal(isCronPath('/api/jobber/sync-extended', sp({ resource: 'visits' })), true);
  assert.equal(isCronPath('/api/import-companycam', sp({})), true);
  assert.equal(isCronPath('/api/health-cron', sp({})), true);
  assert.equal(isCronPath('/api/track1', sp({ resource: 'check_new_leads' })), true);
  assert.equal(isCronPath('/api/track1', sp({ resource: 'leaks' })), true);
  assert.equal(isCronPath('/api/track1', sp({ resource: 'watching_margin_fade' })), true);
  assert.equal(isCronPath('/api/marketing', sp({ resource: 'process_scheduled_sends' })), true);
  // NON-cron resources on the same endpoints are not cron-exempt. NB: 'cash'
  // used to be the example here and became cron-exempt on 2026-08-15 (it is a
  // read the unattended audits need); 'team' is a non-financial company-data
  // read that is deliberately still session-only.
  assert.equal(isCronPath('/api/track1', sp({ resource: 'team' })), false);
  assert.equal(isCronPath('/api/marketing', sp({ resource: 'campaign_send' })), false);
});

test('decideAccess: anonymous request to a protected endpoint is DENIED 401', () => {
  const d = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: 'team' }), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true });
  assert.equal(d.allow, false);
  assert.equal(d.status, 401);
});

test('decideAccess: a valid user is allowed on a protected endpoint', () => {
  const d = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: 'cash' }), hasValidUser: true, hasValidCronSecret: false, cronSecretConfigured: true });
  assert.equal(d.allow, true);
});

test('decideAccess: public endpoint allowed even with no auth', () => {
  const d = decideAccess({ pathname: '/api/clientportal', searchParams: new URLSearchParams(), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true });
  assert.equal(d.allow, true);
});

test('isPublicResourcePath: the Dev To-Do writer is never public', () => {
  assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams('resource=reina_todo_set'), 'POST'), false);
  assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams('resource=reina_todo_set'), 'GET'), false);
  assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams('resource=reina_todo_get'), 'POST'), false);
  assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams('resource=check_new_leads'), 'POST'), false);
  assert.equal(isPublicResourcePath('/api/marketing', new URLSearchParams('resource=reina_todo_set'), 'POST'), false);
});

test('decideAccess: the Dev To-Do writer requires ordinary authentication', () => {
  const allowed = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams('resource=reina_todo_set'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST' });
  assert.equal(allowed.allow, false);
  const wrongMethod = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams('resource=reina_todo_set'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' });
  assert.equal(wrongMethod.allow, false);
  const wrongResource = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams('resource=reina_todo_get'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' });
  assert.equal(wrongResource.allow, false);
});

test('decideAccess: Reina Lab bridge reaches only its self-authenticating GET handler', () => {
  const allowed = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams('resource=reina_lab_read'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, 'public-resource-allowlist');
  const post = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams('resource=reina_lab_read'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST' });
  assert.equal(post.allow, false);
  const nearMiss = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams('resource=reina_lab_reads'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' });
  assert.equal(nearMiss.allow, false);
});

test('decideAccess: cron path needs the cron secret when configured', () => {
  const base = { pathname: '/api/health-cron', searchParams: new URLSearchParams(), hasValidUser: false, cronSecretConfigured: true };
  assert.equal(decideAccess({ ...base, hasValidCronSecret: true }).allow, true);
  assert.equal(decideAccess({ ...base, hasValidCronSecret: false }).allow, false);
});

test('decideAccess: cron grace only applies to cron paths, never the data surface', () => {
  // grace: cron path, no secret configured -> allowed (keeps scheduler alive)
  assert.equal(decideAccess({ pathname: '/api/import-companycam', searchParams: new URLSearchParams(), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: false }).allow, true);
  // but a non-cron protected path is still DENIED even with no secret configured
  assert.equal(decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: 'team' }), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: false }).allow, false);
});

// --- Scheduled read-only financial reads (2026-08-15) ----------------------
// api/snapshot.js accepts CRON_SECRET itself, but /api/snapshot was on no
// allowlist, so the edge guard 401'd it before the handler could honour the
// secret. These pin the fix AND the invariant that it stays non-public.

test('snapshot: is a cron path but is NEVER public', () => {
  assert.equal(isCronPath('/api/snapshot', new URLSearchParams()), true);
  // The important half: cron-exempt != public. Anonymous callers get nothing.
  assert.equal(isPublicApiPath('/api/snapshot'), false);
  assert.equal(isPublicResourcePath('/api/snapshot', new URLSearchParams(), 'GET'), false);
});

test('decideAccess: snapshot needs the cron secret, and a lookalike path is not exempt', () => {
  const base = { pathname: '/api/snapshot', searchParams: new URLSearchParams(), hasValidUser: false, cronSecretConfigured: true };
  assert.equal(decideAccess({ ...base, hasValidCronSecret: true }).allow, true);
  // No secret -> denied. This is the anonymous-attacker case.
  const denied = decideAccess({ ...base, hasValidCronSecret: false });
  assert.equal(denied.allow, false);
  assert.equal(denied.status, 401);
  // A signed-in employee still gets through the normal way.
  assert.equal(decideAccess({ ...base, hasValidUser: true, hasValidCronSecret: false }).allow, true);
  // '/api/snapshot-export' must not inherit the exemption.
  assert.equal(isCronPath('/api/snapshot-export', new URLSearchParams()), false);
});

test('qbo: cron secret authenticates a GET financials read, but never a write method', async () => {
  process.env.CRON_SECRET = 'configured-secret';
  const original = global.fetch;
  global.fetch = async () => { throw new Error('no upstream call should happen'); };
  try {
    const mod = await import('../api/qbo/index.js');

    // GET + valid secret -> passes the auth gate (fails later on no QBO
    // connection, which is what we want: it got past 401).
    const okReq = { method: 'GET', query: { resource: 'financials' }, headers: { authorization: 'Bearer configured-secret' } };
    const okRes = res();
    await mod.default(okReq, okRes);
    assert.notEqual(okRes.statusCode, 401, 'valid cron secret on a GET read must clear the auth gate');

    // Same secret on a NON-GET is not a service read -> falls back to
    // requireUser -> 401. Keeps the exemption read-only.
    const writeReq = { method: 'POST', query: { resource: 'financials' }, headers: { authorization: 'Bearer configured-secret' } };
    const writeRes = res();
    await mod.default(writeReq, writeRes);
    assert.equal(writeRes.statusCode, 401, 'cron secret must not authorize a non-GET');

    // Wrong secret -> 401.
    const badReq = { method: 'GET', query: { resource: 'financials' }, headers: { authorization: 'Bearer wrong' } };
    const badRes = res();
    await mod.default(badReq, badRes);
    assert.equal(badRes.statusCode, 401);

    // Anonymous -> 401.
    const anonReq = { method: 'GET', query: { resource: 'financials' }, headers: {} };
    const anonRes = res();
    await mod.default(anonReq, anonRes);
    assert.equal(anonRes.statusCode, 401);
  } finally {
    global.fetch = original;
    delete process.env.CRON_SECRET;
  }
});

test('qbo: with CRON_SECRET unset the exemption is fail-closed', async () => {
  delete process.env.CRON_SECRET;
  const original = global.fetch;
  global.fetch = async () => { throw new Error('no upstream call should happen'); };
  try {
    const mod = await import('../api/qbo/index.js');
    const req = { method: 'GET', query: { resource: 'financials' }, headers: { authorization: 'Bearer anything' } };
    const r = res();
    await mod.default(req, r);
    assert.equal(r.statusCode, 401, 'no CRON_SECRET configured must not become an open door');
  } finally {
    global.fetch = original;
  }
});

test('checkCronSecret is timing-safe-ish and exact', () => {
  process.env.CRON_SECRET = 'the-real-cron-secret';
  assert.equal(checkCronSecret('Bearer the-real-cron-secret'), true);
  assert.equal(checkCronSecret('Bearer wrong'), false);
  assert.equal(checkCronSecret('Bearer the-real-cron-secre'), false); // prefix
  assert.equal(checkCronSecret(''), false);
  delete process.env.CRON_SECRET;
});

// =====================================================================
// B. Handler-level: anonymous -> 401, no data code reached
// =====================================================================

test('track1: anonymous request to a financial resource is rejected 401', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('no upstream call should happen for an anonymous request'); };
  try {
    const mod = await import('../api/track1.js');
    const req = { method: 'GET', query: { resource: 'cash' }, headers: {}, body: {} };
    const r = res();
    await mod.default(req, r);
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.ok, false);
  } finally {
    global.fetch = original;
  }
});

test('bookkeeping/reference-data: anonymous request is rejected 401', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('no upstream call should happen for an anonymous request'); };
  try {
    const mod = await import('../api/bookkeeping/reference-data.js');
    const req = { method: 'GET', query: { resource: 'all' }, headers: {}, socket: {} };
    const r = res();
    await mod.default(req, r);
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.ok, false);
  } finally {
    global.fetch = original;
  }
});

test('import-companycam: anonymous request is rejected 401 when CRON_SECRET is configured', async () => {
  process.env.CRON_SECRET = 'configured-secret';
  const original = global.fetch;
  global.fetch = async () => { throw new Error('no upstream call should happen for an anonymous request'); };
  try {
    const mod = await import('../api/import-companycam.js');
    const req = { method: 'GET', query: {}, headers: {} };
    const r = res();
    await mod.default(req, r);
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.ok, false);
  } finally {
    global.fetch = original;
    delete process.env.CRON_SECRET;
  }
});

test('import-companycam: cron secret authenticates the scheduled run', async () => {
  process.env.CRON_SECRET = 'configured-secret';
  process.env.COMPANYCAM_API_TOKEN = ''; // force the next guard (missing token -> 500) so we stop before real work
  const original = global.fetch;
  global.fetch = async () => { throw new Error('should not fetch — we stop at the TOKEN check'); };
  try {
    const mod = await import('../api/import-companycam.js');
    const req = { method: 'GET', query: {}, headers: { authorization: 'Bearer configured-secret' } };
    const r = res();
    await mod.default(req, r);
    // Passed the auth gate (not 401); stopped at the missing-token 500 instead.
    assert.notEqual(r.statusCode, 401);
    assert.equal(r.statusCode, 500);
  } finally {
    global.fetch = original;
    delete process.env.CRON_SECRET;
    delete process.env.COMPANYCAM_API_TOKEN;
  }
});

// --- Scheduled financial READS, third leg (2026-08-15) ----------------------
// snapshot + qbo were fixed in d6c3b61; track1's own financial read resources
// were left out and still 401'd at the edge. These pin the fix and, more
// importantly, the two invariants that keep it narrow: GET-only, and reads
// only -- no track1 write resource may ride in on the cron secret.

const FINANCIAL_READS = ['dailybrief', 'cash', 'overhead', 'forecast', 'jobs_margin_list'];

test('track1 financial reads are cron-exempt on GET', () => {
  for (const r of FINANCIAL_READS) {
    assert.equal(isCronPath('/api/track1', new URLSearchParams({ resource: r }), 'GET'), true, `${r} should be cron-exempt on GET`);
  }
  // ...and the two from 2026-08-05 still are, unchanged by the method pinning.
  assert.equal(isCronPath('/api/track1', new URLSearchParams({ resource: 'leaks' }), 'GET'), true);
  assert.equal(isCronPath('/api/track1', new URLSearchParams({ resource: 'watching_margin_fade' }), 'GET'), true);
});

test('track1 financial reads are GET-only: no write method rides in on the cron secret', () => {
  for (const r of FINANCIAL_READS) {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(isCronPath('/api/track1', new URLSearchParams({ resource: r }), m), false, `${r} must not be cron-exempt on ${m}`);
      const d = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: r }), hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: m });
      assert.equal(d.allow, false, `${r} ${m} must be denied even WITH a valid cron secret`);
      assert.equal(d.status, 401);
    }
  }
});

test('track1 financial reads still need the cron secret, and are never public', () => {
  for (const r of FINANCIAL_READS) {
    // No secret -> denied, even though the resource is on the cron allowlist.
    const anon = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: r }), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' });
    assert.equal(anon.allow, false, `${r} must not be readable anonymously`);
    assert.equal(anon.reason, 'cron-bad-secret');
    // With the secret -> allowed.
    const cron = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: r }), hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: 'GET' });
    assert.equal(cron.allow, true, `${r} must be readable by the scheduler`);
    assert.equal(cron.reason, 'valid-cron-secret');
    // A real signed-in user is unaffected.
    assert.equal(decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: r }), hasValidUser: true, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' }).allow, true);
    // And none of them leaked onto the public allowlist.
    assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams({ resource: r }), 'GET'), false);
  }
  assert.equal(isPublicApiPath('/api/track1'), false);
});

test('track1 write + non-financial resources stay session-only', () => {
  // Sample across the endpoint: writes, and reads that are NOT financial.
  for (const r of ['job_workflow_set', 'job_readiness_set', 'materials_cart_add', 'team', 'employee_roster', 'subcontractors', 'reina_todo_get']) {
    for (const m of ['GET', 'POST']) {
      assert.equal(isCronPath('/api/track1', new URLSearchParams({ resource: r }), m), false, `${r} must never be cron-exempt (${m})`);
    }
    const d = decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: r }), hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: 'GET' });
    assert.equal(d.allow, false, `${r} must be denied even WITH a valid cron secret`);
  }
});

test('monitor_prune (internal retention cron) is cron-exempt but never public', () => {
  assert.equal(isCronPath('/api/track1', new URLSearchParams({ resource: 'monitor_prune' }), 'GET'), true);
  assert.equal(decideAccess({ pathname: '/api/track1', searchParams: new URLSearchParams({ resource: 'monitor_prune' }), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' }).allow, false);
  assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams({ resource: 'monitor_prune' }), 'GET'), false);
});

// --- vercel.json <-> guard drift (2026-08-15) -------------------------------
// This bug class has now bitten three times: a cron is scheduled in
// vercel.json, nobody adds it to guard.js, and the edge 401s it on every run
// -- silently, because a failing cron has nobody to tell. It caused the
// 2026-08-05 leaks/watching_margin_fade fix, the 2026-08-15 snapshot fix, and
// the ten unlisted crons found while fixing this one. This test closes the
// class: adding a cron to vercel.json without allowlisting it now fails CI.
//
// KNOWN_UNROUTED is the escape hatch for a cron that is scheduled but
// deliberately not reachable. It is EMPTY, and that is the point: all 29
// scheduled crons now resolve, so the test below is a plain "no cron is
// stranded" assertion with no exceptions carved out of it.
//
// It held nine entries for part of 2026-08-15 -- the marketing auto-sends and
// the social publisher -- while it was confirmed that each is independently
// switched off behind the guard (per-playbook env vars; empty
// ad_platform_connections / social_posts in production). Once that was
// established, letting the scheduler reach them restores plumbing without
// sending anything, so they were allowlisted properly instead.
//
// If a future cron genuinely must stay unreachable, add it here WITH the
// reason. An entry that is merely forgotten belongs in guard.js instead.
const KNOWN_UNROUTED_CRONS = new Set([]);

test('every vercel.json cron can actually get past the edge guard', async () => {
  const { readFileSync } = await import('node:fs');
  const { crons } = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(crons) && crons.length > 0, 'vercel.json should define crons');

  const stranded = [];
  for (const c of crons) {
    const u = new URL(c.path, 'https://hivelogic-live.invalid');
    // Vercel Cron issues GET carrying the CRON_SECRET bearer.
    const reachable = isPublicApiPath(u.pathname)
      || decideAccess({ pathname: u.pathname, searchParams: u.searchParams, hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: 'GET' }).allow;
    if (!reachable && !KNOWN_UNROUTED_CRONS.has(c.path)) stranded.push(c.path);
  }
  assert.deepEqual(stranded, [], `these crons are scheduled but 401 at the edge on every run -- add them to guard.js (or to KNOWN_UNROUTED_CRONS with a reason):\n  ${stranded.join('\n  ')}`);
});

test('the known-unrouted cron list does not rot', async () => {
  const { readFileSync } = await import('node:fs');
  const { crons } = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const scheduled = new Set(crons.map((c) => c.path));
  for (const p of KNOWN_UNROUTED_CRONS) {
    assert.ok(scheduled.has(p), `${p} is in KNOWN_UNROUTED_CRONS but no longer scheduled in vercel.json — drop it from the list`);
    const u = new URL(p, 'https://hivelogic-live.invalid');
    const reachable = isPublicApiPath(u.pathname)
      || decideAccess({ pathname: u.pathname, searchParams: u.searchParams, hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: 'GET' }).allow;
    assert.equal(reachable, false, `${p} is now reachable — remove it from KNOWN_UNROUTED_CRONS so it is covered by the drift test`);
  }
});

// --- The nine remaining scheduled routes (2026-08-15) -----------------------
// Reaching the handler is not the same as sending: each of these is switched
// off again behind this guard (per-playbook env vars in api/marketing.js;
// empty ad_platform_connections / social_posts for the publisher). What these
// pin is that the guard itself stays as tight for them as for everything
// else -- cron secret required, GET only, never public.

const OUTWARD_CRONS = [
  ['/api/social-posts', 'process_scheduled_posts'],
  ['/api/marketing', 'process_review_request_autosend'],
  ['/api/marketing', 'process_post_job_thank_you_autosend'],
  ['/api/marketing', 'process_service_anniversary_autosend'],
  ['/api/marketing', 'process_dormant_reactivation_autosend'],
  ['/api/marketing', 'process_maintenance_reminders_autosend'],
  ['/api/marketing', 'process_new_lead_followup_autosend'],
  ['/api/marketing', 'process_newsletter_autosend'],
  ['/api/marketing', 'process_referral_autosend'],
];

test('the nine scheduled send routes reach their handler only with the cron secret', () => {
  for (const [path, resource] of OUTWARD_CRONS) {
    const sp = () => new URLSearchParams({ resource });
    const call = (over) => decideAccess({ pathname: path, searchParams: sp(), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET', ...over });
    // Anonymous: refused.
    const anon = call({});
    assert.equal(anon.allow, false, `${resource} must not be reachable anonymously`);
    assert.equal(anon.reason, 'cron-bad-secret');
    // With the secret: the scheduler gets through.
    assert.equal(call({ hasValidCronSecret: true }).reason, 'valid-cron-secret', `${resource} must be reachable by cron`);
    // Never public.
    assert.equal(isPublicResourcePath(path, sp(), 'GET'), false, `${resource} must not be on the public allowlist`);
  }
  assert.equal(isPublicApiPath('/api/marketing'), false);
  assert.equal(isPublicApiPath('/api/social-posts'), false);
});

test('the nine scheduled send routes are GET-only, even with a valid cron secret', () => {
  for (const [path, resource] of OUTWARD_CRONS) {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(isCronPath(path, new URLSearchParams({ resource }), m), false, `${resource} must not be cron-exempt on ${m}`);
      const d = decideAccess({ pathname: path, searchParams: new URLSearchParams({ resource }), hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: m });
      assert.equal(d.allow, false, `${resource} ${m} must be denied even WITH a valid cron secret`);
    }
  }
});

test('allowlisting the send routes did not open their endpoints generally', () => {
  // The user-facing resources on those same two endpoints stay session-only.
  for (const [path, resource] of [
    ['/api/marketing', 'campaign_send'],
    ['/api/marketing', 'campaigns'],
    ['/api/social-posts', 'social_post_publish'],
    ['/api/social-posts', 'social_post_create'],
  ]) {
    for (const m of ['GET', 'POST']) {
      assert.equal(isCronPath(path, new URLSearchParams({ resource }), m), false, `${resource} must never be cron-exempt (${m})`);
    }
    assert.equal(
      decideAccess({ pathname: path, searchParams: new URLSearchParams({ resource }), hasValidUser: false, hasValidCronSecret: true, cronSecretConfigured: true, method: 'POST' }).allow,
      false,
      `${resource} must be denied even WITH a valid cron secret`,
    );
  }
});

// --- HiveLogic Monitor desktop agent (2026-08-16) ---------------------------
// Bug: screen monitoring stopped working company-wide the day this guard
// shipped (2026-08-01). The desktop agent authenticates with its own hashed
// bearer token and posts to four ?resource= values on /api/track1, none of
// which were allowlisted -- so every heartbeat, consent answer and screenshot
// upload was refused at the edge before reaching a handler that would have
// honoured the credential it was already carrying. The '/api/agents/' prefix
// entry looked like it covered this, but that is the unrelated automation-agent
// surface. Confirmed in production: Chris was clocked in with
// monitoring_enabled = true, agent last_seen_at frozen at 2026-08-02.
const MONITOR_AGENT_RESOURCES = [
  'monitor_pair',
  'monitor_heartbeat',
  'monitor_consent',
  'monitor_screenshot_upload',
];

test('the Monitor desktop agent can reach its four endpoints without a Supabase session', () => {
  for (const resource of MONITOR_AGENT_RESOURCES) {
    const sp = () => new URLSearchParams({ resource });
    assert.equal(
      isPublicResourcePath('/api/track1', sp(), 'POST'), true,
      `${resource} must be reachable by the agent, which holds no user JWT`,
    );
    const d = decideAccess({
      pathname: '/api/track1', searchParams: sp(),
      hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST',
    });
    assert.equal(d.allow, true, `${resource} must not be 401'd at the edge`);
    assert.equal(d.reason, 'public-resource-allowlist');
  }
});

test('the Monitor agent resources are POST-only -- never a GET door onto track1', () => {
  for (const resource of MONITOR_AGENT_RESOURCES) {
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(
        isPublicResourcePath('/api/track1', new URLSearchParams({ resource }), m), false,
        `${resource} must not be public on ${m}`,
      );
      assert.equal(
        decideAccess({
          pathname: '/api/track1', searchParams: new URLSearchParams({ resource }),
          hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: m,
        }).allow,
        false,
        `${resource} ${m} must still be denied`,
      );
    }
  }
});

test('opening the agent resources did not open track1 generally, or its monitor admin surface', () => {
  // These four are the browser/admin side of monitoring: they are read with a
  // real signed-in session and must stay session-only. monitor_prune is the
  // cron-only retention job -- it must not have become public here either.
  for (const resource of [
    'monitor_my_status',      // the browser poll behind the rolodex Monitor tab
    'monitor_review',         // company roster + screenshots (admin view)
    'monitor_settings',       // screenshot interval / blur / per-user toggles
    'monitor_user_toggle',    // turning monitoring off for a person
    'monitor_pairing_code',   // issues a pairing code -- signed-in employee only
    'monitor_prune',
  ]) {
    for (const m of ['GET', 'POST']) {
      assert.equal(
        isPublicResourcePath('/api/track1', new URLSearchParams({ resource }), m), false,
        `${resource} must not be publicly reachable (${m})`,
      );
    }
    assert.equal(
      decideAccess({
        pathname: '/api/track1', searchParams: new URLSearchParams({ resource }),
        hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST',
      }).allow,
      false,
      `${resource} must require a session`,
    );
  }
  // And a near-miss resource name must not slip through the exact-match check.
  assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams({ resource: 'monitor_heartbeats' }), 'POST'), false);
  // The whole endpoint is still not public.
  assert.equal(isPublicApiPath('/api/track1'), false);
});

test('the /api/agents/ prefix is the automation surface, and does not cover the Monitor agent', () => {
  // Regression guard on the comment that caused this bug: if someone ever
  // "simplifies" the Monitor agent onto /api/agents/, these must be revisited
  // together rather than one silently covering for the other.
  assert.equal(isPublicApiPath('/api/agents/enrollment'), true);
  assert.equal(isPublicApiPath('/api/agents/control'), true);
  assert.equal(isPublicApiPath('/api/track1'), false);
});

// --- BOTH gates, not one (2026-08-16) --------------------------------------
// The edge allowlist above was necessary and NOT sufficient. api/track1.js has
// its own belt-and-braces requireApiAuth check, and requireApiAuth only knows
// how to verify a Supabase JWT -- it sends whatever bearer it is given to
// /auth/v1/user. The Monitor agent's token is not a Supabase JWT, so that
// returns 403 and the handler 401s the agent with "Not signed in".
//
// Result: monitoring stayed dead AFTER the edge was opened. Chris's tray read
// "HiveLogic Monitor — Heartbeat error" and production showed 403s on
// /auth/v1/user every ~30 seconds -- the agent knocking, and being refused one
// layer further in. The same trap had already caught the browser-close beacon
// hours earlier, in the very same block of code.
//
// These tests fail if EITHER gate is closed against the agent.

import { MONITOR_AGENT_RESOURCES as HANDLER_EXEMPT } from '../api/track1.js';

// Full picture: every resource track1.js exempts from its own handler-level
// gate, paired with the ONE HTTP method the edge allows it on. Originally
// every entry here was POST-only (the agent's four write actions); Phase 5
// (2026-08-25) added a GET-only agent read (monitor_app_rules, so the agent
// can fetch the app whitelist to classify locally) -- hence a method map
// instead of a flat "everything is POST" assumption.
const HANDLER_EXEMPT_METHODS = {
  monitor_pair: 'POST',
  monitor_heartbeat: 'POST',
  monitor_consent: 'POST',
  monitor_screenshot_upload: 'POST',
  monitor_app_rules: 'GET',
  monitor_going_offline: 'POST',
};

test('the Monitor agent resource list matches what the guard allowlists', () => {
  // The handler's exemption list and this file's own list of agent resources
  // must describe the same set -- if they drift, one gate closes silently.
  assert.deepEqual(
    [...HANDLER_EXEMPT].sort(), Object.keys(HANDLER_EXEMPT_METHODS).sort(),
    'track1 MONITOR_AGENT_RESOURCES must cover exactly the agent routes this suite guards',
  );
  for (const resource of HANDLER_EXEMPT) {
    const method = HANDLER_EXEMPT_METHODS[resource];
    assert.equal(
      isPublicResourcePath('/api/track1', new URLSearchParams({ resource }), method), true,
      `${resource} is exempt from track1's handler gate but not from the edge on ${method} -- the agent still cannot reach it`,
    );
  }
  // And the reverse: nothing is allowlisted at the edge as a monitor_* agent
  // route without also being in the handler's exemption list.
  for (const resource of Object.keys(HANDLER_EXEMPT_METHODS)) {
    assert.ok(
      HANDLER_EXEMPT.includes(resource),
      `${resource} is public at the edge but would be re-blocked by requireApiAuth`,
    );
  }
});

test('each agent exemption is public on exactly its one method, nowhere else', () => {
  for (const resource of HANDLER_EXEMPT) {
    const allowedMethod = HANDLER_EXEMPT_METHODS[resource];
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(
        isPublicResourcePath('/api/track1', new URLSearchParams({ resource }), m), m === allowedMethod,
        `${resource} on ${m}: expected public=${m === allowedMethod}`,
      );
    }
  }
});

test('the browser-close beacon is exempt on both layers too', () => {
  // The other caller that carries a non-Supabase-header credential. Pinned
  // here so the pair are maintained together.
  assert.equal(
    isPublicResourcePath('/api/track1', new URLSearchParams({ resource: 'workforce_auto_clockout' }), 'POST'), true,
  );
});

// --- the customer card payment link -----------------------------------------
//
// A tech raises a T&M invoice; the customer gets /pay/?t=<token>, and that page
// makes exactly one call: GET /api/fieldops?action=tm_pay_init&t=...
//
// The customer has no HiveLogic account, so no session can exist. '/api/fieldops'
// is deliberately NOT prefix-public (asserted above, and correctly -- its other
// actions read visits, crews and billing). So the pay link 401'd at the edge and
// the page told the customer the link was no longer active. Every card payment
// link the techs sent was dead.
//
// The fix is the narrow resource-pair mechanism, so these tests care as much
// about what stayed shut as about what opened.

test('a customer with no session can reach the payment link, and only that', () => {
  const pay = decideAccess({
    pathname: '/api/fieldops',
    searchParams: new URLSearchParams('action=tm_pay_init&t=abc'),
    hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET',
  });
  assert.equal(pay.allow, true, 'the payment link must survive an edge with no session');
  assert.equal(pay.reason, 'public-resource-allowlist');
});

test('opening the payment link did not open the rest of fieldops', () => {
  const denied = (qs, method = 'GET') => decideAccess({
    pathname: '/api/fieldops',
    searchParams: new URLSearchParams(qs),
    hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method,
  });
  // Sibling actions on the same path read visits, crews and billing.
  for (const qs of ['action=travel_start', 'action=tm_invoice_create', 'action=visit_context', '']) {
    assert.equal(denied(qs).allow, false, `fieldops ${qs || '(no action)'} must still require a session`);
  }
  // Pinned to GET: the entry must not become a POST door onto the same path.
  assert.equal(denied('action=tm_pay_init', 'POST').allow, false, 'tm_pay_init is GET-only');
  // And the whole path must still not be prefix-public.
  assert.equal(isPublicApiPath('/api/fieldops'), false, 'fieldops must never be blanket-public');
});

test('an action-keyed entry does not make ?resource= a second way in', () => {
  // The matcher now reads ?action= for this entry. It must not also accept the
  // same value under ?resource=, or every path in the list gains an alias.
  const viaResource = decideAccess({
    pathname: '/api/fieldops',
    searchParams: new URLSearchParams('resource=tm_pay_init'),
    hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET',
  });
  assert.equal(viaResource.allow, false, 'the entry is keyed on ?action=, not ?resource=');
  // And the reverse: existing ?resource= entries must not start accepting ?action=.
  const monitorViaAction = decideAccess({
    pathname: '/api/track1',
    searchParams: new URLSearchParams('action=monitor_heartbeat'),
    hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST',
  });
  assert.equal(monitorViaAction.allow, false, 'track1 entries stay keyed on ?resource=');
});

test('every existing resource-pair entry still matches after the param change', () => {
  // The default must remain 'resource', or the change silently shuts four
  // Monitor-agent endpoints and the clock-out beacon.
  for (const r of ['monitor_pair', 'monitor_heartbeat', 'monitor_consent', 'monitor_screenshot_upload', 'workforce_auto_clockout']) {
    const d = decideAccess({
      pathname: '/api/track1',
      searchParams: new URLSearchParams('resource=' + r),
      hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST',
    });
    assert.equal(d.allow, true, `${r} must still be reachable`);
  }
});
