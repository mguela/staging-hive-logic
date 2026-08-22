import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleSocialPostsGet,
  handleSocialPostDraftPost,
  handleSocialPostReviewPost,
  handleSocialPostSchedulePost,
  handleSocialPostPublishPost,
  handleProcessScheduledPostsGet,
} from '../api/social-posts.js';

function fakeSupabase(responses) {
  let call = 0;
  return async (path) => {
    const entry = responses[call];
    call += 1;
    if (!entry) throw new Error('fakeSupabase: no response queued for call ' + call + ' (path: ' + path + ')');
    return {
      ok: entry.ok !== false,
      json: async () => entry.rows,
      text: async () => JSON.stringify(entry.rows),
    };
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// ---------- handleSocialPostsGet ----------

test('handleSocialPostsGet returns real rows', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'p1', surface: 'facebook_page' }] }]);
  const res = fakeRes();
  await handleSocialPostsGet({ query: {} }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.posts.length, 1);
});

// ---------- handleSocialPostDraftPost ----------

test('handleSocialPostDraftPost rejects an unknown surface', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleSocialPostDraftPost({ body: { surface: 'twitter', postType: 'text', text: 'hi' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleSocialPostDraftPost rejects a post type the surface cannot publish', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleSocialPostDraftPost({ body: { surface: 'facebook_page', postType: 'video' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleSocialPostDraftPost honestly refuses a Facebook Page post with no real text', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleSocialPostDraftPost({ body: { surface: 'facebook_page', postType: 'text', text: '   ' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleSocialPostDraftPost honestly refuses an Instagram post with no real mediaUrl', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleSocialPostDraftPost({ body: { surface: 'instagram', postType: 'image' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleSocialPostDraftPost creates a real draft row for a valid Facebook Page post', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'p1', platform: 'meta', surface: 'facebook_page', status: 'draft' }] }]);
  const res = fakeRes();
  await handleSocialPostDraftPost({ body: { surface: 'facebook_page', postType: 'text', text: 'New roof in Dayton!', linkUrl: 'https://ghgrp.net' } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.post.status, 'draft');
});

test('handleSocialPostDraftPost creates a real draft row for a valid TikTok video post', async () => {
  const supa = fakeSupabase([{ rows: [{ id: 'p2', platform: 'tiktok', surface: 'tiktok_video', status: 'draft' }] }]);
  const res = fakeRes();
  await handleSocialPostDraftPost({ body: { surface: 'tiktok_video', postType: 'video', mediaUrl: 'https://ghgrp.net/job-photos/timelapse.mp4', text: 'Roof timelapse' } }, res, supa);
  assert.equal(res.statusCode, 200);
});

// ---------- handleSocialPostReviewPost ----------

test('handleSocialPostReviewPost: postId is required', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleSocialPostReviewPost({ body: {} }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleSocialPostReviewPost: 404 when the post does not exist', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'ghost', decision: 'approve' } }, res, supa);
  assert.equal(res.statusCode, 404);
});

test('handleSocialPostReviewPost: reject moves a draft to rejected with a stored reason', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft', surface: 'facebook_page', post_type: 'text', content: { text: 'hi' } }] },
    { rows: [], ok: true },
  ]);
  const res = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'p1', decision: 'reject', reason: 'Not on-brand' } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'rejected');
});

test('handleSocialPostReviewPost: approve re-checks content completeness before scheduling', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft', surface: 'instagram', post_type: 'image', content: { mediaUrl: null } }] },
  ]);
  const res = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'p1', decision: 'approve' } }, res, supa);
  assert.equal(res.statusCode, 409);
});

test('handleSocialPostReviewPost: approve auto-schedules a complete draft in one click -- no separate schedule step', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft', surface: 'facebook_page', post_type: 'text', content: { text: 'New roof in Dayton!' } }] },
    { rows: [] }, // no existing scheduled facebook_page posts
    { rows: [], ok: true }, // the PATCH
  ]);
  const res = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'p1', decision: 'approve' }, hlUser: { email: 'chris@ghgrp.net' } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'scheduled');
  assert.equal(res.body.autoScheduled, true);
  assert.ok(res.body.scheduledFor, 'expected a real scheduledFor timestamp');
  assert.ok(new Date(res.body.scheduledFor).getTime() > Date.now(), 'auto-picked slot must be in the future');
});

test('handleSocialPostReviewPost: an explicit future scheduledFor on approve overrides the auto-pick', async () => {
  const future = new Date(Date.now() + 5 * 3600_000).toISOString();
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft', surface: 'facebook_page', post_type: 'text', content: { text: 'New roof in Dayton!' } }] },
    { rows: [], ok: true }, // the PATCH -- no existing-scheduled lookup call, since a manual override was given
  ]);
  const res = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'p1', decision: 'approve', scheduledFor: future } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'scheduled');
  assert.equal(res.body.autoScheduled, false);
  assert.equal(res.body.scheduledFor, new Date(future).toISOString());
});

test('handleSocialPostReviewPost: a past scheduledFor on approve is ignored in favor of the auto-pick', async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft', surface: 'facebook_page', post_type: 'text', content: { text: 'New roof in Dayton!' } }] },
    { rows: [] },
    { rows: [], ok: true },
  ]);
  const res = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'p1', decision: 'approve', scheduledFor: past } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.autoScheduled, true);
});

test('handleSocialPostReviewPost: auto-schedule avoids stacking on an already-scheduled post for the same surface', async () => {
  // Whatever slot the algorithm picks first for a fresh surface, pre-occupy
  // it on the next approval and confirm the result moves to a different,
  // still-future slot at least the minimum gap away.
  const supa1 = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft', surface: 'instagram', post_type: 'text', content: { text: 'hi' } }] },
    { rows: [] },
    { rows: [], ok: true },
  ]);
  const res1 = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'p1', decision: 'approve' } }, res1, supa1);
  const firstPick = res1.body.scheduledFor;
  assert.ok(firstPick);
  assert.ok(new Date(firstPick).getTime() - Date.now() >= 89 * 60_000);

  const supa2 = fakeSupabase([
    { rows: [{ id: 'p2', status: 'draft', surface: 'instagram', post_type: 'text', content: { text: 'hi again' } }] },
    { rows: [{ scheduled_for: firstPick }] },
    { rows: [], ok: true },
  ]);
  const res2 = fakeRes();
  await handleSocialPostReviewPost({ body: { postId: 'p2', decision: 'approve' } }, res2, supa2);
  const secondPick = res2.body.scheduledFor;
  assert.ok(secondPick);
  const gapMs = Math.abs(new Date(secondPick).getTime() - new Date(firstPick).getTime());
  assert.ok(gapMs >= 3 * 3600_000, 'expected at least a 3h gap from the occupied slot, got ' + gapMs + 'ms');
});

// ---------- handleSocialPostSchedulePost ----------

test('handleSocialPostSchedulePost rejects a past scheduledFor', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleSocialPostSchedulePost({ body: { postId: 'p1', scheduledFor: '2020-01-01T00:00:00Z' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleSocialPostSchedulePost refuses to schedule a post that is not pending_review', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft' }] },
  ]);
  const res = fakeRes();
  const future = new Date(Date.now() + 3600_000).toISOString();
  await handleSocialPostSchedulePost({ body: { postId: 'p1', scheduledFor: future } }, res, supa);
  assert.equal(res.statusCode, 409);
});

test('handleSocialPostSchedulePost moves an approved post to scheduled with a real future timestamp', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'pending_review' }] },
    { rows: [], ok: true },
  ]);
  const res = fakeRes();
  const future = new Date(Date.now() + 3600_000).toISOString();
  await handleSocialPostSchedulePost({ body: { postId: 'p1', scheduledFor: future } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'scheduled');
});

test('handleSocialPostSchedulePost allows rescheduling an already-scheduled (e.g. auto-scheduled) post to a new time', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'scheduled', scheduled_for: new Date(Date.now() + 3600_000).toISOString() }] },
    { rows: [], ok: true },
  ]);
  const res = fakeRes();
  const future = new Date(Date.now() + 7200_000).toISOString();
  await handleSocialPostSchedulePost({ body: { postId: 'p1', scheduledFor: future } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'scheduled');
  assert.equal(res.body.scheduledFor, new Date(future).toISOString());
});

// ---------- handleSocialPostPublishPost ----------

test('handleSocialPostPublishPost refuses to publish a post that is still a draft', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'draft' }] },
  ]);
  const res = fakeRes();
  await handleSocialPostPublishPost({ body: { postId: 'p1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleSocialPostPublishPost refuses honestly when the connection is not launch_enabled', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p1', status: 'pending_review', surface: 'facebook_page', content: { text: 'hi' } }] },
    { rows: [{ state: 'setup_incomplete' }] },
  ]);
  const res = fakeRes();
  await handleSocialPostPublishPost({ body: { postId: 'p1' } }, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 409);
});

test('handleSocialPostPublishPost: a real Facebook publish failure is classified, recorded, and the post is marked failed -- never swallowed', async () => {
  process.env.SOCIAL_META_TEST_TOKEN = 'tok-a';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'p1', status: 'pending_review', surface: 'facebook_page', content: { text: 'hi' } }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'SOCIAL_META_TEST_TOKEN', page_id: 'page1' }] },
      { rows: [], ok: true },
      { rows: [], ok: true },
    ]);
    const failingPost = async () => {
      const err = new Error('Invalid OAuth access token');
      err.metaClassified = { state: 'needs_reauth', reason: 'meta_token_invalid_or_expired', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleSocialPostPublishPost({ body: { postId: 'p1' } }, res, { supabaseRequest: supa, postFacebookPageText: failingPost });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.classified.state, 'needs_reauth');
  } finally {
    delete process.env.SOCIAL_META_TEST_TOKEN;
  }
});

test('handleSocialPostPublishPost: a real successful Facebook Page publish moves the post to posted', async () => {
  process.env.SOCIAL_META_TEST_TOKEN_B = 'tok-b';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'p1', status: 'pending_review', surface: 'facebook_page', content: { text: 'New roof in Dayton!' } }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'SOCIAL_META_TEST_TOKEN_B', page_id: 'page1' }] },
      { rows: [], ok: true },
    ]);
    const succeedingPost = async () => ({ externalPostId: 'page1_post1' });
    const res = fakeRes();
    await handleSocialPostPublishPost({ body: { postId: 'p1' } }, res, { supabaseRequest: supa, postFacebookPageText: succeedingPost });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'posted');
    assert.equal(res.body.publishResult.externalPostId, 'page1_post1');
  } finally {
    delete process.env.SOCIAL_META_TEST_TOKEN_B;
  }
});

test('handleSocialPostPublishPost: a real successful Instagram publish resolves through the shared Meta connection', async () => {
  process.env.SOCIAL_META_TEST_TOKEN_C = 'tok-c';
  try {
    const supa = fakeSupabase([
      { rows: [{ id: 'p2', status: 'scheduled', surface: 'instagram', content: { mediaUrl: 'https://ghgrp.net/img.jpg', mediaType: 'image', text: 'caption' } }] },
      { rows: [{ state: 'launch_enabled', env_var_name: 'SOCIAL_META_TEST_TOKEN_C', page_id: 'page1' }] },
      { rows: [], ok: true },
    ]);
    const succeedingPost = async () => ({ externalPostId: 'ig_post1', containerId: 'c1' });
    const res = fakeRes();
    await handleSocialPostPublishPost({ body: { postId: 'p2' } }, res, { supabaseRequest: supa, postInstagramMedia: succeedingPost });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.publishResult.externalPostId, 'ig_post1');
  } finally {
    delete process.env.SOCIAL_META_TEST_TOKEN_C;
  }
});

test('handleSocialPostPublishPost: a real successful TikTok publish goes through the separate tiktok_content connection', async () => {
  // TikTok's bearer token now comes from api/_lib/tiktok-token.js's
  // auto-refreshing Supabase-backed store, not a static env var -- inject a
  // fake getValidTikTokAccessToken instead of setting process.env.
  const supa = fakeSupabase([
    { rows: [{ id: 'p3', status: 'pending_review', surface: 'tiktok_video', content: { mediaUrl: 'https://ghgrp.net/video.mp4', text: 'Roof timelapse' } }] },
    { rows: [{ state: 'launch_enabled', env_var_name: 'TIKTOK_CONTENT_ACCESS_TOKEN' }] },
    { rows: [], ok: true },
  ]);
  const succeedingPost = async () => ({ externalPostId: 'pub_123' });
  const res = fakeRes();
  await handleSocialPostPublishPost({ body: { postId: 'p3' } }, res, {
    supabaseRequest: supa,
    postTikTokVideo: succeedingPost,
    getValidTikTokAccessToken: async () => 'tt-content-tok',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.publishResult.externalPostId, 'pub_123');
});

test('handleSocialPostPublishPost: a TikTok token refresh failure is refused honestly, not silently retried or swallowed', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'p4', status: 'pending_review', surface: 'tiktok_video', content: { mediaUrl: 'https://ghgrp.net/video.mp4', text: 'Roof timelapse' } }] },
    { rows: [{ state: 'launch_enabled' }] },
  ]);
  const res = fakeRes();
  await handleSocialPostPublishPost({ body: { postId: 'p4' } }, res, {
    supabaseRequest: supa,
    getValidTikTokAccessToken: async () => {
      throw new Error('TikTok authorization expired or was revoked -- reconnect at /api/tiktok/connect');
    },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /reconnect at \/api\/tiktok\/connect/);
});

// ---------- handleProcessScheduledPostsGet (cron sweep) ----------

test('handleProcessScheduledPostsGet publishes every due post best-effort and reports a real summary', async () => {
  process.env.SOCIAL_CRON_TEST_TOKEN = 'tok-cron';
  try {
    const supa = fakeSupabase([
      { rows: [
        { id: 'p1', status: 'scheduled', surface: 'facebook_page', content: { text: 'Post one' } },
        { id: 'p2', status: 'scheduled', surface: 'facebook_page', content: { text: 'Post two' } },
      ] },
      // p1: connection read + successful patch
      { rows: [{ state: 'launch_enabled', env_var_name: 'SOCIAL_CRON_TEST_TOKEN', page_id: 'page1' }] },
      { rows: [], ok: true },
      // p2: connection read + classified failure + failed patch
      { rows: [{ state: 'launch_enabled', env_var_name: 'SOCIAL_CRON_TEST_TOKEN', page_id: 'page1' }] },
      { rows: [], ok: true },
      { rows: [], ok: true },
    ]);
    let call = 0;
    const postFn = async () => {
      call += 1;
      if (call === 1) return { externalPostId: 'ext1' };
      const err = new Error('Invalid OAuth access token');
      err.metaClassified = { state: 'needs_reauth', reason: 'meta_token_invalid_or_expired', message: err.message };
      throw err;
    };
    const res = fakeRes();
    await handleProcessScheduledPostsGet({}, res, { supabaseRequest: supa, postFacebookPageText: postFn });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.processed, 2);
    assert.equal(res.body.succeeded, 1);
    assert.equal(res.body.failed, 1);
  } finally {
    delete process.env.SOCIAL_CRON_TEST_TOKEN;
  }
});

test('handleProcessScheduledPostsGet reports zero processed when nothing is due', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleProcessScheduledPostsGet({}, res, { supabaseRequest: supa });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, 0);
});
