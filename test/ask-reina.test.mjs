// Ready for You -- Ask Reina slice. Adds a real campaign_ask_reina endpoint
// that answers a free-form owner question about one specific draft/active
// campaign, grounded only in that campaign's own real row, its real
// campaign_recipients counts (recipient/sent/responded/booked), and (when
// available) one real sample recipient -- reusing the same candidate-query
// functions ccApprove() already calls. Never fabricates a number, name, or
// outcome; honestly defers when the question asks about something the
// real facts don't cover.

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

check('resource=campaign_ask_reina is wired into the dispatch chain right after campaign_send', () => {
  const idx = marketing.indexOf("resource === 'campaign_send'");
  const chunk = marketing.slice(idx, idx + 400);
  assert.match(chunk, /resource === 'campaign_ask_reina' && req\.method === 'POST'/);
  assert.match(chunk, /return await handleCampaignAskReinaPost\(req, res\);/);
});

check('the resource-list error string documents campaign_ask_reina (POST)', () => {
  assert.match(marketing, /campaign_ask_reina \(POST\)/);
});

function extractAskReinaSource() {
  const start = marketing.indexOf('const CAMPAIGN_TYPE_TO_OPP_KEY');
  const end = marketing.indexOf('// ---------- Content Studio: real photo-backed job list + AI-drafted post copy ----------');
  assert.ok(start > -1 && end > start);
  return marketing.slice(start, end);
}

function loadRealHandler(fixtures) {
  const fnSrc = extractAskReinaSource();
  const candidatesByKey = fixtures.candidatesByKey || {};
  const sandbox = {
    anthropicMkt: fixtures.anthropicMkt !== undefined ? fixtures.anthropicMkt : {
      messages: {
        create: async () => fixtures.anthropicResponse || { content: [{ type: 'text', text: 'Here is my honest answer.' }] },
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
      if (path.startsWith('campaign_recipients?')) {
        return {
          ok: fixtures.recipientsLookupOk !== false,
          json: async () => fixtures.recipients || [],
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
  return { handler: sandbox.handleCampaignAskReinaPost, sandbox };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

check('returns 409 honestly when ANTHROPIC_API_KEY is not configured', async () => {
  const { handler } = loadRealHandler({ anthropicMkt: null });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-1', question: 'Why this?' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error, /ANTHROPIC_API_KEY/);
});

check('requires campaignId', async () => {
  const { handler } = loadRealHandler({});
  const res = fakeRes();
  await handler({ body: { question: 'Why?' } }, res);
  assert.strictEqual(res.statusCode, 400);
});

check('requires a non-empty question', async () => {
  const { handler } = loadRealHandler({});
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-1', question: '  ' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /question is required/);
});

check('rejects an overly long question rather than sending it unbounded to the model', async () => {
  const { handler } = loadRealHandler({});
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-1', question: 'x'.repeat(501) } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /too long/);
});

check('404s when the campaign does not exist', async () => {
  const { handler } = loadRealHandler({ campaign: null });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-missing', question: 'Why?' } }, res);
  assert.strictEqual(res.statusCode, 404);
});

check('grounds the prompt in real campaign facts, real recipient counts, and a real sample recipient', async () => {
  let capturedPrompt = null;
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-2', name: 'Unsold estimate follow-up', type: 'estimate_recovery', channel: 'email', status: 'draft', notes: null, created_at: '2026-07-30T00:00:00Z' },
    recipients: [
      { sent_at: '2026-07-31T00:00:00Z', outcome: 'responded' },
      { sent_at: null, outcome: 'no_response' },
      { sent_at: '2026-07-31T00:00:00Z', outcome: 'booked' },
    ],
    candidatesByKey: {
      unsold_estimates: { candidates: [{ clientId: 'c1', clientName: 'Jane Homeowner', quoteTitle: 'Kitchen remodel', quoteTotal: 12500 }] },
    },
    anthropicMkt: {
      messages: {
        create: async (opts) => {
          capturedPrompt = opts.messages[0].content;
          return { content: [{ type: 'text', text: 'This campaign follows up on 3 real recipients, one of whom already booked.' }] };
        },
      },
    },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-2', question: 'How is this campaign doing?' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.usedRealSample, true);
  assert.match(capturedPrompt, /"recipientCount": 3/);
  assert.match(capturedPrompt, /"sentCount": 2/);
  assert.match(capturedPrompt, /"respondedCount": 1/);
  assert.match(capturedPrompt, /"bookedCount": 1/);
  assert.match(capturedPrompt, /Jane Homeowner/, 'prompt must include the real sample client name');
  assert.match(capturedPrompt, /Kitchen remodel/, 'prompt must include the real sample job\/quote fact');
  assert.match(capturedPrompt, /never invent a number, name, or outcome/i);
  assert.match(capturedPrompt, /say so honestly instead of guessing/i);
  assert.match(capturedPrompt, /How is this campaign doing\?/);
  assert.strictEqual(res.body.answer, 'This campaign follows up on 3 real recipients, one of whom already booked.');
});

check('honestly reports no real sample when the campaign type has no candidates yet', async () => {
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-3', name: 'Reactivate past customers', type: 'reactivation', channel: 'email', status: 'draft', notes: null, created_at: '2026-07-30T00:00:00Z' },
    recipients: [],
    candidatesByKey: { reactivate_customers: { candidates: [] } },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-3', question: 'Who will this reach?' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.usedRealSample, false);
});

check('a custom campaign type (no opportunity-key mapping) skips candidate lookup entirely and still succeeds', async () => {
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-4', name: 'One-off announcement', type: 'custom', channel: 'email', status: 'draft', notes: null, created_at: '2026-07-30T00:00:00Z' },
    recipients: [],
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-4', question: 'What is this?' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.usedRealSample, false);
});

check('502s when the AI returns an empty answer, rather than fabricating one', async () => {
  const { handler } = loadRealHandler({
    campaign: { id: 'camp-5', name: 'Seasonal', type: 'seasonal', channel: 'email', status: 'draft', notes: null, created_at: '2026-07-30T00:00:00Z' },
    recipients: [],
    anthropicMkt: { messages: { create: async () => ({ content: [{ type: 'text', text: '   ' }] }) } },
  });
  const res = fakeRes();
  await handler({ body: { campaignId: 'camp-5', question: 'Why?' } }, res);
  assert.strictEqual(res.statusCode, 502);
});

// ---------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------

check('the main inline script is still syntactically valid JavaScript after the Ask Reina insertion', () => {
  new vm.Script(extractInlineScript(), { filename: htmlPath });
});

check('ccApprove\'s modal has an Ask Reina input+button that calls campaign_ask_reina and renders the answer', () => {
  const start = html.indexOf('function ccApprove');
  const end = html.indexOf('\n  // ---------- Your Plan', start);
  const fn = html.slice(start, end > -1 ? end : undefined);
  assert.match(fn, /reinaLabel\.textContent = 'Ask Reina about this campaign';/);
  assert.match(fn, /api\('campaign_ask_reina', \{ method: 'POST', body: JSON\.stringify\(\{ campaignId: campaignId, question: question \}\) \}\)/);
  assert.match(fn, /reinaAnswer\.textContent = d\.answer;/);
  assert.match(fn, /reinaAnswer\.style\.display = 'block';/);
  assert.match(fn, /reinaInput\.addEventListener\('keydown'/, 'Enter key should also trigger the ask, not just the button click');
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
