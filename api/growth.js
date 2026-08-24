// api/growth.js - Vercel serverless function
// The growth engine: the piece that makes Reina push growth on her own
// instead of waiting to be asked.
//
// Everything the paid-ads and content subsystems could already do was
// human-triggered -- a POST that only ever fired when somebody clicked a
// button that, for paid ads, did not exist on any screen. This file is the
// standing instruction: once a week, look at the real numbers, work out where
// the growth is being left on the table, and put concrete, costed next steps
// in front of a human.
//
// Usage:
//   GET  /api/growth?resource=growth_suggestions[&status=]
//     -> Reina's current ranked next steps, newest scan first. Each row
//        carries the real evidence it was computed from.
//   POST /api/growth?resource=growth_suggestion_decide
//     body: { suggestionId, decision: 'accept'|'dismiss', reason? }
//     -> accept turns the suggestion into a real draft where one can be made
//        automatically (an ad campaign draft, a batch of reel drafts) and
//        links it; dismiss records the decision with a reason. Neither ever
//        launches anything or spends money -- every accepted item still lands
//        in the existing human approval queues.
//   GET  /api/growth?resource=growth_scan
//     -> cron-triggered (weekly, Monday 08:00 America/New_York -- see
//        vercel.json), same CRON_SECRET bearer-token bypass as
//        api/social-posts.js's process_scheduled_posts. Recomputes the whole
//        suggestion list from real data and upserts it.
//
// WHAT THIS FILE IS NOT ALLOWED TO DO, stated plainly because it runs
// unattended: it never launches an ad, never raises a budget, never sends an
// email, and never publishes a post. The most autonomous thing a scan can do
// is create a DRAFT. Every path to a customer or to real money still runs
// through the existing human review gates in api/ads.js, api/marketing.js and
// api/social-posts.js. GROWTH_AUTOPILOT_ENABLED=false turns even the drafting
// off, leaving suggestions only.

import { supabaseRequest as defaultSupabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/require-user.js';
import { gatherGrowthFacts } from './_lib/growth-facts.js';
import { buildSuggestions } from './_lib/growth-suggester.js';
import { createAdCampaignDraft } from './ads.js';
import { selectReelCandidates, chooseReelFrames } from './_lib/reel-builder.js';

const TENANT = 'ghgrp';

// Drafting is on unless explicitly turned off. Suggestions are internal notes
// and drafts are internal drafts -- neither reaches a customer or spends a
// cent -- so the default that matches what this feature is for is "on", with
// an explicit kill switch rather than an opt-in nobody remembers to set.
function autopilotEnabled() {
  return process.env.GROWTH_AUTOPILOT_ENABLED !== 'false';
}

function suggestionShape(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    rationale: row.rationale,
    evidence: row.evidence,
    proposedAction: row.proposed_action,
    priority: row.priority,
    status: row.status,
    linkedRecordId: row.linked_record_id,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decidedReason: row.decided_reason,
    createdAt: row.created_at,
  };
}

export async function handleGrowthSuggestionsGet(req, res, supabaseRequest = defaultSupabaseRequest) {
  const status = String(req.query.status || '').trim();
  let query = `growth_suggestions?tenant_id=eq.${TENANT}&select=*&order=priority.asc,created_at.desc&limit=100`;
  if (status) query += `&status=eq.${encodeURIComponent(status)}`;
  const r = await supabaseRequest(query);
  if (!r.ok) return res.status(500).json({ ok: false, error: await r.text() });
  const rows = await r.json();
  res.status(200).json({ ok: true, suggestions: rows.map(suggestionShape) });
}

// Accepting a suggestion does as much real work as can be done safely and
// automatically, then stops. 'done' means a real draft now exists; 'accepted'
// means the human said yes but the follow-through is theirs to do in the
// relevant screen (there is no honest way to auto-write an email campaign to
// real customers from here).
async function performAcceptedAction(suggestion, deps) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const action = suggestion.proposed_action || {};

  if (action.type === 'ad_campaign_draft') {
    if (!action.platform || !action.division || !Number.isFinite(Number(action.dailyBudgetCents))) {
      return { status: 'accepted', note: 'Open Paid Ads to finish this draft -- it needs a platform and a daily budget.' };
    }
    const result = await createAdCampaignDraft({
      platform: action.platform,
      objective: action.objective || 'lead_gen',
      division: action.division,
      dailyBudgetCents: action.dailyBudgetCents,
      createdBy: 'reina_growth_scan',
    }, deps);
    if (!result.ok) return { status: 'accepted', note: 'Could not auto-draft the campaign: ' + result.error };
    return { status: 'done', linkedRecordId: result.campaign.id, note: 'Draft ad campaign created -- review it in Paid Ads.' };
  }

  if (action.type === 'reel_batch') {
    const count = Math.max(1, Math.min(Number(action.count) || 1, 5));
    const candidates = await selectReelCandidates({ limit: count }, deps);
    if (!candidates.length) return { status: 'accepted', note: 'No job currently has enough real photos for a reel.' };
    const payload = candidates.map((c) => ({
      tenant_id: TENANT,
      job_id: c.jobId,
      job_uuid: c.jobUuid,
      division: c.division,
      status: 'draft',
      photo_ids: chooseReelFrames(c.photos).map((p) => p.id),
      created_by: 'reina_growth_scan',
    }));
    const insertRes = await supabaseRequest('content_reels', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    if (!insertRes.ok) return { status: 'accepted', note: 'Could not create reel drafts: ' + (await insertRes.text()) };
    const inserted = await insertRes.json();
    return {
      status: 'done',
      linkedRecordId: inserted[0] ? inserted[0].id : null,
      note: inserted.length + ' reel draft' + (inserted.length === 1 ? '' : 's') + ' created -- write the scripts in Content Studio.',
    };
  }

  // connect_ad_platform, email_campaign, review_request_batch, review_ad_plan:
  // all of these end at a human doing something Reina must not do for them.
  return { status: 'accepted', note: null };
}

export async function handleGrowthSuggestionDecidePost(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const b = req.body || {};
  const suggestionId = String(b.suggestionId || '').trim();
  const decision = String(b.decision || '').trim();
  const reason = b.reason ? String(b.reason).trim() : null;

  if (!suggestionId) return res.status(400).json({ ok: false, error: 'suggestionId is required.' });
  if (decision !== 'accept' && decision !== 'dismiss') {
    return res.status(400).json({ ok: false, error: "decision must be 'accept' or 'dismiss'." });
  }

  const getRes = await supabaseRequest(`growth_suggestions?id=eq.${encodeURIComponent(suggestionId)}&select=*`);
  if (!getRes.ok) return res.status(500).json({ ok: false, error: await getRes.text() });
  const [suggestion] = await getRes.json();
  if (!suggestion) return res.status(404).json({ ok: false, error: 'That suggestion no longer exists.' });
  if (suggestion.status !== 'open') {
    return res.status(409).json({ ok: false, error: 'That suggestion was already ' + suggestion.status + '.' });
  }

  let outcome = { status: 'dismissed', note: null, linkedRecordId: null };
  if (decision === 'accept') {
    outcome = await performAcceptedAction(suggestion, deps);
  }

  const patch = {
    status: outcome.status,
    decided_at: new Date().toISOString(),
    decided_by: (req.hlUser && (req.hlUser.email || req.hlUser.id)) || 'unknown',
    decided_reason: reason,
    updated_at: new Date().toISOString(),
  };
  if (outcome.linkedRecordId) patch.linked_record_id = outcome.linkedRecordId;

  const patchRes = await supabaseRequest(`growth_suggestions?id=eq.${encodeURIComponent(suggestionId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!patchRes.ok) return res.status(500).json({ ok: false, error: await patchRes.text() });
  const [updated] = await patchRes.json();
  res.status(200).json({ ok: true, suggestion: suggestionShape(updated), note: outcome.note });
}

// The scan itself. Idempotent by (tenant_id, scan_key): re-running inside the
// same week updates the existing rows rather than duplicating them, so a cron
// retry is harmless. A suggestion a human already decided on this week is
// left exactly as they left it -- the scan must never quietly reopen
// something that was dismissed.
export async function handleGrowthScanGet(req, res, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const now = deps.now || new Date();

  const facts = await gatherGrowthFacts(TENANT, supabaseRequest, now);
  const suggestions = buildSuggestions(facts, now);

  const existingRes = await supabaseRequest(
    `growth_suggestions?tenant_id=eq.${TENANT}&scan_key=in.(${suggestions.map((s) => '"' + s.scan_key + '"').join(',') || '""'})&select=scan_key,status`);
  if (!existingRes.ok) return res.status(500).json({ ok: false, error: await existingRes.text() });
  const decidedKeys = new Set((await existingRes.json()).filter((r) => r.status !== 'open').map((r) => r.scan_key));

  const toWrite = suggestions.filter((s) => !decidedKeys.has(s.scan_key)).map((s) => ({
    tenant_id: TENANT,
    kind: s.kind,
    title: s.title,
    rationale: s.rationale,
    evidence: s.evidence,
    proposed_action: s.proposed_action,
    priority: s.priority,
    scan_key: s.scan_key,
    status: 'open',
    updated_at: now.toISOString(),
  }));

  let written = [];
  if (toWrite.length) {
    const upsertRes = await supabaseRequest('growth_suggestions?on_conflict=tenant_id,scan_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(toWrite),
    });
    if (!upsertRes.ok) return res.status(500).json({ ok: false, error: await upsertRes.text() });
    written = await upsertRes.json();
  }

  // The one autonomous write worth doing on its own: if there is a fully
  // specified ad campaign to draft and real headroom to draft it into, make
  // the draft now so a human opens Paid Ads to a finished thing to approve
  // rather than a blank form. Still a draft; still spends nothing.
  const autoDrafted = [];
  if (autopilotEnabled()) {
    for (const row of written) {
      const action = row.proposed_action || {};
      if (action.type !== 'ad_campaign_draft') continue;
      if (!action.platform || !action.division || !Number.isFinite(Number(action.dailyBudgetCents))) continue;
      const result = await createAdCampaignDraft({
        platform: action.platform,
        objective: action.objective || 'lead_gen',
        division: action.division,
        dailyBudgetCents: action.dailyBudgetCents,
        createdBy: 'reina_growth_scan',
      }, deps);
      if (result.ok) {
        autoDrafted.push(result.campaign.id);
        await supabaseRequest(`growth_suggestions?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ linked_record_id: result.campaign.id, updated_at: now.toISOString() }),
        });
      }
    }
  }

  res.status(200).json({
    ok: true,
    scannedAt: facts.asOf,
    suggestionsComputed: suggestions.length,
    suggestionsWritten: written.length,
    suggestionsSkippedAlreadyDecided: suggestions.length - toWrite.length,
    campaignsAutoDrafted: autoDrafted.length,
    autopilotEnabled: autopilotEnabled(),
  });
}

export default async function handler(req, res) {
  const resource = req.query.resource;

  // Same shared-secret cron bypass as api/social-posts.js -- Vercel Cron
  // carries no Supabase user session, so it must skip requireUser.
  if (resource === 'growth_scan') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      try { return await handleGrowthScanGet(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }
  }

  const user = await requireUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Not authenticated. Sign in and try again.' });
  }
  req.hlUser = user;

  try {
    if (resource === 'growth_suggestions' && req.method === 'GET') {
      return await handleGrowthSuggestionsGet(req, res);
    }
    if (resource === 'growth_suggestion_decide' && req.method === 'POST') {
      return await handleGrowthSuggestionDecidePost(req, res);
    }
    // A signed-in human may also run the scan on demand -- useful right after
    // connecting a platform, rather than waiting for Monday.
    if (resource === 'growth_scan' && req.method === 'GET') {
      return await handleGrowthScanGet(req, res);
    }
    return res.status(404).json({ ok: false, error: 'Unknown resource: ' + resource });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
