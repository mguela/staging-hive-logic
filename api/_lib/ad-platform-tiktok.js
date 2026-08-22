// api/_lib/ad-platform-tiktok.js
// Real TikTok for Business Marketing API adapter -- REST interface, API
// version v1.3 (confirm this is still current before relying on it --
// business-api.tiktok.com/portal/docs has TikTok's own release notes).
//
// This module has never been exercised against a real TikTok ad account --
// Chris has not yet finished TikTok for Business developer app approval or
// added a real access token / Advertiser ID. Every function below takes an
// injectable fetchImpl so the request/response contract is verified here
// against realistic mocked responses (see test/ad-platform-tiktok.test.mjs).
// Per the build plan this is NOT "done" until it has actually succeeded
// against Chris's real (small) test spend -- until then this is tested
// scaffolding, ready to go live the moment Chris finishes TikTok setup and
// adds the real access token as a Vercel project setting.
//
// TikTok's credential shape is simpler than Google Ads' -- one long-lived
// access token (generated once via TikTok's app-authorization flow, not
// refreshed per-call like Google's OAuth token) plus the Advertiser ID, the
// same two-field shape Meta uses. ad_platform_connections.env_var_name for
// platform='tiktok' points to a Vercel env var whose value is just the raw
// access token string. ad_platform_connections.ad_account_id is the TikTok
// Advertiser ID.
//
// IMPORTANT, honest limitation: TikTok is a video-first platform. Every real
// ad TikTok serves requires a real uploaded video (or image, for TikTok's
// image-ad formats) -- there is no text-only ad format like a Google
// Responsive Search Ad, and no asset-upload pipeline exists in this codebase
// yet. Rather than fabricating a fake video_id or silently skipping the ad
// creative step, launchTikTokCampaign() creates the real Campaign and Ad
// Group (which need no creative) and then refuses honestly at the Ad-create
// step if adCopy.mediaAssetId (a real TikTok video_id or image_id, uploaded
// out-of-band via TikTok Ads Manager or a future asset-upload endpoint) is
// not provided. This matches this codebase's standing rule against fake
// functionality -- see ad-copy-generator.js's ANTHROPIC_API_KEY 409 pattern
// for the same honesty convention applied elsewhere in this build.

const TIKTOK_API_VERSION = 'v1.3';
const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/' + TIKTOK_API_VERSION;

const defaultFetch = (...args) => fetch(...args);

// TikTok has no single "objective" concept shared with Meta/Google -- a
// campaign carries an objective_type from TikTok's own fixed list. This
// mapping is a judgment call flagged for Chris to confirm before first real
// use, same as Meta's ODAX mapping and Google's channel/bidding mapping.
const OBJECTIVE_MAP = {
  lead_gen: 'LEAD_GENERATION',
  traffic: 'TRAFFIC',
  awareness: 'REACH',
  conversions: 'CONVERSIONS',
};

function tiktokObjectiveFor(internalObjective) {
  const mapped = OBJECTIVE_MAP[internalObjective];
  if (!mapped) {
    const err = new Error('No TikTok objective_type mapping for ' + internalObjective);
    err.unmappedObjective = true;
    throw err;
  }
  return mapped;
}

// ---------- request payload builders (pure -- no I/O, easy to unit test) ----------

function buildCampaignPayload({ advertiserId, name, objective, dailyBudgetCents }) {
  return {
    advertiser_id: advertiserId,
    campaign_name: name,
    objective_type: tiktokObjectiveFor(objective),
    budget_mode: 'BUDGET_MODE_DAY',
    // TikTok's budget field is a plain decimal number in the account's
    // currency (not micros/cents like Google) -- dailyBudgetCents is already
    // in cents, so divide by 100.
    budget: Math.round(dailyBudgetCents) / 100,
    // Always created DISABLE (TikTok's term for paused). Same safety rule as
    // the Meta and Google Ads adapters -- never create an object that could
    // start spending before every step in the chain below has succeeded.
    operation_status: 'DISABLE',
  };
}

function buildAdGroupPayload({ advertiserId, campaignId, name, dailyBudgetCents }) {
  return {
    advertiser_id: advertiserId,
    campaign_id: campaignId,
    adgroup_name: name,
    placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
    budget_mode: 'BUDGET_MODE_DAY',
    budget: Math.round(dailyBudgetCents) / 100,
    billing_event: 'CPC',
    // Real TikTok ad groups require substantially more mandatory targeting
    // fields (age/gender/location/languages, bid strategy, etc.) than shown
    // here -- this is a conservative, broadly-legal-shaped default flagged
    // for Chris to tune once a real launch is imminent, same caveat style as
    // Google's targetImpressionShare default.
    bid_type: 'BID_TYPE_NO_BID',
    optimization_goal: 'CLICK',
    schedule_type: 'SCHEDULE_FROM_NOW',
    operation_status: 'DISABLE',
  };
}

function buildAdPayload({ advertiserId, adgroupId, adCopy, linkUrl, identityId }) {
  if (!adCopy.mediaAssetId) {
    const err = new Error('TikTok ads require a real uploaded video or image asset id (adCopy.mediaAssetId) -- none provided. Asset upload is not wired up in this build yet; Chris/Reina must supply a real TikTok video_id/image_id.');
    err.missingMediaAsset = true;
    throw err;
  }
  return {
    advertiser_id: advertiserId,
    adgroup_id: adgroupId,
    creatives: [{
      ad_name: adCopy.headline,
      ad_format: 'SINGLE_VIDEO',
      video_id: adCopy.mediaAssetId,
      ad_text: adCopy.primaryText,
      call_to_action: adCopy.cta,
      landing_page_url: linkUrl,
      identity_id: identityId,
      identity_type: 'CUSTOMIZED_USER',
    }],
    operation_status: 'DISABLE',
  };
}

// ---------- error classification ----------
//
// TikTok's API returns HTTP 200 for almost everything, including failures --
// the real signal is a non-zero `code` field alongside a `message` string.
// TikTok does not publish one single stable set of codes mapped to auth vs.
// billing vs. policy issues the way Meta's error 190 is documented, so this
// classifier matches on message content with an honest needs_attention
// fallback -- same approach as classifyMetaError and classifyGoogleAdsError.
function classifyTikTokError(body) {
  const code = body && typeof body.code === 'number' ? body.code : null;
  const message = ((body && body.message) || '').toLowerCase();

  if (message.includes('access token') || message.includes('access_token') || message.includes('authoriz') || message.includes('permission')) {
    return { state: 'needs_reauth', reason: 'tiktok_token_invalid_or_unauthorized', tiktokCode: code, message: (body && body.message) || 'TikTok authorization error' };
  }
  if (message.includes('balance') || message.includes('billing') || message.includes('fund') || message.includes('payment')) {
    return { state: 'billing_blocked', reason: 'tiktok_billing_issue', tiktokCode: code, message: (body && body.message) || 'TikTok billing error' };
  }
  if (message.includes('review') || message.includes('reject') || message.includes('polic') || message.includes('violat') || message.includes('disapprov')) {
    return { state: 'policy_blocked', reason: 'tiktok_policy_issue', tiktokCode: code, message: (body && body.message) || 'TikTok policy error' };
  }
  return { state: 'needs_attention', reason: 'tiktok_unclassified_error', tiktokCode: code, message: (body && body.message) || 'Unknown TikTok Marketing API error' };
}

// ---------- HTTP helper ----------

async function tiktokFetch(path, options) {
  const fetchFn = options.fetchImpl || defaultFetch;
  const url = TIKTOK_API_BASE + path;
  const response = await fetchFn(url, {
    method: options.method || 'POST',
    headers: {
      'Access-Token': options.accessToken,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json();
  if (!response.ok || (json && json.code !== 0)) {
    const classified = classifyTikTokError(json);
    const err = new Error(classified.message || ('TikTok Marketing API error at ' + path));
    err.tiktokClassified = classified;
    err.tiktokRawError = json;
    err.step = path;
    throw err;
  }
  return json.data;
}

async function pauseTikTokCampaign(externalCampaignId, conn, fetchImpl) {
  return tiktokFetch('/campaign/update/status/', {
    accessToken: conn.accessToken,
    fetchImpl,
    body: {
      advertiser_id: conn.advertiserId,
      campaign_ids: [externalCampaignId],
      operation_status: 'DISABLE',
    },
  });
}

async function syncTikTokCampaignSpend(externalCampaignId, conn, dateStr, fetchImpl) {
  const res = await tiktokFetch('/report/integrated/get/', {
    accessToken: conn.accessToken,
    fetchImpl,
    body: {
      advertiser_id: conn.advertiserId,
      report_type: 'BASIC',
      dimensions: ['campaign_id', 'stat_time_day'],
      metrics: ['spend'],
      data_level: 'AUCTION_CAMPAIGN',
      start_date: dateStr,
      end_date: dateStr,
      filtering: [{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify([externalCampaignId]) }],
      page: 1,
      page_size: 1,
    },
  });
  const row = (res && res.list && res.list[0]) || null;
  const spendDollars = row && row.metrics ? Number(row.metrics.spend) : 0;
  return {
    spendCents: Math.round((Number.isFinite(spendDollars) ? spendDollars : 0) * 100),
    date: dateStr,
  };
}

async function checkTikTokConnectionHealth(conn, fetchImpl) {
  try {
    const res = await tiktokFetch('/advertiser/info/', {
      accessToken: conn.accessToken,
      method: 'GET',
      fetchImpl,
      body: { advertiser_ids: JSON.stringify([conn.advertiserId]) },
    });
    const row = (res && res.list && res.list[0]) || null;
    return {
      healthy: true,
      accountId: row && row.advertiser_id,
      accountName: row && row.name,
    };
  } catch (err) {
    const classified = err.tiktokClassified || { state: 'needs_attention', reason: 'tiktok_unclassified_error', message: err.message };
    return Object.assign({ healthy: false }, classified);
  }
}

// ---------- orchestration ----------

async function launchTikTokCampaign(params, fetchImpl) {
  const campaign = params.campaign;
  const adCopy = params.adCopy;
  const conn = params.conn || {};
  const linkUrl = params.linkUrl;
  const { accessToken, advertiserId, identityId } = conn;

  if (!accessToken || !advertiserId) {
    const err = new Error('TikTok launch inputs incomplete: accessToken and advertiserId must both be provided');
    err.launchInputsIncomplete = true;
    throw err;
  }

  const campaignRes = await tiktokFetch('/campaign/create/', {
    accessToken,
    fetchImpl,
    body: buildCampaignPayload({ advertiserId, name: campaign.name, objective: campaign.objective, dailyBudgetCents: campaign.daily_budget_cents }),
  });
  const externalCampaignId = campaignRes.campaign_id;

  const adGroupRes = await tiktokFetch('/adgroup/create/', {
    accessToken,
    fetchImpl,
    body: buildAdGroupPayload({ advertiserId, campaignId: externalCampaignId, name: campaign.name + ' -- ad group', dailyBudgetCents: campaign.daily_budget_cents }),
  });
  const externalAdGroupId = adGroupRes.adgroup_id;

  // This throws honestly (missingMediaAsset) if adCopy has no real video/image
  // asset id -- see the file header. The campaign and ad group above are real
  // and already created (both DISABLE/paused), so a caller that hits this
  // error still has a real, inspectable, harmless partial result to work
  // from rather than nothing at all.
  const adRes = await tiktokFetch('/ad/create/', {
    accessToken,
    fetchImpl,
    body: buildAdPayload({ advertiserId, adgroupId: externalAdGroupId, adCopy, linkUrl, identityId }),
  });
  const externalAdIds = adRes.ad_ids;

  // Campaign, ad group, and ad are all created DISABLE (paused) -- every one
  // of the three must be flipped to ENABLE for anything to actually serve.
  // This step used to be missing entirely: the local ad_campaigns row was
  // patched to status:'active' in api/ads.js regardless of whether anything
  // on TikTok's side was ever actually enabled, so the two could silently
  // diverge. If any of these three calls fails, this function throws and
  // api/ads.js leaves the local campaign in pending_review (not active) --
  // the campaign/ad group/ad that already succeeded remain on TikTok, real
  // but still DISABLE, ready for a retry once the failure is fixed.
  // (These three endpoints follow TikTok's documented status-update
  // convention -- same as pauseTikTokCampaign's /campaign/update/status/ --
  // but, like every other real API call in this file, have never been
  // exercised against a live TikTok account; confirm before relying on
  // them.)
  await tiktokFetch('/campaign/update/status/', {
    accessToken, fetchImpl,
    body: { advertiser_id: advertiserId, campaign_ids: [externalCampaignId], operation_status: 'ENABLE' },
  });
  await tiktokFetch('/adgroup/update/status/', {
    accessToken, fetchImpl,
    body: { advertiser_id: advertiserId, adgroup_ids: [externalAdGroupId], operation_status: 'ENABLE' },
  });
  await tiktokFetch('/ad/update/status/', {
    accessToken, fetchImpl,
    body: { advertiser_id: advertiserId, ad_ids: externalAdIds, operation_status: 'ENABLE' },
  });

  return {
    externalCampaignId,
    externalAdGroupId,
    externalAdIds,
  };
}

export {
  TIKTOK_API_VERSION,
  OBJECTIVE_MAP,
  tiktokObjectiveFor,
  buildCampaignPayload,
  buildAdGroupPayload,
  buildAdPayload,
  classifyTikTokError,
  launchTikTokCampaign,
  pauseTikTokCampaign,
  syncTikTokCampaignSpend,
  checkTikTokConnectionHealth,
};
