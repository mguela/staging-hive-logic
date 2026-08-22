import test from 'node:test';
import assert from 'node:assert/strict';
import { recordTaskDecision } from '../api/agents/control.js';

const task = {
  id: '22222222-2222-2222-2222-222222222222',
  scope_hash: 'abc123',
};

test('approval persistence failure leaves the task blocked', async () => {
  const calls = [];
  const result = await recordTaskDecision({
    task,
    approved: true,
    staffId: '33333333-3333-3333-3333-333333333333',
    request: async (path) => {
      calls.push(path);
      return { ok: false, json: async () => [] };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /automation_task_approvals/);
});

test('task is queued only after the approval record is saved', async () => {
  const calls = [];
  const result = await recordTaskDecision({
    task,
    approved: true,
    staffId: '33333333-3333-3333-3333-333333333333',
    request: async (path) => {
      calls.push(path);
      if (path === 'automation_task_approvals') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => [{ id: task.id, status: 'queued' }] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test('zero-row task transition is treated as a blocked race, not success', async () => {
  const result = await recordTaskDecision({
    task,
    approved: true,
    staffId: '33333333-3333-3333-3333-333333333333',
    request: async (path) => path === 'automation_task_approvals'
      ? { ok: true, json: async () => [] }
      : { ok: true, json: async () => [] },
  });
  assert.equal(result.ok, false);
});
