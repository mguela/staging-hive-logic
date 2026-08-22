import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 19 (test coverage): checkCampaignEligibility is the exact
// enforcement function api/marketing.js's own header comment says was added
// after a real audit found the hero "Build Campaign" button could create a
// zero-recipient email campaign for Neighborhood Expansion, even though the
// Opportunities list already marked that audience non-actionable in the UI.
// The header comment explains both computeNeighborhoodExpansion()
// (advisory-only) and handleCampaignsPost() (enforced) now read from the
// same OPPORTUNITY_ELIGIBILITY map "so they can never drift apart" -- this
// file is the real-invocation proof that the enforcement side of that
// contract actually behaves correctly, since (per the file's own history)
// this exact class of gap previously shipped undetected.

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// Robust against destructured-parameter signatures (e.g.
// `function foo({ a, b }) {`), where the first "{" after the declaration is
// the parameter destructure, not the function body -- anchor on the "{"
// that immediately follows the parameter list's closing ")" instead.
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

check('sanity: checkCampaignEligibility is declared exactly once in the real file', () => {
  const re = /function checkCampaignEligibility\s*\(/g;
  const matches = raw.match(re) || [];
  assert.equal(matches.length, 1, `expected exactly one declaration, found ${matches.length}`);
});

const eligibilitySrc = extractConstObject(raw, 'const OPPORTUNITY_ELIGIBILITY =');
const checkEligibilitySrc = extractFunction(raw, 'function checkCampaignEligibility(');

check('sanity: extraction actually captured a real function body, not just the destructured parameter list', () => {
  assert.match(checkEligibilitySrc, /return \{ eligible: true, reason: null, requiredIntegration: null \};/);
});

const blockSrc = [eligibilitySrc, checkEligibilitySrc].join('\n\n');

function makeSandbox() {
  const sandbox = { console, Error, Object };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

check('real invocation: the exact historical bug is now blocked -- neighborhood_expansion email campaign is refused even with a nonzero recipientCount', () => {
  const sandbox = makeSandbox();
  const result = sandbox.checkCampaignEligibility({ opportunityKey: 'neighborhood_expansion', channel: 'email', recipientCount: 500 });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /geographic areas, not existing-customer contacts/);
  assert.equal(result.requiredIntegration, 'google_ads_or_meta_ads_or_direct_mail');
});

// Phase 19 follow-up (test coverage fix): a real recipient source has since
// been wired up for referral_opportunities -- OPPORTUNITY_ELIGIBILITY now
// marks it emailEligible:true with no requiredIntegration gate. This check
// is updated to match the real, current behavior instead of the stale
// not-wired-up assumption it was authored under.
check('real invocation: referral_opportunities email campaign is now eligible (real recipient source has been wired up)', () => {
  const sandbox = makeSandbox();
  const result = sandbox.checkCampaignEligibility({ opportunityKey: 'referral_opportunities', channel: 'email', recipientCount: 500 });
  assert.equal(result.eligible, true);
});

check('real invocation: an eligible opportunity type with a real nonzero recipient count is allowed', () => {
  const sandbox = makeSandbox();
  const result = sandbox.checkCampaignEligibility({ opportunityKey: 'unsold_estimates', channel: 'email', recipientCount: 42 });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
  assert.equal(result.requiredIntegration, null);
});

check('real invocation: an eligible opportunity type with ZERO recipients is still refused -- the generic no-recipients guard, independent of the opportunity-type guard', () => {
  const sandbox = makeSandbox();
  const result = sandbox.checkCampaignEligibility({ opportunityKey: 'unsold_estimates', channel: 'email', recipientCount: 0 });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /no recipients yet/);
});

check('real invocation: a non-email channel bypasses the recipient-count guard (guard is email-specific per the real code)', () => {
  const sandbox = makeSandbox();
  const result = sandbox.checkCampaignEligibility({ opportunityKey: 'unsold_estimates', channel: 'sms', recipientCount: 0 });
  assert.equal(result.eligible, true);
});

check('real invocation: an unknown/missing opportunityKey with a real recipient count is allowed (no rule to block it)', () => {
  const sandbox = makeSandbox();
  const result = sandbox.checkCampaignEligibility({ channel: 'email', recipientCount: 10 });
  assert.equal(result.eligible, true);
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
