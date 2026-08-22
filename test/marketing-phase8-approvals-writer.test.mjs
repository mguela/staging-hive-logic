// Phase 8 -- Ready for You now sources cards from marketing_approvals
// (real pending approval rows), with a fallback to raw draft campaigns
// for drafts created before this writer shipped. handleCampaignsPost
// writes a real CAMPAIGN_SPEND approval row alongside every new campaign
// draft (best-effort, never blocks the real draft). handleCampaignSendPost
// marks that row approved once the campaign actually sends; handleCampaignDeletePost
// clears it if the draft is deleted first.

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

// Load the real ccReadyForYou (plus its real CAMPAIGN_TYPE_LABEL) out of
// the real api/marketing.js source, with fetchAllRows faked, so the test
// exercises the actual shipped merge/fallback logic.
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

check('handleCampaignsPost writes a real CAMPAIGN_SPEND approval row after creating the campaign, best-effort', () => {
  const start = api.indexOf('async function handleCampaignsPost');
  const end = api.indexOf('\nasync function', start + 20);
  const fn = api.slice(start, end);
  assert.match(fn, /await logCampaignActivity\(created\.id, 'created', actorEmail/);
  const writerIdx = fn.indexOf("supabaseRequest('marketing_approvals'");
  assert.ok(writerIdx > -1, 'expected a marketing_approvals write');
  assert.match(fn, /approvable_type: 'CAMPAIGN_SPEND'/);
  assert.match(fn, /approvable_id: String\(created\.id\)/);
  assert.match(fn, /title: created\.name/);
  assert.match(fn, /estimate: JSON\.stringify\(\{ recipientCount: recipients\.length \}\)/);
  // best-effort: wrapped in try/catch, never returns/throws past the real draft response
  const tryIdx = fn.lastIndexOf('try {', writerIdx);
  assert.ok(tryIdx > -1 && tryIdx < writerIdx);
  const catchIdx = fn.indexOf('} catch (e)', writerIdx);
  assert.ok(catchIdx > -1);
  assert.doesNotMatch(fn.slice(tryIdx, catchIdx), /return res\./);
});

check('handleCampaignSendPost marks the pending approval row approved once the campaign actually sends', () => {
  const start = api.indexOf('async function handleCampaignSendPost');
  const end = api.indexOf('\nasync function', start + 20);
  const fn = api.slice(start, end);
  assert.match(fn, /if \(finalStatus === 'active'\) \{/);
  assert.match(fn, /marketing_approvals\?approvable_type=eq\.CAMPAIGN_SPEND&approvable_id=eq\.\$\{encodeURIComponent\(campaignId\)\}&status=eq\.pending/);
  assert.match(fn, /status: 'approved', decided_by: actorEmail \|\| 'owner', decided_at: new Date\(\)\.toISOString\(\)/);
});

check('handleCampaignDeletePost clears the pending approval row for a deleted draft', () => {
  const start = api.indexOf('async function handleCampaignDeletePost');
  const end = api.indexOf('\nasync function', start + 20);
  const fn = api.slice(start, end);
  assert.match(fn, /marketing_approvals\?approvable_type=eq\.CAMPAIGN_SPEND&approvable_id=eq\.\$\{encodeURIComponent\(campaignId\)\}&status=eq\.pending/);
  assert.match(fn, /method: 'DELETE'/);
});

check('a pending CAMPAIGN_SPEND approval row for a real draft campaign becomes a card, keyed by the real campaign id', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [{
      id: 'appr-1', approvable_type: 'CAMPAIGN_SPEND', approvable_id: 'camp-1',
      title: 'Spring reactivation', rationale: 'New reactivation campaign draft ready to review -- 12 recipients ready.',
      preview_text: null, amount_cents: null, max_amount_cents: null, target_description: null,
      estimate: '{"recipientCount":12}', confidence: null, risks: null, status: 'pending', created_at: '2026-08-01T00:00:00Z',
    }],
    campaigns: [{ id: 'camp-1', name: 'Spring reactivation', type: 'reactivation', channel: 'email', status: 'draft', created_at: '2026-08-01T00:00:00Z' }],
    recipients: [{ campaign_id: 'camp-1', sent_at: null }, { campaign_id: 'camp-1', sent_at: null }],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 1);
    const item = result.items[0];
    assert.strictEqual(item.id, 'camp-1', 'id must be the real campaign id so ccApprove/campaign_send keep working unchanged');
    assert.strictEqual(item.type, 'reactivation');
    assert.strictEqual(item.recipientCount, 2);
    assert.strictEqual(item.approvalId, 'appr-1');
  });
});

check('a draft campaign whose approval row was already approved/rejected does not show as a duplicate approval card, but the legacy fallback still shows it if still draft', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [], // approval row already moved out of pending (approved/rejected)
    campaigns: [{ id: 'camp-2', name: 'Legacy draft', type: 'custom', channel: 'email', status: 'draft', created_at: '2026-08-01T00:00:00Z' }],
    recipients: [],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0].id, 'camp-2');
    assert.strictEqual(result.items[0].title, 'Legacy draft');
  });
});

check('a pending approval row whose campaign already moved past draft (sent/active) is not shown as a stale card', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [{
      id: 'appr-3', approvable_type: 'CAMPAIGN_SPEND', approvable_id: 'camp-3',
      title: 'Already sent', rationale: null, preview_text: null, amount_cents: null, max_amount_cents: null,
      target_description: null, estimate: null, confidence: null, risks: null, status: 'pending', created_at: '2026-08-01T00:00:00Z',
    }],
    campaigns: [{ id: 'camp-3', name: 'Already sent', type: 'custom', channel: 'email', status: 'active', created_at: '2026-08-01T00:00:00Z' }],
    recipients: [],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 0, 'a stale pending row for a no-longer-draft campaign must not surface a card');
  });
});

check('an approval row for a non-CAMPAIGN_SPEND type (no writer yet) still shows generically using only its real fields', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [{
      id: 'appr-4', approvable_type: 'BUDGET_ADJUSTMENT', approvable_id: null,
      title: 'Increase Google Ads budget', rationale: 'Real rationale text', preview_text: null,
      amount_cents: 50000, max_amount_cents: 75000, target_description: 'Google Ads channel',
      estimate: null, confidence: 0.8, risks: JSON.stringify(['May exceed monthly cap']), status: 'pending', created_at: '2026-08-01T00:00:00Z',
    }],
    campaigns: [],
    recipients: [],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.items.length, 1);
    const item = result.items[0];
    assert.strictEqual(item.id, 'appr-4');
    assert.strictEqual(item.approvableType, 'BUDGET_ADJUSTMENT');
    assert.strictEqual(item.amountCents, 50000);
    assert.strictEqual(item.maxAmountCents, 75000);
    assert.strictEqual(item.confidence, 0.8);
  });
});

check('sentLast7Days still reflects all real sent recipients regardless of approval status', () => {
  const ccReadyForYou = loadRealReadyForYou({
    approvals: [],
    campaigns: [],
    recipients: [{ campaign_id: 'camp-x', sent_at: new Date().toISOString() }],
  });
  return ccReadyForYou().then((result) => {
    assert.strictEqual(result.sentLast7Days, 1);
  });
});

check('renderReadyForYou conditionally shows amount/max, target, confidence, and risks only when the real fields are present', () => {
  const start = html.indexOf('function renderReadyForYou');
  const end = html.indexOf('function ccApprove', start);
  const fn = html.slice(start, end);
  assert.match(fn, /if \(it\.amountCents != null \|\| it\.maxAmountCents != null\) \{/);
  assert.match(fn, /if \(it\.targetDescription\) \{/);
  assert.match(fn, /if \(it\.confidence != null\) \{/);
  assert.match(fn, /if \(Array\.isArray\(it\.risks\) && it\.risks\.length\) \{/);
});

check('the existing ccApprove button call is unchanged (still keyed on it.id)', () => {
  const start = html.indexOf('function renderReadyForYou');
  const end = html.indexOf('function ccApprove', start);
  const fn = html.slice(start, end);
  assert.ok(fn.includes(`onclick="ccApprove(\\''+ it.id + '\\')">`), 'expected the real ccApprove(it.id) button call, unchanged');
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
