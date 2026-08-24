// test/subportal-file-storage.test.mjs
//
// api/subportal.js uploaded subcontractor compliance documents (COI, W9) to a
// bucket named `sub-documents` and sub invoices to `sub-invoices`. Neither has
// ever existed on the production project -- confirmed by the 2026-08-21 audit
// and re-confirmed against storage.buckets on 2026-08-22, which holds exactly
// six: media, monitor-screenshots, voice-greetings, docs, devtodo-attachments,
// marketing-attachments. A code comment claimed somebody would create them by
// hand in the dashboard. Nobody did, and nothing checked.
//
// The failure was louder than the onboarding-licence one: uploadDataUrl() threw
// on a non-ok response, the outer catch turned it into a 502, and the raw
// Supabase error -- bucket name included -- was returned to a SUBCONTRACTOR,
// who is outside the company.
//
// Both now go into the shared private `docs` bucket under `subs/` prefixes with
// a public.documents row, via api/_lib/hivedoc-files.js. `sub_documents` and
// `sub_invoices` both held 0 rows on production, so no stored path needed
// converting.
//
// Fully mocked. Run: node --experimental-test-module-mocks --test test/subportal-file-storage.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const handler = (await import('../api/subportal.js')).default;

const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 hello').toString('base64');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function run(query, body, { storageOk = true, documentsOk = true, domainOk = true } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opts.body });
    if (u.includes('/rest/v1/sub_sessions')) return jsonRes([{ id: 'sess-1', sub_id: 'sub-1' }]);
    if (u.includes('/rest/v1/subs?')) return jsonRes([{ id: 'sub-1', company_name: 'Joe the Plumber' }]);
    if (u.includes('/rest/v1/sub_audit_log')) return jsonRes({});
    if (u.includes('/rest/v1/documents') && method === 'POST') {
      return documentsOk ? jsonRes([{ id: 'doc-9' }]) : jsonRes({ message: 'schema cache' }, 400);
    }
    if (u.includes('/rest/v1/documents') && method === 'DELETE') return jsonRes({});
    if (u.includes('/rest/v1/sub_documents') || u.includes('/rest/v1/sub_invoices')) {
      return domainOk ? jsonRes([{ id: 'row-1' }]) : jsonRes({ message: 'violates check constraint' }, 400);
    }
    if (u.includes('/storage/v1/object/') && method === 'POST') {
      return storageOk ? jsonRes({ Key: 'ok' }) : jsonRes({ error: 'Bucket not found', statusCode: '404' }, 400);
    }
    if (u.includes('/storage/v1/object/') && method === 'DELETE') return jsonRes({});
    return jsonRes({ error: 'unexpected ' + method + ' ' + u }, 500);
  };
  const req = { method: 'POST', query, headers: { authorization: 'Bearer subtoken' }, body };
  const out = res();
  try { await handler(req, out); } finally { global.fetch = original; }

  const find = (pred) => calls.find(pred) || null;
  return {
    out, calls,
    upload: find((c) => c.url.includes('/storage/v1/object/') && c.method === 'POST'),
    objDelete: find((c) => c.url.includes('/storage/v1/object/') && c.method === 'DELETE'),
    docInsert: find((c) => c.url.includes('/rest/v1/documents') && c.method === 'POST'),
    docDelete: find((c) => c.url.includes('/rest/v1/documents') && c.method === 'DELETE'),
    subDoc: find((c) => c.url.includes('/rest/v1/sub_documents') && c.method === 'POST'),
    subInv: find((c) => c.url.includes('/rest/v1/sub_invoices') && c.method === 'POST'),
  };
}

const uploadDoc = (body = {}, opts) => run({ action: 'documents' }, { doc_type: 'w9', file_data_url: PDF, ...body }, opts);
const uploadInvoice = (body = {}, opts) => run({ action: 'invoice_submit' }, { file_data_url: PDF, amount: 1200, ...body }, opts);

// ---------- compliance documents ----------

test('a compliance document lands in the docs bucket, under a subs prefix', async () => {
  const { upload, out } = await uploadDoc();
  assert.equal(out.statusCode, 200);
  assert.match(upload.url, /\/storage\/v1\/object\/docs\/subs\/documents\/sub-1\/w9-\d+\.pdf$/);
});

test('it is described by a documents row marked sensitive', async () => {
  const { docInsert } = await uploadDoc();
  assert.ok(docInsert, 'the object was described');
  const row = JSON.parse(docInsert.body)[0];
  assert.equal(row.sensitive, true, 'a W9 carries a taxpayer ID and doc_type is unvalidated free text');
  assert.equal(row.doc_type, 'other');
  assert.equal(row.mime_type, 'application/pdf');
  assert.match(row.filename, /^w9\.pdf$/);
});

test('sub_documents.file_url holds the bare storage path, which is the join', async () => {
  const { subDoc, docInsert, upload } = await uploadDoc();
  const stored = JSON.parse(subDoc.body).file_url;
  assert.equal(stored, JSON.parse(docInsert.body)[0].storage_path, 'same value the bucket read policy matches on');
  assert.ok(upload.url.endsWith('/' + stored));
  assert.doesNotMatch(stored, /^(docs|sub-documents)\//, 'no bucket prefix -- it is a path, like documents.storage_path');
});

// ---------- invoices ----------

test('an invoice lands under its own prefix and is not marked sensitive', async () => {
  const { upload, docInsert, out } = await uploadInvoice();
  assert.equal(out.statusCode, 200);
  assert.match(upload.url, /\/storage\/v1\/object\/docs\/subs\/invoices\/sub-1\/invoice-\d+\.pdf$/);
  const row = JSON.parse(docInsert.body)[0];
  assert.equal(row.doc_type, 'invoice');
  assert.equal(row.sensitive, false, 'AP paperwork the office has to process; sensitive would hide it from non-admins');
});

test('the invoice row still records amount provenance', async () => {
  const withAmount = await uploadInvoice({ amount: 1200 });
  assert.equal(JSON.parse(withAmount.subInv.body).amount_source, 'manual');
  const without = await uploadInvoice({ amount: undefined });
  assert.equal(JSON.parse(without.subInv.body).amount_source, 'pending_ocr');
});

// ---------- input that reaches us from a browser ----------

test('doc_type cannot climb out of its prefix', async () => {
  // doc_type is free text the portal has never validated, and it goes straight
  // into a storage path.
  const { upload } = await uploadDoc({ doc_type: '../../media/evil' });
  assert.match(upload.url, /\/object\/docs\/subs\/documents\/sub-1\//, 'still inside the prefix');
  assert.doesNotMatch(upload.url, /\.\./);
});

test('an executable file type is refused before anything is uploaded', async () => {
  const html = 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  const { out, upload } = await uploadDoc({ file_data_url: html });
  assert.equal(upload, null, 'nothing reached storage');
  assert.equal(out.statusCode, 502);
  assert.match(out.body.error, /not accepted/i);
});

test('an oversized file is refused before anything is uploaded', async () => {
  const big = 'data:application/pdf;base64,' + Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64');
  const { out, upload } = await uploadDoc({ file_data_url: big });
  assert.equal(upload, null);
  assert.match(out.body.error, /too large/i);
});

// ---------- failure leaves nothing behind ----------

test('a storage failure never shows the sub our bucket names', async () => {
  // This is the whole original bug: an outside party got the raw Supabase
  // error, bucket name and status code included.
  const { out } = await uploadDoc({}, { storageOk: false });
  assert.equal(out.statusCode, 502);
  assert.doesNotMatch(out.body.error, /bucket|docs\/|supabase|storage/i, out.body.error);
  assert.doesNotMatch(out.body.error, /\b[45]\d\d\b/, out.body.error);
});

test('an object we could not describe is removed', async () => {
  const { upload, objDelete, subDoc } = await uploadDoc({}, { documentsOk: false });
  assert.ok(objDelete, 'the undescribed object was deleted');
  assert.equal(objDelete.url, upload.url);
  assert.equal(subDoc, null, 'and no workflow row was written');
});

test('a file whose workflow row fails is taken back out of the bucket entirely', async () => {
  // A documents row plus an object, with no sub_documents row, is the same
  // orphan by another route: nothing in the sub compliance list points at it.
  const { upload, objDelete, docDelete, out } = await uploadDoc({}, { domainOk: false });
  assert.ok(docDelete, 'the documents row was removed');
  assert.match(docDelete.url, /documents\?id=eq\.doc-9/);
  assert.ok(objDelete, 'the object was removed');
  assert.equal(objDelete.url, upload.url);
  assert.equal(out.statusCode, 502);
  assert.doesNotMatch(out.body.error, /constraint|supabase/i);
});

test('the same cleanup covers invoices', async () => {
  const { objDelete, docDelete } = await uploadInvoice({}, { domainOk: false });
  assert.ok(docDelete);
  assert.ok(objDelete);
});

// ---------- unchanged behaviour ----------

test('a request with no session is still refused before any upload', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => { calls.push(String(url)); return jsonRes([]); };
  const out = res();
  try {
    await handler({ method: 'POST', query: { action: 'documents' }, headers: {}, body: { doc_type: 'w9', file_data_url: PDF } }, out);
  } finally { global.fetch = original; }
  assert.equal(out.statusCode, 401);
  assert.ok(!calls.some((u) => u.includes('/storage/')), 'nothing was uploaded for an unauthenticated caller');
});

test('the required fields are still required', async () => {
  const noFile = await run({ action: 'documents' }, { doc_type: 'w9' });
  assert.equal(noFile.out.statusCode, 400);
  const noType = await run({ action: 'documents' }, { file_data_url: PDF });
  assert.equal(noType.out.statusCode, 400);
  const noInvoiceFile = await run({ action: 'invoice_submit' }, { amount: 10 });
  assert.equal(noInvoiceFile.out.statusCode, 400);
});
