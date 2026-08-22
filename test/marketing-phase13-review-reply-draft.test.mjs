// test/marketing-phase13-review-reply-draft.test.mjs
// Regression guard for the Phase 13 ReviewReply drafting slice: a real
// resource=review_replies GET/POST pair backed by marketing_review_replies
// (sql/041), following the same "real facts only, never fabricate"
// discipline as handleDraftPostPost/handleIdeasProcessPost -- and the
// explicit "never rewrite review text" rule: the AI drafts a NEW reply,
// it never edits the real review content itself.
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

check('dispatch chain wires resource=review_replies for both GET and POST, ahead of draft_post', () => {
  assert.match(api, /if \(resource === 'review_replies' && req\.method === 'GET'\) \{\s*\n\s*return await handleReviewRepliesGet\(req, res\);\s*\n\s*\}/);
  assert.match(api, /if \(resource === 'review_replies' && req\.method === 'POST'\) \{\s*\n\s*return await handleReviewRepliesPost\(req, res\);\s*\n\s*\}/);
  const replyIdx = api.indexOf("resource === 'review_replies'");
  const draftIdx = api.indexOf("resource === 'draft_post'");
  assert.ok(replyIdx > -1 && draftIdx > -1 && replyIdx < draftIdx, 'review_replies dispatch should be wired ahead of draft_post');
});

check('trailing resource-list error string documents review_replies (GET/POST)', () => {
  assert.match(api, /review_replies \(GET\/POST\)/);
});

check('handleReviewRepliesPost validates platform against the real sql/041 CHECK constraint values', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  assert.ok(fnMatch, 'could not isolate handleReviewRepliesPost body');
  const body = fnMatch[0];
  assert.match(body, /\['google_business_profile', 'other'\]\.includes\(platform\)/);
  const sqlPath = path.join(repoRoot, 'sql', '041_marketing_website_review_attribution.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const platformCheckMatch = sql.match(/platform text not null check \(platform in \(([^)]*)\)\)/);
  assert.ok(platformCheckMatch, 'could not find platform CHECK constraint in sql/041');
  assert.match(platformCheckMatch[1], /'google_business_profile'/);
  assert.match(platformCheckMatch[1], /'other'/);
});

check('handleReviewRepliesPost requires a real, non-empty reviewText -- never drafts against an absent review', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  const body = fnMatch[0];
  assert.match(body, /const reviewText = String\(b\.reviewText \|\| ''\)\.trim\(\);/);
  assert.match(body, /if \(!reviewText\) return res\.status\(400\)/);
});

check('handleReviewRepliesPost validates rating as an integer 1-5 when provided, matching sql/041\'s CHECK', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  const body = fnMatch[0];
  assert.match(body, /Number\.isInteger\(rating\) \|\| rating < 1 \|\| rating > 5/);
  const sqlPath = path.join(repoRoot, 'sql', '041_marketing_website_review_attribution.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assert.match(sql, /rating integer check \(rating is null or \(rating between 1 and 5\)\)/);
});

check('handleReviewRepliesPost honestly degrades with 409 when ANTHROPIC_API_KEY is not set', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  const body = fnMatch[0];
  assert.match(body, /if \(!anthropicMkt\) \{\s*\n\s*return res\.status\(409\)/);
});

check('the AI prompt explicitly forbids rewriting the review and forbids inventing facts/promises/refunds', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  const body = fnMatch[0];
  assert.match(body, /never quote-edit or rewrite the review itself/);
  assert.match(body, /Never invent facts, promises, refunds, discounts/);
});

check('reviewReplySensitivityFlag flags low ratings, absent ratings, and negative-keyword reviews -- never defaults to false when unsure', () => {
  assert.match(api, /function reviewReplySensitivityFlag\(rating, reviewText\)/);
  assert.match(api, /if \(typeof rating === 'number' && rating <= 2\) return true;/);
  assert.match(api, /if \(rating == null\) return true;/);
  assert.match(api, /REVIEW_REPLY_SENSITIVE_KEYWORDS\.some\(\(kw\) => lower\.includes\(kw\)\)/);
});

check('review_text is persisted unmodified (the real review) while draft_reply_text holds the AI-generated NEW reply -- never the same field', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  const body = fnMatch[0];
  assert.match(body, /review_text: reviewText,/);
  assert.match(body, /draft_reply_text: draftReplyText,/);
});

check('a save failure never blocks the real drafted reply from being returned -- best-effort persistence, not a hard dependency', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  const body = fnMatch[0];
  const tryIdx = body.search(/try\s*\{\s*\n\s*const insertRes/);
  const catchIdx = body.indexOf('} catch (e) { /* best-effort persistence');
  assert.ok(tryIdx > -1 && catchIdx > tryIdx, 'insert must be wrapped in a best-effort try/catch');
  const responseIdx = body.search(/res\.status\(200\)\.json\(\{\s*\n\s*ok: true,\s*\n\s*reviewReply:/);
  assert.ok(responseIdx > catchIdx, 'the real draft response must still be sent after the best-effort insert, regardless of outcome');
});

check('the audit event only fires when a row was actually persisted (insertedId is real, never fabricated) and reuses the real \'review\' category', () => {
  const fnMatch = api.match(/async function handleReviewRepliesPost\(req, res\)[\s\S]*?(?=\nasync function handleDraftPostPost)/);
  const body = fnMatch[0];
  assert.match(body, /if \(insertedId\) \{\s*\n\s*await logMarketingAuditEvent\('review', 'reply_drafted', 'review_reply', insertedId, 'owner', \{ platform, sensitivityFlag, rating \}\);\s*\n\s*\}/);
  const sqlPath = path.join(repoRoot, 'sql', '040_marketing_campaign_draft_audit_event.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const checkMatch = sql.match(/category text not null check \(category in \(([\s\S]*?)\)\)/);
  assert.match(checkMatch[1], /'review'/);
});

check('handleReviewRepliesGet honestly degrades to an empty list + notice when marketing_review_replies is not synced', () => {
  const fnMatch = api.match(/async function handleReviewRepliesGet\(req, res\)[\s\S]*?(?=\nasync function handleReviewRepliesPost)/);
  assert.ok(fnMatch, 'could not isolate handleReviewRepliesGet body');
  const body = fnMatch[0];
  assert.match(body, /if \(e\.notSynced\) return res\.status\(200\)\.json\(\{ ok: true, replies: \[\], notice:/);
});

check('logMarketingAuditEvent helper is present (brought in from the audit-event-emission slices) -- this file builds on it, not a duplicate', () => {
  const occurrences = api.match(/async function logMarketingAuditEvent/g) || [];
  assert.equal(occurrences.length, 1, 'logMarketingAuditEvent must be defined exactly once');
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
