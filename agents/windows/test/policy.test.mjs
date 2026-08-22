import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findScope, authorizeTask, taskScopeHash } from '../src/policy.js';

const agentId = '11111111-1111-1111-1111-111111111111';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-agent-policy-'));
const approvedRoot = path.join(tempRoot, 'approved');
const repository = path.join(approvedRoot, 'repo');
const outside = path.join(tempRoot, 'outside');
fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
fs.mkdirSync(path.join(outside, '.git'), { recursive: true });

const config = {
  approvedScopes: [{ type: 'repository', path: approvedRoot, permissions: ['read', 'test'] }],
};

function makeTask(taskType, taskPath, extra = {}) {
  const payload = { path: taskPath };
  return {
    task_type: taskType,
    payload,
    scope_hash: taskScopeHash({ agentId, taskType, payload }),
    ...extra,
  };
}

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('allows a real repository inside an approved root', () => {
  const result = authorizeTask(config, makeTask('repository_status', repository), agentId);
  assert.equal(result.ok, true);
});

test('rejects sibling-prefix path escapes', () => {
  assert.equal(findScope(config, `${approvedRoot}-other`), null);
});

test('rejects a Windows junction or symlink that resolves outside the approved root', (t) => {
  const link = path.join(approvedRoot, 'escape-link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`Link creation unavailable: ${error.code || error.message}`);
    return;
  }
  assert.equal(findScope(config, link), null);
});

test('rejects a mutated payload whose approved scope hash no longer matches', () => {
  const task = makeTask('repository_status', repository);
  task.payload = { path: outside };
  assert.equal(authorizeTask(config, task, agentId).ok, false);
});

test('rejects an approval-required test without a recorded approval timestamp', () => {
  const result = authorizeTask(config, makeTask('repository_test', repository), agentId);
  assert.equal(result.ok, false);
});

test('allows an approval-gated test only with matching scope and approval', () => {
  const task = makeTask('repository_test', repository, { approved_at: new Date().toISOString() });
  assert.equal(authorizeTask(config, task, agentId).ok, true);
});

test('rejects write, build, deploy, rollback, update, and shell task types', () => {
  for (const taskType of [
    'repository_build',
    'approved_file_change',
    'deploy_preview',
    'rollback_deployment',
    'automatic_update',
    'shell',
  ]) {
    assert.equal(authorizeTask(config, makeTask(taskType, repository), agentId).ok, false, taskType);
  }
});
