// Idempotent patch: make api/track1.js robust to req.body not being parsed by
// the platform (fixes Save Lead + every write endpoint) and add a small debug
// field on the leads 400 path so we can see what the handler actually received.
const fs = require('fs');
const P = 'api/track1.js';
let s = fs.readFileSync(P, 'utf8');
let changes = 0;

// 1) Insert body-normalizer helpers + call, right after handler opens.
const anchor = 'export default async function handler(req, res) {\r\n  const resource = req.query.resource;';
const anchorLF = 'export default async function handler(req, res) {\n  const resource = req.query.resource;';
const helpers = `async function hlReadBody(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
  if (typeof req.body === 'string' && req.body.length) { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  if (req.method === 'GET' || req.method === 'HEAD') return (req.body && typeof req.body === 'object') ? req.body : {};
  if (req.readableEnded || req.complete) return (req.body && typeof req.body === 'object') ? req.body : {};
  return await new Promise((resolve) => {
    let data = ''; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const to = setTimeout(() => finish({}), 2000);
    req.on('data', (c) => { data += c; });
    req.on('end', () => { clearTimeout(to); try { finish(data ? JSON.parse(data) : {}); } catch (e) { finish({}); } });
    req.on('error', () => { clearTimeout(to); finish({}); });
  });
}
async function hlEnsureBody(req) { try { const b = await hlReadBody(req); if (b && typeof b === 'object') req.body = b; } catch (e) {} }
`;
if (s.indexOf('async function hlEnsureBody') === -1) {
  if (s.indexOf(anchor) !== -1) {
    s = s.replace(anchor, helpers + anchor + '\r\n  await hlEnsureBody(req);');
    changes++;
  } else if (s.indexOf(anchorLF) !== -1) {
    s = s.replace(anchorLF, helpers + anchorLF + '\n  await hlEnsureBody(req);');
    changes++;
  } else {
    console.log('ANCHOR_NOT_FOUND');
  }
} else {
  console.log('helpers already present');
}

// 2) Add debug to the leads 400 path (idempotent).
const oldErr = "if (!first && !last && !company) return res.status(400).json({ ok: false, error: 'Need a first/last name or a company name.' });";
const newErr = "if (!first && !last && !company) return res.status(400).json({ ok: false, error: 'Need a first/last name or a company name.', _got: { t: typeof req.body, keys: (req.body && typeof req.body === 'object') ? Object.keys(req.body) : null } });";
if (s.indexOf(oldErr) !== -1) { s = s.replace(oldErr, newErr); changes++; }
else if (s.indexOf('_got: { t: typeof req.body') !== -1) { console.log('400 debug already present'); }
else { console.log('LEADS_400_LINE_NOT_FOUND'); }

fs.writeFileSync(P, s);
console.log('changes=' + changes);
console.log('has_helpers=' + (s.indexOf('async function hlEnsureBody') !== -1));
console.log('has_call=' + (s.indexOf('await hlEnsureBody(req);') !== -1));
console.log('has_debug=' + (s.indexOf('_got: { t: typeof req.body') !== -1));
