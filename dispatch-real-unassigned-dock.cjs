// One-shot patch: public/index.html -- Dispatch tab polish item #4:
// "sortable/draggable unassigned-visits dock."
//
// Investigation before writing anything: DUN (the "Unassigned work" drawer)
// was a hardcoded 5-row demo array (fake names like "Delgado"/"Barrett"),
// never reassigned anywhere -- while DJOBS/DTECHS/DOFF/DSUBS next to it are
// all real, live-loaded from Jobber via loadDaySchedule(). Worse: that same
// function was silently DROPPING real visits with no assigned tech (the
// `techs=[{name:null}]` fallback resolves to no matching column, so the
// entry just vanished -- never shown anywhere on the board or in the fake
// drawer). So the actual dispatcher-facing bug here was data loss, not just
// a missing interaction.
//
// This patch:
//  1. loadDaySchedule(): real unassigned visits (no tech match) now populate
//     DUN (replacing the hardcoded seed array) instead of disappearing.
//  2. Unassigned drawer: rows now carry a real index + drag handle; dragging
//     a row onto another row reorders the list (client-side priority only,
//     no backend concept of "unassigned order" exists to persist to).
//  3. Dragging a row onto a tech's column actually assigns it for real --
//     reuses the exact same guarded /api/schedule/move-visit endpoint,
//     writeBackGroup()/postMoveVisit() machinery, and freeze-window
//     guardrail the existing job-drag system already uses. Does NOT touch
//     buildImpact()/showImpactPanel()/confirmMove() (those assume an
//     already-scheduled job being moved FROM one tech; assigning something
//     that has no tech yet doesn't fit that ripple-analysis shape) -- uses
//     a lighter native-confirm() flow instead, consistent with this
//     codebase's existing lightweight-confirm pattern (e.g. the
//     freeze-window override confirm).
//
// Known, deliberate limitation (documented rather than hidden): undoing a
// fresh assignment via the standard 5-minute undo link will fail safely
// (the backend requires a start/end time on undo, which a never-scheduled
// visit doesn't have) -- it errors out cleanly rather than corrupting
// anything, but doesn't actually revert. Flagging for a future pass rather
// than over-building this into a bigger change tonight.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('assignUnassignedDrop')) {
  console.log('Already applied -- real unassigned-visits dock already in place. Nothing to do.');
  process.exit(0);
}

const isCRLF = src.includes('\r\n');
const nl = (s) => (isCRLF ? s.replace(/\n/g, '\r\n') : s);
let changes = 0;
function applyOnce(oldRaw, newRaw, label) {
  const oldS = nl(oldRaw);
  const newS = nl(newRaw);
  if (!src.includes(oldS)) {
    console.error('ERROR: anchor not found for "' + label + '". Nothing written. Send this output back.');
    process.exit(1);
  }
  src = src.replace(oldS, newS);
  changes++;
}

// --- 1. loadDaySchedule(): capture real unassigned visits into DUN ---
applyOnce(
  "async function loadDaySchedule(){\n" +
  "  try {\n" +
  "    var r = await fetch('/api/track1?resource=schedule_range&start='+CAL.date+'&end='+CAL.date);\n" +
  "    var data = await r.json();\n" +
  "    if(!data || !data.ok) return;\n" +
  "    var visits = data.visits || [];\n" +
  "    var newDjobs = [];\n" +
  "    var allTechs = ALLCOLS();\n" +
  "    visits.forEach(function(v){\n" +
  "      var techs = (v.assignedTechs && v.assignedTechs.length) ? v.assignedTechs : [{name:null}];\n" +
  "      var done = isVisitDone(v.status);\n" +
  "      techs.forEach(function(tech){\n" +
  "        var tid = matchTechId(tech.name);\n" +
  "        var sHr = etHourOfDay(v.startAt), eHr = etHourOfDay(v.endAt);\n" +
  "        if (sHr != null && eHr != null && eHr > sHr){\n" +
  "          var tk = allTechs.find(function(x){return x.id===tid;});\n" +
  "          newDjobs.push({ t: tid, s: sHr, e: eHr, div: tk ? tk.div : 'GH Co.', cust: v.clientName || '', city: '', type: v.title || 'Visit', st: { g: done ? 'complete' : 'scheduled', s: done ? 'Completed' : 'Scheduled' }, h: 'g', num: v.jobNumber || null, jid: v.jobberId || null, vid: v.visitId || null, origStartAt: v.startAt || null, origEndAt: v.endAt || null });\n" +
  "        }\n" +
  "      });\n" +
  "    });",
  "async function loadDaySchedule(){\n" +
  "  try {\n" +
  "    var r = await fetch('/api/track1?resource=schedule_range&start='+CAL.date+'&end='+CAL.date);\n" +
  "    var data = await r.json();\n" +
  "    if(!data || !data.ok) return;\n" +
  "    var visits = data.visits || [];\n" +
  "    var newDjobs = [];\n" +
  "    var newDun = [];\n" +
  "    var allTechs = ALLCOLS();\n" +
  "    visits.forEach(function(v){\n" +
  "      var techs = (v.assignedTechs && v.assignedTechs.length) ? v.assignedTechs : [{name:null}];\n" +
  "      var done = isVisitDone(v.status);\n" +
  "      var anyRealAssignment = false;\n" +
  "      techs.forEach(function(tech){\n" +
  "        var tid = matchTechId(tech.name);\n" +
  "        var tk = allTechs.find(function(x){return x.id===tid;});\n" +
  "        var sHr = etHourOfDay(v.startAt), eHr = etHourOfDay(v.endAt);\n" +
  "        if (tk){\n" +
  "          anyRealAssignment = true;\n" +
  "          if (sHr != null && eHr != null && eHr > sHr){\n" +
  "            newDjobs.push({ t: tid, s: sHr, e: eHr, div: tk.div, cust: v.clientName || '', city: '', type: v.title || 'Visit', st: { g: done ? 'complete' : 'scheduled', s: done ? 'Completed' : 'Scheduled' }, h: 'g', num: v.jobNumber || null, jid: v.jobberId || null, vid: v.visitId || null, origStartAt: v.startAt || null, origEndAt: v.endAt || null });\n" +
  "          }\n" +
  "        }\n" +
  "      });\n" +
  "      // Real unassigned work: a visit today with no tech that matched a\n" +
  "      // real column. Previously silently dropped here instead of being\n" +
  "      // shown anywhere -- now surfaced in the Unassigned drawer.\n" +
  "      if (!anyRealAssignment && !done){\n" +
  "        var sHr2 = etHourOfDay(v.startAt), eHr2 = etHourOfDay(v.endAt);\n" +
  "        var hasTime = (sHr2 != null && eHr2 != null && eHr2 > sHr2);\n" +
  "        newDun.push({ title: v.title || 'Visit', cust: v.clientName || '(no client)', city: '', div: 'GH Co.', why: hasTime ? 'No tech assigned yet' : 'No tech or time set yet', vid: v.visitId || null, jid: v.jobberId || null, s: hasTime ? sHr2 : null, e: hasTime ? eHr2 : null });\n" +
  "      }\n" +
  "    });",
  'loadDaySchedule() real DUN capture'
);

const oldDjobsAssign = nl(
  "    DJOBS = newDjobs;\n" +
  "    renderCal();\n" +
  "    loadRealJobActivity();\n" +
  "  } catch (e) { console.error('loadDaySchedule failed', e); }\n" +
  "}"
);
if (!src.includes(oldDjobsAssign)) {
  console.error('ERROR: anchor not found for DJOBS assignment tail in loadDaySchedule(). Nothing written. Send this output back.');
  process.exit(1);
}
src = src.replace(oldDjobsAssign, nl(
  "    DJOBS = newDjobs;\n" +
  "    DUN = newDun;\n" +
  "    renderCal();\n" +
  "    loadRealJobActivity();\n" +
  "  } catch (e) { console.error('loadDaySchedule failed', e); }\n" +
  "}"
));
changes++;

// --- 2. Global drag-state var: add dragUN alongside dragDI ---
applyOnce(
  "var PENDING=null, dragDI=null;",
  "var PENDING=null, dragDI=null, dragUN=null;",
  'dragUN global declaration'
);

// --- 3. Drawer render: real index + drag handle, honest empty state ---
applyOnce(
  "    h+='<div class=\"undraw\"><h4>&#128230; Unassigned work &#183; drag onto a tech</h4>';\n" +
  "    DUN.forEach(function(u){ h+='<div class=\"unrow\" draggable=\"true\" ondragstart=\"event.dataTransfer.setData(\\'text/plain\\',\\''+u.title+'\\')\"><span class=\"ud\" style=\"background:'+DIVCOL[u.div]+'\"></span><div>'+u.title+'<small> &#183; '+u.cust+' &#183; '+u.city+'</small></div><span class=\"uwhy\">'+u.why+'</span></div>'; });\n" +
  "    h+='</div>';",
  "    h+='<div class=\"undraw\"><h4>&#128230; Unassigned work &#183; drag to reorder or onto a tech to assign</h4>';\n" +
  "    if(!DUN.length) h+='<div style=\"font-size:11px;color:var(--mut);font-weight:700;padding:4px 2px\">Nothing unassigned right now.</div>';\n" +
  "    DUN.forEach(function(u,ui){ h+='<div class=\"unrow\" draggable=\"true\" data-un=\"'+ui+'\"><span class=\"unhandle\">&#8942;&#8942;</span><span class=\"ud\" style=\"background:'+(DIVCOL[u.div]||'#8b92a8')+'\"></span><div>'+u.title+'<small> &#183; '+u.cust+(u.city?' &#183; '+u.city:'')+'</small></div><span class=\"uwhy\">'+u.why+'</span></div>'; });\n" +
  "    h+='</div>';",
  'unassigned drawer markup'
);

// --- 4. CSS: drag handle + dragging state ---
applyOnce(
  "  .unrow .uwhy{margin-left:auto;font-family:var(--mono);font-size:8px;font-weight:800;color:#b4482f;background:#fbeae6;border-radius:99px;padding:2px 7px;white-space:nowrap}",
  "  .unrow .uwhy{margin-left:auto;font-family:var(--mono);font-size:8px;font-weight:800;color:#b4482f;background:#fbeae6;border-radius:99px;padding:2px 7px;white-space:nowrap}\n" +
  "  .unrow .unhandle{color:#d9c2ba;font-size:11px;line-height:1;flex-shrink:0;letter-spacing:-2px}\n" +
  "  .unrow.dragging{opacity:.4}",
  'unassigned-row drag CSS'
);

// --- 5. wireDispatchDnD(): wire .unrow reorder + tech-column assign drop ---
applyOnce(
  "function wireDispatchDnD(){\n" +
  "  document.querySelectorAll('#calbody .dblk[draggable=true]').forEach(function(el){\n" +
  "    el.addEventListener('dragstart',function(e){dragDI=parseInt(el.getAttribute('data-di'));el.classList.add('dragging');if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(dragDI));}if(typeof jtipHide==='function')jtipHide();});\n" +
  "    el.addEventListener('dragend',function(){el.classList.remove('dragging');clearGhost();document.querySelectorAll('.dp-body.drop-live').forEach(function(b){b.classList.remove('drop-live');});});\n" +
  "  });\n" +
  "  document.querySelectorAll('#calbody .dp-body[data-tech]').forEach(function(body){\n" +
  "    body.addEventListener('dragover',function(e){if(dragDI===null)return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';body.classList.add('drop-live');showGhost(body,e);});\n" +
  "    body.addEventListener('dragleave',function(e){if(e.target===body){body.classList.remove('drop-live');clearGhost();}});\n" +
  "    body.addEventListener('drop',function(e){e.preventDefault();if(dragDI===null)return;var y=e.clientY-body.getBoundingClientRect().top,start=6+y/44,ti=dragDI;body.classList.remove('drop-live');clearGhost();dragDI=null;showImpactPanel(buildImpact(ti,body.getAttribute('data-tech'),start));});\n" +
  "  });\n" +
  "}",
  "function wireDispatchDnD(){\n" +
  "  document.querySelectorAll('#calbody .dblk[draggable=true]').forEach(function(el){\n" +
  "    el.addEventListener('dragstart',function(e){dragDI=parseInt(el.getAttribute('data-di'));dragUN=null;el.classList.add('dragging');if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(dragDI));}if(typeof jtipHide==='function')jtipHide();});\n" +
  "    el.addEventListener('dragend',function(){el.classList.remove('dragging');clearGhost();document.querySelectorAll('.dp-body.drop-live').forEach(function(b){b.classList.remove('drop-live');});});\n" +
  "  });\n" +
  "  // Unassigned-work drawer: drag a card onto another card to reorder\n" +
  "  // (display priority only -- nothing to persist server-side for this),\n" +
  "  // or onto a tech's column to actually assign it (real Jobber write via\n" +
  "  // the same guarded endpoint the job-drag system already uses).\n" +
  "  document.querySelectorAll('#calbody .unrow[draggable=true]').forEach(function(el){\n" +
  "    el.addEventListener('dragstart',function(e){dragUN=parseInt(el.getAttribute('data-un'));dragDI=null;el.classList.add('dragging');if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(dragUN));}});\n" +
  "    el.addEventListener('dragend',function(){el.classList.remove('dragging');document.querySelectorAll('.dp-body.drop-live').forEach(function(b){b.classList.remove('drop-live');});dragUN=null;});\n" +
  "    el.addEventListener('dragover',function(e){if(dragUN===null)return;e.preventDefault();});\n" +
  "    el.addEventListener('drop',function(e){\n" +
  "      e.preventDefault();\n" +
  "      if(dragUN===null)return;\n" +
  "      var overIdx=parseInt(el.getAttribute('data-un'));\n" +
  "      if(isNaN(overIdx)||overIdx===dragUN){dragUN=null;return;}\n" +
  "      var moved=DUN.splice(dragUN,1)[0];\n" +
  "      DUN.splice(overIdx,0,moved);\n" +
  "      dragUN=null;\n" +
  "      renderCal();\n" +
  "    });\n" +
  "  });\n" +
  "  document.querySelectorAll('#calbody .dp-body[data-tech]').forEach(function(body){\n" +
  "    body.addEventListener('dragover',function(e){if(dragDI===null&&dragUN===null)return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';body.classList.add('drop-live');if(dragDI!==null)showGhost(body,e);});\n" +
  "    body.addEventListener('dragleave',function(e){if(e.target===body){body.classList.remove('drop-live');clearGhost();}});\n" +
  "    body.addEventListener('drop',function(e){\n" +
  "      e.preventDefault();\n" +
  "      body.classList.remove('drop-live');clearGhost();\n" +
  "      var y=e.clientY-body.getBoundingClientRect().top,start=6+y/44,techId=body.getAttribute('data-tech');\n" +
  "      if(dragDI!==null){var ti=dragDI;dragDI=null;showImpactPanel(buildImpact(ti,techId,start));return;}\n" +
  "      if(dragUN!==null){var ui=dragUN;dragUN=null;assignUnassignedDrop(ui,techId,start);return;}\n" +
  "    });\n" +
  "  });\n" +
  "}",
  'wireDispatchDnD() drop handling'
);

// --- 6. assignUnassignedDrop(): the real write path, placed right before wireDispatchDnD() ---
applyOnce(
  "function wireDispatchDnD(){",
  "// Assigns a real unassigned visit to a tech by dropping it on that tech's\n" +
  "// column. Deliberately does NOT go through buildImpact()/showImpactPanel()\n" +
  "// (that ripple-analysis assumes an already-scheduled job moving FROM one\n" +
  "// tech to another) -- uses a lighter native confirm(), then reuses the\n" +
  "// exact same guarded write path (postMoveVisit/writeBackGroup) the\n" +
  "// existing job-drag system uses, so the freeze-window guardrail, receipt\n" +
  "// logging, and verified-write behavior all still apply.\n" +
  "function assignUnassignedDrop(unIdx,techId,rawStart){\n" +
  "  var u=DUN[unIdx]; if(!u) return;\n" +
  "  var tech=techById(techId);\n" +
  "  if(!tech || !tech.id){ if(window.chirpToast) chirpToast('&#9888;&#65039; Could not identify that tech column.'); return; }\n" +
  "  var dur=(u.s!=null && u.e!=null) ? Math.max(0.5,u.e-u.s) : 2;\n" +
  "  var ns=Math.round(Math.max(6,Math.min(rawStart,18.5-dur))*4)/4, ne=ns+dur;\n" +
  "  var conflict=DJOBS.some(function(x){return x.t===techId && !x.personal && !x.nonjob && ns<x.e && ne>x.s;});\n" +
  "  var msg='Assign \"'+u.title+'\" ('+u.cust+') to '+tech.n+' at '+tShort(ns)+'\\u2013'+tShort(ne)+'?'+(conflict?'\\n\\nHeads up: overlaps another job already on '+tech.n+'\\'s day -- you\\'ll still need to resolve that separately.':'');\n" +
  "  if(!window.confirm(msg)) return;\n" +
  "  if(!u.vid){ if(window.chirpToast) chirpToast('&#9888;&#65039; Can\\'t assign -- missing a real Jobber visit id (refresh the board and try again).'); return; }\n" +
  "  var newJob={ t:techId, s:ns, e:ne, div:tech.div, cust:u.cust, city:u.city||'', type:u.title, st:{g:'scheduled',s:'Scheduled'}, h:'g', num:null, jid:u.jid||null, vid:u.vid };\n" +
  "  DJOBS.push(newJob);\n" +
  "  DUN.splice(unIdx,1);\n" +
  "  renderCal();\n" +
  "  var dateYmd=(typeof CAL!=='undefined'&&CAL.date)?CAL.date:null;\n" +
  "  var label=u.cust+' assigned to '+tech.n+' at '+tShort(ns);\n" +
  "  var item={ j:newJob, prevT:null, prevS:null, prevE:null, newT:techId, newS:ns, newE:ne, vid:u.vid, dateYmd:dateYmd, techChanged:true, timeChanged:true, fromTechJid:null, toTechJid:tech.jid||null, reason:null, label:label, groupLabel:label };\n" +
  "  writeBackGroup([item],'forward');\n" +
  "}\n" +
  "function wireDispatchDnD(){",
  'assignUnassignedDrop() function'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
const need = ['assignUnassignedDrop', 'dragUN', 'data-un=', 'DUN = newDun', 'unhandle'];
const missing = need.filter((n) => !check.includes(n));
if (!missing.length && changes === 6) {
  console.log('SUCCESS: real unassigned-visits dock (data + reorder + drag-to-assign) shipped (' + changes + ' edits). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification did not fully match (missing: ' + missing.join(', ') + ', changes=' + changes + '). Do not commit -- send this output back.');
  process.exit(1);
}
