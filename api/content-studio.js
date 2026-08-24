// api/content-studio.js - Vercel serverless function
// Short-form video production: real job photos (or captured app screens) plus
// an AI-written script plus a real spoken voiceover, assembled into a real
// video file and handed to the existing human approval queue.
//
// Why the actual video assembly is NOT in this file: Vercel serverless
// functions have no ffmpeg binary, a hard bundle-size ceiling, and an
// execution timeout measured in seconds. Encoding video there would be
// fragile at best. The browser already has a hardware-accelerated encoder
// (canvas.captureStream + MediaRecorder), so the frames and the voiceover are
// prepared here and the render happens in public/reel-studio.js. This file
// receives the finished file back and stores it.
//
// Usage:
//   GET  /api/content-studio?resource=reel_candidates[&minPhotos=&limit=]
//     -> real completed jobs with enough real photos to build a reel from.
//   GET  /api/content-studio?resource=reels[&status=&kind=]
//     -> current reels/commercials and where each one is in the pipeline.
//   POST /api/content-studio?resource=reel_draft
//     body: { jobId }  (or { kind:'commercial', title })
//     -> creates the content_reels row. Nothing is generated yet.
//   POST /api/content-studio?resource=reel_script
//     body: { reelId }
//     -> Claude writes hook / per-shot beats / caption, grounded only in real
//        job facts, with no customer detail of any kind (see reel-builder.js).
//   POST /api/content-studio?resource=reel_voiceover
//     body: { reelId, voice? }
//     -> records a REAL spoken mp3 of the script through the same OpenAI TTS
//        path Reina's production voice already uses, and stores it.
//   GET  /api/content-studio?resource=reel_frames&reelId=
//     -> signed, short-lived URLs for this reel's frames, for the browser
//        renderer. Customer photos never get a permanent public link.
//   POST /api/content-studio?resource=reel_video
//     body: { reelId, contentType, dataBase64 }
//     -> stores the finished video the browser rendered and records its
//        public URL (which Instagram and TikTok fetch server-side).
//   POST /api/content-studio?resource=reel_queue
//     body: { reelId, surface }
//     -> hands the finished video to social_posts as a DRAFT. This is the
//        handoff to the existing human approval gate; it does not publish.
//   POST /api/content-studio?resource=reel_reject
//     body: { reelId, reason? }
//
// Nothing here publishes to a platform. The last step this file can perform
// is creating a draft in the Content Approval queue that a human still has to
// approve, exactly like every other content path in this codebase.

import { supabaseRequest as defaultSupabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/require-user.js';
import { realServiceTerritoryFacts } from './_lib/ad-copy-grounding.js';
import {
  selectReelCandidates,
  chooseReelFrames,
  writeReelScript,
  renderReelVoiceover,
  isReelScriptConfigured,
  isReelVoiceConfigured,
  narrationText,
  REEL_BUCKET,
  MEDIA_BUCKET,
} from './_lib/reel-builder.js';
import { storageUpload, storageSignedUrl, storagePublicUrl } from './_lib/supabase-storage.js';

const TENANT = 'ghgrp';
const SOCIAL_SURFACES = new Set(['instagram', 'tiktok_video', 'facebook_page']);

// A rendered video arrives as base64 in a JSON body. 60 MB of base64 is about
// 45 MB of video -- comfortably above a 3-minute 1080p product film and well
// below the point where the request body becomes the problem.
const MAX_VIDEO_BASE64_BYTES = 60 * 1024 * 1024;

function reelShape(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    jobId: row.job_id,
    division: row.division,
    status: row.status,
    photoIds: row.photo_ids || [],
    frameAssets: row.frame_assets || [],
    script: row.script,
    voiceName: row.voice_name,
    voiceUrl: row.voice_path ? storagePublicUrl(REEL_BUCKET, row.voice_path) : null,
    videoUrl: row.video_public_url,
    socialPostId: row.social_post_id,
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at,
  };
}

async function loadReel(reelId, supabaseRequest) {
  const res = await supabaseRequest(`content_reels?id=eq.${encodeURIComponent(reelId)}&select=*`);
  if (!res.ok) throw new Error(await res.text());
  const [row] = await res.json();
  return row || null;
}

async function patchReel(reelId, patch, supabaseRequest) {
  const res = await supabaseRequest(`content_reels?id=eq.${encodeURIComponent(reelId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(await res.text());
  const [row] = await res.json();
  return row;
}

export async function handleReelCandidatesGet(req, res, deps = {}) {
  const candidates = await selectReelCandidates({
    minPhotos: req.query.minPhotos,
    limit: req.query.limit,
  }, deps);
  res.status(200).json({
    ok: true,
    candidates: candidates.map((c) => ({
      jobId: c.jobId,
      title: c.title,
      division: c.division,
      completedAt: c.completedAt,
      photoCount: c.photoCount,
    })),
  });
}

export async function handleReelsGet(req, res, supabaseRequest = defaultSupabaseRequest) {
  let query = `content_reels?tenant_id=eq.${TENANT}&select=*&order=created_at.desc&limit=100`;
  if (req.query.status) query += `&status=eq.${encodeURIComponent(req.query.status)}`;
  if (req.query.kind) query += `&kind=eq.${encodeURIComponent(req.query.kind)}`;
  const r = await supabaseRequest(query);
  if (!r.ok) return res.status(500).json({ ok: false, error: await r.text() });
  res.status(200).json({ ok: true, reels: (await r.json()).map(reelShape) });
}

export async function handleReelDraftPost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const b = req.body || {};
  const kind = b.kind === 'commercial' ? 'commercial' : 'reel';

  let payload;
  if (kind === 'commercial') {
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ ok: false, error: 'title is required for a commercial.' });
    payload = { tenant_id: TENANT, kind: 'commercial', title, status: 'draft', created_by: 'reina' };
  } else {
    const jobId = String(b.jobId || '').trim();
    if (!jobId) return res.status(400).json({ ok: false, error: 'jobId is required.' });
    const candidates = await selectReelCandidates({ limit: 200 }, deps);
    const candidate = candidates.find((c) => c.jobId === jobId);
    if (!candidate) {
      return res.status(404).json({ ok: false, error: 'That job is not a reel candidate -- it needs enough real photos and no existing reel.' });
    }
    payload = {
      tenant_id: TENANT,
      kind: 'reel',
      title: candidate.title,
      job_id: candidate.jobId,
      job_uuid: candidate.jobUuid,
      division: candidate.division,
      status: 'draft',
      photo_ids: chooseReelFrames(candidate.photos).map((p) => p.id),
      created_by: 'reina',
    };
  }

  const insertRes = await supabaseRequest('content_reels', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([payload]),
  });
  if (!insertRes.ok) return res.status(500).json({ ok: false, error: await insertRes.text() });
  const [inserted] = await insertRes.json();
  res.status(200).json({ ok: true, reel: reelShape(inserted) });
}

export async function handleReelScriptPost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const reelId = String((req.body || {}).reelId || '').trim();
  if (!reelId) return res.status(400).json({ ok: false, error: 'reelId is required.' });
  if (!isReelScriptConfigured(deps)) {
    return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment -- cannot write a script yet.' });
  }
  const reel = await loadReel(reelId, supabaseRequest);
  if (!reel) return res.status(404).json({ ok: false, error: 'That reel no longer exists.' });

  const frameCount = (reel.photo_ids || []).length || (reel.frame_assets || []).length;
  if (!frameCount) return res.status(409).json({ ok: false, error: 'This reel has no frames yet -- there is nothing to write shots for.' });

  const territoryFacts = await realServiceTerritoryFacts(supabaseRequest);
  let script;
  try {
    script = await writeReelScript({
      division: reel.division || 'Handyman',
      jobTitle: reel.title || '',
      frameCount,
      territoryFacts,
    }, deps);
  } catch (e) {
    if (e.notConfigured) return res.status(409).json({ ok: false, error: e.message });
    return res.status(502).json({ ok: false, error: e.message });
  }
  const updated = await patchReel(reelId, { script, status: 'script_ready' }, supabaseRequest);
  res.status(200).json({ ok: true, reel: reelShape(updated), narration: narrationText(script) });
}

export async function handleReelVoiceoverPost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const b = req.body || {};
  const reelId = String(b.reelId || '').trim();
  if (!reelId) return res.status(400).json({ ok: false, error: 'reelId is required.' });
  if (!isReelVoiceConfigured()) {
    return res.status(409).json({ ok: false, error: 'OPENAI_API_KEY is not set for this deployment -- cannot record a voiceover yet.' });
  }
  const reel = await loadReel(reelId, supabaseRequest);
  if (!reel) return res.status(404).json({ ok: false, error: 'That reel no longer exists.' });
  if (!reel.script) return res.status(409).json({ ok: false, error: 'Write the script first -- there is nothing to narrate.' });

  let voice;
  try {
    voice = await renderReelVoiceover({ reelId, script: reel.script, voice: b.voice }, deps);
  } catch (e) {
    if (e.notConfigured) return res.status(409).json({ ok: false, error: e.message });
    return res.status(502).json({ ok: false, error: e.message });
  }
  const updated = await patchReel(reelId, {
    voice_path: voice.path, voice_name: voice.voice, status: 'voice_ready',
  }, supabaseRequest);
  res.status(200).json({ ok: true, reel: reelShape(updated), voiceUrl: voice.publicUrl });
}

// Signed URLs for the renderer. Customer job photos live in a private bucket
// and get a one-hour signed URL each; commercial frames live in the public
// reels bucket and use their permanent URL.
export async function handleReelFramesGet(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const reelId = String(req.query.reelId || '').trim();
  if (!reelId) return res.status(400).json({ ok: false, error: 'reelId is required.' });
  const reel = await loadReel(reelId, supabaseRequest);
  if (!reel) return res.status(404).json({ ok: false, error: 'That reel no longer exists.' });

  const sign = deps.storageSignedUrl || storageSignedUrl;
  const frames = [];

  const photoIds = reel.photo_ids || [];
  if (photoIds.length) {
    const inList = photoIds.map((id) => '"' + id + '"').join(',');
    const mediaRes = await supabaseRequest(`media?id=in.(${inList})&select=id,storage_path`);
    if (!mediaRes.ok) return res.status(500).json({ ok: false, error: await mediaRes.text() });
    const byId = new Map((await mediaRes.json()).map((m) => [m.id, m.storage_path]));
    for (const id of photoIds) {
      const path = byId.get(id);
      if (!path) continue;
      frames.push({ id, url: await sign(MEDIA_BUCKET, path, 3600, deps) });
    }
  }
  for (const asset of (reel.frame_assets || [])) {
    if (!asset || !asset.path) continue;
    frames.push({ id: asset.path, url: storagePublicUrl(asset.bucket || REEL_BUCKET, asset.path), onScreenText: asset.onScreenText || null });
  }

  res.status(200).json({
    ok: true,
    reel: reelShape(reel),
    frames,
    voiceUrl: reel.voice_path ? storagePublicUrl(REEL_BUCKET, reel.voice_path) : null,
  });
}

export async function handleReelVideoPost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const b = req.body || {};
  const reelId = String(b.reelId || '').trim();
  const contentType = String(b.contentType || '').trim();
  const dataBase64 = String(b.dataBase64 || '');

  if (!reelId) return res.status(400).json({ ok: false, error: 'reelId is required.' });
  if (!/^video\/(mp4|webm|quicktime)$/.test(contentType)) {
    return res.status(400).json({ ok: false, error: 'contentType must be video/mp4, video/webm, or video/quicktime.' });
  }
  if (!dataBase64) return res.status(400).json({ ok: false, error: 'dataBase64 is required.' });
  if (dataBase64.length > MAX_VIDEO_BASE64_BYTES) {
    return res.status(413).json({ ok: false, error: 'That video is too large to store through this endpoint.' });
  }
  const reel = await loadReel(reelId, supabaseRequest);
  if (!reel) return res.status(404).json({ ok: false, error: 'That reel no longer exists.' });

  const ext = contentType === 'video/mp4' ? 'mp4' : (contentType === 'video/webm' ? 'webm' : 'mov');
  const path = 'video/' + reelId + '.' + ext;
  const upload = deps.storageUpload || storageUpload;
  await upload(REEL_BUCKET, path, Buffer.from(dataBase64, 'base64'), contentType, deps);

  const updated = await patchReel(reelId, {
    video_path: path,
    video_public_url: storagePublicUrl(REEL_BUCKET, path),
    status: 'rendered',
  }, supabaseRequest);
  res.status(200).json({ ok: true, reel: reelShape(updated) });
}

export async function handleReelQueuePost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const b = req.body || {};
  const reelId = String(b.reelId || '').trim();
  const surface = String(b.surface || '').trim();
  if (!reelId) return res.status(400).json({ ok: false, error: 'reelId is required.' });
  if (!SOCIAL_SURFACES.has(surface)) {
    return res.status(400).json({ ok: false, error: 'surface must be one of: ' + [...SOCIAL_SURFACES].join(', ') + '.' });
  }
  const reel = await loadReel(reelId, supabaseRequest);
  if (!reel) return res.status(404).json({ ok: false, error: 'That reel no longer exists.' });
  if (!reel.video_public_url) {
    return res.status(409).json({ ok: false, error: 'Render the video first -- there is no file to post.' });
  }

  const script = reel.script || {};
  const caption = [script.caption, (script.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  const insertRes = await supabaseRequest('social_posts', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      tenant_id: TENANT,
      surface,
      platform: surface === 'tiktok_video' ? 'tiktok' : 'meta',
      post_type: 'video',
      status: 'draft',
      content: { text: caption, mediaUrl: reel.video_public_url, mediaType: 'video' },
      created_by: 'reina_content_studio',
    }]),
  });
  if (!insertRes.ok) return res.status(500).json({ ok: false, error: await insertRes.text() });
  const [post] = await insertRes.json();
  const updated = await patchReel(reelId, { status: 'queued', social_post_id: post.id }, supabaseRequest);
  res.status(200).json({ ok: true, reel: reelShape(updated), socialPostId: post.id });
}

export async function handleReelRejectPost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const b = req.body || {};
  const reelId = String(b.reelId || '').trim();
  if (!reelId) return res.status(400).json({ ok: false, error: 'reelId is required.' });
  const reel = await loadReel(reelId, supabaseRequest);
  if (!reel) return res.status(404).json({ ok: false, error: 'That reel no longer exists.' });
  const updated = await patchReel(reelId, {
    status: 'rejected',
    rejected_reason: b.reason ? String(b.reason).trim() : null,
  }, supabaseRequest);
  res.status(200).json({ ok: true, reel: reelShape(updated) });
}

export default async function handler(req, res) {
  const resource = req.query.resource;

  const user = await requireUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Not authenticated. Sign in and try again.' });
  }
  req.hlUser = user;

  try {
    if (resource === 'reel_candidates' && req.method === 'GET') return await handleReelCandidatesGet(req, res);
    if (resource === 'reels' && req.method === 'GET') return await handleReelsGet(req, res);
    if (resource === 'reel_frames' && req.method === 'GET') return await handleReelFramesGet(req, res);
    if (resource === 'reel_draft' && req.method === 'POST') return await handleReelDraftPost(req, res);
    if (resource === 'reel_script' && req.method === 'POST') return await handleReelScriptPost(req, res);
    if (resource === 'reel_voiceover' && req.method === 'POST') return await handleReelVoiceoverPost(req, res);
    if (resource === 'reel_video' && req.method === 'POST') return await handleReelVideoPost(req, res);
    if (resource === 'reel_queue' && req.method === 'POST') return await handleReelQueuePost(req, res);
    if (resource === 'reel_reject' && req.method === 'POST') return await handleReelRejectPost(req, res);
    return res.status(404).json({ ok: false, error: 'Unknown resource: ' + resource });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
