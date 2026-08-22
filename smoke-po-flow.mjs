// Exercises the actual rewritten route handlers (not just the engine) end
// to end: create -> approve -> match (creating an exception) -> force-close
// with a controller override.
//
// ROUND 4 UPDATE: this sandbox has no real Supabase project to authenticate
// against, so real HTTP calls to Supabase Auth / PostgREST are not possible
// here. Rather than fake it by going back to trusting request headers (the
// exact hole Round 3 flagged), this script mocks global fetch to answer
// ONLY the two calls _actor.js actually makes -- GET .../auth/v1/user and
// GET .../rest/v1/profiles?id=eq.<uid> -- with a fixed table of two real
// profile shapes (an admin and a crew member). Every other request (the
// durable-store PostgREST calls only run when BOOKKEEPING_PO_STORE=durable,
// which is not set here, so the memory backend is exercised instead) is
// unaffected. This proves the real async, Supabase-Auth-verifying code path
// in _actor.js actually runs and gates correctly -- it does not fall back to
// trusting client-supplied headers at any point.
process.env.BOOKKEEPING_ENABLED = 'true';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'mock-service-key';
// Round 3 correction #2: memory-mode storage now requires an explicit
// development/test opt-in rather than being a silent default. This script is
// exactly that kind of local/demo use.
process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';

const PROFILES = {
  'token-amy': { user: { id: 'uid-amy' }, profile: { id: 'uid-amy', email: 'amy@greenwichhandyman.com', full_name: 'Amy (field tech)', role: 'crew' } },
  'token-chris': { user: { id: 'uid-chris' }, profile: { id: 'uid-chris', email: 'chris@ghgrp.net', full_name: 'Chris', role: 'admin' } },
  'token-spoofed': null // simulates a bearer token Supabase does not recognize at all
};

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const authHeader = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (u.includes('/auth/v1/user')) {
    const entry = PROFILES[token];
    if (!entry) return { ok: false, status: 401, json: async () => ({ error: 'invalid token' }) };
    return { ok: true, status: 200, json: async () => entry.user };
  }
  if (u.includes('/rest/v1/profiles')) {
    const entry = Object.values(PROFILES).find(p => p && u.includes(encodeURIComponent(p.user.id)));
    return { ok: true, status: 200, json: async () => (entry ? [entry.profile] : []) };
  }
  return realFetch(url, opts);
};

function mockReqRes(headers, body) {
  const res = {
    _status: 200, _json: null,
    status(s) { this._status = s; return this; },
    json(j) { this._json = j; return this; }
  };
  const req = { method: 'POST', headers, body };
  return { req, res };
}

// crew -> mapped to 'field' (create/request only); admin -> mapped to
// 'controller' (satisfies every approve/reject/force-close gate the engine
// has). There is no separate real "approver" identity in this single-tenant,
// two-role app -- Chris is, in practice, the approver/controller/bookkeeper
// today, same as the real profiles table.
const AMY_HEADERS = { Authorization: 'Bearer token-amy' };
const CHRIS_HEADERS = { Authorization: 'Bearer token-chris' };
const SPOOFED_HEADERS = { 'x-hivelogic-user-id': 'chris', 'x-hivelogic-user-role': 'controller', 'x-hivelogic-company-id': 'co-greenwich' };

async function call(handlerPath, headers, body) {
  const mod = await import(handlerPath);
  const { req, res } = mockReqRes(headers, body);
  await mod.default(req, res);
  if (res._status >= 400) throw new Error(`${handlerPath} -> ${res._status}: ${JSON.stringify(res._json)}`);
  return res._json;
}

const base = './api/bookkeeping/purchase-orders';

console.log('0) confirm spoofed x-hivelogic-* headers (no Authorization bearer) are rejected...');
let spoofRejected = false;
try {
  await call(`${base}/create.js`, SPOOFED_HEADERS, { jobId: '231', vendorName: 'Nope', lines: [] });
} catch (e) {
  spoofRejected = /401/.test(e.message);
}
if (!spoofRejected) throw new Error('SECURITY REGRESSION: a request with only spoofable x-hivelogic-* headers was NOT rejected.');
console.log('    correctly rejected (401) -- header-spoofing no longer works.');

console.log('1) create planned PO (requester: amy, real crew profile, verified via mocked Supabase Auth)...');
const created = await call(`${base}/create.js`, AMY_HEADERS, {
  jobId: '231', vendorName: 'Home Depot', requestedBy: 'someone-else-entirely', // must be IGNORED (correction #12)
  lines: [{ type: 'material', description: '2x4 lumber', estimatedQty: 50, estimatedUnitPrice: 4.5 }]
});
console.log('   ', created.purchaseOrder.poNumber, created.purchaseOrder.status, '(storeBackend:', created.storeBackend, ')');
if (created.purchaseOrder.requestedBy !== 'uid-amy') throw new Error(`SECURITY REGRESSION: requestedBy was "${created.purchaseOrder.requestedBy}", expected the authenticated actor id "uid-amy" (client override must be ignored).`);
console.log('    requestedBy correctly bound to the authenticated actor (client-supplied override ignored).');
const poId = created.purchaseOrder.id;

console.log('2) approve (chris, real admin profile -> mapped to controller)...');
const approved = await call(`${base}/approve.js`, CHRIS_HEADERS, { poId });
console.log('   ', approved.purchaseOrder.status, 'orderedAt:', approved.purchaseOrder.orderedAt);

console.log('3) match a receipt with EXCESS QUANTITY (60 instead of 50) to create an exception...');
const matched = await call(`${base}/match.js`, CHRIS_HEADERS, {
  receipt: {
    id: 'receipt-1', companyId: 'greenwich-handyman', vendorTransactionDate: new Date().toISOString(),
  },
  matches: [{ poId, lineId: created.purchaseOrder.lines[0].id, receiptLineId: 'rline-1', allocationId: 'a1', quantity: 60, unitPrice: 4.5 }]
});
console.log('   ', matched.purchaseOrders[0].status, 'exceptions:', matched.purchaseOrders[0].exceptions);

console.log('4) attempt a normal close (should fail: unresolved exception)...');
let blockedAsExpected = false;
try {
  await call(`${base}/close.js`, CHRIS_HEADERS, { poId });
} catch (e) {
  blockedAsExpected = true;
  console.log('    blocked as expected:', e.message);
}
if (!blockedAsExpected) throw new Error('Expected a plain close to be blocked while an exception is unresolved.');

console.log('5) force-close with a controller override + written reason...');
const closed = await call(`${base}/close.js`, CHRIS_HEADERS, { poId, force: true, reason: 'Overage approved verbally by Chris on-site; documenting after the fact.' });
console.log('   ', closed.purchaseOrder.status, 'closedForced:', closed.purchaseOrder.closedForced, 'history entries:', closed.purchaseOrder.history.length);

console.log('\nALL STEPS PASSED — full PO lifecycle exercised through the real route handlers with real (mocked-transport) Supabase Auth verification.');

console.log('\n6) pull the job cost report — preapproved vs after-the-fact must stay visibly separate...');
const report = await call(`${base}/job-cost-report.js`, CHRIS_HEADERS, {});
console.log('   job', report.jobs[0].jobId, '-> preapproved: $' + report.jobs[0].preapprovedTotal, '| after-the-fact: $' + report.jobs[0].afterTheFactTotal);
console.log('   company totals:', report.companyTotals);

console.log('\n7) record an after-the-fact purchase on the same job and confirm it lands in the SEPARATE bucket...');
const atf = await call(`${base}/create.js`, AMY_HEADERS, {
  orderType: 'after_the_fact', jobId: '231', vendorName: 'AutoZone',
  afterTheFactReason: 'Truck broke down, emergency parts run',
  lines: [{ type: 'material', description: 'Emergency belt + fluid', estimatedQty: 1, estimatedUnitPrice: 62.4 }]
});
await call(`${base}/approve.js`, CHRIS_HEADERS, { poId: atf.purchaseOrder.id });
await call(`${base}/match.js`, CHRIS_HEADERS, {
  receipt: { id: 'receipt-2', companyId: 'greenwich-handyman', vendorTransactionDate: new Date().toISOString() },
  matches: [{ poId: atf.purchaseOrder.id, lineId: atf.purchaseOrder.lines[0].id, receiptLineId: 'rline-2', allocationId: 'a1', quantity: 1, unitPrice: 62.4 }]
});
await call(`${base}/close.js`, CHRIS_HEADERS, { poId: atf.purchaseOrder.id });
const report2 = await call(`${base}/job-cost-report.js`, CHRIS_HEADERS, {});
const job231 = report2.jobs.find(j => j.jobId === '231');
console.log('   job 231 after adding the AutoZone after-the-fact purchase:');
console.log('     preapproved: $' + job231.preapprovedTotal, '(unchanged)');
console.log('     after-the-fact: $' + job231.afterTheFactTotal, '(went up by 62.40, kept OUT of preapproved)');
if (job231.afterTheFactTotal < 62) throw new Error('After-the-fact purchase did not land in the separate bucket.');
if (job231.preapprovedTotal > 300) throw new Error('After-the-fact purchase leaked into the preapproved bucket.');
console.log('\nJOB COST REPORT PASSED — preapproved and after-the-fact dollars stayed distinct.');

console.log('\n8) Round 3 correction #4/#5 adversarial test: a genuine valid 60/40 split of ONE receipt across TWO different purchase orders, in a single match.js call...');
const poX = await call(`${base}/create.js`, AMY_HEADERS, {
  jobId: '410', vendorName: 'Ferguson Supply',
  lines: [{ type: 'material', description: 'PVC fittings', estimatedQty: 2, estimatedUnitPrice: 89.5 }]
});
const poY = await call(`${base}/create.js`, AMY_HEADERS, {
  jobId: '411', vendorName: 'Ferguson Supply',
  lines: [{ type: 'material', description: 'PVC fittings', estimatedQty: 2, estimatedUnitPrice: 89.5 }]
});
await call(`${base}/approve.js`, CHRIS_HEADERS, { poId: poX.purchaseOrder.id });
await call(`${base}/approve.js`, CHRIS_HEADERS, { poId: poY.purchaseOrder.id });
// The OLD (broken) route grouped matches by poId and called the engine once
// PER PO, so it only ever saw ONE PO's slice of a cross-PO split (e.g. just
// the 0.6 portion) and would incorrectly reject this every time with "must
// total exactly 100%". The fix calls the engine once with BOTH POs and BOTH
// matches together, so the split is validated and applied as one receipt.
const splitResult = await call(`${base}/match.js`, CHRIS_HEADERS, {
  receipt: { id: 'receipt-6040', companyId: 'greenwich-handyman', vendorTransactionDate: new Date().toISOString(), lines: [{ id: 'rl-6040', amount: 179 }] },
  matches: [
    { poId: poX.purchaseOrder.id, lineId: poX.purchaseOrder.lines[0].id, receiptLineId: 'rl-6040', splitPortion: 0.6, quantity: 2, unitPrice: 89.5 },
    { poId: poY.purchaseOrder.id, lineId: poY.purchaseOrder.lines[0].id, receiptLineId: 'rl-6040', splitPortion: 0.4, quantity: 2, unitPrice: 89.5 }
  ]
});
const splitX = splitResult.purchaseOrders.find(po => po.id === poX.purchaseOrder.id);
const splitY = splitResult.purchaseOrders.find(po => po.id === poY.purchaseOrder.id);
console.log('    PO X (60%) received amount: $' + splitX.lines[0].receivedAmount);
console.log('    PO Y (40%) received amount: $' + splitY.lines[0].receivedAmount);
if (splitX.lines[0].receivedAmount !== 107.4) throw new Error(`Expected PO X to receive $107.40 (60% of $179), got $${splitX.lines[0].receivedAmount}.`);
if (splitY.lines[0].receivedAmount !== 71.6) throw new Error(`Expected PO Y to receive $71.60 (40% of $179), got $${splitY.lines[0].receivedAmount}.`);
console.log('\nCROSS-PO SPLIT TEST PASSED — a genuine valid 60/40 split committed to both purchase orders in one atomic call.');

console.log('\n9) Round 3 correction #9 adversarial test: duplicate-bill storage mapping actually works end-to-end (record a bill via match.js, then re-match the same invoice and confirm duplicate_bill fires)...');
const poDup1 = await call(`${base}/create.js`, AMY_HEADERS, {
  jobId: '500', vendorName: 'Ferguson Supply',
  lines: [{ type: 'material', description: 'Copper pipe', estimatedQty: 1, estimatedUnitPrice: 250 }]
});
const poDup2 = await call(`${base}/create.js`, AMY_HEADERS, {
  jobId: '501', vendorName: 'Ferguson Supply',
  lines: [{ type: 'material', description: 'Copper pipe', estimatedQty: 1, estimatedUnitPrice: 250 }]
});
await call(`${base}/approve.js`, CHRIS_HEADERS, { poId: poDup1.purchaseOrder.id });
await call(`${base}/approve.js`, CHRIS_HEADERS, { poId: poDup2.purchaseOrder.id });
// First receipt: records INV-DUP-1 into po_seen_bills via recordSeenBill.
await call(`${base}/match.js`, CHRIS_HEADERS, {
  receipt: { id: 'receipt-dup-source', companyId: 'greenwich-handyman', vendorTransactionDate: new Date().toISOString(), qboVendorId: 'qbo-ferguson', vendorName: 'Ferguson Supply', invoiceNumber: 'INV-DUP-1', currency: 'USD', amount: 250 },
  matches: [{ poId: poDup1.purchaseOrder.id, lineId: poDup1.purchaseOrder.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 250 }]
});
// Second, DIFFERENT receipt, but the SAME vendor/invoice/currency/amount --
// this must be flagged duplicate_bill against the OTHER PO, proving
// getExistingBills actually reads back what recordSeenBill wrote (the exact
// mapping this correction fixed -- previously bill.companyId/bill.amount
// were undefined on every row read back, so this could never fire).
const dupMatch = await call(`${base}/match.js`, CHRIS_HEADERS, {
  receipt: { id: 'receipt-dup-lookalike', companyId: 'greenwich-handyman', vendorTransactionDate: new Date().toISOString(), qboVendorId: 'qbo-ferguson', vendorName: 'Ferguson Supply', invoiceNumber: 'INV-DUP-1', currency: 'USD', amount: 250 },
  matches: [{ poId: poDup2.purchaseOrder.id, lineId: poDup2.purchaseOrder.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 250 }]
});
const dupPo = dupMatch.purchaseOrders.find(po => po.id === poDup2.purchaseOrder.id);
console.log('    second match exceptions:', dupPo.exceptions);
if (!dupPo.exceptions.includes('duplicate_bill')) throw new Error('SECURITY/CORRECTNESS REGRESSION: a same vendor/invoice/currency/amount bill was not flagged duplicate_bill -- the store-to-engine field mapping is broken again.');
console.log('\nDUPLICATE-BILL STORAGE MAPPING TEST PASSED — recordSeenBill/getExistingBills round-trip correctly into the engine\'s duplicate check.');
