import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlStore, requestApproval, decideApproval, verifyApprovedPayload, enqueueQboSync, beginQboSync, finishQboSync, recoverInterruptedQboSync, retryQboSync, verifyControlAudit } from '../src/controls.js';

const submitter = { id: 'user-1', role: 'submitter' }, approver = { id: 'user-2', role: 'approver' }, bookkeeper = { id: 'book-1', role: 'bookkeeper' };
const payload = { PaymentType: 'CreditCard', AccountRef: { value: '42' }, Line: [{ Amount: 10 }] };

test('approval enforces separation of duties and payload immutability', () => {
  const store = createControlStore(); const request = requestApproval(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload }, submitter);
  assert.throws(() => decideApproval(store, request.id, 'approve', '', submitter), /own request/);
  decideApproval(store, request.id, 'approve', 'Looks right', approver); assert.equal(request.status, 'approved'); assert.equal(verifyApprovedPayload(request, payload).valid, true); assert.equal(verifyApprovedPayload(request, { ...payload, PaymentType: 'Cash' }).valid, false);
});

test('high-value approvals require both reviewer and controller roles', () => {
  const store = createControlStore(); const request = requestApproval(store, { companyId: 'co', entityType: 'expense', entityId: 'large', payload, requiredRoles: ['approver', 'controller'], approvalsRequired: 2 }, submitter);
  decideApproval(store, request.id, 'approve', 'First reviewer', approver); decideApproval(store, request.id, 'approve', 'Second reviewer', { id: 'user-3', role: 'approver' }); assert.equal(request.status, 'pending'); decideApproval(store, request.id, 'approve', 'Controller review', { id: 'controller-1', role: 'controller' }); assert.equal(request.status, 'approved');
});

test('QBO outbox is idempotent and refuses unapproved payloads', () => {
  const store = createControlStore(); const request = requestApproval(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload }, submitter);
  assert.throws(() => enqueueQboSync(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload, approvalRequestId: request.id }), /approved/);
  decideApproval(store, request.id, 'approve', '', approver);
  const first = enqueueQboSync(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload, approvalRequestId: request.id }); const second = enqueueQboSync(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload, approvalRequestId: request.id }); assert.equal(first.id, second.id);
});

test('QBO retries never create a second outbox transaction', () => {
  const store = createControlStore(); const request = requestApproval(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload }, submitter); decideApproval(store, request.id, 'approve', '', approver);
  const item = enqueueQboSync(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload, approvalRequestId: request.id }); beginQboSync(store, item.id, bookkeeper); finishQboSync(store, item.id, { ok: false, error: 'timeout', retryable: true }, bookkeeper); retryQboSync(store, item.id, bookkeeper); finishQboSync(store, item.id, { ok: true, qboId: '987' }, bookkeeper);
  assert.equal(item.status, 'complete'); assert.equal(item.qboId, '987'); assert.equal(item.attempts.length, 2); assert.equal(store.qboOutbox.length, 1); assert.equal(beginQboSync(store, item.id, bookkeeper).qboId, '987');
});

test('an interrupted QBO write is recovered with the same idempotency key', () => {
  const store = createControlStore(); const request = requestApproval(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload }, submitter); decideApproval(store, request.id, 'approve', '', approver); const item = enqueueQboSync(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload, approvalRequestId: request.id }); beginQboSync(store, item.id, bookkeeper); const key = item.idempotencyKey; recoverInterruptedQboSync(store, item.id, bookkeeper); retryQboSync(store, item.id, bookkeeper); assert.equal(item.idempotencyKey, key); assert.equal(item.attempts[0].status, 'interrupted'); assert.equal(item.attempts.length, 2); assert.equal(verifyControlAudit(store).valid, true);
});

test('mutating an approved queued payload blocks sync', () => {
  const store = createControlStore(); const request = requestApproval(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload }, submitter); decideApproval(store, request.id, 'approve', '', approver); const item = enqueueQboSync(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload: structuredClone(payload), approvalRequestId: request.id }); item.payload.Line[0].Amount = 11; assert.throws(() => beginQboSync(store, item.id, bookkeeper), /changed after approval/);
});

test('approval and QBO events have a tamper-evident audit chain', () => {
  const store = createControlStore(); const request = requestApproval(store, { companyId: 'co', entityType: 'expense', entityId: 'e1', payload }, submitter); decideApproval(store, request.id, 'approve', '', approver);
  assert.equal(verifyControlAudit(store).valid, true); store.events[0].detail.payloadHash = 'tampered'; assert.equal(verifyControlAudit(store).valid, false);
});
