// test/onboarding-license-storage.test.mjs
//
// api/invites.js?resource=upload_license used to upload to a bucket named
// `onboarding-licenses`. That bucket has never existed on the production
// project -- production has exactly six: media, monitor-screenshots,
// voice-greetings, docs, devtodo-attachments, marketing-attachments. So the
// upload 400'd on every hire, the step was written `pending` with path: null,
// and the raw storage error was shown to the person holding the phone.
//
// The fix routes licences into the private `docs` bucket that already exists,
// under an `onboarding/licenses/` prefix, with a public.documents row marked
// `sensitive` -- HiveDoc's approved single file backend (REPORT.md,
// 2026-08-21). No migration, and nothing new to create in production.
//
// These tests are written from the two directions that actually matter: the
// bytes have to land somewhere reachable, and a driver's licence must not end
// up somewhere loose. Fully mocked.
// Run: node --experimental-test-module-mocks --test test/onboarding-license-storage.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const handler = (await import('../api/invites.js')).default;

// Every bucket that exists on production project sqhusuuhlmcmkeowdrga,
// enumerated 2026-08-21. A bucket named in code but absent here is the exact
// bug this file exists to stop happening again.
const REAL_BUCKETS = new Set([
  'media', 'monitor-screenshots', 'voice-greetings',
  'docs', 'devtodo-attachments', 'marketing-attachments',
  // Created by supabase/migrations/20260824101942_growth_engine_and_reels.sql
  // rather than by hand in the dashboard, which is why it is listed here
  // alongside the six the 2026-08-21 audit enumerated. The reel pipeline
  // Applied to production 2026-08-24; the bucket exists and is public.
  'content-reels',
]);

// Buckets named in code that the audit found missing and that have not been
// fixed yet. Listed rather than silently excluded, so the guard below stays
// true to its name and a NEW missing bucket still fails.
//
// EMPTY, and that is the point: all three writers the 2026-08-21 audit found
// pointing at buckets that do not exist -- `onboarding-licenses`
// (api/invites.js) and `sub-documents` / `sub-invoices` (api/subportal.js) --
// now file into `docs`. The map stays because the next one should be recorded
// here rather than quietly added to REAL_BUCKETS.
const KNOWN_BROKEN = new Map();

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

// storageOk / metadataOk let each test choose which of the two writes fails.
async function runUpload({ storageOk = true, metadataOk = true } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opts.body, headers: opts.headers || {} });
    if (u.includes('/rest/v1/onboarding_sessions')) return jsonRes([{ id: 'sess-1', company_id: 'co-9', status: 'in_progress' }]);
    if (u.includes('/rest/v1/onboarding_steps')) return jsonRes([{ id: 'step-1' }]);
    if (u.includes('/rest/v1/documents') && method === 'POST') {
      return metadataOk ? jsonRes([{ id: 'doc-77' }]) : jsonRes({ message: 'column "title" does not exist' }, 400);
    }
    if (u.includes('/storage/v1/object/') && method === 'POST') {
      return storageOk ? jsonRes({ Key: 'ok' }) : jsonRes({ error: 'Bucket not found' }, 400);
    }
    if (u.includes('/storage/v1/object/') && method === 'DELETE') return jsonRes({ message: 'Successfully deleted' });
    return jsonRes({ error: 'unexpected ' + method + ' ' + u }, 500);
  };
  const req = {
    method: 'POST',
    query: { resource: 'upload_license' },
    headers: { host: 'app.test' },
    body: { session_id: 'sess-1', filename: 'IMG 4821.HEIC', contentType: 'image/png', dataBase64: PNG },
  };
  const out = res();
  try { await handler(req, out); } finally { global.fetch = original; }

  const find = (pred) => calls.find(pred) || null;
  return {
    out, calls,
    upload: find((c) => c.url.includes('/storage/v1/object/') && c.method === 'POST'),
    del: find((c) => c.url.includes('/storage/v1/object/') && c.method === 'DELETE'),
    docInsert: find((c) => c.url.includes('/rest/v1/documents') && c.method === 'POST'),
    step: find((c) => c.url.includes('/rest/v1/onboarding_steps')),
  };
}

const stepRow = (step) => JSON.parse(step.body)[0];

// ---------- the bytes reach a bucket that exists ----------

test('the licence is uploaded to a bucket that actually exists in production', async () => {
  const { upload } = await runUpload();
  assert.ok(upload, 'an upload was attempted');
  const bucket = /\/storage\/v1\/object\/([^/]+)\//.exec(upload.url)[1];
  assert.equal(bucket, 'docs');
  assert.ok(REAL_BUCKETS.has(bucket), bucket + ' is not one of the six production buckets');
});

test('it is filed under an onboarding prefix, keyed to the session', async () => {
  const { upload } = await runUpload();
  assert.match(upload.url, /\/storage\/v1\/object\/docs\/onboarding\/licenses\/sess-1\/\d+_IMG_4821\.HEIC$/);
});

test('a successful upload reports the document it created', async () => {
  const { out } = await runUpload();
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.stored, true);
  assert.equal(out.body.document_id, 'doc-77');
  assert.equal(out.body.flagged_for_review, true, 'V1 is still office-reviewed; there is no OCR');
});

test('the step records where the file went, so the office can find it later', async () => {
  const { step } = await runUpload();
  const row = stepRow(step);
  assert.equal(row.status, 'complete');
  assert.equal(row.payload.bucket, 'docs');
  assert.equal(row.payload.document_id, 'doc-77');
  assert.match(row.payload.path, /^onboarding\/licenses\/sess-1\//);
});

test('the object path and the metadata row point at the same object', async () => {
  const { upload, docInsert } = await runUpload();
  const row = JSON.parse(docInsert.body)[0];
  assert.ok(upload.url.endsWith('/' + row.storage_path), 'a mismatch here means an unreadable file');
});

// ---------- the licence is treated as personal data ----------

test('the documents row is marked sensitive', async () => {
  const { docInsert } = await runUpload();
  assert.ok(docInsert, 'a metadata row was written');
  const row = JSON.parse(docInsert.body)[0];
  assert.equal(row.sensitive, true, "a driver's licence is admin-only inside the company");
  assert.match(row.storage_path, /^onboarding\/licenses\/sess-1\//);
  assert.equal(row.mime_type, 'image/png');
  assert.ok(row.size_bytes > 0);
});

test('the documents row never names a client or a job', async () => {
  // A licence belongs to a person, not to a customer's record. Writing a
  // client_id here would file somebody's ID under a homeowner's folder, and
  // would give client_visible something to resolve to.
  const { docInsert } = await runUpload();
  const row = JSON.parse(docInsert.body)[0];
  assert.equal(row.client_id, undefined);
  assert.equal(row.job_id, undefined);
});

test('only columns that exist in production are written', async () => {
  // `title`, `source`, `category`, client_visible and sub_visible arrive with
  // the 2026-08-21 HiveDoc migrations, which are NOT applied yet. Naming one
  // would make every licence upload fail with a PostgREST schema error.
  const UNAPPLIED = ['title', 'source', 'category', 'document_date', 'vendor_name', 'client_visible', 'sub_visible'];
  const { docInsert } = await runUpload();
  const row = JSON.parse(docInsert.body)[0];
  for (const col of UNAPPLIED) {
    assert.ok(!(col in row), col + ' is not in the production documents table yet');
  }
});

// ---------- failure leaves nothing loose ----------

test('a failed upload writes no metadata and leaves the step pending', async () => {
  const { out, docInsert, step } = await runUpload({ storageOk: false });
  assert.equal(out.statusCode, 502);
  assert.equal(out.body.stored, false);
  assert.equal(docInsert, null, 'no documents row for bytes that never landed');
  const row = stepRow(step);
  assert.equal(row.status, 'pending');
  assert.equal(row.payload.path, null);
  assert.equal(row.payload.document_id, null);
});

test('an unfiled object is deleted rather than left orphaned in the bucket', async () => {
  // Bytes with no documents row are unreachable (the `docs` read policy needs
  // one) and invisible to HiveDoc: personal data nobody can find or erase.
  const { out, upload, del } = await runUpload({ metadataOk: false });
  assert.ok(del, 'the object we could not describe was removed');
  assert.equal(del.url, upload.url, 'and only that object');
  assert.equal(out.statusCode, 502);
  assert.equal(out.body.stored, false);
  assert.equal(out.body.document_id, null);
});

// ---------- what the hire is told ----------

test('the hire is never shown our storage internals', async () => {
  for (const opts of [{ storageOk: false }, { metadataOk: false }]) {
    const { out } = await runUpload(opts);
    const note = String(out.body.note || '');
    assert.ok(note.length, 'the hire still gets an explanation');
    assert.doesNotMatch(note, /bucket|storage|supabase|documents row/i, note);
    assert.doesNotMatch(note, /\b[45]\d\d\b/, 'an HTTP status leaked: ' + note);
  }
});

test('the office still gets the technical reason, in the step payload', async () => {
  const { step } = await runUpload({ storageOk: false });
  assert.match(stepRow(step).payload.note, /failed \(400\)/);
});

test('the hire is not told to skip twice', async () => {
  // public/field/onboard.html appends its own "You can skip and the office will
  // follow up." to whatever comes back here.
  const onboard = fs.readFileSync(path.join(root, 'public', 'field', 'onboard.html'), 'utf8');
  assert.match(onboard, /r\.note\|\|r\.error[\s\S]{0,90}You can skip and the office will follow up/);
  const { out } = await runUpload({ storageOk: false });
  assert.doesNotMatch(String(out.body.note), /skip/i);
});

// ---------- the drift guard ----------

// Every bucket name api/ code mentions, as { bucket -> files that name it }.
function bucketsNamedInApiCode() {
  // /storage/v1/object/ is followed by either a bucket or one of the API's own
  // verbs (…/object/sign/<bucket>/…). Where the bucket is interpolated the verb
  // is all the regex can see, so verbs are skipped rather than reported.
  const STORAGE_VERBS = new Set(['sign', 'public', 'list', 'upload', 'copy', 'move', 'info', 'authenticated']);
  const found = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p); continue; }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(p, 'utf8');
      const patterns = [
        /_BUCKET\s*=\s*'([^']+)'/g,                 // const X_BUCKET = '...'
        /storage_bucket:\s*'([^']+)'/g,             // the search read model
        /\/storage\/v1\/object\/([a-z0-9-]+)\//g,   // a literal in a storage URL
        /uploadDataUrl\(\s*'([^']+)'/g,             // api/subportal.js's helper
      ];
      for (const re of patterns) {
        for (const m of src.matchAll(re)) {
          if (STORAGE_VERBS.has(m[1])) continue;
          if (!found.has(m[1])) found.set(m[1], []);
          found.get(m[1]).push(path.relative(root, p));
        }
      }
    }
  };
  walk(path.join(root, 'api'));
  return found;
}

test('every bucket named in api/ code either exists or is a filed known-broken one', () => {
  const offenders = [];
  for (const [bucket, files] of bucketsNamedInApiCode()) {
    if (REAL_BUCKETS.has(bucket) || KNOWN_BROKEN.has(bucket)) continue;
    offenders.push(bucket + ' (' + [...new Set(files)].join(', ') + ')');
  }
  assert.deepEqual(offenders, [], 'these bucket names do not exist in production');
});

test('the guard can see the buckets it says are still broken', () => {
  // Without this, KNOWN_BROKEN could quietly become a list of names nothing
  // matches -- and the guard above would pass while missing the real cases.
  const named = bucketsNamedInApiCode();
  for (const [bucket, why] of KNOWN_BROKEN) {
    assert.ok(named.has(bucket), bucket + ' is no longer referenced (' + why + ') -- drop it from KNOWN_BROKEN');
  }
});

test('all three writers the audit found are off the known-broken list', () => {
  const named = bucketsNamedInApiCode();
  for (const dead of ['onboarding-licenses', 'sub-documents', 'sub-invoices']) {
    assert.ok(!KNOWN_BROKEN.has(dead), dead + ' is fixed');
    assert.ok(!named.has(dead), 'no code path still writes to ' + dead);
  }
  assert.ok(named.has('docs'), 'they all go where the other documents go');
});

test('no migration creates a bucket that is not in the known set', () => {
  const dir = path.join(root, 'supabase', 'migrations');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.sql')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/insert into storage\.buckets[\s\S]{0,160}?values\s*\(\s*'([^']+)'/gi)) {
      if (!REAL_BUCKETS.has(m[1])) offenders.push(name + ': ' + m[1]);
    }
  }
  assert.deepEqual(offenders, [], 'a migration creates a bucket the audit did not find in production');
});

test('the dead bucket name is gone from the code, but not from the record', () => {
  const invites = fs.readFileSync(path.join(root, 'api', 'invites.js'), 'utf8');
  assert.doesNotMatch(invites, /'onboarding-licenses'/);
  assert.match(invites, /onboarding-licenses/, 'the history stays explained in a comment');
});

test('a licence photo stays out of the HiveDoc read model, deliberately', () => {
  // HiveDoc surfaces business files, and as of 2026-08-22 it reads four stores
  // rather than two -- documents, media, sub_documents, sub_invoices. A
  // photograph of an employee's government ID belongs to none of them: it is
  // HR/PII, it has no client, no job and no vendor, and it would answer no
  // question anybody asks HiveDoc. It is reachable today only through the
  // onboarding step that filed it.
  //
  // This is a source-reading guard, so it proves only that no code path names
  // the onboarding tables -- not that the licence is unreachable by some other
  // route. Its job is narrower than that: to make adding a fifth store over
  // this data a deliberate act rather than a side effect of widening a query.
  const hivedoc = fs.readFileSync(path.join(root, 'api', 'hivedoc.js'), 'utf8');
  assert.doesNotMatch(hivedoc, /onboarding_steps|onboarding_sessions/,
    'HiveDoc must not read the onboarding tables');
  const searchEngine = fs.readFileSync(path.join(root, 'api', '_lib', 'hivedoc-search.js'), 'utf8');
  assert.doesNotMatch(searchEngine, /normalizeOnboarding|onboarding_steps|onboarding_sessions/,
    'nor may the read model learn how to project one');
});
