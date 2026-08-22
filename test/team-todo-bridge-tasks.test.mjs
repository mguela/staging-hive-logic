// test/team-todo-bridge-tasks.test.mjs
// Team To-Do rewire (2026-08-16) -- Source A: real HiveConnect Tasks read and
// written through the existing cross-project bridge.
//
// HiveConnect and HiveLogic are separate Supabase projects with no FK, so the
// Command Center card can only reach `tasks` server-side, with HiveConnect's
// SERVICE key. These tests prove the three things that matter:
//   1. the read is signed-in-only (401 for an unauthenticated caller),
//   2. it returns ACTIVE tasks only, with owner initials resolved,
//   3. completing a task writes BOTH the status patch and the
//      task_status_history row -- the same write shape public/hiveconnect/
//      tasks.js updateTaskStatus() uses, so a completion from the Command
//      Center is indistinguishable from one made inside HiveConnect.
// Fully mocked: no network, no real key, no schema change anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://hivelogic.test';
process.env.SUPABASE_SERVICE_KEY = 'hl-service-key';
process.env.HIVECONNECT_SUPABASE_URL = 'https://hiveconnect.test';
process.env.HIVECONNECT_SUPABASE_SERVICE_KEY = 'hc-service-key';

const CALLER = { id: 'hl-user-1', email: 'chris@ghgrp.net' };
const HC_PROFILE_ID = '11111111-1111-4111-8111-111111111111';

const TASK_A = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'Send the Miller vendor payment',
  status: 'not_started', priority: 'high',
  owner_type: 'employee', owner_profile_id: HC_PROFILE_ID,
  owner_channel_id: null, owner_contact_id: null,
  deliverable_date: '2026-08-18', job_ref: '231-003', client_ref: null,
  created_at: '2026-08-16T12:00:00Z',
};
const TASK_B = {
  id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  title: 'Finalize the Hoffman estimate',
  status: 'in_progress', priority: 'normal',
  owner_type: 'team', owner_profile_id: null,
  owner_channel_id: '22222222-2222-4222-8222-222222222222', owner_contact_id: null,
  deliverable_date: null, job_ref: null, client_ref: 'Hoffman',
  created_at: '2026-08-15T12:00:00Z',
};

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

let calls = [];
let world;

function freshWorld(overrides = {}) {
  return {
    authUser: CALLER,
    mapping: { hivelogic_user_id: CALLER.id, hiveconnect_user_id: HC_PROFILE_ID, status: 'active' },
    tasks: [TASK_A, TASK_B],
    taskPatchOk: true,
    historyOk: true,
    ...overrides,
  };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });

    if (u.includes('/auth/v1/user')) return world.authUser ? jsonRes(world.authUser) : jsonRes({ error: 'bad token' }, 401);
    if (u.includes('/rest/v1/hiveconnect_account_map')) return jsonRes(world.mapping ? [world.mapping] : []);

    if (u.includes('hiveconnect.test/rest/v1/tasks')) {
      if (method === 'PATCH') return world.taskPatchOk ? jsonRes([{}]) : jsonRes({ message: 'patch denied' }, 403);
      if (u.includes('id=eq.')) {
        const id = decodeURIComponent(u.split('id=eq.')[1].split('&')[0]);
        const row = world.tasks.find((t) => t.id === id);
        return jsonRes(row ? [row] : []);
      }
      return jsonRes(world.tasks);
    }
    if (u.includes('hiveconnect.test/rest/v1/task_status_history')) {
      return world.historyOk ? jsonRes([{ id: 'hist-1' }]) : jsonRes({ message: 'history denied' }, 403);
    }
    if (u.includes('hiveconnect.test/rest/v1/profiles')) return jsonRes([{ id: HC_PROFILE_ID, display_name: 'Jovie Ramos', username: 'jovie' }]);
    if (u.includes('hiveconnect.test/rest/v1/channels')) return jsonRes([{ id: '22222222-2222-4222-8222-222222222222', name: 'office' }]);
    if (u.includes('hiveconnect.test/rest/v1/contacts')) return jsonRes([]);
    return jsonRes({ error: 'unexpected call in test: ' + u }, 500);
  };
  try { return await fn(); } finally { global.fetch = original; }
}

async function callBridge(action, body = {}, { authHeader = 'Bearer usertoken' } = {}) {
  const mod = await import('../api/hiveconnect-bridge.js');
  const req = { method: 'POST', query: { action }, headers: { authorization: authHeader }, body };
  const r = res();
  await mod.default(req, r);
  return r;
}

test('tasks_list with no session is 401 -- the bridge never reads HiveConnect for an anonymous caller', async () => {
  world = freshWorld({ authUser: null });
  const r = await withMockedFetch(() => callBridge('tasks_list', {}, { authHeader: '' }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.ok, false);
  assert.ok(!calls.some((c) => c.url.includes('hiveconnect.test/rest/v1/tasks')), 'no HiveConnect task read may happen without a session');
});

test('task_complete with no session is 401', async () => {
  world = freshWorld({ authUser: null });
  const r = await withMockedFetch(() => callBridge('task_complete', { taskId: TASK_A.id }, { authHeader: '' }));
  assert.equal(r.statusCode, 401);
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no write may happen without a session');
});

test('tasks_list returns active tasks with owner label + initials and a due date', async () => {
  world = freshWorld();
  const r = await withMockedFetch(() => callBridge('tasks_list'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.tasks.length, 2);
  const a = r.body.tasks.find((t) => t.id === TASK_A.id);
  assert.equal(a.title, 'Send the Miller vendor payment');
  assert.equal(a.ownerLabel, 'Jovie Ramos');
  assert.equal(a.ownerInitials, 'JR');
  assert.equal(a.dueDate, '2026-08-18');
  assert.equal(a.priority, 'high');
  const b = r.body.tasks.find((t) => t.id === TASK_B.id);
  assert.equal(b.ownerLabel, '#office', 'a team-owned task shows its channel');
  assert.equal(b.ownerInitials, 'OF');
});

test('tasks_list asks HiveConnect to exclude completed / cancelled / draft rows', async () => {
  world = freshWorld();
  await withMockedFetch(() => callBridge('tasks_list'));
  const read = calls.find((c) => c.url.includes('hiveconnect.test/rest/v1/tasks') && c.method === 'GET');
  assert.ok(read, 'a task read must happen');
  const decoded = decodeURIComponent(read.url);
  assert.ok(decoded.includes('status=not.in.(completed,cancelled,draft)'), `active-only filter missing: ${decoded}`);
  assert.equal((decoded.match(/order=/g) || []).length, 1, 'PostgREST takes ONE order param (comma-separated) -- a second one silently replaces the first');
  assert.ok(decoded.includes('order=deliverable_date.asc.nullslast,created_at.desc'), `sort order missing: ${decoded}`);
});

test('completing a task writes the status patch AND the task_status_history row (the round trip)', async () => {
  world = freshWorld();
  const r = await withMockedFetch(() => callBridge('task_complete', { taskId: TASK_A.id }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.task.status, 'completed');
  assert.equal(r.body.task.fromStatus, 'not_started');
  assert.equal(r.body.task.historyWritten, true);

  const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/rest/v1/tasks'));
  assert.ok(patch, 'the task row must be patched');
  assert.equal(patch.body.status, 'completed');
  assert.ok(patch.body.completion_date, 'completion_date must be stamped, same as the HiveConnect UI does');
  assert.ok(patch.body.updated_at, 'updated_at must be stamped');

  const hist = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/task_status_history'));
  assert.ok(hist, 'a task_status_history row must be appended');
  assert.equal(hist.body.task_id, TASK_A.id);
  assert.equal(hist.body.from_status, 'not_started');
  assert.equal(hist.body.to_status, 'completed');
  assert.equal(hist.body.changed_by, HC_PROFILE_ID, 'changed_by must be the caller\'s own HiveConnect profile, not a service identity');
});

test('a history-write failure is reported, not swallowed into a clean success', async () => {
  world = freshWorld({ historyOk: false });
  const r = await withMockedFetch(() => callBridge('task_complete', { taskId: TASK_A.id }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.task.status, 'completed', 'the status change did happen');
  assert.equal(r.body.task.historyWritten, false, 'and the missing audit row is reported honestly');
});

test('a caller with no HiveConnect mapping cannot complete a task (no anonymous changed_by)', async () => {
  world = freshWorld({ mapping: null });
  const r = await withMockedFetch(() => callBridge('task_complete', { taskId: TASK_A.id }));
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'not_mapped');
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'nothing may be written for an unmapped caller');
});

test('a malformed task id is rejected before any HiveConnect write', async () => {
  world = freshWorld();
  const r = await withMockedFetch(() => callBridge('task_complete', { taskId: "1' or '1'='1" }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'bad_task_id');
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'a bad id must never reach a write');
});

test('completing a task that no longer exists is a clear 400, not a silent success', async () => {
  world = freshWorld({ tasks: [] });
  const r = await withMockedFetch(() => callBridge('task_complete', { taskId: TASK_A.id }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'task_not_found');
});

test('an already-completed task is a no-op, not a duplicate history row', async () => {
  world = freshWorld({ tasks: [{ ...TASK_A, status: 'completed' }] });
  const r = await withMockedFetch(() => callBridge('task_complete', { taskId: TASK_A.id }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.task.alreadyCompleted, true);
  assert.ok(!calls.some((c) => c.url.includes('task_status_history')), 'no second history row for an already-completed task');
});

test('the bridge can create and complete, and NOTHING else', async () => {
  // This test used to read "the bridge only ever completes". That was true and
  // deliberate: the write surface was kept as small as the feature needed.
  //
  // 2026-08-17 the feature needed one more verb -- Chris asked for "push it to
  // Team To-Do" as a one-tap action on a triaged email, and there is no honest
  // way to do that without a create path. So the constraint moved, on purpose,
  // and this test says so rather than being quietly deleted.
  //
  // What has NOT moved: no delete, no reopen, no editing someone else's task,
  // no assigning work to other people. Create sets a title and an owner (always
  // the caller). Complete sets a status and appends history. That is the whole
  // surface, and it should stay that way without a reason as specific as this
  // one was.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../api/hiveconnect-bridge.js', import.meta.url), 'utf-8'));
  const taskSection = src.slice(src.indexOf('// Create a task in HiveConnect'));
  assert.ok(!/method: 'DELETE'/.test(taskSection), 'the task bridge must not delete tasks');
  assert.ok(!/method: 'PUT'/.test(taskSection), 'nor replace them wholesale');
  const writes = taskSection.match(/method: '(POST|PATCH|PUT|DELETE)'/g) || [];
  assert.deepEqual(writes.sort(), ["method: 'PATCH'", "method: 'POST'", "method: 'POST'"],
    'one insert (create) + one patch (status) + one insert (history)');
});

test('a created task is owned by the caller, never by someone else', async () => {
  world = freshWorld();
  const r = await withMockedFetch(() => callBridge('task_create', { title: 'Call the stone supplier back' }));
  assert.equal(r.statusCode, 200);
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/tasks'));
  assert.ok(post, 'the task must be inserted');
  assert.equal(post.body.owner_profile_id, HC_PROFILE_ID, 'owner is the caller\'s own HiveConnect profile');
  assert.equal(post.body.created_by, HC_PROFILE_ID);
  assert.equal(post.body.status, 'not_started');
  assert.equal(post.body.title, 'Call the stone supplier back');
});

test('a task with no title is refused before any write', async () => {
  world = freshWorld();
  const r = await withMockedFetch(() => callBridge('task_create', { title: '   ' }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'bad_task_title');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('/rest/v1/tasks')));
});

test('an unmapped caller cannot create a task either', async () => {
  world = freshWorld({ mapping: null });
  const r = await withMockedFetch(() => callBridge('task_create', { title: 'Something' }));
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'not_mapped');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('/rest/v1/tasks')));
});

test('task_create with no session is 401', async () => {
  world = freshWorld({ authUser: null });
  const r = await withMockedFetch(() => callBridge('task_create', { title: 'x' }, { authHeader: '' }));
  assert.equal(r.statusCode, 401);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('/rest/v1/tasks')));
});
