// claude/_patch_auth_round2.cjs
// P0 SECURITY ROUND 2 (2026-07-29): after locking /api/clients and /api/jobs,
// a full route audit found 7 more endpoints returning real business data to
// ANY anonymous request. Confirmed live (signed-out):
//   /api/qbo?resource=financials -> full QuickBooks P&L (cash, AR/AP, net income)
//   /api/snapshot                -> 8,662 clients, $1.45M AR outstanding
//   /api/reports/summary         -> revenue MTD
//   /api/invoices                -> every invoice, amounts + balances
//   /api/chat  (POST)            -> Reina answers using all of the above
//   /api/visual-intel            -> job photos/intel (read AND delete)
//   /api/takeoffs                -> takeoff/plan data
//
// Fix: one shared helper, api/_lib/auth.js (requireUser), gates each handler.
// Signed-out -> 401; signed-in -> unchanged behavior. For /api/qbo ONLY the
// data resources (financials, status) are gated -- the Intuit OAuth callback
// (?code&realmId) and the connect redirect MUST stay public or the QuickBooks
// connection breaks. api/chat.js keeps its existing POST-only + body checks.
//
// This creates api/_lib/auth.js and edits 7 files. It is idempotent (safe to
// re-run) and verifies EVERY anchor across ALL files before writing anything
// -- if any anchor drifted it aborts with nothing half-written. CRLF-safe.
// Usage:  node claude/_patch_auth_round2.cjs [<target-repo-root>]

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const skips = [];
const failures = [];
const planned = []; // { rel, out, crlf }

// Patch an existing file (LF-normalize for matching, restore endings on write).
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
  planned.push({ rel, out: crlf ? src.replace(/\n/g, '\r\n') : src, crlf });
}

// Create a brand-new file (only if absent; re-run leaves an existing one alone).
function createFile(rel, contents) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) { skips.push(rel + ' (exists)'); return; }
  planned.push({ rel, out: contents, crlf: false });
}

// ---------------------------------------------------------------------------
// Shared helper. Single source of truth for "is this a real signed-in user".
// Mirrors the minimal token verification already inlined in clients.js/jobs.js
// (which stay as-is -- shipped and working); new gates import this instead of
// re-inlining. Same Supabase /auth/v1/user check track1.js uses.
// ---------------------------------------------------------------------------
const AUTH_LIB = `// api/_lib/auth.js
// Shared request-auth helper (2026-07-29, P0 security round 2).
// requireUser(req) returns the Supabase auth user for a valid Bearer session,
// or null when the caller is signed out / the token is bad. Endpoints that
// return real business data call this and 401 on null. Verification is done
// against Supabase's own /auth/v1/user endpoint -- the same method
// api/track1.js's getRequestingProfile and the bookkeeping _actor.js helpers
// already use. No profile/role lookup here: these endpoints only need to know
// the request comes from a real signed-in user, not which one.

export async function requireUser(req) {
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
createFile('api/_lib/auth.js', AUTH_LIB);

const IMPORT_AUTH = `import { requireUser } from './_lib/auth.js';\n`;
const IMPORT_AUTH_NESTED = `import { requireUser } from '../_lib/auth.js';\n`; // for api/qbo, api/reports
const GATE = `  const _authedUser = await requireUser(req);
  if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });
`;

// ---------------------------------------------------------------------------
// api/invoices.js  (import after the jobber import; gate at top of handler)
// ---------------------------------------------------------------------------
patchFile('api/invoices.js', [
  { anchor: `import { supabaseRequest } from './_lib/jobber.js';\n`,
    replacement: `import { supabaseRequest } from './_lib/jobber.js';\n${IMPORT_AUTH}` },
  { anchor: `export default async function handler(req, res) {\n  try {`,
    replacement: `export default async function handler(req, res) {\n${GATE}  try {` },
], "from './_lib/auth.js'");

// ---------------------------------------------------------------------------
// api/snapshot.js  (handler uses (_req, res) -> rename to (req, res) + gate)
// ---------------------------------------------------------------------------
patchFile('api/snapshot.js', [
  { anchor: `import { supabaseRequest } from './_lib/jobber.js';\n`,
    replacement: `import { supabaseRequest } from './_lib/jobber.js';\n${IMPORT_AUTH}` },
  { anchor: `export default async function handler(_req, res) {\n  try {`,
    replacement: `export default async function handler(req, res) {\n${GATE}  try {` },
], "from './_lib/auth.js'");

// ---------------------------------------------------------------------------
// api/reports/summary.js  (nested import; gate after the GET-only guard)
// ---------------------------------------------------------------------------
patchFile('api/reports/summary.js', [
  { anchor: `export default async function handler(req, res) {\n  if (req.method !== 'GET') {\n    res.status(405).json({ ok: false, error: 'Only GET is supported.' });\n    return;\n  }\n`,
    replacement: `import { requireUser } from '../_lib/auth.js';\n\nexport default async function handler(req, res) {\n  if (req.method !== 'GET') {\n    res.status(405).json({ ok: false, error: 'Only GET is supported.' });\n    return;\n  }\n${GATE}` },
], "from '../_lib/auth.js'");

// ---------------------------------------------------------------------------
// api/takeoffs.js  (gate every method inside the try)
// ---------------------------------------------------------------------------
patchFile('api/takeoffs.js', [
  { anchor: `import { supabaseRequest } from './_lib/jobber.js';\n`,
    replacement: `import { supabaseRequest } from './_lib/jobber.js';\n${IMPORT_AUTH}` },
  { anchor: `export default async function handler(req, res) {\n  try {`,
    replacement: `export default async function handler(req, res) {\n${GATE}  try {` },
], "from './_lib/auth.js'");

// ---------------------------------------------------------------------------
// api/visual-intel.js  (gate all methods at the top of handler)
// ---------------------------------------------------------------------------
patchFile('api/visual-intel.js', [
  { anchor: `export default async function handler(req, res) {\n  const resource = req.query.resource;\n  try {`,
    replacement: `${IMPORT_AUTH}\nexport default async function handler(req, res) {\n  const resource = req.query.resource;\n${GATE}  try {` },
], "from './_lib/auth.js'");

// ---------------------------------------------------------------------------
// api/chat.js  (gate right after the existing POST-only / api-key guards)
// ---------------------------------------------------------------------------
patchFile('api/chat.js', [
  { anchor: `export default async function handler(req, res) {\n  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });\n  if (!anthropic) return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment.' });\n`,
    replacement: `import { requireUser } from './_lib/auth.js';\n\nexport default async function handler(req, res) {\n  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });\n  if (!anthropic) return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment.' });\n${GATE}` },
], "from './_lib/auth.js'");

// ---------------------------------------------------------------------------
// api/qbo/index.js  (gate ONLY the data resources; OAuth callback stays public)
// Both edits in ONE call so they apply to the same file copy.
// ---------------------------------------------------------------------------
patchFile('api/qbo/index.js', [
  // Import, inserted just before the handler.
  { anchor: `export default async function handler(req, res) {\n  try {\n    const { code, realmId, error, resource,`,
    replacement: `import { requireUser } from '../_lib/auth.js';\n\nexport default async function handler(req, res) {\n  try {\n    const { code, realmId, error, resource,` },
  // Gate, only for the data resources.
  { anchor: `    // Live read: /api/qbo?resource=financials&kind=summary
    if (resource === 'financials') {
      const data = await getFinancials(kind || 'summary', { start_date, end_date, summarize_by, accounting_method });
      return res.status(data && data.error ? 502 : 200).json(data);
    }`,
    replacement: `    // P0 security round 2 (2026-07-29): the data resources return real
    // QuickBooks financials -- require a signed-in session. The OAuth callback
    // (code & realmId, handled above) and the connect redirect (below) stay
    // public because Intuit itself calls them unauthenticated.
    if (resource === 'financials' || resource === 'status') {
      const _authedUser = await requireUser(req);
      if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });
    }

    // Live read: /api/qbo?resource=financials&kind=summary
    if (resource === 'financials') {
      const data = await getFinancials(kind || 'summary', { start_date, end_date, summarize_by, accounting_method });
      return res.status(data && data.error ? 502 : 200).json(data);
    }` },
], "from '../_lib/auth.js'");

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('ABORTED -- nothing written. Anchor problems:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
for (const p of planned) {
  const abs = path.join(ROOT, p.rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, p.out);
  console.log('WROTE: ' + p.rel);
}
for (const s of skips) console.log('SKIP (already done): ' + s);

// Self-install a canonical copy next to the patched code.
const selfDest = path.join(ROOT, 'claude', '_patch_auth_round2.cjs');
if (path.resolve(__filename) !== selfDest) {
  fs.mkdirSync(path.dirname(selfDest), { recursive: true });
  fs.copyFileSync(__filename, selfDest);
  console.log('Installed script copy at claude/_patch_auth_round2.cjs');
}
console.log(`\nDone. ${planned.length} file(s) written, ${skips.length} skipped.`);
