// _patch_encrypt_integration_tokens.cjs
// Encrypt the OAuth tokens stored in the `integrations` table (Jobber, QBO,
// Microsoft) at the application layer, using api/_lib/secrets.js. Every WRITER
// wraps access_token/refresh_token with encryptSecret(); every READER unwraps
// with decryptSecret(). Because secrets.js is passthrough when TOKEN_ENC_KEY
// is unset, and decrypt handles plaintext, THIS PATCH IS A NO-OP until the key
// is set in Vercel -- safe to ship first, activate later.
//
// Files: api/_lib/jobber.js, api/jobber/callback.js, api/qbo/index.js,
//        api/track1.js (Microsoft tokens). (secrets.js is added separately.)
//
// Idempotent (per-file markers), verifies EVERY anchor before writing anything,
// CRLF-safe. Usage: node _patch_encrypt_integration_tokens.cjs [<repo-root>]

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


// Create the shared encryption helper if it doesn't exist yet.
function createFileIfAbsent(rel, contents){
  const abs=path.join(ROOT, rel);
  if(fs.existsSync(abs)){ skips.push(rel+' (exists)'); return; }
  const dir=path.dirname(abs); fs.mkdirSync(dir,{recursive:true});
  planned.push({ rel, out: contents });
}
const SECRETS_JS = '// api/_lib/secrets.js\n// Application-level encryption for the OAuth tokens stored in the\n// `integrations` table (Jobber, QuickBooks, Microsoft). The symmetric key\n// lives ONLY in the Vercel env var TOKEN_ENC_KEY -- never in the database --\n// so a leaked service key or a DB backup no longer exposes usable tokens.\n//\n// Wire format: "enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>" (AES-256-GCM).\n//\n// STAGED, REVERSIBLE ROLLOUT:\n//   - encryptSecret(): if TOKEN_ENC_KEY is NOT set, returns the value\n//     UNCHANGED (passthrough). Shipping this code with no key set is a total\n//     no-op -- tokens keep being written in plaintext exactly as before.\n//     Setting the key later activates encryption on the next token write.\n//   - decryptSecret(): plaintext values (no "enc:v1:" prefix) are returned\n//     as-is, so old plaintext rows keep working after the key is set, until\n//     they get re-written (encrypted) on their next refresh.\n//   - Once ANY token has been stored encrypted, TOKEN_ENC_KEY must remain set.\n//     Removing it makes those tokens undecryptable; decryptSecret then throws\n//     a clear error rather than silently handing back ciphertext.\nimport crypto from \'node:crypto\';\n\nconst PREFIX = \'enc:v1:\';\n\n// TOKEN_ENC_KEY may be a base64 (recommended) or hex 256-bit (32-byte) key.\nfunction getKey() {\n  const raw = process.env.TOKEN_ENC_KEY;\n  if (!raw) return null;\n  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, \'hex\') : Buffer.from(raw, \'base64\');\n  if (buf.length !== 32) {\n    throw new Error(\'TOKEN_ENC_KEY must decode to 32 bytes (got \' + buf.length + \'). Use a base64 or hex 256-bit key.\');\n  }\n  return buf;\n}\n\nexport function isEncrypted(v) {\n  return typeof v === \'string\' && v.startsWith(PREFIX);\n}\n\nexport function encryptSecret(plain) {\n  if (plain == null) return plain;\n  const key = getKey();\n  if (!key) return plain;                // no key set yet -> passthrough (no-op)\n  if (isEncrypted(plain)) return plain;  // already encrypted -> don\'t double-wrap\n  const iv = crypto.randomBytes(12);\n  const cipher = crypto.createCipheriv(\'aes-256-gcm\', key, iv);\n  const ct = Buffer.concat([cipher.update(String(plain), \'utf8\'), cipher.final()]);\n  const tag = cipher.getAuthTag();\n  return PREFIX + iv.toString(\'base64\') + \':\' + tag.toString(\'base64\') + \':\' + ct.toString(\'base64\');\n}\n\nexport function decryptSecret(value) {\n  if (!isEncrypted(value)) return value; // null / undefined / plaintext -> as-is\n  const key = getKey();\n  if (!key) {\n    throw new Error(\'TOKEN_ENC_KEY is not set but an encrypted token was found in the integrations table -- cannot decrypt. Restore TOKEN_ENC_KEY.\');\n  }\n  const parts = value.slice(PREFIX.length).split(\':\');\n  if (parts.length !== 3) throw new Error(\'Malformed encrypted token value.\');\n  const iv = Buffer.from(parts[0], \'base64\');\n  const tag = Buffer.from(parts[1], \'base64\');\n  const ct = Buffer.from(parts[2], \'base64\');\n  const decipher = crypto.createDecipheriv(\'aes-256-gcm\', key, iv);\n  decipher.setAuthTag(tag);\n  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(\'utf8\');\n}\n';
createFileIfAbsent('api/_lib/secrets.js', SECRETS_JS);

// ---------------------------------------------------------------------------
// api/_lib/jobber.js  (Jobber tokens: read in getStoredTokens, write in saveTokens)
// ---------------------------------------------------------------------------
patchFile('api/_lib/jobber.js', [
  { anchor: `const JOBBER_API_VERSION = '2025-04-16';`,
    replacement: `import { encryptSecret, decryptSecret } from './secrets.js';\n\nconst JOBBER_API_VERSION = '2025-04-16';` },
  { anchor: `    if (!rows.length) throw new Error('No Jobber connection found. Reconnect Jobber first.');\n    return rows[0];`,
    replacement: `    if (!rows.length) throw new Error('No Jobber connection found. Reconnect Jobber first.');\n    const row = rows[0];\n    if (row) { row.access_token = decryptSecret(row.access_token); row.refresh_token = decryptSecret(row.refresh_token); }\n    return row;` },
  { anchor: `        key: 'jobber',\n        access_token: tokens.access_token,\n        refresh_token: tokens.refresh_token,`,
    replacement: `        key: 'jobber',\n        access_token: encryptSecret(tokens.access_token),\n        refresh_token: encryptSecret(tokens.refresh_token),` },
], `from './secrets.js'`);

// ---------------------------------------------------------------------------
// api/jobber/callback.js  (writes tokens on OAuth callback)
// ---------------------------------------------------------------------------
patchFile('api/jobber/callback.js', [
  { anchor: `export default async function handler(req, res) {\n    const { code, error } = req.query;`,
    replacement: `import { encryptSecret } from '../_lib/secrets.js';\n\nexport default async function handler(req, res) {\n    const { code, error } = req.query;` },
  { anchor: `                              access_token: tokens.access_token,\n                              refresh_token: tokens.refresh_token,`,
    replacement: `                              access_token: encryptSecret(tokens.access_token),\n                              refresh_token: encryptSecret(tokens.refresh_token),` },
], `from '../_lib/secrets.js'`);

// ---------------------------------------------------------------------------
// api/qbo/index.js  (QBO tokens: read in loadTokens, write in saveTokens)
// ---------------------------------------------------------------------------
patchFile('api/qbo/index.js', [
  { anchor: `import { supabaseRequest } from '../_lib/jobber.js';`,
    replacement: `import { supabaseRequest } from '../_lib/jobber.js';\nimport { encryptSecret, decryptSecret } from '../_lib/secrets.js';` },
  { anchor: "  if (!r.ok) throw new Error(`Failed to read stored QuickBooks tokens: ${await r.text()}`);\n  const rows = await r.json();\n  return rows[0] || null;",
    replacement: "  if (!r.ok) throw new Error(`Failed to read stored QuickBooks tokens: ${await r.text()}`);\n  const rows = await r.json();\n  const row = rows[0] || null;\n  if (row) { row.access_token = decryptSecret(row.access_token); row.refresh_token = decryptSecret(row.refresh_token); }\n  return row;" },
  { anchor: `      key: 'qbo',\n      access_token: t.access_token,\n      refresh_token: t.refresh_token,`,
    replacement: `      key: 'qbo',\n      access_token: encryptSecret(t.access_token),\n      refresh_token: encryptSecret(t.refresh_token),` },
], `from '../_lib/secrets.js'`);

// ---------------------------------------------------------------------------
// api/track1.js  (Microsoft tokens: read in getStoredMicrosoftTokens, write in saveMicrosoftTokens)
// ---------------------------------------------------------------------------
patchFile('api/track1.js', [
  { anchor: `import { provisionHiveConnectAccount, getMapping } from './hiveconnect-bridge.js';`,
    replacement: `import { provisionHiveConnectAccount, getMapping } from './hiveconnect-bridge.js';\nimport { encryptSecret as _encSecret, decryptSecret as _decSecret } from './_lib/secrets.js';` },
  { anchor: `  if (!rows.length) throw new Error('Microsoft 365 is not connected yet.');\n  return rows[0];`,
    replacement: `  if (!rows.length) throw new Error('Microsoft 365 is not connected yet.');\n  const row = rows[0];\n  if (row) { row.access_token = _decSecret(row.access_token); row.refresh_token = _decSecret(row.refresh_token); }\n  return row;` },
  { anchor: `      key: 'microsoft',\n      access_token: tokens.access_token,\n      refresh_token: tokens.refresh_token,`,
    replacement: `      key: 'microsoft',\n      access_token: _encSecret(tokens.access_token),\n      refresh_token: _encSecret(tokens.refresh_token),` },
], `from './_lib/secrets.js'`);

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('ABORTED -- nothing written. Anchor problems:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
for (const p of planned) { fs.writeFileSync(path.join(ROOT, p.rel), p.out); console.log('PATCHED: ' + p.rel); }
for (const s of skips) console.log('SKIP (already patched): ' + s);

const selfDest = path.join(ROOT, 'claude', '_patch_encrypt_integration_tokens.cjs');
try { if (path.resolve(__filename) !== selfDest) { fs.mkdirSync(path.dirname(selfDest), { recursive: true }); fs.copyFileSync(__filename, selfDest); console.log('Installed script copy at claude/_patch_encrypt_integration_tokens.cjs'); } } catch (e) {}
console.log(`\nDone. ${planned.length} patched, ${skips.length} skipped.`);
