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

check('LIFECYCLE_PLAYBOOKS includes maintenance_reminders (other lifecycle-playbook sibling branches add their own entries when reconciled)', () => {
  assert.match(blockSrc, /const LIFECYCLE_PLAYBOOKS = \[[^\]]*'maintenance_reminders'[^\]]*\];/);
});

check('jobs are filtered by a recurring-maintenance keyword match, unlike the other job-keyed playbooks', () => {
  assert.match(blockSrc, /MAINTENANCE_KEYWORDS/);
  assert.match(blockSrc, /function isMaintenanceJobTitle/);
});

check('reduces jobs to each client\'s single most recent MATCHING job before applying the window', () => {
  assert.match(blockSrc, /lastMaintenanceJobByClient/);
});

check('window constants: 330-395 days (annual cadence), distinct from service_anniversary\'s 350-380 one-time window', () => {
  assert.match(blockSrc, /MAINTENANCE_REMINDER_MIN_DAYS = 330/);
  assert.match(blockSrc, /MAINTENANCE_REMINDER_MAX_DAYS = 395/);
});

check('already-contacted check is WINDOWED (like newsletter), not all-time (like dormant_reactivation)', () => {
  assert.match(blockSrc, /MAINTENANCE_REMINDER_DEDUP_WINDOW_DAYS = 300/);
  assert.match(blockSrc, /fetchAllRows\('campaigns', `\?select=id&type=eq\.maintenance_reminders&created_at=gte\.\$\{encodeURIComponent\(cutoff\)\}`\)/);
});

check('reuses the real suppression/consent gating pattern (channel=eq.email)', () => {
  assert.match(blockSrc, /marketing_suppressions.*channel=eq\.email/);
  assert.match(blockSrc, /marketing_consent_ledger.*channel=eq\.email&status=eq\.revoked/);
});

check('already-contacted check is keyed by client, not job (real campaign_recipients call)', () => {
  assert.match(blockSrc, /target_record_type=eq\.client/);
});

function clientDisplayName(c) {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null;
}

function norm(v) {
  return JSON.parse(JSON.stringify(v));
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function makeSandbox({ jobs = [], clients = [], suppressions = [], consent = [], recentCampaigns = [], recipients = [], throwOnJobs = null } = {}) {
  const calls = [];
  const fetchAllRows = async (table, query) => {
    calls.push({ table, query });
    if (table === 'jobs') {
      if (throwOnJobs) throw throwOnJobs;
      return jobs;
    }
    if (table === 'marketing_suppressions') return suppressions;
    if (table === 'marketing_consent_ledger') return consent;
    if (table === 'campaigns') return recentCampaigns;
    if (table === 'campaign_recipients') return recipients;
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
    Math,
    console,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return { sandbox, calls };
}

check('functional: maintenance-keyword job ~365 days old with a real client email returns a candidate', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Gutter Cleaning Maintenance', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Alice', email: 'alice@example.com' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 1);
  assert.equal(data.candidates[0].clientId, 'c1');
  assert.equal(data.candidates[0].clientName, 'Alice');
  assert.equal(data.candidates[0].lastMaintenanceJobTitle, 'Gutter Cleaning Maintenance');
});

check('functional: a completed job whose title does not match any maintenance keyword is ignored entirely', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Deck Build', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Bob', email: 'bob@example.com' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.totalDueForReminder, 0);
});

check('functional: only the most recent MATCHING job per client counts -- an older matching job masked by a newer matching job outside the window is excluded', async () => {
  const { sandbox } = makeSandbox({
    jobs: [
      { jobber_id: 'j1', client_id: 'c1', title: 'HVAC Tune-up', completed_at: daysAgoIso(365) },
      { jobber_id: 'j2', client_id: 'c1', title: 'HVAC Tune-up', completed_at: daysAgoIso(30) },
    ],
    clients: [{ jobber_id: 'c1', name: 'Carl', email: 'carl@example.com' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
});

check('functional: maintenance job just under the 330-day floor (too recent) is excluded', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Seasonal Service', completed_at: daysAgoIso(200) }],
    clients: [{ jobber_id: 'c1', name: 'Dana', email: 'dana@example.com' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.totalDueForReminder, 0);
});

check('functional: maintenance job past the 395-day ceiling (too old) is excluded', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Inspection', completed_at: daysAgoIso(500) }],
    clients: [{ jobber_id: 'c1', name: 'Eve', email: 'eve@example.com' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.totalDueForReminder, 0);
});

check('functional: client with no email is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Cleaning Service', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Frank', email: null }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedNoEmail, 1);
});

check('functional: suppressed client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Maintenance Visit', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Gail', email: 'gail@example.com' }],
    suppressions: [{ client_id: 'c1' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: revoked consent client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Tune-up', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Hank', email: 'hank@example.com' }],
    consent: [{ client_id: 'c1' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: client contacted within the dedup window (windowed campaigns fetch returns a match) is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Gutter Cleaning', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Ivy', email: 'ivy@example.com' }],
    recentCampaigns: [{ id: 'camp1' }],
    recipients: [{ target_record_id: 'c1' }],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedAlreadyContacted, 1);
});

check('functional: client contacted OUTSIDE the dedup window (windowed fetch returns nothing) is treated as eligible again', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Gutter Cleaning', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Jack', email: 'jack@example.com' }],
    recentCampaigns: [],
    recipients: [],
  });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 1);
});

check('functional: zero jobs in window makes no client/suppression/consent/campaigns fetch calls', async () => {
  const { sandbox, calls } = makeSandbox({ jobs: [] });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.candidates.length, 0);
  const wastedCalls = calls.filter((c) => c.table !== 'jobs');
  assert.equal(wastedCalls.length, 0);
});

check('functional: notSynced error on jobs fetch degrades honestly instead of throwing', async () => {
  const err = new Error('relation "jobs" does not exist');
  err.notSynced = true;
  const { sandbox } = makeSandbox({ throwOnJobs: err });
  const data = await sandbox.computeMaintenanceReminderCandidates();
  assert.equal(data.notSynced, true);
  assert.deepEqual(norm(data.candidates), []);
  assert.equal(data.minDays, 330);
  assert.equal(data.maxDays, 395);
});

check('functional: a non-notSynced error on jobs fetch rethrows', async () => {
  const err = new Error('boom');
  const { sandbox } = makeSandbox({ throwOnJobs: err });
  await assert.rejects(() => sandbox.computeMaintenanceReminderCandidates(), /boom/);
});

check('handleLifecycleCandidatesGet: rejects any playbook other than maintenance_reminders with 400', async () => {
  const { sandbox } = makeSandbox({ jobs: [] });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'unsold_estimates' } }, res);
  assert.equal(statusCode, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /maintenance_reminders/);
});

check('handleLifecycleCandidatesGet: 200 + ok:true + playbook + data for the real playbook', async () => {
  const { sandbox } = makeSandbox({
    jobs: [{ jobber_id: 'j1', client_id: 'c1', title: 'Annual Maintenance', completed_at: daysAgoIso(365) }],
    clients: [{ jobber_id: 'c1', name: 'Kate', email: 'kate@example.com' }],
  });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'maintenance_reminders' } }, res);
  assert.equal(statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.playbook, 'maintenance_reminders');
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
