// api/bookkeeping/ledger/close-package.js
// Builds and downloads the real accountant close package for a period --
// buildClosePackage() in server/bookkeeping/src/close.js was already a
// complete, tested engine (chart of accounts, journal entries, trial
// balance, balance sheet, P&L, cash-flow workpaper, AP aging, bank
// registers, reconciliations, sales-tax liability, contractor summary,
// exceptions, audit log, evidence index, a real .xlsx review workbook, and a
// manifest.json with a SHA-256 per file, all zipped) with NO route wired to
// it anywhere in this app -- the exact "real engine, no route" pattern this
// rebuild keeps finding and fixing.
//
// This is intentionally stateless: it re-verifies close readiness and
// rebuilds the package fresh on every call rather than storing/versioning
// prepared packages. The reference app's controller.html shows a history of
// previously-prepared packages (status.packages) -- that requires a
// persistence layer this app doesn't have, so it is NOT reproduced here.
// Nothing is faked; a package is generated on demand, or the request is
// rejected with the real list of blockers if the period isn't ready.
//
// "Back up now" (the reference's other close-card button) now has a real
// equivalent: see api/bookkeeping/backup.js and
// server/bookkeeping/src/backup.js. It is a separate route/engine, not part
// of this one, since a full data backup and a period's accountant close
// package are different artifacts with different audiences and different
// readiness requirements (a backup never requires close readiness -- it's a
// safety net, not an accounting deliverable).
//
// sales_tax / contractors fix (task 7): same real-data wiring as
// ./close.js -- see ../_close_tax_adapters.js and that route's header
// comment. The sales-tax-liability and contractor-1099 sections of the
// generated package now reflect real tracked data instead of always
// reading $0 / no contractors.

let _load_close_cache;
async function _load_close() {
  if (!_load_close_cache) _load_close_cache = await import('../../../server/bookkeeping/src/close.js');
  return _load_close_cache;
}
import { getSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { listExpenses } from '../_expense_store.js';
import { listEvidence } from '../_evidence_store.js';
import { attachContractorAndSalesTaxData } from '../_close_tax_adapters.js';
import { guardBookkeepingRequest } from '../_security.js';

function withEvidenceDocumentIds(expense) {
  if (Array.isArray(expense.evidenceDocumentIds)) return expense;
  return { ...expense, evidenceDocumentIds: expense.evidenceId ? [expense.evidenceId] : [] };
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { buildClosePackage } = await _load_close();
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const throughDate = input.throughDate || new Date().toISOString().slice(0, 10);
    const system = await getSystem(actor.companyId);
    await attachContractorAndSalesTaxData(actor.companyId, system);
    const [rawExpenses, evidenceDocuments] = await Promise.all([
      listExpenses(actor.companyId),
      listEvidence(actor.companyId)
    ]);
    const expenses = rawExpenses.map(withEvidenceDocumentIds);

    let result;
    try {
      result = buildClosePackage({ system, expenses, companyId: actor.companyId, throughDate, evidenceDocuments });
    } catch (buildError) {
      // buildClosePackage() throws "Period cannot close: <blocker details>"
      // when readiness fails -- recompute readiness to hand back the
      // structured blocker list too, not just the joined string, so the
      // caller can render the same exception queue as the GET /close route.
      const { closeReadiness } = await _load_close();
      const readiness = closeReadiness({ system, expenses, companyId: actor.companyId, throughDate, evidenceDocuments });
      res.status(422).json({ ok: false, error: buildError.message || 'Period cannot close.', readiness });
      return;
    }

    const filename = `hivelogic-close-package-${actor.companyId}-${throughDate}.zip`.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Package-Sha256', result.sha256);
    res.status(200).send(result.buffer);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Could not prepare the accountant package.' });
  }
}
