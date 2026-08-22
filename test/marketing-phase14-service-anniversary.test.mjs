import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------- Static source checks (whole-file, not vm-extracted) ----------

check('dispatch wiring: resource=lifecycle_candidates GET routes to handleLifecycleCandidatesGet', () => {
  assert.match(
    raw,
    /if \(resource === 'lifecycle_candidates' && req\.method === 'GET'\) \{\s*return await handleLifecycleCandidatesGet\(req, res\);\s*\}/
  );
});

check('resource-list error string mentions lifecycle_candidates (GET)', () => {
  const errLine = raw.split('\n').find((l) => l.includes('resource must be one of:'));
  assert.ok(errLine, 'expected to find the resource-list error string');
  assert.match(errLine, /lifecycle_candidates \(GET\)/);
});

// ---------- vm-extraction of the Phase 14 lifecycle playbook block ----------

const startMarker = '// ---------- Lifecycle playbooks (Phase 14) ----------';
const endMarker = 'export default async function handler';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find the Phase 14 lifecycle playbooks block start marker');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the exported handler after the lifecycle block');
const blockSrc = raw.slice(startIdx, endIdx);

check('LIFECYCLE_PLAYBOOKS includes service_anniversary', () => {
  // Loosened: post_job_thank_you and service_anniversary were built on independent
  // branches and reconciled into one shared array -- only presence, not
  // exclusivity, is a valid assertion once both are merged.
  assert.match(blockSrc, /const LIFECYCLE_PLAYBOOKS = \[[^\]]*'service_anniversary'[^\]]*\];/);
});

check('window constants: 350-380 days', () => {
  assert.match(blockSrc, /SERVICE_ANNIVERSARY_MIN_DAYS = 350/);
  assert.match(blockSrc, /SERVICE_ANNIVERSARY_MAX_DAYS = 380/);
});

check('reuses the real suppression/consent gating pattern (channel=eq.email)', () => {
  assert.match(blockSrc, /marketing_suppressions.*channel=eq\.email/);
  assert.match(blockSrc, /marketing_consent_ledger.*channel=eq\.email&status=eq\.revoked/);
});

function clientDisplayName(c) {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null;
}

function makeSandbox({ jobs = [], anniversaryCampaigns = [], recipients = [], suppressions = [], consent = [], clients = [], throwOnJobs = null } = {}) {
  const calls = [];
  const fetchAllRows = async (table, query) => {
    calls.push({ table, query });
    if (table === 'jobs') {
      if (throwOnJobs) throw throwOnJobs;
      return jobs;
    }
    if (table === 'campaigns') return anniversaryCampaigns;
    if (table === 'campaign_recipients') return recipients;
    if (table === 'marketing_suppressions') return suppressions;
    if (table === 'marketing_consent_ledger') return consent;
    throw new Error(`unexpected fetchAllRows table: ${table}`);
  };
  const supabaseRequest = async (path) => {
    calls.push({ table: 'clients_supabaseRequest', query: path });
    return {
      ok: true,
      json: async () => clients,
    };
  };
  const sandbox = {
    fetchAllRows,
    supabaseRequest,
    clientDisplayName,
    encodeURIComponent,
    Promise,
    Set,
    Map,
    Date,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox);
  return { sandbox, calls };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function norm(v) {
  return JSON.parse(JSON.stringify(v));
}

check('functional: eligible job with client+email returns a candidate with anniversaryDate', async () => {
  const completedAt = daysAgoIso(365);
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Roof repair', completed_at: completedAt }],
    clients: [{ jobber_id: 'c1', name: 'Alice', email: 'alice@example.com' }],
  });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.candidates.length, 1);
  const cand = norm(data.candidates[0]);
  assert.equal(cand.jobId, 'j1');
  assert.equal(cand.clientId, 'c1');
  assert.equal(cand.clientName, 'Alice');
  assert.equal(cand.jobTitle, 'Roof repair');
  const expectedAnniversary = new Date(new Date(completedAt).getTime() + 365 * 86400000).toISOString();
  assert.equal(cand.anniversaryDate, expectedAnniversary);
  assert.equal(data.skippedNoEmail, 0);
  assert.equal(data.skippedNoClient, 0);
  assert.equal(data.skippedAlreadyContacted, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 0);
});

check('functional: client with no email is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Deck build', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Bob', email: null }],
  });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedNoEmail, 1);
});

check('functional: suppressed client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Fence', completed_at: daysAgoIso(365) }],
    suppressions: [{ client_id: 'c1' }],
    clients: [{ jobber_id: 'c1', name: 'Carl', email: 'carl@example.com' }],
  });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: revoked consent client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Painting', completed_at: daysAgoIso(365) }],
    consent: [{ client_id: 'c1' }],
    clients: [{ jobber_id: 'c1', name: 'Dana', email: 'dana@example.com' }],
  });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: already-contacted job (matching campaign_recipients) is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Gutter clean', completed_at: daysAgoIso(365) }],
    anniversaryCampaigns: [{ id: 'camp1' }],
    recipients: [{ target_record_id: 'j1' }],
    clients: [{ jobber_id: 'c1', name: 'Eve', email: 'eve@example.com' }],
  });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedAlreadyContacted, 1);
});

check('functional: job with no client_id is excluded and counted as skippedNoClient', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: null, title: 'Orphan job', completed_at: daysAgoIso(365) }],
  });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedNoClient, 1);
});

check('functional: zero eligible jobs makes no suppression/consent/clients fetch calls', async () => {
  const { sandbox, calls } = makeSandbox({ jobs: [] });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.candidates.length, 0);
  const wastedCalls = calls.filter((c) => c.table === 'marketing_suppressions' || c.table === 'marketing_consent_ledger' || c.table === 'clients_supabaseRequest');
  assert.equal(wastedCalls.length, 0);
});

check('functional: notSynced error on jobs fetch degrades honestly instead of throwing', async () => {
  const err = new Error('relation "jobs" does not exist');
  err.notSynced = true;
  const { sandbox } = makeSandbox({ throwOnJobs: err });
  const data = await sandbox.computeServiceAnniversaryCandidates();
  assert.equal(data.notSynced, true);
  assert.deepEqual(norm(data.candidates), []);
  assert.equal(data.minDays, 350);
  assert.equal(data.maxDays, 380);
});

check('functional: a non-notSynced error on jobs fetch rethrows', async () => {
  const err = new Error('boom');
  const { sandbox } = makeSandbox({ throwOnJobs: err });
  await assert.rejects(() => sandbox.computeServiceAnniversaryCandidates(), /boom/);
});

check('handleLifecycleCandidatesGet: rejects any playbook other than service_anniversary with 400', async () => {
  const { sandbox } = makeSandbox({ jobs: [] });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  // post_job_thank_you is now a real, valid sibling playbook (reconciled from its
  // own branch) -- use a genuinely-nonexistent playbook name to test rejection.
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'not_a_real_playbook' } }, res);
  assert.equal(statusCode, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /service_anniversary/);
});

check('handleLifecycleCandidatesGet: 200 + ok:true + playbook + data for the real playbook', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Window install', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Frank', email: 'frank@example.com' }],
  });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'service_anniversary' } }, res);
  assert.equal(statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.playbook, 'service_anniversary');
  assert.equal(body.candidates.length, 1);
});

// ---------- Runner ----------

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
