// test/reina-proposals.test.mjs
// Overhead Registries + Payroll Integration — Slice 6.
// Governance: Reina drafts reina_cost_proposals; a human approves. An APPROVED
// proposal writes through to the target (and confirms it); a REJECTED one does
// not. Fully mocked — no network, no DB.
// Run: node --experimental-test-module-mocks --test test/reina-proposals.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

const helpers = await import('../api/_lib/reina-proposals.js');
const registries = await import('../api/registries.js');

// ---- pure helpers --------------------------------------------------------
test('proposalTargetPatch: burden_rate -> patch confirms the employee_pay row', () => {
  const t = helpers.proposalTargetPatch({ proposal_type: 'burden_rate', target_table: 'employee_pay', target_id: 'ep1', proposed_value: { payroll_tax_pct: 8.1, other_burden_pct: 5 } });
  assert.equal(t.table, 'employee_pay');
  assert.equal(t.id, 'ep1');
  assert.deepEqual(t.patch, { source: 'confirmed', payroll_tax_pct: 8.1, other_burden_pct: 5 });
});
test('proposalTargetPatch: unknown type -> null (nothing written)', () => {
  assert.equal(helpers.proposalTargetPatch({ proposal_type: 'assumption', target_table: 'cost_assumptions', target_id: 'x' }), null);
});

test('buildBurdenProposals: proposes on change, skips no-change and rejected', () => {
  const rows = [
    { id: 'ep1', payroll_tax_pct: 7.65, other_burden_pct: 0 }, // differs -> propose
    { id: 'ep2', payroll_tax_pct: 8.1, other_burden_pct: 5 },  // same -> skip
  ];
  const burden = { payroll_tax_pct: 8.1, other_burden_pct: 5, runs: 4 };
  const out = helpers.buildBurdenProposals(rows, burden, [{ period_start: '2026-07-01' }], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].target_id, 'ep1');
  assert.equal(out[0].confidence, 100); // 4 runs
  // now with a matching rejection recorded, it must NOT be re-proposed
  const rejected = [{ status: 'rejected', target_table: 'employee_pay', target_id: 'ep1', proposed_value: { payroll_tax_pct: 8.1, other_burden_pct: 5 } }];
  assert.equal(helpers.buildBurdenProposals(rows, burden, [], rejected).length, 0);
});

// ---- handler: approve writes through, reject does not --------------------
function res() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function jsonRes(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) }; }

function makeFetch(calls) {
  return async (url, opts) => {
    const u = String(url); const method = (opts && opts.method) || 'GET';
    calls.push([method, u]);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/company_members')) return jsonRes([{ company_id: 'gh-1', role: 'owner' }]);
    if (u.includes('/rest/v1/companies')) return jsonRes([{ id: 'gh-1' }]);
    // pending proposal lookup
    if (u.includes('/rest/v1/reina_cost_proposals') && u.includes('status=eq.pending') && method === 'GET')
      return jsonRes([{ id: 'prop-1', proposal_type: 'burden_rate', target_table: 'employee_pay', target_id: 'ep1', proposed_value: { payroll_tax_pct: 8.1, other_burden_pct: 5 }, status: 'pending' }]);
    if (u.includes('/rest/v1/employee_pay') && method === 'PATCH') return jsonRes([{ id: 'ep1' }]);
    if (u.includes('/rest/v1/reina_cost_proposals') && method === 'PATCH') return jsonRes([{ id: 'prop-1' }]);
    if (u.includes('/rest/v1/company_rates')) return jsonRes([{ company_id: 'gh-1', overhead_total: 0 }]);
    if (u.includes('/rest/v1/registry_overhead')) return jsonRes([]);
    return jsonRes({ error: 'unhandled ' + u }, 500);
  };
}
async function callProposals(body, calls) {
  const original = global.fetch; global.fetch = makeFetch(calls);
  try {
    const req = { method: 'POST', query: { resource: 'proposals' }, headers: { authorization: 'Bearer t' }, body };
    const r = res(); await registries.default(req, r); return r;
  } finally { global.fetch = original; }
}

test('approve: applies the value to employee_pay (writes through)', async () => {
  const calls = [];
  const r = await callProposals({ action: 'approve', ids: ['prop-1'] }, calls);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.applied, 1);
  const wroteTarget = calls.some(([m, u]) => m === 'PATCH' && u.includes('/rest/v1/employee_pay'));
  assert.ok(wroteTarget, 'approve must PATCH employee_pay');
});

test('reject: does NOT touch employee_pay, only marks the proposal', async () => {
  const calls = [];
  const r = await callProposals({ action: 'reject', ids: ['prop-1'] }, calls);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rejected, 1);
  const wroteTarget = calls.some(([m, u]) => m === 'PATCH' && u.includes('/rest/v1/employee_pay'));
  assert.ok(!wroteTarget, 'reject must NOT write employee_pay');
  const markedProposal = calls.some(([m, u]) => m === 'PATCH' && u.includes('/rest/v1/reina_cost_proposals'));
  assert.ok(markedProposal, 'reject marks the proposal rejected');
});
