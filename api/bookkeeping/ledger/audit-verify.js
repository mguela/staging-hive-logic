// api/bookkeeping/ledger/audit-verify.js
// GET-only, read-only integrity check for the general ledger's two hash
// chains (ledger.audit, controls.events).
//
// Fixes the verified gap: verifyAuditChain()/verifyEventChain() (in
// server/bookkeeping/src/ledger.js and controls.js) only ever checked a
// chain against itself -- every record's hash links to the previous
// record's hash, all computed from data inside the same one mutable jsonb
// blob (ledger_systems.data). That means a wholesale rewrite of that blob
// (by a compromised key, an app bug, or direct database access) could
// produce a DIFFERENT but still self-consistent chain, and the old check
// would report it as perfectly valid.
//
// This route instead calls verifyAuditChainAgainstLog() (_store.js), which
// compares the chain currently embedded in ledger_systems.data against
// bookkeeping_audit_log -- a separate table this database refuses UPDATE/
// DELETE on (see sql/013_bookkeeping_audit_log.sql). Only a chain that
// matches that independent, append-only witness record-for-record is
// reported valid.

import { verifyAuditChainAgainstLog } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Only GET is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const result = await verifyAuditChainAgainstLog(actor.companyId);
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not verify the audit chain.' });
  }
}
