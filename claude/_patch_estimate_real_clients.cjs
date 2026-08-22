// _patch_estimate_real_clients.cjs
// Wire the Estimate builder's client picker to REAL Jobber clients.
//
// Before: efRender()'s client <select> was built from the fake CLIENTDB array,
// so estimates (incl. the real efRemoteCreate save) were tied to made-up client
// ids. After: a type-to-search picker backed by REAL_CLIENTS (the same live
// /api/clients data the Clients screen loads). Picking a client UPSERTS a
// normalized entry into CLIENTDB, so every existing CLIENTDB lookup in the
// estimate code (name, save payload, etc.) resolves to the real client without
// touching those ~15 call sites.
//
// Honest degradations (real client feed has no street address / town):
//   - property shows company + "see Jobber" instead of a street address
//   - sales tax defaults to Connecticut 6.35% (still editable in the totals)
//   - real email is shown (was a fabricated first.last@gmail.com)
//
// Leaves the fake CLIENTDB array itself intact (legacy template flows), and
// only changes the LIVE efRender builder. The e2Render legacy renderer is not
// touched. Idempotent (marker efEnsureRealClient), verifies anchors, CRLF-safe.
// Usage: node _patch_estimate_real_clients.cjs [<target-repo-root>]

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const REL = 'public/index.html';
const FILE = path.join(ROOT, REL);
const DONE = 'function efEnsureRealClient(';

const raw = fs.readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let s = crlf ? raw.replace(/\r\n/g, '\n') : raw;
if (s.includes(DONE)) { console.log('SKIP (already patched): ' + REL); process.exit(0); }

const problems = [];
function replaceOnce(anchor, replacement) {
  const n = s.split(anchor).length - 1;
  if (n !== 1) { problems.push('anchor found ' + n + 'x (need 1): ' + anchor.slice(0, 70)); return; }
  s = s.replace(anchor, replacement);
}

// ---------------------------------------------------------------------------
// 1. Replace efClientChange() with: new helpers + a real-aware efClientChange.
// ---------------------------------------------------------------------------
const OLD_ECC =
`function efClientChange(v){EST.client=v;var cl=null;CLIENTDB.forEach(function(c){if(c.id===v)cl=c;});
  var tx=efTaxFor(cl);EST.taxName=tx[0];EST.taxPct=tx[1];EST.taxOn=true;EST.propAddr=null;
  chirpToast('&#11041; Tax set to '+tx[0].replace(/ Sales Tax/,'')+' ('+tx[1]+'%) from the client&#8217;s address &#8212; change it in the totals');
  efRender();}`;

const NEW_ECC =
`// ---- Real-client wiring for the Estimate builder (2026-07-30) ----
// The picker searches REAL_CLIENTS (live /api/clients data, loaded by
// loadClientsLive on boot). Picking one upserts a normalized entry into
// CLIENTDB (fields the estimate code already expects: n=name, a=company,
// t=town[none], plus email/jobberUrl/_real) so every existing CLIENTDB
// lookup resolves to the real client with no other edits.
function efClientNorm(rc){ return { id: rc.id, n: rc.name||'(unnamed)', a: rc.companyName||'', t: '', email: rc.email||'', jobberUrl: rc.jobberUrl||'', isLead: !!rc.isLead, isArchived: !!rc.isArchived, _real: true }; }
function efEnsureRealClient(id){
  if(!id || typeof REAL_CLIENTS==='undefined' || !REAL_CLIENTS) return null;
  var rc=null; for(var i=0;i<REAL_CLIENTS.length;i++){ if(String(REAL_CLIENTS[i].id)===String(id)){ rc=REAL_CLIENTS[i]; break; } }
  if(!rc) return null;
  var norm=efClientNorm(rc);
  for(var j=0;j<CLIENTDB.length;j++){ if(CLIENTDB[j].id===norm.id){ for(var k in norm) CLIENTDB[j][k]=norm[k]; return CLIENTDB[j]; } }
  CLIENTDB.push(norm); return norm;
}
function efClientSearch(q){
  var box=document.getElementById('ef-client-results'); if(!box) return;
  q=(q||'').toLowerCase().trim();
  if(typeof REAL_LOADED==='undefined' || !REAL_LOADED){ box.style.display='block'; box.innerHTML='<div style="padding:10px 12px;font-size:11px;color:var(--mut)">Loading clients from Jobber\\u2026</div>'; if(typeof loadClientsLive==='function')loadClientsLive(); return; }
  if(!q){ box.style.display='none'; box.innerHTML=''; return; }
  var out=[]; for(var i=0;i<REAL_CLIENTS.length && out.length<25;i++){ var c=REAL_CLIENTS[i]; var hay=((c.name||'')+' '+(c.companyName||'')+' '+(c.email||'')).toLowerCase(); if(hay.indexOf(q)>=0) out.push(c); }
  if(!out.length){ box.style.display='block'; box.innerHTML='<div style="padding:10px 12px;font-size:11px;color:var(--mut)">No client matches \\u201C'+hlEsc(q)+'\\u201D.</div>'; return; }
  var h=''; out.forEach(function(c){ var idA=String(c.id).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'"); h+='<div onclick="efClientPick(\\''+idA+'\\')" style="padding:9px 12px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--line)" onmouseover="this.style.background=\\'#f7f9fc\\'" onmouseout="this.style.background=\\'\\'"><b>'+hlEsc(c.name||'(unnamed)')+'</b>'+((c.companyName&&c.companyName!==c.name)?' <span style="color:var(--mut);font-size:10px">'+hlEsc(c.companyName)+'</span>':'')+(c.email?'<div style="color:var(--mut);font-size:10px">'+hlEsc(c.email)+'</div>':'')+'</div>'; });
  box.style.display='block'; box.innerHTML=h;
}
function efClientPick(id){ efEnsureRealClient(id); var box=document.getElementById('ef-client-results'); if(box){ box.style.display='none'; box.innerHTML=''; } efClientChange(id); }
function efRealCustInfo(cl){
  return '<div class="ef-custinfo">'
    +'<div class="ck-kv"><span>Property</span><b>'+(cl.a?hlEsc(cl.a):'See Jobber for address')+'</b></div>'
    +'<div class="ck-kv"><span>Email</span><b>'+(cl.email?hlEsc(cl.email):'\\u2014')+'</b></div>'
    +'<div class="ck-kv"><span>Status</span><b>'+(cl.isArchived?'Archived':(cl.isLead?'Lead':'Active'))+'</b></div>'
    +'<div style="font-size:9px;color:var(--mut);font-weight:600;padding:6px 0;line-height:1.5">Phone, full address, and job history live in Jobber'+(cl.jobberUrl?' \\u2014 <a href="'+hlEsc(cl.jobberUrl)+'" target="_blank" style="color:var(--slate);font-weight:800">open \\u2197</a>':'')+'. Sales tax defaults to Connecticut \\u2014 change it in the totals if needed.</div>'
    +'</div>';
}
function efClientChange(v){
  EST.client=v; efEnsureRealClient(v);
  var cl=null;CLIENTDB.forEach(function(c){if(c.id===v)cl=c;});
  var tx=efTaxFor(cl);EST.taxName=tx[0];EST.taxPct=tx[1];EST.taxOn=true;EST.propAddr=null;
  if(cl) chirpToast('&#11041; Client set to '+hlEsc(cl.n)+' &#183; tax '+tx[0].replace(/ Sales Tax/,'')+' ('+tx[1]+'%) &#8212; change it in the totals');
  efRender();
}`;
replaceOnce(OLD_ECC, NEW_ECC);

// ---------------------------------------------------------------------------
// 2. estFormNew: default to no client + ensure a real pick resolves for tax.
// ---------------------------------------------------------------------------
replaceOnce(`EST={client:cid||'c8',num:`, `EST={client:cid||'',num:`);
replaceOnce(
  `var _cl=null;CLIENTDB.forEach(function(c){if(c.id===EST.client)_cl=c;});var _tx=efTaxFor(_cl);`,
  `efEnsureRealClient(EST.client);var _cl=null;CLIENTDB.forEach(function(c){if(c.id===EST.client)_cl=c;});var _tx=efTaxFor(_cl);`
);

// ---------------------------------------------------------------------------
// 3. Replace the fake <select> client picker with the type-to-search widget.
// ---------------------------------------------------------------------------
const OLD_SELECT = `  +'<select onchange="efClientChange(this.value)">'+cs+'</select>';`;
const NEW_WIDGET = `  +'<div style="position:relative">'
  +'<input id="ef-client-in" autocomplete="off" placeholder="Type a client name, company, or email\\u2026" value="'+(cl?hlEsc(cl.n):'')+'" oninput="efClientSearch(this.value)" onfocus="efClientSearch(this.value)" style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font-size:12px;font-family:inherit;box-sizing:border-box">'
  +'<div id="ef-client-results" style="display:none;position:absolute;z-index:60;left:0;right:0;top:100%;background:#fff;border:1px solid var(--line);border-radius:9px;max-height:260px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>'
  +(EST.client?'':'<div style="font-size:9.5px;color:var(--mut);margin-top:4px">Start typing to pick a real client from Jobber.</div>')
  +'</div>';`;
replaceOnce(OLD_SELECT, NEW_WIDGET);

// ---------------------------------------------------------------------------
// 4. Real clients get an honest custinfo block; legacy fake clients unchanged.
// ---------------------------------------------------------------------------
replaceOnce(
  `  if(cl){var em2=(cl.n.split(',')[1]||'').trim().split(' ')[0].toLowerCase()`,
  `  if(cl&&cl._real){ h+=efRealCustInfo(cl); }
  else if(cl){var em2=(cl.n.split(',')[1]||'').trim().split(' ')[0].toLowerCase()`
);

// ---------------------------------------------------------------------------
if (problems.length) {
  console.error('ABORTED -- nothing written. Anchor problems:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
fs.writeFileSync(FILE, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('PATCHED: ' + REL);

const selfDest = path.join(ROOT, 'claude', '_patch_estimate_real_clients.cjs');
try { if (path.resolve(__filename) !== selfDest) { fs.mkdirSync(path.dirname(selfDest), { recursive: true }); fs.copyFileSync(__filename, selfDest); console.log('Installed script copy at claude/_patch_estimate_real_clients.cjs'); } } catch (e) {}
console.log('Done.');
