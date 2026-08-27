// api/bookkeeping/estimates/list.js — GET all estimates for the actor's
// company, optionally filtered by ?clientId=. Real data — this is what the
// existing Estimate Builder's list view (efListRender) should read from
// once it's wired up, replacing the localStorage-draft-only flow it has
// today.

import { listEstimates } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';
import { supabaseRequest } from '../../_lib/jobber.js';

function formatAddress(loc) {
  if (!loc || !loc.street) return null;
  const cityLine = [loc.city, loc.province].filter(Boolean).join(', ') + (loc.postal_code ? ' ' + loc.postal_code : '');
  return cityLine.trim() ? `${loc.street}, ${cityLine}` : loc.street;
}

// jomell, 2026-08-27: the estimates list should show the client's address,
// same as it's now shown on the estimate email. One batched client_locations
// lookup for every distinct client on the page, not a query per row.
async function addressesByClientId(clientIds) {
  if (!clientIds.length) return {};
  const inList = clientIds.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
  const r = await supabaseRequest(`client_locations?jobber_id=in.(${encodeURIComponent(inList)})&select=jobber_id,street,city,province,postal_code`);
  if (!r.ok) return {};
  const rows = await r.json();
  const out = {};
  for (const row of rows) out[row.jobber_id] = formatAddress(row);
  return out;
}

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, estimates: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const clientId = req.query?.clientId || null;
    const estimates = await listEstimates(actor.companyId, { clientId });
    const { withComputedStatus } = await import('../../../server/bookkeeping/src/estimates.js');
    const addresses = await addressesByClientId([...new Set(estimates.map((e) => e.clientId).filter(Boolean))]);
    res.status(200).json({
      ok: true,
      enabled: true,
      estimates: estimates.map((e) => ({ ...withComputedStatus(e), clientAddress: addresses[e.clientId] || null })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not list estimates.' });
  }
}
