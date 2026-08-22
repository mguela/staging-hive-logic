import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleAdSpendSyncPost } from '../api/ads.js';

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

test('handleAdSpendSyncPost: campaignId is required', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdSpendSyncPost({ body: {} }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdSpendSyncPost: rejects a malformed date', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: 'not-a-date' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdSpendSyncPost: 404 when the campaign does not exist', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleAdSpendSyncPost({ body: { campaignId: 'ghost', date: '2026-08-01' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 404);
});

test('handleAdSpendSyncPost: refuses a platform with no live integration yet (a hypothetical future platform, not Meta/Google Ads/TikTok)', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', platform: 'bing_ads', external_campaign_id: 'ext1' }] }]);
  const res = fakeRes();
  await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdSpendSyncPost: refuses a campaign with no external_campaign_id', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', platform: 'meta', external_campaign_id: null }] }]);
  const res = fakeRes();
  await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdSpendSyncPost: refuses honestly when the connection has no usable access token', async () => {
  delete process.env.AD_META_TEST_SYNC_UNSET_TOKEN;
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', platform: 'meta', external_campaign_id: 'ext1' }] },
    { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_SYNC_UNSET_TOKEN' }] },
  ]);
  const res = fakeRes();
  await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdSpendSyncPost: a real Meta failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_META_TEST_SYNC_TOKEN_A = 'tok-a';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'meta', external_campaign_id: 'ext1' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_SYNC_TOKEN_A' }] },
      { rows: [], ok: true },
    ]);
    const failingSync = async () => {
      const err = new Error('This ad account has a billing issue');
      err.metaClassified = { state: 'billing_blocked', reason: 'meta_billing_issue', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa, syncMetaCampaignSpend: failingSync });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'billing_blocked');
  } finally {
    delete process.env.AD_META_TEST_SYNC_TOKEN_A;
  }
});

test('handleAdSpendSyncPost: a real successful sync upserts the real spend into ad_spend_ledger', async () => {
  process.env.AD_META_TEST_SYNC_TOKEN_B = 'tok-b';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'meta', external_campaign_id: 'ext1' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_SYNC_TOKEN_B' }] },
      { rows: [{ id: 'ledger1', tenant_id: 'ghgrp', platform: 'meta', ad_campaign_id: 'c1', spend_date: '2026-08-01', spend_cents: 4321 }], ok: true },
    ]);
    const succeedingSync = async () => ({ spendCents: 4321, date: '2026-08-01' });
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa, syncMetaCampaignSpend: succeedingSync });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.spendCents, 4321);
    assert.equal(res.body.date, '2026-08-01');
    assert.equal(res.body.ledgerRow.id, 'ledger1');
  } finally {
    delete process.env.AD_META_TEST_SYNC_TOKEN_B;
  }
});

test('handleAdSpendSyncPost: defaults the date to today (UTC) when not provided', async () => {
  process.env.AD_META_TEST_SYNC_TOKEN_C = 'tok-c';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'meta', external_campaign_id: 'ext1' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_SYNC_TOKEN_C' }] },
      { rows: [{ id: 'ledger2' }], ok: true },
    ]);
    let capturedDate = null;
    const succeedingSync = async (externalCampaignId, conn, dateStr) => {
      capturedDate = dateStr;
      return { spendCents: 100, date: dateStr };
    };
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, syncMetaCampaignSpend: succeedingSync });
    assert.equal(res.statusCode, 200);
    assert.equal(capturedDate, today);
  } finally {
    delete process.env.AD_META_TEST_SYNC_TOKEN_C;
  }
});

// ---------- Google Ads (step 5, first repeat of the Meta pattern) ----------

const googleCredsJson = JSON.stringify({ developerToken: 'dev-tok', clientId: 'cid', clientSecret: 'csecret', refreshToken: 'refresh-tok' });

test('handleAdSpendSyncPost: refuses honestly when the Google Ads connection has no usable customer id', async () => {
  process.env.AD_GOOGLE_TEST_SYNC_UNSET = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'google_ads', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_SYNC_UNSET', ad_account_id: null }] },
    ]);
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa });
    assert.equal(res.statusCode, 409);
  } finally {
    delete process.env.AD_GOOGLE_TEST_SYNC_UNSET;
  }
});

test('handleAdSpendSyncPost: a real Google Ads failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_GOOGLE_TEST_SYNC_TOKEN_A = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'google_ads', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_SYNC_TOKEN_A', ad_account_id: '1112223333' }] },
      { rows: [], ok: true },
    ]);
    const failingSync = async () => {
      const err = new Error('Billing not configured');
      err.googleAdsClassified = { state: 'billing_blocked', reason: 'google_ads_billing_issue', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa, syncGoogleAdsCampaignSpend: failingSync });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'billing_blocked');
  } finally {
    delete process.env.AD_GOOGLE_TEST_SYNC_TOKEN_A;
  }
});

test('handleAdSpendSyncPost: a real successful Google Ads sync upserts the real spend into ad_spend_ledger', async () => {
  process.env.AD_GOOGLE_TEST_SYNC_TOKEN_B = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'google_ads', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_SYNC_TOKEN_B', ad_account_id: '1112223333' }] },
      { rows: [{ id: 'ledger3', tenant_id: 'ghgrp', platform: 'google_ads', ad_campaign_id: 'c1', spend_date: '2026-08-01', spend_cents: 4321 }], ok: true },
    ]);
    const succeedingSync = async () => ({ spendCents: 4321, date: '2026-08-01' });
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa, syncGoogleAdsCampaignSpend: succeedingSync });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.spendCents, 4321);
    assert.equal(res.body.ledgerRow.id, 'ledger3');
  } finally {
    delete process.env.AD_GOOGLE_TEST_SYNC_TOKEN_B;
  }
});

// ---------- TikTok Ads (step 5, third repeat of the Meta pattern) ----------

test('handleAdSpendSyncPost: refuses honestly when the TikTok connection has no usable advertiser id', async () => {
  process.env.AD_TIKTOK_TEST_SYNC_UNSET = 'tt-tok';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'tiktok', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_SYNC_UNSET', ad_account_id: null }] },
    ]);
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa });
    assert.equal(res.statusCode, 409);
  } finally {
    delete process.env.AD_TIKTOK_TEST_SYNC_UNSET;
  }
});

test('handleAdSpendSyncPost: a real TikTok failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_TIKTOK_TEST_SYNC_TOKEN_A = 'tt-tok-a';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'tiktok', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_SYNC_TOKEN_A', ad_account_id: '778899' }] },
      { rows: [], ok: true },
    ]);
    const failingSync = async () => {
      const err = new Error('Insufficient balance in account');
      err.tiktokClassified = { state: 'billing_blocked', reason: 'tiktok_billing_issue', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa, syncTikTokCampaignSpend: failingSync });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'billing_blocked');
  } finally {
    delete process.env.AD_TIKTOK_TEST_SYNC_TOKEN_A;
  }
});

test('handleAdSpendSyncPost: a real successful TikTok sync upserts the real spend into ad_spend_ledger', async () => {
  process.env.AD_TIKTOK_TEST_SYNC_TOKEN_B = 'tt-tok-b';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', platform: 'tiktok', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_SYNC_TOKEN_B', ad_account_id: '778899' }] },
      { rows: [{ id: 'ledger4', tenant_id: 'ghgrp', platform: 'tiktok', ad_campaign_id: 'c1', spend_date: '2026-08-01', spend_cents: 4321 }], ok: true },
    ]);
    const succeedingSync = async () => ({ spendCents: 4321, date: '2026-08-01' });
    const res = fakeRes();
    await handleAdSpendSyncPost({ body: { campaignId: 'c1', date: '2026-08-01' } }, res, { supabaseRequest: supa, syncTikTokCampaignSpend: succeedingSync });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.spendCents, 4321);
    assert.equal(res.body.ledgerRow.id, 'ledger4');
  } finally {
    delete process.env.AD_TIKTOK_TEST_SYNC_TOKEN_B;
  }
});
