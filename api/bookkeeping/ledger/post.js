// api/bookkeeping/ledger/post.js — posts an approved journal entry.
// Requires a client-supplied idempotency key (postEntry() enforces this) so
// a retried request can never post the same entry twice.
//
// Bank-feed loop closer (added alongside the Bank Feed sub-tab): when the
// entry being posted came from a bank-transaction classification
// (entry.source === 'bank_classification', set by classifyBankTransaction()
// in server/bookkeeping/src/banking.js), the matching bank transaction is
// still sitting at status 'classified_pending' at this point -- and nothing
// in the ported engine itself ever moves it further. postEntry() in
// ledger.js has no knowledge bank transactions even exist (banking.js was
// layered on top of it later), and classifyBankTransaction() only sets
// 'classified_pending' since the journal entry it creates isn't posted yet.
// Without this, a fully approved-and-posted bank classification would stay
// permanently "unresolved" for close-readiness purposes (the bank_matching
// check only accepts 'matched'/'classified'/'excluded') -- a real, latent
// gap in the ported engine, confirmed by grepping ledger.js/banking.js for
// any other place that sets status to 'classified' (there is none) and by
// banking.test.js's own coverage never posting the entry and checking the
// transition. Fixed here at the route layer, not inside the shared, already
// -tested ledger.js/banking.js engine files -- same "route completes what
// the engine leaves off" pattern already used for the job-cost-report
// route's per-line enrichment.

let _load_ledger_cache;
async function _load_ledger() {
  if (!_load_ledger_cache) _load_ledger_cache = await import('../../../server/bookkeeping/src/ledger.js');
  return _load_ledger_cache;
}
import { updateSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { postEntry } = await _load_ledger();
        const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!input.entryId) { res.status(400).json({ ok: false, error: 'entryId is required.' }); return; }
    const idempotencyKey = input.idempotencyKey || `post:${input.entryId}`;

    let posted = null;
    let bankTransactionClosed = false;
    await updateSystem(actor.companyId, system => {
      posted = postEntry(system.ledger, actor.companyId, input.entryId, { id: actor.id, role: actor.role }, idempotencyKey);
      if (posted.source === 'bank_classification' && posted.sourceId) {
        const company = system.ledger.companies[actor.companyId];
        const transaction = (company?.bankTransactions || []).find(item => item.id === posted.sourceId);
        if (transaction && transaction.status === 'classified_pending') { transaction.status = 'classified'; bankTransactionClosed = true; }
      }
      return system;
    });
    res.status(200).json({ ok: true, entry: posted, bankTransactionClosed });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not post this journal entry.' });
  }
}
