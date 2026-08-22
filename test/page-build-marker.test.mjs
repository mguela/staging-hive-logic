// test/page-build-marker.test.mjs
//
// "It's merged and deployed" says nothing about the tab where the bug was
// reported.
//
// On 2026-08-16 an idle-timeout fix was merged, deployed, and tested against
// production for an hour. The test proved nothing: the browser under test was
// still running the page from before the merge. Worse, I had told Chris the
// opposite -- the server's new PostgREST query was visibly running in the edge
// logs, and I read that as proof the page was new. It is not. An OLD page
// calling monitor_my_status triggers the NEW server's query identically. The
// two halves deploy together and then age apart, and a long-lived tab can run
// last week's JavaScript for days.
//
// So the page states which build it is, the poll reports it, and staleness is
// a query instead of an inference. These tests defend the part that can rot
// quietly: the marker must actually correspond to the file it claims to
// describe. A marker that can go stale is WORSE than no marker, because it
// reports "current" while lying -- the exact failure it exists to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const {
  PAGE_BUILD, PAGE_BUILD_MARKER, computePageBuild, isWellFormedBuild,
  pageBuildState, shouldRecordPageBuild, PAGE_BUILD_RECORD_INTERVAL_MS,
  pageAssetRefs, loadPageAssets, runtimeAssetRefs, pageFrameRefs, runtimePageRefs,
} = await import('../api/_lib/page-build.js');

const html = fs.readFileSync('public/index.html', 'utf8');
const assets = loadPageAssets(html);

// --- The marker must match the file it describes ---------------------------

test('the page carries a build marker', () => {
  const m = html.match(PAGE_BUILD_MARKER);
  assert.ok(m, 'public/index.html must declare HL_PAGE_BUILD -- without it no client can say what it is running');
});

test('the marker equals the hash of the page as it actually is', () => {
  const declared = html.match(PAGE_BUILD_MARKER)[1];
  assert.equal(
    declared, computePageBuild(html, assets),
    'public/index.html or one of the scripts/stylesheets it loads changed without restamping. Run: node scripts/stamp-page-build.mjs'
  );
});

test('the server expects exactly the build the page declares', () => {
  assert.equal(
    PAGE_BUILD, html.match(PAGE_BUILD_MARKER)[1],
    'api/_lib/page-build.js and public/index.html disagree -- every client would be reported stale. Run: node scripts/stamp-page-build.mjs'
  );
});

test('editing the page changes its build id', () => {
  // The whole mechanism rests on this. If an edit could leave the id alone,
  // a browser could report "current" while running superseded code.
  const edited = html.replace('</body>', '<!-- a real change --></body>');
  assert.notEqual(edited, html, 'sanity: the edit must have applied');
  assert.notEqual(computePageBuild(edited, assets), computePageBuild(html, assets));
});

test('the id does not depend on what the file currently claims it is', () => {
  // The marker is blanked before hashing, so a hand-edited (wrong) marker
  // still computes the same correct answer -- which is what lets the test
  // above detect drift rather than rubber-stamp it.
  const lied = html.replace(PAGE_BUILD_MARKER, "var HL_PAGE_BUILD = 'deadbeefdeadbeef';");
  assert.equal(computePageBuild(lied, assets), computePageBuild(html, assets));
});

// --- The page is not only index.html ---------------------------------------
//
// index.html is about a fifth of what the page actually executes. The rest is
// ~600KB of same-origin JavaScript and CSS in separate files, every byte of it
// as capable of being stale in a long-lived tab. Hashing only index.html would
// have reported those tabs "current" while lying -- the exact failure the whole
// mechanism exists to prevent, just moved one file over.

test('every same-origin script and stylesheet the page loads is hashed into the id', () => {
  // Not a hardcoded list: the refs are read out of the page, so a module added
  // tomorrow is covered the moment its tag exists.
  const refs = pageAssetRefs(html);
  assert.ok(refs.length >= 20, `expected the page's own script/link tags to yield its modules, got ${refs.length}`);
  for (const expected of [
    'app-bookkeeping.js', 'app-phone-popup.js', 'app-reina-council.js',
    'reina-pilot-host.js', 'sfx.js', 'voice-input.js',
    'bookkeeping.css', 'reina-council.css',
  ]) {
    assert.ok(refs.includes(expected), `${expected} is loaded by the page but would not be hashed`);
  }
});

test('editing a shipped module changes the build id', () => {
  // THE test for this whole section. Before assets were folded in, this passed
  // trivially and proved nothing: a changed app-*.js left the id untouched and
  // every tab running the old copy was reported current.
  const target = assets.find((a) => a.path === 'app-bookkeeping.js');
  assert.ok(target, 'sanity: app-bookkeeping.js must be one of the hashed assets');

  const tampered = assets.map((a) => (a.path === target.path ? { ...a, source: `${a.source}\n// a real change\n` } : a));
  assert.notEqual(
    computePageBuild(html, tampered), computePageBuild(html, assets),
    'a change to a shipped module must move the build id, or its tabs are reported current while stale'
  );
});

test('renaming a module changes the id even if its bytes do not', () => {
  // The path is hashed alongside the content, so two modules trading places --
  // or one being renamed -- cannot produce the same digest.
  const renamed = assets.map((a) => (a.path === 'sfx.js' ? { ...a, path: 'sound-effects.js' } : a));
  assert.notEqual(computePageBuild(html, renamed), computePageBuild(html, assets));
});

test('the id does not depend on the order assets were discovered in', () => {
  // Sorted before hashing. Reordering the tags is a change to index.html, which
  // the html hash already catches on its own -- it must not ALSO shift the id
  // through a second, order-dependent path.
  assert.equal(computePageBuild(html, [...assets].reverse()), computePageBuild(html, assets));
});

test('the id is identical on Windows and Linux line endings', () => {
  const withCrLf = (value) => String(value).replace(/\r?\n/g, '\r\n');
  const windowsAssets = assets.map((asset) => ({ ...asset, source: withCrLf(asset.source) }));
  assert.equal(
    computePageBuild(withCrLf(html), windowsAssets),
    computePageBuild(html, assets),
    'the release fingerprint must not change solely because Git checked files out on another OS'
  );
});

test('cross-origin CDN references are not treated as ours', () => {
  const refs = pageAssetRefs(`
    <script src="https://cdn.jsdelivr.net/npm/gridstack@10/dist/gridstack-all.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
    <script src="//example.com/protocol-relative.js"></script>
    <script src="data:text/javascript,void 0"></script>
    <script src="/ours.js"></script>
  `);
  assert.deepEqual(refs, ['ours.js'], 'we cannot hash what we do not serve, and those URLs are already version-pinned');
});

test('a module is one file no matter how its tag is written', () => {
  // ?v= cache-busters, a leading slash or not, and the same module listed twice
  // all resolve to one path -- otherwise the same bytes would be hashed twice
  // and a purely cosmetic tag edit would look like a code change.
  assert.deepEqual(
    pageAssetRefs(`
      <script src="/voice-input.js?v=20260814b"></script>
      <script src="voice-input.js"></script>
      <script src="/voice-input.js#frag"></script>
    `),
    ['voice-input.js']
  );
});

test('a non-stylesheet link is not hashed', () => {
  assert.deepEqual(pageAssetRefs('<link rel="icon" href="/favicon.ico">'), []);
  assert.deepEqual(pageAssetRefs('<link rel="preload" as="font" href="/f.woff2">'), []);
  assert.deepEqual(pageAssetRefs('<link rel="stylesheet" href="/real.css">'), ['real.css']);
});

test('an asset that cannot be read is an error, never a silent skip', () => {
  // Skipping would leave a shipped file uncovered while the id still looked
  // valid -- which is precisely the lie this file exists to stop.
  assert.throws(
    () => loadPageAssets('<script src="/definitely-not-here.js"></script>'),
    /definitely-not-here\.js/
  );
});

// --- Sub-apps the page embeds in an iframe --------------------------------
//
// The page does not only load files -- it embeds whole other pages. Hive
// Marketing is an iframe pointing at /marketing-command-center/, 122KB of page
// with its own scripts that nothing in index.html declares. Same for /vi-app/,
// /schedule-board/ and /subportal-admin/. Before these were followed, editing
// any of them left the build id untouched and their tabs read as current.

test('every same-origin page the app embeds is hashed', () => {
  const paths = assets.map((a) => a.path);
  for (const expected of [
    'marketing-command-center/index.html', // iframe src set in openMarketingCC()
    'vi-app/index.html',                   // declared <iframe src="/vi-app/">
    'schedule-board/index.html',
    'subportal-admin/index.html',
  ]) {
    assert.ok(paths.includes(expected), `${expected} is embedded in the app but would not be hashed`);
  }
});

test('editing an embedded sub-app changes the build id', () => {
  const target = assets.find((a) => a.path === 'marketing-command-center/index.html');
  assert.ok(target, 'sanity: the marketing sub-app must be one of the hashed assets');
  const tampered = assets.map((a) => (a.path === target.path ? { ...a, source: `${a.source}\n<!-- change -->` } : a));
  assert.notEqual(computePageBuild(html, tampered), computePageBuild(html, assets));
});

test("an embedded page's own scripts are followed, resolved against its own directory", () => {
  const paths = assets.map((a) => a.path);
  // schedule-board/index.html references './data.js' -- relative, so it means
  // data.js IN schedule-board, not at the site root.
  assert.ok(paths.includes('schedule-board/data.js'),
    "the sub-app's relative script ref must resolve against the sub-app's directory");
  assert.ok(paths.some((p) => p.startsWith('vi-app/assets/')),
    "vi-app's built assets must be reached through its index.html");
});

test('pages the user NAVIGATES to are not hashed', () => {
  // window.open('/agents/','_blank') and <a href="/field/"> load a fresh
  // document, so they cannot be stale the way this mechanism means. An earlier
  // version of the iframe rule swept these in, which would have meant editing
  // the standalone field app marked every Command Center tab out of date.
  const paths = assets.map((a) => a.path);
  for (const notOurs of ['agents/index.html', 'field/index.html']) {
    assert.ok(!paths.includes(notOurs), `${notOurs} is navigated to, not embedded -- it must not be hashed`);
  }
  assert.match(html, /window\.open\('\/agents\/'/, 'sanity: /agents/ really is opened as a navigation');
});

test('a frame reference is recognised declared or assigned, and a directory means its index', () => {
  assert.deepEqual(pageFrameRefs('<iframe src="/vi-app/"></iframe>'), ['vi-app/index.html']);
  assert.deepEqual(
    pageFrameRefs('<iframe src="about:blank" data-src="/vi-app/"></iframe>'),
    ['vi-app/index.html'],
    'a session-gated lazy iframe still fingerprints the document it will execute'
  );
  assert.deepEqual(pageFrameRefs('<iframe src="about:blank"></iframe>'), [], 'about:blank is not a page of ours');
  assert.deepEqual(pageFrameRefs('<iframe src="https://maps.google.com/maps?q=x"></iframe>'), []);

  assert.deepEqual(runtimePageRefs(`f.setAttribute('src', '/marketing-command-center/?embedded=1')`),
    ['marketing-command-center/index.html'], 'the query string is not part of the file on disk');
  assert.deepEqual(runtimePageRefs(`f.src='/subportal-admin/'`), ['subportal-admin/index.html']);
  assert.deepEqual(runtimePageRefs(`window.open('/agents/','_blank')`), [],
    'opening a tab is not embedding a page');
  assert.deepEqual(runtimePageRefs(`s.src = '/hiveconnect/config.js'`), [],
    'a script element assignment is an asset, not an embedded document');
});

test('the root document is never one of its own assets', () => {
  // index.html mentions "/index.html" in a comment. Hashing itself as an asset
  // would be circular in the worst way: as an asset its build marker is NOT
  // blanked, so every stamp would change the input to the next stamp and the id
  // would never settle. This is how that was found.
  assert.ok(!assets.some((a) => a.path === 'index.html'), 'the page must not hash itself');
  assert.match(html, /["']\/index\.html["']/, 'sanity: the page really does contain that string');
});

test('stamping is a fixed point', () => {
  // The practical statement of the test above: hashing an already-stamped tree
  // must produce the id it already carries, not a new one.
  assert.equal(computePageBuild(html, assets), html.match(PAGE_BUILD_MARKER)[1]);
});

test('an asset reference cannot climb out of public/', () => {
  assert.deepEqual(pageAssetRefs('<script src="/../../etc/passwd"></script>'), []);
  assert.deepEqual(pageAssetRefs('<script src="../secrets.js"></script>'), []);
});

// --- Scripts the page loads without declaring them --------------------------
//
// Declared tags are not the whole page either. hiveconnect-mount.js fetches
// /hiveconnect/index.html and loadScript()s ten /hiveconnect/*.js files --
// app.js alone is 309KB -- into this same document. reina-pilot-host.js pulls
// in three voice modules the same way, and app-reina-council.js fetches a view.
// None of that is declared anywhere, and all of it can be stale in a live tab.

test('modules loaded at runtime are hashed, not just declared ones', () => {
  const paths = assets.map((a) => a.path);
  for (const expected of [
    'hiveconnect/app.js',            // 309KB, the bulk of the embedded app
    'hiveconnect/cowork-markup.js',
    'hiveconnect/voip-panel.js',
    'hiveconnect/styles-scoped.css', // injected as a <link> by ensureHeadAssets
    'hiveconnect/index.html',        // fetched, and its markup injected wholesale
    'reina-inapp-voice-host.js',     // pulled in by reina-pilot-host.js
    'views/reina-council.html',      // fetched by app-reina-council.js
  ]) {
    assert.ok(paths.includes(expected), `${expected} is loaded into the page but would not be hashed`);
  }
  assert.ok(
    assets.some((a) => a.via === 'runtime') && assets.some((a) => a.via === 'declared'),
    'both discovery routes must actually be contributing'
  );
});

test('editing a runtime-loaded module changes the build id', () => {
  // The counterpart of the declared-module test above, and the whole point of
  // following runtime references: before this, editing 309KB of hiveconnect
  // left the id untouched and every tab running the old copy read as current.
  const target = assets.find((a) => a.path === 'hiveconnect/app.js');
  assert.ok(target, 'sanity: hiveconnect/app.js must be one of the hashed assets');

  const tampered = assets.map((a) => (a.path === target.path ? { ...a, source: `${a.source}\n// a real change\n` } : a));
  assert.notEqual(computePageBuild(html, tampered), computePageBuild(html, assets));
});

test('runtime references are read out of the loader, not a hardcoded list', () => {
  // Whatever hiveconnect-mount.js loads is what gets covered. Add a module to
  // that file tomorrow and it is hashed without anyone editing this mechanism --
  // which matters because a hand-maintained list is exactly what drifted twice.
  const mount = fs.readFileSync('public/hiveconnect-mount.js', 'utf8');
  const refs = runtimeAssetRefs(mount);
  assert.ok(refs.includes('hiveconnect/app.js'));
  assert.ok(refs.includes('hiveconnect/index.html'));
  assert.ok(refs.includes('hiveconnect/styles-scoped.css'));
  assert.ok(!refs.some((r) => r.includes('cdn.jsdelivr')), 'the CDN loads in that same file must not be swept in');

  assert.deepEqual(
    runtimeAssetRefs(`loadScript('/a.js'); fetch("/b/c.html"); x.href = \`/d.css\`;`),
    ['a.js', 'b/c.html', 'd.css']
  );
  assert.deepEqual(
    runtimeAssetRefs(`fetch('/api/track1?resource=x'); go('relative.js'); s='https://cdn/x.js'`),
    [], 'API routes, relative paths and CDN URLs are all not ours to hash'
  );
});

test('a runtime reference is followed, and an unresolvable one is skipped not fatal', () => {
  // A <script src> is a promise that a file exists; a string literal is a guess.
  // Treating them alike would either break the stamp on an innocent string or
  // let a genuinely broken tag through in silence.
  const dir = fs.mkdtempSync(`${os.tmpdir()}/page-build-`);
  try {
    fs.writeFileSync(`${dir}/loader.js`, `loadScript('/real.js'); fetch('/api/not-a-file.js');`);
    fs.writeFileSync(`${dir}/real.js`, 'ok');

    const loaded = loadPageAssets('<script src="/loader.js"></script>', dir);
    assert.deepEqual(loaded.map((a) => a.path), ['loader.js', 'real.js'], 'the reachable one is followed');
    assert.deepEqual(loaded.map((a) => a.via), ['declared', 'runtime']);

    // Same tree, but now the DECLARED tag points at nothing.
    assert.throws(() => loadPageAssets('<script src="/gone.js"></script>', dir), /gone\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime references are followed transitively', () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/page-build-`);
  try {
    fs.writeFileSync(`${dir}/a.js`, `loadScript('/b.js')`);
    fs.writeFileSync(`${dir}/b.js`, `loadScript('/c.js')`);
    fs.writeFileSync(`${dir}/c.js`, `loadScript('/a.js')`); // a cycle must terminate
    assert.deepEqual(
      loadPageAssets('<script src="/a.js"></script>', dir).map((x) => x.path),
      ['a.js', 'b.js', 'c.js'],
      'hiveconnect-mount.js -> hiveconnect/app.js is exactly this shape'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fetched HTML file is hashed but its own tags are not followed', () => {
  // hiveconnect-mount.js strips every <script> out of the markup it injects and
  // loads those files itself. Following the markup's tags would double-count and
  // would pull in hiveconnect/styles.css, which the mounted path never loads.
  const dir = fs.mkdtempSync(`${os.tmpdir()}/page-build-`);
  try {
    fs.writeFileSync(`${dir}/loader.js`, `fetch('/view.html')`);
    fs.writeFileSync(`${dir}/view.html`, '<link rel="stylesheet" href="/never-loaded.css"><div>hi</div>');
    fs.writeFileSync(`${dir}/never-loaded.css`, 'body{}');
    assert.deepEqual(
      loadPageAssets('<script src="/loader.js"></script>', dir).map((x) => x.path),
      ['loader.js', 'view.html'],
      'the markup counts, the tags inside it do not'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the mount loads exactly what the standalone HiveConnect page declares', () => {
  // hiveconnect-mount.js strips every <script> out of the fetched markup and
  // re-loads the same files itself. That list is maintained by hand, and its own
  // comments record it drifting twice -- openTasksTabNative and
  // voipOpenCallFlowModal were both "is not defined" in the embedded app while
  // working fine standalone. This is that drift, as an assertion.
  const standalone = fs.readFileSync('public/hiveconnect/index.html', 'utf8');
  const declaredThere = new Set();
  for (const m of standalone.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
    const ref = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue; // CDN
    if (ref.startsWith('/')) continue;      // belongs to the HiveLogic shell, not this dir
    declaredThere.add(`hiveconnect/${ref.split(/[?#]/)[0]}`);
  }

  const mount = fs.readFileSync('public/hiveconnect-mount.js', 'utf8');
  const loadedByMount = new Set(runtimeAssetRefs(mount).filter((r) => r.startsWith('hiveconnect/') && r.endsWith('.js')));

  assert.ok(declaredThere.size >= 9, `sanity: expected the standalone page to list its modules, got ${declaredThere.size}`);
  assert.deepEqual(
    [...declaredThere].sort(), [...loadedByMount].sort(),
    'hiveconnect/index.html and hiveconnect-mount.js disagree about which modules to load. ' +
    'Standalone will work and the embedded app will throw "is not defined" -- this has happened twice.'
  );
});

test('no asset path is built by concatenation, so runtime discovery can see them all', () => {
  // The documented limit of reading string literals. Checked rather than assumed:
  // a loadScript('/dir/' + name + '.js') would be invisible to the hash.
  const mount = fs.readFileSync('public/hiveconnect-mount.js', 'utf8');
  const callsOnly = mount.replace(/function\s+loadScript\s*\([^)]*\)/g, ''); // not the declaration
  const calls = [...callsOnly.matchAll(/loadScript\(([^)]*)\)/g)];
  assert.ok(calls.length >= 9, `sanity: expected the mount's loadScript calls, found ${calls.length}`);
  for (const m of calls) {
    assert.ok(
      /^\s*['"`][^'"`]+['"`]\s*(?:,\s*(?:true|false)\s*)?$/.test(m[1]),
      `loadScript(${m[1]}) does not take a plain string literal -- runtime discovery cannot follow it`
    );
  }
});

test('computing an id without the assets is refused, not quietly wrong', () => {
  // A forgotten argument would otherwise return a well-formed 16-hex id that
  // covered only index.html -- a wrong answer indistinguishable from a right
  // one. Callers that mean "the page alone" have to say so.
  assert.throws(() => computePageBuild(html), /pass the page assets/);
  assert.match(computePageBuild(html, []), /^[0-9a-f]{16}$/);
});

test('the stamping script keeps both files in step', async () => {
  const src = fs.readFileSync('scripts/stamp-page-build.mjs', 'utf8');
  assert.match(src, /public\/index\.html/);
  assert.match(src, /api\/_lib\/page-build\.js/);
  assert.match(src, /--check/, 'a check mode is what makes this enforceable in CI, not just fixable by hand');
  assert.match(src, /loadPageAssets\(html\)/, 'the script must hash the modules too, or it restamps an id that undercovers the page');
});

// --- Honesty about what we do and do not know ------------------------------

test('a client that reports nothing is "unknown", never "stale"', () => {
  // Clients older than this mechanism cannot say what they are. Calling them
  // stale would be exactly the unfounded claim this exists to prevent. Law 1.
  for (const v of [null, undefined, '', 'latest', 'null']) {
    assert.equal(pageBuildState(v), 'unknown', `${JSON.stringify(v)} must not be judged`);
  }
});

test('a malformed build is not accepted as a real one', () => {
  assert.equal(isWellFormedBuild('107f46aecfe88e54'), true);
  assert.equal(isWellFormedBuild('107F46AECFE88E54'), false, 'the hash is written lowercase');
  assert.equal(isWellFormedBuild('107f46aecfe88e5'), false, 'too short');
  assert.equal(isWellFormedBuild('107f46aecfe88e54x'), false, 'too long');
  assert.equal(isWellFormedBuild('../../etc/passwd'), false);
  assert.equal(isWellFormedBuild(107), false);
});

test('the current build is current and anything else is stale', () => {
  assert.equal(pageBuildState(PAGE_BUILD), 'current');
  assert.equal(pageBuildState('0123456789abcdef'), 'stale');
});

// --- Recording without turning a 30s poll into a 30s write -----------------

test('a changed build is recorded immediately', () => {
  const now = Date.now();
  assert.equal(shouldRecordPageBuild('0123456789abcdef', new Date(now).toISOString(), PAGE_BUILD, now), true,
    'someone reloading onto the new build must show up at once, not in five minutes');
});

test('the same build is not rewritten on every poll', () => {
  const now = Date.now();
  const seen = new Date(now - 60 * 1000).toISOString();
  assert.equal(shouldRecordPageBuild(PAGE_BUILD, seen, PAGE_BUILD, now), false,
    'a poll every 30s must not become a database write every 30s');
});

test('recency is refreshed once the window passes, so "right now" stays meaningful', () => {
  const now = Date.now();
  const seen = new Date(now - PAGE_BUILD_RECORD_INTERVAL_MS - 1000).toISOString();
  assert.equal(shouldRecordPageBuild(PAGE_BUILD, seen, PAGE_BUILD, now), true);
});

test('a first report and an unreadable timestamp both record', () => {
  const now = Date.now();
  assert.equal(shouldRecordPageBuild(null, null, PAGE_BUILD, now), true);
  assert.equal(shouldRecordPageBuild(PAGE_BUILD, 'not a date', PAGE_BUILD, now), true);
});

test('a malformed report is never written to the profile', () => {
  const now = Date.now();
  assert.equal(shouldRecordPageBuild(PAGE_BUILD, null, 'garbage', now), false,
    'a forged or broken value must not overwrite a real observation');
});

// --- Wiring ----------------------------------------------------------------

test('the poll sends the build, on the request that already runs', () => {
  assert.match(
    html,
    /resource=monitor_my_status&build='\+encodeURIComponent\(window\.HL_PAGE_BUILD \|\| ''\)/,
    'the build must ride hlMonitorFabPoll -- no new poller, and it must be URL-encoded'
  );
  const pollers = html.match(/setInterval\(hlMonitorFabPoll/g) || [];
  assert.equal(pollers.length, 1, 'still exactly one monitor poll');
});

test('a stale tab tells the person using it, and keeps telling them', () => {
  assert.match(html, /if\(data && data\.pageStale\) hlPageStaleNotice\(\);/);
  assert.match(html, /window\.hlPageStaleNotice = function\(\)\{/);
  assert.match(html, /location\.reload\(true\)/, 'the notice must offer the actual remedy');
  // A toast would scroll away and let someone keep working against superseded
  // code -- which is the situation this whole change exists to end.
  assert.match(html, /position:fixed;left:0;right:0;bottom:0/, 'it must be a persistent bar, not a transient toast');
});

test('the server answers with both the expected build and the verdict', () => {
  const src = fs.readFileSync('api/track1.js', 'utf8');
  assert.match(src, /pageBuild: PAGE_BUILD/);
  assert.match(src, /pageStale: buildState === 'stale'/);
  assert.match(src, /page_build,page_build_seen_at/,
    'getRequestingProfile must select the columns, or every poll would look like a change and write every time');
});

test('recording never breaks the status the client actually asked for', () => {
  const src = fs.readFileSync('api/track1.js', 'utf8');
  assert.match(src, /catch \(e\) \{ \/\* never let bookkeeping break the poll \*\/ \}/);
});

test('the migration adds the columns and says what NULL means', () => {
  const sql = fs.readFileSync('supabase/migrations/20260816181500_profiles_page_build.sql', 'utf8');
  assert.match(sql, /add column if not exists page_build text/);
  assert.match(sql, /add column if not exists page_build_seen_at timestamptz/);
  assert.match(sql, /NULL means "has not reported"/, 'the distinction between unknown and stale must be written down');
});

test('health-cron reports stale clients, scoped to people actually active now', () => {
  const src = fs.readFileSync('api/health-cron.js', 'utf8');
  assert.match(src, /Browsers on the current build/);
  assert.match(src, /page_build_seen_at=gte\.\$\{since\}/, 'a stale build from days ago is a closed tab, not a live problem');
  assert.match(src, /page_build=not\.is\.null/, 'never-reported must not be counted as stale');
  assert.match(src, /could not check which build clients are running/, 'it must not be silent when it cannot answer');
});
