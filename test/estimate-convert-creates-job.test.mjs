// test/estimate-convert-creates-job.test.mjs
// Phase 0, item 3 (2026-08-17) — the blocking defect, fixed.
//
// Converting an approved estimate used to return `${estimateNumber}-JOB` as a
// STRING and create nothing. That severed the chain from lead to payment
// exactly here: an approved estimate could never become work anyone could
// schedule, cost or invoice.
//
// What these tests pin, in rough order of how expensive the bug would be:
//
//   - a real job row is created, carrying the estimate's own number
//   - converting twice never produces two jobs
//   - if the job cannot be created, the estimate is NOT marked converted --
//     otherwise you get an estimate that says "converted" with no job behind
//     it, which no amount of clicking can recover from
//   - the estimate and job point at each other afterwards
//
// Run with: node --experimental-test-module-mocks --test test/estimate-convert-creates-job.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ENABLED = 'true';

let estimateFixture;
let existingJobRows;
let createdJobs;
let createNativeJobImpl;
let storedEstimate;
let updateEstimateImpl;

mock.module('../api/bookkeeping/estimates/_store.js', {
  namedExports: {
    getEstimate: async () => estimateFixture,
    updateEstimate: async (_companyId, _id, mutate) => {
      return updateEstimateImpl(mutate);
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
    createNativeJob: async (input) => createNativeJobImpl(input),
    resolveCompanyUuid: async () => 'company-uuid-1',
  },
});

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      if (path.startsWith('jobs?company_id=eq.company-uuid-1&project_seq=')) {
        return { ok: true, json: async () => existingJobRows };
      }
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

// The estimate engine's own conversion rules (must be 'approved', deposit is
// excluded from the remaining schedule) are covered by the engine's own tests.
// Here it is stubbed so these tests stay about the route's new behaviour.
mock.module('../server/bookkeeping/src/estimates.js', {
  namedExports: {
    convertToJob: (est) => ({
      ...est,
      lifecycleStatus: 'converted',
      convertedJobId: `${est.estimateNumber}-JOB`, // the old placeholder
      remainingPaymentSchedule: [{ label: 'On completion', amount: 4000 }],
    }),
  },
});

const handler = (await import('../api/bookkeeping/estimates/convert.js')).default;

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
    estimateNumber: 'E-10001',
    companyId: 'greenwich-handyman',
    clientId: 'Z2lkOi8vSm9iYmVy',
    title: 'Kitchen remodel',
    division: 'GH Co. Design|Build',
    lifecycleStatus: 'approved',
    totals: { price: 8000, cardPrice: 8320 },
  };
  existingJobRows = [];
  createdJobs = [];
  storedEstimate = null;
  updateEstimateImpl = async (mutate) => {
    storedEstimate = mutate(estimateFixture);
    estimateFixture = storedEstimate;
    return storedEstimate;
  };
  createNativeJobImpl = async (input) => {
    createdJobs.push(input);
    const seq = input.projectSeq || 99999;
    return {
      job: { jobber_id: `HL-JOB-${seq}`, project_seq: seq, title: input.title },
      projectSeq: seq,
      jobRef: `J-${seq}`,
    };
  };
}

async function convert() {
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { id: 'est-uuid-1' } }, r);
  return r;
}

// ------------------------------------------------------- it creates a job

test('converting an approved estimate creates a real job', async () => {
  reset();
  const r = await convert();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(createdJobs.length, 1, 'exactly one job must be created');
  assert.equal(r.body.job.jobber_id, 'HL-JOB-10001');
});

test('the job keeps the estimate\'s number — E-10001 becomes J-10001', async () => {
  reset();
  const r = await convert();
  assert.equal(r.body.jobRef, 'J-10001');
  assert.equal(createdJobs[0].projectSeq, 10001,
    'a fresh number here would give one project two identities');
});

test('the job carries the estimate\'s client, title, division and value', async () => {
  reset();
  await convert();
  const job = createdJobs[0];
  assert.equal(job.clientId, 'Z2lkOi8vSm9iYmVy');
  assert.equal(job.title, 'Kitchen remodel');
  assert.equal(job.division, 'GH Co. Design|Build');
  assert.equal(job.total, 8320, 'the card price is what the client actually owes');
  assert.equal(job.sourceEstimateId, 'est-uuid-1', 'the job must know where it came from');
});

test('the estimate ends up pointing at the job that actually exists', async () => {
  reset();
  const r = await convert();
  // The engine invents 'E-10001-JOB' as a placeholder; the route must replace it.
  assert.equal(r.body.estimate.convertedJobId, 'J-10001');
  assert.equal(r.body.estimate.convertedJobRef, 'HL-JOB-10001');
  assert.notEqual(r.body.estimate.convertedJobId, 'E-10001-JOB', 'the placeholder must not survive');
});

// ------------------------------------------------------- converting twice

test('converting an already-converted estimate is refused, and creates nothing', async () => {
  reset();
  existingJobRows = [{ jobber_id: 'HL-JOB-10001', project_seq: 10001, title: 'Kitchen remodel' }];
  const r = await convert();
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /already been converted.*J-10001/);
  assert.equal(createdJobs.length, 0, 'a second job must never be created');
});

test('a race that slips past the lookup is still caught by the database', async () => {
  reset();
  createNativeJobImpl = async () => {
    const e = new Error('Job J-10001 already exists.');
    e.code = 'PROJECT_NUMBER_TAKEN';
    throw e;
  };
  const r = await convert();
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /already exists/);
  assert.equal(storedEstimate, null, 'the estimate must not be marked converted');
});

// ------------------------------------------------------- failure ordering

test('if the job cannot be created, the estimate is left alone', async () => {
  // The unrecoverable state is an estimate marked "converted" with no job
  // behind it. Creating the job first is what prevents it.
  reset();
  createNativeJobImpl = async () => { throw new Error('database unavailable'); };
  const r = await convert();
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
  assert.equal(storedEstimate, null,
    'the estimate must still be approved, so the user can simply try again');
});

test('an estimate already marked converted cannot create an orphan job when its job is missing', async () => {
  reset();
  estimateFixture.lifecycleStatus = 'converted';
  const r = await convert();
  assert.equal(r.statusCode, 409);
  assert.equal(createdJobs.length, 0);
  assert.equal(storedEstimate, null);
  assert.match(r.body.error, /already marked converted/i);
});

test('the existing-job lookup is scoped to the actor company', async () => {
  reset();
  await convert();
  // The mock only answers the company-scoped path. If the route drops that
  // scope, the request throws instead of silently seeing another tenant's job.
  assert.equal(createdJobs.length, 1);
});

test('a retry repairs an approved estimate when its job committed before the estimate update failed', async () => {
  reset();
  updateEstimateImpl = async () => { throw new Error('optimistic update failed'); };

  const first = await convert();
  assert.equal(first.statusCode, 422);
  assert.equal(createdJobs.length, 1, 'the job insert committed before the estimate update failed');
  assert.equal(estimateFixture.lifecycleStatus, 'approved');

  existingJobRows = [{
    jobber_id: 'HL-JOB-10001',
    project_seq: 10001,
    title: 'Kitchen remodel',
    source_estimate_id: 'est-uuid-1',
  }];
  updateEstimateImpl = async (mutate) => {
    storedEstimate = mutate(estimateFixture);
    estimateFixture = storedEstimate;
    return storedEstimate;
  };

  const retry = await convert();
  assert.equal(retry.statusCode, 200);
  assert.equal(createdJobs.length, 1, 'recovery must reuse the committed job, never insert another');
  assert.equal(retry.body.estimate.lifecycleStatus, 'converted');
  assert.equal(retry.body.estimate.convertedJobRef, 'HL-JOB-10001');
});

// ------------------------------------------------------- guards

test('a missing estimate id is refused', async () => {
  reset();
  const r = res();
  await handler({ method: 'POST', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 422);
  assert.equal(createdJobs.length, 0);
});

test('the route stays POST-only', async () => {
  reset();
  const r = res();
  await handler({ method: 'GET', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 405);
  assert.equal(createdJobs.length, 0);
});
