// test/estimate-client-approval-engine.test.mjs
// jomell, 2026-08-25: recordClientApproval() is what a client's "Approve"
// click in the emailed estimate actually calls (via
// api/bookkeeping/estimates/respond.js), and it is deliberately NOT the
// same thing as approveEstimate() -- that one requires a controller-role
// actor and the deposit already paid (Chris's deposit-gate spec). Collapsing
// the two would let an email click silently bypass the deposit-gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordClientApproval, sendEstimate, approveEstimate } from '../server/bookkeeping/src/estimates.js';

function baseEstimate(overrides = {}) {
  return {
    id: 'est-1',
    companyId: 'greenwich-handyman',
    estimateNumber: 'E-10012',
    lifecycleStatus: 'sent',
    totals: { price: 1000, cardPrice: 1040 },
    history: [],
    ...overrides,
  };
}

test('recordClientApproval stamps clientApprovedAt without touching lifecycleStatus', () => {
  const est = baseEstimate();
  const updated = recordClientApproval(est, { now: '2026-08-25T12:00:00.000Z' });
  assert.equal(updated.clientApprovedAt, '2026-08-25T12:00:00.000Z');
  assert.equal(updated.lifecycleStatus, 'sent', 'a client email click must not satisfy the controller/deposit approval gate');
});

test('recordClientApproval requires no actor at all -- there is no HiveLogic identity for a client email link', () => {
  const est = baseEstimate();
  assert.doesNotThrow(() => recordClientApproval(est, {}));
});

test('recordClientApproval only applies to a sent estimate', () => {
  const est = baseEstimate({ lifecycleStatus: 'draft' });
  assert.throws(() => recordClientApproval(est, {}), /Cannot record a client approval for an estimate in status "draft"/);
});

test('recordClientApproval carries an optional note through to the record and its history', () => {
  const est = baseEstimate();
  const updated = recordClientApproval(est, { note: 'Looks great, go ahead' });
  assert.equal(updated.clientApprovalNote, 'Looks great, go ahead');
  const entry = updated.history.at(-1);
  assert.equal(entry.type, 'client_approved');
  assert.equal(entry.detail.note, 'Looks great, go ahead');
});

test('recordClientApproval never satisfies the real deposit-gated approveEstimate() afterwards', () => {
  const sent = sendEstimate(baseEstimate({ lifecycleStatus: 'draft' }), { id: 'staff-1', role: 'controller' });
  const clientApproved = recordClientApproval(sent, {});
  assert.throws(
    () => approveEstimate(clientApproved, { id: 'staff-1', role: 'controller' }),
    /the required deposit has not been paid yet/,
    'a client approval must never be mistaken for the deposit having been paid'
  );
});
