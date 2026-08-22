// api/bookkeeping/ledger/bank-match.js — matches an imported bank/card
// transaction to an expense that was already entered through Expense Entry
// (the common case: a card purchase gets entered as an expense first, then
// shows up on the statement later). Wraps matchCandidates()/
// confirmBankMatch() (server/bookkeeping/src/banking.js).
//
// GET ?bankTransactionId=... -> ranked candidate expenses (amount/vendor-
// text/date scoring, already real and tested in banking.js -- this route
// just supplies the real transaction + real unmatched expenses it needs).
//
// POST { bankTransactionId, expenseId } -> confirms the match. This writes
// to TWO separate stores (the ledger system's bank transaction, and the
// expense record's bankTransactionId) since they are not one database in
// this app's architecture -- see _expense_store.js's updateExpense() header
// comment. The ledger side is written first (inside updateSystem, same
// pattern as every other ledger mutation route); the expense side is then
// updated best-effort, exactly like the existing ledger/PO bridges in
// expenses.js -- if the expense-side write fails after the transaction was
// already marked matched, that inconsistency is reported in the response,
// never silently hidden.

let _load_banking_cache;
async function _load_banking() {
  if (!_load_banking_cache) _load_banking_cache = await import('../../../server/bookkeeping/src/banking.js');
  return _load_banking_cache;
}
import { getSystem, updateSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { listExpenses, getExpense, updateExpense } from '../_expense_store.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  const { matchCandidates, confirmBankMatch } = await _load_banking();

  if (req.method === 'GET') {
    try {
      const { bankTransactionId } = req.query || {};
      if (!bankTransactionId) { res.status(400).json({ ok: false, error: 'bankTransactionId is required.' }); return; }
      const system = await getSystem(actor.companyId);
      const company = system.ledger.companies[actor.companyId];
      const transaction = (company?.bankTransactions || []).find(item => item.id === bankTransactionId);
      if (!transaction) { res.status(404).json({ ok: false, error: 'Bank transaction not found.' }); return; }
      const expenses = await listExpenses(actor.companyId);
      const candidates = matchCandidates(transaction, expenses);
      const byId = Object.fromEntries(expenses.map(expense => [expense.id, expense]));
      res.status(200).json({
        ok: true,
        transaction,
        candidates: candidates.map(candidate => ({ ...candidate, expense: byId[candidate.expenseId] ? { id: byId[candidate.expenseId].id, vendor: byId[candidate.expenseId].vendor, total: byId[candidate.expenseId].total, transactionDate: byId[candidate.expenseId].transactionDate } : null }))
      });
    } catch (error) {
      res.status(422).json({ ok: false, error: error.message || 'Could not find match candidates.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!input.bankTransactionId) { res.status(400).json({ ok: false, error: 'bankTransactionId is required.' }); return; }
      if (!input.expenseId) { res.status(400).json({ ok: false, error: 'expenseId is required.' }); return; }

      const expense = await getExpense(actor.companyId, input.expenseId);
      if (!expense) { res.status(404).json({ ok: false, error: 'That expense was not found.' }); return; }

      let transaction = null;
      await updateSystem(actor.companyId, system => {
        transaction = confirmBankMatch(system.ledger, actor.companyId, input.bankTransactionId, expense, { id: actor.id, role: actor.role });
        return system;
      });

      let expenseLinkNote = 'The expense record was updated with this match.';
      try {
        const updated = await updateExpense(actor.companyId, input.expenseId, current => ({ ...current, bankTransactionId: transaction.id }));
        if (!updated) expenseLinkNote = 'The bank transaction was matched, but the expense record could not be found to update -- it may have been deleted since this page loaded.';
      } catch (expenseError) {
        expenseLinkNote = `The bank transaction was matched, but the expense record's own bankTransactionId could not be saved (${expenseError.message || 'unknown error'}). The match is still recorded on the bank-transaction side.`;
      }

      res.status(200).json({ ok: true, transaction, note: expenseLinkNote });
    } catch (error) {
      res.status(422).json({ ok: false, error: error.message || 'Could not confirm this match.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Only GET and POST are supported.' });
}
