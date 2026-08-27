// test/native-job-create.test.mjs
// Phase 0, item 2 (2026-08-17) — a job HiveLogic owns, created properly.
//
// createNativeJob replaced three defects that were live in create_job:
//   1. no project number at all
//   2. the client stored only as a text reference, never as jobs.client_uuid,
//      so a native job was invisible to anything joining on the client
//   3. the division appended to the job TITLE as text --
//      "Kitchen remodel [GH Design|Build]" -- so it could not be grouped,
//      filtered or costed by division
//
// Each of those has a test here, because each was easy to reintroduce.
// Fully stubbed -- no network, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNativeJob, resolveCompanyUuid, resolveDivisionCode, resolveClientUuid } from '../api/_lib/native-job.js';

const COMPANY_UUID = '82cf7354-e460-4863-9f01-d67b3ad05d4a';

const DIVISIONS = [
  { code: 'GH-DB', name: 'GH Co. Design|Build' },
  { code: 'GH-EL', name: 'GH Electric' },
  { code: 'GH-FN', name: 'Greenwich Handyman' },
];

// A stub that answers the three reads/writes createNativeJob makes, and records
// the row it was asked to insert.
function stub({ clientUuid = 'client-uuid-1', insertFails = null } = {}) {
  const state = { inserted: null, allocations: 0 };
  const sb = async (path, opts = {}) => {
    if (path.startsWith('org_units')) {
      return { ok: true, json: async () => DIVISIONS };
    }
    if (path.startsWith('clients')) {
      return { ok: true, json: async () => (clientUuid ? [{ uuid_id: clientUuid }] : []) };
    }
    if (path.startsWith('companies')) {
      return { ok: true, json: async () => [{ id: COMPANY_UUID }] };
    }
    if (path === 'rpc/allocate_project_number') {
      state.allocations += 1;
      return { ok: true, json: async () => [{ sequence_no: 10007 }] };
    }
    if (path === 'jobs') {
      state.inserted = JSON.parse(opts.body);
      if (insertFails) return { ok: false, text: async () => insertFails };
      return { ok: true, json: async () => [{ ...state.inserted, uuid_id: 'job-uuid-1' }] };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { deps: { supabaseRequest: sb }, state };
}

const BASE = { companyId: 'greenwich-handyman', title: 'Kitchen remodel' };

// ------------------------------------------------- defect 1: the number

test('a new job gets a project number', async () => {
  const { deps, state } = stub();
  const result = await createNativeJob(BASE, deps);
  assert.equal(result.projectSeq, 10007);
  assert.equal(result.jobRef, 'J-10007');
  assert.equal(state.inserted.project_seq, 10007);
});

test('a job converted from an estimate REUSES that estimate\'s number', async () => {
  // This is the whole point of the scheme: E-10001 becomes J-10001. Allocating
  // a fresh number here would give one project two identities.
  const { deps, state } = stub();
  const result = await createNativeJob({ ...BASE, projectSeq: 10001 }, deps);
  assert.equal(result.jobRef, 'J-10001');
  assert.equal(state.inserted.project_seq, 10001);
  assert.equal(state.allocations, 0, 'must not burn a new number');
});

test('project_seq is kept apart from Jobber\'s job_number', async () => {
  // 2,775 synced jobs use job_number (1-2999). Writing to it here would make
  // "which system numbered this?" unanswerable.
  const { deps, state } = stub();
  await createNativeJob(BASE, deps);
  assert.ok(!('job_number' in state.inserted), 'must not write Jobber\'s numbering column');
});

test('the native job stores the actor company explicitly, never a database default', async () => {
  const { deps, state } = stub();
  await createNativeJob(BASE, deps);
  assert.equal(state.inserted.company_id, COMPANY_UUID);
});

// 2026-08-26, jomell: "where is 'created' supposed to be set?" -- the
// Active Jobs modal's Created field reads jobber_created_at, which was
// only ever stamped by the Jobber sync. A native job never got one, so it
// always showed blank.
test('a native job is stamped with a created date, matching its updated date', async () => {
  const { deps, state } = stub();
  await createNativeJob(BASE, deps);
  assert.ok(state.inserted.jobber_created_at, 'Created must not be left blank for a native job');
  assert.equal(state.inserted.jobber_created_at, state.inserted.jobber_updated_at);
});

// ------------------------------------------------- defect 2: the client link

test('the client is linked internally, not just by text reference', async () => {
  const { deps, state } = stub({ clientUuid: 'abc-123' });
  await createNativeJob({ ...BASE, clientId: 'Z2lkOi8vSm9iYmVy' }, deps);
  assert.equal(state.inserted.client_id, 'Z2lkOi8vSm9iYmVy');
  assert.equal(state.inserted.client_uuid, 'abc-123',
    'jobs.client_uuid is the link the rest of the app joins on');
});

test('an unknown client does not sink the job', async () => {
  const { deps, state } = stub({ clientUuid: null });
  await createNativeJob({ ...BASE, clientId: 'missing' }, deps);
  assert.equal(state.inserted.client_uuid, null);
  assert.equal(state.inserted.client_id, 'missing', 'still linkable by text');
});

// ------------------------------------------------- defect 3: the division

test('the division is a real field, not glued onto the title', async () => {
  const { deps, state } = stub();
  await createNativeJob({ ...BASE, division: 'GH Electric' }, deps);
  assert.equal(state.inserted.division_code, 'GH-EL');
  assert.equal(state.inserted.title, 'Kitchen remodel',
    'the title must stay clean -- no "[GH Electric]" appended');
});

test('a division can be given by name or by code', async () => {
  for (const given of ['GH Electric', 'GH-EL', 'gh-el', 'gh electric']) {
    const { deps, state } = stub();
    await createNativeJob({ ...BASE, division: given }, deps);
    assert.equal(state.inserted.division_code, 'GH-EL', `for input ${given}`);
  }
});

test('an unrecognised division is refused, not silently dropped', async () => {
  // Dropping it would leave the job looking company-wide, which is worse than
  // an error -- it would quietly mis-cost the work.
  const { deps } = stub();
  await assert.rejects(
    () => createNativeJob({ ...BASE, division: 'GH Roofing' }, deps),
    /not one of this company's divisions/i,
  );
});

test('no division given is fine', async () => {
  const { deps, state } = stub();
  await createNativeJob(BASE, deps);
  assert.equal(state.inserted.division_code, null);
});

// ------------------------------------------------- guards

test('a duplicate project number is reported in words', async () => {
  const { deps } = stub({ insertFails: 'duplicate key value violates unique constraint "uq_jobs_project_seq"' });
  await assert.rejects(
    () => createNativeJob({ ...BASE, projectSeq: 10001 }, deps),
    (e) => {
      assert.equal(e.code, 'PROJECT_NUMBER_TAKEN');
      assert.match(e.message, /J-10001 already exists/);
      return true;
    },
  );
});

test('a job needs a title and a company', async () => {
  const { deps } = stub();
  await assert.rejects(() => createNativeJob({ companyId: 'gh', title: '   ' }, deps), /needs a title/i);
  await assert.rejects(() => createNativeJob({ title: 'x' }, deps), /needs a company/i);
});

test('a zero or negative total is stored as no total, not as zero', async () => {
  const { deps, state } = stub();
  await createNativeJob({ ...BASE, total: 0 }, deps);
  assert.equal(state.inserted.total, null);
});

// ------------------------------------------------- helpers directly

test('resolveDivisionCode returns null for nothing given', async () => {
  const { deps } = stub();
  assert.equal(await resolveDivisionCode('', deps), null);
  assert.equal(await resolveDivisionCode(null, deps), null);
});

test('resolveClientUuid returns null rather than throwing when the lookup fails', async () => {
  const deps = { supabaseRequest: async () => ({ ok: false, text: async () => 'boom' }) };
  assert.equal(await resolveClientUuid('anything', deps), null);
});

test('resolveCompanyUuid fails closed when a company slug is unknown', async () => {
  const deps = { supabaseRequest: async () => ({ ok: true, json: async () => [] }) };
  await assert.rejects(() => resolveCompanyUuid('not-a-company', deps), /does not exist/i);
});
