// api/bookkeeping/ledger/bank.js — GET: read-only view over a company's
// imported bank/card feed: which asset/liability accounts can receive an
// import, every imported transaction (optionally filtered), and completed
// reconciliations. No mutation happens here -- see bank-import.js,
// bank-classify.js, bank-match.js, and bank-reconcile.js for the actions
// that change state.
//
// Query params: ?accountId=... (filter transactions to one account),
// ?status=... (filter transactions to one status: unmatched | matched |
// classified_pending | classified).

import { getSystem } from './_store.js';
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
    const { accountId, status } = req.query || {};
    const system = await getSystem(actor.companyId);
    const company = system.ledger.companies[actor.companyId];
    if (!company) { res.status(404).json({ ok: false, error: 'Company not found.' }); return; }

    const accounts = Object.values(company.accounts || {}).filter(account => account.type === 'asset' || account.type === 'liability');
    let transactions = company.bankTransactions || [];
    if (accountId) transactions = transactions.filter(item => item.accountId === accountId);
    if (status) transactions = transactions.filter(item => item.status === status);
    transactions = transactions.slice().sort((a, b) => (b.postedDate || '').localeCompare(a.postedDate || ''));

    res.status(200).json({
      ok: true,
      accounts,
      transactions,
      reconciliations: (company.reconciliations || []).slice().sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''))
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not load the bank feed.' });
  }
}
