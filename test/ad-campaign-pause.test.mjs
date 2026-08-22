import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleAdCampaignPausePost } from '../api/ads.js';

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

test('handleAdCampaignPausePost: campaignId is required', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdCampaignPausePost({ body: {} }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 400);
});

test('handleAdCampaignPausePost: 404 when the campaign does not exist', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleAdCampaignPausePost({ body: { campaignId: 'ghost' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 404);
});

test('handleAdCampaignPausePost: refuses a platform with no live integration yet (a hypothetical future platform, not Meta/Google Ads/TikTok)', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', status: 'active', platform: 'bing_ads', external_campaign_id: 'ext1' }] }]);
  const res = fakeRes();
  await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignPausePost: refuses to pause a campaign that is not active', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', status: 'draft', platform: 'meta', external_campaign_id: null }] }]);
  const res = fakeRes();
  await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignPausePost: refuses a campaign with no external_campaign_id', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'c1', status: 'active', platform: 'meta', external_campaign_id: null }] }]);
  const res = fakeRes();
  await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignPausePost: refuses honestly when the connection has no usable access token', async () => {
  delete process.env.AD_META_TEST_PAUSE_UNSET_TOKEN;
  const supa = fakeSupabase([
    { rows: [{ id: 'c1', status: 'active', platform: 'meta', external_campaign_id: 'ext1' }] },
    { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_PAUSE_UNSET_TOKEN' }] },
  ]);
  const res = fakeRes();
  await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleAdCampaignPausePost: a real Meta failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_META_TEST_PAUSE_TOKEN_A = 'tok-a';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'meta', external_campaign_id: 'ext1' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_PAUSE_TOKEN_A' }] },
      { rows: [], ok: true },
    ]);
    const failingPause = async () => {
      const err = new Error('Invalid OAuth access token');
      err.metaClassified = { state: 'needs_reauth', reason: 'meta_token_invalid_or_expired', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, pauseMetaCampaign: failingPause });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'needs_reauth');
  } finally {
    delete process.env.AD_META_TEST_PAUSE_TOKEN_A;
  }
});

test('handleAdCampaignPausePost: a real successful pause moves the campaign to paused', async () => {
  process.env.AD_META_TEST_PAUSE_TOKEN_B = 'tok-b';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'meta', external_campaign_id: 'ext1' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_META_TEST_PAUSE_TOKEN_B' }] },
      { rows: [], ok: true },
    ]);
    const succeedingPause = async () => ({ success: true });
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1', reason: 'Q3 budget reallocation' } }, res, { supabaseRequest: supa, pauseMetaCampaign: succeedingPause });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'paused');
    assert.equal(res.body.reason, 'Q3 budget reallocation');
  } finally {
    delete process.env.AD_META_TEST_PAUSE_TOKEN_B;
  }
});

// ---------- Google Ads (step 5, first repeat of the Meta pattern) ----------

const googleCredsJson = JSON.stringify({ developerToken: 'dev-tok', clientId: 'cid', clientSecret: 'csecret', refreshToken: 'refresh-tok' });

test('handleAdCampaignPausePost: refuses honestly when the Google Ads connection has no usable customer id', async () => {
  process.env.AD_GOOGLE_TEST_PAUSE_UNSET = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'google_ads', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_PAUSE_UNSET', ad_account_id: null }] },
    ]);
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
    assert.equal(res.statusCode, 409);
  } finally {
    delete process.env.AD_GOOGLE_TEST_PAUSE_UNSET;
  }
});

test('handleAdCampaignPausePost: a real Google Ads failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_GOOGLE_TEST_PAUSE_TOKEN_A = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'google_ads', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_PAUSE_TOKEN_A', ad_account_id: '1112223333' }] },
      { rows: [], ok: true },
    ]);
    const failingPause = async () => {
      const err = new Error('Token has been expired or revoked.');
      err.googleAdsClassified = { state: 'needs_reauth', reason: 'google_oauth_refresh_failed', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, pauseGoogleAdsCampaign: failingPause });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'needs_reauth');
  } finally {
    delete process.env.AD_GOOGLE_TEST_PAUSE_TOKEN_A;
  }
});

test('handleAdCampaignPausePost: a real successful Google Ads pause moves the campaign to paused', async () => {
  process.env.AD_GOOGLE_TEST_PAUSE_TOKEN_B = googleCredsJson;
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'google_ads', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_GOOGLE_TEST_PAUSE_TOKEN_B', ad_account_id: '1112223333' }] },
      { rows: [], ok: true },
    ]);
    const succeedingPause = async () => ({ results: [{ resourceName: 'customers/1112223333/campaigns/2' }] });
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1', reason: 'Q3 budget reallocation' } }, res, { supabaseRequest: supa, pauseGoogleAdsCampaign: succeedingPause });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'paused');
  } finally {
    delete process.env.AD_GOOGLE_TEST_PAUSE_TOKEN_B;
  }
});

// ---------- TikTok Ads (step 5, third repeat of the Meta pattern) ----------

test('handleAdCampaignPausePost: refuses honestly when the TikTok connection has no usable advertiser id', async () => {
  process.env.AD_TIKTOK_TEST_PAUSE_UNSET = 'tt-tok';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'tiktok', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_PAUSE_UNSET', ad_account_id: null }] },
    ]);
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa });
    assert.equal(res.statusCode, 409);
  } finally {
    delete process.env.AD_TIKTOK_TEST_PAUSE_UNSET;
  }
});

test('handleAdCampaignPausePost: a real TikTok failure is classified and recorded on the connection, never silently swallowed', async () => {
  process.env.AD_TIKTOK_TEST_PAUSE_TOKEN_A = 'tt-tok-a';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'tiktok', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_PAUSE_TOKEN_A', ad_account_id: '778899' }] },
      { rows: [], ok: true },
    ]);
    const failingPause = async () => {
      const err = new Error('Invalid access token');
      err.tiktokClassified = { state: 'needs_reauth', reason: 'tiktok_token_invalid_or_unauthorized', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1' } }, res, { supabaseRequest: supa, pauseTikTokCampaign: failingPause });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'needs_reauth');
  } finally {
    delete process.env.AD_TIKTOK_TEST_PAUSE_TOKEN_A;
  }
});

test('handleAdCampaignPausePost: a real successful TikTok pause moves the campaign to paused', async () => {
  process.env.AD_TIKTOK_TEST_PAUSE_TOKEN_B = 'tt-tok-b';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'c1', status: 'active', platform: 'tiktok', external_campaign_id: '2' }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'AD_TIKTOK_TEST_PAUSE_TOKEN_B', ad_account_id: '778899' }] },
      { rows: [], ok: true },
    ]);
    const succeedingPause = async () => ({});
    const res = fakeRes();
    await handleAdCampaignPausePost({ body: { campaignId: 'c1', reason: 'Q3 budget reallocation' } }, res, { supabaseRequest: supa, pauseTikTokCampaign: succeedingPause });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'paused');
  } finally {
    delete process.env.AD_TIKTOK_TEST_PAUSE_TOKEN_B;
  }
});
