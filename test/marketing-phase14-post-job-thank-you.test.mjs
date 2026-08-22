// Phase 14 -- Lifecycle marketing playbooks. First real playbook: post-job
// thank-you. resource=lifecycle_candidates (GET) finds real completed jobs
// eligible for a thank-you send, gated through the same real
// marketing_suppressions/marketing_consent_ledger tables every other real
// send in this suite is gated through (see handleCampaignSendPost). This is
// read-only -- it finds candidates, it does not send anything.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function norm(v) { return JSON.parse(JSON.stringify(v)); }

function extractLifecycleSource() {
  const start = api.indexOf('// ---------- Lifecycle playbooks (Phase 14)');
  assert.ok(start > -1, 'expected the Phase 14 Lifecycle playbooks section header to exist');
  const end = api.indexOf('export default async function handler(req, res) {', start);
  assert.ok(end > start, 'expected the exported handler to follow the Lifecycle playbooks section');
  return api.slice(start, end);
}

function loadLifecycleFns(overrides) {
  const calls = { fetchAllRows: [], supabaseRequest: [] };
  const sandbox = {
    // clientDisplayName is a small pure helper defined elsewhere in
    // api/marketing.js (reused, not redefined here) -- mirrored exactly so
    // this test doesn't need to pull in the whole file's unrelated
    // dependencies (Anthropic SDK, email lib) just to run one helper.
    clientDisplayName(c) { return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null; },
    fetchAllRows: async (table, query) => {
      calls.fetchAllRows.push({ table, query });
      const fn = (overrides && overrides.fetchAllRows) || (() => []);
      return fn(table, query);
    },
    supabaseRequest: async (path) => {
      calls.supabaseRequest.push(path);
      const fn = (overrides && overrides.supabaseRequest) || (() => ({ ok: true, json: async () => [] }));
      return fn(path);
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractLifecycleSource(), sandbox);
  return { sandbox, calls };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// ---------- Structural / wiring checks ----------

check('resource=lifecycle_candidates is wired into the dispatch chain right after process_scheduled_sends', () => {
  const idx = api.indexOf("resource === 'process_scheduled_sends' && req.method === 'GET')");
  assert.ok(idx > -1, 'expected the process_scheduled_sends GET dispatch to exist');
  const chunk = api.slice(idx, idx + 300);
  assert.match(chunk, /resource === 'lifecycle_candidates' && req\.method === 'GET'/);
  assert.match(chunk, /return await handleLifecycleCandidatesGet\(req, res\);/);
});

check('the resource-list error string documents lifecycle_candidates (GET)', () => {
  // Loosened further: a sibling attribution-snapshot branch appended
  // attribution_snapshot (POST) right after lifecycle_candidates (GET) once
  // merged, so lifecycle_candidates is no longer the last entry and the
  // period no longer immediately follows -- only presence matters now.
  assert.match(api, /lifecycle_candidates \(GET\)/);
});

check('computePostJobThankYouCandidates fetches from jobs.completed_at -- no new column, no migration for reading', () => {
  const fn = extractLifecycleSource();
  assert.match(fn, /fetchAllRows\(\s*\n?\s*'jobs'/);
  assert.match(fn, /completed_at=not\.is\.null/);
});

check('computePostJobThankYouCandidates applies the same real suppression/consent gate as handleCampaignSendPost', () => {
  const fn = extractLifecycleSource();
  assert.match(fn, /fetchAllRows\('marketing_suppressions'/);
  assert.match(fn, /fetchAllRows\('marketing_consent_ledger'/);
  assert.match(fn, /channel=eq\.email/);
});

check('handleLifecycleCandidatesGet rejects any playbook other than the real ones with an honest 400', () => {
  // Loosened: the per-branch single-playbook check was replaced by a shared
  // LIFECYCLE_PLAYBOOKS.includes() dispatcher once post_job_thank_you and
  // service_anniversary were reconciled into siblings.
  const fn = extractLifecycleSource();
  assert.match(fn, /!LIFECYCLE_PLAYBOOKS\.includes\(playbook\)/);
  assert.match(fn, /not built yet/);
});

// ---------- Behavior ----------

check('computePostJobThankYouCandidates returns an eligible candidate with real client/job fields', async () => {
  const { sandbox, calls } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') {
        return [{ jobber_id: 'j1', client_id: 'c1', title: 'Roof repair', completed_at: '2026-07-25T00:00:00Z' }];
      }
      if (table === 'campaigns') return []; // no post_job_thank_you campaigns exist yet
      if (table === 'campaign_recipients') return [];
      if (table === 'marketing_suppressions') return [];
      if (table === 'marketing_consent_ledger') return [];
      throw new Error('unexpected table: ' + table);
    },
    supabaseRequest: async () => ({
      ok: true,
      json: async () => [{ jobber_id: 'c1', name: 'Jane Doe', email: 'jane@example.com' }],
    }),
  });
  const data = await sandbox.computePostJobThankYouCandidates();
  assert.strictEqual(data.candidates.length, 1);
  assert.deepStrictEqual(norm(data.candidates[0]), {
    jobId: 'j1', clientId: 'c1', clientName: 'Jane Doe', jobTitle: 'Roof repair', completedAt: '2026-07-25T00:00:00Z',
  });
  assert.strictEqual(data.windowDays, 14);
  assert.strictEqual(data.totalCompletedJobsInWindow, 1);
  assert.strictEqual(data.skippedNoClient, 0);
  assert.strictEqual(data.skippedAlreadyContacted, 0);
  assert.strictEqual(data.skippedSuppressedOrRevoked, 0);
  assert.strictEqual(data.skippedNoEmail, 0);
});

check('computePostJobThankYouCandidates excludes a job whose client is suppressed for email', async () => {
  const { sandbox } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') return [{ jobber_id: 'j1', client_id: 'c1', title: 'Deck build', completed_at: '2026-07-25T00:00:00Z' }];
      if (table === 'campaigns') return [];
      if (table === 'campaign_recipients') return [];
      if (table === 'marketing_suppressions') return [{ client_id: 'c1' }];
      if (table === 'marketing_consent_ledger') return [];
      throw new Error('unexpected table: ' + table);
    },
  });
  const data = await sandbox.computePostJobThankYouCandidates();
  assert.strictEqual(data.candidates.length, 0);
  assert.strictEqual(data.skippedSuppressedOrRevoked, 1);
});

check('computePostJobThankYouCandidates excludes a job whose client revoked email consent', async () => {
  const { sandbox } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') return [{ jobber_id: 'j1', client_id: 'c1', title: 'Fence repair', completed_at: '2026-07-25T00:00:00Z' }];
      if (table === 'campaigns') return [];
      if (table === 'campaign_recipients') return [];
      if (table === 'marketing_suppressions') return [];
      if (table === 'marketing_consent_ledger') return [{ client_id: 'c1' }];
      throw new Error('unexpected table: ' + table);
    },
  });
  const data = await sandbox.computePostJobThankYouCandidates();
  assert.strictEqual(data.candidates.length, 0);
  assert.strictEqual(data.skippedSuppressedOrRevoked, 1);
});

check('computePostJobThankYouCandidates excludes a job already thanked (real campaign_recipients row against a real post_job_thank_you campaign)', async () => {
  const { sandbox } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') return [{ jobber_id: 'j1', client_id: 'c1', title: 'Gutter clean', completed_at: '2026-07-25T00:00:00Z' }];
      if (table === 'campaigns') return [{ id: 'camp1' }];
      if (table === 'campaign_recipients') return [{ target_record_id: 'j1' }];
      if (table === 'marketing_suppressions') return [];
      if (table === 'marketing_consent_ledger') return [];
      throw new Error('unexpected table: ' + table);
    },
  });
  const data = await sandbox.computePostJobThankYouCandidates();
  assert.strictEqual(data.candidates.length, 0);
  assert.strictEqual(data.skippedAlreadyContacted, 1);
});

check('computePostJobThankYouCandidates excludes a job whose client has no real email on file, never fabricating one', async () => {
  const { sandbox } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') return [{ jobber_id: 'j1', client_id: 'c1', title: 'Paint job', completed_at: '2026-07-25T00:00:00Z' }];
      if (table === 'campaigns') return [];
      if (table === 'campaign_recipients') return [];
      if (table === 'marketing_suppressions') return [];
      if (table === 'marketing_consent_ledger') return [];
      throw new Error('unexpected table: ' + table);
    },
    supabaseRequest: async () => ({ ok: true, json: async () => [{ jobber_id: 'c1', name: 'No Email Guy' }] }),
  });
  const data = await sandbox.computePostJobThankYouCandidates();
  assert.strictEqual(data.candidates.length, 0);
  assert.strictEqual(data.skippedNoEmail, 1);
});

check('computePostJobThankYouCandidates never fabricates a fetch for suppression/consent when there are zero eligible clients', async () => {
  const { sandbox, calls } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') return [];
      throw new Error('unexpected table: ' + table);
    },
  });
  const data = await sandbox.computePostJobThankYouCandidates();
  assert.deepStrictEqual(norm(data.candidates), []);
  const suppressionCalls = calls.fetchAllRows.filter((c) => c.table === 'marketing_suppressions');
  assert.strictEqual(suppressionCalls.length, 0);
});

check('computePostJobThankYouCandidates honestly degrades to an empty, flagged result when jobs is not synced', async () => {
  const { sandbox } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') { const e = new Error('not_synced:jobs'); e.notSynced = true; throw e; }
      throw new Error('unexpected table: ' + table);
    },
  });
  const data = await sandbox.computePostJobThankYouCandidates();
  assert.deepStrictEqual(norm(data.candidates), []);
  assert.strictEqual(data.notSynced, true);
});

check('computePostJobThankYouCandidates re-throws a non-notSynced error rather than silently swallowing it', async () => {
  const { sandbox } = loadLifecycleFns({
    fetchAllRows: async (table) => {
      if (table === 'jobs') throw new Error('boom');
      throw new Error('unexpected table: ' + table);
    },
  });
  await assert.rejects(() => sandbox.computePostJobThankYouCandidates(), /boom/);
});

check('handleLifecycleCandidatesGet returns 400 for an unbuilt playbook, honestly naming only the real one', async () => {
  const { sandbox } = loadLifecycleFns({ fetchAllRows: async () => [] });
  const req = { query: { playbook: 'unsold_estimates' } };
  const res = makeRes();
  await sandbox.handleLifecycleCandidatesGet(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /post_job_thank_you/);
  assert.match(res.body.error, /not built yet/);
});

check('handleLifecycleCandidatesGet returns 200 with the real playbook echoed back for post_job_thank_you', async () => {
  const { sandbox } = loadLifecycleFns({ fetchAllRows: async () => [] });
  const req = { query: { playbook: 'post_job_thank_you' } };
  const res = makeRes();
  await sandbox.handleLifecycleCandidatesGet(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.playbook, 'post_job_thank_you');
  assert.deepStrictEqual(norm(res.body.candidates), []);
});

let pass = 0, fail = 0;
const results = [];
for (const { name, fn } of checks) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      results.push(r.then(() => { pass++; console.log(`  ok  - ${name}`); }).catch((e) => { fail++; console.log(`  not ok  - ${name}\n    ${e.message}`); }));
    } else {
      pass++;
      console.log(`  ok  - ${name}`);
    }
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.message}`);
  }
}
Promise.all(results).then(() => {
  console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
  process.exit(fail ? 1 : 0);
});
