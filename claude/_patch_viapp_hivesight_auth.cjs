// claude/_patch_viapp_hivesight_auth.cjs
// P0 SECURITY ROUND 2 companion (2026-07-29): HiveSight (public/vi-app/, a
// Vite-built SPA embedded as an <iframe src="/vi-app/"> in index.html) calls
// /api/jobs, /api/clients and /api/visual-intel through its own fetch helper
// `nt()`, which never attaches an auth token. It worked only because those
// endpoints used to be open. Round 1 (locking /api/jobs + /api/clients) broke
// HiveSight's data because the main app's window.fetch auth-shim lives in the
// PARENT window and cannot reach the iframe's own window.fetch. Locking
// /api/visual-intel (round 2) would break its photos too.
//
// Fix: inject the SAME Supabase access token the main app uses. HiveSight is
// same-origin, so it can read the same `sb-<project>-auth-token` localStorage
// key. We (1) define a tiny token->header helper __hlViAuth() at the top of the
// bundle, and (2) spread its result into nt()'s request headers -- placed
// BEFORE the caller's own headers so an explicit Authorization still wins.
//
// IMPORTANT / KNOWN DEBT: this edits a Vite BUILD ARTIFACT (the hashed
// index-*.js). HiveSight's real source (main.tsx etc.) is NOT in this repo, so
// this is the only in-repo lever. A future HiveSight rebuild will overwrite
// this file and MUST re-apply the same change at source (add the Authorization
// header in the app's api client). Flagged in status.md.
//
// Idempotent (marker __hlViAuth), verifies its anchor before writing, aborts
// clean if the bundle was rebuilt/renamed. Usage:
//   node claude/_patch_viapp_hivesight_auth.cjs [<target-repo-root>]

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const REL = 'public/vi-app/assets/index-DwAcQw3z.js';
const FILE = path.join(ROOT, REL);
const MARKER = '__hlViAuth';

if (!fs.existsSync(FILE)) {
  console.error(`ABORTED: ${REL} not found (HiveSight bundle may have been rebuilt/renamed -- re-point this script or fix at source).`);
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
if (src.includes(MARKER)) { console.log('SKIP (already patched): ' + REL); process.exit(0); }

// (1) token -> {Authorization} helper, prepended. Mirrors index.html's
// hlTokenSync(): prefer this project's auth-token key, fall back to any
// Supabase auth-token; supports both the flat and {currentSession} shapes.
const HELPER =
  'var __hlViAuth=function(){try{' +
  'var K=Object.keys(localStorage),' +
  "P=K.filter(function(k){return k.indexOf('sqhusuuhlmcmkeowdrga')>=0&&k.indexOf('auth-token')>=0;})," +
  "A=P.length?P:K.filter(function(k){return k.indexOf('auth-token')>=0;});" +
  'for(var i=0;i<A.length;i++){var v=JSON.parse(localStorage.getItem(A[i]));' +
  "if(v&&v.access_token)return{Authorization:'Bearer '+v.access_token};" +
  "if(v&&v.currentSession&&v.currentSession.access_token)return{Authorization:'Bearer '+v.currentSession.access_token};}" +
  '}catch(e){}return{};};\n';

// (2) header injection anchor (verified unique).
const ANCHOR = 'n=await fetch(`${M2}${t}`,{...e,headers:{Accept:"application/json",';
const REPLACEMENT = 'n=await fetch(`${M2}${t}`,{...e,headers:{Accept:"application/json",...(typeof __hlViAuth==="function"?__hlViAuth():{}),';

const count = src.split(ANCHOR).length - 1;
if (count !== 1) {
  console.error(`ABORTED: header anchor found ${count}x (need exactly 1) -- HiveSight bundle changed. Fix at source instead.`);
  process.exit(1);
}

src = HELPER + src.replace(ANCHOR, REPLACEMENT);
fs.writeFileSync(FILE, src);
console.log('PATCHED: ' + REL + ' (HiveSight now sends the signed-in token)');

// Self-install canonical copy.
const selfDest = path.join(ROOT, 'claude', '_patch_viapp_hivesight_auth.cjs');
if (path.resolve(__filename) !== selfDest) {
  fs.mkdirSync(path.dirname(selfDest), { recursive: true });
  fs.copyFileSync(__filename, selfDest);
  console.log('Installed script copy at claude/_patch_viapp_hivesight_auth.cjs');
}
console.log('Done.');
