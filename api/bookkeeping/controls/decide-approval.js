// api/bookkeeping/controls/decide-approval.js
//
// Approves or rejects a pending controls.js approval request (POST
// {approvalId, decision:'approve'|'reject', comment?}). Separation of
// duties is enforced inside decideApproval() itself -- the same actor who
// requested it can never decide it (checked by actor id, not role), and
// with this app's real single-tenant role set (admin -> ledger 'controller',
// crew -> ledger 'submitter', same mapping ../ledger/_actor.js already
// documents) an admin-submitted, controller-required approval can only be
// decided by a DIFFERENT admin account -- the same accepted single-tenant
// simplification already true of ../ledger/approve.js's journal-entry
// approvals; not a new gap introduced here.
//
// Real behavior, not a stub: when a decision results in status 'approved'
// AND the approval's entityType is one this app's accounting engine
// actually produces a QuickBooks payload for ('purchase' or 'bill' --
// server/bookkeeping/src/accounting.js's qboExpenseEntityType()), this also
// looks up the originating expense (its own real, already-computed
// qboPreview field -- never recomputed or invented here) and:
//   1. enqueues it into controls.js's QBO outbox via enqueueQboSync(), and
//   2. (task 6) records Reina's approved-learning memory for this expense's
//      line-level classifications via recordApprovedExpenseLearning(),
//      so future submissions with a similar vendor/sku/description get a
//      real suggestion instead of always reading "no history" -- see
//      ../reina-suggest.js for where that memory gets read back out.
// Both are deliberately best-effort and never allowed to mask a successful
// decision: the approval decision itself is already durably saved by the
// time either of these runs, so a failure in either is caught and reported
// in `note`/`learningNote`, never thrown back as a failed request.
//
// This does NOT call the real QuickBooks write client -- enqueueing is a
// separate, later, deliberate action from actually sending; see
// ./qbo-sync.js for that step, gated behind HIVELOGIC_QBO_WRITE_ENABLED.
// It also does NOT auto-fill anything on any future expense -- learning is
// suggest-only; see ../reina-suggest.js's own header comment for how the
// off-by-default HIVELOGIC_REINA_LEARNING_AUTOFILL_ENABLED gate caps what
// strength of suggestion that route will report.

import { updateSystem } from '../ledger/_store.js';
import { getTrustedActor } from '../ledger/_actor.js';
import { getExpense } from '../_expense_store.js';
import { updateLearningState } from '../_learning_store.js';
import { guardBookkeepingRequest } from '../_security.js';

let _load_controls_cache;
async function _load_controls() {
  if (!_load_controls_cache) _load_controls_cache = await import('../../../server/bookkeeping/src/controls.js');
  return _load_controls_cache;
}
let _load_reina_learning_cache;
async function _load_reina_learning() {
  if (!_load_reina_learning_cache) _load_reina_learning_cache = await import('../../../server/bookkeeping/src/reina-learning.js');
  return _load_reina_learning_cache;
}

const QBO_ENTITY_TYPES = ['purchase', 'bill'];

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { decideApproval, enqueueQboSync } = await _load_controls();
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!input.approvalId) { res.status(400).json({ ok: false, error: 'approvalId is required.' }); return; }
    if (!['approve', 'reject'].includes(input.decision)) { res.status(400).json({ ok: false, error: 'decision must be "approve" or "reject".' }); return; }

    const ledgerActor = { id: actor.id, role: actor.role };
    let decided = null;
    await updateSystem(actor.companyId, system => {
      decided = decideApproval(system.controls, input.approvalId, input.decision, input.comment || '', ledgerActor);
      return system;
    });

    let outboxItem = null;
    let note = null;
    let learningNote = null;
    if (decided.status === 'approved' && QBO_ENTITY_TYPES.includes(decided.entityType)) {
      let expense = null;
      try {
        expense = await getExpense(actor.companyId, decided.entityId);
      } catch (lookupError) {
        note = `Approved, but the originating expense record could not be looked up (${lookupError.message || 'unknown error'}) -- nothing was queued for sync or recorded for Reina.`;
      }

      if (expense && !note) {
        if (!expense.qboPreview) {
          note = 'Approved, but the originating expense\'s QuickBooks payload could not be found -- nothing was queued for sync.';
        } else {
          try {
            await updateSystem(actor.companyId, system => {
              outboxItem = enqueueQboSync(system.controls, {
                companyId: actor.companyId,
                entityType: decided.entityType,
                entityId: decided.entityId,
                payload: expense.qboPreview,
                approvalRequestId: decided.id
              }, ledgerActor);
              return system;
            });
            note = 'Approved and queued for QuickBooks sync. Nothing was sent to QuickBooks yet -- a bookkeeper or controller must trigger the sync.';
          } catch (qboError) {
            note = `Approved, but could not queue for QuickBooks sync (${qboError.message || 'unknown error'}). The approval itself was saved correctly.`;
          }
        }

        // Reina learning bridge (task 6) -- suggest-only, no autofill.
        // Records this expense's approved line-level classifications so a
        // future similar vendor/sku/description gets a real suggestion
        // (see ../reina-suggest.js). Idempotent: recordApprovedExpenseLearning
        // keys each event on (companyId, approvalId, lineId), so retrying
        // this same decision (or a replayed request) never creates
        // duplicate memories.
        try {
          const { recordApprovedExpenseLearning } = await _load_reina_learning();
          let learned = null;
          await updateLearningState(actor.companyId, state => {
            const result = recordApprovedExpenseLearning(state, { companyId: actor.companyId, approval: decided, expense }, ledgerActor);
            learned = result;
            return result.state;
          });
          const newCount = (learned?.events || []).filter(item => !item.replayed).length;
          learningNote = newCount
            ? `Reina recorded ${newCount} approved classification(s) from this expense for future suggestions.`
            : 'Reina had already recorded this expense\'s classifications (no new memory needed).';
        } catch (learningError) {
          learningNote = `Approved, but Reina could not record this expense for future suggestions (${learningError.message || 'unknown error'}). This never affects the approval or QuickBooks queueing above.`;
        }
      }
    }

    res.status(200).json({ ok: true, approval: decided, outbox: outboxItem, note, learningNote });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not decide this approval.' });
  }
}
