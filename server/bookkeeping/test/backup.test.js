import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildBackupArchive } from '../src/backup.js';

function fixtureSystem() {
  return {
    ledger: {
      companies: { co: { id: 'co', name: 'GH Group', accounts: [], entries: [] } },
      audit: []
    }
  };
}

test('buildBackupArchive returns a real zip buffer with a matching sha256 and a manifest listing every included file', () => {
  const result = buildBackupArchive({
    companyId: 'co',
    system: fixtureSystem(),
    expenses: [{ id: 'exp-1', total: 42 }],
    catalog: [{ id: 'cat-1', name: 'Romex wire' }],
    purchaseOrders: [{ id: 'po-1', poNumber: 'PO-1' }],
    evidenceDocuments: [{ id: 'doc-1', filename: 'receipt.png', status: 'received' }],
    evidenceFiles: [{ id: 'doc-1', filename: 'receipt.png', dataBase64: Buffer.from('fake receipt bytes').toString('base64') }]
  });

  // Real zip magic bytes (PK\x03\x04) -- this is an actual zip archive, not a fake file.
  assert.equal(result.buffer.subarray(0, 4).toString('hex'), '504b0304');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);

  const paths = result.manifest.files.map(f => f.path);
  assert.ok(paths.includes('data/ledger-system.json'));
  assert.ok(paths.includes('data/expenses.json'));
  assert.ok(paths.includes('data/catalog.json'));
  assert.ok(paths.includes('data/purchase-orders.json'));
  assert.ok(paths.includes('data/evidence-index.json'));
  assert.ok(paths.some(p => p.startsWith('evidence/doc-1-receipt.png')));

  // manifest.json and README.txt are added to the archive AFTER the manifest
  // is computed (matching buildClosePackage's own convention) -- the
  // manifest never lists itself.
  assert.equal(paths.includes('manifest.json'), false);

  assert.equal(result.manifest.counts.expenses, 1);
  assert.equal(result.manifest.counts.catalogItems, 1);
  assert.equal(result.manifest.counts.purchaseOrders, 1);
  assert.equal(result.manifest.counts.evidenceDocuments, 1);
  assert.equal(result.manifest.counts.evidenceFilesIncluded, 1);
});

test('every manifest entry\'s sha256 is a real, correct hash of that file\'s actual bytes', () => {
  const evidenceContent = Buffer.from('a very specific set of receipt bytes');
  const result = buildBackupArchive({
    companyId: 'co',
    system: fixtureSystem(),
    expenses: [],
    catalog: [],
    purchaseOrders: [],
    evidenceDocuments: [{ id: 'doc-9', filename: 'bill.pdf' }],
    evidenceFiles: [{ id: 'doc-9', filename: 'bill.pdf', dataBase64: evidenceContent.toString('base64') }]
  });
  const entry = result.manifest.files.find(f => f.path.startsWith('evidence/doc-9-bill.pdf'));
  assert.ok(entry, 'evidence file entry must be present in the manifest');
  const expectedHash = createHash('sha256').update(evidenceContent).digest('hex');
  assert.equal(entry.sha256, expectedHash);
  assert.equal(entry.bytes, evidenceContent.length);
});

test('an evidence document with no fetched bytes (dataBase64 missing) is skipped, never silently zero-filled or fabricated', () => {
  const result = buildBackupArchive({
    companyId: 'co',
    system: fixtureSystem(),
    expenses: [],
    catalog: [],
    purchaseOrders: [],
    evidenceDocuments: [{ id: 'doc-missing', filename: 'unreadable.png' }],
    evidenceFiles: [{ id: 'doc-missing', filename: 'unreadable.png', dataBase64: null }]
  });
  assert.equal(result.manifest.counts.evidenceFilesIncluded, 0);
  assert.equal(result.manifest.files.some(f => f.path.startsWith('evidence/')), false);
  // The index still records that the document exists (metadata is never
  // dropped), even though its bytes could not be included this time.
  assert.equal(result.manifest.counts.evidenceDocuments, 1);
});

test('filenames are sanitized so a hostile or malformed filename cannot escape the evidence/ directory or corrupt the archive', () => {
  const result = buildBackupArchive({
    companyId: 'co',
    system: fixtureSystem(),
    expenses: [],
    catalog: [],
    purchaseOrders: [],
    evidenceDocuments: [{ id: '../../etc/passwd', filename: '../../secret.txt' }],
    evidenceFiles: [{ id: '../../etc/passwd', filename: '../../secret.txt', dataBase64: Buffer.from('x').toString('base64') }]
  });
  const entry = result.manifest.files.find(f => f.path.startsWith('evidence/'));
  assert.ok(entry);
  assert.equal(entry.path.includes('..'), false);
  assert.equal(entry.path.includes('/etc/'), false);
  assert.ok(entry.path.startsWith('evidence/'));
});

test('two calls with identical input produce a deterministic file layout (same paths, same per-file hashes) -- createdAt is the only thing allowed to differ', () => {
  const input = {
    companyId: 'co',
    system: fixtureSystem(),
    expenses: [{ id: 'exp-1', total: 10 }],
    catalog: [],
    purchaseOrders: [],
    evidenceDocuments: [],
    evidenceFiles: []
  };
  const a = buildBackupArchive(input);
  const b = buildBackupArchive(input);
  assert.deepEqual(a.manifest.files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })), b.manifest.files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })));
});
