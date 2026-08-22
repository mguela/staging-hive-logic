// Reina M1a — change-request approvals surface (marketing.js resources +
// command-center UI). Extracts the two real handlers from api/marketing.js and
// runs them in a vm sandbox with a fake PostgREST, asserting query shapes,
// validation, the scoped PATCH, and the idempotent 409. Also checks that both
// touched source files stay syntactically valid.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const marketingPath = 'api/marketing.js';
const htmlPath = 'public/marketing-command-center/index.html';
const marketing = fs.readFileSync(marketingPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

function extractHandlers() {
  const start = marketing.indexOf('// ===== Reina M1a: change-request recommendations');
  const end = marketing.indexOf('// ===== end Reina M1a change-request approvals =====');
  assert.ok(start > -1 && end > start, 'handler block markers must be present');
  return marketing.slice(start, end);
}

function loadHandlers(fixtures) {
  const writes = [];
  const sandbox = {
    fetchAllRows: async (table, query) => {
      if (fixtures.notSynced) { const e = new Error('not synced'); e.notSynced = true; throw e; }
      sandbox.__lastRead = { table, query };
      return fixtures.rows || [];
    },
    supabaseRequest: async (path, options) => {
      writes.push({ path, options });
      return {
        ok: fixtures.patchOk !== false,
        json: async () => (fixtures.patchOk === false ? [] : (fixtures.updated || [])),
        text: async () => 'db error',
      };
    },
    String, Array, Number, encodeURIComponent, Date, console,
  };
  sandbox.__writes = writes;
  vm.createContext(sandbox);
  vm.runInContext(extractHandlers(), sandbox);
  return sandbox;
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

test('marketing.js and the command-center HTML stay valid', () => {
  execFileSync(process.execPath, ['--check', marketingPath]);
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  new vm.Script(html.slice(start, end), { filename: htmlPath });
});

test('the two resources are wired into the dispatch chain and the resource list', () => {
  assert.match(marketing, /resource === 'reina_change_requests' && req\.method === 'GET'/);
  assert.match(marketing, /resource === 'reina_change_request_decide' && req\.method === 'POST'/);
  assert.match(marketing, /reina_change_requests \(GET\), reina_change_request_decide \(POST\)/);
});

test('GET lists only pending reina_change_request rows and maps the fields', async () => {
  const sb = loadHandlers({ rows: [{
    id: 'a1', approvable_id: 'JOB1', title: 'Add lights', rationale: 'because',
    amount_cents: null, confidence: '68', risks: ['r1'],
    estimate: { scope_delta: 'add 4 lights', gaps: ['no spec'], needs_estimator_pricing: true, request_source: 'pasted_client_message', test_invocation: true },
    target_description: 'Job X for Tony', status: 'pending', created_at: '2026-08-02T00:00:00Z',
  }] });
  const res = fakeRes();
  await sb.handleReinaChangeRequestsGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.match(sb.__lastRead.query, /approvable_type=eq\.reina_change_request/);
  assert.match(sb.__lastRead.query, /status=eq\.pending/);
  const it = res.body.pending[0];
  assert.strictEqual(it.confidence, 68);
  assert.strictEqual(it.needsEstimatorPricing, true);
  assert.strictEqual(it.scopeDelta, 'add 4 lights');
  assert.deepStrictEqual(it.gaps, ['no spec']);
  assert.strictEqual(it.isTest, true);
});

test('GET degrades gracefully when the table is not migrated yet', async () => {
  const sb = loadHandlers({ notSynced: true });
  const res = fakeRes();
  await sb.handleReinaChangeRequestsGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.returned, 0);
  assert.match(res.body.note, /not set up yet/);
});

test('decide validates decision and id', async () => {
  const sb = loadHandlers({});
  let res = fakeRes();
  await sb.handleReinaChangeRequestDecidePost({ body: { id: '', decision: 'approved' } }, res);
  assert.strictEqual(res.statusCode, 400);
  res = fakeRes();
  await sb.handleReinaChangeRequestDecidePost({ body: { id: 'a1', decision: 'maybe' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(sb.__writes.length, 0, 'no write on invalid input');
});

test('decide PATCHes a pending row scoped by type+status and records the decider', async () => {
  const sb = loadHandlers({ updated: [{ id: 'a1', status: 'approved', decided_by: 'chris@ghgrp.net', decided_at: '2026-08-02T01:00:00Z' }] });
  const res = fakeRes();
  await sb.handleReinaChangeRequestDecidePost({ hlUser: { email: 'chris@ghgrp.net' }, body: { id: 'a1', decision: 'approved' } }, res);
  assert.strictEqual(res.statusCode, 200);
  const w = sb.__writes[0];
  assert.match(w.path, /id=eq\.a1/);
  assert.match(w.path, /approvable_type=eq\.reina_change_request/);
  assert.match(w.path, /status=eq\.pending/);
  assert.strictEqual(w.options.method, 'PATCH');
  const body = JSON.parse(w.options.body);
  assert.strictEqual(body.status, 'approved');
  assert.strictEqual(body.decided_by, 'chris@ghgrp.net');
  assert.ok(body.decided_at);
});

test('decide returns 409 when nothing pending matched (stale tab / double-click)', async () => {
  const sb = loadHandlers({ updated: [] });
  const res = fakeRes();
  await sb.handleReinaChangeRequestDecidePost({ hlUser: { email: 'x@y.z' }, body: { id: 'gone', decision: 'rejected' } }, res);
  assert.strictEqual(res.statusCode, 409);
});
