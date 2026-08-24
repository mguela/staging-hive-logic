// What an upload gets stamped with.
//
// The columns these tests assert on are the ones the search engine actually
// reads. A file with a tidy folder but a null client_id is invisible to its own
// client's folder and to every search for that client's name -- so "it uploaded
// fine" is not the bar; "it can be found again" is.
//
// These run the real hlDocConfirmUpload / hlDocFolderContext source out of
// public/index.html in a VM sandbox, so they fail if the shipped code drifts.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC_PATH = 'public/index.html';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

function extractFunction(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, 'expected to find ' + declSnippet);
  const braceStart = idx + declSnippet.length - 1;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(idx, i + 1);
  }
  throw new Error('unterminated function ' + declSnippet);
}

// Pulls a `var NAME = ...;` declaration, array or object literal alike.
function extractVar(source, name) {
  const idx = source.indexOf('var ' + name + ' = ');
  assert.ok(idx !== -1, 'expected to find var ' + name);
  const open = source.indexOf(source[source.indexOf('=', idx) + 2] === '{' ? '{' : '[', idx);
  const closer = source[open] === '{' ? '}' : ']';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === source[open]) depth++;
    else if (source[i] === closer && --depth === 0) return source.slice(idx, i + 2);
  }
  throw new Error('unterminated var ' + name);
}

// The folder tree the app actually renders: Clients > <client> > <job>.
const FOLDERS = [
  { id: 'root', name: 'Clients', parent_id: null },
  { id: 'f-smith', name: 'John Smith', parent_id: 'root', client_id: 'c-1', client_name: 'John Smith' },
  { id: 'f-kitchen', name: 'Kitchen Renovation', parent_id: 'f-smith', job_id: 'j-9', job_title: 'Kitchen Renovation' },
  { id: 'f-internal', name: 'Insurance', parent_id: null },
];

const HELPERS = [
  'function hlDocFolders(){',
  'function hlDocCanonicalCategory(value){',
  'function hlDocCategoryFromDocType(docType){',
  'function hlDocFolderContext(folderId){',
  'function hlDocDefaultTitle(parts){',
];

function loadInto(sandbox, decls) {
  vm.createContext(sandbox);
  const src = [extractVar(raw, 'HLDOC_CATEGORIES'), extractVar(raw, 'HLDOC_CATEGORY_TO_DOC_TYPE')]
    .concat(decls.map((d) => extractFunction(raw, d)))
    .join('\n');
  vm.runInContext(src, sandbox, { filename: SRC_PATH });
  return sandbox;
}

function helperSandbox() {
  return loadInto({ HLDOC: { folders: FOLDERS, activeFolder: null }, document: { getElementById: () => null } }, HELPERS);
}

// --- working out what a file is about ---

test('a job folder inherits its client from the folder above it', () => {
  const ctx = helperSandbox().hlDocFolderContext('f-kitchen');
  assert.equal(ctx.job_id, 'j-9');
  assert.equal(ctx.job_title, 'Kitchen Renovation');
  // The job folder carries no client of its own; without walking up, this file
  // would be stored with no client at all.
  assert.equal(ctx.client_id, 'c-1');
  assert.equal(ctx.client_name, 'John Smith');
});

test('a client folder yields a client and no job', () => {
  const ctx = helperSandbox().hlDocFolderContext('f-smith');
  assert.equal(ctx.client_id, 'c-1');
  assert.equal(ctx.job_id, null, 'a client folder is not a job');
});

test('an internal folder yields neither, rather than inventing one', () => {
  const ctx = helperSandbox().hlDocFolderContext('f-internal');
  // Spread first: the object is built inside the VM realm, so a direct
  // deepStrictEqual fails on prototype identity rather than on the values.
  assert.deepEqual({ ...ctx }, { client_id: null, client_name: null, job_id: null, job_title: null });
});

test('a folder id that does not exist returns empties instead of throwing', () => {
  assert.equal(helperSandbox().hlDocFolderContext('nope').client_id, null);
});

test('a cycle in the folder tree terminates instead of spinning forever', () => {
  const s = helperSandbox();
  s.HLDOC.folders = [
    { id: 'a', name: 'A', parent_id: 'b' },
    { id: 'b', name: 'B', parent_id: 'a' },
  ];
  assert.doesNotThrow(() => s.hlDocFolderContext('a'));
});

// --- the category vocabulary vs. the legacy column ---

test('Receipt is offered even though the legacy doc_type constraint has no receipt', () => {
  const s = helperSandbox();
  assert.ok(s.HLDOC_CATEGORIES.includes('Receipt'));
  // doc_type is NOT NULL with a validated CHECK that predates this vocabulary,
  // so Receipt has to degrade to a value that constraint accepts.
  assert.equal(s.HLDOC_CATEGORY_TO_DOC_TYPE.Receipt, 'other');
});

test('every category maps to a doc_type the database will accept', () => {
  const s = helperSandbox();
  const allowed = ['contract', 'permit', 'invoice', 'estimate', 'photo', 'payroll', 'other'];
  for (const category of s.HLDOC_CATEGORIES) {
    assert.ok(allowed.includes(s.HLDOC_CATEGORY_TO_DOC_TYPE[category]), category + ' maps outside the doc_type constraint');
  }
});

test('a category is normalised before it is written, never trusted raw', () => {
  const s = helperSandbox();
  assert.equal(s.hlDocCanonicalCategory('invoice'), 'Invoice');
  assert.equal(s.hlDocCanonicalCategory('  PERMIT '), 'Permit');
  // The column carries a CHECK constraint; an unknown value would fail the
  // insert after the file had already reached storage.
  assert.equal(s.hlDocCanonicalCategory('Blueprint'), null);
});

test('the stamped title matches the format the read side generates', () => {
  const s = helperSandbox();
  assert.equal(
    s.hlDocDefaultTitle({ jobTitle: 'Kitchen Reno', category: 'Permit', day: '2026-07-14' }),
    'Kitchen Reno — Permit — 2026-07-14',
  );
  // Nothing to build a title from falls back to the filename rather than
  // emitting a string of empty separators.
  assert.equal(s.hlDocDefaultTitle({ filename: 'IMG_4821.HEIC' }), 'IMG_4821.HEIC');
});

// --- the insert itself ---

function uploadSandbox(fields, activeFolder) {
  const inserted = [];
  const els = {
    'hldoc-suggest-category': { value: fields.category },
    'hldoc-title': { value: fields.title === undefined ? '' : fields.title },
    'hldoc-docdate': { value: fields.docdate === undefined ? '' : fields.docdate },
    'hldoc-vendor': { value: fields.vendor === undefined ? '' : fields.vendor },
    'hldoc-suggest': { style: {} },
    'hldoc-file': { value: 'x' },
  };
  const sandbox = {
    HLDOC: { folders: FOLDERS, activeFolder, docPage: 3 },
    window: { HL_PENDING_UPLOAD: { file: { name: 'permit.pdf', type: 'application/pdf', size: 10 }, suggestion: { confidence: 0.9 } } },
    document: { getElementById: (id) => els[id] || null },
    crypto: { randomUUID: () => 'uuid' },
    sb: {
      storage: { from: () => ({ upload: async () => ({ error: null }) }) },
      auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
      from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }),
    },
    chirpToast() {},
    hlEsc: String,
    hlDocRenderList() {},
    console,
  };
  loadInto(sandbox, ['function hlDocFolders(){', 'function hlDocCanonicalCategory(value){', 'function hlDocFolderContext(folderId){', 'async function hlDocConfirmUpload(){']);
  return { sandbox, inserted };
}

test('an upload into a job folder is stamped with client, job, category and source', async () => {
  const { sandbox, inserted } = uploadSandbox({ category: 'Permit', docdate: '2026-07-14' }, 'f-kitchen');
  await sandbox.hlDocConfirmUpload();

  assert.equal(inserted.length, 1);
  const row = inserted[0];
  assert.equal(row.category, 'Permit');
  assert.equal(row.source, 'Manual upload');
  assert.equal(row.client_id, 'c-1', 'the client is what makes the file findable at all');
  assert.equal(row.client_name, 'John Smith');
  assert.equal(row.job_id, 'j-9');
  assert.equal(row.doc_type, 'permit', 'the legacy column stays populated and valid');
  assert.match(row.document_date, /^2026-07-14T/);
});

test('the document date is the date on the document, not the upload time', async () => {
  // A permit issued in June and scanned in August has to sort as June, or
  // "latest permit" answers with the wrong one.
  const { sandbox, inserted } = uploadSandbox({ category: 'Permit', docdate: '2026-06-02' }, 'f-kitchen');
  await sandbox.hlDocConfirmUpload();
  assert.match(inserted[0].document_date, /^2026-06-02T/);
});

test('a vendor is kept on an invoice and dropped from anything else', async () => {
  const invoice = uploadSandbox({ category: 'Invoice', vendor: 'Joe the Plumber' }, 'f-kitchen');
  await invoice.sandbox.hlDocConfirmUpload();
  assert.equal(invoice.inserted[0].vendor_name, 'Joe the Plumber');

  // The vendor box is hidden for a permit, but a stale value must not ride
  // along -- "Joe the Plumber" matching a permit is a wrong search result.
  const permit = uploadSandbox({ category: 'Permit', vendor: 'Joe the Plumber' }, 'f-kitchen');
  await permit.sandbox.hlDocConfirmUpload();
  assert.equal(permit.inserted[0].vendor_name, null);
});

test('a category outside the vocabulary is normalised, not sent to the constraint', async () => {
  const { sandbox, inserted } = uploadSandbox({ category: 'Blueprint' }, 'f-kitchen');
  await sandbox.hlDocConfirmUpload();
  assert.equal(inserted[0].category, 'Other');
  assert.equal(inserted[0].doc_type, 'other');
});

test('a Receipt writes the new category while keeping doc_type legal', async () => {
  const { sandbox, inserted } = uploadSandbox({ category: 'Receipt' }, 'f-kitchen');
  await sandbox.hlDocConfirmUpload();
  assert.equal(inserted[0].category, 'Receipt');
  assert.equal(inserted[0].doc_type, 'other');
});

test('an upload outside any client folder stores nulls rather than a wrong client', async () => {
  const { sandbox, inserted } = uploadSandbox({ category: 'Other' }, 'f-internal');
  await sandbox.hlDocConfirmUpload();
  assert.equal(inserted[0].client_id, null);
  assert.equal(inserted[0].source, 'Manual upload', 'source is known even when the client is not');
});

test('an empty title is stored as null so the read side generates one', async () => {
  const { sandbox, inserted } = uploadSandbox({ category: 'Permit', title: '   ' }, 'f-kitchen');
  await sandbox.hlDocConfirmUpload();
  assert.equal(inserted[0].title, null);
});
