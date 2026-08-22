// test/marketing-setup-accounts-secret-redaction.test.mjs
// 2026-08-17 (found during Dev To-Do triage, jomell): setupAccountsShape()
// -- the shared function feeding resource=setup (GET), setup_account (POST),
// setup_account_fields (POST), and connection_transition (POST) -- used to
// return the raw `fields` column verbatim. For website_cms that includes a
// real apiKey in plaintext, sent to the browser of ANY signed-in employee
// (this resource has no role gate beyond being signed in). Same vm-extraction
// technique as test/marketing-phase15-add-account-fields.test.mjs (api/
// marketing.js has no named exports), but run through the standard node:test
// API rather than that sibling's standalone process.exit() runner, which
// would kill the whole batch if this file were picked up by
// `node --test test/*.test.mjs` alongside every other test.
// Run with: node --experimental-test-module-mocks --test test/marketing-setup-accounts-secret-redaction.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

// setupAccountsShape() also closes over CHANNEL_LABELS and CONNECTED_STATES,
// both defined ~2200 lines earlier in the file -- pull the real declarations
// in too rather than hand-typing a copy that could drift from the source.
function extractConst(name) {
  const marker = 'const ' + name;
  const idx = raw.indexOf(marker);
  assert.ok(idx !== -1, 'expected to find ' + name);
  // \r?\n -- this file is checked out CRLF on Windows (core.autocrlf=true)
  // even though the committed blob is LF.
  const rest = raw.slice(idx);
  const m = /;\r?\n/.exec(rest);
  assert.ok(m, 'expected a terminating ";" for ' + name);
  return rest.slice(0, m.index + 1);
}
const channelLabelsSrc = extractConst('CHANNEL_LABELS');
const connectedStatesSrc = extractConst('CONNECTED_STATES');

const startMarker = 'async function setupAccountsShape() {';
const endMarker = '\n// Task #104: resume-my-own-setup prefill.';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find setupAccountsShape');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the marker after CONNECTOR_FIELD_SCHEMAS');
const blockSrc = raw.slice(startIdx, endIdx);

function makeSandbox(rows) {
  const sandbox = {
    fetchAllRows: async () => rows,
    isEmailConfigured: () => false,
    isEmailSendEnabled: () => false,
    console,
    Map,
    Set,
    Object,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    channelLabelsSrc + '\n' + connectedStatesSrc + '\n' + blockSrc +
      '\nthis.setupAccountsShape = setupAccountsShape; this.CONNECTOR_FIELD_SCHEMAS = CONNECTOR_FIELD_SCHEMAS;',
    sandbox, { filename: SRC_PATH },
  );
  return sandbox;
}

test('website_cms has a real secret-flagged field (apiKey) -- confirms the schema this test relies on', () => {
  const sandbox = makeSandbox([]);
  assert.equal(sandbox.CONNECTOR_FIELD_SCHEMAS.website_cms.fields.find(f => f.name === 'apiKey').secret, true);
});

test('a saved website_cms apiKey is never returned in the fields object', async () => {
  const sandbox = makeSandbox([
    { platform: 'website_cms', state: 'launch_enabled', account_name: null, account_id: null, login_account_id: null, note: null, last_verified_at: null, fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk-real-secret-value-12345' } },
  ]);
  const accounts = await sandbox.setupAccountsShape();
  const cms = accounts.find(a => a.key === 'website_cms');
  assert.ok(cms);
  assert.equal(cms.fields.apiKey, undefined, 'the real secret value must never appear in the response');
  assert.equal(JSON.stringify(cms).includes('sk-real-secret-value-12345'), false, 'the raw secret must not appear anywhere in the serialized response');
});

test('non-secret fields on the same platform still pass through normally', async () => {
  const sandbox = makeSandbox([
    { platform: 'website_cms', state: 'launch_enabled', account_name: null, account_id: null, login_account_id: null, note: null, last_verified_at: null, fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk-real-secret' } },
  ]);
  const accounts = await sandbox.setupAccountsShape();
  const cms = accounts.find(a => a.key === 'website_cms');
  assert.equal(cms.fields.cmsPlatform, 'WordPress');
  assert.equal(cms.fields.siteUrl, 'https://acme.com');
});

test('savedSecretFields reports the field name (so the UI can show "already saved") without the value', async () => {
  const sandbox = makeSandbox([
    { platform: 'website_cms', state: 'launch_enabled', account_name: null, account_id: null, login_account_id: null, note: null, last_verified_at: null, fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk-real-secret' } },
  ]);
  const accounts = await sandbox.setupAccountsShape();
  const cms = accounts.find(a => a.key === 'website_cms');
  assert.deepEqual(JSON.parse(JSON.stringify(cms.savedSecretFields)), ['apiKey']);
});

test('a platform with no saved secret reports an empty savedSecretFields, not a false positive', async () => {
  const sandbox = makeSandbox([
    { platform: 'website_cms', state: 'setup_incomplete', account_name: null, account_id: null, login_account_id: null, note: null, last_verified_at: null, fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com' } },
  ]);
  const accounts = await sandbox.setupAccountsShape();
  const cms = accounts.find(a => a.key === 'website_cms');
  assert.deepEqual(JSON.parse(JSON.stringify(cms.savedSecretFields)), []);
});

test('an oauth-type platform with no declared secret fields (google_ads) is unaffected', async () => {
  const sandbox = makeSandbox([
    { platform: 'google_ads', state: 'launch_enabled', account_name: 'Acme', account_id: '123', login_account_id: null, note: null, last_verified_at: null, fields: {} },
  ]);
  const accounts = await sandbox.setupAccountsShape();
  const ga = accounts.find(a => a.key === 'google_ads');
  assert.equal(ga.accountName, 'Acme');
  assert.deepEqual(JSON.parse(JSON.stringify(ga.savedSecretFields)), []);
});
