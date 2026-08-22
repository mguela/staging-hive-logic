// One-shot patch: public/index.html -- Chris: "it needs to work exactly
// like this google doc" (the real GH Project Updates sheet). Investigated
// the sheet directly: 14 columns (Date, Project, Contractor, Works
// Required from Contractor, Communication Update, Communication Updated as
// of, Project Deadline, Issues Encountered, Project Status, Section,
// Subsection, Activity, % Complete, Blocker) with real narrative/free-text
// content in several of them. The backend (handleManagerGhUpdates /
// fetchGoogleSheetAsRows in api/track1.js) already reads the live sheet
// dynamically -- headers and row order match the real sheet exactly,
// nothing hardcoded or stale.
//
// The actual gap is in this file's renderTable(): every cell was rendered
// with white-space:nowrap + text-overflow:ellipsis + max-width:280px, which
// silently truncates any long cell (e.g. "Works Required from Contractor",
// "Communication Update", "Issues Encountered", "Blocker") to a single
// clipped line -- so real content present in the sheet was being hidden in
// the app. This shared renderTable() is used by both the GH Project
// Updates and Materials P&L manager tables. Fix: wrap cell text instead of
// truncating it, so every value fully matches what's in the actual sheet.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes("td.style.cssText='padding:7px 10px;border-bottom:1px solid var(--line);white-space:pre-wrap;word-break:break-word;max-width:340px;vertical-align:top'")) {
  console.log('Already applied -- manager table cells already wrap full text. Nothing to do.');
  process.exit(0);
}

const isCRLF = src.includes('\r\n');
const nl = (s) => (isCRLF ? s.replace(/\n/g, '\r\n') : s);

const oldS = nl(
  "  function renderTable(container, headers, rows, capNote){\n" +
  "    container.innerHTML='';\n" +
  "    if(!rows.length){ container.textContent='No rows found in the sheet.'; return; }\n" +
  "    var wrap=document.createElement('div'); wrap.style.cssText='overflow-x:auto;max-height:560px;overflow-y:auto';\n" +
  "    var table=document.createElement('table'); table.style.cssText='width:100%;border-collapse:collapse;font-size:11.5px';\n" +
  "    var thead=document.createElement('thead'); var trh=document.createElement('tr');\n" +
  "    headers.forEach(function(h){ var th=document.createElement('th'); th.textContent=h; th.style.cssText='text-align:left;padding:8px 10px;border-bottom:2px solid var(--line);font-size:10px;font-weight:800;color:var(--mut);text-transform:uppercase;white-space:nowrap;position:sticky;top:0;background:#fff'; trh.appendChild(th); });\n" +
  "    thead.appendChild(trh); table.appendChild(thead);\n" +
  "    var tbody=document.createElement('tbody');\n" +
  "    rows.forEach(function(r,i){\n" +
  "      var tr=document.createElement('tr'); tr.style.cssText = i%2? 'background:#fafbfc':'';\n" +
  "      headers.forEach(function(h){ var td=document.createElement('td'); td.textContent=r[h]||''; td.style.cssText='padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis'; tr.appendChild(td); });\n" +
  "      tbody.appendChild(tr);\n" +
  "    });\n" +
  "    table.appendChild(tbody); wrap.appendChild(table); container.appendChild(wrap);\n" +
  "    if(capNote){ var note=document.createElement('div'); note.style.cssText='font-size:10px;color:var(--mut);font-weight:700;margin-top:8px'; note.textContent=capNote; container.appendChild(note); }\n" +
  "  }"
);

const newS = nl(
  "  function renderTable(container, headers, rows, capNote){\n" +
  "    container.innerHTML='';\n" +
  "    if(!rows.length){ container.textContent='No rows found in the sheet.'; return; }\n" +
  "    var wrap=document.createElement('div'); wrap.style.cssText='overflow-x:auto;max-height:640px;overflow-y:auto';\n" +
  "    var table=document.createElement('table'); table.style.cssText='width:100%;border-collapse:collapse;font-size:11.5px;table-layout:auto';\n" +
  "    var thead=document.createElement('thead'); var trh=document.createElement('tr');\n" +
  "    headers.forEach(function(h){ var th=document.createElement('th'); th.textContent=h; th.style.cssText='text-align:left;padding:8px 10px;border-bottom:2px solid var(--line);font-size:10px;font-weight:800;color:var(--mut);text-transform:uppercase;white-space:nowrap;position:sticky;top:0;background:#fff'; trh.appendChild(th); });\n" +
  "    thead.appendChild(trh); table.appendChild(thead);\n" +
  "    var tbody=document.createElement('tbody');\n" +
  "    rows.forEach(function(r,i){\n" +
  "      var tr=document.createElement('tr'); tr.style.cssText = i%2? 'background:#fafbfc':'';\n" +
  "      headers.forEach(function(h){ var td=document.createElement('td'); td.textContent=r[h]||''; td.style.cssText='padding:7px 10px;border-bottom:1px solid var(--line);white-space:pre-wrap;word-break:break-word;max-width:340px;vertical-align:top'; tr.appendChild(td); });\n" +
  "      tbody.appendChild(tr);\n" +
  "    });\n" +
  "    table.appendChild(tbody); wrap.appendChild(table); container.appendChild(wrap);\n" +
  "    if(capNote){ var note=document.createElement('div'); note.style.cssText='font-size:10px;color:var(--mut);font-weight:700;margin-top:8px'; note.textContent=capNote; container.appendChild(note); }\n" +
  "  }"
);

if (!src.includes(oldS)) {
  console.error('ERROR: anchor not found for renderTable(). Nothing written. Send this output back.');
  process.exit(1);
}
src = src.replace(oldS, newS);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
if (check.includes("white-space:pre-wrap;word-break:break-word;max-width:340px;vertical-align:top")) {
  console.log('SUCCESS: manager tables (GH Project Updates + Materials P&L) now show full cell text, no truncation. New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification failed. Do not commit -- send this output back.');
  process.exit(1);
}
