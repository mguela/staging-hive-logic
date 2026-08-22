// Idempotent removal of the internal "V63 Review" / "Philosophy Review" (phx)
// dev artifact: the sidebar nav entry, the iframe view, and its route/group
// registrations. Nothing else references phx.
const fs = require('fs');
const P = 'public/index.html';
let s = fs.readFileSync(P, 'utf8');
const before = s.length;
const report = {};

// 1) Remove the sidebar nav entry line (whole line).
const navRe = /^[^\n]*id="nav-phx"[^\n]*\r?\n/m;
report.nav_removed = navRe.test(s); s = s.replace(navRe, '');

// 2) Splice out the whole view-phx block (up to the next view).
const start = s.indexOf('<div id="view-phx"');
const end = s.indexOf('<div id="view-pbkx"');
if (start !== -1 && end !== -1 && end > start) { s = s.slice(0, start) + s.slice(end); report.view_removed = true; }
else { report.view_removed = false; report.view_markers = { start, end }; }

// 3) Remove phx from the route arrays (appears as ,'phx').
const arrCount = (s.match(/,'phx'/g) || []).length;
s = s.split(",'phx'").join('');
report.route_array_refs_removed = arrCount;

// 4) Remove phx from the HLGRP group map ("phx": "ops").
const grpRe = /,\s*"phx":\s*"ops"/;
report.hlgrp_removed = grpRe.test(s); s = s.replace(grpRe, '');

fs.writeFileSync(P, s);
report.bytes_removed = before - s.length;
report.residual_phx_mentions = (s.match(/phx/g) || []).length;
report.view_pbkx_present = s.indexOf('<div id="view-pbkx"') !== -1;
report.script_open = (s.match(/<script\b/g) || []).length;
report.script_close = (s.match(/<\/script>/g) || []).length;
console.log(JSON.stringify(report, null, 2));
