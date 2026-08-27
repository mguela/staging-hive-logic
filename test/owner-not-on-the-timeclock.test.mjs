// test/owner-not-on-the-timeclock.test.mjs
//
// Owners are not on the timeclock.
//
// Chris, 2026-08-18: "If it's an Owner, Rich or I, we'll likely never clock in
// and we'll never want to be monitored" -- then, asked who specifically:
// "forget us, think production ready product. the owner is classified by role
// designated in user setup and company setup."
//
// NOT A NEW ROLE, deliberately. employee_roles.permission_roles already carries
// 'owner' beside design_sales, office_manager and the rest, already populated
// from user setup -- Chris Kendall and Lori Kendall hold it. Adding a fourth
// value to profiles.role ('crew'/'admin'/'superadmin') would have meant editing
// every one of the ~20 gates reading `role === 'admin' || role === 'superadmin'`
// and would have locked an owner out of their own app if a single one were
// missed. The concept existed; this gives it teeth.
//
// ONE RULE, three consequences. Monitoring only ever runs during a clock-in, so
// "owners do not clock in" already means no consent prompt, no recording, and
// no idle timeout. Enforcing those separately would be three things to remember
// instead of one.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { isOwner, OWNER_PERMISSION_ROLE, OWNER_NO_CLOCK_IN_MESSAGE } =
  await import('../api/_lib/owner.js');

test('an owner is whoever holds the owner permission role', async () => {
  assert.equal(await isOwner({ email: 'a@b.c' }, ['owner']), true);
  assert.equal(await isOwner({ email: 'a@b.c' }, ['owner', 'design_sales']), true,
    'Chris holds owner alongside design_sales -- a second role must not cancel the first');
  assert.equal(await isOwner({ email: 'a@b.c' }, ['design_sales']), false);
  assert.equal(await isOwner({ email: 'a@b.c' }, []), false);
});

test('a missing or malformed answer is not an owner', async () => {
  // Failing open here would take someone off the timeclock by accident, which
  // silently stops recording their hours.
  assert.equal(await isOwner(null, ['owner']), false);
  assert.equal(await isOwner(undefined, ['owner']), false);
  assert.equal(await isOwner({ email: 'a@b.c' }, 'owner'), false, 'a bare string is not the roles list');
});

test('the owner role is a permission role, not a fourth login role', () => {
  assert.equal(OWNER_PERMISSION_ROLE, 'owner');
  const src = fs.readFileSync('api/_lib/owner.js', 'utf8');
  assert.match(src, /getPermissionRoles/, 'it must read the roles user setup already writes');
  // If someone later adds 'owner' to the coarse login role, every
  // `role === 'admin' || role === 'superadmin'` gate silently stops matching
  // the owner -- which locks them out of their own app.
  const track = fs.readFileSync('api/track1.js', 'utf8');
  assert.doesNotMatch(track, /\['superadmin', 'admin', 'crew', 'owner'\]/,
    'owner must not become a profiles.role value without auditing every role gate');
});

// --- The rule is enforced where it can be relied on ------------------------

test('the clock-in is refused by the server, not merely hidden in the page', () => {
  // The End-of-Day exemption was frontend-only once (Chris, 2026-08-16) and
  // produced a clock-out that could neither be completed nor satisfied: the
  // server refused it from a branch that had never heard of the exemption.
  const src = fs.readFileSync('api/track1.js', 'utf8');
  const clockIn = src.slice(src.indexOf("if (action === 'in') {"));
  const refusal = clockIn.indexOf('if (await isOwner(requester))');
  const insert = clockIn.indexOf("supabaseRequest('workforce_time_sessions'");
  assert.ok(refusal > -1, 'the clock-in must check');
  assert.ok(refusal < insert, 'and it must refuse BEFORE opening a session');
  assert.match(clockIn.slice(refusal, refusal + 300), /OWNER_NO_CLOCK_IN_MESSAGE/,
    'and say the same thing the UI says, from one source');
});

test('the page is told who the owner is instead of working it out', () => {
  const src = fs.readFileSync('api/track1.js', 'utf8');
  // requesterIsOwner (2026-08-26) is computed once via isOwner(requester)
  // and reused for both isOwner and canViewScreenshots -- the assertion
  // below follows that, not the literal call site.
  assert.match(src, /const requesterIsOwner = await isOwner\(requester\);/,
    'workforce_status must ask the real isOwner(), not decide on its own');
  assert.match(src, /isOwner: requesterIsOwner,/,
    'workforce_status must carry it, so the hidden button and the refused request agree');
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.match(html, /isOwner = !!\(data && data\.isOwner\);/);
});

test('ownership is never DECIDED by a hardcoded email', () => {
  // It could only ever be true of one person, and would have quietly stopped
  // being true the day ownership changed.
  //
  // Scoped to comparisons, not mentions: the page also contains the address as
  // display copy in the phone-directory and inbox mockups, which decides
  // nothing. A test that failed on those would either be switched off or
  // routed around, and then it would be guarding nothing.
  const compares = /chris@ghgrp\.net[^\n]{0,40}(===|!==|==)|(===|!==|==)[^\n]{0,40}chris@ghgrp\.net|(includes|indexOf|startsWith)\([^)\n]*chris@ghgrp\.net/;
  for (const f of ['api/track1.js', 'public/index.html']) {
    const src = fs.readFileSync(f, 'utf8');
    const live = src.split('\n').filter((l) => compares.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    assert.deepEqual(live, [], `${f} still decides ownership by email:\n${live.join('\n')}`);
  }
});

test('an owner is not nagged to clock in, and is told why the button is gone', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.match(html, /if \(window\.hlWorkforceIsOwner && window\.hlWorkforceIsOwner\(\)\) return;/,
    'the daily prompt must skip owners rather than point them at a refusal');
  assert.match(html, /Owner account — not on the timeclock\./,
    'a button that vanishes with no reason reads as a bug');
});

test('the owner rule carries the monitoring consequence, rather than repeating it', () => {
  // If someone later "fixes" this by also special-casing owners in the consent
  // path, the two rules can drift. The comment is the guard.
  const src = fs.readFileSync('api/_lib/owner.js', 'utf8');
  assert.match(src, /monitoring only ever runs during a clock-in/i,
    'why one rule is enough has to be written down, or it grows three more');
  assert.match(OWNER_NO_CLOCK_IN_MESSAGE, /not on the timeclock/i);
});
