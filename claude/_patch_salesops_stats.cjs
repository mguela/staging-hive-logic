// Sales & Operations redesign (Chris 2026-07-26): the old widget showed two
// abstract OPEN/GAP bars where "GAP" was just the length of a hardcoded list
// of not-yet-tracked items -- useless. Replace with a clickable stat-tile grid
// of real numbers already returned by /api/track1?resource=dailybrief +
// crew_schedule: quote pipeline $, past-due invoices $, completed-not-billed $,
// today's visits, unassigned visits, stalled jobs. Idempotent.
const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('rb-stat-grid')) { console.log('ALREADY PATCHED'); process.exit(0); }

function countOf(str, sub) { return str.split(sub).length - 1; }

// ---- 1) CSS: append tile styles after the chart-legend rule ----
const CSS_ANCHOR = '#daily-brief-card .rb-chart-legend{display:flex;gap:18px;margin-top:2px;font-size:11px;color:var(--db-text-secondary)}';
if (countOf(s, CSS_ANCHOR) !== 1) { console.error('CSS anchor count ' + countOf(s, CSS_ANCHOR)); process.exit(1); }

const NEW_CSS = CSS_ANCHOR + `
  #daily-brief-card .rb-stat-grp{font-size:10px;font-weight:800;letter-spacing:.06em;color:var(--db-text-secondary);margin:2px 0 6px}
  #daily-brief-card .rb-stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  @media (max-width:640px){#daily-brief-card .rb-stat-grid{grid-template-columns:repeat(2,1fr)}}
  #daily-brief-card .rb-stat{border:1px solid var(--db-border);border-left-width:3px;border-radius:10px;padding:9px 11px;background:#fff;transition:box-shadow .15s}
  #daily-brief-card .rb-stat:hover{box-shadow:0 3px 8px rgba(22,30,46,.14)}
  #daily-brief-card .rb-stat-val{font-size:18px;font-weight:800;color:var(--db-text-primary);line-height:1.15}
  #daily-brief-card .rb-stat-lab{font-size:11px;font-weight:700;color:var(--db-text-secondary);margin-top:2px}
  #daily-brief-card .rb-stat-sub{font-size:10.5px;color:var(--db-text-secondary);margin-top:1px}
  #daily-brief-card .rb-stat.good{border-left-color:#2e9e52;background:#F7FBF8}
  #daily-brief-card .rb-stat.good .rb-stat-val{color:#1e5c34}
  #daily-brief-card .rb-stat.warn{border-left-color:#e0a415;background:#FFFBF0}
  #daily-brief-card .rb-stat.warn .rb-stat-val{color:#6b4a06}
  #daily-brief-card .rb-stat.bad{border-left-color:#d03b3b;background:#FFF6F5}
  #daily-brief-card .rb-stat.bad .rb-stat-val{color:#a52a2a}
  #daily-brief-card .rb-stat.info{border-left-color:var(--db-blue-dark)}
  #daily-brief-card .rb-stat.off{border-left-color:#c7cdd8;background:#fafbfd}
  #daily-brief-card .rb-stat.off .rb-stat-val{color:#9aa3b5}`;
s = s.replace(CSS_ANCHOR, NEW_CSS);

// ---- 2) JS: replace the whole OPEN/GAP block with the stat grid ----
const START = '    // ---- Sales & Operations: simple horizontal bar comparison (same visual pattern as the Financial Intelligence Forecast tab) ----';
const END_MARK = "'<div class=\"rb-chart-cap\">' + opsCap + '</div>' +";
if (countOf(s, START) !== 1) { console.error('START count ' + countOf(s, START)); process.exit(1); }
if (countOf(s, END_MARK) !== 1) { console.error('END_MARK count ' + countOf(s, END_MARK)); process.exit(1); }

const iStart = s.indexOf(START);
const iEndMark = s.indexOf(END_MARK);
const CLOSER = "'</div>';";
const iCloser = s.indexOf(CLOSER, iEndMark);
if (iCloser < 0 || iCloser - iEndMark > 200) { console.error('closer not found near END_MARK'); process.exit(1); }
const iEnd = iCloser + CLOSER.length;

const NEW_JS = String.raw`    // ---- Sales & Operations: real numbers, clickable (2026-07-26 redesign) ----
    var crewOk = !!(crew && crew.ok);
    var opsOpenVal = crewOk ? (crew.unassignedVisits || []).length : null;

    function statTile(o){
      var click = o.view ? (' onclick="showView(\'' + o.view + '\')" style="cursor:pointer"') : '';
      return '<div class="rb-stat ' + (o.tone || 'info') + '"' + click + (o.title ? (' title="' + esc(o.title) + '"') : '') + '>' +
        '<div class="rb-stat-val">' + o.value + '</div>' +
        '<div class="rb-stat-lab">' + esc(o.label) + '</div>' +
        (o.sub ? ('<div class="rb-stat-sub">' + esc(o.sub) + '</div>') : '') +
      '</div>';
    }
    function plural(n, w){ return n + ' ' + w + (n === 1 ? '' : 's'); }

    var oq = data.openQuotes, pdi = data.pastDueInvoices, cni = data.completedNotInvoiced, stj = data.stalledJobs, tv = data.todaysVisits;

    var salesTiles =
      statTile(oq ? {label:'Quote pipeline', value: money(oq.sum), sub: plural(oq.count, 'quote') + ' awaiting client reply', view:'estimates', tone: oq.count > 0 ? 'info' : 'good', title:'Open quotes in Jobber -- click to review estimates'} : {label:'Quote pipeline', value:'—', sub:'lookup failed this morning', tone:'off'}) +
      statTile(pdi ? {label:'Past-due invoices', value: money(pdi.sum), sub: pdi.count > 0 ? (plural(pdi.count, 'invoice') + ' to chase') : 'nothing overdue', view:'invx', tone: pdi.count > 0 ? 'bad' : 'good', title:'Unpaid invoices past their due date -- click to open invoices'} : {label:'Past-due invoices', value:'—', sub:'lookup failed this morning', tone:'off'}) +
      statTile(cni ? {label:'Done, not billed', value: money(cni.sumOfPricedJobs), sub: cni.count > 0 ? (plural(cni.count, 'finished job') + ' awaiting invoice') : 'all finished work billed', view:'jobs', tone: cni.count > 0 ? 'warn' : 'good', title:'Completed work not yet invoiced -- click to open jobs'} : {label:'Done, not billed', value:'—', sub:'lookup failed this morning', tone:'off'});

    var opsTiles =
      statTile(tv ? {label:'Visits today', value: String(tv.count), sub: tv.count > 0 ? 'on the board' : 'nothing scheduled today', view:'crew', tone:'info', title:'Today\'s scheduled visits -- click for the crew board'} : {label:'Visits today', value:'—', sub:'lookup failed this morning', tone:'off'}) +
      statTile(crewOk ? {label:'Unassigned visits', value: String(opsOpenVal), sub: opsOpenVal > 0 ? 'need a tech assigned' : 'every visit covered', view:'crew', tone: opsOpenVal > 0 ? 'bad' : 'good', title:'Visits today with no tech assigned -- click to assign'} : {label:'Unassigned visits', value:'—', sub:'lookup failed this morning', tone:'off'}) +
      statTile(stj ? {label:'Stalled jobs', value: String(stj.count), sub: stj.count > 0 ? '3+ days, no update or photo' : 'all active jobs moving', view:'jobs', tone: stj.count > 0 ? 'warn' : 'good', title:'Active jobs with no Jobber status change and no CompanyCam photo in 3+ days -- click to open jobs'} : {label:'Stalled jobs', value:'—', sub:'lookup failed this morning', tone:'off'});

    var salesOpsHtml = '<div class="rb-section-label">SALES & OPERATIONS</div>' +
      '<div class="rb-chart-card">' +
        '<div class="rb-stat-grp">SALES</div><div class="rb-stat-grid">' + salesTiles + '</div>' +
        '<div class="rb-stat-grp" style="margin-top:12px">OPERATIONS</div><div class="rb-stat-grid">' + opsTiles + '</div>' +
        '<div class="rb-chart-cap" style="margin-top:10px">Live from Jobber + QuickBooks. Click any tile to jump straight to the work.</div>' +
      '</div>';`;

s = s.slice(0, iStart) + NEW_JS + s.slice(iEnd);
fs.writeFileSync(p, s);
console.log('PATCHED OK');
