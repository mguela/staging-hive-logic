// api/bookkeeping/estimates/delete.js — permanently removes a CONVERTED
// estimate and the real job it created. Body: { id }.
//
// 2026-08-25, jomell: "i want to delete the ones in the converted tab." Told
// explicitly first that converting creates a real row in the `jobs` table
// (the same table the crew board/scheduling reads), that staging shares the
// live production Supabase database, and that no code anywhere deletes a
// job today — asked to confirm real hard delete vs. a reversible archive,
// and chose real hard delete. This is that: irreversible, no undo.
//
// Scoped to 'converted' only. Every earlier lifecycle state already has a
// safe, reversible path (reject.js / cancel.js) that keeps history --
// this is the one deliberate exception, and only for the state where the
// estimate itself is done being an estimate (it already became a job).
//
// Job first, then the estimate: if the job delete fails, the estimate is
// left untouched and the whole thing can simply be retried. Deleting the
// estimate first would risk leaving an orphaned job with a dangling
// source_estimate_id if the second delete then failed.

import { getEstimate, deleteEstimate } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';
import { resolveCompanyUuid } from '../../_lib/native-job.js';
import { supabaseRequest } from '../../_lib/jobber.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { id } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'An estimate id is required.' }); return; }

    const current = await getEstimate(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Estimate not found.' }); return; }
    if (current.lifecycleStatus !== 'converted') {
      res.status(409).json({ ok: false, error: 'Only a converted estimate can be deleted this way — use Cancel for draft/sent/approved.' });
      return;
    }

    const companyUuid = await resolveCompanyUuid(actor.companyId);
    const jobRes = await supabaseRequest(
      `jobs?company_id=eq.${encodeURIComponent(companyUuid)}&source_estimate_id=eq.${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
    if (!jobRes.ok) {
      res.status(422).json({ ok: false, error: `Could not delete the associated job: ${(await jobRes.text()).slice(0, 300)}` });
      return;
    }

    await deleteEstimate(actor.companyId, id);
    res.status(200).json({ ok: true, note: `${current.estimateNumber} and its job were permanently deleted.` });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not delete this estimate.' });
  }
}
