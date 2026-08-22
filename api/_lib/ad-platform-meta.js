// api/_lib/ad-platform-meta.js
// Real Meta (Facebook + Instagram) Marketing API adapter -- Graph API v26.0
// (current as of 2026-08-03; Meta retires API versions on a rolling
// ~18-month cycle, see developers.facebook.com/docs/graph-api/changelog --
// confirm this is still the current version before relying on it).
//
// This module has never been exercised against a real Meta ad account --
// Chris has not yet finished his Meta developer app / Marketing API access
// setup on Meta's own side. Every function below takes an injectable
// fetchImpl so the request/response contract is verified here against
// realistic mocked responses (see test/ad-platform-meta.test.mjs). Per the
// build plan this step is NOT "done" until it has actually succeeded
// against Chris's real (small) test spend -- until then this is tested
// scaffolding, ready to go live the moment Chris finishes his Meta setup
// and adds his real access token as a Vercel project setting.

const GRAPH_API_VERSION = 'v26.0';
const GRAPH_API_BASE = 'https://graph.facebook.com/' + GRAPH_API_VERSION;

const defaultFetch = (...args) => fetch(...args);

// Meta migrated every campaign objective to the six ODAX ("Outcome-Driven
// Ads Experiences") values in 2022 -- still the current 6 objectives as of
// 2026. This mapping is well-established but unverified against a live
// account; confirm against Meta's ad-campaign-group reference docs before
// the first real campaign create call.
const OBJECTIVE_MAP = {
  lead_gen: 'OUTCOME_LEADS',
  traffic: 'OUTCOME_TRAFFIC',
  awareness: 'OUTCOME_AWARENESS',
  // "conversions" is ambiguous under ODAX -- OUTCOME_SALES is the closer
  // match for a construction lead-to-job flow than OUTCOME_ENGAGEMENT would
  // be, but flag this for Chris to confirm before first real use.
  conversions: 'OUTCOME_SALES',
};

function metaObjectiveFor(internalObjective) {
  const mapped = OBJECTIVE_MAP[internalObjective];
  if (!mapped) {
    const err = new Error('No Meta ODAX objective mapping for ' + internalObjective);
    err.unmappedObjective = true;
    throw err;
  }
  return mapped;
}

// ---------- request payload builders (pure -- no I/O, easy to unit test) ----------

function buildCampaignPayload({ name, objective, specialAdCategories }) {
  return {
    name,
    objective: metaObjectiveFor(objective),
    // Always created paused. The launch flow in api/ads.js only flips this
    // live after every create call in the chain below has succeeded --
    // never partially live.
    status: 'PAUSED',
    special_ad_categories: (specialAdCategories && specialAdCategories.length) ? specialAdCategories : [],
  };
}

function buildAdSetPayload({ name, campaignExternalId, dailyBudgetCents, targeting }) {
  return {
    name,
    campaign_id: campaignExternalId,
    // Graph API's daily_budget field is in the ad account's currency minor
    // unit -- cents for USD, which is exactly what dailyBudgetCents already is.
    daily_budget: Math.round(dailyBudgetCents),
    billing_event: 'IMPRESSIONS',
    // Hardcoded for lead-gen-style campaigns, the plan's first real use
    // case -- other objectives need their own optimization_goal before
    // they're used for real (traffic/awareness/conversions each need a
    // different valid pairing).
    optimization_goal: 'LEAD_GENERATION',
    targeting: targeting || { geo_locations: { countries: ['US'] } },
    status: 'PAUSED',
  };
}

function buildCreativePayload({ pageId, adCopy, linkUrl }) {
  return {
    name: adCopy.headline + ' -- creative',
    object_story_spec: {
      page_id: pageId,
      link_data: {
        message: adCopy.primaryText,
        link: linkUrl,
        name: adCopy.headline,
        description: adCopy.description,
        call_to_action: { type: adCopy.cta },
      },
    },
  };
}

function buildAdPayload({ name, adSetExternalId, creativeExternalId }) {
  return {
    name,
    adset_id: adSetExternalId,
    creative: { creative_id: creativeExternalId },
    status: 'PAUSED',
  };
}

// ---------- error classification ----------
//
// Error 190 / OAuthException is well-documented: an invalid, expired, or
// revoked access token. Beyond that, Meta does not publish a stable numeric
// code that distinguishes a billing-disabled ad account from a
// policy-disabled one -- both surface as prose in error.message /
// error.error_user_title. This classifier matches on that prose with a
// safe needs_attention fallback for anything it doesn't recognize, rather
// than guessing a code that may not exist. Tune these patterns against
// Chris's real first error the moment one occurs.
function classifyMetaError(errorBody) {
  const err = (errorBody && errorBody.error) || {};
  const code = err.code;
  const message = ((err.message || '') + ' ' + (err.error_user_title || '') + ' ' + (err.error_user_msg || '')).toLowerCase();

  if (code === 190 || err.type === 'OAuthException') {
    return { state: 'needs_reauth', reason: 'meta_token_invalid_or_expired', metaCode: code, message: err.message };
  }
  if (message.includes('payment') || message.includes('billing')) {
    return { state: 'billing_blocked', reason: 'meta_billing_issue', metaCode: code, message: err.message };
  }
  if (message.includes('policy') || message.includes('disapproved') || message.includes('restricted')) {
    return { state: 'policy_blocked', reason: 'meta_policy_issue', metaCode: code, message: err.message };
  }
  return { state: 'needs_attention', reason: 'meta_unclassified_error', metaCode: code, message: err.message || 'Unknown Meta API error' };
}

// ---------- HTTP helper ----------

async function metaFetch(path, options) {
  const method = options.method;
  const body = options.body;
  const accessToken = options.accessToken;
  const fetchFn = options.fetchImpl || defaultFetch;
  const url = new URL(GRAPH_API_BASE + path);
  let response;
  if (!method || method === 'GET') {
    url.searchParams.set('access_token', accessToken);
    response = await fetchFn(url.toString(), { method: 'GET' });
  } else {
    const form = Object.assign({}, body, { access_token: accessToken });
    const params = new URLSearchParams();
    for (const key of Object.keys(form)) {
      const value = form[key];
      params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    response = await fetchFn(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  }
  const json = await response.json();
  if (!response.ok || json.error) {
    const classified = classifyMetaError(json);
    const err = new Error(classified.message || ('Meta API error at ' + path));
    err.metaClassified = classified;
    err.metaRawError = json.error;
    err.step = path;
    throw err;
  }
  return json;
}

async function pauseMetaCampaign(externalCampaignId, conn, fetchImpl) {
  return metaFetch('/' + externalCampaignId, {
    method: 'POST',
    accessToken: conn.accessToken,
    fetchImpl,
    body: { status: 'PAUSED' },
  });
}

async function syncMetaCampaignSpend(externalCampaignId, conn, dateStr, fetchImpl) {
  const timeRange = JSON.stringify({ since: dateStr, until: dateStr });
  const res = await metaFetch('/' + externalCampaignId + '/insights?fields=spend&time_range=' + encodeURIComponent(timeRange), {
    method: 'GET',
    accessToken: conn.accessToken,
    fetchImpl,
  });
  const row = (res.data && res.data[0]) || null;
  const spendDollars = row ? parseFloat(row.spend) : 0;
  return {
    spendCents: Math.round((Number.isFinite(spendDollars) ? spendDollars : 0) * 100),
    date: dateStr,
  };
}

async function checkMetaConnectionHealth(conn, fetchImpl) {
  try {
    const res = await metaFetch('/act_' + conn.adAccountId, {
      method: 'GET',
      accessToken: conn.accessToken,
      fetchImpl,
    });
    return { healthy: true, accountId: res.id, accountName: res.name };
  } catch (err) {
    const classified = err.metaClassified || { state: 'needs_attention', reason: 'meta_unclassified_error', message: err.message };
    return Object.assign({ healthy: false }, classified);
  }
}

// ---------- orchestration ----------

async function launchMetaCampaign(params, fetchImpl) {
  const campaign = params.campaign;
  const adCopy = params.adCopy;
  const conn = params.conn || {};
  const linkUrl = params.linkUrl;
  const accessToken = conn.accessToken;
  const adAccountId = conn.adAccountId;
  const pageId = conn.pageId;

  if (!accessToken || !adAccountId || !pageId) {
    const err = new Error('Meta launch inputs incomplete: accessToken, adAccountId, and pageId must all be provided');
    err.launchInputsIncomplete = true;
    throw err;
  }

  const campaignRes = await metaFetch('/act_' + adAccountId + '/campaigns', {
    method: 'POST',
    accessToken,
    fetchImpl,
    body: buildCampaignPayload({ name: campaign.name, objective: campaign.objective }),
  });
  const externalCampaignId = campaignRes.id;

  const adSetRes = await metaFetch('/act_' + adAccountId + '/adsets', {
    method: 'POST',
    accessToken,
    fetchImpl,
    body: buildAdSetPayload({
      name: campaign.name + ' -- ad set',
      campaignExternalId: externalCampaignId,
      dailyBudgetCents: campaign.daily_budget_cents,
      targeting: campaign.targeting_summary && campaign.targeting_summary.metaTargeting,
    }),
  });
  const externalAdSetId = adSetRes.id;

  const creativeRes = await metaFetch('/act_' + adAccountId + '/adcreatives', {
    method: 'POST',
    accessToken,
    fetchImpl,
    body: buildCreativePayload({ pageId, adCopy, linkUrl }),
  });
  const externalCreativeId = creativeRes.id;

  const adRes = await metaFetch('/act_' + adAccountId + '/ads', {
    method: 'POST',
    accessToken,
    fetchImpl,
    body: buildAdPayload({
      name: campaign.name + ' -- ad',
      adSetExternalId: externalAdSetId,
      creativeExternalId: externalCreativeId,
    }),
  });
  const externalAdId = adRes.id;

  // Every object above is created PAUSED -- Meta requires the campaign, the
  // ad set, AND the ad itself to all be ACTIVE before anything actually
  // serves (a paused ad set under an active campaign still spends nothing).
  // This activation step used to be missing entirely: the local ad_campaigns
  // row was patched to status:'active' in api/ads.js regardless of whether
  // anything on Meta's side ever actually went live, so the two could
  // silently diverge. If any of these three calls fails, this function
  // throws and api/ads.js leaves the local campaign in pending_review (not
  // active) rather than lying about it -- the campaign/ad set/ad objects
  // that already succeeded remain on Meta, real but still paused, ready for
  // a retry once the failure is fixed.
  await metaFetch('/' + externalCampaignId, { method: 'POST', accessToken, fetchImpl, body: { status: 'ACTIVE' } });
  await metaFetch('/' + externalAdSetId, { method: 'POST', accessToken, fetchImpl, body: { status: 'ACTIVE' } });
  await metaFetch('/' + externalAdId, { method: 'POST', accessToken, fetchImpl, body: { status: 'ACTIVE' } });

  return {
    externalCampaignId,
    externalAdSetId,
    externalCreativeId,
    externalAdId,
  };
}

export {
  GRAPH_API_VERSION,
  OBJECTIVE_MAP,
  metaObjectiveFor,
  buildCampaignPayload,
  buildAdSetPayload,
  buildCreativePayload,
  buildAdPayload,
  classifyMetaError,
  launchMetaCampaign,
  pauseMetaCampaign,
  syncMetaCampaignSpend,
  checkMetaConnectionHealth,
};
