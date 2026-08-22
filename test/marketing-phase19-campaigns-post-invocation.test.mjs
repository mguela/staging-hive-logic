import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 19 (test coverage): the earlier campaign-eligibility slice this
// session proved the pure checkCampaignEligibility function blocks the
// historical zero-recipient / wrong-audience bug in isolation. This slice
// goes one level up and proves the REAL HTTP handler (handleCampaignsPost)
// actually wires that check in correctly at the point where it matters --
// before any database write happens -- and that the rest of the handler's
// real branches (duplicate-draft reuse, honest not-synced degrade, the real
// 500-recipient insert cap vs the uncapped recipientCount reported back)
// behave as the live source says they do.

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

function extractFunction(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const closeParenBrace = source.indexOf(') {', idx);
  assert.ok(closeParenBrace !== -1, `expected ") {" after "${declSnippet}"`);
  const braceStart = closeParenBrace + 2;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(lineStart, i + 1);
    }
  }
  throw new Error(`unterminated function body for "${declSnippet}"`);
}

function extractConstObject(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const braceStart = source.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        const semi = source.indexOf(';', i);
        return source.slice(lineStart, semi + 1);
      }
    }
  }
  throw new Error(`unterminated const object for "${declSnippet}"`);
}

check('sanity: handleCampaignsPost is declared exactly once in the real file', () => {
  const re = /function handleCampaignsPost\s*\(/g;
  const matches = raw.match(re) || [];
  assert.equal(matches.length, 1, `expected exactly one declaration, found ${matches.length}`);
});

const eligibilitySrc = extractConstObject(raw, 'const OPPORTUNITY_ELIGIBILITY =');
const checkEligibilitySrc = extractFunction(raw, 'function checkCampaignEligibility(');
const logActivitySrc = extractFunction(raw, 'async function logCampaignActivity(');
const logMarketingAuditEventSrc = extractFunction(raw, 'async function logMarketingAuditEvent(');
const handlerSrc = extractFunction(raw, 'async function handleCampaignsPost(');

check('sanity: the extracted handler body is real -- contains the eligibility gate call before any database write', () => {
  assert.match(handlerSrc, /checkCampaignEligibility\(\{ opportunityKey, channel, recipientCount: incomingRecipients\.length \}\)/);
});

const blockSrc = [eligibilitySrc, checkEligibilitySrc, logActivitySrc, logMarketingAuditEventSrc, handlerSrc].join('\n\n');

function makeMockSupabase(expectedCalls) {
  let i = 0;
  const callLog = [];
  const fn = async function supabaseRequest(url, opts) {
    callLog.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
    const exp = expectedCalls[i];
    assert.ok(exp, `unexpected extra supabaseRequest call #${i + 1}: ${url}`);
    i++;
    if (exp.urlIncludes) assert.ok(url.includes(exp.urlIncludes), `call ${i}: expected url to include "${exp.urlIncludes}", got "${url}"`);
    if (exp.method) assert.equal((opts && opts.method) || 'GET', exp.method, `call ${i}: method mismatch for ${url}`);
    return exp.response;
  };
  fn.callLog = callLog;
  fn.assertAllConsumed = () => assert.equal(i, expectedCalls.length, `expected ${expectedCalls.length} supabaseRequest calls, only ${i} happened`);
  return fn;
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(obj) { this._body = obj; return this; },
  };
}

function makeSandbox(expectedCalls) {
  const supa = makeMockSupabase(expectedCalls);
  const sandbox = {
    console, Error, Object, String, Array, Number, JSON, Promise, encodeURIComponent,
    supabaseRequest: supa,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return { sandbox, supa };
}

// ---------- Basic validation ----------

check('real invocation: missing name is refused with 400 before any database call', async () => {
  const { sandbox, supa } = makeSandbox([]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({ body: { type: 'custom' } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'name is required.');
  supa.assertAllConsumed();
});

check('real invocation: an invalid type is refused with 400 listing the real valid types, before any database call', async () => {
  const { sandbox, supa } = makeSandbox([]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({ body: { name: 'Test', type: 'not_a_real_type' } }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /^type must be one of: /);
  supa.assertAllConsumed();
});

// ---------- The historical bug, now blocked at the real HTTP boundary ----------

check('real invocation: the exact historical bug -- a neighborhood_expansion email campaign with real recipients -- is refused at the handler level with ZERO database calls', async () => {
  const { sandbox, supa } = makeSandbox([]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({
    body: {
      name: 'Neighborhood Push', type: 'custom', channel: 'email',
      targetFilter: { opportunityKey: 'neighborhood_expansion' },
      recipients: [{ clientId: 'C1' }, { clientId: 'C2' }],
    },
  }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.blocked, true);
  assert.match(res._body.error, /geographic areas, not existing-customer contacts/);
  assert.equal(res._body.requiredIntegration, 'google_ads_or_meta_ads_or_direct_mail');
  supa.assertAllConsumed(); // zero calls -- the block happens before any campaigns/campaign_recipients write
});

check('real invocation: an eligible opportunity type with zero recipients is still refused at the handler level, with ZERO database calls', async () => {
  const { sandbox, supa } = makeSandbox([]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({
    body: { name: 'Estimate Follow-up', type: 'estimate_recovery', channel: 'email', targetFilter: { opportunityKey: 'unsold_estimates' }, recipients: [] },
  }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.blocked, true);
  assert.match(res._body.error, /no recipients yet/);
  supa.assertAllConsumed();
});

// ---------- Real successful creation path ----------

check('real invocation: a valid, eligible campaign is created for real -- campaigns row inserted, recipients inserted, activity logged, real recipientCount returned', async () => {
  const { sandbox, supa } = makeSandbox([
    { urlIncludes: 'campaigns?type=eq.estimate_recovery', method: 'GET', response: { ok: true, json: async () => [] } },
    { urlIncludes: 'campaigns', method: 'POST', response: { ok: true, json: async () => [{ id: 'CAMP-NEW', name: 'Estimate Follow-up', type: 'estimate_recovery', channel: 'email', status: 'draft' }] } },
    { urlIncludes: 'campaign_recipients', method: 'POST', response: { ok: true, json: async () => [] } },
    { urlIncludes: 'campaign_activity_log', method: 'POST', response: { ok: true, json: async () => [] } },
  ]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({
    body: {
      name: 'Estimate Follow-up', type: 'estimate_recovery', channel: 'email',
      targetFilter: { opportunityKey: 'unsold_estimates' },
      recipients: [{ clientId: 'C1' }, { clientId: 'C2' }, { clientId: 'C3' }],
    },
    hlUser: { email: 'chris@example.com' },
  }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.campaign.id, 'CAMP-NEW');
  assert.equal(res._body.recipientCount, 3);
  supa.assertAllConsumed();
  const recipientsCall = supa.callLog.find(c => c.url === 'campaign_recipients');
  assert.equal(JSON.parse(recipientsCall.body).length, 3);
});

// ---------- Duplicate-draft reuse path ----------

check('real invocation: a second draft of the SAME non-custom type reuses the existing draft instead of creating a duplicate row', async () => {
  const { sandbox, supa } = makeSandbox([
    { urlIncludes: 'campaigns?type=eq.estimate_recovery', method: 'GET', response: { ok: true, json: async () => [{ id: 'CAMP-EXIST', name: 'Existing Draft', type: 'estimate_recovery', status: 'draft' }] } },
    { urlIncludes: 'campaign_recipients?campaign_id=eq.CAMP-EXIST', method: 'GET', response: { ok: true, json: async () => [] } },
    { urlIncludes: 'campaign_recipients', method: 'POST', response: { ok: true, json: async () => [] } },
  ]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({
    body: {
      name: 'Estimate Follow-up', type: 'estimate_recovery', channel: 'email',
      targetFilter: { opportunityKey: 'unsold_estimates' },
      recipients: [{ clientId: 'C1' }, { clientId: 'C2' }],
    },
  }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.reused, true);
  assert.equal(res._body.campaign.id, 'CAMP-EXIST');
  assert.equal(res._body.recipientCount, 2);
  supa.assertAllConsumed(); // reuse path never touches the campaigns-insert or activity-log calls
});

// ---------- Honest not-synced degrade ----------

check('real invocation: campaigns table not set up yet degrades honestly (200, ok:false, real sql file name) -- not a 500 crash', async () => {
  const { sandbox, supa } = makeSandbox([
    { urlIncludes: 'campaigns', method: 'POST', response: { ok: false, text: async () => 'relation "public.campaigns" does not exist' } },
  ]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({
    body: { name: 'Custom Blast', type: 'custom', channel: 'email', recipients: [{ clientId: 'C1' }] },
  }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, false);
  assert.match(res._body.error, /run sql\/021_campaigns\.sql in Supabase/);
  supa.assertAllConsumed();
});

// ---------- Real 500-recipient insert cap vs uncapped reported count ----------

check('real invocation: a 700-recipient submission only inserts the first 500 campaign_recipients rows, but still reports the true full recipientCount', async () => {
  const bigRecipients = Array.from({ length: 700 }, (_, i) => ({ clientId: `C${i}` }));
  const { sandbox, supa } = makeSandbox([
    { urlIncludes: 'campaigns', method: 'POST', response: { ok: true, json: async () => [{ id: 'CAMP-BIG', name: 'Custom Blast', type: 'custom', channel: 'email', status: 'draft' }] } },
    { urlIncludes: 'campaign_recipients', method: 'POST', response: { ok: true, json: async () => [] } },
    { urlIncludes: 'campaign_activity_log', method: 'POST', response: { ok: true, json: async () => [] } },
  ]);
  const res = makeRes();
  await sandbox.handleCampaignsPost({
    body: { name: 'Custom Blast', type: 'custom', channel: 'email', recipients: bigRecipients },
  }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.recipientCount, 700); // the real, true count -- not silently truncated to what was inserted
  const recipientsCall = supa.callLog.find(c => c.url === 'campaign_recipients');
  assert.equal(JSON.parse(recipientsCall.body).length, 500); // the real insert cap
  supa.assertAllConsumed();
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
    console.log(`  ${e.stack || e.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
