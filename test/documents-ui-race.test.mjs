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
  vm.runInContext(extractFunction(raw, 'async function hlDocConfirmUpload(){'), sandbox, { filename: SRC_PATH });
  await sandbox.hlDocConfirmUpload();

  assert.equal(errors.length, 1);
  assert.match(toasts[0], /could not be cleaned up automatically/);
  assert.equal(window.HL_PENDING_UPLOAD, pending, 'failed metadata remains available for a deliberate retry');
});
