// api/bookkeeping/controls/status.js
//
// Read-only view over server/bookkeeping/src/controls.js's approval +
// QBO-outbox state for the actor's company: this app's own live
// ledger_systems row (via ../ledger/_store.js's getSystem(), the same
// versioned-blob store the General Ledger tab already reads/writes).
// controls.js itself has been fully ported and tested since Phase 4
// increment 1 (server/bookkeeping/test/controls.test.js) -- this is the
// first route in this app to ever read it.
//
// qboWriteEnabled reflects HIVELOGIC_QBO_WRITE_ENABLED honestly -- when
// false (the default), approvals can still be requested/decided (a real,
// useful governance workflow on its own), but nothing in this app will ever
// call the real QuickBooks write client; see ./qbo-sync.js.

import { getSystem } from '../ledger/_store.js';
import { getTrustedActor } from '../ledger/_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

let _load_controls_cache;
async function _load_controls() {
  if (!_load_controls_cache) _load_controls_cache = await import('../../../server/bookkeeping/src/controls.js');
  return _load_controls_cache;
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Only GET is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { verifyControlAudit } = await _load_controls();
    const system = await getSystem(actor.companyId);
    const controls = system.controls || { approvals: [], qboOutbox: [], events: [] };
    const pendingApprovals = controls.approvals.filter(item => item.status === 'pending');
    const outbox = controls.qboOutbox;
    const audit = verifyControlAudit(controls);

    res.status(200).json({
      ok: true,
      enabled: true,
      qboWriteEnabled: process.env.HIVELOGIC_QBO_WRITE_ENABLED === 'true',
      pendingApprovals,
      qboOutbox: outbox,
      qboOutboxSummary: {
        queued: outbox.filter(item => item.status === 'queued').length,
        inFlight: outbox.filter(item => item.status === 'in_flight').length,
        retry: outbox.filter(item => item.status === 'retry').length,
        blocked: outbox.filter(item => item.status === 'blocked').length,
        complete: outbox.filter(item => item.status === 'complete').length
      },
      controlAudit: { valid: audit.valid, records: audit.records }
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not load QuickBooks controls status.' });
  }
}
