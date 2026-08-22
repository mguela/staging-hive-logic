import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
} from '../api/_lib/ad-platform-google.js';

function fakeFetch(responses) {
  const fn = async (url, opts) => {
    const entry = responses[fn.calls];
    fn.calls += 1;
    if (!entry) throw new Error('fakeFetch: no response queued for call ' + fn.calls);
    return {
      ok: entry.ok !== false,
      status: entry.status || (entry.ok === false ? 400 : 200),
      json: async () => entry.json,
    };
  };
  fn.calls = 0;
  return fn;
}

const baseConn = {
  developerToken: 'dev-tok',
  customerId: '1112223333',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-tok',
};

test('googleObjectiveFor maps every known internal objective to a real channel/bidding pair', () => {
  assert.deepEqual(googleObjectiveFor('lead_gen'), { advertisingChannelType: 'SEARCH', biddingField: 'maximizeConversions' });
  assert.deepEqual(googleObjectiveFor('traffic'), { advertisingChannelType: 'SEARCH', biddingField: 'maximizeClicks' });
  assert.deepEqual(googleObjectiveFor('awareness'), { advertisingChannelType: 'DISPLAY', biddingField: 'targetImpressionShare' });
  assert.deepEqual(googleObjectiveFor('conversions'), { advertisingChannelType: 'SEARCH', biddingField: 'maximizeConversions' });
});

test('googleObjectiveFor throws rather than silently guessing an unmapped objective', () => {
  assert.throws(() => googleObjectiveFor('go_viral'));
});

test('buildCampaignBudgetPayload converts cents to real Google Ads micros', () => {
  const payload = buildCampaignBudgetPayload({ name: 'HVAC leads -- budget', dailyBudgetCents: 2000 });
  assert.equal(payload.amountMicros, '20000000');
  assert.equal(payload.deliveryMethod, 'STANDARD');
});

test('buildCampaignPayload is always created paused with the mapped channel type and bidding field', () => {
  const payload = buildCampaignPayload({ name: 'HVAC leads', objective: 'lead_gen', campaignBudgetResourceName: 'customers/1/campaignBudgets/9' });
  assert.equal(payload.status, 'PAUSED');
  assert.equal(payload.advertisingChannelType, 'SEARCH');
  assert.equal(payload.campaignBudget, 'customers/1/campaignBudgets/9');
  assert.deepEqual(payload.maximizeConversions, {});
});

test('buildCampaignPayload fills real required fields for the awareness/targetImpressionShare bidding strategy', () => {
  const payload = buildCampaignPayload({ name: 'Brand awareness', objective: 'awareness', campaignBudgetResourceName: 'customers/1/campaignBudgets/9' });
  assert.equal(payload.advertisingChannelType, 'DISPLAY');
  assert.equal(payload.targetImpressionShare.location, 'ANYWHERE_ON_PAGE');
});

test('buildAdGroupPayload links the real campaign resource name', () => {
  const payload = buildAdGroupPayload({ name: 'ad group', campaignResourceName: 'customers/1/campaigns/2' });
  assert.equal(payload.campaign, 'customers/1/campaigns/2');
  assert.equal(payload.status, 'ENABLED');
});

test('buildResponsiveSearchAdPayload is always created paused and truncates to Google Ads real character caps', () => {
  const payload = buildResponsiveSearchAdPayload({
    adGroupResourceName: 'customers/1/adGroups/3',
    adCopy: {
      headline: 'A'.repeat(50),
      primaryText: 'B'.repeat(120),
      description: 'C'.repeat(50),
      cta: 'CALL_NOW',
    },
    linkUrl: 'https://ghgrp.net',
  });
  assert.equal(payload.status, 'PAUSED');
  assert.equal(payload.ad.finalUrls[0], 'https://ghgrp.net');
  assert.equal(payload.ad.responsiveSearchAd.headlines[0].text.length, 30);
  assert.equal(payload.ad.responsiveSearchAd.descriptions[0].text.length, 90);
});

test('classifyGoogleAdsError: an authenticationError maps to needs_reauth', () => {
  const result = classifyGoogleAdsError({
    error: { details: [{ errors: [{ errorCode: { authenticationError: 'OAUTH_TOKEN_INVALID' }, message: 'Invalid token' }] }] },
  });
  assert.equal(result.state, 'needs_reauth');
  assert.equal(result.googleErrorCode, 'OAUTH_TOKEN_INVALID');
});

test('classifyGoogleAdsError: a billingSetupError maps to billing_blocked', () => {
  const result = classifyGoogleAdsError({
    error: { details: [{ errors: [{ errorCode: { billingSetupError: 'NO_BILLING_SETUP' }, message: 'Billing not configured' }] }] },
  });
  assert.equal(result.state, 'billing_blocked');
});

test('classifyGoogleAdsError: a policyViolationError maps to policy_blocked', () => {
  const result = classifyGoogleAdsError({
    error: { details: [{ errors: [{ errorCode: { policyViolationError: 'PROHIBITED_CONTENT' }, message: 'Ad disapproved' }] }] },
  });
  assert.equal(result.state, 'policy_blocked');
});

test('classifyGoogleAdsError: an unrecognized error honestly falls back to needs_attention, not a guess', () => {
  const result = classifyGoogleAdsError({ error: { details: [{ errors: [{ errorCode: { internalError: 'TRANSIENT_ERROR' }, message: 'Something else' }] }] } });
  assert.equal(result.state, 'needs_attention');
});

test('getGoogleAccessToken returns the real refreshed access token', async () => {
  const fetchImpl = fakeFetch([{ json: { access_token: 'fresh-token', expires_in: 3599 } }]);
  const token = await getGoogleAccessToken(baseConn, fetchImpl);
  assert.equal(token, 'fresh-token');
});

test('getGoogleAccessToken classifies a real refresh failure as needs_reauth instead of throwing an opaque error', async () => {
  const fetchImpl = fakeFetch([{ ok: false, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }]);
  await assert.rejects(
    () => getGoogleAccessToken(baseConn, fetchImpl),
    (err) => err.googleAdsClassified.state === 'needs_reauth'
  );
});

test('launchGoogleAdsCampaign refuses to call out with incomplete launch inputs', async () => {
  await assert.rejects(
    () => launchGoogleAdsCampaign({ campaign: { name: 'x', objective: 'lead_gen' }, adCopy: {}, conn: { developerToken: 'd' } }),
    (err) => err.launchInputsIncomplete === true
  );
});

test('launchGoogleAdsCampaign refreshes the token, then chains budget -> campaign -> ad group -> ad -> enable campaign -> enable ad, and returns every real external id', async () => {
  const fetchImpl = fakeFetch([
    { json: { access_token: 'fresh-token' } },
    { json: { results: [{ resourceName: 'customers/1112223333/campaignBudgets/1' }] } },
    { json: { results: [{ resourceName: 'customers/1112223333/campaigns/2' }] } },
    { json: { results: [{ resourceName: 'customers/1112223333/adGroups/3' }] } },
    { json: { results: [{ resourceName: 'customers/1112223333/adGroupAds/4' }] } },
    { json: { results: [{ resourceName: 'customers/1112223333/campaigns/2' }] } }, // enable campaign
    { json: { results: [{ resourceName: 'customers/1112223333/adGroupAds/4' }] } }, // enable ad
  ]);
  const result = await launchGoogleAdsCampaign({
    campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
    adCopy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'CALL_NOW' },
    conn: baseConn,
    linkUrl: 'https://ghgrp.net',
  }, fetchImpl);
  assert.equal(result.externalCampaignId, '2');
  assert.equal(result.externalCampaignBudgetResourceName, 'customers/1112223333/campaignBudgets/1');
  assert.equal(result.externalAdGroupResourceName, 'customers/1112223333/adGroups/3');
  assert.equal(result.externalAdResourceName, 'customers/1112223333/adGroupAds/4');
  assert.equal(fetchImpl.calls, 7);
});

test('launchGoogleAdsCampaign stops immediately and classifies the error when a create step fails', async () => {
  const fetchImpl = fakeFetch([
    { json: { access_token: 'fresh-token' } },
    { json: { results: [{ resourceName: 'customers/1112223333/campaignBudgets/1' }] } },
    { ok: false, json: { error: { details: [{ errors: [{ errorCode: { policyViolationError: 'PROHIBITED_CONTENT' }, message: 'Campaign name violates policy' }] }] } } },
  ]);
  await assert.rejects(
    () => launchGoogleAdsCampaign({
      campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
      adCopy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'CALL_NOW' },
      conn: baseConn,
    }, fetchImpl),
    (err) => err.googleAdsClassified.state === 'policy_blocked'
  );
  assert.equal(fetchImpl.calls, 3);
});

test('launchGoogleAdsCampaign creates every real object but still throws, leaving them paused, if enabling itself fails', async () => {
  const fetchImpl = fakeFetch([
    { json: { access_token: 'fresh-token' } },
    { json: { results: [{ resourceName: 'customers/1112223333/campaignBudgets/1' }] } },
    { json: { results: [{ resourceName: 'customers/1112223333/campaigns/2' }] } },
    { json: { results: [{ resourceName: 'customers/1112223333/adGroups/3' }] } },
    { json: { results: [{ resourceName: 'customers/1112223333/adGroupAds/4' }] } },
    { ok: false, json: { error: { details: [{ errors: [{ errorCode: { authenticationError: 'OAUTH_TOKEN_INVALID' }, message: 'Invalid token' }] }] } } }, // enable campaign fails
  ]);
  await assert.rejects(
    () => launchGoogleAdsCampaign({
      campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
      adCopy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'CALL_NOW' },
      conn: baseConn,
    }, fetchImpl),
    (err) => err.googleAdsClassified.state === 'needs_reauth'
  );
  assert.equal(fetchImpl.calls, 6);
});

test('pauseGoogleAdsCampaign refreshes the token then sends a real PAUSED status update', async () => {
  const fetchImpl = fakeFetch([
    { json: { access_token: 'fresh-token' } },
    { json: { results: [{ resourceName: 'customers/1112223333/campaigns/2' }] } },
  ]);
  const result = await pauseGoogleAdsCampaign('2', baseConn, fetchImpl);
  assert.equal(result.results[0].resourceName, 'customers/1112223333/campaigns/2');
});

test('syncGoogleAdsCampaignSpend parses real cost_micros into cents', async () => {
  const fetchImpl = fakeFetch([
    { json: { access_token: 'fresh-token' } },
    { json: [{ results: [{ metrics: { costMicros: '43210000' } }] }] },
  ]);
  const result = await syncGoogleAdsCampaignSpend('2', baseConn, '2026-08-03', fetchImpl);
  assert.equal(result.spendCents, 4321);
  assert.equal(result.date, '2026-08-03');
});

test('syncGoogleAdsCampaignSpend honestly reports zero when there is no real spend row', async () => {
  const fetchImpl = fakeFetch([
    { json: { access_token: 'fresh-token' } },
    { json: [{ results: [] }] },
  ]);
  const result = await syncGoogleAdsCampaignSpend('2', baseConn, '2026-08-03', fetchImpl);
  assert.equal(result.spendCents, 0);
});

test('checkGoogleAdsConnectionHealth reports healthy on a real successful account read', async () => {
  const fetchImpl = fakeFetch([
    { json: { access_token: 'fresh-token' } },
    { json: [{ results: [{ customer: { id: '1112223333', descriptiveName: 'GHGRP Ads' } }] }] },
  ]);
  const result = await checkGoogleAdsConnectionHealth(baseConn, fetchImpl);
  assert.equal(result.healthy, true);
  assert.equal(result.accountName, 'GHGRP Ads');
});

test('checkGoogleAdsConnectionHealth classifies a real token failure instead of throwing', async () => {
  const fetchImpl = fakeFetch([
    { ok: false, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
  ]);
  const result = await checkGoogleAdsConnectionHealth(baseConn, fetchImpl);
  assert.equal(result.healthy, false);
  assert.equal(result.state, 'needs_reauth');
});
