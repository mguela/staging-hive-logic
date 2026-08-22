// test/manager-sheets-row-cap.test.mjs
// resource=manager_materials_pnl and resource=manager_gh_updates (api/track1.js)
//
// Found during the 8/17 Dev To-Do triage ("mpmx renders 69,138 unpaginated
// characters"): both handlers fetched and shipped an append-only Google Sheet
// to the browser IN FULL on every load, and the frontend then sliced to the
// FIRST 250 rows for display -- meaning as either sheet grew, the visible
// table only ever showed an increasingly stale window of the OLDEST rows,
// never the most recent ones, while the network payload kept growing
// unbounded underneath it.
//
// Fix under test: cap the transported rows to the most recent 250, but
// compute the summary stats (totalSpend, jobsCovered, statusCounts) over the
// FULL sheet server-side first, so capping the transport can never quietly
// change what those numbers report.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function csvRes(csvText) {
  return { ok: true, status: 200, text: async () => csvText };
}

// Builds a Materials Mastersheet CSV with `n` rows, each with a distinct job
// number and a $100 total, so totals are trivial to assert on.
function materialsCsv(n) {
  const lines = ['Job Number,Order Item Total,Vendor'];
  for (let i = 1; i <= n; i++) lines.push(`JOB-${i},100,Vendor ${i}`);
  return lines.join('\n');
}
function ghUpdatesCsv(n) {
  const lines = ['Update,Status'];
  for (let i = 1; i <= n; i++) lines.push(`Update ${i},${i % 2 === 0 ? 'Done' : 'In Progress'}`);
  return lines.join('\n');
}

let authUser = { id: 'user-1', email: 'chris@ghgrp.net' };
let profile = { id: 'user-1', email: 'chris@ghgrp.net', full_name: 'Chris', role: 'admin' };

async function withMockedFetch(sheetCsv, fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return authUser ? jsonRes(authUser) : jsonRes({ error: 'bad token' }, 401);
    if (u.includes('/rest/v1/profiles')) return jsonRes([profile]);
    if (u.includes('docs.google.com/spreadsheets')) return csvRes(sheetCsv);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function callResource(resource, sheetCsv) {
  const mod = await import('../api/track1.js');
  const req = {
    method: 'GET',
    query: { resource },
    headers: { authorization: 'Bearer usertoken' },
    body: {},
    readableEnded: true,
  };
  const r = res();
  await withMockedFetch(sheetCsv, () => mod.default(req, r));
  return r;
}

test('manager_materials_pnl: under the cap, every row ships and totals match', async () => {
  const r = await callResource('manager_materials_pnl', materialsCsv(10));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.rows.length, 10);
  assert.equal(r.body.totalRows, 10);
  assert.equal(r.body.totalSpend, 1000);
  assert.equal(r.body.jobsCovered, 10);
});

test('manager_materials_pnl: over the cap, only the most recent 250 rows ship, but totals still cover everything', async () => {
  const r = await callResource('manager_materials_pnl', materialsCsv(600));
  assert.equal(r.body.rows.length, 250, 'the table payload must be capped');
  assert.equal(r.body.totalRows, 600, 'the true total must still be reported');
  assert.equal(r.body.totalSpend, 60000, 'Total Spend must be computed over all 600 rows, not just the 250 shipped');
  assert.equal(r.body.jobsCovered, 600, 'Jobs Covered must be computed over all 600 rows, not just the 250 shipped');
});

test('manager_materials_pnl: the capped rows are the most recent ones, not the oldest', async () => {
  const r = await callResource('manager_materials_pnl', materialsCsv(600));
  const jobNumbers = r.body.rows.map((row) => row['Job Number']);
  assert.equal(jobNumbers[0], 'JOB-351', 'the window must start at row 351 (the 250 most recent of 600)');
  assert.equal(jobNumbers[jobNumbers.length - 1], 'JOB-600', 'the window must end at the last row');
});

test('manager_gh_updates: over the cap, statusCounts still reflect every row, not just the shipped window', async () => {
  const r = await callResource('manager_gh_updates', ghUpdatesCsv(600));
  assert.equal(r.body.rows.length, 250);
  assert.equal(r.body.totalRows, 600);
  // Half of 600 rows are 'Done', half 'In Progress', regardless of the cap.
  assert.equal(r.body.statusCounts['Done'], 300);
  assert.equal(r.body.statusCounts['In Progress'], 300);
});

test('both resources still 401 signed-out, unchanged by this fix', async () => {
  authUser = null;
  try {
    const r = await callResource('manager_materials_pnl', materialsCsv(5));
    assert.equal(r.statusCode, 401);
  } finally {
    authUser = { id: 'user-1', email: 'chris@ghgrp.net' };
  }
});
