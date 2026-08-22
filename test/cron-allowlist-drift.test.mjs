// Every cron scheduled in vercel.json must be reachable through the edge guard.
//
// This is the test api/_lib/guard.js has cited by name since the 2026-08-15
// drift repair -- "test/cron-allowlist-drift.test.mjs fails CI if vercel.json
// and this list ever disagree again" -- but which did not actually exist. The
// comment was load-bearing documentation for a guarantee nothing enforced, so
// the very gap it describes could silently reopen. It is written here.
//
// The original failure it guards against: 10 of 29 scheduled crons were absent
// from the allowlist, so Vercel called them on schedule and the edge answered
// 401 every time. Nothing failed loudly -- the crons simply never ran, for
// weeks. A missing entry is invisible in exactly the way that matters.
//
// Direction matters both ways:
//   vercel.json -> guard   a scheduled cron the guard rejects never runs
//   guard -> vercel.json   an allowlisted path with no schedule is a door left
//                          open for no reason (reported, not failed -- some are
//                          invoked by external schedulers rather than Vercel)

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCronPath, decideAccess } from '../api/_lib/guard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

/** "/api/x?resource=y" -> { pathname, params } */
function splitCronPath(p) {
  const [pathname, query = ''] = String(p).split('?');
  return { pathname, params: new URLSearchParams(query) };
}

test('every cron in vercel.json is on the guard allowlist', () => {
  const crons = Array.isArray(vercel.crons) ? vercel.crons : [];
  assert.ok(crons.length > 0, 'vercel.json declares no crons -- this test would be vacuous');

  // The property is "the guard lets this through when Vercel calls it with a
  // valid CRON_SECRET" -- NOT "it appears on the cron list". Some scheduled
  // paths (/api/jobber/webhook) are reachable because they are on the PUBLIC
  // allowlist, since a webhook has to be callable by an outside service. Those
  // are not stranded, and asserting against the cron list alone reports them
  // as broken when they work fine.
  const stranded = [];
  for (const cron of crons) {
    const { pathname, params } = splitCronPath(cron.path);
    // Vercel Cron issues GET.
    const decision = decideAccess({
      pathname,
      searchParams: params,
      hasValidUser: false,
      hasValidCronSecret: true,
      cronSecretConfigured: true,
      method: 'GET',
    });
    if (!decision.allow) stranded.push(cron.path);
  }

  assert.deepEqual(
    stranded,
    [],
    `these crons are scheduled but the edge guard would 401 them, so they will never run:\n  ${stranded.join('\n  ')}`,
  );
});

test('the outbox processor specifically is reachable', () => {
  // Named explicitly rather than left to the sweep above: this one sends mail,
  // and a silent 401 would look identical to "nothing was due".
  const { pathname, params } = splitCronPath('/api/schedule/outbox?resource=process');
  assert.equal(isCronPath(pathname, params, 'GET'), true);
  // ...and is pinned to GET, so it cannot be reached as a write door.
  assert.equal(isCronPath(pathname, params, 'POST'), false);
});

test('the sweep is not vacuous -- an unlisted path is rejected', () => {
  // If isCronPath ever degraded to returning true for everything, the first
  // test would pass while enforcing nothing.
  const { pathname, params } = splitCronPath('/api/schedule/outbox?resource=not_a_real_resource');
  assert.equal(isCronPath(pathname, params, 'GET'), false);
  assert.equal(isCronPath('/api/definitely-not-a-cron', new URLSearchParams(), 'GET'), false);
});
