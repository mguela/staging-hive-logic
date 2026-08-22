// Phase 7 -- the command-center Budget screen now shows real per-channel
// pacing controls (monthly $, minimum viable spend, daily max, testing
// allowance, approval threshold, pause) backed by the Phase 4 pacing
// columns, saved through a new command_center_budget_channels resource
// that reuses handleSetupBudgetPost directly rather than a second write
// path. handleCommandCenterGet's budget field now also carries the real
// channel list, reusing setupBudgetShape rather than a second query.

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

function fullRenderBudgetBody() {
  const start = html.indexOf('function renderBudget(data){');
  const end = html.indexOf('function renderAssumptions', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('the real inline script is still syntactically valid JavaScript', () => {
  new vm.Script(extractInlineScript());
});

check('handleCommandCenterGet now includes real per-channel data reused from setupBudgetShape', () => {
  const start = api.indexOf('async function handleCommandCenterGet(req, res) {');
  const end = api.indexOf('async function handleCommandCenterBudgetPost');
  const fn = api.slice(start, end);
  assert.match(fn, /setupBudgetShape\(\)/);
  assert.match(fn, /channels: channelBudget\.channels/);
  assert.match(fn, /allocatedCents: channelBudget\.allocatedCents/);
});

check('a new command_center_budget_channels resource routes to the existing handleSetupBudgetPost, not a new handler', () => {
  const idx = api.indexOf("resource === 'command_center_budget_channels'");
  assert.ok(idx > -1, 'expected the new resource route to exist');
  const chunk = api.slice(idx, idx + 400);
  assert.match(chunk, /return await handleSetupBudgetPost\(req, res\);/);
});

check('the resource error message lists the new command_center_budget_channels route', () => {
  assert.match(api, /command_center_budget_channels \(POST\)/);
});

check('renderBudget reads the real channels array off data.budget, defaulting to empty', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /var channels = data\.budget\.channels \|\| \[\];/);
});

check('the channel pacing section only renders when there are real channels', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /\(channels\.length \? \(/);
  assert.match(fn, /\) : ''\);/);
});

check('each channel row shows all five pacing fields plus the monthly dollar figure, using the real per-channel values', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /c\.monthlyCents\/100/);
  assert.match(fn, /dv\(c\.minViableSpendCents\)/);
  assert.match(fn, /dv\(c\.dailyMaxCents\)/);
  assert.match(fn, /c\.testingAllowanceCents\/100/);
  assert.match(fn, /dv\(c\.approvalThresholdCents\)/);
  assert.match(fn, /c\.paused \? ' checked' : ''/);
});

check('channel labels are escaped through the existing esc() helper', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /esc\(c\.label\)/);
});

check('the Save Channel Settings button posts to command_center_budget_channels with the real per-channel payload', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /api\('command_center_budget_channels', \{method:'POST', body: JSON\.stringify\(\{monthlyDollars: Number\(slider\.value\), channels: payload\}\)\}\)/);
});

check('an unset pacing field posts as null, not a fabricated zero', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /function num\(id\)\{ var v = document\.getElementById\(id\)\.value; return v === '' \? null : Number\(v\); \}/);
});

check('a save failure re-enables the button and shows the real error message, matching the pattern used elsewhere in this file', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /window\.alert\('Could not save channel settings: ' \+ e\.message\)/);
});

check('the pre-existing aggregate Save Budget button and its command_center_budget call are unchanged', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /api\('command_center_budget', \{method:'POST', body: JSON\.stringify\(\{monthlyDollars: Number\(slider\.value\)\}\)\}\)/);
});

check('renderBudget is still defined exactly once', () => {
  assert.strictEqual((html.match(/function renderBudget\(data\)\{/g) || []).length, 1);
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
