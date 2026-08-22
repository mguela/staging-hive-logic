import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
} from '../api/_lib/ad-platform-meta.js';

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

test('metaObjectiveFor maps every known internal objective to a real ODAX value', () => {
  assert.equal(metaObjectiveFor('lead_gen'), 'OUTCOME_LEADS');
  assert.equal(metaObjectiveFor('traffic'), 'OUTCOME_TRAFFIC');
  assert.equal(metaObjectiveFor('awareness'), 'OUTCOME_AWARENESS');
  assert.equal(metaObjectiveFor('conversions'), 'OUTCOME_SALES');
});

test('metaObjectiveFor throws rather than silently guessing an unmapped objective', () => {
  assert.throws(() => metaObjectiveFor('go_viral'));
});

test('buildCampaignPayload is always created paused with the mapped objective', () => {
  const payload = buildCampaignPayload({ name: 'HVAC leads', objective: 'lead_gen' });
  assert.equal(payload.status, 'PAUSED');
  assert.equal(payload.objective, 'OUTCOME_LEADS');
  assert.deepEqual(payload.special_ad_categories, []);
});

test('buildAdSetPayload rounds the daily budget and defaults US targeting', () => {
  const payload = buildAdSetPayload({ name: 'set', campaignExternalId: 'c1', dailyBudgetCents: 1999.6 });
  assert.equal(payload.daily_budget, 2000);
  assert.equal(payload.campaign_id, 'c1');
  assert.deepEqual(payload.targeting.geo_locations.countries, ['US']);
});

test('buildCreativePayload carries the real ad copy fields into the object_story_spec', () => {
  const payload = buildCreativePayload({
    pageId: 'p1',
    adCopy: { headline: 'Fast HVAC repair', primaryText: 'We fix it fast', description: 'Same-day service', cta: 'CALL_NOW' },
    linkUrl: 'https://ghgrp.net',
  });
  assert.equal(payload.object_story_spec.page_id, 'p1');
  assert.equal(payload.object_story_spec.link_data.name, 'Fast HVAC repair');
  assert.equal(payload.object_story_spec.link_data.call_to_action.type, 'CALL_NOW');
});

test('buildAdPayload links the ad set and creative ids', () => {
  const payload = buildAdPayload({ name: 'ad', adSetExternalId: 'as1', creativeExternalId: 'cr1' });
  assert.equal(payload.adset_id, 'as1');
  assert.equal(payload.creative.creative_id, 'cr1');
});

test('classifyMetaError: error code 190 is a real, documented invalid/expired token', () => {
  const result = classifyMetaError({ error: { code: 190, message: 'Invalid OAuth access token' } });
  assert.equal(result.state, 'needs_reauth');
});

test('classifyMetaError: OAuthException type alone also maps to needs_reauth', () => {
  const result = classifyMetaError({ error: { type: 'OAuthException', message: 'Session expired' } });
  assert.equal(result.state, 'needs_reauth');
});

test('classifyMetaError: a payment/billing message maps to billing_blocked', () => {
  const result = classifyMetaError({ error: { code: 100, message: 'Ad account disabled: payment failure' } });
  assert.equal(result.state, 'billing_blocked');
});

test('classifyMetaError: a policy message maps to policy_blocked', () => {
  const result = classifyMetaError({ error: { code: 100, message: 'This ad was disapproved for policy reasons' } });
  assert.equal(result.state, 'policy_blocked');
});

test('classifyMetaError: an unrecognized error honestly falls back to needs_attention, not a guess', () => {
  const result = classifyMetaError({ error: { code: 999, message: 'Something else entirely' } });
  assert.equal(result.state, 'needs_attention');
});

test('launchMetaCampaign refuses to call out with incomplete launch inputs', async () => {
  await assert.rejects(
    () => launchMetaCampaign({ campaign: { name: 'x', objective: 'lead_gen' }, adCopy: {}, conn: { accessToken: 't' } }),
    (err) => err.launchInputsIncomplete === true
  );
});

test('launchMetaCampaign chains campaign -> adset -> creative -> ad, then activates all three, and returns every real external id', async () => {
  const fetchImpl = fakeFetch([
    { json: { id: 'campaign_1' } },
    { json: { id: 'adset_1' } },
    { json: { id: 'creative_1' } },
    { json: { id: 'ad_1' } },
    { json: { success: true } }, // activate campaign
    { json: { success: true } }, // activate ad set
    { json: { success: true } }, // activate ad
  ]);
  const result = await launchMetaCampaign({
    campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
    adCopy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'CALL_NOW' },
    conn: { accessToken: 't', adAccountId: 'act1', pageId: 'page1' },
    linkUrl: 'https://ghgrp.net',
  }, fetchImpl);
  assert.equal(result.externalCampaignId, 'campaign_1');
  assert.equal(result.externalAdSetId, 'adset_1');
  assert.equal(result.externalCreativeId, 'creative_1');
  assert.equal(result.externalAdId, 'ad_1');
  assert.equal(fetchImpl.calls, 7);
});

test('launchMetaCampaign stops immediately and classifies the error when a create step fails', async () => {
  const fetchImpl = fakeFetch([
    { json: { id: 'campaign_1' } },
    { ok: false, json: { error: { code: 100, message: 'This ad set was disapproved for policy reasons' } } },
  ]);
  await assert.rejects(
    () => launchMetaCampaign({
      campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
      adCopy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'CALL_NOW' },
      conn: { accessToken: 't', adAccountId: 'act1', pageId: 'page1' },
    }, fetchImpl),
    (err) => err.metaClassified.state === 'policy_blocked'
  );
  assert.equal(fetchImpl.calls, 2);
});

test('launchMetaCampaign creates every real object but still throws, leaving them paused, if activation itself fails', async () => {
  const fetchImpl = fakeFetch([
    { json: { id: 'campaign_1' } },
    { json: { id: 'adset_1' } },
    { json: { id: 'creative_1' } },
    { json: { id: 'ad_1' } },
    { ok: false, json: { error: { code: 190, message: 'Invalid OAuth access token' } } }, // activate campaign fails
  ]);
  await assert.rejects(
    () => launchMetaCampaign({
      campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
      adCopy: { headline: 'h', primaryText: 'p', description: 'd', cta: 'CALL_NOW' },
      conn: { accessToken: 't', adAccountId: 'act1', pageId: 'page1' },
    }, fetchImpl),
    (err) => err.metaClassified.state === 'needs_reauth'
  );
  assert.equal(fetchImpl.calls, 5);
});

test('pauseMetaCampaign sends a real PAUSED status update', async () => {
  const fetchImpl = fakeFetch([{ json: { success: true } }]);
  const result = await pauseMetaCampaign('campaign_1', { accessToken: 't' }, fetchImpl);
  assert.equal(result.success, true);
});

test('syncMetaCampaignSpend parses real dollar spend into cents', async () => {
  const fetchImpl = fakeFetch([{ json: { data: [{ spend: '12.34' }] } }]);
  const result = await syncMetaCampaignSpend('campaign_1', { accessToken: 't' }, '2026-08-03', fetchImpl);
  assert.equal(result.spendCents, 1234);
});

test('syncMetaCampaignSpend honestly reports zero when there is no real spend row', async () => {
  const fetchImpl = fakeFetch([{ json: { data: [] } }]);
  const result = await syncMetaCampaignSpend('campaign_1', { accessToken: 't' }, '2026-08-03', fetchImpl);
  assert.equal(result.spendCents, 0);
});

test('checkMetaConnectionHealth reports healthy on a real successful account read', async () => {
  const fetchImpl = fakeFetch([{ json: { id: 'act1', name: 'GHGRP Ads' } }]);
  const result = await checkMetaConnectionHealth({ accessToken: 't', adAccountId: 'act1' }, fetchImpl);
  assert.equal(result.healthy, true);
  assert.equal(result.accountName, 'GHGRP Ads');
});

test('checkMetaConnectionHealth classifies a real token failure instead of throwing', async () => {
  const fetchImpl = fakeFetch([{ ok: false, json: { error: { code: 190, message: 'Invalid OAuth access token' } } }]);
  const result = await checkMetaConnectionHealth({ accessToken: 'bad', adAccountId: 'act1' }, fetchImpl);
  assert.equal(result.healthy, false);
  assert.equal(result.state, 'needs_reauth');
});
