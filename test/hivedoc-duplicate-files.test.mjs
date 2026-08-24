import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// One file, one row.
//
// A sub upload writes twice. storeFiledDocument() puts a public.documents row
// next to the bytes -- which is what makes the object readable at all, since the
// `docs` read policy grants an object only when a documents row points at the
// same storage_path -- and the sub portal writes its own sub_documents /
// sub_invoices row whose file_url is that same path. Both stores are in the read
// model, so before this an admin searching saw one COI as two results.
//
// The sub row is the one that stops being listed. It is NOT the one thrown away:
// the documents row insertDocumentRow() writes for a sub upload holds only
// filename, path, mime, size, doc_type and sensitive. Suppressing the sub row
// outright would leave a bare `invoice.pdf` and make the acceptance question --
// "latest invoice from Joe the plumber on the John Smith job" -- match nothing.
// That case is the last test in the first block, and it fails against a naive
// suppression.

import {
  mergeDuplicateFileRows, normalizeDocumentRow, normalizeSubDocumentRow,
  normalizeSubInvoiceRow, normalizeMediaRow, parseFilters, rowMatches, applySearch,
} from '../api/_lib/hivedoc-search.js';

const INVOICE_PATH = 'subs/invoices/S1/invoice-1700000000000.pdf';
const COI_PATH = 'subs/documents/S1/coi-1700000000000.pdf';

const SUBS = { S1: { company_name: 'Joe the Plumber' } };
const JOBS = { JOB1: { client_id: 'C1', client_name: 'John Smith', job_title: 'Bathroom Remodel' } };

// Exactly what storeFiledDocument() writes for a sub upload: baseline columns
// only. No vendor, no client, no job, no amount.
const filedDoc = (over = {}) => normalizeDocumentRow({
  id: 'doc-1', filename: 'invoice.pdf', storage_path: INVOICE_PATH,
  mime_type: 'application/pdf', size_bytes: 1024, doc_type: 'invoice',
  sensitive: false, uploaded_at: '2026-08-22T10:00:00Z', ...over,
});

const subInvoice = (over = {}) => normalizeSubInvoiceRow({
  id: 'si-1', sub_id: 'S1', job_ref: 'JOB1', file_url: INVOICE_PATH,
  amount: 1250.5, amount_source: 'manual', status: 'submitted',
  submitted_at: '2026-08-22T10:00:00Z', ...over,
}, SUBS, JOBS);

const subDoc = (over = {}) => normalizeSubDocumentRow({
  id: 'sd-1', sub_id: 'S1', doc_type: 'coi', file_url: COI_PATH,
  status: 'current', expires_at: '2027-01-01', uploaded_at: '2026-08-22T09:00:00Z', ...over,
}, SUBS);

// ---------- the merge ----------

test('a sub file that has a documents twin is listed once', () => {
  const merged = mergeDuplicateFileRows([filedDoc(), subInvoice()]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source_system, 'documents', 'the documents row is the survivor');
  assert.equal(merged[0].id, 'doc-1');
  assert.equal(merged[0].also_in.join(), 'sub_invoices', 'the row says it answers for both stores');
  assert.equal(merged[0].sub_row_id, 'si-1');
});

test('the surviving row keeps what only the sub row knew', () => {
  const [row] = mergeDuplicateFileRows([filedDoc(), subInvoice()]);
  assert.equal(row.vendor_name, 'Joe the Plumber');
  assert.equal(row.client_id, 'C1');
  assert.equal(row.client_name, 'John Smith');
  assert.equal(row.job_id, 'JOB1');
  assert.equal(row.job_title, 'Bathroom Remodel');
  assert.equal(row.amount, 1250.5);
  assert.equal(row.status, 'submitted');
  assert.equal(row.sub_id, 'S1');
});

test('the surviving row keeps what only the documents row knew', () => {
  const [row] = mergeDuplicateFileRows([
    filedDoc({ client_visible: true, client_id: 'C1' }),
    subInvoice(),
  ]);
  // Identity and reachability stay with the documents row: its id is what
  // ?resource=file&system=documents resolves, and its storage_path is what the
  // bucket read policy matches on.
  assert.equal(row.open_url, '/api/hivedoc?resource=file&system=documents&id=doc-1');
  assert.equal(row.storage_bucket, 'docs');
  assert.equal(row.storage_path, INVOICE_PATH);
  assert.equal(row.mime_type, 'application/pdf');
  assert.equal(row.size_bytes, 1024);
  // The sharing flags only exist on documents, and are what the portals read.
  assert.equal(row.client_visible, true);
  assert.equal(row.sub_visible, false);
});

test('a bare filename gives way to a title a person would recognise', () => {
  const [row] = mergeDuplicateFileRows([filedDoc(), subInvoice()]);
  assert.notEqual(row.title, 'invoice.pdf');
  assert.match(row.title, /Joe the Plumber/);
  // A real title already on the documents row is not overwritten.
  const [kept] = mergeDuplicateFileRows([filedDoc({ title: 'March retainer' }), subInvoice()]);
  assert.equal(kept.title, 'March retainer');
});

test('closed wins on sensitive, from whichever half says so', () => {
  const coiDoc = () => filedDoc({ id: 'doc-2', filename: 'coi.pdf', storage_path: COI_PATH, doc_type: 'other' });
  // The write path stamps sub paperwork sensitive on the documents row.
  let [row] = mergeDuplicateFileRows([coiDoc({ sensitive: true }), subDoc()]);
  assert.equal(row.sensitive, true);
  // And if only the projection thinks so, that still wins.
  [row] = mergeDuplicateFileRows([coiDoc({ sensitive: false }), subDoc()]);
  assert.equal(row.sensitive, true, 'subDocumentIsSensitive() returns true for every sub document');
});

test('THE REGRESSION GUARD: the acceptance question still matches after merging', () => {
  // Plain suppression of the sub row leaves `invoice.pdf` with a null vendor,
  // null client and null job, and this returns 0. It is the whole reason the
  // merge carries the sub row's fields rather than dropping them.
  const rows = mergeDuplicateFileRows([filedDoc(), subInvoice()]);
  const filters = parseFilters({ category: 'Invoice', vendor: 'joe the plumber', client: 'john smith' });
  assert.equal(rowMatches(rows[0], filters), true);

  const { total, results } = applySearch(rows, filters);
  assert.equal(total, 1, 'one file, one hit -- not two, and not zero');
  assert.equal(results[0].amount, 1250.5);
});

// ---------- what must NOT be merged ----------

test('a sub row with no documents twin is left exactly as it is', () => {
  // Not hypothetical: every sub row written before 2026-08-22 has no twin,
  // because the upload that would have created one always failed.
  const orphan = subInvoice({ id: 'si-old', file_url: 'sub-invoices/S1/invoice-legacy' });
  const merged = mergeDuplicateFileRows([filedDoc(), orphan]);
  assert.equal(merged.length, 2);
  const kept = merged.find((r) => r.id === 'si-old');
  assert.equal(kept.source_system, 'sub_invoices');
  assert.equal(kept.vendor_name, 'Joe the Plumber');
});

test('rows with no storage path are never merged into each other', () => {
  const a = filedDoc({ id: 'doc-a', storage_path: null });
  const b = subInvoice({ id: 'si-a', file_url: null });
  const merged = mergeDuplicateFileRows([a, b]);
  assert.equal(merged.length, 2, 'two nulls are not the same file');
});

test('a media row that happens to share a path is not merged across buckets', () => {
  // media lives in its own bucket, so an identical path is a different object.
  const photo = normalizeMediaRow({ id: 'm1', job_id: 'JOB1', storage_path: INVOICE_PATH, captured_at: '2026-08-22T10:00:00Z' }, JOBS);
  const merged = mergeDuplicateFileRows([filedDoc(), photo, subInvoice()]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((r) => r.source_system === 'media'), 'the photo survives on its own');
});

test('documents rows that are not sub uploads are untouched', () => {
  const plain = normalizeDocumentRow({ id: 'd9', filename: 'permit.pdf', storage_path: 'x/permit.pdf', doc_type: 'permit', uploaded_at: '2026-07-01T00:00:00Z' });
  const merged = mergeDuplicateFileRows([plain]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].also_in, undefined, 'no marker on a row that answers for one store');
  assert.deepEqual(merged[0], plain);
});

test('the result order does not depend on which store answered first', () => {
  const forward = mergeDuplicateFileRows([filedDoc(), subInvoice()]).map((r) => r.id);
  const reverse = mergeDuplicateFileRows([subInvoice(), filedDoc()]).map((r) => r.id);
  assert.deepEqual(forward, ['doc-1']);
  assert.deepEqual(reverse, ['doc-1'], 'the file keeps the documents row position either way');
});

test('two sub rows against one documents row do not multiply it', () => {
  // Defensive: nothing should write two sub rows for one object, but a merge
  // that produced two copies of the file would be worse than the duplicate.
  const merged = mergeDuplicateFileRows([filedDoc(), subInvoice(), subInvoice({ id: 'si-2', amount: 99 })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].amount, 1250.5, 'first sub row wins, deterministically');
});

// ---------- through the endpoint ----------

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';

const TABLES = {
  documents: [{
    id: 'doc-1', filename: 'invoice.pdf', storage_path: INVOICE_PATH, mime_type: 'application/pdf',
    size_bytes: 1024, doc_type: 'invoice', sensitive: false, uploaded_at: '2026-08-22T10:00:00Z',
  }],
  media: [],
  sub_documents: [],
  sub_invoices: [{
    id: 'si-1', sub_id: 'S1', job_ref: 'JOB1', file_url: INVOICE_PATH, amount: 1250.5,
    status: 'submitted', submitted_at: '2026-08-22T10:00:00Z',
  }],
  subs: [{ id: 'S1', company_name: 'Joe the Plumber' }],
  jobs: [{ jobber_id: 'JOB1', title: 'Bathroom Remodel', client_id: 'C1', client_uuid: null }],
  clients: [{ jobber_id: 'C1', name: 'John Smith' }],
};

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      const table = path.split('?')[0];
      if (table === 'profiles') return new Response(JSON.stringify([{ role: 'admin' }]), { status: 200 });
      return new Response(JSON.stringify(TABLES[table] || []), { status: 200 });
    },
  },
});
mock.module('../api/_lib/auth.js', { namedExports: { requireUser: async () => ({ id: 'u1' }) } });
globalThis.fetch = async () => new Response(JSON.stringify({ signedURL: '/object/sign/docs/x?token=t' }), { status: 200 });

const { default: handler } = await import('../api/hivedoc.js');

async function get(query) {
  const res = {
    statusCode: null, body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler({ method: 'GET', query, headers: {} }, res);
  return res;
}

test('search returns one row for the one file', async () => {
  const res = await get({ resource: 'search' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.total, 1, 'was 2 before the merge');
  assert.equal(res.body.results[0].vendor_name, 'Joe the Plumber');
});

test('the browse tree counts the file once', async () => {
  const res = await get({ resource: 'tree' });
  assert.equal(res.statusCode, 200);
  const totals = res.body.clients.reduce((n, c) => n + c.count, 0);
  assert.equal(totals, 1);
  // And it files under the client the sub row supplied, not under Unassigned.
  assert.equal(res.body.clients[0].client_name, 'John Smith');
});

test('the natural-language front door finds the merged row', async () => {
  const res = await get({ resource: 'ask', q: 'latest invoice from Joe the Plumber' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.total, 1);
  assert.equal(res.body.results[0].id, 'doc-1');
});
