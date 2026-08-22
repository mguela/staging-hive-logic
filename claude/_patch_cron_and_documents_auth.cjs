// _patch_cron_and_documents_auth.cjs
// Security follow-ups (2026-07-31), quick wins from the route audit:
//   1. api/jobber/sync.js + api/jobber/sync-extended.js -- cron-only endpoints
//      that hit Jobber's API were publicly triggerable (quota-abuse vector).
//      Gate them the SAME way api/health-cron.js already does: require a valid
//      CRON_SECRET, sent automatically by Vercel Cron as a Bearer header (or
//      ?key= for a manual run). CRON_SECRET is confirmed set in production
//      (health-cron's identical gate is live and its cron runs), so the
//      scheduled syncs keep working; anonymous callers get 401.
//   2. api/documents.js -- the AI document classifier (calls Anthropic) had no
//      auth, so anyone could run up an Anthropic bill. Require a signed-in
//      Supabase session via the shared requireUser helper. Its only caller
//      (public/index.html) runs in the main window, where the window.fetch
//      auth-shim already attaches the token.
//
// Idempotent (per-file markers), verifies every anchor before writing, CRLF-safe.
// Usage: node _patch_cron_and_documents_auth.cjs [<target-repo-root>]

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

// Cron gate -- mirrors api/health-cron.js exactly (Bearer CRON_SECRET or ?key=).
const CRON_GATE =
`  // Cron auth (2026-07-31): this endpoint hits Jobber's API and must not be
  // publicly triggerable. Vercel Cron sends the Bearer automatically; manual
  // runs use ?key=<CRON_SECRET>. Same gate as api/health-cron.js.
  const _cronSecret = process.env.CRON_SECRET;
  const _q = req.query || {};
  const _cronAuthed = _cronSecret && (((req.headers && req.headers.authorization) || '') === \`Bearer \${_cronSecret}\` || _q.key === _cronSecret);
  if (!_cronAuthed) return res.status(401).json({ ok: false, error: 'This endpoint runs on Vercel Cron only. Manual test: ?key=<CRON_SECRET>' });
`;

// --- api/jobber/sync.js (8-space indented body) ---
patchFile('api/jobber/sync.js', [
  {
    anchor: `export default async function handler(req, res) {\n        const startedAt = Date.now();`,
    replacement: `export default async function handler(req, res) {\n${CRON_GATE}        const startedAt = Date.now();`,
  },
], 'Cron auth (2026-07-31)');

// --- api/jobber/sync-extended.js (2-space indented body) ---
patchFile('api/jobber/sync-extended.js', [
  {
    anchor: `export default async function handler(req, res) {\n  const startedAt = Date.now();`,
    replacement: `export default async function handler(req, res) {\n${CRON_GATE}  const startedAt = Date.now();`,
  },
], 'Cron auth (2026-07-31)');

// --- api/documents.js -- require a signed-in session ---
patchFile('api/documents.js', [
  {
    anchor: `import Anthropic from '@anthropic-ai/sdk';\n`,
    replacement: `import Anthropic from '@anthropic-ai/sdk';\nimport { requireUser } from './_lib/auth.js';\n`,
  },
  {
    anchor: `export default async function handler(req, res) {\n  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });\n`,
    replacement: `export default async function handler(req, res) {\n  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });\n  // Auth (2026-07-31): the classifier calls Anthropic -- require a signed-in\n  // session so anonymous callers can't run up an API bill.\n  const _user = await requireUser(req);\n  if (!_user) return res.status(401).json({ ok: false, error: 'Not signed in.' });\n`,
  },
], `require a signed-in\n  // session so anonymous callers`);

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('ABORTED -- nothing written. Anchor problems:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
for (const p of planned) { fs.writeFileSync(path.join(ROOT, p.rel), p.out); console.log('PATCHED: ' + p.rel); }
for (const s of skips) console.log('SKIP (already patched): ' + s);

const selfDest = path.join(ROOT, 'claude', '_patch_cron_and_documents_auth.cjs');
try { if (path.resolve(__filename) !== selfDest) { fs.mkdirSync(path.dirname(selfDest), { recursive: true }); fs.copyFileSync(__filename, selfDest); console.log('Installed script copy at claude/_patch_cron_and_documents_auth.cjs'); } } catch (e) {}
console.log(`\nDone. ${planned.length} patched, ${skips.length} skipped.`);
