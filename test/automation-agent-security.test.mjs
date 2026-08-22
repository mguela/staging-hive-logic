import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, taskScopeHash, validateTask } from '../api/_lib/agents/security.js';

test('task scope hash is stable across object key order', () => {
  const first = taskScopeHash({ agentId: 'a', taskType: 'repository_test', payload: { path: 'C:\\Repo', extra: 1 } });
  const second = taskScopeHash({ taskType: 'repository_test', payload: { extra: 1, path: 'C:\\Repo' }, agentId: 'a' });
  assert.equal(first, second);
});

test('canonical JSON preserves array order', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('arbitrary command fields are rejected', () => {
  const result = validateTask('repository_test', { path: 'C:\\Repo', command: 'whoami' });
  assert.equal(result.ok, false);
});

test('unknown task types are rejected', () => {
  assert.equal(validateTask('remote_shell', { path: 'C:\\Repo' }).ok, false);
});

test('read-only status task does not require approval', () => {
  const result = validateTask('repository_status', { path: 'C:\\Repo' });
  assert.equal(result.ok, true);
  assert.equal(result.approvalRequired, false);
});

test('write, build, deploy, rollback, update, desktop, and shell tasks are rejected', () => {
  for (const taskType of [
    'repository_build',
    'approved_file_change',
    'deploy_preview',
    'rollback_deployment',
    'automatic_update',
    'remote_desktop',
    'remote_shell',
  ]) {
    assert.equal(validateTask(taskType, { path: 'C:\\Repo' }).ok, false, taskType);
  }
});
