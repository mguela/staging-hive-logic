// api/bookkeeping/estimates/client-pricing.js — GET ?clientId=<jobber_id>
//
// jomell, 2026-08-27: the client profile modal's "Recent pricing" section --
// what a client was quoted for a line item, next to what the job it became
// actually carries for that same line item.
//
// No FK ties a job's line item back to "the" estimate line it came from
// (job_line_items and estimate.lines are both real tables, but nothing
// links a row in one to a row in the other) -- the only real join available
// is: an estimate that actually converted to a job (estimate.
// convertedJobId), matched to that job's line items by description text
// (trimmed, case-insensitive). This is a best-effort match, not a
// guaranteed one -- a renamed line item on either side won't match, and
// that's reported as "no job line found yet" (job: null) rather than a
// guessed number. Only estimates that actually converted are considered;
// an open estimate has no job to compare against yet.
//
// Discount/tax lines are excluded -- "line item" here means a real priced
// activity, not a percentage adjustment.

import { listEstimates } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';
import { supabaseRequest } from '../../_lib/jobber.js';

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, rows: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  const clientId = String((req.query && req.query.clientId) || '').trim();
  if (!clientId) { res.status(400).json({ ok: false, error: 'A clientId is required.' }); return; }

  try {
    const { linePrice } = await import('../../../server/bookkeeping/src/estimates.js');
    const estimates = await listEstimates(actor.companyId, { clientId });
    const converted = estimates.filter((e) => e.convertedJobId);

    const rows = [];
    for (const est of converted) {
      const jr = await supabaseRequest(
        `job_line_items?job_ref=eq.${encodeURIComponent(est.convertedJobId)}&select=description,line_total,created_at&order=sort_order.asc`
      );
      const jobLines = jr.ok ? await jr.json() : [];
      const jobByDesc = new Map();
      for (const jl of jobLines) {
        const key = norm(jl.description);
        // First match wins -- two job lines sharing a name is real
        // ambiguity, not something to silently sum or overwrite.
        if (key && !jobByDesc.has(key)) jobByDesc.set(key, jl);
      }

      const seen = new Set();
      for (const line of est.lines || []) {
        if (line.type === 'discount' || line.type === 'tax') continue;
        const key = norm(line.description);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const jobLine = jobByDesc.get(key);
        rows.push({
          lineItem: line.description,
          quoted: { amount: linePrice(line), date: est.sentAt || est.createdAt || null },
          job: jobLine ? { amount: Number(jobLine.line_total) || 0, date: jobLine.created_at || null } : null,
        });
      }
    }

    rows.sort((a, b) => new Date(b.quoted.date || 0).getTime() - new Date(a.quoted.date || 0).getTime());
    res.status(200).json({ ok: true, enabled: true, rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not load recent pricing.' });
  }
}
