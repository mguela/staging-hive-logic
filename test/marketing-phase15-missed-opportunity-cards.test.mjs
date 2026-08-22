import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------- Static source checks ----------

check('handleOpportunitiesGet now also computes computeMissedLeadSourcesOpportunity', () => {
  assert.match(raw, /computeReferralOpportunities\(\),\s*computeSeasonalPromotion\(\),\s*computeMissedLeadSourcesOpportunity\(\),\s*\]\);/);
});

check('the catalog lists the 12 addendum-approved common lead-source platforms', () => {
  const idx = raw.indexOf('COMMON_LEAD_SOURCE_CATALOG');
  const slice = raw.slice(idx, idx + 300);
  for (const name of ['Angi', 'HomeAdvisor', 'Thumbtack', 'Houzz', 'Yelp', 'Nextdoor', 'Porch', 'Networx', 'BuildZoom', 'Service Direct', 'Modernize', 'Bark']) {
    assert.ok(slice.includes(`'${name}'`), `expected catalog to include ${name}`);
  }
});

// ---------- vm-extraction of computeMissedLeadSourcesOpportunity ----------

const startMarker = "// ----- Missed Lead Source (real: lead_pipeline's actual logged sources vs. a common-platform catalog) -----";
const endMarker = 'async function handleOpportunitiesGet(req, res) {';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find the missed-lead-source block start marker');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected handleOpportunitiesGet after the new block');
const blockSrc = raw.slice(startIdx, endIdx);

function makeSandbox(rows, { notSynced = false } = {}) {
  const fetchAllRows = async (table, query) => {
    assert.equal(table, 'lead_pipeline');
    assert.match(query, /select=lead_source&lead_source=not\.is\.null/);
    if (notSynced) {
      const e = new Error('not synced');
      e.notSynced = true;
      throw e;
    }
    return rows;
  };
  const sandbox = { fetchAllRows, String, Set, console, Error };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

check('functional: always marked non-actionable with a real explanation, never a fabricated live connection', async () => {
  const sandbox = makeSandbox([]);
  const opp = await sandbox.computeMissedLeadSourcesOpportunity();
  assert.equal(opp.key, 'missed_lead_sources');
  assert.equal(opp.actionable, false);
  assert.ok(opp.actionableReason && opp.actionableReason.length > 0);
  assert.equal(opp.estRevenue, null);
});

check('functional: zero logged leads means every catalog platform is missing', async () => {
  const sandbox = makeSandbox([]);
  const opp = await sandbox.computeMissedLeadSourcesOpportunity();
  assert.equal(opp.count, 12);
  assert.match(opp.description, /12 common lead-generation platforms/);
});

check('functional: a logged lead_source matching a catalog entry (case-insensitive) removes it from the missing count', async () => {
  const sandbox = makeSandbox([{ lead_source: 'Angi' }, { lead_source: 'referral' }]);
  const opp = await sandbox.computeMissedLeadSourcesOpportunity();
  assert.equal(opp.count, 11);
  assert.ok(!opp.description.includes('12 common'));
});

check('functional: every catalog platform logged at least once yields the honest all-covered description', async () => {
  const rows = ['Angi', 'HomeAdvisor', 'Thumbtack', 'Houzz', 'Yelp', 'Nextdoor', 'Porch', 'Networx', 'BuildZoom', 'Service Direct', 'Modernize', 'Bark'].map((s) => ({ lead_source: s }));
  const sandbox = makeSandbox(rows);
  const opp = await sandbox.computeMissedLeadSourcesOpportunity();
  assert.equal(opp.count, 0);
  assert.match(opp.description, /already has at least one real logged lead/);
});

check('functional: an unsynced lead_pipeline table degrades honestly (null count, not zero or a crash)', async () => {
  const sandbox = makeSandbox([], { notSynced: true });
  const opp = await sandbox.computeMissedLeadSourcesOpportunity();
  assert.equal(opp.count, null);
  assert.match(opp.description, /not set up yet/);
});

check('functional: a non-notSynced error from fetchAllRows still rethrows (no silent swallow)', async () => {
  const fetchAllRows = async () => { throw new Error('boom'); };
  const sandbox = { fetchAllRows, String, Set, console, Error };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  await assert.rejects(() => sandbox.computeMissedLeadSourcesOpportunity(), /boom/);
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
