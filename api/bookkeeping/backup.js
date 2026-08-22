// api/bookkeeping/backup.js
//
// "Back up now" -- see server/bookkeeping/src/backup.js for why this app's
// backup capability is a downloadable, checksum-verified full-data zip
// rather than a port of the reference's local-file-copy design (this app
// has no persistent server-side disk to copy anything to or read a backup
// back from -- it runs on Vercel serverless functions). This route is the
// only place that touches every real store this app has in one request:
// the ledger system, expenses, catalog, purchase orders, and every
// evidence document's actual bytes (not just its metadata).
//
// Stateless, same as ./ledger/close-package.js and ./ledger/export-package.js:
// nothing is persisted or versioned here. Every click builds a fresh
// snapshot from whatever is in the stores right now.

import { createHash } from 'node:crypto';

let _load_backup_cache;
async function _load_backup() {
  if (!_load_backup_cache) _load_backup_cache = await import('../../server/bookkeeping/src/backup.js');
  return _load_backup_cache;
}

import { getSystem } from './ledger/_store.js';
import { getTrustedActor } from './purchase-orders/_actor.js';
import { listExpenses } from './_expense_store.js';
import { listCatalog } from './_catalog_store.js';
import { listPurchaseOrders } from './purchase-orders/_store.js';
import { listEvidence, getEvidence } from './_evidence_store.js';
import { guardBookkeepingRequest } from './_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { buildBackupArchive } = await _load_backup();

    const [system, expenses, catalog, purchaseOrders, evidenceDocuments] = await Promise.all([
      getSystem(actor.companyId),
      listExpenses(actor.companyId),
      listCatalog(actor.companyId),
      listPurchaseOrders(actor.companyId),
      listEvidence(actor.companyId)
    ]);

    // listEvidence() returns metadata only (by design -- see
    // _evidence_store.js) -- a real backup needs the actual bytes, so every
    // document is re-fetched individually here. A document that fails to
    // fetch is skipped by buildBackupArchive (never zero-filled or faked),
    // and its metadata still appears in data/evidence-index.json either way.
    const evidenceFiles = (await Promise.all(
      evidenceDocuments.map(doc => getEvidence(actor.companyId, doc.id).catch(() => null))
    )).filter(Boolean).map(full => ({ id: full.id, filename: full.filename, dataBase64: full.dataBase64 }));

    const result = buildBackupArchive({ companyId: actor.companyId, system, expenses, catalog, purchaseOrders, evidenceDocuments, evidenceFiles });

    // Recompute the hash of the exact buffer about to be sent and compare it
    // to what buildBackupArchive reported. This is the honest equivalent of
    // the reference's verifyLatestBackup() re-read-from-disk check: there is
    // no persisted copy here to re-read, but this still catches any
    // corruption introduced between building the archive and sending it,
    // rather than calling something "verified" without checking anything.
    const recomputed = createHash('sha256').update(result.buffer).digest('hex');
    if (recomputed !== result.sha256) {
      res.status(500).json({ ok: false, error: 'Backup integrity check failed -- the generated archive did not match its own checksum. Nothing was sent.' });
      return;
    }

    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const filename = `hivelogic-backup-${actor.companyId}-${stamp}.zip`.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Backup-Sha256', result.sha256);
    res.setHeader('X-Backup-File-Count', String(result.manifest.files.length));
    res.status(200).send(result.buffer);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Could not build a backup.' });
  }
}
