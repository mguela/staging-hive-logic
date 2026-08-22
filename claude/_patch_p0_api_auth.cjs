// claude/_patch_p0_api_auth.cjs
// P0 SECURITY FIX (2026-07-29): /api/clients and /api/jobs returned the full
// synced Jobber dataset (8,600+ client names/emails/balances, 2,700+ jobs)
// to ANY anonymous request -- no session check at all, queries ran on the
// service key. Confirmed live: GET /api/clients returned totalCount 8662
// signed out.
//
// This patch:
//   1. api/clients.js  -- require a valid Supabase auth session; 401 otherwise.
//   2. api/jobs.js     -- same.
//      (Handler-level only: getClientsData/getJobsListData stay exported and
//      un-gated, so api/chat.js's in-process calls are unaffected. The
//      session check mirrors api/track1.js's getRequestingProfile -- mirrored,
//      not imported, same convention as fieldops.js / marketing.js / voice.js.)
//   3. public/index.html -- one fetch() shim right after hlTokenSync(): every
//      same-origin '/api/' request automatically carries the signed-in user's
//      Bearer token (unless the call site already set Authorization). This
//      covers the ~12 existing bare fetch('/api/clients...')/('/api/jobs...')
//      call sites in one anchored insertion instead of 12 fragile ones.
//   4. public/clientportal-admin/index.html -- its two bare fetches get the
//      page's existing TOKEN attached explicitly.
//
// Idempotent: safe to run more than once. If any anchor is missing it aborts
// without touching ANY file (all-or-nothing per file, checked up front).
// Run from the repo root:  node claude/_patch_p0_api_auth.cjs

const fs = require('fs');
const path = require('path');

// Optional argv: a target repo root to patch (defaults to the repo this
// script lives in). Lets the script run from one clone against another
// (e.g. an isolated worktree). It self-installs into <root>/claude/ so the
// canonical copy always travels with the patched code.
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);

let skipped = 0;
const failures = [];
const planned = []; // { rel, out } -- nothing is written until ALL files check out

function patchFile(rel, edits, doneMarker) {
  // Windows checkouts have CRLF working-tree files; anchors are written LF.
  // Match/patch on an LF-normalized copy, then restore the file's own endings
  // so the on-disk convention (and git's autocrlf behavior) is untouched.
  const raw = read(rel);
  const hadCRLF = raw.includes('\r\n');
  let src = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw;
  if (src.includes(doneMarker)) {
    console.log(`SKIP (already patched): ${rel}`);
    skipped++;
    return;
  }
  // Verify every anchor first -- if one is off, record the failure; no file
  // is written until every file's every anchor has been verified (see below).
  for (const e of edits) {
    const count = src.split(e.anchor).length - 1;
    if (count !== 1) {
      failures.push(`${rel}: anchor not found exactly once (found ${count}): ${e.anchor.slice(0, 80)}...`);
      return;
    }
  }
  for (const e of edits) {
    src = src.replace(e.anchor, e.replacement);
  }
  planned.push({ rel, out: hadCRLF ? src.replace(/\n/g, '\r\n') : src });
}

// ---------------------------------------------------------------------------
// 1 + 2. api/clients.js and api/jobs.js -- session gate on the HTTP handler.
// ---------------------------------------------------------------------------

const AUTH_HELPER = `
// P0 auth gate (2026-07-29): this endpoint previously returned the full synced
// Jobber dataset (real client PII) to anonymous requests. A valid signed-in
// Supabase session is now required. Minimal token verification mirrored from
// api/track1.js's getRequestingProfile (mirrored, not imported -- same
// convention as fieldops.js / marketing.js / voice.js; no profile lookup here
// because this endpoint only needs "is this a real signed-in user", not a
// role). Response shape for signed-in callers is unchanged.
async function requireUser(req) {
  const headers = (req && req.headers) || {};
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  const token = String(authHeader).replace(/^Bearer\\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(\`\${process.env.SUPABASE_URL}/auth/v1/user\`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: \`Bearer \${token}\`,
    },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  return user && user.id ? user : null;
}
`;

const GATE = `  const user = await requireUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
`;

patchFile('api/clients.js', [
  {
    anchor: `export default async function handler(req, res) {\n  try {`,
    replacement: `${AUTH_HELPER}\nexport default async function handler(req, res) {\n${GATE}  try {`,
  },
], 'P0 auth gate (2026-07-29)');

patchFile('api/jobs.js', [
  {
    anchor: `export default async function handler(req, res) {\n  try {`,
    replacement: `${AUTH_HELPER}\nexport default async function handler(req, res) {\n${GATE}  try {`,
  },
], 'P0 auth gate (2026-07-29)');

// ---------------------------------------------------------------------------
// 3. public/index.html -- one fetch() shim right after hlTokenSync().
// ---------------------------------------------------------------------------

// Anchor: the exact end of the hlTokenSync one-liner (verified unique).
const TOKEN_FN_TAIL = `if (v && v.currentSession && v.currentSession.access_token) return v.currentSession.access_token; } } catch (e) {} return null; }`;

const FETCH_SHIM = `
// P0 auth shim (2026-07-29): /api/clients and /api/jobs now require a signed-in
// session server-side (they used to hand the full client list to anonymous
// requests). Rather than editing every one of the ~12 bare fetch('/api/...')
// call sites in this file, wrap window.fetch once: same-origin '/api/' requests
// get the current Supabase access token attached automatically. A call site
// that already sets its own Authorization header (hlTokenSync() users like
// tasks.js patterns) is left untouched. Non-/api/ and cross-origin requests
// pass through unchanged.
(function(){
  var _hlOrigFetch = window.fetch;
  window.fetch = function(input, init){
    try {
      var url = (typeof input === 'string') ? input : ((input && input.url) || '');
      var isApi = url.indexOf('/api/') === 0 || url.indexOf(window.location.origin + '/api/') === 0;
      if (isApi) {
        var tok = hlTokenSync();
        if (tok) {
          init = init || {};
          var h = init.headers;
          var hasAuth = false;
          if (h) {
            if (typeof h.get === 'function') { hasAuth = !!h.get('Authorization'); }
            else { hasAuth = !!(h['Authorization'] || h['authorization']); }
          }
          if (!hasAuth) {
            if (h && typeof h.set === 'function') { h.set('Authorization', 'Bearer ' + tok); }
            else {
              var merged = {};
              if (h) { for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) merged[k] = h[k]; } }
              merged['Authorization'] = 'Bearer ' + tok;
              init.headers = merged;
            }
          }
        }
      }
    } catch (e) { /* never let the shim break a request */ }
    return _hlOrigFetch.call(this, input, init);
  };
})();
`;

patchFile('public/index.html', [
  {
    anchor: TOKEN_FN_TAIL,
    replacement: TOKEN_FN_TAIL + '\n' + FETCH_SHIM,
  },
], 'P0 auth shim (2026-07-29)');

// ---------------------------------------------------------------------------
// 4. public/clientportal-admin/index.html -- attach the page's existing TOKEN.
// ---------------------------------------------------------------------------

patchFile('public/clientportal-admin/index.html', [
  {
    anchor: `  const res = await fetch('/api/jobs?limit=1000');`,
    replacement: `  // P0 auth (2026-07-29): /api/jobs now requires a signed-in session.
  const res = await fetch('/api/jobs?limit=1000', { headers: { Authorization: 'Bearer ' + TOKEN } });`,
  },
  {
    anchor: `  const res = await fetch('/api/clients?limit=5000&order=name');`,
    replacement: `  // P0 auth (2026-07-29): /api/clients now requires a signed-in session.
  const res = await fetch('/api/clients?limit=5000&order=name', { headers: { Authorization: 'Bearer ' + TOKEN } });`,
  },
], "P0 auth (2026-07-29)");

// ---------------------------------------------------------------------------
// 5. test/clients-by-ids.test.mjs -- the three handler() checks called the
//    endpoint signed-out, which is exactly what this patch now rejects.
//    Wrap them with a stubbed auth success (same mocked-everything policy the
//    file already follows) and add dedicated signed-out/bad-token 401 checks.
// ---------------------------------------------------------------------------

const TEST_HELPERS = `

// P0 auth gate (2026-07-29): handler() now requires a signed-in Supabase
// session. authedReq() + authAwareFetch() wrap the pre-existing scenarios:
// identical mocked behavior, plus a stubbed /auth/v1/user success so the
// gate passes. Dedicated checks below cover the signed-out/bad-token 401s.
function authedReq(req) {
  return { headers: { authorization: 'Bearer test-token' }, ...req };
}
function authAwareFetch(dataFetch) {
  return async (url, opts) => {
    if (String(url).includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: 'test-user', email: 't@example.com' }) };
    }
    return dataFetch(url, opts);
  };
}
`;

patchFile('test/clients-by-ids.test.mjs', [
  {
    anchor: `function fakeRes() {
  const calls = [];
  return {
    calls,
    status(code) {
      calls.push({ code });
      return { json: (body) => calls.push({ body }) };
    },
  };
}`,
    replacement: `function fakeRes() {
  const calls = [];
  return {
    calls,
    status(code) {
      calls.push({ code });
      return { json: (body) => calls.push({ body }) };
    },
  };
}
${TEST_HELPERS}`,
  },
  {
    anchor: `check('handler POST with ids[] returns ok:true without touching the GET path', async () => {
  const req = { method: 'POST', body: { ids: [] }, query: {} };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.calls[0].code, 200);
  assert.equal(res.calls[1].body.ok, true);
  assert.deepEqual(res.calls[1].body.clients, []);
});`,
    replacement: `check('handler POST with ids[] returns ok:true without touching the GET path', async () => {
  const originalFetch = global.fetch;
  global.fetch = authAwareFetch(async () => { throw new Error('data fetch should not be called for empty ids'); });
  try {
    const req = authedReq({ method: 'POST', body: { ids: [] }, query: {} });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 200);
    assert.equal(res.calls[1].body.ok, true);
    assert.deepEqual(res.calls[1].body.clients, []);
  } finally {
    global.fetch = originalFetch;
  }
});`,
  },
  {
    anchor: `  global.fetch = async () => {
    fetchCalled = true;
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => [],
    };
  };`,
    replacement: `  global.fetch = authAwareFetch(async () => {
    fetchCalled = true;
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => [],
    };
  });`,
  },
  {
    anchor: `    const req = { method: 'POST', body: {}, query: {} };`,
    replacement: `    const req = authedReq({ method: 'POST', body: {}, query: {} });`,
  },
  {
    anchor: `  global.fetch = async () => ({
    ok: true,
    headers: { get: (name) => (name === 'content-range' ? '0-0/1' : null) },
    json: async () => [mockClientRow('c1', 'Aaron Read')],
  });`,
    replacement: `  global.fetch = authAwareFetch(async () => ({
    ok: true,
    headers: { get: (name) => (name === 'content-range' ? '0-0/1' : null) },
    json: async () => [mockClientRow('c1', 'Aaron Read')],
  }));`,
  },
  {
    anchor: `    const req = { method: 'GET', query: {} };`,
    replacement: `    const req = authedReq({ method: 'GET', query: {} });`,
  },
  {
    anchor: `// ---------- runner ----------`,
    replacement: `// ---------- 11. P0 auth gate: signed-out gets 401, no data leaves ----------
check('handler with no Authorization header returns 401 and never queries data', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('no upstream call should happen when signed out'); };
  try {
    const req = { method: 'GET', query: {}, headers: {} };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 401);
    assert.equal(res.calls[1].body.ok, false);
    assert.equal(res.calls[1].body.clients, undefined, 'no client data in a 401 response');
  } finally {
    global.fetch = originalFetch;
  }
});

check('handler with an invalid token returns 401', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, status: 401 };
    throw new Error('data fetch should not happen for a rejected token');
  };
  try {
    const req = { method: 'GET', query: {}, headers: { authorization: 'Bearer bad' } };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.calls[0].code, 401);
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------- runner ----------`,
  },
], "P0 auth gate (2026-07-29): handler() now requires");

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error('\nABORTED -- no file was written. Anchor problems:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
for (const p of planned) {
  write(p.rel, p.out);
  console.log(`PATCHED: ${p.rel}`);
}
console.log(`\nDone. ${planned.length} file(s) patched, ${skipped} already patched.`);

// Self-install the canonical copy next to the patched code.
const selfDest = path.join(ROOT, 'claude', '_patch_p0_api_auth.cjs');
if (path.resolve(__filename) !== selfDest) {
  fs.copyFileSync(__filename, selfDest);
  console.log('Installed script copy at claude/_patch_p0_api_auth.cjs');
}
