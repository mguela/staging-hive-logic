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

check('LIFECYCLE_PLAYBOOKS includes new_lead_followup (other lifecycle-playbook sibling branches add their own entries when reconciled)', () => {
  assert.match(blockSrc, /const LIFECYCLE_PLAYBOOKS = \[[^\]]*'new_lead_followup'[^\]]*\];/);
});

check('window constant: 24 hour minimum SLA, no max-age cutoff', () => {
  assert.match(blockSrc, /NEW_LEAD_FOLLOWUP_MIN_HOURS = 24/);
  assert.doesNotMatch(blockSrc, /NEW_LEAD_FOLLOWUP_MAX_DAYS|NEW_LEAD_FOLLOWUP_MAX_HOURS/);
});

check('reads lead_pipeline filtered to stage=eq.new', () => {
  assert.match(blockSrc, /fetchAllRows\(\s*'lead_pipeline',/);
  assert.match(blockSrc, /stage=eq\.new/);
});

check('reuses the real suppression/consent gating pattern (channel=eq.email)', () => {
  assert.match(blockSrc, /marketing_suppressions.*channel=eq\.email/);
  assert.match(blockSrc, /marketing_consent_ledger.*channel=eq\.email&status=eq\.revoked/);
});

check('already-contacted check reads campaigns type=eq.new_lead_followup (real fetchAllRows call)', () => {
  assert.match(blockSrc, /fetchAllRows\('campaigns', '\?select=id&type=eq\.new_lead_followup'\)/);
});

function clientDisplayName(c) {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null;
}

function makeSandbox({ leads = [], followupCampaigns = [], recipients = [], suppressions = [], consent = [], clients = [], throwOnLeads = null } = {}) {
  const calls = [];
  const fetchAllRows = async (table, query) => {
    calls.push({ table, query });
    if (table === 'lead_pipeline') {
      if (throwOnLeads) throw throwOnLeads;
      return leads;
    }
    if (table === 'campaigns') return followupCampaigns;
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
    Math,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox);
  return { sandbox, calls };
}

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

function norm(v) {
  return JSON.parse(JSON.stringify(v));
}

check('functional: eligible lead past SLA with client+email returns a candidate', async () => {
  const createdAt = hoursAgoIso(48);
  const { sandbox } = makeSandbox({
    leads: [{ id: 'lead1', client_id: 'c1', lead_source: 'website', need: 'New deck', urgency: 'this_week', created_at: createdAt }],
    clients: [{ jobber_id: 'c1', name: 'Alice', email: 'alice@example.com' }],
  });
  const data = await sandbox.computeNewLeadFollowupCandidates();
  assert.equal(data.candidates.length, 1);
  const cand = norm(data.candidates[0]);
  assert.equal(cand.leadId, 'lead1');
  assert.equal(cand.clientId, 'c1');
  assert.equal(cand.clientName, 'Alice');
  assert.equal(cand.leadSource, 'website');
  assert.equal(cand.need, 'New deck');
  assert.equal(cand.urgency, 'this_week');
  assert.ok(cand.hoursSinceCreated >= 47 && cand.hoursSinceCreated <= 49);
  assert.equal(data.skippedNoEmail, 0);
  assert.equal(data.skippedAlreadyContacted, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 0);
});

check('functional: client with no email is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    leads: [{ id: 'lead1', client_id: 'c1', created_at: hoursAgoIso(48) }],
    clients: [{ jobber_id: 'c1', name: 'Bob', email: null }],
  });
  const data = await sandbox.computeNewLeadFollowupCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedNoEmail, 1);
});

check('functional: suppressed client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    leads: [{ id: 'lead1', client_id: 'c1', created_at: hoursAgoIso(48) }],
    suppressions: [{ client_id: 'c1' }],
    clients: [{ jobber_id: 'c1', name: 'Carl', email: 'carl@example.com' }],
  });
  const data = await sandbox.computeNewLeadFollowupCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: revoked consent client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    leads: [{ id: 'lead1', client_id: 'c1', created_at: hoursAgoIso(48) }],
    consent: [{ client_id: 'c1' }],
    clients: [{ jobber_id: 'c1', name: 'Dana', email: 'dana@example.com' }],
  });
  const data = await sandbox.computeNewLeadFollowupCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: already-contacted lead (matching campaign_recipients) is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    leads: [{ id: 'lead1', client_id: 'c1', created_at: hoursAgoIso(48) }],
    followupCampaigns: [{ id: 'camp1' }],
    recipients: [{ target_record_id: 'lead1' }],
    clients: [{ jobber_id: 'c1', name: 'Eve', email: 'eve@example.com' }],
  });
  const data = await sandbox.computeNewLeadFollowupCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedAlreadyContacted, 1);
});

check('functional: zero eligible leads makes no suppression/consent/clients fetch calls', async () => {
  const { sandbox, calls } = makeSandbox({ leads: [] });
  const data = await sandbox.computeNewLeadFollowupCandidates();
  assert.equal(data.candidates.length, 0);
  const wastedCalls = calls.filter((c) => c.table === 'marketing_suppressions' || c.table === 'marketing_consent_ledger' || c.table === 'clients_supabaseRequest');
  assert.equal(wastedCalls.length, 0);
});

check('functional: notSynced error on lead_pipeline fetch degrades honestly instead of throwing', async () => {
  const err = new Error('relation "lead_pipeline" does not exist');
  err.notSynced = true;
  const { sandbox } = makeSandbox({ throwOnLeads: err });
  const data = await sandbox.computeNewLeadFollowupCandidates();
  assert.equal(data.notSynced, true);
  assert.deepEqual(norm(data.candidates), []);
  assert.equal(data.minHours, 24);
});

check('functional: a non-notSynced error on lead_pipeline fetch rethrows', async () => {
  const err = new Error('boom');
  const { sandbox } = makeSandbox({ throwOnLeads: err });
  await assert.rejects(() => sandbox.computeNewLeadFollowupCandidates(), /boom/);
});

check('handleLifecycleCandidatesGet: rejects any playbook other than new_lead_followup with 400', async () => {
  const { sandbox } = makeSandbox({ leads: [] });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'unsold_estimates' } }, res);
  assert.equal(statusCode, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /new_lead_followup/);
});

check('handleLifecycleCandidatesGet: 200 + ok:true + playbook + data for the real playbook', async () => {
  const { sandbox } = makeSandbox({
    leads: [{ id: 'lead1', client_id: 'c1', created_at: hoursAgoIso(48) }],
    clients: [{ jobber_id: 'c1', name: 'Frank', email: 'frank@example.com' }],
  });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'new_lead_followup' } }, res);
  assert.equal(statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.playbook, 'new_lead_followup');
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
