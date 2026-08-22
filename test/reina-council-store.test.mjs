import assert from 'node:assert/strict';
import test from 'node:test';

import { createCouncilStore } from '../api/_lib/reina/council-store.js';

function response(value) {
  return { ok: true, json: async () => value };
}

test('Council run, messages, and audit are persisted by one transactional RPC', async () => {
  const calls = [];
  const store = createCouncilStore({ request: async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return response({ id: calls[0].body.p_id, state: 'completed' });
  }});
  const result = {
    state: 'completed', budget: { maxRounds: 1 }, usage: { totalCostCents: 1 }, report: {}, executionRequest: null,
    messages: [{ participant: 'claude', round: 0 }, { participant: 'chatgpt', round: 0 }, { participant: 'grok', round: 0 }],
    audit: [
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'claude', round: 0, usage: {} } },
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'chatgpt', round: 0, usage: {} } },
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'grok', round: 0, usage: {} } },
    ],
  };
  const run = await store.createRun({ ownerId: 'owner-1', admissionId: 'admission-1', brief: 'brief', evidence: [], result });
  assert.equal(run.state, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'rpc/reina_council_create_run');
  assert.equal(calls[0].body.p_admission_id, 'admission-1');
  assert.equal(calls[0].body.p_messages.length, 3);
  assert.equal(calls[0].body.p_audit_events.length, 3);
});

test('a project attach travels inside the SAME atomic RPC call, not a separate PATCH', async () => {
  // Found during the 2026-08-18 Boardroom production incident review:
  // project_id used to be attached via a second, non-transactional PATCH
  // issued after this RPC had already committed. If that PATCH failed, the
  // client was told the whole request failed while the run (and possibly a
  // freshly-created, now-orphaned project) already existed. This test would
  // have failed under the old implementation, which made exactly 2 requests
  // (the RPC, then the PATCH) instead of 1.
  const calls = [];
  const store = createCouncilStore({ request: async (path, options) => {
    calls.push({ path, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
    return response({ id: 'run-1', state: 'completed', project_id: 'project-1' });
  }});
  const result = {
    state: 'completed', budget: { maxRounds: 1 }, usage: { totalCostCents: 1 }, report: {}, executionRequest: null,
    messages: [{ participant: 'claude', round: 0 }, { participant: 'chatgpt', round: 0 }, { participant: 'grok', round: 0 }],
    audit: [
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'claude', round: 0, usage: {} } },
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'chatgpt', round: 0, usage: {} } },
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'grok', round: 0, usage: {} } },
    ],
  };
  const run = await store.createRun({ ownerId: 'owner-1', admissionId: 'admission-1', brief: 'brief', evidence: [], result, projectId: 'project-1' });
  assert.equal(run.project_id, 'project-1');
  assert.equal(calls.length, 1, 'exactly one request must be made -- the project id travels with the run, not after it');
  assert.equal(calls[0].path, 'rpc/reina_council_create_run');
  assert.equal(calls[0].body.p_project_id, 'project-1');
});

test('createRun without a project passes p_project_id as null, not omitted', async () => {
  const calls = [];
  const store = createCouncilStore({ request: async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return response({ id: 'run-1', state: 'completed', project_id: null });
  }});
  const result = {
    state: 'completed', budget: { maxRounds: 1 }, usage: { totalCostCents: 1 }, report: {}, executionRequest: null,
    messages: [{ participant: 'claude', round: 0 }, { participant: 'chatgpt', round: 0 }, { participant: 'grok', round: 0 }],
    audit: [
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'claude', round: 0, usage: {} } },
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'chatgpt', round: 0, usage: {} } },
      { type: 'provider.completed', at: '2026-08-05T00:00:00Z', data: { participant: 'grok', round: 0, usage: {} } },
    ],
  };
  await store.createRun({ ownerId: 'owner-1', admissionId: 'admission-1', brief: 'brief', evidence: [], result });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.p_project_id, null);
});

test('provider retry evidence is preserved in full instead of trimmed to a fixed audit count', async () => {
  const calls = [];
  const store = createCouncilStore({ request: async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return response({ id: 'run-with-retry', state: 'completed' });
  }});
  const audit = [
    { type: 'council.started', at: '2026-08-16T00:00:00Z', data: {} },
    { type: 'provider.requested', at: '2026-08-16T00:00:01Z', data: { participant: 'grok', round: 0, attempt: 0 } },
    { type: 'provider.failed', at: '2026-08-16T00:00:02Z', data: { participant: 'grok', round: 0, attempt: 0, reason: 'invalid_message' } },
    { type: 'provider.retrying', at: '2026-08-16T00:00:03Z', data: { participant: 'grok', round: 0, attempt: 1, reason: 'invalid_message' } },
    { type: 'provider.requested', at: '2026-08-16T00:00:04Z', data: { participant: 'grok', round: 0, attempt: 1 } },
    { type: 'provider.completed', at: '2026-08-16T00:00:05Z', data: { participant: 'grok', round: 0, usage: {} } },
    { type: 'moderator.independent_round_completed', at: '2026-08-16T00:00:06Z', data: {} },
    { type: 'moderator.consensus_computed', at: '2026-08-16T00:00:07Z', data: {} },
    { type: 'council.completed', at: '2026-08-16T00:00:08Z', data: {} },
  ];
  const result = {
    state: 'completed', budget: { maxRounds: 1 }, usage: { totalCostCents: 1 }, report: {}, executionRequest: null,
    messages: [
      { participant: 'claude', round: 0 },
      { participant: 'chatgpt', round: 0 },
      { participant: 'grok', round: 0 },
    ],
    audit,
  };
  await store.createRun({ ownerId: 'owner', admissionId: 'admission', brief: 'brief', evidence: [], result });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.p_audit_events.length, audit.length);
  assert.equal(calls[0].body.p_audit_events.some((event) => event.eventType === 'provider.retrying'), true);
});

test('Council persistence retries an old database contract with truthful unavailable placeholders', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (calls.length === 1) return { ok: false, json: async () => ({ message: 'incomplete council persistence payload' }) };
    return response({ id: 'run-legacy-compatible' });
  };
  const store = createCouncilStore({ request });
  const result = {
    state: 'completed', budget: { maxRounds: 1 }, usage: { totalCostCents: 1 }, report: {}, executionRequest: null,
    messages: [{ participant: 'grok', round: 0, summary: 'Verified response' }],
    audit: [
      { type: 'council.started', at: '2026-08-16T00:00:00Z', data: {} },
      { type: 'provider.failed', at: '2026-08-16T00:00:01Z', data: { participant: 'claude', round: 0 } },
      { type: 'provider.failed', at: '2026-08-16T00:00:02Z', data: { participant: 'chatgpt', round: 0 } },
      { type: 'provider.completed', at: '2026-08-16T00:00:03Z', data: { participant: 'grok', round: 0, usage: {} } },
      { type: 'moderator.independent_round_completed', at: '2026-08-16T00:00:04Z', data: { unavailable: ['claude', 'chatgpt'] } },
      { type: 'moderator.consensus_computed', at: '2026-08-16T00:00:05Z', data: {} },
      { type: 'council.completed', at: '2026-08-16T00:00:06Z', data: {} },
    ],
  };
  const row = await store.createRun({ ownerId: 'owner', admissionId: 'admission', brief: 'brief', evidence: [], result });
  assert.equal(row.id, 'run-legacy-compatible');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.p_messages.length, 1);
  assert.equal(calls[1].body.p_messages.length, 3);
  assert.equal(calls[1].body.p_audit_events.length, 10);
  const placeholders = calls[1].body.p_messages.filter((entry) => entry.message.unavailable === true);
  assert.deepEqual(placeholders.map((entry) => entry.participant), ['claude', 'chatgpt']);
  assert.equal(placeholders.every((entry) => entry.message.summary.includes('no answer was generated')), true);
});

test('admission, release, and aggregate reads use service-only RPC boundaries', async () => {
  const calls = [];
  const store = createCouncilStore({ request: async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('_admit')) return response({ status: 'admitted', admissionId: 'admission-1' });
    if (path.endsWith('_get_run')) return response({ id: 'run-1', messages: [], audit: [] });
    return response({ released: true });
  }});
  const admitted = await store.admit({
    ownerId: 'owner-1', idempotencyKey: 'request-123', requestHash: 'a'.repeat(64),
    maxCostCents: 100, maxConcurrentRuns: 1, dailyCostCents: 2000,
  });
  assert.equal(admitted.admissionId, 'admission-1');
  assert.equal((await store.getRun('run-1', 'owner-1')).id, 'run-1');
  assert.equal((await store.releaseAdmission({ admissionId: 'admission-1', ownerId: 'owner-1' })).released, true);
  assert.deepEqual(calls.map((call) => call.path), [
    'rpc/reina_council_admit', 'rpc/reina_council_get_run', 'rpc/reina_council_release_admission',
  ]);
});

test('Boardroom history is owner-scoped, newest-first, and bounded', async () => {
  let path;
  const store = createCouncilStore({ request: async (requestedPath) => {
    path = requestedPath;
    return response([{ id: 'run-1', brief: 'Should we hire?', state: 'completed' }]);
  }});
  const rows = await store.getRecentRuns('owner/one', 500, 17);
  assert.equal(rows.length, 1);
  assert.match(path, /owner_id=eq\.owner%2Fone/);
  assert.match(path, /select=id,brief,state,report,usage,project_id,pinned,created_at,updated_at/);
  assert.match(path, /order=created_at\.desc/);
  assert.match(path, /limit=50&offset=17$/);
});

test('getOrCreateProject reuses an existing owner project without inserting', async () => {
  const calls = [];
  const existing = { id: 'project-1', name: 'HiveLogic Master Project' };
  const store = createCouncilStore({ request: async (path, options) => {
    calls.push({ path, options });
    return response([existing]);
  }});
  const result = await store.getOrCreateProject({ ownerId: 'owner/one', name: existing.name });
  assert.deepEqual(result, { project: existing, created: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /owner_id=eq\.owner%2Fone/);
  assert.match(calls[0].path, /name=eq\.HiveLogic%20Master%20Project/);
  assert.equal(calls[0].options, undefined);
});

test('getOrCreateProject creates once and resolves a uniqueness race by rereading', async () => {
  const calls = [];
  const winner = { id: 'project-winner', name: 'HiveLogic Master Project' };
  let reads = 0;
  const store = createCouncilStore({ request: async (path, options) => {
    calls.push({ path, options });
    if (path === 'boardroom_projects') return { ok: false, json: async () => ({ message: 'duplicate' }) };
    reads += 1;
    return response(reads === 1 ? [] : [winner]);
  }});
  const result = await store.getOrCreateProject({ ownerId: 'owner-1', name: winner.name });
  assert.deepEqual(result, { project: winner, created: false });
  assert.equal(calls.filter((call) => call.path === 'boardroom_projects').length, 1);
  assert.equal(reads, 2);
});

test('imported AI history reads only owner threads and returns source coverage with bounded messages', async () => {
  const paths = [];
  const store = createCouncilStore({ request: async (path) => {
    paths.push(path);
    if (path.startsWith('ai_workroom_threads')) return response([{ id: '00000000-0000-4000-8000-000000000010' }]);
    if (path.startsWith('ai_workroom_sources')) return response([{ source: 'claude', status: 'connected' }]);
    return response([{ id: 'message-1', source: 'claude', body: 'HiveLogic' }]);
  }});
  const result = await store.getImportedHistory('owner/one', 9_999);
  assert.equal(result.sources[0].source, 'claude');
  assert.equal(result.messages[0].id, 'message-1');
  assert.deepEqual(result.availableSources, ['codex', 'chatgpt', 'claude', 'claude_code', 'grok']);
  assert.match(paths[0], /owner_id=eq\.owner%2Fone/);
  assert.match(paths[1], /owner_id=eq\.owner%2Fone/);
  const messagePath = paths.find((path) => /thread_id=in\./.test(path));
  assert.ok(messagePath);
  assert.match(messagePath, /source=not\.is\.null/);
  assert.match(messagePath, /limit=500$/);
  const coveragePaths = paths.filter((path) => /source=eq\./.test(path));
  assert.equal(coveragePaths.length, 5);
  assert.equal(coveragePaths.every((path) => /thread_id=in\./.test(path)), true);
});

test('approval, tenant-scoped queueing, state transition, and audit use one RPC', async () => {
  const calls = [];
  const store = createCouncilStore({ tenantId: 'tenant-1', request: async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return response({ id: 'task-1', status: 'queued' });
  }});
  const task = await store.approveAndQueue({
    run: { id: 'run-1' }, ownerId: 'owner-1', reason: 'approved',
    task: { agentId: '00000000-0000-4000-8000-000000000001', taskType: 'repository_status', path: 'C:\\repo', scopeHash: 'scope' },
  });
  assert.equal(task.id, 'task-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'rpc/reina_council_approve_and_queue');
  assert.equal(calls[0].body.p_tenant_id, 'tenant-1');
  assert.equal(calls[0].body.p_agent_id, '00000000-0000-4000-8000-000000000001');
});
