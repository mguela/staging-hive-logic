// test/estimate-delete-converted.test.mjs
// jomell, 2026-08-25: "i want to delete the ones in the converted tab," then
// "i just want to have the ability/button to delete these" (of any status).
// Told explicitly first that converting an estimate creates a real row in
// the `jobs` table (the same one the crew board/scheduling reads), that
// staging shares the live production Supabase database, and that no code
// anywhere deletes a job today. Given the choice between a reversible
// archive and a real hard delete (via AskUserQuestion), chose real hard
// delete -- for any estimate, not just converted ones.
//
// api/bookkeeping/estimates/delete.js is the one deliberate exception to
// this codebase's "never a silent delete" rule (see cancel.js).
//
// What these tests pin:
//   - any estimate can be deleted this way, regardless of status
//   - a job is only deleted (and only attempted) when the estimate is
//     actually converted -- earlier statuses never had one
//   - any invoices raised from that job are deleted first (2026-08-26:
//     jobs.uuid_id carries a real FK from invoices.job_uuid --
//     fk_invoices_job_uuid -- so the job delete fails with a foreign-key
//     violation the moment even one invoice was ever raised from it)
//   - the job is deleted before the estimate (so a failed job delete never
//     leaves the estimate gone with the job still there)
//   - if either delete fails, everything after it is left untouched, so it
//     can be retried
//   - the delete is scoped to the actor's own company's job row
//
// Run with: node --experimental-test-module-mocks --test test/estimate-delete-converted.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ENABLED = 'true';

let estimateFixture;
let deletedEstimateIds;
let deleteEstimateShouldThrow;
let calls;
let jobLookupFixture;
let jobLookupShouldFail;
let invoiceDeleteFixture;
let invoiceDeleteShouldFail;
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
    supabaseRequest: async (path, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ path: String(path), opts });
      if (String(path).startsWith('invoices')) {
        if (invoiceDeleteShouldFail) return { ok: false, text: async () => 'db error deleting invoices' };
        return { ok: true, json: async () => invoiceDeleteFixture };
      }
      if (String(path).startsWith('jobs')) {
        if (method === 'DELETE') {
          if (jobDeleteShouldFail) return { ok: false, text: async () => 'db error deleting job' };
          return { ok: true, json: async () => [] };
        }
        if (jobLookupShouldFail) return { ok: false, text: async () => 'db error looking up job' };
        return { ok: true, json: async () => jobLookupFixture };
      }
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
  calls = [];
  jobLookupFixture = [{ uuid_id: 'job-uuid-1' }];
  jobLookupShouldFail = false;
  invoiceDeleteFixture = [];
  invoiceDeleteShouldFail = false;
  jobDeleteShouldFail = false;
}

async function del(id = 'est-uuid-1') {
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { id } }, r);
  return r;
}

function jobDeleteCalls() {
  return calls.filter((c) => c.path.startsWith('jobs') && (c.opts.method || 'GET') === 'DELETE');
}
function jobLookupCalls() {
  return calls.filter((c) => c.path.startsWith('jobs') && (c.opts.method || 'GET') !== 'DELETE');
}
function invoiceDeleteCalls() {
  return calls.filter((c) => c.path.startsWith('invoices'));
}

test('deletes the job\'s invoices, the job, and the estimate, in that order', async () => {
  reset();
  const r = await del();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(jobLookupCalls().length, 1, 'the job must be looked up first, to get its uuid_id');
  assert.equal(invoiceDeleteCalls().length, 1, 'invoices raised from the job must be deleted');
  assert.equal(jobDeleteCalls().length, 1, 'the job must be deleted');
  assert.equal(deletedEstimateIds.length, 1, 'the estimate must be deleted');
  assert.ok(calls[0].path.startsWith('jobs') && (calls[0].opts.method || 'GET') !== 'DELETE', 'lookup runs first');
  assert.ok(calls[1].path.startsWith('invoices'), 'invoice delete runs second');
  assert.ok(calls[2].path.startsWith('jobs') && calls[2].opts.method === 'DELETE', 'job delete runs last, after its invoices are gone');
});

test('invoice deletion is scoped to this job\'s uuid_id -- the exact column the FK is on', async () => {
  reset();
  await del();
  assert.match(invoiceDeleteCalls()[0].path, /invoices\?job_uuid=eq\.job-uuid-1/);
});

test('the job delete is scoped to the actor\'s own company and this estimate', async () => {
  reset();
  await del();
  assert.match(jobDeleteCalls()[0].path, /company_id=eq\.company-uuid-1/);
  assert.match(jobDeleteCalls()[0].path, /source_estimate_id=eq\.est-uuid-1/);
});

test('a non-converted estimate is deleted too, but without touching jobs or invoices at all', async () => {
  reset();
  estimateFixture.lifecycleStatus = 'approved';
  const r = await del();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(calls.length, 0, 'an approved estimate never had a job to look up, let alone delete');
  assert.equal(deletedEstimateIds.length, 1);
  assert.doesNotMatch(r.body.note, /job/i, 'the note must not claim a job was deleted when none existed');
});

test('a converted estimate whose job row is somehow already gone deletes cleanly, touching neither invoices nor a job', async () => {
  reset();
  jobLookupFixture = [];
  const r = await del();
  assert.equal(r.statusCode, 200);
  assert.equal(invoiceDeleteCalls().length, 0);
  assert.equal(jobDeleteCalls().length, 0);
  assert.equal(deletedEstimateIds.length, 1);
});

test('if the invoice delete fails, neither the job nor the estimate is deleted', async () => {
  reset();
  invoiceDeleteShouldFail = true;
  const r = await del();
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /invoices/i);
  assert.equal(jobDeleteCalls().length, 0, 'must not attempt the job delete while its invoices still block it');
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

test('the success note mentions how many invoices went with the job', async () => {
  reset();
  invoiceDeleteFixture = [{ jobber_id: 'HL-INV-1' }, { jobber_id: 'HL-INV-2' }];
  const r = await del();
  assert.match(r.body.note, /2 invoices raised from it/);
});

test('the success note says nothing about invoices when there were none', async () => {
  reset();
  invoiceDeleteFixture = [];
  const r = await del();
  assert.doesNotMatch(r.body.note, /invoice/i);
});

test('if the estimate delete itself fails after the job is gone, the error surfaces instead of crashing', async () => {
  reset();
  deleteEstimateShouldThrow = true;
  const r = await del();
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
  assert.equal(jobDeleteCalls().length, 1, 'the job delete still ran');
});

test('a missing estimate id is refused', async () => {
  reset();
  const r = res();
  await handler({ method: 'POST', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 422);
  assert.equal(calls.length, 0);
});

test('an estimate that does not exist is refused', async () => {
  reset();
  estimateFixture = null;
  const r = await del('nonexistent');
  assert.equal(r.statusCode, 404);
  assert.equal(calls.length, 0);
});

test('the route stays POST-only', async () => {
  reset();
  const r = res();
  await handler({ method: 'GET', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 405);
  assert.equal(calls.length, 0);
});
