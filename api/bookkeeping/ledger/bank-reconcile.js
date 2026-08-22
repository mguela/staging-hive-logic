// api/bookkeeping/ledger/bank-reconcile.js — completes a month-end
// reconciliation for one bank/card account (reconcileStatement() in
// server/bookkeeping/src/banking.js) and verifies a completed one's
// integrity (verifyReconciliation()).
//
// POST { accountId, startDate, endDate, statementBeginningBalance,
// statementEndingBalance } -> the real book ending balance for this
// account through endDate is computed HERE from the actual trial balance
// (server/bookkeeping/src/ledger.js's trialBalance() -- the same function
// close.js's own trial_balance check already uses), never accepted from
// the client. banking.js's reconcileStatement() only checks that
// whatever statementEndingBalance/bookEndingBalance it's given are equal --
// if a client could supply its own bookEndingBalance, it could "reconcile"
// by just typing the same number twice, without that number having any
// relationship to what's actually posted. Deriving it server-side from the
// real ledger is what makes this reconciliation mean something.
//
// GET ?reconciliationId=... -> re-verifies a completed reconciliation's
// snapshot against the independent audit trail (already-tested
// verifyReconciliation()).

let _load_banking_cache;
async function _load_banking() {
  if (!_load_banking_cache) _load_banking_cache = await import('../../../server/bookkeeping/src/banking.js');
  return _load_banking_cache;
}
let _load_ledger_engine_cache;
async function _load_ledger_engine() {
  if (!_load_ledger_engine_cache) _load_ledger_engine_cache = await import('../../../server/bookkeeping/src/ledger.js');
  return _load_ledger_engine_cache;
}
import { getSystem, updateSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  if (req.method === 'GET') {
    try {
      const { reconciliationId } = req.query || {};
      if (!reconciliationId) { res.status(400).json({ ok: false, error: 'reconciliationId is required.' }); return; }
      const { verifyReconciliation } = await _load_banking();
      const system = await getSystem(actor.companyId);
      const result = verifyReconciliation(system.ledger, actor.companyId, reconciliationId);
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      res.status(422).json({ ok: false, error: error.message || 'Could not verify this reconciliation.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      for (const field of ['accountId', 'startDate', 'endDate', 'statementBeginningBalance', 'statementEndingBalance']) {
        if (input[field] === undefined || input[field] === null || input[field] === '') { res.status(400).json({ ok: false, error: `${field} is required.` }); return; }
      }

      const { reconcileStatement, trialBalance } = { ...(await _load_banking()), ...(await _load_ledger_engine()) };

      let reconciliation = null;
      await updateSystem(actor.companyId, system => {
        const trial = trialBalance(system.ledger, actor.companyId, input.endDate);
        const row = trial.rows.find(item => item.accountId === input.accountId);
        const bookEndingBalance = row ? row.balance : 0;
        reconciliation = reconcileStatement(system.ledger, actor.companyId, { ...input, bookEndingBalance }, { id: actor.id, role: actor.role });
        return system;
      });

      res.status(200).json({ ok: true, reconciliation });
    } catch (error) {
      res.status(422).json({ ok: false, error: error.message || 'Could not complete this reconciliation.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Only GET and POST are supported.' });
}
