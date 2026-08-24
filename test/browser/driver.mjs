// Browser plumbing for the harness: find a Chromium, open the board, and keep
// the network sealed.
//
// Every external host the board touches is intercepted. That is not only for
// hermeticity — sandboxes commonly block them outright, and a blocked request
// HANGS rather than failing, which stalls MapLibre's 'load' event and produces
// a map with no pins and no fit. A test that measured that would report a
// perfectly confident wrong answer.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Resolve a module without throwing when it is simply not installed. */
function tryResolve(id) {
  try { return require.resolve(id); } catch { return null; }
}

export function findPlaywright() {
  try { return require('playwright-core'); } catch { return null; }
}

/**
 * Locate a Chromium binary. Prefers whatever the environment already provides
 * (PLAYWRIGHT_BROWSERS_PATH, a system install) over downloading anything.
 */
export function findChromium() {
  const fromEnv = process.env.CHROMIUM_PATH || process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // Playwright's own default cache root differs by OS: ~/.cache/ms-playwright
  // on Linux/Mac, but %LOCALAPPDATA%\ms-playwright on Windows (HOME is
  // typically unset there, so that branch alone silently found nothing on a
  // Windows dev machine even with Chromium already installed).
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    path.join(process.env.HOME || '', '.cache', 'ms-playwright'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith('chromium')) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const bin = path.join(root, entry, rel);
        if (fs.existsSync(bin)) return bin;
      }
    }
    const direct = path.join(root, 'chromium');
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  }
  for (const bin of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/** Why the harness cannot run, or null when it can. */
export function unavailableReason() {
  if (!findPlaywright()) return 'playwright-core is not installed (npm install)';
  if (!findChromium()) return 'no Chromium binary found (set CHROMIUM_PATH, or npx playwright install chromium)';
  return null;
}

export const maplibreBundle = () => tryResolve('maplibre-gl/dist/maplibre-gl.js');

// A stand-in map tile: beige ground, green parkland, blue water, white roads.
// Real tiles are unreachable offline, and a blank canvas cannot answer "is the
// map actually visible behind the calendar?" — which is the whole question.
function standInTile() {
  const S = 256;
  const px = Buffer.alloc(S * S * 3);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 3;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, [242, 239, 233]);
  for (let y = 20; y < 110; y++) for (let x = 140; x < 250; x++) set(x, y, [201, 223, 193]);
  for (let y = 170; y < 230; y++) for (let x = 10; x < 90; x++) set(x, y, [170, 211, 223]);
  for (let t = -6; t < 6; t++) for (let i = 0; i < S; i++) { set(i, 128 + t, [255, 255, 255]); set(70 + t, i, [255, 255, 255]); }
  for (const o of [-7, 6]) for (let i = 0; i < S; i++) { set(i, 128 + o, [214, 209, 201]); set(70 + o, i, [214, 209, 201]); }

  const raw = Buffer.alloc(S * (S * 3 + 1));
  for (let y = 0; y < S; y++) { raw[y * (S * 3 + 1)] = 0; px.copy(raw, y * (S * 3 + 1) + 1, y * S * 3, (y + 1) * S * 3); }

  let TABLE = null;
  const crc32 = (buf) => {
    if (!TABLE) {
      TABLE = [];
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c; }
    }
    let c = 0xFFFFFFFF;
    for (const b of buf) c = TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TILE = standInTile();

/**
 * Open the schedule board with every external host intercepted.
 * `page.__maps` collects each MapLibre map built, so a test can read the real
 * camera instead of inferring it.
 */
export async function openBoard(chromium, baseUrl, { width = 1500, height = 900, tiles = true, touch = false } = {}) {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  // hasTouch makes Chromium report a touch-capable device, which is what
  // MapLibre's gesture handlers actually check before binding.
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // Match on a parsed URL rather than a glob string: Playwright has changed its
  // glob semantics between versions, and a pattern that silently stops matching
  // lets the real request through to a network that is not there — which shows
  // up as "no map was built" rather than as a routing problem.
  const on = (predicate, handler) => page.route((url) => predicate(url), handler);
  const isHost = (url, host) => url.hostname === host || url.hostname.endsWith('.' + host);

  const bundle = maplibreBundle();
  if (bundle) {
    // Wrap the constructor so tests can read each map's camera. Doing it here
    // keeps the shipped app free of test-only hooks.
    const shim = fs.readFileSync(bundle, 'utf-8') + `
;(function(){ var M = maplibregl.Map; window.__maps = [];
  function Wrapped(){ var m = new M(...arguments); window.__maps.push(m); return m; }
  Wrapped.prototype = M.prototype; Object.setPrototypeOf(Wrapped, M);
  maplibregl.Map = Wrapped; })();`;
    const css = bundle.replace(/\.js$/, '.css');
    await on((u) => isHost(u, 'unpkg.com') && u.pathname.endsWith('maplibre-gl.js'),
      (r) => r.fulfill({ body: shim, contentType: 'application/javascript' }));
    await on((u) => isHost(u, 'unpkg.com') && u.pathname.endsWith('maplibre-gl.css'),
      (r) => (fs.existsSync(css)
        ? r.fulfill({ path: css, contentType: 'text/css' })
        : r.fulfill({ body: '', contentType: 'text/css' })));
  }

  // Tiles: served as a stand-in, or aborted. Never left to hang — a hanging
  // tile request stalls MapLibre's 'load', and everything downstream of it.
  await on((u) => isHost(u, 'openstreetmap.org'),
    (r) => (tiles ? r.fulfill({ body: TILE, contentType: 'image/png' }) : r.abort()));
  await on((u) => ['api.mapbox.com', 'events.mapbox.com'].includes(u.hostname)
    || isHost(u, 'open-meteo.com') || isHost(u, 'googleapis.com'),
    (r) => r.abort());

  // ?t= satisfies the board's token check; the harness serves the API anyway.
  await page.goto(`${baseUrl}/schedule-board/index.html?t=harness`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('!!window.LabUI', null, { timeout: 30000 });

  return { browser, page, pageErrors };
}

/** Turn the background map on and wait for it to settle. */
export async function enableMapBackdrop(page) {
  await page.evaluate(`(() => {
    if (!document.body.classList.contains('map-under')) document.getElementById('mapBgBtn').click();
  })()`);
  await page.waitForFunction('document.body.classList.contains("map-under")', null, { timeout: 10000 });
  // the map builds asynchronously and fits once laid out
  await page.waitForTimeout(3000);
}

export async function showView(page, view) {
  await page.evaluate(`document.querySelector('#viewtabs .vt[data-v="${view}"]').click()`);
  await page.waitForTimeout(2500);
}

// ---------------------------------------------------------------------------
// Command Center (public/index.html)
// ---------------------------------------------------------------------------
// The Command Center's widget grid is the other place in this app where the
// only honest test is a laid-out one: whether a widget can actually be dragged,
// whether an edit-only control is really absent outside edit mode, and whether
// a resized widget's content still fits are all questions about geometry and
// real event listeners. See command-center-ui.test.mjs.

export const gridstackBundle = () => tryResolve('gridstack/dist/gridstack-all.js');
export const gridstackCssBundle = () => tryResolve('gridstack/dist/gridstack.min.css');
export const leafletBundle = () => tryResolve('leaflet/dist/leaflet.js');

/**
 * Minimal stand-in for supabase-js. The app calls
 * `window.supabase.createClient(...)` at parse time, so if the CDN script is
 * merely aborted the whole script block after it dies and nothing downstream —
 * including the Command Center — ever runs.
 *
 * It reports a SIGNED-IN session, because that is the state the Command Center
 * is used in. With "no session" the app does exactly the right thing — it puts
 * its full-screen login overlay back up — and every geometry probe below then
 * measures the login screen instead of the widget grid. Handing it a session
 * lets the app dismiss that overlay through its own hlTrySilentLogin path
 * rather than the harness reaching in and deleting an element.
 */
// Exported so a test that only needs a signed-in page -- not the whole
// Command Center -- can stub the auth client without copying it. Without it the
// page throws on supabase.createClient at load and sits in a half-booted state.
export const SUPABASE_STUB = `
window.supabase = {
  createClient: function(){
    var noRows = { data: [], error: null };
    var USER = { id: '00000000-0000-4000-8000-000000000001', email: 'harness@hivelogic.test',
                 user_metadata: {}, app_metadata: {}, aud: 'authenticated', role: 'authenticated' };
    var SESSION = { access_token: 'harness-token', refresh_token: 'harness-refresh',
                    token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: USER };
    // sb.from(...) is used as a chainable query builder in a dozen places; a
    // Proxy answers every shape of it without enumerating them.
    function builder(){
      var p = new Proxy(function(){ return p; }, {
        get: function(t, k){
          if (k === 'then') return function(res){ return Promise.resolve(noRows).then(res); };
          return builder();
        },
        apply: function(){ return builder(); }
      });
      return p;
    }
    return {
      auth: {
        getSession: function(){ return Promise.resolve({ data: { session: SESSION }, error: null }); },
        getUser: function(){ return Promise.resolve({ data: { user: USER }, error: null }); },
        onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; },
        refreshSession: function(){ return Promise.resolve({ data: { session: SESSION }, error: null }); },
        signInWithPassword: function(){ return Promise.resolve({ data: { session: SESSION, user: USER }, error: null }); },
        signOut: function(){ return Promise.resolve({ error: null }); },
        updateUser: function(){ return Promise.resolve({ data: { user: USER }, error: null }); },
      },
      from: function(){ return builder(); },
      storage: { from: function(){ return { upload: function(){ return Promise.resolve(noRows); },
                                            getPublicUrl: function(){ return { data: { publicUrl: '' } }; } }; } },
    };
  }
};`;

/**
 * Open the Command Center with every external host intercepted.
 *
 * GridStack is served REAL (from the devDependency) because it is the system
 * under test — it owns the drag handles, the collision resolve and the
 * positioning that these tests exist to measure. Stubbing it would leave a
 * harness that agrees with itself and nothing else.
 */
// The viewport is deliberately TALLER than the grid (which lays out ~1640px at
// this width). elementFromPoint is viewport-relative and returns null for a
// point below the fold — so on a short viewport a "nothing is covering this
// widget" probe would come back null for half the widgets and read as a pass.
// That is the vacuous measurement this suite refuses to make.
export async function openCommandCenter(chromium, baseUrl, { width = 1500, height = 1900 } = {}) {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // The workforce "Clock in?" prompt arms on a timer and renders a modal over
  // the whole app. Left alone it drifts into the middle of a run and covers the
  // grid — which is both a wrong screenshot and an intermittently failing
  // hit-test. Set the app's OWN dismissal flag rather than racing it or
  // deleting its element.
  await page.addInitScript(() => {
    try { localStorage.setItem('hlWfClockInDismissed', new Date().toDateString()); } catch (e) { /* private mode */ }
  });

  const on = (predicate, handler) => page.route((url) => predicate(url), handler);
  const isHost = (url, host) => url.hostname === host || url.hostname.endsWith('.' + host);
  const serveFile = (file, type) => (r) => (file && fs.existsSync(file)
    ? r.fulfill({ path: file, contentType: type })
    : r.fulfill({ body: '', contentType: type }));

  // REGISTRATION ORDER MATTERS: Playwright checks route handlers in REVERSE
  // order of registration, so the broad catch-all has to go on FIRST or it wins
  // over every specific handler below it and aborts the very bundles under test.
  // (Registered the other way round, this harness silently served nothing and
  // reported "the grid never initialised" instead of "your routes are wrong".)
  await on((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());

  const gs = gridstackBundle();
  if (!gs) throw new Error('gridstack is not installed — the Command Center grid cannot be tested without it');
  const gsCss = gridstackCssBundle();
  if (!gsCss) throw new Error('gridstack CSS is not installed — the Command Center layout cannot be tested without it');
  await on((u) => isHost(u, 'jsdelivr.net') && u.pathname.endsWith('gridstack-all.js'),
    serveFile(gs, 'application/javascript'));
  await on((u) => isHost(u, 'jsdelivr.net') && u.pathname.endsWith('gridstack.min.css'),
    serveFile(gsCss, 'text/css'));

  // Leaflet real too: the map widget is one of the nine, and a widget whose
  // content throws on load is not a fair subject for a "does it fit" test.
  const lf = leafletBundle();
  await on((u) => isHost(u, 'cloudflare.com') && u.pathname.endsWith('leaflet.min.js'),
    serveFile(lf, 'application/javascript'));
  await on((u) => isHost(u, 'cloudflare.com') && u.pathname.endsWith('leaflet.min.css'),
    serveFile(lf && lf.replace(/leaflet\.js$/, 'leaflet.css'), 'text/css'));

  await on((u) => isHost(u, 'jsdelivr.net') && u.pathname.includes('supabase'),
    (r) => r.fulfill({ body: SUPABASE_STUB, contentType: 'application/javascript' }));

  // Map tiles: a stand-in rather than a hang. Same reasoning as the board —
  // in a sealed sandbox an un-routed request stalls instead of failing.
  await on((u) => isHost(u, 'openstreetmap.org'), (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));

  // #win is the app's own built-in way to drop the login overlay
  // (index.html: `if(location.hash.indexOf('win')>=0){ ...login... display='none' }`),
  // so the harness reaches the app the same way the app itself allows, rather
  // than by reaching in and deleting an element.
  await page.goto(`${baseUrl}/index.html#win`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof window.showView === "function"', null, { timeout: 30000 });
  await page.evaluate('showView("cc")');
  // hlInitCcGrid needs the container to have real dimensions, and is idempotent.
  await page.waitForFunction(
    '(function(){ if (window.hlInitCcGrid) window.hlInitCcGrid(); return !!window._hlCcGrid; })()',
    null, { timeout: 30000 },
  );
  await page.waitForTimeout(500);
  await assertCommandCenterVisible(page);

  return { browser, page, pageErrors };
}

/**
 * Refuse to proceed while the login overlay is on top of the grid.
 * It is `position:fixed; inset:0; z-index:300`, so every geometry probe would
 * be measuring the login screen — and would report whatever that happens to
 * say, confidently and wrongly.
 */
export async function assertCommandCenterVisible(page) {
  const state = await page.evaluate(`(() => {
    const lg = document.getElementById('login');
    const grid = document.getElementById('cc-main-gridstack');
    const b = grid ? grid.getBoundingClientRect() : null;
    const el = b && b.height > 0
      ? document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + 40)) : null;
    return {
      loginShown: !!lg && getComputedStyle(lg).display !== 'none',
      gridHeight: b ? Math.round(b.height) : 0,
      topmost: el ? (el.id || el.className.toString().slice(0, 40) || el.tagName) : null,
    };
  })()`);
  if (state.loginShown) throw new Error('the login overlay is covering the Command Center — the harness session was not accepted');
  if (!(state.gridHeight > 0)) throw new Error('the Command Center grid has no height — nothing can be measured');
  if (state.topmost === 'login') throw new Error(`something is covering the grid: ${state.topmost}`);
  return state;
}

/**
 * Hover a widget so GridStack's resize handles are actually laid out.
 * They carry `.ui-resizable-autohide` until hover, i.e. `display:none` and a
 * zero-size rect — measuring one un-hovered answers every geometry question
 * with "no overlap", whatever the truth is.
 */
export async function hoverWidget(page, gsId) {
  const box = await page.evaluate(`(() => {
    const n = document.querySelector('[gs-id="${gsId}"]');
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  if (!box) throw new Error(`no widget ${gsId}`);
  // Step the pointer in, from somewhere else. A single jump can land without
  // Chromium synthesising the mouseover GridStack listens for, and an un-hovered
  // item keeps `.ui-resizable-autohide` — i.e. display:none, zero-size handles.
  // Any geometry question asked of those answers "no overlap" for free.
  await page.mouse.move(4, 4);
  await page.mouse.move(box.x, box.y, { steps: 8 });
  await page.waitForFunction(
    `!document.querySelector('[gs-id="${gsId}"]').classList.contains('ui-resizable-autohide')`,
    null, { timeout: 3000 },
  ).catch(() => {});
  await page.waitForTimeout(150);
}

/** Drag a widget by (dx, dy) with a real pointer, from wherever `from` resolves. */
export async function dragWidget(page, gsId, dx, dy, { from = '.w-shield' } = {}) {
  const box = await page.evaluate(`(() => {
    const n = document.querySelector('[gs-id="${gsId}"] ${from}') || document.querySelector('[gs-id="${gsId}"]');
    const b = n.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + Math.min(30, b.height / 2), w: b.width, h: b.height };
  })()`);
  // A zero-size grab target would make "nothing moved" meaningless.
  if (!(box.w > 0 && box.h > 0)) throw new Error(`drag target for ${gsId} has no size`);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + (dx * i) / 10, box.y + (dy * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/**
 * Wait until the Pulse gauges hold real figures.
 * Their loader only fires once it sees the Command Center as visible, which can
 * land after the harness has already navigated; pgReload() is the app's own
 * re-fetch hook. Measuring these tiles full of "Loading…" would be measuring
 * placeholder text — the easiest thing in the world to fit in a box.
 */
export async function waitForPulseData(page) {
  await page.evaluate('window.pgReload && window.pgReload()');
  await page.waitForFunction(
    `[...document.querySelectorAll('.pg-tile .pg-val')].length >= 6
       && [...document.querySelectorAll('.pg-tile .pg-val')].every((e) => e.textContent.trim() && e.textContent.trim() !== '\u2014')`,
    null, { timeout: 20000 },
  );
  await page.waitForTimeout(700); // the meters animate their width in
}

/** Enter or leave the Command Center's customize mode and let it settle. */
export async function setCcEditMode(page, on) {
  await page.evaluate(`window.hlCcSetEditMode(${on ? 'true' : 'false'})`);
  await page.waitForFunction(
    `document.getElementById('snapshot').classList.contains('cc-editing') === ${on ? 'true' : 'false'}`,
    null, { timeout: 5000 },
  );
  await page.waitForTimeout(250);
}

// ---------------------------------------------------------------------------
// HiveGrid Live Workbench (public/index.html, view "tox")
// ---------------------------------------------------------------------------
// The Live Workbench is a real canvas-based takeoff tool loaded into its OWN
// document via <iframe id="if-tox" data-hl63="...">, re-populated by
// re-assigning f.srcdoc from that attribute every time showView('tox') runs
// (the app's own showView override, index.html). Its script reads
// window.parent.sb directly for the signed-in Supabase session rather than
// going through the outer page's normal fetch path -- so it needs no
// mocking of its own: window.parent.sb resolves to the SAME global `sb` the
// outer page builds from window.supabase.createClient(...), which is already
// the thing SUPABASE_STUB below replaces before that assignment runs.
//
// Per WHATWG (a srcdoc document's base URL is its containing document's base
// URL, absent a <base> element inside it), the iframe's relative fetch('/api/...')
// calls resolve against the harness server's own origin -- so page.route()
// sees and can stub them exactly like any top-level request.

/**
 * Open the Live Workbench with every external host intercepted.
 *
 * `stubApi(on, isHost)` registers additional routes BEFORE navigation --
 * required, not just convenient: the iframe's own script calls rlvToxLoad()
 * immediately once its srcdoc is assigned (before this function returns), so
 * a caller registering test-specific API stubs only after openHiveGridWorkbench
 * resolves would race that first fetch and sometimes lose.
 */
export async function openHiveGridWorkbench(chromium, baseUrl, { width = 1500, height = 1000, stubApi } = {}) {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.addInitScript(() => {
    try { localStorage.setItem('hlWfClockInDismissed', new Date().toDateString()); } catch (e) { /* private mode */ }
  });

  const on = (predicate, handler) => page.route((url) => predicate(url), handler);
  const isHost = (url, host) => url.hostname === host || url.hostname.endsWith('.' + host);

  // Same ordering caveat as openCommandCenter: the broad catch-all must be
  // registered FIRST (Playwright checks handlers in reverse registration
  // order), or it wins over the specific handlers below and aborts them too.
  await on((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());
  await on((u) => isHost(u, 'jsdelivr.net') && u.pathname.includes('supabase'),
    (r) => r.fulfill({ body: SUPABASE_STUB, contentType: 'application/javascript' }));

  if (stubApi) await stubApi(on, isHost);

  await page.goto(`${baseUrl}/index.html#win`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof window.showView === "function"', null, { timeout: 30000 });
  await page.evaluate('showView("tox")');

  const frame = await waitForToxFrame(page);
  return { browser, page, frame, pageErrors };
}

/**
 * The tox iframe's srcdoc is (re)assigned by showView; wait for its script to
 * run. Resolved by DOM id via contentFrame() -- not by matching name/url
 * across page.frames() -- since several OTHER views use the same
 * data-hl63/srcdoc mechanism and could otherwise be ambiguous. Exported so a
 * test can re-fetch the frame after simulating a reload (a fresh
 * showView('tox') re-assigns srcdoc and replaces the frame's window).
 */
export async function waitForToxFrame(page) {
  const handle = await page.waitForSelector('#if-tox', { timeout: 10000 });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const frame = await handle.contentFrame();
    if (frame) {
      try {
        const ready = await frame.evaluate('typeof window.WB === "object" && typeof rlvToxSave === "function"');
        if (ready) return frame;
      } catch { /* frame navigating/reloading -- try again */ }
    }
    await page.waitForTimeout(100);
  }
  throw new Error('the tox iframe never finished loading its Live Workbench script');
}
