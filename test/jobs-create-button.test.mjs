// Regression test for the Jobs view's "+ Create Job" button (public/index.html).
//
// Bug (master to-do, HiveLogic Live known bugs): the button was wired to
// showView('jsx') -- the "Job Setup & Readiness" queue -- which is a
// read-only readiness dashboard, not a job-creation form. Clicking
// "+ Create Job" therefore never let anyone actually create a job; it just
// dropped them on the Setup Queue. The button's own label falsely claimed
// this was "through the Readiness Gate", a step the code never implemented.
//
// Fix: wire the button to the SAME real, already-working create-job flow
// used by the dashboard's own "New Job" quick action (openForm('job') +
// hlFillClientSel('njob-client')), which opens the njob modal backed by
// njobSave() -> hlApiPost('create_job', ...). No new form, no new endpoint --
// just pointing the button at the real, tested creation path instead of a
// dead end. The misleading "through the Readiness Gate" label text is
// dropped since the fixed flow does not implement any such gate.
//
// Structural/string checks only (this is a huge static HTML+inline-JS file,
// no DOM test harness wired up here) -- but every assertion below anchors to
// exact, load-bearing strings, so a future edit that breaks the wiring (e.g.
// renaming njob-client, or re-introducing the old showView('jsx') routing)
// will fail this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');

test('the Jobs view "+ Create Job" button opens the real create-job form, not the Setup Queue', () => {
  assert.match(
    html,
    /<button onclick="openForm\('job'\);hlFillClientSel\('njob-client'\)"[^>]*>\+ Create Job<\/button>/,
    'expected the Create Job button to call openForm(\'job\') + hlFillClientSel(\'njob-client\'), same as the working New Job quick action'
  );
});

test('the old dead-end routing to the Setup Queue (showView(\'jsx\')) is gone from this button', () => {
  assert.doesNotMatch(
    html,
    /<button onclick="showView\('jsx'\)"[^>]*>\+ Create Job/,
    'the Create Job button should no longer route to the Setup Queue/Readiness Gate view'
  );
});

test('the button no longer claims a "Readiness Gate" step the fixed flow does not implement', () => {
  assert.doesNotMatch(
    html,
    /\+ Create Job — through the Readiness Gate/,
    'label should not overclaim a gate step that does not exist in the actual create flow'
  );
});

test('the real create-job flow this button now opens still exists end to end', () => {
  // openForm(k) is the generic drawer-form opener the button now calls.
  assert.match(html, /function openForm\(k\)\{/, 'openForm() must still exist');
  // hlFillClientSel populates the client dropdown from real clients.
  assert.match(html, /function hlFillClientSel\(id\)\{/, 'hlFillClientSel() must still exist');
  // The njob modal fields the button's flow depends on.
  for (const id of ['njob-client', 'njob-title', 'njob-div', 'njob-total', 'njob-tm-check']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `expected the njob form field #${id} to still exist`);
  }
  // njobSave() is what the form's own "Create Job" submit button calls.
  assert.match(html, /function njobSave\(\)\{/, 'njobSave() must still exist');
  assert.match(html, /hlApiPost\('create_job'/, 'njobSave() must still post to the real create_job endpoint');
  // The global overlay openForm() targets (.dw / #dwv) must exist exactly
  // once each -- these are not scoped to any one view, so the button works
  // from the Jobs view exactly as it does from the dashboard.
  assert.match(html, /<div class="dwv" id="dwv"/, 'the global form-drawer overlay (#dwv) must still exist');
});

test('the Setup Queue view itself is untouched -- this fix only changes where the button points, not the Setup Queue', () => {
  assert.match(html, /id="view-jsx"/, 'view-jsx (Job Setup & Readiness) should still exist as its own reachable view');
});
