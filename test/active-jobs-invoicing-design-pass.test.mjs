// test/active-jobs-invoicing-design-pass.test.mjs
// jomell, 2026-08-26: a coworker built a full visual redesign of HiveLogic
// in Figma Make (React/Tailwind) and shared the exported project. "Start
// with Active Jobs and Invoicing & AR" -- a design-language pass (colors,
// card/pill treatment, KPI-tile-with-icon style, spacing) applied to the
// real, already-wired-up screens, not a rebuild. Everything here is a pure
// CSS/markup change; every existing id/onclick/function name is untouched
// so real data, drag-and-drop, and the linked-invoices click-through all
// keep working exactly as before.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSource = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n');
const HTML = readSource('public', 'index.html');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

const VIEW_JOBS = (() => {
  const start = HTML.indexOf('<div id="view-jobs" style="display:none">');
  assert.ok(start > -1, 'the Active Jobs production board view should still be findable');
  return HTML.slice(start, start + 8000);
})();

// ---- Active Jobs board ------------------------------------------------------

test('the reskin CSS is scoped to #view-jobs, not the shared .kpi/.pcol/.pcard classes other boards (Estimates) also use', () => {
  assert.match(VIEW_JOBS, /#view-jobs \.kpi\{/);
  assert.match(VIEW_JOBS, /#view-jobs \.pcol\{/);
  assert.match(VIEW_JOBS, /#view-jobs \.pcard\{/);
  // A bare, unscoped redefinition of these classes would leak into Estimates'
  // own kanban board (.pcol.est) and any other reuse of this shared component.
  assert.doesNotMatch(VIEW_JOBS, /\n\s*\.kpi\{/);
  assert.doesNotMatch(VIEW_JOBS, /\n\s*\.pcol\{/);
});

test('each of the four KPI tiles gets an icon-in-colored-square, matching the mockup', () => {
  const icons = ['#dcfce7', '#dbeafe', '#fef9c3', '#fee2e2'];
  icons.forEach((bg) => {
    assert.ok(VIEW_JOBS.includes('class="kpi-ic" style="background:' + bg + '"'), 'missing kpi-ic tile with background ' + bg);
  });
  assert.match(VIEW_JOBS, /<svg width="20" height="20"/);
});

test('the four real KPI ids are still the exact ones renderJobsBoardLive writes into -- the reskin did not touch data wiring', () => {
  for (const id of ['jwb-kpi-value', 'jwb-kpi-count', 'jwb-kpi-deposit', 'jwb-kpi-hold']) {
    assert.match(VIEW_JOBS, new RegExp('id="' + id + '"'));
  }
  const renderFn = extractFunction(HTML, 'function renderJobsBoardLive() {');
  for (const id of ['jwb-kpi-value', 'jwb-kpi-count', 'jwb-kpi-deposit', 'jwb-kpi-hold']) {
    assert.match(renderFn, new RegExp("getElementById\\('" + id + "'\\)"));
  }
});

test('the kanban card renderer (.pcard/.jc-title/.pmeta) and drag-and-drop wiring are untouched by the design pass', () => {
  const renderFn = extractFunction(HTML, 'function renderJobsBoardLive() {');
  assert.match(renderFn, /class="pcard" draggable="true"/);
  assert.match(renderFn, /onclick="openRealJob\(/);
  assert.match(HTML, /function wireJwbDragDrop\(\) \{/);
});

// ---- Invoicing & AR ----------------------------------------------------------

test('the New Invoice button adopts the mockup\'s navy, without touching the shared btn-save class other screens use', () => {
  const start = HTML.indexOf('<div id="view-invx" style="display:none">');
  const section = HTML.slice(start, start + 2500);
  assert.match(section, /background:#1e3a5f/);
  assert.doesNotMatch(section, /class="btn-save"/, 'must not depend on .btn-save, which many other create-buttons in the app also use');
  assert.match(section, /onclick="ivxOpenCreate\(\)"/, 'the real create handler must still be wired');
});

test('ivxSetMode toggles the active tab\'s shadow along with its background/color, so a click does not leave a stale shadow behind', () => {
  const fn = extractFunction(HTML, 'function ivxSetMode(m){');
  assert.match(fn, /o\.style\.boxShadow=\(m==='open'\?'0 1px 3px rgba\(0,0,0,\.08\)':'none'\)/);
  assert.match(fn, /a\.style\.boxShadow=\(m==='all'\?'0 1px 3px rgba\(0,0,0,\.08\)':'none'\)/);
});

test('ivxCard uses the design pass\'s card treatment (radius 12, padded, shadowed) while keeping every real id/onclick intact', () => {
  const fn = extractFunction(HTML, 'function ivxCard(i){');
  assert.match(fn, /border-radius:12px;padding:18px 22px;background:#fff;box-shadow:0 1px 3px rgba\(0,0,0,\.05\)/);
  assert.match(fn, /id="ivxrow-'\+ivxEsc\(i\.id\)\+'"/);
  assert.match(fn, /onclick="ivxMarkPaid\(/);
  assert.match(fn, /onclick="ivxSendEmail\(/);
});

test('secondary invoice actions (Mark paid, Open in Jobber) are outlined, matching the mockup\'s filled-primary/outlined-secondary hierarchy', () => {
  const fn = extractFunction(HTML, 'function ivxCard(i){');
  assert.match(fn, /border:1\.5px solid #d1d5db;border-radius:7px[^"]*background:#fff;color:#0f172a"[^>]*>Mark paid/);
  assert.match(fn, /border:1\.5px solid #2563eb;border-radius:7px[^"]*background:#fff;color:#2563eb">Open in Jobber/);
});

test('the summary tiles keep their real ids and computed values -- only the visual treatment changed', () => {
  const fn = extractFunction(HTML, 'function ivxRender(){');
  assert.match(fn, /font-size:30px;color:#0f172a;margin-bottom:6px">'\+ivxMoney\(ar\)/);
  assert.match(fn, /arRows\.length\+' open/);
  assert.match(fn, /font-size:30px;color:#0f172a;margin-bottom:6px">'\+drafts/);
});

test('nothing in the summary/list/card path was renamed -- ivxLoad, ivxRender, and ivxCard still call each other the same way', () => {
  const loadFn = extractFunction(HTML, 'function ivxLoad(){');
  assert.match(loadFn, /ivxRender\(\);/);
  const renderFn = extractFunction(HTML, 'function ivxRender(){');
  assert.match(renderFn, /rows\.forEach\(function\(i\)\{ html\+=ivxCard\(i\); \}\);/);
});

// ---- Sidebar -----------------------------------------------------------------
// jomell: "add the ui/ux design for the sidebar."

const RAIL = (() => {
  const start = HTML.indexOf('<aside class="rail" role="navigation" aria-label="Primary">');
  assert.ok(start > -1, 'the primary sidebar should still be findable');
  return HTML.slice(start, start + 2000);
})();

test('the sidebar reskin is scoped under .rail, never a bare redefinition of .nav/.ic/.logo/.foot -- all four are reused by unrelated parts of the app', () => {
  assert.match(RAIL, /\.rail \.nav\{/);
  assert.match(RAIL, /\.rail \.nav:hover\{/);
  assert.match(RAIL, /\.rail \.nav\.on\{/);
  assert.match(RAIL, /\.rail \.logo \.tagline\{/);
  assert.doesNotMatch(RAIL, /\n\s*\.nav\{/);
  assert.doesNotMatch(RAIL, /\n\s*\.ic\{/);
  assert.doesNotMatch(RAIL, /\n\s*\.logo\{/);
  assert.doesNotMatch(RAIL, /\n\s*\.foot\{/);
});

test('the sidebar background moves to the mockup\'s navy gradient', () => {
  assert.match(RAIL, /\.rail\{background:linear-gradient\(180deg,#0a1e30 0%,#0f2d47 55%,#0a1c2e 100%\)\}/);
});

// ---- Change Orders ------------------------------------------------------------

test('the Change Orders header/button adopt the mockup styling without touching the shared btn-save class', () => {
  const start = HTML.indexOf('<div id="view-co" style="display:none">');
  const section = HTML.slice(start, start + 1500);
  assert.match(section, /background:#1e3a5f/);
  assert.doesNotMatch(section, /class="btn-save"/);
  assert.match(section, /onclick="coOpenCreate\(\)"/);
});

test('coBadge moves from a pill to the mockup\'s bordered chip, while covering every real status', () => {
  const fn = extractFunction(HTML, 'function coBadge(s){');
  assert.match(fn, /border-radius:4px/);
  assert.match(fn, /border:1px solid '\+c\[0\]\+'40/);
  for (const status of ['draft', 'sent', 'approved', 'rejected', 'overdue', 'paid', 'partially_paid']) {
    assert.match(fn, new RegExp(status + ':\\['));
  }
});

test('coCard keeps every real id and action wired -- coSend/coApprove/coRejectForm/coPayForm', () => {
  const fn = extractFunction(HTML, 'function coCard(co){');
  assert.match(fn, /id="corow-'\+cid\+'"/);
  assert.match(fn, /id="coacts-'\+cid\+'"/);
  assert.match(fn, /id="cop-'\+cid\+'"/);
  assert.match(fn, /onclick="coSend\(/);
  assert.match(fn, /onclick="coApprove\(/);
  assert.match(fn, /onclick="coRejectForm\(/);
  assert.match(fn, /onclick="coPayForm\(/);
});

// ---- Clients --------------------------------------------------------------

test('the Clients reskin is scoped under #view-clients, never a bare .stat/.rav redefinition -- both are reused elsewhere', () => {
  const start = HTML.indexOf('<div id="view-clients" style="display:none">');
  const section = HTML.slice(start, start + 900);
  assert.match(section, /#view-clients \.stat\{/);
  assert.match(section, /#view-clients \.rav\{/);
  assert.doesNotMatch(section, /\n\s*\.stat\{/);
  assert.doesNotMatch(section, /\n\s*\.rav\{/);
});

test('the client avatar chip gets real styling -- previously .rav rendered unstyled outside .rowline, the only other place it appears', () => {
  const fn = extractFunction(HTML, 'function cdbRender(){');
  assert.match(fn, /class="rav" style="background:'\+col\+'"/);
  const start = HTML.indexOf('<div id="view-clients" style="display:none">');
  const section = HTML.slice(start, start + 900);
  assert.match(section, /width:30px;height:30px;border-radius:8px/);
});

test('cdbRender keeps every real search/filter/sort input and the click-through to openRealClient', () => {
  const fn = extractFunction(HTML, 'function cdbRender(){');
  assert.match(fn, /getElementById\('cdb-q'\)/);
  assert.match(fn, /getElementById\('cdb-sort'\)/);
  assert.match(fn, /onclick="openRealClient\(/);
});

test('every real nav id and its onclick handler survive the reskin untouched', () => {
  const start = HTML.indexOf('<aside class="rail" role="navigation" aria-label="Primary">');
  const end = HTML.indexOf('</aside>', start);
  const section = HTML.slice(start, end);
  for (const [id, onclick] of [
    ['nav-cc', "showView('cc')"],
    ['nav-sched', "showView('schedule')"],
    ['nav-ajx', "showView('ajx')"],
    ['nav-invx', "showView('invx')"],
    ['nav-ttx', "showView('ttx')"],
    ['nav-signout', 'hlSignOut()'],
  ]) {
    assert.match(section, new RegExp(`id="${id}" onclick="${onclick.replace(/[().']/g, '\\$&')}"`), `${id} should still call ${onclick}`);
  }
  assert.match(section, /onclick="hlGrpAllToggle\(\)"/);
  assert.match(section, /onclick="hlCompanyPop\(\)"/);
});
