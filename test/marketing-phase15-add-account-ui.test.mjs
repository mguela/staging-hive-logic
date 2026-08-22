import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------- Static source checks (whole-file, not vm-extracted) ----------

check('dispatch wiring: resource=connector_catalog GET routes to handleConnectorCatalogGet', () => {
  assert.match(
    raw,
    /if \(resource === 'connector_catalog' && req\.method === 'GET'\) \{\s*return await handleConnectorCatalogGet\(req, res\);\s*\}/
  );
});

check('dispatch wiring: resource=setup_account_fields POST routes to handleSetupAccountFieldsPost', () => {
  assert.match(
    raw,
    /if \(resource === 'setup_account_fields' && req\.method === 'POST'\) \{\s*return await handleSetupAccountFieldsPost\(req, res\);\s*\}/
  );
});

check('resource-list error string mentions connector_catalog (GET) and setup_account_fields (POST)', () => {
  const errLine = raw.split('\n').find((l) => l.includes('resource must be one of:'));
  assert.ok(errLine, 'expected to find the resource-list error string');
  assert.match(errLine, /connector_catalog \(GET\)/);
  assert.match(errLine, /setup_account_fields \(POST\)/);
});

check('setupAccountsShape selects the fields column and returns a redacted copy per account', () => {
  assert.match(raw, /select=platform,state,account_name,account_id,login_account_id,note,last_verified_at,fields&tenant_id=eq\.ghgrp/);
  // 2026-08-17 security fix: this used to be `fields: (row && row.fields) || {},`,
  // returning secret-typed field values (e.g. website_cms's apiKey) verbatim to
  // any signed-in employee. Now built from a redacted safeFields object --
  // see test/marketing-setup-accounts-secret-redaction.test.mjs for the
  // behavioral coverage of the redaction itself.
  assert.match(raw, /fields: safeFields,/);
  assert.match(raw, /savedSecretFields,/);
});

// ---------- vm-extraction of the Phase 15 connector catalog + fields block ----------

const startMarker = '// ---------- Universal Connections: connector catalog + dynamic account fields (Phase 15) ----------';
const endMarker = '// ---------- Campaign management: delete / rename / duplicate / activity / scheduled sends ----------';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find the Phase 15 block start marker');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the Campaign management block after the Phase 15 block');
const blockSrc = raw.slice(startIdx, endIdx);

check('website_cms requires cmsPlatform/siteUrl/apiKey; direct_mail requires only vendorName (note is optional)', () => {
  assert.match(blockSrc, /name: 'cmsPlatform'.*required: true/);
  assert.match(blockSrc, /name: 'vendorName'.*required: true/);
  assert.match(blockSrc, /name: 'note', label: 'Notes', type: 'text', required: false/);
});

function makeSandbox({ existingRow = null, saveOk = true, mockAccounts } = {}) {
  const calls = [];
  const CHANNEL_LABELS = {
    sms: 'SMS', google_ads: 'Google Ads', meta_ads: 'Meta (Facebook/Instagram)',
    google_business_profile: 'Google Business Profile', website_cms: 'Website / CMS',
    ga4: 'Google Analytics 4', gtm: 'Google Tag Manager', search_console: 'Search Console',
    youtube: 'YouTube', facebook_instagram: 'Facebook Page / Instagram', microsoft_ads: 'Microsoft Ads',
    linkedin: 'LinkedIn', tiktok: 'TikTok', direct_mail: 'Direct Mail',
  };
  const SETUP_ACCOUNT_PLATFORMS = new Set(['email', ...Object.keys(CHANNEL_LABELS)]);
  const defaultAccounts = [...SETUP_ACCOUNT_PLATFORMS].map((key) => ({
    key, label: key === 'email' ? 'Email (Resend)' : CHANNEL_LABELS[key], state: 'not_connected',
  }));
  const setupAccountsShape = async () => mockAccounts || defaultAccounts;
  const supabaseRequest = async (path, opts) => {
    calls.push({ path, opts });
    if (!opts) {
      return { ok: true, json: async () => (existingRow ? [existingRow] : []) };
    }
    return { ok: saveOk, text: async () => 'save failed', json: async () => ({}) };
  };
  const sandbox = {
    supabaseRequest,
    setupAccountsShape,
    SETUP_ACCOUNT_PLATFORMS,
    CHANNEL_LABELS,
    encodeURIComponent,
    JSON,
    Set,
    Map,
    Date,
    String,
    console,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return { sandbox, calls };
}

function makeReqRes(body) {
  let statusCode = null;
  let json = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { json = obj; return this; },
  };
  return { req: { body }, res, getStatus: () => statusCode, getJson: () => json };
}

// ---------- functional: connectorCatalogShape / handleConnectorCatalogGet ----------

check('functional: full catalog has all 15 platforms, oauth types declare zero fields', async () => {
  const { sandbox } = makeSandbox();
  const catalog = await sandbox.connectorCatalogShape();
  assert.equal(catalog.length, 15);
  const googleAds = catalog.find((c) => c.key === 'google_ads');
  assert.equal(googleAds.authMethod, 'oauth');
  assert.equal(googleAds.fields.length, 0);
});

check('functional: website_cms catalog entry carries its 3-field schema end to end', async () => {
  const { sandbox } = makeSandbox();
  const catalog = await sandbox.connectorCatalogShape();
  const cms = catalog.find((c) => c.key === 'website_cms');
  const fieldNames = JSON.parse(JSON.stringify(cms.fields.map((f) => f.name)));
  assert.deepEqual(fieldNames, ['cmsPlatform', 'siteUrl', 'apiKey']);
});

check('functional: a platform with a real connection is alreadyActive and excluded from available', async () => {
  const mockAccounts = [
    { key: 'email', label: 'Email (Resend)', state: 'not_connected' },
    { key: 'website_cms', label: 'Website / CMS', state: 'setup_incomplete' },
  ];
  const { sandbox } = makeSandbox({ mockAccounts });
  const { req, res, getJson } = makeReqRes();
  await sandbox.handleConnectorCatalogGet(req, res);
  const body = getJson();
  const cms = body.catalog.find((c) => c.key === 'website_cms');
  assert.equal(cms.alreadyActive, true);
  assert.ok(!body.available.some((c) => c.key === 'website_cms'));
  assert.ok(body.available.some((c) => c.key === 'email'));
});

// ---------- functional: validateConnectorFieldValues ----------

check('functional: website_cms with all 3 required fields validates ok and trims values', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('website_cms', { cmsPlatform: '  WordPress  ', siteUrl: 'https://example.com', apiKey: 'abc123' });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.payload.cmsPlatform, 'WordPress');
});

check('functional: website_cms missing apiKey fails with a specific error naming the missing field', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('website_cms', { cmsPlatform: 'WordPress', siteUrl: 'https://example.com' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('API key')));
});

check('functional: an oauth-type platform (google_ads) with no declared fields always validates ok', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('google_ads', { anything: 'ignored' });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), {});
});

// ---------- functional: handleSetupAccountFieldsPost ----------

check('functional: brand-new platform submission inserts a row and advances not_connected -> setup_incomplete', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: null });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'Webflow', siteUrl: 'https://acme.com', apiKey: 'xyz' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getJson().ok, true);
  assert.equal(getJson().state, 'setup_incomplete');
  const writeCall = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(writeCall, 'expected an insert for a brand-new platform');
  const payload = JSON.parse(writeCall.opts.body)[0];
  assert.equal(payload.fields.siteUrl, 'https://acme.com');
});

check('functional: missing required fields are rejected with 400 and never write to the table', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: null });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'WordPress' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.equal(getStatus(), 400);
  assert.equal(getJson().ok, false);
  const writeCall = calls.find((c) => c.opts && (c.opts.method === 'PATCH' || c.opts.method === 'POST'));
  assert.equal(writeCall, undefined, 'an invalid submission must never write to marketing_platform_connections');
});

check('functional: unknown platform is rejected with 400', async () => {
  const { sandbox } = makeSandbox();
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'not_a_real_platform', fields: {} });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.equal(getStatus(), 400);
  assert.equal(getJson().ok, false);
});

// ---------- Runner ----------

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
