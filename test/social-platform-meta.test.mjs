import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  postFacebookPageText,
  postInstagramMedia,
  resolveInstagramUserId,
  pollInstagramContainerStatus,
} from '../api/_lib/social-platform-meta.js';

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

const noSleep = async () => {};

test('postFacebookPageText honestly refuses a post with no real text', async () => {
  await assert.rejects(
    () => postFacebookPageText({ accessToken: 'tok', pageId: 'page1', text: '   ', linkUrl: null }),
    (err) => err.missingContent === true
  );
});

test('postFacebookPageText publishes a real text post and returns the real post id', async () => {
  const fetchImpl = fakeFetch([
    { json: { id: 'page1_post1' } },
  ]);
  const result = await postFacebookPageText({ accessToken: 'tok', pageId: 'page1', text: 'We just wrapped a roof replacement in Dayton!', linkUrl: 'https://ghgrp.net/roofing' }, fetchImpl);
  assert.equal(result.externalPostId, 'page1_post1');
  assert.equal(fetchImpl.calls, 1);
});

test('postFacebookPageText classifies a real Meta failure instead of swallowing it', async () => {
  const fetchImpl = fakeFetch([
    { json: { error: { code: 190, type: 'OAuthException', message: 'Error validating access token' } } },
  ]);
  await assert.rejects(
    () => postFacebookPageText({ accessToken: 'bad-tok', pageId: 'page1', text: 'hello' }, fetchImpl),
    (err) => err.metaClassified.state === 'needs_reauth'
  );
});

test('resolveInstagramUserId returns the real linked Instagram Business account id', async () => {
  const fetchImpl = fakeFetch([
    { json: { instagram_business_account: { id: 'ig123' } } },
  ]);
  const id = await resolveInstagramUserId({ accessToken: 'tok', pageId: 'page1' }, fetchImpl);
  assert.equal(id, 'ig123');
});

test('resolveInstagramUserId honestly refuses when the Page has no linked Instagram account', async () => {
  const fetchImpl = fakeFetch([
    { json: {} },
  ]);
  await assert.rejects(
    () => resolveInstagramUserId({ accessToken: 'tok', pageId: 'page1' }, fetchImpl),
    (err) => err.noInstagramAccount === true
  );
});

test('postInstagramMedia honestly refuses when there is no real mediaUrl', async () => {
  await assert.rejects(
    () => postInstagramMedia({ accessToken: 'tok', pageId: 'page1', mediaUrl: null, mediaType: 'image' }),
    (err) => err.missingMediaAsset === true
  );
});

test('postInstagramMedia publishes a real image in two real Graph API steps', async () => {
  const fetchImpl = fakeFetch([
    { json: { instagram_business_account: { id: 'ig123' } } },
    { json: { id: 'container1' } },
    { json: { id: 'ig_post1' } },
  ]);
  const result = await postInstagramMedia({ accessToken: 'tok', pageId: 'page1', mediaUrl: 'https://ghgrp.net/job-photos/roof1.jpg', mediaType: 'image', caption: 'Fresh roof, Dayton OH' }, fetchImpl);
  assert.equal(result.externalPostId, 'ig_post1');
  assert.equal(result.containerId, 'container1');
  assert.equal(fetchImpl.calls, 3);
});

test('postInstagramMedia polls a real video container until FINISHED before publishing', async () => {
  const fetchImpl = fakeFetch([
    { json: { instagram_business_account: { id: 'ig123' } } },
    { json: { id: 'container2' } },
    { json: { status_code: 'IN_PROGRESS' } },
    { json: { status_code: 'FINISHED' } },
    { json: { id: 'ig_post2' } },
  ]);
  const result = await postInstagramMedia(
    { accessToken: 'tok', pageId: 'page1', mediaUrl: 'https://ghgrp.net/job-photos/walkthrough.mp4', mediaType: 'video', caption: 'Full kitchen remodel walkthrough' },
    fetchImpl,
    { sleepImpl: noSleep }
  );
  assert.equal(result.externalPostId, 'ig_post2');
  assert.equal(fetchImpl.calls, 5);
});

test('pollInstagramContainerStatus honestly gives up rather than publishing an unfinished container', async () => {
  const fetchImpl = fakeFetch([
    { json: { status_code: 'IN_PROGRESS' } },
    { json: { status_code: 'IN_PROGRESS' } },
  ]);
  await assert.rejects(
    () => pollInstagramContainerStatus({ accessToken: 'tok', containerId: 'container3', maxAttempts: 2, delayMs: 1 }, fetchImpl, noSleep),
    (err) => err.containerNotReady === true
  );
  assert.equal(fetchImpl.calls, 2);
});

test('pollInstagramContainerStatus classifies a real container processing error', async () => {
  const fetchImpl = fakeFetch([
    { json: { status_code: 'ERROR' } },
  ]);
  await assert.rejects(
    () => pollInstagramContainerStatus({ accessToken: 'tok', containerId: 'container4', maxAttempts: 3, delayMs: 1 }, fetchImpl, noSleep),
    (err) => err.metaClassified.state === 'needs_attention'
  );
});
