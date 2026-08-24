import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// HiveDoc now reads the two subcontractor stores as well as `documents` and
// `media`. Three separate things are held here:
//
//   1. The projections: a sub's paperwork and a sub's invoice, in the one row
//      shape everything else uses.
//   2. That they never leave the company. canSee() allowlists `documents` as
//      the only shareable store; these are internal, and a sub already sees
//      their OWN files through the sub portal's session-scoped actions.
//   3. That the endpoint works at all. `resolveStaffViewer()` was written and
//      never called, so `viewer` was undefined at every use and search, tree and
//      facets each returned 502 "viewer is not defined". Nothing caught it
//      because -- per REPORT.md -- no authenticated call to /api/hivedoc had
//      ever been made.
//
// And one thing the sub stores forced into the open: ?resource=file used to sign
// any row for any authenticated caller, so a crew member with a document id
// could open a `sensitive` contract the search list had correctly hidden.

import {
  normalizeSubDocumentRow, normalizeSubInvoiceRow, subDocumentIsSensitive,
  subDocumentsCouldMatch, subInvoicesCouldMatch,
  parseFilters, rowMatches, applySearch, canSee, filterVisible, redactForAudience,
} from '../api/_lib/hivedoc-search.js';

const SUBS = { S1: { company_name: 'Joe the Plumber' } };
const JOBS = { JOB1: { client_id: 'C1', client_name: 'John Smith', job_title: 'Bathroom Remodel' } };

const subDoc = (over = {}) => normalizeSubDocumentRow({
  id: 'sd1', sub_id: 'S1', doc_type: 'coi', file_url: 'subs/s1/documents/coi-1.pdf',
  status: 'current', expires_at: '2027-01-01', uploaded_at: '2026-07-14T09:00:00Z', ...over,
}, SUBS);

const subInvoice = (over = {}) => normalizeSubInvoiceRow({
  id: 'si1', sub_id: 'S1', job_ref: 'JOB1', file_url: 'subs/s1/invoices/invoice-1.pdf',
  amount: 1250.5, amount_source: 'manual', status: 'submitted',
  submitted_at: '2026-07-20T12:00:00Z', ...over,
}, SUBS, JOBS);

const staff = (role) => ({ audience: 'staff', role });
const client = (clientId) => ({ audience: 'client', clientId });
const sub = (...jobIds) => ({ audience: 'subcontractor', jobIds });

// ---------- projection ----------

test('a sub document projects into the shared row shape', () => {
  const row = subDoc();
  assert.equal(row.source_system, 'sub_documents');
  assert.equal(row.source, 'Sub Portal');
  assert.equal(row.vendor_name, 'Joe the Plumber');
  assert.equal(row.storage_bucket, 'docs', 'the bucket the fixed uploader writes to');
  assert.equal(row.storage_path, 'subs/s1/documents/coi-1.pdf');
  assert.equal(row.open_url, '/api/hivedoc?resource=file&system=sub_documents&id=sd1');
  // Not one of the spec's categories: a COI is not a Contract, a Permit or an
  // Invoice. Other keeps `category` inside the vocabulary the filters share.
  assert.equal(row.category, 'Other');
  // A W9 belongs to a vendor, not to a job. Saying so beats inventing a link.
  assert.equal(row.client_id, null);
  assert.equal(row.job_id, null);
});

test('a sub invoice reaches its client through the same job join media uses', () => {
  const row = subInvoice();
  assert.equal(row.source_system, 'sub_invoices');
  assert.equal(row.category, 'Invoice');
  assert.equal(row.vendor_name, 'Joe the Plumber');
  assert.equal(row.job_id, 'JOB1');
  assert.equal(row.job_title, 'Bathroom Remodel');
  assert.equal(row.client_id, 'C1');
  assert.equal(row.client_name, 'John Smith');
  assert.equal(row.amount, 1250.5);
  assert.equal(row.document_date, '2026-07-20T12:00:00Z');
});

test('a sub whose company name we cannot resolve gets a null vendor, not a guess', () => {
  const row = normalizeSubInvoiceRow({ id: 'x', sub_id: 'UNKNOWN', job_ref: 'JOB1' }, SUBS, JOBS);
  assert.equal(row.vendor_name, null);
});

test('a legacy bucket-qualified file_url is projected as a signable path', () => {
  const row = subDoc({ file_url: 'sub-documents/S1/coi-1' });
  assert.equal(row.storage_path, 'S1/coi-1');
});

test('only a LEADING bucket name is stripped, never one inside the path', () => {
  // The prefix strip is anchored on purpose. A folder that happens to be called
  // `docs` is part of the object's path, and cutting it out silently produces a
  // path that points at nothing -- the same class of unsignable row the sub
  // stores are being fixed for. Unanchored, this row loses its `subs/` prefix
  // and gains a `docs/` one, and the file 404s at signing time.
  assert.equal(subDoc({ file_url: 'subs/docs/S1/coi-1' }).storage_path, 'subs/docs/S1/coi-1');
  assert.equal(subDoc({ file_url: 'S1/sub-invoices/x' }).storage_path, 'S1/sub-invoices/x');
  // And a bare path is already what we want, so it must survive untouched.
  assert.equal(subDoc({ file_url: 'subs/S1/coi-1' }).storage_path, 'subs/S1/coi-1');
});

// ---------- sensitivity ----------

test('every sub document is sensitive, whatever doc_type says', () => {
  // `doc_type` is free text the portal has never validated, so a row reading
  // "coi" is not evidence the file is a COI. The exemption list this used to
  // carry made the read path disagree with the write path -- see the next test.
  for (const t of ['coi', 'COI', 'license', 'certificate of insurance',
                   'w9', 'other', 'bank letter', '', undefined, null]) {
    assert.equal(subDocumentIsSensitive(t), true, `doc_type ${JSON.stringify(t)}`);
  }
});

test('the read path agrees with the write path about sub paperwork', () => {
  // api/subportal.js stamps SUB_DOC_SENSITIVE = true on the public.documents row
  // for every sub document, and SUB_INVOICE_SENSITIVE = false for invoices. The
  // projection here has to reach the same answer, or the same object is refused
  // through ?system=documents and served through ?system=sub_documents.
  const source = fs.readFileSync(new URL('../api/subportal.js', import.meta.url), 'utf8');
  const docWrite = /const SUB_DOC_SENSITIVE\s*=\s*(true|false)/.exec(source);
  const invWrite = /const SUB_INVOICE_SENSITIVE\s*=\s*(true|false)/.exec(source);
  assert.ok(docWrite && invWrite, 'could not read the write-path constants');

  assert.equal(subDoc({ doc_type: 'coi' }).sensitive, docWrite[1] === 'true');
  assert.equal(subDoc({ doc_type: 'w9' }).sensitive, docWrite[1] === 'true');
  assert.equal(subInvoice().sensitive, invWrite[1] === 'true');
});

test('crew cannot open a sub document by asking for it the other way', () => {
  // The leak this closes: the documents row said sensitive, the sub_documents
  // projection said otherwise, and crew got the bytes by naming the store that
  // agreed with them.
  for (const t of ['w9', 'coi', 'license', 'other']) {
    assert.equal(canSee(subDoc({ doc_type: t }), staff('crew')), false, `doc_type ${t}`);
    assert.equal(canSee(subDoc({ doc_type: t }), staff('admin')), true, `doc_type ${t}`);
  }
  assert.equal(canSee(subDoc({ doc_type: 'w9' }), staff('superadmin')), true);
});

test('an accounts-payable invoice is ordinary staff business', () => {
  assert.equal(subInvoice().sensitive, false);
  assert.equal(canSee(subInvoice(), staff('crew')), true);
});

// ---------- nothing leaves the company ----------

test('no sub store row reaches a client or a subcontractor audience', () => {
  const rows = [subDoc(), subDoc({ doc_type: 'w9' }), subInvoice()];
  for (const viewer of [client('C1'), sub('JOB1'), { audience: 'nonsense' }, {}, null]) {
    assert.deepEqual(filterVisible(rows, viewer), [], JSON.stringify(viewer));
  }
});

test('a sub document is projected as visible to nobody outside the company', () => {
  // The flags themselves, pinned separately from canSee(). A sub_documents row
  // has no client_id and no job_id, so the scoping checks in canSee() refuse it
  // even when the flags are wrong -- which means flipping these to true breaks
  // no other test in this file. The projection is the first of the two layers
  // and it needs its own assertion, or it is only ever tested by accident.
  for (const row of [subDoc(), subDoc({ doc_type: 'w9' })]) {
    assert.equal(row.client_visible, false, `${row.doc_type}: never visible to a client`);
    assert.equal(row.sub_visible, false, `${row.doc_type}: not even to the sub who sent it`);
  }
});

test('a sub cannot reach another sub invoice by being on the same job', () => {
  // sub_visible is false on every projected row and canSee() allowlists
  // `documents` anyway, so both layers refuse independently.
  const inv = subInvoice();
  assert.equal(inv.sub_visible, false);
  assert.equal(canSee(inv, sub('JOB1')), false);
  // Even if a flag were somehow flipped on the row, the store check still holds.
  assert.equal(canSee({ ...inv, sub_visible: true }, sub('JOB1')), false);
  assert.equal(canSee({ ...subDoc(), client_visible: true, client_id: 'C1' }, client('C1')), false);
});

test('staff see the row unredacted; nobody else gets one to redact', () => {
  const row = subInvoice();
  assert.equal(redactForAudience(row, staff('admin')), row);
  assert.equal(redactForAudience(row, client('C1')).storage_path, undefined);
});

// ---------- store gating ----------

test('a store that cannot answer the query is not read', () => {
  const f = (q) => parseFilters(q);
  // sub_documents has no client, no job, and files as Other.
  assert.equal(subDocumentsCouldMatch(f({ category: 'Permit' })), false);
  assert.equal(subDocumentsCouldMatch(f({ client: 'John Smith' })), false);
  assert.equal(subDocumentsCouldMatch(f({ job_id: 'JOB1' })), false);
  assert.equal(subDocumentsCouldMatch(f({ source: 'CompanyCam' })), false);
  assert.equal(subDocumentsCouldMatch(f({ category: 'Other' })), true);
  assert.equal(subDocumentsCouldMatch(f({})), true);

  // sub_invoices only ever holds invoices.
  assert.equal(subInvoicesCouldMatch(f({ category: 'Photo' })), false);
  assert.equal(subInvoicesCouldMatch(f({ category: 'Invoice' })), true);
  assert.equal(subInvoicesCouldMatch(f({ client: 'John Smith' })), true);
  assert.equal(subInvoicesCouldMatch(f({ source: 'Sub Portal' })), true);

  // A category we do not have rules out both, rather than returning everything.
  assert.equal(subDocumentsCouldMatch(f({ category: 'blueprints' })), false);
  assert.equal(subInvoicesCouldMatch(f({ category: 'blueprints' })), false);
});

// ---------- the acceptance question ----------

test('"latest invoice from Joe the plumber on the John Smith job" now has an answer', () => {
  // This is one of the four questions in Chris's spec, and until the sub stores
  // joined the read model nothing could answer it: a sub's invoice was in
  // neither `documents` nor `media`.
  const rows = [
    subInvoice({ id: 'old', amount: 400, submitted_at: '2026-05-02T10:00:00Z' }),
    subInvoice({ id: 'newest', amount: 1250.5, submitted_at: '2026-07-20T12:00:00Z' }),
    subInvoice({ id: 'other-vendor', sub_id: 'S2', submitted_at: '2026-08-01T10:00:00Z' }),
    subDoc(),
  ];
  const filters = parseFilters({ category: 'Invoice', vendor: 'joe the plumber', client: 'john smith' });
  const { total, results } = applySearch(filterVisible(rows, staff('admin')), filters);
  assert.equal(total, 2, 'the two invoices from this vendor on this client');
  assert.equal(results[0].id, 'newest', 'newest first, which is what "latest" means');
  assert.equal(results[0].amount, 1250.5);
});

test('a plain-text search finds a sub invoice by its vendor', () => {
  assert.equal(rowMatches(subInvoice(), parseFilters({ q: 'joe plumber' })), true);
  assert.equal(rowMatches(subInvoice(), parseFilters({ q: 'nobody' })), false);
});

// ---------- the endpoint ----------

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';

const TABLES = {
  documents: [{
    id: 'd1', filename: 'contract.pdf', storage_path: 'x/contract.pdf', doc_type: 'contract',
    sensitive: true, client_id: 'C1', job_id: 'JOB1', uploaded_at: '2026-06-01T00:00:00Z',
  }],
  media: [],
  sub_documents: [{
    id: 'sd1', sub_id: 'S1', doc_type: 'w9', file_url: 'subs/s1/documents/w9-1.pdf',
    status: 'current', uploaded_at: '2026-07-14T09:00:00Z',
  }],
  sub_invoices: [{
    id: 'si1', sub_id: 'S1', job_ref: 'JOB1', file_url: 'subs/s1/invoices/invoice-1.pdf',
    amount: 1250.5, status: 'submitted', submitted_at: '2026-07-20T12:00:00Z',
  }],
  subs: [{ id: 'S1', company_name: 'Joe the Plumber' }],
  jobs: [{ jobber_id: 'JOB1', title: 'Bathroom Remodel', client_id: 'C1', client_uuid: null }],
  clients: [{ jobber_id: 'C1', name: 'John Smith' }],
};

let profileRole = 'admin';
let profileLookupFails = false;
const reads = [];
mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      reads.push(path);
      const table = path.split('?')[0];
      if (table === 'profiles') {
        if (profileLookupFails) return new Response('permission denied', { status: 403 });
        return new Response(JSON.stringify([{ role: profileRole }]), { status: 200 });
      }
      return new Response(JSON.stringify(TABLES[table] || []), { status: 200 });
    },
  },
});
mock.module('../api/_lib/auth.js', { namedExports: { requireUser: async () => ({ id: 'u1' }) } });

globalThis.fetch = async () => new Response(JSON.stringify({ signedURL: '/object/sign/docs/x?token=t' }), { status: 200 });

const { default: handler } = await import('../api/hivedoc.js');

function makeRes() {
  return {
    statusCode: null, body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function get(query) {
  reads.length = 0;
  const res = makeRes();
  await handler({ method: 'GET', query, headers: {} }, res);
  return res;
}

test('search returns results instead of 502 "viewer is not defined"', async () => {
  profileRole = 'admin';
  const res = await get({ resource: 'search' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  const ids = res.body.results.map((r) => r.id).sort();
  assert.deepEqual(ids, ['d1', 'sd1', 'si1'], 'all four stores are read into one list');
});

test('tree and facets are wired to the same viewer', async () => {
  profileRole = 'admin';
  assert.equal((await get({ resource: 'tree' })).statusCode, 200);
  assert.equal((await get({ resource: 'facets' })).statusCode, 200);
});

test('a profile lookup that fails degrades to the least privileged staff role', async () => {
  // resolveStaffViewer() swallows the lookup error on purpose: a viewer we
  // cannot identify must not be treated as an admin. A 403 from `profiles` is
  // the realistic shape of that -- and it must not become a 502 either, because
  // an unreadable profile is still a signed-in member of staff.
  profileLookupFails = true;
  const res = await get({ resource: 'search' });
  profileLookupFails = false;
  assert.equal(res.statusCode, 200);
  const ids = res.body.results.map((r) => r.id).sort();
  assert.ok(!ids.includes('d1'), 'the sensitive contract stays hidden');
  assert.ok(!ids.includes('sd1'), 'so does the W9');
  assert.deepEqual(ids, ['si1']);
});

test('crew searching does not see the sensitive contract or the W9', async () => {
  profileRole = 'crew';
  const res = await get({ resource: 'search' });
  assert.deepEqual(res.body.results.map((r) => r.id), ['si1']);
});

test('the natural-language front door reaches the sub invoice too', async () => {
  // ?resource=ask (#506) turns English into the same filters and runs the same
  // path. It read the same undeclared `viewer`, so it 502'd like the rest; and
  // it is the front door the acceptance question is actually asked through.
  profileRole = 'admin';
  const res = await get({ resource: 'ask', q: 'latest invoice from Joe the Plumber' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.resource, 'ask');
  assert.ok(res.body.interpreted, 'the reading is returned so a wrong one is visible');
  assert.deepEqual(res.body.results.map((r) => r.id), ['si1']);
});

test('a store that cannot match is not queried at all', async () => {
  profileRole = 'admin';
  await get({ resource: 'search', category: 'Permit' });
  const tables = reads.map((p) => p.split('?')[0]);
  assert.ok(!tables.includes('sub_documents'), 'sub_documents cannot hold a Permit');
  assert.ok(!tables.includes('sub_invoices'), 'nor can sub_invoices');
  assert.ok(!tables.includes('media'), 'nor can media');
});

test('?resource=file signs a sub invoice for staff', async () => {
  profileRole = 'admin';
  const res = await get({ resource: 'file', system: 'sub_invoices', id: 'si1' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.url, /storage\/v1\/object\/sign\/docs\//);
});

test('?resource=file refuses a file the caller may not see, and says nothing about it', async () => {
  // Before this, the signer took an id and signed it for any authenticated
  // caller -- so crew could open a `sensitive` contract that search correctly
  // hid from them. The refusal is the same 404 an unknown id gets, or the error
  // itself confirms which ids exist.
  profileRole = 'crew';
  const denied = await get({ resource: 'file', system: 'documents', id: 'd1' });
  const missing = await get({ resource: 'file', system: 'documents', id: 'nope' });
  assert.equal(denied.statusCode, 404);
  assert.deepEqual(denied.body, missing.body);

  const w9 = await get({ resource: 'file', system: 'sub_documents', id: 'sd1' });
  assert.equal(w9.statusCode, 404);

  profileRole = 'admin';
  assert.equal((await get({ resource: 'file', system: 'documents', id: 'd1' })).statusCode, 200);
  assert.equal((await get({ resource: 'file', system: 'sub_documents', id: 'sd1' })).statusCode, 200);
});

test('an unknown system falls back to documents rather than reading a table named in the query', async () => {
  // `system` used to pick between two hard-coded names. It now indexes a map,
  // so the guard that matters is that an unrecognised value cannot make this
  // read whatever table the caller asked for.
  profileRole = 'admin';
  for (const system of ['profiles', 'sub_banking', '__proto__', 'constructor']) {
    const res = await get({ resource: 'file', system, id: 'd1' });
    const tables = reads.map((p) => p.split('?')[0]).filter((t) => t !== 'profiles');
    assert.deepEqual([...new Set(tables)], ['documents'], `system=${system} read ${tables}`);
    assert.equal(res.statusCode, 200);
  }
});
