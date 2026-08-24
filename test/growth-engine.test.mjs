import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleGrowthSuggestionsGet,
  handleGrowthSuggestionDecidePost,
  handleGrowthScanGet,
} from '../api/growth.js';

// The growth scan is the only thing in this codebase that acts on the business
// without a human triggering it, so what it is FORBIDDEN to do matters as much
// as what it does. These tests pin both: the drafts it may create, and the
// launches, sends and publishes it may not.
//
// The I/O boundary (supabaseRequest) is injected rather than mocked, matching
// test/ad-budget-governor.test.mjs -- node:test's mock.module is broken here.

const NOW = new Date('2026-08-24T12:00:00.000Z');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// A router-shaped fake: responses are matched by URL substring rather than by
// call order, because the scan issues its reads in parallel and a positional
// fake would make the tests depend on Promise.all's scheduling.
function fakeSupabase(routes, log = []) {
  return async (path, opts = {}) => {
    log.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    for (const [match, rows] of routes) {
      if (path.includes(match)) {
        const value = typeof rows === 'function' ? rows(path, opts) : rows;
        return { ok: true, json: async () => value, text: async () => JSON.stringify(value) };
      }
    }
    return { ok: true, json: async () => [], text: async () => '[]' };
  };
}

// Enough real-shaped data for the scan to find exactly one thing worth saying:
// a pile of unsold estimates. Ads are deliberately fully spent so no campaign
// rule fires and each test can isolate the behaviour it is about.
const SCAN_ROUTES = [
  ['jobs?', [{ jobber_id: 'j1', title: 'Water heater replacement', total: 1200, completed_at: '2026-08-01T00:00:00Z', client_id: 'c1' }]],
  ['quotes?', [{ quote_status: 'awaiting_response', total: 9000, jobber_created_at: '2026-07-01T00:00:00Z' }]],
  ['review_requests?', [{ job_id: 'j1', status: 'sent' }]],
  ['media?', []],
  ['office_location?', [{ lat: 41.02, lng: -73.62 }]],
  ['client_locations?', []],
  ['ad_platform_connections?', [{ platform: 'google_ads', state: 'launch_enabled' }]],
  ['ad_campaigns?', [{ id: 'camp1', platform: 'google_ads', status: 'active', daily_budget_cents: 5000 }]],
  ['ad_budget_caps?', [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }]],
  ['ad_spend_ledger?', [{ spend_cents: 150000 }]],
  ['growth_suggestions?tenant_id=eq.ghgrp&scan_key=in.', []],
  ['growth_suggestions?on_conflict', (path, opts) => JSON.parse(opts.body).map((row, i) => ({ ...row, id: 'sug' + i }))],
];

test('the scan writes real suggestions computed from real rows', async () => {
  const log = [];
  const r = res();
  await handleGrowthScanGet({ query: {} }, r, { supabaseRequest: fakeSupabase(SCAN_ROUTES, log), now: NOW });

  assert.equal(r.body.ok, true);
  assert.ok(r.body.suggestionsWritten >= 1);
  const upsert = log.find((c) => c.path.includes('on_conflict'));
  assert.ok(upsert, 'the scan must upsert rather than blind-insert');
  const kinds = upsert.body.map((row) => row.kind);
  assert.ok(kinds.includes('estimate_recovery'), 'the unsold estimate must be surfaced');
  const quoteRow = upsert.body.find((row) => row.kind === 'estimate_recovery');
  assert.equal(quoteRow.evidence.openQuoteValueCentsLast365, 900000);
  assert.equal(quoteRow.status, 'open');
});

test('the scan never launches, sends, or publishes -- the strongest thing it writes is a draft', async () => {
  const log = [];
  await handleGrowthScanGet({ query: {} }, res(), { supabaseRequest: fakeSupabase(SCAN_ROUTES, log), now: NOW });

  const forbidden = log.filter((c) =>
    c.path.startsWith('social_posts') ||
    c.path.includes('campaign_send') ||
    c.path.includes('outbox') ||
    (c.path.startsWith('ad_campaigns') && c.method === 'PATCH'));
  assert.deepEqual(forbidden, [], 'the unattended scan touched a publish/send/launch path');

  for (const call of log.filter((c) => c.path.startsWith('ad_campaigns') && c.method === 'POST')) {
    for (const row of call.body) assert.equal(row.status, 'draft');
  }
});

test('re-running the scan in the same week does not reopen something already decided', async () => {
  const log = [];
  // The same scan_key already exists and was dismissed by a human.
  const routes = SCAN_ROUTES.map(([m, v]) =>
    m === 'growth_suggestions?tenant_id=eq.ghgrp&scan_key=in.'
      ? [m, [{ scan_key: 'estimate_recovery:unsold_quotes:2026-W35', status: 'dismissed' }]]
      : [m, v]);
  const r = res();
  await handleGrowthScanGet({ query: {} }, r, { supabaseRequest: fakeSupabase(routes, log), now: NOW });

  const upsert = log.find((c) => c.path.includes('on_conflict'));
  const rewritten = upsert ? upsert.body.map((row) => row.scan_key) : [];
  assert.ok(!rewritten.includes('estimate_recovery:unsold_quotes:2026-W35'),
    'a dismissed suggestion must not be silently reopened by the next scan');
  assert.equal(r.body.suggestionsSkippedAlreadyDecided, 1);
});

test('GROWTH_AUTOPILOT_ENABLED=false stops the drafting but still produces suggestions', async () => {
  const prior = process.env.GROWTH_AUTOPILOT_ENABLED;
  process.env.GROWTH_AUTOPILOT_ENABLED = 'false';
  try {
    const log = [];
    const r = res();
    await handleGrowthScanGet({ query: {} }, r, { supabaseRequest: fakeSupabase(SCAN_ROUTES, log), now: NOW });
    assert.equal(r.body.autopilotEnabled, false);
    assert.equal(r.body.campaignsAutoDrafted, 0);
    assert.ok(r.body.suggestionsWritten >= 1, 'suggestions are still produced with autopilot off');
    assert.equal(log.filter((c) => c.path.startsWith('ad_campaigns') && c.method === 'POST').length, 0);
  } finally {
    if (prior === undefined) delete process.env.GROWTH_AUTOPILOT_ENABLED;
    else process.env.GROWTH_AUTOPILOT_ENABLED = prior;
  }
});

test('listing returns the real rows in priority order', async () => {
  const r = res();
  await handleGrowthSuggestionsGet(
    { query: { status: 'open' } }, r,
    fakeSupabase([['growth_suggestions?', [
      { id: 'a', kind: 'reactivation', title: 'T', rationale: 'R', evidence: {}, proposed_action: {}, priority: 1, status: 'open' },
    ]]]));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.suggestions[0].id, 'a');
  assert.equal(r.body.suggestions[0].proposedAction && typeof r.body.suggestions[0].proposedAction, 'object');
});

test('decide: rejects an unknown decision rather than guessing what was meant', async () => {
  const r = res();
  await handleGrowthSuggestionDecidePost({ body: { suggestionId: 'a', decision: 'maybe' } }, r, {});
  assert.equal(r.statusCode, 400);
});

test('decide: a suggestion can only be decided once', async () => {
  const r = res();
  await handleGrowthSuggestionDecidePost(
    { body: { suggestionId: 'a', decision: 'accept' } }, r,
    { supabaseRequest: fakeSupabase([['growth_suggestions?id=eq.a', [{ id: 'a', status: 'dismissed', proposed_action: {} }]]]) });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /already dismissed/);
});

test('accepting a fully specified ad suggestion creates a DRAFT campaign and links it', async () => {
  const log = [];
  const supa = fakeSupabase([
    ['growth_suggestions?id=eq.a', [{
      id: 'a', status: 'open',
      proposed_action: { type: 'ad_campaign_draft', platform: 'google_ads', objective: 'lead_gen', division: 'HVAC', dailyBudgetCents: 12000 },
    }]],
    ['jobs?', [{ title: 'Furnace install', total: 4000, completed_at: '2026-08-01T00:00:00Z' }]],
    ['office_location?', [{ lat: 41.02, lng: -73.62 }]],
    ['client_locations?', []],
    ['ad_campaigns', (path, opts) => JSON.parse(opts.body).map((row) => ({ ...row, id: 'newcamp' }))],
    ['growth_suggestions?id=eq.a&', [{ id: 'a', status: 'done', linked_record_id: 'newcamp', proposed_action: {} }]],
  ], log);

  const r = res();
  await handleGrowthSuggestionDecidePost(
    { body: { suggestionId: 'a', decision: 'accept' }, hlUser: { email: 'chris@ghgrp.net' } }, r,
    {
      supabaseRequest: supa,
      // Injected so the test exercises the real draft path without an API key.
      anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ headline: 'H', primaryText: 'P', description: 'D', cta: 'Book' }) }] }) } },
    });

  assert.equal(r.body.ok, true);
  const created = log.find((c) => c.path.startsWith('ad_campaigns') && c.method === 'POST');
  assert.ok(created, 'a campaign row must have been created');
  assert.equal(created.body[0].status, 'draft', 'accepting must never create anything but a draft');
  assert.equal(created.body[0].created_by, 'reina_growth_scan');
  const patch = log.find((c) => c.method === 'PATCH' && c.path.includes('growth_suggestions'));
  assert.equal(patch.body.status, 'done');
  assert.equal(patch.body.linked_record_id, 'newcamp');
  assert.equal(patch.body.decided_by, 'chris@ghgrp.net');
});

test('accepting something only a human can carry out records the decision without pretending to act', async () => {
  const log = [];
  const r = res();
  await handleGrowthSuggestionDecidePost(
    { body: { suggestionId: 'a', decision: 'accept' }, hlUser: { email: 'chris@ghgrp.net' } }, r,
    {
      supabaseRequest: fakeSupabase([
        ['growth_suggestions?id=eq.a', [{ id: 'a', status: 'open', proposed_action: { type: 'email_campaign', campaignType: 'reactivation' } }]],
        ['growth_suggestions?id=eq.a&', [{ id: 'a', status: 'accepted', proposed_action: {} }]],
      ], log),
    });
  assert.equal(r.body.ok, true);
  const patch = log.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.status, 'accepted', 'not "done" -- nothing was actually carried out');
  assert.equal(log.filter((c) => c.path.startsWith('campaigns') && c.method === 'POST').length, 0);
});

test('dismissing records the reason and creates nothing at all', async () => {
  const log = [];
  const r = res();
  await handleGrowthSuggestionDecidePost(
    { body: { suggestionId: 'a', decision: 'dismiss', reason: 'Busy season already' }, hlUser: { email: 'chris@ghgrp.net' } }, r,
    {
      supabaseRequest: fakeSupabase([
        ['growth_suggestions?id=eq.a', [{ id: 'a', status: 'open', proposed_action: { type: 'ad_campaign_draft', platform: 'meta', division: 'HVAC', dailyBudgetCents: 5000 } }]],
        ['growth_suggestions?id=eq.a&', [{ id: 'a', status: 'dismissed', proposed_action: {} }]],
      ], log),
    });
  const patch = log.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.status, 'dismissed');
  assert.equal(patch.body.decided_reason, 'Busy season already');
  assert.equal(log.filter((c) => c.path.startsWith('ad_campaigns')).length, 0, 'a dismissal must not draft anything');
});
