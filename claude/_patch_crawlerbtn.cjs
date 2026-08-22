// Idempotent: add a "Run Self-Test (QA)" button in the Settings group that
// launches the shielded deep crawler — so Chris doesn't need the dev console.
const fs = require('fs');
const P = 'public/index.html';
let s = fs.readFileSync(P, 'utf8');

if (s.indexOf('id="nav-selftest"') !== -1) { console.log('already_present'); process.exit(0); }

const anchor = '<div class="nav" id="nav-signout"';
if (s.indexOf(anchor) === -1) { console.log('ANCHOR_NOT_FOUND'); process.exit(1); }

const block =
  '<div class="nav" id="nav-selftest" onclick="hlRunCrawler()" style="padding-left:26px;font-size:12px" title="Temporary QA tool: safely clicks every button across the app. Nothing is sent, charged, or saved to real data.">' +
  '<span class="ic" style="font-size:12px;display:flex;align-items:center;justify-content:center">&#128030;</span>Run Self-Test (QA)</div>' +
  '<script>window.hlRunCrawler=function(){try{if(window.__hlCrawlerBusy){return;}window.__hlCrawlerBusy=1;setTimeout(function(){window.__hlCrawlerBusy=0;},4000);}catch(e){}' +
  'try{if(window.chirpToast)chirpToast("&#128030; Self-Test starting \\u2014 watch the top-right badge. Safe: nothing is sent or saved.");}catch(e){}' +
  'var s=document.createElement("script");s.src="/tools/selftest.js?"+Date.now();document.body.appendChild(s);};</script>\r\n        ';

s = s.replace(anchor, block + anchor);
fs.writeFileSync(P, s);

// validate the injected inline script parses
const m = s.match(/window\.hlRunCrawler=function\(\)\{[\s\S]*?\};/);
try { new Function(m[0].replace('window.hlRunCrawler=', '')); console.log('inline_js=OK'); }
catch (e) { console.log('INLINE_JS_ERROR: ' + e.message); }
console.log('has_nav_selftest=' + (s.indexOf('id="nav-selftest"') !== -1));
console.log('has_hlRunCrawler=' + (s.indexOf('window.hlRunCrawler=function') !== -1));
console.log('script_pairs=' + (s.match(/<script\b/g) || []).length + '/' + (s.match(/<\/script>/g) || []).length);
