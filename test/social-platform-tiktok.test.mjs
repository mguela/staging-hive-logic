import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyTikTokContentError,
  postTikTokVideo,
  checkTikTokPublishStatus,
} from '../api/_lib/social-platform-tiktok.js';

function fakeFetch(responses) {
  const fn = async (url, opts) => {
    const entry = responses[fn.calls];
    fn.calls += 1;
    if (!entry) throw new Error('fakeFetch: no response queued for call ' + fn.calls + ' (url: ' + url + ')');
    return {
      ok: entry.ok !== false,
      status: entry.status || (entry.ok === false ? 400 : 200),
      json: async () => entry.json,
    };
  };
  fn.calls = 0;
  return fn;
}

test('classifyTikTokContentError: a token/scope error maps to needs_reauth', () => {
  const result = classifyTikTokContentError({ error: { code: 'access_token_invalid', message: 'The access token is invalid or expired' } });
  assert.equal(result.state, 'needs_reauth');
});

test('classifyTikTokContentError: a rate-limit/policy message maps to policy_blocked', () => {
  const result = classifyTikTokContentError({ error: { code: 'rate_limit_exceeded', message: 'Too many requests, rate limit reached' } });
  assert.equal(result.state, 'policy_blocked');
});

test('classifyTikTokContentError: an unrecognized error honestly falls back to needs_attention, not a guess', () => {
  const result = classifyTikTokContentError({ error: { code: 'internal_error', message: 'Something went wrong, please retry' } });
  assert.equal(result.state, 'needs_attention');
});

test('postTikTokVideo honestly refuses when there is no real videoUrl', async () => {
  await assert.rejects(
    () => postTikTokVideo({ accessToken: 'tok', videoUrl: null, title: 'Job walkthrough' }),
    (err) => err.missingMediaAsset === true
  );
});

test('postTikTokVideo publishes a real video by URL and returns the real publish id', async () => {
  const fetchImpl = fakeFetch([
    { json: { error: { code: 'ok', message: '' }, data: { publish_id: 'pub_123' } } },
  ]);
  const result = await postTikTokVideo({ accessToken: 'tok', videoUrl: 'https://ghgrp.net/job-photos/roof-timelapse.mp4', title: 'Roof replacement timelapse', privacyLevel: 'PUBLIC_TO_EVERYONE' }, fetchImpl);
  assert.equal(result.externalPostId, 'pub_123');
  assert.equal(fetchImpl.calls, 1);
});

test('postTikTokVideo classifies a real TikTok Content Posting failure instead of swallowing it', async () => {
  const fetchImpl = fakeFetch([
    { json: { error: { code: 'access_token_invalid', message: 'The access token is invalid or expired' } } },
  ]);
  await assert.rejects(
    () => postTikTokVideo({ accessToken: 'bad-tok', videoUrl: 'https://ghgrp.net/job-photos/roof-timelapse.mp4', title: 'x' }, fetchImpl),
    (err) => err.tiktokClassified.state === 'needs_reauth'
  );
});

test('checkTikTokPublishStatus reports a real publish status', async () => {
  const fetchImpl = fakeFetch([
    { json: { error: { code: 'ok', message: '' }, data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7000000000000000000'] } } },
  ]);
  const result = await checkTikTokPublishStatus({ accessToken: 'tok', publishId: 'pub_123' }, fetchImpl);
  assert.equal(result.status, 'PUBLISH_COMPLETE');
  assert.deepEqual(result.publiclyAvailablePostId, ['7000000000000000000']);
});
