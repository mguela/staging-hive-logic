// Ready for You -- Save Draft (Edit) slice. Wires the send-review modal's
// existing subject/body editor to the already-built, already-working
// campaign_update backend endpoint (handleCampaignUpdatePost -- confirmed
// present and load-bearing on origin/main, used by handleCampaignsPost,
// handleCampaignDuplicatePost, and process_scheduled_sends already) so
// edits can be persisted to the draft campaign without immediately
// sending to real recipients. No backend change needed -- this slice is
// frontend wiring + tests only.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const marketingPath = 'api/marketing.js';
const htmlPath = 'public/marketing-command-center/index.html';
const marketing = fs.readFileSync(marketingPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractInlineScript() {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('marketing.js syntax is unchanged and valid (this slice is frontend-only)', () => {
  execFileSync(process.execPath, ['--check', marketingPath]);
});

check('the backend campaign_update endpoint this slice relies on really exists and supports subject/body patches', () => {
  assert.match(marketing, /resource === 'campaign_update' && req\.method === 'POST'/);
  const start = marketing.indexOf('async function handleCampaignUpdatePost');
  const end = marketing.indexOf('\nasync function', start + 10);
  const fn = marketing.slice(start, end);
  assert.match(fn, /if \(campaign\.status !== 'draft'\)/, 'must refuse to edit a non-draft campaign');
  assert.match(fn, /patch\.subject = b\.subject\.trim\(\) \|\| null;/);
  assert.match(fn, /patch\.body = b\.body\.trim\(\) \|\| null;/);
});

check('the main inline script is still syntactically valid JavaScript after the Save Draft insertion', () => {
  new vm.Script(extractInlineScript(), { filename: htmlPath });
});

function extractCcApprove() {
  const start = html.indexOf('function ccApprove');
  const end = html.indexOf('\n  // ---------- Your Plan', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('ccApprove\'s modal has a Save Draft button between Cancel and Send', () => {
  const fn = extractCcApprove();
  const cancelIdx = fn.indexOf("cancelBtn.textContent = 'Cancel';");
  const saveIdx = fn.indexOf("saveDraftBtn.textContent = 'Save Draft';");
  const sendIdx = fn.indexOf('sendBtn.textContent = remaining');
  assert.ok(cancelIdx > -1 && saveIdx > -1 && sendIdx > -1, 'all three buttons must be defined');
  assert.ok(cancelIdx < saveIdx && saveIdx < sendIdx, 'Save Draft must be defined between Cancel and Send');
});

check('Save Draft calls campaign_update with the currently-edited subject/body, not campaign_send', () => {
  const fn = extractCcApprove();
  const start = fn.indexOf("saveDraftBtn.addEventListener('click'");
  const end = fn.indexOf("var sendBtn = document.createElement('button');", start);
  const handler = fn.slice(start, end);
  assert.match(handler, /api\('campaign_update', \{ method: 'POST', body: JSON\.stringify\(\{ campaignId: campaignId, subject: subject, body: body \}\) \}\)/);
  assert.doesNotMatch(handler, /campaign_send/, 'Save Draft must never trigger a real send');
  assert.match(handler, /if \(!subject\) \{ window\.alert\('Subject is required\.'\); return; \}/);
  assert.match(handler, /if \(!body\) \{ window\.alert\('Body is required\.'\); return; \}/);
});

check('Save Draft does not close the modal or trigger a list refresh on success (owner can keep editing or send after saving)', () => {
  const fn = extractCcApprove();
  const start = fn.indexOf("saveDraftBtn.addEventListener('click'");
  const end = fn.indexOf("var sendBtn = document.createElement('button');", start);
  const handler = fn.slice(start, end);
  assert.doesNotMatch(handler, /\bclose\(\)/);
  assert.doesNotMatch(handler, /loadAndRender\(\)/);
  assert.match(handler, /saveDraftBtn\.textContent = 'Saved';/, 'must show a real success indicator, not silently do nothing');
});

check('all three action buttons are appended to the modal in the right order', () => {
  const fn = extractCcApprove();
  // After integration with the Reject slice, Cancel/Save/Send are grouped in
  // the actionsRight container (Reject sits separately on the left); the
  // Cancel < Save Draft < Send order is preserved within that group.
  const idx = fn.indexOf('actionsRight.appendChild(cancelBtn);');
  const chunk = fn.slice(idx, idx + 260);
  assert.match(chunk, /actionsRight\.appendChild\(cancelBtn\);\s*actionsRight\.appendChild\(saveDraftBtn\);\s*actionsRight\.appendChild\(sendBtn\);/);
});

check('no scratch/temp files leaked into the tracked source files', () => {
  assert.doesNotMatch(marketing, /scratch_/);
  assert.doesNotMatch(html, /scratch_/);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
