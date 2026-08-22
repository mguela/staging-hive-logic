import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateScanConfidence, createLearningState, learningHealth, recordApprovedExpenseLearning, recordApprovedLearning, suggestFromApprovedLearning, verifyLearningChain } from '../src/reina-learning.js';

const bookkeeper = { id: 'bk-1', role: 'bookkeeper' };
const approval = (state, overrides = {}) => recordApprovedLearning(state, { companyId: 'co-1', vendor: 'Home Depot', sku: '100-ABC', description: '12/2 Romex wire', paymentAccountId: 'card-1', taxState: 'FL', suggestion: { ownerType: 'job', ownerId: 'JOB-44', qboAccountId: '64' }, ...overrides }, bookkeeper).state;

test('Reina only auto-fills after repeated consistent, context-specific approvals', () => {
  let state = createLearningState();
  state = approval(state); state = approval(state); state = approval(state);
  const suggestion = suggestFromApprovedLearning(state, { companyId: 'co-1', vendor: 'HOME DEPOT', sku: '100ABC', description: 'Romex 12 2 wire', paymentAccountId: 'card-1', taxState: 'FL' });
  assert.equal(suggestion.decision, 'auto_fill');
  assert.equal(suggestion.ownerId, 'JOB-44');
  assert.ok(suggestion.confidence >= .92);
});

test('a vendor name alone cannot override conflicting item-level history', () => {
  let state = createLearningState();
  state = approval(state); state = approval(state);
  state = approval(state, { sku: 'TOOL-9', description: 'Cordless drill', suggestion: { ownerType: 'tools', ownerId: 'Shop tools', qboAccountId: '72' } });
  const ambiguous = suggestFromApprovedLearning(state, { companyId: 'co-1', vendor: 'Home Depot', description: '' });
  assert.notEqual(ambiguous.decision, 'auto_fill');
  assert.ok(ambiguous.conflicts > 0);
});

test('company learning never crosses a tenant boundary', () => {
  let state = approval(createLearningState());
  const otherCompany = suggestFromApprovedLearning(state, { companyId: 'co-2', vendor: 'Home Depot', sku: '100-ABC', description: '12/2 Romex wire' });
  assert.equal(otherCompany.decision, 'unknown');
});

test('learning is append-only, role-protected, and tamper-evident', () => {
  const state = approval(createLearningState());
  assert.equal(verifyLearningChain(state).valid, true);
  assert.throws(() => recordApprovedLearning(state, { companyId: 'co-1', vendor: 'Store', suggestion: { ownerType: 'tools', qboAccountId: '72' } }, { id: 'field', role: 'submitter' }), /authorized reviewer/);
  state.events[0].output.qboAccountId = '99';
  assert.equal(verifyLearningChain(state).valid, false);
});

test('field confidence is gated separately and arithmetic failures require review', () => {
  const annotated = annotateScanConfidence({ documentType: 'receipt', vendor: 'ABC Supply', transactionDate: '2026-07-20', subtotal: 100, salesTaxTotal: 6.35, salesTaxState: 'CT', total: 105, confidence: .97, lineItems: [{ description: 'Pipe', subtotal: 100, confidence: .97 }] });
  assert.equal(annotated.fieldDecisions.vendor.decision, 'auto_fill');
  assert.equal(annotated.arithmetic.totalReconciles, false);
  assert.equal(annotated.fieldDecisions.total.decision, 'review');
  assert.equal(annotated.reviewSummary.requiresReview, true);
});

test('missing optional receipt fields do not block an otherwise reconciled scan', () => {
  const annotated = annotateScanConfidence({ documentType: 'receipt', vendor: 'ABC Supply', transactionDate: '2026-07-20', subtotal: 100, salesTaxTotal: 6.35, salesTaxState: 'CT', total: 106.35, confidence: .97, lineItems: [{ description: 'Pipe', subtotal: 100, confidence: .97 }] });
  assert.equal(annotated.reviewSummary.requiresReview, false);
  assert.deepEqual(annotated.reviewSummary.fields, []);
});

test('learning health surfaces conflicting contexts without deleting history', () => {
  let state = approval(createLearningState());
  const firstId = state.events[0].id;
  state = approval(state, { suggestion: { ownerType: 'inventory', ownerId: 'Warehouse', qboAccountId: '66' }, supersedesEventId: firstId });
  const health = learningHealth(state);
  assert.equal(health.approvedCorrections, 2);
  assert.equal(health.activeMemories, 1);
  assert.equal(health.audit.valid, true);
});

test('approved learning is idempotent when approval processing is replayed', () => {
  const input = { companyId: 'co-1', approvalId: 'approval-1', lineId: '0', vendor: 'ABC Supply', description: 'Pipe', suggestion: { ownerType: 'job', ownerId: 'JOB-1', qboAccountId: '64' } };
  const first = recordApprovedLearning(createLearningState(), input, bookkeeper);
  const replay = recordApprovedLearning(first.state, input, bookkeeper);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.events.length, 1);
  assert.equal(replay.event.id, first.event.id);
});

test('only a completed expense approval teaches line-level memory', () => {
  const expense = { id: 'expense-1', vendor: 'Home Depot', paymentAccountId: 'card', evidenceDocumentIds: ['doc-1'], allocations: [{ description: 'Romex', sku: 'R-1', ownerType: 'job', ownerId: 'JOB-1', qboAccountId: '64', salesTaxState: 'FL' }, { description: 'Unknown item', ownerType: 'unknown', ownerId: 'unknown', qboAccountId: '99' }] };
  assert.throws(() => recordApprovedExpenseLearning(createLearningState(), { companyId: 'co-1', approval: { id: 'a1', entityId: expense.id, status: 'pending' }, expense }, bookkeeper), /approval is complete/);
  const approval = { id: 'a1', entityId: expense.id, status: 'approved' };
  const learned = recordApprovedExpenseLearning(createLearningState(), { companyId: 'co-1', approval, expense }, bookkeeper);
  assert.equal(learned.events.length, 1);
  assert.equal(learned.events[0].event.context.sku, 'R-1');
  const replay = recordApprovedExpenseLearning(learned.state, { companyId: 'co-1', approval, expense }, bookkeeper);
  assert.equal(replay.state.events.length, 1);
  assert.equal(replay.events[0].replayed, true);
});
