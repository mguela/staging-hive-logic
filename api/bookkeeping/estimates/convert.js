// api/bookkeeping/estimates/convert.js — approved -> converted. Body: { id }.
//
// Creates the real job, and produces the remaining payment schedule (every row
// except the already-collected deposit).
//
// Until 2026-08-17 this route did NOT create a job anywhere: it returned
// `${estimateNumber}-JOB` as a string and stopped. That severed the chain from
// lead to payment exactly here — an approved estimate could never become work
// anyone could schedule, cost or invoice — and was the single blocking defect
// in Phase 0.
//
// The job keeps the estimate's number: E-10001 becomes J-10001, and every
// change order and invoice that follows hangs off the same 10001. See
// api/_lib/project-numbers.js for the scheme.
//
// Still true, deliberately: nothing is written to Jobber. The job is
// HiveLogic's own. Jobber write-back belongs to a later phase.

let _load_estimates_cache;
async function _load_estimates() {
  if (!_load_estimates_cache) _load_estimates_cache = await import('../../../server/bookkeeping/src/estimates.js');
  return _load_estimates_cache;
}
import { getEstimate, updateEstimate } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';
import { createNativeJob, resolveCompanyUuid } from '../../_lib/native-job.js';
import { parseProjectSequence, jobRef } from '../../_lib/project-numbers.js';
import { supabaseRequest } from '../../_lib/jobber.js';

// Converting twice must never produce two jobs. Three things guard that, in
// order: this lookup, the estimate's own lifecycle (convertToJob refuses
// anything not in 'approved'), and finally uq_jobs_project_seq in the database.
// The last one is the only guarantee under a genuine race — the first two are
// what turn it into a clear message instead of a constraint violation.
async function findExistingJob(companyUuid, projectSeq) {
  const res = await supabaseRequest(
    `jobs?company_id=eq.${encodeURIComponent(companyUuid)}&project_seq=eq.${encodeURIComponent(projectSeq)}&select=jobber_id,project_seq,title,client_id,total,job_status,source_estimate_id&limit=1`,
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return (rows && rows[0]) || null;
}

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { convertToJob } = await _load_estimates();
    const { id } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'An estimate id is required.' }); return; }

    const current = await getEstimate(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Estimate not found.' }); return; }

    // Never create a job before proving the estimate is still in the one state
    // the conversion engine accepts. This also prevents a legacy "converted"
    // placeholder with no matching job from creating an orphan on retry.
    if (current.lifecycleStatus !== 'approved') {
      res.status(409).json({
        ok: false,
        error: current.lifecycleStatus === 'converted'
          ? 'This estimate is already marked converted; no new job was created.'
          : 'Only an approved estimate can be converted to a job.',
      });
      return;
    }

    // The project number the estimate was raised under is the number the job
    // inherits. An estimate numbered outside the scheme (none exist today, but
    // a hand-set number is possible) gets a fresh sequence rather than failing.
    const projectSeq = parseProjectSequence(current.estimateNumber);
    const companyUuid = await resolveCompanyUuid(actor.companyId);

    const already = projectSeq ? await findExistingJob(companyUuid, projectSeq) : null;

    // A job can exist while the estimate still says "approved" if the job
    // insert committed and the following optimistic estimate update failed.
    // That is recoverable: when (and only when) the job points back to this
    // exact estimate, reuse it and finish the second half on retry. A job with
    // the same number but a different/no source remains a hard conflict.
    const recoverable = already && current.lifecycleStatus !== 'converted' &&
      String(already.source_estimate_id || '') === String(current.id || '');
    if (already && !recoverable) {
      res.status(409).json({
        ok: false,
        error: `This estimate has already been converted — it is job ${jobRef(projectSeq)}.`,
        job: already,
      });
      return;
    }

    // Job first, then the estimate. If the job insert fails the estimate stays
    // 'approved' and the whole thing can simply be retried; doing it the other
    // way round would leave an estimate marked converted with no job behind it,
    // which is the state nobody can recover from by clicking again.
    let jobResult = recoverable ? {
      job: already,
      projectSeq,
      jobRef: jobRef(projectSeq),
    } : null;
    try {
      if (!jobResult) jobResult = await createNativeJob({
        companyId: actor.companyId,
        title: current.title || `Estimate ${current.estimateNumber}`,
        clientId: current.clientId || null,
        total: current.totals && (current.totals.cardPrice || current.totals.price),
        division: current.division || null,
        sourceEstimateId: current.id,
        projectSeq,
        companyUuid,
      });
    } catch (jobError) {
      if (jobError.code === 'PROJECT_NUMBER_TAKEN') {
        res.status(409).json({ ok: false, error: jobError.message });
        return;
      }
      throw jobError;
    }

    const updated = await updateEstimate(actor.companyId, id, est => {
      const next = convertToJob(est, actor, {});
      // convertToJob invents a placeholder id of its own; replace it with the
      // job that actually exists so the two records point at each other.
      return { ...next, convertedJobId: jobResult.jobRef, convertedJobRef: jobResult.job.jobber_id };
    });

    res.status(200).json({
      ok: true,
      estimate: updated,
      job: jobResult.job,
      jobRef: jobResult.jobRef,
      note: `Converted to job ${jobResult.jobRef}. Remaining payment schedule: ${updated.remainingPaymentSchedule.map(r => r.label + ' ($' + r.amount.toFixed(2) + ')').join(', ')}.`
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not convert this estimate to a job.' });
  }
}
