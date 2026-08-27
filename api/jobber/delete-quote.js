// api/jobber/delete-quote.js — permanently removes a Jobber-synced quote
// row from HiveLogic's own mirror table. Body: { id } (the quote's
// jobber_id).
//
// 2026-08-25, jomell: after the same real-hard-delete for native estimates
// (api/bookkeeping/estimates/delete.js), asked for the ability on the whole
// Estimates list -- including the "real:" rows, which are actually quotes
// synced from the live Jobber account (hundreds of them: Converted 456 /
// Archived 524 in the tab counts, far more than any test data). Confirmed
// explicitly this includes real business quote history, not just test rows,
// and chose to build the delete anyway.
//
// IMPORTANT ASYMMETRY vs. deleting a native estimate: this table (`quotes`)
// is a one-way, read-only mirror of Jobber (sql/002_extended_resources.sql),
// upserted daily by api/jobber/sync-extended.js on jobber_id -- that sync
// never deletes a row. So this delete only removes HiveLogic's cached copy;
// if the quote still exists in Jobber, the very next daily sync silently
// re-inserts it. Jobber itself is never touched (this app has no write
// access to Jobber's quotes). The frontend modal says this plainly.

import { getTrustedActor } from '../bookkeeping/purchase-orders/_actor.js';
import { supabaseRequest } from '../_lib/jobber.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { id } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'A quote id is required.' }); return; }

    const delRes = await supabaseRequest(`quotes?jobber_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!delRes.ok) {
      res.status(422).json({ ok: false, error: `Could not delete this quote: ${(await delRes.text()).slice(0, 300)}` });
      return;
    }

    res.status(200).json({ ok: true, note: `Quote ${id} deleted from HiveLogic. If it still exists in Jobber, it will reappear on the next daily sync.` });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not delete this quote.' });
  }
}
