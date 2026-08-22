// Phase 8 -- Reject action for Ready-for-You approvals. Any pending
// marketing_approvals row can be rejected via a new approval_reject
// resource (works for CAMPAIGN_SPEND and any other approvable_type).
// Rejecting a CAMPAIGN_SPEND row never deletes the underlying campaign
// draft -- it stays a draft, but ccReadyForYou()'s legacy fallback must
// never resurface it as if it had never been reviewed.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const apiPath = 'api/marketing.js';
const htmlPath = 'public/marketing-command-center/index.html';
const api = fs.readFileSync(apiPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractInlineScript() {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

function loadRealReadyForYou(fixtures) {
  const start = api.indexOf('const CAMPAIGN_TYPE_LABEL');
  assert.ok(start > -1, 'expected CAMPAIGN_TYPE_LABEL to exist');
  const end = api.indexOf('\n// ---------- Phase 2: real Opportunity Engine forecast', start);
  assert.ok(end > start);
  const fnSrc = api.slice(start, end);
  const sandbox = {
    fetchAllRows: async (table) => {
      if (table === 'marketing_approvals') return fixtures.approvals || [];
      if (table === 'campaigns') return fixtures.campaigns || [];
      if (table === 'campaign_recipients') return fixtures.recipients || [];
      throw new Error('unexpected table ' + table);
    },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox.ccReadyForYou;
}

check('the real inline script is still syntactically valid JavaScript', () => {
  new vm.Script(extractInlineScript());
});

check('resource=approval_reject is wired into the dispatch chain after campaign_send', () => {
  const idx = api.indexOf("resource === 'campaign_send'");
  assert.ok(idx > -1);
  const rejectIdx = api.indexOf("resource === 'approval_reject' && req.method === 'POST'", idx);
  assert.ok(rejectIdx > idx, 'expected approval_reject route to be registered after campaign_send');
  const chunk = api.slice(rejectIdx, rejectIdx + 200);
  assert.match(chunk, /return await handleApprovalRejectPost\(req, res\);/);
});

check('the resource-list error string documents approval_reject (POST)', () => {
  assert.match(api, /approval_reject \(POST\)/);
  const idx3 = api.indexOf('campaign_activity (GET)');
  assert.ok(idx3 > -1);
  const enumTail = api.slice(idx3, idx3 + 500);
  assert.match(enumTail, /approval_reject \(POST\)/);
  assert.match(enumTail, /process_scheduled_sends \(GET\)/);
});

check('handleApprovalRejectPost requires approvalId, 404s on missing row, 409s on non-pending, and PATCHes status=rejected with a real actor/timestamp', () => {
  const start = api.indexOf('async function handleApprovalRejectPost');
  const end = api.indexOf('\nasync function', start + 20);
  const fn = api.slice(start, end);
  assert.match(fn, /if \(!approvalId\) return res\.status\(400\)/);
  assert.match(fn, /if \(!approval\) return res\.status\(404\)/);
  assert.match(fn, /if \(approval\.status !== 'pending'\) \{/);
  assert.match(fn, /return res\.status\(409\)/);
  assert.match(fn, /method: 'PATCH'/);
  assert.match(fn, /status: 'rejected', decided_by: actorEmail \|\| 'owner', decided_at: new Date\(\)\.toISOString\(\), decision_reason: reason/);
});

check('handleApprovalRejectPost never deletes/touches the campaigns table -- only marketing_approvals', () => {
  const start = api.indexOf('async function handleApprovalRejectPost');
  const end = api.indexOf('\nasync function', start + 20);
  const fn = api.slice(start, end);
  assert.doesNotMatch(fn, /supabaseRequest\(`campaigns/);
  assert.match(fn, /supabaseRequest\(`marketing_approvals/g);
});

check('ccReadyForYou fetches marketing_approvals without a status filter (so rejected/approved rows are visible for exclusion)', () => {
  const start = api.indexOf('async function ccReadyForYou');
  const end = api.indexOf('\n// ---------- Phase 2: real Opportunity Engine forecast', start);
  const fn = api.slice(start, end);
  assert.doesNotMatch(fn, /status=eq\.pending&order=created_at\.desc'\);\r?\n\s*\} catch \(e\) \{\r?\n\s*if \(!e\.notSynced\) throw e;\r?\n\s*\}\r?\n\s*let campaigns/);
  assert.match(fn, /const pendingApprovals = approvals\.filter\(\(a\) => a\.status === 'pending'\);/);
  assert.match(fn, /for \(const a of pendingApprovals\) \{/);
});

check('a rejected CAMPAIGN_SPEND approval does not resurrect its still-draft campaign via the legacy fallback', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [{
      id: 'appr-5', approvable_type: 'CAMPAIGN_SPEND', approvable_id: 'camp-5',
      title: 'Rejected one', rationale: null, preview_text: null, amount_cents: null, max_amount_cents: null,
      target_description: null, estimate: null, confidence: null, risks: null, status: 'rejected', created_at: '2026-08-01T00:00:00Z',
    }],
    campaigns: [{ id: 'camp-5', name: 'Rejected one', type: 'custom', channel: 'email', status: 'draft', created_at: '2026-08-01T00:00:00Z' }],
    recipients: [],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 0, 'a rejected approval must not resurface its draft campaign as a legacy card');
  });
});

check('an approved CAMPAIGN_SPEND row (already sent) still correctly excludes its campaign from the legacy fallback too', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [{
      id: 'appr-6', approvable_type: 'CAMPAIGN_SPEND', approvable_id: 'camp-6',
      title: 'Approved one', rationale: null, preview_text: null, amount_cents: null, max_amount_cents: null,
      target_description: null, estimate: null, confidence: null, risks: null, status: 'approved', created_at: '2026-08-01T00:00:00Z',
    }],
    // campaign hypothetically still shows as draft in some edge case -- must still be excluded because it has approval history
    campaigns: [{ id: 'camp-6', name: 'Approved one', type: 'custom', channel: 'email', status: 'draft', created_at: '2026-08-01T00:00:00Z' }],
    recipients: [],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 0);
  });
});

check('a pending CAMPAIGN_SPEND approval still becomes a real card unaffected by the fetch-all-statuses change (regression)', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [{
      id: 'appr-7', approvable_type: 'CAMPAIGN_SPEND', approvable_id: 'camp-7',
      title: 'Still pending', rationale: null, preview_text: null, amount_cents: null, max_amount_cents: null,
      target_description: null, estimate: null, confidence: null, risks: null, status: 'pending', created_at: '2026-08-01T00:00:00Z',
    }],
    campaigns: [{ id: 'camp-7', name: 'Still pending', type: 'custom', channel: 'email', status: 'draft', created_at: '2026-08-01T00:00:00Z' }],
    recipients: [],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0].id, 'camp-7');
  });
});

check('a legacy draft campaign with no approval row at all (any status) still shows via the fallback (regression)', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [],
    campaigns: [{ id: 'camp-8', name: 'True legacy', type: 'custom', channel: 'email', status: 'draft', created_at: '2026-08-01T00:00:00Z' }],
    recipients: [],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0].id, 'camp-8');
  });
});

check('the frontend Reject button only renders when the card has a real approvalId', () => {
  const start = html.indexOf('function renderReadyForYou');
  const end = html.indexOf('function ccReject', start);
  const fn = html.slice(start, end);
  assert.match(fn, /\(it\.approvalId \? '<button class="cc-btn cc-btn-secondary"[^']*onclick="ccReject\(\\''\+ it\.approvalId \+ '\\'\)">Reject<\/button>' : ''\)/);
});

check('ccReject calls the real approval_reject resource and refreshes on success, never touching campaign_send', () => {
  const start = html.indexOf('function ccReject');
  const end = html.indexOf('function ccApprove', start);
  const fn = html.slice(start, end);
  assert.match(fn, /api\("approval_reject", \{ method: "POST", body: JSON\.stringify\(\{ approvalId: approvalId, reason: reason \|\| undefined \}\) \}\)/);
  assert.match(fn, /loadAndRender\(\);/);
  assert.doesNotMatch(fn, /campaign_send/);
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
