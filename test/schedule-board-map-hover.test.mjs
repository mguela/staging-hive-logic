import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hovering a pin on the crew board's Map tab shows the job's (or truck's)
// details, and — the part that had to be got right — lets go of them again when
// the pointer moves away. The Command Center map shipped the same behaviour
// first and had to be fixed once (#553): its popup carries no close button, so
// a single missed mouseleave stranded it over the map for good. These tests run
// the board's REAL mapHoverPopup against a stub of whichever map library is in
// play, and pin the pointer-tracking that stops that from happening here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.join(__dirname, '..', 'public', 'schedule-board', 'app.js');
const source = fs.readFileSync(APP_PATH, 'utf-8');

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  const braceStart = declStart + declSnippet.length - 1;
  let depth = 1, i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

// mapEsc is a const arrow, not a function declaration -- pull its line verbatim
// so the tests escape exactly the way the board does.
const MAP_ESC_SRC = (source.match(/^\s*const mapEsc=.*$/m) || [])[0];
if (!MAP_ESC_SRC) throw new Error('mapEsc not found in app.js');

const FN_SRC = [
  MAP_ESC_SRC,
  extractFunction(source, 'function mapHoverPopup(store, el, mk, htmlFn){'),
  extractFunction(source, 'function truckPinHTML(t){'),
].join('\n');

function makeEl() {
  const el = {
    nodeType: 1, style: { display: '' }, _on: {},
    addEventListener(type, fn) { el._on[type] = fn; },
    contains(node) { return node === el; },
  };
  return el;
}

/** A stub of Mapbox/MapLibre's Popup + Marker, plus just enough document. */
function harness({ html = '<b>Job</b>' } = {}) {
  const popups = [];
  const ctx = {
    console, Date, Math, Number, String, Object, Array, JSON,
    setTimeout: (fn) => { ctx.__pendingHide = fn; return 1; },
    clearTimeout: () => { ctx.__pendingHide = null; },
    document: {
      addEventListener(type, fn) { if (type === 'mousemove') ctx.__docMove = fn; },
      removeEventListener(type, fn) { if (type === 'mousemove' && ctx.__docMove === fn) ctx.__docMove = null; },
    },
  };
  ctx.window = ctx;
  const mapEl = makeEl();
  const map = {
    _on: {}, on(evt, fn) { this._on[evt] = fn; }, getContainer: () => mapEl,
  };
  const gl = {
    Popup: class {
      constructor(opts) { this.opts = opts; this.added = 0; this.html = null; this.open = false; this._on = {}; popups.push(this); }
      setHTML(h) { this.html = h; return this; }
      setLngLat() { return this; }
      addTo() { this.added++; this.open = true; if (this._on.open) this._on.open(); return this; }
      remove() { this.open = false; return this; }
      on(evt, fn) { this._on[evt] = fn; return this; }
      isOpen() { return this.open; }
      getElement() { return (this.el = this.el || makeEl()); }
    },
  };
  const el = makeEl();
  const mk = { getLngLat: () => [-73.6, 41.0] };
  ctx.__store = { map, gl };
  ctx.__el = el;
  ctx.__mk = mk;
  ctx.__htmlFn = () => html;
  vm.createContext(ctx);
  vm.runInContext(FN_SRC, ctx);
  vm.runInContext('__close = mapHoverPopup(__store, __el, __mk, __htmlFn)', ctx);
  return { ctx, popups, el, mapEl, map, close: ctx.__close, pop: () => popups[0] };
}

function hoverPin(h) {
  h.el._on.mouseenter();
  return h.pop();
}

// ---------- the point of the whole thing ----------

test('hovering a pin shows its detail popup', () => {
  const h = harness();
  assert.equal(h.popups.length, 1, 'a popup is prepared, not shown');
  assert.equal(h.pop().open, false);
  hoverPin(h);
  assert.equal(h.pop().open, true);
  assert.equal(h.pop().html, '<b>Job</b>');
});

test('moving the pointer away dismisses it', () => {
  const h = harness();
  hoverPin(h);
  h.ctx.__docMove({ target: h.mapEl });   // pointer is over bare map now
  h.ctx.__pendingHide();
  assert.equal(h.pop().open, false);
});

test('it dismisses even if mouseleave never fires', () => {
  // The popup's container is a fresh node on every open, and a node inserted
  // under a cursor that is already still never gets the hover state mouseleave
  // depends on. The guard works off the pointer, not off that event.
  const h = harness();
  hoverPin(h);
  h.ctx.__docMove({ target: h.mapEl });   // no mouseleave on the pin OR the popup
  h.ctx.__pendingHide();
  assert.equal(h.pop().open, false);
});

test('a pointer moving steadily across the map still dismisses it', () => {
  // Restarting the grace countdown on every mousemove would push it out forever.
  const h = harness();
  hoverPin(h);
  h.ctx.__docMove({ target: h.mapEl });
  const first = h.ctx.__pendingHide;
  h.ctx.__docMove({ target: h.mapEl });
  assert.strictEqual(h.ctx.__pendingHide, first, 'the countdown is not restarted while it runs');
  h.ctx.__pendingHide();
  assert.equal(h.pop().open, false);
});

test('the pointer resting on the popup keeps it up', () => {
  const h = harness();
  const pop = hoverPin(h);
  h.ctx.__docMove({ target: pop.getElement() });
  assert.ok(!h.ctx.__pendingHide, 'nothing is counting down');
  assert.equal(pop.open, true);
});

test('hovering the popup does not tear it down and rebuild it', () => {
  const h = harness();
  const pop = hoverPin(h);
  pop.getElement()._on.mouseenter();
  assert.equal(pop.added, 1, 'opened once, not reopened under the cursor');
});

test('leaving the pin holds the popup briefly, then drops it', () => {
  // The grace period is what makes the popup reachable at all.
  const h = harness();
  hoverPin(h);
  h.el._on.mouseleave();
  assert.equal(h.pop().open, true, 'not dismissed the instant the pointer leaves');
  h.ctx.__pendingHide();
  assert.equal(h.pop().open, false);
});

test('panning the map dismisses the popup', () => {
  const h = harness();
  hoverPin(h);
  h.map._on.movestart();
  assert.equal(h.pop().open, false, 'a popup pinned to a pin that is moving is stale on sight');
});

test('leaving the map entirely dismisses the popup', () => {
  const h = harness();
  hoverPin(h);
  h.mapEl._on.mouseleave();
  assert.equal(h.pop().open, false);
});

test('closing unhooks the pointer guard from the document', () => {
  const h = harness();
  hoverPin(h);
  assert.ok(h.ctx.__docMove, 'installed while open');
  h.close();
  assert.equal(h.ctx.__docMove, null, 'a closed popup leaves no listener behind');
});

test('a pin hidden by a filter cannot show a popup', () => {
  const h = harness();
  h.el.style.display = 'none';
  h.el._on.mouseenter();
  assert.equal(h.pop().open, false);
});

test('the content is re-read on every hover, not frozen at build time', () => {
  // A truck moves and its status changes between hovers; a job can change crew.
  let n = 0;
  const h = harness();
  h.ctx.__htmlFn = () => 'hover ' + (++n);
  vm.runInContext('__close = mapHoverPopup(__store, __el, __mk, __htmlFn)', h.ctx);
  const pop = h.popups[1];
  h.el._on.mouseenter();
  assert.equal(pop.html, 'hover 1');
  h.mapEl._on.mouseleave();
  h.el._on.mouseenter();
  assert.equal(pop.html, 'hover 2', 'the second hover re-read the data');
});

test('a pin with nothing to say shows nothing', () => {
  // truckPinHTML returns '' for a crew with no GPS fix; an empty popup would be
  // a blank card floating over the map.
  const h = harness({ html: '' });
  h.el._on.mouseenter();
  assert.equal(h.pop().open, false);
});

// ---------- what the popups actually say ----------

test('a truck with no fix says nothing at all', () => {
  const ctx = harness().ctx;
  ctx.liveTruckPos = () => null;
  vm.runInContext('__out = truckPinHTML({ id: "t1", n: "Alex" })', ctx);
  assert.equal(ctx.__out, '');
});

test('a truck popup names the crew, the vehicle and the age of the fix', () => {
  const ctx = harness().ctx;
  ctx.liveTruckPos = () => ({ vehicleName: 'Truck 4', status: 'DRIVING', speed: 31.4, stale: false,
    updatedAt: new Date(Date.now() - 4 * 60000).toISOString() });
  ctx.dayVisits = () => [{ date: '2026-08-13' }, { date: '2026-08-13' }, { date: '2026-08-14' }];
  ctx.state = { date: '2026-08-13' };
  vm.runInContext('__out = truckPinHTML({ id: "t1", n: "Alex Ruiz" })', ctx);
  const out = ctx.__out;
  assert.match(out, /Alex Ruiz/);
  assert.match(out, /Truck 4/);
  assert.match(out, /DRIVING/);
  assert.match(out, /31 mph/);
  assert.match(out, /4 min ago/);
  assert.match(out, /2 jobs today/, "only today's jobs count");
});

test('a stale fix is called stale rather than dressed up as current', () => {
  const ctx = harness().ctx;
  ctx.liveTruckPos = () => ({ vehicleName: 'Truck 9', status: 'STOPPED', speed: null, stale: true,
    updatedAt: new Date(Date.now() - 90 * 60000).toISOString() });
  ctx.dayVisits = () => [];
  ctx.state = { date: '2026-08-13' };
  vm.runInContext('__out = truckPinHTML({ id: "t2", n: "Sam" })', ctx);
  assert.match(ctx.__out, /90 min ago — stale/);
  assert.match(ctx.__out, /Nothing scheduled today/);
});

// ---------- the fabricated address that used to be the pin's tooltip ----------

test('no pin text comes from synthClient, whose address is invented', () => {
  // synthClient() makes up a street address from a hash of the client's name.
  // It was the job pin's title attribute, so every pin on the live board showed
  // an address that does not exist.
  const jobHtml = extractFunction(source, 'function jobPinHTML(v){');
  assert.doesNotMatch(jobHtml, /synthClient/, 'the popup must use real fields only');
  const addJobs = extractFunction(source, 'function mbAddJobs(store, interactive){');
  assert.doesNotMatch(addJobs, /synthClient/, 'and so must the pin itself');
});

test('a job popup carries the client, the job, the crew and the readiness', () => {
  const ctx = harness().ctx;
  const jobHtml = extractFunction(source, 'function jobPinHTML(v){');
  ctx.techById = () => null;
  ctx.effectiveTech = (v) => v.t;
  ctx.effectiveStart = (v) => v.s;
  ctx.effectiveEnd = (v) => v.e;
  ctx.readinessOf = () => ({ level: 'at_risk', why: 'Materials not received' });
  ctx.cardIcon = () => '*';
  ctx.dLabel = () => 'Thu, Aug 13';
  ctx.fmt = (h) => h + ':00';
  ctx.RDY = { ready: { l: 'READY' }, at_risk: { l: 'AT RISK' }, blocked: { l: 'BLOCKED' } };
  vm.runInContext(jobHtml, ctx);
  vm.runInContext(`__out = jobPinHTML({ client:'Mrs Vance', city:'Greenwich', type:'Deck rebuild',
    jobNo:'2041', date:'2026-08-13', s:9, e:13, crew:[{n:'Alex',lead:true},{n:'Sam'}] })`, ctx);
  const out = ctx.__out;
  assert.match(out, /Mrs Vance/);
  assert.match(out, /Greenwich/);
  assert.match(out, /#2041/);
  assert.match(out, /Deck rebuild/);
  assert.match(out, /Alex/);
  assert.match(out, /Sam/);
  assert.match(out, /AT RISK/);
  assert.match(out, /Materials not received/);
});

test('an unassigned job says so rather than showing an empty line', () => {
  const ctx = harness().ctx;
  const jobHtml = extractFunction(source, 'function jobPinHTML(v){');
  ctx.techById = () => null;
  ctx.effectiveTech = (v) => v.t;
  ctx.effectiveStart = (v) => v.s;
  ctx.effectiveEnd = (v) => v.e;
  ctx.readinessOf = () => ({ level: 'ready', why: '' });
  ctx.cardIcon = () => '*';
  ctx.dLabel = () => 'Thu, Aug 13';
  ctx.fmt = (h) => h + ':00';
  ctx.RDY = { ready: { l: 'READY' }, at_risk: { l: 'AT RISK' }, blocked: { l: 'BLOCKED' } };
  vm.runInContext(jobHtml, ctx);
  vm.runInContext(`__out = jobPinHTML({ client:'Mr Poole', type:'Gutter clean', date:'2026-08-13', s:8, e:10, crew:[] })`, ctx);
  assert.match(ctx.__out, /No crew assigned/);
  assert.match(ctx.__out, /good to start/);
});

// ---------- wiring ----------

test('only the interactive Map tab gets hover popups, never the backdrop', () => {
  // The Day backdrop is pointer-events:none; wiring hover there would be dead
  // code that still allocated a popup per pin.
  const addJobs = extractFunction(source, 'function mbAddJobs(store, interactive){');
  assert.match(addJobs, /if\(interactive\) store\.jobMarkers\[v\.id\]\.closePop=mapHoverPopup/);
});

test('the browser tooltip is dropped where a popup replaces it', () => {
  // Otherwise the native title sits on top of the popup a second later.
  const addJobs = extractFunction(source, 'function mbAddJobs(store, interactive){');
  assert.match(addJobs, /if\(!interactive\) el\.title=/, 'the backdrop keeps a plain tooltip');
  const update = extractFunction(source, 'function mbUpdate(store){');
  assert.match(update, /if\(!m\.closePop\) m\.el\.title/, 'a truck with a popup does not also set a title');
});

test('a pin torn down by a period change takes its popup with it', () => {
  const addJobs = extractFunction(source, 'function mbAddJobs(store, interactive){');
  assert.match(addJobs, /if\(m\.closePop\) m\.closePop\(\)/, 'job pins');
  const addMarkers = extractFunction(source, 'function mbAddMarkers(store){');
  assert.match(addMarkers, /if\(m\.closePop\) m\.closePop\(\)/, 'truck pins');
});

test('the popup is styled for both map libraries and both themes', () => {
  // Mapbox when a token is present, MapLibre when it is not: different class
  // prefixes for the same popup, and the default white card reads as a hole
  // punched in a dark board.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'index.html'), 'utf-8');
  assert.match(css, /\.mbpop \.mapboxgl-popup-content/);
  assert.match(css, /\.mbpop \.maplibregl-popup-content/);
  assert.match(css, /\.mbpop \.mapboxgl-popup-content[^}]*var\(--panel\)/);
});
