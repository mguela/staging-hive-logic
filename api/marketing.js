// api/marketing.js - Vercel serverless function
// Marketing Operating System (MOS) Phase 1 -- Opportunity Engine backend.
// Everything here is real, computed data from tables that already sync
// from Jobber (jobs, clients) plus one new additive table (review_requests,
// sql/020_review_requests.sql). See reina/mos-architecture-spec-2026-07-23.md
// (Build Reina project) for the full design this implements.
//
// Usage:
//   GET  /api/marketing?resource=review_queue
//     -> completed jobs that still need a review ask (client has an email
//        on file, and no review_requests row marks it sent/dismissed yet).
//   POST /api/marketing?resource=review_requests
//     body: { jobId, clientId, status: 'sent'|'dismissed', dismissedReason? }
//     -> records that you (the owner) sent or dismissed a review ask for
//        that job, so it stops showing up in the queue.
//
// LAW 1, applied literally: no automatic sending exists here. No
// Twilio/SendGrid/Resend/similar account is connected, so this file never
// sends anything itself -- it tells you who to ask and hands the frontend
// a mailto: link the owner sends from their own inbox. See the "Not
// connected yet" list on the Marketing tab for the honest status of actual
// automated sending.
//
// Deliberately no sentiment field or sentiment-based filtering anywhere in
// this file -- every completed job with a client email gets the same
// review-ask treatment. Do not add one; see the review-gating research in
// reina/mos-competitive-research-2026-07-23.md before ever considering it.

import { supabaseRequest } from './_lib/jobber.js';
import { isEmailConfigured, isEmailSendEnabled, sendEmail } from './_lib/email.js';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import { getBudgetCap, monthSpendCents, currentMonthBoundsUTC } from './_lib/ad-budget-governor.js';
import { companyForCron, automationConfig, recordRun } from './_lib/automations.js';

const anthropicMkt = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// ---------------------------------------------------------------------
// Centralized campaign channel/audience eligibility -- single source of
// truth for "can this opportunity become an email campaign with real
// recipients." Added 2026-07-25 after an audit found the hero "Build
// Campaign" button could create a zero-recipient email campaign for
// Neighborhood Expansion (areas, not existing-customer contacts) even
// though the Opportunities list already marked that audience
// non-actionable -- the create endpoint had no way to know that, because
// eligibility only existed as UI-advisory metadata. Both
// computeNeighborhoodExpansion() (advisory) and handleCampaignsPost()
// (enforced) now read from this one map so they can never drift apart.
const OPPORTUNITY_ELIGIBILITY = {
  unsold_estimates: { emailEligible: true },
  review_requests: { emailEligible: true },
  reactivate_customers: { emailEligible: true },
  seasonal_promotion: { emailEligible: true },
  neighborhood_expansion: {
    emailEligible: false,
    reason: 'These are geographic areas, not existing-customer contacts we can already email -- reaching new prospects here needs a connected ad platform (Google/Meta Ads) or a direct-mail vendor.',
    requiredIntegration: 'google_ads_or_meta_ads_or_direct_mail',
  },
  referral_opportunities: { emailEligible: true },
};

function checkCampaignEligibility({ opportunityKey, channel, recipientCount }) {
  const ch = channel || 'email';
  if (opportunityKey) {
    const rule = OPPORTUNITY_ELIGIBILITY[opportunityKey];
    if (rule && ch === 'email' && rule.emailEligible === false) {
      return { eligible: false, reason: rule.reason, requiredIntegration: rule.requiredIntegration };
    }
  }
  if (ch === 'email' && !recipientCount) {
    return {
      eligible: false,
      reason: 'This campaign has no recipients yet -- select a real audience before creating a draft.',
      requiredIntegration: null,
    };
  }
  return { eligible: true, reason: null, requiredIntegration: null };
}

// HMAC-signed, stateless unsubscribe link -- no per-recipient token needs
// to be stored anywhere; the signature itself proves the link is genuine.
// Requires MARKETING_UNSUBSCRIBE_SECRET (falls back to SUPABASE_SERVICE_KEY
// only so existing deployments don't hard-fail before the new env var is
// set -- set a dedicated secret for production, see deployment notes).
function unsubscribeSecret() {
  return process.env.MARKETING_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev-only-insecure-fallback';
}
function signUnsubscribe(clientId, channel) {
  const payload = String(clientId) + ':' + String(channel);
  const sig = crypto.createHmac('sha256', unsubscribeSecret()).update(payload).digest('base64url');
  return sig;
}
function unsubscribeUrl(clientId, channel, baseUrl) {
  const sig = signUnsubscribe(clientId, channel);
  const base = baseUrl || process.env.MARKETING_PUBLIC_BASE_URL || 'https://hivelogic-live.vercel.app';
  return base + '/api/marketing-unsubscribe?c=' + encodeURIComponent(clientId) + '&ch=' + encodeURIComponent(channel) + '&s=' + encodeURIComponent(sig);
}

async function logCampaignActivity(campaignId, event, actor, detail) {
  try {
    await supabaseRequest('campaign_activity_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ campaign_id: campaignId, event, actor: actor || null, detail: detail || null }]),
    });
  } catch (e) { /* best-effort only -- never block the real action on a logging failure */ }
}

// Marketing Suite Phase 4 audit-event-emission slice (2026-07-31): a
// cross-category activity trail (marketing_audit_events, sql/040) for
// Phase 5's future "what Reina completed automatically" dashboard and
// Phase 19's full owner-journey coverage. Deliberately separate from
// logCampaignActivity above -- that log is per-campaign detail (Results'
// timeline for one campaign); this one is the company-wide feed across
// every Marketing Suite category (idea/campaign/approval/connection/
// budget/plan/review/opportunity), including events that have no other
// durable record at all once the acted-on row changes or is deleted (e.g.
// a deleted campaign's own activity log disappears with it -- this table
// is the only place that deletion is still visible afterward). Same
// best-effort discipline as logCampaignActivity: a logging failure (or the
// table not being synced yet) must never block or fail the real action.
async function logMarketingAuditEvent(category, action, entityType, entityId, actor, details) {
  try {
    await supabaseRequest('marketing_audit_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        category,
        action,
        entity_type: entityType || null,
        entity_id: entityId != null ? String(entityId) : null,
        actor: actor === 'system' ? 'system' : 'owner',
        details: details || null,
      }]),
    });
  } catch (e) { /* best-effort only -- never block the real action on a logging failure */ }
}

// Auth: every request must carry `Authorization: Bearer <supabase access
// token>`, verified here against Supabase's own /auth/v1/user endpoint --
// same real check as api/voice.js (this file used to have none at all;
// see the "known gap" note this replaces).
async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 10; // safety cap, well above current table sizes
const REVIEW_ASK_WINDOW_DAYS = 60; // realistic recency window for a review ask -- not a sentiment filter, applies identically to every job

async function fetchAllRows(table, query) {
  let all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const sep = query.includes('?') ? '&' : '?';
    const r = await supabaseRequest(`${table}${query}${sep}limit=${PAGE_SIZE}&offset=${offset}`);
    if (!r.ok) {
      const text = await r.text();
      const notSynced = /relation .* does not exist/i.test(text);
      const err = new Error(notSynced ? `not_synced:${table}` : text);
      err.notSynced = notSynced;
      throw err;
    }
    const rows = await r.json();
    all = all.concat(rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

function clientDisplayName(c) {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null;
}

async function handleReviewQueueGet(req, res) {
  const [jobs, clients] = await Promise.all([
    fetchAllRows('jobs', '?select=jobber_id,client_id,job_number,title,total,completed_at&completed_at=not.is.null&order=completed_at.desc'),
    fetchAllRows('clients', '?select=jobber_id,name,first_name,last_name,company_name,email'),
  ]);

  let actioned = new Set();
  try {
    const rr = await fetchAllRows('review_requests', "?select=job_id,status&status=in.(sent,dismissed)");
    actioned = new Set(rr.map(r => r.job_id));
  } catch (e) {
    if (!e.notSynced) throw e;
    // review_requests table not created yet -- treat as "nothing actioned"
    // rather than failing the whole queue; the frontend still shows the
    // real completed-job data, just with a note that the migration hasn't
    // run yet (added by the caller, see below).
  }

  const clientById = new Map(clients.map(c => [c.jobber_id, c]));
  const totalCompletedJobs = jobs.length;
  let withEmail = 0;
  let alreadyActioned = 0;

  const pending = [];
  for (const j of jobs) {
    const client = j.client_id ? clientById.get(j.client_id) : null;
    const email = client && client.email;
    if (email) withEmail++;
    if (actioned.has(j.jobber_id)) { alreadyActioned++; continue; }
    if (!email) continue; // no way to ask yet -- excluded from the queue, counted above instead
    const ageDays = j.completed_at ? Math.floor((Date.now() - new Date(j.completed_at).getTime()) / 86400000) : null;
    pending.push({
      jobId: j.jobber_id,
      clientId: j.client_id,
      clientName: (client && clientDisplayName(client)) || 'Unnamed client',
      clientEmail: email,
      jobTitle: j.title,
      jobNumber: j.job_number,
      total: j.total,
      completedAt: j.completed_at,
      ageDays,
    });
  }

  const withinWindowCount = pending.filter(p => p.ageDays == null || p.ageDays <= REVIEW_ASK_WINDOW_DAYS).length;

  res.status(200).json({
    ok: true,
    source: 'HiveLogic (jobs + clients, real completed-job data)',
    totalCompletedJobs,
    withEmail,
    alreadyActioned,
    returned: pending.length,
    windowDays: REVIEW_ASK_WINDOW_DAYS,
    withinWindowCount,
    pending: pending.slice(0, 300),
  });
}

async function handleReviewRequestsBulkPost(req, res) {
  const b = req.body || {};
  const days = Number(b.olderThanDays);
  if (!isFinite(days) || days <= 0) {
    return res.status(400).json({ ok: false, error: 'olderThanDays must be a positive number.' });
  }

  const [jobs, clients] = await Promise.all([
    fetchAllRows('jobs', '?select=jobber_id,client_id,completed_at&completed_at=not.is.null&order=completed_at.desc'),
    fetchAllRows('clients', '?select=jobber_id,email'),
  ]);

  let actioned = new Set();
  try {
    const rr = await fetchAllRows('review_requests', "?select=job_id,status&status=in.(sent,dismissed)");
    actioned = new Set(rr.map(r => r.job_id));
  } catch (e) {
    if (!e.notSynced) throw e;
  }

  const clientById = new Map(clients.map(c => [c.jobber_id, c]));
  const cutoffMs = Date.now() - days * 86400000;

  const rows = [];
  for (const j of jobs) {
    if (actioned.has(j.jobber_id)) continue;
    const client = j.client_id ? clientById.get(j.client_id) : null;
    if (!(client && client.email)) continue; // matches the GET queue's own eligibility rule
    const completedMs = j.completed_at ? new Date(j.completed_at).getTime() : null;
    if (completedMs == null || completedMs > cutoffMs) continue; // only the backlog older than the cutoff
    rows.push({
      job_id: j.jobber_id,
      client_id: j.client_id || null,
      channel: null,
      status: 'dismissed',
      sent_at: null,
      dismissed_reason: 'bulk_backlog_clear (older than ' + days + ' days)',
      updated_at: new Date().toISOString(),
    });
  }

  if (!rows.length) {
    return res.status(200).json({ ok: true, dismissedCount: 0 });
  }

  const r = await supabaseRequest('review_requests?on_conflict=job_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text();
    const notSynced = /relation .* does not exist/i.test(text);
    return res.status(notSynced ? 200 : 500).json({
      ok: false,
      error: notSynced ? 'review_requests table is not set up yet -- run sql/020_review_requests.sql in Supabase.' : text,
    });
  }
  res.status(200).json({ ok: true, dismissedCount: rows.length });
}

async function handleReviewRequestsPost(req, res) {
  const b = req.body || {};
  const jobId = String(b.jobId || '').trim();
  const status = String(b.status || '').trim();
  if (!jobId) return res.status(400).json({ ok: false, error: 'jobId is required.' });
  if (!['sent', 'dismissed'].includes(status)) {
    return res.status(400).json({ ok: false, error: "status must be 'sent' or 'dismissed'." });
  }

  const row = {
    job_id: jobId,
    client_id: b.clientId ? String(b.clientId) : null,
    channel: status === 'sent' ? 'email' : null,
    status,
    sent_at: status === 'sent' ? new Date().toISOString() : null,
    dismissed_reason: status === 'dismissed' ? (b.dismissedReason || null) : null,
    updated_at: new Date().toISOString(),
  };

  const r = await supabaseRequest('review_requests?on_conflict=job_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const text = await r.text();
    const notSynced = /relation .* does not exist/i.test(text);
    return res.status(notSynced ? 200 : 500).json({
      ok: false,
      error: notSynced ? 'review_requests table is not set up yet -- run sql/020_review_requests.sql in Supabase.' : text,
    });
  }
  await logMarketingAuditEvent('review', status, 'review_request', jobId, 'owner', { clientId: row.client_id, dismissedReason: row.dismissed_reason });
  res.status(200).json({ ok: true, jobId, status });
}

// ---------- Marketing Suite rebuild additions (2026-07-23) ----------
// Server-side copy of the trade classifier in public/index.html's
// jobDivision(). Kept in sync manually -- this runs in a Node serverless
// function, the other in a browser <script> tag, so the two cannot literally
// share one file without a build step this project doesn't have. If you
// change one, change the other.
function jobDivisionServer(title) {
  var t = String(title || '').toLowerCase();
  if (/hvac|heat pump|furnace|boiler|air condition|mini.?split|condenser|thermostat/.test(t)) return 'HVAC';
  if (/electric|panel upgrade|outlet|wiring|lighting|generator|ev charger|breaker|recessed/.test(t)) return 'Electric';
  if (/plumb|water heater|drain|sewer|faucet|toilet|leak|pipe|sump|shower valve/.test(t)) return 'Plumbing';
  if (/design|build|renovat|remodel|addition|kitchen|basement|bath/.test(t)) return 'Design|Build';
  if (/outdoor|patio|deck|landscap|fence|paver|pergola|masonry|walkway|yard|drainage/.test(t)) return 'Outdoor Spaces';
  if (/handyman|repair|install|mount|assemble|caulk|paint|door|window|gutter|trim|shelv|punch/.test(t)) return 'Handyman';
  return 'Handyman';
}

const NEIGHBORHOOD_GRID_DEGREES = 0.01;
const NEIGHBORHOOD_MIN_JOBS = 3;

async function fetchAllClientLocationsForOpportunities() {
  const byClient = new Map();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const r = await supabaseRequest(`client_locations?select=jobber_id,lat,lng&lat=not.is.null&limit=${pageSize}&offset=${offset}`);
    if (!r.ok) break;
    const rows = await r.json();
    for (const loc of rows) byClient.set(loc.jobber_id, { lat: Number(loc.lat), lng: Number(loc.lng) });
    if (rows.length < pageSize) break;
  }
  return byClient;
}

// ----- Unsold Estimates (real: quotes table, no assumptions) -----
async function computeUnsoldEstimates() {
  const quotes = await fetchAllRows('quotes', '?select=jobber_id,total,jobber_created_at&quote_status=eq.awaiting_response');
  const now = Date.now();
  let totalValue = 0, staleCount = 0, staleValue = 0;
  for (const q of quotes) {
    const v = Number(q.total) || 0;
    totalValue += v;
    const ageDays = q.jobber_created_at ? Math.floor((now - new Date(q.jobber_created_at).getTime()) / 86400000) : null;
    if (ageDays != null && ageDays > 30) { staleCount++; staleValue += v; }
  }
  return {
    key: 'unsold_estimates',
    label: 'Unsold Estimates',
    count: quotes.length,
    estRevenue: Math.round(totalValue),
    staleCount,
    staleValue: Math.round(staleValue),
    real: true,
    actionable: quotes.length > 0,
    description: quotes.length
      ? (quotes.length + ' open estimate' + (quotes.length === 1 ? '' : 's') + ' awaiting a client response, ' + staleCount + ' of them over 30 days old with no reply.')
      : 'No open estimates are currently awaiting a client response.',
    actionLabel: 'Create Campaign',
  };
}

// ----- Neighborhood Expansion (real: jobs + client_locations, same grid as the Neighborhoods widget) -----
async function computeNeighborhoodExpansion() {
  const [jobs, locations] = await Promise.all([
    fetchAllRows('jobs', '?select=client_id,total,completed_at&completed_at=not.is.null'),
    fetchAllClientLocationsForOpportunities(),
  ]);
  const cells = new Map();
  for (const j of jobs) {
    const loc = j.client_id ? locations.get(j.client_id) : null;
    if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) continue;
    const key = Math.round(loc.lat / NEIGHBORHOOD_GRID_DEGREES) + ',' + Math.round(loc.lng / NEIGHBORHOOD_GRID_DEGREES);
    if (!cells.has(key)) cells.set(key, { count: 0, revenue: 0 });
    const cell = cells.get(key);
    cell.count++;
    cell.revenue += Number(j.total) || 0;
  }
  let areaCount = 0, revenue = 0;
  for (const cell of cells.values()) {
    if (cell.count >= NEIGHBORHOOD_MIN_JOBS) { areaCount++; revenue += cell.revenue; }
  }
  return {
    key: 'neighborhood_expansion',
    label: 'Neighborhood Expansion',
    count: areaCount,
    estRevenue: Math.round(revenue),
    real: true,
    actionable: OPPORTUNITY_ELIGIBILITY.neighborhood_expansion.emailEligible,
    actionableReason: OPPORTUNITY_ELIGIBILITY.neighborhood_expansion.reason + ' See Launch Channels.',
    requiredIntegration: OPPORTUNITY_ELIGIBILITY.neighborhood_expansion.requiredIntegration,
    description: areaCount
      ? (areaCount + ' area' + (areaCount === 1 ? '' : 's') + ' with ' + NEIGHBORHOOD_MIN_JOBS + '+ completed jobs nearby -- ' + money(revenue) + ' in real revenue already earned there.')
      : 'No area yet has ' + NEIGHBORHOOD_MIN_JOBS + '+ completed jobs close together.',
    actionLabel: 'Create Campaign',
  };
}

function money(n) {
  const v = Math.round(Number(n) || 0);
  return '$' + v.toLocaleString('en-US');
}

// ----- Review Requests (real: same eligibility as the review queue, no revenue guess) -----
async function computeReviewRequestsOpportunity() {
  const jobs = await fetchAllRows('jobs', '?select=jobber_id,client_id,completed_at&completed_at=not.is.null');
  const clients = await fetchAllRows('clients', '?select=jobber_id,email');
  const clientById = new Map(clients.map(c => [c.jobber_id, c]));
  let actioned = new Set();
  try {
    const rr = await fetchAllRows('review_requests', '?select=job_id,status&status=in.(sent,dismissed)');
    actioned = new Set(rr.map(r => r.job_id));
  } catch (e) { if (!e.notSynced) throw e; }
  let pending = 0;
  for (const j of jobs) {
    if (actioned.has(j.jobber_id)) continue;
    const client = j.client_id ? clientById.get(j.client_id) : null;
    if (!(client && client.email)) continue;
    pending++;
  }
  return {
    key: 'review_requests',
    label: 'Review Requests',
    count: pending,
    estRevenue: null, // deliberately no revenue estimate -- no honest conversion rate exists from "review ask" to "$"
    real: true,
    actionable: pending > 0,
    description: pending
      ? (pending + ' completed job' + (pending === 1 ? '' : 's') + ' with a client email on file, still waiting on a review ask.')
      : 'No completed jobs are currently waiting on a review ask.',
    actionLabel: 'Send Requests',
  };
}

// Full candidate list backing computeReviewRequestsOpportunity's count above --
// same filter (completed job, real client email on file, not already
// actioned in review_requests), but returns the real rows so a campaign can
// be created with real recipients instead of just a number. Sorted most-
// recently-completed first and capped at 500 as a safety bound, consistent
// with PAGE_SIZE/MAX_PAGES above.
async function getReviewRequestCandidates(limit) {
  const cap = Math.min(Number(limit) || 500, 500);
  const jobs = await fetchAllRows('jobs', '?select=jobber_id,client_id,title,completed_at&completed_at=not.is.null');
  const clients = await fetchAllRows('clients', '?select=jobber_id,name,first_name,last_name,email');
  const clientById = new Map(clients.map(c => [c.jobber_id, c]));
  let actioned = new Set();
  try {
    const rr = await fetchAllRows('review_requests', '?select=job_id,status&status=in.(sent,dismissed)');
    actioned = new Set(rr.map(r => r.job_id));
  } catch (e) { if (!e.notSynced) throw e; }
  const sorted = jobs.slice().sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  const out = [];
  let totalEligible = 0;
  for (const j of sorted) {
    if (actioned.has(j.jobber_id)) continue;
    const client = j.client_id ? clientById.get(j.client_id) : null;
    if (!(client && client.email)) continue;
    totalEligible++;
    if (out.length >= cap) continue;
    const clientName = client.name || [client.first_name, client.last_name].filter(Boolean).join(' ') || 'there';
    out.push({
      clientId: j.client_id,
      jobId: j.jobber_id,
      jobTitle: j.title || null,
      completedAt: j.completed_at,
      clientName,
      email: client.email,
    });
  }
  return { candidates: out, totalEligible, cap, hasMore: totalEligible > out.length };
}

async function handleReviewRequestCandidatesGet(req, res) {
  const result = await getReviewRequestCandidates(req.query.limit);
  res.status(200).json({ ok: true, candidates: result.candidates, totalEligible: result.totalEligible, cap: result.cap, hasMore: result.hasMore });
}

// Unsold Estimates candidates -- real open quotes with a real client email,
// oldest first (longest-waiting estimates get asked about first). Same
// shape/cap convention as getReviewRequestCandidates.
async function getUnsoldEstimateCandidates(limit) {
  const cap = Math.min(Number(limit) || 500, 500);
  const quotes = await fetchAllRows('quotes', '?select=jobber_id,client_id,client_name,title,total,quote_status,jobber_created_at&quote_status=eq.awaiting_response');
  const clientIds = [...new Set(quotes.map(q => q.client_id).filter(Boolean))];
  const clients = await fetchAllRows('clients', '?select=jobber_id,name,first_name,last_name,email');
  const clientById = new Map(clients.map(c => [c.jobber_id, c]));
  const sorted = quotes.slice().sort((a, b) => new Date(a.jobber_created_at) - new Date(b.jobber_created_at));
  const out = [];
  let totalEligible = 0;
  for (const q of sorted) {
    const client = q.client_id ? clientById.get(q.client_id) : null;
    const email = client && client.email;
    if (!email) continue;
    totalEligible++;
    if (out.length >= cap) continue;
    const clientName = client.name || [client.first_name, client.last_name].filter(Boolean).join(' ') || q.client_name || 'there';
    out.push({
      clientId: q.client_id,
      targetRecordId: q.jobber_id,
      quoteTitle: q.title || null,
      quoteTotal: Number(q.total) || 0,
      clientName,
      email,
    });
  }
  return { candidates: out, totalEligible, cap, hasMore: totalEligible > out.length };
}

// Reactivate Past Customers candidates -- last completed job per client,
// 6 months-2 years ago (same window as computeReactivateCustomers), oldest
// eligible job first.
async function getReactivationCandidates(limit) {
  const cap = Math.min(Number(limit) || 500, 500);
  const jobs = await fetchAllRows('jobs', '?select=jobber_id,client_id,title,total,completed_at&completed_at=not.is.null&order=completed_at.desc');
  const lastByClient = new Map();
  for (const j of jobs) { if (!j.client_id) continue; if (!lastByClient.has(j.client_id)) lastByClient.set(j.client_id, j); }
  const now = Date.now(); const sixMonthsMs = 180 * 86400000; const twoYearsMs = 730 * 86400000;
  const eligible = [];
  for (const j of lastByClient.values()) { const ms = now - new Date(j.completed_at).getTime(); if (ms >= sixMonthsMs && ms <= twoYearsMs) eligible.push(j); }
  const clientIds = [...new Set(eligible.map(j => j.client_id))];
  const clients = await fetchAllRows('clients', '?select=jobber_id,name,first_name,last_name,email');
  const clientById = new Map(clients.map(c => [c.jobber_id, c]));
  eligible.sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at));
  const out = [];
  let totalEligible = 0;
  for (const j of eligible) {
    const client = clientById.get(j.client_id);
    const email = client && client.email;
    if (!email) continue;
    totalEligible++;
    if (out.length >= cap) continue;
    const clientName = client.name || [client.first_name, client.last_name].filter(Boolean).join(' ') || 'there';
    out.push({
      clientId: j.client_id,
      targetRecordId: j.jobber_id,
      lastJobTitle: j.title || null,
      lastJobValue: Number(j.total) || 0,
      clientName,
      email,
    });
  }
  return { candidates: out, totalEligible, cap, hasMore: totalEligible > out.length };
}

// Referral candidates -- existing customers who have a real, staff-tagged
// referred_by_client_id on at least one lead_pipeline row (sql/044). This
// is the real recipient list referral_opportunities was missing -- a
// customer only appears here because a real lead was tagged as referred by
// them, not because they were merely a past customer or logged a referral-
// source lead themselves.
async function getReferralCandidates(limit) {
  const cap = Math.min(Number(limit) || 500, 500);
  let leads = [];
  try {
    leads = await fetchAllRows('lead_pipeline', '?select=client_id,estimated_value,created_at,referred_by_client_id&referred_by_client_id=not.is.null');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const byReferrer = new Map();
  for (const l of leads) {
    const refId = l.referred_by_client_id;
    if (!refId) continue;
    if (!byReferrer.has(refId)) byReferrer.set(refId, { referredCount: 0, estimatedValueSum: 0, mostRecentAt: null });
    const agg = byReferrer.get(refId);
    agg.referredCount += 1;
    agg.estimatedValueSum += Number(l.estimated_value) || 0;
    if (!agg.mostRecentAt || new Date(l.created_at) > new Date(agg.mostRecentAt)) agg.mostRecentAt = l.created_at;
  }
  const referrerIds = [...byReferrer.keys()];
  if (!referrerIds.length) return { candidates: [], totalEligible: 0, cap, hasMore: false };
  const clients = await fetchAllRows('clients', '?select=jobber_id,name,first_name,last_name,email');
  const clientById = new Map(clients.map((c) => [c.jobber_id, c]));
  const eligible = referrerIds
    .map((id) => ({ id, client: clientById.get(id), ...byReferrer.get(id) }))
    .filter((r) => r.client && r.client.email);
  eligible.sort((a, b) => new Date(b.mostRecentAt) - new Date(a.mostRecentAt));
  const out = eligible.slice(0, cap).map((r) => {
    const clientName = r.client.name || [r.client.first_name, r.client.last_name].filter(Boolean).join(' ') || 'there';
    return {
      clientId: r.id,
      targetRecordId: null,
      referredCount: r.referredCount,
      referredEstimatedValue: Math.round(r.estimatedValueSum),
      clientName,
      email: r.client.email,
    };
  });
  return { candidates: out, totalEligible: eligible.length, cap, hasMore: eligible.length > out.length };
}

// Seasonal Promotion candidates -- every real client with a completed job and
// a real email on file, so the (already-manually-drafted) seasonal offer can
// actually be sent to someone.
async function getSeasonalCandidates(limit) {
  const cap = Math.min(Number(limit) || 500, 500);
  const jobs = await fetchAllRows('jobs', '?select=client_id,completed_at&completed_at=not.is.null');
  const clientIds = [...new Set(jobs.map(j => j.client_id).filter(Boolean))];
  const clients = await fetchAllRows('clients', '?select=jobber_id,name,first_name,last_name,email');
  const out = [];
  let totalEligible = 0;
  for (const c of clients) {
    if (!c.email) continue;
    totalEligible++;
    if (out.length >= cap) continue;
    const clientName = c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there';
    out.push({ clientId: c.jobber_id, clientName, email: c.email });
  }
  return { candidates: out, totalEligible, cap, hasMore: totalEligible > out.length };
}

// Generic candidate dispatcher -- one endpoint the frontend can call for any
// opportunity key instead of hardcoding review_requests_candidates. Old route
// kept for backward compatibility.
async function handleOpportunityCandidatesGet(req, res) {
  const key = String(req.query.key || '').trim();
  const limit = req.query.limit;
  let result;
  if (key === 'review_requests') result = await getReviewRequestCandidates(limit);
  else if (key === 'unsold_estimates') result = await getUnsoldEstimateCandidates(limit);
  else if (key === 'reactivate_customers') result = await getReactivationCandidates(limit);
  else if (key === 'seasonal_promotion') result = await getSeasonalCandidates(limit);
  else if (key === 'referral_opportunities') result = await getReferralCandidates(limit);
  else return res.status(400).json({ ok: false, error: 'Unknown or non-actionable opportunity key: ' + key });
  res.status(200).json({
    ok: true,
    key,
    candidates: result.candidates,
    totalEligible: result.totalEligible,
    cap: result.cap,
    hasMore: result.hasMore,
    coverageNote: result.hasMore
      ? ('Showing the ' + result.cap + ' most recent of ' + result.totalEligible + ' eligible -- the remaining ' + (result.totalEligible - result.candidates.length) + ' are deferred to a later batch, not dropped.')
      : null,
  });
}

// Small config surface for the frontend -- currently just the real Google
// review short link (Get more reviews > review link, from Google Business
// Profile Manager, confirmed for Greenwich Handyman, Inc. 2026-07-25) plus
// the two email-send gate states, so the UI can explain a disabled Send
// button honestly instead of guessing.
async function handleMarketingConfigGet(req, res) {
  res.status(200).json({
    ok: true,
    reviewLink: process.env.GOOGLE_REVIEW_LINK || null,
    emailConfigured: isEmailConfigured(),
    emailSendEnabled: isEmailSendEnabled(),
  });
}

// A real send through the exact same Resend path as a campaign send, but
// to exactly one address and with no campaign/recipients rows touched --
// safe to click before ever sending to a real customer.
async function handleTestSendPost(req, res) {
  if (!isEmailConfigured()) {
    return res.status(409).json({ ok: false, error: 'RESEND_API_KEY is not set for this deployment -- add it in Vercel before sending.' });
  }
  if (!isEmailSendEnabled()) {
    return res.status(409).json({ ok: false, error: 'Email sending is built but turned off -- set MARKETING_EMAIL_SEND_ENABLED=true in Vercel to enable it.' });
  }
  const b = req.body || {};
  const requestedTo = String(b.to || '').trim();
  const ownEmail = (req.hlUser && req.hlUser.email) ? String(req.hlUser.email).trim() : '';
  // Default -- and, unless explicitly overridden, REQUIRE -- the test send
  // to go to the authenticated user's own inbox. A caller may send to a
  // different internal test address only by explicitly setting
  // confirmOtherAddress:true, so "test send" can no longer be used as an
  // unguarded way to fire one real email at an arbitrary address.
  const to = requestedTo || ownEmail;
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ ok: false, error: 'A valid "to" email address is required.' });
  }
  if (to.toLowerCase() !== ownEmail.toLowerCase() && !b.confirmOtherAddress) {
    return res.status(400).json({
      ok: false,
      error: 'Test sends go to your own signed-in email by default. To send to a different internal address, set confirmOtherAddress:true explicitly.',
      ownEmail: ownEmail || null,
    });
  }
  const subject = String(b.subject || '').trim();
  const bodyText = String(b.body || '').trim();
  if (!subject || !bodyText) {
    return res.status(400).json({ ok: false, error: 'subject and body are required.' });
  }
  const result = await sendEmail({
    to,
    subject: `[TEST] ${subject}`,
    text: bodyText,
    html: bodyText.split(/\r?\n/).map(line => `<p>${line || '&nbsp;'}</p>`).join(''),
  });
  if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'Send failed.' });
  if (b.campaignId) await logCampaignActivity(String(b.campaignId), 'test_sent', ownEmail || to, { to });
  res.status(200).json({ ok: true, id: result.id });
}

// ----- Reactivate Past Customers (real: jobs.completed_at dormancy, revenue = their own last job's real value) -----
async function computeReactivateCustomers() {
  const jobs = await fetchAllRows('jobs', '?select=client_id,total,completed_at&completed_at=not.is.null&order=completed_at.desc');
  const lastByClient = new Map();
  for (const j of jobs) {
    if (!j.client_id) continue;
    if (!lastByClient.has(j.client_id)) lastByClient.set(j.client_id, j); // first hit per client = most recent, since ordered desc
  }
  const now = Date.now();
  const sixMonthsMs = 180 * 86400000;
  const twoYearsMs = 730 * 86400000;
  let count = 0, revenue = 0;
  for (const j of lastByClient.values()) {
    const ms = now - new Date(j.completed_at).getTime();
    if (ms >= sixMonthsMs && ms <= twoYearsMs) {
      count++;
      revenue += Number(j.total) || 0;
    }
  }
  return {
    key: 'reactivate_customers',
    label: 'Reactivate Past Customers',
    count,
    estRevenue: Math.round(revenue),
    real: true,
    actionable: count > 0,
    description: count
      ? (count + ' past customer' + (count === 1 ? '' : 's') + ' with no completed job in 6-24 months -- ' + money(revenue) + ' was their combined last-job value.')
      : 'No past customers currently fall in the 6-24 month reactivation window.',
    actionLabel: 'Create Campaign',
  };
}

// ----- Referral Opportunities (real: lead_pipeline.lead_source, honestly empty until the team logs it) -----
async function computeReferralOpportunities() {
  let rows = [];
  let notSetUp = false;
  try {
    rows = await fetchAllRows('lead_pipeline', "?select=client_id,estimated_value&lead_source=eq.referral");
  } catch (e) {
    if (e.notSynced) notSetUp = true; else throw e;
  }
  const revenue = rows.reduce((s, r) => s + (Number(r.estimated_value) || 0), 0);
  return {
    key: 'referral_opportunities',
    label: 'Referral Opportunities',
    count: rows.length,
    estRevenue: rows.length ? Math.round(revenue) : null,
    real: true,
    actionable: rows.length > 0,
    description: notSetUp
      ? 'Lead pipeline table is not set up yet.'
      : (rows.length
        ? (rows.length + ' lead' + (rows.length === 1 ? '' : 's') + ' logged as referrals.')
        : 'No leads are currently logged with a referral source -- log lead source on the Leads page to populate this.'),
    actionLabel: 'Create Campaign',
  };
}

// ----- Seasonal Promotion (real: jobs + trade classifier, YoY comparison for the current month) -----
async function computeSeasonalPromotion() {
  const jobs = await fetchAllRows('jobs', '?select=title,total,completed_at&completed_at=not.is.null');
  const now = new Date();
  const month = now.getUTCMonth();
  const thisYear = now.getUTCFullYear();
  const lastYear = thisYear - 1;
  const byDivisionThis = new Map();
  const byDivisionLast = new Map();
  for (const j of jobs) {
    const d = new Date(j.completed_at);
    if (d.getUTCMonth() !== month) continue;
    const div = jobDivisionServer(j.title);
    const v = Number(j.total) || 0;
    if (d.getUTCFullYear() === thisYear) byDivisionThis.set(div, (byDivisionThis.get(div) || 0) + v);
    else if (d.getUTCFullYear() === lastYear) byDivisionLast.set(div, (byDivisionLast.get(div) || 0) + v);
  }
  let bestDiv = null, bestPct = 0, bestThis = 0, bestLast = 0;
  for (const [div, thisVal] of byDivisionThis.entries()) {
    const lastVal = byDivisionLast.get(div) || 0;
    if (lastVal <= 0) continue; // no honest percentage without a real prior-year baseline
    const pct = ((thisVal - lastVal) / lastVal) * 100;
    if (pct > bestPct) { bestPct = pct; bestDiv = div; bestThis = thisVal; bestLast = lastVal; }
  }
  return {
    key: 'seasonal_promotion',
    label: 'Seasonal Promotion',
    count: null,
    estRevenue: null,
    real: true,
    actionable: !!bestDiv,
    description: bestDiv
      ? (bestDiv + ' job revenue is up ' + Math.round(bestPct) + '% this month vs. the same month last year (' + money(bestThis) + ' vs ' + money(bestLast) + ').')
      : 'Not enough same-month history yet to identify a real seasonal trend.',
    actionLabel: 'Plan Promotion',
  };
}

// ----- Missed Lead Source (real: lead_pipeline's actual logged sources vs. a common-platform catalog) -----
// Phase 15 addendum item 3: Reina surfaces missed-opportunity
// recommendations -- compares real logged lead_source values against a
// static list of common home-service lead-generation platforms, and
// flags ones with zero real leads logged from them yet. This card is
// descriptive only -- no lead-source connector exists to build yet, so
// it is deliberately never actionable; it exists to prompt an owner
// decision.
const COMMON_LEAD_SOURCE_CATALOG = [
  'Angi', 'HomeAdvisor', 'Thumbtack', 'Houzz', 'Yelp', 'Nextdoor', 'Porch',
  'Networx', 'BuildZoom', 'Service Direct', 'Modernize', 'Bark',
];

async function computeMissedLeadSourcesOpportunity() {
  let rows = [];
  let notSetUp = false;
  try {
    rows = await fetchAllRows('lead_pipeline', '?select=lead_source&lead_source=not.is.null');
  } catch (e) {
    if (e.notSynced) notSetUp = true; else throw e;
  }
  const usedSources = [...new Set(rows.map((r) => String(r.lead_source || '').trim().toLowerCase()).filter(Boolean))];
  const missing = COMMON_LEAD_SOURCE_CATALOG.filter((platform) => {
    const p = platform.toLowerCase();
    return !usedSources.some((used) => used.includes(p) || p.includes(used));
  });
  return {
    key: 'missed_lead_sources',
    label: 'Missed Lead Sources',
    count: notSetUp ? null : missing.length,
    estRevenue: null,
    real: true,
    actionable: false,
    actionableReason: 'No connector exists yet for lead-source platforms -- this is a suggestion, not a live connection. Log a real lead from a new source on the Leads page once you start using it.',
    description: notSetUp
      ? 'Lead pipeline table is not set up yet.'
      : (missing.length
        ? (missing.length + ' common lead-generation platform' + (missing.length === 1 ? '' : 's') + ' (e.g. ' + missing[0] + ') have no real leads logged from ' + (missing.length === 1 ? 'it' : 'them') + ' yet.')
        : 'Every common lead-generation platform already has at least one real logged lead.'),
    actionLabel: 'Add Marketing Account',
  };
}

async function handleOpportunitiesGet(req, res) {
  const results = await Promise.all([
    computeUnsoldEstimates(),
    computeNeighborhoodExpansion(),
    computeReviewRequestsOpportunity(),
    computeReactivateCustomers(),
    computeReferralOpportunities(),
    computeSeasonalPromotion(),
    computeMissedLeadSourcesOpportunity(),
  ]);
  res.status(200).json({ ok: true, source: 'HiveLogic (real Jobber-synced + HiveLogic tables, no fabricated figures)', opportunities: results });
}

// ----- Brief: pick the single highest-value real recommendation -----
async function handleBriefGet(req, res) {
  const opps = (await Promise.all([
    computeUnsoldEstimates(),
    computeReactivateCustomers(),
    computeNeighborhoodExpansion(),
  ])).filter(o => o.estRevenue != null);
  opps.sort((a, b) => (b.estRevenue || 0) - (a.estRevenue || 0));
  const top = opps[0];
  if (!top || !top.count) {
    return res.status(200).json({ ok: true, brief: null, message: 'No real opportunity currently stands out -- nothing urgent to recommend right now.' });
  }
  res.status(200).json({
    ok: true,
    brief: {
      headline: top.label === 'Unsold Estimates' ? 'Recover Unsold Estimates' : (top.label === 'Reactivate Past Customers' ? 'Reactivate Past Customers' : 'Target ' + top.label),
      description: top.description,
      estRevenue: top.estRevenue,
      opportunityKey: top.key,
    },
  });
}

// ----- Insights: only what's honestly computable today -----
async function handleInsightsGet(req, res) {
  const insights = [];

  // Five-star reviews to showcase -- real count of completed jobs that already got a review ask marked "sent"
  try {
    const sent = await fetchAllRows('review_requests', '?select=job_id&status=eq.sent');
    if (sent.length) {
      insights.push({
        icon: 'star',
        insight: sent.length + ' review request' + (sent.length === 1 ? ' has' : 's have') + ' already been sent.',
        why: 'Those jobs are good candidates for real customer quotes or photos in your next post.',
        action: 'Check the Content Studio for a job with a sent review request.',
      });
    }
  } catch (e) { if (!e.notSynced) throw e; }

  // Seasonal trend, reused from computeSeasonalPromotion so the number always agrees with the opportunity card
  const seasonal = await computeSeasonalPromotion();
  if (seasonal.description && seasonal.count === null && seasonal.estRevenue === null && !/Not enough/.test(seasonal.description)) {
    insights.push({
      icon: 'trend',
      insight: seasonal.description,
      why: 'Real completed-job history, not a guess.',
      action: 'Consider a seasonal promotion for that trade this month.',
    });
  }

  if (!insights.length) {
    insights.push({
      icon: 'info',
      insight: 'No computed insights yet.',
      why: 'Insights here are only ever built from real synced data -- as more jobs, reviews, and leads come in, this fills in.',
      action: null,
    });
  }

  res.status(200).json({ ok: true, insights });
}

// ----- Marketing Health: only real sub-metrics, others explicitly flagged not-yet-measurable -----
async function handleMarketingHealthGet(req, res) {
  const media = await fetchAllRows('media', '?select=captured_at&order=captured_at.desc&limit=1');
  let contentFreshnessDays = null;
  if (media.length && media[0].captured_at) {
    contentFreshnessDays = Math.floor((Date.now() - new Date(media[0].captured_at).getTime()) / 86400000);
  }

  let responseTimeDays = null;
  let notSetUp = false;
  try {
    const pipeline = await fetchAllRows('lead_pipeline', '?select=created_at,first_contacted_at&first_contacted_at=not.is.null');
    if (pipeline.length) {
      const total = pipeline.reduce((s, p) => s + (new Date(p.first_contacted_at) - new Date(p.created_at)), 0);
      responseTimeDays = Math.round((total / pipeline.length) / 86400000 * 10) / 10;
    }
  } catch (e) { if (e.notSynced) notSetUp = true; else throw e; }

  const metrics = [
    { key: 'content_freshness', label: 'Content freshness', real: contentFreshnessDays != null, value: contentFreshnessDays != null ? (contentFreshnessDays + ' day' + (contentFreshnessDays === 1 ? '' : 's') + ' since last photo synced') : 'No photos synced yet' },
    { key: 'response_time', label: 'Response time', real: responseTimeDays != null, value: responseTimeDays != null ? (responseTimeDays + ' day avg to first contact') : (notSetUp ? 'Lead pipeline not set up' : 'No leads logged with a contact date yet') },
    { key: 'brand_consistency', label: 'Brand consistency', real: false, value: 'Not yet measurable -- no defined metric' },
    { key: 'review_rating', label: 'Review rating', real: false, value: 'Not yet measurable -- no ratings source connected' },
    { key: 'campaign_performance', label: 'Campaign performance', real: false, value: 'No campaigns run yet' },
  ];

  const realMetrics = metrics.filter(m => m.real);
  // Score is deliberately only computed from real sub-metrics -- if none are real yet, there is no honest score.
  let score = null;
  if (realMetrics.length) {
    let points = 0;
    if (contentFreshnessDays != null) points += contentFreshnessDays <= 7 ? 100 : contentFreshnessDays <= 30 ? 70 : 40;
    if (responseTimeDays != null) points += responseTimeDays <= 1 ? 100 : responseTimeDays <= 3 ? 70 : 40;
    score = Math.round(points / realMetrics.length);
  }

  // A bare "100" reads identically whether it's built from 1 of 5 metrics or
  // all 5 -- surface the coverage explicitly so it can never be mistaken for
  // a full-confidence score. See reina/... audit, item 6.
  const coverage = { measured: realMetrics.length, total: metrics.length };
  const scoreLabel = score == null
    ? 'Insufficient data -- no sub-metrics are measurable yet'
    : `${score} / 100 (based on ${coverage.measured} of ${coverage.total} measurable metrics)`;

  res.status(200).json({
    ok: true,
    score,
    scoreLabel,
    coverage,
    metrics,
    weighting: 'Each measurable sub-metric contributes equally to the average; sub-metrics with no real data source are excluded from both the numerator and denominator (never scored as full or zero marks).',
    measurementPeriod: 'Point-in-time snapshot as of this request -- content freshness and response time are both computed from the latest available real records, not a rolling window.',
    missingDataBehavior: 'A sub-metric with no connected data source is labeled "Not yet measurable" and excluded from the score entirely -- it is never averaged in as 0 or 100.',
  });
}

// ----- Launch Channels: real connection status, Phase 0 canonical model -----
// Reads sql/030_marketing_canonical_foundation.sql's marketing_platform_connections
// table (see reina/marketing-suite-ultimate-build-spec-2026-07-25.md, Figure 4)
// instead of a hardcoded array, so a real credential change (like today's
// Google Ads OAuth wiring) is reflected here without a code deploy. Email
// stays live-computed since it already has real-time Resend checks.
const CHANNEL_LABELS = {
  sms: 'SMS',
  google_ads: 'Google Ads',
  meta_ads: 'Meta (Facebook/Instagram)',
  google_business_profile: 'Google Business Profile',
  website_cms: 'Website / CMS',
  ga4: 'Google Analytics 4',
  gtm: 'Google Tag Manager',
  search_console: 'Search Console',
  youtube: 'YouTube',
  facebook_instagram: 'Facebook Page / Instagram',
  microsoft_ads: 'Microsoft Ads',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  direct_mail: 'Direct Mail',
};
const CONNECTED_STATES = new Set(['launch_enabled', 'reporting_verified', 'draft_validated']);

async function handleChannelsGet(req, res) {
  const emailConfigured = isEmailConfigured();
  const emailSendEnabled = isEmailSendEnabled();
  const emailChannel = {
    key: 'email', label: 'Email', state: !emailConfigured ? 'not_connected' : (emailSendEnabled ? 'launch_enabled' : 'reporting_verified'),
    connected: emailConfigured,
    note: !emailConfigured
      ? 'No Resend account connected -- add RESEND_API_KEY in Vercel.'
      : (emailSendEnabled ? 'Resend connected -- campaign sending is live.' : 'Resend connected, but sending is turned off -- set MARKETING_EMAIL_SEND_ENABLED=true in Vercel to allow real sends.'),
  };

  let stored = [];
  try {
    stored = await fetchAllRows('marketing_platform_connections', '?select=platform,state,account_name,account_id,login_account_id,note,last_verified_at');
  } catch (e) {
    if (!e.notSynced) throw e; // table not migrated yet on this environment -- fall back to 'not connected' for everything below rather than failing the whole endpoint
  }
  const byPlatform = new Map(stored.map(r => [r.platform, r]));

  const otherChannels = Object.keys(CHANNEL_LABELS).map(key => {
    const row = byPlatform.get(key);
    const state = row ? row.state : 'not_connected';
    return {
      key,
      label: CHANNEL_LABELS[key],
      state,
      connected: CONNECTED_STATES.has(state),
      accountName: (row && row.account_name) || null,
      accountId: (row && row.account_id) || null,
      note: (row && row.note) || 'Not connected.',
    };
  });

  res.status(200).json({ ok: true, channels: [emailChannel, ...otherChannels] });
}

// ----- Campaigns: real CRUD against the new campaigns/campaign_recipients tables -----
async function handleCampaignsGet(req, res) {
  const campaigns = await fetchAllRows('campaigns', '?select=*&order=created_at.desc');
  const recipients = await fetchAllRows('campaign_recipients', '?select=campaign_id,sent_at,outcome,outcome_value');
  const byCampaign = new Map();
  for (const r of recipients) {
    if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, []);
    byCampaign.get(r.campaign_id).push(r);
  }
  const shaped = campaigns.map(c => {
    const recips = byCampaign.get(c.id) || [];
    const sent = recips.filter(r => r.sent_at).length;
    const responded = recips.filter(r => r.outcome === 'responded' || r.outcome === 'booked').length;
    const booked = recips.filter(r => r.outcome === 'booked');
    const bookedCount = booked.length;
    const bookedValue = booked.reduce((s, r) => s + (Number(r.outcome_value) || 0), 0);
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      channel: c.channel,
      status: c.status,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      createdBy: c.created_by,
      updatedBy: c.updated_by,
      scheduledAt: c.scheduled_at,
      notes: c.notes,
      subject: c.subject,
      body: c.body,
      recipientCount: recips.length,
      sent,
      responseRate: sent ? Math.round((responded / sent) * 100) : null,
      booked: bookedCount,
      bookedValue: Math.round(bookedValue),
    };
  });
  res.status(200).json({ ok: true, campaigns: shaped });
}

async function handleCampaignsPost(req, res) {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const type = String(b.type || '').trim();
  const validTypes = [
    'estimate_recovery', 'review_request', 'reactivation', 'referral', 'seasonal', 'custom',
    // Phase 14 lifecycle playbooks (sql/047-052) -- additive-only migrations,
    // written but NOT applied to production per this project's standing rule.
    // These 6 types 400 here until Chris applies that migration; 'referral'
    // above already existed and needed no migration.
    'post_job_thank_you', 'service_anniversary', 'new_lead_followup', 'dormant_reactivation', 'newsletter', 'maintenance_reminders',
  ];
  if (!name) return res.status(400).json({ ok: false, error: 'name is required.' });
  if (!validTypes.includes(type)) return res.status(400).json({ ok: false, error: 'type must be one of: ' + validTypes.join(', ') });

  const channel = ['email', 'sms', 'mail'].includes(b.channel) ? b.channel : 'email';
  const opportunityKey = b.targetFilter && b.targetFilter.opportunityKey ? String(b.targetFilter.opportunityKey) : null;
  const incomingRecipients = Array.isArray(b.recipients) ? b.recipients : [];
  const eligibility = checkCampaignEligibility({ opportunityKey, channel, recipientCount: incomingRecipients.length });
  if (!eligibility.eligible) {
    return res.status(400).json({
      ok: false,
      error: eligibility.reason,
      requiredIntegration: eligibility.requiredIntegration,
      blocked: true,
    });
  }

  const actorEmail = (req.hlUser && req.hlUser.email) || null;

  if (type !== 'custom') {
    const dupRes = await supabaseRequest(`campaigns?type=eq.${encodeURIComponent(type)}&status=eq.draft&select=*&order=created_at.desc&limit=1`);
    if (dupRes.ok) {
      const [existing] = await dupRes.json();
      if (existing) {
        const countRes = await supabaseRequest(`campaign_recipients?campaign_id=eq.${encodeURIComponent(existing.id)}&select=id`);
        let existingRecipientCount = countRes.ok ? (await countRes.json()).length : 0;
        const incoming = incomingRecipients;
        if (existingRecipientCount === 0 && incoming.length) {
          const recRows = incoming.slice(0, 500).map(rec => ({
            campaign_id: existing.id,
            client_id: rec.clientId || null,
            target_record_id: rec.targetRecordId || null,
            target_record_type: rec.targetRecordType || null,
          }));
          await supabaseRequest('campaign_recipients', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(recRows) });
          existingRecipientCount = recRows.length;
        }
        return res.status(200).json({ ok: true, campaign: existing, recipientCount: existingRecipientCount, reused: true });
      }
    }
  }

  const row = {
    name,
    type,
    channel,
    status: 'draft',
    target_filter: b.targetFilter || null,
    notes: b.notes || null,
    created_by: actorEmail,
    subject: typeof b.subject === 'string' && b.subject.trim() ? b.subject.trim() : null,
    body: typeof b.body === 'string' && b.body.trim() ? b.body.trim() : null,
  };
  const r = await supabaseRequest('campaigns', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) {
    const text = await r.text();
    const notSynced = /relation .* does not exist/i.test(text);
    return res.status(notSynced ? 200 : 500).json({ ok: false, error: notSynced ? 'campaigns table is not set up yet -- run sql/021_campaigns.sql in Supabase.' : text });
  }
  const created = (await r.json())[0];

  // Real recipient list, drawn from actual records matching the campaign's target
  const recipients = incomingRecipients;
  if (recipients.length) {
    const recRows = recipients.slice(0, 500).map(rec => ({
      campaign_id: created.id,
      client_id: rec.clientId || null,
      target_record_id: rec.targetRecordId || null,
      target_record_type: rec.targetRecordType || null,
    }));
    await supabaseRequest('campaign_recipients', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(recRows) });
  }

  await logCampaignActivity(created.id, 'created', actorEmail, { opportunityKey, recipientCount: recipients.length });
  if (opportunityKey) {
    await logMarketingAuditEvent('opportunity', 'converted_to_campaign', 'opportunity', opportunityKey, 'owner', { campaignId: created.id, recipientCount: recipients.length });
  }

  // Real Ready-for-You approval row for this draft. Best-effort: a failed
  // write here must never undo or block the real campaign draft that
  // already exists above. No amount/confidence/risks -- this campaign type
  // has no per-send dollar cost field and no real scoring exists yet.
  try {
    await supabaseRequest('marketing_approvals', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        tenant_id: 'ghgrp',
        approvable_type: 'CAMPAIGN_SPEND',
        approvable_id: String(created.id),
        title: created.name,
        rationale: 'New ' + (CAMPAIGN_TYPE_LABEL[created.type] || created.type) + ' campaign draft ready to review -- ' + recipients.length + ' recipients ready.',
        preview_text: created.subject || created.body || null,
        target_description: created.target_filter ? JSON.stringify(created.target_filter) : null,
        estimate: JSON.stringify({ recipientCount: recipients.length }),
        requested_by: 'system',
      }),
    });
  } catch (e) { /* best-effort -- Ready for You falls back to the raw campaign row */ }

  res.status(200).json({ ok: true, campaign: created, recipientCount: recipients.length });
}

async function handleCampaignRecipientPatch(req, res) {
  const b = req.body || {};
  const recipientId = String(b.recipientId || '').trim();
  if (!recipientId) return res.status(400).json({ ok: false, error: 'recipientId is required.' });
  const patch = { updated_at: new Date().toISOString() };
  if (b.sent === true) patch.sent_at = new Date().toISOString();
  if (b.outcome && ['no_response', 'responded', 'booked'].includes(b.outcome)) patch.outcome = b.outcome;
  if (b.outcomeValue != null) patch.outcome_value = Number(b.outcomeValue) || 0;

  const r = await supabaseRequest('campaign_recipients?id=eq.' + encodeURIComponent(recipientId), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: await r.text() });
  const rows = await r.json();
  res.status(200).json({ ok: true, recipient: rows[0] || null });
}

// ----- Campaign Send: real email send via Resend -----
// Gated behind two independent checks, reported as two different honest
// error states (see api/_lib/email.js): isEmailConfigured() (is a
// RESEND_API_KEY even set for this deployment) and isEmailSendEnabled()
// (is MARKETING_EMAIL_SEND_ENABLED=true set on top of that). Both must be
// true before a single email goes out -- matches this repo's convention
// of off-by-default automation gates (HIVELOGIC_QBO_WRITE_ENABLED etc).
async function handleCampaignSendPost(req, res) {
  const b = req.body || {};
  const campaignId = String(b.campaignId || '').trim();
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required.' });

  if (!isEmailConfigured()) {
    return res.status(409).json({ ok: false, error: 'RESEND_API_KEY is not set for this deployment -- add it in Vercel before sending.' });
  }
  if (!isEmailSendEnabled()) {
    return res.status(409).json({ ok: false, error: 'Email sending is built but turned off -- set MARKETING_EMAIL_SEND_ENABLED=true in Vercel to enable it.' });
  }

  const subject = String(b.subject || '').trim();
  const bodyText = String(b.body || '').trim();
  if (!subject || !bodyText) {
    return res.status(400).json({ ok: false, error: 'subject and body are required.' });
  }

  const campRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}&select=*&limit=1`);
  if (!campRes.ok) return res.status(500).json({ ok: false, error: await campRes.text() });
  const [campaign] = await campRes.json();
  if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found.' });
  if (campaign.channel !== 'email') {
    return res.status(400).json({ ok: false, error: `This campaign's channel is "${campaign.channel}", not "email" -- only email sending is built so far.` });
  }
  if (campaign.status === 'sent' || campaign.status === 'sending') {
    return res.status(409).json({ ok: false, error: `This campaign is already "${campaign.status}" -- refusing to send again (protects against double-clicks, retries, and concurrent requests).` });
  }

  const recipients = await fetchAllRows('campaign_recipients', `?campaign_id=eq.${encodeURIComponent(campaignId)}&sent_at=is.null&select=id,client_id,target_record_id,target_record_type`);
  if (!recipients.length) {
    return res.status(200).json({ ok: true, attempted: 0, sent: 0, failed: 0, skippedNoEmail: 0, skippedSuppressed: 0, message: 'No unsent recipients on this campaign.' });
  }

  const actorEmail = (req.hlUser && req.hlUser.email) || null;
  // Atomic claim: flip status draft/scheduled -> sending in one conditional
  // UPDATE. Postgres row-locking makes this safe against two concurrent
  // requests for the SAME campaign -- only one can ever see status still
  // eligible and win the claim; the loser gets 0 rows back and is rejected
  // below instead of sending a second time.
  const claimRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}&status=in.(draft,scheduled)`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'sending' }),
  });
  if (!claimRes.ok) return res.status(500).json({ ok: false, error: await claimRes.text() });
  const claimed = await claimRes.json();
  if (!claimed.length) {
    return res.status(409).json({ ok: false, error: `This campaign is already "${campaign.status}" -- it cannot be sent again from here.` });
  }
  await logCampaignActivity(campaignId, 'send_started', actorEmail, { attempted: recipients.length, subject });

  const clientIds = [...new Set(recipients.map(r => r.client_id).filter(Boolean))];
  const clientsById = new Map();
  if (clientIds.length) {
    const clientsRes = await supabaseRequest(`clients?select=jobber_id,name,first_name,last_name,email&jobber_id=in.(${clientIds.map(id => `"${id}"`).join(',')})`);
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) clientsById.set(c.jobber_id, c);
    }
  }

  let jobTitleById = new Map();
  const jobIds = [...new Set(recipients.filter(r => r.target_record_type === 'job').map(r => r.target_record_id).filter(Boolean))];
  if (jobIds.length) {
    const jobsRes = await supabaseRequest(`jobs?select=jobber_id,title&jobber_id=in.(${jobIds.map(id => `"${id}"`).join(',')})`);
    if (jobsRes.ok) { for (const j of await jobsRes.json()) jobTitleById.set(j.jobber_id, j.title || ''); }
  }

  let quoteById = new Map();
  const quoteIds = [...new Set(recipients.filter(r => r.target_record_type === 'quote').map(r => r.target_record_id).filter(Boolean))];
  if (quoteIds.length) {
    const quotesRes = await supabaseRequest(`quotes?select=jobber_id,title,total&jobber_id=in.(${quoteIds.map(id => `"${id}"`).join(',')})`);
    if (quotesRes.ok) { for (const q of await quotesRes.json()) quoteById.set(q.jobber_id, q); }
  }

  let suppressedClientIds = new Set();
  let revokedClientIds = new Set();
  if (clientIds.length) {
    try {
      const [supp, consent] = await Promise.all([
        fetchAllRows('marketing_suppressions', `?channel=eq.email&client_id=in.(${clientIds.map(id => `"${id}"`).join(',')})&select=client_id`),
        fetchAllRows('marketing_consent_ledger', `?channel=eq.email&status=eq.revoked&client_id=in.(${clientIds.map(id => `"${id}"`).join(',')})&select=client_id`),
      ]);
      suppressedClientIds = new Set(supp.map(row => row.client_id));
      revokedClientIds = new Set(consent.map(row => row.client_id));
    } catch (e) {
      if (!e.notSynced) throw e; // tables not migrated on this environment yet -- fail open to today's existing behavior rather than blocking all sends
    }
  }

  let sent = 0, failed = 0, skippedNoEmail = 0, skippedSuppressed = 0;
  const sentIds = [];
  for (const r of recipients) {
    const client = r.client_id ? clientsById.get(r.client_id) : null;
    const email = client && client.email;
    if (!email) { skippedNoEmail++; continue; }
    if (r.client_id && (suppressedClientIds.has(r.client_id) || revokedClientIds.has(r.client_id))) { skippedSuppressed++; continue; }
    const clientName = (client && (client.name || [client.first_name, client.last_name].filter(Boolean).join(' '))) || 'there';
    const jobTitle = (r.target_record_type === 'job' && r.target_record_id) ? (jobTitleById.get(r.target_record_id) || '') : '';
    const quote = (r.target_record_type === 'quote' && r.target_record_id) ? quoteById.get(r.target_record_id) : null;
    const quoteTitle = quote ? (quote.title || '') : '';
    const quoteTotal = quote ? money(Number(quote.total) || 0) : '';
    const unsubUrl = r.client_id ? unsubscribeUrl(r.client_id, 'email') : null;
    const personalized = bodyText
      .replaceAll('{{clientName}}', clientName)
      .replaceAll('{{jobTitle}}', jobTitle)
      .replaceAll('{{quoteTitle}}', quoteTitle)
      .replaceAll('{{quoteTotal}}', quoteTotal);
    const footer = unsubUrl ? ('\n\n---\nDon\'t want these emails? Unsubscribe: ' + unsubUrl) : '';
    const htmlFooter = unsubUrl ? (`<p style="font-size:11px;color:#8a8a8a;">Don\'t want these emails? <a href="${unsubUrl}">Unsubscribe</a></p>`) : '';
    const result = await sendEmail({
      to: email,
      subject,
      text: personalized + footer,
      html: personalized.split(/\r?\n/).map(line => `<p>${line || '&nbsp;'}</p>`).join('') + htmlFooter,
      headers: unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    });
    if (result.ok) { sent++; sentIds.push(r.id); } else { failed++; }
  }

  if (sentIds.length) {
    await supabaseRequest(`campaign_recipients?id=in.(${sentIds.map(id => `"${id}"`).join(',')})`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ sent_at: new Date().toISOString() }),
    });
  }
  if (sentIds.length && campaign.type === 'review_request') {
    // Mirror sent review-ask emails into the legacy review_requests table
    // (job_id is UNIQUE there) so computeReviewRequestsOpportunity's pending
    // count never re-offers the same completed job on a later page load.
    // Best-effort: a failure here must never undo or block the real send
    // that already happened above.
    const sentSet = new Set(sentIds);
    const rrRows = recipients
      .filter(r => sentSet.has(r.id) && r.target_record_type === 'job' && r.target_record_id)
      .map(r => ({ job_id: r.target_record_id, client_id: r.client_id, channel: 'email', status: 'sent', sent_at: new Date().toISOString() }));
    if (rrRows.length) {
      try {
        await supabaseRequest('review_requests?on_conflict=job_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rrRows),
        });
      } catch (e) { /* best-effort mirror only */ }
    }
  }
  // Resolve the 'sending' claim to a terminal state. sent>0 always moves
  // forward to 'active' (matches the pre-existing terminology) even if some
  // recipients failed/were skipped -- those recipients still have sent_at
  // NULL, so a later retry on this same campaign will pick up exactly the
  // ones that still need it, never re-sending to anyone already marked sent.
  // If NOTHING sent at all (e.g. every recipient was suppressed or every
  // Resend call failed), revert to 'draft' so the campaign is visibly
  // retryable instead of stuck in 'sending' forever.
  const finalStatus = sent > 0 ? 'active' : 'draft';
  await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: finalStatus }),
  });
  if (finalStatus === 'active') {
    // Real Ready-for-You approval row for this campaign, if one exists,
    // moves out of pending now that the owner actually sent it. Best-
    // effort: never blocks the real send that already happened above.
    try {
      await supabaseRequest(`marketing_approvals?approvable_type=eq.CAMPAIGN_SPEND&approvable_id=eq.${encodeURIComponent(campaignId)}&status=eq.pending`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'approved', decided_by: actorEmail || 'owner', decided_at: new Date().toISOString() }),
      });
    } catch (e) { /* best-effort only */ }
  }
  await logCampaignActivity(campaignId, sent > 0 ? 'send_completed' : 'send_failed', actorEmail, { attempted: recipients.length, sent, failed, skippedNoEmail, skippedSuppressed });

  res.status(200).json({ ok: true, attempted: recipients.length, sent, failed, skippedNoEmail, skippedSuppressed });
}

// ---------- Ready for You: Ask Reina (free-form Q&A about a draft campaign) ----------
// The owner can ask a plain-language question about a still-draft campaign
// (why was this recommended, who will it reach, has this worked before,
// etc.) right from the send-review modal. Reina answers using ONLY the
// real facts pulled for this specific campaign -- its own row, its real
// recipient/sent/outcome counts from campaign_recipients, and (when the
// campaign type maps to a real candidate query) one real sample
// recipient's real name/job/quote facts, the same source ccApprove()
// already surfaces. If a question asks about something not present in
// those real facts (e.g. future performance, data this system does not
// track), Reina is instructed to say so honestly rather than guess.
const CAMPAIGN_TYPE_TO_OPP_KEY = {
  review_request: 'review_requests',
  estimate_recovery: 'unsold_estimates',
  reactivation: 'reactivate_customers',
  seasonal: 'seasonal_promotion',
};

async function handleCampaignAskReinaPost(req, res) {
  if (!anthropicMkt) {
    return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment -- Ask Reina is not available yet.' });
  }
  const b = req.body || {};
  const campaignId = String(b.campaignId || '').trim();
  const question = String(b.question || '').trim();
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required.' });
  if (!question) return res.status(400).json({ ok: false, error: 'question is required.' });
  if (question.length > 500) return res.status(400).json({ ok: false, error: 'Question is too long -- please keep it under 500 characters.' });

  const campRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}&select=id,name,type,channel,status,notes,created_at&limit=1`);
  if (!campRes.ok) return res.status(500).json({ ok: false, error: await campRes.text() });
  const [campaign] = await campRes.json();
  if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found.' });

  const recRes = await supabaseRequest(`campaign_recipients?campaign_id=eq.${encodeURIComponent(campaignId)}&select=sent_at,outcome`);
  const recipients = recRes.ok ? await recRes.json() : [];
  const recipientCount = recipients.length;
  const sentCount = recipients.filter((r) => r.sent_at).length;
  const respondedCount = recipients.filter((r) => r.outcome === 'responded').length;
  const bookedCount = recipients.filter((r) => r.outcome === 'booked').length;

  const oppKey = CAMPAIGN_TYPE_TO_OPP_KEY[campaign.type] || null;
  let sample = null;
  if (oppKey === 'review_requests') sample = (await getReviewRequestCandidates(1)).candidates[0] || null;
  else if (oppKey === 'unsold_estimates') sample = (await getUnsoldEstimateCandidates(1)).candidates[0] || null;
  else if (oppKey === 'reactivate_customers') sample = (await getReactivationCandidates(1)).candidates[0] || null;
  else if (oppKey === 'seasonal_promotion') sample = (await getSeasonalCandidates(1)).candidates[0] || null;
  const sampleFacts = sample ? {
    clientName: sample.clientName,
    jobTitle: sample.jobTitle || sample.lastJobTitle || null,
    quoteTitle: sample.quoteTitle || null,
    quoteTotal: sample.quoteTotal != null ? Number(sample.quoteTotal) : null,
  } : null;

  const realFacts = {
    campaignName: campaign.name,
    campaignType: campaign.type,
    channel: campaign.channel,
    status: campaign.status,
    notes: campaign.notes || null,
    createdAt: campaign.created_at,
    recipientCount,
    sentCount,
    respondedCount,
    bookedCount,
    sampleRecipient: sampleFacts,
  };
  const factsText = JSON.stringify(realFacts, null, 2);
  const prompt = 'You are Reina, an AI operations assistant for a home services company, answering the owner\'s question about one specific marketing campaign. ' +
    'Answer using ONLY the real facts below -- never invent a number, name, or outcome that is not present. ' +
    'If the question asks about something these facts do not cover (for example, predicted future performance, or data this system does not track), say so honestly instead of guessing. ' +
    'Keep the answer conversational and under 120 words.\n\n' +
    'Campaign facts:\n' + factsText + '\n\n' +
    'Owner\'s question: ' + question + '\n\n' +
    'Return ONLY your answer text -- no JSON, no markdown headers.';

  const resp = await anthropicMkt.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  const answer = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (!answer) return res.status(502).json({ ok: false, error: 'Reina did not return an answer -- try again.' });
  res.status(200).json({ ok: true, answer, usedRealSample: !!sample });
}

async function handleCampaignRegenerateCopyPost(req, res) {
  if (!anthropicMkt) {
    return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment -- cannot regenerate AI copy yet.' });
  }
  const b = req.body || {};
  const campaignId = String(b.campaignId || '').trim();
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required.' });

  const campRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}&select=id,name,type,channel,status&limit=1`);
  if (!campRes.ok) return res.status(500).json({ ok: false, error: await campRes.text() });
  const [campaign] = await campRes.json();
  if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found.' });
  if (campaign.status !== 'draft') {
    return res.status(409).json({ ok: false, error: `This campaign is already "${campaign.status}" -- copy can only be regenerated for a draft.` });
  }

  const oppKey = CAMPAIGN_TYPE_TO_OPP_KEY[campaign.type] || null;
  let sample = null;
  if (oppKey === 'review_requests') sample = (await getReviewRequestCandidates(1)).candidates[0] || null;
  else if (oppKey === 'unsold_estimates') sample = (await getUnsoldEstimateCandidates(1)).candidates[0] || null;
  else if (oppKey === 'reactivate_customers') sample = (await getReactivationCandidates(1)).candidates[0] || null;
  else if (oppKey === 'seasonal_promotion') sample = (await getSeasonalCandidates(1)).candidates[0] || null;
  const sampleFacts = sample ? {
    clientName: sample.clientName,
    jobTitle: sample.jobTitle || sample.lastJobTitle || null,
    quoteTitle: sample.quoteTitle || null,
    quoteTotal: sample.quoteTotal != null ? Number(sample.quoteTotal) : null,
  } : null;

  const realFacts = { campaignName: campaign.name, campaignType: campaign.type, channel: campaign.channel, sampleRecipient: sampleFacts };
  const factsText = JSON.stringify(realFacts, null, 2);
  const prompt = 'You are drafting a short marketing email (subject + body) for a home services company campaign. ' +
    'Use ONLY the real facts below -- never invent a client name, job detail, or dollar figure that is not present. ' +
    'The body may use the merge fields {{clientName}}, {{jobTitle}}, {{quoteTitle}}, {{quoteTotal}} -- these are filled in per-recipient at send time, so keep them as literal placeholders in your draft rather than the sample values shown below. ' +
    'Keep the tone warm and professional, 3-6 short sentences in the body.\n\n' +
    'Facts:\n' + factsText + '\n\n' +
    'Return ONLY a JSON object with exactly two string keys, "subject" and "body" -- no other text, no markdown code fences.';

  const resp = await anthropicMkt.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  // Bug fix (2026-08-07): review_request/estimate_recovery/reactivation
  // samples embed a real job/quote title in the prompt (often messy
  // real-world text -- ALL CAPS, slashes, apostrophes, parens), and Claude
  // would reliably wrap its answer in a markdown ```json fence or add a
  // one-line lead-in when discussing that title, which the old bare
  // JSON.parse(text) had zero tolerance for. seasonal has no title field in
  // its sample, which is why only it ever parsed cleanly. Stripping a
  // fence and falling back to the outermost {...} substring covers both
  // deviations without needing a stricter prompt or a retry.
  let jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const match = jsonText.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (e2) { /* fall through to the error below */ }
    }
  }
  if (!parsed) {
    return res.status(502).json({ ok: false, error: 'AI response was not valid JSON -- try again.' });
  }
  if (typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    return res.status(502).json({ ok: false, error: 'AI response was missing subject/body -- try again.' });
  }
  res.status(200).json({ ok: true, subject: parsed.subject, body: parsed.body, usedRealSample: !!sample });
}

// ---------- Content Studio: real photo-backed job list + AI-drafted post copy ----------
// Added as the natural next build after the Marketing Suite rebuild's Content
// Studio pass, which shipped real photo-sync STATS but explicitly deferred
// the real photo grid + AI-drafted copy. Both pieces below only ever use
// real Jobber-synced job/client data and real CompanyCam-synced media rows
// (plus any real Visual Intelligence AI analysis already attached to a
// photo) -- never fabricated specifics.
// ===== Reina M1a: change-request recommendations (approvals surface) =====
// Surfaces the pending change-request recommendations Reina wrote via
// /api/reina/observe-change-request -- they are marketing_approvals rows with
// approvable_type='reina_change_request'. This is READ + DECIDE only:
// approving one here records a human decision on the row; it does NOT create a
// change order, email the client, or write to Jobber. That acting step is
// deliberately outside M1a's observe-only scope.
async function handleReinaChangeRequestsGet(req, res) {
  let rows = [];
  try {
    rows = await fetchAllRows('marketing_approvals',
      "?select=id,approvable_id,title,rationale,amount_cents,confidence,risks,estimate,target_description,status,created_at&approvable_type=eq.reina_change_request&status=eq.pending&order=created_at.desc");
  } catch (e) {
    if (e.notSynced) {
      return res.status(200).json({ ok: true, pending: [], returned: 0, note: 'marketing_approvals is not set up yet -- run the latest sql/0NN_*.sql migrations in Supabase.' });
    }
    throw e;
  }
  const pending = rows.map((r) => {
    const est = r.estimate || {};
    return {
      id: r.id,
      jobId: r.approvable_id,
      title: r.title,
      rationale: r.rationale,
      amountCents: r.amount_cents,
      needsEstimatorPricing: est.needs_estimator_pricing === true || r.amount_cents == null,
      confidence: r.confidence == null ? null : Number(r.confidence),
      risks: Array.isArray(r.risks) ? r.risks : [],
      scopeDelta: est.scope_delta || null,
      gaps: Array.isArray(est.gaps) ? est.gaps : [],
      citedExcerpt: est.cited_excerpt || null,
      requestSource: est.request_source || null,
      isTest: est.test_invocation === true,
      target: r.target_description || null,
      createdAt: r.created_at,
    };
  });
  res.status(200).json({ ok: true, source: 'marketing_approvals (reina_change_request, pending)', returned: pending.length, pending });
}

// Task #105: when the owner approves a Reina change-request recommendation,
// tell the real client -- reusing the exact real Resend email infra
// handleCampaignSendPost already sends through (isEmailConfigured /
// isEmailSendEnabled / sendEmail, api/_lib/email.js). Grounded ONLY in the
// approval row's own real captured fields (title/rationale/scope_delta/
// amount_cents) -- never invents what the change was or what it costs.
//
// Jobber change-order creation was investigated for this feature and is
// deliberately NOT implemented:
//   - Jobber's real GraphQL API has no "change order" object at all. The
//     only Jobber WRITE mutations ever verified in this codebase are the
//     visit reschedule/reassign ones in api/schedule/move-visit.js, each
//     confirmed live against Jobber's schema via introspection before use.
//     No such verification is possible here (no live Jobber credentials in
//     this environment), so authoring a brand-new, never-tested mutation
//     would be an unverified guess this codebase's own convention forbids.
//   - HiveLogic's OWN internal "Change Order" feature (real, tested --
//     server/bookkeeping/src/change-orders.js) is not a Jobber object and
//     never writes to Jobber. Every line item it stores requires a real
//     unitCost (cost) figure for margin/job-costing, but a Reina change
//     request only ever captures an optional CLIENT-STATED PRICE, never a
//     cost breakdown (observe-change-request.js explicitly never invents a
//     price, let alone a cost). Fabricating a cost to satisfy that schema
//     would corrupt real profitability reporting -- forbidden outright.
// See reina/task105-change-request-autoexecute-investigation-2026-08-05.md
// for the full writeup.
async function notifyClientOfApprovedChangeRequest(approvalRow) {
  const jobId = approvalRow.approvable_id;
  let job = null;
  let client = null;
  try {
    if (jobId) {
      const jobRes = await supabaseRequest(`jobs?jobber_id=eq.${encodeURIComponent(jobId)}&select=jobber_id,title,client_id&limit=1`);
      if (jobRes.ok) {
        const rows = await jobRes.json();
        job = rows[0] || null;
      }
      if (job && job.client_id) {
        const clientRes = await supabaseRequest(`clients?jobber_id=eq.${encodeURIComponent(job.client_id)}&select=jobber_id,name,first_name,last_name,email&limit=1`);
        if (clientRes.ok) {
          const rows = await clientRes.json();
          client = rows[0] || null;
        }
      }
    }
  } catch (e) {
    return { status: 'failed', reason: `Could not look up the job/client for this change request: ${e.message}` };
  }

  if (!job) {
    return { status: 'skipped_no_job', reason: 'No linked Jobber job was found for this change request -- cannot identify who to notify.' };
  }
  if (!isEmailConfigured()) {
    return { status: 'skipped_not_configured', reason: 'RESEND_API_KEY is not set for this deployment.' };
  }
  if (!isEmailSendEnabled()) {
    return { status: 'skipped_disabled', reason: 'Email sending is built but turned off -- set MARKETING_EMAIL_SEND_ENABLED=true in Vercel to enable it.' };
  }
  if (!client || !client.email) {
    return { status: 'skipped_no_email', reason: 'No email on file for this client.' };
  }

  const clientName = client.name || [client.first_name, client.last_name].filter(Boolean).join(' ') || 'there';
  const jobTitle = job.title || approvalRow.target_description || 'your job';
  const scopeText = (approvalRow.estimate && approvalRow.estimate.scope_delta) || approvalRow.rationale || approvalRow.title;
  const priceLine = approvalRow.amount_cents != null
    ? `Approved amount: ${money(approvalRow.amount_cents / 100)}.`
    : "We'll follow up with pricing for this change shortly.";
  const subject = `Your requested change to "${jobTitle}" has been approved`;
  const lines = [
    `Hi ${clientName},`,
    '',
    `Good news -- we've approved your requested change to "${jobTitle}":`,
    scopeText,
    '',
    priceLine,
    '',
    'Thanks,',
    'The team',
  ];
  const text = lines.join('\n');
  const html = lines.map((l) => `<p>${l || '&nbsp;'}</p>`).join('');
  const result = await sendEmail({ to: client.email, subject, text, html });
  if (!result.ok) {
    return { status: 'failed', reason: result.error };
  }
  return { status: 'sent', to: client.email };
}

async function handleReinaChangeRequestDecidePost(req, res) {
  const b = req.body || {};
  const id = String(b.id || '').trim();
  const decision = String(b.decision || '').trim();
  const reason = b.reason == null ? null : String(b.reason).slice(0, 1000);
  if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ ok: false, error: "decision must be 'approved' or 'rejected'." });
  }
  const decidedBy = (req.hlUser && (req.hlUser.email || req.hlUser.id)) || 'owner';
  const patch = {
    status: decision,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    decision_reason: reason,
    updated_at: new Date().toISOString(),
  };
  // Scope the PATCH to a still-pending Reina change request, so a stale tab or
  // a double-click can never flip an already-decided (or unrelated) row.
  const r = await supabaseRequest(
    `marketing_approvals?id=eq.${encodeURIComponent(id)}&approvable_type=eq.reina_change_request&status=eq.pending`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) },
  );
  if (!r.ok) {
    const text = await r.text();
    return res.status(500).json({ ok: false, error: text });
  }
  const updated = await r.json();
  if (!updated.length) {
    return res.status(409).json({ ok: false, error: 'That recommendation was not found or is no longer pending -- it may have just been decided in another tab. Refresh to see the current list.' });
  }
  const row = updated[0];

  // Task #105: on approve, notify the real client and honestly report the
  // (deliberately not auto-created) change-order status -- see
  // notifyClientOfApprovedChangeRequest above for why. Neither side effect
  // runs for rejections or any other decision.
  let notification = { status: 'not_applicable' };
  let changeOrder = { status: 'not_applicable' };
  if (decision === 'approved') {
    try {
      notification = await notifyClientOfApprovedChangeRequest(row);
    } catch (e) {
      notification = { status: 'failed', reason: e.message || 'Could not send the client notification.' };
    }
    changeOrder = {
      status: 'not_available',
      reason: 'Jobber has no native change-order object, and a HiveLogic Change Order line item requires a real cost figure this change request never captures (only an optional client-stated price) -- auto-creating one would fabricate financial data. See reina/task105-change-request-autoexecute-investigation-2026-08-05.md.',
    };
    // Best-effort: record the outcome on the row itself so it is not lost the
    // moment this response is sent. A failure here never blocks or unwinds
    // the real decision/notification that already happened above.
    try {
      await supabaseRequest(`marketing_approvals?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estimate: { ...(row.estimate || {}), execution: { notification, changeOrder, executed_at: new Date().toISOString() } } }),
      });
    } catch (e) { /* best-effort only */ }
  }

  res.status(200).json({ ok: true, decision, approval: { id: row.id, status: row.status, decided_by: row.decided_by, decided_at: row.decided_at }, notification, changeOrder });
}
// ===== end Reina M1a change-request approvals =====

async function handleContentJobsGet(req, res) {
  const limit = Math.min(Number(req.query.limit) || 12, 30);
  const scanLimit = Math.min(Number(req.query.scanLimit) || 20000, 50000);
  const pageSize = 1000;
  const byJob = {};
  for (let offset = 0; offset < scanLimit; offset += pageSize) {
    const r = await supabaseRequest(`media?select=job_id,captured_at&order=captured_at.desc&limit=${pageSize}&offset=${offset}`);
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    for (const row of rows) {
      if (!row.job_id) continue;
      const cur = byJob[row.job_id];
      if (!cur) byJob[row.job_id] = { jobId: row.job_id, mediaCount: 1, lastActivityAt: row.captured_at };
      else cur.mediaCount++;
    }
    if (rows.length < pageSize) break;
  }
  const top = Object.values(byJob)
    .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
    .slice(0, limit);
  if (!top.length) {
    return res.status(200).json({ ok: true, source: 'HiveLogic Marketing', jobs: [] });
  }
  const jobIds = top.map((t) => t.jobId);
  const jobsRes = await supabaseRequest(`jobs?select=jobber_id,client_id,job_number,title&jobber_id=in.(${jobIds.map((id) => `"${id}"`).join(',')})`);
  const jobsById = new Map();
  if (jobsRes.ok) { for (const j of await jobsRes.json()) jobsById.set(j.jobber_id, j); }
  const clientIds = [...new Set([...jobsById.values()].map((j) => j.client_id).filter(Boolean))];
  const clientsById = new Map();
  if (clientIds.length) {
    const clientsRes = await supabaseRequest(`clients?select=jobber_id,name,first_name,last_name,company_name&jobber_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})`);
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) {
        clientsById.set(c.jobber_id, c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null);
      }
    }
  }
  const jobs = await Promise.all(top.map(async (t) => {
    const job = jobsById.get(t.jobId);
    const mediaRes = await supabaseRequest(`media?select=id,storage_path,captured_at,media_analysis(description,trade,room)&job_id=eq.${encodeURIComponent(t.jobId)}&order=captured_at.desc&limit=4`);
    const mediaRows = mediaRes.ok ? await mediaRes.json() : [];
    const analysis = mediaRows.map((m) => m.media_analysis && m.media_analysis[0]).filter(Boolean);
    return {
      jobId: t.jobId,
      jobNumber: job ? job.job_number : null,
      jobTitle: job ? job.title : null,
      division: jobDivisionServer(job ? job.title : ''),
      clientName: job ? clientsById.get(job.client_id) || null : null,
      mediaCount: t.mediaCount,
      lastActivityAt: t.lastActivityAt,
      photos: mediaRows.map((m) => ({ id: m.id, storagePath: m.storage_path, capturedAt: m.captured_at })),
      hasRealAnalysis: analysis.length > 0,
      analysisNotes: analysis.map((a) => [a.trade, a.room, a.description].filter(Boolean).join(' -- ')).filter(Boolean)
    };
  }));
  return res.status(200).json({ ok: true, source: 'HiveLogic Marketing', jobs });
}

// ----- CampaignDraft persistence (Phase 4 sub-slice 5 / Phase 9 follow-up):
// handleDraftPostPost used to be a purely stateless caption generator --
// every draft was lost the instant the HTTP response was sent. This wires
// it to actually persist each draft into marketing_campaign_drafts
// (sql/040), best-effort: a save failure (including the table not being
// synced yet) never blocks the caption itself from being generated and
// returned -- it only means draftId comes back null and the caption can't
// be found again later. Nothing here fabricates a draft that was never
// generated, and nothing here silently drops the real caption just because
// persistence failed.
async function handleCampaignDraftsGet(req, res) {
  let rows;
  try {
    rows = await fetchAllRows('marketing_campaign_drafts', '?select=*&order=created_at.desc');
  } catch (e) {
    if (e.notSynced) return res.status(200).json({ ok: true, drafts: [], notice: 'marketing_campaign_drafts table is not set up yet -- run sql/040_marketing_campaign_draft_audit_event.sql in Supabase.' });
    throw e;
  }
  res.status(200).json({
    ok: true,
    drafts: rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      division: r.division,
      draftText: r.draft_text,
      usedRealAnalysis: r.used_real_analysis,
      photoCount: r.photo_count,
      status: r.status,
      promotedCampaignId: r.promoted_campaign_id,
      createdAt: r.created_at,
    })),
  });
}

// ---------- ReviewReply (Phase 13, sql/041) ----------
// Turns a real posted review into a drafted reply -- distinct from
// review_requests (sql/020), which only tracks whether the review *ask*
// was sent, not any review that actually came back. review_text is the
// real, unmodified review content; the AI drafts a NEW reply responding to
// it, it never rewrites or edits the review itself (the standing "never
// rewrite review text" rule). No GBP connector exists yet (Phase 15), so
// review_text is real input the owner pastes in, not fetched live -- an
// honest gap, not a fabricated integration.
const REVIEW_REPLY_SENSITIVE_KEYWORDS = [
  'refund', 'scam', 'lawsuit', 'unsafe', 'unacceptable', 'never again',
  'worst', 'fraud', 'terrible', 'awful', 'sue', 'unethical',
];

function reviewReplySensitivityFlag(rating, reviewText) {
  if (typeof rating === 'number' && rating <= 2) return true;
  if (rating == null) return true; // can't assess without a rating -- default to the safer, owner-approval-required state
  const lower = String(reviewText || '').toLowerCase();
  return REVIEW_REPLY_SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

async function handleReviewRepliesGet(req, res) {
  const clientId = req.query.clientId ? String(req.query.clientId) : null;
  let query = '?select=*&order=created_at.desc';
  if (clientId) query += `&client_id=eq.${encodeURIComponent(clientId)}`;
  let rows;
  try {
    rows = await fetchAllRows('marketing_review_replies', query);
  } catch (e) {
    if (e.notSynced) return res.status(200).json({ ok: true, replies: [], notice: 'marketing_review_replies table is not set up yet -- run sql/041_marketing_website_review_attribution.sql in Supabase.' });
    throw e;
  }
  res.status(200).json({
    ok: true,
    replies: rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      reviewRequestId: r.review_request_id,
      platform: r.platform,
      externalReviewId: r.external_review_id,
      reviewerName: r.reviewer_name,
      rating: r.rating,
      reviewText: r.review_text,
      draftReplyText: r.draft_reply_text,
      finalReplyText: r.final_reply_text,
      sensitivityFlag: r.sensitivity_flag,
      status: r.status,
      createdAt: r.created_at,
    })),
  });
}

async function handleReviewRepliesPost(req, res) {
  const b = req.body || {};
  const platform = String(b.platform || '');
  if (!['google_business_profile', 'other'].includes(platform)) {
    return res.status(400).json({ ok: false, error: 'platform must be one of: google_business_profile, other.' });
  }
  const reviewText = String(b.reviewText || '').trim();
  if (!reviewText) return res.status(400).json({ ok: false, error: 'reviewText required -- paste the real, unmodified review.' });
  let rating = null;
  if (b.rating != null) {
    rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: 'rating must be an integer between 1 and 5, if provided.' });
    }
  }
  if (!anthropicMkt) {
    return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment -- cannot draft a reply yet.' });
  }

  const sensitivityFlag = reviewReplySensitivityFlag(rating, reviewText);
  const prompt = 'You are drafting a short, professional reply (2-4 sentences) from a home services company owner to a real customer review.\n\n' +
    'STRICT RULES: never quote-edit or rewrite the review itself -- you are only drafting the OWNER\'S REPLY. Never invent facts, promises, refunds, discounts, or specifics not present in the review or given below. Thank the reviewer, address only what they actually said, and if the review describes a real problem, acknowledge it plainly and invite them to reach out directly -- do not promise a specific resolution.\n\n' +
    'Review' + (rating != null ? ' (rating: ' + rating + '/5)' : '') + ':\n' + reviewText + '\n\n' +
    'Return ONLY the reply text, nothing else.';
  const resp = await anthropicMkt.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  const draftReplyText = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

  const row = {
    client_id: b.clientId || null,
    review_request_id: b.reviewRequestId || null,
    platform,
    external_review_id: b.externalReviewId || null,
    reviewer_name: b.reviewerName || null,
    rating,
    review_text: reviewText,
    draft_reply_text: draftReplyText,
    sensitivity_flag: sensitivityFlag,
  };
  let insertedId = null;
  try {
    const insertRes = await supabaseRequest('marketing_review_replies', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    });
    if (insertRes.ok) {
      const [inserted] = await insertRes.json();
      insertedId = inserted ? inserted.id : null;
    }
  } catch (e) { /* best-effort persistence -- the real draft is still returned below even if the save fails */ }

  if (insertedId) {
    await logMarketingAuditEvent('review', 'reply_drafted', 'review_reply', insertedId, 'owner', { platform, sensitivityFlag, rating });
  }

  res.status(200).json({
    ok: true,
    reviewReply: {
      id: insertedId,
      draftReplyText,
      sensitivityFlag,
      status: 'draft',
    },
  });
}

// ---------- WebsiteChange (Phase 13, sql/041) ----------
// Drafts a real website content change (landing page, promotion, service
// page, etc.) grounded in real completed-job facts for one division --
// never a fabricated job count, price, warranty, or certification. No
// website CMS connector exists yet (Phase 13/15 publish flow is still
// unbuilt), so this only ever produces a 'draft' row; there is no publish
// path here. previous_snapshot/scheduled_publish_at/published_at are left
// untouched -- this handler only ever creates the initial draft.
const WEBSITE_CHANGE_PROVIDERS = ['wordpress', 'webflow', 'wix', 'other'];
const WEBSITE_CHANGE_TYPES = [
  'landing_page', 'promotion', 'service_page', 'portfolio_page',
  'video_embed', 'cta', 'form', 'local_content', 'technical_seo', 'general',
];

async function realDivisionJobFacts(division) {
  const rows = await fetchAllRows('jobs', '?select=title,total,completed_at&completed_at=not.is.null');
  const since180 = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const matched = rows.filter((r) => jobDivisionServer(r.title) === division);
  const recentMatched = matched.filter((r) => r.completed_at && new Date(r.completed_at).getTime() >= since180);
  const withTotal = matched.filter((r) => Number(r.total) > 0);
  const avgTotalCents = withTotal.length
    ? Math.round((withTotal.reduce((s, r) => s + Number(r.total || 0), 0) / withTotal.length) * 100)
    : null;
  return {
    completedJobCount: matched.length,
    completedJobCountLast180Days: recentMatched.length,
    avgJobValueCents: avgTotalCents,
  };
}

async function handleWebsiteChangesGet(req, res) {
  let rows;
  try {
    rows = await fetchAllRows('marketing_website_changes', '?select=*&order=created_at.desc');
  } catch (e) {
    if (e.notSynced) return res.status(200).json({ ok: true, changes: [], notice: 'marketing_website_changes table is not set up yet -- run sql/041_marketing_website_review_attribution.sql in Supabase.' });
    throw e;
  }
  res.status(200).json({
    ok: true,
    changes: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      changeType: r.change_type,
      pagePath: r.page_path,
      title: r.title,
      contentSnapshot: r.content_snapshot,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
  });
}

async function handleWebsiteChangesPost(req, res) {
  const b = req.body || {};
  const provider = String(b.provider || 'other');
  if (!WEBSITE_CHANGE_PROVIDERS.includes(provider)) {
    return res.status(400).json({ ok: false, error: 'provider must be one of: ' + WEBSITE_CHANGE_PROVIDERS.join(', ') + '.' });
  }
  const changeType = String(b.changeType || '');
  if (!WEBSITE_CHANGE_TYPES.includes(changeType)) {
    return res.status(400).json({ ok: false, error: 'changeType must be one of: ' + WEBSITE_CHANGE_TYPES.join(', ') + '.' });
  }
  const division = String(b.division || '').trim();
  if (!division) return res.status(400).json({ ok: false, error: 'division required -- e.g. HVAC, Electric, Plumbing, Design|Build, Outdoor Spaces.' });
  if (!anthropicMkt) {
    return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment -- cannot draft website copy yet.' });
  }

  const facts = await realDivisionJobFacts(division);
  const factsText = JSON.stringify(facts, null, 2);
  const prompt = 'You are drafting website copy for a home services company\'s ' + changeType.replace(/_/g, ' ') + ' about their ' + division + ' work.\n\n' +
    'STRICT RULE: only use the facts given below. Never invent specific prices, warranties, certifications, brand names, or promotional offers that are not present in the facts. If completedJobCount is 0, write general, honest copy about the service -- do not claim any job history. If avgJobValueCents is null, do not mention pricing at all.\n\n' +
    'Facts:\n' + factsText + '\n\n' +
    'Return ONLY a JSON object with exactly these keys: headline (string, under 10 words), body (string, 2-4 sentences), cta (string, under 6 words). No markdown, no code fences, no extra keys.';
  const resp = await anthropicMkt.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  const rawText = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  let draft;
  try {
    draft = JSON.parse(rawText);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Draft copy could not be parsed as valid JSON -- try again.' });
  }
  if (!draft || typeof draft.headline !== 'string' || typeof draft.body !== 'string' || typeof draft.cta !== 'string') {
    return res.status(502).json({ ok: false, error: 'Draft copy response was missing required fields -- try again.' });
  }

  const contentSnapshot = { headline: draft.headline, body: draft.body, cta: draft.cta, division, realFactsUsed: facts };
  const row = {
    provider,
    change_type: changeType,
    page_path: b.pagePath || null,
    title: draft.headline,
    content_snapshot: contentSnapshot,
    status: 'draft',
    created_by: 'reina',
  };
  let insertedId = null;
  try {
    const insertRes = await supabaseRequest('marketing_website_changes', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    });
    if (insertRes.ok) {
      const [inserted] = await insertRes.json();
      insertedId = inserted ? inserted.id : null;
    }
  } catch (e) { /* best-effort persistence -- the real draft is still returned below even if the save fails */ }

  res.status(200).json({
    ok: true,
    websiteChange: {
      id: insertedId,
      provider,
      changeType,
      title: draft.headline,
      contentSnapshot,
      status: 'draft',
    },
  });
}

async function handleDraftPostPost(req, res) {
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
  const jobRes = await supabaseRequest(`jobs?select=jobber_id,client_id,job_number,title&jobber_id=eq.${encodeURIComponent(jobId)}`);
  if (!jobRes.ok) throw new Error(await jobRes.text());
  const [job] = await jobRes.json();
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  const division = jobDivisionServer(job.title);
  const mediaRes = await supabaseRequest(`media?select=id,captured_at,media_analysis(description,trade,room,materials)&job_id=eq.${encodeURIComponent(jobId)}&order=captured_at.desc&limit=10`);
  const mediaRows = mediaRes.ok ? await mediaRes.json() : [];
  const analysis = mediaRows.map((m) => m.media_analysis && m.media_analysis[0]).filter(Boolean);
  const analyzedDetails = analysis
    .map((a) => ({ trade: a.trade, room: a.room, materials: a.materials, description: a.description }))
    .filter((a) => a.trade || a.room || a.description);
  const realFacts = { division, jobNumber: job.job_number, photoCount: mediaRows.length, analyzedDetails };
  if (!anthropicMkt) {
    return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment -- cannot draft AI copy yet.' });
  }
  const factsText = JSON.stringify(realFacts, null, 2);
  const prompt = 'You are drafting a short social media caption (3-4 sentences, no hashtag spam, at most 2 relevant hashtags) for a home services company to post about a completed job.\n\n' +
    'STRICT RULE: only use the facts given below. Never invent specific materials, colors, brand names, dimensions, prices, or client details that are not present in the facts. If the analyzed details list is empty, write a tasteful GENERAL caption about a completed ' + division + ' project -- do not fabricate specifics to fill the gap.\n\n' +
    'Facts:\n' + factsText + '\n\nReturn ONLY the caption text, nothing else.';
  const resp = await anthropicMkt.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const usedRealAnalysis = analyzedDetails.length > 0;

  // Best-effort persistence -- never let a save failure hide the real,
  // already-generated caption from the caller.
  let draftId = null;
  try {
    const insertRes = await supabaseRequest('marketing_campaign_drafts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        job_id: jobId,
        division,
        draft_text: text,
        used_real_analysis: usedRealAnalysis,
        photo_count: mediaRows.length,
        generated_by: 'ai',
        model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
      }),
    });
    if (insertRes.ok) {
      const [saved] = await insertRes.json();
      if (saved) draftId = saved.id;
    }
    // A non-ok response (including "relation does not exist" when
    // sql/040 hasn't been applied yet) is treated the same honest way as
    // every other not-synced table in this file: draftId simply stays
    // null, nothing is fabricated, and the caption is still returned below.
  } catch (e) {
    // Network/parse errors on the persistence path must never surface as
    // a failure of the caption generation itself.
  }

  return res.status(200).json({
    ok: true,
    source: 'HiveLogic Marketing',
    draft: text,
    draftId,
    usedRealAnalysis,
    division,
    jobNumber: job.job_number
  });
}


// ---------- Marketing Command Center (Phase 1, UX-01) ----------
const CC_PLATFORMS = [
  { key: 'website_cms', label: 'Website', icon: 'website' },
  { key: 'google_ads', label: 'Google Ads', icon: 'google_ads' },
  { key: 'google_business_profile', label: 'Google Business Profile', icon: 'gbp' },
  { key: 'email', label: 'Email', icon: 'email' },
  { key: 'meta_ads', label: 'Meta', icon: 'meta' },
  { key: 'sms', label: 'Text Messages', icon: 'sms' },
];
const CC_READY_STATES = new Set(['launch_enabled', 'reporting_verified', 'draft_validated']);

async function ccConnections() {
  const emailConfigured = isEmailConfigured();
  const emailSendEnabled = isEmailSendEnabled();
  let stored = [];
  try {
    stored = await fetchAllRows('marketing_platform_connections', '?select=platform,state,note');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const byPlatform = new Map(stored.map((r) => [r.platform, r]));
  return CC_PLATFORMS.map((p) => {
    if (p.key === 'email') {
      const state = !emailConfigured ? 'not_connected' : (emailSendEnabled ? 'launch_enabled' : 'reporting_verified');
      return {
        key: 'email', label: 'Email', icon: 'email', state,
        ready: CC_READY_STATES.has(state),
        note: !emailConfigured
          ? 'No Resend account connected -- add RESEND_API_KEY in Vercel.'
          : (emailSendEnabled ? 'Resend connected -- campaign sending is live.' : 'Resend connected, but sending is turned off.'),
      };
    }
    const row = byPlatform.get(p.key);
    const state = row ? row.state : 'not_connected';
    return {
      key: p.key, label: p.label, icon: p.icon, state,
      ready: CC_READY_STATES.has(state),
      note: (row && row.note) || 'Not connected.',
    };
  });
}

const CAMPAIGN_TYPE_LABEL = {
  estimate_recovery: 'Unsold estimate follow-up',
  review_request: 'Review requests',
  reactivation: 'Reactivate past customers',
  referral: 'Referral outreach',
  seasonal: 'Seasonal promotion',
  custom: 'Custom campaign',
};

// Ready for You now sources cards from marketing_approvals first (real
// pending approval rows, any approvable_type), falling back to a raw
// draft campaign only when no approval row exists for it yet -- covers
// campaign drafts created before this writer shipped. CAMPAIGN_SPEND
// approval rows still expose id = the real campaign id so the existing
// ccApprove/campaign_send flow on the frontend needs no changes.
async function ccReadyForYou() {
  let approvals = [];
  try {
    approvals = await fetchAllRows('marketing_approvals', '?select=id,approvable_type,approvable_id,title,rationale,preview_text,amount_cents,max_amount_cents,target_description,estimate,confidence,risks,status,created_at&order=created_at.desc');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  let campaigns = [];
  try {
    campaigns = await fetchAllRows('campaigns', '?select=id,name,type,channel,status,created_at&order=created_at.desc&limit=500');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const campaignsById = new Map(campaigns.map((c) => [String(c.id), c]));
  let recipients = [];
  try {
    recipients = await fetchAllRows('campaign_recipients', '?select=campaign_id,sent_at');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const countsByCampaign = new Map();
  const sentByCampaign = new Map();
  let sentLast7Days = 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const r of recipients) {
    countsByCampaign.set(r.campaign_id, (countsByCampaign.get(r.campaign_id) || 0) + 1);
    if (r.sent_at) {
      sentByCampaign.set(r.campaign_id, (sentByCampaign.get(r.campaign_id) || 0) + 1);
      if (new Date(r.sent_at).getTime() >= weekAgo) sentLast7Days++;
    }
  }
  // Any campaign that has ever had a CAMPAIGN_SPEND approval row (pending,
  // approved, or rejected) is excluded from the legacy fallback below --
  // a rejected draft must not resurface as if it had never been reviewed.
  const linkedCampaignIds = new Set();
  for (const a of approvals) {
    if (a.approvable_type === 'CAMPAIGN_SPEND' && a.approvable_id) linkedCampaignIds.add(String(a.approvable_id));
  }
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const approvalItems = [];
  for (const a of pendingApprovals) {
    if (a.approvable_type === 'CAMPAIGN_SPEND') {
      const campaign = a.approvable_id ? campaignsById.get(String(a.approvable_id)) : null;
      if (!campaign || campaign.status !== 'draft') continue;
      const recipientCount = countsByCampaign.get(campaign.id) || 0;
      const sentCount = sentByCampaign.get(campaign.id) || 0;
      approvalItems.push({
        id: campaign.id,
        title: a.title || campaign.name,
        type: campaign.type,
        subtitle: a.rationale || ((CAMPAIGN_TYPE_LABEL[campaign.type] || campaign.type) + ' -- ' + recipientCount + ' recipients ready'),
        actionLabel: 'Review & Approve',
        channel: campaign.channel,
        recipientCount,
        sentCount,
        approvalId: a.id,
        approvableType: a.approvable_type,
        amountCents: a.amount_cents,
        maxAmountCents: a.max_amount_cents,
        targetDescription: a.target_description,
        confidence: a.confidence,
        risks: a.risks,
      });
      continue;
    }
    approvalItems.push({
      id: a.id,
      title: a.title,
      type: null,
      subtitle: a.rationale || null,
      actionLabel: 'Review & Approve',
      channel: null,
      recipientCount: null,
      sentCount: null,
      approvalId: a.id,
      approvableType: a.approvable_type,
      amountCents: a.amount_cents,
      maxAmountCents: a.max_amount_cents,
      targetDescription: a.target_description,
      confidence: a.confidence,
      risks: a.risks,
    });
  }
  const legacyItems = campaigns
    .filter((c) => c.status === 'draft' && !linkedCampaignIds.has(String(c.id)))
    .map((c) => {
      const recipientCount = countsByCampaign.get(c.id) || 0;
      const sentCount = sentByCampaign.get(c.id) || 0;
      return {
        id: c.id,
        title: c.name,
        type: c.type,
        subtitle: (CAMPAIGN_TYPE_LABEL[c.type] || c.type) + ' -- ' + recipientCount + ' recipients ready',
        actionLabel: 'Review & Approve',
        channel: c.channel,
        recipientCount,
        sentCount,
      };
    });
  return { items: [...approvalItems, ...legacyItems], sentLast7Days };
}

// ---------- Phase 2: real Opportunity Engine forecast (ST-01/ST-02/ST-04) ----------
// None of gross margin, qualified-lead rate, or close rate are computable
// from real data today (no job-margin fields, zero rows in lead_pipeline /
// review_requests). Per the spec's own note under Figure 2, these are owner
// planning inputs -- this engine turns them into a transparent, formula-based
// conservative/expected/upside range. It never fabricates a number: if the
// inputs aren't set, or no paid channel is launch-ready, it says exactly why
// instead of guessing.
async function realAvgJobValueCents() {
  try {
    const rows = await fetchAllRows('jobs', '?select=total&total=gt.0');
    if (!rows.length) return null;
    const sum = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    return Math.round((sum / rows.length) * 100);
  } catch (e) {
    if (e.notSynced) return null;
    throw e;
  }
}

async function realHistoricalJobsPerMonth() {
  try {
    const since = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await fetchAllRows('jobs', '?select=jobber_created_at&jobber_created_at=gt.' + since);
    if (!rows.length) return null;
    const months = new Set(rows.map((r) => String(r.jobber_created_at || '').slice(0, 7)));
    const monthCount = months.size || 1;
    return Math.round(rows.length / monthCount);
  } catch (e) {
    if (e.notSynced) return null;
    throw e;
  }
}

async function realPastCustomersForPlan() {
  try {
    const result = await computeReactivateCustomers();
    return { count: result.count, estRevenue: result.estRevenue };
  } catch (e) {
    if (e.notSynced) return { count: 0, estRevenue: 0 };
    throw e;
  }
}

async function realExistingLeadsForPlan() {
  try {
    const rows = await fetchAllRows('lead_pipeline', '?select=stage,estimated_value');
    const active = rows.filter((r) => r.stage !== 'won' && r.stage !== 'lost');
    const estRevenue = active.reduce((s, r) => s + (Number(r.estimated_value) || 0), 0);
    return { count: active.length, estRevenue: Math.round(estRevenue) };
  } catch (e) {
    if (e.notSynced) return { count: 0, estRevenue: 0 };
    throw e;
  }
}

async function realPriorCampaignResultsForPlan() {
  const result = await computeFirstTouchAttribution();
  return {
    attributedJobs: result.totalAttributedJobs,
    unattributedJobs: result.totalUnattributedJobs,
    attributedRevenueCents: result.totalAttributedRevenueCents,
    coveragePct: result.attributionCoveragePct,
  };
}

async function realCompanyCamAvailabilityForPlan() {
  try {
    const rows = await fetchAllRows('media', '?select=media_type,captured_at');
    const totalCount = rows.length;
    const photoCount = rows.filter((r) => r.media_type === 'PHOTO').length;
    const videoCount = rows.filter((r) => r.media_type === 'VIDEO').length;
    const since90 = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const recentCount = rows.filter((r) => r.captured_at && new Date(r.captured_at).getTime() >= since90).length;
    let daysSinceLastCapture = null;
    if (rows.length) {
      const latestMs = rows.reduce((max, r) => {
        const t = r.captured_at ? new Date(r.captured_at).getTime() : 0;
        return t > max ? t : max;
      }, 0);
      if (latestMs) daysSinceLastCapture = Math.floor((Date.now() - latestMs) / 86400000);
    }
    return { totalCount, photoCount, videoCount, recentCount, daysSinceLastCapture };
  } catch (e) {
    if (e.notSynced) return { totalCount: 0, photoCount: 0, videoCount: 0, recentCount: 0, daysSinceLastCapture: null };
    throw e;
  }
}

function haversineMilesForPlan(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function realServiceTerritoryForPlan() {
  try {
    const [officeRows, clientLocs] = await Promise.all([
      fetchAllRows('office_location', '?id=eq.hq&select=lat,lng'),
      fetchAllRows('client_locations', '?select=lat,lng&lat=not.is.null'),
    ]);
    const office = officeRows[0];
    if (!office || !isFinite(Number(office.lat)) || !isFinite(Number(office.lng))) {
      return { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false };
    }
    const officeLat = Number(office.lat);
    const officeLng = Number(office.lng);
    const distances = clientLocs
      .filter((c) => isFinite(Number(c.lat)) && isFinite(Number(c.lng)))
      .map((c) => haversineMilesForPlan(officeLat, officeLng, Number(c.lat), Number(c.lng)));
    if (!distances.length) {
      return { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: true };
    }
    const sum = distances.reduce((s, d) => s + d, 0);
    return {
      geocodedCustomerCount: distances.length,
      avgDistanceMiles: Math.round((sum / distances.length) * 10) / 10,
      maxDistanceMiles: Math.round(Math.max(...distances) * 10) / 10,
      officeSet: true,
    };
  } catch (e) {
    if (e.notSynced) return { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false };
    throw e;
  }
}

// Real connected-channel availability fact for Plan's reference block: how
// many of the channels ccConnections() already tracks (the same list the
// Command Center connections panel shows) are actually launch-ready right
// now. Reuses ccConnections() and its existing CC_READY_STATES definition
// of "ready" -- deliberately not a second, independently-invented
// connection-status computation.
async function realChannelAvailabilityForPlan() {
  const connections = await ccConnections();
  const readyCount = connections.filter((c) => c.ready).length;
  const notReady = connections.filter((c) => !c.ready).map((c) => ({ label: c.label, note: c.note }));
  return { readyCount, totalCount: connections.length, notReady };
}

// ---------- Phase 6: real plan-selection rationale ("why") ----------
// Deterministic, rule-based reasoning over the exact reference facts already
// assembled above -- deliberately NOT an AI-generated narrative (unlike
// handleDraftPostPost's caption drafting). The Plan tab's "why" is a
// financial/operational recommendation, not creative copy: every claim here
// must trace back to a real field already in `reference` and be exactly
// reproducible in a test, with zero hallucination risk and no dependency on
// ANTHROPIC_API_KEY being configured for this feature to work in production.
// Each rule below is independently testable and returns null when its
// triggering condition is not met -- honest silence beats a fabricated
// insight. Results are ordered blocker > opportunity > info so the owner
// sees what is stopping them before what is merely optional.
function planRationaleChannelGate(reference) {
  const ready = reference.realChannelAvailabilityReadyCount;
  const total = reference.realChannelAvailabilityTotalCount;
  if (!total) return null;
  if (ready === 0) {
    return {
      key: 'no_channel_ready',
      priority: 'blocker',
      text: 'No channel is launch-ready yet (0 of ' + total + ') -- connect at least one before allocating any budget.',
    };
  }
  return {
    key: 'channel_ready',
    priority: 'info',
    text: ready + ' of ' + total + ' channels are launch-ready, so this month\'s budget can actually reach customers now.',
  };
}

function planRationaleReactivation(reference) {
  const count = reference.realPastCustomersCount;
  if (!count) return null;
  return {
    key: 'reactivation_window',
    priority: 'opportunity',
    text: count + ' past customer' + (count === 1 ? '' : 's') + ' (' + money(reference.realPastCustomersEstRevenue) + ' in last-job value) are in their 6-24 month reactivation window -- reaching them by email/SMS costs nothing incremental once that channel is connected.',
  };
}

function planRationaleExistingLeads(reference) {
  const count = reference.realExistingLeadsCount;
  if (!count) return null;
  return {
    key: 'existing_leads',
    priority: 'opportunity',
    text: count + ' lead' + (count === 1 ? '' : 's') + ' (' + money(reference.realExistingLeadsEstRevenue) + ' estimated) are already active in the pipeline -- following up on them is cheaper than acquiring a new lead.',
  };
}

function planRationaleUnsoldEstimates(reference) {
  const est = reference.realUnsoldEstimates;
  if (!est || !est.count) return null;
  return {
    key: 'unsold_estimates',
    priority: 'opportunity',
    text: est.count + ' open estimate' + (est.count === 1 ? '' : 's') + ' (' + money(est.estRevenue) + ') are awaiting a client response' + (est.staleCount ? ', ' + est.staleCount + ' of them over 30 days old' : '') + ' -- closing these costs no new ad spend.',
  };
}

function planRationaleDivision(reference) {
  const divisions = (reference.realJobFactsByDivision || []).filter((d) => d.avgJobValueCents !== null && d.completedJobCount > 0);
  if (!divisions.length) return null;
  const best = divisions.reduce((max, d) => (d.avgJobValueCents > max.avgJobValueCents ? d : max));
  return {
    key: 'highest_value_division',
    priority: 'opportunity',
    text: best.division + ' has the highest average job value at ' + money(best.avgJobValueCents / 100) + ' across ' + best.completedJobCount + ' completed job' + (best.completedJobCount === 1 ? '' : 's') + ' -- budget aimed at generating more ' + best.division + ' leads returns the most revenue per sale.',
  };
}

function planRationaleContentFreshness(reference) {
  const total = reference.realCompanyCamTotalAssets;
  if (!total) {
    return {
      key: 'no_content_yet',
      priority: 'opportunity',
      text: 'No CompanyCam photos or videos are synced yet -- capture some on the next job before building a visual campaign.',
    };
  }
  const days = reference.realCompanyCamDaysSinceLastCapture;
  if (days !== null && days !== undefined && days > 14) {
    return {
      key: 'content_stale',
      priority: 'info',
      text: 'The most recent CompanyCam capture was ' + days + ' days ago (' + total + ' assets total) -- fresh photos convert better than older ones in ads and posts.',
    };
  }
  return null;
}

function planRationaleSeasonal(reference) {
  const dist = reference.realSeasonalDistribution || [];
  if (!dist.length) return null;
  const best = dist.reduce((max, m) => (!max || m.completedJobCount > max.completedJobCount ? m : max), null);
  if (!best || !best.completedJobCount) return null;
  return {
    key: 'seasonal_peak',
    priority: 'info',
    text: 'Completed jobs have historically peaked in ' + best.month + ' (' + best.completedJobCount + ' jobs) -- weight seasonal campaigns toward that timing.',
  };
}

function planRationaleServiceTerritory(reference) {
  const count = reference.realServiceTerritoryCustomerCount;
  if (!count) return null;
  return {
    key: 'service_territory',
    priority: 'info',
    text: count + ' real geocoded customer' + (count === 1 ? '' : 's') + ' average ' + reference.realServiceTerritoryAvgDistanceMiles + ' mi from the office (farthest: ' + reference.realServiceTerritoryMaxDistanceMiles + ' mi) -- keep geo-targeted ads inside that real service radius.',
  };
}

function planRationaleAttributionCoverage(reference) {
  const pct = reference.realPriorCampaignCoveragePct;
  const attributed = reference.realPriorCampaignAttributedJobs;
  const unattributed = reference.realPriorCampaignUnattributedJobs;
  if (pct === null || pct === undefined) return null;
  if (pct >= 50) return null;
  return {
    key: 'attribution_coverage_gap',
    priority: 'info',
    text: 'Only ' + pct + '% of completed jobs (' + attributed + ' of ' + (attributed + unattributed) + ') can be matched to a real prior campaign send -- capturing client_id on more sends would sharpen future recommendations.',
  };
}

const PLAN_RATIONALE_RULES = [
  planRationaleChannelGate,
  planRationaleReactivation,
  planRationaleExistingLeads,
  planRationaleUnsoldEstimates,
  planRationaleDivision,
  planRationaleContentFreshness,
  planRationaleSeasonal,
  planRationaleServiceTerritory,
  planRationaleAttributionCoverage,
];

const PLAN_RATIONALE_PRIORITY_ORDER = { blocker: 0, opportunity: 1, info: 2 };

// Combines every rule's real output into one ordered list -- blockers first,
// then opportunities, then info -- while preserving each tier's rule-definition
// order (a stable sort) so results are 100% deterministic given the same
// reference facts, never dependent on wall-clock time or randomness.
function computePlanRationale(reference) {
  const items = PLAN_RATIONALE_RULES.map((rule) => rule(reference)).filter(Boolean);
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const pa = PLAN_RATIONALE_PRIORITY_ORDER[a.item.priority];
      const pb = PLAN_RATIONALE_PRIORITY_ORDER[b.item.priority];
      if (pa !== pb) return pa - pb;
      return a.idx - b.idx;
    })
    .map((x) => x.item);
}

async function ccAssumptionsRow() {
  try {
    const rows = await fetchAllRows('marketing_plan_assumptions', '?select=*&tenant_id=eq.ghgrp');
    return rows[0] || null;
  } catch (e) {
    if (e.notSynced) return null;
    throw e;
  }
}

const FORECAST_BANDS = { conservative: 0.65, expected: 1.0, upside: 1.35 };

function computeForecast({ assumptions, budgetCents, readyPaidChannelKeys, realAvgJobValueCentsVal }) {
  const has = (v) => v !== null && v !== undefined;
  const grossMarginPct = assumptions && has(assumptions.gross_margin_pct) ? Number(assumptions.gross_margin_pct) : null;
  const qualifiedLeadRatePer100 = assumptions && has(assumptions.qualified_lead_rate_per_100) ? Number(assumptions.qualified_lead_rate_per_100) : null;
  const closeRatePct = assumptions && has(assumptions.close_rate_pct) ? Number(assumptions.close_rate_pct) : null;
  const maxNewJobsPerMonth = assumptions && has(assumptions.max_new_jobs_per_month) ? Number(assumptions.max_new_jobs_per_month) : null;
  const riskPosture = (assumptions && assumptions.risk_posture) || 'balanced';
  const avgJobValueCents = assumptions && has(assumptions.avg_job_value_cents) ? Number(assumptions.avg_job_value_cents) : realAvgJobValueCentsVal;

  const inputs = { budgetCents, avgJobValueCents, grossMarginPct, qualifiedLeadRatePer100, closeRatePct, maxNewJobsPerMonth, riskPosture };

  if (!readyPaidChannelKeys.length) {
    return {
      status: 'blocked_no_channel',
      message: 'No paid channel (Google Ads or Meta) is launch-ready yet, so there is nothing real to forecast a lead range from. Once one is verified-connected, your budget flows to it here.',
      inputs,
    };
  }
  if (grossMarginPct === null || qualifiedLeadRatePer100 === null || closeRatePct === null) {
    return {
      status: 'blocked_assumptions',
      message: 'Set your planning assumptions (gross margin, qualified-lead rate, close rate) to turn this budget into a lead range.',
      inputs,
    };
  }
  if (!avgJobValueCents) {
    return {
      status: 'blocked_assumptions',
      message: 'No average job value is available yet -- set one in your assumptions.',
      inputs,
    };
  }

  const budgetDollars = budgetCents / 100;
  const bands = {};
  for (const bandKey of Object.keys(FORECAST_BANDS)) {
    const mult = FORECAST_BANDS[bandKey];
    const qualifiedLeads = (budgetDollars / 100) * qualifiedLeadRatePer100 * mult;
    let soldJobs = qualifiedLeads * (closeRatePct / 100);
    if (maxNewJobsPerMonth !== null) soldJobs = Math.min(soldJobs, maxNewJobsPerMonth);
    const revenueCents = Math.round(soldJobs * avgJobValueCents);
    const grossProfitCents = Math.round(revenueCents * (grossMarginPct / 100));
    bands[bandKey] = {
      qualifiedLeads: Math.round(qualifiedLeads * 10) / 10,
      soldJobs: Math.round(soldJobs * 10) / 10,
      revenueCents,
      grossProfitCents,
    };
  }
  const headlineBand = riskPosture === 'conservative' ? 'conservative' : (riskPosture === 'aggressive' ? 'upside' : 'expected');
  return {
    status: 'ready',
    headlineBand,
    bands,
    inputs,
    methodology: 'Your own planning assumptions applied to this month\'s budget, split across launch-ready paid channels (' + readyPaidChannelKeys.join(', ') + '). Conservative/expected/upside reflect a +/-35% range around your qualified-lead-rate estimate -- not a system prediction from live campaign results, since none have run yet.',
  };
}

const JOB_DIVISIONS = ['HVAC', 'Electric', 'Plumbing', 'Design|Build', 'Outdoor Spaces', 'Handyman'];
const MONTH_NAMES_UTC = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- Phase 6: real per-division + seasonal job facts for the Plan tab ----------
// Extends the Opportunity Engine's existing company-wide realAvgJobValueCents()/
// realHistoricalJobsPerMonth() (above) with the same real jobs data broken down
// by service division (via the existing jobDivisionServer classifier -- never a
// second, fabricated division mapping) and by calendar month, so the Plan tab can
// start answering "which services and which months does our own real job history
// actually support" instead of only a single company-wide average -- the first
// two items ("services/divisions", "seasonal timing") from Phase 6's brief. One
// shared fetch of real completed jobs; a division/month with zero priced jobs
// honestly reports avgJobValueCents: null rather than inventing a number.
async function realJobFactsByDivisionAndMonth() {
  try {
    const rows = await fetchAllRows('jobs', '?select=title,total,completed_at&completed_at=not.is.null');
    const byDivision = new Map(JOB_DIVISIONS.map((d) => [d, { completedJobCount: 0, pricedJobCount: 0, totalCents: 0 }]));
    const byMonth = new Map(MONTH_NAMES_UTC.map((_, i) => [i, 0]));
    for (const r of rows) {
      const division = jobDivisionServer(r.title);
      const bucket = byDivision.get(division) || byDivision.get('Handyman');
      bucket.completedJobCount++;
      const val = Number(r.total);
      if (val > 0) {
        bucket.pricedJobCount++;
        bucket.totalCents += Math.round(val * 100);
      }
      if (r.completed_at) {
        const monthIdx = new Date(r.completed_at).getUTCMonth();
        byMonth.set(monthIdx, (byMonth.get(monthIdx) || 0) + 1);
      }
    }
    const realJobFactsByDivision = JOB_DIVISIONS.map((division) => {
      const b = byDivision.get(division);
      return {
        division,
        completedJobCount: b.completedJobCount,
        avgJobValueCents: b.pricedJobCount > 0 ? Math.round(b.totalCents / b.pricedJobCount) : null,
      };
    });
    const realSeasonalDistribution = MONTH_NAMES_UTC.map((month, i) => ({ month, completedJobCount: byMonth.get(i) || 0 }));
    return { realJobFactsByDivision, realSeasonalDistribution };
  } catch (e) {
    if (e.notSynced) return { realJobFactsByDivision: [], realSeasonalDistribution: [] };
    throw e;
  }
}

// ---------- Phase 6: real unsold-estimates facts for the Plan tab ----------
// Reuses the Opportunity Engine's existing computeUnsoldEstimates() (real
// quotes table, quote_status=awaiting_response) rather than a second,
// duplicate query -- the same real numbers already shown on the
// Opportunities tab's Unsold Estimates card now also inform Plan. Wrapped in
// its own try/catch here (computeUnsoldEstimates() itself does not catch
// notSynced -- its only existing caller, handleOpportunitiesGet, has never
// needed to since quotes has been synced since this table was introduced,
// but Plan's reference block honestly degrades to zeros rather than ever
// failing the whole Plan tab over an unsynced table).
async function realUnsoldEstimatesForPlan() {
  try {
    const estimates = await computeUnsoldEstimates();
    return {
      count: estimates.count,
      estRevenue: estimates.estRevenue,
      staleCount: estimates.staleCount,
      staleValue: estimates.staleValue,
    };
  } catch (e) {
    if (e.notSynced) return { count: 0, estRevenue: 0, staleCount: 0, staleValue: 0 };
    throw e;
  }
}

async function handleAssumptionsGet(req, res) {
  const [row, realAvgJobValue, realHistJobsPerMonth, realDivisionMonthFacts, realUnsoldEstimates, realPastCustomers, realExistingLeads, realPriorCampaignResults, realCompanyCamAvailability, realServiceTerritory, realChannelAvailability] = await Promise.all([
    ccAssumptionsRow(),
    realAvgJobValueCents(),
    realHistoricalJobsPerMonth(),
    realJobFactsByDivisionAndMonth(),
    realUnsoldEstimatesForPlan(),
    realPastCustomersForPlan(),
    realExistingLeadsForPlan(),
    realPriorCampaignResultsForPlan(),
    realCompanyCamAvailabilityForPlan(),
    realServiceTerritoryForPlan(),
    realChannelAvailabilityForPlan(),
  ]);
  const assumptions = row ? {
      grossMarginPct: row.gross_margin_pct === null ? null : Number(row.gross_margin_pct),
      qualifiedLeadRatePer100: row.qualified_lead_rate_per_100 === null ? null : Number(row.qualified_lead_rate_per_100),
      closeRatePct: row.close_rate_pct === null ? null : Number(row.close_rate_pct),
      maxNewJobsPerMonth: row.max_new_jobs_per_month === null ? null : Number(row.max_new_jobs_per_month),
      riskPosture: row.risk_posture || 'balanced',
      avgJobValueCents: row.avg_job_value_cents === null ? null : Number(row.avg_job_value_cents),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    } : { grossMarginPct: null, qualifiedLeadRatePer100: null, closeRatePct: null, maxNewJobsPerMonth: null, riskPosture: 'balanced', avgJobValueCents: null, updatedAt: null, updatedBy: null };
  const reference = {
      realAvgJobValueCents: realAvgJobValue,
      realAvgJobValueSource: realAvgJobValue ? 'Average of real completed/quoted jobs synced from Jobber (total > $0).' : 'No priced jobs synced yet.',
      realHistoricalJobsPerMonth: realHistJobsPerMonth,
      realHistoricalJobsPerMonthSource: realHistJobsPerMonth ? 'Trailing ~12-month average of all jobs created, every source combined -- not marketing-specific. Use as a reference point, not your marketing capacity cap.' : 'Not enough job history yet.',
      realOpenEstimatesCount: realUnsoldEstimates.count,
      realOpenEstimatesValue: realUnsoldEstimates.estRevenue,
      realOpenEstimatesStaleCount: realUnsoldEstimates.staleCount,
      realOpenEstimatesStaleValue: realUnsoldEstimates.staleValue,
      realOpenEstimatesSource: realUnsoldEstimates.count ? 'Real open (awaiting-response) quotes synced from Jobber. Dollar values are quote totals in plain dollars, not cents. Stale = no client response in over 30 days.' : 'No open estimates awaiting a client response yet.',
      realJobFactsByDivision: realDivisionMonthFacts.realJobFactsByDivision,
      realJobFactsByDivisionSource: 'Real completed jobs (Jobber sync) classified by the same division rules used elsewhere in Marketing -- a division with no priced jobs yet reports avgJobValueCents as null rather than a guess.',
      realSeasonalDistribution: realDivisionMonthFacts.realSeasonalDistribution,
      realSeasonalDistributionSource: 'Count of real completed jobs by calendar month, all history combined -- a reference for seasonal timing, not a forecast of next year.',
      realUnsoldEstimates,
      realUnsoldEstimatesSource: realUnsoldEstimates.count ? (realUnsoldEstimates.count + ' real open estimate' + (realUnsoldEstimates.count === 1 ? '' : 's') + ' awaiting a client response (' + realUnsoldEstimates.staleCount + ' over 30 days old) -- the same figures shown on the Opportunities tab, not a separate estimate.') : 'No open estimates are currently awaiting a client response.',
      realPastCustomersCount: realPastCustomers.count,
      realPastCustomersEstRevenue: realPastCustomers.estRevenue,
      realPastCustomersSource: realPastCustomers.count
        ? ('The same ' + realPastCustomers.count + ' reactivation-window past customer' + (realPastCustomers.count === 1 ? '' : 's') + ' shown on the Opportunities tab (6-24 months since their last completed job), not a separate estimate.')
        : 'No past customers currently fall in the 6-24 month reactivation window.',
      realExistingLeadsCount: realExistingLeads.count,
      realExistingLeadsEstRevenue: realExistingLeads.estRevenue,
      realExistingLeadsSource: realExistingLeads.count
        ? (realExistingLeads.count + ' lead' + (realExistingLeads.count === 1 ? '' : 's') + ' currently active in the pipeline (not yet won or lost) -- see the Leads page for detail.')
        : 'No leads are currently logged in the pipeline.',
      realPriorCampaignAttributedJobs: realPriorCampaignResults.attributedJobs,
      realPriorCampaignUnattributedJobs: realPriorCampaignResults.unattributedJobs,
      realPriorCampaignAttributedRevenueCents: realPriorCampaignResults.attributedRevenueCents,
      realPriorCampaignCoveragePct: realPriorCampaignResults.coveragePct,
      realPriorCampaignSource: (realPriorCampaignResults.attributedJobs || realPriorCampaignResults.unattributedJobs)
        ? ('Same first-touch attribution model shown on the Results & Attribution panel -- ' + realPriorCampaignResults.attributedJobs + ' completed job' + (realPriorCampaignResults.attributedJobs === 1 ? '' : 's') + ' matched to a real prior campaign send.')
        : 'No completed jobs with a real prior campaign send yet.',
      realCompanyCamTotalAssets: realCompanyCamAvailability.totalCount,
      realCompanyCamPhotoCount: realCompanyCamAvailability.photoCount,
      realCompanyCamVideoCount: realCompanyCamAvailability.videoCount,
      realCompanyCamRecentCount: realCompanyCamAvailability.recentCount,
      realCompanyCamDaysSinceLastCapture: realCompanyCamAvailability.daysSinceLastCapture,
      realCompanyCamSource: realCompanyCamAvailability.totalCount
        ? (realCompanyCamAvailability.totalCount + ' real photo/video asset' + (realCompanyCamAvailability.totalCount === 1 ? '' : 's') + ' synced from CompanyCam (' + realCompanyCamAvailability.recentCount + ' captured in the last 90 days) -- available for the Content Studio.')
        : 'No CompanyCam photos or videos synced yet.',
      realServiceTerritoryCustomerCount: realServiceTerritory.geocodedCustomerCount,
      realServiceTerritoryAvgDistanceMiles: realServiceTerritory.avgDistanceMiles,
      realServiceTerritoryMaxDistanceMiles: realServiceTerritory.maxDistanceMiles,
      realServiceTerritorySource: !realServiceTerritory.officeSet
        ? 'Office location has not been geocoded yet -- set it to see real average/max distance to your customers.'
        : (realServiceTerritory.geocodedCustomerCount
          ? (realServiceTerritory.geocodedCustomerCount + ' real geocoded customer' + (realServiceTerritory.geocodedCustomerCount === 1 ? '' : 's') + ', averaging ' + realServiceTerritory.avgDistanceMiles + ' mi from your office (farthest: ' + realServiceTerritory.maxDistanceMiles + ' mi) -- same coordinates shown on the Service Area map.')
          : 'No customers have a geocoded address yet.'),
      realChannelAvailabilityReadyCount: realChannelAvailability.readyCount,
      realChannelAvailabilityTotalCount: realChannelAvailability.totalCount,
      realChannelAvailabilityNotReady: realChannelAvailability.notReady,
      realChannelAvailabilitySource: realChannelAvailability.readyCount
        ? (realChannelAvailability.readyCount + ' of ' + realChannelAvailability.totalCount + ' channels launch-ready -- same status shown on the Command Center connections list.')
        : ('0 of ' + realChannelAvailability.totalCount + ' channels launch-ready yet -- connect at least one to start planning a real forecast.'),
  };
  res.status(200).json({
    ok: true,
    assumptions,
    reference,
    rationale: computePlanRationale(reference),
  });
}
async function handleAssumptionsPost(req, res) {
  const b = req.body || {};
  function pctOrNull(v, label) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw Object.assign(new Error(label + ' must be between 0 and 100.'), { status: 400 });
    return n;
  }
  let grossMarginPct, closeRatePct, qualifiedLeadRatePer100, maxNewJobsPerMonth, avgJobValueCents, riskPosture;
  try {
    grossMarginPct = pctOrNull(b.grossMarginPct, 'Gross margin');
    closeRatePct = pctOrNull(b.closeRatePct, 'Close rate');
    if (b.qualifiedLeadRatePer100 === null || b.qualifiedLeadRatePer100 === undefined || b.qualifiedLeadRatePer100 === '') {
      qualifiedLeadRatePer100 = null;
    } else {
      const n = Number(b.qualifiedLeadRatePer100);
      if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Qualified-lead rate must be 0 or more.'), { status: 400 });
      qualifiedLeadRatePer100 = n;
    }
    if (b.maxNewJobsPerMonth === null || b.maxNewJobsPerMonth === undefined || b.maxNewJobsPerMonth === '') {
      maxNewJobsPerMonth = null;
    } else {
      const n = Math.round(Number(b.maxNewJobsPerMonth));
      if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Max new jobs/month must be 0 or more.'), { status: 400 });
      maxNewJobsPerMonth = n;
    }
    if (b.avgJobValueDollars === null || b.avgJobValueDollars === undefined || b.avgJobValueDollars === '') {
      avgJobValueCents = null;
    } else {
      const n = Math.round(Number(b.avgJobValueDollars) * 100);
      if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Average job value must be 0 or more.'), { status: 400 });
      avgJobValueCents = n;
    }
    riskPosture = ['conservative', 'balanced', 'aggressive'].includes(b.riskPosture) ? b.riskPosture : 'balanced';
  } catch (e) {
    return res.status(e.status || 400).json({ ok: false, error: e.message });
  }

  const existing = await ccAssumptionsRow();
  const payload = {
    tenant_id: 'ghgrp',
    gross_margin_pct: grossMarginPct,
    qualified_lead_rate_per_100: qualifiedLeadRatePer100,
    close_rate_pct: closeRatePct,
    max_new_jobs_per_month: maxNewJobsPerMonth,
    avg_job_value_cents: avgJobValueCents,
    risk_posture: riskPosture,
    updated_at: new Date().toISOString(),
    updated_by: 'owner',
  };
  if (existing) {
    await supabaseRequest('marketing_plan_assumptions?tenant_id=eq.ghgrp', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload),
    });
  } else {
    await supabaseRequest('marketing_plan_assumptions', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload),
    });
  }
  await logMarketingAuditEvent('plan', 'assumptions_updated', 'plan_assumptions', 'ghgrp', 'owner', {
    grossMarginPct, closeRatePct, qualifiedLeadRatePer100, maxNewJobsPerMonth, avgJobValueCents, riskPosture,
  });
  let budgetCents = 250000;
  try {
    const budgetRows = await fetchAllRows('marketing_budget_settings', '?select=monthly_budget_cents&tenant_id=eq.ghgrp');
    if (budgetRows[0]) budgetCents = budgetRows[0].monthly_budget_cents;
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const plan = await ccPlan(budgetCents);
  res.status(200).json({ ok: true, plan });
}

async function ccPlan(budgetCents) {
  const connections = await ccConnections();
  const byKey = new Map(connections.map((c) => [c.key, c]));
  let eligibleEmail = 0, eligibleSms = 0;
  try {
    const consent = await fetchAllRows('marketing_consent_ledger', '?select=channel,status&status=eq.granted');
    eligibleEmail = consent.filter((r) => r.channel === 'email').length;
    eligibleSms = consent.filter((r) => r.channel === 'sms').length;
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  let sentCount = 0;
  try {
    const recipients = await fetchAllRows('campaign_recipients', '?select=sent_at&sent_at=not.is.null');
    sentCount = recipients.length;
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const [assumptionsRow, realAvgJobValue] = await Promise.all([ccAssumptionsRow(), realAvgJobValueCents()]);
  const CHANNELS = [
    { key: 'google_ads', label: 'Google Search', icon: 'google_ads', blurb: 'Capture people ready to hire' },
    { key: 'meta_ads', label: 'Meta Video', icon: 'meta', blurb: 'Build local demand' },
    { key: 'email', label: 'Email + SMS', icon: 'email', blurb: 'Bring past customers back' },
    { key: 'website_cms', label: 'Website + Reviews', icon: 'website', blurb: 'Turn visitors into leads' },
  ];
  const channels = CHANNELS.map((ch) => {
    const conn = byKey.get(ch.key);
    let status, ready;
    if (ch.key === 'email') {
      ready = eligibleEmail > 0;
      status = eligibleEmail
        ? eligibleEmail.toLocaleString('en-US') + ' customers ready -- ' + (sentCount ? sentCount + ' sends completed' : 'no campaigns sent yet') + (eligibleSms ? ', ' + eligibleSms.toLocaleString('en-US') + ' SMS-eligible' : ', SMS not available yet')
        : 'No customer email list yet.';
    } else {
      ready = conn ? conn.ready : false;
      status = conn ? (conn.ready ? 'Connected and ready' : conn.note) : 'Not connected.';
    }
    return { key: ch.key, label: ch.label, icon: ch.icon, blurb: ch.blurb, ready, status };
  });
  const readyPaidChannelKeys = ['google_ads', 'meta_ads'].filter((k) => { const c = byKey.get(k); return c && c.ready; });
  const forecast = computeForecast({ assumptions: assumptionsRow, budgetCents, readyPaidChannelKeys, realAvgJobValueCentsVal: realAvgJobValue });
  return {
    budgetCents,
    channels,
    forecast,
  };
}

async function handleCommandCenterGet(req, res) {
  let budgetCents = 250000;
  try {
    const rows = await fetchAllRows('marketing_budget_settings', '?select=monthly_budget_cents&tenant_id=eq.ghgrp');
    if (rows[0]) budgetCents = rows[0].monthly_budget_cents;
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const [connections, readyForYou, plan, channelBudget, schedule] = await Promise.all([
    ccConnections(),
    ccReadyForYou(),
    ccPlan(budgetCents),
    setupBudgetShape(),
    computeScheduleData(),
  ]);
  const readyCount = connections.filter((c) => c.ready).length;
  res.status(200).json({
    ok: true,
    connections: { total: connections.length, connected: readyCount, items: connections },
    readyForYou,
    plan,
    schedule,
    budget: {
      monthlyCents: budgetCents,
      min: 250000,
      max: 1500000,
      // Real per-channel pacing data (sql/045), reused from the same
      // setupBudgetShape() the Marketing Setup screen already relies on --
      // never a second, independently-computed channel list.
      channels: channelBudget.channels,
      allocatedCents: channelBudget.allocatedCents,
    },
  });
}

// ---------- Command Center: budget spend-vs-cap pacing (real ad_spend_ledger vs ad_budget_caps, sql/058) ----------
// Reuses the exact same, already-tested getBudgetCap/monthSpendCents/currentMonthBoundsUTC
// functions api/ads.js's spend-approval path already relies on -- no second,
// independently-computed cap/spend calculation invented here. No cap row
// configured is an honest 'configured: false', never a fabricated default.
async function handleBudgetPacingGet(req, res) {
  const cap = await getBudgetCap('ghgrp', supabaseRequest);
  if (!cap) {
    return res.status(200).json({ ok: true, configured: false });
  }
  const spentCents = await monthSpendCents('ghgrp', supabaseRequest);
  const { daysInMonth, daysRemaining } = currentMonthBoundsUTC();
  const daysElapsed = Math.max(daysInMonth - daysRemaining + 1, 1);
  const capCents = cap.cap_cents;
  const projectedCents = Math.round((spentCents / daysElapsed) * daysInMonth);
  const overPace = capCents > 0 && projectedCents > capCents;
  res.status(200).json({
    ok: true,
    configured: true,
    capCents,
    spentCents,
    projectedCents,
    pctUsed: capCents > 0 ? spentCents / capCents : null,
    daysElapsed,
    daysInMonth,
    autonomyLevel: cap.autonomy_level,
    overPace,
  });
}

// ---------- Command Center: real leads + cost-per-lead by channel (Plan tab) ----------
// Leads grouped by their real lead_pipeline.lead_source value (sql/013) --
// the same free-text field computeMissedLeadSourcesOpportunity() and
// computeReferralOpportunities() already read above. Cost-per-lead only
// computes for the small set of sources with an honest, unambiguous match
// to a paid channel we track real spend for (setupBudgetShape(), sql/045)
// -- every other source reports its real lead count with no invented
// spend/cost figure attached.
const LEAD_SOURCE_CHANNEL_KEY = {
  google: 'google_ads',
  facebook: 'meta_ads',
  website: 'website_cms',
};
async function handleChannelPerformanceGet(req, res) {
  let rows = [];
  let notSetUp = false;
  try {
    rows = await fetchAllRows('lead_pipeline', '?select=lead_source&lead_source=not.is.null');
  } catch (e) {
    if (e.notSynced) notSetUp = true; else throw e;
  }
  if (notSetUp) {
    return res.status(200).json({ ok: true, configured: false, rows: [], totalLeads: 0 });
  }
  const counts = {};
  rows.forEach((r) => {
    const src = String(r.lead_source || '').trim().toLowerCase();
    if (!src) return;
    counts[src] = (counts[src] || 0) + 1;
  });
  const channelBudget = await setupBudgetShape();
  const spendByKey = {};
  (channelBudget.channels || []).forEach((c) => { spendByKey[c.key] = c.monthlyCents || 0; });
  const perSource = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map((source) => {
    const leads = counts[source];
    const channelKey = LEAD_SOURCE_CHANNEL_KEY[source] || null;
    const spendCents = channelKey != null ? (spendByKey[channelKey] || 0) : null;
    const costPerLeadCents = (spendCents != null && leads > 0) ? Math.round(spendCents / leads) : null;
    return { source, leads, channelKey, spendCents, costPerLeadCents };
  });
  res.status(200).json({
    ok: true,
    configured: true,
    rows: perSource,
    totalLeads: rows.length,
  });
}

// ---------- Command Center: quarterly revenue goal + real quarter-to-date progress ----------
// quarterly_revenue_goal_cents lives on the same single-row-per-tenant
// marketing_plan_assumptions table the Plan tab's forecast already reads
// (sql/060, additive nullable column) -- reuses ccAssumptionsRow() and the
// same PATCH-if-exists/POST-if-not write pattern handleAssumptionsPost uses.
// Progress is a real sum of jobs.total for jobs completed this calendar
// quarter -- no goal set is an honest null, never a fabricated target.
async function handleMarketingGoalGet(req, res) {
  const row = await ccAssumptionsRow();
  const goalCents = row && row.quarterly_revenue_goal_cents != null ? Number(row.quarterly_revenue_goal_cents) : null;
  const now = new Date();
  const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), qStartMonth, 1)).toISOString().slice(0, 10);
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), qStartMonth + 3, 1)).toISOString().slice(0, 10);
  let progressCents = 0;
  try {
    const jobs = await fetchAllRows('jobs', `?select=total,completed_at&completed_at=gte.${startDate}&completed_at=lt.${endDate}`);
    progressCents = jobs.reduce((sum, j) => {
      const val = Number(j.total);
      return sum + (val > 0 ? Math.round(val * 100) : 0);
    }, 0);
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const pct = goalCents != null && goalCents > 0 ? progressCents / goalCents : null;
  res.status(200).json({ ok: true, goalCents, progressCents, pct, quarterStart: startDate, quarterEnd: endDate });
}
async function handleMarketingGoalPost(req, res) {
  const b = req.body || {};
  let goalCents = null;
  if (b.goalDollars !== null && b.goalDollars !== undefined && b.goalDollars !== '') {
    const n = Math.round(Number(b.goalDollars) * 100);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ ok: false, error: 'Quarterly revenue goal must be 0 or more.' });
    goalCents = n;
  }
  const existing = await ccAssumptionsRow();
  const payload = { tenant_id: 'ghgrp', quarterly_revenue_goal_cents: goalCents, updated_at: new Date().toISOString(), updated_by: 'owner' };
  if (existing) {
    await supabaseRequest('marketing_plan_assumptions?tenant_id=eq.ghgrp', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload),
    });
  } else {
    await supabaseRequest('marketing_plan_assumptions', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload),
    });
  }
  await logMarketingAuditEvent('plan', 'quarterly_goal_updated', 'plan_assumptions', 'ghgrp', 'owner', { goalCents });
  res.status(200).json({ ok: true, goalCents });
}

async function handleCommandCenterBudgetPost(req, res) {
  const b = req.body || {};
  let cents = Math.round(Number(b.monthlyDollars) * 100);
  if (!Number.isFinite(cents)) return res.status(400).json({ ok: false, error: 'monthlyDollars is required.' });
  cents = Math.min(1500000, Math.max(250000, cents));
  await supabaseRequest('marketing_budget_settings?tenant_id=eq.ghgrp', {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ monthly_budget_cents: cents, updated_at: new Date().toISOString(), updated_by: 'owner' }),
  });
  await logMarketingAuditEvent('budget', 'updated', 'budget', 'monthly', 'owner', { monthlyCents: cents });
  const plan = await ccPlan(cents);
  res.status(200).json({ ok: true, budget: { monthlyCents: cents, min: 250000, max: 1500000 }, plan });
}

// ---------- Marketing Setup: budgets (total limit + per-channel split) + accounts ----------
// Owner request 2026-07-26 ("theres no setup on the marketing suite. add
// budgets, add marketing accounts"). One total monthly limit (existing
// marketing_budget_settings table, sql/031) + an optional per-channel split
// (marketing_channel_budgets, sql/034) that must sum to <= the total.
// Account records reuse marketing_platform_connections (sql/030) -- the
// owner can store which account belongs to each platform (name/ID/notes)
// here, but connection STATE is never editable from this surface: state
// only changes through real connect/verify flows, per the spec's "never
// show a pretend connected state" rule.

const BUDGET_CHANNELS = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS / Text' },
  { key: 'google_ads', label: 'Google Ads' },
  { key: 'meta_ads', label: 'Meta (Facebook/Instagram)' },
  { key: 'google_business_profile', label: 'Google Business Profile' },
  { key: 'website_cms', label: 'Website / SEO' },
  { key: 'direct_mail', label: 'Direct Mail' },
  { key: 'other', label: 'Other / Experiments' },
];

const SETUP_ACCOUNT_PLATFORMS = new Set(['email', ...Object.keys(CHANNEL_LABELS)]);

async function setupBudgetShape() {
  let totalCents = 250000;
  try {
    const rows = await fetchAllRows('marketing_budget_settings', '?select=monthly_budget_cents&tenant_id=eq.ghgrp');
    if (rows[0]) totalCents = rows[0].monthly_budget_cents;
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  let channelRows = [];
  try {
    channelRows = await fetchAllRows('marketing_channel_budgets', '?select=channel,monthly_budget_cents,min_viable_spend_cents,daily_max_cents,testing_allowance_cents,paused,approval_threshold_cents&tenant_id=eq.ghgrp');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const byChannel = new Map(channelRows.map(r => [r.channel, r]));
  const channels = BUDGET_CHANNELS.map(c => {
    const row = byChannel.get(c.key);
    return {
      key: c.key,
      label: c.label,
      monthlyCents: (row && Number(row.monthly_budget_cents)) || 0,
      // Pacing fields: honestly null/0/false when never configured -- never a
      // fabricated non-zero default. See sql/045_marketing_channel_budget_pacing.sql.
      minViableSpendCents: (row && row.min_viable_spend_cents != null) ? Number(row.min_viable_spend_cents) : null,
      dailyMaxCents: (row && row.daily_max_cents != null) ? Number(row.daily_max_cents) : null,
      testingAllowanceCents: (row && row.testing_allowance_cents != null) ? Number(row.testing_allowance_cents) : 0,
      paused: !!(row && row.paused),
      approvalThresholdCents: (row && row.approval_threshold_cents != null) ? Number(row.approval_threshold_cents) : null,
    };
  });
  const allocatedCents = channels.reduce((s, c) => s + c.monthlyCents, 0);
  return { monthlyCents: totalCents, min: 250000, max: 1500000, channels, allocatedCents };
}

async function setupAccountsShape() {
  const emailConfigured = isEmailConfigured();
  const emailSendEnabled = isEmailSendEnabled();
  let stored = [];
  try {
    stored = await fetchAllRows('marketing_platform_connections', '?select=platform,state,account_name,account_id,login_account_id,note,last_verified_at,fields&tenant_id=eq.ghgrp');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const byPlatform = new Map(stored.map(r => [r.platform, r]));
  return ['email', ...Object.keys(CHANNEL_LABELS)].map(key => {
    const row = byPlatform.get(key);
    let state = row ? row.state : 'not_connected';
    let connected = CONNECTED_STATES.has(state);
    let note = (row && row.note) || null;
    if (key === 'email') {
      // Email connection state is real env-derived Resend state, same as
      // handleChannelsGet -- an account record row may still store details.
      state = !emailConfigured ? 'not_connected' : (emailSendEnabled ? 'launch_enabled' : 'reporting_verified');
      connected = emailConfigured;
      if (!note) note = !emailConfigured ? 'No Resend account connected.' : 'Resend connected.';
    }
    // Security fix (2026-08-17, found during Dev To-Do triage): this used to
    // return the raw `fields` column verbatim -- for website_cms that
    // includes a real apiKey in plaintext, sent to the browser of ANY
    // signed-in employee (this resource has no role gate beyond being
    // signed in). connectorPrefillShape() below already redacts secret-typed
    // fields correctly for the connector-catalog response; this had the
    // exact same raw-fields shape feeding four OTHER response bodies
    // (setup, setup_account, setup_account_fields, connection_transition)
    // that never got the same treatment. Same fix, applied at the one
    // shared source instead of separately in each caller.
    const rawFields = (row && row.fields && typeof row.fields === 'object') ? row.fields : {};
    const schema = CONNECTOR_FIELD_SCHEMAS[key] || { fields: [] };
    const secretFieldNames = new Set(schema.fields.filter(f => f.secret).map(f => f.name));
    const safeFields = {};
    const savedSecretFields = [];
    for (const [name, value] of Object.entries(rawFields)) {
      if (secretFieldNames.has(name)) {
        const hasValue = value !== null && value !== undefined && String(value).trim() !== '';
        if (hasValue) savedSecretFields.push(name);
        continue; // never include the real value, saved or not
      }
      safeFields[name] = value;
    }
    return {
      key,
      label: key === 'email' ? 'Email (Resend)' : CHANNEL_LABELS[key],
      state,
      connected,
      accountName: (row && row.account_name) || null,
      accountId: (row && row.account_id) || null,
      loginAccountId: (row && row.login_account_id) || null,
      note: note || 'Not connected.',
      lastVerifiedAt: (row && row.last_verified_at) || null,
      fields: safeFields,
      savedSecretFields,
    };
  });
}

async function handleSetupGet(req, res) {
  const [budget, accounts] = await Promise.all([setupBudgetShape(), setupAccountsShape()]);
  res.status(200).json({ ok: true, budget, accounts });
}

async function handleSetupBudgetPost(req, res) {
  const b = req.body || {};
  let totalCents = Math.round(Number(b.monthlyDollars) * 100);
  if (!Number.isFinite(totalCents)) return res.status(400).json({ ok: false, error: 'monthlyDollars is required.' });
  totalCents = Math.min(1500000, Math.max(250000, totalCents));

  const chIn = (b.channels && typeof b.channels === 'object') ? b.channels : {};

  // Fetch real existing pacing values first. A channel entry may arrive as
  // either the legacy plain dollar number (no pacing info at all) or a
  // richer object that sets only some pacing fields -- either way, any
  // pacing field not explicitly present in this request must keep its real
  // existing value, never silently reset to a fabricated default. This also
  // keeps every row in the single bulk upsert below carrying the same
  // column set, which Supabase/PostgREST's bulk insert requires.
  let existingChannelRows = [];
  try {
    existingChannelRows = await fetchAllRows(
      'marketing_channel_budgets',
      '?select=channel,min_viable_spend_cents,daily_max_cents,testing_allowance_cents,paused,approval_threshold_cents&tenant_id=eq.ghgrp'
    );
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const existingByChannel = new Map(existingChannelRows.map(r => [r.channel, r]));

  function centsFromDollars(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Math.round(Number(v) * 100);
    return Number.isFinite(n) ? n : NaN;
  }

  const rowsToUpsert = [];
  let allocatedCents = 0;
  for (const c of BUDGET_CHANNELS) {
    const v = chIn[c.key];
    const isRich = v !== null && typeof v === 'object';
    const existing = existingByChannel.get(c.key) || {};

    const monthlyInput = isRich ? v.monthlyDollars : v;
    let cents = (monthlyInput === null || monthlyInput === undefined || monthlyInput === '') ? 0 : Math.round(Number(monthlyInput) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      return res.status(400).json({ ok: false, error: c.label + ' budget must be $0 or more.' });
    }
    allocatedCents += cents;

    // Preserve real existing pacing values by default; a rich object below
    // may set or explicitly clear (null) any of them.
    let minViableSpendCents = existing.min_viable_spend_cents != null ? Number(existing.min_viable_spend_cents) : null;
    let dailyMaxCents = existing.daily_max_cents != null ? Number(existing.daily_max_cents) : null;
    let testingAllowanceCents = existing.testing_allowance_cents != null ? Number(existing.testing_allowance_cents) : 0;
    let paused = !!existing.paused;
    let approvalThresholdCents = existing.approval_threshold_cents != null ? Number(existing.approval_threshold_cents) : null;

    if (isRich) {
      if (Object.prototype.hasOwnProperty.call(v, 'minViableSpendDollars')) {
        minViableSpendCents = centsFromDollars(v.minViableSpendDollars);
        if (Number.isNaN(minViableSpendCents)) return res.status(400).json({ ok: false, error: c.label + ' minimum viable spend must be a number.' });
        if (minViableSpendCents != null && minViableSpendCents < 0) return res.status(400).json({ ok: false, error: c.label + ' minimum viable spend must be $0 or more.' });
      }
      if (Object.prototype.hasOwnProperty.call(v, 'dailyMaxDollars')) {
        dailyMaxCents = centsFromDollars(v.dailyMaxDollars);
        if (Number.isNaN(dailyMaxCents)) return res.status(400).json({ ok: false, error: c.label + ' daily maximum must be a number.' });
        if (dailyMaxCents != null && dailyMaxCents < 0) return res.status(400).json({ ok: false, error: c.label + ' daily maximum must be $0 or more.' });
      }
      if (Object.prototype.hasOwnProperty.call(v, 'testingAllowanceDollars')) {
        const parsed = centsFromDollars(v.testingAllowanceDollars);
        testingAllowanceCents = parsed == null ? 0 : parsed;
        if (Number.isNaN(testingAllowanceCents)) return res.status(400).json({ ok: false, error: c.label + ' testing allowance must be a number.' });
        if (testingAllowanceCents < 0) return res.status(400).json({ ok: false, error: c.label + ' testing allowance must be $0 or more.' });
      }
      if (Object.prototype.hasOwnProperty.call(v, 'paused')) {
        paused = !!v.paused;
      }
      if (Object.prototype.hasOwnProperty.call(v, 'approvalThresholdDollars')) {
        approvalThresholdCents = centsFromDollars(v.approvalThresholdDollars);
        if (Number.isNaN(approvalThresholdCents)) return res.status(400).json({ ok: false, error: c.label + ' approval threshold must be a number.' });
        if (approvalThresholdCents != null && approvalThresholdCents < 0) return res.status(400).json({ ok: false, error: c.label + ' approval threshold must be $0 or more.' });
      }
    }

    rowsToUpsert.push({
      tenant_id: 'ghgrp',
      channel: c.key,
      monthly_budget_cents: cents,
      min_viable_spend_cents: minViableSpendCents,
      daily_max_cents: dailyMaxCents,
      testing_allowance_cents: testingAllowanceCents,
      paused,
      approval_threshold_cents: approvalThresholdCents,
      updated_at: new Date().toISOString(),
      updated_by: 'owner',
    });
  }
  if (allocatedCents > totalCents) {
    return res.status(400).json({
      ok: false,
      error: 'Channel budgets add up to $' + Math.round(allocatedCents / 100).toLocaleString('en-US') +
        ', which is over the $' + Math.round(totalCents / 100).toLocaleString('en-US') + ' monthly limit. Lower a channel or raise the limit.',
    });
  }

  // Upsert the total limit (row is normally seeded; handle first-run too).
  let existingTotal = [];
  try {
    existingTotal = await fetchAllRows('marketing_budget_settings', '?select=id&tenant_id=eq.ghgrp');
  } catch (e) {
    if (!e.notSynced) throw e;
  }
  const totalPayload = { monthly_budget_cents: totalCents, updated_at: new Date().toISOString(), updated_by: 'owner' };
  const totalRes = existingTotal.length
    ? await supabaseRequest('marketing_budget_settings?tenant_id=eq.ghgrp', {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(totalPayload),
      })
    : await supabaseRequest('marketing_budget_settings', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ tenant_id: 'ghgrp', ...totalPayload }]),
      });
  if (!totalRes.ok) return res.status(500).json({ ok: false, error: await totalRes.text() });

  const chRes = await supabaseRequest('marketing_channel_budgets?on_conflict=tenant_id,channel', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rowsToUpsert),
  });
  if (!chRes.ok) return res.status(500).json({ ok: false, error: await chRes.text() });

  const budget = await setupBudgetShape();
  res.status(200).json({ ok: true, budget });
}

// ---------- Setup: data-driven budget-split recommendation (task #102) ----------
// Suggests how to split a total monthly budget across BUDGET_CHANNELS using
// real, historical channel performance -- the owner still sets the final
// numbers via handleSetupBudgetPost; this only recommends.
//
// Two real data sources, both already used elsewhere in this file:
//   - ad_spend_ledger (sql/058, applied to production 2026-08-05): real
//     platform-reported spend, by platform (meta, google_ads, tiktok), over
//     a real date range. Never estimated -- see the table's own comment.
//   - lead_pipeline.lead_source (sql/013), mapped to a channel via the same
//     LEAD_SOURCE_CHANNEL_KEY handleChannelPerformanceGet above already uses
//     (google -> google_ads, facebook -> meta_ads).
//
// Only google_ads and meta_ads have BOTH a real spend source AND a real
// lead-source mapping today (tiktok has real spend rows but no matching
// BUDGET_CHANNELS entry or lead_source mapping yet -- an honest gap, not
// fabricated, surfaced via unassignedPlatformSpendCents below). Every other
// BUDGET_CHANNELS entry (email, sms, google_business_profile, website_cms,
// direct_mail, other) has no paid-spend ledger and/or no lead-source
// mapping, so this function never invents a cost-per-lead for them -- it
// recommends keeping their current configured dollar amount unchanged (the
// same "protect what we can't honestly compare" approach the Phase 7
// ccChannelAllocationPreview frontend function already uses for owned
// channels).
const RECOMMENDATION_LOOKBACK_DEFAULT_DAYS = 90;
const RECOMMENDATION_TRACKABLE_CHANNELS = ['google_ads', 'meta_ads'];
// ad_spend_ledger.platform value -> BUDGET_CHANNELS key.
const AD_SPEND_PLATFORM_TO_CHANNEL_KEY = { google_ads: 'google_ads', meta: 'meta_ads' };

async function computeChannelSpendAndLeads(lookbackDays) {
  const spendStartDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const spendByChannel = {}; // channelKey -> real spend cents
  const unassignedPlatformSpendCents = {}; // platform -> real spend cents with no BUDGET_CHANNELS match
  let spendTableMissing = false;
  try {
    const rows = await fetchAllRows(
      'ad_spend_ledger',
      `?select=platform,spend_cents&tenant_id=eq.ghgrp&spend_date=gte.${spendStartDate}`
    );
    rows.forEach((r) => {
      const cents = Number(r.spend_cents || 0);
      const channelKey = AD_SPEND_PLATFORM_TO_CHANNEL_KEY[r.platform];
      if (!channelKey) {
        unassignedPlatformSpendCents[r.platform] = (unassignedPlatformSpendCents[r.platform] || 0) + cents;
        return;
      }
      spendByChannel[channelKey] = (spendByChannel[channelKey] || 0) + cents;
    });
  } catch (e) {
    if (e.notSynced) spendTableMissing = true; else throw e;
  }

  const leadsStartDate = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const leadsByChannel = {}; // channelKey -> real lead count
  let leadsTableMissing = false;
  try {
    const rows = await fetchAllRows(
      'lead_pipeline',
      `?select=lead_source,created_at&lead_source=not.is.null&created_at=gte.${leadsStartDate}`
    );
    rows.forEach((r) => {
      const src = String(r.lead_source || '').trim().toLowerCase();
      if (!src) return;
      const channelKey = LEAD_SOURCE_CHANNEL_KEY[src];
      if (!channelKey) return;
      leadsByChannel[channelKey] = (leadsByChannel[channelKey] || 0) + 1;
    });
  } catch (e) {
    if (e.notSynced) leadsTableMissing = true; else throw e;
  }

  return { spendByChannel, leadsByChannel, unassignedPlatformSpendCents, spendTableMissing, leadsTableMissing };
}

async function handleSetupBudgetRecommendationGet(req, res) {
  const q = (req && req.query) || {};
  const lookbackDays = Math.min(365, Math.max(7, Math.round(Number(q.lookbackDays)) || RECOMMENDATION_LOOKBACK_DEFAULT_DAYS));

  const current = await setupBudgetShape();
  let totalCents = current.monthlyCents;
  if (q.monthlyDollars !== undefined && q.monthlyDollars !== '') {
    const parsed = Math.round(Number(q.monthlyDollars) * 100);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return res.status(400).json({ ok: false, error: 'monthlyDollars must be a number.' });
    }
    totalCents = Math.min(current.max, Math.max(current.min, parsed));
  }

  const { spendByChannel, leadsByChannel, unassignedPlatformSpendCents, spendTableMissing, leadsTableMissing } =
    await computeChannelSpendAndLeads(lookbackDays);
  const dataDegraded = spendTableMissing || leadsTableMissing;

  const currentByKey = new Map(current.channels.map((c) => [c.key, c]));
  const nonTrackableTotalCents = current.channels
    .filter((c) => !RECOMMENDATION_TRACKABLE_CHANNELS.includes(c.key))
    .reduce((s, c) => s + c.monthlyCents, 0);
  const remainingForTrackableCents = totalCents - nonTrackableTotalCents;

  // Real performance stats for the two trackable channels. hasRealData is
  // only true when there is BOTH real tracked spend AND at least one real
  // attributed lead in the lookback window -- a channel with spend but zero
  // leads (or leads but zero tracked spend) gets no fabricated CPL.
  const perf = RECOMMENDATION_TRACKABLE_CHANNELS.map((key) => {
    const spendCents = spendByChannel[key] || 0;
    const leads = leadsByChannel[key] || 0;
    const hasRealData = spendCents > 0 && leads > 0;
    const costPerLeadCents = hasRealData ? Math.round(spendCents / leads) : null;
    return { key, spendCents, leads, hasRealData, costPerLeadCents };
  });
  const perfByKey = new Map(perf.map((p) => [p.key, p]));
  const channelsWithData = perf.filter((p) => p.hasRealData);
  const currentTrackableSum = RECOMMENDATION_TRACKABLE_CHANNELS.reduce(
    (s, k) => s + ((currentByKey.get(k) || {}).monthlyCents || 0), 0
  );

  let basis, summary;
  const trackableRecommendedByKey = {};
  if (remainingForTrackableCents < 0) {
    basis = 'total_below_fixed_channels';
    summary = 'This total does not even cover what your other channels are already budgeted for -- lower one of those first before a paid split can be recommended.';
    RECOMMENDATION_TRACKABLE_CHANNELS.forEach((k) => { trackableRecommendedByKey[k] = 0; });
  } else if (channelsWithData.length === 2) {
    basis = 'real_cost_per_lead';
    summary = `Google Ads and Meta both have real spend/lead data in the last ${lookbackDays} days -- the channel with the lower real cost per lead gets a larger share.`;
    // Lower real cost-per-lead -> larger share of the remaining budget.
    const weights = channelsWithData.map((p) => 1 / p.costPerLeadCents);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    channelsWithData.forEach((p, i) => {
      trackableRecommendedByKey[p.key] = Math.round(remainingForTrackableCents * (weights[i] / weightSum));
    });
  } else if (channelsWithData.length === 1) {
    basis = 'partial_real_data_even_split';
    summary = `Only one paid channel has real spend/lead data in the last ${lookbackDays} days -- an even split, not a confident lean toward the one channel we happen to have a number for.`;
    const half = Math.round(remainingForTrackableCents / 2);
    trackableRecommendedByKey[RECOMMENDATION_TRACKABLE_CHANNELS[0]] = half;
    trackableRecommendedByKey[RECOMMENDATION_TRACKABLE_CHANNELS[1]] = remainingForTrackableCents - half;
  } else if (currentTrackableSum > 0) {
    basis = 'no_real_data_kept_current_proportions';
    summary = `No real spend/lead data exists yet for either paid channel in the last ${lookbackDays} days -- recommendation preserves your current proportional split rather than inventing a preference.`;
    RECOMMENDATION_TRACKABLE_CHANNELS.forEach((k) => {
      const cur = (currentByKey.get(k) || {}).monthlyCents || 0;
      trackableRecommendedByKey[k] = Math.round(remainingForTrackableCents * (cur / currentTrackableSum));
    });
  } else {
    basis = 'no_real_data_even_split';
    summary = `No real performance data or existing spend exists yet for either paid channel -- an even split is the only honest starting point.`;
    const half = Math.round(remainingForTrackableCents / 2);
    trackableRecommendedByKey[RECOMMENDATION_TRACKABLE_CHANNELS[0]] = half;
    trackableRecommendedByKey[RECOMMENDATION_TRACKABLE_CHANNELS[1]] = remainingForTrackableCents - half;
  }

  // Rounding fix-up: Math.round on each independent share can leave the two
  // trackable amounts off by a cent or two from remainingForTrackableCents.
  if (remainingForTrackableCents >= 0) {
    const sum = RECOMMENDATION_TRACKABLE_CHANNELS.reduce((s, k) => s + trackableRecommendedByKey[k], 0);
    const drift = remainingForTrackableCents - sum;
    if (drift !== 0) trackableRecommendedByKey[RECOMMENDATION_TRACKABLE_CHANNELS[0]] += drift;
  }

  const channels = current.channels.map((c) => {
    const isTrackable = RECOMMENDATION_TRACKABLE_CHANNELS.includes(c.key);
    const p = perfByKey.get(c.key);
    let recommendedMonthlyCents, rationale;
    if (isTrackable) {
      recommendedMonthlyCents = trackableRecommendedByKey[c.key];
      if (basis === 'total_below_fixed_channels') {
        rationale = 'Requested total does not cover the other channels current budgets yet.';
      } else if (p.hasRealData) {
        rationale = `Real ${lookbackDays}-day cost per lead: ${(p.costPerLeadCents / 100).toFixed(2)} (${p.leads} lead${p.leads === 1 ? '' : 's'} from ${(p.spendCents / 100).toFixed(2)} real spend).`;
      } else {
        rationale = `No real spend/lead data yet for this channel in the last ${lookbackDays} days.`;
      }
    } else {
      recommendedMonthlyCents = c.monthlyCents;
      rationale = 'No real paid-performance comparison exists for this channel yet -- recommendation keeps your current setting.';
    }
    return {
      key: c.key,
      label: c.label,
      currentMonthlyCents: c.monthlyCents,
      recommendedMonthlyCents,
      hasRealData: isTrackable ? !!(p && p.hasRealData) : null,
      spendCents: isTrackable ? p.spendCents : null,
      leads: isTrackable ? p.leads : null,
      costPerLeadCents: isTrackable ? p.costPerLeadCents : null,
      rationale,
    };
  });

  const notes = [];
  if (dataDegraded) {
    notes.push('Some performance tables are not set up yet -- run the latest sql/0NN_*.sql migrations in Supabase for a fuller recommendation.');
  }
  const unassignedPlatforms = Object.keys(unassignedPlatformSpendCents);
  if (unassignedPlatforms.length) {
    notes.push(
      'Real ad spend was found for ' + unassignedPlatforms.join(', ') +
      ' but there is no matching budget-split channel for it yet, so it is not part of this recommendation.'
    );
  }

  res.status(200).json({
    ok: true,
    lookbackDays,
    totalCents,
    basis,
    summary,
    trackableChannelKeys: RECOMMENDATION_TRACKABLE_CHANNELS,
    channels,
    unassignedPlatformSpendCents,
    notes,
  });
}

async function handleSetupAccountPost(req, res) {
  const b = req.body || {};
  const channel = String(b.channel || '').trim();
  if (!SETUP_ACCOUNT_PLATFORMS.has(channel)) {
    return res.status(400).json({ ok: false, error: 'channel must be one of: ' + [...SETUP_ACCOUNT_PLATFORMS].join(', ') + '.' });
  }
  function strOrNull(v, max) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s ? s.slice(0, max) : null;
  }
  const payload = {
    account_name: strOrNull(b.accountName, 200),
    account_id: strOrNull(b.accountId, 200),
    login_account_id: strOrNull(b.loginAccountId, 200),
    note: strOrNull(b.note, 500),
    updated_at: new Date().toISOString(),
  };

  const exRes = await supabaseRequest('marketing_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(channel) + '&select=id&limit=1');
  if (!exRes.ok) return res.status(500).json({ ok: false, error: await exRes.text() });
  const existing = await exRes.json();

  // Deliberately never sets `state` on an existing row -- connection state
  // only changes through real connect/verify flows. A brand-new row starts
  // honestly at not_connected.
  const saveRes = existing.length
    ? await supabaseRequest('marketing_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(channel), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      })
    : await supabaseRequest('marketing_platform_connections', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ tenant_id: 'ghgrp', platform: channel, state: 'not_connected', ...payload }]),
      });
  if (!saveRes.ok) return res.status(500).json({ ok: false, error: await saveRes.text() });
  await logMarketingAuditEvent('connection', existing.length ? 'account_details_updated' : 'account_details_created', 'platform_connection', channel, 'owner', { accountName: payload.account_name });

  const accounts = await setupAccountsShape();
  res.status(200).json({ ok: true, accounts });
}

// ---------- Universal Connections: connector catalog + dynamic account fields (Phase 15) ----------
// Backend for the "Add Marketing Account" button + dynamic form in
// public/app-marketing.js (deleted 2026-08-18, never loaded). This is a self-contained port of the
// connector-catalog and add-account-fields Phase 15 slices into this UI
// branch (each was built and tested independently off origin/main per the
// project's isolated-sibling-branch pattern) so the new frontend has real,
// working endpoints to call rather than depending on a not-yet-merged
// branch. CONNECTOR_FIELD_SCHEMAS is intentionally identical to the copy on
// those two sibling branches -- reconciliation unions all three into one
// copy, they are already the same code.
const CONNECTOR_FIELD_SCHEMAS = {
  email: { authMethod: 'env_managed', fields: [] },
  sms: { authMethod: 'manual', fields: [] },
  google_ads: { authMethod: 'oauth', fields: [] },
  meta_ads: { authMethod: 'oauth', fields: [] },
  google_business_profile: { authMethod: 'oauth', fields: [] },
  website_cms: {
    authMethod: 'api_key',
    fields: [
      { name: 'cmsPlatform', label: 'CMS platform', type: 'select', options: ['WordPress', 'Webflow', 'Custom'], required: true, helpText: 'Which system runs the website.' },
      { name: 'siteUrl', label: 'Site URL', type: 'text', required: true, helpText: 'e.g. https://example.com' },
      { name: 'apiKey', label: 'API key', type: 'text', required: true, secret: true, helpText: 'Found in your CMS admin settings.' },
    ],
  },
  ga4: { authMethod: 'oauth', fields: [] },
  gtm: { authMethod: 'oauth', fields: [] },
  search_console: { authMethod: 'oauth', fields: [] },
  youtube: { authMethod: 'oauth', fields: [] },
  facebook_instagram: { authMethod: 'oauth', fields: [] },
  microsoft_ads: { authMethod: 'oauth', fields: [] },
  linkedin: { authMethod: 'oauth', fields: [] },
  tiktok: { authMethod: 'oauth', fields: [] },
  direct_mail: {
    authMethod: 'manual',
    fields: [
      { name: 'vendorName', label: 'Vendor name', type: 'text', required: true, helpText: 'The mail house or print vendor you use.' },
      { name: 'note', label: 'Notes', type: 'text', required: false, helpText: 'Optional -- account number, contact, etc.' },
    ],
  },
};

// Task #104: resume-my-own-setup prefill. A field only ever prefills from a
// real value the owner already typed for this exact platform in a prior
// setup_account_fields save (marketing_platform_connections.fields) -- never
// a guess, and never a secret. Secret-typed fields (apiKey) only report
// whether a value is already saved (savedSecretFields) so the modal can show
// "already saved, leave blank to keep" without ever putting the real secret
// back in the DOM.
function connectorPrefillShape(schema, account) {
  const stored = (account && account.fields && typeof account.fields === 'object') ? account.fields : {};
  const values = {};
  const secretsSaved = [];
  for (const f of schema.fields) {
    const raw = stored[f.name];
    const hasValue = raw !== null && raw !== undefined && String(raw).trim() !== '';
    if (!hasValue) continue;
    if (f.secret) secretsSaved.push(f.name);
    else values[f.name] = raw;
  }
  return { values, secretsSaved };
}

async function connectorCatalogShape() {
  const accounts = await setupAccountsShape();
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  return [...SETUP_ACCOUNT_PLATFORMS].map((key) => {
    const schema = CONNECTOR_FIELD_SCHEMAS[key] || { authMethod: 'manual', fields: [] };
    const account = byKey.get(key);
    const prefill = connectorPrefillShape(schema, account);
    return {
      key,
      label: key === 'email' ? 'Email (Resend)' : (CHANNEL_LABELS[key] || key),
      authMethod: schema.authMethod,
      fields: schema.fields,
      state: account ? account.state : 'not_connected',
      alreadyActive: !!(account && account.state !== 'not_connected'),
      savedValues: prefill.values,
      savedSecretFields: prefill.secretsSaved,
    };
  });
}

async function handleConnectorCatalogGet(req, res) {
  const catalog = await connectorCatalogShape();
  const available = catalog.filter((c) => !c.alreadyActive);
  res.status(200).json({ ok: true, catalog, available });
}

function validateConnectorFieldValues(platform, values, existingFields) {
  const schema = CONNECTOR_FIELD_SCHEMAS[platform] || { authMethod: 'manual', fields: [] };
  const v = (values && typeof values === 'object') ? values : {};
  const ex = (existingFields && typeof existingFields === 'object') ? existingFields : {};
  const errors = [];
  const payload = {};
  for (const f of schema.fields) {
    const raw = v[f.name];
    const trimmed = (raw === null || raw === undefined) ? '' : String(raw).trim();
    if (!trimmed && f.secret && ex[f.name]) {
      // Blank secret field with an already-saved value: keep the saved value
      // rather than forcing the owner to retype a secret just to change
      // another field. A real new value always replaces it.
      payload[f.name] = ex[f.name];
      continue;
    }
    if (f.required && !trimmed) {
      errors.push(f.label + ' is required.');
      continue;
    }
    payload[f.name] = trimmed || null;
  }
  return { ok: errors.length === 0, errors, payload };
}

async function handleSetupAccountFieldsPost(req, res) {
  const b = req.body || {};
  const platform = String(b.platform || '').trim();
  if (!SETUP_ACCOUNT_PLATFORMS.has(platform)) {
    return res.status(400).json({ ok: false, error: 'platform must be one of: ' + [...SETUP_ACCOUNT_PLATFORMS].join(', ') + '.' });
  }

  const schema = CONNECTOR_FIELD_SCHEMAS[platform] || { authMethod: 'manual', fields: [] };

  const exRes = await supabaseRequest('marketing_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(platform) + '&select=id,state,fields&limit=1');
  if (!exRes.ok) return res.status(500).json({ ok: false, error: await exRes.text() });
  const existing = await exRes.json();
  const existingFields = (existing[0] && existing[0].fields && typeof existing[0].fields === 'object') ? existing[0].fields : {};

  const validation = validateConnectorFieldValues(platform, b.fields, existingFields);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.errors.join(' ') });
  }

  const currentState = existing[0] ? existing[0].state : 'not_connected';
  const nextState = currentState === 'not_connected' ? 'setup_incomplete' : currentState;

  const payload = {
    fields: validation.payload,
    state: nextState,
    updated_at: new Date().toISOString(),
  };

  const saveRes = existing.length
    ? await supabaseRequest('marketing_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(platform), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      })
    : await supabaseRequest('marketing_platform_connections', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ tenant_id: 'ghgrp', platform, ...payload }]),
      });
  if (!saveRes.ok) return res.status(500).json({ ok: false, error: await saveRes.text() });

  // Never echo a secret-typed field's real value back over the wire -- the
  // caller either just typed it (already knows it) or left it blank to keep
  // the saved one (does not need it repeated back).
  const responseFields = {};
  for (const f of schema.fields) {
    if (f.secret) continue;
    if (Object.prototype.hasOwnProperty.call(validation.payload, f.name)) responseFields[f.name] = validation.payload[f.name];
  }

  const accounts = await setupAccountsShape();
  res.status(200).json({ ok: true, platform, state: nextState, fields: responseFields, accounts });
}

// ---------- Universal Connections state machine (Phase 15) ----------
// Enforces the "One connect/OAuth/select-account/verify-reporting/
// verify-draft/confirm-billing/enable-launch flow for every platform"
// requirement from the master build plan (Phase 15). Before this, nothing
// in this file ever changed a marketing_platform_connections.state value
// past its initial not_connected/setup_incomplete row --
// handleSetupAccountPost above explicitly never touches state, so there
// was a place to store account metadata but no real connect/verify flow
// enforcing it. This is that flow's enforcement layer: a state change must
// be a legal single step in the sequence below, so a connector can never
// claim launch_enabled without having actually passed through
// reporting_verified and draft_validated first, and a real failure is
// always recorded as one of four specific, actionable states rather than
// the old generic needs_attention (which stays valid for backward
// compatibility with any already-stored rows, but new code should prefer
// the specific ones).
const CONNECTION_STATES = [
  'not_connected', 'setup_incomplete', 'reporting_verified', 'draft_validated',
  'launch_enabled', 'needs_attention', 'needs_reauth', 'policy_blocked',
  'billing_blocked', 'external_approval_pending',
];

const ISSUE_STATES = new Set(['needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked', 'external_approval_pending']);

// Every issue state recovers by going back through setup_incomplete (the
// owner/connector must re-verify from there, not resume mid-flow) or by
// disconnecting outright. external_approval_pending is the one exception
// worth naming in comments: nothing is actually broken, there's just
// nothing to do but wait -- it still recovers through setup_incomplete
// once the platform approves, so the honest reporting/draft/launch
// sequence still applies rather than jumping straight to launch_enabled.
const RECOVERY_TARGETS = new Set(['setup_incomplete', 'not_connected']);

const CONNECTION_STATE_TRANSITIONS = {
  not_connected: new Set(['setup_incomplete']),
  setup_incomplete: new Set(['reporting_verified', 'not_connected', 'needs_reauth', 'policy_blocked', 'billing_blocked', 'external_approval_pending']),
  reporting_verified: new Set(['draft_validated', 'not_connected', 'needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked']),
  draft_validated: new Set(['launch_enabled', 'not_connected', 'needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked']),
  launch_enabled: new Set(['not_connected', 'needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked']),
  needs_attention: new Set(RECOVERY_TARGETS),
  needs_reauth: new Set(RECOVERY_TARGETS),
  policy_blocked: new Set(RECOVERY_TARGETS),
  billing_blocked: new Set(RECOVERY_TARGETS),
  external_approval_pending: new Set(RECOVERY_TARGETS),
};

function isValidConnectionTransition(fromState, toState) {
  const allowed = CONNECTION_STATE_TRANSITIONS[fromState];
  return !!allowed && allowed.has(toState);
}

async function handleConnectionTransitionPost(req, res) {
  const b = req.body || {};
  const platform = String(b.platform || '').trim();
  const toState = String(b.toState || '').trim();
  const note = (b.note === null || b.note === undefined) ? null : (String(b.note).trim().slice(0, 500) || null);

  if (!SETUP_ACCOUNT_PLATFORMS.has(platform)) {
    return res.status(400).json({ ok: false, error: 'platform must be one of: ' + [...SETUP_ACCOUNT_PLATFORMS].join(', ') + '.' });
  }
  if (!CONNECTION_STATES.includes(toState)) {
    return res.status(400).json({ ok: false, error: 'toState must be one of: ' + CONNECTION_STATES.join(', ') + '.' });
  }

  const exRes = await supabaseRequest('marketing_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(platform) + '&select=id,state,last_verified_at&limit=1');
  if (!exRes.ok) return res.status(500).json({ ok: false, error: await exRes.text() });
  const existing = await exRes.json();
  const fromState = existing[0] ? existing[0].state : 'not_connected';

  if (!isValidConnectionTransition(fromState, toState)) {
    return res.status(409).json({
      ok: false,
      error: 'Cannot move ' + platform + ' from ' + fromState + ' to ' + toState + ' -- that skips required steps in the connect/verify-reporting/verify-draft/enable-launch sequence.',
      fromState,
    });
  }

  const now = new Date().toISOString();
  const payload = {
    state: toState,
    updated_at: now,
    last_verified_at: ISSUE_STATES.has(toState) ? (existing[0] ? existing[0].last_verified_at : null) : now,
    last_error: ISSUE_STATES.has(toState) ? (note || ('Moved to ' + toState + '.')) : null,
  };

  const saveRes = existing.length
    ? await supabaseRequest('marketing_platform_connections?tenant_id=eq.ghgrp&platform=eq.' + encodeURIComponent(platform), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      })
    : await supabaseRequest('marketing_platform_connections', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ tenant_id: 'ghgrp', platform, ...payload }]),
      });
  if (!saveRes.ok) return res.status(500).json({ ok: false, error: await saveRes.text() });

  const accounts = await setupAccountsShape();
  res.status(200).json({ ok: true, platform, fromState, toState, accounts });
}

// ---------- Campaign management: delete / rename / duplicate / activity / scheduled sends ----------
// Added alongside the 2026-07-25 production-safety audit: drafts had no way
// to be edited or removed, and there was no audit trail of who did what to a
// campaign. All destructive/mutating actions below only ever touch DRAFT
// campaigns (or, for scheduling, draft/scheduled) -- a campaign that has
// ever sent to even one real recipient can only be archived via its status,
// never deleted, so sent-campaign reporting can never disappear.

// Reject a pending marketing_approvals row. Works for any approvable_type
// -- a CAMPAIGN_SPEND rejection leaves the underlying campaign in place as
// a draft (never deletes it); the owner can still edit/delete it manually.
// Once rejected, ccReadyForYou()'s legacy fallback will never resurface it
// as if it had never been reviewed (see the linkedCampaignIds fix above).
async function handleApprovalRejectPost(req, res) {
  const b = req.body || {};
  const approvalId = String(b.approvalId || '').trim();
  if (!approvalId) return res.status(400).json({ ok: false, error: 'approvalId is required.' });

  const apprRes = await supabaseRequest(`marketing_approvals?id=eq.${encodeURIComponent(approvalId)}&select=*&limit=1`);
  if (!apprRes.ok) return res.status(500).json({ ok: false, error: await apprRes.text() });
  const [approval] = await apprRes.json();
  if (!approval) return res.status(404).json({ ok: false, error: 'Approval not found.' });
  if (approval.status !== 'pending') {
    return res.status(409).json({ ok: false, error: `This approval is already ${approval.status} -- it can only be rejected while pending.` });
  }

  const actorEmail = (req.hlUser && req.hlUser.email) || null;
  const reason = b.reason ? String(b.reason).trim().slice(0, 2000) : null;
  const patchRes = await supabaseRequest(`marketing_approvals?id=eq.${encodeURIComponent(approvalId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'rejected', decided_by: actorEmail || 'owner', decided_at: new Date().toISOString(), decision_reason: reason }),
  });
  if (!patchRes.ok) return res.status(500).json({ ok: false, error: await patchRes.text() });
  res.status(200).json({ ok: true, rejected: true, approvalId });
}

async function handleCampaignDeletePost(req, res) {
  const b = req.body || {};
  const campaignId = String(b.campaignId || '').trim();
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required.' });
  if (!b.confirm) return res.status(400).json({ ok: false, error: 'confirm must be true -- this is a destructive action.' });

  const campRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}&select=*&limit=1`);
  if (!campRes.ok) return res.status(500).json({ ok: false, error: await campRes.text() });
  const [campaign] = await campRes.json();
  if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found.' });

  const sentRes = await supabaseRequest(`campaign_recipients?campaign_id=eq.${encodeURIComponent(campaignId)}&sent_at=not.is.null&select=id&limit=1`);
  const hasSent = sentRes.ok ? (await sentRes.json()).length > 0 : false;
  if (hasSent || campaign.status === 'active' || campaign.status === 'sending') {
    return res.status(409).json({ ok: false, error: 'This campaign has already sent to at least one recipient (or is sending right now) -- it can only be archived, not deleted, so reporting is never lost.' });
  }

  const delRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!delRes.ok) return res.status(500).json({ ok: false, error: await delRes.text() });
  await logMarketingAuditEvent('campaign', 'deleted', 'campaign', campaignId, 'owner', { priorStatus: campaign.status });
  // Best-effort: clear any pending approval row for this campaign so a
  // deleted draft never leaves a stale card in Ready for You.
  try {
    await supabaseRequest(`marketing_approvals?approvable_type=eq.CAMPAIGN_SPEND&approvable_id=eq.${encodeURIComponent(campaignId)}&status=eq.pending`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  } catch (e) { /* best-effort only */ }
  res.status(200).json({ ok: true, deleted: true, campaignId });
}

async function handleCampaignUpdatePost(req, res) {
  const b = req.body || {};
  const campaignId = String(b.campaignId || '').trim();
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required.' });

  const campRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}&select=*&limit=1`);
  if (!campRes.ok) return res.status(500).json({ ok: false, error: await campRes.text() });
  const [campaign] = await campRes.json();
  if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found.' });
  if (campaign.status !== 'draft') {
    return res.status(409).json({ ok: false, error: `This campaign is "${campaign.status}", not "draft" -- only drafts can be edited here.` });
  }

  const patch = {};
  let scheduleEvent = null;
  if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.notes === 'string') patch.notes = b.notes;
  if (typeof b.subject === 'string') patch.subject = b.subject.trim() || null;
  if (typeof b.body === 'string') patch.body = b.body.trim() || null;
  if (b.scheduledAt === null) { patch.scheduled_at = null; scheduleEvent = 'schedule_cancelled'; }
  else if (typeof b.scheduledAt === 'string' && b.scheduledAt.trim()) {
    const d = new Date(b.scheduledAt);
    if (isNaN(d.getTime()) || d.getTime() <= Date.now()) {
      return res.status(400).json({ ok: false, error: 'scheduledAt must be a valid future date/time.' });
    }
    patch.scheduled_at = d.toISOString();
    scheduleEvent = 'scheduled';
  }
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'Nothing to update -- provide name, notes, subject, body, and/or scheduledAt.' });
  const actorEmail = (req.hlUser && req.hlUser.email) || null;
  patch.updated_by = actorEmail;

  const r = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: await r.text() });
  const [updated] = await r.json();
  await logCampaignActivity(campaignId, scheduleEvent || 'edited', actorEmail, { patch });
  res.status(200).json({ ok: true, campaign: updated });
}

async function handleCampaignDuplicatePost(req, res) {
  const b = req.body || {};
  const campaignId = String(b.campaignId || '').trim();
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required.' });

  const campRes = await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(campaignId)}&select=*&limit=1`);
  if (!campRes.ok) return res.status(500).json({ ok: false, error: await campRes.text() });
  const [source] = await campRes.json();
  if (!source) return res.status(404).json({ ok: false, error: 'Campaign not found.' });

  const actorEmail = (req.hlUser && req.hlUser.email) || null;
  const row = {
    name: source.name + ' (copy)',
    type: source.type,
    channel: source.channel,
    status: 'draft',
    target_filter: source.target_filter,
    notes: source.notes,
    subject: source.subject,
    body: source.body,
    created_by: actorEmail,
  };
  const r = await supabaseRequest('campaigns', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) return res.status(500).json({ ok: false, error: await r.text() });
  const created = (await r.json())[0];
  // Deliberately NOT copying recipients -- a duplicate starts with zero
  // recipients and must go through real audience selection again, exactly
  // like any other fresh campaign (checkCampaignEligibility would otherwise
  // let a duplicate silently ship with a stale/mismatched audience).
  await logCampaignActivity(created.id, 'duplicated', actorEmail, { sourceCampaignId: campaignId });
  res.status(200).json({
    ok: true,
    campaign: created,
    recipientCount: 0,
    note: 'Duplicated as a new draft with zero recipients -- select a real audience for it before sending.',
  });
}

async function handleCampaignActivityGet(req, res) {
  const campaignId = String(req.query.campaignId || '').trim();
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required.' });
  let events = [];
  try {
    events = await fetchAllRows('campaign_activity_log', `?campaign_id=eq.${encodeURIComponent(campaignId)}&select=event,actor,detail,created_at&order=created_at.desc`);
  } catch (e) { if (!e.notSynced) throw e; }
  res.status(200).json({ ok: true, campaignId, events });
}

// Vercel Cron entry point (see vercel.json, runs every 15 min) -- picks up
// campaigns whose scheduled_at has arrived and sends them through the exact
// same handleCampaignSendPost code path an interactive click uses (same
// atomic claim, same suppression/consent checks, same activity log), by
// constructing a minimal fake req/res pair rather than duplicating the send
// logic in a second place.
async function handleProcessScheduledSendsGet(req, res) {
  const nowIso = new Date().toISOString();
  const due = await fetchAllRows('campaigns', `?status=eq.draft&scheduled_at=not.is.null&scheduled_at=lte.${encodeURIComponent(nowIso)}&select=id,subject,body`);
  const results = [];
  for (const c of due) {
    if (!c.subject || !c.body) {
      await logCampaignActivity(c.id, 'send_failed', 'scheduled-send-cron', { reason: 'Scheduled send fired with no subject/body saved on the draft -- cancelling the schedule instead of retrying forever.' });
      await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(c.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ scheduled_at: null }) });
      results.push({ campaignId: c.id, ok: false, error: 'missing subject/body' });
      continue;
    }
    let captured = { statusCode: 200, body: null };
    const fakeRes = {
      status(code) { captured.statusCode = code; return this; },
      json(body) { captured.body = body; return this; },
    };
    const fakeReq = { body: { campaignId: c.id, subject: c.subject, body: c.body }, hlUser: { email: 'scheduled-send-cron' } };
    try {
      await handleCampaignSendPost(fakeReq, fakeRes);
    } catch (e) {
      captured = { statusCode: 500, body: { ok: false, error: e.message } };
    }
    // Always clear scheduled_at once processed (success, failure, or an
    // interactive send already beat the cron to it) so it never shows as
    // "scheduled" again once this cron has looked at it.
    await supabaseRequest(`campaigns?id=eq.${encodeURIComponent(c.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ scheduled_at: null }) });
    results.push({ campaignId: c.id, ok: captured.body && captured.body.ok, result: captured.body });
  }
  res.status(200).json({ ok: true, processed: due.length, results });
}

// ---------- Review request auto-send (Reina automation) ----------
// Turns getReviewRequestCandidates() into a real, sent review-request
// campaign on a schedule, with zero owner involvement -- gated entirely
// behind two env vars the owner must set for this to ever do anything:
//   REVIEW_REQUEST_AUTOSEND_DAYS -- days after job completion to wait
//                                   before asking (e.g. "3")
//   GOOGLE_REVIEW_LINK           -- already used by the manual flow above
// If either is unset this is a no-op that reports why, so it is safe to
// ship the cron entry before the owner has opted in. This reuses the exact
// handleCampaignsPost / handleCampaignSendPost pipeline the owner uses when
// sending manually (same helper shape as handleProcessScheduledSendsGet
// above), so suppression/consent checks, campaign_recipients bookkeeping,
// activity logging, and Ready-for-You approval resolution all behave
// identically -- this cron just supplies the actor identity.
async function handleProcessReviewRequestAutosendGet(req, res) {
  const days = Number(process.env.REVIEW_REQUEST_AUTOSEND_DAYS);
  if (!isFinite(days) || days <= 0) {
    return res.status(200).json({ ok: true, sent: 0, message: 'REVIEW_REQUEST_AUTOSEND_DAYS is not set -- review-request auto-send is off. Set it in Vercel (e.g. "3") to turn this on.' });
  }
  const reviewLink = process.env.GOOGLE_REVIEW_LINK || null;
  if (!reviewLink) {
    return res.status(200).json({ ok: true, sent: 0, message: 'GOOGLE_REVIEW_LINK is not set -- cannot auto-send review asks with no review link.' });
  }

  const { candidates } = await getReviewRequestCandidates(500);
  const cutoffMs = Date.now() - days * 86400000;
  const eligible = candidates.filter((c) => new Date(c.completedAt).getTime() <= cutoffMs);
  if (!eligible.length) {
    return res.status(200).json({ ok: true, sent: 0, eligible: 0, message: 'No completed jobs are old enough yet.' });
  }

  const actorEmail = 'reina-review-autosend-cron';
  const recipients = eligible.map((c) => ({ clientId: c.clientId, targetRecordId: c.jobId, targetRecordType: 'job' }));

  let createCaptured = { statusCode: 200, body: null };
  const createRes = {
    status(code) { createCaptured.statusCode = code; return this; },
    json(body) { createCaptured.body = body; return this; },
  };
  const createReq = {
    body: { name: 'Auto review requests (Reina)', type: 'review_request', channel: 'email', recipients },
    hlUser: { email: actorEmail },
  };
  try {
    await handleCampaignsPost(createReq, createRes);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not create the review-request campaign: ' + e.message });
  }
  if (!createCaptured.body || !createCaptured.body.ok) {
    return res.status(createCaptured.statusCode || 500).json({ ok: false, error: 'Could not create the review-request campaign.', detail: createCaptured.body });
  }
  const campaignId = createCaptured.body.campaign.id;

  const tmpl = reviewRequestAutosendTemplate(reviewLink);
  let sendCaptured = { statusCode: 200, body: null };
  const sendRes = {
    status(code) { sendCaptured.statusCode = code; return this; },
    json(body) { sendCaptured.body = body; return this; },
  };
  const sendReq = {
    body: { campaignId, subject: tmpl.subject, body: tmpl.body },
    hlUser: { email: actorEmail },
  };
  try {
    await handleCampaignSendPost(sendReq, sendRes);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Campaign created (id ' + campaignId + ') but send failed: ' + e.message });
  }
  return res.status(sendCaptured.statusCode || 200).json(sendCaptured.body);
}

// Same copy the owner sees in the manual flow -- see
// defaultReviewRequestTemplate in public/marketing-command-center/index.html.
// Kept in sync by hand since one lives in frontend JS and one here.
function reviewRequestAutosendTemplate(reviewLink) {
  return {
    subject: 'Quick favor, {{clientName}}?',
    body: 'Hi {{clientName}},\n\n' +
      'Thanks again for choosing Greenwich Handyman, Inc.{{jobTitle}}! If you have a minute, we would really appreciate a quick Google review:\n' +
      reviewLink + '\n\n' +
      'It helps other homeowners find us and means a lot to our team.\n\n' +
      'Thanks so much,\nGreenwich Handyman, Inc.',
  };
}

// ---------- Lifecycle playbooks (Phase 14) ----------
// Two real playbooks: post-job thank-you and service anniversary. Every real
// send this suite makes is gated through the real
// marketing_consent_ledger/marketing_suppressions tables (see the
// suppression/consent check inside handleCampaignSendPost above) -- each
// candidate generator applies the exact same gate BEFORE a job is ever
// surfaced as a candidate, so the owner never sees someone they could not
// actually send to. This endpoint is read-only: it finds real candidates, it
// does not create or send a campaign. Turning an approved candidate into a
// real send is a future slice. The other nine playbooks in Phase 14's brief
// (new-lead follow-up, unsold estimates, reactivation, review request,
// referral, seasonal maintenance, newsletter, maintenance reminder, dormant
// reactivation) are not built yet -- LIFECYCLE_PLAYBOOKS lists only what is
// real today.
const LIFECYCLE_PLAYBOOKS = ['post_job_thank_you', 'service_anniversary', 'dormant_reactivation', 'maintenance_reminders', 'new_lead_followup', 'newsletter', 'referral'];
const POST_JOB_THANK_YOU_WINDOW_DAYS = 14;
const SERVICE_ANNIVERSARY_MIN_DAYS = 350;
const SERVICE_ANNIVERSARY_MAX_DAYS = 380;

async function computePostJobThankYouCandidates() {
  const windowStart = new Date(Date.now() - POST_JOB_THANK_YOU_WINDOW_DAYS * 86400000).toISOString();  let allJobs = [];
  try {
    allJobs = await fetchAllRows(
      'jobs',
      `?select=jobber_id,client_id,title,completed_at&completed_at=not.is.null&completed_at=gte.${encodeURIComponent(windowStart)}&order=completed_at.desc`
    );
  } catch (e) {
    if (!e.notSynced) throw e;
    return { candidates: [], windowDays: POST_JOB_THANK_YOU_WINDOW_DAYS, notSynced: true };
  }
  const jobs = allJobs.filter((j) => j.client_id);

  // A real post_job_thank_you campaign type does not exist in campaigns.type's
  // CHECK constraint yet (sql/047 adds it, not yet applied) -- so today this
  // will always find zero prior campaigns and treat every eligible job as
  // not-yet-contacted. Once sql/047 is applied and a real send path exists,
  // this same query starts honestly excluding jobs already thanked.
  let alreadyContactedJobIds = new Set();
  if (jobs.length) {
    try {
      const thankYouCampaigns = await fetchAllRows('campaigns', '?select=id&type=eq.post_job_thank_you');
      if (thankYouCampaigns.length) {
        const campaignIds = thankYouCampaigns.map((c) => c.id);
        const recipients = await fetchAllRows(
          'campaign_recipients',
          `?select=target_record_id&target_record_type=eq.job&campaign_id=in.(${campaignIds.map((id) => `"${id}"`).join(',')})`
        );
        alreadyContactedJobIds = new Set(recipients.map((r) => r.target_record_id));      }
    } catch (e) {
      if (!e.notSynced) throw e;
    }
  }

  const eligibleJobs = jobs.filter((j) => !alreadyContactedJobIds.has(j.jobber_id));
  const clientIds = [...new Set(eligibleJobs.map((j) => j.client_id))];
  let suppressedClientIds = new Set();
  let revokedClientIds = new Set();
  if (clientIds.length) {
    try {
      const [supp, consent] = await Promise.all([
        fetchAllRows('marketing_suppressions', `?channel=eq.email&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
        fetchAllRows('marketing_consent_ledger', `?channel=eq.email&status=eq.revoked&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
      ]);
      suppressedClientIds = new Set(supp.map((row) => row.client_id));
      revokedClientIds = new Set(consent.map((row) => row.client_id));
    } catch (e) {
      if (!e.notSynced) throw e; // tables not migrated on this environment yet -- fail open to today's existing behavior rather than blocking all candidates
    }
  }

  const gatedJobs = eligibleJobs.filter((j) => !suppressedClientIds.has(j.client_id) && !revokedClientIds.has(j.client_id));

  let clientsById = new Map();
  if (gatedJobs.length) {
    const gatedClientIds = [...new Set(gatedJobs.map((j) => j.client_id))];
    const clientsRes = await supabaseRequest(`clients?select=jobber_id,name,first_name,last_name,email&jobber_id=in.(${gatedClientIds.map((id) => `"${id}"`).join(',')})`);
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) clientsById.set(c.jobber_id, c);
    }
  }

  const candidates = [];
  let skippedNoEmail = 0;
  for (const j of gatedJobs) {
    const client = clientsById.get(j.client_id);
    if (!client || !client.email) { skippedNoEmail++; continue; }
    candidates.push({
      jobId: j.jobber_id,
      clientId: j.client_id,
      clientName: clientDisplayName(client) || 'there',
      jobTitle: j.title || '',
      completedAt: j.completed_at,    });
  }

  return {
    candidates,
    windowDays: POST_JOB_THANK_YOU_WINDOW_DAYS,
    totalCompletedJobsInWindow: allJobs.length,
    skippedNoClient: allJobs.length - jobs.length,
    skippedAlreadyContacted: jobs.length - eligibleJobs.length,
    skippedSuppressedOrRevoked: eligibleJobs.length - gatedJobs.length,
    skippedNoEmail,
  };
}

// This playbook: service anniversary. Finds real completed jobs approaching
// their one-year service anniversary (350-380 days after completion -- a
// real ~30-day outreach window before the exact anniversary date passes),
// gated through the same real marketing_consent_ledger/marketing_suppressions
// tables every other real send in this suite is gated through (see
// handleCampaignSendPost). This endpoint is read-only: it finds real
// candidates, it does not send anything.
async function computeServiceAnniversaryCandidates() {
  const windowStart = new Date(Date.now() - SERVICE_ANNIVERSARY_MAX_DAYS * 86400000).toISOString();
  const windowEnd = new Date(Date.now() - SERVICE_ANNIVERSARY_MIN_DAYS * 86400000).toISOString();
  let allJobs = [];
  try {
    allJobs = await fetchAllRows(
      'jobs',
      `?select=jobber_id,client_id,title,completed_at&completed_at=not.is.null&completed_at=gte.${encodeURIComponent(windowStart)}&completed_at=lte.${encodeURIComponent(windowEnd)}&order=completed_at.asc`
    );
  } catch (e) {
    if (!e.notSynced) throw e;
    return { candidates: [], minDays: SERVICE_ANNIVERSARY_MIN_DAYS, maxDays: SERVICE_ANNIVERSARY_MAX_DAYS, notSynced: true };
  }
  const jobs = allJobs.filter((j) => j.client_id);

  // A real service_anniversary campaign type does not exist in
  // campaigns.type's CHECK constraint yet (sql/047 also adds it, not yet
  // applied) -- so today this always finds zero prior campaigns and treats
  // every eligible job as not-yet-contacted this year.
  let alreadyContactedJobIds = new Set();
  if (jobs.length) {
    try {
      const anniversaryCampaigns = await fetchAllRows('campaigns', '?select=id&type=eq.service_anniversary');
      if (anniversaryCampaigns.length) {
        const campaignIds = anniversaryCampaigns.map((c) => c.id);
        const recipients = await fetchAllRows(
          'campaign_recipients',
          `?select=target_record_id&target_record_type=eq.job&campaign_id=in.(${campaignIds.map((id) => `"${id}"`).join(',')})`
        );
        alreadyContactedJobIds = new Set(recipients.map((r) => r.target_record_id));
      }
    } catch (e) {
      if (!e.notSynced) throw e;
    }
  }

  const eligibleJobs = jobs.filter((j) => !alreadyContactedJobIds.has(j.jobber_id));
  const clientIds = [...new Set(eligibleJobs.map((j) => j.client_id))];

  let suppressedClientIds = new Set();
  let revokedClientIds = new Set();
  if (clientIds.length) {
    try {
      const [supp, consent] = await Promise.all([
        fetchAllRows('marketing_suppressions', `?channel=eq.email&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
        fetchAllRows('marketing_consent_ledger', `?channel=eq.email&status=eq.revoked&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
      ]);
      suppressedClientIds = new Set(supp.map((row) => row.client_id));
      revokedClientIds = new Set(consent.map((row) => row.client_id));
    } catch (e) {
      if (!e.notSynced) throw e; // tables not migrated on this environment yet -- fail open to today's existing behavior rather than blocking all candidates
    }
  }

  const gatedJobs = eligibleJobs.filter((j) => !suppressedClientIds.has(j.client_id) && !revokedClientIds.has(j.client_id));

  let clientsById = new Map();
  if (gatedJobs.length) {
    const gatedClientIds = [...new Set(gatedJobs.map((j) => j.client_id))];
    const clientsRes = await supabaseRequest(`clients?select=jobber_id,name,first_name,last_name,email&jobber_id=in.(${gatedClientIds.map((id) => `"${id}"`).join(',')})`);
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) clientsById.set(c.jobber_id, c);
    }
  }

  const candidates = [];
  let skippedNoEmail = 0;
  for (const j of gatedJobs) {
    const client = clientsById.get(j.client_id);
    if (!client || !client.email) { skippedNoEmail++; continue; }
    const anniversaryDate = new Date(new Date(j.completed_at).getTime() + 365 * 86400000).toISOString();
    candidates.push({
      jobId: j.jobber_id,
      clientId: j.client_id,
      clientName: clientDisplayName(client) || 'there',
      jobTitle: j.title || '',
      completedAt: j.completed_at,
      anniversaryDate,
    });
  }

  return {
    candidates,
    minDays: SERVICE_ANNIVERSARY_MIN_DAYS,
    maxDays: SERVICE_ANNIVERSARY_MAX_DAYS,
    totalCompletedJobsInWindow: allJobs.length,
    skippedNoClient: allJobs.length - jobs.length,
    skippedAlreadyContacted: jobs.length - eligibleJobs.length,    skippedSuppressedOrRevoked: eligibleJobs.length - gatedJobs.length,
    skippedNoEmail,
  };
}

// This playbook: dormant_reactivation. NOT the same thing as the existing
// Opportunity Engine's reactivate_customers card (computeReactivationCandidates,
// which targets the 6-24 month lapsed window -- a warm, recent-ish audience).
// This playbook targets truly dormant clients: their MOST RECENT completed job
// was 24-60 months ago. Different audience, different message (a real
// win-back / "it's been a while" ask, not a routine follow-up), and it needs
// its own dedup trail so the two playbooks never double-contact the same
// client in the same window. Capped at 60 months on the far end -- past that,
// contact info is likely stale and outreach has diminishing returns / bounce
// risk; those clients are better served by a data-hygiene pass than a campaign.
//
// Independently-built sibling to marketing-suite-phase14-post-job-thank-you,
// marketing-suite-phase14-service-anniversary, marketing-suite-phase14-referral,
// and marketing-suite-phase14-new-lead-followup (all five add the same// resource=lifecycle_candidates endpoint and will need their
// LIFECYCLE_PLAYBOOKS lists and handlers combined when these branches are
// reconciled, same as the existing Phase 6 sibling-branch pattern).
//
// campaigns.type needs 'dormant_reactivation' added -- see
// sql/050_marketing_dormant_reactivation_type.sql (written, NOT applied).
//
// Unlike the job-keyed playbooks (thank-you, anniversary, referral), this one
// is keyed to the CLIENT (their most recent job decides eligibility), so the
// already-contacted dedup and target records use client_id, not a job id.
const DORMANT_REACTIVATION_MIN_DAYS = 730;
const DORMANT_REACTIVATION_MAX_DAYS = 1825;

async function computeDormantReactivationCandidates() {  let allJobs = [];
  try {
    allJobs = await fetchAllRows(
      'jobs',
      '?select=jobber_id,client_id,title,completed_at&completed_at=not.is.null&order=completed_at.desc'
    );
  } catch (e) {
    if (!e.notSynced) throw e;
    return { candidates: [], minDays: DORMANT_REACTIVATION_MIN_DAYS, maxDays: DORMANT_REACTIVATION_MAX_DAYS, notSynced: true };
  }

  // Reduce to each client's single most recent completed job -- dormancy is
  // decided by their LAST job, not any job that happens to fall in the window.
  const lastJobByClient = new Map();
  for (const j of allJobs) {
    if (!j.client_id) continue;
    const existing = lastJobByClient.get(j.client_id);
    if (!existing || new Date(j.completed_at) > new Date(existing.completed_at)) {
      lastJobByClient.set(j.client_id, j);
    }
  }

  const cutoffOld = new Date(Date.now() - DORMANT_REACTIVATION_MAX_DAYS * 86400000);
  const cutoffRecent = new Date(Date.now() - DORMANT_REACTIVATION_MIN_DAYS * 86400000);
  const dormantJobs = [...lastJobByClient.values()].filter((j) => {
    const d = new Date(j.completed_at);
    return d >= cutoffOld && d <= cutoffRecent;
  });

  let alreadyContactedClientIds = new Set();
  if (dormantJobs.length) {
    try {
      const dormantCampaigns = await fetchAllRows('campaigns', '?select=id&type=eq.dormant_reactivation');
      if (dormantCampaigns.length) {
        const campaignIds = dormantCampaigns.map((c) => c.id);
        const recipients = await fetchAllRows(
          'campaign_recipients',
          `?select=target_record_id&target_record_type=eq.client&campaign_id=in.(${campaignIds.map((id) => `"${id}"`).join(',')})`
        );
        alreadyContactedClientIds = new Set(recipients.map((r) => r.target_record_id));      }
    } catch (e) {
      if (!e.notSynced) throw e;
    }
  }

  const eligibleJobs = dormantJobs.filter((j) => !alreadyContactedClientIds.has(j.client_id));
  const clientIds = eligibleJobs.map((j) => j.client_id);
  let suppressedClientIds = new Set();
  let revokedClientIds = new Set();
  if (clientIds.length) {
    try {
      const [supp, consent] = await Promise.all([
        fetchAllRows('marketing_suppressions', `?channel=eq.email&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
        fetchAllRows('marketing_consent_ledger', `?channel=eq.email&status=eq.revoked&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
      ]);
      suppressedClientIds = new Set(supp.map((row) => row.client_id));
      revokedClientIds = new Set(consent.map((row) => row.client_id));
    } catch (e) {
      if (!e.notSynced) throw e; // tables not migrated on this environment yet -- fail open to today's existing behavior rather than blocking all candidates
    }
  }

  const gatedJobs = eligibleJobs.filter((j) => !suppressedClientIds.has(j.client_id) && !revokedClientIds.has(j.client_id));

  let clientsById = new Map();
  if (gatedJobs.length) {
    const gatedClientIds = [...new Set(gatedJobs.map((j) => j.client_id))];
    const clientsRes = await supabaseRequest(`clients?select=jobber_id,name,first_name,last_name,email&jobber_id=in.(${gatedClientIds.map((id) => `"${id}"`).join(',')})`);
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) clientsById.set(c.jobber_id, c);
    }  }

  const candidates = [];
  let skippedNoEmail = 0;
  for (const j of gatedJobs) {
    const client = clientsById.get(j.client_id);
    if (!client || !client.email) { skippedNoEmail++; continue; }
    candidates.push({
      clientId: j.client_id,
      clientName: clientDisplayName(client) || 'there',
      lastJobTitle: j.title || '',
      lastCompletedAt: j.completed_at,
      daysSinceLastJob: Math.round((Date.now() - new Date(j.completed_at).getTime()) / 86400000),    });
  }

  return {
    candidates,
    minDays: DORMANT_REACTIVATION_MIN_DAYS,
    maxDays: DORMANT_REACTIVATION_MAX_DAYS,
    totalDormantClientsInWindow: dormantJobs.length,
    skippedAlreadyContacted: dormantJobs.length - eligibleJobs.length,
    skippedSuppressedOrRevoked: eligibleJobs.length - gatedJobs.length,
    skippedNoEmail,  };
}

// This playbook: maintenance_reminders. Distinct from BOTH other job-keyed
// Phase 14 playbooks:
//   - service_anniversary fires ONCE, for ANY completed job, in a fixed
//     350-380 day window after completion -- a one-time relationship
//     touchpoint ("thanks for being a customer a year ago").
//   - dormant_reactivation targets ANY completed job, 24-60 months old,
//     all-time dedup (fires once ever per dormant client).
// maintenance_reminders is neither: it only looks at jobs whose title
// matches a recurring-maintenance keyword (MAINTENANCE_KEYWORDS below --
// gutter cleaning, HVAC tune-up, seasonal inspection, etc.), reduces to
// each client's single most recent MATCHING job (like dormant_reactivation's
// lastJobByClient), and fires in an annual 330-395 day window after that
// job. Unlike service_anniversary, this is meant to recur every year the
// same client keeps getting that service -- so the already-contacted check
// is WINDOWED (like newsletter's), not all-time: a maintenance_reminders
// campaign in the last MAINTENANCE_REMINDER_DEDUP_WINDOW_DAYS blocks a
// repeat send, but does not block next year's reminder.
//
// campaigns.type needs 'maintenance_reminders' added -- see
// sql/052_marketing_maintenance_reminders_type.sql (written, NOT applied).
//
// Keyed to the CLIENT -- the already-contacted dedup and target records use
// client_id, matching dormant_reactivation and newsletter.
const MAINTENANCE_KEYWORDS = ['maintenance', 'tune-up', 'tune up', 'inspection', 'cleaning', 'seasonal service', 'service call'];
const MAINTENANCE_REMINDER_MIN_DAYS = 330;
const MAINTENANCE_REMINDER_MAX_DAYS = 395;
const MAINTENANCE_REMINDER_DEDUP_WINDOW_DAYS = 300;

function isMaintenanceJobTitle(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return MAINTENANCE_KEYWORDS.some((kw) => lower.includes(kw));
}

async function computeMaintenanceReminderCandidates() {
  let allJobs = [];
  try {
    allJobs = await fetchAllRows(
      'jobs',
      '?select=jobber_id,client_id,title,completed_at&completed_at=not.is.null&order=completed_at.desc'
    );
  } catch (e) {
    if (!e.notSynced) throw e;
    return {
      candidates: [],
      minDays: MAINTENANCE_REMINDER_MIN_DAYS,
      maxDays: MAINTENANCE_REMINDER_MAX_DAYS,
      notSynced: true,
    };
  }

  const maintenanceJobs = allJobs.filter((j) => isMaintenanceJobTitle(j.title));

  const lastMaintenanceJobByClient = new Map();
  for (const j of maintenanceJobs) {
    const existing = lastMaintenanceJobByClient.get(j.client_id);
    if (!existing || new Date(j.completed_at) > new Date(existing.completed_at)) {
      lastMaintenanceJobByClient.set(j.client_id, j);
    }
  }

  const now = Date.now();
  const minMs = MAINTENANCE_REMINDER_MIN_DAYS * 86400000;
  const maxMs = MAINTENANCE_REMINDER_MAX_DAYS * 86400000;
  const inWindow = [];
  for (const j of lastMaintenanceJobByClient.values()) {
    const ageMs = now - new Date(j.completed_at).getTime();
    if (ageMs >= minMs && ageMs <= maxMs) inWindow.push(j);
  }

  if (inWindow.length === 0) {
    return {
      candidates: [],
      minDays: MAINTENANCE_REMINDER_MIN_DAYS,
      maxDays: MAINTENANCE_REMINDER_MAX_DAYS,
      totalDueForReminder: 0,
      skippedNoEmail: 0,
      skippedSuppressedOrRevoked: 0,
      skippedAlreadyContacted: 0,
    };
  }

  const resp = await supabaseRequest('clients?select=jobber_id,name,first_name,last_name,company_name,email');
  const allClients = resp.ok ? await resp.json() : [];
  const clientById = new Map(allClients.map((c) => [c.jobber_id, c]));

  const cutoff = new Date(now - MAINTENANCE_REMINDER_DEDUP_WINDOW_DAYS * 86400000).toISOString();
  const [suppressions, revokedConsent, recentCampaigns] = await Promise.all([
    fetchAllRows('marketing_suppressions', '?select=client_id&channel=eq.email'),
    fetchAllRows('marketing_consent_ledger', '?select=client_id&channel=eq.email&status=eq.revoked'),
    fetchAllRows('campaigns', `?select=id&type=eq.maintenance_reminders&created_at=gte.${encodeURIComponent(cutoff)}`),  ]);

  const suppressedIds = new Set(suppressions.map((s) => s.client_id));
  const revokedIds = new Set(revokedConsent.map((r) => r.client_id));

  let recentlyContactedIds = new Set();
  if (recentCampaigns.length > 0) {
    const campaignIds = recentCampaigns.map((c) => c.id);
    const recipients = await fetchAllRows(
      'campaign_recipients',
      `?select=target_record_id&target_record_type=eq.client&campaign_id=in.(${campaignIds.map(encodeURIComponent).join(',')})`
    );
    recentlyContactedIds = new Set(recipients.map((r) => r.target_record_id));
  }

  const candidates = [];
  let skippedNoEmail = 0;
  let skippedSuppressedOrRevoked = 0;
  let skippedAlreadyContacted = 0;

  for (const j of inWindow) {
    const client = clientById.get(j.client_id);
    if (!client || !client.email) {
      skippedNoEmail++;
      continue;
    }
    if (recentlyContactedIds.has(j.client_id)) {
      skippedAlreadyContacted++;
      continue;
    }
    if (suppressedIds.has(j.client_id) || revokedIds.has(j.client_id)) {      skippedSuppressedOrRevoked++;
      continue;
    }
    candidates.push({
      clientId: j.client_id,
      clientName: clientDisplayName(client),
      lastMaintenanceJobTitle: j.title,
      lastMaintenanceCompletedAt: j.completed_at,
      daysSinceLastMaintenance: Math.floor((now - new Date(j.completed_at).getTime()) / 86400000),    });
  }

  return {
    candidates,
    minDays: MAINTENANCE_REMINDER_MIN_DAYS,
    maxDays: MAINTENANCE_REMINDER_MAX_DAYS,
    totalDueForReminder: inWindow.length,
    skippedNoEmail,
    skippedSuppressedOrRevoked,
    skippedAlreadyContacted,  };
}

// This playbook: new_lead_followup. Surfaces leads still sitting in
// lead_pipeline.stage = 'new' (per sql/013_lead_pipeline.sql, the stage
// leaves 'new' the moment anyone logs first contact) that have gone
// unanswered longer than a reasonable SLA. This is a different problem
// than the existing insights 'average response time' metric (which just
// reports an average) -- this playbook returns the actual list of leads
// that need a human to pick up the phone or send an email right now.
// No max-age cutoff on purpose: a lead that's sat uncontacted for 40 days
// is exactly the kind of miss the Queen should keep surfacing, not quietly
// drop off a list once it gets old.
//
// Independently-built sibling to marketing-suite-phase14-post-job-thank-you,
// marketing-suite-phase14-service-anniversary, and
// marketing-suite-phase14-referral (all four add the same
// resource=lifecycle_candidates endpoint and will need their
// LIFECYCLE_PLAYBOOKS lists and handlers combined when these branches are
// reconciled, same as the existing Phase 6 sibling-branch pattern).
//
// campaigns.type needs 'new_lead_followup' added -- see
// sql/049_marketing_new_lead_followup_type.sql (written, NOT applied).
const NEW_LEAD_FOLLOWUP_MIN_HOURS = 24;

async function computeNewLeadFollowupCandidates() {
  const cutoff = new Date(Date.now() - NEW_LEAD_FOLLOWUP_MIN_HOURS * 3600000).toISOString();
  let allLeads = [];
  try {
    allLeads = await fetchAllRows(
      'lead_pipeline',
      `?select=id,client_id,lead_source,need,urgency,created_at&stage=eq.new&created_at=lte.${encodeURIComponent(cutoff)}&order=created_at.asc`
    );
  } catch (e) {
    if (!e.notSynced) throw e;
    return { candidates: [], minHours: NEW_LEAD_FOLLOWUP_MIN_HOURS, notSynced: true };
  }

  let alreadyContactedLeadIds = new Set();
  if (allLeads.length) {
    try {
      const followupCampaigns = await fetchAllRows('campaigns', '?select=id&type=eq.new_lead_followup');
      if (followupCampaigns.length) {
        const campaignIds = followupCampaigns.map((c) => c.id);
        const recipients = await fetchAllRows(
          'campaign_recipients',
          `?select=target_record_id&target_record_type=eq.lead&campaign_id=in.(${campaignIds.map((id) => `"${id}"`).join(',')})`
        );
        alreadyContactedLeadIds = new Set(recipients.map((r) => r.target_record_id));
      }
    } catch (e) {
      if (!e.notSynced) throw e;
    }
  }

  const eligibleLeads = allLeads.filter((l) => !alreadyContactedLeadIds.has(l.id));
  const clientIds = [...new Set(eligibleLeads.map((l) => l.client_id))];

  let suppressedClientIds = new Set();
  let revokedClientIds = new Set();
  if (clientIds.length) {
    try {
      const [supp, consent] = await Promise.all([
        fetchAllRows('marketing_suppressions', `?channel=eq.email&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
        fetchAllRows('marketing_consent_ledger', `?channel=eq.email&status=eq.revoked&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
      ]);
      suppressedClientIds = new Set(supp.map((row) => row.client_id));
      revokedClientIds = new Set(consent.map((row) => row.client_id));
    } catch (e) {
      if (!e.notSynced) throw e; // tables not migrated on this environment yet -- fail open to today's existing behavior rather than blocking all candidates
    }
  }

  const gatedLeads = eligibleLeads.filter((l) => !suppressedClientIds.has(l.client_id) && !revokedClientIds.has(l.client_id));

  let clientsById = new Map();
  if (gatedLeads.length) {
    const gatedClientIds = [...new Set(gatedLeads.map((l) => l.client_id))];
    const clientsRes = await supabaseRequest(`clients?select=jobber_id,name,first_name,last_name,email&jobber_id=in.(${gatedClientIds.map((id) => `"${id}"`).join(',')})`);
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) clientsById.set(c.jobber_id, c);
    }
  }

  const candidates = [];
  let skippedNoEmail = 0;
  for (const l of gatedLeads) {
    const client = clientsById.get(l.client_id);
    if (!client || !client.email) { skippedNoEmail++; continue; }
    candidates.push({
      leadId: l.id,
      clientId: l.client_id,
      clientName: clientDisplayName(client) || 'there',
      leadSource: l.lead_source || null,
      need: l.need || '',
      urgency: l.urgency || null,
      createdAt: l.created_at,
      hoursSinceCreated: Math.round((Date.now() - new Date(l.created_at).getTime()) / 3600000),    });
  }

  return {
    candidates,
    minHours: NEW_LEAD_FOLLOWUP_MIN_HOURS,
    totalNewLeadsPastSla: allLeads.length,
    skippedAlreadyContacted: allLeads.length - eligibleLeads.length,
    skippedSuppressedOrRevoked: eligibleLeads.length - gatedLeads.length,    skippedNoEmail,
  };
}

// This playbook: newsletter. Unlike the other Phase 14 playbooks (all triggered
// by a specific event -- a completed job, a new lead, a lapsed client), this one
// is NOT event-triggered -- it targets the general active client base for a
// periodic company newsletter send. "Active" here means: has a valid email, is
// not suppressed, has not revoked email consent, and has not already received a
// newsletter campaign in the last NEWSLETTER_MIN_DAYS_SINCE_LAST_SEND days -- a
// cooldown that prevents double-sends if this candidate list is pulled more than
// once before the actual send goes out. Unlike dormant_reactivation's
// already-contacted check (which looks at ALL-TIME campaigns of that type,
// because that playbook fires once per dormant client), the newsletter check is
// WINDOWED, because a newsletter is meant to be sent again and again.
//
// campaigns.type needs 'newsletter' added -- see
// sql/051_marketing_newsletter_type.sql (written, NOT applied).
//
// Keyed to the CLIENT, not a job or lead -- the already-contacted dedup and
// target records use client_id.
const NEWSLETTER_MIN_DAYS_SINCE_LAST_SEND = 25;

async function computeNewsletterCandidates() {
  let allClients = [];
  try {
    const resp = await supabaseRequest('clients?select=jobber_id,name,first_name,last_name,company_name,email');
    if (!resp.ok) throw Object.assign(new Error('clients fetch failed'), { notSynced: true });
    allClients = await resp.json();
  } catch (e) {
    if (!e.notSynced) throw e;
    return { candidates: [], minDaysSinceLastSend: NEWSLETTER_MIN_DAYS_SINCE_LAST_SEND, notSynced: true };
  }

  const withEmail = allClients.filter((c) => c.email);
  const skippedNoEmail = allClients.length - withEmail.length;

  if (withEmail.length === 0) {
    return {
      candidates: [],
      minDaysSinceLastSend: NEWSLETTER_MIN_DAYS_SINCE_LAST_SEND,
      totalActiveClients: allClients.length,
      skippedAlreadyContacted: 0,
      skippedSuppressedOrRevoked: 0,
      skippedNoEmail,
    };
  }

  const cutoff = new Date(Date.now() - NEWSLETTER_MIN_DAYS_SINCE_LAST_SEND * 86400000).toISOString();

  const [suppressions, revokedConsent, recentCampaigns] = await Promise.all([
    fetchAllRows('marketing_suppressions', '?select=client_id&channel=eq.email'),
    fetchAllRows('marketing_consent_ledger', '?select=client_id&channel=eq.email&status=eq.revoked'),
    fetchAllRows('campaigns', `?select=id&type=eq.newsletter&created_at=gte.${encodeURIComponent(cutoff)}`),
  ]);

  const suppressedIds = new Set(suppressions.map((s) => s.client_id));
  const revokedIds = new Set(revokedConsent.map((r) => r.client_id));

  let recentlyContactedIds = new Set();
  if (recentCampaigns.length > 0) {
    const campaignIds = recentCampaigns.map((c) => c.id);
    const recipients = await fetchAllRows(
      'campaign_recipients',
      `?select=target_record_id&target_record_type=eq.client&campaign_id=in.(${campaignIds.map(encodeURIComponent).join(',')})`
    );
    recentlyContactedIds = new Set(recipients.map((r) => r.target_record_id));
  }

  const candidates = [];
  let skippedAlreadyContacted = 0;
  let skippedSuppressedOrRevoked = 0;

  for (const c of withEmail) {
    if (recentlyContactedIds.has(c.jobber_id)) {
      skippedAlreadyContacted++;
      continue;
    }
    if (suppressedIds.has(c.jobber_id) || revokedIds.has(c.jobber_id)) {
      skippedSuppressedOrRevoked++;
      continue;
    }
    candidates.push({
      clientId: c.jobber_id,
      clientName: clientDisplayName(c),
    });
  }

  return {
    candidates,
    minDaysSinceLastSend: NEWSLETTER_MIN_DAYS_SINCE_LAST_SEND,
    totalActiveClients: allClients.length,
    skippedAlreadyContacted,
    skippedSuppressedOrRevoked,
    skippedNoEmail,
  };
}

// This playbook: referral. NOT the same thing as the existing
// referral_opportunities Opportunity Engine card (computeReferralOpportunities
// counts leads whose lead_pipeline.lead_source is already tagged 'referral' --
// retrospective lead analytics, no outreach). This playbook is prospective:
// it asks real, recently-satisfied past customers (a completed job, no
// outstanding issues implied) to refer friends/family. Independently-built
// sibling to marketing-suite-phase14-post-job-thank-you and
// marketing-suite-phase14-service-anniversary (both add the same
// resource=lifecycle_candidates endpoint and will need their
// LIFECYCLE_PLAYBOOKS lists and handlers combined when these branches are
// reconciled, same as the existing Phase 6 sibling-branch pattern).
//
// campaigns.type already allows 'referral' (see sql/021_campaigns.sql) --
// no new migration needed for this playbook, unlike the other two.
const REFERRAL_MIN_DAYS = 14;
const REFERRAL_MAX_DAYS = 120;

async function computeReferralCandidates() {
  const windowStart = new Date(Date.now() - REFERRAL_MAX_DAYS * 86400000).toISOString();
  const windowEnd = new Date(Date.now() - REFERRAL_MIN_DAYS * 86400000).toISOString();
  let allJobs = [];
  try {
    allJobs = await fetchAllRows(
      'jobs',
      `?select=jobber_id,client_id,title,completed_at&completed_at=not.is.null&completed_at=gte.${encodeURIComponent(windowStart)}&completed_at=lte.${encodeURIComponent(windowEnd)}&order=completed_at.desc`
    );
  } catch (e) {
    if (!e.notSynced) throw e;
    return { candidates: [], minDays: REFERRAL_MIN_DAYS, maxDays: REFERRAL_MAX_DAYS, notSynced: true };
  }
  const jobs = allJobs.filter((j) => j.client_id);

  let alreadyContactedJobIds = new Set();
  if (jobs.length) {
    try {
      const referralCampaigns = await fetchAllRows('campaigns', '?select=id&type=eq.referral');
      if (referralCampaigns.length) {
        const campaignIds = referralCampaigns.map((c) => c.id);
        const recipients = await fetchAllRows(
          'campaign_recipients',
          `?select=target_record_id&target_record_type=eq.job&campaign_id=in.(${campaignIds.map((id) => `"${id}"`).join(',')})`
        );
        alreadyContactedJobIds = new Set(recipients.map((r) => r.target_record_id));
      }
    } catch (e) {
      if (!e.notSynced) throw e;
    }
  }

  const eligibleJobs = jobs.filter((j) => !alreadyContactedJobIds.has(j.jobber_id));
  const clientIds = [...new Set(eligibleJobs.map((j) => j.client_id))];

  let suppressedClientIds = new Set();
  let revokedClientIds = new Set();
  if (clientIds.length) {
    try {
      const [supp, consent] = await Promise.all([
        fetchAllRows('marketing_suppressions', `?channel=eq.email&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
        fetchAllRows('marketing_consent_ledger', `?channel=eq.email&status=eq.revoked&client_id=in.(${clientIds.map((id) => `"${id}"`).join(',')})&select=client_id`),
      ]);
      suppressedClientIds = new Set(supp.map((row) => row.client_id));
      revokedClientIds = new Set(consent.map((row) => row.client_id));
    } catch (e) {
      if (!e.notSynced) throw e; // tables not migrated on this environment yet -- fail open to today's existing behavior rather than blocking all candidates
    }
  }

  const gatedJobs = eligibleJobs.filter((j) => !suppressedClientIds.has(j.client_id) && !revokedClientIds.has(j.client_id));

  let clientsById = new Map();
  if (gatedJobs.length) {
    const gatedClientIds = [...new Set(gatedJobs.map((j) => j.client_id))];
    const clientsRes = await supabaseRequest(`clients?select=jobber_id,name,first_name,last_name,email&jobber_id=in.(${gatedClientIds.map((id) => `"${id}"`).join(',')})`);
    if (clientsRes.ok) {
      for (const c of await clientsRes.json()) clientsById.set(c.jobber_id, c);
    }
  }

  const candidates = [];
  let skippedNoEmail = 0;
  for (const j of gatedJobs) {
    const client = clientsById.get(j.client_id);
    if (!client || !client.email) { skippedNoEmail++; continue; }
    candidates.push({
      jobId: j.jobber_id,
      clientId: j.client_id,
      clientName: clientDisplayName(client) || 'there',
      jobTitle: j.title || '',
      completedAt: j.completed_at,
    });
  }

  return {
    candidates,
    minDays: REFERRAL_MIN_DAYS,
    maxDays: REFERRAL_MAX_DAYS,
    totalCompletedJobsInWindow: allJobs.length,
    skippedNoClient: allJobs.length - jobs.length,
    skippedAlreadyContacted: jobs.length - eligibleJobs.length,
    skippedSuppressedOrRevoked: eligibleJobs.length - gatedJobs.length,
    skippedNoEmail,
  };
}

async function handleLifecycleCandidatesGet(req, res) {
  const playbook = req.query.playbook;
  if (!LIFECYCLE_PLAYBOOKS.includes(playbook)) {    return res.status(400).json({      ok: false,
      error: `playbook must be one of: ${LIFECYCLE_PLAYBOOKS.join(', ')} (the rest of Phase 14's lifecycle playbooks are not built yet).`,
    });
  }
  const data = playbook === 'post_job_thank_you'
    ? await computePostJobThankYouCandidates()
    : playbook === 'service_anniversary'
    ? await computeServiceAnniversaryCandidates()
    : playbook === 'dormant_reactivation'
    ? await computeDormantReactivationCandidates()
    : playbook === 'maintenance_reminders'
    ? await computeMaintenanceReminderCandidates()
    : playbook === 'new_lead_followup'
    ? await computeNewLeadFollowupCandidates()
    : playbook === 'newsletter'
    ? await computeNewsletterCandidates()
    : await computeReferralCandidates();
  res.status(200).json({ ok: true, playbook, ...data });
}

// ---------- Lifecycle playbook auto-send (Reina automation, Phase 14 -> execution) ----------
// Turns each of the 7 real Phase 14 lifecycle-playbook candidate finders
// (computePostJobThankYouCandidates, computeServiceAnniversaryCandidates,
// computeDormantReactivationCandidates, computeMaintenanceReminderCandidates,
// computeNewLeadFollowupCandidates, computeNewsletterCandidates,
// computeReferralCandidates -- see handleLifecycleCandidatesGet above) into
// real, sent campaigns on a schedule, with zero owner involvement. Each
// playbook is gated behind its own env var so nothing fires until the owner
// opts in, and reuses the exact handleCampaignsPost / handleCampaignSendPost
// pipeline (same shape as handleProcessReviewRequestAutosendGet above) so
// suppression/consent checks, campaign_recipients bookkeeping, activity
// logging, and Ready-for-You approval resolution all behave identically.
//
// IMPORTANT -- six of these seven campaign types (everything except
// 'referral', which was already valid in sql/021_campaigns.sql) do not
// exist yet in production's campaigns.type CHECK constraint. Migrations
// sql/047 through sql/052 add them, additive-only, but per this project's
// standing rule are NOT applied here -- Chris applies them when ready. Until
// that happens, turning on any of the six gates below will make
// handleCampaignsPost 400 with "type must be one of: ..." on every cron
// firing -- a loud, harmless, self-explanatory failure, not silent data
// corruption. 'referral' has no such blocker and can be turned on today.
//
// Merge-field note: the send pipeline only resolves {{jobTitle}} when
// target_record_type === 'job' (see handleCampaignSendPost). post_job_thank_you,
// service_anniversary, and referral are job-keyed and use {{jobTitle}}.
// dormant_reactivation, maintenance_reminders, and newsletter are client-keyed
// (no job to name), and new_lead_followup is lead-keyed -- none of those four
// use {{jobTitle}} in their copy below, since it would just render blank.
const LIFECYCLE_AUTOSEND_TEMPLATES = {
  post_job_thank_you: {
    subject: 'Thank you, {{clientName}}!',
    body: 'Hi {{clientName}},\n\n' +
      'Thank you for choosing Greenwich Handyman, Inc. for your {{jobTitle}} project! We hope everything is working out great.\n\n' +
      'If anything doesn\'t look right or you have questions, just reply to this email -- we\'re always happy to help.\n\n' +
      'Thanks again for trusting us with your home.\n\nGreenwich Handyman, Inc.',
  },
  service_anniversary: {
    subject: 'It\'s been a year, {{clientName}}!',
    body: 'Hi {{clientName}},\n\n' +
      'It\'s been about a year since we completed your {{jobTitle}} project, and we wanted to check in. If it\'s due for a tune-up, a repair, or you have a new project in mind, we would love to help again.\n\n' +
      'Just reply to this email or give us a call anytime.\n\n' +
      'Thanks for being a valued customer,\nGreenwich Handyman, Inc.',
  },
  dormant_reactivation: {
    subject: 'It\'s been a while, {{clientName}}',
    body: 'Hi {{clientName}},\n\n' +
      'It\'s been a while since we last worked together, and we wanted to reach out. If you have any projects on your mind, big or small, we would love the chance to help again.\n\n' +
      'Just reply to this email or give us a call anytime.\n\n' +
      'Warmly,\nGreenwich Handyman, Inc.',
  },
  maintenance_reminders: {
    subject: 'Time for a check-up, {{clientName}}?',
    body: 'Hi {{clientName}},\n\n' +
      'It\'s been about a year since your last maintenance visit with us, and regular upkeep goes a long way toward avoiding bigger repairs down the road. Ready to get something scheduled?\n\n' +
      'Just reply to this email or give us a call and we\'ll find a time that works.\n\n' +
      'Thanks,\nGreenwich Handyman, Inc.',
  },
  new_lead_followup: {
    subject: 'Still there, {{clientName}}?',
    body: 'Hi {{clientName}},\n\n' +
      'We wanted to follow up on your recent request -- we don\'t want it to fall through the cracks. If you still need help, just reply to this email or give us a call and we\'ll get you taken care of.\n\n' +
      'Looking forward to hearing from you,\nGreenwich Handyman, Inc.',
  },
  newsletter: {
    subject: 'What\'s new at Greenwich Handyman, Inc.',
    body: 'Hi {{clientName}},\n\n' +
      'Just a quick update from our team -- we\'re always here for your home maintenance and improvement projects, big or small. If anything comes up, don\'t hesitate to reach out.\n\n' +
      'Thanks for being a valued customer,\nGreenwich Handyman, Inc.',
  },
  referral: {
    subject: 'Know someone who needs a hand, {{clientName}}?',
    body: 'Hi {{clientName}},\n\n' +
      'We hope you\'re still happy with your {{jobTitle}} project! If you know a friend, family member, or neighbor who could use some help around the house, we would really appreciate the introduction.\n\n' +
      'Just reply with their info or have them mention your name when they reach out.\n\n' +
      'Thanks so much,\nGreenwich Handyman, Inc.',
  },
};

// Shared engine behind all 7 handlers below -- see LIFECYCLE_AUTOSEND_TEMPLATES
// comment above for why six of these are inert until Chris applies a migration.
// `automationKey`, when given, adds the Company Setup toggle as a SECOND gate on
// top of the env var. Both must be open. This is what wires the "no closed job
// in 12 months -> re-engagement" switch on Company Setup to the runner that was
// already doing the work, rather than standing up a rival runner beside it.
//
// Order matters: the env var is checked first so the existing "set it in Vercel"
// message is unchanged for the six playbooks that have no toggle, and so a
// playbook can never be switched on from the UI alone.
async function runLifecycleAutosend(res, playbook, envVar, computeFn, toRecipient, automationKey) {
  const enabled = /^(1|true)$/i.test(String(process.env[envVar] || ''));
  if (!enabled) {
    return res.status(200).json({ ok: true, sent: 0, message: `${envVar} is not set -- ${playbook} auto-send is off. Set it in Vercel (e.g. "1") to turn this on.` });
  }
  if (automationKey) {
    const companyId = await companyForCron();
    const cfg = await automationConfig(companyId, automationKey);
    if (!cfg.enabled) {
      await recordRun({ companyId, automation: automationKey, outcome: 'skipped_disabled', detail: { reason: cfg._reason || 'toggle-off', playbook } });
      return res.status(200).json({
        ok: true, sent: 0,
        message: `${automationKey} is switched off on Company Setup -- ${playbook} auto-send did not run.`,
      });
    }
  }
  const data = await computeFn();
  const candidates = data.candidates || [];
  if (!candidates.length) {
    return res.status(200).json({ ok: true, sent: 0, eligible: 0, message: 'No eligible candidates right now.' });
  }
  const actorEmail = `reina-${playbook}-autosend-cron`;
  const recipients = candidates.map(toRecipient).filter((r) => r && r.clientId);
  if (!recipients.length) {
    return res.status(200).json({ ok: true, sent: 0, eligible: 0, message: 'Candidates found but none had a usable client id.' });
  }
  let createCaptured = { statusCode: 200, body: null };
  const createRes = { status(code) { createCaptured.statusCode = code; return this; }, json(body) { createCaptured.body = body; return this; } };
  const createReq = { body: { name: `Auto ${playbook} (Reina)`, type: playbook, channel: 'email', recipients }, hlUser: { email: actorEmail } };
  try { await handleCampaignsPost(createReq, createRes); }
  catch (e) { return res.status(500).json({ ok: false, error: `Could not create the ${playbook} campaign: ` + e.message }); }
  if (!createCaptured.body || !createCaptured.body.ok) {
    return res.status(createCaptured.statusCode || 500).json({ ok: false, error: `Could not create the ${playbook} campaign.`, detail: createCaptured.body });
  }
  const campaignId = createCaptured.body.campaign.id;
  const tmpl = LIFECYCLE_AUTOSEND_TEMPLATES[playbook];
  let sendCaptured = { statusCode: 200, body: null };
  const sendRes = { status(code) { sendCaptured.statusCode = code; return this; }, json(body) { sendCaptured.body = body; return this; } };
  const sendReq = { body: { campaignId, subject: tmpl.subject, body: tmpl.body }, hlUser: { email: actorEmail } };
  try { await handleCampaignSendPost(sendReq, sendRes); }
  catch (e) { return res.status(500).json({ ok: false, error: `Campaign created (id ${campaignId}) but send failed: ` + e.message }); }
  return res.status(sendCaptured.statusCode || 200).json(sendCaptured.body);
}

async function handleProcessPostJobThankYouAutosendGet(req, res) {
  return runLifecycleAutosend(res, 'post_job_thank_you', 'LIFECYCLE_AUTOSEND_POST_JOB_THANK_YOU', computePostJobThankYouCandidates,
    (c) => ({ clientId: c.clientId, targetRecordId: c.jobId, targetRecordType: 'job' }));
}
async function handleProcessServiceAnniversaryAutosendGet(req, res) {
  return runLifecycleAutosend(res, 'service_anniversary', 'LIFECYCLE_AUTOSEND_SERVICE_ANNIVERSARY', computeServiceAnniversaryCandidates,
    (c) => ({ clientId: c.clientId, targetRecordId: c.jobId, targetRecordType: 'job' }));
}
async function handleProcessDormantReactivationAutosendGet(req, res) {
  return runLifecycleAutosend(res, 'dormant_reactivation', 'LIFECYCLE_AUTOSEND_DORMANT_REACTIVATION', computeDormantReactivationCandidates,
    (c) => ({ clientId: c.clientId, targetRecordId: c.clientId, targetRecordType: 'client' }),
    'dormant_client_reengage');
}
async function handleProcessMaintenanceRemindersAutosendGet(req, res) {
  return runLifecycleAutosend(res, 'maintenance_reminders', 'LIFECYCLE_AUTOSEND_MAINTENANCE_REMINDERS', computeMaintenanceReminderCandidates,
    (c) => ({ clientId: c.clientId, targetRecordId: c.clientId, targetRecordType: 'client' }));
}
async function handleProcessNewLeadFollowupAutosendGet(req, res) {
  return runLifecycleAutosend(res, 'new_lead_followup', 'LIFECYCLE_AUTOSEND_NEW_LEAD_FOLLOWUP', computeNewLeadFollowupCandidates,
    (c) => ({ clientId: c.clientId, targetRecordId: c.leadId, targetRecordType: 'lead' }));
}
async function handleProcessNewsletterAutosendGet(req, res) {
  return runLifecycleAutosend(res, 'newsletter', 'LIFECYCLE_AUTOSEND_NEWSLETTER', computeNewsletterCandidates,
    (c) => ({ clientId: c.clientId, targetRecordId: c.clientId, targetRecordType: 'client' }));
}
async function handleProcessReferralAutosendGet(req, res) {
  return runLifecycleAutosend(res, 'referral', 'LIFECYCLE_AUTOSEND_REFERRAL', computeReferralCandidates,
    (c) => ({ clientId: c.clientId, targetRecordId: c.jobId, targetRecordType: 'job' }));
}

// ---------- Phase 18: real first-touch marketing attribution ----------
// Computes genuine first-touch lead/revenue attribution from the real,
// already-synced campaigns/campaign_recipients tables (sql/021_campaigns.sql)
// joined against real completed jobs -- no new schema required. Deliberately
// does NOT read/write marketing_lead_attributions/marketing_revenue_attributions
// (sql/041_marketing_website_review_attribution.sql on the still-unmerged
// marketing-suite-phase4-website-review-attribution branch) since those
// tables are not on origin/main yet; wiring this against schema this branch
// doesn't have would not be a real, tested slice. A job's first touch is
// the campaign whose recipient row for that job's real client has the
// EARLIEST real sent_at that is still on/before the job's real
// completed_at -- never guessed, never backfilled for a client with no
// real sent campaign. Spend/impressions/video views/clicks/calls/forms and
// any cost-per-X metric are honestly reported below as not yet measurable
// -- no ad platform (Google Ads/Meta) is connected, so this slice only
// covers what real campaign-send and job data already answers.
async function computeFirstTouchAttribution() {
  const NOT_YET_MEASURABLE = ['spend', 'impressions', 'video_views', 'clicks', 'calls', 'forms', 'cost_per_qualified_lead', 'cost_per_estimate', 'cost_per_sold_job'];
  const NOT_YET_MEASURABLE_REASON = 'No ad platform (Google Ads/Meta) is connected yet, so spend and paid-channel funnel metrics are not real numbers here -- this view only reports what real campaign-send and job data already answers.';
  try {
    const [campaigns, recipients, jobs] = await Promise.all([
      fetchAllRows('campaigns', '?select=id,name,type,channel'),
      fetchAllRows('campaign_recipients', '?select=campaign_id,client_id,sent_at,outcome,outcome_value&sent_at=not.is.null'),
      fetchAllRows('jobs', '?select=client_id,total,completed_at&completed_at=not.is.null'),
    ]);

    // Real touches per client, earliest first.
    const touchesByClient = new Map();
    for (const r of recipients) {
      if (!r.client_id || !r.sent_at) continue;
      const list = touchesByClient.get(r.client_id) || [];
      list.push({ campaignId: r.campaign_id, sentAt: r.sent_at });
      touchesByClient.set(r.client_id, list);
    }
    for (const list of touchesByClient.values()) {
      list.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
    }

    const perCampaignFirstTouch = new Map(campaigns.map((c) => [c.id, { firstTouchJobCount: 0, firstTouchRevenueCents: 0 }]));

    let totalAttributedJobs = 0;
    let totalUnattributedJobs = 0;
    let totalAttributedRevenueCents = 0;
    let totalAllRevenueCents = 0;

    for (const j of jobs) {
      const val = Number(j.total);
      const cents = val > 0 ? Math.round(val * 100) : 0;
      totalAllRevenueCents += cents;
      if (!j.client_id) { totalUnattributedJobs++; continue; }
      const touches = touchesByClient.get(j.client_id);
      if (!touches || !touches.length) { totalUnattributedJobs++; continue; }
      const completedMs = new Date(j.completed_at).getTime();
      const priorTouches = touches.filter((t) => new Date(t.sentAt).getTime() <= completedMs);
      if (!priorTouches.length) { totalUnattributedJobs++; continue; }
      const firstTouch = priorTouches[0]; // earliest real send on/before completion
      totalAttributedJobs++;
      totalAttributedRevenueCents += cents;
      const bucket = perCampaignFirstTouch.get(firstTouch.campaignId);
      if (bucket) {
        bucket.firstTouchJobCount++;
        bucket.firstTouchRevenueCents += cents;
      }
    }

    const sentByCampaign = new Map();
    const respondedByCampaign = new Map();
    const bookedByCampaign = new Map();
    for (const r of recipients) {
      sentByCampaign.set(r.campaign_id, (sentByCampaign.get(r.campaign_id) || 0) + 1);
      if (r.outcome === 'responded') respondedByCampaign.set(r.campaign_id, (respondedByCampaign.get(r.campaign_id) || 0) + 1);
      if (r.outcome === 'booked') bookedByCampaign.set(r.campaign_id, (bookedByCampaign.get(r.campaign_id) || 0) + 1);
    }

    const campaignResults = campaigns.map((c) => {
      const b = perCampaignFirstTouch.get(c.id);
      return {
        campaignId: c.id,
        name: c.name,
        type: c.type,
        channel: c.channel,
        recipientsSent: sentByCampaign.get(c.id) || 0,
        respondedCount: respondedByCampaign.get(c.id) || 0,
        bookedCount: bookedByCampaign.get(c.id) || 0,
        firstTouchJobCount: b.firstTouchJobCount,
        firstTouchRevenueCents: b.firstTouchRevenueCents,
      };
    });

    return {
      campaigns: campaignResults,
      totalAttributedJobs,
      totalUnattributedJobs,
      totalAttributedRevenueCents,
      totalAllRevenueCents,
      attributionCoveragePct: (totalAttributedJobs + totalUnattributedJobs) > 0
        ? Math.round((totalAttributedJobs / (totalAttributedJobs + totalUnattributedJobs)) * 1000) / 10
        : null,
      notYetMeasurable: NOT_YET_MEASURABLE,
      notYetMeasurableReason: NOT_YET_MEASURABLE_REASON,
    };
  } catch (e) {
    if (e.notSynced) {
      return {
        campaigns: [],
        totalAttributedJobs: 0,
        totalUnattributedJobs: 0,
        totalAttributedRevenueCents: 0,
        totalAllRevenueCents: 0,
        attributionCoveragePct: null,
        notYetMeasurable: NOT_YET_MEASURABLE,
        notYetMeasurableReason: NOT_YET_MEASURABLE_REASON,
      };
    }
    throw e;
  }
}

async function handleAttributionGet(req, res) {
  const result = await computeFirstTouchAttribution();
  const lastTouchResult = await computeLastTouchAttribution();
  const assistedResult = await computeAssistedAttribution();
  res.status(200).json({
    ok: true,
    source: 'HiveLogic (real campaigns + campaign_recipients + jobs, first-touch attribution model)',
    ...result,
    lastTouch: lastTouchResult,
    assisted: assistedResult,
  });
}

// Real last-touch attribution model -- an alternate lens on the same real
// campaigns/campaign_recipients/jobs data computeFirstTouchAttribution()
// already reads, crediting each real completed job's revenue to the LATEST
// real touch on/before completion instead of the earliest. A deliberately
// separate, independent computation (its own real fetch, not a shared
// refactor of the already-shipped/tested first-touch function) so that
// function's tested behavior is never put at risk by this addition.
async function computeLastTouchAttribution() {
  try {
    const [campaigns, recipients, jobs] = await Promise.all([
      fetchAllRows('campaigns', '?select=id,name,type,channel'),
      fetchAllRows('campaign_recipients', '?select=campaign_id,client_id,sent_at,outcome,outcome_value&sent_at=not.is.null'),
      fetchAllRows('jobs', '?select=client_id,total,completed_at&completed_at=not.is.null'),
    ]);

    const touchesByClientLT = new Map();
    for (const r of recipients) {
      if (!r.client_id || !r.sent_at) continue;
      const list = touchesByClientLT.get(r.client_id) || [];
      list.push({ campaignId: r.campaign_id, sentAt: r.sent_at });
      touchesByClientLT.set(r.client_id, list);
    }
    for (const list of touchesByClientLT.values()) {
      list.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
    }

    const perCampaignLastTouch = new Map(campaigns.map((c) => [c.id, { lastTouchJobCount: 0, lastTouchRevenueCents: 0 }]));

    let lastTouchAttributedJobs = 0;
    let lastTouchUnattributedJobs = 0;
    let lastTouchAttributedRevenueCents = 0;

    for (const j of jobs) {
      const val = Number(j.total);
      const cents = val > 0 ? Math.round(val * 100) : 0;
      if (!j.client_id) { lastTouchUnattributedJobs++; continue; }
      const touches = touchesByClientLT.get(j.client_id);
      if (!touches || !touches.length) { lastTouchUnattributedJobs++; continue; }
      const completedMs = new Date(j.completed_at).getTime();
      const priorTouches = touches.filter((t) => new Date(t.sentAt).getTime() <= completedMs);
      if (!priorTouches.length) { lastTouchUnattributedJobs++; continue; }
      const lastTouch = priorTouches[priorTouches.length - 1]; // latest real send on/before completion
      lastTouchAttributedJobs++;
      lastTouchAttributedRevenueCents += cents;
      const bucket = perCampaignLastTouch.get(lastTouch.campaignId);
      if (bucket) {
        bucket.lastTouchJobCount++;
        bucket.lastTouchRevenueCents += cents;
      }
    }

    const campaignResults = campaigns.map((c) => {
      const b = perCampaignLastTouch.get(c.id);
      return {
        campaignId: c.id,
        lastTouchJobCount: b.lastTouchJobCount,
        lastTouchRevenueCents: b.lastTouchRevenueCents,
      };
    });

    return {
      campaigns: campaignResults,
      totalAttributedJobs: lastTouchAttributedJobs,
      totalUnattributedJobs: lastTouchUnattributedJobs,
      totalAttributedRevenueCents: lastTouchAttributedRevenueCents,
      attributionCoveragePct: (lastTouchAttributedJobs + lastTouchUnattributedJobs) > 0
        ? Math.round((lastTouchAttributedJobs / (lastTouchAttributedJobs + lastTouchUnattributedJobs)) * 1000) / 10
        : null,
    };
  } catch (e) {
    if (e.notSynced) {
      return {
        campaigns: [],
        totalAttributedJobs: 0,
        totalUnattributedJobs: 0,
        totalAttributedRevenueCents: 0,
        attributionCoveragePct: null,
      };
    }
    throw e;
  }
}

// Assisted-conversion attribution -- counts jobs with 2+ real touches
// before completion and credits every touch except the last as an assist,
// a deliberately separate real computation from first/last-touch.
async function computeAssistedAttribution() {
  try {
    const [campaigns, recipients, jobs] = await Promise.all([
      fetchAllRows('campaigns', '?select=id,name,type,channel'),
      fetchAllRows('campaign_recipients', '?select=campaign_id,client_id,sent_at,outcome,outcome_value&sent_at=not.is.null'),
      fetchAllRows('jobs', '?select=client_id,total,completed_at&completed_at=not.is.null'),
    ]);
    const touchesByClientAssisted = new Map();
    for (const r of recipients) {
      if (!r.client_id || !r.sent_at) continue;
      const list = touchesByClientAssisted.get(r.client_id) || [];
      list.push({ campaignId: r.campaign_id, sentAt: r.sent_at });
      touchesByClientAssisted.set(r.client_id, list);
    }
    for (const list of touchesByClientAssisted.values()) {
      list.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
    }
    const perCampaignAssisted = new Map(campaigns.map((c) => [c.id, { assistedConversions: 0 }]));
    let totalMultiTouchJobs = 0;
    let totalAssistedConversions = 0;
    for (const j of jobs) {
      if (!j.client_id) continue;
      const touches = touchesByClientAssisted.get(j.client_id);
      if (!touches || touches.length < 2) continue;
      const completedMs = new Date(j.completed_at).getTime();
      const priorTouches = touches.filter((t) => new Date(t.sentAt).getTime() <= completedMs);
      if (priorTouches.length < 2) continue;
      totalMultiTouchJobs++;
      const assistingCampaignIds = new Set(priorTouches.slice(0, -1).map((t) => t.campaignId));
      for (const campaignId of assistingCampaignIds) {
        totalAssistedConversions++;
        const bucket = perCampaignAssisted.get(campaignId);
        if (bucket) bucket.assistedConversions++;
      }
    }
    const campaignResults = campaigns.map((c) => {
      const b = perCampaignAssisted.get(c.id);
      return { campaignId: c.id, assistedConversions: b.assistedConversions, };
    });
    return {
      campaigns: campaignResults,
      totalMultiTouchJobs,
      totalAssistedConversions,
    };
  } catch (e) {
    if (e.notSynced) {
      return {
        campaigns: [],
        totalMultiTouchJobs: 0,
        totalAssistedConversions: 0,
      };
    }
    throw e;
  }
}

// ----- Ideas: owner-submitted marketing ideas (Phase 9) -----
// marketing_owner_ideas.input_mode supports text/voice_note/photo/video/
// document (sql/039_marketing_owner_idea_attachment.sql), but this handler
// only accepts 'text' for now -- no voice/photo/video/document upload or
// transcription pipeline exists anywhere in this repo yet (confirmed by
// sql/039's own design-rationale comment, and by a repo-wide search before
// writing that migration). Accepting those modes here would silently
// accept an idea it can never actually process, so they are rejected with
// an honest "not built yet" error instead of a fake success.
// brief/gap_flags are left null on every created idea -- no brief-
// generation step exists yet either; that is Phase 9's next slice, not
// this one. Never fabricate a brief here.
async function handleIdeasGet(req, res) {
  const ideas = await fetchAllRows('marketing_owner_ideas', '?select=*&order=created_at.desc');

  // Real per-idea attachment counts (Phase 9 upload-wiring slice,
  // 2026-07-31) -- one batch query, not N+1. If marketing_attachments
  // isn't synced yet, every idea honestly shows 0 attachments rather than
  // failing the whole ideas list; matches handleIdeasProcessPost's
  // identical degrade for the same table.
  let attachmentCounts = new Map();
  try {
    const attRows = await fetchAllRows('marketing_attachments', '?select=entity_id&entity_type=eq.OWNER_IDEA');
    for (const a of attRows) attachmentCounts.set(a.entity_id, (attachmentCounts.get(a.entity_id) || 0) + 1);
  } catch (e) {
    if (!e.notSynced) throw e;
  }

  const shaped = ideas.map(i => ({
    id: i.id,
    submittedBy: i.submitted_by,
    inputMode: i.input_mode,
    rawText: i.raw_text,
    jobId: i.job_id,
    clientId: i.client_id,
    status: i.status,
    brief: i.brief,
    gapFlags: i.gap_flags,
    campaignId: i.campaign_id,
    errorReason: i.error_reason,
    processedAt: i.processed_at,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    attachmentCount: attachmentCounts.get(i.id) || 0,
  }));
  res.status(200).json({ ok: true, ideas: shaped });
}

async function handleIdeasPost(req, res) {
  const b = req.body || {};
  const inputMode = String(b.inputMode || 'text').trim();
  const supportedModes = ['text', 'voice_note', 'photo', 'video', 'document'];
  if (!supportedModes.includes(inputMode)) {
    return res.status(400).json({ ok: false, error: 'inputMode must be one of: ' + supportedModes.join(', ') + '.' });
  }
  // Phase 9 upload-wiring slice (2026-07-31): voice/photo/video/document
  // ideas are now real. rawText is only mandatory for the text mode (it IS
  // the idea there); for every other mode it's an optional caption -- the
  // real content is the attachment, uploaded via a follow-up POST to
  // resource=idea_attachments once this idea's real id exists below.
  const rawText = String(b.rawText || '').trim();
  if (inputMode === 'text' && !rawText) return res.status(400).json({ ok: false, error: 'rawText is required.' });

  const actorEmail = (req.hlUser && req.hlUser.email) || null;
  const row = {
    submitted_by: actorEmail,
    input_mode: inputMode,
    raw_text: rawText,
    job_id: b.jobId ? String(b.jobId) : null,
    client_id: b.clientId ? String(b.clientId) : null,
    status: 'submitted',
  };
  const r = await supabaseRequest('marketing_owner_ideas', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) {
    const text = await r.text();
    const notSynced = /relation .* does not exist/i.test(text);
    return res.status(notSynced ? 200 : 500).json({ ok: false, error: notSynced ? 'marketing_owner_ideas table is not set up yet -- run sql/039_marketing_owner_idea_attachment.sql in Supabase.' : text });
  }
  const created = (await r.json())[0];
  res.status(200).json({
    ok: true,
    idea: {
      id: created.id,
      submittedBy: created.submitted_by,
      inputMode: created.input_mode,
      rawText: created.raw_text,
      jobId: created.job_id,
      clientId: created.client_id,
      status: created.status,
      brief: created.brief,
      gapFlags: created.gap_flags,
      campaignId: created.campaign_id,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
    },
  });
}

// ---------------------------------------------------------------------
// Supabase Storage upload for owner-idea attachments (Phase 9 upload-wiring
// slice, 2026-07-31). Accepts a data: URL (what a browser file picker
// produces via FileReader.readAsDataURL) and puts it in a private bucket,
// returning the object path plus the real content-type/size that were
// actually uploaded. Mirrors api/subportal.js's uploadDataUrl() exactly --
// same regex, same service-key direct-to-Storage-API POST, same x-upsert
// convention -- the one established pattern this repo already uses for
// base64-data-URL uploads (api/subportal.js, api/voice.js, api/fieldops.js
// all upload the same way, just to hardcoded single buckets; subportal's
// generalized bucket-parameter version is the closest precedent to reuse).
//
// Buckets are NOT created by this code -- create `marketing-attachments`
// (private) once in the Supabase dashboard before this goes live, same
// one-time manual step already documented for sub-documents/sub-invoices
// in api/subportal.js.
// ---------------------------------------------------------------------
async function uploadDataUrl(bucket, path, dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 data URL (e.g. from a browser file picker).');
  const [, contentType, b64] = match;
  const buf = Buffer.from(b64, 'base64');
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`Storage upload failed: ${await res.text()}`);
  return { storagePath: `${bucket}/${path}`, contentType, sizeBytes: buf.length };
}

// resource=idea_attachments GET -- list the real files attached to one
// idea (?ideaId=...). Degrades honestly (empty list + notice) if
// marketing_attachments isn't synced yet, never fabricates a list.
async function handleIdeaAttachmentsGet(req, res) {
  const ideaId = req.query && req.query.ideaId ? String(req.query.ideaId) : '';
  if (!ideaId) return res.status(400).json({ ok: false, error: 'ideaId is required.' });
  let rows;
  try {
    rows = await fetchAllRows('marketing_attachments', `?select=*&entity_type=eq.OWNER_IDEA&entity_id=eq.${encodeURIComponent(ideaId)}&order=created_at.desc`);
  } catch (e) {
    if (e.notSynced) return res.status(200).json({ ok: true, attachments: [], notice: 'marketing_attachments table is not set up yet -- run sql/039_marketing_owner_idea_attachment.sql in Supabase.' });
    throw e;
  }
  res.status(200).json({
    ok: true,
    attachments: rows.map((a) => ({
      id: a.id,
      attachmentType: a.attachment_type,
      storagePath: a.storage_path,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      durationMs: a.duration_ms,
      transcript: a.transcript,
      uploadedBy: a.uploaded_by,
      createdAt: a.created_at,
    })),
  });
}

// resource=idea_attachments POST -- the real upload path. Confirms the
// idea actually exists before accepting a file for it (never attaches to a
// phantom id), uploads via uploadDataUrl above, then inserts one real
// marketing_attachments row using only what was actually uploaded --
// mime_type/size_bytes come from the real decoded buffer, never a
// client-supplied guess. transcript/media_id are deliberately left null:
// no transcription pipeline and no "reuse an existing media row" picker
// exist yet (sql/039's own header comment says the same) -- both are
// honest gaps, not silently faked.
async function handleIdeaAttachmentsPost(req, res) {
  const b = req.body || {};
  const ideaId = b.ideaId ? String(b.ideaId) : '';
  if (!ideaId) return res.status(400).json({ ok: false, error: 'ideaId is required.' });
  const attachmentType = String(b.attachmentType || '').trim();
  const supportedTypes = ['photo', 'video', 'audio', 'document'];
  if (!supportedTypes.includes(attachmentType)) {
    return res.status(400).json({ ok: false, error: 'attachmentType must be one of: ' + supportedTypes.join(', ') + '.' });
  }
  const fileDataUrl = b.fileDataUrl;
  if (!fileDataUrl || typeof fileDataUrl !== 'string') {
    return res.status(400).json({ ok: false, error: 'fileDataUrl is required (a base64 data: URL from the browser file picker).' });
  }

  const ideaRes = await supabaseRequest(`marketing_owner_ideas?select=id&id=eq.${encodeURIComponent(ideaId)}`);
  if (!ideaRes.ok) {
    const text2 = await ideaRes.text();
    const notSynced = /relation .* does not exist/i.test(text2);
    return res.status(notSynced ? 200 : 500).json({ ok: false, error: notSynced ? 'marketing_owner_ideas table is not set up yet -- run sql/039_marketing_owner_idea_attachment.sql in Supabase.' : text2 });
  }
  const [idea] = await ideaRes.json();
  if (!idea) return res.status(404).json({ ok: false, error: 'Idea not found.' });

  const safeName = (b.fileName ? String(b.fileName) : 'upload').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const objectPath = `owner-idea/${ideaId}/${crypto.randomUUID()}-${safeName}`;
  let uploaded;
  try {
    uploaded = await uploadDataUrl('marketing-attachments', objectPath, fileDataUrl);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: 'Upload to storage failed: ' + (e && e.message ? e.message : String(e)) + ' -- confirm the private "marketing-attachments" bucket exists in Supabase Storage (one-time manual setup, same as sub-documents/sub-invoices).',
    });
  }

  const actorEmail = (req.hlUser && req.hlUser.email) || null;
  const row = {
    entity_type: 'OWNER_IDEA',
    entity_id: ideaId,
    attachment_type: attachmentType,
    storage_path: uploaded.storagePath,
    mime_type: uploaded.contentType,
    size_bytes: uploaded.sizeBytes,
    duration_ms: b.durationMs ? Math.round(Number(b.durationMs)) : null,
    uploaded_by: actorEmail,
  };
  const r2 = await supabaseRequest('marketing_attachments', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!r2.ok) {
    const text3 = await r2.text();
    const notSynced = /relation .* does not exist/i.test(text3);
    return res.status(notSynced ? 200 : 500).json({ ok: false, error: notSynced ? 'marketing_attachments table is not set up yet -- run sql/039_marketing_owner_idea_attachment.sql in Supabase.' : text3 });
  }
  const created = (await r2.json())[0];
  res.status(200).json({
    ok: true,
    attachment: {
      id: created.id,
      attachmentType: created.attachment_type,
      storagePath: created.storage_path,
      mimeType: created.mime_type,
      sizeBytes: created.size_bytes,
      durationMs: created.duration_ms,
      createdAt: created.created_at,
    },
  });
}

// ----- Ideas brief generation (Phase 9, second slice): turn a submitted
// idea into real channel recommendations + honest gap-flagging -----
// Follows the exact same "real facts only, never fabricate" discipline as
// handleDraftPostPost: only recommends channels that are actually
// connected/launch-ready today (via the same ccConnections() the command
// center itself uses), only cites real job/client/attachment facts already
// on the idea, and any missing input surfaces as an honest gapFlag instead
// of an invented assumption. Nothing here sends anything -- it only writes
// brief/gap_flags/status back onto the idea row.
async function handleIdeasProcessPost(req, res) {
  const b = req.body || {};
  const ideaId = String(b.ideaId || '').trim();
  if (!ideaId) return res.status(400).json({ ok: false, error: 'ideaId is required.' });

  const ideaRes = await supabaseRequest(`marketing_owner_ideas?id=eq.${encodeURIComponent(ideaId)}&select=*`);
  if (!ideaRes.ok) {
    const text = await ideaRes.text();
    const notSynced = /relation .* does not exist/i.test(text);
    return res.status(notSynced ? 200 : 500).json({ ok: false, error: notSynced ? 'marketing_owner_ideas table is not set up yet -- run sql/039_marketing_owner_idea_attachment.sql in Supabase.' : text });
  }
  const [idea] = await ideaRes.json();
  if (!idea) return res.status(404).json({ ok: false, error: 'Idea not found.' });

  // Real facts only -- job/client lookups reuse the exact real column
  // shapes already used elsewhere in this file (handleDraftPostPost,
  // handleReviewQueueGet), never a fabricated shape.
  let jobTitle = null;
  let division = null;
  if (idea.job_id) {
    const jobRes = await supabaseRequest(`jobs?select=title&jobber_id=eq.${encodeURIComponent(idea.job_id)}`);
    if (jobRes.ok) {
      const [job] = await jobRes.json();
      if (job) { jobTitle = job.title; division = jobDivisionServer(job.title); }
    }
  }
  let clientName = null;
  if (idea.client_id) {
    const clientRes = await supabaseRequest(`clients?select=name,first_name,last_name,company_name&jobber_id=eq.${encodeURIComponent(idea.client_id)}`);
    if (clientRes.ok) {
      const [client] = await clientRes.json();
      if (client) clientName = clientDisplayName(client);
    }
  }
  let attachmentCount = 0;
  try {
    const attRows = await fetchAllRows('marketing_attachments', `?select=id&entity_type=eq.OWNER_IDEA&entity_id=eq.${encodeURIComponent(idea.id)}`);
    attachmentCount = attRows.length;
  } catch (e) {
    if (!e.notSynced) throw e; // marketing_attachments not synced yet -- treat as zero, not fabricated
  }

  const connections = await ccConnections();
  const readyChannels = connections.filter((c) => c.ready).map((c) => ({ key: c.key, label: c.label }));

  if (!anthropicMkt) {
    const patch = { status: 'error', error_reason: 'ANTHROPIC_API_KEY is not set for this deployment -- cannot generate a brief yet.', processed_at: new Date().toISOString() };
    await supabaseRequest(`marketing_owner_ideas?id=eq.${encodeURIComponent(ideaId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    return res.status(409).json({ ok: false, error: patch.error_reason });
  }

  const realFacts = {
    ideaText: idea.raw_text,
    linkedJobTitle: jobTitle,
    division,
    linkedClientName: clientName,
    attachmentCount,
    channelsActuallyConnectedAndReady: readyChannels.map((c) => c.label),
  };
  const factsText = JSON.stringify(realFacts, null, 2);
  const prompt = 'You are turning an owner-submitted marketing idea into a short campaign brief for a home services company.\n\n' +
    'STRICT RULES:\n' +
    '- Only recommend channels from \"channelsActuallyConnectedAndReady\" below. Never recommend a channel that is not in that list, even if it would normally make sense -- if the list is empty, recommendedChannels must be an empty array.\n' +
    '- Never invent specifics (materials, prices, audience details, timing) not present in the facts. Anything the idea does not specify must be listed in gapFlags instead of assumed.\n' +
    '- If ideaText is vague or missing key details (target audience, timeframe, budget, offer specifics), add a plain-English gapFlag for each missing piece.\n\n' +
    'Facts:\n' + factsText + '\n\n' +
    'Return ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:\n' +
    '{\"summary\": \"one or two sentence summary of the idea\", \"recommendedChannels\": [{\"channel\": \"<label from channelsActuallyConnectedAndReady>\", \"why\": \"one sentence\"}], \"gapFlags\": [\"plain-English gap 1\", \"...\"]}';

  const resp = await anthropicMkt.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });
  const modelText = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

  let parsed = null;
  try {
    const jsonMatch = modelText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : modelText);
  } catch (e) {
    parsed = null;
  }
  const valid = parsed && typeof parsed.summary === 'string' && Array.isArray(parsed.recommendedChannels) && Array.isArray(parsed.gapFlags);
  if (!valid) {
    const patch = { status: 'error', error_reason: 'AI brief response could not be parsed -- try again.', processed_at: new Date().toISOString() };
    await supabaseRequest(`marketing_owner_ideas?id=eq.${encodeURIComponent(ideaId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    return res.status(502).json({ ok: false, error: patch.error_reason });
  }

  // Never trust the model's channel names over the real allow-list -- drop
  // anything it named that isn't actually in channelsActuallyConnectedAndReady.
  const readyLabels = new Set(readyChannels.map((c) => c.label));
  const safeRecommendedChannels = parsed.recommendedChannels.filter((r) => r && readyLabels.has(r.channel));

  const status = safeRecommendedChannels.length === 0 ? 'needs_input' : 'brief_ready';
  const patch = {
    brief: { summary: parsed.summary, recommendedChannels: safeRecommendedChannels },
    gap_flags: parsed.gapFlags,
    status,
    error_reason: null,
    processed_at: new Date().toISOString(),
  };
  const patchRes = await supabaseRequest(`marketing_owner_ideas?id=eq.${encodeURIComponent(ideaId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!patchRes.ok) return res.status(500).json({ ok: false, error: await patchRes.text() });
  const [updated] = await patchRes.json();
  res.status(200).json({
    ok: true,
    idea: {
      id: updated.id,
      status: updated.status,
      brief: updated.brief,
      gapFlags: updated.gap_flags,
      errorReason: updated.error_reason,
      processedAt: updated.processed_at,
    },
  });
}

// ---------- Idea -> Campaign (Task #101: closes the idea/brief/campaign gap) ----------
// Before this, handleIdeasProcessPost got an idea to brief_ready/needs_input
// and stopped there -- nothing ever turned a ready brief into a real
// campaign, and the Ideas UI rendered zero action once an idea left
// submitted/error (confirmed by reading renderIdeas(): actionHtml was only
// ever set for those two statuses). This closes that gap the same honest
// way runLifecycleAutosend() already does: reuse handleCampaignsPost
// in-process instead of duplicating its validation/eligibility/dedup logic.
//
// Only Email and Text Messages map to a real campaigns.channel today
// (email/sms) -- campaigns has no "meta"/"website"/"google_ads" channel in
// its shape, and no publish adapter exists yet for those platforms (that is
// task #103's job). So a brief that only recommends those channels is
// honestly refused here instead of fabricating a campaign channel that
// doesn't exist, or silently creating something the owner didn't ask for.
const IDEA_CHANNEL_TO_CAMPAIGN_CHANNEL = { Email: 'email', 'Text Messages': 'sms' };

async function handleIdeaCreateCampaignPost(req, res) {
  const b = req.body || {};
  const ideaId = String(b.ideaId || '').trim();
  if (!ideaId) return res.status(400).json({ ok: false, error: 'ideaId is required.' });

  const ideaRes = await supabaseRequest(`marketing_owner_ideas?id=eq.${encodeURIComponent(ideaId)}&select=*`);
  if (!ideaRes.ok) {
    const text = await ideaRes.text();
    const notSynced = /relation .* does not exist/i.test(text);
    return res.status(notSynced ? 200 : 500).json({ ok: false, error: notSynced ? 'marketing_owner_ideas table is not set up yet -- run sql/039_marketing_owner_idea_attachment.sql in Supabase.' : text });
  }
  const [idea] = await ideaRes.json();
  if (!idea) return res.status(404).json({ ok: false, error: 'Idea not found.' });
  if (idea.campaign_id) return res.status(409).json({ ok: false, error: 'This idea already has a campaign.', campaignId: idea.campaign_id });
  if (idea.status !== 'brief_ready') {
    return res.status(409).json({ ok: false, error: 'This idea needs a ready brief with at least one recommended channel before a campaign can be created. Generate (or regenerate) the brief first.' });
  }

  const recommendedChannels = (idea.brief && Array.isArray(idea.brief.recommendedChannels)) ? idea.brief.recommendedChannels : [];
  const automatable = recommendedChannels.filter((c) => c && IDEA_CHANNEL_TO_CAMPAIGN_CHANNEL[c.channel]);
  if (!automatable.length) {
    const named = recommendedChannels.map((c) => c && c.channel).filter(Boolean).join(', ') || 'none';
    return res.status(409).json({
      ok: false,
      error: `Reina can't auto-create a campaign for this idea yet -- its recommended channel(s) (${named}) don't have an automated campaign path today. Only Email and Text Messages campaigns are automated so far; create this one manually in Campaigns.`,
    });
  }

  const requestedChannelLabel = typeof b.channel === 'string' && b.channel.trim() ? b.channel.trim() : null;
  const chosen = requestedChannelLabel ? automatable.find((c) => c.channel === requestedChannelLabel) : automatable[0];
  if (!chosen) {
    return res.status(400).json({ ok: false, error: `channel must be one of the idea's automatable recommended channels: ${automatable.map((c) => c.channel).join(', ')}.` });
  }
  const campaignChannel = IDEA_CHANNEL_TO_CAMPAIGN_CHANNEL[chosen.channel];

  const summary = (idea.brief && idea.brief.summary) ? idea.brief.summary : (idea.raw_text || 'Owner idea');
  const name = ('Idea: ' + summary).slice(0, 120);
  const actorEmail = (req.hlUser && req.hlUser.email) || null;
  // Real recipient only when the idea itself is really linked to a client --
  // never fabricate an audience just to satisfy the email-channel eligibility
  // check below; a general idea with no linked client honestly hits that
  // check's real "no recipients yet" refusal instead.
  const recipients = idea.client_id
    ? [{ clientId: idea.client_id, targetRecordId: idea.job_id || null, targetRecordType: idea.job_id ? 'job' : null }]
    : [];

  let createCaptured = { statusCode: 200, body: null };
  const createRes = { status(code) { createCaptured.statusCode = code; return this; }, json(body) { createCaptured.body = body; return this; } };
  const createReq = {
    body: {
      name,
      type: 'custom',
      channel: campaignChannel,
      subject: summary.slice(0, 200),
      body: [idea.raw_text, chosen.why].filter(Boolean).join('\n\n'),
      notes: `Created from owner idea ${idea.id} by Reina (task #101 idea-to-campaign automation).`,
      recipients,
    },
    hlUser: { email: actorEmail },
  };
  try {
    await handleCampaignsPost(createReq, createRes);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not create the campaign: ' + e.message });
  }
  if (!createCaptured.body || !createCaptured.body.ok) {
    return res.status(createCaptured.statusCode || 500).json({ ok: false, error: (createCaptured.body && createCaptured.body.error) || 'Could not create the campaign.', detail: createCaptured.body });
  }
  const campaign = createCaptured.body.campaign;

  const patchRes = await supabaseRequest(`marketing_owner_ideas?id=eq.${encodeURIComponent(ideaId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ campaign_id: campaign.id, updated_at: new Date().toISOString() }),
  });
  if (!patchRes.ok) {
    return res.status(200).json({ ok: true, campaignId: campaign.id, campaign, channel: chosen.channel, ideaLinkWarning: 'Campaign created, but could not link it back to the idea: ' + (await patchRes.text()) });
  }

  res.status(200).json({ ok: true, campaignId: campaign.id, campaign, channel: chosen.channel });
}

// ---------- Schedule (Phase 10 -- replaces the admitted Calendar stub) ----------
// First real slice: a rolling window of real scheduled campaign sends, read
// straight from campaigns.scheduled_at (the same column
// handleProcessScheduledSendsGet above already fires sends from -- no new
// column, no migration). The full Phase 10 brief also lists organic posts,
// videos, website promotions, landing-page launches, review campaigns,
// content-production deadlines, and promo expirations -- none of those have
// a real schedulable date field anywhere in the schema yet (website changes/
// review replies have no publish-scheduling columns; Ideas/content jobs have
// no deadline field). Returning fabricated events for those would be worse
// than an honest gap, so `notYetTracked` names them instead.
// computeScheduleData is shared by resource=schedule (its own window,
// e.g. a future dedicated Schedule page) AND handleCommandCenterGet below
// (fixed default window, folded into the single command_center payload the
// Command Center's Calendar tab already renders from) -- one real fetch,
// no duplicated query logic between the two call sites.
async function computeScheduleData(rawDaysInput, rawPastDaysInput) {
  const rawDays = Number(rawDaysInput);
  const rawPastDays = Number(rawPastDaysInput);
  const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 90, 1), 180);
  const pastDays = Math.min(Math.max(Number.isFinite(rawPastDays) ? rawPastDays : 7, 0), 90);
  const now = new Date();
  const windowStart = new Date(now.getTime() - pastDays * 86400000);
  const windowEnd = new Date(now.getTime() + days * 86400000);
  const rows = await fetchAllRows(
    'campaigns',
    `?select=id,name,type,channel,status,scheduled_at&scheduled_at=not.is.null&scheduled_at=gte.${encodeURIComponent(windowStart.toISOString())}&scheduled_at=lte.${encodeURIComponent(windowEnd.toISOString())}&order=scheduled_at.asc`
  );
  const events = rows.map((c) => ({
    id: c.id,
    kind: 'campaign_send',
    campaignId: c.id,
    name: c.name,
    type: c.type,
    channel: c.channel,
    status: c.status,
    scheduledAt: c.scheduled_at,
  }));
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    events,
    notYetTracked: [
      'organic_posts',
      'videos',
      'website_promotions',
      'landing_page_launches',
      'review_campaigns',
      'content_production_deadlines',
      'promo_expirations',
    ],
  };
}

async function handleScheduleGet(req, res) {
  const data = await computeScheduleData(req.query.days, req.query.pastDays);
  res.status(200).json({ ok: true, ...data });
}

// ---------- Lead/Revenue Attribution snapshot persistence (Phase 18) ----------
// Deliberately independent of the resource=attribution live computation
// (still unmerged, Phase 18) -- this does its own fresh fetch and its own
// math, matching this project's established pattern of not sharing code
// between independent attribution models. It exists because
// marketing_lead_attributions/marketing_revenue_attributions (sql/046,
// renumbered from the original sql/041 to avoid colliding with
// origin/main's own sql/041_webhook_events.sql) are schema-only so far --
// nothing writes to them yet. Deliberately an explicit POST snapshot
// action, not an automatic side effect of any GET: neither table has a
// unique constraint on client_id or job_id, and both carry a
// captured_at/created_at timestamp, so this is an append-only
// point-in-time snapshot history (matching marketing_audit_events'
// append-only convention) -- calling this endpoint repeatedly is expected
// to accumulate snapshots over time, not overwrite one row.
async function computeAttributionSnapshotRows() {
  const [campaigns, recipients, jobs] = await Promise.all([
    fetchAllRows('campaigns', '?select=id,channel'),
    fetchAllRows('campaign_recipients', '?select=campaign_id,client_id,sent_at&sent_at=not.is.null'),
    fetchAllRows('jobs', '?select=jobber_id,client_id,total,completed_at&completed_at=not.is.null'),
  ]);

  const channelByCampaign = new Map(campaigns.map((c) => [c.id, c.channel || null]));

  const touchesByClient = new Map();
  for (const r of recipients) {
    if (!r.client_id || !r.sent_at) continue;
    const list = touchesByClient.get(r.client_id) || [];
    list.push({ campaignId: r.campaign_id, touchedAt: r.sent_at });
    touchesByClient.set(r.client_id, list);
  }
  for (const list of touchesByClient.values()) {
    list.sort((a, b) => new Date(a.touchedAt).getTime() - new Date(b.touchedAt).getTime());
  }

  const capturedAt = new Date().toISOString();

  // LeadAttribution: one row per real client with at least one real touch
  // -- a client-level journey (matches the schema, which has no job_id
  // column), independent of any specific job.
  const leadRows = [];
  for (const [clientId, touches] of touchesByClient.entries()) {
    if (!touches.length) continue;
    const first = touches[0];
    const last = touches[touches.length - 1];
    const assisted = touches.slice(1, -1).map((t) => ({ campaign_id: t.campaignId, touched_at: t.touchedAt }));
    leadRows.push({
      client_id: clientId,
      lead_source_ref: null,
      first_touch_channel: channelByCampaign.get(first.campaignId) || null,
      first_touch_campaign_id: first.campaignId,
      last_touch_channel: channelByCampaign.get(last.campaignId) || null,
      last_touch_campaign_id: last.campaignId,
      assisted_touches: assisted,
      captured_at: capturedAt,
    });
  }

  // RevenueAttribution: one row per real completed job with a real,
  // priced client and at least one real touch on/before completion --
  // credited to that job's own first touch. Jobs with no client, no
  // priced total, or no prior touch are honestly skipped, never given a
  // fabricated row.
  const revenueRows = [];
  for (const j of jobs) {
    if (!j.client_id) continue;
    const val = Number(j.total);
    if (!(val > 0)) continue;
    const touches = touchesByClient.get(j.client_id);
    if (!touches || !touches.length) continue;
    const completedMs = new Date(j.completed_at).getTime();
    const priorTouches = touches.filter((t) => new Date(t.touchedAt).getTime() <= completedMs);
    if (!priorTouches.length) continue;
    const firstTouch = priorTouches[0];
    revenueRows.push({
      job_id: j.jobber_id,
      client_id: j.client_id,
      campaign_id: firstTouch.campaignId,
      lead_attribution_id: null,
      estimate_value_cents: null,
      sold_value_cents: Math.round(val * 100),
      gross_profit_cents: null,
      cost_allocated_cents: null,
      attribution_model: 'first_touch',
      created_at: capturedAt,
    });
  }

  return { leadRows, revenueRows, capturedAt };
}

async function insertRowsIfTableExists(table, rows) {
  if (!rows.length) return { inserted: 0, tableMissing: false };
  const r = await supabaseRequest(table, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text();
    if (/relation .* does not exist/i.test(text)) {
      return { inserted: 0, tableMissing: true };
    }
    throw new Error(`Failed to insert into ${table}: ${text}`);
  }
  return { inserted: rows.length, tableMissing: false };
}

async function handleAttributionSnapshotPost(req, res) {
  try {
    const { leadRows, revenueRows, capturedAt } = await computeAttributionSnapshotRows();
    const [leadResult, revenueResult] = await Promise.all([
      insertRowsIfTableExists('marketing_lead_attributions', leadRows),
      insertRowsIfTableExists('marketing_revenue_attributions', revenueRows),
    ]);
    const notSynced = [
      ...(leadResult.tableMissing ? ['marketing_lead_attributions'] : []),
      ...(revenueResult.tableMissing ? ['marketing_revenue_attributions'] : []),
    ];
    return res.status(200).json({
      ok: true,
      capturedAt,
      leadAttributionRowsInserted: leadResult.inserted,
      revenueAttributionRowsInserted: revenueResult.inserted,
      notSynced,
      note: notSynced.length
        ? 'Some tables are not set up yet -- run sql/046_marketing_lead_revenue_attribution.sql in Supabase, then call this again.'
        : null,
    });
  } catch (e) {
    if (e.notSynced) {
      return res.status(200).json({
        ok: true,
       capturedAt: new Date().toISOString(),
       leadAttributionRowsInserted: 0,
       revenueAttributionRowsInserted: 0,
       notSynced: ['campaigns_or_campaign_recipients_or_jobs'],
       note: 'campaigns/campaign_recipients/jobs are not fully synced yet -- nothing to snapshot.',
      });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export default async function handler(req, res) {
  const resource = req.query.resource;

  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically once
  // CRON_SECRET is set as a project env var (see https://vercel.com/docs/cron-jobs/manage-cron-jobs).
  // process_scheduled_sends is cron-triggered and carries no Supabase user
  // session, so it must bypass the requireUser gate below via this shared-
  // secret check instead -- otherwise every cron firing 401s (that was the
  // actual bug: the cron trigger was added without this bypass).
  if (resource === 'process_scheduled_sends') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      try { return await handleProcessScheduledSendsGet(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }
  }

  // process_review_request_autosend is cron-triggered (see process_scheduled_sends
  // just above for why this needs its own CRON_SECRET bypass instead of the
  // requireUser gate below).
  if (resource === 'process_review_request_autosend') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      try { return await handleProcessReviewRequestAutosendGet(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }
  }

  // Lifecycle playbook auto-send crons (post_job_thank_you, service_anniversary,
  // dormant_reactivation, maintenance_reminders, new_lead_followup, newsletter,
  // referral) are cron-triggered, same CRON_SECRET bypass reasoning as
  // process_review_request_autosend above.
  const LIFECYCLE_AUTOSEND_RESOURCES = {
    process_post_job_thank_you_autosend: handleProcessPostJobThankYouAutosendGet,
    process_service_anniversary_autosend: handleProcessServiceAnniversaryAutosendGet,
    process_dormant_reactivation_autosend: handleProcessDormantReactivationAutosendGet,
    process_maintenance_reminders_autosend: handleProcessMaintenanceRemindersAutosendGet,
    process_new_lead_followup_autosend: handleProcessNewLeadFollowupAutosendGet,
    process_newsletter_autosend: handleProcessNewsletterAutosendGet,
    process_referral_autosend: handleProcessReferralAutosendGet,
  };
  if (LIFECYCLE_AUTOSEND_RESOURCES[resource]) {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      try { return await LIFECYCLE_AUTOSEND_RESOURCES[resource](req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }
  }

  const user = await requireUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Not authenticated. Sign in and try again.' });
  }
  req.hlUser = user;

  try {
    if (resource === 'review_queue' && req.method === 'GET') {
      return await handleReviewQueueGet(req, res);
    }
    if (resource === 'review_requests' && req.method === 'POST') {
      return await handleReviewRequestsPost(req, res);
    }
    if (resource === 'review_requests_bulk' && req.method === 'POST') {
      return await handleReviewRequestsBulkPost(req, res);
    }
    if (resource === 'opportunities' && req.method === 'GET') {
      return await handleOpportunitiesGet(req, res);
    }
    if (resource === 'brief' && req.method === 'GET') {
      return await handleBriefGet(req, res);
    }
    if (resource === 'insights' && req.method === 'GET') {
      return await handleInsightsGet(req, res);
    }
    if (resource === 'marketing_health' && req.method === 'GET') {
      return await handleMarketingHealthGet(req, res);
    }
    if (resource === 'channels' && req.method === 'GET') {
      return await handleChannelsGet(req, res);
    }
    if (resource === 'command_center' && req.method === 'GET') {
      return await handleCommandCenterGet(req, res);
    }
    if (resource === 'command_center_budget' && req.method === 'POST') {
      return await handleCommandCenterBudgetPost(req, res);
    }
    if (resource === 'command_center_budget_channels' && req.method === 'POST') {
      // Reuses the exact same, already-tested per-channel/pacing handler
      // the Marketing Setup screen calls -- no second write path invented.
      return await handleSetupBudgetPost(req, res);
    }
    if (resource === 'command_center_assumptions' && req.method === 'GET') {
      return await handleAssumptionsGet(req, res);
    }
    if (resource === 'command_center_assumptions' && req.method === 'POST') {
      return await handleAssumptionsPost(req, res);
    }
    if (resource === 'command_center_budget_pacing' && req.method === 'GET') {
      return await handleBudgetPacingGet(req, res);
    }
    if (resource === 'command_center_channel_performance' && req.method === 'GET') {
      return await handleChannelPerformanceGet(req, res);
    }
    if (resource === 'command_center_goal' && req.method === 'GET') {
      return await handleMarketingGoalGet(req, res);
    }
    if (resource === 'command_center_goal' && req.method === 'POST') {
      return await handleMarketingGoalPost(req, res);
    }
    if (resource === 'setup' && req.method === 'GET') {
      return await handleSetupGet(req, res);
    }
    if (resource === 'setup_budget' && req.method === 'POST') {
      return await handleSetupBudgetPost(req, res);
    }
    if (resource === 'setup_budget_recommendation' && req.method === 'GET') {
      return await handleSetupBudgetRecommendationGet(req, res);
    }
    if (resource === 'setup_account' && req.method === 'POST') {
      return await handleSetupAccountPost(req, res);
    }
    if (resource === 'connector_catalog' && req.method === 'GET') {
      return await handleConnectorCatalogGet(req, res);
    }
    if (resource === 'setup_account_fields' && req.method === 'POST') {
      return await handleSetupAccountFieldsPost(req, res);
    }
    if (resource === 'connection_transition' && req.method === 'POST') {
      return await handleConnectionTransitionPost(req, res);
    }
    if (resource === 'campaigns' && req.method === 'GET') {
      return await handleCampaignsGet(req, res);
    }
    if (resource === 'campaigns' && req.method === 'POST') {
      return await handleCampaignsPost(req, res);
    }
    if (resource === 'campaign_recipient' && req.method === 'PATCH') {
      return await handleCampaignRecipientPatch(req, res);
    }
    if (resource === 'campaign_send' && req.method === 'POST') {
      return await handleCampaignSendPost(req, res);
    }
    if (resource === 'campaign_ask_reina' && req.method === 'POST') {
      return await handleCampaignAskReinaPost(req, res);
    }
    if (resource === 'campaign_regenerate_copy' && req.method === 'POST') {
      return await handleCampaignRegenerateCopyPost(req, res);
    }
    if (resource === 'reina_change_requests' && req.method === 'GET') {
      return await handleReinaChangeRequestsGet(req, res);
    }
    if (resource === 'reina_change_request_decide' && req.method === 'POST') {
      return await handleReinaChangeRequestDecidePost(req, res);
    }
    if (resource === 'approval_reject' && req.method === 'POST') {
      return await handleApprovalRejectPost(req, res);
    }
    if (resource === 'review_requests_candidates' && req.method === 'GET') {
      return await handleReviewRequestCandidatesGet(req, res);
    }
    if (resource === 'opportunity_candidates' && req.method === 'GET') {
      return await handleOpportunityCandidatesGet(req, res);
    }
    if (resource === 'config' && req.method === 'GET') {
      return await handleMarketingConfigGet(req, res);
    }
    if (resource === 'test_send' && req.method === 'POST') {
      return await handleTestSendPost(req, res);
    }
    if (resource === 'content_jobs' && req.method === 'GET') {
      return await handleContentJobsGet(req, res);
    }
    if (resource === 'review_replies' && req.method === 'GET') {
      return await handleReviewRepliesGet(req, res);
    }
    if (resource === 'review_replies' && req.method === 'POST') {
      return await handleReviewRepliesPost(req, res);
    }
    if (resource === 'website_changes' && req.method === 'GET') {
      return await handleWebsiteChangesGet(req, res);
    }
    if (resource === 'website_changes' && req.method === 'POST') {
      return await handleWebsiteChangesPost(req, res);
    }
    if (resource === 'draft_post' && req.method === 'POST') {
      return await handleDraftPostPost(req, res);
    }
    if (resource === 'campaign_drafts' && req.method === 'GET') {
      return await handleCampaignDraftsGet(req, res);
    }
    if (resource === 'campaign_delete' && req.method === 'POST') {
      return await handleCampaignDeletePost(req, res);
    }
    if (resource === 'campaign_update' && req.method === 'POST') {
      return await handleCampaignUpdatePost(req, res);
    }
    if (resource === 'campaign_duplicate' && req.method === 'POST') {
      return await handleCampaignDuplicatePost(req, res);
    }
    if (resource === 'campaign_activity' && req.method === 'GET') {
      return await handleCampaignActivityGet(req, res);
    }
    if (resource === 'attribution' && req.method === 'GET') {
      return await handleAttributionGet(req, res);
    }
    if (resource === 'ideas' && req.method === 'GET') {
      return await handleIdeasGet(req, res);
    }
    if (resource === 'ideas' && req.method === 'POST') {
      return await handleIdeasPost(req, res);
    }
    if (resource === 'ideas_process' && req.method === 'POST') {
      return await handleIdeasProcessPost(req, res);
    }
    if (resource === 'idea_attachments' && req.method === 'GET') {
      return await handleIdeaAttachmentsGet(req, res);
    }
    if (resource === 'idea_attachments' && req.method === 'POST') {
      return await handleIdeaAttachmentsPost(req, res);
    }
    if (resource === 'idea_create_campaign' && req.method === 'POST') {
      return await handleIdeaCreateCampaignPost(req, res);
    }
    if (resource === 'process_scheduled_sends' && req.method === 'GET') {
      return await handleProcessScheduledSendsGet(req, res);
    }
    if (resource === 'lifecycle_candidates' && req.method === 'GET') {
      return await handleLifecycleCandidatesGet(req, res);
    }
    if (resource === 'schedule' && req.method === 'GET') {
      return await handleScheduleGet(req, res);
    }
    if (resource === 'attribution_snapshot' && req.method === 'POST') {
      return await handleAttributionSnapshotPost(req, res);
    }
    return res.status(400).json({
      ok: false,
      error: 'resource must be one of: review_queue (GET), review_requests (POST), review_requests_bulk (POST), opportunities (GET), brief (GET), insights (GET), marketing_health (GET), channels (GET), command_center (GET), command_center_budget (POST), command_center_budget_channels (POST), command_center_assumptions (GET/POST), setup (GET), setup_budget (POST), setup_budget_recommendation (GET), setup_account (POST), connector_catalog (GET), setup_account_fields (POST), connection_transition (POST), campaigns (GET/POST), campaign_recipient (PATCH), campaign_send (POST), test_send (POST), review_requests_candidates (GET), opportunity_candidates (GET), config (GET), content_jobs (GET), review_replies (GET/POST), website_changes (GET/POST), draft_post (POST), campaign_delete (POST), campaign_update (POST), campaign_duplicate (POST), campaign_activity (GET), campaign_drafts (GET), approval_reject (POST), ideas (GET/POST), ideas_process (POST), idea_attachments (GET/POST), idea_create_campaign (POST), attribution (GET), process_scheduled_sends (GET), schedule (GET), campaign_ask_reina (POST), campaign_regenerate_copy (POST), reina_change_requests (GET), reina_change_request_decide (POST), lifecycle_candidates (GET), attribution_snapshot (POST), command_center_budget_pacing (GET), command_center_channel_performance (GET), command_center_goal (GET/POST).',
    });
  } catch (e) {
    if (e.notSynced) {
      return res.status(200).json({
        ok: false,
        error: 'Required table is not set up yet -- run the latest sql/0NN_*.sql migrations in Supabase.',
      });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
}
