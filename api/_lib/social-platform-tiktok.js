// api/_lib/social-platform-tiktok.js
// Real TikTok Content Posting API adapter -- open.tiktokapis.com/v2
// (confirm this is still current before relying on it -- see
// developers.tiktok.com/doc/content-posting-api-get-started).
//
// IMPORTANT, honest limitation: this is NOT the same API, app, or token as
// api/_lib/ad-platform-tiktok.js. TikTok's Marketing API (ads) and Content
// Posting API (organic) are two separate developer apps with different
// OAuth scopes -- the Marketing API's advertiser access token does not
// work here. Content posting needs a TikTok Login Kit app approved for the
// video.publish scope and a user access token from that flow. Chris has
// not set this up -- ad_platform_connections.platform='tiktok_content' is a
// distinct row from platform='tiktok' precisely because of this split (see
// sql/059_organic_social_posting.sql). Every function below takes an
// injectable fetchImpl and is verified against realistic mocked responses
// (see test/social-platform-tiktok.test.mjs); this is tested scaffolding,
// not yet exercised against a real TikTok account, ready to go the moment
// Chris finishes the separate Content Posting API app approval.
//
// TikTok is video-first -- there is no image or text-only organic post
// type via this API (photo posts exist but are a separate, newer, more
// restricted endpoint not covered here). postTikTokVideo() requires a
// real, publicly-fetchable videoUrl -- there is no asset-upload pipeline
// in this codebase, so this refuses honestly rather than fabricating one,
// same convention as every other adapter in this build.

const TIKTOK_CONTENT_API_BASE = 'https://open.tiktokapis.com/v2';

const defaultFetch = (...args) => fetch(...args);

// TikTok's Content Posting API returns HTTP 200 with an `error.code` field
// (a string, e.g. "ok", "invalid_param") rather than a numeric ads-API
// code -- a different error shape from ad-platform-tiktok.js's classifier,
// so this is its own classifyTikTokContentError rather than a shared one.
function classifyTikTokContentError(body) {
  const err = (body && body.error) || {};
  const code = err.code || null;
  const message = (err.message || '').toLowerCase();

  if (code === 'access_token_invalid' || code === 'scope_not_authorized' || message.includes('token') || message.includes('scope') || message.includes('auth')) {
    return { state: 'needs_reauth', reason: 'tiktok_content_token_invalid_or_unauthorized', tiktokCode: code, message: err.message || 'TikTok Content Posting authorization error' };
  }
  if (message.includes('rate limit') || message.includes('spam') || message.includes('reject')) {
    return { state: 'policy_blocked', reason: 'tiktok_content_policy_issue', tiktokCode: code, message: err.message || 'TikTok Content Posting policy error' };
  }
  return { state: 'needs_attention', reason: 'tiktok_content_unclassified_error', tiktokCode: code, message: err.message || 'Unknown TikTok Content Posting API error' };
}

async function tiktokContentFetch(path, options) {
  const fetchFn = options.fetchImpl || defaultFetch;
  const response = await fetchFn(TIKTOK_CONTENT_API_BASE + path, {
    method: options.method || 'POST',
    headers: {
      Authorization: 'Bearer ' + options.accessToken,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json();
  const code = json && json.error && json.error.code;
  if (!response.ok || (code && code !== 'ok')) {
    const classified = classifyTikTokContentError(json);
    const err = new Error(classified.message || ('TikTok Content Posting API error at ' + path));
    err.tiktokClassified = classified;
    err.tiktokRawError = json;
    err.step = path;
    throw err;
  }
  return json.data;
}

// Publishes a real video by URL (TikTok pulls it server-side -- PULL_FROM_URL
// source, which requires the connected TikTok account's domain to be
// verified in the TikTok developer portal for that URL's domain; that
// verification is a one-time manual step on Chris's side, not something
// this code can do).
async function postTikTokVideo({ accessToken, videoUrl, title, privacyLevel }, fetchImpl) {
  if (!videoUrl) {
    const err = new Error('TikTok has no image or text-only organic post type via this API -- a real, publicly-fetchable videoUrl is required. Asset upload is not wired up in this build yet; supply a real video URL.');
    err.missingMediaAsset = true;
    throw err;
  }
  const res = await tiktokContentFetch('/post/publish/video/init/', {
    accessToken,
    fetchImpl,
    body: {
      post_info: {
        title: title || '',
        privacy_level: privacyLevel || 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl,
      },
    },
  });
  return { externalPostId: res.publish_id };
}

// TikTok's publish is asynchronous -- init returns a publish_id immediately,
// and the real post_id/status is only known via this status-check call.
// Mirrors the same honest "poll, don't assume" pattern as Instagram's
// container status check in social-platform-meta.js.
async function checkTikTokPublishStatus({ accessToken, publishId }, fetchImpl) {
  const res = await tiktokContentFetch('/post/publish/status/fetch/', {
    accessToken,
    fetchImpl,
    body: { publish_id: publishId },
  });
  return { status: res.status, publiclyAvailablePostId: res.publicaly_available_post_id || res.publicly_available_post_id || null };
}

export {
  classifyTikTokContentError,
  postTikTokVideo,
  checkTikTokPublishStatus,
};
