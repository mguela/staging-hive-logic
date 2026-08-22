// api/_lib/social-platform-meta.js
// Real Meta (Facebook Page + Instagram) organic posting adapter -- Graph
// API v26.0, same version as api/_lib/ad-platform-meta.js (confirm this is
// still current before relying on it -- Meta retires API versions on a
// rolling ~18-month cycle).
//
// This module has never been exercised against a real Facebook Page or
// Instagram Business account -- same standing caveat as ad-platform-meta.js:
// every function takes an injectable fetchImpl so the request/response
// contract is verified here against realistic mocked responses (see
// test/social-platform-meta.test.mjs). Not "done" until it has actually
// posted for real; ready to go the moment Chris finishes Page/IG setup.
//
// Reuses the SAME ad_platform_connections row (platform='meta') the ads
// system uses -- a Meta Page access token with pages_manage_posts and
// instagram_content_publish scopes is valid for both ad creative
// attribution and organic posting under Meta's Graph API. No separate
// connection needed (unlike TikTok -- see social-platform-tiktok.js).
//
// Facebook Page posts (text/link) need only a message (+ optional link).
// Instagram has no text-only post type -- every IG post requires real
// media. This build has no asset-upload pipeline, so postInstagramMedia()
// requires a real, publicly-fetchable mediaUrl (Meta's own container-create
// call fetches it server-side) -- never a fabricated or placeholder image.

import { classifyMetaError } from './ad-platform-meta.js';

const GRAPH_API_VERSION = 'v26.0';
const GRAPH_API_BASE = 'https://graph.facebook.com/' + GRAPH_API_VERSION;

const defaultFetch = (...args) => fetch(...args);

async function metaFetch(path, options) {
  const method = options.method || 'POST';
  const body = options.body;
  const accessToken = options.accessToken;
  const fetchFn = options.fetchImpl || defaultFetch;
  const url = new URL(GRAPH_API_BASE + path);
  let response;
  if (method === 'GET') {
    url.searchParams.set('access_token', accessToken);
    if (body) {
      for (const key of Object.keys(body)) url.searchParams.set(key, body[key]);
    }
    response = await fetchFn(url.toString(), { method: 'GET' });
  } else {
    const form = Object.assign({}, body, { access_token: accessToken });
    const params = new URLSearchParams();
    for (const key of Object.keys(form)) {
      const value = form[key];
      if (value === undefined || value === null) continue;
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

// ---------- Facebook Page text/link post ----------

async function postFacebookPageText({ accessToken, pageId, text, linkUrl }, fetchImpl) {
  if (!text || !text.trim()) {
    const err = new Error('A Facebook Page post requires real text.');
    err.missingContent = true;
    throw err;
  }
  const body = { message: text };
  if (linkUrl) body.link = linkUrl;
  const res = await metaFetch('/' + pageId + '/feed', { accessToken, fetchImpl, body });
  return { externalPostId: res.id };
}

// ---------- Instagram media post (image or video/reel) ----------
//
// Two-step Graph API flow: create a media container (Meta fetches mediaUrl
// server-side), then publish it. Video containers are processed
// asynchronously on Meta's side -- pollInstagramContainerStatus() polls
// container status up to maxAttempts times before giving up honestly
// (rather than publishing a container that isn't actually ready, or
// hanging forever).

async function resolveInstagramUserId({ accessToken, pageId }, fetchImpl) {
  const res = await metaFetch('/' + pageId + '?fields=instagram_business_account', { accessToken, fetchImpl, method: 'GET' });
  const igUserId = res.instagram_business_account && res.instagram_business_account.id;
  if (!igUserId) {
    const err = new Error('This Facebook Page has no linked Instagram Business account -- cannot post to Instagram.');
    err.noInstagramAccount = true;
    throw err;
  }
  return igUserId;
}

async function pollInstagramContainerStatus({ accessToken, containerId, maxAttempts = 10, delayMs = 3000 }, fetchImpl, sleepImpl) {
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await metaFetch('/' + containerId + '?fields=status_code', { accessToken, fetchImpl, method: 'GET' });
    if (res.status_code === 'FINISHED') return true;
    if (res.status_code === 'ERROR') {
      const err = new Error('Instagram media processing failed for container ' + containerId + '.');
      err.metaClassified = { state: 'needs_attention', reason: 'meta_ig_container_error', message: err.message };
      throw err;
    }
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  const err = new Error('Instagram media container ' + containerId + ' was still processing after ' + maxAttempts + ' checks -- not publishing an unfinished container.');
  err.containerNotReady = true;
  throw err;
}

async function postInstagramMedia({ accessToken, pageId, mediaUrl, mediaType, caption }, fetchImpl, opts = {}) {
  if (!mediaUrl) {
    const err = new Error('Instagram has no text-only post type -- a real, publicly-fetchable mediaUrl is required. Asset upload is not wired up in this build yet; supply a real image/video URL.');
    err.missingMediaAsset = true;
    throw err;
  }
  const igUserId = await resolveInstagramUserId({ accessToken, pageId }, fetchImpl);

  const containerBody = { caption: caption || '' };
  if (mediaType === 'video') {
    containerBody.media_type = 'REELS';
    containerBody.video_url = mediaUrl;
  } else {
    containerBody.image_url = mediaUrl;
  }
  const containerRes = await metaFetch('/' + igUserId + '/media', { accessToken, fetchImpl, body: containerBody });
  const containerId = containerRes.id;

  if (mediaType === 'video') {
    await pollInstagramContainerStatus({ accessToken, containerId, maxAttempts: opts.maxAttempts, delayMs: opts.delayMs }, fetchImpl, opts.sleepImpl);
  }

  const publishRes = await metaFetch('/' + igUserId + '/media_publish', { accessToken, fetchImpl, body: { creation_id: containerId } });
  return { externalPostId: publishRes.id, containerId };
}

export {
  GRAPH_API_VERSION,
  postFacebookPageText,
  postInstagramMedia,
  resolveInstagramUserId,
  pollInstagramContainerStatus,
};
