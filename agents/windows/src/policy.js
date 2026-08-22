import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  if (!fs.existsSync(resolved)) return null;
  return fs.realpathSync.native(resolved).replace(/[\\/]+$/, '').toLowerCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function taskScopeHash({ agentId, taskType, payload }) {
  return crypto.createHash('sha256')
    .update(canonicalJson({ agentId, taskType, payload }))
    .digest('hex');
}

export function findScope(config, requestedPath) {
  const wanted = canonicalPath(requestedPath);
  if (!wanted) return null;
  return (config.approvedScopes || []).find(scope => {
    const root = canonicalPath(scope.path);
    if (!root) return false;
    return wanted === root || wanted.startsWith(`${root}${path.sep}`);
  }) || null;
}

export function authorizeTask(config, task, agentId) {
  if (!task || !agentId || task.scope_hash !== taskScopeHash({
    agentId,
    taskType: task.task_type,
    payload: task.payload,
  })) {
    return { ok: false, reason: 'Task scope hash is missing or does not match the immutable task payload.' };
  }
  const scope = findScope(config, task?.payload?.path);
  if (!scope) return { ok: false, reason: 'Path is outside locally approved scopes.' };
  const required = {
    repository_status: 'read',
    repository_test: 'test',
  }[task.task_type];
  if (!required) return { ok: false, reason: 'Task type is not implemented by this agent.' };
  if (!(scope.permissions || []).includes(required)) return { ok: false, reason: `Scope does not grant ${required}.` };
  const repositoryMarker = path.join(canonicalPath(task.payload.path), '.git');
  if (!fs.existsSync(repositoryMarker)) return { ok: false, reason: 'Approved path is not a Git repository.' };
  if (task.task_type === 'repository_test' && !task.approved_at) {
    return { ok: false, reason: 'Repository test task has no recorded approval.' };
  }
  return { ok: true, scope, required };
}
