// test/estimate-delete-converted.test.mjs
// jomell, 2026-08-25: "i want to delete the ones in the converted tab." Told
// explicitly first that converting an estimate creates a real row in the
// `jobs` table (the same one the crew board/scheduling reads), that staging
// shares the live production Supabase database, and that no code anywhere
// deletes a job today. Given the choice between a reversible archive and a
// real hard delete (via AskUserQuestion), chose real hard delete.
//
// api/bookkeeping/estimates/delete.js is the one deliberate exception to
// this codebase's "never a silent delete" rule (see cancel.js) -- scoped to
// 'converted' only, since every earlier lifecycle state already has a safe,
// reversible path (reject.js / cancel.js).
//
// What these tests pin:
//   - only a converted estimate can be deleted this way
//   - the job is deleted before the estimate (so a failed job delete never
//     leaves the estimate gone with the job still there)
//   - if the job delete fails, the estimate is left untouched, so it can be
//     retried
//   - the delete is scoped to the actor's own company's job row
//
// Run with: node --experimental-test-module-mocks --test test/estimate-delete-converted.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ENABLED = 'true';

let estimateFixture;
let deletedEstimateIds;
let deleteEstimateShouldThrow;
let jobDeleteCalls;
let jobDeleteShouldFail;

mock.module('../api/bookkeeping/estimates/_store.js', {
  namedExports: {
    getEstimate: async () => estimateFixture,
    deleteEstimate: async (_companyId, id) => {
      if (deleteEstimateShouldThrow) throw new Error('database unavailable');
      deletedEstimateIds.push(id);
    },
  },
});

mock.module('../api/bookkeeping/purchase-orders/_actor.js', {
  namedExports: {
    getTrustedActor: async () => ({ id: 'user-1', companyId: 'greenwich-handyman', role: 'controller' }),
  },
});

mock.module('../api/_lib/native-job.js', {
  namedExports: {
    resolveCompanyUuid: async () => 'company-uuid-1',
  },
});

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts) => {
      jobDeleteCalls.push({ path, opts });
      if (jobDeleteShouldFail) return { ok: false, text: async () => 'db error deleting job' };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

const handler = (await import('../api/bookkeeping/estimates/delete.js')).default;

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  estimateFixture = {
    id: 'est-uuid-1',
    estimateNumber: 'E-10007',
    companyId: 'greenwich-handyman',
    lifecycleStatus: 'converted',
    convertedJobId: 'J-10007',
  };
  deletedEstimateIds = [];
  deleteEstimateShouldThrow = false;
  jobDeleteCalls = [];
  jobDeleteShouldFail = false;
}

async function del(id = 'est-uuid-1') {
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { id } }, r);
  return r;
}

test('deletes both the job and the estimate for a converted estimate', async () => {
  reset();
  const r = await del();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(jobDeleteCalls.length, 1, 'the job must be deleted');
  assert.equal(deletedEstimateIds.length, 1, 'the estimate must be deleted');
  assert.match(jobDeleteCalls[0].opts.method, /DELETE/);
});

test('the job delete is scoped to the actor\'s own company and this estimate', () => {
  return (async () => {
    reset();
    await del();
    assert.match(jobDeleteCalls[0].path, /company_id=eq\.company-uuid-1/);
    assert.match(jobDeleteCalls[0].path, /source_estimate_id=eq\.est-uuid-1/);
  })();
});

test('a non-converted estimate is refused', async () => {
  reset();
  estimateFixture.lifecycleStatus = 'approved';
  const r = await del();
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.ok, false);
  assert.equal(jobDeleteCalls.length, 0, 'nothing must be deleted when the status guard fails');
  assert.equal(deletedEstimateIds.length, 0);
});

test('if the job delete fails, the estimate is left untouched so it can be retried', async () => {
  reset();
  jobDeleteShouldFail = true;
  const r = await del();
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
  assert.equal(deletedEstimateIds.length, 0, 'the estimate must survive a failed job delete');
});

test('if the estimate delete itself fails after the job is gone, the error surfaces instead of crashing', async () => {
  reset();
  deleteEstimateShouldThrow = true;
  const r = await del();
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
  assert.equal(jobDeleteCalls.length, 1, 'the job delete still ran');
});

test('a missing estimate id is refused', async () => {
  reset();
  const r = res();
  await handler({ method: 'POST', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 422);
  assert.equal(jobDeleteCalls.length, 0);
});

test('an estimate that does not exist is refused', async () => {
  reset();
  estimateFixture = null;
  const r = await del('nonexistent');
  assert.equal(r.statusCode, 404);
  assert.equal(jobDeleteCalls.length, 0);
});

test('the route stays POST-only', async () => {
  reset();
  const r = res();
  await handler({ method: 'GET', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 405);
  assert.equal(jobDeleteCalls.length, 0);
});
