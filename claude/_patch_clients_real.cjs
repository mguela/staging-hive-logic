// _patch_clients_real.cjs
// Wire the Clients screen (view-clients in public/index.html) to REAL Jobber
// data. Replaces the fake persona table + fake stat tiles + invented cards
// (Delgado/Reyes/referrals/reviews) with:
//   - real stat tiles (total / active / leads / owed) from /api/clients
//   - a real searchable/sortable/filterable client table (8,600+ clients)
//   - a real client detail drawer (name, company, email, status, balance,
//     last-updated, Open-in-Jobber) that is HONEST about what isn't synced
//     into this view yet (job history / property notes / LTV).
//
// Leaves the shared CLIENTDB array and openClient() UNTOUCHED -- the Estimate
// builder and the new-client form still depend on them. The Clients screen now
// uses its own REAL_CLIENTS + openRealClient() instead.
//
// Region-replace by ASCII-only markers (unicode-safe for the mixed content in
// this file). Idempotent (marker: id="rc-stat-total"), verifies markers before
// writing, CRLF-safe. Usage: node _patch_clients_real.cjs [<target-repo-root>]

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const REL = 'public/index.html';
const FILE = path.join(ROOT, REL);
const DONE = 'id="rc-stat-total"';

const raw = fs.readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let s = crlf ? raw.replace(/\r\n/g, '\n') : raw;
if (s.includes(DONE)) { console.log('SKIP (already patched): ' + REL); process.exit(0); }

// region-replace: replace [startMarker .. endMarker) with `mid`, keeping endMarker.
const problems = [];
function region(startMarker, endMarker, mid) {
  const a = s.indexOf(startMarker);
  if (a < 0) { problems.push('start marker missing: ' + startMarker.slice(0, 60)); return; }
  if (s.indexOf(startMarker, a + startMarker.length) >= 0) { problems.push('start marker not unique: ' + startMarker.slice(0, 60)); return; }
  const b = s.indexOf(endMarker, a);
  if (b < 0) { problems.push('end marker missing after start: ' + endMarker.slice(0, 60)); return; }
  s = s.slice(0, a) + mid + s.slice(b);
}

// ---------------------------------------------------------------------------
// Region 1 (merged): fake headline + banner disclaimer + fake stat tiles +
// fake "Needs attention" persona card + fake toolbar/columns  ->  real header,
// real stat tiles, and a real search/filter/sort toolbar + real columns.
// One region between two unique markers (avoids the non-unique cdb-bar class).
// ---------------------------------------------------------------------------
const BLOCK = `    <div class="lsent"><h1>Clients</h1>
    <p>Your full client book, live from Jobber. Search, filter, and open any record.</p></div>
    <div id="rlv-clients-live" style="display:flex;align-items:center;gap:10px;background:#eef8f1;border:2px solid var(--green);border-radius:13px;padding:11px 15px;margin-bottom:14px;flex-wrap:wrap">
      <span style="font-family:'JetBrains Mono',monospace;font-size:8.5px;font-weight:800;letter-spacing:.12em;color:var(--green)">\u25CF LIVE FROM JOBBER</span>
      <span id="rlv-clients-summary" style="font-size:11px;font-weight:700;color:#161e2e">Loading real client data\u2026</span>
    </div>
    <div class="statrow">
      <div class="stat"><span>Total clients</span><b id="rc-stat-total">\u2026</b><span class="tr">live from Jobber</span></div>
      <div class="stat"><span>Active</span><b id="rc-stat-active">\u2026</b><span class="tr">not archived</span></div>
      <div class="stat"><span>Leads</span><b id="rc-stat-leads">\u2026</b><span class="tr">not yet clients</span></div>
      <div class="stat"><span>Owed by clients</span><b id="rc-stat-owed">\u2026</b><span class="tr">open balances</span></div>
    </div>
    <div class="card">
      <h3>Client database <span style="font-size:10px;color:var(--mut);font-weight:700">SEARCH \u00B7 FILTER \u00B7 CLICK ANY CLIENT FOR THE FULL RECORD</span></h3>
      <div class="cdb-bar">
        <div class="cdb-search">\uD83D\uDD0D<input id="cdb-q" placeholder="Search name, company, or email\u2026" oninput="cdbRender()"></div>
        <button class="chip2 on" onclick="cdbTag(this,'all')">All</button>
        <button class="chip2" onclick="cdbTag(this,'active')">Active</button>
        <button class="chip2" onclick="cdbTag(this,'leads')">Leads</button>
        <button class="chip2" onclick="cdbTag(this,'archived')">Archived</button>
        <button class="chip2" onclick="cdbTag(this,'owes')">Owes money</button>
        <select class="cdb-sel" id="cdb-sort" onchange="cdbRender()">
          <option value="name">Name A\u2013Z</option>
          <option value="balance">Balance (high\u2192low)</option>
          <option value="updated">Recently updated</option>
        </select>
      </div>
      <table class="cdb-table"><thead><tr>
        <th>CLIENT</th><th>EMAIL</th><th>STATUS</th><th style="text-align:right">BALANCE</th><th>UPDATED</th><th></th>
      </tr></thead>
      `;
region(`    <div class="lsent"><h1>347 clients.`, `<tbody id="cdb-body">`, BLOCK);

// ---------------------------------------------------------------------------
// Region 2: remove the fake right rail (Company memory / Referral engine /
// Reviews). Keep the cdb-foot + card close, drop the rail. Unique markers.
// ---------------------------------------------------------------------------
region(`contacts, memory.</span></div>`, `<div class="note">HIVELOGIC / CLIENTS`, `contacts, memory.</span></div>\n    </div>\n    `);

// ---------------------------------------------------------------------------
// Region 4: replace cdbRender() with a real implementation + openRealClient()
// + helpers + REAL_CLIENTS state. Keep everything from `var CKHIST=` onward
// (that + openClient() still serve the Estimate builder).
// ---------------------------------------------------------------------------
const NEWJS = `var REAL_CLIENTS=[]; var REAL_TOTAL=0; var REAL_LOADED=false; var REAL_ERR='';
function rcMoney(n){ n=Number(n)||0; var neg=n<0; n=Math.abs(Math.round(n)); return (neg?'-$':'$')+n.toLocaleString('en-US'); }
function rcStatusChip(c){ if(c.isArchived) return '<span class="tagp dorm">ARCHIVED</span>'; if(c.isLead) return '<span class="tagp new">LEAD</span>'; return '<span class="tagp rec">ACTIVE</span>'; }
function rcDate(x){ if(!x) return '\\u2014'; var d=new Date(x); if(isNaN(d.getTime())) return '\\u2014'; return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function rcInitials(nm){ var m=String(nm||'').replace(/[^A-Za-z ]/g,'').trim().split(/\\s+/); var a=(m[0]||'')[0]||''; var b=(m.length>1?(m[m.length-1]||'')[0]:'')||''; return (a+b).toUpperCase()||'?'; }
function cdbRender(){
  var qEl=document.getElementById('cdb-q'); if(!qEl) return;
  var body=document.getElementById('cdb-body'); if(!body) return;
  var cc=document.getElementById('cdb-count');
  if(!REAL_LOADED){ body.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--mut);padding:24px">'+(REAL_ERR?('\\u26A0\\uFE0F '+hlEsc(REAL_ERR)):'Loading clients from Jobber\\u2026')+'</td></tr>'; if(cc)cc.textContent=''; return; }
  var q=(qEl.value||'').toLowerCase();
  var srtEl=document.getElementById('cdb-sort'); var srt=srtEl?srtEl.value:'name';
  var list=REAL_CLIENTS.filter(function(c){
    if(cdbFilter==='active'&&c.isArchived)return false;
    if(cdbFilter==='leads'&&!c.isLead)return false;
    if(cdbFilter==='archived'&&!c.isArchived)return false;
    if(cdbFilter==='owes'&&!(Number(c.balance)>0))return false;
    if(q){var hay=((c.name||'')+' '+(c.companyName||'')+' '+(c.email||'')).toLowerCase(); if(hay.indexOf(q)<0)return false;}
    return true;
  });
  if(srt==='name')list.sort(function(a,b){var an=(a.name||'').toLowerCase(),bn=(b.name||'').toLowerCase();return an<bn?-1:(an>bn?1:0);});
  else if(srt==='balance')list.sort(function(a,b){return (Number(b.balance)||0)-(Number(a.balance)||0);});
  else if(srt==='updated')list.sort(function(a,b){return (new Date(b.updatedAt||0).getTime())-(new Date(a.updatedAt||0).getTime());});
  var CAP=400; var shown=list.slice(0,CAP); var h='';
  shown.forEach(function(c){
    var nm=c.name||'(unnamed)';
    var col=AVPAL[Math.abs(ckSeed(nm))%AVPAL.length];
    var bal=Number(c.balance)||0;
    var idAttr=String(c.id).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");
    h+='<tr class="cr" onclick="openRealClient(\\''+idAttr+'\\')">'
      +'<td><div class="cdb-name"><span class="rav" style="background:'+col+'">'+rcInitials(nm)+'</span><div>'+hlEsc(nm)+((c.companyName&&c.companyName!==nm)?'<div class="cdb-sub">'+hlEsc(c.companyName)+'</div>':'')+'</div></div></td>'
      +'<td>'+(c.email?hlEsc(c.email):'<span style="color:var(--mut)">\\u2014</span>')+'</td>'
      +'<td>'+rcStatusChip(c)+'</td>'
      +'<td class="cdb-num" style="text-align:right'+(bal>0?';color:#a34237':'')+'">'+rcMoney(bal)+'</td>'
      +'<td style="white-space:nowrap">'+rcDate(c.updatedAt)+'</td>'
      +'<td><span style="color:var(--slate);font-weight:800">\\u203A</span></td></tr>';
  });
  body.innerHTML=h||'<tr><td colspan="6" style="text-align:center;color:var(--mut);padding:24px">No clients match \\u2014 clear a filter or the search.</td></tr>';
  if(cc){ var extra=list.length>CAP?(' \\u00B7 showing first '+CAP+' \\u2014 refine your search to narrow'):''; cc.innerHTML='Showing <b>'+Math.min(list.length,CAP).toLocaleString()+'</b> of <b>'+list.length.toLocaleString()+'</b> matching \\u00B7 <b>'+REAL_TOTAL.toLocaleString()+'</b> total'+extra; }
}
function openRealClient(id){
  var c=null; for(var i=0;i<REAL_CLIENTS.length;i++){ if(String(REAL_CLIENTS[i].id)===String(id)){c=REAL_CLIENTS[i];break;} }
  if(!c)return;
  var nm=c.name||'(unnamed)';
  document.getElementById('ck-town').innerText=c.companyName||'';
  document.getElementById('ck-tags').innerHTML=rcStatusChip(c);
  document.getElementById('ck-name').innerHTML=hlEsc(nm);
  var acts='';
  if(c.email)acts+='<button class="gbtn" onclick="window.location.href=\\'mailto:'+hlEsc(c.email)+'\\'">\\u2709 Email</button>';
  if(c.jobberUrl)acts+='<button class="gbtn go" onclick="window.open(\\''+hlEsc(c.jobberUrl)+'\\',\\'_blank\\')">\\u2197 Open in Jobber</button>';
  document.getElementById('ck-act').innerHTML=acts||'<span style="font-size:11px;color:var(--mut)">No contact info on file.</span>';
  document.getElementById('ck-qb').innerHTML='\\u26A1 <b>Reina:</b> Real record synced from Jobber. Job history and property notes aren\\'t wired into this view yet \\u2014 use \\u201COpen in Jobber\\u201D for the full record.';
  document.getElementById('ck-contact').innerHTML=
    '<div class="ck-kv"><span>Email</span><b>'+(c.email?hlEsc(c.email):'\\u2014')+'</b></div>'
    +'<div class="ck-kv"><span>Company</span><b>'+(c.companyName?hlEsc(c.companyName):'\\u2014')+'</b></div>'
    +'<div class="ck-kv"><span>Status</span><b>'+(c.isArchived?'Archived':(c.isLead?'Lead':'Active'))+'</b></div>'
    +'<div class="ck-kv"><span>Last updated</span><b>'+rcDate(c.updatedAt)+'</b></div>';
  document.getElementById('ck-prop').innerHTML='<div style="font-size:11px;color:var(--mut);font-weight:600;line-height:1.6;padding:4px 0">No property intel synced into this view yet.</div>';
  document.getElementById('ck-ppl').innerHTML='<div class="ck-kv"><span>'+hlEsc(nm)+'<div class="cdb-sub">Client</div></span><b></b></div>';
  var bal=Number(c.balance)||0;
  document.getElementById('ck-money').innerHTML=
    '<div class="ck-kv"><span>Open balance</span><b style="color:'+(bal>0?'#a34237':'var(--ink)')+'">'+rcMoney(bal)+'</b></div>'
    +'<div class="ck-kv"><span>Lifetime value</span><b>\\u2014</b></div>'
    +'<div class="ck-kv"><span>Jobs</span><b>\\u2014</b></div>';
  document.getElementById('ck-hist').innerHTML='<div style="font-size:11px;color:var(--mut);padding:6px 0">Job history isn\\'t wired into this view yet.'+(c.jobberUrl?' <a href="'+hlEsc(c.jobberUrl)+'" target="_blank" style="color:var(--slate);font-weight:800">Open in Jobber \\u2197</a>':'')+'</div>';
  document.getElementById('ck-mem').innerHTML='<div style="font-size:11px;color:var(--mut);padding:4px 0">No notes synced into this view yet.</div>';
  document.getElementById('ck-tl').innerHTML='<div class="t"><b>Last updated</b><small>'+rcDate(c.updatedAt)+'</small></div>';
  document.getElementById('ckv').classList.add('open');
}
`;
region(`function cdbRender(){`, `var CKHIST=`, NEWJS);

// ---------------------------------------------------------------------------
// Region 5: replace loadClientsLive() to load the full real book once and
// drive the stat tiles + table. Keep the ESTIMATES comment that follows.
// ---------------------------------------------------------------------------
const NEWLOAD = `function loadClientsLive(){
  // Real client book, live from Jobber via Supabase. Loaded ONCE, then cached;
  // interval/visibility re-calls just re-render (never refetch ~8k rows). The
  // window.fetch auth-shim attaches the signed-in token automatically.
  var el = document.getElementById('rlv-clients-summary');
  if(REAL_LOADED){ try{cdbRender();}catch(e){} return; }
  fetch(API+'/api/clients?order=name&limit=10000').then(function(r){
      if(!r.ok){ return r.text().then(function(t){ throw new Error('HTTP '+r.status+' '+(r.statusText||'')+(t?(' -- '+t.slice(0,160)):'')); }); }
      return r.json().catch(function(){ throw new Error('server sent back something that was not valid data (HTTP '+r.status+')'); });
    }).then(function(d){
    if(!d.ok) throw new Error(d.error||'bad response');
    REAL_CLIENTS = d.clients||[]; REAL_TOTAL = d.totalCount||REAL_CLIENTS.length; REAL_LOADED=true; REAL_ERR='';
    var active=0,leads=0,owed=0;
    REAL_CLIENTS.forEach(function(c){ if(!c.isArchived)active++; if(c.isLead)leads++; var b=Number(c.balance)||0; if(b>0)owed+=b; });
    var setT=function(id,v){var n=document.getElementById(id); if(n)n.textContent=v;};
    setT('rc-stat-total', REAL_TOTAL.toLocaleString());
    setT('rc-stat-active', active.toLocaleString());
    setT('rc-stat-leads', leads.toLocaleString());
    setT('rc-stat-owed', rcMoney(owed));
    if(el) el.textContent = REAL_TOTAL.toLocaleString()+' clients in system \\u2014 live from Jobber';
    try{cdbRender();}catch(e){}
  }).catch(function(e){
    var msg = (e && e.message) ? e.message : 'unknown error';
    if(/Failed to fetch|NetworkError|Load failed/i.test(msg)) msg = 'network error reaching the server \\u2014 check your connection and try again';
    REAL_ERR=msg; REAL_LOADED=false;
    if(el) el.textContent = '\\u26A0\\uFE0F Could not load clients \\u2014 '+msg;
    try{cdbRender();}catch(e2){}
  });
}

`;
region(`function loadClientsLive(){`, `// ---- ESTIMATES`, NEWLOAD);

// ---------------------------------------------------------------------------
if (problems.length) {
  console.error('ABORTED -- nothing written. Marker problems:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
fs.writeFileSync(FILE, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('PATCHED: ' + REL);

const selfDest = path.join(ROOT, 'claude', '_patch_clients_real.cjs');
try {
  if (path.resolve(__filename) !== selfDest) { fs.mkdirSync(path.dirname(selfDest), { recursive: true }); fs.copyFileSync(__filename, selfDest); console.log('Installed script copy at claude/_patch_clients_real.cjs'); }
} catch (e) {}
console.log('Done.');
