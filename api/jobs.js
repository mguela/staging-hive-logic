// api/jobs.js - Vercel serverless function
// Read-only pull of synced Jobber jobs from Supabase, reshaped for the frontend.
// No computed health band here (Law 1: never invent a score) -- Jobber's synced
// fields (job_status/dates) don't map to the owner/budget/materialsOnSite model
// tonight's job-health formula was built for. Real health scoring against Jobber
// data is separate, honest work for later, not faked here.
//
// 2026-07-30 root-cause rework (Gate 1): client names + geocoded locations are
// now joined onto jobs IN THE DATABASE by the public.jobs_enriched view
// (sql/039_jobs_enriched_view.sql), not in Node. The old code paginated the
// ENTIRE clients table (~9 requests) and ENTIRE client_locations table (~9
// more) on every call -- ~19 PostgREST round-trips per /api/jobs hit, even for
// a single-job ?id= lookup. Now: exactly 1. Response shapes are unchanged.
import { supabaseRequest } from './_lib/jobber.js';
import { jobRef } from './_lib/project-numbers.js';

const PAGE_SIZE = 50;

const LIST_SELECT = 'jobber_id,client_id,job_number,project_seq,division_code,title,job_status,job_type,total,start_at,end_at,completed_at,jobber_created_at,jobber_web_uri,client_name,gps_lat,gps_lng,loc_city,loc_province';

// Single-job fetch, used by the real job-detail view (Visual Intelligence's
// Photos/Timeline/Tags tabs live here). Returns null if not found (route
// handler below turns that into a 404). Shape unchanged from the pre-view
// version (no clientName/city/province here -- the detail view never had them).
export async function getJobByIdData(id) {
  const r = await supabaseRequest(
    `jobs_enriched?select=${LIST_SELECT}&jobber_id=eq.${encodeURIComponent(id)}`
  );
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  if (!rows.length) return null;
  const j = rows[0];
  return {
    id: j.jobber_id, title: j.title, clientId: j.client_id, jobNumber: j.job_number,
    projectSeq: j.project_seq ?? null,
    projectRef: j.project_seq ? jobRef(j.project_seq) : null,
    divisionCode: j.division_code || null,
    status: j.job_status, type: j.job_type, total: j.total, startAt: j.start_at,
    endAt: j.end_at, completedAt: j.completed_at, jobberUrl: j.jobber_web_uri,
    gpsLat: j.gps_lat, gpsLng: j.gps_lng
  };
}

// Extracted so api/chat.js can call this directly in-process instead of
// self-fetching this file's own /api/jobs route over HTTP.
//
// status filter (added 2026-07-21 for the Jobs board rewire): 'active' means
// "not archived" -- everything Jobber still considers open, including
// requires_invoicing (the board shows that as its own real column). Any
// other value is matched exactly against job_status. Omit for the original
// unfiltered behavior (used by Visual Intelligence's "show me everything").
export async function getJobsListData({ limit, offset, status } = {}) {
  const cappedLimit = Math.min(Number(limit) || PAGE_SIZE, 10000);
  // offset support so callers can page past PostgREST's 1000-row-per-request
  // cap (same pattern as api/clients.js) -- Visual Intelligence's Jobs list
  // needs every job, not just the first page, to match CompanyCam's
  // "show me everything" expectation.
  const safeOffset = Math.max(Number(offset) || 0, 0);
  let statusFilter = '';
  if (status === 'active') statusFilter = '&job_status=neq.archived';
  else if (status) statusFilter = `&job_status=eq.${encodeURIComponent(status)}`;
  const r = await supabaseRequest(
    `jobs_enriched?select=${LIST_SELECT}&order=jobber_updated_at.desc&limit=${cappedLimit}&offset=${safeOffset}${statusFilter}`,
    { headers: { Prefer: 'count=exact' } }
  );
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  const range = r.headers.get('content-range');
  const totalCount = range && range.includes('/') && range.split('/')[1] !== '*'
    ? Number(range.split('/')[1]) : rows.length;

  const jobs = rows.map(j => ({
    id: j.jobber_id,
    title: j.title,
    clientId: j.client_id,
    clientName: j.client_name || null,
    jobNumber: j.job_number,
    // HiveLogic-created jobs carry a project number (J-10001); Jobber-synced
    // ones have jobNumber instead. A job has one or the other, never both.
    projectSeq: j.project_seq ?? null,
    projectRef: j.project_seq ? jobRef(j.project_seq) : null,
    divisionCode: j.division_code || null,
    status: j.job_status,
    type: j.job_type,
    total: j.total,
    startAt: j.start_at,
    endAt: j.end_at,
    completedAt: j.completed_at,
    // Surfaced for the Active Jobs list, which sorts and shows when a job was raised.
    createdAt: j.jobber_created_at,
    jobberUrl: j.jobber_web_uri,
    gpsLat: j.gps_lat,
    gpsLng: j.gps_lng,
    city: j.loc_city,
    province: j.loc_province
  }));

  return { totalCount, returned: jobs.length, jobs };
}


// P0 auth gate (2026-07-29): this endpoint previously returned the full synced
// Jobber dataset (real client PII) to anonymous requests. A valid signed-in
// Supabase session is now required. Minimal token verification mirrored from
// api/track1.js's getRequestingProfile (mirrored, not imported -- same
// convention as fieldops.js / marketing.js / voice.js; no profile lookup here
// because this endpoint only needs "is this a real signed-in user", not a
// role). Response shape for signed-in callers is unchanged.
async function requireUser(req) {
  const headers = (req && req.headers) || {};
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  return user && user.id ? user : null;
}

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  try {
    // Single-job fetch: /api/jobs?id=<jobber_id>
    if (req.query.id) {
      const job = await getJobByIdData(req.query.id);
      if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
      return res.status(200).json({ ok: true, source: 'Jobber via Supabase', job });
    }

    const data = await getJobsListData({ limit: req.query.limit, offset: req.query.offset, status: req.query.status });
    res.status(200).json({ ok: true, source: 'Jobber via Supabase', ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
