// Phase 13 -- WebsiteChange drafting application code.
// Verifies api/marketing.js wires up resource=website_changes (GET/POST),
// enforces the sql/041 CHECK constraints for provider/change_type, grounds
// AI drafts in real completed-job facts via the existing jobDivisionServer
// classifier (never a fabricated division mapping), never fabricates
// prices/warranties/certifications/brand names/promotions, degrades
// honestly when ANTHROPIC_API_KEY is unset or the table isn't synced yet,
// treats persistence failure as best-effort (never blocks the real draft
// response), and -- deliberately -- does NOT emit a marketing_audit_events
// row for this handler, since sql/040's category CHECK constraint has no
// 'website' category yet. That omission is a real, intentional scope
// boundary, not an oversight, and is tested here just as rigorously as the
// features that were shipped.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const apiPath = 'api/marketing.js';
const sql041Path = 'sql/041_marketing_website_review_attribution.sql';
const sql040Path = 'sql/040_marketing_campaign_draft_audit_event.sql';

check('api/marketing.js has valid syntax (node --check)', () => {
  execSync(`node --check ${apiPath}`, { stdio: 'pipe' });
});

const body = fs.readFileSync(apiPath, 'utf8');
const sql041 = fs.readFileSync(sql041Path, 'utf8');
const sql040 = fs.readFileSync(sql040Path, 'utf8');

// Bound each function's body by indexOf between its own start marker and the
// next function's start marker. Deliberately NOT using regex with a literal
// trailing "\n}\n" -- the real files use CRLF line endings, and a prior slice
// this session found (and fixed) a pre-existing bug of exactly that shape in
// a sibling test file, so bounding by indexOf is the established safe pattern.
function boundFn(startMarker, endMarker) {
  const startIdx = body.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = body.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return body.slice(startIdx, endIdx);
}

const realDivisionJobFactsBody = () => boundFn(
  'async function realDivisionJobFacts(division) {',
  'async function handleWebsiteChangesGet(req, res) {',
);
const handleWebsiteChangesGetBody = () => boundFn(
  'async function handleWebsiteChangesGet(req, res) {',
  'async function handleWebsiteChangesPost(req, res) {',
);
const handleWebsiteChangesPostBody = () => boundFn(
  'async function handleWebsiteChangesPost(req, res) {',
  '\nasync function handleDraftPostPost',
);

check('dispatch wires resource=website_changes GET to handleWebsiteChangesGet', () => {
  assert.match(body, /resource === 'website_changes' && req\.method === 'GET'\)\s*\{\s*\n\s*return await handleWebsiteChangesGet\(req, res\);/);
});

check('dispatch wires resource=website_changes POST to handleWebsiteChangesPost', () => {
  assert.match(body, /resource === 'website_changes' && req\.method === 'POST'\)\s*\{\s*\n\s*return await handleWebsiteChangesPost\(req, res\);/);
});

check('trailing resource-list error string documents website_changes (GET/POST)', () => {
  assert.match(body, /review_replies \(GET\/POST\), website_changes \(GET\/POST\), draft_post \(POST\), campaign_delete \(POST\)/);
});

check('WEBSITE_CHANGE_PROVIDERS matches sql/041 provider CHECK constraint exactly', () => {
  const m = sql041.match(/provider text[^\n]*check\s*\(provider in \(([^)]+)\)\)/i);
  assert.ok(m, 'could not find provider CHECK constraint in sql/041');
  const sqlValues = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  const jsMatch = body.match(/const WEBSITE_CHANGE_PROVIDERS = \[([^\]]+)\];/);
  assert.ok(jsMatch, 'WEBSITE_CHANGE_PROVIDERS not found');
  const jsValues = jsMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepStrictEqual(jsValues.sort(), sqlValues.sort());
});

check('WEBSITE_CHANGE_TYPES matches sql/041 change_type CHECK constraint exactly', () => {
  const m = sql041.match(/change_type text[^\n]*check\s*\(change_type in \(([^)]+)\)\)/i);
  assert.ok(m, 'could not find change_type CHECK constraint in sql/041');
  const sqlValues = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  const jsMatch = body.match(/const WEBSITE_CHANGE_TYPES = \[([\s\S]*?)\];/);
  assert.ok(jsMatch, 'WEBSITE_CHANGE_TYPES not found');
  const jsValues = jsMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepStrictEqual(jsValues.sort(), sqlValues.sort());
});

check('handleWebsiteChangesPost validates provider against WEBSITE_CHANGE_PROVIDERS', () => {
  assert.match(body, /if \(!WEBSITE_CHANGE_PROVIDERS\.includes\(provider\)\)\s*\{\s*\n\s*return res\.status\(400\)/);
});

check('handleWebsiteChangesPost validates changeType against WEBSITE_CHANGE_TYPES', () => {
  assert.match(body, /if \(!WEBSITE_CHANGE_TYPES\.includes\(changeType\)\)\s*\{\s*\n\s*return res\.status\(400\)/);
});

check('handleWebsiteChangesPost requires a non-empty division', () => {
  assert.match(body, /if \(!division\) return res\.status\(400\)\.json\(\{ ok: false, error: 'division required/);
});

check('handleWebsiteChangesPost degrades honestly (409) when ANTHROPIC_API_KEY / anthropicMkt is unset', () => {
  assert.match(body, /if \(!anthropicMkt\)\s*\{\s*\n\s*return res\.status\(409\)\.json\(\{ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment -- cannot draft website copy yet\.' \}\);/);
});

check('realDivisionJobFacts groups real completed jobs using the real jobDivisionServer classifier', () => {
  const fn = realDivisionJobFactsBody();
  assert.match(fn, /jobDivisionServer\(r\.title\) === division/, 'must classify via the existing jobDivisionServer function, not a fabricated mapping');
  assert.match(fn, /fetchAllRows\('jobs', /, 'must source facts from real jobs rows');
  assert.match(fn, /completed_at=not\.is\.null/, 'must only count real completed jobs');
});

check('realDivisionJobFacts returns only real derived facts (no fabricated fields)', () => {
  const fn = realDivisionJobFactsBody();
  assert.match(fn, /completedJobCount: matched\.length/);
  assert.match(fn, /completedJobCountLast180Days: recentMatched\.length/);
  assert.match(fn, /avgJobValueCents: avgTotalCents/);
  assert.match(fn, /: null/, 'avgJobValueCents must honestly fall back to null, never a fabricated number, when there is no real total data');
});

check('drafting prompt forbids inventing prices, warranties, certifications, brand names, or promotions', () => {
  assert.match(body, /Never invent specific prices, warranties, certifications, brand names, or promotional offers/);
});

check('drafting prompt tells the model to write honestly when completedJobCount is 0', () => {
  assert.match(body, /If completedJobCount is 0, write general, honest copy about the service -- do not claim any job history\./);
});

check('drafting prompt forbids mentioning pricing when avgJobValueCents is null', () => {
  assert.match(body, /If avgJobValueCents is null, do not mention pricing at all\./);
});

check('handleWebsiteChangesPost honestly rejects (502) unparseable AI JSON', () => {
  const fn = handleWebsiteChangesPostBody();
  assert.match(fn, /catch \(e\)\s*\{\s*\n\s*return res\.status\(502\)\.json\(\{ ok: false, error: 'Draft copy could not be parsed as valid JSON -- try again\.' \}\);/);
});

check('handleWebsiteChangesPost honestly rejects (502) a draft missing required fields', () => {
  const fn = handleWebsiteChangesPostBody();
  assert.match(fn, /if \(!draft \|\| typeof draft\.headline !== 'string' \|\| typeof draft\.body !== 'string' \|\| typeof draft\.cta !== 'string'\)\s*\{\s*\n\s*return res\.status\(502\)/);
});

check('handleWebsiteChangesPost treats persistence as best-effort (save failure never blocks the real draft response)', () => {
  const fn = handleWebsiteChangesPostBody();
  // CRLF-safe: bound to this handler's own body first (there are two nearly
  // identical try/catch persistence blocks in this file -- ReviewReply's and
  // this one -- so searching the whole file risks matching the wrong one).
  const tryIdx = fn.search(/try\s*\{\s*\n\s*const insertRes = await supabaseRequest\('marketing_website_changes'/);
  assert.ok(tryIdx > -1, 'expected a try block wrapping the marketing_website_changes insert');
  const catchIdx = fn.indexOf('} catch (e) { /* best-effort persistence -- the real draft is still returned below even if the save fails */ }');
  assert.ok(catchIdx > tryIdx, 'expected the best-effort catch comment after the insert try block');
  const resIdx = fn.search(/res\.status\(200\)\.json\(\{\s*\n\s*ok: true,\s*\n\s*websiteChange: \{/);
  assert.ok(resIdx > catchIdx, 'the real draft response must be returned unconditionally after the best-effort persistence attempt');
});

check('handleWebsiteChangesGet degrades honestly when marketing_website_changes is not synced yet', () => {
  assert.match(body, /if \(e\.notSynced\) return res\.status\(200\)\.json\(\{ ok: true, changes: \[\], notice: 'marketing_website_changes table is not set up yet/);
});

check('handleWebsiteChangesGet maps only real columns from marketing_website_changes rows', () => {
  const fn = handleWebsiteChangesGetBody();
  ['provider', 'changeType', 'pagePath', 'title', 'contentSnapshot', 'status', 'createdBy', 'createdAt'].forEach((f) => {
    assert.ok(fn.includes(f), `expected mapped field ${f} in handleWebsiteChangesGet`);
  });
});

check('handleWebsiteChangesPost deliberately does NOT call logMarketingAuditEvent (no "website" category exists in sql/040 yet)', () => {
  const fn = handleWebsiteChangesPostBody();
  assert.ok(!fn.includes('logMarketingAuditEvent'), 'handleWebsiteChangesPost must not call logMarketingAuditEvent -- sql/040 has no "website" category yet, so this is an intentional gap, not a wiring bug');
});

check("sql/040's category CHECK constraint really has no 'website' category (confirms the gap is real, not just assumed)", () => {
  const m = sql040.match(/category text[^\n]*check\s*\(category in \(([^)]+)\)\)/i);
  assert.ok(m, 'could not find category CHECK constraint in sql/040');
  const categories = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.ok(!categories.includes('website'), "expected sql/040 to NOT yet define a 'website' audit category -- if this ever changes, handleWebsiteChangesPost should be revisited to wire in a real audit event");
});

check('WebsiteChange handlers only ever set status to draft (no publish path exists yet)', () => {
  const fn = handleWebsiteChangesPostBody();
  assert.match(fn, /status: 'draft'/);
  assert.ok(!fn.includes("status: 'published'"), 'no publish path should exist yet in this handler');
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`not ok - ${name}\n  ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
