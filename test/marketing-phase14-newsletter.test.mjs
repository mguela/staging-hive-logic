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

check('LIFECYCLE_PLAYBOOKS includes newsletter (other lifecycle-playbook sibling branches add their own entries when reconciled)', () => {
  assert.match(blockSrc, /const LIFECYCLE_PLAYBOOKS = \[[^\]]*'newsletter'[^\]]*\];/);
});

check('window constant: 25-day cooldown between newsletter sends', () => {
  assert.match(blockSrc, /NEWSLETTER_MIN_DAYS_SINCE_LAST_SEND = 25/);
});

check('unlike dormant_reactivation, the already-contacted check is WINDOWED (created_at=gte cutoff), not all-time', () => {
  assert.match(blockSrc, /fetchAllRows\('campaigns', `\?select=id&type=eq\.newsletter&created_at=gte\.\$\{encodeURIComponent\(cutoff\)\}`\)/);
});

check('reuses the real suppression/consent gating pattern (channel=eq.email)', () => {
  assert.match(blockSrc, /marketing_suppressions.*channel=eq\.email/);
  assert.match(blockSrc, /marketing_consent_ledger.*channel=eq\.email&status=eq\.revoked/);
});

check('already-contacted check is keyed by client, not job or lead (real campaign_recipients call)', () => {
  assert.match(blockSrc, /target_record_type=eq\.client/);
});

check('clients are fetched via the real supabaseRequest call, not fetchAllRows', () => {
  assert.match(blockSrc, /supabaseRequest\('clients\?select=jobber_id,name,first_name,last_name,company_name,email'\)/);
});

function clientDisplayName(c) {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null;
}

function norm(v) {
  return JSON.parse(JSON.stringify(v));
}

function makeSandbox({ clients = [], suppressions = [], consent = [], recentCampaigns = [], recipients = [], throwOnClients = null } = {}) {
  const calls = [];
  const supabaseRequest = async (path) => {
    calls.push({ table: 'clients_supabaseRequest', query: path });
    if (throwOnClients) throw throwOnClients;
    return {
      ok: true,
      json: async () => clients,
    };
  };
  const fetchAllRows = async (table, query) => {
    calls.push({ table, query });
    if (table === 'marketing_suppressions') return suppressions;
    if (table === 'marketing_consent_ledger') return consent;
    if (table === 'campaigns') return recentCampaigns;
    if (table === 'campaign_recipients') return recipients;
    throw new Error(`unexpected fetchAllRows table: ${table}`);
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
    console,
    Object,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return { sandbox, calls };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

check('functional: eligible client with email, no suppression/consent/contact history returns a candidate', async () => {
  const { sandbox } = makeSandbox({
    clients: [{ jobber_id: 'c1', name: 'Alice', email: 'alice@example.com' }],
  });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 1);
  assert.equal(data.candidates[0].clientId, 'c1');
  assert.equal(data.candidates[0].clientName, 'Alice');
  assert.equal(data.totalActiveClients, 1);
});

check('functional: client with no email is excluded and counted, no wasted downstream fetches beyond required', async () => {
  const { sandbox } = makeSandbox({
    clients: [{ jobber_id: 'c1', name: 'Bob', email: null }],
  });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedNoEmail, 1);
});

check('functional: suppressed client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    clients: [{ jobber_id: 'c1', name: 'Carl', email: 'carl@example.com' }],
    suppressions: [{ client_id: 'c1' }],
  });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: revoked consent client is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    clients: [{ jobber_id: 'c1', name: 'Dana', email: 'dana@example.com' }],
    consent: [{ client_id: 'c1' }],
  });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedSuppressedOrRevoked, 1);
});

check('functional: client contacted within the cooldown window (returned by the windowed campaigns fetch) is excluded and counted', async () => {
  const { sandbox } = makeSandbox({
    clients: [{ jobber_id: 'c1', name: 'Eve', email: 'eve@example.com' }],
    recentCampaigns: [{ id: 'camp1' }],
    recipients: [{ target_record_id: 'c1' }],
  });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedAlreadyContacted, 1);
});

check('functional: client contacted OUTSIDE the cooldown window (the windowed fetch returns nothing) is treated as eligible again', async () => {
  const { sandbox } = makeSandbox({
    clients: [{ jobber_id: 'c1', name: 'Frank', email: 'frank@example.com' }],
    recentCampaigns: [],
    recipients: [],
  });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 1);
  assert.equal(data.candidates[0].clientId, 'c1');
});

check('functional: zero clients makes no suppression/consent/campaigns fetch calls', async () => {
  const { sandbox, calls } = makeSandbox({ clients: [] });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.totalActiveClients, 0);
  const wastedCalls = calls.filter((c) => c.table === 'marketing_suppressions' || c.table === 'marketing_consent_ledger' || c.table === 'campaigns' || c.table === 'campaign_recipients');
  assert.equal(wastedCalls.length, 0);
});

check('functional: all clients lacking email makes no suppression/consent/campaigns fetch calls', async () => {
  const { sandbox, calls } = makeSandbox({ clients: [{ jobber_id: 'c1', name: 'Gail', email: null }] });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.candidates.length, 0);
  assert.equal(data.skippedNoEmail, 1);
  const wastedCalls = calls.filter((c) => c.table === 'marketing_suppressions' || c.table === 'marketing_consent_ledger' || c.table === 'campaigns' || c.table === 'campaign_recipients');
  assert.equal(wastedCalls.length, 0);
});

check('functional: notSynced error on clients fetch degrades honestly instead of throwing', async () => {
  const err = new Error('relation "clients" does not exist');
  err.notSynced = true;
  const { sandbox } = makeSandbox({ throwOnClients: err });
  const data = await sandbox.computeNewsletterCandidates();
  assert.equal(data.notSynced, true);
  assert.deepEqual(norm(data.candidates), []);
  assert.equal(data.minDaysSinceLastSend, 25);
});

check('functional: a non-notSynced error on clients fetch rethrows', async () => {
  const err = new Error('boom');
  const { sandbox } = makeSandbox({ throwOnClients: err });
  await assert.rejects(() => sandbox.computeNewsletterCandidates(), /boom/);
});

check('handleLifecycleCandidatesGet: rejects any playbook other than newsletter with 400', async () => {
  const { sandbox } = makeSandbox({ clients: [] });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'unsold_estimates' } }, res);
  assert.equal(statusCode, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /newsletter/);
});

check('handleLifecycleCandidatesGet: 200 + ok:true + playbook + data for the real playbook', async () => {
  const { sandbox } = makeSandbox({
    clients: [{ jobber_id: 'c1', name: 'Helen', email: 'helen@example.com' }],
  });
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; return this; },
  };
  await sandbox.handleLifecycleCandidatesGet({ query: { playbook: 'newsletter' } }, res);
  assert.equal(statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.playbook, 'newsletter');
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
