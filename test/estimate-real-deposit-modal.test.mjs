// test/estimate-real-deposit-modal.test.mjs
// jomell, 2026-08-25: recording a $40 deposit payment threw "Payment of
// $40.00 would bring the deposit's credited total to $1041.60, more than
// the required deposit of $1040.00" -- typed blind into a bare
// window.prompt() with no indication of how much was actually still owed.
// Separately: "this was drafted by 50% payment upfront and then 50% upon
// completion. however its making it pay the whole amount" -- traced to the
// summary modal's "Payment schedule & payouts" block, which showed a
// hardcoded 35/35/30 split for EVERY estimate regardless of what it was
// actually drafted with.
//
// Also: "instead of the popup by chrome, there should be our own popup" --
// window.prompt()/confirm() replaced with a real hlModal()-based form that
// shows the actual remaining balance, caps the input to it, and validates
// before ever calling the server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start > -1, `${decl} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  assert.equal(depth, 0, 'braces must balance');
  return src.slice(start, i);
}

test('recording a deposit payment no longer uses window.prompt or window.confirm', () => {
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  assert.doesNotMatch(fn, /window\.prompt|window\.confirm/,
    'must use the app\'s own hlModal() form, not a native browser dialog');
  assert.match(fn, /hlModal\(/);
});

test('the deposit modal shows the real remaining balance before anyone types an amount', () => {
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  assert.match(fn, /row\.depositRequired\s*-\s*\(row\.depositCreditedTotal\|\|0\)/,
    'must compute the actual remaining balance from this specific estimate\'s real data');
  assert.match(fn, /Remaining to satisfy the deposit/);
});

test('the amount input is capped to the real remaining balance, not left open-ended', () => {
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  assert.match(fn, /max="'\+initial\.toFixed\(2\)\+'"/,
    'the HTML max attribute alone is not enough (browsers do not enforce it) -- there must also be a JS check');
});

test('the payable amount is recomputed per payment method, matching the server\'s cash-discount math', () => {
  // 2026-08-25: "this kinda doesnt make sense" -- the default amount/method
  // (Check, a cash-discount method) was computed off the CARD-priced
  // remaining, so accepting the shown default and submitting overshot the
  // actual required credit and got rejected by the server. A cash/check/ACH
  // payment must divide by the same cardPrice/cashPrice ratio the server's
  // creditedAmount() (server/bookkeeping/src/card-pricing.js) multiplies by.
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  assert.match(fn, /RDP_DISCOUNT_METHODS\s*=\s*\['cash','check','ach'\]/);
  assert.match(fn, /credRemaining\s*\/\s*cashRatio/,
    'a cash/check/ACH payment must divide by the card/cash ratio, not use the card-priced figure as-is');
  assert.match(fn, /cashRatio\s*=.*row\.depositRequired\s*\/\s*row\.depositRequiredCash/,
    'the ratio must come from this estimate\'s own posted vs. cash amounts');
});

test('changing the payment method recomputes the amount live, instead of leaving a stale default', () => {
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  assert.match(fn, /onchange="_hlRdpMethodChange\(\)"/);
  assert.match(fn, /window\._hlRdpMethodChange\s*=\s*function/);
  const methodChangeStart = fn.indexOf('window._hlRdpMethodChange');
  const methodChangeFn = fn.slice(methodChangeStart, fn.indexOf('};', methodChangeStart));
  assert.match(methodChangeFn, /rdpAmountFor\(method\)/);
  assert.match(methodChangeFn, /input\.value\s*=\s*amt\.toFixed\(2\)/,
    'switching methods must update the shown amount, not just its cap');
});

test('an overpayment is caught client-side before ever calling the server', () => {
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  assert.match(fn, /amt2\s*>\s*remaining\s*\+\s*0\.01/,
    'must reject an amount over the remaining balance locally, with the exact reason, instead of round-tripping to the server to find out');
});

test('satisfying the deposit reveals an inline Approve action in the SAME modal, not a second click-through', () => {
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  assert.match(fn, /d\.estimate\s*&&\s*d\.estimate\.depositSatisfied/);
  assert.match(fn, /_hlRdpApproveNow/);
});

test('satisfying the deposit does NOT auto-approve -- a human still has to click', () => {
  // jomell explicitly chose "one-click reveal" over "fully automatic" --
  // approve.js itself also requires the controller/admin role, a real
  // authorization gate this must not bypass.
  const fn = extractFunction(source, 'function efOpenRecordDepositModal(nid,num){');
  const satisfiedBranchStart = fn.search(/if\(d\.estimate&&d\.estimate\.depositSatisfied\)\{/);
  assert.ok(satisfiedBranchStart > -1);
  const approveCallIdx = fn.indexOf("hlEstApi('approve'", satisfiedBranchStart);
  const approveNowDefIdx = fn.indexOf('window._hlRdpApproveNow=function', satisfiedBranchStart);
  assert.ok(approveNowDefIdx > -1 && approveCallIdx > approveNowDefIdx,
    'the approve call must live inside the button\'s own click handler, not fire immediately when the deposit is satisfied');
});

test('the summary modal shows the estimate\'s REAL payment schedule, not a hardcoded 35/35/30 split', () => {
  const start = source.indexOf('function nativeEstimateToRow(e){');
  let depth = 0, i = source.indexOf('{', start);
  do { if (source[i] === '{') depth++; else if (source[i] === '}') depth--; i++; } while (depth > 0);
  const fn = source.slice(start, i);
  assert.match(fn, /paymentSchedule\s*:\s*e\.paymentSchedule/,
    'the real schedule (whatever percentages it actually has) must be carried through');
  assert.match(fn, /totalPrice\s*:/);
});

function estimatesRowClickHandler() {
  const anchor = source.indexOf('window._hlEstEdit=isLocalRow');
  const start = source.lastIndexOf("document.addEventListener('click',function(e){", anchor);
  return source.slice(start, source.indexOf('},true);', anchor) + 10);
}

test('a native row with a real schedule renders it instead of the fake 35/35/30 block', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /if\(nativeRow&&nativeRow\.paymentSchedule&&nativeRow\.paymentSchedule\.length\)\{/,
    'must branch on whether real schedule data actually exists for this row');
  assert.match(fn, /nativeRow\.paymentSchedule\.forEach/,
    'must iterate the estimate\'s own rows, not a fixed 3-row template');
});

test('the fake 35/35/30 block is kept ONLY as the fallback for rows with no real schedule data', () => {
  // Local drafts and Jobber-synced rows have no server-side paymentSchedule
  // to show instead -- removing the fallback entirely would leave them with
  // nothing, which is a separate, bigger fix than what was asked for here.
  const fn = estimatesRowClickHandler();
  assert.match(fn, /\}\s*else\s*\{[\s\S]*?T1 · DEPOSIT','35% on signature'/,
    'the old hardcoded block must only run in the else branch, never for a row that has real data');
});

test('a real payment row\'s dollar amount is computed from the estimate\'s own total, not a fake percentage of it', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /tp\s*\*\s*\(\+r\.pct\|\|0\)\s*\/\s*100/,
    'must multiply the REAL total by the REAL row percentage -- e.g. 50%, not the hardcoded 35/35/30');
});
