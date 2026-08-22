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

check('dispatch wiring: resource=connection_transition POST routes to handleConnectionTransitionPost', () => {
  assert.match(
    raw,
    /if \(resource === 'connection_transition' && req\.method === 'POST'\) \{\s*return await handleConnectionTransitionPost\(req, res\);\s*\}/
  );
});

check('resource-list error string mentions connection_transition (POST)', () => {
  const errLine = raw.split('\n').find((l) => l.includes('resource must be one of:'));
  assert.ok(errLine, 'expected to find the resource-list error string');
  assert.match(errLine, /connection_transition \(POST\)/);
});

check('sql/053 migration is additive: extends the state CHECK constraint without dropping any of the original 6 values', () => {
  const sql = fs.readFileSync('sql/053_marketing_connection_state_extend.sql', 'utf8');
  const originalSix = ['not_connected', 'setup_incomplete', 'reporting_verified', 'draft_validated', 'launch_enabled', 'needs_attention'];
  const newFour = ['needs_reauth', 'policy_blocked', 'billing_blocked', 'external_approval_pending'];
  for (const v of [...originalSix, ...newFour]) {
    assert.match(sql, new RegExp("'" + v + "'"), `expected sql/053 to include '${v}'`);
  }
  assert.match(sql, /drop constraint if exists marketing_platform_connections_state_check/);
});

// ---------- vm-extraction of the Phase 15 connections state-machine block ----------

const startMarker = '// ---------- Universal Connections state machine (Phase 15) ----------';
const endMarker = '// ---------- Campaign management: delete / rename / duplicate / activity / scheduled sends ----------';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
assert.ok(startIdx !== -1, 'expected to find the Phase 15 connections state-machine block start marker');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the Campaign management block after the Phase 15 block');
const blockSrc = raw.slice(startIdx, endIdx);

check('CONNECTION_STATES on this branch is exactly the 10-state honest enum (6 original + 4 new)', () => {
  assert.match(blockSrc, /'not_connected', 'setup_incomplete', 'reporting_verified', 'draft_validated',/);
  assert.match(blockSrc, /'launch_enabled', 'needs_attention', 'needs_reauth', 'policy_blocked',/);
  assert.match(blockSrc, /'billing_blocked', 'external_approval_pending',/);
});

check('not_connected can only ever move to setup_incomplete -- no skipping the connect step', () => {
  assert.match(blockSrc, /not_connected: new Set\(\['setup_incomplete'\]\),/);
});

check('issue states (needs_reauth/policy_blocked/billing_blocked/external_approval_pending) all recover through setup_incomplete or disconnect, not by resuming mid-flow', () => {
  assert.match(blockSrc, /const RECOVERY_TARGETS = new Set\(\['setup_incomplete', 'not_connected'\]\);/);
  assert.match(blockSrc, /needs_reauth: new Set\(RECOVERY_TARGETS\),/);
  assert.match(blockSrc, /policy_blocked: new Set\(RECOVERY_TARGETS\),/);
  assert.match(blockSrc, /billing_blocked: new Set\(RECOVERY_TARGETS\),/);
  assert.match(blockSrc, /external_approval_pending: new Set\(RECOVERY_TARGETS\),/);
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
  const mockAccounts = [{ key: 'google_ads', label: 'Google Ads', state: 'setup_incomplete' }];
  const setupAccountsShape = async () => mockAccounts;
  const supabaseRequest = async (path, opts) => {
    calls.push({ path, opts });
    if (!opts) {
      // the exists-check GET
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
    console,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return { sandbox, calls };
}

// ---------- functional: isValidConnectionTransition ----------

check('functional: not_connected -> setup_incomplete is a legal transition', () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.isValidConnectionTransition('not_connected', 'setup_incomplete'), true);
});

check('functional: not_connected -> launch_enabled is rejected -- cannot skip the whole flow', () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.isValidConnectionTransition('not_connected', 'launch_enabled'), false);
  assert.equal(sandbox.isValidConnectionTransition('not_connected', 'reporting_verified'), false);
  assert.equal(sandbox.isValidConnectionTransition('not_connected', 'draft_validated'), false);
});

check('functional: setup_incomplete -> reporting_verified allowed, but setup_incomplete -> launch_enabled rejected -- must pass through draft_validated first', () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.isValidConnectionTransition('setup_incomplete', 'reporting_verified'), true);
  assert.equal(sandbox.isValidConnectionTransition('setup_incomplete', 'launch_enabled'), false);
});

check('functional: reporting_verified -> draft_validated -> launch_enabled is the real happy path', () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.isValidConnectionTransition('reporting_verified', 'draft_validated'), true);
  assert.equal(sandbox.isValidConnectionTransition('draft_validated', 'launch_enabled'), true);
});

check('functional: launch_enabled can regress to an issue state (something broke after going live)', () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.isValidConnectionTransition('launch_enabled', 'needs_reauth'), true);
  assert.equal(sandbox.isValidConnectionTransition('launch_enabled', 'policy_blocked'), true);
  assert.equal(sandbox.isValidConnectionTransition('launch_enabled', 'billing_blocked'), true);
});

check('functional: needs_reauth cannot resume mid-flow -- only recovers through setup_incomplete or disconnect', () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.isValidConnectionTransition('needs_reauth', 'setup_incomplete'), true);
  assert.equal(sandbox.isValidConnectionTransition('needs_reauth', 'not_connected'), true);
  assert.equal(sandbox.isValidConnectionTransition('needs_reauth', 'reporting_verified'), false);
  assert.equal(sandbox.isValidConnectionTransition('needs_reauth', 'launch_enabled'), false);
});

// ---------- functional: handleConnectionTransitionPost ----------

function makeReqRes(body) {
  let statusCode = null;
  let json = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { json = obj; return this; },
  };
  return { req: { body }, res, getStatus: () => statusCode, getJson: () => json };
}

check('functional: brand-new platform (no existing row) transitions not_connected -> setup_incomplete via POST insert', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: null });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'google_ads', toState: 'setup_incomplete' });
  await sandbox.handleConnectionTransitionPost(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getJson().ok, true);
  assert.equal(getJson().fromState, 'not_connected');
  assert.equal(getJson().toState, 'setup_incomplete');
  const writeCall = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(writeCall, 'expected an insert (POST) call for a brand-new platform row');
});

check('functional: existing setup_incomplete row moves to reporting_verified via PATCH, sets last_verified_at, clears last_error', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: { state: 'setup_incomplete', last_verified_at: null } });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'google_ads', toState: 'reporting_verified' });
  await sandbox.handleConnectionTransitionPost(req, res);
  assert.equal(getStatus(), 200);
  const writeCall = calls.find((c) => c.opts && c.opts.method === 'PATCH');
  assert.ok(writeCall, 'expected a PATCH call for an existing row');
  const payload = JSON.parse(writeCall.opts.body);
  assert.equal(payload.state, 'reporting_verified');
  assert.ok(payload.last_verified_at, 'expected last_verified_at to be set on a verified-state transition');
  assert.equal(payload.last_error, null);
});

check('functional: launch_enabled row moving to policy_blocked sets last_error from the note and preserves the prior last_verified_at', async () => {
  const priorVerifiedAt = '2026-01-01T00:00:00.000Z';
  const { sandbox, calls } = makeSandbox({ existingRow: { state: 'launch_enabled', last_verified_at: priorVerifiedAt } });
  const { req, res, getJson } = makeReqRes({ platform: 'google_ads', toState: 'policy_blocked', note: 'Ad account suspended for policy violation.' });
  await sandbox.handleConnectionTransitionPost(req, res);
  assert.equal(getJson().ok, true);
  const writeCall = calls.find((c) => c.opts && c.opts.method === 'PATCH');
  const payload = JSON.parse(writeCall.opts.body);
  assert.equal(payload.state, 'policy_blocked');
  assert.equal(payload.last_error, 'Ad account suspended for policy violation.');
  assert.equal(payload.last_verified_at, priorVerifiedAt);
});

check('functional: an illegal transition (not_connected -> launch_enabled) returns 409 and never writes', async () => {
  const { sandbox, calls } = makeSandbox({ existingRow: null });
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'google_ads', toState: 'launch_enabled' });
  await sandbox.handleConnectionTransitionPost(req, res);
  assert.equal(getStatus(), 409);
  assert.equal(getJson().ok, false);
  assert.equal(getJson().fromState, 'not_connected');
  const writeCall = calls.find((c) => c.opts && (c.opts.method === 'PATCH' || c.opts.method === 'POST'));
  assert.equal(writeCall, undefined, 'an illegal transition must never write to marketing_platform_connections');
});

check('functional: unknown platform is rejected with 400', async () => {
  const { sandbox } = makeSandbox();
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'not_a_real_platform', toState: 'setup_incomplete' });
  await sandbox.handleConnectionTransitionPost(req, res);
  assert.equal(getStatus(), 400);
  assert.equal(getJson().ok, false);
});

check('functional: unknown toState is rejected with 400', async () => {
  const { sandbox } = makeSandbox();
  const { req, res, getStatus, getJson } = makeReqRes({ platform: 'google_ads', toState: 'super_connected' });
  await sandbox.handleConnectionTransitionPost(req, res);
  assert.equal(getStatus(), 400);
  assert.equal(getJson().ok, false);
});

check('functional: a successful transition returns the real accounts array from setupAccountsShape', async () => {
  const { sandbox } = makeSandbox({ existingRow: null });
  const { req, res, getJson } = makeReqRes({ platform: 'google_ads', toState: 'setup_incomplete' });
  await sandbox.handleConnectionTransitionPost(req, res);
  assert.deepEqual(getJson().accounts, [{ key: 'google_ads', label: 'Google Ads', state: 'setup_incomplete' }]);
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
