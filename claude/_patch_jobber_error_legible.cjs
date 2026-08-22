// Make Jobber token-refresh failures legible (Chris 2026-07-28).
// Root cause of the 3.5-day sync outage: the Jobber refresh token was
// revoked/expired, so Jobber's token endpoint returns a PLAINTEXT error
// ("The provided authorization grant is invalid...") and the code did
// `await res.json()` on it -> "Unexpected token 'T'... is not valid JSON",
// which hid the real cause in sync_log + the health check.
//
// Fix touches ONLY the error path in refreshAccessToken(): read the body as
// text, try to parse JSON, and on failure throw a clear, actionable message.
// Success path is unchanged. 3 single-line, CRLF-safe replacements.
const fs = require('fs');
const p = 'api/_lib/jobber.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('reconnect at /api/jobber/connect')) { console.log('ALREADY PATCHED'); process.exit(0); }

function one(name, find, to) {
  const c = s.split(find).length - 1;
  if (c !== 1) { console.error('anchor ' + name + ' count ' + c); process.exit(1); }
  s = s.replace(find, to);
}

one('A',
  'const tokens = await res.json();',
  'const raw = await res.text(); let tokens = null; try { tokens = JSON.parse(raw); } catch (e) { tokens = null; }');

one('B',
  'if (!res.ok || !tokens.access_token) {',
  'if (!res.ok || !tokens || !tokens.access_token) {');

one('C',
  'throw new Error(`Jobber token refresh failed: ${JSON.stringify(tokens)}`);',
  "throw new Error(/invalid|expired|revoked|grant/i.test(raw) ? 'Jobber authorization expired or was revoked \\u2014 reconnect at /api/jobber/connect' : ('Jobber token refresh failed (HTTP ' + res.status + '): ' + String(raw).slice(0, 200)));");

fs.writeFileSync(p, s);
console.log('PATCHED api/_lib/jobber.js — refresh errors now legible');
