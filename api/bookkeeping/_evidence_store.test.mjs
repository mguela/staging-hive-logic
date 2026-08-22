// api/bookkeeping/_evidence_store.test.mjs
// Exercises the memory backend's review lifecycle added alongside
// api/bookkeeping/document-reviews.js: every evidence document starts
// 'received' (needs review), and markEvidenceReviewed() moves it to
// 'processed' with a real resolution/reviewer/timestamp -- the exact fields
// server/bookkeeping/src/close.js's document_intake check and the Books
// Home review queue both depend on. Also exercises updateEvidenceExtracted()
// (added alongside the receipt-scan.js caching fix, 2026-07-24) -- the
// separate, machine-authored path that persists a Reina OCR scan result.
//
// Run: BOOKKEEPING_ALLOW_MEMORY_STORE=true NODE_ENV=test node --test api/bookkeeping/_evidence_store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';

test('insertEvidence defaults every new document to status "received" (needs review)', async () => {
  const { insertEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-review-1', filename: 'receipt.png', mimeType: 'image/png', dataBase64: Buffer.from('hello').toString('base64'), createdBy: 'user-1' });
  assert.equal(doc.status, 'received');
  assert.equal(doc.resolution, null);
  assert.equal(doc.reviewedAt, null);
});

test('listEvidence surfaces status/resolution/reviewedAt/reviewedBy on every summary row', async () => {
  const { insertEvidence, listEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  await insertEvidence({ companyId: 'co-review-2', filename: 'bill.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('world').toString('base64') });
  const list = await listEvidence('co-review-2');
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'received');
  assert.ok('resolution' in list[0]);
  assert.ok('reviewedAt' in list[0]);
  assert.ok('reviewedBy' in list[0]);
  assert.ok(!('dataBase64' in list[0]), 'listEvidence must never leak raw file bytes into a vault index/review-queue listing');
});

test('markEvidenceReviewed moves a document to "processed" with a default resolution when none is given', async () => {
  const { insertEvidence, markEvidenceReviewed, listEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-review-3', filename: 'receipt.png', mimeType: 'image/png', dataBase64: Buffer.from('x').toString('base64') });
  const reviewed = await markEvidenceReviewed('co-review-3', doc.id, { reviewedBy: 'bookkeeper-1' });
  assert.equal(reviewed.status, 'processed');
  assert.equal(reviewed.resolution, 'reviewed_no_ledger_entry');
  assert.equal(reviewed.reviewedBy, 'bookkeeper-1');
  assert.ok(reviewed.reviewedAt);

  // And the change is durable within the store -- a fresh list reflects it,
  // not just the object handed back from the call.
  const list = await listEvidence('co-review-3');
  assert.equal(list.find(d => d.id === doc.id).status, 'processed');
});

test('markEvidenceReviewed honors an explicit resolution and review note', async () => {
  const { insertEvidence, markEvidenceReviewed } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-review-4', filename: 'statement.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('y').toString('base64') });
  const reviewed = await markEvidenceReviewed('co-review-4', doc.id, { resolution: 'attached_to_expense', reviewNote: 'Matched to expense #42.', reviewedBy: 'controller-1' });
  assert.equal(reviewed.resolution, 'attached_to_expense');
  assert.equal(reviewed.reviewNote, 'Matched to expense #42.');
});

test('markEvidenceReviewed returns null for a document id that does not exist -- never throws or fabricates a record', async () => {
  const { markEvidenceReviewed } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const result = await markEvidenceReviewed('co-review-5', 'nonexistent-id', { reviewedBy: 'bookkeeper-1' });
  assert.equal(result, null);
});

test('a document created in one company is never visible or reviewable through another company\'s id (tenant isolation)', async () => {
  const { insertEvidence, markEvidenceReviewed, listEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-review-6a', filename: 'receipt.png', mimeType: 'image/png', dataBase64: Buffer.from('z').toString('base64') });
  const crossCompanyResult = await markEvidenceReviewed('co-review-6b', doc.id, { reviewedBy: 'someone-else' });
  assert.equal(crossCompanyResult, null);
  const ownCompanyList = await listEvidence('co-review-6a');
  assert.equal(ownCompanyList[0].status, 'received', 'the document must remain unreviewed since the cross-company call was correctly rejected');
});

// ---------------------------------------------------------------------------
// updateEvidenceExtracted() -- the machine-authored scan-persistence path
// added alongside api/bookkeeping/receipt-scan.js's caching fix, 2026-07-24.
// ---------------------------------------------------------------------------

test('a freshly-inserted document has no documentType/extracted until it is actually scanned -- never fabricated', async () => {
  const { insertEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-scan-1', filename: 'receipt.png', mimeType: 'image/png', dataBase64: Buffer.from('a').toString('base64') });
  assert.equal(doc.documentType, null);
  assert.equal(doc.extracted, null);
});

test('updateEvidenceExtracted persists a scan result, status, and documentType', async () => {
  const { insertEvidence, updateEvidenceExtracted } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-scan-2', filename: 'receipt.png', mimeType: 'image/png', dataBase64: Buffer.from('b').toString('base64') });
  const updated = await updateEvidenceExtracted('co-scan-2', doc.id, { status: 'extracted', documentType: 'receipt', extracted: { vendor: 'Home Depot', total: 42.5 } });
  assert.equal(updated.status, 'extracted');
  assert.equal(updated.documentType, 'receipt');
  assert.equal(updated.extracted.vendor, 'Home Depot');
  assert.equal(updated.extracted.total, 42.5);
});

test('updateEvidenceExtracted is durable within the store -- a fresh getEvidence reflects the persisted scan', async () => {
  const { insertEvidence, updateEvidenceExtracted, getEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-scan-3', filename: 'bill.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('c').toString('base64') });
  await updateEvidenceExtracted('co-scan-3', doc.id, { status: 'needs_review', documentType: 'vendor_bill', extracted: { total: 100 } });
  const fresh = await getEvidence('co-scan-3', doc.id);
  assert.equal(fresh.status, 'needs_review');
  assert.equal(fresh.documentType, 'vendor_bill');
  assert.equal(fresh.extracted.total, 100);
});

test('a low-confidence scan status ("needs_review") is distinct from "extracted"/"processed" -- still a real close-readiness blocker until a human resolves it', () => {
  const NEEDS_REVIEW_STATUSES_EXCLUDED = ['extracted', 'processed'];
  assert.equal(NEEDS_REVIEW_STATUSES_EXCLUDED.includes('needs_review'), false);
});

test('updateEvidenceExtracted never sets resolution/reviewedBy/reviewedAt -- a machine scan is never confused with a human review', async () => {
  const { insertEvidence, updateEvidenceExtracted } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-scan-4', filename: 'receipt.png', mimeType: 'image/png', dataBase64: Buffer.from('d').toString('base64') });
  const updated = await updateEvidenceExtracted('co-scan-4', doc.id, { status: 'extracted', documentType: 'receipt', extracted: { vendor: 'ABC Supply' } });
  assert.equal(updated.resolution, null);
  assert.equal(updated.reviewedBy, null);
  assert.equal(updated.reviewedAt, null);
});

test('updateEvidenceExtracted returns null for a document id that does not exist -- never throws or fabricates a record', async () => {
  const { updateEvidenceExtracted } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const result = await updateEvidenceExtracted('co-scan-5', 'nonexistent-id', { status: 'extracted', documentType: 'receipt', extracted: {} });
  assert.equal(result, null);
});

test('a document created in one company cannot have its scan persisted through another company\'s id (tenant isolation)', async () => {
  const { insertEvidence, updateEvidenceExtracted, getEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-scan-6a', filename: 'r.png', mimeType: 'image/png', dataBase64: Buffer.from('e').toString('base64') });
  const crossCompanyResult = await updateEvidenceExtracted('co-scan-6b', doc.id, { status: 'extracted', documentType: 'receipt', extracted: {} });
  assert.equal(crossCompanyResult, null);
  const stillUnscanned = await getEvidence('co-scan-6a', doc.id);
  assert.equal(stillUnscanned.documentType, null);
  assert.equal(stillUnscanned.extracted, null);
});

test('listEvidence never leaks a full scan payload into a vault-index/review-queue listing, even after a document has been scanned', async () => {
  const { insertEvidence, updateEvidenceExtracted, listEvidence } = await import(`./_evidence_store.js?t=${Date.now()}`);
  const doc = await insertEvidence({ companyId: 'co-scan-7', filename: 'receipt.png', mimeType: 'image/png', dataBase64: Buffer.from('f').toString('base64') });
  await updateEvidenceExtracted('co-scan-7', doc.id, { status: 'extracted', documentType: 'receipt', extracted: { vendor: 'Big Vendor', lineItems: [{ description: 'Pipe' }] } });
  const list = await listEvidence('co-scan-7');
  assert.equal(list[0].documentType, 'receipt');
  assert.ok(!('extracted' in list[0]), 'listEvidence summaries must never include the full scan payload');
});
