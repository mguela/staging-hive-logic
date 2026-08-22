// Ready for You -- AI copy regeneration slice. Adds a real
// campaign_regenerate_copy endpoint that drafts fresh subject/body copy for
// a still-draft campaign via the already-configured anthropicMkt client,
// grounded in the campaign's real type/name plus (when available) one real
// sample recipient's real facts -- reusing the same candidate-query
// functions ccApprove() already calls for its send-preview sample. Never
// fabricates a name/job/dollar figure not present in real data.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const marketingPath = 'api/marketing.js';
const htmlPath = 'public/marketing-command-center/index.html';
const marketing = fs.readFileSync(marketingPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractInlineScript() {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('marketing.js syntax is valid', () => {
  execFileSync(process.execPath, ['--check', marketingPath]);
});

check('resource=campaign_regenerate_copy is wired into the dispatch chain right after campaign_send', () => {
  const idx = marketing.indexOf("resource === 'campaign_send'");
  const chunk = marketing.slice(idx, idx + 400);
  assert.match(chunk, /resource === 'campaign_regenerate_copy' && req\.method === 'POST'/);
  assert.match(chunk, /return await handleCampaignRegenerateCopyPost\(req, res\);/);
});

check('the resource-list error string documents campaign_regenerate_copy (POST)', () => {
  assert.match(marketing, /campaign_regenerate_copy \(POST\)/);
});

function extractRegenerateSource() {
  const start = marketing.indexOf('const CAMPAIGN_TYPE_TO_OPP_KEY');
  const end = marketing.indexOf('// ---------- Content Studio: real photo-backed job list + AI-drafted post copy ----------');
  assert.ok(start > -1 && end > start);
  return marketing.slice(start, end);
}

function loadRealHandler(fixtures) {
  const fnSrc = extractRegenerateSource();
  const candidatesByKey = fixtures.candidatesByKey || {};
  const sandbox = {
    anthropicMkt: fixtures.anthropicMkt !== undefined ? fixtures.anthropicMkt : {
      messages: {
        create: async () => fixtures.anthropicResponse || { content: [{ type: 'text', text: JSON.stringify({ subject: 'Hi', body: 'Body' }) }] },
      },
    },
    supabaseRequest: async (path) => {
      if (path.startsWith('campaigns?')) {
        return {
          ok: fixtures.campaignLookupOk !== false,
          text: async () => 'lookup failed',
          json: async () => (fixtures.campaign ? [fixtures.campaign] : []),
        };
      }
      throw new Error('unexpected supabaseRequest path: ' + path);
    },
    getReviewRequestCandidates: async () => candidatesByKey.review_requests || { candidates: [] },
    getUnsoldEstimateCandidates: async () => candidatesByKey.unsold_estimates || { candidates: [] },
    getReactivationCandidates: async () => candidatesByKey.reactivate_customers || { candidates: [] },
    getSeasonalCandidates: async () => candidatesByKey.seasonal_promotion || { candidates: [] },
    encodeURIComponent,
    process: { env: {} },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return { handler: sandbox.handleCampaignRegenerateCopyPost, sandbox };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

check('returns 409 honestly when ANTHROPIC_API_KEY is not configured (anthropicMkt is null) -- never fabricates copy anyway', async () => {
  const { handler } = loadRealHandler({ anthropicMkt: null });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-1' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /ANTHROPIC_API_KEY/);
});

check('requires campaignId', async () => {
  const { handler } = loadRealHandler({});
  const res = fakeRes();
  await handler({ body: {} }, res);
  assert.strictEqual(res.statusCode, 400);
});

check('404s when the campaign does not exist', async () => {
  const { handler } = loadRealHandler({ campaign: null });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-missing' } }, res);
  assert.strictEqual(res.statusCode, 404);
});

check('409s when the campaign is not a draft -- copy can only be regenerated pre-send', async () => {
  const { handler } = loadRealHandler({ campaign: { id: 'camp-1', name: 'Spring push', type: 'seasonal', channel: 'email', status: 'active' } });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-1' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error, /already "active"/);
});

check('grounds the AI prompt in a real sample recipient for a mapped campaign type, never a fabricated one', async () => {
  let capturedPrompt = null;
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-2', name: 'Unsold estimate follow-up', type: 'estimate_recovery', channel: 'email', status: 'draft' },
    candidatesByKey: {
      unsold_estimates: { candidates: [{ clientId: 'c1', clientName: 'Jane Homeowner', quoteTitle: 'Kitchen remodel', quoteTotal: 12500 }] },
    },
    anthropicMkt: {
      messages: {
        create: async (opts) => {
          capturedPrompt = opts.messages[0].content;
          return { content: [{ type: 'text', text: JSON.stringify({ subject: 'Still thinking it over?', body: 'Hi {{clientName}}, about your {{quoteTitle}} quote...' }) }] };
        },
      },
    },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-2' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.usedRealSample, true);
  assert.match(capturedPrompt, /Jane Homeowner/, 'prompt must include the real sample client name');
  assert.match(capturedPrompt, /Kitchen remodel/, 'prompt must include the real sample job/quote fact');
  assert.match(capturedPrompt, /never invent a client name, job detail, or dollar figure/i);
  assert.match(capturedPrompt, /keep them as literal placeholders/i, 'must instruct the AI not to substitute merge fields itself');
  assert.strictEqual(res.body.subject, 'Still thinking it over?');
  assert.match(res.body.body, /\{\{clientName\}\}/, 'returned body should preserve merge-field placeholders');
});

check('honestly reports no real sample when the campaign type has no candidates yet, without fabricating one', async () => {
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-3', name: 'Reactivate past customers', type: 'reactivation', channel: 'email', status: 'draft' },
    candidatesByKey: { reactivate_customers: { candidates: [] } },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-3' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.usedRealSample, false);
});

check('a custom campaign type (no opportunity-key mapping) skips candidate lookup entirely and still succeeds', async () => {
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-4', name: 'One-off announcement', type: 'custom', channel: 'email', status: 'draft' },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-4' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.usedRealSample, false);
});

check('502s when the AI response is not valid JSON, rather than guessing at subject/body', async () => {
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-5', name: 'Seasonal', type: 'seasonal', channel: 'email', status: 'draft' },
    anthropicMkt: { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json at all' }] }) } },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-5' } }, res);
  assert.strictEqual(res.statusCode, 502);
});

check('502s when the AI JSON is missing subject/body keys', async () => {
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-6', name: 'Seasonal', type: 'seasonal', channel: 'email', status: 'draft' },
    anthropicMkt: { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ subject: 'Only subject' }) }] }) } },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-6' } }, res);
  assert.strictEqual(res.statusCode, 502);
});

// ---------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------

check('the main inline script is still syntactically valid JavaScript after the Regenerate button insertion', () => {
  new vm.Script(extractInlineScript(), { filename: htmlPath });
});

check('ccApprove\'s modal has a Regenerate copy button that calls campaign_regenerate_copy and refreshes the subject/body/preview', () => {
  const start = html.indexOf('function ccApprove');
  const end = html.indexOf('\n  // ---------- Your Plan', start);
  const fn = html.slice(start, end > -1 ? end : undefined);
  assert.match(fn, /regenBtn\.textContent = 'Regenerate copy with AI';/);
  assert.match(fn, /api\('campaign_regenerate_copy', \{ method: 'POST', body: JSON\.stringify\(\{ campaignId: campaignId \}\) \}\)/);
  assert.match(fn, /subjInput\.value = d\.subject;/);
  assert.match(fn, /bodyInput\.value = d\.body;/);
  assert.match(fn, /renderPreview\(\);/);
});

check('no scratch/temp files leaked into the tracked source files', () => {
  assert.doesNotMatch(marketing, /scratch_/);
  assert.doesNotMatch(html, /scratch_/);
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
