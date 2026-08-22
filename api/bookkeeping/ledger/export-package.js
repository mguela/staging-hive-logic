// api/bookkeeping/ledger/export-package.js
// Builds and downloads an audience-scoped export package --
// buildExportPackage()/verifyExportPackage() in
// server/bookkeeping/src/exports.js were already a complete, tested engine
// (trial balance CSV, income statement, balance sheet, retained earnings,
// and -- depending on audience -- sales-tax liability, AP aging,
// reconciliations, a full contractor tax report, the raw journal, and the
// raw audit log) with NO route wired to it anywhere in this app -- the same
// "real engine, no route" pattern this rebuild has found and fixed several
// times already (evidence upload, PO audit-verify, close-package, the
// bank-feed routes).
//
// This is deliberately a DIFFERENT, lighter-weight capability than
// close-package.js: buildClosePackage() is a single, always-accountant-
// audience, always-complete zip+xlsx bundle gated behind full close
// readiness. buildExportPackage() supports four distinct audiences
// (accountant / lender / insurer / buyer) that each get a different,
// audience-appropriate subset of files -- a lender or insurer export
// omits the raw audit log and contractor identities that an accountant
// export includes, for example -- and it is gated only on the books
// themselves being internally consistent (a valid audit chain, unmodified
// posted entries, a balanced trial balance and balance sheet), not on the
// full 18-point close checklist. It produces individual CSV/JSON files
// with a manifest, not a zip -- callers can request just the manifest
// (?format=manifest) to see what a full export would contain before
// downloading it as a zip.
//
// Honest scope note: buildExportPackage() also accepts optional `sales`,
// `taxPayments`, and `contractorPayments` arrays for the sales-tax and
// contractor sections. This app has no data source for any of those yet
// (no sales/POS ledger, no separate tax-payment tracking, no 1099
// contractor-payment tracking) -- they are passed as empty arrays here,
// which produces an honest "$0 / no contractors" result rather than a
// fabricated one, and the response's `note` field says so explicitly
// rather than letting an empty sales-tax-liability section look complete.

let _load_exports_cache;
async function _load_exports() {
  if (!_load_exports_cache) _load_exports_cache = await import('../../../server/bookkeeping/src/exports.js');
  return _load_exports_cache;
}
let _load_archive_cache;
async function _load_archive() {
  if (!_load_archive_cache) _load_archive_cache = await import('../../../server/bookkeeping/src/archive.js');
  return _load_archive_cache;
}
import { getSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { listExpenses } from '../_expense_store.js';
import { guardBookkeepingRequest } from '../_security.js';

const AUDIENCES = ['accountant', 'lender', 'insurer', 'buyer'];

function fiscalYearStartFor(throughDate, fiscalYearStartMonth) {
  const [year, month] = throughDate.split('-').map(Number);
  const fyMonth = Number(fiscalYearStartMonth) || 1;
  const fyYear = month >= fyMonth ? year : year - 1;
  return `${fyYear}-${String(fyMonth).padStart(2, '0')}-01`;
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { buildExportPackage, verifyExportPackage } = await _load_exports();
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const audience = input.audience;
    if (!AUDIENCES.includes(audience)) { res.status(400).json({ ok: false, error: `audience must be one of: ${AUDIENCES.join(', ')}.` }); return; }
    const throughDate = input.throughDate || new Date().toISOString().slice(0, 10);
    const basis = ['cash', 'accrual'].includes(input.basis) ? input.basis : undefined;

    const system = await getSystem(actor.companyId);
    const company = system.ledger.companies[actor.companyId];
    if (!company) { res.status(404).json({ ok: false, error: 'Company not found.' }); return; }
    const fiscalYearStartDate = input.fiscalYearStartDate || fiscalYearStartFor(throughDate, company.fiscalYearStartMonth);

    const rawExpenses = await listExpenses(actor.companyId);
    const accountsPayableAgingSupported = ['accountant', 'buyer'].includes(audience);

    let pkg;
    try {
      pkg = buildExportPackage({
        ledger: system.ledger,
        companyId: actor.companyId,
        audience,
        throughDate,
        fiscalYearStartDate,
        basis,
        expenses: accountsPayableAgingSupported ? rawExpenses : [],
        sales: [],
        taxPayments: [],
        vendors: [],
        contractorPayments: []
      });
    } catch (buildError) {
      res.status(422).json({ ok: false, error: buildError.message || 'Could not build this export package.' });
      return;
    }

    const verification = verifyExportPackage(pkg);
    const note = 'Sales-tax and contractor sections reflect $0 / no contractors because this app has no sales or contractor-payment data source yet -- not fabricated, genuinely empty.';

    if ((req.query?.format || input.format) === 'manifest') {
      res.status(200).json({ ok: true, manifest: { ...pkg, files: undefined }, files: pkg.files.map(({ name, sha256, bytes, audience: fileAudience, containsSensitive }) => ({ name, sha256, bytes, audience: fileAudience, containsSensitive })), verification, note });
      return;
    }

    const { createZip } = await _load_archive();
    const zipFiles = pkg.files.map(file => ({ name: file.name, content: file.content }));
    const buffer = createZip(zipFiles);
    const filename = `hivelogic-${audience}-export-${actor.companyId}-${throughDate}.zip`.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Verified', String(verification.valid));
    res.status(200).send(buffer);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Could not prepare this export package.' });
  }
}
