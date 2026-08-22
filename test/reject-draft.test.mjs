// Ready for You -- Reject slice. Wires the send-review modal to the
// already-existing, already-safe campaign_delete backend endpoint
// (handleCampaignDeletePost -- confirmed present on origin/main: requires
// confirm:true, 404s on missing campaign, and refuses to delete a
// campaign that has already sent to at least one recipient or is
// active/sending, returning a real 409 instead) so the owner can reject a
// still-untouched draft directly from the modal, distinct from Cancel
// (which just closes without changing anything). No backend change
// needed -- this slice is frontend wiring + tests only.

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

check('the backend campaign_delete endpoint this slice relies on really exists, requires confirm, and refuses to delete a campaign that has already sent', () => {
  assert.match(marketing, /resource === 'campaign_delete' && req\.method === 'POST'/);
  const start = marketing.indexOf('async function handleCampaignDeletePost');
  const end = marketing.indexOf('\nasync function', start + 10);
  const fn = marketing.slice(start, end);
  assert.match(fn, /if \(!b\.confirm\) return res\.status\(400\)/);
  assert.match(fn, /hasSent \|\| campaign\.status === 'active' \|\| campaign\.status === 'sending'/);
  assert.match(fn, /status\(409\)/);
});

check('the main inline script is still syntactically valid JavaScript after the Reject insertion', () => {
  new vm.Script(extractInlineScript(), { filename: htmlPath });
});

function extractCcApprove() {
  const start = html.indexOf('function ccApprove');
  const end = html.indexOf('\n  // ---------- Your Plan', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('ccApprove\'s modal has a Reject button, visually separated (destructive styling) from Cancel/Send', () => {
  const fn = extractCcApprove();
  assert.match(fn, /rejectBtn\.textContent = 'Reject';/);
  assert.match(fn, /rejectBtn\.style\.cssText = 'margin:0;color:#a33;border-color:#e3b8b8;';/, 'Reject should be visually distinguished as destructive');
});

check('Reject asks for real confirmation before deleting, and calls campaign_delete with confirm:true', () => {
  const fn = extractCcApprove();
  const start = fn.indexOf("rejectBtn.addEventListener('click'");
  const end = fn.indexOf("var actionsRight = document.createElement('div');", start);
  const handler = fn.slice(start, end);
  assert.match(handler, /window\.confirm\('Reject and permanently delete this draft campaign\? This cannot be undone\.'\)/);
  assert.match(handler, /api\('campaign_delete', \{ method: 'POST', body: JSON\.stringify\(\{ campaignId: campaignId, confirm: true \}\) \}\)/);
});

check('Reject closes the modal and refreshes the list only on real success, and surfaces the real backend error (e.g. already-sent 409) otherwise', () => {
  const fn = extractCcApprove();
  const start = fn.indexOf("rejectBtn.addEventListener('click'");
  const end = fn.indexOf("var actionsRight = document.createElement('div');", start);
  const handler = fn.slice(start, end);
  assert.match(handler, /if \(!d \|\| !d\.ok\) \{\s*window\.alert\(\(d && d\.error\) \|\| 'Could not reject this campaign\.'\);/);
  assert.match(handler, /close\(\);\s*loadAndRender\(\);/);
});

check('Reject and Cancel are both disabled together while the delete request is in flight (no double-submit)', () => {
  const fn = extractCcApprove();
  const start = fn.indexOf("rejectBtn.addEventListener('click'");
  const end = fn.indexOf("var actionsRight = document.createElement('div');", start);
  const handler = fn.slice(start, end);
  assert.match(handler, /rejectBtn\.disabled = true;/);
  assert.match(handler, /cancelBtn\.disabled = true;/);
});

check('Reject sits on its own side of the actions row, separate from the Cancel/Save/Send group', () => {
  const fn = extractCcApprove();
  const idx = fn.indexOf('actionsRight.appendChild(cancelBtn);');
  const chunk = fn.slice(idx, idx + 260);
  assert.match(chunk, /actionsRight\.appendChild\(cancelBtn\);\s*actionsRight\.appendChild\(saveDraftBtn\);\s*actionsRight\.appendChild\(sendBtn\);\s*actions\.appendChild\(rejectBtn\);\s*actions\.appendChild\(actionsRight\);/);
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
