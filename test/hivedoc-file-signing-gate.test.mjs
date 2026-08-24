// test/hivedoc-file-signing-gate.test.mjs
//
// /api/hivedoc?resource=file mints a signed URL for a stored file. It runs on
// the SERVICE KEY, which bypasses RLS, so the gate the database would have
// applied has to be applied in the endpoint -- and it was not: the handler
// selected storage_path by id and signed it, for any signed-in user, with no
// visibility check at all. Knowing a row id was enough to open a payroll
// document or a contract, and as of 2026-08-22 onboarding licences are filed
// into the same table (api/invites.js), so the same hole would have exposed
// employees' driver's licences.
//
// The same pass fixes a second defect in that handler: `viewer` was referenced
// by every search path but never assigned, so resolveStaffViewer() was dead
// code and every search threw ReferenceError into the catch and returned 502.
//
// Fully mocked. Run: node --experimental-test-module-mocks --test test/hivedoc-file-signing-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const handler = (await import('../api/hivedoc.js')).default;

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

const LICENCE = {
  id: 'doc-77',
  filename: 'IMG_4821.HEIC',
  storage_path: 'onboarding/licenses/sess-1/1755800000000_IMG_4821.HEIC',
  doc_type: 'other',
  sensitive: true,
  mime_type: 'image/heic',
  uploaded_at: '2026-08-22T10:00:00Z',
};
const PERMIT = { id: 'doc-2', filename: 'permit.pdf', storage_path: 'x/permit.pdf', doc_type: 'permit', sensitive: false, uploaded_at: '2026-07-14T09:00:00Z' };
const PHOTO = { id: 'm-1', job_id: 'JOB1', storage_path: 'JOB1/companycam-1.jpg', created_at: '2026-07-20T12:00:00Z' };

// `role` is what profiles returns for the signed-in user. null models a profile
// lookup that failed, which resolveStaffViewer treats as least privileged.
async function run(query, { role = 'crew', row = LICENCE, table = 'documents', profileOk = true } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method });
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'someone@x.com' });
    if (u.includes('/rest/v1/profiles')) return profileOk ? jsonRes([{ role }]) : jsonRes({ message: 'nope' }, 403);
    if (u.includes('/rest/v1/' + table)) return jsonRes(row ? [row] : []);
    if (u.includes('/rest/v1/')) return jsonRes([]);
    if (u.includes('/storage/v1/object/sign/')) return jsonRes({ signedURL: '/object/sign/docs/abc?token=t' });
    return jsonRes({ error: 'unexpected ' + method + ' ' + u }, 500);
  };
  const req = { method: 'GET', query, headers: { authorization: 'Bearer t', host: 'app.test' } };
  const out = res();
  try { await handler(req, out); } finally { global.fetch = original; }
  return { out, calls, signed: calls.some((c) => c.url.includes('/storage/v1/object/sign/')) };
}

// ---------- the gate ----------

test('crew cannot sign a sensitive document, even holding its id', async () => {
  const { out, signed } = await run({ resource: 'file', system: 'documents', id: 'doc-77' }, { role: 'crew' });
  assert.equal(out.statusCode, 404);
  assert.equal(signed, false, 'no signed URL was ever minted');
});

test('the refusal does not confirm the file exists', async () => {
  // 404 and not 403: "you may not see this" tells somebody there is something
  // there to see. Identical to the response for an id that does not exist.
  const denied = await run({ resource: 'file', system: 'documents', id: 'doc-77' }, { role: 'crew' });
  const missing = await run({ resource: 'file', system: 'documents', id: 'nope' }, { role: 'admin', row: null });
  assert.equal(denied.out.statusCode, missing.out.statusCode);
  assert.deepEqual(denied.out.body, missing.out.body);
});

test('an admin can open the same licence', async () => {
  const { out, signed } = await run({ resource: 'file', system: 'documents', id: 'doc-77' }, { role: 'admin' });
  assert.equal(out.statusCode, 200);
  assert.ok(signed);
  assert.match(out.body.url, /^https:\/\/supabase\.test\/storage\/v1\/object\/sign\//);
});

test('superadmin too, and nobody else', async () => {
  for (const role of ['superadmin', 'admin']) {
    const { out } = await run({ resource: 'file', system: 'documents', id: 'doc-77' }, { role });
    assert.equal(out.statusCode, 200, role + ' should be able to open a sensitive file');
  }
  for (const role of ['crew', 'office', 'dispatcher', null, 'ADMIN']) {
    const { out } = await run({ resource: 'file', system: 'documents', id: 'doc-77' }, { role });
    assert.equal(out.statusCode, 404, String(role) + ' should not');
  }
});

test('a profile lookup that fails closes the door rather than opening it', async () => {
  const { out, signed } = await run({ resource: 'file', system: 'documents', id: 'doc-77' }, { role: 'admin', profileOk: false });
  assert.equal(out.statusCode, 404);
  assert.equal(signed, false);
});

test('ordinary files are unaffected -- crew still open a permit and a photo', async () => {
  const permit = await run({ resource: 'file', system: 'documents', id: 'doc-2' }, { role: 'crew', row: PERMIT });
  assert.equal(permit.out.statusCode, 200);
  const photo = await run({ resource: 'file', system: 'media', id: 'm-1' }, { role: 'crew', row: PHOTO, table: 'media' });
  assert.equal(photo.out.statusCode, 200);
});

test('signing still requires a session at all', async () => {
  const original = global.fetch;
  global.fetch = async () => jsonRes({ message: 'bad jwt' }, 401);
  const out = res();
  try { await handler({ method: 'GET', query: { resource: 'file', id: 'doc-77' }, headers: {} }, out); }
  finally { global.fetch = original; }
  assert.equal(out.statusCode, 401);
});

// ---------- the viewer that was never built ----------

test('a search resolves a viewer instead of throwing ReferenceError', async () => {
  const { out } = await run({ resource: 'search', q: 'permit' }, { role: 'admin', row: PERMIT });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
});

test('facets resolve a viewer too', async () => {
  const { out } = await run({ resource: 'facets' }, { role: 'admin', row: PERMIT });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.resource, 'facets');
});

test('a crew search does not return a sensitive document in the list', async () => {
  const { out } = await run({ resource: 'search' }, { role: 'crew', row: LICENCE });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.results.length, 0, 'the licence is filtered out before it is rendered');
});
