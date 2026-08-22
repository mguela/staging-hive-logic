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

check('resource-list error string mentions connector_catalog (GET)', () => {
  const errLine = raw.split('\n').find((l) => l.includes('resource must be one of:'));
  assert.ok(errLine, 'expected to find the resource-list error string');
  assert.match(errLine, /connector_catalog \(GET\)/);
});

// ---------- vm-extraction of the Phase 15 connector catalog block ----------

const startMarkerMatch = raw.match(/\/\/ ----------.*connector catalog.*\(Phase 15\) ----------/); // relaxed: sibling add-account-ui branch prefixes this header line with its own text once merged
const startMarker = startMarkerMatch ? startMarkerMatch[0] : '// ---------- Universal Connections: connector catalog (Phase 15) ----------';
const endMarker = '// ---------- Campaign management: delete / rename / duplicate / activity / scheduled sends ----------';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find the Phase 15 connector catalog block start marker');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the Campaign management block after the Phase 15 block');
const blockSrc = raw.slice(startIdx, endIdx);

check('OAuth-type platforms declare zero fields -- nothing to render but the Connect button', () => {
  assert.match(blockSrc, /google_ads: \{ authMethod: 'oauth', fields: \[\] \},/);
  assert.match(blockSrc, /meta_ads: \{ authMethod: 'oauth', fields: \[\] \},/);
});

check('website_cms declares a real dynamic field set (cmsPlatform/siteUrl/apiKey), not just an OAuth button', () => {
  assert.match(blockSrc, /website_cms: \{/);
  assert.match(blockSrc, /authMethod: 'api_key',/);
  assert.match(blockSrc, /name: 'cmsPlatform'/);
  assert.match(blockSrc, /name: 'siteUrl'/);
  assert.match(blockSrc, /name: 'apiKey'/);
});

function makeSandbox({ accounts = [] } = {}) {
  const CHANNEL_LABELS = {
    sms: 'SMS', google_ads: 'Google Ads', meta_ads: 'Meta (Facebook/Instagram)',
    google_business_profile: 'Google Business Profile', website_cms: 'Website / CMS',
    ga4: 'Google Analytics 4', gtm: 'Google Tag Manager', search_console: 'Search Console',
    youtube: 'YouTube', facebook_instagram: 'Facebook Page / Instagram', microsoft_ads: 'Microsoft Ads',
    linkedin: 'LinkedIn', tiktok: 'TikTok', direct_mail: 'Direct Mail',
  };
  const SETUP_ACCOUNT_PLATFORMS = new Set(['email', ...Object.keys(CHANNEL_LABELS)]);
  const setupAccountsShape = async () => accounts;
  const sandbox = {
    setupAccountsShape,
    SETUP_ACCOUNT_PLATFORMS,
    CHANNEL_LABELS,
    Map,
    Set,
    console,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return { sandbox };
}

function makeReqRes() {
  let statusCode = null;
  let json = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { json = obj; return this; },
  };
  return { req: {}, res, getStatus: () => statusCode, getJson: () => json };
}

check('functional: a platform with no stored row defaults to not_connected and alreadyActive=false', async () => {
  const { sandbox } = makeSandbox({ accounts: [] });
  const catalog = await sandbox.connectorCatalogShape();
  const googleAds = catalog.find((c) => c.key === 'google_ads');
  assert.ok(googleAds, 'expected google_ads in the catalog');
  assert.equal(googleAds.state, 'not_connected');
  assert.equal(googleAds.alreadyActive, false);
  assert.equal(googleAds.authMethod, 'oauth');
});

check('functional: a platform with any real state past not_connected is alreadyActive=true', async () => {
  const { sandbox } = makeSandbox({ accounts: [{ key: 'google_ads', state: 'setup_incomplete' }] });
  const catalog = await sandbox.connectorCatalogShape();
  const googleAds = catalog.find((c) => c.key === 'google_ads');
  assert.equal(googleAds.state, 'setup_incomplete');
  assert.equal(googleAds.alreadyActive, true);
});

check('functional: catalog includes every SETUP_ACCOUNT_PLATFORMS entry (email + all 14 channels), none missing', async () => {
  const { sandbox } = makeSandbox({ accounts: [] });
  const catalog = await sandbox.connectorCatalogShape();
  assert.equal(catalog.length, 15);
  const keys = new Set(catalog.map((c) => c.key));
  assert.ok(keys.has('email'));
  assert.ok(keys.has('google_ads'));
  assert.ok(keys.has('direct_mail'));
});

check('functional: handleConnectorCatalogGet returns both the full catalog and an available (not-yet-active) subset', async () => {
  const { sandbox } = makeSandbox({ accounts: [{ key: 'google_ads', state: 'launch_enabled' }, { key: 'meta_ads', state: 'not_connected' }] });
  const { req, res, getStatus, getJson } = makeReqRes();
  await sandbox.handleConnectorCatalogGet(req, res);
  assert.equal(getStatus(), 200);
  const body = getJson();
  assert.equal(body.ok, true);
  assert.equal(body.catalog.length, 15);
  const availableKeys = body.available.map((c) => c.key);
  assert.ok(!availableKeys.includes('google_ads'), 'an already-active platform must not appear in available');
  assert.ok(availableKeys.includes('meta_ads'), 'a not-yet-connected platform must appear in available');
});

check('functional: website_cms exposes its declared fields end to end through the real handler', async () => {
  const { sandbox } = makeSandbox({ accounts: [] });
  const { req, res, getJson } = makeReqRes();
  await sandbox.handleConnectorCatalogGet(req, res);
  const cms = getJson().catalog.find((c) => c.key === 'website_cms');
  assert.equal(cms.authMethod, 'api_key');
  assert.equal(cms.fields.length, 3);
  const fieldNames = JSON.parse(JSON.stringify(cms.fields.map((f) => f.name)));
  assert.deepEqual(fieldNames, ['cmsPlatform', 'siteUrl', 'apiKey']);
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
