import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleAdCampaignLaunchPost } from '../api/ads.js';

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

const realAdCopy = { headline: 'h', primaryText: 'p', description: 'd', cta: 'CALL_NOW' };

test('handleAdCampaignLaunchPost: campaignId is required', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: {} }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignLaunchPost: 404 when the campaign does not exist', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'ghost' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 404);
});

test('handleAdCampaignLaunchPost: refuses to launch a campaign that is not pending_review', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', status: 'draft', platform: 'meta', ad_copy: realAdCopy }] }]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses a platform with no live integration yet (a hypothetical future platform, not Meta/Google Ads/TikTok)', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', status: 'pending_review', platform: 'bing_ads', ad_copy: realAdCopy }] }]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses a campaign with no ad copy', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', status: 'pending_review', platform: 'meta', ad_copy: null }] }]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses when the Meta connection is not launch_enabled', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'pending_review', platform: 'meta', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
    { rows: [{ state: 'setup_incomplete' }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses honestly when the real access token is not set yet', async () => {
  delete process.env.AD_META_TEST_UNSET_TOKEN;
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'pending_review', platform: 'meta', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
    { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_UNSET_TOKEN', ad_account_id: 'act1', page_id: 'page1' }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses when the ad account or page is not set up yet', async () => {
  process.env.AD_META_TEST_TOKEN_A = 'tok-a';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'meta', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_TOKEN_A', ad_account_id: null, page_id: 'page1' }] },
    ]);
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
    assert.equal(res.statusCode, 409);
  } finally {
    delete process.env.AD_META_TEST_TOKEN_A;
  }
});

test('handleAdCampaignLaunchPost: refuses to launch when the real budget check fails', async () => {
  process.env.AD_META_TEST_TOKEN_B = 'tok-b';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'meta', ad_copy: realAdCopy, daily_budget_cents: 5000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_TOKEN_B', ad_account_id: 'act1', page_id: 'page1' }] },
      { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
      { rows: [{ spend_cents: 149000 }] },
    ]);
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.budgetCheck.reason, 'would_exceed_monthly_cap');
  } finally {
    delete process.env.AD_META_TEST_TOKEN_B;
  }
});

test('handleAdCampaignLaunchPost: a real Meta failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_META_TEST_TOKEN_C = 'tok-c';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'meta', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_TOKEN_C', ad_account_id: 'act1', page_id: 'page1' }] },
      { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
      { rows: [{ spend_cents: 1000 }] },
      { rows: [], ok: true },
    ]);
    const failingLaunch = async () => {
      const err = new Error('This ad set was disapproved for policy reasons');
      err.metaClassified = { state: 'policy_blocked', reason: 'meta_policy_issue', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, launchMetaCampaign: failingLaunch });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'policy_blocked');
  } finally {
    delete process.env.AD_META_TEST_TOKEN_C;
  }
});

test('handleAdCampaignLaunchPost: a real successful launch moves the campaign to active with its external id', async () => {
  process.env.AD_META_TEST_TOKEN_D = 'tok-d';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'meta', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_TOKEN_D', ad_account_id: 'act1', page_id: 'page1' }] },
      { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
      { rows: [{ spend_cents: 1000 }] },
      { rows: [], ok: true },
    ]);
    const succeedingLaunch = async () => ({
      externalCampaignId: 'campaign_real_1',
      externalAdSetId: 'adset_real_1',
      externalCreativeId: 'creative_real_1',
      externalAdId: 'ad_real_1',
    });
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, launchMetaCampaign: succeedingLaunch });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.launchResult.externalCampaignId, 'campaign_real_1');
  } finally {
    delete process.env.AD_META_TEST_TOKEN_D;
  }
});

// ---------- Google Ads (step 5, first repeat of the Meta pattern) ----------

const googleCredsJson = JSON.stringify({ developerToken: 'dev-tok', clientId: 'cid', clientSecret: 'csecret', refreshToken: 'refresh-tok' });

test('handleAdCampaignLaunchPost: refuses when the Google Ads connection is not launch_enabled', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'pending_review', platform: 'google_ads', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
    { rows: [{ state: 'setup_incomplete' }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses honestly when the Google Ads credentials env var is not set yet', async () => {
  delete process.env.AD_GOOGLE_TEST_UNSET_CREDS;
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'pending_review', platform: 'google_ads', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
    { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_UNSET_CREDS', ad_account_id: '1112223333' }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: a real Google Ads failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_GOOGLE_TEST_CREDS_A = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'google_ads', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_CREDS_A', ad_account_id: '1112223333' }] },
      { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
      { rows: [{ spend_cents: 1000 }] },
      { rows: [], ok: true },
    ]);
    const failingLaunch = async () => {
      const err = new Error('Campaign name violates policy');
      err.googleAdsClassified = { state: 'policy_blocked', reason: 'google_ads_policy_issue', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, launchGoogleAdsCampaign: failingLaunch });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'policy_blocked');
  } finally {
    delete process.env.AD_GOOGLE_TEST_CREDS_A;
  }
});

test('handleAdCampaignLaunchPost: a real successful Google Ads launch moves the campaign to active with its external id', async () => {
  process.env.AD_GOOGLE_TEST_CREDS_B = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'google_ads', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_CREDS_B', ad_account_id: '1112223333' }] },
      { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
      { rows: [{ spend_cents: 1000 }] },
      { rows: [], ok: true },
    ]);
    const succeedingLaunch = async () => ({
      externalCampaignId: '2',
      externalCampaignBudgetResourceName: 'customers/1112223333/campaignBudgets/1',
      externalAdGroupResourceName: 'customers/1112223333/adGroups/3',
      externalAdResourceName: 'customers/1112223333/adGroupAds/4',
    });
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, launchGoogleAdsCampaign: succeedingLaunch });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.launchResult.externalCampaignId, '2');
  } finally {
    delete process.env.AD_GOOGLE_TEST_CREDS_B;
  }
});

// ---------- TikTok Ads (step 5, third repeat of the Meta pattern) ----------

test('handleAdCampaignLaunchPost: refuses when the TikTok connection is not launch_enabled', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'pending_review', platform: 'tiktok', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
    { rows: [{ state: 'setup_incomplete' }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses honestly when the real TikTok access token is not set yet', async () => {
  delete process.env.AD_TIKTOK_TEST_UNSET_TOKEN;
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'pending_review', platform: 'tiktok', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
    { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_UNSET_TOKEN', ad_account_id: '778899', page_id: 'identity-1' }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignLaunchPost: refuses when the TikTok advertiser or identity is not set up yet', async () => {
  process.env.AD_TIKTOK_TEST_TOKEN_A = 'tt-tok-a';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'tiktok', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_TOKEN_A', ad_account_id: '778899', page_id: null }] },
    ]);
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
    assert.equal(res.statusCode, 409);
  } finally {
    delete process.env.AD_TIKTOK_TEST_TOKEN_A;
  }
});

test('handleAdCampaignLaunchPost: a real TikTok failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_TIKTOK_TEST_TOKEN_B = 'tt-tok-b';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'tiktok', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_TOKEN_B', ad_account_id: '778899', page_id: 'identity-1' }] },
      { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
      { rows: [{ spend_cents: 1000 }] },
      { rows: [], ok: true },
    ]);
    const failingLaunch = async () => {
      const err = new Error('Ad rejected during review for policy violation');
      err.tiktokClassified = { state: 'policy_blocked', reason: 'tiktok_policy_issue', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, launchTikTokCampaign: failingLaunch });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'policy_blocked');
  } finally {
    delete process.env.AD_TIKTOK_TEST_TOKEN_B;
  }
});

test('handleAdCampaignLaunchPost: a real successful TikTok launch moves the campaign to active with its external id', async () => {
  process.env.AD_TIKTOK_TEST_TOKEN_C = 'tt-tok-c';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'pending_review', platform: 'tiktok', ad_copy: realAdCopy, daily_budget_cents: 1000 }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_TOKEN_C', ad_account_id: '778899', page_id: 'identity-1' }] },
      { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
      { rows: [{ spend_cents: 1000 }] },
      { rows: [], ok: true },
    ]);
    const succeedingLaunch = async () => ({
      externalCampaignId: '2',
      externalAdGroupId: '3',
      externalAdIds: ['4'],
    });
    const res = fakeRes();
    await handleAdCampaignLaunchPost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, launchTikTokCampaign: succeedingLaunch });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.launchResult.externalCampaignId, '2');
  } finally {
    delete process.env.AD_TIKTOK_TEST_TOKEN_C;
  }
});
