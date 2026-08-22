// claude/_patch_hiveconnect_impersonation.cjs
// P0 SECURITY (2026-07-29): /api/hiveconnect-bridge?action=session took the
// caller's identity (hivelogicUserId + hivelogicEmail) straight from the POST
// body with NO verification, then minted a REAL HiveConnect session for that
// identity. Anyone could POST any email and be logged into that person's
// HiveConnect chat -- read and send their messages. Full impersonation.
//
// Fix (handler-level, api/hiveconnect-bridge.js):
//   - Require the caller's verified Supabase session (Bearer token) via the
//     shared requireUser() helper -> 401 signed-out.
//   - Derive the identity from the VERIFIED token (user.id / user.email).
//     The body's hivelogicUserId/hivelogicEmail are ignored for identity, so
//     a forged body can no longer choose whose session gets minted.
//   The browser caller (public/hiveconnect-mount.js) needs no change: it runs
//   in the main window, where the round-1 window.fetch shim already attaches
//   the signed-in token to same-origin /api/ requests.
//   (isDisabledUser was vestigial -- never sent by the real client, no schema
//   backs it -- so it's dropped from the handler path; ensureMappedAndMint
//   still defaults it off.)
//
// Also appends two handler-level regression tests (401 signed-out; identity
// comes from the token, not the body) to test/hiveconnect-bridge.test.mjs.
// The 9 existing tests exercise ensureMappedAndMint directly and are unchanged.
//
// Idempotent, verifies every anchor before writing, CRLF-safe.
// Usage: node claude/_patch_hiveconnect_impersonation.cjs [<target-repo-root>]

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const failures = [];
const skips = [];
const planned = [];

function patchFile(rel, edits, doneMarker) {
  const raw = read(rel);
  const crlf = raw.includes('\r\n');
  let src = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  if (src.includes(doneMarker)) { skips.push(rel); return; }
  for (const e of edits) {
    const n = src.split(e.anchor).length - 1;
    if (n !== 1) { failures.push(`${rel}: anchor found ${n}x (need 1): ${e.anchor.slice(0, 70)}...`); return; }
  }
  for (const e of edits) src = src.replace(e.anchor, e.replacement);
  planned.push({ rel, out: crlf ? src.replace(/\n/g, '\r\n') : src });
}

// ---------------------------------------------------------------------------
// 1. api/hiveconnect-bridge.js -- import + verified-identity handler.
// ---------------------------------------------------------------------------
patchFile('api/hiveconnect-bridge.js', [
  {
    anchor: `// ---------- HTTP handler ----------\nexport default async function handler(req, res) {`,
    replacement: `import { requireUser } from './_lib/auth.js';\n\n// ---------- HTTP handler ----------\nexport default async function handler(req, res) {`,
  },
  {
    anchor: `  const { hivelogicUserId, hivelogicEmail, isDisabledUser } = req.body || {};
  if (!hivelogicUserId || !hivelogicEmail) {
    res.status(400).json({ ok: false, error: 'hivelogicUserId and hivelogicEmail are required' });
    return;
  }

  try {
    const session = await ensureMappedAndMint(hivelogicUserId, hivelogicEmail, { isDisabledUser });`,
    replacement: `  // P0 security (2026-07-29): identity MUST come from the caller's verified
  // Supabase session, NEVER from client-supplied body fields. Before this,
  // anyone could POST any {hivelogicUserId, hivelogicEmail} and be minted a
  // real HiveConnect session as that person (read/send their chats). Verify
  // the Bearer token and derive identity from it; body id/email are ignored.
  const authedUser = await requireUser(req);
  if (!authedUser) {
    res.status(401).json({ ok: false, error: 'Not signed in.' });
    return;
  }
  const hivelogicUserId = authedUser.id;
  const hivelogicEmail = authedUser.email;
  if (!hivelogicEmail) {
    res.status(400).json({ ok: false, error: 'Your account has no email on file; cannot open HiveConnect.' });
    return;
  }

  try {
    const session = await ensureMappedAndMint(hivelogicUserId, hivelogicEmail, {});`,
  },
], 'P0 security (2026-07-29): identity MUST come from');

// ---------------------------------------------------------------------------
// 2. test/hiveconnect-bridge.test.mjs -- append two handler-level auth tests.
// ---------------------------------------------------------------------------
const TEST_IMPORT_ANCHOR = `import {
  ensureMappedAndMint,
  getMapping,
} from '../api/hiveconnect-bridge.js';`;
const TEST_IMPORT_REPLACEMENT = `import {
  ensureMappedAndMint,
  getMapping,
} from '../api/hiveconnect-bridge.js';
import bridgeHandler from '../api/hiveconnect-bridge.js';`;

const RUNNER_ANCHOR = `// ---------- runner ----------`;
const HANDLER_TESTS = `// ---------- 10 + 11. Handler auth gate (P0 impersonation fix, 2026-07-29) ----------
// These exercise the HTTP handler (not ensureMappedAndMint directly) with a
// full global.fetch stub, to prove the session action requires a verified
// token and derives identity from it -- not from client-supplied body fields.
function mkRes() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

check('session action with NO token returns 401 and never mints', async () => {
  const prevFetch = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://hl.test';
  process.env.SUPABASE_SERVICE_KEY = 'svc';
  let minted = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, status: 401 };
    if (String(url).includes('generate_link')) minted = true;
    throw new Error('no network expected when signed out: ' + url);
  };
  try {
    const req = { method: 'POST', query: { action: 'session' }, headers: {}, body: { hivelogicUserId: 'victim-id', hivelogicEmail: 'victim@evil.com' } };
    const res = mkRes();
    await bridgeHandler(req, res);
    assert.equal(res.code, 401, 'signed-out must be 401');
    assert.equal(minted, false, 'no session may be minted signed-out');
  } finally { globalThis.fetch = prevFetch; }
});

check('session action mints for the TOKEN identity, ignoring a forged body email', async () => {
  const prevFetch = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://hl.test';
  process.env.SUPABASE_SERVICE_KEY = 'svc';
  process.env.HIVECONNECT_SUPABASE_URL = 'https://hc.test';
  process.env.HIVECONNECT_SUPABASE_SERVICE_KEY = 'hcsvc';
  const TOKEN_EMAIL = 'alice@ghgrp.net';
  let generateLinkEmail = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    // 1) token verification -> the real signed-in user is alice
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'alice-id', email: TOKEN_EMAIL }) };
    // 2) mapping lookup (HL rest) -> already mapped, so we go straight to mint
    if (u.includes('/rest/v1/hiveconnect_account_map')) return { ok: true, json: async () => [{ hivelogic_user_id: 'alice-id', hiveconnect_user_id: 'hc-alice', status: 'active' }], text: async () => '[]' };
    // 3) generate_link -> capture which email the session is being minted for
    if (u.includes('/auth/v1/admin/generate_link')) { generateLinkEmail = JSON.parse(opts.body).email; return { ok: true, json: async () => ({ hashed_token: 'h' }), text: async () => '{}' }; }
    // 4) verify -> return a session
    if (u.includes('/auth/v1/verify')) return { ok: true, json: async () => ({ access_token: 'a', refresh_token: 'r', expires_at: 1 }) };
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const req = {
      method: 'POST', query: { action: 'session' },
      headers: { authorization: 'Bearer alice-token' },
      // forged body tries to impersonate someone else -- must be ignored:
      body: { hivelogicUserId: 'mallory-id', hivelogicEmail: 'mallory@evil.com' },
    };
    const res = mkRes();
    await bridgeHandler(req, res);
    assert.equal(res.code, 200, 'authed request should succeed');
    assert.ok(res.body.session && res.body.session.access_token, 'a session should be returned');
    assert.equal(generateLinkEmail, TOKEN_EMAIL, 'session MUST be minted for the token identity, not the forged body email');
  } finally { globalThis.fetch = prevFetch; }
});

// ---------- runner ----------`;

patchFile('test/hiveconnect-bridge.test.mjs', [
  { anchor: TEST_IMPORT_ANCHOR, replacement: TEST_IMPORT_REPLACEMENT },
  { anchor: RUNNER_ANCHOR, replacement: HANDLER_TESTS },
], 'Handler auth gate (P0 impersonation fix, 2026-07-29)');

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('ABORTED -- nothing written. Anchor problems:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
for (const p of planned) {
  fs.writeFileSync(path.join(ROOT, p.rel), p.out);
  console.log('PATCHED: ' + p.rel);
}
for (const s of skips) console.log('SKIP (already patched): ' + s);

const selfDest = path.join(ROOT, 'claude', '_patch_hiveconnect_impersonation.cjs');
if (path.resolve(__filename) !== selfDest) {
  fs.mkdirSync(path.dirname(selfDest), { recursive: true });
  fs.copyFileSync(__filename, selfDest);
  console.log('Installed script copy at claude/_patch_hiveconnect_impersonation.cjs');
}
console.log(`\nDone. ${planned.length} patched, ${skips.length} skipped.`);
