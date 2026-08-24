import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC_PATH = 'public/index.html';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

function extractFunction(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}"`);
  const braceStart = idx + declSnippet.length - 1;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(idx, i + 1);
  }
  throw new Error(`unterminated function ${declSnippet}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a stale Documents folder/page request cannot overwrite a newer selection', async () => {
  const requests = [];
  const elements = new Map([
    ['hldoc-list', { innerHTML: '', style: {} }],
    ['hldoc-empty', { innerHTML: '', style: {} }],
    ['hldoc-page', { innerHTML: '', style: {} }],
  ]);
  const sb = {
    from() {
      const pending = deferred();
      const request = { pending, folder: null, range: null };
      requests.push(request);
      const query = {
        select() { return query; },
        order() { return query; },
        eq(_column, value) { request.folder = value; return query; },
        range(from, to) { request.range = [from, to]; return query; },
        then(resolve, reject) { return pending.promise.then(resolve, reject); },
      };
      return query;
    },
  };
  const sandbox = {
    HLDOC: {
      folders: [], docs: [], activeFolder: 'old-folder', viewMode: 'folder',
      docPage: 0, docPageSize: 50, docTotal: null, docRequestToken: 0,
    },
    document: { getElementById: (id) => elements.get(id) || null },
    sb,
    hlEsc: String,
    hlDocRenderPagination() {},
    hlDocRenderCurrentPage() {},
    // hlDocRenderList now routes client folders and typed searches to
    // /api/hivedoc. This test is about the OTHER path -- the plain documents
    // read -- so these stubs hold it there deliberately: no matching folder
    // means no client, and no search box means no search text.
    hlDocFolders: () => [],
    hlDocFolderClient: () => null,
    hlDocRenderUnified() { throw new Error('this test must exercise the documents path, not the unified one'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(raw, 'async function hlDocRenderList(){'), sandbox, { filename: SRC_PATH });

  const older = sandbox.hlDocRenderList();
  sandbox.HLDOC.activeFolder = 'new-folder';
  const newer = sandbox.hlDocRenderList();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].folder, 'old-folder');
  assert.equal(requests[1].folder, 'new-folder');

  requests[1].pending.resolve({ data: [{ id: 'new-doc' }], error: null, count: 1 });
  await newer;
  requests[0].pending.resolve({ data: [{ id: 'stale-doc' }], error: null, count: 99 });
  await older;

  assert.deepEqual(sandbox.HLDOC.docs.map((doc) => doc.id), ['new-doc']);
  assert.equal(sandbox.HLDOC.docTotal, 1);
});

// Self-test 2026-08-18: "Uncaught TypeError: HLDOC.folders.find is not a
// function", clicking "All documents" -- reported repeatedly across weeks
// under shifting line numbers, and an earlier investigation could not pin
// the exact mechanism by reading code alone (HLDOC.folders is only ever set
// to [] or `data || []` by the code that owns it). Fixed as defense-in-depth
// via a single hlDocFolders() accessor every .find()/.filter() call site now
// goes through, rather than leaving a real, repeatedly-reported crash
// unresolved while chasing an unconfirmed mechanism.
test('hlDocSelectFolder does not throw even if HLDOC.folders is somehow not an array', () => {
  const sandbox = {
    HLDOC: { folders: null, activeFolder: null, viewMode: 'folder', docPage: 0, expanded: {} },
    document: { getElementById: () => null },
    hlDocRenderTree() {},
    hlDocRenderList() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractFunction(raw, 'function hlDocFolders(){') + '\n' + extractFunction(raw, 'function hlDocSelectFolder(id){'),
    sandbox, { filename: SRC_PATH },
  );
  assert.doesNotThrow(() => sandbox.hlDocSelectFolder('some-id'));
  assert.equal(sandbox.HLDOC.activeFolder, 'some-id');
});

test('hlDocFolders() normalizes a non-array value instead of exposing it to callers', () => {
  const sandbox = { HLDOC: { folders: undefined } };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(raw, 'function hlDocFolders(){'), sandbox, { filename: SRC_PATH });
  const empty = sandbox.hlDocFolders();
  assert.equal(Array.isArray(empty), true);
  assert.equal(empty.length, 0);
  const real = [{ id: 'f1' }];
  sandbox.HLDOC.folders = real;
  assert.equal(sandbox.hlDocFolders(), real, 'a real array must pass through unchanged, not get copied');
});

test('explicit password login preserves a deep link and re-applies role navigation', async () => {
  const calls = { route: 0, show: [], permissions: 0 };
  const elements = {
    'lg-user': { value: 'user@example.test' },
    'lg-pass': { value: 'secret' },
    'lg-err': { style: {} },
    login: { style: {}, classList: { add() {} } },
  };
  const button = { disabled: false, textContent: '', innerHTML: '' };
  const window = {
    dispatchEvent() {},
    hlApplyRolePermissions() { calls.permissions++; },
    showView(view) { calls.show.push(view); },
  };
  const sandbox = {
    window,
    document: {
      getElementById: (id) => elements[id],
      querySelector: () => button,
    },
    sb: { auth: { signInWithPassword: async () => ({ error: null, data: { session: { access_token: 'session' } } }) } },
    hlLoadProfile: async () => {},
    hlSyncProfileUI() {},
    hlCheckRoute() { calls.route++; return true; },
    showView: window.showView,
    Event: class Event { constructor(type) { this.type = type; } },
    setTimeout(fn) { fn(); return 1; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(raw, 'async function lgSubmit(){'), sandbox, { filename: SRC_PATH });
  await sandbox.lgSubmit();

  assert.equal(calls.permissions, 1);
  assert.equal(calls.route, 1);
  assert.deepEqual(calls.show, []);
  assert.equal(elements.login.style.display, 'none');
});

test('metadata failure reports an orphan cleanup failure instead of hiding it', async () => {
  const toasts = [];
  const errors = [];
  const pending = { file: { name: 'receipt.pdf', type: 'application/pdf', size: 12 }, suggestion: { confidence: 0.7 } };
  const window = { HL_PENDING_UPLOAD: pending };
  const sandbox = {
    window,
    HLDOC: { activeFolder: null, docPage: 0 },
    document: { getElementById: () => ({ value: 'invoice', style: {} }) },
    crypto: { randomUUID: () => 'uuid' },
    sb: {
      storage: { from: () => ({
        upload: async () => ({ error: null }),
        remove: async () => ({ error: { message: 'cleanup denied' } }),
      }) },
      auth: { getUser: async () => ({ data: { user: { id: 'user-id' } } }) },
      from: () => ({ insert: async () => ({ error: { message: 'metadata denied' } }) }),
    },
    chirpToast: (message) => toasts.push(message),
    console: { error: (...args) => errors.push(args), log() {}, warn() {} },
    hlEsc: String,
  };
  vm.createContext(sandbox);
  // hlDocConfirmUpload now stamps category/client/job, so it needs the helpers
  // that work those out. What this test is about is unchanged: the failure path
  // when the metadata insert is rejected after the file has reached storage.
  vm.runInContext(
    [
      'var HLDOC_CATEGORIES = ' + JSON.stringify(['Contract', 'Permit', 'Photo', 'Invoice', 'Receipt', 'Estimate', 'Payroll', 'Other']) + ';',
      'var HLDOC_CATEGORY_TO_DOC_TYPE = ' + JSON.stringify({
        Contract: 'contract', Permit: 'permit', Photo: 'photo', Invoice: 'invoice',
        Estimate: 'estimate', Payroll: 'payroll', Receipt: 'other', Other: 'other',
      }) + ';',
      extractFunction(raw, 'function hlDocFolders(){'),
      extractFunction(raw, 'function hlDocCanonicalCategory(value){'),
      extractFunction(raw, 'function hlDocFolderContext(folderId){'),
      extractFunction(raw, 'async function hlDocConfirmUpload(){'),
    ].join('\n'),
    sandbox, { filename: SRC_PATH },
  );
  await sandbox.hlDocConfirmUpload();

  assert.equal(errors.length, 1);
  assert.match(toasts[0], /could not be cleaned up automatically/);
  assert.equal(window.HL_PENDING_UPLOAD, pending, 'failed metadata remains available for a deliberate retry');
});

// --- HiveDoc unification (2026-08-21) ---

test('a client folder is read through /api/hivedoc, not the documents table', async () => {
  const sbCalls = [];
  const sandbox = {
    HLDOC: {
      folders: [], docs: [], activeFolder: 'folder-smith', viewMode: 'folder',
      docPage: 0, docPageSize: 50, docTotal: null, docRequestToken: 0,
    },
    document: { getElementById: () => ({ innerHTML: '', style: {}, value: '' }) },
    // If the client path ever falls back to querying `documents` directly, the
    // client's photos vanish again -- which is the bug this whole change exists
    // to fix. So a Supabase call here is a failure, not an alternative route.
    sb: { from(table) { sbCalls.push(table); throw new Error('must not query ' + table + ' for a client folder'); } },
    hlEsc: String,
    hlDocRenderPagination() {},
    hlDocRenderCurrentPage() {},
    hlDocFolders: () => [{ id: 'folder-smith', name: 'John Smith', client_id: 'c-1', client_name: 'John Smith' }],
    hlDocFolderClient: (f) => (f && f.client_id ? { client_id: f.client_id } : null),
    unifiedArgs: null,
    hlDocRenderUnified(folder, searchText, token) { sandbox.unifiedArgs = { folder, searchText, token }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(raw, 'async function hlDocRenderList(){'), sandbox, { filename: SRC_PATH });

  await sandbox.hlDocRenderList();

  assert.equal(sbCalls.length, 0, 'a client folder must not hit the documents table directly');
  assert.ok(sandbox.unifiedArgs, 'a client folder goes to the unified reader');
  assert.equal(sandbox.unifiedArgs.folder.client_id, 'c-1');
});

test('typing a search leaves the page-local path even outside a client folder', async () => {
  const sandbox = {
    HLDOC: {
      folders: [], docs: [], activeFolder: null, viewMode: 'folder',
      docPage: 0, docPageSize: 50, docTotal: null, docRequestToken: 0,
    },
    // The search box has text in it; every other element is inert.
    document: { getElementById: (id) => (id === 'hldoc-search' ? { value: '  permit  ' } : { innerHTML: '', style: {} }) },
    sb: { from(table) { throw new Error('must not query ' + table + ' when searching'); } },
    hlEsc: String,
    hlDocRenderPagination() {},
    hlDocRenderCurrentPage() {},
    hlDocFolders: () => [],
    hlDocFolderClient: () => null,
    unifiedArgs: null,
    hlDocRenderUnified(folder, searchText, token) { sandbox.unifiedArgs = { folder, searchText, token }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(raw, 'async function hlDocRenderList(){'), sandbox, { filename: SRC_PATH });

  await sandbox.hlDocRenderList();

  assert.ok(sandbox.unifiedArgs, 'a typed search is served by the search engine, not by filtering one page');
  assert.equal(sandbox.unifiedArgs.searchText, 'permit', 'and the term is trimmed before it is sent');
});
