// test/jobber-delete-quote.test.mjs
// jomell, 2026-08-25: after building a real hard delete for native
// estimates, asked for the same ability across the whole Estimates list --
// including "real:" rows, which are actually quotes synced from the live
// Jobber account (Converted 456 / Archived 524 in the tab counts). Confirmed
// this includes real business quote history, not test data, and chose to
// build the delete anyway.
//
// api/jobber/delete-quote.js only ever deletes HiveLogic's own mirror row --
// the `quotes` table is a one-way, read-only sync target
// (api/jobber/sync-extended.js upserts by jobber_id daily, never deletes),
// so this can never touch Jobber itself. What these tests pin:
//   - a trusted actor is required
//   - the delete targets the row by its jobber_id
//   - a missing id is refused
//   - the route stays POST-only
//
// Run with: node --experimental-test-module-mocks --test test/jobber-delete-quote.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let deleteCalls;
let deleteShouldFail;
let actorResult;

mock.module('../api/bookkeeping/purchase-orders/_actor.js', {
  namedExports: {
    getTrustedActor: async () => actorResult,
  },
});

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts) => {
      deleteCalls.push({ path, opts });
      if (deleteShouldFail) return { ok: false, text: async () => 'db error deleting quote' };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

const handler = (await import('../api/jobber/delete-quote.js')).default;

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  deleteCalls = [];
  deleteShouldFail = false;
  actorResult = { id: 'user-1', companyId: 'greenwich-handyman', role: 'controller' };
}

async function del(id = 'X123') {
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { id } }, r);
  return r;
}

test('deletes the quote row by its jobber_id', async () => {
  reset();
  const r = await del();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(deleteCalls.length, 1);
  assert.match(deleteCalls[0].path, /^quotes\?jobber_id=eq\.X123$/);
  assert.match(deleteCalls[0].opts.method, /DELETE/);
});

test('an unauthenticated request is refused, and nothing is deleted', async () => {
  reset();
  actorResult = null;
  const r = await del();
  assert.equal(r.statusCode, 401);
  assert.equal(deleteCalls.length, 0);
});

test('a missing quote id is refused', async () => {
  reset();
  const r = res();
  await handler({ method: 'POST', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 422);
  assert.equal(deleteCalls.length, 0);
});

test('a database failure surfaces as an error, not a crash', async () => {
  reset();
  deleteShouldFail = true;
  const r = await del();
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
});

test('the route stays POST-only', async () => {
  reset();
  const r = res();
  await handler({ method: 'GET', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 405);
  assert.equal(deleteCalls.length, 0);
});
