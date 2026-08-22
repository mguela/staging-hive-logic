import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  tiktokObjectiveFor,
  buildCampaignPayload,
  buildAdGroupPayload,
  buildAdPayload,
  classifyTikTokError,
  launchTikTokCampaign,
  pauseTikTokCampaign,
  syncTikTokCampaignSpend,
  checkTikTokConnectionHealth,
} from '../api/_lib/ad-platform-tiktok.js';

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
  accessToken: 'tt-access-tok',
  advertiserId: '778899',
  identityId: 'identity-1',
};

test('tiktokObjectiveFor maps every known internal objective to a real TikTok objective_type', () => {
  assert.equal(tiktokObjectiveFor('lead_gen'), 'LEAD_GENERATION');
  assert.equal(tiktokObjectiveFor('traffic'), 'TRAFFIC');
  assert.equal(tiktokObjectiveFor('awareness'), 'REACH');
  assert.equal(tiktokObjectiveFor('conversions'), 'CONVERSIONS');
});

test('tiktokObjectiveFor throws rather than silently guessing an unmapped objective', () => {
  assert.throws(() => tiktokObjectiveFor('go_viral'));
});

test('buildCampaignPayload converts cents to real TikTok dollars and is always created DISABLE (paused)', () => {
  const payload = buildCampaignPayload({ advertiserId: '778899', name: 'HVAC leads', objective: 'lead_gen', dailyBudgetCents: 2000 });
  assert.equal(payload.advertiser_id, '778899');
  assert.equal(payload.objective_type, 'LEAD_GENERATION');
  assert.equal(payload.budget, 20);
  assert.equal(payload.budget_mode, 'BUDGET_MODE_DAY');
  assert.equal(payload.operation_status, 'DISABLE');
});

test('buildAdGroupPayload links the real campaign id and is always created DISABLE (paused)', () => {
  const payload = buildAdGroupPayload({ advertiserId: '778899', campaignId: '2', name: 'ad group', dailyBudgetCents: 2000 });
  assert.equal(payload.campaign_id, '2');
  assert.equal(payload.budget, 20);
  assert.equal(payload.operation_status, 'DISABLE');
});

test('buildAdPayload honestly refuses when there is no real video/image asset id', () => {
  assert.throws(
    () => buildAdPayload({ advertiserId: '778899', adgroupId: '3', adCopy: { headline: 'h', primaryText: 'p', cta: 'CALL_NOW' }, linkUrl: 'https://ghgrp.net', identityId: 'identity-1' }),
    (err) => err.missingMediaAsset === true
  );
});

test('buildAdPayload builds a real creative when a video/image asset id is provided', () => {
  const payload = buildAdPayload({
    advertiserId: '778899',
    adgroupId: '3',
    adCopy: { headline: 'h', primaryText: 'p', cta: 'CALL_NOW', mediaAssetId: 'v123456' },
    linkUrl: 'https://ghgrp.net',
    identityId: 'identity-1',
  });
  assert.equal(payload.creatives[0].video_id, 'v123456');
  assert.equal(payload.creatives[0].landing_page_url, 'https://ghgrp.net');
  assert.equal(payload.operation_status, 'DISABLE');
});

test('classifyTikTokError: an access-token message maps to needs_reauth', () => {
  const result = classifyTikTokError({ code: 40100, message: 'Invalid access token' });
  assert.equal(result.state, 'needs_reauth');
});

test('classifyTikTokError: a balance message maps to billing_blocked', () => {
  const result = classifyTikTokError({ code: 40200, message: 'Insufficient balance in account' });
  assert.equal(result.state, 'billing_blocked');
});

test('classifyTikTokError: a policy/review message maps to policy_blocked', () => {
  const result = classifyTikTokError({ code: 40300, message: 'Ad rejected during review for policy violation' });
  assert.equal(result.state, 'policy_blocked');
});

test('classifyTikTokError: an unrecognized error honestly falls back to needs_attention, not a guess', () => {
  const result = classifyTikTokError({ code: 50000, message: 'Internal error, please retry' });
  assert.equal(result.state, 'needs_attention');
});

test('launchTikTokCampaign refuses to call out with incomplete launch inputs', async () => {
  await assert.rejects(
    () => launchTikTokCampaign({ campaign: { name: 'x', objective: 'lead_gen' }, adCopy: {}, conn: {} }),
    (err) => err.launchInputsIncomplete === true
  );
});

test('launchTikTokCampaign chains campaign -> ad group -> ad, then enables all three, and returns every real external id when a media asset is provided', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 0, data: { campaign_id: '2' } } },
    { json: { code: 0, data: { adgroup_id: '3' } } },
    { json: { code: 0, data: { ad_ids: ['4'] } } },
    { json: { code: 0, data: {} } }, // enable campaign
    { json: { code: 0, data: {} } }, // enable ad group
    { json: { code: 0, data: {} } }, // enable ad
  ]);
  const result = await launchTikTokCampaign({
    campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
    adCopy: { headline: 'h', primaryText: 'p', cta: 'CALL_NOW', mediaAssetId: 'v123456' },
    conn: baseConn,
    linkUrl: 'https://ghgrp.net',
  }, fetchImpl);
  assert.equal(result.externalCampaignId, '2');
  assert.equal(result.externalAdGroupId, '3');
  assert.deepEqual(result.externalAdIds, ['4']);
  assert.equal(fetchImpl.calls, 6);
});

test('launchTikTokCampaign creates every real object but still throws, leaving them DISABLE, if enabling itself fails', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 0, data: { campaign_id: '2' } } },
    { json: { code: 0, data: { adgroup_id: '3' } } },
    { json: { code: 0, data: { ad_ids: ['4'] } } },
    { json: { code: 40100, message: 'Invalid access token' } }, // enable campaign fails
  ]);
  await assert.rejects(
    () => launchTikTokCampaign({
      campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
      adCopy: { headline: 'h', primaryText: 'p', cta: 'CALL_NOW', mediaAssetId: 'v123456' },
      conn: baseConn,
      linkUrl: 'https://ghgrp.net',
    }, fetchImpl),
    (err) => err.tiktokClassified.state === 'needs_reauth'
  );
  assert.equal(fetchImpl.calls, 4);
});

test('launchTikTokCampaign creates a real campaign and ad group, then honestly refuses at the ad step with no fabricated creative when no media asset is provided', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 0, data: { campaign_id: '2' } } },
    { json: { code: 0, data: { adgroup_id: '3' } } },
  ]);
  await assert.rejects(
    () => launchTikTokCampaign({
      campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
      adCopy: { headline: 'h', primaryText: 'p', cta: 'CALL_NOW' },
      conn: baseConn,
      linkUrl: 'https://ghgrp.net',
    }, fetchImpl),
    (err) => err.missingMediaAsset === true
  );
  assert.equal(fetchImpl.calls, 2);
});

test('launchTikTokCampaign stops immediately and classifies the error when a real step fails', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 40300, message: 'Campaign name rejected for policy violation' } },
  ]);
  await assert.rejects(
    () => launchTikTokCampaign({
      campaign: { name: 'HVAC leads', objective: 'lead_gen', daily_budget_cents: 2000 },
      adCopy: { headline: 'h', primaryText: 'p', cta: 'CALL_NOW', mediaAssetId: 'v123456' },
      conn: baseConn,
      linkUrl: 'https://ghgrp.net',
    }, fetchImpl),
    (err) => err.tiktokClassified.state === 'policy_blocked'
  );
  assert.equal(fetchImpl.calls, 1);
});

test('pauseTikTokCampaign sends a real DISABLE status update', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 0, data: {} } },
  ]);
  await pauseTikTokCampaign('2', baseConn, fetchImpl);
  assert.equal(fetchImpl.calls, 1);
});

test('syncTikTokCampaignSpend parses real reported spend into cents', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 0, data: { list: [{ metrics: { spend: '43.21' } }] } } },
  ]);
  const result = await syncTikTokCampaignSpend('2', baseConn, '2026-08-03', fetchImpl);
  assert.equal(result.spendCents, 4321);
  assert.equal(result.date, '2026-08-03');
});

test('syncTikTokCampaignSpend honestly reports zero when there is no real spend row', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 0, data: { list: [] } } },
  ]);
  const result = await syncTikTokCampaignSpend('2', baseConn, '2026-08-03', fetchImpl);
  assert.equal(result.spendCents, 0);
});

test('checkTikTokConnectionHealth reports healthy on a real successful account read', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 0, data: { list: [{ advertiser_id: '778899', name: 'GHGRP TikTok' }] } } },
  ]);
  const result = await checkTikTokConnectionHealth(baseConn, fetchImpl);
  assert.equal(result.healthy, true);
  assert.equal(result.accountName, 'GHGRP TikTok');
});

test('checkTikTokConnectionHealth classifies a real token failure instead of throwing', async () => {
  const fetchImpl = fakeFetch([
    { json: { code: 40100, message: 'Invalid access token' } },
  ]);
  const result = await checkTikTokConnectionHealth(baseConn, fetchImpl);
  assert.equal(result.healthy, false);
  assert.equal(result.state, 'needs_reauth');
});
