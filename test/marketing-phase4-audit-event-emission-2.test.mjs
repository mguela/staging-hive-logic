// test/marketing-phase4-audit-event-emission-2.test.mjs
// Regression guard for the Phase 4 "audit-event-emission" slice's second
// installment: wiring the 'opportunity' and 'plan' categories (the two
// remaining marketing_audit_events categories that have zero external
// branch dependency -- 'idea' and 'approval' still require their sibling
// branches, which is deliberately out of scope for this slice).
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

check('logMarketingAuditEvent helper is present (brought in from the audit-event-emission slice) -- this file builds on it, not a duplicate', () => {
  assert.match(api, /async function logMarketingAuditEvent\(category, action, entityType, entityId, actor, details\)/);
  const occurrences = api.match(/async function logMarketingAuditEvent/g) || [];
  assert.equal(occurrences.length, 1, 'logMarketingAuditEvent must be defined exactly once');
});

check('handleCampaignsPost logs a real "opportunity converted_to_campaign" event only when the campaign was actually created from an opportunity (opportunityKey present)', () => {
  const fnMatch = api.match(/async function handleCampaignsPost\(req, res\)[\s\S]*?(?=\nasync function handleCampaignRecipientPatch)/);
  assert.ok(fnMatch, 'could not isolate handleCampaignsPost body');
  const body = fnMatch[0];
  assert.match(body, /if \(opportunityKey\) \{\s*\n\s*await logMarketingAuditEvent\('opportunity', 'converted_to_campaign', 'opportunity', opportunityKey, 'owner', \{ campaignId: created\.id, recipientCount: recipients\.length \}\);\s*\n\s*\}/);
  // must log AFTER the real campaign row is created, not before
  const createIdx = body.indexOf("supabaseRequest('campaigns'");
  const logIdx = body.indexOf("logMarketingAuditEvent('opportunity'");
  assert.ok(createIdx > -1 && logIdx > createIdx, 'opportunity audit log must come after the real campaign INSERT');
});

check('handleCampaignsPost does NOT log an opportunity event for a plain custom campaign with no opportunityKey -- the guard is real, not a no-op', () => {
  const fnMatch = api.match(/async function handleCampaignsPost\(req, res\)[\s\S]*?(?=\nasync function handleCampaignRecipientPatch)/);
  const body = fnMatch[0];
  // the opportunityKey is derived from targetFilter.opportunityKey and can be null/absent
  assert.match(body, /const opportunityKey = b\.targetFilter && b\.targetFilter\.opportunityKey \? String\(b\.targetFilter\.opportunityKey\) : null;/);
});

check('handleAssumptionsPost now logs a real "plan assumptions_updated" event -- no audit trail existed for this at all before, even though it directly reshapes the owner-facing forecast', () => {
  const fnMatch = api.match(/async function handleAssumptionsPost\(req, res\)[\s\S]*?(?=\nasync function ccPlan)/);
  assert.ok(fnMatch, 'could not isolate handleAssumptionsPost body');
  const body = fnMatch[0];
  assert.match(body, /await logMarketingAuditEvent\('plan', 'assumptions_updated', 'plan_assumptions', 'ghgrp', 'owner', \{\s*\n\s*grossMarginPct, closeRatePct, qualifiedLeadRatePer100, maxNewJobsPerMonth, avgJobValueCents, riskPosture,\s*\n\s*\}\);/);
  // must log AFTER the real save (PATCH or POST), not before -- and before the
  // unrelated plan-recompute step that follows
  const saveIdx = body.indexOf("marketing_plan_assumptions");
  const logIdx = body.indexOf("logMarketingAuditEvent('plan'");
  const budgetIdx = body.indexOf('let budgetCents');
  assert.ok(saveIdx > -1 && logIdx > saveIdx, 'plan audit log must come after the real assumptions save');
  assert.ok(logIdx > -1 && budgetIdx > logIdx, 'plan audit log must come before the unrelated plan-recompute step');
});

check('the plan audit event uses only already-validated, already-computed real values -- never a fabricated or re-derived number', () => {
  const fnMatch = api.match(/async function handleAssumptionsPost\(req, res\)[\s\S]*?(?=\nasync function ccPlan)/);
  const body = fnMatch[0];
  // every field passed to the audit event must be one of the function's own
  // validated local variables, not a literal or a different expression
  for (const field of ['grossMarginPct', 'closeRatePct', 'qualifiedLeadRatePer100', 'maxNewJobsPerMonth', 'avgJobValueCents', 'riskPosture']) {
    const declMatch = body.match(new RegExp(`(?:let|const)\\s+.*\\b${field}\\b`));
    assert.ok(declMatch, `expected ${field} to be a locally-declared/validated variable in handleAssumptionsPost`);
  }
});

check('opportunity and plan are both real values in sql/040\'s category CHECK constraint -- the categories this slice wires into actually exist in the schema', () => {
  const sqlPath = path.join(repoRoot, 'sql', '040_marketing_campaign_draft_audit_event.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const checkMatch = sql.match(/category text not null check \(category in \(([\s\S]*?)\)\)/);
  assert.ok(checkMatch, 'could not find category CHECK constraint in sql/040');
  const allowed = checkMatch[1];
  for (const cat of ['opportunity', 'plan']) {
    assert.match(allowed, new RegExp(`'${cat}'`), `sql/040's category CHECK should allow '${cat}'`);
  }
});

check('neither new call site attaches a redundant .catch -- the helper itself already swallows all errors internally', () => {
  assert.doesNotMatch(api, /await logMarketingAuditEvent\('opportunity'[^)]*\)\.catch/);
  assert.doesNotMatch(api, /await logMarketingAuditEvent\('plan'[^)]*\)\.catch/);
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
