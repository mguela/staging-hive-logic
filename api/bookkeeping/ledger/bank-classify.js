// api/bookkeeping/ledger/bank-classify.js — categorizes an unmatched bank/
// card transaction directly (for activity that never went through Expense
// Entry -- bank fees, direct debits, interest, transfers) by creating a
// real pending-approval journal entry (classifyBankTransaction() in
// server/bookkeeping/src/banking.js). The transaction itself moves to
// 'classified_pending' until that journal entry is approved and posted --
// see api/bookkeeping/ledger/post.js, which this commit also extends to
// flip the transaction the rest of the way to 'classified' once its journal
// entry actually posts (banking.js's own classifyBankTransaction() does not
// do this -- posting happens through a separate route/entry lifecycle, and
// nothing previously closed that loop; see post.js's header comment).
//
// Body: { bankTransactionId, offsetAccountId, classificationType?,
// description?, memo? }.

let _load_banking_cache;
async function _load_banking() {
  if (!_load_banking_cache) _load_banking_cache = await import('../../../server/bookkeeping/src/banking.js');
  return _load_banking_cache;
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
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!input.bankTransactionId) { res.status(400).json({ ok: false, error: 'bankTransactionId is required.' }); return; }
    if (!input.offsetAccountId) { res.status(400).json({ ok: false, error: 'offsetAccountId is required.' }); return; }

    const { classifyBankTransaction } = await _load_banking();
    let transaction = null;
    await updateSystem(actor.companyId, system => {
      transaction = classifyBankTransaction(system.ledger, actor.companyId, input.bankTransactionId, input, { id: actor.id, role: actor.role });
      return system;
    });

    res.status(200).json({
      ok: true,
      transaction,
      note: 'A pending-approval journal entry was created for this transaction. It stays "classified pending" (still counted as an open item for close readiness) until a different admin approves and posts it in General Ledger > Journal entries.'
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not classify this bank transaction.' });
  }
}
