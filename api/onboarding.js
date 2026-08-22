// api/onboarding.js — Vercel serverless function (Company Setup + Cost Model V1).
//
// Persists the owner/employee onboarding flow into onboarding_sessions +
// onboarding_steps (sql/071) and recomputes the confidence score server-side on
// every step write. The setup wizard (public/setup/index.html) is the caller;
// it stays fully usable even if this endpoint is unavailable, but this makes
// the flow resumable and gives an honest, data-derived confidence number.
//
// Resources (?resource=):
//   session  GET  -> get-or-create the current company onboarding session + its steps
//   step     POST -> upsert one step {step_key,status,payload}, advance the
//                    session's current_step, recompute confidence, return session
//
// Confidence model (per the run-sheet): derived from the SOURCE mix of the
// company's cost_lines — confirmed weight 1.0, imported 0.8, benchmark 0.3,
// manual 1.0 (a human typed it). Score = round(100 * weighted-average). With no
// lines yet it falls back to the fraction of non-skipped steps completed, so a
// brand-new company still shows forward progress. Documented here so the number
// is never a mystery.

import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { resolveCompany } from './_lib/tenant.js';

const STEP_ORDER = ['trade', 'company', 'connect_books', 'crew', 'rate', 'import', 'live'];

const SOURCE_WEIGHT = { confirmed: 1.0, manual: 1.0, imported: 0.8, benchmark: 0.3 };

// The onboarding session belongs to the signed-in user's company (resolved from
// their membership), not a hardcoded slug.
async function getCompanyId(user) {
  const t = await resolveCompany(user);
  return t ? t.company_id : null;
}

async function getOrCreateSession(companyId) {
  const r = await supabaseRequest(
    `onboarding_sessions?company_id=eq.${companyId}&actor_type=eq.company&order=created_at.asc&limit=1`,
  );
  if (!r.ok) throw new Error('session read failed: ' + (await r.text()));
  const rows = await r.json();
  if (rows && rows[0]) return rows[0];
  const ins = await supabaseRequest('onboarding_sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: companyId, actor_type: 'company', current_step: STEP_ORDER[0],
      status: 'in_progress', started_at: new Date().toISOString(), confidence_score: 0,
    }]),
  });
  if (!ins.ok) throw new Error('session create failed: ' + (await ins.text()));
  return (await ins.json())[0];
}

async function getSteps(sessionId) {
  const r = await supabaseRequest(`onboarding_steps?session_id=eq.${sessionId}&order=created_at.asc`);
  if (!r.ok) throw new Error('steps read failed: ' + (await r.text()));
  return r.json();
}

// Confidence from the cost_lines source mix, else step-completion fraction.
async function computeConfidence(companyId, steps) {
  const r = await supabaseRequest(`cost_lines?company_id=eq.${companyId}&select=source&archived=eq.false`);
  const lines = r.ok ? await r.json() : [];
  if (lines.length > 0) {
    let sum = 0;
    for (const l of lines) sum += (SOURCE_WEIGHT[l.source] != null ? SOURCE_WEIGHT[l.source] : 0.3);
    return Math.round((sum / lines.length) * 100);
  }
  const done = (steps || []).filter((s) => s.status === 'complete').length;
  return Math.round((done / STEP_ORDER.length) * 100);
}

function nextStep(stepKey) {
  const i = STEP_ORDER.indexOf(stepKey);
  if (i < 0 || i >= STEP_ORDER.length - 1) return stepKey;
  return STEP_ORDER[i + 1];
}

export default async function handler(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const resource = (req.query && req.query.resource) || '';
  const method = (req.method || 'GET').toUpperCase();

  try {
    // Trades catalog — global (no company scope). Active rows grouped by
    // category, ordered by category_sort then sort_order. Powers step 1 of the
    // setup wizard. `trades` is readable by authenticated; here we read it with
    // the service role like every other table.
    if (resource === 'trades' && method === 'GET') {
      const r = await supabaseRequest(
        'trades?active=eq.true' +
        '&select=category,category_sort,name,slug,description,benchmark_key,benchmark_native,sort_order' +
        '&order=category_sort.asc,sort_order.asc',
      );
      if (!r.ok) throw new Error('trades read failed: ' + (await r.text()));
      const rows = await r.json();
      const categories = [];
      const idx = new Map();
      for (const t of rows) {
        if (!idx.has(t.category)) {
          idx.set(t.category, categories.length);
          categories.push({ category: t.category, category_sort: t.category_sort, trades: [] });
        }
        categories[idx.get(t.category)].trades.push(t);
      }
      return res.status(200).json({ ok: true, categories });
    }

    const companyId = await getCompanyId(auth.user);
    if (!companyId) return res.status(404).json({ ok: false, error: 'No company for this account.' });

    if (resource === 'session' && method === 'GET') {
      const session = await getOrCreateSession(companyId);
      const steps = await getSteps(session.id);
      return res.status(200).json({ ok: true, session, steps });
    }

    if (resource === 'step' && method === 'POST') {
      const body = req.body || {};
      const step_key = body.step_key;
      if (!step_key || !STEP_ORDER.includes(step_key)) {
        return res.status(400).json({ ok: false, error: 'valid step_key is required.' });
      }
      const status = ['pending', 'skipped', 'complete'].includes(body.status) ? body.status : 'complete';
      const session = await getOrCreateSession(companyId);

      const row = {
        company_id: companyId,
        session_id: session.id,
        step_key,
        status,
        payload: body.payload || null,
        completed_at: status === 'complete' ? new Date().toISOString() : null,
      };
      // Upsert on (session_id, step_key).
      const up = await supabaseRequest('onboarding_steps?on_conflict=session_id,step_key', {
        method: 'POST',
        headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify([row]),
      });
      if (!up.ok) throw new Error('step upsert failed: ' + (await up.text()));

      const steps = await getSteps(session.id);
      const confidence = await computeConfidence(companyId, steps);

      // Advance the session pointer + status.
      const isLastComplete = step_key === 'live' && status === 'complete';
      const patch = {
        current_step: isLastComplete ? 'live' : nextStep(step_key),
        confidence_score: confidence,
        status: isLastComplete ? 'complete' : 'in_progress',
        completed_at: isLastComplete ? new Date().toISOString() : null,
      };
      const sp = await supabaseRequest(`onboarding_sessions?id=eq.${session.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      if (!sp.ok) throw new Error('session update failed: ' + (await sp.text()));
      const updated = (await sp.json())[0];

      return res.status(200).json({ ok: true, session: updated, steps, confidence_score: confidence });
    }

    return res.status(404).json({ ok: false, error: `Unknown resource/method: ${resource} ${method}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
