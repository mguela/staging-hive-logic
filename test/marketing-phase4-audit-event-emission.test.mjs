// test/marketing-phase4-audit-event-emission.test.mjs
// Regression guard for the Phase 4 "audit-event-emission" slice: a new
// logMarketingAuditEvent() helper in api/marketing.js that writes into the
// schema-only marketing_audit_events table (sql/040) from 4 real, existing
// handlers that previously had no cross-category audit trail at all.
//
// This slice writes real application code, so on top of the usual
// structural assertions this file also actually runs `node --check`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const apiPath = path.join(repoRoot, 'api', 'marketing.js');

const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('api/marketing.js is syntactically valid JS after the patch', () => {
  execFileSync(process.execPath, ['--check', apiPath], { stdio: 'pipe' });
});

check('logMarketingAuditEvent is defined, best-effort (try/catch, never throws), and defaults actor to "owner" unless explicitly "system" (matching marketing_audit_events\' actor CHECK constraint)', () => {
  const fnMatch = api.match(/async function logMarketingAuditEvent\(category, action, entityType, entityId, actor, details\)[\s\S]*?(?=\n\/\/ Auth: every request must carry)/);
  assert.ok(fnMatch, 'could not isolate logMarketingAuditEvent body');
  const body = fnMatch[0];
  assert.match(body, /try \{/);
  assert.match(body, /catch \(e\) \{ \/\* best-effort only/);
  assert.match(body, /supabaseRequest\('marketing_audit_events', \{/);
  assert.match(body, /actor: actor === 'system' \? 'system' : 'owner',/);
});

check('logMarketingAuditEvent is deliberately separate from logCampaignActivity, not a replacement for it', () => {
  assert.match(api, /async function logCampaignActivity\(campaignId, event, actor, detail\)/);
  assert.match(api, /async function logMarketingAuditEvent\(category, action, entityType, entityId, actor, details\)/);
  // logCampaignActivity's own real call sites must be untouched by this slice
  assert.match(api, /await logCampaignActivity\(created\.id, 'created', actorEmail, \{ opportunityKey, recipientCount: recipients\.length \}\);/);
});

check('handleCampaignDeletePost now logs the deletion -- the only durable record of it once the campaign row itself is gone', () => {
  const fnMatch = api.match(/async function handleCampaignDeletePost\(req, res\)[\s\S]*?(?=\nasync function handleCampaignUpdatePost)/);
  assert.ok(fnMatch, 'could not isolate handleCampaignDeletePost body');
  const body = fnMatch[0];
  assert.match(body, /await logMarketingAuditEvent\('campaign', 'deleted', 'campaign', campaignId, 'owner', \{ priorStatus: campaign\.status \}\);/);
  // must log AFTER the real delete succeeds, not before
  const delIdx = body.indexOf('DELETE');
  const logIdx = body.indexOf("logMarketingAuditEvent('campaign', 'deleted'");
  assert.ok(delIdx > -1 && logIdx > delIdx, 'audit log call must come after the real DELETE request');
});

check('handleReviewRequestsPost now logs sent/dismissed review-request actions -- no audit trail existed for this at all before', () => {
  const fnMatch = api.match(/async function handleReviewRequestsPost\(req, res\)[\s\S]*?(?=\n\/\/ ---------- Marketing Suite rebuild additions)/);
  assert.ok(fnMatch, 'could not isolate handleReviewRequestsPost body');
  const body = fnMatch[0];
  assert.match(body, /await logMarketingAuditEvent\('review', status, 'review_request', jobId, 'owner', \{ clientId: row\.client_id, dismissedReason: row\.dismissed_reason \}\);/);
});

check('handleCommandCenterBudgetPost now logs budget changes -- no audit trail existed for this at all before', () => {
  const fnMatch = api.match(/async function handleCommandCenterBudgetPost\(req, res\)[\s\S]*?(?=\n\/\/ ---------- Marketing Setup)/);
  assert.ok(fnMatch, 'could not isolate handleCommandCenterBudgetPost body');
  const body = fnMatch[0];
  assert.match(body, /await logMarketingAuditEvent\('budget', 'updated', 'budget', 'monthly', 'owner', \{ monthlyCents: cents \}\);/);
});

check('handleSetupAccountPost now logs account-detail changes (created vs updated) -- no audit trail existed for this at all before', () => {
  const fnMatch = api.match(/async function handleSetupAccountPost\(req, res\)[\s\S]*?(?=\n\/\/ ---------- Campaign management)/);
  assert.ok(fnMatch, 'could not isolate handleSetupAccountPost body');
  const body = fnMatch[0];
  assert.match(body, /await logMarketingAuditEvent\('connection', existing\.length \? 'account_details_updated' : 'account_details_created', 'platform_connection', channel, 'owner', \{ accountName: payload\.account_name \}\);/);
});

check('all 4 newly-wired categories (campaign, review, budget, connection) match marketing_audit_events\' real category CHECK constraint from sql/040', () => {
  const sqlPath = path.join(repoRoot, 'sql', '040_marketing_campaign_draft_audit_event.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const checkMatch = sql.match(/category text not null check \(category in \(([\s\S]*?)\)\)/);
  assert.ok(checkMatch, 'could not find category CHECK constraint in sql/040');
  const allowed = checkMatch[1];
  for (const cat of ['campaign', 'review', 'budget', 'connection']) {
    assert.match(allowed, new RegExp(`'${cat}'`), `sql/040's category CHECK should allow '${cat}'`);
  }
});

check('none of the 4 new call sites attach a redundant .catch downstream -- the helper itself already swallows all errors internally (verified above), so callers never need to guard against it throwing', () => {
  assert.doesNotMatch(api, /await logMarketingAuditEvent\([^)]*\)\.catch/);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`ok - ${name}`);
    pass++;
  } catch (e) {
    console.error(`not ok - ${name}`);
    console.error(e && e.message ? e.message : e);
    fail++;
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
