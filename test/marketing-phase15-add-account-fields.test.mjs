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

check('dispatch wiring: resource=setup_account_fields POST routes to handleSetupAccountFieldsPost', () => {
  assert.match(
    raw,
    /if \(resource === 'setup_account_fields' && req\.method === 'POST'\) \{\s*return await handleSetupAccountFieldsPost\(req, res\);\s*\}/
  );
});

check('resource-list error string mentions setup_account_fields (POST)', () => {
  const errLine = raw.split('\n').find((l) => l.includes('resource must be one of:'));
  assert.ok(errLine, 'expected to find the resource-list error string');
  assert.match(errLine, /setup_account_fields \(POST\)/);
});

// ---------- vm-extraction of the Phase 15 dynamic account fields block ----------

const startMarkerMatch = raw.match(/\/\/ ----------.*dynamic account fields \(Phase 15\) ----------/); // relaxed: sibling connector-catalog/add-account-ui branch prefixes this header line with its own text once merged
const startMarker = startMarkerMatch ? startMarkerMatch[0] : '// ---------- Universal Connections: dynamic account fields (Phase 15) ----------';
const endMarker = '// ---------- Campaign management: delete / rename / duplicate / activity / scheduled sends ----------';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find the Phase 15 dynamic account fields block start marker');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the Campaign management block after the Phase 15 block');
const blockSrc = raw.slice(startIdx, endIdx);

check('website_cms requires cmsPlatform/siteUrl/apiKey; direct_mail requires only vendorName (note is optional)', () => {
  assert.match(blockSrc, /name: 'cmsPlatform'.*required: true/);
  assert.match(blockSrc, /name: 'vendorName'.*required: true/);
  assert.match(blockSrc, /name: 'note', label: 'Notes', type: 'text', required: false/);
});

function makeSandbox({ existingRow = null, saveOk = true } = {}) {
  const calls = [];
  const CHANNEL_LABELS = {
    sms: 'SMS', google_ads: 'Google Ads', meta_ads: 'Meta (Facebook/Instagram)',
    google_business_profile: 'Google Business Profile', website_cms: 'Website / CMS',
    ga4: 'Google Analytics 4', gtm: 'Google Tag Manager', search_console: 'Search Console',
    youtube: 'YouTube', facebook_instagram: 'Facebook Page / Instagram', microsoft_ads: 'Microsoft Ads',
    linkedin: 'LinkedIn', tiktok: 'TikTok', direct_mail: 'Direct Mail',
  };
  const SETUP_ACCOUNT_PLATFORMS = new Set(['email', ...Object.keys(CHANNEL_LABELS)]);
  const mockAccounts = [{ key: 'website_cms', label: 'Website / CMS', state: 'setup_incomplete' }];
  const setupAccountsShape = async () => mockAccounts;
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
    encodeURIComponent,
    JSON,
    Set,
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

// ---------- functional: validateConnectorFieldValues ----------

check('functional: website_cms with all 3 required fields validates ok and trims values', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('website_cms', { cmsPlatform: '  WordPress  ', siteUrl: 'https://example.com', apiKey: 'abc123' });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.payload.cmsPlatform, 'WordPress');
  assert.equal(result.payload.siteUrl, 'https://example.com');
});

check('functional: website_cms missing apiKey fails with a specific error naming the missing field', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('website_cms', { cmsPlatform: 'WordPress', siteUrl: 'https://example.com' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('API key')));
});

check('functional: direct_mail with only vendorName (optional note omitted) validates ok', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('direct_mail', { vendorName: 'Acme Mailers' });
  assert.equal(result.ok, true);
  assert.equal(result.payload.vendorName, 'Acme Mailers');
  assert.equal(result.payload.note, null);
});

check('functional: an oauth-type platform (google_ads) with no declared fields always validates ok regardless of input', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('google_ads', { anything: 'ignored' });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), {});
});

check('functional: a whitespace-only required field is rejected, not silently accepted', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('direct_mail', { vendorName: '   ' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Vendor name')));
});

// ---------- functional: handleSetupAccountFieldsPost ----------

check('functional: brand-new platform submission with valid fields inserts a row and advances not_connected -> setup_incomplete', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: null });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'Webflow', siteUrl: 'https://acme.com', apiKey: 'xyz' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getJson().ok, true);
  assert.equal(getJson().state, 'setup_incomplete');
  const writeCall = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(writeCall, 'expected an insert for a brand-new platform');
  const payload = JSON.parse(writeCall.opts.body)[0];
  assert.equal(payload.state, 'setup_incomplete');
  assert.equal(payload.fields.siteUrl, 'https://acme.com');
});

check('functional: resubmitting fields on an already-launch_enabled connection does not regress its state', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: { state: 'launch_enabled' } });
  const { req, res, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'Custom', siteUrl: 'https://new-url.com', apiKey: 'newkey' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.equal(getJson().state, 'launch_enabled');
  const writeCall = calls.find((c) => c.opts && c.opts.method === 'PATCH');
  const payload = JSON.parse(writeCall.opts.body);
  assert.equal(payload.state, 'launch_enabled');
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

check('functional: a successful submission returns the real accounts array from setupAccountsShape', async () => {
  const { sandbox } = makeSandbox({ existingRow: null });
  const { req, res, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'Webflow', siteUrl: 'https://acme.com', apiKey: 'xyz' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.deepEqual(JSON.parse(JSON.stringify(getJson().accounts)), [{ key: 'website_cms', label: 'Website / CMS', state: 'setup_incomplete' }]);
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
