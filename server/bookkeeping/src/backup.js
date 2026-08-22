// server/bookkeeping/src/backup.js
//
// A real "Back up now" capability. Until this file existed, this app had
// NONE anywhere -- api/bookkeeping/ledger/close-package.js's own header
// comment disclosed it plainly: "'Back up now' ... has NO equivalent
// capability anywhere in server/bookkeeping/src/ -- there is no backup
// engine to wire up. It is deliberately omitted from this app's Books Home
// page rather than faked." This closes that gap for real.
//
// Why this can't be a straight port of the reference's backup-verifier.js /
// server.js performBackup(): the reference is a single always-on Node
// process with a local SQLite file and local evidence/catalog-image
// directories, so its "backup" is a real filesystem copy (store.backup(),
// fs.cp() of two directories) into a local backups/<timestamp>/ folder,
// verified later by re-reading that same folder from disk.
// This app runs on Vercel serverless functions: there is no long-lived local
// disk any backup could be written to and later read back from (each
// invocation gets an ephemeral, per-instance /tmp at best), and its durable
// data already lives in Supabase Postgres (which has its own point-in-time
// recovery) or, in memory-mode, nowhere durable at all. A backup feature
// here that tried to imitate the reference's local-file-copy design would
// either silently do nothing useful or quietly fail on every real
// deployment -- exactly the kind of faked feature this rebuild's standing
// rules forbid.
//
// So the honest equivalent: build a complete, self-contained, downloadable
// snapshot of every real record this company has -- the full ledger system
// (chart of accounts, companies, journal entries, audit chain, controls),
// every saved expense, every catalog item, every purchase order, and the
// ORIGINAL BYTES of every evidence document (not just an index) -- as one
// checksum-manifested zip, using the same createZip()/manifest-with-sha256
// pattern buildClosePackage() and buildExportPackage() already established
// in this app. The download itself IS the backup; the owner is responsible
// for storing it somewhere durable (a second cloud drive, an external disk,
// their accountant's own storage) -- exactly the same responsibility the
// reference's own backup-note text places on the owner when no external
// location is configured, just made honest about there being no server-side
// storage step in between here.

import { createHash } from 'node:crypto';
import { createZip } from './archive.js';

function sanitizeFileNamePart(value) {
  return String(value || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_') // strip path separators and anything else non-safe
    .replace(/\.\.+/g, '_')           // collapse ".." (and longer dot runs) so a hostile id/filename can never traverse out of evidence/
    .replace(/^\.+/, '_')             // never let a sanitized name start with a dot either (hidden-file / relative-path ambiguity)
    .slice(0, 180);
}

// Pure and synchronous by design (matches buildClosePackage/
// buildExportPackage) -- all I/O (loading every store, fetching every
// evidence document's actual bytes) happens in the route layer
// (api/bookkeeping/backup.js), which hands this function plain data.
export function buildBackupArchive({ companyId, system, expenses, catalog, purchaseOrders, evidenceDocuments, evidenceFiles }) {
  const createdAt = new Date().toISOString();
  const files = [];
  const addJson = (name, value) => files.push({ name, content: Buffer.from(JSON.stringify(value ?? null, null, 2)) });

  addJson('data/ledger-system.json', system);
  addJson('data/expenses.json', expenses || []);
  addJson('data/catalog.json', catalog || []);
  addJson('data/purchase-orders.json', purchaseOrders || []);
  addJson('data/evidence-index.json', evidenceDocuments || []);

  for (const file of evidenceFiles || []) {
    if (!file?.dataBase64) continue; // a document whose bytes could not be fetched is skipped, not silently zero-filled
    const safeName = `${sanitizeFileNamePart(file.id)}-${sanitizeFileNamePart(file.filename)}`;
    files.push({ name: `evidence/${safeName}`, content: Buffer.from(file.dataBase64, 'base64') });
  }

  // Checksums are computed from the SAME buffers being zipped, in the same
  // pass -- not recomputed later from a re-read copy -- so there is no
  // window where the manifest could describe different bytes than what
  // actually shipped in the archive.
  const manifestFiles = files.map(file => ({ path: file.name, bytes: file.content.length, sha256: createHash('sha256').update(file.content).digest('hex') }));

  const manifest = {
    format: 'hivelogic-backup-v1',
    companyId,
    createdAt,
    counts: {
      expenses: (expenses || []).length,
      catalogItems: (catalog || []).length,
      purchaseOrders: (purchaseOrders || []).length,
      evidenceDocuments: (evidenceDocuments || []).length,
      evidenceFilesIncluded: files.filter(f => f.name.startsWith('evidence/')).length
    },
    files: manifestFiles
  };

  const readme = [
    'HiveLogic full data backup',
    `Company: ${companyId}`,
    `Created: ${createdAt}`,
    '',
    'This is a complete, point-in-time export of every bookkeeping record this',
    'company has: the full ledger (chart of accounts, journal entries, audit',
    'trail, controls) in data/ledger-system.json, every saved expense, catalog',
    'item, and purchase order as JSON, and the ORIGINAL FILE BYTES of every',
    'evidence document (receipts, bills, statements) under evidence/ -- not',
    'just a list of what they were.',
    '',
    'manifest.json lists a SHA-256 checksum for every file in this archive.',
    'Recompute a file\'s hash after unzipping and compare it to the manifest',
    'entry to confirm nothing was altered or corrupted.',
    '',
    'This app runs on serverless infrastructure with no persistent local',
    'disk of its own, so there is no separate server-side backup store this',
    'file was copied from -- this download IS the backup. Save it somewhere',
    'durable: a second cloud drive, an external disk, or your accountant\'s',
    'own storage.'
  ].join('\r\n');

  files.push({ name: 'README.txt', content: Buffer.from(readme) });
  files.push({ name: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2)) });

  const buffer = createZip(files);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return { buffer, sha256, manifest };
}
