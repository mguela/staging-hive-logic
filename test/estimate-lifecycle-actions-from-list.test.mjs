// test/estimate-lifecycle-actions-from-list.test.mjs
// jomell, 2026-08-25: "there should be an option or feature to approve the
// draft. then it will go to 'awaiting response' and then we should be able
// to approve it and then it will be transferred to the 'approved' tab."
//
// The real lifecycle (draft -> sent -> approved -> converted) and the
// endpoints to drive it already existed and worked inside the estimate
// builder's live-status box (efRemoteSend/efRemoteRecordDeposit/
// efRemoteApprove/efRemoteConvert) -- but nothing reached them from the
// Estimates LIST, where a real/native row's "Edit in builder" still falls
// through to the old blank-estimate fallback (reopening a real estimate's
// line items needs a lines<->items format bridge that doesn't exist yet).
// This wires the SAME endpoints directly from the list's summary modal, so
// the lifecycle is reachable without needing that bigger fix first.
//
// Correction folded in here: moving draft -> awaiting response is actually
// SEND, not "approve" (the user's own wording conflated the two) -- Approve
// is the later step, gated on the deposit being paid, matching Chris's
// spec'd deposit-gate design. The button labels reflect the real lifecycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function estimatesRowClickHandler() {
  const anchor = source.indexOf('window._hlEstEdit=isLocalRow');
  assert.ok(anchor > -1, 'the local/real branch on _hlEstEdit must exist');
  const start = source.lastIndexOf("document.addEventListener('click',function(e){", anchor);
  return source.slice(start, source.indexOf('},true);', anchor) + 10);
}

test('nativeEstimateToRow carries the lifecycle fields the list needs to decide which button to show', () => {
  const start = source.indexOf('function nativeEstimateToRow(e){');
  let depth = 0, i = source.indexOf('{', start);
  do { if (source[i] === '{') depth++; else if (source[i] === '}') depth--; i++; } while (depth > 0);
  const fn = source.slice(start, i);
  assert.match(fn, /lifecycleStatus\s*:\s*e\.lifecycleStatus/);
  assert.match(fn, /depositSatisfied\s*:\s*!!e\.depositSatisfied/);
});

test('a draft estimate gets a Send button that calls the real send endpoint', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /lifecycleStatus===\s*'draft'/);
  assert.match(fn, /hlEstApi\('send',\{id:nid\}\)/);
});

test('a sent-but-unpaid estimate gets a deposit-recording action, not a raw Approve button', () => {
  // Approve must stay gated on the deposit -- this is Chris's spec'd
  // deposit-gate design, and approve.js itself blocks it server-side too.
  // 2026-08-25: the actual record-deposit-payment call moved into its own
  // efOpenRecordDepositModal() (a real in-app form replacing window.prompt) --
  // this just needs to confirm the button still routes there.
  const fn = estimatesRowClickHandler();
  assert.match(fn, /lifecycleStatus===\s*'sent'\s*&&\s*!nativeRow\.depositSatisfied/);
  assert.match(fn, /efOpenRecordDepositModal\(nid,num\)/);
});

test('approve only becomes available once the deposit is satisfied', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /lifecycleStatus===\s*'sent'\s*&&\s*nativeRow\.depositSatisfied/);
  assert.match(fn, /hlEstApi\('approve',\{id:nid\}\)/);
});

test('an approved estimate can convert to a job from the list too', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /lifecycleStatus===\s*'approved'/);
  assert.match(fn, /hlEstApi\('convert',\{id:nid\}\)/);
});

test('every lifecycle action refreshes the native list on success, so the row moves tabs live', () => {
  // 2026-08-25: record-deposit-payment's refresh call now lives inside
  // efOpenRecordDepositModal(), not inline in the click handler -- checked
  // separately so this still covers all four actions.
  const fn = estimatesRowClickHandler();
  const inlineCallCount = (fn.match(/loadNativeEstimatesLive\(\)/g) || []).length;
  assert.ok(inlineCallCount >= 3, 'send/approve/convert must each trigger a refresh on success');
  const start = source.indexOf('function efOpenRecordDepositModal(nid,num){');
  let depth = 0, i = source.indexOf('{', start);
  do { if (source[i] === '{') depth++; else if (source[i] === '}') depth--; i++; } while (depth > 0);
  const depositFn = source.slice(start, i);
  assert.match(depositFn, /loadNativeEstimatesLive\(\)/, 'recording a deposit payment must also refresh the list');
});

test('the lifecycle button is scoped to native rows only, never shown for local drafts or Jobber-synced rows', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /var isNativeRow\s*=\s*rowKey\.indexOf\('native:'\)===0/);
  assert.match(fn, /var nativeRow\s*=\s*isNativeRow\?/,
    'must not attempt to look up a native record for a local or Jobber-synced row');
});
