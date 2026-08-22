// api/bookkeeping/confidence-lab.js
// The "Bookkeeper Confidence Lab" — a safe practice run that exercises the
// real, ported double-entry ledger/reporting/banking/close/export engine
// (server/bookkeeping/src/confidence-lab.js) against a self-contained,
// entirely fictional practice company ("Northstar Contracting"). It never
// reads, writes, or touches any of HiveLogic's real company data, real bank
// feeds, or real QuickBooks connection -- it only proves the accounting
// rules themselves catch normal mistakes (unbalanced entries, missing
// evidence, duplicate bills, locked periods, unreconciled banking, missing
// 1099 paperwork) before anyone relies on them for real numbers.
//
// Requires a real, server-verified HiveLogic session (not open to the
// internet), same as every other bookkeeping route, even though running the
// lab itself has no side effects on real data -- an unauthenticated endpoint
// is still a bad idea even when it's harmless.

let _load_confidence_lab_cache;
async function _load_confidence_lab() {
  if (!_load_confidence_lab_cache) _load_confidence_lab_cache = await import('../../server/bookkeeping/src/confidence-lab.js');
  return _load_confidence_lab_cache;
}
import { getTrustedActor } from './purchase-orders/_actor.js';
import { guardBookkeepingRequest } from './_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { runConfidenceLab } = await _load_confidence_lab();
        const lab = runConfidenceLab();
    res.status(200).json({ ok: true, ...lab });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'The confidence lab could not run.' });
  }
}
