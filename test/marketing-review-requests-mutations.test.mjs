import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'api', 'marketing.js');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  if (declSnippet[declSnippet.length - 1] !== '{') throw new Error('declSnippet must end with the opening brace: ' + declSnippet);
  const braceStart = declStart + declSnippet.length - 1;
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

function extractConstLine(src, declSnippet) {
  const start = src.indexOf(declSnippet);
  if (start === -1) throw new Error('const line not found: ' + declSnippet);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

// Real, unmodified source for the two review_requests write endpoints plus
// their shared fetchAllRows dependency.
const PAGE_SIZE_SRC = extractConstLine(source, 'const PAGE_SIZE = ');
const MAX_PAGES_SRC = extractConstLine(source, 'const MAX_PAGES = ');
const FETCH_ALL_ROWS_SRC = extractFunction(source, 'async function fetchAllRows(table, query) {');
const HANDLE_POST_SRC = extractFunction(source, 'async function handleReviewRequestsPost(req, res) {');
const HANDLE_BULK_SRC = extractFunction(source, 'async function handleReviewRequestsBulkPost(req, res) {');
const LOG_AUDIT_EVENT_SRC = extractFunction(source, 'async function logMarketingAuditEvent(category, action, entityType, entityId, actor, details) {');
const blockSrc = [PAGE_SIZE_SRC, MAX_PAGES_SRC, FETCH_ALL_ROWS_SRC, LOG_AUDIT_EVENT_SRC, HANDLE_POST_SRC, HANDLE_BULK_SRC].join('\n\n');

function makeRes() {
  const calls = [];
  return {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(body) { calls.push({ status: this._status, body }); return this; },
    _calls: calls,
  };
}

function makeSandbox(supabaseRequestImpl, fixedNowIso) {
  const FIXED_NOW = fixedNowIso ? new Date(fixedNowIso).getTime() : Date.parse('2026-08-02T12:00:00.000Z');
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(FIXED_NOW);
      else super(...args);
    }
  }
  FakeDate.now = () => FIXED_NOW;
  const sandbox = { supabaseRequest: supabaseRequestImpl, Date: FakeDate, console, Promise, Set, Map };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

// ---------------------------------------------------------------------
// handleReviewRequestsPost
// ---------------------------------------------------------------------

test('handleReviewRequestsPost: missing jobId is rejected honestly with 400, never reaches supabaseRequest', async () => {
  let called = false;
  const sandbox = makeSandbox(async () => { called = true; return { ok: true }; });
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { status: 'sent' } }, res);
  assert.strictEqual(res._calls[0].status, 400);
  assert.strictEqual(res._calls[0].body.ok, false);
  assert.match(res._calls[0].body.error, /jobId is required/);
  assert.strictEqual(called, false);
});

test('handleReviewRequestsPost: an invalid status value is rejected with 400', async () => {
  const sandbox = makeSandbox(async () => ({ ok: true }));
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { jobId: 'job-1', status: 'ignored' } }, res);
  assert.strictEqual(res._calls[0].status, 400);
  assert.match(res._calls[0].body.error, /'sent' or 'dismissed'/);
});

test('handleReviewRequestsPost: status=sent sends the real row shape (channel=email, sent_at set, dismissed_reason null)', async () => {
  let captured = null;
  const sandbox = makeSandbox(async (path, opts) => {
    // Phase 19 follow-up (test coverage fix): handleReviewRequestsPost now
    // also calls logMarketingAuditEvent(...) after the main upsert, which
    // issues its own supabaseRequest('marketing_audit_events', ...) call --
    // guard the capture to the real row-shape assertion this test cares
    // about, so the audit-event call doesn't silently overwrite it.
    if (path.startsWith('review_requests')) {
      captured = { path, body: JSON.parse(opts.body) };
    }
    return { ok: true };
  });
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { jobId: 'job-1', clientId: 'client-9', status: 'sent' } }, res);
  assert.strictEqual(captured.path, 'review_requests?on_conflict=job_id');
  assert.strictEqual(captured.body.job_id, 'job-1');
  assert.strictEqual(captured.body.client_id, 'client-9');
  assert.strictEqual(captured.body.channel, 'email');
  assert.strictEqual(captured.body.status, 'sent');
  assert.strictEqual(captured.body.sent_at, '2026-08-02T12:00:00.000Z');
  assert.strictEqual(captured.body.dismissed_reason, null);
  assert.strictEqual(res._calls[0].status, 200);
  assert.deepStrictEqual({ ...res._calls[0].body }, { ok: true, jobId: 'job-1', status: 'sent' });
});

test('handleReviewRequestsPost: status=dismissed with a reason sends channel=null, sent_at=null, and the real reason', async () => {
  let captured = null;
  const sandbox = makeSandbox(async (path, opts) => {
    // Phase 19 follow-up (test coverage fix): guard against the internal
    // logMarketingAuditEvent(...) call's own supabaseRequest overwriting
    // this capture (see comment above).
    if (path.startsWith('review_requests')) {
      captured = JSON.parse(opts.body);
    }
    return { ok: true };
  });
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { jobId: 'job-2', status: 'dismissed', dismissedReason: 'client asked not to be contacted' } }, res);
  assert.strictEqual(captured.channel, null);
  assert.strictEqual(captured.sent_at, null);
  assert.strictEqual(captured.dismissed_reason, 'client asked not to be contacted');
  assert.strictEqual(captured.status, 'dismissed');
});

test('handleReviewRequestsPost: status=dismissed with no reason falls back to an honest null, not a fabricated default', async () => {
  let captured = null;
  const sandbox = makeSandbox(async (path, opts) => {
    // Phase 19 follow-up (test coverage fix): guard against the internal
    // logMarketingAuditEvent(...) call's own supabaseRequest overwriting
    // this capture (see comment above).
    if (path.startsWith('review_requests')) {
      captured = JSON.parse(opts.body);
    }
    return { ok: true };
  });
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { jobId: 'job-3', status: 'dismissed' } }, res);
  assert.strictEqual(captured.dismissed_reason, null);
});

test('handleReviewRequestsPost: clientId is optional -- absent clientId sends client_id: null', async () => {
  let captured = null;
  const sandbox = makeSandbox(async (path, opts) => {
    // Phase 19 follow-up (test coverage fix): guard against the internal
    // logMarketingAuditEvent(...) call's own supabaseRequest overwriting
    // this capture (see comment above).
    if (path.startsWith('review_requests')) {
      captured = JSON.parse(opts.body);
    }
    return { ok: true };
  });
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { jobId: 'job-4', status: 'sent' } }, res);
  assert.strictEqual(captured.client_id, null);
});

test('handleReviewRequestsPost: a not-synced review_requests table degrades honestly to 200/ok:false, not a 500', async () => {
  const sandbox = makeSandbox(async () => ({
    ok: false,
    text: async () => 'relation "public.review_requests" does not exist',
  }));
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { jobId: 'job-5', status: 'sent' } }, res);
  assert.strictEqual(res._calls[0].status, 200);
  assert.strictEqual(res._calls[0].body.ok, false);
  assert.match(res._calls[0].body.error, /run sql\/020_review_requests\.sql/);
});

test('handleReviewRequestsPost: a genuine database error is propagated honestly as a real 500, never swallowed', async () => {
  const sandbox = makeSandbox(async () => ({
    ok: false,
    text: async () => 'permission denied for table review_requests',
  }));
  const res = makeRes();
  await sandbox.handleReviewRequestsPost({ body: { jobId: 'job-6', status: 'sent' } }, res);
  assert.strictEqual(res._calls[0].status, 500);
  assert.strictEqual(res._calls[0].body.ok, false);
  assert.strictEqual(res._calls[0].body.error, 'permission denied for table review_requests');
});

// ---------------------------------------------------------------------
// handleReviewRequestsBulkPost
// ---------------------------------------------------------------------

function makeFixtureSupabase({ jobs, clients, reviewRequests, reviewRequestsNotSynced, bulkPostResult }) {
  return async (pathAndQuery, opts) => {
    if (opts && opts.method === 'POST') {
      return bulkPostResult || { ok: true };
    }
    if (pathAndQuery.startsWith('jobs')) {
      return { ok: true, json: async () => jobs };
    }
    if (pathAndQuery.startsWith('clients')) {
      return { ok: true, json: async () => clients };
    }
    if (pathAndQuery.startsWith('review_requests')) {
      if (reviewRequestsNotSynced) {
        return { ok: false, text: async () => 'relation "public.review_requests" does not exist' };
      }
      return { ok: true, json: async () => reviewRequests };
    }
    throw new Error('unexpected supabaseRequest call: ' + pathAndQuery);
  };
}

test('handleReviewRequestsBulkPost: olderThanDays missing, zero, negative, or NaN is rejected with 400 before any fetch happens', async () => {
  for (const bad of [undefined, 0, -5, 'not-a-number', null]) {
    let fetchHappened = false;
    const sandbox = makeSandbox(async () => { fetchHappened = true; return { ok: true, json: async () => [] }; });
    const res = makeRes();
    await sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: bad } }, res);
    assert.strictEqual(res._calls[0].status, 400, 'bad value: ' + JSON.stringify(bad));
    assert.match(res._calls[0].body.error, /positive number/);
    assert.strictEqual(fetchHappened, false, 'must not fetch anything before validating olderThanDays: ' + JSON.stringify(bad));
  }
});

test('handleReviewRequestsBulkPost: real eligibility filtering -- only jobs with an emailed client, not already actioned, and older than the cutoff are bulk-dismissed', async () => {
  const NOW = Date.parse('2026-08-02T12:00:00.000Z');
  const days90 = new Date(NOW - 90 * 86400000).toISOString();
  const days30 = new Date(NOW - 30 * 86400000).toISOString();
  const jobs = [
    { jobber_id: 'j-old-with-email', client_id: 'c-1', completed_at: days90 }, // should be included
    { jobber_id: 'j-recent-with-email', client_id: 'c-2', completed_at: days30 }, // too recent -- excluded
    { jobber_id: 'j-old-no-email', client_id: 'c-3', completed_at: days90 }, // no client email -- excluded
    { jobber_id: 'j-old-already-actioned', client_id: 'c-4', completed_at: days90 }, // already actioned -- excluded
    { jobber_id: 'j-old-no-client', client_id: null, completed_at: days90 }, // no client at all -- excluded
  ];
  const clients = [
    { jobber_id: 'c-1', email: 'one@example.com' },
    { jobber_id: 'c-2', email: 'two@example.com' },
    { jobber_id: 'c-3', email: null },
    { jobber_id: 'c-4', email: 'four@example.com' },
  ];
  const reviewRequests = [{ job_id: 'j-old-already-actioned', status: 'dismissed' }];
  let capturedRows = null;
  const supa = makeFixtureSupabase({
    jobs, clients, reviewRequests,
    bulkPostResult: null, // filled below via wrapper
  });
  const sandbox = makeSandbox(async (pathAndQuery, opts) => {
    if (opts && opts.method === 'POST') { capturedRows = JSON.parse(opts.body); return { ok: true }; }
    return supa(pathAndQuery, opts);
  }, '2026-08-02T12:00:00.000Z');
  const res = makeRes();
  await sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: 60 } }, res);
  assert.strictEqual(capturedRows.length, 1, 'exactly one job qualifies for bulk dismissal');
  assert.strictEqual(capturedRows[0].job_id, 'j-old-with-email');
  assert.strictEqual(capturedRows[0].client_id, 'c-1');
  assert.strictEqual(capturedRows[0].channel, null);
  assert.strictEqual(capturedRows[0].status, 'dismissed');
  assert.strictEqual(capturedRows[0].sent_at, null);
  assert.strictEqual(capturedRows[0].dismissed_reason, 'bulk_backlog_clear (older than 60 days)');
  assert.strictEqual(res._calls[0].status, 200);
  assert.deepStrictEqual({ ...res._calls[0].body }, { ok: true, dismissedCount: 1 });
});

test('handleReviewRequestsBulkPost: zero qualifying jobs returns dismissedCount:0 and never calls the bulk POST at all', async () => {
  let postCalled = false;
  const supa = makeFixtureSupabase({ jobs: [], clients: [], reviewRequests: [] });
  const sandbox = makeSandbox(async (pathAndQuery, opts) => {
    if (opts && opts.method === 'POST') { postCalled = true; return { ok: true }; }
    return supa(pathAndQuery, opts);
  });
  const res = makeRes();
  await sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: 60 } }, res);
  assert.strictEqual(postCalled, false, 'no rows to write means no write should be attempted');
  assert.deepStrictEqual({ ...res._calls[0].body }, { ok: true, dismissedCount: 0 });
});

test('handleReviewRequestsBulkPost: a not-synced review_requests table is treated as "nothing actioned yet" and processing continues normally', async () => {
  const NOW = Date.parse('2026-08-02T12:00:00.000Z');
  const days90 = new Date(NOW - 90 * 86400000).toISOString();
  const jobs = [{ jobber_id: 'j-1', client_id: 'c-1', completed_at: days90 }];
  const clients = [{ jobber_id: 'c-1', email: 'a@example.com' }];
  let capturedRows = null;
  const supa = makeFixtureSupabase({ jobs, clients, reviewRequests: null, reviewRequestsNotSynced: true });
  const sandbox = makeSandbox(async (pathAndQuery, opts) => {
    if (opts && opts.method === 'POST') { capturedRows = JSON.parse(opts.body); return { ok: true }; }
    return supa(pathAndQuery, opts);
  }, '2026-08-02T12:00:00.000Z');
  const res = makeRes();
  await sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: 60 } }, res);
  assert.strictEqual(capturedRows.length, 1, 'the not-synced review_requests table must not block real jobs from being processed');
  assert.strictEqual(res._calls[0].body.ok, true);
});

test('handleReviewRequestsBulkPost: a genuine (non-not-synced) error from the review_requests read is NOT swallowed -- it propagates', async () => {
  const sandbox = makeSandbox(async (pathAndQuery, opts) => {
    if (pathAndQuery.startsWith('jobs')) return { ok: true, json: async () => [] };
    if (pathAndQuery.startsWith('clients')) return { ok: true, json: async () => [] };
    if (pathAndQuery.startsWith('review_requests')) return { ok: false, text: async () => 'permission denied for table review_requests' };
    throw new Error('unexpected: ' + pathAndQuery);
  });
  const res = makeRes();
  await assert.rejects(
    () => sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: 60 } }, res),
    /permission denied for table review_requests/
  );
});

test('handleReviewRequestsBulkPost: the bulk write hitting a not-synced table degrades honestly to 200/ok:false', async () => {
  const NOW = Date.parse('2026-08-02T12:00:00.000Z');
  const days90 = new Date(NOW - 90 * 86400000).toISOString();
  const jobs = [{ jobber_id: 'j-1', client_id: 'c-1', completed_at: days90 }];
  const clients = [{ jobber_id: 'c-1', email: 'a@example.com' }];
  const supa = makeFixtureSupabase({ jobs, clients, reviewRequests: [] });
  const sandbox = makeSandbox(async (pathAndQuery, opts) => {
    if (opts && opts.method === 'POST') return { ok: false, text: async () => 'relation "public.review_requests" does not exist' };
    return supa(pathAndQuery, opts);
  }, '2026-08-02T12:00:00.000Z');
  const res = makeRes();
  await sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: 60 } }, res);
  assert.strictEqual(res._calls[0].status, 200);
  assert.strictEqual(res._calls[0].body.ok, false);
  assert.match(res._calls[0].body.error, /run sql\/020_review_requests\.sql/);
});

test('handleReviewRequestsBulkPost: the bulk write hitting a genuine database error surfaces a real 500, never faked as success', async () => {
  const NOW = Date.parse('2026-08-02T12:00:00.000Z');
  const days90 = new Date(NOW - 90 * 86400000).toISOString();
  const jobs = [{ jobber_id: 'j-1', client_id: 'c-1', completed_at: days90 }];
  const clients = [{ jobber_id: 'c-1', email: 'a@example.com' }];
  const supa = makeFixtureSupabase({ jobs, clients, reviewRequests: [] });
  const sandbox = makeSandbox(async (pathAndQuery, opts) => {
    if (opts && opts.method === 'POST') return { ok: false, text: async () => 'connection timed out' };
    return supa(pathAndQuery, opts);
  }, '2026-08-02T12:00:00.000Z');
  const res = makeRes();
  await sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: 60 } }, res);
  assert.strictEqual(res._calls[0].status, 500);
  assert.strictEqual(res._calls[0].body.error, 'connection timed out');
});

test('handleReviewRequestsBulkPost: a job completed EXACTLY at the cutoff boundary is excluded (only strictly older than the cutoff qualifies)', async () => {
  const NOW = Date.parse('2026-08-02T12:00:00.000Z');
  const exactlyAtCutoff = new Date(NOW - 60 * 86400000).toISOString();
  const jobs = [{ jobber_id: 'j-boundary', client_id: 'c-1', completed_at: exactlyAtCutoff }];
  const clients = [{ jobber_id: 'c-1', email: 'a@example.com' }];
  let capturedRows = null;
  const supa = makeFixtureSupabase({ jobs, clients, reviewRequests: [] });
  const sandbox = makeSandbox(async (pathAndQuery, opts) => {
    if (opts && opts.method === 'POST') { capturedRows = JSON.parse(opts.body); return { ok: true }; }
    return supa(pathAndQuery, opts);
  }, '2026-08-02T12:00:00.000Z');
  const res = makeRes();
  await sandbox.handleReviewRequestsBulkPost({ body: { olderThanDays: 60 } }, res);
  // completedMs === cutoffMs -- the real condition is "completedMs > cutoffMs continue", so equal is NOT skipped, it qualifies.
  assert.strictEqual(capturedRows.length, 1, 'a job completed exactly at the cutoff instant should qualify (condition is strictly-greater-than to skip)');
});
