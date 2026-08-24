// Referral candidates slice -- closes the gap flagged directly in
// api/marketing.js's own comments: referral_opportunities was hard-blocked
// from sending because no candidate query existed to identify who to thank/
// reward for a referral. sql/044 adds lead_pipeline.referred_by_client_id
// (additive, nullable, no backfill); api/track1.js exposes it on the leads
// API; api/marketing.js flips the eligibility flag and adds a real
// getReferralCandidates() query; index.html wires the new opportunity type
// and a "Referred by" client picker into the UI.
//
// The app-marketing.js half of this slice was deleted on 2026-08-18 -- that
// file was never loaded by any page (see the deletion commit). The backend,
// SQL and index.html coverage below is unaffected and is why this file stays.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const sqlPath = 'sql/044_lead_pipeline_referred_by.sql';
const track1Path = 'api/track1.js';
const marketingPath = 'api/marketing.js';
const htmlPath = 'public/index.html';

const sql = fs.readFileSync(sqlPath, 'utf8');
const track1 = fs.readFileSync(track1Path, 'utf8');
const marketing = fs.readFileSync(marketingPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractMainInlineScript() {
  const idx = html.indexOf('rlmReferredByPick');
  assert.ok(idx > -1, 'expected rlmReferredByPick to exist in public/index.html');
  const start = html.lastIndexOf('<script>', idx) + '<script>'.length;
  const end = html.indexOf('</script>', idx);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

// ---------------------------------------------------------------------
// sql/044
// ---------------------------------------------------------------------

check('sql/044 is additive-only: nullable column with no backfill/default, plus a partial index', () => {
  assert.match(sql, /alter table lead_pipeline\s*\n\s*add column if not exists referred_by_client_id text references clients\(jobber_id\) on delete set null;/);
  const alterLine = sql.match(/add column[^\n]*\n/)[0];
  assert.doesNotMatch(alterLine, /not null/i, 'the new column must be nullable -- no NOT NULL constraint');
  assert.doesNotMatch(sql, /\bdefault\b/i);
  assert.doesNotMatch(sql, /\bupdate\s+lead_pipeline\b/i);
  assert.match(sql, /create index if not exists lead_pipeline_referred_by_idx\s*\n\s*on lead_pipeline\(referred_by_client_id\)\s*\n\s*where referred_by_client_id is not null;/);
});

// ---------------------------------------------------------------------
// api/track1.js
// ---------------------------------------------------------------------

check('track1.js syntax is valid', () => {
  // track1.js uses ES module import statements, so vm.Script (non-module) can't
  // parse the whole file -- shell out to node --check instead, same as used
  // manually to validate this file during the slice.
  execFileSync(process.execPath, ['--check', track1Path]);
});

check('GET leads maps referred_by_client_id to referredByClientId', () => {
  assert.match(track1, /referredByClientId: p\.referred_by_client_id \|\| null,/);
});

check('POST create writes referred_by_client_id from the request body, trimmed, or null', () => {
  assert.match(track1, /referred_by_client_id: b\.referredByClientId \? String\(b\.referredByClientId\)\.trim\(\) : null,/);
});

check('PATCH only touches referred_by_client_id when the field is explicitly present in the request body', () => {
  assert.match(track1, /if \(b\.referredByClientId !== undefined\) patch\.referred_by_client_id = b\.referredByClientId \? String\(b\.referredByClientId\)\.trim\(\) : null;/);
});

// ---------------------------------------------------------------------
// api/marketing.js
// ---------------------------------------------------------------------

check('marketing.js syntax is valid', () => {
  // Same reason as track1.js -- marketing.js is an ES module.
  execFileSync(process.execPath, ['--check', marketingPath]);
});

check('referral_opportunities is now email-eligible with no lingering blocked reason/requiredIntegration', () => {
  const idx = marketing.indexOf('referral_opportunities:');
  const chunk = marketing.slice(idx, idx + 200);
  assert.match(chunk, /referral_opportunities:\s*\{\s*emailEligible:\s*true\s*\}/);
});

check('handleOpportunityCandidatesGet dispatches referral_opportunities to getReferralCandidates', () => {
  assert.match(marketing, /else if \(key === 'referral_opportunities'\) result = await getReferralCandidates\(limit\);/);
});

function loadRealGetReferralCandidates(fixtures) {
  const start = marketing.indexOf('async function getReferralCandidates');
  assert.ok(start > -1, 'expected getReferralCandidates to exist');
  const end = marketing.indexOf('\nasync function', start + 30);
  assert.ok(end > start);
  const fnSrc = marketing.slice(start, end);
  const sandbox = {
    fetchAllRows: async (table) => {
      if (table === 'lead_pipeline') return fixtures.leads || [];
      if (table === 'clients') return fixtures.clients || [];
      throw new Error('unexpected table ' + table);
    },
    Math, Date, Map,
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox.getReferralCandidates;
}

check('getReferralCandidates only queries lead_pipeline rows with a real referred_by_client_id set', () => {
  const start = marketing.indexOf('async function getReferralCandidates');
  const end = marketing.indexOf('\nasync function', start + 30);
  const fn = marketing.slice(start, end);
  assert.match(fn, /fetchAllRows\('lead_pipeline', '\?select=client_id,estimated_value,created_at,referred_by_client_id&referred_by_client_id=not\.is\.null'\)/);
});

check('getReferralCandidates aggregates real referral counts/value per referrer and filters to real emails only', async () => {
  const getReferralCandidates = loadRealGetReferralCandidates({
    leads: [
      { client_id: 'lead-a', estimated_value: 5000, created_at: '2026-07-01T00:00:00Z', referred_by_client_id: 'cust-1' },
      { client_id: 'lead-b', estimated_value: 3000, created_at: '2026-07-15T00:00:00Z', referred_by_client_id: 'cust-1' },
      { client_id: 'lead-c', estimated_value: 2000, created_at: '2026-07-10T00:00:00Z', referred_by_client_id: 'cust-2' },
      { client_id: 'lead-d', estimated_value: 1000, created_at: '2026-07-20T00:00:00Z', referred_by_client_id: 'cust-3' },
    ],
    clients: [
      { jobber_id: 'cust-1', name: 'Alice Homeowner', first_name: 'Alice', last_name: 'Homeowner', email: 'alice@example.com' },
      { jobber_id: 'cust-2', name: 'Bob NoEmail', first_name: 'Bob', last_name: 'NoEmail', email: null },
      // cust-3 has no client row at all (orphaned/deleted client) -- must be excluded, never fabricated
    ],
  });
  const result = await getReferralCandidates(500);
  assert.strictEqual(result.candidates.length, 1, 'only cust-1 has a real email and a real client row');
  const c = result.candidates[0];
  assert.strictEqual(c.clientId, 'cust-1');
  assert.strictEqual(c.email, 'alice@example.com');
  assert.strictEqual(c.referredCount, 2);
  assert.strictEqual(c.referredEstimatedValue, 8000);
  assert.strictEqual(c.clientName, 'Alice Homeowner');
  assert.strictEqual(result.totalEligible, 1);
  assert.strictEqual(result.hasMore, false);
});

check('getReferralCandidates sorts by most-recent referral first and respects the cap/hasMore contract', async () => {
  const leads = [];
  const clients = [];
  for (let i = 0; i < 5; i++) {
    leads.push({ client_id: `lead-${i}`, estimated_value: 100, created_at: `2026-07-0${i + 1}T00:00:00Z`, referred_by_client_id: `cust-${i}` });
    clients.push({ jobber_id: `cust-${i}`, name: `Customer ${i}`, email: `c${i}@example.com` });
  }
  const getReferralCandidates = loadRealGetReferralCandidates({ leads, clients });
  const result = await getReferralCandidates(3);
  assert.strictEqual(result.cap, 3);
  assert.strictEqual(result.candidates.length, 3);
  assert.strictEqual(result.totalEligible, 5);
  assert.strictEqual(result.hasMore, true);
  assert.strictEqual(result.candidates[0].clientId, 'cust-4', 'most recently-created referral should sort first');
});

check('getReferralCandidates returns an honest empty shape (never fabricated data) when no referrals exist yet', async () => {
  const getReferralCandidates = loadRealGetReferralCandidates({ leads: [], clients: [] });
  const result = await getReferralCandidates(500);
  // result.candidates is an Array constructed inside a separate vm context, so
  // it's not `instanceof` this realm's Array -- compare fields/values directly
  // instead of a whole-object deepStrictEqual across realms.
  assert.strictEqual(result.candidates.length, 0);
  assert.strictEqual(result.totalEligible, 0);
  assert.strictEqual(result.cap, 500);
  assert.strictEqual(result.hasMore, false);
});

// ---------------------------------------------------------------------
// public/index.html
// ---------------------------------------------------------------------

check('the main inline script is still syntactically valid JavaScript after the picker insertion', () => {
  new vm.Script(extractMainInlineScript(), { filename: htmlPath });
});

check('the Lead modal has a Referred By field with a hidden id input and a live search input', () => {
  assert.match(html, /<label>REFERRED BY \(IF A REFERRAL\)<\/label>/);
  assert.match(html, /<input type="hidden" id="rlm-referredby-id">/);
  assert.match(html, /id="rlm-referredby-search"[^>]*oninput="rlmReferredBySearch\(this\.value\)"/);
  assert.doesNotMatch(html, /placeholder="Type an existing customer\\'s name/, 'must not contain a stray literal backslash before the apostrophe');
});

check('rlmReferredBySearch reuses the proven REAL_CLIENTS live-filter pattern and escapes id/name before embedding in onclick', () => {
  const start = html.indexOf('function rlmReferredBySearch');
  const end = html.indexOf('function rlmReferredByPick', start);
  const fn = html.slice(start, end);
  // Was /REAL_CLIENTS\[i\]/, which pinned the hand-rolled scan loop rather than
  // the property. That loop was replaced on 2026-08-23 by hlRankClients, which
  // ranks name above company above email and scans the whole book before
  // capping -- the flat scan surfaced everyone carrying lori@... ahead of the
  // client actually named Lori, and stopped at 20 before ever reaching her.
  // The property this guards is unchanged: it must read the REAL client list.
  assert.match(fn, /hlRankClients\(REAL_CLIENTS/, 'must filter over the real client list, not a fabricated one');
  // idA/nameA must each be escaped (backslash-escape then quote-escape) before
  // being embedded in an onclick="..." HTML attribute, exactly like the
  // proven efClientSearch/efClientPick pattern this was derived from.
  assert.match(fn, /var idA=String\(c\.id\)\.replace\(/, 'idA must be derived from a real client id');
  assert.match(fn, /var nameA=String\(c\.name\|\|'\(unnamed\)'\)\.replace\(/, 'nameA must be derived from a real client name, never fabricated');
  const idAEscapeCount = (fn.match(/var idA=String\(c\.id\)\.replace\(\/[^/]+\/g,[^)]+\)\.replace\(\/'\/g,[^)]+\)/g) || []).length;
  assert.strictEqual(idAEscapeCount, 1, 'idA must escape both backslashes and single quotes');
  const nameAEscapeCount = (fn.match(/var nameA=String\(c\.name\|\|'\(unnamed\)'\)\.replace\(\/[^/]+\/g,[^)]+\)\.replace\(\/'\/g,[^)]+\)/g) || []).length;
  assert.strictEqual(nameAEscapeCount, 1, 'nameA must escape both backslashes and single quotes');
  assert.match(fn, /onclick="rlmReferredByPick\(/, 'the picker row must call rlmReferredByPick from its onclick attribute');
  assert.match(fn, /\+idA\+/, 'onclick must interpolate the escaped idA');
  assert.match(fn, /\+nameA\+/, 'onclick must interpolate the escaped nameA');
});

check('rlmReferredByPick sets both hidden id and visible search value, and hides the results box', () => {
  const start = html.indexOf('function rlmReferredByPick');
  const end = html.indexOf('\n}', start) + 2;
  const fn = html.slice(start, end);
  assert.match(fn, /document\.getElementById\('rlm-referredby-id'\)\.value = id;/);
  assert.match(fn, /document\.getElementById\('rlm-referredby-search'\)\.value = name;/);
  assert.match(fn, /box\.style\.display='none'; box\.innerHTML='';/);
});

check('openRealLead populates the referred-by fields from the real lead record, never fabricating a name it cannot resolve', () => {
  // Takes a card key rather than a clientId since 2026-08-18: one client can
  // hold several opportunities, so a card is addressed by its own id. The
  // referred-by behaviour asserted below is unchanged by that.
  const start = html.indexOf('function openRealLead(key) {');
  assert.ok(start > -1, 'openRealLead signature moved -- update this anchor');
  const end = html.indexOf('\n}', start) + 2;
  const fn = html.slice(start, end);
  assert.match(fn, /var rbyId = l\.referredByClientId \|\| '';/);
  assert.match(fn, /document\.getElementById\('rlm-referredby-id'\)\.value = rbyId;/);
  assert.match(fn, /if \(rbyClient\) rbyName = rbyClient\.name \|\| '';/);
  assert.match(fn, /document\.getElementById\('rlm-referredby-search'\)\.value = rbyName \|\| \(rbyId \? '\(existing customer\)' : ''\);/);
});

check('saveRealLead includes referredByClientId (or null) in its leads PATCH payload', () => {
  const start = html.indexOf('function saveRealLead');
  const end = html.indexOf('\n}', start) + 2;
  const fn = html.slice(start, end);
  assert.match(fn, /referredByClientId: document\.getElementById\('rlm-referredby-id'\)\.value \|\| null/);
});

check('no scratch/temp files leaked into the tracked source files', () => {
  assert.doesNotMatch(html, /scratch_efclient/);
  assert.doesNotMatch(marketing, /scratch_efclient/);
});

let pass = 0, fail = 0;
const results = [];
for (const { name, fn } of checks) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      results.push(r.then(() => { pass++; console.log(`  ok  - ${name}`); }).catch((e) => { fail++; console.log(`  not ok  - ${name}\n    ${e.message}`); }));
    } else {
      pass++;
      console.log(`  ok  - ${name}`);
    }
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.message}`);
  }
}
Promise.all(results).then(() => {
  console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
  process.exit(fail ? 1 : 0);
});
