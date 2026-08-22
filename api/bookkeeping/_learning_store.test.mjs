// api/bookkeeping/_learning_store.test.mjs
// Exercises the memory backend of the new (task 6) Reina learning-memory
// store: provisioning, persistence across calls, per-company isolation, and
// that the stored shape is real reina-learning.js state a caller can run
// suggestFromApprovedLearning()/learningHealth() against directly.
//
// Run: BOOKKEEPING_ALLOW_MEMORY_STORE=true NODE_ENV=test node --test api/bookkeeping/_learning_store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';

test('getLearningState provisions a fresh, empty, valid learning state on first access', async () => {
  const { getLearningState } = await import(`./_learning_store.js?t=${Date.now()}`);
  const { verifyLearningChain } = await import('../../server/bookkeeping/src/reina-learning.js');
  const state = await getLearningState('co-learn-1');
  assert.equal(state.version, 2);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.migratedRules, []);
  assert.ok(verifyLearningChain(state).valid);
});

test('updateLearningState persists a recorded event across separate calls to the same company', async () => {
  const { getLearningState, updateLearningState } = await import(`./_learning_store.js?t=${Date.now()}`);
  const { recordApprovedLearning } = await import('../../server/bookkeeping/src/reina-learning.js');
  await updateLearningState('co-learn-2', (state) => {
    const result = recordApprovedLearning(state, {
      companyId: 'co-learn-2', approvalId: 'appr-1', vendor: 'Ace Hardware', sku: 'AH-1',
      suggestion: { ownerType: 'job', ownerId: 'job-1', qboAccountId: '64' }
    }, { id: 'controller-1', role: 'controller' });
    return result.state;
  });
  const reread = await getLearningState('co-learn-2');
  assert.equal(reread.events.length, 1);
  assert.equal(reread.events[0].context.vendor, 'Ace Hardware');
  assert.equal(reread.events[0].output.qboAccountId, '64');
});

test('a company\'s learning memory is never visible through another company\'s id (tenant isolation)', async () => {
  const { getLearningState, updateLearningState } = await import(`./_learning_store.js?t=${Date.now()}`);
  const { recordApprovedLearning } = await import('../../server/bookkeeping/src/reina-learning.js');
  await updateLearningState('co-learn-3a', (state) => {
    const result = recordApprovedLearning(state, {
      companyId: 'co-learn-3a', approvalId: 'appr-2', vendor: 'Ace Hardware', sku: 'AH-1',
      suggestion: { ownerType: 'job', ownerId: 'job-1', qboAccountId: '64' }
    }, { id: 'controller-1', role: 'controller' });
    return result.state;
  });
  const otherCompany = await getLearningState('co-learn-3b');
  assert.equal(otherCompany.events.length, 0);
});

test('updateLearningState mutations round-trip through suggestFromApprovedLearning correctly', async () => {
  const { getLearningState, updateLearningState } = await import(`./_learning_store.js?t=${Date.now()}`);
  const { recordApprovedLearning, suggestFromApprovedLearning } = await import('../../server/bookkeeping/src/reina-learning.js');
  await updateLearningState('co-learn-4', (state) => {
    const result = recordApprovedLearning(state, {
      companyId: 'co-learn-4', approvalId: 'appr-3', vendor: 'Ace Hardware', sku: 'AH-1',
      suggestion: { ownerType: 'job', ownerId: 'job-1', qboAccountId: '64' }
    }, { id: 'controller-1', role: 'controller' });
    return result.state;
  });
  const state = await getLearningState('co-learn-4');
  const suggestion = suggestFromApprovedLearning(state, { companyId: 'co-learn-4', vendor: 'Ace Hardware', sku: 'AH-1' });
  assert.equal(suggestion.ownerType, 'job');
  assert.equal(suggestion.qboAccountId, '64');
  assert.equal(suggestion.support, 1);
});
