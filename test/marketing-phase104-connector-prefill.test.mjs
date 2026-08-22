// test/marketing-phase104-connector-prefill.test.mjs
// Regression guard for Task #104: pre-fill connector setup fields in the
// Connect modal from real, already-known data instead of making the owner
// retype everything from scratch every time the modal opens.
//
// The only real, honest source of pre-fill data found in this codebase is
// the owner's own previously-saved, non-secret field values for that exact
// platform (marketing_platform_connections.fields), stored by an earlier
// setup_account_fields POST that left the connection in setup_incomplete
// (or any other) state. No company-website/business-profile config exists
// anywhere in this repo to draw a genuine value from for a fresh platform
// that has never been touched, so nothing is invented for that case --
// those fields stay blank, which is the honest behavior.
//
// Secret-typed fields (apiKey) are never pre-filled with their real value.
// CONNECTOR_FIELD_SCHEMAS.website_cms.apiKey now carries `secret: true`;
// connectorCatalogShape() reports only a boolean (savedSecretFields) for
// whether a secret is already on file, never the value itself. A blank
// secret field on resubmission keeps the previously-saved value rather than
// erroring or being wiped -- validateConnectorFieldValues() now takes a
// third `existingFields` argument for exactly this, and
// handleSetupAccountFieldsPost's own JSON response never echoes a secret's
// real value back over the wire either.
//
// This writes real application code (api/marketing.js +
// public/marketing-command-center/index.html), so on top of
// structural/functional assertions this file also runs `node --check`
// against both changed files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const apiPath = path.join(repoRoot, 'api', 'marketing.js');
const frontendPath = path.join(repoRoot, 'public', 'marketing-command-center', 'index.html');

const raw = fs.readFileSync(apiPath, 'utf8');
const frontend = fs.readFileSync(frontendPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------- Syntax sanity ----------

check('api/marketing.js is syntactically valid JS after the patch', () => {
  execFileSync(process.execPath, ['--check', apiPath], { stdio: 'pipe' });
});

check('public/marketing-command-center/index.html is syntactically valid (script block parses as JS)', () => {
  const blocks = [...frontend.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const scriptBody = blocks.find(b => b.includes('function screenFor'));
  assert.ok(scriptBody, 'could not find the command center IIFE script body');
  const tmp = path.join(repoRoot, '.tmp_phase104_script_check.js');
  fs.writeFileSync(tmp, scriptBody);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ---------- Static source checks ----------

check('CONNECTOR_FIELD_SCHEMAS marks the apiKey field secret so it is never echoed back', () => {
  assert.match(
    raw,
    /\{ name: 'apiKey', label: 'API key', type: 'text', required: true, secret: true, helpText: 'Found in your CMS admin settings\.' \}/
  );
});

// ---------- vm-extraction of the Phase 15 connector catalog + fields block ----------
// (Task #104's prefill logic lives inside this same block.)

const startMarkerMatch = raw.match(/\/\/ ----------.*connector catalog.*\(Phase 15\) ----------/);
const startMarker = startMarkerMatch ? startMarkerMatch[0] : '// ---------- Universal Connections: connector catalog + dynamic account fields (Phase 15) ----------';
const endMarker = '// ---------- Campaign management: delete / rename / duplicate / activity / scheduled sends ----------';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find the Phase 15 connector catalog block start marker');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the Campaign management block after the Phase 15 block');
const blockSrc = raw.slice(startIdx, endIdx);

check('connectorPrefillShape and its wiring into connectorCatalogShape exist in source', () => {
  assert.match(blockSrc, /function connectorPrefillShape\(schema, account\)/);
  assert.match(blockSrc, /savedValues: prefill\.values/);
  assert.match(blockSrc, /savedSecretFields: prefill\.secretsSaved/);
});

function makeSandbox({ accounts = [], existingRow = null, saveOk = true } = {}) {
  const calls = [];
  const CHANNEL_LABELS = {
    sms: 'SMS', google_ads: 'Google Ads', meta_ads: 'Meta (Facebook/Instagram)',
    google_business_profile: 'Google Business Profile', website_cms: 'Website / CMS',
    ga4: 'Google Analytics 4', gtm: 'Google Tag Manager', search_console: 'Search Console',
    youtube: 'YouTube', facebook_instagram: 'Facebook Page / Instagram', microsoft_ads: 'Microsoft Ads',
    linkedin: 'LinkedIn', tiktok: 'TikTok', direct_mail: 'Direct Mail',
  };
  const SETUP_ACCOUNT_PLATFORMS = new Set(['email', ...Object.keys(CHANNEL_LABELS)]);
  const setupAccountsShape = async () => accounts;
  const supabaseRequest = async (reqPath, opts) => {
    calls.push({ path: reqPath, opts });
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
    Object,
    Array,
    console,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: apiPath });
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

// ---------- functional: connectorPrefillShape / connectorCatalogShape ----------

check('functional: a platform with no stored row gets empty savedValues and no savedSecretFields', async () => {
  const { sandbox } = makeSandbox({ accounts: [] });
  const catalog = await sandbox.connectorCatalogShape();
  const cms = catalog.find((c) => c.key === 'website_cms');
  assert.deepEqual(JSON.parse(JSON.stringify(cms.savedValues)), {});
  assert.deepEqual(Array.from(cms.savedSecretFields), []);
});

check('functional: a previously-saved non-secret value (siteUrl) resumes into savedValues', async () => {
  const accounts = [{
    key: 'website_cms', label: 'Website / CMS', state: 'setup_incomplete',
    fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk_live_realsecret' },
  }];
  const { sandbox } = makeSandbox({ accounts });
  const catalog = await sandbox.connectorCatalogShape();
  const cms = catalog.find((c) => c.key === 'website_cms');
  assert.equal(cms.savedValues.cmsPlatform, 'WordPress');
  assert.equal(cms.savedValues.siteUrl, 'https://acme.com');
});

check('functional: a saved secret value never appears anywhere in savedValues -- only its presence is flagged', async () => {
  const accounts = [{
    key: 'website_cms', label: 'Website / CMS', state: 'setup_incomplete',
    fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk_live_realsecret' },
  }];
  const { sandbox } = makeSandbox({ accounts });
  const catalog = await sandbox.connectorCatalogShape();
  const cms = catalog.find((c) => c.key === 'website_cms');
  assert.equal(cms.savedValues.apiKey, undefined, 'apiKey must never be present in savedValues');
  assert.deepEqual(Array.from(cms.savedSecretFields), ['apiKey']);
  const serialized = JSON.stringify(catalog);
  assert.ok(!serialized.includes('sk_live_realsecret'), 'the real secret value must never appear anywhere in the connector_catalog response');
});

check('functional: a platform whose stored fields are empty strings is treated as having no saved value', async () => {
  const accounts = [{
    key: 'website_cms', label: 'Website / CMS', state: 'setup_incomplete',
    fields: { cmsPlatform: '', siteUrl: null, apiKey: '' },
  }];
  const { sandbox } = makeSandbox({ accounts });
  const catalog = await sandbox.connectorCatalogShape();
  const cms = catalog.find((c) => c.key === 'website_cms');
  assert.deepEqual(JSON.parse(JSON.stringify(cms.savedValues)), {});
  assert.deepEqual(Array.from(cms.savedSecretFields), []);
});

check('functional: handleConnectorCatalogGet response end to end never leaks a saved secret', async () => {
  const accounts = [{
    key: 'website_cms', label: 'Website / CMS', state: 'setup_incomplete',
    fields: { cmsPlatform: 'Webflow', siteUrl: 'https://example.com', apiKey: 'topsecretvalue' },
  }];
  const { sandbox } = makeSandbox({ accounts });
  const { req, res, getJson } = makeReqRes();
  await sandbox.handleConnectorCatalogGet(req, res);
  const body = getJson();
  assert.ok(!JSON.stringify(body).includes('topsecretvalue'));
  const cms = body.catalog.find((c) => c.key === 'website_cms');
  assert.equal(cms.savedValues.siteUrl, 'https://example.com');
  assert.deepEqual(Array.from(cms.savedSecretFields), ['apiKey']);
});

// ---------- functional: validateConnectorFieldValues resume-with-existing-secret ----------

check('functional: a blank secret field with an already-saved value keeps the saved value instead of erroring', () => {
  const { sandbox } = makeSandbox();
  const existingFields = { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk_existing' };
  const result = sandbox.validateConnectorFieldValues(
    'website_cms',
    { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: '' },
    existingFields
  );
  assert.equal(result.ok, true);
  assert.equal(result.payload.apiKey, 'sk_existing');
});

check('functional: a blank secret field with NO already-saved value is still rejected as required', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues(
    'website_cms',
    { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: '' },
    {}
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('API key')));
});

check('functional: a freshly-typed secret value always replaces the saved one', () => {
  const { sandbox } = makeSandbox();
  const existingFields = { apiKey: 'sk_old' };
  const result = sandbox.validateConnectorFieldValues(
    'website_cms',
    { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk_brand_new' },
    existingFields
  );
  assert.equal(result.ok, true);
  assert.equal(result.payload.apiKey, 'sk_brand_new');
});

check('functional: validateConnectorFieldValues is still backward compatible when called with only 2 args (no existingFields)', () => {
  const { sandbox } = makeSandbox();
  const result = sandbox.validateConnectorFieldValues('website_cms', { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'x' });
  assert.equal(result.ok, true);
});

// ---------- functional: handleSetupAccountFieldsPost resume + never-echo-secret ----------

check('functional: resubmitting with a blank apiKey keeps the previously-saved secret in the write payload', async () => {
  const existingRow = { state: 'setup_incomplete', fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: 'sk_existing' } };
  const { sandbox, calls } = makeSandbox({ existingRow });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: '' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getJson().ok, true);
  const writeCall = calls.find((c) => c.opts && c.opts.method === 'PATCH');
  assert.ok(writeCall, 'expected a PATCH for an existing row');
  const payload = JSON.parse(writeCall.opts.body);
  assert.equal(payload.fields.apiKey, 'sk_existing', 'the saved secret must be preserved when resubmitted blank');
});

check('functional: handleSetupAccountFieldsPost never echoes the real secret value back in its JSON response', async () => {
  const { sandbox } = makeSandbox({ existingRow: null });
  const { req, res, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'Webflow', siteUrl: 'https://acme.com', apiKey: 'brand_new_secret_value' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  const body = getJson();
  assert.equal(body.fields.apiKey, undefined, 'apiKey must never be present in the response fields object');
  assert.equal(body.fields.siteUrl, 'https://acme.com', 'non-secret fields are still echoed back');
  assert.ok(!JSON.stringify(body).includes('brand_new_secret_value'), 'the real secret value must never appear anywhere in the response');
});

check('functional: brand-new platform with no existing row still requires apiKey (nothing to resume from)', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: null });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'website_cms', fields: { cmsPlatform: 'WordPress', siteUrl: 'https://acme.com', apiKey: '' } });
  await sandbox.handleSetupAccountFieldsPost(req, res);
  assert.equal(getStatus(), 400);
  assert.equal(getJson().ok, false);
  const writeCall = calls.find((c) => c.opts && (c.opts.method === 'PATCH' || c.opts.method === 'POST'));
  assert.equal(writeCall, undefined, 'must never write when a genuinely-required field is missing');
});

// ---------- Static checks: frontend wiring in public/marketing-command-center/index.html ----------

check('frontend: the field-rendering loop reads entry.savedValues/entry.savedSecretFields and never sets a secret input.value from them', () => {
  assert.match(frontend, /var savedValue = \(entry\.savedValues && Object\.prototype\.hasOwnProperty\.call\(entry\.savedValues, f\.name\)\) \? entry\.savedValues\[f\.name\] : null;/);
  assert.match(frontend, /var hasSavedSecret = !!\(f\.secret && Array\.isArray\(entry\.savedSecretFields\) && entry\.savedSecretFields\.indexOf\(f\.name\) !== -1\);/);
  assert.match(frontend, /if \(!f\.secret && savedValue\) \{ input\.value = savedValue; \}/);
});

check('frontend: secret-typed fields render as password inputs, not plain text', () => {
  assert.match(frontend, /input\.type = f\.secret \? 'password' : 'text';/);
});

check('frontend: an already-saved secret shows a non-alarming "leave blank to keep" hint instead of echoing the value', () => {
  assert.match(frontend, /Already saved -- leave blank to keep it, or enter a new value to replace it\./);
});

check('frontend: the save handler does not treat a blank already-saved secret field as "missing"', () => {
  assert.match(frontend, /var keepsSavedSecret = !!\(f\.secret && !val && Array\.isArray\(entry\.savedSecretFields\) && entry\.savedSecretFields\.indexOf\(f\.name\) !== -1\);/);
  assert.match(frontend, /if \(f\.required && !val && !keepsSavedSecret\) missing\.push\(f\.label\);/);
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
