import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('public/index.html', 'utf8');
const docsView = fs.readFileSync('public/views/docs.html', 'utf8');
const hcJs = fs.readFileSync('public/hiveconnect/app.js', 'utf8');
const hcCss = fs.readFileSync('public/hiveconnect/styles-scoped.css', 'utf8');
const phoneJs = fs.readFileSync('public/app-phone-popup.js', 'utf8');

test('Documents All documents view does not silently mean only unfiled documents', () => {
  assert.doesNotMatch(html, /q\s*=\s*q\.is\('folder_id',\s*null\)/);
  assert.match(html, /if\(HLDOC\.activeFolder\) q = q\.eq\('folder_id'/);
});

test('Documents tells the truth when classification is unavailable and cleans up an orphaned upload', () => {
  assert.match(docsView, /Reina suggests a type when classification is available/);
  assert.doesNotMatch(docsView, /drag a file in/i);
  assert.match(html, /Automatic classification is unavailable/);
  assert.match(html, /if\(file\.size < 3 \* 1024 \* 1024\)/,
    'the browser must respect the API decoded-sample ceiling');
  assert.match(html, /'Authorization': 'Bearer ' \+ classifySession\.access_token/,
    'the protected classifier request must carry the restored user session');
  assert.match(html, /This file is 3 MB or larger, so automatic classification was skipped/);
  assert.match(html, /storage\.from\('docs'\)\.remove\(\[path\]\)/);
});

test('Change Orders UI remains wired to the real bookkeeping backend', () => {
  assert.match(html, /change-orders\/list/);
  assert.match(html, /change-orders\/'\+action/);
  for (const action of ['create', 'send', 'approve', 'reject', 'record-payment'])
    assert.match(html, new RegExp(`coApi\\('${action}'`));
  assert.match(html, /if\(v==='co'&&typeof coLoadList==='function'\)\{coLoadList\(\);\}/);
});

test('preserved zero-backend mockups are hidden from normal production nav', () => {
  assert.match(html, /id="nav-grp-uc"[^>]*display:none/);
  assert.match(html, /__ucNav\.style\.display = __canSeeInternal \? '' : 'none'/);
  assert.equal((html.match(/class="uc-note"/g) || []).length, 14);
  assert.match(html, /Partial prototype:[\s\S]*ticket form[\s\S]*do not write to production/);
  assert.match(html, /"tmx": "uc"/);
});

test('manager sheet views paginate the loaded 250-row window instead of rendering it all at once', () => {
  assert.match(html, /var MGR_PAGE_SIZE = 50/);
  assert.match(html, /visibleRows = rows\.slice\(start, start \+ MGR_PAGE_SIZE\)/);
  assert.match(html, /Rows '\+\(start\+1\)\+'–'/);
  assert.match(html, /'← Previous'/);
  assert.match(html, /'Next →'/);
});

test('Documents uses bounded server pages and labels its page-local search honestly', () => {
  assert.match(html, /docPageSize: 50/);
  assert.match(html, /select\('\*', \{ count: 'exact' \}\)/);
  assert.match(html, /q = q\.range\(from, from \+ pageSize - 1\)/);
  assert.match(html, /function hlDocPage\(delta\)/);
  assert.match(docsView, /id="hldoc-page"/);
  assert.match(docsView, /placeholder="Search this page…"/);
  assert.match(html, /Search filters this page only/);
});

test('Today brief schedule row is a real navigation link', () => {
  assert.match(html, /Full timing lives on the schedule\.', tone:'live', view:'schedule'/);
});

test('Inbox selection has both behavior and readable active-state styling', () => {
  assert.match(hcJs, /classList\.toggle\('active', b\.dataset\.id === id\)/);
  assert.match(hcCss, /\.ev-folder\.active\{background:#eef2fb\}/);
  assert.match(hcCss, /\.ev-folder\.active \.ev-folder-nm[\s\S]*color:#16203a/);
});

test('the browser bundle has no stale raw-GitHub playbook dependency', () => {
  assert.doesNotMatch(html, /raw\.githubusercontent\.com|githubusercontent\.com/i);
});

test('hidden authenticated views stay network-silent until sign-in or view entry', () => {
  assert.match(html, /id="hivesight-iframe" src="about:blank" data-src="\/vi-app\/"/,
    'the hidden HiveSight iframe must not boot its API client on the login screen');
  assert.match(html, /window\.hlStandupReload = load/);
  assert.match(html, /if\(page==='standup'[\s\S]{0,240}hlRequireSession\(window\.hlStandupReload/);
  assert.match(html, /function hlDocEnsureLoaded\(\)[\s\S]{0,300}hlRequireSession/);
  assert.match(html, /window\.hlEnsureExpxLoaded = function\(\)\{ selectExpxTab\(activeExpxTab\); \}/);
  const expxWire = html.slice(html.indexOf('function wireExpxSubnav()'), html.indexOf("window.hlSelectExpxTab = selectExpxTab"));
  assert.doesNotMatch(expxWire, /loadExpxTab\('bookkeeping'\)/,
    'the accounting fragment must not initialize behind the login overlay');
  assert.match(html, /window\.hlReportsLoadLive = function\(\)[\s\S]{0,500}fetch\('\/api\/reports\/summary'\)/);
  assert.match(html, /if\(unsignedApi\) return Promise\.resolve\(_hlAuthRequiredResponse\(\)\)/,
    'any missed unsigned app API call must still fail locally');
  assert.doesNotMatch(html, /DOMContentLoaded[^\n]*(?:loadCrewScheduleReal|loadFleetGpsReal|loadEmployeeRoster|loadRealSchedule)/,
    'legacy Schedule loaders must not wake hidden API clients at startup');
  assert.doesNotMatch(html, /^\s*(?:loadRealVendorBills|loadRealInvoicesByJob)\(\);/m,
    'legacy QBO loaders must not run at parse time');
  assert.match(phoneJs, /function gatedBoot\(\)[\s\S]{0,180}window\.hlRequireSession\(boot/,
    'the phone status request must wait for a restored session');
  assert.match(phoneJs, /DOMContentLoaded', gatedBoot/);
  assert.match(phoneJs, /hl:signed-in', gatedBoot/);
  assert.doesNotMatch(phoneJs, /DOMContentLoaded', boot/,
    'a logged-out boot must not permanently mark the phone as unconfigured');
  assert.match(html, /function ccInitialWidgetLoad\(\)[\s\S]{0,800}teamTodoLoad\(\)/,
    'Team To-Do must load only inside the active Command Center lifecycle');
  const teamTodoTail = html.slice(html.indexOf('function teamTodoLoad()'), html.indexOf('</script>', html.indexOf('function teamTodoLoad()')));
  assert.doesNotMatch(teamTodoTail, /DOMContentLoaded', teamTodoLoad|hl:signed-in', teamTodoLoad/,
    'Team To-Do must not fetch invisibly on another signed-in view');
});

test('two immediate HiveSight loads coalesce and the latest deep link wins', async () => {
  const start = html.indexOf('function hlEnsureHiveSight(route){');
  const end = html.indexOf('function go(page){', start);
  assert.ok(start !== -1 && end !== -1, 'HiveSight lazy loader must be extractable');
  const source = html.slice(start, end);
  const assigned = [];
  const iframe = {
    dataset: { src: '/vi-app/' },
    _hlLoadPromise: null,
    currentSrc: 'about:blank',
    getAttribute(name) { return name === 'src' ? this.currentSrc : null; },
    setAttribute(name, value) { if (name === 'src') { this.currentSrc = value; assigned.push(value); } },
  };
  let release;
  const windowRef = {
    hlRequireSession(onSession) {
      return new Promise((resolve) => { release = () => resolve(onSession({ access_token: 'test' })); });
    },
  };
  const context = {
    window: windowRef,
    document: { getElementById: (id) => id === 'hivesight-iframe' ? iframe : null },
    Promise,
  };
  vm.runInNewContext(source, context);
  const first = context.hlEnsureHiveSight();
  const second = context.hlEnsureHiveSight('/vi-app/media/photo-123');
  assert.equal(first, second, 'concurrent requests must share one auth/load operation');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(assigned, ['/vi-app/media/photo-123']);
});

test('every canonical route resolves to a shipped view and admin Dev To-Do is no longer orphaned', () => {
  const routeMatch = html.match(/var HL_ROUTE_VIEWS = \[([^\]]+)\]/);
  assert.ok(routeMatch);
  const routes = [...routeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const specialRoots = { cc: 'snapshot', marketing_cc: 'view-marketing-cc', ttx: 'workforce' };
  for (const route of routes) {
    const id = specialRoots[route] || `view-${route}`;
    assert.match(html, new RegExp(`id="${id}"`), `${route} must resolve to a real shipped view root`);
  }
  assert.ok(routes.includes('devtodo'));
  assert.match(html, /"devtodo": "manager"/);

  const navTags = [...html.matchAll(/<div class="nav"[^>]*>/g)].map((m) => m[0]);
  for (const tag of navTags) {
    const target = tag.match(/showView\('([^']*)'\)/)?.[1];
    if(target) assert.ok(routes.includes(target), `nav target ${target} must be canonical`);
  }
});
