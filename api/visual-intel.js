// api/visual-intel.js - Vercel serverless function
// Visual Intelligence: read/write for job photo & video documentation --
// media list/detail, tags, annotations, timeline events, comments, and AI
// analysis. Deliberately its own function, NOT folded into api/track1.js
// (see build notes: a bad edit to the shared dispatcher took down all 18 of
// its resources at once; media/photo handling also has different payload
// needs than the rest of the app). Follows the same conventions as
// api/jobs.js / api/clients.js: plain handler, supabaseRequest() for all DB
// access, { ok, source, ...data } / { ok:false, error } response shape.
//
// The actual photo/video BYTES never pass through this function -- the
// browser uploads directly to Supabase Storage (bucket 'media'), same
// pattern documents.js/index.html already uses for the 'docs' bucket. This
// function only reads/writes the metadata rows and runs AI analysis.
//
// Usage: /api/visual-intel?resource=media|tags|annotations|timeline|comments&jobId=...
//   GET    ?resource=media&jobId=X            list a job's photos/videos
//   GET    ?resource=mediaById&id=X            single media item by id (Visual Intelligence app's media detail page)
//   GET    ?resource=recentMedia&limit=N       most recent media across EVERY job (the "Recent photos" strip)
//   GET    ?resource=mediaSummary              per-job {mediaCount, lastActivityAt} for the Jobs list cards
//   POST   ?resource=media                    create a media row after a Storage upload completes
//   GET    ?resource=tags&jobId=X              list a job's tags
//   POST   ?resource=tags                      create/attach a tag
//   GET    ?resource=annotations&mediaId=X      list a media item's annotations (current, non-superseded)
//   POST   ?resource=annotations                create an annotation (never mutates -- see 006_visual_intel.sql)
//   DELETE ?resource=annotations&id=X           soft-delete (checked at read time, see below)
//   GET    ?resource=timeline&jobId=X           list a job's timeline events
//   POST   ?resource=timeline                   add a manual timeline event
//   GET    ?resource=comments&mediaId=X         list a media item's notes
//   POST   ?resource=comments                   add a note
//   POST   ?resource=analyze                    run AI vision analysis on one media item (see analyzeMedia below)
//   PATCH  ?resource=media&id=X                  update a media item's rotation (the only field editable post-upload)
//   DELETE ?resource=media&id=X                  delete a media item (cascades to its tags/annotations/comments/links, best-effort Storage cleanup)
//   DELETE ?resource=tags&mediaId=X&tagId=Y      unlink one tag from one photo (the tag itself stays if other photos use it)
//   GET    ?resource=entityLinks&mediaId=X       list what a photo is linked to (job, estimate, invoice, etc.)
//   POST   ?resource=entityLinks                 link a photo to any HiveLogic entity (see media_entity_links)
//   DELETE ?resource=entityLinks&id=X            remove a link
//
// mediaById/recentMedia/mediaSummary/annotations-GET were added for the
// Visual Intelligence Phase 1 frontend (the standalone companycam-killer
// prototype's real React app, embedded read-only in HiveLogic via iframe) --
// all four are additive, read-only, and don't touch anything the vanilla
// HiveLogic UI (viLoadGallery/viLoadTimeline/viLoadTags in index.html) relies on.
// The PATCH/DELETE media, tag-unlink, and entityLinks resources below are
// also Phase 1-frontend-only additions (wired up to close out the "isn't
// connected yet" stubs in that app's delete/rotate/tag/link actions) -- same
// additive-only guarantee applies.
import { supabaseRequest } from './_lib/jobber.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// ---------- media ----------

// Every place media rows get selected embeds the same three related tables --
// analysis, tags, and (new) entity links -- so the frontend's mapMedia()
// always sees entityLinks without a second round trip per photo.
const MEDIA_SELECT = '*,media_analysis(*),media_tags(tags(*)),media_entity_links(*)';

async function listMedia(req, res) {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  const r = await supabaseRequest(
    `media?select=${MEDIA_SELECT}&job_id=eq.${encodeURIComponent(jobId)}&order=captured_at.desc&limit=${limit}`
  );
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', jobId, returned: rows.length, media: rows });
}

// Rotation is the only field the viewer lets someone change after upload --
// everything else about a media row is set once at capture time. PATCH
// keeps this distinct from the create-only POST handler above.
async function updateMedia(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const { rotation } = req.body || {};
  if (![0, 90, 180, 270].includes(rotation)) {
    return res.status(400).json({ ok: false, error: 'rotation must be 0, 90, 180, or 270' });
  }
  const r = await supabaseRequest(`media?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ rotation })
  });
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  if (!rows.length) return res.status(404).json({ ok: false, error: 'Media not found' });
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', media: rows[0] });
}

// Deletes the metadata row and lets Postgres's own ON DELETE CASCADE clean
// up media_analysis/media_tags/annotations/media_comments/media_entity_links
// (all defined that way in 006_visual_intel.sql) -- no need to delete each
// child table by hand here. Also best-effort removes the underlying Storage
// object so a deleted photo doesn't linger as an orphaned file; a Storage
// failure never blocks the metadata delete (the row disappearing from every
// gallery/timeline is what actually matters to the user).
async function deleteMedia(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const existing = await supabaseRequest(`media?select=storage_path,thumbnail_path&id=eq.${encodeURIComponent(id)}`);
  if (!existing.ok) throw new Error(await existing.text());
  const [row] = await existing.json();
  if (!row) return res.status(404).json({ ok: false, error: 'Media not found' });

  const r = await supabaseRequest(`media?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());

  // supabaseRequest() always targets /rest/v1/ (PostgREST) -- Storage lives
  // at a different path on the same project, so this hits it directly with
  // the same service-role key rather than going through that helper.
  const paths = [row.storage_path, row.thumbnail_path].filter(Boolean);
  if (paths.length) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/media`, {
        method: 'DELETE',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prefixes: paths })
      });
    } catch (e) {
      console.error('Visual Intelligence: Storage cleanup failed (non-fatal):', e.message);
    }
  }

  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence' });
}

async function createMedia(req, res) {
  const body = req.body || {};
  const required = ['jobId', 'mediaType', 'storagePath', 'capturedAt'];
  const missing = required.filter((k) => !body[k]);
  if (missing.length) return res.status(400).json({ ok: false, error: `Missing: ${missing.join(', ')}` });

  // offline_client_id dedupe: a retried upload with the same client id returns
  // the existing row instead of creating a duplicate (same rule the original
  // companycam-killer prototype used for offline-capture retries).
  if (body.offlineClientId) {
    const existing = await supabaseRequest(`media?select=*&offline_client_id=eq.${encodeURIComponent(body.offlineClientId)}`);
    if (existing.ok) {
      const rows = await existing.json();
      if (rows.length) return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', media: rows[0], deduped: true });
    }
  }

  const insert = {
    job_id: body.jobId,
    media_type: body.mediaType,
    storage_path: body.storagePath,
    mime_type: body.mimeType || null,
    size_bytes: body.sizeBytes || null,
    thumbnail_path: body.thumbnailPath || null,
    captured_at: body.capturedAt,
    gps_lat: body.gpsLat ?? null,
    gps_lng: body.gpsLng ?? null,
    offline_client_id: body.offlineClientId || null,
    uploaded_by: body.uploadedBy || null
  };
  const r = await supabaseRequest('media', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(insert)
  });
  if (!r.ok) throw new Error(await r.text());
  const [row] = await r.json();

  // Auto-append a timeline event for this upload -- same "every photo updates
  // the job timeline without anyone building it by hand" behavior from the
  // original spec. Best-effort: a failure here shouldn't fail the upload.
  try {
    await supabaseRequest('timeline_events', {
      method: 'POST',
      body: JSON.stringify({
        job_id: body.jobId,
        label: `${body.mediaType === 'VIDEO' ? 'Video' : 'Photo'} added`,
        source: 'AUTO',
        media_id: row.id,
        occurred_at: body.capturedAt
      })
    });
  } catch (e) {
    console.error('Visual Intelligence: timeline auto-append failed (non-fatal):', e.message);
  }

  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', media: row });
}

async function getMediaById(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const r = await supabaseRequest(`media?select=${MEDIA_SELECT}&id=eq.${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  if (!rows.length) return res.status(404).json({ ok: false, error: 'Media not found' });
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', media: rows[0] });
}

// Most recent N media across EVERY job -- powers the "Recent photos" strip at
// the top of the Visual Intelligence job list (same idea as CompanyCam's
// company-wide recent-photos view). No jobId filter on purpose.
// Enriches recent-media rows with client name + job number so callers (the
// Command Center's live "Recent job photos" strip) don't need N follow-up
// requests just to caption a photo. media.job_id stores the raw Jobber gid,
// matching jobs.jobber_id -- no formal FK for PostgREST to auto-embed, so
// this batches two lookups (jobs, then clients) scoped to only the distinct
// ids actually present in this page of media, rather than joining per-row.
async function enrichWithJobAndClient(rows) {
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))];
  if (!jobIds.length) return rows;

  const jobsRes = await supabaseRequest(
    `jobs?select=jobber_id,client_id,job_number,title&jobber_id=in.(${jobIds.map((id) => `"${id}"`).join(',')})`
  );
  const jobsById = new Map();
  if (jobsRes.ok) {
    for (const j of await jobsRes.json()) jobsById.set(j.jobber_id, j);
  }

  const clientIds = [...new Set([...jobsById.values()].map((j) => j.client_id).filter(Boolean))];
  const clientsById = new Map();
  if (clientIds.length) {
    const clientsRes = await supabaseRequest(
      `clients?select=jobber_id,name,first_name,last_name,company_name&jobber_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})`
    );
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) {
        clientsById.set(
          c.jobber_id,
          c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null
        );
      }
    }
  }

  return rows.map((r) => {
    const job = jobsById.get(r.job_id);
    return {
      ...r,
      jobNumber: job ? job.job_number : null,
      jobTitle: job ? job.title : null,
      clientName: job ? clientsById.get(job.client_id) || null : null
    };
  });
}

async function listRecentMedia(req, res) {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  const r = await supabaseRequest(`media?select=*,media_analysis(*),media_tags(tags(*))&order=captured_at.desc&limit=${limit}`);
  if (!r.ok) throw new Error(await r.text());
  const enriched = await enrichWithJobAndClient(await r.json());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', media: enriched });
}

// Per-job media aggregate (count + last activity) for the Jobs list cards --
// one lightweight query instead of N per-job round trips. Reduced from the
// most recently active media rows company-wide (bounded, not a full table
// scan), so a job with no recent activity may show as missing here even if
// it has older photos further back -- an accepted Phase 1 simplification,
// consistent with the "recent activity" framing already used elsewhere
// (see loadJobsLive() in index.html).
async function mediaSummary(req, res) {
  // PostgREST caps every single request at 1000 rows no matter what limit=
  // asks for -- the old one-shot version silently saw only the newest 1000
  // media rows, so any job whose photos were all older showed "0 photos" on
  // the Jobs list (confirmed live: 1,819 imported photos, only 20 jobs
  // surfaced). Paginate like everything else does.
  const scanLimit = Math.min(Number(req.query.scanLimit) || 20000, 50000);
  const pageSize = 1000;
  const byJob = {};
  let scanned = 0;
  for (let offset = 0; offset < scanLimit; offset += pageSize) {
    const r = await supabaseRequest(`media?select=job_id,captured_at&order=captured_at.desc&limit=${pageSize}&offset=${offset}`);
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    scanned += rows.length;
    for (const row of rows) {
      const cur = byJob[row.job_id];
      if (!cur) byJob[row.job_id] = { jobId: row.job_id, mediaCount: 1, lastActivityAt: row.captured_at };
      else cur.mediaCount++;
    }
    if (rows.length < pageSize) break;
  }
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', scanned, summary: Object.values(byJob) });
}

async function listAnnotations(req, res) {
  const mediaId = req.query.mediaId;
  if (!mediaId) return res.status(400).json({ ok: false, error: 'mediaId required' });
  const r = await supabaseRequest(`annotations?select=*&media_id=eq.${encodeURIComponent(mediaId)}&superseded_by=is.null&order=created_at.asc`);
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', annotations: await r.json() });
}

// ---------- tags ----------

async function listTags(req, res) {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
  const r = await supabaseRequest(`tags?select=*&job_id=eq.${encodeURIComponent(jobId)}&order=name.asc`);
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', tags: await r.json() });
}

async function createTag(req, res) {
  const { jobId, mediaId, name, source } = req.body || {};
  if (!jobId || !mediaId || !name) return res.status(400).json({ ok: false, error: 'jobId, mediaId, and name required' });

  // Reuse an existing tag with the same name on this job (case-insensitive)
  // instead of creating a duplicate, per the unique index in 006_visual_intel.sql.
  const existing = await supabaseRequest(`tags?select=*&job_id=eq.${encodeURIComponent(jobId)}&name=ilike.${encodeURIComponent(name)}`);
  let tag;
  if (existing.ok) {
    const rows = await existing.json();
    tag = rows[0];
  }
  if (!tag) {
    const created = await supabaseRequest('tags', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ job_id: jobId, name, source: source === 'AI' ? 'AI' : 'MANUAL' })
    });
    if (!created.ok) throw new Error(await created.text());
    [tag] = await created.json();
  }

  const link = await supabaseRequest('media_tags', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ media_id: mediaId, tag_id: tag.id })
  });
  if (!link.ok) throw new Error(await link.text());

  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', tag });
}

// Unlinks a tag from ONE photo (deletes the media_tags join row only) -- the
// tag itself stays, since it's job-scoped and may still be attached to other
// photos on the same job. Matches the photo viewer's per-photo tag chips,
// which remove the tag from that photo, not from the whole job.
async function removeTag(req, res) {
  const mediaId = req.query.mediaId;
  const tagId = req.query.tagId;
  if (!mediaId || !tagId) return res.status(400).json({ ok: false, error: 'mediaId and tagId required' });
  const r = await supabaseRequest(
    `media_tags?media_id=eq.${encodeURIComponent(mediaId)}&tag_id=eq.${encodeURIComponent(tagId)}`,
    { method: 'DELETE' }
  );
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence' });
}

// ---------- entity links ----------
// Polymorphic "attach this photo to any other HiveLogic record" links (see
// media_entity_links in 006_visual_intel.sql, widened in
// 007_entity_links_expand.sql). No validation that entityId actually exists
// in some other table -- most of those modules (estimates, change orders,
// permits, etc.) don't have synced tables of their own yet, so this just
// honestly records the association for whenever they do, same as the
// original spec's "every photo can reference any HiveLogic entity" ask.

async function listEntityLinks(req, res) {
  const mediaId = req.query.mediaId;
  if (!mediaId) return res.status(400).json({ ok: false, error: 'mediaId required' });
  const r = await supabaseRequest(`media_entity_links?select=*&media_id=eq.${encodeURIComponent(mediaId)}&order=created_at.asc`);
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', links: await r.json() });
}

async function createEntityLink(req, res) {
  const { mediaId, entityType, entityId } = req.body || {};
  if (!mediaId || !entityType || !entityId) {
    return res.status(400).json({ ok: false, error: 'mediaId, entityType, and entityId required' });
  }
  const r = await supabaseRequest('media_entity_links', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ media_id: mediaId, entity_type: entityType, entity_id: entityId })
  });
  if (!r.ok) throw new Error(await r.text());
  const [row] = await r.json();
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', link: row });
}

async function deleteEntityLink(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const r = await supabaseRequest(`media_entity_links?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence' });
}

// ---------- annotations ----------

async function createAnnotation(req, res) {
  const { mediaId, annotationType, data, frameTimeMs, createdBy } = req.body || {};
  if (!mediaId || !annotationType || !data) return res.status(400).json({ ok: false, error: 'mediaId, annotationType, and data required' });
  const r = await supabaseRequest('annotations', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      media_id: mediaId, annotation_type: annotationType, data,
      frame_time_ms: frameTimeMs ?? null, created_by: createdBy || null
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const [row] = await r.json();
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', annotation: row });
}

async function deleteAnnotation(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const r = await supabaseRequest(`annotations?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence' });
}

// ---------- timeline ----------

async function listTimeline(req, res) {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
  const r = await supabaseRequest(`timeline_events?select=*&job_id=eq.${encodeURIComponent(jobId)}&order=occurred_at.desc`);
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', timeline: await r.json() });
}

async function createTimelineEvent(req, res) {
  const { jobId, label } = req.body || {};
  if (!jobId || !label) return res.status(400).json({ ok: false, error: 'jobId and label required' });
  const r = await supabaseRequest('timeline_events', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ job_id: jobId, label, source: 'MANUAL', occurred_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(await r.text());
  const [row] = await r.json();
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', event: row });
}

// ---------- comments ----------

async function listComments(req, res) {
  const mediaId = req.query.mediaId;
  if (!mediaId) return res.status(400).json({ ok: false, error: 'mediaId required' });
  const r = await supabaseRequest(`media_comments?select=*&media_id=eq.${encodeURIComponent(mediaId)}&order=created_at.asc`);
  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', comments: await r.json() });
}

async function createComment(req, res) {
  const { mediaId, body, createdBy } = req.body || {};
  if (!mediaId || !body) return res.status(400).json({ ok: false, error: 'mediaId and body required' });
  const r = await supabaseRequest('media_comments', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ media_id: mediaId, body, created_by: createdBy || null })
  });
  if (!r.ok) throw new Error(await r.text());
  const [row] = await r.json();
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', comment: row });
}

// ---------- AI analysis ----------
// Same pattern as api/documents.js's classifyWithClaude/fallbackClassify:
// real Claude call with an honest, low-confidence fallback if the AI is
// unavailable or the call fails -- Law 1 applies here exactly the same way
// documents.js already does it. Confidence is never invented above what the
// method used can actually support.

const TRADES = ['electrical', 'plumbing', 'hvac', 'roofing', 'painting', 'cabinetry', 'flooring', 'tile', 'drywall', 'framing', 'windows', 'doors', 'concrete', 'decks', 'pools', 'landscape', 'general'];

function fallbackAnalyze() {
  return {
    description: null,
    room: null,
    trade: null,
    materials: [],
    damage: null,
    safetyIssue: null,
    confidence: 0,
    reasoning: 'AI analysis unavailable right now -- no fields were guessed.'
  };
}

async function analyzeWithClaude(mimeType, dataBase64) {
  const content = [
    {
      type: 'text',
      text:
        'You are analyzing a construction/home-services job-site photo for HiveLogic. ' +
        'Identify: a one-sentence description, the room (or null), the trade from this list: ' +
        TRADES.join(', ') + ' (or null), a materials array, visible damage (or null), ' +
        'a visible safety issue (or null). Be specific like a contractor would be ' +
        '("200A Square D QO panel, double-tapped breaker") rather than generic ("electrical panel"). ' +
        'Respond with ONLY a JSON object: {"description": string, "room": string|null, ' +
        '"trade": string|null, "materials": string[], "damage": string|null, ' +
        '"safetyIssue": string|null, "confidence": number 0..1}'
    }
  ];
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: dataBase64 } });
  } else {
    throw new Error(`Unsupported media type for analysis: ${mimeType}`);
  }

  const msg = await anthropic.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{ role: 'user', content }]
  });
  const text = msg.content.find((b) => b.type === 'text')?.text || '{}';
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return {
    description: json.description || null,
    room: json.room || null,
    trade: TRADES.includes(json.trade) ? json.trade : null,
    materials: Array.isArray(json.materials) ? json.materials : [],
    damage: json.damage || null,
    safetyIssue: json.safetyIssue || null,
    confidence: Math.max(0, Math.min(1, Number(json.confidence) || 0))
  };
}

async function analyzeMedia(req, res) {
  const { mediaId, mimeType, dataBase64 } = req.body || {};
  if (!mediaId) return res.status(400).json({ ok: false, error: 'mediaId required' });

  let result;
  if (anthropic && dataBase64 && mimeType) {
    try {
      result = await analyzeWithClaude(mimeType, dataBase64);
    } catch (e) {
      console.error('Visual Intelligence: Claude analysis failed, using fallback:', e);
      result = fallbackAnalyze();
    }
  } else {
    result = fallbackAnalyze();
  }

  const r = await supabaseRequest('media_analysis', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      media_id: mediaId,
      description: result.description,
      room: result.room,
      trade: result.trade,
      materials: result.materials,
      damage: result.damage,
      safety_issue: result.safetyIssue,
      confidence: result.confidence,
      model: anthropic ? (process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5') : null,
      analyzed_at: new Date().toISOString()
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const [row] = await r.json();
  return res.status(200).json({ ok: true, source: 'HiveLogic Visual Intelligence', analysis: row });
}

// ---------- dispatch ----------

const GET_HANDLERS = {
  media: listMedia, mediaById: getMediaById, recentMedia: listRecentMedia, mediaSummary,
  tags: listTags, annotations: listAnnotations, timeline: listTimeline, comments: listComments,
  entityLinks: listEntityLinks
};
const POST_HANDLERS = {
  media: createMedia, tags: createTag, annotations: createAnnotation,
  timeline: createTimelineEvent, comments: createComment, analyze: analyzeMedia,
  entityLinks: createEntityLink
};
const PATCH_HANDLERS = {
  media: updateMedia
};
const DELETE_HANDLERS = {
  annotations: deleteAnnotation, media: deleteMedia, tags: removeTag, entityLinks: deleteEntityLink
};

import { requireUser } from './_lib/auth.js';

export default async function handler(req, res) {
  const resource = req.query.resource;
  const _authedUser = await requireUser(req);
  if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  try {
    if (req.method === 'GET') {
      const fn = GET_HANDLERS[resource];
      if (!fn) return res.status(400).json({ ok: false, error: `Unknown or unreadable resource: ${resource}` });
      return await fn(req, res);
    }
    if (req.method === 'POST') {
      const fn = POST_HANDLERS[resource];
      if (!fn) return res.status(400).json({ ok: false, error: `Unknown or unwritable resource: ${resource}` });
      return await fn(req, res);
    }
    if (req.method === 'PATCH') {
      const fn = PATCH_HANDLERS[resource];
      if (!fn) return res.status(400).json({ ok: false, error: `Unknown or unpatchable resource: ${resource}` });
      return await fn(req, res);
    }
    if (req.method === 'DELETE') {
      const fn = DELETE_HANDLERS[resource];
      if (!fn) return res.status(400).json({ ok: false, error: `Unknown or undeletable resource: ${resource}` });
      return await fn(req, res);
    }
    return res.status(405).json({ ok: false, error: `Method ${req.method} not supported for resource ${resource}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
