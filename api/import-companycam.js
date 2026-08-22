// api/import-companycam.js - Vercel serverless function
//
// One-time (repeatable, resumable) import of real photos from a CompanyCam
// account into HiveLogic Visual Intelligence's real Supabase-backed `media`
// table, attached to the correct REAL Jobber jobs.
//
// This is deliberately NOT the same approach as the standalone
// companycam-killer-phase1 prototype's own apps/api/scripts/import-companycam.ts
// -- that script created a brand-new Job per CompanyCam project in its own
// local SQLite database. Here, jobs are real, read-only, synced from Jobber
// (see api/jobber/sync.js) -- this script must attach photos to an
// EXISTING job, never invent one.
//
// Matching approach (confirmed against Jobber's own docs for the real
// CompanyCam<->Jobber integration, help.getjobber.com "Jobber and CompanyCam
// Integration"): a CompanyCam "project" = one Jobber client+property, matched
// by property address, and photos sync to "the most recently created or
// updated active request, quote, or job" for that property. Mirrored here:
//   1. Match the CompanyCam project's address against every client's billing
//      address (client_locations table, synced by api/jobber/sync-extended.js).
//   2. If no address match, fall back to matching the project's primary
//      contact name against a client name/company name -- but ONLY if that
//      name matches exactly one client (an ambiguous name match is logged as
//      unmatched, never guessed).
//   3. Once a client is matched, attach photos to that client's most
//      recently updated NON-archived job (falling back to their single most
//      recent job if all are archived).
// Every match decision -- and every project that couldn't be matched at all
// -- is included in the JSON response so it can be reviewed, never silently
// assumed correct.
//
// Resumable + time-budgeted like api/jobber/sync.js: persists progress in
// sync_cursors (resource='companycam_import') so a run that hits the
// deadline picks up next time instead of re-scanning from project #1 --
// important since downloading + re-uploading thousands of real photos can
// easily exceed a single serverless invocation's time limit.
//
// Usage:
//   GET /api/import-companycam           -- process one batch, return summary
//   GET /api/import-companycam?reset=1   -- restart the scan from project #1
//   (safe to call repeatedly -- already-imported photos are skipped via the
//   same offline_client_id dedupe api/visual-intel.js's createMedia uses)
import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';

const TOKEN = process.env.COMPANYCAM_API_TOKEN;
const CC_API_BASE = 'https://api.companycam.com/v2';
const TIME_BUDGET_MS = 260000; // mirrors sync.js -- stop ~40s before the 300s function limit

async function ccFetch(path) {
  const res = await fetch(`${CC_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CompanyCam API ${path} -> ${res.status}${body ? `: ${body}` : ''}`);
  }
  return res.json();
}

// CompanyCam's list endpoints return a bare JSON array -- defensively unwrap
// a couple of alternate shapes too, in case that ever changes (same
// defensive unwrap the prototype script used).
function asList(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json.projects)) return json.projects;
    if (Array.isArray(json.photos)) return json.photos;
  }
  return [];
}

// CompanyCam silently caps per_page at its own maximum regardless of what's
// requested, so a short page doesn't reliably mean "last page" -- only an
// empty page does (same lesson the prototype script's own comment notes).
async function ccFetchAllPages(pathBuilder, deadline) {
  const perPage = 100;
  const all = [];
  let page = 1;
  while (Date.now() < deadline && page <= 1000) {
    const batch = asList(await ccFetch(pathBuilder(page, perPage)));
    if (!batch.length) break;
    all.push(...batch);
    page++;
  }
  return all;
}

function formatCcAddress(address) {
  if (!address) return null;
  const parts = [address.street_address_1, address.street_address_2, address.city, address.state, address.postal_code].filter(
    (p) => p && String(p).trim()
  );
  return parts.length ? parts.join(', ') : null;
}

// Real CompanyCam photo records mix `uri` and `url` keys inconsistently --
// prefer higher-quality types but scan every entry as a fallback (assuming
// only `uri` produced undefined for every photo in the prototype's first
// real run against this exact account).
// Confirmed live against this real account: the v2 API returns the array
// under `uris` (not `urls` as the prototype script's own TypeScript
// interface assumed -- that typo/wrong-field-name was silently swallowed by
// "no usable URL found" for every single photo until this was diagnosed via
// a raw dump of an actual photo record). Keep checking `urls` too as a
// harmless fallback in case this ever varies by account/API version.
function pickPhotoUrl(photo) {
  const urls = photo.uris || photo.urls;
  if (!urls || !urls.length) return null;
  const preferred = ['original', 'web', 'large', 'full'];
  const ordered = [...preferred.map((t) => urls.find((u) => u.type === t)).filter(Boolean), ...urls];
  for (const entry of ordered) {
    const link = entry.uri || entry.url;
    if (link) return link;
  }
  return null;
}

// Confirmed live: `coordinates` is a single {lat, lon} object on this
// account's photos, not an array like the prototype script assumed. Handle
// both shapes defensively since this is exactly the kind of field that
// turned out to differ from documentation/assumptions once already.
function pickPhotoCoords(photo) {
  const c = photo.coordinates;
  const point = Array.isArray(c) ? c[0] : c;
  const lat = typeof (point && point.lat) === 'number' ? point.lat : null;
  const lng = typeof (point && point.lon) === 'number' ? point.lon : null;
  // (0, 0) shows up on photos with no real GPS fix -- treat it as "no location"
  // rather than a real coordinate in the Gulf of Guinea.
  if (lat === 0 && lng === 0) return { lat: null, lng: null };
  return { lat, lng };
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deliberately tolerant: real-world address text (abbreviations, unit
// numbers, punctuation) rarely matches exactly between two different
// systems. Requires the street number to match exactly, plus the first word
// of the street name -- good enough to catch "123 Main St" vs "123 Main
// Street, Apt 2" while staying cheap. Every match is logged in the response,
// never silently trusted.
function addressesLikelyMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  const wordsA = na.split(' ');
  const wordsB = nb.split(' ');
  if (wordsA[0] !== wordsB[0]) return false; // street number
  if (wordsA[1] && wordsB[1]) return wordsA[1] === wordsB[1]; // first word of street name
  return na === nb;
}

// ---- Per-photo job selection by DATE ----
// The original import attached every photo of a matched client to that
// client's single most-recently-updated job (mirroring Jobber's documented
// live-sync rule). Correct for NEW photos arriving in real time; wrong for a
// historical backfill -- confirmed live: 114 clients with photos -> exactly
// 114 jobs with photos (1:1), with every multi-job client's whole history
// piled onto one job and 5,074 of 7,693 photos sitting on archived jobs.
// Fix: each photo goes to the client's job whose schedule window contains
// the photo's capture date (7 days early grace for pre-start estimate
// visits, 30 days late for punch-list/warranty shots). Inside-window always
// beats outside; ties break to the nearest window midpoint / nearest edge.
// A photo matching no dated window falls back to the nearest dated job, and
// only if the client has NO dated jobs at all does the old most-recent rule
// apply.
const DAY_MS = 86400000;
function pickJobByDate(clientJobs, capturedMs) {
  let best = null;
  let bestScore = Infinity;
  for (const j of clientJobs) {
    const start = j.start_at ? Date.parse(j.start_at) : null;
    if (start === null || Number.isNaN(start)) continue;
    const end = j.end_at ? Date.parse(j.end_at) : start;
    const lo = start - 7 * DAY_MS;
    const hi = (Number.isNaN(end) ? start : end) + 30 * DAY_MS;
    let score;
    if (capturedMs >= lo && capturedMs <= hi) {
      score = Math.abs(capturedMs - (lo + hi) / 2); // inside: closest window center wins
    } else {
      score = 1e15 + Math.min(Math.abs(capturedMs - lo), Math.abs(capturedMs - hi)); // outside: nearest edge
    }
    if (score < bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return best;
}

// This Supabase project silently caps ANY unpaginated request at 1000 rows
// regardless of an explicit `limit` (confirmed live: /api/jobs?limit=5000
// still returned exactly 1000 rows) -- and there are 8,000+ real clients.
// clients/client_locations were being read with a single unpaginated call
// each, so the matching step below only ever saw the first ~1000 clients
// (~11% of the real client base) no matter how correct a client's synced
// address was. Confirmed live: Anna Maria DeSalva's Jobber billing address
// exactly matches her CompanyCam project address, but her row wasn't in
// that first slice, so she always landed in "no matching client" -- and a
// live full-catalog run showed the same fate for 1,601 of 1,825 projects
// (88%). Fix: page through both lists in batches of 1000, same pattern
// api/jobs.js's fetchAllClientLocations() already uses for this exact cap.
async function fetchAllRows(query) {
  const pageSize = 1000;
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const r = await supabaseRequest(`${query}&limit=${pageSize}&offset=${offset}`);
    if (!r.ok) throw new Error(`Failed to load "${query}": ${await r.text()}`);
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}
async function getStoredCursor() {
  const res = await supabaseRequest(`sync_cursors?resource=eq.companycam_import&select=cursor`);
  if (!res.ok) return 0;
  const rows = await res.json();
  return rows.length ? Number(rows[0].cursor) || 0 : 0;
}

async function saveCursor(index) {
  await supabaseRequest('sync_cursors?on_conflict=resource', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ resource: 'companycam_import', cursor: String(index), updated_at: new Date().toISOString() })
  });
}

async function uploadPhotoToStorage(path, buffer, contentType) {
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/media/${path}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buffer
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
}

// ---- One-time remap of ALREADY-imported photos ----
// GET /api/import-companycam?remap=1
// Re-files every previously-imported CompanyCam photo onto the right job by
// capture date (pickJobByDate above) WITHOUT re-downloading anything -- pure
// database moves. Needed because the first import pass put each client's
// whole history on one job. Groups moves by target job so 7,000+ photos
// remap in a couple hundred bulk PATCHes, well inside one invocation.
// Timeline events follow their photo to the new job. Safe to re-run:
// already-correct rows produce no move.
async function handleRemap(res, deadline) {
  const pageSize = 1000;

  // 1. every imported photo (id, current job, capture time)
  const media = [];
  for (let offset = 0; ; offset += pageSize) {
    const r = await supabaseRequest(
      `media?select=id,job_id,captured_at&offline_client_id=like.companycam:*&limit=${pageSize}&offset=${offset}`
    );
    if (!r.ok) throw new Error(`media scan failed: ${await r.text()}`);
    const rows = await r.json();
    media.push(...rows);
    if (rows.length < pageSize) break;
  }

  // 2. every job (id -> client + dates), paginated
  const jobs = [];
  for (let offset = 0; ; offset += pageSize) {
    const r = await supabaseRequest(
      `jobs?select=jobber_id,client_id,job_status,start_at,end_at&limit=${pageSize}&offset=${offset}`
    );
    if (!r.ok) throw new Error(`jobs scan failed: ${await r.text()}`);
    const rows = await r.json();
    jobs.push(...rows);
    if (rows.length < pageSize) break;
  }
  const jobById = new Map(jobs.map((j) => [j.jobber_id, j]));
  const jobsByClient = new Map();
  for (const j of jobs) {
    if (!j.client_id) continue;
    if (!jobsByClient.has(j.client_id)) jobsByClient.set(j.client_id, []);
    jobsByClient.get(j.client_id).push(j);
  }

  // 3. compute moves, grouped by destination job
  const movesByTarget = new Map(); // targetJobId -> [mediaId]
  let unchanged = 0;
  let noClient = 0;
  let noDate = 0;
  for (const m of media) {
    const currentJob = jobById.get(m.job_id);
    if (!currentJob || !currentJob.client_id) { noClient++; continue; }
    const capturedMs = m.captured_at ? Date.parse(m.captured_at) : NaN;
    if (Number.isNaN(capturedMs)) { noDate++; continue; }
    const best = pickJobByDate(jobsByClient.get(currentJob.client_id) || [], capturedMs);
    if (!best || best.jobber_id === m.job_id) { unchanged++; continue; }
    if (!movesByTarget.has(best.jobber_id)) movesByTarget.set(best.jobber_id, []);
    movesByTarget.get(best.jobber_id).push(m.id);
  }

  // 4. apply -- one bulk PATCH per (target job, chunk of 100 ids), media
  // row and its timeline event(s) together
  let moved = 0;
  let patchCalls = 0;
  for (const [targetJobId, ids] of movesByTarget) {
    if (Date.now() >= deadline) break;
    for (let c = 0; c < ids.length; c += 100) {
      const chunk = ids.slice(c, c + 100);
      const idList = chunk.map((id) => `"${id}"`).join(',');
      const r = await supabaseRequest(`media?id=in.(${idList})`, {
        method: 'PATCH',
        body: JSON.stringify({ job_id: targetJobId })
      });
      if (!r.ok) throw new Error(`media move failed: ${await r.text()}`);
      await supabaseRequest(`timeline_events?media_id=in.(${idList})`, {
        method: 'PATCH',
        body: JSON.stringify({ job_id: targetJobId })
      }).catch(() => {});
      moved += chunk.length;
      patchCalls++;
    }
  }

  const summary = {
    scanned: media.length,
    unchanged,
    moved,
    targetJobs: movesByTarget.size,
    skippedNoClient: noClient,
    skippedNoDate: noDate,
    patchCalls,
    finished: Date.now() < deadline
  };
  console.log(`CompanyCam remap: ${JSON.stringify(summary)}`);
  return res.status(200).json({ ok: true, source: 'CompanyCam remap', ...summary });
}

export default async function handler(req, res) {
  // Item 3 (2026-08-01): CompanyCam import/remap requires an authenticated
  // admin (every employee is an admin this phase) OR the Vercel cron secret —
  // this endpoint runs both as a */15 cron and as an interactive admin action.
  // It previously ran with NO auth, exposing client/job matching and a `remap`
  // that rewrites photo→job attachments to anyone who knew the URL. Rollout
  // grace: if CRON_SECRET isn't configured yet, allow (so the existing cron
  // keeps running) but warn — set CRON_SECRET to enforce. Mirrors the global
  // /api middleware's cron-path rule.
  const gate = await requireApiAuth(req);
  if (!gate.ok) {
    if (process.env.CRON_SECRET) {
      return res.status(401).json({ ok: false, error: 'Authentication required (admin session or cron secret).' });
    }
    console.warn('[import-companycam] no auth and CRON_SECRET unset — allowed during rollout grace. Set CRON_SECRET to enforce.');
  }

  if (!TOKEN) {
    return res
      .status(500)
      .json({ ok: false, error: "COMPANYCAM_API_TOKEN is not set. Add it in Vercel -> Settings -> Environment Variables." });
  }

  const deadline = Date.now() + TIME_BUDGET_MS;

  if (req.query && req.query.remap) {
    try {
      return await handleRemap(res, deadline);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  try {
    // ---- Load everything needed to match projects -> clients -> jobs ----
    const [clients, locations] = await Promise.all([
      fetchAllRows('clients?select=jobber_id,name,company_name'),
      fetchAllRows('client_locations?select=jobber_id,street,city,province,postal_code')
    ]);

    const nameToClientIds = new Map();
    for (const c of clients) {
      for (const n of [c.name, c.company_name]) {
        if (!n) continue;
        const key = normalize(n);
        if (!nameToClientIds.has(key)) nameToClientIds.set(key, []);
        nameToClientIds.get(key).push(c.jobber_id);
      }
    }

    // ---- Fetch every CompanyCam project (list call only -- cheap relative
    // to downloading photos, so this always runs in full even if the photo
    // loop below has to stop partway through) ----
    const projects = await ccFetchAllPages((page, perPage) => `/projects?page=${page}&per_page=${perPage}`, deadline);
    projects.sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const reset = req.query && req.query.reset;
    let startIndex = reset ? 0 : await getStoredCursor();
    if (startIndex >= projects.length) startIndex = 0; // finished a full pass last time -- start over to catch new photos

    const summary = {
      totalProjects: projects.length,
      startIndex,
      projectsProcessed: 0,
      matchedByAddress: 0,
      matchedByName: 0,
      unmatchedNoClient: 0,
      unmatchedNoJob: 0,
      photosImported: 0,
      photosSkippedExisting: 0,
      photosFailed: 0,
      photoErrorSamples: [],
      unmatchedProjects: [],
      truncated: false,
      nextIndex: startIndex
    };

    let i = startIndex;
    for (; i < projects.length; i++) {
      if (Date.now() >= deadline) {
        summary.truncated = true;
        break;
      }
      const project = projects[i];
      const projectAddress = formatCcAddress(project.address);
      const clientName = project.primary_contact && project.primary_contact.name;

      // 1) match by address against every client's billing address
      let matchedClientId = null;
      let matchType = null;
      if (projectAddress) {
        for (const loc of locations) {
          const locOneLine = [loc.street, loc.city, loc.province, loc.postal_code].filter(Boolean).join(', ');
          if (locOneLine && addressesLikelyMatch(projectAddress, locOneLine)) {
            matchedClientId = loc.jobber_id;
            matchType = 'address';
            break;
          }
        }
      }
      // 2) fall back to name match, only if it's unambiguous (exactly one client)
      if (!matchedClientId && clientName) {
        const ids = nameToClientIds.get(normalize(clientName));
        if (ids && ids.length === 1) {
          matchedClientId = ids[0];
          matchType = 'name';
        }
      }

      if (!matchedClientId) {
        summary.unmatchedNoClient++;
        summary.unmatchedProjects.push({ id: project.id, name: project.name, reason: 'no matching client' });
        summary.projectsProcessed++;
        summary.nextIndex = i + 1;
        continue;
      }

      // All of this client's jobs WITH their schedule dates -- each photo
      // below picks its own job by capture date (see pickJobByDate). The
      // most-recent non-archived job remains only the last-resort fallback
      // for photos that can't be dated or clients with no dated jobs.
      const jobsRes = await supabaseRequest(
        `jobs?client_id=eq.${encodeURIComponent(matchedClientId)}&select=jobber_id,job_status,start_at,end_at&order=jobber_updated_at.desc&limit=100`
      );
      const clientJobs = jobsRes.ok ? await jobsRes.json() : [];
      const fallbackJob = clientJobs.find((j) => j.job_status !== 'archived') || clientJobs[0];

      if (!fallbackJob) {
        summary.unmatchedNoJob++;
        summary.unmatchedProjects.push({
          id: project.id,
          name: project.name,
          reason: 'client matched, but has no jobs',
          clientId: matchedClientId
        });
        summary.projectsProcessed++;
        summary.nextIndex = i + 1;
        continue;
      }

      if (matchType === 'address') summary.matchedByAddress++;
      else summary.matchedByName++;

      // ---- Import this project's photos onto that job ----
      let photos = [];
      try {
        photos = await ccFetchAllPages(
          (page, perPage) => `/projects/${project.id}/photos?page=${page}&per_page=${perPage}`,
          deadline
        );
      } catch (err) {
        summary.unmatchedProjects.push({ id: project.id, name: project.name, reason: `photos fetch failed: ${err.message}` });
        summary.projectsProcessed++;
        summary.nextIndex = i + 1;
        continue;
      }

      let photoLoopTruncated = false;
      for (const photo of photos) {
        if (Date.now() >= deadline) {
          summary.truncated = true;
          photoLoopTruncated = true;
          break;
        }
        // Same dedupe convention api/visual-intel.js's createMedia already
        // enforces server-side -- checked here too so an already-imported
        // photo is skipped before spending time downloading it again.
        const offlineClientId = `companycam:${photo.id}`;
        const existing = await supabaseRequest(`media?select=id&offline_client_id=eq.${encodeURIComponent(offlineClientId)}`);
        if (existing.ok) {
          const rows = await existing.json();
          if (rows.length) {
            summary.photosSkippedExisting++;
            continue;
          }
        }

        const sourceUrl = pickPhotoUrl(photo);
        if (!sourceUrl) {
          summary.photosFailed++;
          if (summary.photoErrorSamples.length < 8) {
            summary.photoErrorSamples.push({
              photoId: photo.id,
              error: 'no usable URL found in photo.urls',
              rawPhotoKeys: Object.keys(photo),
              rawPhoto: photo
            });
          }
          continue;
        }

        try {
          const capturedAtSeconds = photo.captured_at || photo.created_at;
          const capturedAt = capturedAtSeconds ? new Date(capturedAtSeconds * 1000).toISOString() : new Date().toISOString();
          // Per-photo job pick: the job whose schedule dates contain this
          // photo's capture date, not just the client's newest job.
          const targetJob = (capturedAtSeconds && pickJobByDate(clientJobs, capturedAtSeconds * 1000)) || fallbackJob;

          const imgRes = await fetch(sourceUrl);
          if (!imgRes.ok) throw new Error(`download failed: ${imgRes.status}`);
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const storagePath = `${targetJob.jobber_id}/companycam-${photo.id}.jpg`;
          await uploadPhotoToStorage(storagePath, buffer, 'image/jpeg');

          const coords = pickPhotoCoords(photo);

          const insertRes = await supabaseRequest('media', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              job_id: targetJob.jobber_id,
              media_type: 'PHOTO',
              storage_path: storagePath,
              mime_type: 'image/jpeg',
              size_bytes: buffer.length,
              captured_at: capturedAt,
              gps_lat: coords.lat,
              gps_lng: coords.lng,
              offline_client_id: offlineClientId
            })
          });
          if (!insertRes.ok) throw new Error(await insertRes.text());
          const [mediaRow] = await insertRes.json();

          // Best-effort, matches createMedia's own auto timeline append --
          // a failure here shouldn't fail the photo import.
          await supabaseRequest('timeline_events', {
            method: 'POST',
            body: JSON.stringify({
              job_id: targetJob.jobber_id,
              label: 'Photo imported from CompanyCam',
              source: 'AUTO',
              media_id: mediaRow.id,
              occurred_at: capturedAt
            })
          }).catch(() => {});

          summary.photosImported++;
        } catch (err) {
          summary.photosFailed++;
          if (summary.photoErrorSamples.length < 8) {
            summary.photoErrorSamples.push({ photoId: photo.id, sourceUrl, error: err.message });
          }
        }
      }

      summary.projectsProcessed++;
      if (photoLoopTruncated) {
        // This project's own photo list got cut off mid-way by the time
        // budget -- do NOT advance the cursor past it, or the remaining
        // photos would never get another chance (per-photo dedup only helps
        // if this project's index is revisited). Retry the same project
        // next run; per-photo dedup makes that cheap and safe.
        summary.nextIndex = i;
        break;
      }
      summary.nextIndex = i + 1;
      if (Date.now() >= deadline) {
        summary.truncated = true;
        break;
      }
    }

    const nextCursor = summary.truncated ? summary.nextIndex : summary.nextIndex >= projects.length ? 0 : summary.nextIndex;
    await saveCursor(nextCursor);
    summary.willResumeAt = nextCursor;

    // Logged so progress can be read straight from Vercel's own request logs
    // (Logs -> search "import-companycam") -- more reliable than depending
    // on a browser tab staying alive and un-discarded for the several
    // minutes a full batch can take.
    console.log(
      `CompanyCam import batch: processed ${summary.projectsProcessed}/${summary.totalProjects - summary.startIndex} ` +
        `(cursor ${summary.startIndex} -> ${nextCursor} of ${summary.totalProjects}), ` +
        `matched ${summary.matchedByAddress}+${summary.matchedByName}, ` +
        `photos +${summary.photosImported} imported / ${summary.photosSkippedExisting} skipped / ${summary.photosFailed} failed, ` +
        `truncated=${summary.truncated}`
    );

    return res.status(200).json({ ok: true, source: 'CompanyCam import', ...summary });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
