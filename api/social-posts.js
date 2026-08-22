// api/social-posts.js - Vercel serverless function
// Organic social posting (paid-ads-social build, step 6). A separate
// subsystem from api/ads.js -- this posts real, unpaid content to a
// Facebook Page, Instagram, or TikTok profile; it has no budget, no
// targeting, and no platform "campaign" concept. Mirrors ad_campaigns'
// draft -> review -> [schedule] -> publish state machine and the same
// Universal Connections vocabulary (api/_lib/connection-states.js), but
// against the new social_posts table (sql/059) instead.
//
// Usage:
//   GET  /api/social-posts?resource=social_posts[&platform=][&status=]
//     -> real social_posts rows, optionally filtered.
//   POST /api/social-posts?resource=social_post_draft
//     body: { surface, postType, text?, linkUrl?, mediaUrl?, mediaType? }
//     -> creates a draft row. surface is 'facebook_page' | 'instagram' |
//        'tiktok_video'; each surface only accepts the post types it can
//        actually publish (see SURFACE_POST_TYPES below) -- Instagram and
//        TikTok have no text-only post type, so image/video posts require
//        a real, publicly-fetchable mediaUrl. There is no asset-upload
//        pipeline in this codebase, so a missing mediaUrl is refused
//        honestly (400) rather than faked.
//   POST /api/social-posts?resource=social_post_review
//     body: { postId, decision: 'approve'|'reject', reason?, scheduledFor? }
//     -> approve re-checks content completeness, then moves draft straight
//        to scheduled -- one click, no separate "pick a time" step. Reina
//        auto-picks the next sensible send slot for that surface (see
//        computeAutoScheduleSlot below) unless a future scheduledFor is
//        passed explicitly. reject moves draft -> rejected with a stored
//        reason. Neither touches a real platform.
//   POST /api/social-posts?resource=social_post_schedule
//     body: { postId, scheduledFor }
//     -> moves an approved post to a specific future timestamp -- now used
//        to override Reina's auto-pick or reschedule an already-scheduled
//        post, since social_post_review handles the common case on its own.
//        The process_scheduled_posts cron (below) is what actually
//        publishes it when the time comes.
//   POST /api/social-posts?resource=social_post_publish
//     body: { postId }
//     -> the real platform action: publishes a pending_review or due
//        scheduled post for real, right now. Facebook Page and Instagram
//        go through the Graph API (api/_lib/social-platform-meta.js);
//        TikTok goes through TikTok's Content Posting API
//        (api/_lib/social-platform-tiktok.js). Requires that surface's
//        connection to already be launch_enabled. On success moves the
//        post to posted with its real external_post_id; on failure
//        records the classified connection issue state and leaves the
//        post in its prior status for a retry once fixed.
//   GET  /api/social-posts?resource=process_scheduled_posts
//     -> cron-triggered (Vercel Cron, */15 min -- see vercel.json), same
//        CRON_SECRET bearer-token bypass pattern as
//        api/marketing.js's process_scheduled_sends. Finds every
//        scheduled post whose scheduled_for has passed and publishes each
//        one for real (best-effort -- one post's failure does not block
//        the rest), then reports a summary.
//
// Facebook Page + Instagram credential shape: reuses the SAME
// ad_platform_connections row (platform='meta') the ads system already
// uses. A Meta Page access token with pages_manage_posts and
// instagram_content_publish scopes is valid for both ad creative
// attribution and organic posting -- no separate connection needed.
//
// TikTok credential shape is NOT the same as ads. TikTok's Marketing API
// (platform='tiktok') and Content Posting API (organic) are two separate
// developer apps with different OAuth scopes -- see the header of
// api/_lib/social-platform-tiktok.js. ad_platform_connections.platform=
// 'tiktok_content' is a distinct connection row for this reason.

import { supabaseRequest as defaultSupabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/require-user.js';
import {
  isValidConnectionTransition,
} from './_lib/connection-states.js';
import { postFacebookPageText as defaultPostFacebookPageText, postInstagramMedia as defaultPostInstagramMedia } from './_lib/social-platform-meta.js';
import { postTikTokVideo as defaultPostTikTokVideo } from './_lib/social-platform-tiktok.js';
import { getValidTikTokAccessToken as defaultGetValidTikTokAccessToken } from './_lib/tiktok-token.js';

const SOCIAL_SURFACES = new Set(['facebook_page', 'instagram', 'tiktok_video']);

const SURFACE_LABELS = {
  facebook_page: 'Facebook Page',
  instagram: 'Instagram',
  tiktok_video: 'TikTok',
};

// The customer-facing platform each surface belongs to (social_posts.platform).
const SURFACE_TO_PLATFORM = {
  facebook_page: 'meta',
  instagram: 'meta',
  tiktok_video: 'tiktok',
};

// The ad_platform_connections row each surface authenticates through.
// Facebook Page and Instagram share Meta's one connection; TikTok organic
// posting uses its own separate 'tiktok_content' connection (see file
// header + sql/059 for why).
const SURFACE_TO_CONNECTION_PLATFORM = {
  facebook_page: 'meta',
  instagram: 'meta',
  tiktok_video: 'tiktok_content',
};

// Which post types each surface can actually publish, given the adapters
// built so far. Facebook Page posting here is text/link only (no
// /photos or /videos endpoint wired up yet); Instagram and TikTok have no
// text-only post type on their own platforms.
const SURFACE_POST_TYPES = {
  facebook_page: new Set(['text', 'link']),
  instagram: new Set(['image', 'video']),
  tiktok_video: new Set(['video']),
};

// TikTok's bearer token comes from a different place than every other
// surface: it lives (encrypted) in Supabase and auto-refreshes every 24h
// (api/_lib/tiktok-token.js), instead of a static Vercel env var named by
// connection.env_var_name. deps.getValidTikTokAccessToken lets tests inject
// a fake without touching Supabase. Any failure (not connected yet, refresh
// token revoked, etc.) is allowed to propagate -- the caller turns it into
// an honest connectionNotReady refusal with the real reason attached.
async function resolveSocialConn(surface, connection, deps = {}) {
  if (surface === 'tiktok_video') {
    const getToken = deps.getValidTikTokAccessToken || defaultGetValidTikTokAccessToken;
    const accessToken = await getToken();
    return accessToken ? { accessToken } : null;
  }

  if (!connection || !connection.env_var_name) return null;
  const raw = process.env[connection.env_var_name];
  if (!raw) return null;

  if (surface === 'facebook_page' || surface === 'instagram') {
    if (!connection.page_id) return null;
    return { accessToken: raw, pageId: connection.page_id };
  }
  return null;
}

function contentCompletenessError(surface, postType, content) {
  if (postType === 'text' || postType === 'link') {
    if (!content || !content.text || !String(content.text).trim()) {
      return SURFACE_LABELS[surface] + ' posts require real text.';
    }
  }
  if (postType === 'image' || postType === 'video') {
    if (!content || !content.mediaUrl || !String(content.mediaUrl).trim()) {
      return SURFACE_LABELS[surface] + ' has no text-only post type -- a real, publicly-fetchable mediaUrl is required. Asset upload is not wired up in this build yet.';
    }
  }
  return null;
}

export async function handleSocialPostsGet(req, res, supabaseRequest = defaultSupabaseRequest) {
  const platform = req.query && req.query.platform;
  const status = req.query && req.query.status;
  let query = 'social_posts?tenant_id=eq.ghgrp&select=*&order=created_at.desc';
  if (platform) query += '&platform=eq.' + encodeURIComponent(platform);
  if (status) query += '&status=eq.' + encodeURIComponent(status);
  const listRes = await supabaseRequest(query);
  if (!listRes.ok) return res.status(500).json({ ok: false, error: await listRes.text() });
  const posts = await listRes.json();
  res.status(200).json({ ok: true, posts });
}

export async function handleSocialPostDraftPost(req, res, supabaseRequest = defaultSupabaseRequest) {
  const b = req.body || {};
  const surface = String(b.surface || '').trim();
  const postType = String(b.postType || '').trim();

  if (!SOCIAL_SURFACES.has(surface)) {
    return res.status(400).json({ ok: false, error: 'surface must be one of: ' + [...SOCIAL_SURFACES].join(', ') + '.' });
  }
  if (!SURFACE_POST_TYPES[surface].has(postType)) {
    return res.status(400).json({ ok: false, error: SURFACE_LABELS[surface] + ' only supports these post types: ' + [...SURFACE_POST_TYPES[surface]].join(', ') + '.' });
  }

  const content = {
    text: b.text ? String(b.text).trim().slice(0, 5000) : null,
    linkUrl: b.linkUrl ? String(b.linkUrl).trim() : null,
    mediaUrl: b.mediaUrl ? String(b.mediaUrl).trim() : null,
    mediaType: b.mediaType ? String(b.mediaType).trim() : null,
  };

  const completenessError = contentCompletenessError(surface, postType, content);
  if (completenessError) {
    return res.status(400).json({ ok: false, error: completenessError });
  }

  const payload = {
    tenant_id: 'ghgrp',
    platform: SURFACE_TO_PLATFORM[surface],
    surface,
    post_type: postType,
    content,
    status: 'draft',
    created_by: 'reina',
  };
  const insertRes = await supabaseRequest('social_posts', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([payload]),
  });
  if (!insertRes.ok) return res.status(500).json({ ok: false, error: await insertRes.text() });
  const [inserted] = await insertRes.json();
  res.status(200).json({ ok: true, post: inserted });
}

// ---------- One-click approve -> auto-schedule (Reina automation, task #100) ----------
// Preferred local (America/New_York -- Greenwich, CT is Eastern time) posting
// hours per surface. Deliberately spread through the business day rather than
// clustering around one hour, so approving several drafts back-to-back doesn't
// pile them all into the same slot.
const SOCIAL_AUTOSCHEDULE_HOURS = {
  facebook_page: [9, 13, 17],
  instagram: [11, 15, 19],
  tiktok_video: [12, 18],
};
const SOCIAL_AUTOSCHEDULE_MIN_LEAD_MINUTES = 90; // never auto-schedule less than 90 minutes out
const SOCIAL_AUTOSCHEDULE_MIN_GAP_HOURS = 3; // keep same-surface posts at least 3h apart

// America/New_York's UTC offset (in minutes, positive = behind UTC) at a given
// instant -- correct across DST since Intl resolves the real US DST rules for
// whatever date is passed in, rather than a hardcoded EST/EDT assumption.
function nyOffsetMinutesAt(instant) {
  const asUtc = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asNy = new Date(instant.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return Math.round((asUtc.getTime() - asNy.getTime()) / 60000);
}

// Builds the real UTC instant for "dayOffset days from now, at `hour`:00
// America/New_York time" -- two-pass so the DST offset used is the one that
// actually applies on that calendar date, not today's.
function nyLocalSlotToUtc(now, dayOffset, hour) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const y = Number(map.year), m = Number(map.month), d = Number(map.day) + dayOffset;
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const offsetMin = nyOffsetMinutesAt(naiveUtc);
  return new Date(naiveUtc.getTime() + offsetMin * 60000);
}

// Picks the next real, sensible send time for a freshly-approved post: the
// earliest preferred slot for its surface that is (a) at least
// SOCIAL_AUTOSCHEDULE_MIN_LEAD_MINUTES from now and (b) at least
// SOCIAL_AUTOSCHEDULE_MIN_GAP_HOURS away from every other post already
// scheduled on that same surface -- so approving three Instagram drafts in a
// row spreads them out instead of stacking them in the same slot.
function computeAutoScheduleSlot(surface, existingScheduledForIso, now) {
  const hours = SOCIAL_AUTOSCHEDULE_HOURS[surface] || [10, 14, 18];
  const existingMs = (existingScheduledForIso || []).map((s) => new Date(s).getTime()).filter((t) => !Number.isNaN(t));
  const minLeadMs = SOCIAL_AUTOSCHEDULE_MIN_LEAD_MINUTES * 60000;
  const minGapMs = SOCIAL_AUTOSCHEDULE_MIN_GAP_HOURS * 3600000;
  for (let dayOffset = 0; dayOffset <= 21; dayOffset++) {
    for (const hour of hours) {
      const candidate = nyLocalSlotToUtc(now, dayOffset, hour);
      if (candidate.getTime() - now.getTime() < minLeadMs) continue;
      if (existingMs.some((t) => Math.abs(t - candidate.getTime()) < minGapMs)) continue;
      return candidate;
    }
  }
  // Should be unreachable in practice (21 days x up to 3 slots/day with only
  // a 3h gap constraint), but never return nothing -- fall back to the
  // earliest allowed lead time rather than throwing.
  return new Date(now.getTime() + minLeadMs);
}

export async function handleSocialPostReviewPost(req, res, supabaseRequest = defaultSupabaseRequest) {
  const b = req.body || {};
  const postId = String(b.postId || '').trim();
  const decision = String(b.decision || '').trim();
  if (!postId) return res.status(400).json({ ok: false, error: 'postId is required.' });
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ ok: false, error: 'decision must be "approve" or "reject".' });
  }

  const postRes = await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(postId) + '&select=*&limit=1');
  if (!postRes.ok) return res.status(500).json({ ok: false, error: await postRes.text() });
  const [post] = await postRes.json();
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found.' });
  if (post.status !== 'draft') {
    return res.status(409).json({ ok: false, error: 'This post is already "' + post.status + '" -- it can only be reviewed while in draft.' });
  }

  if (decision === 'reject') {
    const reason = b.reason ? String(b.reason).trim().slice(0, 2000) : null;
    const patchRes = await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(postId), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'rejected', rejection_reason: reason, updated_at: new Date().toISOString() }),
    });
    if (!patchRes.ok) return res.status(500).json({ ok: false, error: await patchRes.text() });
    return res.status(200).json({ ok: true, postId, status: 'rejected' });
  }

  const completenessError = contentCompletenessError(post.surface, post.post_type, post.content);
  if (completenessError) {
    return res.status(409).json({ ok: false, error: 'Cannot approve -- ' + completenessError });
  }

  // Task #100: approving now auto-schedules in the same click -- no separate
  // "pick a date/time" step required. An explicit future scheduledFor in the
  // request body still overrides the auto-pick.
  const now = new Date();
  let scheduledFor = null;
  let autoScheduled = true;
  if (b.scheduledFor) {
    const manual = new Date(b.scheduledFor);
    if (!Number.isNaN(manual.getTime()) && manual.getTime() > now.getTime()) {
      scheduledFor = manual;
      autoScheduled = false;
    }
  }
  if (!scheduledFor) {
    const existingRes = await supabaseRequest('social_posts?surface=eq.' + encodeURIComponent(post.surface) + '&status=eq.scheduled&select=scheduled_for');
    const existing = existingRes.ok ? (await existingRes.json()).map((r) => r.scheduled_for) : [];
    scheduledFor = computeAutoScheduleSlot(post.surface, existing, now);
  }

  const actorEmail = (req.hlUser && req.hlUser.email) || 'owner';
  const patchRes = await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(postId), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'scheduled',
      approved_by: actorEmail,
      approved_at: now.toISOString(),
      scheduled_for: scheduledFor.toISOString(),
      updated_at: now.toISOString(),
    }),
  });
  if (!patchRes.ok) return res.status(500).json({ ok: false, error: await patchRes.text() });
  res.status(200).json({ ok: true, postId, status: 'scheduled', scheduledFor: scheduledFor.toISOString(), autoScheduled });
}

export async function handleSocialPostSchedulePost(req, res, supabaseRequest = defaultSupabaseRequest) {
  const b = req.body || {};
  const postId = String(b.postId || '').trim();
  if (!postId) return res.status(400).json({ ok: false, error: 'postId is required.' });

  const scheduledFor = b.scheduledFor ? new Date(b.scheduledFor) : null;
  if (!scheduledFor || Number.isNaN(scheduledFor.getTime())) {
    return res.status(400).json({ ok: false, error: 'scheduledFor must be a valid date/time.' });
  }
  if (scheduledFor.getTime() <= Date.now()) {
    return res.status(400).json({ ok: false, error: 'scheduledFor must be in the future -- use social_post_publish to post immediately.' });
  }

  const postRes = await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(postId) + '&select=*&limit=1');
  if (!postRes.ok) return res.status(500).json({ ok: false, error: await postRes.text() });
  const [post] = await postRes.json();
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found.' });
  if (post.status !== 'pending_review' && post.status !== 'scheduled') {
    return res.status(409).json({ ok: false, error: 'This post is "' + post.status + '" -- it can only be scheduled (or rescheduled) after approval.' });
  }

  const patchRes = await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(postId), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'scheduled', scheduled_for: scheduledFor.toISOString(), updated_at: new Date().toISOString() }),
  });
  if (!patchRes.ok) return res.status(500).json({ ok: false, error: await patchRes.text() });
  res.status(200).json({ ok: true, postId, status: 'scheduled', scheduledFor: scheduledFor.toISOString() });
}

// ---------- the real platform action, shared by manual publish + the cron sweep ----------

function classifiedFromError(e) {
  return e.metaClassified || e.tiktokClassified || { state: 'needs_attention', reason: 'social_post_unclassified_error', message: e.message };
}

async function publishSocialPostNow(post, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const connPlatform = SURFACE_TO_CONNECTION_PLATFORM[post.surface];

  const connRes = await supabaseRequest('ad_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(connPlatform) + '&select=*&limit=1');
  if (!connRes.ok) throw new Error('Failed to read connection: ' + (await connRes.text()));
  const [connection] = await connRes.json();
  if (!connection || connection.state !== 'launch_enabled') {
    const err = new Error(SURFACE_LABELS[post.surface] + ' connection is not launch_enabled yet (' + (connection ? connection.state : 'not_connected') + ') -- complete the connect/verify sequence first.');
    err.connectionNotReady = true;
    throw err;
  }

  let conn;
  try {
    conn = await resolveSocialConn(post.surface, connection, deps);
  } catch (connErr) {
    const err = new Error(SURFACE_LABELS[post.surface] + ' connection error: ' + connErr.message);
    err.connectionNotReady = true;
    throw err;
  }
  if (!conn) {
    const err = new Error(SURFACE_LABELS[post.surface] + ' setup is not fully complete yet -- Chris still needs to finish adding its real credentials.');
    err.connectionNotReady = true;
    throw err;
  }

  let publishResult;
  try {
    if (post.surface === 'facebook_page') {
      const postFn = deps.postFacebookPageText || defaultPostFacebookPageText;
      publishResult = await postFn({ accessToken: conn.accessToken, pageId: conn.pageId, text: post.content.text, linkUrl: post.content.linkUrl }, deps.fetchImpl);
    } else if (post.surface === 'instagram') {
      const postFn = deps.postInstagramMedia || defaultPostInstagramMedia;
      publishResult = await postFn({ accessToken: conn.accessToken, pageId: conn.pageId, mediaUrl: post.content.mediaUrl, mediaType: post.content.mediaType, caption: post.content.text }, deps.fetchImpl);
    } else if (post.surface === 'tiktok_video') {
      const postFn = deps.postTikTokVideo || defaultPostTikTokVideo;
      publishResult = await postFn({ accessToken: conn.accessToken, videoUrl: post.content.mediaUrl, title: post.content.text, privacyLevel: post.content.privacyLevel }, deps.fetchImpl);
    } else {
      throw new Error('Unknown surface: ' + post.surface);
    }
  } catch (e) {
    const classified = classifiedFromError(e);
    if (isValidConnectionTransition(connection.state, classified.state)) {
      await supabaseRequest('ad_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(connPlatform), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ state: classified.state, last_error: classified.message || e.message, updated_at: new Date().toISOString() }),
      });
    }
    await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(post.id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'failed', last_error: classified.message || e.message, updated_at: new Date().toISOString() }),
    });
    const wrapped = new Error(SURFACE_LABELS[post.surface] + ' publish failed: ' + (classified.message || e.message));
    wrapped.classified = classified;
    throw wrapped;
  }

  const patchRes = await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(post.id), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'posted',
      external_post_id: publishResult.externalPostId,
      posted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!patchRes.ok) throw new Error('Failed to update post after successful publish: ' + (await patchRes.text()));

  return { externalPostId: publishResult.externalPostId };
}

export async function handleSocialPostPublishPost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const b = req.body || {};
  const postId = String(b.postId || '').trim();
  if (!postId) return res.status(400).json({ ok: false, error: 'postId is required.' });

  const postRes = await supabaseRequest('social_posts?id=eq.' + encodeURIComponent(postId) + '&select=*&limit=1');
  if (!postRes.ok) return res.status(500).json({ ok: false, error: await postRes.text() });
  const [post] = await postRes.json();
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found.' });
  if (post.status !== 'pending_review' && post.status !== 'scheduled') {
    return res.status(409).json({ ok: false, error: 'This post is "' + post.status + '" -- it can only be published from pending_review or scheduled.' });
  }

  try {
    const publishResult = await publishSocialPostNow(post, deps);
    return res.status(200).json({ ok: true, postId, status: 'posted', publishResult });
  } catch (e) {
    if (e.connectionNotReady) return res.status(409).json({ ok: false, error: e.message });
    return res.status(502).json({ ok: false, error: e.message, classified: e.classified });
  }
}

export async function handleProcessScheduledPostsGet(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const nowIso = new Date().toISOString();
  const dueRes = await supabaseRequest('social_posts?tenant_id=eq.ghgrp&status=eq.scheduled&scheduled_for=lte.' + encodeURIComponent(nowIso) + '&select=*');
  if (!dueRes.ok) return res.status(500).json({ ok: false, error: await dueRes.text() });
  const duePosts = await dueRes.json();

  const results = [];
  for (const post of duePosts) {
    try {
      const publishResult = await publishSocialPostNow(post, deps);
      results.push({ postId: post.id, ok: true, externalPostId: publishResult.externalPostId });
    } catch (e) {
      // Best-effort: one post's failure never blocks the rest of the sweep.
      results.push({ postId: post.id, ok: false, error: e.message });
    }
  }

  res.status(200).json({
    ok: true,
    processed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}

export default async function handler(req, res) {
  const resource = req.query.resource;

  // Same shared-secret cron bypass as api/marketing.js's
  // process_scheduled_sends -- Vercel Cron carries no Supabase user
  // session, so it must skip requireUser via CRON_SECRET instead.
  if (resource === 'process_scheduled_posts') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      try { return await handleProcessScheduledPostsGet(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }
  }

  const user = await requireUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Not authenticated. Sign in and try again.' });
  }
  req.hlUser = user;

  try {
    if (resource === 'social_posts' && req.method === 'GET') {
      return await handleSocialPostsGet(req, res);
    }
    if (resource === 'social_post_draft' && req.method === 'POST') {
      return await handleSocialPostDraftPost(req, res);
    }
    if (resource === 'social_post_review' && req.method === 'POST') {
      return await handleSocialPostReviewPost(req, res);
    }
    if (resource === 'social_post_schedule' && req.method === 'POST') {
      return await handleSocialPostSchedulePost(req, res);
    }
    if (resource === 'social_post_publish' && req.method === 'POST') {
      return await handleSocialPostPublishPost(req, res);
    }
    return res.status(404).json({ ok: false, error: 'Unknown resource: ' + resource });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export { SOCIAL_SURFACES, SURFACE_LABELS, SURFACE_TO_PLATFORM, SURFACE_TO_CONNECTION_PLATFORM, SURFACE_POST_TYPES };
