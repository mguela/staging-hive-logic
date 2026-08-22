import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'api', 'marketing.js');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

function extractConstLine(src, declSnippet) {
  const start = src.indexOf(declSnippet);
  if (start === -1) throw new Error('const line not found: ' + declSnippet);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  const closeParenBrace = src.indexOf(') {', declStart);
  if (closeParenBrace === -1) throw new Error('opening brace not found for: ' + declSnippet);
  const braceStart = closeParenBrace + 2;
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

const PAGE_SIZE_SRC = extractConstLine(source, 'const PAGE_SIZE = 1000;');
const MAX_PAGES_SRC = extractConstLine(source, 'const MAX_PAGES = 10;');
const REVIEW_WINDOW_SRC = extractConstLine(source, 'const REVIEW_ASK_WINDOW_DAYS = 60;');
const FETCH_ALL_ROWS_SRC = extractFunction(source, 'async function fetchAllRows(table, query) {');
const CLIENT_DISPLAY_NAME_SRC = extractFunction(source, 'function clientDisplayName(c) {');
const HANDLE_REVIEW_QUEUE_GET_SRC = extractFunction(source, 'async function handleReviewQueueGet(req, res) {');

const blockSrc = [PAGE_SIZE_SRC, MAX_PAGES_SRC, REVIEW_WINDOW_SRC, FETCH_ALL_ROWS_SRC, CLIENT_DISPLAY_NAME_SRC, HANDLE_REVIEW_QUEUE_GET_SRC].join('\n\n');

const FIXED_NOW = '2026-06-15T00:00:00.000Z';
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }
}
FakeDate.now = () => new Date(FIXED_NOW).getTime();

function daysAgoIso(n) {
  return new Date(new Date(FIXED_NOW).getTime() - n * 86400000).toISOString();
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) {
      res._status = code;
      return { json: (body) => { res._body = body; } };
    },
  };
  return res;
}

function makeSupabaseMock({ jobs, clients, reviewRequests, reviewRequestsError }) {
  return async (urlString) => {
    if (urlString.startsWith('jobs')) {
      return { ok: true, json: async () => jobs };
    }
    if (urlString.startsWith('clients')) {
      return { ok: true, json: async () => clients };
    }
    if (urlString.startsWith('review_requests')) {
      if (reviewRequestsError) {
        return { ok: false, text: async () => reviewRequestsError };
      }
      return { ok: true, json: async () => reviewRequests || [] };
    }
    throw new Error('unexpected table in mock: ' + urlString);
  };
}

async function runHandler({ jobs, clients, reviewRequests, reviewRequestsError }) {
  const sandbox = {
    supabaseRequest: makeSupabaseMock({ jobs, clients, reviewRequests, reviewRequestsError }),
    Date: FakeDate,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: 'api/marketing.js' });
  const res = makeRes();
  await sandbox.handleReviewQueueGet({ headers: {} }, res);
  return res;
}

const CLIENTS = [
  { jobber_id: 'c-a', name: 'Alice Anderson', email: 'alice@example.com' },
  { jobber_id: 'c-b', name: null, first_name: 'Bob', last_name: 'Baker', email: 'bob@example.com' },
  { jobber_id: 'c-c', name: 'Carol Carlson', email: null },
  { jobber_id: 'c-d', name: 'Dave Davidson', email: 'dave@example.com' },
  { jobber_id: 'c-f', name: null, first_name: null, last_name: null, company_name: 'Acme Corp', email: 'acme@example.com' },
  { jobber_id: 'c-g', name: 'Grace Green', email: 'grace@example.com' },
  { jobber_id: 'c-h', name: null, first_name: null, last_name: null, company_name: null, email: 'noone@example.com' },
];

const JOBS = [
  { jobber_id: 'j-a', client_id: 'c-a', job_number: 'A1', title: 'Roof repair', total: 1000, completed_at: daysAgoIso(10) },
  { jobber_id: 'j-b', client_id: 'c-b', job_number: 'B1', title: 'Deck build', total: 2000, completed_at: daysAgoIso(90) },
  { jobber_id: 'j-c', client_id: 'c-c', job_number: 'C1', title: 'Fence repair', total: 500, completed_at: daysAgoIso(5) },
  { jobber_id: 'j-d', client_id: 'c-d', job_number: 'D1', title: 'Painting', total: 1500, completed_at: daysAgoIso(3) },
  { jobber_id: 'j-e', client_id: null, job_number: 'E1', title: 'Unknown client job', total: 300, completed_at: daysAgoIso(2) },
  { jobber_id: 'j-f', client_id: 'c-f', job_number: 'F1', title: 'Gutter clean', total: 400, completed_at: daysAgoIso(60) },
  { jobber_id: 'j-g', client_id: 'c-g', job_number: 'G1', title: 'Window wash', total: 250, completed_at: daysAgoIso(61) },
  { jobber_id: 'j-h', client_id: 'c-h', job_number: 'H1', title: 'Pressure wash', total: 350, completed_at: daysAgoIso(1) },
];

const REVIEW_REQUESTS = [
  { job_id: 'j-d', status: 'sent' },
];

test('real handleReviewQueueGet computes totals, dedupes actioned, and windows correctly against real fixtures', async () => {
  const res = await runHandler({ jobs: JOBS, clients: CLIENTS, reviewRequests: REVIEW_REQUESTS });
  assert.strictEqual(res._status, 200);
  const body = res._body;
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.totalCompletedJobs, 8);
  assert.strictEqual(body.withEmail, 6); // A,B,D,F,G,H have email; C has null email; E has no client
  assert.strictEqual(body.alreadyActioned, 1); // only D
  assert.strictEqual(body.returned, 5); // A,B,F,G,H
  assert.strictEqual(body.windowDays, 60);
  assert.strictEqual(body.withinWindowCount, 3); // A(10), F(60 boundary), H(1) within; B(90), G(61) not
  const byJobId = new Map(body.pending.map((p) => [p.jobId, p]));
  assert.ok(!byJobId.has('j-c'), 'no-email job must be excluded from pending');
  assert.ok(!byJobId.has('j-d'), 'actioned job must be excluded from pending');
  assert.ok(!byJobId.has('j-e'), 'no-client job must be excluded from pending');
  assert.strictEqual(byJobId.get('j-a').ageDays, 10);
  assert.strictEqual(byJobId.get('j-b').ageDays, 90);
  assert.strictEqual(byJobId.get('j-f').ageDays, 60);
  assert.strictEqual(byJobId.get('j-g').ageDays, 61);
});

test('real clientDisplayName resolution used inside the handler: full name, first+last join, company fallback, and honest "Unnamed client"', async () => {
  const res = await runHandler({ jobs: JOBS, clients: CLIENTS, reviewRequests: REVIEW_REQUESTS });
  const byJobId = new Map(res._body.pending.map((p) => [p.jobId, p]));
  assert.strictEqual(byJobId.get('j-a').clientName, 'Alice Anderson');
  assert.strictEqual(byJobId.get('j-b').clientName, 'Bob Baker');
  assert.strictEqual(byJobId.get('j-f').clientName, 'Acme Corp');
  assert.strictEqual(byJobId.get('j-h').clientName, 'Unnamed client');
});

test('real handler honestly degrades to "nothing actioned" when review_requests table is not synced yet', async () => {
  const res = await runHandler({
    jobs: JOBS,
    clients: CLIENTS,
    reviewRequestsError: 'relation "public.review_requests" does not exist',
  });
  const body = res._body;
  assert.strictEqual(body.alreadyActioned, 0, 'nothing can be marked actioned when the table does not exist');
  const byJobId = new Map(body.pending.map((p) => [p.jobId, p]));
  assert.ok(byJobId.has('j-d'), 'job D reappears in the queue once the actioned-tracking table is unavailable');
});

test('real handler propagates a genuine (non-not-synced) review_requests failure instead of swallowing it', async () => {
  await assert.rejects(
    () => runHandler({
      jobs: JOBS,
      clients: CLIENTS,
      reviewRequestsError: 'permission denied for table review_requests',
    }),
    /permission denied/,
  );
});

test('real handler propagates a jobs-fetch failure (fetchAllRows for jobs/clients is never try/caught)', async () => {
  const sandbox = {
    supabaseRequest: async (urlString) => {
      if (urlString.startsWith('jobs')) return { ok: false, text: async () => 'relation "public.jobs" does not exist' };
      if (urlString.startsWith('clients')) return { ok: true, json: async () => CLIENTS };
      throw new Error('unexpected table in mock: ' + urlString);
    },
    Date: FakeDate,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: 'api/marketing.js' });
  const res = makeRes();
  await assert.rejects(
    () => sandbox.handleReviewQueueGet({ headers: {} }, res),
    /not_synced:jobs/,
  );
});

test('real handler returns an honest empty queue with all real fields present when there are no completed jobs at all', async () => {
  const res = await runHandler({ jobs: [], clients: [], reviewRequests: [] });
  const body = res._body;
  assert.strictEqual(body.totalCompletedJobs, 0);
  assert.strictEqual(body.withEmail, 0);
  assert.strictEqual(body.alreadyActioned, 0);
  assert.strictEqual(body.returned, 0);
  assert.deepStrictEqual([...body.pending], []);
});
