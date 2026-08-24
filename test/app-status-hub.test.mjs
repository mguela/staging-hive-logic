import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findingsFromSelftest, findingsFromHealthChecks, createManualFinding, withResolverNames, setFindingStatus, addFindingAttachment, listFindingAttachments, observeFindings } from '../api/_lib/status-hub.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('self-test failures normalize to stable, deduplicated status findings', () => {
  const findings = findingsFromSelftest([
    { verdict: 'FAILED_FETCH', view: 'docs', label: 'Upload', note: 'documents:500', kind: 'action' },
    { verdict: 'FAILED_FETCH', view: 'docs', label: 'Upload', note: 'documents:500', kind: 'action' },
    { verdict: 'PASS', view: 'docs', label: 'Refresh' },
    { verdict: 'NO_OUTCOME', view: 'cc', label: 'Pulse', note: '' },
  ]);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].source, 'selftest');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].fingerprint, /^[a-f0-9]{40}$/);
  assert.equal(findings[1].severity, 'low');
});

test('daily health feeds only failures and app-blocking warnings into the exception queue', () => {
  const findings = findingsFromHealthChecks([
    { name: 'Jobber sync freshness', status: 'warn', detail: '38h since sync' },
    { name: 'API jobs', status: 'fail', detail: 'HTTP 500' },
    { name: 'Clients', status: 'ok', detail: 'fine' },
  ]);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings.map((f) => f.severity), ['high']);
  assert.ok(findings.every((f) => f.source === 'daily_health'));
});

test('manual reporting only accepts the four blocker categories', async () => {
  await assert.rejects(() => createManualFinding({ source: 'activity_log', title: 'Routine run succeeded' }), /Invalid blocker type/);
  await assert.rejects(() => createManualFinding({ source: 'owner_decision', title: 'x' }), /summary is required/);
  await assert.rejects(() => createManualFinding({ source: 'owner_decision', title: 'A valid blocker title', due_date: 'not-a-date' }), /due date/);
});

test('status-hub migration keeps raw findings and triage events server-only', () => {
  const migration = read('supabase', 'migrations', '20260818180000_app_status_hub.sql');
  assert.match(migration, /create table if not exists public\.app_status_findings/i);
  assert.match(migration, /create table if not exists public\.app_status_events/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.app_status_findings from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.app_status_findings to service_role/i);
});

test('crawler reports carry a real signed-in bearer and feed the status hub', () => {
  const crawler = read('public', 'tools', 'selftest.js');
  const endpoint = read('api', 'selftest-report.js');
  assert.match(crawler, /Authorization:\s*'Bearer '\s*\+\s*token/);
  assert.match(endpoint, /requireApiAuth\(req\)/);
  assert.match(endpoint, /observeFindings\(findingsFromSelftest\(row\.results\)\)/);
  assert.match(read('api', 'health-cron.js'), /observeFindings\(findingsFromHealthChecks\(checks\)\)/);
});

test('Dev To-Do is an issue-and-blocker queue with authenticated human intake and triage', () => {
  const page = read('public', 'index.html');
  const track1 = read('api', 'track1.js');
  const view = page.slice(page.indexOf('id="view-devtodo"'), page.indexOf('function devTodoLoad()'));
  assert.match(page, /Issues &amp; Blockers/);
  assert.match(page, /Successful runs and routine operational activity are excluded/);
  assert.doesNotMatch(view, /resource=reina_todo_get/);
  assert.match(page, /resource=app_status_findings/);
  assert.match(page, /resource=app_status_update/);
  assert.match(page, /resource=app_status_create/);
  assert.match(track1, /handleAppStatusFindings/);
  assert.match(track1, /handleAppStatusUpdate/);
  assert.match(track1, /handleAppStatusCreate/);
  assert.match(track1, /canManageDevTodo/);
});

test('marking a Dev To-Do finding resolved or ignored moves it to its own tab instead of erasing it', () => {
  const page = read('public', 'index.html');
  // Resolved and Ignored are separate tabs, not one merged "closed" bucket --
  // jomell asked for Ignored to be visible on its own, distinct from Resolved.
  for (const id of ['devtodo-tab-open', 'devtodo-tab-resolved', 'devtodo-tab-ignored']) {
    assert.match(page, new RegExp('id="' + id + '" onclick="devTodoSwitchTab\\(\'' + id.replace('devtodo-tab-', '') + '\'\\)"'));
  }
  assert.match(page, /function devTodoSwitchTab\(tab\)/);
  assert.match(page, /if \(devTodoTab === 'resolved'\) return f\.status === 'resolved';/);
  assert.match(page, /if \(devTodoTab === 'ignored'\) return f\.status === 'ignored';/);
  assert.match(page, /return f\.status !== 'resolved' && f\.status !== 'ignored';/);
  assert.match(page, /findingsBody\.innerHTML = devTodoFindingsHtml\(devTodoLastFindings\);/);
});

test('Dev To-Do supports urgency ordering, assignees, due dates, and high-alert delivery', () => {
  const page = read('public', 'index.html');
  const hub = read('api', '_lib', 'status-hub.js');
  const track1 = read('api', 'track1.js');
  const migration = read('supabase', 'migrations', '20260818190000_devtodo_assignment_and_due_date.sql');
  assert.match(page, /id="devtodo-new-assigned-to"/);
  assert.match(page, /id="devtodo-new-due-date" type="date"/);
  assert.match(page, /var urgency = \{critical:0,high:1,medium:2,low:3,info:4\}/);
  assert.match(page, /Overdue:/);
  assert.match(hub, /assigned_to: assignedTo/);
  assert.match(hub, /due_date: due/);
  assert.match(migration, /add column if not exists assigned_to text/i);
  assert.match(migration, /add column if not exists due_date date/i);
  assert.match(track1, /postBotMessage\(channelId, `🚨 HIGH DEV TO-DO BLOCKER:/);
  // The alert must cover 'critical' too. It is a valid severity (status-hub.js
  // accepts critical/high/medium/low) and the queue sorts it ABOVE high, so
  // gating on 'high' alone made the most severe blocker the only silent one.
  assert.match(track1, /result\.created && \['critical', 'high'\]\.includes\(result\.finding\.severity\)/);
  assert.doesNotMatch(track1, /result\.finding\.severity === 'high'/,
    'a bare === high check would exclude critical again');
});

test('a main-branch CI failure can enter the queue, while successful runs cannot', () => {
  const intake = read('api', 'status-hub-ingest.js');
  const workflow = read('.github', 'workflows', 'report-devtodo-failure.yml');
  const guard = read('api', '_lib', 'guard.js');
  assert.match(intake, /STATUS_HUB_INGEST_SECRET/);
  assert.match(intake, /source !== 'github_ci'/);
  assert.match(intake, /timingSafeEqual/);
  assert.match(guard, /'\/api\/status-hub-ingest'/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /conclusion == 'failure'/);
  assert.doesNotMatch(workflow, /conclusion == 'success'/);
});

test('Vercel and Supabase log drains have their own authenticated, failure-only intake', () => {
  const drain = read('api', 'status-hub-log-drain.js');
  const guard = read('api', '_lib', 'guard.js');
  assert.match(drain, /STATUS_HUB_LOG_DRAIN_SECRET/);
  assert.match(drain, /timingSafeEqual/);
  assert.match(drain, /src !== 'vercel' && src !== 'supabase'/);
  // Only entries recognized as real errors may become findings -- ordinary
  // request/response traffic in a log drain batch must never turn into
  // Dev To-Do noise.
  assert.match(drain, /entry\.level !== 'error'/);
  assert.match(guard, /'\/api\/status-hub-log-drain'/);
});

// ---- Resolved-by attribution (Chris, 2026-08-18) -------------------------
// "In the Resolved items list, show who resolved each item -- not just that
// it's resolved."

test('the resolved_by migration is additive and adds nothing else', () => {
  const migration = read('supabase', 'migrations', '20260819020000_app_status_findings_resolved_by.sql');
  assert.match(migration, /add column if not exists resolved_by uuid references auth\.users\(id\)/i);
  // Additive only: no backfill, no rewrite of existing rows, nothing that
  // scripts/check-migration-replay-safety.mjs would (rightly) refuse.
  assert.doesNotMatch(migration, /^\s*(update|delete|truncate|drop)\s/im);
});

// Drives the real setFindingStatus against a stubbed PostgREST so the
// assertions are about what actually gets WRITTEN, not about source text.
function stubSupabase(handler) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
    seen.push(call);
    return handler(call) || { ok: true, status: 200, json: async () => ([{ id: 'f-1' }]), text: async () => '[]' };
  };
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
}
const patchOf = (seen) => seen.filter((c) => c.method === 'PATCH');

test('closing a finding writes who closed it', async () => {
  const stub = stubSupabase(() => null);
  try {
    await setFindingStatus('f-1', 'resolved', 'fixed in #461', 'user-9');
    const [patch] = patchOf(stub.seen);
    assert.equal(patch.body.resolved_by, 'user-9');
    assert.equal(typeof patch.body.resolved_at, 'string');
    // updated_by stays the last toucher; it is not repurposed as the resolver.
    assert.equal(patch.body.updated_by, 'user-9');
  } finally { stub.restore(); }
});

test('ignoring counts as closing, and reopening clears the resolver', async () => {
  for (const [status, expected] of [['ignored', 'user-9'], ['open', null], ['in_progress', null]]) {
    const stub = stubSupabase(() => null);
    try {
      await setFindingStatus('f-1', status, null, 'user-9');
      const [patch] = patchOf(stub.seen);
      // resolved_by must track the CURRENT closure exactly the way resolved_at
      // does, so it can never describe a stale one.
      assert.equal(patch.body.resolved_by, expected, status);
      assert.equal(patch.body.resolved_at === null, expected === null, status);
    } finally { stub.restore(); }
  }
});

test('triage still works in the window before the migration is applied by hand', async () => {
  // The 20260819020000 migration is run by Chris, not by this code, so there
  // is a window where the column is absent. Attribution may be lost there;
  // the ability to triage at all must not be.
  let firstPatch = true;
  const stub = stubSupabase((call) => {
    if (call.method !== 'PATCH') return null;
    if (firstPatch) {
      firstPatch = false;
      return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'PGRST204', message: "Could not find the 'resolved_by' column of 'app_status_findings'" }) };
    }
    return null;
  });
  try {
    const row = await setFindingStatus('f-1', 'resolved', null, 'user-9');
    const patches = patchOf(stub.seen);
    assert.equal(patches.length, 2);
    assert.equal('resolved_by' in patches[0].body, true);
    assert.equal('resolved_by' in patches[1].body, false);
    // The retry still records the closure itself -- only the attribution drops.
    assert.equal(patches[1].body.status, 'resolved');
    assert.equal(typeof patches[1].body.resolved_at, 'string');
    assert.ok(row);
  } finally { stub.restore(); }
});

test('a genuine update failure is still an error, not silently retried away', async () => {
  const stub = stubSupabase((call) => (call.method === 'PATCH'
    ? { ok: false, status: 400, text: async () => JSON.stringify({ code: '23514', message: 'violates check constraint' }) }
    : null));
  try {
    await assert.rejects(() => setFindingStatus('f-1', 'resolved', null, 'user-9'), /Could not update finding/);
    assert.equal(patchOf(stub.seen).length, 1);
  } finally { stub.restore(); }
});

// ---- Recurrence reopens resolved findings (jomell, 2026-08-22) -----------
// A self-test run kept re-reporting the exact same NO_OUTCOME findings jomell
// had already marked resolved, but they never came back into the Open tab --
// observeFinding() refreshed evidence/timestamps on the existing row without
// ever touching `status`, so a recurring-but-"fixed" problem stayed invisible.

test('a finding recurring after being marked resolved reopens automatically', async () => {
  const stub = stubSupabase((call) => {
    if (call.method === 'GET') return { ok: true, status: 200, json: async () => ([{ id: 'f-1', status: 'resolved' }]) };
    return null;
  });
  try {
    await observeFindings([{ source: 'selftest', fingerprint: 'abc123', title: 'NO OUTCOME — Save', detail: 'x', severity: 'low', evidence: {} }]);
    const patch = patchOf(stub.seen)[0];
    assert.equal(patch.body.status, 'open');
    assert.equal(patch.body.resolved_at, null);
    assert.equal(patch.body.resolved_by, null);
    assert.match(patch.body.status_note, /Recurred/);
    const event = stub.seen.find((c) => c.url.includes('app_status_events'));
    assert.ok(event, 'expected a status_changed event logging the reopen');
    assert.equal(event.body.event_type, 'status_changed');
    assert.match(event.body.detail, /^open: recurred via selftest/);
  } finally { stub.restore(); }
});

test('a finding the human is ignoring does not reopen when it recurs', async () => {
  const stub = stubSupabase((call) => {
    if (call.method === 'GET') return { ok: true, status: 200, json: async () => ([{ id: 'f-2', status: 'ignored' }]) };
    return null;
  });
  try {
    await observeFindings([{ source: 'selftest', fingerprint: 'def456', title: 'NO OUTCOME — Save', detail: 'x', severity: 'low', evidence: {} }]);
    const patch = patchOf(stub.seen)[0];
    assert.equal('status' in patch.body, false, 'an ignored finding must not have its status touched on recurrence');
    assert.ok(!stub.seen.some((c) => c.url.includes('app_status_events')), 'ignoring a finding must not log a reopen event');
  } finally { stub.restore(); }
});

test('a finding that is already open just gets its evidence refreshed on recurrence', async () => {
  const stub = stubSupabase((call) => {
    if (call.method === 'GET') return { ok: true, status: 200, json: async () => ([{ id: 'f-3', status: 'open' }]) };
    return null;
  });
  try {
    await observeFindings([{ source: 'selftest', fingerprint: 'ghi789', title: 'NO OUTCOME — Save', detail: 'x', severity: 'low', evidence: {} }]);
    const patch = patchOf(stub.seen)[0];
    assert.equal('status' in patch.body, false);
    assert.equal('resolved_at' in patch.body, false);
    assert.ok(!stub.seen.some((c) => c.url.includes('app_status_events')));
  } finally { stub.restore(); }
});

test('resolver ids become display names on read, and unknown ones stay null', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ([{ id: 'u-1', full_name: 'Jomell', email: 'j@x.com' }]) };
  };
  try {
    const rows = await withResolverNames([
      { id: 'a', status: 'resolved', resolved_by: 'u-1' },
      { id: 'b', status: 'resolved', resolved_by: 'u-gone' },
      { id: 'c', status: 'resolved', resolved_by: null },
    ]);
    assert.equal(rows[0].resolved_by_name, 'Jomell');
    // A resolver we cannot name comes back null so the UI can say "Unknown" --
    // it is never filled in with a plausible-looking substitute.
    assert.equal(rows[1].resolved_by_name, null);
    assert.equal(rows[2].resolved_by_name, null);
    // One batched profiles lookup for the whole page, not one per row.
    assert.equal(calls.length, 1);
    assert.match(calls[0], /profiles\?id=in\./);
  } finally { globalThis.fetch = realFetch; }
});

test('a findings list with no resolvers needs no profile lookup at all', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  try {
    const rows = await withResolverNames([{ id: 'a', status: 'open' }]);
    assert.equal(rows[0].resolved_by_name, null);
  } finally { globalThis.fetch = realFetch; }
});

test('a resolved item renders the resolver name, falling back to Unknown', () => {
  const page = read('public', 'index.html');
  assert.match(page, /function devTodoResolverHtml\(f\)/);
  // Only on closed findings -- an open item has no resolver to name. Since
  // #421 these are the dimmed rows the "show resolved" toggle reveals inline,
  // not a separate tab, so the line must key off the finding's own status
  // rather than any list-level view state.
  assert.match(page, /if \(!f \|\| \(f\.status !== 'resolved' && f\.status !== 'ignored'\)\) return '';/);
  assert.doesNotMatch(page.slice(page.indexOf('function devTodoResolverHtml'), page.indexOf('function devTodoShortDate')), /devTodoShowResolved/);
  assert.match(page, /f\.resolved_by_name \|\| 'Unknown'/);
  assert.match(page, /verb \+ ' by ' \+ who/);
  // The name is escaped like every other server-supplied string on this card.
  assert.match(page, /teamTodoEsc\(f\.resolved_by_name \|\| 'Unknown'\)/);
  // And it is actually wired into the card, not just defined.
  assert.match(page, /devTodoResolverHtml\(f\) \+ '<\/div>'/);
});

// ---- Screenshot/picture attachments (2026-08-19) -------------------------
// "i want it to have a feature where a user can attach screenshots or
// pictures so that the one who will fix it has a clear image what's wrong."

test('the attachments migration adds a service-role-only table and the private bucket', () => {
  const migration = read('supabase', 'migrations', '20260819030000_devtodo_attachments.sql');
  assert.match(migration, /create table if not exists public\.app_status_finding_attachments/i);
  assert.match(migration, /references public\.app_status_findings\(id\) on delete cascade/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.app_status_finding_attachments from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.app_status_finding_attachments to service_role/i);
  assert.match(migration, /insert into storage\.buckets \(id, name, public\)/i);
  assert.match(migration, /values \('devtodo-attachments', 'devtodo-attachments', false\)/i);
});

function stubStorageAndDb({ findingExists = true, existingAttachments = 0, uploadOk = true, insertOk = true } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (options && options.method) || 'GET', body: options && options.body, contentType: options && options.headers && options.headers['Content-Type'] });
    if (u.includes('/rest/v1/app_status_findings?')) {
      return { ok: true, status: 200, json: async () => (findingExists ? [{ id: 'f-1' }] : []), text: async () => '[]' };
    }
    if (u.includes('/rest/v1/app_status_finding_attachments?finding_id=')) {
      return { ok: true, status: 200, json: async () => Array.from({ length: existingAttachments }, (_, i) => ({ id: `a-${i}` })), text: async () => '[]' };
    }
    if (u.includes('/storage/v1/object/devtodo-attachments/')) {
      return { ok: uploadOk, status: uploadOk ? 200 : 502, json: async () => ({}), text: async () => (uploadOk ? '' : 'upload failed') };
    }
    if (u.includes('/rest/v1/app_status_finding_attachments') && (options.method === 'POST')) {
      return { ok: insertOk, status: insertOk ? 200 : 500, json: async () => ([{ id: 'att-1', finding_id: 'f-1', storage_path: 'f-1/x.png', content_type: 'image/png' }]), text: async () => (insertOk ? '' : 'insert failed') };
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// A tiny valid PNG (magic bytes + minimal IHDR) so validateScreenshotBase64's
// real sniff would accept it -- addFindingAttachment itself trusts the
// already-validated `shot` shape, so a plain object matching it is enough here.
const FAKE_SHOT = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', ext: 'png' };

test('attaching an image uploads to the finding-scoped path and records the row', async () => {
  const stub = stubStorageAndDb();
  try {
    const attachment = await addFindingAttachment('f-1', FAKE_SHOT, 'user-9');
    assert.equal(attachment.id, 'att-1');
    const upload = stub.calls.find((c) => c.url.includes('/storage/v1/object/devtodo-attachments/'));
    assert.ok(upload, 'expected a storage upload call');
    assert.match(upload.url, /\/storage\/v1\/object\/devtodo-attachments\/f-1\//);
    assert.equal(upload.contentType, 'image/png');
    const insert = stub.calls.find((c) => c.url.includes('/rest/v1/app_status_finding_attachments') && c.method === 'POST');
    assert.equal(JSON.parse(insert.body).finding_id, 'f-1');
    assert.equal(JSON.parse(insert.body).created_by, 'user-9');
  } finally { stub.restore(); }
});

test('an attachment cannot be attached to a finding that does not exist', async () => {
  const stub = stubStorageAndDb({ findingExists: false });
  try {
    await assert.rejects(() => addFindingAttachment('missing', FAKE_SHOT, 'user-9'), /not found/i);
    assert.ok(!stub.calls.some((c) => c.url.includes('/storage/v1/object/')), 'must not upload before the finding is confirmed to exist');
  } finally { stub.restore(); }
});

test('a finding already at the attachment cap refuses a fifth image', async () => {
  const stub = stubStorageAndDb({ existingAttachments: 4 });
  try {
    await assert.rejects(() => addFindingAttachment('f-1', FAKE_SHOT, 'user-9'), /too many/i);
    assert.ok(!stub.calls.some((c) => c.url.includes('/storage/v1/object/')), 'must not upload once the cap is already hit');
  } finally { stub.restore(); }
});

test('a storage upload failure is a real error, not a silently-recorded empty row', async () => {
  const stub = stubStorageAndDb({ uploadOk: false });
  try {
    await assert.rejects(() => addFindingAttachment('f-1', FAKE_SHOT, 'user-9'), /Could not store the attachment/);
    assert.ok(!stub.calls.some((c) => c.url.includes('/rest/v1/app_status_finding_attachments') && c.method === 'POST'), 'must not insert a row for a blob that never landed');
  } finally { stub.restore(); }
});

test('listFindingAttachments makes one batched query and skips it entirely for an empty list', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; return { ok: true, status: 200, json: async () => ([{ id: 'a-1', finding_id: 'f-1' }]) }; };
  try {
    assert.deepEqual(await listFindingAttachments([]), []);
    assert.equal(calls, 0);
    const rows = await listFindingAttachments(['f-1', 'f-1', 'f-2']);
    assert.equal(calls, 1);
    assert.equal(rows[0].id, 'a-1');
  } finally { globalThis.fetch = realFetch; }
});

test('the Dev To-Do route wiring signs attachments server-side and reuses the Monitor image validator', () => {
  const track1 = read('api', 'track1.js');
  assert.match(track1, /validateScreenshotBase64, requireMonitorAgent/);
  assert.match(track1, /listFindings, setFindingStatus, createManualFinding, listFindingAttachments, addFindingAttachment/);
  assert.match(track1, /async function handleAppStatusAttachmentUpload/);
  assert.match(track1, /resource === 'app_status_attachment_upload'/);
  assert.match(track1, /if \(!\(await canManageDevTodo\(requester\)\)\) return res\.status\(403\)\.json\(\{ ok: false, error: 'Only an admin can attach an image to a finding\.' \}\);/);
  assert.match(track1, /const shot = validateScreenshotBase64\(body\.imageBase64\);/);
  // Signed, short-lived URLs only -- the browser never gets a bare storage path
  // or the service key it would need to read the bucket directly.
  assert.match(track1, /storage\/v1\/object\/sign\/devtodo-attachments\//);
  assert.match(track1, /expiresIn: 300/);
  assert.match(track1, /attachSignedAttachments/);
});

test('the report-a-blocker form accepts images and the queue renders them as thumbnails', () => {
  const page = read('public', 'index.html');
  assert.match(page, /id="devtodo-new-images" type="file" accept="image\/png,image\/jpeg" multiple/);
  assert.match(page, /function devTodoAttachImages\(findingId, fileList\)/);
  assert.match(page, /resource=app_status_attachment_upload/);
  // Staged images from the create form upload AFTER the finding exists, since
  // the upload call needs a real finding_id.
  assert.match(page, /if \(pendingImages && d\.finding && d\.finding\.id\) \{ await devTodoAttachImages\(d\.finding\.id, pendingImages\); return; \}/);
  assert.match(page, /pics\.map\(function\(a\)\{/);
  assert.match(page, /object-fit:cover;border-radius:6px;border:1px solid var\(--line\)/);
  // The per-row attach control hides once the 4-image cap is reached rather
  // than letting a 5th upload fail server-side with no client-side hint.
  assert.match(page, /var attachCtl = attachCount >= 4 \? '' :/);
});

// jomell tested this live: the finding was created fine, but neither
// screenshot ever attached, silently -- no error, no toast.
test('staged images from the create form survive the file input being reset before upload', () => {
  const page = read('public', 'index.html');
  // images.files is a LIVE FileList. The very next line resets the input
  // (images.value = ''), which empties that same FileList in place -- so a
  // bare reference captured here would read back as length 0 by the time
  // devTodoAttachImages actually runs. Array.prototype.slice snapshots the
  // real File objects into a plain array the reset can't reach.
  assert.match(page, /var pendingImages = \(images && images\.files && images\.files\.length\) \? Array\.prototype\.slice\.call\(images\.files\) : null;/);
  const fn = page.slice(page.indexOf('async function devTodoCreateFinding'), page.indexOf('async function devTodoSetFinding'));
  const pendingIdx = fn.indexOf('var pendingImages');
  const resetIdx = fn.indexOf("images.value = ''");
  assert.ok(pendingIdx > -1 && resetIdx > -1 && pendingIdx < resetIdx, 'pendingImages must be captured before the input is reset');
});
