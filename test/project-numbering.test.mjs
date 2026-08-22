// test/project-numbering.test.mjs
// Phase 0, item 1 (2026-08-17) — one number for the life of a project.
//
// Chris's rule: E-10001 becomes J-10001, then CO-10001-1 and INV-10001-1, and
// the number NEVER changes. These tests pin the parts of that which are easy to
// break later without noticing:
//
//   - the shared sequence (estimate and job are the same project)
//   - division stays OUT of the project number, because divisions subcontract
//     to each other and a job's division can change
//   - invoices and change orders are numbered within their project, because
//     progress billing means one job carries several invoices
//   - allocation is atomic, so two people can't be handed the same number
//
// Pure formatting is tested directly; allocation is tested against a stubbed
// Supabase so no network or database is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  estimateRef, estimateRevisionRef, jobRef, changeOrderRef, invoiceRef,
  workOrderRef, projectRefs, parseProjectSequence, allocateProjectSequence,
  PROJECT_SEQUENCE_START,
} from '../api/_lib/project-numbers.js';

const securityRepairSql = fs.readFileSync(
  new URL('../supabase/migrations/20260817235251_project_numbering_security_repair.sql', import.meta.url),
  'utf8',
);

// ------------------------------------------------------------ the scheme

test('one project number carries across every document type', () => {
  const p = projectRefs(10001);
  assert.equal(p.estimate, 'E-10001');
  assert.equal(p.job, 'J-10001');
  assert.equal(p.changeOrder(1), 'CO-10001-1');
  assert.equal(p.invoice(1), 'INV-10001-1');
  assert.equal(p.sequence, 10001);
});

test('an estimate and the job it becomes share one number', () => {
  assert.equal(parseProjectSequence(estimateRef(10001)), parseProjectSequence(jobRef(10001)));
});

test('progress billing numbers invoices within the project', () => {
  // Deposit, draw, final on one job -- they cannot all be INV-10001.
  assert.equal(invoiceRef(10001, 1), 'INV-10001-1');
  assert.equal(invoiceRef(10001, 2), 'INV-10001-2');
  assert.equal(invoiceRef(10001, 3), 'INV-10001-3');
});

test('an estimate revision keeps the project number', () => {
  // Re-quoting at a different price is the same project. A new number here
  // would break "one number for the life of the project" at the first revision.
  assert.equal(estimateRevisionRef(10001, 1), 'E-10001');
  assert.equal(estimateRevisionRef(10001, 2), 'E-10001-R2');
  assert.equal(estimateRevisionRef(10001, 3), 'E-10001-R3');
});

// ------------------------------------------------------------ divisions

test('division never appears in the project number', () => {
  // Divisions subcontract to each other, so the owning division can change or
  // be shared. Baking it into the identifier would force a renumber.
  const p = projectRefs(10001);
  for (const ref of [p.estimate, p.job, p.changeOrder(1), p.invoice(1)]) {
    assert.doesNotMatch(ref, /EL|DB|PL|HV|OS|HC|FN|HM/,
      `${ref} must not carry a division code`);
  }
});

test('an internal work order hangs the division off the job number', () => {
  // GH Design|Build hiring GH Electric on J-10001: Electric's slice is
  // J-10001-EL. Internal only -- the client's chain stays with the owner.
  assert.equal(workOrderRef(10001, 'GH-EL'), 'J-10001-EL');
  assert.equal(workOrderRef(10001, 'GH-DB'), 'J-10001-DB');
  assert.equal(workOrderRef(10001, 'EL'), 'J-10001-EL', 'a bare code works too');
});

test('a work order still parses back to its parent project', () => {
  assert.equal(parseProjectSequence(workOrderRef(10001, 'GH-EL')), 10001);
});

test('a work order refuses a division it cannot express', () => {
  assert.throws(() => workOrderRef(10001, ''), /division/i);
  assert.throws(() => workOrderRef(10001, 'GH-ELECTRICAL-DIVISION'), /not a usable division/i);
});

// ------------------------------------------------------------ reading back

test('the project number can be read back out of any reference', () => {
  assert.equal(parseProjectSequence('E-10001'), 10001);
  assert.equal(parseProjectSequence('J-10001'), 10001);
  assert.equal(parseProjectSequence('CO-10001-2'), 10001);
  assert.equal(parseProjectSequence('INV-10001-3'), 10001);
  assert.equal(parseProjectSequence('e-10001'), 10001, 'case should not matter');
});

test('a Jobber reference carries no project number, and says so quietly', () => {
  // Callers hand this Jobber ids routinely; throwing would be wrong.
  assert.equal(parseProjectSequence('Z2lkOi8vSm9iYmVyL0pvYi8xMjM='), null);
  assert.equal(parseProjectSequence(''), null);
  assert.equal(parseProjectSequence(null), null);
  assert.equal(parseProjectSequence('2999'), null, 'a bare Jobber job number is not ours');
});

// ------------------------------------------------------------ bad input

test('a project number must be a real positive whole number', () => {
  for (const bad of [0, -1, 1.5, 'abc', null, undefined]) {
    assert.throws(() => jobRef(bad), /positive whole number/i, `jobRef(${JSON.stringify(bad)})`);
  }
});

test('change orders and invoices start at 1, not 0', () => {
  assert.throws(() => changeOrderRef(10001, 0), /1 or higher/i);
  assert.throws(() => invoiceRef(10001, 0), /1 or higher/i);
});

// ------------------------------------------------------------ allocation

function stubSb(handler) {
  return { supabaseRequest: handler };
}

test('allocation asks Postgres, so concurrent callers cannot collide', async () => {
  const calls = [];
  const seq = await allocateProjectSequence('greenwich-handyman', stubSb(async (path, opts) => {
    calls.push({ path, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => [{ sequence_no: 10004 }] };
  }));
  assert.equal(seq, 10004);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'rpc/allocate_project_number',
    'must go through the atomic allocator, never read-then-write the counter');
  assert.deepEqual(calls[0].body, { p_company_id: 'greenwich-handyman' });
});

test('allocation starts clear of Jobber\'s own numbering', () => {
  // Jobber runs 1-2999 and keeps climbing while both systems are live. Five
  // digits vs four is what stops "job 2999" and "J-10001" being confused.
  assert.ok(PROJECT_SEQUENCE_START > 2999,
    'the project counter must start above every Jobber job number');
  assert.equal(String(PROJECT_SEQUENCE_START).length, 5);
});

test('allocation refuses to guess a company', async () => {
  await assert.rejects(
    () => allocateProjectSequence('', stubSb(async () => ({ ok: true, json: async () => [] }))),
    /company is required/i,
  );
});

test('a failed allocation is reported, never silently numbered', async () => {
  await assert.rejects(
    () => allocateProjectSequence('gh', stubSb(async () => ({ ok: false, text: async () => 'relation does not exist' }))),
    /Could not allocate a project number/i,
  );
  await assert.rejects(
    () => allocateProjectSequence('gh', stubSb(async () => ({ ok: true, json: async () => [] }))),
    /returned nothing usable/i,
  );
});

test('the project counter and allocator are server-only', () => {
  assert.match(securityRepairSql, /alter table public\.project_counters enable row level security/i);
  assert.match(securityRepairSql, /revoke all on table public\.project_counters from PUBLIC, anon, authenticated/i);
  assert.match(securityRepairSql, /revoke all on function public\.allocate_project_number\(text\) from PUBLIC, anon, authenticated/i);
  assert.match(securityRepairSql, /grant execute on function public\.allocate_project_number\(text\) to service_role/i);
  assert.doesNotMatch(securityRepairSql, /grant execute[\s\S]*to (?:PUBLIC|anon|authenticated)/i);
});

test('the repaired jobs view appends project fields without reordering its contract', () => {
  assert.match(
    securityRepairSql,
    /j\.jobber_id,[\s\S]*j\.job_number,[\s\S]*j\.title,[\s\S]*cl\.province as loc_province,[\s\S]*j\.project_seq,[\s\S]*j\.division_code/i,
  );
  assert.match(securityRepairSql, /security_invoker\s*=\s*true/i);
  assert.match(securityRepairSql, /revoke all on table public\.jobs_enriched from PUBLIC, anon, authenticated/i);
});
