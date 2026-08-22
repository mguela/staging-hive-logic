// api/_lib/ad-platform-google.js
// Real Google Ads API adapter -- REST interface, API version v17 (confirm
// this is still current before relying on it -- Google retires Ads API
// versions roughly every 2-3 quarters, see
// developers.google.com/google-ads/api/docs/release-notes).
//
// This module has never been exercised against a real Google Ads account --
// Chris has not yet finished Google Ads API developer-token approval or
// OAuth client setup on Google's own side. Every function below takes an
// injectable fetchImpl so the request/response contract is verified here
// against realistic mocked responses (see test/ad-platform-google.test.mjs).
// Per the build plan this is NOT "done" until it has actually succeeded
// against Chris's real (small) test spend -- until then this is tested
// scaffolding, ready to go live the moment Chris finishes Google Ads setup
// and adds the real credentials as a Vercel project setting.
//
// Google Ads requires FOUR real secrets, not one like Meta -- a developer
// token, an OAuth client id + secret, and a refresh token (access tokens
// expire hourly and must be refreshed on every call; there is no long-lived
// System User token like Meta has). Rather than adding four new env-var-name
// columns to ad_platform_connections, this adapter expects
// ad_platform_connections.env_var_name to point to a SINGLE Vercel env var
// whose value is a JSON blob:
//   {"developerToken":"...","clientId":"...","clientSecret":"...","refreshToken":"..."}
// ad_platform_connections.ad_account_id is the Google Ads Customer ID (10
// digits, no dashes). ad_platform_connections.business_account_id is the
// optional MCC (manager account) id, sent as the login-customer-id header
// when present -- most single-business Google Ads setups do not need one.

const GOOGLE_ADS_API_VERSION = 'v17';
const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com/' + GOOGLE_ADS_API_VERSION;
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const defaultFetch = (...args) => fetch(...args);

// Google Ads has no single "objective" concept like Meta's ODAX -- a
// campaign is defined by an advertising_channel_type plus a bidding
// strategy goal. This mapping is a judgment call flagged for Chris to
// confirm before first real use, same as Meta's ODAX mapping was.
const OBJECTIVE_MAP = {
  lead_gen: { advertisingChannelType: 'SEARCH', biddingField: 'maximizeConversions' },
  traffic: { advertisingChannelType: 'SEARCH', biddingField: 'maximizeClicks' },
  // Awareness campaigns in Google Ads are conventionally Display/Video with
  // impression-based bidding rather than a search campaign.
  awareness: { advertisingChannelType: 'DISPLAY', biddingField: 'targetImpressionShare' },
  conversions: { advertisingChannelType: 'SEARCH', biddingField: 'maximizeConversions' },
};

function googleObjectiveFor(internalObjective) {
  const mapped = OBJECTIVE_MAP[internalObjective];
  if (!mapped) {
    const err = new Error('No Google Ads channel/bidding mapping for ' + internalObjective);
    err.unmappedObjective = true;
    throw err;
  }
  return mapped;
}

// ---------- request payload builders (pure -- no I/O, easy to unit test) ----------

function buildCampaignBudgetPayload({ name, dailyBudgetCents }) {
  return {
    name,
    // Google Ads bills in micros -- 1,000,000 micros = 1 unit of the
    // account's currency. dailyBudgetCents is already in cents (1/100 of a
    // unit), so micros = cents * 10,000. Sent as a string per the Google
    // Ads API's int64 wire format.
    amountMicros: String(Math.round(dailyBudgetCents * 10000)),
    deliveryMethod: 'STANDARD',
  };
}

function buildCampaignPayload({ name, objective, campaignBudgetResourceName }) {
  const { advertisingChannelType, biddingField } = googleObjectiveFor(objective);
  const payload = {
    name,
    advertisingChannelType,
    campaignBudget: campaignBudgetResourceName,
    // Always created PAUSED. Same safety rule as the Meta adapter -- never
    // create a campaign that could go live before every step in the chain
    // below has succeeded.
    status: 'PAUSED',
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true },
  };
  // targetImpressionShare needs more real fields than the other bidding
  // strategies -- hardcoded to a conservative default here, flagged for
  // Chris to tune once an awareness campaign is actually needed.
  payload[biddingField] = biddingField === 'targetImpressionShare'
    ? { location: 'ANYWHERE_ON_PAGE', targetImpressionShareMicros: '100000', cpcBidCeilingMicros: '2000000' }
    : {};
  return payload;
}

function buildAdGroupPayload({ name, campaignResourceName }) {
  return {
    name,
    campaign: campaignResourceName,
    status: 'ENABLED',
    type: 'SEARCH_STANDARD',
  };
}

function buildResponsiveSearchAdPayload({ adGroupResourceName, adCopy, linkUrl }) {
  return {
    adGroup: adGroupResourceName,
    // Always created PAUSED, same reasoning as buildCampaignPayload.
    status: 'PAUSED',
    ad: {
      finalUrls: [linkUrl],
      responsiveSearchAd: {
        // Google Ads enforces real character caps: 30 for headlines, 90 for
        // descriptions. Truncating here rather than letting the API reject
        // the whole ad on a too-long field the caller didn't expect.
        headlines: [
          { text: adCopy.headline.slice(0, 30) },
          { text: adCopy.description.slice(0, 30) },
        ],
        descriptions: [
          { text: adCopy.primaryText.slice(0, 90) },
        ],
      },
    },
  };
}

// ---------- error classification ----------
//
// Google Ads' REST error shape nests the real error code under
// error.details[0].errors[0].errorCode, which is itself an object whose
// single key names the error category (e.g. { authenticationError:
// 'OAUTH_TOKEN_INVALID' }). This classifier matches on that category name
// with a prose fallback, plus an honest needs_attention default for
// anything unrecognized -- same approach as classifyMetaError, since Google
// likewise does not publish one single stable numeric code to branch on.
function classifyGoogleAdsError(errorBody) {
  const err = (errorBody && errorBody.error) || {};
  const details = (err.details && err.details[0] && err.details[0].errors) || [];
  const firstError = details[0] || {};
  const errorCodeObj = firstError.errorCode || {};
  const codeCategory = Object.keys(errorCodeObj)[0] || null;
  const codeValue = codeCategory ? errorCodeObj[codeCategory] : null;
  const message = ((firstError.message || err.message || '') + '').toLowerCase();

  if (codeCategory === 'authenticationError' || codeCategory === 'authorizationError') {
    return { state: 'needs_reauth', reason: 'google_ads_token_invalid_or_unauthorized', googleErrorCode: codeValue, message: firstError.message || err.message };
  }
  if (codeCategory === 'billingSetupError' || codeCategory === 'paymentsAccountError' || message.includes('billing') || message.includes('payment')) {
    return { state: 'billing_blocked', reason: 'google_ads_billing_issue', googleErrorCode: codeValue, message: firstError.message || err.message };
  }
  if (codeCategory === 'policyViolationError' || codeCategory === 'policyFindingError' || message.includes('policy') || message.includes('disapproved')) {
    return { state: 'policy_blocked', reason: 'google_ads_policy_issue', googleErrorCode: codeValue, message: firstError.message || err.message };
  }
  return { state: 'needs_attention', reason: 'google_ads_unclassified_error', googleErrorCode: codeValue, message: firstError.message || err.message || 'Unknown Google Ads API error' };
}

// ---------- OAuth + HTTP helpers ----------

// Google Ads access tokens expire in about an hour and there is no
// long-lived token like Meta's System User token -- every real call in this
// adapter refreshes first. conn must carry { clientId, clientSecret,
// refreshToken } (all read from the single JSON-blob env var, see header).
async function getGoogleAccessToken(conn, fetchImpl) {
  const fetchFn = fetchImpl || defaultFetch;
  const params = new URLSearchParams({
    client_id: conn.clientId,
    client_secret: conn.clientSecret,
    refresh_token: conn.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetchFn(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await response.json();
  if (!response.ok || json.error) {
    const err = new Error(json.error_description || json.error || 'Google OAuth token refresh failed');
    err.googleAdsClassified = { state: 'needs_reauth', reason: 'google_oauth_refresh_failed', message: err.message };
    throw err;
  }
  return json.access_token;
}

async function googleAdsFetch(customerId, path, options) {
  const fetchFn = options.fetchImpl || defaultFetch;
  const url = GOOGLE_ADS_API_BASE + '/customers/' + customerId + path;
  const headers = {
    Authorization: 'Bearer ' + options.accessToken,
    'developer-token': options.developerToken,
    'Content-Type': 'application/json',
  };
  if (options.loginCustomerId) headers['login-customer-id'] = options.loginCustomerId;
  const response = await fetchFn(url, {
    method: options.method || 'POST',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json();
  if (!response.ok || (json && !Array.isArray(json) && json.error)) {
    const classified = classifyGoogleAdsError(json);
    const err = new Error(classified.message || ('Google Ads API error at ' + path));
    err.googleAdsClassified = classified;
    err.googleAdsRawError = json && json.error;
    err.step = path;
    throw err;
  }
  return json;
}

async function pauseGoogleAdsCampaign(externalCampaignId, conn, fetchImpl) {
  const accessToken = await getGoogleAccessToken(conn, fetchImpl);
  return googleAdsFetch(conn.customerId, '/campaigns:mutate', {
    accessToken,
    developerToken: conn.developerToken,
    loginCustomerId: conn.loginCustomerId,
    fetchImpl,
    body: {
      operations: [{
        update: { resourceName: 'customers/' + conn.customerId + '/campaigns/' + externalCampaignId, status: 'PAUSED' },
        updateMask: 'status',
      }],
    },
  });
}

async function syncGoogleAdsCampaignSpend(externalCampaignId, conn, dateStr, fetchImpl) {
  const accessToken = await getGoogleAccessToken(conn, fetchImpl);
  const query = 'SELECT metrics.cost_micros FROM campaign WHERE campaign.id = ' + externalCampaignId + " AND segments.date = '" + dateStr + "'";
  const res = await googleAdsFetch(conn.customerId, '/googleAds:searchStream', {
    accessToken,
    developerToken: conn.developerToken,
    loginCustomerId: conn.loginCustomerId,
    fetchImpl,
    body: { query },
  });
  // searchStream returns an array of result batches; each batch carries a
  // `results` array. Real usage streams multiple batches for large result
  // sets -- a single campaign/single day query realistically fits in one.
  const batch = (Array.isArray(res) ? res[0] : res) || {};
  const row = (batch.results && batch.results[0]) || null;
  const costMicros = row && row.metrics ? Number(row.metrics.costMicros) : 0;
  return {
    spendCents: Math.round((Number.isFinite(costMicros) ? costMicros : 0) / 10000),
    date: dateStr,
  };
}

async function checkGoogleAdsConnectionHealth(conn, fetchImpl) {
  try {
    const accessToken = await getGoogleAccessToken(conn, fetchImpl);
    const res = await googleAdsFetch(conn.customerId, '/googleAds:searchStream', {
      accessToken,
      developerToken: conn.developerToken,
      loginCustomerId: conn.loginCustomerId,
      fetchImpl,
      body: { query: 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1' },
    });
    const batch = (Array.isArray(res) ? res[0] : res) || {};
    const row = (batch.results && batch.results[0]) || null;
    return {
      healthy: true,
      accountId: row && row.customer && row.customer.id,
      accountName: row && row.customer && row.customer.descriptiveName,
    };
  } catch (err) {
    const classified = err.googleAdsClassified || { state: 'needs_attention', reason: 'google_ads_unclassified_error', message: err.message };
    return Object.assign({ healthy: false }, classified);
  }
}

// ---------- orchestration ----------

async function launchGoogleAdsCampaign(params, fetchImpl) {
  const campaign = params.campaign;
  const adCopy = params.adCopy;
  const conn = params.conn || {};
  const linkUrl = params.linkUrl;
  const { developerToken, customerId, loginCustomerId, clientId, clientSecret, refreshToken } = conn;

  if (!developerToken || !customerId || !clientId || !clientSecret || !refreshToken) {
    const err = new Error('Google Ads launch inputs incomplete: developerToken, customerId, clientId, clientSecret, and refreshToken must all be provided');
    err.launchInputsIncomplete = true;
    throw err;
  }

  const accessToken = await getGoogleAccessToken(conn, fetchImpl);

  const budgetRes = await googleAdsFetch(customerId, '/campaignBudgets:mutate', {
    accessToken, developerToken, loginCustomerId, fetchImpl,
    body: { operations: [{ create: buildCampaignBudgetPayload({ name: campaign.name + ' -- budget', dailyBudgetCents: campaign.daily_budget_cents }) }] },
  });
  const campaignBudgetResourceName = budgetRes.results[0].resourceName;

  const campaignRes = await googleAdsFetch(customerId, '/campaigns:mutate', {
    accessToken, developerToken, loginCustomerId, fetchImpl,
    body: { operations: [{ create: buildCampaignPayload({ name: campaign.name, objective: campaign.objective, campaignBudgetResourceName }) }] },
  });
  const campaignResourceName = campaignRes.results[0].resourceName;
  const externalCampaignId = campaignResourceName.split('/').pop();

  const adGroupRes = await googleAdsFetch(customerId, '/adGroups:mutate', {
    accessToken, developerToken, loginCustomerId, fetchImpl,
    body: { operations: [{ create: buildAdGroupPayload({ name: campaign.name + ' -- ad group', campaignResourceName }) }] },
  });
  const adGroupResourceName = adGroupRes.results[0].resourceName;

  const adRes = await googleAdsFetch(customerId, '/adGroupAds:mutate', {
    accessToken, developerToken, loginCustomerId, fetchImpl,
    body: { operations: [{ create: buildResponsiveSearchAdPayload({ adGroupResourceName, adCopy, linkUrl }) }] },
  });
  const adResourceName = adRes.results[0].resourceName;

  // The campaign and the ad are both created PAUSED (buildCampaignPayload /
  // buildResponsiveSearchAdPayload); the ad group is created ENABLED
  // (buildAdGroupPayload) since Google Ads has no concept of a "paused ad
  // group" blocking spend the way Meta's ad sets do. Both PAUSED objects
  // must be flipped to ENABLED for anything to actually serve. This step
  // used to be missing entirely -- the local ad_campaigns row was patched to
  // status:'active' in api/ads.js regardless of whether the real Google Ads
  // objects were ever enabled, so the two could silently diverge. If either
  // enable call fails, this function throws and api/ads.js leaves the local
  // campaign in pending_review (not active) -- the campaign/ad group/ad that
  // already succeeded remain on Google Ads, real but still paused, ready for
  // a retry once the failure is fixed.
  await googleAdsFetch(customerId, '/campaigns:mutate', {
    accessToken, developerToken, loginCustomerId, fetchImpl,
    body: { operations: [{ update: { resourceName: campaignResourceName, status: 'ENABLED' }, updateMask: 'status' }] },
  });
  await googleAdsFetch(customerId, '/adGroupAds:mutate', {
    accessToken, developerToken, loginCustomerId, fetchImpl,
    body: { operations: [{ update: { resourceName: adResourceName, status: 'ENABLED' }, updateMask: 'status' }] },
  });

  return {
    externalCampaignId,
    externalCampaignBudgetResourceName: campaignBudgetResourceName,
    externalAdGroupResourceName: adGroupResourceName,
    externalAdResourceName: adResourceName,
  };
}

export {
  GOOGLE_ADS_API_VERSION,
  OBJECTIVE_MAP,
  googleObjectiveFor,
  buildCampaignBudgetPayload,
  buildCampaignPayload,
  buildAdGroupPayload,
  buildResponsiveSearchAdPayload,
  classifyGoogleAdsError,
  getGoogleAccessToken,
  launchGoogleAdsCampaign,
  pauseGoogleAdsCampaign,
  syncGoogleAdsCampaignSpend,
  checkGoogleAdsConnectionHealth,
};
