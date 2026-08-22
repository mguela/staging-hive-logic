// test/jobs-margin-list.test.mjs
// 2026-08-15 (jomell): the Jobs page's "Margin list" tab was entirely static
// illustrative demo copy -- fake job names/margins claiming to be "live from
// job costs" -- sitting next to the real, Jobber-synced Production board.
// computeJobsMarginList() replaces it with the SAME real Jobber-contract +
// QuickBooks Customer:Job-actual-cost join api/track1.js's existing
// margin-fade watcher already uses, just returning every active job instead
// of only the ones crossing the fade tripwire, and honestly labeling jobs
// QuickBooks has no cost coding for instead of omitting or fabricating them.
// Run with: node --experimental-test-module-mocks --test test/jobs-margin-list.test.mjs

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let qboIsConnected = true;
let costingData = { jobs: [], matchedLines: 0, unmatchedAmount: 0 };
let costingStale = false;
mock.module('../api/qbo/index.js', {
  namedExports: {
    qboConnected: async () => qboIsConnected,
    getFinancialsDurable: async () => ({ data: costingData, cachedAt: new Date().toISOString(), stale: costingStale, refresh: null }),
    getFinancials: async () => ({}),
  },
});

let jobsRows = [];
mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      const p = String(path);
      if (p.startsWith('jobs')) return { ok: true, json: async () => jobsRows };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

const { computeJobsMarginList } = await import('../api/track1.js');

test('QuickBooks not connected: honest error, not a fabricated list', async () => {
  qboIsConnected = false;
  const result = await computeJobsMarginList();
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /QuickBooks is not connected/);
});

test('a job with real QBO cost coding gets a real, computed margin (not the old fake fixed numbers)', async () => {
  qboIsConnected = true;
  jobsRows = [{ jobber_id: 'j1', job_number: '2417', title: 'Jones Kitchen', total: 86000, job_status: 'active', jobber_web_uri: 'https://jobber.example/j1' }];
  costingData = { jobs: [{ jobNumber: '2417', actualCost: 53320, lineCount: 4 }], matchedLines: 4, unmatchedAmount: 0 };
  const result = await computeJobsMarginList();
  assert.equal(result.body.ok, true);
  const row = result.body.jobs.find(j => j.jobNumber === '2417');
  assert.ok(row);
  assert.equal(row.hasCostData, true);
  assert.equal(row.contractTotal, 86000);
  assert.equal(row.actualCostSoFar, 53320);
  assert.equal(row.percentOfContractSpent, 62);
  assert.equal(row.marginPct, 38); // 100 - 62, the exact numbers the old fake demo row happened to show
});

test('a job QuickBooks has no cost coding for is labeled honestly, not fabricated', async () => {
  qboIsConnected = true;
  jobsRows = [{ jobber_id: 'j2', job_number: '2420', title: 'Kim Kitchen', total: 82000, job_status: 'active', jobber_web_uri: 'https://jobber.example/j2' }];
  costingData = { jobs: [], matchedLines: 0, unmatchedAmount: 0 };
  const result = await computeJobsMarginList();
  const row = result.body.jobs.find(j => j.jobNumber === '2420');
  assert.equal(row.hasCostData, false);
  assert.equal(row.marginPct, null);
  assert.equal(row.actualCostSoFar, null);
  assert.match(result.body.coverageNote, /no cost data yet/);
});

test('worst margin sorts first; jobs with no cost data sort to the bottom', async () => {
  qboIsConnected = true;
  jobsRows = [
    { jobber_id: 'a', job_number: '1', title: 'Good margin job', total: 100000, jobber_web_uri: '' },
    { jobber_id: 'b', job_number: '2', title: 'Bad margin job', total: 100000, jobber_web_uri: '' },
    { jobber_id: 'c', job_number: '3', title: 'No cost data job', total: 100000, jobber_web_uri: '' },
  ];
  costingData = {
    jobs: [
      { jobNumber: '1', actualCost: 60000, lineCount: 1 }, // 40% margin
      { jobNumber: '2', actualCost: 90000, lineCount: 1 }, // 10% margin
    ],
    matchedLines: 2, unmatchedAmount: 0,
  };
  const result = await computeJobsMarginList();
  const order = result.body.jobs.map(j => j.jobNumber);
  assert.deepEqual(order, ['2', '1', '3']);
});
