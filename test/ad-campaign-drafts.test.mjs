import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleAdCampaignsGet,
  handleAdCampaignDraftPost,
  handleAdCampaignReviewPost,
} from '../api/ads.js';

function fakeSupabase(responses) {
  let call = 0;
  return async (path) => {
    const entry = responses[call];
    call += 1;
    if (!entry) throw new Error('fakeSupabase: no response queued for call ' + call + ' (path: ' + path + ')');
    return {
      ok: entry.ok !== false,
      json: async () => entry.rows,
      text: async () => JSON.stringify(entry.rows),
    };
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function fakeAnthropic(replyObj) {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(replyObj) }] }),
    },
  };
}

test('handleAdCampaignsGet: returns real rows from ad_campaigns', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', platform: 'meta', status: 'draft' }] }]);
  const res = fakeRes();
  await handleAdCampaignsGet({ query: {} }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.campaigns.length, 1);
});

test('handleAdCampaignDraftPost: rejects an unknown platform before touching the database', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: { platform: 'snapchat', objective: 'lead_gen', division: 'HVAC', dailyBudgetCents: 1000 } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignDraftPost: rejects an unknown objective', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: { platform: 'meta', objective: 'go_viral', division: 'HVAC', dailyBudgetCents: 1000 } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignDraftPost: rejects an unknown division', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: { platform: 'meta', objective: 'lead_gen', division: 'Roofing', dailyBudgetCents: 1000 } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignDraftPost: rejects a negative daily budget', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: { platform: 'meta', objective: 'lead_gen', division: 'HVAC', dailyBudgetCents: -5 } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignDraftPost: manual adCopy skips AI generation entirely and saves a real draft row', async () => {
  const supa = fakeSupabase([
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{ id: 'new1', status: 'draft', ad_copy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'Call' } }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: {
    platform: 'meta', objective: 'lead_gen', division: 'HVAC', dailyBudgetCents: 2000,
    adCopy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'Call' },
  } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.campaign.status, 'draft');
});

test('handleAdCampaignDraftPost: rejects incomplete manual adCopy rather than silently dropping a field', async () => {
  const supa = fakeSupabase([{ rows: [] }, { rows: [] }, { rows: [] }]);
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: {
    platform: 'meta', objective: 'lead_gen', division: 'HVAC', dailyBudgetCents: 2000,
    adCopy: { headline: 'h', primaryText: 'p', description: 'd' },
  } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignDraftPost: generates AI copy grounded in real facts when no manual copy is given', async () => {
  const supa = fakeSupabase([
    { rows: [{ title: 'Furnace repair', total: 5000, completed_at: new Date().toISOString() }] },
    { rows: [] },
    { rows: [] },
    { rows: [{ id: 'new2', status: 'draft' }] },
  ]);
  const anthropic = fakeAnthropic({ headline: 'AI headline', primaryText: 'AI body', description: 'AI desc', cta: 'Learn More' });
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: { platform: 'meta', objective: 'lead_gen', division: 'HVAC', dailyBudgetCents: 2000 } }, res, { supabaseRequest: supa, anthropic });
  assert.equal(res.statusCode, 200);
});

test('handleAdCampaignDraftPost: refuses honestly (409) when no manual copy is given and AI is not configured', async () => {
  const supa = fakeSupabase([{ rows: [] }, { rows: [] }, { rows: [] }]);
  const res = fakeRes();
  await handleAdCampaignDraftPost({ body: { platform: 'meta', objective: 'lead_gen', division: 'HVAC', dailyBudgetCents: 2000 } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignReviewPost: campaignId is required', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignReviewPost({ body: { decision: 'approve' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignReviewPost: decision must be approve or reject', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignReviewPost({ body: { campaignId: 'c1', decision: 'maybe' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignReviewPost: 404 when the campaign does not exist', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleAdCampaignReviewPost({ body: { campaignId: 'ghost', decision: 'approve' } }, res, supa);
  assert.equal(res.statusCode, 404);
});

test('handleAdCampaignReviewPost: refuses to re-review a campaign that already left draft', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', status: 'active' }] }]);
  const res = fakeRes();
  await handleAdCampaignReviewPost({ body: { campaignId: 'c1', decision: 'approve' } }, res, supa);
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignReviewPost: reject stores a real reason and never touches the budget governor', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'draft', daily_budget_cents: 1000 }] },
    { rows: [], ok: true },
  ]);
  const res = fakeRes();
  await handleAdCampaignReviewPost({ body: { campaignId: 'c1', decision: 'reject', reason: 'not on brand' } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'rejected');
});

test('handleAdCampaignReviewPost: approve is refused when the real budget check fails', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'draft', daily_budget_cents: 5000 }] },
    { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
    { rows: [{ spend_cents: 140000 }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignReviewPost({ body: { campaignId: 'c1', decision: 'approve' } }, res, supa);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.budgetCheck.reason, 'would_exceed_monthly_cap');
});

test('handleAdCampaignReviewPost: approve succeeds and moves draft to pending_review when the real budget check passes', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'draft', daily_budget_cents: 1000 }] },
    { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
    { rows: [{ spend_cents: 20000 }] },
    { rows: [], ok: true },
  ]);
  const res = fakeRes();
  await handleAdCampaignReviewPost({ body: { campaignId: 'c1', decision: 'approve' }, hlUser: { email: 'chris@ghgrp.net' } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'pending_review');
});
